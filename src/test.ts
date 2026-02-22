import type { VoiceConnection, AudioReceiveStream } from '@discordjs/voice'
import type { LiveServerMessage, Session } from '@google/genai'
import type { CommandInteraction, GuildMember } from 'discord.js'

import {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    EndBehaviorType,
} from '@discordjs/voice'
import { GoogleGenAI, MediaResolution, Modality } from '@google/genai'
import { Client, Events, GatewayIntentBits, type CacheType } from 'discord.js'
import { writeFile } from 'fs'
import prism from 'prism-media'
import { pipeline } from 'stream'

// AI Session Management
const responseQueue: LiveServerMessage[] = []
let session: Session | undefined = undefined

// Audio processing queues
const audioInputQueue: Buffer[] = []
const isProcessing = false
let currentAiSession: GoogleGenAI | null = null

async function handleTurn(): Promise<LiveServerMessage[]> {
    const turn: LiveServerMessage[] = []
    let done = false
    while (!done) {
        const message = await waitMessage()
        turn.push(message)
        if (message.serverContent && message.serverContent.turnComplete) {
            done = true
        }
    }
    return turn
}

async function waitMessage(): Promise<LiveServerMessage> {
    let done = false
    let message: LiveServerMessage | undefined = undefined
    while (!done) {
        message = responseQueue.shift()
        if (message) {
            handleModelTurn(message)
            done = true
        } else {
            await new Promise(resolve => {
                setTimeout(resolve, 100)
            })
        }
    }
    return message!
}

const audioParts: string[] = []
function handleModelTurn(message: LiveServerMessage) {
    if (message.serverContent?.modelTurn?.parts) {
        const part = message.serverContent?.modelTurn?.parts?.[0]

        if (part?.fileData) {
            console.log(`File: ${part?.fileData.fileUri}`)
        }

        if (part?.inlineData) {
            const fileName = 'audio.wav'
            const inlineData = part?.inlineData

            audioParts.push(inlineData?.data ?? '')

            const buffer = convertToWav(audioParts, inlineData.mimeType ?? '')
            saveBinaryFile(fileName, buffer)

            // Play the audio response in Discord
            playAudioResponse(buffer)
        }

        if (part?.text) {
            console.log(part?.text)
        }
    }
}

function saveBinaryFile(fileName: string, content: Buffer) {
    writeFile(fileName, content, err => {
        if (err) {
            console.error(`Error writing file ${fileName}:`, err)
            return
        }
        console.log(`Appending stream content to file ${fileName}.`)
    })
}

interface WavConversionOptions {
    numChannels: number
    sampleRate: number
    bitsPerSample: number
}

function convertToWav(rawData: string[], mimeType: string) {
    const options = parseMimeType(mimeType)
    const dataLength = rawData.reduce((a, b) => a + b.length, 0)
    const wavHeader = createWavHeader(dataLength, options)
    const buffer = Buffer.concat(rawData.map(data => Buffer.from(data, 'base64')))
    return Buffer.concat([wavHeader, buffer])
}

function parseMimeType(mimeType: string) {
    const [fileType, ...params] = mimeType.split(';').map(s => s.trim())
    const [, format] = fileType.split('/')

    const options: Partial<WavConversionOptions> = {
        numChannels: 1,
        bitsPerSample: 16,
    }

    if (format && format.startsWith('L')) {
        const bits = parseInt(format.slice(1), 10)
        if (!isNaN(bits)) {
            options.bitsPerSample = bits
        }
    }

    for (const param of params) {
        const [key, value] = param.split('=').map(s => s.trim())
        if (key === 'rate') {
            options.sampleRate = parseInt(value, 10)
        }
    }

    return options as WavConversionOptions
}

function createWavHeader(dataLength: number, options: WavConversionOptions) {
    const { numChannels, sampleRate, bitsPerSample } = options
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
    const blockAlign = (numChannels * bitsPerSample) / 8
    const buffer = Buffer.alloc(44)

    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataLength, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(numChannels, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(byteRate, 28)
    buffer.writeUInt16LE(blockAlign, 32)
    buffer.writeUInt16LE(bitsPerSample, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataLength, 40)

    return buffer
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
        contextWindowCompression: {
            triggerTokens: '25600',
            slidingWindow: { targetTokens: '12800' },
        },
    }

    currentAiSession = ai

    session = await ai.live.connect({
        model,
        callbacks: {
            onopen() {
                console.debug('AI Session Opened')
            },
            onmessage(message: LiveServerMessage) {
                responseQueue.push(message)
            },
            onerror(e: ErrorEvent) {
                console.debug('AI Error:', e.message)
            },
            onclose(e: CloseEvent) {
                console.debug('AI Session Closed:', e.reason)
                currentAiSession = null
            },
        },
        config,
    })

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

const connections = new Map()
const audioPlayers = new Map()
const audioStreams = new Map()

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

        connections.set(voiceChannel.guild.id, connection)

        // Create audio player
        const player = createAudioPlayer()
        audioPlayers.set(voiceChannel.guild.id, player)
        connection.subscribe(player)

        connection.on('stateChange', (oldState, newState) => {
            console.log(`Connection transitioned from ${oldState.status} to ${newState.status}`)
        })

        connection.on('error', error => {
            console.error('Voice connection error:', error)
        })

        // Initialize AI session and start listening immediately
        await initAiSession()
        startAudioReceiving(connection, voiceChannel.guild.id)

        await interaction.reply(
            `✅ Joined **${voiceChannel.name}** and started listening! The AI is now active in the channel.`,
        )
    } catch (error) {
        console.error('Failed to join voice channel:', error)
        await interaction.reply('❌ Failed to join voice channel!')
    }
}

function startAudioReceiving(connection: VoiceConnection, guildId: string) {
    // Create audio receive stream
    const receiver = connection.receiver

    // Create a stream for each user that speaks
    receiver.speaking.on('start', async (userId: string) => {
        console.log(`User ${userId} started speaking`)

        const audioStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000,
            },
        })

        // Store the stream reference
        const streams = audioStreams.get(guildId) || new Map()
        streams.set(userId, audioStream)
        audioStreams.set(guildId, streams)

        // Process the audio stream
        await processAudioStream(audioStream)
    })

    receiver.speaking.on('end', (userId: string) => {
        console.log(`User ${userId} stopped speaking`)
    })
}

async function processAudioStream(audioStream: AudioReceiveStream) {
    try {
        // Convert Opus to PCM
        const decoder = new prism.opus.Decoder({
            frameSize: 960,
            channels: 1,
            rate: 24000,
        })

        // Buffer to collect audio data
        const audioBuffer: Buffer[] = []

        decoder.on('data', (pcmData: Buffer) => {
            audioBuffer.push(pcmData)
        })

        decoder.on('end', async () => {
            // Combine all PCM data
            const completePcmData = Buffer.concat(audioBuffer)

            // Convert PCM to WAV
            const wavBuffer = pcmToWav(completePcmData, {
                sampleRate: 24000,
                channels: 1,
                bitsPerSample: 16,
            })

            // Send to AI
            await sendAudioToAi(wavBuffer)
        })

        // Pipe the audio stream through the decoder
        pipeline(audioStream, decoder, err => {
            if (err) {
                console.error('Audio processing pipeline error:', err)
            }
        })
    } catch (error) {
        console.error('Error processing audio stream:', error)
    }
}

function pcmToWav(
    pcmData: Buffer,
    options: { sampleRate: number; channels: number; bitsPerSample: number },
) {
    const { sampleRate, channels, bitsPerSample } = options
    const dataLength = pcmData.length
    const header = createWavHeader(dataLength, {
        numChannels: channels,
        sampleRate,
        bitsPerSample,
    })

    return Buffer.concat([header, pcmData])
}

async function sendAudioToAi(audioBuffer: Buffer) {
    if (!session) {
        console.error('No active AI session')
        return
    }

    try {
        // Convert audio buffer to base64
        const base64Audio = audioBuffer.toString('base64')

        // Send to AI
        session.sendClientContent({
            turns: [
                {
                    parts: [
                        {
                            inlineData: {
                                mimeType: 'audio/wav',
                                data: base64Audio,
                            },
                        },
                    ],
                },
            ],
        })

        // Process response
        await handleTurn()
    } catch (error) {
        console.error('Error sending audio to AI:', error)
    }
}

function playAudioResponse(audioBuffer: Buffer) {
    // We need to get the current guild from context
    // For simplicity, assuming we're playing to the first active connection
    const connections_list = Array.from(connections.entries())
    if (connections_list.length === 0) return

    const [guildId, connection] = connections_list[0]
    const player = audioPlayers.get(guildId)

    if (!player) return

    // Create audio resource from buffer
    const resource = createAudioResource(audioBuffer, {
        inlineVolume: true,
        inputType: 'arbitrary', // This will treat the buffer as raw PCM
    })

    // Play the audio
    player.play(resource)

    player.on(AudioPlayerStatus.Playing, () => {
        console.log('Audio player is playing')
    })

    player.on(AudioPlayerStatus.Idle, () => {
        console.log('Audio player is idle')
    })

    player.on('error', error => {
        console.error('Audio player error:', error)
    })
}

async function handleLeave(interaction: CommandInteraction<CacheType>) {
    const guildId = interaction.guild?.id
    const connection = getVoiceConnection(guildId!)

    if (!connection) {
        return interaction.reply('Not connected to any voice channel!')
    }

    // Clean up audio streams
    const streams = audioStreams.get(guildId)
    if (streams) {
        streams.forEach((stream: any) => {
            stream.destroy()
        })
        audioStreams.delete(guildId)
    }

    // Close AI session
    if (session) {
        session.close()
        session = undefined
    }

    const player = audioPlayers.get(guildId)
    if (player) {
        player.stop()
        audioPlayers.delete(guildId)
    }

    connection.destroy()
    connections.delete(guildId)

    await interaction.reply('👋 Left voice channel and stopped listening!')
}

// Start the bot
await client.login(process.env['TOKEN'])
