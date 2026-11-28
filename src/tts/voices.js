// 쓸 수 있는 목소리 목록.
//
// Edge TTS 가 "한국어(ko-KR)" 로 분류해 주는 목소리는 3개뿐입니다.
// 하지만 **다국어(Multilingual) 목소리는 로케일과 무관하게 한국어를 읽습니다.**
// 2026-08-31 에 한국어 문장으로 다국어 목소리를 실측해 목록을 넓혔습니다.
// Microsoft가 2026-11에 세라피나·플로리안을 목록에서 내렸으므로, 선택지는 고정된
// 카탈로그가 아닙니다. verify가 현재 Edge 목록과 계속 대조합니다.
//
// ⚠️ 여기에 이름을 추가하면 반드시 `npm run verify` 를 돌리세요.
//    Azure 카탈로그에는 있어도 Edge 무료 엔드포인트에는 없는 이름이 많고,
//    없는 이름을 넣으면 런타임에 실패합니다. verify 가 실재 여부를 대조합니다.
export const VOICES = [
  // ── 한국어 전용 ──
  { value: 'ko-KR-SunHiNeural', label: '선희 · 여성', note: '한국어 전용' },
  { value: 'ko-KR-InJoonNeural', label: '인준 · 남성', note: '한국어 전용' },
  // ── 다국어 (영어·일본어 등이 섞여도 자연스럽게 읽음) ──
  { value: 'ko-KR-HyunsuMultilingualNeural', label: '현수 · 남성', note: '다국어 · 기본값' },
  { value: 'en-US-AvaMultilingualNeural', label: '에이바 · 여성', note: '다국어' },
  { value: 'en-US-EmmaMultilingualNeural', label: '엠마 · 여성', note: '다국어' },
  { value: 'en-US-AndrewMultilingualNeural', label: '앤드류 · 남성', note: '다국어' },
  { value: 'en-US-BrianMultilingualNeural', label: '브라이언 · 남성', note: '다국어' },
  { value: 'en-AU-WilliamMultilingualNeural', label: '윌리엄 · 남성', note: '다국어' },
  { value: 'fr-FR-VivienneMultilingualNeural', label: '비비안 · 여성', note: '다국어' },
  { value: 'fr-FR-RemyMultilingualNeural', label: '레미 · 남성', note: '다국어' },
  { value: 'it-IT-GiuseppeMultilingualNeural', label: '주세페 · 남성', note: '다국어' },
  { value: 'pt-BR-ThalitaMultilingualNeural', label: '탈리타 · 여성', note: '다국어' },
];

export const DEFAULT_VOICE = 'ko-KR-HyunsuMultilingualNeural';

export function isVoiceAvailable(value) {
  return VOICES.some((voice) => voice.value === value);
}

/** 슬래시 명령어 선택지 형태로. (디스코드 제한 25개 — 지금 12개라 여유 있음) */
export const VOICE_CHOICES = VOICES.map((v) => ({
  name: `${v.label} (${v.note})`,
  value: v.value,
}));

export function voiceLabel(value) {
  const v = VOICES.find((x) => x.value === value);
  return v ? `${v.label} (${v.note})` : value;
}

export function isKoreanOnly(value) {
  return value.startsWith('ko-KR-') && !value.includes('Multilingual');
}
