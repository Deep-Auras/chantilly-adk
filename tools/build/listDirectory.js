/**
 * ListDirectory Tool
 * Lists files and subdirectories in a directory
 * Uses GitHub Contents API
 */

const BaseTool = require('../../lib/baseTool');
const { getGitHubService } = require('../../services/github/githubService');
const { getBuildModeManager } = require('../../services/build/buildModeManager');
const { isValidDirPath } = require('../../lib/pathValidation');

class ListDirectory extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'ListDirectory';
    this.description = 'Lists files and subdirectories in a specified directory. Shows file names, types, and sizes. Use this to explore the repository structure.';
    this.category = 'build';
    this.priority = 68;
    this.enabled = true;

    this.parameters = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repository root (empty or "/" for root)'
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively (default: false)'
        },
        max_depth: {
          type: 'number',
          description: 'Maximum depth for recursive listing (default: 2)'
        },
        branch: {
          type: 'string',
          description: 'Branch to list from (optional)'
        }
      },
      required: []
    };
  }

  async shouldTrigger() {
    return false;
  }

  async execute(params, toolContext = {}) {
    const {
      path = '',
      recursive = false,
      max_depth = 2,
      branch
    } = params;

    // Check Build Mode
    const buildModeManager = getBuildModeManager();
    const buildModeEnabled = await buildModeManager.isBuildModeEnabled();

    if (!buildModeEnabled) {
      return {
        success: false,
        error: 'Build Mode is not enabled'
      };
    }

    // Validate path to prevent path traversal
    if (path && !isValidDirPath(path)) {
      return {
        success: false,
        error: 'Invalid directory path. Path traversal patterns are not allowed.'
      };
    }

    const githubService = getGitHubService();

    try {
      // Get current branch
      let targetBranch = branch;
      if (!targetBranch) {
        const status = await buildModeManager.getStatus();
        targetBranch = status.currentBranch || 'main';
      }

      // Normalize path
      const normalizedPath = path.replace(/^\/|\/$/g, '') || '';

      if (recursive) {
        // Use tree API for recursive listing
        const tree = await githubService.getTree(targetBranch);

        // Filter by path prefix
        let items = tree;
        if (normalizedPath) {
          items = tree.filter(item =>
            item.path.startsWith(normalizedPath + '/') ||
            item.path === normalizedPath
          );
        }

        // Apply max depth
        const baseDepth = normalizedPath ? normalizedPath.split('/').length : 0;
        items = items.filter(item => {
          const itemDepth = item.path.split('/').length;
          return itemDepth - baseDepth <= max_depth;
        });

        // Format entries
        const entries = items.map(item => ({
          name: item.path.split('/').pop(),
          path: item.path,
          type: item.type === 'blob' ? 'file' : 'directory',
          size: item.size || null,
          sha: item.sha
        }));

        this.logger.info('Directory listed (recursive)', {
          path: normalizedPath,
          branch: targetBranch,
          entries: entries.length
        });

        return {
          success: true,
          path: normalizedPath || '/',
          branch: targetBranch,
          entries,
          count: entries.length,
          recursive: true,
          maxDepth: max_depth
        };
      }

      // Non-recursive: use Contents API
      const result = await githubService.getFileContents(
        normalizedPath || '',
        targetBranch
      );

      if (result.type === 'not_found') {
        return {
          success: false,
          error: `Directory not found: ${normalizedPath || '/'}`
        };
      }

      if (result.type === 'file') {
        return {
          success: false,
          error: 'Path is a file, not a directory. Use ReadFile instead.'
        };
      }

      // Format directory entries
      const entries = result.entries.map(item => ({
        name: item.name,
        path: item.path,
        type: item.type === 'file' ? 'file' : 'directory',
        size: item.size || null,
        sha: item.sha
      }));

      // Sort: directories first, then files, alphabetically
      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });

      this.logger.info('Directory listed', {
        path: normalizedPath,
        branch: targetBranch,
        entries: entries.length
      });

      return {
        success: true,
        path: normalizedPath || '/',
        branch: targetBranch,
        entries,
        count: entries.length,
        recursive: false
      };
    } catch (error) {
      this.logger.error('ListDirectory failed', {
        path,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = ListDirectory;
