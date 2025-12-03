/**
 * Path Validation Utility for Build Mode Tools
 * Prevents path traversal attacks in file operations
 */

const { logger } = require('../utils/logger');

/**
 * Validates a file path to prevent path traversal attacks
 * @param {string} filePath - The file path to validate
 * @returns {boolean} True if path is safe, false otherwise
 */
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
      logger.warn('Path traversal attempt blocked in tool', { filePath });
      return false;
    }
  }

  // Normalize and ensure path stays within repo
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  return !normalized.startsWith('/') && !normalized.includes('../');
}

/**
 * Validates a directory path
 * @param {string} dirPath - The directory path to validate
 * @returns {boolean} True if path is safe, false otherwise
 */
function isValidDirPath(dirPath) {
  // Empty path is valid (represents root)
  if (!dirPath || dirPath === '' || dirPath === '/') {
    return true;
  }

  return isValidFilePath(dirPath);
}

/**
 * Sanitizes a file path by removing leading/trailing slashes and normalizing
 * @param {string} filePath - The file path to sanitize
 * @returns {string} Sanitized file path
 */
function sanitizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return '';
  }

  return filePath
    .replace(/\\/g, '/')           // Normalize slashes
    .replace(/\/+/g, '/')          // Remove duplicate slashes
    .replace(/^\/+/, '')           // Remove leading slashes
    .replace(/\/+$/, '');          // Remove trailing slashes
}

module.exports = {
  isValidFilePath,
  isValidDirPath,
  sanitizePath
};
