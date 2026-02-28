import type { VoiceConnection } from '@discordjs/voice'
import type { LiveServerMessage, Session } from '@google/genai'
import type { CommandInteraction, GuildMember } from 'discord.js'
import { Readable, Writable, PassThrough } from 'stream'
import { StreamType } from '@discordjs/voice'
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
import { pipeline } from 'stream/promises'

// AI Session Management
let session: Session | undefined = undefined

// Audio processing queues
let isProcessing = false
let aiInputStream: PassThrough | undefined = undefined

async function handleModelTurn(message: LiveServerMessage) {
    const parts = message.serverContent?.modelTurn?.parts
    if (!parts) return

    for (const part of parts) {
        if (part.inlineData) {
            // Gemini sends audio as base64
            const audioBuffer = Buffer.from(part.inlineData.data, 'base64');

            // Get the current guild state (assuming 1 active connection for simplicity)
            // In production, map this by guildId
            const guildId = Array.from(connections.keys())[0];
            if (!guildId) return;
            const guildState = connections.get(guildId);

            if (guildState) {
                playStreamingAudio(guildState, audioBuffer);
            }

        } else if (part.text) {
            console.log('AI sent text response:', part.text);
        }
    }
}

function playStreamingAudio(guildState: GuildConnectionState, chunk: Buffer) {
    // 1. If we don't have an active stream, create the pipeline
    if (!aiInputStream) {
        console.log("Starting new AI audio stream...");

        // Create a generic stream to accept Gemini chunks
        aiInputStream = new PassThrough();

        // Create an FFmpeg instance using Prism to transcode ON THE FLY
        // Input: 24kHz Mono (Gemini default) -> Output: 48kHz Stereo (Discord)
        const ffmpeg = new prism.FFmpeg({
            args: [
                '-analyzeduration', '0',
                '-loglevel', '0',
                '-f', 's16le',
                '-ar', '24000',
                '-ac', '1',
                '-i', '-',
                '-f', 's16le',
                '-ar', '48000',
                '-ac', '2',
            ],
        });

        // Pipe our input stream into FFmpeg
        aiInputStream.pipe(ffmpeg);

        // Create a Discord AudioResource from the FFmpeg output
        const resource = createAudioResource(ffmpeg, {
            inputType: StreamType.Raw,
            inlineVolume: true
        });

        // Play it immediately
        guildState.player.play(resource);

        // Handle stream cleanup when the AI stops speaking or audio ends
        resource.playStream.on('end', () => {
            console.log("Audio resource ended");
            aiInputStream = undefined;
        });
    }

    // 2. Simply write the new chunk to the existing stream
    // The player will pick this up automatically because everything is piped
    aiInputStream.write(chunk);
}

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

    while (!session) {
        await new Promise(r => setTimeout(r, 100));
    }

    return session
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

async function sendAudioToAi(audioBuffer: Buffer) {
    if (!session || isProcessing) {
        console.log('Session not ready, dropping audio');
        return;
    }

    try {
        isProcessing = true;


        if (audioBuffer.length < 160) { // Less than 10ms of audio
            console.log('Audio too short, skipping');
            return;
        }
        // Convert to 16kHz PCM for Gemini
        const pcmBuffer = await convertPcmToWavFFmpeg(audioBuffer);

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

    } catch (error) {
        console.error('Error sending audio to AI:', error);
    } finally {
        isProcessing = false;
    }
}


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
            audioQueue: [], // You can remove this
            isPlaying: false // You can remove this
        }

        connections.set(voiceChannel.guild.id, guildState)

        player.on('error', error => {
            console.error('Audio player error:', error)
        })

        await initAiSession()
        session?.sendClientContent({
            turns: "Hello bro, lets talk"
        })
        startAudioReceiving(guildState)

        await interaction.reply(
            `✅ Joined **${voiceChannel.name}** and started listening! The AI is now active in the channel.`,
        )
    } catch (error) {
        console.error('Failed to join voice channel:', error)
        await interaction.reply('❌ Failed to join voice channel!')
    }
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


interface GuildConnectionState {
    connection: VoiceConnection
    player: ReturnType<typeof createAudioPlayer>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    audioStreams: Map<string, any>
    audioQueue: Buffer[]      // <-- NEW
    isPlaying: boolean        // <-- NEW
}

const connections = new Map<string, GuildConnectionState>()

// Discord Bot Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
})

client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return

    if (interaction.commandName === 'join') {
        await handleJoin(interaction)
    } else if (interaction.commandName === 'leave') {
        await handleLeave(interaction)
    }
})

client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`)
})

// Start the bot
await client.login(process.env['TOKEN'])