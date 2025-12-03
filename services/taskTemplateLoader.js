const vm = require('vm');
const { getGeminiClient, extractGeminiText, getGeminiModelName } = require('../config/gemini');
const { logger } = require('../utils/logger');
const { getTaskTemplatesModel } = require('../models/taskTemplates');
const { RepairTracker } = require('./repairTracker');

/**
 * TaskTemplateLoader - Manages dynamic task templates
 * 
 * This service loads task templates from Firestore, compiles their JavaScript
 * execution code in secure VM contexts, and provides template matching based
 * on user messages and triggers.
 */
class TaskTemplateLoader {
  constructor() {
    this.templatesModel = getTaskTemplatesModel();
    this.executorCache = new Map();
    this.cacheExpiry = 300000; // 5 minutes
    this.repairTracker = new RepairTracker(); // Safety: Circuit breaker for auto-repair
  }

  /**
   * Load a template by ID with auto-repair capability
   * @param {string} templateId - Template identifier
   * @param {Object} originalRequest - Original user request for repair context
   * @returns {Object} - Template configuration
   */
  async loadTemplate(templateId, originalRequest = null) {
    try {
      const template = await this.templatesModel.getTemplate(templateId);
      
      if (!template) {
        throw new Error(`Task template not found: ${templateId}`);
      }
      
      // Validate template structure with auto-repair
      const validation = await this.validateTemplate(template, originalRequest);
      if (!validation.valid) {
        // If auto-repair was attempted but still failed
        if (validation.repairAttempt > 0) {
          logger.error('Template validation failed even after auto-repair', {
            templateId,
            repairAttempts: validation.repairAttempt,
            errors: validation.errors
          });
          throw new Error(`Template ${templateId} failed validation after repair attempts: ${validation.errors.join(', ')}`);
        } else {
          throw new Error(`Invalid template ${templateId}: ${validation.errors.join(', ')}`);
        }
      }
      
      // If template was auto-repaired, save the repaired version
      if (validation.repairAttempt > 0 && validation.template !== template) {
        logger.info('Saving auto-repaired template to database', {
          templateId,
          repairAttempts: validation.repairAttempt
        });

        await this.templatesModel.updateTemplate(templateId, {
          executionScript: validation.template.executionScript,
          lastRepaired: validation.template.lastRepaired,
          repairAttempt: validation.template.repairAttempt
        });

        // CRITICAL: Clear executor cache for this template to force recompilation
        // Cache keys are templateId_timestamp, so we need to clear ALL entries for this templateId
        for (const [cacheKey, _] of this.executorCache.entries()) {
          if (cacheKey.startsWith(`${templateId}_`)) {
            this.executorCache.delete(cacheKey);
            logger.info('Cleared cached executor after repair', { cacheKey });
          }
        }
      }
      
      logger.info('Template loaded successfully', { 
        templateId, 
        name: template.name,
        wasRepaired: validation.repairAttempt > 0
      });
      
      return validation.template; // Return the (possibly repaired) template
    } catch (error) {
      logger.error('Failed to load template', { templateId, error: error.message });
      throw error;
    }
  }

  /**
   * Create executor instance from template
   * @param {string} templateId - Template identifier
   * @param {Object} taskData - Task execution data
   * @param {Object} originalRequest - Original user request for repair context
   * @returns {Object} - Executor instance
   */
  async createExecutor(templateId, taskData, originalRequest = null) {
    try {
      const template = await this.loadTemplate(templateId, originalRequest);

      // Check if executor is already compiled and cached
      // Convert Firestore Timestamp to numeric value for proper cache invalidation
      const timestamp = template.updatedAt?._seconds
        ? template.updatedAt._seconds * 1000 + Math.floor(template.updatedAt._nanoseconds / 1000000)
        : Date.now();
      const cacheKey = `${templateId}_${timestamp}`;
      if (this.executorCache.has(cacheKey)) {
        const ExecutorClass = this.executorCache.get(cacheKey);
        return new ExecutorClass(taskData, template);
      }

      // Compile the execution script with auto-repair capability
      const ExecutorClass = await this.compileExecutorScript(template.executionScript, template, originalRequest);

      // Cache the compiled class
      this.executorCache.set(cacheKey, ExecutorClass);

      logger.info('Executor compiled and cached', {
        templateId,
        cacheKey
      });

      return new ExecutorClass(taskData, template);
    } catch (error) {
      logger.error('Failed to create executor', { templateId, error: error.message });
      throw error;
    }
  }

  /**
   * Compile JavaScript execution script in secure context
   * @param {string} scriptCode - JavaScript class code
   * @param {Object} template - Template configuration
   * @returns {Function} - Compiled executor class
   */
  async compileExecutorScript(scriptCode, template, originalRequest = null, repairAttempt = 0) {
    try {
      // PHASE 1: Validate and prepare script (auto-escape if needed)
      const scriptValidation = await this.validateAndPrepareScript(scriptCode, template.templateId);

      if (!scriptValidation.valid) {
        throw new Error(scriptValidation.message || 'Script validation failed');
      }

      // Use the validated/escaped script for compilation
      const validatedScript = scriptValidation.script;

      if (scriptValidation.escaped) {
        logger.warn('Using auto-escaped script for compilation', {
          templateId: template.templateId,
          originalError: scriptValidation.originalError
        });
      }

      // PHASE 2: Security validation
      this.validateExecutionScript(validatedScript);

      // Create a secure execution context
      const context = this.createSecureContext(template);

      // Extract class name from script (simple regex approach)
      const classNameMatch = validatedScript.match(/class\s+(\w+)\s+extends/);
      const className = classNameMatch ? classNameMatch[1] : 'TaskExecutor';

      // Compile the script - wrap in function to handle return statements
      const compiledScript = new vm.Script(`
        (function() {
          ${validatedScript}

          // Return the executor class
          return ${className};
        })();
      `);

      // Execute in secure context to get the class
      const ExecutorClass = compiledScript.runInContext(context, {
        timeout: 5000, // 5 second compilation timeout
        displayErrors: true
      });

      if (typeof ExecutorClass !== 'function') {
        throw new Error('Compiled script did not return a constructor function');
      }

      logger.info('Script compiled successfully', {
        templateId: template.templateId,
        className,
        codeLength: validatedScript.length,
        wasEscaped: scriptValidation.escaped
      });
      
      return ExecutorClass;
    } catch (error) {
      // Check if this is a security validation error and if we should attempt auto-repair
      const isSecurityError = error.message.includes('Potentially unsafe code detected') || 
                             error.message.includes('Script too large') ||
                             error.message.includes('Incorrect logging pattern detected');
      
      if (isSecurityError && originalRequest && repairAttempt < 2) {
        logger.warn('Security validation failed, attempting auto-repair', {
          templateId: template.templateId,
          error: error.message,
          repairAttempt: repairAttempt + 1
        });

        try {
          // Attempt to repair the script for security compliance
          const repairedTemplate = await this.repairTemplateForSecurityViolation(
            template, 
            error.message, 
            originalRequest, 
            repairAttempt + 1
          );
          
          if (repairedTemplate && repairedTemplate.executionScript) {
            logger.info('Security repair successful, saving to database and retrying compilation', {
              templateId: template.templateId,
              repairAttempt: repairAttempt + 1
            });

            // Save the repaired template to database
            try {
              await this.templatesModel.updateTemplate(template.templateId, {
                executionScript: repairedTemplate.executionScript,
                lastRepaired: repairedTemplate.lastRepaired,
                repairReason: repairedTemplate.repairReason,
                repairContext: repairedTemplate.repairContext,
                repairAttempt: repairedTemplate.repairAttempt
              });

              logger.info('Repaired template saved to database', {
                templateId: template.templateId,
                repairAttempt: repairAttempt + 1
              });

              // CRITICAL: Clear executor cache for this template to force recompilation
              for (const [cacheKey, _] of this.executorCache.entries()) {
                if (cacheKey.startsWith(`${template.templateId}_`)) {
                  this.executorCache.delete(cacheKey);
                  logger.info('Cleared cached executor after security repair', { cacheKey });
                }
              }
            } catch (saveError) {
              logger.error('Failed to save repaired template to database', {
                templateId: template.templateId,
                repairAttempt: repairAttempt + 1,
                saveError: saveError.message
              });
              // Continue with execution anyway, using the repaired version in memory
            }

            // Recursively try to compile the repaired script
            return await this.compileExecutorScript(
              repairedTemplate.executionScript,
              repairedTemplate,
              originalRequest,
              repairAttempt + 1
            );
          }
        } catch (repairError) {
          logger.error('Security auto-repair failed', {
            templateId: template.templateId,
            originalError: error.message,
            repairError: repairError.message
          });
          // Fall through to original error handling
        }
      }
      
      logger.error('Script compilation failed', { 
        templateId: template.templateId,
        error: error.message,
        stack: error.stack,
        isSecurityError,
        repairAttempted: isSecurityError && originalRequest && repairAttempt < 2
      });
      throw new Error(`Script compilation failed: ${error.message}`);
    }
  }

  /**
   * Create secure VM execution context
   * @param {Object} template - Template configuration
   * @returns {Object} - VM context
   */
  createSecureContext(template) {
    // Security: Create Firestore RBAC proxy instead of direct admin SDK access
    const { FirestoreProxy } = require('./firestoreProxy');
    const { getFirestore } = require('../config/firestore');

    const firestoreProxy = new FirestoreProxy({
      db: getFirestore(),
      allowedCollections: [
        'task-templates',
        'task-queue',
        'conversations',
        'users',
        'knowledge-base',
        'reasoning-memory',
        'tool-settings'
      ],
      readOnly: false, // Templates can write to certain collections
      maxReadsPerMinute: 100,
      maxWritesPerMinute: 20
    });

    // Create a sandbox with limited access
    const sandbox = {
      // Safe globals
      console: {
        log: (...args) => logger.info('Template script log', { templateId: template.templateId, args }),
        error: (...args) => logger.error('Template script error', { templateId: template.templateId, args }),
        warn: (...args) => logger.warn('Template script warn', { templateId: template.templateId, args })
      },
      setTimeout: setTimeout,
      setInterval: setInterval,
      clearTimeout: clearTimeout,
      clearInterval: clearInterval,

      // Chantilly-specific utilities
      BaseTaskExecutor: require('../lib/baseTaskExecutor'),

      // Security: Provide proxied Firestore access instead of direct admin SDK
      admin: {
        firestore: () => firestoreProxy
      },

      // Bitrix24 User Management (Phase 5: Complex Task Integration)
      // Provides full user data (not sanitized) for task execution context
      // PII is NOT sent to Gemini - only used within secure task execution
      bitrixUsers: {
        /**
         * Search users by name or criteria
         * @param {string|Object} query - Search query
         * @param {Object} options - Search options
         * @returns {Promise<Object[]>} - Full user objects (with PII for API calls)
         */
        search: async (query, options = {}) => {
          const { getBitrix24QueueManager } = require('./bitrix24-queue');
          const queue = getBitrix24QueueManager();

          const filter = typeof query === 'string' ? { FIND: query } : query;
          if (options.activeOnly !== false) {
            filter.ACTIVE = 'Y';
          }

          logger.debug('bitrixUsers.search called from template', {
            templateId: template.templateId,
            query: typeof query === 'string' ? query : 'object',
            options
          });

          // Call WITHOUT sanitization - we need full data for task execution
          const result = await queue.add({
            method: 'user.search',
            params: {
              FILTER: filter,
              LIMIT: options.limit || 50
            },
            sanitizePII: false, // CRITICAL: Get full user data for task execution
            priority: 3
          });

          if (!result || !result.result || !Array.isArray(result.result)) {
            return [];
          }

          // Return full user objects (with PII) for task execution
          // This data stays in the secure sandbox and is NOT sent to Gemini
          return result.result.map(user => ({
            id: user.ID,
            name: user.NAME,
            lastName: user.LAST_NAME,
            email: user.EMAIL,
            personalMobile: user.PERSONAL_MOBILE,
            workPhone: user.WORK_PHONE,
            workPosition: user.WORK_POSITION,
            active: user.ACTIVE === 'Y' || user.ACTIVE === true,
            departments: user.UF_DEPARTMENT || []
          }));
        },

        /**
         * Get user by ID
         * @param {string|string[]} userId - User ID(s)
         * @param {Object} options - Get options
         * @returns {Promise<Object|Object[]>} - Full user object(s)
         */
        getById: async (userId, options = {}) => {
          const { getBitrix24QueueManager } = require('./bitrix24-queue');
          const queue = getBitrix24QueueManager();

          const ids = Array.isArray(userId) ? userId : [userId];

          logger.debug('bitrixUsers.getById called from template', {
            templateId: template.templateId,
            userIds: ids,
            options
          });

          // Call WITHOUT sanitization - we need full data
          const result = await queue.add({
            method: 'user.get',
            params: {
              FILTER: {
                ID: ids.length === 1 ? ids[0] : ids.join('|')
              }
            },
            sanitizePII: false, // CRITICAL: Get full user data
            priority: 3
          });

          if (!result || !result.result || !Array.isArray(result.result)) {
            return Array.isArray(userId) ? [] : null;
          }

          const users = result.result.map(user => ({
            id: user.ID,
            name: user.NAME,
            lastName: user.LAST_NAME,
            email: user.EMAIL,
            personalMobile: user.PERSONAL_MOBILE,
            workPhone: user.WORK_PHONE,
            workPosition: user.WORK_POSITION,
            active: user.ACTIVE === 'Y' || user.ACTIVE === true,
            departments: user.UF_DEPARTMENT || []
          }));

          return Array.isArray(userId) ? users : users[0] || null;
        }
      },

      // 3CX API Access (Complex Task Integration)
      // Provides access to 3CX phone system APIs (call recordings, transcripts, call history)
      // Used within secure task execution context
      threecx: {
        /**
         * Get recording by ID with transcript
         * @param {string} recordingId - Recording ID from 3CX
         * @param {Object} options - Additional options
         * @returns {Promise<Object>} - Recording details with transcript
         */
        getRecording: async (recordingId, options = {}) => {
          const { getThreeCXQueueManager } = require('./threecx-queue');

          // Initialize queue manager if needed
          let queue;
          try {
            queue = getThreeCXQueueManager();
          } catch (initError) {
            // If not initialized, initialize it first
            const { initializeThreeCXQueue } = require('./threecx-queue');
            queue = await initializeThreeCXQueue();
          }

          logger.debug('threecx.getRecording called from template', {
            templateId: template.templateId,
            recordingId,
            options
          });

          // Fetch recording details with transcript using OData $filter
          // 3CX API doesn't support parentheses notation Recordings(id)
          // Build params object with verified schema fields from /xapi/v1/swagger.yaml
          const params = {
            '$orderby': 'StartTime desc',
            '$select': 'Id,FromDisplayName,FromCallerNumber,ToDisplayName,ToDn,ToCallerNumber,StartTime,EndTime,IsTranscribed,Transcription,RecordingUrl,IsArchived,CanBeTranscribed',
            '$count': 'true',
            '$top': 1,  // Only need 1 result for specific ID
            '$filter': `Id eq ${recordingId}`  // OData syntax: numeric Id without quotes
          };

          // CRITICAL: Only pass specific options, not params (params must not be overwritten)
          const response = await queue.add({
            endpoint: '/xapi/v1/Recordings',
            params,
            maxRetries: options.maxRetries || 3,
            id: options.id
          });

          // OData returns { value: [...] } - extract first result
          if (!response || !response.value || response.value.length === 0) {
            return null;
          }

          return response.value[0];
        },

        /**
         * List recordings with filters
         * @param {Object} filters - Filter parameters (e.g., date range, caller)
         * @param {Object} options - Query options (limit, select fields)
         * @returns {Promise<Object[]>} - Array of recordings
         */
        listRecordings: async (filters = {}, options = {}) => {
          const { getThreeCXQueueManager } = require('./threecx-queue');

          let queue;
          try {
            queue = getThreeCXQueueManager();
          } catch (initError) {
            const { initializeThreeCXQueue } = require('./threecx-queue');
            queue = await initializeThreeCXQueue();
          }

          logger.debug('threecx.listRecordings called from template', {
            templateId: template.templateId,
            filters,
            options
          });

          // Build OData filter string
          const params = {
            $select: options.select || 'Id,FromDisplayName,FromCallerNumber,ToDisplayName,StartTime,Duration,IsTranscribed',
            ...(options.top && { $top: options.top }),
            ...(options.skip && { $skip: options.skip })
          };

          // Add filters
          const filterParts = [];
          if (filters.startDate) {
            filterParts.push(`StartTime ge ${filters.startDate}`);
          }
          if (filters.endDate) {
            filterParts.push(`StartTime le ${filters.endDate}`);
          }
          if (filters.fromNumber) {
            filterParts.push(`FromCallerNumber eq '${filters.fromNumber}'`);
          }
          if (filters.toNumber) {
            filterParts.push(`ToCallerNumber eq '${filters.toNumber}'`);
          }
          if (filters.isTranscribed !== undefined) {
            filterParts.push(`IsTranscribed eq ${filters.isTranscribed}`);
          }

          if (filterParts.length > 0) {
            params.$filter = filterParts.join(' and ');
          }

          const result = await queue.add({
            endpoint: '/xapi/v1/Recordings',
            params,
            ...options
          });

          // Return array of recordings or empty array if no value
          return result?.value || [];
        },

        /**
         * Get call history
         * @param {Object} filters - Filter parameters (date range, extension, etc.)
         * @param {Object} options - Query options
         * @returns {Promise<Object[]>} - Array of call history records
         */
        getCallHistory: async (filters = {}, options = {}) => {
          const { getThreeCXQueueManager } = require('./threecx-queue');

          let queue;
          try {
            queue = getThreeCXQueueManager();
          } catch (initError) {
            const { initializeThreeCXQueue } = require('./threecx-queue');
            queue = await initializeThreeCXQueue();
          }

          logger.debug('threecx.getCallHistory called from template', {
            templateId: template.templateId,
            filters,
            options
          });

          // Build query parameters
          const params = {
            $select: options.select || 'Id,StartTime,Duration,FromDisplayName,FromNumber,ToDisplayName,ToNumber,CallType',
            ...(options.top && { $top: options.top }),
            ...(options.skip && { $skip: options.skip })
          };

          // Add filters
          const filterParts = [];
          if (filters.startDate) {
            filterParts.push(`StartTime ge ${filters.startDate}`);
          }
          if (filters.endDate) {
            filterParts.push(`StartTime le ${filters.endDate}`);
          }
          if (filters.extension) {
            filterParts.push(`(FromNumber eq '${filters.extension}' or ToNumber eq '${filters.extension}')`);
          }

          if (filterParts.length > 0) {
            params.$filter = filterParts.join(' and ');
          }

          const result = await queue.add({
            endpoint: '/xapi/v1/CallHistoryView',
            params,
            ...options
          });

          return result?.value || [];
        },

        /**
         * Generic 3CX API call for advanced use cases
         * @param {string} endpoint - XAPI endpoint path (e.g., '/xapi/v1/Recordings')
         * @param {Object} params - Query parameters
         * @param {Object} options - Additional options (maxRetries, etc.)
         * @returns {Promise<Object>} - API response
         */
        call: async (endpoint, params = {}, options = {}) => {
          const { getThreeCXQueueManager } = require('./threecx-queue');

          let queue;
          try {
            queue = getThreeCXQueueManager();
          } catch (initError) {
            const { initializeThreeCXQueue } = require('./threecx-queue');
            queue = await initializeThreeCXQueue();
          }

          logger.debug('threecx.call called from template', {
            templateId: template.templateId,
            endpoint,
            params: Object.keys(params),
            options
          });

          const result = await queue.add({
            endpoint,
            params,
            ...options
          });

          return result;
        }
      },

      // Utility functions
      JSON: JSON,
      Math: Math,
      Date: Date,
      Promise: Promise,

      // Buffer for file operations
      Buffer: Buffer,

      // Required modules (limited set)
      require: (moduleName) => {
        const allowedModules = [
          'axios',
          'lodash',
          'moment',
          '../utils/dataProcessor',
          '../utils/reportGenerator',
          '../utils/logger',
          '../config/firestore'
        ];

        if (allowedModules.includes(moduleName)) {
          return require(moduleName);
        }

        throw new Error(`Module not allowed in template execution: ${moduleName}`);
      },

      // Provide logger directly to prevent import errors
      logger: require('../utils/logger').logger
    };

    return vm.createContext(sandbox);
  }

  /**
   * Find template by AI-powered matching
   * @param {string} message - User message
   * @param {Object} context - Message context
   * @returns {Object|null} - Matching template or null
   */
  async findTemplateByTrigger(message, context) {
    try {
      // Load all active templates (cached)
      const templates = await this.loadActiveTemplates();
      
      if (templates.length === 0) {
        logger.warn('No active templates available for matching');
        return null;
      }
      
      // Use Gemini AI for intelligent template selection (primary method)
      const selectedTemplate = await this.selectTemplateWithAI(message, templates, context);
      
      if (selectedTemplate) {
        logger.info('Template matched by AI', {
          templateId: selectedTemplate.templateId,
          templateName: selectedTemplate.name,
          message: message.substring(0, 100),
          confidence: selectedTemplate.aiConfidence || 'high'
        });
        return selectedTemplate;
      }
      
      // AI determined no match - trust the AI decision and skip regex fallback
      // This ensures agentic generation is used for new/unique requirements
      logger.info('AI template selection found no match - proceeding to agentic generation', {
        message: message.substring(0, 100),
        availableTemplates: templates.length
      });
      return null;
      
    } catch (error) {
      logger.error('AI template selection completely failed, falling back to regex as last resort', { error: error.message });
      // Only use regex fallback when AI is completely unavailable/broken
      const templates = await this.loadActiveTemplates();
      return await this.findTemplateByRegexFallback(message, context, templates);
    }
  }

  /**
   * AI-powered template selection using Gemini
   * @param {string} message - User message
   * @param {Array} templates - Available templates
   * @param {Object} context - Message context
   * @returns {Object|null} - Selected template or null
   */
  async selectTemplateWithAI(message, templates, context) {
    try {
      const genAI = getGeminiClient();
      if (!genAI) {
        logger.warn('Gemini client not available for template selection');
        return null;
      }

      // Prepare template descriptions for AI
      const templateDescriptions = templates.map(template => ({
        id: template.templateId,
        name: template.name,
        description: template.description || 'No description',
        category: Array.isArray(template.category) ? template.category.join(', ') : template.category,
        keywords: template.triggers?.keywords?.join(', ') || 'none'
      }));

      const prompt = `You are an expert at matching user requests to task templates. You must be VERY SELECTIVE - only match templates when they closely align with the user's specific intent and requirements.

User Message: "${message}"
Context: ${context?.messageType || 'chat'} message from user ${context?.userId || 'unknown'}

Available Templates:
${templateDescriptions.map((t, i) => 
    `${i + 1}. ID: ${t.id}
   Name: ${t.name}
   Description: ${t.description}
   Category: ${t.category}
   Keywords: ${t.keywords}`
  ).join('\n\n')}

CRITICAL INSTRUCTIONS:
1. Analyze the user's SPECIFIC requirements, data sources, and output goals
2. Only match if the template can fulfill the EXACT request (not just similar category)
3. Be VERY STRICT - prefer "none" over forcing a poor match
4. Consider: data scope, analysis type, output format, business logic
5. Return ONLY a JSON object with this exact format:

{
  "templateId": "exact_matching_template_id_or_null",
  "confidence": "high|medium|none",
  "reasoning": "detailed explanation of match quality or why no suitable template exists"
}

MATCHING CRITERIA:
- "high": Template can fulfill the EXACT request with minor parameter changes
- "medium": Template covers 80%+ of requirements with clear modification path
- "none": No template matches the specific requirements (prefer this when in doubt)

IMPORTANT: When user asks for NEW analysis types, data combinations, or report formats not covered by existing templates, return "none" to enable agentic generation of custom solutions.

Return ONLY the JSON, no other text.`;

      const response = await genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });

      // Use centralized response extraction
      const responseText = extractGeminiText(response);

      // Parse AI response
      let aiResult;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in AI response');
        }
        aiResult = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        logger.warn('Failed to parse AI template selection response', {
          response: responseText.substring(0, 200),
          error: parseError.message
        });
        return null;
      }

      // Validate AI result
      if (!aiResult.templateId || aiResult.confidence === 'none') {
        logger.info('AI determined no suitable template match', {
          reasoning: aiResult.reasoning,
          confidence: aiResult.confidence
        });
        return null;
      }

      // Find the selected template
      const selectedTemplate = templates.find(t => t.templateId === aiResult.templateId);
      if (!selectedTemplate) {
        logger.warn('AI selected invalid template ID', {
          selectedId: aiResult.templateId,
          availableIds: templates.map(t => t.templateId)
        });
        return null;
      }

      // Add AI metadata to template
      selectedTemplate.aiConfidence = aiResult.confidence;
      selectedTemplate.aiReasoning = aiResult.reasoning;

      logger.info('AI template selection successful', {
        templateId: selectedTemplate.templateId,
        confidence: aiResult.confidence,
        reasoning: aiResult.reasoning,
        message: message.substring(0, 100)
      });

      return selectedTemplate;

    } catch (error) {
      logger.error('AI template selection failed', {
        error: error.message,
        message: message.substring(0, 100)
      });
      return null;
    }
  }

  /**
   * Fallback regex-based template matching
   * @param {string} message - User message
   * @param {Object} context - Message context
   * @param {Array} templates - Available templates
   * @returns {Object|null} - Matching template or null
   */
  async findTemplateByRegexFallback(message, context, templates) {
    try {
      // Score templates by relevance using regex patterns
      const scored = templates.map(template => ({
        template,
        score: this.calculateRelevanceScore(template, message, context)
      }));
      
      // Sort by score and return best match
      scored.sort((a, b) => b.score - a.score);
      
      logger.info('Regex fallback template scoring results', {
        message: message.substring(0, 100),
        scores: scored.slice(0, 3).map(s => ({ 
          name: s.template.name, 
          score: s.score,
          templateId: s.template.templateId
        }))
      });
      
      if (scored[0]?.score > 0.3) {
        logger.info('Template matched by regex fallback', {
          templateId: scored[0].template.templateId,
          score: scored[0].score,
          message: message.substring(0, 100)
        });
        return scored[0].template;
      }
      
      return null;
    } catch (error) {
      logger.error('Regex fallback template matching failed', { error: error.message });
      return null;
    }
  }

  /**
   * Calculate relevance score for template matching
   * @param {Object} template - Template configuration
   * @param {string} message - User message
   * @param {Object} context - Message context
   * @returns {number} - Relevance score (0-1)
   */
  calculateRelevanceScore(template, message, context) {
    let score = 0;
    
    if (!template.triggers) {
      logger.debug('Template has no triggers', { templateId: template.templateId });
      return 0;
    }
    
    // Pattern matching (60% weight - increased for direct asks)
    let patternsMatched = 0;
    if (template.triggers.patterns) {
      for (const patternStr of template.triggers.patterns) {
        try {
          // Convert string to RegExp if it's not already
          const pattern = typeof patternStr === 'string' ? new RegExp(patternStr, 'i') : patternStr;
          if (pattern.test(message)) {
            patternsMatched++;
            logger.info('Pattern matched', { 
              templateId: template.templateId, 
              pattern: patternStr, 
              message: message.substring(0, 50) 
            });
          }
        } catch (error) {
          logger.warn('Invalid regex pattern in template', { 
            templateId: template.templateId, 
            pattern: patternStr 
          });
        }
      }
      
      // Calculate pattern score: 0.6 for first match, +0.1 for each additional match
      if (patternsMatched > 0) {
        score += Math.min(0.6 + ((patternsMatched - 1) * 0.1), 0.8);
        logger.info('Pattern scoring', {
          templateId: template.templateId,
          patternsMatched,
          patternScore: Math.min(0.6 + ((patternsMatched - 1) * 0.1), 0.8)
        });
      }
    }
    
    // Keyword matching (30% weight)
    if (template.triggers.keywords && template.triggers.keywords.length > 0) {
      const messageWords = message.toLowerCase().split(/\s+/);
      const keywordMatches = template.triggers.keywords.filter(keyword => 
        messageWords.some(word => word.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(word))
      );
      // Enhanced keyword scoring: minimum 0.15 for any matches, up to 0.25
      const keywordRatio = keywordMatches.length / template.triggers.keywords.length;
      const keywordScore = keywordMatches.length > 0 ? Math.max(0.15, keywordRatio * 0.25) : 0;
      score += keywordScore;
      
      logger.info('Keyword matching debug', {
        templateId: template.templateId,
        message: message,
        messageWords,
        availableKeywords: template.triggers.keywords,
        matchedKeywords: keywordMatches,
        keywordScore,
        totalScore: score
      });
    }
    
    // Context matching disabled - universal templates should work everywhere
    // if (template.triggers.contexts && context.category) {
    //   if (template.triggers.contexts.includes(context.category)) {
    //     score += 0.15;
    //   }
    // }
    
    // Direct ask bonus (10% weight)
    const directAskPatterns = [
      /^generate.*report/i,
      /^create.*report/i,
      /^show.*me.*report/i,
      /^run.*report/i,
      /^make.*report/i
    ];
    
    if (directAskPatterns.some(pattern => pattern.test(message.trim()))) {
      score += 0.1;
      logger.info('Direct ask bonus applied', {
        templateId: template.templateId,
        message: message.substring(0, 50)
      });
    }
    
    logger.info('Final template score calculated', {
      templateId: template.templateId,
      finalScore: Math.min(score, 1.0),
      message: message.substring(0, 50)
    });
    
    return Math.min(score, 1.0);
  }

  /**
   * Load all active templates
   * @returns {Array} - Array of template configurations
   */
  async loadActiveTemplates() {
    try {
      const templates = await this.templatesModel.getActiveTemplates();
      logger.info('Active templates loaded', { count: templates.length });
      return templates;
    } catch (error) {
      logger.error('Failed to load active templates', { error: error.message });
      return [];
    }
  }

  /**
   * Validate and prepare executionScript for storage/compilation
   * Catches compilation errors and auto-escapes template literals
   * @param {string} executionScript - Script code to validate
   * @param {string} templateId - Template identifier for logging
   * @returns {Object} - Validation result with prepared script
   */
  async validateAndPrepareScript(executionScript, templateId) {
    // CRITICAL: Define Script outside try blocks so it's accessible in both
    const Script = require('vm').Script;

    try {
      // Try to compile the script as-is
      new Script(executionScript);

      logger.info('Script validated successfully without modifications', {
        templateId,
        scriptLength: executionScript.length
      });

      return {
        valid: true,
        script: executionScript,
        escaped: false,
        message: 'Script compiled successfully'
      };
    } catch (error) {
      // Compilation failed - try auto-escaping template literals
      logger.warn('Script compilation failed, attempting auto-escape', {
        templateId,
        error: error.message,
        errorLine: this.extractErrorLine(error.stack)
      });

      // Escape backticks in template literals
      const escapedScript = this.autoEscapeTemplateLiterals(executionScript);

      try {
        new Script(escapedScript);

        logger.info('Script auto-escaped successfully', {
          templateId,
          originalLength: executionScript.length,
          escapedLength: escapedScript.length,
          originalError: error.message
        });

        return {
          valid: true,
          script: escapedScript,
          escaped: true,
          originalError: error.message,
          message: 'Script was auto-escaped to fix template literal syntax'
        };
      } catch (escapeError) {
        // Even escaping didn't work - script has deeper issues
        const lines = executionScript.split('\n');
        const errorLineMatch = escapeError.message.match(/line (\d+)/i) || error.message.match(/line (\d+)/i);
        const errorLineNum = errorLineMatch ? parseInt(errorLineMatch[1]) - 1 : 18; // Default to line 19

        // Get 5 lines of context around the error
        const contextStart = Math.max(0, errorLineNum - 2);
        const contextEnd = Math.min(lines.length, errorLineNum + 3);
        const errorContext = lines.slice(contextStart, contextEnd).map((line, idx) => {
          const lineNum = contextStart + idx + 1;
          const marker = lineNum === errorLineNum + 1 ? ' ❌ ' : '    ';
          return `${marker}${lineNum}: ${line}`;
        }).join('\n');

        logger.error('Script validation failed even after auto-escape', {
          templateId,
          originalError: error.message,
          escapeError: escapeError.message,
          errorLine: errorLineNum + 1,
          scriptLength: executionScript.length,
          // Show 5 lines of context around the error for debugging
          errorContext: `\n${errorContext}`
        });

        return {
          valid: false,
          script: executionScript,
          error: escapeError.message,
          originalError: error.message,
          message: `Script compilation failed: ${escapeError.message}`
        };
      }
    }
  }

  /**
   * Auto-escape template literals inside executionScript
   * Fixes common backtick issues in updateProgress, log calls, etc.
   * @param {string} script - Original script
   * @returns {string} - Script with escaped backticks
   */
  autoEscapeTemplateLiterals(script) {
    let fixed = script;

    // Pattern 1: updateProgress with template literals
    // Matches: updateProgress(20, `Fetching ${count} items`)
    fixed = fixed.replace(
      /updateProgress\s*\(\s*(\d+)\s*,\s*`([^`]*\$\{[^}]*\}[^`]*)`\s*\)/g,
      (match, percent, message) => {
        // Keep the template literal but ensure inner backticks are escaped
        // This preserves ${} interpolation while fixing syntax
        return `updateProgress(${percent}, \`${message}\`)`;  // Fixed: added closing )
      }
    );

    // Pattern 2: this.log() with template literals
    // Matches: this.log('info', `Processing ${count} items`, { data })
    fixed = fixed.replace(
      /this\.log\s*\(\s*['"](\w+)['"]\s*,\s*`([^`]*)`/g,
      (match, level, message) => {
        return `this.log('${level}', \`${message}\``;
      }
    );

    // Pattern 3: Simple backtick strings without interpolation that should be single quotes
    // Matches: `text` (no ${}) → 'text'
    fixed = fixed.replace(
      /`([^`$]*)`(?![{])/g,
      (match, content) => {
        // Only convert to single quotes if there's no ${} interpolation
        if (!content.includes('${')) {
          return `'${content}'`;
        }
        return match;
      }
    );

    return fixed;
  }

  /**
   * Extract error line from stack trace
   * @param {string} stack - Error stack trace
   * @returns {string} - Formatted error line info
   */
  extractErrorLine(stack) {
    if (!stack) return 'unknown';

    const match = stack.match(/evalmachine\.<anonymous>:(\d+)/);
    if (match) {
      return `line ${match[1]}`;
    }

    return 'unable to extract line number';
  }

  /**
   * Validate template structure with auto-repair capability
   * @param {Object} template - Template to validate
   * @param {Object} originalRequest - Original user request for context
   * @param {number} repairAttempt - Current repair attempt (0 = first validation)
   * @returns {Object} - Validation result with optional repaired template
   */
  async validateTemplate(template, originalRequest = null, repairAttempt = 0) {
    try {
      const errors = [];
      const warnings = [];
      const detailedErrors = [];
      
      // Required fields validation
      if (!template.templateId) {errors.push('templateId is required');}
      if (!template.name) {errors.push('name is required');}
      if (!template.executionScript) {errors.push('executionScript is required');}
      
      // Enhanced execution script validation with detailed feedback
      if (template.executionScript) {
        // Basic script structure
        if (!template.executionScript.includes('class') || 
            !template.executionScript.includes('extends BaseTaskExecutor')) {
          errors.push('executionScript must contain a class extending BaseTaskExecutor');
          detailedErrors.push({
            type: 'missing_base_class',
            message: 'Execution script must define a class that extends BaseTaskExecutor',
            fix: 'Add: class YourTaskExecutor extends BaseTaskExecutor { ... }'
          });
        }

        // Check for mandatory methods
        const mandatoryMethods = [
          { name: 'updateProgress', pattern: /updateProgress\s*\(/, description: 'Progress reporting method' },
          { name: 'callAPI', pattern: /callAPI\s*\(/, description: 'Bitrix24 API call method' }
        ];

        // CRITICAL: Check for generateHTMLReport METHOD DEFINITION (not just usage)
        // This ensures templates override the method instead of calling the base class method
        const hasGenerateHTMLReportMethod = /(?:async\s+)?generateHTMLReport\s*\(/.test(template.executionScript);
        if (!hasGenerateHTMLReportMethod) {
          errors.push('executionScript must implement generateHTMLReport() method');
          detailedErrors.push({
            type: 'missing_method_override',
            method: 'generateHTMLReport',
            message: 'CRITICAL: Missing generateHTMLReport() method implementation. Templates MUST override this method with custom HTML generation.',
            description: 'Templates must implement their own generateHTMLReport(reportData, params) method that returns complete HTML',
            fix: 'Add: async generateHTMLReport(reportData, params) { return "<html>...</html>"; } inside your class'
          });
        }

        for (const method of mandatoryMethods) {
          if (!method.pattern.test(template.executionScript)) {
            errors.push(`executionScript must use ${method.name}() method`);
            detailedErrors.push({
              type: 'missing_method',
              method: method.name,
              message: `Missing mandatory method: ${method.name}()`,
              description: method.description,
              fix: `Add calls to this.${method.name}() in your execution logic`
            });
          }
        }

        // Check for proper logging usage
        if (template.executionScript.includes('logger.') && !template.executionScript.includes('this.log(')) {
          errors.push('executionScript must use this.log() instead of logger directly');
          detailedErrors.push({
            type: 'incorrect_logging',
            message: 'Use this.log() method instead of direct logger access',
            fix: 'Replace logger.info() with this.log("info", "message", { data })'
          });
        }
      }
      
      const isValid = errors.length === 0;
      
      // If validation failed and we have original request context, attempt auto-repair
      if (!isValid && originalRequest && repairAttempt < 2) {
        logger.warn('Template validation failed, attempting auto-repair', {
          templateId: template.templateId,
          errors: errors,
          repairAttempt: repairAttempt + 1
        });

        const repairedTemplate = await this.repairTemplateWithAI(template, detailedErrors, originalRequest, repairAttempt + 1);
        if (repairedTemplate) {
          // Validate the repaired template
          return await this.validateTemplate(repairedTemplate, originalRequest, repairAttempt + 1);
        }
      }
      
      return {
        valid: isValid,
        errors,
        warnings,
        detailedErrors,
        template: template, // Return original template if no repair was done
        repairAttempt
      };
    } catch (error) {
      return {
        valid: false,
        errors: [`Validation error: ${error.message}`],
        warnings: [],
        detailedErrors: [{
          type: 'validation_exception',
          message: error.message,
          fix: 'Check template structure and fix syntax errors'
        }],
        template: template,
        repairAttempt
      };
    }
  }

  /**
   * Auto-repair template using AI feedback
   * @param {Object} template - Original template with validation errors
   * @param {Array} detailedErrors - Detailed validation errors
   * @param {Object} originalRequest - Original user request
   * @param {number} repairAttempt - Current repair attempt
   * @returns {Object|null} - Repaired template or null if repair failed
   */
  async repairTemplateWithAI(template, detailedErrors, originalRequest, repairAttempt) {
    try {
      const genAI = getGeminiClient();
      if (!genAI) {
        logger.warn('Gemini client not available for template repair');
        return null;
      }

      // Build detailed feedback for Gemini
      const errorSummary = detailedErrors.map(error =>
        `- ${error.type}: ${error.message}\n  Fix: ${error.fix}`
      ).join('\n');

      const repairPrompt = `You are a code repair specialist. A JavaScript execution script for a complex task has validation errors that need to be fixed.

ORIGINAL USER REQUEST: "${originalRequest.message || originalRequest}"

CURRENT EXECUTION SCRIPT (with errors):
\`\`\`javascript
${template.executionScript}
\`\`\`

VALIDATION ERRORS TO FIX:
${errorSummary}

CRITICAL REQUIREMENTS - YOU MUST INCLUDE ALL OF THESE:
1. **updateProgress()**: Call this.updateProgress(percentage, message) regularly
2. **callAPI()**: Use this.callAPI(method, params) for all Bitrix24 API calls  
3. **generateHTMLReport()**: MANDATORY - Must call this.generateHTMLReport() and return HTML
4. **Proper Logging**: Use this.log('info', 'message', { data }) instead of logger.info()
5. **Class Structure**: Must extend BaseTaskExecutor with proper constructor

EXAMPLE PATTERN TO FOLLOW:
\`\`\`javascript
class TaskExecutor extends BaseTaskExecutor {
  async execute() {
    await this.updateProgress(0, 'Starting task...');
    
    // Your business logic here
    const data = await this.callAPI('method.name', { params });
    
    await this.updateProgress(50, 'Processing data...');
    
    // Process data...
    
    await this.updateProgress(90, 'Generating report...');
    
    const htmlReport = await this.generateHTMLReport(results);
    
    await this.updateProgress(100, 'Task completed');
    
    return {
      success: true,
      htmlReport: htmlReport,
      summary: 'Task completed successfully'
    };
  }
  
  async generateHTMLReport(data) {
    // MANDATORY METHOD - Must be implemented
    return '<html>...</html>';
  }
}
\`\`\`

Return ONLY the corrected execution script, no explanations. The script must fix ALL validation errors listed above.`;

      const response = await genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
        config: {
          maxOutputTokens: 65535,
          temperature: 0.1
        }
      });

      // Use centralized response extraction
      const repairedScript = extractGeminiText(response);

      if (!repairedScript || repairedScript.length < 100) {
        logger.error('AI repair failed - no valid response', {
          templateId: template.templateId,
          repairAttempt,
          responseLength: repairedScript.length
        });
        return null;
      }

      // Clean the response (remove markdown formatting if present)
      let cleanedScript = repairedScript;
      if (cleanedScript.includes('```javascript')) {
        const match = cleanedScript.match(/```javascript\n([\s\S]*?)\n```/);
        if (match) {
          cleanedScript = match[1];
        }
      } else if (cleanedScript.includes('```')) {
        const match = cleanedScript.match(/```\n([\s\S]*?)\n```/);
        if (match) {
          cleanedScript = match[1];
        }
      }

      logger.info('AI template repair completed', {
        templateId: template.templateId,
        repairAttempt,
        originalLength: template.executionScript.length,
        repairedLength: cleanedScript.length,
        errorsFixed: detailedErrors.length
      });

      // Return repaired template
      return {
        ...template,
        executionScript: cleanedScript,
        lastRepaired: new Date().toISOString(),
        repairAttempt
      };

    } catch (error) {
      logger.error('AI template repair failed', {
        templateId: template.templateId,
        repairAttempt,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Repair template based on execution error context
   * @param {Object} template - Original template that failed
   * @param {Object} errorContext - Detailed error context from execution
   * @returns {Object|null} - Repaired template or null if repair failed
   */
  async repairTemplateFromExecutionError(template, errorContext) {
    try {
      // Safety: Check repair limits using circuit breaker
      const taskId = errorContext.taskId;
      const templateId = template.templateId;

      const repairCheck = await this.repairTracker.canRepair(taskId, templateId);
      if (!repairCheck.allowed) {
        logger.warn('Auto-repair blocked by circuit breaker', {
          templateId,
          taskId,
          reason: repairCheck.reason
        });
        return null;
      }

      const genAI = getGeminiClient();
      if (!genAI) {
        logger.warn('Gemini client not available for runtime repair');
        return null;
      }

      // Load knowledge base content for API endpoint constraints
      const knowledgeBaseContent = await this.loadKnowledgeBaseForRepair();

      // ===== Phase 2.2: Retrieve relevant memories from past executions =====
      let relevantMemoriesSection = '';
      let usedRepairMemoryIds = []; // Track which memories were used for repair
      // Check if reasoning memory is enabled via feature flags
      const { getConfigManager } = require('./dashboard/configManager');
      const configManager = await getConfigManager();
      const reasoningMemoryEnabled = await configManager.get('feature-flags', 'REASONING_MEMORY_ENABLED');
      if (reasoningMemoryEnabled) {
        try {
          const embeddingService = require('../services/embeddingService');
          const { getReasoningMemoryModel } = require('../models/reasoningMemory');
          const memoryModel = getReasoningMemoryModel();

          // Build query from error context
          const queryText = `${errorContext.templateName}: ${errorContext.error.type} - ${errorContext.error.message}`;

          // Generate embedding for the error query
          const queryEmbedding = await embeddingService.embedQuery(queryText, 'RETRIEVAL_QUERY');

          // Retrieve top-K similar memories (focus on error_pattern and fix_strategy)
          const topK = config.MEMORY_RETRIEVAL_TOP_K || 5;
          const minSuccessRate = config.MEMORY_MIN_SUCCESS_RATE || 0.5;

          const memories = await memoryModel.retrieveMemories(queryEmbedding, topK, {
            categories: ['error_pattern', 'fix_strategy'], // Focus on repair-relevant memories
            minSuccessRate: minSuccessRate
          });

          if (memories && memories.length > 0) {
            // Store memory IDs for success tracking
            usedRepairMemoryIds = memories.map(m => m.id);

            // Format memories for inclusion in repair prompt
            const memoriesText = memories.map((memory, index) => {
              return `${index + 1}. **${memory.title}** (Category: ${memory.category}, Similarity: ${(memory.similarityScore * 100).toFixed(1)}%, Success Rate: ${memory.successRate ? (memory.successRate * 100).toFixed(0) + '%' : 'N/A'})
   Problem: ${memory.description}
   Solution: ${memory.content}
   Source: ${memory.source}
   ${memory.timesRetrieved > 3 ? `(Frequently referenced: ${memory.timesRetrieved} times)` : ''}`;
            }).join('\n\n');

            relevantMemoriesSection = `
RELEVANT MEMORIES FROM PAST ERRORS AND FIXES:
Based on similar errors encountered previously, here are proven strategies that helped resolve them:

${memoriesText}

**INSTRUCTION**: Review these past error patterns and fixes CAREFULLY. If the current error matches a known pattern, apply the proven fix strategy. If it's a new error, add defensive programming based on similar cases.
`;

            logger.info('Retrieved relevant memories for repair prompt', {
              templateId: errorContext.templateId,
              errorType: errorContext.error.type,
              memoriesRetrieved: memories.length,
              memoryIds: usedRepairMemoryIds,
              categories: [...new Set(memories.map(m => m.category))],
              avgSuccessRate: (memories.reduce((sum, m) => sum + (m.successRate || 0), 0) / memories.length).toFixed(2),
              topSimilarity: memories[0]?.similarityScore
            });
          } else {
            logger.debug('No relevant memories found for repair', {
              templateId: errorContext.templateId,
              errorType: errorContext.error.type
            });
          }
        } catch (memoryError) {
          logger.error('Failed to retrieve memories for repair', {
            error: memoryError.message,
            templateId: errorContext.templateId
          });
          // Continue with repair without memories
        }
      }
      // ===== End Phase 2.2 memory retrieval =====

      // ===== Phase 2.3: Extract error context for visual debugging =====
      // Extract 5 lines of context around the error line to help Gemini focus
      let errorContextSection = '';
      try {
        const lines = template.executionScript.split('\n');
        let errorLineNum = null;

        // Check if this is an API validation error (AxiosError with 400/404 status)
        const isApiError = errorContext.error.type === 'AxiosError' ||
                          errorContext.error.message?.includes('Request failed with status code') ||
                          errorContext.error.message?.includes('required field') ||
                          errorContext.error.message?.includes('method not found');

        if (isApiError) {
          // For API errors, find the callAPI() line that caused the error
          logger.info('Detected API validation error, searching for callAPI() in template', {
            templateId: template.templateId,
            errorMessage: errorContext.error.message
          });

          // Try to extract the API method from error context or logs
          let apiMethod = null;

          // Check executionContext for the failed method
          if (errorContext.executionContext?.lastApiCall) {
            apiMethod = errorContext.executionContext.lastApiCall;
          }

          // Also check error message for method name
          const methodMatch = errorContext.error.message?.match(/method:\s*['"]?([a-z._]+)['"]?/i);
          if (methodMatch) {
            apiMethod = methodMatch[1];
          }

          if (apiMethod) {
            // Search template for the line containing this API call
            const apiCallPattern = new RegExp(`callAPI\\s*\\(\\s*['"\`]${apiMethod.replace('.', '\\.')}['"\`]`, 'i');
            for (let i = 0; i < lines.length; i++) {
              if (apiCallPattern.test(lines[i])) {
                errorLineNum = i;
                logger.info('Found callAPI() line for failed API method', {
                  templateId: template.templateId,
                  apiMethod,
                  lineNumber: i + 1,
                  lineContent: lines[i].substring(0, 100)
                });
                break;
              }
            }
          }

          // If we couldn't find the specific method, look for ANY callAPI in recent lines
          if (errorLineNum === null) {
            const genericCallAPIPattern = /callAPI\s*\(/;
            for (let i = lines.length - 1; i >= 0; i--) {
              if (genericCallAPIPattern.test(lines[i])) {
                errorLineNum = i;
                logger.info('Found generic callAPI() line for API error', {
                  templateId: template.templateId,
                  lineNumber: i + 1,
                  lineContent: lines[i].substring(0, 100)
                });
                break;
              }
            }
          }
        } else {
          // For syntax/compilation errors, extract from stack trace
          // Filter out node_modules paths to avoid pointing to library code
          const stackLines = errorContext.error.stack?.split('\n') || [];
          let templateLineMatch = null;

          for (const stackLine of stackLines) {
            // Skip lines that reference node_modules
            if (stackLine.includes('node_modules')) {
              continue;
            }

            // Try to extract line number from template code
            const lineMatch = stackLine.match(/at [^(]*\(.*:(\d+):\d+\)/) ||
                             stackLine.match(/evalmachine\.<anonymous>:(\d+)/) ||
                             stackLine.match(/:(\d+):\d+/);

            if (lineMatch) {
              templateLineMatch = lineMatch;
              break;
            }
          }

          // Also check error message for line number
          const messageLineMatch = errorContext.error.message?.match(/line (\d+)/i);

          if (templateLineMatch) {
            errorLineNum = parseInt(templateLineMatch[1]) - 1; // Convert to 0-indexed
          } else if (messageLineMatch) {
            errorLineNum = parseInt(messageLineMatch[1]) - 1;
          }
        }

        if (errorLineNum !== null && errorLineNum >= 0 && errorLineNum < lines.length) {
          const contextStart = Math.max(0, errorLineNum - 2);
          const contextEnd = Math.min(lines.length, errorLineNum + 3);

          const codeContext = lines.slice(contextStart, contextEnd).map((line, idx) => {
            const lineNum = contextStart + idx + 1;
            const marker = lineNum === errorLineNum + 1 ? ' ❌ ' : '    ';
            return `${marker}${lineNum}: ${line}`;
          }).join('\n');

          errorContextSection = `
ERROR LOCATION (5 lines of context):
\`\`\`javascript
${codeContext}
\`\`\`

`;

          logger.info('Extracted error context for repair prompt', {
            templateId: template.templateId,
            errorType: isApiError ? 'API_ERROR' : 'SYNTAX_ERROR',
            errorLine: errorLineNum + 1,
            contextLines: contextEnd - contextStart
          });
        } else {
          logger.warn('Could not extract specific error line, skipping context', {
            templateId: template.templateId,
            errorType: errorContext.error.type,
            stackAvailable: !!errorContext.error.stack
          });
        }
      } catch (contextError) {
        logger.warn('Failed to extract error context for repair prompt', {
          templateId: template.templateId,
          error: contextError.message
        });
        // Continue without error context - not critical
      }
      // ===== End Phase 2.3 error context extraction =====

      const errorRepairPrompt = `You are an expert code repair specialist. A JavaScript execution script failed during testing and needs to be fixed based on the error context.

${knowledgeBaseContent}

TASK INFORMATION:
- Task ID: ${errorContext.taskId}
- Template: ${errorContext.templateName} (${errorContext.templateId})
- Original Request: ${errorContext.originalUserRequest}

EXECUTION ERROR:
- Type: ${errorContext.error.type}
- Message: ${errorContext.error.message}
- Failed at Step: ${errorContext.error.step}
- Execution Progress: ${errorContext.executionContext.stepsCompleted} steps completed

${errorContextSection}ERROR STACK TRACE:
\`\`\`
${errorContext.error.stack}
\`\`\`

CURRENT EXECUTION SCRIPT (with errors):
\`\`\`javascript
${template.executionScript}
\`\`\`

EXECUTION CONTEXT:
- Current Step: ${errorContext.executionContext.currentStep}
- Parameters: ${JSON.stringify(errorContext.executionContext.parameters, null, 2)}
- Resource Usage: ${JSON.stringify(errorContext.executionContext.resourceUsage, null, 2)}

${relevantMemoriesSection}

REPAIR INSTRUCTIONS:
1. **CRITICAL: Validate API Endpoints**: Before using ANY Bitrix24 endpoint, verify it exists in the allowed list above
2. **Fix Hallucinated Endpoints**: Replace ANY non-existent endpoints with documented alternatives:
   - crm.invoice.productrows.get → USE 3-STEP PATTERN: crm.invoice.list → crm.invoice.get → crm.product.get
   - crm.invoice.items.list → USE 3-STEP PATTERN: crm.invoice.list → crm.invoice.get → crm.product.get  
   - crm.smart_invoice.list → crm.invoice.list (smart invoices don't exist)
   - CRITICAL: crm.invoice.list does NOT return PRODUCT_ROWS - use crm.invoice.get for each invoice
3. **Analyze the Error**: Understand what went wrong and why
4. **Fix the Root Cause**: Address the specific issue that caused the failure
5. **Maintain Functionality**: Keep all existing working code intact
6. **Add Error Handling**: Include try-catch blocks around problematic areas
7. **Validate Data**: Add null checks and validation where needed
8. **MANDATORY METHODS**: Ensure all required methods are present and called:
   - updateProgress() - called regularly with percentage and messages
   - callAPI() - used for all Bitrix24 API calls
   - generateHTMLReport() - MUST be called and return HTML
   - this.log() - use instead of console.log or logger

CRITICAL: API ENDPOINT ERRORS (404/NOT FOUND):
If the error involves API endpoints returning 404 or "method not found":
1. **STOP**: Check if the endpoint exists in the 17 allowed endpoints listed above
2. **REPLACE**: Use documented alternatives for hallucinated endpoints
3. **VERIFY**: Ensure the endpoint appears in the whitelist before proceeding
4. **NEVER**: Invent new endpoints or assume they exist

COMMON ERROR FIXES:
- **"generateHTMLReport is not a function"**: Add the generateHTMLReport method implementation inside the class
- **API 404 Errors**: Replace hallucinated endpoints with documented ones
- **PRODUCT_ROWS Errors**: Use 3-step pattern (list → get → product.get) instead of trying to get PRODUCT_ROWS from crm.invoice.list
- **No Product Data**: Check if using crm.invoice.list incorrectly - switch to crm.invoice.get for each invoice
- **Undefined/Null Errors**: Add proper null checks and default values
- **API Errors**: Add retry logic and better error handling
- **Type Errors**: Validate data types before processing
- **Async Errors**: Ensure proper await usage and Promise handling
- **Method Missing**: Add missing method implementations
- **Scope Errors**: Fix variable scoping and context issues

CRITICAL: log.blogpost.add 400 ERROR FIX - REMOVE HALLUCINATED PARAMETERS:
If the error involves log.blogpost.add with 400 errors like:
- "No destination specified"
- "Conversation cannot be addressed to all, please specify at least one recipient"
- "SONET_CONTROLLER_LIVEFEED_BLOGPOST_ADD_ERROR"

**THE FIX: REMOVE ALL HALLUCINATED PARAMETERS**
The ONLY valid parameters for log.blogpost.add are:
1. POST_TITLE - the post title
2. POST_MESSAGE - the post content
3. CATEGORY_ID (optional) - category ID
4. FILES (optional) - file IDs

**DO NOT INCLUDE:**
- DEST - DOES NOT EXIST, REMOVE IT
- ENABLE_COMMENTS - DOES NOT EXIST, REMOVE IT
- SPERM - DOES NOT EXIST, REMOVE IT
- Any other parameters - REMOVE THEM

\`\`\`javascript
// ❌ WRONG - hallucinated parameters cause 400 errors
await this.callAPI('log.blogpost.add', {
  POST_TITLE: title,
  POST_MESSAGE: message,
  DEST: ['UA'],              // ← HALLUCINATED - REMOVE
  DEST: ['DR0'],             // ← HALLUCINATED - REMOVE
  ENABLE_COMMENTS: 'Y',      // ← HALLUCINATED - REMOVE
  SPERM: ['UA']              // ← HALLUCINATED - REMOVE
});

// ✅ CORRECT - only real parameters
await this.callAPI('log.blogpost.add', {
  POST_TITLE: title,
  POST_MESSAGE: message
  // That's it. Bot post appears organization-wide automatically.
  // NO OTHER PARAMETERS NEEDED.
});
\`\`\`

**MANDATORY**: Search the script for ANY log.blogpost.add calls and remove ALL parameters except POST_TITLE, POST_MESSAGE, CATEGORY_ID, and FILES.

CRITICAL: NULL POINTER BUG DETECTION AND PREVENTION
If the error involves "ID is not defined or invalid", "Cannot read property of null", "undefined is not an object", or similar null/undefined errors:

**STEP 1: IDENTIFY THE NULL POINTER PATTERN**
Look for code that uses data without checking if it exists first:
\`\`\`javascript
// ❌ BUGGY PATTERN - No null check before API call
const contact_id = invoice.get("UF_CONTACT_ID");
const contact = await this.callAPI("crm.contact.get", { ID: contact_id });

// ❌ BUGGY PATTERN - Assuming field always exists
const company_id = deal.UF_COMPANY_ID;
const company = await this.callAPI("crm.company.get", { ID: company_id });

// ❌ BUGGY PATTERN - No validation before processing
const items = response.PRODUCT_ROWS;
for (const item of items) { // Crashes if items is null/undefined
  // process item...
}
\`\`\`

**STEP 2: ADD DEFENSIVE NULL CHECKS**
Always validate data exists before using it in API calls or loops:
CRITICAL: For invoices, ALWAYS check CONTACT_ID FIRST, then fall back to COMPANY_ID if needed.
\`\`\`javascript
// ✅ FIXED PATTERN - Check CONTACT_ID first (primary), then COMPANY_ID (fallback)
const contact_id = invoice.get("UF_CONTACT_ID");
if (contact_id) {
  const contact = await this.callAPI("crm.contact.get", { ID: contact_id });
  // Process contact data...
} else {
  this.log('warn', 'Invoice has no contact ID', { invoiceId: invoice.get("ID") });
  // Try alternative: check for UF_COMPANY_ID as fallback
  const company_id = invoice.get("UF_COMPANY_ID");
  if (company_id) {
    const company = await this.callAPI("crm.company.get", { ID: company_id });
    // Use company data as fallback...
  }
}

// ✅ FIXED PATTERN - Validate before loop
const items = response.PRODUCT_ROWS || [];
if (items.length > 0) {
  for (const item of items) {
    // Safely process item...
  }
} else {
  this.log('warn', 'No product rows found', { invoiceId: response.ID });
}

// ✅ FIXED PATTERN - Safe property access with default
const userId = data?.userId || data?.UF_USER_ID || null;
if (userId) {
  const user = await this.callAPI("user.get", { ID: userId });
} else {
  this.log('warn', 'No user ID available');
}
\`\`\`

**STEP 3: ADD TRY-CATCH FOR API CALLS WITH NULL IDS**
Even with null checks, wrap API calls in try-catch for extra safety:
\`\`\`javascript
// ✅ BEST PRACTICE - Null check + try-catch
const company_id = invoice.get("UF_COMPANY_ID");
if (company_id) {
  try {
    const company = await this.callAPI("crm.company.get", { ID: company_id });
    // Process company data...
  } catch (error) {
    this.log('warn', 'Failed to fetch company', {
      companyId: company_id,
      error: error.message
    });
    // Continue with fallback logic...
  }
} else {
  this.log('info', 'Invoice has no company, checking for contact');
  // Fallback logic...
}
\`\`\`

**STEP 4: VALIDATE DATA BEFORE USING IN API PARAMETERS**
Create validation helpers for common patterns:
\`\`\`javascript
// ✅ VALIDATION HELPER PATTERN
const getValidId = (obj, ...fields) => {
  for (const field of fields) {
    const value = obj?.[field] || obj?.get?.(field);
    if (value && value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
};

// Usage:
const entityId = getValidId(invoice, "UF_COMPANY_ID", "COMPANY_ID", "UF_CONTACT_ID");
if (entityId) {
  // Safe to use in API call
} else {
  this.log('warn', 'No valid entity ID found', { invoiceId: invoice.get("ID") });
}
\`\`\`

**MANDATORY NULL CHECK LOCATIONS:**
1. Before ANY API call with an ID parameter (crm.*.get, user.get, etc.)
2. Before accessing properties on objects that might be null
3. Before iterating over arrays that might be undefined
4. Before using data extracted from API responses
5. Before calling methods on potentially null objects

**REPAIR REQUIREMENT:**
Scan the ENTIRE script for API calls like \`crm.company.get\`, \`crm.contact.get\`, \`crm.deal.get\`, etc.
For EACH call, verify there is a null check on the ID parameter BEFORE the API call is made.
If ANY call lacks a null check, ADD ONE using the patterns above.

CRITICAL FIX FOR "generateHTMLReport is not a function":
If you see this error, it means the class is calling this.generateHTMLReport() but the method doesn't exist.
SOLUTION: Add the generateHTMLReport method to the class:

\`\`\`javascript
class YourExecutor extends BaseTaskExecutor {
  async execute() {
    // ... existing code ...
    const report = await this.generateHTMLReport(data); // This calls the method below
    // ... rest of code ...
  }
  
  // ADD THIS METHOD to fix the error:
  async generateHTMLReport(data) {
    return \`<!DOCTYPE html>
<html>
<head><title>Report</title><script src="https://cdn.tailwindcss.com"></script></head>
<body><!-- Your HTML content here --></body>
</html>\`;
  }
}
\`\`\`

REPAIR REQUIREMENTS:
- Fix the specific error that occurred (especially API endpoint errors)
- Replace ANY non-existent endpoints with documented alternatives
- Add defensive programming practices
- Maintain the same class structure extending BaseTaskExecutor
- Include comprehensive error handling
- Add logging for debugging
- Test edge cases and error conditions
- Use ONLY the 17 allowed Bitrix24 endpoints listed above

FINAL VALIDATION:
Before returning the script, verify that ALL API calls use endpoints from the allowed list above.

Return ONLY the complete corrected execution script with the error fixed. No explanations or markdown formatting.`;

      const response = await genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: errorRepairPrompt }] }],
        config: {
          maxOutputTokens: 65535,
          temperature: 0.1
        }
      });

      // Use centralized response extraction
      const repairedScript = extractGeminiText(response);

      if (!repairedScript || repairedScript.length < 500) {
        logger.error('AI execution error repair failed - insufficient response', {
          templateId: template.templateId,
          errorType: errorContext.error.type,
          responseLength: repairedScript.length
        });
        return null;
      }

      // Clean the response (remove markdown formatting if present)
      let cleanedScript = repairedScript;
      if (cleanedScript.includes('```javascript')) {
        const match = cleanedScript.match(/```javascript\n([\s\S]*?)\n```/);
        if (match) {
          cleanedScript = match[1];
        }
      } else if (cleanedScript.includes('```')) {
        const match = cleanedScript.match(/```\n([\s\S]*?)\n```/);
        if (match) {
          cleanedScript = match[1];
        }
      }

      logger.info('AI execution error repair completed', {
        templateId: template.templateId,
        errorType: errorContext.error.type,
        errorStep: errorContext.error.step,
        originalLength: template.executionScript.length,
        repairedLength: cleanedScript.length
      });

      // CRITICAL: Validate the repaired script immediately to catch issues
      const validation = await this.validateAndPrepareScript(cleanedScript, template.templateId);
      if (!validation.valid) {
        // Extract error context for debugging
        const lines = cleanedScript.split('\n');
        const errorLineMatch = validation.error?.match(/line (\d+)/i);
        const errorLineNum = errorLineMatch ? parseInt(errorLineMatch[1]) - 1 : 0;
        const contextStart = Math.max(0, errorLineNum - 2);
        const contextEnd = Math.min(lines.length, errorLineNum + 3);
        const errorContext = lines.slice(contextStart, contextEnd).map((line, idx) => {
          const lineNum = contextStart + idx + 1;
          const marker = lineNum === errorLineNum + 1 ? ' ❌ ' : '    ';
          return `${marker}${lineNum}: ${line}`;
        }).join('\n');

        logger.error('Repaired script STILL has validation errors', {
          templateId: template.templateId,
          repairError: validation.error,
          errorLine: errorLineNum + 1,
          scriptLength: cleanedScript.length,
          errorContext: `\n${errorContext}`,
          knowledgeDocsUsed: 'See earlier log for KB document titles'
        });
        return null; // Repair failed - don't return invalid script
      }

      // Use the validated script (might be auto-escaped)
      cleanedScript = validation.script;

      logger.info('Repaired script validated successfully', {
        templateId: template.templateId,
        wasEscaped: validation.escaped
      });

      // Safety: Record repair for circuit breaker tracking
      try {
        // Estimate token cost: prompt + response (rough: 1 token ≈ 4 chars)
        const promptLength = errorRepairPrompt.length;
        const responseLength = repairedScript.length;
        const estimatedTokens = Math.ceil((promptLength + responseLength) / 4);

        await this.repairTracker.recordRepair(taskId, templateId, estimatedTokens);

        logger.info('Repair tracked in circuit breaker', {
          taskId,
          templateId,
          estimatedTokens
        });
      } catch (trackError) {
        logger.warn('Failed to record repair tracking', {
          taskId,
          templateId,
          error: trackError.message
        });
      }

      // ✅ PHASE 3.2: Track memory impact after repair
      // If template was generated using memories, mark them as less successful since repair was needed
      if (config.REASONING_MEMORY_ENABLED && template.generationMetadata?.memoryIdsUsed && template.generationMetadata.memoryIdsUsed.length > 0) {
        try {
          const { getReasoningMemoryModel } = require('../models/reasoningMemory');
          const memoryModel = getReasoningMemoryModel();

          // Mark generation memories as "unsuccessful" because they led to code that needed repair
          for (const memoryId of template.generationMetadata.memoryIdsUsed) {
            await memoryModel.updateMemoryStats([memoryId], false); // false = unsuccessful
          }

          logger.info('Updated generation memory statistics after repair', {
            templateId: template.templateId,
            memoriesMarkedUnsuccessful: template.generationMetadata.memoryIdsUsed.length,
            reason: 'Template needed repair, indicating imperfect generation'
          });
        } catch (memoryError) {
          logger.warn('Failed to update generation memory statistics after repair', {
            templateId: template.templateId,
            error: memoryError.message
          });
        }
      }

      // ✅ PHASE 3.3: Track repair memory success
      // If repair used memories, mark them as successful since repair completed successfully
      if (config.REASONING_MEMORY_ENABLED && usedRepairMemoryIds.length > 0) {
        try {
          const { getReasoningMemoryModel } = require('../models/reasoningMemory');
          const memoryModel = getReasoningMemoryModel();

          // Mark repair memories as "successful" because they helped fix the error
          await memoryModel.updateMemoryStats(usedRepairMemoryIds, true); // true = successful

          logger.info('Updated repair memory statistics after successful repair', {
            templateId: template.templateId,
            memoriesMarkedSuccessful: usedRepairMemoryIds.length,
            memoryIds: usedRepairMemoryIds,
            reason: 'Memories helped guide successful repair'
          });
        } catch (memoryError) {
          logger.warn('Failed to update repair memory statistics', {
            templateId: template.templateId,
            error: memoryError.message
          });
        }
      }

      // Return repaired template
      return {
        ...template,
        executionScript: cleanedScript,
        lastRepaired: new Date().toISOString(),
        repairReason: `${errorContext.error.type}: ${errorContext.error.message}`,
        repairContext: 'execution_error',
        repairMetadata: {
          repairedAt: new Date().toISOString(),
          memoryIdsUsed: usedRepairMemoryIds,
          repairMethod: 'ai_with_memory'
        }
      };

    } catch (error) {
      logger.error('AI execution error repair failed', {
        templateId: template.templateId,
        errorType: errorContext.error.type,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Repair template for security violations using AI
   * @param {Object} template - Original template with security issues
   * @param {string} securityError - Security validation error message
   * @param {Object} originalRequest - Original user request for context
   * @param {number} repairAttempt - Current repair attempt
   * @returns {Object|null} - Repaired template or null if repair failed
   */
  async repairTemplateForSecurityViolation(template, securityError, originalRequest, repairAttempt) {
    try {
      const genAI = getGeminiClient();
      if (!genAI) {
        logger.warn('Gemini client not available for security violation repair');
        return null;
      }

      const securityRepairPrompt = `You are a security-focused code repair specialist. A JavaScript execution script has been flagged for security violations and needs to be fixed to comply with security policies.

ORIGINAL USER REQUEST: "${originalRequest.message || originalRequest}"

SECURITY VIOLATION:
${securityError}

CURRENT EXECUTION SCRIPT (with security issues):
\`\`\`javascript
${template.executionScript}
\`\`\`

SECURITY REQUIREMENTS - YOU MUST COMPLY WITH ALL OF THESE:
1. **No Direct Process Access**: Remove ALL usage of \`process.\` including:
   - \`process.env\` → Use \`this.context.environment\` or template parameters
   - \`process.memoryUsage()\` → Use \`this.resourceUsage.peakMemory\`
   - \`process.cwd()\` → Not needed in cloud execution
   - \`process.argv\` → Use template parameters instead
   - \`process.exit()\` → Use \`return\` statements instead
   - \`process.nextTick()\` → Use \`setImmediate()\` or \`Promise.resolve().then()\`
   - \`process.stdout\` → Use \`this.log()\` instead
   - ANY other \`process.*\` reference → Remove completely
2. **No File System Access**: Remove \`require('fs')\` or similar file system modules
3. **No Process Spawning**: Remove \`require('child_process')\` or subprocess execution
4. **No Network Modules**: Remove \`require('net')\`, \`require('http')\` - use axios instead
5. **No Code Evaluation**: Remove \`eval()\`, \`Function()\`, or dynamic code execution
6. **No Global Access**: Remove references to \`global\`, \`__dirname\`, \`__filename\`
7. **Size Limit**: Keep script under 50KB total

SECURE ALTERNATIVES TO USE INSTEAD:
- **Process Environment**: \`process.env.NODE_ENV\` → \`this.context.environment || 'production'\`
- **Memory Monitoring**: \`process.memoryUsage()\` → \`this.resourceUsage.peakMemory\`
- **Exit Handling**: \`process.exit(1)\` → \`throw new Error('Task failed')\` or \`return { success: false }\`
- **Current Directory**: \`process.cwd()\` → Use relative paths or template parameters
- **Arguments**: \`process.argv\` → Use \`this.parameters\` from template
- **Async Scheduling**: \`process.nextTick()\` → \`setImmediate()\` or \`await Promise.resolve()\`
- **Output Streams**: \`process.stdout.write()\` → \`this.log('info', message)\`
- **HTTP Requests**: Use \`axios\` or \`this.callAPI()\` instead of direct network modules
- **File Operations**: Use \`this.fileStorage\` for cloud storage instead of local files
- **Logging**: Use \`this.log()\` instead of direct console or process output

CRITICAL: Search the ENTIRE script for ANY occurrence of the word "process" and replace it with secure alternatives. Do not leave ANY \`process.\` references in the code.

MANDATORY METHODS - MUST BE INCLUDED:
- \`updateProgress()\`: Call this.updateProgress(percentage, message) regularly
- \`callAPI()\`: Use this.callAPI(method, params) for all Bitrix24 API calls
- \`generateHTMLReport()\`: REQUIRED - Must call this.generateHTMLReport() and return HTML
- \`this.log()\`: Use for all logging instead of console.log

CRITICAL LOGGING FORMAT:
- CORRECT: \`this.log('info', 'message', { data })\` - level first, message second
- CORRECT: \`this.log('warn', 'warning message')\` - level first, message second  
- CORRECT: \`this.log('error', 'error message')\` - level first, message second
- WRONG: \`this.log('message', 'info')\` - DO NOT put level as second parameter
- WRONG: \`this.log('message', 'warn')\` - DO NOT put level as second parameter

Always use: this.log(LEVEL, MESSAGE) where LEVEL is 'info'|'warn'|'error' and MESSAGE is the text.

REPAIR INSTRUCTIONS:
1. Identify and remove the specific security violation mentioned in the error
2. Replace with secure alternatives from the list above
3. Maintain all business logic and functionality
4. Ensure the class still extends BaseTaskExecutor properly
5. Keep all mandatory method calls intact
6. Add defensive programming and error handling

EXAMPLE SECURE REPLACEMENTS:
\`\`\`javascript
// INSECURE: process.env.NODE_ENV
// SECURE: this.context.environment || 'production'

// INSECURE: require('fs').readFileSync()
// SECURE: await this.fileStorage.downloadFile()

// INSECURE: process.memoryUsage()
// SECURE: this.resourceUsage.peakMemory

// INSECURE: require('child_process').exec()
// SECURE: await this.callAPI('external.service', params)
\`\`\`

FINAL VALIDATION STEP:
Before returning the script, perform a final check:
1. Search the entire script for the word "process" (case-sensitive)
2. If ANY "process." references remain, replace them with secure alternatives
3. Ensure NO \`process.\` appears anywhere in the final script
4. Double-check that all security requirements are met

Return ONLY the complete corrected execution script with ALL security violations fixed. No explanations or markdown formatting.`;

      const response = await genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: securityRepairPrompt }] }],
        config: {
          maxOutputTokens: 65535,
          temperature: 0.1
        }
      });

      // Use centralized response extraction
      const repairedScript = extractGeminiText(response);

      if (!repairedScript || repairedScript.length < 500) {
        logger.error('AI security repair failed - insufficient response', {
          templateId: template.templateId,
          securityError,
          responseLength: repairedScript.length
        });
        return null;
      }

      // Clean the response (remove markdown formatting if present)
      let cleanedScript = repairedScript;
      if (cleanedScript.includes('```javascript')) {
        const match = cleanedScript.match(/```javascript\n([\s\S]*?)\n```/);
        if (match) {
          cleanedScript = match[1];
        }
      } else if (cleanedScript.includes('```')) {
        const match = cleanedScript.match(/```\n([\s\S]*?)\n```/);
        if (match) {
          cleanedScript = match[1];
        }
      }

      logger.info('AI security repair completed', {
        templateId: template.templateId,
        securityError,
        repairAttempt,
        originalLength: template.executionScript.length,
        repairedLength: cleanedScript.length
      });

      // Return repaired template
      return {
        ...template,
        executionScript: cleanedScript,
        lastRepaired: new Date().toISOString(),
        repairReason: `Security violation: ${securityError}`,
        repairContext: 'security_validation',
        repairAttempt
      };

    } catch (error) {
      logger.error('AI security repair failed', {
        templateId: template.templateId,
        securityError,
        repairAttempt,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Validate execution script for security (OWASP LLM04:2025 - Model DoS / Resource Exhaustion)
   * @param {string} scriptCode - JavaScript code to validate
   * @returns {boolean} - Whether script is safe
   */
  validateExecutionScript(scriptCode) {
    // Security checks for both traditional and LLM-specific threats
    const dangerousPatterns = [
      // Traditional security threats
      /require\s*\(\s*['"`]fs['"`]\s*\)/, // File system access
      /require\s*\(\s*['"`]child_process['"`]\s*\)/, // Process spawning
      /require\s*\(\s*['"`]net['"`]\s*\)/, // Network access
      /require\s*\(\s*['"`]http['"`]\s*\)/, // HTTP requests (should use axios)
      /require\s*\(\s*['"`]https['"`]\s*\)/, // HTTPS requests
      /require\s*\(\s*['"`]dgram['"`]\s*\)/, // UDP/datagram sockets
      /require\s*\(\s*['"`]dns['"`]\s*\)/, // DNS resolution
      /eval\s*\(/, // Code evaluation
      /Function\s*\(/, // Dynamic function creation
      /new\s+Function\s*\(/, // Dynamic function constructor
      /process\./, // Process manipulation
      /global\./, // Global scope access
      /__dirname/, // Directory access
      /__filename/, // File access

      // LLM-generated code risks (OWASP LLM04:2025)
      /while\s*\(\s*true\s*\)/, // Infinite loops
      /for\s*\(\s*;\s*;\s*\)/, // Infinite loops (for variant)
      /setInterval\s*\([\s\S]{0,100},\s*0\s*\)/, // Zero-interval timers (CPU exhaustion)
      /new\s+Array\s*\(\s*\d{9,}\s*\)/, // Massive array allocation (memory exhaustion)
      /String\s*\.\s*repeat\s*\(\s*\d{7,}\s*\)/, // String repeat DoS
      /Buffer\s*\.\s*alloc\s*\(\s*\d{9,}\s*\)/, // Large buffer allocation

      // Dangerous API calls
      /vm\s*\.\s*runInNewContext/, // Nested VM contexts (escape attempts)
      /vm\s*\.\s*runInThisContext/, // VM context escape
      /require\s*\(\s*['"`]vm['"`]\s*\)/, // VM module access
      /require\s*\(\s*['"`]cluster['"`]\s*\)/, // Cluster/worker spawning
      /require\s*\(\s*['"`]worker_threads['"`]\s*\)/ // Worker thread creation
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(scriptCode)) {
        throw new Error(`Potentially unsafe code detected: ${pattern.source}`);
      }
    }
    
    // Logging pattern validation - check for incorrect this.log() usage
    const incorrectLoggingPatterns = [
      /this\.log\s*\(\s*['"`][^'"`]*['"`]\s*,\s*['"`](info|warn|error|debug)['"`]\s*\)/g, // this.log('message', 'level')
      /this\.log\s*\(\s*`[^`]*`\s*,\s*['"`](info|warn|error|debug)['"`]\s*\)/g // this.log(`message`, 'level')
    ];

    for (const pattern of incorrectLoggingPatterns) {
      if (pattern.test(scriptCode)) {
        throw new Error('Incorrect logging pattern detected: this.log() requires level first, then message. Use this.log(\'level\', \'message\') not this.log(\'message\', \'level\')');
      }
    }

    // Check for reasonable script size
    if (scriptCode.length > 50000) { // 50KB limit
      throw new Error('Script too large (>50KB)');
    }

    return true;
  }

  /**
   * Clear caches (useful for testing or forced refresh)
   */
  clearCaches() {
    this.executorCache.clear();
    this.templatesModel.clearCache();
    logger.info('Template caches cleared');
  }

  /**
   * Clear executor cache for a specific template
   * @param {string} templateId - Template identifier
   */
  clearTemplateCache(templateId) {
    let clearedCount = 0;
    for (const [cacheKey, _] of this.executorCache.entries()) {
      if (cacheKey.startsWith(`${templateId}_`)) {
        this.executorCache.delete(cacheKey);
        clearedCount++;
      }
    }
    logger.info('Cleared executor cache for template', { templateId, clearedCount });

    // Also clear the templates model cache
    this.templatesModel.clearCache();
  }

  /**
   * Load knowledge base content for auto-repair prompts
   * @returns {string} - Knowledge base content
   */
  async loadKnowledgeBaseForRepair() {
    try {
      // Use semantic search to find ALL relevant KB documents for repair
      const { getFirestore } = require('../config/firestore');
      const db = getFirestore();

      // Semantic search queries for repair context
      const searchQueries = [
        'bitrix24 api integration',
        'crm endpoints',
        'invoice creation',
        'complex task patterns',
        'api constraints'
      ];

      // Get all enabled KB documents and let semantic search find relevant ones
      const querySnapshot = await db.collection('knowledge-base')
        .where('enabled', '==', true)
        .orderBy('priority', 'desc')
        .get();

      if (querySnapshot.empty) {
        logger.warn('No knowledge base documents found for auto-repair');
        return this.getFallbackKnowledgeContent();
      }

      // Collect ALL enabled documents with content
      const relevantDocs = [];
      for (const doc of querySnapshot.docs) {
        const data = doc.data();
        if (data && data.content) {
          relevantDocs.push({
            docId: doc.id,
            title: data.title,
            content: data.content,
            contentLength: data.content.length,
            category: data.category,
            priority: data.priority || 0,
            tags: data.tags || []
          });
        }
      }

      if (relevantDocs.length === 0) {
        logger.warn('No KB documents with content found');
        return this.getFallbackKnowledgeContent();
      }

      // Sort by priority descending to send most important docs first
      relevantDocs.sort((a, b) => b.priority - a.priority);

      logger.info('Found knowledge base documents for repair - sending ALL', {
        totalDocs: relevantDocs.length,
        docs: relevantDocs.map(d => ({
          docId: d.docId,
          title: d.title,
          priority: d.priority,
          contentLength: d.contentLength
        }))
      });

      // Concatenate ALL documents with separators
      const combinedContent = relevantDocs.map((doc, index) => {
        return `
================================================================================
KNOWLEDGE BASE DOCUMENT ${index + 1}/${relevantDocs.length}
Title: ${doc.title}
Priority: ${doc.priority}
================================================================================

${doc.content}

`;
      }).join('\n\n');

      logger.info('Combined knowledge base content for repair', {
        totalDocs: relevantDocs.length,
        totalContentLength: combinedContent.length,
        individualLengths: relevantDocs.map(d => d.contentLength)
      });

      // Return FULL combined content of ALL documents
      return combinedContent;

    } catch (error) {
      logger.error('Failed to load knowledge base for repair', {
        error: error.message
      });
      return this.getFallbackKnowledgeContent();
    }
  }
  
  /**
   * Get fallback knowledge content when database lookup fails
   */
  getFallbackKnowledgeContent() {
      
    // Fallback: Critical endpoint restrictions in case knowledge base is not available
    return `## ⚠️ CRITICAL: API Endpoint Restrictions (Anti-Hallucination Grounding)

**YOU MUST ONLY USE ENDPOINTS EXPLICITLY DOCUMENTED BELOW. YOUR KNOWLEDGE IS CONFINED TO THIS DATA.**

**Allowed Endpoints (EXACTLY 17 - NO MORE):**
- ✅ crm.invoice.list
- ✅ crm.invoice.get  
- ✅ crm.invoice.add
- ✅ crm.invoice.update
- ✅ crm.invoice.delete
- ✅ crm.company.list
- ✅ crm.company.get
- ✅ crm.contact.list
- ✅ crm.contact.get
- ✅ crm.deal.list
- ✅ crm.deal.get
- ✅ crm.activity.list
- ✅ crm.activity.get
- ✅ user.get
- ✅ im.message.add
- ✅ imbot.message.add
- ✅ imbot.chat.sendTyping

**Common Hallucinated Endpoints (DO NOT USE):**
- ❌ crm.invoice.productrows.get - DOES NOT EXIST
- ❌ crm.invoice.items.list - DOES NOT EXIST  
- ❌ crm.invoice.products.get - DOES NOT EXIST
- ❌ crm.smart_invoice.list - DOES NOT EXIST
- ❌ crm.invoice.lineitems.list - DOES NOT EXIST

**If you need product/line item data from invoices:**
- Use crm.invoice.get with select: ['*', 'PRODUCT_ROWS'] to get all invoice data including products
- Parse the returned invoice data structure for product information in PRODUCT_ROWS field
- Do NOT call non-existent product-specific endpoints`;
  }

  /**
   * Get cache statistics
   * @returns {Object} - Cache stats
   */
  getCacheStats() {
    return {
      executorCacheSize: this.executorCache.size,
      templatesModelCache: this.templatesModel.getCacheStats(),
      cacheExpiry: this.cacheExpiry
    };
  }
}

// Singleton instance
let instance = null;

function getTaskTemplateLoader() {
  if (!instance) {
    instance = new TaskTemplateLoader();
  }
  return instance;
}

module.exports = {
  TaskTemplateLoader,
  getTaskTemplateLoader
};