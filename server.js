const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const { broadcast } = require('./ws-server');

let sessions = []; // In-memory session storage (not persistent)

// ------------------------------
// Middleware
// ------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/clips", express.static("clips"));
app.use("/pdfs", express.static("pdfs"));

// Ensure folders exist
["clips", "pdfs", "public/sessions"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ------------------------------
// Multer storage for clip uploads
// ------------------------------
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = "clips";
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname) || ".webm";
        cb(null, `clip_${Date.now()}${ext}`);
    }
});
const upload = multer({ storage });

app.post('/upload-clip', upload.single('clip'), (req, res) => {
  const filename = req.file.filename;
  const clipURL = `https://yourserver.com/clips/${filename}`;
  const clipName = filename.replace('.mp4', '');

  broadcast({
    type: "clip",
    name: req.file.filename.replace('.mp4', ''),
    url: url
});

  res.json({ success: true, url: clipURL });
});

// ------------------------------
// Save session to disk
// ------------------------------
app.post("/save-session", (req, res) => {
    const session = req.body;
    const filename = `session_${Date.now()}.json`;

    fs.writeFileSync(`public/sessions/${filename}`, JSON.stringify(session, null, 2));

    res.json({ url: `/sessions/${filename}` });
});

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
    const dir = "public/sessions";
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    res.json(files);
});

// ------------------------------
// Serve a saved session file
// ------------------------------
app.get("/sessions/:file", (req, res) => {
    const filePath = path.join("public/sessions", req.params.file);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Session not found" });
    }
    res.sendFile(path.resolve(filePath));
});

// ------------------------------
// Generate PDF summary
// ------------------------------
app.get("/api/sessions/:file/summary.pdf", (req, res) => {
    const filePath = path.join("public/sessions", req.params.file);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Session not found" });
    }

    const session = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const pdfPath = path.join("pdfs", `summary_${Date.now()}.pdf`);

    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // Header
    doc.fontSize(18).text("Kilo Baseball Session Summary", { underline: true });
    doc.moveDown();
    doc.fontSize(12);
    doc.text(`Pitcher: ${session.pitcher}`);
    doc.text(`Total Pitches: ${session.pitches.length}`);
    doc.text(`Strikes: ${session.totalStrikes}`);
    doc.text(`Balls: ${session.totalBalls}`);
    doc.text(`Outs: ${session.outs}`);
    doc.moveDown();

    // Pitch list
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

        if (doc.y > 700) doc.addPage();
    });

    doc.end();

    stream.on("finish", () => {
        res.download(pdfPath, `Kilo_Summary_${session.pitcher}.pdf`);
    });
});

// ------------------------------
// Fallback to index.html
// ------------------------------
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ------------------------------
// Start server
// ------------------------------
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});

app.post("/login", (req, res) => {
    const { code } = req.body;

    // Simple login: any code is accepted
    if (!sessions[code]) {
        sessions[code] = { camera: null, tagger: null };
    }

    req.session = { code };
    res.json({ success: true });
});

app.post("/setRole", (req, res) => {
    const { role } = req.body;
    const code = req.session?.code;

    if (!code) return res.json({ success: false });

    if (role === "camera") {
        sessions[code].camera = "active";
    } else {
        sessions[code].tagger = "active";
    }

    res.json({ success: true });
});