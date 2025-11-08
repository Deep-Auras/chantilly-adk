/**
 * Create Complex Tasks Guide - Comprehensive Knowledge Base for Agentic Task Creation
 * 
 * This knowledge base provides Gemini AI with comprehensive instructions for agentically
 * creating complex tasks that integrate with Bitrix24 APIs, generate useful HTML reports,
 * and execute safely in Cloud Tasks environment.
 */

const complexTaskCreationGuide = `# ONE-SHOT PROMPT: Complex Task Creation for Gemini AI

**CONTEXT: You are Gemini AI creating complex task templates for Chantilly Agent. Follow this EXACT pattern from the working example below.**

## 🎯 ONE-SHOT LEARNING PATTERN

**USER REQUEST → FOLLOW THIS EXACT TEMPLATE STRUCTURE**

When user requests a complex task (reports, analysis, multi-step workflows), generate a template using the COMPLETE WORKING EXAMPLE as your guide. Do NOT deviate from this proven pattern.

## 🚨 CRITICAL VALIDATION REQUIREMENTS - READ FIRST

**EVERY EXECUTION SCRIPT MUST INCLUDE THESE 4 MANDATORY METHODS OR VALIDATION WILL FAIL:**

1. **\`this.generateHTMLReport(reportData, options)\`** - ABSOLUTELY MANDATORY custom method (MUST implement your own HTML generation)
2. **\`await this.updateProgress(percent, message)\`** - REQUIRED for progress tracking
3. **\`await this.callAPI(method, params)\`** - REQUIRED for all Bitrix24 API calls
4. **\`this.log(level, message, data)\`** - REQUIRED instead of console.log or logger

**⚠️ AI VALIDATION WARNING**: Templates missing any of these methods will be automatically rejected. These are validation requirements, not suggestions.

### 📋 VALIDATION CHECKLIST FOR AI

Before submitting any execution script, verify ALL of these are included:

- [ ] **\`this.generateHTMLReport()\`** method implemented and called in execute() - CUSTOM IMPLEMENTATION REQUIRED
- [ ] **\`await this.updateProgress()\`** called at least 3 times during execution
- [ ] **\`await this.callAPI()\`** or **\`await this.streamingFetch()\`** used for all API calls
- [ ] **\`this.log()\`** used for logging (never console.log or direct logger imports)

## 🚨 CRITICAL: HTML RENDERING & ACTIVITY FETCHING ANTI-PATTERNS

### ❌ ANTI-PATTERN 1: Missing HTML-Level Array Limiting

**PROBLEM: Relying only on API \\\`limit\\\` parameter is UNRELIABLE in Bitrix24!**

**WRONG - Missing .slice() in HTML rendering:**
\\\`\\\`\\\`javascript
generateHTMLReport(reportData, params) {
  return \\\`
    <div>
      <h4>Recent Activities</h4>
      <ul>
        \\\${entity.activities.map(a => \\\`<li>\\\${a.SUBJECT}</li>\\\`).join('')}
      </ul>
    </div>
  \\\`;
}
\\\`\\\`\\\`

**✅ CORRECT - Double-limiting (API + HTML):**
\\\`\\\`\\\`javascript
generateHTMLReport(reportData, params) {
  return \\\`
    <div>
      <h4>Recent Activities</h4>
      <ul>
        \\\${entity.activities.slice(0, 4).map(a => \\\`<li>\\\${a.SUBJECT}</li>\\\`).join('')}
      </ul>
    </div>
  \\\`;
}
\\\`\\\`\\\`

**Why Both Limits Are Required:**
1. Bitrix24 API \\\`limit\\\` parameter is unreliable (often returns more than requested)
2. HTML MUST ALWAYS explicitly limit displayed items with \\\`.slice(0, N)\\\`
3. Prevents displaying 20+ activities when user expects 4
4. User reported bug: "activities are still not limited to the last 4 recent entries" - caused by missing .slice()

### ❌ ANTI-PATTERN 2: Fetching Activities from Single Owner Only

**PROBLEM: In aggregate reports (Best Customers, Top Companies), entities have BOTH company AND contact relationships that must be checked!**

**WRONG - Only fetching from current entity type:**
\\\`\\\`\\\`javascript
async enrichEntities(entities, type) {
  const isCompany = type === 'company';

  for (const entity of entities) {
    // ❌ WRONG: Only fetches from company OR contact, not both
    const activities = await this.fetchActivities(entity.id, isCompany ? 4 : 3);
    enriched.push({ ...entity, activities });
  }
}

async fetchActivities(ownerId, ownerTypeId) {
  const response = await this.callAPI('crm.activity.list', {
    filter: { OWNER_ID: ownerId, OWNER_TYPE_ID: ownerTypeId },
    order: { 'DATE_TIME': 'DESC' },
    select: ['SUBJECT', 'DESCRIPTION', 'DATE_TIME'],
    limit: 4  // ❌ Also missing start: 0
  });
  return response?.result || [];
}
\\\`\\\`\\\`

**✅ CORRECT - Fetching from BOTH company AND contact:**
\\\`\\\`\\\`javascript
async enrichEntities(entities, type) {
  const isCompany = type === 'company';
  const enriched = [];

  for (const entity of entities) {
    await this.checkCancellation();

    // ✅ CORRECT: Fetch activities from BOTH sources
    let allActivities = [];

    // Fetch from primary entity (company or contact)
    try {
      const primaryActivities = await this.callAPI('crm.activity.list', {
        filter: {
          'OWNER_TYPE_ID': isCompany ? 4 : 3,
          'OWNER_ID': entity.id
        },
        select: [
          'ID', 'TYPE_ID', 'SUBJECT', 'DESCRIPTION', 'DIRECTION',
          'DATE_TIME', 'CREATED', 'AUTHOR_ID', 'RESPONSIBLE_ID',
          'RESULT_STATUS', 'RESULT_TEXT'
        ],
        order: { 'DATE_TIME': 'DESC' },
        start: 0,  // ✅ REQUIRED: Start from beginning
        limit: 50  // ✅ Fetch more than needed, limit later
      });

      if (primaryActivities?.result) {
        allActivities = allActivities.concat(primaryActivities.result);
      }
    } catch (error) {
      this.log('warn', 'Failed to fetch primary activities', {
        entityId: entity.id,
        error: error.message
      });
    }

    // ✅ CRITICAL: Also fetch from related entity if available
    // For companies, check if they have related contacts
    // For contacts, check if they have related companies
    if (entity.invoiceIds && entity.invoiceIds.length > 0) {
      // Get first invoice to find related entity
      const firstInvoiceId = entity.invoiceIds[0];
      try {
        const invoiceDetails = await this.callAPI('crm.invoice.get', {
          id: firstInvoiceId
        });

        const relatedId = isCompany
          ? invoiceDetails?.result?.UF_CONTACT_ID
          : invoiceDetails?.result?.UF_COMPANY_ID;

        if (relatedId && relatedId !== '0') {
          const relatedActivities = await this.callAPI('crm.activity.list', {
            filter: {
              'OWNER_TYPE_ID': isCompany ? 3 : 4,
              'OWNER_ID': relatedId
            },
            select: [
              'ID', 'TYPE_ID', 'SUBJECT', 'DESCRIPTION', 'DIRECTION',
              'DATE_TIME', 'CREATED', 'AUTHOR_ID', 'RESPONSIBLE_ID',
              'RESULT_STATUS', 'RESULT_TEXT'
            ],
            order: { 'DATE_TIME': 'DESC' },
            start: 0,
            limit: 50
          });

          if (relatedActivities?.result) {
            allActivities = allActivities.concat(relatedActivities.result);
          }
        }
      } catch (error) {
        this.log('warn', 'Failed to fetch related activities', { error: error.message });
      }
    }

    // ✅ CRITICAL: Sort combined activities and limit
    if (allActivities.length > 0) {
      allActivities.sort((a, b) => new Date(b.DATE_TIME) - new Date(a.DATE_TIME));
      allActivities = allActivities.slice(0, 4);
    }

    enriched.push({
      ...entity,
      name: entity.name,
      activities: allActivities
    });
  }

  return enriched;
}
\\\`\\\`\\\`

### Required Activity API Parameters Checklist

**ALWAYS include ALL of these in crm.activity.list calls:**

\\\`\\\`\\\`javascript
await this.callAPI('crm.activity.list', {
  filter: {
    'OWNER_TYPE_ID': 4,        // ✅ REQUIRED: 1=Lead, 2=Deal, 3=Contact, 4=Company
    'OWNER_ID': entityId       // ✅ REQUIRED: Entity ID
  },
  select: [
    'ID',                      // ✅ REQUIRED: Activity identifier
    'TYPE_ID',                 // ✅ REQUIRED: 1=Call, 2=Meeting, 3=Email, 4=Task
    'SUBJECT',                 // ✅ REQUIRED: Activity title/subject
    'DESCRIPTION',             // ✅ REQUIRED: Activity details
    'DIRECTION',               // ✅ CRITICAL: 1=Incoming, 2=Outgoing (shows communication direction)
    'DATE_TIME',               // ✅ CRITICAL: Actual activity timestamp (use for sorting)
    'CREATED',                 // ✅ REQUIRED: When logged in system (fallback)
    'AUTHOR_ID',               // ✅ REQUIRED: Who created activity
    'RESPONSIBLE_ID',          // ✅ REQUIRED: Who is responsible
    'RESULT_STATUS',           // ✅ CRITICAL: Completion status
    'RESULT_TEXT'              // ✅ REQUIRED: Result description
  ],
  order: { 'DATE_TIME': 'DESC' },  // ✅ CRITICAL: Sort by actual activity time (NOT CREATED)
  start: 0,                         // ✅ CRITICAL: Ensures pagination starts from beginning
  limit: 50                         // ✅ REQUIRED: Fetch more than needed, limit in code
});
\\\`\\\`\\\`

**Missing Any of These Will Cause:**
- ❌ \\\`DIRECTION\\\` missing: Can't distinguish incoming vs outgoing communications
- ❌ \\\`TYPE_ID\\\` missing: Can't categorize calls vs meetings vs emails
- ❌ \\\`RESULT_STATUS\\\` missing: Can't show completion status
- ❌ \\\`start: 0\\\` missing: Pagination may start from wrong offset
- ❌ \\\`.slice()\\\` in HTML missing: May display 20+ items instead of 4

### HTML Rendering Best Practices for Arrays

**ALWAYS limit arrays in HTML rendering:**

\\\`\\\`\\\`javascript
// ✅ CORRECT: Explicit limiting in HTML
\\\${entity.activities.slice(0, 4).map(a => \\\`...\\\`).join('')}
\\\${entity.products.slice(0, 5).map(p => \\\`...\\\`).join('')}
\\\${invoices.slice(0, 10).map(inv => \\\`...\\\`).join('')}

// ❌ WRONG: No limiting (may display unlimited items)
\\\${entity.activities.map(a => \\\`...\\\`).join('')}
\\\${entity.products.map(p => \\\`...\\\`).join('')}
\\\${invoices.map(inv => \\\`...\\\`).join('')}
\\\`\\\`\\\`

**Why This Matters:**
- User explicitly requested "last 4 recent activities"
- API returned 10+ activities despite \\\`limit: 4\\\`
- Report showed all 10+ activities
- Adding \\\`.slice(0, 4)\\\` fixed the issue immediately

## 📋 COMPLETE WORKING EXAMPLE - FOLLOW THIS EXACT PATTERN

**PROMPT: "Generate a report of customer activities for the last 30 days"**

**OUTPUT: Copy this structure exactly for all complex task requests**

\`\`\`javascript
// This is the COMPLETE WORKING TEMPLATE - Use as your reference pattern
const template = {
  templateId: 'customer_activity_report_30_days',
  name: 'Customer Activity Report - Last 30 Days',
  description: 'Comprehensive report of customer interactions and activities',
  category: ['customer_analysis', 'activity_tracking'],
  
  definition: {
    estimatedSteps: 6,
    estimatedDuration: 900000, // 15 minutes
    memoryRequirement: '512MB',
    requiredServices: ['queueService', 'fileStorage'],
    
    parameterSchema: {
      type: 'object',
      properties: {
        dateRange: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date' },
            end: { type: 'string', format: 'date' }
          },
          default: {
            start: 'auto_30_days_ago',
            end: 'auto_today'
          }
        },
        activityTypes: {
          type: 'array',
          items: { type: 'string' },
          default: ['1', '2', '3', '4'] // Call, Meeting, Email, Task
        },
        includeCompanyDetails: {
          type: 'boolean',
          default: true
        }
      }
    }
  },
  
  executionScript: \`
class CustomerActivityReportExecutor extends BaseTaskExecutor {
  async execute() {
    try {
      await this.validateParameters();
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(10, "Processing date range", "date_processing");
      const params = await this.preprocessParameters(this.parameters);
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(20, "Loading customer activities", "load_activities");
      
      // 🚨 MANDATORY: callAPI() usage - REQUIRED FOR VALIDATION
      const activities = await this.streamingFetch('crm.activity.list', {
        filter: {
          'TYPE_ID': params.activityTypes,
          '>=DATE_TIME': params.dateRange.start,
          '<=DATE_TIME': params.dateRange.end
        },
        select: [
          'ID', 'TYPE_ID', 'SUBJECT', 'DESCRIPTION', 'DIRECTION',
          'DATE_TIME', 'CREATED', 'AUTHOR_ID', 'RESPONSIBLE_ID',
          'OWNER_TYPE_ID', 'OWNER_ID', 'RESULT_STATUS'
        ],
        order: { 'DATE_TIME': 'DESC' }
      }, { batchSize: 100 });
      
      // 🚨 MANDATORY: this.log() usage - REQUIRED FOR VALIDATION
      this.log('info', 'Activities loaded successfully', { count: activities.length });
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(40, "Loading customer information", "load_customers");
      const customerIds = [...new Set(activities
        .filter(a => a.OWNER_TYPE_ID === '4') // Companies
        .map(a => a.OWNER_ID))];
        
      // 🚨 MANDATORY: callAPI() usage - REQUIRED FOR VALIDATION
      const customers = await this.streamingFetch('crm.company.list', {
        filter: { ID: customerIds },
        select: ['ID', 'TITLE', 'INDUSTRY', 'ASSIGNED_BY_ID', 'PHONE', 'EMAIL']
      }, { batchSize: 50 });
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(60, "Analyzing activity patterns", "analysis");
      const reportData = this.analyzeActivityData(activities, customers);
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(80, "Generating report", "generate_report");
      
      // 🚨 MANDATORY: generateHTMLReport() call - CALL YOUR CUSTOM IMPLEMENTATION
      const htmlReport = this.generateHTMLReport(reportData, params);
      
      // Step 6: Upload and finalize
      await this.updateProgress(95, "Uploading report", "upload");
      const attachment = await this.uploadReport(
        htmlReport,
        'customer_activity_report.html',
        {
          reportType: 'customer_activity',
          dateRange: params.dateRange,
          activitiesCount: activities.length,
          customersCount: customers.length
        }
      );
      
      return {
        success: true,
        summary: \`Generated activity report for \${customers.length} customers with \${activities.length} activities\`,
        attachments: [attachment],
        reportData: {
          totalActivities: activities.length,
          totalCustomers: customers.length,
          dateRange: params.dateRange,
          topActivityTypes: reportData.topActivityTypes
        }
      };
      
    } catch (error) {
      await this.handleError(error);
      throw error;
    }
  }
  
  analyzeActivityData(activities, customers) {
    // Implementation details...
    return {
      topActivityTypes: this.getTopActivityTypes(activities),
      customerEngagement: this.calculateEngagementScores(activities, customers),
      timeDistribution: this.analyzeTimeDistribution(activities)
    };
  }
  
  // 🚨 MANDATORY: generateHTMLReport method - VALIDATION WILL FAIL WITHOUT THIS
  async generateHTMLReport(reportData, params) {
    const { topActivityTypes, customerEngagement, timeDistribution } = reportData;
    
    return \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Customer Activity Report</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto p-6">
        <h1 class="text-3xl font-bold text-gray-900 mb-6">Customer Activity Report</h1>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Total Activities</h3>
                <p class="text-3xl font-bold text-blue-600">\${reportData.totalActivities}</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Total Customers</h3>
                <p class="text-3xl font-bold text-green-600">\${reportData.totalCustomers}</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Avg Activities/Customer</h3>
                <p class="text-3xl font-bold text-purple-600">\${(reportData.totalActivities / reportData.totalCustomers).toFixed(1)}</p>
            </div>
        </div>
        
        <div class="bg-white p-6 rounded-lg shadow">
            <h2 class="text-xl font-semibold mb-4">Top Activity Types</h2>
            <div class="space-y-2">
                \${topActivityTypes.map(type => \`
                    <div class="flex justify-between items-center p-2 border rounded">
                        <span>\${type.name}</span>
                        <span class="font-semibold">\${type.count}</span>
                    </div>
                \`).join('')}
            </div>
        </div>
    </div>
</body>
</html>\`;
  }
}
\`
};
\`\`\`

**KEY TAKEAWAYS FROM THIS WORKING EXAMPLE:**
1. Always include the complete template structure with templateId, name, description, category, definition
2. Always include parameterSchema with proper defaults
3. Always include ALL 4 mandatory methods in executionScript
4. Always include the complete generateHTMLReport method with full HTML
5. Follow the exact progress update pattern shown
6. Use this.callAPI() and this.streamingFetch() for all Bitrix24 API calls
7. Include proper error handling and logging

## Executive Overview

This guide provides comprehensive instructions for Gemini AI to agentically create complex tasks within the Chantilly Agent platform. Complex tasks are multi-step workflows that execute in Google Cloud Tasks environment, integrate with Bitrix24 APIs, and generate sophisticated HTML reports with contextual navigation.

### When to Create Complex Tasks

**Always use ComplexTaskManager with action="create" for:**
- Financial reports (invoices, payments, revenue analysis)
- CRM data analysis (customer insights, activity summaries) 
- Bulk data processing (imports, exports, transformations)
- Multi-step workflows (document generation + email + logging)
- Historical data analysis requiring date ranges
- Reports linking multiple Bitrix24 entities

**Key Indicators:**
- User requests "report", "analysis", "generate", "create dashboard"
- Requests involving date ranges ("last 30 days", "this month", "quarterly")
- Multi-entity operations (companies + contacts + deals + activities)
- Document generation with attachments
- Bulk operations affecting multiple records

## Cloud Tasks Execution Environment

### JavaScript Execution Context

Complex tasks execute as JavaScript classes extending \`BaseTaskExecutor\` in Google Cloud Tasks workers. The execution environment provides:

**Available Context:**
\`\`\`javascript
class YourTaskExecutor extends BaseTaskExecutor {
  async execute() {
    // Available properties:
    this.parameters     // Task parameters from user/AI
    this.context        // Execution context with userId, messageData
    this.queueService   // Bitrix24 API queue service
    this.storage        // Google Cloud Storage access
    this.db            // Firestore database access
    
    // Available methods:
    await this.updateProgress(percent, message, stage)
    await this.callAPI(method, params)
    await this.streamingFetch(method, params, options)
    await this.uploadReport(content, filename, metadata)
    this.log(level, message, data)
    await this.checkCancellation()
  }
}
\`\`\`

**Critical Safety Requirements:**
1. **Always use \`await\`** for async operations
2. **Handle errors with try/catch blocks**
3. **Update progress regularly** with \`updateProgress()\`
4. **Check for cancellation** in long loops with \`checkCancellation()\`
5. **Use \`this.log()\`** instead of \`console.log()\` or direct logger imports
6. **Validate parameters** before processing
7. **🚨 NEVER catch rate limit errors in loops** - Always propagate them for exponential backoff

## 🚨 CRITICAL: Error Handling in Loops - PREVENTS INFINITE LOOPS

**MANDATORY RULE: In loops with API calls, NEVER catch rate limit errors - ALWAYS propagate them!**

BaseTaskExecutor's \`callAPI()\` includes built-in exponential backoff. Catching rate limit errors prevents this mechanism from working and causes infinite loops.

### ✅ CORRECT Pattern - Propagate Rate Limit Errors

\`\`\`javascript
// ✅ CORRECT: Only catch non-rate-limit errors in loops
for (const invoiceId of invoiceIds) {
  // CRITICAL: Add cancellation check in ALL tight loops
  await this.checkCancellation();

  try {
    const invoice = await this.callAPI('crm.invoice.get', { id: invoiceId });
    // Process invoice...
  } catch (error) {
    // CRITICAL: NEVER catch rate limit errors - let them propagate!
    if (error.message && (error.message.includes('rate limit') || error.message.includes('429'))) {
      this.log('warn', 'Rate limit hit, propagating for automatic backoff', { invoiceId });
      throw error; // ← CRITICAL: Must propagate to trigger exponential backoff
    }

    // Only catch non-rate-limit errors (missing data, permissions, etc.)
    this.log('warn', 'Failed to fetch invoice', { invoiceId, error: error.message });
    // Continue processing other invoices
  }
}
\`\`\`

### ❌ WRONG Pattern - Causes Infinite Loops

\`\`\`javascript
// ❌ WRONG: Catching ALL errors including rate limits causes infinite loops!
for (const invoiceId of invoiceIds) {
  try {
    const invoice = await this.callAPI('crm.invoice.get', { id: invoiceId });
    // Process...
  } catch (error) {
    // ❌ BUG: Catches rate limit errors and continues loop
    // ❌ Result: Loop retries forever when rate limited
    this.log('warn', 'Error fetching invoice', { error: error.message });
    // Loop continues → hits rate limit again → catches error → infinite loop
  }
}
\`\`\`

**Why Catching Rate Limits Causes Infinite Loops:**
1. Loop makes rapid API calls → hits Bitrix24 rate limit (2 req/sec)
2. Try/catch catches rate limit error and logs it
3. Loop continues to next iteration immediately
4. Next API call also rate limited → caught again → loop continues
5. Progress never advances → task appears frozen → infinite loop detected
6. On Cloud Run: Eventually hits 60-minute timeout and kills container

**Required Pattern for ALL Loops with API Calls:**
\`\`\`javascript
for (const item of items) {
  await this.checkCancellation(); // ← REQUIRED: Allows task cancellation

  try {
    const result = await this.callAPI(method, params);
    // Process result...
  } catch (error) {
    // Check if it's a rate limit error
    if (error.message && (error.message.includes('rate limit') || error.message.includes('429'))) {
      throw error; // ← CRITICAL: Propagate rate limits for backoff
    }

    // Only catch non-recoverable errors
    this.log('warn', 'Non-rate-limit error', { error: error.message });
    // Decide: continue loop or throw based on error type
  }
}
\`\`\`

## 🚨 MANDATORY: Custom generateHTMLReport Implementation

**Every task MUST implement its own \`generateHTMLReport()\` method with custom HTML generation logic!**

### Understanding the Architecture

**BaseTaskExecutor provides a utility method**: \`generateHTMLFromSections(data, options)\`
- This is a **utility helper** for simple reports
- It's **NOT** the method you should call or rely on
- Templates **MUST** implement their own \`generateHTMLReport()\` from scratch

**Templates MUST override**: \`generateHTMLReport(reportData, params)\`
- This is the **primary method** that templates implement
- Validation **WILL FAIL** if this method is missing
- You can optionally use \`generateHTMLFromSections()\` as a utility, but custom implementation is recommended

\`\`\`javascript
// ✅ CORRECT: Implement custom HTML generation (RECOMMENDED)
async generateHTMLReport(reportData, params) {
  const { invoices, companies, contacts, summary } = reportData;

  return \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>\${params.reportTitle || 'Report'}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        'bitrix-blue': '#0066CC',
                        'bitrix-light-blue': '#E6F3FF',
                        'bitrix-gray': '#F5F7FA',
                        'bitrix-border': '#E0E6ED'
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-bitrix-gray min-h-screen">
    <div class="container mx-auto p-6">
      <h1 class="text-3xl font-bold text-gray-900 mb-6">\${params.reportTitle}</h1>

      <!-- Summary Dashboard -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div class="bg-white p-6 rounded-lg shadow">
          <h3 class="text-lg font-semibold mb-2">Total Records</h3>
          <p class="text-3xl font-bold text-blue-600">\${summary.totalRecords}</p>
        </div>
      </div>

      <!-- Detailed Data Sections -->
      <div class="bg-white p-6 rounded-lg shadow">
        <h2 class="text-xl font-semibold mb-4">Details</h2>
        <!-- Your custom report content here -->
      </div>
    </div>
</body>
</html>\`;
}

// ✅ OPTIONAL: Use base class utility for simple reports
async generateHTMLReport(reportData, params) {
  // For very simple table-based reports, you can use the utility method
  return this.generateHTMLFromSections(reportData, {
    title: params.reportTitle || 'Report',
    sections: [
      {
        type: 'table',
        title: 'Results',
        data: reportData.results,
        columns: ['id', 'name', 'status']
      }
    ],
    summary: 'Report generated successfully'
  });
}

// ❌ WRONG: Creating separate builder method and calling wrong base method
buildReportHtml(results) {
  return \`<div>...</div>\`;  // Just body HTML fragments
}

async execute() {
  const html = this.buildReportHtml(data);
  // Calling non-existent old method name - WILL FAIL
  return await this.generateHTMLReport('Title', html);  // ❌ NO!
}

// ❌ WRONG: Not implementing generateHTMLReport() at all
async execute() {
  // Missing the required method override - VALIDATION WILL FAIL
  const report = await this.uploadReport('<html>...</html>', 'report.html');
  return { success: true, attachments: [report] };
}
\`\`\`

**Custom Implementation Requirements:**
- Use TailwindCSS for professional styling (via CDN)
- Include Bitrix24 color scheme (bitrix-blue, bitrix-gray, etc.)
- Generate clickable links back to Bitrix24 entities
- Implement mobile-friendly responsive design
- Include summary dashboard with statistics
- Create custom sections specific to your report type
- Escape HTML properly for security

**🚨 CRITICAL: MANDATORY METHODS - VALIDATION WILL FAIL WITHOUT THESE:**

Every execution script MUST include ALL of these methods or automatic validation will reject the script:

1. **\`generateHTMLReport()\`** - ABSOLUTELY MANDATORY - Must implement custom HTML generation and call it in execute()
2. **\`updateProgress()\`** - REQUIRED - Must be called regularly throughout execution
3. **\`callAPI()\`** - REQUIRED - Must be used for all Bitrix24 API calls
4. **\`this.log()\`** - REQUIRED - Must be used instead of logger directly

⚠️ **VALIDATION FAILURE WARNING**: AI-generated templates missing these methods will be automatically rejected. These are not optional - they are validation requirements.

### CRITICAL LOGGING RULES

**✅ CORRECT - Use BaseTaskExecutor logging methods:**
\`\`\`javascript
this.log('info', 'Processing data', { count: data.length });
this.log('warn', 'Rate limit approaching', { remainingCalls: 10 });
this.log('error', 'API call failed', { error: error.message });
\`\`\`

**❌ WRONG - Never use logger directly:**
\`\`\`javascript
// NEVER DO THIS - Will cause "logger[level] is not a function" error
const { logger } = require('../utils/logger');
logger.info('message'); // FAILS

// NEVER DO THIS EITHER
const logger = require('../utils/logger');
logger.info('message'); // FAILS - logger is {logger, logWithContext}
\`\`\`

**Why this.log() works:**
- BaseTaskExecutor handles the logger setup correctly
- Adds task context automatically (taskId, template name, current step)
- Provides consistent logging format across all tasks
- Prevents "logger[level] is not a function" errors

### 🚨 CRITICAL: AI ANALYSIS WITH GEMINI DURING TASK EXECUTION

**✅ CORRECT - Use BaseTaskExecutor wrapper method:**
\`\`\`javascript
// Call Gemini for AI analysis during task execution
const analysis = await this.callGemini(
  \`Analyze this customer data and identify key insights: \${JSON.stringify(customerData)}\`,
  {
    model: 'gemini-2.5-pro',
    maxTokens: 8192,
    temperature: 0.1
  }
);

// Multi-stage AI analysis pattern
const categorization = await this.callGemini(
  \`Categorize these activities by type: \${JSON.stringify(activities)}\`
);

const insights = await this.callGemini(
  \`Based on these categories: \${categorization}, provide strategic insights.\`
);

this.log('info', 'AI analysis completed', {
  categorizationLength: categorization.length,
  insightsLength: insights.length
});
\`\`\`

**❌ WRONG - Never access genAI client directly:**
\`\`\`javascript
// NEVER DO THIS - this.genAI.getGenerativeModel doesn't exist
const model = this.genAI.getGenerativeModel({
  model: 'gemini-2.5-pro'
});
const result = await model.generateContent(prompt); // FAILS

// NEVER DO THIS EITHER - No direct genAI access
const response = await this.genAI.generateContent(prompt); // FAILS
\`\`\`

**Why this.callGemini() works:**
- BaseTaskExecutor provides the genAI client wrapper with proper initialization
- Handles rate limiting automatically (prevents API quota errors)
- Tracks token usage in resourceUsage.geminiTokens for monitoring
- Provides standardized error handling with proper logging
- Supports all Gemini models (flash, pro, etc.) via options parameter
- Allows customization of temperature, maxTokens, and other generation config

**🚨 CRITICAL: Valid Gemini Model Names (2025):**
- ✅ **CORRECT**: \`gemini-2.5-pro\` (default, recommended for analysis)
- ✅ **CORRECT**: \`gemini-1.5-flash-002\` (faster, lighter tasks)
- ✅ **CORRECT**: \`gemini-1.5-pro-002\` (advanced reasoning)
- ❌ **INVALID**: \`gemini-1.5-flash-latest\` (does NOT exist in v1beta API)
- ❌ **INVALID**: \`gemini-1.5-pro-latest\` (does NOT exist in v1beta API)
- ❌ **INVALID**: Any model with \`-latest\` suffix (not supported)

**NEVER use \`-latest\` suffixed model names - they will cause API errors!**

**Common Use Cases:**
- Analyzing complex data patterns that require AI interpretation
- Categorizing or classifying entities based on content
- Extracting insights from large datasets
- Generating natural language summaries of report data
- Multi-stage analysis with intermediate AI processing

### Memory and Performance Guidelines

- **Memory Limit**: 1GB maximum
- **Execution Time**: 30 minutes maximum
- **API Rate Limits**: Handled automatically by queueService
- **Batch Processing**: Use \`streamingFetch()\` for large datasets
- **Progress Updates**: Every 5-10% completion

### Parameter Preprocessing Best Practices

**🚨 CRITICAL: Always implement \`preprocessParameters()\` to handle defaults and date extraction!**

\`\`\`javascript
async preprocessParameters(params) {
  const processed = { ...params };

  // Apply schema defaults for missing parameters
  processed.includeCompanies = processed.includeCompanies !== undefined
    ? processed.includeCompanies : true;
  processed.includeContacts = processed.includeContacts !== undefined
    ? processed.includeContacts : true;
  processed.includeActivities = processed.includeActivities !== undefined
    ? processed.includeActivities : true;
  processed.activityLimit = processed.activityLimit || 3;
  processed.sortBy = processed.sortBy || 'date_insert';
  processed.sortOrder = processed.sortOrder || 'desc';

  // Ensure dateRange exists with fallback
  if (!processed.dateRange) {
    processed.dateRange = {
      start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end: new Date().toISOString().split('T')[0]
    };
    this.log('warn', 'No dateRange provided, using 90-day fallback', {
      generatedDateRange: processed.dateRange
    });
  }

  // Handle auto-detection patterns
  if (processed.dateRange.start === "auto_detect_from_message") {
    try {
      const detectedRange = await this.extractDateRangeFromMessage();
      processed.dateRange.start = detectedRange.start;
      processed.dateRange.end = detectedRange.end;

      this.log('info', 'AI-detected date range from message', {
        originalMessage: this.context.userMessage || 'unknown',
        detectedStart: detectedRange.start,
        detectedEnd: detectedRange.end,
        detectedDays: detectedRange.days
      });
    } catch (error) {
      this.log('warn', 'Failed to detect date range, using 90-day default', {
        error: error.message
      });
      const date = new Date();
      date.setDate(date.getDate() - 90);
      processed.dateRange.start = date.toISOString().split('T')[0];
      processed.dateRange.end = new Date().toISOString().split('T')[0];
    }
  } else if (processed.dateRange.start === "auto_90_days_ago") {
    const date = new Date();
    date.setDate(date.getDate() - 90);
    processed.dateRange.start = date.toISOString().split('T')[0];
  }

  if (processed.dateRange.end === "auto_today") {
    processed.dateRange.end = new Date().toISOString().split('T')[0];
  }

  return processed;
}

// Simple date extraction helper (no AI required)
extractDateRangeFromPattern(userMessage) {
  // Match "last X days/weeks/months"
  const dayPattern = /last\s+(\d+)\s+days?/i;
  const weekPattern = /last\s+(\d+)\s+weeks?/i;
  const monthPattern = /last\s+(\d+)\s+months?/i;

  let days = 90; // Default

  const dayMatch = userMessage.match(dayPattern);
  const weekMatch = userMessage.match(weekPattern);
  const monthMatch = userMessage.match(monthPattern);

  if (dayMatch) {
    days = parseInt(dayMatch[1]);
  } else if (weekMatch) {
    days = parseInt(weekMatch[1]) * 7;
  } else if (monthMatch) {
    days = parseInt(monthMatch[1]) * 30;
  }

  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  return {
    start: startDate.toISOString().split('T')[0],
    end: endDate.toISOString().split('T')[0],
    days: days
  };
}
\`\`\`

### Template Modification Considerations

**When templates are modified via TaskTemplateManager:**

1. **Cache Invalidation**: Modified templates trigger automatic cache invalidation using Firestore timestamps
2. **Version Control**: Use \`updatedAt\` field to track when templates were last modified
3. **Testing Mode**: Always test modifications before deploying to production
4. **Rollback Strategy**: Keep previous versions in Firestore history for emergency rollback

**Modifications affect:**
- \`executionScript\`: The actual code that runs
- \`parameterSchema\`: Input validation and defaults
- \`definition\`: Estimated steps, duration, memory requirements

## Bitrix24 Data Extraction Best Practices

### Phone and Email Extraction from Bitrix24 Arrays

**🚨 CRITICAL: Bitrix24 returns phone and email as arrays of objects, not strings!**

\`\`\`javascript
// ✅ CORRECT: Extract phone/email from Bitrix24 array format
extractPhoneNumber(phoneData) {
  try {
    if (!phoneData) return '';

    // If it's already a string, return it
    if (typeof phoneData === 'string') {
      return phoneData;
    }

    // If it's an array, extract the VALUE from the first entry
    if (Array.isArray(phoneData) && phoneData.length > 0) {
      const firstPhone = phoneData[0];
      if (firstPhone && typeof firstPhone === 'object' && firstPhone.VALUE) {
        return firstPhone.VALUE;
      }
    }

    return '';
  } catch (error) {
    return '';
  }
}

extractEmailAddress(emailData) {
  try {
    if (!emailData) return '';

    // If it's already a string, return it
    if (typeof emailData === 'string') {
      return emailData;
    }

    // If it's an array, extract the VALUE from first entry
    if (Array.isArray(emailData) && emailData.length > 0) {
      const firstEmail = emailData[0];
      if (firstEmail && typeof firstEmail === 'object' && firstEmail.VALUE) {
        return firstEmail.VALUE;
      }
    }

    return '';
  } catch (error) {
    return '';
  }
}

// Usage in HTML generation
\\\`<div>Phone: \\\${this.extractPhoneNumber(company.PHONE)}</div>\\\`
\\\`<div>Email: \\\${this.extractEmailAddress(company.EMAIL)}</div>\\\`
\`\`\`

### JavaScript Filtering vs API Filtering

**🚨 CRITICAL: Use JavaScript filtering for complex conditions - don't rely on API filters!**

\`\`\`javascript
// ❌ WRONG: Trying to filter \$0 invoices via API (doesn't work reliably)
const invoices = await this.streamingFetch('crm.invoice.list', {
  filter: {
    'STATUS_ID': ['N', 'S'],
    '>PRICE': 0  // API filter may not work correctly
  }
});

// ✅ CORRECT: Filter in JavaScript after fetching
const invoicesRaw = await this.streamingFetch('crm.invoice.list', {
  filter: {
    'STATUS_ID': ['N', 'S']  // Simple status filter only
  },
  select: ['ID', 'PRICE', 'CURRENCY', 'DATE_INSERT', 'UF_COMPANY_ID']
});

// Filter out \$0 or negative amounts in JavaScript
const validInvoices = invoicesRaw.filter(invoice => {
  const amount = parseFloat(invoice.PRICE || 0);
  return amount > 0;  // Only include invoices greater than \$0
});

this.log('info', 'Invoice filtering complete', {
  totalFetched: invoicesRaw.length,
  validInvoices: validInvoices.length,
  filteredOut: invoicesRaw.length - validInvoices.length
});
\`\`\`

**When to use JavaScript filtering:**
- Complex numeric comparisons (greater than, between ranges)
- Multi-field logic (if field1 exists AND field2 > value)
- Data quality checks (non-null, non-empty, valid format)
- Calculations before filtering (sum of fields, date differences)

**When API filtering is safe:**
- Simple equality checks (STATUS_ID = 'N')
- Simple date ranges (>=DATE_CREATE)
- Simple ID lookups (ID IN [1,2,3])

## Bitrix24 API Integration Patterns

### 1. CRM Endpoints (Inbound Webhook)

**Authentication**: Automatic via queueService
**Rate Limiting**: Handled automatically
**Error Handling**: Built-in retry logic

#### Companies
\`\`\`javascript
// Fetch companies with full information
const companies = await this.streamingFetch('crm.company.list', {
  filter: { ID: companyIds },
  select: [
    'ID', 'TITLE', 'COMPANY_TYPE', 'INDUSTRY', 'EMPLOYEES',
    'REVENUE', 'PHONE', 'EMAIL', 'WEB', 'ADDRESS',
    'DATE_CREATE', 'DATE_MODIFY', 'ASSIGNED_BY_ID'
  ]
}, { batchSize: 50 });
\`\`\`

#### Contacts
\`\`\`javascript
// Fetch contacts with relationship data
const contacts = await this.streamingFetch('crm.contact.list', {
  filter: { ID: contactIds },
  select: [
    'ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'POST',
    'PHONE', 'EMAIL', 'COMPANY_ID', 'ASSIGNED_BY_ID',
    'DATE_CREATE', 'DATE_MODIFY'
  ]
}, { batchSize: 50 });
\`\`\`

#### Deals
\`\`\`javascript
// Fetch deals with stage and opportunity data
const deals = await this.streamingFetch('crm.deal.list', {
  filter: {
    'STAGE_ID': 'NEW',
    '>=DATE_CREATE': startDate,
    '<=DATE_CREATE': endDate
  },
  select: [
    'ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
    'PROBABILITY', 'COMPANY_ID', 'CONTACT_ID',
    'DATE_CREATE', 'DATE_MODIFY', 'CLOSE_DATE'
  ],
  order: { 'DATE_CREATE': 'DESC' }
}, { batchSize: 50 });
\`\`\`

#### Invoices
\`\`\`javascript
// Fetch invoices with payment status
const invoices = await this.streamingFetch('crm.invoice.list', {
  filter: {
    'STATUS_ID': ['N', 'S'], // New, Sent
    '>=DATE_INSERT': startDate,
    '<=DATE_INSERT': endDate
  },
  select: [
    'ID', 'INVOICE_ID', 'STATUS_ID', 'PRICE', 'CURRENCY',
    'DATE_CREATE', 'DATE_INSERT', 'DATE_UPDATE',
    'UF_COMPANY_ID', 'UF_CONTACT_ID', 'PERSON_TYPE_ID',
    'TITLE', 'COMMENTS', 'RESPONSIBLE_ID', 'UF_DEAL_ID'
  ]
}, { batchSize: 50 });
\`\`\`

#### Products

**⚠️ Note: Product endpoints (crm.product.*) are marked as deprecated by Bitrix24. The catalog.product.* methods are recommended for new integrations. However, crm.product.* endpoints remain functional for legacy support.**

\`\`\`javascript
// List products with filtering
const products = await this.streamingFetch('crm.product.list', {
  filter: {
    CATALOG_ID: 123,     // Filter by catalog
    ACTIVE: 'Y'          // Only active products
  },
  select: [
    'ID', 'NAME', 'DESCRIPTION', 'PRICE', 'CURRENCY_ID',
    'ACTIVE', 'SECTION_ID', 'CATALOG_ID', 'MEASURE'
  ]
}, { batchSize: 50 });

// Get specific product details
const productDetails = await this.callAPI('crm.product.get', {
  id: productId,
  select: ['ID', 'NAME', 'DESCRIPTION', 'PRICE', 'CURRENCY_ID', 'SECTION_ID', 'ACTIVE']
});

// Get product field definitions (useful before creating/updating products)
const productFields = await this.callAPI('crm.product.fields', {});
const fields = productFields?.result || {};

// Create new product
const newProductId = await this.callAPI('crm.product.add', {
  fields: {
    NAME: 'New Product Name',
    PRICE: 99.99,
    CURRENCY_ID: 'USD',
    DESCRIPTION: 'Product description',
    ACTIVE: 'Y',
    CATALOG_ID: 123,
    SECTION_ID: 456
  }
});

// Update existing product
const updateResult = await this.callAPI('crm.product.update', {
  id: productId,
  fields: {
    NAME: 'Updated Product Name',
    PRICE: 149.99,
    ACTIVE: 'Y'
  }
});

// Common pattern: Bulk price update for multiple products
const productIds = ['123', '456', '789'];
for (const id of productIds) {
  await this.checkCancellation(); // Check for cancellation

  await this.callAPI('crm.product.update', {
    id: id,
    fields: {
      PRICE: 199.99,
      CURRENCY_ID: 'USD'
    }
  });

  this.log('info', 'Product updated', { productId: id });
}

// Pattern: Enrich invoice product data with full product details
for (const row of invoice.PRODUCT_ROWS) {
  if (row.PRODUCT_ID && row.PRODUCT_ID !== '0') {
    const productInfo = await this.callAPI('crm.product.get', {
      id: row.PRODUCT_ID,
      select: ['NAME', 'DESCRIPTION', 'SECTION_ID', 'ACTIVE']
    });

    if (productInfo?.result) {
      row.enrichedData = {
        description: productInfo.result.DESCRIPTION,
        section: productInfo.result.SECTION_ID,
        isActive: productInfo.result.ACTIVE === 'Y'
      };
    }
  }
}
\`\`\`

#### Activities

**🚨 CRITICAL: Fetch activities from BOTH company AND contact, not just one!**

\`\`\`javascript
// ✅ CORRECT: Fetch from BOTH company AND contact
let allActivities = [];

// Fetch company activities if company exists
if (entity.UF_COMPANY_ID && entity.UF_COMPANY_ID !== '0') {
  const companyActivities = await this.callAPI('crm.activity.list', {
    filter: {
      'OWNER_TYPE_ID': 4, // 4 = Company
      'OWNER_ID': entity.UF_COMPANY_ID,
      '>=DATE_TIME': startDate  // Use DATE_TIME (actual activity date), NOT CREATED
    },
    select: [
      'ID', 'TYPE_ID', 'SUBJECT', 'DESCRIPTION', 'DIRECTION',
      'DATE_TIME', 'CREATED', 'AUTHOR_ID', 'RESPONSIBLE_ID',
      'RESULT_STATUS', 'RESULT_TEXT'
    ],
    order: { 'DATE_TIME': 'DESC' },  // Order by DATE_TIME (actual activity time)
    limit: 50
  });
  if (companyActivities?.result) {
    allActivities = allActivities.concat(companyActivities.result);
  }
}

// Fetch contact activities if contact exists
if (entity.UF_CONTACT_ID && entity.UF_CONTACT_ID !== '0') {
  const contactActivities = await this.callAPI('crm.activity.list', {
    filter: {
      'OWNER_TYPE_ID': 3, // 3 = Contact
      'OWNER_ID': entity.UF_CONTACT_ID,
      '>=DATE_TIME': startDate  // Use DATE_TIME (actual activity date)
    },
    select: [
      'ID', 'TYPE_ID', 'SUBJECT', 'DESCRIPTION', 'DIRECTION',
      'DATE_TIME', 'CREATED', 'AUTHOR_ID', 'RESPONSIBLE_ID',
      'RESULT_STATUS', 'RESULT_TEXT'
    ],
    order: { 'DATE_TIME': 'DESC' },
    limit: 50
  });
  if (contactActivities?.result) {
    allActivities = allActivities.concat(contactActivities.result);
  }
}

// Sort combined activities by DATE_TIME and limit
if (allActivities.length > 0) {
  allActivities.sort((a, b) => new Date(b.DATE_TIME) - new Date(a.DATE_TIME));
  allActivities = allActivities.slice(0, 50);  // Apply final limit after combining
}

// ❌ WRONG: Only fetching from company OR contact (misses important interactions)
const activities = await this.callAPI('crm.activity.list', {
  filter: {
    'OWNER_TYPE_ID': 4,
    'OWNER_ID': entity.UF_COMPANY_ID || entity.UF_CONTACT_ID  // WRONG: only one
  }
});

// ❌ WRONG: Ordering by CREATED instead of DATE_TIME
order: { 'CREATED': 'DESC' }  // WRONG: When activity was logged, not when it occurred

// ✅ CORRECT: Order by DATE_TIME (actual activity timestamp)
order: { 'DATE_TIME': 'DESC' }  // CORRECT: When activity actually happened
\`\`\`

**Owner Type IDs:**
- **1** = Lead
- **2** = Deal
- **3** = Contact (individual customer)
- **4** = Company (organization customer)

**Critical Field Differences:**
- **DATE_TIME**: When the activity actually occurred (use for sorting!)
- **CREATED**: When the activity was entered into Bitrix24 system (unreliable for chronology)
- **DIRECTION**: 1=Incoming (from customer), 2=Outgoing (to customer)

### 2. Document Generator (Inbound Webhook)

**Note**: Document generation typically uses templates and merge fields.

\`\`\`javascript
// Generate document from template
const documentResult = await this.callAPI('documentgenerator.document.add', {
  templateId: templateId,
  entityTypeId: 4, // Company
  entityId: companyId,
  values: {
    // Custom merge fields
    'CUSTOM_FIELD_1': 'Value 1',
    'REPORT_DATE': new Date().toLocaleDateString()
  }
});

// Download generated document
if (documentResult.result && documentResult.result.document) {
  const documentUrl = documentResult.result.document.downloadUrl;
  // Process document URL for inclusion in reports
}
\`\`\`

### 3. News Feed API (Inbound Webhook)

**API Reference**: https://apidocs.bitrix24.com/api-reference/log/index.html

\`\`\`javascript
// See Bitrix24 API Integration Guide for API examples

// Retrieve news feed posts
const posts = await this.callAPI('log.blogpost.get', {
  filter: {
    '>DATE_PUBLISH': startDate,
    '<DATE_PUBLISH': endDate
  },
  order: { 'DATE_PUBLISH': 'DESC' },
  start: 0,
  limit: 50
});
\`\`\`

### 4. Chat/Channel/Collab Endpoints (Local Application Webhook)

**Authentication**: Uses bot authentication for messaging

\`\`\`javascript
// Send message to specific chat/channel
const messageResult = await this.callAPI('imbot.message.add', {
  DIALOG_ID: dialogId, // chat123, user456, or group789
  MESSAGE: 'Report has been generated and is available for download.',
  ATTACH: [{
    MESSAGE: 'Report Details',
    COLOR: '#18A0FB',
    BLOCKS: [{
      MESSAGE: \`Report: \${reportTitle}\\nRecords: \${recordCount}\\nGenerated: \${timestamp}\`,
      LINK: {
        NAME: 'Download Report',
        LINK: reportUrl
      }
    }]
  }]
});

// Get chat history for analysis
// ⚠️ CRITICAL: im.dialog.messages.get does NOT support LAST_ID parameter
// Response is an OBJECT not array - use Object.values() to convert
const chatHistory = await this.callAPI('im.dialog.messages.get', {
  DIALOG_ID: dialogId,
  LIMIT: 100  // Max 100 messages, returns in reverse chronological order
  // NO LAST_ID - parameter not supported by this method
});

// CRITICAL: result.messages is an OBJECT like {"123": {...}, "124": {...}}
const messagesObj = chatHistory?.result?.messages || {};
const messagesArray = Object.values(messagesObj);  // Convert to array

// Delete a bot message (only works for messages sent by the bot itself)
// Use case: Clean up test messages, remove outdated bot responses, implement self-moderation
// NOTE: Requires bot authentication context. BOT_ID can be omitted if only one bot exists.
await this.callAPI('imbot.message.delete', {
  MESSAGE_ID: messageId,  // Message ID to delete
  COMPLETE: 'Y'  // 'Y' = delete completely without traces, 'N' = delete but leave traces
});

// Example: Batch delete multiple bot messages
const messagesToDelete = [123, 456, 789];
for (const msgId of messagesToDelete) {
  await this.callAPI('imbot.message.delete', {
    MESSAGE_ID: msgId,
    COMPLETE: 'Y'
  });
  this.log('info', 'Bot message deleted', { messageId: msgId });
}

// Send to collaboration/project
const collabMessage = await this.callAPI('socialnetwork.group.message.add', {
  GROUP_ID: groupId,
  MESSAGE: 'Weekly report is ready for review.',
  FILES: [reportFileId]
});
\`\`\`

## HTML Report Generation Guidelines

### 🚨 MANDATORY EXECUTION SCRIPT STRUCTURE - VALIDATION ENFORCED

**Every execution script MUST follow this EXACT pattern or validation will fail:**

\`\`\`javascript
class YourTaskExecutor extends BaseTaskExecutor {
  async execute() {
    try {
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(10, 'Starting task execution');
      
      // 🚨 MANDATORY: callAPI() usage - REQUIRED FOR VALIDATION  
      const data = await this.callAPI('crm.invoice.list', {
        filter: { '>=DATE_CREATE': '2025-01-01' }
      });
      
      // 🚨 MANDATORY: this.log() usage - REQUIRED FOR VALIDATION
      this.log('info', 'Data fetched successfully', { recordCount: data.result.length });
      
      // Process data...
      const processedData = await this.processData(data);
      
      await this.updateProgress(80, 'Generating report');
      
      // 🚨 MANDATORY: generateHTMLReport() call - ABSOLUTELY REQUIRED
      const htmlReport = await this.generateHTMLReport(processedData, this.parameters);
      const attachment = await this.uploadReport(htmlReport, 'report.html');
      
      await this.updateProgress(100, 'Task completed');
      
      return {
        success: true,
        result: processedData,
        attachment
      };
    } catch (error) {
      await this.handleError(error);
      throw error;
    }
  }
  
  // 🚨 MANDATORY: generateHTMLReport method - VALIDATION WILL FAIL WITHOUT THIS
  async generateHTMLReport(reportData, params) {
    const { entities, summary, metadata } = reportData;
    
    return \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>\${metadata.title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        'bitrix-blue': '#0066CC',
                        'bitrix-light-blue': '#E6F3FF',
                        'bitrix-gray': '#F5F7FA',
                        'bitrix-border': '#E0E6ED'
                    }
                }
            }
        }
    </script>
</head>
<body class="bg-bitrix-gray min-h-screen">
    \${this.generateHeader(metadata)}
    \${this.generateSummaryDashboard(summary)}
    \${this.generateDetailSections(entities)}
    \${this.generateFooter(metadata)}
</body>
</html>\`;
}
\`\`\`

### Linking Back to Bitrix24 Entities

**Critical**: Always provide clickable links back to Bitrix24 for entity management.

\`\`\`javascript
// Company links
const companyUrl = \`https://\${domain}.bitrix24.com/crm/company/show/\${companyId}/\`;

// Contact links
const contactUrl = \`https://\${domain}.bitrix24.com/crm/contact/show/\${contactId}/\`;

// Deal links
const dealUrl = \`https://\${domain}.bitrix24.com/crm/deal/show/\${dealId}/\`;

// Invoice links
const invoiceUrl = \`https://\${domain}.bitrix24.com/crm/invoice/show/\${invoiceId}/\`;

// Activity/Task links
const activityUrl = \`https://\${domain}.bitrix24.com/crm/activity/show/\${activityId}/\`;

// Generate clickable entity cards
generateEntityCard(entity, entityType) {
  const entityUrl = this.getEntityUrl(entity.ID, entityType);
  
  return \`
  <div class="bg-white rounded-lg p-4 shadow-sm border border-bitrix-border hover:shadow-md transition-shadow">
    <div class="flex items-start justify-between">
      <div class="flex-1">
        <h3 class="text-lg font-semibold">
          <a href="\${entityUrl}" target="_blank" class="text-bitrix-blue hover:underline">
            \${entity.TITLE || entity.NAME || 'Untitled'}
          </a>
        </h3>
        <p class="text-sm text-gray-600 mt-1">\${entity.DESCRIPTION || ''}</p>
      </div>
      <div class="text-right">
        <a href="\${entityUrl}" target="_blank" class="text-sm text-bitrix-blue hover:underline">
          View in CRM →
        </a>
      </div>
    </div>
  </div>\`;
}
\`\`\`

### Contextual Navigation

Provide navigation that helps users understand relationships:

\`\`\`javascript
generateRelatedEntitiesSection(entity, relatedData) {
  return \`
  <div class="mt-4 p-4 bg-gray-50 rounded-lg">
    <h4 class="font-medium text-gray-900 mb-3">Related Information</h4>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      \${entity.COMPANY_ID ? \`
      <div>
        <span class="text-sm font-medium text-gray-600">Company:</span>
        <a href="\${this.getEntityUrl(entity.COMPANY_ID, 'company')}" 
           target="_blank" 
           class="block text-bitrix-blue hover:underline">
          \${relatedData.companies.get(entity.COMPANY_ID)?.TITLE || 'View Company'}
        </a>
      </div>
      \` : ''}
      
      \${entity.CONTACT_ID ? \`
      <div>
        <span class="text-sm font-medium text-gray-600">Contact:</span>
        <a href="\${this.getEntityUrl(entity.CONTACT_ID, 'contact')}" 
           target="_blank" 
           class="block text-bitrix-blue hover:underline">
          \${this.getContactName(relatedData.contacts.get(entity.CONTACT_ID))}
        </a>
      </div>
      \` : ''}
      
      \${entity.DEAL_ID ? \`
      <div>
        <span class="text-sm font-medium text-gray-600">Deal:</span>
        <a href="\${this.getEntityUrl(entity.DEAL_ID, 'deal')}" 
           target="_blank" 
           class="block text-bitrix-blue hover:underline">
          \${relatedData.deals.get(entity.DEAL_ID)?.TITLE || 'View Deal'}
        </a>
      </div>
      \` : ''}
    </div>
  </div>\`;
}
\`\`\`

### Security Considerations

**URL Safety:**
- Always validate entity IDs before including in URLs
- Use HTTPS URLs only
- Escape special characters in entity titles
- Limit URL parameters to prevent injection

**Data Exposure:**
- Never include sensitive fields (passwords, tokens) in HTML
- Sanitize user-generated content
- Validate all data before HTML generation
- Use proper HTML escaping

\`\`\`javascript
// Safe HTML generation helper
escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Safe URL generation
getEntityUrl(entityId, entityType) {
  // Validate entity ID
  if (!entityId || !/^[0-9]+$/.test(entityId.toString())) {
    return '#';
  }
  
  const domain = 'your-domain'; // Your Bitrix24 domain
  const baseUrl = \`https://\${domain}.bitrix24.com/crm\`;
  
  switch (entityType) {
    case 'company': return \`\${baseUrl}/company/show/\${entityId}/\`;
    case 'contact': return \`\${baseUrl}/contact/show/\${entityId}/\`;
    case 'deal': return \`\${baseUrl}/deal/show/\${entityId}/\`;
    case 'invoice': return \`\${baseUrl}/invoice/show/\${entityId}/\`;
    default: return baseUrl;
  }
}
\`\`\`

## Real-World Example: Complete Activity Fetching Pattern

**This section shows the CORRECT vs INCORRECT approach for fetching activities in reports.**

### ❌ INCORRECT Pattern (Missing Contact Activities)

\`\`\`javascript
// WRONG: Only fetches from company OR contact (not both)
async compileReportData(reportData, companyMap, contactMap, userMap) {
  for (const opportunity of opportunities) {
    // ❌ WRONG: Picks company OR contact, not both
    const ownerId = opportunity.company?.ID || opportunity.contact?.ID;
    const ownerTypeId = opportunity.company ? 4 : 3;

    if (ownerId && ownerTypeId) {
      const activityResponse = await this.callAPI('crm.activity.list', {
        filter: { OWNER_ID: ownerId, OWNER_TYPE_ID: ownerTypeId },
        order: { CREATED: 'DESC' },  // ❌ WRONG: Should use DATE_TIME
        limit: 4
      });
      opportunity.activities = activityResponse?.result || [];
    }
  }
  return opportunities;
}
\`\`\`

**Problems with this approach:**
1. **Misses contact activities** when company exists (only fetches company activities)
2. **Wrong ordering field** (CREATED instead of DATE_TIME)
3. **Incomplete timeline** - may only show 4 activities from one entity
4. **No field validation** - missing critical fields like DATE_TIME, DIRECTION

### ✅ CORRECT Pattern (Complete Timeline)

\`\`\`javascript
// CORRECT: Fetches from BOTH company AND contact
async compileReportData(reportData, companyMap, contactMap, userMap) {
  for (const opportunity of opportunities) {
    let allActivities = [];

    // Fetch from company if exists
    if (opportunity.company?.ID) {
      const companyActivities = await this.callAPI('crm.activity.list', {
        filter: {
          OWNER_TYPE_ID: 4,
          OWNER_ID: opportunity.company.ID
        },
        order: { DATE_TIME: 'DESC' },  // ✅ CORRECT: Actual activity time
        limit: 4,
        select: [
          'SUBJECT', 'DESCRIPTION', 'DATE_TIME', 'CREATED',
          'DIRECTION', 'TYPE_ID', 'RESULT_STATUS'
        ]
      });
      if (companyActivities?.result) {
        allActivities = allActivities.concat(companyActivities.result);
      }
    }

    // Fetch from contact if exists
    if (opportunity.contact?.ID) {
      const contactActivities = await this.callAPI('crm.activity.list', {
        filter: {
          OWNER_TYPE_ID: 3,
          OWNER_ID: opportunity.contact.ID
        },
        order: { DATE_TIME: 'DESC' },  // ✅ CORRECT: Actual activity time
        limit: 4,
        select: [
          'SUBJECT', 'DESCRIPTION', 'DATE_TIME', 'CREATED',
          'DIRECTION', 'TYPE_ID', 'RESULT_STATUS'
        ]
      });
      if (contactActivities?.result) {
        allActivities = allActivities.concat(contactActivities.result);
      }
    }

    // Sort combined activities and apply final limit
    if (allActivities.length > 0) {
      allActivities.sort((a, b) => new Date(b.DATE_TIME) - new Date(a.DATE_TIME));
      opportunity.activities = allActivities.slice(0, 4);
    } else {
      opportunity.activities = [];
    }
  }
  return opportunities;
}
\`\`\`

**Benefits of correct approach:**
1. **Complete timeline** - shows activities from both company AND contact
2. **Chronologically accurate** - uses DATE_TIME (when activity occurred)
3. **Comprehensive data** - includes DIRECTION (incoming/outgoing) and RESULT_STATUS
4. **Intelligent limiting** - combines both sources then limits to most recent 4

### Key Differences Summary

| Aspect | ❌ Wrong Way | ✅ Right Way |
|--------|-------------|--------------|
| **Data Sources** | Company OR Contact | Company AND Contact |
| **Ordering Field** | CREATED (system log time) | DATE_TIME (actual occurrence) |
| **Result Completeness** | May miss important activities | Complete customer timeline |
| **Field Selection** | Minimal fields | Comprehensive with DIRECTION, RESULT_STATUS |
| **Limit Application** | Per-entity (4 from one) | Combined (4 most recent from both) |

## Testing and Debugging Framework

### Using the Test Action

The \`test\` action allows safe development and debugging of executionScript:

\`\`\`javascript
// In ComplexTaskManager tool
{
  action: "test",
  taskId: "generated_task_id",
  debugLevel: "verbose", // basic, verbose, detailed
  dryRun: true, // Don't make actual API calls
  sampleSize: 10 // Limit data processing for testing
}
\`\`\`

**Test Mode Capabilities:**
- Mock API responses for development
- Limited data processing (sample sizes)
- Verbose logging and debugging output
- Error simulation and handling verification
- Performance measurement and optimization

### Error Handling Patterns

\`\`\`javascript
async execute() {
  try {
    await this.validateParameters();
    
    // Step 1: Data Collection
    await this.updateProgress(10, "Starting data collection", "data_collection");
    
    let entities = [];
    try {
      entities = await this.streamingFetch('crm.entity.list', {
        filter: this.buildFilter(),
        select: this.getRequiredFields()
      }, {
        batchSize: 50,
        progressCallback: (processed, estimated) => {
          const progress = 10 + ((processed / estimated) * 30);
          this.updateProgress(progress, \`Processed \${processed}/\${estimated} entities\`, "data_collection");
        }
      });
    } catch (apiError) {
      this.log('error', 'API call failed', { 
        method: 'crm.entity.list', 
        error: apiError.message,
        retryable: this.isRetryableError(apiError)
      });
      
      if (this.isRetryableError(apiError)) {
        // Implement exponential backoff retry
        await this.delay(1000);
        entities = await this.retryApiCall('crm.entity.list', params);
      } else {
        throw new Error(\`Data collection failed: \${apiError.message}\`);
      }
    }
    
    // Step 2: Data Processing
    await this.updateProgress(50, "Processing collected data", "data_processing");
    
    // ... processing logic with error handling
    
  } catch (error) {
    await this.handleError(error);
    throw error;
  }
}

async handleError(error) {
  this.log('error', 'Task execution failed', {
    error: error.message,
    stack: error.stack,
    stage: this.currentStage,
    progress: this.currentProgress
  });
  
  // Send user-friendly error message
  await this.updateProgress(this.currentProgress, \`Error: \${error.message}\`, "error");
}
\`\`\`

### Performance Optimization Techniques

\`\`\`javascript
// Efficient data loading with streaming
async loadEntitiesEfficiently(entityType, filter, requiredFields) {
  const startTime = Date.now();
  let totalLoaded = 0;
  
  const entities = await this.streamingFetch(\`crm.\${entityType}.list\`, {
    filter: filter,
    select: requiredFields
  }, {
    batchSize: 100, // Optimize based on entity size
    progressCallback: (processed, estimated) => {
      totalLoaded = processed;
      const elapsed = Date.now() - startTime;
      const rate = processed / (elapsed / 1000);
      
      this.log('debug', 'Loading progress', {
        entityType,
        processed,
        estimated,
        rate: \`\${rate.toFixed(1)} entities/second\`,
        estimatedCompletion: new Date(Date.now() + ((estimated - processed) / rate * 1000))
      });
    }
  });
  
  this.log('info', 'Entity loading completed', {
    entityType,
    totalLoaded,
    duration: \`\${(Date.now() - startTime) / 1000}s\`
  });
  
  return entities;
}

// Memory-efficient data processing
async processLargeDataset(entities, processingFunction) {
  const batchSize = 100;
  const results = [];
  
  for (let i = 0; i < entities.length; i += batchSize) {
    await this.checkCancellation(); // Allow task cancellation
    
    const batch = entities.slice(i, i + batchSize);
    const batchResults = await processingFunction(batch);
    results.push(...batchResults);
    
    // Update progress
    const progress = (i + batch.length) / entities.length * 100;
    await this.updateProgress(
      progress, 
      \`Processed \${i + batch.length}/\${entities.length} entities\`, 
      "processing"
    );
    
    // Memory management - garbage collection hint
    if (i % (batchSize * 10) === 0) {
      global.gc && global.gc();
    }
  }
  
  return results;
}
\`\`\`

### Debugging and Troubleshooting Workflows

**Common Issues and Solutions:**

1. **API Rate Limits**:
   - Use \`streamingFetch()\` with appropriate batch sizes
   - Monitor queue service logs for rate limit warnings
   - Implement exponential backoff for retries

2. **Memory Issues**:
   - Process data in batches
   - Clear intermediate variables
   - Use streaming for large datasets

3. **Timeout Issues**:
   - Break long operations into progress-tracked steps
   - Use \`checkCancellation()\` in loops
   - Optimize API queries with specific field selection

4. **Data Quality Issues**:
   - Validate API responses before processing
   - Handle missing or null fields gracefully
   - Log data quality metrics for monitoring

**Debug Logging Best Practices:**

\`\`\`javascript
// Structured debugging information
this.log('debug', 'Processing invoice batch', {
  batchNumber: currentBatch,
  batchSize: invoices.length,
  sampleInvoice: {
    id: invoices[0]?.ID,
    status: invoices[0]?.STATUS_ID,
    amount: invoices[0]?.PRICE,
    hasCompany: !!invoices[0]?.UF_COMPANY_ID,
    hasContact: !!invoices[0]?.UF_CONTACT_ID
  },
  memoryUsage: process.memoryUsage(),
  executionTime: Date.now() - this.startTime
});
\`\`\`

## 📋 COMPLETE WORKING EXAMPLE - FOLLOW THIS EXACT PATTERN

**PROMPT: "Generate a report of customer activities for the last 30 days"**

**OUTPUT: Copy this structure exactly for all complex task requests**

\`\`\`javascript
// This is the COMPLETE WORKING TEMPLATE - Use as your reference pattern
const template = {
  templateId: 'customer_activity_report_30_days',
  name: 'Customer Activity Report - Last 30 Days',
  description: 'Comprehensive report of customer interactions and activities',
  category: ['customer_analysis', 'activity_tracking'],
  
  definition: {
    estimatedSteps: 6,
    estimatedDuration: 900000, // 15 minutes
    memoryRequirement: '512MB',
    requiredServices: ['queueService', 'fileStorage'],
    
    parameterSchema: {
      type: 'object',
      properties: {
        dateRange: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date' },
            end: { type: 'string', format: 'date' }
          },
          default: {
            start: 'auto_30_days_ago',
            end: 'auto_today'
          }
        },
        activityTypes: {
          type: 'array',
          items: { type: 'string' },
          default: ['1', '2', '3', '4'] // Call, Meeting, Email, Task
        },
        includeCompanyDetails: {
          type: 'boolean',
          default: true
        }
      }
    }
  },
  
  executionScript: \`
class CustomerActivityReportExecutor extends BaseTaskExecutor {
  async execute() {
    try {
      await this.validateParameters();
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(10, "Processing date range", "date_processing");
      const params = await this.preprocessParameters(this.parameters);
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(20, "Loading customer activities", "load_activities");
      
      // 🚨 MANDATORY: callAPI() usage - REQUIRED FOR VALIDATION
      const activities = await this.streamingFetch('crm.activity.list', {
        filter: {
          'TYPE_ID': params.activityTypes,
          '>=DATE_TIME': params.dateRange.start,
          '<=DATE_TIME': params.dateRange.end
        },
        select: [
          'ID', 'TYPE_ID', 'SUBJECT', 'DESCRIPTION', 'DIRECTION',
          'DATE_TIME', 'CREATED', 'AUTHOR_ID', 'RESPONSIBLE_ID',
          'OWNER_TYPE_ID', 'OWNER_ID', 'RESULT_STATUS'
        ],
        order: { 'DATE_TIME': 'DESC' }
      }, { batchSize: 100 });
      
      // 🚨 MANDATORY: this.log() usage - REQUIRED FOR VALIDATION
      this.log('info', 'Activities loaded successfully', { count: activities.length });
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(40, "Loading customer information", "load_customers");
      const customerIds = [...new Set(activities
        .filter(a => a.OWNER_TYPE_ID === '4') // Companies
        .map(a => a.OWNER_ID))];
        
      // 🚨 MANDATORY: callAPI() usage - REQUIRED FOR VALIDATION
      const customers = await this.streamingFetch('crm.company.list', {
        filter: { ID: customerIds },
        select: ['ID', 'TITLE', 'INDUSTRY', 'ASSIGNED_BY_ID', 'PHONE', 'EMAIL']
      }, { batchSize: 50 });
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(60, "Analyzing activity patterns", "analysis");
      const reportData = this.analyzeActivityData(activities, customers);
      
      // 🚨 MANDATORY: updateProgress() calls - REQUIRED FOR VALIDATION
      await this.updateProgress(80, "Generating report", "generate_report");
      
      // 🚨 MANDATORY: generateHTMLReport() call - CALL YOUR CUSTOM IMPLEMENTATION
      const htmlReport = this.generateHTMLReport(reportData, params);
      
      // Step 6: Upload and finalize
      await this.updateProgress(95, "Uploading report", "upload");
      const attachment = await this.uploadReport(
        htmlReport,
        'customer_activity_report.html',
        {
          reportType: 'customer_activity',
          dateRange: params.dateRange,
          activitiesCount: activities.length,
          customersCount: customers.length
        }
      );
      
      return {
        success: true,
        summary: \`Generated activity report for \${customers.length} customers with \${activities.length} activities\`,
        attachments: [attachment],
        reportData: {
          totalActivities: activities.length,
          totalCustomers: customers.length,
          dateRange: params.dateRange,
          topActivityTypes: reportData.topActivityTypes
        }
      };
      
    } catch (error) {
      await this.handleError(error);
      throw error;
    }
  }
  
  analyzeActivityData(activities, customers) {
    // Implementation details...
    return {
      topActivityTypes: this.getTopActivityTypes(activities),
      customerEngagement: this.calculateEngagementScores(activities, customers),
      timeDistribution: this.analyzeTimeDistribution(activities)
    };
  }
  
  // 🚨 MANDATORY: generateHTMLReport method - VALIDATION WILL FAIL WITHOUT THIS
  async generateHTMLReport(reportData, params) {
    const { topActivityTypes, customerEngagement, timeDistribution } = reportData;
    
    return \`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Customer Activity Report</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto p-6">
        <h1 class="text-3xl font-bold text-gray-900 mb-6">Customer Activity Report</h1>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Total Activities</h3>
                <p class="text-3xl font-bold text-blue-600">\${reportData.totalActivities}</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Total Customers</h3>
                <p class="text-3xl font-bold text-green-600">\${reportData.totalCustomers}</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Avg Activities/Customer</h3>
                <p class="text-3xl font-bold text-purple-600">\${(reportData.totalActivities / reportData.totalCustomers).toFixed(1)}</p>
            </div>
        </div>
        
        <div class="bg-white p-6 rounded-lg shadow">
            <h2 class="text-xl font-semibold mb-4">Top Activity Types</h2>
            <div class="space-y-2">
                \${topActivityTypes.map(type => \`
                    <div class="flex justify-between items-center p-2 border rounded">
                        <span>\${type.name}</span>
                        <span class="font-semibold">\${type.count}</span>
                    </div>
                \`).join('')}
            </div>
        </div>
    </div>
</body>
</html>\`;
  }
}
\`
};
\`\`\`

This comprehensive guide provides Gemini AI with all the necessary patterns, safety considerations, and implementation details for creating sophisticated complex tasks that integrate seamlessly with Bitrix24 APIs and generate useful, contextual HTML reports for users.
`;

const advancedPatternsGuide = `# Advanced Complex Task Patterns and Workflows

## 3CX API Integration Patterns

### Pattern 1: Call Recording Analysis Report

**Use Case:** Generate comprehensive call analysis reports with transcripts, sentiment analysis, and customer insights.

\`\`\`javascript
const template = {
  templateId: '3cx_call_analysis_report',
  name: '3CX Call Analysis Report',
  description: 'Analyzes call recordings with AI-powered insights, extracts transcripts, and generates comprehensive reports',
  category: ['telephony', 'analytics', '3cx'],

  definition: {
    estimatedSteps: 5,
    estimatedDuration: 600000, // 10 minutes
    memoryRequirement: '512MB',
    requiredServices: ['queueService'],  // threecx global is automatically available in sandbox

    parameterSchema: {
      type: 'object',
      properties: {
        dateRange: {
          type: 'object',
          properties: {
            start: { type: 'string', format: 'date' },
            end: { type: 'string', format: 'date' }
          },
          default: {
            start: 'auto_7_days_ago',
            end: 'auto_today'
          }
        },
        searchQuery: {
          type: 'string',
          description: 'Phone number or search term to filter recordings'
        },
        includeTranscripts: {
          type: 'boolean',
          default: true
        },
        performAIAnalysis: {
          type: 'boolean',
          default: true,
          description: 'Use Gemini AI to analyze call patterns and extract insights'
        }
      }
    }
  },

  executionScript: \\\`
class ThreeCXCallAnalysisExecutor extends BaseTaskExecutor {
  async execute() {
    try {
      await this.validateParameters();

      await this.updateProgress(10, 'Processing date range');
      const params = await this.preprocessParameters(this.parameters);

      await this.updateProgress(20, 'Fetching call recordings from 3CX');

      // ✅ CORRECT: Use threecx global in task templates (VM sandbox)
      const recordings = await this.fetch3CXRecordings(params);

      this.log('info', '3CX recordings fetched', {
        count: recordings.length,
        hasSearchQuery: !!params.searchQuery
      });

      await this.updateProgress(50, 'Processing transcripts and enriching data');
      const enrichedRecordings = await this.enrichRecordings(recordings, params);

      if (params.performAIAnalysis) {
        await this.updateProgress(70, 'Performing AI analysis with Gemini');
        const analysis = await this.analyzeCallPatterns(enrichedRecordings);

        await this.updateProgress(85, 'Generating comprehensive report');
        const htmlReport = await this.generateHTMLReport({
          recordings: enrichedRecordings,
          analysis,
          summary: this.generateSummary(enrichedRecordings, analysis)
        }, params);

        const attachment = await this.uploadReport(
          htmlReport,
          '3cx_call_analysis_report.html',
          {
            reportType: '3cx_analysis',
            dateRange: params.dateRange,
            recordingsAnalyzed: recordings.length,
            aiAnalysisPerformed: true
          }
        );

        return {
          success: true,
          summary: \\\`Analyzed \\\${recordings.length} call recordings with AI insights\\\`,
          attachments: [attachment],
          reportData: {
            totalRecordings: recordings.length,
            withTranscripts: enrichedRecordings.filter(r => r.transcript).length,
            dateRange: params.dateRange,
            keyInsights: analysis.keyInsights
          }
        };
      } else {
        await this.updateProgress(85, 'Generating report');
        const htmlReport = await this.generateHTMLReport({
          recordings: enrichedRecordings,
          summary: this.generateSummary(enrichedRecordings)
        }, params);

        const attachment = await this.uploadReport(
          htmlReport,
          '3cx_call_report.html'
        );

        return {
          success: true,
          summary: \\\`Generated report for \\\${recordings.length} call recordings\\\`,
          attachments: [attachment]
        };
      }

    } catch (error) {
      await this.handleError(error);
      throw error;
    }
  }

  async fetch3CXRecordings(params) {
    // Build date filter
    const filters = {
      startDate: \\\`\\\${params.dateRange.start}T00:00:00.000Z\\\`,
      endDate: \\\`\\\${params.dateRange.end}T23:59:59.999Z\\\`,
      isTranscribed: params.includeTranscripts ? true : undefined
    };

    const options = {
      top: 100,
      select: 'Id,FromDisplayName,FromCallerNumber,ToDisplayName,ToDn,StartTime,IsTranscribed,Transcription,RecordingUrl'
    };

    try {
      // ✅ CORRECT: Use threecx global for list recordings
      // Note: $search is not directly supported by listRecordings helper
      // If searchQuery is provided, use generic call() method instead
      if (params.searchQuery) {
        this.log('info', '3CX search query detected, using generic call()', {
          searchQuery: params.searchQuery
        });

        const dateFilter = \\\`(StartTime ge \\\${filters.startDate} and StartTime lt \\\${filters.endDate})\\\`;
        const response = await threecx.call('/xapi/v1/Recordings', {
          '$filter': dateFilter,
          '$search': \\\`"\\\${this.sanitizeSearchQuery(params.searchQuery)}"\\\`,
          '$orderby': 'StartTime desc',
          '$select': options.select,
          '$top': options.top
        });

        return response?.value || [];
      } else {
        // Use helper method for standard date range queries
        return await threecx.listRecordings(filters, options);
      }
    } catch (error) {
      this.log('error', 'Failed to fetch 3CX recordings', {
        error: error.message,
        filters,
        options
      });

      if (error.message.includes('cooldown')) {
        throw new Error('3CX rate limit cooldown active. Please try again in 5 minutes.');
      } else if (error.message.includes('401')) {
        throw new Error('3CX authentication failed. Check credentials.');
      } else if (error.message.includes('500')) {
        throw new Error('3CX server error. Check OData query syntax or endpoint availability.');
      }

      throw error;
    }
  }

  async getSpecificRecording(recordingId) {
    try {
      // ✅ CORRECT: Use threecx.getRecording() helper method
      const recording = await threecx.getRecording(recordingId);

      if (!recording) {
        this.log('warn', 'Recording not found', { recordingId });
        return null;
      }

      return recording;
    } catch (error) {
      this.log('error', 'Failed to fetch specific recording', {
        recordingId,
        error: error.message
      });
      throw error;
    }
  }

  sanitizeSearchQuery(query) {
    // SECURITY: Remove special characters that could be used for OData injection
    if (!query || typeof query !== 'string') {
      return '';
    }
    // Allow alphanumeric, spaces, basic punctuation
    return query.replace(/[^a-zA-Z0-9\\s.,@-]/g, '').trim();
  }

  async enrichRecordings(recordings, params) {
    const enriched = [];

    for (const recording of recordings) {
      await this.checkCancellation();

      const enrichedRecord = {
        ...recording,
        transcript: null,
        duration: this.calculateDuration(recording),
        callerInfo: this.extractCallerInfo(recording),
        recipientInfo: this.extractRecipientInfo(recording)
      };

      // Extract transcript if available
      if (params.includeTranscripts && recording.IsTranscribed && recording.Transcription) {
        enrichedRecord.transcript = recording.Transcription;
      }

      enriched.push(enrichedRecord);
    }

    return enriched;
  }

  async analyzeCallPatterns(recordings) {
    // Use Gemini AI to analyze call patterns
    const transcriptsForAnalysis = recordings
      .filter(r => r.transcript)
      .slice(0, 20)  // Limit to first 20 for token efficiency
      .map(r => ({
        id: r.Id,
        caller: r.callerInfo,
        recipient: r.recipientInfo,
        date: r.StartTime,
        transcript: r.transcript.substring(0, 1000)  // First 1000 chars
      }));

    if (transcriptsForAnalysis.length === 0) {
      return {
        keyInsights: ['No transcripts available for AI analysis'],
        patterns: [],
        recommendations: []
      };
    }

    const analysisPrompt = \\\`Analyze these call recordings and identify:
1. Common themes and topics discussed
2. Customer pain points or concerns
3. Communication patterns (positive/negative sentiment trends)
4. Actionable recommendations for improving customer service

Call Data:
\\\${JSON.stringify(transcriptsForAnalysis, null, 2)}

Provide a structured analysis with specific examples.\\\`;

    const aiAnalysis = await this.callGemini(analysisPrompt, {
      model: 'gemini-2.5-pro',
      maxTokens: 8192,
      temperature: 0.2
    });

    this.log('info', 'AI analysis completed', {
      recordingsAnalyzed: transcriptsForAnalysis.length,
      analysisLength: aiAnalysis.length
    });

    return {
      keyInsights: this.extractInsights(aiAnalysis),
      rawAnalysis: aiAnalysis,
      recordingsAnalyzed: transcriptsForAnalysis.length
    };
  }

  extractInsights(aiAnalysis) {
    // Extract bullet points or key insights from AI analysis
    const lines = aiAnalysis.split('\\n').filter(line => line.trim());
    return lines.slice(0, 5);  // Top 5 insights
  }

  calculateDuration(recording) {
    // Placeholder - actual duration calculation would require additional fields
    return 'N/A';
  }

  extractCallerInfo(recording) {
    return {
      name: recording.FromDisplayName || 'Unknown',
      number: recording.FromCallerNumber || 'N/A'
    };
  }

  extractRecipientInfo(recording) {
    return {
      name: recording.ToDisplayName || 'Unknown',
      number: recording.ToDn || 'N/A'
    };
  }

  generateSummary(recordings, analysis = null) {
    const summary = {
      totalRecordings: recordings.length,
      withTranscripts: recordings.filter(r => r.transcript).length,
      dateRange: \\\`\\\${recordings[recordings.length - 1]?.StartTime} to \\\${recordings[0]?.StartTime}\\\`
    };

    if (analysis) {
      summary.aiInsights = analysis.keyInsights.length;
      summary.recordingsAnalyzed = analysis.recordingsAnalyzed;
    }

    return summary;
  }

  async generateHTMLReport(reportData, params) {
    const { recordings, analysis, summary } = reportData;

    return \\\`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>3CX Call Analysis Report</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <div class="container mx-auto p-6">
        <h1 class="text-3xl font-bold text-gray-900 mb-6">📞 3CX Call Analysis Report</h1>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Total Calls</h3>
                <p class="text-3xl font-bold text-blue-600">\\\${summary.totalRecordings}</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">With Transcripts</h3>
                <p class="text-3xl font-bold text-green-600">\\\${summary.withTranscripts}</p>
            </div>
            <div class="bg-white p-6 rounded-lg shadow">
                <h3 class="text-lg font-semibold mb-2">Date Range</h3>
                <p class="text-sm text-gray-600">\\\${params.dateRange.start} to \\\${params.dateRange.end}</p>
            </div>
        </div>

        \\\${analysis ? \\\`
        <div class="bg-white p-6 rounded-lg shadow mb-8">
            <h2 class="text-xl font-semibold mb-4">🤖 AI-Powered Insights</h2>
            <div class="prose max-w-none">
                \\\${analysis.keyInsights.map(insight => \\\`<p class="mb-2">• \\\${insight}</p>\\\`).join('')}
            </div>
        </div>
        \\\` : ''}

        <div class="bg-white p-6 rounded-lg shadow">
            <h2 class="text-xl font-semibold mb-4">Call Recordings</h2>
            <div class="space-y-4">
                \\\${recordings.slice(0, 20).map(rec => \\\`
                <div class="border rounded-lg p-4">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <h3 class="font-semibold">\\\${rec.callerInfo.name} → \\\${rec.recipientInfo.name}</h3>
                            <p class="text-sm text-gray-600">\\\${new Date(rec.StartTime).toLocaleString()}</p>
                        </div>
                        <span class="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">\\\${rec.IsTranscribed ? 'Transcribed' : 'No Transcript'}</span>
                    </div>
                    \\\${rec.transcript ? \\\`
                    <div class="mt-2 p-3 bg-gray-50 rounded text-sm">
                        <p class="text-gray-700">\\\${rec.transcript.substring(0, 300)}...</p>
                    </div>
                    \\\` : ''}
                </div>
                \\\`).join('')}
            </div>
        </div>
    </div>
</body>
</html>\\\`;
  }
}
\\\`
};
\`\`\`

**Key Learnings from This Example:**

1. **3CX Global in Task Templates**: Task templates have access to the \`threecx\` global object with helper methods:
   - \`threecx.getRecording(id)\` - Fetch specific recording with transcript
   - \`threecx.listRecordings(filters, options)\` - List recordings with date/caller filters
   - \`threecx.getCallHistory(filters, options)\` - Get call history
   - \`threecx.call(endpoint, params)\` - Generic API call for advanced queries
2. **OData Syntax Mastery** (when using \`threecx.call()\`):
   - **Numeric ID filtering**: \`$filter=Id eq 12345\` (NO quotes)
   - **Search with quotes**: \`$search="5184966351"\` (WITH quotes for exact match)
   - **String filtering**: \`$filter=Name eq 'John'\` (single quotes for strings)
3. **Error Handling**: Specific handling for 3CX cooldown, auth failures, and server errors
4. **AI Integration**: Using Gemini to analyze call transcripts for insights
5. **Security**: Sanitizing search queries to prevent OData injection

## Multi-API Integration Patterns

### Pattern 1: CRM Data Enrichment with External APIs

\`\`\`javascript
async enrichCRMData() {
  // Load base CRM data
  const companies = await this.streamingFetch('crm.company.list', {
    filter: { '!UF_ENRICHED': 'Y' },
    select: ['ID', 'TITLE', 'WEB', 'PHONE', 'EMAIL']
  });
  
  // Enrich with external data sources
  for (const company of companies) {
    try {
      // Example: Enrich with industry data, financial info, etc.
      const enrichedData = await this.enrichWithExternalAPI(company);
      
      // Update Bitrix24 with enriched data
      await this.callAPI('crm.company.update', {
        ID: company.ID,
        fields: {
          'UF_INDUSTRY_DETAILS': enrichedData.industry,
          'UF_FINANCIAL_SCORE': enrichedData.financialScore,
          'UF_ENRICHED': 'Y',
          'UF_ENRICHED_DATE': new Date().toISOString()
        }
      });
      
    } catch (error) {
      this.log('warn', 'Failed to enrich company data', {
        companyId: company.ID,
        error: error.message
      });
    }
  }
}
\`\`\`

### Pattern 2: Automated Document Generation and Distribution

\`\`\`javascript
async generateAndDistributeReports() {
  // Generate multiple report types
  const reportTypes = ['invoice_summary', 'activity_digest', 'sales_forecast'];
  const generatedReports = [];
  
  for (const reportType of reportTypes) {
    const reportData = await this.generateReportData(reportType);
    const document = await this.callAPI('documentgenerator.document.add', {
      templateId: this.getTemplateId(reportType),
      entityTypeId: 4, // Company
      entityId: this.parameters.companyId,
      values: reportData
    });
    
    generatedReports.push({
      type: reportType,
      documentId: document.result.document.id,
      downloadUrl: document.result.document.downloadUrl
    });
  }
  
  // Distribute via multiple channels
  await this.distributeReports(generatedReports);
}

async distributeReports(reports) {
  // Send to news feed
  // NOTE: DEST parameter must be OMITTED for bot posts (causes 400 errors)
  // See Bitrix24 API Integration Guide for correct news feed patterns
  await this.callAPI('log.blogpost.add', {
    POST_TITLE: 'Monthly Reports Generated',
    POST_MESSAGE: this.formatReportsMessage(reports),
    FILES: reports.map(r => r.documentId)
  });
  
  // Send to collaboration space
  await this.callAPI('socialnetwork.group.message.add', {
    GROUP_ID: this.parameters.collaborationGroupId,
    MESSAGE: 'Reports are ready for review',
    FILES: reports.map(r => r.documentId)
  });
  
  // Send individual notifications
  for (const userId of this.parameters.notificationUsers) {
    await this.callAPI('imbot.message.add', {
      DIALOG_ID: userId,
      MESSAGE: 'Your requested reports have been generated and are ready for download.',
      ATTACH: this.formatReportAttachment(reports)
    });
  }
}
\`\`\`

### Pattern 3: Bulk Operations with Progress Tracking

\`\`\`javascript
async performBulkOperations(operations) {
  const totalOperations = operations.length;
  const batchSize = 10;
  const results = [];
  
  for (let i = 0; i < operations.length; i += batchSize) {
    const batch = operations.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(op => this.executeOperation(op))
    );
    
    // Process results and handle failures
    batchResults.forEach((result, index) => {
      const operation = batch[index];
      if (result.status === 'fulfilled') {
        results.push({
          operation: operation.id,
          success: true,
          result: result.value
        });
      } else {
        results.push({
          operation: operation.id,
          success: false,
          error: result.reason.message
        });
        
        this.log('warn', 'Bulk operation failed', {
          operationId: operation.id,
          error: result.reason.message
        });
      }
    });
    
    // Update progress
    const completed = Math.min(i + batchSize, totalOperations);
    const progress = (completed / totalOperations) * 100;
    await this.updateProgress(
      progress,
      \`Completed \${completed}/\${totalOperations} operations (\${results.filter(r => r.success).length} successful)\`,
      'bulk_operations'
    );
  }
  
  return results;
}
\`\`\`

## Error Recovery and Resilience Patterns

### Exponential Backoff with Circuit Breaker

\`\`\`javascript
class APICircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureThreshold = threshold;
    this.timeout = timeout;
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
  }
  
  async execute(apiCall) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime < this.timeout) {
        throw new Error('Circuit breaker is OPEN');
      } else {
        this.state = 'HALF_OPEN';
      }
    }
    
    try {
      const result = await apiCall();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }
  
  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

// Usage in task execution
async executionWithResilience() {
  const circuitBreaker = new APICircuitBreaker();
  
  const apiCall = () => this.callAPI('crm.company.list', {
    filter: this.buildFilter(),
    select: this.getRequiredFields()
  });
  
  try {
    const result = await circuitBreaker.execute(apiCall);
    return result;
  } catch (error) {
    if (error.message === 'Circuit breaker is OPEN') {
      // Use cached data or alternative approach
      return await this.useCachedDataFallback();
    }
    throw error;
  }
}
\`\`\`

## Performance Optimization Patterns

### Parallel Processing with Resource Management

\`\`\`javascript
async processEntitiesInParallel(entities, processingFunction, maxConcurrency = 5) {
  const semaphore = new Semaphore(maxConcurrency);
  const results = [];
  
  const processEntity = async (entity) => {
    await semaphore.acquire();
    try {
      const result = await processingFunction(entity);
      return result;
    } finally {
      semaphore.release();
    }
  };
  
  const promises = entities.map(entity => processEntity(entity));
  const settledResults = await Promise.allSettled(promises);
  
  settledResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      this.log('warn', 'Entity processing failed', {
        entityId: entities[index].ID,
        error: result.reason.message
      });
    }
  });
  
  return results;
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  
  async acquire() {
    return new Promise((resolve) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }
  
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const resolve = this.queue.shift();
      resolve();
    }
  }
}
\`\`\`

## Bluesky API Integration Patterns

### Pattern 1: Prospect Discovery and Analysis Report

**Use Case**: Analyze Bluesky feed to identify and score potential marketing prospects.

**Key Bluesky API Endpoints**:
- \`agent.getTimeline()\` - Fetch home timeline (algorithmic)
- \`agent.getProfile()\` - Get full profile by DID
- \`agent.getSuggestions()\` - Get suggested follows
- \`agent.searchActors()\` - Search profiles by term

**Template Structure**:
\`\`\`javascript
{
  templateId: "bluesky_prospect_discovery",
  name: "Bluesky Prospect Discovery Report",
  description: "Analyzes Bluesky feed and suggested profiles to identify prospects",
  enabled: true,
  category: "bluesky",
  version: "1.0.0",
  parameters: {
    lookbackHours: { type: "number", default: 24 },
    minProspectScore: { type: "number", default: 75 },
    maxProspects: { type: "number", default: 20 },
    includeActivityAnalysis: { type: "boolean", default: true }
  },
  executionScript: \`
    async execute(params, context) {
      const bsky = context.getBskyService();
      const gemini = context.getGeminiService();

      // Initialize Bluesky
      await this.updateProgress(10, 'Connecting to Bluesky...');
      const initialized = await bsky.initialize();
      if (!initialized) {
        throw new Error('Bluesky service not available');
      }

      // Fetch timeline
      await this.updateProgress(20, 'Fetching timeline feed...');
      const timeline = await bsky.getFeed('timeline', 100);

      // Filter by lookback time
      const cutoffTime = new Date(Date.now() - params.lookbackHours * 60 * 60 * 1000);
      const recentPosts = timeline.filter(item => {
        return new Date(item.post.indexedAt) >= cutoffTime;
      });

      this.log('info', 'Timeline fetched', {
        total: timeline.length,
        recent: recentPosts.length
      });

      // Extract unique authors
      await this.updateProgress(30, 'Analyzing authors...');
      const authorMap = new Map();

      for (const item of recentPosts) {
        const did = item.post.author.did;
        if (!authorMap.has(did)) {
          authorMap.set(did, {
            author: item.post.author,
            posts: []
          });
        }
        authorMap.get(did).posts.push(item.post);
      }

      // Fetch full profiles and analyze
      await this.updateProgress(50, 'Evaluating prospects...');
      const prospects = [];
      const authors = Array.from(authorMap.values()).slice(0, 40); // Limit batch

      for (const { author, posts } of authors) {
        try {
          // Get full profile
          const profile = await bsky.getProfile(author.did);

          // AI prospect evaluation
          const evaluation = await this.evaluateProspect(
            profile,
            posts,
            gemini
          );

          if (evaluation.score >= params.minProspectScore) {
            prospects.push({
              profile,
              posts: posts.slice(0, 5), // Limit posts in report
              score: evaluation.score,
              reason: evaluation.reason,
              buyingSignals: evaluation.buyingSignals
            });
          }
        } catch (error) {
          this.log('warn', 'Profile fetch failed', { did: author.did });
        }
      }

      // Sort by score
      prospects.sort((a, b) => b.score - a.score);
      const topProspects = prospects.slice(0, params.maxProspects);

      await this.updateProgress(90, 'Generating report...');

      // Generate HTML report
      const reportData = {
        prospects: topProspects,
        lookbackHours: params.lookbackHours,
        postsAnalyzed: recentPosts.length,
        authorsAnalyzed: authorMap.size,
        generatedAt: new Date().toISOString()
      };

      const html = this.generateHTMLReport(reportData, params);

      await this.updateProgress(100, 'Complete!');

      return {
        html,
        summary: \\\`Found \\\${topProspects.length} qualified prospects from \\\${authorMap.size} authors\\\`
      };
    }

    async evaluateProspect(profile, posts, gemini) {
      const prompt = \\\`Evaluate this Bluesky user as a marketing prospect (0-100):

Profile:
- Handle: @\\\${profile.handle}
- Bio: \\\${profile.description || 'No bio'}
- Followers: \\\${profile.followersCount}

Recent Posts:
\\\${posts.slice(0, 3).map(p => \\\`- "\\\${p.record.text}"\\\`).join('\\\\n')}

Score 0-100 and identify buying signals.

Respond with JSON:
{ "score": 75, "reason": "...", "buyingSignals": ["signal1"] }\\\`;

      const response = await gemini.generateResponse(prompt, {
        temperature: 0.3,
        maxTokens: 300
      });

      const jsonMatch = response.match(/\\{[\\s\\S]*\\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return { score: 0, reason: 'Failed to parse', buyingSignals: [] };
    }

    generateHTMLReport(reportData, params) {
      const { prospects, lookbackHours, postsAnalyzed, authorsAnalyzed, generatedAt } = reportData;

      return \\\`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Bluesky Prospect Discovery Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f8fa; }
    .header { background: #1DA1F2; color: white; padding: 20px; border-radius: 8px; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
    .stat-card { background: white; padding: 15px; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .prospect { background: white; padding: 20px; margin: 15px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .score { font-size: 24px; font-weight: bold; color: #1DA1F2; }
    .posts { margin-top: 15px; padding-left: 20px; }
    .post { margin: 8px 0; color: #555; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎯 Bluesky Prospect Discovery Report</h1>
    <p>Generated: \\\${new Date(generatedAt).toLocaleString()}</p>
  </div>

  <div class="stats">
    <div class="stat-card">
      <h3>\\\${postsAnalyzed}</h3>
      <p>Posts Analyzed</p>
    </div>
    <div class="stat-card">
      <h3>\\\${authorsAnalyzed}</h3>
      <p>Unique Authors</p>
    </div>
    <div class="stat-card">
      <h3>\\\${prospects.length}</h3>
      <p>Qualified Prospects</p>
    </div>
    <div class="stat-card">
      <h3>\\\${lookbackHours}h</h3>
      <p>Time Window</p>
    </div>
  </div>

  <h2>Top Prospects</h2>
  \\\${prospects.slice(0, 10).map((prospect, idx) => \\\`
    <div class="prospect">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div>
          <h3>\\\${idx + 1}. @\\\${prospect.profile.handle}</h3>
          <p><strong>\\\${prospect.profile.displayName || 'No display name'}</strong></p>
        </div>
        <div class="score">\\\${prospect.score}/100</div>
      </div>

      <p><strong>Bio:</strong> \\\${prospect.profile.description || 'No bio'}</p>
      <p><strong>Stats:</strong> \\\${prospect.profile.followersCount} followers, \\\${prospect.posts.length} recent posts</p>
      <p><strong>Why:</strong> \\\${prospect.reason}</p>

      \\\${prospect.buyingSignals.length > 0 ? \\\`
        <p><strong>🚨 Buying Signals:</strong> \\\${prospect.buyingSignals.join(', ')}</p>
      \\\` : ''}

      <div class="posts">
        <strong>Recent Posts:</strong>
        \\\${prospect.posts.slice(0, 3).map(post => \\\`
          <div class="post">
            "\\\${post.record.text.substring(0, 150)}\\\${post.record.text.length > 150 ? '...' : ''}"
            <br><small>\\\${post.likeCount} likes, \\\${post.repostCount} reposts</small>
          </div>
        \\\`).join('')}
      </div>

      <p><a href="https://bsky.app/profile/\\\${prospect.profile.handle}" target="_blank">View Profile →</a></p>
    </div>
  \\\`).join('')}
</body>
</html>\\\`;
    }
  \`
}
\`\`\`

### Pattern 2: Content Publishing with Analytics

**Use Case**: Post content to Bluesky with embedded links/images and track engagement.

**Key Bluesky API Endpoints**:
- \`agent.post()\` - Create post
- \`agent.uploadBlob()\` - Upload images
- \`RichText.detectFacets()\` - Auto-detect mentions and links

**Template Structure**:
\`\`\`javascript
{
  templateId: "bluesky_content_publisher",
  name: "Bluesky Content Publisher",
  description: "Posts content to Bluesky with rich formatting and tracking",
  executionScript: \`
    async execute(params, context) {
      const bsky = context.getBskyService();
      const { RichText } = require('@atproto/api');

      await this.updateProgress(20, 'Connecting to Bluesky...');
      await bsky.initialize();

      // Prepare rich text with auto-detection
      const rt = new RichText({
        text: params.content
      });

      await this.updateProgress(40, 'Processing mentions and links...');
      await rt.detectFacets(bsky.agent);

      // Upload image if provided
      let embed = undefined;
      if (params.imageUrl) {
        await this.updateProgress(60, 'Uploading image...');
        const imageBuffer = await this.downloadImage(params.imageUrl);
        const { data } = await bsky.agent.uploadBlob(imageBuffer, {
          encoding: 'image/jpeg'
        });

        embed = {
          $type: 'app.bsky.embed.images',
          images: [{
            image: data.blob,
            alt: params.imageAlt || 'Image'
          }]
        };
      }

      // Create post
      await this.updateProgress(80, 'Publishing post...');
      const post = await bsky.agent.post({
        text: rt.text,
        facets: rt.facets,
        embed,
        langs: ['en']
      });

      this.log('info', 'Post created', { uri: post.uri });

      await this.updateProgress(100, 'Published!');

      return {
        html: this.generateHTMLReport({ post, content: params.content }, params),
        summary: \\\`Posted to Bluesky: \\\${post.uri}\\\`
      };
    }
  \`
}
\`\`\`

### Bluesky-Specific Considerations

**Rate Limiting**:
- 5,000 points per 5 minutes per DID
- Read operations: 1 point
- Create operations: 3 points
- Implement exponential backoff on 429 errors

**Error Handling**:
\`\`\`javascript
try {
  const profile = await bsky.agent.getProfile({ actor: did });
} catch (error) {
  if (error.status === 429) {
    // Rate limited - wait and retry
    await new Promise(resolve => setTimeout(resolve, 60000));
    // Retry...
  } else if (error.status === 401) {
    // Session expired - re-authenticate
    await bsky.initialize();
    // Retry...
  }
}
\`\`\`

**Data Storage**:
- Always store DIDs (permanent), not handles (can change)
- Cache profile data to reduce API calls (TTL: 1 hour)
- Use Firestore collections: \`bluesky-prospects\`, \`bluesky-followed-profiles\`

This advanced patterns guide provides sophisticated techniques for building robust, performant, and resilient complex tasks that handle real-world scenarios effectively.
`;

const knowledgeBaseEntries = [
  {
    title: 'Create Complex Tasks Guide - Comprehensive Agentic Task Creation',
    content: complexTaskCreationGuide,
    category: 'system_information',
    tags: ['complex-tasks', 'agentic', 'bitrix24', 'api', 'cloud-tasks', 'html-generation', 'system'],
    searchTerms: [
      'agentic task creation', 'complex task development', 'bitrix24 api integration',
      'cloud tasks execution', 'html report generation', 'executionScript patterns',
      'task testing framework', 'bitrix24 crm endpoints', 'document generator',
      'news feed api', 'chat endpoints', 'collab endpoints', 'javascript execution',
      'BaseTaskExecutor', 'progress tracking', 'error handling', 'performance optimization'
    ],
    priority: 95,
    enabled: true
  },
  {
    title: 'Advanced Complex Task Patterns and Resilience Strategies',
    content: advancedPatternsGuide,
    category: 'system_information', 
    tags: ['advanced-patterns', 'bulk-operations', 'error-recovery', 'performance', 'resilience', 'system'],
    searchTerms: [
      'bulk operations', 'error recovery patterns', 'circuit breaker', 'exponential backoff',
      'parallel processing', 'resource management', 'multi-api integration',
      'document distribution', 'performance optimization', 'semaphore pattern',
      'api resilience', 'failure handling', 'concurrent processing'
    ],
    priority: 90,
    enabled: true
  }
];

module.exports = {
  knowledgeBaseEntries
};