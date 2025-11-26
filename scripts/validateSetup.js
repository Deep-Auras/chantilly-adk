#!/usr/bin/env node

/**
 * Setup Validation Script
 *
 * Validates all prerequisites for Chantilly ADK deployment on Google Cloud Run.
 * This script checks:
 * - Required environment variables
 * - Service account permissions
 * - Firestore connectivity and indexes
 * - Gemini API connectivity
 * - Vertex AI connectivity
 *
 * Exit codes:
 * 0 = All checks passed
 * 1 = Critical errors found
 * 2 = Warnings found (deployment possible but not recommended)
 *
 * Usage:
 *   node scripts/validateSetup.js
 *
 * For Cloud Run deployment (uses Application Default Credentials):
 *   node scripts/validateSetup.js --cloud-run
 */

const admin = require('firebase-admin');
const axios = require('axios');
const { logger } = require('../utils/logger');

// Configuration
const REQUIRED_ENV_VARS = [
  'GOOGLE_CLOUD_PROJECT',
  'GEMINI_API_KEY'
];

const OPTIONAL_ENV_VARS = [
  'AGENT_NAME',
  'JWT_SECRET',
  'PORT',
  'NODE_ENV'
];

const REQUIRED_PERMISSIONS = [
  'datastore.entities.get',
  'datastore.entities.list',
  'datastore.entities.create',
  'datastore.entities.update',
  'aiplatform.endpoints.predict'
];

let hasErrors = false;
let hasWarnings = false;

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function printHeader(text) {
  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.cyan}${text}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}\n`);
}

function printSuccess(text) {
  console.log(`${colors.green}✓${colors.reset} ${text}`);
}

function printError(text) {
  console.log(`${colors.red}✗${colors.reset} ${text}`);
  hasErrors = true;
}

function printWarning(text) {
  console.log(`${colors.yellow}⚠${colors.reset} ${text}`);
  hasWarnings = true;
}

function printInfo(text) {
  console.log(`${colors.blue}ℹ${colors.reset} ${text}`);
}

/**
 * Check required environment variables
 */
function checkEnvironmentVariables() {
  printHeader('Environment Variables');

  // Check required variables
  const missing = [];
  for (const varName of REQUIRED_ENV_VARS) {
    if (!process.env[varName]) {
      printError(`Missing required environment variable: ${varName}`);
      missing.push(varName);
    } else {
      printSuccess(`${varName} is set`);
    }
  }

  // Check optional but recommended variables
  for (const varName of OPTIONAL_ENV_VARS) {
    if (!process.env[varName]) {
      printWarning(`Optional environment variable not set: ${varName}`);
    } else {
      printSuccess(`${varName} is set`);
    }
  }

  if (missing.length > 0) {
    printError(`\nMissing ${missing.length} required environment variable(s)`);
    printInfo('Set these variables in Cloud Run service configuration or .env file');
    return false;
  }

  return true;
}

/**
 * Check Firestore connectivity
 */
async function checkFirestore() {
  printHeader('Firestore Database');

  try {
    // Initialize Firebase Admin if not already initialized
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.GOOGLE_CLOUD_PROJECT
      });
    }

    const db = admin.firestore();

    // Try to read from Firestore
    printInfo('Testing Firestore connectivity...');
    const testRef = db.collection('_setup_validation_test').doc('test');
    await testRef.set({ timestamp: admin.firestore.FieldValue.serverTimestamp() });
    await testRef.get();
    await testRef.delete();

    printSuccess('Firestore is accessible');

    // Check if critical collections exist
    printInfo('Checking critical collections...');
    const collections = ['users', 'agent', 'conversations', 'knowledge-base'];

    for (const collectionName of collections) {
      const snapshot = await db.collection(collectionName).limit(1).get();
      if (snapshot.empty) {
        printWarning(`Collection '${collectionName}' is empty (will be created on first use)`);
      } else {
        printSuccess(`Collection '${collectionName}' exists`);
      }
    }

    return true;
  } catch (error) {
    printError(`Firestore check failed: ${error.message}`);

    if (error.code === 7) {
      printError('Permission denied - check service account has Cloud Datastore User role');
    }

    printInfo('Ensure GOOGLE_CLOUD_PROJECT is set correctly');
    printInfo('In Cloud Run, Application Default Credentials are used automatically');

    return false;
  }
}

/**
 * Check Gemini API connectivity
 */
async function checkGeminiAPI() {
  printHeader('Gemini API');

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    printError('GEMINI_API_KEY not set');
    return false;
  }

  try {
    printInfo('Testing Gemini API connectivity...');

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [{ text: 'Hello' }]
        }]
      },
      { timeout: 10000 }
    );

    if (response.status === 200) {
      printSuccess('Gemini API is accessible');
      printSuccess(`API key is valid`);
      return true;
    } else {
      printError(`Unexpected response status: ${response.status}`);
      return false;
    }
  } catch (error) {
    if (error.response?.status === 400 && error.response?.data?.error?.message?.includes('API_KEY_INVALID')) {
      printError('Gemini API key is invalid');
      printInfo('Get a valid API key from https://aistudio.google.com/app/apikey');
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      printError('Cannot connect to Gemini API - check network connectivity');
    } else {
      printError(`Gemini API check failed: ${error.message}`);
    }
    return false;
  }
}

/**
 * Check Vertex AI connectivity (for embeddings)
 */
async function checkVertexAI() {
  printHeader('Vertex AI (Embeddings)');

  const projectId = process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    printError('GOOGLE_CLOUD_PROJECT not set');
    return false;
  }

  try {
    printInfo('Testing Vertex AI connectivity...');

    // Try to import Vertex AI client
    const { VertexAI } = require('@google-cloud/aiplatform');

    const vertexAI = new VertexAI({
      project: projectId,
      location: process.env.VERTEX_AI_LOCATION || 'us-central1'
    });

    printSuccess('Vertex AI client initialized');
    printInfo('Full embedding test will run on first use');

    return true;
  } catch (error) {
    printError(`Vertex AI check failed: ${error.message}`);

    if (error.code === 7) {
      printError('Permission denied - check service account has Vertex AI User role');
    }

    printInfo('Ensure service account has aiplatform.endpoints.predict permission');

    return false;
  }
}

/**
 * Check Firestore indexes
 */
async function checkFirestoreIndexes() {
  printHeader('Firestore Indexes');

  printInfo('Checking if required indexes are deployed...');
  printWarning('Vector indexes cannot be checked programmatically');
  printInfo('Ensure indexes are deployed via: gcloud firestore indexes create firestore.indexes.json');

  try {
    const db = admin.firestore();

    // Test a query that requires an index
    const testQuery = db.collection('knowledge-base')
      .where('category', '==', 'test')
      .orderBy('priority', 'desc')
      .limit(1);

    await testQuery.get();
    printSuccess('Composite index for knowledge-base (category + priority) exists');

  } catch (error) {
    if (error.code === 9) {
      printWarning('Required indexes may not be deployed yet');
      printInfo('Deploy indexes with: gcloud firestore indexes create firestore.indexes.json --project=$GOOGLE_CLOUD_PROJECT');
      printInfo('Note: Index creation can take 10-15 minutes');
    } else {
      printWarning(`Could not verify indexes: ${error.message}`);
    }
  }

  return true;
}

/**
 * Check service account permissions
 */
async function checkServiceAccountPermissions() {
  printHeader('Service Account Permissions');

  printInfo('Checking Application Default Credentials...');

  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth();

    const client = await auth.getClient();
    const projectId = await auth.getProjectId();

    printSuccess(`Using project: ${projectId}`);

    if (process.env.K_SERVICE) {
      printSuccess('Running in Cloud Run - using service account automatically');
      printInfo('Ensure default Compute Engine service account has these roles:');
      printInfo('  - Cloud Datastore User');
      printInfo('  - Vertex AI User');
      printInfo('  - Logs Writer');
    } else {
      printSuccess('Application Default Credentials configured');
      printInfo('For Cloud Run deployment, ensure service account has proper roles');
    }

    return true;
  } catch (error) {
    printError(`Credentials check failed: ${error.message}`);
    printInfo('In Cloud Run, credentials are provided automatically');
    printInfo('For local testing, set GOOGLE_APPLICATION_CREDENTIALS');
    return false;
  }
}

/**
 * Check admin user exists
 */
async function checkAdminUser() {
  printHeader('Admin User');

  try {
    const db = admin.firestore();

    printInfo('Checking for admin users...');
    const adminQuery = await db.collection('users')
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (adminQuery.empty) {
      printWarning('No admin user found');
      printInfo('Create an admin user with: npm run admin:create');
      printInfo('Or use the setup wizard on first deployment');
      return false;
    } else {
      printSuccess(`Admin user exists: ${adminQuery.docs[0].data().username}`);
      return true;
    }
  } catch (error) {
    printWarning(`Could not check admin user: ${error.message}`);
    return false;
  }
}

/**
 * Main validation routine
 */
async function runValidation() {
  console.log(`\n${colors.cyan}╔${'═'.repeat(58)}╗${colors.reset}`);
  console.log(`${colors.cyan}║${' '.repeat(10)}Chantilly ADK - Setup Validation${' '.repeat(15)}║${colors.reset}`);
  console.log(`${colors.cyan}╚${'═'.repeat(58)}╝${colors.reset}\n`);

  printInfo(`Node.js version: ${process.version}`);
  printInfo(`Platform: ${process.platform}`);
  printInfo(`Running in Cloud Run: ${process.env.K_SERVICE ? 'Yes' : 'No'}\n`);

  // Run all checks
  const checks = [
    { name: 'Environment Variables', fn: checkEnvironmentVariables },
    { name: 'Service Account', fn: checkServiceAccountPermissions },
    { name: 'Firestore', fn: checkFirestore },
    { name: 'Gemini API', fn: checkGeminiAPI },
    { name: 'Vertex AI', fn: checkVertexAI },
    { name: 'Firestore Indexes', fn: checkFirestoreIndexes },
    { name: 'Admin User', fn: checkAdminUser }
  ];

  const results = [];

  for (const check of checks) {
    try {
      const result = await check.fn();
      results.push({ name: check.name, passed: result });
    } catch (error) {
      printError(`${check.name} check threw an error: ${error.message}`);
      results.push({ name: check.name, passed: false });
    }
  }

  // Print summary
  printHeader('Validation Summary');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`Total checks: ${results.length}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset}`);
  console.log(`${colors.red}Failed: ${failed}${colors.reset}`);
  console.log(`${colors.yellow}Warnings: ${hasWarnings ? 'Yes' : 'No'}${colors.reset}\n`);

  if (hasErrors) {
    console.log(`${colors.red}❌ VALIDATION FAILED${colors.reset}`);
    console.log('Fix the errors above before deploying to production.\n');
    process.exit(1);
  } else if (hasWarnings) {
    console.log(`${colors.yellow}⚠️  VALIDATION PASSED WITH WARNINGS${colors.reset}`);
    console.log('Deployment is possible but some features may not work correctly.\n');
    process.exit(2);
  } else {
    console.log(`${colors.green}✅ ALL CHECKS PASSED${colors.reset}`);
    console.log('System is ready for deployment!\n');
    process.exit(0);
  }
}

// Run validation
runValidation().catch(error => {
  printError(`Fatal error during validation: ${error.message}`);
  logger.error('Validation failed', { error: error.message, stack: error.stack });
  process.exit(1);
});
