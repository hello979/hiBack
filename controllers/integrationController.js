const User = require('../models/users');
const axios = require('axios');
const integrationHelper = require('../utils/integrationHelper');
const { google } = require('googleapis');
const Integration = require('../models/Integration'); // Your provided model
const { Queue } = require('bullmq'); // We need this to trigger the ingestion
const connection = require('../config/redis'); // Your redis config
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/integrations/google/callback';
// Initialize Queue
const ingestionQueue = new Queue('ingestion-queue', { connection });
// Legacy redirect URIs (kept for backward compatibility)
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_REDIRECT_URI = process.env.NOTION_REDIRECT_URI || 'http://localhost:5000/api/integrations/notion/callback';

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || 'http://localhost:5000/api/integrations/slack/callback';

// ============================================================
// DEPRECATED: These legacy OAuth endpoints are kept for backward
// compatibility. New code should use /oauth/start and /oauth/callback
// ============================================================

exports.getNotionAuthUrl = (req, res) => {
  // We pass the user ID as the 'state' parameter to identify the user in the callback
  const state = req.user.id;
  const authUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${NOTION_CLIENT_ID}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(NOTION_REDIRECT_URI)}&state=${state}`;
  res.json({ url: authUrl });
};

exports.handleNotionCallback = async (req, res) => {
  const { code } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  
  if (!code) {
    return res.redirect(`${frontendUrl}/integrations?status=error&message=No code provided`);
  }

  try {
    const encoded = Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post('https://api.notion.com/v1/oauth/token', {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: NOTION_REDIRECT_URI
    }, {
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Content-Type': 'application/json'
      }
    });

    const { access_token, workspace_id, bot_id, workspace_name, workspace_icon, owner } = response.data;

    // In a real app, we would identify the user from the session or a state parameter.
    // Since this is a callback, we might need to pass a state param with the user ID or token.
    // For simplicity, let's assume the frontend handles the redirect and we send the token back to the frontend,
    // OR we use a cookie/session if available.
    // However, the standard way is to have the frontend call this endpoint or handle the redirect.
    // If the frontend redirects the user here, we need to know WHO the user is.
    // A common pattern is to pass a 'state' parameter with the JWT or user ID (encrypted).
    
    // BUT, since we are using JWTs in headers usually, a browser redirect callback is tricky.
    // Alternative: The frontend opens a popup, the popup goes to Notion -> Callback -> Backend.
    // The Backend renders a script that sends a message to the opener (Frontend) with the success status.
    // OR, we can just return a success HTML page and the user closes it.
    
    // Let's try to find the user. If we can't, we can't save the token.
    // For this implementation, let's assume we pass the user ID in the 'state' parameter.
    
    const state = req.query.state; // This should be the user ID
    if (!state) {
        return res.redirect(`${frontendUrl}/integrations?status=error&message=State parameter missing`);
    }

    const user = await User.findById(state);
    if (!user) {
        return res.redirect(`${frontendUrl}/integrations?status=error&message=User not found`);
    }

    user.notionAccessToken = access_token;
    user.notionWorkspaceId = workspace_id;
    user.notionBotId = bot_id;
    user.notionWorkspaceName = workspace_name;
    user.notionWorkspaceIcon = workspace_icon;
    
    await user.save();
    console.log(`Notion connected successfully for user ${user._id}`);

    // Redirect back to frontend
    res.redirect(`${frontendUrl}/integrations?status=success`);

  } catch (error) {
    console.error('Notion Auth Error:', error.response?.data || error.message);
    res.redirect(`${frontendUrl}/integrations?status=error&message=Auth failed`);
  }
};

exports.getIntegrationStatus = async (req, res) => {
  try {
    // Use integration helper for backward-compatible status
    const status = await integrationHelper.getAllStatus(req.user.id);
    
    res.json({
      success: true,
      data: {
        notion: {
          connected: status.notion.connected,
          workspaceName: status.notion.metadata?.workspaceName,
          workspaceIcon: status.notion.metadata?.workspaceIcon
        },
        slack: {
          connected: status.slack.connected,
          teamName: status.slack.metadata?.teamName,
          channelName: status.slack.metadata?.defaultChannelName
        },
        googleCalendar: {
            connected: status.google_calendar.connected
        }
      }
    });
  } catch (error) {
    console.error('Get Integration Status Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Helper to parse markdown text into Notion rich_text objects
const parseMarkdownToNotion = (text) => {
  if (!text) return [];
  
  // Split by bold markers (**text**)
  // This regex captures the delimiters and the content
  const parts = text.split(/(\*\*.*?\*\*)/g);
  
  return parts.map(part => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return {
        type: 'text',
        text: { content: part.slice(2, -2) },
        annotations: { bold: true }
      };
    }
    return {
      type: 'text',
      text: { content: part }
    };
  }).filter(p => p.text.content); // Remove empty strings
};

exports.exportToNotion = async (req, res) => {
  try {
    console.log(`[Notion Export] Starting for user ${req.user.id}`);
    
    // Use integration helper for backward-compatible token access
    const notionAccessToken = await integrationHelper.getAccessToken(req.user.id, 'notion');
    console.log(`[Notion Export] Token retrieved: ${notionAccessToken ? 'yes' : 'no'}`);
    
    if (!notionAccessToken) {
      return res.status(400).json({ success: false, message: 'Notion not connected' });
    }

    const { meetingTitle, date, summary, todos, transcript, pageId } = req.body;

    // Construct Notion Blocks
    const children = [
      // Header Callout
      {
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: [
            { type: 'text', text: { content: `Meeting Notes: ${meetingTitle || 'Untitled'}` }, annotations: { bold: true } },
            { type: 'text', text: { content: `\nDate: ${new Date(date).toLocaleDateString()}` } }
          ],
          icon: { emoji: '📅' },
          color: 'gray_background'
        }
      },
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      // Summary Section
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: 'Executive Summary' } }],
          color: 'blue'
        }
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: parseMarkdownToNotion(summary || 'No summary available.')
        }
      },
      {
        object: 'block',
        type: 'divider',
        divider: {}
      }
    ];

    if (todos && todos.length > 0) {
      children.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: 'Action Items' } }],
          color: 'red'
        }
      });

      todos.forEach(todo => {
        children.push({
          object: 'block',
          type: 'to_do',
          to_do: {
            rich_text: [{ type: 'text', text: { content: `${todo.task} ` } }, { type: 'text', text: { content: `(@${todo.assignee || 'Unassigned'})` }, annotations: { color: 'gray' } }],
            checked: todo.status === 'completed'
          }
        });
      });
    }

    // Create Page
    // First, search for a suitable parent (Database or Page)
    // We prefer a database (data_source) if available, otherwise a page.
    const searchResponse = await axios.post('https://api.notion.com/v1/search', {
        filter: { value: 'page', property: 'object' }, // We search for pages first as fallback
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 10
    }, {
        headers: {
            'Authorization': `Bearer ${notionAccessToken}`,
            'Notion-Version': '2025-09-03', // Updated to latest version
            'Content-Type': 'application/json'
        }
    });

    // Also search for databases (data_sources in new API)
    const dbSearchResponse = await axios.post('https://api.notion.com/v1/search', {
        filter: { value: 'data_source', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 5
    }, {
        headers: {
            'Authorization': `Bearer ${notionAccessToken}`,
            'Notion-Version': '2025-09-03',
            'Content-Type': 'application/json'
        }
    });

    let parent;
    
    // If pageId is provided, use it directly
    if (pageId) {
      parent = { 
        type: pageId.includes('database') || pageId.length === 32 ? 'database_id' : 'page_id',
        [pageId.includes('database') || pageId.length === 32 ? 'database_id' : 'page_id']: pageId
      };
    } else {
      // Fallback to original logic: search for pages/databases
      // Prefer a database (data_source) if found
      if (dbSearchResponse.data.results.length > 0) {
          parent = { 
              type: 'data_source_id', 
              data_source_id: dbSearchResponse.data.results[0].id 
          };
      } else if (searchResponse.data.results.length > 0) {
          parent = { 
              type: 'page_id', 
              page_id: searchResponse.data.results[0].id 
          };
      } else {
          return res.status(400).json({ success: false, message: 'No accessible pages or databases found in Notion to create the note under.' });
      }
    }

    const createResponse = await axios.post('https://api.notion.com/v1/pages', {
        parent: parent,
        icon: { type: 'emoji', emoji: '🤖' },
        properties: {
            title: {
                title: [{ type: 'text', text: { content: meetingTitle || 'Meeting Notes' } }]
            }
        },
        children: children
    }, {
        headers: {
            'Authorization': `Bearer ${notionAccessToken}`,
            'Notion-Version': '2025-09-03',
            'Content-Type': 'application/json'
        }
    });

    res.json({ success: true, url: createResponse.data.url });

  } catch (error) {
    console.error('Notion Export Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Failed to export to Notion', error: error.response?.data });
  }
};

exports.getSlackAuthUrl = (req, res) => {
  const state = req.user.id;
  const scopes = ['chat:write', 'channels:read', 'users:read', 'team:read'].join(',');
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(SLACK_REDIRECT_URI)}&state=${state}`;
  res.json({ url: authUrl });
};

exports.handleSlackCallback = async (req, res) => {
  const { code } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  
  if (!code) {
    return res.redirect(`${frontendUrl}/integrations?status=error&message=No code provided`);
  }

  try {
    const response = await axios.post('https://slack.com/api/oauth.v2.access', {
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: SLACK_REDIRECT_URI
    });

    if (!response.data.ok) {
      throw new Error(response.data.error || 'Slack auth failed');
    }

    const { access_token, team, user, incoming_webhook } = response.data;

    const state = req.query.state;
    if (!state) {
        return res.redirect(`${frontendUrl}/integrations?status=error&message=State parameter missing`);
    }

    const dbUser = await User.findById(state);
    if (!dbUser) {
        return res.redirect(`${frontendUrl}/integrations?status=error&message=User not found`);
    }

    dbUser.slackAccessToken = access_token;
    dbUser.slackTeamId = team.id;
    dbUser.slackTeamName = team.name;
    dbUser.slackUserId = user.id;
    if (incoming_webhook && incoming_webhook.channel) {
      dbUser.slackDefaultChannelName = incoming_webhook.channel.replace(/^#/, '');
    }
    
    await dbUser.save();
    console.log(`Slack connected successfully for user ${dbUser._id}`);

    res.redirect(`${frontendUrl}/integrations?status=success`);

  } catch (error) {
    console.error('Slack Auth Error:', error.response?.data || error.message);
    res.redirect(`${frontendUrl}/integrations?status=error&message=Auth failed`);
  }
};

exports.exportToSlack = async (req, res) => {
  try {
    const slackAccessToken = await integrationHelper.getAccessToken(req.user.id, 'slack');
    
    if (!slackAccessToken) {
      return res.status(400).json({ success: false, message: 'Slack not connected' });
    }

    const slackMetadata = await integrationHelper.getMetadata(req.user.id, 'slack');
    const { meetingTitle, date, summary, todos, transcript, channelId: requestedChannelId } = req.body;

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📅 ${meetingTitle || 'Meeting Notes'}`,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Date:* ${new Date(date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`
        }
      },
      {
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Executive Summary*\n${summary || 'No summary available.'}`
        }
      }
    ];

    if (todos && todos.length > 0) {
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Action Items*'
        }
      });

      const todoText = todos
        .map(todo => `• ${todo.task} ${todo.assignee ? `(@${todo.assignee})` : '(Unassigned)'} ${todo.status === 'completed' ? '✅' : ''}`)
        .join('\n');
      
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: todoText
        }
      });
    }

    let channelId = requestedChannelId || slackMetadata?.defaultChannelId;

    if (!channelId) {
      const channelsRes = await axios.get('https://slack.com/api/conversations.list?limit=100', {
        headers: {
          'Authorization': `Bearer ${slackAccessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (channelsRes.data.ok && channelsRes.data.channels.length > 0) {
        let targetChannel = channelsRes.data.channels.find(ch => ch.name === 'meeting-notes');
        if (!targetChannel) {
          targetChannel = channelsRes.data.channels.find(ch => ch.name === 'general');
        }
        if (!targetChannel) {
          targetChannel = channelsRes.data.channels[0];
        }
        channelId = targetChannel.id;
        
        // Update metadata in both new and legacy models
        await integrationHelper.updateLegacyMetadata(req.user.id, 'slack', {
          defaultChannelId: channelId,
          defaultChannelName: targetChannel.name
        });
      } else {
        return res.status(400).json({ success: false, message: 'No channels found in Slack workspace' });
      }
    }

    // Attempt to join the channel first (in case bot isn't a member)
    try {
      await axios.post('https://slack.com/api/conversations.join', {
        channel: channelId
      }, {
        headers: {
          'Authorization': `Bearer ${slackAccessToken}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (joinError) {
      // Ignore join errors - bot might already be in channel or it's a private channel
    }

    const postRes = await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channelId,
      blocks: blocks,
      text: `Meeting Notes: ${meetingTitle}`
    }, {
      headers: {
        'Authorization': `Bearer ${slackAccessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!postRes.data.ok) {
      console.error('[Slack Export] Post failed:', postRes.data.error);
      throw new Error(postRes.data.error || 'Failed to post message');
    }

    console.log('[Slack Export] Posted successfully to channel:', channelId, 'ts:', postRes.data.ts);

    // Get workspace domain - try metadata first, then fetch from API
    let workspaceDomain = slackMetadata?.teamDomain;
    
    if (!workspaceDomain) {
      const teamInfoRes = await axios.get('https://slack.com/api/team.info', {
        headers: {
          'Authorization': `Bearer ${slackAccessToken}`,
          'Content-Type': 'application/json'
        }
      });

      workspaceDomain = teamInfoRes.data.ok && teamInfoRes.data.team?.domain 
        ? teamInfoRes.data.team.domain 
        : slackMetadata?.teamName?.toLowerCase().replace(/\s+/g, '-') || 'slack';
        
      // Save for next time
      if (teamInfoRes.data.ok && teamInfoRes.data.team?.domain) {
        await integrationHelper.updateLegacyMetadata(req.user.id, 'slack', {
          teamDomain: teamInfoRes.data.team.domain
        });
      }
    }

    const messageUrl = `https://${workspaceDomain}.slack.com/archives/${channelId}/p${postRes.data.ts.replace('.', '')}`;
    
    res.json({ success: true, url: messageUrl, channel: postRes.data.channel });

  } catch (error) {
    console.error('[Slack Export Error]:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to export to Slack', 
      error: error.response?.data || error.message 
    });
  }
};

// ============================================================
// NEW: MANAGEMENT ENDPOINTS
// ============================================================

exports.getNotionPages = async (req, res) => {
  try {
    const notionAccessToken = await integrationHelper.getAccessToken(req.user.id, 'notion');
    
    if (!notionAccessToken) {
      return res.status(400).json({ success: false, message: 'Notion not connected' });
    }

    const searchResponse = await axios.post('https://api.notion.com/v1/search', {
      filter: { 
        property: 'object',
        value: 'page' 
      },
      page_size: 100
    }, {
      headers: {
        'Authorization': `Bearer ${notionAccessToken}`,
        'Notion-Version': '2025-09-03',
        'Content-Type': 'application/json'
      }
    });

    const pages = searchResponse.data.results.map(page => ({
      id: page.id,
      title: page.properties?.title?.title?.[0]?.plain_text || 
             page.properties?.Name?.title?.[0]?.plain_text || 
             'Untitled',
      icon: page.icon?.emoji || page.icon?.external?.url || null
    }));

    // Also get databases
    const dbSearchResponse = await axios.post('https://api.notion.com/v1/search', {
      filter: { 
        property: 'object',
        value: 'data_source' 
      },
      page_size: 100
    }, {
      headers: {
        'Authorization': `Bearer ${notionAccessToken}`,
        'Notion-Version': '2025-09-03',
        'Content-Type': 'application/json'
      }
    });

    const databases = dbSearchResponse.data.results.map(db => ({
      id: db.id,
      title: db.title?.[0]?.plain_text || 'Untitled Database',
      icon: db.icon?.emoji || db.icon?.external?.url || '📊',
      isDatabase: true
    }));

    res.json({ 
      success: true, 
      pages: [...databases, ...pages],
      metadata: await integrationHelper.getMetadata(req.user.id, 'notion')
    });

  } catch (error) {
    console.error('Get Notion Pages Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch Notion pages' });
  }
};

exports.getSlackChannels = async (req, res) => {
  try {
    const slackAccessToken = await integrationHelper.getAccessToken(req.user.id, 'slack');
    
    if (!slackAccessToken) {
      return res.status(400).json({ success: false, message: 'Slack not connected' });
    }

    const channelsRes = await axios.get('https://slack.com/api/conversations.list', {
      params: {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200
      },
      headers: {
        'Authorization': `Bearer ${slackAccessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!channelsRes.data.ok) {
      throw new Error(channelsRes.data.error || 'Failed to fetch channels');
    }

    // Auto-join channels where bot has access but isn't a member yet
    const joinPromises = channelsRes.data.channels
      .filter(ch => !ch.is_member && !ch.is_private) // Only auto-join public channels
      .map(ch => 
        axios.post('https://slack.com/api/conversations.join', 
          { channel: ch.id },
          { 
            headers: {
              'Authorization': `Bearer ${slackAccessToken}`,
              'Content-Type': 'application/json'
            }
          }
        ).catch(err => {
          console.log(`[Slack] Could not auto-join #${ch.name}:`, err.response?.data?.error || err.message);
          return null;
        })
      );

    // Wait for all join attempts
    await Promise.all(joinPromises);

    // Re-fetch the channel list to get updated membership status
    const updatedChannelsRes = await axios.get('https://slack.com/api/conversations.list', {
      params: {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200
      },
      headers: {
        'Authorization': `Bearer ${slackAccessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const channels = (updatedChannelsRes.data.ok ? updatedChannelsRes.data.channels : channelsRes.data.channels).map(ch => ({
      id: ch.id,
      name: ch.name,
      isPrivate: ch.is_private,
      isMember: ch.is_member,
      memberCount: ch.num_members
    }));

    res.json({ 
      success: true, 
      channels,
      metadata: await integrationHelper.getMetadata(req.user.id, 'slack')
    });

  } catch (error) {
    console.error('Get Slack Channels Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch Slack channels' });
  }
};

exports.disconnectIntegration = async (req, res) => {
  try {
    const { provider } = req.params;
    const validProviders = ['notion', 'slack', 'google_calendar', 'google'];
    
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: 'Invalid provider' });
    }

    // Remove from Integration model
    const Integration = require('../models/Integration');
    await Integration.deleteOne({ userId: req.user.id, provider });

    // Clear legacy User model fields
    const User = require('../models/users');
    const updateFields = {};
    
    if (provider === 'notion') {
      updateFields.notionAccessToken = null;
      updateFields.notionWorkspaceId = null;
      updateFields.notionBotId = null;
      updateFields.notionWorkspaceName = null;
      updateFields.notionWorkspaceIcon = null;
    } else if (provider === 'slack') {
      updateFields.slackAccessToken = null;
      updateFields.slackTeamId = null;
      updateFields.slackTeamName = null;
      updateFields.slackUserId = null;
      updateFields.slackDefaultChannelName = null;
    } else if (provider === 'google_calendar' || provider === 'google') {
      updateFields.googleCalendarAccessToken = null;
      updateFields.googleCalendarRefreshToken = null;
    }

    await User.findByIdAndUpdate(req.user.id, updateFields);

    res.json({ success: true, message: `${provider} disconnected successfully` });

  } catch (error) {
    console.error('Disconnect Integration Error:', error);
    res.status(500).json({ success: false, message: 'Failed to disconnect integration' });
  }
};
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// --- ADD THESE NEW FUNCTIONS ---

exports.getGoogleAuthUrl = (req, res) => {
  const state = req.user.id;
  
  // We need generic Gmail read/write and Calendar access
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Crucial: gets us a Refresh Token
    prompt: 'consent',      // Crucial: forces Refresh Token even if re-connecting
    scope: scopes,
    state: state
  });

  res.json({ url: authUrl });
};

exports.handleGoogleCallback = async (req, res) => {
  const { code, state } = req.query; // state is userId
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/integrations?status=error&message=Invalid request`);
  }

  try {
    // 1. Exchange Code for Tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // 2. Get User Profile (to store email in metadata)
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    // 3. Save to Integration Model (Using your robust Schema)
    // We use 'google' as the provider for the main assistant connection
    const integration = await Integration.findOrCreate(state, 'google');

    integration.updateTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, // Will be null if re-authing without prompt:consent
      expiresAt: tokens.expiry_date
    });
    integration.metadata = {
      ...integration.metadata,
      accountId: userInfo.data.id,
      accountEmail: userInfo.data.email,
      accountName: userInfo.data.name,
      accountAvatar: userInfo.data.picture,
      scopes: tokens.scope
    };

    await integration.save();

    console.log(`[Google] Connected for user ${state}. Triggering ingestion...`);

    await ingestionQueue.add('initial-sync', { 
      userId: state, 
      integrationId: integration._id 
    });

    res.redirect(`${frontendUrl}/integrations?status=success&provider=google`);

  } catch (error) {
    console.error('Google Auth Error:', error.message);
    res.redirect(`${frontendUrl}/integrations?status=error&message=Auth failed`);
  }
};