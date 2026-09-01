// /기능 — 기능을 디스코드에서 켜고 끕니다.
//
// 왜 필요한가: 서버에 이미 다른 음악봇·TTS봇이 있으면 같은 링크·같은 채팅에
// 둘이 동시에 반응해서 겹칩니다. 그때 서버에 SSH로 들어가 프로세스를 끄는 건
// 소유자에게 너무 번거로운 일입니다. 버튼 한 번으로 끄고 켤 수 있어야 합니다.
//
// 이 명령어 자체는 **어떤 기능이 꺼져 있어도 항상 동작해야 합니다.**
// (다 꺼놓고 다시 켤 방법이 없으면 안 되므로 — commands.js 에서 feature 태그를 붙이지 않습니다)
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { FEATURES, activeFeatures, featureEnabled, setFeature, setAllFeatures } from './settings.js';
import { peekGuildAudio } from './audio/guild-audio.js';

function panel(guildId) {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ 기능 켜고 끄기')
    .setColor(0x5865f2)
    .setDescription(
      Object.entries(activeFeatures())
        .map(([key, f]) => {
          const on = featureEnabled(guildId, key);
          return `${on ? '🟢' : '⚪'} ${f.emoji} **${f.label}** — ${on ? '켜짐' : '꺼짐'}\n　${f.hint}`;
        })
        .join('\n\n')
    )
    .setFooter({ text: '버튼을 누르면 바로 바뀝니다. 이 설정은 서버별로 저장됩니다.' });

  const rows = [
    new ActionRowBuilder().addComponents(
      Object.entries(activeFeatures()).map(([key, f]) =>
        new ButtonBuilder()
          .setCustomId(`f:${key}`)
          .setEmoji(f.emoji)
          .setLabel(f.label)
          .setStyle(featureEnabled(guildId, key) ? ButtonStyle.Success : ButtonStyle.Secondary)
      )
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('f:all-on')
        .setLabel('전체 켜기')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('f:all-off')
        .setLabel('전체 끄기')
        .setStyle(ButtonStyle.Danger)
    ),
  ];

  return { embeds: [embed], components: rows };
}

/**
 * 음악과 읽어주기가 둘 다 꺼졌으면 음성채널에 남아 있을 이유가 없습니다.
 * 안 그러면 봇이 아무것도 안 하면서 음성채널에 계속 앉아 있게 됩니다.
 */
function leaveVoiceIfPointless(guildId) {
  if (featureEnabled(guildId, 'music') || featureEnabled(guildId, 'tts')) return;
  peekGuildAudio(guildId)?.destroy();
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('기능')
      .setDescription('음악·읽어주기·타이머·이미지 기능을 켜고 끕니다'),
    async execute(interaction) {
      await interaction.reply({ ...panel(interaction.guildId), flags: MessageFlags.Ephemeral });
    },
  },
];

/** 버튼 처리. customId 가 `f:` 으로 시작하는 것만 옵니다. */
export async function handleFeatureComponent(interaction) {
  const key = interaction.customId.slice(2);
  const guildId = interaction.guildId;

  if (key === 'all-on' || key === 'all-off') {
    setAllFeatures(guildId, key === 'all-on');
  } else if (FEATURES[key]) {
    const next = !featureEnabled(guildId, key);
    setFeature(guildId, key, next);
    // 음악을 끄면 재생 중인 것도 멈춰야 합니다. 안 끄면 계속 흘러나옵니다.
    if (key === 'music' && !next) peekGuildAudio(guildId)?.stop();
  } else {
    return;
  }

  leaveVoiceIfPointless(guildId);
  await interaction.update(panel(guildId)).catch(() => {});
}
