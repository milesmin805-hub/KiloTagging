async function loadPitchers() {
    const res = await fetch("/pitchers.json");
    const pitchers = await res.json();

    const list = document.getElementById("pitcherList");
    list.innerHTML = "";

    pitchers.forEach(p => {
        const div = document.createElement("div");
        div.innerHTML = `<strong>${p.name}</strong>`;
        list.appendChild(div);
    });
}

async function addPitcher() {
    const name = document.getElementById("pitcherNameInput").value;

    const res = await fetch("/pitchers.json");
    const pitchers = await res.json();

    pitchers.push({ name });

    await fetch("/save-pitchers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pitchers)
    });

    loadPitchers();
}

loadPitchers();
