// .env 파일을 읽어서 설정값으로 정리합니다.
// 값이 빠졌으면 여기서 미리 잡아서, 봇이 이상하게 도는 대신 명확한 에러를 냅니다.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
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

/**
 * .env 에 같은 항목이 여러 번 적혀 있으면 알려줍니다.
 *
 * `echo "KEY=값" >> .env` 로 설정을 덧붙이다 보면 같은 줄이 쌓이는데,
 * dotenv 는 조용히 하나만 쓰기 때문에 "분명히 고쳤는데 안 바뀐다" 가 됩니다.
 * 실제로 YTDLP_COOKIES_FILE 이 3줄 쌓여서 진단을 헤맨 적이 있습니다.
 */
function warnDuplicateEnvKeys() {
  try {
    const text = readFileSync(path.join(ROOT, '.env'), 'utf8');
    const seen = new Map();
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    const dups = [...seen].filter(([, n]) => n > 1);
    if (dups.length > 0) {
      console.warn(
        `[설정] .env 에 중복된 항목이 있습니다: ${dups.map(([k, n]) => `${k}(${n}번)`).join(', ')}\n` +
          '       마지막 값만 적용됩니다. 헷갈리니 중복 줄을 지워주세요.'
      );
    }
  } catch {
    // .env 가 없어도 됩니다 (환경변수로만 넘길 수도 있으므로)
  }
}
warnDuplicateEnvKeys();

const required = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missing = required.filter((k) => str(k) === '' || str(k).startsWith('여기에'));
if (missing.length > 0) {
  console.error(
    `\n[설정 오류] .env 파일에 다음 값이 비어 있습니다: ${missing.join(', ')}\n` +
      `.env.example 을 복사해서 .env 로 만들고 값을 채워주세요.\n`
  );
  process.exit(1);
}

/**
 * 봇을 나눠 돌릴 때 **같은 디스코드 애플리케이션**을 두 번 쓰는 사고를 막습니다.
 *
 * `.env.music` 을 만들면서 토큰만 그대로 두기가 정말 쉽습니다. 그러면 두 프로세스가
 * 같은 봇으로 로그인해서 **모든 명령에 두 번 답하고**, `npm run deploy:music` 이
 * 나머지 봇의 명령어를 통째로 지워버립니다. 원인을 찾기가 아주 어렵습니다.
 */
function assertDifferentApplications() {
  const read = (name) => {
    try {
      return readFileSync(path.join(ROOT, name), 'utf8');
    } catch {
      return null;
    }
  };
  const pick = (text, key) => text?.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();

  const main = read('.env');
  const music = read('.env.music');
  if (!main || !music) return; // 나눠 쓰지 않는 상태입니다

  for (const key of ['DISCORD_TOKEN', 'CLIENT_ID']) {
    const a = pick(main, key);
    const b = pick(music, key);
    if (a && b && a === b) {
      console.error(`[설정 오류] .env 와 .env.music 의 ${key} 가 같습니다.`);
      console.error('   같은 봇으로 두 번 로그인하면 모든 명령에 두 번 답하고,');
      console.error('   deploy 가 서로의 명령어를 지웁니다.');
      console.error('   → 디스코드 개발자 포털에서 **애플리케이션을 하나 더** 만들고');
      console.error('     그 토큰과 CLIENT_ID 를 .env.music 에 넣으세요.');
      process.exit(1);
    }
  }
}
assertDifferentApplications();

const imageDirRaw = str('IMAGE_DIR', './data/images');
const dataDirRaw = str('DATA_DIR', './data');

/**
 * 이 봇이 누구인가. 한 저장소로 **봇 두 개**를 돌립니다.
 *
 *   mango — 망고 (기본값). 읽어주기·타이머·이미지. **음악은 없습니다.**
 *   music — 노래하는 망고. 음악만.
 *
 * 둘은 **완전히 다른 봇**입니다. 겸하는 모드는 없습니다.
 * 그래서 디스코드 애플리케이션도 반드시 두 개여야 합니다 —
 * 같은 토큰으로 두 번 띄우면 두 프로세스가 같은 명령을 받아 **두 번 답합니다.**
 * 자세한 건 docs/ARCHITECTURE.md 2.1절.
 */
const BOTS = {
  mango: { name: '망고', features: ['tts', 'timer', 'images'] },
  music: { name: '노래하는 망고', features: ['music'] },
};

const roleRaw = str('BOT_ROLE', 'mango').toLowerCase();
if (!BOTS[roleRaw]) {
  console.error(`[설정 오류] BOT_ROLE 값이 잘못됐습니다: "${roleRaw}"`);
  console.error(`   쓸 수 있는 값: ${Object.keys(BOTS).join(' / ')}`);
  console.error('   mango = 망고 (읽어주기·타이머·이미지) / music = 노래하는 망고 (음악)');
  console.error('   비워두면 mango 입니다.');
  process.exit(1);
}

export const config = {
  role: roleRaw,
  /** 사용자에게 보여줄 이 봇의 이름. */
  botName: BOTS[roleRaw].name,
  /** 이 봇이 맡은 기능들. settings.js 의 FEATURES 키와 같습니다. */
  roleFeatures: BOTS[roleRaw].features,
  token: str('DISCORD_TOKEN'),
  clientId: str('CLIENT_ID'),
  // 여러 서버에서 쓸 수 있습니다. .env 에 쉼표로 나열하세요.
  //   GUILD_ID=123456789012345678,987654321098765432
  // 슬래시 명령어는 여기 적힌 서버들에 각각 등록됩니다. (npm run deploy)
  guildIds: list('GUILD_ID'),

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
