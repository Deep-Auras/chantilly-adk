/**
 * Create Morgan Workflow Sections in Asana Project
 *
 * Phase 13: Automate creation of required Asana sections for Morgan workflow
 *
 * Usage:
 * ASANA_ACCESS_TOKEN=<your-pat> \
 * ASANA_WORKSPACE_GID=<workspace-gid> \
 * node scripts/createAsanaSections.js <project-gid>
 *
 * Example:
 * ASANA_ACCESS_TOKEN=0/abcd1234... \
 * ASANA_WORKSPACE_GID=1234567890 \
 * node scripts/createAsanaSections.js 9876543210
 */

const asana = require('asana');
const { logger } = require('../utils/logger');

// Morgan Workflow Sections
const REQUIRED_SECTIONS = [
  {
    name: 'Morgan - Planning Complete',
    description: 'Move tasks here to trigger Morgan execution'
  },
  {
    name: 'Morgan - Task Completed',
    description: 'Tasks that completed successfully'
  },
  {
    name: 'Morgan - Task Failed',
    description: 'Tasks that failed execution'
  },
  {
    name: 'Morgan - Try Again',
    description: 'Move failed tasks here to retry with modifications'
  }
];

async function createAsanaSections(projectGid) {
  if (!projectGid) {
    throw new Error('Project GID is required');
  }

  if (!process.env.ASANA_ACCESS_TOKEN) {
    throw new Error('ASANA_ACCESS_TOKEN environment variable is required');
  }

  try {
    // Initialize Asana client
    const client = asana.ApiClient.instance;
    const token = client.authentications['token'];
    token.accessToken = process.env.ASANA_ACCESS_TOKEN;

    const sectionsApi = new asana.SectionsApi();
    const projectsApi = new asana.ProjectsApi();

    logger.info('Fetching project details', { projectGid });

    // Get project details
    const projectResult = await projectsApi.getProject(projectGid, {});
    const project = projectResult.data;

    console.log('\n📋 Project Information');
    console.log('====================');
    console.log(`Name: ${project.name}`);
    console.log(`GID: ${project.gid}`);
    console.log(`Workspace: ${project.workspace?.name || 'Unknown'}\n`);

    // Get existing sections
    const sectionsResult = await sectionsApi.getSectionsForProject(projectGid, {});
    const existingSections = sectionsResult.data;

    logger.info('Found existing sections', { count: existingSections.length });

    console.log('Existing Sections:');
    existingSections.forEach(s => console.log(`  - ${s.name}`));
    console.log('');

    // Create Morgan sections
    console.log('Creating Morgan Workflow Sections...');
    console.log('====================================\n');

    const createdSections = [];
    const skippedSections = [];

    for (const sectionConfig of REQUIRED_SECTIONS) {
      // Check if section already exists
      const existing = existingSections.find(
        s => s.name.toLowerCase() === sectionConfig.name.toLowerCase()
      );

      if (existing) {
        console.log(`⏩ Skipping: "${sectionConfig.name}" (already exists)`);
        skippedSections.push(sectionConfig.name);
        continue;
      }

      // Create section
      const body = {
        data: {
          name: sectionConfig.name
        }
      };

      const result = await sectionsApi.createSectionForProject(body, projectGid, {});
      const section = result.data;

      console.log(`✅ Created: "${sectionConfig.name}"`);
      console.log(`   GID: ${section.gid}`);
      console.log(`   Purpose: ${sectionConfig.description}\n`);

      createdSections.push(sectionConfig.name);
      logger.info('Created section', {
        name: sectionConfig.name,
        gid: section.gid,
        projectGid
      });
    }

    // Summary
    console.log('\n📊 Summary');
    console.log('===========');
    console.log(`✅ Created: ${createdSections.length} sections`);
    console.log(`⏩ Skipped: ${skippedSections.length} sections (already exist)`);
    console.log('');

    if (createdSections.length > 0) {
      console.log('Created Sections:');
      createdSections.forEach(name => console.log(`  - ${name}`));
      console.log('');
    }

    if (skippedSections.length > 0) {
      console.log('Skipped Sections:');
      skippedSections.forEach(name => console.log(`  - ${name}`));
      console.log('');
    }

    console.log('✅ Morgan workflow sections setup complete!');
    console.log('\nNext Steps:');
    console.log('  1. Create a task in Asana with subtasks (steps)');
    console.log('  2. Move task to "Morgan - Planning Complete" section');
    console.log('  3. Morgan will execute the task automatically');
    console.log('  4. Task will move to "Task Completed" or "Task Failed" section');
    console.log('  5. If failed, update the task and move to "Try Again" section\n');

    process.exit(0);
  } catch (error) {
    logger.error('Failed to create Asana sections', {
      error: error.message,
      stack: error.stack
    });
    console.error('\n❌ Error:', error.message);
    if (error.response) {
      console.error('API Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

// Get project GID from command line
const projectGid = process.argv[2];

if (!projectGid) {
  console.error('❌ Error: Project GID required\n');
  console.log('Usage:');
  console.log('  ASANA_ACCESS_TOKEN=<your-pat> node scripts/createAsanaSections.js <project-gid>\n');
  console.log('How to get Project GID:');
  console.log('  1. Open your project in Asana');
  console.log('  2. Copy project GID from URL: https://app.asana.com/0/1234567890/...');
  console.log('  3. The project GID is the first number after "/0/"');
  console.log('\nExample:');
  console.log('  ASANA_ACCESS_TOKEN=0/abcd1234... node scripts/createAsanaSections.js 9876543210\n');
  process.exit(1);
}

createAsanaSections(projectGid);
