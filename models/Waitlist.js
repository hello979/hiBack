const mongoose = require('mongoose');

const WaitlistSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  email: {
    type: String,
    required: true
  },
  joinedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Waitlist', WaitlistSchema);
