// 제미나이(Gemini API) 호출을 감싸는 얇은 래퍼입니다.
//
// 왜 제미나이인가: **무료 등급이 있습니다.** ChatGPT 는 API 를 쓰려면 별도로 충전해야
// 하는데(Plus 구독과 무관합니다), 제미나이는 AI Studio 에서 키만 발급받아
// Flash 계열을 무료 한도 안에서 쓸 수 있습니다.
// 소유자 결정(2026-09-02): 제미나이만 붙인다.
//
// ⚠️ 이 파일은 **실제 API 로 검증하지 못한 상태로 작성됐습니다.** 키가 없어서입니다.
//    그래서 오류 경로에 특히 공을 들였습니다 — 처음 돌릴 때 무엇이 틀렸는지
//    제미나이가 한 말을 그대로 보여줍니다. (ARCHITECTURE 3.1-4)
import { config } from '../config.js';
import { userError } from '../user-error.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export function hasKey() {
  return Boolean(config.ai.geminiKey);
}

/**
 * 키가 없을 때 보여줄 안내.
 *
 * 따로 빼둔 이유: `verify` 가 이 문구를 확인해야 하는데, 확인하려고 `ask()` 를 부르면
 * **키가 있는 서버에서는 제미나이를 진짜로 호출합니다.** 무료 한도를 깎으면서요.
 * `npm run verify` 는 네트워크를 쓰지 않아야 합니다. (실제로 겪었습니다)
 */
export function missingKeyMessage() {
  return (
    '제미나이 API 키가 없습니다.\n' +
    'https://aistudio.google.com/apikey 에서 발급받아 `.env` 의 `GEMINI_API_KEY` 에 넣고 재시작해주세요.'
  );
}

/**
 * 망고의 성격과 하지 않을 일.
 *
 * ⚠️ **짧게 씁니다.** 이 글은 질문할 때마다 같이 보내는 비용입니다.
 * ⚠️ "짧게 답하라" 를 넣는 이유는 두 가지입니다 — 답이 길면 돈이고, 디스코드에서 읽기도 힘듭니다.
 */
const SYSTEM = [
  '너는 디스코드 봇 "망고" 야. 친구들끼리 쓰는 개인 서버에서 같이 노는 친구다.',
  '',
  '말투 (소유자가 정한 것):',
  '- 이름은 **망고**. 자기를 부를 때 그렇게 말해.',
  '- **반말**로 답해. 존댓말 쓰지 마.',
  '- 자연스러운 **구어체**로 써. 친구랑 카톡하듯이. 딱딱한 문서체 금지.',
  '- 이모지는 어울릴 때만 하나 정도. 남발하지 마.',
  '',
  '내용:',
  '- **짧게.** 자세히 물어본 게 아니면 3~4문장 안에 끝내.',
  '- 모르는 건 모른다고 해. 그럴듯하게 지어내지 마.',
  '- 개인정보 캐기, 특정인 비방, 위험한 행동 안내는 거절해.',
].join('\n');

/**
 * 제미나이의 오류를 **한국어 + 다음에 뭘 할지** 로 바꿉니다.
 *
 * ⚠️ 모르는 오류는 **제미나이가 한 말을 그대로** 보여줍니다. 추측한 원인을 적으면
 *    그 뒤로 아무도 진짜 원인을 못 찾습니다. (3.1-4)
 */
export function friendlyError(status, body) {
  const raw = String(body?.error?.message ?? '').trim();
  const short = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;

  if (status === 400 && /api[ _-]?key/i.test(raw)) {
    return '제미나이가 API 키를 거부했습니다. `.env` 의 `GEMINI_API_KEY` 를 확인해주세요.';
  }
  if (status === 403) {
    return (
      '제미나이가 접근을 거부했습니다. 키가 만료됐거나 권한이 없습니다.\n' +
      'https://aistudio.google.com/apikey 에서 키를 다시 확인해주세요.'
    );
  }
  if (status === 404) {
    return (
      `\`${config.ai.geminiModel}\` 모델을 찾을 수 없습니다.\n` +
      '`.env` 의 `GEMINI_MODEL` 을 바꿔주세요. (무료로 쓰려면 Flash 계열)\n' +
      (short ? `제미나이가 한 말: \`${short}\`` : '')
    );
  }
  if (status === 429) {
    return (
      '제미나이 요청 한도를 넘겼습니다. **무료 등급은 분당·하루 횟수 제한이 있습니다.**\n' +
      '잠시 뒤 다시 시도해주세요. 자주 그러면 https://aistudio.google.com/rate-limit 에서 한도를 확인하세요.'
    );
  }
  if (status >= 500) {
    return '제미나이 쪽이 혼잡합니다. 잠시 뒤 다시 시도해주세요.';
  }
  return short
    ? `제미나이가 거절했습니다 (${status}). 아래가 제미나이가 한 말 그대로입니다.\n\`${short}\``
    : `제미나이 오류 (${status}).`;
}

/** 답이 안 온 이유를 설명합니다. 조용히 빈 답을 돌려주면 "먹통" 으로 보입니다. */
function explainEmpty(candidate, feedback) {
  const reason = candidate?.finishReason ?? feedback?.blockReason ?? null;
  if (reason === 'MAX_TOKENS') {
    return `답이 길어서 잘렸습니다. \`.env\` 의 \`AI_MAX_OUTPUT_TOKENS\` 를 올리거나 더 좁게 물어봐 주세요.`;
  }
  if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || feedback?.blockReason) {
    return '제미나이가 답하지 않기로 했습니다. 질문을 다르게 해보세요.';
  }
  return reason
    ? `답이 비어 있습니다. 제미나이가 남긴 이유: \`${reason}\``
    : '답이 비어 있습니다. 잠시 뒤 다시 시도해주세요.';
}

function requestBody(prompt, { withoutThinking }) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: config.ai.maxOutputTokens },
  };
  // ⚠️ 제미나이는 기본으로 "생각" 을 하고, **그 생각도 출력 토큰을 먹습니다.**
  //    한도를 낮게 잡아두면 생각만 하다 답이 비어서 돌아옵니다. 그래서 가장 낮게 둡니다.
  //
  // ⚠️ 필드 이름이 바뀌었습니다. 3.x 는 `thinkingLevel`(low·medium·high) 이고
  //    예전 `thinkingBudget` 은 폐기됐습니다. 그래서 **모델마다 받는 이름이 다릅니다.**
  //    거부하면 이 항목만 빼고 한 번 더 시도합니다 — 재생이 되는 게 먼저입니다.
  //
  // ⚠️ `temperature`·`topP`·`topK` 는 3.x 에서 폐기됐습니다(무시되거나 400).
  //    **넣지 마세요.** 지금도 안 보냅니다.
  if (!withoutThinking) {
    body.generationConfig.thinkingConfig = { thinkingLevel: config.ai.thinkingLevel };
  }
  return body;
}

/**
 * 질문 하나를 보내고 답을 받아옵니다.
 *
 * @param {string} prompt 사용자가 물어본 내용
 * @returns {Promise<string>} 답 (한 덩어리 글자)
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 다시 하면 될 수도 있는 실패인가.
 *
 * ⚠️ **429(한도 초과)는 넣지 않습니다.** 곧바로 다시 던지면 상황이 나빠지고,
 *    하루 한도가 떨어진 것이라면 몇 번을 해도 똑같습니다. 그건 바로 알려주는 게 낫습니다.
 * ⚠️ **시간 초과도 넣지 않습니다.** 이미 30초를 기다린 사람을 또 기다리게 만듭니다.
 *    (30초 × 3 = 90초를 쳐다보게 됩니다)
 * 5xx 와 연결 실패만 재시도합니다 — 둘 다 **빨리 실패해서** 다시 해볼 값어치가 있습니다.
 */
function isRetryable(status) {
  return status >= 500;
}

/** 한 번 호출합니다. 결과는 판단하지 않고 그대로 돌려줍니다. */
async function callOnce(prompt, withoutThinking) {
  // 하염없이 기다리지 않게 제한시간을 둡니다. (movie/tmdb.js 와 같은 모양)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(config.ai.geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.ai.geminiKey },
      body: JSON.stringify(requestBody(prompt, { withoutThinking })),
      signal: ctrl.signal,
    });
    return { res, body: await res.json().catch(() => null) };
  } catch (err) {
    if (err.name === 'AbortError') {
      // 시간 초과는 재시도하지 않습니다 (위 설명). 바로 알립니다.
      throw userError(
        `제미나이가 ${config.ai.timeoutMs / 1000}초 안에 답하지 않았습니다. 잠시 뒤 다시 시도해주세요.`
      );
    }
    return { netError: err };
  } finally {
    clearTimeout(timer);
  }
}

export async function ask(prompt) {
  if (!hasKey()) throw userError(missingKeyMessage());

  const attempts = Math.max(1, config.ai.retries + 1);
  // "생각" 설정 이름이 모델마다 달라서 한 번 빼고 다시 해봅니다.
  // ⚠️ 이건 **재시도 횟수로 세지 않습니다.** 혼잡해서 다시 하는 것과 다른 일입니다.
  let withoutThinking = false;
  let usedThinkingFallback = false;

  for (let attempt = 1; ; attempt++) {
    const { res, body, netError } = await callOnce(prompt, withoutThinking);

    if (netError) {
      if (attempt >= attempts) throw userError(`제미나이에 연결하지 못했습니다: ${netError.message}`);
      console.warn(`[ai] 연결 실패, 재시도 ${attempt}/${attempts - 1}: ${netError.message}`);
      await sleep(config.ai.retryDelayMs * attempt);
      continue;
    }

    if (!res.ok) {
      // 이 모델이 "생각" 설정 이름을 모르면 그것만 빼고 한 번 더. (횟수 소모 없음)
      if (!usedThinkingFallback && /thinking/i.test(String(body?.error?.message ?? ''))) {
        usedThinkingFallback = true;
        withoutThinking = true;
        attempt -= 1;
        continue;
      }
      if (isRetryable(res.status) && attempt < attempts) {
        console.warn(`[ai] 제미나이 ${res.status}, 재시도 ${attempt}/${attempts - 1}`);
        await sleep(config.ai.retryDelayMs * attempt);
        continue;
      }
      throw userError(friendlyError(res.status, body));
    }

    const candidate = body?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((p) => p?.text ?? '')
      .join('')
      .trim();

    // 답이 비는 것은 혼잡이 아니라 이유가 있는 것입니다(안전 필터·길이 초과). 재시도하지 않습니다.
    if (!text) throw userError(explainEmpty(candidate, body?.promptFeedback));
    return text;
  }
}
