#!/usr/bin/env node

/**
 * Secure Admin User Creation Script
 *
 * Creates an admin user with strong password validation.
 * NEVER hardcode credentials - always prompt for secure input.
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=cx-voice-backup-383016 \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID=chantilly-agent-${AGENT_NAME} \
 *   node scripts/createAdmin.js
 */

const readline = require('readline');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const { logger } = require('../utils/logger');

// Get database ID from environment (defaults to chantilly-agent-${AGENT_NAME})
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'chantilly-agent-${AGENT_NAME}';

// Bcrypt work factor (same as auth service)
const BCRYPT_ROUNDS = 12;

// Password strength validator
function validatePasswordStrength(password, username = '', email = '') {
  const errors = [];

  // Minimum length (2025 OWASP: 12+ chars for admin)
  if (password.length < 12) {
    errors.push('Password must be at least 12 characters');
  }

  // Check for common passwords
  const commonPasswords = [
    'password123', 'admin123', 'letmein', '123456789',
    'qwerty123', 'password1', 'welcome123', 'administrator',
    'Password1234' // The old hardcoded password
  ];

  if (commonPasswords.some(common => password.toLowerCase().includes(common.toLowerCase()))) {
    errors.push('Password is too common and easily guessed');
  }

  // Check if password contains username
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    errors.push('Password must not contain username');
  }

  // Check if password contains email prefix
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    errors.push('Password must not contain email address');
  }

  // Character diversity (at least 3 of 4 categories)
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

// Prompt for user input with readline
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

// Hidden password input
function promptPassword(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    // Hide password input
    const stdin = process.stdin;
    stdin.setRawMode && stdin.setRawMode(true);
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
        stdin.setRawMode && stdin.setRawMode(false);
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

async function createAdmin() {
  console.log('\n🔐 Secure Admin User Creation\n');
  console.log('This script creates an admin user with secure credentials.');
  console.log('NEVER use default or common passwords!\n');

  try {
    // Initialize Firebase Admin
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
      });
    }

    // Use the configured database
    const db = admin.firestore();
    db.settings({ databaseId: DATABASE_ID });

    console.log(`Using Firestore database: ${DATABASE_ID}\n`);

    // Check if admin already exists
    const adminQuery = await db.collection('users')
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (!adminQuery.empty) {
      console.log('⚠️  Warning: Admin user(s) already exist in the system.');
      const proceed = await prompt('Do you want to create another admin user? (yes/no): ');

      if (proceed.toLowerCase() !== 'yes') {
        console.log('Cancelled. No admin user created.');
        process.exit(0);
      }
    }

    // Prompt for username
    const username = await prompt('Enter admin username: ');

    if (!username || username.length < 3) {
      console.error('❌ Error: Username must be at least 3 characters');
      process.exit(1);
    }

    // Check if username already exists
    const existingUser = await db.collection('users').doc(username).get();
    if (existingUser.exists) {
      console.error(`❌ Error: Username "${username}" already exists`);
      process.exit(1);
    }

    // Prompt for email
    const email = await prompt('Enter admin email: ');

    if (!email || !email.includes('@')) {
      console.error('❌ Error: Please enter a valid email address');
      process.exit(1);
    }

    // Prompt for password (with validation)
    let password;
    let passwordValid = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (!passwordValid && attempts < maxAttempts) {
      password = await promptPassword('Enter admin password (min 12 chars): ');

      if (!password) {
        console.error('❌ Error: Password cannot be empty');
        attempts++;
        continue;
      }

      // Validate password strength
      const validation = validatePasswordStrength(password, username, email);

      if (!validation.valid) {
        console.error('\n❌ Password validation failed:');
        validation.errors.forEach(error => {
          console.error(`   • ${error}`);
        });
        console.log('');
        attempts++;

        if (attempts >= maxAttempts) {
          console.error('Maximum attempts reached. Please try again.');
          process.exit(1);
        }

        continue;
      }

      // Confirm password
      const confirmPassword = await promptPassword('Confirm admin password: ');

      if (password !== confirmPassword) {
        console.error('\n❌ Error: Passwords do not match\n');
        attempts++;
        continue;
      }

      passwordValid = true;
    }

    console.log('\n✅ Password validation passed');
    console.log('Creating admin user...\n');

    // Hash password
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create admin user
    await db.collection('users').doc(username).set({
      username,
      email,
      password: hashedPassword,
      role: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: 'createAdmin.js script',
      lastLogin: null,
      failedAttempts: 0,
      locked: false,
      mustChangePassword: false // Admin created securely, no forced change
    });

    console.log('✅ Admin user created successfully!');
    console.log('\nAdmin Details:');
    console.log(`   Username: ${username}`);
    console.log(`   Email: ${email}`);
    console.log('   Role: admin');
    console.log('\n⚠️  IMPORTANT: Store these credentials securely!');
    console.log('   This is the only time the password will be shown.\n');

    // Log the creation
    logger.info('Admin user created via script', {
      username,
      email,
      createdAt: new Date().toISOString()
    });

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error creating admin user:', error.message);
    logger.error('Admin creation failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Run the script
createAdmin().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
