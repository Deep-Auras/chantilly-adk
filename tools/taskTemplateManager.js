const BaseTool = require('../lib/baseTool');
const { getTaskTemplatesModel } = require('../models/taskTemplates');
const { logger } = require('../utils/logger');
const { getGeminiClient, extractGeminiText } = require('../config/gemini');
const { getConfigManager } = require('../services/dashboard/configManager');

/**
 * TaskTemplateManager - Manages task template definitions
 *
 * This tool handles CRUD operations for task templates, including:
 * - Viewing template definitions
 * - Modifying template code and configuration
 * - Enabling/disabling templates
 * - Toggling testing mode
 * - Deleting templates
 *
 * This is an ADMIN-facing tool for managing template definitions,
 * NOT for creating or executing tasks (use ComplexTaskManager for that).
 */
class TaskTemplateManagerTool extends BaseTool {
  constructor(context) {
    super(context);

    this.name = 'TaskTemplateManager';
    this.description = 'Manage task template definitions - view, modify, enable/disable, or delete templates. Use this when user wants to UPDATE/MODIFY/CHANGE the definition or code of an existing report/analysis template. NOT for creating new tasks or running reports.\n\nIMPORTANT FOR CODE MODIFICATIONS: When modifying executionScript, ALWAYS use templateUpdates.modificationRequest with a description of changes instead of providing the full script. The tool will fetch current code and generate intelligent targeted modifications.';
    this.userDescription = 'Manage task template definitions and configurations';
    this.category = 'admin';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent System';
    this.priority = 60; // Medium priority - admin operations, less common than task creation

    // Define parameters for the tool
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'view', 'modify', 'delete', 'toggle_testing', 'toggle_enabled'],
          description: 'CONCEPTUAL: What does user want to DO with template definitions? Use LIST when user wants to SEE all templates. Use VIEW when user wants to EXAMINE one template in detail. Use MODIFY when user wants to CHANGE template code/config (requires updates). Use DELETE when user wants to REMOVE template permanently. Use TOGGLE_TESTING when user wants to SWITCH between testing/production mode. Use TOGGLE_ENABLED when user wants to ACTIVATE/DEACTIVATE template. Concept: LIST=browse, VIEW=inspect one, MODIFY=change definition, DELETE=remove, TOGGLE_TESTING=switch mode, TOGGLE_ENABLED=enable/disable.',
          default: 'list'
        },
        templateId: {
          type: 'string',
          description: 'Template identifier (e.g., "bitrix24_missed_revenue_opportunity_report")'
        },
        templateUpdates: {
          type: 'object',
          description: 'For simple updates: {name, description, enabled, etc.}. For executionScript modifications: {modificationRequest: "description of changes to make to the code"}. The tool will fetch current code and use AI to generate targeted modifications.',
          additionalProperties: true
        },
        confirmDelete: {
          type: 'boolean',
          description: 'Confirmation flag for template deletion (required to actually delete)',
          default: false
        },
        categoryFilter: {
          type: 'string',
          description: 'Filter templates by category (for list action)'
        },
        enabledFilter: {
          type: 'boolean',
          description: 'Filter templates by enabled status (for list action)'
        }
      },
      required: []
    };

    this.templatesModel = null;
  }

  async initialize() {
    if (!this.templatesModel) {
      this.templatesModel = getTaskTemplatesModel();
      await this.templatesModel.initialize();
    }
  }

  /**
   * Get dynamic tool description with current template list
   * This helps Gemini use correct template IDs instead of hallucinating
   */
  async getDynamicDescription() {
    try {
      await this.initialize();
      const allTemplates = await this.templatesModel.getAllTemplates();

      const templateList = allTemplates.map(t =>
        `- "${t.name}" (ID: ${t.templateId})`
      ).join('\n');

      return `${this.description}\n\n**AVAILABLE TEMPLATES (use exact IDs):**\n${templateList}\n\nIMPORTANT: When user mentions a template by name (e.g., "Slipped through the Cracks"), look up the exact templateId from the list above. DO NOT guess or create template IDs.`;
    } catch (error) {
      this.log('warn', 'Failed to load templates for dynamic description', { error: error.message });
      return this.description;
    }
  }

  /**
   * Extract keywords from search term for intelligent matching
   */
  extractTemplateKeywords(searchTerm) {
    const keywords = new Set();
    const normalized = searchTerm.toLowerCase().replace(/_/g, ' ').trim();

    // Add full normalized term
    keywords.add(normalized);

    // Extract individual significant words (3+ chars)
    const words = normalized.match(/\b\w{3,}\b/g) || [];
    words.forEach(word => keywords.add(word));

    // Keyword expansion for common template-related terms
    const expansions = {
      'bitrix': ['bitrix24', 'crm'],
      'bitrix24': ['bitrix', 'crm'],
      'missed': ['lost', 'unpaid', 'overdue'],
      'revenue': ['money', 'payment', 'income', 'sales'],
      'opportunity': ['deal', 'prospect', 'chance'],
      'report': ['analysis', 'summary', 'review'],
      'invoice': ['bill', 'payment', 'charge'],
      'open': ['unpaid', 'outstanding', 'pending'],
      'old': ['overdue', 'past', 'aged']
    };

    keywords.forEach(keyword => {
      if (expansions[keyword]) {
        expansions[keyword].forEach(expansion => keywords.add(expansion));
      }
    });

    return Array.from(keywords);
  }

  /**
   * Calculate relevance score for template matching
   */
  calculateTemplateRelevance(searchKeywords, template, originalSearchTerm) {
    let score = 0;
    const nameLower = template.name.toLowerCase();
    const templateIdLower = template.templateId.toLowerCase();
    const normalizedSearch = originalSearchTerm.toLowerCase().replace(/_/g, ' ').trim();

    // Exact full search term matches template name (highest priority - user provided exact name)
    if (nameLower === normalizedSearch) {
      score += 15.0;
    }

    // Exact templateId match (second highest priority)
    if (searchKeywords.some(kw => templateIdLower === kw)) {
      score += 10.0;
    }

    // Exact name match with any keyword
    if (searchKeywords.some(kw => nameLower === kw)) {
      score += 8.0;
    }

    // Name contains keyword or keyword contains name
    searchKeywords.forEach(keyword => {
      if (nameLower.includes(keyword)) {
        score += 2.0;
      }
      if (keyword.length > 5 && keyword.includes(nameLower)) {
        score += 1.5;
      }
    });

    // TemplateId contains keyword
    searchKeywords.forEach(keyword => {
      if (templateIdLower.includes(keyword)) {
        score += 1.0;
      }
    });

    // Extract words from template name and count matches
    const nameWords = nameLower.match(/\b\w{3,}\b/g) || [];
    const matchingWords = nameWords.filter(word =>
      searchKeywords.some(kw => kw.includes(word) || word.includes(kw))
    );
    score += matchingWords.length * 0.5;

    // Boost enabled templates slightly
    if (template.enabled) {
      score += 0.1;
    }

    return score;
  }

  /**
   * Find template by ID or name with intelligent fuzzy matching
   * Returns { template, actualTemplateId }
   */
  async findTemplate(templateId) {
    // Try exact ID lookup first
    let template = await this.templatesModel.getTemplate(templateId);
    let actualTemplateId = templateId;

    // If not found by exact ID, use intelligent fuzzy matching
    if (!template) {
      this.log('info', 'Template not found by exact ID, using intelligent search', { templateId });
      const allTemplates = await this.templatesModel.getAllTemplates();

      // Extract search keywords with expansions
      const searchKeywords = this.extractTemplateKeywords(templateId);

      this.log('info', 'Intelligent template search', {
        searchTerm: templateId,
        searchKeywords: searchKeywords.slice(0, 10), // Show first 10 for logging
        availableTemplatesCount: allTemplates.length
      });

      // Calculate relevance scores for all templates
      const scoredTemplates = allTemplates.map(t => ({
        template: t,
        score: this.calculateTemplateRelevance(searchKeywords, t, templateId)
      }));

      // Sort by relevance score
      scoredTemplates.sort((a, b) => b.score - a.score);

      // Use best match if score is above threshold
      if (scoredTemplates.length > 0 && scoredTemplates[0].score > 0.5) {
        template = scoredTemplates[0].template;
        actualTemplateId = template.templateId;

        this.log('info', 'Template found by intelligent matching', {
          searchedId: templateId,
          foundTemplateId: actualTemplateId,
          foundName: template.name,
          relevanceScore: scoredTemplates[0].score,
          topMatches: scoredTemplates.slice(0, 3).map(st => ({
            name: st.template.name,
            score: st.score
          }))
        });
      } else {
        this.log('warn', 'No templates matched search criteria', {
          searchedId: templateId,
          searchKeywords: searchKeywords,
          bestScore: scoredTemplates[0]?.score || 0
        });
      }
    }

    return { template, actualTemplateId };
  }

  /**
   * SEMANTIC TRIGGER (CRITICAL - See CLAUDE.md)
   * DO NOT use keyword/regex matching or database lookups for triggering
   * The description field clearly articulates when to use this tool conceptually
   *
   * This is an ADMIN tool for managing template DEFINITIONS (view/modify/delete).
   * NOT for creating or executing tasks (ComplexTaskManager handles that).
   */
  async shouldTrigger() {
    // ❌ REMOVED 100+ lines of regex patterns, keyword matching, and DB lookups
    // ✅ Gemini's function calling uses the semantic description field for intent detection
    // The description clearly states this is for MANAGING template definitions, not creating tasks
    return false; // Let Gemini handle all triggering via description
  }

  /**
   * Execute the tool with given parameters
   */
  async execute(args, toolContext) {
    try {
      await this.initialize();

      const { action = 'list' } = args;
      const userId = toolContext?.messageData?.userId || 'unknown';

      switch (action) {
      case 'list':
        return await this.listTemplatesEnhanced(args);

      case 'view':
        if (!args.templateId) {
          throw new Error('Template ID is required for view action');
        }
        return await this.viewTemplateDetails(args.templateId);

      case 'modify':
        if (!args.templateId) {
          throw new Error('Template ID is required for modify action');
        }
        if (!args.templateUpdates) {
          throw new Error('Template updates are required for modify action. Specify what fields to update (e.g., executionScript, description, etc.)');
        }
        return await this.modifyTemplate(args.templateId, args.templateUpdates, userId);

      case 'delete':
        if (!args.templateId) {
          throw new Error('Template ID is required for delete action');
        }
        if (!args.confirmDelete) {
          return await this.requestDeleteConfirmation(args.templateId);
        }
        return await this.deleteTemplate(args.templateId, userId);

      case 'toggle_testing':
        if (!args.templateId) {
          throw new Error('Template ID is required for toggle_testing action');
        }
        return await this.toggleTemplateTesting(args.templateId, userId);

      case 'toggle_enabled':
        if (!args.templateId) {
          throw new Error('Template ID is required for toggle_enabled action');
        }
        return await this.toggleTemplateEnabled(args.templateId, userId);

      default:
        throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      this.log('error', 'TaskTemplateManager execution failed', {
        action: args.action,
        templateId: args.templateId,
        error: error.message,
        stack: error.stack
      });

      return {
        success: false,
        error: error.message,
        message: `❌ Template management failed: ${error.message}`
      };
    }
  }

  /**
   * Enhanced template listing with filtering and status information
   */
  async listTemplatesEnhanced(args) {
    try {
      const { categoryFilter, enabledFilter } = args;

      // Get all templates (not just active ones for management)
      let allTemplates;
      if (categoryFilter) {
        // If filtering by category, get all templates and filter manually
        const snapshot = await this.templatesModel.db.collection('task-templates').get();
        allTemplates = [];
        snapshot.forEach(doc => {
          const template = { id: doc.id, ...doc.data() };
          const categories = Array.isArray(template.category) ? template.category : [template.category];
          if (categories.some(cat => cat.toLowerCase().includes(categoryFilter.toLowerCase()))) {
            allTemplates.push(template);
          }
        });
      } else {
        // Get all templates without category filter
        const snapshot = await this.templatesModel.db.collection('task-templates').get();
        allTemplates = [];
        snapshot.forEach(doc => {
          allTemplates.push({ id: doc.id, ...doc.data() });
        });
      }

      // Apply enabled filter if specified
      let templates = allTemplates;
      if (enabledFilter !== undefined) {
        templates = allTemplates.filter(t => t.enabled === enabledFilter);
      }

      if (templates.length === 0) {
        const filterMsg = categoryFilter ? ` in category "${categoryFilter}"` : '';
        const enabledMsg = enabledFilter !== undefined ? ` (${enabledFilter ? 'enabled' : 'disabled'} only)` : '';
        return {
          success: true,
          templates: [],
          message: `📋 No task templates found${filterMsg}${enabledMsg}.`
        };
      }

      let message = `📋 **Task Templates Management** (${templates.length} found)\n\n`;

      templates.forEach((template, index) => {
        const statusIcon = template.enabled ? '✅' : '🚫';
        const testingIcon = template.testing ? '🧪' : '🔒';

        message += `${index + 1}. ${statusIcon} **${template.name}** ${testingIcon}\n`;
        message += `   ID: \`${template.templateId}\`\n`;
        message += `   Category: ${Array.isArray(template.category) ? template.category.join(', ') : template.category}\n`;
        message += `   Status: ${template.enabled ? 'Enabled' : 'Disabled'} | ${template.testing ? 'Testing Mode' : 'Production Mode'}\n`;
        message += `   Description: ${template.description || 'No description'}\n`;

        if (template.definition?.estimatedDuration) {
          message += `   Duration: ~${this.formatDuration(template.definition.estimatedDuration)}\n`;
        }

        if (template.lastRepaired) {
          message += `   Last Auto-Repair: ${new Date(template.lastRepaired).toLocaleDateString()}\n`;
        }

        message += '\n';
      });

      message += '**Template Management Commands:**\n';
      message += '- View details: `view template [template-id]`\n';
      message += '- Modify template: `modify template [template-id]`\n';
      message += '- Toggle testing: `toggle testing mode [template-id]`\n';
      message += '- Enable/disable: `enable/disable template [template-id]`\n';
      message += '- Delete template: `delete template [template-id]`\n';

      return {
        success: true,
        templates,
        message
      };
    } catch (error) {
      this.log('error', 'Enhanced template listing failed', { error: error.message });
      throw error;
    }
  }

  /**
   * View detailed template information
   */
  async viewTemplateDetails(templateId) {
    try {
      const { template } = await this.findTemplate(templateId);

      if (!template) {
        return {
          success: false,
          message: `❌ Template "${templateId}" not found.`
        };
      }

      let message = `📋 **Template Details: ${template.name}**\n\n`;

      message += '**Basic Information:**\n';
      message += `- ID: \`${template.templateId}\`\n`;
      message += `- Name: ${template.name}\n`;
      message += `- Category: ${Array.isArray(template.category) ? template.category.join(', ') : template.category}\n`;
      message += `- Description: ${template.description || 'No description'}\n`;
      message += `- Version: ${template.version || 'N/A'}\n`;
      message += `- Status: ${template.enabled ? '✅ Enabled' : '🚫 Disabled'}\n`;
      message += `- Mode: ${template.testing ? '🧪 Testing' : '🔒 Production'}\n\n`;

      message += '**Execution Details:**\n';
      message += `- Estimated Steps: ${template.definition?.estimatedSteps || 'N/A'}\n`;
      message += `- Estimated Duration: ${template.definition?.estimatedDuration ? this.formatDuration(template.definition.estimatedDuration) : 'N/A'}\n`;
      message += `- Memory Requirement: ${template.definition?.memoryRequirement || 'N/A'}\n`;
      message += `- Required Services: ${template.definition?.requiredServices?.join(', ') || 'None specified'}\n\n`;

      if (template.definition?.parameterSchema?.properties) {
        message += '**Parameters:**\n';
        Object.entries(template.definition.parameterSchema.properties).forEach(([key, schema]) => {
          message += `- ${key}: ${schema.type} (${schema.description || 'No description'})\n`;
        });
        message += '\n';
      }

      if (template.triggers?.length > 0) {
        message += `**Triggers:** ${template.triggers.join(', ')}\n\n`;
      }

      message += '**Metadata:**\n';
      message += `- Created: ${template.createdAt ? new Date(template.createdAt).toLocaleString() : 'N/A'}\n`;
      message += `- Last Modified: ${template.updatedAt ? new Date(template.updatedAt).toLocaleString() : 'N/A'}\n`;

      if (template.lastRepaired) {
        message += `- Last Auto-Repair: ${new Date(template.lastRepaired).toLocaleString()}\n`;
        message += `- Repair Attempts: ${template.repairAttempts || 0}\n`;
      }

      message += `- Script Length: ${template.executionScript?.length || 0} characters\n`;

      return {
        success: true,
        template,
        message
      };
    } catch (error) {
      this.log('error', 'Template details view failed', { templateId, error: error.message });
      throw error;
    }
  }

  /**
   * Generate intelligent code modifications using Gemini
   * @param {string} currentScript - Current execution script
   * @param {string} modificationRequest - Description of changes to make
   * @param {Object} templateInfo - Template metadata for context
   * @returns {string} - Modified execution script
   */
  async generateIntelligentModification(currentScript, modificationRequest, templateInfo) {
    try {
      const client = getGeminiClient();

      const prompt = `You are modifying a task template's execution script. You MUST make TARGETED, SURGICAL changes while preserving all existing functionality.

**CURRENT TEMPLATE INFO:**
Name: ${templateInfo.name}
Description: ${templateInfo.description}
Category: ${Array.isArray(templateInfo.category) ? templateInfo.category.join(', ') : templateInfo.category}

**MODIFICATION REQUEST:**
${modificationRequest}

**CURRENT EXECUTION SCRIPT:**
\`\`\`javascript
${currentScript}
\`\`\`

**CRITICAL INSTRUCTIONS:**
1. This is a JavaScript class extending BaseTaskExecutor - maintain JavaScript syntax
2. Make ONLY the requested changes - DO NOT rewrite or remove existing functionality
3. Preserve ALL existing features, methods, async/await patterns, and logic
4. When filtering data (e.g., invoices), add proper filter conditions in the data processing section
5. For numerical comparisons, use JavaScript operators (>, <, ===, !==, etc.)
6. Maintain the existing code style and structure
7. Add comments explaining new/modified sections
8. Return ONLY the complete modified JavaScript code, no explanations
9. Ensure the script remains syntactically correct JavaScript
10. DO NOT add markdown code blocks or formatting - just return the raw JavaScript code

**EXAMPLE OF FILTERING INVOICES BY AMOUNT:**
\`\`\`javascript
// Filter out invoices with $0 or negative amounts
const validInvoices = invoices.filter(invoice => {
  const amount = parseFloat(invoice.PRICE || invoice.OPPORTUNITY || 0);
  return amount > 0; // Only include invoices greater than $0
});
\`\`\`

**RESPONSE FORMAT:**
Return ONLY the modified JavaScript code, starting with the first line of code.`;

      const configManager = await getConfigManager();
      const geminiModel = await configManager.get('config', 'GEMINI_MODEL');
      if (!geminiModel) {
        throw new Error('GEMINI_MODEL not configured in Firestore agent/config');
      }

      const result = await client.models.generateContent({
        model: geminiModel,
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        config: {
          temperature: 0.3, // Lower temperature for more precise modifications
          maxOutputTokens: 65535, // Maximum for complex scripts
          systemInstruction: 'You are an expert JavaScript developer making precise, targeted code modifications while preserving all existing functionality. The code uses modern ES6+ JavaScript with async/await patterns and extends the BaseTaskExecutor class.'
        }
      });

      // Use centralized response extraction
      let modifiedScript = extractGeminiText(result);

      if (!modifiedScript) {
        throw new Error('No response received from Gemini for code modification');
      }

      // Clean up the response - remove any markdown code blocks if present
      modifiedScript = modifiedScript.trim();
      if (modifiedScript.startsWith('```javascript')) {
        modifiedScript = modifiedScript.replace(/^```javascript\n/, '').replace(/\n```$/, '');
      } else if (modifiedScript.startsWith('```js')) {
        modifiedScript = modifiedScript.replace(/^```js\n/, '').replace(/\n```$/, '');
      } else if (modifiedScript.startsWith('```')) {
        modifiedScript = modifiedScript.replace(/^```\n/, '').replace(/\n```$/, '');
      }

      this.log('info', 'Intelligent modification generated', {
        originalLength: currentScript.length,
        modifiedLength: modifiedScript.length,
        modificationRequest: modificationRequest.substring(0, 100)
      });

      return modifiedScript;
    } catch (error) {
      this.log('error', 'Failed to generate intelligent modification', {
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to generate code modification: ${error.message}`);
    }
  }

  /**
   * Modify template properties
   */
  async modifyTemplate(templateId, updates, userId) {
    try {
      const { template, actualTemplateId } = await this.findTemplate(templateId);

      if (!template) {
        return {
          success: false,
          message: `❌ Template "${templateId}" not found.`
        };
      }

      // Use the actual template ID for the update
      templateId = actualTemplateId;

      // Check if this is an intelligent modification request
      if (updates.modificationRequest || updates.executionScript) {
        // If there's a modificationRequest, use intelligent modification
        if (updates.modificationRequest) {
          this.log('info', 'Processing intelligent modification request', {
            templateId,
            templateName: template.name,
            request: updates.modificationRequest.substring(0, 100)
          });

          // Generate intelligent modification
          const modifiedScript = await this.generateIntelligentModification(
            template.executionScript || '',
            updates.modificationRequest,
            {
              name: template.name,
              description: template.description,
              category: template.category
            }
          );

          // Replace modificationRequest with the generated executionScript
          updates.executionScript = modifiedScript;
          delete updates.modificationRequest;
        }
        // If executionScript is provided directly, use it (legacy behavior)
        else if (updates.executionScript) {
          this.log('info', 'Direct executionScript update (legacy mode)', {
            templateId,
            scriptLength: updates.executionScript.length
          });
        }
      }

      // Validate and sanitize updates
      const allowedUpdates = ['name', 'description', 'category', 'testing', 'enabled', 'executionScript', 'definition', 'triggers', 'priority'];
      const sanitizedUpdates = {};

      Object.keys(updates).forEach(key => {
        if (allowedUpdates.includes(key)) {
          sanitizedUpdates[key] = updates[key];
        }
      });

      if (Object.keys(sanitizedUpdates).length === 0) {
        return {
          success: false,
          message: `❌ No valid updates provided. Allowed fields: ${allowedUpdates.join(', ')}, or use modificationRequest for intelligent code changes`
        };
      }

      // Add metadata
      sanitizedUpdates.updatedAt = new Date().toISOString();
      sanitizedUpdates.lastModifiedBy = userId;

      // Log before update to track what's being saved
      this.log('info', 'Saving template modifications to Firestore', {
        templateId,
        templateName: template.name,
        fieldsToUpdate: Object.keys(sanitizedUpdates),
        hasExecutionScript: !!sanitizedUpdates.executionScript,
        executionScriptLength: sanitizedUpdates.executionScript?.length || 0
      });

      // Update template
      const success = await this.templatesModel.updateTemplate(templateId, sanitizedUpdates);

      if (!success) {
        this.log('error', 'Template update failed - Firestore update returned false', {
          templateId,
          templateName: template.name,
          attemptedFields: Object.keys(sanitizedUpdates)
        });
        return {
          success: false,
          message: `❌ Failed to update template "${templateId}".`
        };
      }

      // Verify the update by reading back from Firestore
      this.log('info', 'Template update reported success, verifying by reading back from Firestore', {
        templateId,
        templateName: template.name
      });

      // Clear cache to force fresh read
      await this.templatesModel.clearCache();

      // Read back to verify
      const verifiedTemplate = await this.templatesModel.getTemplate(templateId);
      if (!verifiedTemplate) {
        this.log('error', 'Template verification failed - could not read back template', {
          templateId
        });
      } else {
        this.log('info', 'Template verification successful', {
          templateId,
          verifiedScriptLength: verifiedTemplate.executionScript?.length || 0,
          expectedScriptLength: sanitizedUpdates.executionScript?.length || 0,
          scriptsMatch: verifiedTemplate.executionScript === sanitizedUpdates.executionScript,
          updatedAt: verifiedTemplate.updatedAt
        });
      }

      const updatedFields = Object.keys(sanitizedUpdates).filter(k => k !== 'updatedAt' && k !== 'lastModifiedBy');
      const wasIntelligentModification = updatedFields.includes('executionScript') &&
                                         sanitizedUpdates.executionScript?.length > 1000; // Likely a full script

      let message = `✅ Template "${template.name}" updated successfully.\n\n`;

      if (wasIntelligentModification) {
        message += '**Modification Type:** Intelligent AI-assisted code modification\n';
        message += `**Script Size:** ${sanitizedUpdates.executionScript.length} characters\n\n`;
        message += 'The execution script has been modified while preserving existing functionality. Review the changes in the template details.\n\n';
      }

      message += `**Updated fields:** ${updatedFields.join(', ')}\n`;
      message += `**Template ID:** ${templateId}\n\n`;
      message += '**⚠️ NOTE:** The next time you run this task, it will use the updated template code.';

      // ✅ PHASE 1.2: Extract lessons learned from user modification
      if (config.REASONING_MEMORY_ENABLED && wasIntelligentModification) {
        try {
          const { getMemoryExtractor } = require('../services/memoryExtractor');
          const memoryExtractor = getMemoryExtractor();

          await memoryExtractor.extractFromUserModification({
            templateId: templateId,
            templateName: template.name,
            templateDescription: template.description,
            userRequest: updates.modificationRequest || 'Manual template update',
            modificationReason: 'User-identified improvement or fix',
            originalScript: template.executionScript,
            modifiedScript: sanitizedUpdates.executionScript,
            changesSummary: `Updated fields: ${updatedFields.join(', ')}`,
            codeDiff: true
          });

          this.log('info', 'User modification lessons extracted to memory', {
            templateId,
            templateName: template.name
          });
        } catch (memoryError) {
          // Don't fail the modification if memory extraction fails
          this.log('warn', 'Failed to extract memory from user modification', {
            templateId,
            error: memoryError.message
          });
        }
      }

      return {
        success: true,
        message,
        updatedFields,
        intelligentModification: wasIntelligentModification,
        templateId: templateId // Include templateId for verification
      };
    } catch (error) {
      this.log('error', 'Template modification failed', { templateId, updates, error: error.message });
      throw error;
    }
  }

  /**
   * Request delete confirmation
   */
  async requestDeleteConfirmation(templateId) {
    try {
      const { template, actualTemplateId } = await this.findTemplate(templateId);

      if (!template) {
        return {
          success: false,
          message: `❌ Template "${templateId}" not found.`
        };
      }

      templateId = actualTemplateId;

      return {
        success: true,
        requiresConfirmation: true,
        message: `⚠️ **Confirm Template Deletion**\n\nYou are about to delete template:\n\n**Name:** ${template.name}\n**ID:** ${templateId}\n**Category:** ${Array.isArray(template.category) ? template.category.join(', ') : template.category}\n\n**This action cannot be undone!**\n\nTo confirm deletion, use: \`delete template ${templateId} --confirm\``
      };
    } catch (error) {
      this.log('error', 'Delete confirmation request failed', { templateId, error: error.message });
      throw error;
    }
  }

  /**
   * Delete template (with confirmation)
   */
  async deleteTemplate(templateId, userId) {
    try {
      const { template, actualTemplateId } = await this.findTemplate(templateId);

      if (!template) {
        return {
          success: false,
          message: `❌ Template "${templateId}" not found.`
        };
      }

      templateId = actualTemplateId;

      const success = await this.templatesModel.deleteTemplate(templateId);

      if (!success) {
        return {
          success: false,
          message: `❌ Failed to delete template "${templateId}".`
        };
      }

      this.log('info', 'Template deleted', {
        templateId,
        templateName: template.name,
        deletedBy: userId
      });

      return {
        success: true,
        message: `✅ Template "${template.name}" (${templateId}) has been permanently deleted.`
      };
    } catch (error) {
      this.log('error', 'Template deletion failed', { templateId, error: error.message });
      throw error;
    }
  }

  /**
   * Toggle template testing mode
   */
  async toggleTemplateTesting(templateId, userId) {
    try {
      const { template, actualTemplateId } = await this.findTemplate(templateId);

      if (!template) {
        return {
          success: false,
          message: `❌ Template "${templateId}" not found.`
        };
      }

      templateId = actualTemplateId;

      const newTestingMode = !template.testing;

      const success = await this.templatesModel.updateTemplate(templateId, {
        testing: newTestingMode,
        updatedAt: new Date().toISOString(),
        lastModifiedBy: userId
      });

      if (!success) {
        return {
          success: false,
          message: `❌ Failed to toggle testing mode for template "${templateId}".`
        };
      }

      const modeIcon = newTestingMode ? '🧪' : '🔒';
      const modeName = newTestingMode ? 'Testing' : 'Production';

      return {
        success: true,
        message: `${modeIcon} Template "${template.name}" is now in **${modeName} Mode**.`,
        testing: newTestingMode
      };
    } catch (error) {
      this.log('error', 'Template testing toggle failed', { templateId, error: error.message });
      throw error;
    }
  }

  /**
   * Toggle template enabled status
   */
  async toggleTemplateEnabled(templateId, userId) {
    try {
      const { template, actualTemplateId } = await this.findTemplate(templateId);

      if (!template) {
        return {
          success: false,
          message: `❌ Template "${templateId}" not found.`
        };
      }

      templateId = actualTemplateId;

      const newEnabledStatus = !template.enabled;

      const success = await this.templatesModel.setTemplateEnabled(templateId, newEnabledStatus);

      if (!success) {
        return {
          success: false,
          message: `❌ Failed to toggle enabled status for template "${templateId}".`
        };
      }

      const statusIcon = newEnabledStatus ? '✅' : '🚫';
      const statusName = newEnabledStatus ? 'Enabled' : 'Disabled';

      return {
        success: true,
        message: `${statusIcon} Template "${template.name}" is now **${statusName}**.`,
        enabled: newEnabledStatus
      };
    } catch (error) {
      this.log('error', 'Template enabled toggle failed', { templateId, error: error.message });
      throw error;
    }
  }

  /**
   * Format duration in human-readable format
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
}

module.exports = TaskTemplateManagerTool;
