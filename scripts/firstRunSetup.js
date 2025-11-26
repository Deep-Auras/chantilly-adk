#!/usr/bin/env node

/**
 * First-Run Setup Wizard for Chantilly ADK
 *
 * This wizard runs on the first container startup when deployed to Google Cloud Run
 * from a repository. It guides users through initial configuration.
 *
 * Workflow:
 * 1. Detect if setup is needed (check for admin user and configuration)
 * 2. Guide user through configuration (or use environment variables)
 * 3. Create admin user
 * 4. Store configuration in Firestore
 * 5. Deploy Firestore indexes
 * 6. Validate the setup
 *
 * Environment variables (for non-interactive setup):
 * - SKIP_SETUP_WIZARD=true (skip wizard entirely)
 * - SETUP_ADMIN_USERNAME (default admin username)
 * - SETUP_ADMIN_PASSWORD (default admin password)
 * - SETUP_ADMIN_EMAIL (default admin email)
 * - GEMINI_API_KEY (required)
 * - GOOGLE_CLOUD_PROJECT (required)
 *
 * Usage:
 *   node scripts/firstRunSetup.js
 *
 * Exit codes:
 * 0 = Setup completed successfully or not needed
 * 1 = Setup failed
 */

const readline = require('readline');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function printBanner() {
  console.log(`\n${colors.cyan}╔${'═'.repeat(58)}╗${colors.reset}`);
  console.log(`${colors.cyan}║${' '.repeat(10)}Chantilly ADK - First Run Setup${' '.repeat(16)}║${colors.reset}`);
  console.log(`${colors.cyan}╚${'═'.repeat(58)}╝${colors.reset}\n`);
}

function printSuccess(text) {
  console.log(`${colors.green}✓${colors.reset} ${text}`);
}

function printError(text) {
  console.log(`${colors.red}✗${colors.reset} ${text}`);
}

function printWarning(text) {
  console.log(`${colors.yellow}⚠${colors.reset} ${text}`);
}

function printInfo(text) {
  console.log(`${colors.blue}ℹ${colors.reset} ${text}`);
}

function printStep(stepNumber, totalSteps, text) {
  console.log(`\n${colors.cyan}[${stepNumber}/${totalSteps}]${colors.reset} ${colors.magenta}${text}${colors.reset}\n`);
}

/**
 * Prompt for user input with readline
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Hidden password input
 */
function promptPassword(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    const stdin = process.stdin;
    const isRaw = stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';

    process.stdout.write(question);

    stdin.on('data', function onData(char) {
      char = char.toString('utf8');

      switch (char) {
      case '\n':
      case '\r':
      case '\u0004': // Ctrl+D
        if (isRaw) stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(password);
        break;
      case '\u0003': // Ctrl+C
        process.exit();
        break;
      case '\u007f': // Backspace
        password = password.slice(0, -1);
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        process.stdout.write(question + '*'.repeat(password.length));
        break;
      default:
        password += char;
        process.stdout.write('*');
        break;
      }
    });
  });
}

/**
 * Validate password strength
 */
function validatePasswordStrength(password, username = '', email = '') {
  const errors = [];

  if (password.length < 12) {
    errors.push('Password must be at least 12 characters');
  }

  const commonPasswords = [
    'password123', 'admin123', 'letmein', '123456789',
    'qwerty123', 'password1', 'welcome123', 'administrator',
    'Password1234'
  ];

  if (commonPasswords.some(common => password.toLowerCase().includes(common.toLowerCase()))) {
    errors.push('Password is too common');
  }

  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    errors.push('Password must not contain username');
  }

  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    errors.push('Password must not contain email');
  }

  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSpecial = /[^a-zA-Z\d]/.test(password);

  const categoryCount = [hasLowercase, hasUppercase, hasDigit, hasSpecial].filter(Boolean).length;

  if (categoryCount < 3) {
    errors.push('Password must contain at least 3 of: lowercase, uppercase, numbers, special characters');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Check if setup is needed
 */
async function isSetupNeeded(db) {
  try {
    // Check for admin user
    const adminQuery = await db.collection('users')
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (!adminQuery.empty) {
      printInfo('Admin user already exists - setup not needed');
      return false;
    }

    // Check for configuration
    const configDoc = await db.collection('agent').doc('config').get();
    if (configDoc.exists && configDoc.data().setupCompleted) {
      printInfo('Setup already completed');
      return false;
    }

    return true;
  } catch (error) {
    printWarning(`Could not check setup status: ${error.message}`);
    return true; // Assume setup is needed if we can't check
  }
}

/**
 * Create admin user
 */
async function createAdminUser(db, username, email, password) {
  const hashedPassword = await bcrypt.hash(password, 12);

  await db.collection('users').doc(username).set({
    username,
    email,
    password: hashedPassword,
    role: 'admin',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: 'firstRunSetup.js',
    lastLogin: null,
    failedAttempts: 0,
    locked: false,
    mustChangePassword: false
  });

  printSuccess(`Admin user '${username}' created successfully`);
}

/**
 * Initialize agent configuration
 */
async function initializeAgentConfig(db, agentName) {
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');

  await db.collection('agent').doc('config').set({
    AGENT_NAME: agentName,
    sessionSecret,
    jwtSecret,
    setupCompleted: true,
    setupDate: admin.firestore.FieldValue.serverTimestamp(),
    version: '1.0.0'
  }, { merge: true });

  printSuccess('Agent configuration initialized');
}

/**
 * Initialize platform configurations
 */
async function initializePlatformConfigs(db) {
  // Initialize platform-settings collection with default disabled states
  const platforms = [
    { id: 'bitrix24', name: 'Bitrix24', enabled: false },
    { id: 'googleChat', name: 'Google Chat', enabled: false },
    { id: 'asana', name: 'Asana', enabled: false },
    { id: 'bluesky', name: 'Bluesky', enabled: false },
    { id: 'webChat', name: 'Web Chat', enabled: true } // Web chat enabled by default
  ];

  for (const platform of platforms) {
    await db.collection('platform-settings').doc(platform.id).set({
      name: platform.name,
      enabled: platform.enabled,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  printSuccess('Platform configurations initialized');
}

/**
 * Deploy Firestore indexes
 */
async function deployFirestoreIndexes() {
  printInfo('Firestore indexes should be deployed manually via:');
  printInfo('  gcloud firestore indexes create firestore.indexes.json --project=$GOOGLE_CLOUD_PROJECT');
  printWarning('Index creation takes 10-15 minutes - continue without waiting');
}

/**
 * Interactive setup wizard
 */
async function runInteractiveSetup(db) {
  printBanner();

  console.log(`${colors.cyan}Welcome to Chantilly ADK!${colors.reset}\n`);
  console.log('This wizard will guide you through the initial setup.\n');

  // Step 1: Agent name
  printStep(1, 5, 'Agent Identity');
  const defaultAgentName = process.env.AGENT_NAME || 'morgan';
  const agentName = await prompt(`Enter agent name [${defaultAgentName}]: `) || defaultAgentName;
  printSuccess(`Agent name: ${agentName}`);

  // Step 2: Admin user
  printStep(2, 5, 'Admin User Creation');
  console.log('Create the first admin user for the dashboard.\n');

  let username, email, password;
  let adminValid = false;

  while (!adminValid) {
    username = await prompt('Enter admin username (min 3 chars): ');

    if (!username || username.length < 3) {
      printError('Username must be at least 3 characters');
      continue;
    }

    // Check if username exists
    const existingUser = await db.collection('users').doc(username).get();
    if (existingUser.exists) {
      printError(`Username '${username}' already exists`);
      continue;
    }

    email = await prompt('Enter admin email: ');

    if (!email || !email.includes('@')) {
      printError('Please enter a valid email address');
      continue;
    }

    let passwordValid = false;
    let attempts = 0;

    while (!passwordValid && attempts < 3) {
      password = await promptPassword('Enter admin password (min 12 chars): ');

      if (!password) {
        printError('Password cannot be empty');
        attempts++;
        continue;
      }

      const validation = validatePasswordStrength(password, username, email);

      if (!validation.valid) {
        console.log(`\n${colors.red}Password validation failed:${colors.reset}`);
        validation.errors.forEach(error => {
          printError(`  ${error}`);
        });
        console.log('');
        attempts++;

        if (attempts >= 3) {
          printError('Maximum attempts reached');
          process.exit(1);
        }

        continue;
      }

      const confirmPassword = await promptPassword('Confirm admin password: ');

      if (password !== confirmPassword) {
        printError('\nPasswords do not match\n');
        attempts++;
        continue;
      }

      passwordValid = true;
    }

    adminValid = true;
  }

  // Step 3: Platform configuration
  printStep(3, 5, 'Platform Configuration');
  console.log('Configure platform integrations (can be changed later via dashboard).\n');

  printInfo('All platforms are disabled by default');
  printInfo('Web Chat is enabled automatically');
  printInfo('You can configure platforms later via the dashboard');

  // Step 4: Create configuration
  printStep(4, 5, 'Initializing Configuration');

  await createAdminUser(db, username, email, password);
  await initializeAgentConfig(db, agentName);
  await initializePlatformConfigs(db);

  printSuccess('Configuration stored in Firestore');

  // Step 5: Firestore indexes
  printStep(5, 5, 'Firestore Indexes');
  await deployFirestoreIndexes();

  // Success message
  console.log(`\n${colors.green}╔${'═'.repeat(58)}╗${colors.reset}`);
  console.log(`${colors.green}║${' '.repeat(20)}Setup Complete!${' '.repeat(22)}║${colors.reset}`);
  console.log(`${colors.green}╚${'═'.repeat(58)}╝${colors.reset}\n`);

  console.log(`${colors.cyan}Admin Credentials:${colors.reset}`);
  console.log(`  Username: ${colors.green}${username}${colors.reset}`);
  console.log(`  Email: ${colors.green}${email}${colors.reset}`);
  console.log(`\n${colors.yellow}⚠️  IMPORTANT: Save these credentials securely!${colors.reset}\n`);

  console.log(`${colors.cyan}Next Steps:${colors.reset}`);
  console.log(`  1. Access the dashboard at your Cloud Run service URL`);
  console.log(`  2. Log in with the admin credentials above`);
  console.log(`  3. Configure platform integrations in Settings`);
  console.log(`  4. Deploy Firestore indexes (see above command)`);
  console.log(`\n${colors.green}The agent is now ready to use!${colors.reset}\n`);
}

/**
 * Non-interactive setup (using environment variables)
 */
async function runNonInteractiveSetup(db) {
  printBanner();
  printInfo('Running non-interactive setup using environment variables\n');

  const username = process.env.SETUP_ADMIN_USERNAME;
  const password = process.env.SETUP_ADMIN_PASSWORD;
  const email = process.env.SETUP_ADMIN_EMAIL;
  const agentName = process.env.AGENT_NAME || 'morgan';

  if (!username || !password || !email) {
    printError('Non-interactive setup requires:');
    printError('  - SETUP_ADMIN_USERNAME');
    printError('  - SETUP_ADMIN_PASSWORD');
    printError('  - SETUP_ADMIN_EMAIL');
    process.exit(1);
  }

  // Validate password
  const validation = validatePasswordStrength(password, username, email);
  if (!validation.valid) {
    printError('Password validation failed:');
    validation.errors.forEach(error => printError(`  ${error}`));
    process.exit(1);
  }

  printInfo(`Creating admin user: ${username}`);
  await createAdminUser(db, username, email, password);

  printInfo(`Initializing agent: ${agentName}`);
  await initializeAgentConfig(db, agentName);

  printInfo('Initializing platform configurations');
  await initializePlatformConfigs(db);

  await deployFirestoreIndexes();

  printSuccess('\n✓ Non-interactive setup completed successfully\n');
}

/**
 * Main setup routine
 */
async function runSetup() {
  try {
    // Check if setup should be skipped
    if (process.env.SKIP_SETUP_WIZARD === 'true') {
      printInfo('Setup wizard skipped (SKIP_SETUP_WIZARD=true)');
      process.exit(0);
    }

    // Verify required environment variables
    if (!process.env.GOOGLE_CLOUD_PROJECT) {
      printError('GOOGLE_CLOUD_PROJECT environment variable is required');
      process.exit(1);
    }

    if (!process.env.GEMINI_API_KEY) {
      printError('GEMINI_API_KEY environment variable is required');
      process.exit(1);
    }

    // Initialize Firebase Admin
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.GOOGLE_CLOUD_PROJECT
      });
    }

    const db = admin.firestore();

    // Check if setup is needed
    const setupNeeded = await isSetupNeeded(db);

    if (!setupNeeded) {
      printSuccess('Setup already completed - skipping wizard\n');
      process.exit(0);
    }

    // Determine if running interactively
    const isInteractive = process.stdin.isTTY &&
                          !process.env.SETUP_ADMIN_USERNAME &&
                          !process.env.CI;

    if (isInteractive) {
      await runInteractiveSetup(db);
    } else {
      await runNonInteractiveSetup(db);
    }

    // Log setup completion
    logger.info('First-run setup completed', {
      timestamp: new Date().toISOString(),
      mode: isInteractive ? 'interactive' : 'non-interactive'
    });

    process.exit(0);

  } catch (error) {
    printError(`\nSetup failed: ${error.message}`);
    logger.error('First-run setup failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Handle interrupts gracefully
process.on('SIGINT', () => {
  console.log('\n\nSetup cancelled by user');
  process.exit(0);
});

// Run setup
runSetup().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
