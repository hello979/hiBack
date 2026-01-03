/**
 * OAuth State Manager
 * 
 * Implements secure, signed, encrypted state parameter handling for OAuth flows.
 * This is the CRITICAL security component that enables:
 * - Single unified callback URI for all OAuth providers
 * - CSRF protection via signed nonces
 * - Replay attack prevention via nonce expiration
 * - Secure routing based on state content
 * 
 * STATE FORMAT (after decryption):
 * {
 *   provider: 'slack' | 'notion' | 'google' | 'google_calendar' | ...,
 *   userId: string,
 *   nonce: string,
 *   timestamp: number,
 *   flowType: 'login' | 'integration',
 *   context: object  // optional provider-specific data
 * }
 * 
 * SECURITY NOTES:
 * - State is encrypted with AES-256-GCM (confidentiality + integrity)
 * - Additional HMAC signature for double verification
 * - Nonces are stored in-memory with TTL (use Redis in production for horizontal scaling)
 * - Strict timestamp validation prevents replay of old states
 */

const crypto = require('./crypto');

// In-memory nonce store (use Redis in production for horizontal scaling)
// Map<nonce, { expiresAt: timestamp, used: boolean }>
const nonceStore = new Map();

// Configuration
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes - states expire after this
const CLEANUP_INTERVAL_MS = 60 * 1000; // Cleanup expired nonces every minute

// Cleanup expired nonces periodically
setInterval(() => {
  const now = Date.now();
  for (const [nonce, data] of nonceStore.entries()) {
    if (data.expiresAt < now) {
      nonceStore.delete(nonce);
    }
  }
}, CLEANUP_INTERVAL_MS);

/**
 * Generate a secure OAuth state parameter
 * 
 * @param {Object} options - State options
 * @param {string} options.provider - OAuth provider identifier
 * @param {string} options.userId - User ID initiating the flow
 * @param {string} options.flowType - 'login' or 'integration'
 * @param {Object} [options.context] - Optional additional context
 * @returns {string} - URL-safe encrypted and signed state string
 */
const generateState = ({ provider, userId, flowType, context = {} }) => {
  if (!provider || !userId || !flowType) {
    throw new Error('provider, userId, and flowType are required');
  }
  
  // Generate a unique nonce
  const nonce = crypto.generateSecureRandom(16);
  const timestamp = Date.now();
  
  // Store nonce with expiration
  nonceStore.set(nonce, {
    expiresAt: timestamp + STATE_TTL_MS,
    used: false
  });
  
  // Construct state payload
  const statePayload = {
    provider,
    userId,
    flowType,
    nonce,
    timestamp,
    context
  };
  
  // Serialize and encrypt
  const stateJson = JSON.stringify(statePayload);
  const encrypted = crypto.encrypt(stateJson);
  
  // Sign the encrypted data for additional verification
  const signature = crypto.sign(encrypted);
  
  // Combine encrypted data and signature, make URL-safe
  const combined = `${encrypted}.${signature}`;
  
  // URL-safe encoding (replace characters that might cause issues)
  return Buffer.from(combined).toString('base64url');
};

/**
 * Verify and decode an OAuth state parameter
 * 
 * @param {string} stateParam - The state parameter from the OAuth callback
 * @returns {Object|null} - Decoded state payload or null if invalid
 * @returns {string} return.provider - OAuth provider
 * @returns {string} return.userId - User ID
 * @returns {string} return.flowType - Flow type
 * @returns {Object} return.context - Additional context
 */
const verifyState = (stateParam) => {
  if (!stateParam) {
    console.error('State parameter is missing');
    return null;
  }
  
  try {
    // Decode from URL-safe base64
    const combined = Buffer.from(stateParam, 'base64url').toString('utf8');
    
    // Split encrypted data and signature
    const lastDotIndex = combined.lastIndexOf('.');
    if (lastDotIndex === -1) {
      console.error('Invalid state format: missing signature separator');
      return null;
    }
    
    const encrypted = combined.substring(0, lastDotIndex);
    const signature = combined.substring(lastDotIndex + 1);
    
    // Verify signature
    if (!crypto.verifySignature(encrypted, signature)) {
      console.error('State signature verification failed');
      return null;
    }
    
    // Decrypt
    const stateJson = crypto.decrypt(encrypted);
    if (!stateJson) {
      console.error('State decryption failed');
      return null;
    }
    
    // Parse JSON
    const statePayload = JSON.parse(stateJson);
    
    // Validate timestamp (prevent replay of very old states)
    const now = Date.now();
    if (now - statePayload.timestamp > STATE_TTL_MS) {
      console.error('State has expired');
      return null;
    }
    
    // Validate and consume nonce (one-time use)
    const nonceData = nonceStore.get(statePayload.nonce);
    if (!nonceData) {
      console.error('Nonce not found (possibly expired or already used)');
      return null;
    }
    
    if (nonceData.used) {
      console.error('Nonce has already been used (replay attack detected)');
      return null;
    }
    
    // Mark nonce as used
    nonceData.used = true;
    
    // Return validated state
    return {
      provider: statePayload.provider,
      userId: statePayload.userId,
      flowType: statePayload.flowType,
      context: statePayload.context || {},
      timestamp: statePayload.timestamp
    };
    
  } catch (error) {
    console.error('State verification error:', error.message);
    return null;
  }
};

/**
 * Invalidate a specific nonce (manual cleanup)
 * @param {string} nonce - Nonce to invalidate
 */
const invalidateNonce = (nonce) => {
  nonceStore.delete(nonce);
};

/**
 * Get stats about the nonce store (for debugging/monitoring)
 * @returns {Object} - Stats about active nonces
 */
const getNonceStats = () => {
  const now = Date.now();
  let active = 0;
  let used = 0;
  let expired = 0;
  
  for (const [, data] of nonceStore.entries()) {
    if (data.expiresAt < now) {
      expired++;
    } else if (data.used) {
      used++;
    } else {
      active++;
    }
  }
  
  return { active, used, expired, total: nonceStore.size };
};

module.exports = {
  generateState,
  verifyState,
  invalidateNonce,
  getNonceStats,
  STATE_TTL_MS
};
