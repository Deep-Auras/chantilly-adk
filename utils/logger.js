const winston = require('winston');
const config = require('../config/env');

// Create base logger configuration with defaults
// LOG_LEVEL and SERVICE_NAME can be optionally set via env vars
// but have sensible defaults for zero-config deployment
const loggerConfig = {
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: process.env.SERVICE_NAME || 'chantilly-agent',
    environment: config.NODE_ENV
  },
  transports: []
};

// Add console transport for local development
if (config.NODE_ENV !== 'production') {
  loggerConfig.transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  );
} else {
  // In production, use structured logging for Cloud Logging
  loggerConfig.transports.push(
    new winston.transports.Console({
      format: winston.format.json()
    })
  );
}

// Add Cloud Logging transport if enabled (optional env var, defaults to enabled in production)
const useCloudLogging = process.env.USE_CLOUD_LOGGING !== 'false'; // Default true
if (useCloudLogging && config.NODE_ENV === 'production') {
  const { LoggingWinston } = require('@google-cloud/logging-winston');
  loggerConfig.transports.push(new LoggingWinston({
    projectId: config.GOOGLE_CLOUD_PROJECT,
    labels: {
      service: process.env.SERVICE_NAME || 'chantilly-agent',
      version: '1.0.0'
    }
  }));
}

const logger = winston.createLogger(loggerConfig);

// Helper function for logging with request context
function logWithContext(level, message, meta = {}, requestId = null) {
  const logMeta = { ...meta };
  if (requestId) {
    logMeta.requestId = requestId;
  }
  logger[level](message, logMeta);
}

module.exports = {
  logger,
  logWithContext
};