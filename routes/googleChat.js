const express = require('express');
const router = express.Router();
const { getGoogleChatService } = require('../services/googleChatService');
const { logger } = require('../utils/logger');

/**
 * Google Chat webhook endpoint
 */
router.post('/webhook/google-chat', async (req, res) => {
  try {
    const event = req.body;
    const chatService = getGoogleChatService();

    // Google Workspace Add-on format: event.chat.messagePayload
    // Simple Chat app format: event.type, event.message, event.space
    const isAddOnFormat = event.chat && event.chat.messagePayload;

    let eventType = 'UNKNOWN';
    let transformedEvent = event;

    if (isAddOnFormat) {
      logger.info('Add-on format detected, transforming event');
      // Transform Workspace Add-on format to simple format
      const messagePayload = event.chat.messagePayload;

      if (messagePayload.message) {
        eventType = 'MESSAGE';
        transformedEvent = {
          type: 'MESSAGE',
          message: messagePayload.message,
          space: messagePayload.space,
          user: event.chat.user,
          eventTime: event.chat.eventTime
        };
      } else if (messagePayload.space && !messagePayload.message) {
        eventType = 'ADDED_TO_SPACE';
        transformedEvent = {
          type: 'ADDED_TO_SPACE',
          space: messagePayload.space,
          user: event.chat.user,
          eventTime: event.chat.eventTime
        };
      }
    } else {
      // Simple Chat app format
      eventType = event.type || 'UNKNOWN';
      if (event.message) eventType = 'MESSAGE';
    }

    switch (eventType) {
      case 'MESSAGE':
        if (transformedEvent.message.slashCommand) {
          const response = await chatService.handleSlashCommand(transformedEvent);
          return res.json(response);
        } else {
          // PHASE 16: Detect task feedback patterns and route to feedback handler
          const messageText = transformedEvent.message.text?.toLowerCase() || '';
          const hasTaskReference = messageText.includes('task');
          const hasFeedbackKeywords = /change|update|fix|add|didn't|missing|wrong|incorrect|modify|remove|needs?|should|require/i.test(messageText);

          if (hasTaskReference && hasFeedbackKeywords) {
            const response = await chatService.handleTaskFeedback(transformedEvent);
            return res.json(response);
          }

          // Default message handling
          const response = await chatService.handleMessage(transformedEvent);
          return res.json(response);
        }

      case 'ADDED_TO_SPACE':
        await chatService.handleSpaceJoin(transformedEvent);
        return res.json({
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: {
                message: {
                  text: "👋 Hi! I'm Morgan, your AI project assistant. How can I help you today?"
                }
              }
            }
          }
        });

      case 'REMOVED_FROM_SPACE':
        await chatService.handleSpaceLeave(transformedEvent);
        return res.json({});

      case 'CARD_CLICKED':
        const response = await chatService.handleCardClick(transformedEvent);
        return res.json(response);

      default:
        logger.info('Unhandled Google Chat event', { eventType, eventKeys: Object.keys(event) });
        return res.json({});
    }
  } catch (error) {
    logger.error('Google Chat webhook error', { error: error.message, stack: error.stack });
    return res.status(500).json({
      text: '❌ Internal error occurred'
    });
  }
});

module.exports = router;
