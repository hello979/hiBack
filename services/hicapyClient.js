const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const BASE_URL = process.env.BOT_SERVICE_BASE_URL || 'http://44.211.217.115:8000';
const ADMIN_KEY = process.env.BOT_SERVICE_ADMIN_KEY;

if (!BASE_URL) {
  console.warn('[hicapyClient] BOT_SERVICE_BASE_URL is not set. Hicapy bot calls will fail until configured.');
}

const ensureBaseUrl = () => {
  if (!BASE_URL) {
    throw new Error('BOT_SERVICE_BASE_URL is not configured');
  }
};

const buildHeaders = ({ apiKey, useAdmin = false, correlationId }) => {
  const headers = {
    'Content-Type': 'application/json',
    'X-Correlation-Id': correlationId || uuidv4()
  };

  if (useAdmin) headers['X-Admin-Key'] = apiKey;
  else headers['X-API-Key'] = apiKey;

  return headers;
};

const handleError = (error, correlationId) => {
  const status = error.response?.status || 500;
  const data = error.response?.data || { message: error.message };

  logger.logError(`[HicapyBot][${correlationId}] ${status} ${JSON.stringify(data)}`);

  return {
    status,
    data,
    correlationId
  };
};

const request = async ({ method, url, data, headers }) => {
  const correlationId = headers?.['X-Correlation-Id'] || uuidv4();
  try {
    ensureBaseUrl();
    const res = await axios({
      method,
      url: `${BASE_URL}${url}`,
      data,
      headers
    });

    return { data: res.data, status: res.status, correlationId };
  } catch (error) {
    throw handleError(error, correlationId);
  }
};

const registerUser = async ({ userId, email, correlationId }) => {
  if (!ADMIN_KEY) {
    throw new Error('BOT_SERVICE_ADMIN_KEY is not configured');
  }

  const headers = buildHeaders({ apiKey: ADMIN_KEY, useAdmin: true, correlationId });
  return request({ method: 'POST', url: '/api/users/register', data: { user_id: userId, email }, headers });
};

const createBot = async ({ apiKey, name, system_prompt, correlationId }) => {
  const headers = buildHeaders({ apiKey, correlationId });
  return request({ method: 'POST', url: '/api/bots/', data: { name, system_prompt }, headers });
};

const listBots = async ({ apiKey, correlationId }) => {
  const headers = buildHeaders({ apiKey, correlationId });
  return request({ method: 'GET', url: '/api/bots/', headers });
};

const startBot = async ({ apiKey, botId, payload, correlationId }) => {
  const headers = buildHeaders({ apiKey, correlationId });
  return request({ method: 'POST', url: `/api/bots/${botId}/start`, data: payload, headers });
};

const stopBot = async ({ apiKey, botId, correlationId }) => {
  const headers = buildHeaders({ apiKey, correlationId });
  return request({ method: 'POST', url: `/api/bots/${botId}/stop`, headers });
};

// --- Scheduling Functions (Added for Auto-Join Logic) ---

const createSchedule = async ({ apiKey, payload, correlationId }) => {
  const headers = buildHeaders({ apiKey, correlationId });
  return request({ method: 'POST', url: '/api/schedules/', data: payload, headers });
};

const deleteSchedule = async ({ apiKey, scheduleId, correlationId }) => {
  const headers = buildHeaders({ apiKey, correlationId });
  try {
    return await request({ method: 'DELETE', url: `/api/schedules/${scheduleId}`, headers });
  } catch (error) {
    // If 404, the schedule is already gone, which is acceptable
    if (error.status === 404) {
      return { status: 404, correlationId: error.correlationId };
    }
    throw error;
  }
};

/**
 * Join a meeting with a bot
 * This uses the startBot endpoint with a meeting URL
 */
const joinMeeting = async ({ apiKey, botId, meetingUrl, correlationId }) => {
  const headers = buildHeaders({ apiKey, correlationId });
  return request({ 
    method: 'POST', 
    url: `/api/bots/${botId}/start`, 
    data: { meeting_url: meetingUrl }, 
    headers 
  });
};

module.exports = {
  registerUser,
  createBot,
  listBots,
  startBot,
  stopBot,
  createSchedule,
  deleteSchedule,
  joinMeeting
};