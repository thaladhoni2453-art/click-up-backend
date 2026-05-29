// backend/services/realtime-service/server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const Redis = require("ioredis");

const { mockDb } = require("../../src/lib/mockDb");

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: true, credentials: true }));

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});


const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

let pubClient = null;
let subClient = null;

try {
  pubClient = new Redis(REDIS_URL);
  subClient = new Redis(REDIS_URL);

  pubClient.on("connect", () => {
    console.log("[Realtime Service] Redis Publisher Connected");
  });
  subClient.on("connect", () => {
    console.log("[Realtime Service] Redis Subscriber Connected");
  });

  subClient.subscribe("ws:emit", (err) => {
    if (err) {
      console.error("[Realtime Service] Subscribe failed:", err);
    } else {
      console.log('[Realtime Service] Subscribed to "ws:emit" channel');
    }
  });
  pubClient.on("error", (err) => {
    console.error("[Realtime Redis Pub Error]", err.message);
  });

  subClient.on("error", (err) => {
    console.error("[Realtime Redis Sub Error]", err.message);
  });

  subClient.on("message", (channel, message) => {
    if (channel === "ws:emit") {
      try {
        const { room, event, data } = JSON.parse(message);

        console.log(
          `[Realtime Service] Redis Broadcast -> ${room}: ${event}`
        );

        io.to(room).emit(event, data);
      } catch (e) {
        console.error("[Realtime Service] Message parse error:", e);
      }
    }
  });

} catch (e) {
  console.warn(
    "[Realtime Service] Redis not connected. Running local Socket.io gateway..."
  );
}

// Active identified users tracking presence map
const activeUsers = new Map(); // socket.id -> userId

io.on("connection", (socket) => {
  console.log(`[Realtime Service] WebSocket client connected: ${socket.id}`);

  // User identification presence registration
  socket.on("identify", (userId) => {
    socket.userId = userId;
    activeUsers.set(socket.id, userId);
    console.log(`[Presence] User identified: ${userId} (${socket.id})`);

    // Broadcast user is online
    io.emit("user:online", { userId });

    // Send the current list of online users back to the identifying client
    const onlineUserIds = Array.from(new Set(activeUsers.values()));
    socket.emit("presence:list", onlineUserIds);
  });

  socket.on("join:workspace", (workspaceId) => {
    socket.join(`workspace:${workspaceId}`);
    console.log(`[Realtime Service] Socket ${socket.id} joined room workspace:${workspaceId}`);
  });

  socket.on("join:task", (taskId) => {
    socket.join(`task:${taskId}`);
    console.log(`[Realtime Service] Socket ${socket.id} joined room task:${taskId}`);
  });

  socket.on("join:channel", (channelId) => {
    socket.join(`channel:${channelId}`);
    console.log(`[Realtime Service] Socket ${socket.id} joined room channel:${channelId}`);
  });

  socket.on("chat:message", ({ channelId, message }) => {
    console.log(`[Realtime Service] Socket ${socket.id} sent message to channel:${channelId}`);
    io.to(`channel:${channelId}`).emit(`chat:${channelId}:message`, message);
  });

  socket.on("room:emit", ({ room, event, data }) => {
    console.log(`[Realtime Service] Socket ${socket.id} emitted room event -> ${room}: ${event}`);
    io.to(room).emit(event, data);
  });

  socket.on("disconnect", () => {
    console.log(`[Realtime Service] WebSocket client disconnected: ${socket.id}`);

    const userId = activeUsers.get(socket.id);
    if (userId) {
      activeUsers.delete(socket.id);
      console.log(`[Presence] User offline: ${userId}`);

      // Check if user is still logged in from another active browser tab
      const stillConnected = Array.from(activeUsers.values()).includes(userId);
      if (!stillConnected) {
        const lastActiveAt = new Date().toISOString();

        // Save last active state inside in-memory mock database
        const mockUserObj = mockDb.users.find(u => u.id === userId);
        if (mockUserObj) {
          mockUserObj.lastActiveAt = lastActiveAt;
        }

        io.emit("user:offline", { userId, lastActiveAt });
      }
    }
  });
});

const PORT = 3004;
server.listen(PORT, () => {
  console.log(`[Realtime Service] WebSocket server listening on Port ${PORT}`);
});
