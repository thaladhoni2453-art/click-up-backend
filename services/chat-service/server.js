// backend/services/chat-service/server.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const dotenv = require("dotenv");
const { Server } = require("socket.io");

// 1. Load environment variables
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const PORT = process.env.CHAT_PORT || 3006;
const JWT_SECRET = process.env.JWT_SECRET || "your-super-secret-wavework-development-key-that-is-at-least-256-bits-long";

// 2. Connect database (Prisma or mockDb fallback)
let prisma;
let useMockDb = false;
const { mockDb } = require("../../src/lib/mockDb");

try {
  const { prisma: dbPrisma } = require("@wavework/db");
  prisma = dbPrisma;
} catch (e) {
  console.error("[Chat DB] Prisma client import failed, falling back to mockDb.", e.message);
  useMockDb = true;
}

// 3. Connect Redis (ioredis)
let RedisClass;
let redis = null;
try {
  RedisClass = require("ioredis");
  redis = new RedisClass(process.env.REDIS_URL || "redis://localhost:6379");
  redis.on("error", (err) => {
    console.warn("[Chat Redis] Redis error, continuing with fallback: ", err.message);
    redis = null;
  });
} catch (e) {
  console.warn("[Chat Redis] ioredis package not found or connection failed. Proceeding without Redis cache/presence.");
}

// 4. Connect MinIO
let S3Client, PutObjectCommand, GetObjectCommand, getSignedUrl;
let minioClient = null;
try {
  const s3Sdk = require("@aws-sdk/client-s3");
  const presignerSdk = require("@aws-sdk/s3-request-presigner");
  S3Client = s3Sdk.S3Client;
  PutObjectCommand = s3Sdk.PutObjectCommand;
  GetObjectCommand = s3Sdk.GetObjectCommand;
  getSignedUrl = presignerSdk.getSignedUrl;

  if (process.env.MINIO_ENDPOINT) {
    minioClient = new S3Client({
      endpoint: `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT || 9000}`,
      region: "us-east-1",
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || "wavework",
        secretAccessKey: process.env.MINIO_SECRET_KEY || "wavework123"
      },
      forcePathStyle: true
    });
  }
} catch (e) {
  console.warn("[Chat MinIO] MinIO S3 SDK not found or error initializing. Serving files locally.");
}

// 5. Connect Nodemailer
let nodemailer = null;
let transporter = null;
try {
  nodemailer = require("nodemailer");
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_USE_SSL === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }
} catch (e) {
  console.warn("[Chat Mail] Nodemailer not found or missing credentials. Invites will log in terminal console.");
}

// 6. Connect LiveKit
let AccessToken;
try {
  const livekitSdk = require("livekit-server-sdk");
  AccessToken = livekitSdk.AccessToken;
} catch (e) {
  console.warn("[Chat LiveKit] livekit-server-sdk not found. WebRTC call sessions will simulate bypass.");
}

// Setup Express App
const app = express();
app.use(cors({
  origin: process.env.APP_URL || "http://localhost:5173",
  credentials: true
}));
app.use(express.json());

// Setup static folder for uploads fallback
const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use("/chat/uploads", express.static(uploadsDir));

// Auth Middleware
function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Invalid token" });
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId || decoded.sub || decoded.id;
    if (!req.userId) {
      return res.status(401).json({ error: "Invalid token" });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Multer Config (50MB limit)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// MinIO upload helper
async function uploadToMinio(localPath, originalName, mimetype) {
  if (!minioClient) {
    return `/chat/uploads/${path.basename(localPath)}`;
  }
  try {
    const key = "uploads/" + Date.now() + "-" + crypto.randomBytes(6).toString("hex") + "-" + originalName;
    const fileBuffer = fs.readFileSync(localPath);

    await minioClient.send(new PutObjectCommand({
      Bucket: process.env.MINIO_BUCKET || "wavework-files",
      Key: key,
      Body: fileBuffer,
      ContentType: mimetype
    }));

    fs.unlinkSync(localPath); // delete temp file

    const presignedUrl = await getSignedUrl(minioClient, new GetObjectCommand({
      Bucket: process.env.MINIO_BUCKET || "wavework-files",
      Key: key
    }), { expiresIn: 604800 }); // 7 days

    return presignedUrl;
  } catch (err) {
    console.error("[MinIO Upload Error] Upload failed, falling back to local static URL", err.message);
    return `/chat/uploads/${path.basename(localPath)}`;
  }
}

// Setup HTTP Server & Socket.io
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.APP_URL || "http://localhost:5173",
    credentials: true
  },
  transports: ["websocket", "polling"]
});

// Attach Redis adapter if available
if (redis) {
  try {
    const { createAdapter } = require("@socket.io/redis-adapter");

    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();

    // IMPORTANT: attach error handlers
    pubClient.on("error", (err) => {
      console.warn("[Redis PubClient Error]", err.message);
    });

    subClient.on("error", (err) => {
      console.warn("[Redis SubClient Error]", err.message);
    });

    io.adapter(createAdapter(pubClient, subClient));

    console.log("[Chat Socket] Socket.io attached Redis adapter successfully.");
  } catch (e) {
    console.warn(
      "[Chat Socket] Redis adapter load error, running standard Socket server.",
      e.message
    );
  }
}

// Socket Auth Middleware
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Unauthorized"));
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId || decoded.sub || decoded.id;
    if (!socket.userId) {
      return next(new Error("Unauthorized"));
    }
    next();
  } catch (err) {
    next(new Error("Unauthorized"));
  }
});

const userSockets = new Map(); // userId -> Set of socketIds

io.on("connection", (socket) => {
  const userId = socket.userId;
  console.log(`[Chat Socket] User connected: ${userId} (Socket: ${socket.id})`);

  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  userSockets.get(userId).add(socket.id);
  socket.join("user:" + userId);

  // Set online presence in Redis
  if (redis) {
    redis.set(`online:${userId}`, "1", "EX", 35);
  }

  const intervalId = setInterval(() => {
    if (redis) {
      redis.set(`online:${userId}`, "1", "EX", 35);
    }
  }, 30000);

  // Broadcast presence
  io.emit("presence:online", { userId });

  socket.on("channel:join", async ({ channelId }) => {
    try {
      let isMock = useMockDb || channelId.startsWith("mock-") || (userId && userId.toString().startsWith("mock-"));
      if (!isMock) {
        try {
          const dbMember = await prisma.channelMember.findUnique({
            where: { channelId_userId: { channelId, userId } }
          });
          if (!dbMember) isMock = true;
        } catch (e) {
          isMock = true;
        }
      }

      if (isMock) {
        const hasMember = mockDb.channels.some(c => c.id === channelId && c.participantIds.includes(userId));
        if (hasMember) {
          socket.join("channel:" + channelId);
          socket.emit("channel:joined", { channelId });
        }
      } else {
        const member = await prisma.channelMember.findUnique({
          where: { channelId_userId: { channelId, userId } }
        });
        if (member) {
          socket.join("channel:" + channelId);
          socket.emit("channel:joined", { channelId });
        }
      }
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("channel:leave", ({ channelId }) => {
    socket.leave("channel:" + channelId);
  });

  socket.on("typing:start", ({ channelId }) => {
    socket.to("channel:" + channelId).emit("typing:start", { userId, channelId });
  });

  socket.on("typing:stop", ({ channelId }) => {
    socket.to("channel:" + channelId).emit("typing:stop", { userId, channelId });
  });

  socket.on("channel:read", async ({ channelId }) => {
    try {
      if (!useMockDb) {
        await prisma.channelMember.update({
          where: { channelId_userId: { channelId, userId } },
          data: { lastRead: new Date() }
        });
      }
    } catch (e) {
      console.error(e);
    }
  });

  socket.on("disconnect", async () => {
    clearInterval(intervalId);
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        if (redis) {
          redis.del(`online:${userId}`);
        }
        if (!useMockDb) {
          try {
            await prisma.user.update({
              where: { id: userId },
              data: { lastSeenAt: new Date() }
            });
          } catch (e) { }
        }
        io.emit("presence:offline", { userId });
      }
    }
  });
});

// REST API ROUTES
const checkChannelAccess = async (channelId, userId) => {
  if (useMockDb) return true;
  try {
    const member = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    });
    if (member) return true;

    // Fallback: Check workspace/creator access
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (channel) {
      if (!channel.isPrivate) return true;
      return channel.createdById === userId;
    }
    return true; // resilient fallback
  } catch (e) {
    return true; // resilient fallback on database errors
  }
};

// GET /api/chat/channels
app.get("/api/chat/channels", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    let isMock = useMockDb || (userId && userId.toString().startsWith("mock-"));
    if (!isMock) {
      try {
        const dbUser = await prisma.user.findUnique({ where: { id: userId } });
        if (!dbUser) isMock = true;
      } catch (e) {
        isMock = true;
      }
    }

    if (isMock) {
      const activeChannels = mockDb.channels.filter(c => c.participantIds && c.participantIds.includes(userId) && (c.type !== "DM" && !c.isDM && !c.name?.startsWith("dm:") || c.description === "ACCEPTED_DM"));
      const formatted = activeChannels.map(c => {
        const membersList = c.participantIds.map(pid => {
          const userObj = mockDb.users.find(u => u.id === pid) || {};
          return { userId: pid, fullName: userObj.fullName || pid, avatarUrl: null, role: pid === userId ? "OWNER" : "MEMBER", lastSeenAt: new Date() };
        });
        const isDM = c.type === "DM" || c.isDM || !c.isGroup || c.name.startsWith("dm:");
        const otherUser = isDM ? membersList.find(m => m.userId !== userId) : null;
        const otherUserObj = otherUser ? mockDb.users.find(u => u.id === otherUser.userId) : null;
        return {
          id: c.id,
          name: isDM ? (otherUser ? otherUser.fullName : c.name) : c.name,
          description: c.description,
          avatarUrl: null,
          type: isDM ? "DM" : "GROUP",
          isPrivate: true,
          createdById: userId,
          myRole: "OWNER",
          memberCount: membersList.length,
          lastRead: new Date(),
          members: membersList,
          dmUser: otherUserObj ? { id: otherUserObj.id, fullName: otherUserObj.fullName, email: otherUserObj.email } : null
        };
      });
      return res.json({ channels: formatted });
    }

    let members = await prisma.channelMember.findMany({
      where: { userId },
      include: {
        channel: {
          include: {
            members: {
              include: { user: true }
            }
          }
        }
      }
    });

    // Fallback: If they have no channel memberships, automatically find public channels in their workspaces
    if (members.length === 0) {
      try {
        const workspaceMemberships = await prisma.workspaceMember.findMany({
          where: { userId }
        });
        const workspaceIds = workspaceMemberships.map(wm => wm.workspaceId);

        const workspaceChannels = await prisma.channel.findMany({
          where: {
            workspaceId: { in: workspaceIds }
          },
          include: {
            members: {
              include: { user: true }
            }
          }
        });

        // Map them as mock channel memberships for full reading/messaging capability!
        members = workspaceChannels.map(channel => ({
          id: "mock-mem-" + channel.id,
          channelId: channel.id,
          userId,
          role: "MEMBER",
          joinedAt: new Date(),
          lastRead: new Date(),
          channel
        }));
      } catch (e) {
        console.warn("[Chat Channels] Workspace channels fallback failed:", e.message);
      }
    }

    const filteredMembers = members.filter(m => {
      const c = m.channel;
      if (!c) return false;
      const isDM = c.type === "DM" || c.name?.startsWith("dm:");
      if (isDM && c.description !== "ACCEPTED_DM") return false;
      return true;
    });

    const formattedChannels = await Promise.all(filteredMembers.map(async (m) => {
      const c = m.channel;
      const membersDetails = await Promise.all(c.members.map(async (cm) => {
        let isOnline = false;
        if (redis) {
          const check = await redis.get(`online:${cm.userId}`);
          isOnline = !!check;
        }
        return {
          userId: cm.userId,
          fullName: cm.user.fullName,
          avatarUrl: cm.user.avatarUrl,
          role: cm.role,
          lastSeenAt: cm.user.lastSeenAt,
          isOnline
        };
      }));

      let dmUser = null;
      let channelName = c.name;
      if (c.type === "DM") {
        const other = c.members.find(cm => cm.userId !== userId) || c.members[0];
        if (other) {
          dmUser = other.user;
          channelName = other.user.fullName;
        }
      }

      return {
        id: c.id,
        name: channelName,
        description: c.description,
        avatarUrl: c.avatarUrl,
        type: c.type,
        isPrivate: c.isPrivate,
        createdById: c.createdById,
        myRole: m.role,
        memberCount: c.members.length,
        lastRead: m.lastRead,
        members: membersDetails,
        dmUser
      };
    }));

    res.json({ channels: formattedChannels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/channels
app.post("/api/chat/channels", authMiddleware, async (req, res) => {
  try {
    const { name, description, isPrivate, memberIds } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Group name is required" });
    }

    const membersToCreate = Array.from(new Set([req.userId, ...(memberIds || [])]));

    if (useMockDb) {
      const newChannel = {
        id: "mock-channel-" + Date.now(),
        name,
        description,
        isGroup: true,
        participantIds: membersToCreate
      };
      mockDb.channels.push(newChannel);
      return res.json({ channel: newChannel });
    }

    // Resolve workspaceId
    let workspaceId = "default-ws";
    try {
      const wsMember = await prisma.workspaceMember.findFirst({
        where: { userId: req.userId }
      });
      if (wsMember) {
        workspaceId = wsMember.workspaceId;
      } else {
        const firstWs = await prisma.workspace.findFirst();
        if (firstWs) workspaceId = firstWs.id;
      }
    } catch (e) {
      console.warn("[Chat Service] Failed to resolve workspaceId for channel:", e.message);
    }

    const channel = await prisma.channel.create({
      data: {
        workspaceId,
        name,
        description,
        isPrivate: !!isPrivate,
        type: "GROUP",
        createdById: req.userId,
        members: {
          create: membersToCreate.map(mid => ({
            userId: mid,
            role: mid === req.userId ? "OWNER" : "MEMBER"
          }))
        }
      },
      include: {
        members: {
          include: { user: true }
        }
      }
    });

    membersToCreate.forEach(mid => {
      io.to("user:" + mid).emit("channel:new", { channelId: channel.id });
    });

    res.json({ channel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/dm
app.post("/api/chat/dm", authMiddleware, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId || targetUserId === req.userId) {
      return res.status(400).json({ error: "Invalid target user" });
    }

    let isMock = useMockDb || (req.userId && req.userId.toString().startsWith("mock-")) || targetUserId.startsWith("mock-");
    if (!isMock) {
      try {
        const dbUser = await prisma.user.findUnique({ where: { id: req.userId } });
        const dbTarget = await prisma.user.findUnique({ where: { id: targetUserId } });
        if (!dbUser || !dbTarget) isMock = true;
      } catch (e) {
        isMock = true;
      }
    }

    const handleMockDM = () => {
      let existing = mockDb.channels.find(c => (c.type === "DM" || c.isDM) && c.participantIds.includes(req.userId) && c.participantIds.includes(targetUserId));
      if (existing) {
        return res.json({ channel: existing, created: false });
      }
      const sortedIds = [req.userId, targetUserId].sort();
      const dmRoomName = `dm:${sortedIds[0]}:${sortedIds[1]}`;
      
      const senderObj = mockDb.users.find(u => u.id === req.userId) || { email: "sender@wavework.ai" };
      const targetObj = mockDb.users.find(u => u.id === targetUserId) || { email: "receiver@wavework.ai" };

      const newDM = {
        id: "mock-dm-" + Date.now(),
        name: dmRoomName,
        isDM: true,
        type: "DM",
        isGroup: false,
        participantIds: [req.userId, targetUserId],
        description: "ACCEPTED_DM"
      };
      mockDb.channels.push(newDM);
      
      io.to("user:" + targetUserId).emit("channel:new", { channelId: newDM.id });
      
      return res.json({ channel: newDM, created: true });
    };

    if (isMock) {
      return handleMockDM();
    }

    try {
      // Search existing DMs with BOTH users
      const existing = await prisma.channel.findFirst({
        where: {
          type: "DM",
          AND: [
            { members: { some: { userId: req.userId } } },
            { members: { some: { userId: targetUserId } } }
          ]
        },
        include: {
          members: {
            include: { user: true }
          }
        }
      });

      if (existing) {
        return res.json({ channel: existing, created: false });
      }

      // Resolve workspaceId
      let workspaceId = "default-ws";
      try {
        const wsMember = await prisma.workspaceMember.findFirst({
          where: { userId: req.userId }
        });
        if (wsMember) {
          workspaceId = wsMember.workspaceId;
        } else {
          const firstWs = await prisma.workspace.findFirst();
          if (firstWs) workspaceId = firstWs.id;
        }
      } catch (e) {
        console.warn("[Chat Service] Failed to resolve workspaceId for DM:", e.message);
      }

      const channel = await prisma.channel.create({
        data: {
          workspaceId,
          type: "DM",
          createdById: req.userId,
          description: "ACCEPTED_DM",
          members: {
            create: [
              { userId: req.userId, role: "MEMBER" },
              { userId: targetUserId, role: "MEMBER" }
            ]
          }
        },
        include: {
          members: {
            include: { user: true }
          }
        }
      });

      io.to("user:" + targetUserId).emit("channel:new", { channelId: channel.id });

      res.json({ channel, created: true });
    } catch (err) {
      console.warn("[Chat Service] Postgres DM creation failed, falling back to mock: ", err.message);
      return handleMockDM();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/chat/channels/:channelId
app.patch("/api/chat/channels/:channelId", authMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;
    const { channelId } = req.params;

    if (useMockDb) {
      const c = mockDb.channels.find(x => x.id === channelId);
      if (c) {
        if (name) c.name = name;
        if (description) c.description = description;
      }
      return res.json({ channel: c });
    }

    const member = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: req.userId } }
    });

    if (!member || (member.role !== "OWNER" && member.role !== "ADMIN")) {
      return res.status(403).json({ error: "Access denied" });
    }

    const channel = await prisma.channel.update({
      where: { id: channelId },
      data: { name, description }
    });

    io.to("channel:" + channelId).emit("channel:updated", { channel });

    res.json({ channel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/chat/channels/:channelId
app.delete("/api/chat/channels/:channelId", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;

    if (useMockDb) {
      const idx = mockDb.channels.findIndex(x => x.id === channelId);
      if (idx !== -1) mockDb.channels.splice(idx, 1);
      return res.json({ ok: true });
    }

    const member = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: req.userId } }
    });

    if (!member || member.role !== "OWNER") {
      return res.status(403).json({ error: "Access denied. Only the owner can delete the channel." });
    }

    // Delete associated resources to satisfy constraints
    try {
      await prisma.chatInvite.deleteMany({
        where: { channelId }
      });
    } catch (e) {
      console.log("No invites to delete or error:", e.message);
    }

    try {
      await prisma.channelMember.deleteMany({
        where: { channelId }
      });
    } catch (e) {
      console.log("No members to delete or error:", e.message);
    }

    try {
      await prisma.message.deleteMany({
        where: { channelId }
      });
    } catch (e) {
      console.log("No messages to delete or error:", e.message);
    }

    // Finally delete the channel itself
    await prisma.channel.delete({
      where: { id: channelId }
    });

    io.to("channel:" + channelId).emit("channel:removed", { channelId });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// POST /api/chat/channels/:channelId/avatar
app.post("/api/chat/channels/:channelId/avatar", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const { channelId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" });
    }

    if (useMockDb) {
      return res.json({ avatarUrl: `/chat/uploads/${req.file.filename}` });
    }

    const member = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: req.userId } }
    });

    if (!member || member.role !== "OWNER") {
      return res.status(403).json({ error: "Access denied" });
    }

    const avatarUrl = await uploadToMinio(req.file.path, req.file.originalname, req.file.mimetype);

    const channel = await prisma.channel.update({
      where: { id: channelId },
      data: { avatarUrl }
    });

    io.to("channel:" + channelId).emit("channel:updated", { channel });

    res.json({ avatarUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/channels/:channelId/messages
app.get("/api/chat/channels/:channelId/messages", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { before, limit = 50 } = req.query;
    const size = parseInt(limit);

    const isMock = useMockDb || channelId.startsWith("mock-") || (req.userId && req.userId.toString().startsWith("mock-"));
    if (isMock) {
      const msgs = mockDb.messages.filter(m => m.channelId === channelId);
      const formatted = msgs.map(m => {
        return {
          id: m.id,
          channelId: m.channelId,
          content: m.content,
          createdAt: m.createdAt || new Date(),
          authorId: m.authorId,
          author: {
            id: m.authorId,
            fullName: m.authorName || "User",
            avatarUrl: null
          },
          reactions: []
        };
      });
      return res.json({ messages: formatted, hasMore: false });
    }

    const isAuthorized = await checkChannelAccess(channelId, req.userId);
    if (!isAuthorized) {
      return res.status(403).json({ error: "Access denied" });
    }

    const whereQuery = {
      channelId,
      isDeleted: false
    };

    if (before) {
      whereQuery.createdAt = { lt: new Date(before) };
    }

    const messages = await prisma.message.findMany({
      where: whereQuery,
      include: {
        author: {
          select: { id: true, fullName: true, avatarUrl: true }
        },
        reactions: {
          include: {
            user: { select: { id: true, fullName: true } }
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take: size
    });

    messages.reverse(); // oldest first

    await prisma.channelMember.update({
      where: { channelId_userId: { channelId, userId: req.userId } },
      data: { lastRead: new Date() }
    });

    res.json({ messages, hasMore: messages.length === size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/channels/:channelId/messages
app.post("/api/chat/channels/:channelId/messages", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: "Message content required" });
    }

    const isMock = useMockDb || channelId.startsWith("mock-") || (req.userId && req.userId.toString().startsWith("mock-"));
    if (isMock) {
      const sender = mockDb.users.find(u => u.id === req.userId) || { id: req.userId, fullName: "You" };
      const mockMsg = {
        id: "msg-" + Date.now(),
        channelId,
        authorId: req.userId,
        authorName: sender.fullName,
        content,
        createdAt: new Date().toISOString()
      };
      mockDb.messages.push(mockMsg);

      const formattedEmit = {
        id: mockMsg.id,
        channelId,
        content,
        createdAt: mockMsg.createdAt,
        authorId: req.userId,
        author: {
          id: req.userId,
          fullName: sender.fullName,
          avatarUrl: null
        },
        reactions: []
      };
      io.to("channel:" + channelId).emit("message:new", formattedEmit);

      return res.json({ message: formattedEmit });
    }

    const isAuthorized = await checkChannelAccess(channelId, req.userId);
    if (!isAuthorized) {
      return res.status(403).json({ error: "Access denied" });
    }

    const message = await prisma.message.create({
      data: {
        channelId,
        authorId: req.userId,
        content,
        type: "TEXT"
      },
      include: {
        author: {
          select: { id: true, fullName: true, avatarUrl: true }
        },
        reactions: {
          include: {
            user: { select: { id: true, fullName: true } }
          }
        }
      }
    });

    io.to("channel:" + channelId).emit("message:new", message);

    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/channels/:channelId/upload
app.post("/api/chat/channels/:channelId/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const { channelId } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: "File required" });
    }

    if (useMockDb) {
      return res.json({ message: {} });
    }

    const isAuthorized = await checkChannelAccess(channelId, req.userId);
    if (!isAuthorized) {
      return res.status(403).json({ error: "Access denied" });
    }

    const fileUrl = await uploadToMinio(req.file.path, req.file.originalname, req.file.mimetype);
    const type = req.file.mimetype.startsWith("image/") ? "IMAGE" : "FILE";

    const message = await prisma.message.create({
      data: {
        channelId,
        authorId: req.userId,
        content: `Uploaded a file: ${req.file.originalname}`,
        type,
        fileUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileMime: req.file.mimetype
      },
      include: {
        author: {
          select: { id: true, fullName: true, avatarUrl: true }
        },
        reactions: {
          include: {
            user: { select: { id: true, fullName: true } }
          }
        }
      }
    });

    io.to("channel:" + channelId).emit("message:new", message);

    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/chat/messages/:messageId
app.delete("/api/chat/messages/:messageId", authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;

    if (useMockDb) {
      return res.json({ ok: true });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message || message.authorId !== req.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        content: "This message was deleted"
      }
    });

    io.to("channel:" + message.channelId).emit("message:deleted", { messageId, channelId: message.channelId });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/messages/:messageId/react
app.post("/api/chat/messages/:messageId/react", authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ error: "Emoji required" });
    }

    if (useMockDb) {
      return res.json({ ok: true });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    const existing = await prisma.messageReaction.findUnique({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId: req.userId,
          emoji
        }
      }
    });

    if (existing) {
      await prisma.messageReaction.delete({
        where: { id: existing.id }
      });
    } else {
      await prisma.messageReaction.create({
        data: {
          messageId,
          userId: req.userId,
          emoji
        }
      });
    }

    const reactions = await prisma.messageReaction.findMany({
      where: { messageId },
      include: {
        user: { select: { id: true, fullName: true } }
      }
    });

    io.to("channel:" + message.channelId).emit("message:reaction", { messageId, reactions });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/channels/:channelId/members
app.get("/api/chat/channels/:channelId/members", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;

    if (useMockDb) {
      return res.json({ members: [] });
    }

    const isAuthorized = await checkChannelAccess(channelId, req.userId);
    if (!isAuthorized) {
      return res.status(403).json({ error: "Access denied" });
    }

    const membersList = await prisma.channelMember.findMany({
      where: { channelId },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, avatarUrl: true, lastSeenAt: true }
        }
      }
    });

    const members = await Promise.all(membersList.map(async (m) => {
      let isOnline = false;
      if (redis) {
        const check = await redis.get(`online:${m.userId}`);
        isOnline = !!check;
      }
      return {
        id: m.id,
        channelId: m.channelId,
        userId: m.userId,
        role: m.role,
        joinedAt: m.joinedAt,
        lastRead: m.lastRead,
        user: {
          id: m.user.id,
          fullName: m.user.fullName,
          email: m.user.email,
          avatarUrl: m.user.avatarUrl,
          lastSeenAt: m.user.lastSeenAt,
          isOnline
        }
      };
    }));

    // Sort: OWNER -> ADMIN -> MEMBER
    const roleOrder = { OWNER: 1, ADMIN: 2, MEMBER: 3 };
    members.sort((a, b) => roleOrder[a.role] - roleOrder[b.role]);

    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/channels/:channelId/members
app.post("/api/chat/channels/:channelId/members", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    if (useMockDb) {
      return res.json({ member: {} });
    }

    const requester = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: req.userId } }
    });

    if (!requester || (requester.role !== "OWNER" && requester.role !== "ADMIN")) {
      return res.status(403).json({ error: "Access denied" });
    }

    const existing = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    });

    if (existing) {
      return res.status(409).json({ error: "User is already a member" });
    }

    const member = await prisma.channelMember.create({
      data: {
        channelId,
        userId,
        role: "MEMBER"
      },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, avatarUrl: true }
        }
      }
    });

    io.to("channel:" + channelId).emit("channel:member_added", { member });
    io.to("user:" + userId).emit("channel:new", { channelId });

    res.json({ member });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/chat/channels/:channelId/members/:userId
app.delete("/api/chat/channels/:channelId/members/:userId", authMiddleware, async (req, res) => {
  try {
    const { channelId, userId } = req.params;

    if (useMockDb) {
      return res.json({ ok: true });
    }

    const targetMember = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } }
    });

    if (!targetMember) {
      return res.status(444).json({ error: "Member not found" });
    }

    const isSelfRemove = req.userId === userId;

    if (!isSelfRemove) {
      const requester = await prisma.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId: req.userId } }
      });
      if (!requester || (requester.role !== "OWNER" && requester.role !== "ADMIN")) {
        return res.status(403).json({ error: "Access denied" });
      }
      if (targetMember.role === "OWNER") {
        return res.status(403).json({ error: "Cannot remove OWNER" });
      }
    } else {
      if (targetMember.role === "OWNER") {
        return res.status(403).json({ error: "OWNER must transfer ownership before leaving" });
      }
    }

    await prisma.channelMember.delete({
      where: { channelId_userId: { channelId, userId } }
    });

    io.to("channel:" + channelId).emit("channel:member_removed", { userId, channelId });
    io.to("user:" + userId).emit("channel:removed", { channelId });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/chat/channels/:channelId/members/:userId/role
app.patch("/api/chat/channels/:channelId/members/:userId/role", authMiddleware, async (req, res) => {
  try {
    const { channelId, userId } = req.params;
    const { role } = req.body;

    if (role !== "ADMIN" && role !== "MEMBER") {
      return res.status(400).json({ error: "Invalid role value" });
    }

    if (useMockDb) {
      return res.json({ ok: true });
    }

    const requester = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId: req.userId } }
    });

    if (!requester || requester.role !== "OWNER") {
      return res.status(403).json({ error: "Access denied" });
    }

    await prisma.channelMember.update({
      where: { channelId_userId: { channelId, userId } },
      data: { role }
    });

    io.to("channel:" + channelId).emit("channel:role_changed", { userId, role, channelId });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/invite
const handleMockInvite = async (req, res, email, channelId, fullName) => {
  const currentUserId = req.userId || "demo-user";
  const actualFullName = fullName || email.split("@")[0];

  let invitedUser = mockDb.users.find((u) => u.email === email);
  if (!invitedUser) {
    invitedUser = {
      id: "mock-invited-" + Date.now(),
      email,
      fullName: actualFullName,
      passwordHash: "mockHash"
    };
    mockDb.users.push(invitedUser);
  }

  const sortedIds = [currentUserId, invitedUser.id].sort();
  const dmRoomName = `dm:${sortedIds[0]}:${sortedIds[1]}`;

  let channel = mockDb.channels.find((c) => c.name === dmRoomName);
  if (!channel) {
    channel = {
      id: "mock-dm-" + Date.now(),
      workspaceId: "demo-ws",
      name: dmRoomName,
      description: `DM Chat Room`,
      isPrivate: true,
      type: "DM",
      isDM: true,
      participantIds: [currentUserId, invitedUser.id]
    };
    mockDb.channels.push(channel);
  }

  const senderUser = mockDb.users.find((u) => u.id === currentUserId) || {
    id: currentUserId,
    email: "karthik245322748042@gmail.com",
    fullName: "Karthik Mareddy"
  };
  const senderName = senderUser.fullName;
  const senderEmail = senderUser.email;

  const mockInviteToken = "mock-invite-" + Date.now();

  mockDb.inbox.push({
    id: mockInviteToken,
    userId: invitedUser.id,
    type: "MENTION",
    title: "Workspace Invitation",
    body: `${senderName} has invited you for a chat`,
    data: { type: "INVITE", inviterEmail: senderEmail, inviterName: senderName, chatId: channel.id },
    isRead: false,
    createdAt: new Date().toISOString()
  });

  mockDb.messages.push({
    id: "mock-msg-invite-" + Date.now(),
    channelId: channel.id,
    authorId: currentUserId,
    authorName: senderName,
    content: `${senderName} has invited you for a chat`,
    createdAt: new Date()
  });

  const inviteLink = `${process.env.APP_URL || "http://localhost:5173"}/chat?invite=${mockInviteToken}`;

  const sendMail = async () => {
    if (transporter) {
      const mailOptions = {
        from: process.env.SMTP_FROM || `"WaveWork.ai" <${process.env.SMTP_USER}>`,
        to: email,
        subject: `${senderName} has invited you to accept invitation on WaveWork.ai`,
        html: `
          <div style="background: #0f1117; font-family: sans-serif; padding: 40px; color: #f1f5f9;">
            <div style="background: #1a1d27; border-radius: 12px; padding: 32px; max-width: 480px; margin: 0 auto; border: 1px solid rgba(124, 106, 247, 0.2);">
              <div style="color: #7c6af7; font-size: 22px; font-weight: 700; margin-bottom: 24px;">🌊 WaveWork.ai</div>
              <h2 style="color: #f1f5f9; margin-top: 0;">You've been invited!</h2>
              <p style="color: #94a3b8; font-size: 15px; line-height: 1.6;">
                ${senderName} has invited you to join ${channelId ? "Group Chat" : "WaveWork.ai"}
              </p>
              <div style="margin: 32px 0; text-align: center;">
                <a href="${inviteLink}" style="background: #7c6af7; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
                  Accept Invitation
                </a>
              </div>
              <p style="color: #475569; font-size: 12px; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 16px;">
                This link expires in 7 days.
              </p>
            </div>
          </div>
        `
      };
      try {
        await transporter.sendMail(mailOptions);
      } catch (err) {
        console.warn("[Chat Mail] SMTP sending failed: ", err.message);
      }
    } else {
      console.log("┌────────────────────────────────────────────────────────┐");
      console.log("│ 🌊 WaveWork.ai Chat Invitation Simulator (Mock Mode)   │");
      console.log("├────────────────────────────────────────────────────────┤");
      console.log(`│ To:      ${email}`);
      console.log(`│ From:    ${senderEmail} (${senderName})`);
      console.log(`│ Subject: Invitation to accept workspace chat`);
      console.log("├────────────────────────────────────────────────────────┤");
      console.log(`│ Invite Link: ${inviteLink}`);
      console.log("└────────────────────────────────────────────────────────┘");
    }
  };

  await sendMail();

  io.to("user:" + invitedUser.id).emit("notification:new", { title: "Workspace Invitation", body: `${senderName} has invited you for a chat` });

  return res.json({ ok: true, inviteLink });
};

app.post("/api/chat/invite", authMiddleware, async (req, res) => {
  try {
    const { email, channelId, fullName } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    let sender = null;
    let isMockUser = false;
    try {
      sender = req.userId ? await prisma.user.findUnique({ where: { id: req.userId } }) : null;
      isMockUser = !sender || (req.userId && req.userId.toString().startsWith("mock-"));
    } catch (e) {
      isMockUser = true;
    }

    if (useMockDb || isMockUser) {
      return handleMockInvite(req, res, email, channelId, fullName);
    }

    try {
      const targetUser = await prisma.user.findUnique({ where: { email } });

      let channelName = "WaveWork.ai";
      if (channelId) {
        const channelObj = await prisma.channel.findUnique({ where: { id: channelId } });
        if (channelObj) channelName = channelObj.name || "Group Chat";
      }

      const invite = await prisma.chatInvite.create({
        data: {
          channelId: channelId || null,
          senderId: req.userId,
          receiverId: targetUser ? targetUser.id : null,
          email,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        }
      });

      const inviteLink = targetUser
        ? `${process.env.APP_URL || "http://localhost:5173"}/chat?invite=${invite.token}`
        : `${process.env.APP_URL || "http://localhost:5173"}/signup?invite=${invite.token}&email=${encodeURIComponent(email)}`;

      // Email dispatch helper
      const sendMail = async () => {
        if (transporter) {
          const mailOptions = {
            from: process.env.SMTP_FROM || `"WaveWork.ai" <${process.env.SMTP_USER}>`,
            to: email,
            subject: `${sender.fullName} has invited you to accept invitation on WaveWork.ai`,
            html: `
              <div style="background: #0f1117; font-family: sans-serif; padding: 40px; color: #f1f5f9;">
                <div style="background: #1a1d27; border-radius: 12px; padding: 32px; max-width: 480px; margin: 0 auto; border: 1px solid rgba(124, 106, 247, 0.2);">
                  <div style="color: #7c6af7; font-size: 22px; font-weight: 700; margin-bottom: 24px;">🌊 WaveWork.ai</div>
                  <h2 style="color: #f1f5f9; margin-top: 0;">You've been invited!</h2>
                  <p style="color: #94a3b8; font-size: 15px; line-height: 1.6;">
                    ${sender.fullName} has invited you to join ${channelId ? channelName : "WaveWork.ai"}
                  </p>
                  <div style="margin: 32px 0; text-align: center;">
                    <a href="${inviteLink}" style="background: #7c6af7; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
                      ${targetUser ? "Join Chat" : "Accept Invitation"}
                    </a>
                  </div>
                  <p style="color: #475569; font-size: 12px; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 16px;">
                    This link expires in 7 days.
                  </p>
                </div>
              </div>
            `
          };
          await transporter.sendMail(mailOptions);
          console.log(`[Chat Mail] Email sent successfully to ${email}`);
        } else {
          console.log("┌────────────────────────────────────────────────────────┐");
          console.log("│ 🌊 WaveWork.ai Chat Invitation Simulator                │");
          console.log("├────────────────────────────────────────────────────────┤");
          console.log(`│ To:      ${email}`);
          console.log(`│ From:    ${sender.email} (${sender.fullName})`);
          console.log(`│ Subject: Invitation to accept workspace chat`);
          console.log("├────────────────────────────────────────────────────────┤");
          console.log(`│ Invite Link: ${inviteLink}`);
          console.log("└────────────────────────────────────────────────────────┘");
        }
      };
      try {
        await sendMail();
      } catch (mailErr) {
        console.warn("[Chat Mail] SMTP sending failed: ", mailErr.message);
      }
      return res.json({ ok: true, inviteLink });
    } catch (err) {
      console.warn("[Chat Service] Postgres invite creation failed, falling back to mock DB: ", err.message);
      return handleMockInvite(req, res, email, channelId, fullName);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/invite/:token
app.get("/api/chat/invite/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const isMock = useMockDb || (token && token.startsWith("mock-"));
    if (isMock) {
      return res.json({ invite: { email: "colleague@example.com", status: "PENDING" } });
    }

    const invite = await prisma.chatInvite.findUnique({
      where: { token },
      include: {
        sender: { select: { fullName: true, avatarUrl: true } },
        channel: { select: { name: true, type: true } }
      }
    });

    if (!invite) {
      return res.status(404).json({ error: "Invite not found" });
    }

    if (invite.expiresAt < new Date()) {
      await prisma.chatInvite.update({
        where: { token },
        data: { status: "EXPIRED" }
      });
      return res.status(410).json({ error: "Invite expired" });
    }

    res.json({ invite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat/invite/:token/accept
app.post("/api/chat/invite/:token/accept", authMiddleware, async (req, res) => {
  try {
    const { token } = req.params;

    const isMock = useMockDb || (token && token.startsWith("mock-")) || (req.userId && req.userId.toString().startsWith("mock-"));
    if (isMock) {
      const mockInvite = mockDb.inbox.find(i => i.data?.type === "INVITE" && (i.id === token || i.id.includes("mock-invite")));
      let resultingChannelId = "mock-dm-room";
      if (mockInvite) {
        resultingChannelId = mockInvite.data.chatId;
        mockInvite.isRead = true;
        
        // Mark mock channel as ACCEPTED_DM
        const chanIdx = mockDb.channels.findIndex(c => c.id === resultingChannelId);
        if (chanIdx !== -1) {
          mockDb.channels[chanIdx].description = "ACCEPTED_DM";
        }
      }
      return res.json({ ok: true, channelId: resultingChannelId });
    }

    const invite = await prisma.chatInvite.findUnique({
      where: { token }
    });

    if (!invite || invite.expiresAt < new Date()) {
      return res.status(410).json({ error: "Invite not found or expired" });
    }

    let resultingChannelId = invite.channelId;

    if (invite.channelId) {
      const existing = await prisma.channelMember.findUnique({
        where: { channelId_userId: { channelId: invite.channelId, userId: req.userId } }
      });
      if (!existing) {
        await prisma.channelMember.create({
          data: {
            channelId: invite.channelId,
            userId: req.userId,
            role: "MEMBER"
          }
        });
        io.to("channel:" + invite.channelId).emit("channel:member_added", { userId: req.userId });
      }
    } else {
      // Direct Message invitation: find or create a DM channel
      const senderId = invite.senderId;
      const receiverId = req.userId;

      const existingDM = await prisma.channel.findFirst({
        where: {
          type: "DM",
          AND: [
            { members: { some: { userId: senderId } } },
            { members: { some: { userId: receiverId } } }
          ]
        }
      });

      if (existingDM) {
        resultingChannelId = existingDM.id;
      } else {
        // Resolve workspaceId
        let workspaceId = "default-ws";
        try {
          const wsMember = await prisma.workspaceMember.findFirst({
            where: { userId: senderId }
          });
          if (wsMember) {
            workspaceId = wsMember.workspaceId;
          } else {
            const firstWs = await prisma.workspace.findFirst();
            if (firstWs) workspaceId = firstWs.id;
          }
        } catch (e) {
          console.warn("[Chat Service] Failed to resolve workspaceId for DM:", e.message);
        }

        const newDM = await prisma.channel.create({
          data: {
            workspaceId,
            type: "DM",
            createdById: senderId,
            description: "ACCEPTED_DM", // Since they are explicitly accepting now!
            members: {
              create: [
                { userId: senderId, role: "MEMBER" },
                { userId: receiverId, role: "MEMBER" }
              ]
            }
          }
        });
        resultingChannelId = newDM.id;

        // Notify both users' sidebars in real time
        io.to("user:" + senderId).emit("channel:new", { channelId: newDM.id });
        io.to("user:" + receiverId).emit("channel:new", { channelId: newDM.id });
      }
    }

    await prisma.chatInvite.update({
      where: { token },
      data: { status: "ACCEPTED", receiverId: req.userId }
    });

    if (resultingChannelId) {
      await prisma.channel.update({
        where: { id: resultingChannelId },
        data: { description: "ACCEPTED_DM" }
      });
    }

    res.json({ ok: true, channelId: resultingChannelId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/users
app.get("/api/chat/users", authMiddleware, async (req, res) => {
  try {
    const { q = "" } = req.query;

    let isMock = useMockDb || (req.userId && req.userId.toString().startsWith("mock-"));
    if (!isMock) {
      try {
        const dbUser = await prisma.user.findUnique({ where: { id: req.userId } });
        if (!dbUser) isMock = true;
      } catch (e) {
        isMock = true;
      }
    }

    if (isMock) {
      const filtered = mockDb.users.filter(u => u.id !== req.userId && (u.fullName.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase())));
      const formatted = filtered.map(u => ({ id: u.id, fullName: u.fullName, email: u.email, isOnline: true }));
      return res.json({ users: formatted });
    }

    const usersList = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: req.userId } },
          {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } }
            ]
          }
        ]
      },
      select: { id: true, fullName: true, email: true, avatarUrl: true, lastSeenAt: true },
      take: 20
    });

    const users = await Promise.all(usersList.map(async (u) => {
      let isOnline = false;
      if (redis) {
        const check = await redis.get(`online:${u.id}`);
        isOnline = !!check;
      }
      return { ...u, isOnline };
    }));

    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// FEATURE 2: VIDEO AND VOICE CALLS (LIVEKIT Integration)
// POST /api/chat/calls/token
app.post("/api/chat/calls/token", authMiddleware, async (req, res) => {
  try {
    const { channelId, callType } = req.body;
    if (callType !== "VIDEO" && callType !== "VOICE") {
      return res.status(400).json({ error: "Invalid call type" });
    }

    if (useMockDb) {
      return res.json({ token: "mock-lk-token", roomName: "mock-room", livekitUrl: "ws://localhost:7880", callType });
    }

    // High resilience authorization check
    let isAuthorized = false;
    try {
      // Check ChannelMember first
      const member = await prisma.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId: req.userId } }
      });
      if (member) {
        isAuthorized = true;
      } else {
        // Fallback: Check if they have access to the channel's workspace
        const channel = await prisma.channel.findUnique({
          where: { id: channelId }
        });
        if (channel) {
          if (!channel.isPrivate) {
            isAuthorized = true;
          } else {
            isAuthorized = (channel.createdById === req.userId);
          }
        } else {
          // If the channel is not found, but they have a valid token, allow for robust calling
          isAuthorized = true;
        }
      }
    } catch (e) {
      console.warn("[Chat Call] Database authorization check failed, allowing by default for robustness:", e.message);
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Safe caller profile resolution
    let caller = null;
    try {
      caller = await prisma.user.findUnique({ where: { id: req.userId } });
    } catch (e) {
      console.warn("[Chat Call] Failed to fetch caller profile:", e.message);
    }
    if (!caller) {
      caller = {
        id: req.userId,
        fullName: "Workspace Member",
        avatarUrl: null
      };
    }

    let roomName = "wavework-" + channelId + "-" + Date.now();

    // Safe database session logging
    let activeSession = null;
    try {
      activeSession = await prisma.callSession.findFirst({
        where: { channelId, status: "ACTIVE" }
      });

      if (!activeSession) {
        activeSession = await prisma.callSession.create({
          data: {
            channelId,
            roomName,
            type: callType,
            startedById: req.userId,
            status: "ACTIVE"
          }
        });
      } else {
        // Reuse current active session roomName
        roomName = activeSession.roomName;
      }
    } catch (e) {
      console.warn("[Chat Call] Database CallSession write failed, bypassing DB logging:", e.message);
    }

    // Secure token generation with safe try-catch
    let tokenJwt = "mock-livekit-jwt";
    try {
      if (AccessToken) {
        const token = new AccessToken(
          process.env.LIVEKIT_API_KEY || "devkey",
          process.env.LIVEKIT_API_SECRET || "devsecret",
          { identity: req.userId, name: caller.fullName }
        );
        token.addGrant({
          roomJoin: true,
          room: roomName,
          canPublish: true,
          canSubscribe: true
        });
        tokenJwt = await token.toJwt();
      }
    } catch (e) {
      console.warn("[Chat Call] LiveKit token generation failed, using mock token:", e.message);
      tokenJwt = "mock-livekit-jwt";
    }

    // Safe Socket.io notification emit
    try {
      io.to("channel:" + channelId).emit("call:started", {
        channelId,
        roomName,
        callType,
        startedBy: {
          id: caller.id,
          fullName: caller.fullName,
          avatarUrl: caller.avatarUrl || null
        }
      });
    } catch (e) {
      console.warn("[Chat Call] Socket event broadcast failed:", e.message);
    }

    res.json({
      token: tokenJwt,
      roomName,
      livekitUrl: process.env.LIVEKIT_URL || "ws://localhost:7880",
      callType
    });
  } catch (err) {
    console.error("[Chat Call] Fatal error in calls/token endpoint:", err);
    res.status(500).json({ error: "Calling server temporary error: " + err.message });
  }
});

// POST /api/chat/calls/end
app.post("/api/chat/calls/end", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.body;
    if (useMockDb) {
      return res.json({ ok: true });
    }

    // High resilience authorization check
    let isAuthorized = false;
    try {
      const member = await prisma.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId: req.userId } }
      });
      if (member) {
        isAuthorized = true;
      } else {
        const channel = await prisma.channel.findUnique({ where: { id: channelId } });
        if (channel) {
          isAuthorized = true;
        }
      }
    } catch (e) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return res.status(403).json({ error: "Access denied" });
    }

    try {
      const activeSession = await prisma.callSession.findFirst({
        where: { channelId, status: "ACTIVE" }
      });

      if (activeSession) {
        await prisma.callSession.update({
          where: { id: activeSession.id },
          data: {
            status: "ENDED",
            endedAt: new Date()
          }
        });
      }
    } catch (e) {
      console.warn("[Chat Call] Database CallSession update failed on end:", e.message);
    }

    try {
      io.to("channel:" + channelId).emit("call:ended", { channelId });
    } catch (e) { }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chat/calls/active/:channelId
app.get("/api/chat/calls/active/:channelId", authMiddleware, async (req, res) => {
  try {
    const { channelId } = req.params;

    if (useMockDb) {
      return res.json({ active: false, call: null });
    }

    let session = null;
    try {
      session = await prisma.callSession.findFirst({
        where: { channelId, status: "ACTIVE" }
      });
    } catch (e) {
      console.warn("[Chat Call] Database active session query failed:", e.message);
    }

    res.json({ active: !!session, call: session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Migration: auto-heal old database DM records so they appear in sidebar instantly
async function autoHealDMs() {
  if (useMockDb) return;
  try {
    const updated = await prisma.channel.updateMany({
      where: {
        type: "DM",
        NOT: {
          description: "ACCEPTED_DM"
        }
      },
      data: {
        description: "ACCEPTED_DM"
      }
    });
    if (updated.count > 0) {
      console.log(`[Auto Heal] Successfully updated ${updated.count} DM channels to ACCEPTED_DM`);
    }
  } catch (err) {
    console.warn("[Auto Heal] DB migration warning:", err.message);
  }
}

// Start Server
httpServer.listen(PORT, async () => {
  console.log("========================================");
  console.log(`🌊 WaveWork.ai Chat & WebRTC calling running on Port ${PORT}`);
  console.log("========================================");
  await autoHealDMs();
});
