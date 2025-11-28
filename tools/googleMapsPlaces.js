const BaseTool = require('../lib/baseTool');
const axios = require('axios');
const { extractGeminiText, getGeminiModelName } = require('../config/gemini');
const { logger } = require('../utils/logger');
const { getFirestore } = require('../config/firestore');

class GoogleMapsPlacesTool extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'GoogleMapsPlaces';
    this.description = 'Provides comprehensive area guides and location information using Google Places API (New) 2025 with KML knowledge base integration and AI-powered insights.';
    this.category = 'geographic';
    this.version = '1.0.0';
    this.author = 'Chantilly Agent';
    this.priority = 60;

    this.parameters = {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'The location, place, area, or neighborhood to get information about'
        },
        diagramType: {
          type: 'string',
          description: 'Type of analysis to perform',
          enum: ['comprehensive', 'nearby_search', 'text_search', 'place_details'],
          default: 'comprehensive'
        },
        radius: {
          type: 'number',
          description: 'Search radius in meters for nearby search',
          minimum: 100,
          maximum: 50000,
          default: 1000
        },
        useLastMessage: {
          type: 'boolean',
          description: 'Use location from previous tool results or messages',
          default: false
        }
      },
      required: ['location']
    };

    // API Configuration (loaded from Firestore)
    this.apiConfig = null;
    this.db = null;

    // Google Places API (New) 2025 endpoints
    this.endpoints = {
      textSearch: 'https://places.googleapis.com/v1/places:searchText',
      nearbySearch: 'https://places.googleapis.com/v1/places:searchNearby',
      placeDetails: 'https://places.googleapis.com/v1/places'
    };

    // Comprehensive field masks for 2025 API (validated fields only)
    this.fieldMasks = {
      comprehensive: [
        // Basic information
        'places.displayName',
        'places.formattedAddress',
        'places.shortFormattedAddress',
        'places.adrFormatAddress',
        'places.location',
        'places.viewport',
        'places.plusCode',
        'places.types',
        'places.primaryType',
        'places.businessStatus',
        
        // Ratings & reviews (comprehensive)
        'places.rating',
        'places.userRatingCount',
        'places.reviews',
        'places.editorialSummary',
        'places.generativeSummary',      // AI-powered summary
        
        // Visual content
        'places.photos',
        
        // Contact information
        'places.websiteUri',
        'places.internationalPhoneNumber',
        'places.nationalPhoneNumber',
        
        // Hours & availability
        'places.currentOpeningHours',
        'places.regularOpeningHours',
        'places.currentSecondaryOpeningHours',
        
        // Pricing & services
        'places.priceLevel',
        'places.takeout',
        'places.delivery',
        'places.dineIn',
        'places.curbsidePickup',
        'places.reservable',
        
        // Dining options
        'places.servesBreakfast',
        'places.servesLunch',
        'places.servesDinner',
        'places.servesBeer',
        'places.servesWine',
        'places.servesCocktails',
        'places.servesVegetarianFood',
        
        // Accessibility & family (corrected fields)
        'places.accessibilityOptions',
        'places.goodForChildren',
        'places.menuForChildren',
        'places.allowsDogs',
        
        // Atmosphere & features
        'places.outdoorSeating',
        'places.liveMusic',
        'places.restroom',
        'places.goodForGroups',
        'places.goodForWatchingSports'
      ].join(','),
      basic: [
        'places.displayName',
        'places.formattedAddress',
        'places.rating',
        'places.userRatingCount',
        'places.types',
        'places.location'
      ].join(',')
    };
  }

  async shouldTrigger(message, toolContext = {}) {
    try {
      // Comprehensive trigger patterns based on Google Places API 2025 capabilities
      const locationTriggers = [
        // === AREA INFORMATION & OVERVIEW ===
        'tell me about this location', 'tell me about this place', 'tell me about this area',
        'tell me about this spot', 'tell me about this neighborhood', 'tell me about this district',
        'more info about this place', 'more info about this location', 'more info about this area',
        'more info about this venue', 'more info about this site',
        'what is this area like', 'what is this place like', 'what is this location like',
        'what is this neighborhood like', 'what is this district like',
        'describe this place', 'describe this location', 'describe this area',
        'describe this neighborhood', 'describe this spot',
        'information about this location', 'information about this place', 'information about this area',
        'information about this district',
        'details about', 'what can you tell me about', 'can you tell me more about', 'can you tell me about',
        'tell me more about', 'give me info on this place',
        'give me info on this location', 'give me info on this area', 'give me info on this neighborhood',
        'learn about this location', 'learn about this place', 'learn about this area',
        'learn about this district',
        'area summary', 'neighborhood guide', 'local overview', 'area guide',
        
        // === BUSINESS & PLACE SEARCH ===
        'are there any', 'any good', 'where can i find', 'looking for',
        'find me', 'search for', 'places in', 'places near',
        'restaurants in', 'pizza in', 'coffee in', 'shops in',
        'in the area', 'near me', 'nearby', 'around here',
        'best places in', 'top rated in', 'popular places in',
        'what to do in', 'where to go in', 'attractions in',
        
        // === PHOTOS & VISUAL CONTENT ===
        'visitor photos', 'get photos', 'photos from', 'show photos',
        'pictures from', 'images from', 'photos of', 'pictures of',
        'visual content', 'photo gallery', 'see photos', 'view photos',
        'recent photos', 'user photos', 'street view', 'images of',
        
        // === RATINGS & REVIEWS ===
        'reviews for', 'ratings for', 'what people say about',
        'user reviews', 'customer reviews', 'feedback for',
        'opinions about', 'experiences at', 'testimonials for',
        'how good is', 'quality of', 'reputation of',
        
        // === HOURS & AVAILABILITY ===
        'opening hours', 'operating hours', 'hours for',
        'when open', 'open now', 'closed now', 'schedule for',
        'business hours', 'availability of', 'timing for',
        
        // === CONTACT & WEBSITE INFO ===
        'contact info', 'phone number', 'website for',
        'how to contact', 'reach out to', 'get in touch with',
        'official website', 'homepage for', 'online presence',
        
        // === PRICING & COST ===
        'price range', 'how expensive', 'cost of', 'pricing for',
        'budget for', 'affordable options', 'cheap places',
        'expensive places', 'mid range', 'price level',
        
        // === ACCESSIBILITY & AMENITIES ===
        'wheelchair accessible', 'accessibility options', 'disabled access',
        'parking available', 'parking options', 'ev charging',
        'restroom facilities', 'amenities at', 'facilities available',
        'good for kids', 'family friendly', 'pet friendly',
        
        // === DINING & SERVICES ===
        'takeout available', 'delivery options', 'dine in',
        'reservations at', 'outdoor seating', 'serves beer',
        'serves wine', 'vegetarian options', 'breakfast served',
        'lunch served', 'dinner served', 'cocktails available',
        
        // === ATMOSPHERE & EXPERIENCE ===
        'atmosphere at', 'vibe of', 'ambiance at',
        'good for groups', 'romantic places', 'quiet places',
        'live music', 'entertainment at', 'atmosphere in',
        
        // === GENERIC "GET X" PATTERNS ===
        'get information', 'get details', 'get data', 'get facts',
        'get reviews', 'get ratings', 'get photos', 'get hours',
        'get contact', 'get website', 'get directions', 'get address',
        'get pricing', 'get amenities', 'get services', 'get features',
        
        // === AI SUMMARY REQUESTS ===
        'summarize this area', 'overview of', 'quick summary',
        'ai summary', 'intelligent overview', 'smart insights',
        'gemini summary', 'automated overview', 'place insights'
      ];

      // Enhanced patterns with location variables - covers "Can you get X for Y area" patterns
      const dynamicPatterns = [
        // === AREA INFORMATION PATTERNS ===
        /what is (.+?) area like/i,
        /what is (.+?) place like/i,
        /what is (.+?) location like/i,
        /what is (.+?) neighborhood like/i,
        /tell me about (.+?) location/i,
        /tell me about (.+?) place/i,
        /tell me about (.+?) area/i,
        /tell me about (.+?) neighborhood/i,
        /details about (.+?) neighborhood/i,
        /details about (.+?) area/i,
        /details about (.+?) location/i,
        /can you tell me (?:more )?about (.+?) (?:area|neighborhood|location|place)/i,
        /tell me more about (.+?) (?:area|neighborhood|location|place)/i,
        /area summary for (.+)/i,
        /neighborhood guide for (.+)/i,
        /overview of (.+?) (?:area|neighborhood|location|place)/i,
        /describe (.+?) (?:area|neighborhood|location|place)/i,
        
        // === BUSINESS SEARCH PATTERNS ===
        /are there any (.+?) in (.+?) (?:area|neighborhood|location|place|district|city|town)/i,
        /any (.+?) in (.+?) (?:area|neighborhood)/i,
        /(.+?) places in (.+?)/i,
        /(.+?) near (.+?)/i,
        /(.+?) around (.+?)/i,
        /find (?:restaurants?|shops?|stores?|places?|bars?|cafes?|hotels?) in (.+?)/i,
        /find (.+?) (?:near|around|in) (.+?) (?:area|neighborhood|location|place|city)/i,
        /looking for (.+?) in (.+?) (?:area|neighborhood|location)/i,
        /where (?:can i find|are|is) (.+?) in (.+?) (?:area|neighborhood|location|city)/i,
        /good (.+?) in (.+?) (?:area|neighborhood|location)/i,
        /best (.+?) in (.+?) (?:area|neighborhood|location|city)/i,
        /top (.+?) in (.+?) (?:area|neighborhood|location)/i,
        /popular (.+?) in (.+?) (?:area|neighborhood|location)/i,
        
        // === "CAN YOU GET X FOR Y" COMPREHENSIVE PATTERNS ===
        /can you get (.+?) for (.+?) (?:area|neighborhood|location|place)/i,
        /can you get (.+?) from (.+?) (?:area|neighborhood|location|place)/i,
        /can you get (.+?) in (.+?) (?:area|neighborhood|location|place)/i,
        /can you get (.+?) about (.+?) (?:area|neighborhood|location|place)/i,
        /get (.+?) for (.+?) (?:area|neighborhood|location|place)/i,
        /get (.+?) from (.+?) (?:area|neighborhood|location|place)/i,
        /get (.+?) in (.+?) (?:area|neighborhood|location|place)/i,
        /get (.+?) about (.+?) (?:area|neighborhood|location|place)/i,
        /show me (.+?) for (.+?) (?:area|neighborhood|location|place)/i,
        /show me (.+?) from (.+?) (?:area|neighborhood|location|place)/i,
        /show me (.+?) in (.+?) (?:area|neighborhood|location|place)/i,
        /find (.+?) for (.+?) (?:area|neighborhood|location|place)/i,
        /find (.+?) from (.+?) (?:area|neighborhood|location|place)/i,
        /search (.+?) for (.+?) (?:area|neighborhood|location|place)/i,
        
        // === SPECIFIC DATA TYPE REQUESTS ===
        /(?:get|show|find) (?:photos|pictures|images) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:reviews|ratings) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:hours|timing|schedule) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:contact|phone|website) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:pricing|cost|prices) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:amenities|facilities|services) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:accessibility|parking|restroom) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:information|details|data) (?:for|from|of|in) (.+?)/i,
        
        // === DINING & ATMOSPHERE REQUESTS ===
        /(?:get|show|find) (?:takeout|delivery|dine.in) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:atmosphere|vibe|ambiance) (?:for|from|of|in) (.+?)/i,
        /(?:get|show|find) (?:outdoor.seating|live.music) (?:for|from|of|in) (.+?)/i,
        
        // === AI SUMMARY PATTERNS ===
        /(?:get|show|give) (?:ai|smart|intelligent) (?:summary|overview) (?:for|of) (.+?)/i,
        /(?:summarize|overview) (.+?) (?:area|neighborhood|location|place)/i,
        /(?:gemini|automated) (?:summary|overview|insights) (?:for|of) (.+?)/i
      ];

      const lowerMessage = message.toLowerCase();

      // Check static triggers
      const hasLocationTrigger = locationTriggers.some(trigger => 
        lowerMessage.includes(trigger.toLowerCase())
      );

      // Check dynamic patterns
      const hasDynamicTrigger = dynamicPatterns.some(pattern => 
        pattern.test(lowerMessage)
      );

      if (hasLocationTrigger || hasDynamicTrigger) {
        this.log('info', 'GoogleMapsPlaces triggered by location request', {
          message: message.substring(0, 100),
          triggerType: hasLocationTrigger ? 'static' : 'dynamic'
        });
        return true;
      }

      // Check if KML knowledge base has relevant geographic data
      const knowledgeResults = toolContext.knowledgeResults || [];
      const hasGeographicKnowledge = knowledgeResults.some(result => 
        result.category === 'geographic' ||
        result.tags?.some(tag => ['kml', 'geographic', 'location', 'neighborhood', 'area', 'map'].includes(tag.toLowerCase())) ||
        result.content?.toLowerCase().includes('coordinates') ||
        result.content?.toLowerCase().includes('<kml')
      );

      if (hasGeographicKnowledge && 
          (lowerMessage.includes('where') || lowerMessage.includes('location') || lowerMessage.includes('area'))) {
        this.log('info', 'GoogleMapsPlaces triggered by geographic knowledge context', {
          knowledgeResultsCount: knowledgeResults.length,
          hasGeographicContent: hasGeographicKnowledge
        });
        return true;
      }

      return false;

    } catch (error) {
      this.log('error', 'Error in GoogleMapsPlaces shouldTrigger', { error: error.message });
      return false;
    }
  }

  async execute(params, toolContext = {}) {
    try {
      await this.loadAPIConfiguration();
      
      const { location, diagramType = 'comprehensive', radius = 1000, useLastMessage = false } = params;

      // Check if this is specifically a photo request
      const userMessage = toolContext.messageData?.message || '';
      const isPhotoRequest = /photo|picture|image/i.test(userMessage);

      this.log('info', 'Starting GoogleMapsPlaces execution', {
        location,
        diagramType,
        radius,
        hasKnowledgeContext: !!toolContext.knowledgeResults,
        hasMessageData: !!toolContext.messageData,
        isPhotoRequest: isPhotoRequest,
        userMessage: userMessage.substring(0, 100)
      });

      // Step 1: Analyze KML and geographic knowledge base
      const kmlAnalysis = await this.analyzeKMLKnowledge(location, toolContext);
      
      // Step 2: Get search strategy from Gemini analysis
      const searchStrategy = await this.generateSearchStrategy(location, kmlAnalysis, toolContext);
      
      // Step 3: Execute Google Places API queries with triple fallback
      let placesData = null;
      
      // Phase 1: Try enhanced Places query based on KML analysis
      if (searchStrategy && searchStrategy.coordinates) {
        placesData = await this.queryPlacesAPI2025(searchStrategy, 'enhanced');
      }
      
      // Phase 2: Web search fallback if no good results
      if (!placesData || placesData.places?.length === 0) {
        this.log('info', 'KML search insufficient, chaining to web search');
        const webSearchResults = await this.chainWebSearch(location, toolContext);
        if (webSearchResults) {
          const webStrategy = await this.analyzeWebWithGemini(webSearchResults, location);
          placesData = await this.queryPlacesAPI2025(webStrategy, 'web_enhanced');
        }
      }
      
      // Phase 3: Basic Places query as last resort
      if (!placesData || placesData.places?.length === 0) {
        this.log('info', 'All sources failed, attempting basic Places query');
        placesData = await this.basicPlacesQuery(location);
      }

      // Step 4: Generate comprehensive response
      if (!placesData || placesData.places?.length === 0) {
        return `I apologize, but I couldn't find detailed information about "${location}". This could be because the location is very specific, new, or not widely covered in current databases. You might try being more specific or checking if the location name is spelled correctly.`;
      }

      const response = this.formatComprehensiveGuide(placesData, kmlAnalysis, null, location, isPhotoRequest);

      this.log('info', 'GoogleMapsPlaces completed successfully', {
        placesFound: placesData.places?.length || 0,
        responseLength: response.length,
        usedKMLData: !!kmlAnalysis,
        searchStrategy: searchStrategy?.source || 'basic',
        hasPhotos: response.includes('📸'),
        hasPhotoUrls: response.includes('places.googleapis.com') || response.includes('maps.googleapis.com'),
        responsePreview: response.substring(0, 500) + '...'
      });

      return response;

    } catch (error) {
      this.log('error', 'GoogleMapsPlaces tool failed', {
        error: error.message,
        stack: error.stack,
        params
      });
      return 'I encountered an error while searching for location information. Please try again with a different location or be more specific in your request.';
    }
  }

  async loadAPIConfiguration() {
    if (this.apiConfig) {return;} // Already loaded

    try {
      // Initialize Firestore if not already done
      if (!this.db) {
        this.db = getFirestore();
      }

      const doc = await this.db.collection('tool-settings').doc('GoogleMapsPlaces').get();
      
      if (!doc.exists) {
        throw new Error('Google Places API configuration not found. Please configure the API key in Firestore.');
      }

      const config = doc.data();
      
      if (!config.enabled) {
        throw new Error('Google Places API is disabled in configuration.');
      }

      if (!config.apiKey) {
        throw new Error('Google Places API key not found in configuration.');
      }

      this.apiConfig = {
        apiKey: config.apiKey,
        rateLimits: config.rateLimits || { requestsPerMinute: 60, requestsPerDay: 1000 },
        fieldPreferences: config.fieldPreferences || { defaultMask: 'enhanced', includeAISummaries: true, includeReviews: true },
        searchDefaults: config.searchDefaults || { radiusMeters: 1000, maxResults: 20, includedTypes: ['restaurant', 'tourist_attraction', 'point_of_interest', 'establishment'] }
      };

      this.log('info', 'Google Places API configuration loaded successfully', {
        hasApiKey: !!this.apiConfig.apiKey,
        rateLimits: this.apiConfig.rateLimits,
        searchDefaults: this.apiConfig.searchDefaults
      });

    } catch (error) {
      this.log('error', 'Failed to load Google Places API configuration', { error: error.message });
      throw error;
    }
  }

  async analyzeKMLKnowledge(location, toolContext) {
    try {
      const knowledgeResults = toolContext.knowledgeResults || [];
      
      // Filter for geographic and KML content
      const geoResults = knowledgeResults.filter(result => 
        result.category === 'geographic' ||
        result.tags?.some(tag => ['kml', 'geographic', 'location', 'neighborhood', 'area', 'map'].includes(tag.toLowerCase())) ||
        result.content?.toLowerCase().includes('coordinates') ||
        result.content?.toLowerCase().includes('<kml') ||
        result.content?.toLowerCase().includes(location.toLowerCase())
      );

      if (geoResults.length === 0) {
        this.log('info', 'No relevant KML/geographic knowledge found', { location });
        return null;
      }

      this.log('info', 'Found relevant geographic knowledge', {
        location,
        geoResultsCount: geoResults.length,
        titles: geoResults.map(r => r.title)
      });

      // Combine KML content for analysis
      const combinedKMLData = geoResults.map(result => ({
        title: result.title,
        content: result.content,
        tags: result.tags
      }));

      return {
        results: combinedKMLData,
        hasCoordinates: geoResults.some(r => r.content?.includes('coordinates')),
        hasKML: geoResults.some(r => r.content?.includes('<kml')),
        relevantTitles: geoResults.map(r => r.title)
      };

    } catch (error) {
      this.log('error', 'Error analyzing KML knowledge', { error: error.message });
      return null;
    }
  }

  async generateSearchStrategy(location, kmlAnalysis, toolContext) {
    try {
      if (!kmlAnalysis || kmlAnalysis.results.length === 0) {
        // Basic search strategy without KML data
        return {
          query: location,
          location: null,
          radius: this.apiConfig.searchDefaults.radiusMeters,
          types: this.apiConfig.searchDefaults.includedTypes,
          source: 'basic'
        };
      }

      // Use Gemini to analyze KML data and generate search strategy
      const { getGeminiClient } = require('../config/gemini');
      const client = getGeminiClient();

      const kmlDataText = kmlAnalysis.results.map(r => 
        `Title: ${r.title}\nContent: ${r.content.substring(0, 2000)}`
      ).join('\n\n');

      const analysisPrompt = `You are analyzing KML geographic data to extract relevant information for a Google Places API query.

KML DATA:
${kmlDataText}

USER QUERY: "${location}"

ANALYZE AND EXTRACT:
1. Geographic Boundaries: Lat/lng coordinates, polygons, boundaries
2. Key Locations: Named places, landmarks, points of interest
3. Context Clues: Neighborhood names, district information, local features
4. Search Strategy: What specific places/types should be queried in Google Places API

PROVIDE A JSON RESPONSE WITH:
{
  "coordinates": {"lat": number, "lng": number} or null,
  "query": "enhanced search query",
  "radius": number (in meters, 100-50000),
  "types": ["array", "of", "place", "types"],
  "keywords": ["relevant", "search", "keywords"],
  "neighborhood": "neighborhood name if found"
}

Generate a focused strategy for Google Places API to answer: "${location}"`;

      const result = await client.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }],
        config: {
          temperature: 0.3,
          maxOutputTokens: 1024
        }
      });

      // Use centralized response extraction
      const responseText = extractGeminiText(result);

      if (!responseText) {
        this.log('warn', 'No response from Gemini for KML analysis');
        return null;
      }

      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.log('warn', 'No valid JSON found in Gemini response', { responseText });
        return null;
      }

      const strategy = JSON.parse(jsonMatch[0]);
      strategy.source = 'kml_analysis';

      this.log('info', 'Generated search strategy from KML analysis', {
        hasCoordinates: !!strategy.coordinates,
        query: strategy.query,
        types: strategy.types,
        radius: strategy.radius
      });

      return strategy;

    } catch (error) {
      this.log('error', 'Error generating search strategy', { error: error.message });
      return null;
    }
  }

  async queryPlacesAPI2025(strategy, type = 'basic') {
    try {
      if (!this.apiConfig || !this.apiConfig.apiKey) {
        throw new Error('Google Places API not configured');
      }

      const baseHeaders = {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiConfig.apiKey,
        'X-Goog-FieldMask': this.fieldMasks.comprehensive
      };

      let requestBody = {};
      let endpoint = this.endpoints.textSearch;

      if (strategy && strategy.coordinates && type !== 'basic') {
        // Use nearby search with coordinates
        endpoint = this.endpoints.nearbySearch;
        requestBody = {
          locationRestriction: {
            circle: {
              center: {
                latitude: strategy.coordinates.lat,
                longitude: strategy.coordinates.lng
              },
              radius: strategy.radius || 1000
            }
          },
          maxResultCount: Math.min(this.apiConfig.searchDefaults.maxResults || 20, 20), // Max 20 for nearby search
          languageCode: 'en'
        };

        if (strategy.types && strategy.types.length > 0) {
          requestBody.includedTypes = strategy.types;
        }

      } else {
        // Use text search
        requestBody = {
          textQuery: strategy?.query || strategy, // Required field
          pageSize: Math.min(this.apiConfig.searchDefaults.maxResults || 20, 20), // Max 20 for text search
          languageCode: 'en'
        };
      }

      this.log('info', 'Querying Google Places API 2025', {
        endpoint,
        requestBodyKeys: Object.keys(requestBody),
        type,
        hasCoordinates: !!(strategy?.coordinates)
      });

      const response = await axios.post(endpoint, requestBody, {
        headers: baseHeaders,
        timeout: 15000
      });

      this.log('info', 'Google Places API response received', {
        statusCode: response.status,
        placesCount: response.data.places?.length || 0,
        hasPlaces: !!response.data.places
      });

      return response.data;

    } catch (error) {
      this.log('error', 'Google Places API query failed', {
        error: error.message,
        statusCode: error.response?.status,
        responseData: error.response?.data,
        type
      });
      
      // Return null to trigger fallback
      return null;
    }
  }

  async chainWebSearch(location, toolContext) {
    try {
      // Check if WebSearch tool is available
      const { getToolRegistry } = require('../lib/toolLoader');
      const registry = getToolRegistry();
      const webSearchTool = registry.getTool('WebSearch');

      if (!webSearchTool) {
        this.log('warn', 'WebSearch tool not available for chaining');
        return null;
      }

      this.log('info', 'Chaining to WebSearch tool for location information', { location });

      const webSearchResult = await webSearchTool.execute({
        query: `${location} area neighborhood guide information`,
        maxResults: 5,
        focusArea: 'general'
      }, toolContext);

      return webSearchResult;

    } catch (error) {
      this.log('error', 'Error chaining to WebSearch tool', { error: error.message });
      return null;
    }
  }

  async analyzeWebWithGemini(webSearchResults, location) {
    try {
      if (!webSearchResults || typeof webSearchResults !== 'string') {
        return null;
      }

      const { getGeminiClient } = require('../config/gemini');
      const client = getGeminiClient();

      const analysisPrompt = `You are analyzing web search results to extract location information for a Google Places API query.

WEB SEARCH RESULTS:
${webSearchResults.substring(0, 3000)}

LOCATION QUERY: "${location}"

Extract and provide a JSON response with:
{
  "query": "enhanced search query for Places API",
  "types": ["relevant", "place", "types"],
  "keywords": ["search", "keywords"],
  "neighborhood": "neighborhood name if mentioned"
}

Focus on extracting specific place types, neighborhood names, and search terms that would help find relevant places.`;

      const result = await client.models.generateContent({
        model: getGeminiModelName(),
        contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }],
        config: {
          temperature: 0.3,
          maxOutputTokens: 512
        }
      });

      // Use centralized response extraction
      const responseText = extractGeminiText(result);

      if (!responseText) {
        return null;
      }

      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return null;
      }

      const strategy = JSON.parse(jsonMatch[0]);
      strategy.source = 'web_analysis';

      this.log('info', 'Generated search strategy from web analysis', {
        query: strategy.query,
        types: strategy.types
      });

      return strategy;

    } catch (error) {
      this.log('error', 'Error analyzing web search with Gemini', { error: error.message });
      return null;
    }
  }

  async basicPlacesQuery(location) {
    try {
      this.log('info', 'Executing basic Places query as fallback', { location });

      return await this.queryPlacesAPI2025({
        query: location,
        source: 'basic_fallback'
      }, 'basic');

    } catch (error) {
      this.log('error', 'Basic Places query failed', { error: error.message });
      return null;
    }
  }

  formatComprehensiveGuide(placesData, kmlData, webData, location, isPhotoRequest = false) {
    const currentDate = new Date().toLocaleDateString();
    
    // If this is specifically a photo request, format a photo-focused response
    if (isPhotoRequest) {
      return this.formatPhotoFocusedResponse(placesData, location, currentDate);
    }
    
    let response = `🗺️ **Comprehensive Area Guide: ${location}**\n\n`;

    // Add KML context if available
    if (kmlData && kmlData.results.length > 0) {
      response += '📍 **Geographic Context** (from local knowledge):\n';
      response += `Found ${kmlData.results.length} relevant local documents covering this area.\n`;
      if (kmlData.relevantTitles.length > 0) {
        response += `Local data sources: ${kmlData.relevantTitles.join(', ')}\n`;
      }
      response += '\n';
    }

    // Add AI summary if available
    const aiSummary = this.extractAISummary(placesData);
    if (aiSummary) {
      response += '🤖 **AI Area Summary** (powered by Google\'s Gemini):\n';
      response += `${aiSummary}\n\n`;
    }

    // Add current places and attractions
    if (placesData && placesData.places && placesData.places.length > 0) {
      response += '🏢 **Current Places & Attractions** (live data):\n';
      const topPlaces = placesData.places.slice(0, 8);
      
      topPlaces.forEach((place, index) => {
        response += `\n**${index + 1}. ${place.displayName?.text || 'Unknown Place'}**\n`;
        
        if (place.formattedAddress) {
          response += `📍 ${place.formattedAddress}\n`;
        }
        
        if (place.rating && place.userRatingCount) {
          response += `⭐ ${place.rating}/5 (${place.userRatingCount.toLocaleString()} reviews)\n`;
        }
        
        if (place.types && place.types.length > 0) {
          const relevantTypes = place.types.slice(0, 3).join(', ');
          response += `🏷️ ${relevantTypes}\n`;
        }
        
        if (place.editorialSummary?.text) {
          response += `📝 ${place.editorialSummary.text}\n`;
        }
        
        if (place.websiteUri) {
          response += `🌐 [Website](${place.websiteUri})\n`;
        }
        
        // Add opening hours if available
        if (place.currentOpeningHours?.weekdayDescriptions) {
          const todayHours = place.currentOpeningHours.weekdayDescriptions[new Date().getDay()];
          if (todayHours) {
            response += `🕒 ${todayHours}\n`;
          }
        }
        
        // Add price level if available
        if (place.priceLevel) {
          const priceSymbols = '$'.repeat(place.priceLevel);
          response += `💰 Price range: ${priceSymbols}\n`;
        }
        
        // Add recent review snippet if available
        if (place.reviews && place.reviews.length > 0 && place.reviews[0].text?.text) {
          const reviewText = place.reviews[0].text.text.substring(0, 100);
          response += `💬 Recent review: "${reviewText}..." (${place.reviews[0].rating}⭐)\n`;
        }
        
        // Add photos if available - include actual URLs for Bitrix24 previews
        if (place.photos && place.photos.length > 0) {
          const photoUrls = this.extractPhotoUrls(place.photos);
          response += `📸 **Photos** (${place.photos.length} available):\n`;
          photoUrls.forEach((photoUrl, index) => {
            response += `- Photo ${index + 1}: ${photoUrl}\n`;
          });
          response += '\n'; // Add extra spacing after photos
        }
        
        // Add dining services if available
        const diningServices = [];
        if (place.takeout) {diningServices.push('Takeout');}
        if (place.delivery) {diningServices.push('Delivery');}
        if (place.dineIn) {diningServices.push('Dine-in');}
        if (place.reservable) {diningServices.push('Reservations');}
        if (diningServices.length > 0) {
          response += `🍽️ Services: ${diningServices.join(', ')}\n`;
        }
        
        // Add accessibility information
        const accessibility = [];
        if (place.accessibilityOptions) {accessibility.push('Accessible options available');}
        if (place.goodForChildren) {accessibility.push('Good for children');}
        if (place.allowsDogs) {accessibility.push('Dog-friendly');}
        if (accessibility.length > 0) {
          response += `♿ Accessibility: ${accessibility.join(', ')}\n`;
        }
        
        // Add special features
        const features = [];
        if (place.outdoorSeating) {features.push('Outdoor seating');}
        if (place.liveMusic) {features.push('Live music');}
        if (place.goodForGroups) {features.push('Good for groups');}
        if (place.servesVegetarianFood) {features.push('Vegetarian options');}
        if (features.length > 0) {
          response += `✨ Features: ${features.join(', ')}\n`;
        }
      });
      response += '\n';
    }

    // Add recent reviews and insights
    const reviewSummary = this.formatRecentReviews(placesData);
    if (reviewSummary) {
      response += '👥 **Recent Reviews & User Insights**:\n';
      response += `${reviewSummary}\n\n`;
    }

    // Add live neighborhood data
    response += '📊 **Live Neighborhood Data**:\n';
    response += '- Current ratings and popular times\n';
    response += '- Recent user submissions and photos\n';
    response += '- Up-to-date pricing and availability\n';
    response += '- Real-time accessibility information\n\n';

    // Add local recommendations
    const recommendations = this.generateSmartRecommendations(placesData, kmlData);
    if (recommendations) {
      response += '📱 **Local Recommendations**:\n';
      response += `${recommendations}\n\n`;
    }

    // Footer
    response += '*Guide combines local KML data, live Google Places information, and AI-powered insights*\n';
    response += `*Last updated: ${currentDate}*`;

    return response;
  }

  extractAISummary(placesData) {
    try {
      if (!placesData || !placesData.places) {return null;}

      // Look for AI-generated summaries in places data
      for (const place of placesData.places) {
        if (place.generativeSummary?.overview?.text) {
          return place.generativeSummary.overview.text;
        }
        if (place.editorialSummary?.text && place.editorialSummary.text.length > 100) {
          return place.editorialSummary.text;
        }
      }

      return null;
    } catch (error) {
      this.log('error', 'Error extracting AI summary', { error: error.message });
      return null;
    }
  }

  formatRecentReviews(placesData) {
    try {
      if (!placesData || !placesData.places) {return null;}

      const reviews = [];
      
      for (const place of placesData.places.slice(0, 3)) {
        if (place.reviews && place.reviews.length > 0) {
          const recentReview = place.reviews[0];
          if (recentReview.text?.text) {
            reviews.push({
              placeName: place.displayName?.text,
              reviewText: recentReview.text.text.substring(0, 150) + '...',
              rating: recentReview.rating,
              relativeTime: recentReview.relativePublishTimeDescription
            });
          }
        }
      }

      if (reviews.length === 0) {return null;}

      let summary = '';
      reviews.forEach((review, index) => {
        summary += `- **${review.placeName}** (${review.rating}⭐): ${review.reviewText}\n`;
        if (review.relativeTime) {
          summary += `  *${review.relativeTime}*\n`;
        }
      });

      return summary;

    } catch (error) {
      this.log('error', 'Error formatting recent reviews', { error: error.message });
      return null;
    }
  }

  /**
   * Format a photo-focused response for photo requests
   * @param {Object} placesData - Places API response data
   * @param {string} location - Location name
   * @param {string} currentDate - Current date string
   * @returns {string} Photo-focused response
   */
  formatPhotoFocusedResponse(placesData, location, currentDate) {
    if (!placesData || !placesData.places || placesData.places.length === 0) {
      return `❌ No location data found for "${location}". Try searching for a broader area or nearby landmarks.`;
    }

    // Focus on places with photos
    const placesWithPhotoData = placesData.places
      .filter(place => place.photos && place.photos.length > 0)
      .slice(0, 6); // Limit to 6 places for concise response

    if (placesWithPhotoData.length === 0) {
      return `❌ No photos available for "${location}". Try searching for nearby landmarks or popular attractions.`;
    }

    let totalPhotos = 0;
    placesWithPhotoData.forEach(place => {
      if (place.photos) {totalPhotos += place.photos.length;}
    });

    // Lead with success message following established pattern
    let response = `✅ **Photo search successful!** Found **${totalPhotos} photos** from **${placesWithPhotoData.length} locations** in ${location}.\n\n`;

    // Concise photo listings
    placesWithPhotoData.forEach((place, index) => {
      const photoUrls = this.extractPhotoUrls(place.photos);
      if (photoUrls.length > 0) {
        response += `📍 **${place.displayName?.text || `Location ${index + 1}`}**\n`;
        
        if (place.rating && place.userRatingCount) {
          response += `⭐ ${place.rating}/5 (${place.userRatingCount.toLocaleString()}) - `;
        }

        response += `📸 ${photoUrls.length} photo${photoUrls.length > 1 ? 's' : ''}\n`;

        // Show up to 6 photos per location to keep response manageable
        const displayPhotos = photoUrls.slice(0, 6);
        displayPhotos.forEach((photoUrl, photoIndex) => {
          response += `- [Photo ${photoIndex + 1}](${photoUrl})\n`;
        });

        if (photoUrls.length > 6) {
          response += `- *${photoUrls.length - 6} more photos available*\n`;
        }
        
        response += '\n';
      }
    });

    response += `*Retrieved from Google Places API on ${currentDate}*`;
    
    return response;
  }

  /**
   * Extract photo URLs from Google Places photo data
   * @param {Array} photos - Array of photo objects from Places API
   * @returns {Array} Array of photo URLs for Bitrix24 display
   */
  extractPhotoUrls(photos) {
    try {
      if (!photos || photos.length === 0) {return [];}

      const photoUrls = [];
      const maxPhotos = Math.min(photos.length, 10); // Limit to 10 photos to avoid spam

      for (let i = 0; i < maxPhotos; i++) {
        const photo = photos[i];
        if (photo.name) {
          // Google Places API (New) uses photo.name as the photo reference
          const photoUrl = this.constructPhotoUrl(photo.name);
          photoUrls.push(photoUrl);
        }
      }

      this.log('info', 'Extracted photo URLs for display', {
        totalPhotos: photos.length,
        extractedUrls: photoUrls.length,
        photoUrls: photoUrls.map(url => url.substring(0, 100) + '...'),
        photoReferences: photos.slice(0, 3).map(photo => photo.name || 'no-name'),
        urlFormat: photoUrls[0]?.includes('places.googleapis.com') ? 'new_api' : 'legacy_api'
      });

      return photoUrls;

    } catch (error) {
      this.log('error', 'Error extracting photo URLs', { error: error.message });
      return [];
    }
  }

  /**
   * Construct Google Places photo URL from photo reference (New API 2025 format)
   * @param {string} photoReference - Photo reference from Places API (New format)
   * @returns {string} Complete photo URL
   */
  constructPhotoUrl(photoReference) {
    const maxWidth = 800; // Good size for Bitrix24 previews
    
    // Google Places API (New) 2025 uses a different photo URL format
    // The photo reference is now a full resource name like "places/ChIJ.../photos/xyz"
    // We need to use the new photo endpoint format
    
    // Check if it's the new format (starts with "places/")
    if (photoReference.startsWith('places/')) {
      // Use the new Places API photo endpoint
      return `https://places.googleapis.com/v1/${photoReference}/media?maxWidthPx=${maxWidth}&key=${this.apiConfig.apiKey}`;
    } else {
      // Fallback to legacy format for compatibility
      return `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photo_reference=${photoReference}&key=${this.apiConfig.apiKey}`;
    }
  }

  generateSmartRecommendations(placesData, kmlData) {
    try {
      if (!placesData || !placesData.places) {return null;}

      const recommendations = [];
      const topRatedPlaces = placesData.places
        .filter(place => place.rating && place.rating >= 4.0)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))
        .slice(0, 3);

      topRatedPlaces.forEach(place => {
        if (place.displayName?.text && place.types) {
          const primaryType = place.types[0].replace(/_/g, ' ');
          recommendations.push(`- **${place.displayName.text}** - Highly rated ${primaryType} (${place.rating}⭐)`);
        }
      });

      // Add KML-based recommendations if available
      if (kmlData && kmlData.relevantTitles.length > 0) {
        recommendations.push(`- Check local knowledge base for detailed information about ${kmlData.relevantTitles[0]}`);
      }

      return recommendations.length > 0 ? recommendations.join('\n') : null;

    } catch (error) {
      this.log('error', 'Error generating smart recommendations', { error: error.message });
      return null;
    }
  }
}

module.exports = GoogleMapsPlacesTool;