/**
 * Google Doc Importer Tool
 * Imports Google Docs, converts them to Markdown, and saves them to the Knowledge Base.
 */

const { getGoogleDocsService } = require('../services/googleDocsService');
const { getKnowledgeBase, initializeKnowledgeBase } = require('../services/knowledgeBase');
const { logger } = require('../utils/logger');

class GoogleDocImporter {
  constructor() {
    this.docsService = getGoogleDocsService();
    this.kbService = null;
  }

  /**
   * Ensure KnowledgeBase service is ready
   */
  async getKbService() {
    if (this.kbService) return this.kbService;

    try {
      this.kbService = getKnowledgeBase();
    } catch (error) {
      logger.info('Initializing KnowledgeBase service for importer...');
      this.kbService = await initializeKnowledgeBase();
    }
    return this.kbService;
  }

  /**
   * Import a Google Doc into the Knowledge Base
   * @param {string} documentId - The Google Doc ID
   * @param {string} category - Target KB category (default: 'general')
   * @param {Array<string>} tags - Optional tags
   */
  async importDocument(documentId, category = 'general', tags = []) {
    try {
      const kbService = await this.getKbService();
      logger.info('Starting Google Doc import', { documentId });

      // 1. Fetch Document
      const doc = await this.docsService.getDocument(documentId);
      const title = doc.title;
      
      if (!title) {
        throw new Error('Document has no title');
      }

      // 2. Convert to Markdown
      const markdown = this.convertToMarkdown(doc);

      // 3. Save to Knowledge Base
      // Check if exists first (exact title match)
      // We use searchKnowledge but filter for exact title to avoid fuzzy dupes
      const searchResults = await kbService.searchKnowledge(title, { 
        includeContent: false,
        maxResults: 10 
      });
      
      const existing = searchResults.find(d => d.title === title);

      let result;
      if (existing) {
        logger.info('Updating existing KB document', { title, id: existing.id });
        
        // Merge tags
        const newTags = [...new Set([...(existing.tags || []), ...tags])];
        
        await kbService.updateKnowledge(existing.id, {
          content: markdown,
          category, // Update category to requested
          tags: newTags,
          lastUpdated: new Date()
        });
        result = { action: 'updated', id: existing.id, title };
      } else {
        logger.info('Creating new KB document', { title });
        const id = await kbService.addKnowledge({
          title,
          content: markdown,
          category,
          tags,
          priority: 50, // Default priority
          enabled: true
        });
        result = { action: 'created', id, title };
      }

      logger.info('Import completed successfully', { title, action: result.action });
      return result;

    } catch (error) {
      logger.error('Google Doc import failed', { documentId, error: error.message });
      throw error;
    }
  }

  /**
   * Converts Google Doc JSON structure to Markdown
   * @param {Object} doc - Google Doc Object
   * @returns {string} Markdown string
   */
  convertToMarkdown(doc) {
    let content = [];
    const body = doc.body.content;

    if (body) {
        for (const el of body) {
        if (el.paragraph) {
            content.push(this.processParagraph(el.paragraph));
        } else if (el.table) {
            content.push(this.processTable(el.table));
        } else if (el.sectionBreak) {
            // Handle section breaks if needed, currently ignored
        }
        }
    }

    return content.join('\n\n');
  }

  processParagraph(paragraph) {
    const styleType = paragraph.paragraphStyle.namedStyleType;
    let prefix = '';
    
    // Handle Headings
    switch (styleType) {
      case 'HEADING_1': prefix = '# '; break;
      case 'HEADING_2': prefix = '## '; break;
      case 'HEADING_3': prefix = '### '; break;
      case 'HEADING_4': prefix = '#### '; break;
      case 'HEADING_5': prefix = '##### '; break;
      case 'HEADING_6': prefix = '###### '; break;
    }

    // Handle Lists
    if (paragraph.bullet) {
      const level = paragraph.bullet.nestingLevel || 0;
      const indent = '  '.repeat(level);
      // Determine list type (glyph) could be complex, defaulting to bullet for simplicity
      prefix = `${indent}- `; 
    }

    const text = paragraph.elements.map(e => this.processTextRun(e)).join('');
    
    // If it's empty/whitespace, return empty string (unless it's a spacer)
    if (!text.trim()) return '';

    return `${prefix}${text}`;
  }

  processTextRun(element) {
    if (!element.textRun) return '';
    
    let text = element.textRun.content;
    const style = element.textRun.textStyle;

    if (!style) return text;

    // Remove trailing newlines from runs to avoid breaking markdown flow
    text = text.replace(/\n$/, '');
    if (!text) return '';

    // Apply Styles
    if (style.bold) text = `**${text}**`;
    if (style.italic) text = `*${text}*`;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.code) text = `\`${text}\``;
    
    // Handle Links
    if (style.link && style.link.url) {
      text = `[${text}](${style.link.url})`;
    }

    return text;
  }

  processTable(table) {
    // Markdown tables are simple: | Header | Header |
    // Google Docs tables are complex. We will attempt a best-effort flat render.
    if (!table.tableRows || table.tableRows.length === 0) return '';

    const rows = table.tableRows.map((row, rowIndex) => {
      const cells = row.tableCells.map(cell => {
        // Flatten cell content (paragraphs) into a single line string
        return cell.content
          .map(c => {
             if (c.paragraph) {
                 return c.paragraph.elements.map(e => this.processTextRun(e)).join('').trim();
             }
             return '';
          })
          .filter(t => t)
          .join('<br>'); // Use HTML break for multi-line cell content
      });
      return `| ${cells.join(' | ')} |`;
    });

    // Construct Header Separator (assuming first row is header)
    // If not, markdown tables still require a header separator after the first row
    const colCount = table.columns || table.tableRows[0].tableCells.length;
    const separator = `| ${Array(colCount).fill('---').join(' | ')} |`;

    // Insert separator after first row
    rows.splice(1, 0, separator);

    return rows.join('\n');
  }
}

// Singleton or Factory export
const importer = new GoogleDocImporter();
module.exports = { getGoogleDocImporter: () => importer, GoogleDocImporter };
