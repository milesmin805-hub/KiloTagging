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
app.use("/clips", express.static("clips"));
app.use(express.json());

// ======================================
// INITIALIZE DATABASE
// ======================================
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pitches (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES sessions(id),
        pitch_type VARCHAR(10),
        zone INTEGER,
        result VARCHAR(50),
        x DECIMAL(5,3),
        y DECIMAL(5,3),
        mph INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS mph INTEGER DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS target_x DECIMAL(5,3) DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS target_y DECIMAL(5,3) DEFAULT NULL;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS clips (
        id UUID PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES sessions(id),
        pitch_id UUID NOT NULL REFERENCES pitches(id),
        url TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Database initialized");
  } catch (err) {
    console.error("Database init error:", err);
  }
}

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
    console.error("Token verify error:", err);
    return null;
  }
}

// ======================================
// AUTH ENDPOINTS
// ======================================
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
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
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

    // Check if user already has a token (reuse it if they do)
    const existingToken = await pool.query(
      "SELECT token FROM users WHERE id = $1",
      [user.id]
    );
    const token = existingToken.rows[0]?.token || generateToken();

    // Only update if we generated a new token
    if (!existingToken.rows[0]) {
      await pool.query("UPDATE users SET token = $1 WHERE id = $2", [token, user.id]);
    }

    res.json({ success: true, token, userId: user.id, email });
  } catch (err) {
    console.error("Login error:", err);
    res.json({ success: false, error: "Login failed" });
  }
});

// ======================================
// SESSION ENDPOINTS
// ======================================
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

app.get("/session/list", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.created_at, s.is_closed, COUNT(p.id) as pitch_count
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

app.get("/session/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
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

    const pitchesResult = await pool.query(
      `SELECT id, pitch_type, zone, result, x, y, mph, created_at
       FROM pitches WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );

    const clipsResult = await pool.query(
      "SELECT pitch_id, url FROM clips WHERE session_id = $1",
      [sessionId]
    );

    const clips = {};
    clipsResult.rows.forEach((clip) => {
      clips[clip.pitch_id] = clip.url;
    });

const pitches = pitchesResult.rows.map((pitch) => {
  let distance = null;
  if (pitch.x !== null && pitch.y !== null && pitch.target_x !== null && pitch.target_y !== null) {
    const pixelDistance = Math.sqrt(
      Math.pow(pitch.x - pitch.target_x, 2) + Math.pow(pitch.y - pitch.target_y, 2)
    );
    const STRIKEZONE_WIDTH_PX = 192;
    const INCHES_PER_PIXEL = 17 / STRIKEZONE_WIDTH_PX;
    distance = Math.round(pixelDistance * INCHES_PER_PIXEL * 10) / 10;
  }
  return {
    id: pitch.id,
    pitchId: pitch.id,
    pitchType: pitch.pitch_type,
    zone: pitch.zone,
    result: pitch.result,
    x: pitch.x,
    y: pitch.y,
    target_x: pitch.target_x,
    target_y: pitch.target_y,
    distance: distance,
    mph: pitch.mph,
    timestamp: new Date(pitch.created_at).getTime()
  };
});

    res.json({
      success: true,
      session: {
        sessionId: session.id,
        name: session.name,
        createdAt: session.created_at,
        closed: session.is_closed,
        pitches,
        clips
      },
      pitches
    });
  } catch (err) {
    console.error("Get session error:", err);
    res.json({ success: false, error: "Failed to get session" });
  }
});

app.post("/session/:sessionId/pitch", async (req, res) => {
  const { sessionId } = req.params;
  const { token, pitch } = req.body;
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

const result = await pool.query(
  `INSERT INTO pitches (id, session_id, pitch_type, zone, result, x, y, target_x, target_y, mph)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
   RETURNING *`,
  [
    pitch.pitchId,
    sessionId,
    pitch.pitchType,
    pitch.zone,
    pitch.result,
    pitch.x,
    pitch.y,
    pitch.target_x || null,
    pitch.target_y || null,
    pitch.mph || null
  ]
);

    const savedPitch = result.rows[0];
    res.json({ 
      success: true, 
      pitch: {
        id: savedPitch.id,
        pitch_type: savedPitch.pitch_type,
        zone: savedPitch.zone,
        result: savedPitch.result,
        mph: savedPitch.mph
      }
    });
  } catch (err) {
    console.error("Save pitch error:", err);
    res.json({ success: false, error: "Failed to save pitch" });
  }
});

app.patch("/session/:sessionId/pitch/:pitchId", async (req, res) => {
  const { sessionId, pitchId } = req.params;
  const { token, updates } = req.body;
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

  const allowedFields = ["pitch_type", "zone", "result", "x", "y", "target_x", "target_y", "mph"];
    const updateClause = [];
    const values = [];
    let paramCount = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        updateClause.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      }
    }

    if (updateClause.length === 0) {
      return res.json({ success: false, error: "No valid fields to update" });
    }

    values.push(pitchId);
    const query = `
      UPDATE pitches 
      SET ${updateClause.join(", ")} 
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.json({ success: false, error: "Pitch not found" });
    }

    console.log("✅ Pitch updated:", pitchId);
    res.json({ success: true, pitch: result.rows[0] });

  } catch (err) {
    console.error("Error updating pitch:", err);
    res.json({ success: false, error: err.message });
  }
});



app.delete("/session/:sessionId/pitch/:pitchId", async (req, res) => {
  const { sessionId, pitchId } = req.params;
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

    await pool.query("DELETE FROM clips WHERE pitch_id = $1", [pitchId]);

    const result = await pool.query(
      "DELETE FROM pitches WHERE id = $1 RETURNING id",
      [pitchId]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, error: "Pitch not found" });
    }

    console.log("✅ Pitch deleted:", pitchId);
    res.json({ success: true });

  } catch (err) {
    console.error("Error deleting pitch:", err);
    res.json({ success: false, error: err.message });
  }
});

app.delete("/session/:sessionId", async (req, res) => {
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

    await pool.query("DELETE FROM clips WHERE session_id = $1", [sessionId]);
    await pool.query("DELETE FROM pitches WHERE session_id = $1", [sessionId]);
    await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);

    console.log("✅ Session deleted:", sessionId);
    res.json({ success: true });

  } catch (err) {
    console.error("Error deleting session:", err);
    res.json({ success: false, error: err.message });
  }
});

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

    console.log("✅ Clip linked:", pitchId);
    res.json({ success: true });
  } catch (err) {
    console.error("Link clip error:", err);
    res.json({ success: false, error: "Failed to link clip" });
  }
});

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

    const sessionResult = await pool.query(
      "SELECT id, name, created_at FROM sessions WHERE id = $1",
      [sessionId]
    );

const pitchesResult = await pool.query(
  `SELECT id, pitch_type, zone, result, x, y, target_x, target_y, mph, created_at
   FROM pitches WHERE session_id = $1 ORDER BY created_at ASC`,
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

  try {
    doc.image(path.join(__dirname, "public/images/kilo-page.png"), 40, 30, { width: 120 });
  } catch (err) {
    console.error("Logo image not found:", err);
  }
  doc.moveDown(2);

  doc.fontSize(24).font("Helvetica-Bold").text("Kilo Baseball Report", { align: "center" });
  doc.fontSize(12).font("Helvetica").text(session.name, { align: "center" });
  doc.fontSize(10)
    .fillColor("#666")
    .text(`Session ID: ${session.sessionId}`, { align: "center" });
  doc.text(`Created: ${new Date(session.createdAt).toLocaleString()}`, { align: "center" });

  doc.moveDown();

  const totalPitches = session.pitches.length;
  const balls = session.pitches.filter((p) => p.result === "Ball").length;
  const strikes = session.pitches.filter(
    (p) => p.result === "Strike" || p.result === "Foul"
  ).length;
  const inPlay = session.pitches.filter((p) => p.result?.includes("Play")).length;

  doc.fontSize(14).font("Helvetica-Bold").text("Session Summary", { underline: true });
  doc.fontSize(11).font("Helvetica").fillColor("#000");
  doc.text(`Total Pitches: ${totalPitches}`);
  doc.text(`Balls: ${balls}`);
  doc.text(`Strikes: ${strikes}`);
  doc.text(`In Play: ${inPlay}`);

  doc.moveDown();

  doc.fontSize(14).font("Helvetica-Bold").text("Pitch Details", { underline: true });
  doc.moveDown(0.5);

const tableTop = doc.y;
doc.fontSize(9).font("Helvetica-Bold")
  .text("#", 50, tableTop)
  .text("Type", 90, tableTop)
  .text("Zone", 140, tableTop)
  .text("Result", 190, tableTop)
  .text("Accuracy", 260, tableTop)
  .text("MPH", 310, tableTop)
  .text("Location", 360, tableTop);

  doc.moveTo(50, tableTop + 18).lineTo(550, tableTop + 18).stroke();

  let yPos = tableTop + 28;

  doc.fontSize(8).font("Helvetica");
  session.pitches.forEach((pitch, index) => {
    if (yPos > 700) {
      doc.addPage();
      yPos = 50;
    }

doc.text(String(index + 1), 50, yPos);
    doc.text(pitch.pitch_type || "—", 90, yPos);
    doc.text(pitch.zone ? String(pitch.zone) : "Ball", 140, yPos);
    doc.text(pitch.result || "—", 190, yPos);

    // Calculate distance
    let distance = "—";
    if (pitch.x !== null && pitch.y !== null && pitch.target_x !== null && pitch.target_y !== null) {
      const pixelDistance = Math.sqrt(
        Math.pow(pitch.x - pitch.target_x, 2) + Math.pow(pitch.y - pitch.target_y, 2)
      );
      const STRIKEZONE_WIDTH_PX = 192;
      const INCHES_PER_PIXEL = 17 / STRIKEZONE_WIDTH_PX;
      distance = (Math.round(pixelDistance * INCHES_PER_PIXEL * 10) / 10) + '"';
    }
    doc.text(distance, 260, yPos);
    doc.text(pitch.mph ? String(pitch.mph) : "—", 310, yPos);

    // Draw strikezone visualization
    drawStrikezonePDF(doc, 360, yPos, 50, 70, pitch.x, pitch.y);

    yPos += 15;
  });

  doc.end();
}

// Helper function to draw strikezone on PDF
function drawStrikezonePDF(doc, x, y, width, height, pitchX, pitchY) {
  // Strikezone border
  doc.rect(x + width * 0.2, y + height * 0.2, width * 0.6, height * 0.6).stroke("#0099FF");

  // Grid lines
  doc.moveTo(x + width * 0.2, y).lineTo(x + width * 0.2, y + height).stroke("#666666");
  doc.moveTo(x + width * 0.8, y).lineTo(x + width * 0.8, y + height).stroke("#666666");
  doc.moveTo(x, y + height * 0.2).lineTo(x + width, y + height * 0.2).stroke("#666666");
  doc.moveTo(x, y + height * 0.8).lineTo(x + width, y + height * 0.8).stroke("#666666");

  // Pitch dot
  if (pitchX !== null && pitchX !== undefined && pitchY !== null && pitchY !== undefined) {
    const dotX = x + pitchX * width;
    const dotY = y + pitchY * height;
    doc.circle(dotX, dotY, 2.5).fill("#FF4444");
  }
}

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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ======================================
// WEBSOCKET - SIMPLIFIED & ROBUST
// ======================================
const clients = {};

wss.on("connection", (ws) => {
  let sessionId = null;
  let deviceType = null;

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }

    if (msg.type === "join-session") {
      sessionId = msg.sessionId;
      deviceType = msg.device;

      if (!clients[sessionId]) {
        clients[sessionId] = {};
      }
      clients[sessionId][deviceType] = ws;

      console.log(`✅ ${deviceType} joined ${sessionId.slice(0, 8)}`);
      
      // TEST: Send hello message to camera after 1 second
      if (deviceType === "camera") {
        setTimeout(() => {
          try {
            ws.send(JSON.stringify({
              type: "hello",
              message: "Server says hello"
            }));
            console.log("📤 Sent HELLO to camera");
          } catch (err) {
            console.error("Failed to send hello:", err);
          }
        }, 1000);
      }
      return;
    }

    if (!sessionId) return;

    // Pitch messages: tagger → camera
    if (msg.type === "pitch-start" || msg.type === "pitch-end" || msg.type === "pitch") {
      const camera = clients[sessionId]?.camera;
      console.log(`🔍 Routing ${msg.type} to camera:`, {
        sessionId: sessionId?.slice(0, 8),
        cameraExists: !!camera,
        cameraReadyState: camera?.readyState,
        availableDevices: Object.keys(clients[sessionId] || {})
      });
      if (camera && camera.readyState === WebSocket.OPEN) {
        camera.send(JSON.stringify(msg));
        console.log(`✅ Routed ${msg.type}`);
      } else {
        console.warn(`❌ Cannot route ${msg.type}: camera not available or not open`);
      }
      return;
    }

    // Clips: camera → tagger
    if (msg.type === "clip") {
      const tagger = clients[sessionId]?.tagger;
      if (tagger && tagger.readyState === WebSocket.OPEN) {
        tagger.send(JSON.stringify(msg));
        console.log(`✅ Clip routed to tagger`);
      }
      return;
    }

    // Velocity: camera → tagger
// Velocity: camera → tagger
    if (msg.type === "velocity") {
      const tagger = clients[sessionId]?.tagger;
      if (tagger && tagger.readyState === WebSocket.OPEN) {
        tagger.send(JSON.stringify(msg));
      }
    }

    // Count updates: tagger → camera
    if (msg.type === "count-update") {
      const camera = clients[sessionId]?.camera;
      if (camera && camera.readyState === WebSocket.OPEN) {
        camera.send(JSON.stringify(msg));
      }
      return;
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    if (sessionId && clients[sessionId]) {
      delete clients[sessionId][deviceType];
      if (Object.keys(clients[sessionId]).length === 0) {
        delete clients[sessionId];
      }
      console.log(`❌ ${deviceType} disconnected`);
    }
  });
});

// ======================================
// START SERVER
// ======================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔥 Kilo Baseball Server running on port ${PORT}`);
});