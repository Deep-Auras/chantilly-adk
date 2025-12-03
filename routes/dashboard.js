/**
 * Dashboard Routes
 *
 * Web-based configuration and management interface for Chantilly Agent.
 * Provides CRUD operations for configuration, knowledge base, tools, and users.
 *
 * Security:
 * - JWT authentication required for all routes
 * - CSRF protection on all POST/PUT/DELETE operations
 * - RBAC enforcement (admin-only routes)
 * - Input validation on all mutations
 * - Audit logging for security events
 *
 * @module routes/dashboard
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const { logger } = require('../utils/logger');
const { getConfigManager } = require('../services/dashboard/configManager');
const { getFirestore } = require('../config/firestore');

// CSRF token generation middleware
router.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// CSRF validation middleware (for POST/PUT/DELETE/PATCH)
const validateCSRF = (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const token = req.body._csrf || req.headers['x-csrf-token'];
    if (!token || token !== req.session.csrfToken) {
      logger.warn('CSRF validation failed', {
        method: req.method,
        path: req.path,
        userId: req.user?.id
      });
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }
  next();
};


// Apply authentication to all dashboard routes
router.use(verifyToken);
router.use(validateCSRF);

// Make user and dynamic agent name available to all views
router.use(async (req, res, next) => {
  // Skip user/agentName loading for API routes - not needed
  if (req.path.startsWith('/api/')) {
    return next();
  }

  // Load full user data from Firestore to get profilePicture
  if (req.user && req.user.id) {
    try {
      const db = getFirestore();
      const userDoc = await db.collection('users').doc(req.user.id).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        res.locals.user = {
          ...req.user,
          profilePicture: userData.profilePicture || null
        };
      } else {
        res.locals.user = req.user;
      }
    } catch (error) {
      logger.warn('Failed to load user profile picture', {
        error: error.message,
        userId: req.user.id
      });
      res.locals.user = req.user;
    }
  } else {
    res.locals.user = req.user;
  }

  // Load agent name from database config (NO ENV VAR FALLBACK)
  try {
    const configManager = await getConfigManager();
    const config = await configManager.get('config');
    res.locals.agentName = config?.AGENT_NAME || 'Clementine';
  } catch (error) {
    // Fallback to default if config loading fails
    res.locals.agentName = 'Clementine';
    logger.warn('Failed to load agent name from Firestore config', { error: error.message });
  }

  // Check if Build Mode is enabled globally (for sidebar styling)
  // Lazy require to avoid loading GitHub service chain on startup
  try {
    const { getBuildModeManager } = require('../services/build/buildModeManager');
    const buildModeManager = getBuildModeManager();
    const buildModeEnabled = await buildModeManager.isBuildModeEnabled();
    res.locals.buildModeEnabled = buildModeEnabled;
  } catch (error) {
    // Build mode not available or error checking
    res.locals.buildModeEnabled = false;
  }

  next();
});

// Admin-only middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    logger.warn('Unauthorized admin access attempt', {
      userId: req.user.id,
      username: req.user.username,
      path: req.path
    });
    req.flash('error', 'Admin access required');
    return res.redirect('/dashboard');
  }
  next();
};

/**
 * Dashboard Overview
 * GET /dashboard
 */
router.get('/', async (req, res) => {
  try {
    res.locals.currentPage = 'overview';
    res.locals.title = 'Dashboard Overview';

    res.render('dashboard/index');
  } catch (error) {
    logger.error('Dashboard overview error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load dashboard');
    res.redirect('/');
  }
});

/**
 * Configuration Dashboard
 * GET /dashboard/config
 */
router.get('/config', requireAdmin, async (req, res) => {
  try {
    const configManager = await getConfigManager();

    // Load configuration sections
    const config = await configManager.get('config');
    const featureFlags = await configManager.get('feature-flags');
    const rateLimits = await configManager.get('rate-limits');

    res.locals.currentPage = 'config';
    res.locals.title = 'Agent Configuration';

    res.render('dashboard/config', {
      config: config || {},
      featureFlags: featureFlags || {},
      rateLimits: rateLimits || {}
    });
  } catch (error) {
    logger.error('Configuration dashboard error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load configuration');
    res.redirect('/dashboard');
  }
});

/**
 * Update Configuration
 * POST /dashboard/config/update
 */
router.post('/config/update', requireAdmin, async (req, res) => {
  try {
    const { section, updates } = req.body;

    if (!section || !updates) {
      return res.status(400).json({ error: 'Invalid configuration update' });
    }

    // Validate section name (whitelist)
    const validSections = ['config', 'feature-flags', 'rate-limits', 'rbac'];
    if (!validSections.includes(section)) {
      return res.status(400).json({ error: 'Invalid configuration section' });
    }

    const configManager = await getConfigManager();
    await configManager.update(section, updates, req.user.id);

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'config_update',
      section,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date(),
      details: { keys: Object.keys(updates) }
    });

    logger.info('Configuration updated', {
      section,
      userId: req.user.id,
      keys: Object.keys(updates)
    });

    res.json({ success: true, message: 'Configuration updated successfully' });
  } catch (error) {
    logger.error('Configuration update failed', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

/**
 * Platforms Dashboard
 * GET /dashboard/platforms
 */
router.get('/platforms', requireAdmin, async (req, res) => {
  try {
    const configManager = await getConfigManager();

    // Load platform configurations
    const bitrix24Config = await configManager.getPlatform('bitrix24');
    const googleChatConfig = await configManager.getPlatform('google-chat');
    const asanaConfig = await configManager.getPlatform('asana');
    const blueskyConfig = await configManager.getPlatform('bluesky');
    const githubConfig = await configManager.getPlatform('github');

    // Check if encrypted credentials exist (for showing masked placeholders)
    const credentialsDoc = await getFirestore().collection('agent').doc('credentials').get();
    const credentials = credentialsDoc.exists ? credentialsDoc.data() : {};

    res.locals.currentPage = 'platforms';
    res.locals.title = 'Platform Integrations';

    res.render('dashboard/platforms', {
      bitrix24: bitrix24Config || {},
      googleChat: googleChatConfig || {},
      asana: asanaConfig || {},
      bluesky: blueskyConfig || {},
      github: githubConfig || {},
      // Credential existence flags for masked placeholders
      hasAsanaAccessToken: !!credentials.asana_access_token,
      hasAsanaWebhookSecret: !!credentials.asana_webhook_secret,
      hasBlueskyAppPassword: !!credentials.bluesky_app_password,
      hasBitrix24WebhookUrl: !!credentials.bitrix24_webhook_url,
      hasGithubAccessToken: !!credentials.github_access_token,
      hasGithubPrivateKey: !!credentials.github_private_key
    });
  } catch (error) {
    logger.error('Platforms dashboard error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load platform configurations');
    res.redirect('/dashboard');
  }
});

/**
 * Knowledge Base Dashboard
 * GET /dashboard/knowledge
 */
router.get('/knowledge', async (req, res) => {
  try {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const kb = getKnowledgeBase();

    // Get all knowledge entries (not just enabled)
    const rawEntries = await kb.getAllKnowledge({ enabled: null });

    // Ensure all entries have required fields with defaults
    // CRITICAL: Convert Firestore timestamps to strings for JSON serialization
    // CRITICAL: Truncate content for client-side (only needed for search, not display)
    const entries = rawEntries.map(entry => ({
      id: entry.id,
      title: entry.title || 'Untitled',
      content: (entry.content || '').substring(0, 500), // Truncate to 500 chars for search
      category: entry.category || 'general',
      priority: entry.priority || 0,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      enabled: entry.enabled !== false,
      lastUpdated: entry.lastUpdated?.toDate ? entry.lastUpdated.toDate().toISOString() :
                   entry.lastUpdated instanceof Date ? entry.lastUpdated.toISOString() :
                   entry.lastUpdated || new Date().toISOString()
    }));

    const categories = await kb.getCategories();

    res.locals.currentPage = 'knowledge';
    res.locals.title = 'Knowledge Base';

    res.render('dashboard/knowledge', {
      entries,
      categories
    });
  } catch (error) {
    logger.error('Knowledge Base dashboard error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load knowledge base');
    res.redirect('/dashboard');
  }
});

/**
 * Knowledge Base Add Page
 * GET /dashboard/knowledge/add
 */
router.get('/knowledge/add', requireAdmin, async (req, res) => {
  try {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const kb = getKnowledgeBase();

    // Get categories for dropdown
    const categories = await kb.getCategories();

    res.locals.currentPage = 'knowledge';
    res.locals.title = 'Add Knowledge Entry';

    res.render('dashboard/knowledge-add', {
      categories
    });
  } catch (error) {
    logger.error('Knowledge Base add page error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load add page');
    res.redirect('/dashboard/knowledge');
  }
});

/**
 * Knowledge Base Edit Page
 * GET /dashboard/knowledge/edit/:id
 */
router.get('/knowledge/edit/:id', requireAdmin, async (req, res) => {
  try {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const kb = getKnowledgeBase();

    // Get the specific entry
    const entry = await kb.getKnowledge(req.params.id);

    if (!entry) {
      req.flash('error', 'Knowledge entry not found');
      return res.redirect('/dashboard/knowledge');
    }

    // Get categories for dropdown
    const categories = await kb.getCategories();

    res.locals.currentPage = 'knowledge';
    res.locals.title = 'Edit Knowledge Entry';

    res.render('dashboard/knowledge-edit', {
      entry: {
        id: entry.id,
        title: entry.title || '',
        content: entry.content || '',
        category: entry.category || 'general',
        priority: entry.priority || 0,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        enabled: entry.enabled !== false
      },
      categories
    });
  } catch (error) {
    logger.error('Knowledge Base edit page error', {
      error: error.message,
      userId: req.user.id,
      entryId: req.params.id
    });
    req.flash('error', 'Failed to load knowledge entry');
    res.redirect('/dashboard/knowledge');
  }
});

/**
 * Tools Dashboard
 * GET /dashboard/tools
 */
router.get('/tools', async (req, res) => {
  try {
    const configManager = await getConfigManager();
    const config = await configManager.get('config');
    const { getToolRegistry } = require('../lib/toolLoader');
    const { TOOL_ACCESS_CONTROL } = require('../config/toolAccessControl');
    const toolRegistry = getToolRegistry();

    const tools = toolRegistry.getAllTools();

    res.locals.currentPage = 'tools';
    res.locals.title = 'Custom Tools';

    res.render('dashboard/tools', {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        category: tool.category || 'general',
        enabled: tool.enabled !== undefined ? tool.enabled : true,
        priority: tool.priority || 0
      })),
      toolAccess: TOOL_ACCESS_CONTROL
    });
  } catch (error) {
    logger.error('Tools dashboard error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load tools');
    res.redirect('/dashboard');
  }
});

/**
 * Build Mode Dashboard
 * GET /dashboard/build
 */
router.get('/build', async (req, res) => {
  try {
    res.locals.currentPage = 'build';
    res.locals.title = 'Build Mode';

    res.render('dashboard/build');
  } catch (error) {
    logger.error('Build dashboard error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load build mode dashboard');
    res.redirect('/dashboard');
  }
});

/**
 * Tasks Dashboard
 * GET /dashboard/tasks
 */
router.get('/tasks', async (req, res) => {
  try {
    const configManager = await getConfigManager();
    const config = await configManager.get('config');
    const db = getFirestore();

    // Get task templates
    const templatesSnapshot = await db.collection('task-templates').get();
    const templates = templatesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.locals.currentPage = 'tasks';
    res.locals.title = 'Complex Tasks';

    res.render('dashboard/tasks', {
      templates
    });
  } catch (error) {
    logger.error('Tasks dashboard error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load tasks');
    res.redirect('/dashboard');
  }
});

/**
 * Users Dashboard (Admin Only)
 * GET /dashboard/users
 */
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const configManager = await getConfigManager();
    const config = await configManager.get('config');
    const db = getFirestore();

    // Get all users
    const usersSnapshot = await db.collection('users').get();
    const users = usersSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        username: data.username,
        email: data.email || '',
        role: data.role,
        createdAt: data.createdAt,
        lastLogin: data.lastLogin,
        loginAttempts: data.loginAttempts || 0,
        locked: data.locked || false,
        profilePicture: data.profilePicture || null
      };
    });

    res.locals.currentPage = 'users';
    res.locals.title = 'User Management';

    res.render('dashboard/users', {
      users
    });
  } catch (error) {
    logger.error('Users dashboard error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load users');
    res.redirect('/dashboard');
  }
});

/**
 * Activity Logs Dashboard (Stub - Admin Only)
 * GET /dashboard/activity
 */
router.get('/activity', requireAdmin, async (req, res) => {
  res.locals.currentPage = 'activity';
  res.locals.title = 'Activity Logs';
  res.render('dashboard/activity');
});

/**
 * Knowledge Base API Routes
 */

// Delete knowledge entry
router.delete('/api/knowledge/:id', requireAdmin, async (req, res) => {
  try {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const kb = getKnowledgeBase();
    await kb.deleteKnowledge(req.params.id);

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'knowledge_delete',
      entryId: req.params.id,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('Knowledge entry deleted', {
      entryId: req.params.id,
      userId: req.user.id
    });

    res.json({ success: true, message: 'Entry deleted successfully' });
  } catch (error) {
    logger.error('Failed to delete knowledge entry', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// Update knowledge entry
router.put('/api/knowledge/:id', requireAdmin, async (req, res) => {
  try {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const kb = getKnowledgeBase();
    await kb.updateKnowledge(req.params.id, req.body);

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'knowledge_update',
      entryId: req.params.id,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date(),
      details: { keys: Object.keys(req.body) }
    });

    logger.info('Knowledge entry updated', {
      entryId: req.params.id,
      userId: req.user.id
    });

    res.json({ success: true, message: 'Entry updated successfully' });
  } catch (error) {
    logger.error('Failed to update knowledge entry', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// Add knowledge entry
router.post('/api/knowledge', requireAdmin, async (req, res) => {
  try {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const kb = getKnowledgeBase();
    const id = await kb.addKnowledge(req.body);

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'knowledge_add',
      entryId: id,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('Knowledge entry added', {
      entryId: id,
      userId: req.user.id
    });

    res.status(201).json({ success: true, id, message: 'Entry added successfully' });
  } catch (error) {
    logger.error('Failed to add knowledge entry', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to add entry' });
  }
});

/**
 * Tool Management API Routes
 */

// Toggle tool enabled/disabled state
router.post('/api/tools/:toolName/toggle', requireAdmin, async (req, res) => {
  try {
    const { toolName } = req.params;
    const { enabled } = req.body;

    // Validate input
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const { getToolRegistry } = require('../lib/toolLoader');
    const toolRegistry = getToolRegistry();
    const tool = toolRegistry.getTool(toolName);

    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }

    // Update tool state
    tool.setEnabled(enabled);

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'tool_toggle',
      toolName,
      enabled,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('Tool state toggled', {
      toolName,
      enabled,
      userId: req.user.id
    });

    res.json({ success: true, enabled });
  } catch (error) {
    logger.error('Failed to toggle tool', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to toggle tool' });
  }
});

// Update tool access permissions
router.post('/api/tools/:toolName/access', requireAdmin, async (req, res) => {
  try {
    const { toolName } = req.params;
    const { roles } = req.body;

    // Validate input
    if (!Array.isArray(roles)) {
      return res.status(400).json({ error: 'roles must be an array' });
    }

    // Validate roles
    const validRoles = ['user', 'admin'];
    const invalidRoles = roles.filter(r => !validRoles.includes(r));
    if (invalidRoles.length > 0) {
      return res.status(400).json({ error: `Invalid roles: ${invalidRoles.join(', ')}` });
    }

    // IMPORTANT: This updates in-memory config only
    // For persistence, we'd need to write to a config file or Firestore
    // For now, changes persist until server restart
    const { TOOL_ACCESS_CONTROL } = require('../config/toolAccessControl');
    TOOL_ACCESS_CONTROL[toolName] = roles;

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'tool_access_update',
      toolName,
      roles,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('Tool access updated', {
      toolName,
      roles,
      userId: req.user.id
    });

    res.json({ success: true, roles });
  } catch (error) {
    logger.error('Failed to update tool access', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to update tool access' });
  }
});

/**
 * Dashboard Statistics API
 * GET /api/dashboard/stats
 */
router.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { getKnowledgeBase } = require('../services/knowledgeBase');
    const { getToolRegistry } = require('../lib/toolLoader');
    const db = getFirestore();

    // Get Knowledge Base stats
    const kb = getKnowledgeBase();
    const kbStats = await kb.getStats();

    // Get Tools count
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
    logger.error('Dashboard stats API error', {
      error: error.message,
      userId: req.user?.id
    });
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

/**
 * Dashboard Activity API
 * GET /api/dashboard/activity
 */
router.get('/api/dashboard/activity', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const limit = parseInt(req.query.limit) || 100;

    // Get recent audit logs
    const logsSnapshot = await db.collection('audit-logs')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    logger.info('Activity logs query returned', {
      count: logsSnapshot.docs.length,
      userId: req.user.id
    });

    const activities = logsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        action: data.action,
        username: data.username,
        userId: data.userId,
        timestamp: data.timestamp,
        // Include all detail fields
        entryId: data.entryId,
        toolName: data.toolName,
        section: data.section,
        platformId: data.platformId,
        details: data.details,
        enabled: data.enabled,
        roles: data.roles
      };
    });

    res.json({ activities });
  } catch (error) {
    logger.error('Dashboard activity API error', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id
    });
    // Return error status instead of empty array to help debugging
    res.status(500).json({
      activities: [],
      error: 'Failed to load activity logs'
    });
  }
});

/**
 * Update Platform Configuration
 * POST /dashboard/platforms/:platformId
 */
router.post('/platforms/:platformId', requireAdmin, async (req, res) => {
  try {
    const { platformId } = req.params;
    const updates = req.body;

    // Validate platform ID (whitelist)
    const validPlatforms = ['bitrix24', 'google-chat', 'asana', 'bluesky', 'github'];
    if (!validPlatforms.includes(platformId)) {
      return res.status(400).json({ error: 'Invalid platform ID' });
    }

    // Validate required fields based on platform
    if (platformId === 'bitrix24' && updates.enabled) {
      if (!updates.domain || !updates.webhookUrl) {
        return res.status(400).json({ error: 'Domain and webhook URL required for Bitrix24' });
      }
    }

    // Google Chat uses ADC (Application Default Credentials) - no validation needed
    // Project ID comes from Core Configuration (stored in Firestore config collection)

    if (platformId === 'asana' && updates.enabled) {
      if (!updates.accessToken || !updates.workspaceGid) {
        return res.status(400).json({ error: 'Access token and workspace GID required for Asana' });
      }
      // Bot email and webhook secret are optional but recommended
    }

    if (platformId === 'bluesky' && updates.enabled) {
      if (!updates.handle || !updates.appPassword) {
        return res.status(400).json({ error: 'Handle and app password required for Bluesky' });
      }
    }

    // GitHub requires either Personal Access Token OR GitHub App credentials
    if (platformId === 'github' && updates.enabled) {
      if (!updates.defaultOwner || !updates.defaultRepo) {
        return res.status(400).json({ error: 'Repository owner and name required for GitHub' });
      }
      const authType = updates.authType || 'personal-token';
      if (authType === 'personal-token') {
        if (!updates.accessToken) {
          return res.status(400).json({ error: 'Access token required for GitHub Personal Access Token authentication' });
        }
      } else if (authType === 'github-app') {
        if (!updates.appId || !updates.installationId || !updates.privateKey) {
          return res.status(400).json({ error: 'App ID, Installation ID, and Private Key required for GitHub App authentication' });
        }
      }
    }

    const configManager = await getConfigManager();

    // Encrypt sensitive credentials before storing
    if (updates.accessToken) {
      updates.accessToken = await configManager.updateCredential(
        `${platformId}_access_token`,
        updates.accessToken,
        req.user.id
      );
    }

    if (updates.webhookUrl && platformId === 'bitrix24') {
      updates.webhookUrl = await configManager.updateCredential(
        'bitrix24_webhook_url',
        updates.webhookUrl,
        req.user.id
      );
    }

    // Google Chat uses ADC - no credentials to encrypt

    if (updates.webhookSecret && platformId === 'asana') {
      updates.webhookSecret = await configManager.updateCredential(
        'asana_webhook_secret',
        updates.webhookSecret,
        req.user.id
      );
    }

    if (updates.appPassword && platformId === 'bluesky') {
      updates.appPassword = await configManager.updateCredential(
        'bluesky_app_password',
        updates.appPassword,
        req.user.id
      );
    }

    // GitHub credential encryption
    if (platformId === 'github') {
      if (updates.accessToken) {
        updates.accessToken = await configManager.updateCredential(
          'github_access_token',
          updates.accessToken,
          req.user.id
        );
      }
      if (updates.privateKey) {
        updates.privateKey = await configManager.updateCredential(
          'github_private_key',
          updates.privateKey,
          req.user.id
        );
      }
    }

    await configManager.updatePlatform(platformId, updates, req.user.id);

    // Reset GitHub service if GitHub config was updated (to pick up new credentials)
    if (platformId === 'github') {
      try {
        const { getGitHubService } = require('../services/github/githubService');
        const githubService = getGitHubService();
        githubService.reset();
      } catch (resetError) {
        logger.warn('Failed to reset GitHub service', { error: resetError.message });
      }
    }

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'platform_update',
      platformId,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date(),
      details: { enabled: updates.enabled }
    });

    logger.info('Platform configuration updated', {
      platformId,
      userId: req.user.id,
      enabled: updates.enabled
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Platform update failed', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to update platform configuration' });
  }
});

/**
 * User Management API Routes
 */

// Get single user details (Admin only)
router.get('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const userDoc = await db.collection('users').doc(req.params.id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    // Return user data without sensitive fields
    res.json({
      id: userDoc.id,
      username: userData.username,
      email: userData.email || '',
      role: userData.role,
      createdAt: userData.createdAt,
      lastLogin: userData.lastLogin,
      locked: userData.locked || false,
      profilePicture: userData.profilePicture || null
    });
  } catch (error) {
    logger.error('Failed to get user details', {
      error: error.message,
      userId: req.user.id,
      targetUserId: req.params.id
    });
    res.status(500).json({ error: 'Failed to get user details' });
  }
});

// Update user (Admin only)
router.put('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const { email, role } = req.body;

    // Validate role
    if (role && !['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be "user" or "admin"' });
    }

    // Validate email format (basic)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if user exists
    const userDoc = await db.collection('users').doc(req.params.id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent admins from demoting themselves
    if (req.params.id === req.user.id && role === 'user') {
      return res.status(400).json({ error: 'Cannot demote yourself from admin' });
    }

    const updates = {};
    if (email !== undefined) updates.email = email;
    if (role !== undefined) updates.role = role;

    await db.collection('users').doc(req.params.id).update(updates);

    // Audit log
    await db.collection('audit-logs').add({
      action: 'user_update',
      targetUserId: req.params.id,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date(),
      details: updates
    });

    logger.info('User updated', {
      targetUserId: req.params.id,
      userId: req.user.id,
      updates: Object.keys(updates)
    });

    res.json({ success: true, message: 'User updated successfully' });
  } catch (error) {
    logger.error('Failed to update user', {
      error: error.message,
      userId: req.user.id,
      targetUserId: req.params.id
    });
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Reset user password (Admin only)
router.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const bcrypt = require('bcrypt');
    const crypto = require('crypto');

    // Check if user exists
    const userDoc = await db.collection('users').doc(req.params.id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate temporary password (12 characters, alphanumeric)
    const tempPassword = crypto.randomBytes(9).toString('base64').substring(0, 12);

    // Hash password
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Update user with new password and require password change
    await db.collection('users').doc(req.params.id).update({
      password: hashedPassword,
      requirePasswordChange: true,
      loginAttempts: 0,
      locked: false
    });

    // Audit log
    await db.collection('audit-logs').add({
      action: 'password_reset',
      targetUserId: req.params.id,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('Password reset', {
      targetUserId: req.params.id,
      userId: req.user.id
    });

    res.json({
      success: true,
      tempPassword,
      message: 'Password reset successfully. User will be required to change password on next login.'
    });
  } catch (error) {
    logger.error('Failed to reset password', {
      error: error.message,
      userId: req.user.id,
      targetUserId: req.params.id
    });
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Lock user account (Admin only)
router.post('/api/users/:id/lock', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();

    // Check if user exists
    const userDoc = await db.collection('users').doc(req.params.id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent admins from locking themselves
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot lock your own account' });
    }

    await db.collection('users').doc(req.params.id).update({
      locked: true,
      lockedAt: new Date(),
      lockedBy: req.user.id
    });

    // Audit log
    await db.collection('audit-logs').add({
      action: 'user_locked',
      targetUserId: req.params.id,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('User account locked', {
      targetUserId: req.params.id,
      userId: req.user.id
    });

    res.json({ success: true, message: 'User account locked successfully' });
  } catch (error) {
    logger.error('Failed to lock user account', {
      error: error.message,
      userId: req.user.id,
      targetUserId: req.params.id
    });
    res.status(500).json({ error: 'Failed to lock user account' });
  }
});

// Unlock user account (Admin only)
router.post('/api/users/:id/unlock', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();

    // Check if user exists
    const userDoc = await db.collection('users').doc(req.params.id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    await db.collection('users').doc(req.params.id).update({
      locked: false,
      loginAttempts: 0,
      lockedAt: null,
      lockedBy: null
    });

    // Audit log
    await db.collection('audit-logs').add({
      action: 'user_unlocked',
      targetUserId: req.params.id,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('User account unlocked', {
      targetUserId: req.params.id,
      userId: req.user.id
    });

    res.json({ success: true, message: 'User account unlocked successfully' });
  } catch (error) {
    logger.error('Failed to unlock user account', {
      error: error.message,
      userId: req.user.id,
      targetUserId: req.params.id
    });
    res.status(500).json({ error: 'Failed to unlock user account' });
  }
});

/**
 * User Profile Routes (Self-Service)
 */

// Get current user profile
router.get('/profile', async (req, res) => {
  try {
    // Check if req.user exists (set by verifyToken middleware)
    if (!req.user || !req.user.id) {
      logger.error('Profile page error: req.user not set', {
        userId: req.user?.id,
        sessionID: req.sessionID
      });
      req.flash('error', 'Authentication error. Please log in again.');
      return res.redirect('/auth/login');
    }

    const db = getFirestore();
    const userDoc = await db.collection('users').doc(req.user.id).get();

    if (!userDoc.exists) {
      logger.warn('Profile page: user document not found', {
        userId: req.user.id
      });
      req.flash('error', 'User not found');
      return res.redirect('/dashboard');
    }

    const userData = userDoc.data();

    res.locals.currentPage = 'users';
    res.locals.title = 'My Profile';

    res.render('dashboard/profile', {
      user: {
        id: userDoc.id,
        username: userData.username,
        email: userData.email || '',
        role: userData.role,
        profilePicture: userData.profilePicture || null,
        // Convert Firestore Timestamps to objects with _seconds property for template compatibility
        createdAt: userData.createdAt ? {
          _seconds: userData.createdAt.seconds || userData.createdAt._seconds || Math.floor(new Date(userData.createdAt).getTime() / 1000)
        } : null,
        lastLogin: userData.lastLogin ? {
          _seconds: userData.lastLogin.seconds || userData.lastLogin._seconds || Math.floor(new Date(userData.lastLogin).getTime() / 1000)
        } : null
      }
    });
  } catch (error) {
    logger.error('Profile page error', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id,
      hasReqUser: !!req.user
    });
    req.flash('error', 'Failed to load profile');
    res.redirect('/dashboard');
  }
});

// Update current user profile
router.put('/api/profile', async (req, res) => {
  try {
    const db = getFirestore();
    const bcrypt = require('bcrypt');
    const { email, currentPassword, newPassword, profilePicture } = req.body;

    const userDoc = await db.collection('users').doc(req.user.id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const updates = {};

    // Update email if provided
    if (email !== undefined && email !== userData.email) {
      // Validate email format
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      updates.email = email;
    }

    // Update profile picture if provided
    if (profilePicture !== undefined) {
      // Validate URL format
      if (profilePicture && profilePicture.trim() !== '') {
        try {
          const url = new URL(profilePicture);
          // Validate protocol (HTTP or HTTPS only)
          if (!['http:', 'https:'].includes(url.protocol)) {
            return res.status(400).json({ error: 'Profile picture URL must use HTTP or HTTPS protocol' });
          }
          updates.profilePicture = profilePicture;
        } catch (e) {
          return res.status(400).json({ error: 'Invalid profile picture URL format' });
        }
      } else {
        // Allow empty string to remove profile picture
        updates.profilePicture = null;
      }
    }

    // Update password if provided
    if (newPassword) {
      // Require current password for password change
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password required to change password' });
      }

      // Verify current password
      const validPassword = await bcrypt.compare(currentPassword, userData.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      // Validate new password strength (minimum 8 characters)
      if (newPassword.length < 8) {
        return res.status(400).json({ error: 'New password must be at least 8 characters' });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      updates.password = hashedPassword;
      updates.requirePasswordChange = false;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    await db.collection('users').doc(req.user.id).update(updates);

    // Audit log
    await db.collection('audit-logs').add({
      action: 'profile_update',
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date(),
      details: {
        emailChanged: !!updates.email,
        passwordChanged: !!updates.password,
        profilePictureChanged: updates.profilePicture !== undefined
      }
    });

    logger.info('Profile updated', {
      userId: req.user.id,
      changes: Object.keys(updates).filter(k => k !== 'password')
    });

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (error) {
    logger.error('Failed to update profile', {
      error: error.message,
      userId: req.user.id
    });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * Chat Page and API Routes
 */

// Chat page
router.get('/chat', async (req, res) => {
  try {
    res.locals.currentPage = 'chat';
    res.locals.title = `Chat with ${res.locals.agentName}`;

    res.render('dashboard/chat');
  } catch (error) {
    logger.error('Chat page error', {
      error: error.message,
      userId: req.user.id
    });
    req.flash('error', 'Failed to load chat');
    res.redirect('/dashboard');
  }
});

// Rate limiter for chat API (100 messages per 15 minutes per user)
const rateLimit = require('express-rate-limit');

const chatRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  keyGenerator: (req) => {
    logger.info('Chat rate limiter - generating key', { userId: req.user?.id });
    return req.user.id;
  },
  handler: (req, res) => {
    logger.warn('Chat rate limit exceeded', {
      userId: req.user.id,
      ip: req.ip
    });
    res.status(429).json({
      error: 'Too many messages. Please wait before sending more.'
    });
  },
  skip: (req) => {
    logger.info('Chat rate limiter - checking request', {
      userId: req.user?.id,
      path: req.path
    });
    return false; // Never skip
  }
});

// Get or create conversation
router.get('/api/chat/conversation', async (req, res) => {
  try {
    const { getChatService } = require('../services/chatService');
    const chatService = await require('../services/chatService').initializeChatService();

    const conversation = await chatService.getOrCreateConversation(req.user.id);

    res.json({
      conversationId: conversation.id,
      messageCount: conversation.messageCount || 0
    });
  } catch (error) {
    logger.error('Failed to get conversation', {
      userId: req.user.id,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// Get conversation messages
router.get('/api/chat/messages', async (req, res) => {
  try {
    const { conversationId, after } = req.query;

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId required' });
    }

    const { getChatService } = require('../services/chatService');
    const chatService = await require('../services/chatService').initializeChatService();

    let messages = await chatService.getHistory(conversationId);

    // Filter messages after timestamp if provided
    if (after) {
      const afterTimestamp = parseInt(after);
      messages = messages.filter(msg => {
        const msgTime = msg.timestamp?._seconds || msg.timestamp?.seconds || 0;
        return msgTime > afterTimestamp;
      });
    }

    res.json({ messages });
  } catch (error) {
    logger.error('Failed to get messages', {
      userId: req.user.id,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Get pending approvals for the chat interface
router.get('/api/chat/pending-approvals', async (req, res) => {
  try {
    const db = getFirestore();
    const branch = req.query.branch || 'main';

    // Get pending modifications that haven't been approved yet
    // Note: Edit/WriteFile tools set userApproved: false initially
    // Filter by branch to only show approvals for the current branch
    const modsSnapshot = await db.collection('code-modifications')
      .where('userApproved', '==', false)
      .where('branch', '==', branch)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const pendingApprovals = [];

    for (const doc of modsSnapshot.docs) {
      const mod = doc.data();
      pendingApprovals.push({
        modId: doc.id,
        filePath: mod.filePath,
        operation: mod.operation,
        diff: mod.diff || '',
        commitMessage: mod.commitMessage,
        branch: mod.branch,
        createdAt: mod.createdAt?.toDate?.()?.toISOString() || null
      });
    }

    logger.info('Loaded pending approvals for chat', {
      userId: req.user.id,
      count: pendingApprovals.length
    });

    res.json({
      success: true,
      pendingApprovals
    });

  } catch (error) {
    logger.error('Failed to load pending approvals', {
      userId: req.user.id,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to load pending approvals'
    });
  }
});

// Stream AI response (SSE endpoint)
router.post('/api/chat/stream', chatRateLimiter, async (req, res) => {
  try {
    const { message, conversationId } = req.body;

    logger.info('Chat stream request', {
      userId: req.user.id,
      conversationId,
      messageLength: message?.length
    });

    // SECURITY: Validate input
    if (!message || typeof message !== 'string') {
      logger.warn('Invalid message type', { userId: req.user.id, messageType: typeof message });
      return res.status(400).json({ error: 'Invalid message' });
    }

    if (!conversationId) {
      logger.warn('Missing conversationId', { userId: req.user.id });
      return res.status(400).json({ error: 'conversationId required' });
    }

    if (message.length > 10000) {
      logger.warn('Message too long', { userId: req.user.id, length: message.length });
      return res.status(400).json({ error: 'Message too long (max 10000 characters)' });
    }

    logger.info('Initializing chat service', { userId: req.user.id });
    const chatService = await require('../services/chatService').initializeChatService();

    logger.info('Starting SSE stream', { userId: req.user.id, userRole: req.user.role, conversationId });
    // Stream response via SSE - pass user role to avoid bitrix_users lookup
    await chatService.streamResponse(res, req.user.id, message, conversationId, req.user.role);

    logger.info('SSE stream completed', { userId: req.user.id });

  } catch (error) {
    logger.error('Chat stream failed', {
      userId: req.user.id,
      error: error.message,
      stack: error.stack
    });

    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate response' });
    }
  }
});

// Clear conversation history
router.post('/api/chat/clear', async (req, res) => {
  try {
    const { conversationId } = req.body;

    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId required' });
    }

    const { getChatService } = require('../services/chatService');
    const chatService = await require('../services/chatService').initializeChatService();

    await chatService.clearHistory(conversationId);

    // Audit log
    const db = getFirestore();
    await db.collection('audit-logs').add({
      action: 'chat_cleared',
      conversationId,
      userId: req.user.id,
      username: req.user.username,
      timestamp: new Date()
    });

    logger.info('Chat conversation cleared', {
      conversationId,
      userId: req.user.id
    });

    res.json({ success: true, message: 'Conversation cleared successfully' });
  } catch (error) {
    logger.error('Failed to clear chat', {
      userId: req.user.id,
      error: error.message
    });
    res.status(500).json({ error: 'Failed to clear conversation' });
  }
});

// ============================================
// Code Modification Approval Endpoints (Chat)
// ============================================

/**
 * POST /api/chat/approve/:modId
 * Approve a pending code modification from chat
 */
router.post('/api/chat/approve/:modId', async (req, res) => {
  try {
    const { modId } = req.params;

    if (!modId || typeof modId !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid modification ID' });
    }

    const db = getFirestore();
    const { getFieldValue } = require('../config/firestore');
    const FieldValue = getFieldValue();

    const modRef = db.collection('code-modifications').doc(modId);
    const modDoc = await modRef.get();

    if (!modDoc.exists) {
      return res.status(404).json({ success: false, error: 'Modification not found' });
    }

    const mod = modDoc.data();

    if (mod.userApproved) {
      return res.status(400).json({ success: false, error: 'Modification already approved' });
    }

    // Apply the modification via GitHub API
    const { getGitHubService } = require('../services/github/githubService');
    const githubService = getGitHubService();
    let result;

    if (mod.operation === 'delete') {
      const existing = await githubService.getFileContents(mod.filePath, mod.branch);
      result = await githubService.deleteFile(
        mod.filePath,
        mod.commitMessage,
        mod.branch,
        existing.sha
      );
    } else {
      result = await githubService.createOrUpdateFile(
        mod.filePath,
        mod.afterContent,
        mod.commitMessage,
        mod.branch
      );
    }

    // Update modification record
    await modRef.update({
      userApproved: true,
      approvedBy: req.user.username,
      approvedAt: FieldValue.serverTimestamp(),
      appliedAt: FieldValue.serverTimestamp(),
      committedAt: FieldValue.serverTimestamp(),
      commitSha: result.commit.sha
    });

    // Add to build session if active
    try {
      const { getBuildModeManager } = require('../services/build/buildModeManager');
      const buildModeManager = getBuildModeManager();
      const session = await buildModeManager.getCurrentSession(req.user.username);
      if (session) {
        await buildModeManager.addCommitToSession(session.sessionId, {
          sha: result.commit.sha,
          message: mod.commitMessage
        });
        await buildModeManager.addFileToSession(session.sessionId, {
          path: mod.filePath,
          status: mod.operation === 'create' ? 'created' : mod.operation
        });
      }
    } catch (sessionError) {
      logger.warn('Failed to add to build session', { error: sessionError.message });
    }

    logger.info('Code modification approved via chat', {
      modId,
      filePath: mod.filePath,
      commitSha: result.commit.sha,
      approvedBy: req.user.username
    });

    // Save approval message to chat history
    if (mod.conversationId) {
      try {
        const { getChatService } = require('../services/chatService');
        const chatService = getChatService();
        const approvalMessage = `✅ **Approved**: ${mod.operation === 'create' ? 'Created' : 'Updated'} \`${mod.filePath}\`\n\nCommit: [\`${result.commit.sha.substring(0, 7)}\`](${result.commit.url})`;
        await chatService.saveMessage(mod.conversationId, {
          role: 'assistant',
          content: approvalMessage,
          userId: null
        });
      } catch (chatError) {
        logger.warn('Failed to save approval to chat history', { error: chatError.message });
      }
    }

    // Trigger Cloud Build deployment
    let buildInfo = { triggered: false };
    try {
      const { getCloudBuildService } = require('../services/cloudBuildService');
      const cloudBuildService = getCloudBuildService();
      buildInfo = await cloudBuildService.triggerBuild(
        mod.branch,
        result.commit.sha,
        req.user.username
      );

      if (buildInfo.triggered) {
        logger.info('Cloud Build triggered after approval', {
          buildId: buildInfo.buildId,
          branch: mod.branch,
          commitSha: result.commit.sha?.substring(0, 7)
        });
      }
    } catch (buildError) {
      logger.warn('Failed to trigger Cloud Build (non-fatal)', {
        error: buildError.message,
        modId
      });
    }

    res.json({
      success: true,
      commitSha: result.commit.sha,
      commitUrl: result.commit.url,
      build: buildInfo
    });
  } catch (error) {
    logger.error('Failed to approve code modification', {
      modId: req.params.modId,
      userId: req.user.id,
      error: error.message
    });
    res.status(500).json({ success: false, error: 'Failed to approve modification' });
  }
});

/**
 * POST /api/chat/approve-batch
 * Approve multiple pending code modifications in a single commit
 * This batches all files into one commit to trigger only one build
 */
router.post('/api/chat/approve-batch', async (req, res) => {
  try {
    const { modIds, commitMessage } = req.body;

    // Validate input
    if (!modIds || !Array.isArray(modIds) || modIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'modIds must be a non-empty array'
      });
    }

    if (modIds.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Cannot batch more than 50 modifications at once'
      });
    }

    const db = getFirestore();
    const { getFieldValue } = require('../config/firestore');
    const FieldValue = getFieldValue();

    // Fetch all modifications
    const mods = [];
    let branch = null;
    let conversationId = null;

    for (const modId of modIds) {
      const modRef = db.collection('code-modifications').doc(modId);
      const modDoc = await modRef.get();

      if (!modDoc.exists) {
        return res.status(404).json({
          success: false,
          error: `Modification ${modId} not found`
        });
      }

      const mod = modDoc.data();

      if (mod.userApproved) {
        return res.status(400).json({
          success: false,
          error: `Modification ${modId} already approved`
        });
      }

      // All modifications must be on the same branch
      if (branch === null) {
        branch = mod.branch;
        conversationId = mod.conversationId;
      } else if (mod.branch !== branch) {
        return res.status(400).json({
          success: false,
          error: 'All modifications must be on the same branch'
        });
      }

      mods.push({ modId, ref: modRef, data: mod });
    }

    // Build files array for batch commit
    const files = [];
    for (const mod of mods) {
      if (mod.data.operation === 'delete') {
        files.push({
          path: mod.data.filePath,
          operation: 'delete'
        });
      } else {
        files.push({
          path: mod.data.filePath,
          content: mod.data.afterContent,
          operation: mod.data.operation
        });
      }
    }

    // Create combined commit message if not provided
    const finalMessage = commitMessage ||
      `Batch update: ${mods.map(m => m.data.filePath.split('/').pop()).join(', ')}`;

    // Create batch commit
    const { getGitHubService } = require('../services/github/githubService');
    const githubService = getGitHubService();
    const result = await githubService.createBatchCommit(files, finalMessage, branch);

    // Update all modification records
    const batch = db.batch();
    for (const mod of mods) {
      batch.update(mod.ref, {
        userApproved: true,
        approvedBy: req.user.username,
        approvedAt: FieldValue.serverTimestamp(),
        appliedAt: FieldValue.serverTimestamp(),
        committedAt: FieldValue.serverTimestamp(),
        commitSha: result.commit.sha,
        batchCommit: true
      });
    }
    await batch.commit();

    // Add to build session if active
    try {
      const { getBuildModeManager } = require('../services/build/buildModeManager');
      const buildModeManager = getBuildModeManager();
      const session = await buildModeManager.getCurrentSession(req.user.username);
      if (session) {
        await buildModeManager.addCommitToSession(session.sessionId, {
          sha: result.commit.sha,
          message: finalMessage
        });
        for (const mod of mods) {
          await buildModeManager.addFileToSession(session.sessionId, {
            path: mod.data.filePath,
            status: mod.data.operation === 'create' ? 'created' : mod.data.operation
          });
        }
      }
    } catch (sessionError) {
      logger.warn('Failed to add to build session', { error: sessionError.message });
    }

    logger.info('Batch code modifications approved via chat', {
      modIds,
      fileCount: files.length,
      commitSha: result.commit.sha,
      approvedBy: req.user.username
    });

    // Save approval message to chat history
    if (conversationId) {
      try {
        const { getChatService } = require('../services/chatService');
        const chatService = getChatService();
        const fileList = mods.map(m => `\`${m.data.filePath}\``).join(', ');
        const approvalMessage = `✅ **Batch Approved**: ${files.length} files committed\n\nFiles: ${fileList}\n\nCommit: [\`${result.commit.sha.substring(0, 7)}\`](${result.commit.url})`;
        await chatService.saveMessage(conversationId, {
          role: 'assistant',
          content: approvalMessage,
          userId: null
        });
      } catch (chatError) {
        logger.warn('Failed to save batch approval to chat history', { error: chatError.message });
      }
    }

    // Trigger Cloud Build deployment (only once for all files)
    let buildInfo = { triggered: false };
    try {
      const { getCloudBuildService } = require('../services/cloudBuildService');
      const cloudBuildService = getCloudBuildService();
      buildInfo = await cloudBuildService.triggerBuild(
        branch,
        result.commit.sha,
        req.user.username
      );

      if (buildInfo.triggered) {
        logger.info('Cloud Build triggered after batch approval', {
          buildId: buildInfo.buildId,
          branch,
          commitSha: result.commit.sha?.substring(0, 7),
          fileCount: files.length
        });
      }
    } catch (buildError) {
      logger.warn('Failed to trigger Cloud Build (non-fatal)', {
        error: buildError.message,
        modIds
      });
    }

    res.json({
      success: true,
      commitSha: result.commit.sha,
      commitUrl: result.commit.url,
      filesCommitted: files.length,
      build: buildInfo
    });
  } catch (error) {
    logger.error('Failed to approve batch code modifications', {
      modIds: req.body.modIds,
      userId: req.user?.id,
      error: error.message
    });
    res.status(500).json({ success: false, error: 'Failed to approve batch modifications' });
  }
});

/**
 * POST /api/chat/reject/:modId
 * Reject a pending code modification from chat
 */
router.post('/api/chat/reject/:modId', async (req, res) => {
  try {
    const { modId } = req.params;

    if (!modId || typeof modId !== 'string') {
      return res.status(400).json({ success: false, error: 'Invalid modification ID' });
    }

    const db = getFirestore();
    const { getFieldValue } = require('../config/firestore');
    const FieldValue = getFieldValue();

    const modRef = db.collection('code-modifications').doc(modId);
    const modDoc = await modRef.get();

    if (!modDoc.exists) {
      return res.status(404).json({ success: false, error: 'Modification not found' });
    }

    const mod = modDoc.data();

    if (mod.userApproved) {
      return res.status(400).json({ success: false, error: 'Modification already approved, cannot reject' });
    }

    // Update modification record as rejected
    // Set userApproved to null so it's excluded from pending queries
    await modRef.update({
      userApproved: null,
      rejected: true,
      rejectedBy: req.user.username,
      rejectedAt: FieldValue.serverTimestamp()
    });

    logger.info('Code modification rejected via chat', {
      modId,
      filePath: mod.filePath,
      rejectedBy: req.user.username
    });

    // Save rejection message to chat history
    if (mod.conversationId) {
      try {
        const { getChatService } = require('../services/chatService');
        const chatService = getChatService();
        const rejectionMessage = `❌ **Rejected**: ${mod.operation === 'create' ? 'Create' : 'Update'} \`${mod.filePath}\` was not applied.`;
        await chatService.saveMessage(mod.conversationId, {
          role: 'assistant',
          content: rejectionMessage,
          userId: null
        });
      } catch (chatError) {
        logger.warn('Failed to save rejection to chat history', { error: chatError.message });
      }
    }

    res.json({ success: true, message: 'Modification rejected' });
  } catch (error) {
    logger.error('Failed to reject code modification', {
      modId: req.params.modId,
      userId: req.user.id,
      error: error.message
    });
    res.status(500).json({ success: false, error: 'Failed to reject modification' });
  }
});

module.exports = router;
