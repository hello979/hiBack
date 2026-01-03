const mongoose = require('mongoose');

// Cache sender decisions to avoid repeated API calls
const SenderCacheSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  senderEmail: { type: String, required: true, lowercase: true },
  senderName: String,
  
  // User's decision about this sender
  decision: { 
    type: String, 
    enum: ['process', 'ignore', 'ask'], 
    default: 'ask' 
  },
  
  // AI-classified category
  category: { 
    type: String, 
    enum: ['work', 'client', 'personal', 'promotional', 'newsletter', 'unknown'],
    default: 'unknown'
  },
  
  // Relationship context
  relationship: String, // "Sarah is VP at Acme Corp"
  
  // Stats
  emailCount: { type: Number, default: 1 },
  lastEmailAt: { type: Date, default: Date.now },
  firstSeen: { type: Date, default: Date.now },
  
  // Auto-approval settings
  autoApprove: { type: Boolean, default: false }, // "Always handle emails from this sender"
  
}, { timestamps: true });

// Compound index for fast lookups
SenderCacheSchema.index({ userId: 1, senderEmail: 1 }, { unique: true });

module.exports = mongoose.model('SenderCache', SenderCacheSchema);
