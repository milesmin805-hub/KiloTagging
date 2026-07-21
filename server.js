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
const ffmpeg = require("fluent-ffmpeg");

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

// ===== KERNEL DENSITY ESTIMATION (KDE) =====
function calculateKDE(points, gridSize = 40) {
  if (points.length < 2) return null;

  // Create grid
  const xMin = -2, xMax = 2;
  const yMin = 0, yMax = 5;
  const xStep = (xMax - xMin) / gridSize;
  const yStep = (yMax - yMin) / gridSize;

  const grid = [];
  const densities = [];

  // Calculate bandwidth (Silverman's rule)
  const n = points.length;
  const h = Math.pow(4 / (n * 3), 1 / 5); // Scott's rule simplified

  // Evaluate KDE at grid points
  for (let i = 0; i <= gridSize; i++) {
    for (let j = 0; j <= gridSize; j++) {
      const x = xMin + i * xStep;
      const y = yMin + j * yStep;

      let density = 0;
      points.forEach(p => {
        const dx = (p.x - x) / h;
        const dy = (p.y - y) / h;
        // Gaussian kernel
        density += Math.exp(-(dx * dx + dy * dy) / 2);
      });
      density /= (n * h * h);

      grid.push({ x, y });
      densities.push(density);
    }
  }

  return { grid, densities, gridSize, xMin, xMax, yMin, yMax };
}

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
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS clip_start_time BIGINT DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS clip_end_time BIGINT DEFAULT NULL;
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
  `SELECT p.id, p.pitch_type, p.zone, p.result, p.x, p.y, p.target_x, p.target_y, p.mph, p.created_at, p.pitcher_id, pi.name as pitcher_name
   FROM pitches p
   LEFT JOIN pitchers pi ON p.pitcher_id = pi.id
   WHERE p.session_id = $1 
   ORDER BY p.created_at ASC`,
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
    const STRIKEZONE_WIDTH_PX = 192;
    const INCHES_PER_PIXEL = 17 / STRIKEZONE_WIDTH_PX;
    const pixelDistance = Math.sqrt(
      Math.pow((pitch.x - pitch.target_x) * STRIKEZONE_WIDTH_PX, 2) + 
      Math.pow((pitch.y - pitch.target_y) * STRIKEZONE_WIDTH_PX, 2)
    );
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
    clip_start_time: pitch.clip_start_time,
    clip_end_time: pitch.clip_end_time,
    distance: distance,
    mph: pitch.mph,
    timestamp: new Date(pitch.created_at).getTime(),
    pitcher_id: pitch.pitcher_id,
    pitcher_name: pitch.pitcher_name
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

app.post("/session/:sessionId/close", async (req, res) => {
  const { sessionId } = req.params;
  const { token } = req.body;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const sessionCheck = await pool.query(
      "SELECT id, name FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.json({ success: false, error: "Session not found" });
    }

    // Get pitches for PDF
    const pitchesResult = await pool.query(
      "SELECT * FROM pitches WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId]
    );

    // Update session status
    await pool.query(
      "UPDATE sessions SET is_closed = TRUE, closed_at = CURRENT_TIMESTAMP WHERE id = $1",
      [sessionId]
    );

    // Generate PDF
    const session = {
      sessionId,
      name: sessionCheck.rows[0].name,
      createdAt: sessionCheck.rows[0].created_at,
      pitches: pitchesResult.rows
    };

  await generateSessionPDF(session);

    res.json({ success: true, message: "Session closed." });

  } catch (err) {
    console.error("Close session error:", err);
    res.json({ success: false, error: "Failed to close session" });
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
  `INSERT INTO pitches (id, session_id, pitch_type, zone, result, x, y, target_x, target_y, clip_start_time, clip_end_time, mph, balls, strikes, spin_rate, ivb, hb, batter_handedness, pitch_outcome_details, exit_velocity, pitcher_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
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
    pitch.clip_start_time || null,
    pitch.clip_end_time || null,
    pitch.mph || null,
    pitch.balls || 0,
    pitch.strikes || 0,
    pitch.spin_rate || null,
    pitch.ivb || null,
    pitch.hb || null,
    pitch.batter_handedness || null,
    pitch.pitch_outcome_details || null,
    pitch.exit_velocity || null,
    pitch.pitcher_id || null
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
  .text("#", 50, tableTop, { width: 40, align: "center" })
  .text("Type", 95, tableTop, { width: 50, align: "center" })
  .text("Zone", 150, tableTop, { width: 50, align: "center" })
  .text("Result", 205, tableTop, { width: 60, align: "center" })
  .text("Accuracy", 270, tableTop, { width: 50, align: "center" })
  .text("MPH", 325, tableTop, { width: 50, align: "center" });

doc.moveTo(50, tableTop + 18).lineTo(520, tableTop + 18).stroke();

let yPos = tableTop + 28;

doc.fontSize(8).font("Helvetica");
session.pitches.forEach((pitch, index) => {
  if (yPos > 700) {
    doc.addPage();
    yPos = 50;
  }

  doc.text(String(index + 1), 50, yPos, { width: 40, align: "center" });
  doc.text(pitch.pitch_type || "—", 95, yPos, { width: 50, align: "center" });
  doc.text(pitch.zone ? String(pitch.zone) : "Ball", 150, yPos, { width: 50, align: "center" });
  doc.text(pitch.result || "—", 205, yPos, { width: 60, align: "center" });

  // Calculate distance
  let distance = "—";
  if (pitch.x !== null && pitch.y !== null && pitch.target_x !== null && pitch.target_y !== null) {
    const STRIKEZONE_WIDTH_PX = 192;
    const INCHES_PER_PIXEL = 17 / STRIKEZONE_WIDTH_PX;
    const pixelDistance = Math.sqrt(
      Math.pow((pitch.x - pitch.target_x) * STRIKEZONE_WIDTH_PX, 2) + 
      Math.pow((pitch.y - pitch.target_y) * STRIKEZONE_WIDTH_PX, 2)
    );
    distance = (Math.round(pixelDistance * INCHES_PER_PIXEL * 10) / 10) + '"';
  }
  doc.text(distance, 270, yPos, { width: 50, align: "center" });
  doc.text(pitch.mph ? String(pitch.mph) : "—", 325, yPos, { width: 50, align: "center" });

yPos += 10;
});

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      console.log("✅ PDF generated:", session.sessionId);
      resolve();
    });

    stream.on('error', (err) => {
      console.error("PDF generation error:", err);
      reject(err);
    });

    doc.end();
  });
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
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);

  if (!user) {
    return res.status(401).json({ success: false, error: "Invalid token" });
  }

  try {
    const sessionCheck = await pool.query(
      "SELECT name FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );

    if (sessionCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: "Session not found" });
    }

    const pdfPath = path.join(__dirname, "pdfs", `${sessionId}.pdf`);
    console.log("Checking PDF at:", pdfPath);

    if (!fs.existsSync(pdfPath)) {
      console.error("PDF file not found:", pdfPath);
      return res.status(404).json({ success: false, error: "PDF not found" });
    }

    res.download(pdfPath, `${sessionCheck.rows[0].name}.pdf`, (err) => {
      if (err) {
        console.error("Download error:", err);
        res.status(500).json({ success: false, error: "Download failed" });
      }
    });
  } catch (err) {
    console.error("Download PDF error:", err);
    res.status(500).json({ success: false, error: "Failed to download PDF" });
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
  const webmPath = req.file.path;
  const mp4Filename = req.file.filename.replace(".webm", ".mp4");
  const mp4Path = path.join(__dirname, "clips", mp4Filename);

  // Convert WebM to MP4
  ffmpeg(webmPath)
    .output(mp4Path)
    .on("end", () => {
      // Delete the WebM file after conversion
      fs.unlinkSync(webmPath);
      console.log("✅ Converted to MP4:", mp4Filename);
      res.json({ url: "/clips/" + mp4Filename });
    })
    .on("error", (err) => {
      console.error("FFmpeg error:", err);
      res.json({ success: false, error: err.message });
    })
    .run();
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

    res.json({ success: true, clipId });
  } catch (err) {
    console.error("Link clip error:", err);
    res.json({ success: false, error: "Failed to link clip" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ======================================
// CSV UPLOAD & PARSING
// ======================================
const csv = require("csv-parse/sync");

app.post("/upload-csv", upload.single("csv"), async (req, res) => {
  const file = req.file;
  const { sessionId, token } = req.body;

   if (!file) {
    return res.json({ success: false, error: "No file received - check upload" });
  }

  // Auth check
  const user = await verifyToken(token);
  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  // Validate session belongs to user
  const sessionCheck = await pool.query(
    "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
    [sessionId, user.id]
  );
  if (sessionCheck.rows.length === 0) {
    return res.json({ success: false, error: "Session not found" });
  }

  try {
    // Parse CSV
    const fs = require("fs");
    const fileContent = fs.readFileSync(file.path, "utf8");
    const records = csv.parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    if (records.length === 0) {
      return res.json({ success: false, error: "CSV is empty" });
    }

    const pitchers = new Map(); // Track unique pitchers
    const pitchesToInsert = [];

    // Process each record
    for (const record of records) {
      const pitcherName = record.Pitcher?.trim();
      const pitcherTeam = record.PitcherTeam?.trim();

      if (!pitcherName) continue; // Skip if no pitcher name
           
      // Skip rows with missing critical pitch data
      if (!record.PlateLocSide || !record.PlateLocHeight || !record.RelSpeed) {
        continue;
      }

      // Track pitcher
      const pitcherKey = `${pitcherName}`;
      if (!pitchers.has(pitcherKey)) {
        const pitcherThrows = record.PitcherThrows || null;
        const pitcherTeam = record.PitcherTeam || null;
        pitchers.set(pitcherKey, { name: pitcherName, team: pitcherTeam, throws: pitcherThrows });
      }

      // Normalize coordinates (Trackman feet → 0-1 scale)
      const plateLocSide = parseFloat(record.PlateLocSide) || 0;
      const plateLocHeight = parseFloat(record.PlateLocHeight) || 0;

      const normalizedX = (plateLocSide + 2.0) / 5.2; // -3.4 to 3.2 → ~0 to 1
      const normalizedY = plateLocHeight / 5.0; // 0-5 → 0-1

      // Clamp to 0-1
      const x = Math.max(0, Math.min(1, normalizedX));
      const y = Math.max(0, Math.min(1, normalizedY));

           // Skip if no pitch type data
      if (!record.TaggedPitchType && !record.AutoPitchType) {
        continue;
      }

      // Map pitch type (Trackman → Kilo)
      const pitchType = (record.TaggedPitchType || record.AutoPitchType) ? mapPitchType(record.TaggedPitchType || record.AutoPitchType) : "?";
      const extension = record.Extension ? parseFloat(record.Extension) : null;
      const relHeight = record.RelHeight ? parseFloat(record.RelHeight) : null;
      const relSide = record.RelSide ? parseFloat(record.RelSide) : null;

      // Map result
      const result = mapPitchResult(record.PitchCall);

      // Get balls and strikes
      const balls = parseInt(record.Balls) || 0;
      const strikes = parseInt(record.Strikes) || 0;

      // Get other metrics (safely handle blanks)
      const mph = record.RelSpeed ? parseInt(record.RelSpeed) : null;
      const spinRate = record.SpinRate ? parseInt(record.SpinRate) : null;
      const ivb = record.InducedVertBreak ? parseFloat(record.InducedVertBreak) : null;
      const hb = record.HorzBreak ? parseFloat(record.HorzBreak) : null;
      const batterHandedness = record.BatterSide ? (record.BatterSide === "Left" ? "LHH" : "RHH") : null;
      const exitVelocity = record.ExitSpeed ? parseInt(record.ExitSpeed) : null;

      pitchesToInsert.push({
        pitcherName,
        pitchType,
        balls,
        strikes,
        result,
        x,
        y,
        mph,
        spinRate,
        ivb,
        hb,
        extension: extension,
        relHeight: relHeight,
        relSide: relSide,
        batterHandedness,
        exitVelocity
      });
    }

    if (pitchesToInsert.length === 0) {
      return res.json({ success: false, error: "No valid pitch data found" });
    }

    // Create pitcher records and insert pitches
    const pitcherMap = {}; // pitcher name → pitcher_id

    for (const [key, pitcher] of pitchers.entries()) {
      // Check if pitcher exists
      const existing = await pool.query(
        "SELECT id FROM pitchers WHERE name = $1",
        [pitcher.name]
      );

      let pitcherId;
      if (existing.rows.length > 0) {
        pitcherId = existing.rows[0].id;
      } else {
        // Create new pitcher
        const newPitcher = await pool.query(
          "INSERT INTO pitchers (id, name, pitcher_throws, team) VALUES ($1, $2, $3, $4) RETURNING id",
          [crypto.randomUUID(), pitcher.name, pitcher.throws, pitcher.team]
        );
        pitcherId = newPitcher.rows[0].id;
      }

      pitcherMap[pitcher.name] = pitcherId;
    }

    // Create CSV import record
    const csvImportId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO csv_imports (id, session_id, pitch_count, pitcher_count)
       VALUES ($1, $2, $3, $4)`,
      [csvImportId, sessionId, pitchesToInsert.length, pitchers.size]
    );

    // Insert all pitches
    for (const pitch of pitchesToInsert) {
      const pitcherId = pitcherMap[pitch.pitcherName];

      await pool.query(
        `INSERT INTO pitches (id, session_id, pitcher_id, pitch_type, balls, strikes, result, x, y, mph, spin_rate, ivb, hb, extension, rel_height, rel_side, batter_handedness, exit_velocity, csv_import_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          crypto.randomUUID(),
          sessionId,
          pitcherId,
          pitch.pitchType,
          pitch.balls,
          pitch.strikes,
          pitch.result,
          pitch.x,
          pitch.y,
          pitch.mph,
          pitch.spinRate,
          pitch.ivb,
          pitch.hb,
          pitch.extension,
          pitch.relHeight,
          pitch.relSide,
          pitch.batterHandedness,
          pitch.exitVelocity,
          csvImportId
        ]
      );
    }
    res.json({
      success: true,
      message: `Imported ${pitchesToInsert.length} pitches from ${pitchers.size} pitchers`,
      pitchers: Array.from(pitchers.values()),
      pitcherCount: pitchers.size
    });

  } catch (err) {
    console.error("CSV upload error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Get past CSV imports for a session
app.get("/session/:sessionId/csv-imports", async (req, res) => {
  const { sessionId } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
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
      `SELECT id, uploaded_at, pitch_count, pitcher_count
       FROM csv_imports
       WHERE session_id = $1
       ORDER BY uploaded_at DESC`,
      [sessionId]
    );

    res.json({
      success: true,
      imports: result.rows.map(row => ({
        id: row.id,
        uploadedAt: row.uploaded_at,
        pitchCount: row.pitch_count,
        pitcherCount: row.pitcher_count
      }))
    });
  } catch (err) {
    console.error("CSV imports list error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Delete CSV import and all linked pitches
app.delete("/csv-import/:csvImportId", async (req, res) => {
  const { csvImportId } = req.params;
  const { token } = req.body;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const csvImport = await pool.query(
      "SELECT id, session_id, pitch_count FROM csv_imports WHERE id = $1",
      [csvImportId]
    );

    if (csvImport.rows.length === 0) {
      return res.json({ success: false, error: "CSV import not found" });
    }

    const sessionId = csvImport.rows[0].session_id;
    const pitchCount = csvImport.rows[0].pitch_count;

    const sessionCheck = await pool.query(
      "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
      [sessionId, user.id]
    );
    if (sessionCheck.rows.length === 0) {
      return res.json({ success: false, error: "Unauthorized" });
    }

    await pool.query(
      "DELETE FROM pitches WHERE csv_import_id = $1",
      [csvImportId]
    );

    await pool.query(
      "DELETE FROM csv_imports WHERE id = $1",
      [csvImportId]
    );

    console.log(`🗑️ Deleted CSV import: ${pitchCount} pitches removed`);

    res.json({
      success: true,
      message: `Deleted CSV import (${pitchCount} pitches removed)`
    });

  } catch (err) {
    console.error("Delete CSV import error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Helper functions
function mapPitchType(trackmanType) {
  if (!trackmanType) return "?";
  
  const normalized = trackmanType.trim().toLowerCase();
  
  // Check for pitch type keywords (handles all variations)
  if (normalized.includes("four") || normalized.includes("4") || normalized.includes("fastball")) return "FB";
  if (normalized.includes("sinker")) return "SN";
  if (normalized.includes("cutter")) return "CT";
  if (normalized.includes("slider")) return "SL";
  if (normalized.includes("curve")) return "CB";
  if (normalized.includes("change")) return "CH";
  if (normalized.includes("split")) return "SP";
  if (normalized.includes("knuckle")) return "KN";
  
  return "?";
}

function mapPitchResult(pitchCall) {
  const resultMap = {
    "BallCalled": "Ball",
    "StrikeCalled": "Strike",
    "StrikeSwinging": "Strike",
    "InPlay": "InPlay",
    "HitByPitch": "HBP",
    "BallIntentional": "Ball"
  };
  return resultMap[pitchCall] || "Ball";
}

// ======================================
// ADVANCED STATS CALCULATOR
// ======================================
function calculateAdvancedStats(allPitches) {
  // Calculate innings pitched
  const inningsPitched = allPitches.length / 6; // roughly 6 pitches per out

  // Count outcomes
  let strikeouts = 0, walks = 0, hbp = 0, homeRuns = 0, runsAllowed = 0;

  allPitches.forEach(p => {
    // Strikeouts
    if (p.result === 'Strikeout' || (p.pitch_call && p.pitch_call.includes('Strikeout'))) {
      strikeouts++;
    }
    // Walks
    if (p.result === 'Walk' || (p.pitch_call && p.pitch_call.includes('BallCalled'))) {
      walks++;
    }
    // HBP
    if (p.pitch_call === 'HitByPitch') {
      hbp++;
    }
    // Home Runs
    if (p.play_result === 'HomeRun') {
      homeRuns++;
    }
    // Runs allowed
    if (p.runs_scored) {
      runsAllowed += parseInt(p.runs_scored);
    }
  });

  // ERA = (Runs * 9) / IP
  const era = inningsPitched > 0 ? ((runsAllowed * 9) / inningsPitched).toFixed(2) : 0;

  // FIP = ((13*HR + 3*(BB+HBP) - 2*K) / IP) + 3.20
  const fip = inningsPitched > 0
    ? (((13 * homeRuns + 3 * (walks + hbp) - 2 * strikeouts) / inningsPitched) + 3.20).toFixed(2)
    : 0;

  // wOBA calculation (opponent wOBA)
  const bipPitches = allPitches.filter(p => p.exit_velocity);
  const avgWoba = bipPitches.length > 0
    ? (bipPitches.reduce((sum, p) => sum + (parseFloat(p.exit_velocity) * 0.01), 0) / bipPitches.length).toFixed(3)
    : 0;

  return {
    era,
    fip,
    strikeouts,
    walks,
    hbp,
    homeRuns,
    runsAllowed,
    inningsPitched: inningsPitched.toFixed(1),
    woba: avgWoba
  };
}

// ======================================
// METRICS CALCULATOR
// ======================================
// preloadedPitches: optional array of pitch rows already fetched by the caller
// (used by the aggregated-across-sessions endpoint, so the exact same stats
// logic runs whether pitches come from one session or all of them combined).
async function calculatePitcherMetrics(sessionId, pitcherId, preloadedPitches) {
  try {
    let pitches;
    if (preloadedPitches) {
      pitches = preloadedPitches;
    } else {
      const pitchesResult = await pool.query(
        `SELECT * FROM pitches 
         WHERE session_id = $1 AND pitcher_id = $2 
         ORDER BY created_at ASC`,
        [sessionId, pitcherId]
      );
      pitches = pitchesResult.rows;
    }

    if (pitches.length === 0) {
      return null;
    }

    // Get pitcher name and throws
    const pitcherResult = await pool.query(
      "SELECT name, pitcher_throws FROM pitchers WHERE id = $1",
      [pitcherId]
    );
    const pitcherName = pitcherResult.rows[0]?.name || "Unknown";
    const pitcherThrows = pitcherResult.rows[0]?.pitcher_throws || null;

    // ===== ADVANCED STATS =====
    const advancedStats = calculateAdvancedStats(pitches);

    // ===== BASIC STATS =====
    const totalPitches = pitches.length;
    const peakVelo = Math.max(...pitches.map(p => p.mph || 0));

    // ===== PITCH TYPE GROUPING =====
    const pitchGroups = {};
    pitches.forEach(p => {
      const type = p.pitch_type || "?";
      if (!pitchGroups[type]) {
        pitchGroups[type] = [];
      }
      pitchGroups[type].push(p);
    });

    // ===== CALCULATE STATS PER PITCH TYPE =====
    const pitchStats = {};
    Object.entries(pitchGroups).forEach(([type, typePitches]) => {
      const count = typePitches.length;
      const usage = ((count / totalPitches) * 100).toFixed(1);

      const avgExtension = typePitches.length > 0
        ? (typePitches.reduce((sum, p) => sum + (parseFloat(p.extension) || 0), 0) / typePitches.length).toFixed(2)
        : 0;

      // Velocity
      const velos = typePitches.filter(p => p.mph).map(p => p.mph);
      const avgVelo = velos.length > 0 
        ? (velos.reduce((a,b) => a+b) / velos.length).toFixed(1)
        : "—";
      const maxVelo = velos.length > 0 ? Math.max(...velos) : "—";
      const minVelo = velos.length > 0 ? Math.min(...velos) : "—";

      // Spin rate
      const spins = typePitches.filter(p => p.spin_rate).map(p => p.spin_rate);
      const avgSpin = spins.length > 0
        ? Math.round(spins.reduce((a,b) => a+b) / spins.length)
        : "—";

      // IVB & HB
      const ivbs = typePitches.filter(p => p.ivb !== null).map(p => parseFloat(p.ivb) || 0);
      const avgIVB = ivbs.length > 0 && ivbs.some(v => v !== 0)
        ? (ivbs.reduce((a,b) => a+b) / ivbs.length).toFixed(2)
        : "—";

      const hbs = typePitches.filter(p => p.hb !== null).map(p => parseFloat(p.hb) || 0);
      const avgHB = hbs.length > 0 && hbs.some(v => v !== 0)
        ? (hbs.reduce((a,b) => a+b) / hbs.length).toFixed(2)
        : "—";

      // Zone %
      const inZone = typePitches.filter(p => isInZone(p.x, p.y)).length;
      const zonePercent = ((inZone / count) * 100).toFixed(1);

      // Whiff % (StrikeSwinging / swings)
      // CSW% (Called Strikes + Whiffs / total)
      const strikes = typePitches.filter(p => p.result === "Strike").length;
      const whiffs = typePitches.filter(p => p.pitch_outcome_details === "Whiff").length;
      const csw = ((strikes + whiffs) / count * 100).toFixed(1);

      // Exit velo (avg, max)
      const exitVelos = typePitches.filter(p => p.exit_velocity).map(p => p.exit_velocity);
      const avgEV = exitVelos.length > 0
        ? (exitVelos.reduce((a,b) => a+b) / exitVelos.length).toFixed(1)
        : "—";
      const maxEV = exitVelos.length > 0 ? Math.max(...exitVelos) : "—";

      // Contact quality (BIP, HH%)
      const bipPitches = typePitches.filter(p => p.result === "InPlay");
      const bipCount = bipPitches.length;
      const hardHits = bipPitches.filter(p => p.exit_velocity && p.exit_velocity > 90);
      const hardHitPercent = bipCount > 0 ? ((hardHits.length / bipCount) * 100).toFixed(1) : "—";

      pitchStats[type] = {
        count,
        usage,
        avgVelo,
        maxVelo,
        minVelo,
        avgSpin,
        avgIVB,
        avgHB,
        extension: avgExtension,
        zonePercent,
        csw,
        avgEV,
        maxEV,
        strikes,
        whiffs,
        bipCount,
        hardHitPercent
      };
    });

    // ===== FIRST PITCH (0-0) STATS =====
    const firstPitches = pitches.filter(p => p.balls === 0 && p.strikes === 0);
    const firstPitchType = firstPitches.length > 0
      ? getMostCommon(firstPitches.map(p => p.pitch_type))
      : "—";
    const firstPitchPercent = ((firstPitches.length / totalPitches) * 100).toFixed(1);

    // ===== HANDEDNESS SPLITS =====
    const rhPitches = pitches.filter(p => p.batter_handedness === "RHH");
    const lhPitches = pitches.filter(p => p.batter_handedness === "LHH");

    // ===== STRIKEOUT PITCH =====
    const strikeoutPitches = pitches.filter(p => p.result === "Strike");
    const outPitch = strikeoutPitches.length > 0
      ? getMostCommon(strikeoutPitches.map(p => p.pitch_type))
      : "—";
    const outPitchCount = strikeoutPitches.filter(p => p.pitch_type === outPitch).length;

    // ===== CONTACT QUALITY =====
    const inPlayPitches = pitches.filter(p => p.result === "InPlay");
    const bipCount = inPlayPitches.length;
    const bipPercent = ((bipCount / totalPitches) * 100).toFixed(1);

    // Hard hit % (exit velocity > 90 mph)
    const hardHits = inPlayPitches.filter(p => p.exit_velocity && p.exit_velocity > 88.5);
    const hardHitPercent = bipCount > 0 ? ((hardHits.length / bipCount) * 100).toFixed(1) : "—";

    // ===== ADVANCED SCOUTING (handedness approach, out pitches, first-pitch
    // tendencies, weakest pitch, two-strike intel) =====
    const advancedScouting = calculateAdvancedScouting(pitches, pitchStats);

    return {
      pitcherName,
      pitcherThrows,
      totalPitches,
      peakVelo,
      firstPitchType,
      firstPitchPercent,
      outPitch,
      outPitchCount,
      pitchStats,
      firstPitches,
      rhPitches,
      lhPitches,
      strikeoutPitches,
      allPitches: pitches,
      bipCount,
      bipPercent,
      hardHitPercent,
      advancedStats: advancedStats,
      ...advancedScouting
    };

  } catch (err) {
    console.error("Metrics calculation error:", err);
    return null;
  }
}

// Helper: Check if pitch is in zone (strike zone = 0.3-0.7 x, 0.3-0.7 y)
function isInZone(x, y) {
  return x >= 0.3 && x <= 0.7 && y >= 0.3 && y <= 0.7;
}

// ======================================
// ADVANCED SCOUTING HELPERS
// ======================================

// Shared breakdown builder used by handedness splits, first-pitch tendencies,
// and two-strike intel so all three report consistent numbers off one code path.
function buildPitchTypeBreakdown(pitchSubset, totalForPercent) {
  const total = totalForPercent !== undefined ? totalForPercent : pitchSubset.length;
  const groups = {};
  pitchSubset.forEach(p => {
    const type = p.pitch_type || "?";
    if (!groups[type]) groups[type] = [];
    groups[type].push(p);
  });

  const breakdown = Object.entries(groups).map(([type, typePitches]) => {
    const count = typePitches.length;
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";

    const velos = typePitches.filter(p => p.mph).map(p => p.mph);
    const avgVelo = velos.length > 0
      ? (velos.reduce((a, b) => a + b) / velos.length).toFixed(1)
      : "—";

    const inZone = typePitches.filter(p => isInZone(p.x, p.y)).length;
    const zonePercent = count > 0 ? ((inZone / count) * 100).toFixed(1) : "—";

    const strikes = typePitches.filter(p => p.result === "Strike").length;
    const whiffs = typePitches.filter(p => p.pitch_outcome_details === "Whiff").length;
    const csw = count > 0 ? (((strikes + whiffs) / count) * 100).toFixed(1) : "—";

    const battedBalls = typePitches.filter(p => p.result === "InPlay");
    const hardHitBalls = battedBalls.filter(p => p.exit_velocity && p.exit_velocity > 90);
    const hardHitPercent = battedBalls.length > 0
      ? ((hardHitBalls.length / battedBalls.length) * 100).toFixed(1)
      : "—";

    return { type, count, pct, avgVelo, zonePercent, csw, whiffs, hardHitPercent, bipCount: battedBalls.length };
  }).sort((a, b) => b.count - a.count);

  return breakdown;
}

// Builds all five advanced scouting views off the same pitch list + pitchStats
// that calculatePitcherMetrics already computed, so nothing is recalculated
// twice or drifts out of sync with the arsenal summary table.
function calculateAdvancedScouting(pitches, pitchStats) {
  // ----- Handedness splits / approach vs RHH & LHH -----
  const rhPitches = pitches.filter(p => p.batter_handedness === "RHH");
  const lhPitches = pitches.filter(p => p.batter_handedness === "LHH");

  const handednessApproach = {
    RHH: {
      pitchCount: rhPitches.length,
      breakdown: buildPitchTypeBreakdown(rhPitches, rhPitches.length)
    },
    LHH: {
      pitchCount: lhPitches.length,
      breakdown: buildPitchTypeBreakdown(lhPitches, lhPitches.length)
    }
  };

  // ----- First pitch tendencies (0-0 counts) -----
  const firstPitches = pitches.filter(p => p.balls === 0 && p.strikes === 0);
  const firstPitchBreakdown = buildPitchTypeBreakdown(firstPitches, firstPitches.length);
  const firstPitchTendencies = {
    totalFirstPitches: firstPitches.length,
    breakdown: firstPitchBreakdown,
    primaryType: firstPitchBreakdown[0]?.type || "—",
    primaryPct: firstPitchBreakdown[0]?.pct || "0.0"
  };

  // ----- Two-strike intel -----
  const twoStrikePitches = pitches.filter(p => p.strikes === 2);
  const twoStrikeBreakdown = buildPitchTypeBreakdown(twoStrikePitches, twoStrikePitches.length);
  const twoStrikeIntel = {
    totalTwoStrikePitches: twoStrikePitches.length,
    breakdown: twoStrikeBreakdown,
    primaryType: twoStrikeBreakdown[0]?.type || "—",
    primaryPct: twoStrikeBreakdown[0]?.pct || "0.0"
  };

  // ----- Primary / secondary out pitch -----
  const outPitchRanking = twoStrikeBreakdown
    .map(b => {
      const outCount = twoStrikePitches.filter(
        p => p.pitch_type === b.type && (p.result === "Strike" || p.pitch_outcome_details === "Whiff")
      ).length;
      return { type: b.type, outCount, csw: b.csw, sampleSize: b.count };
    })
    .sort((a, b) => b.outCount - a.outCount);

  const outPitches = {
    primary: outPitchRanking[0] || null,
    secondary: outPitchRanking[1] || null
  };

  // ----- Weakest pitch -----
  const weakestCandidates = Object.entries(pitchStats)
    .map(([type, stats]) => {
      const hardHit = parseFloat(stats.hardHitPercent);
      const avgEV = parseFloat(stats.avgEV);
      const hasData = !isNaN(hardHit) && !isNaN(avgEV) && stats.bipCount > 0;
      return {
        type,
        hardHitPercent: stats.hardHitPercent,
        avgEV: stats.avgEV,
        maxEV: stats.maxEV,
        battedBallCount: stats.bipCount,
        hasData,
        score: hasData ? (hardHit + (avgEV - 70) * 2) : -Infinity
      };
    })
    .filter(c => c.hasData)
    .sort((a, b) => b.score - a.score);

  const weakestPitch = weakestCandidates[0] || null;

  return {
    handednessApproach,
    firstPitchTendencies,
    twoStrikeIntel,
    outPitches,
    weakestPitch
  };
}

// Helper: Get most common item in array
function getMostCommon(arr) {
  const counts = {};
  arr.forEach(item => {
    counts[item] = (counts[item] || 0) + 1;
  });
  return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
}

// ======================================
// PITCHER REPORT ENDPOINT
// ======================================
app.get("/pitcher/:pitcherId/report", async (req, res) => {
  const { pitcherId } = req.params;
  const { sessionId, token } = req.query;

  // Auth check
  const user = await verifyToken(token);
  if (!user) {
    return res.status(401).send("Unauthorized");
  }

  // Verify session belongs to user
  const sessionCheck = await pool.query(
    "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
    [sessionId, user.id]
  );
  if (sessionCheck.rows.length === 0) {
    return res.status(404).send("Session not found");
  }

  try {
    // Calculate metrics
    const metrics = await calculatePitcherMetrics(sessionId, pitcherId);
    if (!metrics) {
      return res.status(404).send("Pitcher not found");
    }

    // Generate HTML report
    const html = generateScoutingReport(metrics);
    
    res.setHeader("Content-Type", "text/html");
    res.send(html);

  } catch (err) {
    console.error("Report generation error:", err);
    res.status(500).send("Error generating report");
  }
});

// Get metrics as JSON (for pitcher-report.html)
app.get("/session/:sessionId/metrics", async (req, res) => {
  const { sessionId } = req.params;
  const { pitcherId, token } = req.query;

  // Auth check
  const user = await verifyToken(token);
  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  // Verify session belongs to user
  const sessionCheck = await pool.query(
    "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
    [sessionId, user.id]
  );
  if (sessionCheck.rows.length === 0) {
    return res.json({ success: false, error: "Session not found" });
  }

  try {
    const metrics = await calculatePitcherMetrics(sessionId, pitcherId);
    if (!metrics) {
      return res.json({ success: false, error: "Pitcher not found" });
    }

    // Calculate additional stats needed for report
    const shrinkZonePercent = calculateShrinkZone(metrics.allPitches);

    // Calculate KDE for location heatmaps
    const kdeData = {};
    Object.entries(metrics.pitchStats).forEach(([pitchType, stats]) => {
      const pitchesOfType = metrics.allPitches.filter(p => p.pitch_type === pitchType);

      // Convert normalized coords to plate coords
      const points = pitchesOfType
        .map(p => ({
          x: (parseFloat(p.x) * 4) - 2,
          y: parseFloat(p.y) * 5
        }))
        .filter(p => !isNaN(p.x) && !isNaN(p.y));

      if (points.length >= 2) {
        kdeData[pitchType] = calculateKDE(points, 40);
      }
    });

    res.json({
      success: true,
      pitcherName: metrics.pitcherName,
      pitcherThrows: metrics.pitcherThrows,
      totalPitches: metrics.totalPitches,
      peakVelo: metrics.peakVelo,
      firstPitchType: metrics.firstPitchType,
      firstPitchPercent: metrics.firstPitchPercent,
      outPitch: metrics.outPitch,
      outPitchCount: metrics.outPitchCount,
      shrinkZonePercent,
      pitchStats: metrics.pitchStats,
      allPitches: metrics.allPitches,
      handednessApproach: metrics.handednessApproach,
      firstPitchTendencies: metrics.firstPitchTendencies,
      twoStrikeIntel: metrics.twoStrikeIntel,
      outPitches: metrics.outPitches,
      weakestPitch: metrics.weakestPitch,
      kdeData: kdeData,
      advancedStats: metrics.advancedStats,
    });
  } catch (err) {
    console.error("Metrics error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Get all pitchers with aggregated stats across all sessions
app.get("/all-pitchers", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    // Get all pitchers for this user
    const result = await pool.query(
      `SELECT DISTINCT p.id, p.name, p.pitcher_throws, p.team
       FROM pitchers p
       JOIN pitches pt ON p.id = pt.pitcher_id
       JOIN sessions s ON pt.session_id = s.id
       WHERE s.user_id = $1
       ORDER BY p.name`,
      [user.id]
    );

    const pitchers = result.rows;

    const pitchersFormatted = pitchers.map(p => ({
      id: p.id,
      name: p.name,
      pitcher_throws: p.pitcher_throws,
      team: p.team
    }));

    res.json({ success: true, pitchers: pitchersFormatted });

  } catch (err) {
    console.error("All pitchers error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Get aggregated pitcher stats across all sessions (mirrors /session/:sessionId/metrics
// exactly, just sourced from every session's pitches instead of one)
app.get("/pitcher-aggregated/:pitcherId", async (req, res) => {
  const { pitcherId } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    // Get ALL pitches for this pitcher across all sessions (for this user)
    const pitchesResult = await pool.query(
      `SELECT pt.* FROM pitches pt
       JOIN sessions s ON pt.session_id = s.id
       WHERE pt.pitcher_id = $1 AND s.user_id = $2
       ORDER BY pt.created_at ASC`,
      [pitcherId, user.id]
    );

    const allPitches = pitchesResult.rows;

    if (allPitches.length === 0) {
      return res.json({ success: false, error: "No pitch data found" });
    }

    // Reuse the exact same metrics calculator the single-session report uses,
    // just fed the pre-fetched, cross-session pitch list instead of a DB query
    // scoped to one session.
    const metrics = await calculatePitcherMetrics(null, pitcherId, allPitches);
    if (!metrics) {
      return res.json({ success: false, error: "Pitcher not found" });
    }

    const shrinkZonePercent = calculateShrinkZone(metrics.allPitches);

    // Calculate KDE for location heatmaps (identical to the single-session endpoint)
    const kdeData = {};
    Object.entries(metrics.pitchStats).forEach(([pitchType, stats]) => {
      const pitchesOfType = metrics.allPitches.filter(p => p.pitch_type === pitchType);
      const points = pitchesOfType
        .map(p => ({
          x: (parseFloat(p.x) * 4) - 2,
          y: parseFloat(p.y) * 5
        }))
        .filter(p => !isNaN(p.x) && !isNaN(p.y));

      if (points.length >= 2) {
        kdeData[pitchType] = calculateKDE(points, 40);
      }
    });

    res.json({
      success: true,
      pitcherName: metrics.pitcherName,
      pitcherThrows: metrics.pitcherThrows,
      totalPitches: metrics.totalPitches,
      peakVelo: metrics.peakVelo,
      firstPitchType: metrics.firstPitchType,
      firstPitchPercent: metrics.firstPitchPercent,
      outPitch: metrics.outPitch,
      outPitchCount: metrics.outPitchCount,
      shrinkZonePercent,
      pitchStats: metrics.pitchStats,
      allPitches: metrics.allPitches,
      handednessApproach: metrics.handednessApproach,
      firstPitchTendencies: metrics.firstPitchTendencies,
      twoStrikeIntel: metrics.twoStrikeIntel,
      outPitches: metrics.outPitches,
      weakestPitch: metrics.weakestPitch,
      kdeData: kdeData,
      advancedStats: metrics.advancedStats
    });

  } catch (err) {
    console.error("Pitcher aggregated error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Helper: Calculate shrink zone %
function calculateShrinkZone(pitches) {
  if (pitches.length === 0) return 0;
  const oozCount = pitches.filter(p => !isInZone(p.x, p.y)).length;
  return ((oozCount / pitches.length) * 100).toFixed(1);
}

// ======================================
// REPORT HTML GENERATION
// ======================================
function generateScoutingReport(metrics) {
  const {
    pitcherName,
    totalPitches,
    peakVelo,
    firstPitchType,
    firstPitchPercent,
    outPitch,
    outPitchCount,
    pitchStats
  } = metrics;

  // Basic styling
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${pitcherName} - Scouting Report</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      background: #050816;
      color: #e5e7eb;
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      background: #0f172a;
      padding: 30px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.3);
    }
    h1 {
      color: #22d3ee;
      margin-bottom: 10px;
    }
    .header {
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.3);
    }
    .summary-boxes {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 30px;
    }
    .summary-box {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 16px;
      border-radius: 8px;
      text-align: center;
    }
    .summary-label {
      font-size: 12px;
      color: #9ca3af;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .summary-value {
      font-size: 24px;
      color: #22d3ee;
      font-weight: 600;
    }
    .section {
      margin-bottom: 30px;
    }
    .section-title {
      font-size: 16px;
      color: #22d3ee;
      font-weight: 600;
      text-transform: uppercase;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 2px solid rgba(56, 189, 248, 0.3);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    th {
      background: rgba(56, 189, 248, 0.1);
      color: #22d3ee;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      font-size: 12px;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    }
    tr:hover {
      background: rgba(56, 189, 248, 0.05);
    }
    .print-button {
      background: #22d3ee;
      color: #000;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .print-button:hover {
      background: #06b6d4;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${pitcherName}</h1>
      <p>Scouting Report</p>
      <button class="print-button" onclick="window.print()">🖨️ Print / Save as PDF</button>
    </div>

    <div class="summary-boxes">
      <div class="summary-box">
        <div class="summary-label">Pitches Tracked</div>
        <div class="summary-value">${totalPitches}</div>
      </div>
      <div class="summary-box">
        <div class="summary-label">Peak Velo</div>
        <div class="summary-value">${peakVelo} mph</div>
      </div>
      <div class="summary-box">
        <div class="summary-label">First Pitch</div>
        <div class="summary-value">${firstPitchType} (${firstPitchPercent}%)</div>
      </div>
      <div class="summary-box">
        <div class="summary-label">Out Pitch</div>
        <div class="summary-value">${outPitch} (${outPitchCount})</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Arsenal Summary</div>
      <table>
        <thead>
          <tr>
            <th>Pitch Type</th>
            <th>Count</th>
            <th>Usage %</th>
            <th>Avg Velo</th>
            <th>Max Velo</th>
            <th>Avg Spin</th>
            <th>IVB</th>
            <th>HB</th>
            <th>Zone %</th>
            <th>CSW%</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(pitchStats).map(([type, stats]) => `
            <tr>
              <td><strong>${type}</strong></td>
              <td>${stats.count}</td>
              <td>${stats.usage}%</td>
              <td>${stats.avgVelo}</td>
              <td>${stats.maxVelo}</td>
              <td>${stats.avgSpin}</td>
              <td>${stats.avgIVB}</td>
              <td>${stats.avgHB}</td>
              <td>${stats.zonePercent}%</td>
              <td>${stats.csw}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <p style="color: #9ca3af; font-size: 12px;">
        Report generated on ${new Date().toLocaleString()}
      </p>
    </div>
  </div>
</body>
</html>
  `;

  return html;
}

// Generate AI coaching summary (placeholder without API key)
app.post("/session/:sessionId/pitcher/:pitcherId/ai-intel", async (req, res) => {
  const { sessionId, pitcherId } = req.params;
  const { token } = req.body;

  // Auth check
  const user = await verifyToken(token);
  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // No API key - return placeholder
      return res.json({
        success: true,
        intel: "🔑 Configure Anthropic API key to enable AI coaching insights",
        placeholder: true
      });
    }

    // TODO: Call Claude API when key is available
    // For now, just return placeholder
    res.json({
      success: true,
      intel: "Fastball is your most reliable pitch early. Use it to establish the zone, then attack weak contact with breaking pitches.",
      placeholder: false
    });

  } catch (err) {
    console.error("AI intel error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Generate PDF report
app.get("/session/:sessionId/pitcher/:pitcherId/pdf", async (req, res) => {
  const { sessionId, pitcherId } = req.params;
  const { token } = req.query;

  // Auth check
  const user = await verifyToken(token);
  if (!user) {
    return res.status(401).json({ success: false, error: "Invalid token" });
  }

  // Verify session belongs to user
  const sessionCheck = await pool.query(
    "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
    [sessionId, user.id]
  );
  if (sessionCheck.rows.length === 0) {
    return res.status(404).json({ success: false, error: "Session not found" });
  }

  try {
    const metrics = await calculatePitcherMetrics(sessionId, pitcherId);
    if (!metrics) {
      return res.status(404).json({ success: false, error: "Pitcher not found" });
    }

    const shrinkZonePercent = calculateShrinkZone(metrics.allPitches);
    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ margin: 40, size: "A4" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${metrics.pitcherName}_Report.pdf"`);

    doc.pipe(res);

    // Header
    doc.fontSize(24).font("Helvetica-Bold").text(metrics.pitcherName, { align: "center" });
    doc.fontSize(12).font("Helvetica").fillColor("#666").text("Scouting Report", { align: "center" });
    doc.moveDown();

    // Summary boxes
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#000");
    doc.text(`Pitches Tracked: ${metrics.totalPitches} | Peak Velo: ${metrics.peakVelo} mph | First Pitch: ${metrics.firstPitchType} (${metrics.firstPitchPercent}%) | Out Pitch: ${metrics.outPitch}`, { align: "center" });
    doc.moveDown();

    // Arsenal table
    doc.fontSize(12).text("Arsenal Summary", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(9);

    const tableTop = doc.y;
    const rowHeight = 20;
    const columns = {
      pitch: 60,
      count: 40,
      usage: 50,
      velo: 50,
      spin: 50,
      ivb: 40,
      hb: 40,
      zone: 50,
      csw: 40
    };

    // Header row
    doc.font("Helvetica-Bold");
    doc.text("Pitch", 50, tableTop);
    doc.text("Count", 110, tableTop);
    doc.text("Use%", 150, tableTop);
    doc.text("Velo", 190, tableTop);
    doc.text("Spin", 230, tableTop);
    doc.text("IVB", 270, tableTop);
    doc.text("HB", 300, tableTop);
    doc.text("Zone%", 330, tableTop);
    doc.text("CSW%", 380, tableTop);

    doc.moveTo(50, tableTop + 15).lineTo(520, tableTop + 15).stroke();

    // Data rows
    doc.font("Helvetica");
    let yPos = tableTop + 25;

    Object.entries(metrics.pitchStats).forEach(([type, stats]) => {
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }
      doc.text(type, 50, yPos);
      doc.text(stats.count.toString(), 110, yPos);
      doc.text(stats.usage + "%", 150, yPos);
      doc.text(stats.avgVelo.toString(), 190, yPos);
      doc.text(stats.avgSpin.toString(), 230, yPos);
      doc.text(stats.avgIVB.toString(), 270, yPos);
      doc.text(stats.avgHB.toString(), 300, yPos);
      doc.text(stats.zonePercent + "%", 330, yPos);
      doc.text(stats.csw + "%", 380, yPos);
      yPos += rowHeight;
    });

    doc.moveDown();

    // Footer
    doc.fontSize(10).fillColor("#999").text(`Generated on ${new Date().toLocaleString()}`, { align: "center" });

    doc.end();

  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete pitcher (removes pitcher and ALL their pitches from all sessions)
app.delete("/pitcher/:pitcherId", async (req, res) => {
  const { pitcherId } = req.params;
  const { token } = req.query;

  // Auth check
  const user = await verifyToken(token);
  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    // Get pitcher to verify it exists
    const pitcher = await pool.query(
      "SELECT id, name FROM pitchers WHERE id = $1",
      [pitcherId]
    );

    if (pitcher.rows.length === 0) {
      return res.json({ success: false, error: "Pitcher not found" });
    }

    // Delete all pitches for this pitcher (from ALL sessions)
    await pool.query(
      "DELETE FROM pitches WHERE pitcher_id = $1",
      [pitcherId]
    );

    // Delete the pitcher record
    await pool.query(
      "DELETE FROM pitchers WHERE id = $1",
      [pitcherId]
    );

    console.log(`🗑️ Deleted pitcher: ${pitcher.rows[0].name}`);

    res.json({ 
      success: true, 
      message: `Pitcher ${pitcher.rows[0].name} deleted`
    });

  } catch (err) {
    console.error("Delete pitcher error:", err);
    res.json({ success: false, error: err.message });
  }
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

    // Start recording: tagger → camera
    if (msg.type === "start-recording") {
      console.log(`🔍 Routing start-recording to camera:`, {
        sessionId: sessionId?.slice(0, 8),
        cameraExists: !!clients[sessionId]?.camera,
        cameraReadyState: clients[sessionId]?.camera?.readyState,
        availableDevices: Object.keys(clients[sessionId] || {})
      });
      const camera = clients[sessionId]?.camera;
      if (camera && camera.readyState === WebSocket.OPEN) {
        camera.send(JSON.stringify(msg));
        console.log(`✅ start-recording sent to camera`);
      } else {
        console.warn(`❌ Cannot route start-recording`);
      }
      return;
    }

    // Stop recording: tagger → camera
    if (msg.type === "stop-recording") {
      const camera = clients[sessionId]?.camera;
      if (camera && camera.readyState === WebSocket.OPEN) {
        camera.send(JSON.stringify(msg));
        console.log(`✅ stop-recording sent to camera`);
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

app.get("/debug/extension", async (req, res) => {
  try {
    const result = await pool.query('SELECT pitch_type, extension FROM pitches WHERE extension IS NOT NULL LIMIT 5');
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});
// ======================================
// START SERVER
// ======================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🔥 Kilo Baseball Server running on port ${PORT}`);
});
