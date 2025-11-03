# Google My Maps Integration (Option C) - Implementation Plan

## Overview

This document outlines the implementation strategy for integrating Google My Maps with Chantilly's knowledge base system. This approach leverages your team's existing Google My Maps expertise while providing powerful automation through Chantilly's AI capabilities.

## Architecture Overview

### Core APIs Required
- **Google My Maps API** (part of Google Drive API v3)
- **Google Drive API** for file management
- **KML/KMZ generation** from knowledge base documents

### Authentication Setup
```javascript
// Add to existing Google Cloud configuration
const { google } = require('googleapis');
const drive = google.drive('v3');

// OAuth 2.0 scopes needed
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/maps'
];
```

## Implementation Plan

### Phase 1: Knowledge Base Schema Enhancement

**Enhanced Knowledge Base Schema:**
```javascript
// Extend existing knowledge-base documents
{
  title: "Sample Event NYC 2025",
  content: "Event description...",
  category: "events",
  mapData: {
    type: "route", // route, points, areas
    coordinates: [
      { lat: 40.7389, lng: -73.9883, name: "Gramercy Park" },
      { lat: 40.7505, lng: -73.9934, name: "Madison Square Park" }
    ],
    kmlContent: "<kml>...</kml>", // Generated KML
    myMapsId: "1BvR...", // Google My Maps ID after creation
    shareableUrl: "https://mymaps.google.com/...",
    editUrl: "https://mymaps.google.com/maps/d/edit?mid=...",
    lastSynced: "timestamp"
  }
}
```

### Phase 2: KML Generator Tool

**New Tool: `tools/googleMyMapsKML.js`**
```javascript
class GoogleMyMapsKMLTool extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'GoogleMyMapsKML';
    this.description = 'Generate and manage Google My Maps from knowledge base content';
    this.priority = 75; // After knowledge search, before web search
  }

  async generateKMLFromDocument(document) {
    // Extract coordinates from document content
    const coordinates = this.extractCoordinates(document.content);
    
    // Generate KML based on document type
    const kml = this.buildKML({
      title: document.title,
      description: document.content.substring(0, 500),
      coordinates: coordinates,
      category: document.category
    });
    
    return kml;
  }

  buildKML({ title, description, coordinates, category }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${title}</name>
    <description>${description}</description>
    ${coordinates.map(coord => this.createPlacemark(coord)).join('\n')}
  </Document>
</kml>`;
  }

  createPlacemark(coordinate) {
    return `
    <Placemark>
      <name>${coordinate.name}</name>
      <description>${coordinate.description || ''}</description>
      <Point>
        <coordinates>${coordinate.lng},${coordinate.lat},0</coordinates>
      </Point>
    </Placemark>`;
  }
}
```

### Phase 3: Google My Maps Creation Workflow

**Automated My Maps Creation:**
```javascript
async createMyMap(kmlContent, title, description) {
  try {
    // Step 1: Create KML file in Google Drive
    const kmlFile = await drive.files.create({
      requestBody: {
        name: `${title}.kml`,
        parents: ['your-maps-folder-id']
      },
      media: {
        mimeType: 'application/vnd.google-earth.kml+xml',
        body: kmlContent
      }
    });

    // Step 2: Import KML into Google My Maps
    const myMap = await this.importToMyMaps(kmlFile.data.id, title, description);
    
    // Step 3: Update knowledge base with My Maps reference
    await this.updateKnowledgeBaseWithMapData(documentId, {
      myMapsId: myMap.id,
      shareableUrl: myMap.url,
      editUrl: myMap.editUrl,
      kmlFileId: kmlFile.data.id
    });

    return {
      success: true,
      myMapsUrl: myMap.url,
      editUrl: myMap.editUrl,
      embedUrl: myMap.embedUrl
    };
  } catch (error) {
    this.log('error', 'Failed to create My Maps', { error: error.message });
    throw error;
  }
}
```

### Phase 4: End-User Handoff Workflow

**Seamless Handoff Process:**
1. **Chantilly generates KML** from knowledge base content
2. **Auto-creates Google My Maps** with proper sharing permissions
3. **Shares edit link** with product owners/end users
4. **Monitors changes** and optionally syncs back to knowledge base

**Permissions Management:**
```javascript
async shareMyMapWithTeam(myMapsId, teamEmails) {
  // Share with edit permissions for product owners
  for (const email of teamEmails) {
    await drive.permissions.create({
      fileId: myMapsId,
      requestBody: {
        role: 'writer', // Edit permissions
        type: 'user',
        emailAddress: email
      }
    });
  }
  
  // Create shareable link for broader team
  await drive.permissions.create({
    fileId: myMapsId,
    requestBody: {
      role: 'reader',
      type: 'anyone'
    }
  });
}
```

### Phase 5: Bi-Directional Sync Implementation

**Knowledge Base → My Maps:**
```javascript
async syncKnowledgeToMyMaps(documentId) {
  const document = await this.getKnowledgeDocument(documentId);
  
  if (document.mapData?.myMapsId) {
    // Update existing My Maps
    await this.updateMyMapsContent(document.mapData.myMapsId, document);
  } else {
    // Create new My Maps
    const myMapsResult = await this.createMyMap(
      this.generateKMLFromDocument(document),
      document.title,
      document.content
    );
    
    // Update knowledge base with My Maps reference
    await this.updateKnowledgeBaseWithMapData(documentId, myMapsResult);
  }
}
```

**My Maps → Knowledge Base (Optional):**
```javascript
async syncMyMapsToKnowledge(myMapsId) {
  // Download current KML from My Maps
  const kmlContent = await this.downloadKMLFromMyMaps(myMapsId);
  
  // Parse changes and update knowledge base
  const updates = this.parseKMLChanges(kmlContent);
  
  // Update knowledge base document
  await this.updateKnowledgeDocument(documentId, updates);
}
```

### Phase 6: Integration with Existing Chantilly Tools

**Enhanced GoogleMapsPlaces Integration:**
```javascript
// In tools/googleMapsPlaces.js
async execute(params, toolContext) {
  // ... existing place search logic ...
  
  // Check if results should be saved to My Maps
  if (params.saveToMyMaps || toolContext.message.includes('create map')) {
    const kmlTool = toolContext.tools.find(t => t.name === 'GoogleMyMapsKML');
    
    const myMapsResult = await kmlTool.createMyMapFromPlaces({
      places: results.places,
      title: `Places near ${location}`,
      searchQuery: params.location
    });
    
    response += `\n\n📍 **Google My Maps Created:**\n`;
    response += `• [View Map](${myMapsResult.shareableUrl})\n`;
    response += `• [Edit Map](${myMapsResult.editUrl})\n`;
  }
  
  return response;
}
```

**Knowledge Management Tool Enhancement:**
```javascript
// In tools/knowledgeManagement.js
async addDocument(params, messageData) {
  // ... existing document creation logic ...
  
  // Auto-detect if content contains map-worthy information
  if (this.containsGeographicContent(params.content)) {
    const kmlTool = this.getToolByName('GoogleMyMapsKML');
    
    // Generate My Maps automatically
    const myMapsResult = await kmlTool.createMyMapFromContent({
      title: params.title,
      content: params.content,
      documentId: docRef.id
    });
    
    // Update document with map reference
    await docRef.update({
      mapData: {
        myMapsId: myMapsResult.myMapsId,
        shareableUrl: myMapsResult.shareableUrl,
        editUrl: myMapsResult.editUrl
      }
    });
  }
}
```

## User Interface & Commands

### Natural Language Commands
```javascript
shouldTrigger(message) {
  const triggers = [
    /create.*map.*from.*knowledge/i,
    /generate.*my.*maps/i,
    /make.*google.*map/i,
    /export.*to.*my.*maps/i,
    /share.*map.*with.*team/i,
    /update.*my.*maps/i,
    /sync.*map.*changes/i
  ];
  
  return triggers.some(trigger => trigger.test(message));
}
```

### Example Usage Scenarios

**Scenario 1: Create Map from Knowledge Base**
```
User: "Create a Google My Maps from the Sample Event event"
Chantilly: ✅ Google My Maps created! 
• View: https://mymaps.google.com/maps/d/1BvR...
• Edit: https://mymaps.google.com/maps/d/edit?mid=1BvR...
• Shared with: team@company.com (edit access)
```

**Scenario 2: Update Existing Map**
```
User: "Update the walk route map with new checkpoints"
Chantilly: ✅ My Maps updated with latest route information!
• 3 new checkpoints added
• Route optimized for accessibility
• Team notified of changes
```

**Scenario 3: Generate Map from Places Search**
```
User: "Find restaurants in Gramercy Park and create a map"
Chantilly: Found 12 restaurants in Gramercy Park area.

📍 **Google My Maps Created:**
• [View Map](https://mymaps.google.com/maps/d/1BvR...)
• [Edit Map](https://mymaps.google.com/maps/d/edit?mid=1BvR...)

Your team can now edit this map and add custom information!
```

## Benefits Analysis

### For End Users & Product Owners
- **Familiar Interface**: No learning curve - they already use Google My Maps
- **Easy Editing**: Point-and-click editing with Google's intuitive interface
- **Real-time Collaboration**: Multiple team members can edit simultaneously
- **Mobile Access**: Google My Maps mobile app for field updates
- **Rich Features**: Layers, custom icons, directions, street view integration

### For Chantilly System
- **Automated Generation**: KML created from knowledge base content
- **Seamless Handoff**: One-click sharing with proper permissions
- **Sync Capabilities**: Changes can flow back to knowledge base
- **Integration**: Works with existing GoogleMapsPlaces and KnowledgeManagement tools

### For Development Team
- **Google APIs**: Well-documented, stable APIs
- **No Custom UI**: Leverage Google's mapping interface
- **Scalable**: Google's infrastructure handles all hosting/performance
- **Maintenance**: Minimal ongoing maintenance vs custom solutions

## Implementation Timeline

### Phase 1: Foundation (Week 1-2)
- [ ] Set up Google My Maps API authentication
- [ ] Extend knowledge base schema for map data
- [ ] Create basic KML generation utilities

### Phase 2: Core Tool Development (Week 3-4)
- [ ] Implement GoogleMyMapsKML tool
- [ ] Add coordinate extraction from text content
- [ ] Implement basic My Maps creation workflow

### Phase 3: Integration (Week 5-6)
- [ ] Integrate with existing GoogleMapsPlaces tool
- [ ] Enhance KnowledgeManagement tool with map detection
- [ ] Add natural language command processing

### Phase 4: Team Handoff Features (Week 7-8)
- [ ] Implement permissions management
- [ ] Add team sharing capabilities
- [ ] Create sync monitoring system

### Phase 5: Testing & Optimization (Week 9-10)
- [ ] End-to-end testing with real use cases
- [ ] Performance optimization
- [ ] Documentation and team training

## Technical Requirements

### Environment Variables
```bash
# Add to .env
GOOGLE_MAPS_API_KEY=your_existing_key
GOOGLE_DRIVE_CLIENT_ID=your_oauth_client_id
GOOGLE_DRIVE_CLIENT_SECRET=your_oauth_secret
GOOGLE_DRIVE_FOLDER_ID=your_maps_folder_id
TEAM_EMAILS=email1@company.com,email2@company.com
```

### Dependencies
```json
{
  "googleapis": "^118.0.0",
  "xml2js": "^0.6.2",
  "fast-xml-parser": "^4.3.2"
}
```

### File Structure
```
tools/
├── googleMyMapsKML.js          # New KML generation tool
├── googleMapsPlaces.js         # Enhanced with My Maps integration
└── knowledgeManagement.js      # Enhanced with map detection

lib/
├── kmlGenerator.js             # KML utilities
├── myMapsAPI.js               # Google My Maps API wrapper
└── geoUtils.js                # Geographic coordinate utilities

config/
└── googleMaps.js              # Enhanced configuration
```

This implementation plan provides a comprehensive roadmap for integrating Google My Maps with Chantilly's knowledge base, enabling seamless handoffs between AI-generated content and human team collaboration.