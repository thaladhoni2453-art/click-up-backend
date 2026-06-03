// backend/src/launcher.js
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// One-time dependency installer and database migrator bootstrap
const lockFilePath = path.resolve(__dirname, "..", "install_lock_v2.json");
if (!fs.existsSync(lockFilePath)) {
  const { execSync } = require("child_process");
  console.log("🌊 [WaveWork Boot] Workspace packages installation & database migrations initiating...");
  try {
    console.log("🌊 [WaveWork Boot] Installing and linking all workspace dependencies...");
    execSync("npm install", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });

    console.log("🌊 [WaveWork Boot] Installing frontend dependencies...");
    execSync("npm install @livekit/components-react @livekit/components-styles livekit-client", { cwd: path.resolve(__dirname, "..", "..", "frontend"), stdio: "inherit" });

    console.log("🌊 [WaveWork Boot] Running Prisma migrations...");
    execSync("npx prisma migrate dev --name add_chat_and_calls", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });

    fs.writeFileSync(lockFilePath, JSON.stringify({ installedAt: new Date().toISOString() }));
    console.log("🌊 [WaveWork Boot] Installation and migrations completed successfully!");
  } catch (err) {
    console.error("❌ [WaveWork Boot] Installation / Migration failed: ", err.message);
  }
}

const SERVICES = [
  { name: "Gateway", dir: "gateway-service" },
  { name: "Auth", dir: "auth-service" },
  { name: "Workspace", dir: "workspace-service" },
  { name: "Task", dir: "task-service" },
  { name: "Realtime", dir: "realtime-service" },
  { name: "Extra", dir: "extra-service" },
  { name: "Chat", dir: "chat-service" }
];

console.log(`========================================`);
console.log(`🌊 WaveWork.ai Microservices Master Boot (JS Mode)`);
console.log(`========================================`);

SERVICES.forEach((service) => {
  const servicePath = path.resolve(__dirname, "..", "services", service.dir);

  const isProd = process.env.NODE_ENV === "production";
  const cmd = isProd ? "node" : "npx";
  const args = isProd ? ["server.js"] : ["nodemon", "--quiet", "server.js"];

  const proc = spawn(cmd, args, {
    cwd: servicePath,
    shell: true,
    env: { ...process.env, PORT: "" }
  });

  proc.stdout.on("data", (data) => {
    const lines = data.toString().trim().split("\n");
    lines.forEach((line) => {
      if (line) console.log(`[${service.name}] ${line}`);
    });
  });

  proc.stderr.on("data", (data) => {
    const lines = data.toString().trim().split("\n");
    lines.forEach((line) => {
      if (line) console.error(`[${service.name} Error] ${line}`);
    });
  });

  proc.on("close", (code) => {
    console.log(`[${service.name}] Process exited with code ${code}`);
  });
});
