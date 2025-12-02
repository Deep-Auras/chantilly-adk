/**
 * Cloud Build Service
 * Triggers Cloud Build deployments after code commits
 */

const { google } = require('googleapis');
const { logger } = require('../utils/logger');
const { getFirestore } = require('../config/firestore');

class CloudBuildService {
  constructor() {
    this.cloudbuild = null;
    this.projectId = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      // Use default credentials (service account on Cloud Run)
      const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform']
      });

      this.cloudbuild = google.cloudbuild({ version: 'v1', auth });

      // Get project ID from GCP metadata service (automatic on Cloud Run)
      this.projectId = await this.getProjectIdFromMetadata();

      if (!this.projectId) {
        throw new Error('Could not determine Google Cloud project ID from metadata service');
      }

      this.initialized = true;
      logger.info('Cloud Build service initialized', { projectId: this.projectId });
    } catch (error) {
      logger.error('Failed to initialize Cloud Build service', { error: error.message });
      throw error;
    }
  }

  async getProjectIdFromMetadata() {
    try {
      const { GoogleAuth } = require('google-auth-library');
      const auth = new GoogleAuth();
      return await auth.getProjectId();
    } catch {
      return null;
    }
  }

  /**
   * Get the Cloud Build trigger ID - from Firestore or auto-detect
   */
  async getTriggerId() {
    logger.info('getTriggerId called');
    try {
      const db = getFirestore();
      const configDoc = await db.doc('agent/build-mode').get();
      const data = configDoc.data() || {};

      logger.info('getTriggerId Firestore check', {
        docExists: configDoc.exists,
        hasTriggerId: !!data.cloudBuildTriggerId,
        triggerId: data.cloudBuildTriggerId ? `${data.cloudBuildTriggerId.substring(0, 8)}...` : null
      });

      // First check if manually configured in Firestore
      if (configDoc.exists && data.cloudBuildTriggerId) {
        return data.cloudBuildTriggerId;
      }

      // Auto-detect trigger from Cloud Build API
      logger.info('getTriggerId calling autoDetectTriggerId');
      return await this.autoDetectTriggerId();
    } catch (error) {
      logger.error('Failed to get Cloud Build trigger ID', { error: error.message, stack: error.stack });
      return null;
    }
  }

  /**
   * Auto-detect Cloud Build trigger ID by matching repository
   */
  async autoDetectTriggerId() {
    await this.initialize();

    try {
      // Get repository info from Firestore
      const db = getFirestore();
      const buildModeDoc = await db.doc('agent/build-mode').get();
      const configDoc = await db.doc('agent/config').get();

      const buildMode = buildModeDoc.data() || {};
      const config = configDoc.data() || {};

      const repoOwner = buildMode.githubOwner || config.GITHUB_OWNER;
      const repoName = buildMode.githubRepo || config.GITHUB_REPO;

      if (!repoOwner || !repoName) {
        logger.debug('No GitHub repo configured, cannot auto-detect trigger');
        return null;
      }

      const targetRepo = `${repoOwner}/${repoName}`.toLowerCase();

      // List all triggers in the project
      const response = await this.cloudbuild.projects.triggers.list({
        projectId: this.projectId
      });

      const triggers = response.data.triggers || [];

      logger.info('Auto-detecting Cloud Build trigger', {
        targetRepo,
        triggersFound: triggers.length
      });

      // Find a trigger that matches our repository
      for (const trigger of triggers) {
        let triggerRepo = null;

        // Check different trigger source types
        if (trigger.github?.owner && trigger.github?.name) {
          // GitHub App connection (1st gen)
          triggerRepo = `${trigger.github.owner}/${trigger.github.name}`;
        } else if (trigger.repositoryEventConfig?.repository) {
          // Connected repository (2nd gen) - format: projects/PROJECT/locations/REGION/connections/CONNECTION/repositories/REPO
          const repoPath = trigger.repositoryEventConfig.repository;
          const repoMatch = repoPath.match(/repositories\/(.+)$/);
          if (repoMatch) {
            // 2nd gen repos often have owner-repo format
            triggerRepo = repoMatch[1].replace('-', '/');
          }
        } else if (trigger.triggerTemplate?.repoName) {
          // Cloud Source Repositories - format: github_owner_repo
          const csrRepo = trigger.triggerTemplate.repoName;
          if (csrRepo.startsWith('github_')) {
            // Extract owner/repo from github_owner_repo format
            const parts = csrRepo.replace('github_', '').split('_');
            if (parts.length >= 2) {
              triggerRepo = `${parts[0]}/${parts.slice(1).join('_')}`;
            }
          }
        }

        logger.debug('Checking trigger', {
          triggerId: trigger.id,
          triggerName: trigger.name,
          triggerRepo,
          targetRepo,
          hasGithub: !!trigger.github,
          hasRepoEventConfig: !!trigger.repositoryEventConfig,
          hasTriggerTemplate: !!trigger.triggerTemplate
        });

        if (triggerRepo && triggerRepo.toLowerCase() === targetRepo) {
          logger.info('Auto-detected Cloud Build trigger', {
            triggerId: trigger.id,
            triggerName: trigger.name,
            repo: targetRepo
          });

          // Cache the trigger ID in Firestore for faster lookups
          try {
            await db.doc('agent/build-mode').set({
              cloudBuildTriggerId: trigger.id,
              cloudBuildTriggerName: trigger.name,
              cloudBuildTriggerAutoDetected: true
            }, { merge: true });
          } catch (cacheError) {
            logger.debug('Could not cache trigger ID', { error: cacheError.message });
          }

          return trigger.id;
        }
      }

      // Log all triggers for debugging if none matched
      logger.warn('No matching Cloud Build trigger found for repository', {
        targetRepo,
        availableTriggers: triggers.map(t => ({
          id: t.id,
          name: t.name,
          github: t.github ? `${t.github.owner}/${t.github.name}` : null,
          repoEventConfig: t.repositoryEventConfig?.repository || null,
          triggerTemplate: t.triggerTemplate?.repoName || null
        }))
      });

      return null;
    } catch (error) {
      logger.error('Failed to auto-detect Cloud Build trigger', {
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  /**
   * Trigger a Cloud Build using an existing trigger or direct build
   * @param {string} branch - Branch to build
   * @param {string} commitSha - Commit SHA that triggered the build
   * @param {string} triggeredBy - User who approved the commit
   * @returns {Object} Build info
   */
  async triggerBuild(branch, commitSha, triggeredBy) {
    logger.info('triggerBuild START', { branch, commitSha: commitSha?.substring(0, 7), triggeredBy });

    await this.initialize();

    logger.info('triggerBuild calling getTriggerId');
    let triggerId = null;
    try {
      triggerId = await this.getTriggerId();
      logger.info('triggerBuild getTriggerId returned', { triggerId: triggerId ? `${triggerId.substring(0, 8)}...` : null });
    } catch (getTriggerIdError) {
      logger.error('triggerBuild getTriggerId THREW', { error: getTriggerIdError.message, stack: getTriggerIdError.stack });
    }

    // If no trigger ID configured, use direct build method
    if (!triggerId) {
      logger.info('No Cloud Build trigger ID configured, using direct build method', { branch });
      return await this.runBuildDirectly(branch, commitSha, triggeredBy);
    }

    try {
      logger.info('Triggering Cloud Build via trigger', {
        projectId: this.projectId,
        triggerId,
        branch,
        commitSha: commitSha?.substring(0, 7)
      });

      // Run the trigger with the specified branch
      // requestBody is a RepoSource object for triggers.run
      const response = await this.cloudbuild.projects.triggers.run({
        projectId: this.projectId,
        triggerId: triggerId,
        requestBody: {
          branchName: branch
        }
      });

      const build = response.data;
      const buildId = build.metadata?.build?.id || build.name?.split('/').pop();

      logger.info('Cloud Build triggered successfully', {
        buildId,
        branch,
        commitSha: commitSha?.substring(0, 7),
        triggeredBy
      });

      // Store build info in Firestore for tracking
      await this.recordBuild(buildId, branch, commitSha, triggeredBy);

      return {
        triggered: true,
        buildId,
        logUrl: `https://console.cloud.google.com/cloud-build/builds/${buildId}?project=${this.projectId}`
      };
    } catch (error) {
      logger.error('Failed to trigger Cloud Build via trigger, falling back to direct build', {
        error: error.message,
        branch,
        commitSha: commitSha?.substring(0, 7)
      });

      // If trigger fails, try running a build directly from the repo
      return await this.runBuildDirectly(branch, commitSha, triggeredBy);
    }
  }

  /**
   * Run a build directly without using a trigger
   * Fallback if trigger-based approach fails
   */
  async runBuildDirectly(branch, commitSha, triggeredBy) {
    try {
      const db = getFirestore();
      const configDoc = await db.doc('agent/config').get();
      const buildModeDoc = await db.doc('agent/build-mode').get();

      const config = configDoc.data() || {};
      const buildMode = buildModeDoc.data() || {};

      const repoOwner = buildMode.githubOwner || config.GITHUB_OWNER || 'Deep-Auras';
      const repoName = buildMode.githubRepo || config.GITHUB_REPO || 'chantilly-agent-morgan';

      logger.info('Running Cloud Build directly', {
        repoOwner,
        repoName,
        branch,
        commitSha: commitSha?.substring(0, 7)
      });

      const response = await this.cloudbuild.projects.builds.create({
        projectId: this.projectId,
        requestBody: {
          source: {
            repoSource: {
              projectId: this.projectId,
              repoName: `github_${repoOwner}_${repoName}`,
              branchName: branch
            }
          },
          steps: [
            {
              name: 'gcr.io/cloud-builders/docker',
              args: ['build', '-t', `gcr.io/${this.projectId}/chantilly-adk:$BUILD_ID`, '.']
            },
            {
              name: 'gcr.io/cloud-builders/docker',
              args: ['push', `gcr.io/${this.projectId}/chantilly-adk:$BUILD_ID`]
            },
            {
              name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
              entrypoint: 'gcloud',
              args: [
                'run', 'deploy', 'chantilly-agent-morgan',
                `--image=gcr.io/${this.projectId}/chantilly-adk:$BUILD_ID`,
                '--region=us-east4',
                '--platform=managed'
              ]
            }
          ],
          timeout: '1200s',
          options: {
            logging: 'CLOUD_LOGGING_ONLY',
            machineType: 'E2_HIGHCPU_8'
          },
          tags: ['build-mode', `branch-${branch.replace(/\//g, '-')}`]
        }
      });

      const build = response.data;
      const buildId = build.metadata?.build?.id || build.name?.split('/').pop();

      logger.info('Direct Cloud Build started', {
        buildId,
        branch,
        commitSha: commitSha?.substring(0, 7)
      });

      await this.recordBuild(buildId, branch, commitSha, triggeredBy);

      return {
        triggered: true,
        buildId,
        logUrl: `https://console.cloud.google.com/cloud-build/builds/${buildId}?project=${this.projectId}`,
        method: 'direct'
      };
    } catch (error) {
      logger.error('Failed to run direct Cloud Build', {
        error: error.message,
        branch
      });

      return {
        triggered: false,
        reason: error.message
      };
    }
  }

  /**
   * Record build in Firestore for tracking
   */
  async recordBuild(buildId, branch, commitSha, triggeredBy) {
    try {
      const db = getFirestore();
      const { getFieldValue } = require('../config/firestore');
      const FieldValue = getFieldValue();

      await db.collection('cloud-builds').doc(buildId).set({
        buildId,
        branch,
        commitSha,
        triggeredBy,
        status: 'QUEUED',
        triggeredAt: FieldValue.serverTimestamp()
      });
    } catch (error) {
      logger.warn('Failed to record build in Firestore', { error: error.message, buildId });
    }
  }

  /**
   * Get build status
   */
  async getBuildStatus(buildId) {
    await this.initialize();

    try {
      const response = await this.cloudbuild.projects.builds.get({
        projectId: this.projectId,
        id: buildId
      });

      return {
        status: response.data.status,
        logUrl: response.data.logUrl,
        startTime: response.data.startTime,
        finishTime: response.data.finishTime
      };
    } catch (error) {
      logger.error('Failed to get build status', { error: error.message, buildId });
      throw error;
    }
  }

  /**
   * List recent builds from Cloud Build API
   * @param {number} limit - Max number of builds to return
   * @returns {Array} List of builds
   */
  async listBuilds(limit = 10) {
    await this.initialize();

    try {
      // First try to get builds from Firestore (our tracked builds)
      const db = getFirestore();
      const firestoreBuilds = await db.collection('cloud-builds')
        .orderBy('triggeredAt', 'desc')
        .limit(limit)
        .get();

      const trackedBuilds = [];
      firestoreBuilds.forEach(doc => {
        trackedBuilds.push({ id: doc.id, ...doc.data() });
      });

      // Fetch latest status from Cloud Build API for each build
      const buildsWithStatus = await Promise.all(
        trackedBuilds.map(async (build) => {
          try {
            const status = await this.getBuildStatus(build.buildId);
            // Update Firestore if status changed
            if (status.status !== build.status) {
              await db.collection('cloud-builds').doc(build.buildId).update({
                status: status.status,
                startTime: status.startTime || null,
                finishTime: status.finishTime || null,
                logUrl: status.logUrl || null
              });
            }
            return {
              ...build,
              status: status.status,
              startTime: status.startTime,
              finishTime: status.finishTime,
              logUrl: status.logUrl || `https://console.cloud.google.com/cloud-build/builds/${build.buildId}?project=${this.projectId}`
            };
          } catch {
            // If API fails, return cached data
            return {
              ...build,
              logUrl: build.logUrl || `https://console.cloud.google.com/cloud-build/builds/${build.buildId}?project=${this.projectId}`
            };
          }
        })
      );

      return buildsWithStatus;
    } catch (error) {
      logger.error('Failed to list builds', { error: error.message });

      // Fallback: try to list from Cloud Build API directly
      try {
        const response = await this.cloudbuild.projects.builds.list({
          projectId: this.projectId,
          pageSize: limit
        });

        return (response.data.builds || []).map(build => ({
          buildId: build.id,
          status: build.status,
          branch: build.substitutions?.BRANCH_NAME || 'unknown',
          commitSha: build.substitutions?.COMMIT_SHA || null,
          triggeredBy: 'unknown',
          triggeredAt: build.createTime,
          startTime: build.startTime,
          finishTime: build.finishTime,
          logUrl: build.logUrl || `https://console.cloud.google.com/cloud-build/builds/${build.id}?project=${this.projectId}`
        }));
      } catch (apiError) {
        logger.error('Failed to list builds from API', { error: apiError.message });
        return [];
      }
    }
  }

  /**
   * Get project ID (for external use)
   */
  async getProjectId() {
    await this.initialize();
    return this.projectId;
  }
}

// Singleton
let cloudBuildService;

function getCloudBuildService() {
  if (!cloudBuildService) {
    cloudBuildService = new CloudBuildService();
  }
  return cloudBuildService;
}

module.exports = {
  CloudBuildService,
  getCloudBuildService
};
