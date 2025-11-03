#!/usr/bin/env node

/**
 * Create Bitrix User Mapping Script
 *
 * Creates a mapping between Bitrix24 user IDs and internal Chantilly users
 * for role-based access control (RBAC).
 *
 * This script:
 * - Prompts for Bitrix24 user ID (FROM_USER_ID from webhooks)
 * - Prompts for internal username (must exist in users collection)
 * - Fetches role from users collection
 * - Creates bitrix_users document with cached role
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=cx-voice-backup-383016 \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID=chantilly-agent-${AGENT_NAME} \
 *   node scripts/createBitrixUserMapping.js
 */

const readline = require('readline');
const admin = require('firebase-admin');
const { logger } = require('../utils/logger');

// Get database ID from environment (defaults to chantilly-agent-${AGENT_NAME})
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'chantilly-agent-${AGENT_NAME}';

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

async function createBitrixUserMapping() {
  console.log('\n🔗 Bitrix User Mapping Creation\n');
  console.log('This script creates a mapping between Bitrix24 users and internal Chantilly users.');
  console.log('This is required for role-based access control (RBAC).\n');

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

    // Prompt for Bitrix24 user ID
    console.log('Step 1: Bitrix24 User ID');
    console.log('  This is the FROM_USER_ID from Bitrix24 webhook events.');
    console.log('  Example: 1, 42, 123\n');

    const bitrixUserId = await prompt('Enter Bitrix24 user ID: ');

    if (!bitrixUserId || bitrixUserId.length === 0) {
      console.error('❌ Error: Bitrix24 user ID cannot be empty');
      process.exit(1);
    }

    // Validate it's a reasonable ID (numeric or alphanumeric)
    if (!/^[a-zA-Z0-9_-]+$/.test(bitrixUserId)) {
      console.error('❌ Error: Bitrix24 user ID contains invalid characters');
      process.exit(1);
    }

    // Check if mapping already exists
    const existingMapping = await db.collection('bitrix_users').doc(bitrixUserId).get();
    if (existingMapping.exists) {
      const existing = existingMapping.data();
      console.log(`\n⚠️  Warning: Mapping already exists for Bitrix user ${bitrixUserId}`);
      console.log(`   Mapped to: ${existing.internalUserId} (${existing.role})`);
      console.log(`   Created: ${existing.createdAt?.toDate().toISOString() || 'unknown'}`);

      const proceed = await prompt('\nDo you want to update this mapping? (yes/no): ');
      if (proceed.toLowerCase() !== 'yes') {
        console.log('Cancelled. No changes made.');
        process.exit(0);
      }
    }

    // Prompt for internal username
    console.log('\nStep 2: Internal Username');
    console.log('  This is the username in the users collection (used for JWT auth).');
    console.log('  Must be an existing user.\n');

    const internalUserId = await prompt('Enter internal username: ');

    if (!internalUserId || internalUserId.length < 3) {
      console.error('❌ Error: Internal username must be at least 3 characters');
      process.exit(1);
    }

    // Validate internal user exists
    const userDoc = await db.collection('users').doc(internalUserId).get();

    if (!userDoc.exists) {
      console.error(`❌ Error: User "${internalUserId}" does not exist in users collection`);
      console.error('   Create the user first with: npm run admin:create');
      process.exit(1);
    }

    const userData = userDoc.data();

    // Validate user has required fields
    if (!userData.role) {
      console.error(`❌ Error: User "${internalUserId}" has no role defined`);
      process.exit(1);
    }

    if (!userData.email) {
      console.error(`❌ Error: User "${internalUserId}" has no email defined`);
      process.exit(1);
    }

    // Display user info for confirmation
    console.log('\nStep 3: Confirmation');
    console.log('  Mapping Details:');
    console.log(`  ├─ Bitrix24 User ID: ${bitrixUserId}`);
    console.log(`  ├─ Internal User: ${internalUserId}`);
    console.log(`  ├─ Email: ${userData.email}`);
    console.log(`  ├─ Role: ${userData.role}`);
    console.log(`  └─ Last Login: ${userData.lastLogin?.toDate().toISOString() || 'never'}\n`);

    const confirm = await prompt('Create this mapping? (yes/no): ');

    if (confirm.toLowerCase() !== 'yes') {
      console.log('Cancelled. No mapping created.');
      process.exit(0);
    }

    console.log('\nCreating Bitrix user mapping...\n');

    // Create bitrix_users document
    await db.collection('bitrix_users').doc(bitrixUserId).set({
      bitrixUserId,
      internalUserId,
      email: userData.email,
      role: userData.role,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSeen: null,
      createdBy: 'createBitrixUserMapping.js script'
    });

    console.log('✅ Bitrix user mapping created successfully!\n');
    console.log('Mapping Details:');
    console.log(`   Bitrix24 User ID: ${bitrixUserId}`);
    console.log(`   Internal User: ${internalUserId}`);
    console.log(`   Email: ${userData.email}`);
    console.log(`   Role: ${userData.role}`);
    console.log('\n📝 This user will now have access based on their role:');

    if (userData.role === 'admin') {
      console.log('   - Admin: Access to ALL tools (14 tools)');
      console.log('   - Includes: Task management, knowledge base, call recordings, etc.');
    } else {
      console.log('   - User: Access to general tools (8 tools)');
      console.log('   - Includes: Chat, translation, weather, web search, etc.');
    }

    console.log('\n🔍 Testing:');
    console.log('   When this Bitrix user sends a message, the system will:');
    console.log(`   1. Extract FROM_USER_ID: ${bitrixUserId}`);
    console.log(`   2. Look up mapping → ${internalUserId}`);
    console.log(`   3. Apply role: ${userData.role}`);
    console.log(`   4. Filter tools accordingly\n`);

    console.log('💡 Management:');
    console.log('   To update this user\'s role:');
    console.log('   - Update in users collection with: npm run admin:create');
    console.log('   - Then run this script again to sync the role cache');
    console.log('   - Or use the admin API: PUT /admin/bitrix-users/:id/role\n');

    // Log the creation
    logger.info('Bitrix user mapping created via script', {
      bitrixUserId,
      internalUserId,
      email: userData.email,
      role: userData.role,
      createdAt: new Date().toISOString()
    });

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error creating Bitrix user mapping:', error.message);
    logger.error('Bitrix user mapping creation failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Run the script
createBitrixUserMapping().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
