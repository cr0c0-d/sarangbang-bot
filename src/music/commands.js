// 음악 기능: 슬래시 명령어 + "채팅방에 유튜브 링크 붙여넣기" 자동 감지
import {
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { getGuildAudio, peekGuildAudio } from '../audio/guild-audio.js';
import { getTracks, formatDuration } from './ytdlp.js';
import { buildPanel, showPanel } from './panel.js';
import { get as getSetting, featureEnabled } from '../settings.js';
import { recent as recentHistory, timeAgo } from './history.js';

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

  const audio = getGuildAudio(guild);
  audio.textChannel = textChannel;

  // 유튜브 추출(수 초)과 음성채널 접속(수백 ms)을 **동시에** 합니다.
  // 예전에는 추출을 다 기다린 뒤에 접속해서 그만큼 더 늦었습니다.
  const [tracks] = await Promise.all([getTracks(query), audio.connect(voiceChannel)]);
  if (tracks.length === 0) throw new Error('재생할 수 있는 곡을 찾지 못했습니다.');

  const wasIdle = !audio.isPlaying;
  audio.add(tracks, member?.user?.tag ?? '알 수 없음');
  audio.playIfIdle();

  return { tracks, wasIdle, audio };
}

/** 한 건을 넣고 사용자에게 보여줄 문구를 돌려줍니다. (/재생 명령용) */
export async function playRequest(opts) {
  const { tracks, wasIdle, audio } = await enqueue(opts);

  if (tracks.length > 1) {
    // 수백 곡짜리 목록은 앞에서부터 잘라 담습니다.
    // 잘렸는데 아무 말도 안 하면 "왜 뒷곡이 없지?" 가 됩니다.
    const total = tracks.totalFound ?? tracks.length;
    const cut = total > tracks.length ? ` (전체 ${total}곡 중 앞 ${tracks.length}곡)` : '';
    return `📃 재생목록에서 **${tracks.length}곡**을 대기열에 넣었습니다.${cut}`;
  }
  const t = tracks[0];
  if (wasIdle) return `🎵 **${t.title}** (${formatDuration(t.duration)}) 재생을 시작합니다.`;
  return `➕ 대기열에 추가: **${t.title}** (${formatDuration(t.duration)}) — 대기열 ${audio.queue.length}번째`;
}

// ── 지난 재생 목록 ──────────────────────────────────────────
//
// "며칠 전에 듣던 그 노래" 를 링크 없이 다시 트는 길입니다.
// 명령어를 새로 만들지 않았습니다(3.6-6). 대신 두 곳에서 같은 화면이 열립니다.
//   · 제어판의 🕐 지난 곡 버튼
//   · /재생 을 **검색어 없이** 실행했을 때
// 나만 보이는 메시지라 채팅방이 더러워지지 않습니다.

const cutLabel = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 지난 곡 고르기 화면. 드롭다운은 디스코드 규격상 25개까지입니다. */
export function buildHistoryPicker(guildId) {
  const list = recentHistory(guildId, 25);
  if (list.length === 0) {
    return {
      content:
        '🕐 아직 들은 곡이 없습니다.\n유튜브 링크를 채팅방에 붙여넣거나 `/재생 <검색어>` 로 한 곡 틀어보세요.',
      flags: MessageFlags.Ephemeral,
    };
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('m:hist:add')
    .setPlaceholder('다시 들을 곡을 고르세요 (여러 곡 가능)')
    .setMinValues(1)
    .setMaxValues(list.length)
    .addOptions(
      list.map((e) => ({
        label: cutLabel(e.title, 100),
        value: e.url, // 드롭다운 값은 100자 제한. history.js 에서 걸러 넣습니다.
        description: `${formatDuration(e.duration)} · ${timeAgo(e.at)}`,
      }))
    );

  return {
    content: `🕐 최근에 들은 **${list.length}곡** 입니다. 고르면 대기열 맨 뒤에 담깁니다.`,
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  };
}

/** 제어판의 🕐 버튼과 그 드롭다운을 처리합니다. (`m:hist` 로 시작하는 것) */
export async function handleHistoryComponent(interaction) {
  if (interaction.customId === 'm:hist') {
    return interaction.reply(buildHistoryPicker(interaction.guildId));
  }
  if (interaction.customId !== 'm:hist:add') return;

  // 곡마다 유튜브 추출이 있어 수 초씩 걸립니다. 먼저 응답부터 잡아둡니다.
  await interaction.deferUpdate();

  const urls = interaction.values;
  const added = [];
  const failed = [];

  // 붙여넣기로 들어온 곡들과 순서가 뒤엉키지 않게 서버별 줄에 세웁니다.
  await serialize(interaction.guildId, async () => {
    for (const url of urls) {
      try {
        const { tracks } = await enqueue({
          query: url,
          guild: interaction.guild,
          member: interaction.member,
          textChannel: interaction.channel,
        });
        added.push(tracks[0]?.title ?? url);
      } catch (err) {
        failed.push(err.message);
      }
    }
  });

  const lines = [];
  if (added.length > 0) {
    lines.push(`➕ **${added.length}곡**을 대기열에 담았습니다.`);
    lines.push(...added.slice(0, 10).map((t) => `• ${cutLabel(t, 80)}`));
    if (added.length > 10) lines.push(`… 외 ${added.length - 10}곡`);
  }
  // 실패 사유는 곡마다 같은 경우가 많아(음성채널 미입장 등) 한 번만 보여줍니다.
  for (const msg of [...new Set(failed)]) lines.push(`⚠️ ${msg}`);

  // 고르기 화면은 역할을 다했으므로 결과로 바꿉니다 (드롭다운 제거).
  await interaction.editReply({ content: lines.join('\n'), components: [] });

  if (added.length > 0) {
    const audio = peekGuildAudio(interaction.guildId);
    if (audio) showPanel(audio, audio.textChannel ?? interaction.channel);
  }
}

// ── 슬래시 명령어들 ─────────────────────────────────────────

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('재생')
      .setDescription('유튜브 링크나 검색어로 재생합니다 (비우면 지난 곡 목록에서 고릅니다)')
      .addStringOption((o) =>
        o.setName('검색어').setDescription('유튜브 링크 또는 검색할 노래 제목').setRequired(false)
      ),
    async execute(interaction) {
      const query = interaction.options.getString('검색어');

      // 검색어 없이 실행하면 지난 곡 목록을 보여줍니다.
      // 이걸 위해 명령어를 따로 만들지 않습니다 (명령어가 또 늘어납니다).
      if (!query) {
        return interaction.reply(buildHistoryPicker(interaction.guildId));
      }

      await interaction.deferReply();
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

  // /나가기 는 여기 있었지만 src/leave-commands.js 로 옮겼습니다.
  // 음악을 떼어내면 망고 쪽에 음성채널에서 나올 방법이 사라지기 때문입니다.
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

  // ⏳ 를 **즉시** 답니다.
  // 유튜브 추출에 몇 초가 걸리는데 그동안 아무 반응이 없으면 "먹통인가?" 싶습니다.
  // 실제 처리는 그대로지만 체감 반응은 즉시가 됩니다.
  message.react('⏳').catch(() => {});

  // 이 메시지의 처리를 통째로 줄 세웁니다.
  // 링크 여러 개를 연달아 보내도 **보낸 순서대로** 대기열에 들어갑니다.
  serialize(message.guildId, async () => {
    const added = [];
    const failed = [];
    const truncated = []; // 재생목록이 잘린 것들 (전체 N곡 중 앞 M곡)

    for (const link of links) {
      try {
        const { tracks } = await enqueue({
          query: link,
          guild: message.guild,
          member: message.member,
          textChannel: message.channel,
        });
        added.push(...tracks);
        const total = tracks.totalFound ?? tracks.length;
        if (total > tracks.length) truncated.push({ total, taken: tracks.length });
      } catch (err) {
        failed.push(err.message);
      }
    }

    // 잘렸는데 아무 말도 안 하면 "왜 뒷곡이 없지?" 가 됩니다.
    // 링크 붙여넣기는 제어판만 뜨고 안내가 없으므로 여기서 알려줍니다.
    for (const t of truncated) {
      await message.channel
        .send(`📃 재생목록이 길어서 **앞 ${t.taken}곡**만 담았습니다. (전체 ${t.total}곡)`)
        .catch(() => {});
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
