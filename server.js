require('dotenv').config();
const express = require('express');
const connectDB = require('./config/db');
const passport = require('passport');
const path = require('path');
const mongoSanitize = require('express-mongo-sanitize');
const helmet = require('helmet');
const fs = require('fs');
const mongoose = require('mongoose');
const logger = require('./utils/logger');
const complaintsRoute = require('./routes/complaints');
// --- 1. IMPORT THE NEW ROUTES ---
const transcriptRoutes = require('./routes/transcriptRoutes');
const meetingRoutes = require('./routes/meetingRoutes');
const integrationRoutes = require('./routes/integrationRoutes');
const oauthRoutes = require('./routes/oauthRoutes');
const botRoutes = require('./routes/botRoutes');
const notesRoute = require('./routes/notes');
const schedulingRoutes = require('./routes/schedulingRoutes');
// Fail fast if critical environment variables are missing
const requiredEnv = ['MONGO_URI', 'JWT_SECRET'];
const missingEnv = requiredEnv.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('Missing required environment variables:', missingEnv.join(', '));
  process.exit(1);
}
const summarizerRoutes = require('./routes/summarizerRoutes');
const actionRoutes = require('./routes/actionRoutes');
const chatRoutes = require('./routes/chatRoutes');

require('./workers/emailProcessor'); 
require('./workers/ingestionWorker');
// Configs
require('./config/passport')(passport);
connectDB();

const app = express();

// ============================================
// CRITICAL: Trust proxy for Render/Heroku/etc
// This MUST be before any middleware
// ============================================
app.set('trust proxy', 1);

// ============================================
// CORS Configuration - MUST BE ABSOLUTELY FIRST
// ============================================
const allowedOrigins = [
  'https://hicapy.com',             
  'https://www.hicapy.com',
  'https://hicapy.vercel.app'
];

// Add localhost origins only in development
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5173');
}

// Add FRONTEND_URL if set and not already included
if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

console.log('=== CORS Configuration ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('Allowed origins:', allowedOrigins);

// Helper function to set CORS headers
const setCorsHeaders = (req, res) => {
  const origin = req.headers.origin;
  
  // Set CORS headers for allowed origins
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  } else {
    console.log(`[CORS] Origin not allowed: ${origin}`);
  }
};

// CORS middleware - MUST BE ABSOLUTELY FIRST before any other middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Log all requests
  if (req.method === 'OPTIONS') {
    console.log(`[PREFLIGHT] ${req.method} ${req.path} from ${origin || 'no-origin'}`);
  }
  
  // Set CORS headers
  setCorsHeaders(req, res);
  
  // Handle preflight requests immediately - do not continue
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  next();
});

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Helmet - with CORS-safe configuration
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'unsafe-none' },
    crossOriginEmbedderPolicy: false
  })
);

// Body Parser - increased limit for chat context
app.use(express.json({ limit: '500kb' })); 

// File Upload
const fileUpload = require('express-fileupload');
app.use(fileUpload({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  abortOnLimit: true,
  createParentPath: true
})); 

// Mongo Sanitize
app.use((req, res, next) => {
  if (req.body) {
    req.body = mongoSanitize.sanitize(req.body);
  }
  if (req.params) {
    req.params = mongoSanitize.sanitize(req.params);
  }
  next();
});

// ============================================
// PASSPORT
// ============================================
app.use(passport.initialize());

// Debug/Logging middleware
app.use((req, res, next) => {
  // Skip logging for OPTIONS since we already log them
  if (req.method === 'OPTIONS') return next();
  
  const origin = req.headers.origin || '-';
  const ip = req.ip || req.connection?.remoteAddress || '-';
  const line = `${req.method} ${req.path} origin:${origin} ip:${ip}`;
  console.log(`${new Date().toISOString()} ${line}`);
  try {
    logger.logRequest(line);
  } catch (e) {
    // Silent fail for logging
  }
  next();
});

// ============================================
// HEALTH CHECK & TEST ROUTES
// ============================================
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/test', (req, res) => {
  res.json({ 
    message: 'Server is running', 
    timestamp: new Date().toISOString(),
    cors: {
      origin: req.headers.origin,
      allowedOrigins: allowedOrigins
    }
  });
});

// ============================================
// API ROUTES
// ============================================
app.use('/auth', require('./routes/authRoutes'));
app.use('/api/transcripts', transcriptRoutes);
app.use('/api/meetings', meetingRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/bots', botRoutes);
app.use('/oauth', oauthRoutes);
app.use('/api/summarizer', summarizerRoutes);
app.use('/api', complaintsRoute);
app.use('/api/notes', notesRoute);
app.use('/api/team', require('./routes/team'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/actions', actionRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/schedule', schedulingRoutes);
// Static files (with redirect disabled to prevent CORS issues)
app.use(express.static(path.join(__dirname, 'public'), { redirect: false }));

// ============================================
// ERROR HANDLERS
// ============================================

// 404 handler - MUST set CORS headers for error responses
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  setCorsHeaders(req, res);
  res.status(404).json({ 
    error: 'Route not found', 
    method: req.method, 
    path: req.path
  });
});

// Global error handler - MUST set CORS headers for error responses
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  setCorsHeaders(req, res);
  res.status(err.status || 500).json({ 
    error: err.message || 'Internal server error',
    path: req.path 
  });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server secure on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'not set'}`);
  console.log(`Google Callback URL: ${process.env.GOOGLE_CALLBACK_URL || 'not set'}`);
});

// Graceful shutdown helper
const shutdown = async (reason, code = 0) => {
  console.error(`Shutting down: ${reason}`);
  try {
    server.close(async () => {
      await mongoose.connection.close();
      console.log('MongoDB connection closed. Exiting.');
      process.exit(code);
    });
    setTimeout(() => {
      console.warn('Forcing exit after timeout');
      process.exit(code);
    }, 5000);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason);
  logger.logError(reason);
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  logger.logError(err);
  shutdown('uncaughtException', 1);
});