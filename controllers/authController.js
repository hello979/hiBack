const User = require('../models/users');
const Waitlist = require('../models/Waitlist');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// In-memory map to throttle calendar event requests per user.
// Key: userId (string) -> timestamp (ms)
const calendarFetchTimestamps = new Map();

// Helper to generate JWT (with safe fallback for missing secret in dev)
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';

const generateToken = (id) => {
  try {
    return jwt.sign({ id }, JWT_SECRET, { expiresIn: '1d' });
  } catch (err) {
    console.error('JWT sign error:', err);
    return null;
  }
};

// @desc    Register new user (Local)
exports.registerUser = async (req, res) => {
  console.log('[/api/auth/signup] Incoming body:', req.body);
  const { username, email, password } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ msg: 'User already exists' });

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = await User.create({ username, email, password: hashedPassword });
    // Issue token even if access is false; frontend will show ThankYou page when access=false
    const token = generateToken(user._id);

    if (!token) {
      return res.status(500).json({ msg: 'Token generation failed' });
    }

    res.status(201).json({ token, user: { id: user._id, username, email, access: user.access } });
  } catch (err) {
    console.error('Signup Error:', err);

    // Duplicate email (Mongo E11000)
    if (err.code === 11000 && err.keyPattern && err.keyPattern.email) {
      return res.status(400).json({ msg: 'User already exists' });
    }

    // Mongoose validation errors
    if (err.name === 'ValidationError') {
      return res
        .status(400)
        .json({ msg: Object.values(err.errors).map(val => val.message).join(', ') });
    }

    res.status(500).json({ msg: 'Server error' });
  }
};

// @desc    Login user (Local)
exports.loginUser = async (req, res) => {
  console.log('[/api/auth/signin] Incoming body:', req.body);
  const { email, password } = req.body;
  try {
    // Explicitly select password (it's excluded by default in the schema)
    const user = await User.findOne({ email }).select('+password');
    if (!user) return res.status(400).json({ msg: 'Invalid credentials' });

    // If user registered via Google, they might not have a password
    if (!user.password) return res.status(400).json({ msg: 'Please login with Google' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: 'Invalid credentials' });


    const token = generateToken(user._id);
    if (!token) {
      return res.status(500).json({ msg: 'Token generation failed' });
    }

    // Use the username from the user document, not an undefined variable
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, access: user.access } });
  } catch (err) {
    console.error('Signin Error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @desc    Handle Google Callback
exports.googleCallback = (req, res) => {
  // Passport has already verified the user and attached it to req.user
  const token = generateToken(req.user._id);
  if (!token) {
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/?error=token_failed`);
  }
  // Redirect to frontend with token and access flag in query param (or set a cookie)
  // In production, use httpOnly cookies for better security
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
  const access = req.user && req.user.access ? 'true' : 'false';
  res.redirect(`${frontend}/?token=${token}&access=${access}`);
};

// @desc    Save user thoughts/message
exports.saveThoughts = async (req, res) => {
  try {
    const { thoughts } = req.body;
    const userId = req.user._id;

    const user = await User.findByIdAndUpdate(
      userId,
      { thoughts: thoughts || '' },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.json({ msg: 'Thoughts saved successfully', user });
  } catch (err) {
    console.error('Save thoughts error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @desc    Save notification permission
exports.saveNotificationPermission = async (req, res) => {
  try {
    const { notificationPermission } = req.body;
    const userId = req.user._id;

    const user = await User.findByIdAndUpdate(
      userId,
      { notificationPermission: notificationPermission || false },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.json({ msg: 'Notification permission saved successfully', user });
  } catch (err) {
    console.error('Save notification permission error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @desc    Get current logged-in user
exports.getCurrentUser = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ msg: 'Not authorized' });
    const user = req.user;
    res.json({ user: { id: user._id, username: user.username, email: user.email, access: user.access, calendarConnected: !!(user.googleCalendarRefreshToken || user.googleCalendarAccessToken), calendarSynced: user.calendarSynced, calendarLastSynced: user.calendarLastSynced } });
  } catch (err) {
    console.error('Get current user error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// Google Calendar: Initiate OAuth flow and return auth URL (protected)
exports.initiateCalendarConnect = (req, res) => {
  try {
    const { google } = require('googleapis');
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALENDAR_CALLBACK_URL || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/google/calendar/callback`
    );

    // Use state to carry the user's JWT so callback can identify the user
    const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
    if (!token) return res.status(401).json({ msg: 'Not authorized' });

    const scope = ['https://www.googleapis.com/auth/calendar.readonly'];
    const url = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope,
      prompt: 'consent',
      state: token
    });
    console.log('Initiating calendar connect for token present:', !!token, 'authUrl-startsWith:', url && url.substring(0, 40));
    try {
      const logger = require('../utils/logger');
      logger.logEvent(`INITIATE_CALENDAR tokenPresent:${!!token}`);
    } catch (e) {
      console.error('Failed to write initiate log', e);
    }

    res.json({ url });
  } catch (err) {
    console.error('Initiate calendar connect error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// Google Calendar OAuth callback - exchange code for tokens and save on user
exports.googleCalendarCallback = async (req, res) => {
  try {
    const { code, state } = req.query;
    console.log('googleCalendarCallback hit, query keys:', Object.keys(req.query));
    try {
      const logger = require('../utils/logger');
      logger.logEvent(`CALLBACK_CALENDAR query:${JSON.stringify(req.query)}`);
    } catch (e) {
      console.error('Failed to write callback log', e);
    }
    const token = state; // JWT passed via state
    console.log('state jwt present:', !!token);
    if (!token) return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/?calendar=failed`);

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.id;

    const { google } = require('googleapis');
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALENDAR_CALLBACK_URL || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/google/calendar/callback`
    );

    const { tokens } = await oAuth2Client.getToken(code);
    console.log('Exchanged code for tokens keys:', Object.keys(tokens));
    try {
      const logger = require('../utils/logger');
      logger.logEvent(`TOKENS_KEYS:${Object.keys(tokens).join(',')} refresh_present:${!!tokens.refresh_token}`);
    } catch (e) {
      console.error('Failed to write tokens log', e);
    }

    const user = await require('../models/users').findById(userId);
    if (!user) return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/?calendar=failed`);

    // Save refresh token if present (only returned on first consent or when prompt=consent)
    if (tokens.refresh_token) {
      user.googleCalendarRefreshToken = tokens.refresh_token;
    } else {
      console.log('No refresh_token returned in tokens (may require re-consent).');
    }
    user.googleCalendarAccessToken = tokens.access_token;
    user.googleCalendarExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    user.calendarSynced = true;
    user.calendarLastSynced = new Date();
    await user.save();
    console.log(`Google Calendar connected for user=${userId} refresh_token_saved=${!!tokens.refresh_token}`);

    // Redirect to frontend to indicate success
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/?calendar=connected`);
  } catch (err) {
    console.error('Google Calendar callback error:', err);
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/?calendar=failed`);
  }
};

// Fetch upcoming calendar events for the logged-in user
// @desc    Fetch calendar events for the logged-in user (supports ?month=0&year=2024)
// server/controllers/authController.js



exports.getCalendarEvents = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ msg: 'Not authorized' });

    // 1. Get Params FIRST (so we can use them for the throttle key)
    const currentYear = new Date().getFullYear();
    const year = req.query.year ? parseInt(req.query.year) : currentYear;

    // Handle Month: Check for undefined because parseInt("0") is falsy
    const currentMonth = new Date().getMonth();
    const month = req.query.month !== undefined ? parseInt(req.query.month) : currentMonth;
   

    // Calculate timeMin (1st day of requested month)
    const timeMin = new Date(year, month, 1);
    // Calculate timeMax (Last day of requested month)
    // Note: '0' as day gets the last day of previous month, so we use month + 1
    const timeMax = new Date(year, month + 1, 0, 23, 59, 59);

    console.log(`Fetching for User:${user._id} | ${year}-${month+1} | Range: ${timeMin.toISOString()} -> ${timeMax.toISOString()}`);

    // 2. SMART THROTTLE LOGIC
    // Key is unique per user AND per month view
    const throttleKey = `${user._id}_${year}_${month}`; 
    const now = Date.now();
    const last = calendarFetchTimestamps.get(throttleKey) || 0;
    
    // Reduce cooldown to 10 seconds (enough to stop spam scripts, fast enough for humans)
    const THROTTLE_MS = 10 * 1000; 

    if (now - last < THROTTLE_MS) {
      const wait = Math.ceil((THROTTLE_MS - (now - last)) / 1000);
      // We return 429 but we can also just return cached data if you had it. 
      // For now, we stick to the block to save API quota.
      return res.status(429).json({ 
        msg: `Please wait ${wait}s before refreshing this month.`, 
        retryAfter: wait 
      });
    }
    
    // Save timestamp for this specific month view
    calendarFetchTimestamps.set(throttleKey, now);

    // --- GOOGLE API FETCH (Standard Logic) ---
    const { google } = require('googleapis');
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALENDAR_CALLBACK_URL || `${process.env.FRONTEND_URL}/auth/google/calendar/callback`
    );

    // Use new helper that checks both 'google' and 'google_calendar' providers
    const integrationHelper = require('../utils/integrationHelper');
    const googleTokens = await integrationHelper.getGoogleToken(user._id);
    const { accessToken, refreshToken, provider } = googleTokens;

    if (refreshToken) {
      oAuth2Client.setCredentials({ refresh_token: refreshToken });
    } else if (accessToken) {
      oAuth2Client.setCredentials({ access_token: accessToken });
    } else {
      return res.status(400).json({ msg: 'Calendar not connected' });
    }
    
    console.log(`[CalendarEvents] Using ${provider} provider`);

    const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });


    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime'
    });

    user.calendarLastSynced = new Date();
    await user.save();

    res.json({ events: eventsRes.data.items || [], calendarLastSynced: user.calendarLastSynced });

  } catch (err) {
    console.error('Calendar error:', err.message);
    res.status(500).json({ msg: 'Failed to load calendar events' });
  }
};
// Debug: return calendar token presence for the logged-in user (no secrets)
exports.getCalendarDebug = async (req, res) => {
  try {
    // Re-fetch user including secret token fields to be sure we report accurate presence
    const userId = req.user && req.user._id;
    if (!userId) return res.status(401).json({ msg: 'Not authorized' });
    const user = await User.findById(userId).select('+googleCalendarRefreshToken +googleCalendarAccessToken');
    if (!user) return res.status(404).json({ msg: 'User not found' });
    res.json({
      googleCalendarRefreshTokenPresent: !!user.googleCalendarRefreshToken,
      googleCalendarAccessTokenPresent: !!user.googleCalendarAccessToken,
      googleCalendarExpiry: user.googleCalendarExpiry || null,
      calendarSynced: !!user.calendarSynced,
      calendarLastSynced: user.calendarLastSynced || null
    });
  } catch (err) {
    console.error('Calendar debug error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @desc    Join the waitlist
exports.joinWaitlist = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Update User model
    user.waitlist = {
      joined: true,
      joinedAt: new Date()
    };
    await user.save();

    // Update Waitlist collection (upsert to avoid duplicates)
    await Waitlist.findOneAndUpdate(
      { user: user._id },
      { 
        user: user._id,
        email: user.email,
        joinedAt: new Date()
      },
      { upsert: true, new: true }
    );

    // Get updated count
    const count = await Waitlist.countDocuments();
    const totalJoined = 24 + count;

    res.json({ 
      msg: 'Joined waitlist successfully', 
      waitlist: user.waitlist,
      totalJoined 
    });
  } catch (err) {
    console.error('Join Waitlist Error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};

// @desc    Get waitlist status (count)
exports.getWaitlistStatus = async (req, res) => {
  try {
    const count = await Waitlist.countDocuments();
    // Base count is 24 as requested
    const totalJoined = 24 + count;
    
    // Check if current user is joined (if logged in)
    let isJoined = false;
    if (req.user) {
      const waitlistEntry = await Waitlist.findOne({ user: req.user.id });
      if (waitlistEntry) isJoined = true;
    }

    res.json({ 
      totalJoined,
      seatsAvailable: 100, // Static for now, or 100 - totalJoined
      isJoined
    });
  } catch (err) {
    console.error('Get Waitlist Status Error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
};