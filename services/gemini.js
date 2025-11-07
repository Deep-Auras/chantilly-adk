const { getGeminiModel, getGeminiClient, createCustomModel, extractGeminiText } = require('../config/gemini');
const config = require('../config/env');
const { getPromptsModel } = require('../models/prompts');
const { getSettingsModel } = require('../models/settings');
const { getToolRegistry } = require('../lib/toolLoader');
const { getPersonalityService } = require('./agentPersonality');
const { getKnowledgeBase } = require('./knowledgeBase');
const { logger } = require('../utils/logger');
const { getFirestore, getFieldValue } = require('../config/firestore');
const { getContextSanitizer } = require('../utils/contextSanitizer');
const { getContextValidator } = require('../utils/contextValidator');
const embeddingService = require('./embeddingService');
const { FieldValue } = require('@google-cloud/firestore');
const { FeatureFlags } = require('../utils/featureFlags');
const prompts = require('../config/prompts');

class GeminiService {
  constructor() {
    this.model = null;
    this.promptsModel = null;
    this.settingsModel = null;
    this.personalityService = null;
    this.knowledgeBase = null;
    this.conversationCache = new Map(); // In-memory conversation cache
    this.maxCacheSize = 500; // Reasonable limit for conversation cache
    this.cacheCleanupInterval = 900000; // 15 minutes
    this.maxEntriesPerCleanup = 50; // Don't remove too many at once
    this.cacheCleanupIntervalId = null; // Store interval ID for cleanup
    this.db = null;

    // Setup cache cleanup
    this.setupCacheCleanup();
  }

  async initialize() {
    this.model = getGeminiModel();
    this.promptsModel = getPromptsModel();
    this.settingsModel = getSettingsModel();
    this.personalityService = getPersonalityService();
    this.knowledgeBase = getKnowledgeBase();
    this.db = getFirestore();
    await this.promptsModel.initialize();
    await this.settingsModel.initialize();
  }

  /**
   * Generate few-shot identity examples with personality interpolation
   * These examples help anchor the AI's identity behavior and prevent generic "I'm an AI" responses
   * @returns {Array} Array of user/model message pairs for conversation history
   */
  getFewShotExamples() {
    const personality = this.personalityService.getPersonality();
    const { identity } = personality;

    // Get few-shot examples from chat prompt
    const chatPrompt = prompts.DEFAULT_PROMPTS.chat;

    if (!chatPrompt.examples || chatPrompt.examples.length === 0) {
      logger.debug('No few-shot examples defined in chat prompt');
      return [];
    }

    // Prepare variables for interpolation
    const variables = {
      identity: {
        name: identity.name,
        role: identity.role,
        organization: identity.organization
      }
    };

    // Convert examples to Gemini conversation format
    const exampleMessages = chatPrompt.examples.flatMap(ex => {
      const userMessage = prompts.interpolate(ex.user, variables);
      const assistantMessage = prompts.interpolate(ex.assistant, variables);

      return [
        { role: 'user', parts: [{ text: userMessage }] },
        { role: 'model', parts: [{ text: assistantMessage }] }
      ];
    });

    logger.info('Few-shot examples generated for identity anchoring', {
      exampleCount: chatPrompt.examples.length,
      messagesGenerated: exampleMessages.length,
      identityName: identity.name,
      identityRole: identity.role
    });

    return exampleMessages;
  }

  async processMessage(messageData, eventData) {
    let stopTyping = null;

    try {
      // Check if agent should respond based on personality and triggers
      const shouldRespond = await this.shouldAgentRespond(messageData.message, messageData.userId, messageData.messageType);
      if (!shouldRespond) {
        logger.debug('Agent not responding based on triggers', { messageId: messageData.messageId });
        return null;
      }

      // Typing indicators only work on Bitrix24 (Google Chat API doesn't support bot typing status)
      const ENABLE_BITRIX24 = process.env.ENABLE_BITRIX24_INTEGRATION === 'true';
      const isBitrix24Message = !messageData.platform || messageData.platform === 'bitrix24';

      if (ENABLE_BITRIX24 && isBitrix24Message) {
        stopTyping = await this.startTypingIndicator(messageData.dialogId);
      }

      // Apply response delay for natural feeling
      const delay = this.personalityService.getResponseDelay();
      await new Promise(resolve => setTimeout(resolve, delay));

      // Get conversation context
      const context = await this.getConversationContext(messageData.dialogId || messageData.chatId);

      // Search knowledge base for relevant information
      const knowledgeResults = await this.knowledgeBase.searchKnowledge(messageData.message, {
        maxResults: 5,
        minRelevance: 0.1
      });

      // Get personality-enhanced system prompt
      logger.info('Requesting personality prompt for message processing');
      const personalityPrompt = this.personalityService.getPersonalityPrompt();
      logger.info('Personality prompt received', {
        length: personalityPrompt.length,
        startsWithName: personalityPrompt.includes('Chantilly')
      });
      const systemPrompt = await this.promptsModel.getPrompt('chat.system');
      const knowledgePrompt = this.knowledgeBase.getRelevantKnowledgePrompt(knowledgeResults);
      const combinedSystemPrompt = `${personalityPrompt}\n\n${systemPrompt}${knowledgePrompt}`;

      // Debug logging
      logger.info('System prompt components', {
        personalityLength: personalityPrompt.length,
        systemLength: systemPrompt.length,
        knowledgeLength: knowledgePrompt.length,
        totalLength: combinedSystemPrompt.length,
        personalityPreview: personalityPrompt.substring(0, 100)
      });

      // Get user adaptations if available
      const userPreferences = await this.personalityService.getUserAdaptedPersonality(messageData.userId);

      // Prepare user prompt
      const userPrompt = await this.promptsModel.getPrompt('chat.user', {
        message: messageData.message
      });

      // SECURITY: Sanitize and validate ALL context BEFORE any AI processing
      // This prevents sensitive data leakage to external AI services (OWASP LLM02:2025)
      const sanitizer = getContextSanitizer();
      const validator = getContextValidator();

      const rawContext = {
        knowledgeResults: knowledgeResults,
        systemPrompt: combinedSystemPrompt,
        messageData: messageData,
        conversationContext: context
      };

      // First sanitize sensitive data (PII, secrets, credentials)
      const sanitizedContext = sanitizer.sanitizeToolContext(rawContext);

      // Then validate and clean structure
      const validation = validator.validateToolContext(sanitizedContext);

      if (!validation.valid) {
        logger.warn('Context validation failed', {
          errors: validation.errors,
          fallbackToSafeContext: true
        });
      }

      logger.info('Context sanitized for security (OWASP LLM02:2025)', {
        hasKnowledgeResults: !!validation.sanitized.knowledgeResults,
        knowledgeResultsCount: validation.sanitized.knowledgeResults?.length || 0,
        validationPassed: validation.valid,
        errorCount: validation.errors.length
      });

      // Use sanitized data for ALL subsequent operations
      const sanitizedSystemPrompt = validation.sanitized.systemPrompt || combinedSystemPrompt;
      const sanitizedMessageData = validation.sanitized.messageData || messageData;
      const sanitizedConversationContext = validation.sanitized.conversationContext || context;
      const sanitizedKnowledgeResults = validation.sanitized.knowledgeResults || knowledgeResults;

      // Get tools available to this user based on their role (RBAC enforcement)
      // This prevents unauthorized users from accessing admin-only tools
      const registry = getToolRegistry();
      const { getUserRoleService } = require('./userRoleService');

      // Determine user role based on RBAC_SYSTEM configuration
      let userRole = 'user'; // Default to least privilege
      const rbacSystem = config.RBAC_SYSTEM || 'bitrix24'; // Default to original behavior
      const isGoogleChat = sanitizedMessageData.platform === 'google-chat';

      logger.info('RBAC system configured', {
        rbacSystem: rbacSystem,
        platform: sanitizedMessageData.platform,
        userId: sanitizedMessageData.userId
      });

      if (rbacSystem === 'bitrix24') {
        // ORIGINAL BEHAVIOR: Always use Bitrix24 RBAC (backward compatible)
        try {
          const userRoleService = getUserRoleService();
          userRole = await userRoleService.getUserRole(sanitizedMessageData.userId);
        } catch (error) {
          logger.error('Failed to fetch Bitrix24 user role, defaulting to user', {
            userId: sanitizedMessageData.userId,
            error: error.message
          });
          // Continue with default 'user' role (fail-safe)
        }
      } else if (rbacSystem === 'google-workspace') {
        // Google Workspace RBAC: Use Google Chat roles for all messages
        userRole = sanitizedMessageData.userRole || 'user';
        logger.info('Using Google Workspace RBAC for all messages', {
          userId: sanitizedMessageData.userId,
          userRole: userRole
        });
      } else if (rbacSystem === 'hybrid') {
        // Hybrid RBAC: Platform-specific role detection
        if (isGoogleChat) {
          // For Google Chat messages, use Google Workspace roles
          userRole = sanitizedMessageData.userRole || 'user';
          logger.info('Using Google Workspace user role (hybrid mode)', {
            userId: sanitizedMessageData.userId,
            userRole: userRole
          });
        } else {
          // For Bitrix24 messages, use Bitrix24 RBAC
          try {
            const userRoleService = getUserRoleService();
            userRole = await userRoleService.getUserRole(sanitizedMessageData.userId);
          } catch (error) {
            logger.error('Failed to fetch Bitrix24 user role, defaulting to user', {
              userId: sanitizedMessageData.userId,
              platform: sanitizedMessageData.platform,
              error: error.message
            });
            // Continue with default 'user' role (fail-safe)
          }
        }
      }

      // Get role-filtered tools (RBAC)
      const availableTools = registry.getToolsForUser(userRole);

      logger.info('Offering role-filtered tools to Gemini for AI-based selection', {
        userId: sanitizedMessageData.userId,
        userRole: userRole,
        toolCount: availableTools.length,
        toolNames: availableTools.map(t => t.name),
        totalEnabled: registry.getEnabledTools().length,
        filteredOut: registry.getEnabledTools().length - availableTools.length
      });

      const suggestedTools = await this.suggestTools(messageData.message, sanitizedConversationContext, sanitizedMessageData, sanitizedKnowledgeResults);

      // Generate response with explicit system instruction
      let response;
      if (availableTools.length > 0) {
        response = await this.executeWithTools(null, userPrompt, availableTools, sanitizedMessageData, sanitizedSystemPrompt, sanitizedConversationContext, validation.sanitized);

        // Check if tools handled messaging themselves (returned null)
        if (response && response.reply === null) {
          logger.info('Tool handled messaging directly - no response to send');
          return null; // No message to send to user
        }
      } else {
        // Use direct generateContent with explicit system instruction
        // SECURITY: Now using sanitized data to prevent PII/credential leakage
        const client = require('../config/gemini').getGeminiClient();

        // Prepare conversation history with sanitized data
        const contents = [];

        // Add few-shot identity examples FIRST (before conversation history)
        // This anchors the AI's identity and prevents generic "I'm an AI" responses
        const fewShotExamples = this.getFewShotExamples();
        if (fewShotExamples.length > 0) {
          contents.push(...fewShotExamples);
          logger.info('Few-shot examples added to conversation', {
            examplesCount: fewShotExamples.length
          });
        }

        // Add sanitized conversation history if available
        if (sanitizedConversationContext.history && sanitizedConversationContext.history.length > 0) {
          // Additional sanitization pass on conversation history
          const sanitizedHistory = sanitizer.sanitizeConversationHistory(sanitizedConversationContext.history);
          contents.push(...sanitizedHistory);
        }

        // Add current user message
        contents.push({
          role: 'user',
          parts: [{ text: userPrompt }]
        });

        logger.info('Sending to Gemini with sanitized data', {
          systemPromptLength: sanitizedSystemPrompt.length,
          historyLength: contents.length,
          hasPersonality: sanitizedSystemPrompt.includes('Chantilly'),
          sanitizationApplied: true
        });

        try {
          const result = await client.models.generateContent({
            model: 'gemini-2.0-flash-exp',
            contents: contents,
            config: {
              systemInstruction: sanitizedSystemPrompt
            }
          });

          logger.info('Gemini response received successfully', {
            hasCandidates: !!result.candidates,
            candidatesLength: result.candidates?.length
          });

          // Use centralized response extraction with detailed logging
          const reply = extractGeminiText(result, {
            includeLogging: true,
            logger: logger.info.bind(logger)
          }) || 'Sorry, I could not generate a response.';

          response = {
            reply: reply,
            toolsUsed: []
          };
        } catch (geminiError) {
          logger.error('Gemini API call failed', {
            error: geminiError.message,
            stack: geminiError.stack
          });

          response = {
            reply: 'I apologize, but I encountered an error processing your message. Please try again.',
            toolsUsed: []
          };
        }
      }

      // Add tool suggestions if configured
      const personality = this.personalityService.getPersonality();
      if (suggestedTools.length > 0 && 
          personality?.tools?.suggest_proactively && 
          response.toolsUsed.length === 0) {
        response.reply = this.addToolSuggestions(response.reply, suggestedTools);
      }

      // Format response with personality
      response.reply = this.personalityService.formatResponse(response.reply, {
        addEmoji: messageData.messageType !== 'P', // Add emoji in group chats
        userId: messageData.userId
      });

      logger.info('Response formatted, preparing to return', {
        replyLength: response.reply.length,
        toolsUsed: response.toolsUsed.length
      });

      // Save conversation context
      await this.saveConversationContext(messageData.dialogId || messageData.chatId, {
        lastMessage: messageData.message,
        lastResponse: response.reply,
        timestamp: new Date()
      });

      logger.info('Response ready to be sent', {
        replyPreview: response.reply.substring(0, 100)
      });

      return response;
    } catch (error) {
      logger.error('Failed to process message with Gemini', {
        error: error.message,
        messageId: messageData.messageId
      });
      throw error;
    } finally {
      // Stop typing indicator regardless of success or failure
      if (stopTyping) {
        stopTyping();
      }
    }
  }

  async executeWithTools(chat, prompt, tools, messageData, systemInstruction, context, toolExecutionContext = {}) {
    // Initialize or increment tool execution depth
    const currentDepth = (toolExecutionContext.executionDepth || 0) + 1;
    const maxDepth = 5; // Maximum tool execution depth to prevent infinite loops
    
    if (currentDepth > maxDepth) {
      logger.error('Tool execution depth limit exceeded', {
        currentDepth,
        maxDepth,
        toolNames: tools.map(t => t.name)
      });
      throw new Error(`Maximum tool execution depth exceeded (${currentDepth} > ${maxDepth}). Possible infinite loop detected.`);
    }
    
    // Add depth tracking to context
    toolExecutionContext.executionDepth = currentDepth;
    
    logger.info('Tool execution started', {
      depth: currentDepth,
      maxDepth,
      toolCount: tools.length,
      toolNames: tools.map(t => t.name)
    });
    try {
      // Get tool registry
      const registry = getToolRegistry();

      // Prepare tool declarations for Gemini 2.5 Pro (2025 format)
      // Support dynamic descriptions for tools that need context-aware descriptions
      const toolDeclarations = await Promise.all(tools.map(async tool => {
        // Check if tool has getDynamicDescription method (for context-aware descriptions)
        let description = tool.description;
        if (typeof tool.getDynamicDescription === 'function') {
          try {
            description = await tool.getDynamicDescription();
          } catch (error) {
            logger.warn('Failed to get dynamic description for tool', {
              toolName: tool.name,
              error: error.message
            });
            // Fall back to static description
          }
        }

        return {
          name: tool.name,
          description,
          parametersJsonSchema: {
            type: 'object',
            properties: tool.parameters?.properties || {},
            required: tool.parameters?.required || []
          }
        };
      }));

      // Get the Gemini client directly (no conflicting tool config)
      const client = getGeminiClient();

      // Prepare contents with history
      const contents = [];

      // Add few-shot identity examples FIRST (before conversation history)
      // This anchors the AI's identity and prevents generic "I'm an AI" responses
      const fewShotExamples = this.getFewShotExamples();
      if (fewShotExamples.length > 0) {
        contents.push(...fewShotExamples);
        logger.info('Few-shot examples added to tool execution conversation', {
          examplesCount: fewShotExamples.length
        });
      }

      if (context && context.history && context.history.length > 0) {
        contents.push(...context.history);
      }
      contents.push({
        role: 'user',
        parts: [{ text: prompt }]
      });

      // Configure request for Gemini 2.5 Pro with tools (2025 format)
      const requestConfig = {
        model: config.GEMINI_MODEL,
        contents: contents,
        config: {
          tools: [{
            functionDeclarations: toolDeclarations
          }],
          toolConfig: {
            functionCallingConfig: {
              mode: 'ANY',
              allowedFunctionNames: toolDeclarations.map(tool => tool.name)
            }
          },
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024
          }
        }
      };

      // Add system instruction if provided
      if (systemInstruction) {
        // Enhance system instruction with tool usage guidance
        const enhancedSystemInstruction = systemInstruction + `

CRITICAL TOOL USAGE RULES:
- NEVER use action="search" when user wants to modify/append/add content to documents
- ALWAYS use action="update" with appendContent parameter for append operations
- For "append X to document Y": IMMEDIATELY call KnowledgeManagement with action="update", title="Y", appendContent="X"
- NEVER search first, then update - do the update directly
- Only use action="search" when user explicitly wants to find/look up information without modifying it

TEMPLATE MODIFICATION RULES (TaskTemplateManager):
- When user requests to modify/change/update a template's execution code/script:
  * NEVER provide the full executionScript directly
  * ALWAYS use templateUpdates.modificationRequest with a clear description of what to change
  * Example: { "action": "modify", "templateId": "template_id", "templateUpdates": { "modificationRequest": "Add invoice card display sorted by date, include last 4 activities from customer/company, make invoice # clickable link" } }
  * The tool will fetch current code and generate intelligent modifications
- For simple metadata updates (name, description, enabled): use direct field updates
- NEVER regenerate entire scripts from scratch - always use modificationRequest for code changes`;

        requestConfig.config.systemInstruction = enhancedSystemInstruction;
      }

      logger.info('Sending request to Gemini 2.5 Pro', {
        hasTools: !!requestConfig.config?.tools,
        toolCount: toolDeclarations.length,
        hasSystemInstruction: !!systemInstruction,
        model: config.GEMINI_MODEL,
        toolDeclarations: JSON.stringify(toolDeclarations, null, 2),
        requestStructure: {
          hasModel: !!requestConfig.model,
          hasContents: !!requestConfig.contents,
          hasConfig: !!requestConfig.config,
          hasTools: !!requestConfig.config?.tools,
          hasToolConfig: !!requestConfig.config?.toolConfig,
          hasFunctionCallingConfig: !!requestConfig.config?.toolConfig?.functionCallingConfig,
          mode: requestConfig.config?.toolConfig?.functionCallingConfig?.mode,
          hasGenerationConfig: !!requestConfig.config?.generationConfig,
          hasSystemInstruction: !!requestConfig.config?.systemInstruction
        }
      });

      const result = await client.models.generateContent(requestConfig);

      // The Gemini API returns the response directly in result, not result.response
      const response = result;

      // Debug the full result structure
      logger.info('Full Gemini result structure', {
        hasResult: !!result,
        hasResponse: !!response,
        resultKeys: result ? Object.keys(result) : 'result is null',
        hasCandidates: !!result?.candidates,
        firstCandidate: result?.candidates?.[0] ? Object.keys(result.candidates[0]) : 'no candidate',
        contentParts: result?.candidates?.[0]?.content?.parts ?
          result.candidates[0].content.parts.map(p => Object.keys(p)) : 'no parts'
      });

      // Handle different response structures for tool calls (2025 standard)
      let toolCalls = [];
      try {
        // PRIMARY: Check candidates[0].content.parts for function_call (correct 2025 structure)
        if (response?.candidates?.[0]?.content?.parts) {
          const parts = response.candidates[0].content.parts;

          logger.info('Examining content parts for function calls', {
            partsCount: parts.length,
            partsStructure: parts.map((part, idx) => ({
              index: idx,
              keys: Object.keys(part),
              hasText: !!part.text,
              hasFunctionCall: !!part.function_call,
              hasFunctionCallCamel: !!part.functionCall
            }))
          });

          for (const part of parts) {
            // Check both function_call (snake_case) and functionCall (camelCase)
            if (part.function_call) {
              toolCalls.push({
                name: part.function_call.name,
                args: part.function_call.args || {}
              });
            } else if (part.functionCall) {  // camelCase format
              toolCalls.push({
                name: part.functionCall.name,
                args: part.functionCall.args || {}
              });
            }
          }
        }
        // FALLBACK 2: Direct functionCalls method (very old structure)
        else if (response.functionCalls && typeof response.functionCalls === 'function') {
          const legacyCalls = response.functionCalls();
          toolCalls = legacyCalls.map(call => ({
            name: call.name,
            args: call.args || {}
          }));
        }
        // FALLBACK 3: Direct functionCalls array
        else if (response.functionCalls && Array.isArray(response.functionCalls)) {
          toolCalls = response.functionCalls.map(call => ({
            name: call.name,
            args: call.args || {}
          }));
        }

        logger.info('Function calls extracted from Gemini response', {
          toolCallsFound: toolCalls.length,
          callNames: toolCalls.map(tc => tc.name),
          responseStructure: {
            hasCandidates: !!response?.candidates,
            hasContentParts: !!response?.candidates?.[0]?.content?.parts,
            partsCount: response?.candidates?.[0]?.content?.parts?.length || 0,
            hasLegacyFunctionCalls: !!response.functionCalls,
            functionCallsType: typeof response.functionCalls
          }
        });
      } catch (error) {
        logger.error('Error extracting tool calls from response', {
          error: error.message,
          responseKeys: response ? Object.keys(response) : 'response is null/undefined',
          responseType: typeof response
        });
        toolCalls = [];
      }

      const toolResults = [];
      const maxToolCalls = 10; // Maximum number of tool calls in single execution

      // Check for too many tool calls (possible infinite loop)
      if (toolCalls.length > maxToolCalls) {
        logger.error('Too many tool calls detected, possible infinite loop', {
          toolCallsCount: toolCalls.length,
          maxToolCalls,
          toolNames: toolCalls.map(tc => tc.name)
        });
        throw new Error(`Too many tool calls (${toolCalls.length} > ${maxToolCalls}). Possible infinite loop detected.`);
      }

      // If no tool calls detected, check if Gemini returned a text response instead
      if (toolCalls.length === 0) {
        // Use centralized response extraction with detailed logging
        const textResponse = extractGeminiText(response, {
          includeLogging: true,
          logger: logger.info.bind(logger)
        });

        logger.warn('No tool calls detected in response despite tools being available', {
          hasText: !!textResponse,
          textPreview: textResponse.substring(0, 100)
        });

        // Return the text response if no tools were called
        if (textResponse) {
          return {
            reply: textResponse,
            toolsUsed: []
          };
        }
      }

      // Execute tool calls
      for (const call of toolCalls) {
        logger.info('Executing tool call', {
          toolName: call.name,
          hasArgs: !!call.args,
          argsKeys: call.args ? Object.keys(call.args) : [],
          toolArgs: JSON.stringify(call.args, null, 2)
        });

        const tool = registry.getTool(call.name);
        if (tool) {
          try {
            // Pass enhanced context to tools
            const enhancedToolContext = {
              ...toolExecutionContext,
              previousToolResults: toolResults,
              currentCall: call
            };
            
            // Execute tool with timeout protection
            const toolTimeout = 720000; // 12 minutes max per tool
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error(`Tool execution timeout after ${toolTimeout}ms`)), toolTimeout);
            });
            
            const result = await Promise.race([
              tool.execute(call.args, enhancedToolContext),
              timeoutPromise
            ]);
            
            toolResults.push({
              name: call.name,
              result
            });
            logger.info('Tool execution successful', {
              toolName: call.name,
              resultType: typeof result,
              hasKnowledgeContext: !!enhancedToolContext.knowledgeResults,
              executionDepth: currentDepth
            });
          } catch (error) {
            logger.error('Tool execution failed', {
              tool: call.name,
              error: error.message,
              stack: error.stack
            });
            toolResults.push({
              name: call.name,
              error: error.message
            });
          }
        } else {
          logger.warn('Tool not found in registry', {
            requestedTool: call.name,
            availableTools: registry.getAllTools().map(t => t.name)
          });
        }
      }

      // Check if any tools returned null (indicating they handled messaging themselves)
      const hasNullResults = toolResults.some(tr => tr.result === null);
      if (hasNullResults) {
        logger.info('Tool returned null - skipping final response generation', {
          toolResultsCount: toolResults.length,
          toolNames: toolResults.map(tr => tr.name)
        });
        return { reply: null }; // Indicate no additional response needed
      }

      // Generate final response with tool results using the same model
      logger.info('Generating final response with tool results', {
        toolResultsCount: toolResults.length,
        toolNames: toolResults.map(tr => tr.name),
        hasResults: toolResults.length > 0
      });

      // Check if this is a photo response that needs special handling
      // We want Gemini to add annotations but preserve the photo URLs
      let isPhotoResponse = false;
      let photoToolResult = null;
      
      for (const toolResult of toolResults) {
        if (typeof toolResult.result === 'string' && 
            (toolResult.result.includes('📸') || toolResult.result.includes('[Photo ')) &&
            toolResult.result.includes('places.googleapis.com')) {
          
          isPhotoResponse = true;
          photoToolResult = toolResult;
          
          logger.info('Detected photo response - will ask Gemini to enhance with annotations', {
            toolName: toolResult.name,
            responseLength: toolResult.result.length,
            hasPhotoUrls: toolResult.result.includes('places.googleapis.com')
          });
          break;
        }
      }

      const finalRequestConfig = {
        model: config.GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [{
              text: prompt
            }]
          },
          {
            role: 'model',
            parts: [{
              text: 'I\'ll help you with that. Let me use the appropriate tools.'
            }]
          },
          {
            role: 'user',
            parts: [{
              text: isPhotoResponse ?
                `I found visitor photos with actual URLs. Here's the formatted response: ${photoToolResult.result}\n\nIMPORTANT: You MUST preserve ALL photo URLs exactly as provided. Add helpful annotations, context about the locations, or interesting details about what visitors might see, but keep every single [Photo X](URL) link intact. DO NOT create generic text - use the actual response with URLs.` :
                `Tool execution results:\n${toolResults.map(tr => {
                  // CRITICAL: Check for errors FIRST and format them explicitly
                  if (tr.error) {
                    return `❌ ERROR - Tool "${tr.name}" FAILED:\n${tr.error}\n\nThe tool did NOT complete successfully. You MUST inform the user that the operation failed with this error message. DO NOT generate fake successful results.`;
                  }
                  // If result is already a formatted string, use it as-is
                  if (typeof tr.result === 'string') {
                    return tr.result;
                  }
                  // If result is an object with a message field, use that for user-friendly display
                  if (tr.result && typeof tr.result === 'object' && tr.result.message) {
                    return tr.result.message;
                  }
                  // If result is an object/array without message field, format it for display
                  return JSON.stringify(tr.result, null, 2);
                }).join('\n\n')}\n\nCRITICAL: If the tool returned structured data (JSON/objects), convert it to user-friendly prose or lists. If the tool returned a formatted text message, present it exactly as written. Do NOT fabricate structured data or additional fields that were not in the actual tool output.`
            }]
          }
        ],
        config: {
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 65536 // Maximum for Gemini 2.5 Pro - allows full transcripts
          }
        }
      };

      if (systemInstruction) {
        finalRequestConfig.config.systemInstruction = systemInstruction;
      }

      logger.info('Sending final request to Gemini for tool response generation');
      const finalResult = await client.models.generateContent(finalRequestConfig);

      // Use centralized response extraction with detailed logging
      const finalText = extractGeminiText(finalResult, {
        includeLogging: true,
        logger: logger.info.bind(logger)
      }) || finalResult?.text?.() || 'Tool execution completed but no response generated.';

      logger.info('Final Gemini response received', {
        hasCandidates: !!finalResult?.candidates,
        candidatesCount: finalResult?.candidates?.length || 0,
        hasText: !!finalText,
        textLength: finalText.length
      });

      logger.info('Final response prepared for user', {
        responseLength: finalText.length,
        toolsUsed: toolResults.map(t => t.name)
      });

      return {
        reply: finalText,
        toolsUsed: toolResults.map(t => t.name)
      };
    } catch (error) {
      logger.error('Failed to execute with tools', error);
      throw error;
    }
  }

  /**
   * DEPRECATED: Regex-based tool detection
   *
   * This method uses regex patterns in shouldTrigger() methods to filter tools.
   * It has been replaced with AI-based detection where Gemini's function calling
   * system decides which tools to use.
   *
   * Kept for backward compatibility and debugging only.
   *
   * @deprecated Use AI-based detection by offering all tools to Gemini
   */
  async checkForTools(message, messageData = {}, knowledgeResults = []) {
    logger.warn('DEPRECATED: checkForTools() uses regex patterns. Consider using AI-based detection instead.');

    // Check message for tool triggers
    const registry = getToolRegistry();
    const tools = registry.getAllTools();
    const matchedTools = [];

    logger.info('Checking tool triggers (DEPRECATED - regex-based)', {
      message: message.substring(0, 100) + '...',
      availableTools: tools.length,
      toolNames: tools.map(t => t.name)
    });

    for (const tool of tools) {
      if (tool.shouldTrigger) {
        const shouldTrigger = await tool.shouldTrigger(message, {
          messageData,
          knowledgeResults
        });
        logger.info('Tool trigger check (regex-based)', {
          toolName: tool.name,
          shouldTrigger: shouldTrigger,
          message: message.substring(0, 50) + '...'
        });
        if (shouldTrigger) {
          matchedTools.push(tool);
        }
      }
    }

    // Sort matched tools by priority (highest first)
    matchedTools.sort((a, b) => (b.priority || 50) - (a.priority || 50));

    logger.info('Tool trigger results (DEPRECATED)', {
      totalTools: tools.length,
      matchedTools: matchedTools.length,
      matchedToolNames: matchedTools.map(t => t.name),
      priorityOrder: matchedTools.map(t => `${t.name}(${t.priority || 50})`)
    });

    return matchedTools;
  }

  /**
   * DEPRECATED: Semantic tool trigger detection using vector embeddings
   *
   * This method combines vector similarity with regex-based shouldTrigger validation.
   * It has been replaced with pure AI-based detection where Gemini's function calling
   * system decides which tools to use from ALL available tools.
   *
   * Kept for backward compatibility and debugging only.
   *
   * @deprecated Use AI-based detection by offering all tools to Gemini
   * @param {string} message - User message to analyze
   * @param {object} messageData - Message metadata
   * @param {array} knowledgeResults - Knowledge base search results
   * @returns {array} Matched tools sorted by priority
   */
  async checkForToolsSemantic(message, messageData = {}, knowledgeResults = []) {
    logger.warn('DEPRECATED: checkForToolsSemantic() still uses regex validation. Use AI-based detection instead.');
    const useSemanticTools = FeatureFlags.shouldUseSemanticTools();

    if (!useSemanticTools) {
      logger.info('Semantic tool detection disabled by feature flag, using keyword matching');
      return await this.checkForTools(message, messageData, knowledgeResults);
    }

    try {
      const startTime = Date.now();

      // Generate query embedding from user message
      logger.info('Generating query embedding for semantic tool detection', {
        messageLength: message.length,
        messagePreview: message.substring(0, 100)
      });

      const queryEmbedding = await embeddingService.embedQuery(
        message,
        'RETRIEVAL_QUERY'
      );

      logger.info('Query embedding generated', {
        embeddingDimensions: queryEmbedding.length,
        duration: `${Date.now() - startTime}ms`
      });

      // Perform vector search on tool embeddings
      const vectorQuery = this.db.collection('tool-embeddings')
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector(queryEmbedding),
          limit: 5, // Get top 5 semantically relevant tools
          distanceMeasure: 'COSINE'
        });

      const snapshot = await vectorQuery.get();

      logger.info('Vector search for tools completed', {
        resultsFound: snapshot.size,
        duration: `${Date.now() - startTime}ms`
      });

      if (snapshot.empty) {
        logger.warn('No semantically relevant tools found, falling back to keyword matching');
        return await this.checkForTools(message, messageData, knowledgeResults);
      }

      // Get tool registry
      const registry = getToolRegistry();
      const matchedTools = [];
      const checkedTools = new Set();

      // Process vector search results
      for (const doc of snapshot.docs) {
        const data = doc.data();
        const toolName = data.toolName;

        // Skip if already checked (prevent duplicates)
        if (checkedTools.has(toolName)) {
          continue;
        }
        checkedTools.add(toolName);

        const tool = registry.getTool(toolName);

        if (!tool) {
          logger.warn('Tool found in embeddings but not in registry', {
            toolName,
            documentId: doc.id
          });
          continue;
        }

        // Hybrid approach: Check both semantic match AND traditional trigger
        let traditionalTrigger = false;
        if (tool.shouldTrigger) {
          try {
            traditionalTrigger = await tool.shouldTrigger(message, {
              messageData,
              knowledgeResults
            });
          } catch (error) {
            logger.error('Error checking traditional trigger for tool', {
              toolName,
              error: error.message
            });
          }
        }

        logger.info('Semantic tool match validation', {
          toolName,
          semanticMatch: true,
          traditionalTrigger,
          willInclude: traditionalTrigger,
          priority: tool.priority || 50
        });

        // Include tool if traditional trigger also matches (hybrid validation)
        if (traditionalTrigger) {
          matchedTools.push(tool);
        }
      }

      // Sort matched tools by priority (highest first)
      matchedTools.sort((a, b) => (b.priority || 50) - (a.priority || 50));

      logger.info('Semantic tool detection completed', {
        vectorResultsCount: snapshot.size,
        matchedToolsCount: matchedTools.length,
        matchedToolNames: matchedTools.map(t => t.name),
        priorityOrder: matchedTools.map(t => `${t.name}(${t.priority || 50})`),
        totalDuration: `${Date.now() - startTime}ms`
      });

      return matchedTools;

    } catch (error) {
      logger.error('Semantic tool detection failed, falling back to keyword matching', {
        error: error.message,
        stack: error.stack
      });
      return await this.checkForTools(message, messageData, knowledgeResults);
    }
  }

  async getConversationContext(conversationId) {
    // Check cache first
    if (this.conversationCache.has(conversationId)) {
      const context = this.conversationCache.get(conversationId);
      // Update last accessed time
      context.lastAccessed = Date.now();
      return context;
    }

    // Load from Firestore
    try {
      const doc = await this.db
        .collection('conversations')
        .doc(String(conversationId))
        .get();

      if (doc.exists) {
        const context = doc.data();
        context.lastAccessed = Date.now();
        this.conversationCache.set(conversationId, context);
        return context;
      }
    } catch (error) {
      logger.error('Failed to load conversation context', {
        conversationId,
        error: error.message
      });
    }

    const newContext = { history: [], lastAccessed: Date.now() };
    return newContext;
  }

  async saveConversationContext(conversationId, update) {
    try {
      const context = await this.getConversationContext(conversationId);

      // Update history (keep last 10 messages)
      if (!context.history) {context.history = [];}
      context.history.push({
        role: 'user',
        parts: [{ text: update.lastMessage }]
      });
      context.history.push({
        role: 'model',
        parts: [{ text: update.lastResponse }]
      });

      // Keep only last 20 messages (10 exchanges)
      if (context.history.length > 20) {
        context.history = context.history.slice(-20);
      }

      // Enforce cache size limit before adding new entry
      if (this.conversationCache.size >= this.maxCacheSize) {
        this.cleanupCache();
      }
      
      // Update cache with last accessed timestamp
      context.lastAccessed = Date.now();
      context.messageCount = (context.messageCount || 0) + 1;
      this.conversationCache.set(conversationId, context);

      // Save to Firestore
      await this.db
        .collection('conversations')
        .doc(String(conversationId))
        .set({
          ...context,
          lastActive: getFieldValue().serverTimestamp(),
          messageCount: (context.messageCount || 0) + 1
        }, { merge: true });
    } catch (error) {
      logger.error('Failed to save conversation context', {
        conversationId,
        error: error.message
      });
    }
  }

  async analyzeConversation(conversationId, analysisType = 'summary') {
    try {
      const context = await this.getConversationContext(conversationId);

      if (!context.history || context.history.length === 0) {
        return { analysis: 'No conversation history available' };
      }

      const prompt = await this.promptsModel.getPrompt('analysis', {
        conversationHistory: JSON.stringify(context.history),
        analysisType
      });

      const result = await this.model.generateContent(prompt);

      return {
        analysis: result.response.text(),
        type: analysisType
      };
    } catch (error) {
      logger.error('Failed to analyze conversation', {
        conversationId,
        error: error.message
      });
      throw error;
    }
  }

  setupCacheCleanup() {
    // Periodic cleanup to prevent memory leaks
    // Store interval ID to allow proper cleanup
    this.cacheCleanupIntervalId = setInterval(() => {
      this.cleanupCache();
    }, this.cacheCleanupInterval);
  }

  /**
   * Cleanup method to stop background intervals and prevent memory leaks
   * Should be called when shutting down the service or in tests
   */
  destroy() {
    if (this.cacheCleanupIntervalId) {
      clearInterval(this.cacheCleanupIntervalId);
      this.cacheCleanupIntervalId = null;
      logger.info('GeminiService cleanup intervals stopped');
    }
    this.conversationCache.clear();
  }

  cleanupCache() {
    const currentSize = this.conversationCache.size;
    const cleanupThreshold = Math.floor(this.maxCacheSize * 0.8); // Start cleanup at 80%

    if (currentSize <= cleanupThreshold) {
      return; // No cleanup needed
    }

    logger.info('Starting conversation cache cleanup', {
      currentSize,
      threshold: cleanupThreshold,
      maxSize: this.maxCacheSize
    });

    const entries = Array.from(this.conversationCache.entries());
    const now = Date.now();
    
    // Calculate scores for each entry (lower score = higher priority for removal)
    const scoredEntries = entries.map(([key, value]) => {
      let score = 0;
      
      // Age factor (older = lower score)
      const lastAccess = value.lastAccessed || value.timestamp || 0;
      const ageHours = (now - lastAccess) / (1000 * 60 * 60);
      score -= ageHours * 10; // -10 points per hour
      
      // Activity factor (more messages = higher score)
      const messageCount = value.messageCount || 0;
      score += messageCount * 5; // +5 points per message
      
      // Recent activity bonus
      if (ageHours < 1) {score += 100;} // Recent activity bonus
      
      return { key, value, score, ageHours };
    });

    // Sort by score (lowest first - these will be removed)
    scoredEntries.sort((a, b) => a.score - b.score);

    // Remove oldest/least active entries
    const targetSize = Math.floor(this.maxCacheSize * 0.6); // Clean to 60%
    const toRemove = Math.min(
      scoredEntries.length - targetSize,
      this.maxEntriesPerCleanup
    );

    let removed = 0;
    for (let i = 0; i < toRemove && i < scoredEntries.length; i++) {
      const entry = scoredEntries[i];
      
      // Don't remove very recent entries (< 5 minutes) unless absolutely necessary
      if (entry.ageHours < 0.083 && currentSize < this.maxCacheSize * 1.1) {
        continue;
      }
      
      this.conversationCache.delete(entry.key);
      removed++;
    }

    // Force cleanup if we're still over limit
    if (this.conversationCache.size > this.maxCacheSize) {
      const forceRemoveCount = this.conversationCache.size - this.maxCacheSize;
      const remainingEntries = scoredEntries.slice(removed);
      
      for (let i = 0; i < forceRemoveCount && i < remainingEntries.length; i++) {
        this.conversationCache.delete(remainingEntries[i].key);
        removed++;
      }
    }

    logger.info('Cache cleanup completed', {
      initialSize: currentSize,
      removed: removed,
      finalSize: this.conversationCache.size,
      maxSize: this.maxCacheSize,
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024 // MB
    });
  }

  clearConversationCache(conversationId = null) {
    if (conversationId) {
      this.conversationCache.delete(conversationId);
    } else {
      this.conversationCache.clear();
    }
    logger.info('Conversation cache cleared', { conversationId });
  }

  async shouldAgentRespond(message, userId, messageType) {
    // Check personality configuration
    const personality = this.personalityService.getPersonality();

    logger.info('Checking if agent should respond', {
      messagePreview: message.substring(0, 50),
      userId,
      messageType,
      alwaysRespond: personality?.responses?.always_respond,
      hasPersonality: !!personality
    });

    // If always respond is enabled, return true
    if (personality?.responses?.always_respond) {
      logger.info('Always respond is enabled, will respond');
      return true;
    }

    // Check triggers from database
    try {
      const doc = await this.db.collection('agent').doc('triggers').get();
      if (doc.exists) {
        const { triggers = [], enabled = true } = doc.data();

        if (!enabled) {
          logger.info('Triggers disabled, not responding');
          return false;
        }

        const lowerMessage = message.toLowerCase();
        const triggered = triggers.some(trigger => lowerMessage.includes(trigger.toLowerCase()));

        logger.info('Trigger check result', {
          triggers,
          triggered,
          messagePreview: lowerMessage.substring(0, 50)
        });

        return triggered;
      }
    } catch (error) {
      logger.error('Failed to check triggers', error);
    }

    logger.info('No triggers configured, not responding');
    return false;
  }

  async suggestTools(message, context, messageData = {}, knowledgeResults = []) {
    const suggestions = [];
    const registry = getToolRegistry();
    const tools = registry.getEnabledTools();

    // Analyze message for tool relevance
    const lowerMessage = message.toLowerCase();

    for (const tool of tools) {
      // Check if tool has shouldTrigger method
      if (tool.shouldTrigger && await tool.shouldTrigger(message, { messageData, knowledgeResults })) {
        suggestions.push({
          name: tool.name,
          description: tool.userDescription || tool.description,
          confidence: 'high'
        });
      } else if (tool.shouldSuggest && tool.shouldSuggest(message, context)) {
        // Check if tool has shouldSuggest method for proactive suggestions
        suggestions.push({
          name: tool.name,
          description: tool.userDescription || tool.description,
          confidence: 'high'
        });
      } else {
        // Basic keyword matching
        const keywords = this.getToolKeywords(tool.name);
        const matches = keywords.some(keyword => lowerMessage.includes(keyword));

        if (matches) {
          suggestions.push({
            name: tool.name,
            description: tool.userDescription || tool.description,
            confidence: 'medium'
          });
        }
      }
    }

    // Sort by confidence
    suggestions.sort((a, b) => {
      const confidence = { high: 3, medium: 2, low: 1 };
      return confidence[b.confidence] - confidence[a.confidence];
    });

    // Return top 3 suggestions
    return suggestions.slice(0, 3);
  }

  getToolKeywords(toolName) {
    const keywordMap = {
      weather: ['weather', 'temperature', 'forecast', 'climate', 'rain', 'sunny'],
      KnowledgeManagement: ['knowledge', 'document', 'search', 'find', 'add', 'update', 'information', 'save', 'remember'],
      WebSearch: ['web', 'search', 'online', 'internet', 'current', 'latest', 'recent', 'today', 'news', 'lookup', 'duckduckgo', 'google'],
      reminder: ['remind', 'task', 'todo', 'deadline', 'schedule', 'appointment'],
      translation: ['translate', 'language', 'spanish', 'french', 'english'],
      calculator: ['calculate', 'math', 'sum', 'average', 'percentage']
    };

    return keywordMap[toolName.toLowerCase()] || [];
  }

  addToolSuggestions(response, suggestions) {
    if (suggestions.length === 0) {return response;}

    const personality = this.personalityService.getPersonality();
    let suggestionText = '\n\n';

    if (personality?.traits?.communication?.formality === 'casual') {
      suggestionText += '💡 By the way, I can help you with:\n';
    } else {
      suggestionText += 'I can assist you with the following:\n';
    }

    suggestions.forEach(tool => {
      // Use userDescription if available, otherwise clean up description
      const cleanDescription = tool.userDescription || 
        tool.description.split('EXAMPLES:')[0].trim() ||
        tool.description.split('.')[0];
      suggestionText += `• **${tool.name}**: ${cleanDescription}\n`;
    });

    if (personality?.traits?.interaction?.engagement === 'engaging') {
      suggestionText += '\nJust let me know if you\'d like to use any of these!';
    }

    return response + suggestionText;
  }

  /**
   * Start persistent typing indicator for the chat
   * @param {string} dialogId - Chat/dialog ID
   * @returns {function} - Stop function to clear the interval
   */
  async startTypingIndicator(dialogId) {
    if (!dialogId) {
      logger.warn('No dialogId provided for typing indicator');
      return () => {}; // Return empty stop function
    }

    logger.info('Starting persistent typing indicator', { dialogId });

    const queue = require('./bitrix24-queue').getBitrix24QueueManager();
    let typingInterval = null;

    // Send initial typing indicator
    try {
      await queue.add({
        method: 'imbot.chat.sendTyping',
        params: {
          DIALOG_ID: dialogId
        }
      });
    } catch (error) {
      logger.warn('Failed to send initial typing indicator', { error: error.message, dialogId });
    }

    // Set up periodic typing indicator (every 4 seconds)
    typingInterval = setInterval(async () => {
      try {
        await queue.add({
          method: 'imbot.chat.sendTyping',
          params: {
            DIALOG_ID: dialogId
          }
        });
        logger.debug('Typing indicator sent', { dialogId });
      } catch (error) {
        logger.warn('Failed to send periodic typing indicator', { error: error.message, dialogId });
      }
    }, 4000);

    // Return stop function
    return () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        logger.info('Stopped typing indicator', { dialogId });
      }
    };
  }
}

// Singleton instance
let geminiService;

async function initializeGeminiService() {
  if (!geminiService) {
    geminiService = new GeminiService();
    await geminiService.initialize();
  }
  return geminiService;
}

function getGeminiService() {
  if (!geminiService) {
    throw new Error('Gemini service not initialized');
  }
  return geminiService;
}

// Exported wrapper function for webhook handler
async function processMessage(messageData, eventData) {
  const service = await initializeGeminiService();
  return service.processMessage(messageData, eventData);
}

module.exports = {
  GeminiService,
  initializeGeminiService,
  getGeminiService,
  processMessage
};