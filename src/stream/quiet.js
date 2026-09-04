import { MessageFlags, MessageFlagsBitField } from 'discord.js';

/** 공개/나만 보기 상태는 유지하고, 새 메시지 알림과 멘션만 끕니다. */
export function quietPayload(payload, sending = true) {
  const p = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (sending) p.flags = new MessageFlagsBitField(p.flags).add(MessageFlags.SuppressNotifications).bitfield;
  p.allowedMentions = { parse: [], users: [], roles: [], repliedUser: false };
  return p;
}

/** 라우터 오류 응답까지 동일하게 적용합니다. 모달/자동완성/공개 범위는 바꾸지 않습니다. */
export function installQuietStreamReplies(interaction) {
  if (interaction.__quietStream || !(interaction.commandName === '방송' || interaction.customId?.startsWith('tm:'))) return;
  interaction.__quietStream = true;
  for (const method of ['reply', 'followUp', 'editReply', 'update']) {
    const original = interaction[method]?.bind(interaction);
    if (!original) continue;
    interaction[method] = (payload, ...rest) => original(quietPayload(payload, method === 'reply' || method === 'followUp'), ...rest);
  }
  // deferReply는 기존 Ephemeral만 유지합니다. 지연 응답은 모두 나만 보기이며,
  // 편집 API에 새 전송 전용 SuppressNotifications 플래그를 억지로 넣지 않습니다.
}
