# Security Policy

## Overview

This document outlines the security measures implemented in the Bitrix24 Gemini AI Agent to ensure safe and secure operation in production environments.

## Security Architecture

### 1. OWASP API Security Top 10 Compliance

Our application implements comprehensive protection against all OWASP API Security risks:

#### API1:2023 - Broken Object Level Authorization
- **Implementation**: Object-level authorization middleware
- **Protection**: Users can only access their own resources
- **Location**: `middleware/security.js` - `objectLevelAuth()`

#### API2:2023 - Broken Authentication
- **Implementation**: JWT-based authentication with bcrypt password hashing
- **Protection**: Secure token validation, account lockout after 5 failed attempts
- **Location**: `services/auth.js`, `middleware/auth.js`

#### API3:2023 - Broken Object Property Level Authorization
- **Implementation**: Property-level authorization middleware
- **Protection**: Field-level input validation and restrictions
- **Location**: `middleware/security.js` - `propertyLevelAuth()`

#### API4:2023 - Unrestricted Resource Consumption
- **Implementation**: Multi-tier rate limiting
- **Protection**:
  - General API: 100 requests/15min
  - Authentication: 5 requests/15min
  - Sensitive operations: 5 requests/15min
- **Location**: `middleware/security.js` - Rate limiting middleware

#### API5:2023 - Broken Function Level Authorization
- **Implementation**: Role-based access control
- **Protection**: Admin-only operations properly protected
- **Location**: `middleware/security.js` - `functionLevelAuth()`

#### API6:2023 - Unrestricted Access to Sensitive Business Flows
- **Implementation**: Business flow monitoring
- **Protection**: Suspicious pattern detection and logging
- **Location**: `middleware/security.js` - `businessFlowProtection()`

#### API7:2023 - Server Side Request Forgery (SSRF)
- **Implementation**: URL validation and private IP blocking
- **Protection**: Blocks localhost, private IP ranges, dangerous protocols
- **Location**: `middleware/security.js` - `ssrfProtection()`

#### API8:2023 - Security Misconfiguration
- **Implementation**: Comprehensive security headers
- **Protection**: CSP, HSTS, X-Frame-Options, etc.
- **Location**: `middleware/security.js` - `securityHeaders()`

#### API9:2023 - Improper Inventory Management
- **Implementation**: API versioning and usage tracking
- **Protection**: Comprehensive logging of all API access
- **Location**: `middleware/security.js` - `apiVersioning()`

#### API10:2023 - Unsafe Consumption of APIs
- **Implementation**: Output validation and data masking
- **Protection**: Sensitive data filtering in responses
- **Location**: `middleware/security.js` - `outputValidation()`

### 2. Authentication & Authorization

#### JWT Authentication
- **Algorithm**: HS256 with secure secret generation
- **Expiration**: Configurable (default 24h)
- **Storage**: Secure HTTP-only cookies recommended for web clients

#### Password Security
- **Hashing**: bcrypt with salt rounds = 10
- **Strength Requirements**: 8+ chars, uppercase, lowercase, number, special char
- **Account Lockout**: 5 failed attempts triggers lockout

#### Role-Based Access Control
- **Roles**: `admin`, `user`
- **Admin Operations**: Personality management, user creation, system configuration
- **User Operations**: Basic API access, personal data management

### 3. Input Validation & Sanitization

#### XSS Prevention
- **Input Sanitization**: All user inputs sanitized using security utilities
- **Output Encoding**: Automatic encoding of dynamic content
- **CSP Headers**: Strict Content Security Policy implementation

#### SQL Injection Prevention
- **Parameterized Queries**: All database operations use parameterized queries
- **Input Validation**: Joi schema validation for all inputs
- **Pattern Blocking**: Automatic detection and blocking of SQL injection attempts

#### Path Traversal Prevention
- **File Path Validation**: Strict validation of all file paths
- **Directory Restrictions**: Access limited to approved directories only

### 4. Data Protection

#### Encryption
- **In Transit**: TLS 1.2+ enforced for all communications
- **At Rest**: Firestore encryption for sensitive data
- **Secrets**: Environment variables for all sensitive configuration

#### Data Masking
- **Logging**: Sensitive data automatically masked in logs
- **API Responses**: Personal information filtered from error messages
- **Debug Information**: No sensitive data in debug outputs

### 5. Network Security

#### CORS Configuration
- **Origin Restrictions**: Configurable allowed origins
- **Credential Handling**: Secure credential management
- **Header Controls**: Strict allowed headers policy

#### Request Size Limits
- **Body Size**: 10MB maximum request size
- **JSON Bomb Protection**: Validation during parsing
- **Memory Usage**: Monitoring and limits on object depth

### 6. Monitoring & Logging

#### Security Event Logging
- **Authentication Events**: All login attempts, failures, lockouts
- **Authorization Violations**: Unauthorized access attempts
- **Rate Limit Violations**: Excessive request patterns
- **Suspicious Activities**: Pattern-based threat detection

#### Audit Trail
- **Modification Operations**: All POST/PUT/PATCH/DELETE operations logged
- **User Actions**: Comprehensive user activity tracking
- **System Events**: Service startup, configuration changes

### 7. OWASP LLM Top 10 2025 Compliance

This application implements comprehensive protections against LLM-specific security risks:

#### LLM01:2025 - Prompt Injection
- **Implementation**: Multi-layered prompt injection detection
- **Protection**:
  - Pattern-based detection of system prompt manipulation attempts
  - Role manipulation attempt blocking
  - Jailbreak pattern detection (DAN mode, developer mode, sudo mode)
  - Code execution injection prevention
- **Location**: `utils/contextSanitizer.js` - `detectPromptInjection()`, `sanitizeUserInput()`
- **Monitoring**: All injection attempts logged for security analysis

#### LLM02:2025 - Sensitive Information Disclosure
- **Implementation**: Context sanitization before ALL AI API calls
- **Protection**:
  - API keys, secrets, tokens automatically redacted
  - PII (SSN, credit cards) masked before transmission
  - Database connection strings sanitized
  - JWT tokens redacted from context
  - Conversation history sanitized before sending to external AI services
  - System prompts scrubbed of sensitive data
- **Location**:
  - `services/gemini.js:96-131` - Universal sanitization before tool detection
  - `utils/contextSanitizer.js` - Sanitization patterns and methods
  - `utils/contextValidator.js` - Context structure validation
- **Coverage**: Both tool execution path AND direct AI calls protected

#### LLM03:2025 - Training Data Poisoning
- **Implementation**: Knowledge base content validation
- **Protection**:
  - Document content sanitization before indexing
  - Tag validation and sanitization
  - Priority-based document access controls
- **Location**: `utils/contextSanitizer.js` - `sanitizeKnowledgeResults()`

#### LLM04:2025 - Model Denial of Service
- **Implementation**: VM execution sandbox with strict validation
- **Protection**:
  - Infinite loop detection (while(true), for(;;))
  - Resource exhaustion prevention (massive arrays, buffer allocation)
  - Zero-interval timer blocking
  - String repeat DoS prevention
  - Script size limits (50KB max)
  - Execution timeouts (5 seconds compilation, 12 minutes execution)
- **Location**: `services/taskTemplateLoader.js:1213-1252` - `validateExecutionScript()`

#### LLM05:2025 - Supply Chain Vulnerabilities
- **Implementation**: Restricted module access in VM context
- **Protection**:
  - Whitelist-only module loading
  - Allowed modules: axios, lodash, moment, internal utilities
  - Blocked modules: fs, child_process, net, http, vm, cluster, worker_threads
- **Location**: `services/taskTemplateLoader.js:242-293` - `createSecureContext()`

#### LLM06:2025 - Sensitive Information Disclosure (Output)
- **Implementation**: Output validation and filtering
- **Protection**:
  - Response sanitization before delivery
  - Error message filtering (no stack traces to users)
  - Debug information scrubbed from production responses
- **Location**: `middleware/security.js` - `outputValidation()`

#### LLM07:2025 - System Prompt Leakage
- **Implementation**: System prompt sanitization and protection
- **Protection**:
  - Detection of prompt extraction attempts
  - System prompts sanitized before transmission
  - "Show your instructions" patterns blocked
- **Location**: `utils/contextSanitizer.js` - Prompt injection patterns

#### LLM08:2025 - Vector and Embedding Weaknesses
- **Implementation**: Knowledge base security
- **Protection**:
  - Embedding input sanitization
  - Search result filtering
  - Relevance score validation
- **Location**: `services/knowledgeBase.js`

#### LLM09:2025 - Misinformation
- **Implementation**: Response accuracy monitoring
- **Protection**:
  - API endpoint hallucination prevention (whitelist of 17 allowed endpoints)
  - Auto-repair system for invalid API calls
  - Knowledge base grounding for critical operations
- **Location**: `services/taskTemplateLoader.js` - Knowledge base grounding

#### LLM10:2025 - Unbounded Consumption
- **Implementation**: Resource limits and monitoring
- **Protection**:
  - Token usage tracking
  - API rate limiting (2 req/sec, 10K req/10min)
  - Exponential backoff on failures
  - Conversation history limits (20 messages max)
  - Knowledge base result limits (5 documents max)
- **Location**:
  - `services/queue.js` - Rate limiting
  - `services/gemini.js` - Conversation limits
  - `utils/contextValidator.js` - Structure size limits

### 8. Infrastructure Security

#### Container Security
- **Non-root User**: Application runs as non-privileged user (nodejs:1001)
- **Minimal Base Image**: Alpine Linux for reduced attack surface
- **Multi-stage Build**: Optimized production image without dev dependencies

#### Cloud Run Security
- **Service Account**: Minimal required permissions
- **Resource Limits**: CPU and memory constraints
- **Network Isolation**: VPC connector for internal communications

## Security Testing

### Automated Testing
- **Security Test Suite**: Comprehensive tests for all security controls
- **Vulnerability Scanning**: Regular dependency audits
- **Code Quality**: ESLint security rules enforcement

### Manual Testing
- **Penetration Testing**: Regular security assessments recommended
- **Code Review**: Security-focused code reviews for all changes
- **Configuration Review**: Regular security configuration audits

## Vulnerability Reporting

### Responsible Disclosure
If you discover a security vulnerability, please report it to:
- **Email**: security@yourcompany.com
- **Response Time**: 72 hours acknowledgment
- **Resolution**: Critical issues resolved within 7 days

### Supported Versions
| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ Yes    |

## Security Checklist for Deployment

### Pre-deployment
- [ ] Change default admin credentials
- [ ] Configure proper JWT secret
- [ ] Set up allowed CORS origins
- [ ] Configure environment variables
- [ ] Run security test suite
- [ ] Perform dependency audit

### Post-deployment
- [ ] Verify HTTPS enforcement
- [ ] Test authentication flows
- [ ] Validate rate limiting
- [ ] Monitor security logs
- [ ] Set up alerting

### Maintenance
- [ ] Regular dependency updates
- [ ] Security log review
- [ ] Performance monitoring
- [ ] Backup verification
- [ ] Access review

## Security Configuration

### Environment Variables
```bash
# Authentication
JWT_SECRET=your-secure-secret-here
JWT_EXPIRES_IN=24h

# Rate Limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Logging
LOG_LEVEL=info
SECURITY_AUDIT_ENABLED=true
```

### Security Headers
The application automatically sets these security headers:
- `Strict-Transport-Security`
- `X-Content-Type-Options`
- `X-Frame-Options`
- `X-XSS-Protection`
- `Content-Security-Policy`
- `Referrer-Policy`

## Compliance

This application follows security best practices from:
- **OWASP Top 10 API Security Risks 2023** - Full compliance
- **OWASP LLM Top 10 2025** - Full compliance with all LLM-specific security controls
- **NIST Cybersecurity Framework** - Identity, Protect, Detect, Respond, Recover
- **Google Cloud Security Best Practices** - Infrastructure and service security
- **Node.js Security Best Practices** - Secure coding and dependency management

### LLM Security Highlights
- ✅ **Zero Unsanitized AI Calls**: All data sanitized before transmission to external AI services
- ✅ **Prompt Injection Defense**: Multi-pattern detection with logging
- ✅ **PII Protection**: Automatic redaction of sensitive personal information
- ✅ **VM Sandbox Security**: AI-generated code executed in isolated, validated contexts
- ✅ **Resource Limits**: Comprehensive DoS prevention with timeouts and size limits
- ✅ **Audit Trail**: All security events logged for compliance and forensics

## Contact

For security-related questions or concerns:
- **Technical Lead**: [Your Name]
- **Security Team**: security@yourcompany.com
- **Documentation**: [Internal Security Wiki]