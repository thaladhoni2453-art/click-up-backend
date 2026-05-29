// backend/packages/redis/index.js
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let redisClient = null;
let isRedisOffline = false;

// Simulated in-memory cache fallback if Redis is offline
const inMemoryCache = {};

const getRedisClient = () => {
  if (isRedisOffline) return null;
  
  if (!redisClient) {
    try {
      redisClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy(times) {
          // If Redis is not running, stop trying after 2 attempts to prevent blocking
          if (times > 2) {
            console.warn(`[Redis] Connection failed. Switching to resilient in-memory caching fallback...`);
            isRedisOffline = true;
            redisClient = null;
            return null;
          }
          return Math.min(times * 100, 2000);
        },
      });

      redisClient.on("error", (err) => {
        // Suppress connection logs once offline fallback is active
        if (!isRedisOffline) {
          console.warn(`[Redis] Warning: Connection error on ${REDIS_URL}. Offline cache fallback active.`);
          isRedisOffline = true;
          redisClient = null;
        }
      });
    } catch (e) {
      console.warn(`[Redis] Failed to initialize Redis. Offline cache fallback active.`);
      isRedisOffline = true;
      redisClient = null;
    }
  }

  return redisClient;
};

// Resilient Wrapper utilities
const redisCache = {
  async get(key) {
    const client = getRedisClient();
    if (client) {
      try {
        return await client.get(key);
      } catch (e) {
        // Fallthrough to memory
      }
    }
    
    // In-Memory cache lookup
    const cached = inMemoryCache[key];
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.value;
      }
      delete inMemoryCache[key]; // Clean expired key
    }
    return null;
  },

  async set(key, value, ttlSeconds) {
    const client = getRedisClient();
    if (client) {
      try {
        if (ttlSeconds) {
          await client.set(key, value, "EX", ttlSeconds);
        } else {
          await client.set(key, value);
        }
        return;
      } catch (e) {
        // Fallthrough to memory
      }
    }

    // In-Memory cache set
    const expiry = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Date.now() + 3600 * 1000;
    inMemoryCache[key] = { value, expiresAt: expiry };
  },

  async del(key) {
    const client = getRedisClient();
    if (client) {
      try {
        await client.del(key);
        return;
      } catch (e) {
        // Fallthrough to memory
      }
    }
    delete inMemoryCache[key];
  },

  // Event Pub/Sub helper methods
  async publish(channel, message) {
    const client = getRedisClient();
    if (client) {
      try {
        await client.publish(channel, message);
      } catch (e) {
        // Suppress errors during pub/sub if offline
      }
    }
  }
};

module.exports = { getRedisClient, redisCache };
