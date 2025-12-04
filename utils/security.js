const crypto = require('crypto');

// Security utilities to prevent common vulnerabilities

class SecurityUtils {
  // Prevent timing attacks in string comparison
  static timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }

    if (a.length !== b.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  // Sanitize input to prevent XSS and injection attacks
  static sanitizeString(input) {
    if (typeof input !== 'string') {
      return input;
    }

    // HTML encode dangerous characters
    const sanitized = input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;')
      // Remove null bytes
      .replace(/\0/g, '')
      // Remove script tags (additional layer)
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove javascript: protocol
      .replace(/javascript:/gi, '')
      // Remove data: protocol with script
      .replace(/data:text\/html/gi, '')
      // Remove vbscript: protocol
      .replace(/vbscript:/gi, '')
      // Remove on* event handlers
      .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/\son\w+\s*=/gi, '')
      // Remove SQL injection patterns
      .replace(/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|CREATE|ALTER|EXEC|EXECUTE)\b)/gi, '')
      // Remove potential path traversal
      .replace(/\.\.\//g, '')
      .replace(/\.\.\\/, '')
      // Limit length to prevent DoS
      .substring(0, 10000);

    return sanitized;
  }

  // Fields that should NOT be sanitized (passwords are hashed, not displayed)
  static SKIP_SANITIZE_FIELDS = ['password', 'currentPassword', 'newPassword', 'confirmPassword'];

  // Deep sanitize objects recursively
  static sanitizeObject(obj, maxDepth = 10) {
    if (maxDepth <= 0) {
      return null; // Prevent infinite recursion
    }

    if (obj === null || typeof obj !== 'object') {
      return this.sanitizeString(obj);
    }

    if (Array.isArray(obj)) {
      return obj.slice(0, 1000).map(item => this.sanitizeObject(item, maxDepth - 1));
    }

    const sanitized = {};
    let keyCount = 0;

    for (const [key, value] of Object.entries(obj)) {
      if (keyCount >= 1000) {break;} // Prevent DoS with large objects

      const sanitizedKey = this.sanitizeString(key);

      // Skip sanitization for password fields - they are hashed, never displayed
      if (this.SKIP_SANITIZE_FIELDS.includes(key)) {
        sanitized[sanitizedKey] = value;
      } else {
        sanitized[sanitizedKey] = this.sanitizeObject(value, maxDepth - 1);
      }
      keyCount++;
    }

    return sanitized;
  }

  // Validate and sanitize file paths
  static sanitizePath(path) {
    if (typeof path !== 'string') {
      return '';
    }

    return path
      .replace(/\.\./g, '') // Remove path traversal
      .replace(/[<>:"|?*]/g, '') // Remove invalid filename chars
      .replace(/\0/g, '') // Remove null bytes
      .substring(0, 255); // Limit length
  }

  // Generate secure random token
  static generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  // Hash sensitive data
  static hashSensitiveData(data, salt = null) {
    const actualSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(data, actualSalt, 10000, 64, 'sha512').toString('hex');
    return `${actualSalt}:${hash}`;
  }

  // Verify hashed data
  static verifyHashedData(data, hashedData) {
    const [salt, hash] = hashedData.split(':');
    const verifyHash = crypto.pbkdf2Sync(data, salt, 10000, 64, 'sha512').toString('hex');
    return this.timingSafeEqual(hash, verifyHash);
  }

  // Rate limiting helper
  static createRateLimitKey(ip, endpoint) {
    return `rate_limit:${ip}:${endpoint}`;
  }

  // Validate JWT token structure (basic validation)
  static validateJWTStructure(token) {
    if (typeof token !== 'string') {
      return false;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    // Check if each part is valid base64
    try {
      parts.forEach(part => {
        Buffer.from(part, 'base64');
      });
      return true;
    } catch {
      return false;
    }
  }

  // Mask sensitive data for logging
  static maskSensitiveData(obj, sensitiveFields = ['password', 'token', 'secret', 'key']) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    const masked = { ...obj };

    for (const field of sensitiveFields) {
      if (masked[field]) {
        masked[field] = '***MASKED***';
      }
    }

    return masked;
  }

  // Prevent prototype pollution
  static isValidKey(key) {
    return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
  }

  // Safe JSON parse
  static safeJSONParse(str, defaultValue = null) {
    try {
      const parsed = JSON.parse(str);
      return this.sanitizeObject(parsed);
    } catch {
      return defaultValue;
    }
  }

  // Memory usage protection
  static limitMemoryUsage(obj, maxSize = 1000000) { // 1MB default
    const str = JSON.stringify(obj);
    if (str.length > maxSize) {
      throw new Error('Object too large, potential DoS attack');
    }
    return obj;
  }
}

module.exports = SecurityUtils;