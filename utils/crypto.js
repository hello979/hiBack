/**
 * Crypto Utilities for OAuth Token Encryption/Decryption
 * 
 * Uses AES-256-GCM for authenticated encryption of tokens at rest.
 * This provides both confidentiality and integrity protection.
 * 
 * SECURITY NOTES:
 * - ENC_KEY should be 32 bytes (256 bits) base64-encoded
 * - Each encryption uses a unique IV (nonce) for semantic security
 * - Auth tag prevents tampering
 * - Compatible with AWS KMS for key management in production
 */

const crypto = require('crypto');

// Configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits is optimal for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const ENCODING = 'base64';

/**
 * Get encryption key from environment
 * In production, this should come from AWS KMS or similar
 */
const getEncryptionKey = () => {
  const keyBase64 = process.env.ENC_KEY;
  if (!keyBase64) {
    throw new Error('ENC_KEY environment variable is required for encryption');
  }
  
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENC_KEY must be exactly 32 bytes (256 bits) when decoded');
  }
  
  return key;
};

/**
 * Get signing key from environment
 * Used for HMAC operations on state parameters
 */
const getSigningKey = () => {
  const keyBase64 = process.env.SIG_KEY;
  if (!keyBase64) {
    throw new Error('SIG_KEY environment variable is required for signing');
  }
  
  return Buffer.from(keyBase64, 'base64');
};

/**
 * Encrypt a plaintext string
 * @param {string} plaintext - The text to encrypt
 * @returns {string} - Base64 encoded encrypted data (iv:ciphertext:authTag)
 */
const encrypt = (plaintext) => {
  if (!plaintext) return null;
  
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', ENCODING);
    encrypted += cipher.final(ENCODING);
    
    const authTag = cipher.getAuthTag();
    
    // Format: iv:ciphertext:authTag (all base64)
    return `${iv.toString(ENCODING)}:${encrypted}:${authTag.toString(ENCODING)}`;
  } catch (error) {
    console.error('Encryption error:', error.message);
    throw new Error('Encryption failed');
  }
};

/**
 * Decrypt an encrypted string
 * @param {string} encryptedData - Base64 encoded encrypted data (iv:ciphertext:authTag)
 * @returns {string|null} - Decrypted plaintext or null if decryption fails
 */
const decrypt = (encryptedData) => {
  if (!encryptedData) return null;
  
  try {
    const key = getEncryptionKey();
    
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }
    
    const [ivBase64, ciphertext, authTagBase64] = parts;
    
    const iv = Buffer.from(ivBase64, ENCODING);
    const authTag = Buffer.from(authTagBase64, ENCODING);
    
    if (iv.length !== IV_LENGTH) {
      throw new Error('Invalid IV length');
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Invalid auth tag length');
    }
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertext, ENCODING, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    return null; // Return null instead of throwing to handle invalid/tampered data gracefully
  }
};

/**
 * Create an HMAC signature
 * @param {string} data - Data to sign
 * @returns {string} - Base64 encoded HMAC signature
 */
const sign = (data) => {
  const key = getSigningKey();
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(data);
  return hmac.digest(ENCODING);
};

/**
 * Verify an HMAC signature
 * @param {string} data - Original data
 * @param {string} signature - Base64 encoded signature to verify
 * @returns {boolean} - True if signature is valid
 */
const verifySignature = (data, signature) => {
  try {
    const expectedSignature = sign(data);
    // Use timing-safe comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature, ENCODING),
      Buffer.from(expectedSignature, ENCODING)
    );
  } catch (error) {
    return false;
  }
};

/**
 * Generate a cryptographically secure random string
 * @param {number} length - Length in bytes
 * @returns {string} - URL-safe base64 encoded random string
 */
const generateSecureRandom = (length = 32) => {
  return crypto.randomBytes(length).toString('base64url');
};

/**
 * Hash a string using SHA-256
 * @param {string} data - Data to hash
 * @returns {string} - Hex encoded hash
 */
const hash = (data) => {
  return crypto.createHash('sha256').update(data).digest('hex');
};

/**
 * Generate a new encryption key (utility for setup)
 * @returns {string} - Base64 encoded 256-bit key
 */
const generateEncryptionKey = () => {
  return crypto.randomBytes(32).toString('base64');
};

/**
 * Generate a new signing key (utility for setup)
 * @returns {string} - Base64 encoded 512-bit key
 */
const generateSigningKey = () => {
  return crypto.randomBytes(64).toString('base64');
};

module.exports = {
  encrypt,
  decrypt,
  sign,
  verifySignature,
  generateSecureRandom,
  hash,
  generateEncryptionKey,
  generateSigningKey,
  ALGORITHM
};
