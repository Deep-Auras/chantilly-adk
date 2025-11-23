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
    this.description = 'Discover and follow Bluesky profiles matching marketing personas when user EXPLICITLY requests to find or follow people on Bluesky. Use action="follow" when user says "follow people on Bluesky matching personas" or "find and follow" (actually follows profiles). Use action="search" ONLY when user explicitly says "dry run" or "preview matches without following" (simulation only, no actual follows). This tool searches for profiles based on persona characteristics, evaluates match quality using AI, and can automatically follow high-match profiles. Use ONLY when user wants to grow Bluesky following based on persona targeting. DO NOT use for general profile searches, manual follows, or conversational questions about personas.';
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
          description: 'Minimum match score (0-100) to consider profile a good match. Use 50 (balanced - recommended), 40 (more inclusive), or 60 (more selective). DO NOT use values above 60 unless explicitly requested by user.'
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
      matchThreshold = 50, // 50% threshold - balanced between too selective and too broad
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
   * Search for profiles and follow based on persona match (HYBRID APPROACH)
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

    // HYBRID APPROACH: Collect profiles from BOTH suggested follows AND search
    const allProfiles = new Map(); // Use Map to deduplicate by DID
    let profilesFromSuggested = 0;
    let profilesFromSearch = 0;
    const performanceMetrics = {
      startTime: Date.now(),
      suggestedFetchTime: 0,
      searchFetchTime: 0,
      aiScoringTime: 0,
      totalTime: 0
    };

    // 1. Get suggested follows from Bluesky's algorithm (real, active accounts)
    this.log('info', 'DISCOVERY SOURCE 1: Fetching Bluesky suggested follows');
    const suggestedStartTime = Date.now();

    try {
      const suggestedProfiles = await bsky.getSuggestedFollows();

      for (const profile of suggestedProfiles) {
        if (!allProfiles.has(profile.did)) {
          allProfiles.set(profile.did, { ...profile, source: 'suggested' });
          profilesFromSuggested++;
        }
      }

      performanceMetrics.suggestedFetchTime = Date.now() - suggestedStartTime;

      this.log('info', 'SOURCE 1 COMPLETE: Suggested follows fetched', {
        count: profilesFromSuggested,
        fetchTimeMs: performanceMetrics.suggestedFetchTime,
        avgTimePerProfile: profilesFromSuggested > 0 ? Math.round(performanceMetrics.suggestedFetchTime / profilesFromSuggested) : 0
      });
    } catch (error) {
      this.log('error', 'SOURCE 1 FAILED: Error fetching suggested follows', {
        error: error.message,
        stack: error.stack
      });
    }

    // 2. Search for profiles using persona-based queries
    this.log('info', 'DISCOVERY SOURCE 2: Starting persona-based keyword search');
    const searchStartTime = Date.now();

    const searchQueries = [];
    for (const persona of personas) {
      const queries = this.generateSearchQueries(persona);
      searchQueries.push(...queries.map(q => ({ query: q, persona })));
    }

    this.log('info', 'Generated search queries', {
      totalQueries: searchQueries.length,
      queriesPerPersona: Math.round(searchQueries.length / personas.length),
      personas: personas.map(p => p.name)
    });

    // Search profiles (limit to avoid quota exhaustion)
    const maxSearches = Math.min(searchQueries.length, 10);
    let searchesExecuted = 0;
    let searchesSucceeded = 0;
    let searchesFailed = 0;
    let duplicatesSkipped = 0;

    for (let i = 0; i < maxSearches; i++) {
      const { query, persona } = searchQueries[i];
      searchesExecuted++;

      try {
        this.log('info', 'Executing search query', {
          queryNumber: i + 1,
          totalQueries: maxSearches,
          query,
          persona: persona.name
        });

        const queryStartTime = Date.now();
        const profiles = await bsky.searchProfiles(query, 20);
        const queryTime = Date.now() - queryStartTime;

        let newProfilesFromThisQuery = 0;
        let duplicatesFromThisQuery = 0;

        for (const profile of profiles) {
          // Add to collection if not already present (deduplicate by DID)
          if (!allProfiles.has(profile.did)) {
            allProfiles.set(profile.did, { ...profile, source: 'search' });
            profilesFromSearch++;
            newProfilesFromThisQuery++;
          } else {
            duplicatesSkipped++;
            duplicatesFromThisQuery++;
          }
        }

        searchesSucceeded++;

        this.log('info', 'Search query complete', {
          query,
          resultsReturned: profiles.length,
          newProfiles: newProfilesFromThisQuery,
          duplicates: duplicatesFromThisQuery,
          queryTimeMs: queryTime
        });
      } catch (error) {
        searchesFailed++;
        this.log('warn', 'Search query failed', {
          query,
          persona: persona.name,
          error: error.message
        });
      }
    }

    performanceMetrics.searchFetchTime = Date.now() - searchStartTime;

    this.log('info', 'SOURCE 2 COMPLETE: Keyword search finished', {
      searchesExecuted,
      searchesSucceeded,
      searchesFailed,
      successRate: `${Math.round((searchesSucceeded / searchesExecuted) * 100)}%`,
      profilesFound: profilesFromSearch,
      duplicatesSkipped,
      avgProfilesPerSearch: Math.round(profilesFromSearch / searchesSucceeded),
      totalSearchTimeMs: performanceMetrics.searchFetchTime,
      avgTimePerSearch: Math.round(performanceMetrics.searchFetchTime / searchesExecuted)
    });

    this.log('info', 'HYBRID DISCOVERY SUMMARY', {
      totalProfiles: allProfiles.size,
      fromSuggested: profilesFromSuggested,
      fromSearch: profilesFromSearch,
      sourceBreakdown: {
        suggested: `${Math.round((profilesFromSuggested / allProfiles.size) * 100)}%`,
        search: `${Math.round((profilesFromSearch / allProfiles.size) * 100)}%`
      },
      totalFetchTimeMs: performanceMetrics.suggestedFetchTime + performanceMetrics.searchFetchTime
    });

    // 3. Filter already-followed profiles before AI scoring
    const candidateProfiles = [];
    let profilesSkippedAlreadyFollowed = 0;

    for (const [did, profile] of allProfiles) {
      const alreadyFollowed = await this.isAlreadyFollowed(profile.did);
      if (alreadyFollowed) {
        profilesSkippedAlreadyFollowed++;
        continue;
      }
      candidateProfiles.push(profile);
    }

    this.log('info', 'Candidate profiles ready for AI scoring', {
      total: candidateProfiles.length,
      skippedAlreadyFollowed: profilesSkippedAlreadyFollowed
    });

    // 4. BATCH AI scoring - send ALL profiles to AI in ONE request
    const maxCandidates = 40;
    const profilesToScore = candidateProfiles.slice(0, maxCandidates);

    // Count profiles by source going into AI scoring
    const profilesBySourcePreAI = {
      suggested: profilesToScore.filter(p => p.source === 'suggested').length,
      search: profilesToScore.filter(p => p.source === 'search').length
    };

    this.log('info', 'AI SCORING: Starting batch evaluation', {
      profilesCount: profilesToScore.length,
      personasCount: personas.length,
      bySource: profilesBySourcePreAI,
      candidatesPerPersona: Math.round(profilesToScore.length / personas.length)
    });

    const aiScoringStartTime = Date.now();
    const scoringResults = await this.batchScoreProfiles({
      profiles: profilesToScore,
      personas,
      gemini
    });
    performanceMetrics.aiScoringTime = Date.now() - aiScoringStartTime;

    this.log('info', 'AI SCORING COMPLETE', {
      resultsCount: scoringResults.length,
      aiScoringTimeMs: performanceMetrics.aiScoringTime,
      avgTimePerProfile: Math.round(performanceMetrics.aiScoringTime / scoringResults.length)
    });

    // 5. Process scoring results
    const allMatches = [];
    let profilesBelowThreshold = 0;
    const allScores = [];
    const scoresBySource = {
      suggested: [],
      search: []
    };

    for (const result of scoringResults) {
      allScores.push({
        handle: result.profile.handle,
        score: result.bestScore,
        source: result.profile.source,
        reason: result.reason
      });

      // Track scores by source for analysis
      scoresBySource[result.profile.source].push(result.bestScore);

      if (result.bestScore >= matchThreshold) {
        allMatches.push({
          profile: result.profile,
          persona: result.bestPersona,
          matchScore: result.bestScore,
          matchReason: result.reason,
          source: result.profile.source
        });

        this.log('info', 'HIGH MATCH FOUND', {
          handle: result.profile.handle,
          persona: result.bestPersona.name,
          score: result.bestScore,
          source: result.profile.source,
          reason: result.reason.substring(0, 100)
        });
      } else {
        profilesBelowThreshold++;
      }
    }

    const profilesScanned = scoringResults.length;

    // Calculate source-specific statistics
    const avgScoreBySource = {
      suggested: scoresBySource.suggested.length > 0
        ? Math.round(scoresBySource.suggested.reduce((a, b) => a + b, 0) / scoresBySource.suggested.length)
        : 0,
      search: scoresBySource.search.length > 0
        ? Math.round(scoresBySource.search.reduce((a, b) => a + b, 0) / scoresBySource.search.length)
        : 0
    };

    const matchesBySource = {
      suggested: allMatches.filter(m => m.source === 'suggested').length,
      search: allMatches.filter(m => m.source === 'search').length
    };

    const matchRateBySource = {
      suggested: scoresBySource.suggested.length > 0
        ? `${Math.round((matchesBySource.suggested / scoresBySource.suggested.length) * 100)}%`
        : '0%',
      search: scoresBySource.search.length > 0
        ? `${Math.round((matchesBySource.search / scoresBySource.search.length) * 100)}%`
        : '0%'
    };

    // Log comprehensive summary statistics
    this.log('info', 'FILTERING COMPLETE: Threshold analysis', {
      profilesScanned,
      profilesSkippedAlreadyFollowed,
      profilesBelowThreshold,
      matchesFound: allMatches.length,
      matchThreshold,
      matchRate: `${Math.round((allMatches.length / profilesScanned) * 100)}%`
    });

    this.log('info', 'SOURCE PERFORMANCE ANALYSIS', {
      avgScores: avgScoreBySource,
      matchesBySource,
      matchRateBySource,
      profilesEvaluatedBySource: {
        suggested: scoresBySource.suggested.length,
        search: scoresBySource.search.length
      },
      winningSource: avgScoreBySource.suggested > avgScoreBySource.search ? 'suggested' : 'search',
      scoreDifference: Math.abs(avgScoreBySource.suggested - avgScoreBySource.search)
    });

    this.log('info', 'TOP SCORING PROFILES', {
      top5: allScores
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(s => ({
          handle: s.handle,
          score: s.score,
          source: s.source
        }))
    });

    // Sort by match score (highest first)
    allMatches.sort((a, b) => b.matchScore - a.matchScore);

    // Limit to maxFollows
    const toFollow = allMatches.slice(0, maxFollows);

    if (toFollow.length === 0) {
      return `📊 **Persona Profile Search Results (Hybrid Approach)**\n\nCollected ${allProfiles.size} profiles (${profilesFromSuggested} suggested + ${profilesFromSearch} search results)\nEvaluated ${profilesScanned} profiles against ${personas.length} personas.\n\n❌ No profiles found matching threshold of ${matchThreshold}/100.\n\nStats:\n- ${profilesSkippedAlreadyFollowed} already followed\n- ${profilesBelowThreshold} scored below threshold\n\n${allScores.length > 0 ? `Top scores: ${allScores.sort((a, b) => b.score - a.score).slice(0, 3).map(s => `${s.handle}=${s.score}`).join(', ')}\n\n` : ''}Try lowering matchThreshold or check persona definitions.`;
    }

    // Follow profiles (or dry-run)
    const followResults = [];

    if (dryRun) {
      const dryRunBySource = {
        suggested: toFollow.filter(m => m.source === 'suggested').length,
        search: toFollow.filter(m => m.source === 'search').length
      };

      this.log('info', 'DRY-RUN MODE: Would follow profiles', {
        totalCount: toFollow.length,
        bySource: dryRunBySource,
        avgScore: Math.round(toFollow.reduce((sum, m) => sum + m.matchScore, 0) / toFollow.length)
      });
    } else {
      this.log('info', 'FOLLOW EXECUTION: Starting to follow profiles', {
        count: toFollow.length
      });

      let followsSucceeded = 0;
      let followsFailed = 0;
      const followResultsBySource = {
        suggested: { succeeded: 0, failed: 0 },
        search: { succeeded: 0, failed: 0 }
      };

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
            followed: true,
            source: match.source
          });

          followsSucceeded++;
          followResultsBySource[match.source].succeeded++;

          this.log('info', 'FOLLOW SUCCESS', {
            handle: match.profile.handle,
            persona: match.persona.name,
            matchScore: match.matchScore,
            source: match.source
          });
        } catch (error) {
          followsFailed++;
          followResultsBySource[match.source].failed++;

          this.log('warn', 'FOLLOW FAILED', {
            handle: match.profile.handle,
            persona: match.persona.name,
            source: match.source,
            error: error.message
          });

          followResults.push({
            profile: match.profile,
            persona: match.persona.name,
            matchScore: match.matchScore,
            followed: false,
            error: error.message,
            source: match.source
          });
        }
      }

      this.log('info', 'FOLLOW EXECUTION COMPLETE', {
        totalAttempted: toFollow.length,
        succeeded: followsSucceeded,
        failed: followsFailed,
        successRate: `${Math.round((followsSucceeded / toFollow.length) * 100)}%`,
        resultsBySource: followResultsBySource
      });
    }

    // Final performance report
    performanceMetrics.totalTime = Date.now() - performanceMetrics.startTime;

    this.log('info', 'FINAL PERFORMANCE REPORT', {
      totalExecutionTimeMs: performanceMetrics.totalTime,
      breakdown: {
        suggestedFetchMs: performanceMetrics.suggestedFetchTime,
        searchFetchMs: performanceMetrics.searchFetchTime,
        aiScoringMs: performanceMetrics.aiScoringTime,
        otherMs: performanceMetrics.totalTime - (performanceMetrics.suggestedFetchTime + performanceMetrics.searchFetchTime + performanceMetrics.aiScoringTime)
      },
      timePercentages: {
        suggested: `${Math.round((performanceMetrics.suggestedFetchTime / performanceMetrics.totalTime) * 100)}%`,
        search: `${Math.round((performanceMetrics.searchFetchTime / performanceMetrics.totalTime) * 100)}%`,
        aiScoring: `${Math.round((performanceMetrics.aiScoringTime / performanceMetrics.totalTime) * 100)}%`
      },
      efficiency: {
        profilesPerSecond: Math.round((allProfiles.size / performanceMetrics.totalTime) * 1000),
        aiProfilesPerSecond: Math.round((profilesToScore.length / performanceMetrics.aiScoringTime) * 1000)
      }
    });

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
   * Batch score all profiles against all personas in ONE AI call
   */
  async batchScoreProfiles({ profiles, personas, gemini }) {
    // Build comprehensive prompt with ALL profiles and ALL personas
    const profilesList = profiles.map((p, idx) => `
**Profile ${idx + 1}:**
- Handle: ${p.handle}
- Display Name: ${p.displayName || 'Not set'}
- Bio: ${p.description || 'No bio'}
- Source: ${p.source}`).join('\n');

    const personasList = personas.map((p, idx) => `
**Persona ${idx + 1}: ${p.name}** (ID: ${p.personaId})
- Industry: ${p.industry || 'Not specified'}
- Job Titles: ${p.jobTitles ? p.jobTitles.join(', ') : 'Not specified'}
- Interests: ${p.interests ? p.interests.join(', ') : 'Not specified'}
- Pain Points: ${p.painPoints ? p.painPoints.join(', ') : 'Not specified'}`).join('\n');

    const batchPrompt = `Evaluate ${profiles.length} Bluesky profiles against ${personas.length} marketing personas.

**PERSONAS:**
${personasList}

**PROFILES TO EVALUATE:**
${profilesList}

**TASK:** For EACH profile, find the BEST matching persona and assign a score 0-100.

**Scoring Guidelines:**
1. Bio mentions persona industry, job titles, or interests (HIGH PRIORITY - must have substantive bio)
2. Display name or handle suggests relevant professional identity
3. Bio shows genuine professional persona (not spam/bot - look for complete sentences, specific expertise)
4. **CRITICAL: If bio is empty, generic, or spam-like, score must be 0-20 maximum**

**Examples of LOW scores:**
- Empty bio or "No bio" → 0
- Generic bios like "crypto enthusiast" → 10
- Promotional/spam bios → 0
- Single emoji or keyword → 5

**Examples of HIGH scores:**
- Detailed professional bio with job title + industry → 70-90
- Bio mentions specific expertise and pain points → 80-100
- Clear professional identity matching persona → 90-100

**CRITICAL: Respond with ONLY a JSON array, one object per profile, in the SAME order as the profiles above:**

[
  {
    "profileIndex": 1,
    "bestPersonaId": "persona_id_here",
    "score": 85,
    "reason": "One sentence explanation"
  },
  {
    "profileIndex": 2,
    "bestPersonaId": "persona_id_here",
    "score": 0,
    "reason": "Empty bio"
  }
]

IMPORTANT: Return exactly ${profiles.length} results in the same order as the input profiles.`;

    try {
      const response = await gemini.generateResponse(batchPrompt, {
        temperature: 0.3,
        maxTokens: 4000 // Larger limit for batch responses
      });

      // Parse JSON array response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.log('error', 'AI batch response not in expected JSON array format', { response });
        // Fallback: return 0 scores for all
        return profiles.map(profile => ({
          profile,
          bestPersona: personas[0],
          bestScore: 0,
          reason: 'Invalid AI response format'
        }));
      }

      const results = JSON.parse(jsonMatch[0]);

      // Map results back to profiles with persona objects
      return profiles.map((profile, idx) => {
        const result = results.find(r => r.profileIndex === idx + 1) || results[idx];

        if (!result) {
          return {
            profile,
            bestPersona: personas[0],
            bestScore: 0,
            reason: 'No AI result for this profile'
          };
        }

        const bestPersona = personas.find(p => p.personaId === result.bestPersonaId) || personas[0];

        return {
          profile,
          bestPersona,
          bestScore: Math.max(0, Math.min(100, result.score || 0)),
          reason: result.reason || 'No reason provided'
        };
      });

    } catch (error) {
      this.log('error', 'Batch AI scoring failed', {
        error: error.message,
        stack: error.stack,
        profilesCount: profiles.length
      });

      // Fallback: return 0 scores for all
      return profiles.map(profile => ({
        profile,
        bestPersona: personas[0],
        bestScore: 0,
        reason: `Scoring error: ${error.message}`
      }));
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
   * Format follow report for user (platform-agnostic)
   */
  formatFollowReport({ personas, matches, followResults, dryRun, matchThreshold }) {
    let report = `📊 **Bluesky Persona-Based Profile ${dryRun ? 'Search' : 'Follow'} Report**\n`;
    report += `**Strategy:** Hybrid (Suggested Follows + Search)\n\n`;

    report += `**Personas Targeted:** ${personas.map(p => p.name).join(', ')}\n`;
    report += `**Match Threshold:** ${matchThreshold}/100\n`;
    report += `**Profiles Found:** ${matches.length}\n`;

    // Count matches by source
    const fromSuggested = matches.filter(m => m.source === 'suggested').length;
    const fromSearch = matches.filter(m => m.source === 'search').length;
    report += `**Sources:** ${fromSuggested} from suggested, ${fromSearch} from search\n\n`;

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

      const sourceEmoji = match.source === 'suggested' ? '🤖' : '🔍';
      report += `**${i + 1}. @${match.profile.handle}** (Score: ${match.matchScore}/100) ${sourceEmoji}\n`;
      report += `   - Name: ${match.profile.displayName || 'Not set'}\n`;
      report += `   - Bio: ${match.profile.description || 'No bio'}\n`;
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
      report += `\n**Source Legend:** 🤖 = Suggested follows, 🔍 = Search results\n`;
    }

    return report;
  }

  /**
   * Generate report of followed profiles (Google Chat Markdown format)
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
