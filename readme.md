# Discord AI Voice Bot (Also Angry Roles)

This Discord bot uses Google Gemini Live API for real-time voice conversations in voice channels.

## Key Features

- Voice-to-AI: Captures user speech via AudioReceiveStream, decodes Opus, downsamples to 16kHz PCM, sends to Gemini
- AI-to-Voice: Receives AI audio responses as base64 PCM, upsamples to Discord's 48kHz stereo format, plays via AudioPlayer
- Role System: Switchable AI personalities (friend/angry modes) via /ai-set-role
- Commands: /ai-join, /ai-leave, /ai-reset, /ai-roles, /ai-current-role, /ai-set-role <name>

### Core Flow

User speaks → AudioReceiveStream → Opus decode → 48→16kHz → Gemini Live
Gemini responds → base64 PCM → 24mono→48stereo → PassThrough → AudioPlayer → Voice
Bot auto-cleans connections and handles speaking detection with silenceBuffer triggers.

### Tech Stack

@discordjs/voice for voice handling
@google/genai for Gemini Live WebSocket API
prism-media for Opus/PCM conversion
Custom downsample48To16/upsample24MonoTo48Stereo audio processing

# Setup

Configure apiKey, model, config, roles in @/config, check ci folder
Set env variables
`pnpm start` for development

Also added docker example