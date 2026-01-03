/**
 * Integration Model
 * 
 * Dedicated model for storing OAuth integration data.
 * All tokens are encrypted at rest using AES-256-GCM.
 * 
 * This model follows the design pattern of:
 * - Separating integration data from user authentication data
 * - Storing encrypted tokens server-side only (never exposed to frontend)
 * - Supporting token rotation with atomic updates
 * - Maintaining audit trail via timestamps
 * 
 * SECURITY NOTES:
 * - access_token_enc and refresh_token_enc are encrypted with ENC_KEY
 * - Tokens are never returned to clients
 * - Status reflects real-time validity, not session state
 */

const mongoose = require('mongoose');
const crypto = require('../utils/crypto');

const IntegrationSchema = new mongoose.Schema({
  // Reference to the user
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // OAuth provider identifier
  provider: {
    type: String,
    required: true,
    enum: [
      'google',           // Google login (if needed separately)
      'google_calendar',  // Google Calendar integration
      'notion',           // Notion integration
      'slack',            // Slack integration
      'zoom',             // Zoom integration (future)
      'microsoft',        // Microsoft/Teams (future)
      'asana',            // Asana integration (future)
      'trello',           // Trello integration (future)
      'linear',           // Linear integration (future)
      'github',           // GitHub integration (future)
      'jira'              // Jira integration (future)
    ],
    index: true
  },
  
  // Encrypted access token (AES-256-GCM encrypted)
  accessTokenEnc: {
    type: String,
    select: false  // Never returned in queries by default
  },
  
  // Encrypted user access token (for Slack user scopes like search)
  userAccessTokenEnc: {
    type: String,
    select: false
  },
  
  // Encrypted refresh token (AES-256-GCM encrypted)
  refreshTokenEnc: {
    type: String,
    select: false  // Never returned in queries by default
  },
  
  // Token expiration timestamp
  expiresAt: {
    type: Date,
    index: true
  },
  
  // OAuth scopes granted
  scopes: [{
    type: String
  }],
  
  // Integration status
  status: {
    type: String,
    enum: ['connected', 'disconnected', 'expired', 'error'],
    default: 'connected',
    index: true
  },
  
  // Error information (if status is 'error')
  errorMessage: {
    type: String
  },
  lastErrorAt: {
    type: Date
  },
  
  // Provider-specific metadata (not tokens)
  metadata: {
    // Common fields
    accountId: String,      // Provider's user/account ID
    accountName: String,    // Display name
    accountEmail: String,   // Email if available
    accountAvatar: String,  // Avatar URL if available
    
    // Workspace/Team info (for Slack, Notion, etc.)
    workspaceId: String,
    workspaceName: String,
    workspaceIcon: String,
    teamId: String,
    teamName: String,
    
    // Bot info (for Slack, Notion)
    botId: String,
    botUserId: String,
    
    // Channel info (for Slack)
    defaultChannelId: String,
    defaultChannelName: String,
    
    // Webhook info
    webhookUrl: String,
    webhookChannelId: String,
    
    // Additional provider-specific data
    extra: mongoose.Schema.Types.Mixed
  },
  
  // Token refresh metadata
  lastRefreshedAt: {
    type: Date
  },
  refreshCount: {
    type: Number,
    default: 0
  },
  
  // Audit timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient user+provider lookups
IntegrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

// Index for finding expired tokens
IntegrationSchema.index({ status: 1, expiresAt: 1 });

/**
 * Instance method: Set access token (encrypts automatically)
 * @param {string} token - Plaintext access token
 */
IntegrationSchema.methods.setAccessToken = function(token) {
  if (token) {
    this.accessTokenEnc = crypto.encrypt(token);
  } else {
    this.accessTokenEnc = null;
  }
};

/**
 * Instance method: Get decrypted access token
 * @returns {string|null} - Decrypted access token
 */
IntegrationSchema.methods.getAccessToken = function() {
  if (!this.accessTokenEnc) return null;
  return crypto.decrypt(this.accessTokenEnc);
};

/**
 * Instance method: Set user access token (encrypts automatically)
 * @param {string} token - Plaintext user access token
 */
IntegrationSchema.methods.setUserAccessToken = function(token) {
  if (token) {
    this.userAccessTokenEnc = crypto.encrypt(token);
  } else {
    this.userAccessTokenEnc = null;
  }
};

/**
 * Instance method: Get decrypted user access token
 * @returns {string|null} - Decrypted user access token
 */
IntegrationSchema.methods.getUserAccessToken = function() {
  if (!this.userAccessTokenEnc) return null;
  return crypto.decrypt(this.userAccessTokenEnc);
};

/**
 * Instance method: Set refresh token (encrypts automatically)
 * @param {string} token - Plaintext refresh token
 */
IntegrationSchema.methods.setRefreshToken = function(token) {
  if (token) {
    this.refreshTokenEnc = crypto.encrypt(token);
  } else {
    this.refreshTokenEnc = null;
  }
};

/**
 * Instance method: Get decrypted refresh token
 * @returns {string|null} - Decrypted refresh token
 */
IntegrationSchema.methods.getRefreshToken = function() {
  if (!this.refreshTokenEnc) return null;
  return crypto.decrypt(this.refreshTokenEnc);
};

/**
 * Instance method: Check if token needs refresh
 * @param {number} bufferMs - Buffer time before expiration (default 5 minutes)
 * @returns {boolean}
 */
IntegrationSchema.methods.needsRefresh = function(bufferMs = 5 * 60 * 1000) {
  if (!this.expiresAt) return false;
  return Date.now() >= (this.expiresAt.getTime() - bufferMs);
};

/**
 * Instance method: Check if integration is valid/usable
 * @returns {boolean}
 */
IntegrationSchema.methods.isValid = function() {
  return this.status === 'connected' && this.accessTokenEnc;
};

/**
 * Instance method: Mark as disconnected
 * @param {string} [reason] - Optional reason for disconnection
 */
IntegrationSchema.methods.disconnect = function(reason) {
  this.status = 'disconnected';
  if (reason) {
    this.errorMessage = reason;
    this.lastErrorAt = new Date();
  }
  this.accessTokenEnc = null;
  this.refreshTokenEnc = null;
};

/**
 * Instance method: Update tokens after refresh
 * @param {Object} tokens - New tokens
 * @param {string} tokens.accessToken - New access token
 * @param {string} [tokens.refreshToken] - New refresh token (optional)
 * @param {Date|number} [tokens.expiresAt] - Token expiration
 */
IntegrationSchema.methods.updateTokens = function({ accessToken, userAccessToken, refreshToken, expiresAt }) {
  this.setAccessToken(accessToken);
  
  if (userAccessToken) {
    this.setUserAccessToken(userAccessToken);
  }
  
  // Only update refresh token if provided (some providers don't return new ones)
  if (refreshToken) {
    this.setRefreshToken(refreshToken);
  }
  
  if (expiresAt) {
    this.expiresAt = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  }
  
  this.status = 'connected';
  this.lastRefreshedAt = new Date();
  this.refreshCount += 1;
  this.errorMessage = null;
  this.lastErrorAt = null;
};

/**
 * Static method: Find or create integration for user+provider
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<Integration>}
 */
IntegrationSchema.statics.findOrCreate = async function(userId, provider) {
  let integration = await this.findOne({ userId, provider });
  
  if (!integration) {
    integration = new this({ userId, provider });
  }
  
  return integration;
};

/**
 * Static method: Get all integrations for a user with their status
 * Does NOT return tokens, only metadata and status
 * @param {string} userId - User ID
 * @returns {Promise<Array>}
 */
IntegrationSchema.statics.getUserIntegrations = async function(userId) {
  return this.find({ userId })
    .select('-accessTokenEnc -refreshTokenEnc')
    .sort({ createdAt: -1 });
};

/**
 * Static method: Get integration with tokens for internal use
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<Integration|null>}
 */
IntegrationSchema.statics.getWithTokens = async function(userId, provider) {
  return this.findOne({ userId, provider })
    .select('+accessTokenEnc +refreshTokenEnc');
};

/**
 * Static method: Check if user has connected integration
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<boolean>}
 */
IntegrationSchema.statics.isConnected = async function(userId, provider) {
  const integration = await this.findOne({ 
    userId, 
    provider, 
    status: 'connected' 
  });
  return !!integration;
};

/**
 * Static method: Get all expired/expiring integrations for refresh
 * @param {number} bufferMs - Time buffer before expiration
 * @returns {Promise<Array>}
 */
IntegrationSchema.statics.getExpiring = async function(bufferMs = 5 * 60 * 1000) {
  const threshold = new Date(Date.now() + bufferMs);
  return this.find({
    status: 'connected',
    expiresAt: { $lte: threshold },
    refreshTokenEnc: { $exists: true, $ne: null }
  }).select('+accessTokenEnc +refreshTokenEnc');
};

// Pre-save middleware to update timestamps
IntegrationSchema.pre('save', function() {
  this.updatedAt = new Date();
  if (!this.createdAt) {
    this.createdAt = new Date();
  }
});

// Ensure tokens are never serialized to JSON
IntegrationSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.accessTokenEnc;
  delete obj.refreshTokenEnc;
  return obj;
};

module.exports = mongoose.model('Integration', IntegrationSchema);
