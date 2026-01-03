/**
 * Migration Script: Migrate OAuth tokens to Integration model
 * 
 * This script migrates existing OAuth tokens from the User model
 * to the new Integration model with encrypted storage.
 * 
 * USAGE:
 *   node scripts/migrate-oauth-tokens.js
 *   node scripts/migrate-oauth-tokens.js --dry-run
 * 
 * FLAGS:
 *   --dry-run   Preview changes without making modifications
 *   --force     Overwrite existing Integration records
 * 
 * SAFETY:
 * - Run with --dry-run first to preview changes
 * - The script does NOT delete original tokens from User model
 * - Existing Integration records are skipped unless --force is used
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/users');
const Integration = require('../models/Integration');

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

// Statistics
const stats = {
  usersProcessed: 0,
  notionMigrated: 0,
  slackMigrated: 0,
  googleCalendarMigrated: 0,
  skipped: 0,
  errors: 0
};

/**
 * Connect to MongoDB
 */
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

/**
 * Migrate tokens for a single user
 */
const migrateUserTokens = async (user) => {
  const userId = user._id.toString();
  
  // Migrate Notion tokens
  if (user.notionAccessToken) {
    const exists = await Integration.findOne({ userId, provider: 'notion' });
    
    if (exists && !FORCE) {
      console.log(`  [SKIP] Notion integration already exists for user ${userId}`);
      stats.skipped++;
    } else {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would migrate Notion for user ${userId}`);
      } else {
        const integration = exists || new Integration({ userId, provider: 'notion' });
        integration.setAccessToken(user.notionAccessToken);
        integration.status = 'connected';
        integration.metadata = {
          workspaceId: user.notionWorkspaceId,
          workspaceName: user.notionWorkspaceName,
          workspaceIcon: user.notionWorkspaceIcon,
          botId: user.notionBotId
        };
        await integration.save();
        console.log(`  [OK] Migrated Notion for user ${userId}`);
      }
      stats.notionMigrated++;
    }
  }
  
  // Migrate Slack tokens
  if (user.slackAccessToken) {
    const exists = await Integration.findOne({ userId, provider: 'slack' });
    
    if (exists && !FORCE) {
      console.log(`  [SKIP] Slack integration already exists for user ${userId}`);
      stats.skipped++;
    } else {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would migrate Slack for user ${userId}`);
      } else {
        const integration = exists || new Integration({ userId, provider: 'slack' });
        integration.setAccessToken(user.slackAccessToken);
        integration.status = 'connected';
        integration.metadata = {
          teamId: user.slackTeamId,
          teamName: user.slackTeamName,
          accountId: user.slackUserId,
          defaultChannelId: user.slackDefaultChannelId,
          defaultChannelName: user.slackDefaultChannelName
        };
        await integration.save();
        console.log(`  [OK] Migrated Slack for user ${userId}`);
      }
      stats.slackMigrated++;
    }
  }
  
  // Migrate Google Calendar tokens
  if (user.googleCalendarAccessToken || user.googleCalendarRefreshToken) {
    const exists = await Integration.findOne({ userId, provider: 'google_calendar' });
    
    if (exists && !FORCE) {
      console.log(`  [SKIP] Google Calendar integration already exists for user ${userId}`);
      stats.skipped++;
    } else {
      if (DRY_RUN) {
        console.log(`  [DRY-RUN] Would migrate Google Calendar for user ${userId}`);
      } else {
        const integration = exists || new Integration({ userId, provider: 'google_calendar' });
        
        if (user.googleCalendarAccessToken) {
          integration.setAccessToken(user.googleCalendarAccessToken);
        }
        if (user.googleCalendarRefreshToken) {
          integration.setRefreshToken(user.googleCalendarRefreshToken);
        }
        
        integration.status = 'connected';
        integration.expiresAt = user.googleCalendarExpiry;
        integration.metadata = {
          extra: {
            calendarSynced: user.calendarSynced,
            calendarLastSynced: user.calendarLastSynced
          }
        };
        await integration.save();
        console.log(`  [OK] Migrated Google Calendar for user ${userId}`);
      }
      stats.googleCalendarMigrated++;
    }
  }
};

/**
 * Main migration function
 */
const migrate = async () => {
  console.log('='.repeat(60));
  console.log('OAuth Token Migration Script');
  console.log('='.repeat(60));
  
  if (DRY_RUN) {
    console.log('\n*** DRY RUN MODE - No changes will be made ***\n');
  }
  
  if (FORCE) {
    console.log('\n*** FORCE MODE - Existing integrations will be overwritten ***\n');
  }
  
  await connectDB();
  
  // Find all users with any integration tokens
  const users = await User.find({
    $or: [
      { notionAccessToken: { $exists: true, $ne: null } },
      { slackAccessToken: { $exists: true, $ne: null } },
      { googleCalendarAccessToken: { $exists: true, $ne: null } },
      { googleCalendarRefreshToken: { $exists: true, $ne: null } }
    ]
  }).select(
    '+notionAccessToken +slackAccessToken +googleCalendarAccessToken +googleCalendarRefreshToken'
  );
  
  console.log(`Found ${users.length} users with integration tokens\n`);
  
  for (const user of users) {
    console.log(`Processing user: ${user.email} (${user._id})`);
    stats.usersProcessed++;
    
    try {
      await migrateUserTokens(user);
    } catch (error) {
      console.error(`  [ERROR] Failed to migrate user ${user._id}: ${error.message}`);
      stats.errors++;
    }
    
    console.log('');
  }
  
  // Print summary
  console.log('='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`Users processed:      ${stats.usersProcessed}`);
  console.log(`Notion migrated:      ${stats.notionMigrated}`);
  console.log(`Slack migrated:       ${stats.slackMigrated}`);
  console.log(`Google Cal migrated:  ${stats.googleCalendarMigrated}`);
  console.log(`Skipped:              ${stats.skipped}`);
  console.log(`Errors:               ${stats.errors}`);
  console.log('='.repeat(60));
  
  if (DRY_RUN) {
    console.log('\nThis was a dry run. Run without --dry-run to apply changes.');
  }
  
  await mongoose.connection.close();
  console.log('\nDone.');
  process.exit(0);
};

// Run migration
migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
