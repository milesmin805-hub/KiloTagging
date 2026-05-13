// ------------------------------
// Load session from localStorage
// ------------------------------
const session = JSON.parse(localStorage.getItem("kiloSession"));
if (!session) {
    alert("No session data found.");
    return;
}

// Header values
document.getElementById("sumPitcher").innerText = session.pitcher;
document.getElementById("sumTotal").innerText = session.pitches.length;
document.getElementById("sumStrikes").innerText = session.totalStrikes;
document.getElementById("sumBalls").innerText = session.totalBalls;
document.getElementById("sumOuts").innerText = session.outs;

// ------------------------------
// Pitch List
// ------------------------------
const list = document.getElementById("summaryPitchList");
list.innerHTML = "";

session.pitches.forEach(p => {
    const div = document.createElement("div");
    div.className = "summary-item";

    div.innerHTML = `
        <div>
            <strong>${p.pitchType}</strong> — ${p.result}
            ${p.detail ? `(${p.detail})` : ""}
            ${p.velocity ? `<br>Velo: ${p.velocity} MPH` : ""}
            ${p.clipPath ? `<br><a href="${p.clipPath}" target="_blank">View Clip</a>` : ""}
        </div>
    `;

    list.appendChild(div);
});

// ------------------------------
// Velocity Chart
// ------------------------------
const veloArray = session.pitches
    .map(p => p.velocity)
    .filter(v => typeof v === "number" && !isNaN(v));

if (veloArray.length > 0) {
    const ctx = document.getElementById("summaryVelocityChart").getContext("2d");

    new Chart(ctx, {
        type: "line",
        data: {
            labels: veloArray.map((_, i) => i + 1),
            datasets: [{
                label: "Velocity (MPH)",
                data: veloArray,
                borderColor: "#ffb74d",
                backgroundColor: "rgba(255, 183, 77, 0.2)",
                borderWidth: 2,
                tension: 0.3
            }]
        }
    });
}

// ------------------------------
// Heatmap
// ------------------------------
drawHeatmap("summaryHeatmap", session.pitches);

function drawHeatmap(canvasId, pitches) {
    const canvas = document.getElementById(canvasId);
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

    // Pitch colors by type
    const colors = {
        FB: "rgba(255, 0, 0, 0.35)",
        SL: "rgba(0, 128, 255, 0.35)",
        CB: "rgba(128, 0, 255, 0.35)",
        CH: "rgba(0, 255, 128, 0.35)",
        SNK: "rgba(255, 165, 0, 0.35)",
        CUT: "rgba(255, 255, 0, 0.35)"
    };

    // Draw pitches
    pitches.forEach(p => {
        if (p.x == null || p.y == null) return;

        const x = 50 + p.x * 200;
        const y = 350 - p.y * 300;

        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fillStyle = colors[p.pitchType] || "rgba(255,255,255,0.35)";
        ctx.fill();
    });
}

// ------------------------------
// PDF Export
// ------------------------------
async function downloadPDF() {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "pt", "letter");

    pdf.setFontSize(18);
    pdf.text("Kilo Baseball Session Summary", 40, 40);

    pdf.setFontSize(12);
    pdf.text(`Pitcher: ${session.pitcher}`, 40, 70);
    pdf.text(`Total Pitches: ${session.pitches.length}`, 40, 90);
    pdf.text(`Strikes: ${session.totalStrikes}`, 40, 110);
    pdf.text(`Balls: ${session.totalBalls}`, 40, 130);
    pdf.text(`Outs: ${session.outs}`, 40, 150);

    let y = 190;

    for (const p of session.pitches) {
        pdf.text(`${p.pitchType} — ${p.result} ${p.detail || ""}`, 40, y);

        y += 20;

        if (y > 700) {
            pdf.addPage();
            y = 40;
        }
    }

    pdf.save("kilo_session.pdf");
}