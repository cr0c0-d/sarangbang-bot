// 게임 ↔ 기존 포럼 포스트 연결. 제목으로 추측하지 않고 사람이 포스트 안에서 직접 연결합니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'forum-posts.json');
let store = {};
let writeChain = Promise.resolve();

export async function initForumPosts() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = loaded && typeof loaded === 'object' ? loaded : {};
  } catch {
    store = {};
  }
}

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store, null, 2), 'utf8'))
    .catch((e) => console.error('[game] 포럼 연결 저장 실패:', e.message));
  return writeChain;
}

export function flushForumPosts() {
  return writeChain;
}

const mapKey = (kind, gameKey) => `${kind}:${gameKey}`;

export function postIdFor(guildId, kind, gameKey) {
  return store[guildId]?.[mapKey(kind, gameKey)] ?? null;
}

export function bindForumPost(guildId, kind, gameKey, threadId) {
  store[guildId] ??= {};
  // 한 포스트가 두 게임에 동시에 연결되면 검색 결과가 조용히 틀립니다. 옛 연결을 먼저 뗍니다.
  for (const [key, value] of Object.entries(store[guildId])) {
    if (key.startsWith(`${kind}:`) && value === threadId) delete store[guildId][key];
  }
  store[guildId][mapKey(kind, gameKey)] = threadId;
  save();
  return threadId;
}
