/**
 * Google Workspace Chat Service
 * Handles bidirectional communication with Google Chat API
 */

const { google } = require('googleapis');
const { getGeminiService } = require('./gemini');
const { getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');

class GoogleChatService {
  constructor() {
    this.chat = null;
    this.db = getFirestore();
    this.FieldValue = getFieldValue();
    this.initialized = false;
    this.processingMessages = new Map(); // Track in-flight message processing to prevent duplicates

    // CRITICAL: Periodic cleanup to prevent memory leaks
    // Remove stale entries older than 5 minutes (should never happen, but safety measure)
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleProcessing();
    }, 60000); // Run every 60 seconds
  }

  async initialize() {
    if (this.initialized) return;

    try {
      // Use Application Default Credentials (ADC) - no keyFile needed
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/chat.bot']
      });

      this.chat = google.chat({
        version: 'v1',
        auth: await auth.getClient()
      });

      this.initialized = true;
      logger.info('Google Chat service initialized');
    } catch (error) {
      logger.error('Failed to initialize Google Chat service', { error: error.message });
      throw error;
    }
  }

  /**
   * PHASE 16.3: Cleanup stale processing entries
   * Removes entries older than 5 minutes to prevent memory leaks
   */
  cleanupStaleProcessing() {
    const now = Date.now();
    const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
    let cleanedCount = 0;

    for (const [messageId, data] of this.processingMessages.entries()) {
      const age = now - data.startTime;
      if (age > MAX_AGE_MS) {
        this.processingMessages.delete(messageId);
        cleanedCount++;
        logger.warn('Removed stale processing entry', {
          messageId,
          ageMinutes: (age / 60000).toFixed(1),
          spaceName: data.spaceName,
          userName: data.userName
        });
      }
    }

    if (cleanedCount > 0) {
      logger.info('Cleanup completed', {
        removedCount: cleanedCount,
        remainingCount: this.processingMessages.size
      });
    }
  }

  /**
   * PHASE 16.3: Cleanup resources on shutdown
   * Call this when the service is shutting down to prevent memory leaks
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('Google Chat service cleanup interval cleared');
    }
  }

  /**
   * Sanitize Google Chat ID for use as Firestore document ID
   * Google Chat IDs contain slashes which Firestore doesn't allow
   */
  sanitizeId(id) {
    return id.replace(/\//g, '_');
  }

  /**
   * Detect and store user role from Google Chat event
   * Returns 'admin' if user has elevated permissions, otherwise 'user'
   */
  async detectAndStoreUserRole(user, space) {
    try {
      const sanitizedUserId = this.sanitizeId(user.name);

      // Determine role based on user type and space membership
      let role = 'user'; // Default to least privilege
      let roleDetails = {
        userType: user.type || 'HUMAN',
        isSpaceManager: false,
        isWorkspaceAdmin: false
      };

      // Check if user is a bot (bots should have limited permissions)
      if (user.type === 'BOT') {
        role = 'user';
        roleDetails.userType = 'BOT';
      }

      // For spaces (not DMs), try to get membership info to check if user is manager/owner
      if (space && space.type !== 'DM' && space.name) {
        try {
          await this.initialize();

          // Get space membership details
          const membershipName = `${space.name}/members/${user.name.split('/')[1]}`;
          const membership = await this.chat.spaces.members.get({
            name: membershipName
          });

          // Check if user is a space manager/owner
          if (membership.data.role === 'ROLE_MANAGER') {
            role = 'admin';
            roleDetails.isSpaceManager = true;
          }
        } catch (membershipError) {
          // Membership lookup failed - continue with default role
          logger.debug('Could not fetch space membership', {
            userId: sanitizedUserId,
            error: membershipError.message
          });
        }
      }

      // Store user role in Firestore (google-chat-users collection)
      const userRef = this.db.collection('google-chat-users').doc(sanitizedUserId);
      await userRef.set({
        originalUserId: user.name,
        sanitizedUserId: sanitizedUserId,
        displayName: user.displayName || 'Unknown',
        email: user.email || null,
        role: role,
        roleDetails: roleDetails,
        lastSeen: this.FieldValue.serverTimestamp(),
        updatedAt: this.FieldValue.serverTimestamp()
      }, { merge: true });

      logger.info('Google Chat user role detected and stored', {
        userId: sanitizedUserId,
        displayName: user.displayName,
        role: role,
        roleDetails: roleDetails
      });

      return role;

    } catch (error) {
      logger.error('Failed to detect/store user role', {
        userId: user.name,
        error: error.message
      });
      return 'user'; // Fail-safe: default to least privilege
    }
  }

  /**
   * Get user role from Firestore cache
   * Returns cached role if available and recent, otherwise re-detects
   */
  async getUserRole(user, space) {
    try {
      const sanitizedUserId = this.sanitizeId(user.name);
      const userRef = this.db.collection('google-chat-users').doc(sanitizedUserId);
      const userDoc = await userRef.get();

      // Cache TTL: 5 minutes
      const CACHE_TTL_MS = 5 * 60 * 1000;

      if (userDoc.exists) {
        const userData = userDoc.data();
        const lastUpdated = userData.updatedAt?.toMillis() || 0;
        const now = Date.now();

        // If cache is fresh, return cached role
        if (now - lastUpdated < CACHE_TTL_MS) {
          logger.debug('Using cached Google Chat user role', {
            userId: sanitizedUserId,
            role: userData.role,
            cacheAge: `${((now - lastUpdated) / 1000).toFixed(1)}s`
          });
          return userData.role;
        }
      }

      // Cache miss or expired - re-detect role
      return await this.detectAndStoreUserRole(user, space);

    } catch (error) {
      logger.error('Failed to get user role', {
        userId: user.name,
        error: error.message
      });
      return 'user'; // Fail-safe
    }
  }

  /**
   * Handle incoming message event
   */
  async handleMessage(event) {
    const { message, space, user } = event;

    // PHASE 16.3: REQUEST DEDUPLICATION (CRITICAL - Must happen FIRST)
    // Google Chat sends duplicate webhooks within 133ms, too fast for async Map checks.
    // Use message.name (or generate stable ID) to detect duplicates.

    const messageId = message.name || `${space.name}-${user.name}-${message.text?.substring(0, 50)}`;

    // SYNCHRONOUS duplicate check (no await before this)
    if (this.processingMessages.has(messageId)) {
      logger.warn('Duplicate webhook detected, ignoring', {
        messageId: messageId.substring(0, 100),
        spaceName: space.name,
        userName: user.displayName,
        inFlightCount: this.processingMessages.size
      });
      return this.createCardResponse('⏳ Processing your previous request...');
    }

    // Mark IMMEDIATELY before any async operations
    this.processingMessages.set(messageId, {
      startTime: Date.now(),
      spaceName: space.name,
      userName: user.displayName
    });

    try {
      // Sanitize IDs for Firestore (remove slashes)
      const conversationId = this.sanitizeId(space.name);
      const userId = this.sanitizeId(user.name);

      // Detect and store user role
      const userRole = await this.getUserRole(user, space);

      // Process message with Gemini using processMessage
      const gemini = getGeminiService();

      // Format message data for Gemini's processMessage method
      const messageData = {
        message: message.text,
        userId: userId,
        userName: user.displayName || user.name,
        userRole: userRole, // Include detected role
        messageType: space.type === 'DM' ? 'P' : 'G', // P = Private/DM, G = Group
        dialogId: conversationId, // Use sanitized ID
        chatId: conversationId, // Use sanitized ID
        messageId: message.name || `gchat-${Date.now()}`,
        platform: 'google-chat'
      };

      const eventData = {
        type: 'MESSAGE',
        message: message, // Include message for threadKey extraction
        space: space,
        user: user
      };

      // PHASE 16.2: AUTOMATIC TIMEOUT DETECTION
      // Google Chat has a 30-second observed timeout (not 60s as documented).
      // We use Promise.race to automatically switch to async mode if processing takes >10s.

      const WEBHOOK_TIMEOUT_MS = 10000; // 10s threshold (30s observed timeout, 20s safety margin)
      let timeoutReached = false;
      let timeoutId = null;

      // Timeout promise - resolves with acknowledgment after 10s
      const timeoutPromise = new Promise(resolve => {
        timeoutId = setTimeout(() => {
          timeoutReached = true;
          logger.warn('Google Chat webhook timeout threshold reached (10s), returning acknowledgment', {
            messageText: message.text?.substring(0, 100),
            elapsedMs: WEBHOOK_TIMEOUT_MS
          });
          resolve({
            type: 'timeout',
            response: this.createCardResponse(
              '⏳ Your request is taking longer than expected. Processing in the background... I\'ll send the result shortly.'
            )
          });
        }, WEBHOOK_TIMEOUT_MS);
      });

      // Processing promise - returns result when processing completes
      const processingPromise = (async () => {
        try {
          const gemini = getGeminiService();
          const result = await gemini.processMessage(messageData, eventData);
          const responseText = result?.reply || 'Message processed successfully.';

          return {
            type: 'completed',
            responseText: responseText,
            threadKey: eventData.message?.thread?.name || null
          };
        } catch (error) {
          return {
            type: 'error',
            error: error,
            threadKey: eventData.message?.thread?.name || null
          };
        }
      })();

      // Race between timeout and processing completion
      const raceResult = await Promise.race([timeoutPromise, processingPromise]);

      // CRITICAL: Clear the timeout timer to prevent it from firing
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (raceResult.type === 'timeout') {
        // Timeout won the race - return acknowledgment immediately
        // Processing continues in the background
        processingPromise.then(async result => {
          try {
            if (result.type === 'completed') {
              // Send actual result via Chat API
              await this.cacheMessage(conversationId, user, message.text, result.responseText);
              await this.sendMessage(eventData.space.name, result.responseText, result.threadKey);
            } else if (result.type === 'error') {
              // Send error via Chat API
              try {
                await this.sendMessage(
                  eventData.space.name,
                  `❌ Sorry, I encountered an error: ${result.error.message}`,
                  result.threadKey
                );
              } catch (sendError) {
                logger.error('Failed to send error via Chat API', { error: sendError.message });
              }
            }
          } finally {
            // CRITICAL: Remove from processing Map after background completion
            this.processingMessages.delete(messageId);
            logger.debug('Removed message from processing Map (background)', {
              messageId,
              remainingCount: this.processingMessages.size
            });
          }
        }).catch(error => {
          logger.error('Unhandled error in background processing', { error: error.message });
          // Cleanup even on error
          this.processingMessages.delete(messageId);
        });

        return raceResult.response; // Return acknowledgment
      } else if (raceResult.type === 'completed') {
        // Processing won the race - return normal response
        await this.cacheMessage(conversationId, user, message.text, raceResult.responseText);

        // CRITICAL: Remove from processing Map after successful completion
        this.processingMessages.delete(messageId);

        return this.createCardResponse(raceResult.responseText);
      } else if (raceResult.type === 'error') {
        // Error occurred before timeout
        logger.error('Error during Google Chat message processing', {
          error: raceResult.error.message
        });

        // CRITICAL: Remove from processing Map after error
        this.processingMessages.delete(messageId);

        return {
          text: '❌ Sorry, I encountered an error processing your message.'
        };
      }
    } catch (error) {
      logger.error('Error handling Google Chat message', {
        error: error.message,
        stack: error.stack
      });

      // CRITICAL: Remove from processing Map on exception
      this.processingMessages.delete(messageId);

      return {
        text: '❌ Sorry, I encountered an error processing your message.'
      };
    }
  }

  /**
   * Process message asynchronously and send result via Chat API
   */
  async processMessageAsync(messageData, eventData, conversationId) {
    try {
      logger.info('Starting async message processing', {
        messageText: messageData.message.substring(0, 100)
      });

      const gemini = getGeminiService();
      const result = await gemini.processMessage(messageData, eventData);

      const responseText = result?.reply || 'Processing complete.';

      // Cache conversation history
      await this.cacheMessage(conversationId, eventData.user, messageData.message, responseText);

      // Send result via Chat API (async, not webhook response)
      const threadKey = eventData.message?.thread?.name || null;
      await this.sendMessage(eventData.space.name, responseText, threadKey);

      logger.info('Async message processing complete', {
        spaceName: eventData.space.name,
        userId: eventData.user.name
      });
    } catch (error) {
      logger.error('Async processing failed, sending error to user', {
        error: error.message,
        spaceName: eventData.space.name
      });

      try {
        await this.sendMessage(
          eventData.space.name,
          `❌ Sorry, I encountered an error: ${error.message}`,
          eventData.message?.thread?.name || null
        );
      } catch (sendError) {
        logger.error('Failed to send error message to user', {
          error: sendError.message
        });
      }
    }
  }

  /**
   * Cache message in conversation history
   */
  async cacheMessage(spaceId, user, messageText, response) {
    try {
      const conversationRef = this.db.collection('conversations').doc(spaceId);
      const conversationDoc = await conversationRef.get();

      // Sanitize response to only include serializable data
      let sanitizedResponse = response;
      if (typeof response === 'object') {
        // Extract only the text content if response is an object
        sanitizedResponse = response?.text || response?.reply || JSON.stringify(response);
      } else if (typeof response !== 'string') {
        // Convert non-string primitives to string
        sanitizedResponse = String(response);
      }

      // Truncate very long responses (Firestore has 1MB limit per document)
      const MAX_RESPONSE_LENGTH = 10000;
      if (sanitizedResponse.length > MAX_RESPONSE_LENGTH) {
        sanitizedResponse = sanitizedResponse.substring(0, MAX_RESPONSE_LENGTH) + '... [truncated]';
      }

      const messageEntry = {
        timestamp: new Date().toISOString(), // Use ISO string instead of serverTimestamp (not allowed in arrays)
        userId: user.name,
        userName: user.displayName || user.name,
        text: messageText,
        response: sanitizedResponse,
        platform: 'google-chat'
      };

      if (!conversationDoc.exists) {
        // Create new conversation
        await conversationRef.set({
          platform: 'google-chat',
          spaceId: spaceId,
          messages: [messageEntry],
          lastActivity: this.FieldValue.serverTimestamp(),
          created: this.FieldValue.serverTimestamp()
        });
      } else {
        // Append to existing conversation (keep last 10 messages)
        const currentMessages = conversationDoc.data().messages || [];
        const updatedMessages = [...currentMessages, messageEntry].slice(-10);

        await conversationRef.update({
          messages: updatedMessages,
          lastActivity: this.FieldValue.serverTimestamp()
        });
      }

      logger.info('Cached Google Chat message', { spaceId, userId: user.name });
    } catch (error) {
      logger.error('Failed to cache message', {
        error: error.message,
        stack: error.stack,
        spaceId,
        userId: user.name,
        responseType: typeof response
      });
      // Don't throw - caching failure shouldn't break message handling
    }
  }

  /**
   * Format text for Google Chat (Markdown)
   * Converts platform-agnostic formatting to Google Chat format
   */
  formatForGoogleChat(text) {
    if (!text) return '';

    return text
      // Convert **bold** to *bold*
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      // Convert bullet points: - to •
      .replace(/^(\s*)- /gm, '$1• ');
  }

  /**
   * Create rich card response (Google Workspace Add-on format)
   */
  createCardResponse(content) {
    return {
      hostAppDataAction: {
        chatDataAction: {
          createMessageAction: {
            message: {
              text: this.formatForGoogleChat(content)
            }
          }
        }
      }
    };
  }

  /**
   * Send async message to space
   */
  async sendMessage(spaceName, text, threadKey = null) {
    await this.initialize();

    try {
      const message = {
        parent: spaceName,
        requestBody: {
          text: this.formatForGoogleChat(text)
        }
      };

      if (threadKey) {
        message.requestBody.thread = { name: threadKey };
      }

      const response = await this.chat.spaces.messages.create(message);
      logger.info('Sent Google Chat message', { spaceName, threadKey });
      return response.data;
    } catch (error) {
      logger.error('Failed to send Google Chat message', { error: error.message });
      throw error;
    }
  }

  /**
   * Handle slash command
   */
  async handleSlashCommand(event) {
    const { message } = event;
    const command = message.slashCommand;

    switch (command.commandName) {
      case '/help':
        return this.getHelpCard();
      case '/task':
        return this.getTaskCreationCard();
      default:
        return { text: 'Unknown command' };
    }
  }

  /**
   * Create help card
   */
  getHelpCard() {
    return {
      cards: [{
        header: {
          title: '📚 Morgan Help',
          subtitle: 'Available Commands & Features'
        },
        sections: [{
          widgets: [{
            textParagraph: {
              text: '<b>Commands:</b>\n' +
                    '• /help - Show this help message\n' +
                    '• /task - Create a task template\n\n' +
                    '<b>Features:</b>\n' +
                    '• Natural language task creation\n' +
                    '• Knowledge base search\n' +
                    '• Real-time web search\n' +
                    '• Complex task execution\n' +
                    '• Asana integration'
            }
          }]
        }]
      }]
    };
  }

  /**
   * Create task creation card
   */
  getTaskCreationCard() {
    return {
      cards: [{
        header: {
          title: '📋 Create Task',
          subtitle: 'Describe the task you want to create'
        },
        sections: [{
          widgets: [{
            textParagraph: {
              text: 'Just describe what you need in natural language, and I\'ll help create a task template or add it to Asana.'
            }
          }]
        }]
      }]
    };
  }

  /**
   * Handle space join event
   */
  async handleSpaceJoin(event) {
    const { space } = event;
    const sanitizedSpaceId = this.sanitizeId(space.name);

    await this.db.collection('google-chat-spaces').doc(sanitizedSpaceId).set({
      spaceName: space.name, // Store original name
      sanitizedId: sanitizedSpaceId,
      spaceType: space.type, // DM or ROOM
      displayName: space.displayName || 'Unknown',
      joinedAt: this.FieldValue.serverTimestamp(),
      active: true
    });

    logger.info('Joined Google Chat space', { spaceName: space.name, sanitizedId: sanitizedSpaceId });
  }

  /**
   * Handle space leave event
   */
  async handleSpaceLeave(event) {
    const { space } = event;
    const sanitizedSpaceId = this.sanitizeId(space.name);

    await this.db.collection('google-chat-spaces').doc(sanitizedSpaceId).update({
      active: false,
      leftAt: this.FieldValue.serverTimestamp()
    });

    logger.info('Left Google Chat space', { spaceName: space.name, sanitizedId: sanitizedSpaceId });
  }

  /**
   * Handle card click event
   */
  async handleCardClick(event) {
    logger.info('Card clicked', { event: event.action });
    return {
      text: 'Card interaction received'
    };
  }

  /**
   * PHASE 15: Handle task feedback from user
   * User provides natural language feedback about what to fix in a task
   */
  async handleTaskFeedback(event) {
    const { message, space, user } = event;
    const messageText = message.text;

    try {
      logger.info('Processing task feedback', {
        userId: user.name,
        spaceName: space.name,
        textLength: messageText.length
      });

      // 1. Parse feedback to extract task reference and modifications
      const feedback = await this.parseTaskFeedback(messageText);

      if (!feedback.taskReference) {
        return this.createCardResponse(
          '❌ I couldn\'t identify which task you\'re referring to. ' +
          'Please mention the task name or ID in your feedback.\n\n' +
          'Example: "The Customer Report task needs a revenue breakdown step."'
        );
      }

      // 2. Find the Asana task
      const { getAsanaService } = require('./asanaService');
      const asana = getAsanaService();

      const task = await asana.findTaskByReference(feedback.taskReference);

      if (!task) {
        return this.createCardResponse(
          `❌ I couldn't find a task matching "${feedback.taskReference}". ` +
          'Please check the task name and try again.'
        );
      }

      // 3. Apply feedback modifications to task
      await asana.applyFeedbackToTask(task.gid, feedback.modifications);

      // 4. Prepare task for retry (mark incomplete, move to Try Again section)
      await asana.prepareTaskForRetry(task.gid, feedback);

      // 5. Cache feedback in conversation history
      await this.cacheFeedbackExchange(space.name, user, messageText, task, feedback);

      // 6. Confirm to user
      return this.createCardResponse(
        `✅ **Task Updated: ${task.name}**\n\n` +
        `**Changes Applied:**\n${this.formatModifications(feedback.modifications)}\n\n` +
        `The task has been marked incomplete and moved to "Morgan - Try Again" for execution.\n\n` +
        `View in Asana: https://app.asana.com/0/${task.gid}`
      );
    } catch (error) {
      logger.error('Error handling task feedback', { error: error.message, stack: error.stack });
      return this.createCardResponse(
        `❌ Error processing feedback: ${error.message}\n\n` +
        'Please try again or update the task directly in Asana.'
      );
    }
  }

  /**
   * PHASE 15: Parse natural language task feedback using Gemini
   */
  async parseTaskFeedback(messageText) {
    const gemini = getGeminiService();

    const prompt = `Analyze this user feedback about a task and extract:
1. Task reference (name or ID mentioned)
2. List of modifications requested (what to add, change, or remove)

User feedback: "${messageText}"

Respond in JSON format:
{
  "taskReference": "exact task name or ID mentioned",
  "modifications": [
    {
      "type": "add_step|modify_step|remove_step|update_description",
      "description": "what to add/change/remove",
      "details": "additional context if any"
    }
  ],
  "summary": "brief summary of requested changes"
}`;

    try {
      const response = await gemini.generateResponse(prompt, {
        platform: 'google-chat',
        responseFormat: 'json'
      });

      // Try to parse JSON response
      let parsed;
      try {
        parsed = JSON.parse(response);
      } catch (parseError) {
        // If response is not JSON, try to extract JSON from text
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('Could not parse feedback response as JSON');
        }
      }

      logger.info('Parsed task feedback', {
        taskReference: parsed.taskReference,
        modificationsCount: parsed.modifications?.length || 0
      });

      return parsed;
    } catch (error) {
      logger.error('Failed to parse task feedback', { error: error.message });
      // Return empty structure on parse failure
      return {
        taskReference: null,
        modifications: [],
        summary: 'Failed to parse feedback'
      };
    }
  }

  /**
   * PHASE 15: Format modifications for display
   */
  formatModifications(modifications) {
    if (!modifications || modifications.length === 0) {
      return '(No specific modifications detected)';
    }

    return modifications.map((mod, idx) => {
      const icon = mod.type === 'add_step' ? '➕' :
                   mod.type === 'modify_step' ? '✏️' :
                   mod.type === 'remove_step' ? '➖' : '📝';

      let line = `${icon} ${mod.description}`;
      if (mod.details) {
        line += `\n   ${mod.details}`;
      }
      return line;
    }).join('\n');
  }

  /**
   * PHASE 15: Cache feedback exchange in conversation history
   */
  async cacheFeedbackExchange(spaceId, user, messageText, task, feedback) {
    try {
      await this.db.collection('conversations').doc(spaceId).set({
        messages: this.FieldValue.arrayUnion({
          timestamp: new Date().toISOString(),
          userId: user.name,
          userName: user.displayName || user.name,
          text: messageText,
          response: `Task updated: ${task.name}`,
          toolsUsed: ['AsanaTaskManager'],
          metadata: {
            type: 'task_feedback',
            asanaTaskGid: task.gid,
            asanaTaskName: task.name,
            modificationsCount: feedback.modifications.length
          }
        }),
        lastActivity: this.FieldValue.serverTimestamp()
      }, { merge: true });

      logger.info('Cached feedback exchange', {
        spaceId,
        taskGid: task.gid,
        modificationsCount: feedback.modifications.length
      });
    } catch (error) {
      logger.error('Failed to cache feedback exchange', { error: error.message });
      // Don't throw - caching failure shouldn't break feedback handling
    }
  }
}

let instance = null;

function getGoogleChatService() {
  if (!instance) {
    instance = new GoogleChatService();
  }
  return instance;
}

module.exports = { getGoogleChatService };
