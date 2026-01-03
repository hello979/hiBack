# Unified OAuth Architecture

## Overview

This document describes the production-grade, enterprise-level OAuth architecture implemented for HiCapy. This architecture follows the same patterns used by Big Tech companies (Google, Slack, Notion, Stripe, Zapier) for handling OAuth flows.

## Core Principles

### 1. Single Unified Callback URI

All OAuth providers redirect to **one single callback URL**:

```
https://api.hicapy.com/oauth/callback
```

This URL is registered with ALL OAuth providers (Slack, Notion, Google Calendar, etc.). The `state` parameter determines which provider and user the callback is for.

### 2. State-Based Routing

The `state` parameter is the foundation of security:

- **Cryptographically signed** with HMAC-SHA256
- **Encrypted** with AES-256-GCM
- **Contains a unique nonce** to prevent replay attacks
- **Time-limited** (10-minute TTL)

State payload structure:
```javascript
{
  provider: 'slack',       // Which OAuth provider
  userId: '507f1f77bcf86cd799439011',  // User initiating flow
  flowType: 'integration', // 'login' or 'integration'
  nonce: 'abc123...',      // Unique, one-time use
  timestamp: 1703123456789,
  context: {}              // Optional additional data
}
```

### 3. Backend-Only Token Handling

OAuth tokens are **NEVER** exposed to the frontend:

- ❌ Never in cookies
- ❌ Never in localStorage
- ❌ Never in API responses
- ✅ Stored server-side only
- ✅ Encrypted at rest with AES-256-GCM

## Architecture Components

### File Structure

```
server/
├── config/
│   └── oauthProviders.js    # Provider configurations
├── controllers/
│   └── oauthController.js   # Unified OAuth controller
├── models/
│   └── Integration.js       # Token storage model
├── routes/
│   └── oauthRoutes.js       # Single callback route
├── utils/
│   ├── crypto.js            # Encryption utilities
│   ├── oauthAudit.js        # Audit logging
│   ├── oauthState.js        # State management
│   └── integrationHelper.js # Backward-compatible helpers
└── scripts/
    └── migrate-oauth-tokens.js  # Migration script
```

### Data Model

**Integration Collection**:
```javascript
{
  userId: ObjectId,           // Reference to User
  provider: 'slack',          // Provider identifier
  accessTokenEnc: '...',      // AES-256-GCM encrypted
  refreshTokenEnc: '...',     // AES-256-GCM encrypted
  expiresAt: Date,
  scopes: ['chat:write', ...],
  status: 'connected',        // connected | disconnected | expired | error
  metadata: {
    teamId: '...',
    teamName: '...',
    // Provider-specific metadata
  },
  lastRefreshedAt: Date,
  refreshCount: 5,
  createdAt: Date,
  updatedAt: Date
}
```

## OAuth Flow

### Starting an OAuth Flow

1. **Frontend calls** `POST /oauth/start`
   ```javascript
   const response = await fetch('/oauth/start', {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${token}`,
       'Content-Type': 'application/json'
     },
     body: JSON.stringify({
       provider: 'slack',
       context: {} // optional
     })
   });
   
   const { url } = await response.json();
   window.location.href = url; // Redirect to OAuth provider
   ```

2. **Backend generates secure state**
   - Creates signed/encrypted state with nonce
   - Stores nonce in memory (Redis in production)
   - Builds authorization URL with state

3. **User authenticates** with OAuth provider

4. **Provider redirects** to `/oauth/callback?code=...&state=...`

5. **Backend handles callback**
   - Verifies state signature
   - Validates nonce (one-time use)
   - Checks timestamp (10-minute TTL)
   - Extracts provider and userId from state
   - Exchanges code for tokens
   - Encrypts and stores tokens
   - Redirects to frontend

### Token Refresh

Token refresh happens automatically:
- Before tokens expire (5-minute buffer)
- On-demand when API returns 401
- Via `POST /oauth/refresh`

If refresh fails (token revoked), integration is marked as `expired`.

## API Endpoints

### `POST /oauth/start`
Start OAuth flow for a provider.

**Request:**
```json
{
  "provider": "slack",
  "context": {}
}
```

**Response:**
```json
{
  "success": true,
  "url": "https://slack.com/oauth/v2/authorize?..."
}
```

### `GET /oauth/callback`
OAuth callback (called by provider).

### `POST /oauth/disconnect`
Disconnect an integration.

**Request:**
```json
{
  "provider": "slack"
}
```

### `POST /oauth/refresh`
Manually refresh a token.

### `GET /oauth/status`
Get status of all integrations.

**Response:**
```json
{
  "success": true,
  "data": {
    "slack": {
      "name": "Slack",
      "connected": true,
      "status": "connected",
      "metadata": {
        "teamName": "My Workspace"
      }
    },
    "notion": {
      "name": "Notion",
      "connected": false,
      "status": "not_connected"
    }
  }
}
```

### `GET /oauth/providers`
List available providers.

### `GET /oauth/health`
Health check for OAuth system.

## Security Features

### Encryption at Rest

All tokens are encrypted using AES-256-GCM:
- 256-bit key from `ENC_KEY` environment variable
- Unique IV (nonce) per encryption
- Authentication tag for integrity

Format: `base64(iv):base64(ciphertext):base64(authTag)`

### State Parameter Security

1. **Encryption**: State payload is encrypted with AES-256-GCM
2. **Signing**: Encrypted state is signed with HMAC-SHA256
3. **Nonce**: Unique nonce prevents replay attacks
4. **TTL**: States expire after 10 minutes
5. **One-time use**: Nonces are invalidated after use

### Audit Logging

All OAuth events are logged:
- `OAUTH_START` - User initiated flow
- `OAUTH_CALLBACK` - Callback received
- `OAUTH_SUCCESS` - Token exchange succeeded
- `OAUTH_FAILURE` - Flow failed
- `TOKEN_REFRESH` - Token refreshed
- `TOKEN_REVOKE` - Token revoked
- `INTEGRATION_DISCONNECT` - Integration disconnected

Logs include:
- Timestamp
- User ID
- Provider
- Request metadata (IP, user agent)
- Error details (no secrets)

## Adding a New Provider

1. **Add provider config** to `config/oauthProviders.js`:
   ```javascript
   newProvider: {
     name: 'New Provider',
     authorizationUrl: 'https://provider.com/oauth/authorize',
     tokenUrl: 'https://provider.com/oauth/token',
     scopes: ['read', 'write'],
     getAuthParams: () => ({...}),
     exchangeCode: async (code) => {...},
     refreshToken: async (refreshToken) => {...}
   }
   ```

2. **Add to Integration model enum** in `models/Integration.js`

3. **Add environment variables**:
   ```
   NEWPROVIDER_CLIENT_ID=...
   NEWPROVIDER_CLIENT_SECRET=...
   ```

4. **Register with provider**: Add `OAUTH_CALLBACK_URL` as redirect URI

**No route changes needed!** The unified architecture handles everything.

## Environment Variables

```bash
# OAuth callback URL (register with ALL providers)
OAUTH_CALLBACK_URL=https://api.hicapy.com/oauth/callback

# API base URL
API_BASE_URL=https://api.hicapy.com

# Encryption key (32 bytes, base64)
ENC_KEY=your-256-bit-key-base64

# Signing key (64 bytes, base64)
SIG_KEY=your-512-bit-key-base64

# Provider credentials
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NOTION_CLIENT_ID=...
NOTION_CLIENT_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
```

## Migration

To migrate existing tokens to the new system:

```bash
# Preview changes (dry run)
node scripts/migrate-oauth-tokens.js --dry-run

# Apply migration
node scripts/migrate-oauth-tokens.js

# Force overwrite existing
node scripts/migrate-oauth-tokens.js --force
```

## Connected Logic

Integrations are **NOT session-based**:
- Remain connected across logouts
- Remain connected across browser restarts
- Connectivity depends on token validity, not login sessions

Token lifecycle:
- Access tokens: Short-lived (1 hour typical)
- Refresh tokens: Long-lived (months/years)
- Automatic refresh before expiration
- Re-authorization only when refresh fails

## Scaling Considerations

For horizontal scaling (multiple server instances):

1. **Replace in-memory nonce store with Redis**:
   ```javascript
   // utils/oauthState.js
   const redis = require('redis');
   const client = redis.createClient();
   
   // Store nonce with TTL
   await client.setEx(`nonce:${nonce}`, STATE_TTL_SEC, JSON.stringify(data));
   ```

2. **Use AWS KMS for key management**:
   ```javascript
   // utils/crypto.js
   const { KMS } = require('@aws-sdk/client-kms');
   const kms = new KMS({ region: 'us-east-1' });
   
   const getEncryptionKey = async () => {
     const { Plaintext } = await kms.decrypt({
       CiphertextBlob: Buffer.from(process.env.ENCRYPTED_KEY, 'base64')
     });
     return Plaintext;
   };
   ```

## Troubleshooting

### "Invalid or expired request"
- State expired (>10 minutes old)
- Nonce already used (replay attack prevented)
- State was tampered with

### "Token refresh failed"
- User revoked access at provider
- Provider had an outage
- Check audit logs for details

### Integration shows "expired"
- Refresh token is no longer valid
- User needs to re-authorize
- Check `POST /oauth/refresh` response for `requiresReauth: true`

## Comparison to Legacy System

| Feature | Legacy | New System |
|---------|--------|------------|
| Callback URIs | Multiple (per provider) | Single unified |
| Token storage | User model fields | Dedicated Integration model |
| Token encryption | None | AES-256-GCM |
| State security | User ID only | Signed + encrypted + nonce |
| Audit logging | Basic console | Structured JSON logs |
| Token refresh | Manual | Automatic |
| Multi-provider | Hard to add | Easy to add |
| Horizontal scaling | Not safe | Safe (stateless) |
