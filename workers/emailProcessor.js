const { Worker } = require('bullmq');
const Integration = require('../models/Integration');
const Action = require('../models/Action');
const User = require('../models/users');
const SenderCache = require('../models/SenderCache');
const mem0Service = require('../services/mem0Service');
const aiService = require('../services/aiService');
const knowledgeGraphService = require('../services/knowledgeGraphService');
const integrationHelper = require('../utils/integrationHelper');
const { google } = require('googleapis');
const connection = require('../config/redis');

// ============================================
// SMART FILTERING - Zero API calls for spam
// ============================================
const SPAM_INDICATORS = [
  'unsubscribe', 'noreply@', 'donotreply@', 'notifications@',
  'marketing@', 'newsletter@', 'promo@', 'info@'
];

const PROMO_DOMAINS = [
  'linkedin.com', 'facebook.com', 'twitter.com', 'medium.com',
  'substack.com', 'mailchimp.com', 'sendgrid.net'
];

function shouldAutoIgnore(email) {
  const from = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const body = (email.snippet || '').toLowerCase();
  
  if (SPAM_INDICATORS.some(s => from.includes(s))) return { ignore: true, reason: 'noreply_sender' };
  if (PROMO_DOMAINS.some(d => from.includes(d))) return { ignore: true, reason: 'promotional_domain' };
  if (body.includes('unsubscribe') || body.includes('email preferences')) return { ignore: true, reason: 'newsletter' };
  if (email.recipientCount > 50) return { ignore: true, reason: 'mass_email' };
  if (subject.includes('out of office') || subject.includes('automatic reply')) return { ignore: true, reason: 'auto_reply' };
  
  return { ignore: false };
}

function isInternalEmail(email, userDomain) {
  if (!userDomain) return false;
  const senderDomain = email.from?.split('@')[1]?.toLowerCase();
  return senderDomain === userDomain.toLowerCase();
}

// ============================================
// MAIN EMAIL PROCESSOR
// ============================================
const worker = new Worker('email-queue', async (job) => {
  const { userId } = job.data;
  console.log(`[EmailProcessor] Processing emails for user ${userId}`);

  try {
    // Use the helper that checks both providers
    const { accessToken, refreshToken, provider } = await integrationHelper.getGoogleToken(userId);

    const user = await User.findById(userId);

    if (!accessToken && !refreshToken) {
      console.log(`[EmailProcessor] User ${userId} has no Google integration`);
      return;
    }
    
    console.log(`[EmailProcessor] Using ${provider} provider`);

    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    const gmail = google.gmail({ version: 'v1', auth });

    // Fetch recent unread primary emails
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      q: 'is:unread category:primary -from:me'
    });

    if (!listRes.data.messages?.length) {
      console.log(`[EmailProcessor] No new emails for user ${userId}`);
      return;
    }

    const userDomain = user.email?.split('@')[1];

    for (const msgStub of listRes.data.messages) {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: msgStub.id, format: 'full' });
        const headers = msg.data.payload.headers;
        
        const email = {
          id: msg.data.id,
          threadId: msg.data.threadId,
          from: headers.find(h => h.name === 'From')?.value || '',
          to: headers.find(h => h.name === 'To')?.value || '',
          subject: headers.find(h => h.name === 'Subject')?.value || 'No Subject',
          date: headers.find(h => h.name === 'Date')?.value,
          snippet: msg.data.snippet,
          recipientCount: (headers.find(h => h.name === 'To')?.value || '').split(',').length
        };

        const senderMatch = email.from.match(/<(.+?)>/) || [null, email.from];
        const senderEmail = senderMatch[1]?.toLowerCase() || email.from.toLowerCase();

        // Smart filtering
        const ignoreCheck = shouldAutoIgnore(email);
        if (ignoreCheck.ignore) {
          console.log(`[EmailProcessor] Auto-ignored: ${email.subject} (${ignoreCheck.reason})`);
          continue;
        }

        // Check sender cache
        let senderDecision = await SenderCache.findOne({ userId, senderEmail });
        if (senderDecision?.decision === 'ignore') {
          console.log(`[EmailProcessor] Cached ignore: ${senderEmail}`);
          continue;
        }

        // Internal email - auto index without action
        if (isInternalEmail(email, userDomain)) {
          await mem0Service.indexEmail(email, userId);
          continue;
        }

        // Classify new sender
        let classification = { shouldProcess: true, intent: 'general', urgency: 'normal' };
        if (!senderDecision) {
          classification = await aiService.classifyEmail(email);
          await SenderCache.create({
            userId, senderEmail,
            senderName: email.from.split('<')[0].trim(),
            decision: classification.shouldProcess ? 'process' : 'ask',
            category: classification.category
          });
          if (!classification.shouldProcess) continue;
        }

        // Get context from knowledge graph
        const context = await mem0Service.getContext(userId, email);
        const userPrefs = await mem0Service.getUserPreferences(userId);

        // Generate action proposal
        const proposal = await aiService.generateAction({
          email, context, intent: classification.intent, userPreferences: userPrefs
        });

        // Create action card for approval
        await Action.create({
          userId,
          source: 'email',
          sourceId: email.id,
          threadId: email.threadId,
          type: proposal.actionType,
          confidence: proposal.confidence,
          payload: {
            ...proposal.payload,
            from: email.from,
            senderEmail,
            subject: email.subject,
            originalSnippet: email.snippet,
            recipients: [senderEmail]
          },
          context: { sources: context.sources || [], reasoning: proposal.payload.reasoning },
          urgency: classification.urgency,
          status: 'pending'
        });

        console.log(`[EmailProcessor] Created action: ${email.subject}`);
        await mem0Service.indexEmail(email, userId);
        
        // Link email to matching meeting in knowledge graph (auto-links based on topic matching)
        try {
          await knowledgeGraphService.linkEmailToMeeting(userId, {
            id: email.id,
            subject: email.subject,
            snippet: email.snippet,
            fromEmail: senderEmail,
            to: email.to,
            date: email.date ? new Date(email.date) : new Date()
          });
        } catch (kgErr) {
          console.log(`[EmailProcessor] Knowledge graph link skipped: ${kgErr.message}`);
        }

      } catch (emailErr) {
        console.error(`[EmailProcessor] Email error:`, emailErr.message);
      }
    }
  } catch (error) {
    console.error(`[EmailProcessor] Fatal error:`, error.message);
  }
}, { connection });

worker.on('error', err => console.error('[EmailProcessor Error]', err));
module.exports = worker;