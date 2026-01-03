/**
 * Unified OAuth Routes
 * 
 * SINGLE callback URI for all OAuth providers: /oauth/callback
 * This is the ONLY OAuth callback URL registered with providers.
 * 
 * Routes:
 * - POST /oauth/start          - Start OAuth flow (protected)
 * - GET  /oauth/callback       - Handle OAuth callback (public)
 * - POST /oauth/disconnect     - Disconnect integration (protected)
 * - POST /oauth/refresh        - Manually refresh token (protected)
 * - GET  /oauth/status         - Get all integration statuses (protected)
 * - GET  /oauth/providers      - Get available providers (public)
 */

const express = require('express');
const router = express.Router();
const oauthController = require('../controllers/oauthController');
const { protect } = require('../middleware/auth');
const { getAvailableProviders, isProviderConfigured, getProvider } = require('../config/oauthProviders');

/**
 * Start OAuth flow
 * 
 * POST /oauth/start
 * Body: { provider: 'slack' | 'notion' | 'google_calendar' | ..., context?: {} }
 * Response: { success: true, url: 'https://...' }
 * 
 * The frontend should redirect the user to the returned URL.
 */
router.post('/start', protect, oauthController.startOAuth);

/**
 * OAuth callback handler
 * 
 * GET /oauth/callback
 * Query: { code: string, state: string }
 * 
 * This is the UNIFIED callback URL registered with ALL OAuth providers.
 * The state parameter determines the provider and user.
 * 
 * Redirects to frontend with status:
 * - /integrations?status=success&provider=slack
 * - /integrations?status=error&message=...
 */
router.get('/callback', oauthController.handleCallback);

/**
 * Disconnect integration
 * 
 * POST /oauth/disconnect
 * Body: { provider: string }
 * Response: { success: true }
 * 
 * Revokes tokens (if supported) and marks integration as disconnected.
 */
router.post('/disconnect', protect, oauthController.disconnectIntegration);

/**
 * Refresh token
 * 
 * POST /oauth/refresh
 * Body: { provider: string }
 * Response: { success: true } or { success: false, requiresReauth: true }
 * 
 * Manually trigger token refresh. Usually called when API returns 401.
 */
router.post('/refresh', protect, oauthController.refreshToken);

/**
 * Get integration status
 * 
 * GET /oauth/status
 * Response: { success: true, data: { slack: {...}, notion: {...}, ... } }
 * 
 * Returns status for all providers including metadata.
 * Does NOT return tokens.
 */
router.get('/status', protect, oauthController.getIntegrationStatus);

/**
 * Get available providers
 * 
 * GET /oauth/providers
 * Response: { providers: ['slack', 'notion', ...] }
 * 
 * Returns list of configured providers with their display names.
 */
router.get('/providers', (req, res) => {
  const providers = getAvailableProviders()
    .filter(p => isProviderConfigured(p))
    .map(p => ({
      id: p,
      name: getProvider(p)?.name || p
    }));
  
  res.json({ 
    success: true, 
    providers 
  });
});

/**
 * Health check for OAuth system
 * 
 * GET /oauth/health
 * Response: { healthy: true, providers: {...} }
 * 
 * Returns health status of OAuth system and provider configurations.
 */
router.get('/health', (req, res) => {
  const providers = {};
  
  for (const p of getAvailableProviders()) {
    providers[p] = {
      configured: isProviderConfigured(p)
    };
  }
  
  res.json({
    healthy: true,
    timestamp: new Date().toISOString(),
    providers
  });
});

module.exports = router;
