const admin = require('firebase-admin');
const embeddingService = require('../services/embeddingService');
const { loadTools, getToolRegistry } = require('../lib/toolLoader');
const { logger } = require('../utils/logger');

// Get database ID from environment (defaults to chantilly-agent-${AGENT_NAME})
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'chantilly-agent-${AGENT_NAME}';

/**
 * Generate embeddings for all registered tools
 *
 * This enables semantic tool trigger detection based on user intent
 * rather than keyword matching
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=cx-voice-backup-383016 \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID=chantilly-agent-${AGENT_NAME} \
 *   node scripts/generateToolEmbeddings.js
 */
async function generateToolEmbeddings() {
  const db = admin.firestore();

  // Load tools first
  await loadTools();
  const registry = getToolRegistry();
  const tools = registry.getAllTools();

  console.log('🚀 Generating tool embeddings...');
  console.log(`🔧 Using Firestore database: ${DATABASE_ID}`);
  console.log(`🔧 Found ${tools.length} registered tools\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const startTime = Date.now();

  for (const tool of tools) {
    try {
      // Check if embedding already exists
      const existingDoc = await db.collection('tool-embeddings').doc(tool.name).get();
      if (existingDoc.exists && existingDoc.data().embedding) {
        skipped++;
        console.log(`⏭️  [${processed + skipped + failed}/${tools.length}] Skipping "${tool.name}" - embedding exists`);
        continue;
      }

      // Construct comprehensive text representation of tool
      const triggerText = `
Tool: ${tool.name}
Description: ${tool.description}
Category: ${tool.category}
User Description: ${tool.userDescription || tool.description}
Priority: ${tool.priority || 50}
Typical Use Cases: ${getToolUseCases(tool.name)}
      `.trim();

      // Generate embedding
      const embedding = await embeddingService.embedQuery(
        triggerText,
        'SEMANTIC_SIMILARITY'
      );

      // Store in Firestore
      await db.collection('tool-embeddings').doc(tool.name).set({
        toolName: tool.name,
        description: tool.description,
        category: tool.category,
        priority: tool.priority || 50,
        embedding: admin.firestore.FieldValue.vector(embedding),
        embeddingGenerated: admin.firestore.FieldValue.serverTimestamp(),
        embeddingDimensions: embedding.length,
        embeddingModel: 'text-embedding-004',
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });

      processed++;
      console.log(`✅ [${processed + skipped + failed}/${tools.length}] Generated embedding for: "${tool.name}"`);

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
      failed++;
      console.error(`❌ [${processed + skipped + failed}/${tools.length}] Failed: "${tool.name}"`, error.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Tool embedding generation complete!\n');
  console.log('📊 Results:');
  console.log(`   - Processed: ${processed}`);
  console.log(`   - Skipped: ${skipped}`);
  console.log(`   - Failed: ${failed}`);
  console.log(`   - Duration: ${duration}s`);
  if (processed + failed > 0) {
    console.log(`   - Avg per tool: ${(duration / (processed + failed)).toFixed(2)}s`);
  }
  console.log('\n📈 Cache Statistics:');
  const cacheStats = embeddingService.getCacheStats();
  console.log(`   - Hit rate: ${cacheStats.hitRate}`);
  console.log(`   - Cache size: ${cacheStats.size}/${cacheStats.maxSize}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

/**
 * Get typical use cases for each tool
 */
function getToolUseCases(toolName) {
  const useCases = {
    'WebSearch': 'finding current information, latest news, real-time data',
    'KnowledgeManagement': 'searching documentation, finding policies, retrieving information',
    'ComplexTaskManager': 'creating reports, running analysis, multi-step workflows',
    'BitrixTranslationChannels': 'translating messages, broadcasting to multiple languages',
    'GoogleMapsPlaces': 'finding locations, getting directions, location information',
    'DrawioGenerator': 'creating diagrams, visualizing workflows, generating flowcharts',
    'BitrixChatSummary': 'summarizing conversations, analyzing chat history',
    'weather': 'getting weather forecasts, checking conditions',
    'reminder': 'creating tasks, setting reminders',
    'SimpleTaskCreator': 'quick task creation, simple todos',
    'TaskManagement': 'managing tasks, updating task status'
  };
  return useCases[toolName] || 'general tool operations';
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

// Use the configured database
const db = admin.firestore();
db.settings({ databaseId: DATABASE_ID });

generateToolEmbeddings()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Fatal error during tool embedding generation:', error);
    process.exit(1);
  });
