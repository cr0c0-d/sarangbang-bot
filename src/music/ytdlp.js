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
 */
function ffmpegCandidates() {
  const custom = (process.env.FFMPEG_PATH ?? '').trim();
  if (custom) return [custom];
  return [ffmpegPath, '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'].filter(Boolean);
}

let ffmpegIndex = 0;

export function ffmpegInUse() {
  return ffmpegCandidates()[ffmpegIndex] ?? ffmpegCandidates()[0];
}

export function nextFfmpeg() {
  const list = ffmpegCandidates();
  if (ffmpegIndex + 1 >= list.length) return null;
  ffmpegIndex++;
  console.warn(`[music] ffmpeg 을 바꿉니다 → ${ffmpegInUse()} (앞의 것이 죽었습니다)`);
  return ffmpegInUse();
}

export function resetFfmpegChoice() {
  ffmpegIndex = 0;
}

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

const YTDLP =
  (process.env.YTDLP_PATH ?? '').trim() ||
  path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

export function ytdlpPath() {
  return YTDLP;
}

export function updateHint() {
  const custom = (process.env.YTDLP_PATH ?? '').trim();
  return custom
    ? `${path.dirname(custom)}/pip install -U "yt-dlp[default]"`
    : 'npm run update-ytdlp';
}

const CACHE_DIR = path.join(config.dataDir, 'yt-dlp-cache');

const POT_EXTRACTOR_ARGS = 'youtube:player_client=mweb';

export function potProviderEnabled() {
  return (process.env.YTDLP_POT_PROVIDER ?? 'false').toLowerCase() === 'true';
}

function cookiesFile() {
  return (process.env.YTDLP_COOKIES_FILE ?? '').trim();
}

export function extraArgs({ includeCookies = !potProviderEnabled(), includePot = potProviderEnabled() } = {}) {
  const args = ['--cache-dir', CACHE_DIR];
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

export function needsCookieFallback(error) {
  const s = `${error?.stderr ?? ''}\n${error?.message ?? ''}`.toLowerCase();
  return [
    'sign in', 'login_required', 'confirm your age', 'age-restrict',
    'members-only', 'members only', 'private video', 'youtubepot',
    'bgutil', 'po token', 'po_token', '127.0.0.1:4416',
    'connection refused', 'http error 403', 'forbidden',
  ].some((p) => s.includes(p));
}

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

const TRANSIENT_PATTERNS = [
  'the page needs to be reloaded', 'temporarily unavailable',
  'unable to download webpage', 'unable to download api page',
  'failed to extract', 'read timed out', 'connection reset',
  'connection aborted', '타임아웃', 'http error 5',
];

const NEEDS_JS_PATTERNS = ['the page needs to be reloaded', 'n challenge solving failed', 'javascript runtime'];

function looksLikeMissingJsRuntime(s) {
  return !jsRuntimeEnabled() && NEEDS_JS_PATTERNS.some((p) => s.includes(p));
}

export function isTransient(text) {
  const s = String(text).toLowerCase();
  if (looksLikeMissingJsRuntime(s)) return false;
  return TRANSIENT_PATTERNS.some((p) => s.includes(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      e.stderr = err;
      e.expected = true;
      reject(e);
    };
    const timer = setTimeout(() => {
      child.kill();
      noteTimeout(timeoutMs);
      fail(`yt-dlp 가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다 (타임아웃).`, true);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => fail(`yt-dlp 실행 실패: ${e.message}\n(\`${updateHint()}\` 로 다시 받아보세요)`));
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

const BASE_FIRST_MS = 20_000;
const MAX_FIRST_MS = 60_000;
let startupMs = null;
let slowestOkMs = 0;
let timedOutAtMs = 0;
function noteSuccessDuration(ms) { if (ms > slowestOkMs) slowestOkMs = ms; }
function noteTimeout(ms) { if (ms > timedOutAtMs) timedOutAtMs = ms; }
const STARTUP_TO_EXTRACT = 8;
export function timeoutsFor(startup = null, slowestOk = 0, timedOutAt = 0) {
  const first = Math.min(MAX_FIRST_MS, Math.max(BASE_FIRST_MS, startup ? startup * STARTUP_TO_EXTRACT : 0, slowestOk * 2, timedOutAt * 2));
  return [first, Math.min(120_000, first * 2)];
}
export function timeoutLadder() { return timeoutsFor(startupMs, slowestOkMs, timedOutAtMs); }
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
      console.warn('[yt-dlp] PO Token 공개 경로가 실패해 기존 쿠키로 한 번 더 시도합니다.');
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
      if (i === attempts) throw err;
      await sleep(1000);
    }
  }
  throw lastErr;
}

export async function liveInfo(url) {
  const out = await run(
    [
      '--print',
      '%(id)s\t%(release_timestamp)s\t%(live_status)s\t%(title)s',
      '--no-warnings',
      '--ignore-config',
      '--no-playlist',
      '--ignore-no-formats-error',
      ...extraArgs(),
      url,
    ],
    { timeouts: [15_000, 30_000] }
  );
  const [id, ts, status, ...rest] = String(out).trim().split('\n')[0].split('\t');
  const n = Number(ts);
  return {
    videoId: id && id !== 'NA' ? id : '',
    startedAt: Number.isFinite(n) && n > 0 ? n : null,
    liveStatus: status === 'NA' ? '' : (status ?? ''),
    title: rest.join('\t').trim(),
  };
}

export function downloadSection(url, { startSec, endSec, outPath, maxHeight = 720, audioOnly = false }) {
  const h = Math.max(240, Math.round(maxHeight));
  const format = audioOnly
    ? 'ba[ext=m4a]/ba/b[acodec!=none]'
    : `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}][vcodec^=avc1]/bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b[vcodec!=none]`;
  const args = [
    '--no-warnings', '--no-progress', '--ignore-config', '--no-playlist',
    '--ffmpeg-location', ffmpegInUse(),
    '--download-sections', `*${Math.max(0, Math.floor(startSec))}-${Math.floor(endSec)}`,
    '-f', format,
  ];
  if (!audioOnly) args.push('--merge-output-format', 'mp4');
  args.push('--force-overwrites', '-o', `${outPath}.%(ext)s`, ...extraArgs(), url);
  return run(args, { timeouts: [180_000, 300_000] });
}

export function cacheDir() { return CACHE_DIR; }
export function jsRuntimeEnabled() { return (process.env.YTDLP_JS_RUNTIME ?? 'true').toLowerCase() !== 'false'; }
const STREAM_URL_TTL_MS = 5 * 60 * 1000;
export function hasFreshStreamUrl(track) {
  if (!track?.streamUrl || Date.now() - (track.extractedAt ?? 0) >= STREAM_URL_TTL_MS) return false;
  const protocol = String(track.streamProtocol || '').toLowerCase();
  if (protocol.includes('m3u8') || protocol.includes('dash') || protocol.includes('http')) return false;
  return true;
}
export async function getTracks(query) {
  const isUrl = /^https?:\/\//i.test(query);
  const args = [
    '--print', '%(id)s\t%(title)s\t%(duration)s\t%(webpage_url)s\t%(thumbnail)s\t%(uploader)s',
    '--no-warnings', '--ignore-config', '--no-playlist', '--flat-playlist', ...extraArgs(),
  ];
  if (isUrl) args.push(query); else args.push(`ytsearch5:${query}`);
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
export function createStream(url, { startSec = 0 } = {}) {
  const args = [
    '--no-warnings', '--no-progress', '--ignore-config', '--no-playlist',
    '-f', 'ba[ext=m4a]/ba/b[acodec!=none]',
    '--ffmpeg-location', ffmpegInUse(), ...extraArgs(), url,
  ];
  if (startSec > 0) args.splice(args.length - 1, 0, '--download-sections', `*${Math.floor(startSec)}-inf`);
  const child = spawn(YTDLP, args, { windowsHide: true });
  const output = new PassThrough();
  let activeChild = child;
  let stopped = false;
  child.stdout.pipe(output);
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('ERROR') || s.includes('error')) console.warn('[yt-dlp stream]', s.trim());
  });
  child.on('error', (e) => output.destroy(e));
  child.on('close', (code) => {
    if (!stopped && code !== 0) output.destroy(new Error(`yt-dlp stream exited with code ${code}`));
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
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
