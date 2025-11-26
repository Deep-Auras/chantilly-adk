/**
 * Unlock User Account Script
 *
 * Unlocks a locked user account and resets failed login attempts.
 * Optionally resets the password.
 *
 * Usage:
 *   # Just unlock the account
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=chantilly-agent-morgan \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   node scripts/unlockUser.js rrahman
 *
 *   # Unlock and reset password
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=chantilly-agent-morgan \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   node scripts/unlockUser.js rrahman NewPassword123!
 */

const bcrypt = require('bcryptjs');
const { initializeFirestore, getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');

async function unlockUser(username, newPassword = null) {
  try {
    // Initialize Firestore
    await initializeFirestore();
    const db = getFirestore();

    console.log(`🔓 Unlocking user: ${username}...`);

    // Get user document
    const userDoc = await db.collection('users').doc(username).get();

    if (!userDoc.exists) {
      console.error(`❌ User "${username}" not found`);
      process.exit(1);
    }

    const userData = userDoc.data();

    // Show current status
    console.log('\n📊 Current Account Status:');
    console.log(`   - Username: ${userData.username}`);
    console.log(`   - Email: ${userData.email}`);
    console.log(`   - Role: ${userData.role}`);
    console.log(`   - Locked: ${userData.locked ? 'YES ❌' : 'NO ✅'}`);
    console.log(`   - Failed Attempts: ${userData.failedAttempts}`);
    console.log(`   - Last Login: ${userData.lastLogin ? userData.lastLogin.toDate() : 'Never'}`);

    // Prepare update data
    const updateData = {
      locked: false,
      failedAttempts: 0,
      updatedAt: getFieldValue().serverTimestamp()
    };

    // Reset password if provided
    if (newPassword) {
      console.log('\n🔑 Resetting password...');

      // Validate password strength
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
      if (!passwordRegex.test(newPassword)) {
        console.error('❌ Password does not meet requirements:');
        console.error('   - At least 8 characters');
        console.error('   - One uppercase letter');
        console.error('   - One lowercase letter');
        console.error('   - One number');
        console.error('   - One special character (@$!%*?&)');
        process.exit(1);
      }

      // Hash password with secure work factor (12 rounds)
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      updateData.password = hashedPassword;
      updateData.passwordChangedAt = getFieldValue().serverTimestamp();
    }

    // Update user document
    await db.collection('users').doc(username).update(updateData);

    // Log the unlock event
    await db.collection('auth_logs').add({
      username,
      event: 'account_unlocked_via_script',
      success: true,
      timestamp: getFieldValue().serverTimestamp(),
      passwordReset: !!newPassword
    });

    console.log('\n✅ Account unlocked successfully!');
    if (newPassword) {
      console.log('✅ Password reset successfully!');
    }

    console.log('\n📋 Updated Account Status:');
    console.log(`   - Locked: NO ✅`);
    console.log(`   - Failed Attempts: 0`);
    if (newPassword) {
      console.log(`   - Password: Updated`);
    }

    console.log('\n🎉 You can now login with:');
    console.log(`   - Username: ${username}`);
    if (newPassword) {
      console.log(`   - Password: [newly set password]`);
    } else {
      console.log(`   - Password: [your existing password]`);
    }

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Failed to unlock user:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Get command line arguments
const args = process.argv.slice(2);
const username = args[0];
const newPassword = args[1];

if (!username) {
  console.error('❌ Usage: node scripts/unlockUser.js <username> [newPassword]');
  console.error('\nExamples:');
  console.error('  # Just unlock account:');
  console.error('  node scripts/unlockUser.js rrahman');
  console.error('');
  console.error('  # Unlock and reset password:');
  console.error('  node scripts/unlockUser.js rrahman NewPassword123!');
  process.exit(1);
}

// Run unlock
unlockUser(username, newPassword);
