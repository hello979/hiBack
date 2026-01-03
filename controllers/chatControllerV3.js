/**
 * Chat Controller v3 - HiCapy Intelligent Assistant
 * 
 * Implements the full HiCapy specification:
 * 1. 3-Type Intent Recognition (Information, Action, Exploratory)
 * 2. Persistent Conversation History
 * 3. Full Context Injection from Knowledge Graph
 * 4. Pronoun Resolution from Conversation Context
 * 5. Action Approval Flow with [Approve][Edit][Cancel]
 * 6. Learning from User Corrections
 * 7. High-Stakes Action Confirmation
 * 8. Topic Shift Detection (NEW)
 * 9. Strict API Data Priority (NEW)
 * 10. Structured UI Responses (NEW)
 */

const mem0Service = require('../services/mem0Service');
const aiService = require('../services/aiService');
const contextManager = require('../services/contextManager');
const integrationHelper = require('../utils/integrationHelper');
const knowledgeGraphService = require('../services/knowledgeGraphService');
const Conversation = require('../models/Conversation');
const Action = require('../models/Action');
const User = require('../models/users');
const Meeting = require('../models/Meeting');
const Task = require('../models/Task');
const Bot = require('../models/Bot');
const Groq = require('groq-sdk');
const { google } = require('googleapis');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ============================================
// HELPER: Fetch Emails from Gmail
// ============================================
const fetchEmails = async (userId, searchParams = {}) => {
  try {
    const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
    if (!accessToken && !refreshToken) {
      return { success: false, error: 'Gmail not connected' };
    }
    
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    
    const gmail = google.gmail({ version: 'v1', auth });
    
    // Build Gmail search query
    let query = 'in:inbox';
    if (searchParams.from) query += ` from:${searchParams.from}`;
    if (searchParams.to) query += ` to:${searchParams.to}`;
    if (searchParams.subject) query += ` subject:${searchParams.subject}`;
    if (searchParams.keywords?.length > 0) query += ` ${searchParams.keywords.join(' ')}`;
    if (searchParams.unreadOnly) query += ' is:unread';
    
    // Date handling
    const now = new Date();
    if (searchParams.dateRange === 'today') {
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      query += ` after:${formatDateForGmail(today)}`;
    } else if (searchParams.dateRange === 'yesterday') {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      query += ` after:${formatDateForGmail(yesterday)} before:${formatDateForGmail(now)}`;
    } else if (searchParams.dateRange === 'this_week') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      query += ` after:${formatDateForGmail(weekAgo)}`;
    }
    
    console.log(`[ChatV3] Gmail query: ${query}`);
    
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: searchParams.limit || 10,
      q: query
    });
    
    if (!listRes.data.messages?.length) {
      return { success: true, emails: [], count: 0, query };
    }
    
    const emailPromises = listRes.data.messages.slice(0, 10).map(async (msgStub) => {
      try {
        const msg = await gmail.users.messages.get({ 
          userId: 'me', 
          id: msgStub.id, 
          format: 'full'
        });
        
        const headers = msg.data.payload.headers;
        const fromHeader = headers.find(h => h.name === 'From')?.value || '';
        const toHeader = headers.find(h => h.name === 'To')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
        const dateHeader = headers.find(h => h.name === 'Date')?.value;
        
        const fromMatch = fromHeader.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+)>?$/);
        const senderName = fromMatch?.[1]?.trim() || fromMatch?.[2]?.split('@')[0] || 'Unknown';
        const senderEmail = fromMatch?.[2] || fromHeader;
        
        return {
          id: msg.data.id,
          threadId: msg.data.threadId,
          from: senderName,
          fromEmail: senderEmail,
          to: toHeader,
          subject,
          date: dateHeader ? new Date(dateHeader) : null,
          dateFormatted: dateHeader ? new Date(dateHeader).toLocaleDateString('en-US', { 
            weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
          }) : 'Unknown',
          snippet: msg.data.snippet?.substring(0, 300) || '',
          isUnread: msg.data.labelIds?.includes('UNREAD')
        };
      } catch (e) {
        console.error(`[ChatV3] Error fetching email:`, e.message);
        return null;
      }
    });
    
    const emails = (await Promise.all(emailPromises)).filter(e => e !== null);
    
    return { success: true, emails, count: emails.length, query };
  } catch (error) {
    console.error('[ChatV3] Email fetch error:', error.message);
    return { success: false, error: error.message };
  }
};

const formatDateForGmail = (date) => {
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};

// ============================================
// HELPER: Fetch Calendar Events
// ============================================
const fetchCalendarEvents = async (userId, searchParams = {}) => {
  try {
    const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
    if (!accessToken && !refreshToken) {
      return { success: false, error: 'Calendar not connected' };
    }
    
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    
    const calendar = google.calendar({ version: 'v3', auth });
    
    const now = new Date();
    let timeMin = new Date(now);
    let timeMax = new Date(now);
    
    if (searchParams.dateRange === 'today') {
      timeMin.setHours(0, 0, 0, 0);
      timeMax.setHours(23, 59, 59, 999);
    } else if (searchParams.dateRange === 'tomorrow') {
      timeMin.setDate(timeMin.getDate() + 1);
      timeMin.setHours(0, 0, 0, 0);
      timeMax.setDate(timeMax.getDate() + 1);
      timeMax.setHours(23, 59, 59, 999);
    } else if (searchParams.dateRange === 'this_week') {
      timeMax.setDate(timeMax.getDate() + 7);
    } else {
      timeMin.setHours(0, 0, 0, 0);
      timeMax.setDate(timeMax.getDate() + 7);
    }
    
    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20
    });
    
    const events = (eventsRes.data.items || []).map(e => ({
      id: e.id,
      title: e.summary || '(No title)',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location || null,
      attendees: e.attendees?.map(a => ({ email: a.email, name: a.displayName })) || [],
      description: e.description?.substring(0, 200) || null,
      isAllDay: !e.start?.dateTime,
      htmlLink: e.htmlLink,
      meetLink: e.hangoutLink || e.location // Capture Google Meet link
    }));
    
    return { success: true, events, count: events.length };
  } catch (error) {
    console.error('[ChatV3] Calendar fetch error:', error.message);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Find teammates
// ============================================
const findTeammates = async (userId, searchName = null) => {
  try {
    const user = await User.findById(userId).populate('team', 'username email _id');
    const teammates = user?.team || [];
    
    if (searchName) {
      const lower = searchName.toLowerCase();
      return teammates.filter(t => 
        t.username?.toLowerCase().includes(lower) || 
        t.email?.toLowerCase().includes(lower)
      );
    }
    
    return teammates;
  } catch (error) {
    console.error('[ChatV3] Find teammates error:', error.message);
    return [];
  }
};

// ============================================
// HELPER: Get meeting tasks
// ============================================
const getMeetingTasks = async (userId, meetingQuery) => {
  try {
    // Find meeting by title match
    const meetings = await Meeting.find({ 
      user_id: userId 
    }).sort({ createdAt: -1 }).limit(20);
    
    const lower = meetingQuery.toLowerCase();
    const matchedMeeting = meetings.find(m => 
      m.meeting_title?.toLowerCase().includes(lower)
    );
    
    if (!matchedMeeting) {
      return { success: false, error: 'Meeting not found', meetings: meetings.map(m => m.meeting_title) };
    }
    
    // Get tasks for this meeting
    const tasks = await Task.find({ meeting_id: matchedMeeting.meeting_id });
    
    return {
      success: true,
      meeting: {
        id: matchedMeeting.meeting_id,
        title: matchedMeeting.meeting_title,
        date: matchedMeeting.start_time
      },
      tasks: tasks.map(t => ({
        id: t.task_id,
        description: t.description,
        status: t.status,
        assignees: t.assignees
      }))
    };
  } catch (error) {
    console.error('[ChatV3] Get meeting tasks error:', error.message);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Assign task to teammate
// ============================================
const assignTaskToTeammate = async (userId, taskId, teammateId, teammateName) => {
  try {
    const task = await Task.findOne({ task_id: taskId });
    if (!task) {
      return { success: false, error: 'Task not found' };
    }
    
    // Add assignee
    const alreadyAssigned = task.assignees?.some(a => a.user_id === teammateId);
    if (!alreadyAssigned) {
      task.assignees = task.assignees || [];
      task.assignees.push({
        user_id: teammateId,
        name: teammateName
      });
      await task.save();
    }
    
    return { success: true, task };
  } catch (error) {
    console.error('[ChatV3] Assign task error:', error.message);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Extract tasks from conversation text
// ============================================
const extractTasksFromConversation = (conversationText) => {
  if (!conversationText) return [];
  
  const tasks = [];
  let match;
  
  // Action verbs that indicate a real task
  const actionVerbs = /^(follow up|review|send|complete|prepare|schedule|contact|update|create|draft|submit|discuss|plan|confirm|finalize|coordinate|arrange|organize|check|verify|respond|reply|forward|share|present|deliver|implement|resolve|address|handle|process)/i;
  
  // Patterns that are NOT tasks (dates, meeting titles, etc.)
  const notTaskPatterns = [
    /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    /^(january|february|march|april|may|june|july|august|september|october|november|december)/i,
    /^\d{1,2}(st|nd|rd|th)?[,\s]/i, // "9th, 2026"
    /^(email|meeting|document|calendar|scheduled|client|project)\s+(from|with|on|at|for)/i,
    /^(here|would|these|this|that|i found|based on|upon)/i,
    /PM|AM|IST|EST|PST|UTC/i,
    /^\d{4}$/, // Just a year
  ];
  
  const isValidTask = (text) => {
    const trimmed = text.trim();
    // Must start with action verb OR be after "task:" pattern
    if (!actionVerbs.test(trimmed)) return false;
    // Must not match exclusion patterns
    for (const pattern of notTaskPatterns) {
      if (pattern.test(trimmed)) return false;
    }
    return trimmed.length > 15; // Tasks should be descriptive
  };
  
  // Pattern 1: Numbered items that start with action verbs
  const lines = conversationText.split('\n');
  for (const line of lines) {
    const numberedMatch = line.match(/^\s*(\d+)[.)]\s*\*?\*?(.+)/);
    if (numberedMatch) {
      const taskText = numberedMatch[2].replace(/\*+/g, '').replace(/:.+$/, '').trim();
      if (isValidTask(taskText)) {
        const exists = tasks.some(t => t.description.toLowerCase() === taskText.toLowerCase());
        if (!exists) {
          tasks.push({
            id: `conv-task-${numberedMatch[1]}`,
            description: taskText,
            status: 'pending',
            source: 'conversation'
          });
        }
      }
    }
  }
  
  // Pattern 2: Bold action items like **Follow up with...**
  const boldPattern = /\*\*((?:Follow up|Review|Send|Complete|Prepare|Schedule|Contact|Update|Create|Draft|Submit|Discuss|Plan|Confirm|Finalize)[^*]+)\*\*/gi;
  while ((match = boldPattern.exec(conversationText)) !== null) {
    const taskText = match[1].trim();
    if (taskText.length > 15 && !notTaskPatterns.some(p => p.test(taskText))) {
      const exists = tasks.some(t => t.description.toLowerCase().includes(taskText.toLowerCase().substring(0, 15)));
      if (!exists) {
        tasks.push({
          id: `conv-task-${tasks.length + 1}`,
          description: taskText,
          status: 'pending',
          source: 'conversation'
        });
      }
    }
  }
  
  // Pattern 3: Explicit task mentions like "unassigned to-do tasks:"
  const taskListMatch = conversationText.match(/(?:unassigned|pending|open)\s+(?:to-?do\s+)?tasks?[^:]*:([\s\S]*?)(?:Would you like|$)/i);
  if (taskListMatch) {
    const taskSection = taskListMatch[1];
    const taskLines = taskSection.split('\n');
    for (const tLine of taskLines) {
      const itemMatch = tLine.match(/^\s*(?:\d+[.)]|[-•])\s*\*?\*?(.+)/); 
      if (itemMatch) {
        const taskText = itemMatch[1].replace(/\*+/g, '').replace(/:.+$/, '').trim();
        if (taskText.length > 15 && actionVerbs.test(taskText)) {
          const exists = tasks.some(t => t.description.toLowerCase().includes(taskText.toLowerCase().substring(0, 15)));
          if (!exists) {
            tasks.push({
              id: `conv-task-${tasks.length + 1}`,
              description: taskText,
              status: 'pending',
              source: 'conversation'
            });
          }
        }
      }
    }
  }
  
  return tasks;
};

// ============================================
// HELPER: Get user's bots
// ============================================
const getUserBots = async (userId) => {
  try {
    const bots = await Bot.find({ user_id: userId, status: { $ne: 'deleted' } });
    return bots;
  } catch (error) {
    console.error('[ChatV3] Get bots error:', error.message);
    return [];
  }
};

// ============================================
// HELPER: Assign bot to meeting
// ============================================
const assignBotToMeeting = async (userId, meetingId, botId) => {
  try {
    const meeting = await Meeting.findOne({ meeting_id: meetingId, user_id: userId });
    const bot = await Bot.findOne({ _id: botId, user_id: userId });
    
    if (!meeting) return { success: false, error: 'Meeting not found' };
    if (!bot) return { success: false, error: 'Bot not found' };
    
    meeting.assigned_bot_id = bot._id;
    meeting.assigned_bot_service_id = bot.bot_service_bot_id;
    await meeting.save();
    
    return { success: true, meeting, bot };
  } catch (error) {
    console.error('[ChatV3] Assign bot error:', error.message);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Parse relative time expressions
// ============================================
const parseRelativeTime = (timeStr) => {
  if (!timeStr) return null;
  
  const now = new Date();
  const lower = timeStr.toLowerCase();
  
  if (timeStr.includes('T') && timeStr.includes('-')) {
    return new Date(timeStr);
  }
  
  let targetDate = new Date(now);
  
  if (lower.includes('tomorrow')) {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) {
      const currentDay = targetDate.getDay();
      let daysAhead = i - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      targetDate.setDate(targetDate.getDate() + daysAhead);
      break;
    }
  }
  
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2] || '0');
    const ampm = timeMatch[3]?.toLowerCase();
    
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    
    targetDate.setHours(hours, minutes, 0, 0);
    
    if (targetDate < now && !lower.includes('tomorrow') && !days.some(d => lower.includes(d))) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
  } else {
    targetDate.setHours(9, 0, 0, 0);
  }
  
  return targetDate;
};

// ============================================
// HELPER: Check if action is high-stakes
// ============================================
const isHighStakesAction = (actionType, payload) => {
  // More than 10 recipients
  if (payload.recipients?.length > 10 || payload.to?.length > 10) {
    return { isHighStakes: true, reason: 'This email will be sent to more than 10 recipients.' };
  }
  
  // External attendees for meetings
  if (actionType === 'schedule_meeting' && payload.attendees?.length > 0) {
    const userDomain = payload.userEmail?.split('@')[1];
    const hasExternal = payload.attendees.some(a => !a.includes(userDomain));
    if (hasExternal) {
      return { isHighStakes: true, reason: 'This meeting includes external attendees.' };
    }
  }
  
  // Keywords indicating sensitive content
  const sensitiveKeywords = ['legal', 'contract', 'confidential', 'nda', 'salary', 'termination', 'lawsuit'];
  const contentToCheck = (payload.body || '') + (payload.subject || '') + (payload.title || '');
  if (sensitiveKeywords.some(kw => contentToCheck.toLowerCase().includes(kw))) {
    return { isHighStakes: true, reason: 'This content appears to contain sensitive information.' };
  }
  
  return { isHighStakes: false, reason: null };
};

// ============================================
// MAIN CHAT ENDPOINT
// ============================================
exports.chat = async (req, res) => {
  try {
    const { message, conversationId, history, silent } = req.body;
    const userId = req.user.id;

    // SPECIAL HANDLING: Silent fetch for urgent emails (bypass LLM)
    if (message === '__fetch_urgent_emails__') {
      console.log(`[ChatV3] Silent fetch for urgent emails`);
      const emailResult = await fetchEmails(userId, {
        unreadOnly: true,
        limit: 5
      });
      
      if (emailResult.success) {
        const urgentEmails = emailResult.emails.filter(e => 
          (e.subject + e.snippet).toLowerCase().match(/urgent|alert|security|important|immediate|deadline|asap/)
        ).map(e => ({
          id: e.id,
          title: e.subject,
          from: e.from,
          snippet: e.snippet,
          urgency: 'high',
          source: 'gmail',
          date: e.date
        }));
        
        return res.json({ success: true, urgentEmails });
      }
      return res.json({ success: true, urgentEmails: [] });
    }

    console.log(`[ChatV3] Processing: "${message.substring(0, 50)}..."`);

    // 1. GET OR CREATE CONVERSATION
    let conversation;
    if (conversationId) {
      conversation = await Conversation.findOne({ _id: conversationId, userId });
    }
    if (!conversation) {
      conversation = await Conversation.getOrCreateActive(userId);
    }

    // 2. GET USER PREFERENCES
    const user = await User.findById(userId).select('preferences email username');
    const userPreferences = user?.preferences || {};

    // 2a. DETECT TOPIC SHIFT (NEW)
    const previousMessages = conversation.getMessagesForLLM(7);
    const focusContext = contextManager.getFocusContext(userId);
    
    const topicShiftResult = await contextManager.detectTopicShift({
      currentMessage: message,
      previousMessages: previousMessages,
      lastTopicContext: focusContext.currentTopic
    });
    
    console.log(`[ChatV3] Topic shift: ${topicShiftResult.isNewTopic ? 'NEW TOPIC' : 'CONTINUATION'} (confidence: ${topicShiftResult.confidence})`);
    
    // Clear focus context if topic shift detected
    if (topicShiftResult.isNewTopic && topicShiftResult.shouldClearContext) {
      contextManager.clearFocusContext(userId);
      console.log(`[ChatV3] Focus context cleared for new topic: "${topicShiftResult.currentTopic}"`);
    }

    // 2b. ANALYZE QUERY REQUIREMENTS (NEW)
    const queryRequirements = contextManager.analyzeQueryRequirements(message);
    console.log(`[ChatV3] Query requires: calendar=${queryRequirements.needsCalendar}, email=${queryRequirements.needsEmail}, freshData=${queryRequirements.needsFreshData}`);

    // 3. FETCH FRESH API DATA FIRST (if needed)
    const freshApiData = { calendar: [], emails: [], tasks: [] };
    
    if (queryRequirements.needsCalendar || queryRequirements.needsFreshData) {
      const dateRange = queryRequirements.dateRange || 'today';
      console.log(`[ChatV3] Fetching fresh calendar data for: ${dateRange}`);
      const calResult = await fetchCalendarEvents(userId, { dateRange });
      if (calResult.success) {
        freshApiData.calendar = calResult.events;
        console.log(`[ChatV3] Fresh calendar: ${calResult.events.length} events`);
      }
    }
    
    if (queryRequirements.needsEmail || queryRequirements.needsFreshData) {
      const emailResult = await fetchEmails(userId, {
        dateRange: queryRequirements.dateRange || 'today',
        limit: 10
      });
      if (emailResult.success) {
        freshApiData.emails = emailResult.emails;
        console.log(`[ChatV3] Fresh emails: ${emailResult.emails.length} emails`);
      }
    }

    // 4. GET KNOWLEDGE GRAPH CONTEXT
    const knowledgeContext = await mem0Service.search(message, userId);
    console.log(`[ChatV3] Knowledge context items: ${knowledgeContext.length}`);

    // 4a. RESOLVE CONTEXT PRIORITY (NEW)
    const conversationHistory = history || conversation.getMessagesForLLM(10);
    const resolvedContext = contextManager.resolveContextPriority({
      freshApiData,
      conversationHistory,
      longTermMemory: knowledgeContext,
      currentQuery: message
    });
    
    // Log any detected conflicts
    if (resolvedContext.conflicts.length > 0) {
      console.log(`[ChatV3] Context conflicts detected:`, resolvedContext.conflicts.map(c => c.message));
    }

    // Build context string with proper priority
    const contextString = contextManager.buildContextString(resolvedContext);

    // 4b. EXTRACT CONTEXT FROM RECENT CONVERSATION HISTORY
    let conversationContextText = '';
    if (conversationHistory && conversationHistory.length > 0) {
      conversationContextText = conversationHistory.slice(-7).map(m => {
        const role = m.role || m.sender || 'unknown';
        const content = m.content || m.text || '';
        return `${role}: ${content}`;
      }).join('\n');
    }
    
    // Extract any tasks mentioned in conversation
    const extractedTasks = extractTasksFromConversation(conversationContextText);
    console.log(`[ChatV3] Extracted ${extractedTasks.length} tasks from conversation text`);
    
    if (extractedTasks.length > 0 && (!conversation.lastReferences?.tasks || conversation.lastReferences.tasks.length === 0)) {
      conversation.lastReferences = conversation.lastReferences || {};
      conversation.lastReferences.tasks = extractedTasks;
    }

    // 4c. UPDATE FOCUS CONTEXT with entities (NEW)
    focusContext.update(topicShiftResult, {
      meetings: freshApiData.calendar,
      emails: freshApiData.emails,
      tasks: extractedTasks
    });

    // 4d. GET TOPIC-BASED CONTEXT FROM KNOWLEDGE GRAPH
    let topicContext = null;
    const topicMatch = message.match(/latest\s+(?:update|updates|news|status)\s+(?:on|about|for)\s+(.+?)(?:\?|$)/i);
    if (topicMatch) {
      topicContext = await knowledgeGraphService.getLatestUpdates(userId, topicMatch[1], 5);
      console.log(`[ChatV3] Topic context for "${topicMatch[1]}": ${topicContext.nodes.length} nodes`);
    }

    // 5. CLASSIFY INTENT (3-type system)
    const intentResult = await aiService.classifyIntent({
      message,
      conversationHistory: conversationHistory,
      lastReferences: topicShiftResult.isNewTopic ? {} : conversation.lastReferences, // Clear references on topic shift
      userPreferences,
      conversationContext: conversationContextText
    });

    console.log(`[ChatV3] Intent: ${intentResult.intentType} (${intentResult.confidence})`);

    // 6. HANDLE BASED ON INTENT TYPE
    let reply = '';
    let action = null;
    let structuredResponse = null;
    let pendingItems = [];
    
    // Build sources from resolved context with priority
    let sources = [];
    for (const item of resolvedContext.primary) {
      sources.push(...(item.data || []).slice(0, 3).map(d => ({
        source: item.source,
        text: typeof d === 'string' ? d : (d.title || d.subject || d.text || JSON.stringify(d)),
        date: d.start || d.date || new Date().toISOString(),
        isFresh: true
      })));
    }
    sources = sources.concat(knowledgeContext.slice(0, 3));

    // ============================================
    // TYPE 1: INFORMATION REQUEST
    // ============================================
    if (intentResult.intentType === 'information') {
      // Determine if we need to fetch real data
      const needsEmailData = message.toLowerCase().match(/email|mail|inbox|message from|wrote|sent/);
      const needsCalendarData = message.toLowerCase().match(/calendar|meeting|schedule|event|appointment/);

      if (needsEmailData) {
        // Extract sender name from intent or parse from message
        let senderFilter = intentResult.actionDetails?.senderName || intentResult.actionDetails?.recipient;
        
        // Also try to extract sender from message patterns like "email from X" or "mail of X"
        if (!senderFilter) {
          const senderMatch = message.match(/(?:email|mail|message)s?\s+(?:from|of|by)\s+([\w\s]+?)(?:\s|$|\?)/i);
          if (senderMatch) {
            senderFilter = senderMatch[1].trim();
          }
        }
        
        console.log(`[ChatV3] Email sender filter: ${senderFilter || 'none'}`);
        
        const emailResult = await fetchEmails(userId, {
          from: senderFilter,
          keywords: intentResult.contextQuery?.split(' ').filter(w => w.length > 3),
          limit: senderFilter ? 3 : 5  // Fewer results when filtering by sender
        });

        if (emailResult.success && emailResult.emails.length > 0) {
          // Update last reference to the first email found
          await conversation.updateReferences('email', emailResult.emails[0]);
          
          // Add email context to knowledge context
          const emailContext = emailResult.emails.map(e => ({
            source: 'gmail',
            text: `Email from ${e.from}: "${e.subject}" - ${e.snippet}`,
            date: e.dateFormatted
          }));
          sources = [...emailContext, ...sources].slice(0, 5);

          // Construct Slashy-style widget for email list
          structuredResponse = {
            ui_component: {
              type: 'email_list',
              status: 'complete',
              title: 'Email List',
              data: {
                emails: emailResult.emails.map(e => ({
                  id: e.id,
                  from: e.from,
                  subject: e.subject,
                  date: e.dateFormatted || new Date(e.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                  snippet: e.snippet,
                  isUrgent: (e.subject + e.snippet).toLowerCase().match(/urgent|alert|security|important|immediate/) ? true : false,
                  deep_link: `https://mail.google.com/mail/u/0/#inbox/${e.id}`,
                  is_read: !e.isUnread
                }))
              },
              actions: []
            }
          };
        }
      }

      if (needsCalendarData) {
        // Detect date range from user message
        const msgLower = message.toLowerCase();
        const isPastQuery = msgLower.includes('past') || msgLower.includes('had') || msgLower.includes('did i have');
        
        if (isPastQuery) {
          console.log('[ChatV3] Detected past meeting query. Fetching from DB.');
          const attendeeMatch = msgLower.match(/(?:with|from|by)\s+([\w\s]+)/);
          const attendeeName = attendeeMatch ? attendeeMatch[1].trim() : null;

          const pastMeetingsResult = await fetchPastMeetings(userId, { attendee: attendeeName });

          if (pastMeetingsResult.success && pastMeetingsResult.events.length > 0) {
            console.log(`[ChatV3] Found ${pastMeetingsResult.events.length} past meetings from DB.`);
            const dbContext = pastMeetingsResult.events.map(e => ({
              source: 'hicapy_db',
              text: `Past Meeting: "${e.title}" on ${new Date(e.start).toLocaleDateString()}`,
              date: e.start
            }));
            sources = [...dbContext, ...sources];
            reply = `I found ${pastMeetingsResult.events.length} past meeting(s) in the database related to your query.`;
          } else {
            console.log('[ChatV3] No past meetings found in DB for query.');
            reply = "I couldn't find any past meetings in the database that match your query.";
          }
        } else {
          // Detect date range from user message
          let dateRange = 'this_week';
          if (msgLower.includes('today') || msgLower.includes('today\'s')) {
            dateRange = 'today';
          } else if (msgLower.includes('tomorrow')) {
            dateRange = 'tomorrow';
          } else if (intentResult.actionDetails?.time?.includes('today')) {
            dateRange = 'today';
          } else if (intentResult.actionDetails?.time?.includes('tomorrow')) {
            dateRange = 'tomorrow';
          }
          
          console.log(`[ChatV3] Fetching calendar events for dateRange: ${dateRange}`);
          const calResult = await fetchCalendarEvents(userId, { dateRange });
          console.log(`[ChatV3] Calendar result: ${calResult.success ? calResult.events?.length + ' events' : 'failed - ' + calResult.error}`);

          if (calResult.success) {
            if (calResult.events.length > 0) {
              console.log(`[ChatV3] Events found:`, calResult.events.map(e => `"${e.title}" @ ${e.start}`));
              await conversation.updateReferences('meeting', calResult.events[0]);
            
              const calContext = calResult.events.map(e => ({
                source: 'google_calendar',
                text: `Meeting: "${e.title}" on ${new Date(e.start).toLocaleDateString()} at ${new Date(e.start).toLocaleTimeString()}`,
                date: e.start
              }));
              sources = [...calContext, ...sources].slice(0, 5);
            } else {
              console.log(`[ChatV3] No events found for ${dateRange}`);
              // Add explicit "no meetings" context so LLM knows
              sources.unshift({
                source: 'google_calendar',
                text: `No meetings scheduled for ${dateRange === 'today' ? 'today' : dateRange === 'tomorrow' ? 'tomorrow' : 'this week'}`,
                date: new Date().toISOString()
              });
            }
          }
        }
      }

      // Generate informational response
      // If we have a structured widget, use a brief fixed response to save LLM tokens
      if (structuredResponse && structuredResponse.ui_component?.type === 'email_list') {
        const emailCount = structuredResponse.ui_component.data?.emails?.length || 0;
        const senderFilter = intentResult.actionDetails?.senderName || intentResult.actionDetails?.recipient;
        
        if (senderFilter) {
          reply = emailCount === 0
            ? `I couldn't find any emails from ${senderFilter}.`
            : emailCount === 1
              ? `Here's the email from ${senderFilter}.`
              : `Here are ${emailCount} emails from ${senderFilter}.`;
        } else {
          reply = emailCount === 1 
            ? "Here's your latest email."
            : `Here are your latest ${emailCount} emails.`;
        }
      } else if (structuredResponse && structuredResponse.ui_component?.type === 'calendar_list') {
        const eventCount = structuredResponse.ui_component.data?.events?.length || 0;
        reply = eventCount === 0
          ? "You have no upcoming events."
          : `Here are your upcoming ${eventCount} events.`;
      } else {
        reply = await aiService.generateChatResponse({
          query: message,
          context: sources,
          history: conversationHistory,
          userPreferences,
          intentType: 'information',
          lastReferences: conversation.lastReferences,
          hasWidget: !!structuredResponse
        });
      }
    }

    // ============================================
    // TYPE 2: ACTION COMMAND
    // ============================================
    else if (intentResult.intentType === 'action') {
      const actionDetails = intentResult.actionDetails || {};
      
      // Resolve pronouns from context
      let resolvedRecipient = actionDetails.recipient;
      let resolvedSubject = actionDetails.subject;
      
      if (intentResult.pronounResolution) {
        if (!resolvedRecipient && intentResult.pronounResolution['her/him']) {
          resolvedRecipient = intentResult.pronounResolution['her/him'];
        }
        if (!resolvedRecipient && conversation.lastReferences?.person) {
          resolvedRecipient = conversation.lastReferences.person.email || conversation.lastReferences.person.name;
        }
        if (!resolvedSubject && conversation.lastReferences?.email) {
          resolvedSubject = `Re: ${conversation.lastReferences.email.subject}`;
        }
      }

      // Check for missing required parameters
      if (actionDetails.missingParams?.length > 0 && !resolvedRecipient) {
        // Ask for missing info (exploratory response)
        reply = await aiService.generateChatResponse({
          query: message,
          context: sources,
          history: conversationHistory,
          userPreferences,
          intentType: 'exploratory',
          lastReferences: conversation.lastReferences
        });
      } else {
        // Generate the action draft
        let draft = null;
        let actionType = actionDetails.type;

        if (actionType === 'send_email' || actionType === 'draft_reply') {
          draft = await aiService.generateEmailDraft({
            request: message,
            context: sources,
            emailThread: conversation.lastReferences?.email ? 
              `Replying to: "${conversation.lastReferences.email.subject}" from ${conversation.lastReferences.email.from}` : null,
            userPreferences,
            recipientInfo: { relationship: 'colleague' }
          });
          
          if (draft) {
            draft.to = draft.to || [resolvedRecipient];
            draft.subject = draft.subject || resolvedSubject || 'No Subject';
          }
        } else if (actionType === 'schedule_meeting' || actionType === 'reschedule_meeting') {
          draft = await aiService.generateMeetingDetails({
            request: message,
            context: sources,
            userPreferences,
            attendeeContext: resolvedRecipient ? `Attendee: ${resolvedRecipient}` : null
          });
        } else if (actionType === 'cancel_meeting') {
          // Find the meeting to cancel
          const meetingToCancel = sources.find(s => s.source === 'google_calendar' || s.source === 'meeting');
          
          if (meetingToCancel) {
            draft = {
              title: meetingToCancel.text.replace('Meeting: ', '').split(' on ')[0].replace(/"/g, ''),
              startTime: meetingToCancel.date,
              eventId: meetingToCancel.id, // Assuming source has ID
              type: 'cancel_meeting',
              reasoning: `Cancelling meeting "${meetingToCancel.text}" as requested.`
            };
          } else {
            // Try to find by keyword search if not in context
            const calResult = await fetchCalendarEvents(userId, { dateRange: 'this_week' });
            if (calResult.success) {
              // Simple fuzzy match
              const keywords = message.toLowerCase().split(' ').filter(w => w.length > 3 && !['cancel', 'meeting', 'remove', 'delete'].includes(w));
              const match = calResult.events.find(e => keywords.some(k => e.title.toLowerCase().includes(k)));
              
              if (match) {
                draft = {
                  title: match.title,
                  startTime: match.start,
                  eventId: match.id,
                  type: 'cancel_meeting',
                  reasoning: `Found meeting "${match.title}" matching your request.`
                };
              }
            }
          }
        }
        // ============================================
        // BOT ASSIGNMENT ACTIONS
        // ============================================
        else if (actionType === 'assign_bot' || actionType === 'start_meeting_with_bot') {
          // Get user's bots
          const bots = await getUserBots(userId);
          console.log(`[ChatV3] Found ${bots.length} bots for user`);
          
          if (bots.length === 0) {
            reply = `You don't have any bots set up yet. Would you like me to help you create one? Go to the Bots section to enable and create your first bot.`;
          } else {
            // Find matching meeting
            const calResult = await fetchCalendarEvents(userId, { dateRange: 'this_week' });
            const keywords = message.toLowerCase().split(' ').filter(w => w.length > 3);
            const matchedMeeting = calResult.events?.find(e => 
              keywords.some(k => e.title.toLowerCase().includes(k))
            );
            
            // Convert ObjectIds to strings for frontend
            const availableBots = bots.map(b => ({ 
              id: b._id.toString(), 
              name: b.name 
            }));
            console.log(`[ChatV3] Available bots:`, availableBots);
            
            draft = {
              type: actionType,
              botId: bots[0]._id.toString(),
              botName: bots[0].name,
              meetingId: matchedMeeting?.id,
              meetingTitle: matchedMeeting?.title || 'Your next meeting',
              startTime: matchedMeeting?.start,
              endTime: matchedMeeting?.end,
              meetLink: matchedMeeting?.meetLink,
              availableBots: availableBots,
              reasoning: matchedMeeting 
                ? `I'll assign ${bots[0].name} to join "${matchedMeeting.title}".`
                : `Select a bot to assign to your meeting.`
            };
          }
        }
        // ============================================
        // TASK QUERY & ASSIGNMENT ACTIONS
        // ============================================
        else if (actionType === 'query_tasks' || actionType === 'list_meeting_tasks') {
          // Extract meeting name from message
          const meetingMatch = message.match(/(?:from|for|of|in)\s+(?:the\s+)?(.+?)(?:\s+meeting|\s+call|\s+vc|\?|$)/i);
          const meetingName = meetingMatch?.[1] || message.replace(/what|tasks|todo|list|from|the|meeting/gi, '').trim();
          
          const tasksResult = await getMeetingTasks(userId, meetingName);
          
          if (tasksResult.success && tasksResult.tasks.length > 0) {
            // Store in context for follow-up assignment
            conversation.lastReferences = conversation.lastReferences || {};
            conversation.lastReferences.tasks = tasksResult.tasks;
            conversation.lastReferences.meeting = tasksResult.meeting;
            await conversation.save();
            
            const taskList = tasksResult.tasks.map((t, i) => 
              `${i + 1}. ${t.description} [${t.status}]${t.assignees?.length > 0 ? ` - Assigned to: ${t.assignees.map(a => a.name).join(', ')}` : ''}`
            ).join('\n');
            
            reply = `Here are the tasks from **${tasksResult.meeting.title}**:\n\n${taskList}\n\nWould you like me to assign any of these to a teammate?`;
          } else {
            reply = `I couldn't find tasks for that meeting. ${tasksResult.meetings?.length > 0 ? `Recent meetings: ${tasksResult.meetings.slice(0, 3).join(', ')}` : 'No recent meetings found.'}`;
          }
        }
        else if (actionType === 'assign_task') {
          // Get all teammates for selection
          const allTeammates = await findTeammates(userId);
          
          // Get tasks from lastReferences OR from conversation context extraction
          let tasksToAssign = conversation.lastReferences?.tasks || [];
          
          // If no tasks in lastReferences, try to find specific task from message
          if (tasksToAssign.length === 0) {
            // Check if user mentioned a specific task like "follow up task"
            const taskHintMatch = message.match(/(?:the\s+)?(.+?)\s+task/i);
            if (taskHintMatch) {
              const taskHint = taskHintMatch[1].toLowerCase();
              // Search recent messages for matching task
              const recentMessages = conversation.messages?.slice(-10) || [];
              for (const msg of recentMessages) {
                const content = msg.content || '';
                // Look for numbered tasks that match the hint
                const taskMatches = content.match(/\d+\.\s*([^\n:]+)/g) || [];
                for (const taskLine of taskMatches) {
                  if (taskLine.toLowerCase().includes(taskHint)) {
                    const taskDesc = taskLine.replace(/^\d+\.\s*/, '').trim();
                    tasksToAssign = [{
                      id: `msg-task-${Date.now()}`,
                      description: taskDesc,
                      status: 'pending',
                      source: 'conversation'
                    }];
                    break;
                  }
                }
                if (tasksToAssign.length > 0) break;
              }
            }
          }
          
          console.log(`[ChatV3] Tasks to assign: ${tasksToAssign.length}`, tasksToAssign.map(t => t.description));
          
          if (tasksToAssign.length > 0) {
            // Get teammate hint from message
            const teammateMatch = message.match(/assign\s+(?:it\s+)?(?:the\s+)?(?:.+?\s+)?(?:task\s+)?to\s+(.+?)(?:\s|$)/i);
            const teammateName = teammateMatch?.[1] || actionDetails.recipient;
            
            // Find specific teammate if mentioned
            let selectedTeammate = null;
            if (teammateName && teammateName !== 'my' && teammateName !== 'teammates') {
              const matchedTeammates = await findTeammates(userId, teammateName);
              selectedTeammate = matchedTeammates[0] || null;
            }
            
            if (allTeammates.length === 0) {
              // No teammates - offer to send invite
              draft = {
                type: 'send_team_invite',
                inviteEmail: teammateName?.includes('@') ? teammateName : null,
                inviteName: teammateName,
                reasoning: `You don't have any teammates yet. Would you like to invite someone to your team?`
              };
            } else {
              // Store tasks in conversation for future reference
              conversation.lastReferences = conversation.lastReferences || {};
              conversation.lastReferences.tasks = tasksToAssign;
              await conversation.save();
              
              draft = {
                type: 'assign_task',
                taskId: tasksToAssign[0].id,
                taskDescription: tasksToAssign[0].description,
                allTasks: tasksToAssign.map(t => ({ id: t.id, description: t.description })),
                teammateId: selectedTeammate?._id?.toString() || null,
                teammateName: selectedTeammate?.username || null,
                teammateEmail: selectedTeammate?.email || null,
                availableTeammates: allTeammates.map(t => ({
                  id: t._id.toString(),
                  name: t.username,
                  email: t.email
                })),
                reasoning: selectedTeammate 
                  ? `I'll assign "${tasksToAssign[0].description}" to ${selectedTeammate.username}.`
                  : `Select a teammate to assign "${tasksToAssign[0].description}".`
              };
            }
          } else {
            // Still no tasks - try to be more helpful
            reply = `I couldn't find a specific task to assign. Here's what you can do:\n\n1. Ask me "What are my unassigned tasks?" to see pending tasks\n2. Or specify which task you mean, like "Assign the follow up with Shastra task to John"`;
          }
        }
        // ============================================
        // KNOWLEDGE GRAPH QUERIES
        // ============================================
        else if (actionType === 'query_knowledge') {
          // Extract topic from message
          const topic = actionDetails.knowledgeTopic || 
            message.replace(/what's|what|is|the|latest|update|on|about|any|news|tell|me/gi, '').trim();
          
          if (topic) {
            // Get latest nodes from knowledge graph for this topic
            const updates = await knowledgeGraphService.getLatestUpdates(userId, topic, 5);
            
            if (updates && updates.nodes && updates.nodes.length > 0) {
              // Format the knowledge graph nodes
              const updatesList = updates.nodes.map((node, i) => {
                const date = new Date(node.date).toLocaleDateString();
                let content = '';
                
                if (node.type === 'meeting') {
                  content = `📅 **Meeting:** ${node.title} (${date})`;
                } else if (node.type === 'email') {
                  content = `📧 **Email:** ${node.title} (${date})`;
                } else if (node.type === 'task') {
                  content = `✓ **Task:** ${node.title} (${date})`;
                } else if (node.type === 'document') {
                  content = `📄 **Document:** ${node.title} (${date})`;
                } else {
                  content = `📌 ${node.title} (${date})`;
                }
                
                if (node.summary && node.summary !== node.title) {
                  content += `\n   ${node.summary.substring(0, 100)}${node.summary.length > 100 ? '...' : ''}`;
                }
                
                return content;
              }).join('\n\n');
              
              const topicDisplay = updates.topic || topic;
              reply = `Here are the latest updates on **"${topicDisplay}"**:\n\n${updatesList}\n\nWould you like me to go deeper into any of these, or find related items?`;
              
              // Store in context for follow-up
              conversation.lastReferences = conversation.lastReferences || {};
              conversation.lastReferences.knowledgeTopic = topic;
              conversation.lastReferences.knowledgeNodes = updates.nodes.map(n => ({ refId: n.refId, title: n.title, type: n.type }));
              await conversation.save();
            } else {
              reply = `I couldn't find any updates on "${topic}" in your knowledge graph. This could mean:\n- There are no meetings, emails, or tasks related to this topic yet\n- The topic might be named differently\n\nTry asking about a specific meeting name or check your recent meetings.`;
            }
          } else {
            reply = `What topic would you like updates on? You can ask things like "What's the latest on Project X?" or "Any updates about the investor meeting?"`;
          }
        }

        if (draft) {
          // Check if high-stakes
          const highStakes = isHighStakesAction(actionType, { 
            ...draft, 
            userEmail: user?.email 
          });

          // Create pending action in database
          action = await Action.create({
            userId,
            type: actionType,
            source: 'chat',
            status: 'pending',
            payload: {
              ...draft,
              recipients: draft.to,
              originalRequest: message
            },
            context: {
              sources: sources.slice(0, 3),
              reasoning: draft.reasoning || intentResult.reasoning
            }
          });

          // Update conversation with pending action - use set() to ensure proper casting
          conversation.set('pendingAction', {
            actionId: action._id,
            type: actionType,
            createdAt: new Date()
          });

          // Generate structured UI response (NEW)
          structuredResponse = await aiService.generateStructuredResponse({
            actionType,
            draft: { ...draft, _id: action._id },
            context: sources,
            userRequest: message,
            isHighStakes: highStakes.isHighStakes,
            pendingItems: pendingItems
          });
          
          reply = structuredResponse.text;
        } else {
          // Failed to generate draft, ask for clarification
          reply = `I understood you want to ${actionType?.replace('_', ' ')}, but I need a bit more information. Could you provide more details about what you'd like me to do?`;
        }
      }
    }

    // ============================================
    // TYPE 3: EXPLORATORY CONVERSATION
    // ============================================
    else {
      // Engage conversationally, don't prepare actions
      reply = await aiService.generateChatResponse({
        query: message,
        context: sources,
        history: conversationHistory,
        userPreferences,
        intentType: 'exploratory',
        lastReferences: conversation.lastReferences
      });
    }

    // 7. SAVE MESSAGE TO CONVERSATION
    await conversation.addMessage('user', message, {
      intent: {
        type: intentResult.intentType,
        confidence: intentResult.confidence
      },
      topicShift: topicShiftResult.isNewTopic ? topicShiftResult : null
    });
    
    await conversation.addMessage('assistant', reply, {
      intent: { type: intentResult.intentType },
      contextUsed: sources,
      actionId: action?._id,
      ui_component: structuredResponse?.ui_component || null
    });

    // 8. RETURN RESPONSE WITH STRUCTURED UI (NEW)
    res.json({
      reply,
      sources: sources.map(s => ({ text: s.text, source: s.source, date: s.date, isFresh: s.isFresh })),
      action: action ? {
        id: action._id,
        type: action.type,
        payload: action.payload,
        status: action.status,
        isHighStakes: action.payload?.isHighStakes
      } : null,
      // NEW: Structured UI component
      ui_component: structuredResponse?.ui_component || null,
      // NEW: Pending items for floating task list
      pending_items: structuredResponse?.pending_items || pendingItems,
      // NEW: Topic shift info
      topicShift: topicShiftResult.isNewTopic ? {
        detected: true,
        previousTopic: topicShiftResult.previousTopic,
        currentTopic: topicShiftResult.currentTopic
      } : null,
      conversationId: conversation._id,
      intent: {
        type: intentResult.intentType,
        confidence: intentResult.confidence
      }
    });

  } catch (error) {
    console.error('[ChatV3] Error:', error);
    res.status(500).json({ 
      error: 'Failed to process chat',
      message: error.message 
    });
  }
};

// ============================================
// APPROVE ACTION ENDPOINT
// ============================================
exports.approveAction = async (req, res) => {
  try {
    const { actionId } = req.params;
    const userId = req.user.id;

    if (!actionId || actionId === 'undefined' || actionId === 'null') {
      return res.status(400).json({ error: 'Invalid action ID' });
    }

    const action = await Action.findOne({ _id: actionId, userId });
    
    if (!action) {
      return res.status(404).json({ error: 'Action not found' });
    }

    if (action.status !== 'pending') {
      return res.status(400).json({ error: `Action is already ${action.status}` });
    }

    // Execute the action based on type
    let result = null;
    
    if (action.type === 'send_email' || action.type === 'draft_reply') {
      result = await executeEmailAction(userId, action.payload);
    } else if (action.type === 'schedule_meeting') {
      // Placeholder for scheduling logic
      result = { success: true, message: 'Meeting scheduling not yet implemented.' };
    }

    // Update action status
    action.status = 'approved';
    action.executedAt = new Date();
    await action.save();

    // Remove from user's pending actions
    await User.findByIdAndUpdate(userId, 
      { $pull: { pendingActions: actionId } }
    );

    res.json({
      success: true,
      message: result?.message || 'Action completed successfully',
      result
    });

  } catch (error) {
    console.error('[ChatV3] Approve action error:', error);
    res.status(500).json({ error: 'Failed to approve action' });
  }
};

// ============================================
// EDIT ACTION ENDPOINT
// ============================================
exports.editAction = async (req, res) => {
  try {
    const { actionId } = req.params;
    const { edits } = req.body;
    const userId = req.user.id;

    const action = await Action.findOne({ _id: actionId, userId });
    
    if (!action) {
      return res.status(404).json({ error: 'Action not found' });
    }

    if (action.status !== 'pending') {
      return res.status(400).json({ error: `Action is already ${action.status}` });
    }

    // Store original for learning
    const originalPayload = { ...action.payload };

    // Apply edits
    action.payload = { ...action.payload, ...edits };
    action.userFeedback = {
      edited: true,
      editedContent: JSON.stringify(edits)
    };
    await action.save();

    // Learn from the edit
    const learning = await aiService.extractLearning({
      original: JSON.stringify(originalPayload),
      edited: JSON.stringify(action.payload),
      context: action.type
    });

    // Store learned preferences
    if (learning.learnings?.length > 0) {
      for (const l of learning.learnings) {
        await mem0Service.learnPreference(userId, `${l.key}: ${l.value}`, l.key);
      }
    }

    res.json({
      success: true,
      action: {
        id: action._id,
        type: action.type,
        payload: action.payload,
        status: action.status
      },
      learning: learning.acknowledgment
    });

  } catch (error) {
    console.error('[ChatV3] Edit action error:', error);
    res.status(500).json({ error: 'Failed to edit action' });
  }
};

// ============================================
// REJECT ACTION ENDPOINT
// ============================================
exports.rejectAction = async (req, res) => {
  try {
    const { actionId } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;

    const action = await Action.findOne({ _id: actionId, userId });
    
    if (!action) {
      return res.status(404).json({ error: 'Action not found' });
    }

    action.status = 'rejected';
    action.resolvedAt = new Date();
    action.userFeedback = {
      edited: false,
      rejectionReason: reason
    };
    await action.save();

    // Clear pending action from conversation
    await Conversation.updateOne(
      { 'pendingAction.actionId': actionId },
      { $unset: { pendingAction: 1 } }
    );

    // Learn from rejection if reason provided
    if (reason) {
      await mem0Service.learnPreference(
        userId, 
        `User rejected ${action.type} because: ${reason}`,
        `rejection_${action.type}`
      );
    }

    res.json({
      success: true,
      message: 'Action cancelled'
    });

  } catch (error) {
    console.error('[ChatV3] Reject action error:', error);
    res.status(500).json({ error: 'Failed to reject action' });
  }
};

// ============================================
// GET CONVERSATION HISTORY
// ============================================
exports.getConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    const conversation = conversationId 
      ? await Conversation.findOne({ _id: conversationId, userId })
      : await Conversation.getOrCreateActive(userId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    res.json({
      id: conversation._id,
      messages: conversation.messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        intent: m.intent
      })),
      lastReferences: conversation.lastReferences,
      pendingAction: conversation.pendingAction
    });

  } catch (error) {
    console.error('[ChatV3] Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
};

// ============================================
// CLEAR CONVERSATION
// ============================================
exports.clearConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const userId = req.user.id;

    if (conversationId) {
      await Conversation.updateOne(
        { _id: conversationId, userId },
        { status: 'archived' }
      );
    } else {
      await Conversation.updateMany(
        { userId, status: 'active' },
        { status: 'archived' }
      );
    }

    res.json({ success: true, message: 'Conversation cleared' });

  } catch (error) {
    console.error('[ChatV3] Clear conversation error:', error);
    res.status(500).json({ error: 'Failed to clear conversation' });
  }
};

// ============================================
// HELPER: Execute Email Action
// ============================================
const executeEmailAction = async (userId, payload) => {
  try {
    const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
    if (!accessToken && !refreshToken) {
      return { success: false, error: 'Gmail not connected' };
    }

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    
    const gmail = google.gmail({ version: 'v1', auth });

    // Build email
    const to = payload.recipients?.join(', ') || payload.to?.join(', ');
    const subject = payload.subject;
    const body = payload.body;

    const email = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].join('\n');

    const encodedEmail = Buffer.from(email)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
        threadId: payload.threadId
      }
    });

    return { 
      success: true, 
      messageId: result.data.id,
      message: `Email sent to ${to}` 
    };

  } catch (error) {
    console.error('[ChatV3] Email execution error:', error);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Execute Meeting Action
// ============================================
const executeMeetingAction = async (userId, payload) => {
  try {
    const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
    if (!accessToken && !refreshToken) {
      return { success: false, error: 'Calendar not connected' };
    }

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    
    const calendar = google.calendar({ version: 'v3', auth });

    // Handle Cancellation
    if (payload.eventId && payload.type === 'cancel_meeting') {
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: payload.eventId,
        sendUpdates: 'all'
      });
      return { success: true, message: `Meeting "${payload.title}" has been cancelled.` };
    }

    const event = {
      summary: payload.title,
      description: payload.description,
      start: {
        dateTime: payload.startTime,
        timeZone: 'UTC'
      },
      end: {
        dateTime: payload.endTime || new Date(new Date(payload.startTime).getTime() + 60*60*1000).toISOString(),
        timeZone: 'UTC'
      },
      attendees: payload.attendees?.map(email => ({ email })) || [],
      conferenceData: {
        createRequest: {
          requestId: `hicapy-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    };

    const result = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all'
    });

    return { 
      success: true, 
      eventId: result.data.id,
      meetLink: result.data.hangoutLink,
      message: `Meeting "${payload.title}" scheduled successfully` 
    };

  } catch (error) {
    console.error('[ChatV3] Meeting execution error:', error);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Execute Bot Assignment Action
// ============================================
const executeBotAssignmentAction = async (userId, payload) => {
  try {
    const { meetingId, botId, meetingTitle, botName, isInstant, startTime, endTime, meetLink } = payload;
    const { ulid } = require('ulid');
    
    // Get Bot details
    const bot = await Bot.findOne({ _id: botId, user_id: userId });
    if (!bot) return { success: false, error: 'Bot not found' };

    if (isInstant) {
      // For instant meetings, create a new meeting with the bot
      const meeting = new Meeting({
        meeting_id: ulid(),
        meeting_title: meetingTitle || 'Instant Meeting',
        user_id: userId,
        assigned_bot_id: bot._id,
        assigned_bot_service_id: bot.bot_service_bot_id,
        status: 'scheduled',
        start_time: new Date(),
        meetlink: meetLink || `https://meet.google.com/new`, // Fallback if not provided
        bot_config: {
          enable_recording: true,
          enable_transcript: true,
          auto_join: true
        }
      });
      await meeting.save();
      
      // Index in knowledge graph
      try {
        await knowledgeGraphService.indexMeeting(userId, {
          meeting_id: meeting.meeting_id,
          title: meeting.meeting_title,
          start_time: meeting.start_time,
          attendees: []
        });
      } catch (kgErr) {
        console.log('[ChatV3] KG index skipped:', kgErr.message);
      }
      
      return {
        success: true,
        meetingId: meeting._id,
        message: `Started instant meeting "${meeting.meeting_title}" with bot ${botName || 'HiCapy Bot'}. The bot will capture notes and transcripts.`
      };
    } else {
      // Assign bot to existing meeting (from Calendar)
      
      if (!meetLink) {
        return { success: false, error: 'No meeting link found for this event. Please add a Google Meet link first.' };
      }

      // Find or Create Meeting by calendar_event_id
      // meetingId here is the Google Event ID
      let meeting = await Meeting.findOne({ 
        user_id: userId,
        calendar_event_id: meetingId 
      });

      if (!meeting) {
        // Create new meeting record
        meeting = new Meeting({
          meeting_id: ulid(),
          user_id: userId,
          calendar_event_id: meetingId,
          meeting_title: meetingTitle,
          start_time: startTime,
          end_time: endTime,
          meetlink: meetLink,
          status: 'scheduled'
        });
      }

      // Update bot assignment
      meeting.assigned_bot_id = bot._id;
      meeting.assigned_bot_service_id = bot.bot_service_bot_id;
      meeting.bot_config = {
        enable_recording: true,
        enable_transcript: true,
        enable_speak: false,
        auto_join: true // Auto-join by default for assigned meetings
      };
      
      await meeting.save();
      
      // Index in knowledge graph
      try {
        await knowledgeGraphService.indexMeeting(userId, {
          meeting_id: meeting.meeting_id,
          title: meeting.meeting_title,
          start_time: meeting.start_time,
          attendees: []
        });
      } catch (kgErr) {
        console.log('[ChatV3] KG index skipped:', kgErr.message);
      }
      
      return {
        success: true,
        meetingId: meeting._id,
        message: `Bot ${botName || 'HiCapy Bot'} assigned to meeting "${meeting.meeting_title}". It will join automatically.`
      };
    }
  } catch (error) {
    console.error('[ChatV3] Bot assignment error:', error);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Execute Task Assignment Action
// ============================================
const executeTaskAssignmentAction = async (userId, payload) => {
  try {
    const { taskId, taskDescription, assigneeId, assigneeName, meetingId } = payload;
    
    // Get assignee details for proper structure
    const assignee = await User.findById(assigneeId);
    const assigneeObj = {
      user_id: assigneeId,
      name: assigneeName || assignee?.username || 'Unknown',
      avatar: assignee?.avatar || ''
    };
    
    if (taskId) {
      // Assign existing task - check by task_id field (ULID string)
      const task = await Task.findOneAndUpdate(
        { task_id: taskId },
        { 
          $addToSet: { assignees: assigneeObj },
          status: 'in_progress'
        },
        { new: true }
      );
      
      if (!task) {
        return { success: false, error: 'Task not found' };
      }
      
      // Also link to knowledge graph
      try {
        await knowledgeGraphService.linkTaskToMeeting(userId, {
          task_id: task.task_id,
          description: task.description,
          meeting_id: task.meeting_id,
          assignees: task.assignees,
          createdAt: task.createdAt
        });
      } catch (kgErr) {
        console.log('[ChatV3] Task KG link skipped:', kgErr.message);
      }
      
      return {
        success: true,
        taskId: task.task_id,
        message: `Task "${task.description}" has been assigned to ${assigneeName}.`
      };
    } else {
      // Create new task - this shouldn't normally happen from chat
      // as tasks come from meeting transcripts
      return {
        success: false,
        error: 'Creating new tasks from chat is not yet supported. Tasks are generated from meeting transcripts.'
      };
    }
  } catch (error) {
    console.error('[ChatV3] Task assignment error:', error);
    return { success: false, error: error.message };
  }
};

// ============================================
// HELPER: Execute Team Invite Action
// ============================================
const executeTeamInviteAction = async (userId, payload) => {
  try {
    const { email, name } = payload;
    const user = await User.findById(userId);
    
    // Use Gmail to send invite
    const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
    if (!accessToken && !refreshToken) {
      return { success: false, error: 'Gmail not connected' };
    }

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    
    const gmail = google.gmail({ version: 'v1', auth });
    
    const inviteBody = `Hi ${name || 'there'},

${user?.username || 'Your colleague'} has invited you to join their HiCapy workspace!

HiCapy is an AI-powered assistant that helps teams manage meetings, tasks, and emails more effectively.

Click the link below to join:
${process.env.FRONTEND_URL || 'https://hicapy.com'}/invite?from=${encodeURIComponent(user?.email || '')}&team=${encodeURIComponent(user?.team || '')}

Best,
The HiCapy Team`;

    const emailContent = [
      `To: ${email}`,
      `Subject: ${user?.username || 'Your colleague'} invited you to HiCapy`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      inviteBody
    ].join('\n');

    const encodedEmail = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedEmail }
    });

    return {
      success: true,
      message: `Invitation sent to ${name || email}. They'll receive an email to join your HiCapy workspace.`
    };
  } catch (error) {
    console.error('[ChatV3] Team invite error:', error);
    return { success: false, error: error.message };
  }
};

// ============================================
// DAILY BRIEFING ENDPOINT
// ============================================
exports.getDailyBriefing = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    // Get pending actions
    const pendingActions = await Action.find({ 
      userId, 
      status: 'pending' 
    }).sort({ createdAt: -1 }).limit(5);

    // Get today's calendar events
    const calResult = await fetchCalendarEvents(userId, { dateRange: 'today' });
    const meetings = calResult.success ? calResult.events.map(e => ({
      title: e.title,
      time: new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      attendees: e.attendees?.map(a => a.email).join(', ') || ''
    })) : [];

    // Get recent emails needing response
    const emailResult = await fetchEmails(userId, { unreadOnly: true, limit: 5 });
    const emails = emailResult.success ? emailResult.emails.map(e => ({
      from: e.from,
      subject: e.subject
    })) : [];

    // Generate briefing
    const briefing = await aiService.generateBriefing({
      emails,
      meetings,
      pendingActions: pendingActions.map(a => ({ type: a.type, payload: a.payload })),
      userName: user?.username || user?.email?.split('@')[0]
   
    });

    res.json({
      briefing,
      stats: {
        meetingCount: meetings.length,
        pendingEmailCount: emails.length,
        pendingActionCount: pendingActions.length
      },
      meetings,
      pendingActions: pendingActions.slice(0, 3)
    });

  } catch (error) {
    console.error('[ChatV3] Briefing Error:', error);
    res.status(500).json({ error: 'Failed to generate briefing' });
  }
};

// ============================================
// HELPER: Fetch Past Meetings from DB
// ============================================
const fetchPastMeetings = async (userId, searchParams = {}) => {
  try {
    const query = { user_id: userId };

    if (searchParams.attendee) {
      const lowerAttendee = searchParams.attendee.toLowerCase();
      // This query will search for the attendee name in the meeting title, summary, or attendee list.
      query.$or = [
        { 'meeting_title': { $regex: searchParams.attendee, $options: 'i' } },
        { 'summary': { $regex: searchParams.attendee, $options: 'i' } },
        { 'attendees.name': { $regex: searchParams.attendee, $options: 'i' } },
        { 'attendees.email': { $regex: lowerAttendee, $options: 'i' } }
      ];
    }

    const meetings = await Meeting.find(query)
      .sort({ start_time: -1 })
      .limit(searchParams.limit || 10);

    const events = meetings.map(m => ({
      id: m.meeting_id,
      title: m.meeting_title,
      start: m.start_time,
      end: m.end_time,
      summary: m.summary,
      attendees: m.attendees || []
    }));

    return { success: true, events, count: events.length };
  } catch (error) {
    console.error('[ChatV3] Past meetings fetch error:', error.message);
    return { success: false, error: error.message };
  }
};
