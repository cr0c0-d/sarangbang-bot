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
  const cookies = (process.env.YTDLP_COOKIES_FILE ?? '').trim();
  if (cookies) args.push('--cookies', cookies);
  const proxy = (process.env.YTDLP_PROXY ?? '').trim();
  if (proxy) args.push('--proxy', proxy);
  const raw = (process.env.YTDLP_EXTRA_ARGS ?? '').trim();
  if (raw) args.push(...raw.split(/\s+/));
  return args;
}

function run(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('yt-dlp 응답이 너무 오래 걸립니다 (타임아웃).'));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) =>
      reject(new Error(`yt-dlp 실행 실패: ${e.message}\n(npm run update-ytdlp 로 다시 받아보세요)`))
    );
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(friendlyError(err) || `yt-dlp 오류 (코드 ${code})`));
    });
  });
}

function friendlyError(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes("sign in to confirm") || s.includes('bot')) {
    return '유튜브가 이 서버를 봇으로 판단해 차단했습니다. .env 의 YTDLP_COOKIES_FILE 설정이 필요합니다. (README의 "유튜브 차단" 항목 참고)';
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
  const line = stderr.split('\n').find((l) => l.includes('ERROR'));
  return line ? line.trim() : '';
}

const URL_RE = /^https?:\/\//i;

/**
 * 링크 또는 검색어 → 재생 목록.
 * 재생목록 링크면 안에 있는 곡을 전부 담아옵니다.
 */
export async function getTracks(input) {
  const isUrl = URL_RE.test(input);
  const target = isUrl ? input : `ytsearch1:${input}`;
  const isPlaylist = isUrl && /[?&]list=/.test(input);

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--ignore-config',
    ...(isPlaylist ? ['--flat-playlist'] : ['--no-playlist']),
    ...extraArgs(),
    target,
  ];

  const json = JSON.parse(await run(args));

  const toTrack = (e) => ({
    title: e.title ?? '제목 없음',
    url: e.webpage_url ?? e.url ?? (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
    duration: typeof e.duration === 'number' ? e.duration : null,
    uploader: e.uploader ?? e.channel ?? null,
    thumbnail: e.thumbnail ?? null,
  });

  if (Array.isArray(json.entries)) {
    return json.entries.filter(Boolean).map(toTrack).filter((t) => t.url);
  }
  const t = toTrack(json);
  return t.url ? [t] : [];
}

/**
 * 곡 하나의 오디오를 stdout 스트림으로 뽑아냅니다.
 * 반환된 stream 은 그대로 createAudioResource 에 넣으면 됩니다.
 */
export function createStream(url) {
  const child = spawn(
    YTDLP,
    [
      '-f', 'bestaudio[acodec=opus]/bestaudio/best',
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
