import { REST, Routes, SlashCommandBuilder } from "discord.js";

import { AiCommand } from "@/config";

export async function initCommands() {
  const commands = [
    new SlashCommandBuilder().setName(AiCommand.Join).setDescription("бот зайдет в войс"),
    new SlashCommandBuilder().setName(AiCommand.Leave).setDescription("бот выйдет из войса"),
    new SlashCommandBuilder().setName(AiCommand.Reset).setDescription("перезапустить контекст ии"),
    new SlashCommandBuilder().setName(AiCommand.Roles).setDescription("показать доступные роли"),
    new SlashCommandBuilder()
      .setName(AiCommand.SetRole)
      .setDescription("поменять роль")
      .addStringOption((option) =>
        option
          .setName("role")
          .setDescription("выберите")
          .setRequired(true)
          .addChoices(
            { name: "друг", value: "друг" },
            { name: "строгий учитель", value: "строгий учитель" },
            { name: "пьяный сосед", value: "пьяный сосед" },
            { name: "хитрый босс", value: "хитрый босс" },
            { name: "циничный бармен", value: "циничный бармен" },
            { name: "злая бабушка", value: "злая бабушка" },
            { name: "уличный гангстер", value: "уличный гангстер" },
            { name: "сноб-критик", value: "сноб-критик" },
            { name: "бывшая подруга", value: "бывшая подруга" },
            { name: "коррумпированный коп", value: "коррумпированный коп" },
          ),
      ),

    new SlashCommandBuilder().setName(AiCommand.CurrentRole).setDescription("показать текущую роль"),
  ];

  const rest = new REST({ version: "10" }).setToken(process.env["TOKEN"]!);

  try {
    await rest.put(Routes.applicationGuildCommands(process.env["CLIENT_ID"]!, process.env["GUILD_ID"]!), {
      body: commands.map((command) => command.toJSON()),
    });
    console.log(
      "✅ Registered commands:",
      commands.map((c) => c.name),
    );
  } catch (error) {
    console.error("❌ Failed to register:", error);
  }
}
