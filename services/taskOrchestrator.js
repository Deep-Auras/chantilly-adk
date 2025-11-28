const { GoogleGenAI } = require('@google/genai');
const { extractGeminiText, getGeminiModelName } = require('../config/gemini');
const { logger } = require('../utils/logger');
const { getTaskQueueModel } = require('../models/taskQueue');
const { getTaskTemplatesModel } = require('../models/taskTemplates');
const { getWorkerProcessesModel } = require('../models/workerProcesses');
const { getTaskTemplateLoader } = require('./taskTemplateLoader');
const { getCloudTasksQueue } = require('./cloudTasksQueue');
const config = require('../config/env');

/**
 * TaskOrchestrator - Manages complex task execution with template support
 * 
 * This service orchestrates the creation, assignment, and monitoring of complex
 * multi-step tasks using dynamic templates and worker processes.
 */
class TaskOrchestrator {
  constructor() {
    this.taskQueueModel = getTaskQueueModel();
    this.templatesModel = getTaskTemplatesModel();
    this.workerProcessesModel = getWorkerProcessesModel();
    this.templateLoader = getTaskTemplateLoader();
    this.cloudTasksQueue = getCloudTasksQueue();
    this.genAI = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    
    // In-memory task queue for immediate processing
    this.pendingTasks = new Map();
    
    // Worker pool management
    this.workerPool = new Map();
    this.maxWorkers = 4;
    
    // Monitoring intervals
    this.monitoringInterval = null;
    this.cleanupInterval = null;
    
    // Statistics
    this.stats = {
      tasksCreated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      avgExecutionTime: 0,
      workersActive: 0
    };
  }

  /**
   * Initialize the orchestrator
   */
  async initialize() {
    try {
      logger.info('Initializing TaskOrchestrator');
      
      // Initialize models
      await this.taskQueueModel.initialize();
      await this.templatesModel.initialize();
      await this.workerProcessesModel.initialize();
      
      // Load pending tasks from database
      await this.loadPendingTasks();
      
      // Start monitoring and cleanup intervals
      this.startMonitoring();
      
      logger.info('TaskOrchestrator initialized successfully', {
        maxWorkers: this.maxWorkers,
        pendingTasks: this.pendingTasks.size
      });
    } catch (error) {
      logger.error('Failed to initialize TaskOrchestrator', { error: error.message });
      throw error;
    }
  }

  /**
   * Create a task from template
   * @param {string} templateId - Template identifier
   * @param {Object} parameters - Task parameters
   * @param {string} userId - User who created the task
   * @param {Object} options - Additional options
   * @returns {Object} - Task creation result
   */
  async createTaskFromTemplate(templateId, parameters, userId, options = {}) {
    try {
      // CRITICAL: Clear template cache before loading to ensure we get the latest version
      // This is especially important for retry tasks after auto-repair modifications
      if (options.clearCache === true) {
        this.templatesModel.clearCache();
        logger.info('Template cache cleared before loading', { templateId, reason: 'retry_after_modification' });
      }

      // Load template with original request context for auto-repair
      const originalRequest = { message: options.userMessage, context: options.messageContext };
      const template = await this.templateLoader.loadTemplate(templateId, originalRequest);
      
      // Validate parameters against schema
      await this.validateParameters(parameters, template.definition.parameterSchema);
      
      // Estimate task complexity and duration
      const estimation = this.estimateTaskFromTemplate(template, parameters);
      
      // Create agentic task ID with timestamp and contextual suffix
      const timestamp = Date.now();
      const contextualSuffix = await this.generateContextualSuffix(template, options.userMessage || '', parameters);
      const taskId = `task_${timestamp}_${contextualSuffix}`;
      
      const taskData = {
        taskId,
        templateId,
        templateVersion: template.version,
        type: template.category,
        status: 'pending',
        priority: options.priority || 50,
        testing: template.testing ?? (options.testing !== undefined ? options.testing : true), // Inherit from template or options
        definition: {
          ...template.definition,
          parameters,
          executionScript: template.executionScript
        },
        createdBy: userId,
        expiresAt: new Date(Date.now() + (options.ttlDays || 7) * 24 * 60 * 60 * 1000),
        tags: options.tags || [],
        // Store user message for AI date range detection in templates
        userMessage: options.userMessage,
        messageContext: options.messageContext
      };

      // Save to database
      const createdTaskId = await this.taskQueueModel.createTask(taskData);
      if (!createdTaskId) {
        throw new Error('Failed to create task in database');
      }

      // IMPORTANT: Use the actual task ID returned from database, not the generated one
      // This ensures consistency between what's stored and what's referenced
      const actualTaskId = createdTaskId;
      
      // Validate that the returned task ID matches what we expected
      if (actualTaskId !== taskId) {
        logger.warn('Task ID mismatch detected', {
          generatedTaskId: taskId,
          returnedTaskId: actualTaskId,
          templateId,
          userId
        });
      }

      // Enqueue task to Cloud Tasks for background processing
      const cloudTaskName = await this.cloudTasksQueue.enqueueTask({
        taskId: actualTaskId, // Use actual task ID from database
        templateId,
        parameters: parameters, // Pass enhanced parameters directly (don't default to {})
        userId,
        priority: options.priority || template.priority || 50
      });

      // Update task with Cloud Task reference
      await this.taskQueueModel.updateTask(actualTaskId, {
        'execution.cloudTaskName': cloudTaskName,
        'execution.enqueuedAt': new Date()
      });

      // Update statistics
      this.stats.tasksCreated++;

      logger.info('Task created and enqueued to Cloud Tasks', {
        taskId: actualTaskId, // Log the actual task ID
        templateId,
        cloudTaskName,
        userId,
        estimation
      });

      return {
        taskId: actualTaskId, // Return the actual task ID from database
        template,
        message: `✅ Task created using template: ${template.name}`,
        estimation
      };
    } catch (error) {
      logger.error('Failed to create task from template', {
        templateId,
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Auto-create task from user message
   * @param {string} message - User message
   * @param {Object} context - Message context
   * @param {string} userId - User ID
   * @param {Object} enhancedParameters - Pre-extracted parameters from ComplexTaskManager
   * @returns {Object|null} - Task creation result or null
   */
  async autoCreateFromMessage(message, context, userId, enhancedParameters = null) {
    try {
      // Use full original message for AI-powered template matching
      const fullMessage = context?.message || message;
      
      // Find matching template using AI-powered selection
      const template = await this.templateLoader.findTemplateByTrigger(fullMessage, context);
      
      if (!template) {
        logger.debug('No matching template found for message', {
          message: message.substring(0, 100),
          context
        });
        return null;
      }

      let parameters;
      
      if (enhancedParameters) {
        // Use enhanced parameters from ComplexTaskManager (includes Gemini-extracted date ranges)
        logger.info('Using enhanced parameters from ComplexTaskManager', {
          templateId: template.templateId,
          enhancedKeys: Object.keys(enhancedParameters),
          hasDateRange: !!enhancedParameters.dateRange
        });
        parameters = enhancedParameters;
      } else {
        // Fallback to standard AI parameter extraction
        parameters = await this.extractParametersWithAI(message, template);
      }
      
      // Create task with user message context
      const result = await this.createTaskFromTemplate(template.templateId, parameters, userId, {
        userMessage: message,
        messageContext: context
      });
      
      // Add confidence score
      result.confidence = 0.85; // Default confidence for auto-detection
      
      logger.info('Task auto-created from message', {
        taskId: result.taskId,
        templateId: template.templateId,
        message: message.substring(0, 100),
        usedEnhancedParameters: !!enhancedParameters
      });

      return result;
    } catch (error) {
      logger.error('Failed to auto-create task from message', {
        message: message.substring(0, 100),
        error: error.message
      });
      return null;
    }
  }

  /**
   * Extract parameters from message using AI
   * @param {string} message - User message
   * @param {Object} template - Task template
   * @returns {Object} - Extracted parameters
   */
  async extractParametersWithAI(message, template) {
    try {
      const prompt = `Extract task parameters from this user message for the "${template.name}" template.

User Message: "${message}"

Parameter Schema:
${JSON.stringify(template.definition.parameterSchema, null, 2)}

Return valid JSON object with extracted parameters. Use reasonable defaults for missing values.
Today's date: ${new Date().toISOString().split('T')[0]}

Guidelines:
- For date ranges, interpret relative terms like "this year", "last month", "Q1", etc.
- For filters, use logical defaults based on the template category
- For boolean flags, use template defaults or infer from context
- Ensure all required parameters are present

Example output format:
{
  "dateRange": {
    "start": "2024-01-01",
    "end": "2024-12-31"
  },
  "clientFilters": ["active"],
  "includeServices": true,
  "outputFormat": "detailed"
}`;

      const result = await this.genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });

      // Use centralized response extraction
      const responseText = extractGeminiText(result);

      // Parse JSON response
      let extractedParams;
      try {
        extractedParams = JSON.parse(responseText);
      } catch (parseError) {
        logger.warn('Failed to parse AI response as JSON, using defaults', {
          response: responseText,
          error: parseError.message
        });
        extractedParams = this.getDefaultParameters(template);
      }
      
      logger.debug('Parameters extracted with AI', {
        template: template.name,
        extracted: Object.keys(extractedParams),
        message: message.substring(0, 100)
      });
      
      return extractedParams;
    } catch (error) {
      logger.error('Failed to extract parameters with AI', {
        template: template.name,
        error: error.message
      });
      
      // Fallback to defaults
      return this.getDefaultParameters(template);
    }
  }

  /**
   * Get default parameters from template schema
   * @param {Object} template - Task template
   * @returns {Object} - Default parameters
   */
  getDefaultParameters(template) {
    const defaults = {};
    const schema = template.definition?.parameterSchema;
    
    if (schema?.properties) {
      for (const [key, fieldSchema] of Object.entries(schema.properties)) {
        if (fieldSchema.default !== undefined) {
          defaults[key] = fieldSchema.default;
        } else if (fieldSchema.type === 'array') {
          defaults[key] = [];
        } else if (fieldSchema.type === 'object') {
          defaults[key] = {};
        } else if (fieldSchema.type === 'boolean') {
          defaults[key] = false;
        }
      }
    }
    
    return defaults;
  }

  /**
   * Validate parameters against schema with type coercion
   * @param {Object} parameters - Parameters to validate (will be modified in-place for type coercion)
   * @param {Object} schema - JSON schema
   * @returns {boolean} - Validation result
   */
  async validateParameters(parameters, schema) {
    if (!schema) {
      return true; // No schema means no validation required
    }

    const errors = [];

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (parameters[field] === undefined || parameters[field] === null) {
          errors.push(`Required parameter missing: ${field}`);
        }
      }
    }

    // Type checking with automatic coercion
    if (schema.properties) {
      for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        const value = parameters[field];
        if (value !== undefined && value !== null && fieldSchema.type) {
          const actualType = Array.isArray(value) ? 'array' : typeof value;

          // Attempt type coercion if types don't match
          if (actualType !== fieldSchema.type) {
            let coercedValue = value;
            let coercionSuccessful = false;

            // String to Number coercion
            if (fieldSchema.type === 'number' && actualType === 'string') {
              const parsed = Number(value);
              if (!isNaN(parsed)) {
                coercedValue = parsed;
                coercionSuccessful = true;
                logger.info('Parameter type coercion applied', {
                  field,
                  originalValue: value,
                  originalType: 'string',
                  coercedValue,
                  coercedType: 'number'
                });
              }
            }

            // Number to String coercion
            else if (fieldSchema.type === 'string' && actualType === 'number') {
              coercedValue = String(value);
              coercionSuccessful = true;
              logger.info('Parameter type coercion applied', {
                field,
                originalValue: value,
                originalType: 'number',
                coercedValue,
                coercedType: 'string'
              });
            }

            // Boolean coercion
            else if (fieldSchema.type === 'boolean') {
              if (actualType === 'string') {
                coercedValue = value.toLowerCase() === 'true';
                coercionSuccessful = true;
              } else if (actualType === 'number') {
                coercedValue = value !== 0;
                coercionSuccessful = true;
              }
              if (coercionSuccessful) {
                logger.info('Parameter type coercion applied', {
                  field,
                  originalValue: value,
                  originalType: actualType,
                  coercedValue,
                  coercedType: 'boolean'
                });
              }
            }

            // String to Object coercion (JSON parsing) - handles Gemini stringifying nested objects
            else if (fieldSchema.type === 'object' && actualType === 'string') {
              try {
                coercedValue = JSON.parse(value);
                coercionSuccessful = true;
                logger.info('Parameter type coercion applied', {
                  field,
                  originalValue: value.substring(0, 100),
                  originalType: 'string',
                  coercedType: 'object',
                  coercionMethod: 'JSON.parse'
                });
              } catch (parseError) {
                logger.warn('Failed to parse string as JSON for object parameter', {
                  field,
                  value: value.substring(0, 100),
                  error: parseError.message
                });
                // coercionSuccessful remains false, will fall through to error
              }
            }

            // Array coercion from stringified JSON
            else if (fieldSchema.type === 'array' && actualType === 'string') {
              try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) {
                  coercedValue = parsed;
                  coercionSuccessful = true;
                  logger.info('Parameter type coercion applied', {
                    field,
                    originalValue: value.substring(0, 100),
                    originalType: 'string',
                    coercedType: 'array',
                    coercionMethod: 'JSON.parse',
                    arrayLength: parsed.length
                  });
                }
              } catch (parseError) {
                logger.warn('Failed to parse string as JSON array', {
                  field,
                  value: value.substring(0, 100),
                  error: parseError.message
                });
              }
            }

            if (coercionSuccessful) {
              // Apply coerced value back to parameters
              parameters[field] = coercedValue;
            } else {
              // Coercion failed, add error
              errors.push(`Parameter ${field}: expected ${fieldSchema.type}, got ${actualType} (coercion failed)`);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Parameter validation failed: ${errors.join(', ')}`);
    }

    return true;
  }

  /**
   * Generate contextual suffix for task ID using AI
   * @param {Object} template - Task template
   * @param {string} userMessage - Original user message
   * @param {Object} parameters - Task parameters
   * @returns {string} - Contextual suffix (e.g., "invoices_brooklyn")
   */
  async generateContextualSuffix(template, userMessage, parameters) {
    try {
      const prompt = `Generate a short, descriptive task ID suffix based on this context:

Template: ${template.name}
User Message: "${userMessage}"
Template Category: ${Array.isArray(template.category) ? template.category.join(', ') : template.category}

Create a 2-part suffix separated by underscore with:
1. First part: Task type/subject (e.g., "invoices", "reports", "contacts", "analysis")
2. Second part: Context/location/timeframe (e.g., "manhattan", "quarterly", "urgent", "recent")

Requirements:
- Use only lowercase letters, numbers, and underscores
- Maximum 20 characters total
- No spaces or special characters
- Make it meaningful and professional
- Examples: "invoices_manhattan", "reports_quarterly", "contacts_urgent", "analysis_recent"

Return ONLY the suffix (no "task_" prefix, no explanations):`;

      const response = await this.genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      });

      // Use centralized response extraction
      const responseText = extractGeminiText(response);
      let suffix = responseText.trim().toLowerCase();
      
      // Clean and validate the suffix
      suffix = suffix.replace(/[^a-z0-9_]/g, '').substring(0, 20);
      
      // Ensure it has the underscore format
      if (!suffix.includes('_')) {
        suffix = suffix.substring(0, 10) + '_task';
      }
      
      // Fallback if AI generation fails
      if (!suffix || suffix.length < 3) {
        const templateType = template.category?.[0] || 'general';
        const fallbackSuffix = templateType.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8);
        suffix = `${fallbackSuffix}_${Math.random().toString(36).substr(2, 6)}`;
      }
      
      return suffix;
    } catch (error) {
      logger.warn('Failed to generate contextual task ID suffix, using fallback', {
        error: error.message,
        templateName: template.name
      });
      
      // Fallback to template-based suffix
      const templateType = (template.category?.[0] || template.name || 'task')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .substring(0, 8);
      
      return `${templateType}_${Math.random().toString(36).substr(2, 6)}`;
    }
  }

  /**
   * Estimate task from template
   * @param {Object} template - Task template
   * @param {Object} parameters - Task parameters
   * @returns {Object} - Task estimation
   */
  estimateTaskFromTemplate(template, parameters) {
    const baseEstimation = {
      steps: template.definition.estimatedSteps || 5,
      duration: template.definition.estimatedDuration || 300000, // 5 minutes
      complexity: 'medium',
      requiredTools: template.definition.requiredTools || [],
      memoryRequirement: template.definition.memoryRequirement || '512MB'
    };

    // Adjust estimation based on parameters (template-specific logic could be added here)
    if (template.category === 'financial_reporting' && parameters.dateRange) {
      const startDate = new Date(parameters.dateRange.start);
      const endDate = new Date(parameters.dateRange.end);
      const daysDiff = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
      
      // Estimate based on date range
      const scaleFactor = Math.max(1, daysDiff / 365); // Scale by year
      baseEstimation.duration = Math.round(baseEstimation.duration * scaleFactor);
      baseEstimation.complexity = daysDiff > 365 ? 'high' : daysDiff > 90 ? 'medium' : 'low';
    }

    return baseEstimation;
  }

  /**
   * Process the task queue
   */
  async processTaskQueue() {
    try {
      // Get available workers
      const availableWorkers = await this.workerProcessesModel.getAvailableWorkers();
      
      if (availableWorkers.length === 0) {
        logger.debug('No available workers for task assignment');
        return;
      }

      // Process pending tasks
      for (const [taskId, taskData] of this.pendingTasks) {
        const suitableWorker = this.findSuitableWorker(availableWorkers, taskData);
        
        if (suitableWorker) {
          try {
            await this.assignTaskToWorker(taskData, suitableWorker);
            this.pendingTasks.delete(taskId);
            
            // Remove worker from available list for this iteration
            const workerIndex = availableWorkers.findIndex(w => w.workerId === suitableWorker.workerId);
            if (workerIndex > -1) {
              availableWorkers[workerIndex].availableSlots--;
              if (availableWorkers[workerIndex].availableSlots <= 0) {
                availableWorkers.splice(workerIndex, 1);
              }
            }
          } catch (error) {
            logger.error('Failed to assign task to worker', {
              taskId,
              workerId: suitableWorker.workerId,
              error: error.message
            });
          }
        }
        
        if (availableWorkers.length === 0) {
          break; // No more available workers
        }
      }
    } catch (error) {
      logger.error('Error processing task queue', { error: error.message });
    }
  }

  /**
   * Find suitable worker for task
   * @param {Array} availableWorkers - Available workers
   * @param {Object} taskData - Task data
   * @returns {Object|null} - Suitable worker or null
   */
  findSuitableWorker(availableWorkers, taskData) {
    // Filter workers by specialization
    const suitableWorkers = availableWorkers.filter(worker => {
      if (!worker.config?.specializations) {
        return true; // General purpose worker
      }
      return worker.config.specializations.includes(taskData.type);
    });

    if (suitableWorkers.length === 0) {
      return null;
    }

    // Sort by performance and availability
    suitableWorkers.sort((a, b) => {
      // Prioritize by available slots
      if (a.availableSlots !== b.availableSlots) {
        return b.availableSlots - a.availableSlots;
      }
      // Then by success rate
      const aSuccessRate = a.performance?.successRate || 0;
      const bSuccessRate = b.performance?.successRate || 0;
      return bSuccessRate - aSuccessRate;
    });

    return suitableWorkers[0];
  }

  /**
   * Assign task to worker
   * @param {Object} taskData - Task data
   * @param {Object} worker - Worker info
   */
  async assignTaskToWorker(taskData, worker) {
    try {
      // Update task status to running
      await this.taskQueueModel.updateTask(taskData.taskId, {
        status: 'running',
        'execution.workerId': worker.workerId,
        'execution.currentStep': 'initializing'
      });

      // Add task to worker
      await this.workerProcessesModel.addTaskToWorker(worker.workerId, taskData.taskId);

      // TODO: Send task to actual worker process
      // For now, this is a placeholder - in the full implementation,
      // this would spawn a worker process or send to existing worker
      
      logger.info('Task assigned to worker', {
        taskId: taskData.taskId,
        workerId: worker.workerId,
        template: taskData.template?.name
      });
    } catch (error) {
      logger.error('Failed to assign task to worker', {
        taskId: taskData.taskId,
        workerId: worker.workerId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Load pending tasks from database
   */
  async loadPendingTasks() {
    try {
      const pendingTasks = await this.taskQueueModel.getPendingTasks(50);
      
      for (const task of pendingTasks) {
        // Load template for each task
        const template = await this.templateLoader.loadTemplate(task.templateId);
        
        this.pendingTasks.set(task.taskId, {
          ...task,
          template,
          estimation: this.estimateTaskFromTemplate(template, task.definition.parameters)
        });
      }
      
      logger.info('Pending tasks loaded', { count: this.pendingTasks.size });
    } catch (error) {
      logger.error('Failed to load pending tasks', { error: error.message });
    }
  }

  /**
   * Start monitoring intervals
   */
  startMonitoring() {
    // Task queue processing interval
    this.monitoringInterval = setInterval(async () => {
      await this.processTaskQueue();
      await this.updateStatistics();
    }, 5000); // Every 5 seconds

    // Cleanup interval
    this.cleanupInterval = setInterval(async () => {
      await this.cleanupExpiredTasks();
      await this.cleanupInactiveWorkers();
    }, 60000); // Every minute

    logger.info('Monitoring intervals started');
  }

  /**
   * Stop monitoring intervals
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    logger.info('Monitoring intervals stopped');
  }

  /**
   * Update statistics
   */
  async updateStatistics() {
    try {
      const queueStats = await this.taskQueueModel.getQueueStats();
      const workerStats = await this.workerProcessesModel.getWorkerPoolStats();
      
      this.stats = {
        ...this.stats,
        pendingTasks: queueStats.pending,
        runningTasks: queueStats.running,
        completedTasks: queueStats.completed,
        workersActive: workerStats.running + workerStats.idle,
        workersTotal: workerStats.total
      };
    } catch (error) {
      logger.error('Failed to update statistics', { error: error.message });
    }
  }

  /**
   * Cleanup expired tasks
   */
  async cleanupExpiredTasks() {
    try {
      const cleaned = await this.taskQueueModel.cleanupExpiredTasks();
      if (cleaned > 0) {
        logger.info('Expired tasks cleaned up', { count: cleaned });
      }
    } catch (error) {
      logger.error('Failed to cleanup expired tasks', { error: error.message });
    }
  }

  /**
   * Cleanup inactive workers
   */
  async cleanupInactiveWorkers() {
    try {
      const cleaned = await this.workerProcessesModel.cleanupInactiveWorkers();
      if (cleaned > 0) {
        logger.info('Inactive workers cleaned up', { count: cleaned });
      }
    } catch (error) {
      logger.error('Failed to cleanup inactive workers', { error: error.message });
    }
  }

  /**
   * Get orchestrator status
   * @returns {Object} - Status information
   */
  getStatus() {
    return {
      initialized: this.monitoringInterval !== null,
      stats: this.stats,
      pendingTasksInMemory: this.pendingTasks.size,
      workersInPool: this.workerPool.size,
      maxWorkers: this.maxWorkers
    };
  }

  /**
   * Retry a failed task with auto-repaired template
   * @param {string} taskId - Original task ID
   * @param {Object} repairResult - Auto-repair result
   * @returns {Object} - Retry result
   */
  async retryTaskWithRepairedTemplate(taskId, repairResult, userId = null) {
    try {
      // Get the original task
      const originalTask = await this.taskQueueModel.getTask(taskId);
      if (!originalTask) {
        throw new Error(`Original task not found: ${taskId}`);
      }

      // Check for infinite loop prevention - count retry attempts in task ID
      const retryCount = (taskId.match(/_retry_/g) || []).length;
      const maxRetries = 3; // Maximum retry attempts to prevent infinite loops
      
      if (retryCount >= maxRetries) {
        logger.error('Maximum retry attempts reached, stopping infinite loop', {
          taskId: taskId,
          retryCount: retryCount,
          maxRetries: maxRetries,
          templateId: originalTask.templateId
        });
        
        // Mark the original task as permanently failed
        await this.taskQueueModel.updateTask(taskId, {
          status: 'failed_max_retries',
          failureReason: 'Maximum auto-repair retry attempts exceeded',
          maxRetriesReached: true,
          finalRetryCount: retryCount
        });
        
        return {
          success: false,
          error: 'Maximum retry attempts exceeded',
          message: `Task ${taskId} failed after ${retryCount} auto-repair attempts. Please review the template manually.`,
          retryCount: retryCount,
          maxRetriesReached: true
        };
      }

      logger.info('Retrying task with auto-repaired template', {
        originalTaskId: taskId,
        templateId: originalTask.templateId,
        repairAttempt: repairResult.repairAttempt,
        retryCount: retryCount,
        maxRetries: maxRetries
      });

      // Update original task status to indicate auto-repair occurred
      await this.taskQueueModel.updateTask(taskId, {
        status: 'auto_repaired',
        autoRepairInfo: {
          timestamp: new Date().toISOString(),
          originalError: repairResult.originalError,
          repairAttempt: repairResult.repairAttempt,
          repairedTemplateVersion: repairResult.template?.version
        }
      });

      // Create a unique retry task ID with timestamp to prevent duplicates
      const timestamp = Date.now();
      const retryTaskId = `${taskId}_retry_${repairResult.repairAttempt}_${timestamp}`;
      
      // Check if a retry task already exists for this original task
      const existingRetryTask = await this.taskQueueModel.getTasksByField('parentTaskId', taskId);
      const hasActiveRetry = existingRetryTask.some(task => 
        task.status === 'pending' || task.status === 'running' || task.status === 'queued'
      );
      
      if (hasActiveRetry) {
        logger.warn('Active retry task already exists, skipping duplicate retry creation', {
          originalTaskId: taskId,
          existingRetryTasks: existingRetryTask.length,
          activeRetryTasks: existingRetryTask.filter(t => ['pending', 'running', 'queued'].includes(t.status)).length
        });
        return {
          success: false,
          error: 'Active retry task already exists',
          message: `Retry task already exists for ${taskId}`
        };
      }
      
      const retryTaskData = {
        ...originalTask,
        taskId: retryTaskId,
        status: 'pending',
        parentTaskId: taskId, // Link to original task
        retryAttempt: repairResult.repairAttempt,
        testing: true, // Always retry in testing mode first
        createdAt: new Date().toISOString(),
        autoRepairInfo: {
          isRetry: true,
          originalTaskId: taskId,
          repairReason: repairResult.originalError?.message,
          repairAttempt: repairResult.repairAttempt,
          retryTimestamp: timestamp
        }
      };

      // Remove fields that shouldn't be copied
      delete retryTaskData.errors;
      delete retryTaskData.progress;
      delete retryTaskData.completedAt;
      delete retryTaskData.failedAt;

      // Create the retry task
      const createdRetryTaskId = await this.taskQueueModel.createTask(retryTaskData);
      if (!createdRetryTaskId) {
        throw new Error('Failed to create retry task');
      }

      // Immediately queue the retry task for execution
      await this.taskQueueModel.updateTask(retryTaskId, {
        status: 'queued',
        queuedAt: new Date().toISOString()
      });

      // Validate userId before enqueueing retry task
      const retryUserId = originalTask.createdBy || userId;
      
      if (!retryUserId) {
        logger.error('Cannot create retry task: no userId available', {
          taskId,
          originalTaskId: taskId,
          hasCreatedBy: !!originalTask.createdBy,
          providedUserId: !!userId,
          originalTaskFields: Object.keys(originalTask)
        });
        return {
          success: false,
          error: 'Missing userId for retry task',
          message: `Cannot retry task ${taskId}: no user context available`
        };
      }

      logger.info('Creating retry task with userId', {
        retryTaskId,
        originalTaskId: taskId,
        userId: retryUserId,
        source: originalTask.createdBy ? 'originalTask.createdBy' : 'provided userId'
      });

      // Submit retry task to Cloud Tasks queue for execution
      const cloudTaskName = await this.cloudTasksQueue.enqueueTask({
        taskId: retryTaskId,
        templateId: originalTask.templateId,
        parameters: originalTask.definition?.parameters || {},
        userId: retryUserId,  // Use validated userId
        priority: originalTask.priority || 50
      });

      logger.info('Retry task created and queued', {
        originalTaskId: taskId,
        retryTaskId: retryTaskId,
        templateId: originalTask.templateId,
        cloudTaskName: cloudTaskName
      });

      return {
        success: true,
        retryTaskId: retryTaskId,
        originalTaskId: taskId,
        message: `Task ${taskId} auto-repaired and retrying as ${retryTaskId}`
      };

    } catch (error) {
      logger.error('Failed to retry task with repaired template', {
        taskId: taskId,
        error: error.message
      });

      return {
        success: false,
        error: error.message,
        message: `Failed to retry task ${taskId}: ${error.message}`
      };
    }
  }

  /**
   * Shutdown orchestrator
   */
  async shutdown() {
    logger.info('Shutting down TaskOrchestrator');
    
    this.stopMonitoring();
    
    // Clear pending tasks
    this.pendingTasks.clear();
    this.workerPool.clear();
    
    logger.info('TaskOrchestrator shutdown complete');
  }
}

// Singleton instance
let instance = null;

function getTaskOrchestrator() {
  if (!instance) {
    instance = new TaskOrchestrator();
  }
  return instance;
}

module.exports = {
  TaskOrchestrator,
  getTaskOrchestrator
};