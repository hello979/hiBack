const mongoose = require('mongoose');

const ComplaintSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// This creates a collection named 'complaints' in MongoDB
module.exports = mongoose.model('Complaint', ComplaintSchema);