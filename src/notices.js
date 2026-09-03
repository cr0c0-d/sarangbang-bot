// 단순 성공 확인만 사용자·채널별 최신 한 개로 유지합니다.
// 오류, 결과 링크, 임베드, 다음 버튼이 있는 화면은 지우지 않습니다.
import { MessageFlags } from 'discord.js';

export function isConfirmation(payload) {
  const p = typeof payload === 'string' ? { content: payload } : payload ?? {};
  if (p.embeds?.length || p.components?.length || p.files?.length || p.attachments?.length) return false;
  const text = p.content ?? '';
  if (!text || text.length > 700 || /https?:\/\/|⚠|❌|실패|오류|없습니다|못했|못 찾|필요|해주세요|\?|중…|중입니다/.test(text)) return false;
  return /했습니다|됐습니다|되었습니다|저장했습니다|고쳤습니다|바꿨습니다|맞췄습니다|올렸습니다|지웠습니다|취소했습니다|기록합니다/.test(text);
}

/** 주입 가능한 저장소: 테스트에서는 실제 Discord나 타이머 없이 검사합니다. */
export function createNoticeKeeper({ schedule = setTimeout, cancel = clearTimeout } = {}) {
  const latest = new Map();
  const keep = async (key, id, remove, ttl) => {
    const old = latest.get(key);
    if (old?.id === id) return;
    if (old) cancel(old.timer);
    const entry = { id, remove, timer: null };
    latest.set(key, entry);
    // 토큰 만료 전에 마지막 확인도 정리합니다. 재시작 전 메시지는 복원할 수 없습니다.
    entry.timer = schedule(() => {
      if (latest.get(key) === entry) latest.delete(key);
      Promise.resolve().then(remove).catch(() => {});
    }, ttl);
    entry.timer?.unref?.();
    if (old) await Promise.resolve().then(old.remove).catch(() => {});
  };
  keep.forget = (key, id) => {
    const entry = latest.get(key);
    if (entry?.id !== id) return;
    cancel(entry.timer);
    latest.delete(key);
  };
  return keep;
}

const keepLatest = createNoticeKeeper();

/** 기존 reply 반환값·오류·응답 기한은 그대로 두고, 전송 성공 후에만 정리합니다. */
export function installNoticeCleanup(interaction) {
  if (!interaction.user || interaction.__noticeCleanup) return;
  interaction.__noticeCleanup = true;
  const key = `${interaction.applicationId}:${interaction.guildId}:${interaction.channelId}:${interaction.user.id}`;
  let originalPayload = {};
  let ownsOriginal = false;
  const defer = interaction.deferReply?.bind(interaction);
  if (defer) interaction.deferReply = async (...args) => {
    const result = await defer(...args);
    ownsOriginal = true;
    return result;
  };
  for (const method of ['reply', 'editReply', 'followUp']) {
    const original = interaction[method]?.bind(interaction);
    if (!original) continue;
    interaction[method] = async (payload, ...args) => {
      const result = await original(payload, ...args);
      if (method === 'reply') ownsOriginal = true;
      // deferUpdate 뒤 editReply는 누른 패널 자체를 수정합니다. 그 패널은 정리 대상이 아닙니다.
      if (method === 'editReply' && !ownsOriginal) return result;
      const p = typeof payload === 'string' ? { content: payload } : payload ?? {};
      const merged = method === 'editReply' ? { ...originalPayload, ...p } : p;
      if (method !== 'followUp') originalPayload = merged;
      const ephemeral = method === 'editReply'
        ? interaction.ephemeral
        : Boolean(Number(p.flags?.bitfield ?? p.flags ?? 0) & MessageFlags.Ephemeral);
      if (ephemeral && isConfirmation(merged)) {
        const id = method === 'followUp' ? result?.id : '@original';
        if (id) {
          const ttl = Math.max(1, (interaction.createdTimestamp ?? Date.now()) + 14 * 60_000 - Date.now());
          const remove = () => method === 'followUp'
            ? interaction.webhook.deleteMessage(id)
            : interaction.deleteReply();
          await keepLatest(key, `${interaction.id}:${id}`, remove, ttl);
        }
      } else if (method !== 'followUp') {
        keepLatest.forget(key, `${interaction.id}:@original`);
      }
      return result;
    };
  }
}
