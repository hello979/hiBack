# HiCapy Unified OAuth System (Backend)

## Architecture Overview
This backend implements a unified, secure OAuth system for both user login and integrations (Google Calendar, Notion, Slack, etc.) using a **single callback URI**. It is designed for enterprise security, scalability, and ease of adding new providers.

## Key Principles
- **Single OAuth Callback:** All providers redirect to `/oauth/callback`.
- **State-Based Routing:** The `state` parameter is cryptographically signed/encrypted and encodes provider, user, and context. It is strictly validated to prevent CSRF and replay attacks.
- **Backend-Only Token Handling:** OAuth tokens are never exposed to the frontend. They are encrypted at rest and stored in the `Integration` collection.
- **Audit Logging:** All OAuth events (start, callback, refresh, revoke) are logged for security and compliance.

## Main Components
- `utils/crypto.js` — AES-256-GCM encryption for tokens, HMAC signing for state.
- `utils/oauthState.js` — Secure state generation/validation with nonce and expiry.
- `models/Integration.js` — Stores encrypted tokens and metadata for each user/provider.
- `config/oauthProviders.js` — Centralized config for all OAuth providers (easy to add new ones).
- `controllers/oauthController.js` — Handles all OAuth flows (start, callback, disconnect, refresh, status).
- `routes/oauthRoutes.js` — Unified routes for all OAuth operations.
- `utils/oauthAudit.js` — Structured audit logging for all OAuth events.

## OAuth Flow
1. **Start:**
   - `POST /oauth/start` (protected): Generates secure state, returns provider auth URL.
2. **Callback:**
   - `GET /oauth/callback`: Validates state, exchanges code for tokens, stores tokens securely, redirects to frontend.
3. **Status/Disconnect/Refresh:**
   - `GET /oauth/status`, `POST /oauth/disconnect`, `POST /oauth/refresh` (protected): Manage integrations.

## Security Features
- **HTTPS only** (enforced at deployment)
- **Strict redirect URI matching**
- **Signed/encrypted state with nonce**
- **Token encryption at rest**
- **Least-privilege OAuth scopes**
- **Comprehensive audit logging**

## Adding a New Provider
1. Add config to `config/oauthProviders.js`.
2. Add provider to `Integration` model enum.
3. Register credentials in `.env`.
4. No changes to callback routes needed.

## Data Model Example
```
Integration {
  userId,
  provider,
  accessTokenEnc, // encrypted
  refreshTokenEnc, // encrypted
  expiresAt,
  scopes,
  status, // connected/disconnected/expired/error
  metadata, // provider-specific info
  createdAt, updatedAt
}
```

## Migration/Legacy
- Old token fields in `User` model are deprecated; use `Integration` model for all new logic.
- Migration script can move tokens from User to Integration if needed.

## Troubleshooting
- All errors and suspicious events are logged in `logs/oauth-audit-*.log`.
- Use `/oauth/health` to check provider config status.

---
For frontend usage, see `frontend/landing/OAUTH_README.md`.
