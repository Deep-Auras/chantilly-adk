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
 */
class Encryption {
  constructor() {
    this.algorithm = 'aes-256-gcm';

    // Load encryption key from environment
    const keyBase64 = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!keyBase64) {
      logger.warn('CREDENTIAL_ENCRYPTION_KEY not set, encryption disabled');
      this.key = null;
    } else {
      try {
        this.key = Buffer.from(keyBase64, 'base64');

        // Validate key length (must be 32 bytes for AES-256)
        if (this.key.length !== 32) {
          throw new Error(`Invalid key length: ${this.key.length} bytes (expected 32)`);
        }

        logger.info('Encryption initialized', { algorithm: this.algorithm });
      } catch (error) {
        logger.error('Failed to initialize encryption', { error: error.message });
        this.key = null;
      }
    }
  }

  /**
   * Check if encryption is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.key !== null;
  }

  /**
   * Encrypt text using AES-256-GCM
   *
   * @param {string} text - Plaintext to encrypt
   * @returns {Object} Encrypted data object with iv, encrypted, authTag
   * @throws {Error} If encryption fails or key not set
   */
  encrypt(text) {
    if (!this.isEnabled()) {
      throw new Error('Encryption key not configured. Set CREDENTIAL_ENCRYPTION_KEY environment variable.');
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
   * @returns {string} Decrypted plaintext
   * @throws {Error} If decryption fails (wrong key, tampered data, etc.)
   */
  decrypt(encryptedData) {
    if (!this.isEnabled()) {
      throw new Error('Encryption key not configured. Set CREDENTIAL_ENCRYPTION_KEY environment variable.');
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
   * @returns {string} Encrypted credential string
   */
  encryptCredential(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new Error('Credential must be a non-empty string');
    }

    const { encrypted, iv, authTag } = this.encrypt(plaintext);
    return `encrypted:AES256:${iv}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypt credential from dashboard storage
   * Accepts string format: "encrypted:AES256:iv:authTag:ciphertext"
   *
   * @param {string} encryptedString - Encrypted credential string
   * @returns {string} Decrypted plaintext
   */
  decryptCredential(encryptedString) {
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

    return this.decrypt({ encrypted, iv, authTag });
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
