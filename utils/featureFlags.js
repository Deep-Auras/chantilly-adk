const { logger } = require('./logger');

/**
 * Feature Flag System
 *
 * Simple on/off switches for vector search features.
 * All features are fully rolled out (100%).
 *
 * Environment Variables:
 * - ENABLE_VECTOR_SEARCH: Enable vector search (default: true)
 * - ENABLE_SEMANTIC_TEMPLATES: Enable semantic template matching (default: true)
 * - ENABLE_SEMANTIC_TOOLS: Enable semantic tool detection (default: true)
 */
class FeatureFlags {
  /**
   * Check if vector search should be enabled
   * @returns {boolean} True if vector search should be used
   */
  static shouldUseVectorSearch() {
    const enabled = process.env.ENABLE_VECTOR_SEARCH !== 'false';
    if (!enabled) {
      logger.debug('Vector search disabled');
    }
    return enabled;
  }

  /**
   * Check if semantic template matching should be enabled
   * @returns {boolean} True if semantic templates should be used
   */
  static shouldUseSemanticTemplates() {
    const enabled = process.env.ENABLE_SEMANTIC_TEMPLATES !== 'false';
    if (!enabled) {
      logger.debug('Semantic templates disabled');
    }
    return enabled;
  }

  /**
   * Check if semantic tool triggers should be enabled
   * @returns {boolean} True if semantic tools should be used
   */
  static shouldUseSemanticTools() {
    const enabled = process.env.ENABLE_SEMANTIC_TOOLS !== 'false';
    if (!enabled) {
      logger.debug('Semantic tools disabled');
    }
    return enabled;
  }

  /**
   * Get all feature flag states for monitoring/debugging
   * @returns {object} Current feature flag configuration
   */
  static getFeatureStates() {
    return {
      vectorSearch: {
        enabled: this.shouldUseVectorSearch()
      },
      semanticTemplates: {
        enabled: this.shouldUseSemanticTemplates()
      },
      semanticTools: {
        enabled: this.shouldUseSemanticTools()
      }
    };
  }

  /**
   * Log feature flag status for debugging
   */
  static logStatus() {
    const states = this.getFeatureStates();
    logger.info('Feature flag status', states);
  }
}

module.exports = { FeatureFlags };
