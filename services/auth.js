const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');

// Bcrypt work factor (2025 OWASP recommendation: 12-14 rounds)
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;

// JWT configuration loaded from Firestore
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

class AuthService {
  constructor() {
    this.db = null;
    this.jwtSecret = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {return;}

    this.db = getFirestore();

    // Load JWT_SECRET from Firestore (setup wizard stores it there)
    await this.loadJwtSecret();

    // Create default admin user if doesn't exist
    await this.createDefaultAdmin();

    this.initialized = true;
    logger.info('Auth service initialized');
  }

  async loadJwtSecret() {
    try {
      const configDoc = await this.db.collection('agent').doc('config').get();

      if (!configDoc.exists || !configDoc.data().jwtSecret) {
        throw new Error('JWT_SECRET not found in Firestore. Please run setup wizard at /setup');
      }

      this.jwtSecret = configDoc.data().jwtSecret;
      logger.info('JWT secret loaded from Firestore');
    } catch (error) {
      logger.error('Failed to load JWT secret from Firestore', {
        error: error.message
      });
      throw new Error('JWT_SECRET not configured. Please run setup wizard at /setup');
    }
  }

  async createDefaultAdmin() {
    try {
      // SECURITY: Check if ANY admin exists in the system
      // NEVER auto-create admin with hardcoded credentials
      const adminQuery = await this.db.collection('users')
        .where('role', '==', 'admin')
        .limit(1)
        .get();

      if (adminQuery.empty) {
        logger.warn('⚠️  SECURITY WARNING: No admin users found in system!', {
          message: 'Create admin user with: npm run admin:create',
          severity: 'critical',
          action_required: true
        });
        logger.warn('System will function but admin endpoints will be inaccessible');
        logger.warn('Run: npm run admin:create to create first admin user securely');
      } else {
        logger.info('Admin user exists in system', {
          adminCount: adminQuery.size
        });
      }
    } catch (error) {
      logger.error('Failed to check for admin users', error);
    }
  }

  async login(username, password) {
    try {
      // Get user from database
      const userDoc = await this.db.collection('users').doc(username).get();

      if (!userDoc.exists) {
        logger.warn('User not found', { username });
        return {
          success: false,
          error: 'Invalid credentials'
        };
      }

      const userData = userDoc.data();

      // CRITICAL DEBUG: Log user data structure
      logger.info('AUTH DEBUG - User data loaded', {
        username,
        hasPassword: !!userData.password,
        passwordLength: userData.password ? userData.password.length : 0,
        passwordPrefix: userData.password ? userData.password.substring(0, 10) : 'none',
        locked: userData.locked,
        failedAttempts: userData.failedAttempts,
        inputPasswordLength: password ? password.length : 0
      });

      // Check if account is locked
      if (userData.locked) {
        logger.warn('Account is locked', { username });
        return {
          success: false,
          error: 'Account is locked. Contact administrator.'
        };
      }

      // Verify password
      logger.info('AUTH DEBUG - About to compare passwords', { username });
      const isValid = await bcrypt.compare(password, userData.password);
      logger.info('AUTH DEBUG - Password comparison result', { username, isValid });

      if (!isValid) {
        logger.warn('Invalid password', { username });
        // Increment failed attempts
        await this.incrementFailedAttempts(username, userData.failedAttempts);

        return {
          success: false,
          error: 'Invalid credentials'
        };
      }

      // Reset failed attempts and update last login
      await this.db.collection('users').doc(username).update({
        failedAttempts: 0,
        lastLogin: getFieldValue().serverTimestamp()
      });

      // Generate JWT token
      // CRITICAL: Include 'id' field (username is the document ID in Firestore)
      const token = jwt.sign(
        {
          id: username, // Firestore document ID
          username: userData.username,
          email: userData.email,
          role: userData.role
        },
        this.jwtSecret,
        { expiresIn: JWT_EXPIRES_IN }
      );

      // Log successful login
      await this.logAuthEvent(username, 'login', true);

      return {
        success: true,
        token,
        user: {
          username: userData.username,
          email: userData.email,
          role: userData.role
        }
      };
    } catch (error) {
      logger.error('Login failed', { username, error: error.message });
      return {
        success: false,
        error: 'Authentication failed'
      };
    }
  }

  async changePassword(username, currentPassword, newPassword) {
    try {
      // Validate new password strength
      if (!this.validatePasswordStrength(newPassword)) {
        return {
          success: false,
          error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character'
        };
      }

      // Get user
      const userDoc = await this.db.collection('users').doc(username).get();

      if (!userDoc.exists) {
        return {
          success: false,
          error: 'User not found'
        };
      }

      const userData = userDoc.data();

      // Verify current password
      const isValid = await bcrypt.compare(currentPassword, userData.password);

      if (!isValid) {
        await this.logAuthEvent(username, 'password_change_failed', false);
        return {
          success: false,
          error: 'Current password is incorrect'
        };
      }

      // Hash new password with secure work factor
      const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

      // Update password
      await this.db.collection('users').doc(username).update({
        password: hashedPassword,
        passwordChangedAt: getFieldValue().serverTimestamp()
      });

      // Log password change
      await this.logAuthEvent(username, 'password_changed', true);

      return {
        success: true,
        message: 'Password changed successfully'
      };
    } catch (error) {
      logger.error('Password change failed', { username, error: error.message });
      return {
        success: false,
        error: 'Failed to change password'
      };
    }
  }

  async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.jwtSecret);
      return {
        valid: true,
        user: decoded
      };
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return {
          valid: false,
          error: 'Token expired'
        };
      }
      return {
        valid: false,
        error: 'Invalid token'
      };
    }
  }

  async incrementFailedAttempts(username, currentAttempts) {
    const newAttempts = currentAttempts + 1;
    const locked = newAttempts >= 5; // Lock after 5 failed attempts

    await this.db.collection('users').doc(username).update({
      failedAttempts: newAttempts,
      locked
    });

    if (locked) {
      await this.logAuthEvent(username, 'account_locked', false);
      logger.warn('Account locked due to failed attempts', { username });
    }
  }

  async logAuthEvent(username, event, success) {
    try {
      await this.db.collection('auth_logs').add({
        username,
        event,
        success,
        timestamp: getFieldValue().serverTimestamp(),
        ip: null // Would need to pass from request
      });
    } catch (error) {
      logger.error('Failed to log auth event', error);
    }
  }

  validatePasswordStrength(password) {
    // At least 8 characters, one uppercase, one lowercase, one number, one special character
    const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return regex.test(password);
  }

  async createUser(userData) {
    try {
      const { username, email, password, role = 'user' } = userData;

      // Check if user exists
      const existingUser = await this.db.collection('users').doc(username).get();
      if (existingUser.exists) {
        return {
          success: false,
          error: 'Username already exists'
        };
      }

      // Validate password
      if (!this.validatePasswordStrength(password)) {
        return {
          success: false,
          error: 'Password does not meet requirements'
        };
      }

      // Hash password with secure work factor
      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

      // Create user
      await this.db.collection('users').doc(username).set({
        username,
        email,
        password: hashedPassword,
        role,
        createdAt: getFieldValue().serverTimestamp(),
        lastLogin: null,
        failedAttempts: 0,
        locked: false
      });

      logger.info('User created', { username, role });

      return {
        success: true,
        message: 'User created successfully'
      };
    } catch (error) {
      logger.error('Failed to create user', error);
      return {
        success: false,
        error: 'Failed to create user'
      };
    }
  }

  async unlockUser(username) {
    try {
      await this.db.collection('users').doc(username).update({
        locked: false,
        failedAttempts: 0
      });

      await this.logAuthEvent(username, 'account_unlocked', true);

      return {
        success: true,
        message: 'User unlocked successfully'
      };
    } catch (error) {
      logger.error('Failed to unlock user', { username, error: error.message });
      return {
        success: false,
        error: 'Failed to unlock user'
      };
    }
  }
}

// Singleton instance
let authService;

async function initializeAuthService() {
  if (!authService) {
    authService = new AuthService();
    await authService.initialize();
  }
  return authService;
}

function getAuthService() {
  if (!authService) {
    throw new Error('Auth service not initialized');
  }
  return authService;
}

module.exports = {
  AuthService,
  initializeAuthService,
  getAuthService
};