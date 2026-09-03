// 방송 기록 저장소 (타임머신).
//
// ★ **마킹은 세션에 한 줄씩만 저장합니다.** 사람별로 복사해두지 마세요.
//   마킹은 "몇 시 몇 분에 재미있는 일이 있었다" 는 **벽시계 사건 하나**입니다.
//   사람마다 다른 것은 그것을 자기 영상 시간으로 바꾼 결과뿐이고, 그건 계산입니다.
//   사람별로 복사해두면 늦게 합류한 사람이 생겼을 때 어긋나고,
//   오프셋을 고칠 때마다 전부 고쳐야 합니다. (docs/게임방송-기획.md 3.4)
//
// ⚠️ 방송은 몇 시간이고, 클립 추출은 방송이 끝난 뒤 며칠 뒤에도 일어납니다.
//    **끝난 세션도 지우지 않습니다.** 요약판의 버튼이 계속 동작해야 합니다.
//    재시작 직전 몇 초의 마킹이 사라지지 않게 flushStreams() 를 종료 처리에 넣으세요.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'streams.json');

/** 지난 세션을 언제까지 들고 있을지. 클립을 나중에 뽑는 일이 있어 넉넉히 둡니다. */
const KEEP_DAYS = 180;

/** 한 세션에 담을 수 있는 마킹 수. 요약판이 감당할 수 있는 범위로 제한합니다. */
export const MARK_MAX = 200;

/** @type {{ sessions: Session[] }} */
let store = { sessions: [] };
let writeChain = Promise.resolve();

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store), 'utf8'))
    .catch((e) => console.error('[stream] 저장 실패:', e.message));
  return writeChain;
}

/** 저장이 디스크에 실제로 내려갈 때까지 기다립니다. (종료·검증용) */
export function flushStreams() {
  return writeChain;
}

export async function initStreams() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = loaded && Array.isArray(loaded.sessions) ? loaded : { sessions: [] };
  } catch {
    store = { sessions: [] };
  }

  // 오래된 세션은 걷어냅니다. **열려 있는 세션은 나이와 무관하게 남깁니다** —
  // 방송을 켜둔 채 봇을 오래 재시작하지 않았을 수 있습니다.
  const cutoff = nowSec() - KEEP_DAYS * 86400;
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => !s.closedAt || s.closedAt > cutoff);
  if (store.sessions.length !== before) save();
  return store.sessions.length;
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** 짧은 무작위 id. 세션 폴더 이름으로도 그대로 씁니다 (사람이 지은 글자를 안 섞기 위해). */
function newId(len = 6) {
  return crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, len).toLowerCase();
}

// ── 세션 ──────────────────────────────────────────────────────

/** 이 서버에서 지금 기록 중인 세션. 없으면 null. */
export function activeSession(guildId) {
  return store.sessions.find((s) => s.guildId === guildId && !s.closedAt) ?? null;
}

export function sessionById(id) {
  return store.sessions.find((s) => s.id === id) ?? null;
}

/** 최근 세션부터. 상태 화면에서 지난 방송을 보여줄 때 씁니다. */
export function recentSessions(guildId, limit = 5) {
  return store.sessions
    .filter((s) => s.guildId === guildId)
    .slice()
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, limit);
}

export function openSession(guildId, channelId, game) {
  const s = {
    id: newId(),
    guildId,
    channelId,
    game: String(game ?? '').trim(),
    openedAt: nowSec(),
    closedAt: null,
    streams: [],
    marks: [],
    clips: [],
  };
  store.sessions.push(s);
  save();
  return s;
}

export function closeSession(session) {
  session.closedAt = nowSec();
  save();
  return session;
}

/** 잘못 눌러 닫힌 세션을 다시 엽니다. **되돌리는 버튼이 있어야 비파괴입니다.** */
export function reopenSession(session) {
  session.closedAt = null;
  save();
  return session;
}

export function setGame(session, game) {
  const g = String(game ?? '').trim();
  if (!g) return session.game;
  session.game = g;
  save();
  return g;
}

// ── 사람별 방송 ───────────────────────────────────────────────

export function streamOf(session, userId) {
  return session.streams.find((x) => x.userId === userId) ?? null;
}

/**
 * 방송을 등록하거나 링크를 바꿔 끼웁니다.
 * 같은 사람이 다시 실행하면 **새로 만들지 않고 갈아끼웁니다** (오프셋은 초기화).
 */
export function putStream(session, { userId, url, videoId, startedAt, startSource }) {
  const found = streamOf(session, userId);
  const entry = { userId, url, videoId, startedAt, startSource, offsetSec: 0 };
  if (found) Object.assign(found, entry);
  else session.streams.push(entry);
  save();
  return found ?? session.streams[session.streams.length - 1];
}

export function setOffset(session, userId, offsetSec) {
  const s = streamOf(session, userId);
  if (!s) return null;
  s.offsetSec = Math.round(offsetSec);
  save();
  return s;
}

// ── 마킹 ──────────────────────────────────────────────────────

/**
 * 지금을 찍습니다. **입력을 받지 않습니다** — 게임 중에 창을 띄우면 그 순간이 지나갑니다.
 * 설명은 방송이 끝난 뒤 요약판에서 붙입니다.
 *
 * ★ **찍은 사람의 방송에만 들어갑니다** (`forUserId`).
 *   처음에는 모두의 타임라인에 넣었습니다 — 원래 기획이 "협동 게임" 전제였기 때문입니다.
 *   그런데 **동시에 방송을 켜도 각자 다른 게임을 할 수 있습니다**(소유자 지적).
 *   그러면 남의 게임에서 있었던 일이 내 타임라인에 섞입니다. 되돌릴 방법도 없습니다.
 *   그래서 기본을 "내 방송만" 으로 두고, 다 같이 하던 순간은 **찍은 뒤에** 넓힙니다
 *   (`shareMark`). 그 순간은 이미 잡혀 있으니 한 번 더 누르는 데 여유가 있습니다.
 *
 * @param {string|null} forUserId 이 마킹이 들어갈 방송의 주인. `null` 이면 **모두**.
 */
export function addMark(session, byUserId, forUserId = byUserId) {
  if (session.marks.length >= MARK_MAX) return null;
  const mark = { id: newId(4), at: nowSec(), byUserId, forUserId: forUserId ?? null, text: '' };
  session.marks.push(mark);
  save();
  return mark;
}

/** 이 마킹을 **모두의 타임라인**으로 넓힙니다. (다 같이 하던 순간) */
export function shareMark(session, markId) {
  const mark = session.marks.find((m) => m.id === markId);
  if (!mark) return null;
  mark.forUserId = null;
  save();
  return mark;
}

/**
 * 실수로 누른 것을 지웁니다.
 *
 * ⚠️ **내가 찍은 것 중 마지막**을 지웁니다. 그냥 마지막 하나를 지우면
 *    남이 방금 찍은 것을 지우게 됩니다 — 마킹이 사람마다 따로인 지금은 더 그렇습니다.
 */
export function removeLastMark(session, byUserId = null) {
  const idx = byUserId
    ? session.marks.map((m) => m.byUserId).lastIndexOf(byUserId)
    : session.marks.length - 1;
  if (idx < 0) return null;
  const [gone] = session.marks.splice(idx, 1);
  if (gone) save();
  return gone;
}

// ── 요약판 메시지 기억 ────────────────────────────────────────
//
// ★ 왜 기억하는가: 설명을 채우거나 클립을 만들 때마다 요약판을 **새로 올리면**
//   채널에 같은 타임라인이 5장, 6장 쌓입니다. 제어판을 메시지 하나로 고쳐 쓰는 것과
//   같은 이유로(3.6-1) 요약판도 **그 자리에서 고쳐 씁니다.**

export function setSummaryMessages(session, userId, messageIds) {
  session.summaryMsgs ??= {};
  session.summaryMsgs[userId] = messageIds;
  save();
}

export function summaryMessages(session, userId) {
  return session.summaryMsgs?.[userId] ?? [];
}

// ── 클립 ──────────────────────────────────────────────────────

/** 만든 클립을 기록해둡니다. 파일 자체는 `clips.js` 가 다룹니다. */
export function addClip(session, clip) {
  session.clips ??= [];
  // 같은 마킹·같은 사람으로 다시 만들면 갈아끼웁니다. 목록이 중복으로 불지 않게.
  const i = session.clips.findIndex((c) => c.markId === clip.markId && c.userId === clip.userId);
  if (i >= 0) session.clips[i] = { ...clip, madeAt: nowSec() };
  else session.clips.push({ ...clip, madeAt: nowSec() });
  save();
  return session.clips;
}

export function clipsOf(session, userId = null) {
  const all = session.clips ?? [];
  return userId ? all.filter((c) => c.userId === userId) : all;
}

export function setMarkText(session, markId, text) {
  const mark = session.marks.find((m) => m.id === markId);
  if (!mark) return false;
  mark.text = String(text ?? '').trim().slice(0, 200);
  save();
  return true;
}

/**
 * 이 마킹이 그 사람 영상에서 몇 초 지점인지.
 *
 * ★ 이 한 줄이 이 기능의 핵심입니다. (docs/게임방송-기획.md 2.2)
 * 늦게 켠 사람은 음수가 나옵니다 — 그 사람 요약판에서는 그 마킹을 뺍니다.
 */
export function markSecondsFor(stream, mark) {
  return mark.at - stream.startedAt - (stream.offsetSec ?? 0);
}

/** 이 마킹이 그 사람 타임라인에 들어가는가. `forUserId` 가 없으면 **모두의 것**입니다. */
export function markBelongsTo(mark, userId) {
  return !mark.forUserId || mark.forUserId === userId;
}

/**
 * 그 사람 영상에 실제로 담긴 마킹만, 시간순으로.
 *
 * 두 가지를 걸러냅니다.
 *   1. **남의 방송에 찍은 마킹** (`forUserId`). 각자 다른 게임을 할 수 있습니다.
 *   2. 그 사람이 켜기 전의 마킹 (음수). 늦게 켠 사람에게는 그 장면이 없습니다.
 */
export function timelineFor(session, stream) {
  return session.marks
    .filter((mark) => markBelongsTo(mark, stream.userId))
    .map((mark) => ({ mark, sec: markSecondsFor(stream, mark) }))
    .filter((x) => x.sec >= 0)
    .sort((a, b) => a.sec - b.sec);
}

/** `01:20:45` 형태로. 한 시간 미만이어도 유튜브 설명란에는 시간까지 적는 편이 안전합니다. */
export function hhmmss(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** `1시간 8분` 처럼 사람이 읽는 형태로. 경과 시간을 되읽어줄 때 씁니다. */
export function humanDuration(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return `${m}분`;
  return `${s}초`;
}
