/**
 * Grep Tool
 * Searches for a regex pattern in file contents
 * Uses GitHub Code Search API with fallback to in-memory search
 */

const BaseTool = require('../../lib/baseTool');
const { getGitHubService } = require('../../services/github/githubService');
const { getBuildModeManager } = require('../../services/build/buildModeManager');

class Grep extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'Grep';
    this.description = 'Searches for a pattern in file contents across the repository. Returns matching lines with context. Supports regex patterns.';
    this.category = 'build';
    this.priority = 72;
    this.enabled = true;

    this.parameters = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search pattern (regex supported)'
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g., "*.js", "src/**/*.ts")'
        },
        max_results: {
          type: 'number',
          description: 'Maximum matches to return (default: 30)'
        },
        context_lines: {
          type: 'number',
          description: 'Lines of context around each match (default: 2)'
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
    const {
      pattern,
      include,
      max_results = 30,
      context_lines = 2,
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

    const githubService = getGitHubService();

    try {
      // Get current branch
      let targetBranch = branch;
      if (!targetBranch) {
        const status = await buildModeManager.getStatus();
        targetBranch = status.currentBranch || 'main';
      }

      // Try GitHub Code Search first (fast, but limited)
      try {
        const searchResults = await githubService.searchCode(pattern);

        if (searchResults.length > 0) {
          // Get detailed matches for top results
          const matches = [];
          const filesToCheck = searchResults.slice(0, Math.min(10, max_results));

          for (const result of filesToCheck) {
            // Apply include filter
            if (include && !this.matchGlob(result.path, include)) {
              continue;
            }

            // Get file content for detailed matches
            const fileContent = await githubService.getFileContents(result.path, targetBranch);

            if (fileContent.type === 'file') {
              const lineMatches = this.findMatches(
                fileContent.content,
                pattern,
                context_lines
              );

              for (const match of lineMatches) {
                matches.push({
                  file: result.path,
                  ...match
                });

                if (matches.length >= max_results) break;
              }
            }

            if (matches.length >= max_results) break;
          }

          this.logger.info('Grep completed via Code Search', {
            pattern,
            matches: matches.length
          });

          return {
            success: true,
            pattern,
            branch: targetBranch,
            matches,
            totalMatches: matches.length,
            method: 'code_search'
          };
        }
      } catch {
        // Code search failed, fall back to in-memory search
      }

      // Fallback: Get tree and search files in memory
      const tree = await githubService.getTree(targetBranch);
      const files = tree.filter(item => item.type === 'blob');

      // Apply include filter
      let targetFiles = files;
      if (include) {
        targetFiles = files.filter(f => this.matchGlob(f.path, include));
      }

      // Limit files to search (to avoid too many API calls)
      const maxFiles = 20;
      const filesToSearch = targetFiles.slice(0, maxFiles);

      const matches = [];

      for (const file of filesToSearch) {
        // Skip binary files
        if (this.isBinaryPath(file.path)) continue;

        try {
          const content = await githubService.getFileContents(file.path, targetBranch);

          if (content.type === 'file') {
            const lineMatches = this.findMatches(
              content.content,
              pattern,
              context_lines
            );

            for (const match of lineMatches) {
              matches.push({
                file: file.path,
                ...match
              });

              if (matches.length >= max_results) break;
            }
          }
        } catch {
          // Skip files that can't be read
        }

        if (matches.length >= max_results) break;
      }

      this.logger.info('Grep completed via in-memory search', {
        pattern,
        filesSearched: filesToSearch.length,
        matches: matches.length
      });

      return {
        success: true,
        pattern,
        branch: targetBranch,
        matches,
        totalMatches: matches.length,
        filesSearched: filesToSearch.length,
        method: 'in_memory',
        truncated: targetFiles.length > maxFiles
      };
    } catch (error) {
      this.logger.error('Grep failed', {
        pattern,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  findMatches(content, pattern, contextLines) {
    const lines = content.split('\n');
    const matches = [];

    let regex;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      // Invalid regex, use literal search
      regex = new RegExp(this.escapeRegex(pattern), 'gi');
    }

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        // Get context
        const startLine = Math.max(0, i - contextLines);
        const endLine = Math.min(lines.length - 1, i + contextLines);

        const context = [];
        for (let j = startLine; j <= endLine; j++) {
          context.push({
            lineNumber: j + 1,
            content: lines[j],
            isMatch: j === i
          });
        }

        matches.push({
          lineNumber: i + 1,
          content: lines[i],
          context
        });

        regex.lastIndex = 0; // Reset regex state
      }
    }

    return matches;
  }

  matchGlob(filePath, pattern) {
    let regex = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{DOUBLESTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/{{DOUBLESTAR}}/g, '.*');

    if (!pattern.startsWith('**/') && !pattern.startsWith('/')) {
      regex = '^' + regex;
    }
    regex = regex + '$';

    try {
      return new RegExp(regex).test(filePath);
    } catch {
      return filePath.includes(pattern.replace(/\*/g, ''));
    }
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  isBinaryPath(path) {
    const binaryExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
      '.pdf', '.zip', '.tar', '.gz', '.rar',
      '.exe', '.dll', '.so', '.dylib',
      '.woff', '.woff2', '.ttf', '.eot',
      '.mp3', '.mp4', '.avi', '.mov'
    ];

    return binaryExtensions.some(ext => path.toLowerCase().endsWith(ext));
  }
}

module.exports = Grep;
