/**
 * Bluesky Feed Analyzer Tool
 *
 * Monitors Bluesky feed and timeline to identify marketing prospects
 * based on content, engagement, and persona alignment.
 *
 * Features:
 * - Timeline and following feed analysis
 * - AI-powered prospect scoring
 * - Buying signal detection
 * - Prospect report generation
 * - Firestore prospect storage
 *
 * @module tools/bskyFeedAnalyzer
 */

const BaseTool = require('../lib/baseTool');
const { getBskyService } = require('../services/bskyService');
const { getGeminiService } = require('../services/gemini');
const { getFieldValue } = require('../config/firestore');

class BskyFeedAnalyzer extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'BskyFeedAnalyzer';
    this.description = 'Analyze Bluesky feed to identify potential marketing prospects when user EXPLICITLY requests "analyze my Bluesky feed for prospects" or "find potential customers on Bluesky" or "generate prospect report from Bluesky" or "identify sales leads from bsky". This tool monitors the timeline and feeds from followed users, uses AI to evaluate if profiles match marketing personas, analyzes recent posts for buying signals, and generates actionable prospect reports. Use ONLY when user wants to identify sales/marketing opportunities from Bluesky activity. DO NOT use for general feed reading, engagement tracking, or conversational questions about Bluesky content.';
    this.priority = 55;
    this.timeout = 15 * 60 * 1000; // 15 minutes (extensive AI analysis)

    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['analyze', 'report'],
          description: 'Action to perform. "analyze" identifies prospects from feed, "report" generates summary of existing prospects.'
        },
        feedType: {
          type: 'string',
          enum: ['timeline', 'following'],
          description: 'Feed to analyze. "timeline" = home algorithmic feed, "following" = chronological following feed (default: timeline)'
        },
        lookbackHours: {
          type: 'number',
          description: 'How many hours back to analyze posts (default: 24)'
        },
        minProspectScore: {
          type: 'number',
          description: 'Minimum AI score (0-100) to qualify as prospect (default: 75)'
        },
        maxProspects: {
          type: 'number',
          description: 'Maximum prospects to return in report (default: 20)'
        },
        personaIds: {
          type: 'array',
          description: 'Array of persona IDs to filter prospects (optional, defaults to all personas)'
        }
      },
      required: ['action']
    };
  }

  // SEMANTIC TRIGGER (CRITICAL - See CLAUDE.md)
  // DO NOT use keyword matching - let Gemini's function calling handle triggering
  async shouldTrigger() {
    return false; // Let Gemini handle all triggering via description
  }

  async execute(args, toolContext = {}) {
    const {
      action = 'analyze',
      feedType = 'timeline',
      lookbackHours = 24,
      minProspectScore = 75,
      maxProspects = 20,
      personaIds = null
    } = args;

    try {
      // Initialize services
      const bsky = getBskyService();
      const initialized = await bsky.initialize();

      if (!initialized) {
        return '❌ Bluesky integration not available. Check ENABLE_BLUESKY_INTEGRATION setting.';
      }

      switch (action) {
        case 'analyze':
          return await this.analyzeFeed({
            feedType,
            lookbackHours,
            minProspectScore,
            maxProspects,
            personaIds,
            toolContext
          });

        case 'report':
          return await this.generateProspectReport({ maxProspects, minProspectScore });

        default:
          return '❌ Unknown action. Use "analyze" or "report".';
      }
    } catch (error) {
      this.log('error', 'BskyFeedAnalyzer execution failed', { error: error.message });
      return `❌ Error: ${error.message}`;
    }
  }

  /**
   * Analyze feed and identify prospects
   */
  async analyzeFeed({ feedType, lookbackHours, minProspectScore, maxProspects, personaIds, toolContext }) {
    const bsky = getBskyService();
    const gemini = getGeminiService();
    const FieldValue = getFieldValue();

    this.log('info', 'Analyzing Bluesky feed', { feedType, lookbackHours });

    // Load personas
    const personas = await this.loadPersonas(personaIds, toolContext);

    if (personas.length === 0) {
      return '❌ No marketing personas found in knowledge base. Add persona definitions first.';
    }

    // Fetch feed
    const posts = await bsky.getFeed(feedType, 100); // Max 100 posts

    this.log('info', 'Feed fetched', { postsCount: posts.length });

    // Filter by lookback time
    const cutoffTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const recentPosts = posts.filter(post => {
      const postTime = new Date(post.createdAt);
      return postTime >= cutoffTime;
    });

    this.log('info', 'Posts filtered by time', {
      original: posts.length,
      recent: recentPosts.length
    });

    // Extract unique authors (deduplicate)
    const authorMap = new Map();

    for (const post of recentPosts) {
      const did = post.author.did;

      if (!authorMap.has(did)) {
        authorMap.set(did, {
          author: post.author,
          posts: []
        });
      }

      authorMap.get(did).posts.push(post);
    }

    this.log('info', 'Unique authors extracted', { authorsCount: authorMap.size });

    // Analyze each author for prospect potential
    const prospects = [];

    for (const [did, data] of authorMap.entries()) {
      const { author, posts: authorPosts } = data;

      // Skip if already in prospects collection
      const existingProspect = await this.getExistingProspect(did);
      if (existingProspect && existingProspect.status === 'qualified') {
        this.log('info', 'Author already qualified prospect, skipping', { handle: author.handle });
        continue;
      }

      // Get full profile
      let profile;
      try {
        profile = await bsky.getProfile(did);
      } catch (error) {
        this.log('warn', 'Failed to fetch profile', { did, error: error.message });
        continue;
      }

      // Skip low-quality accounts
      if (profile.followersCount < 10 || profile.postsCount < 5) {
        continue;
      }

      // AI prospect scoring
      const prospectEval = await this.evaluateProspect({
        profile,
        recentPosts: authorPosts,
        personas,
        gemini
      });

      if (prospectEval.score >= minProspectScore) {
        prospects.push({
          did,
          profile,
          posts: authorPosts,
          prospectScore: prospectEval.score,
          prospectReason: prospectEval.reason,
          personaMatches: prospectEval.personaMatches,
          buyingSignals: prospectEval.buyingSignals
        });
      }
    }

    // Sort by prospect score (highest first)
    prospects.sort((a, b) => b.prospectScore - a.prospectScore);

    // Limit to maxProspects
    const topProspects = prospects.slice(0, maxProspects);

    this.log('info', 'Prospect analysis complete', {
      totalProspects: prospects.length,
      topProspects: topProspects.length
    });

    // Store prospects in Firestore
    for (const prospect of topProspects) {
      try {
        if (!this.firestore) {
          const { getFirestore } = require('../config/firestore');
          this.firestore = getFirestore();
        }
        await this.firestore.collection('bluesky-prospects').add({
          did: prospect.did,
          handle: prospect.profile.handle,
          displayName: prospect.profile.displayName,
          description: prospect.profile.description,
          prospectScore: prospect.prospectScore,
          prospectReason: prospect.prospectReason,
          personaMatch: prospect.personaMatches,
          recentPosts: prospect.posts.map(p => ({
            text: p.text,
            createdAt: p.createdAt,
            likes: p.likeCount,
            reposts: p.repostCount
          })),
          engagement: {
            likes: prospect.posts.reduce((sum, p) => sum + p.likeCount, 0),
            reposts: prospect.posts.reduce((sum, p) => sum + p.repostCount, 0),
            replies: prospect.posts.reduce((sum, p) => sum + p.replyCount, 0)
          },
          identifiedAt: FieldValue.serverTimestamp(),
          status: 'new',
          notes: ''
        });
      } catch (error) {
        this.log('warn', 'Failed to store prospect', {
          handle: prospect.profile.handle,
          error: error.message
        });
      }
    }

    // Generate report
    return this.formatAnalysisReport({
      personas,
      postsAnalyzed: recentPosts.length,
      authorsAnalyzed: authorMap.size,
      prospects: topProspects,
      lookbackHours,
      minProspectScore
    });
  }

  /**
   * Evaluate if profile is a qualified prospect using AI
   */
  async evaluateProspect({ profile, recentPosts, personas, gemini }) {
    const prospectPrompt = `Evaluate if this Bluesky user is a qualified marketing prospect.

**Target Personas:**
${personas.map(p => `- ${p.name}: ${p.industry || 'N/A'}`).join('\n')}

**Persona Criteria:**
${personas.map(p => `
**${p.name}:**
- Job Titles: ${p.jobTitles ? p.jobTitles.join(', ') : 'Not specified'}
- Interests: ${p.interests ? p.interests.join(', ') : 'Not specified'}
- Pain Points: ${p.painPoints ? p.painPoints.join(', ') : 'Not specified'}
- Buying Signals: ${p.buyingSignals ? p.buyingSignals.join(', ') : 'Not specified'}
`).join('\n')}

**Profile:**
- Handle: @${profile.handle}
- Display Name: ${profile.displayName || 'Not set'}
- Bio: ${profile.description || 'No bio'}
- Followers: ${profile.followersCount}
- Following: ${profile.followingCount}
- Posts: ${profile.postsCount}

**Recent Posts (last ${recentPosts.length}):**
${recentPosts.map((p, i) => `
${i + 1}. "${p.text}" (${p.likeCount} likes, ${p.repostCount} reposts)
`).join('\n')}

**Task:** Score 0-100 (0=not a prospect, 100=highly qualified).

**Consider:**
1. Profile matches persona industry/role (check bio and display name)
2. Recent posts show pain points we solve or buying signals
3. Engagement indicates active, influential user
4. Bio/posts show decision-making authority or budget control
5. Recent activity suggests current need or interest

**Identify:**
- Which persona(s) this profile matches (if any)
- Specific buying signals detected in posts
- Why this is a qualified prospect

Respond ONLY with JSON:
{
  "score": <number 0-100>,
  "reason": "<2-3 sentence explanation>",
  "personaMatches": ["persona_id_1", "persona_id_2"],
  "buyingSignals": ["signal 1", "signal 2"]
}`;

    try {
      const response = await gemini.generateResponse(prospectPrompt, {
        temperature: 0.3, // Low temperature for consistent evaluation
        maxTokens: 300
      });

      // Parse JSON response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          score: Math.max(0, Math.min(100, result.score || 0)),
          reason: result.reason || 'No reason provided',
          personaMatches: result.personaMatches || [],
          buyingSignals: result.buyingSignals || []
        };
      }

      this.log('warn', 'AI response not in expected JSON format', { response });
      return {
        score: 0,
        reason: 'Invalid AI response format',
        personaMatches: [],
        buyingSignals: []
      };
    } catch (error) {
      this.log('error', 'AI prospect evaluation failed', {
        error: error.message,
        stack: error.stack,
        handle: profile?.handle,
        promptLength: prospectPrompt?.length
      });
      return {
        score: 0,
        reason: `Evaluation error: ${error.message}`,
        personaMatches: [],
        buyingSignals: []
      };
    }
  }

  /**
   * Load personas from knowledge base
   */
  async loadPersonas(personaIds, toolContext) {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const knowledgeBase = toolContext.knowledgeBase || getKnowledgeBase();

    try {
      this.log('info', 'Searching KB for personas', { query: 'marketing persona customer' });

      const results = await knowledgeBase.searchKnowledge('marketing persona customer', {
        maxResults: 20,
        minRelevance: 0.3
      });

      this.log('info', 'KB search results', {
        resultsCount: results.length,
        titles: results.map(r => r.title)
      });

      const personas = [];

      for (const doc of results) {
        const extracted = this.extractPersonasFromDocument(doc.content);
        this.log('info', 'Personas extracted from doc', {
          title: doc.title,
          extractedCount: extracted.length,
          personaIds: extracted.map(p => p.personaId)
        });
        personas.push(...extracted);
      }

      this.log('info', 'Total personas loaded', {
        totalCount: personas.length,
        personaIds: personas.map(p => p.personaId)
      });

      // Filter by personaIds if provided
      if (personaIds && personaIds.length > 0) {
        return personas.filter(p => personaIds.includes(p.personaId));
      }

      return personas;
    } catch (error) {
      this.log('error', 'Failed to load personas', {
        error: error.message,
        stack: error.stack
      });
      return [];
    }
  }

  /**
   * Extract persona data from KB document
   */
  extractPersonasFromDocument(content) {
    const personas = [];

    const jsonMatches = content.matchAll(/```json\s*(\{[\s\S]*?"personaId"[\s\S]*?\})\s*```/g);

    for (const match of jsonMatches) {
      try {
        const personaData = JSON.parse(match[1]);
        if (personaData.personaId && personaData.name) {
          personas.push(personaData);
        }
      } catch (error) {
        // Skip invalid JSON
      }
    }

    return personas;
  }

  /**
   * Get existing prospect from Firestore
   */
  async getExistingProspect(did) {
    try {
      if (!this.firestore) {
        const { getFirestore } = require('../config/firestore');
        this.firestore = getFirestore();
      }
      const snapshot = await this.firestore
        .collection('bluesky-prospects')
        .where('did', '==', did)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return null;
      }

      return snapshot.docs[0].data();
    } catch (error) {
      this.log('warn', 'Error checking existing prospect', { did, error: error.message });
      return null;
    }
  }

  /**
   * Format analysis report for user
   */
  formatAnalysisReport({ personas, postsAnalyzed, authorsAnalyzed, prospects, lookbackHours, minProspectScore }) {
    let report = `📊 **Bluesky Feed Prospect Analysis Report**\n\n`;

    report += `**Analysis Period:** Last ${lookbackHours} hours\n`;
    report += `**Posts Analyzed:** ${postsAnalyzed}\n`;
    report += `**Unique Authors:** ${authorsAnalyzed}\n`;
    report += `**Personas Targeted:** ${personas.map(p => p.name).join(', ')}\n`;
    report += `**Minimum Score:** ${minProspectScore}/100\n`;
    report += `**Qualified Prospects:** ${prospects.length}\n\n`;

    if (prospects.length === 0) {
      report += `❌ No qualified prospects found in feed.\n\n`;
      report += `💡 **Suggestions:**\n`;
      report += `- Lower minProspectScore threshold (try 70 or 65)\n`;
      report += `- Follow more accounts matching target personas\n`;
      report += `- Expand lookbackHours to analyze more posts\n`;
      return report;
    }

    report += `🎯 **Top Prospects:**\n\n`;

    for (let i = 0; i < Math.min(prospects.length, 10); i++) {
      const prospect = prospects[i];

      report += `**${i + 1}. @${prospect.profile.handle}** (Score: ${prospect.prospectScore}/100)\n`;
      report += `   - Name: ${prospect.profile.displayName || 'Not set'}\n`;
      report += `   - Bio: ${prospect.profile.description || 'No bio'}\n`;
      report += `   - Stats: ${prospect.profile.followersCount} followers, ${prospect.posts.length} recent posts\n`;
      report += `   - Personas: ${prospect.personaMatches.join(', ') || 'General match'}\n`;
      report += `   - Why: ${prospect.prospectReason}\n`;

      if (prospect.buyingSignals.length > 0) {
        report += `   - 🚨 Buying Signals: ${prospect.buyingSignals.join(', ')}\n`;
      }

      // Show most relevant post
      const topPost = prospect.posts[0];
      if (topPost) {
        const postPreview = topPost.text.substring(0, 100);
        report += `   - Recent Post: "${postPreview}${topPost.text.length > 100 ? '...' : ''}"\n`;
      }

      report += `   - Profile: https://bsky.app/profile/${prospect.profile.handle}\n`;
      report += `\n`;
    }

    if (prospects.length > 10) {
      report += `... and ${prospects.length - 10} more prospects\n\n`;
    }

    report += `💡 **Next Steps:**\n`;
    report += `- Review top prospects above\n`;
    report += `- Engage with their content (like, reply, repost)\n`;
    report += `- Follow high-priority prospects\n`;
    report += `- Reach out via DM or comment with value-first approach\n`;

    return report;
  }

  /**
   * Generate report of existing prospects
   */
  async generateProspectReport({ maxProspects, minProspectScore }) {
    try {
      if (!this.firestore) {
        const { getFirestore } = require('../config/firestore');
        this.firestore = getFirestore();
      }
      const snapshot = await this.firestore
        .collection('bluesky-prospects')
        .where('prospectScore', '>=', minProspectScore)
        .orderBy('prospectScore', 'desc')
        .orderBy('identifiedAt', 'desc')
        .limit(maxProspects)
        .get();

      if (snapshot.empty) {
        return '📊 **Prospect Report**\n\nNo prospects found. Run feed analysis first.';
      }

      const prospects = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Group by status
      const byStatus = {
        new: [],
        contacted: [],
        qualified: [],
        disqualified: []
      };

      for (const prospect of prospects) {
        const status = prospect.status || 'new';
        if (byStatus[status]) {
          byStatus[status].push(prospect);
        }
      }

      let report = `📊 **Bluesky Prospects Report**\n\n`;
      report += `**Total Prospects:** ${prospects.length}\n`;
      report += `- New: ${byStatus.new.length}\n`;
      report += `- Contacted: ${byStatus.contacted.length}\n`;
      report += `- Qualified: ${byStatus.qualified.length}\n`;
      report += `- Disqualified: ${byStatus.disqualified.length}\n\n`;

      // Show top prospects by score
      report += `🌟 **Top Prospects:**\n\n`;

      const topProspects = prospects.slice(0, 10);

      for (let i = 0; i < topProspects.length; i++) {
        const prospect = topProspects[i];

        report += `**${i + 1}. @${prospect.handle}** (Score: ${prospect.prospectScore}/100)\n`;
        report += `   - Status: ${prospect.status || 'new'}\n`;
        report += `   - Why: ${prospect.prospectReason}\n`;
        report += `   - Engagement: ${prospect.engagement?.likes || 0} likes, ${prospect.engagement?.reposts || 0} reposts\n`;
        report += `   - Identified: ${prospect.identifiedAt?.toDate()?.toLocaleDateString() || 'Unknown'}\n`;

        if (prospect.notes) {
          report += `   - Notes: ${prospect.notes}\n`;
        }

        report += `\n`;
      }

      return report;
    } catch (error) {
      this.log('error', 'Failed to generate prospect report', { error: error.message });
      return `❌ Error generating report: ${error.message}`;
    }
  }
}

module.exports = BskyFeedAnalyzer;
