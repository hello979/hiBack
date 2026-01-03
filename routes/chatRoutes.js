const express = require('express');
const router = express.Router();
// Use the HiCapy V3 chat controller with full spec implementation
const chatController = require('../controllers/chatControllerV3');
// Keep V2 for backward compatibility
// const chatControllerV2 = require('../controllers/chatControllerV2');
const { protect } = require('../middleware/auth');

// V3 Routes (New HiCapy Spec)
router.post('/', protect, chatController.chat);
router.get('/briefing', protect, chatController.getDailyBriefing);

// Conversation routes - separate routes for with/without ID
router.get('/conversation', protect, chatController.getConversation);
router.get('/conversation/:conversationId', protect, chatController.getConversation);
router.delete('/conversation', protect, chatController.clearConversation);
router.delete('/conversation/:conversationId', protect, chatController.clearConversation);

// Action approval routes
router.post('/action/:actionId/approve', protect, chatController.approveAction);
router.post('/action/:actionId/edit', protect, chatController.editAction);
router.post('/action/:actionId/reject', protect, chatController.rejectAction);

// V2 Routes (Backward compatibility)
// router.post('/v2', protect, chatControllerV2.chat);
// router.post('/feedback', protect, chatControllerV2.saveFeedback);

module.exports = router;
