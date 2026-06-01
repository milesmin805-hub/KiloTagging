// -------------------------------
// BASIC SETUP
// -------------------------------
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const WebSocket = require("ws");
const wss = new WebSocket.Server({ server });
const path = require("path");
const multer = require("multer");
const fs = require("fs");

// -------------------------------
// STATIC FILES (IMPORTANT)
// -------------------------------
app.use(express.static(__dirname));   // Serve everything in project root
app.use(express.json());

// -------------------------------
// SESSION STORE (NO WARNING)
// -------------------------------
const session = require("express-session");
const FileStore = require("session-file-store")(session);

app.use(session({
  store: new FileStore(),
  secret: "super-secret-key",
  resave: false,
  saveUninitialized: false
}));

// -------------------------------
// DEVICE REGISTRY
// -------------------------------
const devices = {};   // deviceId → ws connection

function broadcast(msg) {
  const data = JSON.stringify(msg);
  Object.values(devices).forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

// -------------------------------
// WEBSOCKET HANDLING
// -------------------------------
wss.on("connection", (ws) => {
  let deviceId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // DEVICE IDENTIFICATION
    if (msg.type === "identify") {
      deviceId = msg.deviceId || Math.random().toString(36).slice(2);
      devices[deviceId] = ws;

      ws.send(JSON.stringify({ type: "identified", deviceId }));
      broadcast({ type: "device-joined", deviceId, device: msg.device });
      return;
    }

    // FORWARD MESSAGES TO ALL DEVICES
    if (msg.type === "pitch-start") {
      broadcast(msg); // device-manager will forward to cameras
      return;
    }

    if (msg.type === "startClip" || msg.type === "stopClip") {
      broadcast(msg);
      return;
    }

    if (msg.type === "clip") {
      broadcast(msg); // tagger receives clip-attached
      return;
    }
  });

  ws.on("close", () => {
    if (deviceId && devices[deviceId]) {
      delete devices[deviceId];
      broadcast({ type: "device-left", deviceId });
    }
  });
});

// -------------------------------
// FILE UPLOADS (CLIPS)
// -------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "clips");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const name = Date.now() + ".webm";
    cb(null, name);
  }
});

const upload = multer({ storage });

app.post("/uploadClip", upload.single("clip"), (req, res) => {
  const url = "/clips/" + req.file.filename;
  res.json({ url });
});

// -------------------------------
// HTML ROUTES
// -------------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/tagging", (req, res) => {
  res.sendFile(path.join(__dirname, "tagging.html"));
});

app.get("/camera", (req, res) => {
  res.sendFile(path.join(__dirname, "camera.html"));
});

app.get("/device-manager", (req, res) => {
  res.sendFile(path.join(__dirname, "device-manager.html"));
});

// -------------------------------
// START SERVER
// -------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});