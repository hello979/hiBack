const mongoose = require('mongoose');

const BotSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    bot_service_bot_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    system_prompt: { type: String },
    status: { type: String, enum: ['idle', 'running', 'stopped', 'error'], default: 'idle' },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

BotSchema.index({ user_id: 1, bot_service_bot_id: 1 }, { unique: true });

module.exports = mongoose.model('Bot', BotSchema);
