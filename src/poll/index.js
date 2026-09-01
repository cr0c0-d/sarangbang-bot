// 투표 — 선택지마다 글자와 사진을 붙여 만들고, 버튼으로 고릅니다.
//
// 왜 직접 만드는가:
//   디스코드에 기본 투표 기능이 있지만 **선택지에 이미지를 못 넣습니다** (글자 + 이모지만).
//   "글자와 이미지의 조합으로 문항을 만들고 싶다" 가 요구사항이라 직접 만들었습니다.
//
// 사용법을 어떻게 줄였는가 (비개발자 친구들이 씁니다):
//   선택지를 칸마다 따로 받으면 입력칸이 열 개가 넘습니다. 그래서 **한 칸에 쉼표로** 받습니다.
//     /투표 질문:점심 뭐 먹지  선택:피자, 치킨, 초밥
//   사진은 필요한 것만 번호로 붙입니다. 안 붙여도 됩니다.
//     /투표 질문:어떤 옷?  선택:A, B  사진1:[첨부]  사진2:[첨부]
//
// ⚠️ 사진은 **투표 메시지에 다시 올립니다.** 명령어로 받은 첨부 주소는 시간이 지나면
//    만료되기 때문입니다. 다시 올리면 그 메시지가 살아 있는 한 계속 보입니다.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  MessageFlags,
  PermissionsBitField,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  FileUploadBuilder,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.dataDir, 'polls.json');

/** 선택지 최대 개수. 버튼 두 줄로 담기는 만큼입니다. */
const MAX_OPTIONS = 10;
/** 사진은 임베드 하나당 하나씩 붙습니다. 메시지가 너무 길어지지 않게 5개까지만. */
const MAX_IMAGES = 5;
/** 오래된 투표를 정리하는 기준. 파일이 무한정 커지지 않게 합니다. */
const KEEP_DAYS = 90;

const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** @type {{ [messageId: string]: Poll }} */
let store = {};
let writeChain = Promise.resolve();

function save() {
  writeChain = writeChain
    .then(() => fs.writeFile(FILE, JSON.stringify(store), 'utf8'))
    .catch((e) => console.error('[poll] 저장 실패:', e.message));
  return writeChain;
}

/** 저장이 디스크에 실제로 내려갈 때까지 기다립니다. (종료·검증용) */
export function flushPolls() {
  return writeChain;
}

// ── 자동 마감 ──────────────────────────────────────────────
//
// 투표를 만들 때 "몇 분 뒤에 닫을지" 를 정할 수 있습니다.
// 켜고 끄는 스위치를 따로 두지 않았습니다 — **비우면 안 함**, 숫자를 넣으면 그때 닫힘.
// 칸 하나로 둘 다 되고, 모달 칸 한도(5개)도 지킬 수 있습니다.
//
// ⚠️ setTimeout 은 재시작하면 사라집니다. 그래서 마감 시각을 **디스크에 적어두고**,
//    봇이 켜질 때 되살립니다 (타이머 기능과 같은 방식, 3.4-2).

/** 최대 7일. setTimeout 한계(약 24.8일)보다 훨씬 짧게 잡아둡니다. */
export const CLOSE_MAX_MINUTES = 7 * 24 * 60;

/** @type {Map<string, NodeJS.Timeout>} 메시지ID → 예약된 마감 */
const closeTimers = new Map();

/**
 * "30", "30분", " 45 " 를 분(minute)으로 읽습니다.
 * 비었거나 숫자가 없으면 **null = 자동 마감 안 함** 입니다.
 */
export function parseMinutes(raw) {
  const n = Number(String(raw ?? '').match(/\d+/)?.[0]);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, CLOSE_MAX_MINUTES);
}

function cancelClose(messageId) {
  const t = closeTimers.get(messageId);
  if (t) clearTimeout(t);
  closeTimers.delete(messageId);
}

/** 마감 시각이 되면 닫습니다. 이미 지났으면 바로 닫습니다. */
function scheduleClose(client, messageId) {
  const poll = store[messageId];
  if (!poll || poll.closed || !poll.closesAt) return;

  cancelClose(messageId);
  const delay = Math.max(0, poll.closesAt - Date.now());
  closeTimers.set(
    messageId,
    setTimeout(() => {
      closeTimers.delete(messageId);
      closePoll(client, messageId, true).catch((e) => console.error('[poll] 자동 마감 실패:', e.message));
    }, delay)
  );
}

/** 투표를 닫고 메시지를 갱신합니다. */
async function closePoll(client, messageId, auto) {
  const poll = store[messageId];
  if (!poll || poll.closed) return;

  poll.closed = true;
  poll.closedAuto = Boolean(auto);
  save();
  cancelClose(messageId);

  // 메시지를 못 찾아도 집계는 이미 닫혔습니다. 화면 갱신만 실패하는 것입니다.
  if (!poll.channelId) return; // 이 기능 이전에 만든 투표는 채널을 모릅니다
  const channel = await client.channels.fetch(poll.channelId).catch(() => null);
  const message = await channel?.messages?.fetch(messageId).catch(() => null);
  if (!message) return;

  // files 를 넘기지 않으면 붙어 있던 사진은 그대로 남습니다.
  await message.edit(buildPoll(poll)).catch((e) => console.error('[poll] 마감 표시 실패:', e.message));
}

/**
 * 봇이 켜질 때 예약을 되살립니다. (ClientReady 에서 부릅니다)
 * 꺼져 있는 동안 시각이 지난 것은 **즉시 닫습니다** — 영원히 열려 있으면 안 됩니다.
 */
export function restorePollDeadlines(client) {
  let revived = 0;
  for (const [messageId, poll] of Object.entries(store)) {
    if (poll?.closed || !poll?.closesAt) continue;
    scheduleClose(client, messageId);
    revived++;
  }
  if (revived > 0) console.log(`   자동 마감 예약 ${revived}건 복구`);
}

export async function initPolls() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const loaded = JSON.parse(await fs.readFile(FILE, 'utf8'));
    store = loaded && typeof loaded === 'object' ? loaded : {};
  } catch {
    store = {};
  }

  // 오래된 것은 버립니다. 투표 메시지는 남지만 버튼이 "찾을 수 없다" 고 답합니다.
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  let dropped = 0;
  for (const [id, poll] of Object.entries(store)) {
    if ((poll?.createdAt ?? 0) < cutoff) {
      delete store[id];
      dropped++;
    }
  }
  if (dropped > 0) {
    console.log(`   오래된 투표 ${dropped}개 정리 (${KEEP_DAYS}일 지남)`);
    save();
  }
}

/** 쉼표·줄바꿈 어느 쪽으로 나눠 써도 되게 합니다. */
export function parseOptions(raw) {
  return String(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
}

/** 표를 세어 봅니다. */
export function tally(poll) {
  const counts = new Array(poll.options.length).fill(0);
  for (const idx of Object.values(poll.votes ?? {})) {
    if (counts[idx] !== undefined) counts[idx]++;
  }
  return { counts, total: counts.reduce((a, b) => a + b, 0) };
}

/** 0~100% 를 막대로. 한눈에 비교되게 합니다. */
function bar(percent) {
  const filled = Math.round((percent / 100) * 12);
  return '█'.repeat(filled) + '░'.repeat(12 - filled);
}

/** 투표 메시지(임베드 + 버튼)를 만듭니다. */
export function buildPoll(poll) {
  const { counts, total } = tally(poll);

  const lines = poll.options.map((opt, i) => {
    const pct = total === 0 ? 0 : Math.round((counts[i] / total) * 100);
    return `${NUM[i]} **${opt.label}**\n\`${bar(pct)}\` ${counts[i]}표 · ${pct}%`;
  });

  // 자동 마감이 걸려 있으면 **언제 닫히는지** 보여줍니다.
  // 디스코드 시각 표시(<t:초:R>)는 보는 사람의 시간대로 "3분 후" 처럼 알아서 세어줍니다.
  // ⚠️ 이건 **본문에서만** 렌더링됩니다. 푸터에 넣으면 `<t:...>` 글자가 그대로 보입니다.
  if (!poll.closed && poll.closesAt) {
    lines.push(`⏳ <t:${Math.floor(poll.closesAt / 1000)}:R> 자동으로 마감됩니다.`);
  }

  const head = new EmbedBuilder()
    .setColor(poll.closed ? 0x99aab5 : 0x5865f2)
    .setTitle(`${poll.closed ? '🔒' : '🗳️'} ${poll.question}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({
      text: poll.closed
        ? `${poll.closedAuto ? '시간이 되어 자동 마감' : '투표 마감'} · 총 ${total}표`
        : `총 ${total}표 · 버튼을 누르면 투표합니다 (다시 누르면 취소)`,
    });

  // 질문 사진은 **크게** 붙입니다. 무엇을 고르는 건지 보여주는 주인공이기 때문입니다.
  // (선택지 사진은 여러 장이라 작게 붙입니다 — 다 크면 메시지가 끝없이 길어집니다)
  if (poll.image) head.setImage(`attachment://${poll.image}`);

  const embeds = [head];

  // 사진이 있는 선택지는 임베드를 하나씩 더 붙입니다.
  //
  // ★ 썸네일(setThumbnail)이 아니라 **큰 이미지(setImage)** 를 씁니다.
  //   처음에는 메시지가 길어지지 않게 썸네일로 붙였는데, **모바일에서는 썸네일을 눌러도
  //   확대되지 않습니다**(PC 는 됩니다 — 소유자 확인). 사진을 보고 고르는 기능인데
  //   폰에서 크게 못 보면 쓸모가 없습니다. 길어지는 것보다 보이는 쪽이 낫습니다.
  //   되돌리지 말 것.
  for (const [i, opt] of poll.options.entries()) {
    if (!opt.image) continue;
    embeds.push(
      new EmbedBuilder()
        .setColor(poll.closed ? 0x99aab5 : 0x5865f2)
        .setDescription(`${NUM[i]} **${opt.label}**`)
        .setImage(`attachment://${opt.image}`)
    );
  }

  const rows = [];
  for (let i = 0; i < poll.options.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        poll.options.slice(i, i + 5).map((opt, j) =>
          new ButtonBuilder()
            .setCustomId(`v:${i + j}`)
            .setEmoji(NUM[i + j])
            .setLabel(cut(opt.label, 40))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(poll.closed)
        )
      )
    );
  }

  if (!poll.closed) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('v:close').setEmoji('🔒').setLabel('마감').setStyle(ButtonStyle.Danger)
      )
    );
  }

  return { embeds, components: rows };
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 첨부 파일 이름을 안전하게. 확장자만 살리고 번호로 다시 짓습니다. */
function imageName(attachment, index) {
  const ext = (attachment.name?.match(/\.(png|jpe?g|gif|webp)$/i)?.[0] ?? '.png').toLowerCase();
  // index 가 -1 이면 질문 사진입니다. 선택지 번호와 겹치면 안 됩니다.
  return index < 0 ? `poll-q${ext}` : `poll-${index + 1}${ext}`;
}

/**
 * 투표 만들기 창(모달).
 *
 * 예전에는 슬래시 명령어 칸에 전부 적어야 했는데, 칸이 일곱 개라 **헷갈리고 번거로웠습니다**
 * (소유자 피드백). 이제 `/투표` 만 치면 이 창이 뜨고, 한 화면에서 다 채웁니다.
 *
 * ⚠️ 모달에 **파일 업로드 칸을 넣을 수 있습니다**(`FileUploadBuilder`).
 *    예전 디스코드에서는 글자만 받을 수 있어서 사진을 명령어 칸으로 받아야 했습니다.
 *    이 컴포넌트를 빼면 다시 그 불편으로 돌아갑니다.
 */
export function buildCreateModal() {
  return new ModalBuilder()
    .setCustomId('v:new')
    .setTitle('투표 만들기')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('질문')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('q')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('점심 뭐 먹지?')
            .setMaxLength(200)
            .setRequired(true)
        ),
      new LabelBuilder()
        .setLabel('선택지')
        .setDescription(`한 줄에 하나씩 적어주세요. 최대 ${MAX_OPTIONS}개.`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('opts')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('피자\n치킨\n초밥')
            .setRequired(true)
        ),
      new LabelBuilder()
        .setLabel('질문 사진 (선택)')
        .setDescription('질문 아래에 크게 붙습니다. 한 장.')
        .setFileUploadComponent(
          new FileUploadBuilder().setCustomId('qimg').setRequired(false).setMinValues(0).setMaxValues(1)
        ),
      new LabelBuilder()
        .setLabel('선택지 사진 (선택)')
        .setDescription(`안 넣어도 됩니다. 넣으면 **선택지 순서대로** 붙습니다. 최대 ${MAX_IMAGES}장.`)
        .setFileUploadComponent(
          new FileUploadBuilder().setCustomId('imgs').setRequired(false).setMinValues(0).setMaxValues(MAX_IMAGES)
        ),
      // 켜고 끄는 스위치를 따로 두지 않았습니다. **비우면 안 함** 이 곧 off 입니다.
      // 칸 하나로 둘 다 되고, 모달 칸 한도(5개)에 딱 맞습니다.
      new LabelBuilder()
        .setLabel('자동 마감 (분)')
        .setDescription('비우면 자동으로 닫지 않습니다. 숫자를 넣으면 그만큼 뒤에 닫힙니다.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('close')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('예: 30')
            .setMaxLength(6)
            .setRequired(false)
        )
    );
}

/**
 * 투표 메시지를 만들어 띄웁니다. 모달과 명령어 인자 양쪽에서 같이 씁니다.
 *
 * @param {string[]} labels 선택지 글자
 * @param {Array<{url: string, contentType?: string, name?: string}>} images 선택지 순서대로
 * @param {{url: string, name?: string}|null} questionImage 질문 아래에 크게 붙일 사진
 * @param {number|null} closeMinutes 몇 분 뒤 자동 마감할지. null 이면 안 함
 */
export async function createPoll(interaction, question, labels, images, questionImage = null, closeMinutes = null) {
  const options = labels.map((label) => ({ label, image: null }));
  const files = [];
  let headImage = null;

  if (questionImage?.url) {
    headImage = imageName(questionImage, -1); // poll-q.png
    files.push(new AttachmentBuilder(questionImage.url, { name: headImage }));
  }

  // 사진은 받은 주소를 그대로 쓰지 않고 **투표 메시지에 다시 올립니다.**
  // 업로드로 받은 주소는 만료되어 나중에 사진이 깨집니다.
  for (let i = 0; i < Math.min(labels.length, MAX_IMAGES, images.length); i++) {
    const att = images[i];
    if (!att?.url) continue;
    const name = imageName(att, i);
    options[i].image = name;
    files.push(new AttachmentBuilder(att.url, { name }));
  }

  const poll = {
    question: cut(question.trim(), 200),
    image: headImage,
    options,
    votes: {},
    createdBy: interaction.user.id,
    guildId: interaction.guildId,
    // 마감할 때 메시지를 다시 찾아야 합니다. 채널을 모르면 화면을 못 고칩니다.
    channelId: interaction.channelId,
    closed: false,
    closedAuto: false,
    closesAt: closeMinutes ? Date.now() + closeMinutes * 60_000 : null,
    createdAt: Date.now(),
  };

  const message = await interaction.editReply({ ...buildPoll(poll), files });
  store[message.id] = poll;
  save();
  // 예약은 메시지 ID 를 알아야 걸 수 있으므로 저장한 뒤에 겁니다.
  if (poll.closesAt) scheduleClose(interaction.client, message.id);
  return poll;
}

/** 선택지가 모자랄 때 보여줄 안내. 어디서 잘못됐는지 알려줘야 합니다. */
function tooFewOptions(interaction, hint) {
  return interaction.reply({
    content: `선택지가 2개 이상이어야 합니다.\n${hint}`,
    flags: MessageFlags.Ephemeral,
  });
}

/** 모달에서 올린 파일. 버전에 따라 배열/컬렉션 어느 쪽으로도 올 수 있어 둘 다 받습니다. */
function uploadedFiles(fields, id) {
  try {
    const got = fields.getUploadedFiles?.(id);
    if (!got) return [];
    return typeof got.values === 'function' ? [...got.values()] : [...got];
  } catch {
    return []; // 안 올렸으면 없는 칸입니다
  }
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('투표')
      .setDescription('투표를 만듭니다 (창이 뜨면 질문·선택지·사진을 채우면 됩니다)')
      // 칸을 비우고 실행하면 창이 뜹니다. 아래 둘은 **한 줄로 빨리** 만들고 싶을 때만 씁니다.
      .addStringOption((o) => o.setName('질문').setDescription('비우면 만들기 창이 뜹니다').setRequired(false))
      .addStringOption((o) =>
        o.setName('선택').setDescription('쉼표로 구분.  예: 피자, 치킨, 초밥').setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName('자동마감')
          .setDescription('몇 분 뒤에 닫을지. 비우면 안 닫습니다')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(CLOSE_MAX_MINUTES)
      ),

    async execute(interaction) {
      const question = interaction.options.getString('질문');
      const choices = interaction.options.getString('선택');

      // 기본 경로: 칸을 비우고 실행 → 만들기 창.
      if (!question || !choices) {
        return interaction.showModal(buildCreateModal());
      }

      // 빠른 경로: 인자를 다 채워서 실행 (사진은 창으로만 붙일 수 있습니다).
      const labels = parseOptions(choices);
      if (labels.length < 2) {
        return tooFewOptions(interaction, '**쉼표로 구분해서** 써주세요.  예: `선택:피자, 치킨, 초밥`');
      }
      await interaction.deferReply();
      await createPoll(interaction, question, labels, [], null, interaction.options.getInteger("자동마감"));
    },
  },
];

/** 만들기 창을 제출했을 때. customId 가 `v:new` 입니다. */
export async function handlePollModal(interaction) {
  const question = interaction.fields.getTextInputValue('q');
  const labels = parseOptions(interaction.fields.getTextInputValue('opts'));

  if (labels.length < 2) {
    return tooFewOptions(interaction, '**한 줄에 하나씩** 적어주세요.');
  }

  const onlyImages = (list) => list.filter((f) => !f.contentType || f.contentType.startsWith('image/'));
  const images = onlyImages(uploadedFiles(interaction.fields, 'imgs'));
  const questionImage = onlyImages(uploadedFiles(interaction.fields, 'qimg'))[0] ?? null;

  let closeMinutes = null;
  try {
    closeMinutes = parseMinutes(interaction.fields.getTextInputValue('close'));
  } catch {
    closeMinutes = null; // 칸이 없는 예전 창에서 온 제출
  }

  // 사진을 다시 올리는 데 시간이 걸립니다. 먼저 응답을 잡아둡니다.
  await interaction.deferReply();
  await createPoll(interaction, question, labels, images, questionImage, closeMinutes);
}

/** 투표 버튼 처리. customId 가 `v:` 로 시작하는 것만 옵니다. */
export async function handlePollComponent(interaction) {
  const poll = store[interaction.message.id];
  if (!poll) {
    // 봇이 오래 꺼져 있었거나 90일이 지난 투표입니다.
    return interaction.reply({
      content: '이 투표는 더 이상 집계하지 않습니다. `/투표` 로 새로 만들어주세요.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (poll.closed) {
    return interaction.reply({ content: '이미 마감된 투표입니다.', flags: MessageFlags.Ephemeral });
  }

  const id = interaction.customId.slice(2);

  if (id === 'close') {
    // 만든 사람과 서버 관리자만 마감할 수 있습니다.
    const isOwner = interaction.user.id === poll.createdBy;
    const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages);
    if (!isOwner && !isAdmin) {
      return interaction.reply({
        content: '투표를 만든 사람만 마감할 수 있습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }
    poll.closed = true;
    poll.closedAuto = false;
    save();
    // 예약이 걸려 있었다면 취소합니다. 안 그러면 닫힌 투표를 또 닫으려 합니다.
    cancelClose(interaction.message.id);
    return interaction.update(buildPoll(poll));
  }

  const idx = Number(id);
  if (!Number.isInteger(idx) || !poll.options[idx]) return;

  // 같은 것을 다시 누르면 취소, 다른 것을 누르면 옮깁니다.
  // "취소" 버튼을 따로 두지 않아도 되므로 버튼이 하나 줄어듭니다.
  const before = poll.votes[interaction.user.id];
  let toast;
  if (before === idx) {
    delete poll.votes[interaction.user.id];
    toast = '투표를 취소했습니다.';
  } else {
    poll.votes[interaction.user.id] = idx;
    toast = `**${poll.options[idx].label}** 에 투표했습니다.`;
  }
  save();

  await interaction.update(buildPoll(poll));
  // 누가 무엇을 골랐는지는 남에게 보이지 않습니다. 본인에게만 알려줍니다.
  await interaction.followUp({ content: toast, flags: MessageFlags.Ephemeral }).catch(() => {});
}
