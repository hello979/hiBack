const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const { 
  HICAPY_MAIN_PROMPT, 
  INTENT_CLASSIFICATION_PROMPT, 
  EMAIL_DRAFT_PROMPT,
  MEETING_SCHEDULE_PROMPT,
  LEARNING_PROMPT,
  BRIEFING_PROMPT,
  TOPIC_SHIFT_PROMPT,
  STRUCTURED_UI_PROMPT
} = require('../config/prompts');
const contextManager = require('./contextManager');

// ============================================
// 3-TYPE INTENT CLASSIFICATION
// Distinguishes: information, action, exploratory
// ============================================
exports.classifyIntent = async ({ message, conversationHistory, lastReferences, userPreferences, conversationContext }) => {
  // Use conversation context if provided, otherwise build from history
  let historyText = conversationContext || '';
  if (!historyText && conversationHistory) {
    historyText = conversationHistory
      .slice(-10)
      .map(m => `${m.role || m.sender}: ${m.content || m.text}`)
      .join('\n');
  }
  
  // Build last references including tasks
  const lastTasksText = lastReferences?.tasks?.length > 0 
    ? lastReferences.tasks.map((t, i) => `${i+1}. ${t.description}`).join(', ')
    : 'None';
  
  const prompt = INTENT_CLASSIFICATION_PROMPT
    .replace('{conversationHistory}', historyText || 'No prior messages')
    .replace('{message}', message)
    .replace('{lastEmail}', lastReferences?.email ? `"${lastReferences.email.subject}" from ${lastReferences.email.from}` : 'None')
    .replace('{lastPerson}', lastReferences?.person ? `${lastReferences.person.name} (${lastReferences.person.email})` : 'None')
    .replace('{lastMeeting}', lastReferences?.meeting ? `"${lastReferences.meeting.title}" on ${lastReferences.meeting.date}` : 'None')
    .replace('{lastTasks}', lastTasksText);

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 800
    });
    
    const result = JSON.parse(completion.choices[0].message.content);
    console.log('[AI] Intent classification:', result.intentType, result.confidence);
    return result;
  } catch (error) {
    console.error('[AI] Intent classification error:', error.message);
    return { 
      intentType: 'information', 
      confidence: 0.5, 
      reasoning: 'Failed to classify, defaulting to information',
      requiresContext: true,
      contextQuery: message
    };
  }
};

// ============================================
// EMAIL DRAFT GENERATION
// Creates drafts matching user's style
// ============================================
exports.generateEmailDraft = async ({ request, context, emailThread, userPreferences, recipientInfo }) => {
  const prompt = EMAIL_DRAFT_PROMPT
    .replace('{request}', request)
    .replace('{context}', context?.map(c => `- [${c.source}] ${c.text}`).join('\n') || 'No context available')
    .replace('{emailThread}', emailThread || 'New email (not a reply)')
    .replace('{formality}', userPreferences?.communicationStyle || 'professional')
    .replace('{greeting}', userPreferences?.emailStyle?.greeting || 'Hi')
    .replace('{closing}', userPreferences?.emailStyle?.closing || 'Best')
    .replace('{signature}', userPreferences?.emailStyle?.signature || '')
    .replace('{relationship}', recipientInfo?.relationship || 'unknown');

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 1000
    });
    
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('[AI] Email draft error:', error.message);
    return null;
  }
};

// ============================================
// MEETING SCHEDULE GENERATION
// Creates meeting details respecting preferences
// ============================================
exports.generateMeetingDetails = async ({ request, context, userPreferences, attendeeContext }) => {
  const prefs = userPreferences?.preferences || {};
  
  const prompt = MEETING_SCHEDULE_PROMPT
    .replace('{request}', request)
    .replace('{context}', context?.map(c => `- [${c.source}] ${c.text}`).join('\n') || 'No context available')
    .replace('{preferredTimes}', prefs.preferredTimes?.join(', ') || '9am-5pm')
    .replace('{bufferMinutes}', prefs.meetingBufferMinutes || 15)
    .replace('{noMeetingDays}', prefs.noMeetingDays?.join(', ') || 'None')
    .replace('{workingHours}', `${prefs.workingHours?.start || '09:00'} - ${prefs.workingHours?.end || '17:00'}`)
    .replace('{attendeeContext}', attendeeContext || 'No attendee information');

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 800
    });
    
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('[AI] Meeting generation error:', error.message);
    return null;
  }
};

// ============================================
// LEARNING EXTRACTION
// Extracts preferences from user edits/corrections
// ============================================
exports.extractLearning = async ({ original, edited, context }) => {
  const prompt = LEARNING_PROMPT
    .replace('{original}', original)
    .replace('{edited}', edited)
    .replace('{context}', context || 'General interaction');

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 600
    });
    
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('[AI] Learning extraction error:', error.message);
    return { learnings: [], acknowledgment: null };
  }
};

// ============================================
// EMAIL CLASSIFICATION (1 API call, cached)
// ============================================
exports.classifyEmail = async (email) => {
  const prompt = `
    Classify this email for a personal assistant system.
    
    FROM: ${email.from}
    SUBJECT: ${email.subject}
    PREVIEW: ${email.snippet}
    
    Return JSON:
    {
      "shouldProcess": true/false,  // Should the assistant take action?
      "category": "work" | "client" | "personal" | "promotional" | "newsletter" | "unknown",
      "intent": "request_info" | "meeting_request" | "follow_up" | "question" | "update" | "unknown",
      "urgency": "low" | "normal" | "high" | "critical",
      "confidence": 0-100
    }
    
    Rules:
    - promotional/newsletter = shouldProcess: false
    - Direct questions or requests = shouldProcess: true
    - Meeting requests = high priority
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0.1
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('Classification error:', error.message);
    return { shouldProcess: true, category: 'unknown', intent: 'unknown', urgency: 'normal', confidence: 50 };
  }
};

// ============================================
// ACTION GENERATION (Context-aware)
// ============================================
exports.generateAction = async ({ email, context, intent, userPreferences }) => {
  const systemPrompt = `
    You are Hicapy, an autonomous AI Chief of Staff. You TAKE ACTIONS, not just suggest them.
    
    INCOMING EMAIL:
    From: ${email.from}
    Subject: ${email.subject}
    Body: ${email.snippet}
    
    KNOWLEDGE GRAPH CONTEXT:
    ${context.facts || 'No prior context found.'}
    
    RELEVANT SOURCES:
    ${context.sources?.map(s => `- [${s.source}] ${s.date}: ${s.text}`).join('\n') || 'None'}
    
    USER PREFERENCES:
    ${JSON.stringify(userPreferences || {})}
    
    DETECTED INTENT: ${intent}
    
    TASK: Generate an action plan.
    
    RULES:
    1. If they request a file/data mentioned in context, draft reply with it
    2. If meeting request, check preferences and propose time
    3. If you need info you don't have, ask for clarification
    4. Always explain your reasoning citing sources
    5. Be professional but match the sender's tone
    
    OUTPUT JSON:
    {
      "actionType": "draft_reply" | "schedule_meeting" | "follow_up" | "clarify",
      "confidence": 0-100,
      "payload": {
        "subject": "Re: original subject",
        "body": "The full email draft text",
        "reasoning": "Why you chose this action and what context you used"
      }
    }
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'system', content: systemPrompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0.3
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error('Action generation error:', error.message);
    return {
      actionType: 'clarify',
      confidence: 30,
      payload: {
        subject: `Re: ${email.subject}`,
        body: 'I need more context to respond to this email properly.',
        reasoning: 'Failed to generate action due to an error.'
      }
    };
  }
};

// ============================================
// CHAT RESPONSE (RAG-powered with full context)
// Uses the comprehensive HiCapy system prompt
// ============================================
exports.generateChatResponse = async ({ 
  query, 
  context, 
  history, 
  userPreferences, 
  intentType,
  lastReferences,
  pendingAction,
  hasWidget = false // NEW: Flag to indicate if a UI widget is present
}) => {
  // Separate fresh data (from live APIs) from cached context
  const freshCalendarData = context?.filter(c => c.source === 'google_calendar') || [];
  const freshEmailData = context?.filter(c => c.source === 'gmail') || [];
  const otherContext = context?.filter(c => c.source !== 'google_calendar' && c.source !== 'gmail') || [];
  
  // Build context section - FRESH DATA FIRST
  let contextSection = '';
  
  if (freshCalendarData.length > 0) {
    contextSection += '**FRESH CALENDAR DATA (from Google Calendar API - use this for calendar questions):**\n';
    contextSection += freshCalendarData.map(c => `- ${c.text}`).join('\n');
    contextSection += '\n\n';
  }
  
  if (freshEmailData.length > 0) {
    contextSection += '**FRESH EMAIL DATA (from Gmail API - use this for email questions):**\n';
    contextSection += freshEmailData.map(c => `- ${c.text}`).join('\n');
    contextSection += '\n\n';
  }
  
  if (otherContext.length > 0) {
    contextSection += '**Additional Context:**\n';
    contextSection += otherContext.map(c => `- [${c.source}] ${c.date || ''}: ${c.text}`).join('\n');
  }
  
  if (!contextSection) {
    contextSection = 'No relevant context found.';
  }
  
  // Build last references section for pronoun resolution
  const referencesSection = [];
  if (lastReferences?.email) {
    referencesSection.push(`Last mentioned email: "${lastReferences.email.subject}" from ${lastReferences.email.from}`);
  }
  if (lastReferences?.person) {
    referencesSection.push(`Last mentioned person: ${lastReferences.person.name} (${lastReferences.person.email})`);
  }
  if (lastReferences?.meeting) {
    referencesSection.push(`Last mentioned meeting: "${lastReferences.meeting.title}" on ${lastReferences.meeting.date}`);
  }

  // Build the dynamic context injection
  const dynamicContext = `
## Current Session Context

**User's Query:** "${query}"

**Detected Intent Type:** ${intentType || 'information'}

**IMPORTANT: If FRESH DATA is provided below, use it to answer the query. Do NOT use old meeting/email info from conversation history when fresh data is available.**

${contextSection}

**Last Referenced Entities (for pronoun resolution):**
${referencesSection.length > 0 ? referencesSection.join('\n') : 'None'}

**User Preferences:**
- Communication Style: ${userPreferences?.communicationStyle || 'professional'}
- Working Hours: ${userPreferences?.workingHours?.start || '09:00'} - ${userPreferences?.workingHours?.end || '17:00'}
- Meeting Buffer: ${userPreferences?.meetingBufferMinutes || 15} minutes

${pendingAction ? `**Pending Action Awaiting Approval:** ${pendingAction.type} - ${pendingAction.payload?.subject || pendingAction.payload?.title || 'Action'}` : ''}

${hasWidget ? `
**CRITICAL INSTRUCTION FOR WIDGET DISPLAY:**
A structured UI widget (like an email list or calendar view) is ALREADY being shown to the user.
1. DO NOT repeat the list of items in your text response.
2. DO NOT offer text-based buttons like "Read | Save | Forward".
3. Keep your response extremely brief (1 sentence).
   Example: "Here are your latest emails." or "I've found these meetings for you."
` : ''}
`;

  // Combine main prompt with dynamic context
  const fullSystemPrompt = HICAPY_MAIN_PROMPT + '\n\n' + dynamicContext;

  // Build messages array with full conversation history (up to 20 messages)
  const messages = [
    { role: 'system', content: fullSystemPrompt },
    ...(history || []).slice(-20).map(h => ({
      role: h.role || (h.sender === 'user' ? 'user' : 'assistant'),
      content: h.content || h.text
    }))
  ];

  // INJECT FRESH DATA AGAIN AFTER HISTORY TO OVERRIDE HALLUCINATIONS
  // This ensures the LLM prioritizes this data over conversation history
  if (freshCalendarData.length > 0 || freshEmailData.length > 0) {
    let freshDataReminder = "SYSTEM UPDATE: Fresh data has just been fetched from live APIs.\n";
    
    if (freshCalendarData.length > 0) {
      freshDataReminder += "CURRENT CALENDAR (Authoritative):\n" + freshCalendarData.map(c => `- ${c.text}`).join('\n') + "\n";
      freshDataReminder += "Ignore any meetings mentioned in previous messages that do not appear in this list.\n";
    }
    
    if (freshEmailData.length > 0) {
      freshDataReminder += "CURRENT EMAILS (Authoritative):\n" + freshEmailData.map(c => `- ${c.text}`).join('\n') + "\n";
    }

    messages.push({ role: 'system', content: freshDataReminder });
  } else if (context?.some(c => c.text.includes('No meetings scheduled'))) {
    // Explicitly remind about empty calendar if applicable
    messages.push({ 
      role: 'system', 
      content: "SYSTEM UPDATE: Live calendar check shows NO meetings. Ignore any meetings mentioned in previous conversation history." 
    });
  }

  // Add user query last
  messages.push({ role: 'user', content: query });

  try {
    const completion = await groq.chat.completions.create({
      messages,
      model: 'llama-3.1-8b-instant',
      temperature: 0.5,
      max_tokens: 1200
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('[AI] Chat response error:', error.message);
    return "I'm having trouble processing that right now. Could you try rephrasing your request?";
  }
};

// ============================================
// ACTION RESPONSE GENERATION
// Generates response with approval buttons format
// ============================================
exports.generateActionResponse = async ({
  actionType,
  draft,
  context,
  userRequest,
  isHighStakes
}) => {
  let actionDescription = '';
  let draftPreview = '';
  
  if (actionType === 'send_email' || actionType === 'draft_reply') {
    actionDescription = `send an email to **${draft.to?.join(', ') || 'recipient'}**`;
    draftPreview = `
**To:** ${draft.to?.join(', ') || 'Not specified'}
${draft.cc?.length > 0 ? `**CC:** ${draft.cc.join(', ')}` : ''}
**Subject:** ${draft.subject || 'No subject'}

---
${draft.body || 'No content'}
---`;
  } else if (actionType === 'schedule_meeting') {
    const startDate = draft.startTime ? new Date(draft.startTime) : null;
    actionDescription = `schedule a meeting: **${draft.title}**`;
    draftPreview = `
**Title:** ${draft.title}
**When:** ${startDate ? startDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'TBD'} at ${startDate ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBD'}
**Duration:** ${draft.duration || 60} minutes
**Attendees:** ${draft.attendees?.join(', ') || 'Not specified'}
${draft.location ? `**Location:** ${draft.location}` : ''}
${draft.description ? `**Description:** ${draft.description}` : ''}`;
  } else if (actionType === 'reschedule_meeting') {
    actionDescription = `reschedule the meeting **${draft.title}** to a new time`;
    draftPreview = `**New Time:** ${draft.newTime}`;
  } else if (actionType === 'cancel_meeting') {
    actionDescription = `cancel the meeting: **${draft.title}**`;
    draftPreview = draft.notifyAttendees ? 'Attendees will be notified.' : '';
  } else if (actionType === 'assign_bot' || actionType === 'start_meeting_with_bot') {
    actionDescription = `assign **${draft.botName || 'a bot'}** to the meeting **${draft.meetingTitle || 'your meeting'}**`;
    draftPreview = `**Bot:** ${draft.botName}\n**Meeting:** ${draft.meetingTitle}`;
  } else if (actionType === 'assign_task') {
    actionDescription = `assign the task **"${draft.taskDescription}"** to **${draft.teammateName || 'a teammate'}**`;
    draftPreview = `**Task:** ${draft.taskDescription}\n**Assignee:** ${draft.teammateName}`;
  } else if (actionType === 'send_team_invite') {
    actionDescription = `send a team invitation to **${draft.inviteName || draft.inviteEmail}**`;
    draftPreview = `**Invitee:** ${draft.inviteName || draft.inviteEmail}`;
  }

  // Build context citation
  const contextCitation = context?.length > 0 
    ? `Based on: ${context.slice(0, 2).map(c => `${c.source} from ${c.date || 'recently'}`).join(', ')}`
    : '';

  // High-stakes warning
  const highStakesWarning = isHighStakes 
    ? `\n\n⚠️ **This is a high-stakes action:** ${draft.highStakesReason || 'Please review carefully before approving.'}\n`
    : '';

  return `I'll ${actionDescription} for you. Please review the details below:

${highStakesWarning}
${contextCitation}`;
};

// ============================================
// STRUCTURED UI RESPONSE GENERATION
// Returns response with embedded UI components
// ============================================
exports.generateStructuredResponse = async ({
  actionType,
  draft,
  context,
  userRequest,
  isHighStakes,
  pendingItems = []
}) => {
  // Generate action buttons based on action type
  const generateActionButtons = (type, payload, isHighStakes) => {
    const baseActions = [];
    
    switch (type) {
      case 'send_email':
      case 'draft_reply':
        baseActions.push(
          { label: 'Send Draft', action_id: `send_${payload._id || Date.now()}`, style: 'primary', icon: 'send' },
          { label: 'Edit Draft', action_id: `edit_${payload._id || Date.now()}`, style: 'secondary', icon: 'edit' },
          { label: 'Add Details', action_id: `edit_details_${payload._id || Date.now()}`, style: 'secondary', icon: 'plus' }
        );
        break;
      case 'schedule_meeting':
        baseActions.push(
          { label: 'Create Event', action_id: `create_${payload._id || Date.now()}`, style: 'primary', icon: 'calendar' },
          { label: 'Modify', action_id: `edit_${payload._id || Date.now()}`, style: 'secondary', icon: 'edit' },
          { label: 'Cancel', action_id: 'cancel', style: 'danger', icon: 'x' }
        );
        break;
      case 'reschedule_meeting':
        baseActions.push(
          { label: 'Confirm Reschedule', action_id: `reschedule_${payload._id || Date.now()}`, style: 'primary', icon: 'calendar' },
          { label: 'Pick Different Time', action_id: `edit_${payload._id || Date.now()}`, style: 'secondary', icon: 'edit' },
          { label: 'Keep Original', action_id: 'cancel', style: 'secondary', icon: 'x' }
        );
        break;
      case 'cancel_meeting':
        baseActions.push(
          { label: 'Confirm Cancellation', action_id: `cancel_meeting_${payload._id || Date.now()}`, style: 'danger', icon: 'x' },
          { label: 'Keep Meeting', action_id: 'cancel', style: 'secondary', icon: 'check' }
        );
        break;
      case 'assign_bot':
      case 'start_meeting_with_bot':
        baseActions.push(
          { label: 'Assign Bot', action_id: `assign_bot_${payload._id || Date.now()}`, style: 'primary', icon: 'bot' },
          { label: 'Choose Different Bot', action_id: `edit_${payload._id || Date.now()}`, style: 'secondary', icon: 'edit' },
          { label: 'Cancel', action_id: 'cancel', style: 'danger', icon: 'x' }
        );
        break;
      case 'assign_task':
        baseActions.push(
          { label: 'Assign Task', action_id: `assign_task_${payload._id || Date.now()}`, style: 'primary', icon: 'check' },
          { label: 'Edit Assignment', action_id: `edit_${payload._id || Date.now()}`, style: 'secondary', icon: 'edit' },
          { label: 'Cancel', action_id: 'cancel', style: 'danger', icon: 'x' }
        );
        break;
      default:
        baseActions.push(
          { label: 'Confirm', action_id: `confirm_${Date.now()}`, style: 'primary', icon: 'check' },
          { label: 'Cancel', action_id: 'cancel', style: 'danger', icon: 'x' }
        );
    }

    // Add extra confirmation step for high-stakes actions
    if (isHighStakes) {
      baseActions[0].requiresConfirmation = true;
      baseActions[0].confirmationMessage = draft.highStakesReason || 'Are you sure? This action cannot be undone.';
    }

    return baseActions;
  };

  // Build preview content
  const buildPreview = (type, payload) => {
    switch (type) {
      case 'send_email':
      case 'draft_reply':
        return {
          type: 'email',
          content: {
            to: payload.to || payload.recipients,
            cc: payload.cc,
            subject: payload.subject,
            body: payload.body,
            from: 'You'
          }
        };
      case 'schedule_meeting':
      case 'reschedule_meeting':
        return {
          type: 'meeting',
          content: {
            title: payload.title,
            startTime: payload.startTime,
            endTime: payload.endTime,
            attendees: payload.attendees,
            location: payload.location,
            description: payload.description
          }
        };
      case 'assign_task':
        return {
          type: 'task',
          content: {
            description: payload.taskDescription,
            assignee: payload.teammateName,
            dueDate: payload.dueDate
          }
        };
      default:
        return null;
    }
  };

  // Generate descriptive text
  let actionDescription = '';
  switch (actionType) {
    case 'send_email':
    case 'draft_reply':
      actionDescription = `send an email to **${draft.to?.join(', ') || draft.recipients?.join(', ') || 'recipient'}**`;
      break;
    case 'schedule_meeting':
      actionDescription = `schedule a meeting: **${draft.title}**`;
      break;
    case 'reschedule_meeting':
      actionDescription = `reschedule **${draft.title}**`;
      break;
    case 'cancel_meeting':
      actionDescription = `cancel the meeting: **${draft.title}**`;
      break;
    case 'assign_bot':
      actionDescription = `assign **${draft.botName || 'a bot'}** to your meeting`;
      break;
    case 'assign_task':
      actionDescription = `assign the task to **${draft.teammateName || 'a teammate'}**`;
      break;
    default:
      actionDescription = 'complete this action';
  }

  const contextCitation = context?.length > 0 
    ? `\n\n*Based on: ${context.slice(0, 2).map(c => c.source).join(', ')}*`
    : '';

  const highStakesWarning = isHighStakes
    ? `\n\n⚠️ **Review carefully:** ${draft.highStakesReason || 'This is a significant action.'}`
    : '';

  // Determine widget type for Slashy-style renderer
  const getWidgetType = (type) => {
    switch (type) {
      case 'send_email':
      case 'draft_reply':
        return 'email_draft';
      case 'schedule_meeting':
      case 'reschedule_meeting':
      case 'cancel_meeting':
        return 'calendar_event';
      case 'assign_task':
        return 'task';
      default:
        return 'action';
    }
  };

  // Get widget title for Slashy-style header
  const getWidgetTitle = (type) => {
    switch (type) {
      case 'send_email':
      case 'draft_reply':
        return 'Email Draft';
      case 'schedule_meeting':
        return 'Schedule Meeting';
      case 'reschedule_meeting':
        return 'Reschedule Meeting';
      case 'cancel_meeting':
        return 'Cancel Meeting';
      case 'assign_task':
        return 'Task Assignment';
      default:
        return 'Action';
    }
  };

  return {
    text: `I'll ${actionDescription} for you.${highStakesWarning}${contextCitation}`,
    ui_component: {
      type: getWidgetType(actionType),
      status: 'draft',
      title: getWidgetTitle(actionType),
      actionId: draft._id || `action_${Date.now()}`,
      data: {
        // Email data
        to: draft.to?.join(', ') || draft.recipients?.join(', ') || '',
        cc: draft.cc || '',
        subject: draft.subject || '',
        body: draft.body || '',
        // Meeting data
        title: draft.title || '',
        startTime: draft.startTime || '',
        endTime: draft.endTime || '',
        attendees: draft.attendees || [],
        location: draft.location || '',
        // Task data
        taskDescription: draft.taskDescription || '',
        assignee: draft.teammateName || ''
      },
      actions: generateActionButtons(actionType, draft, isHighStakes),
      isHighStakes,
      highStakesReason: draft.highStakesReason
    },
    pending_items: pendingItems.map(item => ({
      id: item.id || item._id,
      type: item.type || 'task',
      title: item.title || item.description || item.subject,
      urgency: item.urgency || 'normal',
      due: item.dueDate || item.due || null,
      source: item.source || 'system'
    }))
  };
};

// ============================================
// DETECT TOPIC SHIFT
// Wrapper for context manager's topic shift detection
// ============================================
exports.detectTopicShift = async ({ currentMessage, previousMessages, lastTopicContext }) => {
  return contextManager.detectTopicShift({ currentMessage, previousMessages, lastTopicContext });
};

// ============================================
// ANALYZE QUERY REQUIREMENTS
// Determines what data sources are needed
// ============================================
exports.analyzeQueryRequirements = (query) => {
  return contextManager.analyzeQueryRequirements(query);
};

// ============================================
// DAILY BRIEFING GENERATION
// ============================================
exports.generateBriefing = async ({ emails, meetings, pendingActions, userName }) => {
  const prompt = `
Generate a morning briefing for ${userName || 'the user'}.

TODAY'S CALENDAR:
${meetings.map(m => `- ${m.time}: ${m.title} with ${m.attendees || 'TBD'}`).join('\n') || 'No meetings scheduled'}

PENDING EMAILS (need response):
${emails.map(e => `- From ${e.from}: "${e.subject}"`).join('\n') || 'All caught up!'}

PENDING ACTIONS:
${pendingActions.map(a => `- ${a.type}: ${a.payload?.subject || a.type}`).join('\n') || 'None'}

FORMAT YOUR RESPONSE WITH PROPER MARKDOWN:

## Good morning, ${userName || 'there'}! ☀️

### 📅 Today's Schedule
- Use bullet points for each meeting
- Include times in bold

### 📧 Email Summary  
- List key emails needing attention
- Note any urgent ones

### ✅ Action Items
- What needs approval
- Key tasks

End with a helpful offer.

Keep it friendly and under 200 words. Use markdown formatting.
`;

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'llama-3.1-8b-instant',
    temperature: 0.7,
    max_tokens: 400
  });

  return completion.choices[0].message.content;
};