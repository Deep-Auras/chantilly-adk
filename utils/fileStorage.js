/**
 * Google Cloud Storage utility for Chantilly Agent file management
 * Handles .drawio files and future PNG exports
 */

const { Storage } = require('@google-cloud/storage');
const { logger } = require('./logger');
const { getFirestore } = require('../config/firestore');
const path = require('path');

class FileStorageManager {
  constructor() {
    this.storage = null;
    this.bucket = null;
    this.bucketName = null; // Will be loaded from Firestore
    this.initialized = false;
  }

  /**
   * Initialize Google Cloud Storage client and bucket
   */
  async initialize() {
    if (this.initialized) {return;}

    try {
      // Load bucket name from Firestore
      const db = getFirestore();
      const configDoc = await db.collection('agent').doc('config').get();

      if (configDoc.exists && configDoc.data().GCS_BUCKET_NAME) {
        this.bucketName = configDoc.data().GCS_BUCKET_NAME;
      } else {
        this.bucketName = 'chantilly-adk-files'; // Default fallback
      }

      // Initialize Cloud Storage client
      this.storage = new Storage({
        projectId: process.env.GOOGLE_CLOUD_PROJECT
      });

      // Get bucket reference
      this.bucket = this.storage.bucket(this.bucketName);

      // Verify bucket exists (will throw if not found)
      const [exists] = await this.bucket.exists();
      if (!exists) {
        throw new Error(`Bucket ${this.bucketName} does not exist. Please create it in Google Cloud Console.`);
      }

      this.initialized = true;
      logger.info('File storage initialized successfully', {
        bucketName: this.bucketName,
        projectId: process.env.GOOGLE_CLOUD_PROJECT
      });

    } catch (error) {
      logger.error('Failed to initialize file storage', {
        error: error.message,
        bucketName: this.bucketName
      });
      throw error;
    }
  }

  /**
   * Upload a .drawio file to Google Cloud Storage
   * @param {string} xmlContent - Draw.io XML content
   * @param {string} filename - Filename for the file
   * @param {Object} metadata - Additional metadata
   * @returns {Object} - Upload result with public URL
   */
  async uploadDrawioFile(xmlContent, filename, metadata = {}) {
    await this.initialize();

    try {
      // Ensure filename has .drawio extension
      const drawioFilename = filename.endsWith('.drawio') ? filename : `${filename}.drawio`;
      
      // Create file path with timestamp to avoid conflicts
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = `diagrams/${timestamp}_${drawioFilename}`;

      // Create file reference
      const file = this.bucket.file(filePath);

      // Upload content with proper headers for downloading
      await file.save(xmlContent, {
        metadata: {
          contentType: 'application/octet-stream', // Force download instead of display
          contentDisposition: `attachment; filename="${drawioFilename}"`, // Force download with filename
          metadata: {
            ...metadata,
            uploadedBy: 'Chantilly Agent',
            uploadTime: new Date().toISOString(),
            fileType: 'drawio',
            originalFilename: drawioFilename
          }
        }
      });

      // Get public URL (bucket must have public access configured at bucket level)
      const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${filePath}`;
      
      // Note: With uniform bucket-level access, files inherit bucket permissions
      // The bucket should be configured with public read access at the bucket level

      logger.info('Draw.io file uploaded successfully', {
        filename: drawioFilename,
        filePath,
        publicUrl,
        contentLength: xmlContent.length
      });

      return {
        success: true,
        filename: drawioFilename,
        filePath,
        publicUrl,
        size: Buffer.byteLength(xmlContent, 'utf8')
      };

    } catch (error) {
      logger.error('Failed to upload draw.io file', {
        filename,
        error: error.message
      });
      throw new Error(`File upload failed: ${error.message}`);
    }
  }

  /**
   * Upload an HTML report to Google Cloud Storage  
   * @param {string} htmlContent - HTML report content
   * @param {string} filename - Filename for the file
   * @param {Object} metadata - Additional metadata (taskId, templateId, etc.)
   * @returns {Object} - Upload result with public URL
   */
  async uploadHtmlReport(htmlContent, filename, metadata = {}) {
    await this.initialize();

    try {
      // Ensure filename has .html extension
      const htmlFilename = filename.endsWith('.html') ? filename : `${filename}.html`;
      
      // Create file path with timestamp to avoid conflicts
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = `reports/${timestamp}_${htmlFilename}`;

      // Create file reference
      const file = this.bucket.file(filePath);

      // Upload content with proper headers for downloading
      await file.save(htmlContent, {
        metadata: {
          contentType: 'text/html',
          contentDisposition: `attachment; filename="${htmlFilename}"`, // Force download with filename
          metadata: {
            ...metadata,
            uploadedBy: 'Chantilly Agent',
            uploadTime: new Date().toISOString(),
            fileType: 'html_report',
            originalFilename: htmlFilename
          }
        }
      });

      // Get public URL (bucket must have public access configured at bucket level)
      const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${filePath}`;

      logger.info('HTML report uploaded successfully', {
        filename: htmlFilename,
        filePath,
        publicUrl,
        contentLength: htmlContent.length,
        taskId: metadata.taskId
      });

      return {
        filename: htmlFilename,
        filePath,
        publicUrl,
        contentLength: htmlContent.length,
        uploadTime: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Failed to upload HTML report', {
        filename,
        error: error.message,
        taskId: metadata.taskId
      });
      throw error;
    }
  }

  /**
   * Upload a PNG file to Google Cloud Storage (for future PNG export)
   * @param {Buffer} pngBuffer - PNG file buffer
   * @param {string} filename - Filename for the PNG
   * @param {Object} metadata - Additional metadata
   * @returns {Object} - Upload result with public URL
   */
  async uploadPngFile(pngBuffer, filename, metadata = {}) {
    await this.initialize();

    try {
      // Ensure filename has .png extension
      const pngFilename = filename.endsWith('.png') ? filename : `${filename}.png`;
      
      // Create file path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = `images/${timestamp}_${pngFilename}`;

      // Create file reference
      const file = this.bucket.file(filePath);

      // Upload buffer
      await file.save(pngBuffer, {
        metadata: {
          contentType: 'image/png',
          metadata: {
            ...metadata,
            uploadedBy: 'Chantilly Agent',
            uploadTime: new Date().toISOString(),
            fileType: 'png',
            originalFilename: pngFilename
          }
        }
      });

      // Get public URL (bucket must have public access configured at bucket level)
      const publicUrl = `https://storage.googleapis.com/${this.bucketName}/${filePath}`;
      
      // Note: With uniform bucket-level access, files inherit bucket permissions

      logger.info('PNG file uploaded successfully', {
        filename: pngFilename,
        filePath,
        publicUrl,
        size: pngBuffer.length
      });

      return {
        success: true,
        filename: pngFilename,
        filePath,
        publicUrl,
        size: pngBuffer.length
      };

    } catch (error) {
      logger.error('Failed to upload PNG file', {
        filename,
        error: error.message
      });
      throw new Error(`PNG upload failed: ${error.message}`);
    }
  }

  /**
   * Delete a file from Google Cloud Storage
   * @param {string} filePath - Path to file in bucket
   * @returns {boolean} - Success status
   */
  async deleteFile(filePath) {
    await this.initialize();

    try {
      const file = this.bucket.file(filePath);
      await file.delete();

      logger.info('File deleted successfully', { filePath });
      return true;

    } catch (error) {
      logger.error('Failed to delete file', {
        filePath,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Clean up old files (older than specified days)
   * @param {number} olderThanDays - Delete files older than this many days
   * @returns {number} - Number of files deleted
   */
  async cleanupOldFiles(olderThanDays = 7) {
    await this.initialize();

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const [files] = await this.bucket.getFiles({
        prefix: 'diagrams/'
      });

      let deletedCount = 0;

      for (const file of files) {
        const [metadata] = await file.getMetadata();
        const createdDate = new Date(metadata.timeCreated);

        if (createdDate < cutoffDate) {
          await file.delete();
          deletedCount++;
          logger.debug('Deleted old file', {
            filename: file.name,
            created: createdDate.toISOString()
          });
        }
      }

      logger.info('File cleanup completed', {
        deletedCount,
        olderThanDays
      });

      return deletedCount;

    } catch (error) {
      logger.error('File cleanup failed', {
        error: error.message,
        olderThanDays
      });
      return 0;
    }
  }

  /**
   * Get file storage statistics
   * @returns {Object} - Storage statistics
   */
  async getStorageStats() {
    await this.initialize();

    try {
      const [files] = await this.bucket.getFiles();
      
      let totalSize = 0;
      let drawioCount = 0;
      let pngCount = 0;

      for (const file of files) {
        const [metadata] = await file.getMetadata();
        totalSize += parseInt(metadata.size || 0);

        if (file.name.endsWith('.drawio')) {
          drawioCount++;
        } else if (file.name.endsWith('.png')) {
          pngCount++;
        }
      }

      return {
        totalFiles: files.length,
        totalSize,
        drawioFiles: drawioCount,
        pngFiles: pngCount,
        bucketName: this.bucketName
      };

    } catch (error) {
      logger.error('Failed to get storage stats', {
        error: error.message
      });
      return null;
    }
  }
}

// Export singleton instance
const fileStorageManager = new FileStorageManager();

module.exports = {
  FileStorageManager,
  fileStorageManager,
  uploadDrawioFile: (content, filename, metadata) => 
    fileStorageManager.uploadDrawioFile(content, filename, metadata),
  uploadPngFile: (buffer, filename, metadata) => 
    fileStorageManager.uploadPngFile(buffer, filename, metadata),
  deleteFile: (filePath) => fileStorageManager.deleteFile(filePath),
  cleanupOldFiles: (days) => fileStorageManager.cleanupOldFiles(days),
  getStorageStats: () => fileStorageManager.getStorageStats()
};