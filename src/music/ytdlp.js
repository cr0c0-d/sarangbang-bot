// yt-dlp 바이너리를 감싸는 얇은 래퍼입니다.
// - getTracks(): 링크나 검색어를 받아 재생할 곡 목록(제목/길이/URL)을 알아냅니다.
// - createStream(): 실제 오디오 데이터를 stdout으로 흘려보냅니다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../config.js';

const YTDLP = path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// 유튜브가 데이터센터 IP를 막을 때 쓰는 우회 옵션들입니다. (.env 로 설정)
function extraArgs() {
  const args = [];

  // yt-dlp 는 유튜브 추출에 자바스크립트 런타임이 필요합니다.
  // 없으면 "No supported JavaScript runtime could be found" 경고가 뜨고
  // 일부 포맷을 못 가져옵니다. 기본으로 찾는 건 deno 뿐인데 보통 안 깔려 있습니다.
  //
  // 이 봇은 Node 로 돌아가므로 process.execPath 가 항상 유효한 node 경로입니다.
  // 그걸 그대로 넘겨주면 어느 OS에서도 추가 설치 없이 해결됩니다.
  if ((process.env.YTDLP_JS_RUNTIME ?? 'true').toLowerCase() !== 'false') {
    args.push('--js-runtimes', `node:${process.execPath}`);
  }

  const cookies = (process.env.YTDLP_COOKIES_FILE ?? '').trim();
  if (cookies) args.push('--cookies', cookies);
  const proxy = (process.env.YTDLP_PROXY ?? '').trim();
  if (proxy) args.push('--proxy', proxy);
  const raw = (process.env.YTDLP_EXTRA_ARGS ?? '').trim();
  if (raw) args.push(...raw.split(/\s+/));
  return args;
}

/**
 * 유튜브가 간헐적으로 뱉는, 다시 하면 되는 오류들.
 *
 * 대표 사례: "The page needs to be reloaded."
 *   yt-dlp 자체 재시도(--extractor-retries, 기본 3회)로는 안 잡힙니다.
 *   프로세스를 새로 띄워 웹페이지와 player JSON을 다시 받아야 풀립니다.
 *   그래서 여기서 프로세스 단위로 재시도합니다. (실측: 재시도하면 정상 동작)
 */
const TRANSIENT_PATTERNS = [
  'the page needs to be reloaded',
  'temporarily unavailable',
  'unable to download webpage',
  'unable to download api page',
  'failed to extract',
  'read timed out',
  'connection reset',
  'connection aborted',
  '타임아웃',
  'http error 5', // 500, 502, 503...
];

export function isTransient(text) {
  const s = String(text).toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => s.includes(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runOnce(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    let out = '';
    let err = '';
    let done = false;

    const fail = (message, transient = false) => {
      if (done) return;
      done = true;
      const e = new Error(message);
      e.transient = transient;
      reject(e);
    };

    const timer = setTimeout(() => {
      child.kill();
      fail(`yt-dlp 가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다 (타임아웃).`, true);
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) =>
      fail(`yt-dlp 실행 실패: ${e.message}\n(npm run update-ytdlp 로 다시 받아보세요)`)
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      if (done) return;
      if (code === 0) {
        done = true;
        resolve(out);
      } else {
        fail(friendlyError(err) || `yt-dlp 오류 (코드 ${code})`, isTransient(err));
      }
    });
  });
}

/**
 * yt-dlp 를 실행합니다. 시도마다 제한시간을 **늘려가며** 재시도합니다.
 *
 * 왜 같은 시간으로 3번 하면 안 되는가:
 * 서버가 느려서 30초가 걸리는 상황이라면, 25초 제한으로 세 번 해봐야 세 번 다 실패하고
 * 75초를 버립니다. 실제로 그런 일이 있었습니다.
 * 첫 시도는 짧게 끊어 빠른 실패를 잡고, 그다음은 넉넉히 줘서 느린 서버도 성공하게 합니다.
 */
const TIMEOUT_LADDER = [20_000, 60_000];

async function run(args, { timeouts = TIMEOUT_LADDER } = {}) {
  const attempts = timeouts.length;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    const timeoutMs = timeouts[i - 1];
    try {
      return await runOnce(args, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (!err.transient) throw err;
      if (i === attempts) {
        // 재시도를 다 써도 안 되면 "일시적"이 아니었던 것입니다.
        // 실제 사례: 클라우드 서버에서 IP가 차단되면 유튜브가
        // "The page needs to be reloaded" 를 뱉기도 합니다 — 겉보기만 일시적입니다.
        // 그래서 "잠시 뒤 다시" 라고만 안내하면 원인을 영원히 못 찾습니다.
        // 타임아웃과 차단은 원인이 완전히 달라서 안내도 달라야 합니다.
        // 예전에는 둘 다 "IP 차단일 수 있다" 로 안내해서 엉뚱한 곳을 뒤지게 만들었습니다.
        const timedOut = err.message.includes('타임아웃');
        err.message += timedOut
          ? `\n\n${attempts}번 시도했지만 모두 시간을 초과했습니다. **서버가 느린 것**이지 차단은 아닙니다.` +
            '\n· `.env` 에 `YTDLP_JS_RUNTIME=false` 를 넣고 재시작해보세요. (가장 효과 큼)' +
            '\n· 메모리 부족일 수 있습니다. 서버에서 `free -h` 로 swap 사용량을 확인하세요.' +
            '\n· 진단: 서버에서 `time ./bin/yt-dlp --version` — 5초를 넘으면 기동 자체가 느린 것입니다.'
          : `\n\n${attempts}번 다시 시도했지만 계속 실패했습니다. 일시적 문제가 아닐 수 있습니다.` +
            '\n· 클라우드 서버(Oracle·AWS 등)에서 돌리고 있다면 **유튜브가 그 서버 IP를 차단**한 것일 수 있습니다.' +
            '\n· `.env` 의 `YTDLP_COOKIES_FILE` 설정이 필요합니다. (README의 "유튜브가 막힐 때")' +
            '\n· 진단: 서버에서 `./bin/yt-dlp --simulate -v <링크>` 를 실행해 `LOGIN_REQUIRED` 가 있는지 보세요.';
        throw err;
      }
      console.warn(
        `[music] 재시도 ${i}/${attempts - 1} (다음 제한시간 ${timeouts[i] / 1000}초): ${err.message}`
      );
      await sleep(1000);
    }
  }
  throw lastErr;
}

/**
 * yt-dlp 의 영어 오류 메시지를 한국어 + "다음에 뭘 할지" 로 바꿉니다.
 * verify.mjs 가 이 함수를 직접 검사하므로 export 합니다.
 */
export function friendlyError(stderr) {
  const s = String(stderr).toLowerCase();

  // ⚠️ 여기서 'bot' 같은 짧은 단어로 판별하지 말 것.
  //    프로젝트 폴더 이름(sarangbang-bot)에 'bot' 이 들어 있어서,
  //    경로가 찍힌 아무 오류나 "유튜브 차단" 으로 오진됩니다.
  //    (실제로 그런 버그가 있었습니다. verify.mjs 에 회귀 검사가 있습니다)
  if (s.includes('sign in to confirm')) {
    return '유튜브가 이 서버를 봇으로 판단해 차단했습니다. .env 의 YTDLP_COOKIES_FILE 설정이 필요합니다. (README의 "유튜브가 막힐 때" 항목 참고)';
  }
  if (s.includes('the page needs to be reloaded')) {
    return '유튜브가 일시적으로 요청을 거부했습니다. 잠시 뒤 다시 시도해보세요. (계속 그러면 `npm run update-ytdlp`)';
  }
  if (s.includes('video unavailable') || s.includes('private video')) {
    return '재생할 수 없는 영상입니다 (비공개이거나 삭제됨).';
  }
  if (s.includes('age') && s.includes('restrict')) {
    return '연령 제한 영상이라 쿠키 없이는 재생할 수 없습니다.';
  }
  if (s.includes('unsupported url')) {
    return '지원하지 않는 링크입니다.';
  }
  if (s.includes('cookies') && (s.includes('unable to open') || s.includes('no such file'))) {
    return '.env 의 YTDLP_COOKIES_FILE 경로에 파일이 없습니다. 경로를 확인해주세요.';
  }
  const line = stderr.split('\n').find((l) => l.includes('ERROR'));
  return line ? line.trim() : '';
}

const URL_RE = /^https?:\/\//i;

// 오디오만 있는 포맷을 하나만 고릅니다.
// 하나만 고르는 게 중요합니다 — 여러 개가 뽑히면 아래 --print 의 줄 수가 어긋납니다.
const AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio/best';

// 재생 주소는 시간이 지나면 만료됩니다. 이 시간이 지나면 다시 추출합니다.
const STREAM_URL_TTL_MS = 90 * 60 * 1000; // 90분

/**
 * 링크 또는 검색어 → 재생 목록.
 * 재생목록 링크면 안에 있는 곡을 전부 담아옵니다.
 *
 * ⚡ 속도: 한 번의 추출로 제목과 재생 주소를 같이 받아옵니다. (3.1-2 절)
 */

/**
 * 최근에 뽑아본 결과를 잠깐 들고 있습니다.
 *
 * 같은 곡을 다시 트는 일이 잦은데(반복재생, 친구가 같은 링크를 또 붙여넣기),
 * 그때마다 2.8초를 다시 기다릴 이유가 없습니다.
 * 재생 주소 유효기간(90분)보다 짧게 잡아, 캐시가 살아있으면 주소도 살아있게 합니다.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.tracks;
}

function cacheSet(key, tracks) {
  cache.set(key, { at: Date.now(), tracks });
  // 무한정 쌓이지 않게 오래된 것부터 버립니다.
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

export async function getTracks(input) {
  const isUrl = URL_RE.test(input);
  const target = isUrl ? input : `ytsearch1:${input}`;
  const isPlaylist = isUrl && /[?&]list=/.test(input);

  const cached = cacheGet(target);
  if (cached) {
    // 캐시본을 그대로 주면 호출한 쪽에서 streamUrl 을 덮어쓸 때 서로 간섭합니다.
    return cached.map((t) => ({ ...t }));
  }

  // 재생목록은 곡이 수십 개일 수 있어 주소를 전부 뽑으면 오히려 느립니다.
  // 목록만 가볍게 가져오고, 재생 주소는 각 곡을 틀 때 그때 뽑습니다.
  if (isPlaylist) {
    const json = JSON.parse(
      await run(['--dump-single-json', '--no-warnings', '--ignore-config', '--flat-playlist', ...extraArgs(), target])
    );
    const entries = Array.isArray(json.entries) ? json.entries.filter(Boolean) : [];
    const list = entries
      .map((e) => ({
        title: e.title ?? '제목 없음',
        url: e.webpage_url ?? e.url ?? (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
        duration: typeof e.duration === 'number' ? e.duration : null,
        uploader: e.uploader ?? e.channel ?? null,
        thumbnail: e.thumbnail ?? null,
        streamUrl: null,
        extractedAt: 0,
      }))
      .filter((t) => t.url);
    cacheSet(target, list);
    return list.map((t) => ({ ...t }));
  }

  // 단일 영상 / 검색: --print 로 필요한 값만 받습니다.
  //
  // ⚠️ 항목을 **한 줄에 구분자로** 붙여서 받습니다. 예전에는 항목당 한 줄씩 받았는데,
  //    출력에 줄이 하나라도 더 끼면 순서가 통째로 밀려서 엉뚱한 값이 재생 주소로 들어갔습니다.
  //    (그러면 재생이 즉시 실패하고 "재생 중인 곡 없음" 으로 돌아갑니다)
  const SEP = '|::|';
  const template = ['%(title)s', '%(duration)s', '%(thumbnail)s', '%(uploader)s', '%(webpage_url)s', '%(urls)s'].join(SEP);

  const out = await run([
    '-f', AUDIO_FORMAT,
    '--no-warnings',
    '--ignore-config',
    '--no-playlist',
    '--print', template,
    ...extraArgs(),
    target,
  ]);

  const line = out.split('\n').find((l) => l.includes(SEP));
  if (!line) throw new Error('영상 정보를 읽지 못했습니다. 링크를 다시 확인해주세요.');

  const p = line.split(SEP).map((s) => s.trim());
  const na = (v) => (!v || v === 'NA' ? null : v);
  const isHttp = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

  const url = na(p[4]);
  if (!isHttp(url)) throw new Error('영상 주소를 읽지 못했습니다. 링크를 다시 확인해주세요.');

  // 재생 주소가 http 로 시작하지 않으면 믿지 않습니다.
  // null 이면 재생할 때 yt-dlp 로 다시 뽑습니다 (느리지만 확실).
  const streamUrl = isHttp(na(p[5])) ? na(p[5]).split(/\s+/)[0] : null;

  const result = [
    {
      title: na(p[0]) ?? '제목 없음',
      duration: Number.isFinite(Number(p[1])) ? Number(p[1]) : null,
      thumbnail: isHttp(na(p[2])) ? na(p[2]) : null,
      uploader: na(p[3]),
      url,
      streamUrl,
      extractedAt: Date.now(),
    },
  ];
  cacheSet(target, result);
  return result.map((t) => ({ ...t }));
}

/** JS 런타임 지정을 끌 수 있게 합니다. 느린 서버에서 기동 비용을 줄일 때. */
export function jsRuntimeEnabled() {
  return (process.env.YTDLP_JS_RUNTIME ?? 'true').toLowerCase() !== 'false';
}

/** 저장된 재생 주소를 아직 써도 되는지. */
export function hasFreshStreamUrl(track) {
  return Boolean(track?.streamUrl) && Date.now() - (track.extractedAt ?? 0) < STREAM_URL_TTL_MS;
}

/**
 * 곡 하나의 오디오 원본을 준비합니다.
 *
 * @param {object} track getTracks() 가 돌려준 곡 객체
 * @returns {{ input: import('node:stream').Readable | string, remote: boolean, kill: () => void }}
 *   input 이 문자열이면 ffmpeg 이 그 주소를 직접 받으면 됩니다 (yt-dlp 재추출 없음 = 빠름).
 *   Readable 이면 yt-dlp 가 흘려보내는 스트림입니다 (주소가 만료됐거나 없을 때).
 */
export function createSource(track, { forcePipe = false } = {}) {
  // .env 로 직접 수신을 아예 끌 수 있습니다.
  // 서버 환경에 따라 재생 주소가 거부될 수 있어, 문제가 생기면 이걸로 즉시 되돌립니다.
  const allowDirect = (process.env.MUSIC_DIRECT_STREAM ?? 'true').toLowerCase() !== 'false';

  if (!forcePipe && allowDirect && hasFreshStreamUrl(track)) {
    // 이미 뽑아둔 주소를 그대로 씁니다. 추출을 한 번 건너뛰므로 약 2.8초가 절약됩니다.
    return { input: track.streamUrl, remote: true, kill: () => {} };
  }
  const stream = createStream(track.url);
  return { input: stream, remote: false, kill: () => stream.destroy?.() };
}

/**
 * yt-dlp 로 오디오를 stdout 스트림으로 뽑아냅니다.
 * 재생 주소가 없거나 만료됐을 때만 씁니다 (재생목록에서 꺼낸 곡 등).
 */
export function createStream(url) {
  const child = spawn(
    YTDLP,
    [
      '-f', AUDIO_FORMAT,
      '--no-playlist',
      '--no-warnings',
      '--ignore-config',
      // 라이브/긴 영상에서 끊김을 줄이는 옵션
      '--buffer-size', '16K',
      ...extraArgs(),
      '-o', '-',
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });
  child.on('close', (code) => {
    if (code !== 0 && code !== null) {
      const msg = friendlyError(stderr);
      if (msg) console.error('[music] yt-dlp:', msg);
    }
  });

  // 스트림이 소비되지 않고 버려질 때 프로세스가 남지 않도록 정리 함수를 붙여둡니다.
  child.stdout.once('close', () => {
    if (!child.killed) child.kill();
  });

  return child.stdout;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '실시간';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
