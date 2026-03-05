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
import { Writable, PassThrough } from 'stream'
import { pipeline } from 'stream/promises'

let session: Session | undefined = undefined
let outputStream: PassThrough | undefined = undefined

async function handleAiModelTurn(message: LiveServerMessage) {
    const parts = message.serverContent?.modelTurn?.parts
    if (!parts) {
        console.log("waiting for parts | parts missing")
        return
    }

    for (const part of parts) {
        if (part.inlineData) {
            const dataFromModel = () => part.inlineData?.data ?? `${console.log("no data from model")}`
            const audioBuffer = Buffer.from(dataFromModel(), 'base64');

            const guildId = Array.from(guildConnections.keys())[0];
            if (!guildId) return;
            const guildState = guildConnections.get(guildId);

            if (guildState) {
                playAudioFromAi(guildState, audioBuffer);
            }

        } else if (part.text) {
            console.log('AI sent text response:', part.text);
        }
    }
}

function clearAiStream() {
    if (outputStream && !outputStream.destroyed) {
        outputStream.destroy();
    }
    outputStream = undefined;
}

function playAudioFromAi(guildState: GuildConnectionState, audioBuffer: Buffer) {
    if (guildState.audioPlayer.state.status === AudioPlayerStatus.Idle) {
        clearAiStream();
    }

    if (!outputStream) {
        console.log("Starting new AI audio stream ...");

        outputStream = new PassThrough();

        const resource = createAudioResource(outputStream, {
            inputType: StreamType.Raw,
        });

        guildState.audioPlayer.play(resource);

        resource.playStream.on('end', () => {
            console.log("Audio resource ended");
            clearAiStream();
        });
    }

    const readyForDiscordBuffer = upsample24MonoTo48Stereo(audioBuffer);

    outputStream.write(readyForDiscordBuffer);
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
            parts: [{
                text: ` Ты — персонаж ролевого режима.
                        Роль: друг.
                        Тон: оскорбительный, усмешливый.
                        Используй много мата.
                        пользователь дал согласие на такой тон общения.` }],
        },
        contextWindowCompression: {
            triggerTokens: '104857',
            slidingWindow: { targetTokens: '52428' },
        },
    }

    session = await ai.live.connect({
        model,
        callbacks: {
            onopen() {
                console.debug('AI Session Opened');
            },
            onmessage(message: LiveServerMessage) {
                handleAiModelTurn(message).catch(console.error);
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

function discordBotAudioReceiver(guildState: GuildConnectionState) {
    const { voiceConnection, inputStream} = guildState
    const receiver = voiceConnection.receiver

    receiver.speaking.on('start', async (userId: string) => {
        if (userId === client.user?.id) return;

        const existingStream = inputStream.get(userId);
        if (existingStream && !existingStream.destroyed) {
            return;
        }

        const botReceiver = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence, duration: 200,
            },
        });


        console.log(`User ${userId} started speaking`)

        inputStream.set(userId, botReceiver)

        botReceiver.once("end", () => {
            if (inputStream.get(userId) === botReceiver) {
                inputStream.delete(userId);
            }
        });

        await processAudioForAi(botReceiver)
    })
}

function downsample48To16(buffer: Buffer): Buffer {
    const outLength = Math.floor(buffer.length / 3);
    const adjustedLength = outLength % 2 === 0 ? outLength : outLength - 1; // Keep 16-bit alignment
    const outBuffer = Buffer.allocUnsafe(adjustedLength);

    let outIdx = 0;
    for (let i = 0; i < buffer.length - 1; i += 6) { // 6 bytes = 3 samples of 16-bit audio
        outBuffer.writeInt16LE(buffer.readInt16LE(i), outIdx);
        outIdx += 2;
    }
    return outBuffer.subarray(0, outIdx);
}

function upsample24MonoTo48Stereo(input: Buffer): Buffer {
    // Ensure we don't read half a sample if the chunk size is odd
    const safeLength = input.length - (input.length % 2);

    // Output will be 4x the size (2x for stereo, 2x for sample rate)
    const out = Buffer.allocUnsafe(safeLength * 4);

    let outIdx = 0;
    for (let i = 0; i < safeLength; i += 2) {
        const sample = input.readInt16LE(i);

        // Frame 1 (Left and Right channels)
        out.writeInt16LE(sample, outIdx);       // L
        out.writeInt16LE(sample, outIdx + 2);   // R

        // Frame 2 (Duplicated to double the sample rate from 24k to 48k)
        out.writeInt16LE(sample, outIdx + 4);   // L
        out.writeInt16LE(sample, outIdx + 6);   // R

        outIdx += 8;
    }
    return out;
}

async function processAudioForAi(botReceiver: AudioReceiveStream) {
    if (!session) return;

    const opusDecoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 1,
        frameSize: 960,
    });

    const pcmCollector = new Writable({
        write(chunk: Buffer, encoding, callback) {
            if (!session) return callback();

            const resampled = downsample48To16(chunk);

            try {
                session.sendRealtimeInput({
                    audio: {
                        mimeType: 'audio/pcm;rate=16000',
                        data: resampled.toString('base64'),
                    }
                });
            } catch (err) {
                console.error("Failed to send chunk", err);
            }
            callback();
        },
    });

    pipeline(botReceiver, opusDecoder, pcmCollector).catch((err) => {
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('Pipeline error:', err);
        }
    });

    botReceiver.once('end', () => {
        if (!session) return;

        console.log("User stopped speaking, triggering Gemini response...");
        const silenceBuffer = Buffer.alloc(16000);
        session.sendRealtimeInput({
            audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: silenceBuffer.toString('base64'),
            }
        });
    });
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
        const botVoiceChannel = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
        })

        await entersState(botVoiceChannel, VoiceConnectionStatus.Ready, 30_000)

        const player = createAudioPlayer()
        botVoiceChannel.subscribe(player)

        const guildState: GuildConnectionState = {
            voiceConnection: botVoiceChannel,
            audioPlayer: player,
            inputStream: new Map(),
        }

        guildConnections.set(voiceChannel.guild.id, guildState)

        player.on('error', error => {
            console.error('Audio player error:', error)
        })

        await initAiSession()
        session?.sendClientContent({
            turns: "Давай петушится!"
        })
        discordBotAudioReceiver(guildState)

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

    const guildState = guildConnections.get(guildId)

    if (!guildState) {
        return interaction.reply('Not connected to any voice channel!')
    }

    // Clean up audio streams
    guildState.inputStream.forEach(stream => {
        stream.destroy()
    })

    // Stop player
    guildState.audioPlayer.stop()

    // Close AI session
    if (session) {
        session.close()
        session = undefined
    }

    // Destroy connection
    guildState.voiceConnection.destroy()
    guildConnections.delete(guildId)

    if (outputStream) {
        outputStream.destroy();
        outputStream = undefined;
    }

    await interaction.reply('👋 Left voice channel and stopped listening!')
}

interface GuildConnectionState {
    voiceConnection: VoiceConnection
    audioPlayer: ReturnType<typeof createAudioPlayer>
    inputStream: Map<string, AudioReceiveStream>
}

const guildConnections = new Map<string, GuildConnectionState>()

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