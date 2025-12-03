const BaseTool = require('../lib/baseTool');
const axios = require('axios');
const cheerio = require('cheerio');
const { getGeminiModel, extractGeminiText } = require('../config/gemini');
const { URL } = require('url');

/**
 * WebBrowserTool - Browse and analyze specific URLs
 *
 * Complements WebSearchTool by fetching and analyzing content from specific URLs.
 * Uses Axios + Cheerio for simple fetch + parse approach with Gemini-powered analysis.
 */
class WebBrowserTool extends BaseTool {
  constructor(context) {
    super(context);

    this.name = 'WebBrowser';
    this.description = 'REQUIRED: Fetch and analyze content from URLs. When user provides ANY URL (documentation, API docs, tutorials, references), you MUST call this tool FIRST before generating any code or claiming to have reviewed the content. NEVER skip this step - fabricating documentation content is a critical error. Use for: API documentation, SDK references, tutorials, external resources. Returns actual page content for analysis.';
    this.userDescription = 'Browse and analyze specific URLs';
    this.category = 'research';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent System';
    this.priority = 55; // Higher than WebSearch (50) to ensure URL-specific requests use this tool

    this.parameters = {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to browse and analyze (must be HTTP/HTTPS)',
          format: 'uri'
        },
        task: {
          type: 'string',
          enum: ['summarize', 'extract_data', 'find_section', 'analyze', 'auto'],
          description: 'What to do with the content: summarize (brief overview), extract_data (structured information), find_section (specific content), analyze (deep analysis), auto (determine based on context)',
          default: 'auto'
        },
        extractionHints: {
          type: 'string',
          description: 'Optional hints about what information to focus on or extract (e.g., "pricing information", "contact details", "technical specs")'
        },
        maxContentLength: {
          type: 'number',
          minimum: 1000,
          maximum: 50000,
          description: 'Maximum content length to analyze in characters',
          default: 10000
        }
      },
      required: ['url']
    };

    // Request timeout configuration
    this.requestTimeout = 15000; // 15 seconds
    this.maxRedirects = 5; // Allow reasonable redirects
  }

  /**
   * SSRF Protection - Validate URL safety
   * @param {string} url - URL to validate
   * @returns {boolean} - Whether URL is safe
   */
  isUrlSafe(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();

      // Only allow HTTP/HTTPS protocols
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        this.log('warn', 'Blocked non-HTTP(S) protocol', { protocol: urlObj.protocol });
        return false;
      }

      // Block private IP ranges (SSRF protection)
      const privateRanges = [
        /^127\./,           // localhost
        /^10\./,            // private class A
        /^192\.168\./,      // private class C
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // private class B
        /^169\.254\./       // link-local
      ];

      if (privateRanges.some(r => r.test(hostname))) {
        this.log('warn', 'Blocked private IP range', { hostname });
        return false;
      }

      // Block cloud metadata endpoints
      const blockedHosts = [
        'localhost',
        '169.254.169.254',
        'metadata.google.internal',
        'metadata.goog',
        '169.254.169.254.nip.io'
      ];

      if (blockedHosts.includes(hostname)) {
        this.log('warn', 'Blocked metadata endpoint', { hostname });
        return false;
      }

      return true;
    } catch (error) {
      this.log('error', 'Invalid URL format', { url, error: error.message });
      return false;
    }
  }

  /**
   * Determine if tool should trigger
   * @param {string} message - User message
   * @param {Object} toolContext - Tool context
   * @returns {boolean} - Whether to trigger
   */
  shouldTrigger(message, toolContext = {}) {
    if (!message || typeof message !== 'string') return false;

    const lowerMessage = message.toLowerCase();

    // Trigger patterns for web browsing
    const browserTriggers = [
      // Direct URL mentions
      /https?:\/\/[^\s]+/i,

      // Explicit browse requests
      /browse\s+(this\s+)?url/i,
      /visit\s+(this\s+)?website/i,
      /open\s+(this\s+)?link/i,
      /fetch\s+(from\s+)?url/i,
      /get\s+content\s+from/i,

      // Content extraction requests
      /extract\s+from\s+url/i,
      /analyze\s+(this\s+)?website/i,
      /read\s+(this\s+)?page/i,
      /summarize\s+(this\s+)?url/i,
      /what('s|\s+is)\s+on\s+(this\s+)?page/i,

      // Specific section requests
      /find\s+on\s+(this\s+)?website/i,
      /look\s+for\s+on\s+(the\s+)?page/i,
      /check\s+(the\s+)?website\s+for/i
    ];

    const isTriggered = browserTriggers.some(trigger => trigger.test(message));

    this.log('debug', 'WebBrowser trigger evaluation', {
      message: message.substring(0, 100),
      isTriggered
    });

    return isTriggered;
  }

  /**
   * Execute web browsing task
   * @param {Object} args - Tool arguments
   * @param {Object} toolContext - Tool context
   * @returns {string} - Formatted result
   */
  async execute(args, toolContext = {}) {
    try {
      const {
        url,
        task = 'auto',
        extractionHints,
        maxContentLength = 10000
      } = args;

      // Validate URL
      if (!url) {
        return '❌ No URL provided. Please specify a website URL to browse.';
      }

      // SSRF protection
      if (!this.isUrlSafe(url)) {
        return '❌ **Security Error**: This URL cannot be accessed for safety reasons.\n\n' +
               '*Private IP addresses, localhost, and metadata endpoints are blocked to prevent security vulnerabilities.*';
      }

      this.log('info', 'Starting web browse request', {
        url,
        task,
        hasExtractionHints: !!extractionHints,
        maxContentLength
      });

      // Fetch webpage content
      const content = await this.fetchWebpage(url);

      if (!content || content.length < 50) {
        return '❌ Unable to retrieve meaningful content from this URL. The page may be empty, require JavaScript, or block automated access.';
      }

      // Limit content length
      const truncatedContent = content.substring(0, maxContentLength);
      const wasTruncated = content.length > maxContentLength;

      this.log('info', 'Content retrieved', {
        originalLength: content.length,
        truncatedLength: truncatedContent.length,
        wasTruncated
      });

      // Analyze content with Gemini
      const analysis = await this.analyzeContent(
        truncatedContent,
        url,
        task,
        extractionHints
      );

      // Format response
      let response = `🌐 **Website Analysis: ${this.extractDomain(url)}**\n\n`;
      response += analysis;

      if (wasTruncated) {
        response += `\n\n*Note: Content was truncated to ${maxContentLength} characters for analysis. Visit the URL directly for complete information.*`;
      }

      response += `\n\n*Source: ${url}*`;

      this.log('info', 'Web browse completed successfully', {
        url,
        task,
        analysisLength: analysis.length
      });

      return response;

    } catch (error) {
      this.log('error', 'Web browse failed', {
        url: args.url,
        error: error.message,
        stack: error.stack
      });

      if (error.message.includes('timeout')) {
        return '❌ **Request Timeout**: The website took too long to respond. Please try again or use a different URL.';
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
        return '❌ **Connection Error**: Unable to reach this website. Please check the URL and try again.';
      } else if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        return '❌ **Security Error**: This website has an invalid SSL certificate.';
      } else {
        return `❌ **Error**: Failed to browse website: ${error.message}`;
      }
    }
  }

  /**
   * Fetch webpage content
   * @param {string} url - URL to fetch
   * @returns {string} - Extracted text content
   */
  async fetchWebpage(url) {
    try {
      const response = await axios.get(url, {
        timeout: this.requestTimeout,
        maxRedirects: this.maxRedirects,
        headers: {
          // Use a realistic browser User-Agent to avoid bot detection
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'max-age=0',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        },
        validateStatus: (status) => status >= 200 && status < 400 // Accept success and redirect codes
      });

      // SECURITY: After following redirects, validate final URL
      const finalUrl = response.request?.res?.responseUrl || url;
      if (!this.isUrlSafe(finalUrl)) {
        this.log('warn', 'Final URL after redirects is unsafe', {
          originalUrl: url,
          finalUrl: finalUrl
        });
        throw new Error('Final URL after redirects failed security validation');
      }

      const html = response.data;

      // Parse HTML with Cheerio
      const $ = cheerio.load(html);

      // Remove unwanted elements
      $('script, style, nav, header, footer, iframe, noscript, svg').remove();
      $('.ad, .advertisement, .sidebar, .cookie-banner, #cookie-banner').remove();

      // Extract main content
      let content = '';

      // Try to find main content area
      const mainSelectors = [
        'main',
        'article',
        '[role="main"]',
        '.main-content',
        '#main-content',
        '.content',
        '#content'
      ];

      let mainContent = null;
      for (const selector of mainSelectors) {
        mainContent = $(selector).first();
        if (mainContent.length > 0) {
          break;
        }
      }

      // Extract text from main content or body
      if (mainContent && mainContent.length > 0) {
        content = mainContent.text();
      } else {
        content = $('body').text();
      }

      // Extract e-commerce metadata (prices, availability, etc.) from HTML attributes
      // Many sites store this in meta tags, JSON-LD, or data attributes
      const ecommerceData = [];

      // Look for JSON-LD structured data (common for product pages)
      $('script[type="application/ld+json"]').each((_i, elem) => {
        try {
          const jsonData = JSON.parse($(elem).html());
          if (jsonData) {
            ecommerceData.push(`Structured Data: ${JSON.stringify(jsonData, null, 2)}`);
          }
        } catch (e) {
          // Ignore invalid JSON
        }
      });

      // Look for Open Graph and meta tags
      const metaTags = [];
      $('meta[property^="og:"], meta[property^="product:"], meta[name^="twitter:"]').each((_i, elem) => {
        const property = $(elem).attr('property') || $(elem).attr('name');
        const content = $(elem).attr('content');
        if (property && content) {
          metaTags.push(`${property}: ${content}`);
        }
      });
      if (metaTags.length > 0) {
        ecommerceData.push(`Meta Tags:\n${metaTags.join('\n')}`);
      }

      // Look for common price elements (even if hidden/dynamic)
      const priceSelectors = [
        '.price', '#price', '[data-price]', '[itemprop="price"]',
        '.product-price', '.sale-price', '.regular-price',
        '.price-current', '[class*="price"]', '[id*="price"]'
      ];

      priceSelectors.forEach(selector => {
        $(selector).each((_i, elem) => {
          const text = $(elem).text().trim();
          const dataPrice = $(elem).attr('data-price');
          const content = $(elem).attr('content');
          if (text && text.length < 50) {
            ecommerceData.push(`Price Element: ${text}`);
          }
          if (dataPrice) {
            ecommerceData.push(`Price Data Attribute: ${dataPrice}`);
          }
          if (content) {
            ecommerceData.push(`Price Content: ${content}`);
          }
        });
      });

      // Append e-commerce data if found
      if (ecommerceData.length > 0) {
        content += '\n\n--- E-commerce Metadata ---\n' + ecommerceData.join('\n');
      }

      // Clean up whitespace
      content = content
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();

      this.log('debug', 'Content extracted', {
        url,
        contentLength: content.length,
        statusCode: response.status
      });

      return content;

    } catch (error) {
      this.log('error', 'Failed to fetch webpage', {
        url,
        error: error.message,
        code: error.code
      });
      throw error;
    }
  }

  /**
   * Analyze content with Gemini
   * @param {string} content - Content to analyze
   * @param {string} url - Source URL
   * @param {string} task - Analysis task
   * @param {string} extractionHints - Optional hints
   * @returns {string} - Analysis result
   */
  async analyzeContent(content, url, task, extractionHints) {
    try {
      const model = getGeminiModel();

      // Build prompt based on task
      let prompt = this.buildAnalysisPrompt(content, url, task, extractionHints);

      this.log('info', 'Analyzing content with Gemini', {
        task,
        promptLength: prompt.length,
        hasHints: !!extractionHints
      });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.2 // Lower temperature for factual analysis
        }
      });

      const analysis = extractGeminiText(result) || 'Unable to analyze content';

      this.log('info', 'Content analysis completed', {
        task,
        analysisLength: analysis.length,
        tokensUsed: result.usageMetadata?.totalTokenCount
      });

      return analysis;

    } catch (error) {
      this.log('error', 'Content analysis failed', {
        task,
        error: error.message
      });
      throw new Error(`Failed to analyze content: ${error.message}`);
    }
  }

  /**
   * Build analysis prompt based on task type
   * @param {string} content - Content to analyze
   * @param {string} url - Source URL
   * @param {string} task - Task type
   * @param {string} extractionHints - Optional hints
   * @returns {string} - Prompt for Gemini
   */
  buildAnalysisPrompt(content, url, task, extractionHints) {
    const baseContext = `Analyze the following content from ${url}:\n\n${content}\n\n`;

    const taskPrompts = {
      summarize: `Provide a concise summary of this webpage's content. Include:
- Main topic and purpose
- Key information and takeaways
- Important details or data points
- Conclusions or recommendations (if any)

Keep it brief but comprehensive.`,

      extract_data: `Extract structured information from this content. Focus on:
- Facts and data points
- Names, dates, numbers, statistics
- Important entities (companies, people, products)
- Key terminology or definitions
${extractionHints ? `\nPay special attention to: ${extractionHints}` : ''}

Present the information in a clear, organized format.`,

      find_section: `Find and extract relevant information based on the user's needs.
${extractionHints ? `\nSpecifically look for: ${extractionHints}` : ''}

Provide the most relevant sections with context about where they appear on the page.`,

      analyze: `Provide a comprehensive analysis of this content. Include:
- Main themes and topics
- Key arguments or points made
- Quality and credibility of information
- Important insights or implications
- Potential biases or limitations
${extractionHints ? `\nFocus analysis on: ${extractionHints}` : ''}

Be thorough and analytical.`,

      auto: `Analyze this content and provide the most useful information based on what it contains. This could be:
- A summary if it's an article or documentation
- Extracted data if it contains facts and statistics
- Analysis if it presents arguments or opinions
- Key sections if it's reference material
${extractionHints ? `\nUser is interested in: ${extractionHints}` : ''}

Choose the approach that provides the most value.`
    };

    return baseContext + (taskPrompts[task] || taskPrompts.auto);
  }

  /**
   * Extract domain from URL for display
   * @param {string} url - URL to process
   * @returns {string} - Domain name
   */
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, '');
    } catch {
      return 'Website';
    }
  }

  /**
   * Get tool metadata
   * @returns {Object} - Tool metadata
   */
  getMetadata() {
    return {
      ...super.getMetadata(),
      supportedTasks: ['summarize', 'extract_data', 'find_section', 'analyze', 'auto'],
      securityFeatures: ['SSRF_protection', 'timeout_handling', 'safe_parsing'],
      maxContentLength: 50000,
      requestTimeout: this.requestTimeout
    };
  }
}

module.exports = WebBrowserTool;
