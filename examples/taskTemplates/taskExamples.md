# Task Execution Examples

This document shows how to use the Child Thread Task Execution system with real examples.

## Example 1: Bitrix24 Open Invoices Report

### User Messages That Would Trigger
```
"Generate a report of all open invoices"
"Create Bitrix24 open invoices report"
"Show me outstanding invoices from the last 90 days"
"I need a report of unpaid invoices with customer details"
```

### What Happens Behind the Scenes

1. **Tool Detection**: `ComplexTaskManagerTool` detects the request (priority 40)
2. **Template Matching**: Finds `bitrix_open_invoices_old_report` template
3. **Parameter Extraction**: Gemini AI extracts/calculates:
   ```json
   {
     "dateRange": {
       "start": "2024-07-10",  // 90 days ago
       "end": "2024-10-08"     // today
     },
     "invoiceStatuses": ["N", "S"],
     "includeActivities": true,
     "activityLimit": 3
   }
   ```
4. **Task Creation**: Creates task in Firestore
5. **Worker Assignment**: Assigns to available `BasicTaskWorker`
6. **Execution**: Worker runs the template script with progress updates

### Expected Chantilly Response
```
✅ Task created using template: Bitrix24 Open Invoices (Old) Report

**Task ID:** task_1728434567890_abc123
**Template:** Bitrix24 Open Invoices (Old) Report
**Estimated Duration:** 8m 0s
**Steps:** 8
**Complexity:** medium

*Your task is now queued for execution. Use task status "task_1728434567890_abc123" to monitor progress.*
```

### Checking Task Status
```
User: "task status task_1728434567890_abc123"
```

**Chantilly Response:**
```
🔄 **Task Status: RUNNING**

**Task ID:** task_1728434567890_abc123
**Template:** bitrix_open_invoices_old_report
**Created:** 10/8/2024, 3:30:15 PM
**Progress:** 65%
**Current Step:** Fetching company information
**Step:** 5/8
**Worker:** worker_1728434567890_def456
```

### Completed Task Response
```
✅ **Task Status: COMPLETED**

**Task ID:** task_1728434567890_abc123
**Template:** bitrix_open_invoices_old_report  
**Created:** 10/8/2024, 3:30:15 PM
**Progress:** 100%
**Current Step:** Open invoices report completed

**📄 Results:**
- Execution Time: 7m 23s
- Summary: Generated report for 47 open invoices
- Attachments: 1 files

[HTML Report would be attached as downloadable file]
```

## Example 2: Quarterly Financial Analysis

### User Message
```
"Generate Q3 2024 comprehensive financial report with trends"
```

### Parameter Extraction by AI
```json
{
  "dateRange": {
    "start": "2024-07-01",
    "end": "2024-09-30"
  },
  "outputFormat": "detailed",
  "includeTrends": true,
  "clientFilters": ["active"]
}
```

## Example 3: Task Management Commands

### Create Specific Task
```
User: "create task bitrix_open_invoices_old_report"
Chantilly: [Shows parameter requirements and examples]
```

### List User Tasks
```
User: "list my tasks"
Chantilly: 📝 **Your Tasks** (3 found)

1. 🔄 **bitrix_open_invoices_old_report**
   ID: `task_1728434567890_abc123`
   Status: running (65%)
   Created: 10/8/2024, 3:30:15 PM

2. ✅ **financial_report_quarterly**
   ID: `task_1728434500000_xyz789`
   Status: completed
   Created: 10/8/2024, 2:15:22 PM

3. ⏳ **client_analysis_comprehensive**
   ID: `task_1728434600000_def456`
   Status: pending
   Created: 10/8/2024, 3:45:30 PM
```

### Cancel Task
```
User: "cancel task task_1728434600000_def456"
Chantilly: 🚫 Task cancelled: task_1728434600000_def456

*The task has been cancelled and will not continue execution.*
```

### Show Available Templates
```
User: "show task templates"
Chantilly: 📋 **Available Task Templates** (3 found)

1. **Bitrix24 Open Invoices (Old) Report**
   ID: `bitrix_open_invoices_old_report`
   Category: financial_reporting
   Description: Generate comprehensive HTML report of open invoices with customer information and activity timeline
   Duration: ~8m 0s

2. **Quarterly Financial Report**
   ID: `financial_report_quarterly`
   Category: financial_reporting
   Description: Generate comprehensive quarterly financial reports with client analysis and trend insights
   Duration: ~15m 0s

3. **Comprehensive Client Portfolio Analysis**
   ID: `client_analysis_comprehensive`
   Category: client_management
   Description: Deep analysis of client portfolio with engagement metrics, revenue trends, and growth opportunities
   Duration: ~10m 0s
```

## Integration with Existing Chantilly Tools

The task system works alongside existing tools:

1. **Knowledge Search First**: `KnowledgeManagementTool` (priority 100) searches first
2. **Web Search**: `WebSearchTool` (priority 80) for current information  
3. **Complex Tasks**: `ComplexTaskManagerTool` (priority 40) for multi-step operations
4. **Simple Tools**: Weather, translation, etc. (priority 30 and below)

This ensures simple operations execute immediately while complex operations create trackable tasks.

## File Structure for Tasks

```
/task-templates/          # Firestore collection
  - bitrix_open_invoices_old_report
  - financial_report_quarterly
  - client_analysis_comprehensive

/task-queue/              # Firestore collection  
  - task_1728434567890_abc123
  - task_1728434500000_xyz789

/worker-processes/        # Firestore collection
  - worker_1728434567890_def456
  - worker_1728434600000_ghi789
```

## Next Steps

To test the system:
1. Add the template to Firestore: `task-templates/bitrix_open_invoices_old_report`
2. Start a worker process: `node workers/basicTaskWorker.js`
3. Say to Chantilly: `"Generate a report of all open invoices"`
4. Monitor progress: `"task status [task-id]"`

The system is designed to handle complex, long-running operations while maintaining Chantilly's conversational interface and real-time responsiveness.