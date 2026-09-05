// 오래된 사진 자동 정리.
//
// ⚠️ 이 파일은 **사용자 데이터를 영구 삭제**합니다. 고칠 때 특히 조심하세요.
//
// ── 왜 "디스크의 80%" 를 기준으로 하지 않는가 ────────────────────────────
// 디스크에는 OS·로그·node_modules 도 함께 있습니다. 로그가 폭주해서 디스크가 80% 를
// 넘겼을 때 사진을 지우면, **원인은 그대로 둔 채 데이터만 잃습니다.**
// 그래서 기본 기준은 **이미지 폴더가 쓸 수 있는 예산(IMAGE_MAX_GB)** 입니다.
// 다만 서버가 죽는 것은 막아야 하므로, 디스크 여유가 바닥나면(IMAGE_MIN_FREE_GB)
// 예산과 무관하게 정리하는 안전장치를 따로 둡니다.
//
// ── 안전장치 ────────────────────────────────────────────────────────
// 1. 최근 사진은 지우지 않습니다 (IMAGE_MIN_KEEP_DAYS). 버그나 갑작스러운 대량 업로드로
//    방금 올린 사진이 통째로 날아가는 일을 막습니다.
// 2. 한 번 정리할 때 **예산의 80% 까지** 내려갑니다. 경계선에서 매번 재실행되는 것을 막습니다.
// 3. 지운 내용을 디스코드에 알립니다. 조용히 사라지면 안 됩니다.
// 4. 디스크 여유가 바닥일 때만 1번 안전장치를 무시합니다 (서버 생존 > 사진 보관).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { listFolders, listFiles, deleteFiles, baseDir } from './store.js';

const GB = 1024 ** 3;

export function limits() {
  const num = (key, fallback) => {
    const v = Number((process.env[key] ?? '').trim());
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    enabled: (process.env.IMAGE_AUTO_CLEANUP ?? 'true').toLowerCase() !== 'false',
    maxBytes: num('IMAGE_MAX_GB', 15) * GB,
    targetPercent: Math.min(95, num('IMAGE_CLEANUP_TARGET_PERCENT', 80)),
    minKeepDays: num('IMAGE_MIN_KEEP_DAYS', 7),
    minFreeBytes: num('IMAGE_MIN_FREE_GB', 2) * GB,
  };
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i <= 1 ? 0 : 1)} ${u[i]}`;
}

/** 지금 사진이 얼마나 쌓였는지 + 디스크 여유. */
export async function usage() {
  const folders = await listFolders();
  const bytes = folders.reduce((a, f) => a + f.bytes, 0);
  const count = folders.reduce((a, f) => a + f.count, 0);

  let diskFree = null;
  let diskTotal = null;
  try {
    const s = await fs.statfs(baseDir());
    diskFree = s.bavail * s.bsize;
    diskTotal = s.blocks * s.bsize;
  } catch {
    // 일부 파일시스템에서는 못 읽습니다. 예산 기준만으로 동작합니다.
  }

  return { bytes, count, folders: folders.length, diskFree, diskTotal };
}

/** 모든 폴더의 파일을 **오래된 순** 으로 한 줄로 세웁니다. */
async function allFilesOldestFirst() {
  const folders = await listFolders();
  const out = [];
  for (const f of folders) {
    for (const file of await listFiles(f.name)) {
      out.push({ folder: f.name, name: file.name, size: file.size, mtime: file.mtime });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/**
 * 무엇을 지울지 계획만 세웁니다. **실제로 지우지 않습니다.**
 * 미리보기(/정리)와 자동 정리가 같은 함수를 쓰므로 결과가 어긋나지 않습니다.
 */
export async function planCleanup({ force = false } = {}) {
  const L = limits();
  const u = await usage();

  const diskTight = u.diskFree !== null && u.diskFree < L.minFreeBytes;
  const overBudget = u.bytes > L.maxBytes;

  // 디스크가 바닥나면 "최근 사진 보호" 를 풉니다. 서버가 죽으면 아무것도 못 합니다.
  const ignoreAge = diskTight;
  const cutoff = Date.now() - L.minKeepDays * 24 * 60 * 60_000;

  if (!force && !overBudget && !diskTight) {
    return { need: false, reason: '여유 있음', usage: u, limits: L, files: [], freed: 0, diskTight };
  }

  // 예산의 targetPercent 까지 내려갑니다 (경계선에서 매번 도는 것을 막기 위해).
  const target = L.maxBytes * (L.targetPercent / 100);
  let toFree = Math.max(0, u.bytes - target);

  // 디스크가 바닥이면 여유를 확보할 만큼 더 지웁니다.
  if (diskTight) toFree = Math.max(toFree, L.minFreeBytes - u.diskFree);

  const candidates = await allFilesOldestFirst();
  const picked = [];
  let freed = 0;

  for (const f of candidates) {
    if (freed >= toFree) break;
    if (!ignoreAge && f.mtime > cutoff) continue; // 최근 사진은 건너뜁니다
    picked.push(f);
    freed += f.size;
  }

  const shortfall = freed < toFree;

  return {
    need: picked.length > 0,
    reason: diskTight ? '디스크 여유 부족' : overBudget ? '이미지 용량 초과' : '수동 요청',
    usage: u,
    limits: L,
    files: picked,
    freed,
    toFree,
    diskTight,
    ignoredAge: ignoreAge,
    // 최근 사진 보호 때문에 목표만큼 못 지운 경우 — 알려야 합니다.
    shortfall,
  };
}

/** 계획을 실제로 실행합니다. 폴더별로 묶어서 지웁니다. */
export async function runCleanup(plan) {
  const byFolder = new Map();
  for (const f of plan.files) {
    if (!byFolder.has(f.folder)) byFolder.set(f.folder, []);
    byFolder.get(f.folder).push(f.name);
  }

  let deleted = 0;
  for (const [folder, names] of byFolder) {
    deleted += await deleteFiles(folder, names);
  }

  // 사진이 하나도 안 남은 폴더는 정리합니다.
  for (const folder of byFolder.keys()) {
    const left = await listFiles(folder);
    if (left.length === 0) {
      await fs.rmdir(path.join(baseDir(), folder)).catch(() => {});
    }
  }

  console.log(`[images] 자동 정리: ${deleted}장 삭제, ${fmtBytes(plan.freed)} 확보`);
  return deleted;
}

/** 사람이 읽을 요약. /정리 와 자동 정리 알림이 같이 씁니다. */
export function describe(plan) {
  const { usage: u, limits: L } = plan;
  const pct = ((u.bytes / L.maxBytes) * 100).toFixed(0);
  const lines = [
    `📊 사진·동영상 **${u.count}개** · ${fmtBytes(u.bytes)} / ${fmtBytes(L.maxBytes)} (**${pct}%**) · 폴더 ${u.folders}개`,
  ];
  if (u.diskFree !== null) {
    lines.push(`💽 디스크 여유 ${fmtBytes(u.diskFree)} / ${fmtBytes(u.diskTotal)}`);
  }
  if (!plan.need) {
    lines.push('\n✅ 아직 정리할 필요가 없습니다.');
    return lines.join('\n');
  }

  lines.push(`\n🧹 **${plan.reason}** — 오래된 것부터 **${plan.files.length}개** (${fmtBytes(plan.freed)}) 정리 대상`);
  const preview = plan.files.slice(0, 5).map((f) => {
    const days = Math.floor((Date.now() - f.mtime) / 86400000);
    return `• ${f.folder} / ${f.name.slice(0, 40)} — ${days}일 전`;
  });
  lines.push(preview.join('\n'));
  if (plan.files.length > 5) lines.push(`… 외 ${plan.files.length - 5}개`);

  if (plan.ignoredAge) {
    lines.push(`\n⚠️ 디스크 여유가 부족해 **최근 ${plan.limits.minKeepDays}일 보호를 해제**했습니다.`);
  }
  if (plan.shortfall) {
    lines.push(
      `\n⚠️ 최근 ${L.minKeepDays}일 이내 파일은 보호되어 목표만큼 확보하지 못했습니다.` +
        '\n`.env` 의 `IMAGE_MAX_GB` 를 늘리거나 `IMAGE_MIN_KEEP_DAYS` 를 줄여주세요.'
    );
  }
  return lines.join('\n');
}

// ── 자동 정리 ────────────────────────────────────────────────

let notifyChannel = null;
let timer = null;

/** 정리 결과를 알릴 채널을 기억해둡니다. (사진이 마지막으로 올라온 곳) */
export function setNotifyChannel(channel) {
  notifyChannel = channel;
}

export async function maybeAutoCleanup() {
  const L = limits();
  if (!L.enabled) return null;

  try {
    const plan = await planCleanup();
    if (!plan.need) return null;

    await runCleanup(plan);
    // 조용히 지우면 안 됩니다. 무엇이 사라졌는지 알려야 합니다.
    await notifyChannel
      ?.send(`🧹 **갤러리 자동 정리**\n${describe(plan)}`)
      .catch(() => {});
    return plan;
  } catch (err) {
    console.error('[images] 자동 정리 실패:', err.message);
    return null;
  }
}

/** 한 시간에 한 번 확인합니다. 업로드 직후에도 따로 호출합니다. */
export function startAutoCleanup() {
  if (timer) return;
  const L = limits();
  if (!L.enabled) {
    console.log('[images] 자동 정리 꺼짐 (IMAGE_AUTO_CLEANUP=false)');
    return;
  }
  console.log(
    `[images] 자동 정리 켜짐: 예산 ${fmtBytes(L.maxBytes)}, ` +
      `${L.targetPercent}% 까지 정리, 최근 ${L.minKeepDays}일 보호`
  );
  timer = setInterval(() => maybeAutoCleanup(), 60 * 60_000);
  timer.unref?.();
}

export function stopAutoCleanup() {
  if (timer) clearInterval(timer);
  timer = null;
}
