// 텍스트를 음성(mp3 스트림)으로 바꿉니다.
//
// Microsoft Edge의 읽어주기 엔진(msedge-tts)을 씁니다.
//   - 무료, 가입/API키 불필요
//   - 한국어 음질이 좋음
//   - 인터넷 연결 필요 (마이크로소프트 서버와 웹소켓으로 통신)
//
// ⚡ 속도에 대해 (실측):
//   연결을 새로 맺은 뒤 **첫 발화는 약 1.7초**, 그다음부터는 **70~80ms** 입니다.
//   즉 느린 원인은 합성 자체가 아니라 "식은 연결"입니다.
//   마이크로소프트가 유휴 웹소켓을 끊기 때문에, 채팅이 띄엄띄엄 오면
//   매번 첫 발화 비용(1.7초)을 물게 됩니다.
//
//   그래서 아주 짧은 문장을 주기적으로 합성해 **연결을 따뜻하게 유지**합니다.
//   사용자가 실제로 읽어주기를 쓴 뒤 30분간 조용하면 예열을 멈춥니다.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;

/** 예열용 문장. 짧을수록 좋습니다 (버려지는 데이터라서). */
const WARM_TEXT = '음';
/** 이 간격보다 오래 쉬면 연결이 식습니다. */
const KEEPALIVE_MS = 45_000;
/** 이만큼 아무도 안 쓰면 예열을 멈춥니다 (쓸데없는 통신 방지). */
const IDLE_STOP_MS = 30 * 60_000;

let engine = null;
let engineVoice = null;
let lastUsed = 0;
let keepaliveTimer = null;

async function createEngine(voice) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, FORMAT);
  return tts;
}

/** 스트림을 끝까지 흘려보내 버립니다. (예열용 — 소리는 쓰지 않음) */
function drain(stream) {
  return new Promise((resolve) => {
    stream.on('data', () => {});
    stream.once('end', resolve);
    stream.once('error', resolve);
    setTimeout(resolve, 10_000);
  });
}

/**
 * 연결을 만들고 첫 발화 비용을 미리 치릅니다.
 * 실제 메시지가 올 때는 이미 따뜻한 상태라 70~80ms 만에 나옵니다.
 */
export async function prewarm(voice) {
  try {
    if (!engine || engineVoice !== voice) {
      engine = await createEngine(voice);
      engineVoice = voice;
    }
    await drain(engine.toStream(WARM_TEXT).audioStream);
    startKeepalive();
    return true;
  } catch (err) {
    engine = null;
    engineVoice = null;
    return false;
  }
}

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(async () => {
    // 오래 안 쓰면 예열을 그만둡니다. 다음에 쓸 때 다시 시작됩니다.
    if (lastUsed && Date.now() - lastUsed > IDLE_STOP_MS) {
      stopKeepalive();
      engine = null;
      engineVoice = null;
      return;
    }
    // 방금 썼으면 이미 따뜻하므로 건너뜁니다.
    if (Date.now() - lastUsed < KEEPALIVE_MS) return;
    if (!engine) return;
    try {
      await drain(engine.toStream(WARM_TEXT).audioStream);
    } catch {
      // 연결이 끊겼습니다. 다음 요청 때 새로 만듭니다.
      engine = null;
      engineVoice = null;
    }
  }, KEEPALIVE_MS);
  // 이 타이머 때문에 프로세스가 종료되지 못하는 일은 없어야 합니다.
  keepaliveTimer.unref?.();
}

export function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/**
 * 읽는 속도를 msedge-tts 가 받는 모양으로 바꿉니다.
 *
 * `toStream(text, { rate })` 의 기본값이 `1.0` (배수)이므로 **퍼센트를 100으로 나눕니다.**
 * SSML 의 `<prosody rate="1.3">` 로 들어갑니다.
 * 100이면 아무것도 넘기지 않습니다 — 기본 동작을 그대로 두는 편이 안전합니다.
 */
function rateOptions(speedPercent) {
  const p = Number(speedPercent);
  if (!Number.isFinite(p) || p === 100) return undefined;
  return { rate: p / 100 };
}

/**
 * @param {string} text 읽을 문장
 * @param {string} voice 예: ko-KR-HyunsuMultilingualNeural
 * @param {number} [speedPercent] 읽는 속도(%). 100 = 원래 속도
 * @returns {Promise<import('node:stream').Readable>} mp3 스트림
 */
export async function synthesize(text, voice, speedPercent = 100) {
  lastUsed = Date.now();
  startKeepalive();

  if (!engine || engineVoice !== voice) {
    engine = await createEngine(voice);
    engineVoice = voice;
  }

  // ⚠️ 속도는 **호출할 때마다** 넘깁니다. 연결(engine)에 묶이는 값이 아니라서
  //    사람마다 다른 속도를 써도 연결을 다시 맺지 않습니다 (예열이 그대로 살아 있음).
  const opts = rateOptions(speedPercent);
  try {
    return engine.toStream(text, opts).audioStream;
  } catch (err) {
    // 웹소켓이 끊겨 있으면 한 번 새로 만들어서 재시도합니다.
    engine = await createEngine(voice);
    engineVoice = voice;
    return engine.toStream(text, opts).audioStream;
  }
}

/** 사용 가능한 목소리 목록 (설정할 때 참고용) */
export async function listVoices(localePrefix = 'ko-') {
  const tts = new MsEdgeTTS();
  const voices = await tts.getVoices();
  return voices
    .filter((v) => v.Locale.startsWith(localePrefix))
    .map((v) => ({ shortName: v.ShortName, gender: v.Gender, friendly: v.FriendlyName }));
}
