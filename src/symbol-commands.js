// 사람별 상징 이모지 — 망고가 사용자 멘션을 표시하는 모든 기능에서 함께 씁니다.
import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import {
  get as getSetting,
  setUserSymbol,
  clearUserSymbol,
  symbolMention,
} from './settings.js';
import { scheduleStreamPanelRefresh } from './stream/panel.js';

const EMOJI_PAGE_SIZE = 25;
const EMOJI_CACHE_MS = 5 * 60_000;
const emojiLists = new Map();

async function allGuildEmojis(guild) {
  if (!guild) return [];
  const key = guild.id ?? 'unknown';
  const known = emojiLists.get(key);
  if (known && Date.now() - known.at < EMOJI_CACHE_MS) return known.emojis;
  let emojis = [...(guild.emojis?.cache?.values?.() ?? [])];
  try {
    const fetched = await guild.emojis?.fetch?.();
    if (fetched?.values) emojis = [...fetched.values()];
  } catch {
    // 자동완성에서 REST 조회가 잠깐 실패해도 이미 받은 캐시 목록은 계속 보여줍니다.
  }
  emojis.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
  emojiLists.set(key, { at: Date.now(), emojis });
  return emojis;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('상징이모지')
      .setDescription('망고가 사람 이름 앞에 붙일 서버 이모지를 정합니다')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('사람').setDescription('상징 이모지를 지정할 사람').setRequired(true))
      .addIntegerOption((o) => o.setName('목록페이지').setDescription('이모지 이름을 모를 때 25개씩 넘겨보기 (기본 1)').setMinValue(1).setMaxValue(100))
      .addStringOption((o) => o.setName('이모지').setDescription('이름을 입력해 서버 전체에서 검색 (비우면 해제)').setAutocomplete(true)),
    async autocomplete(interaction) {
      const query = interaction.options.getFocused().trim().toLowerCase().replace(/^:+|:+$/g, '');
      const all = await allGuildEmojis(interaction.guild);
      const page = Math.max(1, interaction.options.getInteger?.('목록페이지') ?? 1);
      const filtered = query
        ? all.filter((emoji) => emoji.name.toLowerCase().includes(query))
            .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
        : all;
      const maxPage = Math.max(1, Math.ceil(filtered.length / EMOJI_PAGE_SIZE));
      const current = Math.min(page, maxPage);
      const from = query ? 0 : (current - 1) * EMOJI_PAGE_SIZE;
      const choices = filtered
        .slice(from, from + EMOJI_PAGE_SIZE)
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
      let emoji = id ? interaction.guild?.emojis?.cache?.get(id) : null;
      const fetchOne = !emoji && id ? interaction.guild?.emojis?.fetch?.(id) : null;
      if (fetchOne) emoji = await fetchOne.catch(() => null);
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
