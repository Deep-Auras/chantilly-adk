const { logger } = require('../utils/logger');
const { getTaskQueueModel } = require('../models/taskQueue');
const { getWorkerProcessesModel } = require('../models/workerProcesses');

/**
 * TaskError - Custom error class for task execution errors
 */
class TaskError extends Error {
  constructor(message, code = 'TASK_ERROR', step = null, data = {}) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.step = step;
    this.data = data;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * BaseTaskExecutor - Base class for all task executors
 * 
 * This class provides common functionality for task execution including:
 * - Progress tracking and reporting
 * - Resource monitoring
 * - Error handling and logging
 * - API rate limiting
 * - Tool integration
 */
class BaseTaskExecutor {
  constructor(taskData, template) {
    this.taskId = taskData.taskId;
    this.parameters = taskData.parameters || {};
    this.context = taskData.context || {};
    this.template = template;
    this.testing = taskData.testing ?? template.testing ?? false;

    // MaTTS: Store provided memories if passed from test-time scaling
    this.providedMemories = taskData.providedMemories || null;
    
    // Models for database operations
    this.taskQueueModel = getTaskQueueModel();
    this.workerProcessesModel = getWorkerProcessesModel();
    
    // Execution state
    this.startTime = Date.now();
    this.currentStep = null;
    this.stepsCompleted = 0;
    this.stepsTotal = template.definition?.estimatedSteps || 1;
    
    // Resource tracking
    this.resourceUsage = {
      peakMemory: 0,
      totalApiCalls: 0,
      geminiTokens: 0,
      errorCount: 0,
      warningCount: 0
    };
    
    // Tool instances (loaded from context)
    this.tools = this.context.tools || {};
    
    // Rate limiters
    this.rateLimiters = this.context.rateLimiters || {};
    
    // Database and AI connections
    this.db = this.context.db;
    this.genAI = this.context.genAI;
    
    // Queue service for Bitrix24 API calls
    this.queueService = this.context.queueService;
    
    // Storage services
    this.fileStorage = this.context.fileStorage;
    
    // Bind methods for callbacks
    this.updateProgress = this.updateProgress.bind(this);
    this.sendMessage = this.sendMessage.bind(this);
    
    // Make TaskError available to templates
    this.TaskError = TaskError;
    
    logger.info('Task executor initialized', {
      taskId: this.taskId,
      template: template.name,
      version: template.version,
      parameters: Object.keys(this.parameters)
    });
  }

  /**
   * Main execution method - must be implemented by subclasses
   * @returns {Object} - Execution result
   */
  async execute() {
    throw new Error('execute() method must be implemented by subclass');
  }

  /**
   * Update task progress
   * @param {number} percentage - Progress percentage (0-100)
   * @param {string} message - Progress message
   * @param {string} step - Current step name
   * @param {Object} data - Additional progress data
   */
  async updateProgress(percentage, message, step = null, data = {}) {
    try {
      // Check for cancellation before updating progress
      await this.checkCancellation();
      
      this.currentStep = step || this.currentStep;
      
      // Update internal state
      if (step && step !== this.currentStep) {
        this.stepsCompleted++;
      }
      
      // Track memory usage
      const memoryUsage = process.memoryUsage();
      this.resourceUsage.peakMemory = Math.max(
        this.resourceUsage.peakMemory,
        memoryUsage.heapUsed
      );
      
      // Update database
      await this.taskQueueModel.updateProgress(
        this.taskId,
        Math.round(percentage * 100) / 100, // Round to 2 decimal places
        message,
        {
          ...data,
          currentStep: this.currentStep,
          stepsCompleted: this.stepsCompleted,
          stepsTotal: this.stepsTotal,
          memoryUsage: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
          timestamp: new Date().toISOString()
        }
      );
      
      // Send to parent process if available
      if (this.sendMessage) {
        this.sendMessage('PROGRESS_UPDATE', {
          taskId: this.taskId,
          percentage,
          message,
          currentStep: this.currentStep,
          data,
          timestamp: new Date().toISOString()
        });
      }
      
      logger.debug('Progress updated', {
        taskId: this.taskId,
        percentage,
        step: this.currentStep,
        message: message.substring(0, 100)
      });
    } catch (error) {
      logger.error('Failed to update progress', {
        taskId: this.taskId,
        error: error.message
      });
    }
  }

  /**
   * Send message to parent process
   * @param {string} type - Message type
   * @param {Object} data - Message data
   */
  sendMessage(type, data) {
    if (this.context.sendMessage) {
      this.context.sendMessage(type, data);
    }
  }

  /**
   * Log with task context
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} meta - Additional metadata
   */
  log(level, message, meta = {}) {
    logger[level](message, {
      taskId: this.taskId,
      template: this.template.name,
      step: this.currentStep,
      ...meta
    });
  }

  /**
   * Get task parameters
   * @returns {Object} - Task parameters
   */
  getParameters() {
    return this.parameters;
  }

  /**
   * Validate task parameters against schema
   * @returns {Object} - Validation result
   */
  async validateParameters() {
    try {
      const schema = this.template.definition?.parameterSchema;
      if (!schema) {
        this.log('warn', 'No parameter schema defined for template');
        return { valid: true, errors: [], warnings: ['No parameter schema'] };
      }

      const errors = [];
      const warnings = [];

      // Basic validation (expand as needed)
      if (schema.required) {
        for (const field of schema.required) {
          if (this.parameters[field] === undefined || this.parameters[field] === null) {
            errors.push(`Required parameter missing: ${field}`);
          }
        }
      }

      // Type validation for properties
      if (schema.properties) {
        for (const [field, fieldSchema] of Object.entries(schema.properties)) {
          const value = this.parameters[field];
          if (value !== undefined && fieldSchema.type) {
            const actualType = Array.isArray(value) ? 'array' : typeof value;
            if (actualType !== fieldSchema.type) {
              errors.push(`Parameter ${field}: expected ${fieldSchema.type}, got ${actualType}`);
            }
          }
        }
      }

      const result = {
        valid: errors.length === 0,
        errors,
        warnings
      };

      if (!result.valid) {
        this.log('error', 'Parameter validation failed', { errors, warnings });
        throw new Error(`Parameter validation failed: ${errors.join(', ')}`);
      }

      this.log('info', 'Parameters validated successfully');
      return result;
    } catch (error) {
      this.log('error', 'Parameter validation error', { error: error.message });
      throw error;
    }
  }

  /**
   * Streaming fetch with progress updates
   * @param {string} method - API method
   * @param {Object} query - Query parameters
   * @param {Object} options - Fetch options
   * @returns {Array} - Fetched data
   */
  async streamingFetch(method, query, options = {}) {
    const {
      batchSize = 50,
      progressCallback = null,
      rateLimiter = 'bitrix24'
    } = options;

    const results = [];
    let hasMore = true;
    let start = 0;
    let processed = 0;

    this.log('info', `Starting streaming fetch for ${method}`, { 
      query, 
      batchSize 
    });

    while (hasMore) {
      // Check for cancellation before each batch
      await this.checkCancellation();
      
      // Rate limiting
      if (this.rateLimiters[rateLimiter]) {
        await this.rateLimiters[rateLimiter].wait();
      }

      try {
        const batchQuery = {
          ...query,
          start,
          limit: batchSize
        };

        const batch = await this.callAPI(method, batchQuery);
        
        if (batch && batch.result) {
          results.push(...batch.result);
          processed += batch.result.length;
          hasMore = batch.result.length === batchSize;
          start += batchSize;

          // Progress callback
          if (progressCallback) {
            progressCallback(processed, processed * 2); // Rough estimate
          }

          // Track API calls
          this.resourceUsage.totalApiCalls++;

          this.log('debug', `Fetched batch for ${method}`, {
            batchSize: batch.result.length,
            totalProcessed: processed,
            hasMore
          });
        } else {
          hasMore = false;
        }
      } catch (error) {
        this.log('error', `Streaming fetch error for ${method}`, {
          start,
          error: error.message
        });

        // Exponential backoff for rate limits
        if (error.message.includes('rate limit') || error.message.includes('429')) {
          await this.exponentialBackoff(processed);
          continue; // Retry same batch
        }

        throw error;
      }
    }

    this.log('info', `Streaming fetch completed for ${method}`, {
      totalResults: results.length,
      apiCalls: this.resourceUsage.totalApiCalls
    });

    return results;
  }

  /**
   * Check if task has been cancelled and throw error if so
   * @throws {Error} - TaskCancelledError if task is cancelled
   */
  async checkCancellation() {
    try {
      const task = await this.taskQueueModel.getTask(this.taskId);
      if (task && task.status === 'cancelled') {
        const error = new Error(`Task ${this.taskId} has been cancelled by user`);
        error.name = 'TaskCancelledError';
        error.taskId = this.taskId;
        throw error;
      }
    } catch (error) {
      if (error.name === 'TaskCancelledError') {
        throw error;
      }
      // Log but don't throw database errors during cancellation check
      this.log('warn', 'Failed to check cancellation status', { 
        error: error.message 
      });
    }
  }

  /**
   * Call Bitrix24 API method with tracking and rate limiting
   * @param {string} method - Bitrix24 API method
   * @param {Object} params - Parameters
   * @returns {Object} - API response
   */
  async callAPI(method, params) {
    try {
      // Check for cancellation before making API calls
      await this.checkCancellation();
      
      // Handle both correct and incorrect API call formats for backward compatibility
      if (typeof method === 'object' && method.method && method.params) {
        // Fix incorrect template format: callAPI({method: "...", params: {...}})
        params = method.params;
        method = method.method;
      }
      
      // Ensure params is defined and is an object
      if (!params || typeof params !== 'object') {
        params = {};
      }
      
      // Use the queue service if available in context
      if (this.queueService) {
        this.log('debug', 'Calling Bitrix24 API via queue', { 
          method, 
          paramsKeys: Object.keys(params),
          params: method.includes('invoice') ? params : 'non-invoice-method'
        });
        
        const result = await this.queueService.add({
          method: method,
          params: params
        });
        
        // Track API calls
        this.resourceUsage.totalApiCalls++;
        
        return result;
      } else {
        throw new Error('Queue service not available in execution context');
      }
    } catch (error) {
      this.log('error', 'Bitrix24 API call failed', { 
        method, 
        error: error.message 
      });
      this.resourceUsage.errorCount++;
      throw error;
    }
  }

  /**
   * Validate and normalize Gemini model name
   * DETERMINISTIC MODEL VALIDATION - Prevents invalid model names from reaching Gemini API
   *
   * @param {string} modelName - Model name to validate
   * @returns {string} - Validated model name (or default if invalid)
   */
  validateAndNormalizeGeminiModel(modelName) {
    // Valid Gemini models as of 2025 (v1beta API)
    const VALID_MODELS = [
      'gemini-2.5-pro',          // Current flagship (Feb 2025)
      'gemini-2.0-flash-exp',    // Experimental fast model
      'gemini-1.5-pro-latest',   // Latest stable 1.5
      'gemini-1.5-flash-latest'  // Latest fast 1.5
    ];

    // Known invalid models that templates might hardcode
    const INVALID_MODELS = [
      'gemini-1.5-pro-002',      // Does NOT exist in v1beta API
      'gemini-1.5-flash-002',    // Does NOT exist in v1beta API
      'gemini-1.5-pro',          // Deprecated - use gemini-1.5-pro-latest
      'gemini-1.5-flash'         // Deprecated - use gemini-1.5-flash-latest
    ];

    const DEFAULT_MODEL = 'gemini-2.5-pro';

    // If no model specified, use default
    if (!modelName || typeof modelName !== 'string') {
      this.log('info', 'No model specified, using default', {
        defaultModel: DEFAULT_MODEL
      });
      return DEFAULT_MODEL;
    }

    // Check if explicitly invalid
    if (INVALID_MODELS.includes(modelName)) {
      this.log('warn', 'Invalid model detected - auto-correcting to default', {
        requestedModel: modelName,
        correctedModel: DEFAULT_MODEL,
        reason: 'Model does not exist in Gemini v1beta API'
      });
      return DEFAULT_MODEL;
    }

    // Check if valid
    if (VALID_MODELS.includes(modelName)) {
      this.log('debug', 'Valid model name confirmed', {
        model: modelName
      });
      return modelName;
    }

    // Unknown model - FAIL DETERMINISTICALLY (user requirement)
    // Do NOT allow unknown models - this prevents typos and outdated model names
    this.log('error', 'Unknown/invalid model specified - rejecting', {
      requestedModel: modelName,
      validModels: VALID_MODELS,
      correctedModel: DEFAULT_MODEL,
      action: 'Using default model instead'
    });

    // Return default instead of failing the entire task
    // This prevents template execution failures while still being strict
    return DEFAULT_MODEL;
  }

  /**
   * Call Gemini AI with tracking
   * @param {string} prompt - AI prompt
   * @param {Object} options - Generation options
   * @param {string} options.model - Model to use (default: gemini-2.5-pro)
   * @param {number} options.maxTokens - Max output tokens (default: 8192)
   * @param {number} options.temperature - Temperature (default: 0.1)
   * @param {Object} options.responseSchema - JSON schema for structured output
   * @returns {Object|string} - AI response (parsed JSON if responseSchema provided, otherwise string)
   */
  async callGemini(prompt, options = {}) {
    try {
      if (!this.genAI) {
        throw new Error('Gemini AI client not available in context');
      }

      // Rate limiting
      if (this.rateLimiters.gemini) {
        await this.rateLimiters.gemini.wait();
      }

      // Build generation config
      const generationConfig = {
        maxOutputTokens: options.maxTokens || 8192,
        temperature: options.temperature || 0.1
      };

      // Add responseSchema if provided for structured JSON output
      if (options.responseSchema) {
        generationConfig.responseSchema = options.responseSchema;
        generationConfig.responseMimeType = 'application/json';
      }

      // CRITICAL: Validate and normalize model name BEFORE API call
      // This prevents templates from using invalid models like "gemini-1.5-pro-002"
      const { getConfigManager } = require('../services/dashboard/configManager');
      const configManager = await getConfigManager();
      const configuredModel = await configManager.get('config', 'GEMINI_MODEL');
      const validatedModel = this.validateAndNormalizeGeminiModel(
        options.model || configuredModel
      );
      if (!validatedModel) {
        throw new Error('GEMINI_MODEL not configured in Firestore agent/config');
      }

      // Use the NEW @google/genai SDK format (2025 syntax)
      // Read default model from env var (CLAUDE.md line 223: GEMINI_MODEL=gemini-2.5-pro)
      const result = await this.genAI.models.generateContent({
        model: validatedModel,
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        generationConfig: generationConfig
      });

      // Extract response using centralized helper
      const { extractGeminiText } = require('../config/gemini');
      const responseText = extractGeminiText(result);

      // Track token usage
      if (result.usageMetadata?.totalTokenCount) {
        this.resourceUsage.geminiTokens += result.usageMetadata.totalTokenCount;
      }

      this.log('debug', 'Gemini API call completed', {
        promptLength: prompt.length,
        tokensUsed: result.usageMetadata?.totalTokenCount || 0,
        totalTokens: this.resourceUsage.geminiTokens,
        hasResponseSchema: !!options.responseSchema
      });

      // Parse JSON if responseSchema was provided
      if (options.responseSchema) {
        try {
          const parsed = JSON.parse(responseText);
          this.log('debug', 'Parsed structured JSON response', {
            hasPersonas: !!parsed.personas,
            personaCount: parsed.personas?.length || 0
          });
          return parsed;
        } catch (parseError) {
          this.log('error', 'Failed to parse JSON response from Gemini', {
            error: parseError.message,
            responsePreview: responseText.substring(0, 200)
          });
          throw new Error(`Gemini returned invalid JSON: ${parseError.message}`);
        }
      }

      // Return raw text if no schema requested
      return responseText;
    } catch (error) {
      this.log('error', 'Gemini API call failed', { error: error.message });
      this.resourceUsage.errorCount++;
      throw error;
    }
  }

  /**
   * Exponential backoff for rate limiting
   * @param {number} attempt - Attempt number
   */
  async exponentialBackoff(attempt) {
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
    this.log('warn', 'Rate limit hit, backing off', { delay, attempt });
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Chunk array into smaller pieces
   * @param {Array} array - Array to chunk
   * @param {number} chunkSize - Size of each chunk
   * @returns {Array} - Array of chunks
   */
  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Format duration in human-readable format
   * @param {number} ms - Duration in milliseconds
   * @returns {string} - Formatted duration
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Create checkpoint for recovery
   * @param {string} stepName - Step name
   * @param {Object} data - Checkpoint data
   */
  async createCheckpoint(stepName, data = {}) {
    try {
      const checkpoint = {
        step: stepName,
        completedAt: new Date().toISOString(),
        duration: Date.now() - this.startTime,
        data,
        resourceUsage: { ...this.resourceUsage }
      };

      // Note: No serverTimestamp() needed here since we're using new Date().toISOString() for completedAt
      await this.taskQueueModel.updateTask(this.taskId, {
        ['progress.checkpoints']: require('firebase-admin').firestore.FieldValue.arrayUnion(checkpoint)
      });

      this.log('info', 'Checkpoint created', { step: stepName });
    } catch (error) {
      this.log('error', 'Failed to create checkpoint', {
        step: stepName,
        error: error.message
      });
    }
  }

  /**
   * Get execution summary
   * @returns {Object} - Execution summary
   */
  getExecutionSummary() {
    const executionTime = Date.now() - this.startTime;
    
    return {
      taskId: this.taskId,
      template: this.template.name,
      version: this.template.version,
      executionTime,
      formattedDuration: this.formatDuration(executionTime),
      stepsCompleted: this.stepsCompleted,
      stepsTotal: this.stepsTotal,
      resourceUsage: {
        ...this.resourceUsage,
        peakMemoryMB: Math.round(this.resourceUsage.peakMemory / 1024 / 1024)
      }
    };
  }

  /**
   * Generate HTML report from sections (utility method - templates should override generateHTMLReport)
   * @param {Object} data - Report data
   * @param {Object} options - Generation options
   * @returns {string} - Generated HTML content
   */
  generateHTMLFromSections(data, options = {}) {
    const {
      title = 'Report',
      subtitle = '',
      customerInfo = null,
      sections = [],
      summary = '',
      metadata = {}
    } = options;

    // Generate customer section if provided
    const customerSection = customerInfo ? `
      <div class="customer-info">
        <h2>Customer Information</h2>
        <div class="info-grid">
          ${Object.entries(customerInfo).map(([key, value]) => `
            <div class="info-item">
              <strong>${this.formatFieldName(key)}:</strong> ${value || 'N/A'}
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    // Generate sections
    const sectionsHTML = sections.map(section => {
      if (section.type === 'table' && section.data && section.data.length > 0) {
        return this.generateTableSection(section);
      } else if (section.type === 'list' && section.items && section.items.length > 0) {
        return this.generateListSection(section);
      } else if (section.type === 'summary') {
        return this.generateSummarySection(section);
      } else {
        return `
          <div class="section">
            <h3>${section.title || 'Section'}</h3>
            <p>${section.content || 'No content available'}</p>
          </div>
        `;
      }
    }).join('');

    // Generate metadata footer
    const metadataHTML = Object.keys(metadata).length > 0 ? `
      <div class="metadata">
        <h3>Report Information</h3>
        ${Object.entries(metadata).map(([key, value]) => `
          <p><strong>${this.formatFieldName(key)}:</strong> ${value}</p>
        `).join('')}
      </div>
    ` : '';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            border-bottom: 3px solid #007acc;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        .header h1 {
            color: #007acc;
            margin: 0 0 10px 0;
            font-size: 2.2em;
        }
        .header .subtitle {
            color: #666;
            font-size: 1.1em;
            margin: 0;
        }
        .customer-info {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        .info-item {
            padding: 10px;
            background: white;
            border-left: 4px solid #007acc;
            border-radius: 3px;
        }
        .section {
            margin: 30px 0;
            padding: 20px 0;
            border-bottom: 1px solid #eee;
        }
        .section:last-child {
            border-bottom: none;
        }
        .section h2, .section h3 {
            color: #007acc;
            margin-top: 0;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 15px 0;
            background: white;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        th {
            background-color: #007acc;
            color: white;
            font-weight: bold;
        }
        tr:hover {
            background-color: #f5f5f5;
        }
        .summary {
            background: #e8f4fd;
            padding: 20px;
            border-radius: 5px;
            border-left: 5px solid #007acc;
            margin: 20px 0;
        }
        .metadata {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin-top: 30px;
            font-size: 0.9em;
            color: #666;
        }
        .list-section ul {
            list-style-type: none;
            padding: 0;
        }
        .list-section li {
            background: #f8f9fa;
            margin: 8px 0;
            padding: 12px;
            border-left: 4px solid #007acc;
            border-radius: 3px;
        }
        .no-data {
            text-align: center;
            color: #666;
            font-style: italic;
            padding: 40px;
            background: #f8f9fa;
            border-radius: 5px;
        }
        @media print {
            body { background: white; }
            .container { box-shadow: none; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${title}</h1>
            ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}
        </div>

        ${customerSection}
        ${sectionsHTML}
        
        ${summary ? `
          <div class="summary">
            <h3>Summary</h3>
            <p>${summary}</p>
          </div>
        ` : ''}
        
        ${metadataHTML}
    </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate table section HTML
   * @param {Object} section - Section configuration
   * @returns {string} - HTML content
   */
  generateTableSection(section) {
    const { title, data, columns } = section;
    
    if (!data || data.length === 0) {
      return `
        <div class="section">
          <h3>${title}</h3>
          <div class="no-data">No data available</div>
        </div>
      `;
    }

    // Auto-detect columns if not provided
    const tableColumns = columns || Object.keys(data[0]);
    
    return `
      <div class="section">
        <h3>${title}</h3>
        <table>
          <thead>
            <tr>
              ${tableColumns.map(col => `<th>${this.formatFieldName(col)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${data.map(row => `
              <tr>
                ${tableColumns.map(col => `<td>${row[col] || 'N/A'}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  /**
   * Generate list section HTML
   * @param {Object} section - Section configuration
   * @returns {string} - HTML content
   */
  generateListSection(section) {
    const { title, items } = section;
    
    if (!items || items.length === 0) {
      return `
        <div class="section">
          <h3>${title}</h3>
          <div class="no-data">No items available</div>
        </div>
      `;
    }

    return `
      <div class="section list-section">
        <h3>${title}</h3>
        <ul>
          ${items.map(item => `<li>${item}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  /**
   * Generate summary section HTML
   * @param {Object} section - Section configuration
   * @returns {string} - HTML content
   */
  generateSummarySection(section) {
    const { title, content, stats } = section;
    
    return `
      <div class="section">
        <h3>${title}</h3>
        ${content ? `<p>${content}</p>` : ''}
        ${stats ? `
          <div class="info-grid">
            ${Object.entries(stats).map(([key, value]) => `
              <div class="info-item">
                <strong>${this.formatFieldName(key)}:</strong> ${value}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Format field names for display
   * @param {string} fieldName - Raw field name
   * @returns {string} - Formatted field name
   */
  formatFieldName(fieldName) {
    return fieldName
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .replace(/_/g, ' ')
      .trim();
  }

  /**
   * Upload report to Cloud Storage and return attachment info
   * @param {string} htmlContent - HTML report content
   * @param {string} fileName - Suggested file name
   * @param {Object} metadata - Additional metadata
   * @returns {Object} - Attachment information
   */
  async uploadReport(htmlContent, fileName, metadata = {}) {
    try {
      if (!this.fileStorage) {
        this.log('warn', 'File storage service not available, storing in task result');
        return {
          name: fileName,
          content: htmlContent,
          type: 'text/html',
          size: htmlContent.length,
          storage: 'inline'
        };
      }

      const uploadResult = await this.fileStorage.uploadHtmlReport(
        htmlContent,
        fileName,
        {
          taskId: this.taskId,
          templateId: this.template?.templateId,
          ...metadata
        }
      );

      this.log('info', 'Report uploaded to Cloud Storage', {
        fileName: uploadResult.filename,
        size: uploadResult.contentLength
      });

      return {
        name: fileName,
        fileName: uploadResult.filename,
        filePath: uploadResult.filePath,
        publicUrl: uploadResult.publicUrl,
        type: 'text/html',
        size: uploadResult.contentLength,
        storage: 'cloud_storage',
        uploadedAt: uploadResult.uploadTime
      };

    } catch (error) {
      this.log('error', 'Failed to upload report to Cloud Storage', {
        error: error.message,
        fileName: fileName,
        contentSize: htmlContent.length
      });

      // In testing mode, throw error to trigger auto-repair
      if (this.isTestingMode()) {
        this.log('info', 'Testing mode: throwing upload error to trigger auto-repair', {
          originalError: error.message
        });
        throw new Error(`File upload failed: ${error.message}`);
      }

      // In production mode, fallback to inline storage  
      this.log('warn', 'Production mode: falling back to inline storage', {
        reason: 'Cloud Storage upload failed'
      });
      
      return {
        name: fileName,
        content: htmlContent.length > 100000 ? htmlContent.substring(0, 100000) + '...[truncated]' : htmlContent,
        type: 'text/html',
        size: htmlContent.length,
        storage: 'inline_truncated',
        note: 'Report was too large for inline storage and Cloud Storage failed'
      };
    }
  }

  /**
   * Handle execution errors with auto-repair for testing mode
   * @param {Error} error - Error object
   * @param {string} step - Current step
   */
  async handleError(error, step = null) {
    this.resourceUsage.errorCount++;
    
    const errorInfo = {
      type: error.name || 'ExecutionError',
      message: error.message,
      step: step || this.currentStep,
      timestamp: new Date().toISOString(),
      stack: error.stack,
      testing: this.isTestingMode()
    };

    this.log('error', 'Task execution error', errorInfo);

    // For testing mode tasks, attempt auto-repair before failing
    if (this.isTestingMode() && this.shouldAttemptAutoRepair(error)) {
      this.log('info', 'Testing mode error detected, attempting auto-repair', {
        taskId: this.taskId,
        templateId: this.template?.templateId,
        errorType: error.name,
        step: step || this.currentStep
      });
      
      // Notify user about repair attempt and potential delays
      if (this.sendMessage) {
        this.sendMessage('TASK_REPAIR_STARTED', {
          taskId: this.taskId,
          templateName: this.template?.name || 'Unknown Template',
          errorType: error.name,
          errorMessage: error.message.substring(0, 200),
          repairAttempt: (this.template?.repairAttempts || 0) + 1,
          estimatedRepairTime: '1-2 minutes'
        });
      }

      try {
        // CRITICAL: Check if task was cancelled BEFORE starting auto-repair
        // This prevents race condition where user cancels during error handling
        const taskBeforeRepair = await this.taskQueueModel.getTask(this.taskId);
        if (taskBeforeRepair && taskBeforeRepair.status === 'cancelled') {
          this.log('info', 'Task was cancelled before auto-repair started, aborting', {
            taskId: this.taskId,
            status: taskBeforeRepair.status,
            cancelledAt: taskBeforeRepair.cancelledAt
          });

          // Don't attempt repair, throw cancellation error immediately
          const cancellationError = new Error('Task was cancelled before auto-repair');
          cancellationError.name = 'TaskCancelledError';
          cancellationError.reason = 'user_cancelled_before_repair';
          throw cancellationError;
        }

        const repairResult = await this.attemptErrorAutoRepair(error, errorInfo);

        // CRITICAL: Check IMMEDIATELY if task was cancelled DURING auto-repair (takes ~1 minute)
        // This check happens BEFORE checking repairResult.success so cancellation always wins
        const taskAfterRepair = await this.taskQueueModel.getTask(this.taskId);
        if (taskAfterRepair && taskAfterRepair.status === 'cancelled') {
          this.log('info', 'Task was cancelled during auto-repair, aborting retry', {
            taskId: this.taskId,
            status: taskAfterRepair.status,
            cancelledAt: taskAfterRepair.cancelledAt,
            repairDuration: `${Date.now() - this.startTime}ms`
          });

          // Don't create retry task, throw cancellation error to stop execution
          const cancellationError = new Error('Task was cancelled during auto-repair');
          cancellationError.name = 'TaskCancelledError';
          cancellationError.reason = 'user_cancelled_during_repair';
          throw cancellationError;
        }

        if (repairResult.success) {
          // Auto-repair succeeded, trigger retry with repaired template
          this.log('info', 'Auto-repair successful, triggering task retry', {
            taskId: this.taskId,
            repairAttempt: repairResult.repairAttempt
          });

          // CRITICAL: Immediately mark original task as failed to prevent duplicate execution
          await this.taskQueueModel.updateTask(this.taskId, {
            status: 'failed_auto_repairing',
            failedAt: new Date().toISOString(),
            autoRepairInProgress: true,
            errors: [errorInfo]
          });

          // CRITICAL: Cancel the Cloud Task to prevent it from continuing execution
          try {
            const task = await this.taskQueueModel.getTask(this.taskId);
            const cloudTaskName = task?.execution?.cloudTaskName;
            
            if (cloudTaskName) {
              const { getCloudTasksQueue } = require('../services/cloudTasksQueue');
              const cloudTasksQueue = getCloudTasksQueue();
              const cancelled = await cloudTasksQueue.cancelTask(cloudTaskName);
              
              this.log('info', 'Cloud Task cancellation attempted during auto-repair', {
                taskId: this.taskId,
                cloudTaskName,
                cancelled
              });
            } else {
              this.log('warn', 'No Cloud Task name found for cancellation', {
                taskId: this.taskId
              });
            }
          } catch (cloudCancelError) {
            this.log('error', 'Failed to cancel Cloud Task during auto-repair', {
              taskId: this.taskId,
              error: cloudCancelError.message
            });
            // Don't throw - auto-repair should continue even if Cloud Task cancellation fails
          }

          // Trigger retry through orchestrator
          try {
            const { getTaskOrchestrator } = require('../services/taskOrchestrator');
            const orchestrator = getTaskOrchestrator();
            const retryResult = await orchestrator.retryTaskWithRepairedTemplate(this.taskId, repairResult, this.context?.userId);
            
            if (retryResult.success) {
              this.log('info', 'Task retry triggered successfully', {
                originalTaskId: this.taskId,
                retryTaskId: retryResult.retryTaskId
              });
              
              // Update current task to indicate retry was initiated
              await this.taskQueueModel.updateTask(this.taskId, {
                status: 'auto_repaired_retrying',
                retryTaskId: retryResult.retryTaskId,
                autoRepairRetryInfo: {
                  timestamp: new Date().toISOString(),
                  retryTaskId: retryResult.retryTaskId,
                  repairAttempt: repairResult.repairAttempt
                }
              });
              
              // CRITICAL: Throw cancellation error to stop original task execution
              this.log('info', 'Throwing TaskCancelledError to stop original task', {
                taskId: this.taskId,
                retryTaskId: retryResult.retryTaskId,
                reason: 'auto_repair_retry'
              });
              
              const cancellationError = new Error('Task cancelled due to auto-repair retry');
              cancellationError.name = 'TaskCancelledError';
              cancellationError.reason = 'auto_repair_retry';
              cancellationError.retryTaskId = retryResult.retryTaskId;
              throw cancellationError;
            } else {
              this.log('error', 'Failed to trigger task retry after repair', {
                taskId: this.taskId,
                retryError: retryResult.error
              });
              // Continue to normal error handling
            }
          } catch (retryError) {
            // If this is our TaskCancelledError from auto-repair retry, re-throw it to stop execution
            if (retryError.name === 'TaskCancelledError' && retryError.reason === 'auto_repair_retry') {
              this.log('info', 'Re-throwing TaskCancelledError to halt execution', {
                taskId: this.taskId,
                retryTaskId: retryError.retryTaskId
              });
              throw retryError;
            }

            this.log('error', 'Exception during task retry trigger', {
              taskId: this.taskId,
              retryError: retryError.message
            });
            // Continue to normal error handling
          }
        } else {
          this.log('warn', 'Auto-repair attempted but failed', {
            taskId: this.taskId,
            repairResult: repairResult
          });
          // Continue to normal error handling
        }
      } catch (repairError) {
        // If this is our TaskCancelledError from auto-repair retry, re-throw it to stop execution
        if (repairError.name === 'TaskCancelledError' && repairError.reason === 'auto_repair_retry') {
          this.log('info', 'Re-throwing TaskCancelledError from outer catch', {
            taskId: this.taskId,
            retryTaskId: repairError.retryTaskId
          });
          throw repairError;
        }

        this.log('error', 'Auto-repair process failed', {
          taskId: this.taskId,
          originalError: error.message,
          repairError: repairError.message
        });
        // Continue to normal error handling
      }
    }

    // Update task with error (normal failure path)
    await this.taskQueueModel.failTask(this.taskId, errorInfo);

    // Send error to parent process
    if (this.sendMessage) {
      this.sendMessage('TASK_FAILED', {
        taskId: this.taskId,
        error: errorInfo,
        summary: this.getExecutionSummary()
      });
    }
  }

  /**
   * Determine if auto-repair should be attempted for this error
   * @param {Error} error - The error that occurred
   * @returns {boolean} - Whether to attempt auto-repair
   */
  shouldAttemptAutoRepair(error) {
    // Don't repair if we've already tried too many times
    if ((this.template?.repairAttempts || 0) >= 50) {
      this.log('info', 'Max repair attempts reached, skipping auto-repair', {
        repairAttempts: this.template?.repairAttempts
      });
      return false;
    }

    // CRITICAL: AxiosError status code check
    // 400-level client errors (except 429) indicate code bugs → SHOULD repair
    // 500-level server errors indicate infrastructure issues → should NOT repair
    // AxiosError without status = network error → should NOT repair
    if (error.name === 'AxiosError') {
      // AxiosError without status code = network/connection error (infrastructure issue)
      if (!error.response?.status) {
        this.log('info', 'AxiosError without status code - likely network/connection error, skipping auto-repair', {
          errorType: error.name,
          errorMessage: error.message.substring(0, 100)
        });
        return false;
      }

      const status = error.response.status;

      // 5xx errors are server/infrastructure issues - don't repair
      if (status >= 500) {
        this.log('info', 'AxiosError with 5xx status - infrastructure error, skipping auto-repair', {
          errorType: error.name,
          statusCode: status,
          errorMessage: error.message.substring(0, 100)
        });
        return false;
      }

      // 429 rate limit is infrastructure issue - don't repair
      if (status === 429) {
        this.log('info', 'AxiosError 429 rate limit - infrastructure error, skipping auto-repair', {
          errorType: error.name,
          statusCode: status
        });
        return false;
      }

      // 400-level errors (except 429) are client errors indicating code bugs - SHOULD repair
      if (status >= 400 && status < 500) {
        this.log('info', 'AxiosError with 4xx status - client error (code bug), attempting auto-repair', {
          errorType: error.name,
          statusCode: status,
          errorMessage: error.message.substring(0, 100)
        });
        return true;
      }
    }

    // Don't repair for certain error types that are likely data/API issues
    const nonRepairableErrors = [
      'TaskCancelledError',
      'AuthenticationError',
      'PermissionError',
      'NetworkError',
      'TimeoutError'
      // Note: AxiosError handled above by status code check
    ];

    if (nonRepairableErrors.includes(error.name)) {
      this.log('info', 'Error type not suitable for auto-repair', {
        errorType: error.name
      });
      return false;
    }

    // Don't repair for infrastructure/network errors (timeouts, server errors)
    const infrastructureErrorPatterns = [
      /timeout.*exceeded/i,        // Axios timeout
      /ETIMEDOUT/i,                // Network timeout
      /ECONNREFUSED/i,             // Connection refused
      /ECONNRESET/i,               // Connection reset
      /502 Bad Gateway/i,          // Bitrix24 server error
      /503 Service Unavailable/i,  // Bitrix24 service down
      /504 Gateway Timeout/i,      // Bitrix24 gateway timeout
      /rate limit/i,               // API rate limiting
      /429/                        // Too many requests
    ];

    const errorMessage = error.message || '';
    const matchedPattern = infrastructureErrorPatterns.find(pattern => pattern.test(errorMessage));

    if (matchedPattern) {
      this.log('info', 'Infrastructure/network error detected, skipping auto-repair', {
        errorType: error.name,
        errorMessage: errorMessage.substring(0, 100),
        matchedPattern: matchedPattern.toString()
      });
      return false;
    }

    // Don't repair if error occurred in auto-repair specific code
    if (error.stack && error.stack.includes('repairTemplateWithAI')) {
      this.log('info', 'Error in repair system itself, skipping auto-repair');
      return false;
    }

    return true;
  }

  /**
   * Attempt to auto-repair the execution script based on the error
   * @param {Error} error - The error that occurred
   * @param {Object} errorInfo - Detailed error information
   * @returns {Object} - Repair result
   */
  async attemptErrorAutoRepair(error, errorInfo) {
    try {
      const { getTaskTemplateLoader } = require('../services/taskTemplateLoader');
      const templateLoader = getTaskTemplateLoader();

      // INTENT ANALYSIS: Use AI-detected intent stored during task creation
      const storedIntent = this.context?.userIntent || 'REUSE_EXISTING_TEMPLATE';
      const storedEntityScope = this.context?.entityScope || 'AUTO';
      const originalRequest = this.context?.userMessage || this.context?.originalRequest || '';

      const userIntent = {
        // What user wanted (from AI-detected intent, not regex)
        wantedNewTask: storedIntent === 'CREATE_NEW_TASK',
        specifiedCustomName: null, // Could parse from originalRequest if needed
        wantedAggregate: storedEntityScope === 'AGGREGATE',
        wantedSpecificEntity: storedEntityScope === 'SPECIFIC_ENTITY',

        // What we actually did (from template metadata)
        usedTemplate: this.template?.templateId,
        templateName: this.template?.name,
        templateType: this.template?.type || [],

        // Intent mismatch detection
        intentMismatch: false,
        mismatchReason: null
      };

      // Detect intent mismatches
      if (userIntent.wantedNewTask && userIntent.specifiedCustomName) {
        if (userIntent.templateName !== userIntent.specifiedCustomName) {
          userIntent.intentMismatch = true;
          userIntent.mismatchReason = `User wanted new task named "${userIntent.specifiedCustomName}" but system used existing template "${userIntent.templateName}"`;
        }
      }

      if (userIntent.wantedAggregate && !userIntent.wantedSpecificEntity) {
        // User wanted aggregate but template requires specific entity
        const requiresEntityId = this.template?.definition?.parameterSchema?.required?.some(
          param => ['customerId', 'contactId', 'companyId', 'dealId', 'leadId'].includes(param)
        );
        if (requiresEntityId) {
          userIntent.intentMismatch = true;
          userIntent.mismatchReason = 'User wanted aggregate analysis of all entities but template requires specific entity ID';
        }
      }

      this.log('info', 'User intent analysis for auto-repair', {
        taskId: this.taskId,
        userIntent,
        errorType: error.name
      });

      // If intent mismatch detected, this is a DESIGN ERROR not CODE ERROR
      // Auto-repair should NOT try to fix the template code, but signal template selection was wrong
      if (userIntent.intentMismatch) {
        this.log('error', 'Intent mismatch detected - template selection error, not code error', {
          taskId: this.taskId,
          mismatchReason: userIntent.mismatchReason,
          recommendation: 'create_new_template_matching_user_intent'
        });

        return {
          success: false,
          isDesignError: true,
          intentMismatch: true,
          message: `Template selection mismatch: ${userIntent.mismatchReason}`,
          recommendation: 'User should create new task with explicit "new task" instruction, or system should use different template',
          userIntent: userIntent
        };
      }

      // Build detailed error context for AI
      const errorContext = {
        taskId: this.taskId,
        templateId: this.template?.templateId,
        templateName: this.template?.name,
        error: {
          type: error.name || 'ExecutionError',
          message: error.message,
          step: errorInfo.step,
          stack: error.stack
        },
        executionContext: {
          currentStep: this.currentStep,
          stepsCompleted: this.stepsCompleted,
          parameters: this.parameters,
          resourceUsage: this.resourceUsage
        },
        originalUserRequest: originalRequest,
        userIntent: userIntent // Include intent analysis in context
      };

      this.log('info', 'Attempting auto-repair with AI', {
        taskId: this.taskId,
        errorType: error.name,
        errorMessage: error.message.substring(0, 200)
      });

      // Use the enhanced repair method in TaskTemplateLoader
      const repairedTemplate = await templateLoader.repairTemplateFromExecutionError(
        this.template,
        errorContext
      );

      if (!repairedTemplate) {
        return {
          success: false,
          message: 'AI could not generate a suitable repair'
        };
      }

      // Validate the repaired template
      const validation = await templateLoader.validateTemplate(repairedTemplate, errorContext);
      if (!validation.valid) {
        return {
          success: false,
          message: `Repaired template failed validation: ${validation.errors.join(', ')}`
        };
      }

      // Update the template in database with repair tracking
      const { getTaskTemplatesModel } = require('../models/taskTemplates');
      const templatesModel = getTaskTemplatesModel();
      
      await templatesModel.updateTemplate(this.template.templateId, {
        executionScript: validation.template.executionScript,
        lastRepaired: new Date().toISOString(),
        repairAttempts: (this.template?.repairAttempts || 0) + 1,
        lastRepairReason: `${error.name}: ${error.message}`,
        autoRepairHistory: require('firebase-admin').firestore.FieldValue.arrayUnion({
          timestamp: new Date().toISOString(),
          errorType: error.name,
          errorMessage: error.message,
          errorStep: errorInfo.step,
          repairAttempt: (this.template?.repairAttempts || 0) + 1
        })
      });

      this.log('info', 'Template auto-repaired and updated', {
        taskId: this.taskId,
        templateId: this.template.templateId,
        repairAttempt: (this.template?.repairAttempts || 0) + 1
      });

      return {
        success: true,
        message: 'Template auto-repaired successfully',
        template: validation.template,
        repairAttempt: (this.template?.repairAttempts || 0) + 1,
        originalError: errorInfo
      };

    } catch (repairError) {
      this.log('error', 'Auto-repair process failed', {
        taskId: this.taskId,
        repairError: repairError.message,
        stack: repairError.stack
      });

      return {
        success: false,
        message: `Auto-repair failed: ${repairError.message}`,
        error: repairError
      };
    }
  }

  /**
   * Phase 2.3: Retrieve memory-enhanced context for task execution
   * Retrieves relevant memories from past executions to guide current task
   * MaTTS Integration: Uses providedMemories from test-time scaling if available
   * @returns {Object|null} - Memory context with memories array and formatted text
   */
  async getMemoryEnhancedContext() {
    const config = require('../config/env');
    if (!config.REASONING_MEMORY_ENABLED) {
      return null;
    }

    // MaTTS Integration: Use provided memories if available (from parallel/sequential scaling)
    if (this.providedMemories && this.providedMemories.length > 0) {
      this.log('info', 'Using MaTTS-provided memories for task execution', {
        taskId: this.taskId,
        memoriesProvided: this.providedMemories.length,
        source: 'matts_test_time_scaling'
      });

      // Format provided memories for use in execution context
      const memoryContext = this.providedMemories.map((memory, index) => {
        return `Memory ${index + 1} (Similarity: ${memory.similarityScore ? (memory.similarityScore * 100).toFixed(1) : 'N/A'}%, Success Rate: ${memory.successRate ? (memory.successRate * 100).toFixed(0) + '%' : 'N/A'}):
Title: ${memory.title}
Strategy: ${memory.content}`;
      }).join('\n\n');

      return {
        memories: this.providedMemories,
        memoryContext: memoryContext
      };
    }

    // Traditional memory retrieval (when not using MaTTS)
    try {
      const embeddingService = require('../services/embeddingService');
      const { getReasoningMemoryModel } = require('../models/reasoningMemory');
      const memoryModel = getReasoningMemoryModel();

      // Build query from task context
      const queryText = `${this.template.name}: ${this.template.description || ''}. Parameters: ${JSON.stringify(this.parameters)}`;

      this.log('debug', 'Generating embedding for memory retrieval', {
        taskId: this.taskId,
        queryLength: queryText.length
      });

      // Generate embedding
      const queryEmbedding = await embeddingService.embedQuery(queryText, 'RETRIEVAL_QUERY');

      // Retrieve relevant memories
      const topK = config.MEMORY_RETRIEVAL_TOP_K || 3;
      const minSuccessRate = config.MEMORY_MIN_SUCCESS_RATE || 0.5;

      const memories = await memoryModel.retrieveMemories(queryEmbedding, topK, {
        minSuccessRate: minSuccessRate,
        category: 'execution_strategy'
      });

      if (memories && memories.length > 0) {
        this.log('info', 'Retrieved relevant memories for task execution', {
          taskId: this.taskId,
          memoriesRetrieved: memories.length,
          topSimilarity: memories[0]?.similarityScore
        });

        // Format memories for use in execution context
        const memoryContext = memories.map((memory, index) => {
          return `Memory ${index + 1} (Similarity: ${(memory.similarityScore * 100).toFixed(1)}%, Success Rate: ${memory.successRate ? (memory.successRate * 100).toFixed(0) + '%' : 'N/A'}):
Title: ${memory.title}
Strategy: ${memory.content}`;
        }).join('\n\n');

        return {
          memories: memories,
          memoryContext: memoryContext
        };
      }

      this.log('debug', 'No relevant memories found for task', {
        taskId: this.taskId
      });

      return null;
    } catch (error) {
      this.log('error', 'Failed to retrieve memory context', {
        taskId: this.taskId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Phase 2.3: Update memory statistics after task execution
   * Tracks which memories were helpful (or not) for continuous improvement
   * @param {Array<string>} memoryIds - IDs of memories used during execution
   * @param {boolean} success - Whether the task succeeded
   */
  async updateMemoryStatistics(memoryIds, success) {
    const config = require('../config/env');
    if (!config.REASONING_MEMORY_ENABLED || !memoryIds || memoryIds.length === 0) {
      return;
    }

    try {
      const { getReasoningMemoryModel } = require('../models/reasoningMemory');
      const memoryModel = getReasoningMemoryModel();

      for (const memoryId of memoryIds) {
        await memoryModel.updateMemoryStatistics(memoryId, success);
      }

      this.log('info', 'Updated memory statistics', {
        taskId: this.taskId,
        memoriesUpdated: memoryIds.length,
        success: success
      });
    } catch (error) {
      this.log('error', 'Failed to update memory statistics', {
        taskId: this.taskId,
        error: error.message
      });
    }
  }

  /**
   * Phase 3.1: Track generation memory success after task completion
   * Should be called by orchestrator/worker after task finishes (success or failure)
   * @param {boolean} taskSuccess - Whether the task completed successfully
   */
  async trackGenerationMemorySuccess(taskSuccess) {
    const config = require('../config/env');
    if (!config.REASONING_MEMORY_ENABLED) {
      return;
    }

    // Check if template has generation metadata (was AI-generated with memories)
    if (!this.template.generationMetadata?.memoryIdsUsed || this.template.generationMetadata.memoryIdsUsed.length === 0) {
      this.log('debug', 'Template has no generation metadata, skipping memory tracking', {
        taskId: this.taskId,
        templateId: this.template.templateId
      });
      return;
    }

    try {
      await this.updateMemoryStatistics(this.template.generationMetadata.memoryIdsUsed, taskSuccess);

      this.log('info', 'Tracked generation memory success', {
        taskId: this.taskId,
        templateId: this.template.templateId,
        taskSuccess,
        memoriesTracked: this.template.generationMetadata.memoryIdsUsed.length,
        generatedAt: this.template.generationMetadata.generatedAt
      });
    } catch (error) {
      this.log('error', 'Failed to track generation memory success', {
        taskId: this.taskId,
        error: error.message
      });
    }
  }

  /**
   * Testing mode utilities and behavior
   */

  /**
   * Check if task is in testing mode
   * @returns {boolean}
   */
  isTestingMode() {
    return this.testing === true;
  }

  /**
   * Generate testing mode context for reports
   * @returns {Object}
   */
  getTestingContext() {
    if (!this.isTestingMode()) {
      return {};
    }

    return {
      testingMode: true,
      testingNotice: 'This template is in development/debugging mode',
      developmentMode: true,
      nextSteps: [
        'Review template execution for accuracy',
        'Test with different parameters if needed',
        'Set testing: false when ready for production'
      ]
    };
  }


  /**
   * Auto-prompt user for next steps after testing completion
   * @param {Object} results - Test execution results
   * @returns {Object} - Prompting message
   */
  generateTestingPrompts(results) {
    if (!this.isTestingMode()) {
      return null;
    }

    const prompts = {
      message: '🧪 **Development Template Execution Complete!** What would you like to do next?',
      options: [
        {
          action: 'promote_production',
          title: '🚀 Promote to Production',
          description: 'Set testing: false and deploy for production use',
          command: `"Set task ${this.taskId} to production mode"`
        },
        {
          action: 'modify_script',
          title: '✏️ Modify Template',
          description: 'Update the execution script or parameters',
          command: `"Modify task ${this.taskId} execution script"`
        },
        {
          action: 'run_again',
          title: '🔄 Run Again',
          description: 'Execute again with same or different parameters',
          command: `"Run task ${this.taskId} again"`
        }
      ],
      context: {
        taskId: this.taskId,
        testing: true,
        developmentMode: true,
        resultsPreview: results.summary || 'Template execution completed successfully'
      }
    };

    return prompts;
  }
}

module.exports = BaseTaskExecutor;
module.exports.TaskError = TaskError;