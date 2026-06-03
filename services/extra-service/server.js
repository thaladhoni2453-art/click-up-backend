// backend/services/extra-service/server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load configurations
dotenv.config({ path: "../../../.env" });

const { prisma } = require("@wavework/db");
const { authMiddleware } = require("@wavework/middleware");
const { mockDb } = require("../../src/lib/mockDb");

const net = require("net");
let isDbOffline = false;

const checkDbConnection = () => {
  return new Promise((resolve) => {
    let host = "127.0.0.1";
    let port = 5432;
    
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        const matches = dbUrl.match(/@([^:/]+)(?::(\d+))?/);
        if (matches) {
          host = matches[1];
          if (matches[2]) port = parseInt(matches[2]);
        }
      } catch (e) {
        // Fall back to default host/port on parsing error
      }
    }

    const socket = new net.Socket();
    socket.setTimeout(1000); // 1 second timeout

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
};

// Run dynamic schema migration to ensure the docs table exists if database is online
const runDocsMigration = async () => {
  console.log("🌊 [Extra Service Startup] Checking database connectivity...");
  const isOnline = await checkDbConnection();
  
  if (!isOnline) {
    isDbOffline = true;
    console.warn("⚠️ [Extra Service Startup] Database is offline. Activating 100% resilient mockDb mode for Docs!");
    return;
  }

  try {
    console.log("🌊 [Extra Service Startup] Database is online. Verifying docs table...");
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS docs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT DEFAULT 'Untitled',
        content TEXT DEFAULT '',
        owner_id TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("🌊 [Extra Service Startup] Docs table verified successfully!");
  } catch (err) {
    console.warn("⚠️ [Extra Service Startup] Docs table initialization skipped (possibly running mockDb):", err.message);
    isDbOffline = true;
  }
};
runDocsMigration();

let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch (e) {
  console.warn("\x1b[33m[Email Service] nodemailer not found. Chat invitations will be simulated beautifully in the terminal console. Run 'npm i nodemailer @types/nodemailer' to activate SMTP delivery.\x1b[0m");
}

async function sendInviteEmail(senderName, senderEmail, receiverEmail, receiverName, chatLink) {
  const printSimulatedEmail = () => {
    console.log("\x1b[35m┌────────────────────────────────────────────────────────┐\x1b[0m");
    console.log("\x1b[35m│ 🌊 WaveWork.ai Email Notification Simulator            │\x1b[0m");
    console.log("\x1b[35m├────────────────────────────────────────────────────────┤\x1b[0m");
    console.log(`│ \x1b[1mTo\x1b[0m:      \x1b[36m${receiverEmail}\x1b[0m (${receiverName})`);
    console.log(`│ \x1b[1mFrom\x1b[0m:    \x1b[36m${senderEmail}\x1b[0m (${senderName})`);
    console.log(`│ \x1b[1mSubject\x1b[0m: \x1b[32m${senderName} has invited you for a chat in wavework.ai\x1b[0m`);
    console.log("\x1b[35m├────────────────────────────────────────────────────────┤\x1b[0m");
    console.log(`│ Hi \x1b[33m${receiverName || receiverEmail}\x1b[0m,`);
    console.log("│ ");
    console.log(`│ \x1b[1m${senderName}\x1b[0m has invited you for an active chat session`);
    console.log(`│ inside the premium collaboration app \x1b[1mwavework.ai\x1b[0m.`);
    console.log("│ ");
    console.log("│ Click the direct link below to join the chat workspace:");
    console.log(`│ \x1b[34m\x1b[4m${chatLink}\x1b[0m`);
    console.log("\x1b[35m└────────────────────────────────────────────────────────┘\x1b[0m");
  };

  if (!nodemailer) {
    printSimulatedEmail();
    return;
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 587;
  const smtpSecure = process.env.SMTP_SECURE === "true";
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || `"WaveWork.ai" <noreply@wavework.ai>`;

  try {
    let transporter;
    if (smtpHost && smtpUser && smtpPass) {
      transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: { user: smtpUser, pass: smtpPass }
      });
    } else {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false,
        auth: { user: testAccount.user, pass: testAccount.pass }
      });
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { margin: 0; padding: 0; background-color: #0c0e18; font-family: 'Outfit', sans-serif; color: #cdd6f4; }
        .container { max-width: 600px; margin: 40px auto; background: #161823; border: 1px solid rgba(139, 92, 246, 0.25); border-radius: 12px; overflow: hidden; }
        .header { background: linear-gradient(135deg, #8b5cf6, #3b82f6); padding: 30px; text-align: center; }
        .header h1 { margin: 0; color: #ffffff; font-size: 24px; font-weight: 800; }
        .content { padding: 40px 30px; }
        .content h2 { color: #ffffff; font-size: 20px; margin-top: 0; margin-bottom: 20px; }
        .content p { font-size: 15px; line-height: 1.6; color: #a6adc8; }
        .highlight { color: #c084fc; font-weight: 600; }
        .button-wrapper { text-align: center; margin: 30px 0; }
        .button { display: inline-block; padding: 14px 28px; background: #8b5cf6; color: #ffffff !important; text-decoration: none; font-size: 15px; font-weight: 700; border-radius: 8px; }
        .footer { padding: 24px 30px; background: rgba(0,0,0,0.2); text-align: center; font-size: 12px; color: #585b70; border-top: 1px solid rgba(255,255,255,0.05); }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>WaveWork.ai</h1>
        </div>
        <div class="content">
          <h2>You have a Chat Invitation! ✉</h2>
          <p>Hi <span class="highlight">${receiverName || receiverEmail}</span>,</p>
          <p><span class="highlight">${senderName}</span> has invited you for a chat in <span class="highlight">wavework.ai</span>.</p>
          <p>Click the button below to join the workspace chat, view your inbox, and connect instantly:</p>
          <div class="button-wrapper">
            <a href="${chatLink}" target="_blank" class="button">Join the Chat Room</a>
          </div>
        </div>
        <div class="footer">
          <p>Sent securely via <a href="https://wavework.ai" style="color: #8b5cf6; text-decoration: none;">WaveWork.ai</a></p>
        </div>
      </div>
    </body>
    </html>
    `;

    const info = await transporter.sendMail({
      from: smtpFrom,
      to: receiverEmail,
      subject: `${senderName} has invited you for a chat in wavework.ai`,
      text: `Hi ${receiverName || receiverEmail},\n\n${senderName} has invited you for a chat in wavework.ai.\n\nJoin the chat here: ${chatLink}\n\nSent securely via WaveWork.ai`,
      html: htmlContent
    });

    console.log(`✉ Email successfully sent to ${receiverEmail}`);
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`🚀 Click here to preview this HTML email in your browser:`);
      console.log(`🔗 \x1b[36m${previewUrl}\x1b[0m`);
    }
  } catch (error) {
    console.error(`[Email Service] Failed to send email to ${receiverEmail}, falling back to console simulation:`, error);
    printSimulatedEmail();
  }
}

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Apply auth middleware
app.use(authMiddleware);

// Helper to parse private group admins and members
function getGroupDetails(channelDescription) {
  if (!channelDescription || !channelDescription.startsWith("group:")) return null;
  const participantList = channelDescription.split(":")[1].split(",");
  return {
    adminId: participantList[0],
    participantIds: participantList
  };
}

// ─────────────────────────────────────────────
// CHAT / CHANNELS
// ─────────────────────────────────────────────
app.get("/api/extra/users", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, fullName: true, email: true, avatarUrl: true }
    });
    return res.json(users.filter((u) => u.id !== req.userId));
  } catch (error) {
    const currentUserId = req.userId || "demo-user";
    const users = mockDb.users.filter((u) => u.id !== currentUserId);
    return res.json(users);
  }
});

app.get("/api/extra/channels", async (req, res) => {
  const currentUserId = req.userId || "demo-user";
  try {
    const dbChannels = await prisma.channel.findMany({
      include: {
        members: {
          include: { user: true }
        }
      },
      orderBy: { createdAt: "asc" }
    });
    const resolved = [];
    
    for (const chan of dbChannels) {
      const isDM = chan.type === "DM" || chan.name.startsWith("dm:");
      if (isDM) {
        if (chan.description !== "ACCEPTED_DM") continue; // SKIP pending DM chats until accepted
        let otherUser = null;
        let otherId = null;
        if (chan.members && chan.members.length > 0) {
          const other = chan.members.find((m) => m.userId !== currentUserId) || chan.members[0];
          if (other) {
            otherUser = other.user;
            otherId = other.userId;
          }
        } else if (chan.name.startsWith("dm:")) {
          const parts = chan.name.split(":");
          otherId = parts.find((p) => p !== "dm" && p !== currentUserId);
          if (otherId) {
            otherUser = await prisma.user.findUnique({ where: { id: otherId } });
          }
        }

        if (otherId) {
          resolved.push({
            ...chan,
            name: otherUser?.fullName || "Chat Partner",
            isDM: true,
            partnerId: otherId
          });
        }
      } else if (chan.isPrivate && chan.description?.startsWith("group:")) {
        const participantIds = chan.description.split(":")[1].split(",");
        if (participantIds.includes(currentUserId)) {
          resolved.push({
            ...chan,
            isDM: false,
            isGroup: true,
            participantIds
          });
        }
      } else {
        resolved.push({ ...chan, isDM: false, isGroup: false });
      }
    }
    return res.json(resolved);
  } catch (error) {
    const resolved = [];
    for (const chan of mockDb.channels) {
      const isDM = chan.type === "DM" || chan.isDM || !chan.isGroup || chan.name.startsWith("dm:");
      if (isDM) {
        if (chan.description !== "ACCEPTED_DM") continue; // SKIP pending DM chats until accepted
        let otherId = null;
        if (chan.participantIds) {
          otherId = chan.participantIds.find((p) => p !== currentUserId) || chan.participantIds[0];
        } else if (chan.name.startsWith("dm:")) {
          const parts = chan.name.replace("_", ":").split(":");
          otherId = parts.find((p) => p !== "dm" && p !== currentUserId);
        }

        if (otherId) {
          const otherUser = mockDb.users.find((u) => u.id === otherId);
          resolved.push({
            ...chan,
            name: otherUser?.fullName || "Chat Partner",
            isDM: true,
            partnerId: otherId,
            participantIds: chan.participantIds || [currentUserId, otherId]
          });
        }
      } else if (chan.isPrivate && chan.description?.startsWith("group:")) {
        const participantIds = chan.description.split(":")[1].split(",");
        if (participantIds.includes(currentUserId)) {
          resolved.push({
            ...chan,
            isDM: false,
            isGroup: true,
            participantIds
          });
        }
      } else {
        resolved.push({ ...chan, isDM: false, isGroup: false });
      }
    }
    return res.json(resolved);
  }
});

app.post("/api/extra/channels", async (req, res) => {
  const { name, description, isDM, targetUserId, isGroup, participantIds } = req.body;
  const currentUserId = req.userId || "demo-user";

  if (isDM && targetUserId) {
    const sortedIds = [currentUserId, targetUserId].sort();
    const dmRoomName = `dm:${sortedIds[0]}:${sortedIds[1]}`;

    try {
      let channel = await prisma.channel.findFirst({
        where: { name: dmRoomName }
      });

      if (!channel) {
        channel = await prisma.channel.create({
          data: {
            workspaceId: req.orgId || "mock-org",
            name: dmRoomName,
            description: `DM Chat Room`,
            isPrivate: true
          }
        });
      }

      const otherUser = await prisma.user.findUnique({ where: { id: targetUserId } });
      return res.status(201).json({
        ...channel,
        name: otherUser?.fullName || "Chat Partner",
        isDM: true,
        partnerId: targetUserId
      });
    } catch (error) {
      let channel = mockDb.channels.find((c) => c.name === dmRoomName);

      if (!channel) {
        channel = {
          id: "mock-dm-" + Date.now(),
          workspaceId: req.orgId || "mock-org",
          name: dmRoomName,
          description: `DM Chat Room`,
          isPrivate: true
        };
        mockDb.channels.push(channel);
      }

      const otherUser = mockDb.users.find((u) => u.id === targetUserId);
      return res.status(201).json({
        ...channel,
        name: otherUser?.fullName || "Chat Partner",
        isDM: true,
        partnerId: targetUserId
      });
    }
  }

  if (isGroup && name && participantIds) {
    const allParticipants = Array.from(new Set([currentUserId, ...participantIds]));
    const serializedParticipants = `group:${allParticipants.join(",")}`;

    try {
      const channel = await prisma.channel.create({
        data: {
          workspaceId: req.orgId || "mock-org",
          name,
          description: serializedParticipants,
          isPrivate: true
        }
      });
      return res.status(201).json({
        ...channel,
        isDM: false,
        isGroup: true,
        participantIds: allParticipants
      });
    } catch (error) {
      const channel = {
        id: "mock-group-" + Date.now(),
        workspaceId: req.orgId || "mock-org",
        name,
        description: serializedParticipants,
        isPrivate: true
      };
      mockDb.channels.push(channel);
      return res.status(201).json({
        ...channel,
        isDM: false,
        isGroup: true,
        participantIds: allParticipants
      });
    }
  }

  if (!name) return res.status(400).json({ error: "Channel name is required" });

  try {
    const channel = await prisma.channel.create({
      data: { workspaceId: req.orgId || "mock-org", name, description },
    });
    return res.status(201).json({ ...channel, isDM: false, isGroup: false });
  } catch (error) {
    const c = { id: "mock-chan-" + Date.now(), workspaceId: req.orgId || "mock-org", name, description, isPrivate: false };
    mockDb.channels.push(c);
    return res.status(201).json({ ...c, isDM: false, isGroup: false });
  }
});

// ─────────────────────────────────────────────
// EMAIL INVITATIONS & INBOX ACTIONS
// ─────────────────────────────────────────────
app.post("/api/extra/invites", async (req, res) => {
  const { email, fullName } = req.body;
  const currentUserId = req.userId || "demo-user";

  if (!email) return res.status(400).json({ error: "Email is required" });
  const actualFullName = fullName || email.split("@")[0];

  try {
    let invitedUser = await prisma.user.findUnique({ where: { email } });
    if (!invitedUser) {
      invitedUser = await prisma.user.create({
        data: {
          email,
          fullName: actualFullName,
          passwordHash: "$2b$10$demoHashPlaceholderForLocalBcryptTestingOnlyString"
        }
      });
    }

    const currentWorkspaceId = req.orgId || "demo-ws";
    const existingMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId: currentWorkspaceId, userId: invitedUser.id }
    });

    if (!existingMember) {
      await prisma.workspaceMember.create({
        data: { workspaceId: currentWorkspaceId, userId: invitedUser.id, role: "MEMBER" }
      });
    }

    const sortedIds = [currentUserId, invitedUser.id].sort();
    const dmRoomName = `dm:${sortedIds[0]}:${sortedIds[1]}`;

    let channel = await prisma.channel.findFirst({
      where: { name: dmRoomName }
    });

    if (!channel) {
      channel = await prisma.channel.create({
        data: {
          workspaceId: currentWorkspaceId,
          name: dmRoomName,
          description: `PENDING_DM`,
          isPrivate: true,
          type: "DM",
          createdById: currentUserId
        }
      });

      // Create channel memberships for both users
      await prisma.channelMember.createMany({
        data: [
          { channelId: channel.id, userId: currentUserId, role: "MEMBER" },
          { channelId: channel.id, userId: invitedUser.id, role: "MEMBER" }
        ],
        skipDuplicates: true
      });
    }

    const sender = await prisma.user.findUnique({ where: { id: currentUserId } });
    const senderName = sender?.fullName || "A team member";
    const senderEmail = sender?.email || "karthik245322748042@gmail.com";

    await prisma.notification.create({
      data: {
        userId: invitedUser.id,
        type: "MENTION",
        title: "Workspace Invitation",
        body: `${senderName} has invited you for a chat`,
        data: { type: "INVITE", inviterEmail: senderEmail, inviterName: senderName, chatId: channel.id },
      }
    });

    // Automatically post the invitation message inside the newly created DM room
    await prisma.message.create({
      data: {
        channelId: channel.id,
        authorId: currentUserId,
        authorName: senderName,
        content: `${senderName} has invited you for a chat`,
      }
    });

    // Send actual Gmail invitation email
    const chatLink = `http://localhost:5173`;
    sendInviteEmail(senderName, senderEmail, email, actualFullName, chatLink);

    return res.status(201).json({ success: true, channelId: channel.id });
  } catch (error) {
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
        description: `PENDING_DM`,
        isPrivate: true,
        type: "DM",
        isDM: true,
        participantIds: [currentUserId, invitedUser.id]
      };
      mockDb.channels.push(channel);
    }

    const sender = mockDb.users.find((u) => u.id === currentUserId) || mockDb.users[0];
    const senderName = sender?.fullName || "A team member";
    const senderEmail = sender?.email || "karthik245322748042@gmail.com";

    mockDb.inbox.push({
      id: "mock-invite-" + Date.now(),
      userId: invitedUser.id,
      type: "MENTION",
      title: "Workspace Invitation",
      body: `${senderName} has invited you for a chat`,
      data: { type: "INVITE", inviterEmail: senderEmail, inviterName: senderName, chatId: channel.id },
      isRead: false,
      createdAt: new Date().toISOString()
    });

    // Pushes a mock chat message into the newly created DM room
    mockDb.messages.push({
      id: "mock-msg-invite-" + Date.now(),
      channelId: channel.id,
      authorId: currentUserId,
      authorName: senderName,
      content: `${senderName} has invited you for a chat`,
      createdAt: new Date()
    });

    // Send actual Gmail invitation email
    const chatLink = `http://localhost:5173`;
    sendInviteEmail(senderName, senderEmail, email, actualFullName, chatLink);

    return res.status(201).json({ success: true, channelId: channel.id });
  }
});

app.get("/api/extra/inbox", async (req, res) => {
  const currentUserId = req.userId || "demo-user";
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: currentUserId },
      orderBy: { createdAt: "desc" }
    });
    return res.json(notifications);
  } catch (error) {
    const list = mockDb.inbox.filter((item) => item.userId === currentUserId);
    return res.json(list);
  }
});

app.post("/api/extra/inbox/:id/accept", async (req, res) => {
  const { id } = req.params;
  try {
    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification) throw new Error("Notification not found");

    await prisma.notification.update({
      where: { id },
      data: { isRead: true }
    });

    const notifData = typeof notification.data === "string" ? JSON.parse(notification.data) : notification.data;
    const chatId = notifData?.chatId;

    if (chatId) {
      await prisma.channel.update({
        where: { id: chatId },
        data: { description: "ACCEPTED_DM" }
      });
      console.log(`[Inbox Accept] Marked DB channel ${chatId} as ACCEPTED_DM`);
    }

    return res.json({ success: true, notification });
  } catch (error) {
    const idx = mockDb.inbox.findIndex((item) => item.id === id);
    if (idx !== -1) {
      mockDb.inbox[idx].isRead = true;
      const notif = mockDb.inbox[idx];
      const chatId = notif.data?.chatId;

      if (chatId) {
        const chanIdx = mockDb.channels.findIndex(c => c.id === chatId);
        if (chanIdx !== -1) {
          mockDb.channels[chanIdx].description = "ACCEPTED_DM";
          console.log(`[Inbox Accept Mock] Marked mock channel ${chatId} as ACCEPTED_DM`);
        }
      }
      return res.json({ success: true, notification: notif });
    }
    return res.status(404).json({ error: "Invite item not found" });
  }
});

app.get("/api/extra/channels/:channelId/messages", async (req, res) => {
  const { channelId } = req.params;
  try {
    const messages = await prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: "asc" },
    });
    if (messages.length > 0) return res.json(messages);
    throw new Error();
  } catch (error) {
    const messages = mockDb.messages.filter((m) => m.channelId === channelId);
    return res.json(messages);
  }
});

app.post("/api/extra/channels/:channelId/messages", async (req, res) => {
  const { channelId } = req.params;
  const { content, authorName, linkedTaskId } = req.body;

  if (!content) return res.status(400).json({ error: "Content is required" });

  try {
    const message = await prisma.message.create({
      data: {
        channelId,
        authorId: req.userId,
        authorName: authorName || "Workspace Member",
        content,
        linkedTaskId,
      },
    });
    return res.status(201).json(message);
  } catch (error) {
    const m = {
      id: "mock-msg-" + Date.now(),
      channelId,
      authorId: req.userId || "demo-user",
      authorName: authorName || "Workspace Member",
      content,
      createdAt: new Date(),
    };
    mockDb.messages.push(m);
    return res.status(201).json(m);
  }
});

// ─────────────────────────────────────────────
// REAL-TIME PRESENCE & STATUS DOTS
// ─────────────────────────────────────────────
app.get("/api/extra/presence", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, fullName: true, avatarUrl: true }
    });
    return res.json(users.map((u) => ({ userId: u.id, lastActiveAt: new Date().toISOString() })));
  } catch (error) {
    const userPresenceList = mockDb.users.map((u) => ({
      userId: u.id,
      lastActiveAt: u.lastActiveAt || null
    }));
    return res.json(userPresenceList);
  }
});

// ─────────────────────────────────────────────
// GROUP CHAT ADMINISTRATION (ADD/REMOVE)
// ─────────────────────────────────────────────
app.post("/api/extra/channels/:channelId/participants", async (req, res) => {
  const { channelId } = req.params;
  const { userId } = req.body;
  const currentUserId = req.userId || "demo-user";

  try {
    let channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const details = getGroupDetails(channel.description);
    if (!details) return res.status(400).json({ error: "Not a group channel" });
    if (details.adminId !== currentUserId) {
      return res.status(403).json({ error: "Forbidden: Only group creator-admins can manage participants" });
    }

    if (details.participantIds.includes(userId)) {
      return res.status(400).json({ error: "User already in group" });
    }

    const newParticipants = [...details.participantIds, userId];
    const updatedDescription = `group:${newParticipants.join(",")}`;

    channel = await prisma.channel.update({
      where: { id: channelId },
      data: { description: updatedDescription }
    });

    return res.json({ success: true, channel });
  } catch (error) {
    let channel = mockDb.channels.find((c) => c.id === channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const details = getGroupDetails(channel.description);
    if (!details) return res.status(400).json({ error: "Not a group channel" });
    if (details.adminId !== currentUserId) {
      return res.status(403).json({ error: "Forbidden: Only group creator-admins can manage participants" });
    }

    if (details.participantIds.includes(userId)) {
      return res.status(400).json({ error: "User already in group" });
    }

    const newParticipants = [...details.participantIds, userId];
    channel.description = `group:${newParticipants.join(",")}`;

    return res.json({ success: true, channel });
  }
});

app.delete("/api/extra/channels/:channelId/participants/:userId", async (req, res) => {
  const { channelId, userId } = req.params;
  const currentUserId = req.userId || "demo-user";

  try {
    let channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const details = getGroupDetails(channel.description);
    if (!details) return res.status(400).json({ error: "Not a group channel" });
    if (details.adminId !== currentUserId) {
      return res.status(403).json({ error: "Forbidden: Only group creator-admins can manage participants" });
    }

    if (!details.participantIds.includes(userId)) {
      return res.status(400).json({ error: "User not in group" });
    }

    if (userId === details.adminId) {
      return res.status(400).json({ error: "Cannot remove the group creator" });
    }

    const newParticipants = details.participantIds.filter((id) => id !== userId);
    const updatedDescription = `group:${newParticipants.join(",")}`;

    channel = await prisma.channel.update({
      where: { id: channelId },
      data: { description: updatedDescription }
    });

    return res.json({ success: true, channel });
  } catch (error) {
    let channel = mockDb.channels.find((c) => c.id === channelId);
    if (!channel) return res.status(404).json({ error: "Channel not found" });

    const details = getGroupDetails(channel.description);
    if (!details) return res.status(400).json({ error: "Not a group channel" });
    if (details.adminId !== currentUserId) {
      return res.status(403).json({ error: "Forbidden: Only group creator-admins can manage participants" });
    }

    if (!details.participantIds.includes(userId)) {
      return res.status(400).json({ error: "User not in group" });
    }

    if (userId === details.adminId) {
      return res.status(400).json({ error: "Cannot remove the group creator" });
    }

    const newParticipants = details.participantIds.filter((id) => id !== userId);
    channel.description = `group:${newParticipants.join(",")}`;

    return res.json({ success: true, channel });
  }
});

// ─────────────────────────────────────────────
// GOALS & OKRs
// ─────────────────────────────────────────────
app.get("/api/extra/goals", async (req, res) => {
  const { workspaceId } = req.query;

  try {
    const goals = await prisma.goal.findMany({
      where: { workspaceId: workspaceId },
      include: { targets: true },
    });
    if (goals.length > 0) return res.json(goals);
    throw new Error();
  } catch (error) {
    const goalsWithTargets = mockDb.goals.map((g) => {
      const targets = mockDb.goalTargets.filter((t) => t.goalId === g.id);
      return { ...g, targets };
    });
    return res.json(goalsWithTargets);
  }
});

app.post("/api/extra/goals", async (req, res) => {
  const { workspaceId, name, description, dueDate, color, targets } = req.body;

  if (!workspaceId || !name) {
    return res.status(400).json({ error: "workspaceId and name are required parameters" });
  }

  try {
    const goal = await prisma.$transaction(async (tx) => {
      const newGoal = await tx.goal.create({
        data: {
          workspaceId,
          name,
          description,
          ownerId: req.userId,
          dueDate: dueDate ? new Date(dueDate) : null,
          color,
        },
      });

      if (targets && Array.isArray(targets)) {
        await tx.goalTarget.createMany({
          data: targets.map((t) => ({
            goalId: newGoal.id,
            name: t.name,
            type: t.type || "NUMBER",
            targetValue: parseFloat(t.targetValue) || 100,
            startValue: parseFloat(t.startValue) || 0,
            currentValue: parseFloat(t.currentValue) || 0,
            unit: t.unit || "",
          })),
        });
      }

      return newGoal;
    });

    const fullGoal = await prisma.goal.findUnique({
      where: { id: goal.id },
      include: { targets: true },
    });

    return res.status(201).json(fullGoal);
  } catch (error) {
    const goalId = "mock-goal-" + Date.now();
    const g = { id: goalId, workspaceId, name, description, color, dueDate: dueDate ? new Date(dueDate) : null };
    mockDb.goals.push(g);

    const mockTargets = [];
    if (targets && Array.isArray(targets)) {
      targets.forEach((t, idx) => {
        const targetObj = {
          id: `mock-target-${goalId}-${idx}`,
          goalId,
          name: t.name,
          type: t.type || "NUMBER",
          currentValue: parseFloat(t.currentValue) || 0,
          targetValue: parseFloat(t.targetValue) || 100,
          unit: t.unit || "",
        };
        mockDb.goalTargets.push(targetObj);
        mockTargets.push(targetObj);
      });
    }

    return res.status(201).json({ ...g, targets: mockTargets });
  }
});

app.patch("/api/extra/goals/targets/:targetId", async (req, res) => {
  const { targetId } = req.params;
  const { currentValue } = req.body;

  try {
    const target = await prisma.goalTarget.update({
      where: { id: targetId },
      data: { currentValue: parseFloat(currentValue) },
    });
    return res.json(target);
  } catch (error) {
    const idx = mockDb.goalTargets.findIndex((t) => t.id === targetId);
    if (idx !== -1) {
      mockDb.goalTargets[idx].currentValue = parseFloat(currentValue);
      return res.json(mockDb.goalTargets[idx]);
    }
    return res.status(404).json({ error: "Target not found (Mock DB)" });
  }
});

// ─────────────────────────────────────────────
// DASHBOARDS
// ─────────────────────────────────────────────
app.get("/api/extra/dashboards", async (req, res) => {
  const { workspaceId } = req.query;
  try {
    const dashboards = await prisma.dashboard.findMany({ where: { workspaceId: workspaceId } });
    return res.json(dashboards);
  } catch (error) {
    return res.json([{ id: "mock-dash", name: "Executive Dashboard", layout: [] }]);
  }
});

app.post("/api/extra/dashboards", async (req, res) => {
  const { workspaceId, name, layout } = req.body;
  try {
    const dashboard = await prisma.dashboard.create({ data: { workspaceId, name, layout: layout || [] } });
    return res.status(201).json(dashboard);
  } catch (error) {
    return res.status(201).json({ id: "mock-dash-" + Date.now(), workspaceId, name, layout: layout || [] });
  }
});

// ─────────────────────────────────────────────
// AUTOMATIONS
// ─────────────────────────────────────────────
app.get("/api/extra/automations", async (req, res) => {
  const { workspaceId } = req.query;
  try {
    const automations = await prisma.automation.findMany({ where: { workspaceId: workspaceId } });
    if (automations.length > 0) return res.json(automations);
    throw new Error();
  } catch (error) {
    return res.json(mockDb.automations);
  }
});

app.post("/api/extra/automations", async (req, res) => {
  const { workspaceId, name, trigger, conditions, actions } = req.body;
  try {
    const automation = await prisma.automation.create({
      data: { workspaceId, name, trigger, conditions: conditions || [], actions },
    });
    return res.status(201).json(automation);
  } catch (error) {
    const auto = { id: "mock-auto-" + Date.now(), workspaceId, name, isEnabled: true, trigger, actions, runCount: 0 };
    mockDb.automations.push(auto);
    return res.status(201).json(auto);
  }
});

// ─────────────────────────────────────────────
// DOCS / COLLABORATIVE PAGES
// ─────────────────────────────────────────────
app.get("/api/extra/docs", async (req, res) => {
  const { workspaceId } = req.query;
  try {
    const docs = await prisma.doc.findMany({
      where: { workspaceId: workspaceId },
      orderBy: { createdAt: "asc" }
    });
    return res.json(docs);
  } catch (error) {
    return res.json([]);
  }
});

app.post("/api/extra/docs", async (req, res) => {
  const { workspaceId, title, content } = req.body;
  try {
    const doc = await prisma.doc.create({
      data: {
        workspaceId,
        title,
        content: content || {},
        createdById: req.userId || "demo-user",
      }
    });
    return res.status(201).json(doc);
  } catch (error) {
    return res.status(201).json({
      id: "mock-doc-" + Date.now(),
      workspaceId,
      title,
      content: content || "",
      createdAt: new Date(),
    });
  }
});

app.patch("/api/extra/docs/:id", async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  try {
    const doc = await prisma.doc.update({
      where: { id },
      data: { title, content }
    });
    return res.json(doc);
  } catch (error) {
    return res.json({ id, title, content });
  }
});

app.delete("/api/extra/docs/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.doc.delete({ where: { id } });
    return res.json({ success: true });
  } catch (error) {
    return res.json({ success: true });
  }
});

// ─────────────────────────────────────────────
// NEW DOCS REST API ENDPOINTS (PostgreSQL + mockDb Fallback)
// ─────────────────────────────────────────────
app.get("/api/docs", authMiddleware, async (req, res) => {
  const userId = req.userId || "demo-user";
  if (isDbOffline) {
    const userDocs = mockDb.docs.filter(d => d.owner_id === userId);
    return res.json(userDocs);
  }
  try {
    // Fast-fail check for DB connectivity before running raw SQL queries
    await prisma.user.findFirst({ select: { id: true } });
    const docs = await prisma.$queryRawUnsafe(
      'SELECT * FROM docs WHERE owner_id = $1 ORDER BY created_at DESC',
      userId
    );
    return res.json(docs);
  } catch (error) {
    console.error("DB query for docs failed, falling back to mockDb:", error.message);
    const userDocs = mockDb.docs.filter(d => d.owner_id === userId);
    return res.json(userDocs);
  }
});

app.post("/api/docs", authMiddleware, async (req, res) => {
  const userId = req.userId || "demo-user";
  let createdDocData;
  if (isDbOffline) {
    createdDocData = {
      id: "mock-doc-uuid-" + Date.now(),
      title: 'Untitled',
      content: '',
      owner_id: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const currentDocs = mockDb.docs || [];
    currentDocs.push(createdDocData);
    mockDb.docs = currentDocs; // Trigger proxy set to write to file
    return res.status(201).json(createdDocData);
  }
  const newDocId = require("crypto").randomUUID();
  try {
    // Fast-fail check for DB connectivity before running raw SQL queries
    await prisma.user.findFirst({ select: { id: true } });
    await prisma.$queryRawUnsafe(
      'INSERT INTO docs (id, title, content, owner_id) VALUES ($1::uuid, $2, $3, $4)',
      newDocId, 'Untitled', '', userId
    );
    const [createdDoc] = await prisma.$queryRawUnsafe(
      'SELECT * FROM docs WHERE id = $1::uuid',
      newDocId
    );
    return res.status(201).json(createdDoc || { id: newDocId, title: 'Untitled', content: '', owner_id: userId });
  } catch (error) {
    console.error("DB create doc failed, falling back to mockDb:", error.message);
    createdDocData = {
      id: "mock-doc-uuid-" + Date.now(),
      title: 'Untitled',
      content: '',
      owner_id: userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const currentDocs = mockDb.docs || [];
    currentDocs.push(createdDocData);
    mockDb.docs = currentDocs; // Trigger proxy set to write to file
    return res.status(201).json(createdDocData);
  }
});

app.get("/api/docs/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  if (isDbOffline) {
    const doc = mockDb.docs.find(d => d.id === id);
    if (!doc) return res.status(404).json({ error: "Doc not found (mockDb)" });
    return res.json(doc);
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (!isUuid) {
    // Skip SQL check for non-UUID strings to prevent PostgreSQL syntax errors
    const mockDoc = mockDb.docs.find(d => d.id === id);
    if (mockDoc) return res.json(mockDoc);
    return res.status(404).json({ error: "Doc not found (mockDb)" });
  }

  try {
    // Fast-fail check for DB connectivity before running raw SQL queries
    await prisma.user.findFirst({ select: { id: true } });
    const [doc] = await prisma.$queryRawUnsafe(
      'SELECT * FROM docs WHERE id = $1::uuid',
      id
    );
    if (!doc) {
      // Fallback: Check if document exists in mockDb
      const mockDoc = mockDb.docs.find(d => d.id === id);
      if (mockDoc) return res.json(mockDoc);
      return res.status(404).json({ error: "Doc not found" });
    }
    return res.json(doc);
  } catch (error) {
    console.error("DB fetch single doc failed, falling back to mockDb:", error.message);
    const doc = mockDb.docs.find(d => d.id === id);
    if (!doc) return res.status(404).json({ error: "Doc not found (mockDb)" });
    return res.json(doc);
  }
});

app.put("/api/docs/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  const userId = req.userId || "demo-user";

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (isDbOffline || !isUuid) {
    const currentDocs = mockDb.docs || [];
    const idx = currentDocs.findIndex(d => d.id === id);
    if (idx !== -1) {
      if (title !== undefined) currentDocs[idx].title = title;
      if (content !== undefined) currentDocs[idx].content = content;
      currentDocs[idx].updated_at = new Date().toISOString();
      mockDb.docs = currentDocs; // Trigger proxy set to write to file
      return res.json(currentDocs[idx]);
    } else {
      // SELF-HEALING: Auto-recreate the lost document in mockDb
      const newDoc = {
        id,
        title: title || 'Untitled',
        content: content || '',
        owner_id: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      currentDocs.push(newDoc);
      mockDb.docs = currentDocs;
      return res.status(201).json(newDoc);
    }
  }

  try {
    // Fast-fail check for DB connectivity before running raw SQL queries
    await prisma.user.findFirst({ select: { id: true } });

    // Check if it exists in SQL database first
    const [existingDoc] = await prisma.$queryRawUnsafe(
      'SELECT * FROM docs WHERE id = $1::uuid',
      id
    );

    if (existingDoc) {
      await prisma.$queryRawUnsafe(
        'UPDATE docs SET title = $1, content = $2, updated_at = NOW() WHERE id = $3::uuid',
        title, content, id
      );
      const [updatedDoc] = await prisma.$queryRawUnsafe(
        'SELECT * FROM docs WHERE id = $1::uuid',
        id
      );
      return res.json(updatedDoc || { id, title, content });
    }

    // Check if it exists in mockDb
    const currentDocs = mockDb.docs || [];
    const idx = currentDocs.findIndex(d => d.id === id);
    if (idx !== -1) {
      if (title !== undefined) currentDocs[idx].title = title;
      if (content !== undefined) currentDocs[idx].content = content;
      currentDocs[idx].updated_at = new Date().toISOString();
      mockDb.docs = currentDocs; // Trigger proxy set to write to file
      return res.json(currentDocs[idx]);
    }

    // SELF-HEALING: Auto-recreate the document. Insert into SQL as it has a valid UUID format
    await prisma.$queryRawUnsafe(
      'INSERT INTO docs (id, title, content, owner_id) VALUES ($1::uuid, $2, $3, $4)',
      id, title || 'Untitled', content || '', userId
    );
    const [newDoc] = await prisma.$queryRawUnsafe(
      'SELECT * FROM docs WHERE id = $1::uuid',
      id
    );
    return res.status(201).json(newDoc || { id, title, content, owner_id: userId });
  } catch (error) {
    console.error("DB update doc failed, falling back to mockDb:", error.message);
    const currentDocs = mockDb.docs || [];
    const idx = currentDocs.findIndex(d => d.id === id);
    if (idx !== -1) {
      if (title !== undefined) currentDocs[idx].title = title;
      if (content !== undefined) currentDocs[idx].content = content;
      currentDocs[idx].updated_at = new Date().toISOString();
      mockDb.docs = currentDocs; // Trigger proxy set to write to file
      return res.json(currentDocs[idx]);
    } else {
      // SELF-HEALING: Auto-recreate in mockDb fallback
      const newDoc = {
        id,
        title: title || 'Untitled',
        content: content || '',
        owner_id: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      currentDocs.push(newDoc);
      mockDb.docs = currentDocs;
      return res.status(201).json(newDoc);
    }
  }
});

app.delete("/api/docs/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;

  // Always attempt to delete from mockDb as well
  const deleteFromMockDb = () => {
    const currentDocs = mockDb.docs || [];
    const idx = currentDocs.findIndex(d => d.id === id);
    if (idx !== -1) {
      currentDocs.splice(idx, 1);
      mockDb.docs = currentDocs; // Trigger proxy set to write to file
      return true;
    }
    return false;
  };

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (isDbOffline || !isUuid) {
    const deleted = deleteFromMockDb();
    if (deleted) return res.json({ success: true });
    return res.status(404).json({ error: "Doc not found (mockDb)" });
  }

  try {
    // Fast-fail check for DB connectivity before running raw SQL queries
    await prisma.user.findFirst({ select: { id: true } });
    
    // Proactively clean it out of mockDb
    deleteFromMockDb();

    await prisma.$queryRawUnsafe(
      'DELETE FROM docs WHERE id = $1::uuid',
      id
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("DB delete doc failed, falling back to mockDb:", error.message);
    const deleted = deleteFromMockDb();
    if (deleted) return res.json({ success: true });
    return res.status(404).json({ error: "Doc not found (mockDb)" });
  }
});

// ─────────────────────────────────────────────
// MOCK AI BRAIN SERVICE
// ─────────────────────────────────────────────
app.post("/api/extra/ai/task/generate", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt is required" });

  setTimeout(() => {
    return res.json({
      name: `AI generated: Develop ${prompt.substring(0, 30)}...`,
      description: `### AI Generated Specification\nThis task was auto-generated based on the prompt: "${prompt}".\n\n#### Recommended Steps:\n- Research and design draft implementation\n- Conduct integration testing\n- Perform production hardening and review`,
      subtasks: [{ name: "Draft technical design document", position: 100 }],
      suggestedPriority: "HIGH",
    });
  }, 1000);
});

app.post("/api/extra/ai/workspace/standup", async (req, res) => {
  return res.json({
    summary: `### 🤖 WaveWork AI Daily Standup Summary\n\n**Yesterday's Work:**\n- Completed backend authentication services and workspace schema design.\n- Configured multi-tenant routing protocols.\n\n**Today's Focus:**\n- Implement drag-and-drop Kanban Board View components.\n- Integrate WebSocket state invalidation hooks.\n\n**Blockers:**\n- *None reported.* Have a high-productivity sprint! 🚀`,
  });
});

const PORT = 3005;
app.listen(PORT, () => {
  console.log(`[Extra Service] Running on Port ${PORT}`);
});
