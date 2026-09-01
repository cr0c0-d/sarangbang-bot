// 영화 고르기 — 장르 + OTT 를 고르면 한 편 뽑아주거나 투표를 만듭니다.
//
// ★ 명령어는 `/영화` **하나뿐**입니다. 나머지는 전부 버튼·드롭다운입니다.
//   기획안은 `/영화뽑기 장르:… ott:…` 와 `/영화투표 …` 두 개를 제안했지만,
//   이 프로젝트는 같은 이유로 이미 두 번 되돌린 적이 있습니다:
//     · 명령어가 30개까지 불어나 걷어냄 (3.6-6)
//     · 투표를 명령어 칸 7개로 받았다가 "헷갈리고 번거롭다" → 모달 (3.6-7)
//   장르·OTT 를 명령어 칸에서 고르게 하면 같은 실수를 세 번째로 하는 것입니다.
//
// ★ 고른 값은 **customId 에 실어** 판을 다시 그립니다. 메모리 Map 에 두면
//   재시작에 날아가고(3.6-1a 와 같은 실수), 사람마다 판이 여러 개 뜨면 엉킵니다.
//     mv:g:<providers>              장르 드롭다운 (지금까지 고른 OTT 를 물고 있음)
//     mv:o:<genre>                  OTT 드롭다운  (지금까지 고른 장르를 물고 있음)
//     mv:draw:<genre>:<providers>   🎲 한 편 뽑기
//     mv:poll:<genre>:<providers>   🗳️ 투표 만들기
//     mv:again:<genre>:<providers>:<제외할 id>
//     mv:back:<genre>:<providers>   조건 바꾸기
//     mv:ott / mv:ottset            서버에서 쓰는 OTT 설정
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';
import { GENRES, PROVIDERS, genreByKey, providerById, findCandidates, hasKey } from './tmdb.js';
import { movieProviders, setMovieProviders } from '../settings.js';
import { createPoll } from '../poll/index.js';

/** 투표 후보 수. 사진이 5장까지라 그 이상은 비교가 안 됩니다. */
const POLL_PICKS = 5;

const NONE = '-';
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── customId 에 상태 싣기 ──────────────────────────────────

const encodeProviders = (ids) => (ids.length > 0 ? ids.join(',') : NONE);
const decodeProviders = (raw) =>
  raw && raw !== NONE ? raw.split(',').map(Number).filter((n) => Number.isFinite(n)) : [];
const decodeGenre = (raw) => (raw && raw !== NONE ? raw : null);

/** `mv:draw:action:8,1883` → { action, genre, providers, extra } */
function parseId(customId) {
  const [, action, ...rest] = customId.split(':');
  return {
    action,
    genreKey: decodeGenre(rest[0]),
    providers: decodeProviders(rest[1]),
    extra: rest[2] ?? null,
  };
}

// ── 고르기 판 ─────────────────────────────────────────────

/**
 * 무엇을 볼지 고르는 판. **나만 보입니다.**
 * @param {string[]} enabled 이 서버에서 쓰는 OTT (설정 안 했으면 빈 배열 = 전체)
 */
function buildPicker(guildId, genreKey, providers) {
  const enabled = movieProviders(guildId);
  // 서버에서 쓰는 OTT 만 고를 수 있게 합니다. 설정 전이면 전부 보여줍니다.
  const usable = enabled.length > 0 ? PROVIDERS.filter((p) => enabled.includes(p.id)) : PROVIDERS;

  const genre = genreByKey(genreKey);
  const chosen = providers.length > 0 ? providers : enabled;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎬 무엇을 볼까요?')
    .setDescription(
      [
        `**장르** — ${genre ? `${genre.emoji} ${genre.label}` : '아무거나 (전체)'}`,
        `**OTT** — ${
          chosen.length > 0 ? chosen.map((id) => providerById(id)?.name ?? id).join(', ') : '전체'
        }`,
        '',
        '고른 뒤 아래 버튼을 누르세요. 장르는 안 골라도 됩니다.',
      ].join('\n')
    );

  const gp = encodeProviders(providers);
  const gk = genreKey ?? NONE;

  const genreMenu = new StringSelectMenuBuilder()
    .setCustomId(`mv:g:${gp}`)
    .setPlaceholder(genre ? `장르: ${genre.label}` : '장르 고르기 (안 골라도 됩니다)')
    .addOptions(
      { label: '아무거나', value: NONE, emoji: '🎲', default: !genreKey },
      ...GENRES.map((g) => ({
        label: g.label,
        value: g.key,
        emoji: g.emoji,
        default: g.key === genreKey,
      }))
    );

  const ottMenu = new StringSelectMenuBuilder()
    .setCustomId(`mv:o:${gk}`)
    .setPlaceholder('OTT 고르기 (여러 개 가능)')
    .setMinValues(0)
    .setMaxValues(usable.length)
    .addOptions(
      usable.map((p) => ({
        label: p.name,
        value: String(p.id),
        description: p.sparse ? '⚠️ TMDB 에 자료가 거의 없습니다' : undefined,
        default: providers.includes(p.id),
      }))
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(genreMenu),
      new ActionRowBuilder().addComponents(ottMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mv:draw:${gk}:${gp}`)
          .setEmoji('🎲')
          .setLabel('한 편 뽑기')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`mv:poll:${gk}:${gp}`)
          .setEmoji('🗳️')
          .setLabel('투표 만들기')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('mv:ott')
          .setEmoji('⚙️')
          .setLabel('쓰는 OTT 설정')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

// ── 뽑기 결과 ─────────────────────────────────────────────

function buildResult(item, genreKey, providers) {
  const gk = genreKey ?? NONE;
  const gp = encodeProviders(providers);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${item.kind === 'tv' ? '📺' : '🎬'} ${item.title}`)
    .setDescription(cut(item.overview, 600) ?? '줄거리 정보가 없습니다.')
    .setFooter({
      text: [
        item.year,
        item.rating ? `★ ${item.rating.toFixed(1)}` : null,
        item.kind === 'tv' ? '시리즈' : '영화',
      ]
        .filter(Boolean)
        .join(' · '),
    });

  // 포스터는 **크게** 붙입니다. 썸네일은 모바일에서 눌러도 확대되지 않습니다 (3.6-7).
  if (item.poster) embed.setImage(item.poster);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mv:again:${gk}:${gp}:${item.id}`)
          .setEmoji('🎲')
          .setLabel('다시 뽑기')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`mv:back:${gk}:${gp}`)
          .setEmoji('🔀')
          .setLabel('조건 바꾸기')
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

/** 조건에 맞는 게 없을 때. 무엇을 바꾸면 되는지까지 알려줍니다. */
function buildEmpty(guildId, genreKey, providers) {
  const genre = genreByKey(genreKey);
  const chosen = providers.length > 0 ? providers : movieProviders(guildId);
  const sparse = chosen.map(providerById).filter((p) => p?.sparse);

  const tips = ['· 장르를 **아무거나**로 바꿔보세요.', '· OTT 를 더 고르거나 전부 해제해보세요.'];
  if (sparse.length > 0) {
    tips.unshift(`· **${sparse.map((p) => p.name).join(', ')}** 는 TMDB 에 자료가 거의 없습니다. 빼보세요.`);
  }

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('😶 조건에 맞는 작품이 없어요')
        .setDescription(
          [
            `**장르** ${genre ? genre.label : '전체'} · **OTT** ${
              chosen.length > 0 ? chosen.map((id) => providerById(id)?.name ?? id).join(', ') : '전체'
            }`,
            '',
            ...tips,
          ].join('\n')
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mv:back:${genreKey ?? NONE}:${encodeProviders(providers)}`)
          .setEmoji('🔀')
          .setLabel('조건 바꾸기')
          .setStyle(ButtonStyle.Primary)
      ),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

// ── 서버에서 쓰는 OTT 설정 ────────────────────────────────

function buildOttSettings(guildId) {
  const enabled = movieProviders(guildId);
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('⚙️ 이 서버에서 쓰는 OTT')
        .setDescription(
          [
            '구독 중인 것만 고르세요. 고른 것만 영화 고르기 판에 나옵니다.',
            '**아무것도 안 고르면 전체**를 씁니다.',
            '',
            enabled.length > 0
              ? `지금: ${enabled.map((id) => providerById(id)?.name ?? id).join(', ')}`
              : '지금: 전체 (설정 안 함)',
          ].join('\n')
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('mv:ottset')
          .setPlaceholder('구독 중인 OTT 를 고르세요')
          .setMinValues(0)
          .setMaxValues(PROVIDERS.length)
          .addOptions(
            PROVIDERS.map((p) => ({
              label: p.name,
              value: String(p.id),
              description: p.sparse ? '⚠️ TMDB 에 자료가 거의 없습니다' : undefined,
              default: enabled.includes(p.id),
            }))
          )
      ),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

// ── 명령어 ────────────────────────────────────────────────

const NO_KEY = {
  content:
    '🎬 영화 기능을 쓰려면 **TMDB 키**가 필요합니다.\n' +
    '1. https://www.themoviedb.org 가입 → 설정 → API\n' +
    '2. "API 읽기 액세스 토큰" 을 복사\n' +
    '3. `.env` 에 `TMDB_READ_TOKEN=...` 을 넣고 봇을 다시 시작',
  flags: MessageFlags.Ephemeral,
};

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('영화')
      .setDescription('오늘 뭐 볼지 골라줍니다 (한 편 뽑기 · 투표 만들기)'),
    async execute(interaction) {
      if (!hasKey()) return interaction.reply(NO_KEY);
      await interaction.reply(buildPicker(interaction.guildId, null, []));
    },
  },
];

// ── 버튼·드롭다운 ─────────────────────────────────────────

/** 조건에 맞는 후보를 가져옵니다. 없으면 안내 화면을 돌려줍니다. */
async function candidatesFor(guildId, genreKey, providers) {
  // 판에서 아무 OTT 도 안 골랐으면 **서버 설정**을 씁니다.
  const use = providers.length > 0 ? providers : movieProviders(guildId);
  return findCandidates({ genreKey, providers: use });
}

export async function handleMovieComponent(interaction) {
  if (!hasKey()) return interaction.reply(NO_KEY);

  const { action, genreKey, providers, extra } = parseId(interaction.customId);

  // 드롭다운으로 고른 값을 판에 반영해 다시 그립니다.
  if (action === 'g') {
    const picked = interaction.values[0];
    return interaction.update(buildPicker(interaction.guildId, decodeGenre(picked), providers));
  }
  if (action === 'o') {
    const picked = interaction.values.map(Number);
    return interaction.update(buildPicker(interaction.guildId, genreKey, picked));
  }
  if (action === 'back') {
    return interaction.update(buildPicker(interaction.guildId, genreKey, providers));
  }

  if (action === 'ott') {
    return interaction.update(buildOttSettings(interaction.guildId));
  }
  if (action === 'ottset') {
    const picked = interaction.values.map(Number);
    setMovieProviders(interaction.guildId, picked);
    // 설정을 바꿨으니 고르기 판으로 돌아갑니다. 바뀐 게 바로 보여야 합니다.
    return interaction.update(buildPicker(interaction.guildId, null, []));
  }

  if (action === 'draw' || action === 'again') {
    await interaction.deferUpdate();
    const list = await candidatesFor(interaction.guildId, genreKey, providers);
    // 직전에 뽑은 것만 뺍니다. 연달아 같은 게 나오면 고장으로 보입니다.
    // 전부 기억하려 들면 복잡해지기만 합니다.
    const pool = list.filter((it) => it.id !== extra);
    const from = pool.length > 0 ? pool : list;
    if (from.length === 0) {
      return interaction.editReply(buildEmpty(interaction.guildId, genreKey, providers));
    }
    const pick = from[Math.floor(Math.random() * from.length)];
    return interaction.editReply(buildResult(pick, genreKey, providers));
  }

  if (action === 'poll') {
    await interaction.deferReply();
    const list = await candidatesFor(interaction.guildId, genreKey, providers);
    // 포스터가 없는 작품은 뺍니다. 사진을 보고 고르는 게 투표의 목적입니다.
    const withPoster = list.filter((it) => it.poster);
    if (withPoster.length < 2) {
      return interaction.editReply({
        content:
          '투표를 만들 만큼 후보가 없습니다 (포스터가 있는 작품이 2편 이상 필요합니다).\n`/영화` 로 조건을 바꿔보세요.',
      });
    }

    // 겹치지 않게 섞어서 앞에서부터 고릅니다.
    const shuffled = withPoster.sort(() => Math.random() - 0.5).slice(0, POLL_PICKS);
    const genre = genreByKey(genreKey);
    const question = genre ? `오늘 뭐 볼까? (${genre.label})` : '오늘 뭐 볼까?';

    // 기존 투표를 그대로 씁니다. 버튼 투표·익명 집계·마감·재시작 견디기가 딸려 옵니다.
    // 포스터 주소를 임베드에 그대로 박지 않고 **다시 올리는 것**도 createPoll 이 해줍니다 (3.6-7).
    await createPoll(
      interaction,
      question,
      shuffled.map((it) => cut(it.title, 60)),
      shuffled.map((it) => ({ url: it.poster, name: 'poster.jpg' }))
    );
    return;
  }
}
