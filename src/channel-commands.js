// 채널을 디스코드 안에서 직접 지정하는 명령어들.
// .env 를 열지 않고도 "이 채널을 음악방으로" 같은 설정을 바꿀 수 있게 합니다.
import { SlashCommandBuilder, EmbedBuilder, ChannelType, MessageFlags } from 'discord.js';
import { KEYS, getWithSource, set, clear } from './settings.js';

// /채널설정 의 "종류" 선택지. settings.js 의 KEYS 와 1:1로 대응합니다.
const CHOICES = Object.entries(KEYS).map(([key, spec]) => ({ name: spec.label, value: key }));

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

/**
 * 고른 종류에 맞는 채널인지 검사합니다. (선택지마다 타입을 강제할 수 없어 여기서 확인)
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

const mention = (id, spec) => (spec.kind === 'voice' ? `<#${id}>` : `<#${id}>`);

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('채널설정')
      .setDescription('각 기능이 사용할 채널을 지정합니다')
      .addStringOption((o) =>
        o.setName('종류').setDescription('무엇을 지정할지').setRequired(true).addChoices(...CHOICES)
      )
      .addChannelOption((o) =>
        o
          .setName('채널')
          .setDescription('지정할 채널')
          .setRequired(true)
          .addChannelTypes(...TEXT_TYPES, ...VOICE_TYPES)
      ),
    async execute(interaction) {
      const key = interaction.options.getString('종류');
      const channel = interaction.options.getChannel('채널');
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
        notes.push('음성채널 안의 채팅이므로, **그 음성채널에서 그대로 읽어줍니다.** 따로 지정할 필요 없습니다.');
      }

      await interaction.reply(
        `✅ **${spec.label}** 을(를) ${mention(channel.id, spec)} 로 지정했습니다.` +
          (notes.length ? '\n' + notes.map((n) => `· ${n}`).join('\n') : '')
      );
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('채널확인')
      .setDescription('지금 어떤 채널이 지정되어 있는지 봅니다'),
    async execute(interaction) {
      const lines = [];
      for (const [key, spec] of Object.entries(KEYS)) {
        const { value, source } = getWithSource(interaction.guildId, key);
        // 값이 어디서 왔는지 반드시 같이 보여줍니다.
        // 이게 없으면 .env 를 고쳤는데 안 바뀌는 이유를 알 수 없습니다.
        const tag =
          source === 'command' ? '`명령어로 지정`' : source === 'env' ? `\`.env 기본값\`` : '';
        const shown = Array.isArray(value)
          ? value.length
            ? value.map((id) => `<#${id}>`).join(' ')
            : '_없음_'
          : value
            ? mention(value, spec)
            : '_없음_';
        lines.push(`**${spec.label}** — ${shown} ${tag}\n　${spec.hint}`);
      }

      const embed = new EmbedBuilder()
        .setTitle('⚙️ 채널 설정')
        .setDescription(lines.join('\n\n'))
        .setFooter({
          text: '명령어로 지정한 값은 .env 보다 우선합니다. /채널해제 하면 .env 값으로 돌아갑니다.',
        })
        .setColor(0x5865f2);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('채널해제')
      .setDescription('명령어로 지정한 채널을 해제하고 .env 기본값으로 되돌립니다')
      .addStringOption((o) =>
        o.setName('종류').setDescription('무엇을 해제할지').setRequired(true).addChoices(...CHOICES)
      )
      .addChannelOption((o) =>
        o
          .setName('채널')
          .setDescription('이미지 채널처럼 여러 개인 경우, 뺄 채널 하나만 고르기 (비우면 전부 해제)')
          .setRequired(false)
          .addChannelTypes(...TEXT_TYPES, ...VOICE_TYPES)
      ),
    async execute(interaction) {
      const key = interaction.options.getString('종류');
      const channel = interaction.options.getChannel('채널');
      const spec = KEYS[key];

      clear(interaction.guildId, key, channel?.id ?? null);

      const after = getWithSource(interaction.guildId, key);
      const now =
        after.source === 'none'
          ? '지금은 아무 채널도 지정되어 있지 않습니다 (기능 꺼짐).'
          : after.source === 'env'
            ? `이제 \`.env\` 의 \`${spec.envName}\` 값을 씁니다.`
            : '남은 지정이 아직 있습니다. `/채널확인` 으로 보세요.';

      await interaction.reply(`🧹 **${spec.label}** 지정을 해제했습니다.\n${now}`);
    },
  },
];
