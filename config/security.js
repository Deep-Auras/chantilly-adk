// Enhanced security configuration following OWASP guidelines
const config = require('./env');

// Security headers configuration
const securityHeaders = {
  // Content Security Policy
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      scriptSrc: ['\'self\'', '\'unsafe-inline\''], // Minimal inline scripts
      styleSrc: ['\'self\'', '\'unsafe-inline\''],
      imgSrc: ['\'self\'', 'data:', 'https:'],
      connectSrc: ['\'self\'', 'https://firestore.googleapis.com', 'https://generativelanguage.googleapis.com'],
      fontSrc: ['\'self\''],
      objectSrc: ['\'none\''],
      mediaSrc: ['\'self\''],
      frameSrc: ['\'none\''],
      baseUri: ['\'self\''],
      formAction: ['\'self\''],
      upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null
    }
  },

  // HTTP Strict Transport Security
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },

  // Frame options
  frameguard: {
    action: 'deny'
  },

  // Content type sniffing prevention
  noSniff: true,

  // XSS protection
  xssFilter: true,

  // Referrer policy
  referrerPolicy: 'strict-origin-when-cross-origin',

  // Cross-origin resource sharing
  // CORS allows all origins - dashboard/API are same-origin on Cloud Run,
  // and webhooks are server-to-server (no CORS needed)
  cors: {
    origin: true, // Allow all origins
    credentials: true,
    maxAge: 86400, // 24 hours
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'X-API-Version'
    ]
  }
};

// Rate limiting configuration
const rateLimits = {
  // General API rate limit
  general: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // requests per window
    message: 'Too many requests from this IP',
    standardHeaders: true,
    legacyHeaders: false
  },

  // Authentication endpoints
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // requests per window
    message: 'Too many authentication attempts',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true
  },

  // Sensitive operations
  sensitive: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // requests per window
    message: 'Too many sensitive operations',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true
  },

  // Password operations
  password: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // requests per window
    message: 'Too many password change attempts',
    standardHeaders: true,
    legacyHeaders: false
  }
};

// Input validation patterns
const validation = {
  // Dangerous patterns to block
  dangerousPatterns: [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, // Script tags
    /javascript:/gi, // JavaScript protocol
    /vbscript:/gi, // VBScript protocol
    /data:text\/html/gi, // Data URL with HTML
    /on\w+\s*=/gi, // Event handlers
    /<iframe\b[^>]*>/gi, // Iframe tags
    /<object\b[^>]*>/gi, // Object tags
    /<embed\b[^>]*>/gi, // Embed tags
    /<applet\b[^>]*>/gi // Applet tags
  ],

  // SQL injection patterns
  sqlPatterns: [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE)\b)/gi,
    /(UNION\s+SELECT)/gi,
    /(\bOR\s+1\s*=\s*1\b)/gi,
    /(\bAND\s+1\s*=\s*1\b)/gi,
    /(--|\#|\/\*|\*\/)/gi
  ],

  // File path traversal patterns
  pathTraversalPatterns: [
    /\.\.[\/\\]/g, // Directory traversal
    /[\/\\]\.\.[\/\\]/g, // Path traversal
    /\%2e\%2e[\/\\]/gi, // Encoded traversal
    /\%252e\%252e[\/\\]/gi // Double encoded traversal
  ],

  // SSRF protection patterns
  ssrfPatterns: [
    /^https?:\/\/127\./,
    /^https?:\/\/localhost/,
    /^https?:\/\/10\./,
    /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./,
    /^https?:\/\/192\.168\./,
    /^file:\/\//,
    /^ftp:\/\//,
    /^gopher:\/\//,
    /^dict:\/\//
  ]
};

// Security monitoring configuration
const monitoring = {
  // Security events to log
  securityEvents: {
    authFailure: 'auth_failure',
    rateLimitExceeded: 'rate_limit_exceeded',
    suspiciousInput: 'suspicious_input',
    unauthorizedAccess: 'unauthorized_access',
    privilegeEscalation: 'privilege_escalation',
    dataExfiltration: 'data_exfiltration',
    accountLockout: 'account_lockout',
    passwordBreach: 'password_breach'
  },

  // Alert thresholds
  alertThresholds: {
    failedLoginAttempts: 5,
    rateLimitViolations: 10,
    suspiciousRequests: 20,
    privilegeEscalationAttempts: 1
  }
};

// File upload security (if needed)
const fileUpload = {
  // Allowed file types
  allowedMimeTypes: [
    'text/plain',
    'application/json',
    'image/png',
    'image/jpeg',
    'image/gif'
  ],

  // Maximum file size (10MB)
  maxFileSize: 10 * 1024 * 1024,

  // File name sanitization
  sanitizeFileName: (filename) => {
    return filename
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/^\.+/, '')
      .substring(0, 255);
  }
};

module.exports = {
  securityHeaders,
  rateLimits,
  validation,
  monitoring,
  fileUpload
};