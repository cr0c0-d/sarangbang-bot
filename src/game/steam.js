// Steam 게임 검색. 두 엔드포인트 모두 비공식이므로, 실패해도 직접 입력 경로는 살아 있어야 합니다.
// docs/게임검색-포럼연동-기획.md 2절.
const SEARCH_URL = 'https://steamcommunity.com/actions/SearchApps/';
const DETAIL_URL = 'https://store.steampowered.com/api/appdetails';
const CACHE_MS = 10 * 60_000;
const cache = new Map();

async function getJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Steam HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 자동완성용. 실패하면 빈 목록을 돌려 직접 입력을 계속 쓸 수 있게 합니다. */
export async function searchGames(query) {
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  const key = q.toLocaleLowerCase('en-US');
  const hit = cache.get(`s:${key}`);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const raw = await getJson(SEARCH_URL + encodeURIComponent(q));
    const value = (Array.isArray(raw) ? raw : [])
      .map((x) => ({ appid: String(x.appid ?? ''), name: String(x.name ?? '').trim(), icon: x.icon || null }))
      .filter((x) => /^\d+$/.test(x.appid) && x.name)
      .slice(0, 10);
    cache.set(`s:${key}`, { at: Date.now(), value });
    return value;
  } catch {
    return [];
  }
}

export async function gameByAppId(appid) {
  const id = String(appid ?? '');
  if (!/^\d+$/.test(id)) return null;
  const hit = cache.get(`d:${id}`);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const raw = await getJson(`${DETAIL_URL}?appids=${id}&cc=kr&l=korean`, 4000);
    const data = raw?.[id]?.success ? raw[id].data : null;
    if (!data?.name) return null;
    const value = {
      key: `steam:${id}`,
      appid: id,
      name: String(data.name).trim(),
      image: data.header_image || null,
      genres: Array.isArray(data.genres) ? data.genres.map((x) => x.description).filter(Boolean) : [],
      cooperative: Array.isArray(data.categories)
        ? data.categories.some((x) => /협동|co-?op/i.test(String(x.description ?? '')))
        : false,
    };
    cache.set(`d:${id}`, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
}

export function directGame(name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!clean) return null;
  return {
    key: `name:${clean.toLocaleLowerCase('ko-KR')}`,
    appid: null,
    name: clean,
    image: null,
    genres: [],
    cooperative: null,
  };
}

/** 자동완성 값(`steam:번호`) 또는 사람이 직접 친 이름을 게임 객체로 바꿉니다. */
export async function resolveGame(input) {
  const text = String(input ?? '').trim();
  const steam = text.match(/^steam:(\d+)$/);
  if (!steam) return directGame(text);
  return gameByAppId(steam[1]);
}

export async function autocompleteGames(interaction) {
  const focused = interaction.options.getFocused();
  const games = await searchGames(focused);
  await interaction
    .respond(games.map((g) => ({ name: `🎮 ${g.name}`.slice(0, 100), value: `steam:${g.appid}` })))
    .catch(() => {});
}
