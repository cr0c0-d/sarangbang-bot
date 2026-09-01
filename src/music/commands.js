// 음악 기능: 슬래시 명령어 + "채팅방에 유튜브 링크 붙여넣기" 자동 감지
import { SlashCommandBuilder, PermissionsBitField, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { getGuildAudio, peekGuildAudio } from '../audio/guild-audio.js';
import { getTracks, formatDuration } from './ytdlp.js';
import { buildPanel, showPanel } from './panel.js';
import { get as getSetting, featureEnabled } from '../settings.js';

// 유튜브 링크인지 판별. (youtube.com, youtu.be, music.youtube.com)
const YOUTUBE_RE =
  /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?|playlist\?|shorts\/|live\/)|youtu\.be\/)\S+/gi;

export function findYoutubeLink(text) {
  return findYoutubeLinks(text)[0] ?? null;
}

/**
 * 메시지 안의 유튜브 링크를 **전부** 찾습니다.
 * 한 번에 여러 곡을 붙여넣는 경우가 많아서, 첫 번째만 보면 나머지가 조용히 무시됩니다.
 */
export function findYoutubeLinks(text) {
  // /g 플래그가 붙은 정규식은 lastIndex 를 들고 다니므로 매번 초기화합니다.
  YOUTUBE_RE.lastIndex = 0;
  const found = String(text ?? '').match(YOUTUBE_RE) ?? [];
  // 같은 링크를 두 번 붙여넣은 경우는 한 번만 넣습니다.
  return [...new Set(found)];
}

/**
 * 서버별로 작업을 한 줄로 세웁니다.
 *
 * 왜 필요한가: 링크 3개를 연달아 붙여넣으면 handleMusicMessage 가 3번 동시에 돌고,
 * 각자 getTracks(수 초 소요)를 하느라 **먼저 보낸 링크가 나중에 대기열에 들어갈 수 있습니다.**
 * 사용자는 보낸 순서대로 재생되기를 기대하므로 순서를 보장해야 합니다.
 */
const guildChains = new Map();

function serialize(guildId, fn) {
  const prev = guildChains.get(guildId) ?? Promise.resolve();
  // 앞 작업이 실패해도 뒤 작업은 실행되어야 하므로 양쪽 핸들러에 같은 fn 을 답니다.
  const next = prev.then(fn, fn);
  guildChains.set(
    guildId,
    next.catch(() => {})
  );
  return next;
}

/**
 * 봇이 들어갈 음성채널을 정합니다.
 * .env 에 MUSIC_VOICE_CHANNEL_ID 가 있으면 항상 그 채널, 없으면 명령한 사람이 있는 채널.
 */
async function resolveVoiceChannel(guild, member) {
  const configured = getSetting(guild.id, 'musicVoiceChannelId');
  if (configured) {
    const ch = await guild.channels.fetch(configured).catch(() => null);
    if (!ch?.isVoiceBased?.()) {
      throw new Error(
        '지정된 음악 음성채널을 찾을 수 없습니다. /채널설정 으로 다시 지정해주세요.'
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
export async function enqueue({ query, guild, member, textChannel }) {
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

  return { tracks, wasIdle, audio };
}

/** 한 건을 넣고 사용자에게 보여줄 문구를 돌려줍니다. (/재생 명령용) */
export async function playRequest(opts) {
  const { tracks, wasIdle, audio } = await enqueue(opts);

  if (tracks.length > 1) {
    return `📃 재생목록에서 **${tracks.length}곡**을 대기열에 넣었습니다.`;
  }
  const t = tracks[0];
  if (wasIdle) return `🎵 **${t.title}** (${formatDuration(t.duration)}) 재생을 시작합니다.`;
  return `➕ 대기열에 추가: **${t.title}** (${formatDuration(t.duration)}) — 대기열 ${audio.queue.length}번째`;
}

// ── 슬래시 명령어들 ─────────────────────────────────────────

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
    data: new SlashCommandBuilder()
      .setName('대기열')
      .setDescription('재생 목록을 보고 버튼으로 조작합니다'),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      if (audio) audio.textChannel = interaction.channel;
      // 버튼이 달린 제어판을 새로 띄웁니다. 이후 곡이 바뀌면 이 메시지가 수정됩니다.
      const sent = await interaction.reply({ ...buildPanel(audio), withResponse: true });
      if (audio) {
        audio.panelMessage = sent?.resource?.message ?? (await interaction.fetchReply().catch(() => null));
      }
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('순서이동')
      .setDescription('대기열에서 곡의 순번을 바꿉니다')
      .addIntegerOption((o) =>
        o.setName('번호').setDescription('옮길 곡의 현재 번호').setRequired(true).setMinValue(1)
      )
      .addIntegerOption((o) =>
        o.setName('새번호').setDescription('옮길 위치 (1이면 맨 앞)').setRequired(true).setMinValue(1)
      ),
    async execute(interaction) {
      const audio = peekGuildAudio(interaction.guildId);
      const from = interaction.options.getInteger('번호');
      const to = interaction.options.getInteger('새번호');
      const item = audio?.moveTo(from, to);
      if (!item) {
        return interaction.reply({
          content: '그 번호의 곡이 없습니다. `/대기열` 로 번호를 확인해주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const now = audio.queue.indexOf(item) + 1;
      await interaction.reply(`↕️ **${item.track.title}** 을(를) ${now}번으로 옮겼습니다.`);
      showPanel(audio, audio.textChannel);
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
  if (!featureEnabled(message.guildId, 'music')) return false;

  const watched = getSetting(message.guildId, 'musicTextChannelId');
  if (watched && message.channelId !== watched) return false;

  const links = findYoutubeLinks(message.content);
  if (links.length === 0) return false;

  // 이 메시지의 처리를 통째로 줄 세웁니다.
  // 링크 여러 개를 연달아 보내도 **보낸 순서대로** 대기열에 들어갑니다.
  serialize(message.guildId, async () => {
    const added = [];
    const failed = [];

    for (const link of links) {
      try {
        const { tracks } = await enqueue({
          query: link,
          guild: message.guild,
          member: message.member,
          textChannel: message.channel,
        });
        added.push(...tracks);
      } catch (err) {
        failed.push(err.message);
      }
    }

    if (added.length === 0) {
      // 실패했을 때는 원본 메시지를 남겨둡니다. 뭘 보냈는지 봐야 하므로.
      await message.reply(`⚠️ ${failed[0] ?? '재생할 수 없습니다.'}`).catch(() => {});
      return;
    }

    // 일부만 실패했으면 그것만 알려줍니다. (성공한 건 제어판에 이미 보입니다)
    if (failed.length > 0) {
      await message
        .reply(`⚠️ ${links.length}개 중 ${failed.length}개는 실패했습니다: ${failed[0]}`)
        .catch(() => {});
      return;
    }

    // 전부 성공: **링크 메시지를 지웁니다.**
    // 이게 쌓이면 제어판이 위로 밀려나서, 소유자가 "항상 제어판이 최신으로 보였으면 좋겠다" 고 요청했습니다.
    // 지울 권한이 없으면(메시지 관리 권한 없음) 조용히 반응만 남깁니다.
    const deleted = await message.delete().then(
      () => true,
      () => false
    );
    if (!deleted) {
      await message.react('✅').catch(() => {});
      console.warn(
        '[music] 링크 메시지를 지우지 못했습니다. 봇에게 "메시지 관리(Manage Messages)" 권한이 필요합니다.'
      );
    }

    // 제어판을 맨 아래로 다시 올립니다. (이미 재생 중이던 경우에도 대기열이 바뀌었으므로)
    const audio = peekGuildAudio(message.guildId);
    if (audio) showPanel(audio, message.channel);
  });

  return true;
}
