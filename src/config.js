// .env 파일을 읽어서 설정값으로 정리합니다.
// 값이 빠졌으면 여기서 미리 잡아서, 봇이 이상하게 도는 대신 명확한 에러를 냅니다.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(key, fallback) {
  const v = str(key);
  if (v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key, fallback = false) {
  const v = str(key).toLowerCase();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

function list(key) {
  return str(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missing = required.filter((k) => str(k) === '' || str(k).startsWith('여기에'));
if (missing.length > 0) {
  console.error(
    `\n[설정 오류] .env 파일에 다음 값이 비어 있습니다: ${missing.join(', ')}\n` +
      `.env.example 을 복사해서 .env 로 만들고 값을 채워주세요.\n`
  );
  process.exit(1);
}

const imageDirRaw = str('IMAGE_DIR', './data/images');
const dataDirRaw = str('DATA_DIR', './data');

export const config = {
  token: str('DISCORD_TOKEN'),
  clientId: str('CLIENT_ID'),
  guildId: str('GUILD_ID'),

  // 봇이 기억해야 하는 것들을 저장하는 폴더 (채널 설정 등)
  dataDir: path.isAbsolute(dataDirRaw) ? dataDirRaw : path.join(ROOT, dataDirRaw),

  music: {
    textChannelId: str('MUSIC_TEXT_CHANNEL_ID'),
    voiceChannelId: str('MUSIC_VOICE_CHANNEL_ID'),
    leaveAfterSec: num('MUSIC_LEAVE_AFTER_SEC', 300),
  },

  tts: {
    textChannelId: str('TTS_TEXT_CHANNEL_ID'),
    voiceChannelId: str('TTS_VOICE_CHANNEL_ID'),
    // 기본값을 다국어 목소리로 둡니다.
    // ko-KR-SunHiNeural 은 일본어를 만나면 소리를 아예 내지 않습니다(실측 0바이트).
    // Hyunsu 는 영어/일본어/중국어를 전부 정상적으로 읽습니다. docs/ARCHITECTURE.md 3.4절 참고.
    voice: str('TTS_VOICE', 'ko-KR-HyunsuMultilingualNeural'),
    maxChars: num('TTS_MAX_CHARS', 200),
    readAuthor: bool('TTS_READ_AUTHOR', false),
  },

  images: {
    channelIds: list('IMAGE_CHANNEL_ID'),
    dir: path.isAbsolute(imageDirRaw) ? imageDirRaw : path.join(ROOT, imageDirRaw),
    webPort: num('WEB_PORT', 3000),
    // 웹서버가 귀 기울일 주소.
    //   0.0.0.0   = 외부에서 접속 가능 (기본값. 집 PC에서 쓸 때 편함)
    //   127.0.0.1 = 이 컴퓨터 안에서만. 서버에 올린 뒤 SSH 터널로 볼 때 쓰면
    //               포트를 인터넷에 열지 않아도 되므로 훨씬 안전합니다.
    webBind: str('WEB_BIND', '0.0.0.0'),
    webPublicUrl: str('WEB_PUBLIC_URL', `http://localhost:${num('WEB_PORT', 3000)}`).replace(/\/+$/, ''),
    webToken: str('WEB_TOKEN'),
  },
};
