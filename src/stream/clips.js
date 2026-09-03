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
import { downloadSection } from '../music/ytdlp.js';

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
 * 폴더 안의 클립 목록. **`.mp4` 만 봅니다** — 실패해서 남은 반쪽 파일(`.part` 등)이
 * 클립처럼 보이면 안 됩니다.
 */
export async function listClips(folder) {
  const dir = folderPath(folder);
  const names = await fs.readdir(dir).catch(() => []);
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.mp4')) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) out.push({ name, bytes: st.size, mtime: st.mtimeMs });
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

/** 실패한 뒤에 남은 반쪽 파일들을 치웁니다. yt-dlp 는 `.part`·`.ytdl`·`.temp` 를 남깁니다. */
async function cleanLeftovers(folder, stem) {
  const dir = folderPath(folder);
  const names = await fs.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(stem)) continue;
    if (name === `${stem}.mp4`) continue;
    await fs.unlink(path.join(dir, name)).catch(() => {});
  }
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
export function clipError(message) {
  const s = String(message ?? '');
  const low = s.toLowerCase();

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
  try {
    await downloadSection(url, {
      startSec,
      endSec,
      outPath: out,
      maxHeight: config.stream.clipMaxHeight,
    });
  } catch (err) {
    // ⚠️ 실패하면 **반쪽 파일을 치웁니다.** `--force-overwrites` 는 다음 실행 이야기라
    //    지금 남은 `.part` 를 지워주지 않습니다.
    await cleanLeftovers(folder, stem);
    const e = userError(clipError(err.message));
    throw e;
  }

  const file = `${stem}.mp4`;
  const st = await fs.stat(path.join(folderPath(folder), file)).catch(() => null);
  if (!st?.isFile()) {
    await cleanLeftovers(folder, stem);
    throw userError(
      'yt-dlp 가 끝났다고 했는데 파일이 없습니다.\n' +
        `저장 위치: ${folderPath(folder)}\n` +
        '디스크가 찼거나 쓰기 권한이 없을 수 있습니다. 서버에서 `df -h` 로 확인해주세요.'
    );
  }

  // 다음 것을 위해 자리를 만들어둡니다. 방금 만든 것은 가장 새것이라 안 지워집니다.
  const pruned = await pruneClips(folder).catch(() => 0);

  return { file, bytes: st.size, pruned, seconds: (Date.now() - t0) / 1000 };
}

/** 웹에서 이 세션 클립을 볼 주소. */
export function clipPageUrl(folder) {
  return `${config.images.webPublicUrl}/c/${folder}`;
}
