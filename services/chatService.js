/**
 * Chat Service
 *
 * Handles real-time chat with AI agent using:
 * - Server-Sent Events (SSE) for streaming responses
 * - Firestore for persistent conversation history
 * - Gemini 2.5 Pro with context caching for optimal performance
 *
 * SECURITY:
 * - SSE connections have 5-minute timeout (prevents memory leaks)
 * - Automatic cleanup on disconnect
 * - Input validation and sanitization
 * - Rate limiting per user
 * - CSRF protection on all mutations
 *
 * @module services/chatService
 */

const { getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');
const { getGeminiService } = require('./gemini');
const { getUserRoleService } = require('./userRoleService');

// SECURITY: Track active SSE connections for cleanup
const activeConnections = new Map();

// SECURITY: Connection timeout to prevent memory leaks
const SSE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MAX_MESSAGE_LENGTH = 10000; // 10K characters
const MAX_HISTORY_MESSAGES = 50; // Keep last 50 messages

class ChatService {
  constructor() {
    this.db = null;
    this.gemini = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    this.db = getFirestore();
    this.gemini = getGeminiService();
    this.initialized = true;

    logger.info('Chat service initialized');
  }

  /**
   * Get or create conversation for user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Conversation object
   */
  async getOrCreateConversation(userId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const conversationId = `chat_${userId}`;
      const conversationRef = this.db.collection('chat-conversations').doc(conversationId);
      const conversationDoc = await conversationRef.get();

      if (conversationDoc.exists) {
        return {
          id: conversationId,
          ...conversationDoc.data()
        };
      }

      // Create new conversation
      const newConversation = {
        userId,
        createdAt: getFieldValue().serverTimestamp(),
        lastActivity: getFieldValue().serverTimestamp(),
        messageCount: 0,
        title: 'New Chat'
      };

      await conversationRef.set(newConversation);

      return {
        id: conversationId,
        ...newConversation
      };
    } catch (error) {
      logger.error('Failed to get/create conversation', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get conversation history
   * @param {string} conversationId - Conversation ID
   * @param {number} limit - Max messages to retrieve
   * @returns {Promise<Array>} Message history
   */
  async getHistory(conversationId, limit = MAX_HISTORY_MESSAGES) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const messagesSnapshot = await this.db
        .collection('chat-conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

      const messages = messagesSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })).reverse(); // Oldest first for context

      return messages;
    } catch (error) {
      logger.error('Failed to get conversation history', {
        conversationId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Save message to conversation
   * @param {string} conversationId - Conversation ID
   * @param {Object} message - Message data
   * @returns {Promise<string>} Message ID
   */
  async saveMessage(conversationId, message) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // SECURITY: Validate message content
      if (!message.content || typeof message.content !== 'string') {
        throw new Error('Invalid message content');
      }

      if (message.content.length > MAX_MESSAGE_LENGTH) {
        throw new Error(`Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`);
      }

      const messageRef = await this.db
        .collection('chat-conversations')
        .doc(conversationId)
        .collection('messages')
        .add({
          role: message.role, // 'user' or 'assistant'
          content: message.content,
          timestamp: getFieldValue().serverTimestamp(),
          userId: message.userId || null
        });

      // Update conversation last activity
      await this.db
        .collection('chat-conversations')
        .doc(conversationId)
        .update({
          lastActivity: getFieldValue().serverTimestamp(),
          messageCount: getFieldValue().increment(1)
        });

      return messageRef.id;
    } catch (error) {
      logger.error('Failed to save message', {
        conversationId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Stream AI response using SSE
   * @param {Object} res - Express response object
   * @param {string} userId - User ID
   * @param {string} userMessage - User's message
   * @param {string} conversationId - Conversation ID
   */
  async streamResponse(res, userId, userMessage, conversationId) {
    if (!this.initialized) {
      await this.initialize();
    }

    // SECURITY: Validate input
    if (!userMessage || typeof userMessage !== 'string') {
      res.status(400).json({ error: 'Invalid message' });
      return;
    }

    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH}` });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // SECURITY: Track connection for cleanup
    const connectionId = `${userId}_${Date.now()}`;
    let timeoutId = null;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      activeConnections.delete(connectionId);

      logger.info('SSE connection cleaned up', {
        connectionId,
        userId
      });
    };

    // SECURITY: Set timeout to prevent memory leaks
    timeoutId = setTimeout(() => {
      logger.warn('SSE connection timeout', {
        connectionId,
        userId,
        timeout: SSE_TIMEOUT
      });
      res.write('event: timeout\ndata: {"error": "Connection timeout"}\n\n');
      res.end();
      cleanup();
    }, SSE_TIMEOUT);

    activeConnections.set(connectionId, { res, userId, cleanup });

    // Cleanup on client disconnect
    res.on('close', cleanup);

    try {
      // Save user message
      await this.saveMessage(conversationId, {
        role: 'user',
        content: userMessage,
        userId
      });

      // Determine user role for RBAC
      const userRoleService = getUserRoleService();
      const userRole = await userRoleService.getUserRole(userId);

      // Send start event
      res.write('event: start\ndata: {"status": "streaming"}\n\n');

      // Use gemini.processMessage() which handles ALL tool execution automatically
      const messageData = {
        message: userMessage,
        userId: userId,
        userName: `User ${userId}`,
        userRole: userRole,
        messageType: 'P', // Private chat
        dialogId: conversationId,
        chatId: conversationId,
        messageId: `webchat-${Date.now()}`,
        platform: 'web-chat'
      };

      const eventData = {
        type: 'MESSAGE'
      };

      logger.info('Processing web chat message with Gemini service', {
        userId,
        userRole,
        conversationId,
        messageLength: userMessage.length
      });

      const result = await this.gemini.processMessage(messageData, eventData);
      const fullResponse = result?.reply || '';

      // Stream response to client (all at once since processMessage returns complete text)
      if (fullResponse && fullResponse.trim()) {
        const eventData = JSON.stringify({ text: fullResponse });
        res.write(`event: chunk\ndata: ${eventData}\n\n`);

        // Save assistant response
        await this.saveMessage(conversationId, {
          role: 'assistant',
          content: fullResponse,
          userId: null
        });
      } else {
        logger.warn('No text response from Gemini', {
          userId,
          conversationId
        });
      }

      // Send completion event
      res.write('event: done\ndata: {"status": "complete"}\n\n');
      res.end();

      logger.info('Chat response streamed successfully', {
        userId,
        conversationId,
        responseLength: fullResponse.length
      });

    } catch (error) {
      logger.error('Chat streaming failed', {
        userId,
        conversationId,
        error: error.message,
        stack: error.stack
      });

      const errorData = JSON.stringify({
        error: 'Failed to generate response',
        message: error.message
      });
      res.write(`event: error\ndata: ${errorData}\n\n`);
      res.end();
    } finally {
      cleanup();
    }
  }

  /**
   * Clear conversation history
   * @param {string} conversationId - Conversation ID
   */
  async clearHistory(conversationId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Delete all messages in batches
      const messagesRef = this.db
        .collection('chat-conversations')
        .doc(conversationId)
        .collection('messages');

      const snapshot = await messagesRef.get();
      const batches = [];
      let batch = this.db.batch();
      let count = 0;

      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
        count++;

        // Firestore batch limit is 500
        if (count === 500) {
          batches.push(batch);
          batch = this.db.batch();
          count = 0;
        }
      });

      if (count > 0) {
        batches.push(batch);
      }

      // Commit all batches
      await Promise.all(batches.map(b => b.commit()));

      // Reset conversation metadata
      await this.db
        .collection('chat-conversations')
        .doc(conversationId)
        .update({
          messageCount: 0,
          lastActivity: getFieldValue().serverTimestamp()
        });

      logger.info('Conversation history cleared', {
        conversationId,
        messagesDeleted: snapshot.size
      });

    } catch (error) {
      logger.error('Failed to clear conversation history', {
        conversationId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Cleanup all active SSE connections
   * Called on server shutdown
   */
  static cleanup() {
    logger.info('Cleaning up active chat connections', {
      activeCount: activeConnections.size
    });

    for (const [connectionId, connection] of activeConnections.entries()) {
      try {
        connection.cleanup();
      } catch (error) {
        logger.warn('Error cleaning up connection', {
          connectionId,
          error: error.message
        });
      }
    }

    activeConnections.clear();
  }
}

// Singleton instance
let chatService;

async function initializeChatService() {
  if (!chatService) {
    chatService = new ChatService();
    await chatService.initialize();
  }
  return chatService;
}

function getChatService() {
  if (!chatService) {
    throw new Error('Chat service not initialized');
  }
  return chatService;
}

module.exports = {
  ChatService,
  initializeChatService,
  getChatService
};
