import { serve } from "https://deno.land/std@0.188.0/http/server.ts";

// Store active WebSocket connections
const activeConnections = new Map();

function handleWebSocket(ws: WebSocket) {
  console.log("New WebSocket connection");

  ws.onopen = () => {
    // Send connected message to Exotel
    ws.send(JSON.stringify({
      event: "connected"
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log("Received message:", message);

      switch (message.event) {
        case 'start':
          console.log('Stream started:', message.stream_sid);
          // Initialize ElevenLabs connection here
          break;

        case 'media':
          // Handle incoming audio from Exotel
          console.log('Received audio chunk');
          break;

        case 'stop':
          console.log('Stream stopped');
          break;
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket connection closed");
  };
}

serve(async (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/stream") {
    if (req.headers.get("upgrade") != "websocket") {
      return new Response(null, { status: 401 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWebSocket(socket);
    return response;
  }

  return new Response("WebSocket server running. Connect to /stream endpoint");
}, { port: 8000 });

console.log("WebSocket server running on :8000");
