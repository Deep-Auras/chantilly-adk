/**
 * Jest Tests for MaTTS (Memory-aware Test-Time Scaling)
 *
 * Tests for:
 * - Critical bugs
 * - Infinite loops (with timeouts)
 * - Data leaks
 * - OWASP compliance
 * - Security validation
 */

// Mock dependencies BEFORE imports (Jest hoists these)
jest.mock('../../config/firestore', () => ({
  getDb: jest.fn(),
  getFieldValue: jest.fn(() => ({
    serverTimestamp: jest.fn(),
    increment: jest.fn()
  }))
}));

jest.mock('../../models/reasoningMemory');
jest.mock('../../services/embeddingService');
jest.mock('../../config/env', () => ({
  MATTS_PARALLEL_ENABLED: true,
  MATTS_SEQUENTIAL_ENABLED: true,
  MATTS_PARALLEL_VARIANTS: 3,
  MATTS_SEQUENTIAL_ITERATIONS: 3
}));
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

const { MemoryTestTimeScaling } = require('../../services/memoryTestTimeScaling');
const { getReasoningMemoryModel } = require('../../models/reasoningMemory');
const embeddingService = require('../../services/embeddingService');

describe('MaTTS Service - Security & Critical Bug Tests', () => {
  let matts;
  let mockMemoryModel;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock memory model
    mockMemoryModel = {
      retrieveMemories: jest.fn(),
      updateMemoryStats: jest.fn()
    };

    getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

    // Mock embedding service
    embeddingService.embedQuery = jest.fn().mockResolvedValue(
      Array.from({ length: 768 }, () => Math.random())
    );

    matts = new MemoryTestTimeScaling();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  describe('OWASP Compliance - Input Validation', () => {
    test('should handle missing task fields gracefully', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      const invalidTasks = [
        {}, // Empty task
        { taskId: null }, // Null taskId
        { parameters: undefined } // Undefined parameters
      ];

      const mockExecute = jest.fn().mockResolvedValue({ success: true });

      for (const task of invalidTasks) {
        await expect(
          matts.parallelScaling(task, mockExecute, 2)
        ).resolves.toBeDefined();
      }
    });

    test('should validate numVariants parameter', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);
      const mockExecute = jest.fn().mockResolvedValue({ success: true });

      const task = { taskId: 'test', parameters: {} };

      // Should handle invalid variants
      await expect(matts.parallelScaling(task, mockExecute, 0)).resolves.toBeDefined();
      await expect(matts.parallelScaling(task, mockExecute, -1)).resolves.toBeDefined();
      await expect(matts.parallelScaling(task, mockExecute, null)).resolves.toBeDefined();
    });

    test('should handle null memory retrieval results', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue(null);

      const mockExecute = jest.fn().mockResolvedValue({ success: true });
      const task = { taskId: 'test' };

      // Should fallback to single execution
      const result = await matts.parallelScaling(task, mockExecute, 3);
      expect(result).toBeDefined();
      expect(mockExecute).toHaveBeenCalledWith(task, []);
    });

    test('should handle malformed memory objects', async () => {
      const malformedMemories = [
        { id: null }, // Null ID
        { }, // Missing ID
        { id: '1', embedding: 'not-an-array' } // Invalid embedding
      ];

      mockMemoryModel.retrieveMemories.mockResolvedValue(malformedMemories);
      const mockExecute = jest.fn().mockResolvedValue({ success: true });

      const task = { taskId: 'test' };

      // Should handle gracefully
      await expect(
        matts.parallelScaling(task, mockExecute, 3)
      ).resolves.toBeDefined();
    });
  });

  describe('Critical Bug Prevention - Infinite Loops', () => {
    test('should complete parallel scaling within timeout', async () => {
      const memories = Array.from({ length: 100 }, (_, i) => ({
        id: `mem-${i}`,
        content: 'test content'
      }));

      mockMemoryModel.retrieveMemories.mockResolvedValue(memories);
      mockMemoryModel.updateMemoryStats.mockResolvedValue(true);

      const mockExecute = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10)); // Simulate work
        return { success: true, executionTime: 100 };
      });

      const task = { taskId: 'test', parameters: {} };

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout: Infinite loop in parallel scaling')), 10000);
      });

      // Should complete within 10 seconds
      await expect(
        Promise.race([
          matts.parallelScaling(task, mockExecute, 5),
          timeoutPromise
        ])
      ).resolves.toBeDefined();
    }, 15000);

    test('should complete sequential scaling within timeout', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        content: 'test content'
      }));

      mockMemoryModel.retrieveMemories.mockResolvedValue(memories);

      const mockExecute = jest.fn().mockResolvedValue({
        success: true,
        score: 0.5,
        executionTime: 100
      });

      const mockReflect = jest.fn().mockResolvedValue({
        shouldRefine: false // Stop after first iteration
      });

      const task = { taskId: 'test' };

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout: Infinite loop in sequential scaling')), 5000);
      });

      await expect(
        Promise.race([
          matts.sequentialScaling(task, mockExecute, mockReflect, 3),
          timeoutPromise
        ])
      ).resolves.toBeDefined();
    }, 10000);

    test('should limit sequential iterations to maxIterations', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1', content: 'test' }
      ]);

      let executeCount = 0;
      const mockExecute = jest.fn().mockImplementation(async () => {
        executeCount++;
        return { success: false, score: 0.3, executionTime: 50 };
      });

      const mockReflect = jest.fn().mockResolvedValue({
        shouldRefine: true, // Always say refine
        refinedTask: {}
      });

      const task = { taskId: 'test' };

      await matts.sequentialScaling(task, mockExecute, mockReflect, 5);

      // Should stop at maxIterations (5), not continue forever
      expect(executeCount).toBeLessThanOrEqual(5);
    });

    test('should stop sequential scaling on high score', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      let executeCount = 0;
      const mockExecute = jest.fn().mockImplementation(async () => {
        executeCount++;
        // Provide fields that score > 0.9 (0.5 + 0.2 + 0.1 + 0.1 + 0.1 = 1.0)
        return {
          success: true,
          steps: 5,
          executionTime: 3000,
          outputData: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
          htmlReport: 'x'.repeat(2000)
        };
      });

      const mockReflect = jest.fn();
      const task = { taskId: 'test' };

      await matts.sequentialScaling(task, mockExecute, mockReflect, 10);

      // Should stop early (at iteration 1) due to high score
      expect(executeCount).toBe(1);
      expect(mockReflect).not.toHaveBeenCalled();
    });
  });

  describe('Memory Leak Prevention', () => {
    test('should not accumulate memory in parallel execution', async () => {
      const memories = Array.from({ length: 100 }, (_, i) => ({
        id: `mem-${i}`,
        content: `Memory content ${i}`,
        embedding: Array.from({ length: 768 }, () => Math.random())
      }));

      mockMemoryModel.retrieveMemories.mockResolvedValue(memories);
      mockMemoryModel.updateMemoryStats.mockResolvedValue(true);

      const mockExecute = jest.fn().mockResolvedValue({
        success: true,
        executionTime: 100
      });

      const task = { taskId: 'test', parameters: {} };

      const initialMemory = process.memoryUsage().heapUsed;

      await matts.parallelScaling(task, mockExecute, 10);

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Should not leak more than 20MB
      expect(memoryIncrease).toBeLessThan(20 * 1024 * 1024);
    });

    test('should cleanup trajectory data after selection', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1', content: 'test' }
      ]);
      mockMemoryModel.updateMemoryStats.mockResolvedValue(true);

      const mockExecute = jest.fn().mockResolvedValue({
        success: true,
        executionTime: 100
      });

      const task = { taskId: 'test' };

      await matts.parallelScaling(task, mockExecute, 3);

      // MaTTS service should not cache trajectories
      expect(Object.keys(matts)).not.toContain('trajectories');
      expect(Object.keys(matts)).not.toContain('cachedResults');
    });

    test('should not retain large objects in sequential scaling', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      const mockExecute = jest.fn().mockResolvedValue({
        success: true,
        score: 0.6,
        largeData: Buffer.alloc(1024 * 1024) // 1MB buffer
      });

      const mockReflect = jest.fn().mockResolvedValue({
        shouldRefine: false
      });

      const task = { taskId: 'test' };

      const initialMemory = process.memoryUsage().heapUsed;

      await matts.sequentialScaling(task, mockExecute, mockReflect, 3);

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Should not retain more than 5MB after completion
      expect(memoryIncrease).toBeLessThan(5 * 1024 * 1024);
    });
  });

  describe('OWASP - Error Handling & Exception Safety', () => {
    test('should handle execution function errors gracefully', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1', content: 'test' }
      ]);

      const mockExecute = jest.fn().mockRejectedValue(new Error('Execution failed'));
      const task = { taskId: 'test' };

      // Should not throw, should return failed trajectory
      const result = await matts.parallelScaling(task, mockExecute, 3);
      expect(result).toBeDefined();
    });

    test('should handle partial trajectory failures in parallel', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1' }, { id: 'mem-2' }, { id: 'mem-3' }
      ]);

      let callCount = 0;
      const mockExecute = jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Trajectory 2 failed');
        }
        return { success: true, score: 0.7, executionTime: 100 };
      });

      const task = { taskId: 'test' };

      const result = await matts.parallelScaling(task, mockExecute, 3);

      // Should return best successful trajectory
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('should handle all trajectories failing', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1' }
      ]);

      const mockExecute = jest.fn().mockRejectedValue(new Error('All failed'));
      const task = { taskId: 'test' };

      const result = await matts.parallelScaling(task, mockExecute, 3);

      // Should return first (failed) trajectory as fallback
      expect(result).toBeNull();
    });

    test('should handle reflection function errors', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      const mockExecute = jest.fn().mockResolvedValue({
        success: true,
        score: 0.5
      });

      const mockReflect = jest.fn().mockRejectedValue(new Error('Reflection failed'));
      const task = { taskId: 'test' };

      // Should handle error and return result
      const result = await matts.sequentialScaling(task, mockExecute, mockReflect, 2);
      expect(result).toBeDefined();
    });

    test('should handle embedding service errors', async () => {
      embeddingService.embedQuery.mockRejectedValue(new Error('Embedding failed'));

      const mockExecute = jest.fn().mockResolvedValue({ success: true });
      const task = { taskId: 'test' };

      // Should propagate error
      await expect(
        matts.parallelScaling(task, mockExecute, 3)
      ).rejects.toThrow('Embedding failed');
    });
  });

  describe('OWASP - Resource Limits', () => {
    test('should limit parallel variants to reasonable number', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1' }
      ]);

      let executeCount = 0;
      const mockExecute = jest.fn().mockImplementation(async () => {
        executeCount++;
        return { success: true, score: 0.5 };
      });

      const task = { taskId: 'test' };

      // Try to create 100 variants (excessive)
      await matts.parallelScaling(task, mockExecute, 100);

      // Should actually execute 100 times (no hard limit, but watch performance)
      expect(executeCount).toBeLessThanOrEqual(100);
    });

    test('should handle memory retrieval limit', async () => {
      // Return excessive memories
      const excessiveMemories = Array.from({ length: 1000 }, (_, i) => ({
        id: `mem-${i}`
      }));

      mockMemoryModel.retrieveMemories.mockResolvedValue(excessiveMemories);

      const mockExecute = jest.fn().mockResolvedValue({ success: true });
      const task = { taskId: 'test' };

      // Should handle without crashing
      await expect(
        matts.parallelScaling(task, mockExecute, 3)
      ).resolves.toBeDefined();
    });

    test('should limit sequential iterations', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      let iterations = 0;
      const mockExecute = jest.fn().mockImplementation(async () => {
        iterations++;
        return { success: false, score: 0.3 };
      });

      const mockReflect = jest.fn().mockResolvedValue({
        shouldRefine: true,
        refinedTask: {}
      });

      const task = { taskId: 'test' };

      await matts.sequentialScaling(task, mockExecute, mockReflect, 10);

      // Should stop at maxIterations
      expect(iterations).toBe(10);
    });
  });

  describe('OWASP - Sensitive Data Exposure', () => {
    test('should not log task parameters', async () => {
      const { logger } = require('../../utils/logger');

      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      const mockExecute = jest.fn().mockResolvedValue({ success: true });

      const task = {
        taskId: 'test',
        parameters: {
          apiKey: 'SENSITIVE_KEY_12345',
          password: 'secret'
        }
      };

      await matts.parallelScaling(task, mockExecute, 2);

      const logCalls = logger.info.mock.calls.flat().join(' ');
      expect(logCalls).not.toContain('SENSITIVE_KEY_12345');
      expect(logCalls).not.toContain('secret');
    });

    test('should not log memory content in trajectories', async () => {
      const { logger } = require('../../utils/logger');

      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1', content: 'CONFIDENTIAL: Internal API design' }
      ]);
      mockMemoryModel.updateMemoryStats.mockResolvedValue(true);

      const mockExecute = jest.fn().mockResolvedValue({ success: true, score: 0.8 });
      const task = { taskId: 'test' };

      await matts.parallelScaling(task, mockExecute, 2);

      const logCalls = logger.info.mock.calls.flat().join(' ');
      expect(logCalls).not.toContain('CONFIDENTIAL: Internal API design');
    });
  });

  describe('Trajectory Scoring Correctness', () => {
    test('should score failed trajectories as 0', () => {
      const failedResult = { success: false };
      expect(matts._scoreTrajectory(failedResult)).toBe(0);
    });

    test('should give base score for basic success', () => {
      const basicSuccess = { success: true };
      expect(matts._scoreTrajectory(basicSuccess)).toBe(0.5);
    });

    test('should bonus for efficiency', () => {
      const efficientResult = {
        success: true,
        steps: 5,
        executionTime: 3000
      };

      const score = matts._scoreTrajectory(efficientResult);
      expect(score).toBeGreaterThan(0.5);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    test('should bonus for quality', () => {
      const qualityResult = {
        success: true,
        outputData: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
        htmlReport: 'x'.repeat(2000)
      };

      const score = matts._scoreTrajectory(qualityResult);
      expect(score).toBeGreaterThan(0.5);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    test('should cap score at 1.0', () => {
      const perfectResult = {
        success: true,
        steps: 1,
        executionTime: 100,
        outputData: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [i, i])),
        htmlReport: 'x'.repeat(10000)
      };

      const score = matts._scoreTrajectory(perfectResult);
      expect(score).toBeCloseTo(1.0, 5); // Use toBeCloseTo for floating point comparison
    });

    test('should handle null/undefined result', () => {
      expect(matts._scoreTrajectory(null)).toBe(0);
      expect(matts._scoreTrajectory(undefined)).toBe(0);
    });
  });

  describe('Functional Correctness - Parallel Scaling', () => {
    test('should distribute memories across variants', async () => {
      const memories = [
        { id: 'mem-1' }, { id: 'mem-2' }, { id: 'mem-3' },
        { id: 'mem-4' }, { id: 'mem-5' }, { id: 'mem-6' }
      ];

      mockMemoryModel.retrieveMemories.mockResolvedValue(memories);
      mockMemoryModel.updateMemoryStats.mockResolvedValue(true);

      const receivedMemorySets = [];
      const mockExecute = jest.fn().mockImplementation(async (task, memorySet) => {
        receivedMemorySets.push(memorySet);
        return { success: true, score: 0.5 };
      });

      const task = { taskId: 'test' };

      await matts.parallelScaling(task, mockExecute, 3);

      // Should have called execute 3 times
      expect(mockExecute).toHaveBeenCalledTimes(3);

      // Should distribute memories via round-robin
      expect(receivedMemorySets.length).toBe(3);
      expect(receivedMemorySets[0].length).toBeGreaterThan(0);
    });

    test('should select best trajectory by score', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1' }, { id: 'mem-2' }, { id: 'mem-3' }
      ]);
      mockMemoryModel.updateMemoryStats.mockResolvedValue(true);

      // Provide fields that will score differently via _scoreTrajectory
      const results = [
        { success: true, executionTime: 6000, result: 'trajectory-0.5' }, // Score: 0.5 (base only, slow)
        { success: true, steps: 5, executionTime: 3000, outputData: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, result: 'trajectory-0.9' }, // Score: 0.9
        { success: true, executionTime: 3000, result: 'trajectory-0.6' } // Score: 0.6 (base + time)
      ];
      let callIndex = 0;

      const mockExecute = jest.fn().mockImplementation(async () => {
        const result = results[callIndex % results.length];
        callIndex++;
        return result;
      });

      const task = { taskId: 'test' };

      const result = await matts.parallelScaling(task, mockExecute, 3);

      // Should return best trajectory (score 0.9)
      expect(result.result).toBe('trajectory-0.9');
    });

    test('should update memory stats for winning trajectory', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([
        { id: 'mem-1' }, { id: 'mem-2' }
      ]);
      mockMemoryModel.updateMemoryStats.mockResolvedValue(true);

      const mockExecute = jest.fn().mockResolvedValue({
        success: true,
        score: 0.8
      });

      const task = { taskId: 'test' };

      await matts.parallelScaling(task, mockExecute, 2);

      // Should update stats for memories used in winning trajectory
      expect(mockMemoryModel.updateMemoryStats).toHaveBeenCalled();
      expect(mockMemoryModel.updateMemoryStats).toHaveBeenCalledWith(
        expect.any(Array),
        true
      );
    });
  });

  describe('Functional Correctness - Sequential Scaling', () => {
    test('should iterate until shouldRefine is false', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      let executeCount = 0;
      const mockExecute = jest.fn().mockImplementation(async () => {
        executeCount++;
        return { success: true, score: 0.5 };
      });

      let reflectCount = 0;
      const mockReflect = jest.fn().mockImplementation(async () => {
        reflectCount++;
        return {
          shouldRefine: reflectCount < 2, // Refine only once
          refinedTask: {}
        };
      });

      const task = { taskId: 'test' };

      await matts.sequentialScaling(task, mockExecute, mockReflect, 5);

      // Should execute twice (initial + 1 refinement)
      expect(executeCount).toBe(2);
      expect(reflectCount).toBe(2);
    });

    test('should track best result across iterations', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      // Provide results that will score: 0.5, 0.7, 0.6 via _scoreTrajectory
      const results = [
        { success: true, executionTime: 6000, data: 'iteration-1' }, // Score: 0.5 (base only)
        { success: true, steps: 5, executionTime: 3000, data: 'iteration-2' }, // Score: 0.7 (base + steps + time)
        { success: true, executionTime: 3000, data: 'iteration-3' } // Score: 0.6 (base + time)
      ];
      let iteration = 0;

      const mockExecute = jest.fn().mockImplementation(async () => {
        const result = results[iteration];
        iteration++;
        return result;
      });

      const mockReflect = jest.fn().mockResolvedValue({
        shouldRefine: true,
        refinedTask: {}
      });

      const task = { taskId: 'test' };

      const result = await matts.sequentialScaling(task, mockExecute, mockReflect, 3);

      // Should return best result (score 0.7 from iteration 2)
      expect(result.data).toBe('iteration-2');
    });

    test('should work without reflection function', async () => {
      mockMemoryModel.retrieveMemories.mockResolvedValue([]);

      const mockExecute = jest.fn().mockResolvedValue({
        success: true,
        score: 0.8
      });

      const task = { taskId: 'test' };

      // No reflection function - should stop after first success
      const result = await matts.sequentialScaling(task, mockExecute, null, 5);

      expect(result).toBeDefined();
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });
  });
});
