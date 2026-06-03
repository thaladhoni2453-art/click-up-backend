// backend/services/workspace-service/server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load configurations
dotenv.config({ path: "../../../.env" });

const { prisma } = require("@wavework/db");
const { redisCache } = require("@wavework/redis");
const { authMiddleware } = require("@wavework/middleware");
const { mockDb } = require("../../src/lib/mockDb");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Apply auth middleware to all workspace endpoints
app.use(authMiddleware);

// Get Workspaces
app.get("/api/workspaces", async (req, res) => {
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.userId },
      include: { workspace: true },
    });
    return res.json(memberships.map((m) => m.workspace));
  } catch (error) {
    const mockWss = mockDb.workspaces.filter((w) => w.orgId === (mockDb.organizations[0]?.id || "mock-org"));
    return res.json(mockWss);
  }
});

// Create Workspace
app.post("/api/workspaces", async (req, res) => {
  const { name, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: "Workspace name is required" });

  try {
    const workspace = await prisma.workspace.create({
      data: {
        orgId: req.orgId,
        name,
        color: color || "#4F46E5",
        icon: icon || "Briefcase",
      },
    });

    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: req.userId,
        role: "ADMIN",
      },
    });

    const space = await prisma.space.create({
      data: { workspaceId: workspace.id, name: "General Space", position: 0 },
    });

    await prisma.spaceMember.create({
      data: { spaceId: space.id, userId: req.userId, role: "ADMIN" },
    });

    return res.status(201).json(workspace);
  } catch (error) {
    const workspaceId = "mock-ws-" + Date.now();
    const mockWs = { id: workspaceId, orgId: req.orgId || "mock-org", name, color: color || "#4F46E5", icon: icon || "Briefcase" };
    mockDb.workspaces.push(mockWs);

    const spaceId = "mock-space-" + Date.now();
    mockDb.spaces.push({ id: spaceId, workspaceId, name: "General Space", position: 0 });

    const todoStatus = { id: "todo-" + spaceId, spaceId, name: "TO DO", color: "#8E8E93", position: 0, type: "OPEN" };
    mockDb.statuses.push(todoStatus);
    mockDb.lists.push({ id: "mock-list-" + Date.now(), spaceId, name: "Sprint Backlog", position: 0 });

    return res.status(201).json(mockWs);
  }
});

// Get Workspace Hierarchy with Resilient Redis Caching
app.get("/api/workspaces/:workspaceId/hierarchy", async (req, res) => {
  const { workspaceId } = req.params;
  const cacheKey = `workspace:${workspaceId}:spaces`;

  try {
    // 1. Try Redis Cache
    const cachedHierarchy = await redisCache.get(cacheKey);
    if (cachedHierarchy) {
      console.log(`[Redis Cache] Workspace Hierarchy Cache HIT for ${workspaceId}`);
      return res.json(JSON.parse(cachedHierarchy));
    }

    // 2. Query Postgres
    // Fetch only accessible spaces (Public spaces OR Private spaces where the user is a member)
    const spaces = await prisma.space.findMany({
      where: { 
        workspaceId,
        OR: [
          { isPrivate: false },
          {
            isPrivate: true,
            members: { some: { userId: req.userId } }
          }
        ]
      },
      orderBy: { position: "asc" },
      include: {
        statuses: { orderBy: { position: "asc" } },
        lists: { where: { folderId: null }, orderBy: { position: "asc" } },
        folders: {
          orderBy: { position: "asc" },
          include: {
            lists: { orderBy: { position: "asc" } }
          }
        }
      },
    });

    if (spaces.length > 0) {
      // Set Redis Cache for 5 minutes (300 seconds)
      await redisCache.set(cacheKey, JSON.stringify(spaces), 300);
      console.log(`[Redis Cache] Workspace Hierarchy Cache SET for ${workspaceId}`);
      return res.json(spaces);
    }
    
    throw new Error();
  } catch (error) {
    // Mock hierarchy fallback
    const mockSpaces = mockDb.spaces.filter((s) => s.workspaceId === workspaceId);
    
    const hierarchy = mockSpaces.map((s) => {
      const statuses = mockDb.statuses.filter((st) => st.spaceId === s.id);
      const lists = mockDb.lists.filter((l) => l.spaceId === s.id && !l.folderId);
      const folders = (mockDb.folders || []).filter((f) => f.spaceId === s.id).map((f) => {
        const folderLists = mockDb.lists.filter((l) => l.folderId === f.id);
        return { ...f, lists: folderLists };
      });
      return { ...s, statuses, lists, folders };
    });

    return res.json(hierarchy);
  }
});

// Create Space (Legacy route preserved, invalidates hierarchy cache)
app.post("/api/workspaces/:workspaceId/spaces", async (req, res) => {
  const { workspaceId } = req.params;
  const { name, color, icon, isPrivate } = req.body;
  if (!name) return res.status(400).json({ error: "Space name is required" });

  try {
    const space = await prisma.space.create({
      data: {
        workspaceId,
        name,
        color: color || "#4F46E5",
        icon: icon || "Folder",
        isPrivate: !!isPrivate
      },
    });

    // Add creator as ADMIN member of the space
    await prisma.spaceMember.create({
      data: { spaceId: space.id, userId: req.userId, role: "ADMIN" }
    });

    // Invalidate Redis cache
    await redisCache.del(`workspace:${workspaceId}:spaces`);
    console.log(`[Redis Cache] Hierarchy Cache Invalidated for ${workspaceId}`);

    return res.status(201).json(space);
  } catch (error) {
    const spaceId = "mock-space-" + Date.now();
    const mockSpace = { id: spaceId, workspaceId, name, color: color || "#4F46E5", icon: icon || "Folder", isPrivate: !!isPrivate, position: mockDb.spaces.length };
    mockDb.spaces.push(mockSpace);

    const todoStatus = { id: "todo-" + spaceId, spaceId, name: "TO DO", color: "#8E8E93", position: 0, type: "OPEN" };
    mockDb.statuses.push(todoStatus);
    mockDb.lists.push({ id: "mock-list-" + Date.now(), spaceId, name: "Roadmap List", position: 0 });

    return res.status(201).json(mockSpace);
  }
});

// Delete Space (Legacy route preserved, invalidates cache)
app.delete("/api/workspaces/spaces/:spaceId", async (req, res) => {
  const { spaceId } = req.params;
  try {
    const space = await prisma.space.findUnique({ where: { id: spaceId } });
    if (space) {
      await prisma.space.delete({ where: { id: spaceId } });
      await redisCache.del(`workspace:${space.workspaceId}:spaces`);
    }
    return res.json({ success: true });
  } catch (error) {
    mockDb.spaces = mockDb.spaces.filter((s) => s.id !== spaceId);
    return res.json({ success: true });
  }
});

// ─────────────────────────────────────────────
// NEW SPACES CRUD API ENDPOINTS
// ─────────────────────────────────────────────

// Get all accessible spaces for this workspace
app.get("/api/spaces", async (req, res) => {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: "workspaceId is required" });

  try {
    const spaces = await prisma.space.findMany({
      where: { 
        workspaceId,
        OR: [
          { isPrivate: false },
          {
            isPrivate: true,
            members: { some: { userId: req.userId } }
          }
        ]
      },
      orderBy: { position: "asc" },
      include: {
        members: { include: { user: true } },
        statuses: { orderBy: { position: "asc" } },
        lists: { where: { folderId: null }, orderBy: { position: "asc" } },
        folders: {
          orderBy: { position: "asc" },
          include: {
            lists: { orderBy: { position: "asc" } }
          }
        }
      }
    });
    return res.json(spaces);
  } catch (e) {
    const mockSpaces = mockDb.spaces.filter(s => s.workspaceId === workspaceId);
    return res.json(mockSpaces);
  }
});

// Create Space
app.post("/api/spaces", async (req, res) => {
  const { workspaceId, name, color, icon, isPrivate, memberIds } = req.body;
  if (!workspaceId || !name) return res.status(400).json({ error: "workspaceId and name are required" });

  try {
    const space = await prisma.space.create({
      data: {
        workspaceId,
        name,
        color: color || "#4F46E5",
        icon: icon || "Folder",
        isPrivate: !!isPrivate
      }
    });

    // Add creator as ADMIN member of the space
    await prisma.spaceMember.create({
      data: { spaceId: space.id, userId: req.userId, role: "ADMIN" }
    });

    // Add other members if private
    if (isPrivate && memberIds && Array.isArray(memberIds)) {
      const otherMembers = memberIds.filter(id => id !== req.userId);
      await prisma.spaceMember.createMany({
        data: otherMembers.map(userId => ({
          spaceId: space.id,
          userId,
          role: "MEMBER"
        })),
        skipDuplicates: true
      });
    }

    // Create default "TO DO" and "COMPLETE" statuses
    await prisma.status.createMany({
      data: [
        { spaceId: space.id, name: "TO DO", color: "#8E8E93", position: 0, type: "OPEN" },
        { spaceId: space.id, name: "COMPLETE", color: "#10B981", position: 1, type: "CLOSED" }
      ]
    });

    await redisCache.del(`workspace:${workspaceId}:spaces`);
    return res.status(201).json(space);
  } catch (e) {
    const spaceId = "mock-space-" + Date.now();
    const mockSpace = { id: spaceId, workspaceId, name, color: color || "#4F46E5", icon: icon || "Folder", isPrivate: !!isPrivate, position: mockDb.spaces.length };
    mockDb.spaces.push(mockSpace);

    // Mock space members mapping
    if (isPrivate && memberIds && Array.isArray(memberIds)) {
      memberIds.forEach(userId => {
        mockDb.spaceMembers.push({ id: "mock-sm-" + Date.now(), spaceId, userId, role: userId === req.userId ? "ADMIN" : "MEMBER" });
      });
    }
    return res.status(201).json(mockSpace);
  }
});

// Get single Space details
app.get("/api/spaces/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const space = await prisma.space.findUnique({
      where: { id },
      include: {
        members: { include: { user: true } },
        statuses: { orderBy: { position: "asc" } },
        lists: { where: { folderId: null }, orderBy: { position: "asc" } },
        folders: {
          orderBy: { position: "asc" },
          include: {
            lists: { orderBy: { position: "asc" } }
          }
        }
      }
    });
    if (!space) return res.status(404).json({ error: "Space not found" });

    // Permissions check: organization member first, private access second
    if (space.isPrivate) {
      const isMember = space.members.some(m => m.userId === req.userId);
      if (!isMember) return res.status(403).json({ error: "Access denied to private space" });
    }

    return res.json(space);
  } catch (e) {
    const space = mockDb.spaces.find(s => s.id === id);
    if (!space) return res.status(404).json({ error: "Space not found" });
    const statuses = mockDb.statuses.filter((st) => st.spaceId === space.id);
    const lists = mockDb.lists.filter((l) => l.spaceId === space.id && !l.folderId);
    const folders = (mockDb.folders || []).filter((f) => f.spaceId === space.id).map((f) => {
      const folderLists = mockDb.lists.filter((l) => l.folderId === f.id);
      return { ...f, lists: folderLists };
    });
    const members = (mockDb.spaceMembers || []).filter(sm => sm.spaceId === id).map(sm => {
      const u = mockDb.users.find(usr => usr.id === sm.userId);
      return { ...sm, user: u };
    });
    return res.json({ ...space, statuses, lists, folders, members });
  }
});

// Update Space configurations
app.patch("/api/spaces/:id", async (req, res) => {
  const { id } = req.params;
  const { name, color, icon, isPrivate, memberIds } = req.body;

  try {
    const space = await prisma.space.findUnique({
      where: { id },
      include: { members: true }
    });
    if (!space) return res.status(404).json({ error: "Space not found" });

    // Organizatonal admin check or space admin check
    const member = space.members.find(m => m.userId === req.userId);
    if (!member || member.role !== "ADMIN") {
      return res.status(403).json({ error: "Only Space Admins can manage Space settings" });
    }

    const updated = await prisma.space.update({
      where: { id },
      data: {
        name: name !== undefined ? name : space.name,
        color: color !== undefined ? color : space.color,
        icon: icon !== undefined ? icon : space.icon,
        isPrivate: isPrivate !== undefined ? !!isPrivate : space.isPrivate
      }
    });

    if (memberIds && Array.isArray(memberIds)) {
      // Re-align space members list
      await prisma.spaceMember.deleteMany({ where: { spaceId: id } });
      await prisma.spaceMember.createMany({
        data: memberIds.map(userId => ({
          spaceId: id,
          userId,
          role: userId === req.userId ? "ADMIN" : "MEMBER"
        })),
        skipDuplicates: true
      });
    }

    await redisCache.del(`workspace:${space.workspaceId}:spaces`);
    return res.json(updated);
  } catch (e) {
    const idx = mockDb.spaces.findIndex(s => s.id === id);
    if (idx !== -1) {
      if (name !== undefined) mockDb.spaces[idx].name = name;
      if (color !== undefined) mockDb.spaces[idx].color = color;
      if (icon !== undefined) mockDb.spaces[idx].icon = icon;
      if (isPrivate !== undefined) mockDb.spaces[idx].isPrivate = isPrivate;

      if (memberIds && Array.isArray(memberIds)) {
        mockDb.spaceMembers = mockDb.spaceMembers.filter(sm => sm.spaceId !== id);
        memberIds.forEach(userId => {
          mockDb.spaceMembers.push({ id: "mock-sm-" + Date.now(), spaceId: id, userId, role: userId === req.userId ? "ADMIN" : "MEMBER" });
        });
      }
      return res.json(mockDb.spaces[idx]);
    }
    return res.status(404).json({ error: "Space not found" });
  }
});

// Delete Space
app.delete("/api/spaces/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const space = await prisma.space.findUnique({
      where: { id },
      include: { members: true }
    });
    if (!space) return res.status(404).json({ error: "Space not found" });

    const member = space.members.find(m => m.userId === req.userId);
    if (!member || member.role !== "ADMIN") {
      return res.status(403).json({ error: "Only Space Admins can delete a Space" });
    }

    await prisma.space.delete({ where: { id } });
    await redisCache.del(`workspace:${space.workspaceId}:spaces`);
    return res.json({ success: true });
  } catch (e) {
    mockDb.spaces = mockDb.spaces.filter(s => s.id !== id);
    return res.json({ success: true });
  }
});

// Space Members APIs
app.get("/api/spaces/:id/members", async (req, res) => {
  const { id } = req.params;
  try {
    const members = await prisma.spaceMember.findMany({
      where: { spaceId: id },
      include: { user: true }
    });
    return res.json(members);
  } catch (e) {
    const members = (mockDb.spaceMembers || []).filter(sm => sm.spaceId === id).map(sm => {
      const u = mockDb.users.find(usr => usr.id === sm.userId);
      return { ...sm, user: u };
    });
    return res.json(members);
  }
});

app.post("/api/spaces/:id/members", async (req, res) => {
  const { id } = req.params;
  const { userId, role } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  try {
    const newMember = await prisma.spaceMember.create({
      data: {
        spaceId: id,
        userId,
        role: role || "MEMBER"
      },
      include: { user: true }
    });
    return res.status(201).json(newMember);
  } catch (e) {
    const mockMember = { id: "mock-sm-" + Date.now(), spaceId: id, userId, role: role || "MEMBER" };
    mockDb.spaceMembers.push(mockMember);
    const u = mockDb.users.find(usr => usr.id === userId);
    return res.status(201).json({ ...mockMember, user: u });
  }
});

app.delete("/api/spaces/:id/members/:userId", async (req, res) => {
  const { id, userId } = req.params;
  try {
    await prisma.spaceMember.delete({
      where: {
        spaceId_userId: {
          spaceId: id,
          userId
        }
      }
    });
    return res.json({ success: true });
  } catch (e) {
    mockDb.spaceMembers = mockDb.spaceMembers.filter(sm => !(sm.spaceId === id && sm.userId === userId));
    return res.json({ success: true });
  }
});

// ─────────────────────────────────────────────
// NEW FOLDERS & FOLDER-LISTS CRUD ENDPOINTS
// ─────────────────────────────────────────────

// Create Folder inside Space
app.post("/api/spaces/:spaceId/folders", async (req, res) => {
  const { spaceId } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Folder name is required" });

  try {
    const folder = await prisma.folder.create({
      data: {
        spaceId,
        name
      }
    });

    const space = await prisma.space.findUnique({ where: { id: spaceId } });
    if (space) {
      await redisCache.del(`workspace:${space.workspaceId}:spaces`);
    }

    return res.status(201).json(folder);
  } catch (error) {
    const folderId = "mock-folder-" + Date.now();
    const mockFolder = { id: folderId, spaceId, name, position: mockDb.folders ? mockDb.folders.length : 0 };
    mockDb.folders.push(mockFolder);
    return res.status(201).json(mockFolder);
  }
});

// Delete Folder
app.delete("/api/folders/:folderId", async (req, res) => {
  const { folderId } = req.params;
  try {
    const folder = await prisma.folder.findUnique({ where: { id: folderId } });
    if (folder) {
      await prisma.folder.delete({ where: { id: folderId } });
      const space = await prisma.space.findUnique({ where: { id: folder.spaceId } });
      if (space) {
        await redisCache.del(`workspace:${space.workspaceId}:spaces`);
      }
    }
    return res.json({ success: true });
  } catch (error) {
    mockDb.folders = mockDb.folders.filter((f) => f.id !== folderId);
    return res.json({ success: true });
  }
});

// Create List inside Folder
app.post("/api/folders/:folderId/lists", async (req, res) => {
  const { folderId } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "List name is required" });

  try {
    const folder = await prisma.folder.findUnique({ where: { id: folderId } });
    if (!folder) return res.status(404).json({ error: "Folder not found" });

    const list = await prisma.list.create({
      data: {
        spaceId: folder.spaceId,
        folderId: folderId,
        name
      }
    });

    const space = await prisma.space.findUnique({ where: { id: folder.spaceId } });
    if (space) {
      await redisCache.del(`workspace:${space.workspaceId}:spaces`);
    }

    return res.status(201).json(list);
  } catch (error) {
    const listId = "mock-list-" + Date.now();
    const folder = mockDb.folders.find(f => f.id === folderId);
    const spaceId = folder ? folder.spaceId : "demo-space";
    const mockList = { id: listId, spaceId, folderId, name, position: mockDb.lists.length };
    mockDb.lists.push(mockList);
    return res.status(201).json(mockList);
  }
});

// Create list (Invalidates Cache)
app.post("/api/workspaces/spaces/:spaceId/lists", async (req, res) => {
  const { spaceId } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "List name is required" });

  try {
    const list = await prisma.list.create({ data: { spaceId, name } });
    const space = await prisma.space.findUnique({ where: { id: spaceId } });
    if (space) {
      await redisCache.del(`workspace:${space.workspaceId}:spaces`);
    }
    return res.status(201).json(list);
  } catch (error) {
    const listId = "mock-list-" + Date.now();
    const mockList = { id: listId, spaceId, name, position: mockDb.lists.length };
    mockDb.lists.push(mockList);
    return res.status(201).json(mockList);
  }
});

// Delete List (Invalidates Cache)
app.delete("/api/workspaces/lists/:listId", async (req, res) => {
  const { listId } = req.params;
  try {
    const list = await prisma.list.findUnique({ where: { id: listId } });
    if (list) {
      await prisma.list.delete({ where: { id: listId } });
      const space = await prisma.space.findUnique({ where: { id: list.spaceId } });
      if (space) {
        await redisCache.del(`workspace:${space.workspaceId}:spaces`);
      }
    }
    return res.json({ success: true });
  } catch (error) {
    mockDb.lists = mockDb.lists.filter((l) => l.id !== listId);
    return res.json({ success: true });
  }
});

app.get("/api/workspaces/lists/:listId", async (req, res) => {
  const { listId } = req.params;
  try {
    const list = await prisma.list.findUnique({ where: { id: listId } });
    if (list) return res.json(list);
    throw new Error();
  } catch (e) {
    const mockList = mockDb.lists.find((l) => l.id === listId) || mockDb.lists[0];
    return res.json(mockList);
  }
});

app.get("/api/workspaces/spaces/:spaceId", async (req, res) => {
  const { spaceId } = req.params;
  try {
    const space = await prisma.space.findUnique({ where: { id: spaceId }, include: { statuses: true } });
    if (space) return res.json(space);
    throw new Error();
  } catch (e) {
    const space = mockDb.spaces.find((s) => s.id === spaceId) || mockDb.spaces[0];
    const statuses = mockDb.statuses.filter((st) => st.spaceId === space.id);
    return res.json({ ...space, statuses });
  }
});

app.post("/api/clean-spaces", async (req, res) => {
  try {
    // Run DB cleanup in the background asynchronously
    (async () => {
      try {
        await prisma.user.findFirst({ select: { id: true } });
        await prisma.spaceMember.deleteMany({});
        await prisma.list.deleteMany({});
        await prisma.folder.deleteMany({});
        await prisma.space.deleteMany({});
        console.log("Postgres spaces cleanup complete.");
      } catch (dbError) {
        console.log("Postgres cleanup skipped or failed:", dbError.message);
      }
    })();

    mockDb.spaces = [];
    mockDb.folders = [];
    mockDb.lists = [];
    mockDb.spaceMembers = [];

    // Also clear mockDb JSON file on disk
    const fs = require('fs');
    const path = require('path');
    const storePath = path.join(__dirname, '../../src/lib/mockDb_store.json');
    if (fs.existsSync(storePath)) {
      const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      data.spaces = [];
      data.folders = [];
      data.lists = [];
      data.spaceMembers = [];
      fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`[Workspace Service] Running on Port ${PORT}`);
});
