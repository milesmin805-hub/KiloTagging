let pitches = [];
let lastPitch = null;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let velocityData = [];
let velocityChart = null;

function initVelocityChart() {
    const ctx = document.getElementById("velocityChart").getContext("2d");

    velocityChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: [],
            datasets: [{
                label: "Velocity (MPH)",
                data: velocityData,
                borderColor: "#4caf50",
                backgroundColor: "rgba(76, 175, 80, 0.2)",
                borderWidth: 2,
                tension: 0.3
            }]
        },
        options: {
            scales: {
                y: { beginAtZero: false }
            }
        }
    });
}
initVelocityChart();

async function startCamera() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
            audio: true
        });

        const video = document.getElementById("liveVideo");
        video.srcObject = mediaStream;

        document.getElementById("videoStatus").innerText = "Camera Active";
        document.getElementById("ndiStatus").innerText = "LIVE";
    } catch (err) {
        alert("Camera access denied or unavailable");
        console.error(err);
    }
}
// Session state
let balls = 0;
let strikes = 0;
let outs = 0;
let totalBalls = 0;
let totalStrikes = 0;
let totalPitches = 0;

// Modal helpers
let modalResolve = null;

function openModal(title, options) {
    const backdrop = document.getElementById("modal-backdrop");
    const titleEl = document.getElementById("modal-title");
    const btnContainer = document.getElementById("modal-buttons");

    titleEl.innerText = title;
    btnContainer.innerHTML = "";

    options.forEach(opt => {
        const btn = document.createElement("button");
        btn.className = "modal-btn";
        btn.innerText = opt.label;
        btn.onclick = () => {
            closeModal();
            if (modalResolve) modalResolve(opt.value);
        };
        btnContainer.appendChild(btn);
    });

    backdrop.style.display = "flex";

    return new Promise(resolve => {
        modalResolve = resolve;
    });
}

function closeModal() {
    document.getElementById("modal-backdrop").style.display = "none";
    modalResolve = null;
}

// UI transitions

function startSession(mode) {
    document.getElementById("launch-screen").classList.remove("active");
    document.getElementById("tagging-screen").classList.add("active");

    // Reset state
    balls = strikes = outs = totalBalls = totalStrikes = totalPitches = 0;
    updateStats();

    // Stream
    const mjpeg = document.getElementById("mjpeg");
    mjpeg.src = "http://192.168.86.70:8080";
    document.getElementById("videoStatus").innerText = "Streaming from phone...";
    document.getElementById("ndiStatus").innerText = "LIVE";
}

function startCamera() {
    const mjpeg = document.getElementById("mjpeg");
    const status = document.getElementById("videoStatus");

    status.innerText = "Checking camera server...";

    fetch("http://192.168.86.70:8080", { method: "GET" })
        .then(() => {
            // Server is running — load stream
            mjpeg.src = "http://192.168.86.70:8080";
            status.innerText = "Camera streaming";
            document.getElementById("ndiStatus").innerText = "LIVE";
        })
        .catch(() => {
            // Server is not running
            status.innerText = "Camera not running — open iPhone app and tap Start Streaming";
        });
}

async function loadPitcherDropdown() {
    const res = await fetch("/pitchers.json");
    const pitchers = await res.json();

    const dropdown = document.getElementById("pitcherSelect");
    dropdown.innerHTML = "";

    pitchers.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.innerText = p.name;
        dropdown.appendChild(opt);
    });
}

loadPitcherDropdown();

function handleTap(event) {
    const zone = document.getElementById("strike-zone");
    const marker = document.getElementById("tap-marker");
    const hint = document.getElementById("tap-hint");

    const rect = zone.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    marker.style.left = `${x - 6}px`;
    marker.style.top = `${y - 6}px`;
    marker.style.display = "block";
    hint.style.display = "none";

    choosePitchType()
        .then(pitchType => {
            if (!pitchType) return null;
            return chooseResult().then(result => ({ pitchType, result }));
        })
        .then(choice => {
            if (!choice) return null;

            if (choice.result === "In Play") {
                return chooseInPlayDetail().then(detail => ({
                    pitchType: choice.pitchType,
                    result: choice.result,
                    detail
                }));
            }

            return {
                pitchType: choice.pitchType,
                result: choice.result,
                detail: ""
            };
        })
        .then(final => {
            if (!final) return;

            // Apply baseball logic
            applyBaseballLogic(final.result, final.detail);
            totalPitches++;

            // Velocity update (only if defined)
            if (typeof velocityVal !== "undefined" && velocityVal !== "--") {
                velocityData.push(parseInt(velocityVal));
                velocityChart.data.labels.push(velocityData.length);
                velocityChart.update();
            }

            updateStats();

            // Create pitch object
            const pitch = {
                id: Date.now(),
                pitchType: final.pitchType,
                result: final.result,
                detail: final.detail,
                x,
                y,
                clip: null,
                thumbnail: null
            };

            pitches.push(pitch);
            lastPitch = pitch;

            updatePitchListUI();
        })
        .finally(() => {
            setTimeout(() => {
                marker.style.display = "none";
            }, 900);
        });
}

function generateThumbnail(videoURL) {
    const video = document.createElement("video");
    video.src = videoURL;
    video.crossOrigin = "anonymous";

    video.addEventListener("loadeddata", () => {
        video.currentTime = 0.1; // grab first frame
    });

    video.addEventListener("seeked", () => {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const thumbnailURL = canvas.toDataURL("image/jpeg");

        lastPitch.thumbnail = thumbnailURL;

        console.log("Thumbnail created:", thumbnailURL);

        updatePitchListUI();
    });
}

function updatePitchListUI() {
    const list = document.getElementById("pitchList");
    list.innerHTML = "";

    pitches.forEach(p => {
        const item = document.createElement("div");
        item.className = "pitch-item";

        item.innerHTML = `
            <img src="${p.thumbnail}" class="thumb">
            <div>
                <strong>${p.pitchType}</strong> — ${p.result}
                <br>
                <a href="${p.clip}" target="_blank">View Clip</a>
            </div>
        `;

        list.appendChild(item);
    });
}
// Dialog flows

function choosePitchType() {
    return openModal("Select Pitch Type", [
        { label: "FB", value: "FB" },
        { label: "CB", value: "CB" },
        { label: "SL", value: "SL" },
        { label: "CH", value: "CH" },
        { label: "SNK", value: "SNK" },
        { label: "CUT", value: "CUT" }
    ]);
}

function chooseResult() {
    return openModal("Select Result", [
        { label: "Strike", value: "Strike" },
        { label: "Ball", value: "Ball" },
        { label: "In Play", value: "In Play" }
    ]);
}

function chooseInPlayDetail() {
    return openModal("In Play Result", [
        { label: "Hit", value: "Hit" },
        { label: "Ground Out", value: "Ground Out" },
        { label: "Line Out", value: "Line Out" },
        { label: "Fly Out", value: "Fly Out" },
        { label: "Foul Ball", value: "Foul Ball" },
        { label: "Error", value: "Error" }
    ]);
}

// Baseball logic (mirrors your Swift)

function applyBaseballLogic(result, detail) {
    switch (result) {
        case "Ball":
            balls += 1;
            totalBalls += 1;
            if (balls >= 4) {
                balls = 0;
                strikes = 0;
            }
            break;

        case "Strike":
            strikes += 1;
            totalStrikes += 1;
            if (strikes >= 3) {
                strikes = 0;
                balls = 0;
                outs += 1;
            }
            break;

        case "In Play":
            totalStrikes += 1;
            switch (detail) {
                case "Ground Out":
                case "Line Out":
                case "Fly Out":
                    outs += 1;
                    balls = 0;
                    strikes = 0;
                    break;
                case "Foul Ball":
                    if (strikes < 2) {
                        strikes += 1;
                    }
                    break;
                case "Hit":
                case "Error":
                    balls = 0;
                    strikes = 0;
                    break;
                default:
                    balls = 0;
                    strikes = 0;
                    break;
            }
            break;
    }

    if (outs >= 3) {
        outs = 0;
    }
}

function updateStats() {
    document.getElementById("countStat").innerText = `${balls}-${strikes}`;
    document.getElementById("outsStat").innerText = outs;
    document.getElementById("tballsStat").innerText = totalBalls;
    document.getElementById("tstrikesStat").innerText = totalStrikes;
    document.getElementById("totalStat").innerText = totalPitches;
}

// Record button (visual only for now)

function toggleRecord() {
    const btn = document.getElementById("recordBtn");

    if (!isRecording) {
        // START RECORDING
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(mediaStream, { mimeType: "video/webm" });

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = saveClip;

        mediaRecorder.start();
        isRecording = true;
        btn.classList.add("recording");
    } else {
        // STOP RECORDING
        mediaRecorder.stop();
        isRecording = false;
        btn.classList.remove("recording");
    }
}

async function saveClip() {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    const formData = new FormData();
    formData.append("clip", blob, `pitch_${Date.now()}.webm`);

    const res = await fetch("/upload-clip", {
        method: "POST",
        body: formData
    });

    const data = await res.json();
    const clipURL = data.url;

    console.log("Uploaded clip:", clipURL);

    // Attach to the most recent pitch
    lastPitch.clip = clipURL;

    // Generate thumbnail
    generateThumbnail(clipURL);
}


// Finish session

async function finishSession() {
    const pitcher = document.getElementById("pitcherName").value;

    const sessionData = {
        pitcher,
        totalPitches,
        totalStrikes,
        totalBalls,
        outs,
        pitches,
        velocityData
    };

    // Save to server
    const res = await fetch("/save-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionData)
    });

    const data = await res.json();
    const sessionURL = data.url;

    // Also save locally for summary page
    localStorage.setItem("kiloSession", JSON.stringify(sessionData));

    window.location.href = "summary.html";
}
