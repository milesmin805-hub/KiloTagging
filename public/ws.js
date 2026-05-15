const ws = new WebSocket("wss://" + window.location.host);

ws.onopen = () => {
    console.log("WebSocket connected");
};

ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);

    if (data.type === "frame" && window.onFrameReceived) {
        window.onFrameReceived(data.frame);
    }
};
