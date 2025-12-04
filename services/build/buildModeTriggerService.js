/**
 * Build Mode Trigger Service
 * Semantic matching to determine when to inject Build Mode system prompt
 * Uses vector embeddings for intent detection
 */

const { getFirestore, getFieldValue } = require('../../config/firestore');
const { logger } = require('../../utils/logger');
const embeddingService = require('../embeddingService');
const { getBuildModeManager } = require('./buildModeManager');
const { getBuildMemoryService } = require('./buildMemoryService');

// Default trigger phrases with categories
const DEFAULT_TRIGGERS = [
  // Code Modification Intent
  { phrase: 'Modify your system', category: 'code_modification' },
  { phrase: 'Change your source code', category: 'code_modification' },
  { phrase: 'Update your codebase', category: 'code_modification' },
  { phrase: 'Edit your files', category: 'code_modification' },
  { phrase: 'Make changes to your code', category: 'code_modification' },

  // Service/Tool Building Intent
  { phrase: 'Build a new system service', category: 'build_service' },
  { phrase: 'Create a new service', category: 'build_service' },
  { phrase: 'Create a new system service', category: 'build_service' },
  { phrase: 'Build a new tool', category: 'build_tool' },
  { phrase: 'Create a new tool', category: 'build_tool' },
  { phrase: 'Add a new feature', category: 'build_feature' },
  { phrase: 'Implement a new feature', category: 'build_feature' },
  { phrase: 'Write a new service for', category: 'build_service' },
  { phrase: 'Implement a service for', category: 'build_service' },
  { phrase: 'Create an integration for', category: 'build_service' },

  // Documentation-driven development
  { phrase: 'Read the documentation and create', category: 'build_service' },
  { phrase: 'Read the docs and build', category: 'build_service' },
  { phrase: 'Based on this documentation create', category: 'build_service' },
  { phrase: 'Use this API reference to build', category: 'build_service' },
  { phrase: 'Following the docs implement', category: 'build_service' },

  // File Creation Intent
  { phrase: 'Create a new file', category: 'build_feature' },
  { phrase: 'Write a new file', category: 'build_feature' },
  { phrase: 'Add a new file to', category: 'build_feature' },

  // Modification Intent
  { phrase: 'Modify system tool', category: 'modify_tool' },
  { phrase: 'Update this tool', category: 'modify_tool' },
  { phrase: 'Change this service', category: 'modify_service' },
  { phrase: 'Modify system service', category: 'modify_service' },
  { phrase: 'Refactor this code', category: 'refactor' },

  // Debug Intent
  { phrase: 'Debug your system', category: 'debug' },
  { phrase: 'Debug this system service', category: 'debug' },
  { phrase: 'Debug this system tool', category: 'debug' },
  { phrase: 'Fix this bug', category: 'debug' },
  { phrase: 'Troubleshoot this issue', category: 'debug' },
  { phrase: 'Find the bug in', category: 'debug' },

  // Analysis Intent
  { phrase: 'Analyze your codebase', category: 'analysis' },
  { phrase: 'Review your code', category: 'analysis' },
  { phrase: 'Check for security issues', category: 'analysis' },
  { phrase: 'Find performance issues', category: 'analysis' }
];

class BuildModeTriggerService {
  constructor() {
    this.db = getFirestore();
    this.FieldValue = getFieldValue();
    this.triggerEmbeddings = new Map(); // Cached trigger embeddings
    this.similarityThreshold = 0.65; // Lowered from 0.75 for better trigger sensitivity
    this.initialized = false;
    this.initializationPromise = null;
  }

  /**
   * Initialize the service - load triggers and generate embeddings
   */
  async initialize() {
    if (this.initialized) return;

    // Prevent concurrent initializations
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._doInitialize();
    return this.initializationPromise;
  }

  async _doInitialize() {
    try {
      // Load configuration from Firestore
      const configDoc = await this.db.doc('agent/build-mode-triggers').get();

      let triggers = DEFAULT_TRIGGERS;
      let threshold = 0.65; // Lowered from 0.75 for better sensitivity

      if (configDoc.exists) {
        const config = configDoc.data();
        if (config.triggers && Array.isArray(config.triggers)) {
          triggers = config.triggers;
        }
        if (config.similarity_threshold) {
          threshold = config.similarity_threshold;
        }
      } else {
        // Create default config in Firestore
        await this.db.doc('agent/build-mode-triggers').set({
          triggers: DEFAULT_TRIGGERS,
          embedding_model: 'text-embedding-004',
          similarity_threshold: 0.65,
          createdAt: this.FieldValue.serverTimestamp()
        });
        logger.info('Created default build mode triggers config');
      }

      this.similarityThreshold = threshold;

      // Generate embeddings for all trigger phrases
      for (const trigger of triggers) {
        try {
          const embedding = await embeddingService.embedQuery(
            trigger.phrase,
            'SEMANTIC_SIMILARITY'
          );
          this.triggerEmbeddings.set(trigger.phrase, {
            ...trigger,
            embedding
          });
        } catch (error) {
          logger.error('Failed to generate embedding for trigger', {
            phrase: trigger.phrase,
            error: error.message
          });
        }
      }

      this.initialized = true;
      logger.info('BuildModeTriggerService initialized', {
        triggerCount: this.triggerEmbeddings.size,
        threshold: this.similarityThreshold
      });
    } catch (error) {
      logger.error('BuildModeTriggerService initialization failed', {
        error: error.message
      });
      this.initializationPromise = null;
      throw error;
    }
  }

  /**
   * Check if Build Mode system prompt should be injected
   * @param {string} userMessage - The user's message
   * @returns {Promise<Object>} Injection decision with metadata
   */
  async shouldInjectBuildModePrompt(userMessage) {
    await this.initialize();

    // 1. Check if Build Mode is enabled globally
    const buildModeManager = getBuildModeManager();
    const buildModeEnabled = await buildModeManager.isBuildModeEnabled();

    if (!buildModeEnabled) {
      return {
        inject: false,
        reason: 'build_mode_disabled'
      };
    }

    // 2. Check if GitHub is ready
    const githubStatus = await buildModeManager.isGitHubReady();
    if (!githubStatus.ready) {
      return {
        inject: false,
        reason: 'github_not_ready',
        details: githubStatus.reason
      };
    }

    // 3. KEYWORD DETECTION (first-pass, before semantic matching)
    // Check for exact phrase matches - these should always trigger regardless of surrounding context
    const keywordTriggers = [
      { pattern: /create\s+(?:a\s+)?(?:new\s+)?tool/i, category: 'build_tool' },
      { pattern: /build\s+(?:a\s+)?(?:new\s+)?tool/i, category: 'build_tool' },
      { pattern: /make\s+(?:a\s+)?(?:new\s+)?tool/i, category: 'build_tool' },
      { pattern: /add\s+(?:a\s+)?(?:new\s+)?tool/i, category: 'build_tool' },
      { pattern: /create\s+(?:a\s+)?(?:new\s+)?service/i, category: 'build_service' },
      { pattern: /build\s+(?:a\s+)?(?:new\s+)?service/i, category: 'build_service' },
      { pattern: /create\s+(?:a\s+)?(?:new\s+)?feature/i, category: 'build_feature' },
      { pattern: /implement\s+(?:a\s+)?(?:new\s+)?feature/i, category: 'build_feature' },
      { pattern: /modify\s+(?:the\s+)?(?:code|file|function)/i, category: 'code_modification' },
      { pattern: /update\s+(?:the\s+)?(?:code|file|function)/i, category: 'code_modification' },
      { pattern: /change\s+(?:the\s+)?(?:code|file|function)/i, category: 'code_modification' },
      { pattern: /edit\s+(?:the\s+)?(?:code|file|function)/i, category: 'code_modification' },
      { pattern: /fix\s+(?:the\s+)?(?:bug|issue|error)/i, category: 'bug_fix' },
      { pattern: /refactor\s+(?:the\s+)?/i, category: 'refactoring' }
    ];

    for (const trigger of keywordTriggers) {
      if (trigger.pattern.test(userMessage)) {
        logger.info('Build mode triggered via keyword detection', {
          userMessage: userMessage.substring(0, 100),
          matchedPattern: trigger.pattern.toString(),
          category: trigger.category
        });

        // Retrieve memories for code generation context
        let memories = [];
        let memoryGuidance = '';
        try {
          const { getBuildMemoryService } = require('./buildMemoryService');
          const buildMemoryService = getBuildMemoryService();
          memories = await buildMemoryService.retrieveForCodeGeneration(userMessage, null, 5);
          memoryGuidance = buildMemoryService.formatMemoriesForPrompt(memories);
        } catch (memoryError) {
          logger.warn('Failed to retrieve memories for build mode', { error: memoryError.message });
        }

        return {
          inject: true,
          matchedPhrase: trigger.pattern.toString(),
          category: trigger.category,
          similarity: 1.0, // Exact keyword match
          matchType: 'keyword',
          memories: memories,
          memoryGuidance: memoryGuidance
        };
      }
    }

    // 4. SEMANTIC SIMILARITY (fallback if no keyword match)
    // Generate embedding for user message
    let messageEmbedding;
    try {
      messageEmbedding = await embeddingService.embedQuery(
        userMessage,
        'SEMANTIC_SIMILARITY'
      );
    } catch (error) {
      logger.error('Failed to generate message embedding', {
        error: error.message
      });
      return {
        inject: false,
        reason: 'embedding_generation_failed',
        error: error.message
      };
    }

    // 5. Find best matching trigger phrase
    let bestMatch = { similarity: 0, trigger: null, phrase: null };

    for (const [phrase, trigger] of this.triggerEmbeddings) {
      const similarity = embeddingService.cosineSimilarity(
        messageEmbedding,
        trigger.embedding
      );

      if (similarity > bestMatch.similarity) {
        bestMatch = { similarity, trigger, phrase };
      }
    }

    // 6. Check if similarity exceeds threshold
    if (bestMatch.similarity >= this.similarityThreshold) {
      logger.info('Build mode prompt triggered', {
        userMessage: userMessage.substring(0, 100),
        matchedPhrase: bestMatch.phrase,
        category: bestMatch.trigger.category,
        similarity: bestMatch.similarity.toFixed(4)
      });

      // 6. Retrieve relevant memories for code generation context
      let memories = [];
      let memoryGuidance = '';
      try {
        const buildMemoryService = getBuildMemoryService();
        memories = await buildMemoryService.retrieveForCodeGeneration(
          userMessage,
          null, // No specific file path from trigger
          5     // Top 5 memories
        );
        memoryGuidance = buildMemoryService.formatMemoriesForPrompt(memories);

        logger.info('Retrieved memories for build mode', {
          memoryCount: memories.length,
          hasGuidance: memoryGuidance.length > 0
        });
      } catch (memoryError) {
        logger.warn('Failed to retrieve memories for build mode', {
          error: memoryError.message
        });
      }

      return {
        inject: true,
        matchedPhrase: bestMatch.phrase,
        category: bestMatch.trigger.category,
        similarity: bestMatch.similarity,
        matchType: 'semantic',
        memories: memories,
        memoryGuidance: memoryGuidance
      };
    }

    // Log non-match for debugging
    logger.info('Build mode trigger not matched', {
      userMessage: userMessage.substring(0, 100),
      bestPhrase: bestMatch.phrase,
      bestSimilarity: bestMatch.similarity?.toFixed(4),
      threshold: this.similarityThreshold,
      gap: (this.similarityThreshold - (bestMatch.similarity || 0)).toFixed(4)
    });

    return {
      inject: false,
      reason: 'no_semantic_match',
      bestSimilarity: bestMatch.similarity,
      bestPhrase: bestMatch.phrase
    };
  }

  /**
   * Add a new trigger phrase
   * @param {string} phrase - Trigger phrase
   * @param {string} category - Category for the trigger
   */
  async addTrigger(phrase, category) {
    await this.initialize();

    // Generate embedding
    const embedding = await embeddingService.embedQuery(
      phrase,
      'SEMANTIC_SIMILARITY'
    );

    // Add to local cache
    this.triggerEmbeddings.set(phrase, {
      phrase,
      category,
      embedding
    });

    // Update Firestore
    const triggers = Array.from(this.triggerEmbeddings.values()).map(t => ({
      phrase: t.phrase,
      category: t.category
    }));

    await this.db.doc('agent/build-mode-triggers').update({
      triggers,
      updatedAt: this.FieldValue.serverTimestamp()
    });

    logger.info('Trigger added', { phrase, category });

    return { added: true, phrase, category };
  }

  /**
   * Remove a trigger phrase
   * @param {string} phrase - Trigger phrase to remove
   */
  async removeTrigger(phrase) {
    await this.initialize();

    if (!this.triggerEmbeddings.has(phrase)) {
      return { removed: false, reason: 'Trigger not found' };
    }

    this.triggerEmbeddings.delete(phrase);

    // Update Firestore
    const triggers = Array.from(this.triggerEmbeddings.values()).map(t => ({
      phrase: t.phrase,
      category: t.category
    }));

    await this.db.doc('agent/build-mode-triggers').update({
      triggers,
      updatedAt: this.FieldValue.serverTimestamp()
    });

    logger.info('Trigger removed', { phrase });

    return { removed: true, phrase };
  }

  /**
   * Update similarity threshold
   * @param {number} threshold - New threshold (0-1)
   */
  async setThreshold(threshold) {
    if (threshold < 0 || threshold > 1) {
      throw new Error('Threshold must be between 0 and 1');
    }

    this.similarityThreshold = threshold;

    await this.db.doc('agent/build-mode-triggers').update({
      similarity_threshold: threshold,
      updatedAt: this.FieldValue.serverTimestamp()
    });

    logger.info('Similarity threshold updated', { threshold });

    return { threshold };
  }

  /**
   * Get all trigger phrases
   */
  async getTriggers() {
    await this.initialize();

    return Array.from(this.triggerEmbeddings.values()).map(t => ({
      phrase: t.phrase,
      category: t.category
    }));
  }

  /**
   * Get current configuration
   */
  async getConfig() {
    await this.initialize();

    return {
      triggerCount: this.triggerEmbeddings.size,
      threshold: this.similarityThreshold,
      categories: [...new Set(
        Array.from(this.triggerEmbeddings.values()).map(t => t.category)
      )]
    };
  }

  /**
   * Test a message against triggers (for debugging/admin)
   * @param {string} message - Message to test
   * @returns {Object} Matching results for all triggers
   */
  async testMessage(message) {
    await this.initialize();

    const messageEmbedding = await embeddingService.embedQuery(
      message,
      'SEMANTIC_SIMILARITY'
    );

    const results = [];

    for (const [phrase, trigger] of this.triggerEmbeddings) {
      const similarity = embeddingService.cosineSimilarity(
        messageEmbedding,
        trigger.embedding
      );

      results.push({
        phrase,
        category: trigger.category,
        similarity: similarity.toFixed(4),
        wouldTrigger: similarity >= this.similarityThreshold
      });
    }

    // Sort by similarity descending
    results.sort((a, b) => parseFloat(b.similarity) - parseFloat(a.similarity));

    return {
      message: message.substring(0, 100),
      threshold: this.similarityThreshold,
      results: results.slice(0, 10) // Top 10 matches
    };
  }

  /**
   * Reload triggers from Firestore
   */
  async reload() {
    this.initialized = false;
    this.initializationPromise = null;
    this.triggerEmbeddings.clear();
    await this.initialize();

    return { reloaded: true, triggerCount: this.triggerEmbeddings.size };
  }
}

// Singleton instance
let buildModeTriggerServiceInstance = null;

function getBuildModeTriggerService() {
  if (!buildModeTriggerServiceInstance) {
    buildModeTriggerServiceInstance = new BuildModeTriggerService();
  }
  return buildModeTriggerServiceInstance;
}

module.exports = {
  BuildModeTriggerService,
  getBuildModeTriggerService,
  DEFAULT_TRIGGERS
};
