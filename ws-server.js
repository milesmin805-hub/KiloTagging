const WebSocket = require("ws");

let wss = null;
let sessionsRef = null;

function initWebSocket(server, sessions) {
  sessionsRef = sessions;
  wss = new WebSocket.Server({ server });

  wss.on("connection", (ws) => {
    ws.sessionCode = null;

    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.type === "joinSession") {
          ws.sessionCode = data.code;

          if (sessionsRef[data.code]) {
            ws.send(
              JSON.stringify({
                type: "sessionUpdate",
                session: sessionsRef[data.code]
              })
            );
          }
        }
      } catch (err) {
        console.error("WS error:", err);
      }
    });
  });

  console.log("WebSocket server ready");
}

function broadcastSessionUpdate(code, extra = null) {
  if (!wss || !sessionsRef[code]) return;

  const payload = {
    type: "sessionUpdate",
    session: sessionsRef[code]
  };

  if (extra) Object.assign(payload, extra);

  const msg = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.sessionCode === code) {
      client.send(msg);
    }
  });
}

module.exports = { initWebSocket, broadcastSessionUpdate };