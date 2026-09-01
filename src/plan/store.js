// 일정 저장소 + 알림 예약.
//
// ★ **일정 하나 = 채널 하나** 입니다. 소유자가 이미 그렇게 쓰고 있습니다
//   ([yymmdd-일정명] 비공개 채널 하나에 일정 하나). 그 구조를 그대로 씁니다.
//     · 일정 ID 를 만들지 않습니다 — **채널 ID 가 곧 일정 ID** 입니다.
//     · 참여자를 관리하지 않습니다 — **채널 권한이 곧 참여자 목록** 입니다.
//     · 그래서 "어느 일정?" 을 물어볼 필요가 없습니다.
//
// ⚠️ setTimeout 은 재시작하면 사라집니다. 알림 시각을 디스크에 적어두고 켜질 때 되살립니다.
//    (타이머·투표 자동마감과 같은 방식 — ARCHITECTURE 3.4-2, 3.6-7)
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'plans.json');

/** setTimeout 한계는 약 24.8일입니다. 그보다 먼 알림은 켜질 때 다시 계산합니다. */
const MAX_TIMEOUT_MS = 20 * 24 * 60 * 60 * 1000;

/** 지난 일정을 언제까지 들고 있을지. 사진·정산 이야기가 끝날 때까지는 남아야 합니다. */
const KEEP_DAYS = 120;

/** @type {{ [channelId: string]: Plan }} */
let store = {};
let writeChain = Promise.resolve();
/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store), 'utf8'))
    .catch((e) => console.error('[plan] 저장 실패:', e.message));
  return writeChain;
}

/** 저장이 디스크에 실제로 내려갈 때까지 기다립니다. (종료·검증용) */
export function flushPlans() {
  return writeChain;
}

export async function initPlans() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = loaded && typeof loaded === 'object' ? loaded : {};
  } catch {
    store = {};
  }

  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  let dropped = 0;
  for (const [id, plan] of Object.entries(store)) {
    if ((plan?.at ?? 0) < cutoff) {
      delete store[id];
      dropped++;
    }
  }
  if (dropped > 0) {
    console.log(`   지난 일정 ${dropped}개 정리 (${KEEP_DAYS}일 지남)`);
    save();
  }
}

export const getPlan = (channelId) => store[channelId] ?? null;
export const allPlans = () => Object.entries(store);

export function setPlan(channelId, plan) {
  store[channelId] = plan;
  save();
  return plan;
}

export function updatePlan(channelId, patch) {
  const plan = store[channelId];
  if (!plan) return null;
  Object.assign(plan, patch);
  save();
  return plan;
}

export function removePlan(channelId) {
  if (!store[channelId]) return false;
  delete store[channelId];
  cancelReminder(channelId);
  save();
  return true;
}

// ── 알림 ──────────────────────────────────────────────────

export function cancelReminder(channelId) {
  const t = timers.get(channelId);
  if (t) clearTimeout(t);
  timers.delete(channelId);
}

/**
 * 알림을 예약합니다. `fire(channelId, plan)` 은 index.js 가 넘겨줍니다.
 * (저장소가 디스코드를 직접 만지지 않게 분리해둡니다)
 */
export function scheduleReminder(channelId, fire) {
  const plan = store[channelId];
  cancelReminder(channelId);
  if (!plan?.remindAt) return;

  const delay = plan.remindAt - Date.now();
  // 이미 지났으면 알리지 않습니다. 지난 약속을 뒤늦게 알려주면 혼란만 줍니다.
  if (delay <= 0) {
    updatePlan(channelId, { remindAt: null });
    return;
  }
  // 너무 멀면 지금 걸 수 없습니다. 다음 재시작이나 20일 뒤에 다시 계산합니다.
  if (delay > MAX_TIMEOUT_MS) {
    timers.set(channelId, setTimeout(() => scheduleReminder(channelId, fire), MAX_TIMEOUT_MS));
    return;
  }

  timers.set(
    channelId,
    setTimeout(() => {
      timers.delete(channelId);
      updatePlan(channelId, { remindAt: null });
      Promise.resolve(fire(channelId, store[channelId])).catch((e) =>
        console.error('[plan] 알림 실패:', e.message)
      );
    }, delay)
  );
}

/** 봇이 켜질 때 예약을 되살립니다. */
export function restoreReminders(fire) {
  let revived = 0;
  for (const [channelId, plan] of Object.entries(store)) {
    if (!plan?.remindAt) continue;
    scheduleReminder(channelId, fire);
    revived++;
  }
  if (revived > 0) console.log(`   일정 알림 예약 ${revived}건 복구`);
}
