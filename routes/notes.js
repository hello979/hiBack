const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const passport = require('passport');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// --- 1. AWS S3 CONFIGURATION ---
const s3Client = new S3Client({
  region: process.env.AWS_REGION, // e.g., 'us-east-1'
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const BUCKET_NAME = "hicapy"; // Hardcoded as per your instruction

// Import Models
const Note = require('../models/Note');
const Meeting = require('../models/Meeting'); 

async function fetchJsonFromS3(key) {
    try {
        const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
        const response = await s3Client.send(command);
        const str = await response.Body.transformToString();
        return JSON.parse(str);
    } catch (e) {
        console.warn(`S3 Fetch Failed for ${key}:`, e.message); // Log but don't crash
        return null;
    }
}

// --- HELPER: Generate Video Link (Presigned URL) ---
async function generateVideoLink(key) {
    try {
        const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
        return await getSignedUrl(s3Client, command, { expiresIn: 7200 }); // Valid for 2 hours
    } catch (e) {
        console.error("Presigned URL Error:", e);
        return null;
    }
}

// --- ENDPOINT A: GENERATE LINK (Snapshot) ---
router.post('/share/:id', passport.authenticate('jwt', { session: false }), async (req, res) => {
  try {
    const idParam = req.params.id;
    const userId = req.user.id;

    // Intelligent Query
    let noteQuery = { userId: userId };
    if (mongoose.Types.ObjectId.isValid(idParam)) {
        noteQuery.$or = [{ _id: idParam }, { meetingId: idParam }];
    } else {
        noteQuery.meetingId = idParam;
    }

    let note = await Note.findOne(noteQuery);
    const { content, title, todos } = req.body;

    // Create or Update Note
    if (note) {
        if (content) note.content = content;
        if (title) note.title = title;
        if (!note.shareId) note.shareId = uuidv4();
        await note.save();
    } else {
        // Fallback: Find Meeting to create fresh note
        let meetingQuery = { user_id: userId }; 
        if (mongoose.Types.ObjectId.isValid(idParam)) {
             meetingQuery.$or = [{ _id: idParam }, { meeting_id: idParam }];
        } else {
             meetingQuery.meeting_id = idParam;
        }

        const meeting = await Meeting.findOne(meetingQuery);
        if (!meeting) return res.status(404).json({ error: "Meeting not found." });

        note = new Note({
            userId: userId,
            meetingId: meeting.meeting_id || meeting._id.toString(),
            title: title || meeting.meeting_title || "Untitled Meeting",
            content: content || "Processing...",
            shareId: uuidv4()
        });
        await note.save();
    }
    res.json({ success: true, shareId: note.shareId }); 
  } catch (err) {
    console.error("Share API Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- ENDPOINT B: PUBLIC VIEW (S3 Integration) ---
router.get('/shared/:shareId', async (req, res) => {
  try {
    // 1. Find the Note
    const note = await Note.findOne({ shareId: req.params.shareId });
    if (!note) return res.status(404).json({ error: "Link expired" });

    // 2. Find the Meeting (to check flags and get ID)
    const mId = note.meetingId;
    let meetingQuery = mongoose.Types.ObjectId.isValid(mId) 
        ? { $or: [{ _id: mId }, { meeting_id: mId }] } 
        : { meeting_id: mId };
    
    const meeting = await Meeting.findOne(meetingQuery);
    
    // 3. CONSTRUCT S3 KEYS (Dynamic)
    // Structure: meetings/meet_{meeting_id}/...
    const meetingIdStr = meeting ? meeting.meeting_id : mId; // Ensure we have the string ID
    const basePath = `meetings/meet_${meetingIdStr}`;
    
    const videoKey = `${basePath}/video/recording.mp4`;
    const transcriptKey = `${basePath}/transcript/transcript.json`;
    const summaryKey = `${basePath}/transcript/summary.json`;

    // 4. PARALLEL FETCHING
    // We start all requests at once for speed
    const videoPromise = (meeting && meeting.has_video) 
        ? generateVideoLink(videoKey) 
        : Promise.resolve(null);

    const transcriptPromise = (meeting && meeting.has_transcript) 
        ? fetchJsonFromS3(transcriptKey) 
        : Promise.resolve(null);

    const summaryJsonPromise = (meeting && meeting.has_summary) 
        ? fetchJsonFromS3(summaryKey) 
        : Promise.resolve(null);

    const [videoUrl, transcriptJson, summaryJson] = await Promise.all([
        videoPromise, 
        transcriptPromise, 
        summaryJsonPromise
    ]);

    // 5. DATA PROCESSING
    // Unwrap Transcript: It usually comes as { transcript: [...] } or just [...]
    let events = [];
    if (transcriptJson) {
        if (Array.isArray(transcriptJson)) events = transcriptJson;
        else if (Array.isArray(transcriptJson.transcript)) events = transcriptJson.transcript;
        else if (Array.isArray(transcriptJson.events)) events = transcriptJson.events;
    }

    // Unwrap Summary: It might be { summary: "...", action_items: [...] }
    const finalSummary = note.content || (summaryJson && summaryJson.summary) || (meeting && meeting.summary) || "";
    const finalTodos = (summaryJson && summaryJson.action_items) || (meeting && meeting.action_items) || [];

    // 6. RESPONSE
    res.json({
        type: 'full',
        title: note.title,
        date: meeting ? (meeting.start_time || meeting.createdAt || meeting.engaged_at) : note.createdAt,
        
        summary: finalSummary,
        todos: finalTodos,
        
        video_url: videoUrl,
        events: events,
        
        bot_name: "HiCapy Bot" 
    });

  } catch (err) {
    console.error("Shared View Error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;