const BaseTool = require('../lib/baseTool');
const axios = require('axios');
const cheerio = require('cheerio');
const { logger } = require('../utils/logger');

class WebSearchTool extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'WebSearch';
    this.description = 'Search the web using DuckDuckGo to find factual information, current events, latest news, prices, statistics, or technical documentation ONLY when user explicitly requests information lookup. DO NOT use for greetings, casual conversation, opinions, or questions that can be answered from personality/identity. Use when user asks: "what is", "current price", "latest news about", "how to", "search for", or explicitly mentions needing current/recent information.';
    this.category = 'information';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent';
    this.priority = 40; // Lower priority - let specialized tools win

    this.parameters = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find current, factual information'
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of websites to fetch and analyze (1-10)',
          minimum: 1,
          maximum: 10,
          default: 5
        },
        focusArea: {
          type: 'string',
          description: 'Specific aspect to focus on (news, technical, general, financial, etc.)',
          enum: ['news', 'technical', 'general', 'financial', 'academic', 'recent'],
          default: 'general'
        }
      },
      required: ['query']
    };

    // DuckDuckGo search configuration
    this.searchBaseUrl = 'https://html.duckduckgo.com/html/';
    this.userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];
    this.maxContentLength = 50000; // Max characters per website (increased from 10k)
    this.maxDownloadSize = 500000; // Max download size (500KB)
    this.requestTimeout = 15000; // 15 seconds timeout per request
  }

  // SEMANTIC TRIGGER (CRITICAL - See CLAUDE.md)
  // DO NOT use keyword matching - let Gemini's function calling handle triggering
  async shouldTrigger() {
    // ❌ REMOVED 60+ lines of keyword lists and context checking
    // ✅ Gemini's function calling uses the semantic description field for intent detection
    // The description clearly states this is for finding current/factual information online
    return false; // Let Gemini handle all triggering via description
  }

  async execute(params, toolContext = {}) {
    try {
      const { query, maxResults = 5, focusArea = 'general' } = params;
      
      this.log('info', 'Starting web search', {
        query,
        maxResults,
        focusArea,
        hasKnowledgeContext: !!toolContext.knowledgeResults
      });

      // Enhance query based on focus area and context
      const enhancedQuery = this.enhanceQuery(query, focusArea, toolContext);
      
      // Step 1: Search DuckDuckGo for results
      const searchResults = await this.searchDuckDuckGo(enhancedQuery, maxResults);
      
      if (searchResults.length === 0) {
        return 'I apologize, but I was unable to find any relevant web results for your query. Please try rephrasing your question or being more specific.';
      }

      // Step 2: Fetch and analyze content from top results
      const analyzedResults = await this.fetchAndAnalyzeResults(searchResults, query);
      
      if (analyzedResults.length === 0) {
        // Fallback: provide search results with snippets when content fetch fails
        return this.generateFallbackResponse(query, searchResults, focusArea);
      }

      // Step 3: Generate comprehensive response
      const response = this.generateResponse(query, analyzedResults, focusArea);

      this.log('info', 'Web search completed successfully', {
        searchResultsFound: searchResults.length,
        sitesAnalyzed: analyzedResults.length,
        responseLength: response.length
      });

      return response;

    } catch (error) {
      this.log('error', 'Web search tool failed', {
        error: error.message,
        stack: error.stack,
        params
      });
      return 'I encountered an error while searching the web. Please try again later or rephrase your query.';
    }
  }

  enhanceQuery(query, focusArea, toolContext) {
    let enhanced = query;

    // Add focus area context
    const focusEnhancements = {
      news: 'latest news',
      technical: 'technical documentation',
      financial: 'current price financial',
      academic: 'research study',
      recent: '2024 2025 latest'
    };

    if (focusEnhancements[focusArea]) {
      enhanced = `${enhanced} ${focusEnhancements[focusArea]}`;
    }

    // Add current year for recency
    if (!enhanced.includes('2024') && !enhanced.includes('2025')) {
      enhanced = `${enhanced} 2024 2025`;
    }

    this.log('info', 'Query enhanced for search', {
      original: query,
      enhanced: enhanced,
      focusArea
    });

    return enhanced;
  }

  getRandomUserAgent() {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async searchDuckDuckGo(query, maxResults) {
    try {
      const searchUrl = this.searchBaseUrl;
      const response = await axios.post(searchUrl, 
        new URLSearchParams({
          q: query,
          b: '', // No specific region
          kl: 'us-en', // US English
          df: '', // No date filter
          safe: 'moderate'
        }), {
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          },
          timeout: this.requestTimeout,
          maxRedirects: 3
        });

      const $ = cheerio.load(response.data);
      const results = [];

      // Parse DuckDuckGo results
      $('.result').each((index, element) => {
        if (results.length >= maxResults) {return false;}

        const titleElement = $(element).find('.result__title a');
        const snippetElement = $(element).find('.result__snippet');
        const urlElement = $(element).find('.result__url');

        const title = titleElement.text().trim();
        const url = titleElement.attr('href');
        const snippet = snippetElement.text().trim();
        const displayUrl = urlElement.text().trim();

        if (title && url && this.isValidUrl(url)) {
          results.push({
            title,
            url: this.cleanUrl(url),
            snippet,
            displayUrl,
            rank: results.length + 1
          });
        }
      });

      this.log('info', 'DuckDuckGo search completed', {
        query,
        resultsFound: results.length,
        requestedMax: maxResults
      });

      return results.slice(0, maxResults);

    } catch (error) {
      this.log('error', 'DuckDuckGo search failed', {
        error: error.message,
        query
      });
      return [];
    }
  }

  async fetchAndAnalyzeResults(searchResults, originalQuery) {
    const analyzedResults = [];
    
    // Process results concurrently but with a limit
    const concurrencyLimit = 3;
    for (let i = 0; i < searchResults.length; i += concurrencyLimit) {
      const batch = searchResults.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(result => this.fetchWebsiteContent(result, originalQuery));
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((promiseResult, index) => {
        if (promiseResult.status === 'fulfilled' && promiseResult.value) {
          analyzedResults.push(promiseResult.value);
        } else {
          this.log('warn', 'Failed to fetch website content', {
            url: batch[index].url,
            error: promiseResult.reason?.message
          });
        }
      });
    }

    // Sort by relevance score
    analyzedResults.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

    return analyzedResults;
  }

  async fetchWebsiteContent(searchResult, originalQuery, retryCount = 0) {
    const maxRetries = 2;

    // SECURITY FIX: Validate URL safety before fetching (SSRF protection)
    if (!this.isUrlSafe(searchResult.url)) {
      this.log('warn', 'URL rejected by SSRF protection', {
        url: searchResult.url,
        reason: 'Private IP or unsafe protocol'
      });
      return null;
    }

    try {
      const response = await axios.get(searchResult.url, {
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: this.requestTimeout,
        maxRedirects: 3, // SECURITY: Allow up to 3 redirects (most sites need this)
        maxContentLength: this.maxDownloadSize,
        validateStatus: function (status) {
          return status >= 200 && status < 400; // Accept success and redirect codes
        }
      });

      // SECURITY: After following redirects, validate final URL
      const finalUrl = response.request?.res?.responseUrl || searchResult.url;
      if (!this.isUrlSafe(finalUrl)) {
        this.log('warn', 'Final URL after redirects is unsafe', {
          originalUrl: searchResult.url,
          finalUrl: finalUrl
        });
        return null;
      }

      const $ = cheerio.load(response.data);

      // Remove unwanted elements
      $('script, style, nav, header, footer, aside, .advertisement, .ads, .social-share').remove();

      // Extract main content
      let content = '';
      const contentSelectors = [
        'article', '[role="main"]', 'main', '.content', '.post-content', 
        '.entry-content', '.article-content', '#content', '.main-content'
      ];

      for (const selector of contentSelectors) {
        const element = $(selector).first();
        if (element.length && element.text().trim().length > 200) {
          content = element.text().trim();
          break;
        }
      }

      // Fallback to body content
      if (!content) {
        content = $('body').text().trim();
      }

      // Clean and truncate content
      content = this.cleanContent(content);
      if (content.length > this.maxContentLength) {
        content = content.substring(0, this.maxContentLength) + '...';
      }

      // Calculate relevance score
      const relevanceScore = this.calculateRelevance(content, originalQuery, searchResult.snippet);

      // Extract publication date if available
      const publishDate = this.extractPublishDate($);

      return {
        ...searchResult,
        content,
        relevanceScore,
        publishDate,
        contentLength: content.length,
        fetchedAt: new Date().toISOString()
      };

    } catch (error) {
      let errorType = 'unknown';
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        errorType = 'connection_failed';
      } else if (error.response && error.response.status === 403) {
        errorType = 'access_forbidden';
      } else if (error.response && error.response.status === 404) {
        errorType = 'not_found';
      } else if (error.code === 'ECONNABORTED') {
        errorType = 'timeout';
      } else if (error.message.includes('maxContentLength')) {
        errorType = 'content_too_large';
      }

      this.log('warn', 'Failed to fetch website', {
        url: searchResult.url,
        error: error.message,
        errorType,
        statusCode: error.response?.status,
        retryCount
      });

      // Retry for certain error types
      if (retryCount < maxRetries && 
          (errorType === 'timeout' || errorType === 'connection_failed')) {
        this.log('info', 'Retrying website fetch', {
          url: searchResult.url,
          attempt: retryCount + 1,
          maxRetries
        });
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return this.fetchWebsiteContent(searchResult, originalQuery, retryCount + 1);
      }

      return null;
    }
  }

  cleanContent(content) {
    return content
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/\n\s*\n/g, '\n') // Remove empty lines
      .replace(/[^\w\s.,!?;:()\-'"]/g, '') // Remove special characters
      .trim();
  }

  calculateRelevance(content, query, snippet) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    const contentLower = (content + ' ' + snippet).toLowerCase();
    
    let score = 0;
    let wordMatches = 0;

    for (const word of queryWords) {
      const regex = new RegExp(word, 'gi');
      const matches = (contentLower.match(regex) || []).length;
      if (matches > 0) {
        wordMatches++;
        score += matches * (word.length > 4 ? 2 : 1); // Longer words get higher weight
      }
    }

    // Normalize score
    const maxPossibleScore = queryWords.length * 10;
    const normalizedScore = Math.min(score / maxPossibleScore, 1);
    
    // Boost score if most query words are found
    const wordMatchRatio = wordMatches / queryWords.length;
    const finalScore = normalizedScore * (0.5 + wordMatchRatio * 0.5);

    return Math.round(finalScore * 100) / 100;
  }

  extractPublishDate($) {
    try {
      // Try various meta tags and selectors for publish date
      const dateSelectors = [
        'meta[property="article:published_time"]',
        'meta[name="publishdate"]',
        'meta[name="date"]',
        'time[datetime]',
        '.publish-date',
        '.date-published',
        '.post-date'
      ];

      for (const selector of dateSelectors) {
        const element = $(selector).first();
        if (element.length) {
          const dateValue = element.attr('content') || element.attr('datetime') || element.text();
          if (dateValue) {
            const parsedDate = new Date(dateValue);
            if (!isNaN(parsedDate.getTime())) {
              return parsedDate.toISOString().split('T')[0]; // Return YYYY-MM-DD format
            }
          }
        }
      }

      // Try JSON-LD structured data
      $('script[type="application/ld+json"]').each((_, script) => {
        try {
          const data = JSON.parse($(script).html());
          if (data.datePublished) {
            const parsedDate = new Date(data.datePublished);
            if (!isNaN(parsedDate.getTime())) {
              return parsedDate.toISOString().split('T')[0];
            }
          }
        } catch (e) {
          // Ignore JSON parsing errors
        }
      });

    } catch (error) {
      // Ignore date extraction errors
    }
    
    return null;
  }

  generateResponse(query, analyzedResults, focusArea) {
    const currentDate = new Date().toISOString().split('T')[0];
    let response = `🔍 **Web Search Results for "${query}"**\n\n`;

    // Group results by recency
    const recentResults = analyzedResults.filter(r => {
      if (!r.publishDate) {return false;}
      const daysDiff = (new Date() - new Date(r.publishDate)) / (1000 * 60 * 60 * 24);
      return daysDiff <= 30; // Last 30 days
    });

    const olderResults = analyzedResults.filter(r => !recentResults.includes(r));

    // Add recent information first
    if (recentResults.length > 0) {
      response += '**📰 Recent Information:**\n';
      recentResults.slice(0, 3).forEach((result, index) => {
        response += `\n**${index + 1}. ${result.title}** (${result.publishDate || 'Recent'})\n`;
        response += `${this.summarizeContent(result.content, query)}\n`;
        response += `*Source: ${result.displayUrl}*\n`;
      });
      response += '\n';
    }

    // Add other relevant information
    if (olderResults.length > 0) {
      response += '**📚 Additional Information:**\n';
      olderResults.slice(0, 2).forEach((result, index) => {
        response += `\n**${index + 1}. ${result.title}**\n`;
        response += `${this.summarizeContent(result.content, query)}\n`;
        response += `*Source: ${result.displayUrl}*\n`;
      });
    }

    // Add summary footer
    response += `\n*Search completed on ${currentDate}. Found ${analyzedResults.length} relevant sources.*`;

    // Add focus area note if applicable
    if (focusArea !== 'general') {
      response += `\n*Search focused on: ${focusArea}*`;
    }

    return response;
  }

  generateFallbackResponse(query, searchResults, focusArea) {
    const currentDate = new Date().toISOString().split('T')[0];
    let response = `🔍 **Web Search Results for "${query}"**\n\n`;
    
    response += `I found ${searchResults.length} relevant sources, but was unable to access the full content due to website restrictions. Here are the search results with available information:\n\n`;

    searchResults.slice(0, 5).forEach((result, index) => {
      response += `**${index + 1}. ${result.title}**\n`;
      if (result.snippet) {
        response += `${result.snippet}\n`;
      }
      response += `*Source: ${result.displayUrl}*\n\n`;
    });

    response += `*Search completed on ${currentDate}. Found ${searchResults.length} relevant sources.*\n`;
    
    if (focusArea !== 'general') {
      response += `*Search focused on: ${focusArea}*\n`;
    }
    
    response += '\n*Note: Some websites could not be accessed due to access restrictions. You may want to visit these links directly for more detailed information.*';

    return response;
  }

  summarizeContent(content, query) {
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
    const queryWords = query.toLowerCase().split(/\s+/);
    
    // Find sentences most relevant to the query
    const scoredSentences = sentences.map(sentence => {
      const sentenceLower = sentence.toLowerCase();
      const score = queryWords.reduce((acc, word) => {
        return acc + (sentenceLower.includes(word) ? 1 : 0);
      }, 0);
      return { sentence: sentence.trim(), score };
    });

    // Sort by relevance and take top sentences
    scoredSentences.sort((a, b) => b.score - a.score);
    const topSentences = scoredSentences.slice(0, 3).map(s => s.sentence);

    let summary = topSentences.join('. ');
    
    // Ensure summary isn't too long
    if (summary.length > 300) {
      summary = summary.substring(0, 297) + '...';
    }

    return summary || content.substring(0, 200) + '...';
  }

  isValidUrl(url) {
    try {
      const urlObj = new URL(url);
      return ['http:', 'https:'].includes(urlObj.protocol);
    } catch {
      return false;
    }
  }

  // SECURITY FIX: SSRF protection - validate URLs before fetching
  isUrlSafe(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;

      // Block private IP ranges (IPv4)
      const privateIPv4Ranges = [
        /^127\./,                    // Loopback
        /^10\./,                     // Private Class A
        /^172\.(1[6-9]|2[0-9]|3[01])\./, // Private Class B
        /^192\.168\./,               // Private Class C
        /^169\.254\./,               // Link-local (AWS metadata)
        /^0\.0\.0\.0$/              // Invalid
      ];

      // Block private IPv6 ranges
      const privateIPv6Ranges = [
        /^::1$/,                     // Loopback
        /^fc00:/,                    // Unique local
        /^fe80:/,                    // Link-local
        /^ff00:/                    // Multicast
      ];

      // Check IPv4
      if (privateIPv4Ranges.some(regex => regex.test(hostname))) {
        this.log('warn', 'Blocked private IPv4 address', { url, hostname });
        return false;
      }

      // Check IPv6
      if (privateIPv6Ranges.some(regex => regex.test(hostname))) {
        this.log('warn', 'Blocked private IPv6 address', { url, hostname });
        return false;
      }

      // Block localhost variants
      const localhostVariants = [
        'localhost',
        '0.0.0.0',
        '[::1]',
        '[::ffff:127.0.0.1]'
      ];

      if (localhostVariants.includes(hostname.toLowerCase())) {
        this.log('warn', 'Blocked localhost variant', { url, hostname });
        return false;
      }

      // Only allow HTTP/HTTPS
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        this.log('warn', 'Blocked non-HTTP protocol', { url, protocol: urlObj.protocol });
        return false;
      }

      // Block cloud metadata endpoints
      const metadataEndpoints = [
        '169.254.169.254',           // AWS/GCP metadata
        'metadata.google.internal',  // GCP metadata domain
        '169.254.169.123'           // Oracle Cloud
      ];

      if (metadataEndpoints.includes(hostname)) {
        this.log('warn', 'Blocked cloud metadata endpoint', { url, hostname });
        return false;
      }

      return true;
    } catch (error) {
      this.log('warn', 'URL parsing failed', { url, error: error.message });
      return false;
    }
  }

  cleanUrl(url) {
    // Remove DuckDuckGo redirect wrapper if present
    if (url.includes('duckduckgo.com/l/?uddg=')) {
      try {
        const urlParams = new URLSearchParams(url.split('?')[1]);
        return decodeURIComponent(urlParams.get('uddg') || url);
      } catch {
        return url;
      }
    }
    return url;
  }
}

module.exports = WebSearchTool;