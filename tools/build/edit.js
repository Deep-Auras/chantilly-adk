/**
 * Edit Tool
 * Performs exact string replacement in a file (surgical edit)
 * Requires user approval before execution
 */

const BaseTool = require('../../lib/baseTool');
const { getGitHubService } = require('../../services/github/githubService');
const { getBuildModeManager } = require('../../services/build/buildModeManager');
const { getFirestore, getFieldValue } = require('../../config/firestore');
const { isValidFilePath } = require('../../lib/pathValidation');

class Edit extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'Edit';
    this.description = 'Performs exact string replacement in a file. The old_string must match exactly and uniquely. REQUIRES USER APPROVAL before execution.';
    this.category = 'build';
    this.priority = 78;
    this.enabled = true;
    this.requiresApproval = true;

    this.parameters = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file to modify'
        },
        old_string: {
          type: 'string',
          description: 'Exact text to replace (must match exactly)'
        },
        new_string: {
          type: 'string',
          description: 'Replacement text'
        },
        expected_replacements: {
          type: 'number',
          description: 'Expected number of replacements (default: 1)'
        },
        commit_message: {
          type: 'string',
          description: 'Commit message for this change'
        },
        branch: {
          type: 'string',
          description: 'Target branch (optional)'
        }
      },
      required: ['file_path', 'old_string', 'new_string', 'commit_message']
    };
  }

  async shouldTrigger() {
    return false;
  }

  async execute(params, toolContext = {}) {
    const {
      file_path,
      old_string,
      new_string,
      expected_replacements = 1,
      commit_message,
      branch
    } = params;
    const userId = toolContext.userId || 'system';

    // Validation
    if (old_string === new_string) {
      return {
        success: false,
        error: 'old_string and new_string must be different'
      };
    }

    // Check Build Mode
    const buildModeManager = getBuildModeManager();
    const canModify = await buildModeManager.canUserModifyCode(userId, toolContext.userRole || 'admin');

    if (!canModify.allowed) {
      return {
        success: false,
        error: canModify.reason
      };
    }

    // Validate file path to prevent path traversal
    if (!isValidFilePath(file_path)) {
      return {
        success: false,
        error: 'Invalid file path. Path traversal patterns are not allowed.'
      };
    }

    const githubService = getGitHubService();
    const db = getFirestore();
    const FieldValue = getFieldValue();

    try {
      // Get current branch
      let targetBranch = branch;
      if (!targetBranch) {
        const status = await buildModeManager.getStatus();
        targetBranch = status.currentBranch || 'main';
      }

      // Get file contents
      const fileResult = await githubService.getFileContents(file_path, targetBranch);

      if (fileResult.type === 'not_found') {
        return {
          success: false,
          error: `File not found: ${file_path}`
        };
      }

      if (fileResult.type !== 'file') {
        return {
          success: false,
          error: 'Path is not a file'
        };
      }

      const beforeContent = fileResult.content;

      // Count occurrences
      const occurrences = (beforeContent.match(new RegExp(this.escapeRegex(old_string), 'g')) || []).length;

      if (occurrences === 0) {
        return {
          success: false,
          error: `old_string not found in file. Make sure it matches exactly including whitespace.`,
          hint: 'Use ReadFile to verify the exact content of the file.'
        };
      }

      if (occurrences !== expected_replacements) {
        return {
          success: false,
          error: `Expected ${expected_replacements} occurrence(s) but found ${occurrences}. Provide more context in old_string to make it unique, or adjust expected_replacements.`,
          occurrences
        };
      }

      // Apply replacement
      const afterContent = beforeContent.replace(
        new RegExp(this.escapeRegex(old_string), 'g'),
        new_string
      );

      // Create modification record
      const modRef = db.collection('code-modifications').doc();
      await modRef.set({
        modId: modRef.id,
        userId,
        filePath: file_path,
        operation: 'update',
        beforeContent,
        afterContent,
        commitMessage: commit_message,
        branch: targetBranch,
        oldString: old_string,
        newString: new_string,
        replacementCount: expected_replacements,
        userApproved: false,
        toolName: this.name,
        createdAt: FieldValue.serverTimestamp()
      });

      // If approval required, return pending
      if (this.requiresApproval && !toolContext.autoApprove) {
        return {
          success: true,
          status: 'pending_approval',
          modId: modRef.id,
          filePath: file_path,
          replacementCount: expected_replacements,
          message: 'Edit request created. Waiting for user approval.',
          diff: this.generateContextDiff(beforeContent, old_string, new_string)
        };
      }

      // Auto-approve path
      const result = await githubService.createOrUpdateFile(
        file_path,
        afterContent,
        commit_message,
        targetBranch,
        fileResult.sha
      );

      // Update record
      await modRef.update({
        userApproved: true,
        approvedAt: FieldValue.serverTimestamp(),
        appliedAt: FieldValue.serverTimestamp(),
        commitSha: result.commit.sha
      });

      // Add to session
      const session = await buildModeManager.getCurrentSession(userId);
      if (session) {
        await buildModeManager.addCommitToSession(session.sessionId, {
          sha: result.commit.sha,
          message: commit_message
        });
        await buildModeManager.addFileToSession(session.sessionId, {
          path: file_path,
          status: 'modified'
        });
      }

      this.logger.info('Edit applied successfully', {
        path: file_path,
        branch: targetBranch,
        replacements: expected_replacements,
        commitSha: result.commit.sha
      });

      return {
        success: true,
        filePath: file_path,
        replacementsMade: expected_replacements,
        commitSha: result.commit.sha,
        commitUrl: result.commit.url,
        branch: targetBranch
      };
    } catch (error) {
      this.logger.error('Edit failed', {
        path: file_path,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  generateContextDiff(content, oldStr, newStr) {
    const lines = content.split('\n');
    const diff = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(oldStr)) {
        // Show context
        if (i > 0) diff.push(`  ${i}: ${lines[i - 1]}`);
        diff.push(`- ${i + 1}: ${lines[i]}`);
        diff.push(`+ ${i + 1}: ${lines[i].replace(oldStr, newStr)}`);
        if (i < lines.length - 1) diff.push(`  ${i + 2}: ${lines[i + 1]}`);
        diff.push('---');
      }
    }

    return diff.slice(0, 30).join('\n');
  }
}

module.exports = Edit;
