const admin = require('firebase-admin');
const embeddingService = require('../services/embeddingService');

// Get database ID from environment (defaults to chantilly-agent-${AGENT_NAME})
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'chantilly-agent-${AGENT_NAME}';

/**
 * Test vector search functionality
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=cx-voice-backup-383016 \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID=chantilly-agent-${AGENT_NAME} \
 *   node scripts/testVectorSearch.js
 */

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
}

const db = admin.firestore();
db.settings({ databaseId: DATABASE_ID });

async function testVectorSearch() {
  console.log('🔍 Testing vector search with user query...');
  console.log(`🔧 Using Firestore database: ${DATABASE_ID}\n`);

  // The actual user query from logs
  const userQuery = 'Review the chat messages in chat4028 and identify all messages from me that are erroneous, testing, or not helpful for deletion. Output the results as a CSV list in an HTML file with the message id and message text.';

  console.log('User Query:', userQuery);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Generate embedding for user query
  console.log('Generating embedding for user query...');
  const queryEmbedding = await embeddingService.embedQuery(
    userQuery,
    'RETRIEVAL_QUERY'
  );
  console.log(`✅ Generated ${queryEmbedding.length}-dimensional embedding\n`);

  // Perform vector search
  console.log('Performing vector search...');
  const vectorQuery = db.collection('task-templates')
    .where('enabled', '==', true)
    .findNearest({
      vectorField: 'embedding',
      queryVector: admin.firestore.FieldValue.vector(queryEmbedding),
      limit: 5,
      distanceMeasure: 'COSINE',
      distanceResultField: 'distance' // Tell Firestore to put distance in this field
    });

  const snapshot = await vectorQuery.get();

  if (snapshot.empty) {
    console.log('❌ No results found\n');
    return;
  }

  console.log(`✅ Found ${snapshot.size} results\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Display all results
  snapshot.forEach((doc, index) => {
    const data = doc.data();

    // Try different methods to get distance
    const distanceFromData = data.distance;
    const distanceFromMethod = doc.vectorDistance;
    const distanceFromGet = doc.get('distance');

    console.log(`${index + 1}. Template: ${data.name}`);
    console.log(`   ID: ${doc.id}`);
    console.log(`   Distance (data.distance): ${distanceFromData}`);
    console.log(`   Distance (doc.vectorDistance): ${distanceFromMethod}`);
    console.log(`   Distance (doc.get('distance')): ${distanceFromGet}`);
    console.log(`   All doc properties:`, Object.keys(doc));
    console.log(`   Description: ${(data.description || 'N/A').substring(0, 100)}...`);
    console.log('');
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Check the top match details
  const bestMatch = snapshot.docs[0];
  const bestData = bestMatch.data();

  console.log('🎯 TOP MATCH ANALYSIS:');
  console.log(`   Template: ${bestData.name}`);
  console.log(`   Distance from query: ${bestData.distance}`);
  console.log(`   Has embedding: ${!!bestData.embedding}`);
  console.log(`   Embedding dimensions: ${bestData.embeddingDimensions || 'unknown'}`);

  process.exit(0);
}

testVectorSearch().catch(error => {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
