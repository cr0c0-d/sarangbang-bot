// TTS 기능: 지정한 채팅방의 메시지를 음성채널에서 읽어줍니다.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} from 'discord.js';
import { config } from '../config.js';
import { getGuildAudio } from '../audio/guild-audio.js';
import { synthesize } from './synth.js';
import {
  get as getSetting,
  ttsEnabled,
  featureEnabled,
  voiceFor,
  setUserVoice,
  clearUserVoice,
  ttsAbbrev,
  setTtsAbbrev,
  clearTtsAbbrev,
  ABBREV_MAX,
} from '../settings.js';
import { VOICES, VOICE_CHOICES, voiceLabel, isKoreanOnly } from './voices.js';
import { withShareButton } from '../share.js';

// 서버별 on/off 상태. 기본값은 켜짐.
const enabledByGuild = new Map();

function isEnabled(guildId) {
  return enabledByGuild.get(guildId) ?? true;
}

const URL_RE = /https?:\/\/\S+/gi;

/** 디스코드 커스텀 이모지. `<:이름:123>` / 움직이는 것은 `<a:이름:123>` */
const CUSTOM_EMOJI_RE = /<a?:\w+:\d+>/g;

/**
 * 유니코드 이모지.
 *
 * 피부톤(👍🏽), ZWJ 조합(👨‍👩‍👧‍👦), 국기(🇰🇷), 키캡(1️⃣), 변형선택자(❤️)까지 잡습니다.
 * ⚠️ `ㅋㅋㅋ` 같은 한글 자음은 이모지가 아니므로 지워지면 안 됩니다 — verify 에 검사가 있습니다.
 */
const EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?)*|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)/gu;

/**
 * 디스코드 메시지를 "읽어도 되는 문장"으로 다듬습니다.
 * 멘션 ID, 이모지 코드, 링크를 그대로 읽으면 알아들을 수 없기 때문입니다.
 */
// ── 낱자(자음·모음)를 소리 나는 글자로 바꾸기 ──────────────────
//
// ★ Edge TTS 는 낱자만 이어진 글에 **소리를 아예 내지 않습니다.**
//   (실측: `ㅋ` 은 정상, `ㅋㅋ` 부터 0바이트. `ㅋㅋㅋ 웃김` 처럼 섞이면 정상)
//   그래서 낱자를 글자로 바꿔줘야 읽힙니다. 아래 세 단계를 순서대로 적용합니다.
//
//   1) 뜻이 있는 축약어    ㅇㅇ → 응응, ㄱㅅ → 감사
//   2) 소리를 흉내낸 반복   ㅋㅋㅋ → 크크크, ㅠㅠ → 흑흑
//   3) 나머지는 소리 나는 대로  ㅅㅂ → 스브, ㅑ → 야
//
//   3단계가 있어서 **무슨 낱자가 와도 무음이 되지 않습니다.**

/**
 * 뜻이 있는 축약어. 낱자만으로 된 낱말일 때만 바꿉니다.
 * 자주 쓰는 게 더 있으면 여기에 한 줄 추가하면 됩니다.
 */
const ABBREV = {
  ㅇㅇ: '응응',
  ㄴㄴ: '노노',
  ㄱㄱ: '고고',
  ㅇㅋ: '오케이',
  ㅂㅂ: '바이바이',
  ㅃㅃ: '빠이빠이',
  ㅅㄱ: '수고',
  ㄱㅅ: '감사',
  ㅈㅅ: '죄송',
  ㅊㅋ: '축하',
  ㅎㅇ: '하이',
  ㅇㅈ: '인정',
  ㅁㅊ: '미친',
  ㄷㄷ: '덜덜',
  ㄱㄷ: '기다려',
  ㅁㄹ: '몰라',
  ㅇㄷ: '어디',
  ㅈㄱ: '지금',
  ㅅㅅ: '수고수고',
};

/** 소리를 흉내낸 낱자. 반복 횟수를 그대로 살립니다. (ㅋㅋㅋ → 크크크) */
const JAMO_SOUND = {
  ㅋ: '크',
  ㅎ: '흐',
  ㅠ: '흑',
  ㅜ: '흑',
};

/**
 * 위에 없는 낱자를 **소리 나는 대로** 바꿉니다.
 * 자음은 ㅡ를 붙이고(ㄱ→그), 모음은 ㅇ을 붙입니다(ㅏ→아).
 * 뜻은 못 살려도 **무음보다는 낫습니다.**
 */
const JAMO_SOUNDOUT = {
  ㄱ: '그', ㄲ: '끄', ㄴ: '느', ㄷ: '드', ㄸ: '뜨', ㄹ: '르', ㅁ: '므',
  ㅂ: '브', ㅃ: '쁘', ㅅ: '스', ㅆ: '쓰', ㅇ: '으', ㅈ: '즈', ㅉ: '쯔',
  ㅊ: '츠', ㅋ: '크', ㅌ: '트', ㅍ: '프', ㅎ: '흐',
  ㄳ: '그스', ㄵ: '느즈', ㄶ: '느흐', ㄺ: '르그', ㄻ: '르므', ㄼ: '르브',
  ㄽ: '르스', ㄾ: '르트', ㄿ: '르프', ㅀ: '르흐', ㅄ: '브스',
  ㅏ: '아', ㅐ: '애', ㅑ: '야', ㅒ: '얘', ㅓ: '어', ㅔ: '에', ㅕ: '여',
  ㅖ: '예', ㅗ: '오', ㅘ: '와', ㅙ: '왜', ㅚ: '외', ㅛ: '요', ㅜ: '우',
  ㅝ: '워', ㅞ: '웨', ㅟ: '위', ㅠ: '유', ㅡ: '으', ㅢ: '의', ㅣ: '이',
};

const JAMO_ONLY_RE = /^[ㄱ-ㅎㅏ-ㅣ]+$/;

/**
 * 낱자를 읽을 수 있는 글자로 바꿉니다.
 * @param {object} [extra] 서버에서 등록한 축약어. **기본 표를 이깁니다.**
 */
function speakJamo(text, extra = {}) {
  // 1) 낱말 단위로 축약어를 먼저 봅니다. (ㄷㄷ 을 '드드' 로 읽으면 안 됩니다)
  //    낱말 사이 공백을 살리려고 구분자까지 같이 쪼갭니다.
  //
  //    ⚠️ 기본 표는 **낱자만인 낱말**에만 적용합니다 (ㅇㅇ·ㄷㄷ …).
  //       서버에서 등록한 것은 낱자든 아니든 **낱말 전체가 같으면** 바꿉니다 —
  //       "ㅇㅅㅇ" 도 "갓생" 도 "wtf" 도 등록할 수 있어야 하니까요.
  //       낱말 전체로만 맞춰보므로 글 중간의 글자를 망가뜨리지 않습니다.
  text = text
    .split(/(\s+)/)
    .map((tok) => {
      if (!tok.trim()) return tok;
      if (extra[tok]) return extra[tok];
      return JAMO_ONLY_RE.test(tok) && ABBREV[tok] ? ABBREV[tok] : tok;
    })
    .join('');

  // 2) 소리를 흉내낸 반복. 글 중간에 섞여 있어도 바꿉니다. (안녕 ㅋㅋ → 안녕 크크)
  text = text.replace(/([ㄱ-ㅎㅏ-ㅣ])\1*/g, (run, jamo) =>
    JAMO_SOUND[jamo] ? JAMO_SOUND[jamo].repeat(run.length) : run
  );

  // 3) 남은 낱자는 소리 나는 대로. 여기까지 오면 무음이 될 일이 없습니다.
  return text.replace(/[ㄱ-ㅎㅏ-ㅣ]/g, (j) => JAMO_SOUNDOUT[j] ?? j);
}

export function cleanText(message, maxChars) {
  let text = message.content ?? '';
  // 이 서버에서 등록한 축약어. 없으면 빈 객체입니다.
  const extra = message.guildId ? ttsAbbrev(message.guildId) : {};

  // <@123> 같은 멘션을 사람 이름으로 바꿉니다.
  text = text.replace(/<@!?(\d+)>/g, (_, id) => {
    const m = message.guild?.members?.cache?.get(id);
    return m ? `${m.displayName} ` : '누군가 ';
  });
  text = text.replace(/<@&(\d+)>/g, (_, id) => {
    const r = message.guild?.roles?.cache?.get(id);
    return r ? `${r.name} ` : '역할 ';
  });
  text = text.replace(/<#(\d+)>/g, (_, id) => {
    const c = message.guild?.channels?.cache?.get(id);
    return c ? `${c.name} 채널 ` : '채널 ';
  });

  // ── 이모지는 읽지 않습니다 ──
  // 이모지 이름("kekw")이나 유니코드 설명을 소리내어 읽으면 알아들을 수 없고 시끄럽습니다.
  // 그래서 전부 지우고, 지울 게 있었는지만 기억해둡니다.
  const before = text;
  text = text.replace(CUSTOM_EMOJI_RE, ' '); // <:이름:123>, <a:이름:123>
  text = text.replace(EMOJI_RE, ' '); // 😀 👍🏽 👨‍👩‍👧‍👦 🇰🇷 1️⃣ …
  const hadEmoji = text !== before;

  // 링크는 통째로 읽으면 끔찍하므로 한마디로 줄입니다.
  // 소유자 요청: "링크" 만 읽으면 뜬금없어서 **"링크를 보냈어요"** 로 읽습니다.
  text = text.replace(URL_RE, ' 링크를 보냈어요 ');

  // 마크다운 기호 제거
  text = text.replace(/[*_~`|>]/g, '');

  // ㅋㅋㅋㅋㅋㅋ, ㅎㅎㅎㅎ, !!!!! 같은 반복은 3개까지만
  text = text.replace(/(.)\1{2,}/g, '$1$1$1');

  // 낱자(자음·모음)를 읽을 수 있는 글자로. 안 하면 무음이 됩니다 — speakJamo 주석 참고.
  text = speakJamo(text, extra);

  text = text.replace(/\s+/g, ' ').trim();

  // 이모지만 보낸 경우. 지우고 나면 읽을 게 없으므로 이렇게 알려줍니다.
  if (!text && hadEmoji) return '이모지를 보냈어요.';

  if (text.length > maxChars) text = text.slice(0, maxChars) + ' 이하 생략';
  return text;
}

/**
 * TTS가 읽을 음성채널을 정합니다. 위에서부터 먼저 맞는 것을 씁니다.
 *
 * 1. /채널설정 으로 읽어주기 음성채널을 못박아둔 경우 → 그 채널
 * 2. 글이 올라온 곳이 음성채널 안의 채팅인 경우 → **그 음성채널**
 *    (음성채널에는 자체 채팅창이 있습니다. 거기에 쓴 글은 그 채널에서 읽어주는 게 자연스럽습니다)
 * 3. 그 외 → 글 쓴 사람이 들어가 있는 음성채널
 */
async function resolveTtsVoiceChannel(guild, member, sourceChannel) {
  const configured = getSetting(guild.id, 'ttsVoiceChannelId');
  if (configured) {
    const ch = await guild.channels.fetch(configured).catch(() => null);
    if (ch?.isVoiceBased?.()) return ch;
    return null;
  }
  if (sourceChannel?.isVoiceBased?.()) return sourceChannel;
  return member?.voice?.channel ?? null;
}

/**
 * 메시지 하나를 읽어줍니다.
 * @returns {boolean} 처리했으면 true
 */
export async function handleTtsMessage(message) {
  if (!featureEnabled(message.guildId, 'tts')) return false;
  if (!ttsEnabled(message.guildId)) return false;
  if (message.channelId !== getSetting(message.guildId, 'ttsTextChannelId')) return false;
  if (!isEnabled(message.guildId)) return false;

  // "//" 로 시작하면 읽지 않습니다. (귓속말용 탈출구)
  if (message.content.startsWith('//')) return false;

  const text = cleanText(message, config.tts.maxChars);
  if (!text) return false;

  const voiceChannel = await resolveTtsVoiceChannel(message.guild, message.member, message.channel);
  if (!voiceChannel) {
    // 아무도 음성채널에 없으면 조용히 무시합니다. (매번 경고하면 시끄러움)
    return false;
  }

  const spoken = config.tts.readAuthor
    ? `${message.member?.displayName ?? message.author.username}, ${text}`
    : text;

  try {
    const audio = getGuildAudio(message.guild);
    await audio.connect(voiceChannel);
    // 글쓴이가 자기 목소리를 정해뒀으면 그걸 씁니다.
    const voice = voiceFor(message.guildId, message.author.id);
    audio.speak(() => synthesize(spoken, voice), voiceChannel.id);
  } catch (err) {
    console.error('[tts] 실패:', err.message);
    await message.react('⚠️').catch(() => {});
  }
  return true;
}

// ── 슬래시 명령어 ───────────────────────────────────────────

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('읽어주기')
      .setDescription('읽어주기 기능을 켜거나 끕니다')
      .addBooleanOption((o) => o.setName('켜기').setDescription('켜면 true, 끄면 false').setRequired(true)),
    async execute(interaction) {
      if (!ttsEnabled(interaction.guildId)) {
        return interaction.reply({
          content:
            '읽어줄 채팅방이 지정되지 않아 기능이 꺼져 있습니다.\n' +
            '`/채널설정` 에서 종류를 "읽어주기 채팅방" 으로 골라 지정해주세요.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const on = interaction.options.getBoolean('켜기');
      enabledByGuild.set(interaction.guildId, on);
      await interaction.reply(on ? '🔊 읽어주기를 켰습니다.' : '🔇 읽어주기를 껐습니다.');
    },
  },

  // /목소리 — **사람마다** 자기 목소리를 정합니다.
  //
  // 예전에는 `/목소리`(서버 기본) 와 `/내목소리`(개인) 둘로 나뉘어 있었는데,
  // 둘 다 있으면 어느 쪽을 써야 할지 헷갈립니다. 개인 설정만 남겼습니다.
  // 서버 기본값은 `.env` 의 `TTS_VOICE` 로 정합니다.
  {
    data: new SlashCommandBuilder()
      .setName('목소리')
      .setDescription('내 글을 읽을 목소리를 고릅니다 (사람마다 다르게 쓸 수 있습니다)')
      .addStringOption((o) =>
        o
          .setName('목소리')
          .setDescription('고르지 않으면 기본 목소리로 되돌립니다')
          .setRequired(false)
          .addChoices(...VOICE_CHOICES)
      ),
    async execute(interaction) {
      const picked = interaction.options.getString('목소리');

      if (!picked) {
        // 비우고 실행하면 내 설정을 지웁니다 (기본값으로 돌아감).
        const had = clearUserVoice(interaction.guildId, interaction.user.id);
        const now = voiceFor(interaction.guildId, interaction.user.id);
        return interaction.reply({
          content: had
            ? `🔄 내 목소리 설정을 지웠습니다. 이제 기본 목소리 **${voiceLabel(now)}** 를 씁니다.`
            : `지금 기본 목소리 **${voiceLabel(now)}** 를 쓰고 있습니다.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      setUserVoice(interaction.guildId, interaction.user.id, picked);
      await interaction.reply({
        content: `🗣️ 앞으로 내 글은 **${voiceLabel(picked)}** 로 읽습니다.${koreanOnlyWarning(picked)}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  // /축약어 — 서버마다 쓰는 말을 등록합니다.
  //
  // 기본 표(ABBREV)는 코드에 있어서 고치려면 배포해야 합니다. 친구들끼리 쓰는 말은
  // 서버마다 다르니, 디스코드에서 바로 추가할 수 있어야 합니다.
  //
  // ⚠️ **명령어를 하나만 만듭니다** (3.6-6). 인자 없이 실행하면 목록이 나오고,
  //    지우는 것은 그 목록의 **드롭다운**으로 합니다. `/축약어추가`·`/축약어삭제` 를
  //    따로 만들면 명령어가 또 불어납니다.
  {
    data: new SlashCommandBuilder()
      .setName('축약어')
      .setDescription('읽어줄 때 바꿔 읽을 말을 등록합니다 (비우면 목록을 봅니다)')
      .addStringOption((o) =>
        o.setName('단어').setDescription('바꿀 말. 예: ㄱㅊ').setRequired(false)
      )
      .addStringOption((o) =>
        o.setName('읽기').setDescription('이렇게 읽습니다. 예: 괜찮아').setRequired(false)
      ),
    async execute(interaction) {
      const word = interaction.options.getString('단어')?.trim();
      const reading = interaction.options.getString('읽기')?.trim();

      // 둘 다 없으면 목록. 이걸 위해 명령어를 또 만들지 않습니다.
      if (!word && !reading) {
        return interaction.reply(buildAbbrevPanel(interaction.guildId));
      }
      if (!word || !reading) {
        return interaction.reply({
          content:
            '**단어**와 **읽기**를 둘 다 적어주세요.\n' +
            '예: `/축약어 단어:ㄱㅊ 읽기:괜찮아`\n' +
            '둘 다 비우면 등록된 목록을 보여줍니다.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const res = setTtsAbbrev(interaction.guildId, word, reading);
      if (!res.ok) {
        return interaction.reply({ content: `⚠️ ${res.reason}`, flags: MessageFlags.Ephemeral });
      }
      await interaction.reply(
        `🗣️ 앞으로 **${word}** 는 "**${reading}**" 로 읽습니다. (등록 ${res.count}개)`
      );
    },
  },
];

/** 등록된 축약어 목록 + 지우기 드롭다운. */
export function buildAbbrevPanel(guildId) {
  const dict = ttsAbbrev(guildId);
  const words = Object.keys(dict);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🗣️ 축약어')
    .setDescription(
      words.length === 0
        ? '아직 등록된 것이 없습니다.\n`/축약어 단어:ㄱㅊ 읽기:괜찮아` 처럼 등록하세요.\n' +
            '기본 축약어(ㅇㅇ·ㄱㅅ·ㄷㄷ 등)는 등록 없이도 읽어줍니다.'
        : words.map((w) => `**${w}** → ${dict[w]}`).join('\n')
    )
    .setFooter({ text: `등록 ${words.length}/${ABBREV_MAX}개 · 같은 단어를 다시 등록하면 덮어씁니다` });

  // 등록된 게 없어도 공유할 값어치는 있습니다 — "이렇게 등록하세요" 안내가 들어 있습니다.
  if (words.length === 0) return withShareButton({ embeds: [embed], flags: MessageFlags.Ephemeral });

  // 드롭다운은 25개까지입니다. 넘으면 앞 25개만 지울 수 있고, 그 사실을 적어줍니다.
  const shown = words.slice(0, 25);
  if (shown.length < words.length) {
    embed.setFooter({ text: `등록 ${words.length}/${ABBREV_MAX}개 · 아래에서는 앞 ${shown.length}개만 지울 수 있습니다` });
  }
  return withShareButton({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('tts:abbrev:del')
          .setPlaceholder('🗑️ 지울 축약어를 고르세요')
          .setMinValues(1)
          .setMaxValues(shown.length)
          .addOptions(shown.map((w) => ({ label: w.slice(0, 100), value: w, description: dict[w].slice(0, 100) })))
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/** 축약어 지우기 드롭다운 처리. customId 가 `tts:` 로 시작하는 것만 옵니다. */
export async function handleTtsComponent(interaction) {
  if (interaction.customId !== 'tts:abbrev:del') return;
  const gone = interaction.values.filter((w) => clearTtsAbbrev(interaction.guildId, w));
  await interaction.update(buildAbbrevPanel(interaction.guildId));
  await interaction
    .followUp({
      content: gone.length > 0 ? `🗑️ ${gone.map((w) => `**${w}**`).join(', ')} 를 지웠습니다.` : '이미 지워진 것입니다.',
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
}

/** 한국어 전용 목소리를 골랐을 때만 붙이는 경고. */
function koreanOnlyWarning(voice) {
  if (!isKoreanOnly(voice)) return '';
  return '\n⚠️ 이 목소리는 한국어 전용입니다. 일본어가 섞이면 그 부분은 소리 없이 넘어가고, 영어는 한국어 발음으로 읽습니다.';
}
