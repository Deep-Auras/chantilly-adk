/**
 * Bluesky API Integration Guide
 *
 * Category: system_information (hidden from users, high priority for AI)
 * Priority: 95 (Critical for Gemini AI)
 * Tags: bluesky, api, at-protocol, social-media, integration
 *
 * IMPORTANT: This knowledge base document is PUBLIC and should be committed to git
 * despite examples/knowledgeBase/ being in .gitignore. Use: git add -f <this-file>
 */

const blueskyApiGuide = `# Bluesky API Integration Guide

## Overview

Bluesky is a decentralized social network built on the AT Protocol (Authenticated Transfer Protocol). The platform provides a rich API for social interactions, content management, and network operations.

**Official Documentation**: https://docs.bsky.app/

## AT Protocol Fundamentals

### DIDs (Decentralized Identifiers)

Every Bluesky account has a unique DID (Decentralized Identifier):
- Format: \`did:plc:abcd1234efgh5678\`
- DIDs are permanent and never change
- Handles can change, but DIDs remain constant
- Always use DIDs for database storage and identity tracking

**Example**:
\`\`\`javascript
// DID format
const did = 'did:plc:z72i7hdynmk6r22z27h6tvur';

// Handle format (can change)
const handle = 'alice.bsky.social';
\`\`\`

### Handles vs DIDs

- **Handles**: Human-readable usernames (e.g., \`@alice.bsky.social\`)
- **DIDs**: Permanent identifiers for accounts
- **Best Practice**: Store DIDs in database, display handles to users

## Authentication

### Service Authentication (Bot/Agent)

Bluesky uses OAuth-style authentication with session tokens:

\`\`\`javascript
const { BskyAgent } = require('@atproto/api');

const agent = new BskyAgent({
  service: 'https://bsky.social'
});

// Login with identifier (handle or email) and app password
await agent.login({
  identifier: 'your-handle.bsky.social',
  password: 'your-app-password' // NOT your account password - create app password in settings
});

// Session is now active and includes:
// - agent.session.accessJwt (access token)
// - agent.session.refreshJwt (refresh token)
// - agent.session.did (your DID)
// - agent.session.handle (your handle)
\`\`\`

**CRITICAL**: Use app passwords, not account passwords. Create app passwords at:
https://bsky.app/settings/app-passwords

### Session Management

Sessions expire after ~2 hours. Implement refresh logic:

\`\`\`javascript
// Check if session is expired
if (!agent.session || isExpired(agent.session.accessJwt)) {
  // Refresh session
  await agent.resumeSession(agent.session);
}

// Or re-login
await agent.login({
  identifier: process.env.BLUESKY_IDENTIFIER,
  password: process.env.BLUESKY_APP_PASSWORD
});
\`\`\`

## Core API Operations

### 1. Profile Operations

#### Get Profile

\`\`\`javascript
// Get profile by handle
const profile = await agent.getProfile({
  actor: 'alice.bsky.social' // or DID
});

// Profile data includes:
// - did: "did:plc:..."
// - handle: "alice.bsky.social"
// - displayName: "Alice"
// - description: "Bio text"
// - avatar: "https://cdn.bsky.app/img/..."
// - followersCount: 1234
// - followsCount: 567
// - postsCount: 890
\`\`\`

#### Search Profiles

\`\`\`javascript
const searchResults = await agent.searchActors({
  term: 'web developer', // Search term
  limit: 25 // Max 100
});

// Returns: searchResults.actors[]
// Each actor has: did, handle, displayName, description, avatar
\`\`\`

### 2. Follow Operations

#### Follow User

\`\`\`javascript
const followUri = await agent.follow(did);

// Returns: at://did:plc:.../app.bsky.graph.follow/...
// Store this URI to unfollow later
\`\`\`

#### Unfollow User

\`\`\`javascript
await agent.deleteFollow(followUri);
\`\`\`

#### Get Suggested Follows

\`\`\`javascript
const suggestions = await agent.getSuggestions({
  limit: 50 // Max 100
});

// Returns real, active accounts suggested by Bluesky's algorithm
// Each suggestion includes: did, handle, displayName, description, avatar
\`\`\`

### 3. Feed Operations

#### Get Timeline Feed

\`\`\`javascript
// Home timeline (algorithmic feed)
const timeline = await agent.getTimeline({
  limit: 50, // Max 100
  cursor: undefined // For pagination
});

// Returns:
// - timeline.feed[] (array of feed items)
// - timeline.cursor (for next page)
\`\`\`

#### Get Following Feed

\`\`\`javascript
// Chronological feed from followed users
const following = await agent.getAuthorFeed({
  actor: agent.session.did,
  limit: 50
});
\`\`\`

#### Feed Item Structure

\`\`\`javascript
{
  post: {
    uri: "at://did:plc:.../app.bsky.feed.post/...",
    cid: "bafyrei...",
    author: {
      did: "did:plc:...",
      handle: "alice.bsky.social",
      displayName: "Alice",
      avatar: "https://..."
    },
    record: {
      text: "Post content here",
      createdAt: "2025-01-08T12:00:00.000Z",
      langs: ["en"]
    },
    replyCount: 5,
    repostCount: 10,
    likeCount: 25,
    indexedAt: "2025-01-08T12:00:01.000Z"
  },
  reply: { /* if this is a reply */ },
  reason: { /* if repost */ }
}
\`\`\`

### 4. Post Operations

#### Create Post

\`\`\`javascript
const post = await agent.post({
  text: 'Hello Bluesky!',
  langs: ['en'],
  createdAt: new Date().toISOString()
});

// Returns: post.uri and post.cid
\`\`\`

#### Create Post with Mentions

\`\`\`javascript
const post = await agent.post({
  text: 'Hey @alice.bsky.social check this out!',
  facets: [
    {
      index: {
        byteStart: 4, // Position in UTF-8 bytes
        byteEnd: 23
      },
      features: [{
        $type: 'app.bsky.richtext.facet#mention',
        did: 'did:plc:...' // Alice's DID
      }]
    }
  ]
});
\`\`\`

#### Create Post with Link

\`\`\`javascript
const post = await agent.post({
  text: 'Check out this article: https://example.com',
  facets: [
    {
      index: {
        byteStart: 24,
        byteEnd: 43
      },
      features: [{
        $type: 'app.bsky.richtext.facet#link',
        uri: 'https://example.com'
      }]
    }
  ]
});
\`\`\`

#### Reply to Post

\`\`\`javascript
const reply = await agent.post({
  text: 'Great post!',
  reply: {
    root: {
      uri: originalPost.uri,
      cid: originalPost.cid
    },
    parent: {
      uri: originalPost.uri,
      cid: originalPost.cid
    }
  }
});
\`\`\`

### 5. Engagement Operations

#### Like Post

\`\`\`javascript
await agent.like(postUri, postCid);
\`\`\`

#### Repost

\`\`\`javascript
await agent.repost(postUri, postCid);
\`\`\`

#### Delete Post

\`\`\`javascript
await agent.deletePost(postUri);
\`\`\`

## Advanced Operations

### Rich Text Processing

Use \`@atproto/api\` RichText helper for automatic facet detection:

\`\`\`javascript
const { RichText } = require('@atproto/api');

const rt = new RichText({
  text: 'Check out @alice.bsky.social and https://example.com!'
});

// Automatically detect mentions and links
await rt.detectFacets(agent);

const post = await agent.post({
  text: rt.text,
  facets: rt.facets
});
\`\`\`

### Image Uploads

\`\`\`javascript
// Upload image blob
const { data } = await agent.uploadBlob(imageBuffer, {
  encoding: 'image/jpeg'
});

// Create post with image
const post = await agent.post({
  text: 'Check out this image!',
  embed: {
    $type: 'app.bsky.embed.images',
    images: [
      {
        image: data.blob,
        alt: 'Description of image'
      }
    ]
  }
});
\`\`\`

### External Embeds (Link Cards)

\`\`\`javascript
const post = await agent.post({
  text: 'Interesting article',
  embed: {
    $type: 'app.bsky.embed.external',
    external: {
      uri: 'https://example.com/article',
      title: 'Article Title',
      description: 'Article description',
      thumb: thumbBlob // Optional image blob
    }
  }
});
\`\`\`

### Pagination

Most list endpoints support cursor-based pagination:

\`\`\`javascript
let cursor = undefined;
const allPosts = [];

while (true) {
  const response = await agent.getTimeline({
    limit: 100,
    cursor
  });

  allPosts.push(...response.feed);

  if (!response.cursor) break; // No more pages
  cursor = response.cursor;
}
\`\`\`

## Rate Limiting

Bluesky enforces rate limits to prevent abuse:

**Global Limits**:
- 5,000 points per 5 minutes per DID
- 3,000 points per hour per DID

**Point Costs**:
- Read operations: 1 point
- Create operations: 3 points
- Update operations: 2 points
- Delete operations: 1 point

**Best Practices**:
- Implement exponential backoff on 429 errors
- Cache profile data to reduce API calls
- Batch operations when possible
- Track your usage with internal rate limit tracking

\`\`\`javascript
// Handle rate limit errors
try {
  await agent.post({ text: 'Hello!' });
} catch (error) {
  if (error.status === 429) {
    // Rate limited
    const retryAfter = error.headers?.['retry-after'] || 60;
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    // Retry request
  }
}
\`\`\`

## Error Handling

Common error codes:

- \`400\`: Invalid request (check parameters)
- \`401\`: Authentication failed (session expired or invalid)
- \`403\`: Forbidden (insufficient permissions)
- \`404\`: Resource not found
- \`429\`: Rate limit exceeded
- \`500\`: Server error (retry with exponential backoff)

\`\`\`javascript
try {
  const profile = await agent.getProfile({ actor: 'nonexistent.bsky.social' });
} catch (error) {
  console.error('Error code:', error.status);
  console.error('Error message:', error.message);

  if (error.status === 404) {
    console.log('Profile not found');
  } else if (error.status === 401) {
    console.log('Need to re-authenticate');
    await agent.login({ /* ... */ });
  }
}
\`\`\`

## Security Best Practices

1. **Never commit credentials**: Use environment variables for app passwords
2. **Use app passwords**: Never use account passwords in code
3. **Validate input**: Sanitize user input before posting
4. **Handle sessions securely**: Store session tokens encrypted
5. **Implement rate limiting**: Respect API limits to avoid bans
6. **Log security events**: Track authentication failures and suspicious activity

## Common Integration Patterns

### 1. Prospect Discovery

\`\`\`javascript
// Hybrid approach: Suggested follows + Search
const suggestions = await agent.getSuggestions({ limit: 50 });
const searchResults = await agent.searchActors({ term: 'web developer', limit: 25 });

// Combine and deduplicate by DID
const allProfiles = new Map();
suggestions.actors.forEach(actor => allProfiles.set(actor.did, actor));
searchResults.actors.forEach(actor => allProfiles.set(actor.did, actor));

// Analyze profiles (batch AI scoring recommended)
const candidates = Array.from(allProfiles.values());
\`\`\`

### 2. Feed Analysis

\`\`\`javascript
// Fetch recent timeline
const timeline = await agent.getTimeline({ limit: 100 });

// Extract unique authors
const authorMap = new Map();
timeline.feed.forEach(item => {
  const did = item.post.author.did;
  if (!authorMap.has(did)) {
    authorMap.set(did, {
      author: item.post.author,
      posts: []
    });
  }
  authorMap.get(did).posts.push(item.post);
});

// Analyze author activity
for (const [did, data] of authorMap.entries()) {
  const profile = await agent.getProfile({ actor: did });
  // AI evaluation of prospect potential
}
\`\`\`

### 3. Content Publishing

\`\`\`javascript
// Create post with rich formatting
const { RichText } = require('@atproto/api');

const rt = new RichText({
  text: 'New blog post: How to Build with AT Protocol\\n\\nCheck it out @bsky.app https://myblog.com/at-protocol'
});

await rt.detectFacets(agent);

await agent.post({
  text: rt.text,
  facets: rt.facets,
  langs: ['en']
});
\`\`\`

## Testing & Development

### Test Accounts

Create separate test accounts for development:
- Use \`*.test\` handles for testing
- Never test on production accounts
- Implement dry-run modes in tools

### Logging & Monitoring

\`\`\`javascript
// Log all API calls
const originalPost = agent.post;
agent.post = async function(...args) {
  console.log('[Bluesky API] POST:', args);
  const result = await originalPost.apply(this, args);
  console.log('[Bluesky API] Response:', result);
  return result;
};
\`\`\`

## Firestore Schema for Bluesky Data

### Followed Profiles Collection

\`\`\`javascript
// Collection: bluesky-followed-profiles
{
  // Document ID: profile DID
  did: "did:plc:...",
  handle: "alice.bsky.social",
  displayName: "Alice",
  description: "Bio text",
  followedAt: Timestamp,
  followUri: "at://did:plc:.../app.bsky.graph.follow/...",
  personaMatch: {
    personaId: "developer_persona",
    personaName: "Software Developers",
    matchScore: 85,
    matchReason: "Bio mentions React and TypeScript"
  }
}
\`\`\`

### Prospects Collection

\`\`\`javascript
// Collection: bluesky-prospects
{
  did: "did:plc:...",
  handle: "bob.bsky.social",
  displayName: "Bob",
  description: "Bio text",
  prospectScore: 90,
  prospectReason: "CTO at tech startup, discussing scaling challenges",
  personaMatch: ["enterprise_persona", "decision_maker_persona"],
  buyingSignals: ["budget discussions", "vendor evaluation"],
  recentPosts: [
    {
      text: "Post content",
      createdAt: Timestamp,
      likes: 25,
      reposts: 5
    }
  ],
  engagement: {
    likes: 100,
    reposts: 25,
    replies: 15
  },
  identifiedAt: Timestamp,
  status: "new", // new | contacted | qualified | disqualified
  notes: ""
}
\`\`\`

## Performance Optimization

### 1. Batch Operations

Instead of individual API calls, batch when possible:

\`\`\`javascript
// BAD: Sequential calls (20 calls)
for (const profile of profiles) {
  const fullProfile = await agent.getProfile({ actor: profile.did });
  // Process...
}

// GOOD: Collect all DIDs first, then batch fetch if API supports
// For Bluesky: Fetch in parallel with Promise.all (rate limit aware)
const batchSize = 10;
for (let i = 0; i < profiles.length; i += batchSize) {
  const batch = profiles.slice(i, i + batchSize);
  const results = await Promise.all(
    batch.map(p => agent.getProfile({ actor: p.did }))
  );
  // Process batch...
}
\`\`\`

### 2. Caching

Cache profile data to reduce API calls:

\`\`\`javascript
const profileCache = new Map();
const CACHE_TTL = 3600000; // 1 hour

async function getCachedProfile(did) {
  const cached = profileCache.get(did);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const profile = await agent.getProfile({ actor: did });
  profileCache.set(did, {
    data: profile,
    timestamp: Date.now()
  });

  return profile;
}
\`\`\`

## Troubleshooting

### Session Expired

**Error**: \`401 Unauthorized\`
**Solution**: Re-authenticate

\`\`\`javascript
if (error.status === 401) {
  await agent.login({
    identifier: process.env.BLUESKY_IDENTIFIER,
    password: process.env.BLUESKY_APP_PASSWORD
  });
  // Retry operation
}
\`\`\`

### Rate Limited

**Error**: \`429 Too Many Requests\`
**Solution**: Implement exponential backoff

\`\`\`javascript
async function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (error.status === 429 && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000; // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}
\`\`\`

### Profile Not Found

**Error**: \`404 Not Found\`
**Cause**: Handle changed or account deleted
**Solution**: Store and use DIDs, not handles

## Resources

- **Official Documentation**: https://docs.bsky.app/
- **AT Protocol Docs**: https://atproto.com/
- **API Reference**: https://docs.bsky.app/docs/api/
- **TypeScript SDK**: https://github.com/bluesky-social/atproto/tree/main/packages/api
- **Community Discord**: https://discord.gg/bluesky

## Code Examples Repository

See working implementation in:
- \`services/bskyService.js\` - Service layer with authentication and API wrappers
- \`tools/bskyPersonaFollow.js\` - Profile discovery and following
- \`tools/bskyFeedAnalyzer.js\` - Feed analysis and prospect identification
- \`tools/bskyYouTubePost.js\` - Content publishing with embeds
`;

// Knowledge base entry metadata
const knowledgeBaseEntries = [
  {
    id: 'bluesky_api_integration_guide',
    title: 'Bluesky API Integration Guide',
    content: blueskyApiGuide,
    category: 'system_information',
    tags: ['bluesky', 'api', 'at-protocol', 'social-media', 'integration', 'authentication', 'rate-limiting'],
    searchTerms: [
      'bluesky api', 'at protocol', 'bsky agent', 'bluesky authentication',
      'bluesky profiles', 'bluesky feed', 'bluesky posts', 'bluesky follow',
      'did identifier', 'app password', 'rate limiting', 'bluesky error handling',
      'rich text', 'facets', 'mentions', 'pagination'
    ],
    priority: 95,
    enabled: true
  }
];

module.exports = {
  blueskyApiGuide,
  knowledgeBaseEntries,
  title: 'Bluesky API Integration Guide',
  category: 'system_information',
  priority: 95,
  lastUpdated: new Date().toISOString()
};
