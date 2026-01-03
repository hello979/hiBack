const express = require('express');
const router = express.Router();
const Action = require('../models/Action');
const SenderCache = require('../models/SenderCache');
const Integration = require('../models/Integration');
const gmailService = require('../services/gmailService');
const calendarService = require('../services/calendarService');
const mem0Service = require('../services/mem0Service');
const { protect } = require('../middleware/auth');

// 1. Get Pending Actions
router.get('/pending', protect, async (req, res) => {
  try {
    const actions = await Action.find({ 
      userId: req.user.id, 
      status: 'pending' 
    }).sort({ createdAt: -1 });
    
    res.json(actions);
  } catch (error) {
    console.error('Fetch Actions Error:', error);
    res.status(500).json({ error: 'Server error fetching actions' });
  }
});

// 2. Approve Action
router.post('/:id/approve', protect, async (req, res) => {
  try {
    const action = await Action.findOne({ _id: req.params.id, userId: req.user.id });
    if (!action) return res.status(404).json({ error: 'Action not found' });
    
    let result = { success: true };
    
    if (action.type === 'draft_reply') {
      // Send email
      await gmailService.sendEmail(req.user.id, action.payload);
      
      // LEARN: User approved this style
      await mem0Service.learnPreference(
        req.user.id, 
        `Approved reply to ${action.payload.senderEmail}. Tone and style were acceptable.`
      );
      
      result.message = 'Email sent successfully';
    } 
    else if (action.type === 'schedule_meeting') {
      // Validate time before creating event
      if (!action.payload.startTime) {
        return res.status(400).json({ 
          error: 'Meeting time was not set properly. Please try scheduling again with a specific time.' 
        });
      }
      
      const startDate = new Date(action.payload.startTime);
      if (isNaN(startDate.getTime())) {
        return res.status(400).json({ 
          error: `Invalid meeting time: ${action.payload.startTime}. Please try scheduling again.` 
        });
      }
      
      // Create calendar event
      const eventResult = await calendarService.createEvent(req.user.id, {
        title: action.payload.title || action.payload.subject,
        description: action.payload.description || action.payload.body,
        startTime: action.payload.startTime,
        endTime: action.payload.endTime,
        attendees: action.payload.attendees || [],
        location: action.payload.location,
        sendNotifications: true
      });
      
      // Check if event creation was successful
      if (!eventResult.success && eventResult.error) {
        return res.status(400).json({ error: eventResult.error });
      }
      
      // LEARN: User approved this meeting type
      await mem0Service.learnPreference(
        req.user.id, 
        `Approved creating meeting: "${action.payload.title}". This type of scheduling is acceptable.`
      );
      
      result.message = 'Event created successfully';
      result.eventLink = eventResult.htmlLink;
    }
    
    action.status = 'approved';
    action.resolvedAt = new Date();
    await action.save();
    
    res.json(result);
  } catch (error) {
    console.error('Approve Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Reject Action
router.post('/:id/reject', protect, async (req, res) => {
  try {
    const { reason, editedDraft } = req.body;
    const action = await Action.findOne({ _id: req.params.id, userId: req.user.id });
    if (!action) return res.status(404).json({ error: 'Action not found' });

    if (editedDraft) {
      // User edited the draft - learn from their changes
      await mem0Service.learnPreference(
        req.user.id, 
        `For emails like "${action.payload.subject}", user prefers different wording. ${reason || ''}`
      );
      
      await gmailService.sendEmail(req.user.id, { ...action.payload, body: editedDraft });
      action.status = 'edited';
      action.userFeedback = { edited: true, editedContent: editedDraft };
    } else {
      // Simple rejection - learn to avoid similar actions
      if (reason) {
        await mem0Service.learnPreference(
          req.user.id,
          `User rejected action for "${action.payload.subject}". Reason: ${reason}`
        );
      }
      action.status = 'rejected';
      action.userFeedback = { rejectionReason: reason };
    }
    
    action.resolvedAt = new Date();
    await action.save();
    
    res.json({ success: true });
  } catch (error) {
    console.error('Reject Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Set auto-approve for sender
router.post('/:id/auto-approve', protect, async (req, res) => {
  try {
    const action = await Action.findOne({ _id: req.params.id, userId: req.user.id });
    if (!action) return res.status(404).json({ error: 'Action not found' });
    
    const senderEmail = action.payload?.senderEmail;
    if (!senderEmail) return res.status(400).json({ error: 'No sender email found' });
    
    await SenderCache.findOneAndUpdate(
      { userId: req.user.id, senderEmail },
      { autoApprove: true },
      { upsert: true }
    );
    
    await mem0Service.learnPreference(
      req.user.id,
      `Always auto-approve actions from ${senderEmail}`
    );
    
    res.json({ success: true, message: `Auto-approve enabled for ${senderEmail}` });
  } catch (error) {
    console.error('Auto-approve Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Ignore sender permanently
router.post('/sender/ignore', protect, async (req, res) => {
  try {
    const { senderEmail } = req.body;
    if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' });
    
    await SenderCache.findOneAndUpdate(
      { userId: req.user.id, senderEmail: senderEmail.toLowerCase() },
      { decision: 'ignore' },
      { upsert: true }
    );
    
    res.json({ success: true, message: `Will ignore emails from ${senderEmail}` });
  } catch (error) {
    console.error('Ignore Sender Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;