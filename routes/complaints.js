const express = require('express');
const router = express.Router();
const Complaint = require('../models/Complaint');

router.post('/report', async (req, res) => {
  try {
    const { email, message } = req.body;

    if (!email || !message) {
      return res.status(400).json({ error: 'Email and message are required' });
    }

    const newComplaint = new Complaint({
      email,
      message,
    });

    await newComplaint.save();

    res.status(201).json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('Error saving complaint:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;