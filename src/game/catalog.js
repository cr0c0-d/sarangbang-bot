// 서버에서 실제로 부르는 게임 이름을 기억합니다.
//
// Steam 검색은 `스타듀밸리`, `발헤임` 같은 통용 한글명을 거의 찾지 못합니다.
// 포럼 포스트를 연결할 때 그 제목을 Steam appid에 별칭으로 묶어두면,
// 그다음부터 `/게임`과 `/방송` 자동완성은 외부 API 없이 한글로 찾을 수 있습니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { userError } from '../user-error.js';

const FILE = path.join(config.dataDir, 'game-aliases.json');
let store = {};
let writeChain = Promise.resolve();

export async function initGameCatalog() {
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
    .catch((e) => console.error('[game] 한글 별칭 저장 실패:', e.message));
  return writeChain;
}

export function flushGameCatalog() {
  return writeChain;
}

/** 띄어쓰기·문장부호·이모지 차이 때문에 같은 별칭을 놓치지 않게 합니다. */
export function normalizeGameSearch(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ko-KR')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function cleanGame(game) {
  return {
    key: game.key,
    appid: game.appid ?? null,
    name: String(game.name ?? '').trim(),
    image: game.image ?? null,
    genres: Array.isArray(game.genres) ? game.genres.slice(0, 20) : [],
    cooperative: game.cooperative ?? null,
  };
}

/** 게임 정보와 포럼 제목 같은 별칭을 누적합니다. */
export function rememberGame(guildId, game, alias = null) {
  if (!guildId || !game?.key || !game?.name) return null;
  store[guildId] ??= {};
  const old = store[guildId][game.key] ?? { aliases: [] };
  const aliases = Array.isArray(old.aliases) ? old.aliases.slice() : [];
  const text = String(alias ?? '').trim().slice(0, 100);
  if (text) {
    const normalized = normalizeGameSearch(text);
    if (normalized && !aliases.some((x) => normalizeGameSearch(x) === normalized)) aliases.push(text);
  }
  store[guildId][game.key] = { ...old, ...cleanGame(game), aliases };
  save();
  return store[guildId][game.key];
}

function gameResult(entry, alias = null) {
  return { ...cleanGame(entry), aliases: entry.aliases ?? [], alias };
}

/** 자동완성에서 한글 일부만 쳐도 포럼 제목 별칭을 찾습니다. */
export function searchKnownGames(guildId, query, limit = 10) {
  const q = normalizeGameSearch(query);
  if (!q) return [];
  const results = [];
  for (const entry of Object.values(store[guildId] ?? {})) {
    if (!entry?.key || !entry?.name) continue;
    const candidates = [entry.name, ...(entry.aliases ?? [])]
      .map((text) => ({ text, normalized: normalizeGameSearch(text) }))
      .filter((x) => x.normalized.includes(q));
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      const rank = (x) => x.normalized === q ? 0 : x.normalized.startsWith(q) ? 1 : 2;
      return rank(a) - rank(b) || a.text.length - b.text.length;
    });
    const best = candidates[0];
    const rank = best.normalized === q ? 0 : best.normalized.startsWith(q) ? 1 : 2;
    results.push({ game: gameResult(entry, best.text), rank, length: best.text.length });
  }
  return results
    .sort((a, b) => a.rank - b.rank || a.length - b.length || a.game.name.localeCompare(b.game.name, 'ko'))
    .slice(0, limit)
    .map((x) => x.game);
}

/** 자동완성 값(game key)이나 정확한 별칭을 정식 게임 정보로 되돌립니다. */
export function resolveKnownGame(guildId, input) {
  const games = Object.values(store[guildId] ?? {}).filter((x) => x?.key && x?.name);
  const byKey = games.find((x) => x.key === input);
  if (byKey) return gameResult(byKey);

  const q = normalizeGameSearch(input);
  if (!q) return null;
  const exact = games.filter((entry) =>
    [entry.name, ...(entry.aliases ?? [])].some((x) => normalizeGameSearch(x) === q)
  );
  // 같은 별칭이 두 게임에 붙었으면 조용히 하나를 고르지 않습니다. 자동완성에서 고르게 합니다.
  if (exact.length > 1) throw userError('같은 별칭의 게임이 여러 개입니다. 자동완성 목록에서 게임을 골라주세요.');
  return exact.length === 1 ? gameResult(exact[0]) : null;
}
