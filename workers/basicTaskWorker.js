const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { logger } = require('../utils/logger');
const { getTaskQueueModel } = require('../models/taskQueue');
const { getWorkerProcessesModel } = require('../models/workerProcesses');
const { getTaskTemplateLoader } = require('../services/taskTemplateLoader');
const { IsolatedTaskWorker } = require('./isolatedTaskWorker');
const { getMemoryTestTimeScaling } = require('../services/memoryTestTimeScaling');
const config = require('../config/env');

/**
 * BasicTaskWorker - Worker process for executing complex tasks
 * 
 * This worker runs in a separate thread and executes tasks using the
 * template system. It provides:
 * - Isolated execution environment
 * - Progress reporting to parent process
 * - Resource monitoring
 * - Error handling and recovery
 * - Checkpoint system for long-running tasks
 */

// Worker configuration
const WORKER_CONFIG = {
  maxConcurrentTasks: 2,
  heartbeatInterval: 5000, // 5 seconds
  healthCheckInterval: 30000, // 30 seconds
  maxExecutionTime: 3600000, // 1 hour
  specializations: ['financial_reporting', 'client_management', 'business_analysis']
};

class BasicTaskWorker {
  constructor(workerId) {
    this.workerId = workerId || this.generateWorkerId();
    this.status = 'starting';
    this.currentTasks = new Map();
    this.startTime = Date.now();

    // Models and services
    this.taskQueueModel = null;
    this.workerProcessesModel = null;
    this.templateLoader = null;
    this.mattsService = null; // MaTTS test-time scaling service

    // Isolated task execution
    this.isolatedWorker = new IsolatedTaskWorker({
      maxMemoryMB: 512,
      taskTimeout: 300000, // 5 minutes
      maxConcurrentTasks: WORKER_CONFIG.maxConcurrentTasks
    });

    // Monitoring
    this.heartbeatTimer = null;
    this.healthCheckTimer = null;
    this.resourceUsage = {
      peakMemory: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      totalExecutionTime: 0
    };

    // Bind methods
    this.handleMessage = this.handleMessage.bind(this);
    this.sendHeartbeat = this.sendHeartbeat.bind(this);
    this.performHealthCheck = this.performHealthCheck.bind(this);
  }

  /**
   * Initialize the worker
   */
  async initialize() {
    try {
      logger.info('Initializing BasicTaskWorker', { workerId: this.workerId });
      
      // Initialize models and services
      this.taskQueueModel = getTaskQueueModel();
      this.workerProcessesModel = getWorkerProcessesModel();
      this.templateLoader = getTaskTemplateLoader();
      this.mattsService = getMemoryTestTimeScaling(); // Initialize MaTTS service

      await this.taskQueueModel.initialize();
      await this.workerProcessesModel.initialize();
      
      // Register worker in database
      await this.registerWorker();
      
      // Set up monitoring
      this.startMonitoring();
      
      // Set up message handling
      if (parentPort) {
        parentPort.on('message', this.handleMessage);
      }
      
      this.status = 'idle';
      await this.updateWorkerStatus('idle');
      
      logger.info('BasicTaskWorker initialized successfully', { 
        workerId: this.workerId,
        specializations: WORKER_CONFIG.specializations 
      });
      
      // Notify parent that worker is ready
      this.sendMessage('WORKER_READY', { workerId: this.workerId });
      
    } catch (error) {
      logger.error('Failed to initialize BasicTaskWorker', { 
        workerId: this.workerId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Register worker in database
   */
  async registerWorker() {
    const workerData = {
      workerId: this.workerId,
      type: 'basic_task_worker',
      pid: process.pid,
      config: WORKER_CONFIG,
      performance: {
        avgTaskDuration: 0,
        tasksPerHour: 0,
        successRate: 100,
        apiCallsPerTask: 0,
        memoryEfficiency: 0
      }
    };

    const registered = await this.workerProcessesModel.registerWorker(workerData);
    if (!registered) {
      throw new Error('Failed to register worker in database');
    }
  }

  /**
   * Handle messages from parent process
   * @param {Object} message - Message from parent
   */
  async handleMessage(message) {
    try {
      const { type, data } = message;
      
      switch (type) {
      case 'EXECUTE_TASK':
        await this.executeTask(data);
        break;
          
      case 'CANCEL_TASK':
        await this.cancelTask(data.taskId);
        break;
          
      case 'STATUS_REQUEST':
        this.sendWorkerStatus();
        break;
          
      case 'SHUTDOWN':
        await this.shutdown();
        break;
          
      default:
        logger.warn('Unknown message type received', { type, workerId: this.workerId });
      }
    } catch (error) {
      logger.error('Error handling message', { 
        workerId: this.workerId, 
        error: error.message 
      });
    }
  }

  /**
   * Execute a task
   * @param {Object} taskData - Task to execute
   */
  async executeTask(taskData) {
    const taskId = taskData.taskId;
    
    try {
      logger.info('Starting task execution', { taskId, workerId: this.workerId });
      
      // Check if we can handle more tasks
      if (this.currentTasks.size >= WORKER_CONFIG.maxConcurrentTasks) {
        throw new Error('Worker at maximum capacity');
      }
      
      // Add to current tasks
      this.currentTasks.set(taskId, {
        taskData,
        startTime: Date.now(),
        status: 'running',
        executorMetadata: null // Will be set after isolated execution
      });
      
      this.status = 'running';
      await this.updateWorkerStatus('running');

      // ===== MaTTS Integration: Memory-aware Test-Time Scaling =====
      // Check if MaTTS is enabled (parallel or sequential scaling)
      const mattsEnabled = config.MATTS_PARALLEL_ENABLED || config.MATTS_SEQUENTIAL_ENABLED;
      let executionResult;

      if (mattsEnabled && config.REASONING_MEMORY_ENABLED) {
        logger.info('MaTTS enabled, using memory-aware test-time scaling', {
          taskId,
          parallelEnabled: config.MATTS_PARALLEL_ENABLED,
          sequentialEnabled: config.MATTS_SEQUENTIAL_ENABLED,
          workerId: this.workerId
        });

        // Define executeFunction for MaTTS - this will be called for each trajectory
        const executeFunction = async (task, memories) => {
          // Create modified taskData with provided memories
          const modifiedTaskData = {
            ...taskData,
            providedMemories: memories // Pass memories from MaTTS to executor
          };

          logger.debug('MaTTS executeFunction called', {
            taskId: task.taskId,
            memoriesProvided: memories.length,
            workerId: this.workerId
          });

          // Execute with provided memories
          return await this.isolatedWorker.executeTaskIsolated(taskId, modifiedTaskData);
        };

        // Decide between parallel or sequential scaling (parallel takes precedence)
        if (config.MATTS_PARALLEL_ENABLED) {
          // Parallel scaling: Generate N trajectories, select best
          const numVariants = config.MATTS_PARALLEL_VARIANTS || 3;
          executionResult = await this.mattsService.parallelScaling(
            taskData,
            executeFunction,
            numVariants
          );
        } else {
          // Sequential scaling: Iteratively refine trajectory
          const maxIterations = config.MATTS_SEQUENTIAL_ITERATIONS || 3;
          executionResult = await this.mattsService.sequentialScaling(
            taskData,
            executeFunction,
            null, // No reflection function yet (can be added later)
            maxIterations
          );
        }
      } else {
        // Traditional execution without MaTTS
        logger.debug('MaTTS disabled, using traditional execution', {
          taskId,
          mattsEnabled,
          reasoningMemoryEnabled: config.REASONING_MEMORY_ENABLED,
          workerId: this.workerId
        });

        executionResult = await this.isolatedWorker.executeTaskIsolated(taskId, taskData);
      }
      // ===== End MaTTS Integration =====

      // Store executor metadata for memory extraction
      if (executionResult.executorMetadata) {
        const taskInfo = this.currentTasks.get(taskId);
        if (taskInfo) {
          taskInfo.executorMetadata = executionResult.executorMetadata;
        }
      }

      // Check if execution was successful
      if (!executionResult.success) {
        throw new Error(executionResult.error || 'Task execution failed');
      }

      const result = executionResult.result;

      // Task completed successfully
      await this.taskCompleted(taskId, result);
      
    } catch (error) {
      await this.taskFailed(taskId, error);
    }
  }

  /**
   * Create execution context for task
   * @param {string} taskId - Task identifier
   * @returns {Object} - Execution context
   */
  createExecutionContext(taskId) {
    return {
      workerId: this.workerId,
      sendMessage: (type, data) => this.sendMessage(type, { taskId, ...data }),
      db: this.taskQueueModel.db,
      genAI: require('../config/gemini').getGeminiClient(),
      queueService: require('../services/bitrix24-queue'), // Add queue service for Bitrix24 API calls
      fileStorage: require('../utils/fileStorage').fileStorageManager, // Add file storage
      tools: {}, // Could inject tools here
      rateLimiters: {
        bitrix24: this.createRateLimiter('bitrix24', 2000), // 2 seconds between calls
        gemini: this.createRateLimiter('gemini', 1000) // 1 second between calls
      }
    };
  }

  /**
   * Create simple rate limiter
   * @param {string} name - Rate limiter name
   * @param {number} delay - Delay in milliseconds
   * @returns {Object} - Rate limiter
   */
  createRateLimiter(name, delay) {
    let lastCall = 0;
    
    return {
      async wait() {
        const now = Date.now();
        const timeSinceLastCall = now - lastCall;
        
        if (timeSinceLastCall < delay) {
          const waitTime = delay - timeSinceLastCall;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        lastCall = Date.now();
      }
    };
  }

  /**
   * Create task timeout promise
   * @param {string} taskId - Task identifier
   * @returns {Promise} - Timeout promise
   */
  createTaskTimeout(taskId) {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Task execution timeout: ${taskId}`));
      }, WORKER_CONFIG.maxExecutionTime);
    });
  }

  /**
   * Handle task completion
   * @param {string} taskId - Task identifier
   * @param {Object} result - Task result
   */
  async taskCompleted(taskId, result) {
    try {
      const taskInfo = this.currentTasks.get(taskId);
      if (!taskInfo) {return;}
      
      const executionTime = Date.now() - taskInfo.startTime;
      
      // Update task in database
      await this.taskQueueModel.completeTask(taskId, {
        ...result,
        executionTime,
        workerId: this.workerId
      });

      // ===== Phase 2.1: Extract memory from successful execution =====
      // Note: Phase 2.3 & 3.1 (memory statistics) are now handled in isolated worker
      const config = require('../config/env');
      if (config.REASONING_MEMORY_ENABLED && taskInfo.executorMetadata) {
        try {
          const { getMemoryExtractor } = require('../services/memoryExtractor');
          const memoryExtractor = getMemoryExtractor();

          const metadata = taskInfo.executorMetadata;
          if (metadata.template) {
            const trajectory = {
              templateId: metadata.template.templateId,
              templateName: metadata.template.name,
              templateDescription: metadata.template.description,
              taskId: taskId,
              parameters: metadata.parameters,
              steps: metadata.progressSteps,
              completionTime: executionTime,
              resourceUsage: metadata.resourceUsage
            };

            // Extract in background (don't block task completion)
            memoryExtractor.extractFromSuccess(trajectory).catch(err => {
              logger.error('Background memory extraction from success failed', {
                taskId: taskId,
                error: err.message
              });
            });

            logger.debug('Memory extraction initiated for successful task', {
              taskId: taskId,
              templateName: trajectory.templateName
            });
          }
        } catch (error) {
          logger.error('Failed to initiate memory extraction from success', {
            taskId: taskId,
            error: error.message
          });
        }
      }
      // ===== End Phase 2.1 memory extraction =====

      // Get task details for notification
      const task = await this.taskQueueModel.getTask(taskId);
      
      // Send completion notification to user
      if (task && task.createdBy) {
        await this.sendTaskNotification(task, 'completed', {
          executionTime,
          result
        });
      }
      
      // Remove from worker
      await this.workerProcessesModel.removeTaskFromWorker(this.workerId, taskId, true);
      
      // Update statistics
      this.resourceUsage.tasksCompleted++;
      this.resourceUsage.totalExecutionTime += executionTime;
      
      // Remove from current tasks
      this.currentTasks.delete(taskId);
      
      // Update status
      if (this.currentTasks.size === 0) {
        this.status = 'idle';
        await this.updateWorkerStatus('idle');
      }
      
      // Notify parent
      this.sendMessage('TASK_COMPLETED', {
        taskId,
        result,
        executionTime,
        workerId: this.workerId
      });
      
      logger.info('Task completed successfully', { 
        taskId, 
        executionTime, 
        workerId: this.workerId 
      });
      
    } catch (error) {
      logger.error('Error handling task completion', { 
        taskId, 
        workerId: this.workerId, 
        error: error.message 
      });
    }
  }

  /**
   * Handle task failure
   * @param {string} taskId - Task identifier
   * @param {Error} error - Task error
   */
  async taskFailed(taskId, error) {
    try {
      const taskInfo = this.currentTasks.get(taskId);
      const executionTime = taskInfo ? Date.now() - taskInfo.startTime : 0;
      
      // Update task in database
      await this.taskQueueModel.failTask(taskId, {
        type: 'execution_error',
        message: error.message,
        workerId: this.workerId,
        executionTime
      });

      // ===== Phase 2.1: Extract memory from failed execution =====
      // Note: Phase 2.3 & 3.1 (memory statistics) are now handled in isolated worker
      const config = require('../config/env');
      if (config.REASONING_MEMORY_ENABLED && taskInfo?.executorMetadata) {
        try {
          const { getMemoryExtractor } = require('../services/memoryExtractor');
          const memoryExtractor = getMemoryExtractor();

          const metadata = taskInfo.executorMetadata;
          if (metadata.template) {
            const trajectory = {
              templateId: metadata.template.templateId,
              templateName: metadata.template.name,
              templateDescription: metadata.template.description,
              taskId: taskId,
              parameters: metadata.parameters,
              steps: metadata.progressSteps,
              error: {
                name: error.name || 'Error',
                message: error.message,
                step: metadata.currentStep || 'unknown'
              },
              executionTime: executionTime
            };

            // Extract in background (don't block task failure handling)
            memoryExtractor.extractFromFailure(trajectory).catch(err => {
              logger.error('Background memory extraction from failure failed', {
                taskId: taskId,
                error: err.message
              });
            });

            logger.debug('Memory extraction initiated for failed task', {
              taskId: taskId,
              templateName: trajectory.templateName,
              errorType: error.name
            });
          }
        } catch (extractError) {
          logger.error('Failed to initiate memory extraction from failure', {
            taskId: taskId,
            error: extractError.message
          });
        }
      }
      // ===== End Phase 2.1 memory extraction =====

      // Get task details for notification
      const task = await this.taskQueueModel.getTask(taskId);
      
      // Send failure notification to user
      if (task && task.createdBy) {
        await this.sendTaskNotification(task, 'failed', {
          executionTime,
          error: {
            type: error.name,
            message: error.message
          }
        });
      }
      
      // Remove from worker
      await this.workerProcessesModel.removeTaskFromWorker(this.workerId, taskId, false);
      
      // Update statistics
      this.resourceUsage.tasksFailed++;
      
      // Remove from current tasks
      this.currentTasks.delete(taskId);
      
      // Update status
      if (this.currentTasks.size === 0) {
        this.status = 'idle';
        await this.updateWorkerStatus('idle');
      }
      
      // Notify parent
      this.sendMessage('TASK_FAILED', {
        taskId,
        error: {
          type: error.name,
          message: error.message
        },
        executionTime,
        workerId: this.workerId
      });
      
      logger.error('Task failed', { 
        taskId, 
        error: error.message, 
        executionTime, 
        workerId: this.workerId 
      });
      
    } catch (error) {
      logger.error('Error handling task failure', { 
        taskId, 
        workerId: this.workerId, 
        error: error.message 
      });
    }
  }

  /**
   * Cancel a task
   * @param {string} taskId - Task identifier
   */
  async cancelTask(taskId) {
    try {
      if (!this.currentTasks.has(taskId)) {
        logger.warn('Attempted to cancel non-existent task', { taskId, workerId: this.workerId });
        return;
      }
      
      // Get task details before removal
      const task = await this.taskQueueModel.getTask(taskId);
      const taskInfo = this.currentTasks.get(taskId);
      const executionTime = taskInfo ? Date.now() - taskInfo.startTime : 0;
      
      // Remove from current tasks
      this.currentTasks.delete(taskId);
      
      // Update task status
      await this.taskQueueModel.cancelTask(taskId);
      
      // Send cancellation notification to user
      if (task && task.createdBy) {
        await this.sendTaskNotification(task, 'cancelled', {
          executionTime
        });
      }
      
      // Remove from worker
      await this.workerProcessesModel.removeTaskFromWorker(this.workerId, taskId, false);
      
      // Update status if no more tasks
      if (this.currentTasks.size === 0) {
        this.status = 'idle';
        await this.updateWorkerStatus('idle');
      }
      
      logger.info('Task cancelled', { taskId, workerId: this.workerId });
      
    } catch (error) {
      logger.error('Error cancelling task', { 
        taskId, 
        workerId: this.workerId, 
        error: error.message 
      });
    }
  }

  /**
   * Start monitoring intervals
   */
  startMonitoring() {
    // Heartbeat
    this.heartbeatTimer = setInterval(this.sendHeartbeat, WORKER_CONFIG.heartbeatInterval);
    
    // Health check
    this.healthCheckTimer = setInterval(this.performHealthCheck, WORKER_CONFIG.healthCheckInterval);
  }

  /**
   * Send heartbeat to parent and update database
   */
  async sendHeartbeat() {
    try {
      const memoryUsage = process.memoryUsage();
      this.resourceUsage.peakMemory = Math.max(this.resourceUsage.peakMemory, memoryUsage.heapUsed);
      
      await this.workerProcessesModel.updateWorkerResources(this.workerId, {
        memoryUsage: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
        cpuUsage: '0%', // Could be enhanced with actual CPU monitoring
        uptime: Date.now() - this.startTime
      });
      
      this.sendMessage('HEARTBEAT', {
        workerId: this.workerId,
        status: this.status,
        currentTasks: this.currentTasks.size,
        resourceUsage: this.resourceUsage
      });
      
    } catch (error) {
      logger.error('Heartbeat failed', { workerId: this.workerId, error: error.message });
    }
  }

  /**
   * Perform health check
   */
  async performHealthCheck() {
    try {
      // Check if worker is healthy
      const memoryUsage = process.memoryUsage();
      const memoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
      
      // Warning if memory usage is high
      if (memoryMB > 1024) { // 1GB
        logger.warn('High memory usage detected', { 
          workerId: this.workerId, 
          memoryMB 
        });
      }
      
      // Check for stuck tasks
      const now = Date.now();
      for (const [taskId, taskInfo] of this.currentTasks) {
        const executionTime = now - taskInfo.startTime;
        if (executionTime > WORKER_CONFIG.maxExecutionTime * 0.8) { // 80% of max time
          logger.warn('Long running task detected', { 
            taskId, 
            executionTime, 
            workerId: this.workerId 
          });
        }
      }
      
    } catch (error) {
      logger.error('Health check failed', { workerId: this.workerId, error: error.message });
    }
  }

  /**
   * Update worker status in database
   * @param {string} status - New status
   */
  async updateWorkerStatus(status, additionalData = {}) {
    try {
      await this.workerProcessesModel.updateWorkerStatus(this.workerId, status, additionalData);
    } catch (error) {
      logger.error('Failed to update worker status', { 
        workerId: this.workerId, 
        status, 
        error: error.message 
      });
    }
  }

  /**
   * Send worker status to parent
   */
  sendWorkerStatus() {
    this.sendMessage('WORKER_STATUS', {
      workerId: this.workerId,
      status: this.status,
      currentTasks: Array.from(this.currentTasks.keys()),
      resourceUsage: this.resourceUsage,
      uptime: Date.now() - this.startTime,
      config: WORKER_CONFIG
    });
  }

  /**
   * Send message to parent process
   * @param {string} type - Message type
   * @param {Object} data - Message data
   */
  sendMessage(type, data) {
    if (parentPort) {
      parentPort.postMessage({ type, data });
    }
  }

  /**
   * Send task notification to user via Bitrix24
   * @param {Object} task - Task object
   * @param {string} status - Task status (completed, failed, cancelled)
   * @param {Object} details - Additional details
   */
  async sendTaskNotification(task, status, details) {
    try {
      const queueService = require('../services/bitrix24-queue');
      const { convertForBitrixChat } = require('../utils/markdownToBB');
      
      let message = '';
      const templateName = task.templateId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      switch (status) {
      case 'completed':
        message = '✅ **Task Completed!**\n\n';
        message += `Your **${templateName}** task has finished successfully.\n\n`;
        message += `**Task ID:** \`${task.taskId}\`\n`;
        message += `**Duration:** ${this.formatDuration(details.executionTime)}\n`;
          
        if (details.result?.summary) {
          message += `**Summary:** ${details.result.summary}\n`;
        }
          
        if (details.result?.attachments?.length > 0) {
          message += `**Files Generated:** ${details.result.attachments.length}\n`;
          details.result.attachments.forEach((attachment, index) => {
            message += `${index + 1}. **${attachment.name}** (${this.formatFileSize(attachment.size)})\n`;
            if (attachment.publicUrl) {
              message += `   Download: ${attachment.publicUrl}\n`;
            }
          });
        }
          
        message += `\n*Use \`task status ${task.taskId}\` to view full details.*`;
        break;
          
      case 'failed':
        message = '❌ **Task Failed**\n\n';
        message += `Your **${templateName}** task encountered an error and could not complete.\n\n`;
        message += `**Task ID:** \`${task.taskId}\`\n`;
        message += `**Duration:** ${this.formatDuration(details.executionTime)}\n`;
        message += `**Error:** ${details.error.message}\n\n`;
        message += '*Please try creating the task again or contact support if the issue persists.*';
        break;
          
      case 'cancelled':
        message = '🚫 **Task Cancelled**\n\n';
        message += `Your **${templateName}** task was cancelled as requested.\n\n`;
        message += `**Task ID:** \`${task.taskId}\`\n`;
        message += `**Duration:** ${this.formatDuration(details.executionTime)}\n\n`;
        message += '*The task was stopped before completion.*';
        break;
      }
      
      // Convert markdown to Bitrix24 BB code
      const bbMessage = convertForBitrixChat(message);
      
      // Send notification via queue (handles rate limiting)
      await queueService.add({
        method: 'imbot.message.add',
        params: {
          DIALOG_ID: task.createdBy, // Send to user who created the task
          MESSAGE: bbMessage
        }
      });
      
      logger.info('Task notification sent', {
        taskId: task.taskId,
        userId: task.createdBy,
        status,
        workerId: this.workerId
      });
      
    } catch (error) {
      logger.error('Failed to send task notification', {
        taskId: task.taskId,
        status,
        error: error.message,
        workerId: this.workerId
      });
      // Don't throw - notification failure shouldn't affect task completion
    }
  }

  /**
   * Format file size for display
   * @param {number} bytes - File size in bytes
   * @returns {string} - Formatted file size
   */
  formatFileSize(bytes) {
    if (!bytes) {return '0 B';}
    
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${Math.round(size * 10) / 10} ${units[unitIndex]}`;
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
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Generate unique worker ID
   * @returns {string} - Worker ID
   */
  generateWorkerId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `worker_${timestamp}_${random}`;
  }

  /**
   * Shutdown worker
   */
  async shutdown() {
    try {
      logger.info('Shutting down worker', { workerId: this.workerId });
      
      this.status = 'stopping';
      await this.updateWorkerStatus('stopping');
      
      // Clear timers
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }
      
      // Cancel running tasks
      for (const taskId of this.currentTasks.keys()) {
        await this.cancelTask(taskId);
      }
      
      // Update status to stopped
      await this.updateWorkerStatus('stopped');
      
      // Notify parent
      this.sendMessage('WORKER_SHUTDOWN', { workerId: this.workerId });
      
      logger.info('Worker shutdown complete', { workerId: this.workerId });
      
      // Exit process
      process.exit(0);
      
    } catch (error) {
      logger.error('Error during worker shutdown', { 
        workerId: this.workerId, 
        error: error.message 
      });
      process.exit(1);
    }
  }
}

// Worker execution logic
if (!isMainThread) {
  // This code runs in the worker thread
  const worker = new BasicTaskWorker(workerData?.workerId);
  
  // Handle uncaught exceptions
  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception in worker', { 
      workerId: worker.workerId, 
      error: error.message 
    });
    await worker.shutdown();
  });
  
  process.on('unhandledRejection', async (reason) => {
    logger.error('Unhandled rejection in worker', { 
      workerId: worker.workerId, 
      reason: reason.toString() 
    });
    await worker.shutdown();
  });
  
  // Initialize and start worker
  worker.initialize().catch(async (error) => {
    logger.error('Failed to initialize worker', { error: error.message });
    await worker.shutdown();
  });
}

module.exports = BasicTaskWorker;