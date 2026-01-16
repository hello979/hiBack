const { Waitlist } = require('../models/waitlistProd');

// POST /auth/waitlist - Join waitlist
exports.joinWaitlistProd = async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !email || !phone) {
      return res.status(400).json({ success: false, message: 'Name, email, and phone are required.' });
    }
    // Check if already exists
    const exists = await Waitlist.findOne({ email });
    if (exists) {
      return res.status(409).json({ success: false, message: 'Email already on waitlist.' });
    }
    await Waitlist.create({ name, email, phone });
    return res.json({ success: true });
  } catch (err) {
    console.error('Waitlist join error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /auth/waitlist/status - Get total count + user's position
exports.getWaitlistStatusProd = async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
    const all = await Waitlist.find().sort({ joinedAt: 1 }).select('email');
    const total = all.length;
    const position = all.findIndex(w => w.email === email);
    return res.json({ success: true, total, position: position === -1 ? null : position + 1 });
  } catch (err) {
    console.error('Waitlist status error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /auth/waitlist/check/:email - Check if email exists
exports.checkWaitlistEmailProd = async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
    const exists = await Waitlist.findOne({ email });
    return res.json({ exists: !!exists });
  } catch (err) {
    console.error('Waitlist check error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};
