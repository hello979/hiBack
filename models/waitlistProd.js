const mongoose = require('mongoose');

if (!process.env.PROD_MONGO_URL) {
  console.error('[Waitlist] PROD_MONGO_URL not set in environment');
}

const waitlistConn = mongoose.createConnection(process.env.PROD_MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

waitlistConn.on('connected', () => {
  console.log('[Waitlist] Connected to PROD MongoDB cluster');
});

waitlistConn.on('error', (err) => {
  console.error('[Waitlist] Connection error:', err);
});

waitlistConn.on('disconnected', () => {
  console.log('[Waitlist] Disconnected from PROD MongoDB cluster');
});

const WaitlistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  joinedAt: { type: Date, default: Date.now },
});

const Waitlist = waitlistConn.model('Waitlist', WaitlistSchema);

module.exports = { Waitlist, waitlistConn };