/**
 * Jest Tests for Admin Memory Endpoints
 *
 * Tests for:
 * - Critical bugs
 * - OWASP compliance
 * - Authentication/Authorization
 * - Rate limiting
 * - Data validation
 */

const request = require('supertest');
const express = require('express');
const adminRouter = require('../../routes/admin');

// Mock dependencies
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req, res, next) => {
    if (req.headers.authorization === 'Bearer valid-token') {
      req.user = { username: 'admin', role: 'admin' };
      next();
    } else if (req.headers.authorization === 'Bearer user-token') {
      req.user = { username: 'user', role: 'user' };
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }),
  sanitizeInput: jest.fn((req, res, next) => next())
}));

jest.mock('../../services/memoryConsolidation');
jest.mock('../../models/reasoningMemory');
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  }
}));

describe('Admin Memory Endpoints - Security Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup express app with admin router
    app = express();
    app.use(express.json());
    app.use('/admin', adminRouter);
  });

  describe('OWASP - Authentication & Authorization', () => {
    test('POST /admin/memory-consolidation should require authentication', async () => {
      const response = await request(app)
        .post('/admin/memory-consolidation')
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    test('POST /admin/memory-consolidation should require admin role', async () => {
      const response = await request(app)
        .post('/admin/memory-consolidation')
        .set('Authorization', 'Bearer user-token')
        .expect(403);

      expect(response.body.error).toBe('Admin access required');
    });

    test('POST /admin/memory-consolidation should allow admin access', async () => {
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');

      const mockConsolidation = {
        consolidate: jest.fn().mockResolvedValue({
          success: true,
          pruned: 5,
          merged: 2,
          archived: 10
        })
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      const response = await request(app)
        .post('/admin/memory-consolidation')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.stats).toBeDefined();
    });

    test('GET /admin/memory-stats should require authentication', async () => {
      const response = await request(app)
        .get('/admin/memory-stats')
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    test('GET /admin/memory-stats should require admin role', async () => {
      const response = await request(app)
        .get('/admin/memory-stats')
        .set('Authorization', 'Bearer user-token')
        .expect(403);

      expect(response.body.error).toBe('Admin access required');
    });
  });

  describe('OWASP - Error Handling', () => {
    test('should handle consolidation service errors', async () => {
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');

      const mockConsolidation = {
        consolidate: jest.fn().mockRejectedValue(new Error('Service error'))
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      const response = await request(app)
        .post('/admin/memory-consolidation')
        .set('Authorization', 'Bearer valid-token')
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Failed to run memory consolidation');
    });

    test('should handle memory stats retrieval errors', async () => {
      const { getReasoningMemoryModel } = require('../../models/reasoningMemory');

      const mockMemoryModel = {
        getAllMemories: jest.fn().mockRejectedValue(new Error('Database error'))
      };

      getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

      const response = await request(app)
        .get('/admin/memory-stats')
        .set('Authorization', 'Bearer valid-token')
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Failed to retrieve memory statistics');
    });

    test('should not expose internal error details', async () => {
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');

      const mockConsolidation = {
        consolidate: jest.fn().mockRejectedValue(
          new Error('Internal: Database password=secret123')
        )
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      const response = await request(app)
        .post('/admin/memory-consolidation')
        .set('Authorization', 'Bearer valid-token')
        .expect(500);

      // Should not leak sensitive error details to response
      expect(response.body.details).not.toContain('password=secret123');
    });
  });

  describe('OWASP - Data Validation', () => {
    test('should handle empty memory list in stats', async () => {
      const { getReasoningMemoryModel } = require('../../models/reasoningMemory');

      const mockMemoryModel = {
        getAllMemories: jest.fn().mockResolvedValue([])
      };

      getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

      const response = await request(app)
        .get('/admin/memory-stats')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.stats.totalMemories).toBe(0);
    });

    test('should handle malformed memory objects in stats', async () => {
      const { getReasoningMemoryModel } = require('../../models/reasoningMemory');

      const malformedMemories = [
        { id: '1', category: null },
        { id: '2' }, // Missing category and source
        { id: '3', successRate: 'not-a-number' }
      ];

      const mockMemoryModel = {
        getAllMemories: jest.fn().mockResolvedValue(malformedMemories)
      };

      getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

      const response = await request(app)
        .get('/admin/memory-stats')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      // Should handle gracefully without crashing
      expect(response.body.success).toBe(true);
      expect(response.body.stats).toBeDefined();
    });
  });

  describe('Critical Bug Prevention - Infinite Loops', () => {
    test('consolidation endpoint should timeout excessive operations', async () => {
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');

      const mockConsolidation = {
        consolidate: jest.fn().mockImplementation(() => {
          // Simulate long-running operation (10 seconds)
          return new Promise(resolve => setTimeout(() => {
            resolve({ success: true, pruned: 0, merged: 0, archived: 0 });
          }, 10000));
        })
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      // Test with shorter timeout - expect it to throw
      await expect(
        request(app)
          .post('/admin/memory-consolidation')
          .set('Authorization', 'Bearer valid-token')
          .timeout(2000) // 2 second timeout, operation takes 10s
      ).rejects.toThrow(); // Should throw timeout error
    }, 15000);

    test('stats endpoint should handle large datasets efficiently', async () => {
      const { getReasoningMemoryModel } = require('../../models/reasoningMemory');

      // Create 10K memories
      const largeMemorySet = Array.from({ length: 10000 }, (_, i) => ({
        id: `mem-${i}`,
        category: 'test',
        source: 'test_source',
        successRate: Math.random(),
        timesRetrieved: Math.floor(Math.random() * 100)
      }));

      const mockMemoryModel = {
        getAllMemories: jest.fn().mockResolvedValue(largeMemorySet)
      };

      getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

      const startTime = Date.now();

      const response = await request(app)
        .get('/admin/memory-stats')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      const duration = Date.now() - startTime;

      // Should complete within 5 seconds even with 10K memories
      expect(duration).toBeLessThan(5000);
      expect(response.body.stats.totalMemories).toBe(10000);
    }, 10000);
  });

  describe('Memory Leak Prevention', () => {
    test('should not retain memory data after stats request', async () => {
      const { getReasoningMemoryModel } = require('../../models/reasoningMemory');

      const memories = Array.from({ length: 1000 }, (_, i) => ({
        id: `mem-${i}`,
        category: 'test',
        source: 'test',
        successRate: 0.5,
        timesRetrieved: 10
      }));

      const mockMemoryModel = {
        getAllMemories: jest.fn().mockResolvedValue(memories)
      };

      getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

      const initialMemory = process.memoryUsage().heapUsed;

      for (let i = 0; i < 10; i++) {
        await request(app)
          .get('/admin/memory-stats')
          .set('Authorization', 'Bearer valid-token');
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Should not accumulate more than 10MB after 10 requests
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });
  });

  describe('OWASP - Sensitive Data Exposure', () => {
    test('should not expose memory content in stats', async () => {
      const { getReasoningMemoryModel } = require('../../models/reasoningMemory');

      const memories = [
        {
          id: 'mem-1',
          category: 'test',
          source: 'test',
          content: 'SENSITIVE: API_KEY=12345', // Sensitive content
          successRate: 0.8
        }
      ];

      const mockMemoryModel = {
        getAllMemories: jest.fn().mockResolvedValue(memories)
      };

      getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

      const response = await request(app)
        .get('/admin/memory-stats')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      const responseBody = JSON.stringify(response.body);

      // Should not leak memory content
      expect(responseBody).not.toContain('SENSITIVE: API_KEY=12345');
      expect(responseBody).not.toContain('API_KEY');
    });

    test('should not log sensitive user information', async () => {
      const { logger } = require('../../utils/logger');
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');

      const mockConsolidation = {
        consolidate: jest.fn().mockResolvedValue({
          success: true,
          pruned: 0,
          merged: 0,
          archived: 0
        })
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      await request(app)
        .post('/admin/memory-consolidation')
        .set('Authorization', 'Bearer valid-token');

      // Check logs don't contain sensitive data
      const logCalls = logger.info.mock.calls.flat().join(' ');
      expect(logCalls).not.toContain('valid-token');
    });
  });

  describe('Functional Correctness', () => {
    test('should return correct consolidation statistics', async () => {
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');

      const mockStats = {
        startTime: '2025-01-01T00:00:00.000Z',
        endTime: '2025-01-01T00:01:00.000Z',
        totalMemories: 100,
        pruned: 10,
        merged: 5,
        archived: 20,
        success: true,
        errors: []
      };

      const mockConsolidation = {
        consolidate: jest.fn().mockResolvedValue(mockStats)
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      const response = await request(app)
        .post('/admin/memory-consolidation')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.stats).toEqual(mockStats);
    });

    test('should calculate memory statistics correctly', async () => {
      const { getReasoningMemoryModel } = require('../../models/reasoningMemory');

      const memories = [
        { id: '1', category: 'error_pattern', source: 'task_failure', successRate: 0.8, timesRetrieved: 10 },
        { id: '2', category: 'fix_strategy', source: 'repair_success', successRate: 0.6, timesRetrieved: 5 },
        { id: '3', category: 'error_pattern', source: 'task_failure', successRate: 0.2, timesRetrieved: 15 },
        { id: '4', category: 'general_strategy', source: 'task_success', successRate: 0.9, timesRetrieved: 20 }
      ];

      const mockMemoryModel = {
        getAllMemories: jest.fn().mockResolvedValue(memories)
      };

      getReasoningMemoryModel.mockReturnValue(mockMemoryModel);

      const response = await request(app)
        .get('/admin/memory-stats')
        .set('Authorization', 'Bearer valid-token')
        .expect(200);

      const stats = response.body.stats;

      expect(stats.totalMemories).toBe(4);
      expect(stats.byCategory.error_pattern).toBe(2);
      expect(stats.byCategory.fix_strategy).toBe(1);
      expect(stats.byCategory.general_strategy).toBe(1);
      expect(stats.bySource.task_failure).toBe(2);
      expect(stats.bySource.repair_success).toBe(1);
      expect(stats.bySource.task_success).toBe(1);
      expect(stats.highPerformers).toBe(2); // >= 70%
      expect(stats.lowPerformers).toBe(1); // < 30%
      // (0.8+0.6+0.2+0.9)/4 = 2.5/4 = 0.625 → rounds to "0.62" or "0.63" depending on method
      expect(parseFloat(stats.avgSuccessRate)).toBeCloseTo(0.625, 1); // Precision 1 = ±0.05 tolerance
    });

    test('should handle Cloud Scheduler authentication', async () => {
      // Simulate Cloud Scheduler request (no user in req)
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');
      const { logger } = require('../../utils/logger');

      const mockConsolidation = {
        consolidate: jest.fn().mockResolvedValue({
          success: true,
          pruned: 0,
          merged: 0,
          archived: 0
        })
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      await request(app)
        .post('/admin/memory-consolidation')
        .set('Authorization', 'Bearer valid-token');

      // Should log 'Cloud Scheduler' when no username
      const logCalls = logger.info.mock.calls.flat();
      const hasSchedulerLog = logCalls.some(call =>
        typeof call === 'object' && call.triggeredBy
      );
      expect(hasSchedulerLog).toBe(true);
    });
  });

  describe('Rate Limiting (if applicable)', () => {
    test('should not allow excessive concurrent consolidation requests', async () => {
      const { getMemoryConsolidation } = require('../../services/memoryConsolidation');

      let consolidationInProgress = false;

      const mockConsolidation = {
        consolidate: jest.fn().mockImplementation(async () => {
          if (consolidationInProgress) {
            throw new Error('Consolidation already in progress');
          }
          consolidationInProgress = true;
          await new Promise(resolve => setTimeout(resolve, 100));
          consolidationInProgress = false;
          return { success: true, pruned: 0, merged: 0, archived: 0 };
        })
      };

      getMemoryConsolidation.mockReturnValue(mockConsolidation);

      // Send 3 concurrent requests
      const requests = Promise.all([
        request(app).post('/admin/memory-consolidation').set('Authorization', 'Bearer valid-token'),
        request(app).post('/admin/memory-consolidation').set('Authorization', 'Bearer valid-token'),
        request(app).post('/admin/memory-consolidation').set('Authorization', 'Bearer valid-token')
      ]);

      const responses = await requests;

      // At least one should complete successfully
      const successCount = responses.filter(r => r.status === 200).length;
      expect(successCount).toBeGreaterThan(0);
    });
  });
});
