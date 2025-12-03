const { logger } = require('./logger');

/**
 * Tool context validation utility to ensure safe data passing between tools
 */
class ContextValidator {
  constructor() {
    this.maxStringLength = 100000; // 100KB max for any string field
    this.maxArrayLength = 1000; // Max 1000 items in arrays
    this.maxObjectDepth = 10; // Max 10 levels of nested objects
  }

  /**
   * Validate tool execution context before passing to tools
   * @param {Object} context - Tool execution context
   * @returns {Object} Validation result with sanitized context
   */
  validateToolContext(context) {
    const result = {
      valid: true,
      errors: [],
      sanitized: null
    };

    try {
      // Handle null/undefined context
      if (context === null || context === undefined) {
        result.valid = false;
        result.errors.push('Tool context cannot be null or undefined');
        result.sanitized = {};
        return result;
      }

      // Must be an object
      if (typeof context !== 'object' || Array.isArray(context)) {
        result.valid = false;
        result.errors.push('Tool context must be an object');
        result.sanitized = {};
        return result;
      }

      const sanitized = {};

      // Validate knowledgeResults
      if (context.knowledgeResults !== undefined) {
        const knowledgeValidation = this.validateKnowledgeResults(context.knowledgeResults);
        if (!knowledgeValidation.valid) {
          result.errors.push(...knowledgeValidation.errors);
        }
        sanitized.knowledgeResults = knowledgeValidation.sanitized;
      }

      // Validate systemPrompt
      if (context.systemPrompt !== undefined) {
        const promptValidation = this.validateSystemPrompt(context.systemPrompt);
        if (!promptValidation.valid) {
          result.errors.push(...promptValidation.errors);
        }
        sanitized.systemPrompt = promptValidation.sanitized;
      }

      // Validate messageData
      if (context.messageData !== undefined) {
        const messageValidation = this.validateMessageData(context.messageData);
        if (!messageValidation.valid) {
          result.errors.push(...messageValidation.errors);
        }
        sanitized.messageData = messageValidation.sanitized;
      }

      // Validate conversationContext
      if (context.conversationContext !== undefined) {
        const conversationValidation = this.validateConversationContext(context.conversationContext);
        if (!conversationValidation.valid) {
          result.errors.push(...conversationValidation.errors);
        }
        sanitized.conversationContext = conversationValidation.sanitized;
      }

      // Validate previousToolResults
      if (context.previousToolResults !== undefined) {
        const toolResultsValidation = this.validatePreviousToolResults(context.previousToolResults);
        if (!toolResultsValidation.valid) {
          result.errors.push(...toolResultsValidation.errors);
        }
        sanitized.previousToolResults = toolResultsValidation.sanitized;
      }

      // Copy other safe fields
      ['currentCall'].forEach(field => {
        if (context[field] !== undefined) {
          sanitized[field] = this.deepClone(context[field], this.maxObjectDepth);
        }
      });

      result.valid = result.errors.length === 0;
      result.sanitized = sanitized;

      if (result.errors.length > 0) {
        logger.warn('Tool context validation issues', {
          errors: result.errors,
          contextKeys: Object.keys(context)
        });
      }

      return result;
    } catch (error) {
      logger.error('Tool context validation failed', {
        error: error.message,
        stack: error.stack
      });
      
      return {
        valid: false,
        errors: [`Validation error: ${error.message}`],
        sanitized: {}
      };
    }
  }

  /**
   * Validate knowledge results array
   */
  validateKnowledgeResults(knowledgeResults) {
    const result = { valid: true, errors: [], sanitized: [] };

    if (knowledgeResults === null || knowledgeResults === undefined) {
      result.sanitized = [];
      return result;
    }

    if (!Array.isArray(knowledgeResults)) {
      result.valid = false;
      result.errors.push('knowledgeResults must be an array');
      result.sanitized = [];
      return result;
    }

    if (knowledgeResults.length > this.maxArrayLength) {
      result.errors.push(`knowledgeResults array too large (${knowledgeResults.length} > ${this.maxArrayLength})`);
      result.sanitized = knowledgeResults.slice(0, this.maxArrayLength);
    } else {
      result.sanitized = knowledgeResults;
    }

    // Validate each knowledge result
    result.sanitized = result.sanitized.map((item, index) => {
      if (!item || typeof item !== 'object') {
        result.errors.push(`knowledgeResults[${index}] must be an object`);
        return null;
      }

      const sanitizedItem = {};
      const allowedFields = ['id', 'title', 'content', 'tags', 'category', 'priority', 'relevanceScore', 'preview'];
      
      allowedFields.forEach(field => {
        if (item[field] !== undefined) {
          if (field === 'tags' && Array.isArray(item[field])) {
            sanitizedItem[field] = item[field].slice(0, 50); // Max 50 tags
          } else if (typeof item[field] === 'string') {
            sanitizedItem[field] = this.truncateString(item[field], this.maxStringLength);
          } else if (typeof item[field] === 'number') {
            sanitizedItem[field] = item[field];
          }
        }
      });

      return sanitizedItem;
    }).filter(item => item !== null);

    result.valid = result.errors.length === 0;
    return result;
  }

  /**
   * Validate system prompt
   */
  validateSystemPrompt(systemPrompt) {
    const result = { valid: true, errors: [], sanitized: '' };

    if (systemPrompt === null || systemPrompt === undefined) {
      result.sanitized = '';
      return result;
    }

    if (typeof systemPrompt !== 'string') {
      result.valid = false;
      result.errors.push('systemPrompt must be a string');
      result.sanitized = '';
      return result;
    }

    result.sanitized = this.truncateString(systemPrompt, this.maxStringLength);
    
    if (result.sanitized.length !== systemPrompt.length) {
      result.errors.push(`systemPrompt truncated from ${systemPrompt.length} to ${result.sanitized.length} characters`);
    }

    return result;
  }

  /**
   * Validate message data
   */
  validateMessageData(messageData) {
    const result = { valid: true, errors: [], sanitized: {} };

    if (!messageData || typeof messageData !== 'object') {
      result.valid = false;
      result.errors.push('messageData must be an object');
      return result;
    }

    const allowedFields = ['userId', 'userRole', 'userName', 'message', 'messageId', 'chatId', 'dialogId', 'messageType', 'timestamp', 'platform'];
    
    allowedFields.forEach(field => {
      if (messageData[field] !== undefined) {
        if (typeof messageData[field] === 'string') {
          result.sanitized[field] = this.truncateString(messageData[field], 10000);
        } else if (typeof messageData[field] === 'number') {
          result.sanitized[field] = messageData[field];
        }
      }
    });

    return result;
  }

  /**
   * Validate conversation context
   */
  validateConversationContext(conversationContext) {
    const result = { valid: true, errors: [], sanitized: {} };

    if (!conversationContext || typeof conversationContext !== 'object') {
      result.sanitized = {};
      return result;
    }

    // Only copy safe fields, limit history size
    if (Array.isArray(conversationContext.history)) {
      result.sanitized.history = conversationContext.history.slice(-20); // Keep last 20 messages
    }

    ['lastMessage', 'lastResponse'].forEach(field => {
      if (typeof conversationContext[field] === 'string') {
        result.sanitized[field] = this.truncateString(conversationContext[field], 5000);
      }
    });

    return result;
  }

  /**
   * Validate previous tool results
   */
  validatePreviousToolResults(toolResults) {
    const result = { valid: true, errors: [], sanitized: [] };

    if (!Array.isArray(toolResults)) {
      result.valid = false;
      result.errors.push('previousToolResults must be an array');
      return result;
    }

    if (toolResults.length > 10) {
      result.errors.push(`Too many previous tool results (${toolResults.length} > 10)`);
      result.sanitized = toolResults.slice(-10); // Keep last 10
    } else {
      result.sanitized = toolResults;
    }

    // Sanitize each tool result
    result.sanitized = result.sanitized.map((toolResult, index) => {
      if (!toolResult || typeof toolResult !== 'object') {
        result.errors.push(`toolResults[${index}] must be an object`);
        return null;
      }

      const sanitized = {};
      
      if (typeof toolResult.name === 'string') {
        sanitized.name = toolResult.name.substring(0, 100);
      }
      
      if (toolResult.result !== undefined) {
        if (typeof toolResult.result === 'string') {
          sanitized.result = this.truncateString(toolResult.result, 5000);
        } else if (typeof toolResult.result === 'object') {
          sanitized.result = this.deepClone(toolResult.result, 3);
        } else {
          sanitized.result = toolResult.result;
        }
      }

      if (typeof toolResult.error === 'string') {
        sanitized.error = this.truncateString(toolResult.error, 1000);
      }

      return sanitized;
    }).filter(item => item !== null);

    result.valid = result.errors.length === 0;
    return result;
  }

  /**
   * Utility: Truncate string to max length
   */
  truncateString(str, maxLength) {
    if (typeof str !== 'string') {return '';}
    if (str.length <= maxLength) {return str;}
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Utility: Deep clone with depth limit to prevent infinite recursion
   */
  deepClone(obj, maxDepth = 5) {
    if (maxDepth <= 0) {return '[MAX_DEPTH_REACHED]';}
    if (obj === null || typeof obj !== 'object') {return obj;}
    if (obj instanceof Date) {return new Date(obj);}
    if (Array.isArray(obj)) {return obj.slice(0, 100).map(item => this.deepClone(item, maxDepth - 1));}
    
    const cloned = {};
    const keys = Object.keys(obj).slice(0, 50); // Max 50 properties
    
    keys.forEach(key => {
      cloned[key] = this.deepClone(obj[key], maxDepth - 1);
    });
    
    return cloned;
  }
}

// Singleton instance
let contextValidator;

function getContextValidator() {
  if (!contextValidator) {
    contextValidator = new ContextValidator();
  }
  return contextValidator;
}

module.exports = {
  ContextValidator,
  getContextValidator
};