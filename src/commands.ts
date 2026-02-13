import { REST, Routes } from 'discord.js'

export async function initCommands() {
    const commands = {
        joinVc: { name: 'join', description: 'bot joins vc' },
        leaveVc: { name: 'leave', description: 'bot leaves vc' },
    }
    const body = [commands.joinVc, commands.leaveVc]
    const rest = new REST({ version: '10' }).setToken(process.env['TOKEN']!)

    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env['CLIENT_ID']!, process.env['GUILD_ID']!),
            { body },
        )
        console.log(
            '✅ Registered commands:',
            body.map(c => c.name),
        )
    } catch (error) {
        console.error('❌ Failed to register:', error)
    }
}
