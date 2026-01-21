const { v4: uuidv4 } = require('uuid');
const { ulid } = require('ulid');
const Meeting = require('../models/Meeting');
const Bot = require('../models/Bot');
const User = require('../models/users');
const hicapy = require('../services/hicapyClient');
const knowledgeGraphService = require('../services/knowledgeGraphService');
const { decrypt } = require('../utils/crypto');
// const logger = require('../utils/logger'); 

const sanitizeMeeting = (meeting) => ({
  meeting_id: meeting.meeting_id,
  meetlink: meeting.meetlink,
  meeting_title: meeting.meeting_title,
  start_time: meeting.start_time,
  end_time: meeting.end_time,
  assigned_bot_id: meeting.assigned_bot_id,
  assigned_bot_service_id: meeting.assigned_bot_service_id,
  engaged: meeting.engaged,
  engaged_at: meeting.engaged_at,
  bot_config: meeting.bot_config,
  auto_join: meeting.auto_join,
  status: meeting.status,
  schedule_id: meeting.schedule_id,
  last_started_at: meeting.last_started_at,
  last_stopped_at: meeting.last_stopped_at,
  created_at: meeting.createdAt,
  updated_at: meeting.updatedAt
});

const getUserApiKey = (user) => {
  const encryptedKey = user?.bot_service?.api_key;
  if (!encryptedKey) return null;
  return decrypt(encryptedKey);
};

const disableBotService = async (user) => {
  user.bot_service = user.bot_service || {};
  user.bot_service.enabled = false;
  user.bot_service.api_key = undefined;
  user.bot_service.last_disabled_at = new Date();
  await user.save();
};

const requireAssignedBot = (meeting) => {
  if (!meeting.assigned_bot_id || !meeting.assigned_bot_service_id) {
    const err = new Error('No bot assigned to this meeting');
    err.status = 400;
    throw err;
  }
};

// --- ENDPOINT: BULK CHECK ---
exports.bulkCheck = async (req, res) => {
  try {
    const { event_ids } = req.body;
    if (!Array.isArray(event_ids)) {
      return res.status(400).json({ success: false, message: 'event_ids array is required' });
    }

    const meetings = await Meeting.find({ 
      user_id: req.user._id,
      calendar_event_id: { $in: event_ids }
    });

    const map = {};
    meetings.forEach(m => {
        if (m.calendar_event_id) {
            map[m.calendar_event_id] = {
                engaged: m.engaged,
                status: m.status,
                meeting_id: m.meeting_id,
                bot_id: m.assigned_bot_id,
                schedule_id: m.schedule_id
            };
        }
    });

    res.json({ success: true, data: map });
  } catch (error) {
    console.error(`[meetings.bulkCheck] ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to check bulk status' });
  }
};

exports.assignBot = async (req, res) => {
  try {
    const { id } = req.params;
    let { 
        bot_id, 
        meetlink, 
        meeting_title, 
        start_time, 
        end_time, 
        auto_join, 
        bot_config = {}, 
        min_record_time_seconds, // Received from frontend calculation
        calendar_event_id 
    } = req.body;

    if (!bot_id || !meetlink) {
      return res.status(400).json({ success: false, message: 'bot_id and meetlink are required' });
    }

    // 1. Force Integer Parsing for Duration (Critical Fix)
    const durationSeconds = parseInt(min_record_time_seconds, 10) || 60;

    const now = new Date();
    const start = start_time ? new Date(start_time) : null;
    const end = end_time ? new Date(end_time) : null;

    // --- SMART AUTO-JOIN DEFAULTS ---
    if (auto_join === undefined && bot_config.auto_join !== undefined) {
        auto_join = bot_config.auto_join;
    }
    if (auto_join === undefined || auto_join === null) {
        auto_join = start && start > now;
    }
    if (end && end < now) {
        auto_join = false;
    }

    if (meetlink && meetlink.includes('google.com/calendar/event')) {
      console.warn(`[assignBot] Warning: Received Calendar Event link (${meetlink}) instead of Meet link.`);
    }

    const existingActive = await Meeting.findOne({
      meetlink,
      engaged: true,
      status: { $in: ['running', 'scheduled'] },
      assigned_bot_id: { $ne: null }
    });
    
    if (existingActive && (!id || existingActive.meeting_id !== id)) {
      return res.status(409).json({ success: false, message: 'A bot is already active/scheduled for this link.' });
    }

    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    const apiKey = getUserApiKey(user);

    const bot = await Bot.findOne({ _id: bot_id, user_id: req.user._id });
    if (!bot) {
      return res.status(404).json({ success: false, message: 'Bot not found' });
    }

    let meeting = await Meeting.findOne({ meeting_id: id, user_id: req.user._id });
    
    let oldScheduleDeleted = false;
    if (meeting && meeting.schedule_id && apiKey) {
        try {
            await hicapy.deleteSchedule({ apiKey, scheduleId: meeting.schedule_id });
            oldScheduleDeleted = true;
        } catch (e) { /* Ignore delete errors */ }
    }

    let newScheduleId = null;
    
    if (auto_join) {
        if (!apiKey) {
            return res.status(403).json({ success: false, message: 'Bot service must be enabled to use Auto-Join.' });
        }

        if (start && end) {
            let joinTime = new Date(start.getTime() - 60000); 
            if (joinTime <= now) joinTime = new Date(now.getTime() + 15000); 

            if (end > now && end > joinTime) {
                try {
                    // Determine enable_speak from bot_config
                    const enableSpeak = bot_config.enable_speak === true;
                    // Force enable_transcript when enable_speak is true
                    const enableTranscript = enableSpeak ? true : (bot_config.enable_transcript !== false);
                    
                    const schedulePayload = {
                        bot_id: bot.bot_service_bot_id,
                        meetlink: meetlink,
                        start_time: joinTime.toISOString(),
                        end_time: end.toISOString(),
                        // Pass forced integer duration
                        min_record_time_seconds: durationSeconds,
                        config: {
                            enable_recording: bot_config.enable_recording !== false,
                            enable_transcript: enableTranscript,
                            enable_speak: enableSpeak
                        }
                    };

                    const scheduleResp = await hicapy.createSchedule({ apiKey, payload: schedulePayload });
                    const respData = scheduleResp.data || scheduleResp;
                    newScheduleId = respData.schedule_id || respData.id || respData._id;
                    
                } catch (schedErr) {
                    const errorData = schedErr.data || schedErr.response?.data;
                    const detail = errorData?.detail || errorData?.message || schedErr.message;
                    console.error(`[assignBot] Schedule creation failed: ${JSON.stringify(detail)}`);
                    return res.status(500).json({ 
                        success: false, 
                        message: `Failed to schedule bot: ${typeof detail === 'object' ? JSON.stringify(detail) : detail || 'Unknown error'}` 
                    });
                }
            } else {
                auto_join = false; 
            }
        }
    }

    let finalScheduleId = newScheduleId;
    if (!newScheduleId && !oldScheduleDeleted && meeting) {
        finalScheduleId = meeting.schedule_id;
    } else if (oldScheduleDeleted && !newScheduleId) {
        finalScheduleId = null;
    }

    let nextStatus = meeting?.status || 'idle';
    if (finalScheduleId) {
        nextStatus = 'scheduled';
    } else if (meeting?.status === 'running') {
        nextStatus = 'running'; 
    } else {
        nextStatus = 'idle';
    }

    const update = {
      meetlink,
      meeting_title,
      start_time: start,
      end_time: end,
      auto_join: !!auto_join,
      assigned_bot_id: bot._id,
      assigned_bot_service_id: bot.bot_service_bot_id,
      schedule_id: finalScheduleId,
      status: nextStatus,
      bot_config: {
        enable_recording: bot_config.enable_recording !== false,
        enable_transcript: bot_config.enable_transcript !== false,
        enable_speak: bot_config.enable_speak === true,
        auto_join: !!auto_join,
        // SAVE duration to DB so 'start' (manual trigger) can use it later
        min_record_time_seconds: durationSeconds 
      }
    };

    if (calendar_event_id) update.calendar_event_id = calendar_event_id;

    const updatedMeeting = await Meeting.findOneAndUpdate(
      { meeting_id: id, user_id: req.user._id },
      { $set: update, $setOnInsert: { engaged: false, meeting_id: id } },
      { new: true, upsert: true }
    );

    // Index meeting in knowledge graph for topic-based queries
    try {
      await knowledgeGraphService.indexMeeting(req.user._id, {
        meeting_id: updatedMeeting.meeting_id,
        id: updatedMeeting.meeting_id,
        title: updatedMeeting.meeting_title,
        start_time: updatedMeeting.start_time,
        attendees: []
      });
    } catch (kgErr) {
      console.log(`[meetings.assign] Knowledge graph index skipped: ${kgErr.message}`);
    }

    res.json({ success: true, data: sanitizeMeeting(updatedMeeting) });
  } catch (error) {
    console.error(`[meetings.assign] ${error.message}`);
    res.status(500).json({ success: false, message: error.message || 'Failed to assign bot' });
  }
};

exports.listAll = async (req, res) => {
  try {
    const meetings = await Meeting.find({ user_id: req.user._id }).sort({ start_time: -1 });
    res.json({ success: true, data: meetings.map(sanitizeMeeting) });
  } catch (error) {
    console.error(`[meetings.listAll] ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch meetings' });
  }
};

exports.listActive = async (req, res) => {
  try {
    const meetings = await Meeting.find({ 
      user_id: req.user._id, 
      status: { $in: ['running', 'scheduled'] },
      engaged: true
    }).sort({ last_started_at: -1 });
    res.json({ success: true, data: meetings.map(sanitizeMeeting) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch active meetings' });
  }
};

exports.engage = async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ meeting_id: req.params.id, user_id: req.user._id });
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });

    requireAssignedBot(meeting);

    const now = new Date();
    if (meeting.end_time && new Date(meeting.end_time) < now) {
        return res.status(400).json({ success: false, message: 'Cannot engage: Meeting has already ended.' });
    }

    const start = meeting.start_time ? new Date(meeting.start_time) : null;
    const end = meeting.end_time ? new Date(meeting.end_time) : null;
    
    if (start && end && end > now && !meeting.schedule_id) {
         const user = await User.findById(req.user._id).select('+bot_service.api_key');
         const apiKey = getUserApiKey(user);

         if (apiKey) {
             const bot = await Bot.findById(meeting.assigned_bot_id);
             if (bot) {
                 let joinTime = new Date(start.getTime() - 60000);
                 if (joinTime <= now) joinTime = new Date(now.getTime() + 15000);

                 if (end > joinTime) {
                     try {
                         // Determine enable_speak from bot_config
                         const enableSpeak = meeting.bot_config?.enable_speak === true;
                         // Force enable_transcript when enable_speak is true
                         const configToUse = meeting.bot_config || { enable_recording: true, enable_transcript: true };
                         const enableTranscript = enableSpeak ? true : (configToUse.enable_transcript !== false);
                         
                         const schedulePayload = {
                             bot_id: bot.bot_service_bot_id,
                             meetlink: meeting.meetlink,
                             start_time: joinTime.toISOString(),
                             end_time: end.toISOString(),
                             // Retrieve saved duration from DB
                             min_record_time_seconds: meeting.bot_config?.min_record_time_seconds || 60,
                             config: {
                                 enable_recording: configToUse.enable_recording !== false,
                                 enable_transcript: enableTranscript,
                                 enable_speak: enableSpeak
                             }
                         };
                         
                         const scheduleResp = await hicapy.createSchedule({ apiKey, payload: schedulePayload });
                         const respData = scheduleResp.data || scheduleResp;
                         
                         meeting.schedule_id = respData.schedule_id || respData.id || respData._id;
                         meeting.auto_join = true;
                         if (meeting.bot_config) meeting.bot_config.auto_join = true;
                     } catch (e) {
                         console.error(`[engage] Failed to auto-schedule:`, e.response?.data?.detail || e.message);
                     }
                 }
             }
         }
    }

    meeting.engaged = true;
    meeting.engaged_at = now;
    
    if (meeting.schedule_id) {
        meeting.status = 'scheduled';
    } else if (meeting.status !== 'running') {
        meeting.status = 'idle';
    }
    
    await meeting.save();
    res.json({ success: true, data: sanitizeMeeting(meeting) });
  } catch (error) {
    console.error(`[meetings.engage] ${error.message}`);
    res.status(500).json({ success: false, message: error.message || 'Failed to engage' });
  }
};

exports.disengage = async (req, res) => {
  const correlationId = uuidv4();
  try {
    const meeting = await Meeting.findOne({ meeting_id: req.params.id, user_id: req.user._id });
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });

    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    const apiKey = getUserApiKey(user);

    if (meeting.schedule_id && apiKey) {
        try { await hicapy.deleteSchedule({ apiKey, scheduleId: meeting.schedule_id }); } catch (e) {}
        meeting.schedule_id = null;
    }

    const now = new Date();
    
    if (meeting.status === 'running' && meeting.assigned_bot_service_id && apiKey) {
        try {
          await hicapy.stopBot({ apiKey, botId: meeting.assigned_bot_service_id, correlationId });
        } catch (e) {}
        meeting.last_stopped_at = now;
    }

    // Detect early termination - check if stopped before scheduled end time
    if (meeting.end_time && now < new Date(meeting.end_time)) {
      meeting.stopped_early = true;
      meeting.termination_reason = 'user_stopped';
      console.log(`[meetings.disengage] Bot stopped early - end_time: ${meeting.end_time}, stopped_at: ${now}`);
    } else {
      meeting.stopped_early = false;
      meeting.termination_reason = 'completed';
    }

    meeting.engaged = false;
    meeting.status = 'stopped';
    await meeting.save();

    res.json({ success: true, data: sanitizeMeeting(meeting), correlation_id: correlationId });
  } catch (error) {
    console.error(`[meetings.disengage] ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.start = async (req, res) => {
  const correlationId = uuidv4();
  try {
    const { trigger = 'manual' } = req.body || {};
    const meeting = await Meeting.findOne({ meeting_id: req.params.id, user_id: req.user._id });
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });

    requireAssignedBot(meeting);

    if (!meeting.engaged) return res.status(409).json({ success: false, message: 'Meeting not engaged.' });

    const isScheduled = !!(meeting.start_time || meeting.end_time);
    if (trigger !== 'scheduler' && isScheduled) return res.status(400).json({ success: false, message: 'Manual start blocked for scheduled meetings' });
    if (trigger === 'scheduler' && isScheduled && !meeting.auto_join) return res.status(403).json({ success: false, message: 'Auto-join disabled' });

    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    const apiKey = getUserApiKey(user);
    if (!user?.bot_service?.enabled || !apiKey) return res.status(403).json({ success: false, message: 'Bot service disabled' });

    // Retrieve saved duration from DB (saved during assignBot)
    const duration = meeting.bot_config?.min_record_time_seconds || 60;
    
    // Determine enable_speak from bot_config
    const enableSpeak = meeting.bot_config?.enable_speak === true;
    // Force enable_transcript when enable_speak is true
    const enableTranscript = enableSpeak ? true : (meeting.bot_config?.enable_transcript !== false);

    const payload = {
      meetlink: meeting.meetlink,
      user_id: user._id.toString(),
      meeting_id: meeting.meeting_id,
      min_record_time: duration, // Map to Start API parameter
      enable_recording: meeting.bot_config?.enable_recording !== false,
      enable_transcript: enableTranscript,
      enable_speak: enableSpeak
    };

    console.log(`[Manual Start] Starting bot with duration: ${duration}s`);

    const startResp = await hicapy.startBot({ apiKey, botId: meeting.assigned_bot_service_id, payload, correlationId });

    meeting.status = 'running';
    meeting.last_started_at = new Date();
    await meeting.save();

    res.json({ success: true, data: sanitizeMeeting(meeting), correlation_id: startResp.correlationId });
  } catch (error) {
    const status = error.status || 500;
    if (status === 401 || status === 403) await disableBotService(req.user);
    console.error(`[meetings.start] ${error.message}`);
    res.status(status).json({ success: false, message: error.message });
  }
};

exports.stop = async (req, res) => {
  const correlationId = uuidv4();
  try {
    const meeting = await Meeting.findOne({ meeting_id: req.params.id, user_id: req.user._id });
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found' });

    requireAssignedBot(meeting);

    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    const apiKey = getUserApiKey(user);
    if (!user?.bot_service?.enabled || !apiKey) return res.status(403).json({ success: false, message: 'Bot service disabled' });

    const stopResp = await hicapy.stopBot({ apiKey, botId: meeting.assigned_bot_service_id, correlationId });

    const now = new Date();
    meeting.status = 'stopped';
    meeting.last_stopped_at = now;

    // Detect early termination - check if stopped before scheduled end time
    if (meeting.end_time && now < new Date(meeting.end_time)) {
      meeting.stopped_early = true;
      meeting.termination_reason = 'user_stopped';
      console.log(`[meetings.stop] Bot stopped early - end_time: ${meeting.end_time}, stopped_at: ${now}`);
    } else {
      meeting.stopped_early = false;
      meeting.termination_reason = 'completed';
    }

    await meeting.save();

    res.json({ success: true, data: sanitizeMeeting(meeting), correlation_id: stopResp.correlationId });
  } catch (error) {
    const status = error.status || 500;
    console.error(`[meetings.stop] ${error.message}`);
    res.status(status).json({ success: false, message: error.message });
  }
};

exports.instant = async (req, res) => {
  const correlationId = uuidv4();
  try {
    const { 
        meetlink, 
        bot_id, 
        bot_config = {}, 
        meeting_title, 
        min_record_time_seconds 
    } = req.body;

    // 1. Force Integer Conversion & Default to 600s (10 min) if missing to avoid 60s issues
    const calculatedDuration = parseInt(min_record_time_seconds, 10) || 600; 
    
    // 2. Determine enable_speak from bot_config (CRITICAL: was hardcoded to false before)
    const enableSpeak = bot_config.enable_speak === true;
    // Force enable_transcript when enable_speak is true (voice bot needs transcript)
    const enableTranscript = enableSpeak ? true : (bot_config.enable_transcript !== false);
    
    console.log(`[Instant Start] Request received for: ${meetlink} duration: ${calculatedDuration}s, enable_speak: ${enableSpeak}`);

    if (!meetlink || !bot_id) return res.status(400).json({ success: false, message: 'meetlink and bot_id required' });

    if (meetlink && meetlink.includes('google.com/calendar/event')) {
      console.warn(`[instant] Warning: Received Calendar Event link (${meetlink}). Bot may fail to join.`);
    }

    await Meeting.updateMany({ meetlink, engaged: true, status: { $nin: ['running', 'scheduled'] } }, { $set: { engaged: false, status: 'stopped' } });

    const existingActive = await Meeting.findOne({ meetlink, engaged: true, status: { $in: ['running', 'scheduled'] }, assigned_bot_id: { $ne: null } });
    if (existingActive) return res.status(409).json({ success: false, message: 'Bot already active in this meeting' });

    const bot = await Bot.findOne({ _id: bot_id, user_id: req.user._id });
    if (!bot) return res.status(404).json({ success: false, message: 'Bot not found' });

    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    const apiKey = getUserApiKey(user);
    if (!user?.bot_service?.enabled || !apiKey) return res.status(403).json({ success: false, message: 'Bot service disabled' });

    const meetingId = ulid();
    const meeting = await Meeting.create({
      meeting_id: meetingId,
      user_id: req.user._id,
      meetlink,
      meeting_title,
      calendar_event_id:`instant_${meetingId}`,
      assigned_bot_id: bot._id,
      assigned_bot_service_id: bot.bot_service_bot_id,
      engaged: true,
      engaged_at: new Date(),
      bot_config: {
        enable_recording: bot_config.enable_recording !== false,
        enable_transcript: enableTranscript,
        enable_speak: enableSpeak,
        // Save duration to DB
        min_record_time_seconds: calculatedDuration
      },
      auto_join: false,
      status: 'idle'
    });

    const payload = {
      meetlink,
      user_id: user._id.toString(),
      meeting_id: meeting.meeting_id,
      // Map correctly to Bot Service API
      min_record_time: calculatedDuration, 
      enable_recording: meeting.bot_config.enable_recording,
      enable_transcript: meeting.bot_config.enable_transcript,
      enable_speak: meeting.bot_config.enable_speak
    };

    const startResp = await hicapy.startBot({ apiKey, botId: bot.bot_service_bot_id, payload, correlationId });

    meeting.status = 'running';
    meeting.last_started_at = new Date();
    await meeting.save();

    // Index meeting in knowledge graph for topic-based queries
    try {
      await knowledgeGraphService.indexMeeting(req.user._id, {
        meeting_id: meeting.meeting_id,
        title: meeting.meeting_title,
        start_time: meeting.engaged_at,
        attendees: []
      });
    } catch (kgErr) {
      console.log(`[meetings.instant] Knowledge graph index skipped: ${kgErr.message}`);
    }

    res.status(201).json({ success: true, data: sanitizeMeeting(meeting), correlation_id: startResp.correlationId });
  } catch (error) {
    const status = error.status || 500;
    if (status === 401 || status === 403) await disableBotService(req.user);
    console.error(`[meetings.instant] Error: ${error.message}`);
    res.status(status).json({ success: false, message: error.message });
  }
};