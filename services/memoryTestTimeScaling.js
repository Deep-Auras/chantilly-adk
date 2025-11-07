/**
 * Memory-aware Test-Time Scaling (MaTTS) Service
 *
 * Implements test-time scaling strategies from the ReasoningBank research paper:
 * 1. Parallel Scaling (Self-Contrast): Generate N trajectories, select best
 * 2. Sequential Scaling (Self-Refinement): Iteratively refine trajectory
 *
 * Expected Performance (from paper):
 * - +8.3% success rate improvement
 * - -16.0% reduction in interaction steps
 *
 * Reference: ReasoningBank Section 3.3, Figure 3
 */

const { getReasoningMemoryModel } = require('../models/reasoningMemory');
const embeddingService = require('./embeddingService');
const { logger } = require('../utils/logger');
const config = require('../config/env');

class MemoryTestTimeScaling {
  constructor() {
    this.memoryModel = getReasoningMemoryModel();
  }

  /**
   * Parallel Scaling (Self-Contrast): Generate N trajectories and select best
   * @param {Object} task - Task to execute
   * @param {Function} executeFunction - Function that executes one trajectory
   * @param {number} numVariants - Number of parallel trajectories to generate
   * @returns {Object} - Best trajectory result
   */
  async parallelScaling(task, executeFunction, numVariants = 3) {
    if (!config.MATTS_PARALLEL_ENABLED) {
      // Fallback: Single execution
      logger.debug('Parallel scaling disabled, using single execution', {
        taskId: task.taskId
      });
      return await executeFunction(task, []);
    }

    const startTime = Date.now();

    // Generate embedding for task
    const queryText = `${task.description || task.templateName || ''}. Parameters: ${JSON.stringify(task.parameters || {})}`;
    const queryEmbedding = await embeddingService.embedQuery(queryText, 'RETRIEVAL_QUERY');

    // Retrieve top N*3 memories to diversify strategies
    const memories = await this.memoryModel.retrieveMemories(queryEmbedding, numVariants * 3, {
      minSuccessRate: 0.5  // Lower threshold for diversity
    });

    if (!memories || memories.length === 0) {
      logger.info('No memories available for parallel scaling, using single execution', {
        taskId: task.taskId
      });
      return await executeFunction(task, []);
    }

    // Split memories into N sets for N variants (round-robin distribution)
    const memoryChunks = Array.from({ length: numVariants }, () => []);
    memories.forEach((memory, index) => {
      memoryChunks[index % numVariants].push(memory);
    });

    logger.info('Starting parallel scaling with memory-guided variants', {
      taskId: task.taskId,
      numVariants,
      totalMemories: memories.length,
      memoriesPerVariant: memoryChunks.map(c => c.length)
    });

    // Execute N trajectories in parallel
    const trajectoryPromises = memoryChunks.map(async (memorySet, index) => {
      try {
        const result = await executeFunction(task, memorySet);
        return {
          index,
          result,
          success: result.success,
          score: this._scoreTrajectory(result),
          memoriesUsed: memorySet.map(m => m.id)
        };
      } catch (error) {
        logger.warn('Parallel trajectory failed', {
          taskId: task.taskId,
          variantIndex: index,
          error: error.message
        });
        return {
          index,
          result: null,
          success: false,
          score: 0,
          memoriesUsed: memorySet.map(m => m.id)
        };
      }
    });

    const trajectories = await Promise.all(trajectoryPromises);

    // Select best trajectory
    const successfulTrajectories = trajectories.filter(t => t.success);
    const bestTrajectory = successfulTrajectories.length > 0
      ? successfulTrajectories.reduce((best, current) =>
        current.score > best.score ? current : best
      )
      : trajectories[0]; // Fallback to first if all failed

    const elapsedTime = Date.now() - startTime;

    logger.info('Parallel scaling complete, selected best trajectory', {
      taskId: task.taskId,
      selectedIndex: bestTrajectory.index,
      successCount: successfulTrajectories.length,
      bestScore: bestTrajectory.score.toFixed(2),
      elapsedTime: `${elapsedTime}ms`,
      allScores: trajectories.map(t => ({ index: t.index, score: t.score.toFixed(2), success: t.success }))
    });

    // Update memory statistics for winning trajectory
    if (bestTrajectory.success && bestTrajectory.memoriesUsed.length > 0) {
      await this.memoryModel.updateMemoryStats(bestTrajectory.memoriesUsed, true);

      logger.debug('Updated memory stats for winning trajectory', {
        taskId: task.taskId,
        memoryCount: bestTrajectory.memoriesUsed.length
      });
    }

    return bestTrajectory.result;
  }

  /**
   * Sequential Scaling (Self-Refinement): Iteratively refine trajectory using memory
   * @param {Object} task - Task to execute
   * @param {Function} executeFunction - Function that executes trajectory
   * @param {Function} reflectFunction - Function that reflects on execution
   * @param {number} maxIterations - Maximum refinement iterations
   * @returns {Object} - Refined trajectory result
   */
  async sequentialScaling(task, executeFunction, reflectFunction, maxIterations = 3) {
    if (!config.MATTS_SEQUENTIAL_ENABLED) {
      // Fallback: Single execution
      logger.debug('Sequential scaling disabled, using single execution', {
        taskId: task.taskId
      });
      return await executeFunction(task, []);
    }

    const startTime = Date.now();

    // Generate embedding for task
    const queryText = `${task.description || task.templateName || ''}. Parameters: ${JSON.stringify(task.parameters || {})}`;
    const queryEmbedding = await embeddingService.embedQuery(queryText, 'RETRIEVAL_QUERY');

    let currentTask = task;
    let bestResult = null;
    let bestScore = 0;
    const iterationResults = [];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      logger.info('Sequential scaling iteration', {
        taskId: task.taskId,
        iteration: iteration + 1,
        maxIterations
      });

      // Retrieve memories relevant to current iteration
      const memories = await this.memoryModel.retrieveMemories(queryEmbedding, 5, {
        minSuccessRate: 0.6
      });

      // Execute trajectory with current memories
      const result = await executeFunction(currentTask, memories);
      const score = this._scoreTrajectory(result);

      iterationResults.push({
        iteration: iteration + 1,
        success: result.success,
        score: score.toFixed(2)
      });

      // Track best result
      if (score > bestScore) {
        bestResult = result;
        bestScore = score;
      }

      // If successful and high score, stop early
      if (result.success && score > 0.9) {
        logger.info('Sequential scaling achieved high score, stopping early', {
          taskId: task.taskId,
          iteration: iteration + 1,
          score: score.toFixed(2)
        });
        break;
      }

      // Reflect on execution and refine task
      if (reflectFunction) {
        try {
          const reflection = await reflectFunction(currentTask, result, memories);
          if (!reflection || !reflection.shouldRefine) {
            logger.info('Sequential scaling reflection suggests no further refinement', {
              taskId: task.taskId,
              iteration: iteration + 1
            });
            break;
          }

          // Update task based on reflection
          currentTask = {
            ...currentTask,
            ...reflection.refinedTask
          };
        } catch (error) {
          logger.warn('Reflection function failed, stopping refinement', {
            taskId: task.taskId,
            iteration: iteration + 1,
            error: error.message
          });
          break;
        }
      } else {
        // No reflection function, stop after first successful iteration
        if (result.success) {
          break;
        }
      }
    }

    const elapsedTime = Date.now() - startTime;

    logger.info('Sequential scaling complete', {
      taskId: task.taskId,
      iterations: iterationResults.length,
      finalScore: bestScore.toFixed(2),
      elapsedTime: `${elapsedTime}ms`,
      iterationResults
    });

    return bestResult;
  }

  /**
   * Score trajectory for comparison
   * @param {Object} result - Trajectory result
   * @returns {number} - Score between 0-1
   */
  _scoreTrajectory(result) {
    if (!result || !result.success) {
      return 0;
    }

    let score = 0.5; // Base success score

    // Bonus for efficiency (fewer steps, less time)
    if (result.steps && result.steps < 10) {
      score += 0.2;
    }
    if (result.executionTime && result.executionTime < 5000) {
      score += 0.1;
    }

    // Bonus for quality (completeness, data richness)
    if (result.outputData && Object.keys(result.outputData).length > 5) {
      score += 0.1;
    }
    if (result.htmlReport && result.htmlReport.length > 1000) {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }
}

// Singleton
let instance = null;
function getMemoryTestTimeScaling() {
  if (!instance) {
    instance = new MemoryTestTimeScaling();
  }
  return instance;
}

module.exports = {
  MemoryTestTimeScaling,
  getMemoryTestTimeScaling
};
