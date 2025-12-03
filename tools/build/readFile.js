/**
 * ReadFile Tool
 * Reads file contents from the GitHub repository via Contents API
 */

const BaseTool = require('../../lib/baseTool');
const { getGitHubService } = require('../../services/github/githubService');
const { getBuildModeManager } = require('../../services/build/buildModeManager');
const { isValidFilePath } = require('../../lib/pathValidation');

class ReadFile extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'ReadFile';
    this.description = 'Reads and returns the content of a specified file from the repository. Use this to examine source code, configuration files, or any text file in the codebase.';
    this.category = 'build';
    this.priority = 80;
    this.enabled = true;

    this.parameters = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file relative to repository root (e.g., src/services/userService.js)'
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (0-based, optional)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read (optional, defaults to entire file)'
        },
        ref: {
          type: 'string',
          description: 'Branch or commit SHA to read from (optional, defaults to current branch)'
        }
      },
      required: ['file_path']
    };
  }

  async shouldTrigger() {
    return false; // Semantic triggering via Gemini
  }

  async execute(params, toolContext = {}) {
    const { file_path, offset, limit, ref } = params;

    // Validate Build Mode is enabled
    const buildModeManager = getBuildModeManager();
    const buildModeEnabled = await buildModeManager.isBuildModeEnabled();

    if (!buildModeEnabled) {
      return {
        success: false,
        error: 'Build Mode is not enabled. Enable Build Mode to access repository files.'
      };
    }

    // Validate file path to prevent path traversal
    if (!isValidFilePath(file_path)) {
      return {
        success: false,
        error: 'Invalid file path. Path traversal patterns are not allowed.'
      };
    }

    // Get GitHub service
    const githubService = getGitHubService();

    try {
      // Determine branch
      let branch = ref;
      if (!branch) {
        const status = await buildModeManager.getStatus();
        branch = status.currentBranch || 'main';
      }

      // Get file contents
      const result = await githubService.getFileContents(file_path, branch);

      if (result.type === 'not_found') {
        return {
          success: false,
          error: `File not found: ${file_path}`
        };
      }

      if (result.type === 'directory') {
        return {
          success: false,
          error: `Path is a directory, not a file: ${file_path}. Use ListDirectory tool instead.`,
          entries: result.entries
        };
      }

      let content = result.content;
      let truncated = false;

      // Apply offset and limit if specified
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        const startLine = offset || 0;
        const endLine = limit ? startLine + limit : lines.length;

        content = lines.slice(startLine, endLine).join('\n');
        truncated = endLine < lines.length;
      }

      this.logger.info('File read successfully', {
        path: file_path,
        branch,
        size: result.size,
        truncated
      });

      return {
        success: true,
        path: file_path,
        content,
        sha: result.sha,
        size: result.size,
        branch,
        truncated,
        totalLines: result.content.split('\n').length
      };
    } catch (error) {
      this.logger.error('ReadFile failed', {
        path: file_path,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = ReadFile;
