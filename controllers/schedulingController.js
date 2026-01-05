const User = require('../models/users');
const Meeting = require('../models/Meeting');
const calendarService = require('../services/calendarService');
const gmailService = require('../services/gmailService');

/**
 * Public scheduling profile + availability
 */
exports.getPublicSchedule = async (req, res) => {
  try {
    const { username } = req.params;
    const lookup = await User.findOne({ username }).select('username email preferences thoughts access');

    if (!lookup) {
      return res.status(404).json({ success: false, message: 'Host not found' });
    }

    if (lookup.preferences?.publicBooking?.enabled === false) {
      return res.status(403).json({ success: false, message: 'Scheduling link disabled.' });
    }

    const slotMinutes = lookup.preferences?.publicBooking?.meetingDuration || 30;
    const availability = await calendarService.getAvailability(lookup._id, {
      days: Number(req.query.days) || 7,
      slotMinutes,
      timezone: lookup.preferences?.workingHours?.timezone || 'UTC',
      workingHours: lookup.preferences?.workingHours,
      bufferMinutes: lookup.preferences?.meetingBufferMinutes,
      workingDays: lookup.preferences?.workingDays
    });

    return res.json({
      success: true,
      host: {
        username: lookup.username,
        headline: lookup.preferences?.publicBooking?.headline || 'Connect with HiCapy',
        welcomeMessage: lookup.preferences?.publicBooking?.welcomeMessage || 'Grab 30 minutes to see the AI Chief of Staff in action.',
        timezone: availability.timezone,
        meetingDuration: slotMinutes,
        marketingHook: lookup.thoughts || 'Trusted AI operator for busy founders.',
        workingHours: lookup.preferences?.workingHours,
        workingDays: lookup.preferences?.workingDays
      },
      availability
    });
  } catch (error) {
    console.error('[Scheduling] Failed to load availability:', error.message);
    res.status(500).json({ success: false, message: 'Unable to load availability' });
  }
};

/**
 * Book a slot - requires authenticated attendee account
 */
exports.bookSlot = async (req, res) => {
  try {
    const { username } = req.params;
    const { slotStart, slotEnd, attendeeName, attendeeEmail, note } = req.body;

    if (!slotStart) {
      return res.status(400).json({ success: false, message: 'Slot start time required' });
    }

    const host = await User.findOne({ username }).select('username email preferences');
    if (!host) {
      return res.status(404).json({ success: false, message: 'Host not found' });
    }

    if (host.preferences?.publicBooking?.enabled === false) {
      return res.status(403).json({ success: false, message: 'Scheduling link disabled' });
    }

    const startTime = new Date(slotStart);
    const endTime = slotEnd ? new Date(slotEnd) : new Date(startTime.getTime() + (host.preferences?.publicBooking?.meetingDuration || 30) * 60000);

    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid slot selection' });
    }

    if (startTime < new Date()) {
      return res.status(400).json({ success: false, message: 'Please pick a future time' });
    }

    const available = await calendarService.isSlotAvailable(host._id, startTime, endTime);
    if (!available) {
      return res.status(409).json({ success: false, message: 'That slot was just booked. Please refresh.' });
    }

    const clientName = attendeeName || req.user?.username || 'Guest';
    const clientEmail = (attendeeEmail || req.user?.email || '').toLowerCase();
    if (!clientEmail) {
      return res.status(400).json({ success: false, message: 'A contact email is required.' });
    }

    const eventPayload = {
      title: `${clientName} × ${host.username}`,
      description: `Booked via HiCapy public link.\nAttendee: ${clientName} (${clientEmail})\nBooked by: ${req.user?.username || 'guest'}\nNotes: ${note || 'n/a'}`,
      startTime,
      endTime,
      attendees: [clientEmail],
      sendNotifications: true,
      createMeetLink: true,
      timeZone: host.preferences?.workingHours?.timezone || 'UTC'
    };

    const calendarEvent = await calendarService.createEvent(host._id, eventPayload);

    await Meeting.create({
      user_id: host._id,
      meeting_title: eventPayload.title,
      start_time: startTime,
      end_time: endTime,
      meetlink: calendarEvent.meetLink || calendarEvent.htmlLink,
      status: 'scheduled',
      calendar_event_id: calendarEvent.eventId
    });

    try {
      await gmailService.sendEmail(host._id, {
        recipients: [clientEmail],
        subject: `Confirmed: ${eventPayload.title}`,
        body: `Hi ${clientName},\n\nYou're confirmed for ${eventPayload.title}. We'll meet ${new Date(startTime).toLocaleString()} (${eventPayload.timeZone}).\n\nCalendar invite + Meet link: ${calendarEvent.meetLink || calendarEvent.htmlLink}\n\nSee you soon!\nTeam HiCapy`
      });
    } catch (emailError) {
      console.warn('[Scheduling] Unable to send confirmation email via Gmail:', emailError.message);
    }

    return res.json({
      success: true,
      meeting: {
        host: host.username,
        start: calendarEvent.start,
        end: calendarEvent.end,
        meetLink: calendarEvent.meetLink || calendarEvent.htmlLink
      },
      redirectUrl: '/'
    });
  } catch (error) {
    console.error('[Scheduling] Booking failed:', error.message);
    res.status(500).json({ success: false, message: error.message || 'Booking failed' });
  }
};
