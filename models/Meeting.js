const mongoose = require('mongoose');
const { ulid } = require('ulid');

const MeetingSchema = new mongoose.Schema(
  {
    meeting_id: {
      type: String,
      required: true,
      unique: true,
      default: () => ulid()
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    meetlink: {
      type: String,
      required: true
    },
    meeting_title: {
      type: String
    },
    start_time: {
      type: Date
    },
    end_time: {
      type: Date
    },
    // --- NEW FIELD FOR SCHEDULING ---
    schedule_id: {
      type: String, // ID returned from Hicapy Bot Service
      default: null
    },
    // --------------------------------
    assigned_bot_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bot'
    },
    assigned_bot_service_id: {
      type: String
    },
    engaged: {
      type: Boolean,
      default: false
    },
    engaged_at: {
      type: Date
    },
    bot_config: {
      enable_recording: { type: Boolean, default: true },
      enable_transcript: { type: Boolean, default: true },
      enable_speak: { type: Boolean, default: false },
      auto_join: { type: Boolean, default: false }
    },
    status: {
      type: String,
      enum: ['idle', 'scheduled', 'running', 'stopped', 'error'],
      default: 'idle'
    },
    calendar_event_id: {
      type: String
    },
    // S3 asset flags and keys
    has_transcript: { type: Boolean, default: false },
    has_summary: { type: Boolean, default: false },
    has_video: { type: Boolean, default: false },
    transcript_s3_key: { type: String },
    summary_s3_key: { type: String },
    video_s3_key: { type: String },
    last_started_at: Date,
    last_stopped_at: Date,
    // Early termination tracking
    stopped_early: { type: Boolean, default: false },
    termination_reason: { 
      type: String, 
      enum: ['completed', 'user_stopped', 'kicked', 'error', 'timeout', null],
      default: null 
    }
  },
  {
    timestamps: true
  }
);

MeetingSchema.index({ user_id: 1, meeting_id: 1 }, { unique: true });

module.exports = mongoose.model('Meeting', MeetingSchema);