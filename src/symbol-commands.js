// 사람별 상징 이모지 — 망고가 사용자 멘션을 표시하는 모든 기능에서 함께 씁니다.
import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  get as getSetting,
  setUserSymbol,
  clearUserSymbol,
  symbolMention,
} from './settings.js';
import { scheduleStreamPanelRefresh } from './stream/panel.js';

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('상징이모지')
      .setDescription('망고가 사람 이름 앞에 붙일 서버 이모지를 정합니다')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('사람').setDescription('상징 이모지를 지정할 사람').setRequired(true))
      .addStringOption((o) => o.setName('이모지').setDescription('서버 이모지 검색 (비우면 해제)').setAutocomplete(true)),
    async autocomplete(interaction) {
      const query = interaction.options.getFocused().trim().toLowerCase();
      const choices = [...(interaction.guild?.emojis?.cache?.values?.() ?? [])]
        .filter((emoji) => !query || emoji.name.toLowerCase().includes(query))
        .slice(0, 25)
        .map((emoji) => ({ name: `:${emoji.name}:`, value: emoji.id }));
      await interaction.respond(choices);
    },
    async execute(interaction) {
      const user = interaction.options.getUser('사람', true);
      const input = interaction.options.getString('이모지');
      if (!input) {
        const removed = clearUserSymbol(interaction.guildId, user.id);
        refreshStreamPanels(interaction, removed);
        return interaction.reply({
          content: removed ? `✅ ${symbolMention(interaction.guildId, user.id)}의 상징 이모지를 해제했습니다.` : '이미 지정된 상징 이모지가 없습니다.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      const id = input.match(/<a?:[^:>]+:(\d+)>/)?.[1] ?? (/^\d+$/.test(input) ? input : null);
      const emoji = id ? interaction.guild?.emojis?.cache?.get(id) : null;
      if (!emoji) {
        return interaction.reply({
          content: '이 서버에 있는 이모지를 목록에서 골라주세요. 다른 서버 이모지와 일반 이모지는 등록할 수 없습니다.',
          flags: MessageFlags.Ephemeral,
        });
      }
      setUserSymbol(interaction.guildId, user.id, emoji.toString());
      refreshStreamPanels(interaction, true);
      return interaction.reply({
        content: `✅ ${symbolMention(interaction.guildId, user.id)}의 상징 이모지를 등록했습니다.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    },
  },
];

function refreshStreamPanels(interaction, changed) {
  const channelId = changed && getSetting(interaction.guildId, 'streamChannelId');
  if (channelId) scheduleStreamPanelRefresh(interaction.client, interaction.guildId, channelId);
}
