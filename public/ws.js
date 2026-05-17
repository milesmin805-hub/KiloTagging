// ws.js — global WebSocket for ALL pages (camera, tagger, dashboard)

(function () {
  const code = localStorage.getItem("sessionCode");
  if (!code) {
    console.warn("No session code found in localStorage.");
    return;
  }

  let ws = null;
  let heartbeatInterval = null;

  function connect() {
    ws = new WebSocket(
      (location.protocol === "https:" ? "wss://" : "ws://") + location.host
    );

    ws.addEventListener("open", () => {
      console.log("WS connected");

      // Join the session
      ws.send(JSON.stringify({ type: "joinSession", code }));

      // Heartbeat to keep connection alive
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 5000);
    });

    ws.addEventListener("close", () => {
      console.warn("WS disconnected, retrying in 2s...");
      clearInterval(heartbeatInterval);
      setTimeout(connect, 2000);
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);

      /* ---------------------------------------------------
         SESSION STATUS UPDATES (dashboard)
      --------------------------------------------------- */
      if (msg.type === "sessionUpdate") {
        const { camera, tagger } = msg.session;
        const bar = document.getElementById("statusBar");
        if (bar) {
          bar.textContent = `Camera: ${camera === "connected" ? "✔️" : "❌"} | Tagger: ${
            tagger === "connected" ? "✔️" : "❌"
          }`;
        }
      }

      /* ---------------------------------------------------
         PITCH EVENTS (tagger → dashboard)
      --------------------------------------------------- */
      if (msg.type === "pitch") {
        console.log("Pitch received:", msg.pitchType);

        const pitchEl = document.getElementById("lastPitch");
        if (pitchEl) {
          pitchEl.textContent = msg.pitchType;
        }
      }

      /* ---------------------------------------------------
         CLIP EVENTS (camera → tagger)
      --------------------------------------------------- */
      if (msg.type === "clip") {
        console.log("Clip received:", msg.url);

        const clipList = document.getElementById("clipsList");
        if (clipList) {
          const item = document.createElement("div");
          item.textContent = msg.url;
          clipList.appendChild(item);
        }
      }

      /* ---------------------------------------------------
         CAMERA COMMANDS (tagger → camera)
      --------------------------------------------------- */
      if (msg.type === "startClip" && window.startClip) {
        startClip();
      }

      if (msg.type === "stopClip" && window.stopClip) {
        stopClip();
      }
    });
  }

  // Start connection
  connect();

  // Expose ws globally so camera/tagger pages can use it
  window.ws = ws;
})();