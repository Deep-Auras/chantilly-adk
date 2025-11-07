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
        space: space,
        user: user
      };

      const result = await gemini.processMessage(messageData, eventData);

      // result may be null if tool handled messaging, or an object with reply
      const responseText = result?.reply || 'Message processed successfully.';

      // Cache conversation history (use sanitized IDs)
      await this.cacheMessage(conversationId, user, message.text, responseText);

      // Return card UI response
      return this.createCardResponse(responseText);
    } catch (error) {
      logger.error('Error handling Google Chat message', { error: error.message, stack: error.stack });
      return {
        text: '❌ Sorry, I encountered an error processing your message.'
      };
    }
  }

  /**
   * Cache message in conversation history
   */
  async cacheMessage(spaceId, user, messageText, response) {
    try {
      const conversationRef = this.db.collection('conversations').doc(spaceId);
      const conversationDoc = await conversationRef.get();

      const messageEntry = {
        timestamp: this.FieldValue.serverTimestamp(),
        userId: user.name,
        userName: user.displayName || user.name,
        text: messageText,
        response: response,
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
      logger.error('Failed to cache message', { error: error.message });
      // Don't throw - caching failure shouldn't break message handling
    }
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
              text: content
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
          text: text
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
}

let instance = null;

function getGoogleChatService() {
  if (!instance) {
    instance = new GoogleChatService();
  }
  return instance;
}

module.exports = { getGoogleChatService };
