const BaseTool = require('../lib/baseTool');
const { getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');
const embeddingService = require('../services/embeddingService');
const { FieldValue } = require('@google-cloud/firestore');
const { FeatureFlags } = require('../utils/featureFlags');

class KnowledgeManagementTool extends BaseTool {
  constructor(context) {
    super(context);

    this.name = 'KnowledgeManagement';
    this.description = 'Manage knowledge base documents. EXAMPLES: For "append X to document Y" use action="update", title="Y", appendContent="X" (auto-approved). For "find document about Z" use action="search", query="Z". For "add to knowledge base" use action="add" (creates immediately with smart defaults). Confirmation only required for destructive operations (delete).';
    this.userDescription = 'Manage knowledge base documents';
    this.category = 'system';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent System';
    this.priority = 100; // Highest priority - knowledge base should be searched first

    // Define parameters for the tool
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update', 'add', 'search', 'delete', 'list'],
          description: 'CONCEPTUAL: What does user want to DO with knowledge? Use ADD when user wants to STORE/SAVE new information. Use UPDATE when user wants to CHANGE/APPEND to existing document. Use SEARCH when user wants to FIND/RETRIEVE information. Use DELETE when user wants to REMOVE document permanently. Use LIST when user wants to SEE all documents. Concept: ADD=store new, UPDATE=modify existing, SEARCH=find, DELETE=remove, LIST=browse all.'
        },
        documentId: {
          type: 'string',
          description: 'Document ID for update/delete operations'
        },
        title: {
          type: 'string',
          description: 'Document title'
        },
        content: {
          type: 'string',
          description: 'Document content (replaces existing content)'
        },
        appendContent: {
          type: 'string',
          description: 'Content to append to existing document content. Use this with "update" action to add text to documents without replacing existing content'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization'
        },
        category: {
          type: 'string',
          enum: ['general', 'hr', 'it', 'policies', 'processes', 'products', 'system_information'],
          description: 'Document category'
        },
        priority: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description: 'Priority (0-100)'
        },
        searchTerms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Search terms for finding documents (can be used instead of query parameter)'
        },
        query: {
          type: 'string',
          description: 'Search query for finding documents'
        },
        maxResults: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of search results to return (default: 50, max: 100)',
          default: 50
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific tags to search for in documents'
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the document is enabled'
        },
        confirm: {
          type: 'boolean',
          description: 'Required for destructive operations like "delete". Not needed for add/update operations.'
        },
        page: {
          type: 'number',
          minimum: 1,
          description: 'Page number for pagination when listing documents (50 results per page)',
          default: 1
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Number of results to return per page (default: 50, max: 100)',
          default: 50
        }
      },
      required: ['action']
    };

    this.db = null;
  }

  async initialize() {
    // Use Firestore from context if available, otherwise this tool will be disabled
    this.db = this.firestore;
    if (!this.db) {
      throw new Error('Firestore not initialized. Call initializeFirestore() first.');
    }
    await super.initialize();
  }

  async execute(params, toolContext = {}) {
    const { action } = params;
    
    // Extract context information
    const messageData = toolContext.messageData || toolContext;
    const knowledgeResults = toolContext.knowledgeResults;
    const previousToolResults = toolContext.previousToolResults;
    
    // Log enhanced context for debugging
    this.log('info', 'Knowledge tool executing with context', {
      action,
      hasKnowledgeResults: !!knowledgeResults,
      hasPreviousResults: !!previousToolResults,
      knowledgeResultsCount: knowledgeResults?.length || 0
    });

    switch (action) {
    case 'add':
      return await this.addDocument(params, messageData);
    case 'update':
      return await this.updateDocument(params, messageData);
    case 'delete':
      return await this.deleteDocument(params, messageData);
    case 'search':
      return await this.searchDocuments(params, toolContext);
    case 'list':
      return await this.listDocuments(params, toolContext);
    default:
      throw new Error(`Unknown action: ${action}`);
    }
  }

  // Intelligent content suggestion based on user message
  async suggestDocumentContent(userMessage, existingTitle = null) {
    const suggestions = {
      title: '',
      content: '',
      tags: [],
      searchTerms: [],
      category: 'general',
      priority: 50
    };

    // Extract likely title from the message
    if (!existingTitle) {
      // Look for patterns like "about X", "regarding X", "how to X"
      const titlePatterns = [
        /(?:about|regarding|concerning|for)\s+(.+?)(?:\.|,|$)/i,
        /(?:how to|guide to|instructions for)\s+(.+?)(?:\.|,|$)/i,
        /(?:what is|what are)\s+(.+?)(?:\.|,|$)/i,
        /(?:^|\n)(.+?)(?:\?|:|$)/
      ];

      for (const pattern of titlePatterns) {
        const match = userMessage.match(pattern);
        if (match) {
          suggestions.title = this.cleanTitle(match[1]);
          break;
        }
      }

      if (!suggestions.title) {
        // Use first sentence or line as title
        const firstLine = userMessage.split(/[\n.!?]/)[0].trim();
        suggestions.title = this.cleanTitle(firstLine.substring(0, 100));
      }
    } else {
      suggestions.title = existingTitle;
    }

    // Format content with proper structure
    suggestions.content = this.formatContent(userMessage);

    // Extract tags from content
    suggestions.tags = this.extractTags(userMessage);

    // Generate search terms
    suggestions.searchTerms = this.generateSearchTerms(userMessage, suggestions.title);

    // Determine category based on keywords
    suggestions.category = this.determineCategory(userMessage);

    // Set priority based on importance indicators
    suggestions.priority = this.determinePriority(userMessage);

    return suggestions;
  }

  cleanTitle(title) {
    return title
      .trim()
      .replace(/^(add|create|new|update|edit|delete|remove)\s+/i, '')
      .replace(/\s+/g, ' ')
      .replace(/^(.)/g, (match) => match.toUpperCase());
  }

  formatContent(text) {
    // Clean and structure the content
    let formatted = text.trim();

    // Keep markdown bullets as-is (don't convert to bullet characters)
    // Platform services will handle conversion if needed
    formatted = formatted.replace(/^\d+\.\s+/gm, (match) => match);

    // Add headers for sections
    formatted = formatted.replace(/^(Steps?|Instructions?|Process|Procedure|Guidelines?):?\s*$/gmi, '## $1\n');
    formatted = formatted.replace(/^(Note|Important|Warning|Tip):?\s*/gmi, '**$1:** ');

    // Ensure proper line breaks
    formatted = formatted.replace(/\n{3,}/g, '\n\n');

    return formatted;
  }

  extractTags(text) {
    const tags = new Set();
    const textLower = text.toLowerCase();

    // Common keyword categories
    const keywordMap = {
      hr: ['hr', 'human resources', 'employee', 'staff', 'vacation', 'leave', 'payroll', 'benefits'],
      it: ['it', 'technology', 'computer', 'software', 'hardware', 'system', 'network', 'password'],
      policies: ['policy', 'policies', 'rule', 'regulation', 'compliance', 'standard'],
      processes: ['process', 'procedure', 'workflow', 'steps', 'instructions', 'guide'],
      products: ['product', 'service', 'feature', 'specification', 'pricing']
    };

    for (const [tag, keywords] of Object.entries(keywordMap)) {
      if (keywords.some(keyword => textLower.includes(keyword))) {
        tags.add(tag);
      }
    }

    // Extract significant words (3+ characters, not common words)
    const commonWords = ['the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'will', 'can', 'are', 'was', 'been'];
    const words = text.match(/\b[a-z]{3,}\b/gi) || [];
    const significantWords = words
      .filter(word => !commonWords.includes(word.toLowerCase()))
      .map(word => word.toLowerCase());

    // Add most frequent significant words as tags (up to 5)
    const wordFreq = {};
    significantWords.forEach(word => {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    });

    Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([word]) => {
        if (tags.size < 8) {tags.add(word);}
      });

    return Array.from(tags);
  }

  generateSearchTerms(text, title) {
    const terms = new Set();

    // Add variations of the title
    if (title) {
      terms.add(title.toLowerCase());
      title.split(' ').forEach(word => {
        if (word.length > 3) {terms.add(word.toLowerCase());}
      });
    }

    // Add common synonyms and related terms
    const synonymMap = {
      'vacation': ['leave', 'time off', 'pto', 'holiday'],
      'password': ['login', 'credentials', 'access', 'sign in'],
      'expense': ['reimbursement', 'receipt', 'spending', 'cost'],
      'employee': ['staff', 'worker', 'personnel', 'team member'],
      'guide': ['instructions', 'manual', 'tutorial', 'how to']
    };

    Object.entries(synonymMap).forEach(([key, synonyms]) => {
      if (text.toLowerCase().includes(key)) {
        synonyms.forEach(syn => terms.add(syn));
      }
    });

    // Extract questions
    const questions = text.match(/\b(what|how|when|where|why|who|which)\s+.+?\?/gi) || [];
    questions.forEach(q => terms.add(q.toLowerCase().replace('?', '')));

    return Array.from(terms).slice(0, 10);
  }

  determineCategory(text) {
    const textLower = text.toLowerCase();

    const categoryKeywords = {
      hr: ['employee', 'hr', 'human resources', 'vacation', 'payroll', 'benefits', 'leave'],
      it: ['computer', 'software', 'system', 'network', 'technology', 'password', 'technical'],
      policies: ['policy', 'rule', 'regulation', 'compliance', 'guideline', 'standard'],
      processes: ['process', 'procedure', 'workflow', 'step', 'instruction', 'how to'],
      products: ['product', 'service', 'feature', 'specification', 'pricing', 'offer'],
      system_information: ['api', 'integration', 'bitrix24', 'system', 'technical', 'developer', 'architecture', 'code']
    };

    let maxScore = 0;
    let selectedCategory = 'general';

    for (const [category, keywords] of Object.entries(categoryKeywords)) {
      const score = keywords.filter(keyword => textLower.includes(keyword)).length;
      if (score > maxScore) {
        maxScore = score;
        selectedCategory = category;
      }
    }

    return selectedCategory;
  }

  determinePriority(text) {
    const textLower = text.toLowerCase();

    // High priority indicators
    if (textLower.includes('urgent') || textLower.includes('critical') ||
        textLower.includes('emergency') || textLower.includes('important')) {
      return 90;
    }

    // Medium-high priority
    if (textLower.includes('policy') || textLower.includes('compliance') ||
        textLower.includes('security') || textLower.includes('required')) {
      return 70;
    }

    // Medium priority (default for most docs)
    if (textLower.includes('process') || textLower.includes('procedure') ||
        textLower.includes('guide') || textLower.includes('instructions')) {
      return 50;
    }

    // Lower priority
    return 30;
  }

  async addDocument(params, messageData) {
    // Generate suggestions for missing fields
    const suggestions = await this.suggestDocumentContent(
      params.content || messageData.message,
      params.title
    );

    // Build document with smart defaults
    const docData = {
      title: params.title || suggestions.title,
      content: params.content || suggestions.content,
      tags: params.tags || suggestions.tags,
      category: params.category || suggestions.category,
      priority: params.priority !== undefined ? params.priority : suggestions.priority,
      searchTerms: params.searchTerms || suggestions.searchTerms,
      enabled: params.enabled !== undefined ? params.enabled : true,
      createdAt: getFieldValue().serverTimestamp(),
      lastUpdated: getFieldValue().serverTimestamp(),
      createdBy: messageData.userId,
      createdVia: 'Chantilly Knowledge Management Tool'
    };

    // Validate required fields
    if (!docData.title || !docData.content) {
      return {
        success: false,
        error: 'Title and content are required for knowledge base entries',
        suggestions: {
          title: suggestions.title,
          content: suggestions.content.substring(0, 200) + '...'
        }
      };
    }

    // Generate embedding from title + content for semantic search
    try {
      const textToEmbed = `${docData.title}\n\n${docData.content}`;
      const embedding = await embeddingService.embedQuery(
        textToEmbed,
        'RETRIEVAL_DOCUMENT'
      );

      // Add embedding to document
      docData.embedding = FieldValue.vector(embedding);
      docData.embeddingGenerated = getFieldValue().serverTimestamp();
      docData.embeddingDimensions = embedding.length;
      docData.embeddingModel = 'text-embedding-004';

      this.log('info', 'Generated vector embedding for new document', {
        embeddingDimensions: embedding.length,
        title: docData.title
      });
    } catch (error) {
      this.log('warn', 'Failed to generate embedding, document will use keyword search only', error);
      // Continue without embedding - document will still work with keyword search
    }

    // Create document immediately
    const docRef = await this.db.collection('knowledge-base').add(docData);

    this.log('info', 'Knowledge base entry created immediately', {
      documentId: docRef.id,
      title: docData.title,
      hasEmbedding: !!docData.embedding,
      autoGenerated: !params.title || !params.content
    });

    return {
      success: true,
      message: `Knowledge base entry "${docData.title}" has been created successfully with semantic search capabilities!`,
      documentId: docRef.id,
      details: {
        title: docData.title,
        tags: docData.tags.join(', '),
        category: docData.category,
        priority: docData.priority,
        semanticSearch: !!docData.embedding,
        autoGenerated: !params.title || !params.content ? 'Used AI-generated suggestions for missing fields' : false
      }
    };
  }

  async updateDocument(params, messageData) {
    let documentId = params.documentId;

    // If no documentId provided, try to find by title
    if (!documentId && params.title) {
      const searchResults = await this.searchDocuments({
        query: params.title,
        maxResults: 1
      });

      if (searchResults.results && searchResults.results.length > 0) {
        documentId = searchResults.results[0].id;
        logger.info('Found document by title for update', {
          title: params.title,
          documentId: documentId
        });
      }
    }

    if (!documentId) {
      throw new Error('Document ID is required for updates, or provide title to search for the document');
    }

    // Fetch existing document
    const docRef = this.db.collection('knowledge-base').doc(documentId);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new Error(`Document with ID ${documentId} not found`);
    }

    const existing = doc.data();

    // Auto-approve simple append operations and minor updates
    const isSimpleAppend = params.appendContent && !params.content && !params.title && !params.tags && !params.category;
    const isMinorUpdate = Object.keys(params).filter(key => 
      key !== 'action' && key !== 'title' && key !== 'documentId' && params[key] !== undefined
    ).length <= 2;

    if (isSimpleAppend) {
      logger.info('Auto-approving simple append operation', {
        documentId: documentId,
        appendContent: params.appendContent.substring(0, 100)
      });
    } else if (isMinorUpdate) {
      logger.info('Auto-approving minor update operation', {
        documentId: documentId,
        updateFields: Object.keys(params).filter(key => 
          key !== 'action' && key !== 'title' && key !== 'documentId' && params[key] !== undefined
        )
      });
    }

    // If no confirmation yet and it's not a simple operation, show what will be updated
    if (!params.confirm && !isSimpleAppend && !isMinorUpdate) {
      const updates = {};

      // Only include fields that are being changed
      if (params.title !== undefined) {updates.title = params.title;}
      if (params.content !== undefined) {updates.content = params.content;}
      if (params.tags !== undefined) {updates.tags = params.tags;}
      if (params.category !== undefined) {updates.category = params.category;}
      if (params.priority !== undefined) {updates.priority = params.priority;}
      if (params.searchTerms !== undefined) {updates.searchTerms = params.searchTerms;}
      if (params.enabled !== undefined) {updates.enabled = params.enabled;}

      return {
        action: 'confirm',
        message: 'Current document details:',
        current: {
          title: existing.title,
          content: existing.content.substring(0, 200) + '...',
          tags: existing.tags,
          category: existing.category,
          priority: existing.priority,
          enabled: existing.enabled
        },
        updates: updates,
        confirmMessage: 'Would you like to apply these updates?'
      };
    }

    // Apply updates
    const updates = {
      lastUpdated: getFieldValue().serverTimestamp(),
      updatedBy: messageData.userId
    };

    if (params.title !== undefined) {updates.title = params.title;}
    if (params.content !== undefined) {
      updates.content = params.content;
    } else if (params.appendContent !== undefined) {
      // Append content to existing content
      updates.content = existing.content + '\n\n' + params.appendContent;
    }
    if (params.tags !== undefined) {updates.tags = params.tags;}
    if (params.category !== undefined) {updates.category = params.category;}
    if (params.priority !== undefined) {updates.priority = params.priority;}
    if (params.searchTerms !== undefined) {updates.searchTerms = params.searchTerms;}
    if (params.enabled !== undefined) {updates.enabled = params.enabled;}

    await docRef.update(updates);

    this.log('info', 'Knowledge base entry updated', {
      documentId: documentId,
      updates: Object.keys(updates)
    });

    return {
      success: true,
      message: `Knowledge base entry "${existing.title}" has been updated successfully!`,
      documentId: documentId,
      updatedFields: Object.keys(updates).filter(k => k !== 'lastUpdated' && k !== 'updatedBy')
    };
  }

  async deleteDocument(params, messageData) {
    const { documentId } = params;
    if (!documentId) {
      throw new Error('Document ID is required for deletion');
    }

    // Fetch document to show what will be deleted
    const docRef = this.db.collection('knowledge-base').doc(documentId);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new Error(`Document with ID ${documentId} not found`);
    }

    const docData = doc.data();

    // If no confirmation yet, show what will be deleted
    if (!params.confirm) {
      return {
        action: 'confirm',
        message: 'You are about to delete the following knowledge base entry:',
        document: {
          id: documentId,
          title: docData.title,
          content: docData.content.substring(0, 200) + '...',
          tags: docData.tags,
          category: docData.category,
          createdAt: docData.createdAt
        },
        confirmMessage: 'Are you sure you want to delete this entry? This action cannot be undone.',
        suggestion: 'Tip: Consider setting enabled=false instead of deleting if you might need this later.'
      };
    }

    // User confirmed, delete the document
    await docRef.delete();

    this.log('info', 'Knowledge base entry deleted', {
      documentId: documentId,
      title: docData.title,
      deletedBy: messageData.userId
    });

    return {
      success: true,
      message: `Knowledge base entry "${docData.title}" has been deleted successfully.`,
      documentId: documentId
    };
  }

  /**
   * Main search entry point - uses hybrid search (vector + keyword)
   * Falls back to keyword-only if vector search is disabled or fails
   */
  async searchDocuments(params, toolContext = {}) {
    const { query, title, category, maxResults = 50, searchTerms, tags, page = 1, limit } = params;

    // Use limit if provided, otherwise use maxResults for backward compatibility
    const resultsPerPage = limit || maxResults;
    const validatedLimit = Math.min(Math.max(1, parseInt(resultsPerPage) || 50), 100);
    const validatedPage = Math.max(1, parseInt(page) || 1);

    // Allow search by query, title, or searchTerms (for Gemini compatibility)
    const searchTerm = query || title || (searchTerms && searchTerms.length > 0 ? searchTerms[0] : null);
    if (!searchTerm) {
      throw new Error('Search query, title, or searchTerms is required');
    }

    // Feature flag check (all features fully rolled out)
    const useVectorSearch = await FeatureFlags.shouldUseVectorSearch();

    if (!useVectorSearch) {
      this.log('info', 'Vector search disabled by feature flag, using keyword search');
      return await this.keywordSearch(params, toolContext);
    }

    try {
      // Hybrid approach: Run both searches in parallel
      // Get extra results for pagination (fetch more than one page)
      const fetchLimit = validatedLimit * Math.min(validatedPage + 2, 10); // Fetch a few pages ahead, cap at 10 pages

      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorSearch(searchTerm, category, fetchLimit, toolContext),
        this.keywordSearch({ ...params, maxResults: fetchLimit }, toolContext)
      ]);

      // Merge results with weighted scoring (70% vector, 30% keyword)
      const allMergedResults = this.mergeResults(
        vectorResults,
        keywordResults.results || [],
        fetchLimit
      );

      // Calculate pagination
      const totalCount = allMergedResults.length;
      const totalPages = Math.ceil(totalCount / validatedLimit);
      const hasNextPage = validatedPage < totalPages;
      const hasPrevPage = validatedPage > 1;

      // Slice results for current page
      const startIdx = (validatedPage - 1) * validatedLimit;
      const endIdx = startIdx + validatedLimit;
      const pagedResults = allMergedResults.slice(startIdx, endIdx);

      const pagination = {
        currentPage: validatedPage,
        totalPages,
        totalRecords: totalCount,
        recordsPerPage: validatedLimit,
        hasNextPage,
        hasPrevPage,
        nextPage: hasNextPage ? validatedPage + 1 : null,
        prevPage: hasPrevPage ? validatedPage - 1 : null
      };

      this.log('info', 'Hybrid search complete', {
        query: searchTerm.substring(0, 100),
        vectorResultsCount: vectorResults.length,
        keywordResultsCount: (keywordResults.results || []).length,
        totalMergedResults: allMergedResults.length,
        currentPage: validatedPage,
        pageResultsCount: pagedResults.length
      });

      // Format as user-friendly text
      let formattedResult = `🔍 **Search Results for "${searchTerm}"**\n\n`;
      formattedResult += `📄 **Page:** ${pagination.currentPage} of ${pagination.totalPages}\n`;
      formattedResult += `📈 **Total Matches:** ${pagination.totalRecords} (showing ${pagedResults.length} on this page)\n`;
      if (category) {
        formattedResult += `🏷️ **Category Filter:** ${category}\n`;
      }
      formattedResult += `\n---\n\n`;

      pagedResults.forEach((result, index) => {
        const num = startIdx + index + 1;
        formattedResult += `${num}. **${result.title}**\n`;
        formattedResult += `   - ID: \`${result.id}\`\n`;
        formattedResult += `   - Category: ${result.category}\n`;
        if (result.tags && result.tags.length > 0) {
          formattedResult += `   - Tags: ${result.tags.join(', ')}\n`;
        }
        formattedResult += `   - Relevance: ${(result.finalScore * 100).toFixed(0)}%`;
        if (result.foundBy) {
          formattedResult += ` (${result.foundBy})`;
        }
        formattedResult += `\n`;
        if (result.preview) {
          formattedResult += `   - Preview: ${result.preview}\n`;
        }
        formattedResult += `\n`;
      });

      // Add pagination navigation if applicable
      if (pagination.totalPages > 1) {
        formattedResult += '\n---\n\n';
        formattedResult += '**📖 Navigation:**\n';

        const navButtons = [];
        if (pagination.hasPrevPage) {
          navButtons.push(`◀️ Previous (Page ${pagination.prevPage})`);
        }
        navButtons.push(`📍 Page ${pagination.currentPage}/${pagination.totalPages}`);
        if (pagination.hasNextPage) {
          navButtons.push(`Next (Page ${pagination.nextPage}) ▶️`);
        }

        formattedResult += navButtons.join(' | ') + '\n\n';

        formattedResult += '**How to navigate:**\n';
        if (pagination.hasPrevPage) {
          formattedResult += `- Previous page: "Search for ${searchTerm} page ${pagination.prevPage}"\n`;
        }
        if (pagination.hasNextPage) {
          formattedResult += `- Next page: "Search for ${searchTerm} page ${pagination.nextPage}"\n`;
        }
        if (pagination.totalPages > 2) {
          formattedResult += `- Specific page: "Search for ${searchTerm} page [1-${pagination.totalPages}]"\n`;
        }
      }

      return formattedResult;

    } catch (error) {
      this.log('error', 'Hybrid search failed, falling back to keyword', error);
      return await this.keywordSearch(params, toolContext);
    }
  }

  /**
   * Vector semantic search using Firestore Vector Search
   */
  async vectorSearch(query, category, maxResults, toolContext = {}) {
    try {
      const startTime = Date.now();

      // Generate query embedding
      const queryEmbedding = await embeddingService.embedQuery(
        query,
        'RETRIEVAL_QUERY'
      );

      this.log('info', 'Performing vector similarity search', {
        query: query.substring(0, 100),
        embeddingDimensions: queryEmbedding.length,
        category
      });

      // Build query with pre-filtering
      let collectionRef = this.db.collection('knowledge-base')
        .where('enabled', '==', true);

      // Pre-filter by category if specified (reduces search space)
      if (category) {
        collectionRef = collectionRef.where('category', '==', category);
      }

      // Perform vector similarity search
      const vectorQuery = collectionRef.findNearest({
        vectorField: 'embedding',
        queryVector: FieldValue.vector(queryEmbedding),
        limit: maxResults * 2, // Get extra for post-filtering
        distanceMeasure: 'COSINE' // Best for semantic similarity
      });

      const snapshot = await vectorQuery.get();
      const results = [];

      snapshot.forEach(doc => {
        const data = doc.data();

        // Filter system_information from user searches
        const isUserSearch = toolContext.messageData && toolContext.messageData.userId;
        if (isUserSearch && data.category === 'system_information') {
          return;
        }

        results.push({
          id: doc.id,
          title: data.title,
          category: data.category,
          tags: data.tags,
          vectorScore: 1.0, // Firestore returns results sorted by relevance
          keywordScore: 0,
          content: data.content,
          preview: data.content.substring(0, 200) + '...'
        });
      });

      const duration = Date.now() - startTime;

      this.log('info', 'Vector search complete', {
        duration: `${duration}ms`,
        resultsFound: results.length
      });

      return results.slice(0, maxResults);

    } catch (error) {
      this.log('error', 'Vector search failed', error);
      throw error;
    }
  }

  /**
   * Merge vector and keyword results with weighted scoring
   * 70% weight to vector (semantic understanding)
   * 30% weight to keyword (exact matches)
   */
  mergeResults(vectorResults, keywordResults, maxResults) {
    const merged = new Map();

    // Add vector results (70% weight)
    vectorResults.forEach((result, index) => {
      const score = 1.0 - (index / Math.max(vectorResults.length, 1)) * 0.5;
      merged.set(result.id, {
        ...result,
        vectorScore: score,
        keywordScore: 0,
        finalScore: score * 0.7,
        foundBy: 'vector'
      });
    });

    // Add/merge keyword results (30% weight)
    keywordResults.forEach((result, index) => {
      const score = result.score || result.relevanceScore || (1.0 - (index / Math.max(keywordResults.length, 1)) * 0.5);

      if (merged.has(result.id)) {
        // Document found by both methods - merge scores
        const existing = merged.get(result.id);
        existing.keywordScore = score;
        existing.finalScore = existing.vectorScore * 0.7 + score * 0.3;
        existing.foundBy = 'both';
      } else {
        // Document only found by keyword search
        merged.set(result.id, {
          ...result,
          vectorScore: 0,
          keywordScore: score,
          finalScore: score * 0.3,
          foundBy: 'keyword'
        });
      }
    });

    // Sort by final score and return top results
    const sortedResults = Array.from(merged.values())
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, maxResults);

    this.log('debug', 'Results merged', {
      vectorOnly: sortedResults.filter(r => r.foundBy === 'vector').length,
      keywordOnly: sortedResults.filter(r => r.foundBy === 'keyword').length,
      both: sortedResults.filter(r => r.foundBy === 'both').length
    });

    return sortedResults;
  }

  /**
   * Keyword-based search (fallback and part of hybrid search)
   * This is the original search implementation
   */
  async keywordSearch(params, toolContext = {}) {
    const { query, title, category, maxResults = 50, searchTerms, tags } = params;

    // Allow search by query, title, or searchTerms (for Gemini compatibility)
    const searchTerm = query || title || (searchTerms && searchTerms.length > 0 ? searchTerms[0] : null);
    if (!searchTerm) {
      throw new Error('Search query, title, or searchTerms is required');
    }

    let queryBuilder = this.db.collection('knowledge-base')
      .where('enabled', '==', true);

    if (category) {
      queryBuilder = queryBuilder.where('category', '==', category);
    }

    const snapshot = await queryBuilder.get();
    const results = [];
    
    // Check if this is a user-initiated search (hide system_information from users)
    const isUserSearch = toolContext.messageData && toolContext.messageData.userId;
    
    this.log('info', 'Knowledge base search filtering', {
      isUserSearch,
      hasMessageData: !!toolContext.messageData,
      userId: toolContext.messageData?.userId
    });

    // Intelligent search: also parse search terms for tag-like keywords
    const searchKeywords = this.extractSearchKeywords(searchTerm, searchTerms, tags);

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // Filter out system_information category for user searches
      if (isUserSearch && data.category === 'system_information') {
        this.log('debug', 'Filtering system_information document from user search', {
          documentId: doc.id,
          title: data.title,
          category: data.category
        });
        return; // Skip this document
      }
      
      const score = this.calculateRelevance(searchTerm, data, searchKeywords);

      if (score > 0.1) {
        results.push({
          id: doc.id,
          title: data.title,
          category: data.category,
          tags: data.tags,
          score: score,
          preview: data.content.substring(0, 150) + '...',
          // Include full content for tools that need it
          content: data.content
        });
      }
    });

    // Sort by relevance score
    results.sort((a, b) => b.score - a.score);

    return {
      success: true,
      query: searchTerm,
      searchKeywords: searchKeywords,
      resultsCount: Math.min(results.length, maxResults),
      results: results.slice(0, maxResults),
      filteredSystemDocs: isUserSearch ? 'system_information category hidden from user' : 'all categories included'
    };
  }

  async listDocuments(params, toolContext = {}) {
    const {
      category,
      limit = 50,
      page = 1,
      showDisabled = false
    } = params;

    // Validate and cap limit
    const validatedLimit = Math.min(Math.max(1, parseInt(limit) || 50), 100);
    const validatedPage = Math.max(1, parseInt(page) || 1);

    // Check if this is a user-initiated search (hide system_information from users)
    const isUserSearch = toolContext.messageData && toolContext.messageData.userId;

    // First, get total count for pagination
    let countQuery = this.db.collection('knowledge-base');
    if (!showDisabled) {
      countQuery = countQuery.where('enabled', '==', true);
    }
    if (category) {
      countQuery = countQuery.where('category', '==', category);
    }

    const countSnapshot = await countQuery.get();
    let totalCount = countSnapshot.size;

    // Filter out system_information from count for user searches
    if (isUserSearch) {
      totalCount = countSnapshot.docs.filter(doc =>
        doc.data().category !== 'system_information'
      ).length;
    }

    // Now fetch the paginated results
    let queryBuilder = this.db.collection('knowledge-base');

    if (!showDisabled) {
      queryBuilder = queryBuilder.where('enabled', '==', true);
    }

    if (category) {
      queryBuilder = queryBuilder.where('category', '==', category);
    }

    queryBuilder = queryBuilder.orderBy('priority', 'desc');

    // Apply pagination offset
    if (validatedPage > 1) {
      const offset = (validatedPage - 1) * validatedLimit;
      queryBuilder = queryBuilder.offset(offset);
    }

    queryBuilder = queryBuilder.limit(validatedLimit);

    const snapshot = await queryBuilder.get();
    const documents = [];

    snapshot.forEach(doc => {
      const data = doc.data();

      // Filter out system_information category for user searches
      if (isUserSearch && data.category === 'system_information') {
        this.log('debug', 'Filtering system_information document from user list', {
          documentId: doc.id,
          title: data.title,
          category: data.category
        });
        return; // Skip this document
      }

      documents.push({
        id: doc.id,
        title: data.title,
        category: data.category,
        priority: data.priority,
        enabled: data.enabled,
        tags: data.tags
      });
    });

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / validatedLimit);
    const hasNextPage = validatedPage < totalPages;
    const hasPrevPage = validatedPage > 1;

    const pagination = {
      currentPage: validatedPage,
      totalPages,
      totalRecords: totalCount,
      recordsPerPage: validatedLimit,
      hasNextPage,
      hasPrevPage,
      nextPage: hasNextPage ? validatedPage + 1 : null,
      prevPage: hasPrevPage ? validatedPage - 1 : null
    };

    // Format as user-friendly text instead of raw JSON
    let formattedResult = `📚 **Knowledge Base Documents**\n\n`;
    formattedResult += `📄 **Page:** ${pagination.currentPage} of ${pagination.totalPages}\n`;
    formattedResult += `📈 **Total Documents:** ${pagination.totalRecords} (showing ${documents.length} on this page)\n`;
    if (category) {
      formattedResult += `🏷️ **Category:** ${category}\n`;
    }
    formattedResult += `\n---\n\n`;

    documents.forEach((doc, index) => {
      const num = (validatedPage - 1) * validatedLimit + index + 1;
      formattedResult += `${num}. **${doc.title}**\n`;
      formattedResult += `   - ID: \`${doc.id}\`\n`;
      formattedResult += `   - Category: ${doc.category}\n`;
      formattedResult += `   - Priority: ${doc.priority}\n`;
      if (doc.tags && doc.tags.length > 0) {
        formattedResult += `   - Tags: ${doc.tags.join(', ')}\n`;
      }
      formattedResult += `\n`;
    });

    // Add pagination navigation if applicable
    if (pagination.totalPages > 1) {
      formattedResult += '\n---\n\n';
      formattedResult += '**📖 Navigation:**\n';

      const navButtons = [];
      if (pagination.hasPrevPage) {
        navButtons.push(`◀️ Previous (Page ${pagination.prevPage})`);
      }
      navButtons.push(`📍 Page ${pagination.currentPage}/${pagination.totalPages}`);
      if (pagination.hasNextPage) {
        navButtons.push(`Next (Page ${pagination.nextPage}) ▶️`);
      }

      formattedResult += navButtons.join(' | ') + '\n\n';

      formattedResult += '**How to navigate:**\n';
      if (pagination.hasPrevPage) {
        formattedResult += `- Previous page: "List knowledge base documents page ${pagination.prevPage}"\n`;
      }
      if (pagination.hasNextPage) {
        formattedResult += `- Next page: "List knowledge base documents page ${pagination.nextPage}"\n`;
      }
      if (pagination.totalPages > 2) {
        formattedResult += `- Specific page: "List knowledge base documents page [1-${pagination.totalPages}]"\n`;
      }
    }

    formattedResult += '\n**💡 Next Steps:**\n';
    formattedResult += '- To view a document: "Show knowledge base document [ID]"\n';
    formattedResult += '- To search: "Search knowledge base for [query]"\n';
    formattedResult += '- To add new: "Add to knowledge base [content]"\n';

    return formattedResult;
  }

  /**
   * Extract intelligent search keywords from various sources
   */
  extractSearchKeywords(searchTerm, searchTerms, tags) {
    const keywords = new Set();
    
    // Add primary search term
    if (searchTerm) {
      keywords.add(searchTerm.toLowerCase());
      
      // Extract individual words from search term
      const words = searchTerm.toLowerCase().match(/\b\w{3,}\b/g) || [];
      words.forEach(word => keywords.add(word));
    }
    
    // Add search terms array
    if (searchTerms && Array.isArray(searchTerms)) {
      searchTerms.forEach(term => {
        if (term) {keywords.add(term.toLowerCase());}
      });
    }
    
    // Add explicit tags
    if (tags && Array.isArray(tags)) {
      tags.forEach(tag => {
        if (tag) {keywords.add(tag.toLowerCase());}
      });
    }
    
    // Intelligent keyword expansion for common terms
    const expansions = {
      'walk': ['walking', 'walk', 'event', 'route', 'map'],
      'map': ['route', 'direction', 'path', 'location', 'geography'],
      'link': ['url', 'website', 'reference', 'resource'],
      'xrp': ['crypto', 'cryptocurrency', 'ripple', 'blockchain'],
      'event': ['walk', 'challenge', 'activity', 'race'],
      'gramercy': ['park', 'neighborhood', 'manhattan', 'nyc', 'new york']
    };
    
    keywords.forEach(keyword => {
      if (expansions[keyword]) {
        expansions[keyword].forEach(expansion => keywords.add(expansion));
      }
    });
    
    return Array.from(keywords);
  }

  calculateRelevance(query, document, searchKeywords = []) {
    const queryLower = query.toLowerCase();
    let score = 0;

    // Title match (highest weight)
    if (document.title.toLowerCase().includes(queryLower)) {
      score += 1.0;
    }

    // Enhanced tag matching with intelligent keywords
    if (document.tags && document.tags.length > 0) {
      // Direct tag match
      const directTagMatch = document.tags.some(tag =>
        tag.toLowerCase().includes(queryLower) || queryLower.includes(tag.toLowerCase())
      );
      if (directTagMatch) {
        score += 0.8;
      }
      
      // Intelligent keyword-to-tag matching
      const keywordTagMatch = searchKeywords.some(keyword =>
        document.tags.some(tag => 
          tag.toLowerCase().includes(keyword) || keyword.includes(tag.toLowerCase())
        )
      );
      if (keywordTagMatch && !directTagMatch) {
        score += 0.6; // Lower than direct match but still significant
      }
    }

    // Search terms match
    if (document.searchTerms && document.searchTerms.some(term =>
      term.toLowerCase().includes(queryLower) || queryLower.includes(term.toLowerCase())
    )) {
      score += 0.7;
    }

    // Enhanced content matching with keyword intelligence
    let contentMatches = 0;
    if (document.content.toLowerCase().includes(queryLower)) {
      contentMatches++;
      score += 0.5;
    }
    
    // Additional content matches for keywords
    searchKeywords.forEach(keyword => {
      if (document.content.toLowerCase().includes(keyword)) {
        contentMatches++;
      }
    });
    
    // Bonus for multiple content matches
    if (contentMatches > 1) {
      score += Math.min(contentMatches * 0.1, 0.3); // Cap at 0.3 bonus
    }

    // Priority boost
    score += (document.priority || 0) / 200;

    // Category relevance boost for specific searches
    if (document.category === 'geographic' && 
        (queryLower.includes('map') || queryLower.includes('location') || queryLower.includes('area'))) {
      score += 0.2;
    }

    return score;
  }

  // SEMANTIC TRIGGER (CRITICAL - See CLAUDE.md)
  // DO NOT use keyword/regex matching - let Gemini's function calling handle triggering
  // The description field clearly articulates when to use this tool conceptually
  async shouldTrigger() {
    // ❌ REMOVED 65+ regex patterns - brittle, breaks on natural language variations
    // ✅ Gemini's function calling uses the semantic description field for intent detection
    return false; // Let Gemini handle all triggering via description
  }
}

module.exports = KnowledgeManagementTool;