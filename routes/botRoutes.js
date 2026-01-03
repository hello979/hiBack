const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const botController = require('../controllers/botController');

router.post('/enable', protect, botController.enableBots);
router.post('/create', protect, botController.createBot);
router.get('/', protect, botController.listBots);

module.exports = router;
