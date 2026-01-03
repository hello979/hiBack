const { GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const s3Client = require('../config/s3');
const Meeting = require('../models/Meeting');
const logger = require('../utils/logger');

// --- DEBUG HELPER: Check file existence and LOG the result ---
const checkS3WithLog = async (bucket, key, label) => {
    try {
        console.log(`[DEBUG] Checking ${label} at: ${key}`);
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        console.log(`[DEBUG] ✅ ${label} FOUND!`);
        return true;
    } catch (err) {
        console.log(`[DEBUG] ❌ ${label} FAILED: ${err.name} - ${err.message}`);
        return false;
    }
};

// --- HELPER: Fetch JSON content ---
const safeFetchJson = async (bucket, key) => {
    try {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3Client.send(command);
        const bodyString = await response.Body.transformToString();
        return JSON.parse(bodyString);
    } catch (err) {
        return null;
    }
};

/**
 * 1. VERBOSE DEBUG FETCH (The one you need right now)
 * GET /api/transcripts/:meeting_id/assets
 */
exports.getMeetingAssets = async (req, res) => {
    const { meeting_id } = req.params;
    console.log(`\n\n=== START DEBUG REQUEST for Meeting: ${meeting_id} ===`);

    try {
        const meeting = await Meeting.findOne({ meeting_id });
        if (!meeting) {
            console.log(`[DEBUG] ❌ Meeting not found in MongoDB`);
            return res.status(404).json({ msg: 'Meeting not found' });
        }
        
        const BUCKET = process.env.AWS_BUCKET_NAME || 'hicapy';
        console.log(`[DEBUG] Using Bucket: ${BUCKET}`);
        console.log(`[DEBUG] Mongo Flags -> T:${meeting.has_transcript} S:${meeting.has_summary} V:${meeting.has_video}`);

        const basePath = `meetings/meet_${meeting_id}`;
        
        // PATHS TO CHECK
        const paths = {
            transcript: `${basePath}/transcript/transcript.json`,
            summary:    `${basePath}/summary/summary.json`,
            video:      `${basePath}/video/recording.mp4`
        };

        // FORCE CHECK S3 REALITY
        const hasTranscript = await checkS3WithLog(BUCKET, paths.transcript, 'Transcript');
        const hasSummary    = await checkS3WithLog(BUCKET, paths.summary,    'Summary');
        const hasVideo      = await checkS3WithLog(BUCKET, paths.video,      'Video');

        // SELF-HEAL MONGODB
        if (meeting.has_transcript !== hasTranscript || 
            meeting.has_summary !== hasSummary || 
            meeting.has_video !== hasVideo) {
            console.log(`[DEBUG] ⚠️  Mismatch found! Updating MongoDB...`);
            meeting.has_transcript = hasTranscript;
            meeting.has_summary = hasSummary;
            meeting.has_video = hasVideo;
            await meeting.save();
        }

        // FETCH DATA
        console.log(`[DEBUG] Fetching content...`);
        
        const [transcriptData, summaryData, videoUrl] = await Promise.all([
            hasTranscript ? safeFetchJson(BUCKET, paths.transcript) : null,
            hasSummary    ? safeFetchJson(BUCKET, paths.summary) : null,
            hasVideo      ? getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET, Key: paths.video }), { expiresIn: 3600 }) : null
        ]);

        // =========================================================
        // 👇 SUPER DEBUG BLOCK 👇
        // =========================================================
        if (transcriptData) {
            console.log("\n====== DEEP DIVE: TRANSCRIPT DATA ======");
            console.log("ALL KEYS IN JSON:", Object.keys(transcriptData));

            // 1. Inspect 'transcript'
            console.log(`\n--- Field: 'transcript' ---`);
            console.log(`   Value:`, transcriptData.transcript);

            // 2. Inspect 'chat_messages' (FORCE PRINT)
            console.log(`\n--- Field: 'chat_messages' ---`);
            const cVal = transcriptData.chat_messages;
            console.log(`   Type:`, typeof cVal);
            
            if (Array.isArray(cVal)) {
                console.log(`   Is Array: YES`);
                console.log(`   Length: ${cVal.length}`);
                console.log(`   First Item:`, cVal[0] ? JSON.stringify(cVal[0]) : "None");
            } else {
                console.log(`   Is Array: NO`);
                console.log(`   Raw Value:`, cVal);
            }

            console.log("=========================================\n");
        } else {
            console.log("\n====== TRANSCRIPT DATA IS NULL ======\n");
        }
        // =========================================================

        res.json({
            success: true,
            meeting_id,
            flags: { has_transcript: hasTranscript, has_summary: hasSummary, has_video: hasVideo },
            // Early termination info
            stopped_early: meeting.stopped_early || false,
            termination_reason: meeting.termination_reason || null,
            end_time: meeting.end_time,
            last_stopped_at: meeting.last_stopped_at,
            data: {
                transcript: transcriptData,
                summary: summaryData,
                video_url: videoUrl,
                videoUrl: videoUrl 
            }
        });

    } catch (err) {
        console.error(`[DEBUG] FATAL ERROR:`, err);
        res.status(500).json({ msg: 'Server Error', error: err.message });
    }
};

/**
 * 2. SYNC TOOL (Restored)
 * GET /api/transcripts/:meeting_id/sync
 */
exports.syncMeetingAssets = async (req, res) => {
    // Re-using the debug logic's core check, simplified
    try {
        const { meeting_id } = req.params;
        const meeting = await Meeting.findOne({ meeting_id });
        if (!meeting) return res.status(404).json({ msg: 'Meeting not found' });
        
        // Reuse getMeetingAssets logic essentially, or just return OK
        // For now, let's just use the main function logic above since it auto-heals
        return exports.getMeetingAssets(req, res); 
    } catch (err) {
        res.status(500).json({ msg: 'Error' });
    }
};

/**
 * 3. STORE TRANSCRIPT (Restored)
 * POST /api/transcripts/store
 */
exports.storeTranscript = async (req, res) => {
    try {
        const { meeting_id, events, ...meta } = req.body;
        const meeting = await Meeting.findOne({ meeting_id });
        if (!meeting) return res.status(404).json({ msg: 'Meeting not found' });

        const s3Key = `meetings/meet_${meeting_id}/transcript/transcript.json`;
        
        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME || 'hicapy',
            Key: s3Key,
            Body: JSON.stringify({ meeting_id, events, ...meta }),
            ContentType: 'application/json'
        }));

        meeting.has_transcript = true;
        await meeting.save();

        res.json({ msg: 'Transcript stored', meeting_id });
    } catch (err) {
        logger.logError(`Store Error: ${err.message}`);
        res.status(500).json({ msg: 'Server Error' });
    }
};