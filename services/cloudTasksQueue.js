const { CloudTasksClient } = require('@google-cloud/tasks');
const { logger } = require('../utils/logger');
const { getFirestore } = require('../config/firestore');

/**
 * Simplified Google Cloud Tasks service following 2025 best practices
 *
 * This implementation follows the current Cloud Tasks documentation
 * and removes unnecessary complexity around authentication.
 *
 * Configuration loaded from Firestore agent/config:
 * - CLOUD_TASKS_LOCATION
 * - CLOUD_TASKS_QUEUE
 * - CLOUD_RUN_SERVICE_URL
 */
class CloudTasksQueue {
  constructor() {
    // Cloud Tasks client uses default application credentials automatically
    this.client = new CloudTasksClient();
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT; // Cloud Run provided
    this.location = null;
    this.queueName = null;
    this.serviceUrl = null;
    this.initialized = false;
  }

  /**
   * Initialize configuration from Firestore
   */
  async _ensureInitialized() {
    if (this.initialized) return;

    try {
      const db = getFirestore();
      const configDoc = await db.collection('agent').doc('config').get();

      if (configDoc.exists) {
        const config = configDoc.data();
        this.location = config.CLOUD_TASKS_LOCATION || 'us-central1';
        this.queueName = config.CLOUD_TASKS_QUEUE || 'chantilly-task-queue';
        this.serviceUrl = config.CLOUD_RUN_SERVICE_URL;
      } else {
        // Use defaults if no config
        this.location = 'us-central1';
        this.queueName = 'chantilly-task-queue';
      }

      this.initialized = true;
      logger.info('CloudTasksQueue initialized from Firestore', {
        location: this.location,
        queueName: this.queueName,
        hasServiceUrl: !!this.serviceUrl
      });
    } catch (error) {
      logger.error('Failed to initialize CloudTasksQueue from Firestore', {
        error: error.message
      });
      // Use defaults on error
      this.location = 'us-central1';
      this.queueName = 'chantilly-task-queue';
      this.initialized = true;
    }
  }

  /**
   * Create and enqueue a task for execution
   * @param {Object} taskData - Task data
   * @returns {Promise<string>} - Task name
   */
  async enqueueTask(taskData) {
    await this._ensureInitialized();

    try {
      const { taskId, templateId, parameters, userId, priority } = taskData;

      logger.info('Enqueuing task to Cloud Tasks', {
        taskId,
        templateId,
        userId,
        priority
      });

      // Construct the fully qualified queue name
      const parent = this.client.queuePath(this.projectId, this.location, this.queueName);

      // Task payload for the worker endpoint
      const payload = {
        taskId,
        templateId,
        parameters,
        userId,
        priority: priority || 50,
        enqueuedAt: new Date().toISOString()
      };

      // Create the task - simplified structure following 2025 examples
      const task = {
        httpRequest: {
          httpMethod: 'POST',
          url: `${this.serviceUrl}/worker/execute`,
          headers: {
            'Content-Type': 'application/json'
            // No Authorization header needed - Cloud Tasks handles authentication
          },
          body: Buffer.from(JSON.stringify(payload))
        }
      };

      // Add immediate or delayed execution based on priority
      if (priority && priority <= 80) {
        task.scheduleTime = {
          seconds: Math.floor(Date.now() / 1000) + 5 // 5 second delay for lower priority
        };
      }

      // Create task in queue
      const request = { parent, task };
      const [response] = await this.client.createTask(request);

      logger.info('Task enqueued successfully', {
        taskId,
        taskName: response.name,
        scheduleTime: response.scheduleTime
      });

      return response.name;
    } catch (error) {
      logger.error('Failed to enqueue task', {
        taskId: taskData.taskId,
        error: error.message,
        code: error.code
      });
      throw error;
    }
  }

  /**
   * Get task queue status and statistics
   * @returns {Promise<Object>} - Queue stats
   */
  async getQueueStats() {
    await this._ensureInitialized();

    try {
      const queuePath = this.client.queuePath(this.projectId, this.location, this.queueName);
      const [queue] = await this.client.getQueue({ name: queuePath });

      return {
        name: queue.name,
        state: queue.state,
        rateLimits: queue.rateLimits,
        retryConfig: queue.retryConfig
      };
    } catch (error) {
      logger.error('Failed to get queue stats', { 
        error: error.message,
        code: error.code 
      });
      throw error;
    }
  }

  /**
   * Ensure the task queue exists (optional - Cloud Tasks can auto-create)
   */
  async ensureQueueExists() {
    await this._ensureInitialized();

    try {
      const parent = this.client.locationPath(this.projectId, this.location);
      const queuePath = this.client.queuePath(this.projectId, this.location, this.queueName);

      // Check if queue exists
      try {
        await this.client.getQueue({ name: queuePath });
        logger.info('Task queue already exists', { queueName: this.queueName });
        return;
      } catch (error) {
        if (error.code !== 5) { // 5 = NOT_FOUND
          throw error;
        }
      }

      // Create queue if it doesn't exist
      logger.info('Creating task queue', { queueName: this.queueName });

      const queue = {
        name: queuePath,
        rateLimits: {
          maxDispatchesPerSecond: 10,
          maxBurstSize: 20,
          maxConcurrentDispatches: 5
        },
        retryConfig: {
          maxAttempts: 3,
          maxRetryDuration: {
            seconds: 1800 // 30 minutes
          },
          minBackoff: {
            seconds: 10
          },
          maxBackoff: {
            seconds: 300
          }
        }
      };

      await this.client.createQueue({
        parent,
        queue
      });

      logger.info('Task queue created successfully', { queueName: this.queueName });
    } catch (error) {
      if (error.code === 6) { // ALREADY_EXISTS
        logger.info('Task queue already exists', { queueName: this.queueName });
        return;
      }
      logger.error('Failed to ensure queue exists', { 
        error: error.message,
        code: error.code 
      });
      throw error;
    }
  }

  /**
   * Cancel a specific Cloud Task
   * @param {string} taskName - Full Cloud Task name
   * @returns {Promise<boolean>} - Success status
   */
  async cancelTask(taskName) {
    await this._ensureInitialized();

    try {
      if (!taskName) {
        logger.warn('Cannot cancel task: no task name provided');
        return false;
      }

      logger.info('Cancelling Cloud Task', { taskName });
      
      // Delete the task from Cloud Tasks queue
      await this.client.deleteTask({ name: taskName });
      
      logger.info('Cloud Task cancelled successfully', { taskName });
      return true;
    } catch (error) {
      // If task already completed or doesn't exist, consider it "cancelled"
      if (error.code === 5) { // NOT_FOUND
        logger.info('Cloud Task not found (already completed or cancelled)', { 
          taskName, 
          error: error.message 
        });
        return true;
      }
      
      logger.error('Failed to cancel Cloud Task', { 
        taskName,
        error: error.message,
        code: error.code 
      });
      return false;
    }
  }

  /**
   * Purge all tasks from the queue (for development/testing)
   */
  async purgeQueue() {
    await this._ensureInitialized();

    try {
      const queuePath = this.client.queuePath(this.projectId, this.location, this.queueName);
      
      logger.warn('Purging task queue', { queueName: this.queueName });
      await this.client.purgeQueue({ name: queuePath });
      
      logger.info('Task queue purged successfully');
    } catch (error) {
      logger.error('Failed to purge queue', { 
        error: error.message,
        code: error.code 
      });
      throw error;
    }
  }
}

// Singleton instance
let cloudTasksQueue = null;

function getCloudTasksQueue() {
  if (!cloudTasksQueue) {
    cloudTasksQueue = new CloudTasksQueue();
  }
  return cloudTasksQueue;
}

module.exports = {
  CloudTasksQueue,
  getCloudTasksQueue
};