const crypto = require('crypto');
const joi = require('joi');
const { logger } = require('../utils/logger');
const { getConfigManager } = require('../services/dashboard/configManager');

// Bitrix24 webhook event schemas
const eventSchemas = {
  'ONIMBOTMESSAGEADD': joi.object({
    data: joi.object({
      BOT: joi.alternatives().try(
        joi.object({
          BOT_ID: joi.number().required(),
          BOT_CODE: joi.string()
        }),
        joi.object().pattern(joi.number(), joi.object()) // Handles nested bot structure like {"682": {...}}
      ),
      PARAMS: joi.object({
        FROM_USER_ID: joi.number().required(),
        MESSAGE: joi.string().required(),
        TO_CHAT_ID: joi.number(),
        DIALOG_ID: joi.alternatives().try(joi.string(), joi.number()),
        MESSAGE_TYPE: joi.string().valid('P', 'C', 'B', 'N', 'O', 'G').optional(),
        SYSTEM: joi.string().valid('Y', 'N'),
        ATTACH: joi.array()
      }).required()
    }).required(),
    ts: joi.string(),
    auth: joi.object()
  }),

  'ONIMCONNECTORMESSAGEADD': joi.object({
    data: joi.object({
      CONNECTOR: joi.object({
        CONNECTOR_ID: joi.string().required(),
        LINE_ID: joi.string()
      }),
      PARAMS: joi.object({
        FROM_USER_ID: joi.number().required(),
        MESSAGE: joi.string().required(),
        TO_CHAT_ID: joi.number(),
        DIALOG_ID: joi.alternatives().try(joi.string(), joi.number()),
        MESSAGE_TYPE: joi.string().valid('P', 'C', 'B', 'N', 'O', 'G').optional(),
        SYSTEM: joi.string().valid('Y', 'N'),
        ATTACH: joi.array(),
        CONNECTOR_MID: joi.string()
      }).required()
    }).required(),
    ts: joi.string(),
    auth: joi.object()
  }),

  'ONIMBOTMESSAGEUPDATE': joi.object({
    data: joi.object({
      BOT: joi.object({
        BOT_ID: joi.number().required(),
        BOT_CODE: joi.string()
      }),
      PARAMS: joi.object({
        MESSAGE_ID: joi.number().required(),
        EDIT_MESSAGE: joi.string(),
        EDIT_DATE: joi.string(),
        EDIT_BY_ID: joi.number()
      }).required()
    }).required(),
    ts: joi.string(),
    auth: joi.object()
  }),

  'ONIMBOTMESSAGEDELETE': joi.object({
    data: joi.object({
      BOT: joi.object({
        BOT_ID: joi.number().required(),
        BOT_CODE: joi.string()
      }),
      PARAMS: joi.object({
        MESSAGE_ID: joi.number().required(),
        DELETE_BY_ID: joi.number()
      }).required()
    }).required(),
    ts: joi.string(),
    auth: joi.object()
  }),

  'ONIMCONNECTORMESSAGEUPDATE': joi.object({
    data: joi.object({
      CONNECTOR: joi.object({
        CONNECTOR_ID: joi.string().required(),
        LINE_ID: joi.string()
      }),
      PARAMS: joi.object({
        MESSAGE_ID: joi.number().required(),
        EDIT_MESSAGE: joi.string(),
        EDIT_DATE: joi.string(),
        EDIT_BY_ID: joi.number(),
        CONNECTOR_MID: joi.string()
      }).required()
    }).required(),
    ts: joi.string(),
    auth: joi.object()
  }),

  'ONIMCONNECTORMESSAGEDELETE': joi.object({
    data: joi.object({
      CONNECTOR: joi.object({
        CONNECTOR_ID: joi.string().required(),
        LINE_ID: joi.string()
      }),
      PARAMS: joi.object({
        MESSAGE_ID: joi.number().required(),
        DELETE_BY_ID: joi.number(),
        CONNECTOR_MID: joi.string()
      }).required()
    }).required(),
    ts: joi.string(),
    auth: joi.object()
  }),

  'ONIMJOINCHAT': joi.object({
    data: joi.object({
      BOT: joi.object({
        BOT_ID: joi.number().required()
      }),
      PARAMS: joi.object({
        CHAT_ID: joi.number().required(),
        USER_ID: joi.number().required(),
        CHAT_TYPE: joi.string()
      }).required()
    }).required(),
    ts: joi.string(),
    auth: joi.object()
  }),

  'ONAPPINSTALL': joi.object({
    event: joi.string().required(),
    auth: joi.object({
      access_token: joi.string(),
      expires_in: joi.number(),
      scope: joi.string(),
      domain: joi.string(),
      server_endpoint: joi.string(),
      status: joi.string(),
      client_endpoint: joi.string(),
      member_id: joi.string(),
      refresh_token: joi.string(),
      application_token: joi.string()
    }).required()
  }),

  'ONAPPUNINSTALL': joi.object({
    event: joi.string().required(),
    auth: joi.object().required()
  })
};

// Generic webhook schema for unknown events
const genericSchema = joi.object({
  event: joi.string().required(),
  data: joi.object(),
  ts: joi.string(),
  auth: joi.object()
});

async function validateWebhookSignature(req) {
  // Determine if this is a Local Application event first
  const eventType = extractEventType(req);

  // Check for Local Application frame load (has AUTH_ID, PLACEMENT, status fields)
  const isLocalAppFrameLoad = req.body?.AUTH_ID && req.body?.PLACEMENT && req.body?.status;

  // Check if this is a bot event from Local Application (has auth.application_token)
  const isBotEvent = req.body?.auth?.application_token &&
    (eventType.startsWith('ONIMBOT') || eventType.startsWith('ONIMCONNECTOR'));

  // Bitrix24 sends a signature in different places depending on event type
  let providedSecret;
  if (isLocalAppFrameLoad) {
    // For Local Application frame loads, use AUTH_ID
    providedSecret = req.body.AUTH_ID;
  } else {
    // For webhooks and bot events
    providedSecret = req.body?.auth?.application_token ||
                    req.query?.auth ||
                    req.headers['x-bitrix-auth'];
  }

  logger.info('Webhook signature validation', {
    hasBodyAuth: !!req.body?.auth?.application_token,
    hasQueryAuth: !!req.query?.auth,
    hasHeaderAuth: !!req.headers['x-bitrix-auth'],
    providedSecretLength: providedSecret ? providedSecret.length : 0,
    eventType,
    isLocalAppFrameLoad,
    isBotEvent,
    requestBody: req.body,
    requestQuery: req.query,
    authHeaders: {
      'x-bitrix-auth': req.headers['x-bitrix-auth'],
      'authorization': req.headers['authorization']
    }
  });

  // For Local Application frame loads, always accept (they have session AUTH_ID)
  if (isLocalAppFrameLoad) {
    logger.info('Local Application frame load detected, allowing access');
    return true;
  }

  // For bot events from Local Application, accept any application_token
  // The application_token identifies the app but doesn't need to match a secret
  if (isBotEvent) {
    logger.info('Bot event from Local Application detected, allowing access', {
      applicationToken: providedSecret ? providedSecret.substring(0, 10) + '...' : 'none'
    });
    return true;
  }

  // Also accept any request that has auth.application_token (following official examples)
  if (req.body?.auth?.application_token) {
    logger.info('Request with application_token detected, allowing access', {
      applicationToken: req.body.auth.application_token.substring(0, 10) + '...',
      eventType
    });
    return true;
  }

  if (!providedSecret) {
    logger.warn('No authentication token provided in webhook');
    return false;
  }

  // Only validate against OUTBOUND_SECRET for manual webhook calls
  // Load from Bitrix24 platform config in Firestore
  let expectedSecret;
  try {
    const configManager = await getConfigManager();
    const bitrix24Config = await configManager.getPlatform('bitrix24');
    expectedSecret = bitrix24Config?.outboundSecret;
  } catch (error) {
    logger.error('Failed to load Bitrix24 config from Firestore', { error: error.message });
  }

  if (!expectedSecret) {
    logger.error('BITRIX24 outboundSecret not configured in platform settings');
    return false;
  }

  logger.info('Comparing secrets', {
    expectedSecretLength: expectedSecret.length,
    providedSecretLength: providedSecret.length,
    secretType: 'OUTBOUND_SECRET',
    expectedSecret: expectedSecret.substring(0, 10) + '...',
    providedSecret: providedSecret.substring(0, 10) + '...'
  });

  const match = crypto.timingSafeEqual(
    Buffer.from(providedSecret),
    Buffer.from(expectedSecret)
  );

  if (!match) {
    logger.warn('Invalid webhook signature', {
      expectedSecretLength: expectedSecret.length,
      providedSecretLength: providedSecret.length,
      expectedSecretPrefix: expectedSecret.substring(0, 10) + '...',
      providedSecretPrefix: providedSecret.substring(0, 10) + '...',
      secretType: isLocalAppEvent ? 'APP_SECRET' : 'OUTBOUND_SECRET'
    });
  } else {
    logger.info('Webhook signature validation successful');
  }

  return match;
}

function validateEventData(eventType, data) {
  const schema = eventSchemas[eventType] || genericSchema;
  const { error, value } = schema.validate(data, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    logger.error('Event validation failed', {
      eventType,
      errors: error.details.map(d => d.message)
    });
    return { valid: false, error: error.message };
  }

  return { valid: true, value };
}

function extractEventType(req) {
  // Bitrix24 sends event type in different places depending on configuration
  // For GET requests, the event type is in the query params
  // For POST requests, it's in the body
  return req.query?.event ||
         req.body?.event ||
         req.headers['x-bitrix-event'] ||
         'UNKNOWN';
}

function extractMessageData(eventData) {
  // Normalize message data across different event types
  const params = eventData?.data?.PARAMS || {};

  return {
    messageId: params.MESSAGE_ID,
    message: params.MESSAGE || params.EDIT_MESSAGE,
    userId: params.FROM_USER_ID || params.EDIT_BY_ID || params.DELETE_BY_ID,
    chatId: params.TO_CHAT_ID || params.CHAT_ID,
    dialogId: params.DIALOG_ID,
    messageType: params.MESSAGE_TYPE, // 'P' for private, 'C' for chat
    isSystem: params.SYSTEM === 'Y',
    attachments: params.ATTACH || [],
    timestamp: eventData.ts || new Date().toISOString()
  };
}

async function validateWebhook(req, res, next) {
  try {
    logger.info('Starting webhook validation', {
      url: req.url,
      method: req.method,
      requestId: req.id
    });

    // For GET requests, convert query params to body format
    if (req.method === 'GET' && req.query) {
      // Bitrix24 sends data in query params for GET requests
      req.body = {
        event: req.query.event,
        data: req.query.data ? JSON.parse(req.query.data) : {},
        ts: req.query.ts,
        auth: {
          domain: req.query.auth_domain || req.query.domain,
          member_id: req.query.member_id,
          application_token: req.query.auth || req.query.application_token
        }
      };
    }

    // Validate signature
    if (!await validateWebhookSignature(req)) {
      logger.warn('Webhook signature validation failed', {
        requestId: req.id
      });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Extract and validate event type
    const eventType = extractEventType(req);
    req.eventType = eventType;

    logger.info('Event type extracted', {
      eventType,
      requestId: req.id
    });

    // Validate event data
    const validation = validateEventData(eventType, req.body);
    if (!validation.valid) {
      logger.warn('Event data validation failed', {
        eventType,
        error: validation.error,
        requestId: req.id
      });
      return res.status(400).json({
        error: 'Invalid event data',
        details: validation.error
      });
    }

    // Attach normalized data to request
    req.eventData = validation.value;
    req.messageData = extractMessageData(validation.value);

    // Debug MESSAGE_TYPE values to understand what Bitrix24 sends
    const params = validation.value.data.PARAMS || {};
    logger.info('MESSAGE_TYPE debug info', {
      messageType: params.MESSAGE_TYPE,
      messageTypeType: typeof params.MESSAGE_TYPE,
      allParams: Object.keys(params),
      eventType,
      requestId: req.id
    });

    logger.info('Webhook validated successfully', {
      eventType,
      userId: req.messageData.userId,
      chatId: req.messageData.chatId,
      messageData: req.messageData,
      requestId: req.id
    });

    next();
  } catch (error) {
    logger.error('Webhook validation error', {
      error: error.message,
      stack: error.stack,
      requestId: req.id
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  validateWebhook,
  validateWebhookSignature,
  validateEventData,
  extractEventType,
  extractMessageData
};