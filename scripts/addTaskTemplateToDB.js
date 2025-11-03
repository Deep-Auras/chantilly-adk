#!/usr/bin/env node

/**
 * Script to add task templates to Firestore
 * Usage: node scripts/addTaskTemplateToDB.js <template-file>
 * Example: node scripts/addTaskTemplateToDB.js examples/bitrixOpenInvoicesTemplate.js
 */

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin with service account
const serviceAccount = require('../service_account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore('chantilly-agent-${AGENT_NAME}');

async function addTaskTemplate(templateFile) {
  try {
    console.log('🔄 Loading task template from:', templateFile);
    
    // Import the template
    const templatePath = path.resolve(templateFile);
    if (!require('fs').existsSync(templatePath)) {
      throw new Error(`Template file not found: ${templatePath}`);
    }
    
    const templateModule = require(templatePath);
    
    // Extract template from module (handle different export patterns)
    let template;
    if (templateModule.bitrixOpenInvoicesTemplate) {
      template = templateModule.bitrixOpenInvoicesTemplate;
    } else if (templateModule.template) {
      template = templateModule.template;
    } else if (templateModule.default) {
      template = templateModule.default;
    } else {
      template = templateModule;
    }
    
    if (!template.templateId) {
      throw new Error('Template must have a templateId field');
    }
    
    console.log('📋 Template loaded:');
    console.log('   Name:', template.name);
    console.log('   ID:', template.templateId);
    console.log('   Version:', template.version);
    console.log('   Categories:', Array.isArray(template.category) ? template.category.join(', ') : template.category);
    console.log('   Enabled:', template.enabled);
    
    // Prepare template for Firestore (convert RegExp to strings)
    const firestoreTemplate = {
      ...template,
      // Convert RegExp patterns to strings for Firestore storage
      triggers: template.triggers ? {
        ...template.triggers,
        patterns: template.triggers.patterns ? 
          template.triggers.patterns.map(pattern => 
            pattern instanceof RegExp ? pattern.source : pattern.toString()
          ) : template.triggers.patterns
      } : template.triggers,
      // Add Firestore timestamps
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    
    // Add to Firestore
    console.log('\n📤 Adding template to Firestore...');
    
    const docRef = db.collection('task-templates').doc(template.templateId);
    await docRef.set(firestoreTemplate);
    
    console.log('✅ Template added successfully!');
    console.log('🆔 Document ID:', template.templateId);
    console.log('🔗 Collection: task-templates');
    
    // Verify the template was added
    console.log('\n🔍 Verifying template in Firestore...');
    const addedDoc = await docRef.get();
    
    if (addedDoc.exists) {
      const data = addedDoc.data();
      console.log('✅ Verification successful!');
      console.log('\n📊 Template details:');
      console.log('   - Name:', data.name);
      console.log('   - Categories:', data.category?.join(', ') || 'None');
      console.log('   - Enabled:', data.enabled);
      console.log('   - Priority:', data.priority);
      console.log('   - Trigger Patterns:', data.triggers?.patterns?.length || 0);
      console.log('   - Keywords:', data.triggers?.keywords?.length || 0);
      console.log('   - Estimated Steps:', data.definition?.estimatedSteps);
      console.log('   - Estimated Duration:', data.definition?.estimatedDuration ? `${Math.round(data.definition.estimatedDuration / 1000 / 60)} minutes` : 'Unknown');
      console.log('   - Required Services:', data.definition?.requiredServices?.join(', ') || 'None');
      console.log('   - Script Length:', data.executionScript?.length || 0, 'characters');
      
      console.log('\n🎯 Auto-detection triggers:');
      if (data.triggers?.patterns) {
        data.triggers.patterns.forEach((pattern, index) => {
          console.log(`   ${index + 1}. ${pattern}`);
        });
      }
      
      console.log('\n🏷️  Keywords:', data.triggers?.keywords?.join(', ') || 'None');
      
    } else {
      console.error('❌ Verification failed: Template not found in Firestore');
      process.exit(1);
    }
    
    console.log(`\n🎉 ${template.name} template is ready for use!`);
    console.log('\n💡 Test commands for Chantilly:');
    console.log('   - "Generate a report of all open invoices"');
    console.log('   - "Create open invoice report"');
    console.log('   - "Show me outstanding invoices"');
    console.log('   - "Bitrix invoice report"');
    
  } catch (error) {
    console.error('❌ Error adding template:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

async function listExistingTemplates() {
  try {
    console.log('📋 Checking existing templates...\n');
    
    const snapshot = await db.collection('task-templates').get();
    
    if (snapshot.empty) {
      console.log('📭 No templates found in Firestore');
      return;
    }
    
    console.log(`📊 Found ${snapshot.size} existing template(s):\n`);
    
    snapshot.forEach(doc => {
      const data = doc.data();
      console.log(`🔹 ${data.name || doc.id}`);
      console.log(`   ID: ${doc.id}`);
      console.log(`   Categories: ${Array.isArray(data.category) ? data.category.join(', ') : data.category || 'Unknown'}`);
      console.log(`   Enabled: ${data.enabled}`);
      console.log(`   Priority: ${data.priority || 50}`);
      if (data.createdAt?.toDate) {
        console.log(`   Created: ${data.createdAt.toDate().toISOString()}`);
      }
      console.log('');
    });
    
  } catch (error) {
    console.error('❌ Error listing templates:', error.message);
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  console.log('🚀 Task Template Database Installer\n');
  
  if (args.length === 0) {
    console.log('Usage: node scripts/addTaskTemplateToDB.js <template-file>');
    console.log('Example: node scripts/addTaskTemplateToDB.js examples/bitrixOpenInvoicesTemplate.js');
    console.log('\n📋 Checking existing templates...\n');
    await listExistingTemplates();
    process.exit(0);
  }
  
  const templateFile = args[0];
  
  // First check existing templates
  await listExistingTemplates();
  
  // Add the specified template
  await addTaskTemplate(templateFile);
  
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