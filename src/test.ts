import type { VoiceConnection } from '@discordjs/voice'
import type { LiveServerMessage, Session } from '@google/genai'
import type { CommandInteraction, GuildMember } from 'discord.js'

import {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    EndBehaviorType,
    entersState,
    VoiceConnectionStatus,
} from '@discordjs/voice'
import { GoogleGenAI, MediaResolution, Modality } from '@google/genai'
import { spawn } from 'child_process'
import { Client, Events, GatewayIntentBits, type CacheType } from 'discord.js'
import { readFileSync, unlinkSync, writeFileSync } from "fs"
import prism from 'prism-media'
import { Readable, Writable } from 'stream'
import { pipeline } from 'stream/promises'

// AI Session Management
let session: Session | undefined = undefined

// Audio processing queues
let isProcessing = false

async function handleModelTurn(message: LiveServerMessage) {
    if (message.serverContent?.modelTurn?.parts) {
        for (const part of message.serverContent.modelTurn.parts) {
            if (part?.inlineData) {
                const audioBuffer = Buffer.from(part.inlineData.data, 'base64');

                console.log('AI sent audio response:', {
                    mimeType: part.inlineData.mimeType,
                    size: audioBuffer.length
                });

                // Convert AI's audio to Discord format
                const discordAudio = await convertAiAudioToDiscord(audioBuffer);
                playAudioResponse(discordAudio);
            } else if (part?.text) {
                console.log('AI sent text response:', part.text);
            }
        }
    }
}

async function convertAiAudioToDiscord(aiAudioBuffer: Buffer): Promise<Buffer> {
    // Save to temp file
    const inputPath = `temp_ai_${Date.now()}.raw`;
    const outputPath = `temp_discord_${Date.now()}.wav`;

    writeFileSync(inputPath, aiAudioBuffer);

    return new Promise((resolve, reject) => {
        // Try to detect if it's WAV or raw PCM
        const isWav = aiAudioBuffer.toString('ascii', 0, 4) === 'RIFF';

        const ffmpegArgs = isWav ? [
            '-i', inputPath,  // If it's WAV, let ffmpeg detect format
        ] : [
            '-f', 's16le',     // Raw PCM
            '-ar', '24000',    // Assume 24kHz
            '-ac', '1',        // Mono
            '-i', inputPath,
        ];

        const ffmpeg = spawn('ffmpeg', [
            ...ffmpegArgs,
            '-ar', '48000',    // Discord sample rate
            '-ac', '2',        // Stereo for Discord
            '-acodec', 'pcm_s16le',
            '-f', 'wav',
            outputPath,
            '-y',
            '-loglevel', 'error'
        ]);

        ffmpeg.on('close', (code) => {
            try {
                if (code === 0) {
                    const discordBuffer = readFileSync(outputPath);
                    unlinkSync(inputPath);
                    unlinkSync(outputPath);
                    resolve(discordBuffer);
                } else {
                    reject(new Error(`FFmpeg failed with code ${code}`));
                }
            } catch (err) {
                reject(err);
            }
        });
    });
}

let sessionReady = false;
async function initAiSession() {
    const ai = new GoogleGenAI({
        apiKey: process.env['GEMINI_API_KEY'],
    })

    const model = 'models/gemini-2.5-flash-native-audio-preview-12-2025'

    const config = {
        responseModalities: [Modality.AUDIO],
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: 'Zephyr',
                },
            },
        },
    }

    session = await ai.live.connect({
        model,
        callbacks: {
            onopen() {
                console.debug('AI Session Opened');
                sessionReady = true;
            },
            onmessage(message: LiveServerMessage) {
                // NEW: Process chunks directly as they arrive from the AI!
                handleModelTurn(message).catch(console.error);
            },
            onerror(e: ErrorEvent) {
                console.debug('AI Error:', e.message);
            },
            onclose(e: CloseEvent) {
                console.debug('AI Session Closed:', e.reason);
            },
        },
        config,
    })

    while (!sessionReady) {
        await new Promise(r => setTimeout(r, 100));
    }

    return session
}

// Discord Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
})

interface GuildConnectionState {
    connection: VoiceConnection
    player: ReturnType<typeof createAudioPlayer>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audioStreams: Map<string, any>
    audioQueue: Buffer[]      // <-- NEW
    isPlaying: boolean        // <-- NEW
}

const connections = new Map<string, GuildConnectionState>()

client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`)
})

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return

    if (interaction.commandName === 'join') {
        await handleJoin(interaction)
    } else if (interaction.commandName === 'leave') {
        await handleLeave(interaction)
    }
})

async function handleJoin(interaction: CommandInteraction<CacheType>) {
    const member = interaction.member as GuildMember
    const voiceChannel = member.voice.channel

    if (!voiceChannel) {
        return interaction.reply('Please join a voice channel first!')
    }

    const existing = getVoiceConnection(voiceChannel.guild.id)
    if (existing) {
        return interaction.reply('Already connected to a voice channel!')
    }

    try {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
        })

        // Wait for connection to be ready
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000)

        const player = createAudioPlayer()
        connection.subscribe(player)

        const guildState: GuildConnectionState = {
            connection,
            player,
            audioStreams: new Map(),
            audioQueue: [],       // <-- NEW
            isPlaying: false      // <-- NEW
        }
        connections.set(voiceChannel.guild.id, guildState)

        // NEW: Automatically play the next chunk when idle
        player.on(AudioPlayerStatus.Idle, () => {
            guildState.isPlaying = false;
            playNext(guildState);
        })

        player.on('error', error => {
            console.error('Audio player error:', error)
            guildState.isPlaying = false;
            playNext(guildState);
        })
        // Initialize AI session and start listening immediately
        await initAiSession()
        startAudioReceiving(guildState)

        await interaction.reply(
            `✅ Joined **${voiceChannel.name}** and started listening! The AI is now active in the channel.`,
        )
    } catch (error) {
        console.error('Failed to join voice channel:', error)
        await interaction.reply('❌ Failed to join voice channel!')
    }
}

function startAudioReceiving(guildState: GuildConnectionState) {
    const { connection, audioStreams } = guildState
    const receiver = connection.receiver

    // Create a stream for each user that speaks
    receiver.speaking.on('start', async (userId: string) => {
        console.log(`User ${userId} started speaking`)

        const audioStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 250,
            },
        });

        audioStreams.set(userId, audioStream)

        // Process the audio stream
        await processAudioStream(audioStream)
    })

    receiver.speaking.on('end', (userId: string) => {
        console.log(`User ${userId} stopped speaking`)
    })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processAudioStream(audioStream: any) {
    try {
        // Create a buffer to collect PCM data
        const pcmChunks: Buffer[] = []

        // Create Opus decoder using prism-media
        const decoder = new prism.opus.Decoder({
            channels: 1,
            rate: 48000,
            frameSize: 960,
        })

        // Create a writable stream to collect PCM data
        const pcmCollector = new Writable({
            write(chunk: Buffer, encoding, callback) {
                pcmChunks.push(chunk)
                callback()
            },
        })

        // Handle decoder errors
        decoder.on('error', (error: Error) => {
            console.error('Decoder error:', error)
        })

        // Pipe the audio stream through the decoder to the collector
        await pipeline(audioStream, decoder, pcmCollector)

        // After pipeline completes, process the collected PCM
        if (pcmChunks.length > 0) {
            // Combine all PCM data
            const completePcmData = Buffer.concat(pcmChunks)

            // Log audio info for debugging
            console.log(`Collected ${completePcmData.length} bytes of PCM data`)
            console.log(`Sample rate: 48000, Channels: 1, Bit depth: 16-bit`)

            await sendAudioToAi(completePcmData)
        }
    } catch (error) {
        console.error(`Error processing audio stream for user:`, error)
    }
}

async function trimSilence(pcmBuffer: Buffer): Promise<Buffer> {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);

    // Calculate RMS energy for each 10ms frame
    const frameSize = 480; // 10ms @ 48kHz
    const energies: number[] = [];

    for (let i = 0; i < samples.length; i += frameSize) {
        const frame = samples.slice(i, Math.min(i + frameSize, samples.length));
        let sum = 0;
        for (let j = 0; j < frame.length; j++) {
            sum += frame[j] * frame[j];
        }
        const rms = Math.sqrt(sum / frame.length);
        energies.push(rms);
    }

    // Find speech threshold (adjust as needed)
    const maxEnergy = Math.max(...energies);
    const threshold = maxEnergy * 0.05; // 5% of peak

    // Find first frame above threshold
    let startFrame = 0;
    for (let i = 0; i < energies.length; i++) {
        if (energies[i] > threshold) {
            startFrame = Math.max(0, i - 2); // Include 20ms before speech
            break;
        }
    }

    // Convert frame index to byte index
    const startByte = startFrame * frameSize * 2;

    return pcmBuffer.slice(startByte);
}

async function sendAudioToAi(audioBuffer: Buffer) {
    if (!session || !sessionReady || isProcessing) {
        console.log('Session not ready, dropping audio');
        return;
    }

    try {
        isProcessing = true;

        // VAD - only send actual speech
        const speechBuffer = await trimSilence(audioBuffer);

        if (speechBuffer.length < 160) { // Less than 10ms of audio
            console.log('Audio too short, skipping');
            return;
        }
        // Convert to 16kHz PCM for Gemini
        const pcmBuffer = await convertPcmToWavFFmpeg(speechBuffer);

        // Truncate if too long (Gemini has limits)
        const MAX_AUDIO_SIZE = 48000 * 30; // 30 seconds at 16kHz
        let finalBuffer = pcmBuffer;
        if (pcmBuffer.length > MAX_AUDIO_SIZE) {
            console.log('Audio too long, truncating to 30s');
            finalBuffer = pcmBuffer.slice(0, MAX_AUDIO_SIZE);
        }

        // Gemini expects LINEAR16 PCM with specific format
        // Send as base64 encoded PCM, not WAV
        console.log('Sending audio to AI:', {
            bufferLength: finalBuffer.length,
            durationMs: Math.round((finalBuffer.length / 2) / 16), // samples / 16 = ms
        });

        // Send as raw PCM with correct MIME type
        session.sendRealtimeInput({
            audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: finalBuffer.toString('base64'),
            }
        });
        session.sendClientContent({ turnComplete: true });

    } catch (error) {
        console.error('Error sending audio to AI:', error);
    } finally {
        isProcessing = false;
    }
}

function playAudioResponse(audioBuffer: Buffer) {
    const connections_list = Array.from(connections.entries())
    if (connections_list.length === 0) return

    const [_, guildState] = connections_list[0]

    // Add to queue and attempt to play
    guildState.audioQueue.push(audioBuffer);
    playNext(guildState);
}


function playNext(guildState: GuildConnectionState) {
    if (guildState.isPlaying || guildState.audioQueue.length === 0) return;

    const { player } = guildState;
    if (!player) return;

    guildState.isPlaying = true;
    const audioBuffer = guildState.audioQueue.shift()!;

    console.log(`Playing audio chunk... (${guildState.audioQueue.length} remaining in queue)`);

    // Convert the Buffer into a Readable stream so Discord can play it
    const stream = Readable.from(audioBuffer);

    const resource = createAudioResource(stream, {
        inlineVolume: true,
        inputType: 'arbitrary', // arbitrary is fine since it's a valid WAV from your FFmpeg conversion
    });

    player.play(resource);
}

async function handleLeave(interaction: CommandInteraction<CacheType>) {
    const guildId = interaction.guild?.id
    if (!guildId) return

    const guildState = connections.get(guildId)

    if (!guildState) {
        return interaction.reply('Not connected to any voice channel!')
    }

    // Clean up audio streams
    guildState.audioStreams.forEach(stream => {
        stream.destroy()
    })

    // Stop player
    guildState.player.stop()

    // Close AI session
    if (session) {
        session.close()
        session = undefined
    }

    // Destroy connection
    guildState.connection.destroy()
    connections.delete(guildId)

    await interaction.reply('👋 Left voice channel and stopped listening!')
}

async function convertPcmToWavFFmpeg(pcmBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const inputPath = 'temp_input_' + Date.now() + '.pcm';
        const outputPath = 'temp_output_' + Date.now() + '.pcm';

        writeFileSync(inputPath, pcmBuffer);

        const ffmpeg = spawn('ffmpeg', [
            '-f', 's16le',
            '-ar', '48000',     // Input: 48kHz from Discord
            '-ac', '1',          // Mono
            '-i', inputPath,
            '-ar', '16000',      // Output: 16kHz for Gemini
            '-ac', '1',          // Keep mono
            '-f', 's16le',       // Raw PCM output (no WAV header)
            '-acodec', 'pcm_s16le',
            outputPath,
            '-y',
            '-loglevel', 'error' // Reduce noise
        ]);

        ffmpeg.on('close', (code) => {
            try {
                const convertedBuffer = readFileSync(outputPath);
                unlinkSync(inputPath);
                unlinkSync(outputPath);

                if (code === 0) {
                    resolve(convertedBuffer);
                } else {
                    reject(new Error(`FFmpeg failed with code ${code}`));
                }
            } catch (err) {
                reject(err);
            }
        });
    });
}

// Start the bot
await client.login(process.env['TOKEN'])