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
import { get as getSetting } from '../settings.js';
import { liveInfo } from '../music/ytdlp.js';
import {
  activeSession,
  sessionById,
  recentSessions,
  openSession,
  closeSession,
  reopenSession,
  setGame,
  putStream,
  streamOf,
  setOffset,
  addMark,
  removeLastMark,
  setMarkText,
  addClip,
  clipsOf,
  setSummaryMessages,
  summaryMessages,
  timelineFor,
  hhmmss,
  humanDuration,
  nowSec,
  MARK_MAX,
} from './store.js';
import {
  buildSummary,
  buildOffsetModal,
  buildDescModal,
  buildClipModal,
  buildSessionPicker,
  ensureStreamPanel,
  repostStreamPanel,
  scheduleStreamPanelRefresh,
  DESC_PER_PAGE,
} from './panel.js';
import { makeClip, clipPageUrl, fmtBytes } from './clips.js';
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

function buildStatus(guildId) {
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
        `· <@${s.userId}> — 시작 <t:${s.startedAt}:t> · ${humanDuration(now - s.startedAt - (s.offsetSec ?? 0))} 진행 중`
      );
    }
    if (session.streams.length === 0) lines.push('· 아직 등록한 사람이 없습니다.');
  } else {
    lines.push('기록 중인 방송이 없습니다.');
    lines.push('`/방송 링크:<내 라이브 주소> 게임명:<이름>` 으로 시작하세요.');
  }

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
      .addStringOption((o) => o.setName('게임명').setDescription('무슨 게임인지 (처음 등록할 때만)')),

    async execute(interaction) {
      const guildId = interaction.guildId;
      const link = interaction.options.getString('링크');
      const game = interaction.options.getString('게임명');

      // 인자가 없으면 상태만 보여줍니다.
      if (!link) {
        if (game && activeSession(guildId)) {
          setGame(activeSession(guildId), game);
          const channelId = getSetting(guildId, 'streamChannelId');
          if (channelId) await ensureStreamPanel(interaction.client, guildId, channelId).catch(() => {});
        }
        // 요약판은 종료 뒤 **클립 뽑기로 가는 유일한 입구**입니다. 밀려 올라갔을 때
        // 여기서 다시 부를 수 있어야 합니다.
        const picker = buildSessionPicker(guildId);
        return interaction.reply({
          embeds: [buildStatus(guildId)],
          ...(picker ? { components: [picker] } : {}),
          flags: MessageFlags.Ephemeral,
        });
      }

      const channelId = requireHomeChannel(guildId);
      const videoId = parseVideoId(link);
      if (!videoId) {
        throw userError(
          '유튜브 라이브 주소를 알아볼 수 없습니다.\n' +
            '이런 형태여야 합니다: `https://www.youtube.com/live/…` · `https://youtu.be/…` · `https://www.youtube.com/watch?v=…`'
        );
      }

      // yt-dlp 를 부르므로 3초를 넘길 수 있습니다. 먼저 답해둡니다.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const url = watchUrl(videoId);
      const info = await liveInfo(url);

      if (info.liveStatus === 'is_upcoming') {
        throw userError(
          '아직 시작하지 않은 방송입니다. **라이브를 켠 다음에** 등록해주세요.\n' +
            '(켜기 전에 등록하면 마킹 시간이 전부 어긋납니다)'
        );
      }
      if (info.liveStatus === 'not_live') {
        throw userError('라이브가 아니라 일반 영상입니다. 라이브 방송 주소를 넣어주세요.');
      }

      const session = activeSession(guildId) ?? openSession(guildId, channelId, game);
      if (game) setGame(session, game);

      // 유튜브가 시작 시각을 안 알려주면 지금 시각으로 대체합니다.
      // ⚠️ 그때는 **반드시 사람에게 말해줘야** 합니다. 조용히 넘기면 전부 어긋난 채로 갑니다.
      const startedAt = info.startedAt ?? nowSec();
      const startSource = info.startedAt ? 'release_timestamp' : 'command';
      putStream(session, { userId: interaction.user.id, url, videoId, startedAt, startSource });

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
      if (info.title) lines.push(`제목: ${info.title.slice(0, 150)}`);

      await interaction.editReply(lines.join('\n'));
      await ensureStreamPanel(interaction.client, guildId, channelId).catch(() => {});
    },
  },
];

// ── 버튼·드롭다운 ─────────────────────────────────────────────

export async function handleStreamComponent(interaction, client) {
  const id = interaction.customId;
  const guildId = interaction.guildId;

  if (id === 'tm:panel:mark') return markNow(interaction, client);
  if (id === 'tm:panel:undo') return undoMark(interaction, client);
  if (id === 'tm:panel:offset') return openOffsetModal(interaction);
  if (id === 'tm:panel:end') return endSession(interaction, client);
  if (id.startsWith('tm:panel:reopen:')) return reopen(interaction, client, id.split(':')[3]);
  if (id.startsWith('tm:desc:')) return openDescModal(interaction, id);
  if (id.startsWith('tm:clip:')) return openClipModal(interaction, id);
  if (id.startsWith('tm:cpage:')) return turnClipPage(interaction, id);
  if (id === 'tm:resum') return resendPastSummary(interaction, client);

  // 모르는 버튼입니다. 조용히 넘기면 디스코드가 "응답하지 않았어요" 를 띄웁니다.
  // (기능을 늘릴 때 여기 갈래를 먼저 추가하세요 — 안 하면 새 버튼이 이 안내에 삼켜집니다)
  return interaction.reply(eph('⚠️ 이 버튼은 더 쓰지 않습니다. `/방송` 으로 요약판을 다시 올려주세요.')).catch(() => {});
}

/** 지난 방송을 골라 요약판을 다시 올립니다. */
async function resendPastSummary(interaction, client) {
  const session = sessionById(interaction.values?.[0]);
  if (!session) return interaction.reply(eph('그 방송 기록을 찾지 못했습니다.'));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return interaction.editReply('방송 채널을 찾지 못했습니다. `/채널설정` 에서 확인해주세요.');
  }

  for (const stream of session.streams) await postSummary(channel, session, stream);
  await repostStreamPanel(client, session.guildId, session.channelId).catch(() => {});
  await interaction.editReply(`📝 요약판을 <#${session.channelId}> 에 다시 올렸습니다.`);
}

async function markNow(interaction, client) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  const mark = addMark(session, interaction.user.id);
  if (!mark) {
    return interaction.reply(eph(`마킹이 ${MARK_MAX}개를 넘었습니다. 방송을 종료하고 새로 시작해주세요.`));
  }

  // 사람마다 다른 시간이 됩니다. 누른 사람 기준으로 보여주고, 등록 안 했으면 첫 사람 기준.
  const mine = streamOf(session, interaction.user.id) ?? session.streams[0] ?? null;
  const at = mine ? hhmmss(Math.max(0, mark.at - mine.startedAt - (mine.offsetSec ?? 0))) : null;
  const who = mine && mine.userId !== interaction.user.id ? ` (<@${mine.userId}> 기준)` : '';

  // ⚠️ **답을 먼저 합니다.** 제어판 수정이 앞에 오면 전송 한도에 걸릴 때
  //    가장 많이 눌리는 버튼에서 "Unknown interaction" 이 납니다. (기획 3.10)
  await interaction.reply(
    eph(`✂️ 찍었습니다 (${session.marks.length}번째)${at ? ` · ${at}${who}` : ''}`)
  );
  scheduleStreamPanelRefresh(client, interaction.guildId, session.channelId);
}

async function undoMark(interaction, client) {
  const session = activeSession(interaction.guildId);
  if (!session) return interaction.reply(eph('기록 중인 방송이 없습니다.'));

  const gone = removeLastMark(session);
  await interaction.reply(
    eph(gone ? `↩️ 마지막 마킹을 지웠습니다. 남은 마킹 ${session.marks.length}개` : '지울 마킹이 없습니다.')
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
  //    닫혔는데 요약판도 못 올리고, 제어판도 못 고쳐서 [▶️ 이어서 기록] 버튼이 안 생깁니다.
  //    그러면 되돌릴 방법이 화면에 없어집니다.
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    return interaction.editReply(
      '방송 채널을 찾지 못해 요약판을 올릴 수 없습니다. **종료하지 않았습니다.**\n' +
        '`/채널설정` 에서 방송 채널을 확인한 뒤 다시 눌러주세요. 기록은 그대로 있습니다.'
    );
  }

  closeSession(session);

  // ⚠️ **하나씩 순서대로** 보냅니다. 6명분을 한꺼번에 던지면 채널 전송 한도에 걸립니다.
  //    보낸 메시지 ID 를 기억해둡니다 — 나중에 설명·클립이 바뀌면 **그 자리에서 고쳐 씁니다.**
  let sent = 0;
  for (const stream of session.streams) sent += await postSummary(channel, session, stream);

  // 제어판을 **맨 마지막에** 다시 올립니다. 그래야 채널 맨 아래에 남습니다.
  await repostStreamPanel(client, interaction.guildId, session.channelId).catch(() => {});

  await interaction.editReply(
    sent > 0
      ? `⏹️ 방송을 종료하고 요약판을 <#${session.channelId}> 에 올렸습니다.\n` +
          '잘못 눌렀다면 제어판의 **▶️ 이어서 기록** 으로 되돌릴 수 있습니다.'
      : '⏹️ 방송을 종료했습니다. 등록된 방송이 없어 요약판은 없습니다.'
  );
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
  const pages = buildSummary(session, stream, Number(pageRaw) || 0);
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

  const lines = [
    `🎥 **클립을 만들었습니다** — ${hhmmss(from)} ~ ${hhmmss(to)} (${length}초)`,
    `${made.file} · ${fmtBytes(made.bytes)} · ${made.seconds.toFixed(0)}초 걸림`,
    '',
    `보기: ${clipPageUrl(session.id)}`,
    `이 방송의 클립 ${clipsOf(session).length}개`,
  ];
  if (made.pruned > 0) {
    lines.push(
      `\n🧹 상한(세션당 ${config.stream.clipPerSession}개 · 전체 ${config.stream.clipTotal}개)을 넘어 오래된 클립 ${made.pruned}개를 지웠습니다.`
    );
  }
  await interaction.editReply(lines.join('\n'));

  // 요약판의 ✅ 표시와 [클립 보기] 링크가 따라오게 다시 올립니다.
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
  for (const { mark } of page) {
    // 칸을 안 채웠으면 빈 문자열이 옵니다. 원래 있던 설명을 지우는 것도 뜻으로 받습니다.
    const value = interaction.fields.getTextInputValue(mark.id) ?? '';
    if (value.trim() !== (mark.text ?? '')) {
      setMarkText(session, mark.id, value);
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

  // 요약판의 타임라인이 바뀌었으니 다시 올려줍니다.
  await updateSummary(client, session, stream).catch(() => {});
}

/**
 * 요약판을 **그 자리에서 고쳐 씁니다.**
 *
 * ★ 새로 올리면 안 됩니다. 클립을 5개 만들면 채널에 같은 타임라인이 6장 쌓입니다.
 *   (제어판을 메시지 하나로 고쳐 쓰는 것과 같은 이유 — 3.6-1)
 *
 * @returns {Promise<boolean>} 고쳐 쓰지 못했으면 false (부르는 쪽이 새로 올립니다)
 */
async function refreshSummary(client, session, stream) {
  const ids = summaryMessages(session, stream.userId);
  const pages = buildSummary(session, stream);
  // 설명을 채우면 글자가 늘어 장수가 바뀔 수 있습니다. 그때는 고쳐 쓸 수 없습니다.
  if (ids.length === 0 || ids.length !== pages.length) return false;

  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;

  for (let i = 0; i < ids.length; i++) {
    const msg = await channel.messages.fetch(ids[i]).catch(() => null);
    if (!msg) return false; // 누가 지웠습니다. 새로 올려야 합니다.
    await msg.edit({ content: pages[i].content, components: pages[i].components ?? [] }).catch(() => {});
  }
  return true;
}

/** 요약판을 새로 올리고 메시지 ID 를 기억합니다. **하나씩 순서대로** 보냅니다. */
async function postSummary(channel, session, stream) {
  const ids = [];
  for (const payload of buildSummary(session, stream)) {
    const sent = await channel
      .send({ ...payload, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
      .catch(() => null);
    if (sent) ids.push(sent.id);
  }
  if (ids.length > 0) setSummaryMessages(session, stream.userId, ids);
  return ids.length;
}

/** 고쳐 쓰기를 먼저 시도하고, 안 되면 새로 올립니다. */
async function updateSummary(client, session, stream) {
  if (await refreshSummary(client, session, stream)) return;

  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  await postSummary(channel, session, stream);
  // 새로 올렸으니 제어판이 파묻혔습니다. 맨 아래로 되돌립니다.
  // (고쳐 쓴 경우에는 채널에 아무것도 안 늘어나므로 건드리지 않습니다)
  await repostStreamPanel(client, session.guildId, session.channelId).catch(() => {});
}
