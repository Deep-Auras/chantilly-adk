/**
 * Encryption Utilities
 *
 * Provides AES-256-GCM encryption/decryption for sensitive data storage.
 * Used for encrypting all credentials: Bluesky JWT tokens, platform API keys,
 * webhook URLs, service account credentials, etc.
 *
 * Security:
 * - AES-256-GCM authenticated encryption (prevents tampering)
 * - Random IV for each encryption (no IV reuse)
 * - Authentication tag verification on decrypt
 *
 * @module utils/encryption
 */

const crypto = require('crypto');
const { logger } = require('./logger');

/**
 * Encryption service using AES-256-GCM
 * Loads encryption key from Firestore (agent/config/credentialEncryptionKey)
 */
class Encryption {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.key = null;
    this.initialized = false;
    this.initPromise = null;
  }

  /**
   * Initialize encryption key from Firestore
   * Called lazily on first use
   */
  async _ensureInitialized() {
    if (this.initialized) {
      return;
    }

    // Prevent multiple concurrent initializations
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this._loadKeyFromFirestore();
    await this.initPromise;
  }

  async _loadKeyFromFirestore() {
    try {
      const { getFirestore } = require('../config/firestore');
      const db = getFirestore();
      const configDoc = await db.collection('agent').doc('config').get();

      if (!configDoc.exists) {
        logger.warn('agent/config not found, encryption disabled');
        this.initialized = true;
        return;
      }

      // Support both field names for backwards compatibility
      const data = configDoc.data();
      const keyBase64 = data.CREDENTIAL_ENCRYPTION_KEY || data.credentialEncryptionKey;
      if (!keyBase64) {
        logger.warn('CREDENTIAL_ENCRYPTION_KEY not set in Firestore, encryption disabled');
        this.initialized = true;
        return;
      }

      this.key = Buffer.from(keyBase64, 'base64');

      // Validate key length (must be 32 bytes for AES-256)
      if (this.key.length !== 32) {
        throw new Error(`Invalid key length: ${this.key.length} bytes (expected 32)`);
      }

      logger.info('Encryption initialized from Firestore', { algorithm: this.algorithm });
      this.initialized = true;
    } catch (error) {
      logger.error('Failed to initialize encryption from Firestore', { error: error.message });
      this.key = null;
      this.initialized = true;
    }
  }

  /**
   * Check if encryption is enabled (sync check after initialization)
   * @returns {boolean}
   */
  isEnabled() {
    return this.key !== null;
  }

  /**
   * Check if encryption is enabled (async, ensures initialization)
   * @returns {Promise<boolean>}
   */
  async isEnabledAsync() {
    await this._ensureInitialized();
    return this.key !== null;
  }

  /**
   * Encrypt text using AES-256-GCM
   *
   * @param {string} text - Plaintext to encrypt
   * @returns {Promise<Object>} Encrypted data object with iv, encrypted, authTag
   * @throws {Error} If encryption fails or key not set
   */
  async encrypt(text) {
    await this._ensureInitialized();

    if (!this.isEnabled()) {
      throw new Error('Encryption key not configured. Set credentialEncryptionKey in Firestore agent/config.');
    }

    if (!text || typeof text !== 'string') {
      throw new Error('Text to encrypt must be a non-empty string');
    }

    try {
      // Generate random IV (12 bytes recommended for GCM)
      const iv = crypto.randomBytes(12);

      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

      // Encrypt
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Get authentication tag
      const authTag = cipher.getAuthTag();

      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      logger.error('Encryption failed', { error: error.message });
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt AES-256-GCM encrypted data
   *
   * @param {Object} encryptedData - Object with encrypted, iv, authTag properties
   * @param {string} encryptedData.encrypted - Encrypted hex string
   * @param {string} encryptedData.iv - Initialization vector (hex)
   * @param {string} encryptedData.authTag - Authentication tag (hex)
   * @returns {Promise<string>} Decrypted plaintext
   * @throws {Error} If decryption fails (wrong key, tampered data, etc.)
   */
  async decrypt(encryptedData) {
    await this._ensureInitialized();

    if (!this.isEnabled()) {
      throw new Error('Encryption key not configured. Set credentialEncryptionKey in Firestore agent/config.');
    }

    if (!encryptedData || typeof encryptedData !== 'object') {
      throw new Error('Invalid encrypted data object');
    }

    const { encrypted, iv, authTag } = encryptedData;

    if (!encrypted || !iv || !authTag) {
      throw new Error('Encrypted data missing required fields (encrypted, iv, authTag)');
    }

    try {
      // Create decipher
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.key,
        Buffer.from(iv, 'hex')
      );

      // Set authentication tag (verifies data not tampered with)
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));

      // Decrypt
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      logger.error('Decryption failed', { error: error.message });
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  /**
   * Generate a new encryption key (32 bytes base64-encoded)
   * Use this to generate CREDENTIAL_ENCRYPTION_KEY value
   *
   * @returns {string} Base64-encoded 32-byte key
   */
  static generateKey() {
    return crypto.randomBytes(32).toString('base64');
  }

  /**
   * Encrypt credential for dashboard storage
   * Returns string format: "encrypted:AES256:iv:authTag:ciphertext"
   *
   * @param {string} plaintext - Credential to encrypt
   * @returns {Promise<string>} Encrypted credential string
   */
  async encryptCredential(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new Error('Credential must be a non-empty string');
    }

    const { encrypted, iv, authTag } = await this.encrypt(plaintext);
    return `encrypted:AES256:${iv}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypt credential from dashboard storage
   * Accepts string format: "encrypted:AES256:iv:authTag:ciphertext"
   *
   * @param {string} encryptedString - Encrypted credential string
   * @returns {Promise<string>} Decrypted plaintext
   */
  async decryptCredential(encryptedString) {
    if (!encryptedString || typeof encryptedString !== 'string') {
      throw new Error('Encrypted credential must be a non-empty string');
    }

    // Check if it's encrypted
    if (!encryptedString.startsWith('encrypted:AES256:')) {
      // Not encrypted, return as-is (for backward compatibility)
      return encryptedString;
    }

    // Parse format: encrypted:AES256:iv:authTag:ciphertext
    const parts = encryptedString.split(':');
    if (parts.length !== 5) {
      throw new Error('Invalid encrypted credential format');
    }

    const [, , iv, authTag, encrypted] = parts;

    return await this.decrypt({ encrypted, iv, authTag });
  }
}

// Singleton instance
let instance = null;

/**
 * Get encryption service instance
 * @returns {Encryption}
 */
function getEncryption() {
  if (!instance) {
    instance = new Encryption();
  }
  return instance;
}

module.exports = { Encryption, getEncryption };
