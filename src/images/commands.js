// 이미지 기능: 올라온 이미지 자동 저장 + 폴더 관리 슬래시 명령어
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
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
import { includesChannel, imagesEnabled } from '../settings.js';

/**
 * 감시 대상 채널에 올라온 이미지를 저장합니다.
 * @returns {boolean} 처리했으면 true
 */
export async function handleImageMessage(message) {
  if (!imagesEnabled(message.guildId)) return false;

  // 스레드에 올라온 것도 부모 채널이 대상이면 받아줍니다.
  const parentId = message.channel?.isThread?.() ? message.channel.parentId : null;
  const watched =
    includesChannel(message.guildId, 'imageChannelIds', message.channelId) ||
    (parentId && includesChannel(message.guildId, 'imageChannelIds', parentId));
  if (!watched) return false;

  if (message.attachments.size === 0) return false;
  if (![...message.attachments.values()].some(isImageAttachment)) return false;

  try {
    const { folder, saved } = await saveAttachments(message);
    if (saved.length === 0) return false;
    await message.react('✅').catch(() => {});
    console.log(`[images] ${saved.length}장 저장 → ${folder}`);
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
      .setName('갤러리')
      .setDescription('사진을 여러 장 골라서 한 번에 받을 수 있는 웹페이지 주소를 알려줍니다')
      .addStringOption((o) =>
        o.setName('폴더').setDescription('바로 열 폴더 이름 (비우면 폴더 목록)').setRequired(false)
      ),
    async execute(interaction) {
      const folder = interaction.options.getString('폴더');
      const url = folder
        ? `${config.images.webPublicUrl}/f/${encodeURIComponent(folder)}`
        : config.images.webPublicUrl;
      const authNote = config.images.webToken
        ? '\n로그인 창이 뜨면 **아이디는 아무거나**, 비밀번호에 `.env` 의 `WEB_TOKEN` 값을 넣으세요.'
        : '';
      await interaction.reply({
        content: `🖼️ ${url}\n사진을 여러 장 고르고 **선택한 사진 받기**를 누르면 한 장씩 전부 저장됩니다.${authNote}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
