// 디스코드 안에서 명령어로 바꾼 설정을 기억합니다.
//
// 설정값의 우선순위:
//   1. /채널설정 명령으로 지정한 값  (data/settings.json 에 저장, 재시작해도 유지)
//   2. .env 에 적어둔 값             (기본값)
//   3. 없음                          (해당 기능 꺼짐)
//
// ⚠️ 명령어로 한 번 지정하면 .env 를 고쳐도 반영되지 않습니다.
//    그래서 /채널확인 이 "어느 쪽에서 온 값인지"를 항상 같이 보여줍니다.
//    .env 값으로 되돌리려면 /채널해제 를 쓰면 됩니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'settings.json');

/** @type {Record<string, Record<string, any>>} 서버ID → { 키: 값 } */
let store = {};
let writeChain = Promise.resolve();

/**
 * 다룰 수 있는 설정 키와, 값이 비었을 때 쓸 .env 기본값.
 * 새 설정을 추가하려면 여기에만 넣으면 됩니다.
 */
// 각 항목의 `feature` 는 **역할 분리**에 쓰입니다.
// 음악만 맡은 봇에게 읽어주기 채널을 물어봐야 소용이 없으므로,
// activeKeys() 가 자기 역할의 것만 골라 줍니다.
export const KEYS = {
  musicTextChannelId: {
    label: '음악 채팅방',
    feature: 'music',
    hint: '유튜브 링크를 붙여넣으면 재생되는 채팅방',
    kind: 'text',
    envValue: () => config.music.textChannelId,
    envName: 'MUSIC_TEXT_CHANNEL_ID',
  },
  musicVoiceChannelId: {
    label: '음악 음성채널',
    feature: 'music',
    hint: '음악을 틀 음성채널 (지정 안 하면 명령한 사람을 따라감)',
    kind: 'voice',
    envValue: () => config.music.voiceChannelId,
    envName: 'MUSIC_VOICE_CHANNEL_ID',
  },
  ttsTextChannelId: {
    label: '읽어주기 채팅방',
    feature: 'tts',
    hint: '여기에 쓴 글을 음성채널에서 읽어줍니다',
    kind: 'text',
    envValue: () => config.tts.textChannelId,
    envName: 'TTS_TEXT_CHANNEL_ID',
  },
  ttsVoiceChannelId: {
    label: '읽어주기 음성채널',
    feature: 'tts',
    hint: '읽어줄 음성채널 (지정 안 하면 말한 사람을 따라감)',
    kind: 'voice',
    envValue: () => config.tts.voiceChannelId,
    envName: 'TTS_VOICE_CHANNEL_ID',
  },
  planCategoryId: {
    label: '일정 카테고리',
    feature: 'plan',
    hint: '/일정새로 로 만든 일정 채널이 이 카테고리 밑에 생깁니다',
    kind: 'category',
    envValue: () => config.plan.categoryId,
    envName: 'PLAN_CATEGORY_ID',
  },
  imageChannelIds: {
    label: '이미지 채널',
    feature: 'images',
    hint: '비워두면 봇이 볼 수 있는 모든 채널. 지정하면 그 채널들만',
    kind: 'text',
    multi: true,
    envValue: () => config.images.channelIds,
    envName: 'IMAGE_CHANNEL_ID',
  },
  imageExcludeChannelIds: {
    label: '이미지 제외 채널',
    feature: 'images',
    hint: '여기 지정한 채널의 사진은 저장하지 않습니다 (다른 설정보다 우선)',
    kind: 'text',
    multi: true,
    envValue: () => config.images.excludeChannelIds,
    envName: 'IMAGE_EXCLUDE_CHANNEL_ID',
  },
};

/**
 * 기능 on/off. 서버(길드)별로 저장합니다.
 *
 * 왜 필요한가: 서버에 이미 다른 음악봇·TTS봇이 있으면 같은 링크에 둘이 반응해 겹칩니다.
 * 서버에 SSH로 들어가 프로세스를 끄지 않고도 디스코드에서 기능별로 끌 수 있어야 합니다.
 * (개선하면서 켜고 끄기를 반복할 수 있게)
 */
/**
 * 이 봇이 맡은 기능인가? (`BOT_ROLE` 로 정합니다)
 *
 * "켜져 있는가"(`featureEnabled`)와 **다른 것입니다.**
 *   - 역할에 없는 기능 → 이 봇에는 아예 없습니다. 명령어도 등록되지 않습니다.
 *   - 역할에 있지만 꺼진 기능 → 명령어는 있고, 쓰면 "꺼져 있습니다" 라고 답합니다.
 */
export function inRole(feature) {
  return config.roleFeatures.includes(feature);
}

/** 이 역할이 물어볼 만한 설정 항목만 골라 줍니다. */
export function activeKeys() {
  return Object.fromEntries(Object.entries(KEYS).filter(([, spec]) => inRole(spec.feature)));
}

export const FEATURES = {
  music: { label: '음악', emoji: '🎵', hint: '유튜브 링크 감지 + /재생 등' },
  tts: { label: '읽어주기', emoji: '🗣️', hint: '채팅을 음성으로 읽어주기' },
  timer: { label: '타이머', emoji: '⏰', hint: '/타이머 · /알람등록' },
  images: { label: '이미지 정리', emoji: '🖼️', hint: '사진 자동 저장 (갤러리 열람은 계속 됩니다)' },
  poll: { label: '투표', emoji: '🗳️', hint: '/투표 로 선택지를 만들고 버튼으로 고르기' },
  movie: { label: '영화 고르기', emoji: '🎬', hint: '/영화 로 한 편 뽑기 · 투표 만들기 (TMDB)' },
  plan: { label: '일정', emoji: '📅', hint: '/일정 · /일정새로 · /정산' },
  ai: { label: '망고야', emoji: '🥭', hint: '/망고야 로 물어보기 (제미나이)' },
};

/** 이 역할이 켜고 끌 수 있는 기능만 골라 줍니다. */
export function activeFeatures() {
  return Object.fromEntries(Object.entries(FEATURES).filter(([key]) => inRole(key)));
}

/** 기본값은 "켜짐" 입니다. 명시적으로 끈 것만 저장합니다. */
export function featureEnabled(guildId, key) {
  return store[guildId]?.features?.[key] !== false;
}

export function setFeature(guildId, key, on) {
  store[guildId] ??= {};
  store[guildId].features ??= {};
  if (on) delete store[guildId].features[key];
  else store[guildId].features[key] = false;

  if (Object.keys(store[guildId].features).length === 0) delete store[guildId].features;
  if (Object.keys(store[guildId]).length === 0) delete store[guildId];
  save();
}

export function setAllFeatures(guildId, on) {
  for (const key of Object.keys(FEATURES)) setFeature(guildId, key, on);
}

export function featureStates(guildId) {
  return Object.fromEntries(Object.keys(FEATURES).map((k) => [k, featureEnabled(guildId, k)]));
}

// ── TTS 목소리 (사람마다 다르게) ──────────────────────────────
//
// 우선순위: **내가 정한 목소리 > `.env` 의 TTS_VOICE**
//
// 예전에는 `/목소리`(서버 기본) 와 `/내목소리`(개인) 두 명령어가 있었는데,
// 둘 다 있으면 어느 쪽을 써야 할지 헷갈려서 **개인 설정만 남겼습니다.**
// 서버 기본값은 `.env` 의 `TTS_VOICE` 로 정합니다.
//
// ⚠️ 예전에 `/목소리` 로 정해둔 서버 기본값(settings.json 의 `voice`)은 이제 쓰지 않습니다.
//    그 서버 사람들은 개인 설정이 없으면 `.env` 기본 목소리를 씁니다.

export function userVoice(guildId, userId) {
  return store[guildId]?.userVoices?.[userId] ?? null;
}

export function setUserVoice(guildId, userId, voice) {
  store[guildId] ??= {};
  store[guildId].userVoices ??= {};
  store[guildId].userVoices[userId] = voice;
  save();
}

export function clearUserVoice(guildId, userId) {
  if (!store[guildId]?.userVoices?.[userId]) return false;
  delete store[guildId].userVoices[userId];
  if (Object.keys(store[guildId].userVoices).length === 0) delete store[guildId].userVoices;
  save();
  return true;
}

/** 이 사람의 글을 읽을 때 쓸 목소리. */
export function voiceFor(guildId, userId) {
  return userVoice(guildId, userId) ?? config.tts.voice;
}

// ── 음량 (음악 / 읽어주기 따로) ────────────────────────────────
//
// ffmpeg 의 -af volume 으로 조절합니다. discord.js 의 inlineVolume 을 쓰면
// 실시간 조절이 되지만, opus 를 PCM 으로 풀었다 다시 인코딩해야 합니다.
// 이 프로젝트에는 순수 JS 인코더(opusscript)밖에 없어서 1코어 서버에서는 소리가 끊깁니다.
// (ARCHITECTURE 3.2 절의 재인코딩 회피가 통째로 깨집니다)

/** 0~200(%). 100 이 원음. */
const VOLUME_DEFAULT = 100;
export const VOLUME_MAX = 200;

export function volumePercent(guildId, kind) {
  return store[guildId]?.volume?.[kind] ?? VOLUME_DEFAULT;
}

/** ffmpeg 에 넘길 배율 (1 = 원음). */
export function volumeScale(guildId, kind) {
  return volumePercent(guildId, kind) / 100;
}

export function setVolume(guildId, kind, percent) {
  const v = Math.max(0, Math.min(VOLUME_MAX, Math.round(percent)));
  store[guildId] ??= {};
  store[guildId].volume ??= {};
  if (v === VOLUME_DEFAULT) delete store[guildId].volume[kind];
  else store[guildId].volume[kind] = v;

  if (Object.keys(store[guildId].volume).length === 0) delete store[guildId].volume;
  if (Object.keys(store[guildId]).length === 0) delete store[guildId];
  save();
  return v;
}

// ── 영화: 이 서버에서 쓰는 OTT ─────────────────────────────
//
// 안 보는 OTT 를 보여주면 "볼 수 없는 작품" 만 나옵니다. 그렇다고 코드에 박아두면
// 구독을 바꿀 때마다 배포해야 합니다. 그래서 서버별로 저장합니다.
// **아무것도 안 고른 서버는 전체**로 봅니다 (설정 전에도 동작해야 합니다).

export function movieProviders(guildId) {
  return store[guildId]?.movieProviders ?? [];
}

export function setMovieProviders(guildId, ids) {
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))];
  store[guildId] ??= {};
  if (clean.length === 0) delete store[guildId].movieProviders;
  else store[guildId].movieProviders = clean;
  if (Object.keys(store[guildId]).length === 0) delete store[guildId];
  save();
  return clean;
}

export async function initSettings() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    store = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    store = {};
  }
}

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store, null, 2), 'utf8'))
    .catch((e) => console.error('[settings] 저장 실패:', e.message));
  return writeChain;
}

/**
 * 설정값과 그 출처를 함께 돌려줍니다.
 * @returns {{ value: any, source: 'command'|'env'|'none' }}
 */
export function getWithSource(guildId, key) {
  const spec = KEYS[key];
  if (!spec) throw new Error(`알 수 없는 설정 키: ${key}`);

  const saved = store[guildId]?.[key];
  const hasSaved = spec.multi ? Array.isArray(saved) && saved.length > 0 : Boolean(saved);
  if (hasSaved) return { value: saved, source: 'command' };

  const env = spec.envValue();
  const hasEnv = spec.multi ? Array.isArray(env) && env.length > 0 : Boolean(env);
  if (hasEnv) return { value: env, source: 'env' };

  return { value: spec.multi ? [] : '', source: 'none' };
}

/** 값만 필요할 때. */
export function get(guildId, key) {
  return getWithSource(guildId, key).value;
}

/** 이 채널이 해당 설정에 포함되는지 (multi 키는 목록 안에 있는지). */
export function includesChannel(guildId, key, channelId) {
  const v = get(guildId, key);
  return Array.isArray(v) ? v.includes(channelId) : v === channelId;
}

/** 값을 지정합니다. multi 키면 목록에 추가합니다. */
export function set(guildId, key, channelId) {
  const spec = KEYS[key];
  store[guildId] ??= {};

  if (spec.multi) {
    // 아직 명령어로 지정한 적이 없으면 .env 목록을 출발점으로 삼습니다.
    const current = Array.isArray(store[guildId][key]) ? store[guildId][key] : [...spec.envValue()];
    if (!current.includes(channelId)) current.push(channelId);
    store[guildId][key] = current;
  } else {
    store[guildId][key] = channelId;
  }
  save();
  return store[guildId][key];
}

/**
 * 지정을 해제합니다. 해제하면 .env 값으로 되돌아갑니다.
 * multi 키에서 channelId 를 주면 그것만 목록에서 뺍니다.
 */
export function clear(guildId, key, channelId = null) {
  const spec = KEYS[key];
  if (!store[guildId]) return;

  if (spec.multi && channelId) {
    const current = Array.isArray(store[guildId][key]) ? store[guildId][key] : [...spec.envValue()];
    store[guildId][key] = current.filter((id) => id !== channelId);
    if (store[guildId][key].length === 0) delete store[guildId][key];
  } else {
    delete store[guildId][key];
  }

  if (Object.keys(store[guildId]).length === 0) delete store[guildId];
  save();
}

/** 기능이 켜져 있는지 = 그 기능의 필수 채널이 정해져 있는지. */
export function ttsEnabled(guildId) {
  return getWithSource(guildId, 'ttsTextChannelId').source !== 'none';
}

/**
 * 이미지 정리는 **항상 켜져 있습니다.**
 * 채널 목록은 "켜기/끄기"가 아니라 **필터**입니다.
 *   목록이 비어 있으면  → 봇이 볼 수 있는 모든 채널의 이미지를 저장 (기본값)
 *   목록이 있으면        → 그 채널들만 저장
 * 소유자가 "기본적으로 다 업로드" 를 원했고, 봇이 볼 수 있는 채널은
 * 디스코드 권한으로 이미 제한되므로 그게 자연스러운 경계입니다.
 */
export function imagesEnabled() {
  return true;
}

/**
 * 이 채널의 이미지를 저장해야 하는지.
 *
 * 두 목록이 있고 **제외가 이깁니다.**
 *   · 이미지 채널   — 비어 있으면 전부, 지정하면 그 채널들만
 *   · 제외 채널     — 여기 있으면 무조건 안 받습니다
 *
 * 왜 제외가 이기나: 소유자가 원한 건 "기본은 전부 받되 몇 군데만 빼기" 입니다.
 * 그 상황에서 제외를 나중에 보면, 지정 목록이 비어 있어 이미 `true` 로 나가버립니다.
 * **먼저 걸러야 합니다.**
 *
 * 스레드는 부모 채널을 따릅니다 — 제외한 채널의 스레드도 제외입니다.
 */
export function imageChannelAllowed(guildId, channelId, parentId = null) {
  const excluded = get(guildId, 'imageExcludeChannelIds') ?? [];
  if (excluded.includes(channelId) || (parentId && excluded.includes(parentId))) return false;

  const { value, source } = getWithSource(guildId, 'imageChannelIds');
  if (source === 'none') return true; // 지정 없음 = 전부
  return value.includes(channelId) || (parentId ? value.includes(parentId) : false);
}
