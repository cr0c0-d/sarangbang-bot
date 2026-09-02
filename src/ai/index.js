// `/망고야` — 봇에게 물어보기 (제미나이)
//
// 설계 근거는 docs/망고야-기획.md 에 있습니다. 요점만:
//   · 답은 **모두에게 보입니다** (소유자 결정). 투표·영화와 같은 결입니다.
//   · 읽어주기(TTS)로는 읽지 않습니다 — 긴 답을 듣는 건 괴롭습니다.
//   · 대화를 기억하지 않습니다. 기억하면 매번 앞 대화를 다시 보내서 비쌉니다.
//   · 한도가 이 기능의 절반입니다. usage.js 참고.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { userError } from '../user-error.js';
import { ask, hasKey } from './gemini.js';
import { check, record, remaining, tokenUsage } from './usage.js';

/** 디스코드 메시지 한 통의 상한. */
const DISCORD_LIMIT = 2000;
/** 몇 통까지 이어 붙일지. 넘으면 잘라내고 **잘랐다고 말합니다.** */
const MAX_CHUNKS = 3;
const TRUNCATED_NOTICE = '\n\n*(답이 너무 길어 여기까지만 보여드립니다)*';

/**
 * 긴 답을 디스코드가 받는 크기로 나눕니다.
 *
 * ⚠️ **글자 수로만 자르면 단어와 코드가 잘립니다.** 문단 → 줄 → 그래도 길면 글자 순으로
 *    경계를 찾아 자릅니다.
 *
 * @returns {string[]} 각 조각은 limit 이하
 */
export function splitForDiscord(text, limit = DISCORD_LIMIT, firstLimit = limit) {
  const out = [];
  let rest = String(text ?? '').trim();
  let cap = Math.max(1, firstLimit); // 첫 조각만 머리글 자리를 남겨 좁게 잡습니다

  while (rest.length > cap) {
    const head = rest.slice(0, cap);
    // 문단 → 줄 순으로 끊을 자리를 찾습니다. 너무 앞에서 끊기면(절반 미만) 그냥 글자로 자릅니다.
    let cut = head.lastIndexOf('\n\n');
    if (cut < cap / 2) cut = head.lastIndexOf('\n');
    if (cut < cap / 2) cut = cap;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    cap = limit;
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 질문을 인용문으로 만듭니다.
 *
 * ⚠️ `>>>` (여러 줄 인용) 을 쓰면 **그 뒤의 답까지 전부 인용**이 됩니다.
 *    그래서 줄마다 `>` 를 붙입니다.
 */
export function quoteQuestion(question) {
  return String(question ?? '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * 답 한 덩어리를 디스코드에 보낼 모양으로 만듭니다.
 *
 * @param {string} text 제미나이가 준 답
 * @param {string} [question] 같이 보여줄 질문. 디스코드는 슬래시 명령어의 **입력값을
 *   다른 사람에게 보여주지 않습니다** — "○○님이 망고야를 사용함" 만 뜹니다.
 *   답만 덜렁 남으면 무엇을 물어본 건지 아무도 모릅니다. 그래서 우리가 적어줍니다.
 */
export function formatAnswer(text, question = '') {
  const header = question ? `${quoteQuestion(question)}\n\n` : '';
  const chunks = splitForDiscord(text, DISCORD_LIMIT, DISCORD_LIMIT - header.length);
  const kept = chunks.slice(0, MAX_CHUNKS);
  const truncated = chunks.length > MAX_CHUNKS;

  // 조용히 자르면 답이 이상하게 끝난 것처럼 보입니다. (재생목록 자르기와 같은 원칙 — 3.1-1)
  //
  // ⚠️ **안내를 그냥 붙이면 한도를 넘깁니다.** 마지막 조각은 이미 2000자에 꽉 차 있을
  //    수 있어서, 붙이면 2027자가 되고 그 메시지는 **아예 전송되지 않습니다.**
  //    자리를 먼저 비워야 합니다. (verify 가 잡아낸 실제 버그)
  if (truncated) {
    const i = kept.length - 1;
    kept[i] = `${kept[i].slice(0, DISCORD_LIMIT - TRUNCATED_NOTICE.length).trim()}${TRUNCATED_NOTICE}`;
  }
  if (kept.length > 0) kept[0] = header + kept[0];
  return { chunks: kept, truncated };
}

/**
 * 인자 없이 실행했을 때 보여주는 상태. 명령어를 따로 만들지 않습니다 (3.6-6).
 * verify 6x 가 조립해보므로 export 합니다 — 빌더는 toJSON() 에서야 값을 검사합니다.
 */
export function buildStatusPanel(guildId, userId) {
  const left = remaining(guildId, userId);
  const tok = tokenUsage(guildId);
  const n = (v) => v.toLocaleString('ko-KR');

  // 한도는 **서버 통합**이 기본입니다 (소유자 결정). 사람당 한도는 0 = 안 씀.
  const limits = [`서버 **${left.guild}/${left.guildMax}회** 남음 (하루)`];
  if (left.userMax > 0) limits.push(`나 ${left.user}/${left.userMax}회 남음 (1시간)`);

  const embed = new EmbedBuilder()
    .setColor(0xf5a623)
    .setTitle('🥭 망고야')
    .setDescription('`/망고야 질문:...` 로 물어보세요. 답은 이 채팅방 모두에게 보입니다.')
    .addFields(
      { name: '남은 질문', value: limits.join('\n') },
      {
        name: '쓴 토큰',
        // ⚠️ **남은 토큰이 아닙니다.** 제미나이는 남은 양을 안 알려줍니다.
        //    우리가 쓴 것만 세어둔 값입니다. 그 구분을 화면에 적어둡니다.
        value:
          `오늘 ${n(tok.day)} · 이번 달 ${n(tok.month)}\n` +
          '무료 등급의 **남은 양**은 API 로 알 수 없습니다 →\n' +
          '[AI Studio 에서 확인](https://aistudio.google.com/rate-limit)',
      },
      { name: '쓰는 모델', value: hasKey() ? `제미나이 \`${config.ai.geminiModel}\`` : '⚠️ API 키가 없습니다' }
    );
  if (!hasKey()) {
    embed.addFields({
      name: '설정하려면',
      value:
        'https://aistudio.google.com/apikey 에서 키를 받아\n' +
        '`.env` 의 `GEMINI_API_KEY` 에 넣고 봇을 재시작하세요.',
    });
  }
  return { embeds: [embed], flags: MessageFlags.Ephemeral };
}

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('망고야')
      .setDescription('망고에게 물어봅니다 (비우면 남은 횟수를 봅니다)')
      .addStringOption((o) =>
        o.setName('질문').setDescription('궁금한 것을 물어보세요').setRequired(false)
      ),
    async execute(interaction) {
      const question = interaction.options.getString('질문')?.trim();

      // 질문 없이 실행하면 상태를 보여줍니다. 이걸 위해 명령어를 또 만들지 않습니다.
      if (!question) {
        return interaction.reply(buildStatusPanel(interaction.guildId, interaction.user.id));
      }

      // ⚠️ 질문 길이부터 봅니다. **답보다 질문이 더 비쌀 수 있습니다** —
      //    긴 글을 통째로 붙여넣으면 그만큼 토큰을 씁니다.
      if (question.length > config.ai.maxInputChars) {
        throw userError(
          `질문이 너무 깁니다 (${question.length}자). **${config.ai.maxInputChars}자**까지만 됩니다.\n` +
            '줄여서 다시 물어봐 주세요.'
        );
      }

      const gate = check(interaction.guildId, interaction.user.id);
      if (!gate.ok) {
        // 한도 안내는 **나만 보이게** 합니다. 채팅방에 남길 이유가 없습니다.
        return interaction.reply({ content: `🥭 ${gate.reason}`, flags: MessageFlags.Ephemeral });
      }

      // 제미나이 응답은 몇 초 걸립니다. 3초 안에 답하지 않으면 디스코드가
      // "적시에 응답하지 않았어요" 를 띄웁니다. 먼저 자리를 잡아둡니다.
      await interaction.deferReply();

      const { text: answer, tokens } = await ask(question);
      // 성공했을 때만 셉니다. 실패한 질문으로 한도를 깎으면 억울합니다.
      // 쓴 토큰도 같이 남겨서 "얼마나 썼나" 를 볼 수 있게 합니다.
      record(interaction.guildId, interaction.user.id, tokens);

      // 질문을 같이 적어줍니다. 디스코드는 슬래시 명령어의 입력값을 다른 사람에게
      // 보여주지 않아서("○○님이 망고야를 사용함"), 답만 남으면 뭘 물어본 건지 모릅니다.
      const { chunks } = formatAnswer(answer, question);
      await interaction.editReply(chunks[0]);
      for (const extra of chunks.slice(1)) {
        await interaction.followUp(extra).catch(() => {});
      }
    },
  },
];
