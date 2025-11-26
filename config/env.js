const joi = require('joi');

// MINIMAL env validation - only for Cloud Run provided variables
// ALL other config loaded from Firestore via ConfigManager

const envSchema = joi.object({
  // Cloud Run provided
  PORT: joi.number().default(8080),
  NODE_ENV: joi.string().valid('development', 'production', 'test').default('development'),
  GOOGLE_CLOUD_PROJECT: joi.string().optional(), // Provided by ADC

  // Local development only
  GOOGLE_APPLICATION_CREDENTIALS: joi.string().optional(),
  FIRESTORE_DATABASE_ID: joi.string().default('(default)')
}).unknown();

const { error, value: validatedEnv } = envSchema.validate(process.env);

if (error) {
  throw new Error(`Environment validation error: ${error.message}`);
}

module.exports = validatedEnv;