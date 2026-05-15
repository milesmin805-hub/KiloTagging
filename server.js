const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const cors = require("cors");
const session = require("express-session");
const http = require("http");

const app = express();
const server = http.createServer(app);
const { initWebSocket, broadcastSessionUpdate } = require("./ws-server");

const PORT = process.env.PORT || 3000;

// Shared in-memory session store
const sessions = {}; 

// ------------------------------
// Middleware
// ------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/clips", express.static("clips"));
app.use("/pdfs", express.static("pdfs"));

app.use(
  session({
    secret: "super-secret-key",
    resave: false,
    saveUninitialized: true
  })
);

// Ensure folders exist
["clips", "pdfs", "public/sessions"].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ------------------------------
// Multer storage for clip uploads
// ------------------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "clips");
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `clip_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

app.post("/upload-clip", upload.single("clip"), (req, res) => {
  const filename = req.file.filename;
  const clipURL = `/clips/${filename}`;

  broadcastSessionUpdate(req.session.code, {
    type: "clip",
    name: filename.replace(".mp4", ""),
    url: clipURL
  });

  res.json({ success: true, url: clipURL });
});

// ------------------------------
// Login (shared session code)
// ------------------------------
app.post("/login", (req, res) => {
  const { code } = req.body;

  if (!code) return res.json({ success: false });

  req.session.code = code;

  if (!sessions[code]) {
    sessions[code] = { camera: "disconnected", tagger: "disconnected" };
  }

  res.json({ success: true, code });
});

// ------------------------------
// Set role
// ------------------------------
app.post("/setRole", (req, res) => {
  const { role } = req.body;
  const code = req.session.code;

  if (!code || !sessions[code]) {
    return res.json({ success: false });
  }

  if (role === "camera") {
    sessions[code].camera = "connected";
  } else if (role === "tagger") {
    sessions[code].tagger = "connected";
  }

  broadcastSessionUpdate(code);

  res.json({ success: true });
});

// ------------------------------
// Save session to disk
// ------------------------------
app.post("/save-session", (req, res) => {
  const sessionData = req.body;
  const filename = `session_${Date.now()}.json`;

  fs.writeFileSync(`public/sessions/${filename}`, JSON.stringify(sessionData, null, 2));

  res.json({ url: `/sessions/${filename}` });
});

// ------------------------------
// Pitcher data
// ------------------------------
app.get("/pitchers", (req, res) => {
  const data = fs.readFileSync("public/pitchers.json", "utf8");
  res.json(JSON.parse(data));
});

app.post("/save-pitchers", (req, res) => {
  fs.writeFileSync("public/pitchers.json", JSON.stringify(req.body, null, 2));
  res.json({ success: true });
});

// ------------------------------
// List saved sessions
// ------------------------------
app.get("/list-sessions", (req, res) => {
  const files = fs.readdirSync("public/sessions").filter(f => f.endsWith(".json"));
  res.json(files);
});

// ------------------------------
// Serve saved session
// ------------------------------
app.get("/sessions/:file", (req, res) => {
  const filePath = path.join("public/sessions", req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.resolve(filePath));
});

// ------------------------------
// PDF summary
// ------------------------------
app.get("/api/sessions/:file/summary.pdf", (req, res) => {
  const filePath = path.join("public/sessions", req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });

  const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const pdfPath = path.join("pdfs", `summary_${Date.now()}.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  doc.fontSize(18).text("Kilo Baseball Session Summary", { underline: true });
  doc.moveDown();
  doc.fontSize(12);
  doc.text(`Pitcher: ${session.pitcher}`);
  doc.text(`Total Pitches: ${session.pitches.length}`);
  doc.text(`Strikes: ${session.totalStrikes}`);
  doc.text(`Balls: ${session.totalBalls}`);
  doc.text(`Outs: ${session.outs}`);
  doc.moveDown();

  session.pitches.forEach((p, i) => {
    doc.fontSize(14).text(`Pitch #${i + 1}`, { underline: true });
    doc.fontSize(11);
    doc.text(`Type: ${p.pitchType}`);
    doc.text(`Result: ${p.result}`);
    if (p.detail) doc.text(`Detail: ${p.detail}`);
    if (p.velocity) doc.text(`Velocity: ${p.velocity} MPH`);
    if (p.x != null && p.y != null) doc.text(`Location: (${p.x}, ${p.y})`);
    if (p.clipPath) doc.text(`Clip: ${p.clipPath}`, { link: p.clipPath, underline: true });
    doc.moveDown();
  });

  doc.end();

  stream.on("finish", () => {
    res.download(pdfPath, `Kilo_Summary_${session.pitcher}.pdf`);
  });
});

// ------------------------------
// Serve login as homepage
// ------------------------------
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/login.html");
});

// ------------------------------
// Start server + WebSocket
// ------------------------------
initWebSocket(server, sessions);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});