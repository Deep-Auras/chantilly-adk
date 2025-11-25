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

// CRITICAL DEBUG: Log session state before verifyToken
router.use((req, res, next) => {
  logger.info('DASHBOARD - Session state check', {
    path: req.path,
    sessionID: req.sessionID,
    hasSession: !!req.session,
    hasToken: !!(req.session && req.session.token),
    hasUser: !!(req.session && req.session.user),
    cookieHeader: req.headers.cookie ? 'present' : 'missing'
  });
  next();
});

// Apply authentication to all dashboard routes
router.use(verifyToken);
router.use(validateCSRF);

// Make user and dynamic agent name available to all views
router.use(async (req, res, next) => {
  res.locals.user = req.user;

  // Load agent name from database config (falls back to env var, then default)
  try {
    const configManager = await getConfigManager();
    const config = await configManager.get('config');
    res.locals.agentName = config?.AGENT_NAME || process.env.AGENT_NAME || 'Clementine';
  } catch (error) {
    // Fallback to env var or default if config loading fails
    res.locals.agentName = process.env.AGENT_NAME || 'Clementine';
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

    res.locals.currentPage = 'platforms';
    res.locals.title = 'Platform Integrations';

    res.render('dashboard/platforms', {
      bitrix24: bitrix24Config || {},
      googleChat: googleChatConfig || {},
      asana: asanaConfig || {},
      bluesky: blueskyConfig || {}
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
    const entries = rawEntries.map(entry => ({
      id: entry.id,
      title: entry.title || 'Untitled',
      content: entry.content || '',
      category: entry.category || 'general',
      priority: entry.priority || 0,
      tags: entry.tags || [],
      enabled: entry.enabled !== false,
      lastUpdated: entry.lastUpdated
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
        category: tool.category,
        enabled: tool.enabled,
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
        role: data.role,
        createdAt: data.createdAt,
        lastLogin: data.lastLogin,
        loginAttempts: data.loginAttempts || 0,
        locked: data.locked || false
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
 * Dashboard Activity API (Stub)
 * GET /api/dashboard/activity
 */
router.get('/api/dashboard/activity', async (req, res) => {
  try {
    const db = getFirestore();

    // Get recent audit logs
    const logsSnapshot = await db.collection('audit-logs')
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    const activities = logsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        message: `${data.action} by ${data.username || 'System'}`,
        timestamp: data.timestamp?.toDate?.()?.toLocaleString() || 'Unknown'
      };
    });

    res.json({ activities });
  } catch (error) {
    logger.error('Dashboard activity API error', {
      error: error.message,
      userId: req.user?.id
    });
    res.json({ activities: [] }); // Return empty array on error
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
    const validPlatforms = ['bitrix24', 'google-chat', 'asana', 'bluesky'];
    if (!validPlatforms.includes(platformId)) {
      return res.status(400).json({ error: 'Invalid platform ID' });
    }

    // Validate required fields based on platform
    if (platformId === 'bitrix24' && updates.enabled) {
      if (!updates.domain || !updates.webhookUrl) {
        return res.status(400).json({ error: 'Domain and webhook URL required for Bitrix24' });
      }
    }

    if (platformId === 'google-chat' && updates.enabled) {
      if (!updates.projectId) {
        return res.status(400).json({ error: 'Project ID required for Google Chat' });
      }
    }

    if (platformId === 'asana' && updates.enabled) {
      if (!updates.accessToken || !updates.workspaceGid) {
        return res.status(400).json({ error: 'Access token and workspace GID required for Asana' });
      }
    }

    if (platformId === 'bluesky' && updates.enabled) {
      if (!updates.handle || !updates.appPassword) {
        return res.status(400).json({ error: 'Handle and app password required for Bluesky' });
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

    if (updates.serviceAccount && platformId === 'google-chat') {
      updates.serviceAccount = await configManager.updateCredential(
        'google_chat_service_account',
        updates.serviceAccount,
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

    await configManager.updatePlatform(platformId, updates, req.user.id);

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

module.exports = router;
