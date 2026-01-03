const express = require('express');
const router = express.Router();
const Task = require('../models/Task'); 
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require('crypto');
const { protect } = require('../middleware/auth'); 

// --- CONFIGURATION ---
const s3 = new S3Client({ 
  region: process.env.AWS_REGION, 
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const BUCKET = process.env.AWS_BUCKET_NAME || 'hicapy';
const ENCRYPTION_KEY = process.env.CHAT_ENCRYPTION_KEY; 
const IV_LENGTH = 16;

// --- CRYPTO HELPERS ---
const encrypt = (text) => {
  if (!text) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

const decrypt = (text) => {
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) { return "[Encrypted Message]"; }
};

// --- API ENDPOINTS ---

// 1. GET TASKS (Calculates Unseen Counts)
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const { meetingId } = req.query;
    
    let query = {
      $or: [
        { creator_id: userId },
        { "assignees.user_id": userId }
      ]
    };
    if (meetingId) query.meeting_id = meetingId;
    
    // Use .lean() to allow modifying the JSON result
    const tasks = await Task.find(query).sort({ last_message_at: -1 }).lean();
    
    // Calculate Unseen Counts & Sign Video URLs
    const processedTasks = await Promise.all(tasks.map(async (task) => {
      // 1. Video URL Logic
      let videoUrl = null;
      try {
        const videoKey = `meetings/meet_${task.meeting_id}/video/recording.mp4`; // Adjust key pattern as needed
        videoUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: videoKey }), { expiresIn: 3600 });
      } catch (e) { videoUrl = null; }

      // 2. Unseen Count Logic
      // Find read status for this specific user
      const userStatus = task.read_status?.find(s => s.user_id === userId.toString());
      const lastReadCount = userStatus ? userStatus.last_read_count : 0;
      const totalComments = task.comments_count || 0;
      const unseen = totalComments - lastReadCount;

      return {
        ...task,
        video_url: videoUrl,
        unseen_count: unseen > 0 ? unseen : 0
      };
    }));

    res.json({ success: true, data: processedTasks });
  } catch (err) {
    console.error("❌ GET Tasks Failed:", err);
    res.status(500).json({ error: "Could not fetch tasks" });
  }
});

// 2. MARK AS READ (Clears the Notification)
router.post('/:taskId/read', protect, async (req, res) => {
    try {
      const { taskId } = req.params;
      const userId = req.user.id || req.user._id;
  
      const task = await Task.findOne({ task_id: taskId });
      if(!task) return res.status(404).json({error: "Task not found"});
  
      // Update or Add user to read_status array
      const existingIndex = task.read_status.findIndex(s => s.user_id === userId.toString());
      
      if (existingIndex > -1) {
          task.read_status[existingIndex].last_read_count = task.comments_count;
      } else {
          task.read_status.push({ user_id: userId, last_read_count: task.comments_count });
      }
      
      await task.save();
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to mark read" }); }
});

// 3. SEND CHAT (With Reply Context & Increments Count)
router.post('/:taskId/chat', protect, async (req, res) => {
  try {
    const { taskId } = req.params;
    // Receive reply details and sender name
    const { text, meetingId, replyToId, replyToContent, replyToSender, file } = req.body;
    const user = req.user;

    const timestamp = new Date().toISOString();
    const msgId = `${timestamp}_${user.id || user._id}`;
    const key = `meetings/meet_${meetingId}/tasks/${taskId}/chat/${msgId}.json`;

    const messagePayload = {
      id: msgId,
      sender_id: user.id || user._id,
      sender_name: user.username || user.name || "User",
      content: encrypt(text), 
      
      // Store rich reply context
      reply_context: replyToId ? {
          id: replyToId,
          text: replyToContent,
          sender: replyToSender
      } : null,

      timestamp: timestamp,
      is_deleted: false
    };

    if (file) {
      messagePayload.file = {
        name: file.name,
        size: file.size,
        type: file.type,
        url: file.url
      };
    }

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(messagePayload),
      ContentType: "application/json"
    }));

    // Increment global comment count (triggers notification for others)
    await Task.findOneAndUpdate(
      { task_id: taskId },
      { $inc: { comments_count: 1 }, $set: { last_message_at: new Date() } }
    );

    res.json({ success: true, message: { ...messagePayload, content: text } });

  } catch (err) {
    console.error("❌ Send Chat Failed:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// 4. GET CHAT MESSAGES
router.get('/:taskId/chat', protect, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { meetingId } = req.query;
    const prefix = `meetings/meet_${meetingId}/tasks/${taskId}/chat/`;

    const listCommand = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix });
    const s3Files = await s3.send(listCommand);

    if (!s3Files.Contents || s3Files.Contents.length === 0) {
      return res.json({ messages: [] });
    }

    const messages = await Promise.all(s3Files.Contents.map(async (file) => {
      const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: file.Key });
      const response = await s3.send(getCmd);
      const str = await response.Body.transformToString();
      const json = JSON.parse(str);

      if (json.is_deleted) return { ...json, content: "🚫 Message deleted" };
      json.content = decrypt(json.content);
      
      // Fallback for old messages without reply_context
      if (!json.reply_context && json.reply_to) {
          json.reply_context = { text: "Replying to message...", sender: "User" };
      }

      return json;
    }));

    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ messages });

  } catch (err) {
    console.error("❌ Get Chat Failed:", err);
    res.status(500).json({ error: "Failed to load thread" });
  }
});

// 5. DELETE MESSAGE
router.post('/:taskId/delete', protect, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { meetingId, messageId } = req.body;
    const key = `meetings/meet_${meetingId}/tasks/${taskId}/chat/${messageId}.json`;

    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await s3.send(getCmd);
    const json = JSON.parse(await response.Body.transformToString());

    json.is_deleted = true;
    json.content = encrypt("🚫 This message was deleted");

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: JSON.stringify(json), ContentType: "application/json"
    }));

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Delete failed" }); }
});

// 6. UPLOAD FILE (Standard S3 Upload)
router.post('/:taskId/upload', protect, async (req, res) => {
    // ... (Your existing file upload logic stays here) ...
    // Note: Ensure you handle req.files properly
    res.json({ success: true, message: "File logic placeholder" }); 
});

module.exports = router;