/**
 * Build Mode Manager
 * Manages build mode state, sessions, and permissions
 */

const { getFirestore, getFieldValue } = require('../../config/firestore');
const { logger } = require('../../utils/logger');
const { getGitHubService } = require('../github/githubService');

class BuildModeManager {
  constructor() {
    this.db = getFirestore();
    this.FieldValue = getFieldValue();
    this.SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    this.MAX_CONCURRENT_SESSIONS = 3;
  }

  /**
   * Check if build mode is enabled globally
   */
  async isBuildModeEnabled() {
    try {
      const doc = await this.db.doc('agent/build-mode').get();
      if (!doc.exists) return false;
      return doc.data()?.enabled === true;
    } catch (error) {
      logger.error('Error checking build mode status', { error: error.message });
      return false;
    }
  }

  /**
   * Check if GitHub integration is properly configured and verified
   * Build mode cannot be enabled without GitHub
   */
  async isGitHubReady() {
    try {
      const githubService = getGitHubService();
      const isEnabled = await githubService.isEnabled();

      if (!isEnabled) {
        return { ready: false, reason: 'GitHub integration is not enabled' };
      }

      const verification = await githubService.verifyConnection();
      if (!verification.connected) {
        return { ready: false, reason: verification.error || 'GitHub connection failed' };
      }

      return { ready: true, ...verification };
    } catch (error) {
      return { ready: false, reason: error.message };
    }
  }

  /**
   * Enable build mode
   */
  async enableBuildMode(userId, branch = 'main') {
    // First verify GitHub is ready
    const githubStatus = await this.isGitHubReady();
    if (!githubStatus.ready) {
      throw new Error(`Cannot enable Build Mode: ${githubStatus.reason}`);
    }

    // Check if already enabled by another user
    const currentState = await this.db.doc('agent/build-mode').get();
    if (currentState.exists && currentState.data()?.enabled && currentState.data()?.lockedBy !== userId) {
      throw new Error(`Build Mode is locked by another user: ${currentState.data().lockedBy}`);
    }

    // Enable build mode
    await this.db.doc('agent/build-mode').set({
      enabled: true,
      currentBranch: branch,
      activeSince: this.FieldValue.serverTimestamp(),
      activeUser: userId,
      lockedBy: userId,
      enabledAt: this.FieldValue.serverTimestamp(),
      enabledBy: userId
    }, { merge: true });

    logger.info('Build mode enabled', { userId, branch });

    // Create a build session
    const sessionId = await this.createBuildSession(userId, branch);

    return { enabled: true, sessionId, branch };
  }

  /**
   * Disable build mode
   */
  async disableBuildMode(userId) {
    const currentState = await this.db.doc('agent/build-mode').get();

    if (!currentState.exists || !currentState.data()?.enabled) {
      return { disabled: true, message: 'Build mode was not enabled' };
    }

    // Only the user who enabled it can disable (or admin)
    const data = currentState.data();
    if (data.lockedBy && data.lockedBy !== userId) {
      throw new Error(`Build Mode is locked by ${data.lockedBy}. Only they can disable it.`);
    }

    // Complete any active sessions
    const activeSessions = await this.db.collection('build-sessions')
      .where('userId', '==', userId)
      .where('status', '==', 'active')
      .get();

    const batch = this.db.batch();

    activeSessions.forEach(doc => {
      batch.update(doc.ref, {
        status: 'completed',
        completedAt: this.FieldValue.serverTimestamp()
      });
    });

    // Disable build mode
    batch.update(this.db.doc('agent/build-mode'), {
      enabled: false,
      lockedBy: null,
      activeUser: null,
      disabledAt: this.FieldValue.serverTimestamp(),
      disabledBy: userId
    });

    await batch.commit();

    logger.info('Build mode disabled', { userId });

    return { disabled: true };
  }

  /**
   * Get current build mode status
   */
  async getStatus() {
    const doc = await this.db.doc('agent/build-mode').get();

    if (!doc.exists) {
      return {
        enabled: false,
        githubConfigured: false
      };
    }

    const data = doc.data();
    const githubStatus = await this.isGitHubReady();

    return {
      enabled: data.enabled || false,
      currentBranch: data.currentBranch || null,
      activeUser: data.activeUser || null,
      lockedBy: data.lockedBy || null,
      activeSince: data.activeSince || null,
      githubReady: githubStatus.ready,
      githubUser: githubStatus.user || null,
      repository: githubStatus.repository || null
    };
  }

  /**
   * Create a new build session
   */
  async createBuildSession(userId, branch) {
    // Check concurrent session limit
    const activeSessions = await this.db.collection('build-sessions')
      .where('status', '==', 'active')
      .get();

    if (activeSessions.size >= this.MAX_CONCURRENT_SESSIONS) {
      throw new Error(`Maximum concurrent sessions (${this.MAX_CONCURRENT_SESSIONS}) reached`);
    }

    const sessionRef = this.db.collection('build-sessions').doc();
    const sessionId = sessionRef.id;

    await sessionRef.set({
      sessionId,
      userId,
      branch,
      status: 'active',
      startedAt: this.FieldValue.serverTimestamp(),
      completedAt: null,
      commits: [],
      files: [],
      buildId: null,
      buildStatus: null,
      lastActivity: this.FieldValue.serverTimestamp()
    });

    logger.info('Build session created', { sessionId, userId, branch });

    return sessionId;
  }

  /**
   * Get current active session for user
   */
  async getCurrentSession(userId) {
    const sessions = await this.db.collection('build-sessions')
      .where('userId', '==', userId)
      .where('status', '==', 'active')
      .orderBy('startedAt', 'desc')
      .limit(1)
      .get();

    if (sessions.empty) return null;

    return { id: sessions.docs[0].id, ...sessions.docs[0].data() };
  }

  /**
   * Update session activity (prevents timeout)
   */
  async touchSession(sessionId) {
    await this.db.collection('build-sessions').doc(sessionId).update({
      lastActivity: this.FieldValue.serverTimestamp()
    });
  }

  /**
   * Add commit to session
   */
  async addCommitToSession(sessionId, commit) {
    await this.db.collection('build-sessions').doc(sessionId).update({
      commits: this.FieldValue.arrayUnion({
        sha: commit.sha,
        message: commit.message,
        timestamp: new Date().toISOString()
      }),
      lastActivity: this.FieldValue.serverTimestamp()
    });
  }

  /**
   * Add modified file to session
   */
  async addFileToSession(sessionId, file) {
    await this.db.collection('build-sessions').doc(sessionId).update({
      files: this.FieldValue.arrayUnion({
        path: file.path,
        status: file.status,
        timestamp: new Date().toISOString()
      }),
      lastActivity: this.FieldValue.serverTimestamp()
    });
  }

  /**
   * Complete a build session
   */
  async completeBuildSession(sessionId, status = 'completed') {
    await this.db.collection('build-sessions').doc(sessionId).update({
      status,
      completedAt: this.FieldValue.serverTimestamp()
    });

    logger.info('Build session completed', { sessionId, status });
  }

  /**
   * Check if user can modify code
   */
  async canUserModifyCode(userId, userRole) {
    // Check if build mode is enabled
    const buildModeEnabled = await this.isBuildModeEnabled();
    if (!buildModeEnabled) {
      return { allowed: false, reason: 'Build mode is not enabled' };
    }

    // Check if user has build mode locked
    const status = await this.getStatus();
    if (status.lockedBy && status.lockedBy !== userId) {
      return { allowed: false, reason: `Build mode is locked by ${status.lockedBy}` };
    }

    // Check role permissions
    const allowedRoles = ['admin', 'developer'];
    if (!allowedRoles.includes(userRole)) {
      return { allowed: false, reason: 'Insufficient permissions' };
    }

    return { allowed: true };
  }

  /**
   * Lock build mode to a specific user
   */
  async lockBuildMode(userId) {
    const status = await this.getStatus();

    if (!status.enabled) {
      throw new Error('Build mode is not enabled');
    }

    if (status.lockedBy && status.lockedBy !== userId) {
      throw new Error(`Build mode is already locked by ${status.lockedBy}`);
    }

    await this.db.doc('agent/build-mode').update({
      lockedBy: userId,
      lockedAt: this.FieldValue.serverTimestamp()
    });

    return { locked: true, userId };
  }

  /**
   * Unlock build mode
   */
  async unlockBuildMode(userId) {
    const status = await this.getStatus();

    if (status.lockedBy && status.lockedBy !== userId) {
      throw new Error(`Only ${status.lockedBy} can unlock build mode`);
    }

    await this.db.doc('agent/build-mode').update({
      lockedBy: null,
      lockedAt: null
    });

    return { unlocked: true };
  }

  /**
   * Switch current branch
   */
  async switchBranch(userId, branchName) {
    const canModify = await this.canUserModifyCode(userId, 'admin');
    if (!canModify.allowed) {
      throw new Error(canModify.reason);
    }

    // Verify branch exists on GitHub
    const githubService = getGitHubService();
    await githubService.getBranch(branchName);

    await this.db.doc('agent/build-mode').update({
      currentBranch: branchName,
      branchSwitchedAt: this.FieldValue.serverTimestamp()
    });

    logger.info('Branch switched', { userId, branchName });

    return { switched: true, branch: branchName };
  }

  /**
   * Get session history for a user
   */
  async getSessionHistory(userId, limit = 10) {
    const sessions = await this.db.collection('build-sessions')
      .where('userId', '==', userId)
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get();

    return sessions.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Cleanup stale sessions (called periodically)
   */
  async cleanupStaleSessions() {
    const cutoffTime = new Date(Date.now() - this.SESSION_TIMEOUT);

    const staleSessions = await this.db.collection('build-sessions')
      .where('status', '==', 'active')
      .where('lastActivity', '<', cutoffTime)
      .get();

    if (staleSessions.empty) return { cleaned: 0 };

    const batch = this.db.batch();
    staleSessions.forEach(doc => {
      batch.update(doc.ref, {
        status: 'timeout',
        completedAt: this.FieldValue.serverTimestamp()
      });
    });

    await batch.commit();

    logger.info('Cleaned up stale sessions', { count: staleSessions.size });

    return { cleaned: staleSessions.size };
  }
}

// Singleton instance
let buildModeManagerInstance = null;

function getBuildModeManager() {
  if (!buildModeManagerInstance) {
    buildModeManagerInstance = new BuildModeManager();
  }
  return buildModeManagerInstance;
}

module.exports = {
  BuildModeManager,
  getBuildModeManager
};
