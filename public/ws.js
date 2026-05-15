(function () {
  const code = localStorage.getItem("sessionCode");
  if (!code) return;

  const socket = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host
  );

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "joinSession", code }));
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "sessionUpdate") {
      const { camera, tagger } = msg.session;
      const bar = document.getElementById("statusBar");
      if (bar) {
        bar.textContent = `Camera: ${camera === "connected" ? "✔️" : "❌"} | Tagger: ${
          tagger === "connected" ? "✔️" : "❌"
        }`;
      }
    }
  });
})();