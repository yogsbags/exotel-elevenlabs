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
    
    if (!data.signed_url) {
      throw new Error("Failed to get signed URL from ElevenLabs");
    }
    
    this.elevenlabsWs = new WebSocket(data.signed_url);
    
    this.elevenlabsWs.onopen = () => {
      console.log("ElevenLabs WebSocket connected");
    };

    this.elevenlabsWs.onerror = (error) => {
      console.error("ElevenLabs WebSocket error:", error);
    };

    this.elevenlabsWs.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      console.log("Received message from ElevenLabs:", message.type); // Add logging
      
      switch (message.type) {
        case "conversation_initiation_metadata":
          console.log("Conversation initiated:", message.conversation_initiation_metadata_event);
          break;
          
        case "ping":
          this.elevenlabsWs?.send(JSON.stringify({
            type: "pong",
            event_id: message.ping_event.event_id,
          }));
          break;
          
        default:
          await this.handleElevenLabsMessage(message);
      }
    };

    this.elevenlabsWs.onclose = (event) => {
      console.log("ElevenLabs connection closed:", event.code, event.reason);
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
        // Verify input format (16kHz)
        if (!verifyAudioFormat(message.audio_event.audio_base_64, 16000)) {
          console.warn("Incoming audio from ElevenLabs doesn't match expected 16kHz format");
        }
        // Convert 16kHz PCM to 8kHz PCM for Exotel
        const convertedAudio = await this.convertAudioForExotel(
          message.audio_event.audio_base_64
        );
        // Verify output format (8kHz)
        if (!verifyAudioFormat(convertedAudio, 8000)) {
          console.warn("Converted audio doesn't match Exotel 8kHz format");
        }
        
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
    try {
      // Verify input format (8kHz)
          if (!verifyAudioFormat(message.media.payload, 8000)) {
            console.warn("Incoming audio from Exotel doesn't match expected 8kHz format");
          }
      // Convert 8kHz PCM to 16kHz PCM for ElevenLabs
      const convertedAudio = await this.convertAudioForElevenLabs(
        message.media.payload
      );

      // Verify output format (16kHz)
          if (!verifyAudioFormat(convertedAudio, 16000)) {
            console.warn("Converted audio doesn't match ElevenLabs 16kHz format");
          }
      
      // Send to ElevenLabs
      const payload = {
        user_audio_chunk: convertedAudio
      };
      console.log("Sending audio to ElevenLabs");
      this.elevenlabsWs.send(JSON.stringify(payload));
    } catch (error) {
      console.error("Error processing audio:", error);
    }
  } else {
    console.error("ElevenLabs WebSocket not ready:", this.elevenlabsWs?.readyState);
  }
  break;

      case "stop":
        console.log("Stream ended:", this.streamSid);
          if (this.exotelWs) {
            this.exotelWs.close();
          }
        this.cleanup();
        break;
    }
  }

async convertAudioForElevenLabs(audioBase64) {
  try {
    // Decode base64 to buffer
    const binaryData = atob(audioBase64);
    const inputBuffer = new Int16Array(binaryData.length / 2);
    
    // Convert binary string to Int16Array (8kHz PCM)
    for (let i = 0; i < binaryData.length; i += 2) {
      inputBuffer[i/2] = (binaryData.charCodeAt(i) | (binaryData.charCodeAt(i + 1) << 8));
    }

    // Create output buffer for 16kHz (double size for upsampling)
    const outputBuffer = new Int16Array(inputBuffer.length * 2);
    
    // Linear interpolation for upsampling from 8kHz to 16kHz
    for (let i = 0; i < inputBuffer.length - 1; i++) {
      // Copy original sample
      outputBuffer[i * 2] = inputBuffer[i];
      
      // Calculate interpolated sample between current and next sample
      const currentSample = inputBuffer[i];
      const nextSample = inputBuffer[i + 1];
      outputBuffer[i * 2 + 1] = Math.round((currentSample + nextSample) / 2);
    }
    
    // Handle the last sample
    const lastIndex = inputBuffer.length - 1;
    outputBuffer[lastIndex * 2] = inputBuffer[lastIndex];
    outputBuffer[lastIndex * 2 + 1] = inputBuffer[lastIndex];

    // Convert to Uint8Array for base64 encoding
    const outputBytes = new Uint8Array(outputBuffer.buffer);
    
    // Convert to base64
    let binary = '';
    for (let i = 0; i < outputBytes.length; i++) {
      binary += String.fromCharCode(outputBytes[i]);
    }
    
    return btoa(binary);
  } catch (error) {
    console.error("Error in convertAudioForElevenLabs:", error);
    throw error;
  }
}

async convertAudioForExotel(audioBase64) {
  try {
    // Decode base64 to buffer
    const binaryData = atob(audioBase64);
    const inputBuffer = new Int16Array(binaryData.length / 2);
    
    // Convert binary string to Int16Array (16kHz PCM)
    for (let i = 0; i < binaryData.length; i += 2) {
      inputBuffer[i/2] = (binaryData.charCodeAt(i) | (binaryData.charCodeAt(i + 1) << 8));
    }

    // Create output buffer for 8kHz (half size for downsampling)
    const outputBuffer = new Int16Array(Math.ceil(inputBuffer.length / 2));
    
    // Average every two samples for downsampling from 16kHz to 8kHz
    for (let i = 0; i < outputBuffer.length; i++) {
      const sample1 = inputBuffer[i * 2];
      const sample2 = i * 2 + 1 < inputBuffer.length ? inputBuffer[i * 2 + 1] : sample1;
      outputBuffer[i] = Math.round((sample1 + sample2) / 2);
    }

    // Convert to Uint8Array for base64 encoding
    const outputBytes = new Uint8Array(outputBuffer.buffer);
    
    // Convert to base64
    let binary = '';
    for (let i = 0; i < outputBytes.length; i++) {
      binary += String.fromCharCode(outputBytes[i]);
    }
    
    return btoa(binary);
  } catch (error) {
    console.error("Error in convertAudioForExotel:", error);
    throw error;
  }
}

function verifyAudioFormat(audioBase64, expectedSampleRate) {
  try {
    const binaryData = atob(audioBase64);
    const buffer = new Int16Array(binaryData.length / 2);
    
    // Basic validation - check if data length matches expected format
    // For PCM 16-bit:
    // - Each sample is 2 bytes
    // - Expected length should be: duration * sampleRate * 2
    const durationMs = 250; // assuming 250ms chunks
    const expectedSamples = (durationMs / 1000) * expectedSampleRate;
    const expectedBytes = expectedSamples * 2;
    
    const isValid = Math.abs(binaryData.length - expectedBytes) < expectedSampleRate; // Allow some flexibility
    
    if (!isValid) {
      console.warn(`Audio format validation failed. Expected ~${expectedBytes} bytes, got ${binaryData.length}`);
    }
    
    return isValid;
  } catch (error) {
    console.error("Error verifying audio format:", error);
    return false;
  }
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
