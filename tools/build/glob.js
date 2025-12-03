/**
 * Glob Tool
 * Finds files matching a glob pattern in the repository
 * Uses GitHub Trees API for stateless operation
 */

const BaseTool = require('../../lib/baseTool');
const { getGitHubService } = require('../../services/github/githubService');
const { getBuildModeManager } = require('../../services/build/buildModeManager');
const { isValidDirPath } = require('../../lib/pathValidation');

class Glob extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'Glob';
    this.description = 'Finds files matching a glob pattern in the repository. Use patterns like "**/*.js", "src/**/*.ts", or "*.md". Returns matching file paths.';
    this.category = 'build';
    this.priority = 70;
    this.enabled = true;

    this.parameters = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts", "*.md")'
        },
        dir_path: {
          type: 'string',
          description: 'Directory to search within (optional, defaults to root)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 100)'
        },
        branch: {
          type: 'string',
          description: 'Branch to search (optional)'
        }
      },
      required: ['pattern']
    };
  }

  async shouldTrigger() {
    return false;
  }

  async execute(params, toolContext = {}) {
    const { pattern, dir_path, max_results = 100, branch } = params;

    // Check Build Mode
    const buildModeManager = getBuildModeManager();
    const buildModeEnabled = await buildModeManager.isBuildModeEnabled();

    if (!buildModeEnabled) {
      return {
        success: false,
        error: 'Build Mode is not enabled'
      };
    }

    // Validate dir_path to prevent path traversal
    if (dir_path && !isValidDirPath(dir_path)) {
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

      // Get repository tree
      const tree = await githubService.getTree(targetBranch);

      // Filter to only files (blobs)
      let files = tree.filter(item => item.type === 'blob');

      // Apply directory filter if specified
      if (dir_path) {
        const normalizedDir = dir_path.replace(/^\/|\/$/g, '');
        files = files.filter(f => f.path.startsWith(normalizedDir + '/') || f.path === normalizedDir);
      }

      // Apply glob pattern matching
      const matches = files.filter(f => this.matchGlob(f.path, pattern));

      // Limit results
      const limited = matches.slice(0, max_results);

      this.logger.info('Glob search completed', {
        pattern,
        dir_path,
        branch: targetBranch,
        matches: matches.length,
        returned: limited.length
      });

      return {
        success: true,
        pattern,
        branch: targetBranch,
        files: limited.map(f => ({
          path: f.path,
          size: f.size,
          sha: f.sha
        })),
        totalMatches: matches.length,
        truncated: matches.length > max_results
      };
    } catch (error) {
      this.logger.error('Glob failed', {
        pattern,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Simple glob pattern matching
   * Supports: *, **, ?
   */
  matchGlob(filePath, pattern) {
    // Convert glob to regex
    let regex = pattern
      .replace(/\./g, '\\.')          // Escape dots
      .replace(/\*\*/g, '{{DOUBLESTAR}}') // Temp placeholder
      .replace(/\*/g, '[^/]*')         // Single * matches non-slash
      .replace(/\?/g, '[^/]')          // ? matches single char
      .replace(/{{DOUBLESTAR}}/g, '.*'); // ** matches anything

    // Handle patterns starting with **
    if (!pattern.startsWith('**/') && !pattern.startsWith('/')) {
      regex = '^' + regex;
    }

    // Anchor to end
    regex = regex + '$';

    try {
      return new RegExp(regex).test(filePath);
    } catch {
      // Invalid regex, try simple includes
      return filePath.includes(pattern.replace(/\*/g, ''));
    }
  }
}

module.exports = Glob;
