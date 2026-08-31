// 텍스트를 음성(mp3 스트림)으로 바꿉니다.
//
// Microsoft Edge의 읽어주기 엔진(msedge-tts)을 씁니다.
//   - 무료, 가입/API키 불필요
//   - 한국어 음질이 좋음 (ko-KR-SunHiNeural 등)
//   - 인터넷 연결 필요 (마이크로소프트 서버와 웹소켓으로 통신)
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

let cached = null;
let cachedVoice = null;

async function getEngine(voice) {
  if (cached && cachedVoice === voice) return cached;

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  cached = tts;
  cachedVoice = voice;
  return tts;
}

/**
 * @param {string} text 읽을 문장
 * @param {string} voice 예: ko-KR-SunHiNeural
 * @returns {Promise<import('node:stream').Readable>} mp3 스트림
 */
export async function synthesize(text, voice) {
  try {
    const engine = await getEngine(voice);
    return engine.toStream(text).audioStream;
  } catch (err) {
    // 웹소켓이 끊겨 있으면 한 번 새로 만들어서 재시도합니다.
    cached = null;
    cachedVoice = null;
    const engine = await getEngine(voice);
    return engine.toStream(text).audioStream;
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
