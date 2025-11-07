const admin = require('firebase-admin');
const config = require('./env');
const { logger } = require('../utils/logger');

let db;
let initialized = false;

async function initializeFirestore() {
  if (initialized) {
    return db;
  }

  try {
    logger.info('Starting Firestore initialization', {
      projectId: config.GOOGLE_CLOUD_PROJECT,
      nodeEnv: config.NODE_ENV,
      hasCredentials: !!config.GOOGLE_APPLICATION_CREDENTIALS
    });

    // Initialize Firebase Admin
    const initConfig = {
      projectId: config.GOOGLE_CLOUD_PROJECT
    };

    logger.info('Firebase init config', initConfig);

    if (config.NODE_ENV === 'production') {
      // In production (Cloud Run), use default application credentials
      logger.info('Using production credentials');
      admin.initializeApp(initConfig);
    } else {
      // In development, use service account key if provided
      if (config.GOOGLE_APPLICATION_CREDENTIALS) {
        logger.info('Using service account credentials');
        const serviceAccount = require(config.GOOGLE_APPLICATION_CREDENTIALS);
        initConfig.credential = admin.credential.cert(serviceAccount);
      } else {
        logger.info('No service account credentials provided');
      }
      admin.initializeApp(initConfig);
    }

    logger.info('Getting Firestore instance');
    const { getFirestore } = require('firebase-admin/firestore');
    db = getFirestore(config.FIRESTORE_DATABASE_ID);

    // Configure Firestore settings
    logger.info('Configuring Firestore settings');
    db.settings({
      ignoreUndefinedProperties: true,
      timestampsInSnapshots: true
    });

    // Test connection
    logger.info('Testing Firestore connection...');
    await db.collection('_health').doc('check').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      service: 'chantilly-adk'
    });
    logger.info('Firestore connection test successful');

    initialized = true;
    logger.info('Firestore initialized successfully');
    return db;
  } catch (error) {
    logger.error('Failed to initialize Firestore', error);
    throw error;
  }
}

function getFirestore() {
  if (!initialized) {
    // In development, if credentials are missing, return a mock that gracefully fails
    if (process.env.NODE_ENV === 'development') {
      logger.warn('Firestore not available, returning mock instance for development');
      return createMockFirestore();
    }
    throw new Error('Firestore not initialized. Call initializeFirestore() first.');
  }
  return db;
}

function createMockFirestore() {
  return {
    collection: () => ({
      doc: () => ({
        get: () => Promise.resolve({ exists: false, data: () => null }),
        set: () => Promise.reject(new Error('Firestore not available - missing credentials')),
        update: () => Promise.reject(new Error('Firestore not available - missing credentials')),
        delete: () => Promise.reject(new Error('Firestore not available - missing credentials'))
      }),
      where: () => ({
        get: () => Promise.resolve({ empty: true, docs: [] })
      }),
      orderBy: () => ({
        limit: () => ({
          get: () => Promise.resolve({ empty: true, docs: [] })
        })
      }),
      add: () => Promise.reject(new Error('Firestore not available - missing credentials'))
    })
  };
}

// Helper function to get Firestore Timestamp
function getTimestamp() {
  return admin.firestore.Timestamp;
}

// Helper function for Field Values
function getFieldValue() {
  return admin.firestore.FieldValue;
}

module.exports = {
  initializeFirestore,
  getDb: getFirestore,  // Alias for ReasoningBank compatibility
  getFirestore,
  getTimestamp,
  getFieldValue
};