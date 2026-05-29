// backend/packages/events/index.js
const { redisCache } = require("@wavework/redis");

const publishEvent = async (channel, payload) => {
  try {
    const message = JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
    });
    
    // Publish using our resilient Redis wrapper
    await redisCache.publish(channel, message);
    console.log(`[Event Sourcing] Published to channel "${channel}"`);
  } catch (error) {
    console.warn(`[Event Sourcing] Failed to publish event payload:`, error);
  }
};

module.exports = { publishEvent };
