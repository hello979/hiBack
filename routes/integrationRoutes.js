const express = require('express');
const router = express.Router();
const integrationController = require('../controllers/integrationController');
const { protect } = require('../middleware/auth');

router.get('/notion/auth-url', protect, integrationController.getNotionAuthUrl);
router.get('/notion/callback', integrationController.handleNotionCallback);
router.post('/notion/export', protect, integrationController.exportToNotion);

router.get('/slack/auth-url', protect, integrationController.getSlackAuthUrl);
router.get('/slack/callback', integrationController.handleSlackCallback);
router.post('/slack/export', protect, integrationController.exportToSlack);

router.get('/status', protect, integrationController.getIntegrationStatus);

// New management endpoints
router.get('/notion/pages', protect, integrationController.getNotionPages);
router.get('/slack/channels', protect, integrationController.getSlackChannels);
router.post('/:provider/disconnect', protect, integrationController.disconnectIntegration);
// Google Integration (The "Assistant" Brain)
router.get('/google/auth-url', protect, integrationController.getGoogleAuthUrl);
router.get('/google/callback', integrationController.handleGoogleCallback);
module.exports = router;
