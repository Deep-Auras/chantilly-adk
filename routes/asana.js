const express = require('express');
const router = express.Router();
const { getAsanaService } = require('../services/asanaService');
const { logger } = require('../utils/logger');

/**
 * Asana webhook endpoint
 */
router.post('/webhook/asana', async (req, res) => {
  try {
    const asana = getAsanaService();

    // Handle webhook handshake
    if (req.headers['x-hook-secret']) {
      logger.info('Asana webhook handshake');
      res.setHeader('X-Hook-Secret', req.headers['x-hook-secret']);
      return res.status(200).send();
    }

    // Verify webhook signature
    const signature = req.headers['x-hook-signature'];
    const rawBody = JSON.stringify(req.body);

    if (!asana.verifyWebhookSignature(rawBody, signature)) {
      logger.warn('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Process webhook events
    const events = req.body.events || [];

    for (const event of events) {
      await asana.handleWebhookEvent(event);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Asana webhook error', { error: error.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Create webhook (admin endpoint)
 */
router.post('/asana/webhooks/create', async (req, res) => {
  try {
    const { resourceGid, filters } = req.body;
    const asana = getAsanaService();

    const targetUrl = `${req.protocol}://${req.get('host')}/webhook/asana`;

    const webhook = await asana.createWebhook(resourceGid, targetUrl, filters);

    return res.json({ success: true, webhook });
  } catch (error) {
    logger.error('Failed to create webhook', { error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
