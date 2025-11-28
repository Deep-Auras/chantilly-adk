/**
 * Bluesky Integration Service
 * Handles bidirectional communication with Bluesky AT Protocol API
 *
 * Features:
 * - Session-based authentication with automatic token refresh
 * - Profile search, retrieval, and following operations
 * - Feed monitoring and timeline access
 * - Post creation with rich text support
 * - Rate limiting (100 API calls/min, 50 follows/day)
 * - Encrypted credential storage in Firestore
 *
 * @module services/bskyService
 */

const { BskyAgent } = require('@atproto/api');
const bcrypt = require('bcrypt');
const { getFirestore, getFieldValue } = require('../config/firestore');
const { getEncryption } = require('../utils/encryption');
const { logger } = require('../utils/logger');

/**
 * Rate limiter for API calls
 */
class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests; // Max requests per window
    this.windowMs = windowMs; // Time window in milliseconds
    this.requests = []; // Array of request timestamps
  }

  /**
   * Check if request is allowed, wait if needed
   * @returns {Promise<boolean>} True if allowed
   */
  async checkLimit() {
    const now = Date.now();

    // Remove timestamps outside current window
    this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);

    if (this.requests.length >= this.maxRequests) {
      // Calculate wait time
      const oldestRequest = this.requests[0];
      const waitTime = this.windowMs - (now - oldestRequest);

      if (waitTime > 0) {
        logger.warn('Rate limit reached, waiting', { waitMs: waitTime });
        await new Promise(resolve => setTimeout(resolve, waitTime + 100));
        return this.checkLimit(); // Recursively check after wait
      }
    }

    // Add current request
    this.requests.push(now);
    return true;
  }

  /**
   * Get current request count in window
   * @returns {number}
   */
  getCurrentCount() {
    const now = Date.now();
    this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);
    return this.requests.length;
  }
}

/**
 * Daily limiter for follows
 */
class DailyLimiter {
  constructor(maxPerDay) {
    this.maxPerDay = maxPerDay;
    this.db = getFirestore();
    this.FieldValue = getFieldValue();
  }

  /**
   * Check if follow is allowed today
   * @returns {Promise<{allowed: boolean, count: number, remaining: number}>}
   */
  async checkLimit() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    try {
      const docRef = this.db.collection('bluesky-rate-limits').doc('daily-follows');
      const doc = await docRef.get();

      if (!doc.exists) {
        // First follow today
        await docRef.set({
          date: today,
          count: 0,
          updated: this.FieldValue.serverTimestamp()
        });

        return { allowed: true, count: 0, remaining: this.maxPerDay };
      }

      const data = doc.data();

      // Check if date changed (new day)
      if (data.date !== today) {
        // Reset counter for new day
        await docRef.set({
          date: today,
          count: 0,
          updated: this.FieldValue.serverTimestamp()
        });

        return { allowed: true, count: 0, remaining: this.maxPerDay };
      }

      // Check current count
      const count = data.count || 0;
      const remaining = this.maxPerDay - count;

      if (count >= this.maxPerDay) {
        logger.warn('Daily follow limit reached', { count, maxPerDay: this.maxPerDay });
        return { allowed: false, count, remaining: 0 };
      }

      return { allowed: true, count, remaining };
    } catch (error) {
      logger.error('Error checking daily follow limit', { error: error.message });
      // Fail open (allow request if Firestore error)
      return { allowed: true, count: 0, remaining: this.maxPerDay };
    }
  }

  /**
   * Increment daily follow counter
   * @returns {Promise<number>} New count
   */
  async increment() {
    const today = new Date().toISOString().split('T')[0];

    try {
      const docRef = this.db.collection('bluesky-rate-limits').doc('daily-follows');

      // Use Firestore transaction for atomic increment
      const newCount = await this.db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);

        if (!doc.exists || doc.data().date !== today) {
          transaction.set(docRef, {
            date: today,
            count: 1,
            updated: this.FieldValue.serverTimestamp()
          });
          return 1;
        }

        const currentCount = doc.data().count || 0;
        const newCount = currentCount + 1;

        transaction.update(docRef, {
          count: newCount,
          updated: this.FieldValue.serverTimestamp()
        });

        return newCount;
      });

      return newCount;
    } catch (error) {
      logger.error('Error incrementing follow count', { error: error.message });
      return 0;
    }
  }
}

/**
 * LRU Cache for profile data
 */
class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) {
      return null;
    }

    // Move to end (most recent)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    // Remove if exists (to update order)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Add to end
    this.cache.set(key, value);

    // Evict oldest if over limit
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  get size() {
    return this.cache.size;
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * Bluesky service for AT Protocol operations
 */
class BskyService {
  constructor() {
    this.agent = null;
    this.session = null;
    this.db = getFirestore();
    this.FieldValue = getFieldValue();
    this.encryption = getEncryption();
    this.initialized = false;

    // Rate limiting
    const rateLimit = parseInt(process.env.BLUESKY_RATE_LIMIT_PER_MINUTE) || 100;
    const followLimit = parseInt(process.env.BLUESKY_FOLLOW_LIMIT_PER_DAY) || 50;

    this.rateLimiter = new RateLimiter(rateLimit, 60000); // Per minute
    this.followLimiter = new DailyLimiter(followLimit);

    // Profile cache (LRU eviction)
    this.profileCache = new LRUCache(1000);

    // Session refresh tracking
    this.lastRefresh = null;
    this.refreshAttempts = 0;
    this.maxRefreshAttempts = 3;

    // Service URL
    this.serviceUrl = process.env.BLUESKY_SERVICE_URL || 'https://bsky.social';
  }

  /**
   * Initialize Bluesky service
   * Loads session from Firestore or creates new session
   *
   * @returns {Promise<boolean>} True if initialized successfully
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }

    try {
      // Check if integration enabled via dashboard configuration
      const platformDoc = await this.db.collection('agent').doc('platforms').collection('bluesky').doc('config').get();

      if (!platformDoc.exists || !platformDoc.data().enabled) {
        logger.info('Bluesky integration disabled in dashboard');
        return false;
      }

      const platformConfig = platformDoc.data();

      // Get service URL from config (fallback to default)
      this.serviceUrl = platformConfig.serviceUrl || 'https://bsky.social';

      // Create agent
      this.agent = new BskyAgent({ service: this.serviceUrl });

      // Try to load existing session
      const sessionLoaded = await this.loadSession();

      if (!sessionLoaded) {
        // Create new session using dashboard credentials
        const sessionCreated = await this.createSession();

        if (!sessionCreated) {
          logger.error('Failed to create Bluesky session');
          return false;
        }
      }

      this.initialized = true;
      logger.info('Bluesky service initialized', {
        handle: this.session?.handle,
        did: this.session?.did
      });

      return true;
    } catch (error) {
      logger.error('Failed to initialize Bluesky service', { error: error.message });
      return false;
    }
  }

  /**
   * Load session from Firestore
   * @returns {Promise<boolean>} True if session loaded successfully
   */
  async loadSession() {
    try {
      const docRef = this.db.collection('bluesky-credentials').doc('auth');
      const doc = await docRef.get();

      if (!doc.exists) {
        logger.info('No existing Bluesky session found');
        return false;
      }

      const data = doc.data();

      // Check if session expired
      if (data.sessionExpiry && data.sessionExpiry.toDate() < new Date()) {
        logger.info('Bluesky session expired, refreshing');
        return await this.refreshSession(data);
      }

      // Decrypt tokens
      if (!this.encryption.isEnabled()) {
        logger.error('Encryption not enabled, cannot decrypt session');
        return false;
      }

      const accessJwt = this.encryption.decrypt(data.accessJwt);
      const refreshJwt = this.encryption.decrypt(data.refreshJwt);

      // Resume session
      await this.agent.resumeSession({
        accessJwt,
        refreshJwt,
        did: data.did,
        handle: data.username
      });

      this.session = {
        did: data.did,
        handle: data.username,
        accessJwt,
        refreshJwt
      };

      logger.info('Bluesky session loaded from Firestore', { handle: data.username });
      return true;
    } catch (error) {
      logger.error('Failed to load Bluesky session', { error: error.message });
      return false;
    }
  }

  /**
   * Create new session with credentials
   * @returns {Promise<boolean>} True if session created successfully
   */
  async createSession() {
    try {
      // Load credentials from dashboard configuration
      const platformDoc = await this.db.collection('agent').doc('platforms').collection('bluesky').doc('config').get();

      if (!platformDoc.exists) {
        logger.error('Bluesky platform configuration not found');
        return false;
      }

      const platformConfig = platformDoc.data();
      const handle = platformConfig.handle;

      if (!handle) {
        logger.error('Bluesky handle not configured in dashboard');
        return false;
      }

      // Get encrypted app password from credentials collection
      const credentialsDoc = await this.db.collection('agent').doc('credentials').get();

      if (!credentialsDoc.exists || !credentialsDoc.data().bluesky_app_password) {
        logger.error('Bluesky app password not configured in dashboard');
        return false;
      }

      const encryptedPassword = credentialsDoc.data().bluesky_app_password;

      // Decrypt app password
      if (!this.encryption.isEnabled()) {
        logger.error('Encryption not enabled, cannot decrypt Bluesky credentials');
        return false;
      }

      const appPassword = this.encryption.decryptCredential(encryptedPassword);

      // Login
      logger.info('Creating Bluesky session', { handle });
      const response = await this.agent.login({ identifier: handle, password: appPassword });

      if (!response.success) {
        logger.error('Bluesky login failed', {
          handle,
          responseData: response.data || 'no data',
          responseHeaders: response.headers || 'no headers'
        });
        return false;
      }

      logger.info('Bluesky login successful', {
        handle,
        did: response.data.did,
        actualHandle: response.data.handle
      });

      this.session = {
        did: response.data.did,
        handle: response.data.handle,
        accessJwt: response.data.accessJwt,
        refreshJwt: response.data.refreshJwt
      };

      // Store session in Firestore
      await this.saveSession();

      logger.info('Bluesky session created', {
        handle: this.session.handle,
        did: this.session.did
      });

      return true;
    } catch (error) {
      logger.error('Failed to create Bluesky session', {
        error: error.message,
        errorCode: error.code || 'no code',
        errorStatus: error.status || 'no status',
        errorStack: error.stack
      });
      return false;
    }
  }

  /**
   * Save session to Firestore with encrypted tokens
   * @returns {Promise<void>}
   */
  async saveSession() {
    if (!this.session) {
      throw new Error('No session to save');
    }

    if (!this.encryption.isEnabled()) {
      throw new Error('Encryption not enabled, cannot save session');
    }

    try {
      // Encrypt tokens
      const encryptedAccessJwt = this.encryption.encrypt(this.session.accessJwt);
      const encryptedRefreshJwt = this.encryption.encrypt(this.session.refreshJwt);

      // Calculate expiry (access tokens typically expire in 2 hours)
      const sessionExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);

      const docRef = this.db.collection('bluesky-credentials').doc('auth');
      await docRef.set({
        username: this.session.handle,
        did: this.session.did,
        accessJwt: encryptedAccessJwt,
        refreshJwt: encryptedRefreshJwt,
        sessionCreated: this.FieldValue.serverTimestamp(),
        sessionExpiry: sessionExpiry,
        updated: this.FieldValue.serverTimestamp()
      });

      logger.info('Bluesky session saved to Firestore');
    } catch (error) {
      logger.error('Failed to save Bluesky session', { error: error.message });
      throw error;
    }
  }

  /**
   * Refresh session using refreshJwt
   * @param {Object} sessionData - Existing session data from Firestore
   * @returns {Promise<boolean>} True if refresh successful
   */
  async refreshSession(sessionData = null) {
    // Prevent refresh loops
    if (this.lastRefresh && Date.now() - this.lastRefresh < 60000) {
      logger.warn('Refresh attempted too soon, skipping', {
        secondsSinceLastRefresh: Math.floor((Date.now() - this.lastRefresh) / 1000)
      });
      return false;
    }

    if (this.refreshAttempts >= this.maxRefreshAttempts) {
      logger.error('Max refresh attempts reached', { attempts: this.refreshAttempts });
      this.refreshAttempts = 0; // Reset for next attempt
      return false;
    }

    this.refreshAttempts++;
    this.lastRefresh = Date.now();

    try {
      let refreshJwt;

      if (sessionData) {
        // Decrypt from provided session data
        refreshJwt = this.encryption.decrypt(sessionData.refreshJwt);
      } else if (this.session) {
        // Use current session
        refreshJwt = this.session.refreshJwt;
      } else {
        logger.error('No session data available for refresh');
        return false;
      }

      logger.info('Refreshing Bluesky session', { attempt: this.refreshAttempts });

      // Call refresh API
      const response = await this.agent.com.atproto.server.refreshSession({}, {
        headers: {
          Authorization: `Bearer ${refreshJwt}`
        }
      });

      if (!response.success) {
        logger.error('Session refresh failed', {
          responseData: response.data || 'no data',
          responseHeaders: response.headers || 'no headers',
          attempt: this.refreshAttempts
        });
        return false;
      }

      // Update session
      this.session = {
        did: response.data.did,
        handle: response.data.handle,
        accessJwt: response.data.accessJwt,
        refreshJwt: response.data.refreshJwt
      };

      // Save updated session
      await this.saveSession();

      // Reset refresh attempts on success
      this.refreshAttempts = 0;

      logger.info('Bluesky session refreshed successfully');
      return true;
    } catch (error) {
      logger.error('Failed to refresh Bluesky session', {
        error: error.message,
        errorCode: error.code || 'no code',
        errorStatus: error.status || 'no status',
        errorStack: error.stack,
        attempt: this.refreshAttempts
      });
      return false;
    }
  }

  /**
   * Search for profiles matching query
   *
   * @param {string} query - Search query (keywords, handles, etc.)
   * @param {number} limit - Max results (default: 20)
   * @returns {Promise<Array>} Array of profile objects
   */
  async searchProfiles(query, limit = 20) {
    await this.ensureInitialized();
    await this.rateLimiter.checkLimit();

    try {
      logger.info('Searching Bluesky profiles', { query, limit });

      const response = await this.agent.searchActors({
        term: query,
        limit: Math.min(limit, 100) // Max 100 per request
      });

      if (!response.success) {
        throw new Error('Search failed');
      }

      // NOTE: searchActors returns ProfileView which does NOT include followersCount/followsCount/postsCount
      // These fields only available in ProfileViewDetailed from getProfile endpoint
      const profiles = response.data.actors.map(actor => ({
        did: actor.did,
        handle: actor.handle,
        displayName: actor.displayName,
        description: actor.description || '',
        avatarUrl: actor.avatar
      }));

      logger.info('Profile search complete', {
        query,
        resultsCount: profiles.length
      });

      return profiles;
    } catch (error) {
      logger.error('Profile search failed', { query, error: error.message });
      throw error;
    }
  }

  /**
   * Get suggested follows for an actor (using Bluesky's recommendation algorithm)
   *
   * @param {string} actor - Handle or DID (defaults to authenticated user)
   * @returns {Promise<Array>} Array of suggested profile objects
   */
  async getSuggestedFollows(actor = null) {
    await this.ensureInitialized();
    await this.rateLimiter.checkLimit();

    try {
      // Use authenticated user if no actor specified
      const targetActor = actor || this.session.did;

      logger.info('Fetching Bluesky suggested follows', { actor: targetActor });

      const response = await this.agent.app.bsky.graph.getSuggestedFollowsByActor({
        actor: targetActor
      });

      if (!response.success) {
        throw new Error('Suggested follows fetch failed');
      }

      // NOTE: getSuggestedFollowsByActor returns ProfileView which does NOT include followersCount/followsCount/postsCount
      // These fields only available in ProfileViewDetailed from getProfile endpoint
      const profiles = response.data.suggestions.map(actor => ({
        did: actor.did,
        handle: actor.handle,
        displayName: actor.displayName,
        description: actor.description || '',
        avatarUrl: actor.avatar
      }));

      logger.info('Suggested follows fetched', {
        actor: targetActor,
        suggestionsCount: profiles.length
      });

      return profiles;
    } catch (error) {
      logger.error('Failed to fetch suggested follows', {
        actor: actor || 'self',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get who an actor follows
   *
   * @param {string} actor - Handle or DID
   * @param {number} limit - Max results (default: 50)
   * @returns {Promise<Array>} Array of profile objects
   */
  async getFollows(actor, limit = 50) {
    await this.ensureInitialized();
    await this.rateLimiter.checkLimit();

    try {
      logger.info('Fetching who actor follows', { actor, limit });

      const response = await this.agent.app.bsky.graph.getFollows({
        actor,
        limit: Math.min(limit, 100)
      });

      if (!response.success) {
        throw new Error('Get follows failed');
      }

      // NOTE: getFollows returns ProfileView which does NOT include followersCount/followsCount/postsCount
      const profiles = response.data.follows.map(actor => ({
        did: actor.did,
        handle: actor.handle,
        displayName: actor.displayName,
        description: actor.description || '',
        avatarUrl: actor.avatar
      }));

      logger.info('Follows fetched', { actor, count: profiles.length });
      return profiles;
    } catch (error) {
      logger.error('Failed to fetch follows', { actor, error: error.message });
      throw error;
    }
  }

  /**
   * Get who follows an actor
   *
   * @param {string} actor - Handle or DID
   * @param {number} limit - Max results (default: 50)
   * @returns {Promise<Array>} Array of profile objects
   */
  async getFollowers(actor, limit = 50) {
    await this.ensureInitialized();
    await this.rateLimiter.checkLimit();

    try {
      logger.info('Fetching actor followers', { actor, limit });

      const response = await this.agent.app.bsky.graph.getFollowers({
        actor,
        limit: Math.min(limit, 100)
      });

      if (!response.success) {
        throw new Error('Get followers failed');
      }

      // NOTE: getFollowers returns ProfileView which does NOT include followersCount/followsCount/postsCount
      const profiles = response.data.followers.map(actor => ({
        did: actor.did,
        handle: actor.handle,
        displayName: actor.displayName,
        description: actor.description || '',
        avatarUrl: actor.avatar
      }));

      logger.info('Followers fetched', { actor, count: profiles.length });
      return profiles;
    } catch (error) {
      logger.error('Failed to fetch followers', { actor, error: error.message });
      throw error;
    }
  }

  /**
   * Get profile by handle or DID
   *
   * @param {string} handleOrDid - Bluesky handle or DID
   * @returns {Promise<Object>} Profile object
   */
  async getProfile(handleOrDid) {
    await this.ensureInitialized();

    // Check cache first
    const cached = this.profileCache.get(handleOrDid);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      // Cache valid for 5 minutes
      return cached.profile;
    }

    await this.rateLimiter.checkLimit();

    try {
      logger.info('Fetching Bluesky profile', { handleOrDid });

      const response = await this.agent.getProfile({ actor: handleOrDid });

      if (!response.success) {
        throw new Error('Profile fetch failed');
      }

      const profile = {
        did: response.data.did,
        handle: response.data.handle,
        displayName: response.data.displayName,
        description: response.data.description || '',
        avatarUrl: response.data.avatar,
        followersCount: response.data.followersCount || 0,
        followingCount: response.data.followsCount || 0,
        postsCount: response.data.postsCount || 0,
        labels: response.data.labels || []
      };

      // Cache profile
      this.profileCache.set(handleOrDid, {
        profile,
        timestamp: Date.now()
      });

      return profile;
    } catch (error) {
      logger.error('Failed to fetch profile', { handleOrDid, error: error.message });
      throw error;
    }
  }

  /**
   * Follow a user
   *
   * @param {string} did - User DID to follow
   * @returns {Promise<string>} Follow record URI
   */
  async followUser(did) {
    await this.ensureInitialized();

    // Check daily limit
    const limitCheck = await this.followLimiter.checkLimit();
    if (!limitCheck.allowed) {
      throw new Error(`Daily follow limit reached (${limitCheck.count}/${this.followLimiter.maxPerDay}). Try again tomorrow.`);
    }

    await this.rateLimiter.checkLimit();

    try {
      logger.info('Following Bluesky user', { did });

      const response = await this.agent.follow(did);

      if (!response) {
        throw new Error('Follow failed');
      }

      // Increment daily counter
      const newCount = await this.followLimiter.increment();

      // Store in Firestore
      const profile = await this.getProfile(did);

      await this.db.collection('bluesky-followed-profiles').doc(did).set({
        did,
        handle: profile.handle,
        displayName: profile.displayName,
        description: profile.description,
        avatarUrl: profile.avatarUrl,
        followersCount: profile.followersCount,
        followingCount: profile.followingCount,
        postsCount: profile.postsCount,
        followedAt: this.FieldValue.serverTimestamp(),
        followUri: response.uri
      });

      logger.info('User followed successfully', {
        did,
        handle: profile.handle,
        dailyCount: newCount
      });

      return response.uri;
    } catch (error) {
      logger.error('Failed to follow user', { did, error: error.message });
      throw error;
    }
  }

  /**
   * Get timeline feed
   *
   * @param {string} algorithm - Feed algorithm ('timeline' or 'following')
   * @param {number} limit - Max posts (default: 50)
   * @returns {Promise<Array>} Array of post objects
   */
  async getFeed(algorithm = 'timeline', limit = 50) {
    await this.ensureInitialized();
    await this.rateLimiter.checkLimit();

    try {
      logger.info('Fetching Bluesky feed', { algorithm, limit });

      let response;
      if (algorithm === 'timeline') {
        response = await this.agent.getTimeline({ limit: Math.min(limit, 100) });
      } else {
        // Following feed
        response = await this.agent.api.app.bsky.feed.getAuthorFeed({
          actor: this.session.did,
          limit: Math.min(limit, 100)
        });
      }

      if (!response.success) {
        throw new Error('Feed fetch failed');
      }

      const posts = response.data.feed.map(item => ({
        uri: item.post.uri,
        cid: item.post.cid,
        author: {
          did: item.post.author.did,
          handle: item.post.author.handle,
          displayName: item.post.author.displayName,
          avatarUrl: item.post.author.avatar
        },
        text: item.post.record.text,
        createdAt: item.post.record.createdAt,
        likeCount: item.post.likeCount || 0,
        repostCount: item.post.repostCount || 0,
        replyCount: item.post.replyCount || 0
      }));

      logger.info('Feed fetched successfully', { postsCount: posts.length });
      return posts;
    } catch (error) {
      logger.error('Failed to fetch feed', { algorithm, error: error.message });
      throw error;
    }
  }

  /**
   * Create external link embed with thumbnail
   *
   * @param {string} url - External URL to embed
   * @param {Object} options - Embed options (title, description, thumbnailUrl)
   * @returns {Promise<Object>} Embed object for post
   */
  async createExternalEmbed(url, options = {}) {
    await this.ensureInitialized();
    await this.rateLimiter.checkLimit();

    try {
      const { title, description, thumbnailUrl } = options;

      if (!url) {
        throw new Error('URL required for external embed');
      }

      logger.info('Creating external embed', { url, title, hasThumbnail: !!thumbnailUrl });

      // Download thumbnail image if provided
      let thumbBlob = null;
      if (thumbnailUrl) {
        try {
          logger.info('Downloading thumbnail', { thumbnailUrl });

          const thumbResponse = await fetch(thumbnailUrl, {
            timeout: 15000,
            headers: {
              'User-Agent': 'Chantilly-ADK/1.0'
            }
          });

          if (!thumbResponse.ok) {
            throw new Error(`Thumbnail download failed: ${thumbResponse.status}`);
          }

          // Convert to blob
          const imageBuffer = await thumbResponse.arrayBuffer();
          const imageBlob = new Blob([imageBuffer], {
            type: thumbResponse.headers.get('content-type') || 'image/jpeg'
          });

          logger.info('Uploading thumbnail to Bluesky', {
            size: imageBlob.size,
            type: imageBlob.type
          });

          // Upload blob to Bluesky
          const uploadResult = await this.agent.uploadBlob(imageBlob, {
            encoding: imageBlob.type
          });

          thumbBlob = uploadResult.data.blob;

          logger.info('Thumbnail uploaded successfully', {
            blobRef: thumbBlob.ref.toString()
          });
        } catch (error) {
          logger.warn('Failed to upload thumbnail, embed will have no image', {
            error: error.message,
            thumbnailUrl
          });
          // Continue without thumbnail
        }
      }

      // Create embed object
      const embed = {
        $type: 'app.bsky.embed.external',
        external: {
          uri: url,
          title: title || url,
          description: description || ''
        }
      };

      // Add thumbnail if available
      if (thumbBlob) {
        embed.external.thumb = thumbBlob;
      }

      logger.info('External embed created', {
        hasThumb: !!thumbBlob,
        titleLength: embed.external.title.length,
        descLength: embed.external.description.length
      });

      return embed;
    } catch (error) {
      logger.error('Failed to create external embed', {
        error: error.message,
        url,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Create a post
   *
   * @param {string} text - Post text content
   * @param {Object} options - Additional options (langs, createdAt, embed, facets, etc.)
   * @returns {Promise<Object>} Post URI and CID
   */
  async createPost(text, options = {}) {
    await this.ensureInitialized();
    await this.rateLimiter.checkLimit();

    try {
      if (!text || text.length > 300) {
        const errorMsg = text
          ? `Post text exceeds Bluesky's 300 character limit (${text.length} characters)`
          : 'Post text cannot be empty';
        logger.error('Post validation failed', { textLength: text?.length || 0, limit: 300 });
        throw new Error(errorMsg);
      }

      logger.info('Creating Bluesky post', { textLength: text.length, limit: 300, remaining: 300 - text.length });

      const postData = {
        text,
        createdAt: options.createdAt || new Date().toISOString(),
        langs: options.langs || ['en']
      };

      // Add facets if provided (for clickable links, mentions, hashtags)
      if (options.facets && Array.isArray(options.facets) && options.facets.length > 0) {
        postData.facets = options.facets;
      }

      // Add embed if provided (for rich preview cards with thumbnails)
      if (options.embed) {
        postData.embed = options.embed;
        logger.info('Post includes embed', {
          embedType: options.embed.$type,
          hasThumb: !!options.embed.external?.thumb
        });
      }

      logger.info('Calling BskyAgent.post() with data', {
        textLength: postData.text.length,
        textPreview: postData.text.substring(0, 100),
        createdAt: postData.createdAt,
        langs: postData.langs,
        facetsCount: postData.facets?.length || 0,
        hasEmbed: !!postData.embed,
        embedType: postData.embed?.$type || null
      });

      const response = await this.agent.post(postData);

      if (!response) {
        throw new Error('Post creation failed');
      }

      logger.info('Bluesky post created successfully', {
        uri: response.uri,
        cid: response.cid
      });

      // Sanitize URI for Firestore document ID (URIs contain // which is invalid)
      // Example URI: at://did:plc:xxx/app.bsky.feed.post/xxx
      const sanitizedUri = response.uri.replace(/\//g, '_');

      // Store in Firestore
      await this.db.collection('bluesky-posts').doc(sanitizedUri).set({
        uri: response.uri,
        cid: response.cid,
        text,
        createdAt: this.FieldValue.serverTimestamp(),
        youtubeVideoId: options.youtubeVideoId || null,
        targetPersonas: options.targetPersonas || [],
        engagement: { likes: 0, reposts: 0, replies: 0 },
        lastUpdated: this.FieldValue.serverTimestamp()
      });

      logger.info('Post saved to Firestore', { sanitizedUri });

      // Construct Bluesky post URL
      const postRkey = response.uri.split('/').pop();
      const postUrl = `https://bsky.app/profile/${this.session.did}/post/${postRkey}`;

      logger.info('Bluesky post URL constructed', {
        uri: response.uri,
        did: this.session.did,
        rkey: postRkey,
        url: postUrl,
        urlLength: postUrl.length
      });

      return {
        uri: response.uri,
        cid: response.cid,
        url: postUrl
      };
    } catch (error) {
      logger.error('Failed to create post', {
        error: error.message,
        stack: error.stack,
        textLength: text?.length,
        postData: { text: text.substring(0, 100) + '...', createdAt: options.createdAt, langs: options.langs }
      });
      throw error;
    }
  }

  /**
   * Ensure service is initialized
   * @throws {Error} If not initialized
   */
  async ensureInitialized() {
    if (!this.initialized) {
      const success = await this.initialize();
      if (!success) {
        throw new Error('Bluesky service not initialized');
      }
    }
  }

  /**
   * Get service status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      initialized: this.initialized,
      handle: this.session?.handle,
      did: this.session?.did,
      rateLimitRemaining: this.rateLimiter.maxRequests - this.rateLimiter.getCurrentCount(),
      profileCacheSize: this.profileCache.size
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    this.profileCache.clear();
    this.initialized = false;
    this.session = null;
    logger.info('Bluesky service cleanup complete');
  }
}

// Singleton instance
let instance = null;

/**
 * Get Bluesky service instance
 * @returns {BskyService}
 */
function getBskyService() {
  if (!instance) {
    instance = new BskyService();
  }
  return instance;
}

module.exports = { BskyService, getBskyService };
