/**
 * Integration Helper
 * 
 * Provides backward-compatible access to integration tokens.
 * During migration, checks both the new Integration model and
 * the legacy User model fields.
 * 
 * This helper should be used by all code that needs access tokens.
 * It handles:
 * - Checking the new Integration model first
 * - Falling back to legacy User model fields
 * - Automatic token refresh when needed
 * - Consistent error handling
 */

const Integration = require('../models/Integration');
const User = require('../models/users');
const { getProvider } = require('../config/oauthProviders');

// Lazy load to avoid circular dependency issues
let refreshIntegrationTokenFn = null;
const getRefreshFn = () => {
  if (!refreshIntegrationTokenFn) {
    refreshIntegrationTokenFn = require('../controllers/oauthController').refreshIntegrationToken;
  }
  return refreshIntegrationTokenFn;
};

/**
 * Get access token for a provider (backward compatible)
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name ('notion', 'slack', 'google_calendar')
 * @returns {Promise<string|null>} - Access token or null
 */
const getAccessToken = async (userId, provider) => {
  try {
    console.log(`[IntegrationHelper] Getting access token for ${provider} (user: ${userId})`);
    
    // First, try the new Integration model
    const integration = await Integration.getWithTokens(userId, provider);
    console.log(`[IntegrationHelper] Integration found: ${integration ? 'yes' : 'no'}`);
    
    if (integration && integration.isValid()) {
      console.log(`[IntegrationHelper] Integration is valid, status: ${integration.status}`);
      
      // Check if token needs refresh
      if (integration.needsRefresh()) {
        console.log(`[IntegrationHelper] Token needs refresh`);
        const refreshFn = getRefreshFn();
        if (refreshFn) {
          const refreshResult = await refreshFn(userId, provider);
          if (!refreshResult.success) {
            console.log(`[IntegrationHelper] Refresh failed, falling back to legacy`);
            // Fall back to legacy if refresh fails
            return getLegacyToken(userId, provider);
          }
          // Re-fetch after refresh
          const refreshed = await Integration.getWithTokens(userId, provider);
          return refreshed?.getAccessToken() || null;
        }
      }
      const token = integration.getAccessToken();
      console.log(`[IntegrationHelper] Token decrypted: ${token ? 'yes' : 'no'}`);
      return token;
    }
    
    // Fall back to legacy User model fields
    console.log(`[IntegrationHelper] Falling back to legacy token for ${provider}`);
    return getLegacyToken(userId, provider);
    
  } catch (error) {
    console.error(`Error getting access token for ${provider}:`, error);
    return null;
  }
};

/**
 * Get user access token for a provider (e.g. for Slack search)
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<string|null>} - User access token or null
 */
const getUserAccessToken = async (userId, provider) => {
  try {
    // Only supported for new Integration model
    const integration = await Integration.getWithTokens(userId, provider);
    
    if (integration && integration.isValid()) {
      // Check if token needs refresh (using same logic as main token)
      if (integration.needsRefresh()) {
        const refreshFn = getRefreshFn();
        if (refreshFn) {
          await refreshFn(userId, provider);
          // Re-fetch after refresh
          const refreshed = await Integration.getWithTokens(userId, provider);
          return refreshed?.getUserAccessToken() || null;
        }
      }
      return integration.getUserAccessToken();
    }
    
    return null;
  } catch (error) {
    console.error(`Error getting user access token for ${provider}:`, error);
    return null;
  }
};

/**
 * Get token from legacy User model fields
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<string|null>} - Access token or null
 */
const getLegacyToken = async (userId, provider) => {
  try {
    const selectFields = {
      notion: '+notionAccessToken',
      slack: '+slackAccessToken',
      google_calendar: '+googleCalendarAccessToken +googleCalendarRefreshToken'
    };
    
    const tokenField = {
      notion: 'notionAccessToken',
      slack: 'slackAccessToken',
      google_calendar: 'googleCalendarAccessToken'
    };
    
    if (!selectFields[provider]) {
      return null;
    }
    
    const user = await User.findById(userId).select(selectFields[provider]);
    return user ? user[tokenField[provider]] : null;
    
  } catch (error) {
    console.error(`Error getting legacy token for ${provider}:`, error);
    return null;
  }
};

/**
 * Get integration metadata (backward compatible)
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<Object|null>} - Metadata or null
 */
const getMetadata = async (userId, provider) => {
  try {
    // First, try the new Integration model
    const integration = await Integration.findOne({ userId, provider });
    
    if (integration && integration.metadata) {
      return integration.metadata;
    }
    
    // Fall back to legacy User model fields
    return getLegacyMetadata(userId, provider);
    
  } catch (error) {
    console.error(`Error getting metadata for ${provider}:`, error);
    return null;
  }
};

/**
 * Get metadata from legacy User model fields
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<Object|null>} - Metadata or null
 */
const getLegacyMetadata = async (userId, provider) => {
  try {
    const user = await User.findById(userId);
    if (!user) return null;
    
    switch (provider) {
      case 'notion':
        return {
          workspaceId: user.notionWorkspaceId,
          workspaceName: user.notionWorkspaceName,
          workspaceIcon: user.notionWorkspaceIcon,
          botId: user.notionBotId
        };
        
      case 'slack':
        return {
          teamId: user.slackTeamId,
          teamName: user.slackTeamName,
          accountId: user.slackUserId,
          defaultChannelId: user.slackDefaultChannelId,
          defaultChannelName: user.slackDefaultChannelName
        };
        
      case 'google_calendar':
        return {
          calendarSynced: user.calendarSynced,
          calendarLastSynced: user.calendarLastSynced,
          expiresAt: user.googleCalendarExpiry
        };
        
      default:
        return null;
    }
    
  } catch (error) {
    console.error(`Error getting legacy metadata for ${provider}:`, error);
    return null;
  }
};

/**
 * Check if integration is connected (backward compatible)
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<boolean>}
 */
const isConnected = async (userId, provider) => {
  try {
    // First, check new Integration model
    const connected = await Integration.isConnected(userId, provider);
    if (connected) return true;
    
    // Fall back to legacy check
    const legacyToken = await getLegacyToken(userId, provider);
    return !!legacyToken;
    
  } catch (error) {
    console.error(`Error checking connection for ${provider}:`, error);
    return false;
  }
};

/**
 * Get integration status for all providers (backward compatible)
 * 
 * @param {string} userId - User ID
 * @returns {Promise<Object>} - Status object by provider
 */
const getAllStatus = async (userId) => {
  const providers = ['notion', 'slack', 'google_calendar', 'google'];
  const status = {};
  
  for (const provider of providers) {
    const connected = await isConnected(userId, provider);
    const metadata = connected ? await getMetadata(userId, provider) : null;
    
    status[provider] = {
      connected,
      metadata
    };
  }
  
  return status;
};

/**
 * Get Google token (checks both 'google' and 'google_calendar' providers)
 * The 'google' provider has full Gmail + Calendar access,
 * 'google_calendar' is legacy with limited scope.
 * 
 * @param {string} userId - User ID
 * @returns {Promise<{accessToken: string|null, refreshToken: string|null, provider: string|null}>}
 */
const getGoogleToken = async (userId) => {
  try {
    // First try the new 'google' provider (full access)
    const googleIntegration = await Integration.getWithTokens(userId, 'google');
    if (googleIntegration && googleIntegration.isValid()) {
      console.log('[IntegrationHelper] Found google integration with full access');
      const accessToken = googleIntegration.getAccessToken();
      const refreshToken = googleIntegration.getRefreshToken();
      return { accessToken, refreshToken, provider: 'google' };
    }
    
    // Fall back to 'google_calendar' provider
    const calendarIntegration = await Integration.getWithTokens(userId, 'google_calendar');
    if (calendarIntegration && calendarIntegration.isValid()) {
      console.log('[IntegrationHelper] Found google_calendar integration');
      const accessToken = calendarIntegration.getAccessToken();
      const refreshToken = calendarIntegration.getRefreshToken();
      return { accessToken, refreshToken, provider: 'google_calendar' };
    }
    
    // Fall back to legacy User fields
    const user = await User.findById(userId).select('+googleCalendarAccessToken +googleCalendarRefreshToken');
    if (user?.googleCalendarAccessToken || user?.googleCalendarRefreshToken) {
      console.log('[IntegrationHelper] Found legacy Google Calendar tokens');
      return {
        accessToken: user.googleCalendarAccessToken,
        refreshToken: user.googleCalendarRefreshToken,
        provider: 'legacy'
      };
    }
    
    return { accessToken: null, refreshToken: null, provider: null };
    
  } catch (error) {
    console.error('[IntegrationHelper] Error getting Google token:', error);
    return { accessToken: null, refreshToken: null, provider: null };
  }
};

/**
 * Check if user has Google integration (either provider)
 * 
 * @param {string} userId - User ID
 * @returns {Promise<boolean>}
 */
const hasGoogleIntegration = async (userId) => {
  const { provider } = await getGoogleToken(userId);
  return provider !== null;
};

/**
 * Update legacy metadata (for backward compatibility during transition)
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @param {Object} metadata - Metadata to update
 */
const updateLegacyMetadata = async (userId, provider, metadata) => {
  try {
    const updates = {};
    
    switch (provider) {
      case 'slack':
        if (metadata.defaultChannelId) updates.slackDefaultChannelId = metadata.defaultChannelId;
        if (metadata.defaultChannelName) updates.slackDefaultChannelName = metadata.defaultChannelName;
        break;
        
      case 'google_calendar':
        if (metadata.calendarSynced !== undefined) updates.calendarSynced = metadata.calendarSynced;
        if (metadata.calendarLastSynced) updates.calendarLastSynced = metadata.calendarLastSynced;
        break;
    }
    
    if (Object.keys(updates).length > 0) {
      await User.findByIdAndUpdate(userId, updates);
    }
    
    // Also update the new Integration model if it exists
    const integration = await Integration.findOne({ userId, provider });
    if (integration) {
      integration.metadata = { ...integration.metadata, ...metadata };
      await integration.save();
    }
    
  } catch (error) {
    console.error(`Error updating metadata for ${provider}:`, error);
  }
};

module.exports = {
  getAccessToken,
  getUserAccessToken,
  getMetadata,
  isConnected,
  getAllStatus,
  updateLegacyMetadata,
  getLegacyToken,
  getLegacyMetadata,
  getGoogleToken,
  hasGoogleIntegration
};
