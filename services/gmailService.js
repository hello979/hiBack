const { google } = require('googleapis');
const integrationHelper = require('../utils/integrationHelper');

exports.sendEmail = async (userId, payload) => {
  // Use the helper that checks both providers
  const { accessToken, refreshToken, provider } = await integrationHelper.getGoogleToken(userId);

  if (!accessToken && !refreshToken) {
    throw new Error("Google not connected. Please connect Gmail & Calendar first.");
  }
  
  console.log(`[GmailService] Using ${provider} provider for email`);

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  
  auth.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  const gmail = google.gmail({ version: 'v1', auth });

  // 2. Construct Raw Email (MIME)
  const subject = payload.subject;
  const to = payload.recipients.join(',');
  const body = payload.body;
  
  const str = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body
  ].join('\n');

  const raw = Buffer.from(str).toString("base64").replace(/\+/g, '-').replace(/\//g, '_');

  // 3. Send
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });
  
  console.log(`[Success] Email sent via user's Google integration`);
};