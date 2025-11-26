const BaseTool = require('../lib/baseTool');
const { getReasoningMemoryModel } = require('../models/reasoningMemory');
const embeddingService = require('../services/embeddingService');

/**
 * MemoryManagementTool - Manage ReasoningBank memory system
 *
 * Allows users to interact with the memory system via chat:
 * - List recent memories
 * - Search memories by query
 * - View memory statistics
 * - Delete specific memories (admin only)
 */
class MemoryManagementTool extends BaseTool {
  constructor() {
    super();

    this.name = 'MemoryManagement';
    this.description = 'Manage ReasoningBank memory: list, search, delete, and analyze memory items from past task executions and repairs';
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'search', 'delete', 'stats'],
          description: 'Action to perform: list (show recent memories), search (find by query), delete (remove memory), stats (system statistics)'
        },
        memoryId: {
          type: 'string',
          description: 'Memory ID (required for delete action)'
        },
        searchQuery: {
          type: 'string',
          description: 'Search query text (required for search action)'
        },
        category: {
          type: 'string',
          enum: ['error_pattern', 'fix_strategy', 'api_usage', 'general_strategy'],
          description: 'Filter by category (optional for list/search)'
        },
        limit: {
          type: 'number',
          description: 'Number of results to return (default: 10, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['action']
    };
    this.priority = 40;
    this.memoryModel = null;
  }

  async initialize() {
    if (!this.memoryModel) {
      this.memoryModel = getReasoningMemoryModel();
      await this.memoryModel.initialize();
    }
  }

  async shouldTrigger(message, context) {
    const patterns = [
      /list.*memor(y|ies)/i,
      /show.*memor(y|ies)/i,
      /search.*memor(y|ies)/i,
      /find.*memor(y|ies)/i,
      /delete.*memory/i,
      /remove.*memory/i,
      /memory.*stats/i,
      /memory.*statistics/i,
      /reasoning.*memory/i,
      /what.*learned/i,
      /what.*remember/i,
      /view.*memor(y|ies)/i
    ];

    return patterns.some(pattern => pattern.test(message));
  }

  async execute(params, context) {
    try {
      await this.initialize();

      switch (params.action) {
      case 'list':
        return await this._listMemories(params);
      case 'search':
        return await this._searchMemories(params, context);
      case 'delete':
        return await this._deleteMemory(params, context);
      case 'stats':
        return await this._getMemoryStats();
      default:
        return {
          success: false,
          error: 'Invalid action. Use: list, search, delete, or stats'
        };
      }
    } catch (error) {
      this.log('error', 'Memory management failed', {
        action: params.action,
        error: error.message
      });

      return {
        success: false,
        error: `Memory management failed: ${error.message}`
      };
    }
  }

  async _listMemories(params) {
    const limit = params.limit || 10;
    const memories = await this.memoryModel.getAllMemories(limit);

    if (memories.length === 0) {
      return {
        success: true,
        message: 'No memories found in the system yet. Memories will be created automatically as tasks complete and repairs occur.',
        memories: []
      };
    }

    const formattedMemories = memories.map(m => ({
      id: m.id,
      title: m.title,
      description: m.description,
      category: m.category,
      source: m.source,
      successRate: m.successRate ? (m.successRate * 100).toFixed(0) + '%' : 'N/A',
      timesRetrieved: m.timesRetrieved || 0,
      createdAt: m.createdAt?.toDate ? m.createdAt.toDate().toISOString() : m.createdAt
    }));

    return {
      success: true,
      message: `Found ${memories.length} memory items (showing most recent):`,
      memories: formattedMemories,
      totalShown: memories.length
    };
  }

  async _searchMemories(params, context) {
    if (!params.searchQuery) {
      return {
        success: false,
        error: 'Search query is required. Example: "search memories for API rate limits"'
      };
    }

    this.log('info', 'Searching memories', {
      query: params.searchQuery,
      category: params.category
    });

    // Generate embedding for search query
    const queryEmbedding = await embeddingService.embedQuery(
      params.searchQuery,
      'RETRIEVAL_QUERY'
    );

    // Retrieve relevant memories
    const topK = params.limit || 5;
    const memories = await this.memoryModel.retrieveMemories(queryEmbedding, topK, {
      category: params.category
    });

    if (memories.length === 0) {
      return {
        success: true,
        message: `No relevant memories found for "${params.searchQuery}". Try a different search term or check available categories.`,
        memories: [],
        searchQuery: params.searchQuery
      };
    }

    const formattedMemories = memories.map(m => ({
      id: m.id,
      title: m.title,
      description: m.description,
      content: m.content,
      category: m.category,
      source: m.source,
      similarityScore: (m.similarityScore * 100).toFixed(1) + '%',
      successRate: m.successRate ? (m.successRate * 100).toFixed(0) + '%' : 'N/A',
      timesRetrieved: m.timesRetrieved || 0
    }));

    this.log('info', 'Memory search completed', {
      query: params.searchQuery,
      resultsFound: memories.length,
      topSimilarity: memories[0]?.similarityScore
    });

    return {
      success: true,
      message: `Found ${memories.length} relevant memories for "${params.searchQuery}":`,
      memories: formattedMemories,
      searchQuery: params.searchQuery
    };
  }

  async _deleteMemory(params, context) {
    if (!params.memoryId) {
      return {
        success: false,
        error: 'Memory ID is required for delete action'
      };
    }

    // Check if user has admin permissions (optional - implement based on your auth system)
    // For now, allow deletion but log it

    this.log('warn', 'Memory deletion requested', {
      memoryId: params.memoryId,
      userId: context?.userId
    });

    try {
      await this.memoryModel.db.collection(this.memoryModel.collectionName)
        .doc(params.memoryId)
        .delete();

      this.log('info', 'Memory deleted', {
        memoryId: params.memoryId
      });

      return {
        success: true,
        message: `Memory ${params.memoryId} has been deleted from the system.`,
        memoryId: params.memoryId
      };

    } catch (error) {
      this.log('error', 'Memory deletion failed', {
        memoryId: params.memoryId,
        error: error.message
      });

      return {
        success: false,
        error: `Failed to delete memory: ${error.message}`
      };
    }
  }

  async _getMemoryStats() {
    const memories = await this.memoryModel.getAllMemories(1000);

    if (memories.length === 0) {
      return {
        success: true,
        message: 'No memories in the system yet. Statistics will be available after tasks complete and repairs occur.',
        stats: {
          totalMemories: 0,
          bySource: {},
          byCategory: {},
          avgSuccessRate: 'N/A',
          topPerformers: []
        }
      };
    }

    const stats = {
      totalMemories: memories.length,
      bySource: {},
      byCategory: {},
      avgSuccessRate: 0,
      totalRetrievals: 0,
      topPerformers: []
    };

    memories.forEach(m => {
      stats.bySource[m.source] = (stats.bySource[m.source] || 0) + 1;
      stats.byCategory[m.category] = (stats.byCategory[m.category] || 0) + 1;
      stats.totalRetrievals += m.timesRetrieved || 0;
    });

    // Calculate average success rate
    const memoriesWithRate = memories.filter(m => m.successRate != null);
    if (memoriesWithRate.length > 0) {
      stats.avgSuccessRate = memoriesWithRate.reduce((sum, m) => sum + m.successRate, 0) / memoriesWithRate.length;
      stats.avgSuccessRate = (stats.avgSuccessRate * 100).toFixed(1) + '%';
    } else {
      stats.avgSuccessRate = 'N/A';
    }

    // Top performers
    stats.topPerformers = memories
      .filter(m => m.successRate != null && m.timesRetrieved > 0)
      .sort((a, b) => {
        // Sort by success rate first, then by retrieval count
        if (b.successRate !== a.successRate) {
          return b.successRate - a.successRate;
        }
        return b.timesRetrieved - a.timesRetrieved;
      })
      .slice(0, 5)
      .map(m => ({
        title: m.title,
        category: m.category,
        successRate: (m.successRate * 100).toFixed(0) + '%',
        timesRetrieved: m.timesRetrieved,
        timesUsedInSuccess: m.timesUsedInSuccess || 0,
        timesUsedInFailure: m.timesUsedInFailure || 0
      }));

    this.log('info', 'Memory statistics retrieved', {
      totalMemories: stats.totalMemories,
      avgSuccessRate: stats.avgSuccessRate
    });

    return {
      success: true,
      message: 'Memory system statistics:',
      stats: stats
    };
  }
}

module.exports = MemoryManagementTool;
