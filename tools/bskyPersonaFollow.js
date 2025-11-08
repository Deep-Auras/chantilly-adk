/**
 * Bluesky Persona-Based Following Tool
 *
 * Discovers and follows Bluesky profiles matching marketing personas
 * defined in knowledge base. Uses AI to evaluate profile relevance.
 *
 * Features:
 * - Persona-based profile discovery
 * - AI match scoring with Gemini
 * - Automatic following with daily limits
 * - Dry-run mode for testing
 * - Detailed match reporting
 *
 * @module tools/bskyPersonaFollow
 */

const BaseTool = require('../lib/baseTool');
const { getBskyService } = require('../services/bskyService');
const { getGeminiService } = require('../services/gemini');

class BskyPersonaFollow extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'BskyPersonaFollow';
    this.description = 'Discover and follow Bluesky profiles matching marketing personas when user EXPLICITLY requests "find Bluesky profiles matching our personas" or "follow people on Bluesky who match our target audience" or "search for bsky profiles matching personas". This tool searches for profiles based on persona characteristics (industry, interests, job titles) defined in knowledge base documents, evaluates match quality using AI, and automatically follows high-match profiles. Use ONLY when user wants to grow Bluesky following based on persona targeting. DO NOT use for general profile searches, manual follows, or conversational questions about personas.';
    this.priority = 60;
    this.timeout = 15 * 60 * 1000; // 15 minutes (AI scoring can take time)

    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'follow', 'report'],
          description: 'Action to perform. "search" finds matches without following, "follow" searches and follows, "report" generates summary of followed profiles.'
        },
        personaIds: {
          type: 'array',
          description: 'Array of persona IDs to target (optional, defaults to all personas in knowledge base)'
        },
        matchThreshold: {
          type: 'number',
          description: 'Minimum match score (0-100) to consider profile a good match (default: 75)'
        },
        maxFollows: {
          type: 'number',
          description: 'Maximum profiles to follow in single execution (default: 10)'
        },
        dryRun: {
          type: 'boolean',
          description: 'If true, only search and score, do not actually follow (default: false)'
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
      action = 'search',
      personaIds = null,
      matchThreshold = 75,
      maxFollows = 10,
      dryRun = false
    } = args;

    try {
      // Initialize services
      const bsky = getBskyService();
      const initialized = await bsky.initialize();

      if (!initialized) {
        return '❌ Bluesky integration not available. Check ENABLE_BLUESKY_INTEGRATION setting.';
      }

      switch (action) {
        case 'search':
        case 'follow':
          return await this.searchAndFollow({
            personaIds,
            matchThreshold,
            maxFollows,
            dryRun: dryRun || action === 'search',
            toolContext
          });

        case 'report':
          return await this.generateReport();

        default:
          return '❌ Unknown action. Use "search", "follow", or "report".';
      }
    } catch (error) {
      this.log('error', 'BskyPersonaFollow execution failed', { error: error.message });
      return `❌ Error: ${error.message}`;
    }
  }

  /**
   * Search for profiles and follow based on persona match
   */
  async searchAndFollow({ personaIds, matchThreshold, maxFollows, dryRun, toolContext }) {
    const bsky = getBskyService();
    const gemini = getGeminiService();

    // Load personas from knowledge base
    this.log('info', 'Loading marketing personas from knowledge base');

    const personas = await this.loadPersonas(personaIds, toolContext);

    if (personas.length === 0) {
      return '❌ No marketing personas found in knowledge base. Add persona definitions first.';
    }

    this.log('info', 'Personas loaded', { count: personas.length });

    // Search for profiles matching each persona
    const allMatches = [];
    const searchQueries = [];

    for (const persona of personas) {
      // Generate search queries from persona
      const queries = this.generateSearchQueries(persona);
      searchQueries.push(...queries.map(q => ({ query: q, persona })));
    }

    this.log('info', 'Generated search queries', { count: searchQueries.length });

    // Search profiles (limit to avoid quota exhaustion)
    const maxSearches = Math.min(searchQueries.length, 10);
    for (let i = 0; i < maxSearches; i++) {
      const { query, persona } = searchQueries[i];

      try {
        this.log('info', 'Searching profiles', { query, persona: persona.name });

        const profiles = await bsky.searchProfiles(query, 20);

        // Score each profile against persona
        for (const profile of profiles) {
          // Skip profiles with low follower count (likely bots)
          if (profile.followersCount < 10) {
            continue;
          }

          // Skip if already followed
          const alreadyFollowed = await this.isAlreadyFollowed(profile.did);
          if (alreadyFollowed) {
            continue;
          }

          // AI match scoring
          const matchScore = await this.scoreProfileMatch(profile, persona, gemini);

          if (matchScore.score >= matchThreshold) {
            allMatches.push({
              profile,
              persona,
              matchScore: matchScore.score,
              matchReason: matchScore.reason
            });
          }
        }
      } catch (error) {
        this.log('warn', 'Profile search failed', { query, error: error.message });
      }
    }

    // Sort by match score (highest first)
    allMatches.sort((a, b) => b.matchScore - a.matchScore);

    // Limit to maxFollows
    const toFollow = allMatches.slice(0, maxFollows);

    if (toFollow.length === 0) {
      return `📊 **Persona Profile Search Results**\n\nSearched ${maxSearches} queries across ${personas.length} personas.\n\n❌ No profiles found matching threshold of ${matchThreshold}/100.\n\nTry lowering matchThreshold or expanding persona definitions.`;
    }

    // Follow profiles (or dry-run)
    const followResults = [];

    if (dryRun) {
      this.log('info', 'Dry-run mode: would follow', { count: toFollow.length });
    } else {
      for (const match of toFollow) {
        try {
          const followUri = await bsky.followUser(match.profile.did);

          // Store match data in Firestore
          if (!this.firestore) {
            const { getFirestore } = require('../config/firestore');
            this.firestore = getFirestore();
          }
          await this.firestore.collection('bluesky-followed-profiles').doc(match.profile.did).update({
            personaMatch: {
              personaId: match.persona.personaId,
              personaName: match.persona.name,
              matchScore: match.matchScore,
              matchReason: match.matchReason
            }
          });

          followResults.push({
            profile: match.profile,
            persona: match.persona.name,
            matchScore: match.matchScore,
            followed: true
          });

          this.log('info', 'Followed profile', {
            handle: match.profile.handle,
            persona: match.persona.name,
            matchScore: match.matchScore
          });
        } catch (error) {
          this.log('warn', 'Failed to follow profile', {
            handle: match.profile.handle,
            error: error.message
          });

          followResults.push({
            profile: match.profile,
            persona: match.persona.name,
            matchScore: match.matchScore,
            followed: false,
            error: error.message
          });
        }
      }
    }

    // Generate report
    return this.formatFollowReport({
      personas,
      matches: toFollow,
      followResults: dryRun ? [] : followResults,
      dryRun,
      matchThreshold
    });
  }

  /**
   * Load personas from knowledge base
   */
  async loadPersonas(personaIds, toolContext) {
    // Search knowledge base for persona documents
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const knowledgeBase = toolContext.knowledgeBase || getKnowledgeBase();

    try {
      // Search for documents containing persona data
      const results = await knowledgeBase.searchKnowledge('marketing persona customer', {
        maxResults: 20,
        minRelevance: 0.3
      });

      const personas = [];

      for (const doc of results) {
        // Parse persona data from document content
        const extracted = this.extractPersonasFromDocument(doc.content);
        personas.push(...extracted);
      }

      // Filter by personaIds if provided
      if (personaIds && personaIds.length > 0) {
        return personas.filter(p => personaIds.includes(p.personaId));
      }

      return personas;
    } catch (error) {
      this.log('error', 'Failed to load personas', { error: error.message });
      return [];
    }
  }

  /**
   * Extract persona data from KB document
   */
  extractPersonasFromDocument(content) {
    const personas = [];

    // Look for JSON persona definitions in content
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
   * Generate search queries from persona
   */
  generateSearchQueries(persona) {
    const queries = [];

    // Job titles
    if (persona.jobTitles && persona.jobTitles.length > 0) {
      queries.push(...persona.jobTitles.slice(0, 2)); // Top 2 job titles
    }

    // Industry keywords
    if (persona.industry) {
      queries.push(persona.industry);
    }

    // Bio keywords
    if (persona.bio_keywords && persona.bio_keywords.length > 0) {
      queries.push(...persona.bio_keywords.slice(0, 3)); // Top 3 keywords
    }

    // Limit to 5 queries per persona
    return queries.slice(0, 5);
  }

  /**
   * Score profile match against persona using AI
   */
  async scoreProfileMatch(profile, persona, gemini) {
    const matchPrompt = `Evaluate if this Bluesky profile matches our marketing persona.

**Persona: ${persona.name}**
- Industry: ${persona.industry || 'Not specified'}
- Job Titles: ${persona.jobTitles ? persona.jobTitles.join(', ') : 'Not specified'}
- Interests: ${persona.interests ? persona.interests.join(', ') : 'Not specified'}
- Pain Points: ${persona.painPoints ? persona.painPoints.join(', ') : 'Not specified'}

**Profile:**
- Handle: ${profile.handle}
- Display Name: ${profile.displayName || 'Not set'}
- Bio: ${profile.description || 'No bio'}
- Followers: ${profile.followersCount}
- Following: ${profile.followingCount}
- Posts: ${profile.postsCount}

Score 0-100 (0=no match, 100=perfect match). Consider:
1. Bio mentions persona industry, job titles, or interests
2. Follower/following counts indicate real active account (not bot)
3. Display name or handle suggests relevant professional identity
4. Account activity (posts count) shows engagement

Respond ONLY with JSON:
{
  "score": <number 0-100>,
  "reason": "<1-2 sentence explanation of score>"
}`;

    try {
      const response = await gemini.generateResponse(matchPrompt, {
        temperature: 0.3, // Low temperature for consistent scoring
        maxTokens: 150
      });

      // Parse JSON response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          score: Math.max(0, Math.min(100, result.score)),
          reason: result.reason || 'No reason provided'
        };
      }

      this.log('warn', 'AI response not in expected JSON format', { response });
      return { score: 0, reason: 'Invalid AI response format' };
    } catch (error) {
      this.log('error', 'AI scoring failed', { error: error.message });
      return { score: 0, reason: `Scoring error: ${error.message}` };
    }
  }

  /**
   * Check if profile already followed
   */
  async isAlreadyFollowed(did) {
    try {
      if (!this.firestore) {
        const { getFirestore } = require('../config/firestore');
        this.firestore = getFirestore();
      }
      const doc = await this.firestore.collection('bluesky-followed-profiles').doc(did).get();
      return doc.exists;
    } catch (error) {
      this.log('warn', 'Error checking if profile followed', { did, error: error.message });
      return false;
    }
  }

  /**
   * Format follow report for user
   */
  formatFollowReport({ personas, matches, followResults, dryRun, matchThreshold }) {
    let report = `📊 **Bluesky Persona-Based Profile ${dryRun ? 'Search' : 'Follow'} Report**\n\n`;

    report += `**Personas Targeted:** ${personas.map(p => p.name).join(', ')}\n`;
    report += `**Match Threshold:** ${matchThreshold}/100\n`;
    report += `**Profiles Found:** ${matches.length}\n\n`;

    if (dryRun) {
      report += `**Mode:** Dry-run (no actual follows performed)\n\n`;
      report += `🎯 **Top Matches (would follow):**\n\n`;
    } else {
      const succeeded = followResults.filter(r => r.followed).length;
      const failed = followResults.filter(r => !r.followed).length;

      report += `**Followed:** ${succeeded} profiles\n`;
      if (failed > 0) {
        report += `**Failed:** ${failed} profiles\n`;
      }
      report += `\n🎯 **Followed Profiles:**\n\n`;
    }

    // List top matches
    const toShow = matches.slice(0, 10);

    for (let i = 0; i < toShow.length; i++) {
      const match = toShow[i];
      const followResult = followResults.find(r => r.profile.did === match.profile.did);

      report += `**${i + 1}. @${match.profile.handle}** (Score: ${match.matchScore}/100)\n`;
      report += `   - Name: ${match.profile.displayName || 'Not set'}\n`;
      report += `   - Bio: ${match.profile.description || 'No bio'}\n`;
      report += `   - Stats: ${match.profile.followersCount} followers, ${match.profile.postsCount} posts\n`;
      report += `   - Persona: ${match.persona.name}\n`;
      report += `   - Why: ${match.matchReason}\n`;

      if (followResult) {
        if (followResult.followed) {
          report += `   - ✅ Followed successfully\n`;
        } else {
          report += `   - ❌ Follow failed: ${followResult.error}\n`;
        }
      }

      report += `\n`;
    }

    if (matches.length > 10) {
      report += `... and ${matches.length - 10} more matches\n\n`;
    }

    if (dryRun) {
      report += `💡 **Next Steps:**\n`;
      report += `- Review matches above\n`;
      report += `- Run with dryRun=false to actually follow profiles\n`;
      report += `- Adjust matchThreshold if needed (lower = more profiles, higher = more selective)\n`;
    }

    return report;
  }

  /**
   * Generate report of followed profiles
   */
  async generateReport() {
    try {
      if (!this.firestore) {
        const { getFirestore } = require('../config/firestore');
        this.firestore = getFirestore();
      }
      const snapshot = await this.firestore
        .collection('bluesky-followed-profiles')
        .orderBy('followedAt', 'desc')
        .limit(50)
        .get();

      if (snapshot.empty) {
        return '📊 **Followed Profiles Report**\n\nNo profiles followed yet.';
      }

      const profiles = snapshot.docs.map(doc => doc.data());

      // Group by persona
      const byPersona = {};

      for (const profile of profiles) {
        const personaName = profile.personaMatch?.personaName || 'Unknown';

        if (!byPersona[personaName]) {
          byPersona[personaName] = [];
        }

        byPersona[personaName].push(profile);
      }

      let report = `📊 **Bluesky Followed Profiles Report**\n\n`;
      report += `**Total Followed:** ${profiles.length} profiles\n\n`;

      for (const [personaName, personaProfiles] of Object.entries(byPersona)) {
        report += `**${personaName}** (${personaProfiles.length} profiles):\n`;

        const avgScore = personaProfiles.reduce((sum, p) =>
          sum + (p.personaMatch?.matchScore || 0), 0) / personaProfiles.length;

        report += `   - Average Match Score: ${avgScore.toFixed(0)}/100\n`;

        // Show top 3
        const top3 = personaProfiles.slice(0, 3);
        for (const profile of top3) {
          report += `   - @${profile.handle} (${profile.personaMatch?.matchScore || 0}/100)\n`;
        }

        if (personaProfiles.length > 3) {
          report += `   ... and ${personaProfiles.length - 3} more\n`;
        }

        report += `\n`;
      }

      return report;
    } catch (error) {
      this.log('error', 'Failed to generate report', { error: error.message });
      return `❌ Error generating report: ${error.message}`;
    }
  }
}

module.exports = BskyPersonaFollow;
