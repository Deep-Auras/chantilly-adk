/**
 * Memory Consolidation Service
 *
 * Provides periodic maintenance for the ReasoningBank memory system:
 * - Prunes low-quality memories (< 30% success rate after 10+ uses)
 * - Detects and merges near-duplicate memories
 * - Archives stale memories (not retrieved in 90+ days)
 *
 * Should be run periodically (e.g., daily via Cloud Scheduler)
 */

const { getReasoningMemoryModel } = require('../models/reasoningMemory');
const { logger } = require('../utils/logger');

class MemoryConsolidation {
  constructor() {
    this.memoryModel = getReasoningMemoryModel();
  }

  /**
   * Run full memory consolidation process
   * @returns {Object} - Statistics about consolidation operations
   */
  async consolidate() {
    logger.info('Starting memory consolidation');

    const stats = {
      startTime: new Date().toISOString(),
      totalMemories: 0,
      pruned: 0,
      merged: 0,
      archived: 0,
      errors: []
    };

    try {
      // Get count of memories before consolidation
      const memoriesBefore = await this.memoryModel.getAllMemories(10000);
      stats.totalMemories = memoriesBefore.length;

      // Step 1: Prune low-quality memories
      logger.info('Step 1: Pruning low-quality memories');
      const prunedCount = await this.pruneLowQualityMemories();
      stats.pruned = prunedCount;

      // Step 2: Detect and merge near-duplicates
      logger.info('Step 2: Detecting and merging duplicates');
      const mergedCount = await this.detectAndMergeDuplicates();
      stats.merged = mergedCount;

      // Step 3: Archive stale memories
      logger.info('Step 3: Archiving stale memories');
      const archivedCount = await this.archiveStaleMemories();
      stats.archived = archivedCount;

      stats.endTime = new Date().toISOString();
      stats.success = true;

      logger.info('Memory consolidation completed successfully', stats);

      return stats;
    } catch (error) {
      stats.errors.push(error.message);
      stats.success = false;
      logger.error('Memory consolidation failed', {
        error: error.message,
        stack: error.stack,
        stats
      });
      throw error;
    }
  }

  /**
   * Prune memories with very low success rates (< 30% after 10+ retrievals)
   * @returns {number} - Number of memories pruned
   */
  async pruneLowQualityMemories() {
    const lowQualityThreshold = 0.3;
    const minRetrievals = 10;

    const memories = await this.memoryModel.getAllMemories(10000);
    const toPrune = memories.filter(m =>
      m.timesRetrieved >= minRetrievals &&
      m.successRate !== null &&
      m.successRate < lowQualityThreshold
    );

    logger.info('Identified low-quality memories for pruning', {
      totalMemories: memories.length,
      toPrune: toPrune.length,
      threshold: `${lowQualityThreshold * 100}%`,
      minRetrievals
    });

    for (const memory of toPrune) {
      try {
        await this.memoryModel.deleteMemory(memory.id);
        logger.debug('Pruned low-quality memory', {
          memoryId: memory.id,
          title: memory.title,
          successRate: (memory.successRate * 100).toFixed(0) + '%',
          timesRetrieved: memory.timesRetrieved
        });
      } catch (error) {
        logger.warn('Failed to prune memory', {
          memoryId: memory.id,
          error: error.message
        });
      }
    }

    return toPrune.length;
  }

  /**
   * Detect near-duplicate memories using cosine similarity
   * @returns {number} - Number of memories merged
   */
  async detectAndMergeDuplicates() {
    const similarityThreshold = 0.95;  // Very similar memories

    const memories = await this.memoryModel.getAllMemories(10000);
    const duplicatePairs = [];

    // Compare each memory to others (only need to check each pair once)
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        // Skip if either memory doesn't have an embedding
        if (!memories[i].embedding || !memories[j].embedding) {
          continue;
        }

        const similarity = this._cosineSimilarity(
          memories[i].embedding,
          memories[j].embedding
        );

        if (similarity >= similarityThreshold) {
          duplicatePairs.push({
            memory1: memories[i],
            memory2: memories[j],
            similarity
          });
        }
      }
    }

    logger.info('Found near-duplicate memory pairs', {
      duplicatePairs: duplicatePairs.length,
      threshold: similarityThreshold
    });

    let mergedCount = 0;

    // Merge duplicates: Keep memory with higher success rate
    for (const pair of duplicatePairs) {
      try {
        const { memory1, memory2 } = pair;

        // Determine which to keep (higher success rate, or more retrievals if tied)
        let keep, remove;
        if (memory1.successRate > memory2.successRate) {
          keep = memory1;
          remove = memory2;
        } else if (memory2.successRate > memory1.successRate) {
          keep = memory2;
          remove = memory1;
        } else {
          // Tied success rates, keep the one retrieved more often
          keep = memory1.timesRetrieved >= memory2.timesRetrieved ? memory1 : memory2;
          remove = memory1.timesRetrieved >= memory2.timesRetrieved ? memory2 : memory1;
        }

        // Merge statistics
        const mergedTimesRetrieved = keep.timesRetrieved + remove.timesRetrieved;
        const mergedTimesSuccessful = (keep.timesUsedInSuccess || 0) + (remove.timesUsedInSuccess || 0);
        const mergedTimesFailure = (keep.timesUsedInFailure || 0) + (remove.timesUsedInFailure || 0);
        const totalUses = mergedTimesSuccessful + mergedTimesFailure;

        await this.memoryModel.updateMemory(keep.id, {
          timesRetrieved: mergedTimesRetrieved,
          timesUsedInSuccess: mergedTimesSuccessful,
          timesUsedInFailure: mergedTimesFailure,
          successRate: totalUses > 0 ? mergedTimesSuccessful / totalUses : null
        });

        // Delete duplicate
        await this.memoryModel.deleteMemory(remove.id);

        mergedCount++;

        logger.debug('Merged duplicate memory', {
          keptId: keep.id,
          keptTitle: keep.title,
          removedId: remove.id,
          similarity: pair.similarity.toFixed(3),
          mergedStats: {
            timesRetrieved: mergedTimesRetrieved,
            successRate: totalUses > 0 ? (mergedTimesSuccessful / totalUses).toFixed(2) : 'N/A'
          }
        });
      } catch (error) {
        logger.warn('Failed to merge duplicate memories', {
          memory1Id: pair.memory1.id,
          memory2Id: pair.memory2.id,
          error: error.message
        });
      }
    }

    return mergedCount;
  }

  /**
   * Archive memories that haven't been retrieved in 90+ days
   * @returns {number} - Number of memories archived
   */
  async archiveStaleMemories() {
    const staleThresholdDays = 90;
    const now = new Date();
    const staleDate = new Date(now.getTime() - staleThresholdDays * 24 * 60 * 60 * 1000);

    const memories = await this.memoryModel.getAllMemories(10000);

    const staleMemories = memories.filter(m => {
      // Use updatedAt (when last retrieved/used) or createdAt as fallback
      // Handle missing timestamps gracefully
      if (!m.updatedAt && !m.createdAt) {
        return false; // Skip memories without timestamps
      }

      const lastActivity = m.updatedAt
        ? new Date(m.updatedAt._seconds * 1000)
        : new Date(m.createdAt._seconds * 1000);
      return lastActivity < staleDate;
    });

    logger.info('Identified stale memories for archiving', {
      totalMemories: memories.length,
      staleMemories: staleMemories.length,
      staleDays: staleThresholdDays
    });

    for (const memory of staleMemories) {
      try {
        await this.memoryModel.archiveMemory(memory.id);

        const lastActivity = memory.updatedAt ? new Date(memory.updatedAt._seconds * 1000) : new Date(memory.createdAt._seconds * 1000);

        logger.debug('Archived stale memory', {
          memoryId: memory.id,
          title: memory.title,
          lastActivity: lastActivity.toISOString(),
          daysSinceActivity: Math.floor((now - lastActivity) / (24 * 60 * 60 * 1000))
        });
      } catch (error) {
        logger.warn('Failed to archive memory', {
          memoryId: memory.id,
          error: error.message
        });
      }
    }

    return staleMemories.length;
  }

  /**
   * Calculate cosine similarity between two embeddings
   * @param {Array|Object} vec1 - First embedding vector (array or Firestore vector)
   * @param {Array|Object} vec2 - Second embedding vector (array or Firestore vector)
   * @returns {number} - Similarity score (0-1)
   */
  _cosineSimilarity(vec1, vec2) {
    // Input validation
    if (!vec1 || !vec2) {
      return 0;
    }

    // Handle Firestore vector objects (with _values property)
    const arr1 = vec1._values || vec1;
    const arr2 = vec2._values || vec2;

    if (!Array.isArray(arr1) || !Array.isArray(arr2)) {
      logger.warn('Invalid embedding format for similarity calculation');
      return 0;
    }

    if (arr1.length !== arr2.length) {
      logger.warn('Embedding dimension mismatch', {
        vec1Length: arr1.length,
        vec2Length: arr2.length
      });
      return 0;
    }

    let dotProduct = 0;
    let mag1 = 0;
    let mag2 = 0;

    for (let i = 0; i < arr1.length; i++) {
      dotProduct += arr1[i] * arr2[i];
      mag1 += arr1[i] * arr1[i];
      mag2 += arr2[i] * arr2[i];
    }

    mag1 = Math.sqrt(mag1);
    mag2 = Math.sqrt(mag2);

    if (mag1 === 0 || mag2 === 0) {
      return 0;
    }

    return dotProduct / (mag1 * mag2);
  }
}

// Singleton
let instance = null;
function getMemoryConsolidation() {
  if (!instance) {
    instance = new MemoryConsolidation();
  }
  return instance;
}

module.exports = {
  MemoryConsolidation,
  getMemoryConsolidation
};
