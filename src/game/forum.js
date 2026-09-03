import { MessageFlags } from 'discord.js';
import { get as getSetting } from '../settings.js';
import { postIdFor } from './store.js';
import { timelineFor, hhmmss, markStreamForumPosted } from '../stream/store.js';

const LIMIT = 2000;

function recordChunks(session, stream) {
  const game = stream.game || session.game || '게임 이름 없음';
  const header =
    `📺 **${game}** · <@${stream.userId}>\n` +
    `방송 시작 <t:${stream.startedAt}:F> · 종료 <t:${session.closedAt}:F>\n` +
    `<${stream.url}>`;
  const rows = timelineFor(session, stream).map(({ mark, sec }) => `${hhmmss(sec)} ${mark.text || '(설명 없음)'}`);
  if (rows.length === 0) return [`${header}\n\n이 방송에 남긴 마킹이 없습니다.`];

  const chunks = [];
  let current = [];
  for (const row of rows) {
    const prefix = chunks.length === 0 ? `${header}\n\`\`\`\n` : '```\n';
    const candidate = `${prefix}${[...current, row].join('\n')}\n\`\`\``;
    if (candidate.length > LIMIT && current.length) {
      chunks.push(`${prefix}${current.join('\n')}\n\`\`\``);
      current = [];
    }
    current.push(row);
  }
  if (current.length) {
    const prefix = chunks.length === 0 ? `${header}\n\`\`\`\n` : '```\n';
    chunks.push(`${prefix}${current.join('\n')}\n\`\`\``);
  }
  return chunks;
}

/** 연결된 녹화 포스트에 방송 기록을 올립니다. 연결이 없으면 기록은 보류 상태로 남습니다. */
export async function publishStreamRecord(client, session, stream) {
  if (stream.forumPosted?.messageIds?.length) return { status: 'already', threadId: stream.forumPosted.threadId };
  const gameKey = stream.gameKey;
  if (!gameKey) return { status: 'unlinked' };
  const threadId = postIdFor(session.guildId, 'rec', gameKey);
  if (!threadId) return { status: 'unlinked' };
  const thread = await client.channels.fetch(threadId).catch(() => null);
  if (!thread?.isThread?.() || !thread.isTextBased?.()) return { status: 'missing', threadId };

  const messages = [];
  for (const content of recordChunks(session, stream)) {
    const message = await thread
      .send({ content, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
      .catch(() => null);
    if (!message) {
      // 여러 장 중 중간에 실패하면 다음 재시도에서 중복되지 않게 이번에 보낸 것만 걷습니다.
      await Promise.allSettled(messages.map((sent) => sent.delete?.()));
      return { status: 'failed', threadId };
    }
    messages.push(message);
  }
  const messageIds = messages.map((message) => message.id);
  markStreamForumPosted(session, stream.userId, threadId, messageIds);
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
