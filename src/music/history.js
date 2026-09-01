// 지난 재생 기록 — "그때 그 노래 뭐였지" 를 해결합니다.
//
// GuildAudio 안에도 `history` 가 있지만 그건 **⏮️ 이전 곡용**이고 메모리에만 있습니다.
// 봇을 재시작하면 사라지고, 오래된 곡은 밀려나갑니다.
// 여기는 **디스크에 남는 목록**이라 며칠 전에 듣던 곡도 다시 꺼낼 수 있습니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'history.json');

/** 서버당 몇 곡까지 기억할지. 드롭다운은 25개 제한이라 그보다 넉넉히 둡니다. */
const LIMIT = 60;

/** @type {{ [guildId: string]: Array<{url: string, title: string, duration: number|null, at: number}> }} */
let store = {};
let writeChain = Promise.resolve();

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store), 'utf8'))
    .catch((e) => console.error('[history] 저장 실패:', e.message));
  return writeChain;
}

export async function initHistory() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = loaded && typeof loaded === 'object' ? loaded : {};
  } catch {
    store = {}; // 파일이 없거나 깨졌으면 빈 상태로 시작합니다
  }
}

/**
 * 곡을 기록합니다. **실제로 소리가 나기 시작한 순간**에만 부릅니다.
 *
 * 대기열에 넣을 때 기록하면, 재생에 실패한 곡(유튜브 차단 등)까지 목록에 쌓입니다.
 * 다시 골라도 또 실패하므로 기록할 값어치가 없습니다.
 */
export function record(guildId, track, at = Date.now()) {
  if (!guildId || !track?.url || !track?.title) return;
  // 드롭다운 값은 100자 제한입니다. 넘는 주소는 다시 고를 수 없으니 넣지 않습니다.
  if (track.url.length > 100) return;

  const list = (store[guildId] ??= []);
  // 같은 곡을 또 들었으면 맨 앞으로 올립니다 (중복으로 쌓이지 않게).
  const at0 = list.findIndex((e) => e.url === track.url);
  if (at0 !== -1) list.splice(at0, 1);

  list.unshift({ url: track.url, title: track.title, duration: track.duration ?? null, at });
  if (list.length > LIMIT) list.length = LIMIT;
  save();
}

/** 최근에 들은 순서대로 돌려줍니다. */
export function recent(guildId, limit = 25) {
  return (store[guildId] ?? []).slice(0, limit);
}

export function count(guildId) {
  return (store[guildId] ?? []).length;
}

/** "방금 · 3시간 전 · 어제 · 5일 전" — 언제 들었는지 감을 주기 위한 표시입니다. */
export function timeAgo(at, now = Date.now()) {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '어제';
  if (day < 30) return `${day}일 전`;
  const month = Math.floor(day / 30);
  return `${month}달 전`;
}
