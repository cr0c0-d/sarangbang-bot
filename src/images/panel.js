// 갤러리 바로가기 패널.
//
// 왜 필요한가: 사진을 보려면 매번 `/갤러리` 를 쳐야 했는데 불편하다는 피드백을 받았습니다.
// 그래서 사진이 한 장이라도 올라온 채널에는 **버튼을 채팅방 맨 아래에 항상 띄워둡니다.**
// 음악 제어판과 완전히 같은 방식입니다 (맨 아래면 수정, 밀려났으면 지우고 다시).
//
// 알림은 울리지 않습니다(SuppressNotifications). 사진 올릴 때마다 알림이 오면 시끄럽습니다.
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { config } from '../config.js';
import { listFiles } from './store.js';
import { rememberPanel, forgetPanel, GALLERY } from '../panel-registry.js';

/** 채널ID → 띄워둔 패널 메시지. 음악과 달리 **채널 단위**입니다. */
const panels = new Map();
/** 채널ID → 작업 큐. 동시에 여러 장이 올라올 때 패널이 두 개 생기는 것을 막습니다. */
const chains = new Map();

function galleryUrl(folder) {
  return `${config.images.webPublicUrl}/f/${encodeURIComponent(folder)}`;
}

function buildPanel(folder, count, latest) {
  const embed = new EmbedBuilder()
    .setTitle(`🖼️ ${folder}`)
    .setColor(0x5865f2)
    .setDescription(
      `사진 **${count}장**이 모여 있습니다.\n` +
        '아래 버튼을 눌러 여러 장을 골라 한 번에 받으세요.'
    );
  // 최근 사진을 미리보기로 붙이면 뭐가 들어있는지 한눈에 보입니다.
  if (latest) embed.setThumbnail(`${galleryUrl(folder)}`.replace('/f/', '/img/') + `/${encodeURIComponent(latest)}`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('갤러리 열기').setEmoji('🖼️').setStyle(ButtonStyle.Link).setURL(galleryUrl(folder))
  );

  return { embeds: [embed], components: [row] };
}

async function isAtBottom(channel, messageId) {
  try {
    const last = await channel.messages.fetch({ limit: 1 });
    return last.first()?.id === messageId;
  } catch {
    return false;
  }
}

/**
 * 갤러리 버튼을 채팅방 맨 아래에 띄웁니다.
 * 사진이 저장된 직후에 호출합니다. 사진이 없으면 아무것도 하지 않습니다.
 */
export function showGalleryPanel(channel, folder) {
  if (!channel || !folder) return Promise.resolve();
  const key = channel.id;
  const next = (chains.get(key) ?? Promise.resolve())
    .then(() => showNow(channel, folder))
    .catch((err) => console.error('[images] 갤러리 패널 실패:', err.message));
  chains.set(key, next);
  return next;
}

async function showNow(channel, folder) {
  const files = await listFiles(folder);
  if (files.length === 0) return; // 한 장도 없으면 띄우지 않습니다

  const body = buildPanel(folder, files.length, files[0]?.name);
  const existing = panels.get(channel.id);

  if (existing) {
    if (await isAtBottom(channel, existing.id)) {
      try {
        await existing.edit(body);
        return;
      } catch {
        panels.delete(channel.id);
        forgetPanel(GALLERY, channel.id);
      }
    } else {
      // 다른 대화에 밀려 올라갔습니다. 지우고 맨 아래에 다시 띄웁니다.
      await existing.delete().catch(() => {});
      panels.delete(channel.id);
      forgetPanel(GALLERY, channel.id);
    }
  }

  const sent = await channel.send({ ...body, flags: MessageFlags.SuppressNotifications });
  panels.set(channel.id, sent);
  // 재시작 후 이 버튼을 되찾아 그대로 쓰기 위해 디스크에 적어둡니다.
  rememberPanel(GALLERY, channel.id, sent.id);
}

/** 봇이 채널을 떠나거나 기능이 꺼질 때 정리용. */
export function forgetGalleryPanel(channelId) {
  panels.delete(channelId);
  forgetPanel(GALLERY, channelId);
}

/**
 * 재시작 전에 띄워둔 갤러리 버튼을 되찾습니다.
 * 이걸 안 하면 다음 업로드 때 버튼이 하나 더 생겨서 재시작마다 쌓입니다.
 */
export function adoptGalleryPanel(channelId, message) {
  panels.set(channelId, message);
}
