const mongoose = require('mongoose');

const ActionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  
  // What triggered this?
  source: { type: String, enum: ['email', 'calendar', 'slack', 'system', 'chat'], required: true },
  sourceId: String, // email messageId or calendar eventId
  threadId: String, // for email thread continuity
  
  // The Proposal
  type: { 
    type: String, 
    enum: [
      'draft_reply', 
      'schedule_meeting', 
      'follow_up', 
      'data_entry', 
      'reminder', 
      'clarify',
      'send_email',
      'assign_bot',
      'assign_task',
      'cancel_meeting',
      'reschedule_meeting',
      'start_meeting_with_bot',
      'send_team_invite'
    ], 
    required: true 
  },
  confidence: { type: Number, min: 0, max: 100 },
  urgency: { type: String, enum: ['low', 'normal', 'high', 'critical'], default: 'normal' },
  
  // The Content (Rich payload for the UI) - Using Mixed to allow flexible schema
  payload: mongoose.Schema.Types.Mixed,
  
  // Context used for decision
  context: {
    sources: [{ 
      type: { type: String },  // 'email', 'meeting', 'slack'
      date: String,
      summary: String
    }],
    reasoning: String
  },
  
  // User feedback for learning
  userFeedback: {
    edited: Boolean,
    editedContent: String,
    rejectionReason: String
  },
  
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected', 'edited', 'expired', 'auto_approved'], 
    default: 'pending' 
  },
  
  resolvedAt: Date,
  createdAt: { type: Date, default: Date.now, expires: 86400 } // 24h TTL
});

ActionSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Action', ActionSchema);