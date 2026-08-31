// TTS 기능: 지정한 채팅방의 메시지를 음성채널에서 읽어줍니다.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { getGuildAudio } from '../audio/guild-audio.js';
import { synthesize, listVoices } from './synth.js';
import { get as getSetting, ttsEnabled, featureEnabled } from '../settings.js';

// 서버별 on/off 상태. 기본값은 켜짐.
const enabledByGuild = new Map();
// 서버별 목소리 설정. 없으면 .env 기본값.
const voiceByGuild = new Map();

function isEnabled(guildId) {
  return enabledByGuild.get(guildId) ?? true;
}

function voiceFor(guildId) {
  return voiceByGuild.get(guildId) ?? config.tts.voice;
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
    const voice = voiceFor(message.guildId);
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
      .setName('목소리')
      .setDescription('읽어주기 목소리를 바꿉니다')
      .addStringOption((o) =>
        o
          .setName('이름')
          .setDescription('예: ko-KR-SunHiNeural')
          .setRequired(true)
          .addChoices(
            // Edge TTS 가 실제로 제공하는 한국어 목소리는 이 셋뿐입니다.
            // (2026-08-31 실측. 다른 이름을 넣으면 런타임에 실패합니다)
            { name: '현수 — 남성, 다국어 (기본·권장)', value: 'ko-KR-HyunsuMultilingualNeural' },
            { name: '선희 — 여성, 한국어 전용', value: 'ko-KR-SunHiNeural' },
            { name: '인준 — 남성, 한국어 전용', value: 'ko-KR-InJoonNeural' }
          )
      ),
    async execute(interaction) {
      const name = interaction.options.getString('이름');
      voiceByGuild.set(interaction.guildId, name);
      // 한국어 전용 목소리는 일본어를 만나면 소리를 아예 내지 않습니다. 미리 알려줍니다.
      const warn = name.includes('Multilingual')
        ? ''
        : '\n⚠️ 이 목소리는 한국어 전용입니다. 일본어가 섞이면 그 부분은 소리 없이 넘어가고,' +
          ' 영어는 한국어 발음으로 읽습니다.';
      await interaction.reply(`🗣️ 목소리를 **${name}** 로 바꿨습니다.${warn}`);
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('목소리목록')
      .setDescription('사용 가능한 한국어 목소리를 모두 봅니다'),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const voices = await listVoices('ko-');
        const text = voices.map((v) => `- \`${v.shortName}\` (${v.gender})`).join('\n');
        await interaction.editReply(`**한국어 목소리 목록**\n${text || '없음'}`);
      } catch (err) {
        await interaction.editReply(`목록을 가져오지 못했습니다: ${err.message}`);
      }
    },
  },
];
