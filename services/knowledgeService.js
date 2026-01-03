/**
 * Knowledge Service - Unified Knowledge Graph for HiCapy
 * 
 * This service provides a unified interface to search and retrieve
 * information across ALL user data sources:
 * - Meeting transcripts and summaries
 * - Tasks (from meetings)
 * - Notes
 * - Emails (via Gmail API)
 * - Calendar events
 * - Mem0 memories
 * 
 * Think of this as the "brain" that connects everything together.
 */

const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const Note = require('../models/Note');
const Action = require('../models/Action');
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const s3Client = require('../config/s3');
const mem0Service = require('./mem0Service');
const integrationHelper = require('../utils/integrationHelper');
const { google } = require('googleapis');

const BUCKET = process.env.AWS_BUCKET_NAME || 'hicapy';

// ============================================
// HELPER: Fetch JSON from S3
// ============================================
const fetchS3Json = async (key) => {
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const response = await s3Client.send(command);
    const bodyString = await response.Body.transformToString();
    return JSON.parse(bodyString);
  } catch (err) {
    console.error(`[Knowledge] S3 fetch error for ${key}:`, err.message);
    return null;
  }
};

// ============================================
// GET ALL MEETING DATA FOR A USER
// ============================================
const getAllMeetingsWithContent = async (userId, limit = 20) => {
  try {
    const meetings = await Meeting.find({ user_id: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const enrichedMeetings = [];

    for (const meeting of meetings) {
      const basePath = `meetings/meet_${meeting.meeting_id}`;
      
      // Fetch transcript and summary from S3
      let transcript = null;
      let summary = null;
      
      if (meeting.has_transcript) {
        transcript = await fetchS3Json(`${basePath}/transcript/transcript.json`);
      }
      if (meeting.has_summary) {
        summary = await fetchS3Json(`${basePath}/summary/summary.json`);
      }

      // Get tasks for this meeting
      const tasks = await Task.find({ meeting_id: meeting.meeting_id }).lean();

      enrichedMeetings.push({
        id: meeting.meeting_id,
        title: meeting.meeting_title || 'Untitled Meeting',
        date: meeting.start_time || meeting.createdAt,
        status: meeting.status,
        link: meeting.meetlink,
        hasTranscript: meeting.has_transcript,
        hasSummary: meeting.has_summary,
        // Store the raw transcript data (could be 'events' or 'transcript' format)
        transcriptData: transcript,
        // Extract text content for searching
        transcriptText: extractTranscriptText(transcript),
        summary: summary || null,
        speakers: extractSpeakers(transcript),
        tasks: tasks.map(t => ({
          id: t.task_id,
          description: t.description,
          status: t.status,
          assignees: t.assignees,
          creator: t.creator_info
        }))
      });
    }

    return enrichedMeetings;
  } catch (error) {
    console.error('[Knowledge] Error fetching meetings:', error);
    return [];
  }
};

// ============================================
// EXTRACT SPEAKERS FROM TRANSCRIPT
// ============================================
const extractSpeakers = (transcriptData) => {
  if (!transcriptData) return [];
  
  const speakers = new Set();
  
  // Handle new format with 'events' array
  if (transcriptData.events && Array.isArray(transcriptData.events)) {
    transcriptData.events.forEach(entry => {
      if (entry.speaker) speakers.add(entry.speaker);
      // Also extract speaker name from text if it's prefixed (e.g., "John Doe\nActual text")
      if (entry.text && entry.text.includes('\n')) {
        const possibleName = entry.text.split('\n')[0].trim();
        if (possibleName && possibleName.length < 50 && !possibleName.includes(' ') === false) {
          speakers.add(possibleName);
        }
      }
    });
  }
  
  // Handle participants array
  if (transcriptData.participants && Array.isArray(transcriptData.participants)) {
    transcriptData.participants.forEach(p => {
      if (p && p !== 'Unknown') speakers.add(p);
    });
  }
  
  // Handle old format with 'transcript' array
  if (transcriptData.transcript && Array.isArray(transcriptData.transcript)) {
    transcriptData.transcript.forEach(entry => {
      if (entry.speaker) speakers.add(entry.speaker);
    });
  }
  
  return Array.from(speakers).filter(s => s !== 'Unknown');
};

// ============================================
// EXTRACT FULL TEXT FROM TRANSCRIPT
// ============================================
const extractTranscriptText = (transcriptData) => {
  if (!transcriptData) return '';
  
  const textParts = [];
  
  // Handle new format with 'events' array
  if (transcriptData.events && Array.isArray(transcriptData.events)) {
    transcriptData.events.forEach(entry => {
      if (entry.text) {
        textParts.push(entry.text);
      }
    });
  }
  
  // Handle old format with 'transcript' array
  if (transcriptData.transcript && Array.isArray(transcriptData.transcript)) {
    transcriptData.transcript.forEach(entry => {
      if (entry.text) {
        textParts.push(`${entry.speaker || ''}: ${entry.text}`);
      }
    });
  }
  
  return textParts.join(' ');
};

// ============================================
// TOKENIZE QUERY INTO SEARCHABLE KEYWORDS
// ============================================
const tokenizeQuery = (query) => {
  // Remove common stop words and extract meaningful keywords
  const stopWords = ['did', 'i', 'have', 'any', 'the', 'a', 'an', 'with', 'about', 'regarding', 'what', 'who', 'when', 'where', 'how', 'is', 'are', 'was', 'were', 'do', 'does', 'my', 'me', 'you', 'your', 'this', 'that', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'from'];
  
  const words = query.toLowerCase()
    .replace(/[?!.,;:'"]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.includes(word));
  
  return [...new Set(words)]; // Remove duplicates
};

// ============================================
// SEARCH ACROSS ALL KNOWLEDGE SOURCES
// ============================================
const searchKnowledge = async (userId, query, options = {}) => {
  console.log(`[Knowledge] Searching for: "${query}"`);
  
  const results = {
    meetings: [],
    tasks: [],
    notes: [],
    memories: [],
    relevantContext: []
  };

  const queryLower = query.toLowerCase();
  const keywords = tokenizeQuery(query);
  console.log(`[Knowledge] Extracted keywords: ${keywords.join(', ')}`);

  try {
    // 1. Search meetings (titles, transcripts, summaries)
    const allMeetings = await getAllMeetingsWithContent(userId, 50);
    console.log(`[Knowledge] Checking ${allMeetings.length} meetings`);
    
    for (const meeting of allMeetings) {
      let relevance = 0;
      let matchReason = [];
      let matchedKeywords = [];

      // Check each keyword
      for (const keyword of keywords) {
        // Check title
        if (meeting.title?.toLowerCase().includes(keyword)) {
          relevance += 10;
          matchedKeywords.push(`title:${keyword}`);
        }

        // Check speakers
        if (meeting.speakers?.some(s => s.toLowerCase().includes(keyword))) {
          relevance += 15; // Higher weight for speaker matches
          matchedKeywords.push(`speaker:${keyword}`);
        }

        // Check transcript text
        if (meeting.transcriptText?.toLowerCase().includes(keyword)) {
          relevance += 5;
          matchedKeywords.push(`transcript:${keyword}`);
        }

        // Check summary
        if (meeting.summary) {
          const summaryText = JSON.stringify(meeting.summary).toLowerCase();
          if (summaryText.includes(keyword)) {
            relevance += 6;
            matchedKeywords.push(`summary:${keyword}`);
          }
        }
      }

      // Check tasks
      const matchingTasks = meeting.tasks?.filter(t => 
        keywords.some(kw => t.description?.toLowerCase().includes(kw))
      ) || [];
      
      if (matchingTasks.length > 0) {
        relevance += 7;
        matchReason.push('task match');
      }

      if (relevance > 0) {
        console.log(`[Knowledge] Meeting "${meeting.title}" matched with relevance ${relevance}: ${matchedKeywords.join(', ')}`);
        results.meetings.push({
          ...meeting,
          relevance,
          matchReason: matchedKeywords.join(', '),
          matchingTasks
        });
      }
    }

    // Sort by relevance
    results.meetings.sort((a, b) => b.relevance - a.relevance);

    // 2. Search all tasks
    const allTasks = await Task.find({
      $or: [
        { description: { $regex: query, $options: 'i' } },
        { 'assignees.name': { $regex: query, $options: 'i' } }
      ]
    }).lean();

    results.tasks = allTasks.map(t => ({
      id: t.task_id,
      meetingId: t.meeting_id,
      description: t.description,
      status: t.status,
      assignees: t.assignees,
      createdAt: t.createdAt
    }));

    // 3. Search notes
    const notes = await Note.find({
      userId,
      $or: [
        { title: { $regex: query, $options: 'i' } },
        { content: { $regex: query, $options: 'i' } }
      ]
    }).lean();

    results.notes = notes.map(n => ({
      id: n._id,
      title: n.title,
      content: n.content?.substring(0, 500),
      meetingId: n.meetingId
    }));

    // 4. Search Mem0 memories
    results.memories = await mem0Service.search(query, userId);

    // 5. Build unified context
    results.relevantContext = buildContext(results, query);

    console.log(`[Knowledge] Found: ${results.meetings.length} meetings, ${results.tasks.length} tasks, ${results.notes.length} notes`);

    return results;
  } catch (error) {
    console.error('[Knowledge] Search error:', error);
    return results;
  }
};

// ============================================
// BUILD UNIFIED CONTEXT STRING FOR AI
// ============================================
const buildContext = (results, query) => {
  const contextParts = [];

  // Add meeting context
  if (results.meetings.length > 0) {
    contextParts.push('=== RELEVANT MEETINGS ===');
    results.meetings.slice(0, 5).forEach(m => {
      contextParts.push(`\nMeeting: "${m.title}" on ${new Date(m.date).toLocaleDateString()}`);
      contextParts.push(`  Speakers: ${m.speakers?.join(', ') || 'Unknown'}`);
      contextParts.push(`  Match reason: ${m.matchReason}`);
      
      if (m.summary?.key_points) {
        contextParts.push(`  Key Points: ${m.summary.key_points.slice(0, 3).join('; ')}`);
      }
      
      if (m.matchingTasks?.length > 0) {
        contextParts.push(`  Related Tasks:`);
        m.matchingTasks.forEach(t => {
          contextParts.push(`    - ${t.description} (${t.status})`);
        });
      }

      // Add relevant transcript snippets from both formats
      const keywords = tokenizeQuery(query);
      if (m.transcriptData?.events && Array.isArray(m.transcriptData.events)) {
        const relevantSnippets = m.transcriptData.events
          .filter(t => keywords.some(kw => t.text?.toLowerCase().includes(kw)))
          .slice(0, 5);
        
        if (relevantSnippets.length > 0) {
          contextParts.push(`  Transcript snippets:`);
          relevantSnippets.forEach(s => {
            // Extract speaker name from text if prefixed
            let speaker = s.speaker || 'Unknown';
            let text = s.text || '';
            if (text.includes('\n')) {
              const parts = text.split('\n');
              speaker = parts[0].trim() || speaker;
              text = parts.slice(1).join(' ').trim();
            }
            contextParts.push(`    ${speaker}: "${text.substring(0, 200)}"`);
          });
        }
      } else if (m.transcriptData?.transcript && Array.isArray(m.transcriptData.transcript)) {
        const relevantSnippets = m.transcriptData.transcript
          .filter(t => keywords.some(kw => t.text?.toLowerCase().includes(kw)))
          .slice(0, 5);
        
        if (relevantSnippets.length > 0) {
          contextParts.push(`  Transcript snippets:`);
          relevantSnippets.forEach(s => {
            contextParts.push(`    ${s.speaker}: "${s.text?.substring(0, 200)}"`);
          });
        }
      }
    });
  }

  // Add task context
  if (results.tasks.length > 0) {
    contextParts.push('\n=== RELEVANT TASKS ===');
    results.tasks.slice(0, 5).forEach(t => {
      contextParts.push(`- Task: ${t.description}`);
      contextParts.push(`  Status: ${t.status}, Meeting: ${t.meetingId}`);
      if (t.assignees?.length > 0) {
        contextParts.push(`  Assigned to: ${t.assignees.map(a => a.name).join(', ')}`);
      }
    });
  }

  // Add note context
  if (results.notes.length > 0) {
    contextParts.push('\n=== RELEVANT NOTES ===');
    results.notes.slice(0, 3).forEach(n => {
      contextParts.push(`- Note: "${n.title}"`);
      contextParts.push(`  Content: ${n.content?.substring(0, 200)}...`);
    });
  }

  // Add memory context
  if (results.memories.length > 0) {
    contextParts.push('\n=== MEMORIES & HISTORY ===');
    results.memories.slice(0, 5).forEach(m => {
      contextParts.push(`- ${m.text} (Source: ${m.source}, Date: ${m.date})`);
    });
  }

  return contextParts.join('\n');
};

// ============================================
// GET RECENT ACTIVITY FOR BRIEFING
// ============================================
const getRecentActivity = async (userId, days = 7) => {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [meetings, tasks, actions] = await Promise.all([
    Meeting.find({ 
      user_id: userId, 
      createdAt: { $gte: since } 
    }).sort({ createdAt: -1 }).limit(10).lean(),
    
    Task.find({
      creator_id: userId.toString(),
      createdAt: { $gte: since }
    }).sort({ createdAt: -1 }).limit(20).lean(),
    
    Action.find({
      userId,
      createdAt: { $gte: since }
    }).sort({ createdAt: -1 }).limit(10).lean()
  ]);

  return { meetings, tasks, actions };
};

// ============================================
// INDEX NEW DATA INTO MEM0 FOR FUTURE RETRIEVAL
// ============================================
const indexMeetingToMemory = async (userId, meeting, transcript, summary) => {
  try {
    // Index meeting summary
    if (summary) {
      const summaryText = `Meeting "${meeting.meeting_title}" on ${meeting.start_time}. 
        Key points: ${summary.key_points?.join('; ') || 'N/A'}. 
        Decisions: ${summary.decisions?.join('; ') || 'N/A'}.
        Action items: ${summary.action_items?.join('; ') || 'N/A'}.`;
      
      await mem0Service.client.add(
        [{ role: 'user', content: summaryText }],
        {
          user_id: userId,
          metadata: {
            source: 'meeting',
            meetingId: meeting.meeting_id,
            date: meeting.start_time,
            type: 'meeting_summary'
          }
        }
      );
    }

    // Index key discussions from transcript
    if (transcript?.transcript && Array.isArray(transcript.transcript)) {
      // Extract important segments (long statements, decisions, etc.)
      const importantSegments = transcript.transcript
        .filter(t => t.text?.length > 100)
        .slice(0, 10);

      for (const segment of importantSegments) {
        await mem0Service.client.add(
          [{ role: 'user', content: `In meeting "${meeting.meeting_title}", ${segment.speaker} said: "${segment.text}"` }],
          {
            user_id: userId,
            metadata: {
              source: 'transcript',
              meetingId: meeting.meeting_id,
              speaker: segment.speaker,
              date: meeting.start_time,
              type: 'discussion'
            }
          }
        );
      }
    }

    console.log(`[Knowledge] Indexed meeting ${meeting.meeting_id} to memory`);
  } catch (error) {
    console.error('[Knowledge] Error indexing meeting:', error);
  }
};

module.exports = {
  getAllMeetingsWithContent,
  searchKnowledge,
  buildContext,
  getRecentActivity,
  indexMeetingToMemory,
  fetchS3Json
};
