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
} from 'discord.js';
import { KEYS, activeKeys, getWithSource, set, clear } from './settings.js';

// 이 봇이 맡은 항목만 물어봅니다.
// 음악만 맡은 봇에게 읽어주기 채널을 지정하게 해봐야, 그 봇은 읽어주지 않습니다.
const CHOICES = Object.entries(activeKeys()).map(([key, spec]) => ({ name: spec.label, value: key }));

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

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
  if (spec.kind === 'voice' && !channel.isVoiceBased?.()) {
    return `**${spec.label}** 에는 음성채널을 골라주세요. (${channel.name} 은 채팅 전용 채널입니다)`;
  }
  return null;
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
      .setDescription('각 기능이 사용할 채널을 보고 지정합니다 (비우면 현재 상태만 봅니다)')
      .addStringOption((o) =>
        o.setName('종류').setDescription('무엇을 지정할지').setRequired(false).addChoices(...CHOICES)
      )
      .addChannelOption((o) =>
        o
          .setName('채널')
          .setDescription('지정할 채널')
          .setRequired(false)
          .addChannelTypes(...TEXT_TYPES, ...VOICE_TYPES)
      ),
    async execute(interaction) {
      const key = interaction.options.getString('종류');
      const channel = interaction.options.getChannel('채널');

      // 인자 없이 실행 → 현재 상태 + 해제 버튼
      if (!key && !channel) {
        return interaction.reply({ ...panel(interaction.guildId), flags: MessageFlags.Ephemeral });
      }
      if (!key || !channel) {
        return interaction.reply({
          content: '지정하려면 **종류와 채널을 둘 다** 골라주세요.\n둘 다 비우면 현재 설정을 보여줍니다.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const spec = KEYS[key];
      const problem = checkKind(key, channel);
      if (problem) {
        return interaction.reply({ content: `⚠️ ${problem}`, flags: MessageFlags.Ephemeral });
      }

      set(interaction.guildId, key, channel.id);

      const notes = [];
      if (spec.multi) notes.push('이미 지정된 채널이 있으면 함께 유지됩니다.');
      // 음성채널 안의 채팅을 읽어주기 채팅방으로 고르면, 음성채널을 따로 지정할 필요가 없습니다.
      if (key === 'ttsTextChannelId' && channel.isVoiceBased?.()) {
        notes.push('음성채널 안의 채팅이므로, **그 음성채널에서 그대로 읽어줍니다.**');
      }

      await interaction.reply(
        `✅ **${spec.label}** 을(를) <#${channel.id}> 로 지정했습니다.` +
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
