// Simple queue implementation to replace p-queue
class SimpleQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 1;
    this.interval = options.interval || 500;
    this.intervalCap = options.intervalCap || 1;
    this.maxSize = options.maxSize || 5000; // Default max queue size
    this.queue = [];
    this.running = 0;
    this.processing = false;
    this.droppedCount = 0;
  }

  get size() {
    return this.queue.length;
  }

  get pending() {
    return this.running;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      // Check queue size limit
      if (this.queue.length >= this.maxSize) {
        this.droppedCount++;
        const error = new Error(`Queue at capacity (${this.maxSize}), dropping request`);
        error.code = 'QUEUE_FULL';
        error.queueSize = this.queue.length;
        error.droppedCount = this.droppedCount;
        reject(error);
        return;
      }
      
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && this.running < this.concurrency) {
      const { fn, resolve, reject } = this.queue.shift();
      this.running++;

      setTimeout(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.running--;
          this.process();
        }
      }, this.interval);
    }

    this.processing = false;
  }

  async clear() {
    this.queue = [];
  }
}
const { logger } = require('../utils/logger');
const { getFirestore, getFieldValue } = require('../config/firestore');
const { convertForBitrixChat } = require('../utils/markdownToBB');
const { BitrixAPIValidator } = require('./bitrixAPIValidator');

class SlidingWindow {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.timestamps = [];
  }

  canProceed() {
    const now = Date.now();
    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    return this.timestamps.length < this.maxRequests;
  }

  addRequest() {
    this.timestamps.push(Date.now());
  }

  getRequestsInWindow() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    return this.timestamps.length;
  }
}

class Bitrix24QueueManager {
  constructor() {
    // Rate limits from Bitrix24 specifications (will be loaded from Firestore)
    this.limits = {
      perSecond: 2,
      per10Minutes: 10000,
      cooldownMs: 600000, // 10 minutes
      maxRetries: 3,
      methodLimits: {
        'im.message.add': { perSecond: 1 },
        'crm.deal.list': { perMinute: 250 },
        'crm.deal.update': { perMinute: 50 },
        'crm.invoice.list': { perMinute: 300 },
        'crm.invoice.get': { perMinute: 300 },
        'crm.company.list': { perMinute: 300 },
        'crm.company.get': { perMinute: 300 },
        'crm.contact.list': { perMinute: 300 },
        'crm.contact.get': { perMinute: 300 },
        'crm.activity.list': { perMinute: 200 },
        'crm.activity.get': { perMinute: 200 },
        'user.get': { perMinute: 100 }
      }
    };

    // Initialize queue later with async method
    this.queue = null;
    this.initialized = false;

    // Sliding window for 10-minute limit (will be initialized after config load)
    this.slidingWindow = null;

    // Cooldown tracking
    this.cooldownUntil = null;

    // Statistics
    this.stats = {
      processed: 0,
      failed: 0,
      queued: 0,
      cooldowns: 0
    };

    // Firestore for persistence
    this.db = null;

    // Bitrix24 webhook URL (loaded from Firestore)
    this.webhookUrl = null;

    // Security: API validator for Bitrix24 calls
    this.apiValidator = new BitrixAPIValidator();
  }

  async initialize() {
    if (this.initialized) {return;}

    try {
      // Initialize Firestore
      this.db = getFirestore();

      // Load configuration from Firestore
      const configDoc = await this.db.collection('agent').doc('config').get();
      if (configDoc.exists) {
        const config = configDoc.data();
        this.limits.perSecond = parseInt(config.RATE_LIMIT_PER_SECOND) || 2;
        this.limits.per10Minutes = parseInt(config.RATE_LIMIT_PER_10MIN) || 10000;
        this.limits.maxRetries = parseInt(config.QUEUE_MAX_RETRIES) || 3;
      }

      // Load Bitrix24 platform config
      const platformDoc = await this.db.collection('agent').doc('platforms')
        .collection('bitrix24').doc('config').get();
      if (platformDoc.exists) {
        const platformConfig = platformDoc.data();
        this.webhookUrl = platformConfig.webhookUrl;
      }

      // Initialize sliding window with loaded config
      this.slidingWindow = new SlidingWindow(600000, this.limits.per10Minutes);

      // Initialize SimpleQueue
      this.queue = new SimpleQueue({
        concurrency: this.limits.perSecond,
        interval: 1000,
        intervalCap: this.limits.perSecond
      });

      this.initialized = true;
      logger.info('Bitrix24 Queue manager initialized from Firestore', {
        limits: this.limits,
        hasWebhookUrl: !!this.webhookUrl
      });
    } catch (error) {
      logger.error('Failed to initialize queue manager', { error: error.message });
      throw error;
    }
  }

  isInCooldown() {
    if (!this.cooldownUntil) {return false;}
    if (Date.now() >= this.cooldownUntil) {
      this.cooldownUntil = null;
      logger.info('Cooldown period ended');
      return false;
    }
    return true;
  }

  async enterCooldown() {
    this.cooldownUntil = Date.now() + this.limits.cooldownMs;
    this.stats.cooldowns++;
    logger.warn('Entering cooldown period', {
      until: new Date(this.cooldownUntil).toISOString()
    });

    // Save cooldown state to Firestore
    if (this.db) {
      await this.db.collection('queue').doc('state').set({
        cooldownUntil: this.cooldownUntil,
        timestamp: getFieldValue().serverTimestamp()
      }, { merge: true });
    }
  }

  async add(request) {
    if (!this.initialized || !this.queue) {
      await this.initialize();
    }

    // Validate request
    if (!request.method || !request.params) {
      throw new Error('Invalid request: method and params required');
    }

    // Security: Validate API call against whitelist and safety rules
    const validation = this.apiValidator.validateAPICall(
      request.method,
      request.params,
      { requestId: request.id || 'unknown' }
    );

    if (!validation.valid) {
      const errorMessage = `API validation failed: ${validation.errors.join(', ')}`;
      logger.warn('Bitrix24 API call rejected by validator', {
        method: request.method,
        errors: validation.errors,
        requestId: request.id || 'unknown'
      });
      throw new Error(errorMessage);
    }

    // Use sanitized params from validation
    request.params = validation.sanitized;

    // Convert markdown to BB code for Bitrix24 chat messages
    const processedRequest = await this.preprocessRequest(request);

    // Check if this is a chat message that needs chunking
    const chatMethods = ['im.message.add', 'imbot.message.add', 'im.notify.add', 'imbot.notify.add'];
    const isLongMessage = chatMethods.includes(processedRequest.method) &&
                          processedRequest.params.MESSAGE &&
                          processedRequest.params.MESSAGE.length > 19000;

    if (isLongMessage) {
      // Chunk the message and send multiple requests
      const chunks = this.chunkMessage(processedRequest.params.MESSAGE);
      const results = [];

      logger.info('Sending chunked message', {
        method: processedRequest.method,
        totalChunks: chunks.length,
        dialogId: processedRequest.params.DIALOG_ID
      });

      for (let i = 0; i < chunks.length; i++) {
        const chunkRequest = {
          ...processedRequest,
          params: {
            ...processedRequest.params,
            MESSAGE: chunks[i]
          }
        };

        // Check cooldown before each chunk
        if (this.isInCooldown()) {
          logger.warn('Request rejected due to cooldown', {
            method: chunkRequest.method,
            chunkIndex: i + 1,
            totalChunks: chunks.length,
            cooldownRemaining: this.cooldownUntil - Date.now()
          });
          throw new Error('Rate limit cooldown active');
        }

        // Check 10-minute window before each chunk
        if (!this.slidingWindow.canProceed()) {
          await this.enterCooldown();
          logger.warn('Request rejected due to rate limit', {
            method: chunkRequest.method,
            chunkIndex: i + 1,
            totalChunks: chunks.length
          });
          throw new Error('Rate limit exceeded');
        }

        try {
          const result = await this.queue.add(async () => {
            return this.executeRequest(chunkRequest);
          }, {
            priority: request.priority || 0
          });

          results.push(result);

          logger.info('Chunk sent successfully', {
            chunkIndex: i + 1,
            totalChunks: chunks.length,
            chunkLength: chunks[i].length
          });
        } catch (error) {
          logger.error('Failed to send message chunk', {
            chunkIndex: i + 1,
            totalChunks: chunks.length,
            error: error.message
          });
          throw error;
        }
      }

      // Return the result of the last chunk
      return results[results.length - 1];
    }

    // Normal single-message flow
    // Check if in cooldown
    if (this.isInCooldown()) {
      logger.warn('Request rejected due to cooldown', {
        method: processedRequest.method,
        cooldownRemaining: this.cooldownUntil - Date.now()
      });
      throw new Error('Rate limit cooldown active');
    }

    // Check 10-minute window
    if (!this.slidingWindow.canProceed()) {
      await this.enterCooldown();
      logger.warn('Request rejected due to rate limit', {
        method: processedRequest.method
      });
      throw new Error('Rate limit exceeded');
    }

    // Add to queue with retry logic
    try {
      const result = await this.queue.add(async () => {
        return this.executeRequest(processedRequest);
      }, {
        priority: request.priority || 0
      });

      // Sanitize PII if requested
      if (request.sanitizePII) {
        return this.sanitizeResponse(request.method, result);
      }

      return result;
    } catch (error) {
      if (error.code === 'QUEUE_FULL') {
        logger.warn('Queue at capacity, request dropped', {
          method: processedRequest.method,
          queueSize: error.queueSize,
          droppedCount: error.droppedCount
        });
        return {
          success: false,
          error: 'Queue at capacity - request dropped',
          code: 'QUEUE_FULL',
          dropped: true
        };
      }
      throw error;
    }
  }

  /**
   * Sanitize Bitrix24 API response to remove PII
   * @param {string} method - API method name
   * @param {Object} response - Raw API response
   * @returns {Object} Sanitized response
   */
  sanitizeResponse(method, response) {
    // User methods return PII
    if (method.startsWith('user.')) {
      return this.sanitizeUserResponse(response);
    }

    // CRM contact methods may contain PII
    if (method.includes('contact.')) {
      return this.sanitizeContactResponse(response);
    }

    // IM user methods may contain user info
    if (method.startsWith('im.user.')) {
      return this.sanitizeUserResponse(response);
    }

    // Default: return as-is (no PII expected)
    logger.debug('No PII sanitization needed for method', { method });
    return response;
  }

  /**
   * Sanitize user data by removing PII fields
   * @param {Object} response - Raw user.* API response
   * @returns {Object} Sanitized response with PII removed
   */
  sanitizeUserResponse(response) {
    if (!response || !response.result) {
      return response;
    }

    // Handle both single user object and array of users
    const users = Array.isArray(response.result) ? response.result : [response.result];

    const sanitized = users.map(user => this.sanitizeUser(user));

    logger.debug('Sanitized user response', {
      originalCount: users.length,
      sanitizedCount: sanitized.length
    });

    return {
      ...response,
      result: Array.isArray(response.result) ? sanitized : sanitized[0]
    };
  }

  /**
   * Sanitize individual user object
   * @param {Object} user - Raw user object from Bitrix24
   * @returns {Object} Sanitized user object (safe for Gemini)
   */
  sanitizeUser(user) {
    if (!user) {
      return user;
    }

    return {
      // Safe fields only
      id: user.ID,
      displayName: this.formatDisplayName(user),
      active: user.ACTIVE === true || user.ACTIVE === 'Y',
      workPosition: user.WORK_POSITION || null,

      // REMOVED: EMAIL, PERSONAL_EMAIL, PERSONAL_MOBILE, WORK_PHONE
      // REMOVED: PERSONAL_STREET, PERSONAL_CITY, PERSONAL_STATE, PERSONAL_ZIP
      // REMOVED: WORK_STREET, WORK_CITY, WORK_STATE, WORK_ZIP
      // REMOVED: PERSONAL_BIRTHDAY, PERSONAL_PHOTO, UF_* custom fields
      // REMOVED: Full NAME and LAST_NAME (only displayName exposed)
    };
  }

  /**
   * Format user display name (first name + last initial)
   * @param {Object} user - User object
   * @returns {string} Display name (e.g., "Royce W.")
   */
  formatDisplayName(user) {
    const firstName = user.NAME || 'User';
    const lastInitial = user.LAST_NAME ? ` ${user.LAST_NAME.charAt(0)}.` : '';
    return `${firstName}${lastInitial}`;
  }

  /**
   * Sanitize CRM contact data by removing PII fields
   * @param {Object} response - Raw crm.contact.* API response
   * @returns {Object} Sanitized response with PII removed
   */
  sanitizeContactResponse(response) {
    if (!response || !response.result) {
      return response;
    }

    // Handle both single contact and array
    const contacts = Array.isArray(response.result) ? response.result : [response.result];

    const sanitized = contacts.map(contact => this.sanitizeContact(contact));

    logger.debug('Sanitized contact response', {
      originalCount: contacts.length,
      sanitizedCount: sanitized.length
    });

    return {
      ...response,
      result: Array.isArray(response.result) ? sanitized : sanitized[0]
    };
  }

  /**
   * Sanitize individual CRM contact object
   * @param {Object} contact - Raw contact object from Bitrix24
   * @returns {Object} Sanitized contact object
   */
  sanitizeContact(contact) {
    if (!contact) {
      return contact;
    }

    return {
      // Safe fields only
      id: contact.ID,
      name: contact.NAME ? `${contact.NAME.charAt(0)}. ${contact.LAST_NAME || ''}`.trim() : 'Contact',
      companyId: contact.COMPANY_ID || null,

      // REMOVED: EMAIL, PHONE, ADDRESS fields
      // REMOVED: Full NAME and LAST_NAME (only initial exposed)
    };
  }

  async executeRequest(request) {
    const startTime = Date.now();
    let attempts = 0;

    // SECURITY: Validate and cap maxRetries to prevent infinite loops
    const rawMaxRetries = request.maxRetries !== undefined ? request.maxRetries : this.limits.maxRetries;
    const maxRetries = Math.min(
      Math.max(0, parseInt(rawMaxRetries) || 0),
      10  // HARD LIMIT - never more than 10 retries
    );

    // SECURITY: Maximum execution time (2 minutes) - circuit breaker
    const MAX_EXECUTION_TIME = 120000;

    logger.debug('Starting request execution', {
      method: request.method,
      maxRetries,
      requestId: request.id || 'unknown'
    });

    while (attempts <= maxRetries) {
      // SECURITY: Circuit breaker - check total execution time
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_EXECUTION_TIME) {
        const error = new Error('Request execution time limit exceeded');
        logger.error('Request timeout after multiple retries', {
          method: request.method,
          attempts,
          elapsed,
          maxTime: MAX_EXECUTION_TIME,
          requestId: request.id || 'unknown'
        });
        this.stats.failed++;
        throw error;
      }

      try {
        // Log attempt
        logger.debug('Executing request attempt', {
          method: request.method,
          attempt: attempts + 1,
          maxRetries: maxRetries + 1,
          elapsed
        });

        // Track request in sliding window
        this.slidingWindow.addRequest();

        // Execute the actual API call
        const result = await this.callBitrix24API(request);

        // Update statistics
        this.stats.processed++;
        // Only log non-typing requests to reduce log spam
        if (request.method !== 'imbot.chat.sendTyping') {
          logger.info('Request processed successfully', {
            method: request.method,
            attempts: attempts + 1,
            duration: Date.now() - startTime,
            requestId: request.id || 'unknown'
          });
        }

        return result;
      } catch (error) {
        attempts++;
        logger.error('Request failed', {
          method: request.method,
          attempt: attempts,
          error: error.message,
          errorResponse: error.response?.data,
          elapsed: Date.now() - startTime,
          requestId: request.id || 'unknown'
        });

        // Check for rate limit error
        if (error.response?.status === 429 || error.code === 'RATE_LIMIT') {
          await this.enterCooldown();
          throw new Error('Rate limit exceeded');
        }


        // Retry with exponential backoff
        if (attempts <= maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
          logger.info('Retrying request after delay', {
            method: request.method,
            attempt: attempts,
            delay,
            requestId: request.id || 'unknown'
          });
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Max retries reached, fail the request
          this.stats.failed++;
          logger.error('Request failed after all retries', {
            method: request.method,
            totalAttempts: attempts,
            elapsed: Date.now() - startTime,
            finalError: error.message,
            requestId: request.id || 'unknown'
          });
          throw error;
        }
      }
    }

    // SECURITY: Should never reach here, but safety fallback
    throw new Error('Request execution completed without success or error');
  }

  async getBotAuth(method = null) {
    try {
      // CRITICAL: Only imbot.* methods should use bot OAuth authentication
      // All other methods (log.*, crm.*, im.*, user.*, etc.) should use webhook URL
      //
      // Reasoning:
      // - imbot.* methods: Bot-specific operations requiring bot identity (bot messages, typing indicators)
      // - log.* methods: Company-wide operations (news feed posts) requiring user-level permissions
      // - crm.* methods: CRM operations requiring broader permissions than bot scope provides
      // - im.*, user.*, etc.: General operations best handled with webhook URL

      if (method && method.startsWith('imbot.')) {
        // Use bot OAuth authentication for bot-specific methods
        const doc = await this.db.collection('bot').doc('auth').get();
        if (doc.exists) {
          const botAuth = doc.data();
          logger.debug('Using bot OAuth authentication for imbot method', { method });
          return botAuth;
        } else {
          logger.warn('Bot auth not found for imbot method, falling back to webhook URL', { method });
          return {
            restUrl: this.webhookUrl ? this.webhookUrl.replace(/[^/]*$/, '') : '',
            accessToken: null
          };
        }
      } else {
        // Use webhook URL (user authentication) for all other methods
        logger.debug('Using webhook URL authentication', {
          method,
          reason: method ? `${method.split('.')[0]}.* methods use webhook auth` : 'default_webhook_auth'
        });
        return {
          restUrl: this.webhookUrl ? this.webhookUrl.replace(/[^/]*$/, '') : '',
          accessToken: null
        };
      }
    } catch (error) {
      logger.error('Failed to get authentication config', { error: error.message });
      // Fallback to webhook URL
      return {
        restUrl: this.webhookUrl ? this.webhookUrl.replace(/[^/]*$/, '') : '',
        accessToken: null
      };
    }
  }

  async preprocessRequest(request) {
    // Create a copy of the request to avoid modifying the original
    const processedRequest = {
      ...request,
      params: { ...request.params }
    };

    // Convert markdown to BB code for chat message methods
    const chatMethods = [
      'im.message.add',
      'imbot.message.add',
      'im.notify.add',
      'imbot.notify.add'
    ];

    // Enhanced debugging for message preprocessing
    logger.debug('Preprocessing request', {
      method: request.method,
      hasChatMethod: chatMethods.includes(request.method),
      hasMessage: !!request.params.MESSAGE,
      messagePreview: request.params.MESSAGE ? request.params.MESSAGE.substring(0, 100) + '...' : 'none'
    });

    if (chatMethods.includes(request.method) && request.params.MESSAGE) {
      const originalMessage = request.params.MESSAGE;
      
      try {
        // First, enhance raw URLs with agentic link text
        logger.debug('Starting URL enhancement', {
          originalLength: originalMessage.length,
          hasHttp: originalMessage.includes('http'),
          messageSnippet: originalMessage.substring(0, 200)
        });
        
        const enhancedMessage = await this.enhanceURLsWithLinkText(originalMessage);
        
        logger.debug('URL enhancement completed', {
          originalLength: originalMessage.length,
          enhancedLength: enhancedMessage.length,
          changed: originalMessage !== enhancedMessage,
          enhancedSnippet: enhancedMessage.substring(0, 200)
        });
        
        // Then convert markdown to BB code
        let convertedMessage = convertForBitrixChat(enhancedMessage);
        
        logger.debug('BB code conversion completed', {
          enhancedLength: enhancedMessage.length,
          convertedLength: convertedMessage.length,
          changed: enhancedMessage !== convertedMessage,
          hasBBCode: convertedMessage.includes('[URL='),
          convertedSnippet: convertedMessage.substring(0, 200)
        });
        
        // Enhanced BB code validation and cleanup
        const bbCodePattern = /\[URL=([^\]]+)\]([^\[]+)\[\/URL\]/g;
        const malformedPattern = /\[URL=([^\]]+)\]\([^)]+\)/g;
        
        // Check for and fix malformed BB code with mixed markdown syntax
        if (malformedPattern.test(convertedMessage)) {
          logger.warn('Detected malformed BB code with mixed markdown syntax', {
            originalMessage: convertedMessage.substring(0, 200),
            malformedMatches: convertedMessage.match(malformedPattern) || []
          });
          
          // Fix malformed BB code by removing markdown remnants
          convertedMessage = convertedMessage.replace(
            /\[URL=([^\]]+)\]\([^)]+\)(\].*?\[\/URL\])/g,
            (match, url, suffix) => {
              // Extract the text part from the suffix
              const textMatch = suffix.match(/\]([^\[]+)\[\/URL\]/);
              const text = textMatch ? textMatch[1] : 'Web Link';
              return `[URL=${url}]${text}[/URL]`;
            }
          );
        }
        
        // Check for incomplete BB codes and fix them
        const incompleteBBPattern = /\[URL=([^\]]+)\]([^\[]*?)(?!\[\/URL\])/g;
        if (incompleteBBPattern.test(convertedMessage) && !convertedMessage.includes('[/URL]')) {
          logger.warn('Detected incomplete BB code, fixing', {
            originalMessage: convertedMessage.substring(0, 200)
          });
          
          convertedMessage = convertedMessage.replace(
            /\[URL=([^\]]+)\]([^\[]*?)$/g,
            (match, url, text) => {
              const cleanText = text.trim() || 'Web Link';
              return `[URL=${url}]${cleanText}[/URL]`;
            }
          );
        }
        
        // Final validation - if BB code is still malformed, try to fix it
        if (convertedMessage.includes('[URL=') && !bbCodePattern.test(convertedMessage)) {
          logger.warn('BB code validation failed, attempting final fix', {
            message: convertedMessage.substring(0, 200),
            hasURLTag: convertedMessage.includes('[URL='),
            hasClosingTag: convertedMessage.includes('[/URL]')
          });
          
          // More comprehensive fix for broken BB codes
          convertedMessage = convertedMessage.replace(
            /\[URL=([^\]]+)\]([^]*?)(?:\[\/URL\]|$)/g,
            (match, url, text) => {
              // Clean up the text part, removing any markdown remnants
              let cleanText = text
                .replace(/\([^)]*\)/g, '') // Remove (url) patterns
                .replace(/\].*$/, '') // Remove ] and everything after
                .trim();
              
              // If no text remains, generate a fallback
              if (!cleanText) {
                try {
                  const urlObj = new URL(url);
                  cleanText = urlObj.hostname.includes('google.com') ? 'Google Maps Link' : 'Web Link';
                } catch {
                  cleanText = 'Web Link';
                }
              }
              
              return `[URL=${url}]${cleanText}[/URL]`;
            }
          );
        }
        
        // Validate final BB code conversion
        const bbMatches = convertedMessage.match(bbCodePattern);
        
        if (bbMatches) {
          logger.debug('BB code validation passed', {
            method: request.method,
            bbCodeCount: bbMatches.length,
            bbCodes: bbMatches,
            messageLength: convertedMessage.length
          });
        }
        
        processedRequest.params.MESSAGE = convertedMessage;

        // Enhanced logging for conversion tracking
        if (originalMessage !== convertedMessage) {
          logger.info('Converted markdown to BB code for Bitrix24', {
            method: request.method,
            originalLength: originalMessage.length,
            convertedLength: convertedMessage.length,
            hasMarkdown: originalMessage.includes('**') || originalMessage.includes('*') || originalMessage.includes('`'),
            hasURL: originalMessage.includes('http'),
            hasBBCode: convertedMessage.includes('[URL='),
            conversionSteps: {
              step1_urlEnhancement: {
                changed: originalMessage !== enhancedMessage,
                length: enhancedMessage.length
              },
              step2_bbConversion: {
                changed: enhancedMessage !== convertedMessage,
                length: convertedMessage.length,
                bbCodeFound: !!bbMatches
              }
            },
            // Store for debugging
            originalMessage: originalMessage.substring(0, 200) + (originalMessage.length > 200 ? '...' : ''),
            enhancedMessage: enhancedMessage.substring(0, 200) + (enhancedMessage.length > 200 ? '...' : ''),
            convertedMessage: convertedMessage.substring(0, 200) + (convertedMessage.length > 200 ? '...' : '')
          });
        }
      } catch (error) {
        logger.error('Failed to process message for BB conversion', {
          error: error.message,
          method: request.method,
          messageLength: originalMessage.length,
          messagePreview: originalMessage.substring(0, 100)
        });
        
        // Use original message if processing fails
        processedRequest.params.MESSAGE = originalMessage;
      }
    }

    return processedRequest;
  }

  /**
   * Chunk long messages to fit within Bitrix24's character limit
   * @param {string} message - The message to chunk
   * @param {number} maxLength - Maximum characters per chunk (default: 19000 to leave margin)
   * @returns {Array<string>} - Array of message chunks
   */
  chunkMessage(message, maxLength = 19000) {
    // If message is within limit, return as-is
    if (message.length <= maxLength) {
      return [message];
    }

    logger.warn('Message exceeds Bitrix24 character limit, chunking required', {
      messageLength: message.length,
      maxLength,
      chunksEstimated: Math.ceil(message.length / maxLength)
    });

    const chunks = [];
    const lines = message.split('\n');
    let currentChunk = '';
    let chunkNumber = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineWithNewline = i < lines.length - 1 ? line + '\n' : line;

      // Check if adding this line would exceed the limit
      if (currentChunk.length + lineWithNewline.length > maxLength) {
        if (currentChunk.length > 0) {
          // Add footer to current chunk
          const footer = `\n\n[I]--- Message continues (${chunkNumber}/${Math.ceil(message.length / maxLength) + 1}) ---[/I]`;
          chunks.push(currentChunk.trim() + footer);
          chunkNumber++;
          currentChunk = '';
        }

        // If a single line is too long, split it by words
        if (lineWithNewline.length > maxLength) {
          const words = line.split(' ');
          let wordChunk = '';

          for (const word of words) {
            if (wordChunk.length + word.length + 1 > maxLength) {
              if (wordChunk.length > 0) {
                const footer = `\n\n[I]--- Message continues (${chunkNumber}/${Math.ceil(message.length / maxLength) + 1}) ---[/I]`;
                chunks.push(wordChunk.trim() + footer);
                chunkNumber++;
                wordChunk = '';
              }

              // If single word is too long, split it (rare edge case)
              if (word.length > maxLength) {
                const wordParts = word.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
                for (let j = 0; j < wordParts.length - 1; j++) {
                  const footer = `\n\n[I]--- Message continues (${chunkNumber}/${Math.ceil(message.length / maxLength) + 1}) ---[/I]`;
                  chunks.push(wordParts[j] + footer);
                  chunkNumber++;
                }
                wordChunk = wordParts[wordParts.length - 1] + ' ';
              } else {
                wordChunk = word + ' ';
              }
            } else {
              wordChunk += word + ' ';
            }
          }

          if (wordChunk.trim().length > 0) {
            currentChunk = wordChunk.trim() + '\n';
          }
        } else {
          currentChunk = lineWithNewline;
        }
      } else {
        currentChunk += lineWithNewline;
      }
    }

    // Add remaining content as final chunk
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    logger.info('Message chunked successfully', {
      originalLength: message.length,
      chunksCreated: chunks.length,
      chunkLengths: chunks.map(c => c.length)
    });

    return chunks;
  }

  async callBitrix24API(request) {
    const axios = require('axios');

    // Get bot authentication data (pass method for CRM-specific handling)
    const botAuth = await this.getBotAuth(request.method);

    // Use bot's REST URL and access token
    const url = `${botAuth.restUrl}${request.method}`;

    // Enhanced debugging for invoice list requests
    if (request.method === 'crm.invoice.list') {
      logger.info('Sending crm.invoice.list request', {
        method: request.method,
        url: url.substring(0, 50) + '...',
        params: request.params,
        filter: request.params?.filter,
        requestBody: JSON.stringify(request.params, null, 2)
      });
    }

    const requestConfig = {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json',
        'Accept-Charset': 'utf-8'
      },
      // Ensure proper encoding
      responseEncoding: 'utf8'
    };

    // Enhanced logging for BB code conversion debugging
    if (request.params.MESSAGE && request.params.MESSAGE.includes('[URL=')) {
      logger.info('Sending BB code message to Bitrix24', {
        method: request.method,
        messageLength: request.params.MESSAGE.length,
        hasBBCode: request.params.MESSAGE.includes('[URL='),
        bbCodeSnippet: request.params.MESSAGE.match(/\[URL=[^\]]+\][^\[]+\[\/URL\]/)?.[0] || 'No BB code found',
        fullMessage: request.params.MESSAGE,
        messagePreview: request.params.MESSAGE.substring(0, 300),
        // Character analysis
        hasSquareBrackets: request.params.MESSAGE.includes('[') && request.params.MESSAGE.includes(']'),
        urlEqualCount: (request.params.MESSAGE.match(/URL=/g) || []).length,
        slashUrlCount: (request.params.MESSAGE.match(/\/URL/g) || []).length
      });
    }

    // Add auth token if available
    if (botAuth.accessToken) {
      requestConfig.params = {
        auth: botAuth.accessToken
      };
    } else {
      // Use webhook URL format (for CRM methods or when bot auth unavailable)
      if (!this.webhookUrl) {
        throw new Error('Bitrix24 webhook URL not configured. Please configure in dashboard.');
      }
      const webhookUrl = `${this.webhookUrl}${request.method}`;

      logger.debug('Using webhook URL for API call', {
        method: request.method,
        webhookUrl: webhookUrl.substring(0, 50) + '...',
        hasMessage: !!request.params.MESSAGE,
        reason: request.method.startsWith('crm.') ? 'crm_method' : 'no_bot_auth'
      });

      const response = await axios.post(webhookUrl, request.params, requestConfig);
      return response.data;
    }

    const response = await axios.post(url, request.params, requestConfig);
    
    // Enhanced logging for invoice list responses
    if (request.method === 'crm.invoice.list') {
      logger.info('Received crm.invoice.list response', {
        method: request.method,
        responseStatus: response.status,
        resultCount: response.data?.result?.length || 0,
        totalCount: response.data?.total || 0,
        hasMore: response.data?.more || false,
        success: !!response.data?.result
      });
    }
    
    // Enhanced logging for response
    if (request.params.MESSAGE && request.params.MESSAGE.includes('[URL=')) {
      logger.debug('Bitrix24 API response for BB code message', {
        method: request.method,
        responseStatus: response.status,
        responseData: response.data,
        success: !!response.data?.result
      });
    }
    
    return response.data;
  }


  getStats() {
    return {
      ...this.stats,
      queueSize: this.queue.size,
      queuePending: this.queue.pending,
      isInCooldown: this.isInCooldown(),
      cooldownUntil: this.cooldownUntil,
      requestsInWindow: this.slidingWindow.getRequestsInWindow()
    };
  }

  async clear() {
    await this.queue.clear();
    this.stats.queued = 0;
    logger.info('Queue cleared');
  }

  /**
   * Enhance raw URLs with agentic link text using Gemini
   * @param {string} message - The message that may contain raw URLs
   * @returns {string} - Message with URLs converted to proper markdown links
   */
  async enhanceURLsWithLinkText(message) {
    try {
      // Enhanced logging for debugging URL enhancement issues
      logger.debug('Starting URL enhancement process', {
        messageLength: message.length,
        messagePreview: message.substring(0, 200),
        hasHttp: message.includes('http'),
        hasMarkdownLinks: message.includes('](')
      });

      // Find raw URLs that are not already in markdown link format
      // More robust regex to exclude URLs already in markdown [text](url) format
      const rawUrlRegex = /(?<!\]\()https?:\/\/[^\s\)\]"]+(?!\))/g;
      const urlMatches = message.match(rawUrlRegex);
      
      // Check for cases where Gemini creates [https://url](https://url) format
      // This is valid markdown but has URL as text - we should improve the link text
      const urlAsTextRegex = /\[(https?:\/\/[^\]]+)\]\((https?:\/\/[^)]+)\)/g;
      const urlAsTextMatches = message.match(urlAsTextRegex);
      
      // Check for malformed markdown links that start with [ but don't have proper format
      // BUT exclude valid markdown links that already have the closing ](url) format
      const malformedLinkRegex = /\[https?:\/\/[^\s\)\]"]+(?!\]\([^)]+\))/g;
      const malformedMatches = message.match(malformedLinkRegex);
      
      if ((!urlMatches || urlMatches.length === 0) && 
          (!malformedMatches || malformedMatches.length === 0) && 
          (!urlAsTextMatches || urlAsTextMatches.length === 0)) {
        logger.debug('No URLs found to enhance', { 
          rawUrlMatches: urlMatches?.length || 0,
          malformedMatches: malformedMatches?.length || 0,
          urlAsTextMatches: urlAsTextMatches?.length || 0
        });
        return message; // No URLs found
      }

      logger.debug('Found URLs to enhance', { 
        rawUrlCount: urlMatches?.length || 0,
        malformedCount: malformedMatches?.length || 0,
        urlAsTextCount: urlAsTextMatches?.length || 0,
        rawUrls: urlMatches?.map(url => url.substring(0, 50) + '...') || [],
        malformedUrls: malformedMatches?.map(url => url.substring(0, 50) + '...') || [],
        urlAsTextUrls: urlAsTextMatches?.map(url => url.substring(0, 50) + '...') || []
      });

      let enhancedMessage = message;

      // Fix URL-as-text links first (e.g., [https://google.com](https://google.com) -> [Google Maps Link](https://google.com))
      if (urlAsTextMatches && urlAsTextMatches.length > 0) {
        for (const match of urlAsTextMatches) {
          const urlPattern = /\[(https?:\/\/[^\]]+)\]\((https?:\/\/[^)]+)\)/;
          const urlMatch = match.match(urlPattern);
          if (urlMatch) {
            const [fullMatch, , linkUrl] = urlMatch; // textUrl not needed, just skip it
            const linkText = this.generateFallbackLinkText(linkUrl);
            // Replace with proper link text
            enhancedMessage = enhancedMessage.replace(fullMatch, `[${linkText}](${linkUrl})`);
            
            logger.debug('Fixed URL-as-text link', {
              original: fullMatch.substring(0, 50) + '...',
              linkText: linkText,
              url: linkUrl.substring(0, 50) + '...'
            });
          }
        }
      }

      // Fix malformed links first (e.g., [https://google.com -> [Link Text](https://google.com))
      // Only fix links that are truly malformed (don't already have ](url) ending)
      if (malformedMatches && malformedMatches.length > 0) {
        for (const malformedLink of malformedMatches) {
          const url = malformedLink.substring(1); // Remove the opening [
          const linkText = this.generateFallbackLinkText(url);
          // Replace malformed link with proper markdown format
          enhancedMessage = enhancedMessage.replace(malformedLink, `[${linkText}](${url})`);
          
          logger.debug('Fixed malformed link', {
            malformedLink: malformedLink,
            extractedUrl: url.substring(0, 50) + '...',
            linkText: linkText,
            result: `[${linkText}](${url.substring(0, 30)}...)`
          });
        }
      }

      // Process raw URLs with smart fallback link text
      if (urlMatches && urlMatches.length > 0) {
        for (const url of urlMatches) {
          const linkText = this.generateFallbackLinkText(url);
          // Replace raw URL with markdown link format
          enhancedMessage = enhancedMessage.replace(url, `[${linkText}](${url})`);
          
          logger.debug('Enhanced raw URL with fallback link text', {
            originalUrl: url.substring(0, 50) + '...',
            linkText: linkText
          });
        }
      }

      logger.debug('URL enhancement completed', {
        originalLength: message.length,
        enhancedLength: enhancedMessage.length,
        changed: message !== enhancedMessage,
        enhancedPreview: enhancedMessage.substring(0, 200)
      });

      return enhancedMessage;

    } catch (error) {
      logger.error('Failed to enhance URLs with link text', { error: error.message });
      return message; // Return original message if enhancement fails
    }
  }


  /**
   * Generate simple fallback link text based on URL domain
   * @param {string} url - The URL to generate text for
   * @returns {string} - Simple fallback link text
   */
  generateFallbackLinkText(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      const fullUrl = url.toLowerCase();
      const pathname = urlObj.pathname.toLowerCase();

      // Enhanced domain-specific fallbacks with better context
      if (hostname.includes('maps.google.com') || 
          hostname.includes('goo.gl/maps') || 
          (hostname.includes('google.com') && (fullUrl.includes('/maps/') || pathname.includes('/maps')))) {
        // More specific Google Maps link text based on URL content
        if (fullUrl.includes('walk') || fullUrl.includes('route')) {
          return 'Walk Route Map';
        }
        if (fullUrl.includes('place') || fullUrl.includes('search')) {
          return 'Location on Google Maps';
        }
        return 'Google Maps Link';
      }
      
      if (hostname.includes('storage.googleapis.com') || hostname.includes('storage.cloud.google.com')) {
        return 'Download File';
      }
      
      if (hostname.includes('drive.google.com')) {
        if (fullUrl.includes('document')) {return 'Google Document';}
        if (fullUrl.includes('spreadsheet')) {return 'Google Spreadsheet';}
        if (fullUrl.includes('presentation')) {return 'Google Presentation';}
        return 'Google Drive File';
      }
      
      if (hostname.includes('github.com')) {
        return 'GitHub Repository';
      }
      
      if (hostname.includes('docs.google.com')) {
        return 'Google Document';
      }

      if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
        return 'YouTube Video';
      }

      if (hostname.includes('dropbox.com')) {
        return 'Dropbox File';
      }

      // Generic fallback with cleaner domain name
      const cleanDomain = hostname.replace('www.', '').replace(/^m\./, '');
      const domainParts = cleanDomain.split('.');
      const mainDomain = domainParts.length > 1 ? domainParts[0] : cleanDomain;
      
      // Capitalize first letter for better presentation
      const capitalizedDomain = mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
      return `${capitalizedDomain} Link`;

    } catch (error) {
      logger.debug('Error generating fallback link text', { url, error: error.message });
      return 'Web Link';
    }
  }
}

// Singleton instance
let bitrix24QueueManager;

async function initializeBitrix24Queue() {
  if (!bitrix24QueueManager) {
    bitrix24QueueManager = new Bitrix24QueueManager();
    await bitrix24QueueManager.initialize();
  }
  return bitrix24QueueManager;
}

function getBitrix24QueueManager() {
  if (!bitrix24QueueManager) {
    throw new Error('Bitrix24 queue manager not initialized');
  }
  return bitrix24QueueManager;
}

module.exports = {
  Bitrix24QueueManager,
  initializeBitrix24Queue,
  getBitrix24QueueManager,
  // Deprecated exports for backward compatibility - will be removed in future version
  initializeQueue: initializeBitrix24Queue,
  getQueueManager: getBitrix24QueueManager
};