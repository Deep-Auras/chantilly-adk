/**
 * Build Mode API Routes
 * Handles build mode management, GitHub operations, and code modifications
 */

const express = require('express');
const router = express.Router();
const joi = require('joi');
const rateLimit = require('express-rate-limit');
const { verifyToken, sanitizeInput } = require('../middleware/auth');
const { getBuildModeManager } = require('../services/build/buildModeManager');
const { getBuildModeTriggerService } = require('../services/build/buildModeTriggerService');
const { getGitHubService } = require('../services/github/githubService');
const { getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');

// Decode HTML entities that may be introduced by frontend frameworks
// Handles both single and double-encoding (from sanitizeInput middleware)
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') {
    return str;
  }
  // First pass: decode &amp; to & (handles double-encoding)
  let decoded = str.replace(/&amp;/gi, '&');
  // Second pass: decode all HTML entities
  decoded = decoded
    .replace(/&#x2F;/gi, '/')    // Forward slash
    .replace(/&#47;/g, '/')       // Forward slash (decimal)
    .replace(/&#x5C;/gi, '\\')   // Backslash
    .replace(/&#92;/g, '\\')      // Backslash (decimal)
    .replace(/&#x27;/gi, '\'')   // Single quote
    .replace(/&#39;/g, '\'')      // Single quote (decimal)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"');
  return decoded;
}

// Path traversal validation helper
function isValidFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  // Block path traversal patterns
  const dangerousPatterns = [
    /\.\./,           // Parent directory traversal
    /^\/+/,           // Absolute paths
    /^~\//,           // Home directory
    /\0/,             // Null bytes
    /[<>:"|?*]/       // Invalid characters on Windows
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(filePath)) {
      logger.warn('Path traversal attempt blocked', { filePath });
      return false;
    }
  }

  // Normalize and ensure path stays within repo
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  return !normalized.startsWith('/') && !normalized.includes('../');
}

// Rate limiters for Build Mode API
const buildModeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  keyGenerator: (req) => req.user?.username || req.ip,
  handler: (req, res) => {
    logger.warn('Build mode rate limit exceeded', {
      username: req.user?.username,
      ip: req.ip,
      path: req.path
    });
    res.status(429).json({
      success: false,
      error: 'Too many requests. Please slow down.',
      retryAfter: 60
    });
  }
});

const modificationLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 code modifications per minute
  keyGenerator: (req) => req.user?.username || req.ip,
  handler: (req, res) => {
    logger.warn('Modification rate limit exceeded', {
      username: req.user?.username,
      ip: req.ip
    });
    res.status(429).json({
      success: false,
      error: 'Too many modification requests. Please slow down.',
      retryAfter: 60
    });
  }
});

// Validation schemas
const enableBuildModeSchema = joi.object({
  branch: joi.string().min(1).max(100).default('main')
});

const createBranchSchema = joi.object({
  branchName: joi.string().min(1).max(100).required()
    .pattern(/^[a-zA-Z0-9\-_/]+$/, 'valid branch name'),
  fromBranch: joi.string().min(1).max(100).default('main')
});

const switchBranchSchema = joi.object({
  branch: joi.string().min(1).max(100).required()
});

const mergeBranchSchema = joi.object({
  head: joi.string().min(1).max(100).required(),
  base: joi.string().min(1).max(100).required(),
  commitMessage: joi.string().max(500).optional()
});

const modifyCodeSchema = joi.object({
  filePath: joi.string().min(1).max(500).required()
    .custom((value, helpers) => {
      if (!isValidFilePath(value)) {
        return helpers.error('any.invalid');
      }
      return value;
    }, 'path traversal validation'),
  operation: joi.string().valid('create', 'update', 'delete').required(),
  content: joi.string().max(1000000).optional(), // 1MB max
  commitMessage: joi.string().min(1).max(500).required(),
  branch: joi.string().min(1).max(100).optional()
});

const approveModificationSchema = joi.object({
  comment: joi.string().max(500).optional()
});

// Build mode access middleware (admin or developer with build access)
const requireBuildAccess = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }

  const allowedRoles = ['admin', 'developer'];
  if (!allowedRoles.includes(req.user.role)) {
    logger.warn('User lacks build mode access', {
      username: req.user.username,
      role: req.user.role,
      path: req.path
    });
    return res.status(403).json({
      success: false,
      error: 'Build mode access required (admin or developer role)'
    });
  }

  next();
};

// Apply authentication, sanitization, and rate limiting to all build routes
// Use verifyToken which supports both session-based auth (dashboard) and JWT (API)
router.use(verifyToken);
router.use(sanitizeInput);
router.use(buildModeLimiter);

// ============================================================================
// BUILD MODE MANAGEMENT
// ============================================================================

/**
 * GET /api/build/status
 * Get current build mode status (no auth required for status check)
 */
router.get('/status', async (req, res) => {
  try {
    const buildModeManager = getBuildModeManager();
    const status = await buildModeManager.getStatus();

    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    logger.error('Failed to get build mode status', {
      error: error.message,
      requestedBy: req.user?.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get build mode status'
    });
  }
});

/**
 * POST /api/build/enable
 * Enable build mode
 */
router.post('/enable', requireBuildAccess, async (req, res) => {
  try {
    // Decode HTML entities BEFORE validation
    const decodedBody = {
      branch: decodeHtmlEntities(req.body.branch)
    };

    const { error, value } = enableBuildModeSchema.validate(decodedBody);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const branchName = value.branch;

    const buildModeManager = getBuildModeManager();
    const result = await buildModeManager.enableBuildMode(
      req.user.username,
      branchName
    );

    logger.info('Build mode enabled', {
      enabledBy: req.user.username,
      branch: branchName,
      sessionId: result.sessionId
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to enable build mode', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/build/disable
 * Disable build mode
 */
router.post('/disable', requireBuildAccess, async (req, res) => {
  try {
    const buildModeManager = getBuildModeManager();
    const result = await buildModeManager.disableBuildMode(req.user.username);

    logger.info('Build mode disabled', {
      disabledBy: req.user.username
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to disable build mode', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/build/session
 * Get current user's build session
 */
router.get('/session', requireBuildAccess, async (req, res) => {
  try {
    const buildModeManager = getBuildModeManager();
    const session = await buildModeManager.getCurrentSession(req.user.username);

    res.json({
      success: true,
      session
    });
  } catch (error) {
    logger.error('Failed to get build session', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get build session'
    });
  }
});

/**
 * GET /api/build/sessions/history
 * Get session history for current user
 */
router.get('/sessions/history', requireBuildAccess, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const buildModeManager = getBuildModeManager();
    const sessions = await buildModeManager.getSessionHistory(
      req.user.username,
      limit
    );

    res.json({
      success: true,
      sessions,
      count: sessions.length
    });
  } catch (error) {
    logger.error('Failed to get session history', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get session history'
    });
  }
});

// ============================================================================
// BRANCH OPERATIONS
// ============================================================================

/**
 * GET /api/build/branches
 * List all branches
 */
router.get('/branches', requireBuildAccess, async (req, res) => {
  try {
    const githubService = getGitHubService();
    const branches = await githubService.listBranches();

    res.json({
      success: true,
      branches: branches.map(b => ({
        name: b.name,
        protected: b.protected,
        sha: b.commit?.sha
      })),
      count: branches.length
    });
  } catch (error) {
    logger.error('Failed to list branches', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list branches'
    });
  }
});

/**
 * POST /api/build/branches/create
 * Create a new branch
 */
router.post('/branches/create', requireBuildAccess, async (req, res) => {
  try {
    // Decode HTML entities BEFORE validation (frontend may encode slashes)
    const decodedBody = {
      branchName: decodeHtmlEntities(req.body.branchName),
      fromBranch: decodeHtmlEntities(req.body.fromBranch)
    };

    const { error, value } = createBranchSchema.validate(decodedBody);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const branchName = value.branchName;
    const fromBranch = value.fromBranch;

    const githubService = getGitHubService();
    const result = await githubService.createBranch(
      branchName,
      fromBranch
    );

    logger.info('Branch created', {
      createdBy: req.user.username,
      branchName: branchName,
      fromBranch: fromBranch
    });

    res.json({
      success: true,
      branch: branchName,
      ref: result.ref,
      sha: result.object.sha
    });
  } catch (error) {
    logger.error('Failed to create branch', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/build/branches/switch
 * Switch to a different branch
 */
router.post('/branches/switch', requireBuildAccess, async (req, res) => {
  try {
    // Decode HTML entities BEFORE validation
    const decodedBody = {
      branch: decodeHtmlEntities(req.body.branch)
    };

    const { error, value } = switchBranchSchema.validate(decodedBody);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const branchName = value.branch;

    const buildModeManager = getBuildModeManager();
    const result = await buildModeManager.switchBranch(
      req.user.username,
      branchName
    );

    logger.info('Branch switched', {
      switchedBy: req.user.username,
      branch: branchName
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to switch branch', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/build/branches/merge
 * Merge branches
 */
router.post('/branches/merge', requireBuildAccess, async (req, res) => {
  try {
    // Decode HTML entities BEFORE validation
    const decodedBody = {
      head: decodeHtmlEntities(req.body.head),
      base: decodeHtmlEntities(req.body.base),
      commitMessage: req.body.commitMessage
    };

    const { error, value } = mergeBranchSchema.validate(decodedBody);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const head = value.head;
    const base = value.base;

    const githubService = getGitHubService();
    const result = await githubService.mergeBranch(
      base,
      head,
      value.commitMessage
    );

    logger.info('Branches merged', {
      mergedBy: req.user.username,
      head: head,
      base: base,
      sha: result.sha
    });

    res.json({
      success: true,
      sha: result.sha,
      message: result.commit?.message
    });
  } catch (error) {
    logger.error('Failed to merge branches', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// CODE MODIFICATION
// ============================================================================

/**
 * POST /api/build/modify
 * Request a code modification (creates pending modification)
 */
router.post('/modify', modificationLimiter, requireBuildAccess, async (req, res) => {
  try {
    const { error, value } = modifyCodeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    // Check if user can modify code
    const buildModeManager = getBuildModeManager();
    const canModify = await buildModeManager.canUserModifyCode(
      req.user.username,
      req.user.role
    );

    if (!canModify.allowed) {
      return res.status(403).json({
        success: false,
        error: canModify.reason
      });
    }

    // Get current session
    const session = await buildModeManager.getCurrentSession(req.user.username);
    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'No active build session. Enable build mode first.'
      });
    }

    const db = getFirestore();
    const FieldValue = getFieldValue();

    // Decode HTML entities from branch if provided
    const branch = value.branch ? decodeHtmlEntities(value.branch) : session.branch;

    // Get existing file content for updates
    let beforeContent = null;
    if (value.operation === 'update' || value.operation === 'delete') {
      const githubService = getGitHubService();
      const existing = await githubService.getFileContents(
        value.filePath,
        branch
      );
      if (existing.type === 'file') {
        beforeContent = existing.content;
      }
    }

    // Create modification record
    const modRef = db.collection('code-modifications').doc();
    await modRef.set({
      modId: modRef.id,
      sessionId: session.sessionId,
      userId: req.user.username,
      filePath: value.filePath,
      operation: value.operation,
      beforeContent,
      afterContent: value.content || null,
      commitMessage: value.commitMessage,
      branch: branch,
      userApproved: false,
      approvedAt: null,
      appliedAt: null,
      committedAt: null,
      commitSha: null,
      createdAt: FieldValue.serverTimestamp()
    });

    logger.info('Code modification requested', {
      modId: modRef.id,
      filePath: value.filePath,
      operation: value.operation,
      requestedBy: req.user.username
    });

    res.json({
      success: true,
      modId: modRef.id,
      status: 'pending_approval'
    });
  } catch (error) {
    logger.error('Failed to create modification request', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to create modification request'
    });
  }
});

/**
 * GET /api/build/modifications
 * List pending modifications for current session
 */
router.get('/modifications', requireBuildAccess, async (req, res) => {
  try {
    const buildModeManager = getBuildModeManager();
    const session = await buildModeManager.getCurrentSession(req.user.username);

    if (!session) {
      return res.json({
        success: true,
        modifications: [],
        count: 0
      });
    }

    const db = getFirestore();
    const mods = await db.collection('code-modifications')
      .where('sessionId', '==', session.sessionId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const modifications = mods.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null
    }));

    res.json({
      success: true,
      modifications,
      count: modifications.length
    });
  } catch (error) {
    logger.error('Failed to list modifications', {
      error: error.message,
      requestedBy: req.user.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list modifications'
    });
  }
});

/**
 * GET /api/build/modifications/:modId
 * Get modification details
 */
router.get('/modifications/:modId', requireBuildAccess, async (req, res) => {
  try {
    const { modId } = req.params;

    const db = getFirestore();
    const doc = await db.collection('code-modifications').doc(modId).get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Modification not found'
      });
    }

    res.json({
      success: true,
      modification: {
        id: doc.id,
        ...doc.data()
      }
    });
  } catch (error) {
    logger.error('Failed to get modification', {
      error: error.message,
      modId: req.params.modId
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get modification'
    });
  }
});

/**
 * POST /api/build/modifications/:modId/approve
 * Approve and apply a modification
 */
router.post('/modifications/:modId/approve', modificationLimiter, requireBuildAccess, async (req, res) => {
  try {
    const { modId } = req.params;
    const { error } = approveModificationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const db = getFirestore();
    const FieldValue = getFieldValue();
    const modRef = db.collection('code-modifications').doc(modId);
    const modDoc = await modRef.get();

    if (!modDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Modification not found'
      });
    }

    const mod = modDoc.data();

    if (mod.userApproved) {
      return res.status(400).json({
        success: false,
        error: 'Modification already approved'
      });
    }

    // Apply the modification via GitHub API
    const githubService = getGitHubService();
    let result;

    if (mod.operation === 'delete') {
      // Get SHA for delete
      const existing = await githubService.getFileContents(mod.filePath, mod.branch);
      result = await githubService.deleteFile(
        mod.filePath,
        mod.commitMessage,
        mod.branch,
        existing.sha
      );
    } else {
      // Create or update
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

    // Add to session
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

    logger.info('Modification approved and applied', {
      modId,
      commitSha: result.commit.sha,
      approvedBy: req.user.username
    });

    res.json({
      success: true,
      commitSha: result.commit.sha,
      commitUrl: result.commit.url
    });
  } catch (error) {
    logger.error('Failed to approve modification', {
      error: error.message,
      modId: req.params.modId
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/build/modifications/:modId/reject
 * Reject a modification
 */
router.post('/modifications/:modId/reject', requireBuildAccess, async (req, res) => {
  try {
    const { modId } = req.params;
    const { reason } = req.body;

    const db = getFirestore();
    const FieldValue = getFieldValue();
    const modRef = db.collection('code-modifications').doc(modId);
    const modDoc = await modRef.get();

    if (!modDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Modification not found'
      });
    }

    await modRef.update({
      rejected: true,
      rejectedBy: req.user.username,
      rejectedAt: FieldValue.serverTimestamp(),
      rejectionReason: reason || null
    });

    logger.info('Modification rejected', {
      modId,
      rejectedBy: req.user.username,
      reason
    });

    res.json({
      success: true,
      rejected: true
    });
  } catch (error) {
    logger.error('Failed to reject modification', {
      error: error.message,
      modId: req.params.modId
    });
    res.status(500).json({
      success: false,
      error: 'Failed to reject modification'
    });
  }
});

// ============================================================================
// GITHUB OPERATIONS
// ============================================================================

/**
 * GET /api/build/github/status
 * Check GitHub connection status
 */
router.get('/github/status', async (req, res) => {
  try {
    logger.info('GitHub status check requested', {
      userId: req.user?.id,
      username: req.user?.username
    });

    const githubService = getGitHubService();
    const isEnabled = await githubService.isEnabled();

    logger.info('GitHub isEnabled check', { isEnabled });

    if (!isEnabled) {
      return res.json({
        success: true,
        connected: false,
        enabled: false,
        reason: 'GitHub integration not enabled'
      });
    }

    const verification = await githubService.verifyConnection();

    logger.info('GitHub verification result', {
      connected: verification.connected,
      error: verification.error
    });

    res.json({
      success: true,
      ...verification
    });
  } catch (error) {
    logger.error('Failed to check GitHub status', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      error: 'Failed to check GitHub status',
      details: error.message
    });
  }
});

/**
 * GET /api/build/github/commits/:branch
 * List commits for a branch
 */
router.get('/github/commits/:branch', requireBuildAccess, async (req, res) => {
  try {
    // Decode HTML entities from branch name (URL params may be encoded)
    const branch = decodeHtmlEntities(req.params.branch);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const githubService = getGitHubService();
    const commits = await githubService.listCommits(branch, limit);

    res.json({
      success: true,
      branch,
      commits,
      count: commits.length
    });
  } catch (error) {
    logger.error('Failed to list commits', {
      error: error.message,
      branch: req.params.branch
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list commits'
    });
  }
});

/**
 * GET /api/build/github/file/*
 * Get file contents (path as wildcard)
 */
router.get('/github/file/*', requireBuildAccess, async (req, res) => {
  try {
    const filePath = req.params[0];
    // Decode HTML entities from ref/branch parameter
    const ref = decodeHtmlEntities(req.query.ref || req.query.branch);

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: 'File path is required'
      });
    }

    // Validate file path to prevent path traversal
    if (!isValidFilePath(filePath)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file path'
      });
    }

    const githubService = getGitHubService();
    const result = await githubService.getFileContents(filePath, ref);

    if (result.type === 'not_found') {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to get file contents', {
      error: error.message,
      path: req.params[0]
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get file contents'
    });
  }
});

/**
 * GET /api/build/github/tree
 * Get repository tree
 */
router.get('/github/tree', requireBuildAccess, async (req, res) => {
  try {
    // Decode HTML entities from branch parameter
    const branch = decodeHtmlEntities(req.query.branch) || 'main';

    const githubService = getGitHubService();
    const tree = await githubService.getTree(branch);

    // Filter to just files and limit response size
    const files = tree
      .filter(item => item.type === 'blob')
      .slice(0, 1000)
      .map(item => ({
        path: item.path,
        sha: item.sha,
        size: item.size
      }));

    res.json({
      success: true,
      branch,
      files,
      count: files.length,
      truncated: tree.length > 1000
    });
  } catch (error) {
    logger.error('Failed to get tree', {
      error: error.message,
      branch: req.query.branch
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get repository tree'
    });
  }
});

/**
 * GET /api/build/github/rate-limit
 * Get GitHub API rate limit status
 */
router.get('/github/rate-limit', requireBuildAccess, async (req, res) => {
  try {
    const githubService = getGitHubService();
    const rateLimit = await githubService.getRateLimit();

    res.json({
      success: true,
      ...rateLimit
    });
  } catch (error) {
    logger.error('Failed to get rate limit', {
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get rate limit'
    });
  }
});

// ============================================================================
// TRIGGER MANAGEMENT
// ============================================================================

/**
 * GET /api/build/triggers/semantic
 * Get semantic trigger configuration
 */
router.get('/triggers/semantic', requireBuildAccess, async (req, res) => {
  try {
    const triggerService = getBuildModeTriggerService();
    const config = await triggerService.getConfig();
    const triggers = await triggerService.getTriggers();

    res.json({
      success: true,
      config,
      triggers
    });
  } catch (error) {
    logger.error('Failed to get semantic triggers', {
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get semantic triggers'
    });
  }
});

/**
 * POST /api/build/triggers/semantic/test
 * Test a message against semantic triggers
 */
router.post('/triggers/semantic/test', requireBuildAccess, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }

    const triggerService = getBuildModeTriggerService();
    const result = await triggerService.testMessage(message);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Failed to test semantic trigger', {
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to test trigger'
    });
  }
});

// ============================================================================
// CLOUD BUILD OPERATIONS
// ============================================================================

/**
 * GET /api/build/cloud-builds
 * List recent Cloud Build deployments
 */
router.get('/cloud-builds', requireBuildAccess, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const { getCloudBuildService } = require('../services/cloudBuildService');
    const cloudBuildService = getCloudBuildService();
    const builds = await cloudBuildService.listBuilds(limit);

    res.json({
      success: true,
      builds,
      count: builds.length
    });
  } catch (error) {
    logger.error('Failed to list cloud builds', {
      error: error.message,
      requestedBy: req.user?.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to list cloud builds'
    });
  }
});

/**
 * GET /api/build/cloud-builds/:buildId/status
 * Get status of a specific build
 */
router.get('/cloud-builds/:buildId/status', requireBuildAccess, async (req, res) => {
  try {
    const { buildId } = req.params;

    const { getCloudBuildService } = require('../services/cloudBuildService');
    const cloudBuildService = getCloudBuildService();
    const status = await cloudBuildService.getBuildStatus(buildId);

    res.json({
      success: true,
      buildId,
      ...status
    });
  } catch (error) {
    logger.error('Failed to get build status', {
      error: error.message,
      buildId: req.params.buildId
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get build status'
    });
  }
});

/**
 * POST /api/build/cloud-builds/trigger
 * Manually trigger a Cloud Build deployment
 */
router.post('/cloud-builds/trigger', modificationLimiter, requireBuildAccess, async (req, res) => {
  try {
    // Get current branch from build mode or use provided branch
    const buildModeManager = getBuildModeManager();
    const status = await buildModeManager.getStatus();

    // Decode HTML entities from branch name (frontend may encode slashes)
    const rawBranch = req.body.branch || status.currentBranch || 'main';
    const branch = decodeHtmlEntities(rawBranch);

    const { getCloudBuildService } = require('../services/cloudBuildService');
    const cloudBuildService = getCloudBuildService();

    logger.info('Manual Cloud Build trigger requested', {
      triggeredBy: req.user.username,
      branch
    });

    const result = await cloudBuildService.triggerBuild(
      branch,
      null, // No specific commit SHA for manual trigger
      req.user.username
    );

    if (!result.triggered) {
      return res.status(400).json({
        success: false,
        error: result.reason || 'Failed to trigger build'
      });
    }

    res.json({
      success: true,
      buildId: result.buildId,
      logUrl: result.logUrl,
      branch,
      triggeredBy: req.user.username
    });
  } catch (error) {
    logger.error('Failed to trigger cloud build', {
      error: error.message,
      requestedBy: req.user?.username
    });
    res.status(500).json({
      success: false,
      error: 'Failed to trigger cloud build'
    });
  }
});

/**
 * GET /api/build/cloud-builds/config
 * Get Cloud Build configuration (trigger ID, project ID)
 */
router.get('/cloud-builds/config', requireBuildAccess, async (_req, res) => {
  try {
    const { getCloudBuildService } = require('../services/cloudBuildService');
    const cloudBuildService = getCloudBuildService();

    const triggerId = await cloudBuildService.getTriggerId();
    const projectId = await cloudBuildService.getProjectId();

    res.json({
      success: true,
      configured: !!triggerId,
      projectId,
      triggerId: triggerId ? `${triggerId.substring(0, 8)}...` : null, // Partial for security
      consoleUrl: projectId ? `https://console.cloud.google.com/cloud-build/builds?project=${projectId}` : null
    });
  } catch (error) {
    logger.error('Failed to get cloud build config', {
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get cloud build config'
    });
  }
});

module.exports = router;
