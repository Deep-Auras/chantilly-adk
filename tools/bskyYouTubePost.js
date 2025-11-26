/**
 * Bluesky YouTube Post Generator Tool
 *
 * Analyzes YouTube videos using Gemini 2.5 Pro's video understanding
 * capabilities and generates engaging Bluesky posts tailored to
 * marketing personas.
 *
 * Features:
 * - Direct YouTube URL analysis (no download needed)
 * - Visual + audio content extraction
 * - Persona-tailored post generation
 * - Automatic fact enrichment
 * - Post preview and immediate posting
 *
 * @module tools/bskyYouTubePost
 */

const BaseTool = require('../lib/baseTool');
const { getBskyService } = require('../services/bskyService');
const { getVertexAIClient, extractGeminiText } = require('../config/gemini');

class BskyYouTubePost extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'BskyYouTubePost';
    this.description = 'POST to Bluesky from YouTube videos when user EXPLICITLY requests creating/posting Bluesky content from a YouTube URL. Recognizes requests like: "create a Bluesky post from this YouTube video", "post this YouTube video to Bluesky", "watch this YouTube video and create a Bluesky post", "share YouTube video on Bluesky". Supports persona-based targeting (e.g., "create post for Retail Rita persona"). This tool IMMEDIATELY POSTS to Bluesky (does NOT generate drafts). Analyzes video with Gemini 2.5 Pro (visual + audio), loads persona information from knowledge base if requested, extracts key insights, and publishes engaging posts. Supports youtube.com and youtu.be URLs. Use ONLY when user provides YouTube URL AND wants to PUBLISH to Bluesky. DO NOT use for: general video summaries, web searches about personas, or conversational questions.';
    this.priority = 60; // Higher than WebSearch (50) to win on YouTube+Bluesky requests
    this.timeout = 15 * 60 * 1000; // 15 minutes (video analysis can be slow)

    this.parameters = {
      type: 'object',
      properties: {
        youtubeUrl: {
          type: 'string',
          description: 'YouTube video URL (youtube.com/watch?v=ID or youtu.be/ID)'
        },
        personaIds: {
          type: 'array',
          items: {
            type: 'string'
          },
          description: 'Target persona IDs for tailoring post tone/content (optional)'
        },
        maxLength: {
          type: 'number',
          description: 'Maximum post character length (default: 300, Bluesky limit)'
        },
        includeFact: {
          type: 'boolean',
          description: 'Add an interesting extra fact related to video topic (default: true)'
        },
        tone: {
          type: 'string',
          enum: ['professional', 'casual', 'engaging'],
          description: 'Post tone (default: engaging)'
        }
      },
      required: ['youtubeUrl']
    };
  }

  // SEMANTIC TRIGGER (CRITICAL - See CLAUDE.md)
  // DO NOT use keyword matching - let Gemini's function calling handle triggering
  async shouldTrigger() {
    return false; // Let Gemini handle all triggering via description
  }

  async execute(args, toolContext = {}) {
    const {
      youtubeUrl,
      personaIds = null,
      maxLength = 300,
      includeFact = true,
      tone = 'engaging'
    } = args;

    try {
      // Validate YouTube URL
      const videoId = this.extractVideoId(youtubeUrl);
      if (!videoId) {
        return '❌ Invalid YouTube URL. Use format: https://www.youtube.com/watch?v=VIDEO_ID or https://youtu.be/VIDEO_ID';
      }

      this.log('info', 'Processing YouTube video', { videoId });

      // Initialize services
      const bsky = getBskyService();

      const bskyInitialized = await bsky.initialize();
      if (!bskyInitialized) {
        return '❌ Bluesky integration not available. Check ENABLE_BLUESKY_INTEGRATION setting.';
      }

      // Step 1: Analyze video with Gemini 2.5 Pro
      this.log('info', 'Analyzing video content with Gemini 2.5 Pro');

      const videoAnalysis = await this.analyzeVideo(youtubeUrl);

      if (!videoAnalysis.success) {
        return `❌ Video analysis failed: ${videoAnalysis.error}`;
      }

      this.log('info', 'Video analysis complete', {
        topicExtracted: !!videoAnalysis.topic
      });

      // Step 2: Load target personas
      const personas = await this.loadPersonas(personaIds, toolContext);

      if (personas.length === 0) {
        this.log('warn', 'No personas found, using generic tone');
      }

      // Step 3: Generate persona-tailored post
      this.log('info', 'Generating Bluesky post', { tone, maxLength });

      const postText = await this.generatePost({
        videoAnalysis,
        personas,
        tone,
        maxLength,
        includeFact
      });

      if (!postText) {
        return '❌ Failed to generate post text';
      }

      // Step 4: Use embed card instead of URL in text (more space for content)
      // With rich embed, we don't need to include URL in text - it's shown in the preview card
      const finalPost = postText;

      // CRITICAL: Validate total length does not exceed Bluesky's 300 character limit
      if (finalPost.length > 300) {
        this.log('warn', 'Post text exceeds 300 chars, truncating', {
          originalLength: finalPost.length
        });

        // Truncate at sentence boundary
        const truncatedText = this.truncateAtSentence(postText, 300);

        this.log('info', 'Post truncated to fit limit', {
          newLength: truncatedText.length
        });

        return `❌ Generated post exceeds Bluesky's 300 character limit (${finalPost.length} chars). Please try with shorter content or disable includeFact.`;
      }

      this.log('info', 'Post generated with rich embed', {
        textLength: finalPost.length,
        withinLimit: finalPost.length <= 300,
        willHaveEmbed: true
      });

      // Step 5: Post to Bluesky with rich embed (ALWAYS - no draft mode)
      return await this.postToBsky({
        text: finalPost,
        videoId,
        personaIds,
        videoAnalysis,
        bsky
      });
    } catch (error) {
      this.log('error', 'BskyYouTubePost execution failed', { error: error.message });
      return `❌ Error: ${error.message}`;
    }
  }

  /**
   * Extract video ID from YouTube URL
   */
  extractVideoId(url) {
    // Validate URL format (SSRF protection)
    try {
      const urlObj = new URL(url);

      // Only allow YouTube domains
      const allowedHosts = ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'];
      if (!allowedHosts.includes(urlObj.hostname)) {
        this.log('warn', 'Invalid YouTube domain', { hostname: urlObj.hostname });
        return null;
      }

      // Extract video ID
      if (urlObj.hostname === 'youtu.be') {
        // https://youtu.be/VIDEO_ID
        return urlObj.pathname.substring(1);
      } else {
        // https://www.youtube.com/watch?v=VIDEO_ID
        const videoId = urlObj.searchParams.get('v');
        return videoId;
      }
    } catch (error) {
      this.log('warn', 'URL parsing failed', { url, error: error.message });
      return null;
    }
  }

  /**
   * Analyze YouTube video with Gemini 2.5 Pro via Vertex AI
   * CRITICAL: Requires Vertex AI client for YouTube URL support
   */
  async analyzeVideo(youtubeUrl) {
    const analysisPrompt = `Analyze this YouTube video and provide:

1. **Main Topic** (1 sentence): What is the video primarily about?
2. **Key Insights** (3 bullet points): Most important takeaways or learnings
3. **Target Audience**: Who would benefit most from this video?
4. **Surprising Fact** (1 sentence): One interesting or little-known fact related to the video's topic (can be from video or your knowledge)
5. **Emotional Tone**: Is the video informative, inspirational, urgent, entertaining, etc.?

Keep analysis concise and actionable for social media content creation.

Format response as JSON:
{
  "topic": "main topic in one sentence",
  "insights": ["insight 1", "insight 2", "insight 3"],
  "targetAudience": "description of target audience",
  "surprisingFact": "interesting fact",
  "emotionalTone": "tone descriptor"
}`;

    try {
      // CRITICAL: Use Vertex AI client (NOT regular Gemini client) for YouTube URL support
      const vertexAI = getVertexAIClient();

      const response = await vertexAI.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [
          {
            fileData: {
              fileUri: youtubeUrl,
              mimeType: 'video/mp4'  // Required for Vertex AI (per official docs)
            }
          },
          analysisPrompt
        ]
      });

      // Use centralized response extraction
      const responseText = extractGeminiText(response);

      if (!responseText) {
        throw new Error('Empty response from Gemini');
      }

      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const analysis = JSON.parse(jsonMatch[0]);

      return {
        success: true,
        topic: analysis.topic || 'Unknown topic',
        insights: analysis.insights || [],
        targetAudience: analysis.targetAudience || 'General audience',
        surprisingFact: analysis.surprisingFact || null,
        emotionalTone: analysis.emotionalTone || 'informative'
      };
    } catch (error) {
      this.log('error', 'Video analysis failed', { error: error.message });

      // Provide helpful error messages
      if (error.message.includes('video too long')) {
        return {
          success: false,
          error: 'Video exceeds 2 hour limit. Use shorter video or request low resolution processing.'
        };
      }

      if (error.message.includes('quota') || error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('429')) {
        return {
          success: false,
          error: 'Gemini API quota exceeded. Try again in 1 hour.'
        };
      }

      if (error.message.includes('unavailable')) {
        return {
          success: false,
          error: 'YouTube video unavailable (private, deleted, or region-locked).'
        };
      }

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate persona-tailored Bluesky post
   */
  async generatePost({ videoAnalysis, personas, tone, maxLength, includeFact }) {
    let personaContext = '';

    if (personas.length > 0) {
      personaContext = `
**Target Personas:**
${personas.map(p => `
- ${p.name}: ${p.industry || 'N/A'}
  Interests: ${p.interests ? p.interests.join(', ') : 'N/A'}
  Pain Points: ${p.painPoints ? p.painPoints.join(', ') : 'N/A'}
  Preferred Tone: ${p.preferredTone || tone}
`).join('\n')}
`;
    }

    const postPrompt = `Create an engaging Bluesky post about this YouTube video.

**Video Analysis:**
- Topic: ${videoAnalysis.topic}
- Key Insights: ${videoAnalysis.insights.join('; ')}
- Target Audience: ${videoAnalysis.targetAudience}
- Emotional Tone: ${videoAnalysis.emotionalTone}
${includeFact && videoAnalysis.surprisingFact ? `- Surprising Fact: ${videoAnalysis.surprisingFact}` : ''}

${personaContext}

**CRITICAL Requirements:**
1. Maximum ${maxLength} characters (STRICT LIMIT - Bluesky limit is 300, YouTube link will show in rich preview card below text)
2. Start with attention-grabbing hook relevant to ${personas.length > 0 ? 'persona interests' : 'video topic'}
3. Include 1-2 key insights from the video
${includeFact ? '4. Add the surprising fact if it fits naturally' : ''}
5. End with engagement prompt (question or call-to-action)
6. Use ${tone} tone${personas.length > 0 ? ` appropriate for ${personas.map(p => p.name).join(' and ')}` : ''}
7. Include 2-3 relevant hashtags (max)
8. Make it conversational and authentic, not salesy
9. Create urgency or curiosity to drive video views

DO NOT include the YouTube link in text - it will appear as a rich preview card with thumbnail below the post.

IMPORTANT: Stay UNDER ${maxLength} characters. Use the full character allowance for engaging content.

Format: Plain text only, no markdown. Natural line breaks for readability.`;

    try {
      // Use Vertex AI client directly for simple content generation
      const vertexAI = getVertexAIClient();

      const response = await vertexAI.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: postPrompt }] }],
        generationConfig: {
          temperature: 0.7, // Higher creativity for engaging content
          maxOutputTokens: 300
        }
      });

      // Use centralized response extraction
      const responseText = extractGeminiText(response);

      if (!responseText) {
        this.log('error', 'Empty response from Gemini post generation');
        return null;
      }

      // Clean up response
      let postText = responseText.trim();

      // Remove any markdown formatting
      postText = postText.replace(/\*\*/g, '');
      postText = postText.replace(/\*/g, '');

      // Ensure within character limit (no URL in text - it's in embed card)
      if (postText.length > maxLength) {
        postText = this.truncateAtSentence(postText, maxLength);
      }

      this.log('info', 'Post text generated successfully', { length: postText.length });
      return postText;
    } catch (error) {
      this.log('error', 'Post generation failed', {
        error: error.message,
        stack: error.stack,
        prompt: postPrompt.substring(0, 200) + '...'
      });
      return null;
    }
  }

  /**
   * Truncate text at sentence boundary
   */
  truncateAtSentence(text, maxLength) {
    if (text.length <= maxLength) {
      return text;
    }

    // Find last sentence-ending punctuation before limit
    const truncated = text.substring(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastQuestion = truncated.lastIndexOf('?');
    const lastExclamation = truncated.lastIndexOf('!');

    const lastSentenceEnd = Math.max(lastPeriod, lastQuestion, lastExclamation);

    if (lastSentenceEnd > maxLength * 0.7) {
      // Good truncation point found
      return truncated.substring(0, lastSentenceEnd + 1).trim();
    }

    // No good sentence boundary, truncate at word
    const lastSpace = truncated.lastIndexOf(' ');
    return truncated.substring(0, lastSpace).trim() + '...';
  }

  /**
   * Load personas from knowledge base
   */
  async loadPersonas(personaIds, toolContext) {
    if (!personaIds || personaIds.length === 0) {
      return [];
    }

    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const knowledgeBase = toolContext.knowledgeBase || getKnowledgeBase();

    try {
      const results = await knowledgeBase.searchKnowledge('marketing persona customer', {
        maxResults: 20,
        minRelevance: 0.3
      });

      const personas = [];

      for (const doc of results) {
        const extracted = this.extractPersonasFromDocument(doc.content);
        personas.push(...extracted);
      }

      // Filter by personaIds
      return personas.filter(p => personaIds.includes(p.personaId));
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
   * Get YouTube video metadata using oEmbed API
   * @param {string} videoId - YouTube video ID
   * @returns {Promise<Object>} Video metadata (title, author, thumbnail)
   */
  async getYouTubeMetadata(videoId) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;

      const response = await fetch(oembedUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Chantilly-ADK/1.0'
        }
      });

      if (!response.ok) {
        throw new Error(`YouTube oEmbed API returned ${response.status}`);
      }

      const data = await response.json();

      return {
        title: data.title || 'YouTube Video',
        author: data.author_name || 'YouTube',
        thumbnailUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    } catch (error) {
      this.log('warn', 'Failed to fetch YouTube metadata, using defaults', { error: error.message });

      // Fallback to default thumbnail URL
      return {
        title: 'YouTube Video',
        author: 'YouTube',
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      };
    }
  }

  /**
   * Post to Bluesky with rich embed preview
   */
  async postToBsky({ text, videoId, personaIds, videoAnalysis, bsky }) {
    try {
      this.log('info', 'Posting to Bluesky with rich embed', { textLength: text.length });

      // Get YouTube metadata for rich embed
      const metadata = await this.getYouTubeMetadata(videoId);
      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

      // Create rich embed with thumbnail and metadata
      const embed = await bsky.createExternalEmbed(youtubeUrl, {
        title: metadata.title,
        description: videoAnalysis.topic || 'Watch this video on YouTube',
        thumbnailUrl: metadata.thumbnailUrl
      });

      const result = await bsky.createPost(text, {
        embed: embed, // Rich preview card with YouTube thumbnail and metadata
        youtubeVideoId: videoId,
        targetPersonas: personaIds || []
      });

      this.log('info', 'Post created successfully', { uri: result.uri });

      return `✅ **Posted to Bluesky with Rich Preview!**

📱 **Post Content:**
${text}

🎬 **YouTube Video:**
- Title: ${metadata.title}
- ${youtubeUrl}

🔗 **View Post:** ${result.url}

📊 **Video Analysis:**
- Topic: ${videoAnalysis.topic}
- Insights: ${videoAnalysis.insights.join('; ')}
${videoAnalysis.surprisingFact ? `- Fun Fact Used: ${videoAnalysis.surprisingFact}` : ''}

💡 **The post includes a clickable preview card with thumbnail!**
Track engagement at: ${result.url}`;
    } catch (error) {
      this.log('error', 'Failed to post to Bluesky', { error: error.message });
      return `❌ Failed to post: ${error.message}\n\n**Draft Post:**\n${text}`;
    }
  }

  /**
   * Format draft preview for user review
   */
  formatDraftPreview({ text, videoAnalysis, personas, youtubeUrl }) {
    let preview = `📝 **Bluesky Post Draft Ready**\n\n`;

    preview += `**Post Content:**\n${text}\n\n`;

    preview += `**Character Count:** ${text.length}/300\n\n`;

    preview += `📊 **Video Analysis:**\n`;
    preview += `- Topic: ${videoAnalysis.topic}\n`;
    preview += `- Key Insights: ${videoAnalysis.insights.join('; ')}\n`;
    preview += `- Emotional Tone: ${videoAnalysis.emotionalTone}\n`;
    if (videoAnalysis.surprisingFact) {
      preview += `- Surprising Fact: ${videoAnalysis.surprisingFact}\n`;
    }
    preview += `\n`;

    if (personas.length > 0) {
      preview += `🎯 **Targeted Personas:** ${personas.map(p => p.name).join(', ')}\n\n`;
    }

    preview += `**Video:** ${youtubeUrl}\n\n`;

    preview += `💡 **Next Steps:**\n`;
    preview += `- Review post content above\n`;
    preview += `- To post immediately, run again with postImmediately=true\n`;
    preview += `- To regenerate with different tone, specify tone parameter\n`;

    return preview;
  }
}

module.exports = BskyYouTubePost;
