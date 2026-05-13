async function loadSessions() {
    const res = await fetch("/list-sessions");
    const files = await res.json();

    const list = document.getElementById("sessionList");
    list.innerHTML = "";

    for (const file of files) {
        const sessionRes = await fetch(`/sessions/${file}`);
        const session = await sessionRes.json();

        const total = session.pitches ? session.pitches.length : 0;

        const div = document.createElement("div");
        div.className = "session-item";

        div.innerHTML = `
            <strong>${session.pitcher}</strong> — ${total} pitches
            <br>
            <button onclick="openSession('${file}')">Open</button>
        `;

        list.appendChild(div);
    }
}

function openSession(file) {
    window.location.href = `viewer.html?file=${file}`;
}

loadSessions();