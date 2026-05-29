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
    const spaces = await prisma.space.findMany({
      where: { workspaceId },
      orderBy: { position: "asc" },
      include: {
        statuses: { orderBy: { position: "asc" } },
        lists: { where: { folderId: null }, orderBy: { position: "asc" } },
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
    const mockSpaces = mockDb.spaces.filter((s) => s.workspaceId === workspaceId || s.workspaceId === "demo-ws");
    const hierarchy = mockSpaces.map((s) => {
      const statuses = mockDb.statuses.filter((st) => st.spaceId === s.id);
      const lists = mockDb.lists.filter((l) => l.spaceId === s.id && !l.folderId);
      return { ...s, statuses, lists, folders: [] };
    });

    return res.json(hierarchy);
  }
});

// Create Space (Invalidates Hierarchy Cache)
app.post("/api/workspaces/:workspaceId/spaces", async (req, res) => {
  const { workspaceId } = req.params;
  const { name, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: "Space name is required" });

  try {
    const space = await prisma.space.create({
      data: {
        workspaceId,
        name,
        color: color || "#4F46E5",
        icon: icon || "Folder",
      },
    });

    // Invalidate Redis cache
    await redisCache.del(`workspace:${workspaceId}:spaces`);
    console.log(`[Redis Cache] Hierarchy Cache Invalidated for ${workspaceId}`);

    return res.status(201).json(space);
  } catch (error) {
    const spaceId = "mock-space-" + Date.now();
    const mockSpace = { id: spaceId, workspaceId, name, color: color || "#4F46E5", icon: icon || "Folder", position: mockDb.spaces.length };
    mockDb.spaces.push(mockSpace);

    const todoStatus = { id: "todo-" + spaceId, spaceId, name: "TO DO", color: "#8E8E93", position: 0, type: "OPEN" };
    mockDb.statuses.push(todoStatus);
    mockDb.lists.push({ id: "mock-list-" + Date.now(), spaceId, name: "Roadmap List", position: 0 });

    return res.status(201).json(mockSpace);
  }
});

// Delete Space (Invalidates Cache)
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

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`[Workspace Service] Running on Port ${PORT}`);
});
