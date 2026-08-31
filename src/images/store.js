// 이미지 저장소. 디스코드에 올라온 이미지를 디스크의 폴더로 정리해 저장합니다.
//
// 폴더가 정해지는 순서 (위에서부터 먼저 적용):
//   1. 메시지가 스레드 안에 있으면  → 스레드 이름
//   2. 그 채널에 /폴더 명령으로 지정한 이름이 있으면 → 그 이름
//   3. 둘 다 없으면 → 오늘 날짜 (YYYY-MM-DD)
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';

const BASE = config.images.dir;
const META_FILE = path.join(BASE, '_meta.json');
const FOLDER_MAP_FILE = path.join(BASE, '_folders.json');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.heic']);

/** @type {Record<string, object>} "폴더/파일명" → 메타데이터 */
let meta = {};
/** @type {Record<string, string>} 채널ID → 폴더명 */
let folderMap = {};

let writeChain = Promise.resolve();

export async function initStore() {
  await fs.mkdir(BASE, { recursive: true });
  meta = await readJson(META_FILE, {});
  folderMap = await readJson(FOLDER_MAP_FILE, {});
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 여러 이미지가 동시에 들어와도 JSON이 깨지지 않도록 쓰기를 한 줄로 세웁니다.
function saveJson(file, data) {
  writeChain = writeChain
    .then(() => fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8'))
    .catch((e) => console.error('[images] 메타데이터 저장 실패:', e.message));
  return writeChain;
}

// ── 경로 안전장치 ───────────────────────────────────────────

/**
 * 폴더명에서 위험한 문자를 걷어냅니다.
 * 이걸 안 하면 "../../Windows" 같은 이름으로 저장 폴더 밖에 파일을 쓸 수 있습니다.
 */
export function safeFolderName(name) {
  const cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
    .trim();
  return cleaned || '기타';
}

export function safeFileName(name) {
  return String(name ?? '')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'image';
}

/** 폴더 경로를 만들되, 반드시 저장소 안쪽인지 확인합니다. */
export function folderPath(folder) {
  const safe = safeFolderName(folder);
  const p = path.resolve(BASE, safe);
  const base = path.resolve(BASE);
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw new Error('잘못된 폴더 이름입니다.');
  }
  return p;
}

export function filePath(folder, file) {
  const safe = safeFileName(file);
  const p = path.resolve(folderPath(folder), safe);
  const dir = folderPath(folder);
  if (!p.startsWith(dir + path.sep)) throw new Error('잘못된 파일 이름입니다.');
  return p;
}

// ── 채널별 기본 폴더 ────────────────────────────────────────

export function setChannelFolder(channelId, folder) {
  const safe = safeFolderName(folder);
  folderMap[channelId] = safe;
  saveJson(FOLDER_MAP_FILE, folderMap);
  return safe;
}

export function clearChannelFolder(channelId) {
  delete folderMap[channelId];
  saveJson(FOLDER_MAP_FILE, folderMap);
}

export function getChannelFolder(channelId) {
  return folderMap[channelId] ?? null;
}

export function allChannelFolders() {
  return { ...folderMap };
}

/**
 * 이미지를 어느 폴더에 넣을지 결정합니다.
 *
 * Message 객체가 아니라 (채널, 채널ID)를 받습니다.
 * /폴더확인 명령어는 메시지가 아니라 interaction 에서 호출하기 때문입니다.
 * 여기에 message 의 다른 필드를 쓰고 싶어지면, 호출부 두 곳을 모두 고쳐야 합니다.
 *
 * @param {import('discord.js').Channel|null} channel
 * @param {string} channelId
 */
export function resolveFolder(channel, channelId) {
  // 1순위: 스레드 안에 올렸으면 스레드 이름
  if (channel?.isThread?.() && channel.name) {
    return safeFolderName(channel.name);
  }
  // 2순위: /폴더 명령으로 이 채널에 직접 지정한 이름
  const configured = folderMap[channelId];
  if (configured) return configured;
  // 3순위: 채널 이름 그대로 (기본값)
  if (channel?.name) return safeFolderName(channel.name);
  // 마지막 수단: 채널 이름을 알 수 없을 때만 날짜
  return localDate(new Date());
}

/** 지금 이 채널의 폴더가 어떤 규칙으로 정해졌는지 설명합니다. (/폴더확인 용) */
export function explainFolder(channel, channelId) {
  if (channel?.isThread?.() && channel.name) return '스레드 이름을 폴더로 씁니다';
  if (folderMap[channelId]) return '`/폴더` 명령으로 직접 지정한 이름입니다';
  if (channel?.name) return '채널 이름을 그대로 씁니다 (기본값)';
  return '채널 이름을 알 수 없어 날짜를 씁니다';
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * YYYY-MM-DD (현지 시각 기준).
 *
 * toISOString() 을 쓰면 UTC 기준이 되어, 한국시간 오전 0~9시에 올린 사진이
 * "어제" 폴더로 들어갑니다. 사용자 입장에서는 명백한 버그로 보이므로 현지 시각을 씁니다.
 * 서버(VPS)에서는 OS 시간대를 Asia/Seoul 로 맞춰야 의도대로 동작합니다.
 */
export function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYYMMDD-HHMMSS (현지 시각 기준). 파일 이름 앞에 붙입니다. */
export function localStamp(d) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// ── 저장 ────────────────────────────────────────────────────

export function isImageAttachment(att) {
  if (att.contentType?.startsWith('image/')) return true;
  return IMAGE_EXT.has(path.extname(att.name ?? '').toLowerCase());
}

/** 이름이 겹치면 뒤에 -1, -2 를 붙여서 덮어쓰기를 막습니다. */
async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = fileName;
  for (let i = 1; i < 1000; i++) {
    try {
      await fs.access(path.join(dir, candidate));
      candidate = `${stem}-${i}${ext}`;
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * 메시지에 붙은 이미지를 전부 저장합니다.
 * @returns {Promise<{folder: string, saved: string[]}>}
 */
export async function saveAttachments(message) {
  const folder = resolveFolder(message.channel, message.channelId);
  const dir = folderPath(folder);
  await fs.mkdir(dir, { recursive: true });

  const saved = [];
  for (const att of message.attachments.values()) {
    if (!isImageAttachment(att)) continue;

    const stamp = localStamp(new Date(message.createdTimestamp));
    const base = safeFileName(`${stamp}_${att.name ?? 'image'}`);
    const name = await uniquePath(dir, base);
    const dest = path.join(dir, name);

    const res = await fetch(att.url);
    if (!res.ok) {
      console.error(`[images] 다운로드 실패 (${att.name}): HTTP ${res.status}`);
      continue;
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));

    meta[`${folder}/${name}`] = {
      folder,
      file: name,
      originalName: att.name ?? null,
      size: att.size ?? null,
      width: att.width ?? null,
      height: att.height ?? null,
      author: message.author?.tag ?? null,
      authorId: message.author?.id ?? null,
      channelId: message.channelId,
      messageId: message.id,
      messageUrl: message.url,
      uploadedAt: new Date(message.createdTimestamp).toISOString(),
    };
    saved.push(name);
  }

  if (saved.length > 0) saveJson(META_FILE, meta);
  return { folder, saved };
}

// ── 조회 ────────────────────────────────────────────────────

export async function listFolders() {
  const entries = await fs.readdir(BASE, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const files = await listFiles(e.name);
    out.push({
      name: e.name,
      count: files.length,
      bytes: files.reduce((a, f) => a + f.size, 0),
      latest: files[0]?.mtime ?? null,
    });
  }
  out.sort((a, b) => (b.latest ?? 0) - (a.latest ?? 0));
  return out;
}

export async function listFiles(folder) {
  const dir = folderPath(folder);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
    if (!st) continue;
    out.push({
      name: e.name,
      size: st.size,
      mtime: st.mtimeMs,
      meta: meta[`${folder}/${e.name}`] ?? null,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function createFolder(folder) {
  const dir = folderPath(folder);
  await fs.mkdir(dir, { recursive: true });
  return path.basename(dir);
}

/** 파일들을 다른 폴더로 옮깁니다. */
export async function moveFiles(fromFolder, files, toFolder) {
  const destDir = folderPath(toFolder);
  await fs.mkdir(destDir, { recursive: true });
  let moved = 0;
  for (const f of files) {
    const src = filePath(fromFolder, f);
    const name = await uniquePath(destDir, path.basename(src));
    await fs.rename(src, path.join(destDir, name)).catch(async (e) => {
      if (e.code === 'EXDEV') {
        await fs.copyFile(src, path.join(destDir, name));
        await fs.unlink(src);
      } else throw e;
    });
    const oldKey = `${safeFolderName(fromFolder)}/${path.basename(src)}`;
    if (meta[oldKey]) {
      meta[`${safeFolderName(toFolder)}/${name}`] = {
        ...meta[oldKey],
        folder: safeFolderName(toFolder),
        file: name,
      };
      delete meta[oldKey];
    }
    moved++;
  }
  saveJson(META_FILE, meta);
  return moved;
}

export async function deleteFiles(folder, files) {
  let n = 0;
  for (const f of files) {
    await fs.unlink(filePath(folder, f)).catch(() => {});
    delete meta[`${safeFolderName(folder)}/${safeFileName(f)}`];
    n++;
  }
  saveJson(META_FILE, meta);
  return n;
}

export function baseDir() {
  return BASE;
}
