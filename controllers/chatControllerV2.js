// /**
//  * Chat Controller v2 - Intelligent Assistant with Full Knowledge Graph
//  * 
//  * This controller handles all chat interactions with:
//  * 1. Smart query analysis using AI
//  * 2. Unified knowledge search (meetings, transcripts, tasks, emails)
//  * 3. Email/Calendar API integration
//  * 4. Action creation AND execution
//  * 5. Context-aware responses
//  * 6. Natural language time parsing
//  * 7. Google Meet link generation
//  * 8. Bot assignment for meetings
//  */

// const mem0Service = require('../services/mem0Service');
// const aiService = require('../services/aiService');
// const knowledgeService = require('../services/knowledgeService');
// const calendarService = require('../services/calendarService');
// const integrationHelper = require('../utils/integrationHelper');
// const hicapyClient = require('../services/hicapyClient');
// const Action = require('../models/Action');
// const Meeting = require('../models/Meeting');
// const Task = require('../models/Task');
// const User = require('../models/users');
// const Bot = require('../models/Bot');
// const Feedback = require('../models/Feedback');
// const Groq = require('groq-sdk');
// const { google } = require('googleapis');
// const { decrypt } = require('../utils/crypto');

// const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// // ============================================
// // NATURAL LANGUAGE TIME PARSER
// // ============================================
// const parseNaturalTime = async (timeExpression, referenceDate = new Date()) => {
//   // First try simple patterns before calling LLM (faster and more reliable)
//   const now = referenceDate;
//   const timeMatch = timeExpression.match(/(\d{1,2})\s*(?::|\s)?(\d{2})?\s*(am|pm)?/i);
  
//   // Handle common patterns directly
//   const lowerExpr = timeExpression.toLowerCase().trim();
//   let targetDate = new Date(now);
//   let hours = null;
//   let minutes = 0;
  
//   // Extract time component
//   if (timeMatch) {
//     hours = parseInt(timeMatch[1]);
//     minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
//     const period = timeMatch[3]?.toLowerCase();
    
//     if (period === 'pm' && hours < 12) hours += 12;
//     if (period === 'am' && hours === 12) hours = 0;
//   }
  
//   // Determine date
//   if (lowerExpr.includes('tomorrow')) {
//     targetDate.setDate(targetDate.getDate() + 1);
//   } else if (lowerExpr.includes('next week')) {
//     targetDate.setDate(targetDate.getDate() + 7);
//   } else if (lowerExpr.includes('next')) {
//     // Handle "next monday", "next tuesday", etc.
//     const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
//     for (let i = 0; i < days.length; i++) {
//       if (lowerExpr.includes(days[i])) {
//         const currentDay = now.getDay();
//         let daysUntil = i - currentDay;
//         if (daysUntil <= 0) daysUntil += 7; // Next week if same or past day
//         targetDate.setDate(targetDate.getDate() + daysUntil);
//         break;
//       }
//     }
//   }
  
//   // If we found a valid time
//   if (hours !== null) {
//     targetDate.setHours(hours, minutes, 0, 0);
    
//     const isToday = targetDate.toDateString() === now.toDateString();
//     const tomorrow = new Date(now);
//     tomorrow.setDate(tomorrow.getDate() + 1);
//     const isTomorrow = targetDate.toDateString() === tomorrow.toDateString();
    
//     const formatted = targetDate.toLocaleString('en-US', {
//       weekday: 'short',
//       month: 'short',
//       day: 'numeric',
//       year: 'numeric',
//       hour: 'numeric',
//       minute: '2-digit',
//       hour12: true
//     });
    
//     console.log(`[TimeParser] Direct parse: "${timeExpression}" → ${targetDate.toISOString()}`);
    
//     return {
//       dateTime: targetDate.toISOString(),
//       formatted: isToday ? `Today at ${targetDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` :
//                  isTomorrow ? `Tomorrow at ${targetDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` :
//                  formatted,
//       isToday,
//       isTomorrow,
//       confidence: 0.95
//     };
//   }
  
//   // Fallback to LLM for complex expressions
//   const prompt = `Parse this time expression into an exact date and time.

// Time: "${timeExpression}"
// Now: ${referenceDate.toISOString()}

// Return ONLY this JSON (no other text):
// {"dateTime": "YYYY-MM-DDTHH:MM:SS.000Z", "formatted": "human readable", "isToday": false, "isTomorrow": false, "confidence": 0.9}`;

//   try {
//     const completion = await groq.chat.completions.create({
//       messages: [{ role: 'user', content: prompt }],
//       model: 'llama-3.1-8b-instant',
//       temperature: 0.0,
//       max_tokens: 150
//     });

//     const content = completion.choices[0].message.content.trim();
//     // Try to extract JSON more aggressively
//     let jsonStr = content;
//     const jsonMatch = content.match(/\{[^{}]*"dateTime"[^{}]*\}/s);
//     if (jsonMatch) {
//       jsonStr = jsonMatch[0];
//     }
    
//     const result = JSON.parse(jsonStr);
//     console.log(`[TimeParser] LLM parse: "${timeExpression}" → ${result.dateTime}`);
//     return result;
//   } catch (error) {
//     console.error('[TimeParser] Parse error for:', timeExpression, error.message);
//     // Ultimate fallback: assume tomorrow at 5pm if "tomorrow" is mentioned
//     if (lowerExpr.includes('tomorrow')) {
//       const fallback = new Date(now);
//       fallback.setDate(fallback.getDate() + 1);
//       fallback.setHours(17, 0, 0, 0);
//       return {
//         dateTime: fallback.toISOString(),
//         formatted: `Tomorrow at 5:00 PM`,
//         isToday: false,
//         isTomorrow: true,
//         confidence: 0.6
//       };
//     }
//     return null;
//   }
// };

// // ============================================
// // UNIFIED INTELLIGENT QUERY PARSER
// // Uses LLM + conversation history for robust understanding
// // Replaces all regex-based parsing with context-aware AI
// // ============================================
// const intelligentQueryParser = async (message, fullContext = {}) => {
//   const {
//     conversationHistory = [],
//     pendingAction = null,
//     conversationContext: structuredContext = {},
//     resolvedEmailContext = null
//   } = fullContext;

//   // Build rich conversation transcript
//   let conversationTranscript = 'No previous messages';
//   if (conversationHistory && conversationHistory.length > 0) {
//     const recentMessages = conversationHistory.slice(-8); // Last 8 messages for better context
//     conversationTranscript = recentMessages.map((m, idx) => {
//       const role = m.sender === 'user' ? '👤 User' : '🤖 Assistant';
//       const text = m.text?.substring(0, 600) || '';
//       return `[${idx + 1}] ${role}: ${text}`;
//     }).join('\n\n');
//   }

//   // Build structured data context (emails, meetings from previous responses)
//   let dataContext = '';
//   if (structuredContext?.emails?.length > 0) {
//     dataContext += '\n📧 EMAILS IN CONTEXT (from previous responses):\n';
//     structuredContext.emails.slice(0, 10).forEach((email, i) => {
//       dataContext += `  [Email ${email.index || i + 1}] From: ${email.from} <${email.fromEmail}>\n`;
//       dataContext += `    Subject: ${email.subject}\n`;
//       dataContext += `    Date: ${email.dateFormatted || 'Unknown'}\n`;
//       dataContext += `    Preview: ${email.snippet?.substring(0, 150) || 'No preview'}...\n`;
//       if (email.extractedTime) dataContext += `    ⏰ Mentioned time: ${email.extractedTime}\n`;
//       if (email.extractedPurpose) dataContext += `    📌 Topic: ${email.extractedPurpose}\n`;
//       dataContext += '\n';
//     });
//   }
  
//   if (structuredContext?.meetings?.length > 0) {
//     dataContext += '\n📅 MEETINGS IN CONTEXT:\n';
//     structuredContext.meetings.slice(0, 5).forEach((mtg, i) => {
//       dataContext += `  [Meeting ${i + 1}] ${mtg.title || 'Untitled'} - ${mtg.dateFormatted || mtg.startTime || 'Unknown time'}\n`;
//     });
//   }

//   // Build pending action context
//   let pendingActionStr = '';
//   if (pendingAction) {
//     pendingActionStr = `\n⏳ PENDING ACTION (waiting for confirmation):\n`;
//     pendingActionStr += `  Type: ${pendingAction.type}\n`;
//     if (pendingAction.payload) {
//       if (pendingAction.payload.recipients) pendingActionStr += `  To: ${pendingAction.payload.recipients.join(', ')}\n`;
//       if (pendingAction.payload.subject) pendingActionStr += `  Subject: ${pendingAction.payload.subject}\n`;
//       if (pendingAction.payload.title) pendingActionStr += `  Meeting: ${pendingAction.payload.title}\n`;
//       if (pendingAction.payload.attendees) pendingActionStr += `  Attendees: ${pendingAction.payload.attendees.join(', ')}\n`;
//     }
//   }

//   // Build resolved reference context (if user said "email 2" or "that email")
//   let resolvedRefStr = '';
//   if (resolvedEmailContext) {
//     resolvedRefStr = `\n🔗 USER IS REFERRING TO THIS EMAIL:\n`;
//     resolvedRefStr += `  From: ${resolvedEmailContext.from} <${resolvedEmailContext.fromEmail}>\n`;
//     resolvedRefStr += `  Subject: ${resolvedEmailContext.subject}\n`;
//     if (resolvedEmailContext.extractedTime) resolvedRefStr += `  Mentioned Time: ${resolvedEmailContext.extractedTime}\n`;
//     if (resolvedEmailContext.extractedPurpose) resolvedRefStr += `  Topic/Purpose: ${resolvedEmailContext.extractedPurpose}\n`;
//     resolvedRefStr += `  Content: ${resolvedEmailContext.snippet?.substring(0, 300) || 'No content'}\n`;
//   }

//   const prompt = `You are an expert query intent parser for HiCapy, an AI personal assistant.
// Your job is to understand EXACTLY what the user wants, using the FULL conversation context.

// ═══════════════════════════════════════════════════════════════
// CURRENT USER MESSAGE: "${message}"
// ═══════════════════════════════════════════════════════════════

// CONVERSATION HISTORY:
// ${conversationTranscript}
// ${dataContext}
// ${pendingActionStr}
// ${resolvedRefStr}

// ═══════════════════════════════════════════════════════════════
// INTENT CLASSIFICATION RULES
// ═══════════════════════════════════════════════════════════════

// STEP 1: Determine if this is a QUERY (fetching data) or ACTION (doing something)

// 📋 QUERIES (category: email, calendar, slack, knowledge, general):
// - "what emails need attention" → email query
// - "show my emails" → email query  
// - "any important emails?" → email query
// - "what's on my calendar" → calendar query
// - "am I free tomorrow" → calendar query
// - "search slack for X" → slack search
// - "what did we discuss in the meeting" → knowledge query
// - "hello", "hi", "thanks" → general

// 📤 ACTIONS (category: action, action_confirm, action_modify, action_from_context):
// - "schedule a meeting with X at Y" → action (explicit new action)
// - "email X about Y" → action (explicit new action)
// - "schedule it", "send it", "yes", "confirm" → action_confirm (confirming pending action)
// - "make it shorter", "improve the body" → action_modify (editing pending action)
// - "fix the event accordingly", "create meeting from this" → action_from_context (using conversation data)

// STEP 2: Resolve References from Context

// When user says: | Look for:
// "email 2" or "second email" | Find email with index 2 in EMAILS IN CONTEXT
// "email from John" | Find email where from contains "John"  
// "the client acquisition one" | Find email where subject/snippet contains "client acquisition"
// "that meeting" | Use the meeting discussed in conversation
// "him/her/them" | Find person mentioned in recent messages
// "that time" | Extract time from referenced email/message

// STEP 3: Extract All Parameters

// For ACTIONS, extract:
// - title/subject: What is the meeting/email about?
// - time: When? (preserve natural language like "tomorrow at 5pm")
// - attendees/recipients: Who? (extract emails or names)
// - body: What content?

// ═══════════════════════════════════════════════════════════════
// CRITICAL RULES
// ═══════════════════════════════════════════════════════════════

// 1. If user asks "what emails" or "show emails" → ALWAYS return category: "email", NOT an action
// 2. If there's a pending action and user says "yes/send/confirm/schedule it" → return category: "action_confirm"
// 3. If user references "email 2" → find and return that email's data in resolvedTarget
// 4. If confidence < 0.7 due to ambiguity → set needsClarification: true with a specific question
// 5. For slack searches → extract query, channel, and from parameters
// 6. Proactive suggestions should be specific, not generic

// ═══════════════════════════════════════════════════════════════

// Return ONLY valid JSON (no markdown, no explanation):
// {
//   "category": "email" | "calendar" | "slack" | "knowledge" | "action" | "action_confirm" | "action_modify" | "action_from_context" | "general",
//   "subIntent": "fetch" | "search" | "compose_email" | "schedule_meeting" | "reply_to_email" | "confirm" | "modify" | "query" | "greeting",
//   "confidence": 0.0-1.0,
//   "needsClarification": true | false,
//   "clarificationQuestion": "Specific question to ask user if confidence is low, or null",
  
//   "resolvedTarget": {
//     "type": "email" | "meeting" | "person" | null,
//     "index": "email/meeting number if referenced, or null",
//     "from": "resolved sender name",
//     "fromEmail": "resolved sender email",
//     "subject": "resolved subject",
//     "extractedTime": "time mentioned in target like 'tomorrow at 5pm'",
//     "extractedPurpose": "topic/purpose extracted"
//   },
  
//   "queryParams": {
//     "emailParams": { "from": null, "subject": null, "unreadOnly": false, "dateRange": null, "keywords": [] },
//     "calendarParams": { "dateRange": null, "title": null },
//     "slackParams": { "query": null, "channel": null, "from": null },
//     "knowledgeParams": { "searchQuery": null, "meetingTitle": null }
//   },
  
//   "actionParams": {
//     "type": "schedule_meeting" | "send_email" | "reply_email" | "create_task" | null,
//     "title": "meeting title or email subject",
//     "time": "natural language time like 'tomorrow at 5pm' - PRESERVE EXACTLY as mentioned",
//     "duration": 60,
//     "attendees": ["email@example.com"],
//     "attendeeNames": ["name if email not available"],
//     "recipients": ["email@example.com"],
//     "body": "email body text",
//     "isReply": false,
//     "replyToEmail": "original sender email if replying",
//     "assignBot": false
//   },
  
//   "proactiveSuggestion": "What a helpful assistant would suggest next based on context, or null"
// }`;

//   try {
//     const completion = await groq.chat.completions.create({
//       messages: [{ role: 'user', content: prompt }],
//       model: 'llama-3.1-8b-instant',
//       temperature: 0.1,
//       max_tokens: 1500
//     });

//     const content = completion.choices[0].message.content.trim();
    
//     // Robust JSON extraction: Find first '{' and last '}'
//     const firstOpen = content.indexOf('{');
//     const lastClose = content.lastIndexOf('}');
    
//     if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
//         const jsonCandidate = content.substring(firstOpen, lastClose + 1);
//         try {
//             const result = JSON.parse(jsonCandidate);
//             console.log('[QueryParser] Parsed intent:', JSON.stringify(result, null, 2));
//             return result;
//         } catch (e) {
//             console.warn('[QueryParser] Substring parse failed, trying regex fallback...');
//         }
//     }

//     const jsonMatch = content.match(/\{[\s\S]*\}/);
//     if (jsonMatch) {
//       const result = JSON.parse(jsonMatch[0]);
//       console.log('[QueryParser] Parsed intent:', JSON.stringify(result, null, 2));
//       return result;
//     }
//     return { category: 'general', subIntent: 'greeting', confidence: 0.5, needsClarification: false };
//   } catch (error) {
//     console.error('[QueryParser] Parse error:', error);
//     return { category: 'general', subIntent: 'greeting', confidence: 0.3, needsClarification: true, clarificationQuestion: "I had trouble understanding that. Could you rephrase?" };
//   }
// };

// // ============================================
// // LEGACY QUERY ANALYZER (keeping for compatibility, now wraps new parser)
// // ============================================
// const analyzeQuery = async (message, conversationHistory = [], pendingAction = null, resolvedContext = null, fullConversationContext = null) => {
//   // Use new intelligent parser with ALL context
//   const parsedIntent = await intelligentQueryParser(message, {
//     conversationHistory,
//     pendingAction,
//     conversationContext: fullConversationContext, // Pass emails/meetings list from frontend
//     resolvedEmailContext: resolvedContext
//   });
  
//   // Map new format to old format for backwards compatibility
//   // Fix: Handle when LLM returns category:action with subIntent:action_confirm
//   let finalCategory = parsedIntent.category;
//   if (parsedIntent.category === 'action' && parsedIntent.subIntent === 'action_confirm') {
//     finalCategory = 'action_confirm';
//   }
  
//   return {
//     category: finalCategory,
//     subIntent: parsedIntent.subIntent,
//     confidence: parsedIntent.confidence,
//     isConfirmation: finalCategory === 'action_confirm' || parsedIntent.subIntent === 'confirm',
//     needsClarification: parsedIntent.needsClarification,
//     clarificationQuestion: parsedIntent.clarificationQuestion,
//     resolvedTarget: parsedIntent.resolvedTarget, // Pass through resolved target
//     slackParams: parsedIntent.queryParams?.slackParams,
//     searchParams: parsedIntent.queryParams?.emailParams,
//     calendarParams: parsedIntent.queryParams?.calendarParams,
//     extractedFromContext: parsedIntent.resolvedTarget ? {
//       title: parsedIntent.resolvedTarget.extractedPurpose || parsedIntent.resolvedTarget.subject,
//       time: parsedIntent.resolvedTarget.extractedTime,
//       attendees: parsedIntent.resolvedTarget.fromEmail ? [parsedIntent.resolvedTarget.fromEmail] : [],
//       attendeeNames: parsedIntent.resolvedTarget.from ? [parsedIntent.resolvedTarget.from] : [],
//       emailSubject: parsedIntent.resolvedTarget.subject,
//       replyTo: parsedIntent.resolvedTarget.fromEmail
//     } : parsedIntent.actionParams ? {
//       title: parsedIntent.actionParams.title,
//       time: parsedIntent.actionParams.time,
//       attendees: parsedIntent.actionParams.attendees || [],
//       attendeeNames: parsedIntent.actionParams.attendeeNames || [],
//       emailSubject: parsedIntent.actionParams.title,
//       replyTo: parsedIntent.actionParams.replyToEmail
//     } : {},
//     meetingParams: parsedIntent.actionParams?.type === 'schedule_meeting' ? {
//       title: parsedIntent.actionParams.title,
//       time: parsedIntent.actionParams.time,
//       timeRaw: parsedIntent.actionParams.time,
//       duration: parsedIntent.actionParams.duration || 60,
//       attendees: parsedIntent.actionParams.attendees || [],
//       attendeeNames: parsedIntent.actionParams.attendeeNames || [],
//       assignBot: parsedIntent.actionParams.assignBot || false
//     } : null,
//     emailParams: parsedIntent.actionParams?.type === 'send_email' || parsedIntent.actionParams?.type === 'reply_email' ? {
//       recipients: parsedIntent.actionParams.recipients || [],
//       subject: parsedIntent.actionParams.title,
//       body: parsedIntent.actionParams.body,
//       isReply: parsedIntent.actionParams.isReply || false
//     } : null,
//     useContextFor: parsedIntent.resolvedTarget ? {
//       title: !!parsedIntent.resolvedTarget.extractedPurpose,
//       time: !!parsedIntent.resolvedTarget.extractedTime,
//       attendees: !!parsedIntent.resolvedTarget.fromEmail
//     } : {},
//     proactiveSuggestion: parsedIntent.proactiveSuggestion
//   };
// };

// // ============================================
// // CONTACT RESOLVER - Find email from name
// // ============================================
// const resolveContact = async (userId, nameOrEmail) => {
//   // If it's already an email, return it
//   if (nameOrEmail.includes('@')) {
//     return { email: nameOrEmail, name: nameOrEmail.split('@')[0] };
//   }

//   // Search in previous meetings for this contact
//   const meetings = await Meeting.find({ user_id: userId })
//     .select('participants')
//     .sort({ start_time: -1 })
//     .limit(50);

//   const normalizedName = nameOrEmail.toLowerCase().trim();
  
//   for (const meeting of meetings) {
//     if (meeting.participants) {
//       for (const participant of meeting.participants) {
//         const pName = (participant.name || '').toLowerCase();
//         const pEmail = (participant.email || '').toLowerCase();
        
//         if (pName.includes(normalizedName) || normalizedName.includes(pName.split(' ')[0])) {
//           return { email: participant.email, name: participant.name || pEmail.split('@')[0] };
//         }
//       }
//     }
//   }

//   // Try to search in user's Google contacts or recent emails
//   try {
//     const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
//     if (accessToken || refreshToken) {
//       const auth = new google.auth.OAuth2(
//         process.env.GOOGLE_CLIENT_ID,
//         process.env.GOOGLE_CLIENT_SECRET
//       );
//       auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
//       const gmail = google.gmail({ version: 'v1', auth });
      
//       // Search for emails with this person's name
//       const searchRes = await gmail.users.messages.list({
//         userId: 'me',
//         q: `from:${nameOrEmail} OR to:${nameOrEmail}`,
//         maxResults: 5
//       });
      
//       if (searchRes.data.messages?.length > 0) {
//         const msgDetail = await gmail.users.messages.get({
//           userId: 'me',
//           id: searchRes.data.messages[0].id,
//           format: 'metadata',
//           metadataHeaders: ['From', 'To']
//         });
        
//         const headers = msgDetail.data.payload?.headers || [];
//         for (const h of headers) {
//           const val = h.value || '';
//           if (val.toLowerCase().includes(normalizedName)) {
//             const emailMatch = val.match(/<([^>]+)>/);
//             if (emailMatch) {
//               return { email: emailMatch[1], name: nameOrEmail };
//             }
//           }
//         }
//       }
//     }
//   } catch (e) {
//     console.log('[Chat] Contact search error:', e.message);
//   }

//   // Fallback: return the name as-is (user will need to provide email)
//   return { email: null, name: nameOrEmail };
// };

// // ============================================
// // BOT ASSIGNMENT FOR MEETINGS
// // ============================================
// const assignBotToMeeting = async (userId, meetLink, meetingTitle) => {
//   try {
//     const user = await User.findById(userId).select('+bot_service.api_key');
    
//     if (!user?.bot_service?.enabled || !user?.bot_service?.api_key) {
//       return { success: false, error: 'Bot service not enabled. Enable bots from dashboard first.' };
//     }

//     // Get user's bots
//     const bots = await Bot.find({ user_id: userId, status: 'idle' }).sort({ created_at: -1 }).limit(1);
    
//     if (bots.length === 0) {
//       return { success: false, error: 'No bots available. Create a bot from the Bots page first.' };
//     }

//     const bot = bots[0];
//     const apiKey = decrypt(user.bot_service.api_key);

//     // Join the meeting
//     const joinResult = await hicapyClient.joinMeeting({
//       apiKey,
//       botId: bot.bot_service_bot_id,
//       meetingUrl: meetLink,
//       correlationId: `chat-${Date.now()}`
//     });

//     if (joinResult.success || joinResult.data) {
//       // Update bot status
//       await Bot.findByIdAndUpdate(bot._id, { 
//         status: 'in_meeting',
//         current_meeting_url: meetLink
//       });

//       return { 
//         success: true, 
//         botId: bot._id, 
//         botName: bot.name,
//         message: `Bot "${bot.name}" is joining the meeting.`
//       };
//     }

//     return { success: false, error: joinResult.error || 'Failed to join meeting' };
//   } catch (error) {
//     console.error('[Chat] Bot assignment error:', error);
//     return { success: false, error: error.message };
//   }
// };

// // ============================================
// // EMAIL IMPORTANCE SCORING
// // ============================================
// const calculateEmailImportance = (subject, fromName, fromEmail, labels, snippet) => {
//   let score = 5; // Start neutral
  
//   const subjectLower = (subject || '').toLowerCase();
//   const fromLower = (fromName + ' ' + fromEmail).toLowerCase();
//   const snippetLower = (snippet || '').toLowerCase();
  
//   // DECREASE score for promotional/spam indicators
//   const spamKeywords = ['unsubscribe', 'newsletter', 'promotional', 'sale', 'discount', 
//     'limited time', 'act now', 'click here', 'free', 'winner', 'congratulations',
//     'offer', 'deal', 'promo', '% off', 'save now', 'buy now', 'order now'];
//   const spamSenders = ['noreply', 'no-reply', 'notifications', 'newsletter', 'marketing',
//     'promo', 'deals', 'offers', 'alert', 'updates@', 'info@', 'team@'];
  
//   for (const kw of spamKeywords) {
//     if (subjectLower.includes(kw) || snippetLower.includes(kw)) score -= 2;
//   }
//   for (const sender of spamSenders) {
//     if (fromLower.includes(sender)) score -= 3;
//   }
  
//   // Common promotional senders
//   const promotionalDomains = ['linkedin.com', 'unstop.com', 'coca-cola', 'spotify', 
//     'amazon.com', 'flipkart', 'myntra', 'swiggy', 'zomato', 'urbancompany'];
//   for (const domain of promotionalDomains) {
//     if (fromLower.includes(domain)) score -= 4;
//   }
  
//   // INCREASE score for important indicators
//   const importantKeywords = ['urgent', 'asap', 'important', 'deadline', 'meeting', 
//     'schedule', 'call', 'interview', 'offer letter', 'contract', 'payment',
//     'invoice', 'action required', 'response needed', 'tomorrow', 'today'];
  
//   for (const kw of importantKeywords) {
//     if (subjectLower.includes(kw) || snippetLower.includes(kw)) score += 2;
//   }
  
//   // Personal email domains = more important
//   if (fromLower.includes('@gmail.com') || fromLower.includes('@yahoo') || 
//       fromLower.includes('@outlook') || fromLower.includes('@hotmail')) {
//     score += 2;
//   }
  
//   // Labels indicate importance
//   if (labels.includes('IMPORTANT')) score += 3;
//   if (labels.includes('STARRED')) score += 3;
//   if (labels.includes('CATEGORY_PERSONAL')) score += 2;
//   if (labels.includes('CATEGORY_PROMOTIONS')) score -= 5;
//   if (labels.includes('CATEGORY_SOCIAL')) score -= 3;
//   if (labels.includes('CATEGORY_FORUMS')) score -= 3;
  
//   return Math.max(0, Math.min(10, score)); // Clamp 0-10
// };

// // ============================================
// // GMAIL API - ROBUST EMAIL FETCHER
// // ============================================
// const fetchEmails = async (userId, params = {}) => {
//   try {
//     const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
//     if (!accessToken && !refreshToken) {
//       console.log('[Chat] No Google token found for user');
//       return { success: false, error: 'Gmail not connected. Please connect from Integrations page.' };
//     }

//     const auth = new google.auth.OAuth2(
//       process.env.GOOGLE_CLIENT_ID,
//       process.env.GOOGLE_CLIENT_SECRET
//     );
//     auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

//     const gmail = google.gmail({ version: 'v1', auth });

//     // Build query - SMART query construction
//     let queryParts = [];
    
//     // Only add label filter if not searching everywhere
//     if (!params.searchEverywhere) {
//       queryParts.push('in:inbox');
//     }

//     // ===== IMPORTANCE FILTERING (default: exclude promotions/spam) =====
//     // Unless explicitly asked for all emails, filter out noise
//     if (!params.includePromotions && !params.showAll) {
//       // Exclude promotional categories
//       queryParts.push('-category:promotions');
//       queryParts.push('-category:social');
//       queryParts.push('-category:forums');
//       // Exclude common newsletter/promotional senders
//       queryParts.push('-from:noreply');
//       queryParts.push('-from:notifications');
//       queryParts.push('-from:newsletter');
//       queryParts.push('-from:marketing');
//     }
    
//     // Prioritize important/starred if filtering for important
//     if (params.importantOnly) {
//       queryParts.push('(is:important OR is:starred OR category:primary)');
//     }

//     if (params.from) {
//       queryParts.push(`from:${params.from}`);
//     }
//     if (params.to) {
//       queryParts.push(`to:${params.to}`);
//     }
//     if (params.subject) {
//       queryParts.push(`subject:(${params.subject})`);
//     }
//     // Only add meaningful keywords (not generic terms)
//     if (params.keywords?.length > 0) {
//       const meaningfulKeywords = params.keywords.filter(k => 
//         !['email', 'mail', 'message', 'show', 'get', 'find', 'search', 'last', 'latest', 'recent'].includes(k.toLowerCase())
//       );
//       if (meaningfulKeywords.length > 0) {
//         queryParts.push(meaningfulKeywords.join(' OR '));
//       }
//     }
//     if (params.unreadOnly) {
//       queryParts.push('is:unread');
//     }

//     // Date handling
//     const now = new Date();
//     if (params.dateRange === 'today') {
//       const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
//       queryParts.push(`after:${formatGmailDate(today)}`);
//     } else if (params.dateRange === 'yesterday') {
//       const yesterday = new Date(now);
//       yesterday.setDate(yesterday.getDate() - 1);
//       const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
//       queryParts.push(`after:${formatGmailDate(yesterday)} before:${formatGmailDate(today)}`);
//     } else if (params.dateRange === 'this_week') {
//       const weekAgo = new Date(now);
//       weekAgo.setDate(weekAgo.getDate() - 7);
//       queryParts.push(`after:${formatGmailDate(weekAgo)}`);
//     }

//     const query = queryParts.length > 0 ? queryParts.join(' ') : '';
//     const maxResults = params.limit || 10;

//     console.log(`[Chat] Gmail API query: "${query}", limit: ${maxResults}`);

//     const listRes = await gmail.users.messages.list({
//       userId: 'me',
//       maxResults,
//       q: query || undefined
//     });

//     if (!listRes.data.messages?.length) {
//       return { success: true, emails: [], count: 0, query };
//     }

//     // Fetch email details
//     const emails = [];
//     const messagesToFetch = listRes.data.messages.slice(0, Math.min(maxResults, 10));

//     for (const msg of messagesToFetch) {
//       try {
//         const detail = await gmail.users.messages.get({
//           userId: 'me',
//           id: msg.id,
//           format: 'full'
//         });

//         const headers = detail.data.payload?.headers || [];
//         const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

//         const fromRaw = getHeader('From');
//         const fromMatch = fromRaw.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+)>?$/);
        
//         // Extract email body
//         let body = '';
//         const extractBody = (part) => {
//           if (!part) return '';
//           if (part.body?.data) {
//             try {
//               return Buffer.from(part.body.data, 'base64').toString('utf-8');
//             } catch (e) {
//               return '';
//             }
//           }
//           if (part.parts) {
//             // Prefer text/plain, then text/html
//             const textPart = part.parts.find(p => p.mimeType === 'text/plain');
//             if (textPart) return extractBody(textPart);
//             const htmlPart = part.parts.find(p => p.mimeType === 'text/html');
//             if (htmlPart) {
//               const html = extractBody(htmlPart);
//               // Basic HTML stripping
//               return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
//             }
//             // Recurse into first part
//             return extractBody(part.parts[0]);
//           }
//           return '';
//         };
//         body = extractBody(detail.data.payload);
//         // Limit body length for storage
//         body = body.substring(0, 2000);
        
//         emails.push({
//           id: detail.data.id,
//           threadId: detail.data.threadId,
//           from: fromMatch?.[1]?.trim() || fromMatch?.[2]?.split('@')[0] || 'Unknown',
//           fromEmail: fromMatch?.[2] || fromRaw,
//           to: getHeader('To'),
//           subject: getHeader('Subject') || '(No Subject)',
//           date: new Date(getHeader('Date')),
//           dateFormatted: new Date(getHeader('Date')).toLocaleString('en-US', {
//             weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
//           }),
//           snippet: detail.data.snippet || '',
//           body: body || detail.data.snippet || '', // Include full body for context
//           isUnread: detail.data.labelIds?.includes('UNREAD'),
//           labels: detail.data.labelIds || [],
//           // Calculate importance score for filtering
//           importanceScore: calculateEmailImportance(
//             getHeader('Subject'),
//             fromMatch?.[1]?.trim() || '',
//             fromMatch?.[2] || '',
//             detail.data.labelIds || [],
//             detail.data.snippet || ''
//           )
//         });
//       } catch (e) {
//         console.error(`[Chat] Error fetching email ${msg.id}:`, e.message);
//       }
//     }

//     // ===== FILTER BY IMPORTANCE (unless showAll) =====
//     let filteredEmails = emails;
//     if (!params.showAll && !params.includePromotions) {
//       filteredEmails = emails.filter(e => e.importanceScore >= 3); // Score 3+ = important
//       // If too few important emails, include some lower scored ones
//       if (filteredEmails.length < 2 && emails.length > 0) {
//         filteredEmails = emails.slice(0, Math.min(5, emails.length));
//       }
//     }

//     // Sort by date if requested
//     if (params.sortBy === 'date_desc') {
//       filteredEmails.sort((a, b) => new Date(b.date) - new Date(a.date));
//     }

//     return { success: true, emails: filteredEmails, count: filteredEmails.length, query, totalFetched: emails.length };
//   } catch (error) {
//     console.error('[Chat] Gmail fetch error:', error.message);
//     if (error.message.includes('Invalid Credentials') || error.code === 401) {
//       return { success: false, error: 'Gmail credentials expired. Please reconnect from Integrations.' };
//     }
//     return { success: false, error: error.message };
//   }
// };

// const formatGmailDate = (date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;

// // ============================================
// // SLACK MESSAGE SEARCH
// // ============================================
// const axios = require('axios');

// const searchSlackMessages = async (userId, params = {}) => {
//   try {
//     // Try to get user token first (required for search)
//     let slackToken = await integrationHelper.getUserAccessToken(userId, 'slack');
    
//     // Fallback to bot token if user token not found (though search will likely fail)
//     if (!slackToken) {
//       console.log('[Chat] No Slack user token found, trying bot token');
//       slackToken = await integrationHelper.getAccessToken(userId, 'slack');
//     }
    
//     if (!slackToken) {
//       console.log('[Chat] No Slack token found for user');
//       return { success: false, error: 'Slack not connected. Please connect from Integrations page.' };
//     }

//     const { query, channel, from, limit = 20 } = params;
    
//     // Build search query
//     let searchQuery = query || '*';
//     if (channel) searchQuery += ` in:${channel}`;
//     if (from) searchQuery += ` from:${from}`;

//     console.log(`[Chat] Slack search query: "${searchQuery}"`);

//     // Search messages using Slack API
//     const searchRes = await axios.get('https://slack.com/api/search.messages', {
//       headers: {
//         'Authorization': `Bearer ${slackToken}`,
//         'Content-Type': 'application/json'
//       },
//       params: {
//         query: searchQuery,
//         count: limit,
//         sort: 'timestamp',
//         sort_dir: 'desc'
//       }
//     });

//     if (!searchRes.data.ok) {
//       console.error('[Chat] Slack search error:', searchRes.data.error);
//       return { success: false, error: searchRes.data.error };
//     }

//     const messages = searchRes.data.messages?.matches || [];
    
//     // Format messages for display
//     const formattedMessages = messages.map(msg => ({
//       id: msg.ts,
//       channel: msg.channel?.name || 'Unknown',
//       channelId: msg.channel?.id,
//       from: msg.username || msg.user || 'Unknown',
//       text: msg.text?.substring(0, 500) || '',
//       date: new Date(parseFloat(msg.ts) * 1000),
//       dateFormatted: new Date(parseFloat(msg.ts) * 1000).toLocaleString('en-US', {
//         weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
//       }),
//       permalink: msg.permalink
//     }));

//     return { 
//       success: true, 
//       messages: formattedMessages, 
//       count: formattedMessages.length,
//       total: searchRes.data.messages?.total || 0
//     };
//   } catch (error) {
//     console.error('[Chat] Slack search error:', error.message);
//     return { success: false, error: error.message };
//   }
// };

// // Get list of Slack channels user has access to
// const getSlackChannels = async (userId) => {
//   try {
//     const slackToken = await integrationHelper.getAccessToken(userId, 'slack');
    
//     if (!slackToken) {
//       return { success: false, error: 'Slack not connected' };
//     }

//     const channelsRes = await axios.get('https://slack.com/api/conversations.list', {
//       headers: {
//         'Authorization': `Bearer ${slackToken}`,
//         'Content-Type': 'application/json'
//       },
//       params: {
//         types: 'public_channel,private_channel',
//         limit: 100
//       }
//     });

//     if (!channelsRes.data.ok) {
//       return { success: false, error: channelsRes.data.error };
//     }

//     // Return only channels user is member of
//     const channels = channelsRes.data.channels
//       .filter(ch => ch.is_member)
//       .map(ch => ({
//         id: ch.id,
//         name: ch.name,
//         isPrivate: ch.is_private,
//         memberCount: ch.num_members
//       }));

//     return { success: true, channels };
//   } catch (error) {
//     console.error('[Chat] Slack channels error:', error.message);
//     return { success: false, error: error.message };
//   }
// };

// // ============================================
// // CALENDAR FETCHER
// // ============================================
// const fetchCalendarEvents = async (userId, params = {}) => {
//   try {
//     const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
//     if (!accessToken && !refreshToken) {
//       return { success: false, error: 'Calendar not connected' };
//     }

//     const auth = new google.auth.OAuth2(
//       process.env.GOOGLE_CLIENT_ID,
//       process.env.GOOGLE_CLIENT_SECRET
//     );
//     auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

//     const calendar = google.calendar({ version: 'v3', auth });

//     // Determine time range
//     const now = new Date();
//     let timeMin = new Date(now);
//     let timeMax = new Date(now);
//     timeMax.setDate(timeMax.getDate() + 7); // Default: next week

//     if (params.dateRange === 'today') {
//       timeMin.setHours(0, 0, 0, 0);
//       timeMax = new Date(timeMin);
//       timeMax.setDate(timeMax.getDate() + 1);
//     } else if (params.dateRange === 'tomorrow') {
//       timeMin.setDate(timeMin.getDate() + 1);
//       timeMin.setHours(0, 0, 0, 0);
//       timeMax = new Date(timeMin);
//       timeMax.setDate(timeMax.getDate() + 1);
//     }

//     const eventsRes = await calendar.events.list({
//       calendarId: 'primary',
//       timeMin: timeMin.toISOString(),
//       timeMax: timeMax.toISOString(),
//       singleEvents: true,
//       orderBy: 'startTime',
//       maxResults: 20
//     });

//     const events = (eventsRes.data.items || []).map(e => ({
//       id: e.id,
//       title: e.summary || '(No title)',
//       start: e.start?.dateTime || e.start?.date,
//       end: e.end?.dateTime || e.end?.date,
//       location: e.location,
//       attendees: e.attendees?.map(a => ({ email: a.email, name: a.displayName })) || [],
//       description: e.description,
//       isAllDay: !e.start?.dateTime
//     }));

//     return { success: true, events, count: events.length };
//   } catch (error) {
//     console.error('[Chat] Calendar fetch error:', error.message);
//     return { success: false, error: error.message };
//   }
// };

// // ============================================
// // SEND EMAIL VIA GMAIL API
// // ============================================
// const sendEmail = async (userId, { to, subject, body }) => {
//   try {
//     const { accessToken, refreshToken } = await integrationHelper.getGoogleToken(userId);
    
//     if (!accessToken && !refreshToken) {
//       return { success: false, error: 'Gmail not connected' };
//     }

//     const auth = new google.auth.OAuth2(
//       process.env.GOOGLE_CLIENT_ID,
//       process.env.GOOGLE_CLIENT_SECRET
//     );
//     auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

//     const gmail = google.gmail({ version: 'v1', auth });

//     // Get user's email
//     const profile = await gmail.users.getProfile({ userId: 'me' });
//     const fromEmail = profile.data.emailAddress;

//     // Create email
//     const emailLines = [
//       `From: ${fromEmail}`,
//       `To: ${Array.isArray(to) ? to.join(', ') : to}`,
//       `Subject: ${subject}`,
//       'Content-Type: text/plain; charset=utf-8',
//       '',
//       body
//     ];
    
//     const email = emailLines.join('\r\n');
//     const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

//     const result = await gmail.users.messages.send({
//       userId: 'me',
//       requestBody: { raw: encodedEmail }
//     });

//     console.log(`[Chat] Email sent successfully: ${result.data.id}`);
//     return { success: true, messageId: result.data.id };
//   } catch (error) {
//     console.error('[Chat] Send email error:', error.message);
//     return { success: false, error: error.message };
//   }
// };

// // ============================================
// // PROACTIVE RESPONSE GENERATOR - Always suggests next actions
// // ============================================
// const generateProactiveResponse = async (userQuery, context, dataType = 'general', sources = []) => {
//   const sourceContext = sources.length > 0 
//     ? `\nSOURCES REFERENCED:\n${sources.map((s, i) => `${i+1}. ${s.type}: ${s.title || s.description || 'Untitled'}`).join('\n')}`
//     : '';

//   const prompt = `
// You are HiCapy, a proactive AI personal assistant - think of yourself as a founder's office intern who anticipates needs.

// USER QUESTION: "${userQuery}"

// AVAILABLE DATA:
// ${context}
// ${sourceContext}

// === RESPONSE RULES ===
// 1. Answer the question clearly with markdown formatting
// 2. Be specific - use actual names, dates, times from the data
// 3. For emails: show From, Subject, Date, and key content
// 4. For meetings: mention speakers, topic, key points

// === PROACTIVE ASSISTANT RULES (CRITICAL) ===
// After answering, ALWAYS end with 2-3 proactive suggestions based on context.
// Think: "What would a helpful intern suggest next?"

// Examples of proactive suggestions:
// - After showing an email: "Would you like me to **reply to this email**? Or **schedule a follow-up call**?"
// - After showing a meeting: "Should I **send meeting notes to attendees**? Or **create follow-up tasks**?"
// - After knowledge search: "Want me to **set a reminder** about this? Or **draft a message to the team**?"
// - After calendar check: "Should I **block time** for this? Or **send a calendar invite** to someone?"
// - After task discussion: "Want me to **mark this complete**? Or **reschedule it**?"

// Format your suggestions like:
// ---
// 💡 **What would you like to do next?**
// - 📧 Reply to [person] confirming availability
// - 📅 Create a calendar event for [topic]
// - ✍️ Draft a summary to share with team

// Keep suggestions specific to the context, not generic.
// `;

//   try {
//     const completion = await groq.chat.completions.create({
//       messages: [{ role: 'user', content: prompt }],
//       model: 'llama-3.1-8b-instant',
//       temperature: 0.4,
//       max_tokens: 1200
//     });
    
//     return completion.choices[0].message.content;
//   } catch (error) {
//     console.error('[Chat] AI generation error:', error);
//     return 'I encountered an error generating a response. Please try again.';
//   }
// };

// // ============================================
// // MAIN CHAT HANDLER
// // ============================================
// exports.chat = async (req, res) => {
//   try {
//     const { message, history, pendingAction, lastEmailContext, conversationContext } = req.body;
//     const userId = req.user.id;

//     console.log(`\n[Chat] ========== New Message ==========`);
//     console.log(`[Chat] User: ${userId}`);
//     console.log(`[Chat] Message: "${message}"`);
//     console.log(`[Chat] Has pending action: ${!!pendingAction}`);
//     console.log(`[Chat] History length: ${history?.length || 0}`);
//     console.log(`[Chat] Conversation context: emails=${conversationContext?.emails?.length || 0}, meetings=${conversationContext?.meetings?.length || 0}`);

//     // ===== RESOLVE REFERENCES BEFORE ANALYSIS =====
//     // Handle: "email 2", "email from subhradeep", "that meeting email", "the client acquisition one"
//     let resolvedContext = { ...lastEmailContext };
    
//     if (conversationContext?.emails?.length > 0) {
//       // Pattern 1: "email 2", "email #2", "2nd email"
//       const emailNumMatch = message.match(/email\s*#?\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*email/i);
//       if (emailNumMatch) {
//         const emailIndex = parseInt(emailNumMatch[1] || emailNumMatch[2]);
//         const referencedEmail = conversationContext.emails.find(e => e.index === emailIndex);
//         if (referencedEmail) {
//           console.log(`[Chat] Resolved "email ${emailIndex}" to:`, referencedEmail.subject);
//           resolvedContext = { ...resolvedContext, ...referencedEmail };
//         }
//       }
      
//       // Pattern 2: "email from [name]", "meeting with [name]", "[name]'s email"
//       const namePatterns = [
//         /(?:email|mail|message)\s+(?:from|by)\s+(\w+)/i,
//         /(\w+)(?:'s|s)\s+(?:email|mail|message)/i,
//         /(?:meeting|schedule|call)\s+with\s+(\w+)/i,
//         /with\s+(\w+)\s+at/i
//       ];
//       for (const pattern of namePatterns) {
//         const nameMatch = message.match(pattern);
//         if (nameMatch) {
//           const searchName = nameMatch[1].toLowerCase();
//           // Find email from that person (check from name, not just email)
//           const matchedEmail = conversationContext.emails.find(e => 
//             e.from?.toLowerCase().includes(searchName) || 
//             e.fromEmail?.toLowerCase().includes(searchName)
//           );
//           if (matchedEmail) {
//             console.log(`[Chat] Resolved "${searchName}" to email:`, matchedEmail.subject);
//             resolvedContext = { ...resolvedContext, ...matchedEmail };
//             break;
//           }
//         }
//       }
      
//       // Pattern 3: "the client acquisition one", "fix the client acquisition meeting", "client acquisition email"
//       const subjectPatterns = [
//         /(?:the|that)\s+([a-zA-Z\s]+?)\s+(?:email|mail|one|meeting)/i,
//         /(?:fix|schedule|create)\s+(?:the\s+)?([a-zA-Z\s]+?)\s+(?:meeting|event|call)/i,
//         /(?:about|regarding|for)\s+([a-zA-Z\s]+)/i,
//         /([a-zA-Z\s]+?)\s+(?:email|meeting)/i
//       ];
//       for (const pattern of subjectPatterns) {
//         const subjectMatch = message.match(pattern);
//         if (subjectMatch && !resolvedContext.subject) {
//           const searchTerm = subjectMatch[1].toLowerCase().trim();
//           // Skip generic words
//           if (['the', 'a', 'an', 'this', 'that', 'my', 'event', 'from'].includes(searchTerm)) continue;
          
//           const matchedEmail = conversationContext.emails.find(e => 
//             e.subject?.toLowerCase().includes(searchTerm) ||
//             e.snippet?.toLowerCase().includes(searchTerm)
//           );
//           if (matchedEmail) {
//             console.log(`[Chat] Resolved topic "${searchTerm}" to email:`, matchedEmail.subject);
//             resolvedContext = { ...resolvedContext, ...matchedEmail };
//             break;
//           }
//         }
//       }
//     }

//     // 1. ANALYZE THE QUERY with full context using intelligent parser
//     // The new parser uses LLM + conversation history instead of regex
//     // Pass ALL context: history, pending action, resolved email, and full conversation context (emails/meetings)
//     let analysis = await analyzeQuery(message, history, pendingAction, resolvedContext, conversationContext);
//     console.log(`[Chat] Category: ${analysis.category}, SubIntent: ${analysis.subIntent}, Confidence: ${analysis.confidence}`);
    
//     // If LLM resolved a target (email/meeting), use it
//     if (analysis.resolvedTarget && Object.keys(analysis.resolvedTarget).length > 0) {
//       if (analysis.resolvedTarget.fromEmail || analysis.resolvedTarget.subject) {
//         console.log(`[Chat] LLM resolved reference to:`, analysis.resolvedTarget.subject || analysis.resolvedTarget.from);
//         // Merge LLM-resolved context with any pre-resolved context
//         resolvedContext = { 
//           ...resolvedContext, 
//           from: analysis.resolvedTarget.from || resolvedContext.from,
//           fromEmail: analysis.resolvedTarget.fromEmail || resolvedContext.fromEmail,
//           subject: analysis.resolvedTarget.subject || resolvedContext.subject,
//           extractedTime: analysis.resolvedTarget.extractedTime || resolvedContext.extractedTime,
//           extractedPurpose: analysis.resolvedTarget.extractedPurpose || resolvedContext.extractedPurpose
//         };
//       }
//     }

//     // ===== HANDLE LOW CONFIDENCE / CLARIFICATION NEEDED =====
//     if (analysis.needsClarification && analysis.confidence < 0.6 && analysis.clarificationQuestion) {
//       console.log(`[Chat] Low confidence (${analysis.confidence}), asking for clarification`);
//       return res.json({
//         reply: `🤔 ${analysis.clarificationQuestion}`,
//         sources: [],
//         action: null,
//         needsClarification: true
//       });
//     }

//     // 2. HANDLE CONTEXT-BASED ACTIONS (using info from previous messages)
//     if (analysis.category === 'action_from_context') {
//       console.log('[Chat] Creating action from conversation context');
//       const extracted = analysis.extractedFromContext || {};
      
//       // Schedule meeting from context
//       if (analysis.subIntent === 'schedule_meeting') {
//         // ===== KEY FIX: Use pre-extracted time from resolvedContext first =====
//         // This is the structured data from the frontend, not LLM guessing
//         let startDateTime = null;
//         let formattedTime = 'Not specified';
        
//         // ===== MULTI-SOURCE TIME EXTRACTION =====
//         // Try multiple sources in order of reliability
//         let timeSource = null;
        
//         // Source 1: Frontend extracted time (already parsed)
//         if (resolvedContext?.extractedTime) {
//           timeSource = resolvedContext.extractedTime;
//           console.log(`[Chat] Time from frontend context: "${timeSource}"`);
//         }
        
//         // Source 2: LLM extracted time
//         if (!timeSource && extracted.time) {
//           timeSource = extracted.time;
//           console.log(`[Chat] Time from LLM extraction: "${timeSource}"`);
//         }
        
//         // Source 3: Extract directly from email body/snippet (backup)
//         if (!timeSource && (resolvedContext?.body || resolvedContext?.snippet)) {
//           const textToSearch = (resolvedContext.body || '') + ' ' + (resolvedContext.snippet || '');
//           const timePatterns = [
//             /tomorrow\s+at\s+(\d{1,2})\s*(am|pm)?/i,
//             /today\s+at\s+(\d{1,2})\s*(am|pm)?/i,
//             /(\d{1,2})\s*(am|pm)\s+tomorrow/i,
//             /(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2})\s*(am|pm)?/i,
//             /\bat\s+(\d{1,2})\s*(am|pm)/i,
//           ];
//           for (const pattern of timePatterns) {
//             const match = textToSearch.match(pattern);
//             if (match) {
//               timeSource = match[0];
//               console.log(`[Chat] Time extracted from body: "${timeSource}"`);
//               break;
//             }
//           }
//         }
        
//         console.log(`[Chat] Final time source: "${timeSource}"`);
        
//         if (timeSource) {
//           const parsedTime = await parseNaturalTime(timeSource);
//           if (parsedTime?.dateTime) {
//             startDateTime = new Date(parsedTime.dateTime);
//             formattedTime = parsedTime.formatted || startDateTime.toLocaleString();
//             console.log(`[Chat] Parsed time: ${formattedTime}`);
//           } else {
//             formattedTime = timeSource;
//           }
//         }

//         // ===== KEY FIX: Use attendee from resolvedContext =====
//         const resolvedAttendees = [];
        
//         // Priority 1: Use fromEmail from frontend context (most reliable)
//         if (resolvedContext?.fromEmail && resolvedContext.fromEmail.includes('@')) {
//           resolvedAttendees.push(resolvedContext.fromEmail);
//           console.log(`[Chat] Added attendee from context: ${resolvedContext.fromEmail}`);
//         }
        
//         // Priority 2: Use LLM extracted attendees
//         if (extracted.attendees?.length > 0) {
//           for (const email of extracted.attendees) {
//             if (email?.includes('@') && !resolvedAttendees.includes(email)) {
//               resolvedAttendees.push(email);
//             }
//           }
//         }
//         if (extracted.attendeeNames?.length > 0) {
//           for (const name of extracted.attendeeNames) {
//             const contact = await resolveContact(userId, name);
//             if (contact.email && !resolvedAttendees.includes(contact.email)) {
//               resolvedAttendees.push(contact.email);
//             }
//           }
//         }

//         // ===== KEY FIX: Use title from resolvedContext =====
//         const meetingTitle = resolvedContext?.extractedPurpose || resolvedContext?.subject || extracted.title || analysis.meetingParams?.title || 'Meeting';
//         console.log(`[Chat] Meeting title: "${meetingTitle}"`);

//         // Calculate end time
//         const duration = analysis.meetingParams?.duration || 60;
//         let endDateTime = null;
//         if (startDateTime) {
//           endDateTime = new Date(startDateTime.getTime() + duration * 60 * 1000);
//         }

//         // Create the meeting action
//         const action = await Action.create({
//           userId,
//           type: 'schedule_meeting',
//           source: 'chat',
//           status: 'pending',
//           payload: {
//             title: meetingTitle,
//             startTime: startDateTime?.toISOString(),
//             endTime: endDateTime?.toISOString(),
//             attendees: resolvedAttendees,
//             description: `Created from chat context`,
//             assignBot: analysis.meetingParams?.assignBot || false
//           }
//         });

//         const pendingMeetingAction = {
//           id: action._id,
//           type: 'schedule_meeting',
//           payload: action.payload
//         };

//         let replyMessage = `📅 **Meeting Ready to Schedule**\n\n`;
//         replyMessage += `**Title:** ${meetingTitle}\n`;
//         replyMessage += `**When:** ${formattedTime}\n`;
//         if (resolvedAttendees.length > 0) {
//           replyMessage += `**Attendees:** ${resolvedAttendees.join(', ')}\n`;
//         }
//         replyMessage += `\n🔗 A **Google Meet link** will be automatically created.\n`;
        
//         // Add proactive suggestion
//         if (analysis.proactiveSuggestion) {
//           replyMessage += `\n💡 *${analysis.proactiveSuggestion}*\n`;
//         }
        
//         replyMessage += `\nSay **"schedule it"** to confirm, or tell me what to change.`;

//         return res.json({
//           reply: replyMessage,
//           sources: [],
//           action: pendingMeetingAction
//         });
//       }

//       // Reply to email from context
//       if (analysis.subIntent === 'reply_to_email') {
//         const replyTo = extracted.replyTo;
//         const originalSubject = extracted.emailSubject;

//         // Generate reply content
//         const genPrompt = `Generate a brief, professional email confirming availability for a meeting. The user is replying to confirm they can attend. Keep it short and friendly.`;
//         const completion = await groq.chat.completions.create({
//           messages: [{ role: 'user', content: genPrompt }],
//           model: 'llama-3.1-8b-instant',
//           temperature: 0.5,
//           max_tokens: 300
//         });
//         const emailBody = completion.choices[0].message.content;

//         const action = await Action.create({
//           userId,
//           type: 'draft_reply',
//           source: 'chat',
//           status: 'pending',
//           payload: {
//             recipients: replyTo ? [replyTo] : [],
//             subject: originalSubject ? `Re: ${originalSubject.replace(/^Re:\s*/i, '')}` : 'Re: Meeting Confirmation',
//             body: emailBody
//           }
//         });

//         const pendingEmailAction = {
//           id: action._id,
//           type: 'send_email',
//           payload: action.payload
//         };

//         return res.json({
//           reply: `📧 **Reply Draft Ready**\n\n**To:** ${replyTo || 'Not specified'}\n**Subject:** ${action.payload.subject}\n\n---\n${emailBody}\n---\n\nSay **"send it"** to send, or tell me what changes you'd like.`,
//           sources: [],
//           action: pendingEmailAction
//         });
//       }
//     }

//     // 3. HANDLE ACTION CONFIRMATIONS (send, approve, yes, schedule it)
//     if (analysis.category === 'action_confirm' || analysis.isConfirmation) {
//       console.log('[Chat] Received pendingAction from frontend:', pendingAction);
      
//       // If no pendingAction provided, try to find the most recent pending action for this user
//       let actionToExecute = pendingAction;
//       if (!actionToExecute) {
//         console.log('[Chat] No pendingAction in request, checking database...');
//         const recentAction = await Action.findOne({ 
//           userId, 
//           status: 'pending',
//           type: { $in: ['draft_reply', 'send_email', 'schedule_meeting'] }
//         }).sort({ createdAt: -1 });
        
//         if (recentAction) {
//           console.log('[Chat] Found pending action in database:', recentAction._id, recentAction.type);
//           actionToExecute = {
//             id: recentAction._id,
//             type: recentAction.type === 'draft_reply' ? 'send_email' : recentAction.type,
//             payload: recentAction.payload
//           };
//         }
//       }
      
//       if (actionToExecute) {
//         console.log(`[Chat] Executing action: ${actionToExecute.type}`);
        
//         if (actionToExecute.type === 'send_email' || actionToExecute.type === 'draft_reply') {
//           const result = await sendEmail(userId, {
//             to: actionToExecute.payload.recipients,
//             subject: actionToExecute.payload.subject,
//             body: actionToExecute.payload.body
//           });

//           if (result.success) {
//             // Update action status
//             if (actionToExecute.id) {
//               await Action.findByIdAndUpdate(actionToExecute.id, { 
//                 status: 'approved', 
//                 resolvedAt: new Date() 
//               });
//             }
//             return res.json({
//               reply: `✅ **Email sent successfully!**\n\nYour email to **${actionToExecute.payload.recipients.join(', ')}** with subject "**${actionToExecute.payload.subject}**" has been delivered.`,
//               sources: [],
//               action: null,
//               actionExecuted: true
//             });
//           } else {
//             return res.json({
//               reply: `❌ **Failed to send email:** ${result.error}\n\nPlease check your Gmail integration.`,
//               sources: [],
//               action: actionToExecute // Keep action for retry
//             });
//           }
//         }
        
//         // Handle other action types...
//         if (actionToExecute.type === 'schedule_meeting') {
//           console.log('[Chat] Executing meeting creation:', actionToExecute.payload);
          
//           try {
//             const result = await calendarService.createEvent(userId, {
//               title: actionToExecute.payload.title,
//               startTime: actionToExecute.payload.startTime,
//               endTime: actionToExecute.payload.endTime,
//               attendees: actionToExecute.payload.attendees || [],
//               description: actionToExecute.payload.description || '',
//               createMeetLink: true,
//               sendNotifications: true
//             });

//             if (result.success) {
//               // Update action status
//               if (actionToExecute.id) {
//                 await Action.findByIdAndUpdate(actionToExecute.id, { 
//                   status: 'approved', 
//                   resolvedAt: new Date(),
//                   'payload.eventId': result.eventId,
//                   'payload.meetLink': result.meetLink
//                 });
//               }

//               // If user requested bot assignment, handle it
//               let botMessage = '';
//               if (actionToExecute.payload.assignBot && result.meetLink) {
//                 const botResult = await assignBotToMeeting(userId, result.meetLink, actionToExecute.payload.title);
//                 if (botResult.success) {
//                   botMessage = `\n\n🤖 **Bot Assigned:** ${botResult.botName} will join and record the meeting.`;
//                 } else {
//                   botMessage = `\n\n⚠️ Could not assign bot: ${botResult.error}`;
//                 }
//               }

//               const attendeeList = actionToExecute.payload.attendees?.length > 0 
//                 ? `\n**Attendees:** ${actionToExecute.payload.attendees.join(', ')}` 
//                 : '';

//               return res.json({
//                 reply: `✅ **Meeting Scheduled Successfully!**\n\n📅 **${actionToExecute.payload.title}**\n**When:** ${result.start?.dateTime ? new Date(result.start.dateTime).toLocaleString() : 'Scheduled'}${attendeeList}\n\n🔗 **Google Meet Link:** ${result.meetLink || 'Not available'}\n\n[Open in Calendar](${result.htmlLink})${botMessage}`,
//                 sources: [],
//                 action: null,
//                 actionExecuted: true,
//                 meetingData: {
//                   eventId: result.eventId,
//                   meetLink: result.meetLink,
//                   htmlLink: result.htmlLink
//                 }
//               });
//             } else {
//               return res.json({
//                 reply: `❌ **Failed to create meeting:** ${result.error}\n\nPlease check your Calendar integration.`,
//                 sources: [],
//                 action: actionToExecute
//               });
//             }
//           } catch (error) {
//             console.error('[Chat] Meeting creation error:', error);
//             return res.json({
//               reply: `❌ **Failed to create meeting:** ${error.message}`,
//               sources: [],
//               action: actionToExecute
//             });
//           }
//         }
//       } else {
//         return res.json({
//           reply: "I don't have a pending action to confirm. What would you like me to do?",
//           sources: [],
//           action: null
//         });
//       }
//     }

//     // 2.5 HANDLE ACTION MODIFICATIONS (improve body, change subject, etc.)
//     if (analysis.category === 'action_modify' || analysis.isModification) {
//       console.log('[Chat] Modifying pending action:', analysis.modificationRequest);
      
//       // Get the pending action from request or database
//       let actionToModify = pendingAction;
//       if (!actionToModify) {
//         const recentAction = await Action.findOne({ 
//           userId, 
//           status: 'pending',
//           type: { $in: ['draft_reply', 'send_email'] }
//         }).sort({ createdAt: -1 });
        
//         if (recentAction) {
//           actionToModify = {
//             id: recentAction._id,
//             type: 'send_email',
//             payload: recentAction.payload
//           };
//         }
//       }
      
//       if (actionToModify && actionToModify.payload) {
//         const currentBody = actionToModify.payload.body || '';
//         const currentSubject = actionToModify.payload.subject || 'Hello';
//         const recipients = actionToModify.payload.recipients || [];
        
//         // Use AI to improve/modify the content
//         const modifyPrompt = `
// You are helping improve an email draft.

// CURRENT EMAIL:
// To: ${recipients.join(', ')}
// Subject: ${currentSubject}
// Body: ${currentBody}

// USER REQUEST: "${message}"

// ${analysis.subIntent === 'modify_subject' 
//   ? 'Generate ONLY a new subject line. Return just the subject text, nothing else.'
//   : 'Generate an improved email body based on the user\'s request. Keep the core message but make it better. Return just the body text, nothing else.'}`;

//         const completion = await groq.chat.completions.create({
//           messages: [{ role: 'user', content: modifyPrompt }],
//           model: 'llama-3.1-8b-instant',
//           temperature: 0.5,
//           max_tokens: 500
//         });
        
//         const newContent = completion.choices[0].message.content.trim();
        
//         // Update the action in database
//         let updatedPayload = { ...actionToModify.payload };
//         if (analysis.subIntent === 'modify_subject') {
//           updatedPayload.subject = newContent;
//         } else {
//           updatedPayload.body = newContent;
//         }
        
//         if (actionToModify.id) {
//           await Action.findByIdAndUpdate(actionToModify.id, { 
//             payload: updatedPayload 
//           });
//         }
        
//         const updatedAction = {
//           id: actionToModify.id,
//           type: 'send_email',
//           payload: updatedPayload
//         };
        
//         return res.json({
//           reply: `📧 **Email Draft Updated**\n\n**To:** ${recipients.join(', ')}\n**Subject:** ${updatedPayload.subject}\n\n---\n${updatedPayload.body}\n---\n\nSay **"send it"** to send, or tell me what other changes you'd like.`,
//           sources: [],
//           action: updatedAction
//         });
//       } else {
//         return res.json({
//           reply: "I don't have an email draft to modify. Would you like to compose a new email?",
//           sources: [],
//           action: null
//         });
//       }
//     }

//     // 5. HANDLE EMAIL QUERIES
//     if (analysis.category === 'email') {
//       console.log(`[Chat] Fetching emails with params:`, analysis.searchParams);
//       const emailResult = await fetchEmails(userId, analysis.searchParams || {});

//       if (!emailResult.success) {
//         return res.json({
//           reply: `⚠️ ${emailResult.error}`,
//           sources: [],
//           action: null
//         });
//       }

//       if (emailResult.emails.length === 0) {
//         return res.json({
//           reply: `📭 **No emails found** matching your query.\n\nI searched with: \`${emailResult.query || 'all inbox'}\`\n\nTry:\n- Checking a different time range\n- Searching by sender name\n- Removing specific filters`,
//           sources: [],
//           action: null
//         });
//       }

//       // Build context and generate proactive response
//       const emailContextStr = emailResult.emails.map((e, i) => 
//         `Email ${i + 1}:\n  From: ${e.from} <${e.fromEmail}>\n  Subject: ${e.subject}\n  Date: ${e.dateFormatted}\n  Preview: ${e.snippet}`
//       ).join('\n\n');

//       // Generate response with proactive suggestions
//       const proactivePrompt = `
// You are HiCapy, a proactive AI personal assistant.
// Present the email information AND suggest next actions.

// USER QUESTION: "${message}"

// EMAIL DATA:
// ${emailContextStr}

// RULES:
// 1. Present the email details clearly (From, Subject, Date, Preview)
// 2. ANALYZE the email content for actionable items:
//    - If it mentions a meeting time → Suggest "Would you like me to create a calendar event?"
//    - If it's asking for a reply → Suggest "Would you like me to draft a reply?"
//    - If it needs follow-up → Suggest appropriate action
// 3. Be concise but helpful
// 4. Use markdown formatting

// Example for meeting request email:
// "Based on this email, it looks like **[Name]** wants to meet **[time]** about **[topic]**.

// Would you like me to:
// - 📅 **Create a calendar event** for this meeting?
// - ✉️ **Send a reply** confirming your availability?"
// `;

//       const completion = await groq.chat.completions.create({
//         messages: [{ role: 'user', content: proactivePrompt }],
//         model: 'llama-3.1-8b-instant',
//         temperature: 0.3,
//         max_tokens: 800
//       });
      
//       const reply = completion.choices[0].message.content;
      
//       // Extract first email as context for follow-up actions
//       const firstEmail = emailResult.emails[0];
//       const emailContextForFrontend = {
//         from: firstEmail.from,
//         fromEmail: firstEmail.fromEmail,
//         subject: firstEmail.subject,
//         date: firstEmail.dateFormatted,
//         snippet: firstEmail.snippet
//       };
      
//       return res.json({
//         reply,
//         // Include full email data in sources for context persistence
//         sources: emailResult.emails.slice(0, 10).map((e, idx) => ({ 
//           type: 'email',
//           index: idx + 1, // 1-based index for "email 1", "email 2" references
//           id: e.id,
//           title: e.subject, 
//           from: e.from,
//           fromEmail: e.fromEmail,
//           snippet: e.snippet,
//           body: (e.body || e.snippet || '').substring(0, 500), // Limit body size but keep for extraction
//           date: e.dateFormatted || e.date
//         })),
//         action: null,
//         emailContext: emailContextForFrontend // Pass email context for follow-up
//       });
//     }

//     // 6. HANDLE SLACK QUERIES
//     if (analysis.category === 'slack') {
//       console.log(`[Chat] Searching Slack messages:`, analysis.slackParams);
      
//       const slackResult = await searchSlackMessages(userId, {
//         query: analysis.slackParams?.query || message,
//         channel: analysis.slackParams?.channel,
//         from: analysis.slackParams?.from,
//         limit: 15
//       });

//       if (!slackResult.success) {
//         return res.json({
//           reply: `⚠️ ${slackResult.error}`,
//           sources: [],
//           action: null
//         });
//       }

//       if (slackResult.messages.length === 0) {
//         return res.json({
//           reply: `🔍 No Slack messages found matching your search.\n\nTry a different search term or check if you have access to the channel.`,
//           sources: [],
//           action: null
//         });
//       }

//       // Build rich sources for Slack messages
//       const slackSources = slackResult.messages.map(msg => ({
//         type: 'slack',
//         id: msg.id,
//         title: msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : ''),
//         from: msg.from,
//         channel: msg.channel,
//         date: msg.dateFormatted,
//         permalink: msg.permalink
//       }));

//       // Format messages for LLM context
//       const slackContext = slackResult.messages.map((msg, i) => 
//         `${i + 1}. **${msg.from}** in #${msg.channel} (${msg.dateFormatted}):\n   "${msg.text}"`
//       ).join('\n\n');

//       const reply = await generateProactiveResponse(
//         message, 
//         `Slack Search Results (${slackResult.count} messages found, ${slackResult.total} total):\n\n${slackContext}`,
//         'slack',
//         slackSources
//       );

//       return res.json({
//         reply,
//         sources: slackSources,
//         action: null
//       });
//     }

//     // 7. HANDLE CALENDAR QUERIES
//     if (analysis.category === 'calendar') {
//       const calResult = await fetchCalendarEvents(userId, analysis.searchParams || {});

//       if (!calResult.success) {
//         return res.json({
//           reply: `⚠️ ${calResult.error}`,
//           sources: [],
//           action: null
//         });
//       }

//       // Build rich sources for calendar events
//       const calendarSources = calResult.events.map(e => ({
//         type: 'calendar',
//         id: e.id,
//         title: e.title,
//         date: new Date(e.start).toLocaleDateString(),
//         time: new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
//         attendees: e.attendees?.map(a => a.name || a.email).slice(0, 3) || [],
//         location: e.location || null
//       }));

//       const calContext = calResult.events.length > 0
//         ? calResult.events.map((e, i) => {
//             const start = new Date(e.start).toLocaleString();
//             const attendeeList = e.attendees?.length > 0 ? ` with ${e.attendees.map(a => a.name || a.email).join(', ')}` : '';
//             return `Event ${i + 1}: "${e.title}" at ${start}${attendeeList}${e.location ? `, Location: ${e.location}` : ''}`;
//           }).join('\n')
//         : 'No events found for the requested time period.';

//       const reply = await generateProactiveResponse(message, calContext, 'calendar', calendarSources);
//       return res.json({ 
//         reply, 
//         sources: calendarSources,
//         action: null 
//       });
//     }

//     // 7. HANDLE KNOWLEDGE QUERIES (meetings, transcripts, tasks)
//     if (analysis.category === 'knowledge') {
//       console.log(`[Chat] Searching knowledge base:`, analysis.knowledgeQuery);
      
//       // Build search query from knowledge params
//       const searchTerms = [
//         analysis.knowledgeQuery?.speakerName,
//         analysis.knowledgeQuery?.topic,
//         analysis.knowledgeQuery?.meetingTitle,
//         ...(analysis.knowledgeQuery?.searchTerms || [])
//       ].filter(Boolean).join(' ') || message;

//       const knowledgeResults = await knowledgeService.searchKnowledge(userId, searchTerms);
      
//       if (knowledgeResults.relevantContext) {
//         // Build rich sources
//         const sources = [];
//         if (knowledgeResults.meetings?.length > 0) {
//           knowledgeResults.meetings.slice(0, 3).forEach(m => {
//             sources.push({ 
//               type: 'meeting', 
//               id: m._id || m.id,
//               title: m.title || 'Meeting',
//               date: m.start_time ? new Date(m.start_time).toLocaleDateString() : m.date,
//               time: m.start_time ? new Date(m.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null,
//               speakers: m.speakers || [],
//               hasTranscript: m.has_transcript || false
//             });
//           });
//         }
//         if (knowledgeResults.tasks?.length > 0) {
//           knowledgeResults.tasks.slice(0, 2).forEach(t => {
//             sources.push({ 
//               type: 'task', 
//               id: t._id || t.id,
//               title: t.description || t.title,
//               status: t.status || 'pending',
//               dueDate: t.due_date ? new Date(t.due_date).toLocaleDateString() : null,
//               assignee: t.assignee || null
//             });
//           });
//         }

//         const reply = await generateProactiveResponse(message, knowledgeResults.relevantContext, 'knowledge', sources);

//         return res.json({ reply, sources, action: null });
//       }
//     }

//     // 6. HANDLE ACTION CREATION (compose email, schedule meeting)
//     if (analysis.category === 'action') {
//       console.log('[Chat] Handling action creation:', analysis.subIntent);
      
//       // ===== SCHEDULE MEETING =====
//       if (analysis.subIntent === 'schedule_meeting') {
//         const meetingParams = analysis.meetingParams || {};
        
//         // Parse the time expression
//         let parsedTime = null;
//         let formattedTime = 'Not specified';
//         let startDateTime = null;
        
//         if (meetingParams.timeRaw || meetingParams.time) {
//           const timeExpression = meetingParams.timeRaw || meetingParams.time;
//           parsedTime = await parseNaturalTime(timeExpression);
          
//           if (parsedTime && parsedTime.dateTime) {
//             startDateTime = new Date(parsedTime.dateTime);
//             formattedTime = parsedTime.formatted || startDateTime.toLocaleString();
//           } else {
//             formattedTime = timeExpression;
//           }
//         }

//         // Resolve attendee emails from names
//         const resolvedAttendees = [];
//         const attendeeNames = meetingParams.attendeeNames || [];
//         const attendeeEmails = meetingParams.attendees || [];
        
//         // Add any direct emails
//         for (const email of attendeeEmails) {
//           if (email && email.includes('@')) {
//             resolvedAttendees.push(email);
//           }
//         }
        
//         // Resolve names to emails
//         const unresolvedNames = [];
//         for (const name of attendeeNames) {
//           const contact = await resolveContact(userId, name);
//           if (contact.email) {
//             resolvedAttendees.push(contact.email);
//           } else {
//             unresolvedNames.push(name);
//           }
//         }

//         // Calculate end time (default 1 hour duration)
//         const duration = meetingParams.duration || 60;
//         let endDateTime = null;
//         if (startDateTime) {
//           endDateTime = new Date(startDateTime.getTime() + duration * 60 * 1000);
//         }

//         // Create pending action
//         const action = await Action.create({
//           userId,
//           type: 'schedule_meeting',
//           source: 'chat',
//           status: 'pending',
//           payload: {
//             title: meetingParams.title || 'New Meeting',
//             startTime: startDateTime?.toISOString(),
//             endTime: endDateTime?.toISOString(),
//             attendees: resolvedAttendees,
//             description: meetingParams.description || '',
//             assignBot: meetingParams.assignBot || false
//           },
//           context: {
//             reasoning: `User requested: "${message}"`,
//             unresolvedNames,
//             timeExpression: meetingParams.timeRaw || meetingParams.time
//           }
//         });

//         const pendingAction = {
//           id: action._id,
//           type: 'schedule_meeting',
//           payload: action.payload
//         };

//         // Build response
//         let replyMessage = `📅 **Meeting Ready to Schedule**\n\n`;
//         replyMessage += `**Title:** ${meetingParams.title || 'New Meeting'}\n`;
//         replyMessage += `**When:** ${formattedTime}\n`;
        
//         if (resolvedAttendees.length > 0) {
//           replyMessage += `**Attendees:** ${resolvedAttendees.join(', ')}\n`;
//         }
        
//         if (unresolvedNames.length > 0) {
//           replyMessage += `\n⚠️ **Couldn't find email for:** ${unresolvedNames.join(', ')}\n`;
//           replyMessage += `Please provide their email addresses, or I'll create the meeting without them.\n`;
//         }
        
//         if (meetingParams.assignBot) {
//           replyMessage += `\n🤖 **Bot will be assigned** to record the meeting.\n`;
//         }
        
//         replyMessage += `\n🔗 A **Google Meet link** will be automatically created.\n`;
//         replyMessage += `\nSay **"schedule it"** to confirm, or tell me what to change.`;

//         return res.json({
//           reply: replyMessage,
//           sources: [],
//           action: pendingAction
//         });
//       }

//       // ===== COMPOSE EMAIL =====
//       if (analysis.subIntent === 'compose_email') {
//         const emailParams = analysis.emailParams || {};
        
//         // Resolve recipient emails
//         const resolvedRecipients = [];
//         const recipientNames = emailParams.recipientNames || [];
//         const recipientEmails = emailParams.recipients || [];
        
//         // Add direct emails
//         for (const email of recipientEmails) {
//           if (email && email.includes('@')) {
//             resolvedRecipients.push(email);
//           }
//         }
        
//         // Resolve names
//         const unresolvedNames = [];
//         for (const name of recipientNames) {
//           const contact = await resolveContact(userId, name);
//           if (contact.email) {
//             resolvedRecipients.push(contact.email);
//           } else {
//             unresolvedNames.push(name);
//           }
//         }

//         // Generate email content
//         let emailSubject = emailParams.subject || 'Hello';
//         let emailBody = emailParams.body || '';
//         let meetLinkNote = '';

//         // If user wants to include a meeting link, check for recent meeting
//         if (emailParams.includeMeetLink) {
//           const recentMeeting = await Action.findOne({
//             userId,
//             type: 'schedule_meeting',
//             status: 'approved',
//             'payload.meetLink': { $exists: true }
//           }).sort({ resolvedAt: -1 });

//           if (recentMeeting?.payload?.meetLink) {
//             meetLinkNote = `\n\nMeeting Link: ${recentMeeting.payload.meetLink}`;
//           }
//         }

//         // Generate email content if not specified
//         if (!emailBody || emailBody.length < 10) {
//           const genPrompt = `Generate a professional email body for: "${message}". ${meetLinkNote ? 'Include the meeting link naturally.' : ''} Keep it brief and friendly.`;
//           const completion = await groq.chat.completions.create({
//             messages: [{ role: 'user', content: genPrompt }],
//             model: 'llama-3.1-8b-instant',
//             temperature: 0.5,
//             max_tokens: 400
//           });
//           emailBody = completion.choices[0].message.content;
//           if (meetLinkNote && !emailBody.includes('meet.google.com')) {
//             emailBody += meetLinkNote;
//           }
//         }

//         // Create draft action
//         const action = await Action.create({
//           userId,
//           type: 'draft_reply',
//           source: 'chat',
//           status: 'pending',
//           payload: {
//             recipients: resolvedRecipients,
//             subject: emailSubject,
//             body: emailBody
//           },
//           context: {
//             reasoning: `User requested: "${message}"`,
//             unresolvedNames
//           }
//         });

//         const pendingAction = {
//           id: action._id,
//           type: 'send_email',
//           payload: action.payload
//         };

//         let replyMessage = `📧 **Email Draft Ready**\n\n`;
//         replyMessage += `**To:** ${resolvedRecipients.length > 0 ? resolvedRecipients.join(', ') : 'Not specified'}\n`;
//         replyMessage += `**Subject:** ${emailSubject}\n\n`;
//         replyMessage += `---\n${emailBody}\n---\n`;
        
//         if (unresolvedNames.length > 0) {
//           replyMessage += `\n⚠️ **Couldn't find email for:** ${unresolvedNames.join(', ')}\n`;
//           replyMessage += `Please provide their email addresses.\n`;
//         }
        
//         replyMessage += `\nSay **"send it"** to send, or tell me what changes you'd like.`;

//         return res.json({
//           reply: replyMessage,
//           sources: [],
//           action: pendingAction
//         });
//       }
//     }

//     // 9. GENERAL CHAT - Use full context with proactive suggestions
//     console.log('[Chat] Falling back to general chat with knowledge search');
    
//     // Search all knowledge sources
//     const knowledgeResults = await knowledgeService.searchKnowledge(userId, message);
//     const memories = await mem0Service.search(message, userId);
    
//     // Build rich sources
//     const generalSources = [];
//     if (knowledgeResults.meetings?.length > 0) {
//       knowledgeResults.meetings.slice(0, 2).forEach(m => {
//         generalSources.push({
//           type: 'meeting',
//           id: m._id || m.id,
//           title: m.title || 'Meeting',
//           date: m.start_time ? new Date(m.start_time).toLocaleDateString() : null,
//           speakers: m.speakers || []
//         });
//       });
//     }
//     if (memories.length > 0) {
//       memories.slice(0, 2).forEach(m => {
//         generalSources.push({
//           type: 'memory',
//           id: m.id,
//           title: m.text?.substring(0, 50) + '...' || 'Memory',
//           date: m.created_at ? new Date(m.created_at).toLocaleDateString() : null
//         });
//       });
//     }
    
//     let fullContext = '';
//     if (knowledgeResults.relevantContext) {
//       fullContext += knowledgeResults.relevantContext;
//     }
//     if (memories.length > 0) {
//       fullContext += '\n\n=== MEMORIES ===\n' + memories.map(m => m.text).join('\n');
//     }

//     const reply = await generateProactiveResponse(message, fullContext || 'No specific context found.', 'general', generalSources);

//     res.json({
//       reply,
//       sources: generalSources,
//       action: null
//     });

//   } catch (error) {
//     console.error('[Chat] Error:', error);
//     res.status(500).json({ 
//       error: 'Failed to process chat',
//       details: error.message 
//     });
//   }
// };

// // ============================================
// // DAILY BRIEFING - Proactive & Actionable
// // ============================================
// exports.getDailyBriefing = async (req, res) => {
//   try {
//     const userId = req.user.id;
//     const user = await User.findById(userId);

//     // Get today's calendar
//     const calResult = await fetchCalendarEvents(userId, { dateRange: 'today' });
    
//     // Get recent emails (more for analysis)
//     const emailResult = await fetchEmails(userId, { limit: 10, sortBy: 'date_desc' });
    
//     // Get pending actions
//     const pendingActions = await Action.find({ 
//       userId, 
//       status: 'pending' 
//     }).sort({ createdAt: -1 }).limit(5);

//     // Get recent activity
//     const recentActivity = await knowledgeService.getRecentActivity(userId, 3);

//     // ANALYZE EMAILS FOR URGENCY/ACTION NEEDED
//     let emailsNeedingAttention = [];
//     if (emailResult.success && emailResult.emails?.length > 0) {
//       const analysisPrompt = `
// Analyze these emails and identify which ones NEED ATTENTION or require a response.

// EMAILS:
// ${emailResult.emails.map((e, i) => `${i+1}. From: ${e.from} <${e.fromEmail}>
//    Subject: ${e.subject}
//    Date: ${e.dateFormatted}
//    Preview: ${e.snippet}
// `).join('\n')}

// Return ONLY a JSON array of objects for emails needing attention:
// [
//   {
//     "index": 1,
//     "reason": "Meeting request - needs confirmation",
//     "urgency": "high" | "medium" | "low",
//     "suggestedAction": "Reply to confirm availability"
//   }
// ]

// Rules:
// - Meeting requests = high urgency
// - Questions needing answers = medium urgency  
// - FYI emails = low urgency (skip these)
// - Only include actionable emails, not newsletters/marketing
// - Return empty array [] if no emails need attention
// `;

//       try {
//         const analysisCompletion = await groq.chat.completions.create({
//           messages: [{ role: 'user', content: analysisPrompt }],
//           model: 'llama-3.1-8b-instant',
//           temperature: 0.2,
//           max_tokens: 500
//         });
        
//         const analysisContent = analysisCompletion.choices[0].message.content.trim();
//         const jsonMatch = analysisContent.match(/\[[\s\S]*\]/);
//         if (jsonMatch) {
//           const needsAttention = JSON.parse(jsonMatch[0]);
//           emailsNeedingAttention = needsAttention.map(item => ({
//             ...emailResult.emails[item.index - 1],
//             reason: item.reason,
//             urgency: item.urgency,
//             suggestedAction: item.suggestedAction
//           })).filter(e => e.fromEmail);
//         }
//       } catch (e) {
//         console.error('[Briefing] Email analysis error:', e);
//       }
//     }

//     // Generate proactive briefing
//     const briefingPrompt = `
// You are HiCapy, a proactive AI personal assistant. Generate a helpful daily briefing.

// USER: ${user?.name || user?.email?.split('@')[0]}
// CURRENT TIME: ${new Date().toLocaleString()}

// TODAY'S SCHEDULE:
// ${calResult.events?.length > 0 
//   ? calResult.events.map(e => `- ${new Date(e.start).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${e.title}${e.attendees?.length ? ` (with ${e.attendees.length} attendees)` : ''}`).join('\n')
//   : 'No meetings scheduled today'}

// EMAILS NEEDING ATTENTION:
// ${emailsNeedingAttention.length > 0
//   ? emailsNeedingAttention.map(e => `- [${e.urgency?.toUpperCase()}] From ${e.from}: "${e.subject}" - ${e.reason}`).join('\n')
//   : 'No urgent emails'}

// PENDING TASKS:
// ${pendingActions.length > 0
//   ? pendingActions.map(a => `- ${a.type}: ${a.payload?.subject || a.payload?.title}`).join('\n')
//   : 'No pending actions'}

// Generate a brief, friendly morning briefing that:
// 1. Greets the user by name
// 2. Summarizes their day at a glance
// 3. HIGHLIGHTS any emails needing attention with specific actions
// 4. Suggests what to tackle first
// 5. Keep it under 200 words
// `;

//     let briefingText = '';
//     try {
//       const briefingCompletion = await groq.chat.completions.create({
//         messages: [{ role: 'user', content: briefingPrompt }],
//         model: 'llama-3.1-8b-instant',
//         temperature: 0.5,
//         max_tokens: 400
//       });
//       briefingText = briefingCompletion.choices[0].message.content;
//     } catch (e) {
//       briefingText = `Good morning! You have ${calResult.events?.length || 0} meetings today and ${emailsNeedingAttention.length} emails needing attention.`;
//     }

//     res.json({
//       briefing: briefingText,
//       stats: {
//         meetingCount: calResult.events?.length || 0,
//         emailCount: emailResult.emails?.length || 0,
//         pendingActionCount: pendingActions.length,
//         taskCount: recentActivity.tasks?.length || 0,
//         urgentEmailCount: emailsNeedingAttention.filter(e => e.urgency === 'high').length
//       },
//       meetings: calResult.events || [],
//       emails: emailResult.emails?.slice(0, 5) || [],
//       emailsNeedingAttention: emailsNeedingAttention,
//       pendingActions
//     });

//   } catch (error) {
//     console.error('[Briefing] Error:', error);
//     res.status(500).json({ error: 'Failed to generate briefing' });
//   }
// };

// // ============================================
// // SAVE FEEDBACK FOR LEARNING
// // ============================================
// exports.saveFeedback = async (req, res) => {
//   try {
//     const { messageId, isPositive, messageText, sources, timestamp } = req.body;
//     const userId = req.user.id;

//     // Determine time context
//     const now = new Date();
//     const hour = now.getHours();
//     const timeOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
//     const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });

//     // Determine category from sources
//     let category = 'general';
//     if (sources?.length > 0) {
//       category = sources[0].type || 'general';
//     }

//     // Save feedback
//     await Feedback.create({
//       userId,
//       messageId: messageId?.toString() || Date.now().toString(),
//       isPositive,
//       messageText: messageText?.substring(0, 500),
//       sources: sources?.slice(0, 5),
//       category,
//       feedbackContext: {
//         timeOfDay,
//         dayOfWeek,
//         responseLength: messageText?.length || 0
//       }
//     });

//     console.log(`[Feedback] User ${userId} ${isPositive ? 'liked' : 'disliked'} ${category} response`);

//     // Optionally, update user preferences based on feedback patterns
//     // This can be used to personalize future responses
//     const recentFeedback = await Feedback.find({ userId }).sort({ createdAt: -1 }).limit(50);
//     const likedCategories = recentFeedback.filter(f => f.isPositive).map(f => f.category);
//     const dislikedCategories = recentFeedback.filter(f => !f.isPositive).map(f => f.category);

//     // Calculate preferences
//     const preferences = {};
//     for (const cat of [...new Set([...likedCategories, ...dislikedCategories])]) {
//       const liked = likedCategories.filter(c => c === cat).length;
//       const disliked = dislikedCategories.filter(c => c === cat).length;
//       preferences[cat] = { liked, disliked, score: liked - disliked };
//     }

//     console.log(`[Feedback] User preferences:`, preferences);

//     res.json({ success: true, message: 'Feedback recorded' });
//   } catch (error) {
//     console.error('[Feedback] Error:', error);
//     res.status(500).json({ error: 'Failed to save feedback' });
//   }
// };
