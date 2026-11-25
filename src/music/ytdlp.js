// yt-dlp 바이너리를 감싸는 얇은 래퍼입니다.
// - getTracks(): 링크나 검색어를 받아 재생할 곡 목록(제목/길이/URL)을 알아냅니다.
// - createStream(): 실제 오디오 데이터를 stdout으로 흘려보냅니다.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';
import { ROOT, config } from '../config.js';
import { userError } from '../user-error.js';

/**
 * yt-dlp 에게 알려줄 ffmpeg 경로. `--download-sections` 가 ffmpeg 을 필요로 합니다.
 *
 * ⚠️ **묶음 ffmpeg(ffmpeg-static)이 죽는 서버가 있습니다.** 소유자 서버(1코어 ARM)에서
 *    클립을 뽑을 때 `ffmpeg exited with code -11` 이 났습니다. -11 은 SIGSEGV —
 *    정상 종료가 아니라 **죽은 것**입니다. 음악(오디오 변환)은 같은 바이너리로 잘 돌기 때문에
 *    바이너리 자체가 아니라 그 코드 경로(HTTPS 구간 받기)의 문제로 보이지만,
 *    **원인은 확정하지 못했습니다.** 그래서 원인을 짐작하는 대신 **다른 ffmpeg 으로 넘어갑니다.**
 *
 * 후보 순서: `FFMPEG_PATH` (있으면 이것만) → 묶음 ffmpeg → 서버에 깔린 ffmpeg
 */
function ffmpegCandidates() {
  const custom = (process.env.FFMPEG_PATH ?? '').trim();
  if (custom) return [custom];
  return [ffmpegPath, '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'].filter(Boolean);
}

let ffmpegIndex = 0;

/** 지금 쓰는 ffmpeg. */
export function ffmpegInUse() {
  return ffmpegCandidates()[ffmpegIndex] ?? ffmpegCandidates()[0];
}

/**
 * ffmpeg 이 죽었을 때 **다음 후보로 넘깁니다.**
 * @returns {string|null} 넘어간 경로. 더 남은 후보가 없으면 null.
 */
export function nextFfmpeg() {
  const list = ffmpegCandidates();
  if (ffmpegIndex + 1 >= list.length) return null;
  ffmpegIndex++;
  console.warn(`[music] ffmpeg 을 바꿉니다 → ${ffmpegInUse()} (앞의 것이 죽었습니다)`);
  return ffmpegInUse();
}

/** @internal 검증용. */
export function resetFfmpegChoice() {
  ffmpegIndex = 0;
}

/**
 * 켜 때 한 번 `-version` 을 돌려 **쓸 수 있는 ffmpeg** 을 고릅니다.
 *
 * 이걸 안 하면 "클립을 눌렀는데 안 된다" 로만 알게 됩니다. 켜 때 알면 미리 고칠 수 있습니다.
 * ⚠️ `-version` 이 통해도 실제 구간 받기에서 죽을 수 있습니다 (실제로 그랬습니다).
 *    그래서 이 검사만으로 끝이 아니고 `nextFfmpeg()` 로 넘기는 길도 함께 둡니다.
 */
export async function pickFfmpeg() {
  const list = ffmpegCandidates();
  for (let i = 0; i < list.length; i++) {
    const okRun = await new Promise((resolve) => {
      const child = spawn(list[i], ['-version'], { stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(code === 0));
    });
    if (okRun) {
      ffmpegIndex = i;
      return list[i];
    }
  }
  return null;
}

/**
 * yt-dlp 실행 파일.
 *
 * 기본은 `bin/` 에 내려받은 **공식 바이너리**입니다. 그런데 그건 PyInstaller 로 묶인
 * 파일이라 **실행할 때마다 파이썬 런타임을 통째로 풍니다.** 곡을 틀 때마다 그 비용이
 * 그대로 깔립니다 — 소유자 서버(1코어 ARM) 실측 **3.1~5.7초**, 집 PC 는 1.6초.
 *
 * pip 로 설치하면 푸는 과정이 없어 훨씬 빠리 뜹니다. 그때 그 경로를
 * `.env.music` 의 `YTDLP_PATH` 에 적으면 됩니다.
 * 봇이 켜질 때 기동 시간을 재서 로그에 찍으므로 **바꾼 효과가 바로 보입니다.**
 */
const YTDLP =
  (process.env.YTDLP_PATH ?? '').trim() ||
  path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

/** 어느 yt-dlp 를 쓰고 있는지. (켜 때 로그에 찍습니다) */
export function ytdlpPath() {
  return YTDLP;
}

/**
 * "yt-dlp 를 새로 받으세요" 를 **지금 쓰는 방식에 맞게** 안내합니다.
 *
 * pip 로 깔아놓고 `npm run update-ytdlp` 를 하면 봇이 쓰지도 않는 `bin/` 만 갱신됩니다.
 * 그러면 "시키는 대로 했는데 안 고쳐진다" 가 됩니다.
 */
export function updateHint() {
  const custom = (process.env.YTDLP_PATH ?? '').trim();
  return custom
    ? `${path.dirname(custom)}/pip install -U "yt-dlp[default]"`
    : 'npm run update-ytdlp';
}

// 유튜브가 데이터센터 IP를 막을 때 쓰는 우회 옵션들입니다.
// yt-dlp 는 **노래하는 망고만** 돌리므로, 이 값들의 제자리는 `.env.music` 입니다.
// (.env 에 적어도 상속되어 동작은 합니다)
/**
 * yt-dlp 캐시를 **우리가 정한 곳**에 둡니다.
 *
 * yt-dlp 는 유튜브 플레이어 JS(서명 계산에 쓰는 것)를 캐시해둡니다. 그게 남아 있으면
 * 다음 추출부터 그만큼 빠라집니다. 기본 위치는 `~/.cache/yt-dlp` 인데,
 * **systemd 로 돌리면 `HOME` 이 없거나 다른 곳을 가리키기 쉽습니다.**
 * 그러면 캐시가 매번 날아가서 곡마다 플레이어 JS 를 다시 받고 다시 파싱합니다.
 *
 * 경로를 직접 지정해 그 문제를 아예 없앱니다. `data/` 밑이라 git 에도 안 올라갑니다.
 */
const CACHE_DIR = path.join(config.dataDir, 'yt-dlp-cache');

const POT_EXTRACTOR_ARGS = 'youtube:player_client=mweb';

/** PO Token 공급자를 쓸지. 설치 전에는 기존 동작을 그대로 유지합니다. */
export function potProviderEnabled() {
  return (process.env.YTDLP_POT_PROVIDER ?? 'false').toLowerCase() === 'true';
}

function cookiesFile() {
  return (process.env.YTDLP_COOKIES_FILE ?? '').trim();
}

/**
 * 공급자를 켜면 공개 영상은 로그인 쿠키 없이 먼저 요청합니다.
 * 계정이 필요한 영상 또는 공급자 장애만 아래 run()에서 기존 쿠키로 한 번 더 시도합니다.
 */
export function extraArgs({ includeCookies = !potProviderEnabled(), includePot = potProviderEnabled() } = {}) {
  const args = ['--cache-dir', CACHE_DIR];

  // yt-dlp 는 유튜브 추출에 자바스크립트 런타임이 필요합니다.
  // 없으면 "No supported JavaScript runtime could be found" 경고가 뜨고
  // 일부 포맷을 못 가져옵니다. 기본으로 찾는 건 deno 뿐인데 보통 안 깔려 있습니다.
  //
  // 이 봇은 Node 로 돌아가므로 process.execPath 가 항상 유효한 node 경로입니다.
  // 그걸 그대로 넘겨주면 어느 OS에서도 추가 설치 없이 해결됩니다.
  if ((process.env.YTDLP_JS_RUNTIME ?? 'true').toLowerCase() !== 'false') {
    args.push('--js-runtimes', `node:${process.execPath}`);
  }

  if (includePot) args.push('--extractor-args', POT_EXTRACTOR_ARGS);

  const cookies = cookiesFile();
  if (includeCookies && cookies) args.push('--cookies', cookies);
  const proxy = (process.env.YTDLP_PROXY ?? '').trim();
  if (proxy) args.push('--proxy', proxy);
  const raw = (process.env.YTDLP_EXTRA_ARGS ?? '').trim();
  if (raw) args.push(...raw.split(/\s+/));
  return args;
}

/** 계정 인증이 필요하거나 PO Token 공급자가 고장난 경우에만 쿠키 예비 경로를 쓵니다. */
export function needsCookieFallback(error) {
  const s = `${error?.stderr ?? ''}\n${error?.message ?? ''}`.toLowerCase();
  return [
    'sign in',
    'login_required',
    'confirm your age',
    'age-restrict',
    'members-only',
    'members only',
    'private video',
    'youtubepot',
    'bgutil',
    'po token',
    'po_token',
    '127.0.0.1:4416',
    'connection refused',
    'http error 403',
    'forbidden',
  ].some((p) => s.includes(p));
}

/** mweb+공급자 옵션을 빼고 기존 yt-dlp 클라이언트+쿠키 조합으로 되돌립니다. */
export function cookieFallbackArgs(args, cookieFile = cookiesFile()) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--extractor-args' && args[i + 1] === POT_EXTRACTOR_ARGS) {
      i++;
      continue;
    }
    result.push(args[i]);
  }
  if (cookieFile && !result.includes('--cookies')) result.push('--cookies', cookieFile);
  return result;
}

/**
 * 유튜브가 간헐적으로 벚는, 다시 하면 되는 오류들.
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

/**
 * 서명(n challenge)을 못 풀었을 때 유튜브가 벚는 말.
 *
 * ⚠️ 이건 **JS 런타임을 꺼두면 반드시** 납니다. 그때는 다시 해봐야 똑같습니다.
 *    "일시적" 으로 분류해 재시도하면 곡마다 40~60초를 버리고도 결국 실패합니다.
 *    (실제로 겪었습니다: YTDLP_JS_RUNTIME=false 를 넣자 재생이 아예 안 됐습니다)
 */
const NEEDS_JS_PATTERNS = ['the page needs to be reloaded', 'n challenge solving failed', 'javascript runtime'];

function looksLikeMissingJsRuntime(s) {
  return !jsRuntimeEnabled() && NEEDS_JS_PATTERNS.some((p) => s.includes(p));
}

export function isTransient(text) {
  const s = String(text).toLowerCase();
  // JS 런타임을 꺼둬서 나는 것이라면 다시 해도 소용없습니다. 빠리 실패하고 원인을 알립니다.
  if (looksLikeMissingJsRuntime(s)) return false;
  return TRANSIENT_PATTERNS.some((p) => s.includes(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 로그에 찍은 명령을 **그대로 복사해 붙여넣을 수 있게** 따옴표를 씀웁니다. */
export function quoteArgForLog(a) {
  return quoteArg(a);
}

function quoteArg(a) {
  return /[\s|'\"$`\\*?()[\]{}<>&;]/.test(a) ? `'${String(a).replace(/'/g, `'\\''`)}'` : a;
}

function runOnce(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(YTDLP, args, { windowsHide: true });
    let out = '';
    let err = '';
    let done = false;

    const fail = (message, transient = false) => {
      if (done) return;
      done = true;
      const e = new Error(message);
      e.transient = transient;
      // ⚠️ **원문을 버리지 마세요.** 예전에 첫 줄만 남겨서, ffmpeg 이 왜 죽었는지
      //    알려주는 줄이 그대로 사라졌습니다 (`ffmpeg exited with code 183` 만 남음).
      //    부르는 쪽이 필요하면 원문에서 진짜 원인을 찾을 수 있어야 합니다.
      e.stderr = err;
      // 원인을 이미 한국어로 적어둔 오류입니다. 로그에 스택까지 찍을 필요가 없습니다.
      // (index.js 의 logError 참고)
      e.expected = true;
      reject(e);
    };

    const timer = setTimeout(() => {
      child.kill();
      // 다음부터는 이 제한시간을 근거로 더 넉넉히 잡습니다. (noteTimeout 참고)
      noteTimeout(timeoutMs);
      fail(`yt-dlp 가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다 (타임아웃).`, true);
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) =>
      fail(`yt-dlp 실행 실패: ${e.message}\n(\`${updateHint()}\` 로 다시 받아보세요)`)
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      if (done) return;
      if (code === 0) {
        done = true;
        noteSuccessDuration(Date.now() - startedAt);
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
/**
 * 첫 시도의 제한시간은 **서버 속도에 맞춰 정합니다.**
 *
 * 왜 고정값이면 안 되는가 (실제로 겪은 일):
 * 예전에는 첫 시도가 무조건 20초였습니다. 그런데 소유자 서버는 yt-dlp **기동만 5.7초**이고
 * 추출까지 20초쯤 걸립니다. 그러면 첫 시도가 **매번** 20초에 잘리고, 1초 쉬었다가
 * 다시 20초를 써서 한 번 뽑는 데 40초가 넘습니다. 곡 전환이 느렸던 이유가 여기 있습니다.
 * 게다가 그렇게 느리면 미리 뽑기도 제때 못 끝내서, 다음 곡이 또 가장 느린 길로 갑니다.
 *
 * 그래서 두 가지를 근거로 잡습니다.
 *   · 켜 때 재 **기동 시간** (measureStartup) — 첫 곡부터 적용됩니다
 *   · 지금까지 **성공한 추출 중 가장 느렸던 것**
 * 둘 다 없으면 예전처럼 20초로 시작합니다.
 *
 * ⚠️ 성공 기록만으로는 부족합니다. 제한시간이 짧아서 한 번도 성공하지 못하면
 *    기록이 영영 안 쌓여 **스스로 못 빠져나옵니다.** 기동 시간으로 바닥을 깔아두는 이유입니다.
 */
const BASE_FIRST_MS = 20_000;
const MAX_FIRST_MS = 60_000;

let startupMs = null;      // 켜 때 재 yt-dlp 기동 시간
let slowestOkMs = 0;       // 성공한 추출 중 가장 느렸던 것
let timedOutAtMs = 0;      // 시간을 초과해본 적 있는 제한시간 중 가장 큰 것

function noteSuccessDuration(ms) {
  if (ms > slowestOkMs) slowestOkMs = ms;
}

/**
 * 시간 초과 자체가 **"이 제한시간으로는 부족하다" 는 증거**입니다. 다음부터 두 배로 잡습니다.
 *
 * 기동 시간만으로 짐작하는 것보다 이쪽이 확실합니다. 실측에서 기동은 3.1~5.7초로
 * 들쫍날쫍했는데 추출은 12~25초였습니다. 재시작할 때 기동이 3.1초로 찍히면
 * 짐작값이 20초에 머물러 **또 잘립니다.** 한 번 잘리면 그걸 근거로 올립니다.
 */
function noteTimeout(ms) {
  if (ms > timedOutAtMs) timedOutAtMs = ms;
}

/**
 * 계산만 하는 순수 함수로 떼어둠습니다. 이래야 느린 서버 값을 넣고 검사할 수 있습니다.
 * (verify 가 기동 5.7초짜리 서버를 흉내 내 확인합니다)
 */
/**
 * 기동 시간 대비 추출 시간의 배수. **실측으로 정했습니다.**
 * 소유자 서버: 기동 3.1~5.7초, 추출 12~25초 → 4~8배.
 * 5배로 잡았더니 기동이 3.1초로 찍힌 재시작에서 15.5초가 나와 **또 잘렸습니다.**
 */
const STARTUP_TO_EXTRACT = 8;

export function timeoutsFor(startup = null, slowestOk = 0, timedOutAt = 0) {
  const first = Math.min(
    MAX_FIRST_MS,
    Math.max(BASE_FIRST_MS, startup ? startup * STARTUP_TO_EXTRACT : 0, slowestOk * 2, timedOutAt * 2)
  );
  // 두 번째는 넉넉히. 단계를 셋으로 늘리지 마세요 — 정말 멈춘 경우에 너무 오래 붙잡습니다.
  return [first, Math.min(120_000, first * 2)];
}

export function timeoutLadder() {
  return timeoutsFor(startupMs, slowestOkMs, timedOutAtMs);
}

/**
 * 추출은 **한 번에 하나만** 돕립니다.
 *
 * 실측 (소유자 서버, 1코어):
 * ```
 * 미리 뽑기 실패 (73.2초) · Barcelona Nights: yt-dlp 가 40초 안에 응답하지 않았습니다
 * 미리 뽑기 실패 (62.9초) · Sins:             yt-dlp 가 40초 안에 응답하지 않았습니다
 * ```
 * 미리 뽑기 **두 개가 동시에** 돌아가면서 서로를 깃길습니다. 혼자면 12초쯤 걸리는 일이
 * 60~73초가 되고, 제한시간을 40초로 늘려도 여전히 잘립니다. 봇 전체가 멈춘 것처럼
 * 보이기도 했습니다("Unknown interaction" — 버튼에 3초 안에 답하지 못함).
 *
 * 코어가 하나뿐인 서버에서는 **동시에 돌리는 것이 언제나 손해**입니다.
 * 둘을 나란히 20초씩 쓰느니, 하나를 12초에 끝내고 다음을 12초에 끝내는 편이
 * 첫 곡도 빠르고 전체도 빠릅니다.
 *
 * ⚠️ 이 줄 세우기를 없애지 마세요. 병렬로 돌리면 빠라 보이지만 실측은 반대입니다.
 * ⚠️ 재생용 스트림(createStream)은 여기 넣지 않습니다. 곡이 끝날 때까지 살아 있어서
 *    넣으면 미리 뽑기가 영영 차례를 못 받습니다.
 */
let extractChain = Promise.resolve();

function serializeExtraction(fn) {
  const next = extractChain.then(fn, fn);
  extractChain = next.catch(() => {});
  return next;
}

async function run(args, opts = {}) {
  return serializeExtraction(async () => {
    try {
      return await runSerialized(args, opts);
    } catch (err) {
      const cookie = cookiesFile();
      if (!potProviderEnabled() || !cookie || !needsCookieFallback(err)) throw err;

      console.warn(
        '[yt-dlp] PO Token 공개 경로가 실패해 기존 쿠키로 한 번 더 시도합니다.\n' +
          `         이유: ${String(err.message ?? err).split('\n')[0]}`
      );
      return runSerialized(cookieFallbackArgs(args, cookie), opts);
    }
  });
}

async function runSerialized(args, { timeouts = timeoutLadder() } = {}) {
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
        // "The page needs to be reloaded" 를 벚기도 합니다 — 겉보기만 일시적입니다.
        // 그래서 "잠시 뒤 다시" 라고만 안내하면 원인을 영원히 못 찾습니다.
        // 타임아웃과 차단은 원인이 완전히 달라서 안내도 달라야 합니다.
        // 예전에는 둘 다 "IP 차단일 수 있습니다" 라고 답했습니다.
        const hint = isTransient(err.message) || isTransient(err.stderr || '')
          ? ' \n(\uc77c시적인 문제일 수 있습니다. 잠시 뒤 다시 시도해보세요)'
          : '';
        throw new Error(err.message + hint);
      }
      await sleep(1000);
    }
  }
  throw lastErr;
}

/**
 * 유튜브 라이브 영상의 기본 정보를 가져옵니다. (id, 시작 시각, live_status, 제목)
 *
 * 종료된 라이브(Post-Live Manifestless) 에서 formats 가 없어도 메타데이터는 받기 위해
 * `--ignore-no-formats-error` 를 붙입니다.
 */
export async function liveInfo(url) {
  const out = await run(
    [
      '--print',
      '%(id)s\t%(release_timestamp)s\t%(live_status)s\t%(title)s',
      '--no-warnings',
      '--ignore-config',
      '--no-playlist',
      '--ignore-no-formats-error', // 종료된 라이브(Post-Live)에서 formats 없어도 메타데이터 추출
      ...extraArgs(),
      url,
    ],
    { timeouts: [15_000, 30_000] } // 종료 직후 영상은 조금 더 걸릴 수 있음
  );

  const [id, ts, status, ...rest] = String(out).trim().split('\n')[0].split('\t');
  const n = Number(ts);
  return {
    videoId: id && id !== 'NA' ? id : '',
    // yt-dlp 는 값이 없으면 문자열 'NA' 를 찍습니다. Number('NA') 는 NaN 입니다.
    startedAt: Number.isFinite(n) && n > 0 ? n : null,
    liveStatus: status === 'NA' ? '' : (status ?? ''),
    title: rest.join('\t').trim(),
  };
}

/**
 * 영상의 **한 구간만** 잘라 파일로 내려받습니다. (방송 기록의 클립 추출)
 *
 * ★ **재인코딩을 하지 않습니다.** `--force-keyframes-at-cuts` 를 붙이지 마세요.
 *   yt-dlp 도움말이 직접 말합니다: "This is slow due to needing a re-encode".
 *   1코어 서버에서 몇 분씩 걸립니다. 대신 키프레임 경계에서 잘려 ±2~3초 오차가 나는데,
 *   40초 클립에서는 감수할 만합니다.
 *
 * ★ **H.264(avc1)를 우선합니다.** 그냥 `height<=720` 만 주면 유튜브가 AV1 을 주는데
 *   (실측 확인), 브라우저·기기 호환이 떨어집니다. 화질을 낮추는 것도 재인코딩이 아니라
 *   **낮은 포맷을 골라 받는 것**이라 공짜입니다.
 *
 * ⚠️ `--ffmpeg-location` 을 반드시 넘깁니다. `--download-sections` 는 ffmpeg 이 필요한데,
 *    서버에 ffmpeg 이 깔려 있지 않을 수 있습니다. 이 프로젝트는 ffmpeg-static 을 쓵니다.
 *
 * ⚠️ 실측 (집 PC, 15초 구간): 약 14초 · 2.8MB · `Stream #0:0 -> #0:0 (copy)` 확인.
 *    1코어 서버는 더 걸리므로 제한시간을 넉넉히 줍니다.
 *
 * ⚠️ 이 호출은 `noteSuccessDuration` / `noteTimeout` 을 건드려 **공용 제한시간 사다리를
 *    늘립니다**(`timeoutLadder`). 지금은 망고의 모든 호출(`liveInfo`·`downloadSection`)이
 *    제한시간을 직접 넘기므로 문제가 없습니다. 망고에서 yt-dlp 를 새로 부를 때는
 *    **반드시 `timeouts` 를 함께 넘기세요.**
 *
 * ⚠️ 음성만 녹화된 방송도 있습니다. 그때는 `audioOnly` 로 다시 부르면 **소리만** 잘라옵니다
 *    (실측: 15초 구간 → 3.7초 · 244KB · `.m4a` · copy). 영상보다 훨씬 싸고 빠릅니다.
 *
 * @param {string} url 영상 주소
 * @param {{startSec:number, endSec:number, outPath:string, maxHeight?:number, audioOnly?:boolean}} opts
 *   `outPath` 는 **확장자 없는** 경로입니다. yt-dlp 가 알맞은 확장자를 붙입니다
 *   (영상이면 `.mp4`, 소리만이면 `.m4a`). 그래서 부르는 쪽은 **결과 파일을 찾아야** 합니다.
 * @returns {Promise<string>} yt-dlp 가 남긴 출력 (진단용)
 */
export function downloadSection(url, { startSec, endSec, outPath, maxHeight = 720, audioOnly = false }) {
  const h = Math.max(240, Math.round(maxHeight));

  // ⚠️ **영상을 받을 때 맨 뒤에 `/b`(무엇이든) 를 붙이지 마세요.**
  //    화면 없이 음성만 녹화된 방송에서 `b` 는 **오디오 포맷에 걸립니다.**
  //    그러면 소리만 든 파일을 "영상 클립" 이라고 조용히 내줍니다 — 사람은 뭘 받았는지 모릅니다.
  //    영상을 반드시 요구하면 yt-dlp 가 `Requested format is not available` 로 답하고,
  //    그때 부르는 쪽이 **소리만으로 다시** 시도합니다 (clips.js 의 makeClip).
  const format = audioOnly
    ? 'ba[ext=m4a]/ba/b[acodec!=none]'
    : `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/` +
      `b[height<=${h}][vcodec^=avc1]/` +
      `bv*[height<=${h}]+ba/` +
      `b[height<=${h}]/` +
      // 화질 상한을 못 맞추더라도 **영상은 있어야** 합니다.
      `bv*+ba/b[vcodec!=none]`;

  const args = [
    '--no-warnings',
    '--no-progress',
    '--ignore-config',
    '--no-playlist',
    '--ffmpeg-location',
    ffmpegInUse(),
    '--download-sections',
    `*${Math.max(0, Math.floor(startSec))}-${Math.floor(endSec)}`,
    '-f',
    format,
  ];
  // ⚠️ 소리만 받을 때 `--merge-output-format mp4` 를 주면 **소리를 mp4 로 감싸** 버립니다.
  //    브라우저가 영상처럼 열려다 검은 화면을 보여줍니다. `.m4a` 로 두는 것이 맞습니다.
  if (!audioOnly) args.push('--merge-output-format', 'mp4');

  args.push('--force-overwrites', '-o', `${outPath}.%(ext)s`, ...extraArgs(), url);

  return run(args, { timeouts: [180_000, 300_000] });
}

/** 캐시가 실제로 쌓였는지. 안 쌓이면 곡마다 플레이어 JS 를 다시 받습니다. */
export function cacheDir() {
  return CACHE_DIR;
}

/** JS 런타임 지정을 끌 수 있게 합니다. 느린 서버에서 기동 비용을 줄일 때. */
export function jsRuntimeEnabled() {
  return (process.env.YTDLP_JS_RUNTIME ?? 'true').toLowerCase() !== 'false';
}

/** 저장된 재생 주소를 아직 써도 되는지. */
export function hasFreshStreamUrl(track) {
  if (!track?.streamUrl || Date.now() - (track.extractedAt ?? 0) >= STREAM_URL_TTL_MS) return false;

  // %(urls)s가 항상 완성 파일 하나를 뜻하지는 않습니다. HLS/DASH와 여러 조각 형식의 주소를
  // 완성 파일처럼 다시 열면 첫 조각만 잠깐 재생된 뒤 정상 종료할 수 있습니다.
  const protocol = String(track.streamProtocol || '').toLowerCase();
  if (protocol.includes('m3u8') || protocol.includes('dash') || protocol.includes('http')) {
    // 이 경우는 새로 추출하는 편이 안전합니다.
    return false;
  }
  return true;
}

/** 재생 주소 유효 기간. (yt-dlp 가 주는 주소는 일정 시간 후 만료) */
const STREAM_URL_TTL_MS = 5 * 60 * 1000;

/**
 * 곡 목록을 가져옵니다. 링크면 그 영상의 정보, 검색어면 유튜브 검색 결과.
 */
export async function getTracks(query) {
  const isUrl = /^https?:\/\//i.test(query);
  const args = [
    '--print',
    '%(id)s\t%(title)s\t%(duration)s\t%(webpage_url)s\t%(thumbnail)s\t%(uploader)s',
    '--no-warnings',
    '--ignore-config',
    '--no-playlist',
    '--flat-playlist',
    ...extraArgs(),
  ];
  if (isUrl) {
    args.push(query);
  } else {
    args.push(`ytsearch5:${query}`);
  }

  const out = await run(args, { timeouts: [20_000, 40_000] });
  const lines = String(out).trim().split('\n').filter(Boolean);
  return lines.map((line) => {
    const [id, title, duration, webpage_url, thumbnail, uploader] = line.split('\t');
    return {
      id: id === 'NA' ? null : id,
      title: title === 'NA' ? '(제목 없음)' : title,
      duration: Number(duration) || 0,
      url: webpage_url === 'NA' ? null : webpage_url,
      thumbnail: thumbnail === 'NA' ? null : thumbnail,
      uploader: uploader === 'NA' ? null : uploader,
    };
  }).filter((t) => t.id);
}

/**
 * 실제 오디오 스트림을 만듭니다. (stdout으로 흘려보냄)
 */
export function createStream(url, { startSec = 0 } = {}) {
  const args = [
    '--no-warnings',
    '--no-progress',
    '--ignore-config',
    '--no-playlist',
    '-f',
    'ba[ext=m4a]/ba/b[acodec!=none]',
    '--ffmpeg-location',
    ffmpegInUse(),
    ...extraArgs(),
    url,
  ];
  if (startSec > 0) {
    args.splice(args.length - 1, 0, '--download-sections', `*${Math.floor(startSec)}-inf`);
  }

  const child = spawn(YTDLP, args, { windowsHide: true });
  const output = new PassThrough();
  let activeChild = child;
  let stopped = false;

  child.stdout.pipe(output);
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('ERROR') || s.includes('error')) {
      console.warn('[yt-dlp stream]', s.trim());
    }
  });
  child.on('error', (e) => output.destroy(e));
  child.on('close', (code) => {
    if (!stopped && code !== 0) {
      output.destroy(new Error(`yt-dlp stream exited with code ${code}`));
    }
  });

  output.once('close', () => {
    stopped = true;
    if (activeChild && !activeChild.killed) activeChild.kill();
  });
  return output;
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
