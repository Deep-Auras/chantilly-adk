const { GoogleGenAI } = require('@google/genai');
const { logger } = require('../utils/logger');

let geminiClient;
let model;
let geminiModelName;
let geminiApiKey;

/**
 * Load Gemini configuration from Firestore ONLY
 * NO FALLBACKS - Database-driven only
 * Returns null if config doesn't exist (e.g., during first-time setup)
 */
async function loadGeminiConfig() {
  try {
    const { getFirestore } = require('./firestore');
    const db = getFirestore();
    const configDoc = await db.collection('agent').doc('config').get();

    if (!configDoc.exists) {
      logger.warn('Configuration not found in Firestore', {
        note: 'Setup wizard has not been completed yet. Access /setup to configure.'
      });
      return null;
    }

    const data = configDoc.data();

    if (!data.GEMINI_API_KEY) {
      logger.warn('GEMINI_API_KEY not found in Firestore', {
        note: 'Complete setup wizard at /setup to configure API key'
      });
      return null;
    }

    if (!data.GEMINI_MODEL) {
      logger.warn('GEMINI_MODEL not found in Firestore', {
        note: 'Complete setup wizard at /setup to configure model'
      });
      return null;
    }

    geminiApiKey = data.GEMINI_API_KEY;
    geminiModelName = data.GEMINI_MODEL;

    logger.info('Loaded Gemini config from Firestore', {
      model: geminiModelName,
      hasApiKey: true
    });

    return { apiKey: geminiApiKey, model: geminiModelName };
  } catch (error) {
    logger.error('Failed to load Gemini config from Firestore', {
      error: error.message,
      note: 'Run setup wizard at /setup to configure'
    });
    return null;
  }
}

async function initializeGemini() {
  if (!geminiClient) {
    // Load API key and model from Firestore
    const config = await loadGeminiConfig();

    // If config is null (setup not completed), skip initialization
    if (!config) {
      logger.warn('Gemini initialization skipped - configuration not available', {
        note: 'Complete setup wizard at /setup to enable Gemini'
      });
      return { client: null, model: null };
    }

    geminiClient = new GoogleGenAI({
      apiKey: config.apiKey
    });
    model = {
      generateContent: async (prompt) => {
        return await geminiClient.models.generateContent({
          model: config.model,
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

            const result = geminiClient.models.generateContent({
              model: config.model,
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
    logger.info(`Gemini initialized with model: ${config.model}`);
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
 * Returns the model loaded from Firestore ONLY
 */
function getGeminiModelName() {
  if (!geminiModelName) {
    throw new Error('Gemini not initialized. Call initializeGemini() first.');
  }
  return geminiModelName;
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
    customLogger('Gemini response parts breakdown', {
      hasCandidates: !!result.candidates,
      candidatesLength: result.candidates?.length || 0,
      totalParts: allParts.length,
      partTypes: allParts.map((p, i) => ({
        index: i,
        keys: Object.keys(p),
        hasText: !!p.text,
        isThought: !!p.thought,
        textLength: p.text?.length || 0,
        textPreview: p.text?.substring(0, 200) || '',
        fullPart: JSON.stringify(p).substring(0, 500)
      }))
    });
  }

  // Filter out thought parts (Gemini 2.5 includes reasoning with thought: true)
  const textParts = allParts.filter(part => !part.thought);

  logger.info('extractGeminiText result', {
    totalParts: allParts.length,
    textPartsAfterFilter: textParts.length,
    hasAnyText: textParts.some(p => p.text),
    combinedLength: textParts.map(part => part.text || '').join('').length
  });

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

async function getVertexAIClient() {
  if (!vertexAIClient) {
    // GOOGLE_CLOUD_PROJECT is available via ADC in Cloud Run
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;

    if (!projectId) {
      throw new Error('GOOGLE_CLOUD_PROJECT not available via Application Default Credentials');
    }

    vertexAIClient = new GoogleGenAI({
      vertexai: true,  // CRITICAL: lowercase 'ai', boolean value (per official Google Cloud docs)
      project: projectId,
      location: process.env.VERTEX_AI_LOCATION || 'us-central1'
    });
    logger.info('Vertex AI client initialized for YouTube URL support', { projectId });
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