// `/망고야` 사용량 세기 — **이 기획에서 가장 중요한 부분입니다.**
//
// 친구들이 같이 쓰는데 요금(또는 무료 등급의 하루 한도)은 소유자 몫입니다.
// 한도가 없으면 한 사람이 오전에 다 써버리고 나머지는 종일 못 씁니다.
//
// ⚠️ **재시작하면 초기화되는 한도는 한도가 아닙니다.** 디스크에 남깁니다.
//    `music/history.js` 와 같은 방식입니다 — 쓰기는 기다리지 않고, 종료할 때 flush.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'ai-usage.json');

/** @type {{ users: {[k: string]: number[]}, guilds: {[k: string]: number[]}, tokens: {[k: string]: object} }} */
let store = { users: {}, guilds: {}, tokens: {} };
let writeChain = Promise.resolve();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store), 'utf8'))
    .catch((e) => console.error('[ai] 사용량 저장 실패:', e.message));
  return writeChain;
}

/**
 * 저장이 디스크에 **실제로 내려갈 때까지** 기다립니다.
 * 종료할 때 부릅니다. 안 그러면 방금 쓴 횟수가 사라져 한도가 새어나갑니다.
 */
export function flushUsage() {
  return writeChain;
}

export async function initUsage() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    const obj = (v) => (v && typeof v === 'object' ? v : {});
    store = { users: obj(loaded?.users), guilds: obj(loaded?.guilds), tokens: obj(loaded?.tokens) };
  } catch {
    store = { users: {}, guilds: {}, tokens: {} }; // 파일이 없거나 깨졌으면 빈 상태로
  }
}

/** 창(window) 밖으로 나간 기록은 버립니다. 안 그러면 파일이 끝없이 자랍니다. */
function recent(list, windowMs, now) {
  return (list ?? []).filter((t) => now - t < windowMs);
}

const userKey = (guildId, userId) => `${guildId}:${userId}`;

/**
 * 지금 물어봐도 되는지 봅니다. **아직 세지는 않습니다.**
 *
 * 왜 나누나: 질문이 실패하면(제미나이 오류 등) 횟수를 깎지 않아야 합니다.
 * 성공했을 때만 `record()` 를 부릅니다.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function check(guildId, userId, now = Date.now()) {
  const perUser = config.ai.perUserHourly;
  const perGuild = config.ai.perGuildDaily;

  const mine = recent(store.users[userKey(guildId, userId)], HOUR_MS, now);
  if (perUser > 0 && mine.length >= perUser) {
    const waitMin = Math.max(1, Math.ceil((HOUR_MS - (now - mine[0])) / 60000));
    return {
      ok: false,
      reason: `한 시간에 **${perUser}번**까지만 물어볼 수 있습니다. **${waitMin}분** 뒤에 다시 물어봐 주세요.`,
    };
  }

  const ours = recent(store.guilds[guildId], DAY_MS, now);
  if (perGuild > 0 && ours.length >= perGuild) {
    const waitHour = Math.max(1, Math.ceil((DAY_MS - (now - ours[0])) / HOUR_MS));
    return {
      ok: false,
      reason: `이 서버의 하루 한도(**${perGuild}번**)를 다 썼습니다. **${waitHour}시간** 뒤에 다시 채워집니다.`,
    };
  }

  return { ok: true };
}

/** `2026-09-02` · `2026-09` — 날짜가 바뀌면 저절로 0부터 셉니다. */
const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const monthKey = (now) => new Date(now).toISOString().slice(0, 7);

/**
 * 실제로 한 번 썼다고 기록합니다. **성공했을 때만** 부릅니다.
 * @param {number} [tokens] 이번에 쓴 토큰 수 (제미나이가 알려준 값)
 */
export function record(guildId, userId, tokens = 0, now = Date.now()) {
  const uk = userKey(guildId, userId);
  store.users[uk] = [...recent(store.users[uk], HOUR_MS, now), now];
  store.guilds[guildId] = [...recent(store.guilds[guildId], DAY_MS, now), now];

  if (tokens > 0) {
    const t = (store.tokens[guildId] ??= {});
    // 날짜가 바뀌면 그 칸을 0으로 되돌립니다. 따로 청소할 필요가 없습니다.
    if (t.day !== dayKey(now)) {
      t.day = dayKey(now);
      t.dayTokens = 0;
    }
    if (t.month !== monthKey(now)) {
      t.month = monthKey(now);
      t.monthTokens = 0;
    }
    t.dayTokens = (t.dayTokens ?? 0) + tokens;
    t.monthTokens = (t.monthTokens ?? 0) + tokens;
    t.total = (t.total ?? 0) + tokens;
  }
  save();
}

/** 남은 횟수. 상태 화면에 보여줍니다 — 얼마나 남았는지 모르면 불안합니다. */
export function remaining(guildId, userId, now = Date.now()) {
  const mine = recent(store.users[userKey(guildId, userId)], HOUR_MS, now).length;
  const ours = recent(store.guilds[guildId], DAY_MS, now).length;
  return {
    user: Math.max(0, config.ai.perUserHourly - mine),
    userMax: config.ai.perUserHourly,
    guild: Math.max(0, config.ai.perGuildDaily - ours),
    guildMax: config.ai.perGuildDaily,
    used: ours,
  };
}

/**
 * 지금까지 쓴 토큰. **남은 양이 아닙니다** — 제미나이는 남은 양을 알려주지 않습니다.
 * 그건 https://aistudio.google.com/rate-limit 에서만 볼 수 있습니다.
 */
export function tokenUsage(guildId, now = Date.now()) {
  const t = store.tokens[guildId] ?? {};
  return {
    day: t.day === dayKey(now) ? (t.dayTokens ?? 0) : 0,
    month: t.month === monthKey(now) ? (t.monthTokens ?? 0) : 0,
    total: t.total ?? 0,
  };
}

/** 검사용. 세어둔 것을 지웁니다. */
export function resetUsage() {
  store = { users: {}, guilds: {}, tokens: {} };
}
