const joi = require('joi');

// More lenient validation for test environment
const isTest = process.env.NODE_ENV === 'test';

const envSchema = joi.object({
  // Platform Integration Flags
  ENABLE_BITRIX24_INTEGRATION: joi.boolean().default(false),
  ENABLE_GOOGLE_CHAT_INTEGRATION: joi.boolean().default(false),
  ENABLE_ASANA_INTEGRATION: joi.boolean().default(false),

  // RBAC Configuration (Role-Based Access Control)
  // Determines which platform's role system to use for user permissions
  // Options: 'bitrix24' (default), 'google-workspace', 'hybrid'
  // - bitrix24: Uses bitrix_users collection (original behavior)
  // - google-workspace: Uses Google Workspace admin/space manager roles
  // - hybrid: Checks platform-specific role (Bitrix24 for Bitrix, Google for Google Chat)
  RBAC_SYSTEM: joi.string().valid('bitrix24', 'google-workspace', 'hybrid').default('bitrix24'),

  // Bitrix24 Configuration (optional - only required if ENABLE_BITRIX24_INTEGRATION=true)
  BITRIX24_DOMAIN: joi.string().optional(),
  BITRIX24_INBOUND_WEBHOOK: joi.string().uri().optional(),
  BITRIX24_OUTBOUND_SECRET: joi.string().optional(),
  BITRIX24_APP_ID: joi.string().optional(),
  BITRIX24_APP_SECRET: joi.string().optional(),
  BITRIX24_USER_ID: joi.string().default('1'),

  // Google Workspace Chat Configuration (optional - only required if ENABLE_GOOGLE_CHAT_INTEGRATION=true)
  GOOGLE_CHAT_PROJECT_ID: joi.string().optional(),
  GOOGLE_CHAT_PROJECT_NUMBER: joi.string().optional(),

  // Asana Configuration (optional - only required if ENABLE_ASANA_INTEGRATION=true)
  ASANA_ACCESS_TOKEN: joi.string().optional(),
  ASANA_WORKSPACE_GID: joi.string().optional(),
  ASANA_BOT_EMAIL: joi.string().email().optional(),
  ASANA_WEBHOOK_SECRET: joi.string().optional(),

  // Gemini AI Configuration
  GEMINI_API_KEY: isTest ? joi.string().default('test-key') : joi.string().required(),
  GEMINI_MODEL: joi.string().default('gemini-2.0-flash-exp'),

  // 3CX API Configuration
  THREECX_ENDPOINT: joi.string().optional(),
  THREECX_CLIENT_ID: joi.string().optional(),
  THREECX_CLIENT_SECRET: joi.string().optional(),
  THREECX_TOKEN_ENDPOINT: joi.string().default('/connect/token'),
  THREECX_STORAGE_BUCKET: joi.string().optional(),
  THREECX_STORAGE_BUCKET_PREFIX: joi.string().default(''),

  // Google Cloud Configuration
  GOOGLE_CLOUD_PROJECT: isTest ? joi.string().default('test-project') : joi.string().required(),
  FIRESTORE_DATABASE_ID: joi.string().default('(default)'),
  GOOGLE_APPLICATION_CREDENTIALS: joi.string().optional(),

  // Server Configuration
  PORT: joi.number().default(8080),
  NODE_ENV: joi.string().valid('development', 'production', 'test').default('development'),
  SERVICE_NAME: joi.string().default('bitrix24-gemini-agent'),
  CLOUD_RUN_SERVICE_URL: joi.string().uri().default('https://placeholder.run.app'),

  // Cloud Tasks Configuration
  CLOUD_TASKS_LOCATION: joi.string().default('us-central1'),
  CLOUD_TASKS_QUEUE: joi.string().default('chantilly-task-queue'),

  // Queue Configuration
  QUEUE_MAX_RETRIES: joi.number().default(3),
  QUEUE_RETRY_DELAY: joi.number().default(5000),
  RATE_LIMIT_PER_SECOND: joi.number().default(2),
  RATE_LIMIT_PER_10MIN: joi.number().default(10000),

  // Translation Feature  
  TRANSLATION_TARGET_DIALOG_IDS: joi.string().default('{}'),

  // Monitoring
  USE_CLOUD_LOGGING: joi.boolean().default(true),
  LOG_LEVEL: joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  ENABLE_METRICS: joi.boolean().default(true),

  // Prompt Management
  USE_DB_PROMPTS: joi.boolean().default(false),

  // ReasoningBank Memory System
  REASONING_MEMORY_ENABLED: joi.boolean().default(false),

  // MaTTS Test-Time Scaling
  MATTS_PARALLEL_ENABLED: joi.boolean().default(false),
  MATTS_SEQUENTIAL_ENABLED: joi.boolean().default(false),
  MATTS_PARALLEL_VARIANTS: joi.number().default(3),
  MATTS_SEQUENTIAL_ITERATIONS: joi.number().default(3),

  // Memory Retrieval Settings
  MEMORY_RETRIEVAL_TOP_K: joi.number().default(3),
  MEMORY_MIN_SUCCESS_RATE: joi.number().min(0).max(1).default(0.5),
  MEMORY_SIMILARITY_THRESHOLD: joi.number().min(0).max(1).default(0.5)
}).unknown();

const { error, value: validatedEnv } = envSchema.validate(process.env);

if (error) {
  throw new Error(`Environment validation error: ${error.message}`);
}

// Parse complex environment variables
const config = {
  ...validatedEnv,
  TRANSLATION_TARGET_DIALOG_IDS: validatedEnv.TRANSLATION_TARGET_DIALOG_IDS
    ? JSON.parse(validatedEnv.TRANSLATION_TARGET_DIALOG_IDS)
    : {}
};

module.exports = config;