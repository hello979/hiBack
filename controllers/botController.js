const { v4: uuidv4 } = require('uuid');
const Bot = require('../models/Bot');
const User = require('../models/users');
const { encrypt, decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');
const hicapyClient = require('../services/hicapyClient');

const sanitizeBot = (botDoc) => ({
  id: botDoc._id,
  bot_service_bot_id: botDoc.bot_service_bot_id,
  name: botDoc.name,
  system_prompt: botDoc.system_prompt,
  status: botDoc.status,
  created_at: botDoc.created_at,
  updated_at: botDoc.updated_at
});

const disableBotService = async (user) => {
  user.bot_service = user.bot_service || {};
  user.bot_service.enabled = false;
  user.bot_service.api_key = undefined;
  user.bot_service.last_disabled_at = new Date();
  await user.save();
};

const getUserApiKey = (user) => {
  const encryptedKey = user?.bot_service?.api_key;
  if (!encryptedKey) return null;
  return decrypt(encryptedKey);
};

exports.enableBots = async (req, res) => {
  const correlationId = uuidv4();
  console.log(`[bots.enable][${correlationId}] Starting enableBots for user: ${req.user?._id}`);
  
  try {
    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    
    if (!user) {
      console.log(`[bots.enable][${correlationId}] User not found`);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    console.log(`[bots.enable][${correlationId}] User found: ${user.email}, bot_service.enabled: ${user.bot_service?.enabled}, has_api_key: ${!!user.bot_service?.api_key}`);

    // If marked enabled but api_key is missing, clear enabled flag to force re-registration
    if (user.bot_service?.enabled && !user.bot_service?.api_key) {
      console.log(`[bots.enable][${correlationId}] Clearing stale enabled flag (no api_key)`);
      user.bot_service.enabled = false;
      await user.save();
    }

    // If already enabled and api_key present, short-circuit
    if (user.bot_service?.enabled && user.bot_service?.api_key) {
      console.log(`[bots.enable][${correlationId}] Already enabled with api_key, returning success`);
      return res.json({ success: true, enabled: true, alreadyEnabled: true, correlation_id: correlationId });
    }

    console.log(`[bots.enable][${correlationId}] Calling bot service to register user...`);
    
    const registration = await hicapyClient.registerUser({
      userId: user._id.toString(),
      email: user.email,
      correlationId
    });

    console.log(`[bots.enable][${correlationId}] Bot service response:`, JSON.stringify(registration.data));

    const apiKey = registration?.data?.api_key;
    if (!apiKey) {
      console.log(`[bots.enable][${correlationId}] No api_key in response`);
      throw new Error('Hicapy bot registration did not return an api_key');
    }

    console.log(`[bots.enable][${correlationId}] Got api_key: ${apiKey.substring(0, 10)}...`);

    // Initialize bot_service object if it doesn't exist
    if (!user.bot_service) {
      user.bot_service = {};
    }
    
    user.bot_service.enabled = true;
    user.bot_service.api_key = encrypt(apiKey);
    user.bot_service.created_at = new Date();
    
    await user.save();
    console.log(`[bots.enable][${correlationId}] User saved with bot_service enabled`);

    // Verify the save worked
    const verifyUser = await User.findById(user._id).select('+bot_service.api_key');
    console.log(`[bots.enable][${correlationId}] Verification - enabled: ${verifyUser.bot_service?.enabled}, has_key: ${!!verifyUser.bot_service?.api_key}`);

    return res.status(201).json({ success: true, enabled: true, correlation_id: registration.correlationId });
  } catch (error) {
    const status = error.status || 500;
    console.error(`[bots.enable][${correlationId}] ERROR:`, error.message, error.data || '');

    if (status === 401 || status === 403) {
      await disableBotService(req.user);
    }

    logger.logError(`[bots.enable][${correlationId}] ${error.message || status}`);
    return res.status(status).json({
      success: false,
      correlation_id: error.correlationId || correlationId,
      message: error.data?.message || error.message || 'Failed to enable bots'
    });
  }
};

exports.createBot = async (req, res) => {
  const correlationId = uuidv4();
  console.log(`[bots.create][${correlationId}] Starting createBot for user: ${req.user?._id}`);
  
  try {
    const { name, system_prompt } = req.body;
    console.log(`[bots.create][${correlationId}] Request body - name: ${name}, system_prompt: ${system_prompt ? 'provided' : 'empty'}`);
    
    if (!name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }

    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    
    if (!user) {
      console.log(`[bots.create][${correlationId}] User not found`);
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    console.log(`[bots.create][${correlationId}] User found: ${user.email}, bot_service.enabled: ${user.bot_service?.enabled}, has_api_key: ${!!user.bot_service?.api_key}`);
    
    const apiKey = getUserApiKey(user);
    console.log(`[bots.create][${correlationId}] Decrypted api_key: ${apiKey ? apiKey.substring(0, 10) + '...' : 'NULL'}`);

    if (!user?.bot_service?.enabled || !apiKey) {
      console.log(`[bots.create][${correlationId}] Bot service not enabled or no api_key - returning 403`);
      return res.status(403).json({ success: false, message: 'Bot service not enabled. Please call /api/bots/enable first.' });
    }

    console.log(`[bots.create][${correlationId}] Calling bot service to create bot...`);
    const remoteBot = await hicapyClient.createBot({ apiKey, name, system_prompt, correlationId });
    console.log(`[bots.create][${correlationId}] Bot service response:`, JSON.stringify(remoteBot.data));
    
    const remoteData = remoteBot.data || {};
    const botServiceId = remoteData.bot_id || remoteData.id || remoteData.botId;

    if (!botServiceId) {
      console.log(`[bots.create][${correlationId}] No bot_id in response`);
      throw new Error('Hicapy bot creation did not return a bot id');
    }

    console.log(`[bots.create][${correlationId}] Got bot_id: ${botServiceId}`);

    const bot = await Bot.create({
      user_id: req.user._id,
      bot_service_bot_id: botServiceId,
      name,
      system_prompt,
      status: 'idle'
    });

    console.log(`[bots.create][${correlationId}] Bot created locally with id: ${bot._id}`);

    return res.status(201).json({
      success: true,
      data: sanitizeBot(bot),
      correlation_id: remoteBot.correlationId
    });
  } catch (error) {
    const status = error.status || 500;
    console.error(`[bots.create][${correlationId}] ERROR:`, error.message, error.data || '');
    
    if (status === 401 || status === 403) {
      await disableBotService(req.user);
    }

    logger.logError(`[bots.create][${correlationId}] ${error.message || status}`);
    return res.status(status).json({
      success: false,
      correlation_id: error.correlationId || correlationId,
      message: error.data?.message || error.message || 'Failed to create bot'
    });
  }
};

exports.listBots = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+bot_service.api_key');
    
    // Check if bot service is properly enabled (both enabled flag AND api_key present)
    const apiKey = getUserApiKey(user);
    if (!user?.bot_service?.enabled || !apiKey) {
      // Return 403 to trigger frontend to show enable button
      return res.status(403).json({ 
        success: false, 
        message: 'Bot service not enabled. Please call /api/bots/enable first.' 
      });
    }
    
    const bots = await Bot.find({ user_id: req.user._id }).sort({ created_at: -1 });
    return res.json({ success: true, data: bots.map(sanitizeBot) });
  } catch (error) {
    logger.logError(`[bots.list] ${error.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch bots' });
  }
};
