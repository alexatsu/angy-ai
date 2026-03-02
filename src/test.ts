import type { AudioReceiveStream, VoiceConnection } from '@discordjs/voice'
import type { LiveServerMessage, Session } from '@google/genai'
import type { CommandInteraction, GuildMember } from 'discord.js'

import { AudioPlayerStatus, StreamType } from '@discordjs/voice'
import {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    EndBehaviorType,
    entersState,
    VoiceConnectionStatus,
} from '@discordjs/voice'
import { GoogleGenAI, MediaResolution, Modality } from '@google/genai'
import { Client, Events, GatewayIntentBits, type CacheType } from 'discord.js'
import prism from 'prism-media'
import { Writable, PassThrough, Readable } from 'stream'
import { pipeline } from 'stream/promises'

let session: Session | undefined = undefined
let aiInputStream: PassThrough | undefined = undefined

async function handleModelTurn(message: LiveServerMessage) {
    const parts = message.serverContent?.modelTurn?.parts
    if (!parts) {
        console.log("waiting for parts | parts missing")
        return
    }

    for (const part of parts) {
        if (part.inlineData) {
            // Gemini sends audio as base64
            const dataFromModel = () => part.inlineData?.data ?? `${console.log("no data from model")}`
            const audioBuffer = Buffer.from(dataFromModel(), 'base64');

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

function clearAiStream() {
    if (aiInputStream && !aiInputStream.destroyed) {
        aiInputStream.destroy();
    }
    aiInputStream = undefined;
}

function playStreamingAudio(guildState: GuildConnectionState, audioBuffer: Buffer) {
    if (guildState.player.state.status === AudioPlayerStatus.Idle) {
        clearAiStream()
    }

    // If we don't have an active stream, create the pipeline
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
    aiInputStream.write(audioBuffer);
}

async function initAiSession() {
    if (session) {
        session.close();
        session = undefined;
    }

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
        systemInstruction: {
            parts: [{ text: "You are a helpful voice assistant in a Discord call. Keep responses concise and conversational." }],
        },
    }

    session = await ai.live.connect({
        model,
        callbacks: {
            onopen() {
                console.debug('AI Session Opened');
            },
            onmessage(message: LiveServerMessage) {
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

    // Listen for when users start speaking
    receiver.speaking.on('start', async (userId: string) => {
        // Ignore the bot's own audio
        if (userId === client.user?.id) return;

        const existing = audioStreams.get(userId);
        if (existing) {
            if (!existing.destroyed) existing.destroy();
            audioStreams.delete(userId);
        }

        console.log(`User ${userId} started speaking`)

        // Create a subscription
        const subscribedReceiver = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 500, // Wait 500ms of silence before deciding user is done
            },
        });

        audioStreams.set(userId, subscribedReceiver)

        subscribedReceiver.once("end", () => {
            if (audioStreams.get(userId) === subscribedReceiver) {
                audioStreams.delete(userId);
            }
        });

        // Process the stream
        await processAudioStream(subscribedReceiver)
    })
}

async function processAudioStream(audioStream: AudioReceiveStream) {
    const pcmChunks: Buffer[] = []

    // Create decoder
    const decoder = new prism.opus.Decoder({
        channels: 1,
        rate: 48000,
        frameSize: 960,
    })

    const MAX_BUFFER_SIZE = 20 * 1024 * 1024; // 20MB cap
    let currentSize = 0;

    const pcmCollector = new Writable({
        write(chunk: Buffer, encoding, callback) {
            if (currentSize + chunk.length > MAX_BUFFER_SIZE) {
                audioStream.destroy();
                return callback(new Error('Buffer limit exceeded'));
            }
            pcmChunks.push(chunk);
            currentSize += chunk.length;
            callback();
        },
    });

    // Handle decoder errors specifically
    decoder.on('error', (error: Error) => {
        console.error('Decoder error:', error)
    })

    try {
        // Pipe the audio stream through the decoder to the collector
        await pipeline(audioStream, decoder, pcmCollector)
    } catch (err: unknown) {
        // ERROR HANDLING FIX:
        // Ignore premature close errors. This happens when the user stops talking
        // and Discord.js closes the stream, or when you manually destroy the
        // stream in the 'speaking' event handler.

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const error = err as any;
        if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
            // This is expected behavior for voice streams
        } else {
            console.error(`Error processing audio stream for user:`, error)
        }
    }

    if (pcmChunks.length > 0) {
        const completePcmData = Buffer.concat(pcmChunks)
        console.log(`Collected ${completePcmData.length} bytes of PCM data`)
        await sendAudioToAi(completePcmData)
    }
}

async function sendAudioToAi(audioBuffer: Buffer) {
    if (!session) {
        console.log('Session not ready');
        return;
    }

    try {
        // Filter out very short noises (< 0.5s) to prevent "Huh?" responses to clicks
        if (audioBuffer.length < 48000 * 0.5) {
            return;
        }

        const pcm16k = await convertAudioTo16k(audioBuffer);
        const silenceBuffer = Buffer.alloc(32000); // Zero-filled buffer = Silence
        const payload = Buffer.concat([pcm16k, silenceBuffer]);

        console.log(`Sending ${pcm16k.length} bytes to AI...`);

        session.sendRealtimeInput({
            audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: payload.toString('base64'),
            }
        });

        // Note: We do NOT need to tell Gemini to "reply". 
        // Sending a chunk of audio after silence naturally triggers the VAD (Voice Activity Detection) in the model.
    } catch (error) {
        console.error('Error sending audio to AI:', error);
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
        }

        connections.set(voiceChannel.guild.id, guildState)

        player.on('error', error => {
            console.error('Audio player error:', error)
        })

        await initAiSession()
        session?.sendClientContent({
            turns: "Привет, поговори с нами"
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

    if (aiInputStream) {
        aiInputStream.destroy();
        aiInputStream = undefined;
    }

    await interaction.reply('👋 Left voice channel and stopped listening!')
}

async function convertAudioTo16k(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        // 1. Create a stream from the existing buffer
        const inputStream = Readable.from(inputBuffer);

        // 2. Create an FFmpeg transform stream
        const ffmpeg = new prism.FFmpeg({
            args: [
                '-analyzeduration', '0',
                '-loglevel', '0',
                '-f', 's16le',
                '-ar', '48000', // Input: Discord 48k
                '-ac', '1',     // Input: Mono
                '-i', '-',
                '-f', 's16le',
                '-ar', '16000', // Output: Gemini 16k
                '-ac', '1',     // Output: Mono
            ],
        });

        // 3. Collect the converted data into a new buffer
        const chunks: Buffer[] = [];
        const collector = new Writable({
            write(chunk, encoding, callback) {
                chunks.push(chunk);
                callback();
            }
        });

        // 4. Handle events
        pipeline(inputStream, ffmpeg, collector)
            .then(() => {
                resolve(Buffer.concat(chunks));
            })
            .catch(reject);
    });
}

interface GuildConnectionState {
    connection: VoiceConnection
    player: ReturnType<typeof createAudioPlayer>
    audioStreams: Map<string, AudioReceiveStream>
}

const connections = new Map<string, GuildConnectionState>()

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

await client.login(process.env['TOKEN'])