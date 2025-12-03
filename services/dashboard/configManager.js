/**
 * ConfigManager Service
 *
 * Manages agent configuration stored in Firestore database.
 * Provides centralized access to configuration with caching and encryption support.
 *
 * Features:
 * - Database-driven configuration (eliminates hardcoded env vars)
 * - In-memory caching with TTL (1 minute default)
 * - Credential encryption/decryption
 * - Configuration sections: config, credentials, feature-flags, platforms, etc.
 * - Audit trail for all configuration changes
 *
 * Security:
 * - Credentials encrypted with AES-256-GCM before storage
 * - All updates logged with user ID and timestamp
 * - Cache invalidation on updates
 *
 * @module services/dashboard/configManager
 */

const { getFirestore, getFieldValue } = require('../../config/firestore');
const { logger } = require('../../utils/logger');
const { getEncryption } = require('../../utils/encryption');

class ConfigManager {
  constructor() {
    this.db = null;
    this.encryption = null;
    this.configCache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache TTL
    this.lastCacheUpdate = null;
    this.initialized = false;
  }

  /**
   * Initialize the ConfigManager service
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      this.db = getFirestore();
      this.encryption = getEncryption();

      // Load initial config into cache
      await this.loadAllConfig();

      this.initialized = true;
      logger.info('ConfigManager initialized', {
        cacheTTL: `${this.cacheTimeout / 1000}s`,
        encryptionEnabled: await this.encryption.isEnabledAsync()
      });
    } catch (error) {
      logger.error('ConfigManager initialization failed', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Load all configuration sections into cache
   */
  async loadAllConfig() {
    try {
      const sections = ['config', 'feature-flags', 'rbac', 'rate-limits'];

      for (const section of sections) {
        const doc = await this.db.collection('agent').doc(section).get();
        if (doc.exists) {
          this.configCache.set(section, doc.data());
        }
      }

      this.lastCacheUpdate = Date.now();
      logger.info('Config cache loaded', {
        sections: this.configCache.size
      });
    } catch (error) {
      logger.error('Failed to load config cache', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Refresh cache if needed (based on TTL)
   */
  async refreshCacheIfNeeded() {
    const now = Date.now();
    if (!this.lastCacheUpdate || (now - this.lastCacheUpdate) > this.cacheTimeout) {
      await this.loadAllConfig();
    }
  }

  /**
   * Get configuration value
   *
   * @param {string} section - Configuration section (config, feature-flags, etc.)
   * @param {string|null} key - Specific key to retrieve (null = entire section)
   * @returns {Promise<any>} Configuration value
   */
  async get(section, key = null) {
    if (!this.initialized) {
      await this.initialize();
    }

    await this.refreshCacheIfNeeded();

    const sectionData = this.configCache.get(section);
    if (!sectionData) {
      // Not in cache, try to load from Firestore
      const doc = await this.db.collection('agent').doc(section).get();
      if (!doc.exists) {
        return null;
      }

      const data = doc.data();
      this.configCache.set(section, data);

      if (key) {
        return data[key];
      }
      return data;
    }

    if (key) {
      return sectionData[key];
    }

    return sectionData;
  }

  /**
   * Get decrypted credential value
   *
   * @param {string} section - Configuration section
   * @param {string} key - Credential key
   * @returns {Promise<string>} Decrypted credential value
   */
  async getDecrypted(section, key) {
    const encrypted = await this.get(section, key);

    if (!encrypted) {
      return null;
    }

    // Check if it's encrypted
    if (typeof encrypted === 'string' && encrypted.startsWith('encrypted:')) {
      if (!await this.encryption.isEnabledAsync()) {
        throw new Error('Encryption key not configured. Cannot decrypt credentials.');
      }

      return await this.encryption.decryptCredential(encrypted);
    }

    // Not encrypted, return as-is
    return encrypted;
  }

  /**
   * Update configuration section
   *
   * @param {string} section - Configuration section
   * @param {Object} updates - Updates to apply
   * @param {string} userId - User making the change
   * @returns {Promise<boolean>} Success status
   */
  async update(section, updates, userId = 'system') {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const updateData = {
        ...updates,
        updatedAt: getFieldValue().serverTimestamp(),
        updatedBy: userId
      };

      await this.db.collection('agent').doc(section).set(updateData, { merge: true });

      // Update cache
      const currentData = this.configCache.get(section) || {};
      this.configCache.set(section, {
        ...currentData,
        ...updateData
      });

      logger.info('Config updated', {
        section,
        keys: Object.keys(updates),
        userId
      });

      return true;
    } catch (error) {
      logger.error('Failed to update config', {
        section,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update encrypted credential
   *
   * @param {string} key - Credential key
   * @param {string} value - Plaintext credential value
   * @param {string} userId - User making the change
   * @returns {Promise<boolean>} Success status
   */
  async updateCredential(key, value, userId = 'system') {
    if (!await this.encryption.isEnabledAsync()) {
      throw new Error('Encryption key not configured. Cannot encrypt credentials.');
    }

    const encrypted = await this.encryption.encryptCredential(value);
    return this.update('credentials', { [key]: encrypted }, userId);
  }

  /**
   * Get platform configuration
   *
   * @param {string} platformId - Platform ID (bitrix24, google-chat, asana)
   * @returns {Promise<Object|null>} Platform configuration
   */
  async getPlatform(platformId) {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const doc = await this.db
        .collection('agent')
        .doc('platforms')
        .collection(platformId)
        .doc('config')
        .get();

      return doc.exists ? doc.data() : null;
    } catch (error) {
      logger.error('Failed to get platform config', {
        platformId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Update platform configuration
   *
   * @param {string} platformId - Platform ID
   * @param {Object} updates - Updates to apply
   * @param {string} userId - User making the change
   * @returns {Promise<boolean>} Success status
   */
  async updatePlatform(platformId, updates, userId = 'system') {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const updateData = {
        ...updates,
        platformId,
        updatedAt: getFieldValue().serverTimestamp(),
        updatedBy: userId
      };

      await this.db
        .collection('agent')
        .doc('platforms')
        .collection(platformId)
        .doc('config')
        .set(updateData, { merge: true });

      logger.info('Platform config updated', {
        platformId,
        userId
      });

      return true;
    } catch (error) {
      logger.error('Failed to update platform config', {
        platformId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Check if setup wizard has been completed
   *
   * @returns {Promise<boolean>} Setup completion status
   */
  async isSetupComplete() {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const setupDoc = await this.db.collection('agent').doc('setup-status').get();
      return setupDoc.exists && setupDoc.data().completed === true;
    } catch (error) {
      logger.error('Failed to check setup status', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Mark setup wizard as complete
   *
   * @param {string} userId - User who completed setup
   * @returns {Promise<boolean>} Success status
   */
  async markSetupComplete(userId = 'system') {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      await this.db.collection('agent').doc('setup-status').set({
        completed: true,
        currentStep: 5,
        completedSteps: [1, 2, 3, 4, 5],
        setupCompletedAt: getFieldValue().serverTimestamp(),
        setupCompletedBy: userId
      });

      logger.info('Setup marked as complete', { userId });
      return true;
    } catch (error) {
      logger.error('Failed to mark setup complete', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Clear configuration cache
   */
  clearCache() {
    this.configCache.clear();
    this.lastCacheUpdate = null;
    logger.info('Config cache cleared');
  }

  /**
   * Get config with env var fallback
   * Used during migration from env vars to database
   *
   * @param {string} key - Config key
   * @param {string} envVar - Environment variable name
   * @param {any} defaultValue - Default value if not found
   * @returns {Promise<any>} Configuration value
   */
  async getWithFallback(key, envVar, defaultValue = null) {
    // Try database first
    const dbValue = await this.get('config', key);
    if (dbValue !== null && dbValue !== undefined) {
      return dbValue;
    }

    // Fall back to environment variable
    if (process.env[envVar]) {
      logger.warn('Using env var fallback for config', {
        key,
        envVar,
        note: 'Consider migrating to database'
      });
      return process.env[envVar];
    }

    // Return default
    return defaultValue;
  }
}

// Singleton instance
let configManager;

/**
 * Get ConfigManager singleton instance
 *
 * @returns {Promise<ConfigManager>} ConfigManager instance
 */
async function getConfigManager() {
  if (!configManager) {
    configManager = new ConfigManager();
    await configManager.initialize();
  }
  return configManager;
}

module.exports = { ConfigManager, getConfigManager };
