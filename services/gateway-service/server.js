// backend/services/gateway-service/server.js
const express = require("express");
const http = require("http");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: true,
  credentials: true
}));

const SERVICES = {
  "/api/auth": 3001,
  "/api/workspaces": 3002,
  "/api/tasks": 3003,
  "/api/dashboard": 3003,
  "/api/extra": 3005,
  "/api/chat": 3006,
  "/chat/uploads": 3006,
};

// Route HTTP API requests to their respective microservices
app.use((req, res) => {
  const matchedPrefix = Object.keys(SERVICES).find(prefix => req.path.startsWith(prefix));
  if (!matchedPrefix) {
    return res.status(404).json({ error: `Route not found on API Gateway: ${req.path}` });
  }

  const port = SERVICES[matchedPrefix];
  
  const options = {
    hostname: "localhost",
    port: port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  console.log(`[Gateway Proxy] ${req.method} ${req.path} -> Forwarding to Port ${port}`);

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error(`[Gateway Proxy Error] Target service on Port ${port} is offline.`, err.message);
    res.status(502).json({ error: `Bad Gateway: Target service on Port ${port} is offline.` });
  });

  req.pipe(proxyReq);
});

// Native WebSocket forwarding to realtime-service on Port 3004 or chat-service on Port 3006
server.on("upgrade", (req, socket, head) => {
  const isSocketIo = req.url.startsWith("/socket.io");
  const targetPort = isSocketIo ? 3006 : 3004;
  console.log(`[Gateway WebSocket] Forwarding socket connection to Port ${targetPort}`);

  const options = {
    hostname: "localhost",
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options);
  
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
                 Object.keys(proxyRes.headers).map(key => `${key}: ${proxyRes.headers[key]}`).join("\r\n") +
                 "\r\n\r\n");
                 
    proxySocket.on("error", (err) => {
      console.log(`[Gateway WebSocket proxySocket error]:`, err.message);
      socket.end();
    });
    
    socket.on("error", (err) => {
      console.log(`[Gateway WebSocket client socket error]:`, err.message);
      proxySocket.end();
    });

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on("error", (err) => {
    console.error(`[Gateway WebSocket Error] Target service on Port ${targetPort} is offline.`, err.message);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  proxyReq.end();
});

// Process-wide crash protection
process.on("uncaughtException", (err) => {
  console.error("[Gateway Uncaught Exception]:", err.message || err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Gateway Unhandled Rejection at]:", promise, "reason:", reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`📡 WaveWork.ai Gateway running on Port ${PORT}`);
  console.log(`⚡ Directing traffic to Services on Ports 3001-3005`);
  console.log(`========================================`);
});
