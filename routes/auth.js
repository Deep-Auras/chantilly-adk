const express = require('express');
const router = express.Router();
const joi = require('joi');
const { getAuthService } = require('../services/auth');
const { authLimiter, authenticateToken, sanitizeInput } = require('../middleware/auth');
const { logger } = require('../utils/logger');

// Validation schemas
const loginSchema = joi.object({
  username: joi.string().alphanum().min(3).max(30).required(),
  password: joi.string().min(6).required()
}).unknown(true); // Allow CSRF token and other fields

const changePasswordSchema = joi.object({
  currentPassword: joi.string().required(),
  newPassword: joi.string().min(8).required()
});

const createUserSchema = joi.object({
  username: joi.string().alphanum().min(3).max(30).required(),
  email: joi.string().email().required(),
  password: joi.string().min(8).required(),
  role: joi.string().valid('admin', 'user').default('user')
});

// Apply rate limiting and input sanitization to all auth routes
router.use(authLimiter);
router.use(sanitizeInput);

// CSRF token generation for forms
router.use((req, res, next) => {
  // Check if session is initialized (handles race condition during startup)
  if (!req.session) {
    logger.warn('Session not initialized yet, waiting...');
    return res.status(503).send('Service starting up, please wait a moment and refresh.');
  }

  if (!req.session.csrfToken) {
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  next();
});

// Login page (GET)
router.get('/login', (req, res) => {
  res.render('auth/login');
});

// Login endpoint (supports both JSON API and form submission)
router.post('/login', async (req, res) => {
  try {
    logger.info('LOGIN ROUTE - Request received', {
      body: req.body,
      contentType: req.headers['content-type'],
      hasUsername: !!req.body.username,
      hasPassword: !!req.body.password
    });

    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      logger.warn('LOGIN ROUTE - Validation failed', { error: error.details[0].message });
      // Form submission - redirect with error
      if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
        req.flash('error', error.details[0].message);
        return res.redirect('/auth/login');
      }
      // JSON API - return error
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { username, password } = value;
    logger.info('LOGIN ROUTE - Validation passed, calling auth service', { username });
    const authService = getAuthService();
    const result = await authService.login(username, password);
    logger.info('LOGIN ROUTE - Auth service returned', { success: result.success, username });

    if (result.success) {
      logger.info('Successful login', { username });

      // Form submission - set session and redirect to dashboard
      // Check both Content-Type AND Accept headers to detect form submission
      const isFormSubmission = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ||
                               req.headers['content-type']?.includes('multipart/form-data') ||
                               req.headers.accept?.includes('text/html');

      if (isFormSubmission) {
        req.session.token = result.token;
        req.session.user = result.user;

        // CRITICAL DEBUG: Log session after setting
        logger.info('LOGIN SUCCESS - Session set', {
          sessionID: req.sessionID,
          hasToken: !!req.session.token,
          hasUser: !!req.session.user,
          username: req.session.user?.username,
          cookieSecure: req.session.cookie.secure,
          cookieHttpOnly: req.session.cookie.httpOnly,
          cookieMaxAge: req.session.cookie.maxAge
        });

        return res.redirect('/dashboard');
      }

      // JSON API - return token
      res.json(result);
    } else {
      logger.warn('Failed login attempt', { username, error: result.error });

      // Form submission - redirect with error
      if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
        req.flash('error', result.error || 'Invalid credentials');
        return res.redirect('/auth/login');
      }

      // JSON API - return error
      res.status(401).json(result);
    }
  } catch (error) {
    logger.error('Login error', error);

    // Form submission - redirect with error
    if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      req.flash('error', 'Authentication failed');
      return res.redirect('/auth/login');
    }

    // JSON API - return error
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
});

// Change password endpoint (protected)
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { error, value } = changePasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { currentPassword, newPassword } = value;
    const authService = getAuthService();

    const result = await authService.changePassword(
      req.user.username,
      currentPassword,
      newPassword
    );

    if (result.success) {
      logger.info('Password changed', { username: req.user.username });
    }

    res.json(result);
  } catch (error) {
    logger.error('Password change error', { username: req.user.username, error });
    res.status(500).json({
      success: false,
      error: 'Failed to change password'
    });
  }
});

// Create user endpoint (admin only)
router.post('/create-user', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { error, value } = createUserSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const authService = getAuthService();
    const result = await authService.createUser(value);

    if (result.success) {
      logger.info('User created', {
        createdBy: req.user.username,
        newUser: value.username
      });
    }

    res.json(result);
  } catch (error) {
    logger.error('User creation error', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create user'
    });
  }
});

// Unlock user endpoint (admin only)
router.post('/unlock-user', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Username required'
      });
    }

    const authService = getAuthService();
    const result = await authService.unlockUser(username);

    if (result.success) {
      logger.info('User unlocked', {
        unlockedBy: req.user.username,
        unlockedUser: username
      });
    }

    res.json(result);
  } catch (error) {
    logger.error('User unlock error', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unlock user'
    });
  }
});

// Verify token endpoint
router.post('/verify', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: req.user,
    message: 'Token is valid'
  });
});

// Get current user info
router.get('/me', authenticateToken, (req, res) => {
  res.json({
    success: true,
    user: {
      username: req.user.username,
      email: req.user.email,
      role: req.user.role
    }
  });
});

// Logout endpoint (supports both JSON API and form submission)
router.post('/logout', (req, res) => {
  const username = req.user?.username || req.session?.user?.username || 'unknown';
  logger.info('User logged out', { username });

  // Clear session
  req.session.destroy((err) => {
    if (err) {
      logger.error('Session destruction error', { error: err.message });
    }

    // Form submission - redirect to login
    if (req.headers['content-type']?.includes('application/x-www-form-urlencoded') ||
        req.headers.accept?.includes('text/html')) {
      return res.redirect('/auth/login');
    }

    // JSON API - return success
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  });
});

module.exports = router;