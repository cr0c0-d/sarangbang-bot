// 봇이 띄워둔 "제어판" 메시지를 재시작 후에도 기억합니다.
//
// 왜 필요한가:
//   음악 제어판과 갤러리 버튼은 메시지 하나를 계속 수정해서 재사용합니다.
//   그런데 그 메시지 ID 를 **메모리에만** 들고 있었습니다.
//   봇을 재시작하면 참조를 잃어버려서:
//     · 음악 제어판 — "지금 재생 중" 인 채로 채팅방에 영원히 남습니다 (곡은 안 나오는데)
//     · 갤러리 버튼 — 다음 업로드 때 새로 하나 더 생겨서 재시작마다 쌓입니다
//
//   그래서 ID 를 디스크에 적어두고, 시작할 때 처리합니다.
//     · 음악 제어판 → **지웁니다** (재시작하면 음악은 이어지지 않으므로 내용이 거짓말입니다)
//     · 갤러리 버튼 → **되찾습니다** (링크 버튼이라 재시작 후에도 멀쩡히 동작합니다)
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'panels.json');

export const MUSIC = 'music';
export const GALLERY = 'gallery';

/** @type {{ [kind: string]: { [channelId: string]: string } }} 종류 → 채널ID → 메시지ID */
let store = {};
let writeChain = Promise.resolve();

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store, null, 2), 'utf8'))
    .catch((e) => console.error('[panel] 저장 실패:', e.message));
  return writeChain;
}

export async function initPanelRegistry() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    store = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    store = {}; // 파일이 없거나 깨졌으면 빈 상태로 시작합니다
  }
}

/** 제어판을 띄웠으면 기억해둡니다. */
export function rememberPanel(kind, channelId, messageId) {
  if (!channelId || !messageId) return;
  if (store[kind]?.[channelId] === messageId) return; // 같은 값이면 다시 쓰지 않습니다
  store[kind] ??= {};
  store[kind][channelId] = messageId;
  save();
}

export function forgetPanel(kind, channelId) {
  if (!store[kind]?.[channelId]) return;
  delete store[kind][channelId];
  if (Object.keys(store[kind]).length === 0) delete store[kind];
  save();
}

export function rememberedId(kind, channelId) {
  return store[kind]?.[channelId] ?? null;
}

async function fetchPanel(client, channelId, messageId) {
  const channel = await client.channels.fetch(channelId);
  return { channel, message: await channel.messages.fetch(messageId) };
}

/** 기억해둔 음악 제어판을 지웁니다. (시작 시 / 종료 시) */
export async function deleteMusicPanels(client) {
  let deleted = 0;
  for (const [channelId, messageId] of Object.entries(store[MUSIC] ?? {})) {
    try {
      const { message } = await fetchPanel(client, channelId, messageId);
      await message.delete();
      deleted++;
    } catch {
      // 이미 지워졌거나 채널이 없어졌습니다. 기억만 지우면 됩니다.
    }
    forgetPanel(MUSIC, channelId);
  }
  return deleted;
}

/** 메시지가 음악 제어판인지 봅니다. 버튼 customId 가 `m:` 으로 시작합니다. */
function isMusicPanel(msg, botId) {
  if (msg.author?.id !== botId) return false;
  return JSON.stringify(msg.components ?? []).includes('"m:');
}

/** 메시지가 갤러리 버튼인지 봅니다. 우리 갤러리 주소를 가리키는 링크 버튼입니다. */
function isGalleryPanel(msg, botId) {
  if (msg.author?.id !== botId) return false;
  const base = config.images.webPublicUrl;
  if (!base) return false;
  return JSON.stringify(msg.components ?? []).includes(`${base}/f/`);
}

/**
 * 기억에 **없는** 옛 제어판까지 찾아 지웁니다.
 *
 * 이 기능이 생기기 전에 남은 것들, 또는 저장 파일이 날아간 경우를 위한 청소입니다.
 * 봇이 **자기가 쓴 메시지 중 제어판인 것만** 지웁니다 — 남의 대화는 절대 건드리지 않습니다.
 * 갤러리 버튼은 "기억해둔 그 하나" 만 남기고 중복만 지웁니다 (링크 버튼은 계속 쓸모 있음).
 */
export async function sweepOrphanPanels(client, { perChannel = 50 } = {}) {
  let deleted = 0;
  let scanned = 0;

  for (const guild of client.guilds.cache.values()) {
    let channels;
    let me;
    try {
      // members.me 는 캐시에 없을 수 있습니다. 없으면 모든 채널을 건너뛰어
      // 청소가 조용히 아무것도 안 하게 되므로 직접 받아옵니다.
      me = guild.members.me ?? (await guild.members.fetchMe());
      channels = await guild.channels.fetch();
    } catch {
      continue;
    }

    for (const channel of channels.values()) {
      if (!channel?.isTextBased?.()) continue;
      // 봇이 읽을 수 없는 채널은 건너뜁니다. (음성채널의 채팅도 isTextBased 입니다)
      const perms = channel.permissionsFor(me);
      if (!perms?.has('ViewChannel') || !perms?.has('ReadMessageHistory')) continue;

      scanned++;
      let messages;
      try {
        messages = await channel.messages.fetch({ limit: perChannel });
      } catch {
        continue; // 권한이나 일시적 오류 → 다음 채널로
      }

      const keepGallery = rememberedId(GALLERY, channel.id);
      for (const msg of messages.values()) {
        const stale =
          isMusicPanel(msg, client.user.id) || (isGalleryPanel(msg, client.user.id) && msg.id !== keepGallery);
        if (!stale) continue;
        if (await msg.delete().then(() => true).catch(() => false)) deleted++;
      }
    }
  }

  return { deleted, scanned };
}

/**
 * 시작할 때 한 번 호출합니다.
 *
 * @param {import('discord.js').Client} client
 * @param {(channelId: string, message: import('discord.js').Message) => void} adoptGallery
 *        되찾은 갤러리 버튼을 갤러리 모듈에 넘겨줄 콜백
 */
export async function cleanupPanelsOnStart(client, adoptGallery) {
  try {
    // 1) 갤러리 버튼은 되찾아서 계속 씁니다 (새로 만들지 않게).
    for (const [channelId, messageId] of Object.entries(store[GALLERY] ?? {})) {
      try {
        const { message } = await fetchPanel(client, channelId, messageId);
        adoptGallery?.(channelId, message);
      } catch {
        forgetPanel(GALLERY, channelId); // 사라졌으면 기억도 지웁니다
      }
    }

    // 2) 음악 제어판은 지웁니다. 재시작하면 음악이 이어지지 않으므로 내용이 거짓말입니다.
    const known = await deleteMusicPanels(client);

    // 3) 기억에 없는 옛것까지 훑어 지웁니다.
    const { deleted, scanned } = await sweepOrphanPanels(client);

    const total = known + deleted;
    if (total > 0) console.log(`   옛 제어판 ${total}개 정리 (채널 ${scanned}개 확인)`);
  } catch (err) {
    console.error('[panel] 시작 시 정리 실패:', err.message);
  }
}
