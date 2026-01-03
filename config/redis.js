const IORedis = require('ioredis');

// BullMQ requires 'maxRetriesPerRequest' to be null
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined, // undefined if no password
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Retry strategy: wait 500ms, then 1000ms, etc. up to 2 seconds
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

// Production: Handle TLS (SSL) if your provider requires it (e.g., AWS/Heroku)
if (process.env.REDIS_TLS === 'true') {
  redisConfig.tls = {
    rejectUnauthorized: false // Often needed for self-signed certs in managed Redis
  };
}

const connection = new IORedis(redisConfig);

connection.on('connect', () => {
  console.log(`[Redis] Connected to ${redisConfig.host}:${redisConfig.port}`);
});

connection.on('error', (err) => {
  console.error('[Redis] Connection Error:', err.message);
});

module.exports = connection;