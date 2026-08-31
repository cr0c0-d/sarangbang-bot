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
export const KEYS = {
  musicTextChannelId: {
    label: '음악 채팅방',
    hint: '유튜브 링크를 붙여넣으면 재생되는 채팅방',
    kind: 'text',
    envValue: () => config.music.textChannelId,
    envName: 'MUSIC_TEXT_CHANNEL_ID',
  },
  musicVoiceChannelId: {
    label: '음악 음성채널',
    hint: '음악을 틀 음성채널 (지정 안 하면 명령한 사람을 따라감)',
    kind: 'voice',
    envValue: () => config.music.voiceChannelId,
    envName: 'MUSIC_VOICE_CHANNEL_ID',
  },
  ttsTextChannelId: {
    label: '읽어주기 채팅방',
    hint: '여기에 쓴 글을 음성채널에서 읽어줍니다',
    kind: 'text',
    envValue: () => config.tts.textChannelId,
    envName: 'TTS_TEXT_CHANNEL_ID',
  },
  ttsVoiceChannelId: {
    label: '읽어주기 음성채널',
    hint: '읽어줄 음성채널 (지정 안 하면 말한 사람을 따라감)',
    kind: 'voice',
    envValue: () => config.tts.voiceChannelId,
    envName: 'TTS_VOICE_CHANNEL_ID',
  },
  imageChannelIds: {
    label: '이미지 채널',
    hint: '비워두면 봇이 볼 수 있는 모든 채널. 지정하면 그 채널들만',
    kind: 'text',
    multi: true,
    envValue: () => config.images.channelIds,
    envName: 'IMAGE_CHANNEL_ID',
  },
};

/**
 * 기능 on/off. 서버(길드)별로 저장합니다.
 *
 * 왜 필요한가: 서버에 이미 다른 음악봇·TTS봇이 있으면 같은 링크에 둘이 반응해 겹칩니다.
 * 서버에 SSH로 들어가 프로세스를 끄지 않고도 디스코드에서 기능별로 끌 수 있어야 합니다.
 * (개선하면서 켜고 끄기를 반복할 수 있게)
 */
export const FEATURES = {
  music: { label: '음악', emoji: '🎵', hint: '유튜브 링크 감지 + /재생 등' },
  tts: { label: '읽어주기', emoji: '🗣️', hint: '채팅을 음성으로 읽어주기' },
  timer: { label: '타이머', emoji: '⏰', hint: '/타이머 · /알람등록' },
  images: { label: '이미지 정리', emoji: '🖼️', hint: '사진 자동 저장 (갤러리 열람은 계속 됩니다)' },
};

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

/** 이 채널의 이미지를 저장해야 하는지. 목록이 비어 있으면 전부 저장합니다. */
export function imageChannelAllowed(guildId, channelId, parentId = null) {
  const { value, source } = getWithSource(guildId, 'imageChannelIds');
  if (source === 'none') return true; // 지정 없음 = 전부
  return value.includes(channelId) || (parentId ? value.includes(parentId) : false);
}
