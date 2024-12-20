import { serve } from "https://deno.land/std@0.188.0/http/server.ts";

// Store active connections
const activeConnections = new Map();

class CallHandler {
  constructor(streamSid: string) {
    this.streamSid = streamSid;
    this.exotelWs = null;
    this.elevenlabsWs = null;
    this.isActive = true;
    this.sequenceNumber = 1;
  }

  async initializeElevenLabs() {
    try {
      // Get signed URL from ElevenLabs
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${Deno.env.get("ELEVENLABS_AGENT_ID")}`,
        {
          headers: {
            "xi-api-key": Deno.env.get("ELEVENLABS_API_KEY"),
          },
        }
      );
      const data = await response.json();
      
      this.elevenlabsWs = new WebSocket(data.signed_url);
      
      this.elevenlabsWs.onopen = () => {
        console.log("ElevenLabs WebSocket connected");
      };

      this.elevenlabsWs.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        await this.handleElevenLabsMessage(message);
      };

      this.elevenlabsWs.onclose = () => {
        console.log("ElevenLabs connection closed");
        this.cleanup();
      };
    } catch (error) {
      console.error("Error connecting to ElevenLabs:", error);
      this.cleanup();
    }
  }

  async handleElevenLabsMessage(message: any) {
    if (!this.isActive) return;

    switch (message.type) {
      case "audio":
        // Convert 16kHz PCM to 8kHz PCM for Exotel
        const convertedAudio = await this.convertAudioForExotel(
          message.audio_event.audio_base_64
        );
        
        // Send to Exotel in chunks of appropriate size
        const chunks = this.chunkAudio(convertedAudio, 32000); // 32kb chunks
        
        for (const chunk of chunks) {
          if (this.exotelWs) {
            this.exotelWs.send(JSON.stringify({
              event: "media",
              sequence_number: this.sequenceNumber++,
              stream_sid: this.streamSid,
              media: {
                chunk: 1,
                timestamp: Date.now(),
                payload: chunk,
              },
            }));
          }
        }

        // Send mark for tracking
        if (this.exotelWs) {
          this.exotelWs.send(JSON.stringify({
            event: "mark",
            sequence_number: this.sequenceNumber++,
            stream_sid: this.streamSid,
            mark: {
              name: `audio_${Date.now()}`,
            },
          }));
        }
        break;

      case "ping":
        // Respond to ElevenLabs ping
        this.elevenlabsWs?.send(JSON.stringify({
          type: "pong",
          event_id: message.ping_event.event_id,
        }));
        break;
    }
  }

  async handleExotelMessage(message: any) {
    if (!this.isActive) return;

    switch (message.event) {
      case "connected":
        console.log("Exotel connected, stream:", this.streamSid);
        break;

      case "start":
        console.log("Stream started:", message.stream_sid);
        await this.initializeElevenLabs();
        break;

      case "media":
        if (this.elevenlabsWs?.readyState === WebSocket.OPEN) {
          // Convert 8kHz PCM to 16kHz PCM for ElevenLabs
          const convertedAudio = await this.convertAudioForElevenLabs(
            message.media.payload
          );
          
          // Send to ElevenLabs
          this.elevenlabsWs.send(JSON.stringify({
            user_audio_chunk: convertedAudio,
          }));
        }
        break;

      case "stop":
        console.log("Stream ended:", this.streamSid);
        this.cleanup();
        break;
    }
  }

  // Convert 8kHz PCM to 16kHz PCM
  async convertAudioForElevenLabs(audioBase64: string): Promise<string> {
    // TODO: Implement audio upsampling from 8kHz to 16kHz
    return audioBase64;
  }

  // Convert 16kHz PCM to 8kHz PCM
  async convertAudioForExotel(audioBase64: string): Promise<string> {
    // TODO: Implement audio downsampling from 16kHz to 8kHz
    return audioBase64;
  }

  // Split audio into appropriate chunk sizes
  chunkAudio(audioBase64: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    let i = 0;
    while (i < audioBase64.length) {
      // Ensure chunk size is multiple of 320 bytes
      const size = Math.min(chunkSize - (chunkSize % 320), audioBase64.length - i);
      chunks.push(audioBase64.slice(i, i + size));
      i += size;
    }
    return chunks;
  }

  cleanup() {
    this.isActive = false;
    if (this.elevenlabsWs) {
      this.elevenlabsWs.close();
    }
    activeConnections.delete(this.streamSid);
  }
}

serve(async (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/stream") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Upgrade to WebSocket required", { status: 426 });
    }

    const { socket: ws, response } = Deno.upgradeWebSocket(req);

    ws.onopen = () => {
      console.log("Exotel WebSocket connected");
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.event === "start") {
          const handler = new CallHandler(message.stream_sid);
          handler.exotelWs = ws;
          activeConnections.set(message.stream_sid, handler);
          await handler.handleExotelMessage(message);
        } else if (message.stream_sid) {
          const handler = activeConnections.get(message.stream_sid);
          if (handler) {
            await handler.handleExotelMessage(message);
          }
        }
      } catch (error) {
        console.error("Error handling message:", error);
      }
    };

    ws.onclose = () => {
      console.log("Exotel WebSocket closed");
    };

    return response;
  }

  return new Response(JSON.stringify({
    status: "running",
    websocket_endpoint: "wss://exotel-elevenlabs.deno.dev/stream",
    message: "Use the WebSocket endpoint for bidirectional streaming"
  }), {
    headers: {
      "content-type": "application/json"
    }
  }), { port: 8000 });

console.log("Server running on :8000");
