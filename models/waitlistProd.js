const mongoose = require('mongoose');

const waitlistConn = mongoose.createConnection(process.env.PROD_MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const WaitlistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  joinedAt: { type: Date, default: Date.now },
});

const Waitlist = waitlistConn.model('Waitlist', WaitlistSchema);

module.exports = { Waitlist, waitlistConn };