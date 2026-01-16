const express = require('express');
const passport = require('passport');
const { registerUser, loginUser, googleCallback, saveThoughts, saveNotificationPermission, getCurrentUser, joinWaitlist, getWaitlistStatus, updateSchedulingPreferences } = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const router = express.Router();
// Local Auth
router.post('/signup', registerUser);
router.post('/signin', loginUser);

// Google Auth
// 1. Redirect user to Google
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
// Google Calendar connect (protected): returns an auth URL for the client to open
router.post('/google/calendar/initiate', protect, require('../controllers/authController').initiateCalendarConnect);
// Google Calendar OAuth callback
router.get('/google/calendar/callback', require('../controllers/authController').googleCalendarCallback);

// 2. Google redirects back here -> Passport checks code -> Controller issues JWT
router.get(
  '/google/callback',
  (req, res, next) => {
    console.log('Google callback route hit!', req.query);
    passport.authenticate('google', { session: false }, (err, user, info) => {
      // 1. Capture "Bad Request" or "TokenError" here
      if (err || !user) {
        console.error("Google Auth Error:", err, info);
        const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
        // If passport provided an info message (like access denied), pass that to frontend
        if (info && info.message === 'Access denied') {
          return res.redirect(`${frontend}/?error=access_denied`);
        }
        // Redirect back to frontend home on error instead of crashing
        return res.redirect(`${frontend}/?error=auth_failed`);
      }

      // 2. If successful, manually log them in (attach to req)
      req.user = user;
      next();
    })(req, res, next);
  },
  // 3. Proceed to your controller
  require('../controllers/authController').googleCallback
);

// Protected routes - require authentication
router.post('/thoughts', protect, saveThoughts);
router.post('/notification-permission', protect, saveNotificationPermission);
router.post('/waitlist', protect, joinWaitlist);
router.get('/waitlist/status', getWaitlistStatus); // Public endpoint
router.get('/me', protect, getCurrentUser);
// Protected endpoint to fetch calendar events
router.get('/calendar/events', protect, require('../controllers/authController').getCalendarEvents);
// Debug endpoint for calendar token presence
router.get('/calendar/debug', protect, require('../controllers/authController').getCalendarDebug);
router.put('/preferences/scheduling', protect, updateSchedulingPreferences);


// Mark welcome modal as seen
router.post('/welcome-seen', protect, require('../controllers/authController').setWelcomeSeen);

// --- New Waitlist (PROD_MONGO_URL) endpoints ---
const waitlistProd = require('../controllers/waitlistProdController');
router.post('/waitlist', waitlistProd.joinWaitlistProd);
router.get('/waitlist/status', waitlistProd.getWaitlistStatusProd);
router.get('/waitlist/check/:email', waitlistProd.checkWaitlistEmailProd);

// Scheduler link management routes
router.get('/scheduler-link/check/:name', protect, require('../controllers/authController').checkSchedulerLinkAvailability);
router.put('/scheduler-link', protect, require('../controllers/authController').updateSchedulerLinkName);

module.exports = router;