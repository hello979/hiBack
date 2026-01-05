/**
 * Calendar Service
 * Handles Google Calendar operations - both reading and writing
 */

const { google } = require('googleapis');
const { DateTime } = require('luxon');
const integrationHelper = require('../utils/integrationHelper');

/**
 * Get authenticated calendar client for a user
 */
const getCalendarClient = async (userId) => {
  // Use the new helper that checks both providers
  const { accessToken, refreshToken, provider } = await integrationHelper.getGoogleToken(userId);
  
  if (!accessToken && !refreshToken) {
    throw new Error('Google not connected. Please connect your Gmail & Calendar first.');
  }
  
  console.log(`[CalendarService] Using ${provider} provider for calendar operations`);

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  auth.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken
  });

  // Handle token refresh
  auth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      console.log('[CalendarService] Received refreshed token');
      // Token refresh handling is done by the OAuth client automatically
    }
  });

  return google.calendar({ version: 'v3', auth });
};

/**
 * Create a calendar event with automatic Google Meet link
 * 
 * @param {string} userId - User ID
 * @param {Object} eventData - Event details
 * @param {string} eventData.title - Event title/summary
 * @param {string} eventData.description - Event description
 * @param {Date|string} eventData.startTime - Start time
 * @param {Date|string} eventData.endTime - End time (optional, defaults to 1 hour after start)
 * @param {string[]} eventData.attendees - Array of attendee emails
 * @param {string} eventData.location - Event location
 * @param {boolean} eventData.sendNotifications - Whether to send invite emails
 * @param {boolean} eventData.createMeetLink - Whether to create Google Meet link (default: true)
 * @param {string} eventData.meetLink - Custom meeting link (if not using Google Meet)
 */
exports.createEvent = async (userId, eventData) => {
  const calendar = await getCalendarClient(userId);

  // Validate start time
  if (!eventData.startTime) {
    console.error('[CalendarService] No start time provided');
    return { success: false, error: 'Start time is required' };
  }

  const startTime = new Date(eventData.startTime);
  
  // Check for invalid date
  if (isNaN(startTime.getTime())) {
    console.error('[CalendarService] Invalid start time:', eventData.startTime);
    return { success: false, error: `Invalid start time: ${eventData.startTime}` };
  }
  
  const endTime = eventData.endTime 
    ? new Date(eventData.endTime) 
    : new Date(startTime.getTime() + 60 * 60 * 1000); // Default 1 hour

  const event = {
    summary: eventData.title,
    description: eventData.description || '',
    location: eventData.location || '',
    start: {
      dateTime: startTime.toISOString(),
      timeZone: eventData.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: eventData.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    attendees: eventData.attendees?.map(email => ({ email })) || [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 15 },
        { method: 'popup', minutes: 30 }
      ]
    }
  };

  // Add Google Meet link by default unless a custom link is provided
  const createMeetLink = eventData.createMeetLink !== false;
  if (createMeetLink && !eventData.meetLink) {
    // Generate unique request ID for conference
    const requestId = `hicapy-${userId}-${Date.now()}`;
    event.conferenceData = {
      createRequest: {
        requestId: requestId,
        conferenceSolutionKey: {
          type: 'hangoutsMeet'
        }
      }
    };
  } else if (eventData.meetLink) {
    // Use custom meeting link in description
    event.description = `${eventData.description || ''}\n\nMeeting Link: ${eventData.meetLink}`.trim();
  }

  try {
    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: createMeetLink && !eventData.meetLink ? 1 : 0,
      sendUpdates: eventData.sendNotifications !== false ? 'all' : 'none'
    });

    console.log(`[Calendar] Event created: ${response.data.id}`);
    
    // Extract Google Meet link from response
    const meetLink = response.data.conferenceData?.entryPoints?.find(
      ep => ep.entryPointType === 'video'
    )?.uri;
    
    return {
      success: true,
      eventId: response.data.id,
      htmlLink: response.data.htmlLink,
      meetLink: meetLink || eventData.meetLink || null,
      summary: response.data.summary,
      start: response.data.start,
      end: response.data.end,
      attendees: eventData.attendees || []
    };
  } catch (error) {
    const status = error?.code || error?.response?.status;
    const reason = error?.errors?.[0]?.reason || error?.response?.data?.error?.errors?.[0]?.reason;
    const isInsufficientPermission = status === 403 || reason === 'insufficientPermissions';
    const needsReconnect = isInsufficientPermission || /insufficient permission/i.test(error?.message || '');
    console.error('[Calendar] Failed to create event:', error.message, reason);
    if (needsReconnect) {
      throw new Error('Google Calendar needs write access. Reconnect your Google integration under Settings → Integrations and approve calendar access.');
    }
    throw new Error(`Failed to create calendar event: ${error.message}`);
  }
};

/**
 * Get upcoming events for a user
 */
exports.getUpcomingEvents = async (userId, maxResults = 10) => {
  const calendar = await getCalendarClient(userId);

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    });

    return response.data.items.map(event => ({
      id: event.id,
      title: event.summary,
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      location: event.location,
      attendees: event.attendees?.map(a => a.email) || [],
      htmlLink: event.htmlLink
    }));
  } catch (error) {
    console.error('[Calendar] Failed to fetch events:', error.message);
    throw error;
  }
};

/**
 * Get today's events
 */
exports.getTodayEvents = async (userId) => {
  const calendar = await getCalendarClient(userId);

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: today.toISOString(),
      timeMax: tomorrow.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    return response.data.items.map(event => ({
      id: event.id,
      title: event.summary,
      time: new Date(event.start?.dateTime || event.start?.date).toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
      }),
      attendees: event.attendees?.map(a => a.email).join(', ') || ''
    }));
  } catch (error) {
    console.error('[Calendar] Failed to fetch today events:', error.message);
    return [];
  }
};

/**
 * Compute availability windows for public scheduling links
 */
exports.getAvailability = async (userId, options = {}) => {
  const calendar = await getCalendarClient(userId);

  const timezone = options.timezone || options.workingHours?.timezone || 'UTC';
  const slotMinutes = options.slotMinutes || 30;
  const bufferMinutes = options.bufferMinutes ?? 15;
  const days = options.days || 7;
  let workingDays = Array.isArray(options.workingDays) && options.workingDays.length
    ? options.workingDays.map(Number).filter(d => d >= 0 && d <= 6)
    : [1, 2, 3, 4, 5]; // 0 = Sunday
  if (!workingDays.length) {
    workingDays = [1, 2, 3, 4, 5];
  }

  const baseStart = options.startDate
    ? DateTime.fromJSDate(new Date(options.startDate), { zone: timezone })
    : DateTime.now().setZone(timezone);

  const timeMin = baseStart.startOf('day').toISO();
  const timeMax = baseStart.plus({ days }).endOf('day').toISO();

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone: timezone,
      items: [{ id: 'primary' }]
    }
  });

  const busyBlocks = (response.data.calendars?.primary?.busy || []).map(block => ({
    start: DateTime.fromISO(block.start).setZone(timezone),
    end: DateTime.fromISO(block.end).setZone(timezone)
  }));

  const workStart = options.workingHours?.start || '09:00';
  const workEnd = options.workingHours?.end || '17:00';
  const [startHour, startMinute] = workStart.split(':').map(Number);
  const [endHour, endMinute] = workEnd.split(':').map(Number);
  const now = DateTime.now().setZone(timezone).plus({ minutes: bufferMinutes });

  const daysOutput = [];

  for (let day = 0; day < days; day++) {
    const windowDate = baseStart.plus({ days: day }).startOf('day');
    const isoWeekday = windowDate.weekday; // 1 (Mon) -> 7 (Sun)
    const jsWeekday = isoWeekday % 7; // convert to 0 (Sun) -> 6 (Sat)
    if (!workingDays.includes(jsWeekday)) {
      continue;
    }
    const dayStart = windowDate.set({ hour: startHour || 0, minute: startMinute || 0, second: 0, millisecond: 0 });
    const dayEnd = windowDate.set({ hour: endHour || 0, minute: endMinute || 0, second: 0, millisecond: 0 });

    if (dayEnd <= dayStart) continue;

    const slots = [];
    let cursor = dayStart;

    while (cursor.plus({ minutes: slotMinutes }) <= dayEnd) {
      const slotEnd = cursor.plus({ minutes: slotMinutes });

      const overlapsBusy = busyBlocks.some(block => {
        const paddedStart = block.start.minus({ minutes: bufferMinutes });
        const paddedEnd = block.end.plus({ minutes: bufferMinutes });
        return slotEnd > paddedStart && cursor < paddedEnd;
      });

      const isPast = slotEnd <= now;

      if (!overlapsBusy && !isPast) {
        slots.push({
          start: cursor.toUTC().toISO(),
          end: slotEnd.toUTC().toISO(),
          label: `${cursor.toFormat('hh:mm a')} – ${slotEnd.toFormat('hh:mm a')}`,
          localStart: cursor.toISO(),
          localEnd: slotEnd.toISO()
        });
      }

      cursor = cursor.plus({ minutes: slotMinutes });
    }

    const dayBusy = busyBlocks
      .filter(block => block.start.hasSame(windowDate, 'day'))
      .map(block => ({
        start: block.start.toUTC().toISO(),
        end: block.end.toUTC().toISO(),
        localStart: block.start.toISO(),
        localEnd: block.end.toISO()
      }));

    daysOutput.push({
      date: windowDate.toISODate(),
      readable: windowDate.toFormat('EEE, MMM d'),
      weekday: jsWeekday,
      slots,
      busy: dayBusy
    });
  }

  return {
    timezone,
    slotMinutes,
    workingHours: { start: workStart, end: workEnd },
    bufferMinutes,
    workingDays,
    days: daysOutput
  };
};

/**
 * Ensure a slot is still available before booking (no overlapping events)
 */
exports.isSlotAvailable = async (userId, startTime, endTime) => {
  const calendar = await getCalendarClient(userId);

  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin: new Date(startTime).toISOString(),
      timeMax: new Date(endTime).toISOString(),
      items: [{ id: 'primary' }]
    }
  });

  const busy = response.data.calendars?.primary?.busy || [];
  return busy.length === 0;
};

/**
 * Update an existing event
 */
exports.updateEvent = async (userId, eventId, updates) => {
  const calendar = await getCalendarClient(userId);

  try {
    const response = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      resource: updates
    });

    return {
      success: true,
      event: response.data
    };
  } catch (error) {
    console.error('[Calendar] Failed to update event:', error.message);
    throw error;
  }
};

/**
 * Delete an event
 */
exports.deleteEvent = async (userId, eventId) => {
  const calendar = await getCalendarClient(userId);

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId
    });

    return { success: true };
  } catch (error) {
    console.error('[Calendar] Failed to delete event:', error.message);
    throw error;
  }
};
