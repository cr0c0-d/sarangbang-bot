// TTS 기능: 지정한 채팅방의 메시지를 음성채널에서 읽어줍니다.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { getGuildAudio } from '../audio/guild-audio.js';
import { synthesize } from './synth.js';
import {
  get as getSetting,
  ttsEnabled,
  featureEnabled,
  voiceFor,
  setGuildVoice,
  setUserVoice,
  clearUserVoice,
  userVoice,
  guildVoice,
} from '../settings.js';
import { VOICES, VOICE_CHOICES, voiceLabel, isKoreanOnly } from './voices.js';

// 서버별 on/off 상태. 기본값은 켜짐.
const enabledByGuild = new Map();

function isEnabled(guildId) {
  return enabledByGuild.get(guildId) ?? true;
}

const URL_RE = /https?:\/\/\S+/gi;

/**
 * 디스코드 메시지를 "읽어도 되는 문장"으로 다듬습니다.
 * 멘션 ID, 이모지 코드, 링크를 그대로 읽으면 알아들을 수 없기 때문입니다.
 */
export function cleanText(message, maxChars) {
  let text = message.content ?? '';

  // <@123> 같은 멘션을 사람 이름으로 바꿉니다.
  text = text.replace(/<@!?(\d+)>/g, (_, id) => {
    const m = message.guild?.members?.cache?.get(id);
    return m ? `${m.displayName} ` : '누군가 ';
  });
  text = text.replace(/<@&(\d+)>/g, (_, id) => {
    const r = message.guild?.roles?.cache?.get(id);
    return r ? `${r.name} ` : '역할 ';
  });
  text = text.replace(/<#(\d+)>/g, (_, id) => {
    const c = message.guild?.channels?.cache?.get(id);
    return c ? `${c.name} 채널 ` : '채널 ';
  });

  // <:이름:123> 커스텀 이모지 → 이름만
  text = text.replace(/<a?:(\w+):\d+>/g, '$1 ');

  // 링크는 통째로 읽으면 끔찍하므로 한 단어로 줄입니다.
  text = text.replace(URL_RE, ' 링크 ');

  // 마크다운 기호 제거
  text = text.replace(/[*_~`|>]/g, '');

  // ㅋㅋㅋㅋㅋㅋ, ㅎㅎㅎㅎ, !!!!! 같은 반복은 3개까지만
  text = text.replace(/(.)\1{2,}/g, '$1$1$1');

  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxChars) text = text.slice(0, maxChars) + ' 이하 생략';
  return text;
}

/**
 * TTS가 읽을 음성채널을 정합니다. 위에서부터 먼저 맞는 것을 씁니다.
 *
 * 1. /채널설정 으로 읽어주기 음성채널을 못박아둔 경우 → 그 채널
 * 2. 글이 올라온 곳이 음성채널 안의 채팅인 경우 → **그 음성채널**
 *    (음성채널에는 자체 채팅창이 있습니다. 거기에 쓴 글은 그 채널에서 읽어주는 게 자연스럽습니다)
 * 3. 그 외 → 글 쓴 사람이 들어가 있는 음성채널
 */
async function resolveTtsVoiceChannel(guild, member, sourceChannel) {
  const configured = getSetting(guild.id, 'ttsVoiceChannelId');
  if (configured) {
    const ch = await guild.channels.fetch(configured).catch(() => null);
    if (ch?.isVoiceBased?.()) return ch;
    return null;
  }
  if (sourceChannel?.isVoiceBased?.()) return sourceChannel;
  return member?.voice?.channel ?? null;
}

/**
 * 메시지 하나를 읽어줍니다.
 * @returns {boolean} 처리했으면 true
 */
export async function handleTtsMessage(message) {
  if (!featureEnabled(message.guildId, 'tts')) return false;
  if (!ttsEnabled(message.guildId)) return false;
  if (message.channelId !== getSetting(message.guildId, 'ttsTextChannelId')) return false;
  if (!isEnabled(message.guildId)) return false;

  // "//" 로 시작하면 읽지 않습니다. (귓속말용 탈출구)
  if (message.content.startsWith('//')) return false;

  const text = cleanText(message, config.tts.maxChars);
  if (!text) return false;

  const voiceChannel = await resolveTtsVoiceChannel(message.guild, message.member, message.channel);
  if (!voiceChannel) {
    // 아무도 음성채널에 없으면 조용히 무시합니다. (매번 경고하면 시끄러움)
    return false;
  }

  const spoken = config.tts.readAuthor
    ? `${message.member?.displayName ?? message.author.username}, ${text}`
    : text;

  try {
    const audio = getGuildAudio(message.guild);
    await audio.connect(voiceChannel);
    // 글쓴이가 자기 목소리를 정해뒀으면 그걸 씁니다.
    const voice = voiceFor(message.guildId, message.author.id);
    audio.speak(() => synthesize(spoken, voice), voiceChannel.id);
  } catch (err) {
    console.error('[tts] 실패:', err.message);
    await message.react('⚠️').catch(() => {});
  }
  return true;
}

// ── 슬래시 명령어 ───────────────────────────────────────────

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('읽어주기')
      .setDescription('읽어주기 기능을 켜거나 끕니다')
      .addBooleanOption((o) => o.setName('켜기').setDescription('켜면 true, 끄면 false').setRequired(true)),
    async execute(interaction) {
      if (!ttsEnabled(interaction.guildId)) {
        return interaction.reply({
          content:
            '읽어줄 채팅방이 지정되지 않아 기능이 꺼져 있습니다.\n' +
            '`/채널설정` 에서 종류를 "읽어주기 채팅방" 으로 골라 지정해주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const on = interaction.options.getBoolean('켜기');
      enabledByGuild.set(interaction.guildId, on);
      await interaction.reply(on ? '🔊 읽어주기를 켰습니다.' : '🔇 읽어주기를 껐습니다.');
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('내목소리')
      .setDescription('내 글을 읽을 목소리를 고릅니다 (사람마다 다르게 쓸 수 있습니다)')
      .addStringOption((o) =>
        o
          .setName('목소리')
          .setDescription('고르지 않으면 서버 기본 목소리를 씁니다')
          .setRequired(false)
          .addChoices(...VOICE_CHOICES)
      ),
    async execute(interaction) {
      const picked = interaction.options.getString('목소리');

      if (!picked) {
        // 비우고 실행하면 내 설정을 지웁니다 (서버 기본값으로 돌아감).
        const had = clearUserVoice(interaction.guildId, interaction.user.id);
        const now = voiceFor(interaction.guildId, interaction.user.id);
        return interaction.reply({
          content: had
            ? `🔄 내 목소리 설정을 지웠습니다. 이제 서버 기본값 **${voiceLabel(now)}** 를 씁니다.`
            : `지금 서버 기본값 **${voiceLabel(now)}** 를 쓰고 있습니다.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      setUserVoice(interaction.guildId, interaction.user.id, picked);
      await interaction.reply({
        content: `🗣️ 앞으로 내 글은 **${voiceLabel(picked)}** 로 읽습니다.${koreanOnlyWarning(picked)}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('목소리')
      .setDescription('서버 기본 목소리를 바꿉니다 (개인 설정이 없는 사람에게 적용)')
      .addStringOption((o) =>
        o.setName('목소리').setDescription('서버 기본으로 쓸 목소리').setRequired(true).addChoices(...VOICE_CHOICES)
      ),
    async execute(interaction) {
      const picked = interaction.options.getString('목소리');
      setGuildVoice(interaction.guildId, picked);
      await interaction.reply(
        `🗣️ 서버 기본 목소리를 **${voiceLabel(picked)}** 로 바꿨습니다.` +
          koreanOnlyWarning(picked) +
          '\n(개인 목소리는 `/내목소리` 로 따로 정할 수 있습니다)'
      );
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('목소리목록')
      .setDescription('쓸 수 있는 목소리와 지금 내 설정을 봅니다'),
    async execute(interaction) {
      const mine = userVoice(interaction.guildId, interaction.user.id);
      const server = guildVoice(interaction.guildId) ?? config.tts.voice;

      const lines = VOICES.map((v) => {
        const marks = [];
        if (v.value === mine) marks.push('👤 내 목소리');
        if (v.value === server) marks.push('🏠 서버 기본');
        return `• **${v.label}** — ${v.note}${marks.length ? `  ← ${marks.join(', ')}` : ''}`;
      }).join('\n');

      await interaction.reply({
        content:
          `**쓸 수 있는 목소리 ${VOICES.length}종**\n${lines}\n\n` +
          '`/내목소리` 로 내 목소리만 바꿀 수 있습니다. 비우고 실행하면 서버 기본값으로 돌아갑니다.\n' +
          '"다국어" 목소리는 영어·일본어가 섞여도 자연스럽게 읽습니다.',
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];

/** 한국어 전용 목소리를 골랐을 때만 붙이는 경고. */
function koreanOnlyWarning(voice) {
  if (!isKoreanOnly(voice)) return '';
  return '\n⚠️ 이 목소리는 한국어 전용입니다. 일본어가 섞이면 그 부분은 소리 없이 넘어가고, 영어는 한국어 발음으로 읽습니다.';
}
