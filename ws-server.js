const WebSocket = require("ws");

let wss = null;
let sessionsRef = null;

/* -------------------------------------------------------
   DEVICE PRESENCE TRACKING
------------------------------------------------------- */
const deviceStatus = {
  tagger: false,
  camera: false,
  dashboard: false
};

/* -------------------------------------------------------
   BROADCAST HELPER
------------------------------------------------------- */
function broadcast(data) {
  const msg = JSON.stringify(data);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

/* -------------------------------------------------------
   MAIN INIT FUNCTION
------------------------------------------------------- */
function initWebSocket(server, sessions) {
  sessionsRef = sessions;
  wss = new WebSocket.Server({ server });

  wss.on("connection", (ws) => {
    ws.sessionCode = null;
    ws.deviceType = null;

    ws.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch (err) {
        console.error("Invalid JSON:", msg);
        return;
      }

      /* -----------------------------
         DEVICE IDENTIFICATION
      ----------------------------- */
      if (data.type === "identify" && data.device) {
        ws.deviceType = data.device;

        deviceStatus[data.device] = true;

        broadcast({
          type: "presence",
          device: data.device,
          online: true
        });

        return;
      }

      /* -----------------------------
         PITCH EVENT (from Tagger)
      ----------------------------- */
      if (data.type === "pitch") {
        broadcast({
          type: "pitch",
          pitchId: data.pitchId,
          pitchType: data.pitchType,
          zone: data.zone,
          result: data.result,
          timestamp: data.timestamp
        });
        return;
      }

      /* -----------------------------
         VELOCITY EVENT (from Radar)
      ----------------------------- */
      if (data.type === "velocity") {
        broadcast({
          type: "velocity",
          value: data.value,
          timestamp: Date.now()
        });
        return;
      }

      /* -----------------------------
         CLIP EVENT (from Camera)
      ----------------------------- */
      if (data.type === "clip") {
        broadcast({
          type: "clip",
          url: data.url,
          timestamp: Date.now()
        });
        return;
      }

      /* -----------------------------
         CLIP TAG EVENT (Tagger links clip → pitch)
      ----------------------------- */
      if (data.type === "clip-tag") {
        broadcast({
          type: "clip-tag",
          url: data.url,
          pitchId: data.pitchId,
          timestamp: Date.now()
        });
        return;
      }

      /* -----------------------------
         SESSION JOIN (existing logic)
      ----------------------------- */
      if (data.type === "joinSession" && data.code) {
        ws.sessionCode = data.code;
      }
    });

    /* -----------------------------
       HANDLE DISCONNECT
    ----------------------------- */
    ws.on("close", () => {
      if (ws.deviceType) {
        deviceStatus[ws.deviceType] = false;

        broadcast({
          type: "presence",
          device: ws.deviceType,
          online: false
        });
      }
    });
  });

  console.log("WebSocket server ready");
}

/* -------------------------------------------------------
   SESSION UPDATE BROADCAST (unchanged)
------------------------------------------------------- */
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