// 일정 — 시간·장소·할 일을 한 판에 모아두고, 채널 생성까지 해줍니다.
//
// 소유자의 실제 사용 방식을 그대로 옮긴 기능입니다 (docs/일정-정산-기획.md):
//   「일정」 카테고리 아래 [yymmdd-일정명] 비공개 채널 → 참여자만 권한 →
//   숙소·예약 정보를 미리 보내둠 → 끝나면 사진 → 한 사람이 결제하고 정산
//
// ★ 자동 감지를 **하지 않습니다.** 채팅·사진은 중구난방으로 올라오므로 긁으면 쓰레기가 쌓입니다.
//   필요한 것만 **메시지 우클릭 → 앱 → 📌 일정에 등록** 으로 사람이 고릅니다.
//
// ★ 날짜 조율(투표)과 **이어주지 않습니다.** 소유자 표현대로 "과하다" — 정해지면 수기 입력.
import {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { parseWhen, formatWhen, yymmdd, titleFromChannelName } from './parse-when.js';
import { getPlan, setPlan, updatePlan, removePlan, scheduleReminder, cancelReminder } from './store.js';
import { get as getSetting, set as setSetting } from '../settings.js';

/** 할 일 버튼은 한 줄에 5개씩 두 줄까지. 그 이상은 목록으로만 보여줍니다. */
const TODO_BUTTONS = 10;

const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
const lines = (raw) =>
  String(raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

// ── 지도 링크 ─────────────────────────────────────────────
//
// 좌표도 API 키도 필요 없습니다. **검색어만 넣으면 됩니다.** (2026-09-01 실측, 둘 다 200)
// 가게 이름이든 주소든 그대로 넘기면 되고, 길찾기는 지도 앱이 알아서 제공합니다.
export const kakaoMapUrl = (q) => `https://map.kakao.com/?q=${encodeURIComponent(q)}`;
export const naverMapUrl = (q) => `https://map.naver.com/p/search/${encodeURIComponent(q)}`;

// ── 판 ────────────────────────────────────────────────────

export function buildPanel(plan) {
  const done = plan.todos.filter((t) => t.doneBy).length;

  const body = [`🕘 ${formatWhen(plan.at, plan.hasTime)} · <t:${Math.floor(plan.at / 1000)}:R>`];
  if (plan.place) body.push(`📍 ${plan.place}`);

  if (plan.todos.length > 0) {
    body.push(
      '',
      `**✅ 할 일  ${done}/${plan.todos.length}**`,
      ...plan.todos.map((t) => `${t.doneBy ? '✅' : '⬜'} ${t.text}${t.doneBy ? ` <@${t.doneBy}>` : ''}`)
    );
  }
  if (plan.notes.length > 0) {
    body.push('', '**📝 메모**', ...plan.notes.map((n) => `· ${n}`));
  }
  if (plan.refs.length > 0) {
    body.push('', '**📎 참고자료**', ...plan.refs.map((r) => `· [${r.label}](${r.url})`));
  }
  if (plan.todos.length > TODO_BUTTONS) {
    // 조용히 자르지 않고 왜 버튼이 일부만 있는지 적습니다 (재생목록 자르기와 같은 원칙).
    body.push('', `_버튼은 앞 ${TODO_BUTTONS}개만 있습니다. 나머지는 목록에서 확인하세요._`);
  }

  const embed = new EmbedBuilder()
    .setColor(plan.at < Date.now() ? 0x99aab5 : 0x5865f2)
    .setTitle(`📅 ${plan.title}`)
    .setDescription(body.join('\n'))
    .setFooter({ text: plan.remindAt ? '🔔 알림 예약됨' : '알림 없음' });

  const rows = [];

  // 1줄: 지도 (장소가 있을 때만)
  if (plan.place) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🗺️').setLabel('카카오맵').setURL(kakaoMapUrl(plan.place)),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setEmoji('🧭').setLabel('네이버지도').setURL(naverMapUrl(plan.place))
      )
    );
  }

  // 2~3줄: 할 일 토글
  const shown = plan.todos.slice(0, TODO_BUTTONS);
  for (let i = 0; i < shown.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        shown.slice(i, i + 5).map((t, j) =>
          new ButtonBuilder()
            .setCustomId(`pl:todo:${i + j}`)
            .setEmoji(t.doneBy ? '✅' : '⬜')
            .setLabel(cut(t.text, 40))
            .setStyle(t.doneBy ? ButtonStyle.Success : ButtonStyle.Secondary)
        )
      )
    );
  }

  // 마지막 줄: 조작
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pl:edit').setEmoji('✏️').setLabel('고치기').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pl:addtodo').setEmoji('➕').setLabel('할 일').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pl:note').setEmoji('📝').setLabel('메모').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pl:remind').setEmoji('🔔').setLabel('알림').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('pl:del').setEmoji('🗑️').setLabel('삭제').setStyle(ButtonStyle.Danger)
    )
  );

  return { embeds: [embed], components: rows };
}

// ── 모달 ──────────────────────────────────────────────────

/** 이 채널에 일정을 등록하는 창. 제목은 채널 이름에서 뽑아 미리 채웁니다. */
export function buildRegisterModal(channel, plan = null) {
  // ⚠️ **`setDescription(null)` 을 부르면 안 됩니다.** 검증기가 거부하고
  //    `Received one or more errors` 로 창이 아예 안 뜹니다 (실제로 겪음).
  //    값이 없으면 **아예 부르지 않아야** 합니다. setValue·setPlaceholder 도 같습니다.
  const t = (id, label, opts = {}) => {
    const input = new TextInputBuilder()
      .setCustomId(id)
      .setStyle(opts.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(Boolean(opts.required));
    if (opts.placeholder) input.setPlaceholder(opts.placeholder);
    if (opts.value) input.setValue(opts.value);

    const lbl = new LabelBuilder().setLabel(label);
    if (opts.hint) lbl.setDescription(opts.hint);
    return lbl.setTextInputComponent(input);
  };

  return new ModalBuilder()
    .setCustomId('pl:save')
    .setTitle(plan ? '일정 고치기' : '일정 등록')
    .addLabelComponents(
      t('title', '제목', {
        required: true,
        // 이미 채널 이름에 적어둔 것을 또 타이핑하지 않게 합니다.
        value: plan?.title ?? titleFromChannelName(channel?.name),
      }),
      t('when', '날짜 · 시간', {
        required: true,
        hint: '예: 10/3 18:30 · 2026-10-03 · 10월 3일 오후 6시 · 내일 19시',
        value: plan ? formatWhenForEdit(plan) : '',
      }),
      t('place', '장소', {
        hint: '가게 이름이나 주소. 지도 버튼이 붙습니다. 비워도 됩니다.',
        value: plan?.place ?? '',
      }),
      t('todos', '할 일', { long: true, hint: '한 줄에 하나씩. 비워도 됩니다.',
        value: plan ? plan.todos.map((x) => x.text).join('\n') : '' }),
      t('notes', '메모', { long: true, hint: '한 줄에 하나씩. 비워도 됩니다.',
        value: plan ? plan.notes.join('\n') : '' })
    );
}

/** 고치기 창에 넣을 날짜 문자열. 다시 파싱되는 형태로 돌려줍니다. */
function formatWhenForEdit(plan) {
  const d = new Date(plan.at);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return plan.hasTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

/**
 * 일정 카테고리를 고르는 판.
 *
 * `/채널설정` 의 채널 칸은 텍스트·음성·카테고리를 **한 목록에 섞어** 보여줍니다.
 * 디스코드가 "종류" 선택에 따라 목록을 바꿔주지 못하기 때문입니다.
 * 그래서 여기서는 **카테고리만** 나오는 드롭다운을 씁니다.
 */
export function buildCategoryPicker() {
  return {
    content:
      '먼저 **일정 채널을 만들 카테고리**를 골라주세요. 한 번만 고르면 됩니다.\n' +
      '(나중에 바꾸려면 `/채널설정` 에서 「일정 카테고리」 를 고르시면 됩니다)',
    components: [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('pl:cat')
          .setPlaceholder('카테고리 고르기')
          .addChannelTypes(ChannelType.GuildCategory)
      ),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

/** 새 채널을 만드는 창. 사람과 **역할** 둘 다 고를 수 있습니다. */
export function buildCreateChannelModal() {
  return new ModalBuilder()
    .setCustomId('pl:mk')
    .setTitle('일정 채널 만들기')
    .addLabelComponents(
      new LabelBuilder().setLabel('일정 이름').setTextInputComponent(
        new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('오사카 여행')
      ),
      new LabelBuilder()
        .setLabel('날짜 · 시간')
        .setDescription('채널 이름 앞에 yymmdd 로 붙습니다. 예: 10/3 18:30')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('when').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('10/3 18:30')
        ),
      new LabelBuilder()
        .setLabel('장소')
        .setDescription('비워도 됩니다.')
        .setTextInputComponent(
          new TextInputBuilder().setCustomId('place').setStyle(TextInputStyle.Short).setRequired(false)
        ),
      new LabelBuilder()
        .setLabel('참여자')
        .setDescription('고른 사람만 채널을 볼 수 있습니다.')
        .setUserSelectMenuComponent(
          new UserSelectMenuBuilder().setCustomId('users').setRequired(false).setMinValues(0).setMaxValues(20)
        ),
      new LabelBuilder()
        .setLabel('참여 역할')
        .setDescription('역할로 한꺼번에 넣을 수 있습니다.')
        .setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder().setCustomId('roles').setRequired(false).setMinValues(0).setMaxValues(10)
        )
    );
}

// ── 명령어 ────────────────────────────────────────────────

export const commands = [
  {
    data: new SlashCommandBuilder().setName('일정').setDescription('이 채널의 일정을 보거나 등록합니다'),
    async execute(interaction) {
      const plan = getPlan(interaction.channelId);
      // 없으면 등록 창, 있으면 판을 맨 아래로 다시 띄웁니다 (제어판과 같은 규칙 — 3.6-1).
      if (!plan) return interaction.showModal(buildRegisterModal(interaction.channel));
      await interaction.reply(buildPanel(plan));
      updatePlan(interaction.channelId, { panelMessageId: (await interaction.fetchReply()).id });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('일정새로')
      .setDescription('일정용 비공개 채널을 새로 만듭니다 (참여자·역할만 볼 수 있게)'),
    async execute(interaction) {
      const categoryId = getSetting(interaction.guildId, 'planCategoryId');
      // 아직 안 정했으면 **여기서 바로 고르게** 합니다.
      // `/채널설정` 으로 보내면, 그쪽 채널 목록에는 텍스트·음성 채널이 섞여 나와서
      // "카테고리를 고르라는데 채널만 보인다" 가 됩니다. 여기서는 카테고리만 보여줍니다.
      if (!categoryId) return interaction.reply(buildCategoryPicker());
      await interaction.showModal(buildCreateChannelModal());
    },
  },
  {
    // 우클릭 메뉴는 슬래시 목록과 **별도**라 명령어 목록이 지저분해지지 않습니다.
    data: new ContextMenuCommandBuilder().setName('일정에 등록').setType(ApplicationCommandType.Message),
    async execute(interaction) {
      const plan = getPlan(interaction.channelId);
      if (!plan) {
        return interaction.reply({
          content: '이 채널에는 일정이 없습니다. `/일정` 으로 먼저 등록해주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const msg = interaction.targetMessage;
      // 원본 메시지를 링크로 모읍니다. **다시 올리지 않습니다** — 원본이 그대로 출처입니다.
      const label =
        cut(msg.content?.replace(/\n/g, ' ').trim(), 60) ||
        (msg.attachments.size > 0 ? `${msg.author.username} 의 첨부 ${msg.attachments.size}개` : '메시지');

      if (plan.refs.some((r) => r.url === msg.url)) {
        return interaction.reply({ content: '이미 등록된 메시지입니다.', flags: MessageFlags.Ephemeral });
      }
      plan.refs.push({ label, url: msg.url });
      updatePlan(interaction.channelId, { refs: plan.refs });
      await refreshPanel(interaction.channel, plan);
      await interaction.reply({ content: `📎 참고자료에 등록했습니다: **${label}**`, flags: MessageFlags.Ephemeral });
    },
  },
];

// ── 판 갱신 ───────────────────────────────────────────────

/** 판 메시지를 그 자리에서 고칩니다. 없으면 아무것도 하지 않습니다. */
async function refreshPanel(channel, plan) {
  if (!plan.panelMessageId || !channel) return;
  const msg = await channel.messages.fetch(plan.panelMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit(buildPanel(plan)).catch(() => {});
}

/**
 * 일정을 지우거나 고칠 수 있는 사람인가.
 * 만든 사람과 **채널 관리** 권한이 있는 사람만. 아무나 지우면 안 됩니다.
 */
function canManage(interaction, plan) {
  if (interaction.user.id === plan.createdBy) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels));
}

// ── 알림 ──────────────────────────────────────────────────

const REMIND_CHOICES = [
  { value: '60', label: '1시간 전' },
  { value: '180', label: '3시간 전' },
  { value: 'morning', label: '당일 아침 9시' },
  { value: 'evebefore', label: '하루 전 저녁 8시' },
  { value: 'off', label: '알림 끄기' },
];

function remindAtFrom(plan, choice) {
  const d = new Date(plan.at);
  if (choice === 'off') return null;
  if (choice === 'morning') return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0).getTime();
  if (choice === 'evebefore') return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 20, 0).getTime();
  return plan.at - Number(choice) * 60_000;
}

/** 알림이 울릴 때. index.js 가 client 를 물려 넘겨줍니다. */
export function makeReminderFire(client) {
  return async (channelId, plan) => {
    if (!plan) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    await channel
      .send({
        content: `🔔 **${plan.title}** — ${formatWhen(plan.at, plan.hasTime)}`,
        embeds: buildPanel(plan).embeds,
      })
      .catch(() => {});
  };
}

// ── 버튼 · 모달 ───────────────────────────────────────────

export async function handlePlanComponent(interaction, client) {
  const [, action, arg] = interaction.customId.split(':');

  // 카테고리 고르기는 **일정이 없어도** 동작해야 합니다 (일정을 만들기 전 단계입니다).
  if (action === 'cat') {
    setSetting(interaction.guildId, 'planCategoryId', interaction.values[0]);
    // 고른 뒤 바로 만들기 창을 띄웁니다. 명령어를 다시 치게 하지 않습니다.
    return interaction.showModal(buildCreateChannelModal());
  }

  const plan = getPlan(interaction.channelId);
  if (!plan) {
    return interaction.reply({
      content: '이 채널의 일정을 찾을 수 없습니다. `/일정` 으로 다시 등록해주세요.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'todo') {
    const todo = plan.todos[Number(arg)];
    if (!todo) return;
    // 누른 사람이 담당자가 됩니다. 담당자를 따로 지정하지 않아도 되게.
    // 이미 자기가 체크한 것을 다시 누르면 해제됩니다.
    if (todo.doneBy === interaction.user.id) todo.doneBy = null;
    else todo.doneBy = interaction.user.id;
    updatePlan(interaction.channelId, { todos: plan.todos });
    return interaction.update(buildPanel(plan));
  }

  if (action === 'edit') return interaction.showModal(buildRegisterModal(interaction.channel, plan));

  if (action === 'addtodo' || action === 'note') {
    const isTodo = action === 'addtodo';
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(isTodo ? 'pl:addtodo' : 'pl:note')
        .setTitle(isTodo ? '할 일 추가' : '메모 추가')
        .addLabelComponents(
          new LabelBuilder()
            .setLabel(isTodo ? '할 일' : '메모')
            .setDescription('한 줄에 하나씩. 여러 개를 한 번에 넣을 수 있습니다.')
            .setTextInputComponent(
              new TextInputBuilder().setCustomId('v').setStyle(TextInputStyle.Paragraph).setRequired(true)
            )
        )
    );
  }

  // ── 삭제 ──
  //
  // 두 가지를 **분명히 갈라놓습니다.** 섞어놓으면 사진과 대화가 통째로 날아갑니다.
  //   · 일정만 지우기  → 판과 기록만. 채널·사진·대화는 그대로
  //   · 채널까지 지우기 → 되돌릴 수 없음
  if (action === 'del') {
    if (!canManage(interaction, plan)) {
      return interaction.reply({
        content: '일정을 만든 사람이나 **채널 관리** 권한이 있는 사람만 지울 수 있습니다.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      content: [
        `🗑️ **${plan.title}** 을 지울까요?`,
        '',
        '· **일정만 지우기** — 판과 등록한 내용(할 일·메모·참고자료)만 지웁니다.',
        '  이 채널과 사진·대화는 **그대로 남습니다.**',
        '· **채널까지 지우기** — 이 채널을 지웁니다.',
        '  **여기 올린 사진과 대화가 전부 사라지고 되돌릴 수 없습니다.**',
      ].join('\n'),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('pl:delplan').setEmoji('🗑️').setLabel('일정만 지우기').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('pl:delch').setEmoji('💥').setLabel('채널까지 지우기').setStyle(ButtonStyle.Danger)
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'delplan' || action === 'delch') {
    if (!canManage(interaction, plan)) {
      return interaction.update({ content: '지울 권한이 없습니다.', components: [] });
    }

    // 판을 남겨두면 "지웠는데 아직 있다" 가 됩니다. 먼저 지웁니다 (3.6-1a 와 같은 이유).
    if (plan.panelMessageId) {
      await interaction.channel?.messages
        ?.fetch(plan.panelMessageId)
        .then((m) => m.delete())
        .catch(() => {});
    }
    removePlan(interaction.channelId);

    if (action === 'delplan') {
      return interaction.update({
        content: '🗑️ 일정을 지웠습니다. 채널과 사진·대화는 그대로 있습니다.\n`/일정` 으로 다시 등록할 수 있습니다.',
        components: [],
      });
    }

    // 채널 삭제. 여기서부터는 되돌릴 수 없습니다.
    const me = interaction.guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.update({
        content:
          '일정 기록은 지웠지만 **채널은 못 지웠습니다.** 봇에게 채널 관리 권한이 없습니다.\n' +
          '채널은 직접 지우시거나, 서버 설정 → 역할 에서 권한을 켜주세요.',
        components: [],
      });
    }
    // 채널이 사라지면 이 응답도 사라지므로, 먼저 알려주고 지웁니다.
    await interaction.update({ content: '💥 채널을 지웁니다…', components: [] });
    await interaction.channel.delete(`일정 삭제: ${plan.title} (${interaction.user.tag})`).catch((err) => {
      console.error('[plan] 채널 삭제 실패:', err.message);
    });
    return;
  }

  if (action === 'remind') {
    return interaction.reply({
      content: '언제 알려드릴까요?',
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('pl:remindset')
            .setPlaceholder('알림 시점 고르기')
            .addOptions(REMIND_CHOICES.map((c) => ({ label: c.label, value: c.value })))
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'remindset') {
    const choice = interaction.values[0];
    const at = remindAtFrom(plan, choice);
    // 이미 지난 시점을 고르면 알림이 영원히 안 옵니다. 미리 알려줍니다.
    if (at !== null && at <= Date.now()) {
      return interaction.update({
        content: '그 시점은 이미 지났습니다. 다른 것을 골라주세요.',
        components: interaction.message.components,
      });
    }
    updatePlan(interaction.channelId, { remindAt: at });
    if (at === null) cancelReminder(interaction.channelId);
    else scheduleReminder(interaction.channelId, makeReminderFire(client));

    await refreshPanel(interaction.channel, plan);
    return interaction.update({
      content: at === null ? '🔔 알림을 껐습니다.' : `🔔 <t:${Math.floor(at / 1000)}:F> 에 알려드립니다.`,
      components: [],
    });
  }
}

export async function handlePlanModal(interaction, client) {
  const id = interaction.customId;

  if (id === 'pl:save') {
    const when = parseWhen(interaction.fields.getTextInputValue('when'));
    if (!when) {
      return interaction.reply({
        content:
          '날짜를 읽지 못했습니다. 이렇게 적어주세요.\n' +
          '`10/3` · `10/3 18:30` · `2026-10-03` · `10월 3일 오후 6시` · `내일 19시`',
        flags: MessageFlags.Ephemeral,
      });
    }

    const before = getPlan(interaction.channelId);
    const newTodos = lines(interaction.fields.getTextInputValue('todos'));
    // 고칠 때 이미 체크된 것은 **체크를 유지**합니다. 글자가 같으면 같은 할 일로 봅니다.
    const doneMap = new Map((before?.todos ?? []).map((t) => [t.text, t.doneBy]));

    const plan = {
      title: cut(interaction.fields.getTextInputValue('title').trim(), 100),
      at: when.at,
      hasTime: when.hasTime,
      place: interaction.fields.getTextInputValue('place').trim() || null,
      todos: newTodos.map((text) => ({ text: cut(text, 80), doneBy: doneMap.get(text) ?? null })),
      notes: lines(interaction.fields.getTextInputValue('notes')).map((n) => cut(n, 200)),
      refs: before?.refs ?? [],
      panelMessageId: before?.panelMessageId ?? null,
      remindAt: before?.remindAt ?? null,
      createdBy: before?.createdBy ?? interaction.user.id,
    };
    setPlan(interaction.channelId, plan);
    if (plan.remindAt) scheduleReminder(interaction.channelId, makeReminderFire(client));

    await interaction.reply(buildPanel(plan));
    updatePlan(interaction.channelId, { panelMessageId: (await interaction.fetchReply()).id });
    return;
  }

  if (id === 'pl:addtodo' || id === 'pl:note') {
    const plan = getPlan(interaction.channelId);
    if (!plan) return interaction.reply({ content: '일정을 찾을 수 없습니다.', flags: MessageFlags.Ephemeral });
    const added = lines(interaction.fields.getTextInputValue('v'));
    if (id === 'pl:addtodo') plan.todos.push(...added.map((text) => ({ text: cut(text, 80), doneBy: null })));
    else plan.notes.push(...added.map((n) => cut(n, 200)));
    updatePlan(interaction.channelId, { todos: plan.todos, notes: plan.notes });

    await refreshPanel(interaction.channel, plan);
    return interaction.reply({ content: `${added.length}개 추가했습니다.`, flags: MessageFlags.Ephemeral });
  }

  if (id === 'pl:mk') {
    const when = parseWhen(interaction.fields.getTextInputValue('when'));
    if (!when) {
      return interaction.reply({
        content: '날짜를 읽지 못했습니다. `10/3 18:30` 처럼 적어주세요.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const name = interaction.fields.getTextInputValue('name').trim();
    const place = interaction.fields.getTextInputValue('place')?.trim() || null;
    const users = pickIds(interaction.fields, 'users');
    const roles = pickIds(interaction.fields, 'roles');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await createPlanChannel(interaction, { name, when, users, roles });
    if (typeof channel === 'string') return interaction.editReply(channel); // 오류 문구

    const plan = {
      title: cut(name, 100),
      at: when.at,
      hasTime: when.hasTime,
      place,
      todos: [],
      notes: [],
      refs: [],
      panelMessageId: null,
      remindAt: null,
      createdBy: interaction.user.id,
    };
    const panel = await channel.send(buildPanel(plan));
    plan.panelMessageId = panel.id;
    setPlan(channel.id, plan);

    return interaction.editReply(`✅ <#${channel.id}> 를 만들었습니다.`);
  }
}

/** 모달의 사람·역할 고르기 값. 안 골랐으면 빈 배열입니다. */
function pickIds(fields, id) {
  try {
    const got = id === 'users' ? fields.getSelectedUsers(id) : fields.getSelectedRoles(id);
    if (!got) return [];
    return [...(typeof got.keys === 'function' ? got.keys() : got.map((x) => x.id))];
  } catch {
    return [];
  }
}

/**
 * 일정 채널을 만듭니다. `[yymmdd-이름]` 형태로 **지정된 카테고리 밑에** 만들고,
 * 고른 사람·역할과 만든 사람만 볼 수 있게 합니다.
 * @returns {Promise<import('discord.js').TextChannel | string>} 실패하면 사용자에게 보여줄 문구
 */
async function createPlanChannel(interaction, { name, when, users, roles }) {
  const guild = interaction.guild;
  const categoryId = getSetting(interaction.guildId, 'planCategoryId');
  const category = await guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    return '일정 카테고리를 찾을 수 없습니다. `/채널설정` 으로 다시 지정해주세요.';
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return '봇에게 **채널 관리** 권한이 없어 채널을 만들 수 없습니다.\n서버 설정 → 역할 → 봇 역할에서 켜주세요.';
  }

  // 디스코드가 공백을 하이픈으로 바꾸고 소문자화합니다. 우리가 미리 정리해둡니다.
  const slug = name.replace(/\s+/g, '-').replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ_-]/g, '').slice(0, 40) || '일정';

  try {
    return await guild.channels.create({
      name: `${yymmdd(when.at)}-${slug}`,
      type: ChannelType.GuildText,
      parent: category.id,
      // 비공개로 만듭니다. everyone 을 막고 참여자만 열어줍니다.
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        // 만든 사람은 항상 넣습니다. 안 넣으면 자기가 만든 채널을 못 봅니다.
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel] },
        ...users.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
        ...roles.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
      ],
      reason: `일정 채널: ${name} (${interaction.user.tag})`,
    });
  } catch (err) {
    return `채널을 만들지 못했습니다: ${err.message}\n카테고리 채널 수 상한(50개)에 걸렸을 수도 있습니다.`;
  }
}
