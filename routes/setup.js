/**
 * Setup Wizard Routes
 *
 * Handles first-time setup for new Cloud Run deployments.
 * Provides a web interface for:
 * - Creating the first admin user
 * - Configuring agent identity
 * - Initializing database configuration
 *
 * Security:
 * - Only accessible when no admin user exists
 * - Automatically disabled after setup completes
 * - Password validation enforced
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { logger } = require('../utils/logger');
const { getFirestore, getFieldValue } = require('../config/firestore');

const router = express.Router();

/**
 * Check if setup is needed
 */
async function isSetupNeeded() {
  try {
    const db = getFirestore();

    // Check for admin user
    const adminQuery = await db.collection('users')
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (!adminQuery.empty) {
      return false;
    }

    // Check for configuration
    const configDoc = await db.collection('agent').doc('config').get();
    if (configDoc.exists && configDoc.data().setupCompleted) {
      return false;
    }

    return true;
  } catch (error) {
    logger.error('Error checking setup status', { error: error.message });
    // Assume setup is needed if we can't check
    return true;
  }
}

/**
 * Validate password strength
 */
function validatePasswordStrength(password, username = '', email = '') {
  const errors = [];

  // Minimum length
  if (password.length < 12) {
    errors.push('Password must be at least 12 characters');
  }

  // Check for common passwords
  const commonPasswords = [
    'password123', 'admin123', 'letmein', '123456789',
    'qwerty123', 'password1', 'welcome123', 'administrator',
    'Password1234'
  ];

  if (commonPasswords.some(common => password.toLowerCase().includes(common.toLowerCase()))) {
    errors.push('Password is too common');
  }

  // Check if password contains username
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    errors.push('Password must not contain username');
  }

  // Check if password contains email prefix
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    errors.push('Password must not contain email');
  }

  // Character diversity
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z\d]/.test(password);

  const categoryCount = [hasLowercase, hasUppercase, hasDigit, hasSpecial].filter(Boolean).length;

  if (categoryCount < 3) {
    errors.push('Password must contain at least 3 of: lowercase, uppercase, numbers, special characters');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * GET /setup - Show setup wizard page
 */
router.get('/', async (req, res) => {
  try {
    const setupNeeded = await isSetupNeeded();

    if (!setupNeeded) {
      logger.info('Setup already completed, redirecting to dashboard');
      return res.redirect('/dashboard');
    }

    res.render('setup');
  } catch (error) {
    logger.error('Error rendering setup page', { error: error.message, stack: error.stack });
    res.status(500).send('Error loading setup wizard');
  }
});

/**
 * POST /setup/complete - Complete setup wizard
 */
router.post('/complete', express.json(), async (req, res) => {
  try {
    // Verify setup is still needed
    const setupNeeded = await isSetupNeeded();

    if (!setupNeeded) {
      return res.status(400).json({
        success: false,
        message: 'Setup has already been completed'
      });
    }

    const { username, email, password, agentName, geminiApiKey, geminiModel } = req.body;

    // Validate required fields
    if (!username || !email || !password || !agentName || !geminiApiKey || !geminiModel) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Validate username
    if (username.length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Username must be at least 3 characters'
      });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username can only contain letters, numbers, hyphens, and underscores'
      });
    }

    // Validate email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email address'
      });
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password, username, email);
    if (!passwordValidation.valid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.errors[0] // Return first error
      });
    }

    // Validate agent name
    if (agentName.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Agent name must be at least 2 characters'
      });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(agentName)) {
      return res.status(400).json({
        success: false,
        message: 'Agent name can only contain letters, numbers, hyphens, and underscores'
      });
    }

    // Validate Gemini API key
    if (!geminiApiKey.startsWith('AIza')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Gemini API key format'
      });
    }

    if (geminiApiKey.length < 39) {
      return res.status(400).json({
        success: false,
        message: 'Gemini API key appears to be incomplete'
      });
    }

    const db = getFirestore();

    // Check if username already exists
    const existingUser = await db.collection('users').doc(username).get();
    if (existingUser.exists) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists'
      });
    }

    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 12);

    await db.collection('users').doc(username).set({
      username,
      email,
      password: hashedPassword,
      role: 'admin',
      createdAt: getFieldValue().serverTimestamp(),
      createdBy: 'setup-wizard',
      lastLogin: null,
      failedAttempts: 0,
      locked: false,
      mustChangePassword: false
    });

    logger.info('Admin user created via setup wizard', { username, email });

    // Initialize agent configuration
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    const jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

    await db.collection('agent').doc('config').set({
      AGENT_NAME: agentName,
      GEMINI_API_KEY: geminiApiKey,
      GEMINI_MODEL: geminiModel,
      sessionSecret,
      jwtSecret,
      setupCompleted: true,
      setupDate: getFieldValue().serverTimestamp(),
      version: '1.0.0'
    }, { merge: true });

    logger.info('Agent configuration initialized', {
      agentName,
      geminiModel,
      hasGeminiKey: true
    });

    // Initialize platform configurations
    const platforms = [
      { id: 'bitrix24', name: 'Bitrix24', enabled: false },
      { id: 'googleChat', name: 'Google Chat', enabled: false },
      { id: 'asana', name: 'Asana', enabled: false },
      { id: 'bluesky', name: 'Bluesky', enabled: false },
      { id: 'webChat', name: 'Web Chat', enabled: true }
    ];

    for (const platform of platforms) {
      await db.collection('platform-settings').doc(platform.id).set({
        name: platform.name,
        enabled: platform.enabled,
        createdAt: getFieldValue().serverTimestamp()
      }, { merge: true });
    }

    logger.info('Platform configurations initialized');

    // Success response
    res.json({
      success: true,
      message: 'Setup completed successfully',
      agentName
    });

    logger.info('Setup wizard completed successfully', {
      username,
      agentName,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error completing setup', {
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Setup failed: ' + error.message
    });
  }
});

/**
 * GET /setup/status - Check if setup is needed (API endpoint)
 */
router.get('/status', async (_req, res) => {
  try {
    const setupNeeded = await isSetupNeeded();

    res.json({
      setupNeeded,
      setupCompleted: !setupNeeded
    });
  } catch (error) {
    logger.error('Error checking setup status', { error: error.message });
    res.status(500).json({
      error: 'Failed to check setup status'
    });
  }
});

module.exports = router;
module.exports.isSetupNeeded = isSetupNeeded;
