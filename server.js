// ======================================
// KILO BASEBALL - POSTGRES VERSION
// ======================================
const express = require("express");
const app = express();
const http = require("http");
const server = http.createServer(app);
const WebSocket = require("ws");
const wss = new WebSocket.Server({ server });
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const { Pool } = require("pg");

// ======================================
// DATABASE CONNECTION
// ======================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

// ======================================
// MIDDLEWARE
// ======================================
app.use(express.static("public"));
// Serve clip files
app.use("/clips", express.static("clips"));
app.use(express.json());

// ======================================
// INITIALIZE DATABASE
// ======================================
async function initializeDatabase() {
  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create sessions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMP,
        is_closed BOOLEAN DEFAULT FALSE
      );
    `);

    // Create pitches table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitches (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES sessions(id),
        pitch_type VARCHAR(10),
        zone INTEGER,
        result VARCHAR(50),
        x DECIMAL(5,3),
        y DECIMAL(5,3),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create clips table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clips (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES sessions(id),
        pitch_id UUID NOT NULL REFERENCES pitches(id),
        url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Database initialized successfully");
  } catch (err) {
    console.error("Database initialization error:", err);
  }
}

// Initialize on startup
initializeDatabase();

// ======================================
// HELPER FUNCTIONS
// ======================================
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

async function verifyToken(token) {
  try {
    const result = await pool.query(
      "SELECT id, email FROM users WHERE token = $1",
      [token]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error("Token verification error:", err);
    return null;
  }
}

// ======================================
// AUTH ENDPOINTS
// ======================================

// SIGNUP
app.post("/auth/signup", async (req, res) => {
  const { email, password, confirmPassword } = req.body;

  if (!email || !password || !confirmPassword) {
    return res.json({ success: false, error: "Missing fields" });
  }

  if (password !== confirmPassword) {
    return res.json({ success: false, error: "Passwords don't match" });
  }

  if (password.length < 6) {
    return res.json({ success: false, error: "Password too short" });
  }

  try {
    // Check if user exists
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.json({ success: false, error: "Email already exists" });
    }

    const userId = crypto.randomUUID();
    const token = generateToken();
    const passwordHash = hashPassword(password);

    await pool.query(
      "INSERT INTO users (id, email, password_hash, token) VALUES ($1, $2, $3, $4)",
      [userId, email, passwordHash, token]
    );

    res.json({ success: true, token, userId, email });
  } catch (err) {
    console.error("Signup error:", err);
    res.json({ success: false, error: "Signup failed" });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, error: "Missing fields" });
  }

  try {
    const result = await pool.query(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, error: "Invalid credentials" });
    }

    const user = result.rows[0];
    const passwordHash = hashPassword(password);

    if (user.password_hash !== passwordHash) {
      return res.json({ success: false, error: "Invalid credentials" });
    }

    const token = generateToken();
    await pool.query("UPDATE users SET token = $1 WHERE id = $2", [token, user.id]);

    res.json({ success: true, token, userId: user.id, email });
  } catch (err) {
    console.error("Login error:", err);
    res.json({ success: false, error: "Login failed" });
  }
});

// ======================================
// SESSION ENDPOINTS
// ======================================

// CREATE SESSION
app.post("/session/create", async (req, res) => {
  const { token, name } = req.body;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const sessionId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO sessions (id, user_id, name) VALUES ($1, $2, $3)",
      [sessionId, user.id, name || `Session ${new Date().toLocaleDateString()}`]
    );

    res.json({ success: true, sessionId });
  } catch (err) {
    console.error("Create session error:", err);
    res.json({ success: false, error: "Failed to create session" });
  }
});

// LIST USER SESSIONS
app.get("/session/list", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.created_at, s.is_closed,
              COUNT(p.id) as pitch_count
       FROM sessions s
       LEFT JOIN pitches p ON s.id = p.session_id
       WHERE s.user_id = $1
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [user.id]
    );

    const sessions = result.rows.map((row) => ({
      sessionId: row.id,
      name: row.name,
      createdAt: row.created_at,
      closed: row.is_closed,
      pitches: Array(row.pitch_count).fill({})
    }));

    res.json({ success: true, sessions });
  } catch (err) {
    console.error("List sessions error:", err);
    res.json({ success: false, error: "Failed to list sessions" });
  }
});

// GET SESSION DETAILS
app.get("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const sessionResult = await pool.query(
      "SELECT id, name, created_at, is_closed FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );

    if (sessionResult.rows.length === 0) {
      return res.json({ success: false, error: "Session not found" });
    }

    const session = sessionResult.rows[0];

    // Get pitches
    const pitchesResult = await pool.query(
      `SELECT id, pitch_type, zone, result, x, y, created_at
       FROM pitches WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );

    // Get clips
    const clipsResult = await pool.query(
      "SELECT pitch_id, url FROM clips WHERE session_id = $1",
      [sessionId]
    );

    const clips = {};
    clipsResult.rows.forEach((clip) => {
      clips[clip.pitch_id] = clip.url;
    });

    const pitches = pitchesResult.rows.map((pitch) => ({
      pitchId: pitch.id,
      pitchType: pitch.pitch_type,
      zone: pitch.zone,
      result: pitch.result,
      x: pitch.x,
      y: pitch.y,
      timestamp: new Date(pitch.created_at).getTime()
    }));

    res.json({
      success: true,
      session: {
        sessionId: session.id,
        name: session.name,
        createdAt: session.created_at,
        closed: session.is_closed,
        pitches,
        clips
      }
    });
  } catch (err) {
    console.error("Get session error:", err);
    res.json({ success: false, error: "Failed to get session" });
  }
});

// SAVE PITCH TO SESSION
app.post("/session/:sessionId/pitch", async (req, res) => {
  const { sessionId } = req.params;
  const { token, pitch } = req.body;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    // Verify session belongs to user
    const sessionCheck = await pool.query(
      "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.json({ success: false, error: "Session not found" });
    }

    await pool.query(
      `INSERT INTO pitches (id, session_id, pitch_type, zone, result, x, y)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        pitch.pitchId,
        sessionId,
        pitch.pitchType,
        pitch.zone,
        pitch.result,
        pitch.x,
        pitch.y
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Save pitch error:", err);
    res.json({ success: false, error: "Failed to save pitch" });
  }
});

// LINK CLIP TO PITCH
app.post("/session/:sessionId/link-clip", async (req, res) => {
  const { sessionId } = req.params;
  const { token, pitchId, clipUrl } = req.body;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const sessionCheck = await pool.query(
      "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.json({ success: false, error: "Session not found" });
    }

    const clipId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO clips (id, session_id, pitch_id, url) VALUES ($1, $2, $3, $4)",
      [clipId, sessionId, pitchId, clipUrl]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Link clip error:", err);
    res.json({ success: false, error: "Failed to link clip" });
  }
});

// CLOSE SESSION
app.post("/session/:sessionId/close", async (req, res) => {
  const { sessionId } = req.params;
  const { token } = req.body;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const sessionCheck = await pool.query(
      "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.json({ success: false, error: "Session not found" });
    }

    await pool.query(
      "UPDATE sessions SET is_closed = TRUE, closed_at = CURRENT_TIMESTAMP WHERE id = $1",
      [sessionId]
    );

    // Get session data for PDF
    const sessionResult = await pool.query(
      "SELECT id, name, created_at FROM sessions WHERE id = $1",
      [sessionId]
    );

    const pitchesResult = await pool.query(
      "SELECT id, pitch_type, zone, result FROM pitches WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId]
    );

    const clipsResult = await pool.query(
      "SELECT pitch_id FROM clips WHERE session_id = $1",
      [sessionId]
    );

    const session = {
      sessionId: sessionResult.rows[0].id,
      name: sessionResult.rows[0].name,
      createdAt: sessionResult.rows[0].created_at,
      pitches: pitchesResult.rows,
      clips: clipsResult.rows
    };

    // Generate PDF
    generateSessionPDF(session);

    res.json({ success: true });
  } catch (err) {
    console.error("Close session error:", err);
    res.json({ success: false, error: "Failed to close session" });
  }
});

// ======================================
// PDF GENERATION
// ======================================
function generateSessionPDF(session) {
  const pdfPath = path.join(__dirname, "pdfs", `${session.sessionId}.pdf`);

  if (!fs.existsSync(path.join(__dirname, "pdfs"))) {
    fs.mkdirSync(path.join(__dirname, "pdfs"), { recursive: true });
  }

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const stream = fs.createWriteStream(pdfPath);

  doc.pipe(stream);

  // Header
  doc.fontSize(24).font("Helvetica-Bold").text("Kilo Baseball Report", { align: "center" });
  doc.fontSize(12).font("Helvetica").text(session.name, { align: "center" });
  doc.fontSize(10)
    .fillColor("#666")
    .text(`Session ID: ${session.sessionId}`, { align: "center" });
  doc.text(`Created: ${new Date(session.createdAt).toLocaleString()}`, { align: "center" });

  doc.moveDown();

  // Summary Stats
  const totalPitches = session.pitches.length;
  const balls = session.pitches.filter((p) => p.result === "Ball").length;
  const strikes = session.pitches.filter(
    (p) => p.result === "Strike" || p.result === "Foul"
  ).length;
  const inPlay = session.pitches.filter((p) => p.result === "In Play").length;

  doc.fontSize(14).font("Helvetica-Bold").text("Session Summary", { underline: true });
  doc.fontSize(11).font("Helvetica").fillColor("#000");
  doc.text(`Total Pitches: ${totalPitches}`);
  doc.text(`Balls: ${balls}`);
  doc.text(`Strikes: ${strikes}`);
  doc.text(`In Play: ${inPlay}`);

  doc.moveDown();

  // Pitches Table
  doc.fontSize(14).font("Helvetica-Bold").text("Pitch Details", { underline: true });
  doc.moveDown(0.3);

  // Table Header
  doc.fontSize(10).font("Helvetica-Bold");
  doc.text("#", 50, doc.y, { width: 30 });
  doc.text("Type", 85, doc.y - 15, { width: 50 });
  doc.text("Zone", 140, doc.y - 15, { width: 40 });
  doc.text("Result", 185, doc.y - 15, { width: 60 });
  doc.text("Clip", 250, doc.y - 15, { width: 100 });

  doc.moveTo(50, doc.y).lineTo(500, doc.y).stroke();
  doc.moveDown();

  // Table Rows
  doc.fontSize(9).font("Helvetica");
  session.pitches.forEach((pitch, index) => {
    const hasClip = session.clips.some((c) => c.pitch_id === pitch.id);
    const clipUrl = hasClip ? "✓ Video" : "—";

    doc.text(String(index + 1), 50, doc.y, { width: 30 });
    doc.text(pitch.pitch_type || "—", 85, doc.y - 15, { width: 50 });
    doc.text(pitch.zone || "Ball", 140, doc.y - 15, { width: 40 });
    doc.text(pitch.result || "—", 185, doc.y - 15, { width: 60 });
    doc.text(clipUrl, 250, doc.y - 15, { width: 100 });

    doc.moveDown();

    if (doc.y > 700) {
      doc.addPage();
    }
  });

  doc.end();
}

// DOWNLOAD PDF
app.get("/session/:sessionId/download-pdf", async (req, res) => {
  const { sessionId } = req.params;
  const token = req.headers.authorization?.split(" ")[1];
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const sessionCheck = await pool.query(
      "SELECT name FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.json({ success: false, error: "Session not found" });
    }

    const pdfPath = path.join(__dirname, "pdfs", `${sessionId}.pdf`);

    if (!fs.existsSync(pdfPath)) {
      return res.json({ success: false, error: "PDF not found" });
    }

    res.download(pdfPath, `${sessionCheck.rows[0].name}.pdf`);
  } catch (err) {
    console.error("Download PDF error:", err);
    res.json({ success: false, error: "Failed to download PDF" });
  }
});

// ======================================
// FILE UPLOADS
// ======================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "clips");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

// ======================================
// STATIC ROUTES
// ======================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ======================================
// WEBSOCKET SESSIONS
// ======================================
const wsConnections = {}; // sessionId → [ws connections]

wss.on("connection", (ws) => {
  let sessionId = null;
  let userId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Join session
    if (msg.type === "join-session") {
      sessionId = msg.sessionId;
      userId = msg.userId;

      if (!wsConnections[sessionId]) {
        wsConnections[sessionId] = [];
      }
      wsConnections[sessionId].push(ws);

      // Notify other devices
      broadcast(sessionId, {
        type: "device-joined",
        device: msg.device,
        userId
      });
      return;
    }

    // Broadcast to other devices in same session
    if (
      msg.type === "pitch-start" ||
      msg.type === "pitch-end" ||
      msg.type === "pitch" ||
      msg.type === "clip"
    ) {
      broadcast(sessionId, msg);
      return;
    }
  });

  ws.on("close", () => {
    if (sessionId && wsConnections[sessionId]) {
      wsConnections[sessionId] = wsConnections[sessionId].filter((c) => c !== ws);
    }
  });
});

function broadcast(sessionId, msg) {
  const data = JSON.stringify(msg);
  if (wsConnections[sessionId]) {
    wsConnections[sessionId].forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }
}

// ======================================
// START SERVER
// ======================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔥 Kilo Baseball Server running on port ${PORT}`);
});