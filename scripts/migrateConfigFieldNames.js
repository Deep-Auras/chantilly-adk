/**
 * Migration Script: Fix field name casing in agent/config document
 *
 * Old setup used environment variables with uppercase names (JWT_SECRET)
 * New setup uses camelCase for secrets (jwtSecret)
 *
 * This script migrates the field names to match the new format.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

// Initialize Firebase Admin
const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!projectId) {
  console.error('ERROR: GOOGLE_CLOUD_PROJECT environment variable is required');
  process.exit(1);
}

console.log('Initializing Firebase Admin...');
console.log('Project ID:', projectId);

if (serviceAccountPath) {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: projectId
  });
} else {
  admin.initializeApp({
    projectId: projectId
  });
}

const db = admin.firestore();

async function migrateConfigFields() {
  try {
    console.log('\n=== Starting Config Field Migration ===\n');

    // Get current config document
    const configRef = db.collection('agent').doc('config');
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      console.error('ERROR: agent/config document does not exist');
      process.exit(1);
    }

    const currentData = configDoc.data();
    console.log('Current fields:', Object.keys(currentData));
    console.log('\nCurrent data (secrets masked):');
    Object.keys(currentData).forEach(key => {
      if (key.toLowerCase().includes('secret') || key.toLowerCase().includes('key')) {
        console.log(`  ${key}: ***MASKED***`);
      } else {
        console.log(`  ${key}:`, currentData[key]);
      }
    });

    // Build migration map
    const updates = {};
    const fieldsToDelete = [];

    // Migrate JWT_SECRET -> jwtSecret
    if (currentData.JWT_SECRET && !currentData.jwtSecret) {
      updates.jwtSecret = currentData.JWT_SECRET;
      fieldsToDelete.push('JWT_SECRET');
      console.log('\n✓ Will migrate: JWT_SECRET -> jwtSecret');
    }

    // Generate sessionSecret if missing
    if (!currentData.sessionSecret) {
      updates.sessionSecret = crypto.randomBytes(32).toString('hex');
      console.log('✓ Will generate: sessionSecret (missing)');
    }

    // Ensure these fields are uppercase (they should already be)
    const uppercaseFields = ['AGENT_NAME', 'GEMINI_API_KEY', 'GEMINI_MODEL'];
    uppercaseFields.forEach(field => {
      if (currentData[field]) {
        console.log(`✓ Field already correct: ${field}`);
      } else {
        console.log(`⚠ Warning: Missing field: ${field}`);
      }
    });

    // Check if any updates are needed
    if (Object.keys(updates).length === 0 && fieldsToDelete.length === 0) {
      console.log('\n✅ No migration needed - all fields are correct');
      process.exit(0);
    }

    // Show what will be updated
    console.log('\n=== Migration Plan ===');
    console.log('Fields to add/update:', Object.keys(updates));
    console.log('Fields to delete:', fieldsToDelete);

    // Perform the migration
    console.log('\n=== Applying Migration ===');

    // Add/update fields
    if (Object.keys(updates).length > 0) {
      await configRef.update(updates);
      console.log('✓ Fields updated');
    }

    // Delete old fields
    for (const field of fieldsToDelete) {
      await configRef.update({
        [field]: admin.firestore.FieldValue.delete()
      });
      console.log(`✓ Deleted old field: ${field}`);
    }

    // Verify migration
    console.log('\n=== Verifying Migration ===');
    const updatedDoc = await configRef.get();
    const updatedData = updatedDoc.data();

    console.log('Updated fields:', Object.keys(updatedData));

    // Check required fields
    const requiredFields = ['jwtSecret', 'sessionSecret', 'AGENT_NAME', 'GEMINI_API_KEY', 'GEMINI_MODEL'];
    const missing = requiredFields.filter(f => !updatedData[f]);

    if (missing.length > 0) {
      console.log('\n⚠ WARNING: Still missing required fields:', missing);
    } else {
      console.log('\n✅ Migration completed successfully!');
      console.log('All required fields are present.');
    }

    console.log('\n=== Migration Complete ===\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

// Run migration
migrateConfigFields()
  .then(() => {
    console.log('Exiting...');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
