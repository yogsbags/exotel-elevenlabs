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

async convertAudioForElevenLabs(audioBase64: string): Promise<string> {
  // Decode base64 to buffer
  const binaryData = atob(audioBase64);
  const inputBuffer = new Int16Array(binaryData.length / 2);
  
  // Convert binary string to Int16Array
  for (let i = 0; i < binaryData.length; i += 2) {
    inputBuffer[i/2] = (binaryData.charCodeAt(i) | (binaryData.charCodeAt(i + 1) << 8));
  }

  // Create output buffer (twice the size for upsampling)
  const outputBuffer = new Int16Array(inputBuffer.length * 2);
  
  // Linear interpolation for upsampling
  for (let i = 0; i < inputBuffer.length - 1; i++) {
    outputBuffer[i * 2] = inputBuffer[i];
    // Calculate intermediate sample
    outputBuffer[i * 2 + 1] = Math.round((inputBuffer[i] + inputBuffer[i + 1]) / 2);
  }
  // Handle last sample
  outputBuffer[outputBuffer.length - 2] = inputBuffer[inputBuffer.length - 1];
  outputBuffer[outputBuffer.length - 1] = inputBuffer[inputBuffer.length - 1];

  // Convert back to base64
  const outputArray = new Uint8Array(outputBuffer.buffer);
  let binaryString = "";
  for (let i = 0; i < outputArray.length; i++) {
    binaryString += String.fromCharCode(outputArray[i]);
  }
  return btoa(binaryString);
}

async convertAudioForExotel(audioBase64: string): Promise<string> {
  // Decode base64 to buffer
  const binaryData = atob(audioBase64);
  const inputBuffer = new Int16Array(binaryData.length / 2);
  
  // Convert binary string to Int16Array
  for (let i = 0; i < binaryData.length; i += 2) {
    inputBuffer[i/2] = (binaryData.charCodeAt(i) | (binaryData.charCodeAt(i + 1) << 8));
  }

  // Create output buffer (half the size for downsampling)
  const outputBuffer = new Int16Array(Math.floor(inputBuffer.length / 2));
  
  // Average pairs of samples for downsampling
  for (let i = 0; i < outputBuffer.length; i++) {
    outputBuffer[i] = Math.round((inputBuffer[i * 2] + inputBuffer[i * 2 + 1]) / 2);
  }

  // Convert back to base64
  const outputArray = new Uint8Array(outputBuffer.buffer);
  let binaryString = "";
  for (let i = 0; i < outputArray.length; i++) {
    binaryString += String.fromCharCode(outputArray[i]);
  }
  return btoa(binaryString);
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
          console.log(`New call starting with stream_sid: ${message.stream_sid}`);
          if (activeConnections.has(message.stream_sid)) {
              console.log(`Warning: Already have handler for stream_sid: ${message.stream_sid}`);
              return;
          }
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
  });
}, { port: 8000 });

console.log("Server running on :8000");
