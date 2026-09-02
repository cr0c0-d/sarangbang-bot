// /정산 — 한 사람이 결제하고 나머지가 송금하는 흐름을 그대로 옮긴 것입니다.
//
// 지금까지는 채널에 `[누구-얼마, 누구-얼마]` 를 적어두고 각자 송금했습니다.
// 그러면 **누가 보냈는지 세어야** 하고, 다 보냈는지 확인하려면 위로 올라가 읽어야 합니다.
//
// 그래서 목록과 **송금 버튼**을 만들어줍니다. 실제 송금은 사람이 합니다 —
// 계좌·금융 API 는 범위 밖이고, **버튼은 "보냈다는 표시"** 일 뿐입니다.
//
// ★ 모달에 **사람 고르기 칸**을 넣을 수 있어서 한 화면에서 끝납니다. (2026-09-01 확인)
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getPlan } from './store.js';

const FILE = path.join(config.dataDir, 'settlements.json');
const KEEP_DAYS = 120;

/** @type {{ [messageId: string]: Settlement }} */
let store = {};
let writeChain = Promise.resolve();

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store), 'utf8'))
    .catch((e) => console.error('[settle] 저장 실패:', e.message));
  return writeChain;
}

export function flushSettlements() {
  return writeChain;
}

export async function initSettlements() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = loaded && typeof loaded === 'object' ? loaded : {};
  } catch {
    store = {};
  }
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  let dropped = 0;
  for (const [id, s] of Object.entries(store)) {
    if ((s?.createdAt ?? 0) < cutoff) {
      delete store[id];
      dropped++;
    }
  }
  if (dropped > 0) {
    console.log(`   지난 정산 ${dropped}개 정리`);
    save();
  }
}

const won = (n) => `${n.toLocaleString('ko-KR')}원`;

/**
 * 고른 사람들의 ID를 **고른 순서대로** 돌려줍니다.
 *
 * ⚠️ **`getSelectedUsers()` 를 쓰지 마세요.** 그건 `resolved.users` **객체**를 훑어
 *    만든 Collection 이라, 순서가 **디스코드가 그 객체를 어떤 순서로 내보냈는지**에
 *    달려 있습니다. 고른 순서와 다를 수 있습니다.
 *
 * 실제로 겪은 일: 금액 `100`·`1000` 과 사람 `A(본인)`·`B` 를 넣었더니
 * **A 에 1000원, B 에 100원**이 붙었습니다. 순서가 뒤집힌 것입니다.
 *
 * `values` 는 고른 값이 담긴 **배열**이라 순서가 그대로입니다. 그걸 씁니다.
 * (배열이 없는 경우에만 Collection 으로 물러납니다 — 없는 것보다 낫습니다)
 */
export function selectedUserIds(interaction, customId) {
  const field = interaction.fields.getField(customId);
  if (Array.isArray(field?.values) && field.values.length > 0) return [...field.values];
  return [...interaction.fields.getSelectedUsers(customId).keys()];
}

/**
 * 금액 칸을 읽습니다.
 *
 * 숫자 **하나**면 총액을 인원수로 **균등분할**합니다 (가장 흔한 경우).
 * 줄 수가 인원수와 같으면 **순서대로 개별 금액**입니다 —
 * 그 "순서" 는 `selectedUserIds()` 가 돌려주는 순서(= 고른 순서)입니다.
 * `120,000` `12만` `120000원` 처럼 적어도 읽습니다.
 */
export function parseAmounts(raw, count) {
  const nums = String(raw ?? '')
    .split('\n')
    .map((line) => {
      const t = line.replace(/[,\s원]/g, '');
      if (!t) return null;
      const man = t.match(/^(\d+(?:\.\d+)?)만$/); // 12만 → 120000
      if (man) return Math.round(Number(man[1]) * 10000);
      const n = Number(t.match(/\d+/)?.[0]);
      return Number.isFinite(n) && n > 0 ? n : null;
    })
    .filter((n) => n !== null);

  if (nums.length === 0 || count < 1) return null;

  if (nums.length === 1) {
    // 균등분할. 나누어떨어지지 않으면 **첫 사람이 남는 1원씩** 더 냅니다.
    // 총액이 어긋나면 안 되므로 어딘가는 반드시 몰아야 합니다.
    const base = Math.floor(nums[0] / count);
    const rest = nums[0] - base * count;
    return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
  }
  if (nums.length === count) return nums;
  return null; // 개수가 안 맞습니다
}

export function buildSettlement(s) {
  const owe = s.shares.filter((x) => x.userId !== s.payerId);
  const paid = owe.filter((x) => x.sent).reduce((a, b) => a + b.amount, 0);
  const owed = owe.reduce((a, b) => a + b.amount, 0);
  const allDone = owe.length > 0 && owe.every((x) => x.sent);

  const rows = s.shares.map((x) =>
    x.userId === s.payerId
      ? `<@${x.userId}>  ${won(x.amount)}  _(결제자)_`
      : `<@${x.userId}>  ${won(x.amount)}  ${x.sent ? '✅ 보냈어요' : '⬜ 송금 전'}`
  );

  const embed = new EmbedBuilder()
    .setColor(allDone ? 0x57f287 : 0xfee75c)
    .setTitle(`💰 ${s.title}`)
    .setDescription(
      [
        `결제: <@${s.payerId}> · 총 ${won(s.total)} · ${s.shares.length}명`,
        '',
        ...rows,
        '',
        allDone ? '**정산 완료** 🎉' : `받을 돈  ${won(paid)} / ${won(owed)}`,
      ].join('\n')
    )
    .setFooter({ text: '실제 송금은 각자 하시고, 보내면 버튼을 눌러주세요' });

  if (allDone) return { embeds: [embed], components: [] };

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('st:sent').setEmoji('✅').setLabel('보냈어요').setStyle(ButtonStyle.Success)
  );
  // ✏️ 고치기는 **아무도 보냈다고 하지 않았을 때만** 보여줍니다 (소유자 요청).
  // 한 명이라도 보낸 뒤에 금액이 바뀌면 그 사람이 얼마를 보냈는지 알 수 없게 됩니다.
  if (canEdit(s)) {
    row.addComponents(
      new ButtonBuilder().setCustomId('st:edit').setEmoji('✏️').setLabel('고치기').setStyle(ButtonStyle.Secondary)
    );
  }
  return { embeds: [embed], components: [row] };
}

/**
 * 고칠 수 있는가 — **아무도 "보냈어요" 를 누르지 않았을 때만.**
 *
 * 왜 이 경계인가: 누군가 보낸 뒤에 금액을 바꾸면 **그 사람이 실제로 보낸 금액과
 * 목록의 금액이 어긋납니다.** 그러면 정산이 오히려 헷갈리게 됩니다.
 * 그때는 새로 만드는 게 맞습니다.
 */
export function canEdit(s) {
  return !s.shares.some((x) => x.sent);
}

/**
 * 고치기 창. **사람은 그대로 두고 내용·금액만** 고칩니다.
 *
 * 왜 사람은 못 고치나: 모달의 사람 고르기 칸에는 **지금 값을 미리 채워둘 수 없습니다.**
 * 빈 칸으로 띄우면 다시 전부 고르게 되고, 그러면 순서가 또 바뀌어 금액이 어긋납니다
 * (그 버그를 방금 고쳤습니다). 사람을 바꿔야 하면 새로 만드는 편이 안전합니다.
 *
 * @param {object} s 지금 정산
 * @param {(userId: string) => string} nameOf 사람 이름을 찾아주는 함수 (순서를 보여주려고)
 */
export function buildEditModal(s, nameOf = (id) => id) {
  const order = s.shares.map((x, i) => `${i + 1}. ${nameOf(x.userId)}`).join(' · ');
  return new ModalBuilder()
    .setCustomId('st:edit')
    .setTitle('정산 고치기')
    .addLabelComponents(
      new LabelBuilder().setLabel('내용').setTextInputComponent(
        new TextInputBuilder()
          .setCustomId('title')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(s.title)
      ),
      new LabelBuilder()
        .setLabel('금액')
        // 순서를 보여줘야 어느 줄이 누구인지 알 수 있습니다. 드롭다운은 순서를 안 보여줍니다.
        .setDescription(`이 순서대로 한 줄씩 — ${order}`.slice(0, 100))
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('amount')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setValue(s.shares.map((x) => String(x.amount)).join('\n'))
        )
    );
}

export const commands = [
  {
    data: new SlashCommandBuilder().setName('정산').setDescription('결제한 돈을 나눠서 정산 목록을 만듭니다'),
    async execute(interaction) {
      // 이 채널에 일정이 있으면 제목을 미리 채워둡니다. 또 타이핑하지 않게.
      const plan = getPlan(interaction.channelId);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('st:new')
          .setTitle('정산 만들기')
          .addLabelComponents(
            new LabelBuilder().setLabel('내용').setTextInputComponent(
              new TextInputBuilder()
                .setCustomId('title')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(plan?.title ?? '')
                .setPlaceholder('오사카 여행 숙소')
            ),
            new LabelBuilder()
              .setLabel('금액')
              .setDescription('숫자 하나면 균등분할. 여러 줄이면 아래에서 고른 순서대로 한 줄씩. (12만 · 120,000 도 됩니다)')
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId('amount')
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
                  .setPlaceholder('120000')
              ),
            new LabelBuilder()
              .setLabel('나눌 사람')
              .setDescription('고른 순서대로 위 금액이 붙습니다. 본인도 넣으면 자기 몫으로 표시되고 송금 대상에서는 빠집니다.')
              .setUserSelectMenuComponent(
                new UserSelectMenuBuilder().setCustomId('who').setRequired(true).setMinValues(1).setMaxValues(20)
              )
          )
      );
    },
  },
];

export async function handleSettleModal(interaction) {
  if (interaction.customId === 'st:edit') return handleEditSubmit(interaction);
  if (interaction.customId !== 'st:new') return;

  const users = selectedUserIds(interaction, 'who');
  const amounts = parseAmounts(interaction.fields.getTextInputValue('amount'), users.length);
  if (!amounts) {
    return interaction.reply({
      content:
        '금액을 읽지 못했습니다.\n' +
        `· 숫자 **하나**를 적으면 ${users.length}명이 나눠 냅니다.  예: \`120000\`\n` +
        `· 사람마다 다르면 **${users.length}줄**로 적어주세요.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const s = {
    title: interaction.fields.getTextInputValue('title').trim().slice(0, 100),
    payerId: interaction.user.id,
    total: amounts.reduce((a, b) => a + b, 0),
    shares: users.map((userId, i) => ({ userId, amount: amounts[i], sent: false })),
    createdAt: Date.now(),
  };

  await interaction.reply(buildSettlement(s));
  store[(await interaction.fetchReply()).id] = s;
  save();
}

/**
 * 고치기 창에서 확인을 눌렀을 때.
 *
 * ⚠️ 여기서 **다시 확인합니다.** 창을 띄운 뒤 확인을 누르기까지 몇 분이 걸릴 수 있고,
 *    그 사이에 누군가 "보냈어요" 를 누를 수 있습니다. 그러면 고치면 안 됩니다.
 */
async function handleEditSubmit(interaction) {
  const messageId = interaction.message?.id;
  const s = messageId ? store[messageId] : null;
  if (!s) {
    return interaction.reply({
      content: '이 정산은 더 이상 집계하지 않습니다. `/정산` 으로 새로 만들어주세요.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (interaction.user.id !== s.payerId) {
    return interaction.reply({ content: '결제한 사람만 고칠 수 있습니다.', flags: MessageFlags.Ephemeral });
  }
  if (!canEdit(s)) {
    return interaction.reply({
      content: '이미 누군가 **보냈어요** 를 눌렀습니다. 이제는 고칠 수 없습니다.\n금액이 틀렸다면 `/정산` 으로 새로 만들어주세요.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const amounts = parseAmounts(interaction.fields.getTextInputValue('amount'), s.shares.length);
  if (!amounts) {
    return interaction.reply({
      content:
        '금액을 읽지 못했습니다.\n' +
        `· 숫자 **하나**를 적으면 ${s.shares.length}명이 나눠 냅니다.\n` +
        `· 사람마다 다르면 **${s.shares.length}줄**로 적어주세요. (사람은 그대로입니다)`,
      flags: MessageFlags.Ephemeral,
    });
  }

  s.title = interaction.fields.getTextInputValue('title').trim().slice(0, 100) || s.title;
  // 사람과 순서는 그대로 두고 금액만 갈아 끼웁니다.
  s.shares = s.shares.map((x, i) => ({ ...x, amount: amounts[i] }));
  s.total = amounts.reduce((a, b) => a + b, 0);
  save();

  await interaction.update(buildSettlement(s));
  await interaction
    .followUp({ content: '✏️ 고쳤습니다.', flags: MessageFlags.Ephemeral })
    .catch(() => {});
}

export async function handleSettleComponent(interaction) {
  const s = store[interaction.message.id];
  if (!s) {
    return interaction.reply({
      content: '이 정산은 더 이상 집계하지 않습니다. `/정산` 으로 새로 만들어주세요.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.customId === 'st:edit') {
    if (interaction.user.id !== s.payerId) {
      return interaction.reply({ content: '결제한 사람만 고칠 수 있습니다.', flags: MessageFlags.Ephemeral });
    }
    if (!canEdit(s)) {
      return interaction.reply({
        content: '이미 누군가 **보냈어요** 를 눌렀습니다. 이제는 고칠 수 없습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }
    // 순서를 보여주려고 이름을 찾습니다. 못 찾으면 번호만 나옵니다.
    const nameOf = (id) =>
      interaction.guild?.members?.cache?.get(id)?.displayName ?? '알 수 없음';
    return interaction.showModal(buildEditModal(s, nameOf));
  }

  const mine = s.shares.find((x) => x.userId === interaction.user.id);
  if (!mine) {
    return interaction.reply({ content: '이 정산에 포함되지 않았습니다.', flags: MessageFlags.Ephemeral });
  }
  if (mine.userId === s.payerId) {
    return interaction.reply({ content: '결제하신 분은 송금할 게 없습니다 🙂', flags: MessageFlags.Ephemeral });
  }

  // 본인 줄만 토글합니다. 남의 것은 못 건드립니다.
  mine.sent = !mine.sent;
  save();
  await interaction.update(buildSettlement(s));
  await interaction
    .followUp({
      content: mine.sent ? '✅ 보냈다고 표시했습니다.' : '⬜ 표시를 지웠습니다.',
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
}
