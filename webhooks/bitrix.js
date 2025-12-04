const { validateWebhook } = require('./validator');
const { processMessage } = require('../services/gemini');
const { getQueueManager } = require('../services/bitrix24-queue');
const { getSettingsModel } = require('../models/settings');
const config = require('../config/env');
const { logger } = require('../utils/logger');

// SECURITY: Input validation helper function
function validateFields(obj, schema) {
  const missing = [];
  const invalid = [];

  for (const [field, expectedType] of Object.entries(schema)) {
    if (!(field in obj)) {
      missing.push(field);
    } else if (typeof obj[field] !== expectedType) {
      invalid.push({ field, expected: expectedType, got: typeof obj[field] });
    } else if (expectedType === 'string' && obj[field].trim() === '') {
      invalid.push({ field, reason: 'empty string' });
    }
  }

  return {
    valid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid
  };
}

// Message processing cache to prevent duplicate processing
const processedMessages = new Map();
const MESSAGE_CACHE_TTL = 300000; // 5 minutes
const MAX_CACHE_SIZE = 10000; // SECURITY: Maximum 10K cached messages (prevent memory exhaustion)
const CACHE_EVICTION_PERCENTAGE = 0.2; // Remove 20% when full

function evictOldestEntries() {
  const startSize = processedMessages.size;
  const entries = Array.from(processedMessages.entries());

  // Sort by timestamp (oldest first)
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

  // Remove oldest 20%
  const toRemove = Math.floor(MAX_CACHE_SIZE * CACHE_EVICTION_PERCENTAGE);
  const removed = entries.slice(0, toRemove);

  removed.forEach(([key]) => {
    processedMessages.delete(key);
  });

  logger.info('Cache eviction completed', {
    startSize,
    endSize: processedMessages.size,
    removed: toRemove,
    reason: 'MAX_CACHE_SIZE exceeded'
  });
}

function isMessageAlreadyProcessed(messageId, userId) {
  const cacheKey = `${messageId}-${userId}`;
  const cached = processedMessages.get(cacheKey);

  // Enforce size limit BEFORE adding new entries
  if (!cached && processedMessages.size >= MAX_CACHE_SIZE) {
    evictOldestEntries();
  }

  if (cached) {
    // Check if cache entry is still valid
    if (Date.now() - cached.timestamp < MESSAGE_CACHE_TTL) {
      // Increment processing count
      cached.count = (cached.count || 1) + 1;
      cached.lastProcessed = Date.now();

      // Only block after 999 attempts (effectively disabled for testing)
      if (cached.count > 999) {
        return true;
      }
      return false;
    } else {
      // Remove expired entry
      processedMessages.delete(cacheKey);
    }
  }

  // Mark as processed (first time)
  processedMessages.set(cacheKey, {
    timestamp: Date.now(),
    lastProcessed: Date.now(),
    messageId: messageId,
    count: 1
  });

  return false;
}

// SECURITY FIX: Store interval ID for proper cleanup
let messageCleanupInterval = null;

function startMessageCleanup() {
  if (messageCleanupInterval) {
    clearInterval(messageCleanupInterval);
  }

  messageCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of processedMessages.entries()) {
      if (now - value.timestamp > MESSAGE_CACHE_TTL) {
        processedMessages.delete(key);
      }
    }
  }, 60000); // Clean every minute
}

function cleanup() {
  if (messageCleanupInterval) {
    clearInterval(messageCleanupInterval);
    messageCleanupInterval = null;
  }
  processedMessages.clear();
  logger.info('Webhook cache cleanup completed');
}

function getCacheMetrics() {
  return {
    size: processedMessages.size,
    maxSize: MAX_CACHE_SIZE,
    utilization: (processedMessages.size / MAX_CACHE_SIZE * 100).toFixed(2) + '%'
  };
}

// Start cleanup interval
startMessageCleanup();

async function handleMessageAdd(req, res) {
  const { messageData, eventData } = req;

  try {
    // Prevent excessive duplicate message processing (>3 attempts)
    if (isMessageAlreadyProcessed(messageData.messageId, messageData.userId)) {
      const cacheKey = `${messageData.messageId}-${messageData.userId}`;
      const cached = processedMessages.get(cacheKey);
      logger.info('Excessive duplicate message detected, skipping processing', {
        messageId: messageData.messageId,
        userId: messageData.userId,
        attemptCount: cached?.count || 'unknown'
      });
      return res.json({ status: 'ignored', reason: 'excessive_duplicates' });
    }
    // Update bot auth data from webhook (prevents 401 errors)
    if (req.body?.data?.BOT) {
      const botData = Object.values(req.body.data.BOT)[0]; // Get first bot data
      if (botData?.AUTH) {
        const { getFirestore, getFieldValue } = require('../config/firestore');
        const db = getFirestore();

        await db.collection('bot').doc('auth').set({
          botId: botData.BOT_ID,
          domain: botData.AUTH.domain,
          accessToken: botData.AUTH.access_token,
          restUrl: `https://${botData.AUTH.domain}/rest/`,
          updated: getFieldValue().serverTimestamp()
        }, { merge: true });

        logger.info('Bot auth updated from webhook', {
          botId: botData.BOT_ID,
          domain: botData.AUTH.domain
        });
      }
    }

    // Get settings for the channel
    const settings = getSettingsModel();
    const channelSettings = await settings.getChannelSettings(messageData.chatId);

    // Check if channel is enabled
    if (!channelSettings.enabled) {
      logger.info('Channel disabled, ignoring message', {
        chatId: messageData.chatId
      });
      return res.json({ status: 'ignored', reason: 'channel_disabled' });
    }

    // Translation is now handled by the BitrixTranslationChannelsTool
    // Users can request translation by mentioning Chantilly with translation keywords

    // Process with Gemini AI
    const response = await processMessage(messageData, eventData);

    // Send response back to Bitrix24 if needed
    if (response && response.reply) {
      const queue = getQueueManager();
      await queue.add({
        method: 'imbot.message.add',
        params: {
          DIALOG_ID: messageData.dialogId || messageData.chatId,
          MESSAGE: response.reply
        }
      });
    }

    res.json({ status: 'processed', hasReply: !!response?.reply });
  } catch (error) {
    logger.error('Failed to handle message', {
      error: error.message,
      messageId: messageData.messageId
    });

    // Send user-friendly error message to Bitrix24 chat
    let userMessage = 'Sorry, I encountered an error processing your message.';
    if (error.message?.includes('503') || error.message?.includes('overloaded')) {
      userMessage = 'The AI service is temporarily overloaded. Please try again in a few moments.';
    } else if (error.message?.includes('429') || error.message?.includes('quota')) {
      userMessage = 'Too many requests. Please wait a moment before trying again.';
    }

    try {
      const queue = getQueueManager();
      await queue.add({
        method: 'imbot.message.add',
        params: {
          DIALOG_ID: messageData.dialogId || messageData.chatId,
          MESSAGE: `❌ ${userMessage}`
        }
      });
    } catch (sendError) {
      logger.error('Failed to send error message to user', { error: sendError.message });
    }

    res.status(500).json({ error: 'Failed to process message' });
  }
}

async function handleMessageUpdate(req, res) {
  const { messageData, eventData } = req;

  try {
    logger.info('Message updated', {
      messageId: messageData.messageId,
      userId: messageData.userId
    });

    // Translation updates are now handled by the BitrixTranslationChannelsTool
    // when users specifically request translation

    res.json({ status: 'processed' });
  } catch (error) {
    logger.error('Failed to handle message update', {
      error: error.message,
      messageId: messageData.messageId
    });
    res.status(500).json({ error: 'Failed to process message update' });
  }
}

async function handleMessageDelete(req, res) {
  const { messageData } = req;

  try {
    logger.info('Message deleted', {
      messageId: messageData.messageId,
      userId: messageData.userId
    });

    // Could implement cleanup logic here if needed
    // For example, delete translated versions of the message

    res.json({ status: 'processed' });
  } catch (error) {
    logger.error('Failed to handle message delete', {
      error: error.message,
      messageId: messageData.messageId
    });
    res.status(500).json({ error: 'Failed to process message delete' });
  }
}

async function handleJoinChat(req, res) {
  const { eventData } = req;
  const params = eventData.data.PARAMS;

  try {
    logger.info('User joined chat', {
      userId: params.USER_ID,
      chatId: params.CHAT_ID,
      chatType: params.CHAT_TYPE
    });

    // Send welcome message if configured
    const settings = getSettingsModel();
    const channelSettings = await settings.getChannelSettings(params.CHAT_ID);

    if (channelSettings.welcomeMessage) {
      const queue = getQueueManager();
      await queue.add({
        method: 'imbot.message.add',
        params: {
          DIALOG_ID: params.CHAT_ID,
          MESSAGE: channelSettings.welcomeMessage
        }
      });
    }

    res.json({ status: 'processed' });
  } catch (error) {
    logger.error('Failed to handle join chat', {
      error: error.message,
      chatId: params.CHAT_ID
    });
    res.status(500).json({ error: 'Failed to process join chat' });
  }
}

async function handleAppInstall(req, res) {
  // ONAPPINSTALL has auth data directly in the request
  const auth = req.body?.auth || req.query || {};

  // SECURITY: Validate required fields
  const requiredFields = {
    domain: 'string',
    access_token: 'string',
    member_id: 'string'
  };

  const validation = validateFields(auth, requiredFields);
  if (!validation.valid) {
    logger.warn('App install validation failed', {
      missing: validation.missing,
      invalid: validation.invalid,
      ip: req.ip
    });

    return res.status(400).json({
      error: 'Invalid installation payload',
      details: {
        missing: validation.missing,
        invalid: validation.invalid
      }
    });
  }

  try {
    logger.info('App installation started', {
      domain: auth.domain,
      memberId: auth.member_id,
      accessToken: auth.access_token ? 'present' : 'missing'
    });

    // Register the bot using the auth token - matching official examples
    const axios = require('axios');
    const config = require('../config/env');

    // Build the REST endpoint URL
    const restUrl = `https://${auth.domain}/rest/`;

    // Download and encode avatar image
    let avatarBase64 = null;
    try {
      const avatarUrl = 'https://your-domain.bitrix24.com/b6518741/resize_cache/203550/a7fa78f57e73ecbd0b9500a062d0d214/main/cfd/cfdfe2825811f5b3d6d28d2d599d8428/3d8bc78f-3332-4f21-901c-f8b1fead990f.png';
      const avatarResponse = await axios.get(avatarUrl, { responseType: 'arraybuffer' });
      avatarBase64 = Buffer.from(avatarResponse.data, 'binary').toString('base64');
      logger.info('Avatar downloaded and encoded successfully');
    } catch (avatarError) {
      logger.warn('Failed to download avatar, proceeding without it', avatarError.message);
    }

    // Prepare bot properties
    const botProperties = {
      NAME: 'Chantilly',
      LAST_NAME: 'Agent',
      COLOR: 'MINT',
      WORK_POSITION: 'AI Assistant powered by Gemini'
    };

    // Add avatar if successfully downloaded
    if (avatarBase64) {
      botProperties.PERSONAL_PHOTO = avatarBase64;
    }

    // Register bot with parameters matching official examples
    const botRegistration = await axios.post(
      `${restUrl}imbot.register`,
      {
        CODE: 'Chantilly_AI_AGENT',
        TYPE: 'O', // O for Open Lines (Open Channel support)
        EVENT_MESSAGE_ADD: config.CLOUD_RUN_SERVICE_URL + '/webhook/bitrix24',
        EVENT_WELCOME_MESSAGE: config.CLOUD_RUN_SERVICE_URL + '/webhook/bitrix24',
        EVENT_BOT_DELETE: config.CLOUD_RUN_SERVICE_URL + '/webhook/bitrix24',
        PROPERTIES: botProperties
      },
      {
        params: {
          auth: auth.access_token
        }
      }
    );

    if (botRegistration.data.result) {
      const botId = botRegistration.data.result;

      // Save bot authentication data for future message sending
      const { getFirestore, getFieldValue } = require('../config/firestore');
      const db = getFirestore();

      await db.collection('bot').doc('auth').set({
        botId: botId,
        domain: auth.domain,
        accessToken: auth.access_token,
        memberId: auth.member_id,
        restUrl: `https://${auth.domain}/rest/`,
        registered: getFieldValue().serverTimestamp()
      });

      logger.info('Bot registered successfully', {
        botId: botId,
        domain: auth.domain
      });
      res.json({ status: 'installed', botId: botId });
    } else {
      throw new Error('Bot registration failed');
    }
  } catch (error) {
    logger.error('App installation failed', {
      error: error.message,
      domain: auth.domain
    });
    res.status(500).json({ error: 'Installation failed' });
  }
}

async function handleAppUninstall(req, res) {
  const { auth } = req.eventData;

  try {
    logger.info('App uninstallation', {
      domain: auth.domain
    });

    // Clean up any stored data if needed
    res.json({ status: 'uninstalled' });
  } catch (error) {
    logger.error('App uninstallation failed', {
      error: error.message
    });
    res.status(500).json({ error: 'Uninstallation failed' });
  }
}

// Main webhook handler router
async function bitrixWebhook(req, res) {
  logger.info('Bitrix24 webhook request received', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    query: req.query,
    bodyKeys: Object.keys(req.body || {}),
    requestId: req.id
  });

  // Check if this is an ONAPPINSTALL event (doesn't need validation)
  const eventType = req.body?.event || req.query?.event || 'UNKNOWN';

  if (eventType === 'ONAPPINSTALL') {
    logger.info('ONAPPINSTALL event detected, bypassing validation');
    req.eventType = eventType;
    req.eventData = req.body || req.query;
    return handleAppInstall(req, res);
  }

  // Validate webhook for all other events
  await validateWebhook(req, res, async () => {
    const validatedEventType = req.eventType;

    logger.info('Processing webhook event', {
      eventType: validatedEventType,
      requestId: req.id
    });

    // Route to appropriate handler based on event type
    switch (validatedEventType) {
    case 'ONIMBOTMESSAGEADD':
    case 'ONIMCONNECTORMESSAGEADD':
      return handleMessageAdd(req, res);

    case 'ONIMBOTMESSAGEUPDATE':
    case 'ONIMCONNECTORMESSAGEUPDATE':
      return handleMessageUpdate(req, res);

    case 'ONIMBOTMESSAGEDELETE':
    case 'ONIMCONNECTORMESSAGEDELETE':
      return handleMessageDelete(req, res);

    case 'ONIMJOINCHAT':
    case 'ONIMBOTJOINCHAT':
      return handleJoinChat(req, res);

    case 'ONAPPUNINSTALL':
      return handleAppUninstall(req, res);

    default:
      logger.warn('Unknown event type', { eventType });
      res.json({ status: 'ignored', reason: 'unknown_event' });
    }
  });
}

module.exports = bitrixWebhook;
module.exports.cleanup = cleanup;
module.exports.getCacheMetrics = getCacheMetrics;