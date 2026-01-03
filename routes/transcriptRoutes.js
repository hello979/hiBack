const express = require('express');
const router = express.Router();
const transcriptController = require('../controllers/transcriptController');
const { protect } = require('../middleware/auth');

// 1. Fetch Page Data (Video, Text, Summary)
router.get('/:meeting_id/assets', protect, transcriptController.getMeetingAssets);

// 2. Repair/Sync Data (Fixes "False" flags)
router.get('/:meeting_id/sync', protect, transcriptController.syncMeetingAssets);

// 3. Store Data (Used by Bot)
router.post('/store', protect, transcriptController.storeTranscript);

module.exports = router;