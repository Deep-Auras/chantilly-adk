const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { logger } = require('./utils/logger');
const {
  securityHeaders,
  resourceLimiter,
  requestSizeLimit,
  auditLogger,
  apiVersioning,
  outputValidation
} = require('./middleware/security');
const { initializeFirestore } = require('./config/firestore');
const healthCheck = require('./utils/healthCheck');
const agentRoutes = require('./routes/agent');
const authRoutes = require('./routes/auth');
const knowledgeRoutes = require('./routes/knowledge');
const workerRoutes = require('./routes/worker');
const adminRoutes = require('./routes/admin');

// Conditional platform integrations
const ENABLE_BITRIX24 = process.env.ENABLE_BITRIX24_INTEGRATION === 'true';
const ENABLE_GOOGLE_CHAT = process.env.ENABLE_GOOGLE_CHAT_INTEGRATION === 'true';
const ENABLE_ASANA = process.env.ENABLE_ASANA_INTEGRATION === 'true';

// Load platform-specific routes conditionally
const bitrixWebhook = ENABLE_BITRIX24 ? require('./webhooks/bitrix') : null;
const googleChatRoutes = ENABLE_GOOGLE_CHAT ? require('./routes/googleChat') : null;
const asanaRoutes = ENABLE_ASANA ? require('./routes/asana') : null;

const app = express();
const PORT = process.env.PORT || 8080;

// Configure Express for Cloud Run proxy (trust exactly 1 proxy for security)
app.set('trust proxy', 1);

// Security middleware (OWASP compliant)
app.use(securityHeaders);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      styleSrc: ['\'self\'', '\'unsafe-inline\''],
      scriptSrc: ['\'self\''],
      imgSrc: ['\'self\'', 'data:', 'https:']
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));
app.use(compression());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || false,
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Rate limiting
app.use(resourceLimiter);

// Request size limiting
app.use(requestSizeLimit('10mb'));

// Body parsing with security
app.use(bodyParser.json({
  limit: '10mb',
  type: ['application/json'],
  verify: (req, res, buf) => {
    // Prevent JSON bomb attacks
    if (buf.length > 10 * 1024 * 1024) { // 10MB
      throw new Error('Request too large');
    }
  }
}));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// API inventory and audit logging
app.use(apiVersioning);
app.use(auditLogger);
app.use(outputValidation);

// Request ID for tracing and log ALL incoming requests
app.use((req, res, next) => {
  // SECURITY: Add error handling for UUID generation with timestamp fallback
  try {
    req.id = req.headers['x-cloud-trace-context'] || require('uuid').v4();
  } catch (error) {
    // Fallback to timestamp-based ID if UUID generation fails
    req.id = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    logger.warn('UUID generation failed, using timestamp-based ID', {
      error: error.message,
      fallbackId: req.id
    });
  }

  // Log webhook requests with full details
  if (req.path.includes('webhook') || req.method === 'GET') {
    logger.info('INCOMING REQUEST', {
      method: req.method,
      fullUrl: req.originalUrl,
      path: req.path,
      query: req.query,
      headers: req.headers,
      body: req.body,
      requestId: req.id,
      userAgent: req.headers['user-agent']
    });
  } else {
    logger.info(`${req.method} ${req.path}`, { requestId: req.id });
  }

  next();
});

// Initialize services
async function initializeServices() {
  let hasErrors = false;

  // Try Firestore initialization
  try {
    await initializeFirestore();
    logger.info('Firestore initialized');
  } catch (error) {
    logger.error('Failed to initialize Firestore', error);
    hasErrors = true;
  }

  // Try authentication service initialization
  try {
    const { initializeAuthService } = require('./services/auth');
    await initializeAuthService();
    logger.info('Authentication service initialized');
  } catch (error) {
    logger.error('Failed to initialize authentication service', error);
    hasErrors = true;
  }

  // Try user role service initialization (for RBAC)
  try {
    const { initializeUserRoleService } = require('./services/userRoleService');
    await initializeUserRoleService();
    logger.info('User role service initialized (RBAC)');
  } catch (error) {
    logger.error('Failed to initialize user role service', error);
    hasErrors = true;
  }

  // Try personality service initialization
  try {
    const { initializePersonalityService } = require('./services/agentPersonality');
    const { initializeKnowledgeBase } = require('./services/knowledgeBase');
    await initializePersonalityService();
    await initializeKnowledgeBase();
    logger.info('Agent personality initialized');
  } catch (error) {
    logger.error('Failed to initialize personality service', error);
    hasErrors = true;
  }

  // Try Gemini service initialization
  try {
    const { initializeGeminiService } = require('./services/gemini');
    await initializeGeminiService();
    logger.info('Gemini service initialized');
  } catch (error) {
    logger.error('Failed to initialize Gemini service', error);
    hasErrors = true;
  }

  // Try custom tools loading - this is critical for the current issue
  try {
    const { loadTools } = require('./lib/toolLoader');
    await loadTools();
    logger.info('Custom tools loaded');
  } catch (error) {
    logger.error('Failed to load custom tools', error);
    hasErrors = true;
  }

  // Try Bitrix24 queue manager initialization (conditional)
  if (ENABLE_BITRIX24) {
    try {
      const { initializeQueue } = require('./services/bitrix24-queue');
      await initializeQueue();
      logger.info('Bitrix24 queue manager initialized');
    } catch (error) {
      logger.error('Failed to initialize Bitrix24 queue manager', error);
      hasErrors = true;
    }
  } else {
    logger.info('Bitrix24 integration disabled - skipping queue initialization');
  }

  // Try Google Chat service initialization (conditional)
  if (ENABLE_GOOGLE_CHAT) {
    try {
      const { getGoogleChatService } = require('./services/googleChatService');
      const chatService = getGoogleChatService();
      await chatService.initialize();
      logger.info('Google Chat service initialized');
    } catch (error) {
      logger.error('Failed to initialize Google Chat service', error);
      hasErrors = true;
    }
  } else {
    logger.info('Google Chat integration disabled - skipping initialization');
  }

  // Try Asana service initialization (conditional)
  if (ENABLE_ASANA) {
    try {
      const { getAsanaService } = require('./services/asanaService');
      const asanaService = getAsanaService();
      await asanaService.initialize();
      logger.info('Asana service initialized');
    } catch (error) {
      logger.error('Failed to initialize Asana service', error);
      hasErrors = true;
    }
  } else {
    logger.info('Asana integration disabled - skipping initialization');
  }

  // Try 3CX authentication service initialization (optional)
  try {
    const { initializeThreeCXAuthService } = require('./services/threecx-auth');
    await initializeThreeCXAuthService();
    logger.info('3CX authentication service initialized');
  } catch (error) {
    // 3CX is optional - log but don't fail startup
    logger.warn('3CX authentication service not initialized (credentials may not be configured)', {
      error: error.message
    });
  }

  // Try 3CX queue manager initialization (optional, depends on auth)
  try {
    const { initializeThreeCXQueue } = require('./services/threecx-queue');
    await initializeThreeCXQueue();
    logger.info('3CX queue manager initialized');
  } catch (error) {
    // 3CX is optional - log but don't fail startup
    logger.warn('3CX queue manager not initialized (credentials may not be configured)', {
      error: error.message
    });
  }

  return !hasErrors;
}

// Routes
app.get('/', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Chantilly Agent',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint for Cloud Run
app.get('/health', healthCheck);

// Authentication routes
app.use('/auth', authRoutes);

// Admin routes (Bitrix user management, role control)
app.use('/admin', adminRoutes);

// Agent management routes
app.use('/agent', agentRoutes);

// Knowledge base routes
app.use('/knowledge', knowledgeRoutes);

// Worker routes for Cloud Tasks background processing
app.use('/worker', workerRoutes);

// Platform-specific routes (conditional)
if (ENABLE_GOOGLE_CHAT && googleChatRoutes) {
  app.use('/', googleChatRoutes);
  logger.info('Google Chat routes registered');
}

if (ENABLE_ASANA && asanaRoutes) {
  app.use('/', asanaRoutes);
  logger.info('Asana routes registered');
}

if (ENABLE_BITRIX24 && bitrixWebhook) {
  // Bitrix24 webhook endpoint with rate limiting
  const webhookLimiter = require('express-rate-limit')({
    windowMs: 60 * 1000,
    max: 100,
    keyGenerator: (req) => {
      const ip = req.ip || req.connection.remoteAddress || 'unknown';
      const signature = req.headers['x-bitrix24-signature'] || '';
      return `webhook-${ip}-${signature.substring(0, 10)}`;
    }
  });

  app.all('/webhook/bitrix24', webhookLimiter, bitrixWebhook);
  logger.info('Bitrix24 routes registered');
}

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler with better null/undefined handling
app.use((err, req, res, next) => {
  // Handle null/undefined errors gracefully
  const errorMessage = err?.message || 'Unknown error occurred';
  const errorStack = err?.stack || 'No stack trace available';
  const statusCode = err?.status || err?.statusCode || 500;

  // Don't expose internal errors in production
  const isProduction = process.env.NODE_ENV === 'production';

  logger.error('Unhandled error', {
    error: errorMessage,
    stack: errorStack,
    requestId: req.id,
    url: req.url,
    method: req.method
  });

  // Return appropriate error based on environment and error type
  if (statusCode === 400) {
    return res.status(400).json({
      success: false,
      error: 'Bad Request',
      message: isProduction ? 'Invalid request data' : errorMessage,
      requestId: req.id
    });
  }

  if (statusCode === 401) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      requestId: req.id
    });
  }

  if (statusCode === 403) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      requestId: req.id
    });
  }

  // Default 500 error
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: isProduction ? 'Something went wrong' : errorMessage,
    requestId: req.id
  });
});

// Graceful shutdown for Cloud Run
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown');

  try {
    // SECURITY FIX: Clear all intervals and cleanup resources

    // 1. Cleanup Bitrix24 webhook cache (if enabled)
    if (ENABLE_BITRIX24) {
      try {
        const webhookCleanup = require('./webhooks/bitrix').cleanup;
        if (webhookCleanup) {
          webhookCleanup();
          logger.info('Bitrix24 webhook cache cleanup completed');
        }
      } catch (error) {
        logger.error('Bitrix24 webhook cleanup failed', { error: error.message });
      }
    }

    // 2. Cleanup GeminiService intervals
    try {
      const { getGeminiService } = require('./services/gemini');
      const geminiService = getGeminiService();
      if (geminiService && geminiService.destroy) {
        geminiService.destroy();
        logger.info('GeminiService cleanup completed');
      }
    } catch (error) {
      // Service might not be initialized yet, that's okay
      logger.debug('GeminiService cleanup skipped', { reason: error.message });
    }

    // 2. Cleanup tool registry
    try {
      const { getToolLoader } = require('./lib/toolLoader');
      const toolLoader = getToolLoader();
      if (toolLoader && toolLoader.registry) {
        await toolLoader.registry.clear();
        logger.info('Tool registry cleanup completed');
      }
    } catch (error) {
      logger.error('Tool registry cleanup failed', { error: error.message });
    }

    // 3. Shutdown TaskOrchestrator if initialized
    try {
      const { getTaskOrchestrator } = require('./services/taskOrchestrator');
      const orchestrator = getTaskOrchestrator();
      if (orchestrator) {
        await orchestrator.shutdown();
        logger.info('TaskOrchestrator shutdown completed');
      }
    } catch (error) {
      logger.error('TaskOrchestrator shutdown failed', { error: error.message });
    }

    // 4. Cleanup 3CX services if initialized
    try {
      const { getThreeCXQueueManager } = require('./services/threecx-queue');
      const threeCXQueue = getThreeCXQueueManager();
      if (threeCXQueue && threeCXQueue.clear) {
        await threeCXQueue.clear();
        logger.info('3CX queue cleanup completed');
      }
    } catch (error) {
      // 3CX services might not be initialized, that's okay
      logger.debug('3CX queue cleanup skipped', { reason: error.message });
    }

    // 5. Close HTTP server
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
    process.exit(1);
  }

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});

// Start server
let server;

// Start server immediately for health checks, initialize services in background
server = app.listen(PORT, () => {
  logger.info(`Server starting on port ${PORT}`);
});

// Initialize services in background
initializeServices().then((success) => {
  if (success) {
    logger.info('All services initialized successfully');
  } else {
    logger.error('Some services failed to initialize, but server is running');
    // Don't exit - let health checks handle service readiness
  }
}).catch((error) => {
  logger.error('Service initialization error', error);
  // Don't exit - let health checks handle service readiness
});