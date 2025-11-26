/**
 * Bluesky Firestore Setup Script
 *
 * Creates Firestore collections and documents required for Bluesky integration.
 * Run this script before enabling Bluesky features.
 *
 * Collections created:
 * - bluesky-credentials: Encrypted authentication data
 * - bluesky-followed-profiles: Tracking followed profiles
 * - bluesky-prospects: Marketing prospect data
 * - bluesky-posts: Post analytics and tracking
 * - bluesky-rate-limits: Rate limit tracking
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=your-project-id \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   node scripts/setupBskyFirestore.js
 */

const { initializeFirestore, getFirestore, getFieldValue } = require('../config/firestore');

async function setupBlueskyFirestore() {
  // Initialize Firestore first
  await initializeFirestore();

  const db = getFirestore();
  const FieldValue = getFieldValue();

  console.log('🚀 Setting up Bluesky Firestore collections...\n');

  try {
    // 1. Create bluesky-credentials collection
    console.log('📁 Creating bluesky-credentials collection...');
    const credRef = db.collection('bluesky-credentials').doc('auth');
    const credDoc = await credRef.get();

    if (!credDoc.exists) {
      await credRef.set({
        username: null,
        passwordHash: null,
        did: null,
        accessJwt: null,
        refreshJwt: null,
        sessionCreated: null,
        sessionExpiry: null,
        updated: FieldValue.serverTimestamp(),
        note: 'Placeholder document - will be populated on first login'
      });
      console.log('   ✅ Created bluesky-credentials/auth');
    } else {
      console.log('   ⚠️  bluesky-credentials/auth already exists');
    }

    // 2. Create bluesky-followed-profiles collection
    console.log('\n📁 Creating bluesky-followed-profiles collection...');
    const followedRef = db.collection('bluesky-followed-profiles').doc('_meta');
    const followedDoc = await followedRef.get();

    if (!followedDoc.exists) {
      await followedRef.set({
        collectionName: 'bluesky-followed-profiles',
        description: 'Tracks profiles followed by Morgan for persona matching',
        created: FieldValue.serverTimestamp(),
        fields: {
          did: 'string - Decentralized Identifier',
          handle: 'string - Bluesky handle',
          displayName: 'string - Profile display name',
          description: 'string - Profile bio',
          avatarUrl: 'string - Profile avatar URL',
          followedAt: 'timestamp - When followed',
          personaMatch: 'object - {personaId, personaName, matchScore, matchReason}',
          followersCount: 'number',
          followingCount: 'number',
          postsCount: 'number',
          followUri: 'string - Follow record URI'
        }
      });
      console.log('   ✅ Created bluesky-followed-profiles/_meta');
    } else {
      console.log('   ⚠️  bluesky-followed-profiles/_meta already exists');
    }

    // 3. Create bluesky-prospects collection
    console.log('\n📁 Creating bluesky-prospects collection...');
    const prospectsRef = db.collection('bluesky-prospects').doc('_meta');
    const prospectsDoc = await prospectsRef.get();

    if (!prospectsDoc.exists) {
      await prospectsRef.set({
        collectionName: 'bluesky-prospects',
        description: 'Marketing prospects identified from feed analysis',
        created: FieldValue.serverTimestamp(),
        fields: {
          did: 'string - Decentralized Identifier',
          handle: 'string - Bluesky handle',
          displayName: 'string - Profile display name',
          description: 'string - Profile bio',
          prospectScore: 'number (0-100) - AI qualification score',
          prospectReason: 'string - Why qualified as prospect',
          personaMatch: 'array - Matching persona IDs',
          recentPosts: 'array - Recent post objects',
          engagement: 'object - {likes, reposts, replies}',
          identifiedAt: 'timestamp - When identified',
          status: 'string - new|contacted|qualified|disqualified',
          notes: 'string - Manual notes'
        }
      });
      console.log('   ✅ Created bluesky-prospects/_meta');
    } else {
      console.log('   ⚠️  bluesky-prospects/_meta already exists');
    }

    // 4. Create bluesky-posts collection
    console.log('\n📁 Creating bluesky-posts collection...');
    const postsRef = db.collection('bluesky-posts').doc('_meta');
    const postsDoc = await postsRef.get();

    if (!postsDoc.exists) {
      await postsRef.set({
        collectionName: 'bluesky-posts',
        description: 'Tracks Morgan\'s Bluesky posts for analytics',
        created: FieldValue.serverTimestamp(),
        fields: {
          uri: 'string - Post URI',
          cid: 'string - Content ID',
          text: 'string - Post text',
          createdAt: 'timestamp - When created',
          youtubeVideoId: 'string - YouTube video ID (if generated from video)',
          targetPersonas: 'array - Target persona IDs',
          engagement: 'object - {likes, reposts, replies}',
          lastUpdated: 'timestamp - Last engagement update'
        }
      });
      console.log('   ✅ Created bluesky-posts/_meta');
    } else {
      console.log('   ⚠️  bluesky-posts/_meta already exists');
    }

    // 5. Create bluesky-rate-limits collection
    console.log('\n📁 Creating bluesky-rate-limits collection...');
    const rateLimitsRef = db.collection('bluesky-rate-limits').doc('daily-follows');
    const rateLimitsDoc = await rateLimitsRef.get();

    if (!rateLimitsDoc.exists) {
      await rateLimitsRef.set({
        date: new Date().toISOString().split('T')[0],
        count: 0,
        maxPerDay: 50,
        updated: FieldValue.serverTimestamp(),
        note: 'Tracks daily follow count for rate limiting'
      });
      console.log('   ✅ Created bluesky-rate-limits/daily-follows');
    } else {
      console.log('   ⚠️  bluesky-rate-limits/daily-follows already exists');
    }

    console.log('\n✅ Bluesky Firestore setup complete!\n');

    // Display collection summary
    console.log('📊 **Collection Summary:**\n');
    console.log('1. bluesky-credentials (1 doc)');
    console.log('   - Stores encrypted session tokens');
    console.log('   - Service account access only');
    console.log('');
    console.log('2. bluesky-followed-profiles (N docs)');
    console.log('   - Each doc is a followed profile');
    console.log('   - Document ID = profile DID');
    console.log('');
    console.log('3. bluesky-prospects (N docs)');
    console.log('   - Each doc is a marketing prospect');
    console.log('   - Auto-generated document IDs');
    console.log('');
    console.log('4. bluesky-posts (N docs)');
    console.log('   - Each doc is a Morgan post');
    console.log('   - Document ID = post URI');
    console.log('');
    console.log('5. bluesky-rate-limits (1 doc)');
    console.log('   - Tracks daily follow count');
    console.log('   - Resets automatically at midnight UTC');
    console.log('');

    console.log('💡 **Next Steps:**\n');
    console.log('1. Generate encryption key:');
    console.log('   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    console.log('');
    console.log('2. Add environment variables to Cloud Run:');
    console.log('   - ENABLE_BLUESKY_INTEGRATION=false (enable after testing)');
    console.log('   - BLUESKY_USERNAME=your-handle.bsky.social');
    console.log('   - BLUESKY_PASSWORD=app-password-from-bluesky');
    console.log('   - CREDENTIAL_ENCRYPTION_KEY=<generated-key>  (for all credential encryption)');
    console.log('');
    console.log('3. Create Bluesky app password:');
    console.log('   - Log into https://bsky.app');
    console.log('   - Settings → App Passwords → Add App Password');
    console.log('   - Name: "Morgan AI Agent"');
    console.log('');
    console.log('4. Deploy knowledge base documents:');
    console.log('   - node scripts/addKBToDb.js examples/knowledgeBase/customerPersonas.js');
    console.log('   - node scripts/addKBToDb.js examples/knowledgeBase/bskyMarketingGuide.js');
    console.log('');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Run setup
setupBlueskyFirestore();
