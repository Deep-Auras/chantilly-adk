const { getDb, getFieldValue } = require('../config/firestore');
const { FieldValue } = require('@google-cloud/firestore');
const { logger } = require('../utils/logger');

class ReasoningMemoryModel {
  constructor() {
    this.db = null;
    this.collectionName = 'reasoning-memory';
    this.cache = new Map();
    this.cacheTimeout = 3600000; // 1 hour
  }

  async initialize() {
    if (!this.db) {
      this.db = getDb();
    }
  }

  /**
   * Add memory item to the pool
   * @param {Object} memory - { title, description, content, source, category, embedding, userIntent }
   */
  async addMemory(memory) {
    await this.initialize();

    const memoryDoc = {
      title: memory.title,
      description: memory.description,
      content: memory.content,
      source: memory.source,
      category: memory.category,
      templateId: memory.templateId || null,
      taskId: memory.taskId || null,
      embedding: FieldValue.vector(memory.embedding), // ⚠️ CRITICAL: Must wrap in FieldValue.vector()

      // USER INTENT: What the user originally wanted vs what was delivered
      userIntent: memory.userIntent || {
        originalRequest: null,
        wantedNewTask: false,
        specifiedCustomName: null,
        wantedAggregate: false,
        wantedSpecificEntity: false,
        intentSatisfied: true, // Whether the delivered result matched user intent
        mismatchReason: null,
        requests: [] // Array of related request strings/IDs
      },

      successRate: memory.successRate || null,
      timesRetrieved: 0,
      timesUsedInSuccess: 0,
      timesUsedInFailure: 0,
      createdAt: getFieldValue().serverTimestamp(),
      updatedAt: getFieldValue().serverTimestamp()
    };

    const docRef = await this.db.collection(this.collectionName).add(memoryDoc);
    logger.info('Memory item added', {
      memoryId: docRef.id,
      title: memory.title,
      source: memory.source,
      category: memory.category
    });

    this.cache.clear();
    return docRef.id;
  }

  /**
   * Retrieve top-k most similar memories using Firestore Vector Search
   * @param {Array} queryEmbedding - Embedding vector of current task/query
   * @param {Number} topK - Number of memories to retrieve (default: 3)
   * @param {Object} filters - Optional filters { category, templateId, minSuccessRate }
   */
  async retrieveMemories(queryEmbedding, topK = 3, filters = {}) {
    await this.initialize();

    let query = this.db.collection(this.collectionName);

    // Apply pre-filters (if needed)
    if (filters.category) {
      query = query.where('category', '==', filters.category);
    }
    if (filters.templateId) {
      query = query.where('templateId', '==', filters.templateId);
    }

    // Use Firestore's native vector search
    const vectorQuery = query.findNearest({
      vectorField: 'embedding',
      queryVector: FieldValue.vector(queryEmbedding), // ⚠️ CRITICAL: Must wrap query vector too
      limit: topK * 2, // Fetch extra for post-filtering
      distanceMeasure: 'COSINE',
      distanceResultField: 'distance'
    });

    const snapshot = await vectorQuery.get();

    if (snapshot.empty) {
      logger.info('No memories found', { filters });
      return [];
    }

    // Process results and apply success rate filter
    const memories = [];
    snapshot.forEach(doc => {
      const data = doc.data();

      // Apply success rate filter if specified
      if (filters.minSuccessRate && data.successRate !== null && data.successRate < filters.minSuccessRate) {
        return;
      }

      // Convert distance to similarity score (1 - distance for cosine)
      const similarityScore = 1 - (data.distance || 0);

      memories.push({
        id: doc.id,
        ...data,
        similarityScore: similarityScore,
        distance: undefined // Remove distance field from output
      });
    });

    // Take top-k after post-filtering
    const topMemories = memories.slice(0, topK);

    // Update retrieval statistics (in parallel for performance)
    const updatePromises = topMemories.map(memory =>
      this.db.collection(this.collectionName).doc(memory.id).update({
        timesRetrieved: getFieldValue().increment(1),
        updatedAt: getFieldValue().serverTimestamp()
      })
    );

    await Promise.all(updatePromises);

    logger.info('Memories retrieved via vector search', {
      totalFetched: memories.length,
      topKReturned: topMemories.length,
      topSimilarity: topMemories[0]?.similarityScore,
      filters: filters
    });

    return topMemories;
  }

  /**
   * Update memory statistics after task completion
   */
  async updateMemoryStats(memoryIds, taskSuccess) {
    await this.initialize();

    const field = taskSuccess ? 'timesUsedInSuccess' : 'timesUsedInFailure';

    for (const memoryId of memoryIds) {
      await this.db.collection(this.collectionName).doc(memoryId).update({
        [field]: getFieldValue().increment(1),
        updatedAt: getFieldValue().serverTimestamp()
      });

      // Recalculate success rate
      const doc = await this.db.collection(this.collectionName).doc(memoryId).get();
      const data = doc.data();
      const totalUses = (data.timesUsedInSuccess || 0) + (data.timesUsedInFailure || 0);
      if (totalUses > 0) {
        const successRate = (data.timesUsedInSuccess || 0) / totalUses;
        await this.db.collection(this.collectionName).doc(memoryId).update({
          successRate: successRate
        });
      }
    }
  }

  /**
   * Get all memories (for debugging/management)
   */
  async getAllMemories(limit = 100) {
    await this.initialize();

    const snapshot = await this.db.collection(this.collectionName)
      .orderBy('updatedAt', 'desc')
      .limit(limit)
      .get();

    const memories = [];
    snapshot.forEach(doc => {
      memories.push({ id: doc.id, ...doc.data() });
    });

    return memories;
  }

  /**
   * Update specific fields of a memory
   * @param {string} memoryId - Memory document ID
   * @param {Object} updates - Fields to update
   */
  async updateMemory(memoryId, updates) {
    await this.initialize();

    await this.db.collection(this.collectionName).doc(memoryId).update({
      ...updates,
      updatedAt: getFieldValue().serverTimestamp()
    });

    logger.debug('Memory updated', {
      memoryId,
      updatedFields: Object.keys(updates)
    });

    this.cache.clear();
  }

  /**
   * Delete a memory permanently
   * @param {string} memoryId - Memory document ID
   */
  async deleteMemory(memoryId) {
    await this.initialize();

    await this.db.collection(this.collectionName).doc(memoryId).delete();

    logger.info('Memory deleted', { memoryId });

    this.cache.clear();
  }

  /**
   * Archive a memory (move to archive collection for historical reference)
   * @param {string} memoryId - Memory document ID
   */
  async archiveMemory(memoryId) {
    await this.initialize();

    // Get the memory document
    const doc = await this.db.collection(this.collectionName).doc(memoryId).get();
    if (!doc.exists) {
      logger.warn('Memory not found for archiving', { memoryId });
      return;
    }

    const memoryData = doc.data();

    // Copy to archive collection
    await this.db.collection('reasoning-memory-archive').doc(memoryId).set({
      ...memoryData,
      archivedAt: getFieldValue().serverTimestamp(),
      archivedReason: 'Stale memory (not retrieved in 90+ days)'
    });

    // Delete from active collection
    await this.db.collection(this.collectionName).doc(memoryId).delete();

    logger.info('Memory archived', { memoryId });

    this.cache.clear();
  }

  /**
   * Get memory by ID
   * @param {string} memoryId - Memory document ID
   */
  async getMemoryById(memoryId) {
    await this.initialize();

    const doc = await this.db.collection(this.collectionName).doc(memoryId).get();
    if (!doc.exists) {
      return null;
    }

    return { id: doc.id, ...doc.data() };
  }
}

// Singleton
let instance = null;
function getReasoningMemoryModel() {
  if (!instance) {
    instance = new ReasoningMemoryModel();
  }
  return instance;
}

module.exports = {
  ReasoningMemoryModel,
  getReasoningMemoryModel
};
