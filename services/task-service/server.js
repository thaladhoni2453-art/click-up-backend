// backend/services/task-service/server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

// Load configurations
dotenv.config({ path: "../../../.env" });

const { prisma } = require("@wavework/db");

// Run dynamic schema migrations on startup
const runStartupMigration = async () => {
  try {
    console.log("🌊 [Task Service Startup] Ensuring database columns exist via ALTER TABLE...");
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Task" 
      ADD COLUMN IF NOT EXISTS "story_points" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "estimated_hours" DOUBLE PRECISION NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP WITH TIME ZONE;
    `);
    console.log("🌊 [Task Service Startup] Database schema altered successfully!");
  } catch (err) {
    console.warn("⚠️ [Task Service Startup] Alter table migration skipped or failed (possibly running mockDb):", err.message);
  }
};
runStartupMigration();

const { redisCache } = require("@wavework/redis");
const { publishEvent } = require("@wavework/events");
const { authMiddleware } = require("@wavework/middleware");
const { mockDb } = require("../../src/lib/mockDb");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Apply auth middleware to all task endpoints
app.use(authMiddleware);

// Get Tasks (with Resilient Redis Caching)
app.get("/api/tasks", async (req, res) => {
  const { listId, priority, statusId, search } = req.query;

  if (!listId) {
    return res.status(400).json({ error: "listId is required" });
  }

  const cacheKey = `list:${listId}:tasks:${priority || ""}:${statusId || ""}:${search || ""}`;

  try {
    // 1. Try Redis Cache
    const cachedTasks = await redisCache.get(cacheKey);
    if (cachedTasks) {
      console.log(`[Redis Cache] Task List Cache HIT for ${listId}`);
      return res.json(JSON.parse(cachedTasks));
    }

    // 2. Query Database
    const whereClause = {
      listId: listId,
      isArchived: false,
    };

    if (priority) whereClause.priority = priority;
    if (statusId) whereClause.statusId = statusId;
    if (search) {
      whereClause.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const tasks = await prisma.task.findMany({
      where: whereClause,
      orderBy: { position: "asc" },
      include: {
        creator: { select: { id: true, fullName: true } },
        status: true,
        assignees: {
          include: {
            user: { select: { id: true, fullName: true, email: true, avatarUrl: true } }
          }
        }
      },
    });

    if (tasks.length > 0) {
      // Cache lists for 60 seconds
      await redisCache.set(cacheKey, JSON.stringify(tasks), 60);
      console.log(`[Redis Cache] Task List Cache SET for ${listId}`);
      return res.json(tasks);
    }
    
    throw new Error();
  } catch (error) {
    // Mock Fallback
    let filteredTasks = mockDb.tasks.filter((t) => t.listId === listId);

    if (priority) filteredTasks = filteredTasks.filter((t) => t.priority === priority);
    if (statusId) filteredTasks = filteredTasks.filter((t) => t.statusId === statusId);

    const tasksWithDetails = filteredTasks.map((t) => {
      const status = mockDb.statuses.find((st) => st.id === t.statusId) || { id: t.statusId, name: "TO DO", color: "#8E8E93" };
      const mockAssignees = (mockDb.taskAssignees || [])
        .filter((ta) => ta.taskId === t.id)
        .map((ta) => {
          const u = mockDb.users.find((user) => user.id === ta.userId);
          return u ? { user: { id: u.id, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl } } : null;
        })
        .filter(Boolean);
      return {
        ...t,
        creator: { id: t.creatorId, fullName: "Workspace Creator" },
        status,
        assignees: mockAssignees
      };
    });

    return res.json(tasksWithDetails);
  }
});

// Helper to invalidate task lists cache
const invalidateTasksCache = async (listId) => {
  try {
    const client = redisCache.getRedisClient?.();
    if (client) {
      // Find all keys matching list:ID:tasks* and delete them
      const keys = await client.keys(`list:${listId}:tasks*`);
      if (keys.length > 0) {
        await client.del(...keys);
        console.log(`[Redis Cache] Cleared ${keys.length} cached task list keys for list ${listId}`);
      }
    } else {
      // Fallback fallback invalidation for memory cache
      await redisCache.del(`list:${listId}:tasks:::`);
    }
  } catch (e) {
    // Ignore errors
  }
};

// Get Dashboard Stats
app.get("/api/dashboard/stats", async (req, res) => {
  try {
    const now = new Date();
    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
    startOfWeek.setDate(diff);
    startOfWeek.setHours(0, 0, 0, 0);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);

    const tasks = await prisma.task.findMany({
      where: {
        OR: [
          { creatorId: req.userId },
          { assignees: { some: { userId: req.userId } } }
        ],
        createdAt: {
          gte: startOfWeek,
          lt: endOfWeek
        }
      },
      include: {
        status: true
      }
    });

    const completedTasks = tasks.filter(t => t.statusId === 'done-status' || t.status?.name === 'COMPLETE' || t.status?.name === 'DONE');
    const totalTasks = tasks.length;
    const completion_rate = totalTasks > 0 ? Math.round((completedTasks.length / totalTasks) * 100) : 0;
    const tracked_hours = completedTasks.reduce((sum, t) => sum + (t.estimated_hours || 0), 0);
    const velocity = completedTasks.reduce((sum, t) => sum + (t.story_points || 0), 0);

    return res.json({
      completion_rate,
      tracked_hours,
      velocity
    });
  } catch (error) {
    console.error("Dashboard stats DB query failed, falling back to mockDb:", error);
    try {
      const now = new Date();
      const startOfWeek = new Date(now);
      const day = startOfWeek.getDay();
      const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
      startOfWeek.setDate(diff);
      startOfWeek.setHours(0, 0, 0, 0);

      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 7);

      const userTasks = mockDb.tasks.filter(t => {
        const isUserRelated = t.creatorId === req.userId || (t.assignees && t.assignees.some(a => a.userId === req.userId)) || t.creatorId === 'demo-user';
        let taskDate = t.createdAt ? new Date(t.createdAt) : new Date();
        return isUserRelated && taskDate >= startOfWeek && taskDate < endOfWeek;
      });

      const completedTasks = userTasks.filter(t => t.statusId === 'done-status' || t.statusId?.includes('done'));
      const totalTasks = userTasks.length;
      const completion_rate = totalTasks > 0 ? Math.round((completedTasks.length / totalTasks) * 100) : 0;
      const tracked_hours = completedTasks.reduce((sum, t) => sum + (t.estimated_hours || 0), 0);
      const velocity = completedTasks.reduce((sum, t) => sum + (t.story_points || 0), 0);

      return res.json({
        completion_rate,
        tracked_hours,
        velocity
      });
    } catch (fallbackError) {
      return res.json({
        completion_rate: 0,
        tracked_hours: 0,
        velocity: 0
      });
    }
  }
});

// Get single task
app.get("/api/tasks/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, fullName: true } },
        status: true,
        comments: {
          include: { author: { select: { id: true, fullName: true } } },
          orderBy: { createdAt: "desc" },
        },
        timeEntries: true,
        assignees: {
          include: {
            user: { select: { id: true, fullName: true, email: true, avatarUrl: true } }
          }
        }
      },
    });
    if (task) return res.json(task);
    throw new Error();
  } catch (error) {
    const t = mockDb.tasks.find((taskItem) => taskItem.id === id);
    if (!t) return res.status(404).json({ error: "Task not found (Mock DB)" });

    const status = mockDb.statuses.find((st) => st.id === t.statusId) || { id: t.statusId, name: "TO DO", color: "#8E8E93" };
    const comments = mockDb.comments
      .filter((c) => c.taskId === t.id)
      .map((c) => {
        const author = mockDb.users.find((u) => u.id === c.authorId) || { id: c.authorId, fullName: "Workspace Member" };
        return { ...c, author };
      });

    const mockAssignees = (mockDb.taskAssignees || [])
      .filter((ta) => ta.taskId === t.id)
      .map((ta) => {
        const u = mockDb.users.find((user) => user.id === ta.userId);
        return u ? { user: { id: u.id, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl } } : null;
      })
      .filter(Boolean);

    return res.json({
      ...t,
      creator: { id: t.creatorId, fullName: "Workspace Creator" },
      status,
      comments,
      timeEntries: [],
      assignees: mockAssignees
    });
  }
});

// Create Task (Invalidates Cache & Publishes Event)
app.post("/api/tasks", async (req, res) => {
  const { listId, name, description, priority, dueDate, statusId, position, timeEstimate, estimated_hours, story_points, points } = req.body;

  if (!listId || !name) {
    return res.status(400).json({ error: "listId and name are required parameters" });
  }

  try {
    const parsedEstimate = timeEstimate !== undefined ? parseInt(timeEstimate) : null;
    const parsedHours = estimated_hours !== undefined ? parseFloat(estimated_hours) : (timeEstimate !== undefined ? parseFloat(timeEstimate) : 0);
    const parsedPoints = points !== undefined ? parseInt(points) : null;
    const parsedStoryPoints = story_points !== undefined ? parseInt(story_points) : (points !== undefined ? parseInt(points) : 0);

    const task = await prisma.task.create({
      data: {
        listId,
        creatorId: req.userId,
        statusId: statusId || "todo",
        name,
        description,
        priority: priority || "NONE",
        dueDate: dueDate ? new Date(dueDate) : null,
        position: position || 1000.0,
        timeEstimate: parsedEstimate,
        estimated_hours: parsedHours,
        points: parsedPoints,
        story_points: parsedStoryPoints
      },
      include: { status: true },
    });

    // Invalidate Redis Caches
    await invalidateTasksCache(listId);

    // Event Pub/Sub: broadcast to all realtime instances
    const listObj = await prisma.list.findUnique({
      where: { id: listId },
      include: { space: true },
    });
    
    await publishEvent("ws:emit", {
      room: `workspace:${listObj?.space.workspaceId || "mock-ws"}`,
      event: "task:changed",
      data: { taskId: task.id, listId, action: "CREATED" }
    });

    return res.status(201).json(task);
  } catch (error) {
    const taskId = "mock-task-" + Date.now();
    
    const parsedEstimate = timeEstimate !== undefined ? parseInt(timeEstimate) : null;
    const parsedHours = estimated_hours !== undefined ? parseFloat(estimated_hours) : (timeEstimate !== undefined ? parseFloat(timeEstimate) : 0);
    const parsedPoints = points !== undefined ? parseInt(points) : null;
    const parsedStoryPoints = story_points !== undefined ? parseInt(story_points) : (points !== undefined ? parseInt(points) : 0);

    const mockTask = {
      id: taskId,
      listId,
      creatorId: req.userId || "demo-user",
      statusId: statusId || "todo",
      name,
      description,
      priority: priority || "NONE",
      dueDate: dueDate ? new Date(dueDate) : null,
      position: position || 1000.0,
      timeSpent: 0,
      timeEstimate: parsedEstimate,
      estimated_hours: parsedHours,
      points: parsedPoints,
      story_points: parsedStoryPoints
    };

    mockDb.tasks.push(mockTask);
    const status = mockDb.statuses.find((st) => st.id === mockTask.statusId) || { id: mockTask.statusId, name: "TO DO", color: "#8E8E93" };

    // Emit event directly on WebSocket
    await publishEvent("ws:emit", {
      room: "workspace:default-ws",
      event: "task:changed",
      data: { taskId, listId, action: "CREATED" }
    });

    return res.status(201).json({
      ...mockTask,
      status,
      creator: { id: mockTask.creatorId, fullName: "Workspace Creator" },
      assignees: []
    });
  }
});

// Update Task (Invalidates Cache & Publishes Event)
app.patch("/api/tasks/:id", async (req, res) => {
  const { id } = req.params;
  const { name, description, priority, dueDate, statusId, position, timeEstimate, estimated_hours, story_points, points } = req.body;

  try {
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (priority !== undefined) updateData.priority = priority;
    if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
    if (statusId !== undefined) {
      updateData.statusId = statusId;
      try {
        const statusObj = await prisma.status.findUnique({ where: { id: statusId } });
        if (statusObj?.name === "COMPLETE" || statusObj?.name === "DONE" || statusObj?.type === "DONE" || statusObj?.type === "CLOSED" || statusId === "done-status") {
          updateData.completed_at = new Date();
        } else {
          updateData.completed_at = null;
        }
      } catch (statusErr) {
        if (statusId === "done-status" || statusId.includes("done")) {
          updateData.completed_at = new Date();
        } else {
          updateData.completed_at = null;
        }
      }
    }
    if (position !== undefined) updateData.position = position;

    // Support updating estimates & points
    if (timeEstimate !== undefined) {
      updateData.timeEstimate = timeEstimate !== null ? parseInt(timeEstimate) : null;
      updateData.estimated_hours = timeEstimate !== null ? parseFloat(timeEstimate) : 0;
    }
    if (estimated_hours !== undefined) {
      updateData.estimated_hours = estimated_hours !== null ? parseFloat(estimated_hours) : 0;
    }
    if (points !== undefined) {
      updateData.points = points !== null ? parseInt(points) : null;
      updateData.story_points = points !== null ? parseInt(points) : 0;
    }
    if (story_points !== undefined) {
      updateData.story_points = story_points !== null ? parseInt(story_points) : 0;
    }

    const task = await prisma.task.update({
      where: { id },
      data: updateData,
      include: {
        status: true,
        list: { include: { space: true } },
        assignees: {
          include: {
            user: { select: { id: true, fullName: true, email: true, avatarUrl: true } }
          }
        }
      },
    });

    // Invalidate caches
    await invalidateTasksCache(task.listId);

    // Event Sourcing
    await publishEvent("ws:emit", {
      room: `workspace:${task.list.space.workspaceId}`,
      event: "task:changed",
      data: { taskId: task.id, listId: task.listId, action: "UPDATED" }
    });

    return res.json(task);
  } catch (error) {
    const idx = mockDb.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return res.status(404).json({ error: "Task not found (Mock DB)" });

    if (name !== undefined) mockDb.tasks[idx].name = name;
    if (description !== undefined) mockDb.tasks[idx].description = description;
    if (priority !== undefined) mockDb.tasks[idx].priority = priority;
    if (dueDate !== undefined) mockDb.tasks[idx].dueDate = dueDate ? new Date(dueDate) : null;
    if (statusId !== undefined) {
      mockDb.tasks[idx].statusId = statusId;
      if (statusId === "done-status" || statusId.includes("done")) {
        mockDb.tasks[idx].completed_at = new Date();
      } else {
        mockDb.tasks[idx].completed_at = null;
      }
    }
    if (position !== undefined) mockDb.tasks[idx].position = position;

    // Mock updates
    if (timeEstimate !== undefined) {
      mockDb.tasks[idx].timeEstimate = timeEstimate !== null ? parseInt(timeEstimate) : null;
      mockDb.tasks[idx].estimated_hours = timeEstimate !== null ? parseFloat(timeEstimate) : 0;
    }
    if (estimated_hours !== undefined) {
      mockDb.tasks[idx].estimated_hours = estimated_hours !== null ? parseFloat(estimated_hours) : 0;
    }
    if (points !== undefined) {
      mockDb.tasks[idx].points = points !== null ? parseInt(points) : null;
      mockDb.tasks[idx].story_points = points !== null ? parseInt(points) : 0;
    }
    if (story_points !== undefined) {
      mockDb.tasks[idx].story_points = story_points !== null ? parseInt(story_points) : 0;
    }

    const updated = mockDb.tasks[idx];
    const status = mockDb.statuses.find((st) => st.id === updated.statusId) || { id: updated.statusId, name: "TO DO", color: "#8E8E93" };

    await publishEvent("ws:emit", {
      room: "workspace:default-ws",
      event: "task:changed",
      data: { taskId: id, listId: updated.listId, action: "UPDATED" }
    });

    const mockAssignees = (mockDb.taskAssignees || [])
      .filter((ta) => ta.taskId === updated.id)
      .map((ta) => {
        const u = mockDb.users.find((user) => user.id === ta.userId);
        return u ? { user: { id: u.id, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl } } : null;
      })
      .filter(Boolean);

    return res.json({
      ...updated,
      status,
      creator: { id: updated.creatorId, fullName: "Workspace Creator" },
      assignees: mockAssignees
    });
  }
});

// Delete Task (Invalidates Cache & Publishes Event)
app.delete("/api/tasks/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const task = await prisma.task.findUnique({
      where: { id },
      include: { list: { include: { space: true } } },
    });
    
    if (task) {
      await prisma.task.delete({ where: { id } });
      await invalidateTasksCache(task.listId);
      
      await publishEvent("ws:emit", {
        room: `workspace:${task.list.space.workspaceId}`,
        event: "task:changed",
        data: { taskId: id, listId: task.listId, action: "DELETED" }
      });
    }
    return res.json({ success: true });
  } catch (error) {
    const t = mockDb.tasks.find((taskItem) => taskItem.id === id);
    mockDb.tasks = mockDb.tasks.filter((taskItem) => taskItem.id !== id);
    
    if (t) {
      await publishEvent("ws:emit", {
        room: "workspace:default-ws",
        event: "task:changed",
        data: { taskId: id, listId: t.listId, action: "DELETED" }
      });
    }
    return res.json({ success: true });
  }
});

// Create Comment
app.post("/api/tasks/:taskId/comments", async (req, res) => {
  const { taskId } = req.params;
  const { content } = req.body;

  try {
    const comment = await prisma.comment.create({
      data: { taskId, authorId: req.userId, content },
    });
    return res.status(201).json(comment);
  } catch (error) {
    const mockComment = {
      id: "mock-comment-" + Date.now(),
      taskId,
      authorId: req.userId || "demo-user",
      content,
      createdAt: new Date(),
    };
    mockDb.comments.push(mockComment);
    const author = mockDb.users.find((u) => u.id === mockComment.authorId) || { id: mockComment.authorId, fullName: "Workspace Member" };
    return res.status(201).json({ ...mockComment, author });
  }
});

// Time Entries
app.post("/api/tasks/:taskId/time-entries", async (req, res) => {
  const { taskId } = req.params;
  const { startedAt, endedAt, description, billable } = req.body;

  try {
    const timeEntry = await prisma.timeEntry.create({
      data: {
        taskId,
        userId: req.userId,
        startedAt: new Date(startedAt),
        endedAt: endedAt ? new Date(endedAt) : null,
        description,
        billable: billable || false,
        duration: endedAt ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000) : null,
      },
    });
    return res.status(201).json(timeEntry);
  } catch (error) {
    const te = {
      id: "mock-te-" + Date.now(),
      taskId,
      userId: req.userId || "demo-user",
      startedAt: new Date(startedAt),
      endedAt: endedAt ? new Date(endedAt) : null,
      duration: endedAt ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000) : null,
      description,
      billable: billable || false,
    };
    mockDb.timeEntries.push(te);
    return res.status(201).json(te);
  }
});

// ─────────────────────────────────────────────
// SECURE TASK ASSIGNMENT API ENDPOINTS
// ─────────────────────────────────────────────

async function validateAssigneeAccess(taskId, userId) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { list: { include: { space: true } } },
  });
  if (!task) return { valid: false, error: "Task not found" };

  const space = task.list.space;

  // 1. Verify user is workspace member
  const workspaceMember = await prisma.workspaceMember.findFirst({
    where: { workspaceId: space.workspaceId, userId },
  });
  if (!workspaceMember) {
    return { valid: false, error: "User is not a member of the workspace" };
  }

  // 2. If private space, verify user is space member
  if (space.isPrivate) {
    const spaceMember = await prisma.spaceMember.findFirst({
      where: { spaceId: space.id, userId },
    });
    if (!spaceMember) {
      return { valid: false, error: "User does not have access to this private Space" };
    }
  }

  return { valid: true };
}

function validateAssigneeAccessMock(taskId, userId) {
  const task = mockDb.tasks.find((t) => t.id === taskId);
  if (!task) return { valid: false, error: "Task not found" };

  const list = mockDb.lists.find((l) => l.id === task.listId);
  const spaceId = list ? list.spaceId : "demo-space";
  const space = mockDb.spaces.find((s) => s.id === spaceId);

  // In mockDb, we verify the user exists
  const user = mockDb.users.find((u) => u.id === userId);
  if (!user) {
    return { valid: false, error: "User not found" };
  }

  // If private space, verify user is space member
  if (space && space.isPrivate) {
    const spaceMember = (mockDb.spaceMembers || []).find(
      (sm) => sm.spaceId === spaceId && sm.userId === userId
    );
    if (!spaceMember) {
      return { valid: false, error: "User does not have access to this private Space" };
    }
  }

  return { valid: true };
}

// GET /api/tasks/:id/assignees
app.get("/api/tasks/:id/assignees", async (req, res) => {
  const { id } = req.params;
  try {
    const assignees = await prisma.taskAssignee.findMany({
      where: { taskId: id },
      include: { user: { select: { id: true, fullName: true, email: true, avatarUrl: true } } },
    });
    return res.json(assignees.map((a) => a.user));
  } catch (error) {
    const assignees = (mockDb.taskAssignees || [])
      .filter((ta) => ta.taskId === id)
      .map((ta) => {
        const u = mockDb.users.find((user) => user.id === ta.userId);
        return u ? { id: u.id, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl } : null;
      })
      .filter(Boolean);
    return res.json(assignees);
  }
});

// GET /api/tasks/:id/eligible-assignees
app.get("/api/tasks/:id/eligible-assignees", async (req, res) => {
  const { id } = req.params;
  try {
    const task = await prisma.task.findUnique({
      where: { id },
      include: { list: { include: { space: true } } },
    });
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    const space = task.list.space;
    if (space.isPrivate) {
      const spaceMembers = await prisma.spaceMember.findMany({
        where: { spaceId: space.id },
        include: { user: { select: { id: true, fullName: true, email: true, avatarUrl: true } } },
      });
      return res.json(spaceMembers.map((sm) => sm.user));
    } else {
      const workspaceMembers = await prisma.workspaceMember.findMany({
        where: { workspaceId: space.workspaceId },
        include: { user: { select: { id: true, fullName: true, email: true, avatarUrl: true } } },
      });
      return res.json(workspaceMembers.map((wm) => wm.user));
    }
  } catch (error) {
    const task = mockDb.tasks.find((t) => t.id === id);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }
    const list = mockDb.lists.find((l) => l.id === task.listId);
    const spaceId = list ? list.spaceId : "demo-space";
    const space = mockDb.spaces.find((s) => s.id === spaceId);
    
    if (space && space.isPrivate) {
      const spaceMembers = (mockDb.spaceMembers || [])
        .filter((sm) => sm.spaceId === spaceId)
        .map((sm) => {
          const u = mockDb.users.find((user) => user.id === sm.userId);
          return u ? { id: u.id, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl } : null;
        })
        .filter(Boolean);
      return res.json(spaceMembers);
    } else {
      const users = mockDb.users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        avatarUrl: u.avatarUrl,
      }));
      return res.json(users);
    }
  }
});

// POST /api/tasks/:id/assignees
app.post("/api/tasks/:id/assignees", async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  try {
    const validation = await validateAssigneeAccess(id, userId);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }

    const assignee = await prisma.taskAssignee.upsert({
      where: { taskId_userId: { taskId: id, userId } },
      create: { taskId: id, userId },
      update: {},
      include: { user: { select: { id: true, fullName: true, email: true, avatarUrl: true } } },
    });

    const task = await prisma.task.findUnique({ where: { id } });
    if (task) {
      await invalidateTasksCache(task.listId);
      const listObj = await prisma.list.findUnique({
        where: { id: task.listId },
        include: { space: true },
      });
      await publishEvent("ws:emit", {
        room: `workspace:${listObj?.space.workspaceId || "mock-ws"}`,
        event: "task:changed",
        data: { taskId: id, listId: task.listId, action: "UPDATED" }
      });
    }

    return res.status(201).json(assignee.user);
  } catch (error) {
    const validation = validateAssigneeAccessMock(id, userId);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }

    if (!mockDb.taskAssignees) {
      mockDb.taskAssignees = [];
    }

    const existing = mockDb.taskAssignees.find((ta) => ta.taskId === id && ta.userId === userId);
    if (!existing) {
      mockDb.taskAssignees.push({ taskId: id, userId });
    }

    const task = mockDb.tasks.find((t) => t.id === id);
    if (task) {
      if (!task.assignees) task.assignees = [];
      if (!task.assignees.some((a) => a.userId === userId)) {
        task.assignees.push({ userId });
      }

      await publishEvent("ws:emit", {
        room: "workspace:default-ws",
        event: "task:changed",
        data: { taskId: id, listId: task.listId, action: "UPDATED" }
      });
    }

    const u = mockDb.users.find((user) => user.id === userId);
    return res.status(201).json({ id: u.id, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl });
  }
});

// DELETE /api/tasks/:id/assignees/:userId
app.delete("/api/tasks/:id/assignees/:userId", async (req, res) => {
  const { id, userId } = req.params;

  try {
    await prisma.taskAssignee.delete({
      where: { taskId_userId: { taskId: id, userId } },
    });

    const task = await prisma.task.findUnique({ where: { id } });
    if (task) {
      await invalidateTasksCache(task.listId);
      const listObj = await prisma.list.findUnique({
        where: { id: task.listId },
        include: { space: true },
      });
      await publishEvent("ws:emit", {
        room: `workspace:${listObj?.space.workspaceId || "mock-ws"}`,
        event: "task:changed",
        data: { taskId: id, listId: task.listId, action: "UPDATED" }
      });
    }

    return res.json({ success: true });
  } catch (error) {
    if (mockDb.taskAssignees) {
      mockDb.taskAssignees = mockDb.taskAssignees.filter(
        (ta) => !(ta.taskId === id && ta.userId === userId)
      );
    }

    const task = mockDb.tasks.find((t) => t.id === id);
    if (task) {
      if (task.assignees) {
        task.assignees = task.assignees.filter((a) => a.userId !== userId);
      }

      await publishEvent("ws:emit", {
        room: "workspace:default-ws",
        event: "task:changed",
        data: { taskId: id, listId: task.listId, action: "UPDATED" }
      });
    }

    return res.json({ success: true });
  }
});

// PATCH /api/tasks/:id/assignees
app.patch("/api/tasks/:id/assignees", async (req, res) => {
  const { id } = req.params;
  const { userIds } = req.body;
  if (!userIds || !Array.isArray(userIds)) {
    return res.status(400).json({ error: "userIds array is required" });
  }

  try {
    for (const userId of userIds) {
      const validation = await validateAssigneeAccess(id, userId);
      if (!validation.valid) {
        return res.status(403).json({ error: `User ${userId}: ${validation.error}` });
      }
    }

    await prisma.$transaction([
      prisma.taskAssignee.deleteMany({ where: { taskId: id } }),
      prisma.taskAssignee.createMany({
        data: userIds.map((userId) => ({ taskId: id, userId })),
        skipDuplicates: true,
      }),
    ]);

    const task = await prisma.task.findUnique({ where: { id } });
    if (task) {
      await invalidateTasksCache(task.listId);
      const listObj = await prisma.list.findUnique({
        where: { id: task.listId },
        include: { space: true },
      });
      await publishEvent("ws:emit", {
        room: `workspace:${listObj?.space.workspaceId || "mock-ws"}`,
        event: "task:changed",
        data: { taskId: id, listId: task.listId, action: "UPDATED" }
      });
    }

    const assignees = await prisma.taskAssignee.findMany({
      where: { taskId: id },
      include: { user: { select: { id: true, fullName: true, email: true, avatarUrl: true } } },
    });
    return res.json(assignees.map((a) => a.user));
  } catch (error) {
    for (const userId of userIds) {
      const validation = validateAssigneeAccessMock(id, userId);
      if (!validation.valid) {
        return res.status(403).json({ error: `User ${userId}: ${validation.error}` });
      }
    }

    if (!mockDb.taskAssignees) {
      mockDb.taskAssignees = [];
    }

    mockDb.taskAssignees = mockDb.taskAssignees.filter((ta) => ta.taskId !== id);
    userIds.forEach((userId) => {
      mockDb.taskAssignees.push({ taskId: id, userId });
    });

    const task = mockDb.tasks.find((t) => t.id === id);
    if (task) {
      task.assignees = userIds.map((userId) => ({ userId }));

      await publishEvent("ws:emit", {
        room: "workspace:default-ws",
        event: "task:changed",
        data: { taskId: id, listId: task.listId, action: "UPDATED" }
      });
    }

    const users = userIds
      .map((userId) => {
        const u = mockDb.users.find((user) => user.id === userId);
        return u ? { id: u.id, fullName: u.fullName, email: u.email, avatarUrl: u.avatarUrl } : null;
      })
      .filter(Boolean);
    return res.json(users);
  }
});

const PORT = 3003;
app.listen(PORT, () => {
  console.log(`[Task Service] Running on Port ${PORT}`);
});
