const express = require('express');
const router = express.Router();
const schedulingController = require('../controllers/schedulingController');
const { protect } = require('../middleware/auth');

router.get('/:username', schedulingController.getPublicSchedule);
router.post('/:username/book', protect, schedulingController.bookSlot);

module.exports = router;
