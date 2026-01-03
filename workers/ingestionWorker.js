const { Worker } = require('bullmq');
const { google } = require('googleapis');
const Integration = require('../models/Integration');
const connection = require('../config/redis');
const { MemoryClient } = require('mem0ai');

// Initialize Mem0 (The Knowledge Graph)
const mem0 = new MemoryClient({ 
  apiKey: process.env.MEM0_API_KEY 
});

const worker = new Worker('ingestion-queue', async (job) => {
  const { userId, integrationId } = job.data;
  console.log(`[Ingestion] Starting initial sync for User: ${userId}`);

  try {
    // 1. SECURE TOKEN RETRIEVAL
    // We explicitly select the hidden encrypted fields
    const integration = await Integration.findById(integrationId).select('+accessTokenEnc +refreshTokenEnc');

    if (!integration || !integration.isValid()) {
      console.error(`[Ingestion] Integration not valid for user ${userId}`);
      return;
    }

    // 2. SETUP GOOGLE CLIENT
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({
      access_token: integration.getAccessToken(),
      refresh_token: integration.getRefreshToken()
    });

    // 3. INGEST EMAILS (History)
    // We fetch the last 30 important emails to build immediate context
    const gmail = google.gmail({ version: 'v1', auth });
    
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 30,
      q: 'category:primary -from:me' // Skip sent items and promos
    });

    if (listRes.data.messages) {
      console.log(`[Ingestion] Found ${listRes.data.messages.length} emails to index...`);
      
      const memories = [];
      
      // Process in parallel chunks for speed
      const emailPromises = listRes.data.messages.map(async (msgStub) => {
        try {
          const msg = await gmail.users.messages.get({ userId: 'me', id: msgStub.id });
          const headers = msg.data.payload.headers;
          
          const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
          const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
          const date = headers.find(h => h.name === 'Date')?.value;
          const snippet = msg.data.snippet;

          // Prepare for Vector DB
          return {
            content: `Email from ${from} (${date}): Subject "${subject}". Content: ${snippet}`,
            metadata: {
              user_id: userId,
              type: 'communication_history',
              source: 'gmail',
              source_id: msgStub.id
            }
          };
        } catch (err) {
          return null; // Skip failed emails
        }
      });

      const results = await Promise.all(emailPromises);
      const validMemories = results.filter(r => r !== null);

      // Batch Upload to Mem0
      if (validMemories.length > 0) {
        await mem0.add(validMemories, { user_id: userId });
        console.log(`[Ingestion] Successfully indexed ${validMemories.length} emails into Knowledge Graph.`);
      }
    }

    // 4. INGEST CALENDAR (Upcoming)
    // We look 2 weeks ahead
    const calendar = google.calendar({ version: 'v3', auth });
    const calRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: (new Date()).toISOString(),
      timeMax: (new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)).toISOString(), // +14 days
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime',
    });

    if (calRes.data.items && calRes.data.items.length > 0) {
      const eventMemories = calRes.data.items.map(event => {
        const start = event.start.dateTime || event.start.date;
        const attendees = event.attendees ? event.attendees.map(a => a.email).join(', ') : 'None';
        
        return {
          content: `Upcoming Meeting: "${event.summary}" at ${start}. Attendees: ${attendees}. Description: ${event.description || 'None'}`,
          metadata: {
            user_id: userId,
            type: 'schedule',
            source: 'google_calendar',
            event_id: event.id
          }
        };
      });

      await mem0.add(eventMemories, { user_id: userId });
      console.log(`[Ingestion] Indexed ${eventMemories.length} calendar events.`);
    }

    console.log(`[Ingestion] Initial sync complete for ${userId}`);

  } catch (error) {
    console.error(`[Ingestion Failed] User ${userId}:`, error.message);
    // In production, you might want to flag the integration as 'error' here
  }

}, { connection });

// Handle worker errors
worker.on('error', err => {
  console.error('[IngestionWorker Error]', err);
});

module.exports = worker;