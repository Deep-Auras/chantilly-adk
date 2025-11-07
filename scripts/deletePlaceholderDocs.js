#!/usr/bin/env node

/**
 * Delete Placeholder Documents Script
 *
 * Removes all placeholder documents created during Firestore initialization.
 * Run this after indexes are built and admin user is verified.
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=chantilly-agent-morgan \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID="(default)" \
 *   node scripts/deletePlaceholderDocs.js
 */

const admin = require('firebase-admin');
const { logger } = require('../utils/logger');

const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';

// Collections with placeholder documents
const COLLECTIONS_WITH_PLACEHOLDERS = [
  'users',
  'auth_logs',
  'knowledge-base',
  'task-templates',
  'tool-embeddings',
  'reasoning-memory',
  'tool-settings',
  'conversations',
  'google-chat-spaces',
  'asana-webhooks',
  'prompts',
  'settings',
  'task-queue',
  'worker-processes'
];

// Collections with specific placeholder documents
const DOCUMENTS_WITH_PLACEHOLDERS = {
  'agent': ['personality', 'triggers'],
  'bot': ['auth'],
  'queue': ['state', 'metrics']
};

async function deletePlaceholders() {
  console.log('\n🗑️  Placeholder Document Cleanup\n');
  console.log('This script will remove all placeholder documents created during initialization.\n');
  console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT}`);
  console.log(`Database: ${DATABASE_ID}\n`);

  try {
    // Initialize Firebase Admin
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault()
      });
    }

    const db = admin.firestore();
    db.settings({ databaseId: DATABASE_ID });

    console.log('🔍 Scanning for placeholder documents...\n');

    let totalDeleted = 0;
    let totalScanned = 0;

    // Delete from collections with placeholders
    for (const collectionName of COLLECTIONS_WITH_PLACEHOLDERS) {
      try {
        console.log(`Checking collection: ${collectionName}`);

        const snapshot = await db.collection(collectionName)
          .where('_placeholder', '==', true)
          .get();

        totalScanned += snapshot.size;

        if (snapshot.empty) {
          console.log(`  ✓ No placeholders found\n`);
          continue;
        }

        console.log(`  Found ${snapshot.size} placeholder(s)`);

        const batch = db.batch();
        let batchCount = 0;

        snapshot.forEach(doc => {
          batch.delete(doc.ref);
          batchCount++;
          console.log(`    - Deleting: ${doc.id}`);
        });

        if (batchCount > 0) {
          await batch.commit();
          totalDeleted += batchCount;
          console.log(`  ✓ Deleted ${batchCount} placeholder(s)\n`);
        }

      } catch (error) {
        console.error(`  ✗ Error processing ${collectionName}: ${error.message}\n`);
      }
    }

    // Delete specific documents with placeholders
    console.log('Checking specific documents...\n');

    for (const [collectionName, docIds] of Object.entries(DOCUMENTS_WITH_PLACEHOLDERS)) {
      try {
        console.log(`Collection: ${collectionName}`);

        for (const docId of docIds) {
          const docRef = db.collection(collectionName).doc(docId);
          const doc = await docRef.get();

          if (doc.exists) {
            const data = doc.data();
            if (data._placeholder === true) {
              await docRef.delete();
              totalDeleted++;
              console.log(`  - Deleted placeholder: ${docId}`);
            } else {
              console.log(`  ✓ Document exists (not placeholder): ${docId}`);
            }
          } else {
            console.log(`  ✓ Document doesn't exist: ${docId}`);
          }
        }

        console.log('');
      } catch (error) {
        console.error(`  ✗ Error processing ${collectionName}: ${error.message}\n`);
      }
    }

    // Summary
    console.log('\n✅ Cleanup Complete!\n');
    console.log(`Documents scanned: ${totalScanned}`);
    console.log(`Placeholders deleted: ${totalDeleted}`);
    console.log('');

    if (totalDeleted === 0) {
      console.log('✨ No placeholder documents found. Collections are clean!\n');
    } else {
      console.log('💡 Note: Keep the _health/check document - it\'s used for health checks.\n');
    }

    logger.info('Placeholder cleanup completed', {
      scanned: totalScanned,
      deleted: totalDeleted
    });

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Cleanup failed:', error.message);
    logger.error('Placeholder cleanup failed', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Run the script
deletePlaceholders().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
