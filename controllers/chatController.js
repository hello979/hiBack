// const mem0Service = require('../services/mem0Service');
// const aiService = require('../services/aiService');
// const integrationHelper = require('../utils/integrationHelper');
// const Action = require('../models/Action');
// const Groq = require('groq-sdk');
// const { google } = require('googleapis');
// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// // ============================================
// // SMART QUERY ANALYZER - Uses AI to understand any query
// // ============================================
// const analyzeQuery = async (message) => {
//   const prompt = `
// Analyze this user message and determine the user's intent and the parameters for their query. Your goal is to be a world-class query parser.

// Message: "${message}"

// Respond with ONLY a JSON object (no markdown). The JSON should be structured as follows:
// {
//   "category": "email" | "calendar" | "action" | "general",
//   "subIntent": "read" | "search" | "create" | "send" | "list",
//   "confidence": 0.0 to 1.0,
//   "searchParams": {
//     "from": "sender name or email if mentioned",
//     "to": "recipient if mentioned",
//     "subject": "subject keywords if mentioned",
//     "dateRange": "today" | "yesterday" | "this_week" | "last_week" | "specific_date" | null,
//     "specificDate": "YYYY-MM-DD if a specific date is mentioned",
//     "keywords": ["any", "search", "keywords"],
//     "unreadOnly": true/false,
//     "important": true/false,
//     "sortBy": "date_desc" | "date_asc" | "relevance",
//     "limit": 10
//   },
//   "actionParams": {
//     "type": "schedule_meeting" | "send_email" | null,
//     "title": "meeting title if scheduling",
//     "startTime": "time expression like 'tomorrow at 3pm'",
//     "recipients": ["email addresses"],
//     "subject": "email subject",
//     "body": "email body content"
//   }
// }

// RULES & EXAMPLES:
// 1.  **Temporal Queries**: For "last", "latest", "most recent", set "sortBy": "date_desc" and a small "limit" (e.g., 1 or 5). Do NOT include "last" or "latest" in keywords.
//     - "what was the last email" -> { "sortBy": "date_desc", "limit": 1, "keywords": [] }
//     - "show me the 5 most recent emails from Ivan" -> { "from": "Ivan", "sortBy": "date_desc", "limit": 5, "keywords": [] }

// 2.  **Keyword Filtering**: Remove generic words like "email", "mail", "message", "find", "search", "show me" from the "keywords" array.
//     - "search for emails about the project update" -> { "keywords": ["project", "update"] }
//     - "find messages from support" -> { "from": "support", "keywords": [] }

// 3.  **Parameter Combination**: Combine parameters intelligently.
//     - "unread emails from Netflix this week" -> { "from": "Netflix", "dateRange": "this_week", "unreadOnly": true }
//     - "did John email me yesterday about the invoice" -> { "from": "John", "dateRange": "yesterday", "keywords": ["invoice"] }

// 4.  **Default Values**: Default "sortBy" to "date_desc" for emails unless specified otherwise. Default "limit" to 10.

// Return valid JSON only.`;

//   try {
//     const completion = await groq.chat.completions.create({
//       messages: [{ role: 'user', content: prompt }],
//       model: 'llama-3.1-8b-instant',
//       temperature: 0.1,
//       max_tokens: 600
//     });
    
//     const content = completion.choices[0].message.content.trim();
//     const jsonMatch = content.match(/\{[\s\S]*\}/);
//     if (jsonMatch) {
//       const result = JSON.parse(jsonMatch[0]);
//       console.log('[Chat] Query analysis:', JSON.stringify(result, null, 2));
//       return result;
//     }
//     return { category: 'general', confidence: 0.5 };
//   } catch (error) {
//     console.error('[Chat] Query analysis error:', error);
//     return { category: 'general', confidence: 0.5 };
//   }
// };

// // ============================================
// // SMART EMAIL FETCHER - Builds Gmail query from AI params
// // ============================================
// const fetchEmails = async (userId, searchParams = {}) => {
//   try {
//     const { accessToken, refreshToken, provider } = await integrationHelper.getGoogleToken(userId);
    
//     if (!accessToken && !refreshToken) {
//       return { success: false, error: 'Gmail not connected' };
//     }
    
//     console.log(`[Chat] Fetching emails with params:`, searchParams);
    
//     const auth = new google.auth.OAuth2(
//       process.env.GOOGLE_CLIENT_ID,
//       process.env.GOOGLE_CLIENT_SECRET
//     );
//     auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    
//     const gmail = google.gmail({ version: 'v1', auth });
    
//     // Build Gmail search query from AI-extracted params
//     let query = 'in:inbox';
    
//     if (searchParams.from) {
//       query += ` from:${searchParams.from}`;
//     }
//     if (searchParams.to) {
//       query += ` to:${searchParams.to}`;
//     }
//     if (searchParams.subject) {
//       query += ` subject:${searchParams.subject}`;
//     }
//     if (searchParams.keywords?.length > 0) {
//       query += ` ${searchParams.keywords.join(' ')}`;
//     }
//     if (searchParams.unreadOnly) {
//       query += ' is:unread';
//     }
//     if (searchParams.important) {
//       query += ' is:important';
//     }
    
//     // Handle date ranges
//     const now = new Date();
//     if (searchParams.dateRange === 'today') {
//       const today = new Date(now);
//       today.setHours(0, 0, 0, 0);
//       query += ` after:${formatDateForGmail(today)}`;
//     } else if (searchParams.dateRange === 'yesterday') {
//       const yesterday = new Date(now);
//       yesterday.setDate(yesterday.getDate() - 1);
//       yesterday.setHours(0, 0, 0, 0);
//       const today = new Date(now);
//       today.setHours(0, 0, 0, 0);
//       query += ` after:${formatDateForGmail(yesterday)} before:${formatDateForGmail(today)}`;
//     } else if (searchParams.dateRange === 'this_week') {
//       const weekAgo = new Date(now);
//       weekAgo.setDate(weekAgo.getDate() - 7);
//       query += ` after:${formatDateForGmail(weekAgo)}`;
//     } else if (searchParams.dateRange === 'last_week') {
//       const twoWeeksAgo = new Date(now);
//       twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
//       const weekAgo = new Date(now);
//       weekAgo.setDate(weekAgo.getDate() - 7);
//       query += ` after:${formatDateForGmail(twoWeeksAgo)} before:${formatDateForGmail(weekAgo)}`;
//     } else if (searchParams.specificDate) {
//       const date = new Date(searchParams.specificDate);
//       const nextDay = new Date(date);
//       nextDay.setDate(nextDay.getDate() + 1);
//       query += ` after:${formatDateForGmail(date)} before:${formatDateForGmail(nextDay)}`;
//     }
    
//     console.log(`[Chat] Gmail query: ${query}`);
    
//     const listRes = await gmail.users.messages.list({
//       userId: 'me',
//       maxResults: searchParams.limit || 10,
//       q: query
//     });
    
//     if (!listRes.data.messages?.length) {
//       return { success: true, emails: [], count: 0, query };
//     }
    
//     // Fetch full details for each email
//     const emails = [];
//     for (const msgStub of listRes.data.messages.slice(0, 10)) {
//       try {
//         const msg = await gmail.users.messages.get({ 
//           userId: 'me', 
//           id: msgStub.id, 
//           format: 'full'
//         });
        
//         const headers = msg.data.payload.headers;
//         const fromHeader = headers.find(h => h.name === 'From')?.value || '';
//         const toHeader = headers.find(h => h.name === 'To')?.value || '';
//         const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
//         const dateHeader = headers.find(h => h.name === 'Date')?.value;
        
//         // Parse sender
//         const fromMatch = fromHeader.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+)>?$/);
//         const senderName = fromMatch?.[1]?.trim() || fromMatch?.[2]?.split('@')[0] || 'Unknown';
//         const senderEmail = fromMatch?.[2] || fromHeader;
        
//         // Get body preview
//         let bodyPreview = msg.data.snippet || '';
        
//         emails.push({
//           id: msg.data.id,
//           threadId: msg.data.threadId,
//           from: senderName,
//           fromEmail: senderEmail,
//           to: toHeader,
//           subject,
//           date: dateHeader ? new Date(dateHeader) : null,
//           dateFormatted: dateHeader ? new Date(dateHeader).toLocaleDateString('en-US', { 
//             weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
//           }) : 'Unknown',
//           snippet: bodyPreview.substring(0, 200),
//           isUnread: msg.data.labelIds?.includes('UNREAD'),
//           isImportant: msg.data.labelIds?.includes('IMPORTANT')
//         });
//       } catch (e) {
//         console.error(`[Chat] Error fetching email:`, e.message);
//       }
//     }
    
//     return { success: true, emails, count: emails.length, query };
    
//   } catch (error) {
//     console.error('[Chat] Email fetch error:', error.message);
//     return { success: false, error: error.message };
//   }
// };

// const formatDateForGmail = (date) => {
//   return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
// };

// // ============================================
// // SMART CALENDAR FETCHER
// // ============================================
// const fetchCalendarEvents = async (userId, searchParams = {}) => {
//   try {
//     const { accessToken, refreshToken, provider } = await integrationHelper.getGoogleToken(userId);
    
//     if (!accessToken && !refreshToken) {
//       return { success: false, error: 'Calendar not connected' };
//     }
    
//     const auth = new google.auth.OAuth2(
//       process.env.GOOGLE_CLIENT_ID,
//       process.env.GOOGLE_CLIENT_SECRET
//     );
//     auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    
//     const calendar = google.calendar({ version: 'v3', auth });
    
//     // Determine time range from searchParams
//     const now = new Date();
//     let timeMin = new Date(now);
//     let timeMax = new Date(now);
    
//     if (searchParams.dateRange === 'today') {
//       timeMin.setHours(0, 0, 0, 0);
//       timeMax.setHours(23, 59, 59, 999);
//     } else if (searchParams.dateRange === 'tomorrow') {
//       timeMin.setDate(timeMin.getDate() + 1);
//       timeMin.setHours(0, 0, 0, 0);
//       timeMax.setDate(timeMax.getDate() + 1);
//       timeMax.setHours(23, 59, 59, 999);
//     } else if (searchParams.dateRange === 'yesterday') {
//       timeMin.setDate(timeMin.getDate() - 1);
//       timeMin.setHours(0, 0, 0, 0);
//       timeMax.setDate(timeMax.getDate() - 1);
//       timeMax.setHours(23, 59, 59, 999);
//     } else if (searchParams.dateRange === 'this_week') {
//       timeMax.setDate(timeMax.getDate() + 7);
//     } else if (searchParams.specificDate) {
//       timeMin = new Date(searchParams.specificDate);
//       timeMin.setHours(0, 0, 0, 0);
//       timeMax = new Date(searchParams.specificDate);
//       timeMax.setHours(23, 59, 59, 999);
//     } else {
//       // Default: today and next 3 days
//       timeMin.setHours(0, 0, 0, 0);
//       timeMax.setDate(timeMax.getDate() + 3);
//     }
    
//     console.log(`[Chat] Calendar query: ${timeMin.toISOString()} to ${timeMax.toISOString()}`);
    
//     const eventsRes = await calendar.events.list({
//       calendarId: 'primary',
//       timeMin: timeMin.toISOString(),
//       timeMax: timeMax.toISOString(),
//       singleEvents: true,
//       orderBy: 'startTime',
//       maxResults: 20
//     });
    
//     let events = (eventsRes.data.items || []).map(e => ({
//       id: e.id,
//       title: e.summary || '(No title)',
//       start: e.start?.dateTime || e.start?.date,
//       end: e.end?.dateTime || e.end?.date,
//       location: e.location || null,
//       attendees: e.attendees?.map(a => ({ email: a.email, name: a.displayName })) || [],
//       description: e.description?.substring(0, 200) || null,
//       isAllDay: !e.start?.dateTime,
//       htmlLink: e.htmlLink
//     }));
    
//     // Filter by search params if provided
//     if (searchParams.keywords?.length > 0) {
//       const keywords = searchParams.keywords.map(k => k.toLowerCase());
//       events = events.filter(e => 
//         keywords.some(kw => 
//           e.title.toLowerCase().includes(kw) ||
//           e.description?.toLowerCase().includes(kw) ||
//           e.attendees.some(a => a.email?.toLowerCase().includes(kw) || a.name?.toLowerCase().includes(kw))
//         )
//       );
//     }
    
//     return { success: true, events, count: events.length };
    
//   } catch (error) {
//     console.error('[Chat] Calendar fetch error:', error.message);
//     return { success: false, error: error.message };
//   }
// };

// // ============================================
// // AI-POWERED RESPONSE GENERATOR
// // Uses fetched data to answer the specific question
// // ============================================
// const generateDataResponse = async (userQuery, data, dataType) => {
//   let context = '';
  
//   if (dataType === 'email') {
//     if (data.emails.length === 0) {
//       context = 'No emails found matching the query.';
//     } else {
//       context = data.emails.map((e, i) => 
//         `Email ${i + 1}:\n- From: ${e.from} <${e.fromEmail}>\n- Subject: ${e.subject}\n- Date: ${e.dateFormatted}\n- Preview: ${e.snippet}\n- Unread: ${e.isUnread}`
//       ).join('\n\n');
//     }
//   } else if (dataType === 'calendar') {
//     if (data.events.length === 0) {
//       context = 'No calendar events found for the requested time period.';
//     } else {
//       context = data.events.map((e, i) => {
//         const startTime = e.isAllDay ? 'All day' : new Date(e.start).toLocaleString();
//         const attendeeList = e.attendees.map(a => a.name || a.email).join(', ');
//         return `Event ${i + 1}:\n- Title: ${e.title}\n- When: ${startTime}\n- Location: ${e.location || 'N/A'}\n- Attendees: ${attendeeList || 'None'}`;
//       }).join('\n\n');
//     }
//   }
  
//   const prompt = `
// You are HiCapy, an AI assistant. Answer the user's question using ONLY the real data provided below.
// Do NOT make up any information. If the data doesn't contain the answer, say so.

// USER QUESTION: "${userQuery}"

// REAL DATA FROM USER'S ${dataType.toUpperCase()}:
// ${context}

// FORMATTING RULES:
// - Use markdown for readability
// - Use **bold** for names, subjects, dates
// - Use bullet points for lists
// - Be concise but complete
// - If showing emails, format nicely with From, Subject, Date
// - If no results, suggest what they could search for instead
// - Offer to take action (draft reply, schedule meeting) if appropriate

// Answer the user's specific question:`;

//   try {
//     const completion = await groq.chat.completions.create({
//       messages: [{ role: 'user', content: prompt }],
//       model: 'llama-3.1-8b-instant',
//       temperature: 0.3,
//       max_tokens: 800
//     });
    
//     return completion.choices[0].message.content;
//   } catch (error) {
//     console.error('[Chat] Response generation error:', error);
//     return formatFallbackResponse(data, dataType);
//   }
// };

// // Fallback formatting if AI response fails
// const formatFallbackResponse = (data, dataType) => {
//   if (dataType === 'email') {
//     if (!data.emails.length) {
//       return `No emails found matching your search. Try being more specific or check a different time range.`;
//     }
//     let response = `## 📧 Found ${data.emails.length} email(s)\n\n`;
//     data.emails.forEach(e => {
//       response += `### ${e.subject}\n`;
//       response += `**From:** ${e.from} (${e.fromEmail})\n`;
//       response += `**Date:** ${e.dateFormatted}\n`;
//       response += `> ${e.snippet}...\n\n`;
//     });
//     return response;
//   }
  
//   if (dataType === 'calendar') {
//     if (!data.events.length) {
//       return `No events found for that time period.`;
//     }
//     let response = `## 📅 Found ${data.events.length} event(s)\n\n`;
//     data.events.forEach(e => {
//       const time = e.isAllDay ? 'All day' : new Date(e.start).toLocaleString();
//       response += `- **${time}** - ${e.title}\n`;
//       if (e.location) response += `  📍 ${e.location}\n`;
//     });
//     return response;
//   }
  
//   return 'I found some data but had trouble formatting it. Please try again.';
// };

// // Parse relative times to ISO format
// const parseRelativeTime = (timeStr) => {
//   if (!timeStr) return null;
  
//   const now = new Date();
//   const lower = timeStr.toLowerCase();
  
//   // Already ISO format
//   if (timeStr.includes('T') && timeStr.includes('-')) {
//     return new Date(timeStr);
//   }
  
//   // Parse "tomorrow at 3pm"
//   if (lower.includes('tomorrow')) {
//     const tomorrow = new Date(now);
//     tomorrow.setDate(tomorrow.getDate() + 1);
    
//     const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
//     if (timeMatch) {
//       let hours = parseInt(timeMatch[1]);
//       const minutes = parseInt(timeMatch[2] || '0');
//       const ampm = timeMatch[3]?.toLowerCase();
      
//       if (ampm === 'pm' && hours !== 12) hours += 12;
//       if (ampm === 'am' && hours === 12) hours = 0;
      
//       tomorrow.setHours(hours, minutes, 0, 0);
//     } else {
//       tomorrow.setHours(9, 0, 0, 0); // Default to 9am
//     }
//     return tomorrow;
//   }
  
//   // Parse "next Monday", "this Friday" etc
//   const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
//   for (let i = 0; i < days.length; i++) {
//     if (lower.includes(days[i])) {
//       const target = new Date(now);
//       const currentDay = target.getDay();
//       let daysAhead = i - currentDay;
//       if (daysAhead <= 0) daysAhead += 7;
//       target.setDate(target.getDate() + daysAhead);
      
//       const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
//       if (timeMatch) {
//         let hours = parseInt(timeMatch[1]);
//         const minutes = parseInt(timeMatch[2] || '0');
//         const ampm = timeMatch[3]?.toLowerCase();
        
//         if (ampm === 'pm' && hours !== 12) hours += 12;
//         if (ampm === 'am' && hours === 12) hours = 0;
        
//         target.setHours(hours, minutes, 0, 0);
//       } else {
//         target.setHours(9, 0, 0, 0);
//       }
//       return target;
//     }
//   }
  
//   // Just time today "at 3pm"
//   const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
//   if (timeMatch) {
//     const today = new Date(now);
//     let hours = parseInt(timeMatch[1]);
//     const minutes = parseInt(timeMatch[2] || '0');
//     const ampm = timeMatch[3]?.toLowerCase();
    
//     if (ampm === 'pm' && hours !== 12) hours += 12;
//     if (ampm === 'am' && hours === 12) hours = 0;
    
//     today.setHours(hours, minutes, 0, 0);
    
//     // If time has passed, assume tomorrow
//     if (today < now) {
//       today.setDate(today.getDate() + 1);
//     }
//     return today;
//   }
  
//   return null;
// };

// exports.chat = async (req, res) => {
//   try {
//     const { message, history } = req.body;
//     const userId = req.user.id;

//     // 1. USE AI TO ANALYZE THE QUERY
//     const analysis = await analyzeQuery(message);
//     console.log('[Chat] Query analysis result:', analysis.category, analysis.subIntent);

//     // 2. HANDLE EMAIL QUERIES (read/search)
//     if (analysis.category === 'email' && ['read', 'search', 'list'].includes(analysis.subIntent)) {
//       console.log('[Chat] Fetching emails with params:', analysis.searchParams);
//       const emailResult = await fetchEmails(userId, analysis.searchParams || {});
      
//       if (!emailResult.success) {
//         return res.json({
//           reply: `I couldn't access your emails. ${emailResult.error === 'Gmail not connected' 
//             ? 'Please connect your Gmail & Calendar from the Integrations page first.' 
//             : 'There was an error: ' + emailResult.error}`,
//           sources: [],
//           action: null
//         });
//       }
      
//       // Use AI to generate a response that answers the specific question
//       const reply = await generateDataResponse(message, emailResult, 'email');
//       return res.json({ reply, sources: [], action: null });
//     }
    
//     // 3. HANDLE CALENDAR QUERIES (read/search)
//     if (analysis.category === 'calendar' && ['read', 'search', 'list'].includes(analysis.subIntent)) {
//       console.log('[Chat] Fetching calendar with params:', analysis.searchParams);
//       const calResult = await fetchCalendarEvents(userId, analysis.searchParams || {});
      
//       if (!calResult.success) {
//         return res.json({
//           reply: `I couldn't access your calendar. ${calResult.error === 'Calendar not connected'
//             ? 'Please connect your Gmail & Calendar from the Integrations page first.'
//             : 'There was an error: ' + calResult.error}`,
//           sources: [],
//           action: null
//         });
//       }
      
//       const reply = await generateDataResponse(message, calResult, 'calendar');
//       return res.json({ reply, sources: [], action: null });
//     }

//     // 4. HANDLE ACTIONS (create meeting, send email)
//     if (analysis.category === 'action' && analysis.actionParams) {
//       const params = analysis.actionParams;
//       let action = null;
//       let actionMessage = '';
      
//       if (params.type === 'schedule_meeting') {
//         const startTime = parseRelativeTime(params.startTime);
//         const endTime = startTime ? new Date(startTime.getTime() + 60 * 60 * 1000) : null;
        
//         if (startTime) {
//           action = await Action.create({
//             userId,
//             type: 'schedule_meeting',
//             source: 'chat',
//             status: 'pending',
//             payload: {
//               title: params.title || 'New Meeting',
//               description: '',
//               startTime: startTime.toISOString(),
//               endTime: endTime?.toISOString(),
//               attendees: params.recipients || [],
//               location: ''
//             },
//             reasoning: `User requested: "${message}"`
//           });
          
//           actionMessage = `I've prepared a calendar event for **${params.title || 'New Meeting'}** on **${startTime.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}** at **${startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}**. Please approve it to add to your calendar.`;
//         }
//       }
      
//       if (params.type === 'send_email' && params.recipients?.length > 0) {
//         action = await Action.create({
//           userId,
//           type: 'draft_reply',
//           source: 'chat',
//           status: 'pending',
//           payload: {
//             recipients: params.recipients,
//             subject: params.subject || 'No Subject',
//             body: params.body || ''
//           },
//           reasoning: `User requested: "${message}"`
//         });
        
//         actionMessage = `I've drafted an email to **${params.recipients.join(', ')}** with subject **"${params.subject || 'No Subject'}"**. Please review and approve.`;
//       }
      
//       if (action) {
//         return res.json({ 
//           reply: actionMessage, 
//           sources: [],
//           action: {
//             id: action._id,
//             type: action.type,
//             payload: action.payload,
//             status: action.status
//           }
//         });
//       }
//     }

//     // 5. GENERAL CHAT - Use RAG and knowledge base
//     const relevantMemories = await mem0Service.search(message, userId);
//     const userPreferences = await mem0Service.getUserPreferences(userId);

//     const reply = await aiService.generateChatResponse({
//       query: message,
//       context: relevantMemories,
//       history: history || [],
//       userPreferences
//     });

//     res.json({ 
//       reply, 
//       sources: relevantMemories.slice(0, 3),
//       action: null
//     });

//   } catch (error) {
//     console.error('Chat Error:', error);
//     res.status(500).json({ error: 'Failed to process chat' });
//   }
// };

// // ============================================
// // DAILY BRIEFING ENDPOINT
// // ============================================
// exports.getDailyBriefing = async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const Integration = require('../models/Integration');
//     const Action = require('../models/Action');
//     const { google } = require('googleapis');

//     // Get user's name
//     const User = require('../models/users');
//     const user = await User.findById(userId);

//     // Get pending actions
//     const pendingActions = await Action.find({ 
//       userId, 
//       status: 'pending' 
//     }).sort({ createdAt: -1 }).limit(5);

//     // Get today's calendar events
//     let meetings = [];
//     const { accessToken, refreshToken, provider } = await integrationHelper.getGoogleToken(userId);

//     if (accessToken || refreshToken) {
//       try {
//         console.log(`[DailyBriefing] Using ${provider} for calendar`);
//         const auth = new google.auth.OAuth2(
//           process.env.GOOGLE_CLIENT_ID,
//           process.env.GOOGLE_CLIENT_SECRET
//         );
//         auth.setCredentials({
//           access_token: accessToken,
//           refresh_token: refreshToken
//         });
        
//         const calendar = google.calendar({ version: 'v3', auth });
//         const today = new Date();
//         const tomorrow = new Date(today);
//         tomorrow.setDate(tomorrow.getDate() + 1);
        
//         const calRes = await calendar.events.list({
//           calendarId: 'primary',
//           timeMin: today.toISOString(),
//           timeMax: tomorrow.toISOString(),
//           singleEvents: true,
//           orderBy: 'startTime'
//         });
        
//         meetings = (calRes.data.items || []).map(e => ({
//           title: e.summary,
//           time: new Date(e.start?.dateTime || e.start?.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
//           attendees: e.attendees?.map(a => a.email).join(', ') || ''
//         }));
//       } catch (calErr) {
//         console.error('Calendar fetch error:', calErr.message);
//       }
//     }

//     // Get emails needing response (from actions)
//     const emails = pendingActions
//       .filter(a => a.source === 'email')
//       .map(a => ({ from: a.payload?.from, subject: a.payload?.subject }));

//     // Generate briefing
//     const briefing = await aiService.generateBriefing({
//       emails,
//       meetings,
//       pendingActions: pendingActions.map(a => ({ type: a.type, payload: a.payload })),
//       userName: user?.name || user?.email?.split('@')[0]
//     });

//     res.json({
//       briefing,
//       stats: {
//         meetingCount: meetings.length,
//         pendingEmailCount: emails.length,
//         pendingActionCount: pendingActions.length
//       },
//       meetings,
//       pendingActions: pendingActions.slice(0, 3)
//     });

//   } catch (error) {
//     console.error('Briefing Error:', error);
//     res.status(500).json({ error: 'Failed to generate briefing' });
//   }
// };
