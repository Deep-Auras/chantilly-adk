/**
 * Google Docs Service
 * Handles programmatic document creation, editing, and management.
 * Bridges Google Docs API (content) and Google Drive API (file management).
 * 
 * References:
 * - https://developers.google.com/workspace/docs/api/how-tos/overview
 * - https://developers.google.com/workspace/docs/api/how-tos/documents
 */

const { google } = require('googleapis');
const { logger } = require('../utils/logger');

class GoogleDocsService {
  constructor() {
    this.docs = null;
    this.drive = null;
    this.initialized = false;
  }

  /**
   * Initialize the service with Google Auth (ADC)
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // Scopes required for both content editing and file management
      const auth = new google.auth.GoogleAuth({
        scopes: [
          'https://www.googleapis.com/auth/documents',
          'https://www.googleapis.com/auth/drive' // Required for file operations (copy, move)
        ]
      });

      const authClient = await auth.getClient();

      this.docs = google.docs({ version: 'v1', auth: authClient });
      this.drive = google.drive({ version: 'v3', auth: authClient });

      this.initialized = true;
      logger.info('Google Docs service initialized');
    } catch (error) {
      logger.error('Failed to initialize Google Docs service', { error: error.message });
      throw error;
    }
  }

  /**
   * Create a new blank document
   * NOTE: Created in root folder by default
   * @param {string} title - Document title
   * @returns {Promise<Object>} Created document object
   */
  async createDocument(title) {
    await this.initialize();
    try {
      const res = await this.docs.documents.create({
        requestBody: {
          title: title || 'Untitled Document'
        }
      });
      logger.info('Created Google Doc', { documentId: res.data.documentId, title });
      return res.data;
    } catch (error) {
      logger.error('Failed to create document', { error: error.message });
      throw error;
    }
  }

  /**
   * Create a document directly inside a specific folder
   * (Combines Create + Move operations)
   * @param {string} title - Document title
   * @param {string} folderId - Target Google Drive folder ID
   * @returns {Promise<Object>} Created document object
   */
  async createInFolder(title, folderId) {
    await this.initialize();
    try {
      // 1. Create document (lands in root)
      const doc = await this.createDocument(title);
      const fileId = doc.documentId;

      // 2. Move to target folder
      // Fetch current parents to remove them
      const file = await this.drive.files.get({
        fileId: fileId,
        fields: 'parents'
      });

      const previousParents = file.data.parents ? file.data.parents.join(',') : '';

      await this.drive.files.update({
        fileId: fileId,
        addParents: folderId,
        removeParents: previousParents,
        fields: 'id, parents'
      });

      logger.info('Moved document to folder', { documentId: fileId, folderId });
      return doc;
    } catch (error) {
      logger.error('Failed to create document in folder', { error: error.message, folderId });
      throw error;
    }
  }

  /**
   * Get full document structure
   * @param {string} documentId 
   * @returns {Promise<Object>} Document resource
   */
  async getDocument(documentId) {
    await this.initialize();
    try {
      const res = await this.docs.documents.get({
        documentId: documentId
      });
      return res.data;
    } catch (error) {
      logger.error('Failed to get document', { documentId, error: error.message });
      throw error;
    }
  }

  /**
   * Copy an existing document (Template pattern)
   * Uses Drive API as Docs API cannot copy files
   * @param {string} originFileId - Source document ID
   * @param {string} copyTitle - Title for the new copy
   * @returns {Promise<Object>} New file metadata
   */
  async copyDocument(originFileId, copyTitle) {
    await this.initialize();
    try {
      const res = await this.drive.files.copy({
        fileId: originFileId,
        requestBody: {
          name: copyTitle,
          mimeType: 'application/vnd.google-apps.document'
        }
      });
      logger.info('Copied document', { originId: originFileId, newId: res.data.id });
      return res.data;
    } catch (error) {
      logger.error('Failed to copy document', { originFileId, error: error.message });
      throw error;
    }
  }

  /**
   * Execute batch updates on a document
   * Primary method for content editing
   * @param {string} documentId 
   * @param {Array<Object>} requests - List of Request objects
   * @returns {Promise<Object>} BatchUpdate response
   */
  async batchUpdate(documentId, requests) {
    await this.initialize();
    if (!requests || requests.length === 0) return null;

    try {
      const res = await this.docs.documents.batchUpdate({
        documentId: documentId,
        requestBody: {
          requests: requests
        }
      });
      logger.info('Executed batch update', { documentId, requestCount: requests.length });
      return res.data;
    } catch (error) {
      logger.error('Failed to batch update document', { documentId, error: error.message });
      throw error;
    }
  }

  /**
   * Helper: Replace text placeholders (e.g. {{NAME}})
   * @param {string} documentId 
   * @param {Object} replacements - Key-value pairs { "{{KEY}}": "Value" }
   */
  async replaceText(documentId, replacements) {
    const requests = Object.entries(replacements).map(([key, value]) => ({
      replaceAllText: {
        containsText: {
          text: key,
          matchCase: true
        },
        replaceText: String(value)
      }
    }));

    return this.batchUpdate(documentId, requests);
  }

  /**
   * Helper: Append text to the end of the document
   * Requires fetching document first to find end index
   * @param {string} documentId 
   * @param {string} text 
   */
  async appendText(documentId, text) {
    await this.initialize();
    try {
      const doc = await this.getDocument(documentId);
      const content = doc.body.content;
      // The last element is always a SectionBreak (newline), insert before it
      const lastIndex = content[content.length - 1].endIndex;

      const requests = [{
        insertText: {
          text: text,
          location: {
            index: lastIndex - 1
          }
        }
      }];

      return await this.batchUpdate(documentId, requests);
    } catch (error) {
      logger.error('Failed to append text', { documentId, error: error.message });
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

function getGoogleDocsService() {
  if (!instance) {
    instance = new GoogleDocsService();
  }
  return instance;
}

module.exports = { getGoogleDocsService };
