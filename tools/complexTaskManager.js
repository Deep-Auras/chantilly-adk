const BaseTool = require('../lib/baseTool');
const { getTaskOrchestrator } = require('../services/taskOrchestrator');
const { getTaskQueueModel } = require('../models/taskQueue');
const { getTaskTemplatesModel } = require('../models/taskTemplates');
const { getTaskTemplateLoader } = require('../services/taskTemplateLoader');
const { logger } = require('../utils/logger');
const { GoogleGenAI } = require('@google/genai');
const { extractGeminiText, getGeminiModelName } = require('../config/gemini');
const config = require('../config/env');
const embeddingService = require('../services/embeddingService');
const { FieldValue } = require('@google-cloud/firestore');
const { FeatureFlags } = require('../utils/featureFlags');
const { PromptSanitizer } = require('../utils/promptSanitizer');

/**
 * ComplexTaskManagerTool - Manages complex multi-step tasks
 * 
 * This tool integrates with the Chantilly tool system to provide natural language
 * task creation and management for complex operations that require:
 * - Multiple sequential steps
 * - Long execution times (>30 seconds)
 * - Progress tracking and checkpoints
 * - Worker process execution
 * - Resource monitoring
 */
class ComplexTaskManagerTool extends BaseTool {
  constructor(context) {
    super(context);

    this.name = 'ComplexTaskManager';
    this.description = 'Create and manage complex INTERNAL multi-step tasks that require long execution times, progress tracking, and worker processes. Use for operations like financial reports, bulk data processing, comprehensive analysis, or multi-step workflows that execute CODE. CRITICAL: When user requests ANY kind of report, invoice report, or data analysis, you MUST ALWAYS use action="create" with auto-detection. DO NOT use for: (1) ANY Asana, Bitrix24, or external platform task operations - those have dedicated tools, (2) Template management - use TaskTemplateManager tool, (3) Simple searches or single tool operations. This tool is ONLY for executing multi-step JavaScript code that generates reports or processes data internally.';
    this.userDescription = 'Manage complex multi-step tasks and workflows';
    this.category = 'productivity';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent System';
    this.priority = 80; // High priority for complex task creation, above SimpleTaskCreator (75) and TaskTemplateManager (60)

    // Define parameters for the tool
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'status', 'cancel', 'cancel_all', 'list', 'test', 'modify', 'repair_status'],
          description: 'Action to perform: "create" (REQUIRED for ALL report/analysis requests - agentically generates new tasks), "status" (check existing task), "cancel" (stop single task), "cancel_all" (stop all running/pending tasks), "list" (show user tasks), "test" (debug and iterate executionScript with user feedback), "modify" (update existing RUNNING task instance), "repair_status" (check auto-repair status for tasks). NOTE: For template management (modify/view/delete templates), use TaskTemplateManager tool instead.',
          default: 'create'
        },
        templateId: {
          type: 'string',
          description: 'Template ID for task creation (e.g., "financial_report_quarterly", "client_analysis_comprehensive")'
        },
        taskId: {
          type: 'string',
          description: 'Task identifier for status/cancel operations'
        },
        description: {
          type: 'string',
          description: 'REQUIRED for action="create": Pass the FULL user message here for parameter extraction. Do NOT extract parameters manually. Examples: "Generate invoice report for Q4 2024" or "Purge messages: 123, 456, 789". The system will auto-extract parameters from this description.'
        },
        parameters: {
          type: 'object',
          description: 'OPTIONAL: Only provide if you have already extracted parameters in the correct format matching the template schema. If unsure, leave this empty and provide description instead - the system will extract parameters automatically.',
          additionalProperties: true
        },
        priority: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Task priority (1-100, default: 50)'
        },
        autoDetect: {
          type: 'boolean',
          description: 'Auto-detect template from description (default: true)'
        },
        userIntent: {
          type: 'string',
          enum: ['CREATE_NEW_TASK', 'REUSE_EXISTING_TEMPLATE'],
          description: 'CRITICAL: Semantic intent detection. Use CREATE_NEW_TASK when user is DEFINING what they want by explaining objectives, requirements, steps, or implementation details (e.g., "report that does X, should analyze Y, using steps 1-2-3"). This indicates they are SPECIFYING a new template to be built. Use REUSE_EXISTING_TEMPLATE when user is REFERENCING a name without explaining what it does, assuming it already exists (e.g., just mentioning "X Report" without describing its purpose or steps). Key concept: Are they TEACHING you what to build (CREATE) or ASSUMING you already know it (REUSE)?',
          default: 'CREATE_NEW_TASK'
        },
        entityScope: {
          type: 'string',
          enum: ['AGGREGATE', 'SPECIFIC_ENTITY', 'AUTO'],
          description: 'CRITICAL: Entity scope detection. Use AGGREGATE when user says "all customers", "all invoices", "every contact", or wants analysis of multiple entities. Use SPECIFIC_ENTITY when user references a specific ID like "customer #123" or "this contact". Use AUTO to let system decide based on template requirements.',
          default: 'AUTO'
        },
        modificationType: {
          type: 'string',
          enum: ['MINOR_TWEAK', 'MAJOR_OVERHAUL', 'BUG_FIX', 'COMPLETE_RESTART', 'DIFFERENT_TEMPLATE'],
          description: 'For modify action: Type of modification. MINOR_TWEAK = small changes/adjustments. MAJOR_OVERHAUL = completely redo/redesign/different approach. BUG_FIX = fix error/problem. COMPLETE_RESTART = start over from scratch. DIFFERENT_TEMPLATE = use different template entirely.',
          default: 'MINOR_TWEAK'
        },
        modificationScope: {
          type: 'string',
          enum: ['PARAMETERS', 'OUTPUT_FORMAT', 'LOGIC', 'DATA_SOURCE', 'MULTIPLE'],
          description: 'For modify action: Scope of modification. PARAMETERS = change parameter values. OUTPUT_FORMAT = different output/report format. LOGIC = change algorithm/calculation/process. DATA_SOURCE = use different data/API. MULTIPLE = multiple areas.',
          default: 'PARAMETERS'
        },
        debugLevel: {
          type: 'string',
          enum: ['basic', 'verbose', 'detailed'],
          description: 'Debug level for test action (default: verbose)',
          default: 'verbose'
        },
        dryRun: {
          type: 'boolean',
          description: 'For test action: simulate execution without making actual API calls',
          default: true
        },
        sampleSize: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'For test action: limit data processing to sample size for faster testing',
          default: 10
        },
        agenticGeneration: {
          type: 'boolean',
          description: 'Enable agentic task generation using knowledge base and AI (default: true for create action)',
          default: true
        }
      },
      required: ['action']
    };

    // Initialize services
    this.orchestrator = null;
    this.taskQueueModel = null;
    this.templatesModel = null;
    this.templateLoader = getTaskTemplateLoader();
    this.genAI = new GoogleGenAI({
      apiKey: config.GEMINI_API_KEY,
      requestOptions: {
        timeout: 900000 // 15 minutes for complex agentic template generation
      }
    });
    this.sanitizer = new PromptSanitizer(); // Security: Sanitize user input before using in prompts
    this.initialized = false;
  }

  /**
   * Initialize the tool with required services
   */
  async initialize() {
    if (this.initialized) {return;}

    try {
      this.orchestrator = getTaskOrchestrator();
      this.taskQueueModel = getTaskQueueModel();
      this.templatesModel = getTaskTemplatesModel();
      
      // Initialize orchestrator if not already initialized
      if (!this.orchestrator.getStatus().initialized) {
        await this.orchestrator.initialize();
      }

      this.initialized = true;
      this.log('info', 'ComplexTaskManager tool initialized');
    } catch (error) {
      this.log('error', 'Failed to initialize ComplexTaskManager tool', { error: error.message });
      throw error;
    }
  }

  /**
   * Find best matching template using vector similarity
   * This replaces keyword-based template detection
   */
  async findBestTemplate(description, userId) {
    const useSemanticTemplates = FeatureFlags.shouldUseSemanticTemplates();

    if (!useSemanticTemplates) {
      this.log('info', 'Semantic template matching disabled by feature flag, using keyword matching');
      return await this.findTemplateByKeywords(description);
    }

    try {
      const startTime = Date.now();

      // Generate query embedding from user description
      const queryEmbedding = await embeddingService.embedQuery(
        description,
        'RETRIEVAL_QUERY'
      );

      this.log('info', 'Finding best template match via semantic search', {
        description: description.substring(0, 100),
        userId
      });

      // Get Firestore instance from context
      const db = this.firestore;
      if (!db) {
        throw new Error('Firestore not available');
      }

      // PHASE 1: Try name-only embedding search first (better for short exact queries)
      const nameVectorQuery = db.collection('task-templates')
        .where('enabled', '==', true)
        .findNearest({
          vectorField: 'nameEmbedding',
          queryVector: FieldValue.vector(queryEmbedding),
          limit: 5,
          distanceMeasure: 'COSINE',
          distanceResultField: 'nameDistance'
        });

      const nameSnapshot = await nameVectorQuery.get();
      let bestNameMatch = null;
      let bestNameScore = 0;

      if (!nameSnapshot.empty) {
        bestNameMatch = nameSnapshot.docs[0];
        const nameDistance = bestNameMatch.data().nameDistance;
        if (nameDistance !== undefined && nameDistance !== null) {
          bestNameScore = 1 - nameDistance;
          this.log('info', 'Name embedding search result', {
            templateId: bestNameMatch.id,
            templateName: bestNameMatch.data().name,
            nameScore: (bestNameScore * 100).toFixed(1) + '%'
          });
        }
      }

      // PHASE 2: Full-text embedding search (better for descriptive queries)
      const vectorQuery = db.collection('task-templates')
        .where('enabled', '==', true)
        .findNearest({
          vectorField: 'embedding',
          queryVector: FieldValue.vector(queryEmbedding),
          limit: 5,
          distanceMeasure: 'COSINE',
          distanceResultField: 'distance'
        });

      const snapshot = await vectorQuery.get();

      if (snapshot.empty && nameSnapshot.empty) {
        this.log('warn', 'No templates found via vector search');
        return null;
      }

      // PHASE 3: Choose best match between name and full-text search
      let bestMatch, distance;

      if (bestNameScore > 0.85) {
        // High name similarity (>85%) - use name match
        bestMatch = bestNameMatch;
        distance = bestNameMatch.data().nameDistance;
        this.log('info', 'Using name embedding match (high similarity)', {
          templateId: bestMatch.id,
          templateName: bestMatch.data().name,
          nameScore: (bestNameScore * 100).toFixed(1) + '%',
          method: 'name_embedding'
        });
      } else if (!snapshot.empty) {
        // Use full-text search result
        bestMatch = snapshot.docs[0];
        distance = bestMatch.data().distance;
        const fullScore = distance !== undefined ? 1 - distance : 0;
        this.log('info', 'Using full embedding match', {
          templateId: bestMatch.id,
          templateName: bestMatch.data().name,
          fullScore: (fullScore * 100).toFixed(1) + '%',
          nameScore: (bestNameScore * 100).toFixed(1) + '%',
          method: 'full_embedding'
        });
      } else {
        // Only name results available but low similarity
        bestMatch = bestNameMatch;
        distance = bestNameMatch.data().nameDistance;
      }

      const data = bestMatch.data();

      // Validate that distance was returned
      if (distance === undefined || distance === null) {
        this.log('error', 'Vector search returned undefined distance - distanceResultField not working', {
          templateId: bestMatch.id,
          templateName: data.name,
          hasEmbedding: !!data.embedding,
          embeddingDimensions: data.embeddingDimensions,
          dataKeys: Object.keys(data)
        });
        // Reject all matches if distance is broken - force agentic generation
        return null;
      }

      // Convert distance to similarity score (1 - distance for COSINE)
      const similarityScore = 1 - distance;

      // CRITICAL: Only use existing template if similarity is above threshold
      // If similarity is too low, return null to trigger agentic generation
      const SIMILARITY_THRESHOLD = 0.70; // 70% minimum similarity required

      if (similarityScore < SIMILARITY_THRESHOLD) {
        this.log('info', 'Best template match below similarity threshold, will create new template', {
          templateId: bestMatch.id,
          templateName: data.name,
          similarityScore: (similarityScore * 100).toFixed(1) + '%',
          threshold: (SIMILARITY_THRESHOLD * 100) + '%',
          recommendation: 'create_new_template'
        });
        return null; // Return null to trigger agentic generation
      }

      // CRITICAL: Enhanced similarity check - validate parameter compatibility
      // Even with high similarity, reject if template requires specific entity ID but user wants aggregate analysis

      // First, check if user wants aggregate analysis regardless of template schema
      // This works even if template schema is corrupted
      const isAggregateRequest = /\b(all|every|each)\s+(\w+\s+){0,5}(customer|contact|company|invoice|client|deal|lead)/i.test(description) ||
                                /customers|contacts|companies|invoices|clients|deals|leads/i.test(description) ||
                                /aggregate|total|summary|list\s+of/i.test(description);

      const isSpecificEntity = /customer\s*#?\d+|contact\s*#?\d+|company\s*#?\d+|deal\s*#?\d+|lead\s*#?\d+/i.test(description) ||
                              /specific\s+(customer|contact|company|deal|lead)/i.test(description) ||
                              /this\s+(customer|contact|company|deal|lead)/i.test(description);

      // Check schema if available, OR check template name for entity ID indicators
      let requiresEntityId = false;
      let requiredParams = [];

      if (data.definition?.parameterSchema?.required) {
        requiredParams = data.definition.parameterSchema.required;
        requiresEntityId = requiredParams.includes('customerId') ||
                          requiredParams.includes('contactId') ||
                          requiredParams.includes('companyId') ||
                          requiredParams.includes('dealId') ||
                          requiredParams.includes('leadId');
      } else {
        // FALLBACK: Schema corrupted - check template name for single-entity indicators
        const templateName = data.name || '';
        requiresEntityId = /single\s+customer|specific\s+customer|one\s+customer|\(single/i.test(templateName);

        this.log('warn', 'Template schema missing or corrupted, using name-based entity detection', {
          templateId: bestMatch.id,
          templateName: data.name,
          requiresEntityId: requiresEntityId,
          hasDefinition: !!data.definition,
          hasParameterSchema: !!data.definition?.parameterSchema,
          hasRequired: !!data.definition?.parameterSchema?.required
        });
      }

      if (requiresEntityId && isAggregateRequest && !isSpecificEntity) {
        this.log('info', 'Template requires entity ID but user wants aggregate analysis, rejecting template', {
          templateId: bestMatch.id,
          templateName: data.name,
          similarityScore: (similarityScore * 100).toFixed(1) + '%',
          requiredParams: requiredParams.length > 0 ? requiredParams : 'detected from template name',
          userRequestType: 'aggregate',
          templateType: 'single_entity',
          aggregateIndicators: description.match(/\b(all|every|each|customers|contacts|companies|invoices|aggregate|total|summary)\b/gi),
          recommendation: 'create_aggregate_template',
          schemaCorrupted: requiredParams.length === 0
        });
        return null; // Trigger agentic generation of aggregate template
      }

      const duration = Date.now() - startTime;

      this.log('info', 'Found best template match above threshold', {
        templateId: bestMatch.id,
        templateName: data.name,
        similarityScore: (similarityScore * 100).toFixed(1) + '%',
        confidence: 'high',
        duration: `${duration}ms`
      });

      return {
        templateId: bestMatch.id,
        similarityScore: similarityScore,
        ...data
      };

    } catch (error) {
      this.log('error', 'Template vector search failed, falling back to keywords', error);
      return await this.findTemplateByKeywords(description);
    }
  }

  /**
   * Fallback keyword-based template matching
   * Keep for backward compatibility and hybrid approach
   */
  async findTemplateByKeywords(description) {
    // Use existing templateLoader method
    return await this.templateLoader.findTemplateByTrigger(description, {});
  }

  /**
   * Determine if this tool should trigger for the given message
   * @param {string} message - User message
   * @param {Object} messageData - Message context
   * @returns {boolean} - Whether tool should trigger
   */
  shouldTrigger(message, messageData) {
    if (!message || typeof message !== 'string') {return false;}

    const complexTaskPatterns = [
      // Explicit task management
      /create\s+task/i,
      /start\s+task/i,
      /task\s+status/i,
      /cancel\s+task/i,
      /cancel\s+all\s+tasks?/i,
      /stop\s+all\s+tasks?/i,
      /kill\s+all\s+tasks?/i,
      /abort\s+all\s+tasks?/i,
      /list\s+tasks/i,
      // Confirmation patterns for suggested templates
      /^yes$/i,
      /^yes\s*$/i,
      /^y$/i,
      /^ok$/i,
      /^okay$/i,
      /^sure$/i,
      /^go\s+ahead$/i,
      /^do\s+it$/i,
      /^proceed$/i,
      /^continue$/i,
      /^start$/i,
      /^run\s+it$/i,
      /^execute$/i,
      /^let['']?s\s+do\s+it$/i,
      /^sounds?\s+good$/i,
      /^that.*sounds?\s+good$/i,
      /^perfect$/i,
      /^exactly$/i,
      /^correct$/i,
      /^use.*that.*template$/i,
      /^use.*that.*one$/i,
      
      // Complex operations that need tasks
      /generate.*report/i,
      /create.*report/i,
      /create.*new.*report/i,
      /new.*report/i,
      /make.*report/i,
      /build.*report/i,
      /generate.*analysis/i,
      /create.*analysis/i,
      /generate.*analyze/i,
      /generate.*invoice/i,
      /generate.*products/i,
      /generate.*rank/i,
      /invoice.*analysis/i,
      /invoice.*line.*items/i,
      /rank.*products/i,
      /analyze.*invoice/i,
      /product.*sales.*analysis/i,
      /sales.*analysis/i,
      /comprehensive.*analysis/i,
      /bulk.*process/i,
      /quarterly.*review/i,
      /annual.*summary/i,
      /export.*all/i,
      /process.*batch/i,
      /analyze.*portfolio/i,
      /create.*dashboard/i,
      /migrate.*data/i,
      /sync.*with/i,

      // News feed and blog post patterns
      /news\s+feed/i,
      /feed\s+post/i,
      /blog\s+post/i,
      /create.*post/i,
      /make.*post/i,
      /new.*post/i,
      /celebration\s+post/i,
      /announcement\s+post/i,
      /company.*news/i,
      /publish.*news/i,
      /share.*news/i,
      
      // Proceed patterns for confirmations
      /proceed.*with.*generate/i,
      /proceed.*with.*analysis/i,
      /proceed.*with.*report/i,
      
      // Multi-step indicators
      /step.*by.*step/i,
      /workflow/i,
      /pipeline/i,
      /automation/i,
      /background.*task/i,
      /long.*running/i,
      /progress.*tracking/i,
      
      // Time indicators suggesting complex operations
      /over.*the.*next/i,
      /for.*the.*past/i,
      /monthly.*for/i,
      /daily.*for/i,
      /historical.*data/i
    ];

    // Check for complexity indicators
    const hasComplexityIndicators = complexTaskPatterns.some(pattern => pattern.test(message));
    
    // Check for exclusions (simple operations)
    const simpleOperationPatterns = [
      /^what.*is/i,
      /^who.*is/i,
      /^when.*is/i,
      /^where.*is/i,
      /^how.*to/i,
      /^search.*for/i,
      /^find.*the/i,
      /^translate/i,
      /^weather/i,
      /^current/i,
      /^latest/i
    ];

    const isSimpleOperation = simpleOperationPatterns.some(pattern => pattern.test(message));

    // Find which patterns matched for debugging
    const matchedPatterns = complexTaskPatterns.filter(pattern => pattern.test(message));
    
    this.log('info', 'ComplexTaskManager trigger evaluation', {
      message: message.substring(0, 100),
      hasComplexityIndicators,
      isSimpleOperation,
      matchedPatterns: matchedPatterns.map(p => p.toString()),
      shouldTrigger: hasComplexityIndicators && !isSimpleOperation
    });

    return hasComplexityIndicators && !isSimpleOperation;
  }

  /**
   * Execute the tool with given parameters
   * @param {Object} args - Tool arguments
   * @param {Object} toolContext - Tool execution context
   * @returns {Object} - Execution result
   */
  async execute(args, toolContext) {
    try {
      await this.initialize();

      let { action } = args;
      const userId = toolContext?.messageData?.userId || 'unknown';
      const userMessage = toolContext?.messageData?.message || '';
      
      // Check if this is a confirmation message without explicit action
      if (!action && this.isConfirmationMessage(userMessage)) {
        // Extract context from conversation history to determine what's being confirmed
        const confirmationContext = await this.extractConfirmationContext(toolContext);
        if (confirmationContext?.templateId || confirmationContext?.taskType) {
          this.log('info', 'Detected confirmation for template suggestion', {
            userMessage,
            templateId: confirmationContext.templateId,
            taskType: confirmationContext.taskType
          });
          
          // Set action to create with confirmation context
          action = 'create';
          args = { 
            ...args, 
            action: 'create',
            templateId: confirmationContext.templateId,
            description: confirmationContext.description || userMessage,
            confirmed: true
          };
        }
      }
      
      // Auto-correct common AI mistakes: if user wants a report but AI chose "templates", fix it
      const isReportRequest = /generate.*report|report.*of|create.*report|invoice.*report|analysis|comprehensive/i.test(userMessage);

      if (action === 'templates' && isReportRequest) {
        this.log('warn', 'AI incorrectly chose templates action for report request, auto-correcting to create', {
          originalAction: action,
          userMessage: userMessage.substring(0, 100),
          correctedAction: 'create'
        });
        action = 'create';
        args = { ...args, action: 'create', autoDetect: true, description: userMessage };
      }

      // Auto-correct: if user wants to cancel all tasks but AI chose "cancel", fix it
      const isCancelAllRequest = /cancel\s+all|stop\s+all|kill\s+all|abort\s+all/i.test(userMessage);

      if (action === 'cancel' && isCancelAllRequest && !args.taskId) {
        this.log('info', 'Auto-correcting cancel to cancel_all based on user message', {
          originalAction: action,
          userMessage: userMessage.substring(0, 100),
          correctedAction: 'cancel_all'
        });
        action = 'cancel_all';
        args = { ...args, action: 'cancel_all' };
      }

      this.log('info', 'ComplexTaskManager executing', { action, userId });

      switch (action) {
      case 'create':
        return await this.createTask(args, userId, toolContext);
        
      case 'status':
        return await this.getTaskStatus(args, userId);
        
      case 'cancel':
        return await this.cancelTask(args, userId);

      case 'cancel_all':
        return await this.cancelAllTasks(args, userId);

      case 'list':
        return await this.listUserTasks(args, userId);

      case 'test':
        return await this.testTask(args, userId, toolContext);
        
      case 'modify':
        return await this.modifyTask(args, userId, toolContext);

      case 'repair_status':
        return await this.getAutoRepairStatus(args, userId);
        
      default:
        throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.log('error', 'ComplexTaskManager execution failed', {
        action: args.action,
        error: error.message,
        stack: error.stack
      });

      // Re-throw error so Gemini reports failure accurately to user
      // (returning success:false objects causes Gemini to generate false-positive responses)
      throw new Error(`Task management failed: ${error.message}`);
    }
  }

  /**
   * Extract PII locally using regex patterns (no API calls, zero PII exposure)
   * @param {string} text - Input text
   * @returns {Object} - Extracted PII data with tokens and mapping
   */
  extractPIILocally(text) {
    const piiMap = {};
    const tokens = [];
    let tokenizedText = text;
    let tokenCounter = 0;

    // Email pattern
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    const emails = text.match(emailRegex) || [];
    emails.forEach(email => {
      const token = `[EMAIL_${tokenCounter}]`;
      piiMap[token] = { type: 'email', value: email };
      tokenizedText = tokenizedText.replace(email, token);
      tokens.push(token);
      tokenCounter++;
    });

    // Phone patterns (various formats)
    const phoneRegex = /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g;
    const phones = text.match(phoneRegex) || [];
    phones.forEach(phone => {
      const token = `[PHONE_${tokenCounter}]`;
      piiMap[token] = { type: 'phone', value: phone };
      tokenizedText = tokenizedText.replace(phone, token);
      tokens.push(token);
      tokenCounter++;
    });

    // Name patterns (capitalized words in context of "name", "contact", etc.)
    const nameContextRegex = /(?:name|contact|person|client|customer name|contact name)[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi;
    let nameMatch;
    while ((nameMatch = nameContextRegex.exec(text)) !== null) {
      const name = nameMatch[1];
      const token = `[NAME_${tokenCounter}]`;
      piiMap[token] = { type: 'name', value: name };
      tokenizedText = tokenizedText.replace(name, token);
      tokens.push(token);
      tokenCounter++;
    }

    // Address patterns (multi-word capitalized sequences with numbers)
    const addressRegex = /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b/gi;
    const addresses = text.match(addressRegex) || [];
    addresses.forEach(address => {
      const token = `[ADDRESS_${tokenCounter}]`;
      piiMap[token] = { type: 'address', value: address };
      tokenizedText = tokenizedText.replace(address, token);
      tokens.push(token);
      tokenCounter++;
    });

    this.log('info', 'PII extraction completed locally', {
      piiDetected: tokens.length,
      types: Object.values(piiMap).map(p => p.type)
    });

    return {
      tokenizedText,
      piiMap,
      hasPII: tokens.length > 0
    };
  }

  /**
   * Restore PII values from tokens
   * @param {Object} extractedParams - Parameters with tokens
   * @param {Object} piiMap - PII mapping
   * @returns {Object} - Parameters with restored PII values
   */
  restorePII(extractedParams, piiMap) {
    const restored = {};

    for (const [key, value] of Object.entries(extractedParams)) {
      if (typeof value === 'string') {
        // Replace tokens with actual values
        let restoredValue = value;
        for (const [token, piiData] of Object.entries(piiMap)) {
          restoredValue = restoredValue.replace(token, piiData.value);
        }
        restored[key] = restoredValue;
      } else if (typeof value === 'object' && value !== null) {
        // Recursively restore nested objects
        restored[key] = this.restorePII(value, piiMap);
      } else {
        restored[key] = value;
      }
    }

    return restored;
  }

  /**
   * Extract parameters from user message using hybrid local/AI approach
   * STAGE 1: Local PII extraction (no API, zero exposure)
   * STAGE 2: Tokenized AI extraction (PII replaced with tokens)
   * STAGE 3: Restore real PII values
   *
   * @param {string} description - User message/description
   * @param {Object} baseParameters - Base parameters to enhance
   * @param {Object} templateSchema - Optional template parameterSchema to guide extraction
   * @returns {Object} - Enhanced parameters
   */
  async extractParametersWithGemini(description, baseParameters, templateSchema = null) {
    try {
      // STAGE 1: Extract PII locally (no API calls)
      const piiExtraction = this.extractPIILocally(description);
      const { tokenizedText, piiMap, hasPII } = piiExtraction;

      if (hasPII) {
        this.log('info', 'PII detected and tokenized locally', {
          originalLength: description.length,
          tokenizedLength: tokenizedText.length,
          piiTypes: Object.values(piiMap).map(p => p.type)
        });
      }

      // Security: Sanitize user input before using in prompts
      const sanitizedText = this.sanitizer.sanitizeUserInput(tokenizedText, 'task_description');
      if (sanitizedText !== tokenizedText) {
        this.log('warn', 'Prompt injection attempt detected and sanitized', {
          originalLength: tokenizedText.length,
          sanitizedLength: sanitizedText.length
        });
      }

      // STAGE 2: Build prompt based on whether we have template schema
      let prompt;

      if (templateSchema && templateSchema.properties) {
        // PRIMARY: Use template schema to guide Gemini's parameter extraction
        this.log('info', 'Using template schema to guide parameter extraction', {
          templateSchemaKeys: Object.keys(templateSchema.properties),
          requiredParams: templateSchema.required || []
        });

        const schemaDescription = Object.entries(templateSchema.properties)
          .map(([key, schema]) => {
            const required = (templateSchema.required || []).includes(key) ? ' (REQUIRED)' : '';
            return `  "${key}"${required}: ${schema.description || schema.type}`;
          })
          .join('\n');

        prompt = `Extract parameters from the user request according to this EXACT schema:

User Message: "${sanitizedText}"
Current Date: ${new Date().toISOString().split('T')[0]}

TEMPLATE PARAMETER SCHEMA (use these EXACT parameter names):
${schemaDescription}

EXTRACTION RULES:
1. Text may contain tokens like [EMAIL_0], [PHONE_0], [NAME_0], [ADDRESS_0]. Preserve these tokens exactly as-is.
2. For array parameters: Extract comma-separated lists, newline-separated lists, or space-separated lists as arrays
3. For array of strings: Convert each item to a string (e.g., [182080, 182038] → ["182080", "182038"])
4. For array of numbers: Parse each item as a number if the schema specifies number items
5. CRITICAL: You MUST use the exact parameter names from the schema above. Do not invent new parameter names.
6. CRITICAL: Return ONLY valid JSON with quoted property names. NO explanations, NO markdown.

Examples:
- User: "IDs: 123, 456, 789" + Schema: messageIds (array of strings) → {"messageIds": ["123", "456", "789"]}
- User: "IDs:\n123\n456\n789" + Schema: messageIds (array of strings) → {"messageIds": ["123", "456", "789"]}
- User: "Process items 1 2 3" + Schema: items (array of numbers) → {"items": [1, 2, 3]}

Extract parameters and return ONLY a JSON object with the schema's parameter names:`;
      } else {
        // FALLBACK: Generic parameter extraction without schema guidance
        this.log('info', 'No template schema provided, using generic parameter extraction');

        prompt = `Analyze this user request and extract ALL relevant parameters:

User Message: "${sanitizedText}"
Current Date: ${new Date().toISOString().split('T')[0]}

NOTE: Text may contain tokens like [EMAIL_0], [PHONE_0], [NAME_0], [ADDRESS_0]. Preserve these tokens exactly as-is in your output.

Extract ALL parameters mentioned in the request and return ONLY a JSON object with this format:
{
  "customerId": "extracted customer ID if mentioned (e.g., '158', 'CUST-123')",
  "companyId": "extracted company ID if mentioned",
  "contactId": "extracted contact ID if mentioned",
  "dealId": "extracted deal ID if mentioned",
  "invoiceId": "extracted invoice ID if mentioned",
  "email": "email token if found (e.g., '[EMAIL_0]')",
  "phone": "phone token if found (e.g., '[PHONE_0]')",
  "name": "name token if found (e.g., '[NAME_0]')",
  "address": "address token if found (e.g., '[ADDRESS_0]')",
  "dateRange": {
    "start": "YYYY-MM-DD",
    "end": "YYYY-MM-DD"
  },
  "detected": "description of what was detected"
}

Examples:
- "customer id 158 last 30 days" → {"customerId": "158", "dateRange": {"start": "2025-09-08", "end": "2025-10-08"}, "detected": "customer 158, 30 days"}
- "Look up customer 42 find invoices in last 2 months" → {"customerId": "42", "dateRange": {"start": "2025-08-08", "end": "2025-10-08"}, "detected": "customer 42, 2 months"}
- "customer 123 email [EMAIL_0] phone [PHONE_0]" → {"customerId": "123", "email": "[EMAIL_0]", "phone": "[PHONE_0]", "detected": "customer 123 with email and phone"}

IMPORTANT:
- Extract customer/company/contact/deal/invoice IDs from phrases like "customer id 158", "customer 158", "id 158"
- Preserve ALL tokens exactly as shown (e.g., [EMAIL_0], [PHONE_0], [NAME_0])
- Only include parameters that are actually mentioned in the message
- If no time period is found, use a 2-month default for the dateRange
- Return only the JSON, no other text or formatting

Return only the JSON object with detected parameters:`;
      }

      const response = await this.genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 4096, // Sufficient headroom for parameter extraction with safety margin
          temperature: 0.1
        }
      });

      // Use centralized response extraction with detailed logging
      const responseText = extractGeminiText(response, {
        includeLogging: true,
        logger: this.log.bind(this)
      });

      this.log('info', 'Gemini parameter extraction response', {
        responseLength: responseText.length,
        promptPreview: prompt.substring(0, 300) + '...',
        fullResponse: responseText.substring(0, 1000) // Log first 1000 chars for debugging
      });

      // Try to extract JSON from response - handle multiline and nested objects
      let jsonMatch = responseText.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        // Try alternative patterns
        jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || 
                   responseText.match(/```\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          jsonMatch[0] = jsonMatch[1]; // Use captured group
        }
      }
      
      if (!jsonMatch) {
        this.log('warn', 'No valid JSON found in Gemini response for date extraction', {
          response: responseText.substring(0, 200)
        });
        return baseParameters;
      }

      let extractedData;
      try {
        // Try to parse the JSON directly first
        extractedData = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        // If parsing fails, try to repair common issues
        let repairedJson = jsonMatch[0];
        
        // Fix incomplete JSON by adding missing closing braces and required fields
        if (!repairedJson.includes('"detected"')) {
          repairedJson = repairedJson.replace(/\}$/, '');
          if (!repairedJson.trim().endsWith(',')) {
            repairedJson += ',';
          }
          repairedJson += '\n  "detected": "extracted from user message"\n}';
        }
        
        // Ensure proper closing
        const openBraces = (repairedJson.match(/\{/g) || []).length;
        const closeBraces = (repairedJson.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
          repairedJson += '\n}';
        }
        
        try {
          extractedData = JSON.parse(repairedJson);
          this.log('info', 'Successfully repaired and parsed JSON', {
            originalJson: jsonMatch[0],
            repairedJson: repairedJson
          });
        } catch (repairError) {
          this.log('warn', 'Failed to parse extracted JSON for date range after repair attempt', {
            originalJson: jsonMatch[0],
            repairedJson: repairedJson,
            parseError: parseError.message,
            repairError: repairError.message
          });
          return baseParameters;
        }
      }

      // Filter out null/undefined values and detected field
      const extractedParams = {};
      for (const [key, value] of Object.entries(extractedData)) {
        if (key !== 'detected' && value !== null && value !== undefined) {
          extractedParams[key] = value;
        }
      }

      // STAGE 3: Restore PII values from tokens
      let finalParams = extractedParams;
      if (hasPII) {
        finalParams = this.restorePII(extractedParams, piiMap);
        this.log('info', 'PII restored to parameters', {
          tokensRestored: Object.keys(piiMap).length,
          parameterKeys: Object.keys(finalParams)
        });
      }

      this.log('info', 'Parameters extracted by Gemini (with PII protection)', {
        detected: extractedData.detected,
        extractedParameters: Object.keys(finalParams),
        piiProtected: hasPII
      });

      // Ensure we always have a dateRange (90-day fallback)
      if (!finalParams.dateRange) {
        finalParams.dateRange = {
          start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 90 days ago
          end: new Date().toISOString().split('T')[0] // today
        };
      }

      return {
        ...baseParameters,
        ...finalParams
      };
    } catch (error) {
      this.log('warn', 'Failed to extract parameters with Gemini, using base parameters', {
        error: error.message
      });
      
      // Ensure we always return a valid parameter structure with dateRange fallback
      return {
        ...baseParameters,
        dateRange: {
          start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 90 days ago
          end: new Date().toISOString().split('T')[0] // today
        }
      };
    }
  }

  /**
   * Create a new complex task
   * @param {Object} args - Creation arguments
   * @param {string} userId - User identifier
   * @param {Object} toolContext - Tool execution context
   * @returns {Object} - Creation result
   */
  async createTask(args, userId, toolContext) {
    try {
      const { templateId, description, parameters, priority, autoDetect = true, userIntent } = args;

      let result;

      // CRITICAL: Check user intent FIRST before using templateId
      // If user explicitly says "create NEW", ignore any templateId and generate agentically
      if (userIntent === 'CREATE_NEW_TASK' && description) {
        this.log('info', 'User explicitly requested NEW task creation, skipping template reuse', {
          description: description.substring(0, 100),
          ignoredTemplateId: templateId || 'none',
          userId
        });
        // Skip to agentic generation below (don't use templateId)
      } else if (templateId) {
        // Only use templateId if user intent is REUSE or not specified
        // Verify template exists before using it
        const template = await this.templatesModel.getTemplate(templateId);

        if (!template) {
          this.log('warn', 'Template ID provided but not found, falling back to auto-detection', {
            templateId,
            hasDescription: !!description,
            autoDetect
          });

          // Fall back to auto-detection if template doesn't exist
          if (description && autoDetect !== false) {
            // Continue to auto-detection logic below
            // (Don't use templateId, let the system find or generate the right template)
          } else {
            throw new Error(`Task template not found: ${templateId}`);
          }
        } else {
          // Template exists, use it
          // Extract and enhance parameters even when templateId is provided (convert "last 60 days" → actual dates)
          // PRIMARY: Pass template's parameterSchema to guide Gemini's parameter extraction

          // CRITICAL FIX: When description is provided, IGNORE the parameters arg from Gemini's function call
          // Gemini sometimes hallucinates parameters (e.g., window properties) when constructing function calls
          // We must extract parameters fresh from the description using the template's schema as ground truth
          const enhancedParameters = description
            ? await this.extractParametersWithGemini(description, {}, template.definition?.parameterSchema)
            : parameters || {};

          // Ensure we always have a dateRange (absolute fallback)
          if (!enhancedParameters.dateRange) {
            enhancedParameters.dateRange = {
              start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 90 days ago
              end: new Date().toISOString().split('T')[0] // today
            };
          }

          // CRITICAL: Normalize parameter names to match template's parameterSchema
          // Gemini often uses different names (e.g., "customer_list_csv") than what templates expect (e.g., "csvData")
          const normalizedParameters = this.normalizeParameterNames(enhancedParameters, template);

          result = await this.orchestrator.createTaskFromTemplate(
            templateId,
            normalizedParameters,
            userId,
            {
              priority: priority || 50,
              userMessage: description,
              userIntent: args.userIntent || 'CREATE_NEW_TASK', // Store AI-detected intent for self-repair (match schema default)
              entityScope: args.entityScope || 'AUTO', // Store AI-detected entity scope for self-repair
              messageContext: toolContext?.messageData || {}
            }
          );
        }
      }

      // Auto-detection path (also used as fallback when templateId doesn't exist)
      if (!result && description && autoDetect !== false) {
        // CRITICAL: Use AI-detected user intent instead of brittle regex patterns
        // Default to CREATE_NEW_TASK to match parameter schema default
        const userIntent = args.userIntent || 'CREATE_NEW_TASK';
        let existingTemplate;

        if (userIntent === 'CREATE_NEW_TASK') {
          this.log('info', 'Gemini detected CREATE_NEW_TASK intent, skipping template matching', {
            description: description.substring(0, 100),
            userId,
            userIntent: 'CREATE_NEW_TASK',
            recommendation: 'force_agentic_generation'
          });

          // Skip template matching entirely - go straight to agentic generation
          existingTemplate = null;
        } else {
          // User wants to reuse existing template - try semantic search
          this.log('info', 'Gemini detected REUSE_EXISTING_TEMPLATE intent, searching for matching template', {
            description: description.substring(0, 100),
            userId,
            userIntent: 'REUSE_EXISTING_TEMPLATE',
            semanticSearchEnabled: process.env.ENABLE_SEMANTIC_TEMPLATES === 'true'
          });

          existingTemplate = await this.findBestTemplate(description, userId);
        }

        if (existingTemplate) {
          this.log('info', 'Found existing template for request', {
            templateId: existingTemplate.templateId,
            templateName: existingTemplate.name,
            description: description.substring(0, 100)
          });

          // Extract parameters using Gemini with template schema guidance
          const enhancedParameters = await this.extractParametersWithGemini(
            description,
            parameters || {},
            existingTemplate.definition?.parameterSchema
          );

          // Ensure we always have a dateRange (absolute fallback)
          if (!enhancedParameters.dateRange) {
            enhancedParameters.dateRange = {
              start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 90 days ago
              end: new Date().toISOString().split('T')[0] // today
            };
          }

          // CRITICAL: Validate that extracted parameters match template requirements
          // If template requires entity ID but none was extracted, reject template and create new one
          const templateDef = existingTemplate.definition || {};
          const requiredParams = templateDef.parameterSchema?.required || [];
          const requiresEntityId = requiredParams.includes('customerId') ||
                                  requiredParams.includes('contactId') ||
                                  requiredParams.includes('companyId') ||
                                  requiredParams.includes('dealId') ||
                                  requiredParams.includes('leadId');

          let shouldUseTemplate = true;

          if (requiresEntityId) {
            // Check if ANY required entity ID was actually extracted
            const hasCustomerId = enhancedParameters.customerId;
            const hasContactId = enhancedParameters.contactId;
            const hasCompanyId = enhancedParameters.companyId;
            const hasDealId = enhancedParameters.dealId;
            const hasLeadId = enhancedParameters.leadId;

            const hasAnyRequiredEntityId = hasCustomerId || hasContactId || hasCompanyId || hasDealId || hasLeadId;

            if (!hasAnyRequiredEntityId) {
              this.log('info', 'Template requires entity ID but none extracted from user request, rejecting template', {
                templateId: existingTemplate.templateId,
                templateName: existingTemplate.name,
                requiredParams: requiredParams,
                extractedParams: Object.keys(enhancedParameters),
                userRequestType: 'aggregate_or_missing_entity',
                recommendation: 'create_new_aggregate_template'
              });

              // Don't use this template - force agentic generation instead
              shouldUseTemplate = false;
            }
          }

          // Use existing template only if validation passed
          if (shouldUseTemplate) {
            result = await this.orchestrator.createTaskFromTemplate(
              existingTemplate.templateId,
              enhancedParameters,
              userId,
              {
                priority: priority || 50,
                userMessage: description,
                userIntent: args.userIntent || 'REUSE_EXISTING_TEMPLATE',
                entityScope: args.entityScope || 'AUTO',
                messageContext: toolContext?.messageData || {}
              }
            );
          }
        } else {
          // No existing template found, check if agentic generation is enabled
          if (args.agenticGeneration !== false) {
            // Try agentic task generation
            try {
              this.log('info', 'No existing template found, attempting agentic task generation', {
                description: description.substring(0, 100),
                userId
              });

              const agenticResult = await this.generateTaskAgentically(
                description,
                parameters || {},
                userId,
                toolContext,
                args.entityScope || 'AUTO'
              );
              if (agenticResult.success) {
                return agenticResult;
              } else {
                this.log('error', 'Agentic generation failed, no fallback available', {
                  reason: agenticResult.reason,
                  details: agenticResult.details
                });
                // Throw error so Gemini reports failure accurately to user
                throw new Error(`Could not create task: ${agenticResult.reason}. ${agenticResult.details || ''}`);
              }
            } catch (error) {
              this.log('error', 'Agentic generation error, no fallback available', {
                error: error.message,
                stack: error.stack
              });
              // Re-throw so Gemini reports error to user accurately
              throw error;
            }
          } else {
            this.log('error', 'No existing template found and agentic generation disabled', {
              description: description.substring(0, 100)
            });
            // Throw error so Gemini reports failure accurately to user
            throw new Error('No matching template found. Please specify a template ID or enable agentic generation.');
          }
        }
      }

      // If we still don't have a result, something went wrong
      if (!result) {
        throw new Error('Either templateId or description is required for task creation');
      }

      this.log('info', 'Task created successfully', {
        taskId: result.taskId,
        templateId: result.template?.templateId,
        userId
      });

      // Send immediate notification about task start
      const startNotification = '🚀 **Task Started**\n\n' +
        `I've started working on your **${result.template?.name}** request. This may take some time to complete.\n\n` +
        `**Task ID:** \`${result.taskId}\`\n` +
        `**Estimated Duration:** ${this.formatDuration(result.estimation?.duration || 300000)}\n` +
        `**Steps:** ${result.estimation?.steps || 5}\n\n` +
        '*I\'ll notify you when it\'s complete. You can check progress anytime with:*\n' +
        `\`task status ${result.taskId}\``;

      return {
        success: true,
        taskId: result.taskId,
        template: result.template?.name,
        estimation: result.estimation,
        message: startNotification,
        // Include task details for potential follow-up notifications
        taskDetails: {
          taskId: result.taskId,
          templateName: result.template?.name,
          estimatedDuration: result.estimation?.duration || 300000
        }
      };
    } catch (error) {
      this.log('error', 'Task creation failed', { error: error.message, userId });
      throw error;
    }
  }

  /**
   * Get task status
   * @param {Object} args - Status arguments
   * @param {string} userId - User identifier
   * @returns {Object} - Status result
   */
  async getTaskStatus(args, userId) {
    try {
      const { taskId } = args;
      
      if (!taskId) {
        throw new Error('Task ID is required for status check');
      }

      const task = await this.taskQueueModel.getTask(taskId);
      
      if (!task) {
        // Try to find similar task IDs to help user with potential typos
        this.log('warn', 'Task not found, checking for similar task IDs', { 
          requestedTaskId: taskId,
          userId 
        });
        
        // Get user's recent tasks to suggest alternatives
        const recentTasks = await this.taskQueueModel.getUserTasks(userId, ['pending', 'running'], 5);
        let suggestionMessage = `❌ Task not found: ${taskId}`;
        
        if (recentTasks.length > 0) {
          suggestionMessage += '\n\n📋 **Your Recent Tasks:**\n';
          recentTasks.forEach((recentTask, index) => {
            suggestionMessage += `${index + 1}. \`${recentTask.taskId}\` - ${recentTask.status}\n`;
          });
          suggestionMessage += '\n*Use the exact task ID from the list above.*';
        } else {
          suggestionMessage += '\n\n*You have no active tasks. Use "list tasks" to see your task history.*';
        }
        
        return {
          success: false,
          message: suggestionMessage,
          recentTasks: recentTasks.map(t => ({ taskId: t.taskId, status: t.status }))
        };
      }

      // Check if user owns this task
      if (task.createdBy !== userId) {
        return {
          success: false,
          message: '❌ Access denied: You can only view your own tasks'
        };
      }

      const statusEmoji = {
        'pending': '⏳',
        'running': '🔄',
        'completed': '✅',
        'failed': '❌',
        'cancelled': '🚫'
      };

      let statusMessage = `${statusEmoji[task.status] || '❓'} **Task Status: ${task.status.toUpperCase()}**\n\n`;
      statusMessage += `**Task ID:** ${task.taskId}\n`;
      statusMessage += `**Template:** ${task.templateId}\n`;
      statusMessage += `**Created:** ${this.formatTimestamp(task.createdAt)}\n`;

      if (task.progress) {
        statusMessage += `**Progress:** ${task.progress.percentage || 0}%\n`;
        if (task.progress.message) {
          statusMessage += `**Current Step:** ${task.progress.message}\n`;
        }
        if (task.progress.data?.currentStep) {
          statusMessage += `**Step:** ${task.progress.data.stepsCompleted || 0}/${task.progress.data.stepsTotal || 1}\n`;
        }
      }

      if (task.execution?.workerId) {
        statusMessage += `**Worker:** ${task.execution.workerId}\n`;
      }

      if (task.status === 'completed' && task.result) {
        statusMessage += '\n**📄 Results:**\n';
        statusMessage += `- Execution Time: ${this.formatDuration(task.result.executionTime || 0)}\n`;
        if (task.result.summary) {
          statusMessage += `- Summary: ${task.result.summary}\n`;
        }
        if (task.result.attachments?.length > 0) {
          statusMessage += `- Attachments: ${task.result.attachments.length} files\n`;
        }
      }

      if (task.status === 'failed' && task.errors?.length > 0) {
        statusMessage += '\n**⚠️ Errors:**\n';
        const latestError = task.errors[task.errors.length - 1];
        statusMessage += `- ${latestError.type}: ${latestError.message}\n`;
        if (latestError.step) {
          statusMessage += `- Failed at step: ${latestError.step}\n`;
        }
      }

      return {
        success: true,
        task,
        message: statusMessage
      };
    } catch (error) {
      this.log('error', 'Task status check failed', { taskId: args.taskId, error: error.message });
      throw error;
    }
  }

  /**
   * Cancel a task
   * @param {Object} args - Cancel arguments
   * @param {string} userId - User identifier
   * @returns {Object} - Cancel result
   */
  async cancelTask(args, userId) {
    try {
      const { taskId } = args;
      
      if (!taskId) {
        throw new Error('Task ID is required for cancellation');
      }

      const task = await this.taskQueueModel.getTask(taskId);
      
      if (!task) {
        return {
          success: false,
          message: `❌ Task not found: ${taskId}`
        };
      }

      // Check if user owns this task
      if (task.createdBy !== userId) {
        return {
          success: false,
          message: '❌ Access denied: You can only cancel your own tasks'
        };
      }

      // Check if task can be cancelled
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        return {
          success: false,
          message: `❌ Cannot cancel task in ${task.status} state`
        };
      }

      // Cancel the task
      const success = await this.taskQueueModel.cancelTask(taskId);
      
      if (success) {
        this.log('info', 'Task cancelled', { taskId, userId });
        return {
          success: true,
          message: `🚫 Task cancelled: ${taskId}\n\n*The task has been cancelled and will not continue execution.*`
        };
      } else {
        throw new Error('Failed to cancel task in database');
      }
    } catch (error) {
      this.log('error', 'Task cancellation failed', { taskId: args.taskId, error: error.message });
      throw error;
    }
  }

  /**
   * Cancel all running and pending tasks for a user
   * @param {Object} args - Cancel arguments
   * @param {string} userId - User identifier
   * @returns {Object} - Cancel result
   */
  async cancelAllTasks(args, userId) {
    try {
      // Get ALL active tasks for the user (including auto-repair states)
      const tasks = await this.taskQueueModel.getUserTasks(
        userId,
        ['pending', 'running', 'failed_auto_repairing', 'auto_repaired_retrying'],
        100
      );

      if (tasks.length === 0) {
        return {
          success: true,
          message: '✅ No active tasks to cancel\n\n*You have no running or pending tasks.*'
        };
      }

      // Cancel each task
      const cancelResults = [];
      let successCount = 0;
      let failureCount = 0;

      for (const task of tasks) {
        try {
          const success = await this.taskQueueModel.cancelTask(task.taskId);
          if (success) {
            successCount++;
            cancelResults.push({
              taskId: task.taskId,
              templateId: task.templateId,
              status: 'cancelled'
            });
          } else {
            failureCount++;
            cancelResults.push({
              taskId: task.taskId,
              templateId: task.templateId,
              status: 'failed'
            });
          }
        } catch (error) {
          failureCount++;
          cancelResults.push({
            taskId: task.taskId,
            templateId: task.templateId,
            status: 'error',
            error: error.message
          });
        }
      }

      this.log('info', 'Bulk task cancellation completed', {
        userId,
        totalTasks: tasks.length,
        successCount,
        failureCount
      });

      let message = '🚫 **Bulk Task Cancellation**\n\n';
      message += `✅ Successfully cancelled: ${successCount} tasks\n`;

      if (failureCount > 0) {
        message += `❌ Failed to cancel: ${failureCount} tasks\n`;
      }

      message += '\n**Cancelled Tasks:**\n';
      cancelResults.forEach((result, index) => {
        const statusEmoji = result.status === 'cancelled' ? '✅' : '❌';
        message += `${index + 1}. ${statusEmoji} ${result.templateId} (\`${result.taskId}\`)\n`;
      });

      return {
        success: true,
        cancelledCount: successCount,
        failedCount: failureCount,
        totalTasks: tasks.length,
        results: cancelResults,
        message
      };
    } catch (error) {
      this.log('error', 'Bulk task cancellation failed', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * List user tasks
   * @param {Object} args - List arguments
   * @param {string} userId - User identifier
   * @returns {Object} - List result
   */
  async listUserTasks(args, userId) {
    try {
      const { status = ['pending', 'running'], limit = 10 } = args;
      
      const tasks = await this.taskQueueModel.getUserTasks(userId, status, limit);
      
      if (tasks.length === 0) {
        return {
          success: true,
          tasks: [],
          message: `📝 No tasks found for status: ${Array.isArray(status) ? status.join(', ') : status}`
        };
      }

      let message = `📝 **Your Tasks** (${tasks.length} found)\n\n`;
      
      tasks.forEach((task, index) => {
        const statusEmoji = {
          'pending': '⏳',
          'running': '🔄',
          'completed': '✅',
          'failed': '❌',
          'cancelled': '🚫'
        };

        message += `${index + 1}. ${statusEmoji[task.status]} **${task.templateId}**\n`;
        message += `   ID: \`${task.taskId}\`\n`;
        message += `   Status: ${task.status}`;
        
        if (task.progress?.percentage) {
          message += ` (${task.progress.percentage}%)`;
        }
        
        message += `\n   Created: ${this.formatTimestamp(task.createdAt)}\n\n`;
      });

      message += '*Use "task status <task-id>" to view detailed status for any task.*';

      return {
        success: true,
        tasks,
        message
      };
    } catch (error) {
      this.log('error', 'Task listing failed', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Format duration in human-readable format
   * @param {number} ms - Duration in milliseconds
   * @returns {string} - Formatted duration
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Format timestamp for display
   * @param {*} timestamp - Firestore timestamp
   * @returns {string} - Formatted timestamp
   */
  formatTimestamp(timestamp) {
    if (!timestamp) {return 'Unknown';}
    
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return date.toLocaleString();
    } catch (error) {
      return 'Invalid date';
    }
  }

  /**
   * Generate a complex task agentically using knowledge base and AI
   * @param {string} description - User's natural language description
   * @param {Object} parameters - Additional parameters
   * @param {string} userId - User ID
   * @param {Object} toolContext - Tool execution context
   * @param {string} entityScope - Entity scope for task execution (AGGREGATE | SPECIFIC_ENTITY | AUTO)
   * @returns {Object} - Task creation result
   */
  async generateTaskAgentically(description, parameters, userId, toolContext, entityScope = 'AUTO') {
    try {
      this.log('info', 'Starting agentic task generation', { 
        description: description.substring(0, 100),
        userId,
        hasKnowledgeContext: !!toolContext.knowledgeResults
      });

      // Step 1: Search knowledge base for relevant information
      const knowledgeResults = await this.searchRelevantKnowledge(description, toolContext);
      
      // Step 2: Generate task template using AI
      const generatedTemplate = await this.generateTaskTemplate(description, parameters, knowledgeResults, toolContext);
      
      if (!generatedTemplate.success) {
        this.log('warn', 'Agentic template generation failed, attempting fallback', {
          error: generatedTemplate.error,
          description: description.substring(0, 100)
        });
        
        // Fallback: Try to find a working template based on content patterns
        const fallbackTemplate = await this.findFallbackTemplate(description);
        if (fallbackTemplate) {
          this.log('info', 'Using fallback template for agentic task', {
            fallbackTemplateId: fallbackTemplate.templateId,
            originalDescription: description.substring(0, 100)
          });

          // Use the fallback template with schema-guided parameter extraction
          const enhancedParameters = await this.extractParametersWithGemini(
            description,
            parameters || {},
            fallbackTemplate.definition?.parameterSchema
          );
          
          // Ensure we always have a dateRange
          if (!enhancedParameters.dateRange) {
            enhancedParameters.dateRange = {
              start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
              end: new Date().toISOString().split('T')[0]
            };
          }
          
          const taskResult = await this.orchestrator.createTaskFromTemplate(
            fallbackTemplate.templateId,
            enhancedParameters,
            userId,
            {
              userMessage: description,
              userIntent: 'REUSE_EXISTING_TEMPLATE', // Fallback template = reusing
              entityScope: 'AUTO', // Let system decide based on template
              messageContext: { dialogId: this.messageData?.dialogId }
            }
          );
          
          return {
            success: true,
            taskId: taskResult.taskId,
            message: `📋 **Task Created Using Fallback Template**\n\n✅ I've created your task using the **${fallbackTemplate.name}** template.\n\n**Task ID:** \`${taskResult.taskId}\`\n\nThe task is now running and you'll receive a notification when it's complete.`,
            usedFallback: true,
            fallbackTemplateId: fallbackTemplate.templateId
          };
        }
        
        return {
          success: false,
          reason: 'Failed to generate task template and no suitable fallback found',
          details: generatedTemplate.error
        };
      }

      // Step 3: Extract parameters with schema guidance from generated template
      const enhancedParameters = await this.extractParametersWithGemini(
        description,
        parameters || {},
        generatedTemplate.template.definition?.parameterSchema
      );

      // Ensure we always have a dateRange (absolute fallback)
      if (!enhancedParameters.dateRange) {
        enhancedParameters.dateRange = {
          start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 90 days ago
          end: new Date().toISOString().split('T')[0] // today
        };
      }

      this.log('info', 'Enhanced parameters for agentic task', {
        originalParameters: parameters,
        enhancedParameters: enhancedParameters
      });

      // Step 4: Create task from generated template with enhanced parameters
      const taskResult = await this.createTaskFromGeneratedTemplate(
        generatedTemplate.template,
        userId,
        enhancedParameters,
        description,
        entityScope
      );

      this.log('info', 'Agentic task generation completed', {
        taskId: taskResult.taskId,
        templateId: taskResult.templateId,
        testing: taskResult.testing
      });

      // Generate proactive suggestions for next steps
      const nextStepSuggestions = await this.generateNextStepSuggestions(taskResult, generatedTemplate.template);

      return {
        success: true,
        taskId: taskResult.taskId,
        templateId: taskResult.templateId,
        template: taskResult.template,
        message: '🤖 **Custom Task Generated Agentically**\n\n' +
          `I've created a custom task specifically for your request: **${generatedTemplate.template.name}**\n\n` +
          `**Task ID:** \`${taskResult.taskId}\`\n` +
          `**Template ID:** \`${taskResult.templateId}\`\n` +
          `**Testing Mode:** ${taskResult.testing ? '🧪 **ENABLED** - Enhanced error handling with auto-repair' : '✅ **DISABLED** - Production run'}\n\n` +
          `${taskResult.testing ?
            '*This task is in **testing mode**. It will run with full data but includes enhanced error handling and automatic self-repair if issues occur. This allows the template to improve itself during execution.*' :
            '*This task will run in production mode with standard error handling.*'
          }\n\n` +
          `**Estimated Duration:** ${this.formatDuration(generatedTemplate.template.definition.estimatedDuration)}\n` +
          `**Steps:** ${generatedTemplate.template.definition.estimatedSteps}\n\n` +
          nextStepSuggestions,
        testing: taskResult.testing,
        agenticallyGenerated: true,
        suggestedActions: ['test', 'execute', 'modify']
      };

    } catch (error) {
      this.log('error', 'Agentic task generation failed', {
        error: error.message,
        stack: error.stack
      });
      
      return {
        success: false,
        reason: 'Agentic generation error',
        details: error.message
      };
    }
  }

  /**
   * Search knowledge base for relevant information to assist task generation
   * @param {string} description - User description
   * @param {Object} toolContext - Tool context (may contain existing knowledge results)
   * @returns {Array} - Relevant knowledge base articles
   */
  async searchRelevantKnowledge(description, toolContext) {
    try {
      // Use existing knowledge results if available from tool context
      if (toolContext.knowledgeResults && toolContext.knowledgeResults.length > 0) {
        this.log('info', 'Using existing knowledge results from tool context', {
          resultsCount: toolContext.knowledgeResults.length
        });
        return toolContext.knowledgeResults;
      }

      // Search for complex task creation guidance
      const systemKnowledge = await this.searchKnowledgeBase([
        'agentic task creation',
        'complex task development', 
        'bitrix24 api integration',
        'executionScript patterns'
      ]);

      // Search for relevant content based on user description
      const contextualKnowledge = await this.searchKnowledgeBase([
        description,
        this.extractKeywords(description)
      ].flat());

      // Combine and deduplicate results
      const allResults = [...systemKnowledge, ...contextualKnowledge];
      const uniqueResults = Array.from(
        new Map(allResults.map(item => [item.id, item])).values()
      );

      this.log('info', 'Knowledge base search completed - sending ALL semantic matches', {
        systemResults: systemKnowledge.length,
        contextualResults: contextualKnowledge.length,
        totalUniqueResults: uniqueResults.length,
        docTitles: uniqueResults.map(d => d.title)
      });

      // Return ALL semantic search results (no arbitrary limit)
      return uniqueResults;

    } catch (error) {
      this.log('warn', 'Knowledge base search failed', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Search knowledge base using the KnowledgeManagement tool
   * @param {Array} searchTerms - Array of search terms
   * @returns {Array} - Search results
   */
  async searchKnowledgeBase(searchTerms) {
    if (!Array.isArray(searchTerms) || searchTerms.length === 0) {
      return [];
    }

    try {
      // Access KnowledgeManagement tool through tool context
      const KnowledgeManagementTool = require('./knowledgeManagement');
      const knowledgeTool = new KnowledgeManagementTool(this.context);
      await knowledgeTool.initialize();

      const allResults = [];
      
      for (const term of searchTerms.slice(0, 3)) { // Limit searches
        if (typeof term === 'string' && term.trim().length > 2) {
          const searchResult = await knowledgeTool.execute({
            action: 'search',
            query: term.trim(),
            maxResults: 3
          }, { /* system search - no user filtering */ });
          
          if (searchResult.success && searchResult.results) {
            allResults.push(...searchResult.results);
          }
        }
      }

      return allResults;

    } catch (error) {
      this.log('warn', 'Knowledge base search error', {
        error: error.message,
        searchTerms: searchTerms.slice(0, 3)
      });
      return [];
    }
  }

  /**
   * Extract keywords from user description
   * @param {string} description - User description
   * @returns {Array} - Extracted keywords
   */
  extractKeywords(description) {
    if (!description || typeof description !== 'string') {
      return [];
    }

    // Common task-related keywords
    const taskKeywords = [
      'report', 'analysis', 'generate', 'create', 'process', 'analyze',
      'invoice', 'customer', 'company', 'contact', 'deal', 'activity',
      'bitrix24', 'crm', 'dashboard', 'export', 'import', 'bulk'
    ];

    const words = description.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2);

    // Return relevant keywords found in description
    return words.filter(word =>
      taskKeywords.includes(word) ||
      /^(last|past|this|current|recent|monthly|daily|weekly)$/.test(word)
    );
  }

  /**
   * Normalize parameter names to match template's parameterSchema
   * Gemini often uses different parameter names than what templates expect
   * @param {Object} parameters - Parameters from Gemini
   * @param {Object} template - Task template with parameterSchema
   * @returns {Object} - Normalized parameters
   */
  normalizeParameterNames(parameters, template) {
    const schema = template?.definition?.parameterSchema;

    if (!schema || !schema.properties) {
      // No schema to normalize against, return as-is
      return parameters;
    }

    const normalized = { ...parameters };
    const schemaKeys = Object.keys(schema.properties);

    // Common parameter name variations that Gemini uses
    const nameVariations = {
      'csvData': ['customer_list_csv', 'csv_data', 'csv', 'customerListCsv', 'list_data'],
      'customerId': ['customer_id', 'customid', 'cid'],
      'companyId': ['company_id', 'companyid'],
      'contactId': ['contact_id', 'contactid'],
      'dealId': ['deal_id', 'dealid'],
      'invoiceId': ['invoice_id', 'invoiceid'],
      'dateRange': ['date_range', 'range', 'period']
    };

    // For each property in the schema, check if we have a variation in the parameters
    for (const schemaKey of schemaKeys) {
      // If parameter already exists with correct name, skip
      if (parameters[schemaKey] !== undefined) {
        continue;
      }

      // Check for variations
      const variations = nameVariations[schemaKey] || [];
      for (const variation of variations) {
        if (parameters[variation] !== undefined) {
          this.log('info', 'Normalizing parameter name to match template schema', {
            original: variation,
            normalized: schemaKey,
            templateId: template.templateId,
            value: typeof parameters[variation] === 'string'
              ? parameters[variation].substring(0, 100)
              : JSON.stringify(parameters[variation]).substring(0, 100)
          });

          // Move the parameter to the correct name
          normalized[schemaKey] = parameters[variation];
          delete normalized[variation];
          break;
        }
      }
    }

    return normalized;
  }

  /**
   * Find a fallback template when agentic generation fails
   * @param {string} description - Task description
   * @returns {Object|null} - Fallback template or null
   */
  async findFallbackTemplate(description) {
    try {
      const lowerDesc = description.toLowerCase();
      
      // Check for invoice-related requests
      if (lowerDesc.includes('invoice') || lowerDesc.includes('customer') || 
          lowerDesc.includes('report') || lowerDesc.includes('money')) {
        
        const templates = await this.taskTemplatesModel.getActiveTemplates();
        
        // Look for invoice-related templates
        const invoiceTemplate = templates.find(t => 
          t.templateId.includes('invoice') || 
          t.category.some(cat => cat.toLowerCase().includes('financial')) ||
          t.name.toLowerCase().includes('invoice')
        );
        
        if (invoiceTemplate) {
          this.log('info', 'Found invoice fallback template', {
            templateId: invoiceTemplate.templateId,
            templateName: invoiceTemplate.name
          });
          return invoiceTemplate;
        }
      }
      
      // Check for general reporting requests
      if (lowerDesc.includes('report') || lowerDesc.includes('analysis')) {
        const templates = await this.taskTemplatesModel.getActiveTemplates();
        
        const reportTemplate = templates.find(t => 
          t.category.some(cat => cat.toLowerCase().includes('reporting')) ||
          t.name.toLowerCase().includes('report')
        );
        
        if (reportTemplate) {
          this.log('info', 'Found reporting fallback template', {
            templateId: reportTemplate.templateId,
            templateName: reportTemplate.name
          });
          return reportTemplate;
        }
      }
      
      return null;
    } catch (error) {
      this.log('error', 'Error finding fallback template', {
        error: error.message,
        description: description.substring(0, 100)
      });
      return null;
    }
  }

  /**
   * Generate a task template using AI based on user description and knowledge
   * @param {string} description - User description
   * @param {Object} parameters - Base parameters
   * @param {Array} knowledgeResults - Relevant knowledge base articles
   * @param {Object} toolContext - Tool context
   * @returns {Object} - Generated template result
   */
  async generateTaskTemplate(description, parameters, knowledgeResults, toolContext) {
    try {
      // Security: Sanitize user input before using in prompts
      const sanitizedDescription = this.sanitizer.sanitizeUserInput(description, 'task_description');
      if (sanitizedDescription !== description) {
        this.log('warn', 'Prompt injection attempt detected in template generation', {
          originalLength: description.length,
          sanitizedLength: sanitizedDescription.length
        });
      }

      const knowledgeContext = knowledgeResults
        .map(kb => {
          // CRITICAL: Send FULL content for ALL KB articles (NO TRUNCATION EVER)
          return `**${kb.title}**:\n${kb.content}`;
        })
        .join('\n\n---\n\n');

      // ✅ PHASE 2.1: Retrieve relevant memories for generation
      let memoryContext = '';
      let usedMemoryIds = [];

      if (config.REASONING_MEMORY_ENABLED) {
        try {
          const embeddingService = require('../services/embeddingService');
          const { getReasoningMemoryModel } = require('../models/reasoningMemory');
          const memoryModel = getReasoningMemoryModel();

          // Generate embedding for user request
          const queryText = `${description}. Creating new task template for: ${JSON.stringify(parameters)}`;
          const queryEmbedding = await embeddingService.embedQuery(queryText, 'RETRIEVAL_QUERY');

          // Retrieve highly successful memories focused on generation patterns
          const memories = await memoryModel.retrieveMemories(queryEmbedding, 5, {
            minSuccessRate: 0.7  // Only proven strategies (70%+ success)
          });

          if (memories && memories.length > 0) {
            usedMemoryIds = memories.map(m => m.id);

            memoryContext = `
**PROVEN STRATEGIES FROM PAST EXECUTIONS:**
${memories.map((m, i) => `${i + 1}. **${m.title}** (Success Rate: ${((m.successRate || 0) * 100).toFixed(0)}%, Category: ${m.category})
   ${m.description}
   Strategy: ${m.content}
   ${m.source ? `Source: ${m.source}` : ''}`).join('\n\n')}

**CRITICAL**: Apply these proven patterns during template generation. These strategies have been validated through successful executions.
`;

            this.log('info', 'Retrieved memories for template generation', {
              memoryCount: memories.length,
              avgSuccessRate: (memories.reduce((sum, m) => sum + (m.successRate || 0), 0) / memories.length).toFixed(2),
              categories: [...new Set(memories.map(m => m.category))]
            });
          } else {
            this.log('info', 'No memories retrieved for template generation', {
              reasoningMemoryEnabled: true,
              queryLength: queryText.length
            });
          }
        } catch (memoryError) {
          // Don't fail generation if memory retrieval fails
          this.log('warn', 'Failed to retrieve memories for generation', {
            error: memoryError.message
          });
        }
      }

      const prompt = `You are an expert at creating complex task templates for the Chantilly Agent platform.

**USER REQUEST:**
"${sanitizedDescription}"

**AVAILABLE PARAMETERS:**
${JSON.stringify(parameters, null, 2)}

${memoryContext}

**RELEVANT KNOWLEDGE BASE:**
${knowledgeContext}

**CONTEXT:**
- User ID: ${toolContext?.messageData?.userId || 'unknown'}
- Platform: Bitrix24 CRM integration
- Environment: Google Cloud Tasks with JavaScript execution
- Purpose: Create a complete task template that can execute safely

**CRITICAL REQUIREMENTS:**
1. Generate a complete JavaScript task template extending BaseTaskExecutor
2. Use Cloud Tasks execution environment safely (no external dependencies)
3. Include proper Bitrix24 API integration using this.callAPI() and this.streamingFetch()
4. Generate useful HTML reports with entity links back to Bitrix24
5. Include comprehensive error handling and progress tracking
6. Set testing: true by default for new templates
7. Follow all security best practices from knowledge base

**TEMPLATE STRUCTURE:**
Return ONLY a JSON object with this exact structure (NO MARKDOWN FORMATTING, NO executionScript field):
{
  "templateId": "unique_snake_case_id_no_spaces_lowercase_only",
  "name": "Human Readable Name",
  "description": "Detailed description of what this task does and its purpose",
  "category": ["Reporting", "Analysis", "CRM"],
  "enabled": true,
  "testing": true,
  "triggers": {
    "patterns": ["regex pattern1", "regex pattern2"],
    "keywords": ["keyword1", "keyword2"],
    "contexts": ["context1", "context2"]
  },
  "definition": {
    "estimatedSteps": 6,
    "estimatedDuration": 900000,
    "memoryRequirement": "512MB",
    "requiredServices": ["queueService", "fileStorage"],
    "parameterSchema": {
      "type": "object",
      "properties": {
        "customerId": {"type": "string", "description": "Customer ID (always string, e.g., '158')"},
        "companyId": {"type": "string", "description": "Company ID (always string)"},
        "contactId": {"type": "string", "description": "Contact ID (always string)"},
        "dealId": {"type": "string", "description": "Deal ID (always string)"},
        "invoiceId": {"type": "string", "description": "Invoice ID (always string)"},
        "dateRange": {
          "type": "object",
          "properties": {
            "start": {"type": "string", "format": "date"},
            "end": {"type": "string", "format": "date"}
          },
          "default": {"start": "auto_30_days_ago", "end": "auto_today"}
        }
      },
      "required": []
    }
  }
}

NOTE: Do NOT include "executionScript" field in this JSON. It will be generated separately to avoid JSON escaping issues.

**CRITICAL OUTPUT REQUIREMENTS:**
1. Return ONLY VALID JSON - NOT JavaScript object literals
2. **ALL property names MUST be quoted strings**: Use "templateId" NOT templateId
3. Return ONLY the JSON object - NO markdown code blocks, NO explanations, NO other text
4. templateId must be snake_case with no spaces or capital letters
5. estimatedSteps must be a number between 3-15
6. estimatedDuration must be a number in milliseconds (minimum 60000 for 1 minute)
7. category must be an array of strings
8. **CRITICAL**: ALL ID fields (customerId, companyId, contactId, dealId, invoiceId, etc.) MUST be type "string", NEVER "number". IDs extracted from parameters are always strings.
9. **CRITICAL**: parameterSchema.required must ALWAYS be included as an array:
   - For aggregate templates (analyze ALL customers/invoices/etc): "required": []
   - For single-entity templates (requires specific customerId/contactId/etc): "required": ["customerId"] or ["contactId"] etc.
   - This field determines whether the template requires a specific entity ID or can operate on all entities

Generate complete, production-ready template METADATA that implements the user's specific request using Bitrix24 APIs, following all patterns from the knowledge base.

RETURN ONLY STRICT JSON (property names in quotes) WITH NO FORMATTING:`;

      this.log('info', 'Generating task template metadata with AI (step 1 of 2)', {
        promptLength: prompt.length,
        knowledgeArticles: knowledgeResults.length,
        knowledgeBaseTitles: knowledgeResults.map(kb => kb.title),
        userDescription: description.substring(0, 100)
      });

      // STEP 1: Generate metadata JSON (without executionScript)
      const metadataResponse = await this.genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 8192, // Metadata only, much smaller
          temperature: 0.1 // Low temperature for precise JSON structure
        }
      });

      // Log response structure
      this.log('info', 'Gemini metadata generation response received', {
        hasCandidates: !!metadataResponse.candidates,
        candidatesCount: metadataResponse.candidates?.length,
        finishReason: metadataResponse.candidates?.[0]?.finishReason,
        usageMetadata: metadataResponse.usageMetadata
      });

      // Extract metadata JSON
      const metadataText = extractGeminiText(metadataResponse, {
        includeLogging: true,
        logger: this.log.bind(this)
      });

      this.log('info', 'AI template metadata response text', {
        responseLength: metadataText.length,
        responsePreview: metadataText.substring(0, 200)
      });

      // Extract JSON metadata from response
      let jsonMatch = metadataText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        jsonMatch = metadataText.match(/```json\s*([\s\S]*?)\s*```/) ||
                   metadataText.match(/```\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          jsonMatch[0] = jsonMatch[1];
        }
      }

      if (!jsonMatch) {
        throw new Error('No valid JSON found in AI metadata response. Response must be a valid JSON object only.');
      }

      let templateMetadata;
      try {
        templateMetadata = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        this.log('error', 'JSON parsing failed', {
          error: parseError.message,
          jsonContent: jsonMatch[0].substring(0, 1000),
          jsonLength: jsonMatch[0].length,
          errorPosition: parseError.message.match(/position (\d+)/)?.[1]
        });

        // Attempt to repair common JSON metadata issues
        let repairedJson = jsonMatch[0];

        // Fix common issues: trailing commas and unquoted property names
        try {
          // Fix unquoted property names (JavaScript object literal → JSON)
          // Match: word characters followed by colon (not inside quotes)
          repairedJson = repairedJson.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');

          // Remove trailing commas before closing brackets/braces
          repairedJson = repairedJson
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/([}\]]),\s*$/g, '$1');

          // Try parsing the repaired JSON
          templateMetadata = JSON.parse(repairedJson);

          this.log('info', 'JSON metadata repair successful', {
            originalLength: jsonMatch[0].length,
            repairedLength: repairedJson.length
          });
        } catch (repairError) {
          this.log('error', 'JSON metadata repair failed', {
            originalError: parseError.message,
            repairError: repairError.message
          });
          throw new Error(`Invalid JSON structure in AI metadata response: ${parseError.message}. Repair attempt also failed: ${repairError.message}`);
        }
      }

      if (!templateMetadata || typeof templateMetadata !== 'object') {
        throw new Error('AI metadata response must be a valid JSON object');
      }

      // STEP 2: Generate executionScript as plain JavaScript
      this.log('info', 'Generating executionScript with AI (step 2 of 2)', {
        templateId: templateMetadata.templateId,
        templateName: templateMetadata.name
      });

      const scriptPrompt = `You are generating the executionScript for a Chantilly Agent task template.

**TEMPLATE METADATA:**
${JSON.stringify(templateMetadata, null, 2)}

**USER REQUEST:**
"${description}"

**AVAILABLE PARAMETERS:**
${JSON.stringify(parameters, null, 2)}

**RELEVANT KNOWLEDGE BASE:**
${knowledgeContext}

**EXECUTION SCRIPT REQUIREMENTS:**
Generate a COMPLETE, production-ready JavaScript class that:

1. Must extend BaseTaskExecutor class
2. Must include comprehensive try/catch error handling
3. Must call this.updateProgress() regularly (every 10-20% completion)
4. Must use this.callAPI() or this.streamingFetch() for Bitrix24 API calls
5. Must generate useful HTML reports using this.generateHTMLReport()
6. Must use this.uploadReport() to save reports to cloud storage
7. Must include entity links back to Bitrix24: https://your-domain.bitrix24.com/crm/[entity]/show/[id]/
8. Must validate parameters and handle missing data gracefully
9. Must include this.checkCancellation() in long loops
10. Must use this.log() for logging instead of console.log()

**IMPORTANT:**
- Return ONLY the JavaScript class code - NO markdown code blocks, NO explanations, NO JSON
- Start with: class TaskExecutor extends BaseTaskExecutor {
- Implement complete working code that fulfills the user's request
- Include all data fetching, processing, HTML generation, and file upload
- Generate complete ChartJS visualizations if requested
- Minimum 500 characters of actual implementation code
- CRITICAL: Test your code mentally for syntax errors before returning it

**STRING SYNTAX RULES (CRITICAL - Prevents Syntax Errors):**
- NEVER use template literals (backticks with \${}) in this.log() messages
- NEVER use template literals in this.updateProgress() messages
- NEVER use template literals in throw new Error() messages
- ALWAYS use string concatenation with + operator for log messages with variables
- Examples:
  ✅ CORRECT: this.log('info', 'Processing recording ID ' + recordingId);
  ✅ CORRECT: this.updateProgress(30, 'Analyzing transcript...');
  ✅ CORRECT: throw new Error('Recording ' + recordingId + ' not found');
  ❌ WRONG: this.log('info', \`Processing recording ID \${recordingId}\`);
  ❌ WRONG: throw new Error(\`Recording \${recordingId} not found\`);

RETURN ONLY THE JAVASCRIPT CLASS CODE:`;

      const scriptResponse = await this.genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: scriptPrompt }] }],
        generationConfig: {
          maxOutputTokens: 65535, // Maximum for complex executionScript
          temperature: 0.1
        }
      });

      let executionScript = extractGeminiText(scriptResponse, {
        includeLogging: true,
        logger: this.log.bind(this)
      });

      this.log('info', 'ExecutionScript generated', {
        scriptLength: executionScript.length,
        scriptPreview: executionScript.substring(0, 200)
      });

      // Clean up markdown code blocks if present (flexible whitespace handling)
      executionScript = executionScript.trim();
      if (executionScript.startsWith('```javascript')) {
        executionScript = executionScript.replace(/^```javascript\s*[\r\n]+/, '').replace(/[\r\n]+```\s*$/, '');
      } else if (executionScript.startsWith('```js')) {
        executionScript = executionScript.replace(/^```js\s*[\r\n]+/, '').replace(/[\r\n]+```\s*$/, '');
      } else if (executionScript.startsWith('```')) {
        executionScript = executionScript.replace(/^```\s*[\r\n]+/, '').replace(/[\r\n]+```\s*$/, '');
      }
      executionScript = executionScript.trim(); // Final trim after removing fences

      this.log('info', 'Markdown code fences cleaned', {
        cleanedLength: executionScript.length,
        startsWithClass: executionScript.startsWith('class '),
        cleanedPreview: executionScript.substring(0, 100)
      });

      // Combine metadata + executionScript
      let template = {
        ...templateMetadata,
        executionScript: executionScript
      };

      if (!template || typeof template !== 'object') {
        throw new Error('AI response must be a valid template object');
      }
      
      // Validate with auto-repair using TaskTemplateLoader
      const { getTaskTemplateLoader } = require('../services/taskTemplateLoader');
      const templateLoader = getTaskTemplateLoader();

      const validation = await templateLoader.validateTemplate(template, { message: description || 'Complex task generation' });
      
      if (!validation.valid) {
        this.log('error', 'Generated template validation failed even after auto-repair', {
          templateId: template.templateId,
          errors: validation.errors,
          repairAttempts: validation.repairAttempt
        });
        throw new Error(`Generated template validation failed: ${validation.errors.join(', ')}`);
      }

      // Use the validated (possibly auto-repaired) template
      template = validation.template;

      // Start in testing mode for safe initial runs
      template.testing = true;

      // ✅ PHASE 2.3: Store generation metadata for success tracking
      template.generationMetadata = {
        generatedAt: new Date().toISOString(),
        memoryIdsUsed: usedMemoryIds,
        userRequest: description,
        generationMethod: 'ai_generated'
      };

      this.log('info', 'Task template generated successfully', {
        templateId: template.templateId,
        name: template.name,
        estimatedSteps: template.definition?.estimatedSteps,
        testing: template.testing,
        memoriesUsed: usedMemoryIds.length
      });

      return {
        success: true,
        template: template
      };

    } catch (error) {
      this.log('error', 'Task template generation failed', {
        error: error.message,
        stack: error.stack
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }


  /**
   * Create task from generated template
   * @param {Object} template - Generated template
   * @param {string} userId - User ID
   * @param {Object} parameters - Task parameters
   * @param {string} description - Task description
   * @param {string} entityScope - Entity scope for task execution (AGGREGATE | SPECIFIC_ENTITY | AUTO)
   * @returns {Object} - Task creation result
   */
  async createTaskFromGeneratedTemplate(template, userId, parameters, description = '', entityScope = 'AUTO') {
    try {
      // Log template structure for debugging
      this.log('info', 'Storing template in database', {
        templateId: template.templateId,
        templateKeys: Object.keys(template),
        hasName: !!template.name,
        hasDescription: !!template.description,
        hasDefinition: !!template.definition,
        hasExecutionScript: !!template.executionScript,
        enabled: template.enabled
      });
      
      // Ensure template has all required fields before storing
      if (!template.templateId) {
        throw new Error('Generated template missing templateId');
      }
      
      // Store the generated template in database
      const templateCreated = await this.templatesModel.createTemplate(template.templateId, template);
      
      if (!templateCreated) {
        throw new Error(`Failed to store template in database: ${template.templateId}`);
      }
      
      this.log('info', 'Generated template stored in database', {
        templateId: template.templateId,
        testing: template.testing
      });

      // Small delay to ensure template is available for retrieval
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create task from the new template
      const result = await this.orchestrator.createTaskFromTemplate(
        template.templateId,
        parameters,
        userId,
        {
          priority: 60, // Medium-high priority for agentic tasks
          testing: template.testing, // Inherit testing mode from template
          userIntent: 'CREATE_NEW_TASK', // Agentic generation always means new task
          entityScope: entityScope || 'AUTO', // Use AI-detected entity scope
          userMessage: description || 'Agentically generated task'
        }
      );

      return {
        taskId: result.taskId,
        templateId: template.templateId,
        template: template,
        testing: template.testing
      };

    } catch (error) {
      this.log('error', 'Failed to create task from generated template', {
        templateId: template.templateId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Test and debug a complex task
   * @param {Object} args - Test arguments
   * @param {string} userId - User ID
   * @param {Object} toolContext - Tool context
   * @returns {Object} - Test result
   */
  async testTask(args, userId, toolContext) {
    try {
      const { taskId, templateId, debugLevel = 'verbose', dryRun = true, sampleSize = 10 } = args;
      
      this.log('info', 'Starting task testing', {
        taskId,
        templateId,
        debugLevel,
        dryRun,
        sampleSize,
        userId
      });

      let task = null;
      
      if (taskId) {
        // Test existing task
        task = await this.taskQueueModel.getTask(taskId);
        if (!task) {
          return {
            success: false,
            message: `❌ Task with ID '${taskId}' not found.`
          };
        }
        
        if (task.userId !== userId) {
          return {
            success: false,
            message: '❌ You can only test your own tasks.'
          };
        }
        
      } else if (templateId) {
        // Test template by creating a test task
        const template = await this.templatesModel.getTemplate(templateId);
        if (!template) {
          return {
            success: false,
            message: `❌ Template with ID '${templateId}' not found.`
          };
        }

        // Create test task
        const testResult = await this.orchestrator.createTaskFromTemplate(
          templateId,
          { ...args.parameters, __test_mode: true, __sample_size: sampleSize },
          userId,
          {
            priority: 90,
            testing: true,
            dryRun: dryRun,
            userIntent: 'REUSE_EXISTING_TEMPLATE', // Test action always reuses template
            entityScope: 'AUTO', // Let system decide based on template
            userMessage: args.description || 'Test execution'
          }
        );
        
        task = await this.taskQueueModel.getTask(testResult.taskId);
        
      } else {
        return {
          success: false,
          message: '❌ Either taskId or templateId is required for testing.'
        };
      }

      // Analyze task for potential issues
      const analysis = await this.analyzeTaskForTesting(task, debugLevel);
      
      // Generate debugging recommendations
      const recommendations = this.generateDebuggingRecommendations(task, analysis);
      
      const testReport = this.generateTestReport(task, analysis, recommendations, debugLevel);
      
      return {
        success: true,
        message: testReport,
        task: {
          id: task.taskId,
          status: task.status,
          testing: task.testing || false
        },
        analysis: analysis,
        recommendations: recommendations
      };

    } catch (error) {
      this.log('error', 'Task testing failed', {
        error: error.message,
        stack: error.stack
      });
      
      return {
        success: false,
        message: `❌ Testing failed: ${error.message}`
      };
    }
  }

  /**
   * Analyze task for testing and debugging
   * @param {Object} task - Task object
   * @param {string} debugLevel - Debug detail level
   * @returns {Object} - Analysis results
   */
  async analyzeTaskForTesting(task, debugLevel) {
    const analysis = {
      structure: this.analyzeTaskStructure(task),
      parameters: this.analyzeTaskParameters(task),
      executionScript: this.analyzeExecutionScript(task),
      dependencies: this.analyzeTaskDependencies(task),
      riskFactors: []
    };
    
    // Identify potential issues
    if (!task.testing) {
      analysis.riskFactors.push('Task not in testing mode - will run with full production data');
    }
    
    if (!task.template?.definition?.parameterSchema) {
      analysis.riskFactors.push('No parameter schema defined - may cause validation issues');
    }
    
    if (task.template?.definition?.estimatedDuration > 1800000) { // 30 minutes
      analysis.riskFactors.push('Long execution time - consider breaking into smaller tasks');
    }
    
    return analysis;
  }

  /**
   * Analyze task structure
   */
  analyzeTaskStructure(task) {
    return {
      hasTemplate: !!task.template,
      hasExecutionScript: !!(task.template?.executionScript),
      hasParameters: !!(task.parameters && Object.keys(task.parameters).length > 0),
      estimatedSteps: task.template?.definition?.estimatedSteps || 0,
      estimatedDuration: task.template?.definition?.estimatedDuration || 0
    };
  }

  /**
   * Analyze task parameters
   */
  analyzeTaskParameters(task) {
    const params = task.parameters || {};
    return {
      parameterCount: Object.keys(params).length,
      hasDateRange: !!(params.dateRange?.start && params.dateRange?.end),
      hasTestMode: !!params.__test_mode,
      sampleSize: params.__sample_size || null,
      missingRequired: this.findMissingRequiredParameters(task)
    };
  }

  /**
   * Analyze execution script
   */
  analyzeExecutionScript(task) {
    const script = task.template?.executionScript || '';
    return {
      length: script.length,
      extendsBaseTaskExecutor: script.includes('BaseTaskExecutor'),
      hasExecuteMethod: script.includes('async execute()'),
      hasErrorHandling: script.includes('try') && script.includes('catch'),
      hasProgressTracking: script.includes('updateProgress'),
      hasApiCalls: script.includes('callAPI') || script.includes('streamingFetch'),
      hasReportGeneration: script.includes('generateHTMLReport') || script.includes('uploadReport')
    };
  }

  /**
   * Analyze task dependencies
   */
  analyzeTaskDependencies(task) {
    const services = task.template?.definition?.requiredServices || [];
    return {
      requiredServices: services,
      requiresQueue: services.includes('queueService'),
      requiresStorage: services.includes('fileStorage'),
      requiresDatabase: services.includes('database'),
      memoryRequirement: task.template?.definition?.memoryRequirement || 'unknown'
    };
  }

  /**
   * Find missing required parameters
   */
  findMissingRequiredParameters(task) {
    const schema = task.template?.definition?.parameterSchema;
    if (!schema || !schema.required) {
      return [];
    }
    
    const provided = Object.keys(task.parameters || {});
    return schema.required.filter(req => !provided.includes(req));
  }

  /**
   * Generate debugging recommendations
   */
  generateDebuggingRecommendations(task, analysis) {
    const recommendations = [];
    
    if (!analysis.structure.hasExecutionScript) {
      recommendations.push({
        type: 'critical',
        message: 'Missing execution script - task cannot run',
        action: 'Add executionScript extending BaseTaskExecutor'
      });
    }
    
    if (!analysis.executionScript.extendsBaseTaskExecutor) {
      recommendations.push({
        type: 'critical',
        message: 'Execution script must extend BaseTaskExecutor',
        action: 'Update class declaration: class TaskExecutor extends BaseTaskExecutor'
      });
    }
    
    if (!analysis.executionScript.hasErrorHandling) {
      recommendations.push({
        type: 'high',
        message: 'Missing error handling in execution script',
        action: 'Add try/catch blocks around main execution logic'
      });
    }
    
    if (!analysis.executionScript.hasProgressTracking) {
      recommendations.push({
        type: 'medium',
        message: 'No progress tracking found',
        action: 'Add this.updateProgress() calls throughout execution'
      });
    }
    
    if (analysis.parameters.missingRequired.length > 0) {
      recommendations.push({
        type: 'high',
        message: `Missing required parameters: ${analysis.parameters.missingRequired.join(', ')}`,
        action: 'Provide missing parameters or update parameter schema'
      });
    }
    
    if (!task.testing) {
      recommendations.push({
        type: 'warning',
        message: 'Task not in testing mode',
        action: 'Enable testing mode for safe development and debugging'
      });
    }
    
    return recommendations;
  }

  /**
   * Generate comprehensive test report
   */
  generateTestReport(task, analysis, recommendations, debugLevel) {
    let report = '🧪 **Task Testing Report**\n\n';
    
    report += '**Task Information:**\n';
    report += `- **ID:** \`${task.taskId}\`\n`;
    report += `- **Template:** ${task.template?.name || 'Unknown'}\n`;
    report += `- **Status:** ${task.status}\n`;
    report += `- **Testing Mode:** ${task.testing ? '✅ Enabled' : '❌ Disabled'}\n`;
    report += `- **Created:** ${this.formatTimestamp(task.createdAt)}\n\n`;
    
    report += '**Structure Analysis:**\n';
    report += `- **Template:** ${analysis.structure.hasTemplate ? '✅' : '❌'}\n`;
    report += `- **Execution Script:** ${analysis.structure.hasExecutionScript ? '✅' : '❌'}\n`;
    report += `- **Parameters:** ${analysis.structure.hasParameters ? '✅' : '❌'}\n`;
    report += `- **Estimated Steps:** ${analysis.structure.estimatedSteps}\n`;
    report += `- **Estimated Duration:** ${this.formatDuration(analysis.structure.estimatedDuration)}\n\n`;
    
    if (debugLevel === 'verbose' || debugLevel === 'detailed') {
      report += '**Execution Script Analysis:**\n';
      report += `- **Extends BaseTaskExecutor:** ${analysis.executionScript.extendsBaseTaskExecutor ? '✅' : '❌'}\n`;
      report += `- **Has execute() method:** ${analysis.executionScript.hasExecuteMethod ? '✅' : '❌'}\n`;
      report += `- **Error Handling:** ${analysis.executionScript.hasErrorHandling ? '✅' : '❌'}\n`;
      report += `- **Progress Tracking:** ${analysis.executionScript.hasProgressTracking ? '✅' : '❌'}\n`;
      report += `- **API Calls:** ${analysis.executionScript.hasApiCalls ? '✅' : '❌'}\n`;
      report += `- **Report Generation:** ${analysis.executionScript.hasReportGeneration ? '✅' : '❌'}\n`;
      report += `- **Script Length:** ${analysis.executionScript.length} characters\n\n`;
    }
    
    if (recommendations.length > 0) {
      report += '**🔧 Recommendations:**\n';
      recommendations.forEach((rec, index) => {
        const icon = rec.type === 'critical' ? '🚨' : rec.type === 'high' ? '⚠️' : rec.type === 'medium' ? '💡' : 'ℹ️';
        report += `${index + 1}. ${icon} **${rec.type.toUpperCase()}:** ${rec.message}\n`;
        report += `   *Action:* ${rec.action}\n\n`;
      });
    } else {
      report += '**✅ All Checks Passed**\n\nYour task looks ready for execution!\n\n';
    }
    
    if (debugLevel === 'detailed') {
      report += '**Dependencies:**\n';
      report += `- **Required Services:** ${analysis.dependencies.requiredServices.join(', ') || 'None'}\n`;
      report += `- **Memory Requirement:** ${analysis.dependencies.memoryRequirement}\n\n`;
      
      if (analysis.parameters.parameterCount > 0) {
        report += `**Parameters (${analysis.parameters.parameterCount}):**\n`;
        Object.entries(task.parameters || {}).forEach(([key, value]) => {
          const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
          report += `- **${key}:** \`${valueStr.substring(0, 50)}${valueStr.length > 50 ? '...' : ''}\`\n`;
        });
        report += '\n';
      }
    }
    
    report += '**Next Steps:**\n';
    if (task.testing) {
      report += '1. Review and address any critical recommendations above\n';
      report += '2. Run the task in testing mode to verify functionality\n';
      report += '3. Use `test` action again to re-analyze after changes\n';
      report += '4. When satisfied, disable testing mode for production run\n';
    } else {
      report += '1. Consider enabling testing mode for safer development\n';
      report += '2. Address any recommendations above before production run\n';
      report += '3. Monitor task execution closely when running in production\n';
    }
    
    return report;
  }

  /**
   * Generate proactive suggestions for next steps after task creation
   * @param {Object} taskResult - Task creation result
   * @param {Object} template - Generated template
   * @returns {string} - Formatted suggestions message
   */
  async generateNextStepSuggestions(taskResult, template) {
    // Check current task status to determine if it's already executing
    let currentTask = null;
    let isAutoExecuted = false;
    
    try {
      currentTask = await this.taskQueueModel.getTask(taskResult.taskId);
      // Task is auto-executed if it has cloudTaskName, is queued, or is running
      isAutoExecuted = !!(currentTask?.execution?.cloudTaskName || 
                         currentTask?.status === 'queued' || 
                         currentTask?.status === 'running');
    } catch (error) {
      this.log('warn', 'Could not check task status for suggestions', { 
        taskId: taskResult.taskId, 
        error: error.message 
      });
    }

    const suggestions = [];
    
    if (isAutoExecuted) {
      // Task is already executing - show monitoring and management options
      suggestions.push({
        action: 'monitor',
        emoji: '📊',
        title: 'Monitor Progress',
        description: 'Check current execution status and progress',
        command: `"Check status of task ${taskResult.taskId}"`
      });

      suggestions.push({
        action: 'cancel',
        emoji: '🛑',
        title: 'Cancel Execution',
        description: 'Stop the task if needed (only while pending/running)',
        command: `"Cancel task ${taskResult.taskId}"`
      });
    } else {
      // Task is not auto-executing - show test and execute options
      if (taskResult.testing) {
        suggestions.push({
          action: 'test',
          emoji: '🧪',
          title: 'Test Further',
          description: 'Run detailed testing to validate and debug the execution script',
          command: `"Run detailed test on task ${taskResult.taskId}"`
        });
      }

      suggestions.push({
        action: 'execute', 
        emoji: '🚀',
        title: 'Execute Task',
        description: taskResult.testing ? 
          'Execute with real data after testing is complete' : 
          'Execute the task with full production data now',
        command: `"Execute complex task ${taskResult.taskId}"`
      });
    }

    // Always suggest modification option
    suggestions.push({
      action: 'modify',
      emoji: '✏️', 
      title: 'Modify Template',
      description: 'Update task parameters, execution script, or configuration',
      command: `"Update task template ${taskResult.templateId}"`
    });

    // Build the suggestion message
    let message = '## 🎯 **What would you like to do next?**\n\n';
    
    suggestions.forEach((suggestion, index) => {
      message += `**${index + 1}. ${suggestion.emoji} ${suggestion.title}**\n`;
      message += `   ${suggestion.description}\n`;
      message += `   *Say: ${suggestion.command}*\n\n`;
    });

    // Add context based on execution status
    if (isAutoExecuted) {
      const status = currentTask?.status || 'queued';
      message += `⏳ **Task Status:** Your task is currently **${status}** and executing automatically.\n\n`;
      message += '💡 **Recommendation:** Monitor progress and wait for completion, or cancel if changes are needed.\n\n';
    } else {
      // Add helpful context for non-executing tasks
      if (taskResult.testing) {
        message += '💡 **Recommendation:** Start with testing to ensure the task works correctly before full execution.\n\n';
      } else {
        message += '💡 **Recommendation:** This task is ready for immediate execution, but you can test first if preferred.\n\n';
      }
    }

    // Add status monitoring info
    message += `📊 **Monitor Progress:** Use "task status ${taskResult.taskId}" to check execution progress anytime.`;

    return message;
  }

  /**
   * Check if a message is a confirmation
   * @param {string} message - User message
   * @returns {boolean} - Whether this is a confirmation
   */
  isConfirmationMessage(message) {
    if (!message || typeof message !== 'string') {return false;}
    
    const confirmationPatterns = [
      /^yes$/i,
      /^yes\s*$/i,
      /^y$/i,
      /^ok$/i,
      /^okay$/i,
      /^sure$/i,
      /^go\s+ahead$/i,
      /^do\s+it$/i,
      /^proceed$/i,
      /^continue$/i,
      /^start$/i,
      /^run\s+it$/i,
      /^execute$/i,
      /^let['']?s\s+do\s+it$/i,
      /^sounds?\s+good$/i,
      /^that.*sounds?\s+good$/i,
      /^perfect$/i,
      /^exactly$/i,
      /^correct$/i,
      /^use.*that.*template$/i,
      /^use.*that.*one$/i
    ];
    
    return confirmationPatterns.some(pattern => pattern.test(message.trim()));
  }

  /**
   * Extract context from conversation history to understand what's being confirmed
   * @param {Object} toolContext - Tool execution context
   * @returns {Object|null} - Confirmation context
   */
  async extractConfirmationContext(toolContext) {
    try {
      // Look for template suggestions in conversation history
      const conversationContext = toolContext?.conversationContext;
      if (!conversationContext?.content) {return null;}

      // Look for the most recent Chantilly message that might contain template suggestions
      const messages = conversationContext.content.reverse(); // Most recent first
      
      for (const message of messages) {
        if (message.role === 'assistant' && message.content) {
          const content = message.content;
          
          // Look for template ID patterns in Chantilly's response
          const templateIdMatch = content.match(/template.*?([a-z_]+_report|[a-z_]+_analysis)/i);
          if (templateIdMatch) {
            return {
              templateId: templateIdMatch[1],
              description: this.extractDescriptionFromSuggestion(content),
              taskType: 'template_execution'
            };
          }
          
          // Look for report type suggestions
          const reportTypeMatch = content.match(/(invoice.*report|sales.*analysis|product.*analysis)/i);
          if (reportTypeMatch) {
            return {
              templateId: null,
              description: `Generate ${reportTypeMatch[1]}`,
              taskType: 'report_generation'
            };
          }
        }
      }
      
      return null;
    } catch (error) {
      this.log('warn', 'Failed to extract confirmation context', { error: error.message });
      return null;
    }
  }

  /**
   * Extract description from template suggestion
   * @param {string} content - Chantilly's suggestion content
   * @returns {string} - Extracted description
   */
  extractDescriptionFromSuggestion(content) {
    // Look for descriptions in quotes or after "report"
    const descriptionMatch = content.match(/"([^"]+)"|report[:\s]+([^.!?]+)/i);
    if (descriptionMatch) {
      return descriptionMatch[1] || descriptionMatch[2];
    }
    
    // Fallback: extract first sentence that mentions report/analysis
    const sentenceMatch = content.match(/([^.!?]*(?:report|analysis)[^.!?]*)/i);
    return sentenceMatch ? sentenceMatch[1].trim() : 'Generate requested report';
  }

  /**
   * Modify existing task template
   * @param {Object} args - Tool arguments
   * @param {string} userId - User ID
   * @param {Object} toolContext - Tool execution context
   * @returns {Object} - Modification result
   */
  async modifyTask(args, userId, toolContext) {
    try {
      let { templateId, taskId, modifications, description, modificationType, modificationScope } = args;
      const userMessage = toolContext?.messageData?.message || description || '';

      // INTENT DETECTION: Use AI-detected modification intent from parameters
      const modType = modificationType || 'MINOR_TWEAK';
      const modScope = modificationScope || 'PARAMETERS';

      const modificationIntent = {
        // Type of change (from AI-detected parameter)
        isMinorTweak: modType === 'MINOR_TWEAK',
        isMajorOverhaul: modType === 'MAJOR_OVERHAUL',
        isBugFix: modType === 'BUG_FIX',
        wantsCompleteRestart: modType === 'COMPLETE_RESTART',
        wantsDifferentTemplate: modType === 'DIFFERENT_TEMPLATE',

        // Scope of change (from AI-detected parameter)
        isParameterChange: modScope === 'PARAMETERS',
        isOutputChange: modScope === 'OUTPUT_FORMAT',
        isLogicChange: modScope === 'LOGIC',
        isDataSourceChange: modScope === 'DATA_SOURCE',
        isMultipleChanges: modScope === 'MULTIPLE',

        // Store AI-detected values for context
        modificationType: modType,
        modificationScope: modScope,
        originalUserMessage: userMessage
      };

      this.log('info', 'Modification intent detected via AI parameters', {
        intent: modificationIntent,
        userId,
        userMessage: userMessage.substring(0, 100),
        aiDetectedType: modType,
        aiDetectedScope: modScope
      });

      // If user wants complete restart or different template, skip modification and create new task
      if (modificationIntent.wantsCompleteRestart || modificationIntent.wantsDifferentTemplate) {
        this.log('info', 'User wants complete restart, redirecting to task creation instead of modification', {
          userId,
          reason: modificationIntent.wantsCompleteRestart ? 'restart' : 'different_template',
          aiDetectedType: modType
        });

        return {
          success: false,
          message: '⚠️ It sounds like you want to create a completely new task rather than modify an existing one. Please use "create task" action instead, or clarify if you want to modify the existing task.',
          recommendation: 'use_create_action',
          detectedIntent: modificationIntent
        };
      }

      // Handle contextual references like "the task you just made", "that template"
      if (!templateId && !taskId) {
        const contextualReferences = [
          /(?:the|that|this)\s+(?:task|template|complex task|report).*(?:you just|just|recently|latest)/i,
          /(?:the|that|this)\s+(?:last|recent|latest)\s+(?:task|template|one)/i,
          /(?:modify|update|change|fix)\s+(?:the|that|this|it)/i
        ];

        const hasContextualReference = contextualReferences.some(pattern => pattern.test(userMessage));

        if (hasContextualReference) {
          this.log('info', 'Detected contextual reference, finding most recent task/template', {
            userMessage: userMessage.substring(0, 100),
            userId
          });

          // Find the most recently created task by this user
          const recentTasks = await this.taskQueueModel.getUserTasks(userId, ['pending', 'running', 'queued', 'completed'], 1);

          if (recentTasks.length > 0) {
            taskId = recentTasks[0].taskId;
            this.log('info', 'Resolved contextual reference to recent task', {
              taskId,
              templateId: recentTasks[0].templateId,
              createdAt: recentTasks[0].createdAt,
              detectedIntent: modificationIntent
            });
          } else {
            return {
              success: false,
              message: '❌ I couldn\'t find a recent task to modify. Please specify the task ID or template ID explicitly.'
            };
          }
        } else {
          return {
            success: false,
            message: '❌ Either templateId or taskId is required for modification.'
          };
        }
      }

      let targetTemplateId = templateId;
      
      // If taskId provided, get template from task
      if (taskId && !templateId) {
        const task = await this.taskQueueModel.getTask(taskId);
        if (!task) {
          return {
            success: false,
            message: `❌ Task not found: ${taskId}`
          };
        }
        targetTemplateId = task.templateId;
      }

      // Load existing template
      const existingTemplate = await this.templatesModel.getTemplate(targetTemplateId);
      if (!existingTemplate) {
        return {
          success: false,
          message: `❌ Template not found: ${targetTemplateId}`
        };
      }

      this.log('info', 'Modifying existing template', {
        templateId: targetTemplateId,
        userMessage: userMessage.substring(0, 100),
        modifications: modifications ? Object.keys(modifications) : 'ai-generated'
      });

      // Use AI to generate modifications based on user request
      const modifiedTemplate = await this.generateTemplateModifications(
        existingTemplate,
        userMessage,
        modifications,
        modificationIntent, // Pass AI-detected intent for context
        toolContext
      );

      if (!modifiedTemplate) {
        return {
          success: false,
          message: '❌ Failed to generate template modifications. Please provide more specific modification requirements.'
        };
      }

      // Validate the modified template with auto-repair
      const templateLoader = require('../services/taskTemplateLoader').getTaskTemplateLoader();
      const validation = await templateLoader.validateTemplate(modifiedTemplate, { message: userMessage });
      
      if (!validation.valid) {
        this.log('error', 'Modified template validation failed', {
          templateId: targetTemplateId,
          errors: validation.errors,
          repairAttempts: validation.repairAttempt
        });
        
        return {
          success: false,
          message: `❌ Template modifications failed validation: ${validation.errors.join(', ')}`
        };
      }

      // Use the validated (possibly auto-repaired) template
      const finalTemplate = validation.template;

      // Update template in database
      const updateData = {
        name: finalTemplate.name,
        description: finalTemplate.description,
        definition: finalTemplate.definition,
        executionScript: finalTemplate.executionScript,
        updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        lastModified: new Date().toISOString(),
        modifiedBy: userId,
        version: (existingTemplate.version || 1) + 0.1 // Increment version
      };

      await this.templatesModel.updateTemplate(targetTemplateId, updateData);

      this.log('info', 'Template modification completed', {
        templateId: targetTemplateId,
        wasAutoRepaired: validation.repairAttempt > 0,
        newVersion: updateData.version
      });

      // Generate success response with next steps
      const nextStepsMessage = this.generateModificationNextSteps(finalTemplate, taskId);

      return {
        success: true,
        message: `✅ **Template Modified Successfully!**

📝 **Template:** ${finalTemplate.name}
🆔 **ID:** ${targetTemplateId}
📦 **Version:** ${updateData.version}
${validation.repairAttempt > 0 ? '🔧 **Auto-repaired:** Fixed validation issues automatically\n' : ''}

**Key Changes:**
${this.summarizeTemplateChanges(existingTemplate, finalTemplate)}

${nextStepsMessage}`,
        template: {
          templateId: targetTemplateId,
          name: finalTemplate.name,
          version: updateData.version,
          testing: finalTemplate.testing || false
        }
      };

    } catch (error) {
      this.log('error', 'Template modification failed', {
        templateId: args.templateId,
        taskId: args.taskId,
        error: error.message,
        stack: error.stack
      });
      
      return {
        success: false,
        message: `❌ Modification failed: ${error.message}`
      };
    }
  }

  /**
   * Generate template modifications using AI
   * @param {Object} existingTemplate - Current template
   * @param {string} userMessage - User's modification request
   * @param {Object} explicitModifications - Explicit modifications if provided
   * @param {Object} toolContext - Tool context
   * @returns {Object} - Modified template
   */
  async generateTemplateModifications(existingTemplate, userMessage, explicitModifications, modificationIntent, toolContext) {
    try {
      // Security: Sanitize user input before using in prompts
      const sanitizedMessage = this.sanitizer.sanitizeUserInput(userMessage, 'task_description');
      if (sanitizedMessage !== userMessage) {
        this.log('warn', 'Prompt injection attempt detected in modification request', {
          originalLength: userMessage.length,
          sanitizedLength: sanitizedMessage.length
        });
      }

      // If explicit modifications provided, apply them directly
      if (explicitModifications && Object.keys(explicitModifications).length > 0) {
        return {
          ...existingTemplate,
          ...explicitModifications,
          updatedAt: new Date().toISOString()
        };
      }

      // Use AI to understand and implement modifications
      const { GoogleGenAI } = require('@google/genai');
      const config = require('../config/env');
      const genAI = new GoogleGenAI({
        apiKey: config.GEMINI_API_KEY,
        requestOptions: {
          timeout: 900000 // 15 minutes for complex modifications
        }
      });

      // Format AI-detected intent for prompt
      const intentContext = modificationIntent ? `
DETECTED MODIFICATION INTENT (from AI analysis):
- Type: ${modificationIntent.modificationType} (${
  modificationIntent.isMinorTweak ? 'small tweaks/adjustments' :
    modificationIntent.isMajorOverhaul ? 'major redesign/complete redo' :
      modificationIntent.isBugFix ? 'fix errors/bugs' : 'other changes'
})
- Scope: ${modificationIntent.modificationScope} (${
  modificationIntent.isParameterChange ? 'change parameter values' :
    modificationIntent.isOutputChange ? 'modify output format' :
      modificationIntent.isLogicChange ? 'change logic/algorithm' :
        modificationIntent.isDataSourceChange ? 'use different data sources' :
          modificationIntent.isMultipleChanges ? 'multiple areas' : 'focused change'
})` : '';

      // ✅ PHASE 2.2: Retrieve memories about similar modifications
      let modificationMemoryContext = '';
      let usedMemoryIds = [];

      if (config.REASONING_MEMORY_ENABLED) {
        try {
          const embeddingService = require('../services/embeddingService');
          const { getReasoningMemoryModel } = require('../models/reasoningMemory');
          const memoryModel = getReasoningMemoryModel();

          const queryText = `Modifying template: ${existingTemplate.name}. User request: ${sanitizedMessage}`;
          const queryEmbedding = await embeddingService.embedQuery(queryText, 'RETRIEVAL_QUERY');

          // Focus on fix_strategy and generation_pattern for modifications
          const memories = await memoryModel.retrieveMemories(queryEmbedding, 3, {
            minSuccessRate: 0.6  // Slightly lower threshold for modification guidance
          });

          if (memories && memories.length > 0) {
            usedMemoryIds = memories.map(m => m.id);

            modificationMemoryContext = `
**PROVEN MODIFICATION PATTERNS:**
${memories.map((m, i) => `${i + 1}. ${m.title} (${((m.successRate || 0) * 100).toFixed(0)}% success)
   ${m.content}`).join('\n')}

Apply these proven strategies when making modifications.
`;

            this.log('info', 'Retrieved memories for template modification', {
              templateId: existingTemplate.templateId,
              memoryCount: memories.length,
              avgSuccessRate: (memories.reduce((sum, m) => sum + (m.successRate || 0), 0) / memories.length).toFixed(2)
            });
          }
        } catch (memoryError) {
          // Don't fail modification if memory retrieval fails
          this.log('warn', 'Failed to retrieve memories for modification', {
            error: memoryError.message
          });
        }
      }

      const modificationPrompt = `You are a template modification specialist. Modify the existing task template based on the user's request.

USER REQUEST: "${sanitizedMessage}"
${intentContext}

${modificationMemoryContext}

EXISTING TEMPLATE:
- Name: ${existingTemplate.name}
- Description: ${existingTemplate.description}
- Execution Script Length: ${existingTemplate.executionScript?.length || 0} characters

EXISTING EXECUTION SCRIPT:
\`\`\`javascript
${existingTemplate.executionScript}
\`\`\`

MODIFICATION INSTRUCTIONS:
1. Follow the detected modification intent above - ${modificationIntent?.modificationType || 'MINOR_TWEAK'} in ${modificationIntent?.modificationScope || 'PARAMETERS'} scope
2. Keep all existing functionality unless explicitly asked to change it
3. Maintain the same class structure extending BaseTaskExecutor
4. MUST include all mandatory methods: updateProgress(), callAPI(), generateHTMLReport()
5. Use this.log() for all logging instead of logger directly
6. Make surgical changes matching the intent scope - only modify what the user requested

RETURN FORMAT: Return a JSON object with the complete modified template:
{
  "templateId": "${existingTemplate.templateId}",
  "name": "Updated name if changed",
  "description": "Updated description if changed", 
  "definition": { /* existing definition with any updates */ },
  "executionScript": "/* complete updated JavaScript code */"
}

Focus on the user's specific request and maintain all existing critical functionality.`;

      const response = await genAI.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: modificationPrompt }] }],
        generationConfig: {
          maxOutputTokens: 65535,
          temperature: 0.1
        }
      });

      // Use centralized response extraction with detailed logging
      const responseText = extractGeminiText(response, {
        includeLogging: true,
        logger: this.log.bind(this)
      });

      this.log('debug', 'Template modification response combined', {
        responseLength: responseText.length
      });

      // Parse JSON response
      let modifiedTemplate;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in AI response');
        }
        modifiedTemplate = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        this.log('error', 'Failed to parse AI modification response', {
          response: responseText.substring(0, 500),
          error: parseError.message
        });
        return null;
      }

      // Merge with existing template data
      const result = {
        ...existingTemplate,
        ...modifiedTemplate,
        templateId: existingTemplate.templateId, // Preserve original ID
        testing: existingTemplate.testing, // Preserve testing mode
        enabled: existingTemplate.enabled // Preserve enabled state
      };

      this.log('info', 'AI template modification generated', {
        templateId: existingTemplate.templateId,
        originalScriptLength: existingTemplate.executionScript?.length || 0,
        modifiedScriptLength: result.executionScript?.length || 0
      });

      return result;

    } catch (error) {
      this.log('error', 'AI template modification failed', {
        templateId: existingTemplate.templateId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Summarize changes made to template
   * @param {Object} oldTemplate - Original template
   * @param {Object} newTemplate - Modified template
   * @returns {string} - Summary of changes
   */
  summarizeTemplateChanges(oldTemplate, newTemplate) {
    const changes = [];

    if (oldTemplate.name !== newTemplate.name) {
      changes.push(`- **Name:** "${oldTemplate.name}" → "${newTemplate.name}"`);
    }

    if (oldTemplate.description !== newTemplate.description) {
      changes.push('- **Description:** Updated');
    }

    if (oldTemplate.executionScript !== newTemplate.executionScript) {
      const oldLength = oldTemplate.executionScript?.length || 0;
      const newLength = newTemplate.executionScript?.length || 0;
      const sizeDiff = newLength - oldLength;
      changes.push(`- **Execution Script:** Modified (${sizeDiff > 0 ? '+' : ''}${sizeDiff} characters)`);
    }

    if (JSON.stringify(oldTemplate.definition) !== JSON.stringify(newTemplate.definition)) {
      changes.push('- **Configuration:** Updated parameters or settings');
    }

    return changes.length > 0 ? changes.join('\n') : '- Minor updates and improvements';
  }

  /**
   * Generate next steps after modification
   * @param {Object} template - Modified template
   * @param {string} taskId - Optional task ID if modifying from task
   * @returns {string} - Next steps message
   */
  generateModificationNextSteps(template, taskId = null) {
    let message = '\n## 🎯 **Next Steps:**\n\n';
    
    message += '**1. 🧪 Test Changes**\n';
    message += '   Verify modifications work correctly\n';
    message += `   *Say: "Test template ${template.templateId}"*\n\n`;
    
    if (taskId) {
      message += '**2. 🔄 Update Existing Task**\n';
      message += '   Apply changes to your current task\n';
      message += `   *Say: "Update task ${taskId} with latest template"*\n\n`;
    }
    
    message += '**3. 🚀 Create New Task**\n';
    message += '   Create a new task with the updated template\n';
    message += `   *Say: "Create task from template ${template.templateId}"*\n\n`;
    
    message += '💡 **Tip:** Always test template changes before running with production data.';
    
    return message;
  }

  /**
   * Get auto-repair status for tasks
   * @param {Object} args - Tool arguments
   * @param {string} userId - User ID
   * @returns {Object} - Auto-repair status result
   */
  async getAutoRepairStatus(args, userId) {
    try {
      const { taskId, templateId, includeHistory = false } = args;

      if (taskId) {
        // Get specific task auto-repair info
        const task = await this.taskQueueModel.getTask(taskId);
        if (!task) {
          return {
            success: false,
            message: `❌ Task not found: ${taskId}`
          };
        }

        // Check if task was auto-repaired
        const hasAutoRepairInfo = task.autoRepairInfo || task.autoRepairRetryInfo;
        if (!hasAutoRepairInfo) {
          return {
            success: true,
            message: `📋 **Task ${taskId}**\n\n✅ No auto-repairs needed - task executed successfully without errors.`,
            autoRepaired: false
          };
        }

        let statusMessage = `📋 **Task Auto-Repair Status: ${taskId}**\n\n`;
        
        if (task.status === 'auto_repaired' || task.status === 'auto_repaired_retrying') {
          statusMessage += '🔧 **Auto-Repair Applied**\n';
          statusMessage += `   Original Error: ${task.autoRepairInfo?.originalError?.type} - ${task.autoRepairInfo?.originalError?.message}\n`;
          statusMessage += `   Repair Attempt: ${task.autoRepairInfo?.repairAttempt || 1}\n`;
          statusMessage += `   Repaired At: ${task.autoRepairInfo?.timestamp}\n\n`;

          if (task.retryTaskId) {
            statusMessage += `🔄 **Retry Task Created**: ${task.retryTaskId}\n`;
            statusMessage += '   Status: Currently running with fixed template\n\n';
          }
        }

        return {
          success: true,
          message: statusMessage,
          autoRepaired: true,
          task: {
            id: taskId,
            status: task.status,
            autoRepairInfo: task.autoRepairInfo,
            retryTaskId: task.retryTaskId
          }
        };

      } else if (templateId) {
        // Get template auto-repair history
        const template = await this.templatesModel.getTemplate(templateId);
        if (!template) {
          return {
            success: false,
            message: `❌ Template not found: ${templateId}`
          };
        }

        let statusMessage = `📋 **Template Auto-Repair Status: ${template.name}**\n\n`;
        
        if (template.repairAttempts && template.repairAttempts > 0) {
          statusMessage += `🔧 **Auto-Repairs Applied**: ${template.repairAttempts}\n`;
          statusMessage += `   Last Repair: ${template.lastRepaired}\n`;
          statusMessage += `   Last Repair Reason: ${template.lastRepairReason}\n\n`;

          if (includeHistory && template.autoRepairHistory) {
            statusMessage += '📊 **Repair History**:\n';
            template.autoRepairHistory.forEach((repair, index) => {
              statusMessage += `   ${index + 1}. ${repair.errorType} (${repair.timestamp})\n`;
              statusMessage += `      Error: ${repair.errorMessage}\n`;
              statusMessage += `      Step: ${repair.errorStep}\n\n`;
            });
          }
        } else {
          statusMessage += '✅ No auto-repairs needed - template executes successfully without errors.';
        }

        return {
          success: true,
          message: statusMessage,
          template: {
            id: templateId,
            name: template.name,
            repairAttempts: template.repairAttempts || 0,
            lastRepaired: template.lastRepaired,
            autoRepairHistory: template.autoRepairHistory || []
          }
        };

      } else {
        return {
          success: false,
          message: '❌ Either taskId or templateId is required to check auto-repair status.'
        };
      }

    } catch (error) {
      this.log('error', 'Failed to get auto-repair status', {
        taskId: args.taskId,
        templateId: args.templateId,
        error: error.message
      });

      return {
        success: false,
        message: `❌ Failed to get auto-repair status: ${error.message}`
      };
    }
  }
}

module.exports = ComplexTaskManagerTool;