/**
 * Setup Google Chat Notification Space for Asana Task Updates
 *
 * Phase 12: Configure Firestore document for Google Chat notifications
 *
 * Usage:
 * NODE_ENV=test \
 * GOOGLE_CLOUD_PROJECT=<your-project-id> \
 * GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 * node scripts/setupGoogleChatNotifications.js spaces/AAAA1234567
 */

const { getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');

async function setupGoogleChatNotifications(spaceId) {
  if (!spaceId || !spaceId.startsWith('spaces/')) {
    throw new Error(
      'Invalid space ID. Format should be: spaces/AAAA1234567\n\n' +
      'How to get Space ID:\n' +
      '1. Open Google Chat\n' +
      '2. Navigate to the space where Morgan should send notifications\n' +
      '3. Copy space ID from URL: https://mail.google.com/chat/u/0/#chat/space/AAAA1234567\n' +
      '4. Use: spaces/AAAA1234567'
    );
  }

  try {
    const db = getFirestore();
    const FieldValue = getFieldValue();

    logger.info('Setting up Google Chat notification space', { spaceId });

    // Create tool-settings document for AsanaNotifications
    await db.collection('tool-settings').doc('AsanaNotifications').set({
      googleChatSpaceId: spaceId,
      enabled: true,
      notifyOnSuccess: true,
      notifyOnFailure: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    logger.info('✅ Google Chat notification space configured successfully');
    logger.info('Configuration', {
      spaceId,
      notifyOnSuccess: true,
      notifyOnFailure: true
    });

    console.log('\n✅ Setup Complete!');
    console.log('====================');
    console.log(`Space ID: ${spaceId}`);
    console.log('Notify on Success: Enabled');
    console.log('Notify on Failure: Enabled');
    console.log('\nMorgan will now send Asana task notifications to this Google Chat space.');
    console.log('\nTo verify: Check Firestore collection "tool-settings" → document "AsanaNotifications"');

    process.exit(0);
  } catch (error) {
    logger.error('Failed to setup Google Chat notifications', { error: error.message });
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

// Get space ID from command line argument
const spaceId = process.argv[2];

if (!spaceId) {
  console.error('❌ Error: Space ID required\n');
  console.log('Usage:');
  console.log('  node scripts/setupGoogleChatNotifications.js spaces/AAAA1234567\n');
  console.log('How to get Space ID:');
  console.log('  1. Open Google Chat');
  console.log('  2. Navigate to the space where Morgan should send notifications');
  console.log('  3. Copy space ID from URL: https://mail.google.com/chat/u/0/#chat/space/AAAA1234567');
  console.log('  4. Run: node scripts/setupGoogleChatNotifications.js spaces/AAAA1234567');
  process.exit(1);
}

setupGoogleChatNotifications(spaceId);
