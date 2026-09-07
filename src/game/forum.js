import { MessageFlags, ActionRowBuilder } from 'discord.js';
import { get as getSetting, symbolMention } from '../settings.js';
import { postIdFor } from './store.js';
import { markStreamForumPosted, timelineFor, hhmmss } from '../stream/store.js';
import { buildClipEntry, buildReplayLinkEntry, buildTimelineEditEntry } from '../stream/panel.js';

export function recordContent(session, stream) {
  const game = stream.game || session.game || '게임 이름 없음';
  const header =
    `📺 **${game}** · ${symbolMention(session.guildId, stream.userId)}\n` +
    `방송 시작일 <t:${stream.startedAt}:d>\n` +
    (stream.url
      ? `${stream.url}`
      : '⚠️ **다시보기 링크 연결 대기** · 방송자 또는 관리자가 아래 버튼으로 연결해주세요.');
  return header;
}

/** 녹화방 타임라인에서 누르면 해당 초부터 재생되는 YouTube 주소입니다. */
export function youtubeTimestampUrl(stream, sec) {
  const seconds = Math.max(0, Math.floor(Number(sec) || 0));
  const videoId = String(stream?.videoId ?? '').trim();
  if (/^[\w-]{11}$/.test(videoId)) {
    // 짧은 주소를 써야 타임라인이 많아도 Discord 2,000자 안에 더 많이 담깁니다.
    return `https://youtu.be/${videoId}?t=${seconds}s`;
  }
  if (!stream?.url) return null;
  try {
    const url = new URL(stream.url);
    url.searchParams.set('t', `${seconds}s`);
    return url.toString();
  } catch {
    return null;
  }
}

function recordTimelineRow(stream, mark, sec) {
  const time = hhmmss(sec);
  const link = youtubeTimestampUrl(stream, sec);
  // 코드 블록 밖으로 나오므로 설명이 임의의 링크·강조 문법이 되지 않게 이스케이프합니다.
  const description = (mark.text || '(설명 없음)')
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_[\]()~>|])/g, '\\$1');
  return `${link ? `[${time}](${link})` : time} ${description}`;
}

/** 헤더와 클릭 가능한 타임라인까지 포함해 Discord 2,000자 안에서 나눕니다. */
export function recordPages(session, stream) {
  const header = recordContent(session, stream);
  const rows = timelineFor(session, stream).map(({ mark, sec }) =>
    recordTimelineRow(stream, mark, sec)
  );
  if (!rows.length) return [`${header}\n\n이 방송에 남긴 마킹이 없습니다.`];
  const pages = [];
  let current = `${header}\n\n`;
  for (const row of rows) {
    if (current.length + row.length + 1 > 2000) {
      pages.push(current.trimEnd());
      current = '';
    }
    current += `${row}\n`;
  }
  pages.push(current.trimEnd());
  return pages;
}

const publishing = new Map();

/** 연결된 녹화 포스트에 방송 기록을 올립니다. 연결이 없으면 기록은 보류 상태로 남습니다. */
export async function publishStreamRecord(client, session, stream, { refreshPreview = false } = {}) {
  const key = `${session.id}:${stream.userId}`;
  // 갱신 중 들어온 설명 수정도 버리지 않고 순서대로 최신 상태를 반영합니다.
  const previous = publishing.get(key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(() => publish(client, session, stream, refreshPreview)).finally(() => {
    if (publishing.get(key) === job) publishing.delete(key);
  });
  publishing.set(key, job);
  return job;
}

async function publish(client, session, stream, refreshPreview) {
  const previous = stream.forumPosted;
  const gameKey = stream.gameKey;
  const threadId = previous?.threadId || (gameKey && postIdFor(session.guildId, 'rec', gameKey));
  if (!threadId) return { status: 'unlinked' };
  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread?.isThread?.() || !thread.isTextBased?.()) return { status: 'missing', threadId };

  const pages = recordPages(session, stream);
  const ids = [...(previous?.messageIds ?? [])];
  const existed = ids.length > 0;
  const remember = (complete = false) => markStreamForumPosted(session, stream.userId, threadId, [...ids], complete);
  try {
    for (let i = 0; i < pages.length; i++) {
      const payload = {
        content: pages[i], allowedMentions: { parse: [] },
        // 항상 명시해 페이지 증감 때 이전 마지막 페이지의 버튼도 제거합니다.
        components: i === pages.length - 1
          ? [new ActionRowBuilder().addComponents(
              buildTimelineEditEntry(session, stream),
              stream.url ? buildClipEntry(session, stream) : buildReplayLinkEntry(session, stream)
            )] : [],
      };
      if (ids[i]) {
        const message = await thread.messages.fetch(ids[i]);
        if (i === 0 && refreshPreview && stream.url) {
          await refreshRecordPreview(message, payload, stream.url);
        } else {
          await message.edit(payload);
        }
      } else {
        const message = await thread.send({ ...payload, flags: MessageFlags.SuppressNotifications });
        ids.push(message.id);
        // 중간에 실패해도 재시도에서 같은 페이지를 늘리지 않도록 성공분을 바로 저장합니다.
        remember();
      }
    }
    while (ids.length > pages.length) {
      try { await thread.messages.delete(ids[ids.length - 1]); }
      catch (err) { if (err.code !== 10008) throw err; }
      ids.pop();
      remember();
    }
    remember(true);
    return { status: existed ? 'updated' : 'posted', threadId };
  } catch (err) {
    if (ids.length) remember();
    console.warn('[game] 녹화 포스트 동기화 실패:', threadId, err.message);
    return { status: 'failed', threadId };
  }
}

/** 링크를 빼고 다시 넣어 자동 미리보기 재생성을 시도합니다. 캐시 갱신까지 보장하지 않습니다. */
async function refreshRecordPreview(message, payload, url) {
  // 기존 무음 플래그는 보존하고 임베드 숨김만 해제합니다. 링크는 첫 페이지에만 있습니다.
  const restored = { ...payload, flags: (message.flags?.bitfield ?? MessageFlags.SuppressNotifications) & ~MessageFlags.SuppressEmbeds };
  try {
    const withoutYoutubeLinks = payload.content
      .split('\n').filter((line) => line !== url).join('\n')
      .replace(/\[([0-9]{2}:[0-9]{2}:[0-9]{2})\]\(https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^)\s]+\)/gi, '$1');
    await message.edit({ ...payload, content: withoutYoutubeLinks, embeds: [] });
  } finally {
    // 링크 제거 요청이 실패/타임아웃해도 복원을 시도합니다. 복원 실패는 한 번 재시도합니다.
    try { await message.edit(restored); }
    catch { await message.edit(restored); }
  }
}

/** 새 녹화 포스트를 연결했을 때, 끝났지만 보류 중인 같은 게임 기록을 밀어 넣습니다. */
export async function publishPendingForGame(client, guildId, gameKey) {
  const { sessionsForGuild } = await import('../stream/store.js');
  let posted = 0;
  for (const session of sessionsForGuild(guildId)) {
    if (!session.closedAt) continue;
    for (const stream of session.streams) {
      if (stream.gameKey !== gameKey || (stream.forumPosted?.messageIds?.length && stream.forumPosted.complete !== false)) continue;
      const result = await publishStreamRecord(client, session, stream);
      if (result.status === 'posted' || result.status === 'updated') posted += 1;
    }
  }
  return posted;
}

export function forumLinks(guildId, gameKey) {
  return {
    rec: postIdFor(guildId, 'rec', gameKey),
    shot: postIdFor(guildId, 'shot', gameKey),
    recForum: getSetting(guildId, 'recordingForumId'),
    shotForum: getSetting(guildId, 'screenshotForumId'),
  };
}
