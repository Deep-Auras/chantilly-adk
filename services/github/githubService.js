/**
 * GitHub Integration Service
 * Handles all GitHub API operations using Octokit
 * Uses GitHub Contents API for stateless file operations (no local git clone)
 */

const { Octokit } = require('@octokit/rest');
const { createAppAuth } = require('@octokit/auth-app');
const { getFirestore, getFieldValue } = require('../../config/firestore');
const { logger } = require('../../utils/logger');
const { getEncryption } = require('../../utils/encryption');

class GitHubService {
  constructor() {
    this.octokit = null;
    this.db = getFirestore();
    this.FieldValue = getFieldValue();
    this.initialized = false;
    this.config = null;
    this.treeCache = new Map(); // Cache repo tree for session
    this.treeCacheExpiry = 5 * 60 * 1000; // 5 minutes
    this.MAX_CACHE_SIZE = 100;
  }

  /**
   * Initialize the service with config from Firestore
   */
  async initialize() {
    if (this.initialized) return;

    try {
      logger.info('Initializing GitHub service...');

      // Load config from Firestore
      const configDoc = await this.db.doc('agent/platforms/github/config').get();

      if (!configDoc.exists) {
        logger.warn('GitHub config not found in Firestore');
        return;
      }

      this.config = configDoc.data();
      logger.info('GitHub config loaded for initialization', {
        enabled: this.config.enabled,
        authType: this.config.authType,
        defaultOwner: this.config.defaultOwner,
        defaultRepo: this.config.defaultRepo,
        hasAppId: !!this.config.appId,
        hasInstallationId: !!this.config.installationId
      });

      if (!this.config.enabled) {
        logger.info('GitHub integration is disabled');
        return;
      }

      // Get encrypted credentials from agent/credentials
      const credentialsDoc = await this.db.doc('agent/credentials').get();
      if (!credentialsDoc.exists) {
        throw new Error('Credentials document not found');
      }
      const credentials = credentialsDoc.data();
      logger.info('Credentials document loaded', {
        hasGithubAccessToken: !!credentials.github_access_token,
        hasGithubPrivateKey: !!credentials.github_private_key
      });

      // Get encryption service (async initialization from Firestore)
      const encryption = getEncryption();
      if (!await encryption.isEnabledAsync()) {
        throw new Error('Encryption not enabled, cannot decrypt GitHub credentials');
      }

      // Initialize Octokit based on auth type
      const authType = this.config.authType || 'personal-token';

      if (authType === 'personal-token') {
        const encryptedToken = credentials.github_access_token;
        if (!encryptedToken) {
          throw new Error('GitHub access token not found in credentials');
        }
        const accessToken = await encryption.decryptCredential(encryptedToken);

        this.octokit = new Octokit({
          auth: accessToken
        });
      } else if (authType === 'github-app') {
        // GitHub App authentication using @octokit/auth-app
        const { appId, installationId } = this.config;

        if (!appId || !installationId) {
          throw new Error('GitHub App ID and Installation ID are required');
        }

        const encryptedPrivateKey = credentials.github_private_key;
        if (!encryptedPrivateKey) {
          throw new Error('GitHub private key not found in credentials');
        }
        const privateKey = await encryption.decryptCredential(encryptedPrivateKey);

        // Both App ID and Installation ID are numeric
        const numericAppId = parseInt(appId, 10);
        const numericInstallationId = parseInt(installationId, 10);

        if (isNaN(numericAppId)) {
          throw new Error('App ID must be a valid number (found in GitHub App settings)');
        }
        if (isNaN(numericInstallationId)) {
          throw new Error('Installation ID must be a valid number (found in installation URL)');
        }

        logger.info('Creating GitHub App Octokit instance', {
          appId: numericAppId,
          installationId: numericInstallationId,
          privateKeyLength: privateKey?.length
        });

        // Create Octokit with GitHub App authentication
        this.octokit = new Octokit({
          authStrategy: createAppAuth,
          auth: {
            appId: numericAppId,
            privateKey: privateKey,
            installationId: numericInstallationId
          }
        });

        logger.info('GitHub App authentication configured', {
          appId: numericAppId,
          installationId: numericInstallationId
        });
      } else {
        throw new Error('Invalid GitHub authentication configuration');
      }

      this.initialized = true;
      logger.info('GitHub service initialized', {
        owner: this.config.defaultOwner,
        repo: this.config.defaultRepo
      });
    } catch (error) {
      logger.error('Failed to initialize GitHub service', { error: error.message });
      throw error;
    }
  }

  /**
   * Reset the service state to force re-initialization
   * Called when config changes (e.g., after saving platform settings)
   */
  reset() {
    this.initialized = false;
    this.octokit = null;
    this.config = null;
    this.treeCache.clear();
    logger.info('GitHub service reset, will re-initialize on next use');
  }

  /**
   * Check if GitHub integration is enabled
   * Always reads fresh config from Firestore
   */
  async isEnabled() {
    // Always read fresh config to detect changes
    const configDoc = await this.db.doc('agent/platforms/github/config').get();
    if (!configDoc.exists) {
      logger.info('GitHub config document does not exist');
      return false;
    }
    this.config = configDoc.data();
    logger.info('GitHub config loaded', {
      enabled: this.config?.enabled,
      authType: this.config?.authType,
      hasOwner: !!this.config?.defaultOwner,
      hasRepo: !!this.config?.defaultRepo
    });
    return this.config?.enabled === true;
  }

  /**
   * Verify GitHub connection - tests API auth, repo access, and branch listing
   * Always re-initializes to pick up fresh config
   */
  async verifyConnection() {
    try {
      // Reset and re-initialize to pick up any config changes
      this.reset();
      await this.initialize();

      if (!this.octokit) {
        return {
          connected: false,
          error: 'GitHub client not initialized'
        };
      }

      const { defaultOwner, defaultRepo } = this.config;
      if (!defaultOwner || !defaultRepo) {
        return {
          connected: false,
          error: 'Repository owner or name not configured'
        };
      }

      // For GitHub App auth, we can't use users.getAuthenticated()
      // Instead, verify by checking repository access directly
      const authType = this.config.authType || 'personal-token';
      let authInfo = {};

      if (authType === 'personal-token') {
        // Personal token: can get authenticated user
        const { data: user } = await this.octokit.rest.users.getAuthenticated();
        authInfo = { user: user.login, authType: 'personal-token' };
      } else if (authType === 'github-app') {
        // GitHub App: get app installation info instead
        try {
          const { data: installation } = await this.octokit.rest.apps.getAuthenticated();
          authInfo = { user: installation.name || 'GitHub App', app: installation.name, authType: 'github-app' };
        } catch {
          // If that fails, just note it's a GitHub App
          authInfo = { user: 'GitHub App', authType: 'github-app' };
        }
      }

      // Test repository access

      await this.octokit.rest.repos.get({
        owner: defaultOwner,
        repo: defaultRepo
      });

      // Test branch listing (verify read permissions)
      const { data: branches } = await this.octokit.rest.repos.listBranches({
        owner: defaultOwner,
        repo: defaultRepo,
        per_page: 5
      });

      return {
        connected: true,
        ...authInfo,
        repository: `${defaultOwner}/${defaultRepo}`,
        branchCount: branches.length,
        permissions: {
          read: true,
          write: true
        }
      };
    } catch (error) {
      logger.error('GitHub connection verification failed', {
        error: error.message,
        status: error.status
      });
      return {
        connected: false,
        error: error.message,
        status: error.status
      };
    }
  }

  /**
   * Get repository information
   */
  async getRepository(owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.repos.get({ owner, repo });
    return data;
  }

  /**
   * List all branches
   */
  async listBranches(owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.repos.listBranches({
      owner,
      repo,
      per_page: 100
    });
    return data;
  }

  /**
   * Get specific branch info
   */
  async getBranch(branch, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.repos.getBranch({
      owner,
      repo,
      branch
    });
    return data;
  }

  /**
   * Create a new branch from an existing branch
   */
  async createBranch(branchName, fromBranch = 'main', owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    // Get the SHA of the source branch
    const { data: sourceBranch } = await this.octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: fromBranch
    });

    // Create new branch reference
    const { data } = await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: sourceBranch.commit.sha
    });

    logger.info('Created new branch', {
      branch: branchName,
      fromBranch,
      sha: sourceBranch.commit.sha
    });

    return data;
  }

  /**
   * Merge one branch into another
   */
  async mergeBranch(base, head, commitMessage = null, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.repos.merge({
      owner,
      repo,
      base,
      head,
      commit_message: commitMessage || `Merge ${head} into ${base}`
    });

    logger.info('Merged branches', { base, head, sha: data.sha });
    return data;
  }

  /**
   * Get file contents from repository
   * Returns decoded content and SHA for updates
   */
  async getFileContents(path, ref = null, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    try {
      const params = { owner, repo, path };
      if (ref) params.ref = ref;

      const { data } = await this.octokit.rest.repos.getContent(params);

      // Handle file vs directory
      if (Array.isArray(data)) {
        // It's a directory
        return {
          type: 'directory',
          entries: data.map(item => ({
            name: item.name,
            path: item.path,
            type: item.type,
            size: item.size,
            sha: item.sha
          }))
        };
      }

      // It's a file - decode content
      const content = data.encoding === 'base64'
        ? Buffer.from(data.content, 'base64').toString('utf-8')
        : data.content;

      return {
        type: 'file',
        content,
        sha: data.sha,
        size: data.size,
        path: data.path,
        encoding: data.encoding
      };
    } catch (error) {
      if (error.status === 404) {
        return { type: 'not_found', path };
      }
      throw error;
    }
  }

  /**
   * Create or update a file in the repository
   * This performs commit + push in a single API call
   */
  async createOrUpdateFile(path, content, message, branch = null, sha = null, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;
    branch = branch || 'main';

    // If no SHA provided, try to get existing file's SHA
    if (!sha) {
      try {
        const existing = await this.getFileContents(path, branch, owner, repo);
        if (existing.type === 'file') {
          sha = existing.sha;
        }
      } catch {
        // File doesn't exist, that's fine for create
      }
    }

    // Encode content to base64
    const encodedContent = Buffer.from(content, 'utf-8').toString('base64');

    const params = {
      owner,
      repo,
      path,
      message,
      content: encodedContent,
      branch
    };

    if (sha) {
      params.sha = sha;
    }

    const { data } = await this.octokit.rest.repos.createOrUpdateFileContents(params);

    logger.info('File committed to GitHub', {
      path,
      branch,
      commitSha: data.commit.sha,
      operation: sha ? 'update' : 'create'
    });

    // Invalidate tree cache for this branch
    this.treeCache.delete(`${owner}/${repo}/${branch}`);

    return {
      commit: {
        sha: data.commit.sha,
        message: data.commit.message,
        url: data.commit.html_url
      },
      content: {
        sha: data.content.sha,
        path: data.content.path
      }
    };
  }

  /**
   * Delete a file from the repository
   */
  async deleteFile(path, message, branch, sha, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.repos.deleteFile({
      owner,
      repo,
      path,
      message,
      sha,
      branch
    });

    logger.info('File deleted from GitHub', {
      path,
      branch,
      commitSha: data.commit.sha
    });

    // Invalidate tree cache
    this.treeCache.delete(`${owner}/${repo}/${branch}`);

    return {
      commit: {
        sha: data.commit.sha,
        message
      }
    };
  }

  /**
   * Create a batch commit with multiple file changes in a single commit
   * Uses Git Trees API for atomic multi-file commits
   *
   * @param {Array} files - Array of file changes: { path, content, operation: 'create'|'update'|'delete' }
   * @param {string} message - Commit message
   * @param {string} branch - Target branch
   * @returns {Object} Commit result with SHA and URL
   */
  async createBatchCommit(files, message, branch = 'main', owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    if (!files || files.length === 0) {
      throw new Error('No files provided for batch commit');
    }

    logger.info('Creating batch commit', {
      fileCount: files.length,
      branch,
      paths: files.map(f => f.path)
    });

    // 1. Get the current commit SHA for the branch
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`
    });
    const currentCommitSha = refData.object.sha;

    // 2. Get the tree SHA from the current commit
    const { data: commitData } = await this.octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: currentCommitSha
    });
    const baseTreeSha = commitData.tree.sha;

    // 3. Build tree entries for each file
    const treeEntries = [];

    for (const file of files) {
      if (file.operation === 'delete') {
        // For deletes, we set sha to null which removes the file
        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: null
        });
      } else {
        // For create/update, create a blob first
        const { data: blobData } = await this.octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(file.content, 'utf-8').toString('base64'),
          encoding: 'base64'
        });

        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha
        });
      }
    }

    // 4. Create a new tree with all the changes
    const { data: newTreeData } = await this.octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: treeEntries
    });

    // 5. Create a commit pointing to the new tree
    const { data: newCommitData } = await this.octokit.rest.git.createCommit({
      owner,
      repo,
      message,
      tree: newTreeData.sha,
      parents: [currentCommitSha]
    });

    // 6. Update the branch reference to point to the new commit
    await this.octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommitData.sha
    });

    logger.info('Batch commit created successfully', {
      commitSha: newCommitData.sha,
      branch,
      fileCount: files.length,
      paths: files.map(f => f.path)
    });

    // Invalidate tree cache for this branch
    this.treeCache.delete(`${owner}/${repo}/${branch}`);

    return {
      commit: {
        sha: newCommitData.sha,
        message: newCommitData.message,
        url: `https://github.com/${owner}/${repo}/commit/${newCommitData.sha}`
      },
      files: files.map(f => ({
        path: f.path,
        operation: f.operation
      }))
    };
  }

  /**
   * Get the full repository tree (cached)
   * Single API call returns entire repo structure
   */
  async getTree(branch = 'main', owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const cacheKey = `${owner}/${repo}/${branch}`;
    const cached = this.treeCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.treeCacheExpiry) {
      return cached.tree;
    }

    // Get branch SHA
    const { data: branchData } = await this.octokit.rest.repos.getBranch({
      owner,
      repo,
      branch
    });

    // Get tree recursively
    const { data } = await this.octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: branchData.commit.sha,
      recursive: 'true'
    });

    // Evict old cache entries if over limit
    if (this.treeCache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.treeCache.keys().next().value;
      this.treeCache.delete(oldestKey);
    }

    // Cache the result
    this.treeCache.set(cacheKey, {
      tree: data.tree,
      timestamp: Date.now()
    });

    return data.tree;
  }

  /**
   * List commits for a branch
   */
  async listCommits(branch = 'main', limit = 20, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.repos.listCommits({
      owner,
      repo,
      sha: branch,
      per_page: Math.min(limit, 100)
    });

    return data.map(commit => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author.name,
      date: commit.commit.author.date,
      url: commit.html_url
    }));
  }

  /**
   * Get a specific commit
   */
  async getCommit(sha, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: sha
    });

    return {
      sha: data.sha,
      message: data.commit.message,
      author: data.commit.author,
      files: data.files?.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions
      }))
    };
  }

  /**
   * Revert a specific commit by creating a new commit that undoes its changes
   * @param {string} sha - The commit SHA to revert
   * @param {string} branch - The branch to apply the revert on
   * @param {string} owner - Repository owner (optional)
   * @param {string} repo - Repository name (optional)
   * @returns {Object} The revert commit info
   */
  async revertCommit(sha, branch, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    logger.info('Starting commit revert', { sha, branch, owner, repo });

    // Get the commit details including files changed
    const { data: commitData } = await this.octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: sha
    });

    if (!commitData.parents || commitData.parents.length === 0) {
      throw new Error('Cannot revert the initial commit');
    }

    const parentSha = commitData.parents[0].sha;
    const files = commitData.files || [];

    if (files.length === 0) {
      throw new Error('No files changed in this commit');
    }

    logger.info('Commit has files to revert', {
      sha,
      parentSha,
      fileCount: files.length,
      files: files.map(f => ({ path: f.filename, status: f.status }))
    });

    // Build the list of files to restore to parent state
    const filesToCommit = [];

    for (const file of files) {
      try {
        if (file.status === 'added') {
          // File was added - delete it by setting content to null
          filesToCommit.push({
            path: file.filename,
            content: null, // Signal deletion
            operation: 'delete'
          });
        } else if (file.status === 'removed') {
          // File was deleted - restore from parent
          const parentContent = await this.getFileContents(file.filename, parentSha, owner, repo);
          filesToCommit.push({
            path: file.filename,
            content: parentContent.content,
            operation: 'create'
          });
        } else {
          // File was modified - restore from parent
          const parentContent = await this.getFileContents(file.filename, parentSha, owner, repo);
          filesToCommit.push({
            path: file.filename,
            content: parentContent.content,
            operation: 'update'
          });
        }
      } catch (fileError) {
        logger.warn('Failed to process file for revert', {
          filename: file.filename,
          status: file.status,
          error: fileError.message
        });
        throw new Error(`Failed to revert file ${file.filename}: ${fileError.message}`);
      }
    }

    // Create revert commit message
    const originalMessage = commitData.commit.message.split('\n')[0]; // First line only
    const revertMessage = `Revert "${originalMessage}"\n\nThis reverts commit ${sha.substring(0, 7)}.`;

    // Use createBatchCommit-like logic to create the revert
    // Get current branch ref
    const { data: refData } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`
    });
    const currentCommitSha = refData.object.sha;

    // Get the current commit's tree
    const { data: currentCommit } = await this.octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: currentCommitSha
    });
    const baseTreeSha = currentCommit.tree.sha;

    // Create blobs and tree entries for each file
    const treeEntries = [];

    for (const file of filesToCommit) {
      if (file.operation === 'delete') {
        // To delete a file, we omit it from the tree (use sha: null with mode 100644)
        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: null // null SHA deletes the file
        });
      } else {
        // Create blob for file content
        const { data: blob } = await this.octokit.rest.git.createBlob({
          owner,
          repo,
          content: file.content,
          encoding: 'utf-8'
        });

        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha
        });
      }
    }

    // Create new tree
    const { data: newTree } = await this.octokit.rest.git.createTree({
      owner,
      repo,
      tree: treeEntries,
      base_tree: baseTreeSha
    });

    // Create the revert commit
    const { data: newCommit } = await this.octokit.rest.git.createCommit({
      owner,
      repo,
      message: revertMessage,
      tree: newTree.sha,
      parents: [currentCommitSha]
    });

    // Update branch ref
    await this.octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha
    });

    logger.info('Commit reverted successfully', {
      originalSha: sha,
      revertSha: newCommit.sha,
      branch,
      filesReverted: files.length
    });

    return {
      sha: newCommit.sha,
      message: revertMessage,
      url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
      filesReverted: files.map(f => f.filename)
    };
  }

  /**
   * Create a pull request
   */
  async createPullRequest(title, head, base, body = '', owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      title,
      head,
      base,
      body
    });

    logger.info('Pull request created', {
      number: data.number,
      title,
      head,
      base
    });

    return {
      number: data.number,
      url: data.html_url,
      title: data.title,
      state: data.state
    };
  }

  /**
   * Search code in repository
   */
  async searchCode(query, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.search.code({
      q: `${query} repo:${owner}/${repo}`,
      per_page: 30
    });

    return data.items.map(item => ({
      path: item.path,
      name: item.name,
      sha: item.sha,
      url: item.html_url,
      repository: item.repository.full_name
    }));
  }

  /**
   * List GitHub Actions workflows
   */
  async listWorkflows(owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.actions.listRepoWorkflows({
      owner,
      repo
    });

    return data.workflows.map(w => ({
      id: w.id,
      name: w.name,
      path: w.path,
      state: w.state
    }));
  }

  /**
   * Trigger a workflow dispatch
   */
  async triggerWorkflow(workflowId, ref = 'main', inputs = {}, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    await this.octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowId,
      ref,
      inputs
    });

    logger.info('Workflow triggered', { workflowId, ref });

    return { triggered: true, workflowId, ref };
  }

  /**
   * Get workflow run status
   */
  async getWorkflowRun(runId, owner = null, repo = null) {
    await this.initialize();
    owner = owner || this.config.defaultOwner;
    repo = repo || this.config.defaultRepo;

    const { data } = await this.octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId
    });

    return {
      id: data.id,
      status: data.status,
      conclusion: data.conclusion,
      workflowId: data.workflow_id,
      branch: data.head_branch,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      url: data.html_url
    };
  }

  /**
   * Get rate limit status
   */
  async getRateLimit() {
    await this.initialize();

    const { data } = await this.octokit.rest.rateLimit.get();

    return {
      limit: data.rate.limit,
      remaining: data.rate.remaining,
      reset: new Date(data.rate.reset * 1000).toISOString(),
      used: data.rate.used
    };
  }
}

// Singleton instance
let githubServiceInstance = null;

function getGitHubService() {
  if (!githubServiceInstance) {
    githubServiceInstance = new GitHubService();
  }
  return githubServiceInstance;
}

module.exports = {
  GitHubService,
  getGitHubService
};
