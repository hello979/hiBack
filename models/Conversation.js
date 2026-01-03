const mongoose = require('mongoose');

// ============================================
// CONVERSATION MODEL
// Persists chat history for context-aware AI
// ============================================

const MessageSchema = new mongoose.Schema({
  role: { 
    type: String, 
    enum: ['user', 'assistant', 'system'], 
    required: true 
  },
  content: { 
    type: String, 
    required: true 
  },
  // Intent classification for this message
  intent: {
    type: { 
      type: String, 
      enum: ['information', 'action', 'exploratory', 'approval', 'unknown'] 
    },
    confidence: Number,
    actionType: String // For action intents: 'send_email', 'schedule_meeting', etc.
  },
  // Context retrieved from Knowledge Graph for this message
  contextUsed: [{
    source: String,
    text: String,
    date: String
  }],
  // If an action was created from this message
  actionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Action' },
  timestamp: { type: Date, default: Date.now }
}, { _id: true });

const ConversationSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    index: true 
  },
  
  // Conversation metadata
  title: { type: String, default: 'New Conversation' },
  status: { 
    type: String, 
    enum: ['active', 'archived', 'deleted'], 
    default: 'active' 
  },
  
  // Messages in this conversation (ordered by timestamp)
  messages: [MessageSchema],
  
  // Conversation context summary (for long conversations)
  summary: String,
  
  // Entities mentioned in this conversation (for pronoun resolution)
  entities: {
    people: [{
      name: String,
      email: String,
      lastMentioned: Date,
      context: String // "Sarah from the Q4 report email"
    }],
    meetings: [{
      title: String,
      eventId: String,
      date: Date,
      lastMentioned: Date
    }],
    emails: [{
      subject: String,
      messageId: String,
      threadId: String,
      from: String,
      lastMentioned: Date
    }],
    topics: [String] // "Q4 report", "investor update", etc.
  },
  
  // Last active entity references (for "it", "her", "that email" resolution)
  lastReferences: {
    email: {
      messageId: String,
      subject: String,
      from: String,
      fromEmail: String
    },
    person: {
      name: String,
      email: String
    },
    meeting: {
      eventId: String,
      title: String,
      date: Date
    },
    document: {
      name: String,
      source: String,
      url: String
    },
    tasks: [{
      id: String,
      description: String,
      status: String,
      source: String
    }]
  },
  
  // Pending action awaiting approval
  pendingAction: {
    actionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Action' },
    type: { type: String },
    createdAt: Date
  },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastMessageAt: { type: Date, default: Date.now }
});

// Index for efficient queries
ConversationSchema.index({ userId: 1, status: 1, lastMessageAt: -1 });
ConversationSchema.index({ userId: 1, 'messages.timestamp': -1 });

// Auto-update timestamps (using async/await style, no next() needed)
ConversationSchema.pre('save', function() {
  this.updatedAt = new Date();
  if (this.messages.length > 0) {
    this.lastMessageAt = this.messages[this.messages.length - 1].timestamp;
  }
});

// Static method to get or create active conversation
ConversationSchema.statics.getOrCreateActive = async function(userId) {
  let conversation = await this.findOne({ 
    userId, 
    status: 'active',
    lastMessageAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Active within 24h
  }).sort({ lastMessageAt: -1 });
  
  if (!conversation) {
    conversation = await this.create({ userId, messages: [] });
  }
  
  return conversation;
};

// Method to add a message and prune old ones (keep last 20)
ConversationSchema.methods.addMessage = async function(role, content, metadata = {}) {
  const message = {
    role,
    content,
    intent: metadata.intent,
    contextUsed: metadata.contextUsed,
    actionId: metadata.actionId,
    timestamp: new Date()
  };
  
  this.messages.push(message);
  
  // Keep only last 20 messages to stay within context limits
  if (this.messages.length > 20) {
    // Before pruning, generate summary of removed messages
    const removedMessages = this.messages.slice(0, this.messages.length - 20);
    // Store key entities from removed messages
    this.messages = this.messages.slice(-20);
  }
  
  await this.save();
  return message;
};

// Method to update entity references (for pronoun resolution)
ConversationSchema.methods.updateReferences = async function(type, data) {
  if (type === 'email' && data) {
    this.lastReferences.email = {
      messageId: data.messageId || data.id,
      subject: data.subject,
      from: data.from,
      fromEmail: data.fromEmail
    };
  } else if (type === 'person' && data) {
    this.lastReferences.person = {
      name: data.name,
      email: data.email
    };
  } else if (type === 'meeting' && data) {
    this.lastReferences.meeting = {
      eventId: data.eventId || data.id,
      title: data.title,
      date: data.date || data.start
    };
  }
  
  await this.save();
};

// Get messages formatted for LLM
ConversationSchema.methods.getMessagesForLLM = function(limit = 20) {
  return this.messages.slice(-limit).map(m => ({
    role: m.role,
    content: m.content
  }));
};

module.exports = mongoose.model('Conversation', ConversationSchema);
