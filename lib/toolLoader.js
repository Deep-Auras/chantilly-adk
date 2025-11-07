const fs = require('fs').promises;
const path = require('path');
const { logger } = require('../utils/logger');
const { getFirestore } = require('../config/firestore');
const BaseTool = require('./baseTool');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.loadedFiles = new Set();
  }

  register(tool) {
    if (!(tool instanceof BaseTool)) {
      throw new Error('Tool must extend BaseTool class');
    }

    this.tools.set(tool.name, tool);
    logger.info('Tool registered', {
      name: tool.name,
      description: tool.description,
      category: tool.category
    });
  }

  async unregister(toolName) {
    const tool = this.tools.get(toolName);
    if (tool) {
      try {
        await tool.cleanup();
        logger.info('Tool cleanup successful', { tool: toolName });
      } catch (err) {
        logger.warn('Tool cleanup failed', {
          tool: toolName,
          error: err.message,
          stack: err.stack
        });
      }
      this.tools.delete(toolName);
      logger.info('Tool unregistered', { name: toolName });
    }
  }

  getTool(toolName) {
    return this.tools.get(toolName);
  }

  getAllTools() {
    return Array.from(this.tools.values());
  }

  getEnabledTools() {
    return Array.from(this.tools.values()).filter(tool => tool.enabled);
  }

  /**
   * Get tools available to a specific user role (RBAC)
   * Filters tools based on role-based access control configuration
   *
   * @param {string} userRole - User role ('user' or 'admin')
   * @returns {Array} - Array of tools accessible to this role
   */
  getToolsForUser(userRole = 'user') {
    const { hasAccess } = require('../config/toolAccessControl');

    return Array.from(this.tools.values()).filter(tool => {
      // First check if tool is enabled
      if (!tool.enabled) {
        return false;
      }

      // Check role-based access
      const hasRoleAccess = hasAccess(tool.name, userRole);

      // If access denied, log for debugging
      if (!hasRoleAccess) {
        logger.debug('Tool filtered due to role restrictions', {
          toolName: tool.name,
          userRole,
          toolEnabled: tool.enabled
        });
      }

      return hasRoleAccess;
    });
  }

  getToolsByCategory(category) {
    return Array.from(this.tools.values()).filter(tool => tool.category === category);
  }

  getToolsMetadata() {
    return Array.from(this.tools.values()).map(tool => tool.getMetadata());
  }

  async clear() {
    const toolNames = Array.from(this.tools.keys());
    logger.info('Clearing all tools', { count: toolNames.length });

    // Create array of cleanup promises
    const cleanupPromises = Array.from(this.tools.values()).map(tool =>
      tool.cleanup()
        .then(() => ({ status: 'fulfilled', tool: tool.name }))
        .catch(err => ({
          status: 'rejected',
          tool: tool.name,
          error: err.message
        }))
    );

    // Wait for all cleanups (success or failure)
    const results = await Promise.allSettled(cleanupPromises);

    // Log results
    const failed = results.filter(r => r.value?.status === 'rejected');
    if (failed.length > 0) {
      logger.warn('Some tool cleanups failed', {
        failed: failed.map(f => f.value)
      });
    }

    this.tools.clear();
    this.loadedFiles.clear();
    logger.info('Tool registry cleared');
  }
}

class ToolLoader {
  constructor() {
    this.registry = new ToolRegistry();
    this.toolsDirectory = path.join(process.cwd(), 'tools');
    this.watching = false;
  }

  async loadTools() {
    try {
      // Ensure tools directory exists
      await this.ensureDirectoryExists(this.toolsDirectory);

      // Load all tools from the tools directory
      await this.loadFromDirectory(this.toolsDirectory, 'tools');

      // Initialize all tools
      await this.initializeTools();

      // Validate tool access control configuration
      const { validateConfiguration } = require('../config/toolAccessControl');
      const registeredToolNames = this.registry.getAllTools().map(t => t.name);
      validateConfiguration(registeredToolNames, logger);

      logger.info('All tools loaded', {
        totalTools: this.registry.tools.size,
        enabledTools: this.registry.getEnabledTools().length
      });
    } catch (error) {
      logger.error('Failed to load tools', { error: error.message });
      throw error;
    }
  }

  async loadFromDirectory(directory, source = 'unknown') {
    try {
      const exists = await fs.access(directory).then(() => true).catch(() => false);
      if (!exists) {
        logger.info('Tools directory does not exist', { directory });
        return;
      }

      const files = await fs.readdir(directory);
      const jsFiles = files.filter(file =>
        file.endsWith('.js') &&
        !file.endsWith('.test.js') &&
        !file.endsWith('.spec.js')
      );

      for (const file of jsFiles) {
        await this.loadToolFile(path.join(directory, file), source);
      }

      logger.info('Loaded tools from directory', {
        directory,
        source,
        fileCount: jsFiles.length
      });
    } catch (error) {
      logger.error('Failed to load tools from directory', {
        directory,
        error: error.message
      });
    }
  }

  async loadToolFile(filePath, source = 'unknown') {
    try {
      // Avoid loading the same file multiple times
      if (this.loadedFiles && this.loadedFiles.has(filePath)) {
        return;
      }

      // Platform integration flags
      const ENABLE_BITRIX24 = process.env.ENABLE_BITRIX24_INTEGRATION === 'true';
      const ENABLE_ASANA = process.env.ENABLE_ASANA_INTEGRATION === 'true';

      // Skip platform-specific tools if their platform is disabled
      const fileName = path.basename(filePath);

      if (fileName.toLowerCase().includes('bitrix') && !ENABLE_BITRIX24) {
        logger.info('Skipping Bitrix24 tool (integration disabled)', { file: fileName });
        return;
      }

      if (fileName.toLowerCase().includes('asana') && !ENABLE_ASANA) {
        logger.info('Skipping Asana tool (integration disabled)', { file: fileName });
        return;
      }

      // Clear require cache for hot-reload in development
      if (process.env.NODE_ENV === 'development') {
        delete require.cache[require.resolve(filePath)];
      }

      // Load the tool file
      const ToolClass = require(filePath);

      // Validate tool class
      if (typeof ToolClass !== 'function') {
        throw new Error('Tool file must export a class');
      }

      // Create tool context - handle service dependencies gracefully
      let firestore = null;
      let queue = null;

      try {
        firestore = getFirestore();
      } catch (error) {
        logger.warn('Firestore not available for tool context', {
          file: path.basename(filePath),
          error: error.message
        });
      }

      // Only load queue manager if Bitrix24 is enabled
      if (ENABLE_BITRIX24) {
        try {
          const { getQueueManager } = require('../services/bitrix24-queue');
          queue = getQueueManager();
        } catch (error) {
          logger.warn('Queue manager not available for tool context', {
            file: path.basename(filePath),
            error: error.message
          });
        }
      }

      const context = {
        firestore: firestore,
        queue: queue,
        logger: logger.child({ source: 'tool' })
      };

      // Instantiate and register tool
      const tool = new ToolClass(context);
      tool.source = source;
      tool.filePath = filePath;

      this.registry.register(tool);
      if (this.loadedFiles) {
        this.loadedFiles.add(filePath);
      }

      logger.info('Tool loaded from file', {
        file: path.basename(filePath),
        toolName: tool.name,
        source,
        hasShoudTrigger: typeof tool.shouldTrigger === 'function'
      });
    } catch (error) {
      logger.error('Failed to load tool file', {
        file: filePath,
        error: error.message
      });
    }
  }

  async initializeTools() {
    const tools = this.registry.getAllTools();
    const initPromises = tools.map(async (tool) => {
      try {
        await tool.initialize();
      } catch (error) {
        logger.error('Tool initialization failed', {
          tool: tool.name,
          error: error.message
        });
        tool.setEnabled(false);
      }
    });

    await Promise.all(initPromises);
  }

  async reloadTools() {
    logger.info('Reloading all tools');
    await this.registry.clear();
    this.loadedFiles.clear();
    await this.loadTools();
  }

  async reloadTool(toolName) {
    const tool = this.registry.getTool(toolName);
    if (!tool || !tool.filePath) {
      throw new Error(`Tool ${toolName} not found or has no file path`);
    }

    logger.info('Reloading tool', { toolName });

    // Unregister current tool
    await this.registry.unregister(toolName);
    this.loadedFiles.delete(tool.filePath);

    // Reload tool file
    await this.loadToolFile(tool.filePath, tool.source);
  }

  async ensureDirectoryExists(directory) {
    try {
      await fs.access(directory);
    } catch {
      await fs.mkdir(directory, { recursive: true });

      // Create .gitkeep file
      await fs.writeFile(
        path.join(directory, '.gitkeep'),
        '# This directory contains custom tools\n'
      );

      logger.info('Created tools directory', { directory });
    }
  }

  getRegistry() {
    return this.registry;
  }

  // Development helper for hot-reload
  async watchTools() {
    if (this.watching || process.env.NODE_ENV === 'production') {
      return;
    }

    try {
      const chokidar = require('chokidar');
      const watcher = chokidar.watch([this.toolsDirectory], {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true
      });

      watcher.on('change', async (filePath) => {
        if (filePath.endsWith('.js')) {
          logger.info('Tool file changed, reloading', { file: filePath });
          try {
            // Find tool by file path
            const tools = this.registry.getAllTools();
            const tool = tools.find(t => t.filePath === filePath);

            if (tool) {
              await this.reloadTool(tool.name);
            } else {
              // New file, reload all
              await this.reloadTools();
            }
          } catch (error) {
            logger.error('Hot-reload failed', { file: filePath, error: error.message });
          }
        }
      });

      this.watching = true;
      logger.info('Tool watcher started');
    } catch (error) {
      logger.warn('Could not start tool watcher', { error: error.message });
    }
  }
}

// Singleton instances
let toolLoader;
let toolRegistry;

async function loadTools() {
  if (!toolLoader) {
    toolLoader = new ToolLoader();
    toolRegistry = toolLoader.getRegistry();
  }

  await toolLoader.loadTools();

  // Start watching in development
  if (process.env.NODE_ENV === 'development') {
    await toolLoader.watchTools();
  }

  return toolRegistry;
}

function getToolRegistry() {
  if (!toolRegistry) {
    throw new Error('Tools not loaded. Call loadTools() first.');
  }
  return toolRegistry;
}

function getToolLoader() {
  return toolLoader;
}

module.exports = {
  ToolRegistry,
  ToolLoader,
  loadTools,
  getToolRegistry,
  getToolLoader
};