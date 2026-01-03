const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  task_id: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  meeting_id: { 
    type: String, 
    required: true, 
    index: true 
  },
  description: { type: String, required: true },
  
  // Creator Info
  creator_id: { type: String, required: true },
  creator_info: {
    name: String,
    avatar: String
  },
  
  // Assignees
  assignees: [{
    user_id: String,
    name: String,
    avatar: String
  }],
  
  status: { 
    type: String, 
    enum: ['pending', 'in_progress', 'completed'], 
    default: 'pending' 
  },
  
  s3_path: { type: String, required: true }, 
  video_url: { type: String }, 

  // --- CHAT METADATA ---
  comments_count: { type: Number, default: 0 },
  last_message_at: { type: Date, default: Date.now },

  // NEW: Track read status per user
  read_status: [{
    user_id: String,
    last_read_count: { type: Number, default: 0 }
  }],

  // Attachments
  attachments: [{
    name: String,
    s3_key: String,
    file_type: String,
    uploaded_at: { type: Date, default: Date.now }
  }]

}, { timestamps: true });

module.exports = mongoose.model('Task', TaskSchema);