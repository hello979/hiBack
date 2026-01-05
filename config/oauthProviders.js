/**
 * OAuth Provider Configurations
 * 
 * Centralized configuration for all OAuth providers.
 * This makes it easy to add new providers without changing callback URIs.
 * 
 * Each provider configuration includes:
 * - OAuth endpoints (authorization, token, revoke)
 * - Client credentials (from environment)
 * - Default scopes
 * - Token exchange logic
 * - Token refresh logic
 * 
 * ADDING A NEW PROVIDER:
 * 1. Add provider configuration object below
 * 2. Add provider name to Integration model enum
 * 3. Add environment variables for client ID/secret
 * 4. Done! No route changes needed.
 */

const axios = require('axios');

/**
 * Get the unified OAuth callback URL
 * This single URL is registered with ALL OAuth providers
 */
const getCallbackUrl = () => {
  return process.env.OAUTH_CALLBACK_URL || 
         `${process.env.API_BASE_URL || 'http://localhost:5000'}/oauth/callback`;
};

/**
 * Provider configurations
 * Each provider has standard OAuth 2.0 properties plus custom handlers
 */
const providers = {
  
  // =========================================
  // GOOGLE (Gmail + Calendar - Full Assistant Access)
  // =========================================
  google: {
    name: 'Google (Email & Calendar)',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    
    // Full scopes for Gmail read/send + Calendar read/write
    scopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ],
    
    getAuthParams: () => ({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: getCallbackUrl(),
      response_type: 'code',
      scope: providers.google.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true'
    }),
    
    exchangeCode: async (code) => {
      const response = await axios.post(providers.google.tokenUrl, {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: getCallbackUrl()
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      // Fetch user info for metadata
      let metadata = {};
      try {
        const userInfoRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { 'Authorization': `Bearer ${response.data.access_token}` }
        });
        metadata = {
          accountId: userInfoRes.data.id,
          accountEmail: userInfoRes.data.email,
          accountName: userInfoRes.data.name,
          accountAvatar: userInfoRes.data.picture
        };
      } catch (e) {
        console.error('Failed to fetch Google user info:', e.message);
      }
      
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        expiresAt: new Date(Date.now() + (response.data.expires_in * 1000)),
        scopes: response.data.scope ? response.data.scope.split(' ') : providers.google.scopes,
        metadata
      };
    },
    
    refreshToken: async (refreshToken) => {
      const response = await axios.post(providers.google.tokenUrl, {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      return {
        accessToken: response.data.access_token,
        refreshToken: null,
        expiresIn: response.data.expires_in,
        expiresAt: new Date(Date.now() + (response.data.expires_in * 1000))
      };
    },
    
    revokeToken: async (token) => {
      await axios.post(`${providers.google.revokeUrl}?token=${token}`);
    }
  },

  // =========================================
  // GOOGLE CALENDAR (Legacy - Now upgraded to full access)
  // =========================================
  google_calendar: {
    name: 'Google Calendar',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    
    // Upgraded scopes - now includes Gmail and Calendar write
    scopes: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ],
    
    // Get OAuth URL parameters
    getAuthParams: () => ({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: getCallbackUrl(),
      response_type: 'code',
      scope: providers.google_calendar.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent', // Always show consent to get refresh token
      include_granted_scopes: 'true'
    }),
    
    // Exchange authorization code for tokens
    exchangeCode: async (code) => {
      const response = await axios.post(providers.google_calendar.tokenUrl, {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: getCallbackUrl()
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        expiresAt: new Date(Date.now() + (response.data.expires_in * 1000)),
        scopes: response.data.scope ? response.data.scope.split(' ') : providers.google_calendar.scopes,
        metadata: {}
      };
    },
    
    // Refresh access token
    refreshToken: async (refreshToken) => {
      const response = await axios.post(providers.google_calendar.tokenUrl, {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      
      return {
        accessToken: response.data.access_token,
        // Google doesn't return new refresh token on refresh
        refreshToken: null,
        expiresIn: response.data.expires_in,
        expiresAt: new Date(Date.now() + (response.data.expires_in * 1000))
      };
    },
    
    // Revoke tokens
    revokeToken: async (token) => {
      await axios.post(`${providers.google_calendar.revokeUrl}?token=${token}`);
    }
  },
  
  // =========================================
  // NOTION
  // =========================================
  notion: {
    name: 'Notion',
    authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    revokeUrl: null, // Notion doesn't have a revoke endpoint
    
    // Notion uses owner=user for user-level access
    scopes: [], // Notion doesn't use traditional scopes
    
    getAuthParams: () => ({
      client_id: process.env.NOTION_CLIENT_ID,
      redirect_uri: getCallbackUrl(),
      response_type: 'code',
      owner: 'user'
    }),
    
    exchangeCode: async (code) => {
      const credentials = Buffer.from(
        `${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`
      ).toString('base64');
      
      const response = await axios.post(providers.notion.tokenUrl, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: getCallbackUrl()
      }, {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json'
        }
      });
      
      const data = response.data;
      
      return {
        accessToken: data.access_token,
        refreshToken: null, // Notion tokens don't expire currently
        expiresIn: null,
        expiresAt: null,
        scopes: [],
        metadata: {
          workspaceId: data.workspace_id,
          workspaceName: data.workspace_name,
          workspaceIcon: data.workspace_icon,
          botId: data.bot_id,
          accountId: data.owner?.user?.id,
          accountName: data.owner?.user?.name,
          accountEmail: data.owner?.user?.person?.email,
          accountAvatar: data.owner?.user?.avatar_url
        }
      };
    },
    
    // Notion tokens don't expire, so no refresh needed
    refreshToken: null,
    
    revokeToken: null
  },
  
  // =========================================
  // SLACK
  // =========================================
  slack: {
    name: 'Slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: 'https://slack.com/api/auth.revoke',
    
    scopes: [
      'chat:write',
      'channels:read',
      'channels:join',
      'groups:read',
      'users:read',
      'team:read'
    ],
    
    getAuthParams: () => ({
      client_id: process.env.SLACK_CLIENT_ID,
      redirect_uri: getCallbackUrl(),
      scope: providers.slack.scopes.join(','),
      user_scope: 'search:read' // Explicitly request user scope for search
    }),
    
    exchangeCode: async (code) => {
      const response = await axios.post(providers.slack.tokenUrl, null, {
        params: {
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          code,
          redirect_uri: getCallbackUrl()
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      
      if (!response.data.ok) {
        throw new Error(response.data.error || 'Slack authorization failed');
      }
      
      const data = response.data;
      
      return {
        accessToken: data.access_token,
        userAccessToken: data.authed_user?.access_token, // Capture user token
        refreshToken: data.refresh_token || null,
        expiresIn: data.expires_in || null,
        expiresAt: data.expires_in ? new Date(Date.now() + (data.expires_in * 1000)) : null,
        scopes: data.scope ? data.scope.split(',') : providers.slack.scopes,
        metadata: {
          teamId: data.team?.id,
          teamName: data.team?.name,
          teamDomain: data.team?.domain, // Add workspace domain/slug for URLs
          botUserId: data.bot_user_id,
          accountId: data.authed_user?.id,
          webhookUrl: data.incoming_webhook?.url,
          webhookChannelId: data.incoming_webhook?.channel_id,
          defaultChannelName: data.incoming_webhook?.channel?.replace(/^#/, '')
        }
      };
    },
    
    // Slack bot tokens don't typically need refresh
    // Enterprise Grid uses rotating tokens which would need this
    refreshToken: async (refreshToken) => {
      const response = await axios.post('https://slack.com/api/oauth.v2.access', null, {
        params: {
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }
      });
      
      if (!response.data.ok) {
        throw new Error(response.data.error || 'Slack token refresh failed');
      }
      
      return {
        accessToken: response.data.access_token,
        userAccessToken: response.data.authed_user?.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        expiresAt: response.data.expires_in 
          ? new Date(Date.now() + (response.data.expires_in * 1000)) 
          : null
      };
    },
    
    revokeToken: async (token) => {
      await axios.post(providers.slack.revokeUrl, null, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }
  },
  
  // =========================================
  // ZOOM (Future)
  // =========================================
  zoom: {
    name: 'Zoom',
    authorizationUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    revokeUrl: 'https://zoom.us/oauth/revoke',
    
    scopes: ['meeting:read', 'meeting:write'],
    
    getAuthParams: () => ({
      client_id: process.env.ZOOM_CLIENT_ID,
      redirect_uri: getCallbackUrl(),
      response_type: 'code'
    }),
    
    exchangeCode: async (code) => {
      const credentials = Buffer.from(
        `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
      ).toString('base64');
      
      const response = await axios.post(providers.zoom.tokenUrl, null, {
        params: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: getCallbackUrl()
        },
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        expiresAt: new Date(Date.now() + (response.data.expires_in * 1000)),
        scopes: response.data.scope ? response.data.scope.split(' ') : providers.zoom.scopes,
        metadata: {}
      };
    },
    
    refreshToken: async (refreshToken) => {
      const credentials = Buffer.from(
        `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
      ).toString('base64');
      
      const response = await axios.post(providers.zoom.tokenUrl, null, {
        params: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        },
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        expiresAt: new Date(Date.now() + (response.data.expires_in * 1000))
      };
    },
    
    revokeToken: async (token) => {
      const credentials = Buffer.from(
        `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
      ).toString('base64');
      
      await axios.post(providers.zoom.revokeUrl, null, {
        params: { token },
        headers: { 'Authorization': `Basic ${credentials}` }
      });
    }
  }
};

/**
 * Get provider configuration
 * @param {string} providerName - Name of the provider
 * @returns {Object|null} - Provider configuration or null
 */
const getProvider = (providerName) => {
  return providers[providerName] || null;
};

/**
 * Get list of all available providers
 * @returns {Array<string>}
 */
const getAvailableProviders = () => {
  return Object.keys(providers);
};

/**
 * Check if a provider is configured (has credentials)
 * @param {string} providerName - Name of the provider
 * @returns {boolean}
 */
const isProviderConfigured = (providerName) => {
  const provider = providers[providerName];
  if (!provider) return false;
  
  switch (providerName) {
    case 'google':
      return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    case 'google_calendar':
      return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    case 'notion':
      return !!(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET);
    case 'slack':
      return !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
    case 'zoom':
      return !!(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
    default:
      return false;
  }
};

/**
 * Build authorization URL for a provider
 * @param {string} providerName - Name of the provider
 * @param {string} state - Encrypted state parameter
 * @returns {string} - Full authorization URL
 */
const buildAuthUrl = (providerName, state) => {
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  
  const params = provider.getAuthParams();
  params.state = state;
  
  const queryString = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  
  return `${provider.authorizationUrl}?${queryString}`;
};

module.exports = {
  providers,
  getProvider,
  getAvailableProviders,
  isProviderConfigured,
  buildAuthUrl,
  getCallbackUrl
};
