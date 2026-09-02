// "나만 보이는 화면" 을 채팅방 모두에게 한 번 보여주는 버튼.
//
// 왜 이렇게 만들었나 (소유자 요청):
//   "/도움말 같은 걸 한번씩 전체공지하고 싶다. 자주는 아니라서 명령어를 추가하긴 싫다."
//
// 생각해본 방법들:
//   1. `/도움말 공개:true` 처럼 **인자를 추가** — 명령어마다 인자가 하나씩 늘고,
//      쓰는 사람이 그 인자가 있다는 걸 알아야 합니다. 자주 쓰지 않는 기능일수록 잊힙니다.
//   2. `/공지` 같은 **명령어를 추가** — 소유자가 원하지 않았고, 3.6-6 규칙에도 어긋납니다.
//   3. ★ 그 화면에 **버튼을 붙이기** — 화면을 본 사람에게만 보이고, 누르면 그 자리에서
//      같은 내용이 채팅방에 올라갑니다. 외울 것이 없습니다.
//
// 3번을 골랐습니다. 이 저장소의 규칙과도 맞습니다 — "자주 쓰는 조작은 버튼으로".
//
// ★ **상태를 저장하지 않습니다.** 누른 그 메시지의 내용을 그대로 다시 올립니다.
//   그래서 어떤 화면에든 붙일 수 있고, 화면을 고쳐도 이 파일은 손댈 일이 없습니다.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';

const SHARE_ID = 'share:now';

/**
 * 나만 보이는 응답에 "모두에게 보이기" 버튼을 붙입니다.
 *
 * @param {object} payload `interaction.reply()` 에 넘길 그 객체
 * @returns {object} 버튼이 붙은 같은 객체
 */
export function withShareButton(payload) {
  const rows = [...(payload.components ?? [])];
  // 한 메시지에 5줄까지입니다. 꽉 찼으면 버튼을 포기합니다 —
  // 있으면 좋은 기능이 원래 화면을 깨뜨리면 안 됩니다.
  if (rows.length >= 5) return payload;

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(SHARE_ID)
        .setEmoji('📢')
        .setLabel('모두에게 보이기')
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return { ...payload, components: rows };
}

/** 이 버튼인가. (index.js 가 라우팅할 때 씁니다) */
export function isShareComponent(customId) {
  return customId === SHARE_ID;
}

/**
 * 누른 그 화면을 채팅방에 올립니다.
 *
 * ⚠️ **버튼·드롭다운은 같이 올리지 않습니다.** 그건 누른 사람의 나만 보이는 화면에
 *    묶인 것이라, 남이 눌러도 동작하지 않거나 엉뚱하게 동작합니다.
 *    올리는 것은 **글과 임베드**뿐입니다.
 */
export async function handleShareComponent(interaction) {
  const { content, embeds } = interaction.message;
  if (!content && embeds.length === 0) {
    return interaction.reply({ content: '올릴 내용이 없습니다.', flags: MessageFlags.Ephemeral });
  }

  const sent = await interaction.channel
    .send({
      content: content || undefined,
      embeds,
      // 공지라도 자고 있는 사람을 깨울 이유는 없습니다.
      flags: MessageFlags.SuppressNotifications,
      allowedMentions: { parse: [] }, // 내용에 멘션이 있어도 알림을 쏘지 않습니다
    })
    .then(
      () => true,
      (err) => {
        console.error('[share] 올리기 실패:', err.message);
        return false;
      }
    );

  if (!sent) {
    return interaction.reply({
      content: '⚠️ 이 채팅방에 글을 쓸 권한이 없습니다. 봇 권한을 확인해주세요.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // 버튼을 없애 **두 번 올리는 것을 막습니다.** 눌렀는지 눌렀는지 헷갈리지 않게.
  const rows = interaction.message.components.filter(
    (r) => !JSON.stringify(r).includes(SHARE_ID)
  );
  await interaction.update({ components: rows }).catch(() => {});
  await interaction
    .followUp({ content: '📢 채팅방에 올렸습니다.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}
