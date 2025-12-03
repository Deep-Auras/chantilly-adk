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
const dashboardRoutes = require('./routes/dashboard');
const setupRoutes = require('./routes/setup');

// ALWAYS load all platform routes (enabled status determined by database, not env vars)
const bitrixWebhook = require('./webhooks/bitrix');
const googleChatRoutes = require('./routes/googleChat');
const asanaRoutes = require('./routes/asana');
const buildRoutes = require('./routes/build');

const app = express();
const PORT = process.env.PORT || 8080;

// Configure Express for Cloud Run proxy (trust exactly 1 proxy for security)
app.set('trust proxy', 1);

// Configure Pug template engine for dashboard
const path = require('path');
app.set('view engine', 'pug');
app.set('views', path.join(__dirname, 'views'));

// Explicit favicon route (before static middleware to ensure it's served)
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/x-icon');
  res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// Serve static assets from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Dashboard middleware (session, flash messages)
// Note: csurf is deprecated, using custom CSRF implementation
const session = require('express-session');
const flash = require('connect-flash');

// CRITICAL: Load session secret from Firestore, not env vars
// Generate and store persistent session secret in Firestore if it doesn't exist
const getSessionSecret = async () => {
  const { getFirestore } = require('./config/firestore');
  const db = getFirestore();
  const configDoc = await db.collection('agent').doc('config').get();

  if (configDoc.exists && configDoc.data().sessionSecret) {
    return configDoc.data().sessionSecret;
  }

  // Generate new persistent secret and store in Firestore
  const newSecret = require('crypto').randomBytes(32).toString('hex');
  await db.collection('agent').doc('config').set({
    sessionSecret: newSecret
  }, { merge: true });

  logger.info('Generated and stored new session secret in Firestore');
  return newSecret;
};

// Session management for dashboard (initialized after services start)
let sessionMiddleware = null;
const initSession = async () => {
  const secret = await getSessionSecret();
  sessionMiddleware = session({
    secret: secret,
    resave: false,
    saveUninitialized: false,
    proxy: true, // Trust proxy headers from Cloud Run
    cookie: {
      secure: false, // CRITICAL: Set to false because Cloud Run doesn't send X-Forwarded-Proto header
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax'
    }
  });
};

// Apply session middleware (will be initialized after Firestore is ready)
app.use((req, res, next) => {
  if (sessionMiddleware) {
    sessionMiddleware(req, res, next);
  } else {
    // Session not ready yet, skip for now (only affects startup)
    next();
  }
});

// Flash messages
app.use(flash());

// Make user and flash messages available to all views
app.use((req, res, next) => {
  res.locals.user = req.user || null;

  // Only use flash if session is initialized
  if (sessionMiddleware && req.flash) {
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
  } else {
    res.locals.success = [];
    res.locals.error = [];
  }

  next();
});

// Security middleware (OWASP compliant)
app.use(securityHeaders);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      styleSrc: ['\'self\'', '\'unsafe-inline\'', 'https://cdn.tailwindcss.com'],
      scriptSrc: ['\'self\'', '\'unsafe-eval\'', '\'unsafe-inline\'', 'https://cdn.tailwindcss.com', 'https://cdn.jsdelivr.net'],
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

// CORS: Dashboard and API are same-origin (same Cloud Run service), so CORS is only
// needed for local development. Allow all origins since webhooks are server-to-server
// and don't use CORS anyway.
app.use(cors({
  origin: true, // Reflect request origin (allows all)
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
    firestoreReady = true; // Signal that Firestore is ready for requests
    logger.info('Firestore initialized');
  } catch (error) {
    logger.error('Failed to initialize Firestore', error);
    hasErrors = true;
  }

  // Initialize session with persistent secret from Firestore
  try {
    await initSession();
    logger.info('Session middleware initialized with persistent secret');
  } catch (error) {
    logger.error('Failed to initialize session middleware', error);
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

  // Load platform configurations from database
  const { getConfigManager } = require('./services/dashboard/configManager');
  const configManager = await getConfigManager();

  // Try Bitrix24 queue manager initialization (check database)
  try {
    const bitrix24Config = await configManager.getPlatform('bitrix24');
    if (bitrix24Config?.enabled) {
      const { initializeQueue } = require('./services/bitrix24-queue');
      await initializeQueue();
      logger.info('Bitrix24 queue manager initialized');
    } else {
      logger.info('Bitrix24 integration disabled in database - skipping queue initialization');
    }
  } catch (error) {
    logger.error('Failed to initialize Bitrix24 queue manager', error);
    hasErrors = true;
  }

  // Try Google Chat service initialization (check database)
  try {
    const googleChatConfig = await configManager.getPlatform('google-chat');
    if (googleChatConfig?.enabled) {
      const { getGoogleChatService } = require('./services/googleChatService');
      const chatService = getGoogleChatService();
      await chatService.initialize();
      logger.info('Google Chat service initialized (enabled in database)');
    } else {
      logger.info('Google Chat integration disabled in database - skipping initialization');
    }
  } catch (error) {
    logger.error('Failed to initialize Google Chat service', error);
    hasErrors = true;
  }

  // Try Asana service initialization (check database)
  try {
    const asanaConfig = await configManager.getPlatform('asana');
    if (asanaConfig?.enabled) {
      const { getAsanaService } = require('./services/asanaService');
      const asanaService = getAsanaService();
      await asanaService.initialize();
      logger.info('Asana service initialized (enabled in database)');
    } else {
      logger.info('Asana integration disabled in database - skipping initialization');
    }
  } catch (error) {
    logger.error('Failed to initialize Asana service', error);
    hasErrors = true;
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

// Readiness check - ensure Firestore is initialized before handling requests
// Must come BEFORE any other middleware that needs database access
let firestoreReady = false;
app.use(async (req, res, next) => {
  // Always allow health checks
  if (req.path === '/health') {
    return next();
  }

  // Wait for Firestore to be ready (with timeout)
  if (!firestoreReady) {
    const maxWaitTime = 30000; // 30 seconds
    const checkInterval = 100; // Check every 100ms
    let waited = 0;

    while (!firestoreReady && waited < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      waited += checkInterval;
    }

    if (!firestoreReady) {
      logger.error('Firestore not ready after timeout', {
        path: req.path,
        waitedMs: waited
      });
      return res.status(503).send('Service Unavailable - Database not ready');
    }
  }

  next();
});

// Setup wizard middleware - redirect to setup if needed
// Must be registered AFTER readiness check
let setupCheckInitialized = false;
app.use(async (req, res, next) => {
  // Skip setup check for certain routes
  const skipPaths = ['/health', '/setup', '/favicon.ico'];
  const shouldSkip = skipPaths.some(path => req.path.startsWith(path)) ||
                     req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico)$/);

  if (shouldSkip) {
    return next();
  }

  // Only check after Firestore is initialized
  if (!setupCheckInitialized) {
    try {
      const { isSetupNeeded } = require('./routes/setup');
      const needsSetup = await isSetupNeeded();

      if (needsSetup && req.path !== '/setup') {
        logger.info('Setup needed - redirecting to setup wizard', {
          requestedPath: req.path
        });
        return res.redirect('/setup');
      }

      setupCheckInitialized = !needsSetup;
    } catch (error) {
      // If we can't check setup status, let the request continue
      // (setup routes will handle errors appropriately)
      logger.warn('Could not check setup status', { error: error.message });
    }
  }

  next();
});

// Routes
app.get('/', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'Chantilly Agent',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint for Cloud Run
app.get('/health', healthCheck);

// Setup wizard routes (must be before auth requirement)
app.use('/setup', setupRoutes);

// Authentication routes
app.use('/auth', authRoutes);

// Dashboard routes (web-based configuration management)
app.use('/dashboard', dashboardRoutes);

// Dashboard API routes (for Alpine.js AJAX calls)
const dashboardApiRouter = express.Router();
const { getFirestore } = require('./config/firestore');
dashboardApiRouter.use(require('./middleware/auth').verifyToken);
dashboardApiRouter.get('/stats', async (req, res) => {
  try {
    const { getKnowledgeBase } = require('./services/knowledgeBase');
    const { getToolRegistry } = require('./lib/toolLoader');
    const db = getFirestore();

    // Get Knowledge Base stats
    const kb = getKnowledgeBase();
    const kbStats = await kb.getStats();

    // Get Tools count (loaded from files, not Firestore)
    const toolRegistry = getToolRegistry();
    const tools = toolRegistry.getAllTools();

    // Get Task Templates count
    const templatesSnapshot = await db.collection('task-templates').get();

    res.json({
      agentStatus: 'Active',
      kbCount: kbStats.totalEntries || 0,
      toolsCount: tools.length || 0,
      templatesCount: templatesSnapshot.size || 0
    });
  } catch (error) {
    logger.error('Failed to fetch dashboard stats', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

dashboardApiRouter.get('/activity', async (req, res) => {
  try {
    const db = getFirestore();
    const limit = parseInt(req.query.limit) || 100;

    const logsSnapshot = await db.collection('audit-logs')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const activities = logsSnapshot.docs.map(doc => {
      const data = doc.data();
      // Format action for display (e.g., "config_update" -> "Config Update")
      const formattedAction = data.action
        ? data.action.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
        : 'Unknown Action';

      // Convert Firestore timestamp to a format the frontend can handle
      let timestamp = null;
      if (data.timestamp) {
        if (data.timestamp.toDate) {
          // Firestore Timestamp object
          timestamp = { seconds: Math.floor(data.timestamp.toDate().getTime() / 1000) };
        } else if (data.timestamp._seconds) {
          // Already serialized Firestore timestamp
          timestamp = { seconds: data.timestamp._seconds };
        } else if (data.timestamp instanceof Date) {
          // JavaScript Date object
          timestamp = { seconds: Math.floor(data.timestamp.getTime() / 1000) };
        } else {
          // Try parsing as string
          const parsed = new Date(data.timestamp);
          if (!isNaN(parsed.getTime())) {
            timestamp = { seconds: Math.floor(parsed.getTime() / 1000) };
          }
        }
      }

      // Format timestamp as string for dashboard overview display
      let timestampStr = 'Unknown';
      if (timestamp && timestamp.seconds) {
        timestampStr = new Date(timestamp.seconds * 1000).toLocaleString();
      }

      return {
        id: doc.id,
        // Legacy field for dashboard overview compatibility
        message: `${formattedAction} by ${data.username || 'System'}`,
        // Full fields for Activity Logs view
        action: data.action,
        username: data.username,
        userId: data.userId,
        timestamp: timestamp,
        timestampStr: timestampStr, // Formatted string for overview display
        entryId: data.entryId,
        toolName: data.toolName,
        section: data.section,
        platformId: data.platformId,
        details: data.details,
        enabled: data.enabled,
        roles: data.roles,
        targetUserId: data.targetUserId
      };
    });

    res.json({ activities });
  } catch (error) {
    logger.error('Failed to fetch recent activity', { error: error.message, userId: req.user?.id });
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

app.use('/api/dashboard', dashboardApiRouter);

// Admin routes (Bitrix user management, role control)
app.use('/admin', adminRoutes);

// Agent management routes
app.use('/agent', agentRoutes);

// Knowledge base routes
app.use('/knowledge', knowledgeRoutes);

// Build mode routes (GitHub integration, code modification)
app.use('/api/build', buildRoutes);
logger.info('Build mode routes registered at /api/build');

// Worker routes for Cloud Tasks background processing
app.use('/worker', workerRoutes);

// Platform-specific routes (ALWAYS registered - handlers check database for enabled status)
app.use('/', googleChatRoutes);
logger.info('Google Chat routes registered at /webhook/google-chat');

app.use('/', asanaRoutes);
logger.info('Asana routes registered');

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
logger.info('Bitrix24 routes registered at /webhook/bitrix24');

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler with better null/undefined handling
app.use((err, req, res, _next) => {
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

    // 1. Cleanup Bitrix24 webhook cache
    try {
      const webhookCleanup = require('./webhooks/bitrix').cleanup;
      if (webhookCleanup) {
        webhookCleanup();
        logger.info('Bitrix24 webhook cache cleanup completed');
      }
    } catch (error) {
      logger.error('Bitrix24 webhook cleanup failed', { error: error.message });
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

    // 4. Cleanup Google Chat service if initialized (PHASE 16.3: deduplication cleanup)
    try {
      const { getGoogleChatService } = require('./services/googleChatService');
      const chatService = getGoogleChatService();
      if (chatService && chatService.destroy) {
        chatService.destroy();
        logger.info('Google Chat service cleanup completed');
      }
    } catch (error) {
      // Google Chat service might not be initialized, that's okay
      logger.debug('Google Chat service cleanup skipped', { reason: error.message });
    }

    // 5. Cleanup Asana service if initialized (polling intervals)
    try {
      const { getAsanaService } = require('./services/asanaService');
      const asanaService = getAsanaService();
      if (asanaService && asanaService.cleanup) {
        await asanaService.cleanup();
        logger.info('Asana service cleanup completed');
      }
    } catch (error) {
      // Asana service might not be initialized, that's okay
      logger.debug('Asana service cleanup skipped', { reason: error.message });
    }

    // 6. Cleanup Chat service SSE connections (prevent memory leaks)
    try {
      const { ChatService } = require('./services/chatService');
      ChatService.cleanup();
      logger.info('Chat service SSE connections cleaned up');
    } catch (error) {
      // Chat service might not be initialized, that's okay
      logger.debug('Chat service cleanup skipped', { reason: error.message });
    }

    // 5. Cleanup 3CX services if initialized
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