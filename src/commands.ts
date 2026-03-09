import { REST, Routes } from 'discord.js'


export enum AiCommand {
    Join = 'ai-join',
    Leave = 'ai-leave',
    Reset = 'ai-reset',
}

export async function initCommands() {
    const commands: Record<AiCommand, { name: AiCommand, description: string }> = {
        [AiCommand.Join]: { name: AiCommand.Join, description: 'bot joins vc' },
        [AiCommand.Leave]: { name: AiCommand.Leave, description: 'bot leaves vc' },
        [AiCommand.Reset]: { name: AiCommand.Reset, description: "bot reset ai context" }
    }
    const body = Object.values(commands)
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
