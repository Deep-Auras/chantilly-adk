const { getFirestore, getFieldValue } = require('../config/firestore');
const { logger } = require('../utils/logger');

class KnowledgeBaseService {
  constructor() {
    this.db = null;
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes
    this.lastCacheUpdate = null;

    // SECURITY: Valid categories whitelist to prevent NoSQL injection
    this.VALID_CATEGORIES = ['hr', 'it', 'policies', 'processes', 'general', 'api', 'security', 'compliance'];
    this.VALID_PRIORITIES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
  }

  // SECURITY: Validate category parameter
  validateCategory(category) {
    if (!category) {return null;} // Optional parameter

    if (typeof category !== 'string') {
      throw new Error('Category must be a string');
    }

    if (!this.VALID_CATEGORIES.includes(category)) {
      throw new Error(`Invalid category. Must be one of: ${this.VALID_CATEGORIES.join(', ')}`);
    }

    return category;
  }

  // SECURITY: Validate priority parameter
  validatePriority(priority) {
    if (priority === undefined || priority === null) {return null;}

    const numPriority = parseInt(priority);
    if (isNaN(numPriority) || numPriority < 0 || numPriority > 100) {
      throw new Error('Priority must be a number between 0 and 100');
    }

    return numPriority;
  }

  // SECURITY: Validate string input to prevent injection
  validateString(value, fieldName, maxLength = 10000) {
    if (!value) {
      throw new Error(`${fieldName} is required`);
    }

    if (typeof value !== 'string') {
      throw new Error(`${fieldName} must be a string`);
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(`${fieldName} cannot be empty`);
    }

    if (trimmed.length > maxLength) {
      throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
    }

    return trimmed;
  }

  async initialize() {
    this.db = getFirestore();
    await this.loadCache();
    logger.info('Knowledge base service initialized');
  }

  async loadCache() {
    try {
      // CRITICAL FIX: Load ALL entries (enabled and disabled) for dashboard CRUD
      // The cache is used by both AI queries (need enabled only) and dashboard (needs all)
      const snapshot = await this.db
        .collection('knowledge-base')
        .orderBy('priority', 'desc')
        .get();

      this.cache.clear();
      snapshot.forEach(doc => {
        const data = doc.data();
        this.cache.set(doc.id, {
          id: doc.id,
          title: data.title,
          content: data.content,
          tags: data.tags || [],
          category: data.category,
          priority: data.priority || 0,
          searchTerms: data.searchTerms || [],
          enabled: data.enabled !== false, // Default to true if not set
          lastUpdated: data.lastUpdated
        });
      });

      this.lastCacheUpdate = Date.now();
      logger.info(`Loaded ${this.cache.size} knowledge base entries`);
    } catch (error) {
      logger.error('Failed to load knowledge base cache', error);
    }
  }

  async refreshCacheIfNeeded() {
    const now = Date.now();
    if (!this.lastCacheUpdate || (now - this.lastCacheUpdate) > this.cacheTimeout) {
      await this.loadCache();
    }
  }

  async searchKnowledge(query, options = {}) {
    await this.refreshCacheIfNeeded();

    // SECURITY: Validate query parameter
    if (!query || typeof query !== 'string') {
      throw new Error('Search query must be a non-empty string');
    }

    if (query.trim().length === 0) {
      throw new Error('Search query cannot be empty');
    }

    const {
      maxResults = 3,
      category = null,
      includeContent = true,
      minRelevance = 0.3
    } = options;

    // SECURITY: Validate category if provided
    const validatedCategory = this.validateCategory(category);

    const queryLower = query.toLowerCase();
    const results = [];

    for (const [id, entry] of this.cache) {
      let score = 0;

      // CRITICAL: Only search enabled entries for AI queries
      if (!entry.enabled) {
        continue;
      }

      // Skip if category filter doesn't match
      if (validatedCategory && entry.category !== validatedCategory) {
        continue;
      }

      // Title match (highest weight)
      if (entry.title.toLowerCase().includes(queryLower)) {
        score += 1.0;
      }

      // Tags match (high weight)
      const matchingTags = entry.tags.filter(tag =>
        tag.toLowerCase().includes(queryLower) ||
        queryLower.includes(tag.toLowerCase())
      );
      score += matchingTags.length * 0.8;

      // Search terms match (high weight)
      const matchingSearchTerms = entry.searchTerms.filter(term =>
        term.toLowerCase().includes(queryLower) ||
        queryLower.includes(term.toLowerCase())
      );
      score += matchingSearchTerms.length * 0.7;

      // Content match (lower weight)
      if (entry.content.toLowerCase().includes(queryLower)) {
        score += 0.5;
      }

      // Word-level matching for better relevance
      const queryWords = queryLower.split(' ').filter(w => w.length > 2);
      queryWords.forEach(word => {
        if (entry.title.toLowerCase().includes(word)) {score += 0.3;}
        if (entry.tags.some(tag => tag.toLowerCase().includes(word))) {score += 0.2;}
        if (entry.content.toLowerCase().includes(word)) {score += 0.1;}
      });

      if (score >= minRelevance) {
        results.push({
          ...entry,
          relevanceScore: score,
          content: includeContent ? entry.content : undefined
        });
      }
    }

    // Sort by relevance score and priority
    results.sort((a, b) => {
      if (Math.abs(a.relevanceScore - b.relevanceScore) < 0.1) {
        return b.priority - a.priority; // Higher priority first if scores are close
      }
      return b.relevanceScore - a.relevanceScore;
    });

    return results.slice(0, maxResults);
  }

  async addKnowledge(entry) {
    try {
      // SECURITY: Validate all input fields
      const validatedTitle = this.validateString(entry.title, 'Title', 200);
      const validatedContent = this.validateString(entry.content, 'Content', 50000);
      const validatedCategory = this.validateCategory(entry.category || 'general');
      const validatedPriority = this.validatePriority(entry.priority !== undefined ? entry.priority : 50);

      // SECURITY: Sanitize and validate tags array
      let validatedTags = [];
      if (entry.tags && Array.isArray(entry.tags)) {
        validatedTags = entry.tags
          .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
          .map(tag => tag.trim())
          .slice(0, 20); // Limit to 20 tags
      }

      // SECURITY: Sanitize and validate search terms array
      let validatedSearchTerms = [];
      if (entry.searchTerms && Array.isArray(entry.searchTerms)) {
        validatedSearchTerms = entry.searchTerms
          .filter(term => typeof term === 'string' && term.trim().length > 0)
          .map(term => term.trim())
          .slice(0, 50); // Limit to 50 search terms
      }

      const knowledgeEntry = {
        title: validatedTitle,
        content: validatedContent,
        tags: validatedTags,
        category: validatedCategory,
        priority: validatedPriority,
        searchTerms: validatedSearchTerms,
        enabled: entry.enabled !== false,
        createdAt: getFieldValue().serverTimestamp(),
        lastUpdated: getFieldValue().serverTimestamp()
      };

      const docRef = await this.db.collection('knowledge-base').add(knowledgeEntry);

      // Update cache
      this.cache.set(docRef.id, {
        id: docRef.id,
        ...knowledgeEntry,
        createdAt: new Date(),
        lastUpdated: new Date()
      });

      logger.info('Knowledge entry added', { id: docRef.id, title: entry.title });
      return docRef.id;
    } catch (error) {
      logger.error('Failed to add knowledge entry', error);
      throw error;
    }
  }

  async updateKnowledge(id, updates) {
    try {
      // SECURITY: Validate document ID
      if (!id || typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('Document ID must be a non-empty string');
      }

      // SECURITY: Validate update fields if present
      const validatedUpdates = {};

      if (updates.title !== undefined) {
        validatedUpdates.title = this.validateString(updates.title, 'Title', 200);
      }

      if (updates.content !== undefined) {
        validatedUpdates.content = this.validateString(updates.content, 'Content', 50000);
      }

      if (updates.category !== undefined) {
        validatedUpdates.category = this.validateCategory(updates.category);
      }

      if (updates.priority !== undefined) {
        validatedUpdates.priority = this.validatePriority(updates.priority);
      }

      if (updates.tags !== undefined) {
        if (!Array.isArray(updates.tags)) {
          throw new Error('Tags must be an array');
        }
        validatedUpdates.tags = updates.tags
          .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
          .map(tag => tag.trim())
          .slice(0, 20);
      }

      if (updates.searchTerms !== undefined) {
        if (!Array.isArray(updates.searchTerms)) {
          throw new Error('Search terms must be an array');
        }
        validatedUpdates.searchTerms = updates.searchTerms
          .filter(term => typeof term === 'string' && term.trim().length > 0)
          .map(term => term.trim())
          .slice(0, 50);
      }

      if (updates.enabled !== undefined) {
        validatedUpdates.enabled = Boolean(updates.enabled);
      }

      const updateData = {
        ...validatedUpdates,
        lastUpdated: getFieldValue().serverTimestamp()
      };

      await this.db.collection('knowledge-base').doc(id.trim()).update(updateData);

      // Update cache
      if (this.cache.has(id)) {
        this.cache.set(id, {
          ...this.cache.get(id),
          ...updates,
          lastUpdated: new Date()
        });
      }

      logger.info('Knowledge entry updated', { id, updates: Object.keys(updates) });
      return true;
    } catch (error) {
      logger.error('Failed to update knowledge entry', { id, error: error.message });
      throw error;
    }
  }

  async deleteKnowledge(id) {
    try {
      // SECURITY: Validate document ID
      if (!id || typeof id !== 'string' || id.trim().length === 0) {
        throw new Error('Document ID must be a non-empty string');
      }

      await this.db.collection('knowledge-base').doc(id.trim()).delete();
      this.cache.delete(id);
      logger.info('Knowledge entry deleted', { id });
      return true;
    } catch (error) {
      logger.error('Failed to delete knowledge entry', { id, error: error.message });
      throw error;
    }
  }

  async getKnowledge(id) {
    await this.refreshCacheIfNeeded();

    // SECURITY: Validate document ID
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('Document ID must be a non-empty string');
    }

    return this.cache.get(id) || null;
  }

  async getAllKnowledge(options = {}) {
    await this.refreshCacheIfNeeded();

    const { category = null, enabled = true } = options;

    // SECURITY: Validate category if provided
    const validatedCategory = this.validateCategory(category);

    let results = Array.from(this.cache.values());

    if (validatedCategory) {
      results = results.filter(entry => entry.category === validatedCategory);
    }

    if (enabled !== null) {
      results = results.filter(entry => entry.enabled === enabled);
    }

    return results.sort((a, b) => b.priority - a.priority);
  }

  async getCategories() {
    await this.refreshCacheIfNeeded();
    const categories = new Set();

    for (const entry of this.cache.values()) {
      if (entry.category) {
        categories.add(entry.category);
      }
    }

    return Array.from(categories).sort();
  }

  getRelevantKnowledgePrompt(searchResults) {
    if (!searchResults || searchResults.length === 0) {
      return '';
    }

    let prompt = '\n\nRELEVANT KNOWLEDGE BASE INFORMATION:\n';

    searchResults.forEach((result, index) => {
      prompt += `\n${index + 1}. **${result.title}** (Category: ${result.category})\n`;
      prompt += `${result.content}\n`;
      if (result.tags.length > 0) {
        prompt += `Tags: ${result.tags.join(', ')}\n`;
      }
    });

    prompt += '\n\nIMPORTANT: This knowledge base information is highly relevant to the user\'s question. Use this detailed information as the primary source for your response. Provide comprehensive, specific, actionable guidance based on this content rather than giving generic answers.';

    return prompt;
  }

  async getStats() {
    await this.refreshCacheIfNeeded();

    const stats = {
      totalEntries: this.cache.size,
      enabledEntries: 0,
      categories: new Set(),
      lastCacheUpdate: this.lastCacheUpdate
    };

    for (const entry of this.cache.values()) {
      if (entry.enabled) {stats.enabledEntries++;}
      if (entry.category) {stats.categories.add(entry.category);}
    }

    stats.categories = Array.from(stats.categories);
    return stats;
  }
}

// Singleton instance
let knowledgeBaseService;

async function initializeKnowledgeBase() {
  if (!knowledgeBaseService) {
    knowledgeBaseService = new KnowledgeBaseService();
    await knowledgeBaseService.initialize();
  }
  return knowledgeBaseService;
}

function getKnowledgeBase() {
  if (!knowledgeBaseService) {
    throw new Error('Knowledge base service not initialized');
  }
  return knowledgeBaseService;
}

module.exports = {
  KnowledgeBaseService,
  initializeKnowledgeBase,
  getKnowledgeBase
};