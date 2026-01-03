// Mock bots data for HiCapy
// These represent the available bots that can be assigned to meetings

const mockBots = [
  {
    bot_id: 'bot_meeting_assistant_01',
    name: 'Meeting Assistant',
    description: 'General purpose meeting assistant that takes notes and provides summaries',
    color: '#3B82F6', // Blue
    icon: '📝',
    capabilities: ['note-taking', 'summarization', 'action-items']
  },
  {
    bot_id: 'bot_sales_coach_01',
    name: 'Sales Coach',
    description: 'Analyzes sales calls and provides coaching feedback',
    color: '#10B981', // Green
    icon: '💼',
    capabilities: ['sales-analysis', 'coaching', 'deal-tracking']
  },
  {
    bot_id: 'bot_interview_helper_01',
    name: 'Interview Helper',
    description: 'Assists with interview analysis and candidate evaluation',
    color: '#8B5CF6', // Purple
    icon: '🎯',
    capabilities: ['interview-analysis', 'evaluation', 'feedback']
  },
  {
    bot_id: 'bot_standup_tracker_01',
    name: 'Standup Tracker',
    description: 'Tracks standup meetings and team progress',
    color: '#06B6D4', // Cyan
    icon: '🚀',
    capabilities: ['standup-tracking', 'blockers', 'progress']
  },
  {
    bot_id: 'bot_brainstorm_buddy_01',
    name: 'Brainstorm Buddy',
    description: 'Captures ideas and organizes brainstorming sessions',
    color: '#EC4899', // Pink
    icon: '💡',
    capabilities: ['idea-capture', 'organization', 'follow-ups']
  }
];

// Get all available bots
const getAllBots = () => {
  return mockBots;
};

// Get a specific bot by ID
const getBotById = (botId) => {
  return mockBots.find(bot => bot.bot_id === botId);
};

// Validate if a bot ID exists
const isValidBotId = (botId) => {
  return mockBots.some(bot => bot.bot_id === botId);
};

module.exports = {
  mockBots,
  getAllBots,
  getBotById,
  isValidBotId
};
