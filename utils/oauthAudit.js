/**
 * OAuth Audit Logger
 * 
 * Enterprise-grade audit logging for all OAuth events.
 * Logs are structured for easy querying and compliance.
 * 
 * LOGGED EVENTS:
 * - OAUTH_START: User initiated OAuth flow
 * - OAUTH_CALLBACK: OAuth callback received
 * - OAUTH_SUCCESS: Token exchange successful
 * - OAUTH_FAILURE: OAuth flow failed
 * - TOKEN_REFRESH: Token refreshed
 * - TOKEN_REFRESH_FAILURE: Token refresh failed
 * - TOKEN_REVOKE: Token revoked
 * - INTEGRATION_DISCONNECT: Integration disconnected
 * 
 * SECURITY NOTES:
 * - Never log actual tokens
 * - Mask sensitive data
 * - Include request metadata for forensics
 */

const fs = require('fs');
const path = require('path');

// Log directory
const LOG_DIR = path.join(__dirname, '..', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Log levels
const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  AUDIT: 'AUDIT'
};

/**
 * Get current timestamp in ISO format
 */
const getTimestamp = () => new Date().toISOString();

/**
 * Mask sensitive data for logging
 * @param {string} value - Value to mask
 * @param {number} visibleChars - Number of chars to show at start/end
 */
const mask = (value, visibleChars = 4) => {
  if (!value) return '[null]';
  if (value.length <= visibleChars * 2) return '***';
  return `${value.substring(0, visibleChars)}...${value.substring(value.length - visibleChars)}`;
};

/**
 * Extract request metadata for logging
 * @param {Object} req - Express request object
 */
const getRequestMeta = (req) => {
  if (!req) return {};
  
  return {
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: (req.headers?.['user-agent'] || '').substring(0, 200),
    origin: req.headers?.origin || req.headers?.referer,
    method: req.method,
    path: req.path
  };
};

/**
 * Write log entry to file
 * @param {Object} entry - Log entry
 */
const writeLog = (entry) => {
  const filename = `oauth-audit-${new Date().toISOString().split('T')[0]}.log`;
  const filepath = path.join(LOG_DIR, filename);
  const line = JSON.stringify(entry) + '\n';
  
  try {
    fs.appendFileSync(filepath, line);
  } catch (error) {
    console.error('Failed to write audit log:', error.message);
  }
  
  // Also log to console in development
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[OAUTH_AUDIT] ${entry.event}:`, entry);
  }
};

/**
 * Log OAuth flow start
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {string} params.provider - OAuth provider
 * @param {Object} params.req - Express request
 */
const logOAuthStart = ({ userId, provider, req }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: LOG_LEVELS.AUDIT,
    event: 'OAUTH_START',
    userId,
    provider,
    request: getRequestMeta(req)
  });
};

/**
 * Log OAuth callback received
 * @param {Object} params
 * @param {string} params.provider - OAuth provider
 * @param {boolean} params.hasCode - Whether code was present
 * @param {boolean} params.hasState - Whether state was present
 * @param {Object} params.req - Express request
 */
const logOAuthCallback = ({ provider, hasCode, hasState, req }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: LOG_LEVELS.AUDIT,
    event: 'OAUTH_CALLBACK',
    provider,
    hasCode,
    hasState,
    request: getRequestMeta(req)
  });
};

/**
 * Log OAuth success
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {string} params.provider - OAuth provider
 * @param {boolean} params.hasRefreshToken - Whether refresh token was received
 * @param {Array} params.scopes - Granted scopes
 * @param {Object} params.metadata - Provider metadata (safe to log)
 */
const logOAuthSuccess = ({ userId, provider, hasRefreshToken, scopes, metadata }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: LOG_LEVELS.AUDIT,
    event: 'OAUTH_SUCCESS',
    userId,
    provider,
    hasRefreshToken,
    scopes,
    metadata: {
      workspaceName: metadata?.workspaceName,
      teamName: metadata?.teamName,
      accountId: mask(metadata?.accountId)
    }
  });
};

/**
 * Log OAuth failure
 * @param {Object} params
 * @param {string} params.userId - User ID (if known)
 * @param {string} params.provider - OAuth provider
 * @param {string} params.error - Error message
 * @param {string} params.stage - Where failure occurred
 * @param {Object} params.req - Express request
 */
const logOAuthFailure = ({ userId, provider, error, stage, req }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: LOG_LEVELS.ERROR,
    event: 'OAUTH_FAILURE',
    userId: userId || 'unknown',
    provider,
    error,
    stage,
    request: getRequestMeta(req)
  });
};

/**
 * Log token refresh
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {string} params.provider - OAuth provider
 * @param {boolean} params.success - Whether refresh succeeded
 * @param {string} params.error - Error message (if failed)
 */
const logTokenRefresh = ({ userId, provider, success, error }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: success ? LOG_LEVELS.AUDIT : LOG_LEVELS.ERROR,
    event: success ? 'TOKEN_REFRESH' : 'TOKEN_REFRESH_FAILURE',
    userId,
    provider,
    success,
    error: error || null
  });
};

/**
 * Log token revocation
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {string} params.provider - OAuth provider
 * @param {boolean} params.success - Whether revocation succeeded
 * @param {Object} params.req - Express request
 */
const logTokenRevoke = ({ userId, provider, success, req }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: LOG_LEVELS.AUDIT,
    event: 'TOKEN_REVOKE',
    userId,
    provider,
    success,
    request: getRequestMeta(req)
  });
};

/**
 * Log integration disconnect
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {string} params.provider - OAuth provider
 * @param {string} params.reason - Reason for disconnect
 * @param {Object} params.req - Express request
 */
const logIntegrationDisconnect = ({ userId, provider, reason, req }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: LOG_LEVELS.AUDIT,
    event: 'INTEGRATION_DISCONNECT',
    userId,
    provider,
    reason,
    request: getRequestMeta(req)
  });
};

/**
 * Log state validation events
 * @param {Object} params
 * @param {boolean} params.valid - Whether state was valid
 * @param {string} params.reason - Validation failure reason
 * @param {Object} params.req - Express request
 */
const logStateValidation = ({ valid, reason, req }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: valid ? LOG_LEVELS.INFO : LOG_LEVELS.WARN,
    event: 'STATE_VALIDATION',
    valid,
    reason: reason || null,
    request: getRequestMeta(req)
  });
};

/**
 * Log security event (suspicious activity)
 * @param {Object} params
 * @param {string} params.type - Type of security event
 * @param {string} params.description - Description
 * @param {Object} params.data - Additional data
 * @param {Object} params.req - Express request
 */
const logSecurityEvent = ({ type, description, data, req }) => {
  writeLog({
    timestamp: getTimestamp(),
    level: LOG_LEVELS.WARN,
    event: 'SECURITY_EVENT',
    type,
    description,
    data,
    request: getRequestMeta(req)
  });
};

module.exports = {
  logOAuthStart,
  logOAuthCallback,
  logOAuthSuccess,
  logOAuthFailure,
  logTokenRefresh,
  logTokenRevoke,
  logIntegrationDisconnect,
  logStateValidation,
  logSecurityEvent,
  mask
};
