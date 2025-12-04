/**
 * Build Memory Service
 * Integrates ReasoningMemory with Build Mode for learning from code changes
 *
 * Extracts memories from:
 * - Rejected code changes (what to avoid - user spotted issues)
 * - Build failures (CI/CD feedback - code broke something)
 *
 * Note: We intentionally do NOT learn from approvals or build successes.
 * Approval just means user okayed it, not that it's good code.
 * Build success is the baseline expectation, not a noteworthy event.
 *
 * Retrieves memories to improve code generation quality
 */

const { getGeminiClient } = require('../../config/gemini');
const { getReasoningMemoryModel } = require('../../models/reasoningMemory');
const { MemoryValidator } = require('../memoryValidator');
const { logger } = require('../../utils/logger');
const { getConfigManager } = require('../dashboard/configManager');
const embeddingService = require('../embeddingService');

/**
 * Get Gemini model name from centralized config
 */
async function getGeminiModelName() {
  const configManager = await getConfigManager();
  const modelName = await configManager.get('config', 'GEMINI_MODEL');
  if (!modelName) {
    throw new Error('GEMINI_MODEL not configured in Firestore agent/config');
  }
  return modelName;
}

class BuildMemoryService {
  constructor() {
    this.client = getGeminiClient();
    this.memoryModel = getReasoningMemoryModel();
    this.validator = new MemoryValidator();
  }

  /**
   * Extract memory from a rejected code modification
   * Learns what to avoid in code changes
   *
   * @param {Object} modification - The rejected modification record
   * @param {string} rejectionReason - Why it was rejected
   */
  async extractFromRejection(modification, rejectionReason) {
    const prompt = `You are analyzing a rejected code modification to learn what to avoid in future code changes.

**Modification Details:**
- File: ${modification.filePath}
- Operation: ${modification.operation}
- Commit Message: ${modification.commitMessage}
- Rejection Reason: ${rejectionReason || 'Not specified'}

**Proposed Code Change:**
\`\`\`
${this._truncateContent(modification.afterContent, 2000)}
\`\`\`

**Original Code (if update):**
\`\`\`
${this._truncateContent(modification.beforeContent, 1500)}
\`\`\`

**Instructions:**
Analyze why this code change was rejected. Extract lessons about:
1. Patterns to avoid in generated code
2. Common mistakes that lead to rejection
3. What makes code changes unacceptable
4. How to improve code quality

Extract at most 2 memory items. Each should be:
- **Root-cause focused**: Identify the underlying issue
- **Preventative**: Help avoid similar rejections
- **Generalizable**: Apply to future code generation

Output Format (JSON array):
[
  {
    "title": "Brief identifier (5-7 words)",
    "description": "One-sentence summary of what to avoid",
    "content": "Detailed guidance on preventing this issue (2-3 sentences)",
    "category": "code_rejection"
  }
]

Respond ONLY with the JSON array, no additional text.`;

    try {
      const memories = await this._extractMemories(prompt);

      logger.info('Extracted memories from code rejection', {
        filePath: modification.filePath,
        rejectionReason: rejectionReason?.substring(0, 100),
        memoryCount: memories.length
      });

      // Store memories
      for (const memory of memories) {
        await this._storeMemory(memory, {
          source: 'build_rejection',
          filePath: modification.filePath,
          operation: modification.operation,
          rejectionReason: rejectionReason
        });
      }

      return memories;
    } catch (error) {
      logger.error('Failed to extract memories from rejection', {
        error: error.message,
        filePath: modification.filePath
      });
      return [];
    }
  }

  /**
   * Extract memory from a failed build (CI/CD feedback)
   * Only extracts from failures - success is the baseline expectation
   *
   * @param {Object} buildResult - Build result information
   * @param {string} buildResult.status - SUCCESS, FAILURE, etc.
   * @param {string} buildResult.branch - Branch that was built
   * @param {Array} buildResult.recentCommits - Recent commits in build
   * @param {string} buildResult.errorLogs - Error logs if failed
   */
  async extractFromBuildFailure(buildResult) {
    // Only extract memories from failures - success is expected, not noteworthy
    if (buildResult.status === 'SUCCESS') {
      logger.debug('Skipping memory extraction for successful build', {
        branch: buildResult.branch
      });
      return [];
    }

    const prompt = `You are analyzing a failed CI/CD build to extract lessons about what breaks builds.

**Build Details:**
- Status: ${buildResult.status}
- Branch: ${buildResult.branch}
- Duration: ${buildResult.duration || 'unknown'}

**Recent Commits:**
${(buildResult.recentCommits || []).slice(0, 5).map(c => `- ${c.message}`).join('\n') || 'No commit info'}

**Error Logs:**
\`\`\`
${this._truncateContent(buildResult.errorLogs, 1500)}
\`\`\`

**Instructions:**
Analyze why this build failed. Extract lessons to prevent similar failures.

Focus on:
1. Common causes of build failures
2. Code patterns that break builds
3. Configuration issues to avoid
4. Test failures and their root causes

Extract at most 2 memory items.

Output Format (JSON array):
[
  {
    "title": "Brief identifier (5-7 words)",
    "description": "One-sentence summary",
    "content": "Detailed guidance (2-3 sentences)",
    "category": "build_failure"
  }
]

Respond ONLY with the JSON array, no additional text.`;

    try {
      const memories = await this._extractMemories(prompt);

      logger.info('Extracted memories from build failure', {
        status: buildResult.status,
        branch: buildResult.branch,
        memoryCount: memories.length
      });

      // Store memories
      for (const memory of memories) {
        await this._storeMemory(memory, {
          source: 'build_failure',
          branch: buildResult.branch,
          buildId: buildResult.buildId
        });
      }

      return memories;
    } catch (error) {
      logger.error('Failed to extract memories from build failure', {
        error: error.message,
        status: buildResult.status
      });
      return [];
    }
  }

  /**
   * Retrieve relevant memories for code generation context
   * Called before generating code to provide historical context
   *
   * @param {string} taskDescription - Description of the code task
   * @param {string} filePath - Target file path (optional)
   * @param {number} topK - Number of memories to retrieve
   * @returns {Array} Relevant memories with guidance
   */
  async retrieveForCodeGeneration(taskDescription, filePath = null, topK = 5) {
    try {
      // Generate embedding for the task
      const queryText = filePath
        ? `Code modification for ${filePath}: ${taskDescription}`
        : `Code generation task: ${taskDescription}`;

      const queryEmbedding = await embeddingService.embedQuery(
        queryText,
        'RETRIEVAL_QUERY'
      );

      // Retrieve memories with build-related categories
      const memories = await this.memoryModel.retrieveMemories(
        queryEmbedding,
        topK,
        { minSuccessRate: 0.5 } // Only use memories with decent track record
      );

      // Filter to build-related categories if we have enough
      // Note: We only learn from failures (rejection, build_failure) not successes
      const buildCategories = [
        'code_rejection', 'build_failure',
        'generation_pattern', 'fix_strategy',
        'error_pattern'
      ];

      const buildMemories = memories.filter(m =>
        buildCategories.includes(m.category)
      );

      // Use build-specific if we have them, otherwise use general
      const relevantMemories = buildMemories.length >= 2
        ? buildMemories
        : memories;

      logger.info('Retrieved memories for code generation', {
        taskDescription: taskDescription.substring(0, 100),
        filePath,
        totalFound: memories.length,
        buildSpecific: buildMemories.length,
        returned: relevantMemories.length
      });

      return relevantMemories;
    } catch (error) {
      logger.error('Failed to retrieve memories for code generation', {
        error: error.message,
        taskDescription: taskDescription?.substring(0, 100)
      });
      return [];
    }
  }

  /**
   * Format memories for inclusion in system prompt
   *
   * @param {Array} memories - Retrieved memories
   * @returns {string} Formatted guidance text
   */
  formatMemoriesForPrompt(memories) {
    if (!memories || memories.length === 0) {
      return '';
    }

    const guidance = memories.map((m, i) => {
      const successInfo = m.successRate !== null
        ? ` (${Math.round(m.successRate * 100)}% success rate)`
        : '';
      return `${i + 1}. **${m.title}**${successInfo}
   ${m.description}
   ${m.content}`;
    }).join('\n\n');

    return `
## Historical Code Generation Guidance

Based on previous successful patterns and lessons learned:

${guidance}

Apply these insights when generating code.`;
  }

  /**
   * Private: Extract memories using Gemini
   */
  async _extractMemories(prompt) {
    const modelName = await getGeminiModelName();
    const result = await this.client.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 4096
      }
    });

    const responseText = result.candidates[0].content.parts[0].text;
    return JSON.parse(this._extractJSON(responseText));
  }

  /**
   * Private: Store memory with embedding
   */
  async _storeMemory(memory, metadata) {
    try {
      // Validate memory structure
      const memoryValidation = this.validator.validateMemory(memory, metadata.source);
      if (!memoryValidation.valid) {
        logger.warn('Build memory failed validation, skipping', {
          memoryTitle: memory.title?.substring(0, 50),
          errors: memoryValidation.errors,
          source: metadata.source
        });
        return;
      }

      // Generate embedding
      const embeddingText = `${memory.title}. ${memory.description}. ${memory.content}`;
      const embeddingResult = await this.client.models.embedContent({
        model: 'text-embedding-004',
        content: embeddingText
      });

      const embedding = embeddingResult.embedding.values;

      // Validate embedding
      const embeddingValidation = this.validator.validateEmbedding(embedding);
      if (!embeddingValidation.valid) {
        logger.warn('Build memory embedding failed validation, skipping', {
          memoryTitle: memory.title?.substring(0, 50),
          errors: embeddingValidation.errors
        });
        return;
      }

      // Store with metadata
      await this.memoryModel.addMemory({
        title: memory.title,
        description: memory.description,
        content: memory.content,
        category: memory.category,
        source: metadata.source,
        templateId: null,
        taskId: null,
        embedding: embedding,
        userIntent: {
          originalRequest: null,
          wantedNewTask: false,
          specifiedCustomName: null,
          wantedAggregate: false,
          wantedSpecificEntity: false,
          intentSatisfied: true,
          mismatchReason: null,
          requests: []
        }
      });

      logger.debug('Build memory stored successfully', {
        memoryTitle: memory.title?.substring(0, 50),
        category: memory.category,
        source: metadata.source
      });
    } catch (error) {
      logger.error('Failed to store build memory', {
        error: error.message,
        memoryTitle: memory.title?.substring(0, 50)
      });
    }
  }

  /**
   * Private: Truncate content for LLM context
   */
  _truncateContent(content, maxLength) {
    if (!content) {
      return 'N/A';
    }
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength) + '\n... [truncated]';
  }

  /**
   * Private: Extract JSON from LLM response
   */
  _extractJSON(text) {
    const codeBlockMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1];
    }

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    return text;
  }
}

// Singleton
let instance = null;
function getBuildMemoryService() {
  if (!instance) {
    instance = new BuildMemoryService();
  }
  return instance;
}

module.exports = {
  BuildMemoryService,
  getBuildMemoryService
};
