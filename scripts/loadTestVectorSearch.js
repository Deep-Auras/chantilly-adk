const admin = require('firebase-admin');
const embeddingService = require('../services/embeddingService');
const { logger } = require('../utils/logger');

// Get database ID from environment (defaults to chantilly-agent-${AGENT_NAME})
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || 'chantilly-agent-${AGENT_NAME}';

/**
 * Load Test for Vector Search Performance
 *
 * Tests embedding generation and caching with 100 realistic queries
 * Measures latency, error rates, cache performance
 *
 * Success Criteria:
 * - P95 Latency < 500ms
 * - Zero errors
 * - Cache hit rate > 50%
 *
 * Usage:
 *   NODE_ENV=test \
 *   GOOGLE_CLOUD_PROJECT=cx-voice-backup-383016 \
 *   GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
 *   FIRESTORE_DATABASE_ID=chantilly-agent-${AGENT_NAME} \
 *   node scripts/loadTestVectorSearch.js
 */

const testQueries = [
  // Knowledge base queries (30)
  'How do I request time off?',
  'What\'s the vacation policy?',
  'How to submit an expense report?',
  'What are the company benefits?',
  'How to reset my password?',
  'Where can I find the employee handbook?',
  'What\'s the process for requesting equipment?',
  'How do I report a workplace issue?',
  'Tell me about the XRP event',
  'What\'s the cryptocurrency walking event?',
  'When is the New York XRP walk?',
  'How do I integrate with Bitrix24 API?',
  'What are the Bitrix24 rate limits?',
  'How to create Bitrix24 webhooks?',
  'Explain Bitrix24 authentication',
  'What\'s the route planning guide?',
  'How to use Google Maps API?',
  'Tell me about payment processing',
  'How do invoices work?',
  'What\'s the billing process?',
  'Customer transaction procedures',
  'Show me information about policies',
  'Company procedures and guidelines',
  'IT support documentation',
  'Network access instructions',
  'Database connection info',
  'Deployment procedures',
  'CI/CD pipeline setup',
  'Testing guidelines',
  'Code review process',

  // Task template queries (20)
  'Create quarterly financial report',
  'Generate sales analysis',
  'Build customer feedback summary',
  'Make invoice report',
  'Produce monthly statistics',
  'Create project status update',
  'Generate performance metrics',
  'Build compliance report',
  'Make expense summary',
  'Produce audit documentation',
  'Create risk assessment',
  'Generate quality report',
  'Build training materials',
  'Make onboarding checklist',
  'Produce meeting minutes',
  'Create workflow diagram',
  'Generate process documentation',
  'Build technical specification',
  'Make user guide',
  'Produce system architecture',

  // Tool trigger queries (20)
  'What\'s the weather forecast?',
  'Search the web for latest news',
  'Find current Bitcoin price',
  'Look up recent AI developments',
  'Translate this to Spanish',
  'Send message to all teams',
  'Broadcast to international channels',
  'Create a reminder for tomorrow',
  'Add task to project',
  'Schedule meeting next week',
  'Find directions to venue',
  'Show me location details',
  'Get place information',
  'Search for nearby restaurants',
  'What\'s the event location?',
  'Summarize our chat discussion',
  'Review last 50 messages',
  'Analyze conversation topics',
  'Create diagram from notes',
  'Visualize this process',

  // Semantic variation tests (30)
  'vacation time request procedure',
  'PTO policy information',
  'paid leave guidelines',
  'time away from work process',
  'crypto event in NYC',
  'blockchain walking marathon',
  'XRP community meetup details',
  'digital currency walk event',
  'API integration instructions',
  'connecting to Bitrix system',
  'webhook setup tutorial',
  'REST API authentication',
  'financial summary generation',
  'quarterly earnings report',
  'revenue analysis creation',
  'fiscal period documentation',
  'current meteorological conditions',
  'temperature prediction service',
  'climate forecast retrieval',
  'weather information lookup',
  'internet search capability',
  'online information retrieval',
  'web data lookup service',
  'search engine integration',
  'language conversion service',
  'multilingual message distribution',
  'international communication tools',
  'translation broadcast system',
  'visual workflow representation',
  'process flowchart creation'
];

async function loadTest() {
  console.log('🚀 Starting vector search load test...');
  console.log(`🔧 Using Firestore database: ${DATABASE_ID}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const results = {
    totalQueries: testQueries.length,
    successCount: 0,
    failureCount: 0,
    latencies: [],
    errors: []
  };

  const startTime = Date.now();

  for (let i = 0; i < testQueries.length; i++) {
    const query = testQueries[i];
    const queryStartTime = Date.now();

    try {
      // Test embedding generation
      const embedding = await embeddingService.embedQuery(query, 'RETRIEVAL_QUERY');
      const latency = Date.now() - queryStartTime;

      results.successCount++;
      results.latencies.push(latency);

      if ((i + 1) % 10 === 0) {
        console.log(`✅ Progress: ${i + 1}/${testQueries.length} queries processed (avg: ${(results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length).toFixed(0)}ms)`);
      }

    } catch (error) {
      results.failureCount++;
      results.errors.push({
        query,
        error: error.message
      });
      console.error(`❌ Failed query ${i + 1}: ${query} - ${error.message}`);
    }

    // Rate limiting: 1 query per 100ms (10 QPS max)
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  // Calculate statistics
  if (results.latencies.length > 0) {
    results.latencies.sort((a, b) => a - b);
    const p50 = results.latencies[Math.floor(results.latencies.length * 0.5)];
    const p95 = results.latencies[Math.floor(results.latencies.length * 0.95)];
    const p99 = results.latencies[Math.floor(results.latencies.length * 0.99)];
    const avg = results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length;
    const max = Math.max(...results.latencies);
    const min = Math.min(...results.latencies);

    // Get cache stats
    const cacheStats = embeddingService.getCacheStats();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 Load Test Results');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('📈 Query Statistics:');
    console.log(`   Total Queries: ${results.totalQueries}`);
    console.log(`   Success: ${results.successCount}`);
    console.log(`   Failures: ${results.failureCount}`);
    console.log(`   Duration: ${totalDuration}s`);
    console.log(`   Throughput: ${(results.totalQueries / parseFloat(totalDuration)).toFixed(2)} queries/sec\n`);

    console.log('⚡ Latency Statistics:');
    console.log(`   Average: ${avg.toFixed(2)}ms`);
    console.log(`   Min: ${min}ms`);
    console.log(`   Max: ${max}ms`);
    console.log(`   P50 (median): ${p50}ms`);
    console.log(`   P95: ${p95}ms`);
    console.log(`   P99: ${p99}ms\n`);

    console.log('💾 Cache Performance:');
    console.log(`   Hit Rate: ${cacheStats.hitRate}`);
    console.log(`   Cache Size: ${cacheStats.size}/${cacheStats.maxSize}`);
    console.log(`   Cache Hits: ${cacheStats.hits}`);
    console.log(`   Cache Misses: ${cacheStats.misses}\n`);

    if (results.failureCount > 0) {
      console.log('❌ Errors Encountered:');
      results.errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. "${err.query}" - ${err.error}`);
      });
      console.log('');
    }

    // Success criteria check
    const passedLatency = p95 < 500; // P95 < 500ms
    const passedErrors = results.failureCount === 0;
    const cacheHitRate = parseFloat(cacheStats.hitRate);
    const passedCache = cacheHitRate > 50; // >50% cache hit rate

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Success Criteria');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`   ${passedLatency ? '✅' : '❌'} P95 Latency < 500ms: ${p95}ms`);
    console.log(`   ${passedErrors ? '✅' : '❌'} Zero Errors: ${results.failureCount} failures`);
    console.log(`   ${passedCache ? '✅' : '❌'} Cache Hit Rate > 50%: ${cacheStats.hitRate}\n`);

    const allPassed = passedLatency && passedErrors && passedCache;
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(allPassed ? '✅ ALL TESTS PASSED!' : '❌ SOME TESTS FAILED!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (!allPassed) {
      console.log('📋 Recommendations:');
      if (!passedLatency) {
        console.log('   - P95 latency too high. Check Vertex AI quota limits.');
        console.log('   - Consider increasing cache size or TTL.');
      }
      if (!passedErrors) {
        console.log('   - Errors detected. Review error messages above.');
        console.log('   - Check Vertex AI API status and credentials.');
      }
      if (!passedCache) {
        console.log('   - Low cache hit rate. Consider:');
        console.log('     • Increasing cache size (current: 1000)');
        console.log('     • Increasing TTL (current: 1 hour)');
        console.log('     • Adding query normalization');
      }
      console.log('');
    }

    return {
      passed: allPassed,
      metrics: {
        latency: { avg, p50, p95, p99, min, max },
        errors: results.failureCount,
        cache: cacheStats,
        duration: totalDuration
      }
    };
  } else {
    console.log('❌ No successful queries to analyze');
    return { passed: false };
  }
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

loadTest()
  .then((result) => {
    process.exit(result.passed ? 0 : 1);
  })
  .catch(error => {
    console.error('\n❌ Fatal error during load test:', error);
    process.exit(1);
  });
