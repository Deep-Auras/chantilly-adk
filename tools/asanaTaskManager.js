const BaseTool = require('../lib/baseTool');
const { getAsanaService } = require('../services/asanaService');

class AsanaTaskManager extends BaseTool {
  constructor(context) {
    super(context);
    this.name = 'AsanaTaskManager';
    this.description = 'Create, update, search, and complete tasks in Asana when user EXPLICITLY requests task management operations. Supports project names (e.g., "Liberteks") and section names (e.g., "General To Do"). Use ONLY when user asks to: create/add task, update task, find/search tasks, mark complete, or add comments. DO NOT use for conversational questions about identity, organization info, or general chat. This is strictly for task management operations.';
    this.priority = 80;

    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'search', 'get', 'complete', 'add_comment'],
          description: 'Action to perform'
        },
        projectGid: {
          type: 'string',
          description: 'Project GID (alternative to projectName)'
        },
        projectName: {
          type: 'string',
          description: 'Project name (alternative to projectGid, e.g., "Liberteks")'
        },
        sectionName: {
          type: 'string',
          description: 'Section name within the project (optional, e.g., "General To Do")'
        },
        taskGid: {
          type: 'string',
          description: 'Task GID (required for update, get, complete, add_comment)'
        },
        name: {
          type: 'string',
          description: 'Task name (for create)'
        },
        notes: {
          type: 'string',
          description: 'Task description/notes'
        },
        assignee: {
          type: 'string',
          description: 'Assignee user GID'
        },
        dueDate: {
          type: 'string',
          description: 'Due date (YYYY-MM-DD format)'
        },
        comment: {
          type: 'string',
          description: 'Comment text (for add_comment)'
        },
        searchParams: {
          type: 'object',
          description: 'Search parameters (for search action)'
        }
      },
      required: ['action']
    };
  }

  shouldTrigger() {
    // Semantic trigger - rely on Gemini's function calling to detect task management intent
    // The description clearly articulates when to use this tool conceptually
    // No brittle keyword matching - Gemini understands the CONCEPT of task management

    // This method is primarily for backward compatibility with BaseTool pattern
    // The real semantic detection happens in the description field above
    return false; // Let Gemini's function calling handle all triggering
  }

  async execute(args) {
    const asana = getAsanaService();

    try {
      switch (args.action) {
        case 'create':
          // Resolve project GID from name if needed
          let projectGid = args.projectGid;
          if (!projectGid && args.projectName) {
            const project = await asana.getProjectByName(args.projectName);
            if (!project) {
              return `❌ Project "${args.projectName}" not found`;
            }
            projectGid = project.gid;
            this.log('info', 'Resolved project by name', {
              projectName: args.projectName,
              projectGid
            });
          }

          if (!projectGid) {
            return `❌ Either projectGid or projectName must be provided`;
          }

          // Create the task
          const task = await asana.createTask(projectGid, {
            name: args.name,
            notes: args.notes,
            assignee: args.assignee,
            dueDate: args.dueDate
          });

          // Move to section if specified
          if (args.sectionName) {
            const section = await asana.getSectionByName(projectGid, args.sectionName);
            if (section) {
              await asana.moveTaskToSection(task.gid, section.gid);
              this.log('info', 'Moved task to section', {
                taskGid: task.gid,
                sectionName: args.sectionName,
                sectionGid: section.gid
              });
              return `✅ Created task: ${task.name}\nSection: ${args.sectionName}\nGID: ${task.gid}\nURL: https://app.asana.com/0/${task.gid}`;
            } else {
              return `✅ Created task: ${task.name}\nGID: ${task.gid}\nURL: https://app.asana.com/0/${task.gid}\n⚠️ Warning: Section "${args.sectionName}" not found, task created in default section`;
            }
          }

          return `✅ Created task: ${task.name}\nGID: ${task.gid}\nURL: https://app.asana.com/0/${task.gid}`;

        case 'get':
          const taskDetails = await asana.getTask(args.taskGid);
          return this.formatTaskDetails(taskDetails);

        case 'complete':
          await asana.updateTaskStatus(args.taskGid, true);
          return `✅ Task marked as complete`;

        case 'add_comment':
          await asana.addComment(args.taskGid, args.comment);
          return `✅ Comment added to task`;

        case 'search':
          if (!args.searchParams || typeof args.searchParams !== 'object') {
            return '❌ Search requires valid searchParams object (e.g., {text: "task name", assignee: "user@example.com"})';
          }
          const tasks = await asana.searchTasks(args.searchParams);
          return this.formatTaskList(tasks);

        default:
          return '❌ Unknown action';
      }
    } catch (error) {
      this.log('error', 'Asana tool error', { error: error.message });
      return `❌ Error: ${error.message}`;
    }
  }

  formatTaskDetails(task) {
    let output = `📋 **${task.name}**\n\n`;
    output += `GID: ${task.gid}\n`;
    output += `Status: ${task.completed ? '✅ Complete' : '⏳ In Progress'}\n`;

    if (task.assignee) {
      output += `Assignee: ${task.assignee.name}\n`;
    }

    if (task.due_on) {
      output += `Due: ${task.due_on}\n`;
    }

    if (task.notes) {
      output += `\nDescription:\n${task.notes}\n`;
    }

    output += `\nURL: https://app.asana.com/0/${task.gid}`;
    return output;
  }

  formatTaskList(tasks) {
    if (!tasks || tasks.length === 0) {
      return 'No tasks found';
    }

    let output = `📋 **Found ${tasks.length} tasks:**\n\n`;

    tasks.forEach(task => {
      output += `• ${task.name} (${task.gid})\n`;
    });

    return output;
  }
}

module.exports = AsanaTaskManager;
