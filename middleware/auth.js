const jwt = require('jsonwebtoken');
const User = require('../models/users');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';

// Middleware to protect routes - verify JWT token
exports.protect = async (req, res, next) => {
  // CRITICAL: Skip auth for OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    return next();
  }

  let token;

  // Check for token in Authorization header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    // Ensure CORS headers are set on 401 responses
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    return res.status(401).json({ msg: 'Not authorized, no token' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Get user from token
    // Include calendar token fields when attaching req.user so downstream handlers
    // can inspect whether calendar tokens are present without extra queries.
    req.user = await User.findById(decoded.id).select('+googleCalendarRefreshToken +googleCalendarAccessToken +bot_service.api_key');
    
    if (!req.user) {
      // Ensure CORS headers are set on 401 responses
      if (req.headers.origin) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      return res.status(401).json({ msg: 'User not found' });
    }

    next();
  } catch (err) {
    console.error('Token verification error:', err);
    // Ensure CORS headers are set on 401 responses
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    return res.status(401).json({ msg: 'Not authorized, token failed' });
  }
};

