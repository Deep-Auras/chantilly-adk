const { getGeminiClient } = require('../config/gemini');
const { getReasoningMemoryModel } = require('../models/reasoningMemory');
const { MemoryValidator } = require('./memoryValidator');
const { FieldValue } = require('@google-cloud/firestore');
const { logger } = require('../utils/logger');
const { getConfigManager } = require('./dashboard/configManager');

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

class MemoryExtractor {
  constructor() {
    this.client = getGeminiClient();
    this.memoryModel = getReasoningMemoryModel();
    this.validator = new MemoryValidator(); // Security: Validate memories before storage
  }

  /**
   * Extract memory items from successful task trajectory
   * Based on ReasoningBank success extraction (Appendix A.1)
   */
  async extractFromSuccess(trajectory) {
    const prompt = `You are analyzing a successful task execution to extract generalizable reasoning strategies and insights.

**Task Information:**
- Template: ${trajectory.templateName}
- Description: ${trajectory.templateDescription}
- Parameters: ${JSON.stringify(trajectory.parameters, null, 2)}

**Execution Trajectory:**
${this._formatTrajectory(trajectory.steps)}

**Final Outcome:**
- Status: Success
- Completion Time: ${trajectory.completionTime}ms
- Resource Usage: ${trajectory.resourceUsage}

**Instructions:**
Think about why this trajectory was successful. Extract generalizable insights that could help future tasks succeed.

Focus on:
1. Effective strategies used (e.g., API call patterns, error handling approaches)
2. Optimal parameter configurations
3. Successful integration patterns with Bitrix24 APIs
4. Efficient resource usage patterns

Extract at most 3 memory items. Each memory item should be:
- **Generalizable**: Not specific to this exact query/context
- **Actionable**: Provides concrete guidance for future tasks
- **Concise**: Clear and focused on one insight

Output Format (JSON array):
[
  {
    "title": "Brief identifier of the strategy (5-7 words)",
    "description": "One-sentence summary of the insight",
    "content": "Detailed reasoning steps and operational guidance (2-3 sentences)",
    "category": "error_pattern" | "fix_strategy" | "api_usage" | "general_strategy" | "generation_pattern"
  }
]

Respond ONLY with the JSON array, no additional text.`;

    try {
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
      const memories = JSON.parse(this._extractJSON(responseText));

      logger.info('Extracted memories from success', {
        templateName: trajectory.templateName,
        memoryCount: memories.length
      });

      // Generate embeddings and store memories
      for (const memory of memories) {
        await this._storeMemory(memory, {
          source: 'task_success',
          templateId: trajectory.templateId,
          taskId: trajectory.taskId
        });
      }

      return memories;

    } catch (error) {
      logger.error('Failed to extract memories from success', {
        error: error.message,
        templateName: trajectory.templateName
      });
      return [];
    }
  }

  /**
   * Extract memory items from failed task trajectory
   * Based on ReasoningBank failure extraction (Appendix A.1)
   */
  async extractFromFailure(trajectory) {
    const prompt = `You are analyzing a failed task execution to extract lessons learned and preventative strategies.

**Task Information:**
- Template: ${trajectory.templateName}
- Description: ${trajectory.templateDescription}
- Parameters: ${JSON.stringify(trajectory.parameters, null, 2)}

**Execution Trajectory:**
${this._formatTrajectory(trajectory.steps)}

**Failure Information:**
- Error Type: ${trajectory.error?.name}
- Error Message: ${trajectory.error?.message}
- Error Location: ${trajectory.error?.step}
- Execution Time Before Failure: ${trajectory.executionTime}ms

**Instructions:**
Reflect on why this trajectory failed. Extract lessons learned and strategies to prevent similar failures.

Focus on:
1. Root causes of the failure (not just symptoms)
2. Patterns that led to the error
3. What should have been done differently
4. Preventative strategies for future tasks

Extract at most 3 memory items. Each memory item should be:
- **Root-cause focused**: Identify underlying issues, not surface symptoms
- **Preventative**: Provide strategies to avoid the failure
- **Generalizable**: Apply to similar situations, not just this exact case

Output Format (JSON array):
[
  {
    "title": "Brief identifier of the lesson (5-7 words)",
    "description": "One-sentence summary of what went wrong and why",
    "content": "Detailed analysis of failure cause and preventative strategies (2-3 sentences)",
    "category": "error_pattern" | "fix_strategy" | "api_usage" | "general_strategy" | "generation_pattern"
  }
]

Respond ONLY with the JSON array, no additional text.`;

    try {
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
      const memories = JSON.parse(this._extractJSON(responseText));

      logger.info('Extracted memories from failure', {
        templateName: trajectory.templateName,
        errorType: trajectory.error?.name,
        memoryCount: memories.length
      });

      // Generate embeddings and store memories
      for (const memory of memories) {
        await this._storeMemory(memory, {
          source: 'task_failure',
          templateId: trajectory.templateId,
          taskId: trajectory.taskId
        });
      }

      return memories;

    } catch (error) {
      logger.error('Failed to extract memories from failure', {
        error: error.message,
        templateName: trajectory.templateName
      });
      return [];
    }
  }

  /**
   * Extract memory from repair attempt (unique to Chantilly)
   */
  async extractFromRepair(repairContext) {
    const prompt = `You are analyzing a template repair attempt to extract error patterns and fix strategies.

**Original Template:**
- Name: ${repairContext.templateName}
- Error Occurred: ${repairContext.originalError.message}

**Repair Process:**
- Repair Attempt: ${repairContext.repairAttempt}
- Repair Strategy Used: ${repairContext.repairStrategy}
- Repair Outcome: ${repairContext.repairSuccess ? 'Success' : 'Failed'}

**Code Changes:**
${repairContext.codeChanges || 'Not available'}

**Instructions:**
Extract lessons about error patterns and repair strategies that could help future repairs.

Focus on:
1. Common error patterns that trigger repairs
2. Effective repair strategies that work
3. Code patterns that prevent errors
4. Anti-patterns that cause failures

Extract at most 2 memory items focusing on repair knowledge.

Output Format (JSON array):
[
  {
    "title": "Brief identifier (5-7 words)",
    "description": "One-sentence summary",
    "content": "Detailed guidance (2-3 sentences)",
    "category": "error_pattern" | "fix_strategy"
  }
]

Respond ONLY with the JSON array, no additional text.`;

    try {
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
      const memories = JSON.parse(this._extractJSON(responseText));

      logger.info('Extracted memories from repair', {
        templateName: repairContext.templateName,
        repairSuccess: repairContext.repairSuccess,
        memoryCount: memories.length
      });

      // Generate embeddings and store memories
      for (const memory of memories) {
        await this._storeMemory(memory, {
          source: repairContext.repairSuccess ? 'repair_success' : 'repair_failure',
          templateId: repairContext.templateId,
          taskId: repairContext.taskId
        });
      }

      return memories;

    } catch (error) {
      logger.error('Failed to extract memories from repair', {
        error: error.message,
        templateName: repairContext.templateName
      });
      return [];
    }
  }

  /**
   * Extract memory from user-requested template modification
   * Captures human expertise and manual fixes
   */
  async extractFromUserModification(modificationContext) {
    const prompt = `You are analyzing a user-requested template modification to capture human expertise.

**Original Template:**
- Name: ${modificationContext.templateName}
- Description: ${modificationContext.templateDescription}

**User's Modification Request:**
"${modificationContext.userRequest}"

**Changes Made:**
${modificationContext.changesSummary || 'See code diff below'}

**Code Changes (if available):**
${modificationContext.codeDiff ?
  `BEFORE:\n${modificationContext.originalScript?.substring(0, 1000)}\n\nAFTER:\n${modificationContext.modifiedScript?.substring(0, 1000)}`
  : 'Not available'}

**Why User Made This Change:**
${modificationContext.modificationReason || 'User identified issue or improvement opportunity'}

**Instructions:**
Extract lessons learned from this human expert modification.

Focus on:
1. What was wrong with the original template that user noticed?
2. What pattern or principle does this fix represent?
3. How can future template generation avoid this issue?
4. What best practices does this modification demonstrate?

Extract at most 2 memory items focusing on generation and modification patterns.

Output Format (JSON array):
[
  {
    "title": "Brief identifier (5-7 words)",
    "description": "One-sentence summary of the lesson",
    "content": "Detailed guidance for future template generation (2-3 sentences)",
    "category": "generation_pattern" | "fix_strategy"
  }
]

Respond ONLY with the JSON array, no additional text.`;

    try {
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
      const memories = JSON.parse(this._extractJSON(responseText));

      logger.info('Extracted memories from user modification', {
        templateName: modificationContext.templateName,
        userRequest: modificationContext.userRequest?.substring(0, 100),
        memoryCount: memories.length
      });

      // Generate embeddings and store memories
      for (const memory of memories) {
        await this._storeMemory(memory, {
          source: 'user_modification',
          templateId: modificationContext.templateId,
          taskId: null,
          // Store user intent metadata (only the expected fields, not the entire context)
          userIntent: {
            originalRequest: modificationContext.userRequest || null,
            wantedNewTask: false,
            specifiedCustomName: null,
            wantedAggregate: false,
            wantedSpecificEntity: false,
            intentSatisfied: true,
            mismatchReason: null,
            requests: [] // Array of related request strings/IDs
          }
        });
      }

      return memories;

    } catch (error) {
      logger.error('Failed to extract memories from user modification', {
        error: error.message,
        templateName: modificationContext.templateName
      });
      return [];
    }
  }

  /**
   * Store memory with embedding (with validation)
   */
  async _storeMemory(memory, metadata) {
    try {
      // Security: Validate memory structure and content before processing
      const memoryValidation = this.validator.validateMemory(memory, metadata.source);
      if (!memoryValidation.valid) {
        logger.warn('Memory failed validation, skipping storage', {
          memoryTitle: memory.title?.substring(0, 50) || 'unknown',
          errors: memoryValidation.errors,
          source: metadata.source
        });
        return; // Don't store invalid memories
      }

      const embeddingText = `${memory.title}. ${memory.description}. ${memory.content}`;

      const embeddingResult = await this.client.models.embedContent({
        model: 'text-embedding-004',
        content: embeddingText
      });

      const embedding = embeddingResult.embedding.values;

      // Security: Validate embedding format before storage
      const embeddingValidation = this.validator.validateEmbedding(embedding);
      if (!embeddingValidation.valid) {
        logger.warn('Memory embedding failed validation, skipping storage', {
          memoryTitle: memory.title?.substring(0, 50),
          errors: embeddingValidation.errors,
          source: metadata.source
        });
        return; // Don't store memories with invalid embeddings
      }

      // Both validations passed, safe to store
      // Only pass expected fields to avoid Firestore schema errors
      const memoryToStore = {
        title: memory.title,
        description: memory.description,
        content: memory.content,
        category: memory.category,
        source: metadata.source,
        templateId: metadata.templateId || null,
        taskId: metadata.taskId || null,
        userIntent: metadata.userIntent || null,
        embedding: embedding // Will be wrapped in FieldValue.vector() by addMemory()
      };

      // Debug: Log the exact structure being stored
      logger.debug('Attempting to store memory', {
        memoryTitle: memory.title?.substring(0, 50),
        hasUserIntent: !!memoryToStore.userIntent,
        userIntentKeys: memoryToStore.userIntent ? Object.keys(memoryToStore.userIntent) : [],
        source: metadata.source
      });

      await this.memoryModel.addMemory(memoryToStore);

      logger.debug('Memory stored successfully after validation', {
        memoryTitle: memory.title?.substring(0, 50),
        category: memory.category,
        source: metadata.source
      });

    } catch (error) {
      logger.error('Failed to process memory for storage', {
        error: error.message,
        memoryTitle: memory.title?.substring(0, 50) || 'unknown',
        source: metadata.source
      });
    }
  }

  /**
   * Format trajectory steps for LLM consumption
   */
  _formatTrajectory(steps) {
    if (!steps || steps.length === 0) {
      return 'No steps recorded';
    }

    return steps.map((step, index) => {
      return `Step ${index + 1}: ${step.action}
  Description: ${step.description}
  Status: ${step.status}
  ${step.result ? `Result: ${JSON.stringify(step.result).substring(0, 200)}` : ''}
  ${step.error ? `Error: ${step.error}` : ''}`;
    }).join('\n\n');
  }

  /**
   * Extract JSON from response (handles markdown code blocks)
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
function getMemoryExtractor() {
  if (!instance) {
    instance = new MemoryExtractor();
  }
  return instance;
}

module.exports = {
  MemoryExtractor,
  getMemoryExtractor
};
