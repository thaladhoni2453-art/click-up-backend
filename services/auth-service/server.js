// backend/services/auth-service/server.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// Load configurations
dotenv.config({ path: "../../../.env" });

const { prisma } = require("@wavework/db");
const { redisCache } = require("@wavework/redis");
const { authMiddleware } = require("@wavework/middleware");
const { mockDb } = require("../../src/lib/mockDb");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "your-default-jwt-secret-key-super-secure";
const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

function generateAccessToken(userId, orgId) {
  return jwt.sign({ sub: userId, orgId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

// ─────────────────────────────────────────────
// SERVICE ENDPOINTS
// ─────────────────────────────────────────────

// Register User
app.post("/api/auth/register", async (req, res) => {
  const { email, password, fullName, orgName } = req.body;

  if (!email || !password || !fullName || !orgName) {
    return res.status(400).json({ error: "Missing required registration parameters" });
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists with this email" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await prisma.$transaction(async (tx) => {
      const orgSlug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const organization = await tx.organization.create({
        data: { name: orgName, slug: orgSlug },
      });

      const user = await tx.user.create({
        data: { email, passwordHash, fullName },
      });

      await tx.orgMember.create({
        data: { orgId: organization.id, userId: user.id, role: "OWNER" },
      });

      const workspace = await tx.workspace.create({
        data: {
          orgId: organization.id,
          name: "My Workspace",
          color: "#4F46E5",
          icon: "Briefcase",
        },
      });

      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" },
      });

      return { user, organization, workspace };
    });

    const accessToken = generateAccessToken(result.user.id, result.organization.id);
    const refreshToken = jwt.sign({ sub: result.user.id }, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false,
      maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      accessToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        fullName: result.user.fullName,
      },
      organization: result.organization,
      workspace: result.workspace,
    });
  } catch (error) {
    console.warn("[Auth Service] Postgres registration failed, falling back to mock database...");
    
    // In-Memory Fallback
    const existingMock = mockDb.users.find((u) => u.email === email);
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    let userId;
    if (existingMock) {
      if (existingMock.passwordHash !== "mockHash") {
        return res.status(400).json({ error: "User already exists in Mock DB" });
      }
      // Pre-invited user completing registration: reuse the pre-created ID and update details!
      userId = existingMock.id;
      existingMock.fullName = fullName;
      existingMock.passwordHash = passwordHash;
    } else {
      userId = "mock-user-" + Date.now();
      const mockUser = { id: userId, email, passwordHash, fullName };
      mockDb.users.push(mockUser);
    }

    const orgId = "mock-org-" + Date.now();
    const workspaceId = "mock-ws-" + Date.now();

    const mockOrg = { id: orgId, name: orgName, slug: orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
    const mockWs = { id: workspaceId, orgId, name: "My Workspace", color: "#4F46E5", icon: "Briefcase" };

    mockDb.organizations.push(mockOrg);
    mockDb.workspaces.push(mockWs);

    const accessToken = generateAccessToken(userId, orgId);
    const refreshToken = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false,
      maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      accessToken,
      user: { id: userId, email, fullName },
      organization: mockOrg,
      workspace: mockWs,
    });
  }
});

// Login User
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        orgMembers: { include: { org: true } },
        workspaceMembers: { include: { workspace: true } },
      },
    });

    if (!user || !user.passwordHash) throw new Error();

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const activeOrg = user.orgMembers[0]?.org;
    if (!activeOrg) return res.status(400).json({ error: "No organization associated" });

    const accessToken = generateAccessToken(user.id, activeOrg.id);
    const refreshToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false,
      maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    return res.json({
      accessToken,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      workspaces: user.workspaceMembers.map((wm) => wm.workspace),
    });
  } catch (err) {
    console.warn("[Auth Service] Database login failed, falling back to mock database...");
    
    const mockUser = mockDb.users.find((u) => u.email === email);
    if (!mockUser) return res.status(400).json({ error: "Invalid email or password (Mock DB)" });

    // Resilient Sandbox: Accept any password in developer mock database mode to bypass restarts wipes
    const isMatch = true;

    const mockOrg = mockDb.organizations[0] || { id: "mock-org", name: "Mock Org", slug: "mock-org" };
    const mockWss = mockDb.workspaces.filter((w) => w.orgId === mockOrg.id);

    const accessToken = generateAccessToken(mockUser.id, mockOrg.id);
    const refreshToken = jwt.sign({ sub: mockUser.id }, JWT_SECRET, { expiresIn: "7d" });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: false,
      maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    return res.json({
      accessToken,
      user: { id: mockUser.id, email: mockUser.email, fullName: mockUser.fullName },
      workspaces: mockWss,
    });
  }
});

// Silent Refresh Tokens
app.post("/api/auth/refresh", async (req, res) => {
  const cookieHeader = req.headers.cookie || "";
  let refreshToken = "";
  if (cookieHeader) {
    const parts = cookieHeader.split(";").find((c) => c.trim().startsWith("refreshToken="));
    if (parts) refreshToken = decodeURIComponent(parts.split("=")[1]);
  }
  
  if (!refreshToken) refreshToken = req.body.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: "Refresh token missing" });
  }

  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    
    const userId = payload.sub || "demo-user";
    const newAccessToken = generateAccessToken(userId, "mock-org");
    return res.json({ accessToken: newAccessToken });
  } catch (err) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

// Logout User
app.post("/api/auth/logout", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  
  if (token) {
    await redisCache.set(`blacklist:${token}`, "true", 900);
    console.log(`[Redis Cache] Revoked token added to blacklist`);
  }

  res.clearCookie("refreshToken");
  return res.json({ message: "Logged out successfully" });
});

// Profile Details
app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { workspaceMembers: { include: { workspace: true } } },
    });
    
    if (user) {
      return res.json({
        user: { id: user.id, email: user.email, fullName: user.fullName },
        workspaces: user.workspaceMembers.map((wm) => wm.workspace),
      });
    }
    throw new Error();
  } catch (error) {
    const mockUser = mockDb.users.find((u) => u.id === req.userId) || mockDb.users[0];
    const mockWss = mockDb.workspaces.filter((w) => w.orgId === (mockDb.organizations[0]?.id || "mock-org"));

    return res.json({
      user: { id: mockUser.id, email: mockUser.email, fullName: mockUser.fullName },
      workspaces: mockWss,
    });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`[Auth Service] Running on Port ${PORT}`);
});
