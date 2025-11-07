/**
 * Tool Access Control Configuration (RBAC)
 *
 * Maps tool names to allowed user roles.
 * This is the central configuration for role-based access control.
 *
 * SECURITY:
 * - Tools not in this config will default to admin-only (fail-secure)
 * - Tool names MUST match the tool class name (not filename)
 * - Roles: 'user' (all users), 'admin' (administrators only)
 *
 * VALIDATION:
 * - Validated on service startup (lib/toolLoader.js)
 * - Warnings logged for tools not in config
 * - Unknown tools default to admin-only access
 */

const TOOL_ACCESS_CONTROL = {
  // ===== ALL USERS =====
  // General communication and information tools

  // Bitrix24 tools (only if ENABLE_BITRIX24_INTEGRATION=true)
  BitrixChatSummary: ['user', 'admin'],

  // Asana tools (only if ENABLE_ASANA_INTEGRATION=true)
  AsanaTaskManager: ['user', 'admin'],

  // General tools (always available)
  DrawioGenerator: ['user', 'admin'],
  GoogleMapsPlaces: ['user', 'admin'],
  weather: ['user', 'admin'],
  WebBrowser: ['user', 'admin'],
  WebSearch: ['user', 'admin'],

  // ===== ADMIN ONLY =====
  // Tools that create/modify data or access sensitive information

  // Bitrix24 admin tools (only if ENABLE_BITRIX24_INTEGRATION=true)
  BitrixUserManagement: ['admin'],

  // General admin tools (always available)
  ComplexTaskManager: ['admin'],
  KnowledgeManagement: ['admin'],
  SimpleTaskCreator: ['admin'],
  TaskManagement: ['admin'],
  TaskTemplateManager: ['admin']
};

/**
 * Get allowed roles for a tool
 * @param {string} toolName - Tool name (from tool.name property)
 * @returns {Array<string>|null} Array of allowed roles or null if not configured
 */
function getAllowedRoles(toolName) {
  return TOOL_ACCESS_CONTROL[toolName] || null;
}

/**
 * Check if a tool is accessible by a given role
 * @param {string} toolName - Tool name
 * @param {string} userRole - User role ('user' or 'admin')
 * @returns {boolean} True if role has access
 */
function hasAccess(toolName, userRole = 'user') {
  // Normalize role to 'user' for null/undefined/invalid values (fail-safe)
  const normalizedRole = (userRole === 'admin' || userRole === 'user') ? userRole : 'user';

  const allowedRoles = TOOL_ACCESS_CONTROL[toolName];

  // If tool not in config, default to admin-only (fail-secure)
  if (!allowedRoles) {
    return normalizedRole === 'admin';
  }

  return allowedRoles.includes(normalizedRole);
}

/**
 * Get all tools accessible by a role
 * @param {string} userRole - User role ('user' or 'admin')
 * @returns {Array<string>} Array of accessible tool names
 */
function getToolsForRole(userRole = 'user') {
  return Object.keys(TOOL_ACCESS_CONTROL).filter(toolName =>
    TOOL_ACCESS_CONTROL[toolName].includes(userRole)
  );
}

/**
 * Validate tool access control configuration
 * Logs warnings for potential issues
 * @param {Array<string>} registeredToolNames - Tool names from registry
 * @param {Object} logger - Logger instance
 */
function validateConfiguration(registeredToolNames, logger) {
  const configuredTools = Object.keys(TOOL_ACCESS_CONTROL);
  const registeredSet = new Set(registeredToolNames);
  const configuredSet = new Set(configuredTools);

  // Find tools in registry but not in config
  const unconfiguredTools = registeredToolNames.filter(name => !configuredSet.has(name));
  if (unconfiguredTools.length > 0) {
    logger.warn('Tools not in access control config (defaulting to admin-only)', {
      tools: unconfiguredTools,
      count: unconfiguredTools.length
    });
  }

  // Find tools in config but not in registry
  const unregisteredTools = configuredTools.filter(name => !registeredSet.has(name));
  if (unregisteredTools.length > 0) {
    logger.warn('Tools in access control config but not registered', {
      tools: unregisteredTools,
      count: unregisteredTools.length,
      note: 'These may be disabled or not loaded'
    });
  }

  logger.info('Tool access control configuration validated', {
    totalConfigured: configuredTools.length,
    totalRegistered: registeredToolNames.length,
    adminOnly: getToolsForRole('admin').length - getToolsForRole('user').length,
    allUsers: getToolsForRole('user').length
  });
}

module.exports = {
  TOOL_ACCESS_CONTROL,
  getAllowedRoles,
  hasAccess,
  getToolsForRole,
  validateConfiguration
};
