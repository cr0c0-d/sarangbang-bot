// 이미지 기능: 올라온 이미지 자동 저장 + 폴더 관리 슬래시 명령어
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { config } from '../config.js';
import {
  saveAttachments,
  setChannelFolder,
  clearChannelFolder,
  resolveFolder,
  explainFolder,
  listFolders,
  isImageAttachment,
  baseDir,
} from './store.js';
import { imageChannelAllowed, featureEnabled } from '../settings.js';
import { showGalleryPanel } from './panel.js';
import { planCleanup, runCleanup, describe, maybeAutoCleanup, setNotifyChannel } from './cleanup.js';

/**
 * 감시 대상 채널에 올라온 이미지를 저장합니다.
 * @returns {boolean} 처리했으면 true
 */
export async function handleImageMessage(message) {
  // 기능을 끄면 새 사진만 저장하지 않습니다. 이미 모아둔 갤러리는 계속 볼 수 있습니다.
  if (!featureEnabled(message.guildId, 'images')) return false;

  // 스레드에 올라온 것도 부모 채널이 대상이면 받아줍니다.
  const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
  if (!imageChannelAllowed(message.guildId, message.channelId, parentId)) return false;

  if (message.attachments.size === 0) return false;
  if (![...message.attachments.values()].some(isImageAttachment)) return false;

  try {
    const { folder, saved } = await saveAttachments(message);
    if (saved.length === 0) return false;
    await message.react('✅').catch(() => {});
    console.log(`[images] ${saved.length}장 저장 → ${folder}`);
    // 갤러리 버튼을 채팅방 맨 아래로 올립니다. (매번 /갤러리 를 치지 않아도 되도록)
    showGalleryPanel(message.channel, folder);
    // 용량이 찼는지 확인합니다. 정리 결과는 이 채널에 알립니다.
    setNotifyChannel(message.channel);
    maybeAutoCleanup();
  } catch (err) {
    console.error('[images] 저장 실패:', err);
    await message.react('⚠️').catch(() => {});
  }
  return true;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('폴더')
      .setDescription('이 채널에 올라오는 이미지를 저장할 폴더를 지정합니다')
      .addStringOption((o) =>
        o.setName('이름').setDescription('폴더 이름 (비우면 지정 해제)').setRequired(false)
      ),
    async execute(interaction) {
      const name = interaction.options.getString('이름');
      if (!name) {
        clearChannelFolder(interaction.channelId);
        return interaction.reply(
          '📂 폴더 지정을 해제했습니다. 이제 채널 이름을 폴더로 씁니다.'
        );
      }
      const safe = setChannelFolder(interaction.channelId, name);
      await interaction.reply(`📂 이 채널의 이미지는 이제 **${safe}** 폴더에 저장됩니다.`);
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('폴더확인')
      .setDescription('지금 이 채널의 이미지가 어디에 저장되는지 봅니다'),
    async execute(interaction) {
      const now = resolveFolder(interaction.channel, interaction.channelId);
      const how = explainFolder(interaction.channel, interaction.channelId);
      await interaction.reply({
        content: `현재 저장 폴더: **${now}**\n(${how})\n저장 위치: \`${baseDir()}\``,
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('폴더목록')
      .setDescription('저장된 폴더와 장수를 봅니다'),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const folders = await listFolders();
      if (folders.length === 0) {
        return interaction.editReply('아직 저장된 이미지가 없습니다.');
      }
      const lines = folders
        .slice(0, 25)
        .map((f) => `• **${f.name}** — ${f.count}장`)
        .join('\n');
      const embed = new EmbedBuilder()
        .setTitle('📁 이미지 폴더')
        .setDescription(lines + (folders.length > 25 ? `\n… 외 ${folders.length - 25}개` : ''))
        .setFooter({ text: `전체 ${folders.reduce((a, f) => a + f.count, 0)}장` })
        .setColor(0x5865f2);
      await interaction.editReply({ embeds: [embed] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('정리')
      .setDescription('사진 용량을 보고, 오래된 것부터 정리합니다')
      .addBooleanOption((o) =>
        o
          .setName('지금바로')
          .setDescription('true 면 예산이 남아도 강제로 정리 대상을 계산합니다')
          .setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const force = interaction.options.getBoolean('지금바로') ?? false;
      const plan = await planCleanup({ force });

      if (!plan.need) {
        return interaction.editReply(describe(plan));
      }

      // ⚠️ 되돌릴 수 없으므로 **미리 보여주고 확인을 받습니다.** 바로 지우지 않습니다.
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('g:clean')
          .setLabel(`${plan.files.length}장 삭제`)
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('g:cancel').setLabel('취소').setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({
        content: `${describe(plan)}\n\n**정말 지울까요? 되돌릴 수 없습니다.**`,
        components: [row],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('갤러리')
      .setDescription('이 채널의 사진을 여러 장 골라 한 번에 받을 수 있는 주소를 알려줍니다')
      .addStringOption((o) =>
        o.setName('폴더').setDescription('다른 폴더를 보려면 이름 입력 (비우면 이 채널)').setRequired(false)
      ),
    async execute(interaction) {
      // 기본은 **이 채널의 폴더**입니다.
      // 폴더 목록은 소유자 전용이라, 여기서 목록 링크를 주면 친구들이 막힌 페이지로 갑니다.
      const folder =
        interaction.options.getString('폴더') ??
        resolveFolder(interaction.channel, interaction.channelId);
      const url = `${config.images.webPublicUrl}/f/${encodeURIComponent(folder)}`;

      // 보기·내려받기는 암호가 없습니다. 링크만 있으면 친구들도 바로 열 수 있습니다.
      await interaction.reply({
        content: [
          `🖼️ **${folder}** 폴더`,
          url,
          '사진을 클릭해 여러 장 고르고 **⬇️ 선택한 사진 받기** 를 누르면 한 장씩 전부 저장됩니다.',
          '(Shift+클릭 으로 범위 선택, **전체 선택** 버튼도 있습니다)',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];

/** /정리 의 확인 버튼. customId 가 `g:` 으로 시작하는 것만 옵니다. */
export async function handleImageComponent(interaction) {
  if (interaction.customId === 'g:cancel') {
    return interaction.update({ content: '취소했습니다. 아무것도 지우지 않았습니다.', components: [] });
  }
  if (interaction.customId !== 'g:clean') return;

  await interaction.update({ content: '🧹 정리하는 중…', components: [] });

  // 버튼을 누른 시점에 다시 계산합니다.
  // 미리보기 이후 사진이 더 올라왔을 수 있는데, 옛 목록으로 지우면 엉뚱한 파일을 건드립니다.
  const plan = await planCleanup({ force: true });
  if (!plan.need) {
    return interaction.editReply({ content: '정리할 것이 없습니다.', components: [] });
  }
  const deleted = await runCleanup(plan);
  await interaction.editReply({
    content: `🧹 **${deleted}장**을 지워 ${(plan.freed / 1024 ** 2).toFixed(0)}MB 를 확보했습니다.`,
    components: [],
  });
}
