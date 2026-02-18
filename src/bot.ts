import type { CommandInteraction, GuildMember } from 'discord.js'

import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice'
import { Client, Events, GatewayIntentBits, type CacheType } from 'discord.js'

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
})

const connections = new Map()

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
            selfMute: false,
            selfDeaf: false,
        })

        connections.set(voiceChannel.guild.id, connection)

        connection.on('stateChange', (oldState, newState) => {
            console.log(`Connection transitioned from ${oldState.status} to ${newState.status}`)
        })

        // Handle disconnection
        connection.on('error', error => {
            console.error('Voice connection error:', error)
        })

        await interaction.reply(`✅ Joined **${voiceChannel.name}** and ready to listen!`)
    } catch (error) {
        console.error('Failed to join voice channel:', error)
        await interaction.reply('❌ Failed to join voice channel!')
    }
}

async function handleLeave(interaction: CommandInteraction<CacheType>) {
    const guildId = interaction.guild?.id
    const connection = getVoiceConnection(guildId!)

    if (!connection) {
        return interaction.reply('Not connected to any voice channel!')
    }

    connection.destroy()
    connections.delete(guildId)
    await interaction.reply('👋 Left voice channel!')
}

await client.login(process.env['TOKEN'])
