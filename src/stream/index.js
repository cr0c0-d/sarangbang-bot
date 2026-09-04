// 🎥 방송 기록 (타임머신) — 유튜브 라이브 하이라이트 시간 찍기.
//
// 설계와 함정은 docs/게임방송-기획.md 에 있습니다. 고치기 전에 읽으세요.
// 특히 다음 셋은 실수하기 쉽습니다.
//   · 시각 기준은 `release_timestamp` 입니다. 명령 실행 시각이 아닙니다. (2.2)
//   · 마킹은 입력을 받지 않습니다. 게임 중이니까요. (1-3)
//   · 마킹 버튼은 **답을 먼저 하고** 제어판을 나중에 고칩니다. (3.10)
//
// 명령어는 `/방송` 하나뿐이고 나머지는 전부 버튼입니다. (규칙 3.6-6)
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { userError } from '../user-error.js';
import { get as getSetting, streamHome, setStreamHome } from '../settings.js';
import { liveInfo } from '../music/ytdlp.js';
import {
  activeSession,
  sessionById,
  recentSessions,
  lastGameForUser,
  openSession,
  closeSession,
  reopenSession,
  setGame,
  setStreamGame,
  putStream,
  streamOf,
  setOffset,
  addMark,
  removeLastMark,
  shareMark,
  markSecondsFor,
  setMarkText,
  addClip,
  clipsOf,
  timelineFor,
  hhmmss,
  humanDuration,
  nowSec,
  MARK_MAX,
} from './store.js';
import { resolveGame, autocompleteGames } from '../game/steam.js';
import { publishStreamRecord } from '../game/forum.js';
import {
  buildSummary,
  buildClipPicker,
  buildOffsetModal,
  buildDescModal,
  buildClipModal,
  buildSessionPicker,
  ensureStreamPanel,
  repostStreamPanel,
  scheduleStreamPanelRefresh,
  DESC_PER_PAGE,
} from './panel.js';
import { makeClip, clipPageUrl, fmtBytes, cleanupByBudget, filePath as clipFilePath } from './clips.js';
import { enabled as driveEnabled, uploadClip } from './drive.js';
import { config } from '../config.js';

/** 오프셋을 이 범위 밖으로 두면 실수입니다. 6시간이면 어떤 방송이든 덮습니다. */
const OFFSET_LIMIT_SEC = 6 * 3600;

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

/**
 * 유튜브 링크에서 영상 ID 를 뽑습니다.
 *
 * ⚠️ **`watch?v=` 만 보면 안 됩니다.** 라이브를 켜면 유튜브가 주는 주소는
 *    `youtube.com/live/<id>` 입니다. 실제로 붙여넣는 건 그 형태입니다.
 */
export function parseVideoId(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  // 주소가 아니라 ID 만 붙여넣은 경우도 받아줍니다.
  if (/^[\w-]{11}$/.test(text)) return text;

  const patterns = [
    /[?&]v=([\w-]{11})/, // youtube.com/watch?v=ID
    /youtu\.be\/([\w-]{11})/i, // youtu.be/ID
    /\/live\/([\w-]{11})/i, // youtube.com/live/ID  ← 라이브가 주는 형태
    /\/embed\/([\w-]{11})/i,
    /\/shorts\/([\w-]{11})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/**
 * **채널 고정 주소**인가. (`youtube.com/@계정/live` 처럼 방송마다 안 바뀌는 주소)
 *
 * ★ 이걸 알아보는 것이 "매번 링크 붙이기" 를 없애는 열쇠입니다.
 *   yt-dlp 가 이 주소를 **지금 하는 방송**으로 풀어줍니다 (실측: `@ABCNews/live` → 현재 방송).
 *   그래서 사람마다 한 번만 저장해두면 그다음부터 버튼 하나로 등록됩니다.
 */
export function parseLiveHome(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  // @계정 만 적은 경우도 받아줍니다.
  const handle = text.match(/^@([\w.-]{3,30})$/);
  if (handle) return `https://www.youtube.com/@${handle[1]}/live`;

  const m = text.match(
    /^https?:\/\/(?:www\.|m\.)?youtube\.com\/((?:@[\w.-]+)|(?:channel\/[\w-]+)|(?:c\/[\w.-]+)|(?:user\/[\w.-]+))(?:\/live)?\/?$/i
  );
  if (!m) return null;
  return `https://www.youtube.com/${m[1]}/live`;
}

/** `/방송` 을 쓸 수 있는 상태인지 확인하고 방송 채널 ID 를 돌려줍니다. */
function requireHomeChannel(guildId) {
  const channelId = getSetting(guildId, 'streamChannelId');
  if (!channelId) {
    throw userError(
      '방송 채널이 지정되지 않았습니다.\n' +
        '`/채널설정` 에서 **방송 채널**을 정해주세요. 그 채널에 제어판이 상주합니다.\n' +
        '(그 채널은 일반 사용자의 "메시지 보내기"를 막아두는 것이 좋습니다 — 제어판이 밀리지 않습니다)'
    );
  }
  return channelId;
}

// ── 상태 보기 (`/방송` 을 인자 없이) ──────────────────────────
//
// 상태를 보는 명령어를 따로 만들지 않습니다. 명령어가 불어납니다. (규칙 3.6-6)

function buildStatus(guildId, userId) {
  const embed = new EmbedBuilder().setColor(0xe67e22).setTitle('🎥 방송 기록');
  const session = activeSession(guildId);
  const channelId = getSetting(guildId, 'streamChannelId');
  const lines = [];

  lines.push(
    channelId ? `제어판: <#${channelId}>` : '⚠️ 방송 채널이 없습니다. `/채널설정` 에서 정해주세요.'
  );
  lines.push('');

  if (session) {
    const now = nowSec();
    lines.push(
      `**기록 중** — ${session.game || '이름 없음'} · 켠 지 ${humanDuration(now - session.openedAt)} · 마킹 ${session.marks.length}개`
    );
    for (const s of session.streams) {
      lines.push(
        `· <@${s.userId}> — **${s.game || '게임 미지정'}** · 시작 <t:${s.startedAt}:t> · ${humanDuration(now - s.startedAt - (s.offsetSec ?? 0))} 진행 중`
      );
    }
    if (session.streams.length === 0) lines.push('· 아직 등록한 사람이 없습니다.');
  } else {
    lines.push('기록 중인 방송이 없습니다.');
    lines.push('`/방송 링크:<내 라이브 주소> 게임명:<이름>` 으로 시작하세요.');
  }

  // 저장해둔 고정 주소를 보여줍니다. 무엇이 저장됐는지 볼 수 없으면 고칠 수도 없습니다.
  const home = streamHome(guildId, userId);
  lines.push('');
  lines.push(
    home
      ? `📌 내 고정 주소: ${home}\n(제어판의 **🎬 지난 게임으로 등록** 이 이 주소와 마지막 게임을 씁니다. 바꾸려면 \`/방송 링크:… 게임명:…\` 으로 다시 등록하세요)`
      : '📌 등록은 `/방송 링크:<이번 방송 주소>` 로 합니다.\n' +
          '**공개**로 방송하신다면 `…/@내계정/live` 를 한 번 등록해두면 같은 게임은 **🎬 지난 게임으로 등록** 만 누르면 됩니다.\n' +
          '**일부공개는 그 방법이 안 됩니다** — 채널 목록에 안 떠서 유튜브가 못 찾아줍니다. 방송마다 주소를 넣어주세요.'
  );

  const past = recentSessions(guildId, 6).filter((s) => s.closedAt);
  if (past.length > 0) {
    lines.push('');
    lines.push('**지난 방송**');
    for (const s of past) {
      lines.push(`· <t:${s.openedAt}:d> ${s.game || '이름 없음'} · 마킹 ${s.marks.length}개 · 참여 ${s.streams.length}명`);
    }
  }

  embed.setDescription(lines.join('\n').slice(0, 3800));
  return embed;
}

// ── 명령어 ────────────────────────────────────────────────────

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('방송')
      .setDescription('라이브를 등록해 하이라이트 시간을 찍습니다 (비우면 상태 보기)')
      .addStringOption((o) =>
        o.setName('링크').setDescription('내 유튜브 라이브 주소 (라이브를 켠 뒤에 등록하세요)')
      )
      .addStringOption((o) =>
        o
          .setName('게임명')
          .setDescription('영문으로 검색해 고르거나, 목록에 없으면 직접 입력하세요')
          .setAutocomplete(true)
      ),
    autocomplete: autocompleteGames,

    async execute(interaction) {
      const guildId = interaction.guildId;
      const link = interaction.options.getString('링크');
      const game = interaction.options.getString('게임명');

      // 인자가 없으면 상태만 보여줍니다.
      if (!link) {
        if (game && activeSession(guildId)) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const resolved = await resolveGame(game, guildId);
          if (!resolved) {
            return interaction.editReply(
              'Steam에서 게임 이름을 가져오지 못했습니다. 목록을 다시 고르거나 게임 이름을 직접 입력해주세요.'
            );
          }
          const changed = setStreamGame(activeSession(guildId), interaction.user.id, resolved);
          if (!changed) {
            return interaction.editReply('먼저 `/방송 링크:<내 라이브 주소> 게임명:<게임>` 으로 내 방송을 등록해주세요.');
          }
          const channelId = getSetting(guildId, 'streamChannelId');
          if (channelId) await ensureStreamPanel(interaction.client, guildId, channelId).catch(() => {});
          return interaction.editReply(`🎮 내 방송 게임을 **${resolved.name}**(으)로 바꿨습니다.`);
        }
        // 녹화방 미연결 때도 요약판에서 클립을 만들 수 있습니다. 밀려 올라갔을 때
        // 여기서 다시 부를 수 있어야 합니다.
        const picker = buildSessionPicker(guildId, interaction.user.id);
        return interaction.reply({
          embeds: [buildStatus(guildId, interaction.user.id)],
          ...(picker ? { components: [picker] } : {}),
          flags: MessageFlags.Ephemeral,
        });
      }

      return registerStream(interaction, { link, game });
    },
  },
];

/**
 * 방송을 등록합니다. `/방송 링크:…` 와 제어판의 **[🎬 지난 게임으로 등록]** 이 함께 씁니다.
 *
 * @param {object} interaction
 * @param {{link?: string|null, game?: string|null}} opts
 *   `link` 가 없으면 **저장해둔 고정 주소**를 씁니다.
 */
async function registerStream(interaction, { link = null, game = null } = {}) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const channelId = requireHomeChannel(guildId);

  // 무엇을 조회할지 정합니다. 세 갈래입니다.
  let target;
  let homeToSave = null;
  /** 고정 주소로 조회하는가. 오류 안내 문구가 달라집니다. */
  let usingHome = false;

  if (link) {
    const videoId = parseVideoId(link);
    if (videoId) {
      // 이 방송 하나만 가리키는 주소입니다. **저장하지 않습니다** —
      // 저장해두면 다음 방송에서 지난 방송을 등록하게 됩니다.
      target = watchUrl(videoId);
    } else {
      homeToSave = parseLiveHome(link);
      if (!homeToSave) {
        throw userError(
          '유튜브 주소를 알아볼 수 없습니다. 둘 중 하나로 적어주세요.\n' +
            '· **이번 방송 주소** — `https://www.youtube.com/live/…` · `https://youtu.be/…` · `…/watch?v=…`\n' +
            '  **일부공개(링크 있는 사람만)로 켜셨다면 이쪽입니다.**\n' +
            '· 채널 고정 주소 — `https://www.youtube.com/@내계정/live`\n' +
            '  **공개 방송에서만 됩니다.** 되면 저장돼서 같은 게임은 다음부터 **🎬 지난 게임으로 등록** 만 누르면 됩니다.'
        );
      }
      target = homeToSave;
      usingHome = true;
    }
  } else {
    usingHome = true;
    const saved = streamHome(guildId, userId);
    if (!saved) {
      throw userError(
        '저장해둔 주소가 없습니다. `/방송 링크:<이번 방송 주소>` 로 등록해주세요.\n' +
          '`https://www.youtube.com/live/…` · `https://youtu.be/…` · `…/watch?v=…`\n\n' +
          '💡 **공개**로 방송하신다면 `https://www.youtube.com/@내계정/live` 를 한 번 등록해두면\n' +
          '   같은 게임이면 그다음부터 이 버튼만 누르면 됩니다.\n' +
          '   **일부공개는 이 방법이 안 됩니다** — 채널 목록에 안 떠서 유튜브가 못 찾아줍니다.'
      );
    }
    target = saved;
  }

  // yt-dlp 를 부르므로 3초를 넘길 수 있습니다. 먼저 답해둡니다.
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const currentSession = activeSession(guildId);
  const currentStream = currentSession ? streamOf(currentSession, userId) : null;
  let resolvedGame = null;
  if (game) {
    resolvedGame = await resolveGame(game, guildId);
    if (!resolvedGame) {
      throw userError(
        'Steam에서 게임 이름을 가져오지 못했습니다. 검색 목록을 다시 고르거나 게임 이름을 직접 입력해주세요.'
      );
    }
  }
  // 버튼에는 자동완성을 붙일 수 없습니다. 저장 주소 버튼은 마지막에 고른 게임을 재사용하고,
  // 다른 게임이라면 `/방송 ... 게임명:...` 으로 검색해서 고르게 합니다.
  if (!resolvedGame && !currentStream?.gameKey) resolvedGame = lastGameForUser(guildId, userId);
  // 세션이 같아도 사람마다 다른 게임일 수 있으므로, 새로 참가하는 사람은 자기 게임을 고릅니다.
  if ((!currentStream || !currentStream.gameKey) && !resolvedGame) {
    throw userError(
      '처음 등록할 때는 **게임을 먼저 골라야 합니다.**\n' +
        '`/방송 링크:<내 라이브 주소> 게임명:<게임>` 으로 다시 등록해주세요.'
    );
  }

  let info;
  try {
    info = await liveInfo(target);
  } catch (err) {
    // ⚠️ **고정 주소는 공개 방송만 찾습니다.** (실측 확인)
    //    라이브 중이 아닌 채널의 `/live` 주소에 대해 yt-dlp 는 이렇게 답합니다:
    //      ERROR: [youtube:tab] @Google: The channel is not currently live
    //    일부공개(링크 있는 사람만)로 켜면 **채널 목록에 안 떠서** 같은 답이 옵니다.
    //    이 안내가 없으면 사람은 "분명히 방송 중인데" 하고 멀쩡한 주소를 들여다봅니다.
    if (usingHome && /not currently live|현재 라이브 중이 아/i.test(err.message)) {
      throw userError(
        '유튜브가 **"이 채널은 지금 라이브 중이 아니다"** 라고 답했습니다.\n\n' +
          '**채널 고정 주소(`@계정/live`)는 공개 방송만 찾습니다.**\n' +
          '일부공개(링크 있는 사람만)로 켜면 채널 목록에 안 뜨기 때문에 이 방법으로는 안 찾아집니다.\n\n' +
          '→ **이번 방송 주소를 그대로 넣어주세요.** (유튜브 스튜디오의 공유 링크)\n' +
          '`/방송 링크:https://www.youtube.com/live/…`\n' +
          '`/방송 링크:https://youtu.be/…` · `/방송 링크:…/watch?v=…`\n\n' +
          '일부공개로 쓰실 거면 **방송마다** 이렇게 넣어야 합니다.\n' +
          '(라이브를 아직 안 켠 경우에도 같은 답이 옵니다 — 켜셨는지도 확인해주세요)'
      );
    }
    throw err;
  }

  if (info.liveStatus === 'is_upcoming' || (usingHome && !info.videoId)) {
    // ⚠️ 고정 주소를 쓸 때는 **주소가 잘못된 게 아닙니다.** 아직 안 켠 것입니다.
    //    "주소를 확인하세요" 라고 하면 멀쩡한 주소를 들여다보게 만듭니다.
    throw userError(
      usingHome
        ? '지금 하는 방송을 찾지 못했습니다. **라이브를 먼저 켜고** 다시 눌러주세요.\n' +
            `(저장된 주소: ${target})`
        : '아직 시작하지 않은 방송입니다. **라이브를 켠 다음에** 등록해주세요.\n' +
            '(켜기 전에 등록하면 마킹 시간이 전부 어긋납니다)'
    );
  }
  if (info.liveStatus === 'not_live') {
    throw userError('라이브가 아니라 일반 영상입니다. 라이브 방송 주소를 넣어주세요.');
  }

  const videoId = info.videoId || parseVideoId(target);
  const url = watchUrl(videoId);

  const session = activeSession(guildId) ?? openSession(guildId, channelId, resolvedGame?.name);
  if (resolvedGame && !session.game) setGame(session, resolvedGame.name);

  // 유튜브가 시작 시각을 안 알려주면 지금 시각으로 대체합니다.
  // ⚠️ 그때는 **반드시 사람에게 말해줘야** 합니다. 조용히 넘기면 전부 어긋난 채로 갑니다.
  const startedAt = info.startedAt ?? nowSec();
  const startSource = info.startedAt ? 'release_timestamp' : 'command';
  const effectiveGame = resolvedGame ?? (currentStream?.gameKey ? {
    name: currentStream.game,
    key: currentStream.gameKey,
    appid: currentStream.appid ?? null,
    cooperative: currentStream.cooperative ?? null,
  } : null);
  putStream(session, {
    userId,
    url,
    videoId,
    startedAt,
    startSource,
    game: effectiveGame?.name,
    gameKey: effectiveGame?.key,
    appid: effectiveGame?.appid,
    cooperative: effectiveGame?.cooperative,
  });

  // 고정 주소는 등록이 **성공한 뒤에** 저장합니다. 틀린 주소를 저장하면 안 됩니다.
  if (homeToSave) setStreamHome(guildId, userId, homeToSave);

  const elapsed = humanDuration(nowSec() - startedAt);
  const lines = [
    `✅ 등록했습니다 · 방송 시작 <t:${startedAt}:t> · **지금 ${elapsed} 진행 중**`,
    '',
    // ★ 이 확인 요청이 어긋난 t=0 을 잡는 1차 방어선입니다. (기획 2.2a)
    '**"지금 ' + elapsed + ' 진행 중" 이 맞습니까?** 실제와 다르면 제어판의 `⏱️ 시간 어긋남` 으로 맞춰주세요.',
    `제어판: <#${channelId}> · 이제 재미있을 때 **✂️ 지금!** 을 누르면 됩니다.`,
  ];
  if (startSource === 'command') {
    lines.splice(
      1,
      0,
      '⚠️ 유튜브에서 방송 시작 시각을 못 읽어서 **지금 시각을 시작점으로** 잡았습니다.\n' +
        '   이미 켜둔 지 오래됐다면 `⏱️ 시간 어긋남` 으로 반드시 맞춰주세요.'
    );
  }
  if (homeToSave) {
    lines.push(`📌 이 주소를 저장했습니다. 같은 게임은 다음부터 제어판의 **🎬 지난 게임으로 등록** 만 누르면 됩니다.`);
  }
  if (info.title) lines.push(`제목: ${info.title.slice(0, 150)}`);
  if (effectiveGame) lines.push(`게임: **${effectiveGame.name}**`);

  await interaction.editReply(lines.join('\n'));
  await ensureStreamPanel(interaction.client, guildId, channelId).catch(() => {});
}

// ── 클립 용량 자동 정리 ───────────────────────────────────────
//
// ⚠️ **사용자 데이터를 영구 삭제합니다.** 안전장치는 `clips.js` 의 cleanupByBudget 에 있습니다.
//    여기서는 그것을 주기적으로 부르고 **결과를 알립니다.** 조용히 사라지면 안 됩니다.

let cleanupTimer = null;

/** 지운 클립들을 세션 → 서버 → 방송 채널로 되짚어 알립니다. */
async function announceCleanup(client, result) {
  // 어느 서버에 알려야 하는지는 **세션이 알려줍니다.**
  // ⚠️ 못 찾으면 "첫 번째 서버" 같은 짐작을 하지 말고 로그에만 남깁니다 —
  //    엉뚱한 채널에 남의 방송 이야기를 올리게 됩니다.
  const byGuild = new Map();
  const orphans = [];
  for (const c of result.deleted) {
    const guildId = sessionById(c.folder)?.guildId;
    if (!guildId) {
      orphans.push(c);
      continue;
    }
    if (!byGuild.has(guildId)) byGuild.set(guildId, []);
    byGuild.get(guildId).push(c);
  }

  if (orphans.length > 0) {
    console.warn(
      `[stream] 정리한 클립 ${orphans.length}개는 세션 기록이 없어 알리지 못했습니다 ` +
        `(폴더: ${[...new Set(orphans.map((c) => c.folder))].join(', ')})`
    );
  }

  for (const [guildId, list] of byGuild) {
    const channelId = getSetting(guildId, 'streamChannelId');
    if (!channelId) continue;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;

    const freed = list.reduce((a, c) => a + c.bytes, 0);
    await channel
      .send({
        content:
          `🧹 **클립 용량 정리** — 오래된 클립 ${list.length}개를 지웠습니다 (${fmtBytes(freed)} 확보)\n` +
          `예산 ${fmtBytes(result.budget)} 를 넘어서 오래된 것부터 지웠습니다. ` +
          `최근 ${config.stream.clipMinKeepDays}일 안에 만든 것은 지우지 않습니다.\n` +
          `타임라인 텍스트는 그대로 있으니 필요하면 다시 뽑을 수 있습니다.`,
        flags: MessageFlags.SuppressNotifications,
      })
      .catch(() => {});
  }
}

async function maybeCleanup(client) {
  try {
    const result = await cleanupByBudget();
    if (result.deleted.length === 0) {
      // 예산을 넘었는데 전부 최근 것이면 지울 수 없습니다. 그건 알려줘야 합니다.
      if (result.bytes > result.budget && result.blockedByAge > 0) {
        console.warn(
          `[stream] 클립이 예산을 넘었습니다 (${fmtBytes(result.bytes)} / ${fmtBytes(result.budget)}) ` +
            `— 최근 ${config.stream.clipMinKeepDays}일 보호 때문에 ${result.blockedByAge}개를 지우지 못했습니다.\n` +
            '        STREAM_CLIP_MAX_GB 를 늘리거나 웹페이지에서 손으로 지워주세요.'
        );
      }
      return;
    }
    console.log(
      `[stream] 클립 정리: ${result.deleted.length}개 · ${fmtBytes(result.freed)} 확보 ` +
        `(남은 용량 ${fmtBytes(result.bytes)} / 예산 ${fmtBytes(result.budget)})`
    );
    await announceCleanup(client, result);
  } catch (err) {
    console.error('[stream] 클립 정리 실패:', err.message);
  }
}

export function startClipCleanup(client) {
  if (cleanupTimer) return;
  if (!config.stream.clipAutoCleanup) {
    console.log('   클립 자동 정리 꺼짐 (STREAM_CLIP_AUTO_CLEANUP=false)');
    return;
  }
  console.log(
    `   클립 자동 정리 켜짐: 예산 ${fmtBytes(config.stream.clipMaxGb * 1024 ** 3)}, ` +
      `${config.stream.clipCleanupTargetPercent}% 까지 정리, 최근 ${config.stream.clipMinKeepDays}일 보호`
  );
  // 켜자마자 한 번 봅니다. 꺼져 있는 동안 쌓였을 수 있습니다.
  maybeCleanup(client);
  cleanupTimer = setInterval(() => maybeCleanup(client), 60 * 60_000);
  cleanupTimer.unref?.();
}

export function stopClipCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

// ── 버튼·드롭다운 ─────────────────────────────────────────────

export async function handleStreamComponent(interaction, client) {
  const id = interaction.customId;
  const guildId = interaction.guildId;

  if (id === 'tm:panel:join') return registerStream(interaction);
  if (id === 'tm:panel:mark') return markNow(interaction, client);
  if (id.startsWith('tm:share:')) return shareMarkNow(interaction, client, id.split(':')[2]);
  if (id === 'tm:panel:undo') return undoMark(interaction, client);
  if (id === 'tm:panel:offset') return openOffsetModal(interaction);
  if (id === 'tm:panel:end') return endSession(interaction, client);
  if (id.startsWith('tm:panel:reopen:')) return reopen(interaction, client, id.split(':')[3]);
  if (id.startsWith('tm:desc:')) return openDescModal(interaction, id);
  if (id.startsWith('tm:clipsopen:')) return openClipPicker(interaction, id);
  if (id.startsWith('tm:pickpage:')) return openClipPicker(interaction, id, true);
  if (id.startsWith('tm:clip:')) return openClipModal(interaction, id);
  if (id.startsWith('tm:cpage:')) return turnClipPage(interaction, id);
  if (id === 'tm:resum') return resendPastSummary(interaction, client);

  // 모르는 버튼입니다. 조용히 넘기면 디스코드가 "응답하지 않았어요" 를 띄웁니다.
  // (기능을 늘릴 때 여기 갈래를 먼저 추가하세요 — 안 하면 새 버튼이 이 안내에 삼켜집니다)
  return interaction.reply(eph('⚠️ 이 버튼은 더 쓰지 않습니다. `/방송` 으로 내 지난 방송 타임라인 보기를 열어주세요.')).catch(() => {});
}

/** 지난 방송에서 본인 요약만 나만 보기로 엽니다. */
async function resendPastSummary(interaction, client) {
  const session = sessionById(interaction.values?.[0]);
  if (!session || session.guildId !== interaction.guildId) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));
  const mine = streamOf(session, interaction.user.id);
  if (!mine) return interaction.reply(eph('이 세션에 등록한 본인 방송이 없습니다.'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply('📝 내 방송 요약입니다. 다른 사람에게는 보이지 않습니다.');
  await sendOwnSummary(interaction, session);
  if (session.closedAt && mine.forumPosted?.messageIds?.length) {
    const result = await publishStreamRecord(client, session, mine, { refreshPreview: true });
    if (!['posted', 'updated'].includes(result.status)) {
      await interaction.editReply('⚠️ 내 요약은 표시했지만 녹화방 갱신에 실패했습니다. 권한을 확인하고 다시 시도해주세요.');
    }
  }
}

async function markNow(interaction, client) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  const userId = interaction.user.id;
  const mine = streamOf(session, userId);

  // ★ **내 방송에만** 찍습니다. 동시에 방송을 켜도 각자 다른 게임을 할 수 있습니다.
  //   단 등록을 안 한 사람이 누르면 갈 곳이 없으므로 그때만 모두의 것으로 둡니다.
  const mark = addMark(session, userId, mine ? userId : null);
  if (!mark) {
    return interaction.reply(eph(`마킹이 ${MARK_MAX}개를 넘었습니다. 방송을 종료하고 새로 시작해주세요.`));
  }

  const count = session.marks.filter((m) => m.byUserId === userId).length;
  const payload = mine
    ? {
        content:
          `✂️ 찍었습니다 · ${hhmmss(Math.max(0, markSecondsFor(mine, mark)))} · **내 방송** (${count}번째)\n` +
          '다 같이 하던 순간이면 아래 버튼으로 모두의 타임라인에 넣을 수 있습니다.',
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`tm:share:${mark.id}`)
              .setLabel('다 같이 하던 순간')
              .setEmoji('👥')
              .setStyle(ButtonStyle.Secondary)
          ),
        ],
        flags: MessageFlags.Ephemeral,
      }
    : eph(
        `✂️ 찍었습니다 (${count}번째) · **모두의 타임라인**에 넣었습니다.\n` +
          '(내 방송이 등록되어 있지 않아서입니다. `🎬 지난 게임으로 등록` 또는 `/방송`으로 등록하면 그다음부터는 내 방송에만 찍힙니다)'
      );

  // ⚠️ **답을 먼저 합니다.** 제어판 수정이 앞에 오면 전송 한도에 걸릴 때
  //    가장 많이 눌리는 버튼에서 "Unknown interaction" 이 납니다. (기획 3.10)
  await interaction.reply(payload);
  scheduleStreamPanelRefresh(client, interaction.guildId, session.channelId);
}

/** 방금 찍은 것을 모두의 타임라인으로 넓힙니다. (그 순간은 이미 잡혀 있습니다) */
async function shareMarkNow(interaction, client, markId) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  const mark = shareMark(session, markId);
  if (!mark) return interaction.reply(eph('그 마킹을 찾지 못했습니다. 이미 지워졌을 수 있습니다.'));

  await interaction.update({
    content: '👥 **모두의 타임라인**으로 넓혔습니다. 방송을 켠 사람 전원의 요약판에 들어갑니다.',
    components: [],
  });
  scheduleStreamPanelRefresh(client, interaction.guildId, session.channelId);
}

async function undoMark(interaction, client) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  // ⚠️ **내가 찍은 것** 중 마지막을 지웁니다. 남이 방금 찍은 것을 지우면 안 됩니다.
  const gone = removeLastMark(session, interaction.user.id);
  await interaction.reply(
    eph(
      gone
        ? `↩️ 내가 찍은 마지막 마킹을 지웠습니다. 이 방송의 마킹 ${session.marks.length}개`
        : '내가 찍은 마킹이 없습니다. (남이 찍은 것은 지울 수 없습니다)'
    )
  );
  scheduleStreamPanelRefresh(client, interaction.guildId, session.channelId);
}

function openOffsetModal(interaction) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  const mine = streamOf(session, interaction.user.id);
  if (!mine) {
    return interaction.reply(
      eph('먼저 `/방송 링크:<내 라이브 주소>` 로 등록해주세요. 자기 방송의 시간만 맞출 수 있습니다.')
    );
  }

  return interaction.showModal(buildOffsetModal(mine));
}

async function endSession(interaction, client) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // ⚠️ **채널을 먼저 확인하고 나중에 닫습니다.** 순서를 바꾸면 이렇게 됩니다:
  //    닫혔는데 제어판을 못 고쳐서 [▶️ 이어서 기록] 버튼이 안 생깁니다.
  //    그러면 되돌릴 방법이 화면에 없어집니다.
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return interaction.editReply(
      '방송 채널을 찾지 못해 제어판을 갱신할 수 없습니다. **종료하지 않았습니다.**\n' +
        '`/채널설정` 에서 방송 채널을 확인한 뒤 다시 눌러주세요. 기록은 그대로 있습니다.'
    );
  }

  closeSession(session);

  // 공유 녹화방 기록만 순서대로 보냅니다. 방송 채널에는 공개 요약을 보내지 않습니다.
  let forumPosted = 0;
  let forumPending = 0;
  let forumFailed = 0;
  for (const stream of session.streams) {
    const result = await publishStreamRecord(client, session, stream);
    if (result.status === 'posted' || result.status === 'updated') forumPosted += 1;
    else if (result.status === 'unlinked') forumPending += 1;
    else forumFailed += 1;
  }

  // 제어판을 **맨 마지막에** 다시 올립니다. 그래야 채널 맨 아래에 남습니다.
  await repostStreamPanel(client, interaction.guildId, session.channelId).catch(() => {});

  const resultLines = [
    '⏹️ 방송 기록을 종료했습니다. 본인 방송의 요약만 나만 보기로 표시합니다.',
    '다른 참여자는 `/방송`에서 지난 방송을 골라 자기 요약을 확인할 수 있습니다.',
    '잘못 눌렀다면 방송 채널 제어판의 **▶️ 이어서 기록**으로 되돌릴 수 있습니다.',
  ];
  if (forumPosted) resultLines.push(`📺 녹화 포스트에 방송 기록 **${forumPosted}개**를 올렸습니다.`);
  if (forumPending) {
    resultLines.push(
      `⏸️ 게임과 연결된 녹화 포스트가 없어 **${forumPending}개 기록을 보류했습니다.** ` +
        '기존 녹화 포스트 안에서 `/게임 검색:<게임>` 으로 연결하면 자동으로 올라갑니다.'
    );
  }
  if (forumFailed) resultLines.push(`⚠️ 녹화 포스트 전송에 실패한 기록이 ${forumFailed}개 있습니다. 연결과 권한을 확인해주세요.`);
  await interaction.editReply(resultLines.join('\n'));
  await sendOwnSummary(interaction, session);
}

async function reopen(interaction, client, sessionId) {
  const session = sessionById(sessionId);
  if (!session) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));
  if (activeSession(interaction.guildId)) {
    return interaction.reply(eph('이미 다른 방송을 기록 중입니다. 그걸 먼저 종료해주세요.'));
  }

  reopenSession(session);
  await interaction.reply(eph(`▶️ 다시 기록합니다. 마킹 ${session.marks.length}개가 그대로 있습니다.`));
  await ensureStreamPanel(client, interaction.guildId, session.channelId).catch(() => {});
}

/** 설명 채우기 모달을 띄웁니다. 한 번에 5개씩, 페이지로 넘깁니다. */
function openDescModal(interaction, customId) {
  const [, , sessionId, userId, fromRaw] = customId.split(':');
  const session = sessionById(sessionId);
  if (!session) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));

  const stream = streamOf(session, userId);
  if (!stream) return interaction.reply(eph('그 사람의 방송 기록을 찾지 못했습니다.'));

  const built = buildDescModal(session, stream, fromRaw);
  if (!built) return interaction.reply(eph('더 채울 마킹이 없습니다.'));
  return interaction.showModal(built.modal);
}

/** 요약판의 드롭다운에서 마킹을 고르면 구간 창을 띄웁니다. */
function openClipPicker(interaction, customId, turning = false) {
  const [, , sessionId, userId, pageRaw] = customId.split(':');
  const session = sessionById(sessionId);
  const stream = session?.guildId === interaction.guildId ? streamOf(session, userId) : null;
  if (!stream) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));
  const payload = buildClipPicker(session, stream, Number(pageRaw) || 0);
  return turning ? interaction.update(payload) : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function openClipModal(interaction, customId) {
  const [, , sessionId, userId] = customId.split(':');
  const session = sessionById(sessionId);
  if (!session) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));

  const stream = streamOf(session, userId);
  if (!stream) return interaction.reply(eph('그 사람의 방송 기록을 찾지 못했습니다.'));

  const mark = session.marks.find((m) => m.id === interaction.values?.[0]);
  if (!mark) return interaction.reply(eph('그 마킹을 찾지 못했습니다. 요약판을 다시 올려주세요.'));

  return interaction.showModal(buildClipModal(session, stream, mark));
}

/** 마킹이 25개를 넘으면 드롭다운을 페이지로 나눕니다. */
async function turnClipPage(interaction, customId) {
  const [, , sessionId, userId, pageRaw] = customId.split(':');
  const session = sessionById(sessionId);
  const stream = session ? streamOf(session, userId) : null;
  if (!stream) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));

  // 요약판은 여러 장일 수 있고, 조작부는 **마지막 장에만** 있습니다.
  // 지금 누른 그 메시지만 고쳐야 하므로 마지막 장을 씁니다.
  const pages = buildSummary(session, stream, Number(pageRaw) || 0, true);
  const last = pages[pages.length - 1];
  return interaction.update({ content: last.content, components: last.components ?? [] });
}

// ── 입력 창(모달) 제출 ────────────────────────────────────────

export async function handleStreamModal(interaction, client) {
  const id = interaction.customId;
  if (id === 'tm:offsetm') return submitOffset(interaction, client);
  if (id.startsWith('tm:descm:')) return submitDesc(interaction, client);
  if (id.startsWith('tm:clipm:')) return submitClip(interaction, client);
  return interaction.reply(eph('⚠️ 알 수 없는 입력 창입니다.')).catch(() => {});
}

/** 구간을 받아 실제로 잘라냅니다. 오래 걸리므로 진행 상황을 먼저 보여줍니다. */
async function submitClip(interaction, client) {
  const [, , sessionId, userId, markId] = interaction.customId.split(':');
  const session = sessionById(sessionId);
  const stream = session ? streamOf(session, userId) : null;
  if (!stream) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));

  // ⚠️ 시간 칸에도 `parseElapsed` 를 씁니다. 숫자만 적으면 **분**으로 보므로
  //    (`90` → 90분) 창의 기본값과 안내를 시:분:초로 채워뒀습니다.
  const rawFrom = interaction.fields.getTextInputValue('from');
  const rawTo = interaction.fields.getTextInputValue('to');
  const from = parseElapsed(rawFrom);
  const to = parseElapsed(rawTo);
  if (from === null || to === null) {
    throw userError(
      `시간을 알아볼 수 없습니다 (시작 "${rawFrom}" · 끝 "${rawTo}").\n` +
        '`01:20:30` 처럼 **시:분:초** 로 적어주세요.'
    );
  }
  if (to <= from) throw userError('끝 시간이 시작 시간보다 뒤여야 합니다.');

  const length = to - from;
  if (length > config.stream.clipMaxSec) {
    throw userError(
      `${hhmmss(from)} ~ ${hhmmss(to)} 는 **${length}초**입니다. 한 개는 ${config.stream.clipMaxSec}초까지입니다.\n` +
        '길면 용량이 금방 차고, 그러면 사진 자동 정리가 돌아 사진이 지워질 수 있습니다.\n' +
        '구간을 나눠서 여러 개로 만들어주세요.'
    );
  }

  const title = (interaction.fields.getTextInputValue('title') ?? '').trim();

  // 잘라내는 데 서버에서 30초~2분이 걸립니다. 먼저 답해두고 끝나면 고쳐 씁니다.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction
    .editReply(`🎬 ${hhmmss(from)} ~ ${hhmmss(to)} (${length}초) 를 잘라내고 있습니다… 30초쯤 걸립니다.`)
    .catch(() => {});

  const made = await makeClip({
    folder: session.id,
    url: stream.url,
    startSec: from,
    endSec: to,
    title: title || hhmmss(from),
  });

  addClip(session, {
    markId,
    userId,
    file: made.file,
    startSec: from,
    endSec: to,
    title: title || hhmmss(from),
  });

  // ⚠️ 소리만 만들어졌으면 **반드시 말해줍니다.** 조용히 소리만 주면
  //    사람은 영상을 받았다고 생각하고 나중에 열어보고 당황합니다.
  const lines = made.audioOnly
    ? [
        `🎧 **소리만 잘라냈습니다** — ${hhmmss(from)} ~ ${hhmmss(to)} (${length}초)`,
        '이 방송에는 **화면이 없습니다** (음성만 녹화된 방송입니다).',
        `${made.file} · ${fmtBytes(made.bytes)} · ${made.seconds.toFixed(0)}초 걸림`,
        '',
        `듣기: ${clipPageUrl(session.id)}`,
        `이 방송의 클립 ${clipsOf(session).length}개`,
      ]
    : [
        `🎥 **클립을 만들었습니다** — ${hhmmss(from)} ~ ${hhmmss(to)} (${length}초)`,
        `${made.file} · ${fmtBytes(made.bytes)} · ${made.seconds.toFixed(0)}초 걸림`,
        '',
        `보기: ${clipPageUrl(session.id)}`,
        `이 방송의 클립 ${clipsOf(session).length}개`,
      ];

  // 구글 드라이브는 **더하기만** 합니다. 설정이 없으면 아무 일도 없고,
  // 실패해도 여기 한 줄이 붙을 뿐 로컬 파일과 웹페이지는 그대로입니다.
  // (⚠️ 로컬 파일을 지우지 않습니다 — 반쪽만 올라갔을 때 되돌릴 방법이 없어집니다)
  if (driveEnabled()) {
    await interaction.editReply(lines.join('\n') + '\n\n☁️ 구글 드라이브에 올리는 중…').catch(() => {});
    try {
      const up = await uploadClip(clipFilePath(session.id, made.file), made.file);
      lines.push(`\n☁️ 드라이브: ${up.link}`);
      if (!up.shared) lines.push('(링크 공개 설정에 실패했습니다. 드라이브에서 직접 공유해주세요)');
    } catch (err) {
      // 원인을 지어내지 않습니다. drive.js 가 구글이 한 말을 담아 옵니다.
      lines.push(`\n⚠️ 드라이브 업로드 실패 — 클립은 서버에 그대로 있습니다.\n${err.message}`);
    }
  }
  if (made.pruned > 0) {
    lines.push(
      `\n🧹 상한(세션당 ${config.stream.clipPerSession}개 · 전체 ${config.stream.clipTotal}개)을 넘어 오래된 클립 ${made.pruned}개를 지웠습니다.`
    );
  }
  await interaction.editReply(lines.join('\n'));

  // 녹화방을 동기화합니다. 개인 요약의 최신 내용은 다시 열 때 표시합니다.
  await updateSummary(client, session, stream).catch(() => {});
}

/**
 * "몇 시간 몇 분"을 초로 바꿉니다. `1시간 20분` `80분` `1:20:00` 을 다 받습니다.
 * @returns {number|null}
 */
export function parseElapsed(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  // 01:20:00 / 20:00 형태
  if (/^\d{1,3}(:\d{1,2}){1,2}$/.test(t)) {
    const parts = t.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  const h = t.match(/(\d+)\s*(?:시간|시|h)/i);
  const m = t.match(/(\d+)\s*(?:분|m(?!s))/i);
  const s = t.match(/(\d+)\s*(?:초|s)/i);
  if (h || m || s) {
    return Number(h?.[1] ?? 0) * 3600 + Number(m?.[1] ?? 0) * 60 + Number(s?.[1] ?? 0);
  }

  // 숫자만 적었으면 분으로 봅니다. 방송 경과를 초로 적는 사람은 없습니다.
  if (/^\d+$/.test(t)) return Number(t) * 60;
  return null;
}

async function submitOffset(interaction, client) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  const mine = streamOf(session, interaction.user.id);
  if (!mine) return interaction.reply(eph('먼저 `/방송` 으로 등록해주세요.'));

  const raw = interaction.fields.getTextInputValue('elapsed');
  const realElapsed = parseElapsed(raw);
  if (realElapsed === null) {
    throw userError(`"${raw}" 를 알아볼 수 없습니다. \`1시간 20분\` · \`80분\` · \`1:20:00\` 처럼 적어주세요.`);
  }

  // 부호를 헷갈리기 쉽습니다. 정의부터 씁니다.
  //   markSecondsFor = mark.at − startedAt − offsetSec  (store.js)
  //   이 값이 `mark.at − 진짜시작` 이어야 하므로 → offsetSec = 진짜시작 − startedAt
  //
  // 예: 봇은 12:00 시작으로 알고 지금 12:08 (8분 진행). 실제로는 11:00 에 켰다면
  //     진짜시작 = 12:08 − 68분 = 11:00 → offsetSec = −3600.
  //     12:05 의 마킹은 12:05 − 12:00 − (−3600) = 65분. 11:00 기준으로 맞습니다.
  const trueStart = nowSec() - realElapsed;
  const offset = trueStart - mine.startedAt;
  if (Math.abs(offset) > OFFSET_LIMIT_SEC) {
    throw userError(
      `${Math.round(offset / 60)}분이나 차이가 납니다. 잘못 적으신 것 같습니다.\n` +
        `봇은 지금 "${humanDuration(nowSec() - mine.startedAt - (mine.offsetSec ?? 0))} 진행 중" 으로 알고 있습니다.`
    );
  }

  setOffset(session, interaction.user.id, offset);
  const now = humanDuration(nowSec() - mine.startedAt - (mine.offsetSec ?? 0));
  await interaction.reply(
    eph(
      `⏱️ 맞췄습니다 — 이제 **${now} 진행 중** 으로 봅니다 (오프셋 ${offset > 0 ? '+' : ''}${offset}초).\n` +
        '이미 찍어둔 마킹에도 그대로 적용됩니다.'
    )
  );
  await ensureStreamPanel(client, interaction.guildId, session.channelId).catch(() => {});
}

async function submitDesc(interaction, client) {
  const [, , sessionId, userId, fromRaw] = interaction.customId.split(':');
  const session = sessionById(sessionId);
  if (!session) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));

  const stream = streamOf(session, userId);
  if (!stream) return interaction.reply(eph('그 사람의 방송 기록을 찾지 못했습니다.'));

  const rows = timelineFor(session, stream);
  const from = Math.max(0, Number(fromRaw) || 0);
  const page = rows.slice(from, from + DESC_PER_PAGE);

  let changed = 0;
  // 같은 내용으로 재제출해도 앞선 동기화 실패를 복구할 수 있게 페이지 전체를 대상으로 둡니다.
  const changedMarkIds = new Set(page.map(({ mark }) => mark.id));
  for (const { mark } of page) {
    // 칸을 안 채웠으면 빈 문자열이 옵니다. 원래 있던 설명을 지우는 것도 뜻으로 받습니다.
    const value = interaction.fields.getTextInputValue(mark.id) ?? '';
    if (value.trim() !== (mark.text ?? '')) {
      setMarkText(session, mark.id, value);
      changedMarkIds.add(mark.id);
      changed++;
    }
  }

  const next = from + DESC_PER_PAGE;
  const more = next < rows.length;
  const payload = {
    content:
      `✏️ ${changed}개를 고쳤습니다.` +
      (more ? ` 아직 ${rows.length - next}개 남았습니다.` : ' 전부 채웠습니다.'),
    flags: MessageFlags.Ephemeral,
  };
  if (more) {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`tm:desc:${sessionId}:${userId}:${next}`)
          .setLabel(`다음 ${Math.min(DESC_PER_PAGE, rows.length - next)}개`)
          .setEmoji('✏️')
          .setStyle(ButtonStyle.Primary)
      ),
    ];
  }
  await interaction.reply(payload);

  // 공유 마킹 설명은 다른 방송자의 타임라인에도 들어갑니다. 해당 포럼도 함께 갱신합니다. 개인 요약은 다시 열어 확인합니다.
  let syncFailed = false;
  for (const target of session.streams) {
    if (target !== stream && !timelineFor(session, target).some(({ mark }) => changedMarkIds.has(mark.id))) continue;
    try {
      const result = await updateSummary(client, session, target, { refreshPreview: true });
      if (result && !['posted', 'updated'].includes(result.status)) syncFailed = true;
    } catch { syncFailed = true; }
  }
  if (syncFailed) {
    await interaction.editReply({ content: `${payload.content}\n⚠️ 일부 게시물 동기화에 실패했습니다. 설명은 저장됐습니다. 권한을 확인한 뒤 설명 채우기를 다시 제출해주세요.` });
  }
}

/** 본인 방송만 나만 보기로 보냅니다. 영구 메시지 ID로 저장하지 않습니다. */
async function sendOwnSummary(interaction, session) {
  const mine = session.guildId === interaction.guildId ? streamOf(session, interaction.user.id) : null;
  if (!mine) {
    await interaction.followUp(eph('이 세션에 등록한 본인 방송이 없습니다. 다른 참여자의 요약은 표시하지 않습니다.'));
    return;
  }
  for (const payload of buildSummary(session, mine)) {
    await interaction.followUp({
      ...payload, flags: MessageFlags.Ephemeral | MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] },
    });
  }
}

/** 개인 요약은 다시 열 때 최신 내용으로 만들고, 공유 녹화방만 동기화합니다. */
async function updateSummary(client, session, stream, options) {
  if (session.closedAt && stream.forumPosted?.messageIds?.length) {
    return publishStreamRecord(client, session, stream, options);
  }
  return null;
}
