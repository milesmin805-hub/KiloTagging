async function loadSession() {
    const params = new URLSearchParams(window.location.search);
    const file = params.get("file");
    if (!file) return;

    const res = await fetch(`/sessions/${file}`);
    const session = await res.json();

    // Header
    document.getElementById("viewerHeader").innerHTML = `
        <strong>${session.pitcher}</strong><br>
        ${session.pitches.length} pitches<br>
        <small>${new Date(session.date).toLocaleString()}</small>
    `;

    // Pitch List
    const list = document.getElementById("viewerPitchList");
    list.innerHTML = "";

    session.pitches.forEach(p => {
        const div = document.createElement("div");
        div.className = "summary-item";

        div.innerHTML = `
            <div>
                <strong>${p.pitchType}</strong> — ${p.result}
                ${p.detail ? `(${p.detail})` : ""}
                ${p.velocity ? `<br>Velo: ${p.velocity} MPH` : ""}
                ${p.x != null && p.y != null ? `<br>Loc: (${p.x.toFixed(2)}, ${p.y.toFixed(2)})` : ""}
                ${p.clipPath ? `<br><a href="${p.clipPath}" target="_blank">View Clip</a>` : ""}
            </div>
        `;

        list.appendChild(div);
    });

    // Velocity Chart
    const veloArray = session.pitches
        .map(p => p.velocity)
        .filter(v => typeof v === "number" && !isNaN(v));

    if (veloArray.length > 0) {
        drawVelocityChart(veloArray);
    }

    // Heatmap
    drawHeatmap("viewerHeatmap", session.pitches);
}

// ------------------------------
// Heatmap
// ------------------------------
function drawHeatmap(canvasId, pitches) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    canvas.width = 300;
    canvas.height = 400;

    // Background
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Strike zone
    ctx.strokeStyle = "white";
    ctx.lineWidth = 3;
    ctx.strokeRect(50, 50, 200, 300);

    // Pitches
    pitches.forEach(p => {
        if (p.x == null || p.y == null) return;

        const x = 50 + p.x * 200;
        const y = 350 - p.y * 300;

        ctx.fillStyle = "rgba(255, 0, 0, 0.35)";
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fill();
    });
}

// ------------------------------
// Velocity Chart
// ------------------------------
function drawVelocityChart(data) {
    const canvas = document.getElementById("viewerVelocityChart");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    new Chart(ctx, {
        type: "line",
        data: {
            labels: data.map((_, i) => i + 1),
            datasets: [{
                label: "Velocity (MPH)",
                data,
                borderColor: "#4caf50",
                backgroundColor: "rgba(76, 175, 80, 0.2)",
                borderWidth: 2,
                tension: 0.3
            }]
        }
    });
}

// ------------------------------
// Start
// ------------------------------
loadSession();