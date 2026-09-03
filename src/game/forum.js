import { MessageFlags } from 'discord.js';
import { get as getSetting } from '../settings.js';
import { postIdFor } from './store.js';
import { markStreamForumPosted, timelineFor, hhmmss } from '../stream/store.js';

export function recordContent(session, stream) {
  const game = stream.game || session.game || '게임 이름 없음';
  const header =
    `📺 **${game}** · <@${stream.userId}>\n` +
    `방송 시작일 <t:${stream.startedAt}:d>\n` +
    `<${stream.url}>`;
  return header;
}

/** 헤더와 코드블록까지 포함해 Discord 2,000자 안에서 나눕니다. */
export function recordPages(session, stream) {
  const header = recordContent(session, stream);
  const rows = timelineFor(session, stream).map(({ mark, sec }) =>
    `${hhmmss(sec)} ${(mark.text || '(설명 없음)').replace(/`/g, 'ˋ').replace(/[\r\n]+/g, ' ')}`
  );
  if (!rows.length) return [`${header}\n\n이 방송에 남긴 마킹이 없습니다.`];
  const pages = [];
  let current = `${header}\n\n\`\`\`\n`;
  for (const row of rows) {
    if (current.length + row.length + 5 > 2000) {
      pages.push(`${current}\`\`\``);
      current = '```\n';
    }
    current += `${row}\n`;
  }
  pages.push(`${current}\`\`\``);
  return pages;
}

const publishing = new Map();

/** 연결된 녹화 포스트에 방송 기록을 올립니다. 연결이 없으면 기록은 보류 상태로 남습니다. */
export async function publishStreamRecord(client, session, stream) {
  const key = `${session.id}:${stream.userId}`;
  // 갱신 중 들어온 설명 수정도 버리지 않고 순서대로 최신 상태를 반영합니다.
  const previous = publishing.get(key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(() => publish(client, session, stream)).finally(() => {
    if (publishing.get(key) === job) publishing.delete(key);
  });
  publishing.set(key, job);
  return job;
}

async function publish(client, session, stream) {
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
      const payload = { content: pages[i], allowedMentions: { parse: [] } };
      if (ids[i]) {
        const message = await thread.messages.fetch(ids[i]);
        await message.edit(payload);
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
