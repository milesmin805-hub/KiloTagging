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
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS vert_appr_angle DECIMAL(6,3) DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS direction DECIMAL(7,3) DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS launch_angle DECIMAL(6,3) DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS distance DECIMAL(7,2) DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS hit_type TEXT DEFAULT NULL;
    `);

    // Strikeout/walk flag, batted-ball outcome, and runs scored — needed for
    // the Advanced Stats (K/BB/HBP/HR/ERA/FIP) calculations to actually work.
    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS kor_bb VARCHAR(20) DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS play_result VARCHAR(50) DEFAULT NULL;
    `);

    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS runs_scored INTEGER DEFAULT NULL;
    `);

   // Hitters table — mirrors pitchers, one row per batter identity
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hitters (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        bats VARCHAR(10) DEFAULT NULL,
        team VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Links each pitch to the batter who faced it, alongside the existing pitcher_id
    await pool.query(`
      ALTER TABLE pitches ADD COLUMN IF NOT EXISTS batter_id UUID REFERENCES hitters(id) DEFAULT NULL;
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

await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gc_games (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        team_name TEXT NOT NULL,
        opponent TEXT NOT NULL,
        game_date TEXT,
        home_away TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gc_batting (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gc_game_id UUID NOT NULL REFERENCES gc_games(id) ON DELETE CASCADE,
        team_name TEXT NOT NULL,
        jersey TEXT,
        player_name TEXT NOT NULL,
        position TEXT,
        pa INT DEFAULT 0,
        ab INT DEFAULT 0,
        h INT DEFAULT 0,
        singles INT DEFAULT 0,
        doubles INT DEFAULT 0,
        triples INT DEFAULT 0,
        hr INT DEFAULT 0,
        xbh INT DEFAULT 0,
        r INT DEFAULT 0,
        rbi INT DEFAULT 0,
        bb INT DEFAULT 0,
        ks INT DEFAULT 0,
        ks_swing INT DEFAULT 0,
        ks_look INT DEFAULT 0,
        hbp INT DEFAULT 0,
        sac INT DEFAULT 0,
        fc INT DEFAULT 0,
        roe INT DEFAULT 0,
        sb INT DEFAULT 0,
        cs INT DEFAULT 0,
        avg DECIMAL(5,3) DEFAULT 0,
        obp DECIMAL(5,3) DEFAULT 0,
        slg DECIMAL(5,3) DEFAULT 0,
        ops DECIMAL(5,3) DEFAULT 0,
        iso DECIMAL(5,3) DEFAULT 0,
        woba DECIMAL(5,3) DEFAULT 0,
        gb_pct DECIMAL(5,1) DEFAULT 0,
        ld_pct DECIMAL(5,1) DEFAULT 0,
        fb_pct DECIMAL(5,1) DEFAULT 0,
        gb_fb DECIMAL(5,2),
        spray_l DECIMAL(5,1) DEFAULT 0,
        spray_c DECIMAL(5,1) DEFAULT 0,
        spray_r DECIMAL(5,1) DEFAULT 0,
        total_pitches_seen INT DEFAULT 0,
        fps_pct DECIMAL(5,1) DEFAULT 0,
        raw_at_bats JSONB
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS gc_pitching (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gc_game_id UUID NOT NULL REFERENCES gc_games(id) ON DELETE CASCADE,
        team_name TEXT NOT NULL,
        player_name TEXT NOT NULL,
        ip INT DEFAULT 0,
        bf INT DEFAULT 0,
        h INT DEFAULT 0,
        bb INT DEFAULT 0,
        ks INT DEFAULT 0,
        ks_swing INT DEFAULT 0,
        ks_look INT DEFAULT 0,
        hbp INT DEFAULT 0,
        hr INT DEFAULT 0,
        wp INT DEFAULT 0,
        k9 DECIMAL(5,2),
        bb9 DECIMAL(5,2),
        h9 DECIMAL(5,2),
        whip DECIMAL(5,3),
        kbb DECIMAL(5,2),
        k_pct DECIMAL(5,1) DEFAULT 0,
        bb_pct DECIMAL(5,1) DEFAULT 0,
        gb_pct DECIMAL(5,1) DEFAULT 0,
        ld_pct DECIMAL(5,1) DEFAULT 0,
        fb_pct DECIMAL(5,1) DEFAULT 0,
        fps_pct DECIMAL(5,1) DEFAULT 0,
        strike_pct DECIMAL(5,1) DEFAULT 0,
        total_pitches INT DEFAULT 0,
        avg_p_per_bf DECIMAL(5,1),
        avg_p_per_inn DECIMAL(5,1),
        innings JSONB
      );
    `);

    await pool.query(`
      INSERT INTO teams (raw_name, display_name)
      SELECT DISTINCT team, team FROM pitchers
      WHERE team IS NOT NULL AND team != ''
      ON CONFLICT (raw_name) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO teams (raw_name, display_name)
      SELECT DISTINCT team, team FROM hitters
      WHERE team IS NOT NULL AND team != ''
      ON CONFLICT (raw_name) DO NOTHING;
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

const csvStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + ext);
  }
});

const upload = multer({ storage });
const csvUpload = multer({ storage: csvStorage });

const gcStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + ".pdf");
  }
});
const gcUpload = multer({ storage: gcStorage });

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
const { parseGCScorebook, computeBattingLine, computePitchingLine } = require('./gc-parser');
const xlsx = require("xlsx");

// ======================================
// RAPSODO HELPERS
// ======================================

// Detects whether an uploaded file is from Rapsodo or Trackman based on
// its header row — so you can upload either format without doing anything special.
function detectFileSource(headers) {
  if (headers.includes("Pitch TotalSpeed (MPH)") || headers.includes("Pitcher First Name")) return "rapsodo";
  if (headers.includes("RelSpeed") || headers.includes("Pitcher")) return "trackman";
  return "unknown";
}

// Rapsodo uses its own pitch-type shortcodes (FA, CU, etc.) that differ
// from Trackman's verbose labels (FourSeamFastBall, Curveball, etc.)
function mapRapsodoPitchType(rapsodoType) {
  if (!rapsodoType) return "?";
  const t = rapsodoType.trim().toUpperCase();
  const map = {
    "FA": "FB", "FF": "FB", "FT": "SN", "SI": "SN",
    "FC": "CT", "SL": "SL", "CU": "CB", "KC": "CB",
    "CH": "CH", "FS": "SP", "KN": "KN", "SC": "SL"
  };
  return map[t] || "?";
}

// Rapsodo coordinates are in inches; normalize to the same 0-1 scale
// Trackman uses, so all downstream metrics work identically regardless of source.
function normalizeRapsodoCoords(sideInches, heightInches) {
  const sideFeet = parseFloat(sideInches) / 12;
  const heightFeet = parseFloat(heightInches) / 12;
  const x = Math.max(0, Math.min(1, (sideFeet + 2.0) / 5.2));
  const y = Math.max(0, Math.min(1, heightFeet / 5.0));
  return { x, y };
}

// Parses a Rapsodo .xlsx export into the same pitch-object shape that the
// Trackman CSV path produces, so one insert loop handles both.
function parseRapsodoXlsx(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

  const pitchers = new Map();
  const hitters = new Map();
  const pitchesToInsert = [];

  rows.forEach(record => {
    const pitcherFirst = record["Pitcher First Name"]?.toString().trim();
    const pitcherLast = record["Pitcher Last Name"]?.toString().trim();
    if (!pitcherFirst && !pitcherLast) return;
    const pitcherName = `${pitcherFirst || ""} ${pitcherLast || ""}`.trim();

    const speed = record["Pitch TotalSpeed (MPH)"];
    if (!speed || speed === "-" || isNaN(parseFloat(speed))) return; // skip rows with no real pitch data

    const pitcherThrows = record["Pitch Throws"] === "L" ? "Left" : record["Pitch Throws"] === "R" ? "Right" : null;
    if (!pitchers.has(pitcherName)) {
      pitchers.set(pitcherName, { name: pitcherName, team: null, throws: pitcherThrows });
    } else {
      const ep = pitchers.get(pitcherName);
      if (!ep.throws && pitcherThrows) ep.throws = pitcherThrows;
    }

    const hitterFirst = record["Hitter First Name"]?.toString().trim();
    const hitterLast = record["Hitter Last Name"]?.toString().trim();
    const batterName = hitterFirst || hitterLast ? `${hitterFirst || ""} ${hitterLast || ""}`.trim() : null;
    const batterBats = record["Hit Bats"] === "L" ? "LHH" : record["Hit Bats"] === "R" ? "RHH" : null;
    if (batterName && !hitters.has(batterName)) {
      hitters.set(batterName, { name: batterName, team: null, bats: batterBats });
    }

    const sideRaw = record["Strike Zone Side (Inches)"];
    const heightRaw = record["Strike Zone Height (Inches)"];
    const hasCords = sideRaw && sideRaw !== "-" && heightRaw && heightRaw !== "-";
    const { x, y } = hasCords ? normalizeRapsodoCoords(sideRaw, heightRaw) : { x: null, y: null };

    const hb = record["Pitch HorizontalBreakSpin (Inches)"];
    const vb = record["Pitch VerticalBreakSpin (Inches)"];
    const evRaw = record["Hit TotalSpeed (MPH)"];

    pitchesToInsert.push({
      pitcherName,
      batterName,
      pitchType: mapRapsodoPitchType(record["Pitch Type"]),
      balls: null,
      strikes: null,
      result: null, // Rapsodo doesn't track pitch call (ball/strike) per pitch
      x,
      y,
      mph: parseFloat(speed) || null,
      spinRate: record["Pitch TotalSpin (RPM)"] && record["Pitch TotalSpin (RPM)"] !== "-" ? parseInt(record["Pitch TotalSpin (RPM)"]) : null,
      ivb: vb && vb !== "-" && parseFloat(vb) !== 0 ? parseFloat(vb) : null,
      hb: hb && hb !== "-" && parseFloat(hb) !== 0 ? parseFloat(hb) : null,
      extension: null,
      relHeight: record["Pitch ReleaseHeight (Feet)"] && record["Pitch ReleaseHeight (Feet)"] !== "-" ? parseFloat(record["Pitch ReleaseHeight (Feet)"]) : null,
      relSide: record["Pitch ReleaseSide (Feet)"] && record["Pitch ReleaseSide (Feet)"] !== "-" ? parseFloat(record["Pitch ReleaseSide (Feet)"]) : null,
      batterHandedness: batterBats,
      exitVelocity: evRaw && evRaw !== "-" && parseFloat(evRaw) > 0 ? parseInt(evRaw) : null,
      korBB: null,
      playResult: null,
      runsScored: null
    });
  });

  return { pitchers, hitters, pitchesToInsert };
}

app.post("/upload-csv", csvUpload.single("csv"), async (req, res) => {
  const file = req.file;
  const { sessionId, token } = req.body;

  if (!file) {
    return res.json({ success: false, error: "No file received - check upload" });
  }

  const user = await verifyToken(token);
  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  const sessionCheck = await pool.query(
    "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
    [sessionId, user.id]
  );
  if (sessionCheck.rows.length === 0) {
    return res.json({ success: false, error: "Session not found" });
  }

  try {
    let pitchers, hitters, pitchesToInsert;

    const ext = path.extname(file.originalname).toLowerCase();

    if (ext === ".xlsx") {
      // ===== RAPSODO PATH =====
      const parsed = parseRapsodoXlsx(file.path);
      pitchers = parsed.pitchers;
      hitters = parsed.hitters;
      pitchesToInsert = parsed.pitchesToInsert;
    } else {
      // ===== TRACKMAN PATH (existing logic) =====
      const fileContent = fs.readFileSync(file.path, "utf8");
      const records = csv.parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      if (records.length === 0) {
        return res.json({ success: false, error: "CSV is empty" });
      }

      // Detect source from headers just in case a Trackman CSV comes in
      const headers = Object.keys(records[0]);
      const source = detectFileSource(headers);
      if (source === "unknown") {
        return res.json({ success: false, error: "Unrecognized CSV format — expected Trackman or Rapsodo headers" });
      }

      pitchers = new Map();
      hitters = new Map();
      pitchesToInsert = [];

  for (const record of records) {
        const pitcherName = record.Pitcher?.trim();
        const pitcherTeam = record.PitcherTeam?.trim();

        if (!pitcherName) continue;

        if (!record.PlateLocSide || !record.PlateLocHeight || !record.RelSpeed) {
          continue;
        }

        const pitcherKey = `${pitcherName}`;
        const pitcherThrows = record.PitcherThrows || null;
        if (!pitchers.has(pitcherKey)) {
          pitchers.set(pitcherKey, { name: pitcherName, team: pitcherTeam, throws: pitcherThrows });
        } else {
          const existingPitcher = pitchers.get(pitcherKey);
          if (!existingPitcher.throws && pitcherThrows) existingPitcher.throws = pitcherThrows;
          if (!existingPitcher.team && pitcherTeam) existingPitcher.team = pitcherTeam;
        }

        const batterName = record.Batter?.trim();
        if (batterName && !hitters.has(batterName)) {
          const batterBats = record.BatterSide || null;
          const batterTeam = record.BatterTeam || null;
          hitters.set(batterName, { name: batterName, team: batterTeam, bats: batterBats });
        }

        const plateLocSide = parseFloat(record.PlateLocSide) || 0;
        const plateLocHeight = parseFloat(record.PlateLocHeight) || 0;
        const normalizedX = (plateLocSide + 2.0) / 5.2;
        const normalizedY = plateLocHeight / 5.0;
        const x = Math.max(0, Math.min(1, normalizedX));
        const y = Math.max(0, Math.min(1, normalizedY));

        if (!record.TaggedPitchType && !record.AutoPitchType) {
          continue;
        }

        const pitchType = (record.TaggedPitchType || record.AutoPitchType) ? mapPitchType(record.TaggedPitchType || record.AutoPitchType) : "?";
        const extension = record.Extension ? parseFloat(record.Extension) : null;
        const relHeight = record.RelHeight ? parseFloat(record.RelHeight) : null;
        const relSide = record.RelSide ? parseFloat(record.RelSide) : null;
        const result = mapPitchResult(record.PitchCall);
        const balls = parseInt(record.Balls) || 0;
        const strikes = parseInt(record.Strikes) || 0;
        const mph = record.RelSpeed ? parseInt(record.RelSpeed) : null;
        const spinRate = record.SpinRate ? parseInt(record.SpinRate) : null;
        const ivb = record.InducedVertBreak ? parseFloat(record.InducedVertBreak) : null;
        const hb = record.HorzBreak ? parseFloat(record.HorzBreak) : null;
        const batterHandedness = record.BatterSide ? (record.BatterSide === "Left" ? "LHH" : "RHH") : null;
        const exitVelocity = record.ExitSpeed ? parseInt(record.ExitSpeed) : null;
const korBB = record.KorBB || null;
        const playResult = record.PlayResult && record.PlayResult !== "Undefined" ? record.PlayResult : null;
        const runsScored = record.RunsScored ? parseInt(record.RunsScored) : null;
        const vertApprAngle = record.VertApprAngle ? parseFloat(record.VertApprAngle) : null;
        const direction = record.Direction && record.Direction !== "" ? parseFloat(record.Direction) : null;
        const launchAngle = record.Angle && record.Angle !== "" ? parseFloat(record.Angle) : null;
        const distance = record.Distance && record.Distance !== "" ? parseFloat(record.Distance) : null;
        const hitType = (record.TaggedHitType && record.TaggedHitType !== "Undefined")
          ? record.TaggedHitType
          : (record.AutoHitType && record.AutoHitType !== "Undefined" ? record.AutoHitType : null);

        pitchesToInsert.push({
          pitcherName,
          batterName,
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
          extension,
          relHeight,
          relSide,
          batterHandedness,
          exitVelocity,
          korBB,
          playResult,
          runsScored,
          vertApprAngle,
          direction,
          launchAngle,
          distance,
          hitType
        });
      }

      if (pitchesToInsert.length === 0) {
        return res.json({ success: false, error: "No valid pitch data found" });
      }
    } // end Trackman else block

    // ===== SHARED INSERT LOGIC (runs for both Rapsodo and Trackman) =====
    const pitcherMap = {};

    for (const [key, pitcher] of pitchers.entries()) {
      const existing = await pool.query(
        "SELECT id FROM pitchers WHERE name = $1",
        [pitcher.name]
      );

      let pitcherId;
      if (existing.rows.length > 0) {
        pitcherId = existing.rows[0].id;
        await pool.query(
          `UPDATE pitchers SET
             pitcher_throws = COALESCE(pitcher_throws, $1),
             team = COALESCE(team, $2)
           WHERE id = $3`,
          [pitcher.throws, pitcher.team, pitcherId]
        );
      } else {
        const newPitcher = await pool.query(
          "INSERT INTO pitchers (id, name, pitcher_throws, team) VALUES ($1, $2, $3, $4) RETURNING id",
          [crypto.randomUUID(), pitcher.name, pitcher.throws, pitcher.team]
        );
        pitcherId = newPitcher.rows[0].id;
      }

      pitcherMap[pitcher.name] = pitcherId;
    }

    // Seed any new team names into the teams table
    for (const [key, pitcher] of pitchers.entries()) {
      if (pitcher.team) {
        await pool.query(
          `INSERT INTO teams (raw_name, display_name) VALUES ($1, $1)
           ON CONFLICT (raw_name) DO NOTHING`,
          [pitcher.team]
        );
      }
    }

    const hitterMap = {};

    for (const [key, hitter] of hitters.entries()) {
      const existing = await pool.query(
        "SELECT id FROM hitters WHERE name = $1",
        [hitter.name]
      );

      let hitterId;
      if (existing.rows.length > 0) {
        hitterId = existing.rows[0].id;
      } else {
        const newHitter = await pool.query(
          "INSERT INTO hitters (id, name, bats, team) VALUES ($1, $2, $3, $4) RETURNING id",
          [crypto.randomUUID(), hitter.name, hitter.bats, hitter.team]
        );
        hitterId = newHitter.rows[0].id;
      }

      hitterMap[hitter.name] = hitterId;
    }

    const csvImportId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO csv_imports (id, session_id, pitch_count, pitcher_count)
       VALUES ($1, $2, $3, $4)`,
      [csvImportId, sessionId, pitchesToInsert.length, pitchers.size]
    );

    for (const pitch of pitchesToInsert) {
      const pitcherId = pitcherMap[pitch.pitcherName];
      const batterId = pitch.batterName ? hitterMap[pitch.batterName] : null;

      await pool.query(
`INSERT INTO pitches (id, session_id, pitcher_id, batter_id, pitch_type, balls, strikes, result, x, y, mph, spin_rate, ivb, hb, extension, rel_height, rel_side, batter_handedness, exit_velocity, csv_import_id, kor_bb, play_result, runs_scored, vert_appr_angle, direction, launch_angle, distance, hit_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)`,
        [
          crypto.randomUUID(),
          sessionId,
          pitcherId,
          batterId,
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
          csvImportId,
          pitch.korBB,
          pitch.playResult,
          pitch.runsScored,
          pitch.vertApprAngle,
          pitch.direction,
          pitch.launchAngle,
          pitch.distance,
          pitch.hitType
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

// Get aggregated metrics for a hitter broken down by pitch type they've faced
app.get("/hitter/:hitterId/metrics", async (req, res) => {
  const { hitterId } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const hitterCheck = await pool.query(
      "SELECT id, name, bats FROM hitters WHERE id = $1",
      [hitterId]
    );
    if (hitterCheck.rows.length === 0) {
      return res.json({ success: false, error: "Hitter not found" });
    }
    const hitter = hitterCheck.rows[0];

    const pitches = await pool.query(
      `SELECT pitch_type, result, x, y, exit_velocity, kor_bb, play_result
       FROM pitches
       WHERE batter_id = $1 AND pitch_type IS NOT NULL AND pitch_type != ''`,
      [hitterId]
    );

    if (pitches.rows.length === 0) {
      return res.json({
        success: true,
        hitter,
        pitchTypeStats: {},
        totalPitches: 0
      });
    }

    // Group by pitch type
    const groups = {};
    for (const p of pitches.rows) {
      const type = p.pitch_type || "?";
      if (!groups[type]) groups[type] = [];
      groups[type].push(p);
    }

    // Zone bounds (same 0-1 scale as stored)
    const ZONE_X_MIN = 0.25, ZONE_X_MAX = 0.75;
    const ZONE_Y_MIN = 0.25, ZONE_Y_MAX = 0.75;

    function inZone(p) {
      const x = parseFloat(p.x), y = parseFloat(p.y);
      return x >= ZONE_X_MIN && x <= ZONE_X_MAX && y >= ZONE_Y_MIN && y <= ZONE_Y_MAX;
    }
    
function isSwing(result) {
      return ["StrikeSwinging", "Foul", "InPlay"].includes(result);
    }
    
    function isWhiff(result) {
      return result === "StrikeSwinging";
    }
    
    const pitchTypeStats = {};
    for (const [type, typePitches] of Object.entries(groups)) {
      const total = typePitches.length;

      const swings = typePitches.filter(p => isSwing(p.result));
      const whiffs = typePitches.filter(p => isWhiff(p.result));

      // Chase = swings on pitches outside zone
      const outsideZone = typePitches.filter(p => !inZone(p));
      const chases = outsideZone.filter(p => isSwing(p.result));
      const chaseRate = outsideZone.length > 0
        ? Math.round((chases.length / outsideZone.length) * 100)
        : null;

      const whiffRate = swings.length > 0
        ? Math.round((whiffs.length / swings.length) * 100)
        : null;

      const bip = typePitches.filter(p => p.exit_velocity && parseFloat(p.exit_velocity) > 0);
      const hardHit = bip.filter(p => parseFloat(p.exit_velocity) >= 95);
      const hardHitPct = bip.length > 0
        ? Math.round((hardHit.length / bip.length) * 100)
        : null;

      const avgEV = bip.length > 0
        ? Math.round(bip.reduce((a, b) => a + parseFloat(b.exit_velocity), 0) / bip.length)
        : null;

const swingPct = total > 0
        ? Math.round((swings.length / total) * 100)
        : null;

      pitchTypeStats[type] = {
        total,
        swings: swings.length,
        whiffs: whiffs.length,
        whiffRate,
        swingPct,
        outsideZone: outsideZone.length,
        chases: chases.length,
        chaseRate,
        bip: bip.length,
        hardHit: hardHit.length,
        hardHitPct,
        avgEV
      };
    }

    res.json({
      success: true,
      hitter,
      pitchTypeStats,
      totalPitches: pitches.rows.length
    });

  } catch (err) {
    console.error("Hitter metrics error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Full hitter profile — stat line, batted ball profile, spray chart, splits
app.get("/hitter/:hitterId/profile", async (req, res) => {
  const { hitterId } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const hitterCheck = await pool.query(
      "SELECT id, name, bats, team FROM hitters WHERE id = $1",
      [hitterId]
    );
    if (hitterCheck.rows.length === 0) {
      return res.json({ success: false, error: "Hitter not found" });
    }
    const hitter = hitterCheck.rows[0];

    const pitches = await pool.query(
      `SELECT pitch_type, result, x, y, exit_velocity, kor_bb, play_result,
              runs_scored, batter_handedness, direction, launch_angle, distance,
              hit_type, balls, strikes, pitcher_id
       FROM pitches
       WHERE batter_id = $1`,
      [hitterId]
    );

    const rows = pitches.rows;
    if (rows.length === 0) {
      return res.json({ success: true, hitter, isEmpty: true });
    }

    // ===== STAT LINE =====
    const singles = rows.filter(p => p.play_result === "Single").length;
    const doubles = rows.filter(p => p.play_result === "Double").length;
    const triples = rows.filter(p => p.play_result === "Triple").length;
    const homers = rows.filter(p => p.play_result === "HomeRun").length;
    const hits = singles + doubles + triples + homers;
    const xbh = doubles + triples + homers;
    const walks = rows.filter(p => p.kor_bb === "Walk").length;
    const strikeouts = rows.filter(p => p.kor_bb === "Strikeout").length;
    const hbp = rows.filter(p => p.result === "HBP").length;
    const sac = rows.filter(p => p.play_result === "Sacrifice").length;
    const ab = rows.filter(p =>
      ["Single","Double","Triple","HomeRun","Out","Error"].includes(p.play_result) || p.kor_bb === "Strikeout"
    ).length;
    const pa = ab + walks + hbp + sac;

    // OBP = (H + BB + HBP) / (AB + BB + HBP + SF)
    const obp = pa > 0 ? ((hits + walks + hbp) / (ab + walks + hbp + sac)).toFixed(3) : ".000";
    // SLG = (1B + 2*2B + 3*3B + 4*HR) / AB
    const slg = ab > 0 ? ((singles + 2*doubles + 3*triples + 4*homers) / ab).toFixed(3) : ".000";
    // OPS
    const ops = (parseFloat(obp) + parseFloat(slg)).toFixed(3);
    // wOBA (simplified: BB*0.69 + HBP*0.72 + 1B*0.888 + 2B*1.271 + 3B*1.616 + HR*2.101) / (AB + BB - IBB + SF + HBP)
    const woba = pa > 0
      ? ((walks*0.69 + hbp*0.72 + singles*0.888 + doubles*1.271 + triples*1.616 + homers*2.101) / (ab + walks + hbp + sac)).toFixed(3)
      : ".000";

    // ===== BATTED BALL PROFILE =====
    const bip = rows.filter(p => p.hit_type && p.hit_type !== "Undefined");
    const gbCount = bip.filter(p => p.hit_type === "GroundBall").length;
    const ldCount = bip.filter(p => p.hit_type === "LineDrive").length;
    const fbCount = bip.filter(p => p.hit_type === "FlyBall").length;
    const puCount = bip.filter(p => p.hit_type === "Popup").length;
    const bipTotal = bip.length;

    const gbPct = bipTotal > 0 ? ((gbCount / bipTotal) * 100).toFixed(1) : "0.0";
    const ldPct = bipTotal > 0 ? ((ldCount / bipTotal) * 100).toFixed(1) : "0.0";
    const fbPct = bipTotal > 0 ? ((fbCount / bipTotal) * 100).toFixed(1) : "0.0";
    const puPct = bipTotal > 0 ? ((puCount / bipTotal) * 100).toFixed(1) : "0.0";

    // ===== CONTACT QUALITY =====
    const evRows = rows.filter(p => p.exit_velocity && parseFloat(p.exit_velocity) > 0);
    const avgEV = evRows.length > 0
      ? (evRows.reduce((a, b) => a + parseFloat(b.exit_velocity), 0) / evRows.length).toFixed(1)
      : null;
    const hardHit = evRows.filter(p => parseFloat(p.exit_velocity) >= 95).length;
    const hardHitPct = evRows.length > 0 ? ((hardHit / evRows.length) * 100).toFixed(1) : null;

    // Sweet spot % = launch angle 8-32 degrees
    const laRows = rows.filter(p => p.launch_angle !== null && p.launch_angle !== undefined);
    const sweetSpot = laRows.filter(p => parseFloat(p.launch_angle) >= 8 && parseFloat(p.launch_angle) <= 32).length;
    const sweetSpotPct = laRows.length > 0 ? ((sweetSpot / laRows.length) * 100).toFixed(1) : null;

    // ===== SPRAY CHART DATA =====
    const sprayData = rows
      .filter(p => p.direction !== null && p.exit_velocity && parseFloat(p.exit_velocity) > 0)
      .map(p => ({
        direction: parseFloat(p.direction),
        distance: p.distance ? parseFloat(p.distance) : 150,
        exitVelocity: parseFloat(p.exit_velocity),
        playResult: p.play_result,
        hitType: p.hit_type,
        launchAngle: p.launch_angle ? parseFloat(p.launch_angle) : null
      }));

    // ===== PITCH TYPE BREAKDOWN =====
    const pitchGroups = {};
    rows.forEach(p => {
      const type = p.pitch_type || "?";
      if (!pitchGroups[type]) pitchGroups[type] = [];
      pitchGroups[type].push(p);
    });

    const ZONE_X_MIN = 0.25, ZONE_X_MAX = 0.75;
    const ZONE_Y_MIN = 0.25, ZONE_Y_MAX = 0.75;
    const inZone = (p) => parseFloat(p.x) >= ZONE_X_MIN && parseFloat(p.x) <= ZONE_X_MAX && parseFloat(p.y) >= ZONE_Y_MIN && parseFloat(p.y) <= ZONE_Y_MAX;
    const isSwing = (r) => ["StrikeSwinging","Foul","InPlay"].includes(r);
    const isWhiff = (r) => r === "StrikeSwinging";

    const pitchTypeStats = {};
    Object.entries(pitchGroups).forEach(([type, typePitches]) => {
      const total = typePitches.length;
      const swings = typePitches.filter(p => isSwing(p.result));
      const whiffs = typePitches.filter(p => isWhiff(p.result));
      const outsideZone = typePitches.filter(p => !inZone(p));
      const chases = outsideZone.filter(p => isSwing(p.result));
      const bipType = typePitches.filter(p => p.exit_velocity && parseFloat(p.exit_velocity) > 0);
      const hardHitType = bipType.filter(p => parseFloat(p.exit_velocity) >= 95);

      pitchTypeStats[type] = {
        total,
        swingPct: total > 0 ? Math.round((swings.length / total) * 100) : null,
        whiffRate: swings.length > 0 ? Math.round((whiffs.length / swings.length) * 100) : null,
        chaseRate: outsideZone.length > 0 ? Math.round((chases.length / outsideZone.length) * 100) : null,
        avgEV: bipType.length > 0 ? (bipType.reduce((a,b) => a + parseFloat(b.exit_velocity), 0) / bipType.length).toFixed(1) : null,
        hardHitPct: bipType.length > 0 ? ((hardHitType.length / bipType.length) * 100).toFixed(1) : null
      };
    });

    // ===== HANDEDNESS SPLITS =====
    const vsRHP = rows.filter(p => p.batter_handedness !== null);
    // Get pitcher handedness from pitchers table
    const pitcherIds = [...new Set(rows.map(p => p.pitcher_id).filter(Boolean))];
    const pitcherHandedness = {};
    if (pitcherIds.length > 0) {
      const phResult = await pool.query(
        `SELECT id, pitcher_throws FROM pitchers WHERE id = ANY($1)`,
        [pitcherIds]
      );
      phResult.rows.forEach(p => { pitcherHandedness[p.id] = p.pitcher_throws; });
    }

    const vsRHPRows = rows.filter(p => pitcherHandedness[p.pitcher_id] === "Right");
    const vsLHPRows = rows.filter(p => pitcherHandedness[p.pitcher_id] === "Left");

    function splitStats(splitRows) {
      const sng = splitRows.filter(p => p.play_result === "Single").length;
      const dbl = splitRows.filter(p => p.play_result === "Double").length;
      const tri = splitRows.filter(p => p.play_result === "Triple").length;
      const hr = splitRows.filter(p => p.play_result === "HomeRun").length;
      const h = sng + dbl + tri + hr;
      const bb = splitRows.filter(p => p.kor_bb === "Walk").length;
      const hbpS = splitRows.filter(p => p.result === "HBP").length;
      const sacS = splitRows.filter(p => p.play_result === "Sacrifice").length;
      const abS = splitRows.filter(p =>
        ["Single","Double","Triple","HomeRun","Out","Error"].includes(p.play_result) || p.kor_bb === "Strikeout"
      ).length;
      const obpS = (abS + bb + hbpS + sacS) > 0 ? ((h + bb + hbpS) / (abS + bb + hbpS + sacS)).toFixed(3) : ".000";
      const slgS = abS > 0 ? ((sng + 2*dbl + 3*tri + 4*hr) / abS).toFixed(3) : ".000";
      const opsS = (parseFloat(obpS) + parseFloat(slgS)).toFixed(3);
      const evS = splitRows.filter(p => p.exit_velocity && parseFloat(p.exit_velocity) > 0);
      const avgEVS = evS.length > 0 ? (evS.reduce((a,b) => a + parseFloat(b.exit_velocity), 0) / evS.length).toFixed(1) : null;
      return { pitches: splitRows.length, ab: abS, h, bb, k: splitRows.filter(p => p.kor_bb === "Strikeout").length, obp: obpS, slg: slgS, ops: opsS, avgEV: avgEVS };
    }

// ===== ZONE HEAT MAP =====
    function buildZoneGrid(pitchRows) {
      const zoneData = Array(3).fill(null).map(() => Array(3).fill(null).map(() => ({
        pitches: 0, evSum: 0, evCount: 0, swings: 0,
        hits: 0, ab: 0, pitchTypes: {}
      })));

      pitchRows.forEach(p => {
        const x = parseFloat(p.x), y = parseFloat(p.y);
        if (isNaN(x) || isNaN(y)) return;
        const col = x < 0.417 ? 0 : x < 0.583 ? 1 : 2;
        const row = y > 0.583 ? 0 : y > 0.417 ? 1 : 2;
        if (col < 0 || col > 2 || row < 0 || row > 2) return;

        const cell = zoneData[row][col];
        cell.pitches++;

        if (p.exit_velocity && parseFloat(p.exit_velocity) > 0) {
          cell.evSum += parseFloat(p.exit_velocity);
          cell.evCount++;
        }

        if (isSwing(p.result)) cell.swings++;

        // BA tracking — count ABs and hits per zone
        const isAB = ["Single","Double","Triple","HomeRun","Out","Error"].includes(p.play_result) || p.kor_bb === "Strikeout";
        const isHit = ["Single","Double","Triple","HomeRun"].includes(p.play_result);
        if (isAB) cell.ab++;
        if (isHit) cell.hits++;

        // Pitch types put in play from this zone
        if (p.result === "InPlay" && p.pitch_type) {
          cell.pitchTypes[p.pitch_type] = (cell.pitchTypes[p.pitch_type] || 0) + 1;
        }
      });

      return zoneData.map(row =>
        row.map(cell => ({
          pitches: cell.pitches,
          avgEV: cell.evCount > 0 ? (cell.evSum / cell.evCount).toFixed(1) : null,
          swingPct: cell.pitches > 0 ? Math.round((cell.swings / cell.pitches) * 100) : null,
          ba: cell.ab > 0 ? (cell.hits / cell.ab).toFixed(3) : null,
          pitchTypes: Object.entries(cell.pitchTypes)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => ({ type, count })),
          ab: cell.ab,
          hits: cell.hits
        }))
      );
    }

    const zoneGrid = buildZoneGrid(rows);
    const zoneGridVsRHP = buildZoneGrid(vsRHPRows);
    const zoneGridVsLHP = buildZoneGrid(vsLHPRows);

res.json({
      success: true,
      hitter,
      totalPitches: rows.length,
      statLine: { ab, hits, xbh, homers, walks, strikeouts, hbp, obp, slg, ops, woba, pa },
      contactQuality: { avgEV, hardHitPct, sweetSpotPct, bipTotal: evRows.length },
      battedBallProfile: { gbPct, ldPct, fbPct, puPct, gbCount, ldCount, fbCount, puCount, bipTotal },
      sprayData,
      pitchTypeStats,
      handednessSplits: {
        vsRHP: splitStats(vsRHPRows),
        vsLHP: splitStats(vsLHPRows)
      },
      zoneGrid,
      zoneGridVsRHP,
      zoneGridVsLHP
    });

  } catch (err) {
    console.error("Hitter profile error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Get all teams with display names
app.get("/teams", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const result = await pool.query(
      `SELECT raw_name, display_name FROM teams ORDER BY display_name ASC`
    );
    res.json({ success: true, teams: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Rename a team's display name everywhere
app.patch("/team/rename", async (req, res) => {
  const { token, rawName, displayName } = req.body;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  if (!rawName || !displayName) {
    return res.json({ success: false, error: "Missing rawName or displayName" });
  }

  try {
    await pool.query(
      `INSERT INTO teams (raw_name, display_name) VALUES ($1, $2)
       ON CONFLICT (raw_name) DO UPDATE SET display_name = $2`,
      [rawName, displayName]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Assign a pitcher to a team
app.patch("/pitcher/:pitcherId/team", async (req, res) => {
  const { pitcherId } = req.params;
  const { token, team } = req.body;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    await pool.query(
      `UPDATE pitchers SET team = $1 WHERE id = $2`,
      [team, pitcherId]
    );
    // Make sure this team exists in the teams table
    if (team) {
      await pool.query(
        `INSERT INTO teams (raw_name, display_name) VALUES ($1, $1)
         ON CONFLICT (raw_name) DO NOTHING`,
        [team]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Assign a hitter to a team
app.patch("/hitter/:hitterId/team", async (req, res) => {
  const { hitterId } = req.params;
  const { token, team } = req.body;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    await pool.query(
      `UPDATE hitters SET team = $1 WHERE id = $2`,
      [team, hitterId]
    );
    if (team) {
      await pool.query(
        `INSERT INTO teams (raw_name, display_name) VALUES ($1, $1)
         ON CONFLICT (raw_name) DO NOTHING`,
        [team]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ======================================
// GAMECHANGER ENDPOINTS
// ======================================

// Temporary debug endpoint — remove after fixing parser
app.post("/debug-gc-pdf", gcUpload.fields([{ name: "pdf", maxCount: 1 }]), async (req, res) => {
  const file = req.files?.pdf?.[0];
  const scorebookFile = req.files?.scorebook?.[0] || null;
  if (!file) return res.json({ success: false, error: "No box score PDF received" });
  const fs = require("fs");
  const pdfBuffer = fs.readFileSync(file.path);
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(pdfBuffer, { pagerender: null, max: 0 });
  const pages = data.text.split('\f');
  res.json({
    numPages: pages.length,
    page0Lines: pages[0]?.split('\n').filter(l => l.trim()).slice(0, 15),
    page1Lines: pages[1]?.split('\n').filter(l => l.trim()).slice(0, 15),
    rawFirst500: data.text.substring(0, 500),
  });
});

// Upload a GameChanger scorebook PDF
app.post("/upload-gc", gcUpload.fields([{ name: "pdf", maxCount: 1 }, { name: "scorebook", maxCount: 1 }]), async (req, res) => {
  const file = req.files?.pdf?.[0];
  const scorebookFile = req.files?.scorebook?.[0] || null;
  const { token } = req.body;
  if (!file) return res.json({ success: false, error: "No box score PDF received" });

  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const fs = require("fs");
const pdfBuffer = fs.readFileSync(file.path);
    
    const pdfParse = require('pdf-parse');
    const debugData = await pdfParse(pdfBuffer, { pagerender: null, max: 0 });
    console.log('=== GC BOX SCORE DEBUG ===');
    console.log('pdf file:', file?.originalname, 'size:', file?.size);
    console.log('scorebook file:', scorebookFile?.originalname, 'size:', scorebookFile?.size);
    console.log('Text length:', debugData.text.length);
    console.log('First 300 chars:', JSON.stringify(debugData.text.substring(0, 300)));
    
    const game = await parseGCScorebook(pdfBuffer);
    console.log('Parsed teams:', game.teams);
    console.log('Batting keys team0:', Object.keys(game.batting[game.teams[0]] || {}));
    console.log('Parsed teams:', game.teams);
    console.log('Parsed date:', game.date);
    console.log('Page 0 batting keys:', Object.keys(game.batting[game.teams[0]] || {}));
    console.log('Page 1 batting keys:', Object.keys(game.batting[game.teams[1]] || {}));
    const fullLines = debugData.text.split('\n').slice(0, 40);
    console.log('Full lines 0-40:', JSON.stringify(fullLines));
    if (!game.teams || game.teams.length === 0) {
      return res.json({ success: false, error: "Could not parse teams from PDF" });
    }

    const results = [];

    for (let i = 0; i < game.teams.length; i++) {
      const teamName = game.teams[i];
      const oppTeam = game.teams.find((t, idx) => idx !== i) || "Unknown";
      const homeAway = game.homeAway[i] || null;

      // Insert game record
      const gameResult = await pool.query(
        `INSERT INTO gc_games (id, user_id, team_name, opponent, game_date, home_away)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [crypto.randomUUID(), user.id, teamName, oppTeam, game.date, homeAway]
      );
      const gcGameId = gameResult.rows[0].id;

// Insert batting stats
      const batting = game.batting[teamName] || {};
      for (const [playerKey, pdata] of Object.entries(batting)) {
        const line = computeBattingLine(pdata);
        if (!line || line.ab === 0) continue;
        
        await pool.query(
          `INSERT INTO gc_batting (id, gc_game_id, team_name, jersey, player_name, position,
            pa, ab, h, singles, doubles, triples, hr, xbh, r, rbi, bb, ks, ks_swing, ks_look,
            hbp, sac, fc, roe, sb, cs, avg, obp, slg, ops, iso, woba,
            gb_pct, ld_pct, fb_pct, gb_fb, spray_l, spray_c, spray_r,
            total_pitches_seen, fps_pct, raw_at_bats)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                   $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,
                   $35,$36,$37,$38,$39,$40)`,
          [
            crypto.randomUUID(), gcGameId, teamName, pdata.jersey, pdata.name, pdata.position,
            line.pa, line.ab, line.h, line.singles, line.doubles, line.triples, line.hr, line.xbh,
            line.r || 0, line.rbi || 0, line.bb, line.ks, line.ksSwing, line.ksLook, line.hbp, line.sac, line.fc, line.roe,
            line.sb, line.cs, line.avg, line.obp, line.slg, line.ops, line.iso, line.woba,
            line.gbPct, line.ldPct, line.fbPct, line.gbFb, line.sprayL, line.sprayC, line.sprayR,
            line.totalPitchesSeen, line.fpsPct, JSON.stringify(pdata.atBats)
          ]
        );
      }

// Insert pitching stats
      const pitching = game.pitching[teamName] || {};
      for (const [pitcherName, pitcher] of Object.entries(pitching)) {
        const line = computePitchingLine(pitcher);
        if (!line) continue;
        
        await pool.query(
          `INSERT INTO gc_pitching (id, gc_game_id, team_name, player_name,
            ip, bf, h, bb, ks, ks_swing, ks_look, hbp, hr, wp,
            k9, bb9, h9, whip, kbb, k_pct, bb_pct,
            gb_pct, ld_pct, fb_pct, fps_pct, strike_pct,
            total_pitches, avg_p_per_bf, avg_p_per_inn, innings)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                   $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
          [
            crypto.randomUUID(), gcGameId, teamName, pitcherName,
            line.ip, line.bf, line.h, line.bb, line.ks, line.ksSwing, line.ksLook,
            line.hbp, line.hr, line.wp, line.k9, line.bb9, line.h9, line.whip, line.kbb,
            line.kPct, line.bbPct, line.gbPct, line.ldPct, line.fbPct,
            line.fpsPct, line.strikePct, line.totalPitches,
            line.avgPPerBF, line.avgPPerInn, JSON.stringify(line.innings)
          ]
        );
      }

      results.push({ teamName, gcGameId });
    }

    res.json({ success: true, games: results });

  } catch (err) {
    console.error("GC upload error:", err);
    res.json({ success: false, error: err.message });
  }
});

// List all GC games for this user
app.get("/gc-games", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const result = await pool.query(
      `SELECT id, team_name, opponent, game_date, home_away, created_at
       FROM gc_games WHERE user_id = $1 ORDER BY game_date DESC, created_at DESC`,
      [user.id]
    );
    res.json({ success: true, games: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get full game box score
app.get("/gc-game/:gameId", async (req, res) => {
  const { gameId } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const gameCheck = await pool.query(
      "SELECT * FROM gc_games WHERE id = $1 AND user_id = $2",
      [gameId, user.id]
    );
    if (gameCheck.rows.length === 0) return res.json({ success: false, error: "Game not found" });

    const batting = await pool.query(
      "SELECT * FROM gc_batting WHERE gc_game_id = $1 ORDER BY team_name, pa DESC",
      [gameId]
    );
    const pitching = await pool.query(
      "SELECT * FROM gc_pitching WHERE gc_game_id = $1 ORDER BY team_name, ip DESC",
      [gameId]
    );

    res.json({
      success: true,
      game: gameCheck.rows[0],
      batting: batting.rows,
      pitching: pitching.rows
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get aggregated GC stats for a player across all games
app.get("/gc-player/:playerName", async (req, res) => {
  const { playerName } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const batting = await pool.query(
      `SELECT b.*, g.game_date, g.opponent, g.home_away
       FROM gc_batting b
       JOIN gc_games g ON b.gc_game_id = g.id
       WHERE g.user_id = $1 AND LOWER(b.player_name) = LOWER($2)
       ORDER BY g.game_date DESC`,
      [user.id, playerName]
    );

    const pitching = await pool.query(
      `SELECT p.*, g.game_date, g.opponent, g.home_away
       FROM gc_pitching p
       JOIN gc_games g ON p.gc_game_id = g.id
       WHERE g.user_id = $1 AND LOWER(p.player_name) = LOWER($2)
       ORDER BY g.game_date DESC`,
      [user.id, playerName]
    );

    res.json({
      success: true,
      playerName,
      batting: batting.rows,
      pitching: pitching.rows
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get all GC players for this user
app.get("/gc-players", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    const result = await pool.query(
      `SELECT DISTINCT b.player_name, b.team_name, b.jersey,
              COUNT(DISTINCT b.gc_game_id) as games
       FROM gc_batting b
       JOIN gc_games g ON b.gc_game_id = g.id
       WHERE g.user_id = $1
       GROUP BY b.player_name, b.team_name, b.jersey
       ORDER BY b.team_name, b.player_name`,
      [user.id]
    );
    res.json({ success: true, players: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Delete a GC game
app.delete("/gc-game/:gameId", async (req, res) => {
  const { gameId } = req.params;
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);
  if (!user) return res.json({ success: false, error: "Invalid token" });

  try {
    await pool.query(
      "DELETE FROM gc_games WHERE id = $1 AND user_id = $2",
      [gameId, user.id]
    );
    res.json({ success: true });
  } catch (err) {
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
  if (!pitchCall) return null;
  const map = {
    'StrikeSwinging': 'StrikeSwinging',
    'StrikeCalled': 'StrikeCalled',
    'FoulBall': 'Foul',
    'FoulBallNotFieldable': 'Foul',
    'FoulBallFieldable': 'Foul',
    'BallCalled': 'Ball',
    'HitByPitch': 'HBP',
    'InPlay': 'InPlay',
    'BallIntentional': 'Ball',
    'AutomaticStrike': 'StrikeCalled',
    'AutomaticBall': 'Ball',
  };
  return map[pitchCall.trim()] || null;
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
    // Strikeouts / walks — Trackman's KorBB column, "Strikeout" or "Walk"
    if (p.kor_bb === 'Strikeout') {
      strikeouts++;
    }
    if (p.kor_bb === 'Walk') {
      walks++;
    }
    // HBP — already captured correctly via the existing result column
    if (p.result === 'HBP') {
      hbp++;
    }
    // Home Runs — Trackman's PlayResult is "Homerun" (one word, lowercase r)
    if (p.play_result === 'Homerun') {
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

      // VAA (Vertical Approach Angle)
      const vaas = typePitches.filter(p => p.vert_appr_angle !== null && p.vert_appr_angle !== undefined).map(p => parseFloat(p.vert_appr_angle));
      const avgVAA = vaas.length > 0
        ? (vaas.reduce((a,b) => a+b) / vaas.length).toFixed(2)
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
        avgVAA,
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
    const pitchSequencing = calculatePitchSequencing(pitches);

    const metricsForReport = {
      pitcherName, pitcherThrows, pitchStats, allPitches: pitches, ...advancedScouting
    };
    const aiScoutingReport = generateAIScoutingReport(metricsForReport);

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
      pitchSequencing,
      aiScoutingReport,
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

// ======================================
// PITCH SEQUENCING
// ======================================
// For each pitch type, finds which pitch type follows it most often.
// Sequenced only within the same session — the last pitch of one session
// never counts as "followed by" the first pitch of a different session.
function calculatePitchSequencing(pitches) {
  const bySession = {};
  pitches.forEach(p => {
    const sid = p.session_id;
    if (!bySession[sid]) bySession[sid] = [];
    bySession[sid].push(p);
  });

  const followCounts = {};
  Object.values(bySession).forEach(sessionPitches => {
    for (let i = 0; i < sessionPitches.length - 1; i++) {
      const current = sessionPitches[i].pitch_type || "?";
      const next = sessionPitches[i + 1].pitch_type || "?";
      if (!followCounts[current]) followCounts[current] = {};
      followCounts[current][next] = (followCounts[current][next] || 0) + 1;
    }
  });

  return Object.entries(followCounts).map(([type, nextCounts]) => {
    const total = Object.values(nextCounts).reduce((a, b) => a + b, 0);
    const ranked = Object.entries(nextCounts)
      .map(([nextType, count]) => ({ nextType, count, pct: ((count / total) * 100).toFixed(1) }))
      .sort((a, b) => b.count - a.count);
    return { type, totalFollowed: total, topFollowUp: ranked[0] || null, breakdown: ranked };
  }).sort((a, b) => b.totalFollowed - a.totalFollowed);
}

// ======================================
// AI GENERATED SCOUTING REPORT
// ======================================
// Rule-based report generation (not a live LLM call) — same approach as the
// existing Pitch Shape Summary. Arm angle follows Statcast's public
// definition (0deg = sidearm, 90deg = over the top), but since Trackman
// doesn't give us actual pitcher height, shoulder height is an assumed
// constant (5.5 ft) rather than derived per-pitcher — treat the angle as an
// estimate, not an exact Statcast-style measurement.
function calculateArmAngle(pitches) {
  const withRelease = pitches.filter(p => p.rel_height !== null && p.rel_height !== undefined && p.rel_side !== null && p.rel_side !== undefined);
  if (withRelease.length === 0) return null;

  const avgRelHeight = withRelease.reduce((sum, p) => sum + parseFloat(p.rel_height), 0) / withRelease.length;
  const avgRelSide = withRelease.reduce((sum, p) => sum + Math.abs(parseFloat(p.rel_side)), 0) / withRelease.length;

  // Recalibrated against a real known example (5ft release height, 2ft
  // release side = textbook High 3/4). Without actual pitcher height on
  // file, this constant can't be exactly right at every arm slot at once —
  // if you run into another clearly-mislabeled real pitcher, that's a sign
  // this needs another calibration pass, not a one-time fix.
  const ASSUMED_SHOULDER_HEIGHT_FT = 1.5;
  const verticalComponent = avgRelHeight - ASSUMED_SHOULDER_HEIGHT_FT;
  const angleDegrees = Math.atan2(verticalComponent, avgRelSide) * (180 / Math.PI);

  let classification;
  if (angleDegrees >= 68) classification = "Over the Top";
  else if (angleDegrees >= 45) classification = "High 3/4";
  else if (angleDegrees >= 25) classification = "Low 3/4";
  else if (angleDegrees >= 5) classification = "Side Arm";
  else classification = "Submarine";

  return { angleDegrees: Math.round(angleDegrees), classification, avgRelHeight: avgRelHeight.toFixed(2), avgRelSide: avgRelSide.toFixed(2) };
}

// 20-80 scouting-scale estimate. 50 = MLB-average velocity for that pitch
// type (roughly 93mph fastball, per Baseball America's published benchmark)
// blended with CSW% vs a ~28% MLB-average baseline. This is an approximation
// from tracked data, not an official scout's grade.
const PITCH_VELO_BASELINES = { FB: 93, SN: 93, CT: 89, SL: 85, CB: 79, CH: 85, SP: 85, KN: 77 };
const CSW_BASELINE = 28;

function estimatePitchGrade(pitchType, avgVelo, csw) {
  const veloBaseline = PITCH_VELO_BASELINES[pitchType] ?? 88;
  const velo = parseFloat(avgVelo);
  const cswNum = parseFloat(csw);

  const veloComponent = isNaN(velo) ? 50 : 50 + ((velo - veloBaseline) / 3) * 10;
  const cswComponent = isNaN(cswNum) ? 50 : 50 + ((cswNum - CSW_BASELINE) / 5) * 10;

  const combined = (veloComponent * 0.6) + (cswComponent * 0.4);
  const clamped = Math.max(20, Math.min(80, combined));
  return Math.round(clamped / 5) * 5;
}

function estimateOverallGrade(pitchStats, pitchGrades) {
  let weightedSum = 0, totalUsage = 0;
  Object.entries(pitchStats).forEach(([type, stats]) => {
    const usage = parseFloat(stats.usage);
    weightedSum += pitchGrades[type] * usage;
    totalUsage += usage;
  });
  const raw = totalUsage > 0 ? weightedSum / totalUsage : 50;
  return Math.max(20, Math.min(80, Math.round(raw / 5) * 5));
}

function generateAIScoutingReport(metrics) {
  const nameParts = (metrics.pitcherName || "Unknown Pitcher").trim().split(/\s+/);
  const firstName = nameParts[0] || "—";
  const lastName = nameParts.slice(1).join(" ") || "—";

  const throwSide = metrics.pitcherThrows === "Left" ? "LHP" : (metrics.pitcherThrows === "Right" ? "RHP" : "—");
  const armAngle = calculateArmAngle(metrics.allPitches);

  const pitchGrades = {};
  Object.entries(metrics.pitchStats).forEach(([type, stats]) => {
    pitchGrades[type] = estimatePitchGrade(type, stats.avgVelo, stats.csw);
  });
  const overallGrade = estimateOverallGrade(metrics.pitchStats, pitchGrades);

  const veloRanges = Object.entries(metrics.pitchStats).map(([type, stats]) => ({
    type, min: stats.minVelo, max: stats.maxVelo, grade: pitchGrades[type]
  }));

  let weaknesses = [];
  if (metrics.weakestPitch) {
    weaknesses.push(`${metrics.weakestPitch.type} gets hit hard (${metrics.weakestPitch.hardHitPercent}% hard-hit, ${metrics.weakestPitch.avgEV} mph avg EV allowed).`);
  }
  const worstZonePitch = Object.entries(metrics.pitchStats)
    .filter(([, s]) => s.zonePercent !== "—")
    .sort((a, b) => parseFloat(a[1].zonePercent) - parseFloat(b[1].zonePercent))[0];
  if (worstZonePitch) {
    weaknesses.push(`${worstZonePitch[0]} lands in the zone only ${worstZonePitch[1].zonePercent}% of the time.`);
  }
  const weaknessesSummary = weaknesses.length ? weaknesses.join(" ") : "Not enough data yet to identify clear weaknesses.";

  let strengths = [];
  if (metrics.outPitches?.primary) {
    strengths.push(`${metrics.outPitches.primary.type} is a reliable put-away pitch (${metrics.outPitches.primary.csw}% CSW in two-strike counts).`);
  }
  const bestCSWPitch = Object.entries(metrics.pitchStats)
    .filter(([, s]) => s.csw !== "—")
    .sort((a, b) => parseFloat(b[1].csw) - parseFloat(a[1].csw))[0];
  if (bestCSWPitch) {
    strengths.push(`${bestCSWPitch[0]} generates the most called strikes and whiffs (${bestCSWPitch[1].csw}% CSW).`);
  }
  const strengthsSummary = strengths.length ? strengths.join(" ") : "Not enough data yet to identify clear strengths.";

  const attackPitch = metrics.outPitches?.primary?.type || metrics.firstPitchTendencies?.primaryType || "their primary pitch";
  const improvePitch = metrics.weakestPitch?.type || worstZonePitch?.[0] || "their secondary offerings";
  const overallSummary = `${firstName} ${lastName} should continue to lean on ${attackPitch} as a foundation of the arsenal. ` +
    `The clearest area for improvement is ${improvePitch} — tightening its location and usage in counts where it's currently getting hit or missing the zone would raise the overall profile.`;

  return {
    firstName, lastName, throwSide, armAngle, pitchGrades, overallGrade,
    veloRanges, weaknessesSummary, strengthsSummary, overallSummary
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
      pitchSequencing: metrics.pitchSequencing,
      aiScoutingReport: metrics.aiScoutingReport
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

// Bulk-reclassify every "?" pitch for a pitcher to a real pitch type. If
// sessionId is provided, scoped to just that session; otherwise scoped to
// every session this user owns for that pitcher (career-wide).
app.patch("/pitcher/:pitcherId/reclassify-unknown", async (req, res) => {
  const { pitcherId } = req.params;
  const { token, newPitchType, sessionId } = req.body;

  const user = await verifyToken(token);
  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  if (!newPitchType) {
    return res.json({ success: false, error: "Missing newPitchType" });
  }

  try {
    let result;
    if (sessionId) {
      const sessionCheck = await pool.query(
        "SELECT id FROM sessions WHERE id = $1 AND user_id = $2",
        [sessionId, user.id]
      );
      if (sessionCheck.rows.length === 0) {
        return res.json({ success: false, error: "Session not found" });
      }

      result = await pool.query(
        `UPDATE pitches SET pitch_type = $1
         WHERE pitcher_id = $2 AND pitch_type = '?' AND session_id = $3
         RETURNING id`,
        [newPitchType, pitcherId, sessionId]
      );
    } else {
      result = await pool.query(
        `UPDATE pitches SET pitch_type = $1
         WHERE pitcher_id = $2 AND pitch_type = '?'
           AND session_id IN (SELECT id FROM sessions WHERE user_id = $3)
         RETURNING id`,
        [newPitchType, pitcherId, user.id]
      );
    }

    res.json({ success: true, updatedCount: result.rows.length });

  } catch (err) {
    console.error("Reclassify unknown pitch error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Get all hitters with sessions belonging to this user (mirrors /all-pitchers)

app.get("/all-hitters", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  const user = await verifyToken(token);

  if (!user) {
    return res.json({ success: false, error: "Invalid token" });
  }

  try {
    const result = await pool.query(
      `SELECT DISTINCT h.id, h.name, h.bats, h.team
       FROM hitters h
       JOIN pitches pt ON h.id = pt.batter_id
       JOIN sessions s ON pt.session_id = s.id
       WHERE s.user_id = $1
       ORDER BY h.name`,
      [user.id]
    );

    const hittersFormatted = result.rows.map(h => ({
      id: h.id,
      name: h.name,
      bats: h.bats,
      team: h.team
    }));

    res.json({ success: true, hitters: hittersFormatted });

  } catch (err) {
    console.error("All hitters error:", err);
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
      advancedStats: metrics.advancedStats,
      pitchSequencing: metrics.pitchSequencing,
      aiScoutingReport: metrics.aiScoutingReport
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

app.get("/debug/results", async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT result FROM pitches ORDER BY result');
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
