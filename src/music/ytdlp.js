// yt-dlp 바이너리를 감싸는 얇은 래퍼입니다.
// - getTracks(): 링크나 검색어를 받아 재생할 곡 목록(제목/길이/URL)을 알아냅니다.
// - createStream(): 실제 오디오 데이터를 stdout으로 흘려보냅니다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../config.js';
import { userError } from '../user-error.js';

/**
 * yt-dlp 실행 파일.
 *
 * 기본은 `bin/` 에 내려받은 **공식 바이너리**입니다. 그런데 그건 PyInstaller 로 묶인
 * 파일이라 **실행할 때마다 파이썬 런타임을 통째로 풉니다.** 곡을 틀 때마다 그 비용이
 * 그대로 깔립니다 — 소유자 서버(1코어 ARM) 실측 **3.1~5.7초**, 집 PC 는 1.6초.
 *
 * pip 로 설치하면 푸는 과정이 없어 훨씬 빨리 뜹니다. 그때 그 경로를
 * `.env.music` 의 `YTDLP_PATH` 에 적으면 됩니다.
 * 봇이 켜질 때 기동 시간을 재서 로그에 찍으므로 **바꾼 효과가 바로 보입니다.**
 */
const YTDLP =
  (process.env.YTDLP_PATH ?? '').trim() ||
  path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

/** 어느 yt-dlp 를 쓰고 있는지. (켤 때 로그에 찍습니다) */
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
    ? `${path.dirname(custom)}/pip install -U yt-dlp`
    : 'npm run update-ytdlp';
}

// 유튜브가 데이터센터 IP를 막을 때 쓰는 우회 옵션들입니다.
// yt-dlp 는 **노래하는 망고만** 돌리므로, 이 값들의 제자리는 `.env.music` 입니다.
// (.env 에 적어도 상속되어 동작은 합니다)
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

/**
 * 서명(n challenge)을 못 풀었을 때 유튜브가 뱉는 말.
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
  // JS 런타임을 꺼둬서 나는 것이라면 다시 해도 소용없습니다. 빨리 실패하고 원인을 알립니다.
  if (looksLikeMissingJsRuntime(s)) return false;
  return TRANSIENT_PATTERNS.some((p) => s.includes(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 *   · 켤 때 잰 **기동 시간** (measureStartup) — 첫 곡부터 적용됩니다
 *   · 지금까지 **성공한 추출 중 가장 느렸던 것**
 * 둘 다 없으면 예전처럼 20초로 시작합니다.
 *
 * ⚠️ 성공 기록만으로는 부족합니다. 제한시간이 짧아서 한 번도 성공하지 못하면
 *    기록이 영영 안 쌓여 **스스로 못 빠져나옵니다.** 기동 시간으로 바닥을 깔아두는 이유입니다.
 */
const BASE_FIRST_MS = 20_000;
const MAX_FIRST_MS = 60_000;

let startupMs = null;      // 켤 때 잰 yt-dlp 기동 시간
let slowestOkMs = 0;       // 성공한 추출 중 가장 느렸던 것
let timedOutAtMs = 0;      // 시간을 초과해본 적 있는 제한시간 중 가장 큰 것

function noteSuccessDuration(ms) {
  if (ms > slowestOkMs) slowestOkMs = ms;
}

/**
 * 시간 초과 자체가 **"이 제한시간으로는 부족하다" 는 증거**입니다. 다음부터 두 배로 잡습니다.
 *
 * 기동 시간만으로 짐작하는 것보다 이쪽이 확실합니다. 실측에서 기동은 3.1~5.7초로
 * 들쭉날쭉했는데 추출은 12~25초였습니다. 재시작할 때 기동이 3.1초로 찍히면
 * 짐작값이 20초에 머물러 **또 잘립니다.** 한 번 잘리면 그걸 근거로 올립니다.
 */
function noteTimeout(ms) {
  if (ms > timedOutAtMs) timedOutAtMs = ms;
}

/**
 * 계산만 하는 순수 함수로 떼어뒀습니다. 이래야 느린 서버 값을 넣고 검사할 수 있습니다.
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
 * 추출은 **한 번에 하나만** 돌립니다.
 *
 * 실측 (소유자 서버, 1코어):
 * ```
 * 미리 뽑기 실패 (73.2초) · Barcelona Nights: yt-dlp 가 40초 안에 응답하지 않았습니다
 * 미리 뽑기 실패 (62.9초) · Sins:             yt-dlp 가 40초 안에 응답하지 않았습니다
 * ```
 * 미리 뽑기 **두 개가 동시에** 돌아가면서 서로를 굶겼습니다. 혼자면 12초쯤 걸리는 일이
 * 60~73초가 되고, 제한시간을 40초로 늘려도 여전히 잘립니다. 봇 전체가 멈춘 것처럼
 * 보이기도 했습니다("Unknown interaction" — 버튼에 3초 안에 답하지 못함).
 *
 * 코어가 하나뿐인 서버에서는 **동시에 돌리는 것이 언제나 손해**입니다.
 * 둘을 나란히 20초씩 쓰느니, 하나를 12초에 끝내고 다음을 12초에 끝내는 편이
 * 첫 곡도 빠르고 전체도 빠릅니다.
 *
 * ⚠️ 이 줄 세우기를 없애지 마세요. 병렬로 돌리면 빨라 보이지만 실측은 반대입니다.
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
  return serializeExtraction(() => runSerialized(args, opts));
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
        // "The page needs to be reloaded" 를 뱉기도 합니다 — 겉보기만 일시적입니다.
        // 그래서 "잠시 뒤 다시" 라고만 안내하면 원인을 영원히 못 찾습니다.
        // 타임아웃과 차단은 원인이 완전히 달라서 안내도 달라야 합니다.
        // 예전에는 둘 다 "IP 차단일 수 있다" 로 안내해서 엉뚱한 곳을 뒤지게 만들었습니다.
        const timedOut = err.message.includes('타임아웃');
        err.message += timedOut
          ? `\n\n${attempts}번 시도했지만 모두 시간을 초과했습니다. **서버가 느린 것**이지 차단은 아닙니다.` +
            // ⚠️ 여기서 YTDLP_JS_RUNTIME=false 를 권하지 마세요. 실제로 권했다가
            //    **재생이 아예 안 됐습니다.** 기동은 빨라지지만 서명을 못 풀어
            //    "The page needs to be reloaded" 만 반복합니다. 되돌리는 값싼 조치가 아닙니다.
            '\n· 메모리 부족일 수 있습니다. 서버에서 `free -h` 로 swap 사용량을 확인하세요.' +
            '\n· 진단: 서버에서 `time ./bin/yt-dlp --version` — 5초를 넘으면 기동 자체가 느린 것입니다.'
          : `\n\n${attempts}번 다시 시도했지만 계속 실패했습니다. 일시적 문제가 아닐 수 있습니다.` +
            '\n· 클라우드 서버(Oracle·AWS 등)에서 돌리고 있다면 **유튜브가 그 서버 IP를 차단**한 것일 수 있습니다.' +
            '\n· `.env.music` 의 `YTDLP_COOKIES_FILE` 설정이 필요합니다. (README의 "유튜브가 막힐 때")' +
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
  // ⚠️ `Sign in to confirm …` 은 **두 가지**입니다. 나이 쪽을 먼저 걸러야 합니다.
  //      Sign in to confirm your age         → 그 영상 하나의 문제 (연령 제한)
  //      Sign in to confirm you're not a bot → 서버 전체의 문제 (IP 차단)
  //    예전에는 둘 다 "봇으로 판단해 차단" 이라고 답했습니다. 그래서 연령 제한 영상
  //    하나를 틀려다 실패한 사람이 멀쩡한 쿠키를 다시 뽑는 헛수고를 했습니다.
  //    ⚠️ 여기서 `age` 만으로 판별하지 말 것. `webpage` · `page` 에도 들어 있어서
  //       엉뚱한 오류가 연령 제한으로 오진됩니다. (위의 `bot` 과 같은 함정입니다)
  if (s.includes('confirm your age') || s.includes('age-restrict') || s.includes('age restrict')) {
    return (
      '연령 제한이 걸린 영상입니다. **이 영상 하나만의 문제**이니 다른 곡은 그대로 됩니다.\n' +
      '(성인 인증된 계정의 쿠키를 `.env.music` 의 YTDLP_COOKIES_FILE 에 넣으면 풀립니다)'
    );
  }
  if (s.includes('sign in to confirm')) {
    // 쿠키를 이미 넣어둔 상태에서 이 오류가 나면 "설정하세요" 는 틀린 안내입니다.
    // 그때는 만료된 것이므로 **다시 뽑으라고** 해야 합니다.
    const hasCookies = (process.env.YTDLP_COOKIES_FILE ?? '').trim() !== '';
    return hasCookies
      ? '유튜브가 이 서버를 봇으로 판단해 차단했습니다.\n' +
          '쿠키는 설정되어 있으니 **만료된 것으로 보입니다.** 새로 뽑아서 교체해주세요.\n' +
          '(시크릿 창에서 로그인 → 영상 재생 → 쿠키 저장 → **로그아웃하지 말고** 창 닫기)'
      : '유튜브가 이 서버를 봇으로 판단해 차단했습니다. `.env.music` 의 YTDLP_COOKIES_FILE 설정이 필요합니다. (README의 "유튜브가 막힐 때" 항목 참고)';
  }
  // n challenge(서명 계산)는 자바스크립트 런타임이 있어야 풀립니다.
  // 이게 실패하면 곧바로 "The page needs to be reloaded" 가 뒤따라 나오므로
  // **차단보다 먼저** 검사해야 원인을 제대로 짚습니다.
  //
  // ⚠️ 같은 말이라도 **JS 런타임을 꺼뒀는지**에 따라 원인이 완전히 다릅니다.
  //    꺼뒀으면 그게 원인입니다 — "잠시 뒤 다시" 라고 안내하면 영원히 못 고칩니다.
  //    (실제로 겪었습니다: 속도를 줄여보려고 껐다가 재생이 아예 안 됐습니다)
  if (looksLikeMissingJsRuntime(s)) {
    return (
      '유튜브 서명 계산에 실패했습니다. **`.env.music` 의 `YTDLP_JS_RUNTIME=false` 가 원인입니다.**\n' +
      '그 줄을 지우고 재시작해주세요. (지우면 기동이 조금 느려지는 대신 재생이 됩니다)\n' +
      '`sed -i \'/^YTDLP_JS_RUNTIME=false/d\' .env.music && sudo systemctl restart music-sarangbang-bot`'
    );
  }
  if (s.includes('n challenge solving failed') || s.includes('javascript runtime')) {
    return (
      '유튜브 서명 계산에 필요한 자바스크립트 런타임이 없습니다.\n' +
      '`.env.music` 에 `YTDLP_JS_RUNTIME=false` 가 있다면 지우거나 `true` 로 바꾸고 재시작해주세요.'
    );
  }
  if (s.includes('the page needs to be reloaded')) {
    return `유튜브가 일시적으로 요청을 거부했습니다. 잠시 뒤 다시 시도해보세요. (계속 그러면 \`${updateHint()}\`)`;
  }
  // ⚠️ 유튜브는 **서로 다른 이유**를 전부 "Video unavailable" 한마디로 뭉뚱그립니다.
  //    예전에는 이걸 다 "비공개이거나 삭제됨" 이라고 답했습니다. 지역 차단이나
  //    멤버십 전용 영상을 만난 사람은 지운 적도 없는 영상을 지웠다는 말을 들은 셈입니다.
  //    **구분되는 것만 구분하고, 모르겠으면 유튜브가 한 말을 그대로 보여줍니다.**
  if (s.includes('private video')) {
    return '비공개 영상입니다. 링크가 있어도 초대받은 계정만 볼 수 있어서 봇도 못 봅니다.';
  }
  if (s.includes('video unavailable') || s.includes('this video is not available')) {
    if (s.includes('in your country') || s.includes('not made this video available')) {
      return (
        '이 영상은 **서버가 있는 지역에서 막혀 있습니다.** 내 컴퓨터에서 보인다고 서버에서도 보이지는 않습니다.\n' +
        '`.env.music` 의 YTDLP_PROXY 에 볼 수 있는 지역의 프록시를 넣으면 풀립니다.'
      );
    }
    if (s.includes("channel's members") || s.includes('members-only') || s.includes('members only')) {
      return '채널 멤버십 전용 영상입니다. 멤버십이 있는 계정의 쿠키가 아니면 봇은 못 봅니다.';
    }
    if (s.includes('removed by the uploader') || s.includes('has been terminated') || s.includes('no longer available')) {
      return '올린 사람이 지웠거나 채널이 사라진 영상입니다.';
    }
    // 여기까지 안 걸리면 **이유를 모릅니다.** 추측해서 답하면 엉뚱한 곳을 뒤지게 됩니다.
    return `유튜브가 이 영상을 "볼 수 없다" 고만 답했습니다. 아래가 유튜브가 한 말 그대로입니다.\n\`${rawError(stderr)}\``;
  }
  if (s.includes('unsupported url')) {
    return '지원하지 않는 링크입니다.';
  }
  if (s.includes('cookies') && (s.includes('unable to open') || s.includes('no such file'))) {
    return '`.env.music` 의 YTDLP_COOKIES_FILE 경로에 파일이 없습니다. 경로를 확인해주세요. (`.env` 에 적어두셨다면 그쪽입니다 — 음악 봇은 두 파일을 다 읽습니다)';
  }
  return rawError(stderr);
}

/**
 * yt-dlp 가 실제로 뱉은 오류 한 줄. **우리가 이유를 모를 때 이걸 그대로 보여줍니다.**
 *
 * `ERROR: [youtube] dQw4w9WgXcQ:` 같은 앞머리는 사람에게 아무 뜻이 없어서 떼어냅니다.
 * 너무 길면 디스코드 메시지를 잡아먹으므로 잘라냅니다.
 */
export function rawError(stderr) {
  const line = String(stderr ?? '')
    .split('\n')
    .find((l) => l.includes('ERROR'));
  if (!line) return '';
  const cleaned = line.trim().replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]{6,}:\s*)?/, '');
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}

const URL_RE = /^https?:\/\//i;

// 오디오만 있는 포맷을 하나만 고릅니다.
// 하나만 고르는 게 중요합니다 — 여러 개가 뽑히면 아래 --print 의 줄 수가 어긋납니다.
const AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio/best';

// 재생 주소는 시간이 지나면 만료됩니다. 이 시간이 지나면 다시 추출합니다.
const STREAM_URL_TTL_MS = 90 * 60 * 1000; // 90분

/**
 * 재생목록 하나에서 담을 최대 곡 수.
 * 수백 곡짜리 목록이 흔해서(실측 183곡) 상한이 없으면 대기열이 감당이 안 됩니다.
 */
const PLAYLIST_MAX = Math.max(1, Number(process.env.MUSIC_PLAYLIST_MAX ?? 50) || 50);

/** 목록 사본을 주면서 "원래 몇 곡이었는지"(totalFound)를 같이 넘깁니다. */
function withTotal(list) {
  const copy = list.map((t) => ({ ...t }));
  copy.totalFound = list.totalFound ?? list.length;
  return copy;
}

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

/**
 * 재생목록 링크인가.
 *
 * ⚠️ `list=` 가 붙었다고 전부 재생목록으로 보면 안 됩니다.
 *    유튜브는 자동재생·믹스로 넘어가면 링크에 `list=RD...` 를 **알아서 붙입니다.**
 *    그 링크를 공유한 사람은 **그 곡 하나**를 보낸 것이지 목록을 보낸 게 아닙니다.
 *    이걸 목록으로 처리하면 노래 하나 공유했는데 수십 곡이 쏟아집니다.
 *
 *    RD = 믹스/라디오 (유튜브가 자동으로 만든 것 — 사람이 공유한 목록이 아닙니다)
 *    LL = 좋아요, WL = 나중에 볼 동영상 (개인 목록이라 어차피 못 가져옵니다)
 *
 *    반대로 아래는 **진짜 재생목록**이므로 그대로 둡니다.
 *    PL = 사람이 만든 목록, UU = 채널 업로드 전체, OLAK5uy_ = 앨범(자동이지만 의도가 분명함)
 */
export function playlistIdOf(url) {
  const id = String(url).match(/[?&]list=([A-Za-z0-9_-]+)/)?.[1];
  if (!id) return null;
  if (/^(RD|LL|WL)/.test(id)) return null;
  return id;
}

export async function getTracks(input) {
  const isUrl = URL_RE.test(input);
  const target = isUrl ? input : `ytsearch1:${input}`;
  const isPlaylist = isUrl && playlistIdOf(input) !== null;

  const cached = cacheGet(target);
  if (cached) {
    // 캐시본을 그대로 주면 호출한 쪽에서 streamUrl 을 덮어쓸 때 서로 간섭합니다.
    return withTotal(cached);
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

    // 재생목록은 수백 곡짜리가 흔합니다(실측: 183곡짜리 목록 확인).
    // 그대로 담으면 대기열이 감당이 안 되고, 되돌리려면 전부 지워야 합니다.
    // 앞에서부터 잘라 담고, **몇 곡 중 몇 곡인지 알려줍니다.**
    const capped = list.slice(0, PLAYLIST_MAX);
    capped.totalFound = list.length; // 잘렸는지 알리려고 붙여둡니다
    cacheSet(target, capped);
    return withTotal(capped);
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
  if (!line) throw userError('영상 정보를 읽지 못했습니다. 링크를 다시 확인해주세요.');

  const p = line.split(SEP).map((s) => s.trim());
  const na = (v) => (!v || v === 'NA' ? null : v);
  const isHttp = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

  const url = na(p[4]);
  if (!isHttp(url)) throw userError('영상 주소를 읽지 못했습니다. 링크를 다시 확인해주세요.');

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

/**
 * yt-dlp 를 **켜는 데만** 얼마나 걸리는지 재서 알려줍니다. (켤 때 한 번)
 *
 * 왜 재나: yt-dlp 는 PyInstaller 번들이라 실행할 때마다 파이썬 런타임을 풉니다.
 * 이 비용은 **곡을 틀 때마다 그대로 깔립니다.** 집 PC 에서는 1.6초인데 느린 서버에서는
 * 훨씬 클 수 있고, 그러면 "왜 느린가" 의 답이 여기서 끝납니다.
 * 매번 서버에 들어가 `time ./bin/yt-dlp --version` 을 치게 하는 대신 봇이 알려줍니다.
 */
export function measureStartup() {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(YTDLP, ['--version'], { stdio: 'ignore', windowsHide: true });
    const done = (ok) => {
      // 이 값으로 첫 시도의 제한시간 바닥을 깝니다. (timeoutLadder 참고)
      if (ok) startupMs = Date.now() - t0;
      resolve(ok ? (Date.now() - t0) / 1000 : null);
    };
    child.once('error', () => done(false));
    child.once('close', (code) => done(code === 0));
  });
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
 * 직접 수신(0단계)이 이 서버에서 되는가.
 *
 * **쿠키를 쓰는 서버에서는 거의 항상 실패합니다.** 쿠키로 뽑은 재생 주소를
 * ffmpeg 이 쿠키 없이 그냥 받으면 유튜브가 거부하기 때문입니다.
 * 그런데 실패해도 곡은 나옵니다 — 아래 단계로 다시 시도하니까요.
 * 그래서 **문제를 눈치채기 어려운 채로 곡마다 헛걸음을 합니다.**
 *
 * 두 번 연속 실패하면 이번 실행 동안은 0단계를 아예 쓰지 않습니다.
 * (1단계부터 시작하므로 재생 자체는 계속 됩니다)
 */
let directFailures = 0;
let directDisabled = false;

export function noteDirectFailure(reason) {
  if (directDisabled) return;
  if (++directFailures < 2) return;
  directDisabled = true;
  console.warn(
    '[music] 직접 수신(0단계)이 계속 실패해서 이번 실행 동안은 쓰지 않습니다.\n' +
      '        이제 곡마다 1단계(뽑아둔 주소를 yt-dlp 가 받기)부터 시작합니다.\n' +
      '        헛걸음이 사라져 재생이 빨라집니다. (재생 자체는 계속 됩니다)\n' +
      '        쿠키를 쓰는 서버에서 흔한 일입니다. 영구히 끄려면\n' +
      '        .env.music 에 MUSIC_DIRECT_STREAM=false 를 넣으세요.' +
      (reason ? `\n        마지막 오류: ${reason}` : '')
  );
}

/** 직접 수신이 실제로 성공했으면 실패 기록을 지웁니다. (일시적 실패였을 수 있으므로) */
export function noteDirectSuccess() {
  directFailures = 0;
}

/**
 * 오디오 원본을 준비하는 **세 단계**. 위에서부터 빠르고, 실패하면 한 칸 내려갑니다.
 *
 *   0 직접 — 뽑아둔 주소를 **ffmpeg 이 직접** 받습니다. yt-dlp 를 아예 안 씁니다. (가장 빠름)
 *   1 주소 — 뽑아둔 주소를 **yt-dlp 가** 받습니다. 유튜브 추출을 건너뛰므로
 *            **쿠키·프록시를 그대로 쓰면서** 추출 한 번(수 초)을 아낍니다.
 *   2 추출 — 유튜브에서 처음부터 다시 뽑습니다. 가장 느리지만 가장 확실합니다.
 *
 * ⚠️ **1단계를 지우지 마세요.** 예전에는 0 아니면 2 뿐이었습니다.
 *    쿠키를 쓰는 서버는 0 단계가 거의 항상 거부되므로(직접 수신 실패) 곧바로 2 로 떨어졌고,
 *    그러면 **한 곡에 유튜브 추출을 두 번**(목록 담을 때 + 틀 때) 하게 됩니다.
 *    1 단계는 그 두 번째 추출을 없앱니다. (실측: 파이프 경로 3.2초 → 1.4초)
 */
export const SRC_DIRECT = 0;
export const SRC_URL = 1;
export const SRC_EXTRACT = 2;

/** 이 곡을 실제로 어느 단계로 틀 수 있는지. (원하는 단계가 불가능하면 내려갑니다) */
export function sourceLevel(track, wanted = SRC_DIRECT) {
  // .env 로 직접 수신을 아예 끌 수 있습니다.
  // 서버 환경에 따라 재생 주소가 거부될 수 있어, 문제가 생기면 이걸로 즉시 되돌립니다.
  const allowDirect = (process.env.MUSIC_DIRECT_STREAM ?? 'true').toLowerCase() !== 'false';

  let level = Math.max(SRC_DIRECT, Math.min(SRC_EXTRACT, wanted));
  if (level === SRC_DIRECT && (!allowDirect || directDisabled)) level = SRC_URL;
  // 뽑아둔 주소가 없거나 만료됐으면 0·1 단계를 쓸 수 없습니다.
  if (level <= SRC_URL && !hasFreshStreamUrl(track)) level = SRC_EXTRACT;
  return level;
}

export function createSource(track, { level = SRC_DIRECT } = {}) {
  const lv = sourceLevel(track, level);

  if (lv === SRC_DIRECT) {
    return { input: track.streamUrl, remote: true, level: lv, kill: () => {} };
  }
  const stream =
    lv === SRC_URL
      ? createStream(track.streamUrl, { extract: false })
      : createStream(track.url);
  return { input: stream, remote: false, level: lv, kill: () => stream.destroy?.() };
}

/**
 * yt-dlp 로 오디오를 stdout 스트림으로 뽑아냅니다.
 *
 * @param {string} url 유튜브 주소(extract: true) 또는 이미 뽑아둔 재생 주소(extract: false)
 * @param {{extract?: boolean}} [opts]
 *   extract: false 면 **추출하지 않고 그 주소를 그대로 받아옵니다.**
 *   그때는 `-f` 를 넘기지 않습니다 — 재생 주소에는 고를 포맷이 하나뿐이라,
 *   `bestaudio[acodec=opus]` 같은 조건을 걸면 도리어 못 찾고 실패합니다.
 */
export function createStream(url, { extract = true } = {}) {
  const args = [];
  if (extract) args.push('-f', AUDIO_FORMAT, '--no-playlist');
  args.push(
    '--no-warnings',
    '--ignore-config',
    // 라이브/긴 영상에서 끊김을 줄이는 옵션
    '--buffer-size', '16K',
    ...extraArgs(),
    '-o', '-',
    url
  );

  const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

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
