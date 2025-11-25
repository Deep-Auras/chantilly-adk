const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../services/auth');
const { logger } = require('../utils/logger');
const SecurityUtils = require('../utils/security');

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Access token required'
    });
  }

  // Validate JWT structure before attempting verification
  if (!SecurityUtils.validateJWTStructure(token)) {
    logger.warn('Malformed JWT token attempt', {
      tokenPrefix: token.substring(0, 20) + '...',
      ip: req.ip
    });
    return res.status(401).json({
      success: false,
      error: 'Invalid token format'
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      logger.warn('Invalid token attempt', {
        error: err.message,
        ip: req.ip
      });

      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Token expired'
        });
      }

      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    // Validate user object structure
    if (!user || !user.username || !user.role) {
      logger.warn('Token missing required user data', {
        hasUser: !!user,
        hasUsername: !!(user && user.username),
        hasRole: !!(user && user.role),
        ip: req.ip
      });
      return res.status(401).json({
        success: false,
        error: 'Invalid token payload'
      });
    }

    req.user = user;
    next();
  });
}

// Middleware to check if user is admin
function requireAdmin(req, res, next) {
  // Ensure user exists and has been authenticated
  if (!req.user) {
    logger.warn('Admin endpoint accessed without authentication', {
      endpoint: req.path,
      ip: req.ip
    });
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  }

  // Check for admin role specifically
  if (req.user.role !== 'admin') {
    logger.warn('Function level authorization violation', {
      username: req.user.username,
      userRole: req.user.role,
      requiredRole: 'admin',
      endpoint: req.path
    });

    return res.status(403).json({
      success: false,
      error: 'Admin role required'
    });
  }

  // Log successful admin access for audit
  logger.info('Admin access granted', {
    username: req.user.username,
    endpoint: req.path,
    ip: req.ip
  });

  next();
}

// Middleware for rate limiting auth endpoints
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 9999, // DISABLED - High limit to effectively disable rate limiting
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      path: req.path
    });

    res.status(429).json({
      success: false,
      error: 'Too many attempts. Please try again later.'
    });
  }
});

// Middleware to sanitize user input
function sanitizeInput(req, res, next) {
  try {
    // Sanitize request body
    if (req.body) {
      req.body = SecurityUtils.sanitizeObject(req.body);
      SecurityUtils.limitMemoryUsage(req.body);
    }

    // Sanitize query parameters
    if (req.query) {
      req.query = SecurityUtils.sanitizeObject(req.query);
    }

    // Sanitize route parameters
    if (req.params) {
      req.params = SecurityUtils.sanitizeObject(req.params);
    }

    next();
  } catch (error) {
    logger.warn('Input sanitization failed', {
      error: error.message,
      ip: req.ip
    });

    res.status(400).json({
      success: false,
      error: 'Invalid input data'
    });
  }
}

// Middleware to verify JWT token (supports both API and session-based auth)
function verifyToken(req, res, next) {
  // Check session first (for dashboard)
  if (req.session && req.session.token && req.session.user) {
    logger.info('VERIFY_TOKEN - Checking session token', {
      path: req.path,
      method: req.method,
      sessionID: req.sessionID,
      hasToken: !!req.session.token,
      username: req.session.user?.username
    });

    // Verify session token
    jwt.verify(req.session.token, JWT_SECRET, (err, user) => {
      if (err) {
        // Session token expired, redirect to login
        logger.warn('Session token expired', {
          username: req.session.user.username,
          error: err.message,
          path: req.path
        });
        req.session.destroy();

        if (req.headers.accept?.includes('text/html')) {
          return res.redirect('/auth/login');
        }

        return res.status(401).json({
          success: false,
          error: 'Session expired'
        });
      }

      // Token valid, set req.user
      logger.info(`VERIFY_TOKEN - Session token valid: user = ${JSON.stringify(user)}`);
      req.user = user;
      logger.info(`VERIFY_TOKEN - req.user SET: req.user = ${JSON.stringify(req.user)}`);
      return next();
    });
  } else {
    // Fall back to Authorization header (for API)
    logger.info('VERIFY_TOKEN - No session found, checking Authorization header', {
      path: req.path,
      method: req.method,
      hasSession: !!req.session,
      hasSessionToken: !!(req.session && req.session.token),
      hasSessionUser: !!(req.session && req.session.user),
      sessionID: req.sessionID
    });

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      // No token found, redirect to login or return 401
      logger.warn('VERIFY_TOKEN - No token found', {
        path: req.path,
        hasAuthHeader: !!authHeader
      });

      if (req.headers.accept?.includes('text/html')) {
        return res.redirect('/auth/login');
      }

      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Validate JWT structure
    if (!SecurityUtils.validateJWTStructure(token)) {
      logger.warn('Malformed JWT token attempt', {
        tokenPrefix: token.substring(0, 20) + '...',
        ip: req.ip
      });

      if (req.headers.accept?.includes('text/html')) {
        return res.redirect('/auth/login');
      }

      return res.status(401).json({
        success: false,
        error: 'Invalid token format'
      });
    }

    // Verify token
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        logger.warn('Invalid token attempt', {
          error: err.message,
          ip: req.ip
        });

        if (req.headers.accept?.includes('text/html')) {
          return res.redirect('/auth/login');
        }

        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({
            success: false,
            error: 'Token expired'
          });
        }

        return res.status(401).json({
          success: false,
          error: 'Invalid token'
        });
      }

      // Validate user object structure
      if (!user || !user.username || !user.role) {
        logger.warn('Token missing required user data', {
          hasUser: !!user,
          hasUsername: !!(user && user.username),
          hasRole: !!(user && user.role),
          ip: req.ip
        });

        if (req.headers.accept?.includes('text/html')) {
          return res.redirect('/auth/login');
        }

        return res.status(401).json({
          success: false,
          error: 'Invalid token payload'
        });
      }

      req.user = user;
      next();
    });
  }
}

module.exports = {
  authenticateToken,
  verifyToken,
  requireAdmin,
  authLimiter,
  sanitizeInput
};