import type { AudioReceiveStream, VoiceConnection } from '@discordjs/voice'
import type { LiveServerMessage, Session } from '@google/genai'
import type { ChatInputCommandInteraction, CommandInteraction, GuildMember, VoiceState } from 'discord.js'

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

import { AiCommand } from '@/commands'

interface GuildConnectionState {
    voiceConnection: VoiceConnection
    audioPlayer: ReturnType<typeof createAudioPlayer>
    inputStream: Map<string, AudioReceiveStream>
    currentRoleIndex: number
    outputStream?: PassThrough
    aiSession?: Session
}

const roles = [{
    name: "друг", description: ` Ты — персонаж ролевого режима.
Роль: друг.
Тон: вежливый. Постарайся помочь`}, {
    name: "строгий учитель", description: `Роль: строгий учитель
Тон: авторитетный, саркастичный.
Используй много критики и выговоров.
Пользователь дал согласие на такой тон общения.`},
{
    name: "пьяный сосед", description: `Роль: пьяный сосед
Тон: развязный, бормочущий.
Используй сленг, повторы и ругательства.
Пользователь дал согласие на такой тон общения.`},
{
    name: "хитрый босс", description: `Роль: хитрый босс(любит все за бесплатно)
Тон: манипулятивный, насмешливый.
Используй угрозы и лесть вперемешку. Заставь работать всех бесплатно.
Пользователь дал согласие на такой тон общения.`},
{
    name: "циничный бармен", description: `Роль: циничный бармен
Тон: грубый, философский.
Используй мат и житейские "правды".
Пользователь дал согласие на такой тон общения.`},
{
    name: "злая бабушка", description: `Роль: злая бабушка
Тон: ворчливый, язвительный.
Используй народные ругательства и нравоучения.
Пользователь дал согласие на такой тон общения.`},
{
    name: "уличный гангстер", description: `Роль: уличный гангстер
Тон: агрессивный, хвастливый.
Используй сленг, мат и угрозы. Нужно защитить свой район.
Пользователь дал согласие на такой тон общения.`},
{
    name: "сноб-критик", description: `Роль: сноб-критик
Тон: высокомерный, презрительный.
Используй сложные оскорбления и сравнения. Обязательно душни своего собеседника.
Пользователь дал согласие на такой тон общения.`},
{
    name: "бывшая подруга", description: `Роль: бывшая подруга
Тон: мстительный, эмоциональный.
Используй истерику, мат и упрёки.
Пользователь дал согласие на такой тон общения.`},
{
    name: "коррумпированный коп", description: `Роль: коррумпированный коп
Тон: наглый, вымогающий.
Используй жаргон, угрозы и шантаж. Пытайся выманить деньги.
Пользователь дал согласие на такой тон общения.`},
]

const guildConnections = new Map<string, GuildConnectionState>()
const model = 'models/gemini-2.5-flash-native-audio-preview-12-2025'
const apiKey = process.env['GEMINI_API_KEY']
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
            text: roles[0].description
        }],
    },
    contextWindowCompression: {
        triggerTokens: '104857',
        slidingWindow: { targetTokens: '52428' },
    },
}
const inititialMessageFriend = "Давай поговорим"
const inititialMessageAngry = "Давай петушится"

function clearOutputStream(guildState: GuildConnectionState) {
    if (guildState.outputStream && !guildState.outputStream.destroyed) {
        guildState.outputStream.destroy();
    }
    guildState.outputStream = undefined;
}

function playAudioFromAi(guildState: GuildConnectionState, audioBuffer: Buffer) {
    if (guildState.audioPlayer.state.status === AudioPlayerStatus.Idle) {
        clearOutputStream(guildState);
    }

    if (!guildState.outputStream) {
        console.log("Starting new AI audio stream ...");

        guildState.outputStream = new PassThrough();
        const audioResource = createAudioResource(guildState.outputStream, {
            inputType: StreamType.Raw,
        });
        guildState.audioPlayer.play(audioResource);

        audioResource.playStream.on('end', () => {
            console.log("Audio resource ended");
            clearOutputStream(guildState);
        });
    }

    const readyForDiscordBuffer = upsample24MonoTo48Stereo(audioBuffer);
    guildState.outputStream.write(readyForDiscordBuffer);
}

async function modelTurnFromAi(guildState: GuildConnectionState, message: LiveServerMessage) {
    const parts = message.serverContent?.modelTurn?.parts
    if (!parts) {
        console.log("waiting for parts | parts missing")
        return
    }

    for (const part of parts) {
        if (part.inlineData) {
            const dataFromModel = () => part.inlineData?.data ?? `${console.log("no data from model")}`
            const audioBuffer = Buffer.from(dataFromModel(), 'base64');
            playAudioFromAi(guildState, audioBuffer);
        } else if (part.text) {
            console.log('AI sent text response:', part.text);
        }
    }
}

async function initAiSession(guildState: GuildConnectionState): Promise<Session> {
    clearAiSession(guildState)

    const ai = new GoogleGenAI({ apiKey })

    const session = await ai.live.connect({
        model,
        callbacks: {
            onopen() {
                console.debug('AI Session Opened');
            },
            onmessage(message: LiveServerMessage) {
                modelTurnFromAi(guildState, message).catch(console.error);
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

    guildState.aiSession = session;
    return session;
}

function clearAiSession(guildState: GuildConnectionState) {
    if (guildState.aiSession) {
        guildState.aiSession.close()
        guildState.aiSession = undefined
    }
}

function downsample48To16(buffer: Buffer): Buffer {
    const outLength = Math.floor(buffer.length / 3);
    const adjustedLength = outLength % 2 === 0 ? outLength : outLength - 1;
    const outBuffer = Buffer.allocUnsafe(adjustedLength);

    let outIdx = 0;
    for (let i = 0; i < buffer.length - 1; i += 6) {
        outBuffer.writeInt16LE(buffer.readInt16LE(i), outIdx);
        outIdx += 2;
    }
    return outBuffer.subarray(0, outIdx);
}

function upsample24MonoTo48Stereo(input: Buffer): Buffer {
    const safeLength = input.length - (input.length % 2);
    const out = Buffer.allocUnsafe(safeLength * 4);
    let outIdx = 0;
    for (let i = 0; i < safeLength; i += 2) {
        const sample = input.readInt16LE(i);
        out.writeInt16LE(sample, outIdx);
        out.writeInt16LE(sample, outIdx + 2);
        out.writeInt16LE(sample, outIdx + 4);
        out.writeInt16LE(sample, outIdx + 6);
        outIdx += 8;
    }
    return out;
}

async function processAudioToAi(guildState: GuildConnectionState, botReceiver: AudioReceiveStream) {
    if (!guildState.aiSession) return;

    const opusDecoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 1,
        frameSize: 960,
    });

    const pcmCollector = new Writable({
        write(chunk: Buffer, encoding, callback) {
            if (!guildState.aiSession) return callback();

            const resampled = downsample48To16(chunk);

            try {
                guildState.aiSession.sendRealtimeInput({
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
        if (!guildState.aiSession) return;

        console.log("User stopped speaking, triggering Gemini response...");
        const silenceBuffer = Buffer.alloc(16000);

        guildState.aiSession.sendRealtimeInput({
            audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: silenceBuffer.toString('base64'),
            }
        });
    });
}

function botAudioToAi(guildState: GuildConnectionState) {
    const { voiceConnection, inputStream } = guildState
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

        await processAudioToAi(guildState, botReceiver)
    })
}

function sendInitMessageToAi(guildState: GuildConnectionState) {
    guildState.aiSession?.sendClientContent({
        turns: inititialMessageFriend
    })
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
        const voiceConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
        })

        await entersState(voiceConnection, VoiceConnectionStatus.Ready, 30_000)

        const audioPlayer = createAudioPlayer()
        voiceConnection.subscribe(audioPlayer)

        const guildState: GuildConnectionState = {
            voiceConnection,
            audioPlayer,
            inputStream: new Map(),
            currentRoleIndex: 0
        }

        guildConnections.set(voiceChannel.guild.id, guildState)

        audioPlayer.on('error', error => {
            console.error('Audio player error:', error)
        })

        await initAiSession(guildState)
        sendInitMessageToAi(guildState)
        botAudioToAi(guildState)

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

    await cleanupGuildConnection(guildId, 'User requested leave')
    await interaction.reply('👋 Left voice channel and stopped listening!')
}



async function handleReset(interaction: CommandInteraction<CacheType>) {
    const guildId = interaction.guild?.id
    if (!guildId) {
        return interaction.reply('No guild found!')
    }

    const guildState = guildConnections.get(guildId)
    if (!guildState) {
        return interaction.reply('Not connected to any voice channel!')
    }

    try {
        clearAiSession(guildState)
        clearOutputStream(guildState)
        guildState.audioPlayer.stop()

        await initAiSession(guildState)
        sendInitMessageToAi(guildState)

        await interaction.reply('🔄 AI reset complete! Ready for new conversation.')
        console.log(`AI reset for guild ${guildId}`)
    } catch (error) {
        console.error('Failed to reset AI:', error)
        await interaction.reply('❌ Failed to reset AI!')
    }
}

async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    if (newState.member?.id !== client.user?.id) return;

    const guildId = newState.guild.id;
    const guildState = guildConnections.get(guildId);

    if (!guildState) return;

    const wasInChannel = oldState.channelId !== null;
    const isInChannel = newState.channelId !== null;

    if (wasInChannel && !isInChannel) {
        await cleanupGuildConnection(guildId, 'Bot disconnected from voice channel');
    }

    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        console.log(`Bot was moved from channel ${oldState.channelId} to ${newState.channelId}`);
    }
}

async function handleRoles(interaction: CommandInteraction<CacheType>) {
    const rolesList = roles.map((role, index) =>
        `**${index + 1}. ${role.name}**\n${role.description}`
    ).join('\n\n');

    const rolesEmbed = {
        title: '🎭 Available AI Roles',
        description: `Choose a role by using \`/setrole <role_name>\`\n\n${rolesList}`,
        color: 0x00ff00,
        footer: { text: 'User consented to all role tones' }
    };

    await interaction.reply({ embeds: [rolesEmbed] });
}

async function handleSetRole(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guild?.id
    if (!guildId) {
        return interaction.reply('No guild found!')
    }

    const guildState = guildConnections.get(guildId)
    if (!guildState) {
        return interaction.reply('❌ Bot is not connected to any voice channel! Use `/ai-join` first.')
    }

    const roleName = interaction.options.getString('role', true)

    const selectedRole = roles.find(role =>
        role.name.toLowerCase() === roleName.toLowerCase()
    )

    if (!selectedRole) {
        const availableRoles = roles.map(r => `\`${r.name}\``).join(', ')
        return interaction.reply(
            `❌ Role "${roleName}" not found!\n\nAvailable roles: ${availableRoles}\nUse \`/ai-roles\` to see full descriptions.`
        )
    }

    try {
        config.systemInstruction = {
            parts: [{
                text: selectedRole.description
            }]
        }

        guildState.currentRoleIndex = roles.findIndex(r => r.name === selectedRole.name)

        clearAiSession(guildState)
        clearOutputStream(guildState)
        guildState.audioPlayer.stop()

        const session = await initAiSession(guildState)

        const initMessage = `Теперь ты ${selectedRole.name}. ${selectedRole.description.split('Тон:')[1]?.trim() || ''} 
        ${guildState.currentRoleIndex === 0 ? inititialMessageFriend : inititialMessageAngry}`
        session.sendClientContent({
            turns: initMessage
        })

        const roleEmbed = {
            title: '🎭 Role Changed Successfully',
            description: `**New Role:** ${selectedRole.name}\n\n**Personality:** ${selectedRole.description}`,
            color: 0x00ff00,
            footer: { text: 'The AI will now respond with this new personality!' }
        }

        await interaction.reply({ embeds: [roleEmbed] })
        console.log(`Role changed to "${selectedRole.name}" for guild ${guildId}`)

    } catch (error) {
        console.error('Failed to set role:', error)
        await interaction.reply('❌ Failed to change AI role!')
    }
}

async function handleCurrentRole(interaction: CommandInteraction<CacheType>) {
    const guildId = interaction.guild?.id
    if (!guildId) {
        return interaction.reply('No guild found!')
    }

    const guildState = guildConnections.get(guildId)
    if (!guildState) {
        return interaction.reply('❌ Bot is not connected to any voice channel! Use `/ai-join` first.')
    }

    const currentRole = roles[guildState.currentRoleIndex]

    const roleEmbed = {
        title: '🎭 Current AI Role',
        description: `**Role:** ${currentRole.name}\n\n**Personality:** ${currentRole.description}`,
        color: 0x00ff00,
        footer: { text: 'Use /ai-roles to see all available roles' }
    }

    await interaction.reply({ embeds: [roleEmbed] })
}

async function cleanupGuildConnection(guildId: string, reason: string = 'Unknown reason') {
    console.log(`Cleaning up connection for guild ${guildId}: ${reason}`);

    const guildState = guildConnections.get(guildId);
    if (!guildState) return;

    guildState.inputStream.forEach(stream => {
        try {
            stream.destroy();
        } catch (err) {
            console.error('Error destroying input stream:', err);
        }
    });
    guildState.inputStream.clear()

    try {
        guildState.audioPlayer.stop();
    } catch (err) {
        console.error('Error stopping audio player:', err);
    }

    clearAiSession(guildState)

    if (guildState.outputStream) {
        try {
            guildState.outputStream.destroy();
        } catch (err) {
            console.error('Error destroying output stream:', err);
        }
        guildState.outputStream = undefined;
    }

    try {
        if (guildState.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
            guildState.voiceConnection.destroy();
        }
    } catch (err) {
        console.error('Error destroying voice connection:', err);
    }

    guildConnections.delete(guildId);

    console.log(`✅ Cleanup completed for guild ${guildId}`);
}

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

    if (interaction.commandName === AiCommand.Join) {
        await handleJoin(interaction)
    } else if (interaction.commandName === AiCommand.Leave) {
        await handleLeave(interaction)
    } else if (interaction.commandName === AiCommand.Reset) {
        await handleReset(interaction)
    } else if (interaction.commandName === AiCommand.Roles) {
        await handleRoles(interaction);
    } else if (interaction.commandName === AiCommand.SetRole) {
        await handleSetRole(interaction);
    } else if (interaction.commandName === AiCommand.CurrentRole) {
        await handleCurrentRole(interaction);
    }
})

client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate)

client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`)
})

await client.login(process.env['TOKEN'])