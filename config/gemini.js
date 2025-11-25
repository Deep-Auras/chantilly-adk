const { GoogleGenAI } = require('@google/genai');
const config = require('./env');
const { logger } = require('../utils/logger');

let geminiClient;
let model;
let geminiModelName;

/**
 * Load Gemini model configuration from Firestore
 * Falls back to env var if Firestore not available or no config set
 */
async function loadGeminiModelConfig() {
  if (geminiModelName) {
    return geminiModelName; // Already loaded
  }

  try {
    const { getFirestore } = require('./firestore');
    const db = getFirestore();
    const configDoc = await db.collection('agent').doc('config').get();

    if (configDoc.exists && configDoc.data().geminiModel) {
      geminiModelName = configDoc.data().geminiModel;
      logger.info('Loaded Gemini model from Firestore', { model: geminiModelName });
      return geminiModelName;
    }
  } catch (error) {
    logger.warn('Failed to load Gemini model from Firestore, using default', {
      error: error.message
    });
  }

  // Fallback to env var default
  geminiModelName = config.GEMINI_MODEL;
  logger.info('Using default Gemini model from env', { model: geminiModelName });
  return geminiModelName;
}

async function initializeGemini() {
  if (!geminiClient) {
    // Load model config from Firestore first
    const modelName = await loadGeminiModelConfig();

    geminiClient = new GoogleGenAI({
      apiKey: config.GEMINI_API_KEY
    });
    model = {
      generateContent: async (prompt) => {
        return await geminiClient.models.generateContent({
          model: modelName,
          contents: typeof prompt === 'string' ?
            [{ role: 'user', parts: [{ text: prompt }] }] : prompt.contents || prompt
        });
      },
      startChat: (options = {}) => {
        return {
          sendMessage: async (prompt) => {
            const contents = options.history || [];
            contents.push({
              role: 'user',
              parts: [{ text: prompt }]
            });

            const result = await geminiClient.models.generateContent({
              model: modelName,
              contents,
              systemInstruction: options.systemInstruction
            });

            // Use centralized response extraction
            const responseText = extractGeminiText(result);

            return {
              response: {
                text: () => responseText
              }
            };
          }
        };
      }
    };
    logger.info(`Gemini initialized with model: ${modelName}`);
  }
  return { client: geminiClient, model };
}

function getGeminiModel() {
  if (!model) {
    initializeGemini();
  }
  return model;
}

function getGeminiClient() {
  if (!geminiClient) {
    initializeGemini();
  }
  return geminiClient;
}

/**
 * Get the configured Gemini model name
 * Returns the model loaded from Firestore, or the default if not yet loaded
 */
function getGeminiModelName() {
  return geminiModelName || config.GEMINI_MODEL;
}

// Helper function to create a model with specific settings
function createCustomModel(modelConfig = {}) {
  const client = getGeminiClient();
  return {
    generateContent: async (request) => {
      return await client.models.generateContent({
        model: modelConfig.model || getGeminiModelName(),
        ...request,
        generationConfig: {
          temperature: modelConfig.temperature || 0.7,
          topK: modelConfig.topK || 40,
          topP: modelConfig.topP || 0.95,
          maxOutputTokens: modelConfig.maxOutputTokens || 1024,
          ...modelConfig.generationConfig
        },
        safetySettings: modelConfig.safetySettings || [
          {
            category: 'HARM_CATEGORY_HARASSMENT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          },
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          },
          {
            category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          },
          {
            category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          }
        ]
      });
    }
  };
}

/**
 * Extracts text from Gemini API response, handling multi-part responses
 * and filtering out thought parts (Gemini 2.5 reasoning)
 *
 * @param {Object} result - Gemini API result object
 * @param {Object} options - Optional configuration
 * @param {boolean} options.includeLogging - Whether to log parts breakdown (default: false)
 * @param {Function} options.logger - Logger function to use for debugging
 * @returns {string} Combined text from all non-thought parts
 */
function extractGeminiText(result, options = {}) {
  const { includeLogging = false, logger: customLogger } = options;

  // Extract all parts from the response
  const allParts = result.candidates?.[0]?.content?.parts || [];

  // Optional debug logging
  if (includeLogging && customLogger) {
    customLogger('debug', 'Gemini response parts breakdown', {
      totalParts: allParts.length,
      partTypes: allParts.map((p, i) => ({
        index: i,
        hasText: !!p.text,
        isThought: !!p.thought,
        textLength: p.text?.length || 0,
        textPreview: p.text?.substring(0, 100) || ''
      }))
    });
  }

  // Filter out thought parts (Gemini 2.5 includes reasoning with thought: true)
  const textParts = allParts.filter(part => !part.thought);

  // Combine all text parts into a single string
  return textParts.map(part => part.text || '').join('');
}

/**
 * Get Vertex AI client for features that require service account auth
 * (e.g., YouTube URL support)
 *
 * Uses Application Default Credentials from service account
 */
let vertexAIClient;

function getVertexAIClient() {
  if (!vertexAIClient) {
    vertexAIClient = new GoogleGenAI({
      vertexai: true,  // CRITICAL: lowercase 'ai', boolean value (per official Google Cloud docs)
      project: config.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION || 'us-central1'
    });
    logger.info('Vertex AI client initialized for YouTube URL support');
  }
  return vertexAIClient;
}

module.exports = {
  initializeGemini,
  getGeminiModel,
  getGeminiClient,
  getGeminiModelName,
  getVertexAIClient,
  createCustomModel,
  extractGeminiText
};