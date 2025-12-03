// OWASP API Security Guidelines Implementation
const rateLimit = require('express-rate-limit');
const { logger } = require('../utils/logger');
const SecurityUtils = require('../utils/security');

// OWASP API1:2023 - Broken Object Level Authorization
function objectLevelAuth(req, res, next) {
  // Ensure users can only access their own resources
  const userId = req.user?.username;
  const requestedUserId = req.params.userId;

  if (requestedUserId && requestedUserId !== userId && req.user?.role !== 'admin') {
    logger.warn('Object level authorization violation', {
      user: userId,
      requestedUser: requestedUserId,
      endpoint: req.path
    });

    return res.status(403).json({
      success: false,
      error: 'Access denied: insufficient permissions'
    });
  }

  next();
}

// OWASP API2:2023 - Broken Authentication
function enhancedAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (token && !SecurityUtils.validateJWTStructure(token)) {
    logger.warn('Malformed JWT token', { ip: req.ip });
    return res.status(401).json({
      success: false,
      error: 'Invalid token format'
    });
  }

  next();
}

// OWASP API3:2023 - Broken Object Property Level Authorization
function propertyLevelAuth(allowedFields) {
  return (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const submittedFields = Object.keys(req.body || {});
      const unauthorizedFields = submittedFields.filter(field => !allowedFields.includes(field));

      if (unauthorizedFields.length > 0) {
        logger.warn('Property level authorization violation', {
          user: req.user?.username,
          unauthorizedFields,
          endpoint: req.path
        });

        return res.status(400).json({
          success: false,
          error: `Unauthorized fields: ${unauthorizedFields.join(', ')}`
        });
      }
    }

    next();
  };
}

// OWASP API4:2023 - Unrestricted Resource Consumption
const resourceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Limit each IP to 500 requests per windowMs (increased for dashboard usage)
  message: 'Too many requests from this IP',
  standardHeaders: true,
  legacyHeaders: false,
  // Enhanced key generator for Cloud Run with security validation
  keyGenerator: (req) => {
    let ip = req.ip; // This will be correct with trust proxy: 1

    const forwarded = req.get('X-Forwarded-For');
    if (forwarded) {
      // Extract first IP and validate format
      const firstIp = forwarded.split(',')[0].trim();
      // Remove port if present (handle IP:PORT format, but not IPv6 colons)
      const cleanIp = firstIp.includes('.') ? firstIp.replace(/:\d+$/, '') : firstIp;

      // Basic IP validation - allow IPv4 and any IPv6 format (including compressed)
      // IPv4: standard dotted notation
      // IPv6: contains colons, reasonable length, hex chars only
      const isValidIPv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(cleanIp);
      const isValidIPv6 = /^[0-9a-fA-F:]+$/.test(cleanIp) && cleanIp.includes(':') && cleanIp.length <= 45;

      if (isValidIPv4 || isValidIPv6) {
        ip = cleanIp;
      }
    }

    return ip || 'unknown';
  },
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });

    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded'
    });
  }
});

// Specific limiter for sensitive operations
const sensitiveOpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Very restrictive for admin operations
  message: 'Too many sensitive operations',
  skipSuccessfulRequests: true,
  // Enhanced key generator for Cloud Run with security validation
  keyGenerator: (req) => {
    let ip = req.ip; // This will be correct with trust proxy: 1

    const forwarded = req.get('X-Forwarded-For');
    if (forwarded) {
      // Extract first IP and validate format
      const firstIp = forwarded.split(',')[0].trim();
      // Remove port if present (handle IP:PORT format, but not IPv6 colons)
      const cleanIp = firstIp.includes('.') ? firstIp.replace(/:\d+$/, '') : firstIp;

      // Basic IP validation - allow IPv4 and any IPv6 format (including compressed)
      const isValidIPv4 = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(cleanIp);
      const isValidIPv6 = /^[0-9a-fA-F:]+$/.test(cleanIp) && cleanIp.includes(':') && cleanIp.length <= 45;

      if (isValidIPv4 || isValidIPv6) {
        ip = cleanIp;
      }
    }

    return ip || 'unknown';
  }
});

// OWASP API5:2023 - Broken Function Level Authorization
function functionLevelAuth(requiredRole) {
  return (req, res, next) => {
    const userRole = req.user?.role;

    if (!userRole || userRole !== requiredRole) {
      logger.warn('Function level authorization violation', {
        user: req.user?.username,
        userRole,
        requiredRole,
        endpoint: req.path
      });

      return res.status(403).json({
        success: false,
        error: 'Insufficient role privileges'
      });
    }

    next();
  };
}

// OWASP API6:2023 - Unrestricted Access to Sensitive Business Flows
function businessFlowProtection(req, res, next) {
  // Monitor for suspicious patterns
  const suspiciousPatterns = [
    /personality.*reset/i,
    /admin.*create/i,
    /password.*change/i
  ];

  const endpoint = req.path;
  const isSuspicious = suspiciousPatterns.some(pattern => pattern.test(endpoint));

  if (isSuspicious) {
    logger.info('Sensitive business flow accessed', {
      user: req.user?.username,
      endpoint,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  }

  next();
}

// OWASP API7:2023 - Server Side Request Forgery (SSRF)
function ssrfProtection(req, res, next) {
  // Check for potential SSRF in URL parameters or body
  const checkForSSRF = (obj) => {
    if (typeof obj === 'string') {
      // Block private IP ranges and localhost
      const dangerousPatterns = [
        /https?:\/\/127\./,
        /https?:\/\/localhost/,
        /https?:\/\/10\./,
        /https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./,
        /https?:\/\/192\.168\./,
        /file:\/\//,
        /ftp:\/\//
      ];

      return dangerousPatterns.some(pattern => pattern.test(obj));
    }

    if (typeof obj === 'object' && obj !== null) {
      return Object.values(obj).some(checkForSSRF);
    }

    return false;
  };

  if (checkForSSRF(req.body) || checkForSSRF(req.query)) {
    logger.warn('Potential SSRF attempt blocked', {
      ip: req.ip,
      endpoint: req.path
    });

    return res.status(400).json({
      success: false,
      error: 'Invalid URL detected'
    });
  }

  next();
}

// OWASP API8:2023 - Security Misconfiguration
function securityHeaders(req, res, next) {
  // Set security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', 'default-src \'self\'');

  // Remove server signature
  res.removeHeader('X-Powered-By');

  next();
}

// OWASP API9:2023 - Improper Inventory Management
function apiVersioning(req, res, next) {
  // Track API usage for inventory management
  logger.info('API endpoint accessed', {
    endpoint: req.path,
    method: req.method,
    version: req.headers['api-version'] || 'v1',
    userAgent: req.get('User-Agent')
  });

  next();
}

// OWASP API10:2023 - Unsafe Consumption of APIs
function outputValidation(req, res, next) {
  // Intercept response to validate output
  const originalSend = res.send;

  res.send = function(data) {
    try {
      // Don't mask tokens in auth login responses
      if ((req.path === '/login' || req.path === '/auth/login' || req.originalUrl.includes('/auth/login')) && req.method === 'POST') {
        return originalSend.call(this, data);
      }

      // Ensure no sensitive data is leaked in other responses
      if (typeof data === 'string') {
        const parsed = JSON.parse(data);
        const sanitized = SecurityUtils.maskSensitiveData(parsed);
        return originalSend.call(this, JSON.stringify(sanitized));
      }
    } catch {
      // If not JSON, send as-is
    }

    return originalSend.call(this, data);
  };

  next();
}

// Request size limiter
function requestSizeLimit(maxSize = '10mb') {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length']);

    if (contentLength > parseInt(maxSize) * 1024 * 1024) {
      logger.warn('Request size limit exceeded', {
        size: contentLength,
        limit: maxSize,
        ip: req.ip
      });

      return res.status(413).json({
        success: false,
        error: 'Request entity too large'
      });
    }

    next();
  };
}

// Audit logging middleware
function auditLogger(req, res, next) {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;

    // Log all modification operations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      logger.info('API modification audit', {
        user: req.user?.username,
        method: req.method,
        endpoint: req.path,
        statusCode: res.statusCode,
        duration,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
      });
    }
  });

  next();
}

module.exports = {
  objectLevelAuth,
  enhancedAuth,
  propertyLevelAuth,
  resourceLimiter,
  sensitiveOpLimiter,
  functionLevelAuth,
  businessFlowProtection,
  ssrfProtection,
  securityHeaders,
  apiVersioning,
  outputValidation,
  requestSizeLimit,
  auditLogger
};