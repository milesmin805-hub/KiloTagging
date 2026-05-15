const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

module.exports = { broadcast };

wss.on('connection', socket => {
  console.log('Client connected');
});