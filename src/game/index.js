import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { get as getSetting } from '../settings.js';
import { resolveGame, autocompleteGames } from './steam.js';
import { bindForumPost } from './store.js';
import { rememberGame, normalizeGameSearch } from './catalog.js';
import { forumLinks, publishPendingForGame } from './forum.js';

const linkTo = (guildId, channelId) => `https://discord.com/channels/${guildId}/${channelId}`;

function forumKind(interaction) {
  const channel = interaction.channel;
  if (!channel?.isThread?.()) return null;
  const parentId = channel.parentId;
  if (parentId === getSetting(interaction.guildId, 'recordingForumId')) return 'rec';
  if (parentId === getSetting(interaction.guildId, 'screenshotForumId')) return 'shot';
  return null;
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('게임')
      .setDescription('게임의 스샷·녹화 포스트를 찾거나, 현재 포스트를 게임에 연결합니다')
      .addStringOption((o) =>
        o
          .setName('검색')
          .setDescription('영문으로 검색해 고르거나, 목록에 없으면 게임 이름을 그대로 입력하세요')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption((o) => o.setName('별칭').setDescription('추가할 한글명·줄임말 (스레드 관리자만)').setMaxLength(100)),
    autocomplete: autocompleteGames,
    async execute(interaction) {
      const raw = interaction.options.getString('검색', true);
      const alias = interaction.options.getString('별칭')?.trim();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const game = await resolveGame(raw, interaction.guildId);
      if (!game) {
        return interaction.editReply(
          'Steam에서 게임 이름을 가져오지 못했습니다. 검색 목록을 다시 고르거나 게임 이름을 직접 입력해주세요.'
        );
      }

      const kind = forumKind(interaction);
      if (alias && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads)) {
        return interaction.editReply('별칭을 추가하려면 **스레드 관리** 권한이 필요합니다.');
      }
      if (alias && !normalizeGameSearch(alias)) return interaction.editReply('별칭에는 한글·영문·숫자 중 하나 이상을 넣어주세요.');
      if (alias) rememberGame(interaction.guildId, game, alias);
      if (kind) {
        // 연결을 바꾸면 검색 결과와 방송 기록 목적지가 함께 바뀝니다.
        // 실수나 장난으로 다른 게임에 덮어쓰지 못하게 포럼 관리 권한이 있는 사람만 허용합니다.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads)) {
          return interaction.editReply('이 포스트를 게임에 연결하려면 **스레드 관리** 권한이 필요합니다.');
        }
        bindForumPost(interaction.guildId, kind, game.key, interaction.channelId);
        // 기존 포스트 제목이 이 서버 사람들이 실제로 쓰는 한글명·별칭입니다.
        // 제목으로 게임을 추측하지는 않고, 사람이 Steam 게임을 확정한 뒤에만 별칭으로 기억합니다.
        rememberGame(interaction.guildId, game, interaction.channel?.name);
        let pending = 0;
        if (kind === 'rec') pending = await publishPendingForGame(interaction.client, interaction.guildId, game.key);
        const label = kind === 'rec' ? '녹화 포스트' : '스샷 포스트';
        return interaction.editReply(
          `✅ 이 ${label}를 **${game.name}**${game.appid ? ` (Steam ${game.appid})` : ''}에 연결했습니다.` +
            (pending ? `\n보류 중이던 방송 기록 **${pending}개**도 이 포스트에 올렸습니다.` : '')
            + (alias ? `\n별칭 **${alias}**도 저장했습니다.` : '')
        );
      }

      const links = forumLinks(interaction.guildId, game.key);
      if (alias) return interaction.editReply(`✅ **${game.name}**의 별칭 **${alias}**를 저장했습니다.`);
      const lines = [
        links.shot ? `📷 [스샷 포스트 바로가기](${linkTo(interaction.guildId, links.shot)})` : '📷 스샷 포스트 — 연결 안 됨',
        links.rec ? `📺 [녹화 포스트 바로가기](${linkTo(interaction.guildId, links.rec)})` : '📺 녹화 포스트 — 연결 안 됨',
      ];
      if (!links.shot && !links.rec) {
        lines.push('', '연결하려는 포럼 포스트 안에서 같은 `/게임 검색:…` 을 실행하면 연결됩니다.');
      }
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`🎮 ${game.name}`).setDescription(lines.join('\n'));
      if (game.image) embed.setImage(game.image);
      if (game.genres.length) embed.addFields({ name: '장르', value: game.genres.slice(0, 6).join(' · ') });
      if (game.appid) embed.setURL(`https://store.steampowered.com/app/${game.appid}`);
      return interaction.editReply({ embeds: [embed] });
    },
  },
];
