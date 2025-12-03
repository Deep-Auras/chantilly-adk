const { logger } = require('./logger');
const { getFirestore } = require('../config/firestore');

/**
 * Feature Flag System
 *
 * Simple on/off switches for vector search features.
 * All features loaded from Firestore agent/config document.
 *
 * Firestore fields (all default to true):
 * - enableVectorSearch: Enable vector search
 * - enableSemanticTemplates: Enable semantic template matching
 * - enableSemanticTools: Enable semantic tool detection
 */
class FeatureFlags {
  static cache = null;
  static cacheTimestamp = 0;
  static CACHE_TTL = 60000; // 1 minute cache

  /**
   * Load feature flags from Firestore with caching
   * @returns {Promise<object>} Feature flag configuration
   */
  static async loadFlags() {
    const now = Date.now();

    // Return cached value if still valid
    if (this.cache && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      return this.cache;
    }

    try {
      const db = getFirestore();
      const configDoc = await db.collection('agent').doc('config').get();

      if (!configDoc.exists) {
        // Default all features enabled
        this.cache = {
          enableVectorSearch: true,
          enableSemanticTemplates: true,
          enableSemanticTools: true
        };
      } else {
        const config = configDoc.data();
        this.cache = {
          enableVectorSearch: config.enableVectorSearch !== false,
          enableSemanticTemplates: config.enableSemanticTemplates !== false,
          enableSemanticTools: config.enableSemanticTools !== false
        };
      }

      this.cacheTimestamp = now;
      return this.cache;
    } catch (error) {
      logger.error('Failed to load feature flags from Firestore', { error: error.message });
      // Default to enabled on error
      return {
        enableVectorSearch: true,
        enableSemanticTemplates: true,
        enableSemanticTools: true
      };
    }
  }

  /**
   * Check if vector search should be enabled
   * @returns {Promise<boolean>} True if vector search should be used
   */
  static async shouldUseVectorSearch() {
    const flags = await this.loadFlags();
    if (!flags.enableVectorSearch) {
      logger.debug('Vector search disabled');
    }
    return flags.enableVectorSearch;
  }

  /**
   * Check if semantic template matching should be enabled
   * @returns {Promise<boolean>} True if semantic templates should be used
   */
  static async shouldUseSemanticTemplates() {
    const flags = await this.loadFlags();
    if (!flags.enableSemanticTemplates) {
      logger.debug('Semantic templates disabled');
    }
    return flags.enableSemanticTemplates;
  }

  /**
   * Check if semantic tool triggers should be enabled
   * @returns {Promise<boolean>} True if semantic tools should be used
   */
  static async shouldUseSemanticTools() {
    const flags = await this.loadFlags();
    if (!flags.enableSemanticTools) {
      logger.debug('Semantic tools disabled');
    }
    return flags.enableSemanticTools;
  }

  /**
   * Get all feature flag states for monitoring/debugging
   * @returns {Promise<object>} Current feature flag configuration
   */
  static async getFeatureStates() {
    const flags = await this.loadFlags();
    return {
      vectorSearch: {
        enabled: flags.enableVectorSearch
      },
      semanticTemplates: {
        enabled: flags.enableSemanticTemplates
      },
      semanticTools: {
        enabled: flags.enableSemanticTools
      }
    };
  }

  /**
   * Log feature flag status for debugging
   */
  static async logStatus() {
    const states = await this.getFeatureStates();
    logger.info('Feature flag status', states);
  }

  /**
   * Clear cache (useful for testing or immediate config reload)
   */
  static clearCache() {
    this.cache = null;
    this.cacheTimestamp = 0;
  }
}

module.exports = { FeatureFlags };
