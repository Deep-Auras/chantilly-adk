# Chantilly Agent

Chantilly is an open-source agent development kit that enables any LLM to use tools, retain knowledge, and execute complex tasks. Built on Node.js and Google Cloud, it provides production-ready architecture with vector search, self-repairing tasks using ReasoningBank, and integrations for multiple platforms. Built for Google Cloud Run with Node.js 22+ and enterprise-grade security featuring intelligent knowledge management, real-time web search, and executable task templates with isolated-vm sandboxing. Bitrix24 is the first supported platform integration.

Read the [Chantilly ADK Whitepaper](chantilly-adk-whitepaper.md) for architectural details and design philosophy.

## Features

- 🧠 **AI Personality Management**: 8 trait categories with API-configurable personalities
- 🔧 **Custom Tools**: AI-selected dynamic tools for real-world processes
- 📋 **Task Template System**: Executable JavaScript templates with auto-repair and ReasoningMemory learning
- 📚 **Knowledge Base Management**: Vector search with persistent information storage and retrieval
- 🔒 **Enterprise Security**: OWASP LLM Top 10:2025 compliant with JWT auth and comprehensive protection
- 🚀 **Platform Agnostic**: Designed for multiple integrations (Bitrix24 added October 2025)

## Quick Start

### Prerequisites

- Node.js 22+
- Google Cloud Project with Firestore enabled (database ID: `chantilly-agent${agentName}`)
- Bitrix24 account with webhook permissions
- Google Gemini API key

### Local Development

1. **Clone and install dependencies**

   ```bash
   git clone <your-repo>
   cd chantilly-adk
   npm install
   ```

   *Dependencies include cheerio for web search HTML parsing, axios for HTTP requests, isolated-vm for secure task execution, and other core libraries.*

2. **Configure environment**

   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Set up Google Cloud credentials (LOCAL DEVELOPMENT ONLY)**

   ```bash
   # Download service account key from Google Cloud Console
   # ⚠️  IMPORTANT: This is ONLY for local development and running scripts
   # NEVER deploy this JSON file to Cloud Run or commit it to git
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
   ```

   **Note**: Cloud Run uses Application Default Credentials (ADC) automatically via the default compute service account. You do NOT need to set `GOOGLE_APPLICATION_CREDENTIALS` in Cloud Run environment variables.

4. **Start development server**

   ```bash
   npm run dev
   ```

5. **Expose webhook endpoint** (for Bitrix24 testing)

   ```bash
   # Install ngrok: https://ngrok.com/
   ngrok http 8080
   ```

### Cloud Run Deployment (2025 - Zero-Config)

**Prerequisites - Enable Required APIs:**

Before deploying, enable these Google Cloud APIs (go to each link and click "ENABLE"):

1. **[Cloud Firestore API](https://console.cloud.google.com/apis/library/firestore.googleapis.com)** - Database storage
2. **[Cloud Run API](https://console.cloud.google.com/apis/library/run.googleapis.com)** - Serverless hosting
3. **[Artifact Registry API](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com)** - Docker images
4. **[Cloud Build API](https://console.cloud.google.com/apis/library/cloudbuild.googleapis.com)** - CI/CD builds
5. **[Cloud Logging API](https://console.cloud.google.com/apis/library/logging.googleapis.com)** - Application logs
6. **[Vertex AI API](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com)** - Text embeddings

After enabling APIs, **create Firestore database**:
- Go to [Firestore](https://console.cloud.google.com/firestore)
- Click **"Create database"**
- Choose **"Native mode"** (NOT Datastore mode)
- Select location: **us-central1** (match your Cloud Run region)
- Click **"Create"**

**New Deployment from Repository**:

1. **Push your code to GitHub** (or GitLab/Bitbucket)

2. **Create Cloud Run Service via Console**:
   - Go to [Google Cloud Console > Cloud Run](https://console.cloud.google.com/run)
   - Click "Create Service"
   - Select "Continuously deploy from a repository (source or function)"
   - Connect your GitHub repository
   - Select branch (main/master)
   - Set region: `us-central1`
   - Set minimum instances: `1` (recommended for production)
   - Set maximum instances: `100`
   - Click "Create"

3. **Access Setup Wizard**:
   - Wait for deployment to complete (~2-3 minutes)
   - Open the Cloud Run service URL in your browser
   - You'll be automatically redirected to `/setup`
   - Complete the 6-step setup wizard:
     - **Step 1**: Welcome
     - **Step 2**: Create admin user (username, email, password)
     - **Step 3**: Configure agent identity (agent name)
     - **Step 4**: API configuration (Gemini API key, model selection)
     - **Step 5**: Review & confirm
     - **Step 6**: Success! Credentials displayed

4. **Deploy Firestore Indexes** (one-time, from local machine):
   ```bash
   npm run deploy:indexes
   ```

**Key Benefits**:
- ✅ **Zero environment variables** - ADC provides `GOOGLE_CLOUD_PROJECT` automatically
- ✅ **No manual configuration** - Everything configured via web UI
- ✅ **Continuous deployment** - Push to GitHub auto-deploys in ~2-3 minutes
- ✅ **Secure setup** - All config stored in Firestore, wizard auto-disabled after completion

**Platform Integration** (optional, after initial setup):
- Configure Bitrix24/Google Chat/Asana via dashboard after setup
- See dashboard at `/dashboard` (requires admin login)

## Configuration

### Firestore Collections

#### Core Collections
- `agent/personality` - AI personality configuration
- `agent/triggers` - Response trigger configuration
- `users/` - JWT user accounts
- `conversations/` - Chat context history

#### Task System
- `task-templates/` - Executable task templates with dual embeddings
- `task-queue/` - Pending/running task executions
- `reasoning-memory/` - ReasoningBank-inspired learning memories
- `worker-processes/` - Worker process state management

#### Knowledge & Tools
- `knowledge-base/` - Knowledge documents with vector search
- `tool-embeddings/` - Tool semantic triggers (deprecated)

#### Bot State
- `bot/auth` - Bitrix24 bot authentication
- `queue/` - API call queue state (transient, rate limiting only)

### Bitrix24 Setup

1. **Create Inbound Webhook**

   - Go to Bitrix24 > Applications > Webhooks
   - Create new inbound webhook with required permissions
   - Copy the webhook URL to `BITRIX24_INBOUND_WEBHOOK`

2. **Create Outbound Webhook**

   - Set trigger events: `ONIMBOTMESSAGEADD`, `ONIMBOTMESSAGEUPDATE`, `ONIMBOTMESSAGEDELETE`
   - Set handler URL to your Cloud Run service: `https://your-service.run.app/webhook/bitrix24`
   - Set secret key in `BITRIX24_OUTBOUND_SECRET`

### Translation Setup

Configure target dialog IDs for translation:

```env
TRANSLATION_TARGET_DIALOG_IDS={"es":"chat123","fr":"chat456","de":"chat789"}
```

Translation is tool-based with AI-driven activation. Users request translation by mentioning Chantilly with context like "translate to channels" or "translate & syndicate".

## Architecture

### Core Components

- **Personality Engine**: Manages 8 trait categories with real-time updates
- **Task Template System**: Executable JavaScript with isolated-vm sandboxing, auto-repair, and ReasoningMemory
- **AI Tool Selection**: Gemini-based function calling (all enabled tools offered to AI)
- **Security Layer**: OWASP LLM Top 10:2025 compliant protection with JWT authentication
- **Translation Service**: Personality-preserved cross-language communication
- **Queue Manager**: Rate-limited API calls for Bitrix24 (2 req/sec, 10,000 req/10min)

### System Flow

```
Platform Integrations → Authentication → Personality Engine → Gemini AI → Tool Selection → Response
         ↓                     ↓              ↓                    ↓             ↓
    Rate Limited Queue → Security Middleware → Task Templates → ReasoningMemory → Audit Logging
                                ↓                        ↓
                    Firestore (Personality, Templates, Memory, Users, Context)
```

### Directory Structure

```
/
├── server.js              # Main Express server with OWASP security
├── routes/                # API routes
│   ├── agent.js          # Personality, triggers, memory dashboard
│   ├── auth.js           # JWT authentication
│   ├── knowledge.js      # Knowledge base CRUD
│   └── worker.js         # Worker process management
├── services/             # Core services
│   ├── gemini.js         # Gemini API integration
│   ├── agentPersonality.js
│   ├── queue.js          # Rate limiting queue
│   ├── embeddingService.js
│   ├── memoryExtractor.js # ReasoningMemory extraction
│   └── taskTemplateLoader.js
├── models/               # Firestore models
│   ├── taskTemplates.js  # Template CRUD with dual embeddings
│   ├── reasoningMemory.js
│   └── taskQueue.js
├── tools/                # Dynamic tool system
│   ├── complexTaskManager.js
│   ├── taskTemplateManager.js
│   ├── knowledgeManagement.js
│   ├── bitrixTranslationChannels.js
│   └── [12 other tools]
├── utils/                # Security & validation
│   ├── contextSanitizer.js
│   ├── contextValidator.js
│   └── parameterExtractor.js
├── middleware/           # Security middleware
├── scripts/              # Maintenance scripts
├── tests/                # Security & critical bug tests
└── .claude/              # Claude Code integration (hooks, commands)
```

## AI Personality System

Chantilly Agent features a sophisticated personality management system with 8 trait categories:

- **Communication**: formality, verbosity, technicality, response_length
- **Emotional**: empathy_level, enthusiasm, humor, warmth
- **Behavioral**: proactivity, patience, assertiveness, creativity
- **Cognitive**: thinking_style, problem_solving, learning_adaptation, detail_orientation
- **Interaction**: engagement, questioning, feedback_style, boundary_setting
- **Cultural**: language_register, cultural_sensitivity, emoji_usage, metaphor_usage
- **Expertise**: confidence, teaching_style, knowledge_sharing, specialization
- **Task**: focus, urgency, follow_up, organization

## Task Template System

### Overview

Chantilly includes an advanced task template system that allows execution of complex, multi-step tasks using sandboxed JavaScript code. Templates learn from success and failure through ReasoningMemory.

### Template Structure

```javascript
{
  templateId: "report_generator",
  name: "Generate Invoice Report",
  description: "Generates detailed invoice reports...",
  category: ["reporting", "finance"],

  // Dual embeddings for intelligent search
  nameEmbedding: FieldValue.vector([...]),  // Exact matching
  embedding: FieldValue.vector([...]),       // Semantic search

  // JSON Schema parameter validation
  parameters: {
    type: "object",
    properties: {
      dateRange: { type: "string", description: "Q1 2024, Last 30 days" },
      format: { type: "string", enum: ["HTML", "JSON"] }
    },
    required: ["dateRange"]
  },

  // Sandboxed JavaScript execution
  executionScript: `
    async function execute(params, context) {
      // Access allowed globals: bitrix, gemini, logger
      const invoices = await bitrix.call('crm.invoice.list', {
        filter: { /* ... */ }
      });

      return {
        success: true,
        result: { /* ... */ }
      };
    }
  `,

  enabled: true,
  testing: false,
  scriptValidated: true,
  createdAt: timestamp,
  updatedAt: timestamp
}
```

### Key Features

- **Dual Embeddings**: Name-based exact matching + semantic content search
- **Isolated Execution**: Runs in isolated-vm sandbox (no process.*, require(), etc.)
- **Auto-Repair**: Self-healing on errors using Gemini (max 3 repair cycles)
- **Parameter Validation**: JSON schema-based with automatic extraction
- **Security**: Banned pattern detection, timeout protection (12 minutes max)
- **ReasoningMemory**: Learns from execution successes and failures

### Template Search

1. **Phase 1**: Search `nameEmbedding` for exact name matches
2. **Phase 2**: Search full `embedding` for semantic queries
3. **Phase 3**: Choose best match (prioritize name if >85% similarity)

## ReasoningMemory System

### Overview

Inspired by ReasoningBank, Chantilly extracts and stores lessons learned from task template execution, creating a growing knowledge base of effective strategies and common pitfalls.

### Memory Extraction Sources

- **Task Success**: Effective strategies, optimal configurations
- **Task Failure**: Root causes, preventative strategies
- **Auto-Repair**: Error patterns, successful fix strategies
- **User Modifications**: Human expertise, generation patterns

### Memory Categories

- `error_pattern` - Common failure modes and causes
- `fix_strategy` - Successful repair approaches
- `api_usage` - Effective API usage patterns
- `general_strategy` - Task execution strategies
- `generation_pattern` - Template creation best practices

### Memory Validation

- Content length limits (5000 characters)
- Banned pattern detection
- Source validation
- Category validation
- Quota enforcement (100 memories per template)
- Schema compliance

## Dynamic Tool System

### Tool Selection Mechanism

**AI-Driven Selection**: All enabled tools are offered to Gemini AI as function declarations. Gemini decides which tools to use based on conversation context, eliminating the need for keyword triggers or regex patterns.

### Creating Custom Tools

Extend the `BaseTool` class:

```javascript
const BaseTool = require('../lib/baseTool');

class MyTool extends BaseTool {
  constructor(context) {
    super(context);

    this.name = 'MyTool';
    this.description = 'Description for AI to understand when to use this tool';
    this.category = 'automation';
    this.priority = 50;

    this.parameters = {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Input parameter description for AI'
        }
      },
      required: ['input']
    };
  }

  async execute(params, toolContext) {
    try {
      // Tool implementation
      const result = await this.performToolAction(params);

      return {
        success: true,
        result: result
      };
    } catch (error) {
      this.log('error', 'Tool execution failed', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }

  async performToolAction(params) {
    // Main tool logic here
    return `Processed: ${params.input}`;
  }
}

module.exports = MyTool;
```

### Built-in Tools

1. **Knowledge Management** - Store, search, and retrieve organizational information
2. **Complex Task Manager** - Execute task templates with auto-repair
3. **Task Template Manager** - Create and manage task templates
4. **Web Search** - DuckDuckGo-powered real-time information retrieval
5. **Translation & Syndication** - Multi-language broadcasting with attribution
6. **Diagram Generator** - AI-powered .drawio diagram creation
7. **Task & Reminder** - Bitrix24 task creation with priority levels
8. **Weather Information** - Global weather data and forecasts
9. **Chat Summary** - Intelligent conversation summarization
10. **Google Maps Places** - Location search and information

### Tool Context Sharing

Tools can share context with each other:

- Knowledge Management results inform Web Search queries and Diagram Generator examples
- Chat Summary outputs automatically trigger Diagram Generator for visualization
- Translation tool preserves original user attribution
- All tools maintain conversation context for personalized responses

## Built-in Tools Documentation

### 📚 Knowledge Management Tool

**Purpose**: Comprehensive information management system for storing and retrieving organizational knowledge.

**Core Features**:

- ✅ **Smart Document Creation**: Auto-suggests titles, tags, categories from context
- ✅ **Full CRUD Operations**: Add, update, delete, search, and list documents
- ✅ **Vector Search**: Semantic search with relevance scoring
- ✅ **Category Organization**: HR, IT, policies, processes, general categories
- ✅ **Priority System**: 0-100 priority levels for document importance
- ✅ **Confirmation Workflows**: Safety confirmations for destructive operations

**Usage Pattern**:

AI determines when to use knowledge management based on conversation context (e.g., "save this information", "what do you know about X", "search your knowledge").

### 🌐 Web Search Tool

**Purpose**: Real-time web search using DuckDuckGo for current information not available in knowledge base.

**Core Features**:

- ✅ **Intelligent Triggering**: AI detects when web search is needed
- ✅ **DuckDuckGo Integration**: Privacy-focused web search
- ✅ **Content Analysis**: Fetches and analyzes top search results
- ✅ **Smart Summarization**: Query-focused summaries with source attribution
- ✅ **Fallback Protection**: Provides results even when websites block access
- ✅ **SSRF Protection**: Blocks private IPs and metadata endpoints

**Automatic Activation**:

AI activates web search for:
- Requests for "latest", "current", "recent" information
- Date-specific queries (2024, 2025)
- When knowledge base has insufficient information
- Explicit requests for online information

### 🔄 Translation & Syndication Tool

**Purpose**: Translates messages and broadcasts to multiple language-specific Bitrix24 channels.

**Core Features**:

- ✅ **Multi-Language Support**: English, Spanish, French, German, Chinese, Portuguese, Russian, Arabic, Polish
- ✅ **Parallel Processing**: All translations happen simultaneously
- ✅ **User Attribution**: Shows original username in translated messages
- ✅ **Dynamic Configuration**: Add/remove target channels via conversation
- ✅ **Firestore Integration**: Persistent settings with real-time updates
- ✅ **Cache System**: Avoids re-translating identical content

**Usage Pattern**:

AI activates for translation and syndication requests in conversation context.

### 📊 Diagram Generator Tool

**Purpose**: Creates professional interactive diagrams from text using AI-powered generation.

**Core Features**:

- ✅ **Agentic AI Generation**: Uses Gemini to create human-like, professional diagrams
- ✅ **Multiple Diagram Types**: Flowcharts, mind maps, process diagrams, decision trees, network diagrams
- ✅ **Auto-Type Detection**: AI determines optimal diagram type from content
- ✅ **Tool Chaining**: Works with Knowledge Base, Chat Summary, Web Search results
- ✅ **Professional Styling**: Gradients, colors, shadows, modern fonts, visual hierarchy
- ✅ **Cloud Storage**: Uploads .drawio files to Google Cloud Storage with download links

**Technical Specifications**:

- **AI Engine**: Google Gemini 2.5 Pro with specialized prompting
- **File Format**: Standard draw.io XML format (.drawio files)
- **Storage**: Google Cloud Storage with public download links
- **Validation**: XML structure validation with repair capabilities
- **Timeout**: 5-minute generation window for complex diagrams

**Why .drawio**:

- Editable by users (not static images)
- Professional export options (PNG, PDF, SVG)
- Standard format, no vendor lock-in
- Vector-based scalability
- Free tools (draw.io, diagrams.net)

### 📝 Task & Reminder Tool

**Purpose**: Creates tasks and reminders in Bitrix24 with due dates and priorities.

**Core Features**:

- ✅ **Bitrix24 Integration**: Creates actual tasks in workspace
- ✅ **Priority Levels**: Low, medium, high priority assignment
- ✅ **Due Date Support**: Flexible date parsing
- ✅ **User Assignment**: Automatically assigns to message sender
- ✅ **Firestore Tracking**: Maintains reminder history

### 🌤️ Weather Information Tool

**Purpose**: Provides current weather conditions and forecasts globally.

**Core Features**:

- ✅ **Global Coverage**: Weather data for cities worldwide
- ✅ **Flexible Date Support**: Current weather or future forecasts
- ✅ **Unit Options**: Metric (Celsius) or Imperial (Fahrenheit)
- ✅ **Smart Parsing**: Extracts location from conversational text

## API Endpoints

### Public Endpoints

- `GET /` - Service status
- `GET /health` - Health check with service diagnostics

### Agent Management (Protected)

**Note**: All modification endpoints require JWT authentication with appropriate role.

#### Personality Management

- `GET /agent/personality` - Get complete personality configuration (public)
- `GET /agent/personality/traits` - Get all personality traits (public)
- `GET /agent/personality/trait/:path` - Get specific trait (public)
- `PUT /agent/personality` - Update entire personality (admin, JWT)
- `PATCH /agent/personality/trait` - Update specific trait (admin, JWT)
- `POST /agent/personality/reset` - Reset to default personality (admin, JWT)
- `GET /agent/personality/profiles` - List available personality profiles (public)
- `POST /agent/personality/profile/:profileName` - Apply personality profile (admin, JWT)

#### User Preferences

- `GET /agent/personality/user/:userId` - Get user-specific adaptations (JWT)
- `PUT /agent/personality/user/:userId` - Save user preferences (admin, JWT)

#### Response Triggers

- `GET /agent/triggers` - Get current trigger configuration (public)
- `POST /agent/triggers` - Configure response triggers (admin, JWT)

#### Memory System

- `GET /agent/memory/dashboard` - ReasoningMemory analytics (JWT)

### Authentication

- `POST /auth/login` - User login
- `POST /auth/change-password` - Password change (JWT)

### Knowledge Base (Protected)

- `GET /knowledge` - List documents (JWT)
- `POST /knowledge` - Create document (admin, JWT)
- `PUT /knowledge/:id` - Update document (admin, JWT)
- `DELETE /knowledge/:id` - Delete document (admin, JWT)
- `POST /knowledge/search` - Search documents (JWT)

### Integrations

- `POST /webhook/bitrix24` - Bitrix24 webhook handler

### Authentication Examples

#### Login

```bash
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "Password1234"
  }'
```

Response:

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "username": "admin",
    "email": "admin@company.com",
    "role": "admin"
  }
}
```

#### Using Authentication Token

```bash
curl -X PATCH http://localhost:8080/agent/personality/trait \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "path": "communication.formality",
    "value": "casual"
  }'
```

### Personality Management Examples

#### Update Single Trait

```bash
curl -X PATCH http://localhost:8080/agent/personality/trait \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "path": "communication.formality",
    "value": "casual"
  }'
```

#### Apply Personality Profile

```bash
curl -X POST http://localhost:8080/agent/personality/profile/creative_collaborator \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Available profiles:

- `business_professional` - Professional and task-focused
- `creative_collaborator` - Creative and engaging
- `technical_expert` - Technical and analytical
- `supportive_coach` - Empathetic and patient

## Development

### Available Scripts

```bash
# Development
npm run dev               # Development server with hot reload
npm test                  # Run all tests
npm run test:security     # Security-focused tests
npm run test:coverage     # Test coverage report

# Code Quality
npm run lint              # ESLint check
npm run lint:fix          # Auto-fix linting issues
npm run validate          # Full validation pipeline

# Security
npm run security:audit    # Check for vulnerabilities
npm run security:check    # Moderate+ security check

# Deployment
npm run deploy:indexes    # Deploy Firestore indexes
```

### Hot Reload

Tools and services are automatically reloaded when files change in development mode. No server restart required.

### Running Scripts Locally

Scripts in `/scripts` directory require Firebase Admin credentials for **local execution only**:

```bash
# Pattern for all scripts (LOCAL DEVELOPMENT ONLY)
NODE_ENV=test \
GOOGLE_CLOUD_PROJECT=your-project-id \
GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/service_account.json" \
node scripts/<script-name>.js
```

**Common Scripts**:

- `initFirestoreCollections.js` - Initialize all Firestore collections and create admin user
- `deletePlaceholderDocs.js` - Remove placeholder documents after setup
- `backfillTaskTemplates.js` - Add dual embeddings to templates
- `backfillKnowledgeBase.js` - Add embeddings to knowledge docs
- `initializeMemorySystem.js` - Set up ReasoningMemory
- `createAdmin.js` - Create additional admin users
- `generateToolEmbeddings.js` - Tool embeddings (deprecated)

**Requirements for Local Scripts**:

- `service_account.json` in project root with Firestore Admin permissions
- Database ID: `chantilly-agent-${AGENT_NAME}` (auto-configured in scripts)
- **⚠️  CRITICAL**: Never deploy service account JSON keys to Cloud Run
- **⚠️  CRITICAL**: Never commit service account JSON to git (added to .gitignore)

**Cloud Run Deployment**:

Cloud Run services use **Application Default Credentials (ADC)** via the default compute service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`). No service account JSON file is needed or should be used in production.

## Security (OWASP LLM Top 10:2025 Compliant)

### Authentication & Authorization

- ✅ JWT authentication with bcrypt password hashing
- ✅ Role-based access control (admin/user)
- ✅ Account lockout after 5 failed attempts
- ✅ Object/Property/Function level authorization

### Input Protection

- ✅ PII sanitization before AI processing (LLM02)
- ✅ XSS prevention with input sanitization
- ✅ SQL/NoSQL injection protection
- ✅ SSRF protection blocking private IPs (LLM07)
- ✅ Path traversal prevention
- ✅ Prompt injection detection (LLM01)

### Infrastructure Security

- ✅ Multi-tier rate limiting (general/auth/sensitive) (LLM04)
- ✅ Comprehensive security headers (CSP, HSTS, etc.)
- ✅ Non-root container execution
- ✅ Business flow monitoring
- ✅ Audit logging for all operations
- ✅ Resource limits (LLM10)

### Template & Tool Security

- ✅ Isolated-vm sandbox execution (LLM06)
- ✅ Banned pattern detection (LLM03)
- ✅ Parameter validation (LLM06)
- ✅ Vector embedding validation (LLM08)
- ✅ Tool result validation (LLM09)
- ✅ Execution timeout protection (LLM04)

### Security Testing

- ✅ Comprehensive security test suite
- ✅ Vulnerability scanning with npm audit
- ✅ Critical bug prevention tests
- ✅ OWASP LLM Top 10 attack simulations
- ✅ Zero known vulnerabilities

## Monitoring

### Health Checks

The `/health` endpoint provides comprehensive service status:

```json
{
  "status": "healthy",
  "checks": {
    "firestore": {"status": "healthy"},
    "gemini": {"status": "healthy"},
    "bitrix24": {"status": "healthy"},
    "queue": {"pending": 0, "processing": 0}
  }
}
```

### Logging

Structured logging with Cloud Logging integration:

```javascript
logger.info('Message processed', {
  userId: 123,
  messageId: 456,
  duration: 150
});
```

### Metrics

- Queue metrics (pending, processing, cooldown status)
- Tool execution metrics (duration, success rate)
- Memory metrics (cache hits, Firestore reads)
- Template execution metrics (success, repair cycles)

## Troubleshooting

### Common Issues

1. **Webhook not receiving events**

   - Verify webhook URL in Bitrix24 settings
   - Check Cloud Run logs for incoming requests
   - Ensure service is publicly accessible

2. **Queue backing up**

   - Check if in cooldown period via `/health`
   - Review Firestore `queue/failed` collection
   - Monitor rate limit configuration (2 req/sec, 10,000 req/10min)
   - Note: Queue is for rate limiting only, not persistent messaging

3. **Translation not working**

   - Check `TRANSLATION_TARGET_DIALOG_IDS` is properly configured
   - Verify `TRANSLATION_ENABLED=true`
   - Ensure Chantilly is mentioned in group chats
   - Review Gemini API quotas and errors

4. **Template execution failing**

   - Check template has both embeddings (nameEmbedding + embedding)
   - Verify `ENABLE_SEMANTIC_TEMPLATES=true`
   - Run backfill script if templates created manually
   - Review banned pattern detection logs
   - Check isolated-vm timeout settings (12 minutes max)

5. **ReasoningMemory not working**

   - Verify `REASONING_MEMORY_ENABLED=true`
   - Check Firestore indexes deployed
   - Validate embedding dimensions (768)
   - Review memory dashboard: `GET /agent/memory/dashboard`

### Debugging

Enable debug logging:

```env
LOG_LEVEL=debug
```

Check Cloud Run service logs:

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=chantilly-adk" \
  --limit 50 \
  --format json
```

Check Firestore for queue status:

```bash
# Via Firebase Console or scripts
node scripts/checkQueueStatus.js
```

## Performance Tips

- Keep min instances at 1 (no cold starts)
- Use in-memory caching for hot data (personality, templates)
- Batch Firestore operations where possible
- Monitor memory usage via `/health` endpoint
- Set appropriate execution timeouts (12 min for templates, 30 sec for tools)
- Leverage dual embeddings for faster template search

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests (use `/create-unit-tests` and `/create-integration-tests` commands)
5. Run validation: `npm run validate`
6. Submit a pull request

## License

MIT License - see LICENSE file for details
