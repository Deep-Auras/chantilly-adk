#!/usr/bin/env node

/**
 * Firestore Collections Initialization Script
 *
 * Creates all required Firestore collections for chantilly-agent-morgan with placeholder documents.
 * This ensures collections exist and vector indexes can be created.
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=chantilly-agent-morgan \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID="(default)" \
 *   node scripts/initFirestoreCollections.js
 */

const readline = require('readline');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const { logger } = require('../utils/logger');

// Get database ID from environment
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';
const BCRYPT_ROUNDS = 12;

// Collection definitions with placeholder documents
const COLLECTIONS = {
  // Core user management
  'users': {
    description: 'User accounts and authentication',
    placeholder: {
      _placeholder: true,
      created: new Date().toISOString(),
      note: 'Placeholder document - will be deleted after admin user creation'
    }
  },

  'auth_logs': {
    description: 'Authentication event logs',
    placeholder: {
      _placeholder: true,
      event: 'system_init',
      timestamp: new Date().toISOString()
    }
  },

  // Agent configuration
  'agent': {
    description: 'Agent personality and configuration',
    documents: {
      'personality': {
        _placeholder: true,
        created: new Date().toISOString(),
        note: 'Run scripts/initMorganPersonality.js to initialize Morgan personality'
      },
      'triggers': {
        _placeholder: true,
        created: new Date().toISOString(),
        note: 'Response triggers will be configured via API'
      }
    }
  },

  // Knowledge and templates
  'knowledge-base': {
    description: 'Knowledge management documents with vector embeddings',
    placeholder: {
      _placeholder: true,
      title: 'System Placeholder',
      content: 'This is a placeholder document. Add knowledge base articles via scripts/addKBToDb.js',
      category: 'system',
      priority: 0,
      created: new Date().toISOString()
    },
    requiresVectorIndex: true
  },

  'task-templates': {
    description: 'Task templates with semantic matching embeddings',
    placeholder: {
      _placeholder: true,
      templateId: '_placeholder',
      name: 'System Placeholder',
      description: 'Placeholder template - add templates via scripts/addTaskTemplateToDB.js',
      category: ['system'],
      created: new Date().toISOString()
    },
    requiresVectorIndex: true
  },

  'tool-embeddings': {
    description: 'Tool trigger pattern embeddings for semantic detection',
    placeholder: {
      _placeholder: true,
      toolName: 'SystemPlaceholder',
      description: 'Placeholder - run scripts/generateToolEmbeddings.js',
      created: new Date().toISOString()
    },
    requiresVectorIndex: true
  },

  'reasoning-memory': {
    description: 'ReasoningBank episodic memory with vector search',
    placeholder: {
      _placeholder: true,
      category: 'system',
      reasoning: 'System initialization placeholder',
      context: 'Firestore collections initialization',
      created: new Date().toISOString(),
      successRate: 1.0,
      timesRetrieved: 0
    },
    requiresVectorIndex: true
  },

  // Tool settings
  'tool-settings': {
    description: 'Dynamic tool configuration storage',
    placeholder: {
      _placeholder: true,
      created: new Date().toISOString(),
      note: 'Tool settings will be created by individual tools on first use'
    }
  },

  // Platform integrations
  'conversations': {
    description: 'Multi-platform conversation history',
    placeholder: {
      _placeholder: true,
      platform: 'system',
      messages: [],
      created: new Date().toISOString()
    }
  },

  'google-chat-spaces': {
    description: 'Google Chat spaces registry',
    placeholder: {
      _placeholder: true,
      spaceName: 'spaces/_placeholder',
      spaceType: 'DM',
      displayName: 'Placeholder',
      active: false,
      joinedAt: new Date().toISOString()
    }
  },

  'asana-webhooks': {
    description: 'Asana webhook registrations',
    placeholder: {
      _placeholder: true,
      gid: '_placeholder',
      resourceGid: '_placeholder',
      targetUrl: 'https://placeholder.run.app',
      active: false,
      created: new Date().toISOString()
    }
  },

  'bot': {
    description: 'Bot authentication tokens (Bitrix24/other platforms)',
    documents: {
      'auth': {
        _placeholder: true,
        created: new Date().toISOString(),
        note: 'Will be populated on bot registration'
      }
    }
  },

  // Queue and task management
  'queue': {
    description: 'API call queue state and metrics',
    documents: {
      'state': {
        _placeholder: true,
        initialized: true,
        created: new Date().toISOString()
      },
      'metrics': {
        _placeholder: true,
        totalRequests: 0,
        totalErrors: 0,
        created: new Date().toISOString()
      }
    }
  },

  'task-queue': {
    description: 'Complex task queue management',
    placeholder: {
      _placeholder: true,
      taskId: '_placeholder_task',
      status: 'placeholder',
      created: new Date().toISOString()
    }
  },

  'worker-processes': {
    description: 'Worker process registry and health',
    placeholder: {
      _placeholder: true,
      workerId: '_placeholder_worker',
      status: 'stopped',
      created: new Date().toISOString()
    }
  },

  // System collections
  '_health': {
    description: 'Health check collection',
    documents: {
      'check': {
        service: 'chantilly-agent-morgan',
        initialized: new Date().toISOString(),
        status: 'healthy'
      }
    }
  },

  'prompts': {
    description: 'Dynamic prompt management (optional)',
    placeholder: {
      _placeholder: true,
      key: '_placeholder',
      content: 'Placeholder prompt',
      created: new Date().toISOString()
    }
  },

  'settings': {
    description: 'System settings storage',
    placeholder: {
      _placeholder: true,
      created: new Date().toISOString()
    }
  }
};

// Password validation function
function validatePasswordStrength(password, username = '', email = '') {
  const errors = [];

  if (password.length < 12) {
    errors.push('Password must be at least 12 characters');
  }

  const commonPasswords = [
    'password123', 'admin123', 'letmein', '123456789',
    'qwerty123', 'password1', 'welcome123', 'administrator',
    'Password1234', 'Morgan123', 'Chantilly123'
  ];

  if (commonPasswords.some(common => password.toLowerCase().includes(common.toLowerCase()))) {
    errors.push('Password is too common and easily guessed');
  }

  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    errors.push('Password must not contain username');
  }

  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) {
    errors.push('Password must not contain email address');
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

// Prompt utilities
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

function promptPassword(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
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
      case '\u0004':
        stdin.setRawMode && stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        rl.close();
        process.stdout.write('\n');
        resolve(password);
        break;
      case '\u0003':
        process.exit();
        break;
      case '\u007f':
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

async function createCollection(db, collectionName, config) {
  console.log(`  Creating collection: ${collectionName}`);
  console.log(`    Purpose: ${config.description}`);

  try {
    if (config.documents) {
      // Create specific documents
      for (const [docId, docData] of Object.entries(config.documents)) {
        await db.collection(collectionName).doc(docId).set(docData);
        console.log(`    ✓ Created document: ${docId}`);
      }
    } else if (config.placeholder) {
      // Create placeholder document
      const docRef = await db.collection(collectionName).add(config.placeholder);
      console.log(`    ✓ Created placeholder document: ${docRef.id}`);
    }

    if (config.requiresVectorIndex) {
      console.log(`    ⚠️  Requires vector index (create after initialization)`);
    }

    return true;
  } catch (error) {
    console.error(`    ✗ Error: ${error.message}`);
    return false;
  }
}

async function createAdminUser(db) {
  console.log('\n🔐 Admin User Creation\n');
  console.log('Create the first admin user for authentication.\n');

  try {
    // Check if admin already exists
    const adminQuery = await db.collection('users')
      .where('role', '==', 'admin')
      .limit(1)
      .get();

    if (!adminQuery.empty) {
      console.log('⚠️  Admin user already exists. Skipping admin creation.');
      return true;
    }

    // Prompt for admin details
    const username = await prompt('Enter admin username [admin]: ') || 'admin';

    if (username.length < 3) {
      console.error('❌ Username must be at least 3 characters');
      return false;
    }

    const existingUser = await db.collection('users').doc(username).get();
    if (existingUser.exists && !existingUser.data()._placeholder) {
      console.error(`❌ Username "${username}" already exists`);
      return false;
    }

    const email = await prompt('Enter admin email [admin@morgan.local]: ') || 'admin@morgan.local';

    if (!email.includes('@')) {
      console.error('❌ Please enter a valid email address');
      return false;
    }

    // Prompt for password with validation
    let password;
    let passwordValid = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (!passwordValid && attempts < maxAttempts) {
      password = await promptPassword('Enter admin password (min 12 chars): ');

      if (!password) {
        console.error('❌ Password cannot be empty');
        attempts++;
        continue;
      }

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
          return false;
        }

        continue;
      }

      const confirmPassword = await promptPassword('Confirm admin password: ');

      if (password !== confirmPassword) {
        console.error('\n❌ Passwords do not match\n');
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
      createdBy: 'initFirestoreCollections.js',
      lastLogin: null,
      failedAttempts: 0,
      locked: false,
      mustChangePassword: false
    });

    console.log('✅ Admin user created successfully!');
    console.log('\nAdmin Details:');
    console.log(`   Username: ${username}`);
    console.log(`   Email: ${email}`);
    console.log('   Role: admin');
    console.log('\n⚠️  IMPORTANT: Store these credentials securely!\n');

    logger.info('Admin user created', {
      username,
      email,
      createdAt: new Date().toISOString()
    });

    return true;
  } catch (error) {
    console.error(`\n❌ Error creating admin user: ${error.message}`);
    return false;
  }
}

async function initializeCollections() {
  console.log('\n🚀 Firestore Collections Initialization\n');
  console.log('This script will create all required collections for chantilly-agent-morgan.\n');
  console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT}`);
  console.log(`Database: ${DATABASE_ID}\n`);

  const proceed = await prompt('Proceed with initialization? (yes/no): ');

  if (proceed.toLowerCase() !== 'yes') {
    console.log('Initialization cancelled.');
    process.exit(0);
  }

  try {
    // Initialize Firebase Admin
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
      });
    }

    const db = admin.firestore();
    db.settings({ databaseId: DATABASE_ID });

    console.log('\n📦 Creating collections...\n');

    let successCount = 0;
    let failCount = 0;
    const vectorIndexCollections = [];

    for (const [collectionName, config] of Object.entries(COLLECTIONS)) {
      const success = await createCollection(db, collectionName, config);
      if (success) {
        successCount++;
        if (config.requiresVectorIndex) {
          vectorIndexCollections.push(collectionName);
        }
      } else {
        failCount++;
      }
      console.log(''); // Empty line between collections
    }

    console.log('\n✅ Collection creation complete!');
    console.log(`   Created: ${successCount} collections`);
    if (failCount > 0) {
      console.log(`   Failed: ${failCount} collections`);
    }

    // Create admin user
    const adminCreated = await createAdminUser(db);

    // Summary
    console.log('\n📋 Summary:\n');
    console.log(`✅ ${successCount} collections initialized`);
    console.log(`${adminCreated ? '✅' : '⚠️ '} Admin user ${adminCreated ? 'created' : 'skipped/failed'}`);

    if (vectorIndexCollections.length > 0) {
      console.log('\n⚠️  Vector Indexes Required:\n');
      console.log('The following collections require vector indexes:');
      vectorIndexCollections.forEach(col => {
        console.log(`   • ${col}`);
      });
      console.log('\nRun the following gcloud commands to create indexes:');
      console.log('\nSee todo #4 for complete index creation commands.\n');
    }

    console.log('\n🎉 Initialization complete!\n');
    console.log('Next steps:');
    console.log('  1. Create vector indexes (see above)');
    console.log('  2. Wait for indexes to build (10-30 minutes)');
    console.log('  3. Run scripts/initMorganPersonality.js');
    console.log('  4. Test admin login at your Cloud Run URL/auth/login');
    console.log('  5. Delete placeholder documents if needed\n');

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Initialization failed:', error.message);
    logger.error('Firestore initialization failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Run the script
initializeCollections().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
