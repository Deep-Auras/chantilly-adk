# Google Maps Places Tool Implementation Plan

## 📋 **Project Overview**
Implementation of GoogleMapsPlaces tool for Chantilly Agent using Google Places API (New) 2025 with KML knowledge base integration and AI-powered location insights.

## 🎯 **User Requirements & Answers**

### **Claude's Questions & User Responses:**

1. **API Key Management**: 
   - ✅ User has Google Places API key
   - ✅ Load API key from Firestore `tool-settings` collection document

2. **KML Integration Scope**:
   - ✅ Search **ALL geographic knowledge base entries** (not just specific KML)
   - ✅ Include all documents with geographic tags, coordinates, location data

3. **Response Detail Level**:
   - ✅ **Comprehensive area guides** with maximum detail
   - ✅ Focus on **recent information** especially people-submitted content
   - ✅ Include user reviews, ratings, current data

4. **Tool Priority**:
   - ✅ Priority: **68** (between Translation (70) and ChatSummary (60))

5. **Fallback Strategy**:
   - ✅ Triple fallback: **KML → Web Search → Basic Google Places query**
   - ✅ Always attempt basic Places query if other methods fail

## 🏗️ **Technical Architecture**

### **Tool Flow Diagram**
```
User Query → Trigger Detection → KML Knowledge Search → Gemini Analysis → Places API Query → Comprehensive Response
     ↓              ↓                    ↓                 ↓               ↓
   Location    Geographic KB      AI Strategy        2025 API        Formatted Guide
   Request     Documents          Generation         Enhanced         with AI Summaries
     ↓              ↓                    ↓               Data              ↓
  Fallback → Web Search Tool → Gemini Analysis → Places API → Combined Response
     ↓              ↓                    ↓               ↓              ↓
Last Resort → Basic Places Query → Domain Fallback → Simple Response
```

### **2025 Google Places API Integration**

**Critical 2025 Updates:**
- ✅ Places API (New) endpoints required (Legacy discontinued)
- ✅ Mandatory `X-Goog-FieldMask` headers for all requests
- ✅ AI-powered summaries using Gemini model integration
- ✅ Enhanced data fields and accessibility options
- ✅ Session-based pricing model

**API Endpoints (2025):**
- Text Search: `https://places.googleapis.com/v1/places:searchText` (POST)
- Nearby Search: `https://places.googleapis.com/v1/places:searchNearby` (POST)
- Place Details: `https://places.googleapis.com/v1/places/PLACE_ID` (GET)

**Required Dependencies:**
```bash
npm install @googlemaps/places
```

**2025 API Request Syntax:**

*Text Search Request:*
```javascript
POST https://places.googleapis.com/v1/places:searchText
Headers: {
  'Content-Type': 'application/json',
  'X-Goog-Api-Key': 'API_KEY',
  'X-Goog-FieldMask': 'places.displayName,places.formattedAddress'
}
Body: {
  "textQuery": "required search string",
  "pageSize": 20, // max 20
  "languageCode": "en"
}
```

*Nearby Search Request:*
```javascript
POST https://places.googleapis.com/v1/places:searchNearby
Headers: {
  'Content-Type': 'application/json',
  'X-Goog-Api-Key': 'API_KEY',
  'X-Goog-FieldMask': 'places.displayName,places.formattedAddress'
}
Body: {
  "locationRestriction": {
    "circle": {
      "center": { "latitude": 37.7937, "longitude": -122.3965 },
      "radius": 500.0
    }
  },
  "maxResultCount": 20, // max 20
  "includedTypes": ["restaurant", "tourist_attraction"]
}
```

## 🔧 **Firestore Configuration**

### **Document Structure: `tool-settings/GoogleMapsPlaces`**
```javascript
{
  apiKey: string,                    // Google Places API key
  enabled: boolean,                  // true
  rateLimits: {                      // map
    requestsPerMinute: number,       // 60
    requestsPerDay: number           // 1000
  },
  fieldPreferences: {                // map
    defaultMask: string,             // "enhanced"
    includeAISummaries: boolean,     // true
    includeReviews: boolean          // true
  },
  searchDefaults: {                  // map
    radiusMeters: number,            // 1000
    maxResults: number,              // 20
    includedTypes: array             // ["restaurant", "tourist_attraction", "point_of_interest", "establishment"]
  },
  createdAt: timestamp,              // Firestore timestamp
  updatedAt: timestamp,              // Firestore timestamp
  createdBy: string                  // "admin"
}
```

## 🎯 **Tool Triggers & Patterns**

### **Primary Trigger Patterns:**
- `tell me about this location/place/area/spot/neighborhood/district`
- `more info about this place/location/area/venue/site`
- `what is this area/place/location/neighborhood/district like`
- `what is [X] area/place/location/neighborhood/district like`
- `tell me about [X] location/place/area/neighborhood`

### **Expanded Variations:**
- `describe this place/location/area/neighborhood/spot`
- `information about this location/place/area/district`
- `details about [X] neighborhood/area/location/place`
- `what can you tell me about [X] location/area/place`
- `give me info on this place/location/area/neighborhood`
- `learn about this location/place/area/district`
- `area summary for [X]`
- `neighborhood guide for [X]`

### **Geographic Synonyms:**
- **Location**: place, spot, site, venue, destination, locale, position
- **Area**: region, zone, district, section, vicinity, territory, quarter
- **Neighborhood**: hood, district, quarter, community, borough, precinct

## 🧠 **AI Integration Strategy**

### **KML Analysis with Gemini**
```javascript
buildKMLAnalysisPrompt(kmlData, userQuery) {
  return `You are analyzing KML geographic data to extract relevant information for a Google Places API query.

KML DATA:
${kmlData}

USER QUERY: "${userQuery}"

ANALYZE AND EXTRACT:
1. **Geographic Boundaries**: Lat/lng coordinates, polygons, boundaries
2. **Key Locations**: Named places, landmarks, points of interest
3. **Context Clues**: Neighborhood names, district information, local features
4. **Search Strategy**: What specific places/types should be queried in Google Places API

PROVIDE:
- Specific coordinates or address for Places API
- Place types to search for (restaurant, tourist_attraction, etc.)
- Radius for search area
- Keywords that would enhance the search

Generate a focused strategy for Google Places API to answer: "${userQuery}"`;
}
```

### **AI-Powered Response Enhancement**
- ✅ **Place Summaries**: Brief overviews powered by Gemini
- ✅ **Review Summaries**: AI-generated review analysis
- ✅ **Area Summaries**: Neighborhood character and insights
- ✅ **Recent Information Priority**: Focus on user-submitted, current data

## 📊 **Field Masks & Data Retrieval**

### **Comprehensive Field Configuration:**
```javascript
this.fieldMasks = {
  comprehensive: [
    'places.displayName',
    'places.formattedAddress', 
    'places.rating',
    'places.userRatingCount',
    'places.editorialSummary',
    'places.generativeSummary',      // AI-powered summary
    'places.reviews',                // Recent user reviews
    'places.photos',
    'places.currentOpeningHours',
    'places.priceLevel',
    'places.types',
    'places.websiteUri',
    'places.regularOpeningHours',
    'places.accessibilityOptions'
  ].join(',')
};
```

## 🔄 **Triple Fallback Strategy**

### **Phase 1: KML Knowledge Base Search**
```javascript
// Search ALL geographic knowledge base entries
const geoFilter = knowledgeResults.filter(result => 
  result.category === 'geographic' ||
  result.tags.some(tag => ['kml', 'geographic', 'location', 'neighborhood', 'area', 'map'].includes(tag.toLowerCase())) ||
  result.content.toLowerCase().includes('coordinates') ||
  result.content.toLowerCase().includes('<kml') ||
  result.content.toLowerCase().includes(location.toLowerCase())
);
```

### **Phase 2: Web Search Fallback**
```javascript
if (!placesData || placesData.places?.length === 0) {
  this.log('info', 'KML search insufficient, chaining to web search');
  const webSearchResults = await this.chainWebSearch(location, toolContext);
  const webStrategy = await this.analyzeWebWithGemini(webSearchResults, query);
  placesData = await this.queryPlacesAPI2025(webStrategy);
}
```

### **Phase 3: Basic Places Query (Last Resort)**
```javascript
if (!placesData || placesData.places?.length === 0) {
  this.log('info', 'All sources failed, attempting basic Places query');
  placesData = await this.basicPlacesQuery(location);
}
```

## 📱 **Response Format**

### **Comprehensive Area Guide Template:**
```javascript
formatComprehensiveGuide(placesData, kmlData, webData, location) {
  return `🗺️ **Comprehensive Area Guide: ${location}**

📍 **Geographic Context** (from local knowledge):
${this.formatKMLContext(kmlData)}

🤖 **AI Area Summary** (powered by Google's Gemini):
${this.extractAISummary(placesData)}

🏢 **Current Places & Attractions** (live data):
${this.formatRecentPlaces(placesData)}

👥 **Recent Reviews & User Insights**:
${this.formatRecentReviews(placesData)}

📊 **Live Neighborhood Data**:
- Current ratings and popular times
- Recent user submissions and photos  
- Up-to-date pricing and availability
- Real-time accessibility information

🌐 **Additional Context** (web search):
${webData ? this.formatWebContext(webData) : 'No additional web context found'}

📱 **Local Recommendations**:
${this.generateSmartRecommendations(placesData, kmlData)}

*Guide combines local KML data, live Google Places information, and AI-powered insights*
*Last updated: ${new Date().toLocaleString()}*`;
}
```

## 🔒 **Security & Rate Limiting**

### **API Configuration Loading:**
```javascript
async loadAPIConfiguration() {
  const doc = await db.collection('tool-settings').doc('GoogleMapsPlaces').get();
  
  if (!doc.exists || !doc.data().enabled) {
    throw new Error('Google Places API configuration not found or disabled');
  }
  
  this.apiConfig = {
    apiKey: config.apiKey,
    rateLimits: config.rateLimits,
    fieldPreferences: config.fieldPreferences,
    searchDefaults: config.searchDefaults
  };
}
```

### **Rate Limiting:**
- ✅ 60 requests per minute default
- ✅ 1000 requests per day default
- ✅ Configurable via Firestore document
- ✅ Graceful degradation on limit reached

## 🚀 **Implementation Checklist**

### **Core Development:**
- [ ] Create `tools/googleMapsPlaces.js` extending BaseTool
- [ ] Implement 2025 Google Places API client integration
- [ ] Add KML knowledge base search functionality
- [ ] Implement Gemini analysis for geographic data
- [ ] Create comprehensive response formatting
- [ ] Add triple fallback strategy (KML → Web → Basic)

### **Configuration:**
- [x] Create Firestore `tool-settings/GoogleMapsPlaces` document
- [ ] Add environment variable validation
- [ ] Implement rate limiting and error handling
- [ ] Add API key loading from Firestore

### **Integration:**
- [ ] Connect with existing KnowledgeManagement tool (priority 100)
- [ ] Chain with WebSearch tool (priority 80) for fallback
- [ ] Test with Sample Event KML data
- [ ] Verify tool priority ordering (68)

### **Testing:**
- [ ] Unit tests for tool triggers and responses
- [ ] Integration tests with KML knowledge base
- [ ] Test AI-powered summary generation
- [ ] Verify comprehensive guide formatting
- [ ] Test all fallback scenarios

## 🎉 **Expected Outcomes**

### **User Experience:**
- ✅ Rich, comprehensive location guides
- ✅ AI-enhanced summaries and insights  
- ✅ Recent, user-submitted information priority
- ✅ Seamless integration with existing KML knowledge
- ✅ Intelligent fallback to web search when needed

### **Technical Benefits:**
- ✅ Modern 2025 Google Places API implementation
- ✅ Secure Firestore-based configuration
- ✅ Robust error handling and fallbacks
- ✅ AI-powered content enhancement
- ✅ Rate limiting and cost management

---

**Creation Date**: October 7, 2025  
**Status**: Ready for Implementation  
**Priority**: High  
**Estimated Development Time**: 4-6 hours  

## 📝 **Notes**
- Implementation should focus on comprehensive, recent information
- AI summaries must include proper Google attribution
- Tool should work seamlessly with existing Chantilly personality and response style
- Consider March 2025 pricing changes in usage monitoring