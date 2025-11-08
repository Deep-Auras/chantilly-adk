#!/usr/bin/env node

/**
 * Script to add knowledge base documents to Firestore
 * Usage: node scripts/addKBToDb.js <knowledge-base-file>
 * Example: node scripts/addKBToDb.js examples/knowledgeBase/bitrix24ApiIntegration.js
 */

const path = require('path');
const { initializeFirestore, getFirestore, getFieldValue } = require('../config/firestore');

let db;

async function addKnowledgeBaseDocument(kbFile) {
  try {
    console.log('🔄 Loading knowledge base document from:', kbFile);
    
    // Import the knowledge base file
    const kbPath = path.resolve(kbFile);
    if (!require('fs').existsSync(kbPath)) {
      throw new Error(`Knowledge base file not found: ${kbPath}`);
    }
    
    const kbModule = require(kbPath);
    
    // Extract knowledge base entries
    let entries;
    if (kbModule.knowledgeBaseEntries) {
      entries = kbModule.knowledgeBaseEntries;
    } else if (Array.isArray(kbModule)) {
      entries = kbModule;
    } else {
      throw new Error('Knowledge base file must export knowledgeBaseEntries array or be an array itself');
    }
    
    console.log('📋 Knowledge base entries loaded:');
    console.log(`   Found: ${entries.length} entries`);
    
    // Process each entry
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      
      if (!entry.title || !entry.content) {
        throw new Error(`Entry ${i + 1} must have title and content fields`);
      }
      
      console.log(`\n📄 Processing entry ${i + 1}:`);
      console.log('   Title:', entry.title);
      console.log('   Category:', entry.category || 'general');
      console.log('   Priority:', entry.priority || 50);
      console.log('   Tags:', entry.tags?.join(', ') || 'none');
      console.log('   Search Terms:', entry.searchTerms?.length || 0);
      console.log('   Content Length:', entry.content.length, 'characters');
      
      // Prepare entry for Firestore
      const FieldValue = getFieldValue();
      const firestoreEntry = {
        title: entry.title,
        content: entry.content,
        category: entry.category || 'general',
        tags: entry.tags || [],
        searchTerms: entry.searchTerms || [],
        priority: entry.priority || 50,
        enabled: entry.enabled !== undefined ? entry.enabled : true,
        // Add Firestore timestamps
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: 'system'
      };
      
      // Generate document ID from title
      const docId = entry.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      
      console.log('   Document ID:', docId);
      
      // Add to Firestore
      console.log('   📤 Adding to Firestore...');
      
      const docRef = db.collection('knowledge-base').doc(docId);
      await docRef.set(firestoreEntry);
      
      console.log('   ✅ Entry added successfully!');
    }
    
    console.log(`\n🎉 All ${entries.length} knowledge base entries added successfully!`);
    
    // Verify entries were added
    console.log('\n🔍 Verifying entries in Firestore...');
    const snapshot = await db.collection('knowledge-base').get();
    
    console.log(`✅ Verification complete! Found ${snapshot.size} total entries in knowledge base.`);
    
    // Show added entries
    console.log('\n📊 Knowledge base entries added:');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const docId = entry.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      
      console.log(`   ${i + 1}. ${entry.title}`);
      console.log(`      - Category: ${entry.category || 'general'}`);
      console.log(`      - Priority: ${entry.priority || 50}`);
      console.log(`      - Enabled: ${entry.enabled !== undefined ? entry.enabled : true}`);
      console.log(`      - Document ID: ${docId}`);
      
      if (entry.category === 'system_information') {
        console.log('      - 🔒 SYSTEM ONLY: Hidden from user access, high priority for AI');
      }
    }
    
    console.log('\n💡 Knowledge base entries are now available to Chantilly Agent!');
    console.log('   - Entries will be searchable within 5 minutes (cache refresh)');
    console.log('   - System information entries are prioritized for AI responses');
    console.log('   - Use the KnowledgeManagement tool to search and manage entries');
    
  } catch (error) {
    console.error('❌ Error adding knowledge base:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

async function listExistingKnowledgeBase() {
  try {
    console.log('📋 Checking existing knowledge base...\n');
    
    const snapshot = await db.collection('knowledge-base').get();
    
    if (snapshot.empty) {
      console.log('📭 No knowledge base entries found in Firestore');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} existing knowledge base entries:\n`);
    
    const entries = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      entries.push({
        id: doc.id,
        title: data.title,
        category: data.category,
        priority: data.priority,
        enabled: data.enabled,
        createdAt: data.createdAt,
        tags: data.tags,
        contentLength: data.content?.length || 0
      });
    });
    
    // Sort by priority (highest first), then by title
    entries.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.title.localeCompare(b.title);
    });
    
    entries.forEach((entry, index) => {
      console.log(`${index + 1}. ${entry.title}`);
      console.log(`   ID: ${entry.id}`);
      console.log(`   Category: ${entry.category || 'general'}`);
      console.log(`   Priority: ${entry.priority || 50} ${entry.priority >= 90 ? '(HIGH)' : entry.priority >= 70 ? '(MEDIUM)' : '(LOW)'}`);
      console.log(`   Enabled: ${entry.enabled}`);
      console.log(`   Content: ${entry.contentLength} characters`);
      console.log(`   Tags: ${entry.tags?.join(', ') || 'none'}`);
      
      if (entry.category === 'system_information') {
        console.log('   🔒 SYSTEM ONLY: Hidden from users, AI priority');
      }
      
      if (entry.createdAt?.toDate) {
        console.log(`   Created: ${entry.createdAt.toDate().toISOString()}`);
      }
      console.log('');
    });
    
  } catch (error) {
    console.error('❌ Error listing knowledge base:', error.message);
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  console.log('🚀 Knowledge Base Database Installer\n');

  // Initialize Firestore first
  await initializeFirestore();
  db = getFirestore();

  if (args.length === 0) {
    console.log('Usage: node scripts/addKBToDb.js <knowledge-base-file>');
    console.log('Example: node scripts/addKBToDb.js examples/knowledgeBase/bitrix24ApiIntegration.js');
    console.log('\n📋 Checking existing knowledge base...\n');
    await listExistingKnowledgeBase();
    process.exit(0);
  }

  const kbFile = args[0];

  // First check existing entries
  await listExistingKnowledgeBase();

  // Add the specified knowledge base
  await addKnowledgeBaseDocument(kbFile);

  process.exit(0);
}

// Error handling
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  process.exit(1);
});

main().catch(console.error);