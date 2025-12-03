const { getGeminiModel } = require('../config/gemini');
const { getConfigManager } = require('../services/dashboard/configManager');
const axios = require('axios');

async function checkFirestore() {
  try {
    // Use configManager to verify Firestore connectivity
    const configManager = await getConfigManager();
    await configManager.get('config', 'setupCompleted');
    return { status: 'healthy', latency: 0 };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}

async function checkGeminiAPI() {
  try {
    const model = getGeminiModel();
    await model.generateContent('Test');
    const configManager = await getConfigManager();
    const geminiModel = await configManager.get('config', 'GEMINI_MODEL');
    return { status: 'healthy', model: geminiModel || 'configured' };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}

async function checkBitrix24API() {
  try {
    const configManager = await getConfigManager();
    const bitrix24 = await configManager.getPlatform('bitrix24');

    if (!bitrix24 || !bitrix24.webhookUrl) {
      return {
        status: 'not_configured',
        message: 'Bitrix24 webhook URL not configured'
      };
    }

    await axios.get(
      `${bitrix24.webhookUrl}profile`,
      { timeout: 5000 }
    );
    return {
      status: 'healthy',
      domain: bitrix24.domain || 'configured'
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    };
  }
}

async function getQueueStatus() {
  try {
    const { getQueueManager } = require('../services/bitrix24-queue');
    const queue = getQueueManager();

    return {
      pending: queue?.size || 0,
      processing: queue?.pending || 0,
      cooldown: queue?.isInCooldown() || false,
      failed: queue?.failedCount || 0
    };
  } catch (error) {
    return {
      pending: 0,
      processing: 0,
      cooldown: false,
      failed: 0,
      error: error.message
    };
  }
}

async function healthCheck(req, res) {
  const startTime = Date.now();

  const [firestore, gemini, bitrix24, queue] = await Promise.all([
    checkFirestore(),
    checkGeminiAPI(),
    checkBitrix24API(),
    getQueueStatus()
  ]);

  const allHealthy =
    firestore.status === 'healthy' &&
    gemini.status === 'healthy' &&
    bitrix24.status === 'healthy';

  const health = {
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    responseTime: Date.now() - startTime,
    checks: {
      firestore,
      gemini,
      bitrix24,
      queue
    },
    environment: {
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || 'development'
    }
  };

  res.status(allHealthy ? 200 : 503).json(health);
}

module.exports = healthCheck;