/**
 * WriteFile Tool
 * Creates or overwrites a file in the repository via GitHub Contents API
 * Requires user approval before execution
 */

const BaseTool = require('../../lib/baseTool');
const { getGitHubService } = require('../../services/github/githubService');
const { getBuildModeManager } = require('../../services/build/buildModeManager');
const { getFirestore, getFieldValue } = require('../../config/firestore');
const { isValidFilePath } = require('../../lib/pathValidation');

class WriteFile extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'WriteFile';
    this.description = 'Creates a new file or overwrites an existing file in the repository. This commits and pushes the change. REQUIRES USER APPROVAL before execution.';
    this.category = 'build';
    this.priority = 75;
    this.enabled = true;
    this.requiresApproval = true;

    this.parameters = {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file relative to repository root'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file'
        },
        commit_message: {
          type: 'string',
          description: 'Commit message describing this change'
        },
        branch: {
          type: 'string',
          description: 'Target branch (optional, defaults to current branch)'
        }
      },
      required: ['file_path', 'content', 'commit_message']
    };
  }

  async shouldTrigger() {
    return false;
  }

  async execute(params, toolContext = {}) {
    const { file_path, content, commit_message, branch } = params;
    const userId = toolContext.userId || 'system';

    // Validate Build Mode is enabled
    const buildModeManager = getBuildModeManager();
    const canModify = await buildModeManager.canUserModifyCode(userId, toolContext.userRole || 'admin');

    if (!canModify.allowed) {
      return {
        success: false,
        error: canModify.reason,
        requiresApproval: true
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
      // Get current branch if not specified
      let targetBranch = branch;
      if (!targetBranch) {
        const status = await buildModeManager.getStatus();
        targetBranch = status.currentBranch || 'main';
      }

      // Check if file exists (for before content)
      let beforeContent = null;
      let operation = 'create';
      try {
        const existing = await githubService.getFileContents(file_path, targetBranch);
        if (existing.type === 'file') {
          beforeContent = existing.content;
          operation = 'update';
        }
      } catch {
        // File doesn't exist - creating new
      }

      // Generate diff for preview
      const diff = this.generateDiff(beforeContent, content);

      // Create modification record for approval
      const modRef = db.collection('code-modifications').doc();
      await modRef.set({
        modId: modRef.id,
        userId,
        conversationId: toolContext.conversationId || null,
        filePath: file_path,
        operation,
        beforeContent,
        afterContent: content,
        commitMessage: commit_message,
        branch: targetBranch,
        diff,
        userApproved: false,
        toolName: this.name,
        createdAt: FieldValue.serverTimestamp()
      });

      // If auto-approve is disabled (default), return pending status
      if (this.requiresApproval && !toolContext.autoApprove) {
        return {
          success: true,
          status: 'pending_approval',
          modId: modRef.id,
          operation,
          filePath: file_path,
          message: `File ${operation} request created. Waiting for user approval.`,
          diff
        };
      }

      // Auto-approve path (if enabled)
      const result = await githubService.createOrUpdateFile(
        file_path,
        content,
        commit_message,
        targetBranch
      );

      // Update modification record
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
          status: operation === 'create' ? 'created' : 'modified'
        });
      }

      this.logger.info('File written successfully', {
        path: file_path,
        branch: targetBranch,
        operation,
        commitSha: result.commit.sha
      });

      return {
        success: true,
        operation,
        filePath: file_path,
        commitSha: result.commit.sha,
        commitUrl: result.commit.url,
        branch: targetBranch
      };
    } catch (error) {
      this.logger.error('WriteFile failed', {
        path: file_path,
        error: error.message
      });

      return {
        success: false,
        error: error.message
      };
    }
  }

  generateDiff(before, after) {
    if (!before) {
      return `+++ New file\n${after.split('\n').map(l => `+ ${l}`).join('\n')}`;
    }

    // Simple line-by-line diff
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const diff = [];

    const maxLines = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < maxLines; i++) {
      const bLine = beforeLines[i];
      const aLine = afterLines[i];

      if (bLine === aLine) {
        diff.push(`  ${bLine || ''}`);
      } else {
        if (bLine !== undefined) diff.push(`- ${bLine}`);
        if (aLine !== undefined) diff.push(`+ ${aLine}`);
      }
    }

    return diff.slice(0, 50).join('\n') + (diff.length > 50 ? '\n... (truncated)' : '');
  }
}

module.exports = WriteFile;
