/**
 * Context Manager Service
 * 
 * Handles intelligent context management for HiCapy AI Assistant:
 * 1. Topic Shift Detection - Detects when user switches topics
 * 2. API Data Priority - Ensures fresh API data takes precedence over history
 * 3. Short-term Focus Context - Manages current conversation focus
 * 4. Long-term Memory Preservation - Keeps important facts across topics
 */

const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ============================================
// TOPIC SHIFT DETECTION
// Uses lightweight LLM call to detect topic changes
// ============================================
exports.detectTopicShift = async ({ 
  currentMessage, 
  previousMessages, 
  lastTopicContext 
}) => {
  // If no previous messages, it's a new topic
  if (!previousMessages || previousMessages.length === 0) {
    return {
      isNewTopic: true,
      confidence: 1.0,
      previousTopic: null,
      currentTopic: await extractTopic(currentMessage),
      shouldClearContext: true
    };
  }

  const recentHistory = previousMessages.slice(-5).map(m => 
    `${m.role || m.sender}: ${m.content || m.text}`
  ).join('\n');

  const prompt = `Analyze if the user's new message represents a TOPIC SHIFT from the recent conversation.

RECENT CONVERSATION:
${recentHistory}

NEW USER MESSAGE: "${currentMessage}"

PREVIOUS TOPIC CONTEXT: ${lastTopicContext || 'None established'}

RULES FOR TOPIC SHIFT DETECTION:
1. A topic shift occurs when the user asks about a DIFFERENT entity (person, meeting, email, task)
2. Pronouns ("it", "that", "this") referring to previous topic = NOT a topic shift
3. Follow-up questions about the same subject = NOT a topic shift  
4. Asking about a NEW meeting/person/email = TOPIC SHIFT
5. Generic commands like "check my calendar" = Context-independent (treat as new topic)

EXAMPLES:
- Previous: "What about Snehal's meeting?" → New: "When is Subhradeep's meeting?" = TOPIC SHIFT (different person)
- Previous: "2pm meeting with John" → New: "Cancel it" = NOT a topic shift (refers to same meeting)
- Previous: "Email from Sarah" → New: "What did Mike email about?" = TOPIC SHIFT (different person)
- Previous: "My 3pm call" → New: "Who's attending?" = NOT a topic shift (same meeting)

Return JSON only:
{
  "isNewTopic": true | false,
  "confidence": 0.0-1.0,
  "previousTopic": "Brief description of previous topic",
  "currentTopic": "Brief description of current topic",
  "shouldClearContext": true | false,
  "reasoning": "Why this is or isn't a topic shift",
  "carryOverEntities": ["list of entities from previous topic that should be remembered"]
}`;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.1-8b-instant',
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 500
    });

    const result = JSON.parse(completion.choices[0].message.content);
    console.log('[ContextManager] Topic shift detection:', result.isNewTopic ? 'NEW TOPIC' : 'CONTINUATION', result.confidence);
    return result;
  } catch (error) {
    console.error('[ContextManager] Topic shift detection error:', error.message);
    // Default to treating as continuation if detection fails
    return {
      isNewTopic: false,
      confidence: 0.5,
      previousTopic: lastTopicContext,
      currentTopic: currentMessage.substring(0, 50),
      shouldClearContext: false,
      carryOverEntities: []
    };
  }
};

// ============================================
// EXTRACT TOPIC FROM MESSAGE
// ============================================
const extractTopic = async (message) => {
  try {
    const completion = await groq.chat.completions.create({
      messages: [{ 
        role: 'user', 
        content: `Extract the main topic/subject from this message in 10 words or less: "${message}"` 
      }],
      model: 'llama-3.1-8b-instant',
      temperature: 0.1,
      max_tokens: 50
    });
    return completion.choices[0].message.content.trim();
  } catch (error) {
    return message.substring(0, 50);
  }
};

// ============================================
// CONTEXT PRIORITY RESOLVER
// Ensures API data > Conversation History > Long-term Memory
// ============================================
exports.resolveContextPriority = ({ 
  freshApiData, 
  conversationHistory, 
  longTermMemory,
  currentQuery 
}) => {
  const context = {
    primary: [],      // Fresh API data (highest priority)
    secondary: [],    // Relevant conversation context
    background: [],   // Long-term memory (lowest priority)
    conflicts: [],    // Detected conflicts between sources
    trustOrder: ['google_calendar', 'gmail', 'conversation', 'memory']
  };

  // Add fresh API data as PRIMARY (always trusted)
  if (freshApiData?.calendar?.length > 0) {
    context.primary.push({
      source: 'google_calendar',
      priority: 1,
      isFresh: true,
      data: freshApiData.calendar,
      text: formatCalendarForContext(freshApiData.calendar)
    });
  }

  if (freshApiData?.emails?.length > 0) {
    context.primary.push({
      source: 'gmail',
      priority: 1,
      isFresh: true,
      data: freshApiData.emails,
      text: formatEmailsForContext(freshApiData.emails)
    });
  }

  if (freshApiData?.tasks?.length > 0) {
    context.primary.push({
      source: 'tasks',
      priority: 1,
      isFresh: true,
      data: freshApiData.tasks,
      text: formatTasksForContext(freshApiData.tasks)
    });
  }

  // Add relevant conversation context as SECONDARY
  // Filter to only include context relevant to current query
  if (conversationHistory?.length > 0) {
    const relevantHistory = filterRelevantHistory(conversationHistory, currentQuery);
    if (relevantHistory.length > 0) {
      context.secondary.push({
        source: 'conversation',
        priority: 2,
        isFresh: false,
        data: relevantHistory,
        text: relevantHistory.map(h => `[${h.role}]: ${h.content || h.text}`).join('\n')
      });
    }
  }

  // Add long-term memory as BACKGROUND
  if (longTermMemory?.length > 0) {
    context.background.push({
      source: 'memory',
      priority: 3,
      isFresh: false,
      data: longTermMemory,
      text: longTermMemory.map(m => m.text || m.content).join('\n')
    });
  }

  // Detect conflicts between API data and conversation history
  context.conflicts = detectContextConflicts(context.primary, context.secondary);

  return context;
};

// ============================================
// CONFLICT DETECTION
// Identifies when conversation history contradicts API data
// ============================================
const detectContextConflicts = (primary, secondary) => {
  const conflicts = [];

  // Check for meeting time conflicts
  const apiMeetings = primary.find(p => p.source === 'google_calendar')?.data || [];
  const historyText = secondary.map(s => s.text).join(' ').toLowerCase();

  for (const meeting of apiMeetings) {
    const meetingTitle = (meeting.title || meeting.summary || '').toLowerCase();
    const meetingTime = meeting.start ? new Date(meeting.start).toLocaleTimeString() : '';
    
    // Check if conversation mentioned different time for same meeting
    if (historyText.includes(meetingTitle)) {
      const timePattern = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
      const mentionedTimes = historyText.match(timePattern) || [];
      
      for (const time of mentionedTimes) {
        if (!meetingTime.toLowerCase().includes(time.replace(/\s/g, '').toLowerCase())) {
          conflicts.push({
            type: 'meeting_time',
            entity: meetingTitle,
            apiValue: meetingTime,
            historyValue: time,
            resolution: 'USE_API_DATA',
            message: `Note: The calendar shows ${meetingTitle} at ${meetingTime}. Previous conversation mentioned ${time} but API data is authoritative.`
          });
        }
      }
    }
  }

  return conflicts;
};

// ============================================
// FILTER RELEVANT HISTORY
// Only includes history items relevant to current query
// ============================================
const filterRelevantHistory = (history, currentQuery) => {
  if (!history || history.length === 0) return [];
  
  const queryLower = currentQuery.toLowerCase();
  const keywords = queryLower.split(/\s+/).filter(w => w.length > 3);
  
  return history.filter(item => {
    const content = (item.content || item.text || '').toLowerCase();
    // Include if any keyword matches
    return keywords.some(kw => content.includes(kw));
  }).slice(-5); // Max 5 relevant items
};

// ============================================
// FORMAT HELPERS
// ============================================
const formatCalendarForContext = (events) => {
  if (!events || events.length === 0) return 'No calendar events found.';
  
  return events.map(e => {
    const start = e.start ? new Date(e.start) : null;
    const timeStr = start ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBD';
    const dateStr = start ? start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    const attendees = e.attendees?.map(a => a.name || a.email).join(', ') || 'No attendees';
    return `📅 "${e.title || 'Untitled'}" on ${dateStr} at ${timeStr} with ${attendees}`;
  }).join('\n');
};

const formatEmailsForContext = (emails) => {
  if (!emails || emails.length === 0) return 'No emails found.';
  
  return emails.map(e => {
    const dateStr = e.date ? new Date(e.date).toLocaleDateString('en-US', { 
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }) : '';
    return `📧 From ${e.from} (${dateStr}): "${e.subject}" - ${e.snippet?.substring(0, 100)}...`;
  }).join('\n');
};

const formatTasksForContext = (tasks) => {
  if (!tasks || tasks.length === 0) return 'No tasks found.';
  
  return tasks.map((t, i) => {
    const status = t.status === 'completed' ? '✅' : '⬜';
    const assignees = t.assignees?.map(a => a.name).join(', ') || 'Unassigned';
    return `${status} ${i + 1}. ${t.description} (${assignees})`;
  }).join('\n');
};

// ============================================
// BUILD CONTEXT STRING FOR AI
// Assembles context with proper priority ordering
// ============================================
exports.buildContextString = (resolvedContext, options = {}) => {
  const { includeConflictWarnings = true, maxLength = 4000 } = options;
  
  let contextParts = [];

  // 1. Primary (Fresh API Data) - ALWAYS FIRST
  if (resolvedContext.primary.length > 0) {
    contextParts.push('## 🔴 CURRENT DATA (FROM LIVE APIs - USE THIS FOR ANSWERS)');
    contextParts.push('**IMPORTANT: This data is fetched live from Google Calendar/Gmail. If it contradicts conversation history, TRUST THIS DATA.**\n');
    
    for (const item of resolvedContext.primary) {
      if (item.source === 'google_calendar') {
        contextParts.push('### Calendar Events (Live from Google Calendar):');
      } else if (item.source === 'gmail') {
        contextParts.push('### Emails (Live from Gmail):');
      } else if (item.source === 'tasks') {
        contextParts.push('### Tasks:');
      }
      contextParts.push(item.text);
      contextParts.push('');
    }
  }

  // 2. Conflict Warnings
  if (includeConflictWarnings && resolvedContext.conflicts.length > 0) {
    contextParts.push('## ⚠️ CONTEXT CONFLICTS DETECTED');
    contextParts.push('The following conflicts were detected between live API data and conversation history. **ALWAYS USE API DATA:**');
    for (const conflict of resolvedContext.conflicts) {
      contextParts.push(`- ${conflict.message}`);
    }
    contextParts.push('');
  }

  // 3. Secondary (Conversation Context) - WITH WARNING
  if (resolvedContext.secondary.length > 0) {
    contextParts.push('## 🟡 CONVERSATION HISTORY (Reference Only)');
    contextParts.push('**Note: Use this for context about user intent, but prefer live API data for facts.**\n');
    for (const item of resolvedContext.secondary) {
      contextParts.push(item.text);
    }
    contextParts.push('');
  }

  // 4. Background (Long-term Memory)
  if (resolvedContext.background.length > 0) {
    contextParts.push('## 🟢 BACKGROUND KNOWLEDGE');
    for (const item of resolvedContext.background) {
      contextParts.push(item.text);
    }
  }

  let result = contextParts.join('\n');
  
  // Truncate if too long
  if (result.length > maxLength) {
    result = result.substring(0, maxLength) + '\n\n[Context truncated for length]';
  }

  return result;
};

// ============================================
// FOCUS CONTEXT MANAGER
// Manages short-term focus context that gets cleared on topic shift
// ============================================
class FocusContext {
  constructor() {
    this.currentTopic = null;
    this.entities = {
      meetings: [],
      emails: [],
      people: [],
      tasks: []
    };
    this.lastUpdated = null;
  }

  update(topicInfo, entities) {
    this.currentTopic = topicInfo.currentTopic;
    
    if (topicInfo.shouldClearContext) {
      this.clear();
    }

    // Merge new entities
    if (entities.meetings) this.entities.meetings = entities.meetings;
    if (entities.emails) this.entities.emails = entities.emails;
    if (entities.people) this.entities.people = [...new Set([...this.entities.people, ...(entities.people || [])])];
    if (entities.tasks) this.entities.tasks = entities.tasks;
    
    // Carry over specified entities from previous topic
    if (topicInfo.carryOverEntities) {
      for (const entity of topicInfo.carryOverEntities) {
        // Mark as carried over for reference
        console.log(`[FocusContext] Carrying over entity: ${entity}`);
      }
    }

    this.lastUpdated = new Date();
  }

  clear() {
    this.entities = { meetings: [], emails: [], people: [], tasks: [] };
    console.log('[FocusContext] Context cleared for new topic');
  }

  getLastReference(type) {
    switch (type) {
      case 'meeting':
        return this.entities.meetings[this.entities.meetings.length - 1] || null;
      case 'email':
        return this.entities.emails[this.entities.emails.length - 1] || null;
      case 'person':
        return this.entities.people[this.entities.people.length - 1] || null;
      case 'task':
        return this.entities.tasks[this.entities.tasks.length - 1] || null;
      default:
        return null;
    }
  }

  toJSON() {
    return {
      currentTopic: this.currentTopic,
      entities: this.entities,
      lastUpdated: this.lastUpdated
    };
  }
}

// Store focus contexts per user session
const focusContexts = new Map();

exports.getFocusContext = (userId) => {
  if (!focusContexts.has(userId)) {
    focusContexts.set(userId, new FocusContext());
  }
  return focusContexts.get(userId);
};

exports.clearFocusContext = (userId) => {
  if (focusContexts.has(userId)) {
    focusContexts.get(userId).clear();
  }
};

// ============================================
// QUERY INTENT ANALYZER
// Determines if query needs fresh API data
// ============================================
exports.analyzeQueryRequirements = (query) => {
  const queryLower = query.toLowerCase();
  
  const requirements = {
    needsCalendar: false,
    needsEmail: false,
    needsTasks: false,
    needsFreshData: false,
    dateRange: null,
    searchParams: {}
  };

  // Calendar-related queries
  const calendarKeywords = ['meeting', 'calendar', 'schedule', 'appointment', 'call', 'event', 'busy', 'free', 'available'];
  if (calendarKeywords.some(k => queryLower.includes(k))) {
    requirements.needsCalendar = true;
    requirements.needsFreshData = true;
  }

  // Email-related queries  
  const emailKeywords = ['email', 'mail', 'inbox', 'message', 'sent', 'received', 'from', 'reply'];
  if (emailKeywords.some(k => queryLower.includes(k))) {
    requirements.needsEmail = true;
    requirements.needsFreshData = true;
  }

  // Task-related queries
  const taskKeywords = ['task', 'todo', 'to-do', 'action item', 'follow up', 'followup'];
  if (taskKeywords.some(k => queryLower.includes(k))) {
    requirements.needsTasks = true;
  }

  // Date range detection
  if (queryLower.includes('today')) {
    requirements.dateRange = 'today';
  } else if (queryLower.includes('tomorrow')) {
    requirements.dateRange = 'tomorrow';
  } else if (queryLower.includes('this week')) {
    requirements.dateRange = 'this_week';
  } else if (queryLower.includes('yesterday')) {
    requirements.dateRange = 'yesterday';
  }

  // "Current status" type queries always need fresh data
  const statusKeywords = ['do i have', 'what\'s on', 'what is on', 'any', 'check my', 'show me my'];
  if (statusKeywords.some(k => queryLower.includes(k))) {
    requirements.needsFreshData = true;
  }

  return requirements;
};

module.exports = exports;
