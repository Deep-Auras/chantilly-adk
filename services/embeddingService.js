const { VertexAIEmbeddings } = require('@langchain/google-vertexai');
const { logger } = require('../utils/logger');
const { getVertexAILocation } = require('../config/gemini');

/**
 * EmbeddingService - Centralized embedding generation with caching
 *
 * Features:
 * - text-embedding-004 (768 dimensions, optimized for English)
 * - In-memory caching (1 hour TTL, max 1000 entries)
 * - LRU cache eviction
 * - Support for different task types (query, document, similarity)
 * - Cache statistics tracking
 */
class EmbeddingService {
  constructor() {
    this.embeddings = null; // Lazy initialized
    this.initialized = false;

    // Multi-tier caching for cost optimization
    this.cache = new Map(); // In-memory cache
    this.cacheMaxSize = 1000; // Max cached embeddings
    this.cacheMaxAge = 3600000; // 1 hour TTL
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Performance metrics for Week 4 monitoring
    this.latencies = []; // Rolling window of last 1000 latencies
    this.maxLatencyWindow = 1000;
    this.successCount = 0;
    this.errorCount = 0;
    this.taskTypeStats = {}; // Track usage by task type
    this.metricsReportInterval = 3600000; // Report every hour
    this.lastMetricsReport = Date.now();

    logger.info('EmbeddingService constructor called (lazy init)');
  }

  /**
   * Initialize embeddings client with config from Firestore
   */
  _ensureInitialized() {
    if (!this.initialized) {
      const location = getVertexAILocation();
      this.embeddings = new VertexAIEmbeddings({
        model: 'text-embedding-004',
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: location
      });
      this.initialized = true;

      logger.info('EmbeddingService initialized', {
        model: 'text-embedding-004',
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: location,
        cacheMaxSize: this.cacheMaxSize,
        cacheTTL: `${this.cacheMaxAge / 1000}s`,
        metricsEnabled: true
      });
    }
  }

  /**
   * Generate embedding for a single text with intelligent caching
   * @param {string} text - Text to embed
   * @param {string} taskType - RETRIEVAL_QUERY, RETRIEVAL_DOCUMENT, or SEMANTIC_SIMILARITY
   * @returns {Promise<number[]>} 768-dimensional vector
   */
  async embedQuery(text, taskType = 'RETRIEVAL_QUERY') {
    this._ensureInitialized();

    if (!text || typeof text !== 'string') {
      throw new Error('Text must be a non-empty string');
    }

    const cacheKey = `${taskType}:${text.trim().toLowerCase()}`;

    // Check cache
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheMaxAge) {
        this.cacheHits++;
        logger.debug('Embedding cache hit', {
          text: text.substring(0, 50) + '...',
          cacheHitRate: this.getCacheHitRate(),
          taskType
        });
        return cached.vector;
      } else {
        // Cache entry expired, remove it
        this.cache.delete(cacheKey);
      }
    }

    this.cacheMisses++;

    try {
      const startTime = Date.now();

      // Generate embedding with Vertex AI
      const vector = await this.embeddings.embedQuery(text);

      const duration = Date.now() - startTime;

      // Record performance metrics
      this.recordMetrics(duration, taskType, true);

      // Cache the result
      this.cache.set(cacheKey, {
        vector: vector,
        timestamp: Date.now()
      });

      // Cleanup cache if too large (LRU eviction)
      if (this.cache.size > this.cacheMaxSize) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
        logger.debug('Cache evicted oldest entry', { cacheSize: this.cache.size });
      }

      logger.info('Embedding generated', {
        dimensions: vector.length,
        taskType,
        duration: `${duration}ms`,
        text: text.substring(0, 50) + '...',
        cacheSize: this.cache.size,
        cacheHitRate: this.getCacheHitRate()
      });

      // Check if it's time to report periodic metrics
      this.checkPeriodicMetricsReport();

      return vector;
    } catch (error) {
      // Record error metrics
      this.recordMetrics(0, taskType, false);

      logger.error('Embedding generation failed', {
        error: error.message,
        text: text.substring(0, 100),
        taskType
      });
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple documents (batch optimization)
   * @param {string[]} documents - Array of document texts
   * @returns {Promise<number[][]>} Array of 768-dimensional vectors
   */
  async embedDocuments(documents) {
    this._ensureInitialized();

    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error('Documents must be a non-empty array');
    }

    try {
      const startTime = Date.now();

      const vectors = await this.embeddings.embedDocuments(documents);

      const duration = Date.now() - startTime;

      logger.info('Batch embeddings generated', {
        count: documents.length,
        duration: `${duration}ms`,
        avgPerDoc: `${(duration / documents.length).toFixed(2)}ms`
      });

      return vectors;
    } catch (error) {
      logger.error('Batch embedding generation failed', {
        error: error.message,
        documentCount: documents.length
      });
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two embeddings
   * @param {number[]} embedding1 - First embedding vector
   * @param {number[]} embedding2 - Second embedding vector
   * @returns {number} Cosine similarity score (0-1)
   */
  cosineSimilarity(embedding1, embedding2) {
    if (!embedding1 || !embedding2 || embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same dimensions');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    return similarity;
  }

  /**
   * Get cache hit rate as percentage
   * @returns {string} Cache hit rate (e.g., "85.50%")
   */
  getCacheHitRate() {
    const totalRequests = this.cacheHits + this.cacheMisses;
    if (totalRequests === 0) {return '0.00%';}
    return ((this.cacheHits / totalRequests) * 100).toFixed(2) + '%';
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    const totalRequests = this.cacheHits + this.cacheMisses;
    return {
      size: this.cache.size,
      maxSize: this.cacheMaxSize,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      totalRequests: totalRequests,
      hitRate: this.getCacheHitRate(),
      utilization: ((this.cache.size / this.cacheMaxSize) * 100).toFixed(2) + '%'
    };
  }

  /**
   * Clear the cache (useful for testing or memory management)
   */
  clearCache() {
    const previousSize = this.cache.size;
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;

    logger.info('Cache cleared', {
      previousSize,
      clearedEntries: previousSize
    });
  }

  /**
   * Get cache entry count
   * @returns {number} Number of cached embeddings
   */
  getCacheSize() {
    return this.cache.size;
  }

  /**
   * Record performance metrics for monitoring
   * @param {number} latency - Request latency in milliseconds
   * @param {string} taskType - Type of embedding task
   * @param {boolean} success - Whether the request succeeded
   */
  recordMetrics(latency, taskType, success) {
    // Track success/error counts
    if (success) {
      this.successCount++;
    } else {
      this.errorCount++;
    }

    // Track latencies (rolling window)
    if (success && latency > 0) {
      this.latencies.push(latency);
      if (this.latencies.length > this.maxLatencyWindow) {
        this.latencies.shift(); // Remove oldest
      }
    }

    // Track task type distribution
    if (!this.taskTypeStats[taskType]) {
      this.taskTypeStats[taskType] = { count: 0, totalLatency: 0 };
    }
    this.taskTypeStats[taskType].count++;
    if (success && latency > 0) {
      this.taskTypeStats[taskType].totalLatency += latency;
    }
  }

  /**
   * Calculate percentile from latency array
   * @param {number} percentile - Percentile to calculate (0-100)
   * @returns {number|null} Latency at percentile or null if no data
   */
  calculatePercentile(percentile) {
    if (this.latencies.length === 0) {return null;}

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Get comprehensive performance metrics
   * @returns {Object} Performance metrics including latencies, error rate, task types
   */
  getPerformanceMetrics() {
    const totalRequests = this.successCount + this.errorCount;
    const errorRate = totalRequests > 0 ? ((this.errorCount / totalRequests) * 100).toFixed(2) + '%' : '0.00%';

    const latencyStats = this.latencies.length > 0 ? {
      p50: this.calculatePercentile(50),
      p95: this.calculatePercentile(95),
      p99: this.calculatePercentile(99),
      avg: Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length),
      min: Math.min(...this.latencies),
      max: Math.max(...this.latencies),
      count: this.latencies.length
    } : null;

    const taskTypeBreakdown = {};
    for (const [taskType, stats] of Object.entries(this.taskTypeStats)) {
      taskTypeBreakdown[taskType] = {
        count: stats.count,
        avgLatency: stats.count > 0 ? Math.round(stats.totalLatency / stats.count) : 0
      };
    }

    return {
      requests: {
        total: totalRequests,
        successful: this.successCount,
        failed: this.errorCount,
        errorRate: errorRate
      },
      latency: latencyStats,
      taskTypes: taskTypeBreakdown,
      cache: this.getCacheStats()
    };
  }

  /**
   * Check if it's time to report periodic metrics and log them
   */
  checkPeriodicMetricsReport() {
    const now = Date.now();
    if (now - this.lastMetricsReport >= this.metricsReportInterval) {
      const metrics = this.getPerformanceMetrics();

      logger.info('Embedding Service Performance Report', {
        reportInterval: `${this.metricsReportInterval / 60000} minutes`,
        ...metrics
      });

      this.lastMetricsReport = now;
    }
  }

  /**
   * Reset performance metrics (useful for testing or after deployment)
   */
  resetMetrics() {
    this.latencies = [];
    this.successCount = 0;
    this.errorCount = 0;
    this.taskTypeStats = {};
    this.lastMetricsReport = Date.now();

    logger.info('Performance metrics reset');
  }
}

// Export singleton instance
module.exports = new EmbeddingService();
