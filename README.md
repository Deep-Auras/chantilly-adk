# Chantilly Agent

An open-source agent development kit enabling LLMs to use tools, retain knowledge, and execute complex tasks. Built on Node.js and Google Cloud with production-ready architecture, vector search, and multi-platform integrations.

Read the [Chantilly ADK Whitepaper](chantilly-adk-whitepaper.md) for architectural details.

## Features

- **AI Personality Management**: 8 trait categories with API-configurable personalities
- **Custom Tools**: AI-selected dynamic tools for real-world processes
- **Task Templates**: Executable JavaScript with auto-repair and ReasoningMemory learning
- **Knowledge Base**: Vector search with persistent storage and retrieval
- **Enterprise Security**: OWASP LLM Top 10:2025 compliant
- **Multi-Platform**: Bitrix24, Google Chat, Asana integrations

---

## Quick Start (~5 min)

### Prerequisites

1. Github Account
2. Google Cloud Account & Project
3. Gemini

### Cloud Run Deployment

#### 1. Fork this Repository
1. Click the Fork Button
2. Take note of the Owner / Organization
3. Name the fork appropriately

#### 2. Enable Required APIs

Go to [Google Cloud Console](https://console.cloud.google.com) and enable:

| API | Purpose |
|-----|---------|
| [Cloud Firestore](https://console.cloud.google.com/apis/library/firestore.googleapis.com) | Database |
| [Cloud Run](https://console.cloud.google.com/apis/library/run.googleapis.com) | Hosting |
| [Artifact Registry](https://console.cloud.google.com/apis/library/artifactregistry.googleapis.com) | Docker images |
| [Cloud Build](https://console.cloud.google.com/apis/library/cloudbuild.googleapis.com) | CI/CD |
| [Cloud Logging](https://console.cloud.google.com/apis/library/logging.googleapis.com) | Application logs |
| [Vertex AI](https://console.cloud.google.com/apis/library/aiplatform.googleapis.com) | Embeddings |

#### 3. Create Firestore Database

1. Go to [Firestore Console](https://console.cloud.google.com/firestore)
2. Click **"Create database"**
3. Select **Native mode** (NOT Datastore)
4. Location: **us-central1**
5. Click **Create**

#### 4. Grant Service Account Roles

Two service accounts need additional permissions:

**A. Cloud Build Service Account** (for CI/CD and index deployment):
1. Go to [IAM & Admin](https://console.cloud.google.com/iam-admin/iam)
2. Find `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`
3. Add these roles:
   - **Cloud Datastore Owner** - Firestore index deployment
   - **Firebase Admin** - Firebase CLI access

**B. Compute Engine Service Account** (for Cloud Run runtime):
1. Find `PROJECT_NUMBER-compute@developer.gserviceaccount.com`
2. Add these roles:
   - **Cloud Datastore Owner** - Firestore access
   - **Vertex AI User** - Embeddings
   - **Cloud Build Editor** - Trigger deployments (if using Build Mode)
   - **Storage Object Admin** - File uploads (if using diagram tool)
3. Click **Save**

#### 5. Deploy to Cloud Run

1. Go to [Cloud Run Console](https://console.cloud.google.com/run)
2. Click **"Create Service"**
3. Select **"Continuously deploy from a repository"**
4. Connect your forked GitHub repository
5. Configure:
   - Region: `us-central1`
   - Min instances: `1`
   - Max instances: `100`
   - Allow unauthenticated invocations: **Yes**
6. Click **Create**

#### 6. Complete Setup Wizard

1. Wait for deployment (~2-3 min)
2. Open the Cloud Run service URL
3. Complete the 6-step setup:
   - Create admin account
   - Configure agent name
   - Add Gemini API key
   - Review & confirm

---

### Local Development (Optional)

```bash
# Clone and install
git clone <your-repo>
cd chantilly-agent
npm install

# Configure environment
cp .env.example .env
# Edit .env with credentials

# Set up credentials (LOCAL ONLY - never deploy this file)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"

# Start server
npm run dev

# Expose webhook (for platform testing)
ngrok http 8080
```

---

## Architecture (~10 min)

### System Flow

```
User Message → Platform Webhook → Auth → Personality Engine → Gemini AI → Tools → Response
                                           ↓                      ↓
                                    Firestore (Config, Memory, Templates, Knowledge)
```

### Services

| Service | Purpose |
|---------|---------|
| `gemini.js` | Gemini API integration, tool orchestration |
| `agentPersonality.js` | 8-category personality management |
| `embeddingService.js` | Vertex AI text embeddings |
| `taskTemplateLoader.js` | Template execution with auto-repair |
| `memoryExtractor.js` | ReasoningMemory learning |
| `queue.js` | Rate-limited API calls |

### Tools

All tools are AI-selected via Gemini function calling:

| Tool | Priority | Purpose |
|------|----------|---------|
| Knowledge Management | 100 | Store/search organizational info |
| Complex Task Manager | 95 | Execute task templates |
| Task Template Manager | 90 | Create/manage templates |
| Web Search | 50 | DuckDuckGo real-time search |
| Diagram Generator | 50 | AI-powered .drawio diagrams |
| Translation | 70 | Multi-language syndication |
| Weather | 30 | Global weather data |
| Reminder | 30 | Task creation |

### Data Layer (Firestore)

| Collection | Purpose |
|------------|---------|
| `agent/personality` | AI personality config |
| `agent/config` | System configuration |
| `users/` | Authentication accounts |
| `conversations/` | Chat history |
| `knowledge-base/` | Documents with vector embeddings |
| `task-templates/` | Executable templates |
| `reasoning-memory/` | Learned strategies |
| `cloud-builds/` | Build tracking |

---

## API Reference

### Public
- `GET /` - Service status
- `GET /health` - Health check

### Authentication
- `POST /auth/login` - User login
- `POST /auth/change-password` - Change password (JWT)

### Agent (JWT required)
- `GET /agent/personality` - Get personality
- `PATCH /agent/personality/trait` - Update trait (admin)
- `POST /agent/personality/reset` - Reset to defaults (admin)

### Knowledge (JWT required)
- `GET /knowledge` - List documents
- `POST /knowledge` - Create document (admin)
- `POST /knowledge/search` - Search documents

### Build Mode (JWT required)
- `GET /api/build/status` - Build mode status
- `POST /api/build/enable` - Enable build mode
- `GET /api/build/branches` - List branches
- `POST /api/build/cloud-builds/trigger` - Trigger deployment

### Webhooks
- `POST /webhook/bitrix24` - Bitrix24 handler
- `POST /webhook/google-chat` - Google Chat handler

---

## Development

```bash
npm run dev           # Development server
npm test              # Run tests
npm run lint          # ESLint check
npm run validate      # Full validation
```

> **Note**: Firestore indexes are deployed automatically during Cloud Build. See step 7 above.

---

## Security

OWASP LLM Top 10:2025 compliant:

- JWT authentication with bcrypt
- Role-based access control
- PII sanitization before AI processing
- SSRF protection (blocks private IPs)
- Isolated-vm sandbox for template execution
- Rate limiting (multi-tier)
- Prompt injection detection

See [SECURITY.md](docs/SECURITY.md) for details.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Webhook not receiving | Check Cloud Run logs, verify URL in platform settings |
| Template execution failing | Verify embeddings exist, check `ENABLE_SEMANTIC_TEMPLATES=true` |
| Rate limited | Check `/health` endpoint, review queue status |
| Build mode errors | See [Cloud Build docs](docs/integrations/cloud-build.md) |

Enable debug logging: `LOG_LEVEL=debug`

---

## License

MIT License - see LICENSE file
