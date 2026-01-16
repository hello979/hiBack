const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { 
    type: String, 
    required: [true, 'Username is required'], 
    trim: true,
    minlength: 3,
    maxlength: 30,
    match: [/^[a-zA-Z0-9_ ]+$/, 'Username can only contain letters, numbers, and spaces'] 
  },
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please fill a valid email address'] 
  },
  password: { 
    type: String, 
    select: false 
  },
  schedulerLinkName: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    minlength: 3,
    maxlength: 30,
    match: [/^[a-zA-Z0-9_-]+$/, 'Scheduler link can only contain letters, numbers, hyphens, and underscores']
  },
  googleId: {
    type: String,
    sparse: true,
    index: true
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  access: {
    type: Boolean,
    default: false
  },
  thoughts: {
    type: String,
    default: ''
  },
  notificationPermission: {
    type: Boolean,
    default: false
  },
  waitlist: {
    joined: {
      type: Boolean,
      default: false
    },
    joinedAt: {
      type: Date
    }
  },

  // ============================================================
  // Welcome Modal Tracking
  // ============================================================
  hasSeenWelcome: {
    type: Boolean,
    default: false
  },
  // ============================================================
  // NEW: AGENTIC PREFERENCES (Adaptive Learning)
  // This is where the bot stores what it learns about your style
  // ============================================================
  preferences: {
    // Communication Style (The bot adjusts its drafts based on this)
    communicationStyle: { 
      type: String, 
      enum: ['professional', 'formal', 'casual', 'brief', 'enthusiastic'], 
      default: 'professional' 
    },
    
    // Scheduling Rules
    meetingBufferMinutes: { type: Number, default: 15 }, // "Always leave 15m between calls"
    workingHours: {
      start: { type: String, default: "09:00" },
      end: { type: String, default: "17:00" },
      timezone: { type: String, default: "UTC" }
    },
    workingDays: {
      type: [Number],
      default: [1, 2, 3, 4, 5], // Monday-Friday (0 = Sunday)
      enum: [0, 1, 2, 3, 4, 5, 6]
    },
    publicBooking: {
      enabled: { type: Boolean, default: true },
      meetingDuration: { type: Number, default: 30 },
      headline: { type: String, default: '' },
      welcomeMessage: { type: String, default: '' },
      heroImage: { type: String, default: '' }
    },
    
    // Smart Filtering Lists
    autoTrackList: [{ type: String }],   // e.g., ["important-client.com"]
    blockedDomains: [{ type: String }]   // e.g., ["newsletter-service.com"]
  },

  // ============================================================
  // NEW: DASHBOARD STATS (For Daily Briefing)
  // ============================================================
  dailyStats: {
    emailsProcessed: { type: Number, default: 0 },
    actionsSaved: { type: Number, default: 0 }, // Time saved by using the bot
    learningMoments: { type: Number, default: 0 }, // How many times user corrected the bot
    lastBriefingAt: { type: Date }
  },

  // ============================================================
  // LEGACY / COMPATIBILITY
  // ============================================================

  // Bot service (CueMeet) configuration
  bot_service: {
    enabled: { type: Boolean, default: false },
    api_key: { type: String, select: false },
    created_at: { type: Date },
    last_disabled_at: { type: Date }
  },
  
  // ============================================================
  // DEPRECATED FIELDS (Moved to Integration Model)
  // Keep these for data migration if needed, but do not use for new logic.
  // ============================================================
  
  googleCalendarRefreshToken: { type: String, select: false },
  googleCalendarAccessToken: { type: String, select: false },
  
  notionAccessToken: { type: String, select: false },
  notionWorkspaceId: { type: String },
  notionBotId: { type: String },
  notionWorkspaceName: { type: String },
  notionWorkspaceIcon: { type: String },
  
  slackAccessToken: { type: String, select: false },
  slackTeamId: { type: String },
  slackTeamName: { type: String },
  slackUserId: { type: String },
  slackDefaultChannelId: { type: String },
  slackDefaultChannelName: { type: String },
  
  googleCalendarExpiry: { type: Date },
  calendarSynced: { type: Boolean, default: false },
  calendarLastSynced: { type: Date },
  
  createdAt: { type: Date, default: Date.now },
  team: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] 
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);