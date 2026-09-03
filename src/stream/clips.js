// 방송 클립 파일 저장소.
//
// ⚠️ **`src/images/store.js` 를 고쳐서 쓰지 마세요.** 그 파일은 이 저장소에서 가장 위험한
//    경로(사진 저장·삭제)를 다룹니다. 여기에 같은 안전장치를 따로 둡니다.
//
// ⚠️ 뿌리를 `data/` 가 아니라 **`data/clips/`** 에 둡니다. `data/` 에 두면
//    settings.json · streams.json · panels.json 이 상위 경로 한 칸 거리에 놓입니다.
//
// ── 용량에 대해 ──────────────────────────────────────────────
// 720p 는 초당 약 0.19MB 입니다 (실측: 15초 = 2.8MB). 그래서
//   · **길이 상한**(STREAM_CLIP_MAX_SEC)이 실질적인 용량 상한입니다.
//   · 개수 상한은 그 위에 얹는 것입니다. 개수만으로는 바이트를 못 막습니다.
// 디스크가 차면 사진 자동 정리(images/cleanup.js)가 **원인은 그대로 둔 채 사진을 지웁니다.**
// 클립이 사진을 잡아먹지 않게 하는 것이 여기 상한들의 목적입니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { userError } from '../user-error.js';
import { downloadSection, nextFfmpeg } from '../music/ytdlp.js';

const BASE = path.join(config.dataDir, 'clips');

/** 세션 id 는 무작위 소문자·숫자 6글자입니다. 이름을 다듬는 대신 **모양을 검사합니다.** */
const FOLDER_RE = /^[a-z0-9]{4,12}$/;

export function baseDir() {
  return BASE;
}

export async function initClips() {
  await fs.mkdir(BASE, { recursive: true });
  return BASE;
}

/** 폴더(=세션) 경로. 모양이 다르면 아예 거부합니다. */
export function folderPath(folder) {
  const name = String(folder ?? '');
  if (!FOLDER_RE.test(name)) throw userError('잘못된 클립 폴더 이름입니다.');
  const p = path.resolve(BASE, name);
  // 모양 검사를 통과했어도 한 번 더 확인합니다. 안전장치는 겹쳐 두는 것이 맞습니다.
  if (!p.startsWith(path.resolve(BASE) + path.sep)) throw userError('잘못된 클립 폴더 이름입니다.');
  return p;
}

/** 파일 이름에서 경로가 될 수 있는 글자를 없앱니다. */
export function safeClipName(name) {
  const cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'clip';
}

export function filePath(folder, file) {
  const dir = folderPath(folder);
  const p = path.resolve(dir, safeClipName(file));
  if (!p.startsWith(dir + path.sep)) throw userError('잘못된 클립 파일 이름입니다.');
  return p;
}

/**
 * 클립이 될 수 있는 확장자.
 *
 * ⚠️ **`.mp4` 만 보면 안 됩니다.** 음성만 녹화된 방송은 `.m4a` 로 나옵니다.
 *    그런데 아무 파일이나 받아도 안 됩니다 — 실패해서 남은 반쪽 파일(`.part`·`.ytdl`)이
 *    클립처럼 보이면 안 됩니다. 그래서 **아는 확장자만** 받습니다.
 */
export const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'mov'];
export const AUDIO_EXT = ['m4a', 'mp3', 'opus', 'aac', 'ogg'];
const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT];

const extOf = (name) => String(name).toLowerCase().split('.').pop();

/** 이 파일이 **소리만** 인가. 웹페이지가 `<audio>` 로 보여줄지 정하는 데 씁니다. */
export function isAudioClip(name) {
  return AUDIO_EXT.includes(extOf(name));
}

export function isMediaClip(name) {
  return MEDIA_EXT.includes(extOf(name));
}

/** 폴더 안의 클립 목록. 아는 확장자만, 새것부터. */
export async function listClips(folder) {
  const dir = folderPath(folder);
  const names = await fs.readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    if (!isMediaClip(name)) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, bytes: st.size, mtime: st.mtimeMs, audio: isAudioClip(name) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function listFolders() {
  const names = await fs.readdir(BASE).catch(() => []);
  const out = [];
  for (const name of names) {
    if (!FOLDER_RE.test(name)) continue;
    const files = await listClips(name);
    if (files.length === 0) continue;
    out.push({ name, count: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0) });
  }
  return out;
}

export async function deleteClip(folder, file) {
  const p = filePath(folder, file);
  return fs
    .unlink(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * 실패한 뒤에 남은 반쪽 파일들을 치웁니다. yt-dlp 는 `.part`·`.ytdl`·`.temp` 를 남깁니다.
 *
 * ⚠️ **확장자를 가정하지 않습니다.** 영상이면 `.mp4`, 소리만이면 `.m4a` 로 나오므로
 *    "`.mp4` 만 남기기" 로 짜면 **성공한 음성 클립을 지웁니다.**
 */
async function cleanLeftovers(folder, stem) {
  const dir = folderPath(folder);
  const names = await fs.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(`${stem}.`)) continue;
    if (isMediaClip(name)) continue; // 제대로 만들어진 것은 남깁니다
    await fs.unlink(path.join(dir, name)).catch(() => {});
  }
}

/** 방금 만들어진 결과 파일을 찾습니다. 확장자는 yt-dlp 가 정합니다. */
async function findProduced(folder, stem) {
  const dir = folderPath(folder);
  const names = await fs.readdir(dir).catch(() => []);
  const hit = names.find((n) => n.startsWith(`${stem}.`) && isMediaClip(n));
  if (!hit) return null;
  const st = await fs.stat(path.join(dir, hit)).catch(() => null);
  if (!st?.isFile() || st.size === 0) return null;
  return { file: hit, bytes: st.size, audio: isAudioClip(hit) };
}

/**
 * 예산(GB)을 넘었으면 오래된 클립부터 지웁니다.
 *
 * ⚠️ **사용자 데이터를 영구 삭제합니다.** `src/images/cleanup.js` 와 같은 안전장치를 둡니다
 *    (그 파일의 머리말이 이유를 자세히 적어뒀습니다 — ARCHITECTURE 3.6-5).
 *      1. 최근 것은 지우지 않습니다 (`STREAM_CLIP_MIN_KEEP_DAYS`).
 *         방금 만든 클립이 사라지면 사람이 뭘 잃었는지도 모릅니다.
 *      2. 예산의 80% 까지 내려갑니다. 경계선에서 매번 재실행되는 것을 막습니다.
 *      3. 지운 내용을 디스코드에 알립니다. 조용히 사라지면 안 됩니다. (부르는 쪽이 합니다)
 *
 * ⚠️ 예산을 **사진과 따로** 둡니다. 하나로 합치면 클립이 늘 때 사진이 지워집니다.
 *
 * @returns {Promise<{deleted: Array, freed: number, bytes: number, budget: number, blockedByAge: number}>}
 */
export async function cleanupByBudget() {
  const budget = config.stream.clipMaxGb * 1024 ** 3;
  const target = budget * (config.stream.clipCleanupTargetPercent / 100);
  const keepAfter = Date.now() - config.stream.clipMinKeepDays * 86400_000;

  const folders = await listFolders();
  const all = [];
  for (const f of folders) {
    for (const c of await listClips(f.name)) all.push({ folder: f.name, ...c });
  }
  let bytes = all.reduce((a, c) => a + c.bytes, 0);
  if (bytes <= budget) return { deleted: [], freed: 0, bytes, budget, blockedByAge: 0 };

  // 오래된 것부터 (mtime 오름차순)
  all.sort((a, b) => a.mtime - b.mtime);

  const deleted = [];
  let freed = 0;
  let blockedByAge = 0;
  for (const c of all) {
    if (bytes - freed <= target) break;
    // 안전장치 1: 최근 것은 건드리지 않습니다.
    if (c.mtime > keepAfter) {
      blockedByAge++;
      continue;
    }
    if (await deleteClip(c.folder, c.name)) {
      deleted.push(c);
      freed += c.bytes;
    }
  }

  return { deleted, freed, bytes: bytes - freed, budget, blockedByAge };
}

/** 오래된 클립부터 지워 **개수** 상한 안으로 맞춥니다. @returns {number} 지운 개수 */
export async function pruneClips(folder) {
  let removed = 0;

  // 1) 이 세션의 개수
  const mine = await listClips(folder).catch(() => []);
  for (const f of mine.slice(config.stream.clipPerSession)) {
    if (await deleteClip(folder, f.name)) removed++;
  }

  // 2) 전체 개수
  const folders = await listFolders();
  const all = [];
  for (const f of folders) {
    for (const c of await listClips(f.name)) all.push({ folder: f.name, ...c });
  }
  all.sort((a, b) => b.mtime - a.mtime);
  for (const c of all.slice(config.stream.clipTotal)) {
    if (await deleteClip(c.folder, c.name)) removed++;
  }

  return removed;
}

/** 사람이 읽는 용량. */
export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i <= 1 ? 0 : 1)} ${u[i]}`;
}

/**
 * yt-dlp 가 뱉은 영어 오류를 "다음에 뭘 하면 되는지" 로 바꿉니다.
 *
 * ⚠️ **원인을 모르면 지어내지 마세요.** 아래 목록에 없으면 원문을 그대로 붙여
 *    소유자가 진짜 원인을 찾을 수 있게 합니다. (CLAUDE.md · ARCHITECTURE 3.1-4)
 */
/**
 * ffmpeg 이 **죽었는가.** (정상 종료가 아니라 신호로 끝난 것)
 *
 * yt-dlp 는 `ffmpeg exited with code -11` 처럼 알려줍니다. 음수는 신호 번호입니다 —
 * -11 은 SIGSEGV(세그폴트), -9 는 SIGKILL(대개 메모리 부족), -6 은 abort.
 * 정상적인 실패(코드 1 등)와 **구분해야** 합니다. 죽은 것만 다른 ffmpeg 으로 넘깁니다.
 */
export function looksLikeFfmpegCrash(message) {
  const s = String(message ?? '');
  if (/ffmpeg[\s\S]{0,40}exited with code -\d+/i.test(s)) return true;
  return /ffmpeg[\s\S]{0,40}(sigsegv|segmentation fault|core dumped)/i.test(s);
}

/**
 * ffmpeg 의 **양수** 종료 코드를 사람 말로 바꿉니다.
 *
 * ffmpeg 은 실패하면 `AVERROR` 값을 그대로 반환하고, 종료 코드는 `& 0xFF` 로 잘립니다.
 * 그래서 183 같은 낯선 숫자가 나옵니다. 계산과 실측으로 확인한 것만 적습니다 (2026-09-03):
 *
 * ```
 * AVERROR_INVALIDDATA = -1094995529  →  183
 * $ ffmpeg -i garbage.mp4 …  →  "Invalid data found when processing input" · 종료코드 183
 * ```
 *
 * ⚠️ **모르는 코드는 지어내지 않습니다.** 목록에 없으면 null 을 주고 원문만 보여줍니다.
 */
export function ffmpegExitMeaning(code) {
  const n = Number(code);
  if (n === 183) {
    return {
      what: '입력 데이터가 영상이 아니었습니다 (AVERROR_INVALIDDATA).',
      // ⚠️ **실제로 겪은 원인을 첫 번째로 적습니다.** 처음에는 "쿠키가 없어서 유튜브가
      //    거부한 것" 이라고 짚었는데 **틀렸습니다** — 같은 쿠키 설정으로 잘 됩니다.
      //    진짜 원인은 그 방송에 **화면이 없었던** 것이었습니다.
      likely:
        '이 프로젝트에서 실제로 있었던 원인은 **화면 없이 음성만 녹화된 방송**이었습니다.\n' +
        '화면까지 녹화한 방송으로 다시 하니 잘 됐습니다. 먼저 그것부터 확인해주세요.\n' +
        '(그 밖의 가능성은 서버 로그의 `[stream] 클립 실패 원문` 을 봐야 압니다)',
    };
  }
  if (n === 187) return { what: '입력이 예상보다 먼저 끝났습니다 (AVERROR_EOF).', likely: '' };
  if (n === 204) return { what: '유튜브가 요청을 거부했습니다 (HTTP 오류 계열).', likely: '' };
  return null;
}

/** 오류 원문에서 ffmpeg 이 남긴 줄만 골라 옵니다. 진짜 원인이 거기 있습니다. */
export function ffmpegLines(raw, limit = 6) {
  return String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[download\]/.test(l))
    .filter((l) => /error|invalid|forbidden|http|403|refus|denied|ffmpeg|failed/i.test(l))
    .slice(-limit);
}

/**
 * **영상 포맷이 없다**는 답인가.
 *
 * 포맷 선택식이 영상을 반드시 요구하므로, 화면 없이 음성만 녹화된 방송은
 * 이 답을 받습니다 (실측). 그걸 알아채고 **소리만으로 다시** 시도합니다.
 */
export function looksLikeNoVideo(message) {
  return /requested format is not available/i.test(String(message ?? ''));
}

export function clipError(message, raw = '') {
  const s = String(message ?? '');
  const low = s.toLowerCase();

  // ★ 영상도 소리도 못 찾은 경우입니다. (소리만 받기까지 실패한 뒤에 여기 옵니다)
  //   화면 없는 방송 자체는 이제 **소리만으로 만들어줍니다** — makeClip 참고.
  if (looksLikeNoVideo(s)) {
    return (
      '이 방송에서 **쓸 수 있는 화면도 소리도 찾지 못했습니다.**\n\n' +
      '· 방송이 아직 다시보기로 만들어지지 않았을 수 있습니다. 몇 분 뒤에 다시 눌러주세요.\n' +
      '· OBS 에 화면·소리 소스가 들어가 있는지 확인해주세요.\n' +
      `· 화질 상한(현재 ${config.stream.clipMaxHeight}p)이 너무 낮아도 이 답이 옵니다.\n` +
      '· 타임라인 텍스트는 이것과 무관하게 그대로 남아 있습니다.'
    );
  }

  // ffmpeg 이 양수 코드로 실패한 경우. 숫자만 보여주면 아무도 원인을 모릅니다.
  const exit = s.match(/ffmpeg[\s\S]{0,40}exited with code (\d+)/i);
  if (exit) {
    const meaning = ffmpegExitMeaning(exit[1]);
    const lines = ffmpegLines(raw);
    const parts = [s.trim()];
    if (meaning) {
      parts.push(`\n**코드 ${exit[1]}** — ${meaning.what}`);
      if (meaning.likely) parts.push(meaning.likely);
    } else {
      // ⚠️ 모르는 코드입니다. 지어내지 않고 원문을 보여줍니다. (3.1-4)
      parts.push(`\n**코드 ${exit[1]}** 이 무슨 뜻인지는 저도 모릅니다. 아래 원문이 답입니다.`);
    }
    if (lines.length > 0) parts.push(`\nffmpeg 이 남긴 말:\n\`\`\`\n${lines.join('\n')}\n\`\`\``);
    else parts.push('\n서버 로그에 `[stream] 클립 실패 원문` 으로 자세한 내용이 남았습니다.');
    parts.push(
      '· 쿠키를 쓰고 있다면 `.env` 의 `YTDLP_COOKIES_FILE` 이 **망고 쪽에도** 있는지 확인해주세요.\n' +
        '· 구간을 짧게(30초 이내) 해서 다시 해보세요.'
    );
    return parts.join('\n');
  }

  // ⚠️ 원인을 짐작해서 적지 않습니다. **무엇을 해보면 되는지**만 적습니다.
  //    (묶음 ffmpeg 이 왜 죽는지는 확정하지 못했습니다 — ARCHITECTURE 3.6-9)
  if (looksLikeFfmpegCrash(s)) {
    return (
      `${s.trim()}\n\n` +
      '**ffmpeg 이 정상 종료가 아니라 죽었습니다** (음수 코드는 신호 번호입니다. -11 = 세그폴트).\n' +
      '봇이 다른 ffmpeg 으로도 해봤지만 안 됐습니다. 서버에서 이렇게 해보세요:\n' +
      '```\nsudo apt install -y ffmpeg\nffmpeg -version\n```\n' +
      '그다음 `.env` 에 아래를 넣고 재시작하세요.\n' +
      '```\nFFMPEG_PATH=/usr/bin/ffmpeg\n```\n' +
      '· -9 가 나왔다면 메모리 부족입니다. `free -h` 로 swap 을 확인하세요.\n' +
      '· 클립 화질을 낮추면 부담이 줄어듭니다 (`STREAM_CLIP_MAX_HEIGHT=480`).'
    );
  }

  if (low.includes('live event will begin') || low.includes('premieres in') || low.includes('is_upcoming')) {
    return '아직 시작하지 않은 방송입니다.';
  }
  if (low.includes('ffmpeg') && (low.includes('not found') || low.includes('no such file'))) {
    return 'ffmpeg 을 찾지 못했습니다. `npm install` 을 다시 실행해주세요 (ffmpeg-static).';
  }
  if (low.includes('this live stream recording is not available') || low.includes('post_live')) {
    return (
      '유튜브가 **아직 다시보기를 만들고 있습니다.** 몇 분 뒤에 다시 눌러주세요.\n' +
      '(방송이 길었으면 더 걸립니다. 요약판 버튼은 계속 남아 있습니다)'
    );
  }
  if (low.includes('private video') || low.includes('members-only')) {
    return '봇이 이 영상을 볼 수 없습니다. **일부공개**(링크 있는 사람만)로 바꿔주세요. 완전 비공개는 못 봅니다.';
  }
  if (low.includes('video unavailable') || low.includes('has been removed')) {
    return '영상이 사라졌습니다. 다시보기를 지우셨거나 유튜브가 내렸습니다. 타임라인 텍스트는 그대로 있습니다.';
  }
  if (low.includes('타임아웃')) {
    return (
      s +
      '\n\n구간이 너무 길거나 서버가 느립니다. 구간을 짧게 줄여 다시 해보세요.\n' +
      '방송이 방금 끝났다면 다시보기가 아직 안 만들어진 것일 수도 있습니다.'
    );
  }
  return s;
}

/**
 * 클립 실패의 **원문을 통째로** 로그에 남깁니다.
 *
 * ★ 왜 통째로인가: `ffmpeg exited with code 183` 만 남기면 아무도 원인을 못 찾습니다.
 *   실제로 그래서 한 번 헤맸습니다. yt-dlp·ffmpeg 이 그 위에 진짜 이유를 적어두는데,
 *   첫 줄만 남기면 그게 버려집니다. (CLAUDE.md · ARCHITECTURE 3.1-4)
 */
function logClipFailure(err) {
  const raw = String(err?.stderr ?? '').trim();
  console.error(
    `[stream] 클립 실패: ${String(err?.message ?? '').split('\n')[0]}\n` +
      (raw ? `[stream] 클립 실패 원문 ↓\n${raw.split('\n').slice(-25).join('\n')}` : '[stream] (원문이 비어 있습니다)')
  );
}

/**
 * 한 구간을 잘라 파일로 만듭니다.
 *
 * @returns {Promise<{file: string, bytes: number, pruned: number, seconds: number}>}
 */
export async function makeClip({ folder, url, startSec, endSec, title }) {
  const length = Math.round(endSec - startSec);
  if (length <= 0) throw userError('끝 시간이 시작 시간보다 뒤여야 합니다.');
  if (length > config.stream.clipMaxSec) {
    throw userError(
      `클립이 ${length}초입니다. 한 개는 **${config.stream.clipMaxSec}초까지**만 만들 수 있습니다.\n` +
        '길면 용량이 금방 차고, 사진 자동 정리가 돌아 사진이 지워질 수 있습니다.\n' +
        '구간을 나눠서 여러 개로 만들어주세요.'
    );
  }

  await fs.mkdir(folderPath(folder), { recursive: true });

  // 파일 이름: 시작 시간 + 제목. 내려받았을 때 무슨 장면인지 바로 알 수 있게.
  const stamp = new Date(startSec * 1000).toISOString().slice(11, 19).replace(/:/g, '');
  const stem = safeClipName(`${stamp}-${title || '클립'}`);
  const out = path.join(folderPath(folder), stem);

  const t0 = Date.now();
  const cut = (audioOnly) =>
    downloadSection(url, {
      startSec,
      endSec,
      outPath: out,
      maxHeight: config.stream.clipMaxHeight,
      audioOnly,
    });

  /** 소리만으로 만들었는가. 사람에게 **반드시 말해줘야** 합니다. */
  let audioOnly = false;

  const attempt = async (isAudio) => {
    try {
      await cut(isAudio);
      return null;
    } catch (err) {
      // ⚠️ 실패하면 **반쪽 파일을 치웁니다.** `--force-overwrites` 는 다음 실행 이야기라
      //    지금 남은 `.part` 를 지워주지 않습니다.
      await cleanLeftovers(folder, stem);
      return err;
    }
  };

  let err = await attempt(false);

  // ffmpeg 이 **죽었으면**(-11 = SIGSEGV 등) 다른 ffmpeg 으로 한 번 더 해봅니다.
  // 소유자 서버에서 묶음 ffmpeg 이 실제로 이렇게 죽었습니다. 원인은 확정하지 못했지만
  // 서버에 깔린 ffmpeg 으로 바꾸면 되는 경우가 있으니, 사람이 손대기 전에 봇이 해봅니다.
  if (err && looksLikeFfmpegCrash(err.message) && nextFfmpeg()) {
    console.warn(`[stream] ffmpeg 이 죽어서(${err.message.trim()}) 다른 ffmpeg 으로 다시 시도합니다.`);
    err = await attempt(false);
  }

  // ★ **화면이 없는 방송이면 소리만이라도 잘라냅니다.**
  //   웃긴 순간은 소리만으로도 남길 값이 있습니다 (소유자 요청).
  //   ⚠️ 다만 **처음부터 소리만 받으면 안 됩니다.** 그러면 영상이 있는 방송에서도
  //      조용히 소리만 내주게 됩니다 — 사람은 뭘 받았는지 모릅니다.
  //      영상을 먼저 요구하고, **없다는 답을 받은 뒤에만** 소리로 내려갑니다.
  //   실측: 15초 구간이 3.7초 · 244KB (영상은 14초 · 2.4MB). 훨씬 싸고 빠릅니다.
  if (err && looksLikeNoVideo(err.message) && config.stream.clipAudioFallback) {
    console.log('[stream] 화면이 없는 방송입니다. 소리만으로 잘라냅니다.');
    const audioErr = await attempt(true);
    if (audioErr) {
      logClipFailure(audioErr);
      throw userError(clipError(audioErr.message, audioErr.stderr));
    }
    audioOnly = true;
    err = null;
  }

  if (err) {
    logClipFailure(err);
    throw userError(clipError(err.message, err.stderr));
  }

  // ⚠️ **확장자를 가정하지 않습니다.** 영상은 `.mp4`, 소리만은 `.m4a` 로 나옵니다.
  const made = await findProduced(folder, stem);
  if (!made) {
    await cleanLeftovers(folder, stem);
    throw userError(
      'yt-dlp 가 끝났다고 했는데 파일이 없습니다.\n' +
        `저장 위치: ${folderPath(folder)}\n` +
        '디스크가 찼거나 쓰기 권한이 없을 수 있습니다. 서버에서 `df -h` 로 확인해주세요.'
    );
  }

  // 다음 것을 위해 자리를 만들어둡니다. 방금 만든 것은 가장 새것이라 안 지워집니다.
  const pruned = await pruneClips(folder).catch(() => 0);

  return {
    file: made.file,
    bytes: made.bytes,
    // 확장자로 다시 판단합니다 — 요청과 결과가 어긋났을 때 **결과가 맞습니다.**
    audioOnly: made.audio,
    requestedAudioOnly: audioOnly,
    pruned,
    seconds: (Date.now() - t0) / 1000,
  };
}

/** 웹에서 이 세션 클립을 볼 주소. */
export function clipPageUrl(folder) {
  return `${config.images.webPublicUrl}/c/${folder}`;
}
