import { REST, Routes, SlashCommandBuilder } from 'discord.js'

export enum AiCommand {
    Join = 'ai-join',
    Leave = 'ai-leave',
    Reset = 'ai-reset',
    Roles = 'ai-roles',
    SetRole = "ai-set-role",
    CurrentRole = "ai-current-role"
}

export async function initCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName(AiCommand.Join)
            .setDescription('bot joins vc'),

        new SlashCommandBuilder()
            .setName(AiCommand.Leave)
            .setDescription('bot leaves vc'),

        new SlashCommandBuilder()
            .setName(AiCommand.Reset)
            .setDescription("bot reset ai context"),

        new SlashCommandBuilder()
            .setName(AiCommand.Roles)
            .setDescription("show available roles"),

        new SlashCommandBuilder()
            .setName(AiCommand.SetRole)
            .setDescription("set new role")
            .addStringOption(option =>
                option.setName('role')
                    .setDescription('The role name to set')
                    .setRequired(true)
                    .addChoices(
                        { name: 'друг', value: 'друг' },
                        { name: 'строгий учитель', value: 'строгий учитель' },
                        { name: 'пьяный сосед', value: 'пьяный сосед' },
                        { name: 'хитрый босс', value: 'хитрый босс' },
                        { name: 'циничный бармен', value: 'циничный бармен' },
                        { name: 'злая бабушка', value: 'злая бабушка' },
                        { name: 'уличный гангстер', value: 'уличный гангстер' },
                        { name: 'сноб-критик', value: 'сноб-критик' },
                        { name: 'бывшая подруга', value: 'бывшая подруга' },
                        { name: 'коррумпированный коп', value: 'коррумпированный коп' }
                    )
            ),

        new SlashCommandBuilder()
            .setName(AiCommand.CurrentRole)
            .setDescription("show the current AI role"),
    ];

    const rest = new REST({ version: '10' }).setToken(process.env['TOKEN']!)

    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env['CLIENT_ID']!, process.env['GUILD_ID']!),
            { body: commands.map(command => command.toJSON()) },
        )
        console.log(
            '✅ Registered commands:',
            commands.map(c => c.name),
        )
    } catch (error) {
        console.error('❌ Failed to register:', error)
    }
}