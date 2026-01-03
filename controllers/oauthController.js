/**
 * Unified OAuth Controller
 * 
 * Single controller handling ALL OAuth flows:
 * - Start OAuth flow (generates secure state, redirects to provider)
 * - Handle OAuth callback (validates state, exchanges code, stores tokens)
 * - Disconnect integration
 * - Refresh tokens
 * - Get integration status
 * 
 * This follows the Big Tech pattern of:
 * - One callback URI for all providers
 * - State-based routing
 * - Backend-only token handling
 * - Encrypted token storage
 * 
 * SECURITY FEATURES:
 * - Signed/encrypted state parameters
 * - Nonce-based replay protection
 * - Token encryption at rest
 * - Comprehensive audit logging
 */

const Integration = require('../models/Integration');
const User = require('../models/users');
const oauthState = require('../utils/oauthState');
const { getProvider, buildAuthUrl, isProviderConfigured, getAvailableProviders } = require('../config/oauthProviders');
const audit = require('../utils/oauthAudit');

// Get frontend URL for redirects
const getFrontendUrl = () => process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * Start OAuth flow
 * 
 * POST /oauth/start
 * Body: { provider: string, context?: object }
 * 
 * Generates a secure state parameter and returns the OAuth authorization URL.
 * The frontend should redirect the user to this URL.
 */
exports.startOAuth = async (req, res) => {
  try {
    const { provider, context } = req.body;
    const userId = req.user._id.toString();
    
    // Validate provider
    if (!provider) {
      return res.status(400).json({ 
        success: false, 
        message: 'Provider is required' 
      });
    }
    
    const providerConfig = getProvider(provider);
    if (!providerConfig) {
      return res.status(400).json({ 
        success: false, 
        message: `Unknown provider: ${provider}` 
      });
    }
    
    if (!isProviderConfigured(provider)) {
      return res.status(400).json({ 
        success: false, 
        message: `Provider ${provider} is not configured` 
      });
    }
    
    // Generate secure state
    const state = oauthState.generateState({
      provider,
      userId,
      flowType: 'integration',
      context: context || {}
    });
    
    // Build authorization URL
    const authUrl = buildAuthUrl(provider, state);
    
    // Audit log
    audit.logOAuthStart({ userId, provider, req });
    
    res.json({ 
      success: true, 
      url: authUrl 
    });
    
  } catch (error) {
    console.error('OAuth start error:', error);
    audit.logOAuthFailure({
      userId: req.user?._id?.toString(),
      provider: req.body?.provider,
      error: error.message,
      stage: 'start',
      req
    });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to start OAuth flow' 
    });
  }
};

/**
 * Handle OAuth callback
 * 
 * GET /oauth/callback?code=...&state=...
 * 
 * This is the SINGLE callback URI registered with ALL OAuth providers.
 * The state parameter determines which provider and user this callback is for.
 */
exports.handleCallback = async (req, res) => {
  const frontendUrl = getFrontendUrl();
  const { code, state, error: oauthError, error_description } = req.query;
  
  // Log callback received
  audit.logOAuthCallback({
    provider: 'unknown', // Will be determined from state
    hasCode: !!code,
    hasState: !!state,
    req
  });
  
  // Handle OAuth error from provider
  if (oauthError) {
    console.error('OAuth provider error:', oauthError, error_description);
    audit.logOAuthFailure({
      userId: 'unknown',
      provider: 'unknown',
      error: `${oauthError}: ${error_description}`,
      stage: 'provider_error',
      req
    });
    return res.redirect(`${frontendUrl}/integrations?status=error&message=${encodeURIComponent(oauthError)}`);
  }
  
  // Validate required parameters
  if (!code) {
    audit.logOAuthFailure({
      userId: 'unknown',
      provider: 'unknown',
      error: 'No authorization code',
      stage: 'callback_validation',
      req
    });
    return res.redirect(`${frontendUrl}/integrations?status=error&message=No authorization code`);
  }
  
  if (!state) {
    audit.logOAuthFailure({
      userId: 'unknown',
      provider: 'unknown',
      error: 'No state parameter',
      stage: 'callback_validation',
      req
    });
    audit.logSecurityEvent({
      type: 'MISSING_STATE',
      description: 'OAuth callback received without state parameter',
      data: {},
      req
    });
    return res.redirect(`${frontendUrl}/integrations?status=error&message=Invalid request`);
  }
  
  // Verify state
  const stateData = oauthState.verifyState(state);
  
  if (!stateData) {
    audit.logStateValidation({ valid: false, reason: 'State verification failed', req });
    audit.logSecurityEvent({
      type: 'INVALID_STATE',
      description: 'OAuth callback with invalid/tampered state',
      data: {},
      req
    });
    return res.redirect(`${frontendUrl}/integrations?status=error&message=Invalid or expired request`);
  }
  
  audit.logStateValidation({ valid: true, reason: null, req });
  
  const { provider, userId, flowType, context } = stateData;
  
  try {
    // Get provider configuration
    const providerConfig = getProvider(provider);
    if (!providerConfig) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    
    // Verify user exists
    const user = await User.findById(userId);
    if (!user) {
      audit.logOAuthFailure({
        userId,
        provider,
        error: 'User not found',
        stage: 'user_verification',
        req
      });
      return res.redirect(`${frontendUrl}/integrations?status=error&message=User not found`);
    }
    
    // Exchange code for tokens
    console.log(`Exchanging OAuth code for ${provider} (user: ${userId})`);
    const tokenData = await providerConfig.exchangeCode(code);
    
    // Get or create integration record
    const integration = await Integration.findOrCreate(userId, provider);
    
    // Store encrypted tokens
    integration.setAccessToken(tokenData.accessToken);
    
    if (tokenData.userAccessToken) {
      integration.setUserAccessToken(tokenData.userAccessToken);
    }
    
    if (tokenData.refreshToken) {
      integration.setRefreshToken(tokenData.refreshToken);
    }
    
    // Update metadata
    integration.expiresAt = tokenData.expiresAt;
    integration.scopes = tokenData.scopes || [];
    integration.status = 'connected';
    integration.errorMessage = null;
    integration.lastErrorAt = null;
    
    // Store provider-specific metadata
    if (tokenData.metadata) {
      integration.metadata = {
        ...integration.metadata,
        ...tokenData.metadata
      };
    }
    
    // Store context data if provided
    if (context) {
      integration.metadata = {
        ...integration.metadata,
        extra: {
          ...(integration.metadata?.extra || {}),
          ...context
        }
      };
    }
    
    await integration.save();
    
    console.log(`OAuth success for ${provider} (user: ${userId})`);
    
    // Audit log success
    audit.logOAuthSuccess({
      userId,
      provider,
      hasRefreshToken: !!tokenData.refreshToken,
      scopes: tokenData.scopes,
      metadata: tokenData.metadata
    });
    
    // Redirect to frontend with success
    res.redirect(`${frontendUrl}/integrations?status=success&provider=${provider}`);
    
  } catch (error) {
    // Log the full error details for debugging
    console.error(`OAuth callback error for ${provider}:`, error.message);
    if (error.response) {
      console.error('Provider response status:', error.response.status);
      console.error('Provider response data:', JSON.stringify(error.response.data, null, 2));
    }
    console.error('Callback URL used:', process.env.OAUTH_CALLBACK_URL || `${process.env.API_BASE_URL}/oauth/callback`);
    
    audit.logOAuthFailure({
      userId,
      provider,
      error: error.message,
      stage: 'token_exchange',
      req
    });
    
    // Update integration status to error if it exists
    try {
      const integration = await Integration.findOne({ userId, provider });
      if (integration) {
        integration.status = 'error';
        integration.errorMessage = error.response?.data?.error || error.message;
        integration.lastErrorAt = new Date();
        await integration.save();
      }
    } catch (updateError) {
      console.error('Failed to update integration status:', updateError);
    }
    
    // Return actual error message from provider for debugging
    const actualError = error.response?.data?.error || error.response?.data?.message || error.message || 'Authorization failed';
    res.redirect(`${frontendUrl}/integrations?status=error&provider=${provider}&message=${encodeURIComponent(actualError)}`);
  }
};

/**
 * Refresh an integration token
 * 
 * This function is designed to be called internally, not as a route handler.
 * It handles the logic of refreshing an expired access token.
 * 
 * @param {string} userId - The user's ID
 * @param {string} provider - The provider to refresh
 * @returns {Promise<{success: boolean, message?: string}>}
 */
exports.refreshIntegrationToken = async (userId, provider) => {
  const integration = await Integration.getWithTokens(userId, provider);

  if (!integration) {
    return { success: false, message: 'Integration not found' };
  }

  const refreshToken = integration.getRefreshToken();
  if (!refreshToken) {
    integration.status = 'expired';
    integration.errorMessage = 'No refresh token available to renew connection.';
    await integration.save();
    return { success: false, message: 'No refresh token' };
  }

  try {
    const providerConfig = getProvider(provider);
    if (!providerConfig || !providerConfig.refreshToken) {
      return { success: false, message: `Token refresh not supported for ${provider}` };
    }

    console.log(`[OAuth] Refreshing token for ${provider} (user: ${userId})`);
    const newTokens = await providerConfig.refreshToken(refreshToken);

    integration.updateTokens(newTokens);
    await integration.save();

    audit.logTokenRefreshSuccess({ userId, provider });
    console.log(`[OAuth] Token refresh successful for ${provider} (user: ${userId})`);
    
    return { success: true };

  } catch (error) {
    console.error(`[OAuth] Token refresh failed for ${provider} (user: ${userId}):`, error.message);
    if (error.response) {
      console.error('Provider response:', error.response.data);
    }

    integration.status = 'error';
    integration.errorMessage = `Token refresh failed: ${error.response?.data?.error_description || error.message}`;
    integration.lastErrorAt = new Date();
    await integration.save();

    audit.logTokenRefreshFailure({ userId, provider, error: error.message });

    return { success: false, message: error.message };
  }
};

/**
 * Disconnect an integration
 * 
 * POST /oauth/disconnect
 * Body: { provider: string }
 * 
 * Revokes tokens (if provider supports it) and removes integration.
 */
exports.disconnectIntegration = async (req, res) => {
  try {
    const { provider } = req.body;
    const userId = req.user._id.toString();
    
    if (!provider) {
      return res.status(400).json({ 
        success: false, 
        message: 'Provider is required' 
      });
    }
    
    // Get integration with tokens
    const integration = await Integration.getWithTokens(userId, provider);
    
    if (!integration) {
      return res.status(404).json({ 
        success: false, 
        message: 'Integration not found' 
      });
    }
    
    // Try to revoke token at provider (best effort)
    const providerConfig = getProvider(provider);
    if (providerConfig && providerConfig.revokeToken) {
      try {
        const accessToken = integration.getAccessToken();
        if (accessToken) {
          await providerConfig.revokeToken(accessToken);
        }
        audit.logTokenRevoke({ userId, provider, success: true, req });
      } catch (revokeError) {
        console.error(`Failed to revoke ${provider} token:`, revokeError.message);
        audit.logTokenRevoke({ userId, provider, success: false, req });
        // Continue with disconnect even if revoke fails
      }
    }
    
    // Clear integration data
    integration.disconnect('User requested disconnect');
    await integration.save();
    
    audit.logIntegrationDisconnect({
      userId,
      provider,
      reason: 'User requested',
      req
    });
    
    res.json({ 
      success: true, 
      message: `${provider} disconnected successfully` 
    });
    
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to disconnect integration' 
    });
  }
};

/**
 * Get integration status for all providers
 * 
 * GET /oauth/status
 * 
 * Returns connection status for all configured providers.
 * Does NOT return tokens.
 */
exports.getIntegrationStatus = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    
    // Get all integrations for this user
    const integrations = await Integration.getUserIntegrations(userId);
    
    // Get all available providers
    const availableProviders = getAvailableProviders();
    
    // Build status object
    const status = {};
    
    for (const provider of availableProviders) {
      const integration = integrations.find(i => i.provider === provider);
      const providerConfig = getProvider(provider);
      
      status[provider] = {
        name: providerConfig?.name || provider,
        configured: isProviderConfigured(provider),
        connected: integration?.status === 'connected',
        status: integration?.status || 'not_connected',
        metadata: integration ? {
          workspaceName: integration.metadata?.workspaceName,
          workspaceIcon: integration.metadata?.workspaceIcon,
          teamName: integration.metadata?.teamName,
          accountName: integration.metadata?.accountName,
          defaultChannelName: integration.metadata?.defaultChannelName
        } : null,
        connectedAt: integration?.createdAt,
        lastRefreshed: integration?.lastRefreshedAt,
        errorMessage: integration?.errorMessage
      };
    }
    
    res.json({ 
      success: true, 
      data: status 
    });
    
  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to get integration status' 
    });
  }
};

/**
 * Refresh token for a provider
 * 
 * POST /oauth/refresh
 * Body: { provider: string }
 * 
 * Manually triggers token refresh. Usually called when API returns 401.
 */
exports.refreshToken = async (req, res) => {
  try {
    const { provider } = req.body;
    const userId = req.user._id.toString();
    
    if (!provider) {
      return res.status(400).json({ 
        success: false, 
        message: 'Provider is required' 
      });
    }
    
    const result = await refreshIntegrationToken(userId, provider);
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Token refreshed successfully' 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        message: result.error,
        requiresReauth: result.requiresReauth 
      });
    }
    
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to refresh token' 
    });
  }
};

/**
 * Internal function to refresh a token
 * Can be called from scheduled jobs or on-demand
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Object} - { success, error?, requiresReauth? }
 */
const refreshIntegrationToken = async (userId, provider) => {
  try {
    // Get integration with tokens
    const integration = await Integration.getWithTokens(userId, provider);
    
    if (!integration) {
      return { success: false, error: 'Integration not found' };
    }
    
    const refreshToken = integration.getRefreshToken();
    if (!refreshToken) {
      return { 
        success: false, 
        error: 'No refresh token available',
        requiresReauth: true 
      };
    }
    
    // Get provider configuration
    const providerConfig = getProvider(provider);
    if (!providerConfig || !providerConfig.refreshToken) {
      return { 
        success: false, 
        error: 'Provider does not support token refresh',
        requiresReauth: true 
      };
    }
    
    // Refresh the token
    const newTokens = await providerConfig.refreshToken(refreshToken);
    
    // Update integration with new tokens
    integration.updateTokens({
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      expiresAt: newTokens.expiresAt
    });
    
    await integration.save();
    
    audit.logTokenRefresh({ userId, provider, success: true });
    
    return { success: true };
    
  } catch (error) {
    console.error(`Token refresh failed for ${provider}:`, error.message);
    
    audit.logTokenRefresh({ 
      userId, 
      provider, 
      success: false, 
      error: error.message 
    });
    
    // Check if we need to mark integration as disconnected
    const isAuthError = error.response?.status === 401 || 
                        error.response?.status === 400 ||
                        error.message.includes('invalid_grant') ||
                        error.message.includes('token has been revoked');
    
    if (isAuthError) {
      try {
        const integration = await Integration.findOne({ userId, provider });
        if (integration) {
          integration.status = 'expired';
          integration.errorMessage = 'Refresh token expired or revoked';
          integration.lastErrorAt = new Date();
          await integration.save();
        }
      } catch (updateError) {
        console.error('Failed to update integration status:', updateError);
      }
      
      return { 
        success: false, 
        error: 'Token expired - reauthorization required',
        requiresReauth: true 
      };
    }
    
    return { 
      success: false, 
      error: 'Token refresh failed' 
    };
  }
};

/**
 * Get a valid access token for internal use
 * Handles refresh if needed
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {string|null} - Access token or null
 */
exports.getValidAccessToken = async (userId, provider) => {
  try {
    const integration = await Integration.getWithTokens(userId, provider);
    
    if (!integration || !integration.isValid()) {
      return null;
    }
    
    // Check if token needs refresh
    if (integration.needsRefresh()) {
      const refreshResult = await refreshIntegrationToken(userId, provider);
      if (!refreshResult.success) {
        return null;
      }
      // Re-fetch integration after refresh
      const refreshedIntegration = await Integration.getWithTokens(userId, provider);
      return refreshedIntegration?.getAccessToken() || null;
    }
    
    return integration.getAccessToken();
    
  } catch (error) {
    console.error(`Failed to get access token for ${provider}:`, error);
    return null;
  }
};

/**
 * Get integration metadata for internal use
 * 
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Object|null} - Integration metadata or null
 */
exports.getIntegrationMetadata = async (userId, provider) => {
  try {
    const integration = await Integration.findOne({ userId, provider });
    return integration?.metadata || null;
  } catch (error) {
    console.error(`Failed to get integration metadata for ${provider}:`, error);
    return null;
  }
};

// Export internal function for use in scheduled jobs
exports.refreshIntegrationToken = refreshIntegrationToken;
