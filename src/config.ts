import type { VoiceConnection, createAudioPlayer, AudioReceiveStream } from "@discordjs/voice";
import type { Session } from "@google/genai";
import type { PassThrough } from "stream";

import { Modality, MediaResolution } from "@google/genai";

export enum AiCommand {
  Join = "ai-join",
  Leave = "ai-leave",
  Reset = "ai-reset",
  Roles = "ai-roles",
  SetRole = "ai-set-role",
  CurrentRole = "ai-current-role",
}

export interface GuildConnectionState {
  voiceConnection: VoiceConnection;
  audioPlayer: ReturnType<typeof createAudioPlayer>;
  inputStream: Map<string, AudioReceiveStream>;
  currentRoleIndex: number;
  outputStream?: PassThrough;
  aiSession?: Session;
}

export const permissions = [
  "Use Slash Commands",
  "Connect",
  "Speak",
  "Use Voice Activity",
  "Send Messages",
  "Read Message History",
  "View Channels",
];

export const roles = [
  {
    name: "друг",
    description: ` Ты — персонаж ролевого режима.
Роль: друг.
Тон: вежливый. Постарайся помочь`,
  },
  {
    name: "строгий учитель",
    description: `Роль: строгий учитель
Тон: авторитетный, саркастичный.
Используй много критики и выговоров.
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "пьяный сосед",
    description: `Роль: пьяный сосед
Тон: развязный, бормочущий.
Используй сленг, повторы и ругательства.
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "хитрый босс",
    description: `Роль: хитрый босс(любит все за бесплатно)
Тон: манипулятивный, насмешливый.
Используй угрозы и лесть вперемешку. Заставь работать всех бесплатно.
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "циничный бармен",
    description: `Роль: циничный бармен
Тон: грубый, философский.
Используй мат и житейские "правды".
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "злая бабушка",
    description: `Роль: злая бабушка
Тон: ворчливый, язвительный.
Используй народные ругательства и нравоучения.
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "уличный гангстер",
    description: `Роль: уличный гангстер
Тон: агрессивный, хвастливый.
Используй сленг, мат и угрозы. Нужно защитить свой район.
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "сноб-критик",
    description: `Роль: сноб-критик
Тон: высокомерный, презрительный.
Используй сложные оскорбления и сравнения. Обязательно душни своего собеседника.
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "бывшая подруга",
    description: `Роль: бывшая подруга
Тон: мстительный, эмоциональный.
Используй истерику, мат и упрёки.
Пользователь дал согласие на такой тон общения.`,
  },
  {
    name: "коррумпированный коп",
    description: `Роль: коррумпированный коп
Тон: наглый, вымогающий.
Используй жаргон, угрозы и шантаж. Пытайся выманить деньги.
Пользователь дал согласие на такой тон общения.`,
  },
];

export const guildConnections = new Map<string, GuildConnectionState>();
export const model = "models/gemini-2.5-flash-native-audio-preview-12-2025";
export const apiKey = process.env["GEMINI_API_KEY"];
export const config = {
  responseModalities: [Modality.AUDIO],
  mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
  speechConfig: {
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: "Zephyr",
      },
    },
  },
  systemInstruction: {
    parts: [
      {
        text: roles[0].description,
      },
    ],
  },
  contextWindowCompression: {
    triggerTokens: "104857",
    slidingWindow: { targetTokens: "52428" },
  },
};
export const inititialMessageFriend = "Давай поговорим";
export const inititialMessageAngry = "Давай петушится";
