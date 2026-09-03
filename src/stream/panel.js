// 방송 제어판 — 게임 중에 누를 버튼들.
//
// 왜 버튼인가: 게임 중입니다. 명령어를 치거나 창을 띄워 입력하는 동안 그 순간은 지나갑니다.
// **[✂️ 지금!] 은 누르는 즉시 끝나야** 합니다. 설명은 방송이 끝난 뒤에 붙입니다.
//
// 이 제어판은 **방송 채널에 상주합니다.** 음악 제어판과 달리 재시작해도 지우지 않습니다 —
// 방송 기록은 디스크에 남아 이어지므로 제어판 내용이 거짓말이 되지 않습니다.
// (panel-registry.js 의 STREAM 주석 참고)
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { rememberPanel, forgetPanel, rememberedId, STREAM } from '../panel-registry.js';
import { get as getSetting } from '../settings.js';
import { config } from '../config.js';
import {
  activeSession,
  recentSessions,
  timelineFor,
  clipsOf,
  hhmmss,
  humanDuration,
  nowSec,
} from './store.js';
import { clipPageUrl } from './clips.js';

/** 임베드 설명 칸의 상한(4096)에 여유를 두고 자릅니다. */
const DESC_LIMIT = 3800;
/** 한 메시지에 담을 수 있는 글자 수. 요약판을 나눌 기준입니다. */
const MESSAGE_LIMIT = 1900;
/** 설명 채우기 모달 한 장에 담을 마킹 수. 디스코드 모달은 칸 5개가 상한입니다. */
export const DESC_PER_PAGE = 5;

/** 드롭다운 선택지 상한. 디스코드 제한입니다 — 넘으면 페이지를 나눠야 합니다. */
export const SELECT_LIMIT = 25;

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 이 채널이 지정된 방송 채널인가. */
export function isStreamHome(guildId, channelId) {
  if (!guildId || !channelId) return false;
  return getSetting(guildId, 'streamChannelId') === channelId;
}

/**
 * 사람 한 명의 상태 한 줄.
 *
 * ★ **경과 시간을 반드시 보여줍니다.** 이게 어긋난 t=0 을 잡는 1차 방어선입니다.
 *   `release_timestamp` 가 틀리면 조용히 틀려서, 유튜브 설명란에 붙여볼 때까지
 *   아무도 모릅니다. 등록한 사람은 자기가 언제 켰는지 아니까 이 줄을 읽는 순간 잡힙니다.
 *   (docs/게임방송-기획.md 2.2a)
 */
function streamLine(s, now) {
  const elapsed = humanDuration(now - s.startedAt - (s.offsetSec ?? 0));
  const bits = [`<@${s.userId}>`, s.game || '게임 미지정', `[라이브](${s.url})`, `시작 <t:${s.startedAt}:t>`, `${elapsed} 진행 중`];
  if (s.offsetSec) bits.push(`오프셋 ${s.offsetSec > 0 ? '+' : ''}${s.offsetSec}초`);
  // 시작 시각을 유튜브에서 못 읽었으면 **반드시 말해줘야** 합니다. 그때는 전부 어긋납니다.
  if (s.startSource !== 'release_timestamp') bits.push('⚠️ 시작 시각 추정');
  return `· ${bits.join(' · ')}`;
}

/** 제어판 메시지 본문(임베드 + 버튼). 기록 중이 아니어도 만들어집니다. */
export function buildStreamPanel(guildId) {
  const session = activeSession(guildId);
  const embed = new EmbedBuilder().setColor(0xe67e22);
  const rows = [];

  if (session) {
    const now = nowSec();
    const lines = [];
    if (session.game) lines.push(`**${session.game}**`);
    lines.push(`켠 지 ${humanDuration(now - session.openedAt)} · 마킹 **${session.marks.length}개**`);
    lines.push('');
    lines.push(
      session.streams.length > 0
        ? session.streams.map((s) => streamLine(s, now)).join('\n')
        : '아직 등록한 사람이 없습니다. `/방송 링크:<내 라이브 주소>` 로 등록하세요.'
    );

    // 최근 마킹 3개만. 전부 보여주면 제어판이 길어져 버튼이 화면 밖으로 밀립니다.
    //
    // ⚠️ 마킹은 **찍은 사람의 방송에만** 들어갑니다. 그러니 시간도 그 사람 기준으로
    //    보여줘야 합니다. 첫 사람 기준으로 다 보여주면 다른 사람 것이 엉뚱하게 나옵니다.
    const tail = session.marks.slice(-3).reverse();
    if (tail.length > 0) {
      lines.push('');
      lines.push(
        '최근 마킹 — ' +
          tail
            .map((m) => {
              const owner = m.forUserId ? session.streams.find((s) => s.userId === m.forUserId) : null;
              const at = owner
                ? hhmmss(Math.max(0, m.at - owner.startedAt - (owner.offsetSec ?? 0)))
                : `<t:${m.at}:t>`;
              return m.forUserId ? `${at} <@${m.forUserId}>` : `${at} 👥모두`;
            })
            .join(' · ')
      );
    }

    embed.setTitle('🎥 방송 기록 중').setDescription(lines.join('\n').slice(0, DESC_LIMIT));
    embed.setFooter({ text: '다시보기를 남기지 않으면 나중에 클립을 뽑을 수 없습니다.' });

    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('tm:panel:mark')
          .setLabel('지금!')
          .setEmoji('✂️')
          .setStyle(ButtonStyle.Success)
          .setDisabled(session.streams.length === 0),
        new ButtonBuilder()
          .setCustomId('tm:panel:undo')
          .setLabel('내 마지막 취소')
          .setEmoji('↩️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(session.marks.length === 0),
        new ButtonBuilder()
          .setCustomId('tm:panel:offset')
          .setLabel('시간 어긋남')
          .setEmoji('⏱️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(session.streams.length === 0),
        new ButtonBuilder()
          .setCustomId('tm:panel:end')
          .setLabel('방송 종료')
          .setEmoji('⏹️')
          .setStyle(ButtonStyle.Danger)
      )
    );
    // 늦게 켠 사람이 스스로 끼어들 수 있어야 합니다. 저장해둔 고정 주소를 씁니다.
    rows.push(new ActionRowBuilder().addComponents(joinButton()));
    return { embeds: [embed], components: rows };
  }

  // ── 기록 중이 아닐 때 ──
  const last = recentSessions(guildId, 1)[0] ?? null;
  const lines = ['지금 기록 중인 방송이 없습니다.', '`/방송 링크:<내 라이브 주소> 게임명:<이름>` 으로 시작하세요.'];
  lines.push('');
  lines.push('라이브를 **켠 다음에** 등록하세요. 켜기 전에 등록하면 시간이 어긋납니다.');

  if (last) {
    lines.push('');
    lines.push(
      `지난 방송 — ${last.game || '이름 없음'} · <t:${last.openedAt}:d> · 마킹 ${last.marks.length}개`
    );
  }

  embed.setTitle('🎥 방송 기록').setDescription(lines.join('\n').slice(0, DESC_LIMIT));

  // ⚠️ **[▶️ 이어서 기록] 이 있어야 "종료"가 비파괴가 됩니다.**
  //    누구나 누를 수 있는 버튼이라, 다섯 명이 아직 게임 중인데 눌릴 수 있습니다.
  //    저장이 안 지워지는 것만으로는 부족합니다 — 되돌리는 버튼이 있어야 합니다.
  const idleButtons = [joinButton()];
  if (last) {
    idleButtons.push(
      new ButtonBuilder()
        .setCustomId(`tm:panel:reopen:${last.id}`)
        .setLabel('이어서 기록')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  rows.push(new ActionRowBuilder().addComponents(...idleButtons));

  return { embeds: [embed], components: rows };
}

/**
 * **[🎬 지난 게임으로 등록]** — 저장해둔 고정 주소와 마지막 게임으로 한 번에 등록합니다.
 *
 * ★ 이게 "매번 링크 붙이기" 를 없애는 자리입니다. 명령어를 새로 만들지 않고
 *   버튼으로 둡니다 — `/방송` 을 인자 없이 치면 상태 보기라서 겹치고,
 *   자주 하는 조작은 버튼이어야 합니다 (규칙 3.6-6).
 */
function joinButton() {
  return new ButtonBuilder()
    .setCustomId('tm:panel:join')
    .setLabel('지난 게임으로 등록')
    .setEmoji('🎬')
    .setStyle(ButtonStyle.Primary);
}

/**
 * 방송 채널의 제어판을 최신 상태로 맞춥니다. 없으면 새로 띄웁니다.
 *
 * 기억해둔 메시지를 **고쳐 쓰는 것이 기본**입니다. 매번 새로 올리면 방송 몇 시간 동안
 * 채널이 제어판으로 도배되고, 전송 한도(5회/5초)에도 걸립니다.
 */
export async function ensureStreamPanel(client, guildId, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;

  const payload = buildStreamPanel(guildId);
  const known = rememberedId(STREAM, channelId);
  if (known) {
    const msg = await channel.messages.fetch(known).catch(() => null);
    if (msg) {
      await msg.edit(payload).catch(() => {});
      return msg;
    }
    forgetPanel(STREAM, channelId); // 누가 지웠습니다. 아래에서 새로 띄웁니다.
  }

  const sent = await channel
    .send({ ...payload, flags: MessageFlags.SuppressNotifications })
    .catch(() => null);
  if (sent) rememberPanel(STREAM, channelId, sent.id);
  return sent;
}

/** 켤 때 한 번. 방송 채널을 지정해둔 서버마다 제어판을 준비합니다. */
export async function ensureStreamPanels(client) {
  for (const guild of client.guilds.cache.values()) {
    const channelId = getSetting(guild.id, 'streamChannelId');
    if (!channelId) continue;
    await ensureStreamPanel(client, guild.id, channelId).catch(() => {});
  }
}

/** 제어판을 채널 맨 아래로 다시 올립니다. (요약판을 보낸 뒤에만) */
export async function repostStreamPanel(client, guildId, channelId) {
  const known = rememberedId(STREAM, channelId);
  if (known) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    await channel?.messages
      .fetch(known)
      .then((m) => m.delete())
      .catch(() => {});
    forgetPanel(STREAM, channelId);
  }
  return ensureStreamPanel(client, guildId, channelId);
}

// ── 제어판 고치기를 몰아서 하기 ────────────────────────────────
//
// 6명이 [✂️ 지금!] 을 연달아 누르면 제어판 수정이 그만큼 쌓입니다.
// 디스코드 전송 한도에 걸리면 **가장 많이 눌리는 버튼이 느려집니다.**
// 그래서 잠깐 모아 한 번만 고칩니다. 버튼 응답 자체는 이걸 기다리지 않습니다.
const pendingRefresh = new Map();
const REFRESH_DELAY_MS = 1500;

export function scheduleStreamPanelRefresh(client, guildId, channelId) {
  if (pendingRefresh.has(guildId)) return;
  const timer = setTimeout(() => {
    pendingRefresh.delete(guildId);
    ensureStreamPanel(client, guildId, channelId).catch(() => {});
  }, REFRESH_DELAY_MS);
  timer.unref?.();
  pendingRefresh.set(guildId, timer);
}

/**
 * 지난 방송의 요약판을 다시 올리는 드롭다운.
 *
 * 왜 필요한가: 종료 뒤에는 **요약판이 클립 뽑기로 가는 유일한 입구**입니다.
 * 채팅이 쌓여 위로 밀려 올라가면 찾아 올라가기 어렵습니다. 여기서 다시 부를 수 있게 합니다.
 */
export function buildSessionPicker(guildId) {
  const past = recentSessions(guildId, SELECT_LIMIT).filter((s) => s.closedAt && s.streams.length > 0);
  if (past.length === 0) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('tm:resum')
      .setPlaceholder('📝 지난 방송의 요약판 다시 올리기')
      .addOptions(
        past.map((s) => ({
          label: cut(`${s.game || '이름 없음'} · 마킹 ${s.marks.length}개`, 90),
          description: `${new Date(s.openedAt * 1000).toLocaleDateString('ko-KR')} · ${s.streams.length}명`,
          value: s.id,
        }))
      )
  );
}

// ── 입력 창 ───────────────────────────────────────────────────
//
// ⚠️ 화면을 만드는 함수는 **여기에 둡니다.** 그래야 verify 가 `toJSON()` 을 불러
//    빌더 검사를 돌릴 수 있습니다. 핸들러 안에 숨기면 검증이 불가능합니다. (규칙 7-1)

/** 시간이 어긋났을 때 실제 경과를 받는 창. 자기 방송만 고칠 수 있습니다. */
export function buildOffsetModal(stream, now = nowSec()) {
  const elapsed = humanDuration(now - stream.startedAt - (stream.offsetSec ?? 0));
  return new ModalBuilder()
    .setCustomId('tm:offsetm')
    .setTitle('시간 어긋남 맞추기')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('실제로 방송을 켠 지 얼마나 됐습니까?')
        .setDescription(`봇은 "${elapsed} 진행 중" 으로 알고 있습니다. 예: 1시간 20분`.slice(0, 100))
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('elapsed')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1시간 20분')
            .setRequired(true)
        )
    );
}

/**
 * 설명 채우기 창. 한 번에 5개씩 (디스코드 모달은 칸 5개가 상한).
 * @returns {{modal: ModalBuilder, marks: Array}|null} 채울 것이 없으면 null
 */
export function buildDescModal(session, stream, from = 0) {
  const rows = timelineFor(session, stream);
  const start = Math.max(0, Number(from) || 0);
  const page = rows.slice(start, start + DESC_PER_PAGE);
  if (page.length === 0) return null;

  const modal = new ModalBuilder()
    .setCustomId(`tm:descm:${session.id}:${stream.userId}:${start}`)
    .setTitle(`설명 채우기 (${start + 1}~${start + page.length}번)`);

  for (const { mark, sec } of page) {
    const input = new TextInputBuilder()
      .setCustomId(mark.id)
      .setStyle(TextInputStyle.Short)
      // ⚠️ 반드시 false. 안 하면 5칸 중 2칸만 채운 사람이 빠져나갈 수 없는 검증 오류를 만납니다.
      .setRequired(false)
      .setMaxLength(200);
    // ⚠️ **빈 문자열로 setValue 하지 마세요.** 창이 조용히 안 뜨고 버튼이 고장난 것처럼 보입니다.
    if (mark.text) input.setValue(mark.text);
    modal.addLabelComponents(new LabelBuilder().setLabel(hhmmss(sec)).setTextInputComponent(input));
  }

  return { modal, marks: page.map((x) => x.mark), total: rows.length, next: start + DESC_PER_PAGE };
}

/**
 * 클립 구간을 받는 창. 마킹을 중심으로 기본값을 채워둡니다.
 *
 * ⚠️ 시간 형식을 **`01:20:45` 로 유도합니다.** `parseElapsed` 는 숫자만 적으면 **분**으로
 *    보기 때문에(`90` → 90분), 기본값과 안내를 시:분:초로 채워 그 길로 안 가게 합니다.
 */
export function buildClipModal(session, stream, mark) {
  const sec = timelineFor(session, stream).find((x) => x.mark.id === mark.id)?.sec ?? 0;
  const from = Math.max(0, sec - config.stream.clipBeforeSec);
  const to = sec + config.stream.clipAfterSec;

  const modal = new ModalBuilder()
    .setCustomId(`tm:clipm:${session.id}:${stream.userId}:${mark.id}`)
    .setTitle(`클립 만들기 (${hhmmss(sec)})`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('시작 시간')
        .setDescription('시:분:초 로 적어주세요. 예: 01:20:30')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('from')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('01:20:30')
            .setValue(hhmmss(from))
        ),
      new LabelBuilder()
        .setLabel('끝 시간')
        .setDescription(`한 개는 ${config.stream.clipMaxSec}초까지입니다`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('to')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('01:21:10')
            .setValue(hhmmss(to))
        )
    );

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(60)
    .setPlaceholder('차에 치임');
  // ⚠️ 빈 문자열로 setValue 하면 창이 조용히 안 뜹니다. (규칙 7-1)
  if (mark.text) titleInput.setValue(mark.text);
  modal.addLabelComponents(new LabelBuilder().setLabel('클립 제목').setTextInputComponent(titleInput));

  return modal;
}

// ── 요약판 ────────────────────────────────────────────────────

/**
 * 한 사람의 요약판 메시지들. **사람당 한 장**입니다.
 *
 * 왜 나누는가: 버튼은 메시지당 25개, 드롭다운 선택지도 25개가 상한입니다.
 * 6명 × 마킹 여러 개를 한 장에 넣으면 넘칩니다. (docs/게임방송-기획.md 3.5)
 *
 * @returns {Array<{content: string, components?: Array}>} 순서대로 보낼 메시지들
 */
export function buildSummary(session, stream, clipPage = 0) {
  const rows = timelineFor(session, stream);
  const header =
    `📝 <@${stream.userId}> 의 타임라인` +
    (stream.game || session.game ? ` · ${stream.game || session.game}` : '') +
    ` · 마킹 ${rows.length}개\n` +
    `<${stream.url}>`;

  if (rows.length === 0) {
    return [{ content: `${header}\n\n이 방송 시간 안에 든 마킹이 없습니다.` }];
  }

  const lines = rows.map(({ mark, sec }) => `${hhmmss(sec)} ${mark.text || '(설명 없음)'}`);

  // 코드블록으로 감싸야 유튜브 설명란에 그대로 복사됩니다.
  // 길면 여러 장으로 나눕니다 — 조각마다 코드블록을 따로 닫아야 합니다.
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > MESSAGE_LIMIT && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length > 0) chunks.push(cur);

  return chunks.map((chunk, i) => {
    const content = (i === 0 ? `${header}\n` : '') + '```\n' + chunk.join('\n') + '\n```';
    // 버튼은 **마지막 조각에만** 붙입니다. 조각마다 붙으면 어느 걸 눌러야 할지 헷갈립니다.
    if (i < chunks.length - 1) return { content };
    return { content, components: summaryControls(session, stream, rows, clipPage) };
  });
}

/**
 * 요약판 아래의 조작부. 클립 뽑기 드롭다운 + 버튼들.
 *
 * 마킹이 25개를 넘으면 드롭다운에 다 못 담아서(디스코드 제한) 페이지로 나눕니다.
 */
function summaryControls(session, stream, rows, clipPage) {
  const pages = Math.max(1, Math.ceil(rows.length / SELECT_LIMIT));
  const page = Math.min(Math.max(0, clipPage), pages - 1);
  const slice = rows.slice(page * SELECT_LIMIT, page * SELECT_LIMIT + SELECT_LIMIT);
  const madeIds = new Set(clipsOf(session, stream.userId).map((c) => c.markId));

  const select = new StringSelectMenuBuilder()
    .setCustomId(`tm:clip:${session.id}:${stream.userId}:${page}`)
    .setPlaceholder(
      pages > 1 ? `🎥 클립 만들 순간 고르기 (${page + 1}/${pages}쪽)` : '🎥 클립 만들 순간 고르기'
    )
    .addOptions(
      slice.map(({ mark, sec }) => ({
        label: `${hhmmss(sec)}${madeIds.has(mark.id) ? ' ✅' : ''}`,
        description: mark.text ? cut(mark.text, 90) : '설명 없음',
        value: mark.id,
      }))
    );

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`tm:desc:${session.id}:${stream.userId}:0`)
      .setLabel('설명 채우기')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
  ];
  if (pages > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`tm:cpage:${session.id}:${stream.userId}:${page - 1}`)
        .setLabel('이전 쪽')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`tm:cpage:${session.id}:${stream.userId}:${page + 1}`)
        .setLabel('다음 쪽')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pages - 1)
    );
  }
  // 클립을 하나라도 만들었으면 보러 가는 링크를 붙입니다. (링크 버튼은 customId 가 없습니다)
  if (clipsOf(session).length > 0) {
    buttons.push(
      new ButtonBuilder()
        .setLabel('클립 보기')
        .setEmoji('🎥')
        .setStyle(ButtonStyle.Link)
        .setURL(clipPageUrl(session.id))
    );
  }

  return [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(...buttons)];
}
