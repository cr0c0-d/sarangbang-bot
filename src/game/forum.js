import { MessageFlags } from 'discord.js';
import { get as getSetting } from '../settings.js';
import { postIdFor } from './store.js';
import { markStreamForumPosted } from '../stream/store.js';

export function recordContent(session, stream) {
  const game = stream.game || session.game || '게임 이름 없음';
  const header =
    `📺 **${game}** · <@${stream.userId}>\n` +
    `방송 시작일 <t:${stream.startedAt}:d>\n` +
    `<${stream.url}>`;
  // 수정 가능한 타임라인은 방송 요약판 한 곳에서만 관리합니다.
  return header;
}

const publishing = new Map();

/** 연결된 녹화 포스트에 방송 기록을 올립니다. 연결이 없으면 기록은 보류 상태로 남습니다. */
export async function publishStreamRecord(client, session, stream) {
  const key = `${session.id}:${stream.userId}`;
  if (publishing.has(key)) return publishing.get(key);
  const job = publish(client, session, stream).finally(() => publishing.delete(key));
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

  const content = recordContent(session, stream);
  if (previous?.messageIds?.length) {
    // 이전 버전의 여러 장짜리 타임라인도 다음 설명 수정/종료 때 간단한 링크로 바꿉니다.
    try {
      const first = await thread.messages.fetch(previous.messageIds[0]);
      await first.edit({ content, allowedMentions: { parse: [] } });
      for (const id of previous.messageIds.slice(1)) {
        try { await thread.messages.delete(id); }
        catch (err) { if (err.code !== 10008) throw err; }
      }
      markStreamForumPosted(session, stream.userId, threadId, [first.id]);
      return { status: 'updated', threadId };
    } catch { return { status: 'failed', threadId }; }
  }
  const message = await thread
    .send({ content, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
    .catch(() => null);
  if (!message) return { status: 'failed', threadId };
  markStreamForumPosted(session, stream.userId, threadId, [message.id]);
  return { status: 'posted', threadId };
}

/** 새 녹화 포스트를 연결했을 때, 끝났지만 보류 중인 같은 게임 기록을 밀어 넣습니다. */
export async function publishPendingForGame(client, guildId, gameKey) {
  const { sessionsForGuild } = await import('../stream/store.js');
  let posted = 0;
  for (const session of sessionsForGuild(guildId)) {
    if (!session.closedAt) continue;
    for (const stream of session.streams) {
      if (stream.gameKey !== gameKey || stream.forumPosted?.messageIds?.length) continue;
      const result = await publishStreamRecord(client, session, stream);
      if (result.status === 'posted') posted += 1;
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
