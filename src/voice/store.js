// 🎧 소리 기록의 저장 목록. **방송 기록(`src/stream/store.js`)과 별개 파일입니다.**
//
// 왜 따로인가: 소리 기록은 방송을 켜지 않아도 씁니다. 그냥 수다 떠는 상황이 주 용도라
// 방송 세션에 얹으면 "수다 떨려고 방송을 켜야" 합니다. 파일 정리와 하루 한도를 위해 내부 저장만
// **날짜 폴더**를 쓰고, 사용자에게는 날짜와 관계없이 한 페이지로 합쳐 보여줍니다.
//
// 파일 자체와 용량 예산은 `stream/clips.js` 를 **같이 씁니다.** 예산을 따로 두면
// 정리가 소리만 조용히 못 지워, 디스크가 차도 원인을 못 찾습니다 (ARCHITECTURE 3.6-12).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'voice-clips.json');

/** @type {{ days: Record<string, { folder: string, guildId: string, clips: any[] }> }} */
let store = { days: {} };
let writeChain = Promise.resolve();

export async function initVoiceClips() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = loaded?.days ? loaded : { days: {} };
  } catch {
    store = { days: {} };
  }
}

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store, null, 2), 'utf8'))
    .catch((e) => console.error('[voice] 저장 실패:', e.message));
  return writeChain;
}

export function flushVoiceClips() {
  return writeChain;
}

/**
 * 오늘의 폴더 이름.
 *
 * ⚠️ 웹 클립 페이지(`/c/:folder`)가 `^[a-z0-9]{4,12}$` 만 받습니다.
 * 그래서 길드 앞 4자리 + 날짜 6자리 = 10자로 만듭니다 —
 * 서버가 여러 개일 때 남의 서버 소리가 같은 폴더에 섞이지 않게 길드를 넣습니다.
 */
export function folderFor(guildId, date = new Date()) {
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${String(guildId).slice(0, 4)}${yy}${mm}${dd}`.toLowerCase();
}

export function dayOf(guildId, date = new Date()) {
  const folder = folderFor(guildId, date);
  store.days[folder] ??= { folder, guildId, clips: [] };
  return store.days[folder];
}

export function addVoiceClip(guildId, clip) {
  const day = dayOf(guildId);
  day.clips.push({ ...clip, at: Math.floor(Date.now() / 1000) });
  save();
  return day;
}

/** 서버의 모든 소리 기록. 웹에서는 날짜 폴더를 숨기고 최신순으로 합칩니다. */
export function allVoiceClips(guildId) {
  return Object.values(store.days)
    .filter((d) => d.guildId === guildId)
    .flatMap((d) => d.clips.map((clip) => ({ ...clip, folder: clip.folder ?? d.folder })))
    .filter((clip) => clip.file && clip.folder)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** 제목만 바꿉니다. 파일명은 건드리지 않아 열린 재생·다운로드 주소가 깨지지 않습니다. */
export async function setVoiceClipTitle(guildId, folder, file, title) {
  const text = String(title ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!text) return null;
  const day = store.days[String(folder)];
  if (!day || day.guildId !== String(guildId)) return null;
  const clip = day.clips.find((c) => c.file === file);
  if (!clip) return null;
  clip.title = text;
  await save();
  return { ...clip, folder: day.folder };
}

export function clipsToday(guildId) {
  return dayOf(guildId).clips;
}

/** 최근 며칠치 폴더. `/음성기록` 이 지난 것도 들으러 갈 수 있게 보여줍니다. */
export function recentDays(guildId, limit = 5) {
  return Object.values(store.days)
    .filter((d) => d.guildId === guildId && d.clips.length > 0)
    .sort((a, b) => b.folder.localeCompare(a.folder))
    .slice(0, limit);
}
