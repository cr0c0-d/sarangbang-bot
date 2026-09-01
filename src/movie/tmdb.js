// TMDB(The Movie Database) 호출을 감싸는 얇은 래퍼입니다.
//
// 왜 TMDB 인가: 넷플릭스·쿠팡플레이는 **서드파티용 카탈로그 API 를 제공하지 않습니다.**
// 크롤링은 약관 위반 소지에 구조가 바뀔 때마다 깨집니다. TMDB 는 무료 공식 API 이고,
// `watch_region=KR` + `with_watch_providers` 로 "한국에서 이 OTT 로 볼 수 있는 작품" 을 줍니다.
// (yt-dlp 를 쓰는 것과 같은 판단입니다 — ARCHITECTURE 3.1, 3.6-8)
import { config } from '../config.js';

const BASE = 'https://api.themoviedb.org/3';

/** 포스터 주소. w500 이면 디스코드 임베드에 충분하고 파일도 가볍습니다. */
export const posterUrl = (path) => (path ? `https://image.tmdb.org/t/p/w500${path}` : null);

/** 키가 없으면 기능을 꺼둡니다. 키가 없다고 봇 전체가 죽으면 안 됩니다. */
export function hasKey() {
  return Boolean(config.tmdb.readToken || config.tmdb.apiKey);
}

/**
 * TMDB 호출.
 *
 * 인증은 두 가지입니다. **읽기 액세스 토큰(v4)** 이 있으면 그걸 헤더로 쓰고,
 * 없으면 예전 방식인 **API 키(v3)** 를 주소에 붙입니다.
 * 개발자 포털에서 둘 다 주기 때문에 어느 쪽을 넣어도 되게 해둡니다.
 */
async function call(path, { timeoutMs = 8000 } = {}) {
  if (!hasKey()) throw new Error('TMDB_API_KEY 가 설정되지 않았습니다.');

  const sep = path.includes('?') ? '&' : '?';
  const url = config.tmdb.readToken ? `${BASE}${path}` : `${BASE}${path}${sep}api_key=${config.tmdb.apiKey}`;
  const headers = { accept: 'application/json' };
  if (config.tmdb.readToken) headers.Authorization = `Bearer ${config.tmdb.readToken}`;

  // 느린 서버에서 하염없이 기다리지 않게 제한시간을 둡니다.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(friendlyError(res.status));
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('TMDB 응답이 너무 오래 걸립니다. 잠시 뒤 다시 시도해주세요.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 영어 상태코드를 한국어 + "다음에 뭘 할지" 로 바꿉니다. (music/ytdlp.js 의 관례) */
export function friendlyError(status) {
  if (status === 401) {
    return 'TMDB 키가 잘못됐습니다. `.env` 의 TMDB_READ_TOKEN 을 확인해주세요.\n(themoviedb.org → 설정 → API → "API 읽기 액세스 토큰")';
  }
  if (status === 404) return 'TMDB 에서 찾을 수 없는 주소입니다. (봇 문제일 수 있습니다)';
  if (status === 429) return 'TMDB 요청이 너무 많습니다. 잠시 뒤 다시 시도해주세요.';
  if (status >= 500) return 'TMDB 쪽에 문제가 있습니다. 잠시 뒤 다시 시도해주세요.';
  return `TMDB 오류 (${status})`;
}

// ── 장르 ──────────────────────────────────────────────────
//
// ⚠️ TMDB 는 영화와 드라마의 **장르 번호가 다릅니다.**
//    액션은 영화가 28, 드라마는 10759(Action & Adventure) 입니다.
//    둘을 섞어 뽑기로 했으므로(3.6-8) 종류별 번호를 같이 들고 다녀야 합니다.
//
//    드라마에 없는 장르(로맨스·스릴러·공포)는 `tv: null` 입니다. 그때는 영화만 찾습니다.
//    번호는 2026-09-01 에 `/genre/movie/list`·`/genre/tv/list` 로 실측했습니다.
//    verify 가 실제로 대조하므로, TMDB 가 바꾸면 검증에서 걸립니다.
export const GENRES = [
  { key: 'action', label: '액션', emoji: '💥', movie: '28', tv: '10759' },
  { key: 'comedy', label: '코미디', emoji: '😂', movie: '35', tv: '35' },
  { key: 'romance', label: '로맨스', emoji: '💕', movie: '10749', tv: null },
  { key: 'thriller', label: '스릴러', emoji: '😰', movie: '53', tv: null },
  { key: 'horror', label: '공포', emoji: '👻', movie: '27', tv: null },
  { key: 'scifi', label: 'SF · 판타지', emoji: '🚀', movie: '878|14', tv: '10765' },
  { key: 'animation', label: '애니메이션', emoji: '🎨', movie: '16', tv: '16' },
  { key: 'drama', label: '드라마', emoji: '🎭', movie: '18', tv: '18' },
  { key: 'crime', label: '범죄', emoji: '🔪', movie: '80', tv: '80' },
  { key: 'mystery', label: '미스터리', emoji: '🔍', movie: '9648', tv: '9648' },
  { key: 'family', label: '가족', emoji: '👨‍👩‍👧', movie: '10751', tv: '10751' },
  { key: 'documentary', label: '다큐멘터리', emoji: '📚', movie: '99', tv: '99' },
];

export const genreByKey = (key) => GENRES.find((g) => g.key === key) ?? null;

// ── OTT (watch provider) ──────────────────────────────────
//
// ★ provider ID 는 **추측하면 안 됩니다.** 기획안은 쿠팡플레이를 356 으로 적었는데,
//   356 은 실제로 **wavve** 입니다. 2026-09-01 에 `/watch/providers/*?watch_region=KR` 로
//   실측한 값입니다. `verify` 가 이름까지 대조하므로 TMDB 가 바꾸면 걸립니다.
//
// ⚠️ **쿠팡플레이는 TMDB 에 자료가 사실상 없습니다** (실측: 영화 0건, 드라마 8건).
//   목록에는 두되 고르면 결과가 없다고 안내합니다. 지워버리면 "왜 없냐" 는 질문이 반복됩니다.
export const PROVIDERS = [
  { id: 8, name: '넷플릭스', tmdbName: 'Netflix' },
  { id: 1883, name: 'TVING', tmdbName: 'TVING' },
  { id: 356, name: 'wavve', tmdbName: 'wavve' },
  { id: 97, name: '왓챠', tmdbName: 'Watcha' },
  { id: 337, name: '디즈니+', tmdbName: 'Disney Plus' },
  { id: 119, name: '아마존 프라임', tmdbName: 'Amazon Prime Video' },
  { id: 350, name: 'Apple TV', tmdbName: 'Apple TV' },
  { id: 1881, name: '쿠팡플레이', tmdbName: 'Coupang Play', sparse: true },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === Number(id)) ?? null;

/**
 * 박아둔 provider 이름이 지금도 맞는지 대조합니다. 시작할 때 한 번 부릅니다.
 *
 * 매번 조회하면 느리고, 안 하면 조용히 틀립니다. 그래서 **박아두고 대조해 경고**합니다.
 * (`.env` 중복 경고, 두 봇 토큰 대조와 같은 방식)
 */
export async function checkProviders() {
  try {
    const json = await call('/watch/providers/movie?watch_region=KR&language=ko-KR');
    const actual = new Map(json.results.map((p) => [p.provider_id, p.provider_name]));
    const wrong = PROVIDERS.filter((p) => actual.has(p.id) && actual.get(p.id) !== p.tmdbName);
    if (wrong.length > 0) {
      console.warn(
        '[movie] TMDB 의 OTT 번호가 바뀐 것 같습니다:\n' +
          wrong.map((p) => `        ${p.id} 를 ${p.tmdbName} 로 알고 있는데 실제로는 ${actual.get(p.id)}`).join('\n') +
          '\n        src/movie/tmdb.js 의 PROVIDERS 를 고쳐야 합니다.'
      );
    }
  } catch (err) {
    console.warn('[movie] OTT 목록 확인 실패 (기능은 그대로 씁니다):', err.message);
  }
}

// ── 후보 찾기 ─────────────────────────────────────────────

/** 너무 안 알려진 작품만 나오지 않게 최소 평가 수를 둡니다. */
const MIN_VOTES = 50;
/** discover 는 한 페이지에 20개를 줍니다. 이 정도면 뽑을 거리가 충분합니다. */
const MAX_PAGE = 20;

function discoverPath(kind, { genre, providers, page }) {
  const params = [
    'watch_region=KR',
    'language=ko-KR',
    'sort_by=popularity.desc',
    `vote_count.gte=${MIN_VOTES}`,
    'include_adult=false',
    `page=${page}`,
  ];
  // 여러 OTT 는 | 로 이으면 "이 중 아무거나" 가 됩니다.
  if (providers.length > 0) params.push(`with_watch_providers=${providers.join('|')}`);
  const g = genre?.[kind];
  if (g) params.push(`with_genres=${g}`);
  return `/discover/${kind}?${params.join('&')}`;
}

/** TMDB 응답 한 건을 우리가 쓰는 모양으로. 영화와 드라마의 필드 이름이 다릅니다. */
function toItem(raw, kind) {
  return {
    id: `${kind}-${raw.id}`,
    kind,
    title: raw.title ?? raw.name ?? '제목 없음',
    year: (raw.release_date ?? raw.first_air_date ?? '').slice(0, 4) || null,
    overview: raw.overview || null,
    rating: typeof raw.vote_average === 'number' ? raw.vote_average : null,
    votes: raw.vote_count ?? 0,
    poster: posterUrl(raw.poster_path),
  };
}

/**
 * 조건에 맞는 후보를 찾습니다. **영화와 드라마를 둘 다 찾아 섞습니다.**
 *
 * 캐시하지 않습니다 — "뽑을 때마다 다른 결과" 가 이 기능의 전부입니다.
 * 대신 무작위 페이지를 한 장씩만 가져와 호출을 아낍니다.
 */
export async function findCandidates({ genreKey = null, providers = [] } = {}) {
  const genre = genreByKey(genreKey);
  const kinds = ['movie', 'tv'].filter((k) => !genre || genre[k]);

  // 먼저 1페이지를 받아 전체가 몇 페이지인지 봅니다.
  const heads = await Promise.all(
    kinds.map((k) => call(discoverPath(k, { genre, providers, page: 1 })).catch(() => null))
  );

  const items = [];
  const extraFetches = [];
  for (const [i, head] of heads.entries()) {
    if (!head?.results?.length) continue;
    const kind = kinds[i];
    items.push(...head.results.map((r) => toItem(r, kind)));

    // 1페이지만 보면 인기순 상위 20개만 계속 나옵니다. 무작위로 한 페이지를 더 섞습니다.
    const pages = Math.min(head.total_pages ?? 1, MAX_PAGE);
    if (pages > 1) {
      const pick = 2 + Math.floor(Math.random() * (pages - 1));
      extraFetches.push(
        call(discoverPath(kind, { genre, providers, page: pick }))
          .then((j) => items.push(...(j.results ?? []).map((r) => toItem(r, kind))))
          .catch(() => {})
      );
    }
  }
  await Promise.all(extraFetches);

  // 같은 작품이 두 페이지에 걸쳐 나올 수 있습니다.
  const seen = new Set();
  return items.filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));
}
