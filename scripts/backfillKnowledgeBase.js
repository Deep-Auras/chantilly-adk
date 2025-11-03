const admin = require('firebase-admin');
const embeddingService = require('../services/embeddingService');
const { logger } = require('../utils/logger');

// Get database ID from environment (defaults to chantilly-agent-${AGENT_NAME})
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'chantilly-agent-${AGENT_NAME}';

/**
 * Backfill embeddings for existing knowledge base documents
 *
 * This script:
 * 1. Loads all enabled knowledge base documents
 * 2. Generates 768D embeddings for each (title + content)
 * 3. Updates Firestore documents with embeddings
 * 4. Implements rate limiting (60 requests/minute max)
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=cx-voice-backup-383016 \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID=chantilly-agent-${AGENT_NAME} \
 *   node scripts/backfillKnowledgeBase.js
 */
async function backfillKnowledgeBase() {
  const db = admin.firestore();

  const snapshot = await db.collection('knowledge-base')
    .where('enabled', '==', true)
    .get();

  console.log('🚀 Starting knowledge base backfill...');
  console.log(`📚 Using Firestore database: ${DATABASE_ID}`);
  console.log(`📚 Found ${snapshot.size} enabled documents\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const startTime = Date.now();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Skip if embedding already exists
    if (data.embedding) {
      skipped++;
      console.log(`⏭️  [${processed + skipped + failed}/${snapshot.size}] Skipping "${data.title}" - embedding exists`);
      continue;
    }

    try {
      // Generate embedding from title + content
      const textToEmbed = `${data.title}\n\n${data.content}`;
      const embedding = await embeddingService.embedQuery(
        textToEmbed,
        'RETRIEVAL_DOCUMENT'
      );

      // Update document with embedding
      await doc.ref.update({
        embedding: admin.firestore.FieldValue.vector(embedding),
        embeddingGenerated: admin.firestore.FieldValue.serverTimestamp(),
        embeddingDimensions: embedding.length,
        embeddingModel: 'text-embedding-004'
      });

      processed++;
      console.log(`✅ [${processed + skipped + failed}/${snapshot.size}] Generated embedding for: "${data.title}"`);

      // Rate limiting: 60 requests/minute max (1 per second)
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      failed++;
      console.error(`❌ [${processed + skipped + failed}/${snapshot.size}] Failed: "${data.title}"`, error.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Backfill complete!\n');
  console.log('📊 Results:');
  console.log(`   - Processed: ${processed}`);
  console.log(`   - Skipped: ${skipped}`);
  console.log(`   - Failed: ${failed}`);
  console.log(`   - Duration: ${duration}s`);
  console.log(`   - Avg per doc: ${(duration / (processed + failed)).toFixed(2)}s`);
  console.log('\n📈 Cache Statistics:');
  const cacheStats = embeddingService.getCacheStats();
  console.log(`   - Hit rate: ${cacheStats.hitRate}`);
  console.log(`   - Cache size: ${cacheStats.size}/${cacheStats.maxSize}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

// Use the configured database
const db = admin.firestore();
db.settings({ databaseId: DATABASE_ID });

backfillKnowledgeBase()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Fatal error during backfill:', error);
    process.exit(1);
  });
