const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  messageId: {
    type: String,
    required: true
  },
  isPositive: {
    type: Boolean,
    required: true
  },
  messageText: {
    type: String,
    maxlength: 500
  },
  sources: [{
    type: { type: String },
    title: String
  }],
  // Learning metadata
  category: String, // What type of response was this? email, meeting, task, etc.
  feedbackContext: {
    timeOfDay: String, // morning, afternoon, evening
    dayOfWeek: String,
    responseLength: Number
  }
}, { 
  timestamps: true 
});

// Index for quick lookups
feedbackSchema.index({ userId: 1, createdAt: -1 });
feedbackSchema.index({ userId: 1, isPositive: 1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
