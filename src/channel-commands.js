// /채널설정 — 각 기능이 쓸 채널을 지정합니다.
//
// 예전에는 /채널설정 /채널확인 /채널해제 세 개였습니다.
// 명령어가 너무 많아져서 **하나로 합쳤습니다**:
//   인자 없이 실행 → 현재 상태 + 해제 버튼이 있는 패널
//   인자를 주면    → 그 자리에서 지정
// /기능 과 같은 방식이라 조작이 일관됩니다.
//
// 이 명령어는 **어떤 기능이 꺼져 있어도 항상 동작해야 합니다.**
// (commands.js 에서 feature 태그를 붙이지 않습니다)
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { KEYS, activeKeys, getWithSource, set, clear, inRole } from './settings.js';
import { ensureHomePanel } from './music/panel.js';
import { ensureStreamPanel } from './stream/panel.js';
import { peekGuildAudio } from './audio/guild-audio.js';

// 이 봇이 맡은 항목만 물어봅니다.
// 음악만 맡은 봇에게 읽어주기 채널을 지정하게 해봐야, 그 봇은 읽어주지 않습니다.
const CHOICES = Object.entries(activeKeys()).map(([key, spec]) => ({ name: spec.label, value: key }));

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
// 일정 채널을 만들 때 어느 카테고리 밑에 넣을지 지정하는 데 씁니다.
const CATEGORY_TYPES = [ChannelType.GuildCategory];

/**
 * 고른 종류에 맞는 채널인지 검사합니다.
 *
 * 중요: 음성채널에도 안에 채팅창이 있습니다. discord.js 에서 음성채널은
 * isTextBased() 와 isVoiceBased() 를 **둘 다** 만족합니다.
 * 그래서 채널 타입 목록을 하드코딩하지 않고 이 두 메서드로 판단합니다.
 * (예전에 타입 목록으로 검사해서, 음성채널 안의 채팅을 읽어주기 채팅방으로 못 고르는 버그가 있었습니다)
 */
function checkKind(key, channel) {
  const spec = KEYS[key];
  if (spec.kind === 'text' && !channel.isTextBased?.()) {
    return `**${spec.label}** 에는 채팅을 쓸 수 있는 채널을 골라주세요. (${channel.name} 에는 채팅창이 없습니다)`;
  }
  if (spec.kind === 'category' && channel.type !== ChannelType.GuildCategory) {
    return '카테고리를 골라주세요. (채널을 담는 상위 묶음입니다)';
  }
  if (spec.kind === 'voice' && !channel.isVoiceBased?.()) {
    return `**${spec.label}** 에는 음성채널을 골라주세요. (${channel.name} 은 채팅 전용 채널입니다)`;
  }
  return null;
}

/**
 * 봇이 그 채널을 실제로 쓸 수 있는지 확인해서 **없는 권한만** 알려줍니다.
 *
 * ★ 왜 필요한가: 비공개 채널을 지정하면 봇에게 권한이 없는 경우가 많습니다.
 *   그러면 지정은 되는데 제어판이 안 뜨고 읽어주기도 안 됩니다. 그런데
 *   **아무 오류도 안 납니다** — 사람은 "왜 안 되지" 만 하게 됩니다.
 *   그 자리에서 무엇이 없는지 알려주는 것이 이 함수의 목적입니다.
 *
 * ⚠️ 권한 이름을 한국어로 적습니다. 디스코드 한국어판의 표기와 맞춰야
 *    소유자가 어디를 눌러야 할지 찾을 수 있습니다.
 */
export function permissionWarnings(interaction, key, channel) {
  const spec = KEYS[key];
  const me = interaction.guild?.members?.me;
  if (!me || spec.kind === 'category') return [];

  const perms = channel.permissionsFor?.(me);
  if (!perms) return [];

  const missing = [];
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('채널 보기');

  if (spec.kind === 'text') {
    if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('메시지 보내기');
    if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) missing.push('메시지 기록 보기');
    if (!perms.has(PermissionFlagsBits.EmbedLinks)) missing.push('링크 첨부');
  }
  if (spec.kind === 'voice') {
    if (!perms.has(PermissionFlagsBits.Connect)) missing.push('연결');
    if (!perms.has(PermissionFlagsBits.Speak)) missing.push('말하기');
  }

  if (missing.length === 0) return [];
  return [
    `⚠️ **봇에게 이 권한이 없습니다: ${missing.join(', ')}**\n` +
      `  지정은 됐지만 **그대로는 동작하지 않습니다.** 채널 이름 옆 ⚙️ → 권한 → ` +
      `\`${interaction.client.user.username}\` 을 더하고 위 권한을 켜주세요.\n` +
      '  (비공개 채널은 봇도 따로 초대해줘야 합니다)',
  ];
}

/** 현재 설정 + 해제 버튼. (예전 /채널확인 + /채널해제 를 흡수) */
function panel(guildId) {
  const lines = [];
  const clearable = [];

  for (const [key, spec] of Object.entries(activeKeys())) {
    const { value, source } = getWithSource(guildId, key);
    // 값이 어디서 왔는지 반드시 같이 보여줍니다.
    // 이게 없으면 .env 를 고쳤는데 안 바뀌는 이유를 알 수 없습니다.
    const tag = source === 'command' ? '`명령어로 지정`' : source === 'env' ? '`.env 기본값`' : '';
    const shown = Array.isArray(value)
      ? value.length
        ? value.map((id) => `<#${id}>`).join(' ')
        : '_없음_'
      : value
        ? `<#${value}>`
        : '_없음_';
    lines.push(`**${spec.label}** — ${shown} ${tag}\n　${spec.hint}`);
    if (source === 'command') clearable.push([key, spec]);
  }

  const embed = new EmbedBuilder()
    .setTitle('⚙️ 채널 설정')
    .setDescription(lines.join('\n\n'))
    .setFooter({
      text: '바꾸려면 /채널설정 종류:... 채널:... · 명령어로 지정한 값은 .env 보다 우선합니다',
    })
    .setColor(0x5865f2);

  // 명령어로 지정한 것만 해제할 수 있습니다 (.env 값은 여기서 지울 수 없습니다).
  const rows = [];
  for (let i = 0; i < clearable.length; i += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        clearable.slice(i, i + 5).map(([key, spec]) =>
          new ButtonBuilder()
            .setCustomId(`c:clear:${key}`)
            .setLabel(`🧹 ${spec.label} 해제`)
            .setStyle(ButtonStyle.Secondary)
        )
      )
    );
  }

  return { embeds: [embed], components: rows };
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('채널설정')
      // ★ 서버 설정을 바꾸는 명령어라 **관리자(서버 관리 권한)만** 쓸 수 있게 합니다.
      //   setDefaultMemberPermissions 는 디스코드가 직접 막아줍니다. 코드에서 검사하면
      //   새 명령어를 추가할 때 반드시 빠뜨립니다. 서버 주인이 필요하면
      //   서버 설정 → 연동 에서 명령어별로 다시 열어줄 수 있습니다.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDescription('각 기능이 사용할 채널을 보고 지정합니다 (비우면 현재 상태만 봅니다)')
      .addStringOption((o) =>
        o.setName('종류').setDescription('무엇을 지정할지').setRequired(false).addChoices(...CHOICES)
      )
      .addChannelOption((o) =>
        o
          .setName('채널')
          // 비우면 지금 이 채널로 지정합니다. 비공개 채널이 목록에 안 뜰 때 쓰는 길입니다.
          .setDescription('지정할 채널 (비우면 지금 이 채널)')
          .setRequired(false)
          .addChannelTypes(...TEXT_TYPES, ...VOICE_TYPES, ...CATEGORY_TYPES)
      ),
    async execute(interaction) {
      const key = interaction.options.getString('종류');
      const channel = interaction.options.getChannel('채널');

      // 인자 없이 실행 → 현재 상태 + 해제 버튼
      if (!key && !channel) {
        return interaction.reply({ ...panel(interaction.guildId), flags: MessageFlags.Ephemeral });
      }
      if (!key) {
        return interaction.reply({
          content: '무엇을 지정할지(**종류**)를 골라주세요.\n둘 다 비우면 현재 설정을 보여줍니다.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ★ **채널을 비우면 지금 이 채널로 지정합니다.**
      //   비공개 채널이 채널 고르기 칸에 안 뜨는 경우가 있습니다. 그때 지정할 방법이
      //   아예 없으면 안 됩니다. 그 채널에 들어가서 이 명령을 치면 됩니다.
      const target = channel ?? interaction.channel;
      if (!target) {
        return interaction.reply({
          content: '채널을 고르거나, **지정하려는 채널에 들어가서** 채널 칸을 비우고 실행해주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const usedHere = !channel;

      const spec = KEYS[key];
      const problem = checkKind(key, target);
      if (problem) {
        return interaction.reply({ content: `⚠️ ${problem}`, flags: MessageFlags.Ephemeral });
      }

      set(interaction.guildId, key, target.id);

      const notes = [];
      if (usedHere) notes.push('채널을 안 고르셨으므로 **지금 이 채널**로 지정했습니다.');
      if (spec.multi) notes.push('이미 지정된 채널이 있으면 함께 유지됩니다.');
      // 음성채널 안의 채팅을 읽어주기 채팅방으로 고르면, 음성채널을 따로 지정할 필요가 없습니다.
      if (key === 'ttsTextChannelId' && target.isVoiceBased?.()) {
        notes.push('음성채널 안의 채팅이므로, **그 음성채널에서 그대로 읽어줍니다.**');
      }

      // ★ **봇이 그 채널을 실제로 쓸 수 있는지 지금 확인합니다.**
      //   비공개 채널을 지정하면 봇에게 권한이 없는 경우가 많습니다. 그러면 지정은
      //   되지만 제어판이 안 뜨고 읽어주기도 안 되는데, **아무 오류도 안 납니다.**
      //   조용히 안 되는 것이 제일 나쁩니다 — 그 자리에서 무엇이 없는지 알려줍니다.
      notes.push(...permissionWarnings(interaction, key, target));

      // 음악 채팅방으로 정했으면 **그 자리에 제어판을 바로 띄웁니다.**
      // 정하자마자 보여야 "항상 보인다" 가 됩니다. (music/panel.js 의 isMusicHome)
      if (key === 'musicTextChannelId' && inRole('music')) {
        notes.push('이 채팅방에는 **음악 제어판이 항상 떠 있습니다.** (재생 중이 아니어도)');
        ensureHomePanel(interaction.client, interaction.guildId, target.id, peekGuildAudio(interaction.guildId)).catch(
          (err) => console.error('[panel] 제어판 띄우기 실패:', err.message)
        );
      }

      // 방송 채널도 같습니다. 정하자마자 제어판이 보여야 "여기가 그 채널" 임을 압니다.
      if (key === 'streamChannelId' && inRole('stream')) {
        notes.push('이 채팅방에는 **방송 제어판이 항상 떠 있습니다.**');
        ensureStreamPanel(interaction.client, interaction.guildId, target.id).catch((err) =>
          console.error('[panel] 방송 제어판 띄우기 실패:', err.message)
        );
      }

      await interaction.reply(
        `✅ **${spec.label}** 을(를) <#${target.id}> 로 지정했습니다.` +
          (notes.length ? '\n' + notes.map((n) => `· ${n}`).join('\n') : '')
      );
    },
  },
];

/** 해제 버튼 처리. customId 가 `c:` 으로 시작하는 것만 옵니다. */
export async function handleChannelComponent(interaction) {
  const [, action, key] = interaction.customId.split(':');
  if (action !== 'clear' || !KEYS[key]) return;

  clear(interaction.guildId, key);

  const after = getWithSource(interaction.guildId, key);
  const now =
    after.source === 'none'
      ? '지정된 채널이 없습니다 (기능 꺼짐).'
      : `이제 \`.env\` 의 \`${KEYS[key].envName}\` 값을 씁니다.`;

  await interaction.update(panel(interaction.guildId)).catch(() => {});
  await interaction
    .followUp({
      content: `🧹 **${KEYS[key].label}** 지정을 해제했습니다. ${now}`,
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
}
