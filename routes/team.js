const express = require('express');
const router = express.Router();
const passport = require('passport');
const User = require('../models/users');
const Invitation = require('../models/Invitation');
const crypto = require('crypto');

// --- 1. AWS S3 IMPORTS (Required for the delete function) ---
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

// --- 2. AUTH MIDDLEWARE DEFINITION ---
// We define 'protect' to point to your passport JWT strategy
const protect = passport.authenticate('jwt', { session: false });

// --- 3. S3 CONFIGURATION ---
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET = process.env.AWS_BUCKET_NAME;
const ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY; 
const IV_LENGTH = 16;

// Helper for encryption (used in delete message)
const encrypt = (text) => {
  if (!text || !ENCRYPTION_KEY) return text;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

// --- ROUTES ---

// GET DATA (Team & Pending Invites)
router.get('/', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('team', 'username email _id');
    const pendingInvites = await Invitation.find({ 
        receiverEmail: req.user.email, 
        status: 'pending' 
    }).populate('sender', 'username email');

    res.json({ success: true, team: user.team, invites: pendingInvites });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// SEND INVITATION
router.post('/invite', protect, async (req, res) => {
  try {
    const { email } = req.body;
    const sender = await User.findById(req.user.id);
    const targetEmail = email.trim().toLowerCase();

    if (targetEmail === sender.email) return res.status(400).json({ error: "You cannot invite yourself." });

    const alreadyTeammate = await User.findOne({ _id: { $in: sender.team }, email: targetEmail });
    if (alreadyTeammate) return res.status(400).json({ error: "User is already in your team." });

    const existingInvite = await Invitation.findOne({ sender: sender._id, receiverEmail: targetEmail, status: 'pending' });
    if (existingInvite) return res.status(400).json({ error: "Invitation already sent." });

    const newInvite = new Invitation({ sender: sender._id, receiverEmail: targetEmail });
    await newInvite.save();
    res.json({ success: true, message: "Invitation sent successfully!" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// RESPOND TO INVITATION
router.post('/respond', protect, async (req, res) => {
    try {
        const { inviteId, action } = req.body;
        const invite = await Invitation.findById(inviteId);
        const currentUser = await User.findById(req.user.id);

        if (!invite) return res.status(404).json({ error: "Invitation not found." });
        if (invite.receiverEmail !== currentUser.email) return res.status(403).json({ error: "Not authorized." });

        if (action === 'accept') {
            const sender = await User.findById(invite.sender);
            if (sender) {
                if (!sender.team.includes(currentUser._id)) {
                    sender.team.push(currentUser._id);
                    await sender.save();
                }
                if (!currentUser.team.includes(sender._id)) {
                    currentUser.team.push(sender._id);
                    await currentUser.save();
                }
            }
            invite.status = 'accepted';
        } else {
            invite.status = 'rejected';
        }

        await invite.save();
        const updatedUser = await User.findById(req.user.id).populate('team', 'username email _id');
        res.json({ success: true, team: updatedUser.team });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

// DELETE MESSAGE (Soft Delete in S3)
router.post('/:taskId/delete', protect, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { meetingId, messageId } = req.body;
    
    const key = `meetings/meet_${meetingId}/tasks/${taskId}/chat/${messageId}.json`;

    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await s3.send(getCmd);
    const json = JSON.parse(await response.Body.transformToString());

    json.is_deleted = true;
    json.content = encrypt("🚫 Message deleted"); 

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(json),
      ContentType: "application/json"
    }));

    res.json({ success: true });
  } catch (err) {
    console.error("Delete failed:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

module.exports = router;