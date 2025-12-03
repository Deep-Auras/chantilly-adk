/**
 * Asana Integration Service
 * Handles bidirectional communication with Asana API
 */

const asana = require('asana');
const crypto = require('crypto');
const { getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');
const { getEncryption } = require('../utils/encryption');

// Morgan Workflow Section Names
const MORGAN_SECTIONS = {
  PLANNING_COMPLETE: 'Morgan - Planning Complete',
  TASK_COMPLETED: 'Morgan - Task Completed',
  TASK_FAILED: 'Morgan - Task Failed',
  TRY_AGAIN: 'Morgan - Try Again'
};

class AsanaService {
  constructor() {
    this.client = null;
    this.workspaceGid = null;
    this.webhookSecret = null;
    this.botEmail = null;
    this.db = getFirestore();
    this.FieldValue = getFieldValue();
    this.encryption = getEncryption();
    this.initialized = false;
    this.pollers = new Map(); // For monitoring task execution
  }

  async initialize() {
    if (this.initialized) return;

    try {
      // Load config from Firestore
      const platformDoc = await this.db
        .collection('agent')
        .doc('platforms')
        .collection('asana')
        .doc('config')
        .get();

      if (!platformDoc.exists) {
        throw new Error('Asana platform configuration not found in Firestore');
      }

      const platformConfig = platformDoc.data();
      this.workspaceGid = platformConfig.workspaceGid;
      this.botEmail = platformConfig.botEmail;

      // Load credentials from Firestore
      const credentialsDoc = await this.db.collection('agent').doc('credentials').get();
      if (!credentialsDoc.exists) {
        throw new Error('Credentials not found in Firestore');
      }

      const credentials = credentialsDoc.data();

      // Decrypt webhook secret if encrypted
      if (credentials.asana_webhook_secret) {
        this.webhookSecret = await this.encryption.decryptCredential(credentials.asana_webhook_secret);
      }

      // Decrypt access token
      if (!credentials.asana_access_token) {
        throw new Error('Asana access token not found in credentials');
      }
      const accessToken = await this.encryption.decryptCredential(credentials.asana_access_token);

      // Asana SDK v3.x uses ApiClient pattern
      this.client = asana.ApiClient.instance;
      const token = this.client.authentications['token'];
      token.accessToken = accessToken;

      // Instantiate API classes
      this.tasksApi = new asana.TasksApi();
      this.webhooksApi = new asana.WebhooksApi();
      this.storiesApi = new asana.StoriesApi();
      this.sectionsApi = new asana.SectionsApi();
      this.projectsApi = new asana.ProjectsApi();

      this.initialized = true;
      logger.info('Asana service initialized from Firestore config', {
        workspaceGid: this.workspaceGid,
        botEmail: this.botEmail
      });
    } catch (error) {
      logger.error('Failed to initialize Asana service', { error: error.message });
      throw error;
    }
  }

  /**
   * Verify webhook HMAC signature
   */
  verifyWebhookSignature(body, signature) {
    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    hmac.update(body);
    const expectedSignature = hmac.digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Handle webhook handshake
   */
  handleHandshake(secret) {
    return {
      'X-Hook-Secret': secret
    };
  }

  /**
   * Create webhook for project/portfolio/workspace
   */
  async createWebhook(resourceGid, targetUrl, filters = null) {
    await this.initialize();

    try {
      const body = {
        data: {
          resource: resourceGid,
          target: targetUrl,
          filters: filters
        }
      };

      const result = await this.webhooksApi.createWebhook(body);
      const webhook = result.data;

      // Store webhook in Firestore
      await this.db.collection('asana-webhooks').doc(webhook.gid).set({
        gid: webhook.gid,
        resourceGid: resourceGid,
        targetUrl: targetUrl,
        filters: filters || null,
        active: true,
        created: this.FieldValue.serverTimestamp()
      });

      logger.info('Created Asana webhook', { gid: webhook.gid, resourceGid });
      return webhook;
    } catch (error) {
      logger.error('Failed to create Asana webhook', { error: error.message });
      throw error;
    }
  }

  /**
   * Handle webhook event
   */
  async handleWebhookEvent(event) {
    const { action, resource, parent } = event;

    logger.info('Asana webhook event', {
      action,
      resourceType: resource.resource_type,
      resourceGid: resource.gid
    });

    try {
      switch (resource.resource_type) {
        case 'task':
          return await this.handleTaskEvent(action, resource);
        case 'story':
          return await this.handleCommentEvent(action, resource, parent);
        case 'project':
          return await this.handleProjectEvent(action, resource);
        default:
          logger.info('Unhandled resource type', { resourceType: resource.resource_type });
      }
    } catch (error) {
      logger.error('Error handling Asana webhook event', { error: error.message });
    }
  }

  /**
   * Handle task event (enhanced with section-based workflow)
   */
  async handleTaskEvent(action, resource) {
    await this.initialize();

    if (action === 'added' || action === 'changed') {
      // Fetch full task details including memberships for section detection
      const opts = {
        opt_fields: 'name,notes,assignee,due_on,completed,projects,custom_fields,attachments,subtasks,memberships'
      };
      const result = await this.tasksApi.getTask(resource.gid, opts);
      const task = result.data;

      // PHASE 8: Section-based workflow triggering
      // Check each project membership for Morgan workflow sections
      if (task.memberships && task.memberships.length > 0) {
        for (const membership of task.memberships) {
          const sectionName = membership.section?.name;
          const projectGid = membership.project?.gid;

          if (sectionName && projectGid) {
            logger.info('Task section detected', {
              taskGid: task.gid,
              taskName: task.name,
              section: sectionName,
              project: membership.project?.name
            });

            // Route based on section
            switch (sectionName) {
              case MORGAN_SECTIONS.PLANNING_COMPLETE:
                // PHASE 9: Create complex task from Asana structure
                await this.processPlanningCompleteTask(task, projectGid);
                return; // Don't process further

              case MORGAN_SECTIONS.TRY_AGAIN:
                // PHASE 11: Retry with user modifications
                await this.processRetryTask(task, projectGid);
                return; // Don't process further

              default:
                // Not a trigger section, continue to legacy processing
                break;
            }
          }
        }
      }

      // Legacy processing: Check if Morgan should process this task (assignment/mention)
      if (this.shouldProcessTask(task)) {
        await this.processTaskForMorgan(task);
      }
    }

    if (action === 'deleted') {
      logger.info('Task deleted', { gid: resource.gid });
    }
  }

  /**
   * Check if Morgan should process this task
   */
  shouldProcessTask(task) {
    // Check if assigned to Morgan (botEmail loaded from Firestore)
    if (task.assignee && task.assignee.email === this.botEmail) {
      return true;
    }

    // Check if mentioned in notes or description
    if (task.notes && task.notes.includes('@morgan')) {
      return true;
    }

    return false;
  }

  /**
   * Process task assigned to Morgan
   */
  async processTaskForMorgan(task) {
    logger.info('Processing task for Morgan', {
      gid: task.gid,
      name: task.name
    });

    // Generate AI response
    const { getGeminiService } = require('./gemini');
    const gemini = getGeminiService();

    const response = await gemini.generateResponse(
      `Task assigned: ${task.name}\n\nDescription: ${task.notes}`,
      {
        platform: 'asana',
        taskGid: task.gid
      }
    );

    // Add comment to task with Morgan's response
    await this.addComment(task.gid, response);
  }

  /**
   * Create task in Asana
   */
  async createTask(projectGid, data) {
    await this.initialize();

    try {
      const body = {
        data: {
          projects: [projectGid],
          name: data.name,
          notes: data.notes || '',
          due_on: data.dueDate || null,
          assignee: data.assignee || null
        }
      };

      // If section provided, add it to memberships during creation
      if (data.sectionGid) {
        body.data.memberships = [
          {
            project: projectGid,
            section: data.sectionGid
          }
        ];
      }

      const result = await this.tasksApi.createTask(body);
      const task = result.data;

      logger.info('Created Asana task', {
        gid: task.gid,
        name: task.name,
        section: data.sectionGid || 'default'
      });
      return task;
    } catch (error) {
      logger.error('Failed to create Asana task', { error: error.message });
      throw error;
    }
  }

  /**
   * Update task status
   */
  async updateTaskStatus(taskGid, completed) {
    await this.initialize();

    try {
      const body = {
        data: {
          completed: completed
        }
      };

      const result = await this.tasksApi.updateTask(body, taskGid);
      const task = result.data;

      logger.info('Updated task status', { gid: taskGid, completed });
      return task;
    } catch (error) {
      logger.error('Failed to update task status', { error: error.message });
      throw error;
    }
  }

  /**
   * Add comment to task
   */
  async addComment(taskGid, text) {
    await this.initialize();

    try {
      const body = {
        data: {
          text: text
        }
      };

      const result = await this.storiesApi.createStoryForTask(body, taskGid);
      const story = result.data;

      logger.info('Added comment to task', { taskGid });
      return story;
    } catch (error) {
      logger.error('Failed to add comment', { error: error.message });
      throw error;
    }
  }

  /**
   * Get task with full details
   */
  async getTask(taskGid) {
    await this.initialize();

    try {
      const opts = {
        opt_fields: 'name,notes,assignee,due_on,completed,projects,custom_fields,attachments,subtasks,tags,followers,memberships'
      };

      const result = await this.tasksApi.getTask(taskGid, opts);
      return result.data;
    } catch (error) {
      logger.error('Failed to get task', { error: error.message });
      throw error;
    }
  }

  /**
   * Search tasks in workspace
   */
  async searchTasks(params) {
    await this.initialize();

    try {
      const opts = {
        ...params,
        workspace: this.workspaceGid
      };

      const result = await this.tasksApi.searchTasksForWorkspace(opts);
      return result.data;
    } catch (error) {
      logger.error('Failed to search tasks', { error: error.message });
      throw error;
    }
  }

  /**
   * Get subtasks
   */
  async getSubtasks(taskGid) {
    await this.initialize();

    try {
      const result = await this.tasksApi.getSubtasksForTask(taskGid, {});
      return result.data;
    } catch (error) {
      logger.error('Failed to get subtasks', { error: error.message });
      throw error;
    }
  }

  /**
   * Handle comment event
   */
  async handleCommentEvent(action, resource, parent) {
    if (action === 'added' && parent && parent.resource_type === 'task') {
      // Fetch story details
      const result = await this.storiesApi.getStory(resource.gid, {});
      const story = result.data;

      // Check if Morgan is mentioned
      if (story.text && story.text.includes('@morgan')) {
        const task = await this.getTask(parent.gid);
        await this.processTaskForMorgan(task);
      }
    }
  }

  /**
   * Handle project event
   */
  async handleProjectEvent(action, resource) {
    logger.info('Project event', { action, gid: resource.gid });
    // Handle project-level events if needed
  }

  /**
   * Get project by name in workspace
   */
  async getProjectByName(projectName) {
    await this.initialize();

    try {
      const opts = {
        workspace: this.workspaceGid,
        opt_fields: 'name,gid'
      };
      const result = await this.projectsApi.getProjects(opts);
      const projects = result.data;
      const project = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());
      return project || null;
    } catch (error) {
      logger.error('Failed to get project by name', { error: error.message, projectName });
      throw error;
    }
  }

  /**
   * Get section by name in a project
   */
  async getSectionByName(projectGid, sectionName) {
    await this.initialize();

    try {
      const result = await this.sectionsApi.getSectionsForProject(projectGid, {});
      const sections = result.data;
      const section = sections.find(s => s.name === sectionName);
      return section || null;
    } catch (error) {
      logger.error('Failed to get section by name', { error: error.message });
      throw error;
    }
  }

  /**
   * Move task to a section
   */
  async moveTaskToSection(taskGid, sectionGid) {
    await this.initialize();

    try {
      const body = {
        data: {
          task: taskGid
        }
      };

      // Asana SDK v3.x signature: addTaskForSection(body, section_gid, opts)
      const result = await this.sectionsApi.addTaskForSection(body, sectionGid, {});
      logger.info('Moved task to section', { taskGid, sectionGid });
      return result;
    } catch (error) {
      logger.error('Failed to move task to section', {
        error: error.message,
        stack: error.stack,
        taskGid,
        sectionGid
      });
      throw error;
    }
  }

  /**
   * PHASE 8: Get task's current section in a project
   */
  async getTaskSection(taskGid, projectGid) {
    await this.initialize();

    try {
      const task = await this.getTask(taskGid);

      // Find membership for the specific project
      const membership = task.memberships?.find(m => m.project?.gid === projectGid);

      if (membership && membership.section) {
        return membership.section.name;
      }

      return null;
    } catch (error) {
      logger.error('Failed to get task section', { error: error.message });
      throw error;
    }
  }

  /**
   * PHASE 9: Process task in "Morgan - Planning Complete" section
   * Creates complex task template from Asana task structure
   */
  async processPlanningCompleteTask(task, projectGid) {
    logger.info('Processing Planning Complete task', {
      taskGid: task.gid,
      taskName: task.name,
      projectGid
    });

    try {
      // 1. Extract task information
      const taskTitle = task.name;
      const taskDescription = task.notes || '';

      // 2. Fetch subtasks
      const subtasks = await this.getSubtasks(task.gid);

      // 3. Build complex task from Asana structure
      const complexTaskParams = {
        userIntent: 'CREATE_NEW_TASK',
        entityScope: 'AUTO',
        taskTitle: taskTitle,
        taskObjective: taskDescription,
        explicitSteps: subtasks.map((st, idx) => ({
          stepNumber: idx + 1,
          description: st.name,
          details: st.notes || ''
        })),
        metadata: {
          sourceType: 'asana',
          sourceTaskGid: task.gid,
          sourceProjectGid: projectGid,
          createdAt: new Date().toISOString()
        }
      };

      // 4. Create complex task using ComplexTaskManager
      const ComplexTaskManager = require('../tools/complexTaskManager');
      const taskManager = new ComplexTaskManager({
        db: this.db,
        platform: 'asana',
        asanaTaskGid: task.gid,
        asanaProjectGid: projectGid
      });

      logger.info('Creating complex task template from Asana task', {
        asanaTaskGid: task.gid,
        templateTitle: taskTitle,
        stepCount: subtasks.length
      });

      const result = await taskManager.execute(complexTaskParams);

      // 5. Add comment to Asana task with template ID
      await this.addComment(
        task.gid,
        `🤖 Morgan: Task template created and queued for execution.\n\n` +
        `Template: ${taskTitle}\n` +
        `Steps: ${subtasks.length}\n` +
        `Status: Executing...`
      );

      // 6. Monitor execution and handle completion (async)
      this.monitorTaskExecution(task.gid, projectGid, result.taskId);
    } catch (error) {
      logger.error('Failed to process Planning Complete task', { error: error.message });
      // Move to Failed section
      await this.handleTaskFailure(task.gid, projectGid, error.message);
    }
  }

  /**
   * PHASE 9: Monitor complex task execution and handle completion/failure
   */
  async monitorTaskExecution(asanaTaskGid, projectGid, complexTaskId) {
    // This runs asynchronously - polls Firestore for task status
    const pollInterval = 30000; // 30 seconds
    const maxPolls = 40; // 20 minutes max
    let polls = 0;

    const poller = setInterval(async () => {
      try {
        polls++;

        // Check task status in Firestore
        const taskDoc = await this.db.collection('task-queue').doc(complexTaskId).get();

        if (!taskDoc.exists) {
          clearInterval(poller);
          this.pollers.delete(complexTaskId);
          logger.warn('Task not found in queue', { complexTaskId });
          return;
        }

        const taskData = taskDoc.data();
        const status = taskData.status;

        logger.debug('Polling task status', {
          complexTaskId,
          status,
          progress: taskData.progress
        });

        // Handle completion
        if (status === 'COMPLETED') {
          clearInterval(poller);
          this.pollers.delete(complexTaskId);
          await this.handleTaskSuccess(asanaTaskGid, projectGid, taskData);
        }

        // Handle failure
        if (status === 'FAILED') {
          clearInterval(poller);
          this.pollers.delete(complexTaskId);
          await this.handleTaskFailure(asanaTaskGid, projectGid, taskData.error);
        }

        // Timeout
        if (polls >= maxPolls) {
          clearInterval(poller);
          this.pollers.delete(complexTaskId);
          logger.warn('Task execution timeout', { complexTaskId });
          await this.handleTaskFailure(
            asanaTaskGid,
            projectGid,
            'Execution timeout (20 minutes)'
          );
        }
      } catch (error) {
        logger.error('Error polling task status', { error: error.message });
      }
    }, pollInterval);

    // Store interval ID for cleanup
    this.pollers.set(complexTaskId, poller);
  }

  /**
   * PHASE 10: Handle successful task execution
   * - Mark task complete
   * - Send Google Chat notification
   * - Move to "Morgan - Task Completed" section
   */
  async handleTaskSuccess(asanaTaskGid, projectGid, taskData) {
    logger.info('Task execution succeeded', {
      asanaTaskGid,
      executionTime: taskData.executionTime,
      templateId: taskData.templateId
    });

    try {
      // 1. Add success comment with results
      const successComment =
        `✅ **Morgan: Task Completed Successfully**\n\n` +
        `Execution Time: ${Math.round(taskData.executionTime / 1000)}s\n` +
        `Steps Completed: ${taskData.progress}%\n` +
        `Template: ${taskData.templateName}\n\n` +
        (taskData.result?.summary || '');

      await this.addComment(asanaTaskGid, successComment);

      // 2. Mark task as complete
      await this.updateTaskStatus(asanaTaskGid, true);

      // 3. Move to "Task Completed" section
      const completedSection = await this.getSectionByName(
        projectGid,
        MORGAN_SECTIONS.TASK_COMPLETED
      );

      if (completedSection) {
        await this.moveTaskToSection(asanaTaskGid, completedSection.gid);
      }

      // 4. Send Google Chat notification
      await this.sendGoogleChatNotification({
        status: 'success',
        taskGid: asanaTaskGid,
        taskName: taskData.templateName,
        message: `Task completed successfully in ${Math.round(taskData.executionTime / 1000)}s`,
        asanaUrl: `https://app.asana.com/0/${asanaTaskGid}`
      });
    } catch (error) {
      logger.error('Error handling task success', { error: error.message });
    }
  }

  /**
   * PHASE 10: Handle failed task execution
   * - Add failure comment
   * - Send Google Chat notification
   * - Move to "Morgan - Task Failed" section
   */
  async handleTaskFailure(asanaTaskGid, projectGid, errorMessage) {
    logger.info('Task execution failed', {
      asanaTaskGid,
      error: errorMessage
    });

    try {
      // 1. Add failure comment
      const failureComment =
        `❌ **Morgan: Task Execution Failed**\n\n` +
        `Error: ${errorMessage}\n\n` +
        `**Next Steps:**\n` +
        `1. Review the error message above\n` +
        `2. Update task description and subtasks with corrections\n` +
        `3. Move task to "Morgan - Try Again" to retry\n` +
        `4. Or contact support if the error persists`;

      await this.addComment(asanaTaskGid, failureComment);

      // 2. Move to "Task Failed" section
      const failedSection = await this.getSectionByName(
        projectGid,
        MORGAN_SECTIONS.TASK_FAILED
      );

      if (failedSection) {
        await this.moveTaskToSection(asanaTaskGid, failedSection.gid);
      }

      // 3. Send Google Chat notification
      await this.sendGoogleChatNotification({
        status: 'failure',
        taskGid: asanaTaskGid,
        taskName: 'Task execution',
        message: `Task failed: ${errorMessage}`,
        asanaUrl: `https://app.asana.com/0/${asanaTaskGid}`
      });
    } catch (error) {
      logger.error('Error handling task failure', { error: error.message });
    }
  }

  /**
   * PHASE 10: Send Google Chat notification
   */
  async sendGoogleChatNotification({ status, taskGid, taskName, message, asanaUrl }) {
    try {
      const { getGoogleChatService } = require('./googleChatService');
      const chatService = getGoogleChatService();

      // Get configured notification space from Firestore
      const configDoc = await this.db.collection('tool-settings')
        .doc('AsanaNotifications').get();

      if (!configDoc.exists || !configDoc.data().googleChatSpaceId) {
        logger.warn('Google Chat notification space not configured');
        return;
      }

      const spaceName = configDoc.data().googleChatSpaceId;
      const emoji = status === 'success' ? '✅' : '❌';
      const statusText = status === 'success' ? 'Completed' : 'Failed';

      const notificationText =
        `${emoji} **Morgan: Task ${statusText}**\n\n` +
        `Task: ${taskName}\n` +
        `${message}\n\n` +
        `View in Asana: ${asanaUrl}`;

      await chatService.sendMessage(spaceName, notificationText);
      logger.info('Sent Google Chat notification', { status, taskGid });
    } catch (error) {
      logger.error('Failed to send Google Chat notification', { error: error.message });
      // Don't throw - notification failure shouldn't break workflow
    }
  }

  /**
   * PHASE 11: Process task in "Morgan - Try Again" section
   * User has made modifications and wants to retry
   */
  async processRetryTask(task, projectGid) {
    logger.info('Processing retry task', {
      taskGid: task.gid,
      taskName: task.name
    });

    try {
      // 1. Mark task as incomplete (in case user forgot)
      if (task.completed) {
        await this.updateTaskStatus(task.gid, false);
      }

      // 2. Add comment acknowledging retry
      await this.addComment(
        task.gid,
        `🔄 **Morgan: Retry Requested**\n\n` +
        `Processing updated task with your modifications...\n` +
        `Updated description and subtasks will be used for the new template.`
      );

      // 3. Process as new task (same as Planning Complete)
      // This will create a new template with modifications
      await this.processPlanningCompleteTask(task, projectGid);

      logger.info('Retry task processed', { taskGid: task.gid });
    } catch (error) {
      logger.error('Failed to process retry task', { error: error.message });
      await this.handleTaskFailure(task.gid, projectGid, error.message);
    }
  }

  /**
   * PHASE 11: Update template and memories based on retry modifications
   */
  async updateTemplateFromRetry(task, projectGid, originalTemplateId) {
    logger.info('Updating template from retry', {
      taskGid: task.gid,
      templateId: originalTemplateId
    });

    try {
      // 1. Fetch current subtasks (user modifications)
      const updatedSubtasks = await this.getSubtasks(task.gid);

      // 2. Get original template
      const templateDoc = await this.db.collection('task-templates')
        .doc(originalTemplateId).get();

      if (!templateDoc.exists) {
        logger.warn('Original template not found', { templateId: originalTemplateId });
        return;
      }

      const originalTemplate = templateDoc.data();

      // 3. Compare steps to identify modifications
      const modifications = this.compareSteps(
        originalTemplate.steps,
        updatedSubtasks
      );

      // 4. Update template with modifications
      const updatedSteps = updatedSubtasks.map((st, idx) => ({
        stepNumber: idx + 1,
        description: st.name,
        code: st.notes || originalTemplate.steps[idx]?.code || '',
        expectedOutcome: originalTemplate.steps[idx]?.expectedOutcome || ''
      }));

      await this.db.collection('task-templates').doc(originalTemplateId).update({
        title: task.name,
        objective: task.notes || originalTemplate.objective,
        steps: updatedSteps,
        updatedAt: this.FieldValue.serverTimestamp(),
        retryCount: (originalTemplate.retryCount || 0) + 1
      });

      // 5. Store modifications in ReasoningMemory
      await this.db.collection('reasoning-memory').add({
        category: 'template_modification',
        templateId: originalTemplateId,
        asanaTaskGid: task.gid,
        modifications: modifications,
        reason: 'User-requested retry with modifications',
        timestamp: this.FieldValue.serverTimestamp()
      });

      logger.info('Template updated from retry', {
        templateId: originalTemplateId,
        modificationCount: modifications.length
      });
    } catch (error) {
      logger.error('Failed to update template from retry', { error: error.message });
      throw error;
    }
  }

  /**
   * PHASE 11: Compare original steps with updated subtasks
   */
  compareSteps(originalSteps, updatedSubtasks) {
    const modifications = [];

    updatedSubtasks.forEach((updated, idx) => {
      const original = originalSteps[idx];

      if (!original) {
        modifications.push({
          type: 'added',
          stepNumber: idx + 1,
          description: updated.name,
          details: updated.notes
        });
      } else if (original.description !== updated.name || original.code !== updated.notes) {
        modifications.push({
          type: 'modified',
          stepNumber: idx + 1,
          before: { description: original.description, code: original.code },
          after: { description: updated.name, details: updated.notes }
        });
      }
    });

    // Check for removed steps
    if (originalSteps.length > updatedSubtasks.length) {
      for (let i = updatedSubtasks.length; i < originalSteps.length; i++) {
        modifications.push({
          type: 'removed',
          stepNumber: i + 1,
          description: originalSteps[i].description
        });
      }
    }

    return modifications;
  }

  /**
   * PHASE 15: Find task by name or partial match (for Google Chat feedback)
   */
  async findTaskByReference(reference) {
    await this.initialize();

    try {
      // Try exact task GID first
      if (reference.match(/^\d+$/)) {
        try {
          const task = await this.getTask(reference);
          return task;
        } catch (error) {
          // Not a valid GID, continue with name search
        }
      }

      // Search by task name (case-insensitive partial match)
      const params = {
        'text': reference,
        'opt_fields': 'name,gid,completed,memberships',
        'resource_subtype': 'default_task'
      };

      const results = await this.searchTasks(params);

      if (!results || results.length === 0) {
        return null;
      }

      // Prefer tasks in Morgan sections
      const morganTask = results.find(task => {
        const section = task.memberships?.[0]?.section?.name;
        return section && (
          section === MORGAN_SECTIONS.TASK_COMPLETED ||
          section === MORGAN_SECTIONS.TASK_FAILED
        );
      });

      return morganTask || results[0];
    } catch (error) {
      logger.error('Error finding task by reference', { error: error.message });
      return null;
    }
  }

  /**
   * PHASE 15: Apply feedback modifications to task (from Google Chat)
   */
  async applyFeedbackToTask(taskGid, modifications) {
    await this.initialize();

    try {
      const task = await this.getTask(taskGid);
      const currentSubtasks = await this.getSubtasks(taskGid);

      logger.info('Applying feedback to task', {
        taskGid,
        taskName: task.name,
        modificationCount: modifications.length
      });

      // Process each modification
      for (const mod of modifications) {
        switch (mod.type) {
          case 'add_step': {
            // Add new subtask
            const body = {
              data: {
                parent: taskGid,
                name: mod.description,
                notes: mod.details || '',
                completed: false
              }
            };
            await this.tasksApi.createTask(body);
            logger.info('Added subtask', { taskGid, step: mod.description });
            break;
          }

          case 'modify_step': {
            // Find and update matching subtask
            const matchingSubtask = this.findMatchingSubtask(currentSubtasks, mod.description);
            if (matchingSubtask) {
              const body = {
                data: {
                  name: mod.description,
                  notes: mod.details || matchingSubtask.notes
                }
              };
              await this.tasksApi.updateTask(body, matchingSubtask.gid);
              logger.info('Modified subtask', { taskGid, subtaskGid: matchingSubtask.gid });
            } else {
              // If no match, add as new step
              const body = {
                data: {
                  parent: taskGid,
                  name: mod.description,
                  notes: mod.details || '',
                  completed: false
                }
              };
              await this.tasksApi.createTask(body);
            }
            break;
          }

          case 'remove_step': {
            // Find and delete matching subtask
            const subtaskToRemove = this.findMatchingSubtask(currentSubtasks, mod.description);
            if (subtaskToRemove) {
              await this.tasksApi.deleteTask(subtaskToRemove.gid);
              logger.info('Removed subtask', { taskGid, subtaskGid: subtaskToRemove.gid });
            }
            break;
          }

          case 'update_description': {
            // Update task description/notes
            const updatedNotes = task.notes + '\n\n---\n**User Feedback:**\n' + mod.description;
            const body = {
              data: {
                notes: updatedNotes
              }
            };
            await this.tasksApi.updateTask(body, taskGid);
            logger.info('Updated task description', { taskGid });
            break;
          }
        }
      }

      // Add comment with feedback summary
      await this.addComment(
        taskGid,
        `📝 **User Feedback Applied via Google Chat**\n\n` +
        modifications.map(m => `• ${m.description}`).join('\n') +
        `\n\nTask updated and ready for retry.`
      );

      return true;
    } catch (error) {
      logger.error('Error applying feedback to task', { error: error.message });
      throw error;
    }
  }

  /**
   * PHASE 15: Find subtask that best matches a description
   */
  findMatchingSubtask(subtasks, description) {
    const normalized = description.toLowerCase();

    // Try exact match first
    let match = subtasks.find(st => st.name.toLowerCase() === normalized);
    if (match) return match;

    // Try partial match
    match = subtasks.find(st =>
      st.name.toLowerCase().includes(normalized) ||
      normalized.includes(st.name.toLowerCase())
    );

    return match || null;
  }

  /**
   * PHASE 15: Prepare task for retry after feedback (move to Try Again section)
   */
  async prepareTaskForRetry(taskGid, feedback) {
    await this.initialize();

    try {
      const task = await this.getTask(taskGid);
      const projectGid = task.memberships?.[0]?.project?.gid;

      if (!projectGid) {
        throw new Error('Task is not in a project');
      }

      // 1. Mark task as incomplete
      if (task.completed) {
        await this.updateTaskStatus(taskGid, false);
      }

      // 2. Get "Try Again" section
      const tryAgainSection = await this.getSectionByName(
        projectGid,
        MORGAN_SECTIONS.TRY_AGAIN
      );

      if (!tryAgainSection) {
        throw new Error('Morgan - Try Again section not found in project');
      }

      // 3. Move to "Try Again" section
      await this.moveTaskToSection(taskGid, tryAgainSection.gid);

      // 4. Add retry comment
      await this.addComment(
        taskGid,
        `🔄 **Ready for Retry (Feedback via Google Chat)**\n\n` +
        `User feedback has been applied. Task will be re-executed with updates.\n\n` +
        `**Modifications:**\n` +
        feedback.modifications.map(m => `• ${m.description}`).join('\n')
      );

      logger.info('Task prepared for retry', {
        taskGid,
        taskName: task.name,
        modifications: feedback.modifications.length
      });

      return true;
    } catch (error) {
      logger.error('Error preparing task for retry', { error: error.message });
      throw error;
    }
  }

  /**
   * Cleanup method for graceful shutdown
   */
  async cleanup() {
    // Clear all polling intervals
    for (const [taskId, poller] of this.pollers.entries()) {
      clearInterval(poller);
      logger.info('Cleared task poller', { taskId });
    }
    this.pollers.clear();
  }
}

let instance = null;

function getAsanaService() {
  if (!instance) {
    instance = new AsanaService();
  }
  return instance;
}

module.exports = { getAsanaService };
