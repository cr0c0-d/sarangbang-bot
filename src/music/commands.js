// 음악 기능: 슬래시 명령어 + "채팅방에 유튜브 링크 붙여넣기" 자동 감지
import { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionsBitField, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { getGuildAudio, peekGuildAudio } from '../audio/guild-audio.js';
import { getTracks, formatDuration } from './ytdlp.js';
import { get as getSetting } from '../settings.js';

// 유튜브 링크인지 판별. (youtube.com, youtu.be, music.youtube.com)
const YOUTUBE_RE =
  /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?|playlist\?|shorts\/|live\/)|youtu\.be\/)\S+/i;

export function findYoutubeLink(text) {
  return text.match(YOUTUBE_RE)?.[0] ?? null;
}

/**
 * 봇이 들어갈 음성채널을 정합니다.
 * .env 에 MUSIC_VOICE_CHANNEL_ID 가 있으면 항상 그 채널, 없으면 명령한 사람이 있는 채널.
 */
async function resolveVoiceChannel(guild, member) {
  const configured = getSetting(guild.id, 'musicVoiceChannelId');
  if (configured) {
    const ch = await guild.channels.fetch(configured).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildVoice) {
      throw new Error(
        '지정된 음악 음성채널을 찾을 수 없습니다. /채널확인 으로 설정을 보고 /채널설정 으로 다시 지정해주세요.'
      );
    }
    return ch;
  }

  const ch = member?.voice?.channel;
  if (!ch) {
    throw new Error(
      '먼저 음성채널에 들어간 뒤 다시 시도해주세요. (또는 /채널설정 으로 음악 음성채널을 지정하세요)'
    );
  }
  return ch;
}

function assertCanJoin(voiceChannel, guild) {
  const me = guild.members.me;
  const perms = voiceChannel.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.Connect)) {
    throw new Error(`**${voiceChannel.name}** 에 들어갈 권한이 없습니다. (연결 권한 필요)`);
  }
  if (!perms.has(PermissionsBitField.Flags.Speak)) {
    throw new Error(`**${voiceChannel.name}** 에서 말할 권한이 없습니다. (말하기 권한 필요)`);
  }
}

/**
 * 링크/검색어를 받아 큐에 넣고 재생을 시작하는 공통 로직.
 * 슬래시 명령과 링크 자동감지 양쪽에서 같이 씁니다.
 * @returns {Promise<string>} 사용자에게 보여줄 결과 메시지
 */
export async function playRequest({ query, guild, member, textChannel }) {
  const voiceChannel = await resolveVoiceChannel(guild, member);
  assertCanJoin(voiceChannel, guild);

  const tracks = await getTracks(query);
  if (tracks.length === 0) throw new Error('재생할 수 있는 곡을 찾지 못했습니다.');

  const audio = getGuildAudio(guild);
  audio.textChannel = textChannel;
  await audio.connect(voiceChannel);

  const wasIdle = !audio.isPlaying;
  audio.add(tracks, member?.user?.tag ?? '알 수 없음');
  audio.playIfIdle();

  if (tracks.length > 1) {
    return `📃 재생목록에서 **${tracks.length}곡**을 대기열에 넣었습니다.`;
  }
  const t = tracks[0];
  if (wasIdle) return `🎵 **${t.title}** (${formatDuration(t.duration)}) 재생을 시작합니다.`;
  return `➕ 대기열에 추가: **${t.title}** (${formatDuration(t.duration)}) — 대기열 ${audio.queue.length}번째`;
}

// ── 슬래시 명령어들 ─────────────────────────────────────────

function requireAudio(interaction) {
  const audio = peekGuildAudio(interaction.guildId);
  if (!audio || (!audio.isPlaying && audio.queue.length === 0)) {
    return null;
  }
  return audio;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('재생')
      .setDescription('유튜브 링크나 검색어로 음악을 재생합니다')
      .addStringOption((o) =>
        o.setName('검색어').setDescription('유튜브 링크 또는 검색할 노래 제목').setRequired(true)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      const query = interaction.options.getString('검색어');
      const msg = await playRequest({
        query,
        guild: interaction.guild,
        member: interaction.member,
        textChannel: interaction.channel,
      });
      await interaction.editReply(msg);
    },
  },

  {
    data: new SlashCommandBuilder().setName('다음').setDescription('현재 곡을 건너뜁니다'),
    async execute(interaction) {
      const audio = requireAudio(interaction);
      if (!audio) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
      const skipped = audio.skip();
      await interaction.reply(`⏭️ 건너뜀: **${skipped?.track?.title ?? '알 수 없음'}**`);
    },
  },

  {
    data: new SlashCommandBuilder().setName('정지').setDescription('재생을 멈추고 대기열을 비웁니다'),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      if (!audio) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
      audio.stop();
      await interaction.reply('⏹️ 재생을 멈추고 대기열을 비웠습니다.');
    },
  },

  {
    data: new SlashCommandBuilder().setName('일시정지').setDescription('일시정지'),
    async execute(interaction) {
      const audio = requireAudio(interaction);
      if (!audio) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
      audio.pause();
      await interaction.reply('⏸️ 일시정지했습니다.');
    },
  },

  {
    data: new SlashCommandBuilder().setName('이어재생').setDescription('일시정지 해제'),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      if (!audio) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
      audio.resume();
      await interaction.reply('▶️ 다시 재생합니다.');
    },
  },

  {
    data: new SlashCommandBuilder().setName('반복').setDescription('현재 곡 반복재생을 켜고 끕니다'),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      if (!audio) return interaction.reply({ content: '재생 중인 곡이 없습니다.', flags: MessageFlags.Ephemeral });
      audio.loop = !audio.loop;
      await interaction.reply(audio.loop ? '🔁 반복재생 켜짐' : '➡️ 반복재생 꺼짐');
    },
  },

  {
    data: new SlashCommandBuilder().setName('대기열').setDescription('대기열을 봅니다'),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      if (!audio || (!audio.current && audio.queue.length === 0)) {
        return interaction.reply({ content: '대기열이 비어 있습니다.', flags: MessageFlags.Ephemeral });
      }

      const lines = [];
      if (audio.current) {
        lines.push(
          `**지금 재생 중**\n${audio.current.track.title} (${formatDuration(audio.current.track.duration)})`
        );
      }
      if (audio.queue.length > 0) {
        const shown = audio.queue
          .slice(0, 10)
          .map((it, i) => `${i + 1}. ${it.track.title} (${formatDuration(it.track.duration)})`)
          .join('\n');
        const more = audio.queue.length > 10 ? `\n… 외 ${audio.queue.length - 10}곡` : '';
        lines.push(`**대기열 (${audio.queue.length}곡)**\n${shown}${more}`);
      }

      const embed = new EmbedBuilder()
        .setTitle('🎶 재생 대기열')
        .setDescription(lines.join('\n\n'))
        .setColor(0x5865f2);
      await interaction.reply({ embeds: [embed] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('나가기').setDescription('음성채널에서 나갑니다'),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      if (!audio) return interaction.reply({ content: '음성채널에 있지 않습니다.', flags: MessageFlags.Ephemeral });
      audio.destroy();
      await interaction.reply('👋 음성채널에서 나왔습니다.');
    },
  },
];

/**
 * 지정된 채팅방에 올라온 유튜브 링크를 자동으로 재생합니다.
 * @returns {boolean} 이 메시지를 처리했으면 true
 */
export async function handleMusicMessage(message) {
  const watched = getSetting(message.guildId, 'musicTextChannelId');
  if (watched && message.channelId !== watched) return false;

  const link = findYoutubeLink(message.content);
  if (!link) return false;

  try {
    const msg = await playRequest({
      query: link,
      guild: message.guild,
      member: message.member,
      textChannel: message.channel,
    });
    await message.reply(msg);
  } catch (err) {
    await message.reply(`⚠️ ${err.message}`).catch(() => {});
  }
  return true;
}
