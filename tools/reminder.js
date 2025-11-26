const BaseTool = require('../lib/baseTool');
const toolSettingsManager = require('../lib/toolSettings');
const { getFirestore } = require('../config/firestore');

class ReminderTool extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'reminder';
    this.description = 'Create reminders and tasks when user EXPLICITLY requests to set a reminder, create a task, or schedule something with a deadline. Supports Bitrix24 tasks and Google Calendar events. Use ONLY when user wants to CREATE a new reminder/task. DO NOT use for conversational questions, checking existing tasks, or general discussion about tasks.';
    this.category = 'productivity';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent';

    this.parameters = {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The reminder/task title'
        },
        description: {
          type: 'string',
          description: 'Detailed description of the task'
        },
        dueDate: {
          type: 'string',
          description: 'Due date in YYYY-MM-DD format'
        },
        priority: {
          type: 'string',
          description: 'Task priority level',
          enum: ['low', 'medium', 'high'],
          default: 'medium'
        }
      },
      required: ['title']
    };
  }

  // SEMANTIC TRIGGER (CRITICAL - See CLAUDE.md)
  // DO NOT use keyword/regex matching - let Gemini's function calling handle triggering
  async shouldTrigger() {
    return false; // Let Gemini handle all triggering via description
  }

  async execute(params, messageData) {
    try {
      // Get tool settings from Firestore (with fallback to env vars)
      const settings = await toolSettingsManager.getToolSettings('reminder');
      const preferredPlatform = settings.platform || await this.getDefaultPlatform();

      this.log('info', 'Reminder platform selected', {
        platform: preferredPlatform,
        fromSettings: !!settings.platform,
        fallbackUsed: !settings.platform
      });

      // Route to appropriate platform
      switch (preferredPlatform) {
        case 'bitrix24':
          return await this.createBitrix24Task(params, messageData);
        case 'google-calendar':
          return await this.createGoogleCalendarEvent(params, messageData);
        case 'asana':
          return await this.createAsanaTask(params, messageData);
        default:
          throw new Error(`Unknown reminder platform: ${preferredPlatform}. Supported platforms: bitrix24, google-calendar, asana`);
      }
    } catch (error) {
      this.log('error', 'Reminder creation failed', {
        error: error.message,
        params
      });
      throw new Error(`Failed to create reminder: ${error.message}`);
    }
  }

  /**
   * Get default platform based on enabled integrations from Firestore
   */
  async getDefaultPlatform() {
    const db = getFirestore();

    // Check platform-settings collection
    const platformsSnapshot = await db.collection('platform-settings').get();

    for (const doc of platformsSnapshot.docs) {
      const data = doc.data();
      if (data.enabled) {
        const platformId = doc.id;
        if (platformId === 'bitrix24') return 'bitrix24';
        if (platformId === 'asana') return 'asana';
        if (platformId === 'googleChat') return 'google-calendar';
      }
    }

    throw new Error('No reminder platform is enabled. Enable a platform in dashboard settings.');
  }

  /**
   * Create task in Bitrix24
   */
  async createBitrix24Task(params, messageData) {
    const { title, description, dueDate, priority = 'medium' } = params;

    const taskData = {
      TITLE: title,
      DESCRIPTION: description || '',
      RESPONSIBLE_ID: messageData.userId,
      PRIORITY: this.getPriorityCode(priority),
      CREATED_BY: messageData.userId
    };

    if (dueDate) {
      taskData.DEADLINE = dueDate;
    }

    // Call Bitrix24 API to create task
    const result = await this.callBitrix24('tasks.task.add', {
      fields: taskData
    });

    const taskId = result.result?.task?.id;

    if (taskId) {
      // Save reminder data to Firestore for tracking
      await this.saveToFirestore('reminders', taskId.toString(), {
        taskId,
        title,
        userId: messageData.userId,
        chatId: messageData.chatId,
        createdAt: new Date().toISOString(),
        priority,
        dueDate,
        platform: 'bitrix24'
      });

      const response = `✅ Reminder created successfully in Bitrix24!

📝 Task: ${title}
👤 Assigned to: User #${messageData.userId}
📅 Due: ${dueDate || 'No deadline set'}
🎯 Priority: ${priority.toUpperCase()}
🔗 Task ID: ${taskId}`;

      this.log('info', 'Bitrix24 task created', {
        taskId,
        title,
        userId: messageData.userId
      });

      return response;
    } else {
      throw new Error('Failed to create task in Bitrix24');
    }
  }

  /**
   * Create event in Google Calendar
   */
  async createGoogleCalendarEvent(params, messageData) {
    const { title, description, dueDate, priority = 'medium' } = params;

    // For now, return a user-friendly message that Google Calendar integration is coming
    // TODO: Implement Google Calendar API integration
    const response = `✅ Reminder noted!

📝 Task: ${title}
📅 Due: ${dueDate || 'No deadline set'}
🎯 Priority: ${priority.toUpperCase()}

⚠️ Note: Google Calendar integration is not yet fully implemented. This reminder has been logged but not added to your calendar. Consider using Asana for task management instead.`;

    this.log('info', 'Google Calendar reminder logged (not yet implemented)', {
      title,
      dueDate,
      priority
    });

    // Save to Firestore for tracking
    await this.saveToFirestore('reminders', `gcal-${Date.now()}`, {
      title,
      description,
      userId: messageData.userId,
      chatId: messageData.chatId,
      createdAt: new Date().toISOString(),
      priority,
      dueDate,
      platform: 'google-calendar',
      status: 'pending-implementation'
    });

    return response;
  }

  /**
   * Create task in Asana
   */
  async createAsanaTask(params, messageData) {
    const { title, description, dueDate, priority = 'medium' } = params;

    try {
      const { getAsanaService } = require('../services/asanaService');
      const asana = getAsanaService();

      // Get Asana workspace GID from Firestore
      const db = getFirestore();
      const asanaPlatform = await db.collection('platform-settings').doc('asana').get();
      const workspaceGid = asanaPlatform.exists ? asanaPlatform.data().workspaceGid : null;

      if (!workspaceGid) {
        throw new Error('ASANA_WORKSPACE_GID not configured in platform settings');
      }

      // Create task in Asana
      // Note: We're creating a task without a project for now (personal task)
      // To add to a specific project, we'd need the project GID
      const task = await asana.createTask(workspaceGid, {
        name: title,
        notes: description || '',
        dueDate: dueDate || null
      });

      const response = `✅ Reminder created successfully in Asana!

📝 Task: ${title}
📅 Due: ${dueDate || 'No deadline set'}
🎯 Priority: ${priority.toUpperCase()}
🔗 Asana Task: https://app.asana.com/0/${task.gid}`;

      this.log('info', 'Asana task created', {
        taskGid: task.gid,
        title,
        dueDate
      });

      // Save to Firestore for tracking
      await this.saveToFirestore('reminders', task.gid, {
        taskGid: task.gid,
        title,
        description,
        userId: messageData.userId,
        chatId: messageData.chatId,
        createdAt: new Date().toISOString(),
        priority,
        dueDate,
        platform: 'asana'
      });

      return response;
    } catch (error) {
      this.log('error', 'Failed to create Asana task', {
        error: error.message,
        title
      });
      throw new Error(`Failed to create Asana task: ${error.message}`);
    }
  }

  getPriorityCode(priority) {
    const priorities = {
      low: '0',
      medium: '1',
      high: '2'
    };
    return priorities[priority] || '1';
  }

  async listReminders(userId) {
    try {
      // Get user's reminders from Firestore
      const snapshot = await this.firestore
        .collection('reminders')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get();

      const reminders = [];
      snapshot.forEach(doc => {
        reminders.push({
          id: doc.id,
          ...doc.data()
        });
      });

      return reminders;
    } catch (error) {
      this.log('error', 'Failed to list reminders', {
        error: error.message,
        userId
      });
      return [];
    }
  }
}

module.exports = ReminderTool;