#!/usr/bin/env node
/**
 * Reconcile Transcript.user_id with Meeting.user_id
 *
 * Dry-run by default. Pass --apply to update documents.
 * Usage:
 *   node scripts/reconcile-transcripts.js           # dry-run
 *   node scripts/reconcile-transcripts.js --apply   # apply fixes
 */
const mongoose = require('mongoose');
// Minimal arg parsing to avoid ESM/CommonJS issues
require('dotenv').config();

const Transcript = require('../models/Transcript');
const Meeting = require('../models/Meeting');

async function main() {
  const argv = { apply: process.argv.includes('--apply') };

  const MONGO_URI = process.env.MONGO_URI;
  if (!MONGO_URI) {
    console.error('Missing MONGO_URI');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB:', mongoose.connection.db.databaseName);

  const meetings = await Meeting.find({ engaged: true }).lean();
  console.log(`Loaded ${meetings.length} engaged meetings`);

  let mismatches = 0;
  for (const m of meetings) {
    const t = await Transcript.findOne({ meeting_id: m.meeting_id });
    if (!t) continue;
    const meetingOwner = m.user_id?.toString();
    const transcriptOwner = t.user_id?.toString();

    if (meetingOwner && transcriptOwner && meetingOwner !== transcriptOwner) {
      mismatches++;
      console.log(`Mismatch: meeting_id=${m.meeting_id} meeting.user_id=${meetingOwner} transcript.user_id=${transcriptOwner}`);
      if (argv.apply) {
        t.user_id = m.user_id;
        await t.save();
        console.log(`  -> Fixed: set transcript.user_id=${meetingOwner}`);
      }
    }
  }

  console.log(`\nSummary: ${mismatches} mismatch(es) ${argv.apply ? 'fixed' : 'found (dry-run)'}.`);
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error('Error:', err);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
