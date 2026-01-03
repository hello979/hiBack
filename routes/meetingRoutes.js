const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const meetingController = require('../controllers/meetingController');
const Meeting = require('../models/Meeting'); 
// List all meetings
router.get('/', protect, meetingController.listAll);

// List active meetings
router.get('/active', protect, meetingController.listActive);

// --- ADD THIS LINE TO FIX THE 404 ERROR ---
router.post('/bulk-check', protect, meetingController.bulkCheck);
// ------------------------------------------

// Instant join flow (no pre-existing meeting)
router.post('/instant', protect, meetingController.instant);

// Meeting lifecycle
router.post('/:id/assign-bot', protect, meetingController.assignBot);
router.post('/:id/engage', protect, meetingController.engage);
router.post('/:id/disengage', protect, meetingController.disengage);
router.post('/:id/start', protect, meetingController.start);
router.post('/:id/stop', protect, meetingController.stop);
router.patch('/:meeting_id', async (req, res) => {
  try {
    const { meeting_id } = req.params;
    const { meeting_title } = req.body;

    if (!meeting_title) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }

    // Find the meeting by its custom meeting_id (from your schema)
    // NOT the default MongoDB _id
    const updatedMeeting = await Meeting.findOneAndUpdate(
      { meeting_id: meeting_id }, 
      { $set: { meeting_title: meeting_title } },
      { new: true } // Return the updated document so we can see the change
    );

    if (!updatedMeeting) {
      return res.status(404).json({ success: false, message: "Meeting not found" });
    }

    res.json({ success: true, data: updatedMeeting });
  } catch (error) {
    console.error("Error updating meeting title:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
module.exports = router;