const admin = require('firebase-admin');
const embeddingService = require('../services/embeddingService');
const { logger } = require('../utils/logger');

// Get database ID from environment (defaults to chantilly-agent-${AGENT_NAME})
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'chantilly-agent-${AGENT_NAME}';

/**
 * Backfill embeddings for task templates
 *
 * Generates TWO embeddings per template using SEMANTIC_SIMILARITY task type:
 * - nameEmbedding: Generated from template name only (for exact matching)
 * - embedding: Generated from name + description (for semantic search)
 *
 * This matches the dual-embedding generation in models/taskTemplates.js for consistency
 *
 * Run this script after:
 * - Upgrading from version without embeddings
 * - Upgrading to dual-embedding system
 * - Manually creating templates directly in Firestore
 * - Detecting templates that fail to match in semantic search
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=cx-voice-backup-383016 \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID=chantilly-agent-${AGENT_NAME} \
 *   node scripts/backfillTaskTemplates.js
 */
async function backfillTaskTemplates() {
  const db = admin.firestore();

  const snapshot = await db.collection('task-templates').get();

  console.log('🚀 Starting task template backfill...');
  console.log(`📋 Using Firestore database: ${DATABASE_ID}`);
  console.log(`📋 Found ${snapshot.size} templates\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const startTime = Date.now();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    // Check if BOTH embeddings exist
    if (data.embedding && data.nameEmbedding) {
      skipped++;
      console.log(`⏭️  [${processed + skipped + failed}/${snapshot.size}] Skipping "${data.name}" - both embeddings exist`);
      continue;
    }

    try {
      const templateName = data.name || '';
      const embeddingText = `${templateName} ${data.description || ''}`.trim();

      if (!templateName) {
        console.log(`⚠️  [${processed + skipped + failed}/${snapshot.size}] Skipping "${doc.id}" - no name`);
        skipped++;
        continue;
      }

      // PHASE 1: Generate name-only embedding (for exact matching)
      let nameEmbedding = null;
      if (!data.nameEmbedding) {
        nameEmbedding = await embeddingService.embedQuery(
          templateName,
          'SEMANTIC_SIMILARITY'
        );
        console.log(`   📝 Generated nameEmbedding for: "${templateName}"`);
      }

      // PHASE 2: Generate full-text embedding (for semantic search)
      let embedding = null;
      if (!data.embedding && embeddingText) {
        embedding = await embeddingService.embedQuery(
          embeddingText,
          'SEMANTIC_SIMILARITY'
        );
        console.log(`   📄 Generated full embedding for: "${templateName}"`);
      }

      // Update Firestore with both embeddings
      const updateData = {
        embeddingGenerated: admin.firestore.FieldValue.serverTimestamp(),
        embeddingModel: 'text-embedding-004'
      };

      if (nameEmbedding) {
        updateData.nameEmbedding = admin.firestore.FieldValue.vector(nameEmbedding);
        updateData.nameEmbeddingDimensions = nameEmbedding.length;
      }

      if (embedding) {
        updateData.embedding = admin.firestore.FieldValue.vector(embedding);
        updateData.embeddingDimensions = embedding.length;
      }

      await doc.ref.update(updateData);

      processed++;
      console.log(`✅ [${processed + skipped + failed}/${snapshot.size}] Generated embeddings for: "${data.name}"`);

      // Rate limiting (1 second per template for 2 API calls)
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      failed++;
      console.error(`❌ [${processed + skipped + failed}/${snapshot.size}] Failed: "${data.name}"`, error.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Task template backfill complete!\n');
  console.log('📊 Results:');
  console.log(`   - Processed: ${processed}`);
  console.log(`   - Skipped: ${skipped}`);
  console.log(`   - Failed: ${failed}`);
  console.log(`   - Duration: ${duration}s`);
  if (processed + failed > 0) {
    console.log(`   - Avg per template: ${(duration / (processed + failed)).toFixed(2)}s`);
  }
  console.log('\n📈 Cache Statistics:');
  const cacheStats = embeddingService.getCacheStats();
  console.log(`   - Hit rate: ${cacheStats.hitRate}`);
  console.log(`   - Cache size: ${cacheStats.size}/${cacheStats.maxSize}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

// Use the configured database
const db = admin.firestore();
db.settings({ databaseId: DATABASE_ID });

backfillTaskTemplates()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Fatal error during backfill:', error);
    process.exit(1);
  });
