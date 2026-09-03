// 수정 후 재검증. 토큰 없이 확인할 수 있는 것 전부.
//
// ★★ **검사는 돌리는 사람의 `.env` 에 기대면 안 됩니다.** ★★
//
// 세 번 같은 사고가 났습니다. 전부 **소유자 서버에서만** 실패했습니다:
//   1. `GEMINI_API_KEY` 가 있어서 "키가 없으면 발급 주소를 알려줌" 이 실패
//      (게다가 실제 API 를 불러 무료 한도를 썼습니다)
//   2. `.env` 에 `YTDLP_PATH` 를 넣으니 "기본 안내는 npm 스크립트" 가 실패
//   3. `TTS_VOICE` · `STREAM_CLIP_MAX_SEC` 등도 같은 함정을 안고 있었습니다
//
// 집 PC 에서 초록불인데 서버에서 빨간불이면 검증이 오히려 방해가 됩니다.
// 그래서 **`.env.example` 에 있는 모든 항목을 먼저 빈 값으로 눌러둡니다.**
// dotenv 는 이미 있는 환경변수를 덮어쓰지 않으므로, 이렇게 하면 `.env` 가
// 무엇을 담고 있어도 검사 결과가 같습니다.
//
// ⚠️ 그래서 **새 설정을 만들면 `.env.example` 에 꼭 추가해야 합니다** (프로젝트 규칙).
//    안 넣으면 그 항목만 소유자 환경에 따라 결과가 달라집니다.
import fs from 'node:fs';

/** 검사가 실제로 필요한 값들. 이것만 남기고 나머지는 전부 눌러 없앱니다. */
const VERIFY_ENV = {
  DISCORD_TOKEN: 'x'.repeat(59),
  CLIENT_ID: '123456789012345678',
  GUILD_ID: '123456789012345678, 987654321098765432',
  TTS_TEXT_CHANNEL_ID: '111111111111111111',
  IMAGE_CHANNEL_ID: '222222222222222222',
  IMAGE_DIR: './data/verify-images',
  WEB_PORT: '38473',
  WEB_TOKEN: 'testsecret',
  WEB_BIND: '127.0.0.1',
  DATA_DIR: './data/verify-data',
};

/** `.env.example` 이 아는 모든 항목. 여기 없는 것은 눌러줄 수도 없습니다. */
const KNOWN_ENV_KEYS = [
  ...new Set(
    ['./.env.example', './.env.music.example']
      .flatMap((p) => fs.readFileSync(p, 'utf8').split('\n'))
      .map((line) => line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1])
      .filter(Boolean)
  ),
];

// ⚠️ **이미 셸에 있는 값도 눌러씁니다.** 채워넣기만 하면 `export YTDLP_PATH=…` 나
//    systemd 의 EnvironmentFile 로 들어온 값은 그대로 남아 검사가 흔들립니다.
//    verify 는 **어디서 돌려도 같은 답**이어야 합니다. 변형을 시험하려면
//    환경변수를 바꾸지 말고 이 파일의 검사를 고치세요.
for (const key of KNOWN_ENV_KEYS) process.env[key] = '';
Object.assign(process.env, VERIFY_ENV);

// ⚠️ **시작할 때도 검사용 폴더를 지웁니다.** 끝에서만 지우면, 검사가 중간에
//    죽었을 때 남은 상태가 **다음 실행을 거짓으로 실패시킵니다.**
//    실제로 그랬습니다 — 등록해둔 축약어가 남아 "등록 전에는 그대로" 가 실패했습니다.
for (const dir of ['./data/verify-data', './data/verify-images']) {
  // ⚠️ `force: true` 는 "없음"만 무시합니다. 파일이 잠겨 있으면(윈도우에서 다른
  //    프로세스가 잡고 있을 때) 그대로 던져서 **검증이 시작도 못 하고 죽습니다.**
  //    지우지 못한 것보다 죽는 것이 나쁩니다. 못 지우면 알리고 계속합니다.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[verify] ${dir} 를 지우지 못했습니다 (${e.code ?? e.message}).`);
    console.warn('         남은 상태 때문에 거짓 실패가 날 수 있습니다. 손으로 지우고 다시 돌려주세요.');
  }
}
// ── 검사 결과 모으기 ─────────────────────────────────────────
//
// ★ 왜 모아두는가: 검사가 1000개를 넘어서, 실패가 나도 **스크롤을 한참 올려야**
//   어디가 깨졌는지 보입니다. 그래서 실패한 것만 **맨 끝에 다시 모아** 보여줍니다.
//   맨 끝은 스크롤하지 않아도 보이는 자리입니다.
//
// 조용히 보고 싶으면: `npm run verify:q`  (실패한 것만 나옵니다)

const args = process.argv.slice(2);
const QUIET = args.includes('-q') || args.includes('--quiet');

let fail = 0;
let checked = 0;
/** @type {Array<{label: string, extra: string}>} 실패한 것만. 끝에서 다시 보여줍니다. */
const failures = [];

const ok = (label, cond, extra = '') => {
  checked++;
  // ⚠️ 함수를 그대로 넘기면 **항상 참**이 되어 조용히 통과합니다.
  //    실제로 한 번 그렇게 썼습니다. 검사가 거짓으로 통과하는 것이 제일 나쁩니다.
  if (typeof cond === 'function') {
    fail++;
    failures.push({ label, extra: '⚠️ 조건에 함수를 넘겼습니다. `cond()` 로 불러서 넘기세요.' });
    console.log(`  FAIL ${label}  ⚠️ 조건에 함수를 넘겼습니다 (항상 통과가 됩니다)`);
    return;
  }
  const passed = Boolean(cond);
  if (!passed) {
    fail++;
    failures.push({ label, extra: String(extra ?? '') });
  }
  if (passed && QUIET) return;
  console.log((passed ? '  ok   ' : '  FAIL ') + label + (extra ? '  ' + extra : ''));
};

/** 실패한 것만 맨 끝에 모아 보여줍니다. */
function reportFailures() {
  if (failures.length === 0) {
    console.log(`\n✅ 전부 통과 — 검사 ${checked}개`);
    return;
  }
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`❌ 실패 ${failures.length}건 — 위로 올리지 않아도 여기 다 있습니다`);
  console.log(line);
  failures.forEach((f, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${f.label}`);
    if (f.extra) console.log(`    └ ${f.extra}`);
  });
  console.log(line);
  console.log(`검사 ${checked}개 중 ${failures.length}개 실패`);
  console.log('실패한 것만 보려면:  npm run verify:q');
}

// 1) 명령어 스키마
const { initSettings } = await import('./src/settings.js');
await initSettings();
const { allCommands } = await import('./src/commands.js');
const names = allCommands.map((c) => c.data.toJSON().name);
// 검증은 기본 봇(망고)으로 돕니다. 노래하는 망고 쪽은 아래 6t) 에서
// 따로 프로세스를 띄워 검사합니다 (config 가 import 시점에 한 번만 읽히므로).
ok('망고 명령어 23개 로드 (우클릭 1개 포함)', allCommands.length === 23, `(${allCommands.length}개) ${names.join(' ')}`);
ok('명령어 이름 중복 없음', new Set(names).size === names.length);
ok('영문 명령어 잔존 없음',
  !names.some((n) => /^[a-z]/.test(n)), names.filter((n) => /^[a-z]/.test(n)).join(',') || '없음');
for (const need of ['채널설정', '나가기', '타이머', '타이머목록', '알람등록', '기능', '목소리', '읽어주기', '폴더', '폴더목록', '정리', '갤러리', '도움말', '투표', '영화', '일정', '일정새로', '정산', '게임']) {
  ok(`/${need} 존재`, names.includes(need));
}
ok('/읽기중지 제거됨 (나가기로 통합)', !names.includes('읽기중지'));

// 1a) 서버 설정을 바꾸거나 데이터를 지우는 명령어는 **관리자만**.
//     setDefaultMemberPermissions 는 디스코드가 직접 막아줍니다. 코드에서 검사하면
//     새 명령어를 추가할 때 반드시 빠뜨립니다 (3.7-1 과 같은 발상).
{
  const { PermissionFlagsBits } = await import('discord.js');
  const perms = new Map(allCommands.map((c) => [c.data.toJSON().name, c.data.toJSON().default_member_permissions]));
  const MANAGE = String(PermissionFlagsBits.ManageGuild);
  for (const name of ['채널설정', '기능', '정리']) {
    ok(`/${name} 은 관리자만`, perms.get(name) === MANAGE, String(perms.get(name)));
  }
  // 친구들이 늘 쓰는 것은 막으면 안 됩니다.
  for (const name of ['도움말', '일정', '일정새로', '정산', '투표', '영화', '게임', '타이머', '목소리', '갤러리']) {
    ok(`/${name} 은 누구나`, !perms.get(name), String(perms.get(name)));
  }
}
// 버튼으로 대체해 없앤 명령어들이 되살아나지 않았는지 (명령어 수 줄이기의 회귀 검사)
for (const gone of ['핑', '다음', '정지', '일시정지', '이어재생', '반복', '이전곡',
                    '대기열제거', '대기열비우기', '목소리목록', '폴더확인', '채널확인', '채널해제',
                    '내목소리']) {
  ok(`/${gone} 제거됨`, !names.includes(gone));
}
for (const c of allCommands) {
  const j = c.data.toJSON();
  if (typeof c.execute !== 'function') ok(`/${j.name} execute`, false);
}
ok('모든 명령어 toJSON + execute 통과', true);

// 2) index.js 가 import 하는 이름들이 존재하는가
const src = fs.readFileSync('./src/index.js', 'utf8');
const re = /import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g;
let m;
while ((m = re.exec(src))) {
  const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
  const mod = await import(m[2].replace('./', './src/'));
  for (const n of names) ok(`import ${n} from ${m[2]}`, n in mod);
}

// 3) MessageFlags 를 쓰는 파일이 전부 import 했는가 (없으면 런타임 ReferenceError)
const srcFiles = fs.readdirSync('./src', { recursive: true })
  .filter((f) => String(f).endsWith('.js'))
  .map((f) => './src/' + String(f).replace(/\\/g, '/'));
for (const f of srcFiles) {
  const t = fs.readFileSync(f, 'utf8');
  if (t.includes('MessageFlags.')) {
    ok(`${f} MessageFlags import`, /import\s*\{[^}]*MessageFlags[^}]*\}\s*from\s*'discord\.js'/.test(t));
  }
}
ok('ephemeral: true 잔존 없음', !srcFiles.some((f) => fs.readFileSync(f, 'utf8').includes('ephemeral: true')));

// 4) 경로 안전장치
const store = await import('./src/images/store.js');
await store.initStore();
for (const c of ['../../Windows', '..\\..\\evil', 'C:\\Windows', '/etc/passwd', '']) {
  ok(`경로탈출 방어 ${JSON.stringify(c)}`, store.folderPath(c).startsWith(store.baseDir()), '→ ' + store.safeFolderName(c));
}
ok('날짜 폴더 하이픈 보존', store.safeFolderName('2026-08-31') === '2026-08-31', store.safeFolderName('2026-08-31'));

// 5) 폴더 결정 규칙: 스레드명 > /폴더 지정 > 채널명 > 날짜
ok('1순위 스레드명',
  store.resolveFolder({ isThread: () => true, name: '여행 사진' }, '999') === '여행 사진');
ok('3순위 채널명 (기본값)',
  store.resolveFolder({ isThread: () => false, name: '사진창고' }, '999') === '사진창고');
ok('4순위 날짜 (채널 이름을 모를 때)',
  /^\d{4}-\d{2}-\d{2}$/.test(store.resolveFolder(null, '999')));
{
  store.setChannelFolder('999', '내가지정한폴더');
  ok('2순위 /폴더 지정이 채널명을 이김',
    store.resolveFolder({ isThread: () => false, name: '사진창고' }, '999') === '내가지정한폴더');
  ok('스레드명은 /폴더 지정보다도 우선',
    store.resolveFolder({ isThread: () => true, name: '스레드폴더' }, '999') === '스레드폴더');
  store.clearChannelFolder('999');
  ok('/폴더 해제하면 채널명으로 복귀',
    store.resolveFolder({ isThread: () => false, name: '사진창고' }, '999') === '사진창고');
}

// 5c) 설정 저장소: 명령어 지정이 .env 를 이기고, 해제하면 되돌아가는가
{
  const st = await import('./src/settings.js');
  const G = 'testguild';
  const before = st.getWithSource(G, 'ttsTextChannelId');
  ok('.env 값이 기본 출처', before.source === 'env' && before.value === '111111111111111111');
  st.set(G, 'ttsTextChannelId', '777777777777777777');
  const after = st.getWithSource(G, 'ttsTextChannelId');
  ok('명령어 지정이 .env 를 덮어씀', after.source === 'command' && after.value === '777777777777777777');
  st.clear(G, 'ttsTextChannelId');
  ok('해제하면 .env 로 복귀', st.getWithSource(G, 'ttsTextChannelId').source === 'env');

  st.set(G, 'imageChannelIds', '888888888888888888');
  const multi = st.get(G, 'imageChannelIds');
  ok('이미지 채널은 목록에 추가됨 (.env 것도 유지)',
    multi.includes('888888888888888888') && multi.includes('222222222222222222'), multi.join(','));
  st.clear(G, 'imageChannelIds');
}

// 5b) 날짜/시각이 현지 기준인가 (UTC면 한국 오전 0~9시에 어제 폴더로 감)
{
  const d = new Date(2026, 7, 31, 3, 4, 5); // 로컬 2026-08-31 03:04:05
  ok("localDate 현지기준", store.localDate(d) === "2026-08-31", store.localDate(d));
  ok("localStamp 현지기준", store.localStamp(d) === "20260831-030405", store.localStamp(d));
}

// 6) TTS 정제
const { cleanText } = await import('./src/tts/index.js');
const g = { members: { cache: new Map() }, roles: { cache: new Map() }, channels: { cache: new Map() } };
const got = cleanText({ content: '<@1> 야 https://youtu.be/a 봐 <:kek:9> **굵게** ㅋㅋㅋㅋㅋ', guild: g }, 200);
// 소유자 요청: 링크는 "링크" 가 아니라 **"링크를 보냈어요"** 로 읽습니다.
ok('TTS 정제', got === '누군가 야 링크를 보냈어요 봐 굵게 크크크크크', JSON.stringify(got));
ok('링크는 "링크를 보냈어요" 로', cleanText({ content: 'https://x.com/a', guild: g }, 200) === '링크를 보냈어요');

// 6-1) 축약어 등록·관리 — 서버마다 쓰는 말이 달라서 코드를 고쳐 배포할 수 없습니다.
{
  const st = await import('./src/settings.js');
  const tts = await import('./src/tts/index.js');
  const G = 'abbrevguild';
  const say = (s) => cleanText({ content: s, guild: g, guildId: G }, 200);

  ok('등록 전에는 그대로 (낱자는 소리내어)', say('ㄱㅊ') === '그츠', say('ㄱㅊ'));
  ok('기본 축약어는 등록 없이도 됨', say('ㄱㅅ') === '감사', say('ㄱㅅ'));

  ok('등록하면 그렇게 읽음', st.setTtsAbbrev(G, 'ㄱㅊ', '괜찮아').ok && say('ㄱㅊ') === '괜찮아', say('ㄱㅊ'));
  ok('글 중간에 있어도 바뀜', say('나는 ㄱㅊ 아니야') === '나는 괜찮아 아니야', say('나는 ㄱㅊ 아니야'));
  // ⚠️ **낱말 전체가 같을 때만** 바꿔야 합니다. 안 그러면 멀쩡한 글자를 망가뜨립니다.
  ok('낱말 일부는 안 바꿈', say('ㄱㅊㅊ') !== '괜찮아', say('ㄱㅊㅊ'));
  // 낱자가 아닌 것도 등록할 수 있어야 합니다 (서버마다 쓰는 말이 다릅니다).
  ok('낱자가 아니어도 등록됨', st.setTtsAbbrev(G, '갓생', '갓 생').ok && say('갓생') === '갓 생');
  // 기본 표를 덮어쓸 수 있어야 합니다 — 기본값이 마음에 안 들 수 있습니다.
  ok('기본 축약어를 덮어씀', st.setTtsAbbrev(G, 'ㄱㅅ', '고맙습니다').ok && say('ㄱㅅ') === '고맙습니다');
  ok('다른 서버에는 영향 없음', cleanText({ content: 'ㄱㅅ', guild: g, guildId: 'other' }, 200) === '감사');

  ok('지우면 되돌아감', st.clearTtsAbbrev(G, 'ㄱㅅ') && say('ㄱㅅ') === '감사');
  ok('없는 것을 지우면 false', st.clearTtsAbbrev(G, '없는말') === false);

  // 잘못된 입력은 이유를 말해줘야 합니다.
  ok('공백이 든 단어는 거부', !st.setTtsAbbrev(G, '두 낱말', 'x').ok);
  ok('빈 값은 거부', !st.setTtsAbbrev(G, '', 'x').ok && !st.setTtsAbbrev(G, 'x', '').ok);
  ok('너무 긴 단어는 거부', !st.setTtsAbbrev(G, 'ㄱ'.repeat(30), 'x').ok);

  // 개수 상한 — 무한정 쌓이면 읽기 처리가 느려집니다.
  const F = 'fullguild';
  for (let i = 0; i < st.ABBREV_MAX; i++) st.setTtsAbbrev(F, `말${i}`, '읽기');
  const over = st.setTtsAbbrev(F, '하나더', '읽기');
  ok('상한을 넘으면 거부', !over.ok && over.reason.includes(String(st.ABBREV_MAX)), over.reason);
  ok('이미 있는 것은 상한과 무관하게 고칠 수 있음', st.setTtsAbbrev(F, '말0', '다르게').ok);

  // 목록 화면. 명령어를 또 만들지 않고 인자 없이 실행했을 때 보여줍니다 (3.6-6).
  const empty = tts.buildAbbrevPanel('nobody');
  ok('비었으면 등록 방법을 알려줌', JSON.stringify(empty.embeds[0].toJSON()).includes('/축약어 단어'));
  // 비었으면 지울 것이 없으니 드롭다운은 없고, 📢 버튼만 있습니다.
  ok('비었으면 지우기 드롭다운 없음',
    !JSON.stringify(empty.components ?? []).includes('tts:abbrev:del'));
  const panel = tts.buildAbbrevPanel(G);
  const pj = JSON.stringify([panel.embeds[0].toJSON(), ...panel.components.map((r) => r.toJSON())]);
  ok('목록에 등록한 것이 보임', pj.includes('ㄱㅊ') && pj.includes('괜찮아'));
  ok('지우기 드롭다운이 있음', pj.includes('tts:abbrev:del'));
  ok('목록은 나만 보이게', panel.flags === (await import('discord.js')).MessageFlags.Ephemeral);
}

// 6-2) 📢 모두에게 보이기 — 명령어도 인자도 늘리지 않고 공지하는 길
//
// 소유자 요청: "/도움말 같은 걸 한번씩 전체공지하고 싶다. 명령어는 추가하기 싫다."
{
  const share = await import('./src/share.js');
  const { commandMap } = await import('./src/commands.js');
  const dj = await import('discord.js');

  const plain = { embeds: [new dj.EmbedBuilder().setTitle('T')], flags: dj.MessageFlags.Ephemeral };
  const withBtn = share.withShareButton(plain);
  ok('버튼이 붙음', JSON.stringify(withBtn.components.map((r) => r.toJSON())).includes('share:now'));
  ok('원래 내용은 그대로', withBtn.embeds === plain.embeds && withBtn.flags === plain.flags);
  ok('원래 객체를 고치지 않음', plain.components === undefined);

  // 이미 줄이 있으면 뒤에 붙어야 합니다 (기존 조작을 밀어내면 안 됩니다).
  const row = () => new dj.ActionRowBuilder().addComponents(
    new dj.ButtonBuilder().setCustomId('x').setLabel('x').setStyle(dj.ButtonStyle.Secondary)
  );
  const two = share.withShareButton({ components: [row()] });
  ok('기존 줄 뒤에 붙음', two.components.length === 2 && JSON.stringify(two.components[1].toJSON()).includes('share:now'));
  // ⚠️ 한 메시지에 5줄까지입니다. 꽉 찬 화면을 깨뜨리면 안 됩니다.
  const full = share.withShareButton({ components: [row(), row(), row(), row(), row()] });
  ok('5줄이면 버튼을 포기함', full.components.length === 5 && !JSON.stringify(full.components.map((r) => r.toJSON())).includes('share:now'));

  ok('이 버튼인지 알아봄', share.isShareComponent('share:now') && !share.isShareComponent('m:next'));

  const src = fs.readFileSync('./src/share.js', 'utf8');
  // 남이 눌러도 동작하지 않는 버튼을 채팅방에 올리면 안 됩니다.
  ok('올릴 때 버튼·드롭다운은 빼고 올림', src.includes('content: content || undefined') && !/send\({[\s\S]{0,200}components:/.test(src));
  // 공지라도 자고 있는 사람을 깨울 이유는 없습니다.
  ok('알림을 쏘지 않음', src.includes('SuppressNotifications') && src.includes("parse: []"));
  // 두 번 올리면 채팅방이 지저분해집니다.
  ok('올린 뒤 버튼을 없앰', src.includes('두 번 올리는 것을 막습니다'));
  ok('권한이 없으면 이유를 알려줌', src.includes('글을 쓸 권한이 없습니다'));

  const ix = fs.readFileSync('./src/index.js', 'utf8');
  // /도움말 처럼 어느 기능에도 속하지 않아 **항상** 동작해야 합니다.
  ok('기능이 꺼져도 동작', ix.includes('const isShare = isShareComponent('));
  ok('/도움말 에 버튼이 붙음',
    fs.readFileSync('./src/commands.js', 'utf8').includes('withShareButton({ embeds: [embed]'));
  ok('명령어 개수는 그대로 (인자도 안 늘림)', commandMap.has('도움말') && !commandMap.has('공지'));
}

// 6a) 이모지는 읽지 않는다
{
  const say = (s) => cleanText({ content: s, guild: g }, 200);
  ok('이모지만 보내면 안내 문구', say('😀') === '이모지를 보냈어요.', say('😀'));
  ok('이모지 여러 개도 한 번만', say('😀😀😀') === '이모지를 보냈어요.');
  ok('복합 이모지(가족·국기·키캡)', say('👨‍👩‍👧‍👦 🇰🇷 1️⃣') === '이모지를 보냈어요.');
  ok('커스텀 이모지만 보내도 안내 문구', say('<:kekw:123>') === '이모지를 보냈어요.');
  ok('움직이는 커스텀 이모지도', say('<a:dance:987>') === '이모지를 보냈어요.');
  ok('글에 섞이면 이모지만 빼고 읽음', say('안녕 😀') === '안녕', say('안녕 😀'));
  ok('커스텀 이모지도 빼고 읽음', say('안녕하세요 <:kekw:123> 반가워요') === '안녕하세요 반가워요');
  ok('이모지 이름을 읽지 않음', !say('<:kekw:123> 안녕').includes('kekw'));
  // ★ Edge TTS 는 낱자만 이어진 글에 소리를 아예 안 냅니다 (실측: ㅋㅋ 부터 0바이트).
  //   그래서 개수를 줄인 뒤 **발음 나는 글자로 바꿔야** 읽힙니다.
  //
  //   반복 상한은 TTS_MAX_REPEAT (기본 6). 소유자가 3 → 6 으로 늘렸습니다 —
  //   웃음의 길이도 표현이라 3개로 자르면 심심합니다.
  const { config: cfg } = await import('./src/config.js');
  ok('반복 상한은 설정값 (기본 6)', cfg.tts.maxRepeat === 6, `${cfg.tts.maxRepeat}`);
  ok('상한보다 짧으면 그대로', say('ㅋㅋㅋ') === '크크크', say('ㅋㅋㅋ'));
  ok('상한까지는 다 읽음', say('ㅋ'.repeat(6)) === '크'.repeat(6), say('ㅋ'.repeat(6)));
  ok('상한을 넘으면 잘림', say('ㅋ'.repeat(20)) === '크'.repeat(6), say('ㅋ'.repeat(20)));
  ok('ㅎ · ㅠ · ㅜ 도 마찬가지', say('ㅎㅎ') === '흐흐' && say('ㅠㅠ') === '흑흑' && say('ㅜㅜㅜㅜ') === '흑흑흑흑',
    `${say('ㅎㅎ')} / ${say('ㅠㅠ')} / ${say('ㅜㅜㅜㅜ')}`);
  ok('글에 섞인 낱자도 바뀜', say('안녕 ㅋㅋ') === '안녕 크크', say('안녕 ㅋㅋ'));
  ok('낱자를 지워버리지는 않음', say('ㅋㅋㅋㅋㅋ') !== '');

  // 축약어는 뜻을 살려서 읽습니다. 소리대로 읽으면 ㄷㄷ 이 "드드" 가 됩니다.
  for (const [input, want] of [['ㅇㅇ', '응응'], ['ㄴㄴ', '노노'], ['ㄱㅅ', '감사'],
                               ['ㅇㅋ', '오케이'], ['ㄷㄷ', '덜덜'], ['ㅎㅇ', '하이']]) {
    ok(`축약어 ${input} → ${want}`, say(input) === want, say(input));
  }
  ok('축약어는 낱말 전체가 낱자일 때만', say('ㅇㅇ 알겠어') === '응응 알겠어', say('ㅇㅇ 알겠어'));

  // ★ 가장 중요한 불변조건: 어떤 낱자가 와도 무음이 되면 안 됩니다.
  //   무음이면 그 메시지가 통째로 안 읽히고, 예전에는 15초씩 멈추기까지 했습니다.
  const JAMO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎㅏㅐㅑㅓㅔㅕㅗㅛㅜㅠㅡㅣ'.split('');
  const leftover = [];
  for (const a of JAMO) {
    for (const b of JAMO) {
      const out = say(a + b);
      if (/[ㄱ-ㅎㅏ-ㅣ]/.test(out) || out === '') leftover.push(a + b + '→' + out);
    }
  }
  ok('두 낱자 조합 전부가 읽을 수 있는 글자로', leftover.length === 0,
    leftover.slice(0, 5).join(' ') || `${JAMO.length ** 2}가지 확인`);
  ok('반복도 마찬가지', !/[ㄱ-ㅎㅏ-ㅣ]/.test(say('ㅅㅂㅅㅂ') + say('ㅋㅋㅋㅋㅋㅋ') + say('ㅑㅑㅑ')));
  ok('평범한 문장은 그대로', say('오늘 날씨 좋다') === '오늘 날씨 좋다');
  ok('빈 메시지는 여전히 빈 값 (안 읽음)', say('   ') === '');
}

// 6b) /목소리 선택지가 Edge TTS 에 실제로 존재하는 목소리인가
// (이 검사가 없어서 실재하지 않는 목소리 6개가 들어간 적이 있습니다)
{
  const { listVoices } = await import('./src/tts/synth.js');
  const { VOICES } = await import('./src/tts/voices.js');
  const real = new Set((await listVoices('')).map((v) => v.shortName));
  let missing = VOICES.filter((v) => !real.has(v.value));
  ok(`목소리 ${VOICES.length}종 전부 실재`, missing.length === 0, missing.map((v) => v.value).join(','));
  ok('목소리가 3종보다 많음 (다국어 확장)', VOICES.length > 3, String(VOICES.length));

  const { config } = await import('./src/config.js');
  ok('기본 목소리 실재', real.has(config.tts.voice), config.tts.voice);
  ok('기본 목소리가 다국어', config.tts.voice.includes('Multilingual'), config.tts.voice);

  // 사람별 목소리. 서버 기본 목소리 명령어(/목소리)는 없앴고,
  // 이제 **개인 설정 > .env 기본값** 두 단계뿐입니다.
  const st = await import('./src/settings.js');
  const G = 'voiceguild', U = 'user1', U2 = 'user2';
  ok('기본은 .env 값', st.voiceFor(G, U) === config.tts.voice);
  st.setUserVoice(G, U, 'en-US-AvaMultilingualNeural');
  ok('내 목소리가 기본값을 덮음', st.voiceFor(G, U) === 'en-US-AvaMultilingualNeural');
  ok('다른 사람은 기본값 그대로', st.voiceFor(G, U2) === config.tts.voice);
  ok('내 목소리 해제하면 기본값으로', st.clearUserVoice(G, U) && st.voiceFor(G, U) === config.tts.voice);

  // ★ 읽는 속도도 **사람마다** 저장합니다 (소유자 요청). 목소리와 같은 자리·같은 방식.
  ok('속도 기본은 .env 값', st.speedFor(G, U) === config.tts.speed, `${st.speedFor(G, U)}`);
  ok('내 속도가 기본값을 덮음', st.setUserSpeed(G, U, 130) === 130 && st.speedFor(G, U) === 130);
  ok('다른 사람은 그대로', st.speedFor(G, U2) === config.tts.speed);
  ok('상한·하한을 지킴',
    st.setUserSpeed(G, U, 500) === st.SPEED_MAX && st.setUserSpeed(G, U, 1) === st.SPEED_MIN);
  // 기본값이면 저장하지 않습니다 — 설정 파일에 쓸모없는 값이 쌓이지 않게.
  ok('기본값으로 되돌리면 저장 안 함', st.setUserSpeed(G, U, config.tts.speed) && st.userSpeed(G, U) === null);
  st.setUserSpeed(G, U, 150);
  ok('해제하면 기본값으로', st.clearUserSpeed(G, U) && st.speedFor(G, U) === config.tts.speed);

  // 속도가 실제로 SSML 까지 가는가. (네트워크 없이 템플릿만 확인)
  {
    const { MsEdgeTTS } = await import('msedge-tts');
    const t = new MsEdgeTTS();
    t._metadataOptions = { voiceLocale: 'ko-KR' };
    t._voice = 'ko-KR-HyunsuMultilingualNeural';
    const rateOf = (opts) => t._SSMLTemplate('안녕', opts).match(/rate="([^"]*)"/)[1];
    ok('속도를 안 주면 기본(1)', rateOf(undefined) === '1');
    ok('속도가 SSML 에 들어감', rateOf({ rate: 1.3 }) === '1.3' && rateOf({ rate: 0.5 }) === '0.5');
    // 퍼센트를 배수로 바꿔 넘겨야 합니다 (130% → 1.3). 그대로 넘기면 130배가 됩니다.
    const synth = fs.readFileSync('./src/tts/synth.js', 'utf8');
    ok('퍼센트를 배수로 바꿔 넘김', synth.includes('return { rate: p / 100 };'));
    ok('100%면 아무것도 넘기지 않음', synth.includes('p === 100) return undefined'));
    // ⚠️ 속도는 호출할 때마다 넘겨야 합니다. 연결에 묶으면 사람이 바뀔 때마다
    //    연결을 다시 맺어 예열(1.7초)이 매번 날아갑니다.
    ok('속도는 연결이 아니라 호출에 붙음',
      synth.includes('engine.toStream(text, opts)') && !synth.includes('engineSpeed'));
    const ttsSrc = fs.readFileSync('./src/tts/index.js', 'utf8');
    ok('읽을 때 그 사람 속도를 씀', ttsSrc.includes('synthesize(spoken, voice, speed)'));
    // 명령어를 새로 만들지 않고 /목소리 에 칸을 더했습니다 (3.6-6).
    ok('/목소리 에 속도 칸이 있음', /addIntegerOption[\s\S]{0,60}setName\('속도'\)/.test(ttsSrc));
    ok('명령어를 새로 만들지 않음', !ttsSrc.includes("setName('속도조절')"));
  }
  ok('서버 기본 목소리 설정은 제거됨', st.setGuildVoice === undefined && st.guildVoice === undefined);
}

// 6c) GUILD_ID 를 쉼표 목록으로 읽는가 (여러 서버 지원)
{
  const { config } = await import('./src/config.js');
  ok('GUILD_ID 목록 파싱 (2개)', config.guildIds.length === 2, config.guildIds.join(' | '));
  ok('공백 섞인 항목도 정리됨', config.guildIds[1] === '987654321098765432', config.guildIds[1]);
}

// 6d) /채널설정 이 음성채널 안의 채팅을 "채팅방"으로 받아들이는가
// (음성채널은 discord.js 에서 isTextBased() 와 isVoiceBased() 를 둘 다 만족합니다.
//  예전에 채널 타입 목록으로 검사해서 이걸 거부하는 버그가 있었습니다)
{
  const cmd = allCommands.find((c) => c.data.toJSON().name === '채널설정');
  const src = fs.readFileSync('./src/channel-commands.js', 'utf8');
  ok('타입 목록 하드코딩 대신 isTextBased 사용', src.includes('isTextBased?.()'));
  ok('타입 목록 하드코딩 대신 isVoiceBased 사용', src.includes('isVoiceBased?.()'));
  const types = cmd.data.toJSON().options[1]['channel_types'];
  ok('채널 선택지에 음성채널 포함', Array.isArray(types) && types.includes(2), JSON.stringify(types));
  ok('채널 선택지에 포럼·미디어 채널 포함', types.includes(15) && types.includes(16), JSON.stringify(types));
}

// 6e) TTS 가 음성채널 자체 채팅에서 그 채널로 읽어주는가
{
  const src = fs.readFileSync('./src/tts/index.js', 'utf8');
  ok('TTS: 글이 올라온 음성채널을 그대로 사용', src.includes('sourceChannel?.isVoiceBased?.()'));
  ok('TTS: 호출부가 message.channel 을 넘김', src.includes('message.member, message.channel)'));
}

// 6f) yt-dlp 오류 분류 — 오진 회귀 검사
// (예전에 stderr.includes('bot') 로 판별해서, 프로젝트 경로에 'bot' 이 들어간
//  아무 오류나 "유튜브 차단" 으로 오진하는 버그가 있었습니다)
{
  const { friendlyError, isTransient } = await import('./src/music/ytdlp.js');

  const cookiePathErr = 'ERROR: unable to open /home/ubuntu/sarangbang-bot/cookies.txt';
  const got = friendlyError(cookiePathErr);
  ok('경로에 bot 이 있어도 "차단"으로 오진하지 않음', !got.includes('봇으로 판단'), got);

  ok('실제 차단 메시지는 잡아냄',
    friendlyError('ERROR: Sign in to confirm you are not a bot').includes('봇으로 판단'));

  // 쿠키가 이미 있는데 차단되면 "설정하세요" 가 아니라 "만료됐다" 로 안내해야 합니다.
  {
    const saved = process.env.YTDLP_COOKIES_FILE;
    process.env.YTDLP_COOKIES_FILE = '/tmp/cookies.txt';
    ok('쿠키가 있으면 만료 안내',
      friendlyError('ERROR: Sign in to confirm you are not a bot').includes('만료'));
    delete process.env.YTDLP_COOKIES_FILE;
    ok('쿠키가 없으면 설정 안내',
      friendlyError('ERROR: Sign in to confirm you are not a bot').includes('설정이 필요'));
    if (saved !== undefined) process.env.YTDLP_COOKIES_FILE = saved;
  }

  ok('n challenge 실패는 JS런타임 안내로',
    friendlyError('WARNING: n challenge solving failed: Ensure you have a supported JavaScript runtime').includes('자바스크립트 런타임'));
  // n challenge 실패 뒤에는 항상 "The page needs to be reloaded" 가 따라붙습니다.
  // 마지막 줄만 보고 "일시적 오류" 로 안내하면 원인을 영영 못 찾습니다.
  ok(
    'n challenge 안내가 차단 안내보다 우선',
    !friendlyError(
      ['WARNING: n challenge solving failed', 'ERROR: The page needs to be reloaded.'].join('\n')
    ).includes('일시적으로')
  );
  ok('일시적 오류를 한국어로 안내',
    friendlyError('ERROR: [youtube] abc: The page needs to be reloaded.').includes('일시적으로'));

  ok('일시적 오류로 분류됨 (재시도 대상)',
    isTransient('ERROR: [youtube] abc: The page needs to be reloaded.'));

  // ★ 같은 말이라도 JS 런타임을 꺼뒀으면 **원인이 그것**입니다.
  //   2026-09-02 에 속도를 줄여보려고 껐다가 재생이 아예 안 됐습니다.
  //   "일시적" 으로 보고 재시도하면 곡마다 40~60초를 버리고도 결국 실패합니다.
  {
    const saved = process.env.YTDLP_JS_RUNTIME;
    process.env.YTDLP_JS_RUNTIME = 'false';
    const msg = friendlyError('ERROR: [youtube] abc: The page needs to be reloaded.');
    ok('런타임을 꺼뒀으면 그게 원인이라고 알림', msg.includes('YTDLP_JS_RUNTIME=false') && msg.includes('원인'));
    ok('런타임을 꺼뒀으면 재시도하지 않음',
      !isTransient('ERROR: [youtube] abc: The page needs to be reloaded.'));
    if (saved === undefined) delete process.env.YTDLP_JS_RUNTIME;
    else process.env.YTDLP_JS_RUNTIME = saved;
    ok('되돌리면 다시 일시적 오류', isTransient('ERROR: [youtube] abc: The page needs to be reloaded.'));
  }
  // ⚠️ 느릴 때 이 설정을 권하면 안 됩니다. 재생 자체가 안 됩니다.
  ok('느릴 때 런타임 끄기를 권하지 않음',
    !/시간을 초과했습니다[\s\S]{0,300}?YTDLP_JS_RUNTIME=false` 를 넣고/.test(
      fs.readFileSync('./src/music/ytdlp.js', 'utf8')
    ));
  ok('삭제된 영상은 재시도 대상 아님',
    !isTransient('ERROR: [youtube] abc: Video unavailable'));
  // ⚠️ 유튜브는 **서로 다른 이유**를 전부 "Video unavailable" 로 뭉뚱그립니다.
  //    예전에는 전부 "비공개이거나 삭제됨" 이라고 답해서, 지역 차단이나 멤버십 전용
  //    영상을 만난 사람이 지운 적도 없는 영상을 지웠다는 말을 들었습니다.
  ok('비공개 영상',
    friendlyError('ERROR: [youtube] abc: Private video. Sign in if you have been granted access')
      .includes('비공개 영상'));
  ok('지역 차단은 프록시 안내로',
    friendlyError('ERROR: [youtube] abc: Video unavailable. The uploader has not made this video available in your country')
      .includes('YTDLP_PROXY'));
  ok('멤버십 전용은 그렇게 안내',
    friendlyError("ERROR: [youtube] abc: Video unavailable. This video is available to this channel's members")
      .includes('멤버십'));
  ok('삭제된 영상',
    friendlyError('ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader')
      .includes('지웠거나'));
  {
    // 이유를 모르면 **추측하지 말고** 유튜브가 한 말을 그대로 보여줍니다.
    const unknown = friendlyError('ERROR: [youtube] abc: Video unavailable');
    ok('이유를 모르면 원문을 보여줌', unknown.includes('Video unavailable'));
    ok('모르면서 삭제됐다고 하지 않음', !unknown.includes('삭제') && !unknown.includes('비공개'));
    ok('원문에서 ERROR 앞머리를 떼어냄', !unknown.includes('ERROR:') && !unknown.includes('[youtube]'));
  }

  // ⚠️ `Sign in to confirm …` 은 두 가지입니다. 나이 쪽이 먼저 걸러져야 합니다.
  //    안 그러면 연령 제한 영상 하나 때문에 멀쩡한 쿠키를 다시 뽑게 됩니다.
  {
    const age = friendlyError("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users");
    ok('연령 제한은 그 영상만의 문제로', age.includes('연령 제한'));
    ok('연령 제한을 IP 차단으로 오진하지 않음', !age.includes('봇으로 판단'));
    ok('진짜 IP 차단은 그대로 잡힘',
      friendlyError("ERROR: [youtube] abc: Sign in to confirm you're not a bot").includes('봇으로 판단'));
    // ⚠️ `age` 만으로 판별하면 `webpage` 에 걸려 엉뚱한 오류가 연령 제한이 됩니다.
    //    (`bot` 이 sarangbang-bot 에 걸리던 것과 같은 함정)
    ok('webpage 를 연령 제한으로 오진하지 않음',
      !friendlyError('ERROR: Unable to download webpage: restricted').includes('연령 제한'));
    ok('age-restricted 는 잡힘',
      friendlyError('ERROR: [youtube] abc: This video is age-restricted').includes('연령 제한'));
  }
}

// 6f-1) 로그에 스택이 아니라 **원인 한 줄**이 보이는가
//
// 소유자는 서버에서 journalctl 을 눈으로 훑습니다. 오류마다 스택이 20줄씩 붙으면
// 정작 읽어야 할 한국어 한 줄이 묻힙니다. (실제로 `/재생` 실패 때 겪음)
{
  const { userError, isExpected } = await import('./src/user-error.js');
  const e = userError('연령 제한이 걸린 영상입니다.');
  ok('예상된 오류로 표시됨', isExpected(e) && e.message.includes('연령 제한'));
  ok('보통 오류는 그대로 (스택을 남겨야 함)', !isExpected(new Error('버그')));

  const idx = fs.readFileSync('./src/index.js', 'utf8');
  ok('로그를 한 곳으로 모음', idx.includes('function logError(tag, err)'));
  ok('예상된 오류는 메시지만', idx.includes('isExpected(err) ? err.message : err'));
  // 한 군데라도 빠지면 거기서만 스택이 쏟아집니다.
  ok('일부러 잡은 오류는 전부 logError 를 거침',
    !/console\.error\((?:'\[(?:입력 창|버튼|메시지 처리)\]'|`\[명령어)/.test(idx));
  // ⚠️ 반대로 **처리되지 않은 오류만은 스택을 남겨야** 합니다.
  //    그 자체가 catch 가 빠진 버그라, 메시지만 찍으면 어디가 빠졌는지 못 찾습니다.
  ok('처리되지 않은 오류는 스택을 남김',
    idx.includes("console.error('[처리되지 않은 오류]', err)") &&
    !idx.includes("logError('[처리되지 않은 오류]'"));

  const paths = ['./src/music/commands.js', './src/music/ytdlp.js', './src/audio/guild-audio.js'];
  ok('사용자에게 보여줄 오류는 userError 로',
    paths.every((p) => !fs.readFileSync(p, 'utf8').includes('throw new Error(')));
  // ⚠️ 반대로 **코드가 잘못돼서 나는 오류는 스택이 있어야** 고칩니다.
  //    경로 안전장치·알 수 없는 설정 키를 userError 로 바꾸지 마세요.
  ok('안전장치 오류는 스택을 남김',
    fs.readFileSync('./src/images/store.js', 'utf8').includes("throw new Error('잘못된 폴더 이름입니다.')"));
}

// 6f-2) /망고야 — 한도와 답 자르기
//
// ⚠️ 이 기능의 절반은 **한도**입니다. 친구들이 같이 쓰는데 요금(무료 등급의 하루 한도)은
//    소유자 몫이라, 한 사람이 다 써버리면 나머지가 종일 못 씁니다.
{
  const { splitForDiscord, formatAnswer } = await import('./src/ai/index.js');
  const usage = await import('./src/ai/usage.js');
  const { config } = await import('./src/config.js');

  // 자르기: 글자 수로만 자르면 단어가 잘립니다. 문단·줄 경계를 찾아야 합니다.
  const long = Array.from({ length: 200 }, (_, i) => `${i}번째 문단입니다.`).join('\n\n');
  const parts = splitForDiscord(long, 500);
  ok('긴 답을 여러 조각으로', parts.length > 1);
  ok('모든 조각이 상한 이하', parts.every((p) => p.length <= 500), `최대 ${Math.max(...parts.map((p) => p.length))}자`);
  ok('조각을 이으면 내용이 보존됨', parts.join('\n\n').replace(/\s/g, '') === long.replace(/\s/g, ''));
  ok('짧은 답은 한 조각', splitForDiscord('안녕하세요', 2000).length === 1);
  ok('빈 답은 조각 없음', splitForDiscord('', 2000).length === 0);
  // 조용히 자르면 답이 이상하게 끝난 것처럼 보입니다. (재생목록 자르기와 같은 원칙)
  const many = formatAnswer('가'.repeat(9000));
  ok('조각 수에 상한이 있음', many.chunks.length <= 3, `${many.chunks.length}조각`);
  ok('잘렸으면 잘렸다고 적음', many.truncated && many.chunks.at(-1).includes('여기까지만'));

  // ★ 디스코드는 슬래시 명령어의 **입력값을 다른 사람에게 보여주지 않습니다.**
  //   "○○님이 망고야를 사용함" 만 뜨므로, 답만 남으면 뭘 물어본 건지 아무도 모릅니다.
  {
    const { quoteQuestion } = await import('./src/ai/index.js');
    const q = '오사카 뭐 먹지';
    const withQ = formatAnswer('스시 먹어', q);
    ok('질문이 답과 함께 나옴', withQ.chunks[0].includes(q));
    ok('질문은 인용문으로', withQ.chunks[0].startsWith('> '));
    ok('답도 그대로 있음', withQ.chunks[0].includes('스시 먹어'));
    // ⚠️ `>>>` 를 쓰면 뒤의 답까지 인용이 됩니다. 줄마다 `>` 를 붙여야 합니다.
    ok('여러 줄 질문도 줄마다 인용', quoteQuestion('가\n나') === '> 가\n> 나');
    ok('여러 줄 인용 기호는 안 씀', !withQ.chunks[0].includes('>>>'));
    // 머리글 때문에 첫 조각이 디스코드 한도를 넘으면 그 메시지가 아예 안 갑니다.
    const longQ = '질'.repeat(1000);
    const tight = formatAnswer('답'.repeat(5000), longQ);
    ok('질문이 길어도 첫 조각이 한도 이하',
      tight.chunks.every((c) => c.length <= 2000), `최대 ${Math.max(...tight.chunks.map((c) => c.length))}자`);
  }

  // ★ 재시도 — **무엇을 다시 하고 무엇을 안 하는지**가 핵심입니다.
  //   제미나이를 실제로 부를 수 없으니(무료 한도) fetch 를 갈아끼워 확인합니다.
  //   덕분에 요청 모양·재시도·오류 안내를 전부 실제로 돌려봅니다.
  {
    const gem = await import('./src/ai/gemini.js');
    const realFetch = globalThis.fetch;
    const savedDelay = config.ai.retryDelayMs;
    const savedKey = config.ai.geminiKey;
    config.ai.retryDelayMs = 1; // 검사에서 몇 초씩 쉬면 안 됩니다
    // ⚠️ **키가 있든 없든 같은 결과가 나와야 합니다.** 소유자 서버에는 키가 있고
    //    제 PC 에는 없어서, 환경에 따라 결과가 달라지는 검사를 한 번 이미 냈습니다.
    config.ai.geminiKey = 'verify-fake-key';

    let plans = [];
    const sent = [];
    globalThis.fetch = async (_url, opts) => {
      const plan = plans.shift() ?? { status: 200, body: answerBody('마지막') };
      sent.push(JSON.parse(opts.body));
      if (plan.abort) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return { ok: plan.status < 400, status: plan.status, json: async () => plan.body };
    };
    const answerBody = (text) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    const errBody = (message) => ({ error: { message } });
    const run = async (list) => {
      plans = list;
      sent.length = 0;
      return gem.ask('테스트').then((r) => ({ text: r.text, tokens: r.tokens }), (e) => ({ error: e.message }));
    };

    try {
      let r = await run([
        { status: 503, body: errBody('overloaded') },
        { status: 500, body: errBody('internal') },
        { status: 200, body: answerBody('드디어 됐다') },
      ]);
      ok('5xx 는 다시 해서 성공', r.text === '드디어 됐다', r.text ?? r.error);
      ok('세 번까지 시도', sent.length === 3, `${sent.length}번`);

      r = await run(Array.from({ length: 5 }, () => ({ status: 503, body: errBody('x') })));
      ok('계속 실패하면 3번에서 멈춤', sent.length === 3, `${sent.length}번`);
      ok('혼잡 안내로 끝남', (r.error ?? '').includes('혼잡'), r.error);

      // ⚠️ 429 를 곧바로 다시 던지면 상황이 나빠지고, 하루 한도면 몇 번을 해도 같습니다.
      r = await run([{ status: 429, body: errBody('quota') }, { status: 200, body: answerBody('안 와야 함') }]);
      ok('429 는 다시 하지 않음', sent.length === 1, `${sent.length}번`);
      ok('무료 등급 한도라고 알려줌', (r.error ?? '').includes('무료 등급'));

      r = await run([{ status: 404, body: errBody('nope') }, { status: 200, body: answerBody('안 와야 함') }]);
      ok('404 는 다시 하지 않음', sent.length === 1, `${sent.length}번`);

      // ⚠️ 시간 초과는 이미 30초를 기다린 뒤입니다. 또 기다리게 하면 90초가 됩니다.
      r = await run([{ abort: true }, { status: 200, body: answerBody('안 와야 함') }]);
      ok('시간 초과는 다시 하지 않음', sent.length === 1, `${sent.length}번`);
      ok('시간 초과라고 알려줌', (r.error ?? '').includes('안 답하지 않았습니다') || (r.error ?? '').includes('초 안에'));

      // "생각" 설정 이름이 모델마다 다릅니다. 빼고 다시 하되 **횟수는 안 씁니다.**
      r = await run([
        { status: 400, body: errBody('Unknown name "thinkingLevel"') },
        { status: 503, body: errBody('overloaded') },
        { status: 503, body: errBody('overloaded') },
        { status: 200, body: answerBody('생각 빼고 성공') },
      ]);
      ok('생각 설정이 거부되면 빼고 다시', r.text === '생각 빼고 성공', r.text ?? r.error);
      ok('그 시도는 재시도 횟수로 안 셈', sent.length === 4, `${sent.length}번`);
      ok('그다음부터는 생각 설정을 안 보냄',
        sent[0].generationConfig.thinkingConfig !== undefined &&
        sent[1].generationConfig.thinkingConfig === undefined);

      // 3.x 에서 폐기된 항목을 보내면 400 이 날 수 있습니다.
      await run([{ status: 200, body: answerBody('확인') }]);
      const g = sent[0].generationConfig;
      ok('temperature·topP·topK 를 안 보냄',
        g.temperature === undefined && g.topP === undefined && g.topK === undefined);
      ok('마지막 turn 이 model 이 아님', sent[0].contents.at(-1).role === 'user');

      // 답이 비는 것은 혼잡이 아니라 이유가 있는 것입니다.
      r = await run([
        { status: 200, body: { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] } },
        { status: 200, body: answerBody('안 와야 함') },
      ]);
      ok('빈 답은 다시 하지 않음', sent.length === 1, `${sent.length}번`);
      ok('길이 초과라고 알려줌', (r.error ?? '').includes('AI_MAX_OUTPUT_TOKENS'), r.error);
    } finally {
      globalThis.fetch = realFetch;
      config.ai.retryDelayMs = savedDelay;
      config.ai.geminiKey = savedKey;
    }
  }

  // 말투는 소유자가 정했습니다 — 반말 · 구어체 · 이름은 망고.
  {
    const gemSrc = fs.readFileSync('./src/ai/gemini.js', 'utf8');
    const sys = gemSrc.slice(gemSrc.indexOf('const SYSTEM = ['), gemSrc.indexOf("].join('\\n');"));
    ok('이름은 망고', sys.includes('망고'));
    // ★ 실제로 겪은 것: 상대를 "망고야!" 라고 불렀습니다. 명령어 이름이 `/망고야` 라서
    //   모델이 헷갈린 것입니다. **누가 망고인지**를 못 박아야 합니다.
    ok('상대를 망고라고 부르지 말라고 못 박음', sys.includes('상대를 "망고" 라고 부르지 마'));
    ok('상대는 누나라고 부르게', sys.includes('상대를 부를 때는 "누나"'));
    ok('매번 부르지는 말라고 함', sys.includes('매번 부르지는 마'));
    ok('반말로 답하게', sys.includes('반말'));
    ok('구어체로 답하게', sys.includes('구어체'));
    ok('질문에 맞춰 길이를 조절하게', sys.includes('추천·설명·비교를 물으면 자세히'));
    ok('장소는 위치까지 적게', sys.includes('어디쯤인지'));
    // ★ 가장 중요한 지시. 검색이 없는데 링크를 요구하면 **없는 주소를 지어냅니다.**
    //   그러면 사람이 헛걸음합니다. 소유자가 "링크나 블로그 후기" 를 원했지만
    //   지금 구조로는 줄 수 없고, 지어내는 것보다 못 준다고 말하는 게 낫습니다.
    ok('링크를 지어내지 말라고 지시', sys.includes('링크(URL)를 절대 만들어 쓰지 마'));
    ok('검색을 못 한다는 것을 알려줌', sys.includes('인터넷 검색을 할 수 없다'));
    ok('대신 검색어를 알려주게', sys.includes('검색할 때 쓸 만한 말'));
    ok('확실하지 않으면 그렇게 말하게', sys.includes('확실하진 않은데'));
  }

  // 한도: 시간이 지나면 다시 되어야 하고, 성공했을 때만 세어야 합니다.
  usage.resetUsage();
  const G = 'aiguild';
  const U = 'user1';
  const now = Date.parse('2026-09-02T12:00:00Z');
  ok('처음에는 물어볼 수 있음', usage.check(G, U, now).ok);

  // ★ 소유자 결정: **사람당으로 나누지 않고 서버 통합 한도만** 씁니다. 기본값 0 = 안 씀.
  //   친구 사이에 각자 몫을 정해두는 게 오히려 어색하다는 판단입니다.
  ok('사람당 한도는 기본으로 안 씀', config.ai.perUserHourly === 0, `${config.ai.perUserHourly}`);
  {
    // 쓰고 싶으면 숫자를 넣으면 됩니다. 그 경로도 살아 있는지 확인합니다.
    const savedPerUser = config.ai.perUserHourly;
    config.ai.perUserHourly = 3;
    usage.resetUsage();
    for (let i = 0; i < 3; i++) usage.record(G, U, 0, now);
    const blocked = usage.check(G, U, now);
    ok('숫자를 넣으면 사람당 한도가 걸림', !blocked.ok);
    ok('언제 풀리는지 알려줌', /분/.test(blocked.reason ?? ''), blocked.reason);
    ok('다른 사람은 그대로 됨', usage.check(G, 'user2', now).ok);
    ok('한 시간 뒤에는 다시 됨', usage.check(G, U, now + 61 * 60 * 1000).ok);
    config.ai.perUserHourly = savedPerUser;
  }
  usage.resetUsage();

  // 서버당 하루 한도 (다른 사람들이 나눠 써도 합산되어야 합니다)
  usage.resetUsage();
  for (let i = 0; i < config.ai.perGuildDaily; i++) usage.record(G, `user${i}`, 0, now);
  const guildBlocked = usage.check(G, 'newbie', now);
  ok('서버당 하루 한도도 걸림', !guildBlocked.ok);
  ok('하루 한도는 시간으로 안내', /시간/.test(guildBlocked.reason ?? ''), guildBlocked.reason);
  ok('다른 서버는 영향 없음', usage.check('otherguild', U, now).ok);
  ok('하루 뒤에는 다시 됨', usage.check(G, 'newbie', now + 25 * 60 * 60 * 1000).ok);
  usage.resetUsage();

  // ★ 쓴 토큰 세기. 소유자 질문: "남은 토큰을 볼 수는 없나?"
  //   ⚠️ **남은 양은 제미나이가 알려주지 않습니다.** 우리가 쓴 것만 셀 수 있습니다.
  //      그 구분을 화면에 적어둬야 합니다 — 안 그러면 "남은 양" 으로 오해합니다.
  {
    const { tokensUsed } = await import('./src/ai/gemini.js');
    ok('totalTokenCount 를 씀', tokensUsed({ totalTokenCount: 1234 }) === 1234);
    // 필드가 없으면 있는 것들을 더합니다. "생각" 토큰도 돈입니다.
    ok('없으면 항목을 더함',
      tokensUsed({ promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 }) === 35);
    ok('모양이 바뀌어도 0 으로 떨어짐', tokensUsed(undefined) === 0 && tokensUsed({}) === 0);

    // ★ "느리다" 의 원인이 둘인데 **대책이 정반대**입니다. 로그로 구분해야 합니다.
    //   답 쓰는 게 느리면 → 오는 대로 보여주기
    //   "생각" 이 느리면 → 생각을 줄이기 (스트리밍은 소용없음)
    const { tokenBreakdown } = await import('./src/ai/gemini.js');
    const b = tokenBreakdown({
      promptTokenCount: 300,
      thoughtsTokenCount: 200,
      candidatesTokenCount: 700,
      totalTokenCount: 1200,
    });
    ok('토큰을 항목별로 나눔', b.prompt === 300 && b.thoughts === 200 && b.output === 700);
    ok('생각 토큰을 따로 셈', tokenBreakdown({ thoughtsTokenCount: 42 }).thoughts === 42);
    const gemSrc2 = fs.readFileSync('./src/ai/gemini.js', 'utf8');
    ok('걸린 시간과 항목을 로그에 남김',
      gemSrc2.includes('[ai] 답변 ${sec}초') && gemSrc2.includes('생각 ${used.thoughts}'));

    const T = 'tokguild';
    const t0 = Date.parse('2026-09-02T12:00:00Z');
    usage.record(T, 'u', 1000, t0);
    usage.record(T, 'u', 500, t0);
    ok('오늘 쓴 토큰을 더해서 셈', usage.tokenUsage(T, t0).day === 1500);
    ok('이번 달도 같이 셈', usage.tokenUsage(T, t0).month === 1500);
    // 날짜가 바뀌면 그날 칸은 0부터. 따로 청소할 필요가 없습니다.
    const nextDay = Date.parse('2026-09-03T12:00:00Z');
    ok('날짜가 바뀌면 오늘 칸은 0', usage.tokenUsage(T, nextDay).day === 0);
    usage.record(T, 'u', 200, nextDay);
    ok('달이 같으면 월 누적은 이어짐', usage.tokenUsage(T, nextDay).month === 1700);
    const nextMonth = Date.parse('2026-10-01T12:00:00Z');
    ok('달이 바뀌면 월 칸도 0', usage.tokenUsage(T, nextMonth).month === 0);
    usage.resetUsage();

    // 화면에 "쓴 것" 과 "남은 것" 을 헷갈리지 않게 적었는가
    const ai = fs.readFileSync('./src/ai/index.js', 'utf8');
    ok('화면에 쓴 토큰을 보여줌', ai.includes("name: '쓴 토큰'"));
    ok('남은 양은 모른다고 적어둠', ai.includes('남은 양**은 API 로 알 수 없습니다'));
    ok('어디서 보는지 알려줌', ai.includes('aistudio.google.com/rate-limit'));
    // 사람당 한도를 안 쓸 때 "나 0/0회" 같은 이상한 줄이 나오면 안 됩니다.
    ok('사람당 한도가 0이면 그 줄을 숨김', ai.includes('if (left.userMax > 0) limits.push('));
  }

  // 키가 없을 때 뜻이 통하는 안내가 나와야 합니다.
  //
  // ⚠️ **여기서 ask() 를 부르면 안 됩니다.** 키가 있는 서버에서는 제미나이를 진짜로
  //    호출해서 무료 한도를 깎습니다. 처음에 그렇게 짰다가 소유자 서버에서
  //    `FAIL 키가 없으면 발급 주소를 알려줌` 으로 드러났습니다 —
  //    키가 있으니 그 오류가 안 났던 것입니다. verify 는 **네트워크를 쓰지 않습니다.**
  const gem = await import('./src/ai/gemini.js');
  ok('키가 없으면 발급 주소를 알려줌', gem.missingKeyMessage().includes('aistudio.google.com'));
  ok('어디에 넣어야 하는지까지 알려줌', gem.missingKeyMessage().includes('GEMINI_API_KEY'));
  ok('키 없으면 실제로 그 안내가 나감',
    fs.readFileSync('./src/ai/gemini.js', 'utf8').includes('if (!hasKey()) throw userError(missingKeyMessage());'));
  // 이 검사 자체가 **진짜 네트워크를 쓰지 않도록** 못 박아둡니다.
  // ask() 를 부르긴 하지만 반드시 fetch 를 갈아끼운 상태여야 하고, 끝나면 되돌려야 합니다.
  {
    const v = fs.readFileSync('./verify.mjs', 'utf8');
    ok('제미나이 검사는 fetch 를 갈아끼워서 함',
      v.includes('globalThis.fetch = async') && v.includes('globalThis.fetch = realFetch'));
    ok('갈아끼우기 전에 ask 를 부르지 않음',
      v.indexOf('globalThis.fetch = async') < v.indexOf('gem.ask('));
    ok('키가 있든 없든 같게 (환경에 안 기댐)', v.includes("config.ai.geminiKey = 'verify-fake-key'"));
  }
  // 모르는 오류는 제미나이가 한 말을 그대로 (3.1-4)
  ok('모르는 오류는 원문을 보여줌',
    gem.friendlyError(418, { error: { message: 'teapot detected' } }).includes('teapot detected'));
  ok('한도 초과는 무료 등급 안내로', gem.friendlyError(429, {}).includes('무료 등급'));
  ok('모델 오류는 GEMINI_MODEL 안내로', gem.friendlyError(404, {}).includes('GEMINI_MODEL'));

  const ai = fs.readFileSync('./src/ai/index.js', 'utf8');
  // 제미나이 응답은 몇 초 걸립니다. 3초 안에 답하지 않으면 디스코드가 실패로 봅니다.
  ok('오래 걸리므로 먼저 자리를 잡음', ai.includes('await interaction.deferReply();'));
  // 실패한 질문으로 한도를 깎으면 억울합니다.
  ok('성공했을 때만 횟수를 셈', ai.indexOf('const answer = await ask(') < ai.indexOf('record(interaction.guildId'));
  // 답보다 질문이 더 비쌀 수 있습니다.
  ok('질문 길이도 막음', ai.includes('question.length > config.ai.maxInputChars'));
  ok('한도 안내는 나만 보이게', /gate\.ok[\s\S]{0,200}MessageFlags\.Ephemeral/.test(ai));
  ok('키를 로그에 안 찍음', !/console\.(log|warn|error)[^\n]*geminiKey/.test(fs.readFileSync('./src/ai/gemini.js', 'utf8')));
}

// 6g) 한 메시지의 여러 링크를 전부 찾는가
{
  const { findYoutubeLinks } = await import('./src/music/commands.js');
  const many = findYoutubeLinks('첫곡 https://youtu.be/aaaaaaaaaaa 둘째 https://www.youtube.com/watch?v=bbbbbbbbbbb 끝');
  ok('여러 링크 전부 감지 (2개)', many.length === 2, many.join(' | '));
  const dup = findYoutubeLinks('https://youtu.be/aaa https://youtu.be/aaa');
  ok('같은 링크 중복 제거', dup.length === 1);
  ok('링크 없으면 빈 배열', findYoutubeLinks('링크 없음').length === 0);
}

// 6h) 제어판 구성 (버튼/드롭다운)
{
  const { buildPanel } = await import('./src/music/panel.js');
  const fake = {
    guild: { id: 'paneltest' },
    current: { track: { title: '지금곡', duration: 200, thumbnail: null } },
    queue: [
      { track: { title: '다음곡A', duration: 100 } },
      { track: { title: '다음곡B', duration: 150 } },
    ],
    history: [{ track: { title: '지난곡' } }],
    loop: false,
    isPaused: false,
  };
  const panel = buildPanel(fake);
  const json = JSON.stringify(panel.components.map((r) => r.toJSON()));
  for (const id of ['m:prev', 'm:toggle', 'm:next', 'm:loop', 'm:stop', 'm:top', 'm:del', 'm:refresh']) {
    ok(`제어판 ${id} 있음`, json.includes(id));
  }
  ok('대기열이 임베드에 표시됨', JSON.stringify(panel.embeds[0].toJSON()).includes('다음곡A'));

  const empty = buildPanel(null);
  ok('재생 중 없을 때도 제어판 생성', empty.components.length >= 1);
}

// 6i) 이미지: 채널 지정이 없으면 전부 저장 (기본값 반전)
{
  const st = await import('./src/settings.js');
  const G = 'imgguild';
  // .env 에 IMAGE_CHANNEL_ID 가 있으므로 그 채널만 허용됩니다
  ok('.env 지정 채널은 허용', st.imageChannelAllowed(G, '222222222222222222'));
  ok('.env 지정 밖의 채널은 거부', !st.imageChannelAllowed(G, '999999999999999999'));
  ok('imagesEnabled 는 항상 true', st.imagesEnabled() === true);

  // ★ 제외 채널. 소유자 요청: "기본 모든 채널을 감지하되 특정 채널은 제외"
  //   ⚠️ **제외가 먼저 걸러져야 합니다.** 나중에 보면, 지정 목록이 비었을 때
  //      이미 true 로 나가버려서 제외가 통째로 무시됩니다.
  {
    const X = 'imgexcl';
    const A = '111111111111111111'; // 제외할 채널
    const B = '222222222222222222'; // .env 지정 채널
    ok('제외 전에는 허용', st.imageChannelAllowed(X, B));
    st.set(X, 'imageExcludeChannelIds', A);
    ok('제외한 채널은 거부', !st.imageChannelAllowed(X, A));
    ok('제외 안 한 채널은 그대로', st.imageChannelAllowed(X, B));
    // 제외한 채널의 스레드도 제외입니다. 부모를 따라야 합니다.
    ok('제외 채널의 스레드도 거부', !st.imageChannelAllowed(X, 'thread1', A));
    // 지정 목록과 겹칠 때 어느 쪽이 이기는가 — 제외가 이겨야 합니다.
    st.set(X, 'imageChannelIds', A);
    ok('지정에도 있으면 제외가 이김', !st.imageChannelAllowed(X, A));
    st.clear(X, 'imageExcludeChannelIds', A);
    ok('제외를 풀면 다시 허용', st.imageChannelAllowed(X, A));
    // /채널설정 선택지에 나와야 합니다. (KEYS 에 넣으면 자동)
    ok('/채널설정 항목으로 나옴', Boolean(st.KEYS.imageExcludeChannelIds?.label));
    ok('.env 로도 지정 가능', st.KEYS.imageExcludeChannelIds.envName === 'IMAGE_EXCLUDE_CHANNEL_ID');
  }
}

// 6j) 대기열 편집 로직 (제거 / 순서이동 / 비우기)
{
  const { GuildAudio } = await import('./src/audio/guild-audio.js');
  const a = new GuildAudio({ id: 'qtest' });
  const T = (n) => ({ track: { title: n, duration: 100 }, requestedBy: 'me' });
  a.queue = [T('1곡'), T('2곡'), T('3곡'), T('4곡')];

  const removed = a.removeAt(2);
  ok('removeAt(2) 가 2번째를 뺌', removed.track.title === '2곡', removed.track.title);
  ok('제거 후 3곡 남음', a.queue.length === 3);

  const moved = a.moveTo(3, 1);
  ok('moveTo(3,1) 로 맨 앞으로', a.queue[0].track.title === '4곡' && moved.track.title === '4곡',
    a.queue.map((x) => x.track.title).join(','));

  ok('범위 밖 번호는 null', a.removeAt(99) === null && a.moveTo(99, 1) === null);
  ok('큰 새번호는 맨 뒤로 붙음',
    a.moveTo(1, 999) !== null && a.queue[a.queue.length - 1].track.title === '4곡',
    a.queue.map((x) => x.track.title).join(','));

  ok('bringToFront 는 moveTo(pos,1) 과 같음', a.bringToFront(2) !== null);
  ok('clearQueue 가 개수를 돌려주고 비움', a.clearQueue() === 3 && a.queue.length === 0);

  // 이전곡: 기록이 없으면 아무것도 하지 않아야 함
  ok('기록 없으면 previous() 가 false', a.previous() === false);
  a.history.push(T('지난곡'));
  ok('기록 있으면 previous() 가 true', a.previous() === true);
  a.destroy();
}

// 6k) 속도 개선 + 제어판 동작이 코드에 실제로 들어갔는가
{
  const yt = fs.readFileSync('./src/music/ytdlp.js', 'utf8');
  ok('추출 1회로 재생주소까지 받음 (--print 사용)', yt.includes("'--print'"));
  ok('재생주소 재사용 판정 함수 존재', yt.includes('export function hasFreshStreamUrl'));
  const { hasFreshStreamUrl } = await import('./src/music/ytdlp.js');
  ok('신선한 주소는 재사용', hasFreshStreamUrl({ streamUrl: 'http://x', extractedAt: Date.now() }));
  ok('오래된 주소는 재추출', !hasFreshStreamUrl({ streamUrl: 'http://x', extractedAt: 0 }));
  ok('주소 없으면 재추출', !hasFreshStreamUrl({ streamUrl: null, extractedAt: Date.now() }));

  const ff = fs.readFileSync('./src/audio/ffmpeg.js', 'utf8');
  ok('원격 주소 재접속 옵션 있음', ff.includes("'-reconnect'"));

  const syn = fs.readFileSync('./src/tts/synth.js', 'utf8');
  ok('TTS 예열 함수 존재', syn.includes('export async function prewarm'));
  ok('TTS 연결 유지 타이머 존재', syn.includes('startKeepalive'));

  const pn = fs.readFileSync('./src/music/panel.js', 'utf8');
  ok('제어판: 알림 억제 플래그 사용', pn.includes('MessageFlags.SuppressNotifications'));
  ok('제어판: 맨 아래인지 확인', pn.includes('isAtBottom'));
  ok('제어판: 밀려나면 지우고 다시 띄움', pn.includes('panelMessage.delete()'));
  ok('제어판: 동시 호출 직렬화', pn.includes('panelChain'));

  const mc = fs.readFileSync('./src/music/commands.js', 'utf8');
  ok('링크 메시지 자동 삭제', mc.includes('message.delete()'));
  ok('삭제 실패 시 반응으로 대체', mc.includes("message.react('✅')"));
}

// 6l) /갤러리 가 이 채널의 폴더를 기본값으로 쓰는가
{
  const ic = fs.readFileSync('./src/images/commands.js', 'utf8');
  ok('/갤러리 기본값 = 이 채널 폴더', ic.includes('resolveFolder(interaction.channel, interaction.channelId)'));
  ok('/갤러리 가 폴더 목록으로 보내지 않음', !ic.includes('config.images.webPublicUrl;'));
}

// 6m) 타이머: 시간 해석과 저장 동작
{
  const T = await import('./src/timer/index.js');
  const cases = [
    ['15', 15], ['15분', 15], ['60', 60], ['1시간', 60],
    ['1시간 30분', 90], ['90m', 90], ['1h30m', 90], ['30초', 0.5],
  ];
  for (const [input, want] of cases) {
    const got = T.parseMinutes(input);
    ok(`시간해석 "${input}" = ${want}분`, Math.abs((got ?? -1) - want) < 0.001, String(got));
  }
  for (const bad of ['라면', '', 'abc', '0', '-5']) {
    ok(`시간해석 거부 ${JSON.stringify(bad)}`, T.parseMinutes(bad) === null);
  }
  ok('시간표시 90분 → 1시간 30분', T.formatMinutes(90) === '1시간 30분', T.formatMinutes(90));
  ok('시간표시 0.5분 → 30초', T.formatMinutes(0.5) === '30초', T.formatMinutes(0.5));

  // 단어 등록/삭제
  const G = 'timerguild';
  T.setWord(G, '라면', 3);
  ok('단어 등록', T.words(G)['라면'] === 3);
  ok('단어 삭제', T.removeWord(G, '라면') === true && T.words(G)['라면'] === undefined);
  ok('없는 단어 삭제는 false', T.removeWord(G, '없음') === false);

  // 타이머 추가/취소
  const t = T.addTimer({ guildId: G, channelId: 'c', userId: 'u', minutes: 60, label: '테스트' });
  ok('타이머 추가', T.running(G).length === 1 && T.running(G)[0].label === '테스트');
  ok('발동 시각이 미래', t.fireAt > Date.now() + 59 * 60_000);
  ok('타이머 취소', T.cancelTimer(t.id)?.label === '테스트' && T.running(G).length === 0);
  ok('없는 타이머 취소는 null', T.cancelTimer('nope') === null);

  // 자동완성 존재
  const cmd = allCommands.find((c) => c.data.toJSON().name === '타이머');
  ok('/타이머 에 자동완성 있음', typeof cmd.autocomplete === 'function');
  ok('/타이머 시간칸이 autocomplete 로 선언됨', cmd.data.toJSON().options[0].autocomplete === true);
}

// 6n) 자동완성 라우팅이 진입점에 연결됐는가
{
  const src2 = fs.readFileSync('./src/index.js', 'utf8');
  ok('index.js: isAutocomplete 처리', src2.includes('interaction.isAutocomplete()'));
  ok('index.js: 타이머 버튼 라우팅', src2.includes("startsWith('t:')"));
  ok('index.js: 타이머 복구 호출', src2.includes('initTimers('));
}

// 6z) /채널설정 — 비공개 채널도 지정할 수 있어야 한다
//
// ★ 비공개 채널이 **채널 고르기 칸에 안 뜨는** 경우가 있다 (소유자 보고).
//   그때 지정할 방법이 아예 없으면 안 된다 → 채널을 비우면 **지금 이 채널**로 지정한다.
//   그리고 비공개 채널은 봇에게 권한이 없기 쉬운데, 그러면 지정은 되고
//   **조용히 동작하지 않는다.** 그 자리에서 무엇이 없는지 알려줘야 한다.
{
  const cc = await import('./src/channel-commands.js');
  const dj2 = await import('discord.js');
  const src = fs.readFileSync('./src/channel-commands.js', 'utf8');

  ok('채널을 비우면 지금 이 채널로 지정', src.includes('const target = channel ?? interaction.channel'));
  ok('그렇게 지정했음을 알려줌', src.includes('**지금 이 채널**로 지정했습니다'));
  const opt = cc.commands[0].data.toJSON().options.find((o) => o.name === '채널');
  ok('채널 칸 설명이 비웠을 때를 알려줌', opt.description.includes('비우면'), opt.description);
  ok('채널 칸은 여전히 선택 입력', opt.required !== true);

  // 없는 권한만 골라서 알려주는가. 가짜 채널로 검사한다.
  const fakeInteraction = (username = '망고') => ({
    guild: { members: { me: { id: 'bot' } } },
    client: { user: { username } },
  });
  const chan = (has) => ({
    id: 'c1',
    name: '방송기록',
    isTextBased: () => true,
    isVoiceBased: () => false,
    permissionsFor: () => ({ has: (p) => has.includes(p) }),
  });
  const P = dj2.PermissionFlagsBits;
  const all = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks];

  ok('권한이 다 있으면 잔소리하지 않음',
    cc.permissionWarnings(fakeInteraction(), 'streamChannelId', chan(all)).length === 0);

  const noView = cc.permissionWarnings(fakeInteraction(), 'streamChannelId', chan([]));
  ok('권한이 없으면 알려줌', noView.length === 1);
  ok('없는 권한을 한국어로 이름 지어 알려줌',
    noView[0].includes('채널 보기') && noView[0].includes('메시지 보내기'), noView[0].split('\n')[0]);
  ok('지정은 됐지만 안 된다고 분명히 말함', noView[0].includes('그대로는 동작하지 않습니다'));
  ok('어디를 눌러야 하는지까지 적음', noView[0].includes('권한') && noView[0].includes('망고'));
  ok('비공개 채널은 봇도 초대해야 한다고 알려줌', noView[0].includes('봇도 따로 초대'));

  // 있는 권한은 목록에 넣지 않는다. 다 나열하면 무엇이 문제인지 안 보인다.
  const onlyEmbed = cc.permissionWarnings(fakeInteraction(), 'streamChannelId',
    chan([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]));
  ok('있는 권한은 안 적음 (없는 것만)',
    onlyEmbed[0].includes('링크 첨부') && !onlyEmbed[0].includes('채널 보기'), onlyEmbed[0].split('\n')[0]);

  // 음성채널은 다른 권한을 본다.
  const voiceChan = {
    id: 'v1', name: '음성', isTextBased: () => true, isVoiceBased: () => true,
    permissionsFor: () => ({ has: (p) => p === P.ViewChannel }),
  };
  const vw = cc.permissionWarnings(fakeInteraction(), 'ttsVoiceChannelId', voiceChan);
  ok('음성채널은 연결·말하기를 봄', vw[0].includes('연결') && vw[0].includes('말하기'), vw[0].split('\n')[0]);
  ok('음성채널에 메시지 권한을 요구하지 않음', !vw[0].includes('메시지 보내기'));

  // 카테고리는 검사할 것이 없다.
  ok('카테고리는 권한 검사를 건너뜀',
    cc.permissionWarnings(fakeInteraction(), 'planCategoryId', chan([])).length === 0);
  // 봇 정보를 못 읽으면 잔소리하지 않는다 (엉뚱한 경고보다 침묵이 낫다).
  ok('봇 정보를 못 읽으면 조용히 넘김',
    cc.permissionWarnings({ guild: null, client: { user: {} } }, 'streamChannelId', chan([])).length === 0);

  // 방송 채널을 정하면 그 자리에 제어판이 바로 떠야 한다 ("여기가 그 채널" 임을 알게).
  ok('방송 채널을 정하면 제어판을 바로 띄움', src.includes("key === 'streamChannelId'"));

  const forumAll = [P.ViewChannel, P.SendMessagesInThreads, P.ReadMessageHistory, P.ManageThreads];
  ok('포럼 권한이 다 있으면 경고 없음',
    cc.permissionWarnings(fakeInteraction(), 'recordingForumId', chan(forumAll)).length === 0);
  const forumMissing = cc.permissionWarnings(fakeInteraction(), 'recordingForumId', chan([P.ViewChannel]));
  ok('포럼에 필요한 권한을 따로 안내',
    !forumMissing[0].includes('공개 스레드 만들기') && forumMissing[0].includes('스레드에서 메시지 보내기'));
}

// 6za) 검사 자체가 환경에 기대지 않는가
//
// ★ 같은 사고가 **세 번** 났습니다. 전부 소유자 서버에서만 실패했습니다:
//   GEMINI_API_KEY · YTDLP_PATH · (잠재적으로) TTS_VOICE · STREAM_CLIP_MAX_SEC
//   집 PC 에서 초록불인데 서버에서 빨간불이면 검증이 방해가 됩니다.
{
  // `.env*.example` 에 있는 항목은 전부 눌려 있어야 한다.
  const notNeutralized = KNOWN_ENV_KEYS.filter(
    (k) => !(k in VERIFY_ENV) && (process.env[k] ?? '') !== ''
  );
  ok('알려진 설정 항목은 전부 눌러둠', notNeutralized.length === 0, notNeutralized.join(', '));
  ok('눌러둘 항목 목록을 example 에서 읽음', KNOWN_ENV_KEYS.length > 30, `${KNOWN_ENV_KEYS.length}개`);

  // 코드가 읽는 설정이 example 에 다 있는가. 없으면 그 항목만 환경에 따라 흔들린다.
  const codeKeys = new Set();
  for (const f of ['./src/config.js', './src/music/ytdlp.js', './src/images/cleanup.js']) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\['([A-Z][A-Z0-9_]*)'\])/g)) {
      codeKeys.add(m[1] ?? m[2]);
    }
    for (const m of text.matchAll(/\b(?:str|num|bool|list)\('([A-Z][A-Z0-9_]*)'/g)) codeKeys.add(m[1]);
  }
  // 이 셋은 설정이 아니라 시스템 환경변수라 example 에 없습니다.
  const systemKeys = new Set(['HOME', 'NODE_ENV', 'PATH', 'TMPDIR', 'TEMP']);
  const missing = [...codeKeys].filter((k) => !systemKeys.has(k) && !KNOWN_ENV_KEYS.includes(k));
  ok('코드가 읽는 설정이 .env*.example 에 다 있음', missing.length === 0, missing.join(', ') || '빠진 것 없음');

  // 실패를 맨 끝에 모아 보여주는가 (1000개가 넘어 스크롤로는 못 찾는다)
  const vsrc = fs.readFileSync('./verify.mjs', 'utf8');
  ok('실패를 맨 끝에 모아 보여줌', vsrc.includes('function reportFailures') && vsrc.includes('failures.push'));
  ok('실패한 것만 보는 방법이 있음', vsrc.includes('--quiet') && vsrc.includes("'-q'"));
  ok('npm 스크립트로도 있음',
    Boolean(JSON.parse(fs.readFileSync('./package.json', 'utf8')).scripts['verify:q']));
  // 조건에 함수를 넘기면 항상 통과가 된다. 실제로 한 번 그렇게 썼다.
  ok('조건에 함수를 넘기면 잡아냄', vsrc.includes("typeof cond === 'function'"));
}

// 6o) 기능 on/off
{
  const st = await import('./src/settings.js');
  const G = 'featguild';

  ok('기본값은 전부 켜짐', Object.values(st.featureStates(G)).every(Boolean));

  st.setFeature(G, 'music', false);
  ok('음악만 끄기', st.featureEnabled(G, 'music') === false && st.featureEnabled(G, 'tts') === true);

  st.setFeature(G, 'music', true);
  ok('다시 켜기', st.featureEnabled(G, 'music') === true);

  st.setAllFeatures(G, false);
  ok('전체 끄기', Object.values(st.featureStates(G)).every((v) => v === false));
  st.setAllFeatures(G, true);
  ok('전체 켜기', Object.values(st.featureStates(G)).every(Boolean));

  ok('기능 목록 9개', Object.keys(st.FEATURES).length === 9, Object.keys(st.FEATURES).join(','));
}

// 6p) 꺼진 기능이 실제로 막히는가 (태그 + 중앙 차단이 연결됐는지)
{
  const byName = new Map(allCommands.map((c) => [c.data.toJSON().name, c]));
  // 망고가 가진 것만 봅니다. 음악 쪽 태그는 6t) 에서 따로 확인합니다.
  const expect = {
    읽어주기: 'tts', 목소리: 'tts',
    타이머: 'timer', 알람등록: 'timer',
    갤러리: 'images', 폴더: 'images',
  };
  for (const [name, feature] of Object.entries(expect)) {
    ok(`/${name} 은 ${feature} 기능 소속`, byName.get(name)?.feature === feature, String(byName.get(name)?.feature));
  }
  // 항상 켜져 있어야 하는 것들 — 다 꺼놓고 되살릴 방법이 없으면 안 됩니다.
  // /나가기 는 음악·읽어주기·알람이 같은 음성 커넥션을 쓰므로 어느 기능에도 안 속합니다.
  for (const name of ['기능', '채널설정', '도움말', '나가기']) {
    ok(`/${name} 은 항상 동작 (태그 없음)`, byName.get(name)?.feature === undefined);
  }

  const idx = fs.readFileSync('./src/index.js', 'utf8');
  ok('index.js: 명령어 중앙 차단', idx.includes('command.feature && !featureEnabled'));
  ok('index.js: 버튼 차단', idx.includes("isMusic ? 'music' : isTimer ? 'timer' :"));
  ok('index.js: 채널 패널 라우팅', idx.includes("startsWith('c:')"));
  ok('index.js: f: 라우팅', idx.includes("startsWith('f:')"));

  for (const [file, key] of [
    ['./src/music/commands.js', 'music'],
    ['./src/tts/index.js', 'tts'],
    ['./src/images/commands.js', 'images'],
  ]) {
    ok(`${file} 메시지 처리 차단`, fs.readFileSync(file, 'utf8').includes(`featureEnabled(message.guildId, '${key}')`));
  }

}

// 6q) 음악 재생 실패 자가복구 + 갤러리 패널
{
  const ga = fs.readFileSync('./src/audio/guild-audio.js', 'utf8').replace(/\r\n/g, '\n');
  ok('재생 실패 감지 함수', ga.includes('playedNothing()'));
  ok('실패하면 한 단계 아래로 재시도', ga.includes('srcLevel: nextLevel'));
  ok('세 단계 모두 실패하면 사용자에게 알림', ga.includes('재생에 실패했습니다'));

  const ff = fs.readFileSync('./src/audio/ffmpeg.js', 'utf8');
  ok('ffmpeg 오류를 호출부로 전달', ff.includes('onError?.(msg)'));

  const yt = fs.readFileSync('./src/music/ytdlp.js', 'utf8');
  ok('구분자 기반 파싱 (줄 밀림 방지)', yt.includes("const SEP = '|::|'"));
  ok('재생주소 http 검증', yt.includes('isHttp(na(p[5]))'));
  ok('직접수신 끄는 스위치', yt.includes('MUSIC_DIRECT_STREAM'));

  // 재생목록: `list=` 가 붙었다고 전부 목록으로 보면 안 됩니다.
  // 유튜브는 자동재생으로 넘어가면 링크에 list=RD... 를 알아서 붙입니다.
  // 그걸 목록으로 처리하면 **노래 하나 공유했는데 수십 곡이 쏟아집니다.**
  const { playlistIdOf } = await import('./src/music/ytdlp.js');
  const plCases = [
    ['https://www.youtube.com/playlist?list=PLabc123', 'PLabc123'],
    ['https://www.youtube.com/watch?v=X&list=PLabc123', 'PLabc123'],
    ['https://youtu.be/X?list=PLabc123', 'PLabc123'],
    ['https://www.youtube.com/watch?v=X&list=UUabc', 'UUabc'], // 채널 업로드 — 진짜 목록
    ['https://www.youtube.com/watch?v=X&list=OLAK5uy_abc', 'OLAK5uy_abc'], // 앨범
    ['https://www.youtube.com/watch?v=X&list=RDabc', null], // 믹스/라디오 — 자동
    ['https://www.youtube.com/watch?v=X&list=RDMMabc', null],
    ['https://www.youtube.com/watch?v=X&list=LL', null], // 좋아요 (개인)
    ['https://www.youtube.com/watch?v=X&list=WL', null], // 나중에 볼 동영상 (개인)
    ['https://youtu.be/X', null],
  ];
  const plBad = plCases.filter(([url, want]) => playlistIdOf(url) !== want);
  ok('재생목록 판별 (믹스·개인목록은 제외)', plBad.length === 0,
    plBad.map(([u]) => u).join(' ') || `${plCases.length}가지 확인`);

  // 수백 곡짜리 목록이 흔합니다 (실측: 183곡). 상한이 없으면 대기열이 감당이 안 됩니다.
  ok('재생목록 곡 수 상한', yt.includes('PLAYLIST_MAX') && yt.includes('MUSIC_PLAYLIST_MAX'));
  ok('잘렸으면 몇 곡 중 몇 곡인지 알림',
    yt.includes('totalFound') &&
    fs.readFileSync('./src/music/commands.js', 'utf8').includes('전체 ${total}곡 중 앞 ${tracks.length}곡'));
  ok('붙여넣기로 담아도 잘린 것을 알림',
    fs.readFileSync('./src/music/commands.js', 'utf8').includes('재생목록이 길어서'));
  // 직접 수신이 매번 실패하면 곡마다 헛걸음해서 시간을 두 배로 씁니다.
  // 쿠키를 쓰는 서버에서 실제로 겪은 문제입니다.
  ok('직접수신이 계속 실패하면 스스로 끔', yt.includes('directDisabled') && yt.includes('noteDirectFailure'));
  ok('성공하면 실패 기록을 지움', yt.includes('noteDirectSuccess'));
  // ⚠️ Playing 이 떴다고 성공으로 치면 안 됩니다. 직접 수신이 거부돼도 플레이어는
  //    Playing 을 잠깐 지나갑니다. 그러면 "두 번 연속 실패하면 끈다" 가 매번 0으로
  //    되돌아가 **영영 작동하지 않고, 곡마다 헛걸음합니다.** (서버 로그에서 확인)
  ok('직접 수신 성공은 소리가 난 뒤에 판정',
    ga.includes('if (this.usedDirect) this.confirmDirectLater();') &&
    !/Playing[\s\S]{0,400}?if \(this\.usedDirect\) noteDirectSuccess\(\);/.test(ga));
  ok('판정 기준은 실제로 3초 이상 재생',
    ga.includes("(resource?.playbackDuration ?? 0) >= 3000) noteDirectSuccess()"));
  ok('그 사이 곡이 바뀌면 판정 안 함', ga.includes('this.currentResource !== resource) return;'));

  // 원본 준비의 **세 단계**. 1단계(뽑아둔 주소를 yt-dlp 가 받기)가 없으면
  // 쿠키를 쓰는 서버는 한 곡에 유튜브 추출을 **두 번** 합니다. (실측 3.5초 → 1.4초)
  {
    const { sourceLevel, SRC_DIRECT, SRC_URL, SRC_EXTRACT } = await import('./src/music/ytdlp.js');
    const fresh = { streamUrl: 'https://x/a', extractedAt: Date.now(), url: 'https://youtu.be/x' };
    const stale = { streamUrl: 'https://x/a', extractedAt: 1, url: 'https://youtu.be/x' };
    const none = { streamUrl: null, extractedAt: 0, url: 'https://youtu.be/x' };
    const saved = process.env.MUSIC_DIRECT_STREAM;

    process.env.MUSIC_DIRECT_STREAM = 'true';
    ok('주소가 살아있으면 0단계(직접)', sourceLevel(fresh, SRC_DIRECT) === SRC_DIRECT);
    ok('0단계가 실패했으면 1단계(뽑아둔 주소)', sourceLevel(fresh, SRC_URL) === SRC_URL);
    ok('1단계도 실패했으면 2단계(전체 추출)', sourceLevel(fresh, SRC_EXTRACT) === SRC_EXTRACT);
    ok('주소가 없으면 곧바로 2단계', sourceLevel(none, SRC_DIRECT) === SRC_EXTRACT);
    ok('주소가 만료됐으면 2단계', sourceLevel(stale, SRC_DIRECT) === SRC_EXTRACT);

    process.env.MUSIC_DIRECT_STREAM = 'false';
    // ⚠️ 직접 수신을 껐다고 2단계로 떨어지면 안 됩니다. 그게 예전의 느린 동작이었습니다.
    ok('직접수신을 꺼도 1단계는 씀', sourceLevel(fresh, SRC_DIRECT) === SRC_URL);
    if (saved === undefined) delete process.env.MUSIC_DIRECT_STREAM;
    else process.env.MUSIC_DIRECT_STREAM = saved;

    ok('1단계는 뽑아둔 주소를 넘김', yt.includes("createStream(track.streamUrl, { extract: false })"));
    // 재생 주소에는 고를 포맷이 하나뿐이라, -f 조건을 걸면 도리어 못 찾고 실패합니다.
    ok('추출하지 않을 때는 -f 를 안 붙임', yt.includes("if (extract) args.push('-f', AUDIO_FORMAT, '--no-playlist');"));
  }
  const gaDirect = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
  ok('실패 원인을 로그에 남김', gaDirect.includes('this.lastStreamError.slice(0, 200)'));
  const cfg = fs.readFileSync('./src/config.js', 'utf8');
  ok('.env 중복 항목 경고', cfg.includes('warnDuplicateEnvKeys'));
  ok('다음 곡 미리 추출', ga.includes('prefetchNext()'));
  // 재생 중에 재생목록을 담으면, 곡이 끝난 뒤에야 추출이 시작되어 그만큼 조용해졌습니다.
  ok('담을 때도 미리 추출', ga.includes('if (this.isPlaying) this.prefetchNext();'));
  ok('추출 결과 캐시', yt.includes('function cacheGet'));
  // 캐시본을 그대로 주면 호출한 쪽에서 streamUrl 을 덮어쓸 때 서로 간섭합니다.
  ok('캐시본을 복사해서 반환 (오염 방지)',
    yt.includes('return withTotal(cached);') && yt.includes('list.map((t) => ({ ...t }))'));
  ok('JS런타임 끄는 스위치', yt.includes('YTDLP_JS_RUNTIME'));

  // ★ 느린 서버에서 가장 큰 고정 비용은 yt-dlp 기동입니다. 공식 바이너리는
  //   실행할 때마다 파이썬을 풉니다 (실측 3.1~5.7초). pip 로 깐 것을 가리킬 수 있어야 합니다.
  {
    const { ytdlpPath } = await import('./src/music/ytdlp.js');
    ok('yt-dlp 경로를 바꿀 수 있음', yt.includes("process.env.YTDLP_PATH"));
    ok('기본은 bin/ 의 바이너리', ytdlpPath().includes('bin'));
    ok('어느 것을 쓰는지 로그에 찍음',
      fs.readFileSync('./src/index.js', 'utf8').includes('${ytdlpPath()}'));
    // 다른 yt-dlp 를 쓰는데 bin/ 을 갱신하면 봇이 쓰는 것은 안 바뀝니다.
    ok('갱신 스크립트가 그 사실을 알림',
      fs.readFileSync('./scripts/update-ytdlp.mjs', 'utf8').includes('YTDLP_PATH'));
    ok('.env.music.example 에 설명', fs.readFileSync('./.env.music.example', 'utf8').includes('YTDLP_PATH='));

    // ⚠️ pip 로 깔아놓고 `npm run update-ytdlp` 를 하면 봇이 쓰지도 않는 bin/ 만 갱신됩니다.
    //    "시키는 대로 했는데 안 고쳐진다" 가 됩니다.
    const { updateHint } = await import('./src/music/ytdlp.js');
    const savedPath = process.env.YTDLP_PATH;
    ok('기본 안내는 npm 스크립트', updateHint() === 'npm run update-ytdlp');
    process.env.YTDLP_PATH = '/home/ubuntu/.venv-ytdlp/bin/yt-dlp';
    // ⚠️ `[default]` 없이 깔면 최소 의존성만 들어와서, 손으로 돌리면 되는데
    //    **봇에서만(쿠키 경로에서) 실패**합니다. 안내에서 이게 빠지면 안 됩니다.
    ok('pip 안내에 [default] 가 있음', updateHint().includes('"yt-dlp[default]"'), updateHint());
    ok('안내하는 모든 pip 명령에 [default]',
      ['./src/index.js', './src/music/ytdlp.js', './scripts/update-ytdlp.mjs', './.env.music.example'].every(
        (p) => !/pip install(?! -U "yt-dlp\[default\]")/.test(fs.readFileSync(p, 'utf8'))
      ));
    if (savedPath === undefined) delete process.env.YTDLP_PATH;
    else process.env.YTDLP_PATH = savedPath;
    // 안내를 적는 곳이 여러 군데라 하나만 빠져도 엉뚱한 데로 보냅니다.
    // (문구를 직접 만드는 updateHint() 가 있는 ytdlp.js 는 제외)
    ok('안내는 전부 updateHint 를 거침',
      ['./src/index.js', './src/audio/guild-audio.js'].every(
        (p) => !fs.readFileSync(p, 'utf8').includes('npm run update-ytdlp')
      ));
  }
  ok('제한시간을 늘려가며 재시도', yt.includes('timeouts = timeoutLadder()') && yt.includes('timeouts[i - 1]'));

  // ★ 같은 yt-dlp 인데 손으로 돌리면 되고 봇에서만 안 되는 일이 있었습니다.
  //   봇이 덧붙이는 인자(--js-runtimes·--cookies) 때문입니다. 실패하면 그대로 남깁니다.
  {
    ok('끝내 실패하면 이유와 명령을 함께 남김',
      yt.includes('[music] 추출 실패') && yt.includes('이유: ${err.message') && yt.includes('명령: ${YTDLP}'));
    // 쿠키는 경로만 넘기므로 내용이 새지 않습니다. 내용을 인자로 넘기면 안 됩니다.
    ok('쿠키는 경로만 넘김', yt.includes("args.push('--cookies', cookies)") && !yt.includes('readFileSync(cookies'));
    // 복사해 붙여넣어 그대로 돌릴 수 있어야 합니다.
    const { quoteArgForLog } = await import('./src/music/ytdlp.js');
    ok('공백이 든 인자는 따옴표로', quoteArgForLog('a b') === "'a b'");
    ok('평범한 인자는 그대로', quoteArgForLog('--no-warnings') === '--no-warnings');
    ok('따옴표가 든 인자도 안전', quoteArgForLog("it's") === "'it'\\''s'", quoteArgForLog("it's"));
  }
  ok('타임아웃과 차단 안내를 구분', yt.includes('서버가 느린 것') && yt.includes('IP를 차단'));

  // ★ 첫 시도 제한시간이 고정 20초였습니다. 소유자 서버는 기동만 5.7초, 추출까지 20초라
  //   **매번** 잘리고 다시 하느라 한 번 뽑는 데 40초가 넘었습니다.
  {
    const { timeoutsFor, timeoutLadder, measureStartup } = await import('./src/music/ytdlp.js');
    const fast = timeoutsFor(1600, 0); // 집 PC (기동 1.6초)
    ok('제한시간은 두 단계', fast.length === 2 && fast[0] < fast[1]);
    ok('빠른 서버는 예전과 같음 (20초)', fast[0] === 20_000, `${fast[0]}ms`);

    // 소유자 서버: 기동만 5.7초. 20초로는 추출이 매번 잘립니다.
    const slow = timeoutsFor(5700, 0);
    ok('느린 서버는 첫 시도를 늘림', slow[0] > 20_000, `${slow[0] / 1000}초`);
    // ⚠️ 성공 기록만 보면 안 됩니다. 제한시간이 짧아 한 번도 성공 못 하면
    //    기록이 영영 안 쌓여 스스로 못 빠져나옵니다. 기동 시간이 바닥을 깝니다.
    ok('성공 기록 없이도 늘어남 (스스로 빠져나옴)', timeoutsFor(5700, 0)[0] === slow[0]);
    ok('성공 기록이 더 느리면 그걸 따름', timeoutsFor(1600, 25_000)[0] === 50_000);
    // ★ 한 번 잘려봤으면 그 자체가 증거입니다. 짐작(기동×5)보다 확실합니다 —
    //   실측에서 기동은 3.1~5.7초로 들쭉날쭉했는데 추출은 12~25초였습니다.
    //   기동이 3.1초로 찍힌 재시작에서는 짐작값이 20초에 머물러 또 잘렸습니다.
    ok('한 번 잘리면 다음엔 두 배로', timeoutsFor(3100, 0, 20_000)[0] === 40_000);
    ok('제한시간에 상한이 있음', timeoutsFor(999_999, 999_999, 999_999)[0] === 60_000);
    ok('두 번째도 상한이 있음', timeoutsFor(999_999, 999_999, 999_999)[1] <= 120_000);
    ok('시간 초과를 실제로 기록함', yt.includes('noteTimeout(timeoutMs)'));

    await measureStartup(); // 실제로 재보고, 그 값이 반영되는지
    ok('잰 기동 시간이 실제로 반영됨', timeoutLadder()[0] >= 20_000, `${timeoutLadder()[0]}ms`);
  }
  // ★ 첫 곡이 느린 이유의 상당 부분은 "유튜브 플레이어 JS 를 받아 파싱하는 비용" 입니다.
  //   곡과 상관없는 고정 비용이라 켤 때 미리 치러둘 수 있습니다. (TTS 예열과 같은 생각)
  {
    const ix = fs.readFileSync('./src/index.js', 'utf8');
    ok('켤 때 캐시를 미리 데움', yt.includes('export async function warmUpCache(') && ix.includes('warmUpCache()'));
    // ⚠️ systemd 는 HOME 이 없거나 다를 수 있어 ~/.cache 가 날아갑니다.
    //    그러면 곡마다 플레이어 JS 를 다시 받습니다. 경로를 직접 정해 그 문제를 없앱니다.
    ok('캐시 위치를 직접 지정', yt.includes("args = ['--cache-dir', CACHE_DIR]"));
    ok('캐시는 data/ 밑 (git 에 안 올라감)', yt.includes("path.join(config.dataDir, 'yt-dlp-cache')"));
    ok('캐시가 안 쌓이면 알려줌', ix.includes('캐시가 안 쌓입니다'));
    // 매 재시작마다 헛돌면, 켜자마자 곡을 트는 사람이 그만큼 기다립니다.
    ok('이미 쌓여 있으면 건너뜀', yt.includes('if (already) return 0;'));
    // 예열은 있으면 좋은 것입니다. 실패해도 재생은 되어야 합니다.
    ok('예열 실패는 재생을 막지 않음', /warmUpCache\([\s\S]{0,900}?\} catch \{\s*\n\s*return null;/.test(yt));
  }

  // 미리 뽑기가 조용히 실패하면 다음 곡이 왜 느린지 알 수 없습니다.
  ok('미리 뽑기 결과를 로그로', ga.includes('[music] 미리 뽑기 ${took()}초') && ga.includes('미리 뽑기 실패'));

  // ★ 1코어 서버에서 추출을 동시에 돌리면 서로를 굶깁니다.
  //   실측: 미리 뽑기 두 개가 겹쳐 각각 73.2초·62.9초가 걸리고 둘 다 잘렸습니다.
  ok('추출은 한 번에 하나만', yt.includes('function serializeExtraction(') && yt.includes('serializeExtraction(() => runSerialized('));
  // 재생용 스트림은 곡이 끝날 때까지 살아 있어서, 줄에 넣으면 미리 뽑기가 굶습니다.
  // 줄을 타는 곳은 run() 하나뿐이어야 합니다. (정의 1 + 호출 1 = 2)
  ok('줄을 타는 곳은 추출 하나뿐', (yt.match(/serializeExtraction\(/g) ?? []).length === 2);
  {
    // 지금 곡이 뽑히는 중에 다음 곡을 뽑으면 지금 듣고 싶은 곡이 더 늦게 나옵니다.
    const playingBlock = ga.slice(
      ga.indexOf('AudioPlayerStatus.Playing, () => {'),
      ga.indexOf("this.musicPlayer.on('error'")
    );
    const playNextBlock = ga.slice(ga.indexOf("playNext(intent = 'auto') {"), ga.indexOf('  reapplyVolume()'));
    ok('미리 뽑기는 소리가 난 뒤에 시작', playingBlock.includes('this.prefetchNext();'));
    ok('곡을 거는 순간에는 미리 뽑지 않음', !playNextBlock.includes('this.prefetchNext();'));

    // ★ 주소를 뽑아뒀어도 첫 소리까지 9~11초입니다(실측). 그게 곡 사이 침묵이 됩니다.
    //   곡이 끝나갈 무렵 **소리까지** 미리 열어두면 전환이 사실상 즉시가 됩니다.
    // ⚠️ "곡 끝나기 40초 전" 에 걸면 **곡을 넘겨가며 듣는 분에게는 그 시점이 안 옵니다.**
    //    (실측: 14초 만에 다음 곡) 주소가 준비되는 즉시 겁니다.
    ok('주소가 준비되면 곧바로 소리도 엶',
      /\.finally\(\(\) => \{[\s\S]{0,400}?this\.prepareNext\(\)/.test(ga));
    ok('주소가 이미 있으면 준비만 겁니다',
      /hasFreshStreamUrl\(next\.track\)\) \{[\s\S]{0,200}?this\.prepareNext\(\)/.test(ga));
    // 그래도 실패하거나 중간에 끊겼을 때를 위한 보험은 남겨둡니다.
    ok('실패했을 때를 위한 예약은 남김', playingBlock.includes('this.schedulePrepareNext();'));

    // ★ 열어둔 소리는 **죽을 수 있습니다.** 곡 하나가 끝날 때까지 몇 분을 노는 연결로 기다립니다.
    //   죽은 걸 모르고 틀면 "소리 안 남 → 실패 판정 → 재시도" 라 지금보다 나빠집니다.
    ok('끊기면 죽은 것으로 표시', ga.includes('prepared.dead = true;'));
    ok('끊기면 붙잡고 있지 않음', ga.includes("stream.once('end', onDead);") && ga.includes("stream.once('error', onDead);"));
    ok('쓸 때 다시 확인', playNextBlock.includes('!this.prepared.dead'));
    ok('죽었으면 다시 열어봄', ga.includes('this.schedulePrepareNext(); // 곡이 끝나갈 무렵 다시 열어봅니다'));
    // ★ 준비도 세 단계를 탑니다. 0단계가 안 되는 서버에서 준비만 0단계로 시도하면
    //   매번 빈손으로 끝나 미리 열어두기가 통째로 무용지물이 됩니다.
    //   (MUSIC_DIRECT_STREAM=true 인 동안 `다음 곡 준비 완료` 가 한 번도 안 찍혔습니다)
    ok('준비도 안 되면 한 단계 아래로', ga.includes('return this.prepareNext(src.level + 1);'));
    ok('준비 실패도 직접수신 실패로 셈', ga.includes("if (src.level === SRC_DIRECT) noteDirectFailure("));
    ok('마지막 단계까지 실패하면 알림', ga.includes('다음 곡 준비 실패 (소리 없음)'));
    ok('재귀 전에 자리를 비켜줌', ga.includes('this.preparing = false; // 아래 재귀가'));
    ok('준비해둔 소리를 실제로 씀', playNextBlock.includes('this.prepared.item === item'));
    // 대기열이 바뀌었으면 준비해둔 것은 남이 됩니다. 반드시 정리해야 프로세스가 안 남습니다.
    ok('내 것이 아니면 버림', playNextBlock.includes('this.dropPrepared();'));
    ok('버릴 때 프로세스도 죽임', ga.includes('this.prepared.kill();'));
    for (const fn of ['stop()', 'clearQueue()', 'destroy()']) {
      const body = ga.slice(ga.indexOf(`  ${fn} {`), ga.indexOf(`  ${fn} {`) + 700);
      ok(`${fn} 에서도 정리`, body.includes('this.dropPrepared()'));
    }
    // 음량은 ffmpeg 을 띄울 때 정해집니다. 미리 연 소리에는 옛 음량이 박혀 있습니다.
    ok('음량이 바뀌면 다시 엶',
      /reapplyVolume\(\)[\s\S]{0,400}?this\.dropPrepared\(\);[\s\S]{0,120}?this\.schedulePrepareNext\(\);/.test(ga));
  }
  ok('타임아웃 메시지에 실제 초 표기', yt.includes('초 안에 응답하지 않았습니다'));
  const mc2 = fs.readFileSync('./src/music/commands.js', 'utf8').replace(/\r\n/g, '\n');
  ok('추출과 음성접속을 동시에', mc2.includes('Promise.all([gettingTracks, audio.connect(voiceChannel)])'));
  // ★ 지난 곡은 제목·길이를 이미 압니다. 담기만 하는데 yt-dlp 를 부르면 곡당 몇 초씩 걸립니다.
  //   (소유자 지적: "지난 곡에서 선택해서 대기열에 담는것도 오래걸려")
  ok('아는 곡은 추출을 건너뜀', mc2.includes('known\n    ? Promise.resolve(known)'));
  ok('지난 곡은 기록에서 제목을 씀', mc2.includes('recentHistory(interaction.guildId, 60)'));
  ok('지난 곡 담기는 yt-dlp 를 안 부름',
    /handleHistoryComponent[\s\S]*?enqueue\(\{\s*\n\s*tracks,/.test(mc2));
  // 느릴 때 어디가 느린지 로그만 보고 알 수 있어야 합니다.
  ok('곡 정보에 걸린 시간을 남김', mc2.includes('[music] 곡 정보 ${'));
  ok('첫 소리까지 걸린 시간을 남김', ga.includes('[music] 첫 소리까지 ${sec}초'));
  ok('yt-dlp 기동 시간을 켤 때 잼',
    yt.includes('export function measureStartup()') &&
    fs.readFileSync('./src/index.js', 'utf8').includes('yt-dlp 기동 ${sec.toFixed(1)}초'));
  ok('링크 감지 즉시 반응', mc2.includes("message.react('⏳')"));
  ok('미리추출: 대기열 변경 확인', ga.includes('this.queue.includes(next)'));

  const ip = fs.readFileSync('./src/images/panel.js', 'utf8');
  ok('갤러리 패널: 알림 억제', ip.includes('MessageFlags.SuppressNotifications'));
  ok('갤러리 패널: 맨 아래 확인', ip.includes('isAtBottom'));
  ok('갤러리 패널: 밀려나면 다시 띄움', ip.includes('existing.delete()'));
  ok('갤러리 패널: 사진 없으면 안 띄움', ip.includes('files.length === 0'));
  ok('갤러리 패널: 링크 버튼', ip.includes('ButtonStyle.Link'));
  ok('이미지 저장 후 패널 호출', fs.readFileSync('./src/images/commands.js', 'utf8').includes('showGalleryPanel('));
}

// 6r) 사진 용량 자동 정리
{
  process.env.IMAGE_MAX_GB = '0.000001'; // 1KB — 무조건 초과시켜 계획이 서는지 본다
  process.env.IMAGE_MIN_KEEP_DAYS = '0';
  const cl = await import('./src/images/cleanup.js');

  const L = cl.limits();
  ok('예산 설정을 읽음', L.maxBytes > 0 && L.targetPercent > 0);
  ok('기본 최소보관일이 있음', cl.limits().minKeepDays >= 0);

  const u = await cl.usage();
  ok('용량 집계', typeof u.bytes === 'number' && typeof u.count === 'number');
  ok('디스크 여유 확인', u.diskFree === null || u.diskFree > 0, String(u.diskFree));

  const plan = await cl.planCleanup();
  ok('계획은 실제로 지우지 않음 (files 목록만)', Array.isArray(plan.files));
  ok('요약 문구 생성', typeof cl.describe(plan) === 'string' && cl.describe(plan).length > 10);

  // 예산이 넉넉하면 정리 대상이 없어야 한다
  process.env.IMAGE_MAX_GB = '1000';
  const plan2 = await cl.planCleanup();
  ok('여유 있으면 정리 안 함', plan2.need === false, plan2.reason);

  const src2 = fs.readFileSync('./src/images/cleanup.js', 'utf8');
  ok('오래된 순 정렬', src2.includes('a.mtime - b.mtime'));
  ok('최근 사진 보호', src2.includes('f.mtime > cutoff'));
  ok('디스크 바닥이면 보호 해제', src2.includes('const ignoreAge = diskTight'));
  ok('정리 후 디스코드 알림', src2.includes('사진 자동 정리'));

  const ic2 = fs.readFileSync('./src/images/commands.js', 'utf8');
  ok('/정리 는 확인 버튼을 거침', ic2.includes("setCustomId('g:clean')"));
  ok('확인 시점에 계획을 다시 계산', ic2.includes('planCleanup({ force: true })'));

  process.env.IMAGE_MAX_GB = '15';
  delete process.env.IMAGE_MIN_KEEP_DAYS;
}

// 6s) 음량 (음악 / 읽어주기 따로)
{
  const st = await import('./src/settings.js');
  const G = 'volguild';
  ok('기본은 100%', st.volumePercent(G, 'music') === 100 && st.volumePercent(G, 'tts') === 100);
  ok('배율은 1', st.volumeScale(G, 'music') === 1);

  st.setVolume(G, 'music', 70);
  ok('음악만 바뀜', st.volumePercent(G, 'music') === 70 && st.volumePercent(G, 'tts') === 100);
  ok('배율 환산', Math.abs(st.volumeScale(G, 'music') - 0.7) < 1e-9, String(st.volumeScale(G, 'music')));

  st.setVolume(G, 'tts', 150);
  ok('읽어주기는 따로', st.volumePercent(G, 'tts') === 150 && st.volumePercent(G, 'music') === 70);

  ok('상한을 넘기면 잘림', st.setVolume(G, 'music', 999) === st.VOLUME_MAX, String(st.VOLUME_MAX));
  ok('음수는 0으로', st.setVolume(G, 'music', -50) === 0);
  st.setVolume(G, 'music', 100);
  st.setVolume(G, 'tts', 100);

  // inlineVolume 을 쓰면 안 됩니다 (순수 JS opus 인코더뿐이라 1코어 서버에서 끊김)
  const ga2 = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
  ok('inlineVolume 을 쓰지 않음', !ga2.includes('inlineVolume'));
  ok('ffmpeg 음량으로 조절', ga2.includes("volumeScale(this.guild.id, 'music')"));
  ok('재생 중 음량 반영 (이어서 다시 틀기)', ga2.includes('reapplyVolume()') && ga2.includes('seekSec: resumeAt'));

  const pn2 = fs.readFileSync('./src/music/panel.js', 'utf8');
  ok('제어판에 음량 버튼', pn2.includes("'m:vol+'") && pn2.includes("'m:vol-'"));

  // 읽어주기·알람 음량 조절은 걷어냈습니다. speak() 에 음량 인자도 남기지 않습니다.
  ok('읽어주기는 원음 그대로', ga2.includes('speak(makeStream, targetChannelId = null) {') &&
    ga2.includes('const piped = toOggOpus(raw);'));

  // 소리가 안 나오는 글을 그냥 재생하면 Playing 을 15초 기다리다 실패하고,
  // 그동안 뒤에 온 문장이 전부 밀립니다.
  ok('소리 안 나오면 15초 기다리지 않고 건너뜀',
    ga2.includes('await waitForAudio(piped.stream') && ga2.includes('소리가 나오지 않아 건너뜁니다'));
}

// 7) 유튜브 링크 감지
const { findYoutubeLink } = await import('./src/music/commands.js');
ok('youtu.be 감지', findYoutubeLink('보셈 https://youtu.be/dQw4w9WgXcQ') !== null);
ok('일반문장 무시', findYoutubeLink('링크 없음') === null);

// 8) 웹 갤러리
const { startWebServer } = await import('./src/web/server.js');
const server = await startWebServer();
const base = 'http://127.0.0.1:38473';
const auth = 'Basic ' + Buffer.from('u:testsecret').toString('base64');
// 루트: 안내만. 폴더 이름이 새어나가면 안 됩니다.
{
  const r = await fetch(base);
  ok('루트는 암호 없이 열림 (200)', r.status === 200, String(r.status));
  const html = await r.text();
  ok('루트에 안내 문구', html.includes('/갤러리'));
  ok('루트에 폴더 이름 노출 없음', !html.includes('/f/'), '폴더 링크가 보이면 실패');
}

// 폴더 목록: 소유자 전용 (브라우저 로그인창을 띄우는 401)
{
  const noAuth = await fetch(base + '/folders');
  ok('폴더 목록: 암호 없으면 401', noAuth.status === 401, String(noAuth.status));
  ok('폴더 목록: 로그인창 유도 헤더 있음', Boolean(noAuth.headers.get('www-authenticate')));
  const withAuth = await fetch(base + '/folders', { headers: { Authorization: auth } });
  ok('폴더 목록: 맞는 암호면 200', withAuth.status === 200, String(withAuth.status));
  ok('폴더 목록 페이지 렌더', (await withAuth.text()).includes('폴더 목록'));
}

// 폴더 안 갤러리: 누구나 (친구들이 링크만 열면 되도록)
{
  const g = await fetch(base + '/f/' + encodeURIComponent('테스트폴더'));
  ok('폴더 갤러리는 암호 없이 200', g.status === 200, String(g.status));
  const html = await g.text();
  ok('갤러리에 뒤로가기 버튼 없음', !html.includes('← 폴더 목록'));
  ok('갤러리에 다른 폴더 이름 목록 없음', !html.includes('<datalist'));
}

ok('경로탈출 요청 차단', (await fetch(base + '/img/..%2f..%2f/etc')).status >= 400);

// 되돌릴 수 없는 작업(삭제·이동)은 암호로 막힘
const delBody = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: '기타', files: ['x.png'] }) };
ok('삭제: 암호 없으면 401', (await fetch(base + '/api/delete', delBody)).status === 401);
ok('삭제: 틀린 암호 401',
  (await fetch(base + '/api/delete', { ...delBody, headers: { ...delBody.headers, Authorization: 'Basic ' + Buffer.from('u:wrong').toString('base64') } })).status === 401);
ok('삭제: 맞는 암호는 통과 (401 아님)',
  (await fetch(base + '/api/delete', { ...delBody, headers: { ...delBody.headers, Authorization: auth } })).status !== 401);
ok('이동: 암호 없으면 401',
  (await fetch(base + '/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'a', files: ['x.png'], to: 'b' }) })).status === 401);

ok('WEB_BIND 적용 (127.0.0.1 바인딩)', server.address().address === '127.0.0.1', server.address().address);

// 8b) 방송 클립 — 경로 안전장치 · 길이 상한 · 웹 라우트
//
// ⚠️ **실제 추출은 여기서 하지 않습니다** (네트워크를 타고 15초쯤 걸림).
//    yt-dlp 로 직접 확인해뒀습니다 (2026-09-03, 15초 구간 = 2.4MB, `-> #0:0 (copy)`, H.264).
//    여기서는 그 앞뒤 — 값 만들기, 경로, 상한, 웹 — 를 봅니다.
{
  const clips = await import('./src/stream/clips.js');
  const st2 = await import('./src/stream/store.js');
  const pn2 = await import('./src/stream/panel.js');
  const PATH = (await import('node:path')).default;
  const { config } = await import('./src/config.js');
  await clips.initClips();
  await st2.initStreams();

  // ★ 불변조건은 "clips/ 밖으로 못 나간다" 다.
  //   뿌리를 data/ 에 두면 settings.json · streams.json 이 한 칸 거리에 놓인다.
  ok('클립 뿌리는 data/clips (data/ 가 아님)', clips.baseDir().endsWith(PATH.join('clips')));
  for (const bad of ['..', '../..', 'a/b', '..%2fx', '', 'AB', 'toolongfoldername', '../settings']) {
    let threw = false;
    try { clips.folderPath(bad); } catch { threw = true; }
    ok(`클립 폴더 이름 거부: ${JSON.stringify(bad)}`, threw);
  }
  for (const bad of ['../../settings.json', '..\\..\\x', 'a/b/c', '....//x']) {
    const p = clips.filePath('abc123', bad);
    ok(`클립 파일 이름이 폴더를 못 벗어남: ${JSON.stringify(bad)}`,
      p.startsWith(clips.folderPath('abc123') + PATH.sep), p);
  }

  // 클립 만들기 창 — 기본값이 시:분:초여야 한다.
  // parseElapsed 는 숫자만 적으면 **분**으로 보므로(90 → 90분) 기본값으로 그 길을 막는다.
  const cs = st2.openSession('gc', 'chc', '테스트');
  st2.putStream(cs, { userId: 'u1', url: 'https://www.youtube.com/watch?v=' + 'A'.repeat(11), videoId: 'A'.repeat(11), startedAt: st2.nowSec() - 3600, startSource: 'release_timestamp' });
  const cm = st2.addMark(cs, 'u1');
  cm.at = st2.nowSec() - 3600 + 60; // 영상 60초 지점
  st2.setMarkText(cs, cm.id, '테스트 장면');
  const cStream = st2.streamOf(cs, 'u1');
  const clipModal = JSON.stringify(pn2.buildClipModal(cs, cStream, cm).toJSON());
  ok('클립 창 시작이 마킹 15초 앞 (시:분:초)', clipModal.includes('"value":"00:00:45"'), clipModal.match(/"value":"[^"]*"/g)?.join(' '));
  ok('클립 창 끝이 마킹 25초 뒤', clipModal.includes('"value":"00:01:25"'));
  ok('클립 창 제목이 마킹 설명으로 채워짐', clipModal.includes('테스트 장면'));
  ok('클립 창 안내가 시:분:초 형식을 유도', clipModal.includes('01:20:30'));
  // 설명이 없는 마킹에 setValue('') 를 하면 창이 조용히 안 뜬다. (규칙 7-1)
  const bare = { ...cm, text: '' };
  const bareModal = JSON.stringify(pn2.buildClipModal(cs, cStream, bare).toJSON());
  ok('설명 없는 마킹의 제목 칸에 value 를 넣지 않음', !/"value":""/.test(bareModal));

  // ★ 길이 상한이 실질적인 **용량** 상한이다. 개수 제한은 바이트를 못 막는다.
  let capped = null;
  await clips.makeClip({ folder: 'abc123', url: 'x', startSec: 0, endSec: 600, title: 't' }).catch((e) => (capped = e.message));
  ok('클립 길이 상한이 막음 (용량 폭주 방지)', /180초까지/.test(capped ?? ''), (capped ?? '').split('\n')[0]);
  let rev = null;
  await clips.makeClip({ folder: 'abc123', url: 'x', startSec: 60, endSec: 30, title: 't' }).catch((e) => (rev = e.message));
  ok('끝이 시작보다 앞이면 막음', /뒤여야/.test(rev ?? ''));

  // ── ffmpeg 이 죽었을 때 (소유자 서버 실측: `ffmpeg exited with code -11`) ──
  //
  // ★ 음수 코드는 **신호 번호**다. -11 = SIGSEGV. 정상 실패(코드 1)와 구분해야
  //   "다른 ffmpeg 으로 넘기기" 를 아무 실패에나 하지 않는다.
  {
    const yt4 = await import('./src/music/ytdlp.js');
    ok('-11 은 죽은 것으로 봄', clips.looksLikeFfmpegCrash('ERROR: ffmpeg exited with code -11'));
    ok('-9(메모리 부족)도 죽은 것', clips.looksLikeFfmpegCrash('ffmpeg exited with code -9'));
    ok('segfault 글자도 잡음', clips.looksLikeFfmpegCrash('ffmpeg: Segmentation fault'));
    // ⚠️ 정상 실패를 죽음으로 보면 아무 오류에나 ffmpeg 을 갈아치운다.
    ok('코드 1 은 죽은 것이 아님', !clips.looksLikeFfmpegCrash('ERROR: ffmpeg exited with code 1'));
    ok('다른 오류도 죽은 것이 아님', !clips.looksLikeFfmpegCrash('ERROR: Video unavailable'));

    // ── 양수 코드: ffmpeg 자신의 오류 (소유자 서버 실측: 183) ──
    //
    // ★ ffmpeg 은 AVERROR 값을 반환하고 종료 코드는 & 0xFF 로 잘린다.
    //   AVERROR_INVALIDDATA = -1094995529 → 183. 계산과 실측으로 확인했다.
    //   숫자만 보여주면 아무도 원인을 모른다.
    ok('183 을 AVERROR_INVALIDDATA 로 해석', clips.ffmpegExitMeaning(183)?.what.includes('영상이 아니'));
    // ⚠️ 처음엔 "쿠키가 없어서 유튜브가 거부" 라고 짚었는데 **틀렸다.**
    //    같은 쿠키 설정으로 잘 된다. 진짜 원인은 방송에 **화면이 없었던** 것이었다.
    //    실제로 겪은 원인을 첫 번째로 적어야 한다.
    ok('183 은 실제로 겪은 원인(화면 없음)을 먼저 짚어줌',
      clips.ffmpegExitMeaning(183)?.likely.includes('음성만 녹화된 방송'));

    // ── 화면 없는 방송은 **소리만** 잘라준다 (소유자 요청) ──
    //
    // ⚠️ 처음부터 소리만 받으면 안 된다. 그러면 영상이 있는 방송에서도 조용히
    //   소리만 내주게 되고, 사람은 뭘 받았는지 모른다.
    //   영상을 먼저 요구하고 "없다" 는 답을 받은 뒤에만 내려간다.
    ok('영상 포맷이 없다는 답을 알아봄',
      clips.looksLikeNoVideo('ERROR: Requested format is not available. Use --list-formats …'));
    ok('다른 오류는 영상 없음으로 안 봄', !clips.looksLikeNoVideo('ERROR: Video unavailable'));

    const ytFmt = fs.readFileSync('./src/music/ytdlp.js', 'utf8');
    // ★ 맨 뒤 /b 를 붙이면 오디오 포맷에 걸려 소리만 든 파일을 "영상 클립" 이라고 내준다.
    ok('영상을 받을 때는 영상을 반드시 요구',
      ytFmt.includes('b[vcodec!=none]') && !/\/b`;/.test(ytFmt));
    ok('소리만 받는 선택식이 따로 있음', ytFmt.includes("'ba[ext=m4a]/ba/b[acodec!=none]'"));
    // 소리를 mp4 로 감싸면 브라우저가 영상처럼 열려다 검은 화면을 보여준다.
    ok('소리만일 때는 mp4 로 감싸지 않음',
      /if \(!audioOnly\) args\.push\('--merge-output-format', 'mp4'\)/.test(ytFmt));

    const csrc3 = fs.readFileSync('./src/stream/clips.js', 'utf8');
    ok('영상을 먼저 시도한 뒤에만 소리로 내려감',
      csrc3.indexOf('let err = await attempt(false)') < csrc3.indexOf('looksLikeNoVideo(err.message)'));
    ok('소리 내려가기를 끌 수 있음', csrc3.includes('config.stream.clipAudioFallback'));
    ok('확장자를 가정하지 않고 결과를 찾음',
      csrc3.includes('findProduced') && !csrc3.includes('`${stem}.mp4`'));

    // 목록·페이지가 소리 클립을 구분해야 한다.
    ok('mp4 만이 아니라 m4a 도 클립으로 봄', clips.isMediaClip('a.m4a') && clips.isMediaClip('a.mp4'));
    ok('소리 클립을 알아봄', clips.isAudioClip('a.m4a') && !clips.isAudioClip('a.mp4'));
    ok('반쪽 파일은 여전히 클립이 아님',
      !clips.isMediaClip('a.mp4.part') && !clips.isMediaClip('a.ytdl'));
    const wsrc = fs.readFileSync('./src/web/server.js', 'utf8');
    // 소리만인 클립을 <video> 로 보여주면 검은 화면이 나온다. "재생이 안 된다" 로 보인다.
    ok('소리 클립은 <audio> 로 보여줌', wsrc.includes('<audio src=') && wsrc.includes('f.audio'));
    ok('소리 클립임을 화면에 표시', wsrc.includes('🎧 소리만'));
    const si5 = fs.readFileSync('./src/stream/index.js', 'utf8');
    ok('소리만 만들어졌으면 반드시 말해줌',
      si5.includes('made.audioOnly') && si5.includes('소리만 잘라냈습니다'));
    // ⚠️ 모르는 코드는 지어내지 않는다. (3.1-4)
    ok('모르는 코드는 null (지어내지 않음)', clips.ffmpegExitMeaning(77) === null);

    const msg183 = clips.clipError(
      'ERROR: ffmpeg exited with code 183',
      'HTTP error 403 Forbidden\n[download] something\nError opening input: Invalid data found when processing input'
    );
    ok('183 안내에 원문이 들어감', msg183.includes('403 Forbidden'));
    ok('183 안내가 뜻을 설명', msg183.includes('AVERROR_INVALIDDATA'));
    ok('[download] 진행 줄은 걸러냄', !msg183.includes('[download] something'));
    ok('원문이 없으면 로그를 보라고 안내',
      clips.clipError('ERROR: ffmpeg exited with code 183', '').includes('클립 실패 원문'));
    const unknownMsg = clips.clipError('ERROR: ffmpeg exited with code 77', 'weird http error');
    ok('모르는 코드는 모른다고 말함', unknownMsg.includes('저도 모릅니다'));

    // 원문을 버리면 진짜 원인이 사라진다. runOnce 가 붙여줘야 한다.
    const yt5 = fs.readFileSync('./src/music/ytdlp.js', 'utf8');
    ok('yt-dlp 오류에 원문을 붙여둠 (err.stderr)', yt5.includes('e.stderr = err;'));
    const csrc2 = fs.readFileSync('./src/stream/clips.js', 'utf8');
    ok('클립 실패는 원문을 통째로 로그에 남김',
      csrc2.includes('클립 실패 원문') && csrc2.includes('logClipFailure'));
    ok('원문을 clipError 에 넘김', csrc2.includes('clipError(err.message, err.stderr)'));

    const crashMsg = clips.clipError('ERROR: ffmpeg exited with code -11');
    ok('죽었을 때 원문을 그대로 보여줌', crashMsg.includes('code -11'));
    ok('신호 번호라는 것을 설명', crashMsg.includes('-11 = 세그폴트'));
    ok('무엇을 해보면 되는지 적음', crashMsg.includes('sudo apt install -y ffmpeg') && crashMsg.includes('FFMPEG_PATH'));
    ok('-9 면 메모리를 보라고 안내', crashMsg.includes('free -h'));

    // 후보를 넘길 수 있어야 한다. 못 넘기면 재시도할 것이 없다.
    yt4.resetFfmpegChoice();
    const first = yt4.ffmpegInUse();
    ok('기본은 묶음 ffmpeg', first.includes('ffmpeg-static'), first);
    const second = yt4.nextFfmpeg();
    ok('죽으면 다음 후보로 넘어감', Boolean(second) && second !== first, String(second));
    // FFMPEG_PATH 를 지정하면 그것만 쓴다 (사람이 정한 것을 봇이 갈아치우면 안 된다).
    process.env.FFMPEG_PATH = '/usr/bin/ffmpeg';
    yt4.resetFfmpegChoice();
    ok('FFMPEG_PATH 를 정하면 그것만 씀', yt4.ffmpegInUse() === '/usr/bin/ffmpeg');
    ok('정해줬으면 다른 것으로 안 넘김', yt4.nextFfmpeg() === null);
    process.env.FFMPEG_PATH = '';
    yt4.resetFfmpegChoice();

    const csrc = fs.readFileSync('./src/stream/clips.js', 'utf8');
    ok('죽었을 때만 다시 시도', csrc.includes('looksLikeFfmpegCrash(err.message) && nextFfmpeg()'));
    ok('다시 시도 전에 반쪽 파일을 치움',
      /cleanLeftovers\(folder, stem\);[\s\S]{0,400}looksLikeFfmpegCrash/.test(csrc));
    ok('바꿔 시도한다는 것을 로그에 남김', csrc.includes('다른 ffmpeg 으로 다시 시도합니다'));
    const idx3 = fs.readFileSync('./src/index.js', 'utf8');
    ok('켤 때 쓸 수 있는 ffmpeg 을 골라 찍음', idx3.includes('pickFfmpeg()') && idx3.includes('클립용 ffmpeg'));
    ok('못 찾으면 타임라인은 된다고 알려줌', idx3.includes('타임라인 기록은 ffmpeg 없이도 됩니다'));
  }

  // 오류 안내 — 원인을 모르면 원문을 그대로 보여줘야 한다. (ARCHITECTURE 3.1-4)
  ok('다시보기가 아직 없으면 그렇게 안내',
    clips.clipError('ERROR: This live stream recording is not available.').includes('다시보기를 만들고 있습니다'));
  ok('비공개면 일부공개로 바꾸라고 안내',
    clips.clipError('ERROR: Private video').includes('일부공개'));
  ok('영상이 사라졌으면 그렇게 안내',
    clips.clipError('ERROR: Video unavailable').includes('사라졌습니다'));
  ok('모르는 오류는 원문을 그대로 보여줌',
    clips.clipError('ERROR: 처음 보는 오류입니다') === 'ERROR: 처음 보는 오류입니다');

  // 웹 라우트 — 가짜 파일로 확인한다 (실제 추출 없이).
  const fakeFolder = 'zz99zz';
  const fakeName = '000045-테스트.mp4';
  fs.mkdirSync(clips.folderPath(fakeFolder), { recursive: true });
  fs.writeFileSync(clips.filePath(fakeFolder, fakeName), Buffer.alloc(4096, 1));
  // .mp4 가 아닌 반쪽 파일은 목록에 나오면 안 된다.
  fs.writeFileSync(clips.filePath(fakeFolder, `${fakeName}.part`), Buffer.alloc(10));

  const listed = await clips.listClips(fakeFolder);
  ok('클립 목록은 .mp4 만 (반쪽 파일 제외)', listed.length === 1 && listed[0].name === fakeName, listed.map((x) => x.name).join());

  const cp = await fetch(`${base}/c/${fakeFolder}`);
  ok('클립 페이지는 암호 없이 200 (갤러리와 같은 경계)', cp.status === 200, String(cp.status));
  const cpHtml = await cp.text();
  ok('클립 페이지에 재생기', cpHtml.includes('<video'));
  ok('클립 페이지에 받기 링크', cpHtml.includes(`/cdl/${fakeFolder}/`));
  ok('클립 페이지에 반쪽 파일이 안 보임', !cpHtml.includes('.part'));

  const cf = await fetch(`${base}/clip/${fakeFolder}/${encodeURIComponent(fakeName)}`);
  ok('클립 파일 200', cf.status === 200, String(cf.status));
  ok('mp4 로 내려옴', (cf.headers.get('content-type') ?? '').includes('mp4'), cf.headers.get('content-type') ?? '');
  await cf.arrayBuffer();
  // Range 가 안 되면 브라우저에서 재생 중 건너뛰기가 안 된다.
  const rg = await fetch(`${base}/clip/${fakeFolder}/${encodeURIComponent(fakeName)}`, { headers: { Range: 'bytes=0-1023' } });
  ok('Range 요청 지원 (206) — 재생 중 건너뛰기', rg.status === 206, String(rg.status));
  await rg.arrayBuffer();

  const noKey = await fetch(`${base}/api/clip-delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: fakeFolder, files: [fakeName] }),
  });
  ok('클립 삭제: 암호 없으면 401', noKey.status === 401, String(noKey.status));
  const withKey = await fetch(`${base}/api/clip-delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ folder: fakeFolder, files: [fakeName] }),
  });
  ok('클립 삭제: 맞는 암호면 200', withKey.status === 200, String(withKey.status));
  ok('클립이 실제로 지워짐', !fs.existsSync(clips.filePath(fakeFolder, fakeName)));

  // 상한을 넘기면 오래된 것부터 지운다.
  for (let i = 0; i < 25; i++) {
    fs.writeFileSync(clips.filePath(fakeFolder, `p${i}.mp4`), Buffer.alloc(64));
  }
  const pruned = await clips.pruneClips(fakeFolder);
  ok('세션당 클립 개수 상한이 걸림', pruned >= 5 && (await clips.listClips(fakeFolder)).length <= 20, `${pruned}개 지움`);

  // ── 예산으로 자동 정리 — **사용자 데이터를 지우는 코드다** ──
  //
  // 안전장치가 실제로 동작하는지 본다. 안 하면 "정리했다" 는 로그만 남고
  // 방금 만든 클립이 사라진다.
  {
    const now = Date.now();
    const budget = config.stream.clipMaxGb * 1024 ** 3;
    // 예산을 넘기려면 큰 파일이 필요하다. 실제로 5GB 를 쓸 수는 없으니
    // 예산을 잠깐 아주 작게 만들어 검사한다.
    const savedGb = process.env.STREAM_CLIP_MAX_GB;
    void budget;

    const oldFolder = 'old111';
    const newFolder = 'new111';
    fs.mkdirSync(clips.folderPath(oldFolder), { recursive: true });
    fs.mkdirSync(clips.folderPath(newFolder), { recursive: true });
    // 오래된 것 (보호 기간을 넘김) / 방금 만든 것
    const oldFile = clips.filePath(oldFolder, 'a.mp4');
    const newFile = clips.filePath(newFolder, 'b.mp4');
    fs.writeFileSync(oldFile, Buffer.alloc(2 * 1024 * 1024));
    fs.writeFileSync(newFile, Buffer.alloc(2 * 1024 * 1024));
    const longAgo = new Date(now - 30 * 86400_000);
    fs.utimesSync(oldFile, longAgo, longAgo);

    // config 는 import 시점에 굳으므로 값을 바꿔 다시 읽어야 한다.
    // 여기서는 그럴 수 없으니 **함수의 동작**을 순서로 검사한다.
    const res = await clips.cleanupByBudget();
    ok('예산 안이면 아무것도 안 지움', res.deleted.length === 0, `${res.deleted.length}개`);
    ok('현재 용량을 셈', res.bytes >= 4 * 1024 * 1024, clips.fmtBytes(res.bytes));
    ok('예산을 함께 돌려줌', res.budget === config.stream.clipMaxGb * 1024 ** 3);
    ok('방금 만든 클립이 남아 있음', fs.existsSync(newFile));
    ok('오래된 클립도 예산 안이면 남아 있음', fs.existsSync(oldFile));
    void savedGb;

    const src = fs.readFileSync('./src/stream/clips.js', 'utf8');
    // 안전장치 1: 최근 것 보호. 이걸 없애면 방금 만든 클립이 사라진다.
    ok('최근 클립 보호 (min keep days)', src.includes('clipMinKeepDays') && src.includes('c.mtime > keepAfter'));
    ok('보호 때문에 못 지운 개수를 셈 (알려줘야 함)', src.includes('blockedByAge++'));
    // 안전장치 2: 예산의 80% 까지. 경계선에서 매번 재실행되는 것을 막는다.
    ok('예산의 일부까지 내려감 (경계선 재실행 방지)', src.includes('clipCleanupTargetPercent'));
    ok('오래된 것부터 지움', src.includes('all.sort((a, b) => a.mtime - b.mtime)'));
    // ⚠️ 사진 예산과 **따로** 둬야 한다. 합치면 클립이 늘 때 사진이 지워진다.
    //    (주석으로 참조하는 건 괜찮다 — import 하거나 사진 예산을 읽는 것이 문제다)
    ok('사진 코드를 import 하지 않음', !/^import .*images\//m.test(src), '주석 참조는 괜찮음');
    ok('사진 예산(IMAGE_MAX_GB)을 읽지 않음', !src.includes('IMAGE_MAX_GB'));
    ok('클립 예산은 따로 (STREAM_CLIP_MAX_GB)', config.stream.clipMaxGb > 0 && src.includes('clipMaxGb'));

    const si2 = fs.readFileSync('./src/stream/index.js', 'utf8');
    // 안전장치 3: 조용히 사라지면 안 된다.
    ok('지운 것을 디스코드에 알림', si2.includes('클립 용량 정리') && si2.includes('announceCleanup'));
    // 어느 서버에 알릴지는 세션이 알려준다. 못 찾으면 짐작하지 말고 로그로.
    ok('알릴 서버는 세션에서 찾음', si2.includes("sessionById(c.folder)?.guildId"));
    ok('못 찾으면 짐작하지 않고 로그만', si2.includes('세션 기록이 없어 알리지 못했습니다'));
    ok('예산을 넘겼는데 못 지우면 그 사실을 남김', si2.includes('보호 때문에'));
    ok('자동 정리를 끌 수 있음', si2.includes('STREAM_CLIP_AUTO_CLEANUP=false'));

    const idx2 = fs.readFileSync('./src/index.js', 'utf8');
    ok('켤 때 클립 정리를 시작', idx2.includes('startClipCleanup(c)'));

    fs.rmSync(clips.folderPath(oldFolder), { recursive: true, force: true });
    fs.rmSync(clips.folderPath(newFolder), { recursive: true, force: true });
  }

  // 요약판에 클립이 반영되는가
  st2.addClip(cs, { markId: cm.id, userId: 'u1', file: fakeName, startSec: 45, endSec: 60, title: '테스트 장면' });
  const withClip = pn2.buildSummary(cs, cStream).at(-1);
  const wcJson = JSON.stringify(withClip.components.map((r) => r.toJSON()));
  ok('만든 마킹에 ✅ 표시', wcJson.includes('✅'));
  ok('요약판에 [클립 보기] 링크', wcJson.includes(`/c/${cs.id}`));

  // 마킹이 25개를 넘으면 드롭다운을 나눠야 한다 (디스코드 제한).
  for (let i = 0; i < 30; i++) {
    const m = st2.addMark(cs, 'u1');
    m.at = st2.nowSec() - 3000 + i;
  }
  const paged = pn2.buildSummary(cs, cStream, 0).at(-1);
  const pagedJson = JSON.parse(JSON.stringify(paged.components.map((r) => r.toJSON())));
  const opts = pagedJson.flatMap((r) => r.components).find((c) => c.type === 3)?.options ?? [];
  ok('드롭다운은 25개까지만', opts.length === 25, `${opts.length}개`);
  ok('넘치면 쪽 넘기기 버튼이 생김',
    pagedJson.flatMap((r) => r.components).some((c) => String(c.custom_id ?? '').startsWith('tm:cpage:')));

  // 지난 방송의 요약판을 다시 부를 길 (종료 뒤 클립으로 가는 유일한 입구가 밀려 올라가므로)
  st2.closeSession(cs);
  const sp = pn2.buildSessionPicker('gc');
  ok('지난 방송 요약판 다시 올리기 드롭다운', Boolean(sp) && JSON.stringify(sp.toJSON()).includes('tm:resum'));
  ok('지난 방송이 없으면 드롭다운도 없음', pn2.buildSessionPicker('없는서버') === null);

  // ── 구글 드라이브 업로드 (선택 기능) ──
  //
  // ⚠️ **이 검사는 "우리 코드가 의도한 요청을 만드는가" 만 봅니다.**
  //    구글이 그 요청을 받아주는지는 **확인되지 않았습니다** — 자격증명이 필요합니다.
  //    다른 기능들(yt-dlp 구간 추출, 고정 주소 해석)은 실제로 돌려보고 만들었지만
  //    이건 그러지 못했습니다. docs/게임방송-기획.md 7절.
  //
  // ⚠️ **실제 구글 API 를 부르지 않습니다.** fetch 를 가로챕니다.
  //    (제미나이 검사에서 실제 API 를 불러 소유자의 무료 한도를 쓴 적이 있습니다)
  {
    const drive = await import('./src/stream/drive.js');
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (u.includes('/upload/drive/v3/files')) {
        return new Response(JSON.stringify({ id: 'FILEID' }), { status: 200 });
      }
      if (u.includes('/permissions')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    };

    try {
      // 키가 없으면 조용히 꺼지고, 무엇이 빠졌는지 알려줘야 한다.
      ok('키가 없으면 기능이 꺼짐', drive.enabled() === false);
      const miss = drive.missingConfigMessage();
      ok('무엇이 빠졌는지 알려줌', miss.includes('GDRIVE_CLIENT_ID') && miss.includes('GDRIVE_REFRESH_TOKEN'));
      ok('안 해도 된다고 알려줌', miss.includes('설정하지 않아도 됩니다'));
      ok('키가 없으면 올리려 해도 막힘',
        await drive.uploadClip('x', 'y').then(() => false, (e) => e.expected === true));
      ok('키가 없을 때는 구글을 부르지 않음', calls.length === 0, `${calls.length}회 호출`);

      // 키가 있는 것처럼 만들어 요청 모양을 본다.
      const { config: dcfg } = await import('./src/config.js');
      Object.assign(dcfg.drive, {
        clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', folderId: 'FOLDER', shareAnyone: true,
      });
      drive.resetTokenCache();
      ok('키가 있으면 켜짐', drive.enabled() === true);

      const tmp = `${clips.baseDir()}/dtest.mp4`;
      fs.mkdirSync(clips.baseDir(), { recursive: true });
      fs.writeFileSync(tmp, Buffer.alloc(1024, 7));
      const up = await drive.uploadClip(tmp, '테스트.mp4');

      const token = calls.find((c) => c.url.includes('oauth2'));
      const upload = calls.find((c) => c.url.includes('/upload/'));
      const perm = calls.find((c) => c.url.includes('/permissions'));

      ok('refresh_token 으로 access_token 을 받음',
        String(token.opts.body).includes('grant_type=refresh_token'));
      ok('multipart 업로드', upload.url.includes('uploadType=multipart'));
      ok('공유 드라이브도 지원', upload.url.includes('supportsAllDrives=true'));
      ok('Bearer 토큰을 붙임', upload.opts.headers.Authorization === 'Bearer tok');
      const boundary = upload.opts.headers['Content-Type'].match(/boundary=(\S+)/)[1];
      const body = Buffer.from(upload.opts.body).toString('latin1');
      ok('본문이 헤더의 경계를 씀', body.startsWith(`--${boundary}\r\n`) && body.endsWith(`--${boundary}--\r\n`));
      ok('메타데이터에 폴더를 넣음', body.includes('"parents":["FOLDER"]'));
      ok('파일 바이트가 본문에 들어감', Buffer.from(upload.opts.body).length > 1024);
      ok('링크 공개를 따로 요청', Boolean(perm) && String(perm.opts.body).includes('"type":"anyone"'));
      ok('드라이브 링크를 돌려줌', up.link === 'https://drive.google.com/file/d/FILEID/view', up.link);

      // 토큰은 캐시해야 한다. 업로드마다 왕복이 하나 늘어나면 안 된다.
      const before = calls.filter((c) => c.url.includes('oauth2')).length;
      await drive.uploadClip(tmp, '두번째.mp4');
      ok('토큰을 캐시함 (업로드마다 다시 받지 않음)',
        calls.filter((c) => c.url.includes('oauth2')).length === before);

      // 실패하면 **구글이 한 말을 그대로** 보여줘야 한다. 원인을 지어내면 안 된다. (3.1-4)
      globalThis.fetch = async (url) =>
        String(url).includes('oauth2')
          ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
          : new Response('{}', { status: 200 });
      drive.resetTokenCache();
      const err = await drive.uploadClip(tmp, 'x.mp4').then(() => null, (e) => e.message);
      ok('인증 실패 시 구글 원문을 보여줌', err.includes('invalid_grant'));
      ok('만료된 토큰이면 다시 받으라고 안내', err.includes('GDRIVE_REFRESH_TOKEN'));

      fs.unlinkSync(tmp);
      Object.assign(dcfg.drive, { clientId: '', clientSecret: '', refreshToken: '' });
      drive.resetTokenCache();
    } finally {
      globalThis.fetch = realFetch;
    }

    // ★ 가장 중요한 안전장치: **로컬 파일을 지우지 않는다.**
    //   올렸다고 해놓고 반쪽만 갔을 때 원본까지 지우면 되돌릴 방법이 없다.
    const dsrc = fs.readFileSync('./src/stream/drive.js', 'utf8');
    ok('드라이브가 로컬 파일을 지우지 않음 (사본만 올림)',
      !/unlink|\brm\b|GDRIVE_DELETE_LOCAL/.test(dsrc));
    ok('검증하지 못했다는 사실을 파일 머리에 적어둠', dsrc.includes('실제 구글 API 로 검증하지 못했습니다'));
    ok('googleapis 의존성을 늘리지 않음',
      !JSON.parse(fs.readFileSync('./package.json', 'utf8')).dependencies.googleapis);
    const si4 = fs.readFileSync('./src/stream/index.js', 'utf8');
    ok('업로드가 실패해도 클립은 남는다고 알려줌', si4.includes('클립은 서버에 그대로 있습니다'));
    ok('설정이 없으면 업로드를 시도하지 않음', si4.includes('if (driveEnabled())'));
  }

  fs.rmSync(clips.baseDir(), { recursive: true, force: true });
}

// 6u) 투표
{
  const poll = await import('./src/poll/index.js');
  await poll.initPolls();

  // 선택지는 한 칸에 쉼표로 씁니다. 칸을 열 개 만들면 아무도 안 씁니다.
  ok('쉼표로 나눔', JSON.stringify(poll.parseOptions('피자, 치킨, 초밥')) === JSON.stringify(['피자', '치킨', '초밥']));
  ok('줄바꿈으로 써도 됨', poll.parseOptions('피자\n치킨').length === 2);
  ok('빈 칸·공백은 버림', JSON.stringify(poll.parseOptions('피자,  , 치킨,')) === JSON.stringify(['피자', '치킨']));
  ok('10개까지만', poll.parseOptions(Array.from({ length: 15 }, (_, i) => `항목${i}`).join(',')).length === 10);

  const make = (n) => ({
    question: '점심 뭐?',
    options: Array.from({ length: n }, (_, i) => ({ label: `선택${i + 1}`, image: null })),
    votes: {},
    createdBy: 'u0',
    closed: false,
    createdAt: Date.now(),
  });

  const p = make(3);
  p.votes = { a: 0, b: 0, c: 1 };
  const { counts, total } = poll.tally(p);
  ok('표 세기', counts[0] === 2 && counts[1] === 1 && counts[2] === 0 && total === 3, counts.join('/'));

  const built = poll.buildPoll(p);
  const json = JSON.stringify(built.components.map((r) => r.toJSON()));
  ok('선택지마다 버튼', json.includes('"v:0"') && json.includes('"v:1"') && json.includes('"v:2"'));
  ok('마감 버튼', json.includes('"v:close"'));
  ok('결과가 임베드에 보임', JSON.stringify(built.embeds[0].toJSON()).includes('2표'));

  // 사진이 있는 선택지는 임베드를 하나 더 붙입니다. 첨부를 그대로 참조하면
  // 주소가 만료되므로 **투표 메시지에 다시 올린 파일**(attachment://)을 씁니다.
  const withImg = make(2);
  withImg.options[0].image = 'poll-1.png';
  const imgJson = JSON.stringify(poll.buildPoll(withImg).embeds.map((e) => e.toJSON()));
  ok('사진은 attachment:// 로 참조', imgJson.includes('attachment://poll-1.png'));
  // ★ 모바일에서는 썸네일을 눌러도 확대되지 않습니다. 큰 이미지여야 합니다.
  ok('선택지 사진은 눌러서 크게 볼 수 있어야 함 (썸네일 금지)',
    imgJson.includes('"image":{"url":"attachment://poll-1.png"') && !imgJson.includes('thumbnail'));
  ok('사진 있는 선택지만 임베드 추가', poll.buildPoll(withImg).embeds.length === 2);
  const src2 = fs.readFileSync('./src/poll/index.js', 'utf8');
  ok('첨부를 다시 올림 (주소 만료 대비)', src2.includes('new AttachmentBuilder(att.url'));

  // 질문에도 사진을 붙일 수 있습니다. 선택지 사진과 **파일 이름이 겹치면 안 됩니다.**
  const withQ = { ...make(2), image: 'poll-q.png' };
  withQ.options[0].image = 'poll-1.png';
  const qj = JSON.stringify(poll.buildPoll(withQ).embeds.map((e) => e.toJSON()));
  ok('질문 사진은 크게 (image)', qj.includes('"image":{"url":"attachment://poll-q.png"'));
  ok('선택지 사진도 큰 이미지 (모바일에서 확대 가능)', qj.includes('"image":{"url":"attachment://poll-1.png"'));
  ok('질문 사진 이름이 선택지와 안 겹침', src2.includes('index < 0 ? `poll-q${ext}`'));

  // ★ 만들기 창(모달). 슬래시 명령어 칸이 일곱 개라 헷갈린다는 피드백으로 바꿨습니다.
  //   모달에 **파일 업로드 칸**을 넣을 수 있어서 사진까지 한 화면에서 받습니다.
  const modal = poll.buildCreateModal().toJSON();
  ok('만들기 창이 v:new', modal.custom_id === 'v:new');
  ok('창은 5칸 (디스코드 한도와 같음 — 더 못 늘림)', modal.components.length === 5, `${modal.components.length}칸`);
  const inner = modal.components.map((c) => c.component ?? {});
  ok('질문·선택지는 글자 칸', inner[0].custom_id === 'q' && inner[1].custom_id === 'opts');
  ok('질문 사진 칸 (한 장)', inner[2].custom_id === 'qimg' && inner[2].max_values === 1);
  ok('선택지 사진 칸 (여러 장)', inner[3].custom_id === 'imgs' && inner[3].max_values === 5);
  ok('사진은 안 넣어도 됨', inner[2].required === false && inner[3].required === false);
  ok('모달 제출이 index 에 연결됨',
    fs.readFileSync('./src/index.js', 'utf8').includes('interaction.isModalSubmit()') &&
    fs.readFileSync('./src/index.js', 'utf8').includes('handlePollModal(interaction)'));

  // 창이 안 뜨는 환경이 있을 때를 대비해 인자로도 만들 수 있어야 합니다.
  const cmd = poll.commands[0].data.toJSON();
  ok('/투표 는 칸을 비우면 창이 뜸', cmd.options.every((o) => o.required !== true), '필수 인자 없음');
  ok('인자로도 만들 수 있음 (창이 안 될 때 대비)', cmd.options.length === 3,
    cmd.options.map((o) => o.name).join(' '));

  // ── 자동 마감 ──
  // 켜고 끄는 스위치를 따로 두지 않았습니다. 비우면 안 함 = off.
  ok('마감 분 읽기', poll.parseMinutes('30') === 30 && poll.parseMinutes('30분') === 30 &&
    poll.parseMinutes(' 45 ') === 45);
  ok('비우면 자동 마감 안 함', poll.parseMinutes('') === null && poll.parseMinutes(null) === null &&
    poll.parseMinutes('abc') === null);
  ok('0분은 안 함 (즉시 마감은 실수일 뿐)', poll.parseMinutes('0') === null);
  ok('상한을 넘기면 잘림 (7일)', poll.parseMinutes('99999') === poll.CLOSE_MAX_MINUTES);
  ok('창에 자동 마감 칸', inner[4].custom_id === 'close' && inner[4].required === false);
  ok('명령어에도 자동마감', cmd.options.some((o) => o.name === '자동마감'));

  const timed = { ...make(2), closesAt: 1800000000000 };
  const timedJson = JSON.stringify(poll.buildPoll(timed).embeds[0].toJSON());
  // 디스코드 시각 표시는 **본문에서만** 렌더링됩니다. 푸터에 넣으면 <t:...> 가 그대로 보입니다.
  ok('언제 닫히는지 본문에 보임', timedJson.includes('<t:1800000000:R>'));
  ok('푸터에는 넣지 않음', !JSON.stringify(poll.buildPoll(timed).embeds[0].toJSON().footer ?? {}).includes('<t:'));

  const autoClosed = { ...timed, closed: true, closedAuto: true };
  const acJson = JSON.stringify(poll.buildPoll(autoClosed).embeds[0].toJSON());
  ok('자동으로 닫혔음을 표시', acJson.includes('자동 마감'));
  ok('닫힌 뒤엔 남은 시간 안 보임', !acJson.includes('<t:'));

  // setTimeout 은 재시작하면 사라집니다. 마감 시각을 저장해두고 켜질 때 다시 걸어야 합니다.
  ok('마감 시각을 저장함', src2.includes('closesAt:'));
  ok('메시지를 다시 찾을 수 있게 채널도 저장', src2.includes('channelId: interaction.channelId'));
  ok('재시작하면 예약을 되살림', typeof poll.restorePollDeadlines === 'function' &&
    fs.readFileSync('./src/index.js', 'utf8').includes('restorePollDeadlines(c)'));
  ok('손으로 마감하면 예약을 취소', src2.includes('cancelClose(interaction.message.id)'));

  // 10개면 버튼이 두 줄로 나뉘어야 합니다 (한 줄에 5개 제한)
  const big = poll.buildPoll(make(10));
  ok('버튼은 한 줄에 5개까지', big.components.length === 3, `${big.components.length}줄`);
  for (const row of big.components) {
    if (row.toJSON().components.length > 5) ok('한 줄 5개 초과', false);
  }

  // 마감하면 누를 수 없어야 합니다
  const closed = make(2);
  closed.closed = true;
  const cj = JSON.stringify(poll.buildPoll(closed).components.map((r) => r.toJSON()));
  ok('마감하면 버튼이 잠김', cj.includes('"disabled":true') && !cj.includes('"v:close"'));

  // 재시작을 견뎌야 합니다 (버튼은 메시지에 계속 남아 있으므로)
  ok('저장 완료를 기다릴 수 있음', typeof poll.flushPolls === 'function');
  ok('버튼 앞머리가 index 에 등록됨', fs.readFileSync('./src/index.js', 'utf8').includes("startsWith('v:')"));
  ok('/기능 으로 끌 수 있음', (await import('./src/settings.js')).FEATURES.poll !== undefined);

  fs.rmSync('./data/verify-data/polls.json', { force: true });
}

// 6v) 영화 고르기
{
  const tmdb = await import('./src/movie/tmdb.js');
  const mv = fs.readFileSync('./src/movie/index.js', 'utf8');

  // ★ provider ID 는 추측하면 안 됩니다. 기획안은 쿠팡플레이를 356 으로 적었는데
  //   356 은 실제로 wavve 입니다. 아래는 2026-09-01 실측값입니다.
  const byName = Object.fromEntries(tmdb.PROVIDERS.map((p) => [p.name, p.id]));
  ok('넷플릭스 = 8', byName['넷플릭스'] === 8);
  ok('쿠팡플레이 = 1881 (356 아님)', byName['쿠팡플레이'] === 1881, String(byName['쿠팡플레이']));
  ok('356 은 wavve', byName['wavve'] === 356);
  ok('TVING = 1883', byName['TVING'] === 1883);
  const coupang = tmdb.PROVIDERS.find((p) => p.id === 1881);
  ok('쿠팡플레이는 자료 부족 표시', coupang?.sparse === true);
  // TMDB 에서 쿠팡플레이는 **볼 수 있는 곳(provider 1881)** 과 **만든 곳(network 5169)** 둘로 존재합니다.
  // provider 로는 드라마 8건뿐이지만 network 로는 31건입니다. 오리지널은 거기서 볼 수 있으므로 보탭니다.
  ok('쿠팡플레이는 network 로 보강', coupang?.network === 5169);
  ok('network 조회가 실제로 붙어 있음', fs.readFileSync('./src/movie/tmdb.js', 'utf8').includes('with_networks='));

  // 영화와 드라마는 장르 번호가 다릅니다. 섞어 뽑으므로 둘 다 들고 있어야 합니다.
  const action = tmdb.genreByKey('action');
  ok('액션은 영화·드라마 번호가 다름', action.movie === '28' && action.tv === '10759');
  ok('드라마에 없는 장르는 tv 가 null', tmdb.genreByKey('horror').tv === null);
  ok('장르 12개', tmdb.GENRES.length === 12, String(tmdb.GENRES.length));
  ok('장르 키 중복 없음', new Set(tmdb.GENRES.map((g) => g.key)).size === tmdb.GENRES.length);

  ok('포스터 주소 조립', tmdb.posterUrl('/a.jpg') === 'https://image.tmdb.org/t/p/w500/a.jpg');
  ok('포스터 없으면 null', tmdb.posterUrl(null) === null);
  ok('키 없으면 꺼둠 (봇 전체가 죽으면 안 됨)', typeof tmdb.hasKey === 'function' && mv.includes('if (!hasKey())'));
  ok('키 오류는 무엇을 할지까지 안내', tmdb.friendlyError(401).includes('TMDB_READ_TOKEN'));
  ok('요청 과다·서버 오류도 구분', tmdb.friendlyError(429).includes('잠시') && tmdb.friendlyError(503).includes('TMDB'));

  // ★ 명령어는 하나뿐이어야 합니다. 기획안의 /영화뽑기 + /영화투표 로 되돌리지 말 것.
  const movieCmds = (await import('./src/movie/index.js')).commands;
  ok('명령어는 /영화 하나뿐', movieCmds.length === 1 && movieCmds[0].data.toJSON().name === '영화');
  ok('/영화 는 칸이 없음 (전부 버튼)', (movieCmds[0].data.toJSON().options ?? []).length === 0);

  // 고른 값은 customId 에 싣습니다. 메모리 Map 에 두면 재시작에 날아갑니다.
  ok('고른 값을 customId 에 실음', mv.includes('mv:draw:${gk}:${gp}') && mv.includes('function parseId('));
  ok('상태를 메모리에 두지 않음', !/new Map\(\)/.test(mv));
  ok('customId 가 100자 제한 안에 들어감',
    `mv:again:documentary:${tmdb.PROVIDERS.map((p) => p.id).join(',')}:tv-999999`.length < 100);

  ok('다시 뽑기는 직전 것만 제외', mv.includes('it.id !== extra'));
  ok('포스터는 크게 (모바일에서 확대 가능)', mv.includes('embed.setImage(item.poster)'));
  ok('투표는 기존 것을 재사용', mv.includes('createPoll(') && !mv.includes('votes: {}'));
  ok('포스터 없는 후보는 투표에서 제외', mv.includes('list.filter((it) => it.poster)'));
  ok('결과 0건이면 무엇을 바꿀지 안내', mv.includes('조건에 맞는 작품이 없어요') && mv.includes('영화 정보가 없습니다'));

  // 서버마다 쓰는 OTT 를 고릅니다. 안 고르면 전체.
  const st2 = await import('./src/settings.js');
  const G = 'movieguild';
  ok('설정 전에는 전체', st2.movieProviders(G).length === 0);
  st2.setMovieProviders(G, [8, 1883, 8]);
  ok('중복은 걸러짐', JSON.stringify(st2.movieProviders(G)) === JSON.stringify([8, 1883]));
  st2.setMovieProviders(G, []);
  ok('비우면 전체로 되돌아감', st2.movieProviders(G).length === 0);
  ok('/기능 으로 끌 수 있음', st2.FEATURES.movie !== undefined);

  const ix2 = fs.readFileSync('./src/index.js', 'utf8');
  ok('버튼 앞머리 mv: 등록', ix2.includes("startsWith('mv:')") && ix2.includes('handleMovieComponent'));
  ok('시작할 때 OTT 번호 대조', ix2.includes('checkProviders()'));
}

// 6w) 일정 · 정산
{
  const pw = await import('./src/plan/parse-when.js');
  const pl = fs.readFileSync('./src/plan/index.js', 'utf8').replace(/\r\n/g, '\n');
  const now = new Date(2026, 8, 1, 12, 0); // 2026-09-01 12:00
  const p2 = (n) => String(n).padStart(2, '0');
  const fmt = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };

  // 소유자 결정: 날짜는 직접 적는다. "이번 주말" 해석기는 만들지 않는다.
  // 대신 **적어둔 날짜를 관대하게** 읽어야 한다.
  const whenCases = [
    ['2026-10-03 18:30', '2026-10-03 18:30'],
    ['2026.10.3 오후 6시 30분', '2026-10-03 18:30'],
    ['10/3 18:30', '2026-10-03 18:30'],
    ['10월 3일 오후 6시', '2026-10-03 18:00'], // 치환하면 "10- 3" 이 되어 끊기던 버그
    ['10-3', '2026-10-03 00:00'],
    ['내일 19시', '2026-09-02 19:00'],
    ['오늘 저녁 7시', '2026-09-01 19:00'],
    ['251003', '2025-10-03 00:00'], // 채널 이름 형식을 그대로 적는 사람이 있다
    ['12/25 오전 9시', '2026-12-25 09:00'],
    ['1/5', '2027-01-05 00:00'], // ★ 연도를 안 적었으면 가장 가까운 미래
    ['2026-02-30', null], // 없는 날짜
    ['10/3 25:00', null],
    ['13/1', null],
    ['', null],
    ['아무말', null],
  ];
  const whenBad = whenCases.filter(([input, want]) => {
    const r = pw.parseWhen(input, now);
    return (r ? fmt(r.at) : null) !== want;
  });
  ok('날짜 읽기', whenBad.length === 0, whenBad.map(([i]) => i).join(' / ') || `${whenCases.length}가지 확인`);
  ok('시간 안 적으면 종일', pw.parseWhen('10/3', now).hasTime === false && pw.parseWhen('10/3 9:00', now).hasTime === true);
  ok('표시 형식', pw.formatWhen(pw.parseWhen('10/3 18:30', now).at, true) === '10월 3일 (토) 오후 6:30',
    pw.formatWhen(pw.parseWhen('10/3 18:30', now).at, true));
  ok('채널 이름용 yymmdd', pw.yymmdd(pw.parseWhen('10/3', now).at) === '261003');

  // ── 일정표: 한 일정에 여러 곳 ──
  // `시간 이름 | 장소` — `|` 뒤가 지도에 검색됩니다.
  // "점심" 을 지도에 검색해봐야 소용이 없으므로 이름과 장소를 나눕니다.
  const base = pw.parseWhen('9/1', now).at;
  const stopCases = [
    ['12:00 점심 | 홍대 스시로', '12:00', '점심', '홍대 스시로'],
    ['오후 2시 카페 | 어니언 홍대', '14:00', '카페', '어니언 홍대'],
    ['16:00 방탈출', '16:00', '방탈출', null],
    ['14시 30분 산책', '14:30', '산책', null],
    // ★ 맨숫자를 시간으로 읽으면 "저녁 2차" 가 **오후 2시 "차"** 가 됩니다 (실제로 겪은 버그).
    ['저녁 2차', null, '저녁 2차', null],
    ['3차', null, '3차', null],
    ['점심 | 스시로', null, '점심', '스시로'],
    ['9:00 아침 | 카페 | 추가', '09:00', '아침', '카페 | 추가'],
  ];
  const stopBad = stopCases.filter(([line, wantT, wantN, wantP]) => {
    const [s] = pw.parseStops(line, base);
    const t = s.at === null ? null : `${p2(new Date(s.at).getHours())}:${p2(new Date(s.at).getMinutes())}`;
    return t !== wantT || s.name !== wantN || s.place !== wantP;
  });
  ok('일정표 한 줄 읽기', stopBad.length === 0, stopBad.map(([l]) => l).join(' / ') || `${stopCases.length}가지 확인`);

  // 나들이는 시간순으로 보는 게 당연합니다. 시간 없는 것은 적은 순서대로 맨 뒤.
  const sorted = pw.parseStops(['16:00 저녁', '12:00 점심', '2차', '14:00 카페'].join('\n'), base);
  ok('시간순 정렬, 시간 없는 건 맨 뒤',
    sorted.map((s) => s.name).join(',') === '점심,카페,저녁,2차', sorted.map((s) => s.name).join(','));

  // 고치기 창에 다시 채워 넣을 수 있어야 합니다 (되돌려 읽어도 같아야 함).
  const roundTrip = pw.stopsToText(sorted);
  ok('되돌려 읽어도 같음',
    pw.stopsToText(pw.parseStops(roundTrip, base)) === roundTrip, JSON.stringify(roundTrip));
  ok('빈 일정표는 빈 배열', pw.parseStops('', base).length === 0 && pw.parseStops(null, base).length === 0);

  // 이미 채널 이름에 적어둔 것을 또 타이핑하지 않게 합니다.
  const titleCases = [
    ['[251003-오사카]', '오사카'],
    ['251003-오사카', '오사카'],
    ['251003_제주도 여행', '제주도 여행'],
    ['251003-스타필드-하남', '스타필드 하남'],
    ['오사카', '오사카'],
  ];
  ok('채널 이름에서 제목 뽑기',
    titleCases.every(([input, want]) => pw.titleFromChannelName(input) === want),
    titleCases.map(([i]) => `${i}→${pw.titleFromChannelName(i)}`).join(' '));

  // 지도는 좌표도 API 키도 필요 없습니다. 검색어만 넣으면 됩니다 (2026-09-01 실측).
  const { kakaoMapUrl, naverMapUrl } = await import('./src/plan/index.js');
  ok('카카오맵 주소', kakaoMapUrl('스타필드 하남') === 'https://map.kakao.com/?q=' + encodeURIComponent('스타필드 하남'));
  ok('네이버지도 주소', naverMapUrl('스타필드 하남') === 'https://map.naver.com/p/search/' + encodeURIComponent('스타필드 하남'));
  ok('장소를 그대로 넘기지 않고 인코딩', kakaoMapUrl('강남 & 역삼').includes('%26'));
  const { ButtonBuilder, ButtonStyle } = await import('discord.js');
  ok('지도는 링크 버튼으로 쓸 수 있음', (() => {
    try {
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('x').setURL(kakaoMapUrl('테스트')).toJSON();
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('x').setURL(naverMapUrl('테스트')).toJSON();
      return true;
    } catch { return false; }
  })());

  // 판: 할 일 버튼은 한 줄에 5개, 두 줄까지. 넘치면 조용히 자르지 말고 알려야 합니다.
  const { buildPanel } = await import('./src/plan/index.js');
  const mkPlan = (n) => ({
    title: '홍대 나들이', at: pw.parseWhen('10/3', now).at, hasTime: false,
    stops: pw.parseStops(
      ['12:00 점심 | 홍대 스시로', '오후 2시 카페 | 어니언 홍대', '16:00 방탈출'].join('\n'),
      pw.parseWhen('10/3', now).at
    ),
    todos: Array.from({ length: n }, (_, i) => ({ text: `할일${i}`, doneBy: i === 0 ? 'u1' : null })),
    notes: ['체크인 15시'], refs: [{ label: '숙소', url: 'https://discord.com/channels/1/2/3' }],
    panelMessageId: null, remindAt: null, createdBy: 'u1',
  });
  const panel3 = buildPanel(mkPlan(3));
  const pj = JSON.stringify(panel3.components.map((r) => r.toJSON()));
  const pe = JSON.stringify(panel3.embeds[0].toJSON());

  // ★ **한 일정에 여러 곳.** 지도는 버튼이 아니라 **링크 글자**입니다 —
  //   항목마다 버튼 2개를 달면 3곳만 돌아도 줄 한도(5줄)를 잡아먹습니다.
  ok('일정표가 여러 곳을 보여줌', pe.includes('일정표') && pe.includes('점심') && pe.includes('카페') && pe.includes('방탈출'));
  ok('곳마다 지도 링크', (pe.match(/map.kakao.com/g) ?? []).length === 2 && pe.includes('map.naver.com'));
  ok('지도는 버튼이 아니라 링크 글자', !pj.includes('map.kakao.com'));

  // ★ 길찾기: 첫 곳은 **도착지만**, 두 번째부터는 **이전 장소가 출발지**.
  //   카카오·네이버는 이름만으로 길찾기 칸을 못 채웁니다 (브라우저로 직접 확인).
  //   그래서 길찾기만 구글을 쓰고, 장소 보기는 카카오·네이버로 둡니다.
  const { directionsUrl } = await import('./src/plan/index.js');
  ok('첫 곳은 출발지 없음 (현재 위치에서)',
    directionsUrl('A') === 'https://www.google.com/maps/dir/?api=1&destination=A');
  ok('둘째부터 이전 장소가 출발지',
    directionsUrl('B', 'A').includes('origin=A') && directionsUrl('B', 'A').includes('destination=B'));
  ok('판에 길찾기 링크가 순서대로', (() => {
    const d = panel3.embeds[0].toJSON().description;
    const dirs = [...d.matchAll(/maps\/dir\/\?([^)]+)/g)].map((m) => decodeURIComponent(m[1]));
    // 점심(첫 곳) → 출발지 없음 / 카페 → 점심 장소가 출발지 / 방탈출 → 카페 장소가 출발지
    return (
      dirs.length === 2 &&
      !dirs[0].includes('origin=') &&
      dirs[1].includes('origin=홍대+스시로')
    );
  })(), JSON.stringify([...panel3.embeds[0].toJSON().description.matchAll(/maps\/dir\/\?([^)]+)/g)].map((m) => decodeURIComponent(m[1]))));
  ok('장소를 인코딩해서 넘김', directionsUrl('강남 & 역삼').includes('%26'));
  ok('장소 없는 항목도 됨', pe.includes('방탈출'));
  ok('할 일 토글 버튼', pj.includes('"pl:todo:0"') && pj.includes('"pl:todo:2"'));
  ok('조작 버튼', ['pl:edit', 'pl:addtodo', 'pl:note', 'pl:remind', 'pl:del'].every((id) => pj.includes(`"${id}"`)));

  // 삭제: **일정만** 과 **채널까지** 를 분명히 갈라놓아야 합니다.
  // 섞어놓으면 사진과 대화가 통째로 날아갑니다.
  ok('삭제는 확인을 거침', pl.includes("action === 'del'") && pl.includes('pl:delplan') && pl.includes('pl:delch'));
  ok('일정만 / 채널까지 를 나눔', pl.includes('일정만 지우기') && pl.includes('채널까지 지우기'));
  ok('되돌릴 수 없다고 경고', pl.includes('되돌릴 수 없습니다'));
  ok('만든 사람·채널관리자만', pl.includes('function canManage(') && pl.includes('plan.createdBy'));
  ok('지울 때 판도 지움 (거짓말 방지)', /removePlan\(interaction\.channelId\)/.test(pl) && pl.includes('m.delete()'));
  ok('채널 관리 권한 없으면 기록만 지우고 알림', pl.includes('채널은 못 지웠습니다'));
  ok('참고자료는 링크로만 (다시 안 올림)',
    JSON.stringify(panel3.embeds[0].toJSON()).includes('discord.com/channels') && !pl.includes('AttachmentBuilder'));

  const panel12 = buildPanel(mkPlan(12));
  ok('버튼 줄은 5줄 이내', panel12.components.length <= 5, `${panel12.components.length}줄`);
  ok('할 일 버튼은 10개까지', panel12.components.filter((r) => JSON.stringify(r.toJSON()).includes('pl:todo')).length === 2);
  ok('넘치면 조용히 자르지 않고 알림', JSON.stringify(panel12.embeds[0].toJSON()).includes('앞 10개만'));

  // 일정 하나 = 채널 하나. 일정 ID 를 따로 만들지 않습니다.
  const store = fs.readFileSync('./src/plan/store.js', 'utf8');
  ok('채널 ID 가 곧 일정 ID', store.includes('[channelId: string]: Plan'));
  ok('알림은 저장하고 재시작 때 되살림',
    store.includes('restoreReminders') && fs.readFileSync('./src/index.js', 'utf8').includes('restoreReminders(makeReminderFire(c))'));
  ok('지난 시각이면 알리지 않음', store.includes('if (delay <= 0)'));
  ok('setTimeout 한계보다 먼 알림도 처리', store.includes('MAX_TIMEOUT_MS'));

  // 채널 생성: 비공개 + 지정 카테고리 + 사람/역할
  ok('everyone 을 막고 참여자만 열어줌',
    pl.includes('deny: [PermissionFlagsBits.ViewChannel]') && pl.includes('guild.roles.everyone.id'));
  ok('사람과 역할 둘 다', pl.includes('UserSelectMenuBuilder') && pl.includes('RoleSelectMenuBuilder'));
  ok('만든 사람도 넣음 (안 넣으면 자기 채널을 못 봄)', pl.includes('id: interaction.user.id, allow'));
  ok('지정한 카테고리 밑에', pl.includes('parent: category.id') && pl.includes("getSetting(interaction.guildId, 'planCategoryId')"));
  ok('채널 관리 권한이 없으면 미리 알림', pl.includes('PermissionFlagsBits.ManageChannels'));
  ok('카테고리 설정 항목', (await import('./src/settings.js')).KEYS.planCategoryId?.kind === 'category');
  ok('/채널설정 이 카테고리를 받음',
    fs.readFileSync('./src/channel-commands.js', 'utf8').includes('CATEGORY_TYPES'));
  // ⚠️ `/채널설정` 의 채널 칸은 텍스트·음성·카테고리를 한 목록에 **섞어** 보여줍니다.
  //   디스코드가 "종류" 선택에 따라 목록을 바꿔주지 못합니다.
  //   그래서 /일정새로 는 **카테고리만** 나오는 드롭다운을 따로 씁니다.
  ok('카테고리를 안 정했으면 그 자리에서 고르게', pl.includes('ChannelSelectMenuBuilder') &&
    pl.includes('addChannelTypes(ChannelType.GuildCategory)'));
  ok('고른 뒤 바로 만들기 창으로', pl.includes("action === 'cat'") && pl.includes('buildCreateChannelModal()'));
  ok('카테고리 고르기는 일정이 없어도 동작', pl.indexOf("action === 'cat'") < pl.indexOf('const plan = getPlan(interaction.channelId);\n  if (!plan)'));

  // ★ 드롭다운은 종류가 여럿입니다 (글자·채널·사람·역할·멘션).
  //   isStringSelectMenu() 로 좁히면 **채널 고르기가 조용히 무시되고**
  //   "봇이 적시에 응답하지 않았어요" 가 뜹니다. 실제로 겪은 버그입니다.
  const ixSel = fs.readFileSync('./src/index.js', 'utf8');
  ok('모든 종류의 드롭다운을 받음', ixSel.includes('interaction.isAnySelectMenu()'));
  ok('String 만 보지 않음', !ixSel.includes('interaction.isButton() || interaction.isStringSelectMenu()'));

  // 자동 감지를 하지 않는 것이 요구사항입니다.
  ok('메시지 자동 감지 안 함', !fs.readFileSync('./src/index.js', 'utf8').includes('handlePlanMessage'));
  ok('우클릭으로 등록', pl.includes('ContextMenuCommandBuilder') && pl.includes('ApplicationCommandType.Message'));
  ok('우클릭 명령어가 라우팅됨', fs.readFileSync('./src/index.js', 'utf8').includes('isMessageContextMenuCommand()'));

  // ── 정산 ──
  const st3 = await import('./src/plan/settle.js');
  await st3.initSettlements();
  ok('숫자 하나면 균등분할', JSON.stringify(st3.parseAmounts('120000', 3)) === JSON.stringify([40000, 40000, 40000]));
  // 나누어떨어지지 않으면 총액이 어긋나면 안 되므로 앞사람이 1원씩 더 냅니다.
  const odd = st3.parseAmounts('100000', 3);
  ok('안 나누어떨어지면 총액을 지킴', odd.reduce((a, b) => a + b, 0) === 100000, odd.join('+'));
  ok('12만 도 읽음', JSON.stringify(st3.parseAmounts('12만', 2)) === JSON.stringify([60000, 60000]));
  ok('쉼표·원 도 읽음', JSON.stringify(st3.parseAmounts('120,000원', 2)) === JSON.stringify([60000, 60000]));
  ok('줄 수가 인원과 같으면 개별 금액',
    JSON.stringify(st3.parseAmounts('10000\n20000\n30000', 3)) === JSON.stringify([10000, 20000, 30000]));
  ok('개수가 안 맞으면 거부', st3.parseAmounts('10000\n20000', 3) === null);
  ok('금액을 못 읽으면 거부', st3.parseAmounts('', 3) === null && st3.parseAmounts('돈', 3) === null);

  // ★ 금액과 사람이 뒤바뀌던 버그. 소유자 보고:
  //   금액 `100`·`1000` + 사람 `A(본인)`·`B` → **A 에 1000, B 에 100** 이 붙었습니다.
  //
  //   원인: getSelectedUsers() 는 `resolved.users` **객체**를 훑어 만든 Collection 이라
  //   순서가 **디스코드가 그 객체를 어떤 순서로 내보냈는지**에 달려 있습니다.
  //   고른 순서가 담긴 것은 `values` **배열** 쪽입니다.
  {
    const A = '900000000000000000'; // 먼저 고른 사람 (ID 가 큼)
    const B = '100000000000000000';
    // values 는 고른 순서, Collection 은 그와 다른 순서인 상황을 만듭니다.
    const interaction = {
      fields: {
        getField: () => ({ values: [A, B] }),
        getSelectedUsers: () => new Map([[B, {}], [A, {}]]),
      },
    };
    ok('고른 순서(values)를 씀', JSON.stringify(st3.selectedUserIds(interaction, 'who')) === JSON.stringify([A, B]));

    // 금액이 고른 순서대로 붙는가 — 소유자가 겪은 그 조합 그대로
    const users = st3.selectedUserIds(interaction, 'who');
    const amounts = st3.parseAmounts('100\n1000', users.length);
    const shares = users.map((userId, i) => ({ userId, amount: amounts[i] }));
    ok('먼저 고른 사람에게 첫 금액', shares[0].userId === A && shares[0].amount === 100,
      `${shares[0].amount}원`);
    ok('두 번째 사람에게 두 번째 금액', shares[1].userId === B && shares[1].amount === 1000);

    // values 가 없으면(모양이 바뀌면) Collection 으로 물러나야 합니다 — 없는 것보다 낫습니다.
    const noValues = {
      fields: { getField: () => ({}), getSelectedUsers: () => new Map([[B, {}], [A, {}]]) },
    };
    ok('values 가 없으면 물러나서라도 동작',
      JSON.stringify(st3.selectedUserIds(noValues, 'who')) === JSON.stringify([B, A]));

    // ⚠️ 순서에 기대는 코드가 다시 getSelectedUsers 로 돌아가면 안 됩니다.
    const src = fs.readFileSync('./src/plan/settle.js', 'utf8');
    ok('정산은 selectedUserIds 로만 사람을 읽음',
      src.includes("const users = selectedUserIds(interaction, 'who');") &&
      !/const users = \[\.\.\.interaction\.fields\.getSelectedUsers/.test(src));
    // 고른 순서가 금액 순서라는 것을 **화면에도** 적어야 합니다. 안 보이면 확인할 수가 없습니다.
    ok('모달에 순서를 알려줌', src.includes('고른 순서대로 위 금액이 붙습니다'));
  }

  // ★ 정산 고치기 — **아무도 보냈다고 하지 않았을 때만** (소유자 요청)
  {
    const mk = (sent) => ({
      title: '숙소', payerId: 'p', total: 300,
      shares: [{ userId: 'p', amount: 100, sent: false }, { userId: 'a', amount: 200, sent }],
      createdAt: Date.now(),
    });
    ok('아무도 안 보냈으면 고칠 수 있음', st3.canEdit(mk(false)));
    // 누군가 보낸 뒤에 금액을 바꾸면 **보낸 금액과 목록이 어긋납니다.**
    ok('한 명이라도 보냈으면 못 고침', !st3.canEdit(mk(true)));

    const withBtn = JSON.stringify(st3.buildSettlement(mk(false)).components.map((r) => r.toJSON()));
    ok('고칠 수 있으면 버튼이 보임', withBtn.includes('st:edit'));
    const noBtn = JSON.stringify(st3.buildSettlement(mk(true)).components.map((r) => r.toJSON()));
    ok('못 고치면 버튼도 안 보임', !noBtn.includes('st:edit'));

    // 창이 조립되고, 지금 값이 채워져 있어야 합니다 (빈 칸으로 띄우면 다시 다 타이핑)
    const modal = st3.buildEditModal(mk(false), (id) => (id === 'p' ? '지예' : '민수')).toJSON();
    const mj = JSON.stringify(modal);
    ok('고치기 창이 조립됨', modal.custom_id === 'st:edit');
    ok('지금 금액이 채워져 있음', mj.includes('100\\n200'));
    ok('지금 내용이 채워져 있음', mj.includes('숙소'));
    // 어느 줄이 누구인지 보여줘야 합니다. 드롭다운은 순서를 안 보여줍니다.
    ok('금액 칸에 사람 순서를 적어줌', mj.includes('1. 지예') && mj.includes('2. 민수'));

    const src2 = fs.readFileSync('./src/plan/settle.js', 'utf8');
    ok('결제한 사람만 고칠 수 있음', src2.includes('결제한 사람만 고칠 수 있습니다'));
    // ⚠️ 창을 띄운 뒤 확인까지 몇 분이 걸릴 수 있습니다. 그 사이에 누가 보낼 수 있습니다.
    ok('확인할 때 다시 검사함',
      /handleEditSubmit[\s\S]{0,1200}?if \(!canEdit\(s\)\)/.test(src2));
    ok('사람과 순서는 건드리지 않음', src2.includes('s.shares.map((x, i) => ({ ...x, amount: amounts[i] }))'));
  }

  const settle = {
    title: '숙소', payerId: 'p', total: 120000,
    shares: [{ userId: 'p', amount: 40000, sent: false }, { userId: 'a', amount: 40000, sent: true },
             { userId: 'b', amount: 40000, sent: false }],
    createdAt: Date.now(),
  };
  const sj = JSON.stringify(st3.buildSettlement(settle).embeds[0].toJSON());
  ok('결제자는 송금 대상이 아님', sj.includes('(결제자)'));
  ok('보낸 사람만 표시', sj.includes('✅ 보냈어요') && sj.includes('⬜ 송금 전'));
  ok('받을 돈 합계', sj.includes('40,000원 / 80,000원'));
  const allSent = { ...settle, shares: settle.shares.map((x) => ({ ...x, sent: true })) };
  ok('전원 보내면 완료', JSON.stringify(st3.buildSettlement(allSent).embeds[0].toJSON()).includes('정산 완료'));
  ok('완료되면 버튼도 사라짐', st3.buildSettlement(allSent).components.length === 0);
  const sSrc = fs.readFileSync('./src/plan/settle.js', 'utf8');
  ok('본인 줄만 토글', sSrc.includes('x.userId === interaction.user.id'));
  ok('실제 송금 연동은 하지 않음 (표시만)', sSrc.includes('보냈다는 표시'));

  fs.rmSync('./data/verify-data/plans.json', { force: true });
  fs.rmSync('./data/verify-data/settlements.json', { force: true });
}

// 6y) 방송 기록 (타임머신)
//
// 가장 위험한 것은 **시각 계산**이다. 틀려도 조용히 틀려서, 유튜브 설명란에
// 붙여볼 때까지 아무도 모른다. 그래서 부호까지 숫자로 못 박아 검사한다.
{
  const store = await import('./src/stream/store.js');
  const panel = await import('./src/stream/panel.js');
  const stream = await import('./src/stream/index.js');
  await store.initStreams();

  // ── 링크 형태: /live/ 를 반드시 받아야 한다 (라이브가 주는 형태다) ──
  const forms = {
    'youtube.com/live/': 'https://www.youtube.com/live/AbCdEfGhIjK',
    'youtu.be/': 'https://youtu.be/AbCdEfGhIjK?si=zz',
    'watch?v= (재생목록 붙은 것)': 'https://www.youtube.com/watch?v=AbCdEfGhIjK&list=RDxyz',
    'music.youtube.com': 'https://music.youtube.com/watch?v=AbCdEfGhIjK',
    'ID 만': 'AbCdEfGhIjK',
  };
  for (const [name, url] of Object.entries(forms)) {
    ok(`링크 형태 ${name}`, stream.parseVideoId(url) === 'AbCdEfGhIjK', String(stream.parseVideoId(url)));
  }
  ok('유튜브가 아니면 null', stream.parseVideoId('https://example.com/x') === null);

  // ── 고정 주소 (방송마다 안 바뀌는 주소) ──
  //
  // ★ 이게 "매번 링크 붙이기" 를 없앤다. yt-dlp 가 이 주소를 **지금 하는 방송**으로
  //   풀어준다 (실측 2026-09-03: youtube.com/@ABCNews/live → id=iipR5yUp36o, is_live).
  const homes = {
    '@계정/live': 'https://www.youtube.com/@mychannel/live',
    '@계정 (live 없이)': 'https://www.youtube.com/@mychannel',
    '@계정만': '@mychannel',
  };
  for (const [name, url] of Object.entries(homes)) {
    ok(`고정 주소 ${name}`, stream.parseLiveHome(url) === 'https://www.youtube.com/@mychannel/live',
      String(stream.parseLiveHome(url)));
  }
  ok('channel/UC… 도 고정 주소',
    stream.parseLiveHome('https://www.youtube.com/channel/UCabc123/live') === 'https://www.youtube.com/channel/UCabc123/live');
  // ⚠️ **watch?v= 는 고정 주소가 아니다.** 저장해두면 매번 지난 방송을 등록하게 된다 —
  //    조용히 틀리는 종류의 오류라서, 아예 고정 주소로 인정하지 않는다.
  ok('watch?v= 는 고정 주소가 아님', stream.parseLiveHome('https://www.youtube.com/watch?v=AbCdEfGhIjK') === null);
  ok('/live/<ID> 도 고정 주소가 아님', stream.parseLiveHome('https://www.youtube.com/live/AbCdEfGhIjK') === null);
  ok('유튜브가 아니면 null', stream.parseLiveHome('https://example.com/@x/live') === null);

  {
    const s2 = await import('./src/settings.js');
    ok('고정 주소를 사람마다 저장', s2.setStreamHome('gh', 'u9', 'https://www.youtube.com/@me/live') && s2.streamHome('gh', 'u9') === 'https://www.youtube.com/@me/live');
    ok('안 정한 사람은 null', s2.streamHome('gh', 'u8') === null);
    ok('지울 수 있음', s2.clearStreamHome('gh', 'u9') && s2.streamHome('gh', 'u9') === null);

    const si3 = fs.readFileSync('./src/stream/index.js', 'utf8');
    // 등록이 성공한 뒤에 저장해야 한다. 틀린 주소를 저장하면 매번 실패한다.
    ok('고정 주소는 등록 성공 후에 저장',
      si3.indexOf('putStream(session, { userId, url, videoId, startedAt, startSource })') < si3.indexOf('if (homeToSave) setStreamHome'));
    // 고정 주소로 조회했는데 방송이 없으면 **주소 문제가 아니다.** 라이브를 안 켠 것이다.
    ok('고정 주소인데 방송이 없으면 "라이브를 먼저 켜세요"',
      si3.includes('**라이브를 먼저 켜고** 다시 눌러주세요'));

    // ★ **고정 주소는 공개 방송만 찾는다.** (실측 2026-09-03)
    //   라이브 중이 아닌 채널의 /live 에 대해 yt-dlp 는 이렇게 답한다:
    //     ERROR: [youtube:tab] @Google: The channel is not currently live
    //   일부공개로 켜면 채널 목록에 안 떠서 같은 답이 온다.
    //   이 안내가 없으면 "분명히 방송 중인데" 하고 멀쩡한 주소를 들여다본다.
    ok('"채널이 라이브 중이 아니다" 를 가로채 일부공개 사정을 설명',
      /not currently live[\s\S]{0,900}일부공개/.test(si3));
    ok('일부공개면 이번 방송 주소를 넣으라고 안내',
      /not currently live[\s\S]{0,900}이번 방송 주소를 그대로 넣어주세요/.test(si3));
    ok('라이브를 안 켠 경우도 같은 답이라고 알려줌',
      /not currently live[\s\S]{0,1200}라이브를 아직 안 켠 경우에도/.test(si3));
    ok('고정 주소를 "추천" 으로 앞세우지 않음 (일부공개엔 안 됨)',
      !si3.includes('**고정 주소(추천)**'));
    ok('저장된 주소가 없을 때도 일부공개 사정을 알려줌',
      /저장해둔 주소가 없습니다[\s\S]{0,500}일부공개는 이 방법이 안 됩니다/.test(si3));

    // friendlyError 가 이 문장을 영어 그대로 넘기는 것을 전제로 가로챈다.
    // 만약 나중에 번역을 넣으면 위 정규식이 못 잡으므로 여기서 함께 확인한다.
    const yt3 = await import('./src/music/ytdlp.js');
    const passedThrough = yt3.friendlyError('ERROR: [youtube:tab] @Google: The channel is not currently live');
    ok('friendlyError 가 이 문장을 그대로 넘김 (가로채기가 성립하는 근거)',
      /not currently live/i.test(passedThrough), passedThrough);
    ok('저장된 주소를 안내에 함께 보여줌', si3.includes('저장된 주소:'));
    ok('yt-dlp 가 풀어준 videoId 를 씀 (고정 주소 해석)',
      si3.includes('info.videoId || parseVideoId(target)'));
    const yt2 = fs.readFileSync('./src/music/ytdlp.js', 'utf8');
    ok('liveInfo 가 videoId 도 돌려줌', yt2.includes('%(id)s') && yt2.includes('videoId: id'));
  }

  // ── 경과 시간 적기: 사람이 쓰는 여러 형태 ──
  ok('경과 "1시간 20분"', stream.parseElapsed('1시간 20분') === 4800);
  ok('경과 "80분"', stream.parseElapsed('80분') === 4800);
  ok('경과 "1:20:00"', stream.parseElapsed('1:20:00') === 4800);
  ok('경과 "20:00" 은 20분', stream.parseElapsed('20:00') === 1200);
  ok('숫자만 적으면 분', stream.parseElapsed('45') === 2700);
  ok('알아볼 수 없으면 null', stream.parseElapsed('헛소리') === null);

  // ── 마킹 시각 계산 + 오프셋 부호 ──
  const now = store.nowSec();
  const s = store.openSession('gv', 'chv', '발헤임');
  store.putStream(s, { userId: 'u1', url: 'https://www.youtube.com/watch?v=A'.padEnd(43, 'A'), videoId: 'A'.repeat(11), startedAt: now - 480, startSource: 'release_timestamp' });
  store.putStream(s, { userId: 'u2', url: 'https://www.youtube.com/watch?v=B'.padEnd(43, 'B'), videoId: 'B'.repeat(11), startedAt: now - 200, startSource: 'command' });
  const mk1 = store.addMark(s, 'u1'); mk1.at = now - 300;
  const mk2 = store.addMark(s, 'u1'); mk2.at = now - 100;
  const u1 = store.streamOf(s, 'u1');
  const u2 = store.streamOf(s, 'u2');

  // 진짜 불변조건: **등록한 사람이 몇 명이든 한 번 찍으면 한 줄** 이다.
  // (`!('marks' in u1)` 로 검사하면 없던 키를 확인하는 것이라 그냥 통과한다)
  const beforeMark = s.marks.length;
  const extra = store.addMark(s, 'u2');
  ok('한 번 찍으면 사람이 몇 명이든 한 줄',
    s.marks.length === beforeMark + 1 && s.streams.length === 2,
    `${s.streams.length}명 / ${s.marks.length}줄`);
  ok('사람별 방송에는 마킹을 복사해두지 않음',
    s.streams.every((x) => !('marks' in x)),
    Object.keys(u1).join());
  store.removeLastMark(s, 'u2');
  void extra;
  ok('마킹 시각은 사람마다 따로 계산', store.markSecondsFor(u1, mk2) === 380 && store.markSecondsFor(u2, mk2) === 100);
  ok('타임라인은 시간순', store.timelineFor(s, u1).map((x) => x.sec).join() === '180,380');

  // ── ★ 마킹은 **찍은 사람의 방송에만** 들어간다 ──
  //
  // 처음에는 모두의 타임라인에 넣었다 (원래 기획이 "협동 게임" 전제였다).
  // 그런데 **동시에 방송을 켜도 각자 다른 게임을 할 수 있다**(소유자 지적).
  // 그러면 남의 게임에서 있었던 일이 내 타임라인에 섞이고 되돌릴 방법도 없다.
  ok('찍은 사람의 방송에만 들어감 (기본)',
    mk2.forUserId === 'u1' && store.timelineFor(s, u2).length === 0,
    `u2 타임라인 ${store.timelineFor(s, u2).length}개`);
  ok('내 방송에는 들어감', store.timelineFor(s, u1).some((x) => x.mark.id === mk2.id));

  // 다 같이 하던 순간은 **찍은 뒤에** 넓힌다. 그 순간은 이미 잡혀 있으니 여유가 있다.
  store.shareMark(s, mk2.id);
  ok('[다 같이] 로 넓히면 모두의 타임라인에 들어감',
    mk2.forUserId === null && store.timelineFor(s, u2).length === 1,
    `u2 타임라인 ${store.timelineFor(s, u2).length}개`);
  // 넓혀도 **늦게 켠 사람의 음수 마킹**은 여전히 빠져야 한다 (그 장면이 영상에 없다).
  const early = store.addMark(s, 'u1', null);
  early.at = now - 3000;
  ok('넓힌 마킹도 켜기 전이면 빠짐 (음수)',
    store.timelineFor(s, u2).every((x) => x.sec >= 0) && !store.timelineFor(s, u2).some((x) => x.mark.id === early.id));
  store.removeLastMark(s, 'u1');
  store.shareMark(s, mk2.id) && (mk2.forUserId = 'u1'); // 원래대로

  // 등록 안 한 사람이 누르면 갈 곳이 없다. 그때만 모두의 것으로 둔다.
  const guest = store.addMark(s, 'u9', null);
  ok('등록 안 한 사람이 찍으면 모두의 것', guest.forUserId === null);
  store.removeLastMark(s, 'u9');

  // 취소는 **내가 찍은 것** 중 마지막. 남이 방금 찍은 것을 지우면 안 된다.
  const mineLast = store.addMark(s, 'u1');
  const othersLast = store.addMark(s, 'u2');
  ok('취소는 내가 찍은 마지막 것', store.removeLastMark(s, 'u1')?.id === mineLast.id);
  ok('남이 찍은 것은 안 지워짐', s.marks.some((m) => m.id === othersLast.id));
  ok('내가 찍은 게 없으면 아무것도 안 지움', store.removeLastMark(s, 'u77') === null);
  store.removeLastMark(s, 'u2');

  // 옛 데이터(forUserId 칸이 없던 시절)는 전원에게 들어간다. 옛 기록에는 맞는 해석이지만
  // 새 규칙을 시험할 때 섞이면 헷갈리므로 기동할 때 알려줘야 한다.
  {
    const legacyMark = { id: 'L1', at: now - 100, byUserId: 'u1', text: '' }; // forUserId 없음
    ok('옛 마킹은 모두의 것으로 봄 (그때는 그게 실제 동작이었다)',
      store.markBelongsTo(legacyMark, 'u1') && store.markBelongsTo(legacyMark, 'u2'));
    const ssrc = fs.readFileSync('./src/stream/store.js', 'utf8');
    ok('옛 마킹이 있으면 기동할 때 알려줌',
      ssrc.includes('옛 방식 마킹') && ssrc.includes("m.forUserId === undefined"));
  }

  const si0 = fs.readFileSync('./src/stream/index.js', 'utf8');
  ok('마킹 버튼이 내 방송에만 찍음',
    si0.includes('addMark(session, userId, mine ? userId : null)'));
  ok('찍은 뒤 [다 같이] 버튼을 함께 줌', si0.includes('tm:share:${mark.id}'));
  ok('취소는 내가 찍은 것만', si0.includes('removeLastMark(session, interaction.user.id)'));

  // ★ 부호를 헷갈리면 조용히 반대로 어긋난다. 실제 상황으로 검사한다.
  //   봇은 8분 진행으로 알지만 실제로는 68분 켜져 있었다 → 마킹이 60분씩 **늘어야** 한다.
  const trueStart = now - 68 * 60;
  store.setOffset(s, 'u1', trueStart - u1.startedAt);
  ok('오프셋을 맞추면 경과도 맞음', now - u1.startedAt - u1.offsetSec === 68 * 60, `${(now - u1.startedAt - u1.offsetSec) / 60}분`);
  ok('오프셋이 마킹을 뒤로 밀지 않고 앞으로 당김 (부호)',
    store.markSecondsFor(u1, mk2) === 380 + 3600, String(store.markSecondsFor(u1, mk2)));
  ok('이미 찍어둔 마킹에도 적용됨', store.timelineFor(s, u1).map((x) => store.hhmmss(x.sec)).join() === '01:03:00,01:06:20');
  store.setOffset(s, 'u1', 0);

  ok('hhmmss 는 시간까지 채움 (유튜브 설명란용)', store.hhmmss(3725) === '01:02:05' && store.hhmmss(5) === '00:00:05');
  ok('마지막 마킹 취소', store.removeLastMark(s)?.id === mk2.id && s.marks.length === 1);
  store.addMark(s, 'u1');

  // ── 종료는 비파괴여야 한다 ──
  store.closeSession(s);
  ok('종료해도 마킹이 남음', store.sessionById(s.id)?.marks.length === 2);
  ok('종료하면 기록 중이 아님', store.activeSession('gv') === null);
  store.reopenSession(s);
  ok('이어서 기록하면 다시 열림', store.activeSession('gv')?.id === s.id);
  store.closeSession(s);

  // ── 제어판 ──
  const idsOf = (payload) =>
    payload.components.flatMap((r) => JSON.parse(JSON.stringify(r.toJSON())).components.map((c) => c.custom_id));
  store.reopenSession(s);
  const live = panel.buildStreamPanel('gv');
  ok('제어판 버튼 (마킹·취소·오프셋·종료·나도등록)',
    idsOf(live).join() === 'tm:panel:mark,tm:panel:undo,tm:panel:offset,tm:panel:end,tm:panel:join',
    idsOf(live).join());
  // 늦게 켠 사람이 스스로 끼어들 수 있어야 한다. 기록 중이 아닐 때도 있어야 한다.
  ok('기록 중에도 [지난 게임으로 등록] 이 있음', idsOf(live).includes('tm:panel:join'));
  ok('제어판이 경과 시간을 보여줌 (어긋남을 잡는 1차 방어선)',
    JSON.stringify(live.embeds[0].toJSON()).includes('진행 중'));
  ok('시작 시각을 추정했으면 표시',
    JSON.stringify(live.embeds[0].toJSON()).includes('시작 시각 추정'));
  store.closeSession(s);
  const idle = panel.buildStreamPanel('gv');
  ok('기록 중이 아니어도 제어판이 남음', idle.embeds.length === 1);
  ok('닫힌 제어판에 [이어서 기록] 이 있음 (종료를 되돌리는 유일한 길)',
    idsOf(idle).some((x) => x.startsWith('tm:panel:reopen:')), idsOf(idle).join());
  ok('제어판 버튼은 전부 tm:panel: 로 시작', [...idsOf(live), ...idsOf(idle)].every((x) => x.startsWith('tm:panel:')));

  // ── 요약판 ──
  store.setMarkText(s, s.marks[0].id, '차에 치임');
  const summary = panel.buildSummary(s, u1);
  const joined = summary.map((m) => m.content).join('\n');
  ok('요약판이 코드블록 (유튜브 설명란에 그대로 복사)', joined.includes('```'));
  ok('요약판에 설명이 들어감', joined.includes('차에 치임'));
  ok('설명 없는 마킹도 줄은 남김', joined.includes('(설명 없음)'));
  // 요약판이 tm:panel: 을 쓰면 **훑기가 요약판을 제어판으로 오인해 지운다.**
  ok('요약판 조작부에 tm:panel: 이 없음 (훑기가 지우면 안 됨)',
    idsOf(summary[summary.length - 1]).every((x) => !x.startsWith('tm:panel:')),
    idsOf(summary[summary.length - 1]).join());
  ok('요약판에 클립 뽑기 드롭다운이 있음',
    idsOf(summary[summary.length - 1]).some((x) => x.startsWith('tm:clip:')));
  ok('요약판이 2000자를 넘지 않음', summary.every((m) => m.content.length <= 2000));

  // 마킹이 많아도 나뉘어야 한다. 6명 × 여러 개가 한 장에 안 들어간다.
  for (let i = 0; i < 120; i++) {
    const m = store.addMark(s, 'u1');
    m.at = now - 400 + i;
    store.setMarkText(s, m.id, `아주 긴 설명을 넣어서 한 메시지를 넘기게 만듭니다 ${i}`);
  }
  const big = panel.buildSummary(s, u1);
  ok('마킹이 많으면 여러 장으로 나뉨', big.length > 1, `${big.length}장`);
  ok('나뉘어도 전부 2000자 이하', big.every((m) => m.content.length <= 2000));
  ok('버튼은 마지막 장에만',
    big.slice(0, -1).every((m) => !m.components) && Boolean(big[big.length - 1].components));
  ok('코드블록이 장마다 닫힘', big.every((m) => (m.content.match(/```/g) ?? []).length === 2));

  // ── 입력 창 (빌더 검사는 6x 에서도 돈다) ──
  const noText = store.addMark(s, 'u1');
  noText.at = now - 50;
  const built = panel.buildDescModal(s, u1, 0);
  const modalJson = JSON.parse(JSON.stringify(built.modal.toJSON()));
  const inputs = JSON.stringify(modalJson);
  ok('설명 창은 한 번에 5개', built.marks.length === 5, `${built.marks.length}개`);
  ok('설명 창의 칸은 전부 선택 입력 (required:false)', !/"required":true/.test(inputs));
  ok('설명이 없는 칸에는 value 를 넣지 않음 (빈 문자열은 창을 죽인다)', !/"value":""/.test(inputs));
  ok('설명 창에 다음 페이지가 있음', built.next === 5 && built.total > 5);
  ok('더 채울 것이 없으면 null', panel.buildDescModal(s, u1, 9999) === null);

  // ── 배선 ──
  const idx = fs.readFileSync('./src/index.js', 'utf8');
  ok('재시작 직전 마킹이 사라지지 않게 flushStreams 를 종료 처리에', idx.includes('await flushStreams()'));
  ok('켤 때 방송 제어판을 준비', idx.includes('ensureStreamPanels(c)'));
  ok('방송 기록 저장소를 로그인 전에 초기화', idx.indexOf('await initStreams()') < idx.indexOf('client.login'));
  ok('tm: 버튼이 진입점에 연결', idx.includes("startsWith('tm:')") && idx.includes('handleStreamComponent'));
  ok('tm: 입력 창도 연결', idx.includes('handleStreamModal'));

  const reg = fs.readFileSync('./src/panel-registry.js', 'utf8');
  ok('훑기가 방송 제어판만 남김 (요약판은 건드리지 않음)',
    reg.includes(`'"tm:panel:'`) && reg.includes('rememberedId(STREAM, channel.id)'));
  ok('방송 제어판은 재시작 때 지우지 않음 (기록이 이어지므로)',
    !/deleteMusicPanels[\s\S]{0,600}STREAM/.test(reg));

  const si = fs.readFileSync('./src/stream/index.js', 'utf8');
  // 제어판 수정이 답보다 앞에 오면 가장 많이 눌리는 버튼에서 "Unknown interaction" 이 난다.
  // ⚠️ 이 검사는 **소스 글자에 의존한다.** 답변 문구를 고치면 여기가 깨진다.
  //    깨지면 순서가 아직 맞는지 눈으로 확인하고 아래 문자열을 맞춰줄 것.
  //    (양쪽이 -1 이 되면 `-1 < -1` 이 false 라 조용히 통과하지 않고 실패한다 — 그게 낫다)
  ok('마킹은 답을 먼저 하고 제어판을 나중에 고침',
    si.indexOf('await interaction.reply(\n    eph(`✂️') < si.indexOf('scheduleStreamPanelRefresh(client, interaction.guildId'));
  ok('제어판 수정을 몰아서 함 (6명이 연달아 눌러도 한도에 안 걸리게)',
    fs.readFileSync('./src/stream/panel.js', 'utf8').includes('pendingRefresh'));
  ok('요약판은 하나씩 순서대로 보냄 (한꺼번에 던지면 전송 한도)',
    /for \(const payload of buildSummary\(session, stream\)\)[\s\S]{0,300}?await channel\s*\n?\s*\.send/.test(si));
  // ★ 클립·설명이 바뀔 때 요약판을 **새로 올리면** 같은 타임라인이 채널에 쌓인다.
  //   클립 5개 = 요약판 6장. 제어판처럼 그 자리에서 고쳐 써야 한다.
  ok('요약판은 그 자리에서 고쳐 씀 (새로 올려 쌓지 않음)',
    si.includes('async function refreshSummary') && si.includes('msg.edit({ content:'));
  ok('요약판 메시지 ID 를 기억해둠 (고쳐 쓰려면 필요)',
    si.includes('setSummaryMessages(session, stream.userId, ids)'));
  ok('고쳐 쓰지 못하면 새로 올림 (장수가 바뀌었을 때)',
    /if \(await refreshSummary\([\s\S]{0,200}?postSummary\(channel, session, stream\)/.test(si));
  ok('요약판을 올린 뒤 제어판을 맨 아래로 다시 올림', si.includes('repostStreamPanel(client, interaction.guildId'));
  // 채널을 못 찾으면 **닫지 않는다.** 닫아버리면 [이어서 기록] 버튼도 못 그려서 되돌릴 길이 없다.
  ok('방송 채널을 못 찾으면 종료하지 않음',
    si.indexOf('const channel = await client.channels.fetch(session.channelId)') < si.indexOf('\n  closeSession(session);'));
  // 세션을 다시 연 뒤 설명을 채우면 요약판이 제어판 아래에 쌓인다. 조건 없이 다시 올려야 한다.
  ok('설명을 채운 뒤에도 제어판을 조건 없이 맨 아래로',
    !/resendSummary[\s\S]{0,600}if \(!activeSession/.test(si));

  const yt = fs.readFileSync('./src/music/ytdlp.js', 'utf8');
  ok('시작 시각은 release_timestamp 로 읽음', yt.includes('%(release_timestamp)s'));
  ok('게시 시각(timestamp)을 시작 시각으로 쓰지 않음', !/'%\(timestamp\)s'/.test(yt));
  ok('메타데이터 한 번 읽는 데는 제한시간을 따로 줌', /liveInfo[\s\S]{0,900}timeouts: \[10_000, 20_000\]/.test(yt));

  const env = fs.readFileSync('./.env.example', 'utf8');
  ok('.env.example 에 STREAM_CHANNEL_ID', env.includes('STREAM_CHANNEL_ID='));
  ok('.env.example 에 두 포럼 채널', env.includes('RECORDING_FORUM_ID=') && env.includes('SCREENSHOT_FORUM_ID='));
  ok('.env.example 이 망고에도 YTDLP_PATH 가 필요함을 알려줌',
    /방송 기록[\s\S]{0,600}YTDLP_PATH/.test(env));
}

// 6s-1) 게임 검색 · 포럼 연결
{
  const steam = await import('./src/game/steam.js');
  const catalog = await import('./src/game/catalog.js');
  const forumStore = await import('./src/game/store.js');
  const forum = await import('./src/game/forum.js');
  const streams = await import('./src/stream/store.js');
  const settings = await import('./src/settings.js');

  await catalog.initGameCatalog();

  const direct = await steam.resolveGame('  모여봐요   동물의 숲  ');
  ok('Steam에 없는 게임도 직접 입력', direct.name === '모여봐요 동물의 숲' && direct.key === 'name:모여봐요 동물의 숲');
  ok('직접 입력 게임은 협동 여부를 추측하지 않음', direct.cooperative === null);

  const stardew = {
    key: 'steam:413150', appid: '413150', name: 'Stardew Valley', image: null,
    genres: ['인디'], cooperative: true,
  };
  catalog.rememberGame('alias-guild', stardew, '📷 스타듀 밸리 스샷방');
  catalog.rememberGame('alias-guild', stardew, '스타듀밸리 녹화방');
  catalog.rememberGame('alias-guild', stardew, '스듀');
  ok('수동 줄임말도 같은 Steam 게임으로 검색', catalog.searchKnownGames('alias-guild', '스듀')[0]?.key === stardew.key);
  ok('다른 서버에 별칭이 새어나가지 않음', catalog.searchKnownGames('other-alias-guild', '스듀').length === 0);
  await catalog.flushGameCatalog();
  await catalog.initGameCatalog();
  ok('재시작 뒤에도 별칭 복원', catalog.resolveKnownGame('alias-guild', '스듀')?.key === stardew.key);
  catalog.rememberGame('collision-guild', stardew, '겹치는별칭');
  catalog.rememberGame('collision-guild', { ...stardew, key: 'steam:892970', appid: '892970', name: 'Valheim' }, '겹치는별칭');
  let collisionRejected = false;
  try { await steam.resolveGame('겹치는별칭', 'collision-guild'); } catch { collisionRejected = true; }
  ok('별칭 충돌은 조용히 다른 게임으로 확정하지 않음', collisionRejected && catalog.searchKnownGames('collision-guild', '겹치는별칭').length === 2);
  ok('포럼 제목을 게임의 한글 별칭으로 누적',
    catalog.searchKnownGames('alias-guild', '스타듀밸리')[0]?.key === stardew.key);
  ok('한글 별칭 검색은 띄어쓰기·이모지를 무시',
    catalog.searchKnownGames('alias-guild', '스타듀 밸리')[0]?.key === stardew.key);
  ok('저장된 한글 별칭을 Steam 게임으로 복원',
    (await steam.resolveGame('스타듀밸리 녹화방', 'alias-guild'))?.key === stardew.key);
  let aliasChoices = [];
  await steam.autocompleteGames({
    guildId: 'alias-guild',
    options: { getFocused: () => '스타듀' },
    respond: async (choices) => { aliasChoices = choices; },
  });
  ok('/게임·/방송 자동완성에서 한글 별칭 검색',
    aliasChoices.some((x) => x.value === stardew.key && x.name.includes('스타듀')));

  const gameCmd = allCommands.find((c) => c.data.toJSON().name === '게임');
  ok('/게임 안에 수동 별칭 옵션', gameCmd.data.toJSON().options.some((o) => o.name === '별칭' && !o.required));
  let aliasReply = '';
  const aliasInteraction = {
    guildId: 'alias-guild', channel: null,
    options: { getString: (name) => name === '검색' ? stardew.key : '농장겜' },
    memberPermissions: { has: () => false },
    deferReply: async () => {}, editReply: async (text) => { aliasReply = text; },
  };
  await gameCmd.execute(aliasInteraction);
  ok('일반 사용자의 별칭 변경 거부', aliasReply.includes('권한') && catalog.searchKnownGames('alias-guild', '농장겜').length === 0);
  aliasInteraction.memberPermissions.has = () => true;
  await gameCmd.execute(aliasInteraction);
  ok('관리자가 명령으로 별칭 추가', aliasReply.includes('저장했습니다') && catalog.resolveKnownGame('alias-guild', '농장겜')?.key === stardew.key);
  ok('/게임 검색칸은 자동완성',
    typeof gameCmd.autocomplete === 'function' && gameCmd.data.toJSON().options[0].autocomplete === true);
  const broadcastCmd = allCommands.find((c) => c.data.toJSON().name === '방송');
  ok('/방송 게임명도 자동완성',
    typeof broadcastCmd.autocomplete === 'function' && broadcastCmd.data.toJSON().options[1].autocomplete === true);

  await forumStore.initForumPosts();
  forumStore.bindForumPost('gameguild', 'rec', direct.key, 'thread-rec');
  forumStore.bindForumPost('gameguild', 'shot', direct.key, 'thread-shot');
  ok('게임 하나에 녹화·스샷 포스트를 따로 연결',
    forumStore.postIdFor('gameguild', 'rec', direct.key) === 'thread-rec' &&
      forumStore.postIdFor('gameguild', 'shot', direct.key) === 'thread-shot');
  forumStore.bindForumPost('gameguild', 'rec', 'name:다른게임', 'thread-rec');
  ok('한 포스트를 다른 게임에 연결하면 옛 연결 해제',
    forumStore.postIdFor('gameguild', 'rec', direct.key) === null &&
      forumStore.postIdFor('gameguild', 'rec', 'name:다른게임') === 'thread-rec');

  settings.set('gameguild', 'recordingForumId', 'forum-rec');
  settings.set('gameguild', 'screenshotForumId', 'forum-shot');
  ok('스샷 포럼 포스트는 이미지 저장 대상',
    settings.imageChannelAllowed('gameguild', 'thread-shot', 'forum-shot'));

  const session = streams.openSession('game-post-guild', 'stream-channel', direct.name);
  const stream = streams.putStream(session, {
    userId: 'broadcaster', url: 'https://www.youtube.com/watch?v=abcdefghijk', videoId: 'abcdefghijk',
    startedAt: streams.nowSec() - 100, startSource: 'release_timestamp',
    game: direct.name, gameKey: direct.key, appid: null, cooperative: null,
  });
  ok('버튼용 마지막 게임을 방송자별로 기억',
    streams.lastGameForUser('game-post-guild', 'broadcaster')?.key === direct.key);
  streams.addMark(session, 'broadcaster');
  streams.closeSession(session);
  forumStore.bindForumPost('game-post-guild', 'rec', direct.key, 'record-thread');
  const sentContents = [];
  const editedContents = [];
  const removedMessages = [];
  let failAtSend = null;
  const fakeClient = { channels: { fetch: async () => ({
    isThread: () => true,
    isTextBased: () => true,
    messages: {
      fetch: async (id) => ({ id, edit: async (payload) => editedContents.push(payload.content) }),
      delete: async (id) => removedMessages.push(id),
    },
    send: async (payload) => {
      if (sentContents.length + 1 === failAtSend) { failAtSend = null; throw new Error('검증용 전송 실패'); }
      sentContents.push(payload.content);
      return { id: `msg-${sentContents.length}` };
    },
  }) } };
  const posted = await forum.publishStreamRecord(fakeClient, session, stream);
  ok('방송 종료 기록을 연결된 녹화 포스트에 전송', posted.status === 'posted' && sentContents.length > 0);
  ok('녹화 포스트 기록에 방송자·시작 날짜·링크·타임라인',
    sentContents.join('\n').includes('<@broadcaster>') && sentContents.join('\n').includes('방송 시작') &&
      sentContents.join('\n').includes('youtube.com/watch') && sentContents.join('\n').includes(':d>') &&
      !sentContents.join('\n').includes(':F>') && sentContents.join('\n').includes('```'));
  ok('녹화 포스트 기록은 디스코드 메시지 길이 상한 안', sentContents.every((x) => x.length <= 2000));
  stream.forumPosted.messageIds.push('old-timeline-page');
  const again = await forum.publishStreamRecord(fakeClient, session, stream);
  ok('같은 방송 기록은 새 메시지 없이 갱신', again.status === 'updated' && sentContents.length === 1 && editedContents.length === 1);
  ok('옛 타임라인 추가 페이지 정리', removedMessages.includes('old-timeline-page') && stream.forumPosted.messageIds.length === 1);
  streams.setMarkText(session, session.marks[0].id, '새로운 설명');
  await forum.publishStreamRecord(fakeClient, session, stream);
  ok('수정한 설명이 기존 녹화방 메시지에 반영', editedContents.at(-1).includes('새로운 설명') && sentContents.length === 1);
  for (let i = 0; i < 30; i++) {
    const mark = streams.addMark(session, 'broadcaster');
    streams.setMarkText(session, mark.id, '긴 설명'.repeat(50));
  }
  const expanded = forum.recordPages(session, stream);
  ok('헤더·타임라인·코드블록 포함 2000자 안에서 분할', expanded.length > 1 && expanded.every((x) => x.length <= 2000));
  failAtSend = 3;
  const partial = await forum.publishStreamRecord(fakeClient, session, stream);
  ok('부분 실패해도 성공한 페이지 ID 보존', partial.status === 'failed' && stream.forumPosted.messageIds.length === 2 && stream.forumPosted.complete === false);
  const retried = await forum.publishPendingForGame(fakeClient, session.guildId, stream.gameKey);
  ok('다시 연결 시 부분 전송 복구·중복 없음', retried === 1 && stream.forumPosted.complete && sentContents.length === expanded.length);
  for (const mark of session.marks) streams.setMarkText(session, mark.id, '짧게');
  const firstId = stream.forumPosted.messageIds[0];
  await forum.publishStreamRecord(fakeClient, session, stream);
  ok('설명이 짧아지면 추가 페이지만 삭제하고 첫 메시지 유지', stream.forumPosted.messageIds.length === 1 && stream.forumPosted.messageIds[0] === firstId);
  const countBefore = sentContents.length;
  await Promise.all([forum.publishStreamRecord(fakeClient, session, stream), forum.publishStreamRecord(fakeClient, session, stream)]);
  ok('동시 갱신도 메시지를 중복 생성하지 않음', sentContents.length === countBefore);
  const shared = streams.openSession('shared-sync-guild', 'shared-summary', '공유게임');
  for (const userId of ['shared-a', 'shared-b']) {
    streams.putStream(shared, { userId, url: 'https://youtu.be/abcdefghijk', startedAt: streams.nowSec() - 60, game: '공유게임', gameKey: 'name:공유게임' });
    streams.markStreamForumPosted(shared, userId, `forum-${userId}`, [`record-${userId}`]);
    streams.setSummaryMessages(shared, userId, [`summary-${userId}`]);
  }
  const sharedMark = streams.addMark(shared, 'shared-a', null);
  streams.closeSession(shared);
  const syncEdits = [];
  const syncClient = { channels: { fetch: async () => ({
    isThread: () => true, isTextBased: () => true,
    messages: { fetch: async (id) => ({ id, edit: async (payload) => syncEdits.push({ id, content: payload.content }) }) },
  }) } };
  const streamFeature = await import('./src/stream/index.js');
  await streamFeature.handleStreamModal({
    customId: `tm:descm:${shared.id}:shared-a:0`, fields: { getTextInputValue: () => '공유 장면 설명 수정' },
    reply: async () => {}, editReply: async () => {},
  }, syncClient);
  ok('설명 모달 제출이 공유 방송자 두 명의 녹화방까지 동기화',
    ['record-shared-a', 'record-shared-b', 'summary-shared-a', 'summary-shared-b'].every((id) =>
      syncEdits.some((edit) => edit.id === id && edit.content.includes('공유 장면 설명 수정'))) && sharedMark.text === '공유 장면 설명 수정');

  const gameSrc = fs.readFileSync('./src/game/index.js', 'utf8');
  ok('포스트는 자동 생성하지 않고 현재 포스트를 수동 연결',
    gameSrc.includes('bindForumPost') && !gameSrc.includes('threads.create'));
  ok('포스트 연결 시 제목을 한글 별칭으로 기억',
    gameSrc.includes('rememberGame(interaction.guildId, game, interaction.channel?.name)'));
  ok('포럼 연결 변경은 스레드 관리자만 가능',
    gameSrc.includes('PermissionFlagsBits.ManageThreads'));
  const streamSrc = fs.readFileSync('./src/stream/index.js', 'utf8');
  ok('연결 안 된 녹화 기록은 보류한다고 안내', streamSrc.includes('기록을 보류했습니다'));
  ok('포럼 연결 저장도 종료 전에 flush', fs.readFileSync('./src/index.js', 'utf8').includes('await flushForumPosts()'));
  ok('게임 한글 별칭도 종료 전에 flush', fs.readFileSync('./src/index.js', 'utf8').includes('await flushGameCatalog()'));
}

// 단순 확인 응답만 교체하고 사용자별 화면과 오류는 보존합니다.
{
  const { isConfirmation, createNoticeKeeper, installNoticeCleanup } = await import('./src/notices.js');
  ok('단순 성공 확인은 정리 대상', isConfirmation('✅ 별칭을 저장했습니다.'));
  ok('오류는 정리하지 않음', !isConfirmation('⚠️ 저장에 실패했습니다.'));
  ok('결과 링크는 정리하지 않음', !isConfirmation('완료했습니다. https://example.com/result'));
  ok('다음 버튼은 정리하지 않음', !isConfirmation({ content: '고쳤습니다.', components: [{}] }));
  ok('임베드 결과는 정리하지 않음', !isConfirmation({ content: '완료했습니다.', embeds: [{}] }));
  const deleted = [];
  const keeper = createNoticeKeeper({ schedule: () => 0, cancel: () => {} });
  await keeper('user-a', 'one', async () => deleted.push('one'), 100);
  await keeper('user-b', 'other', async () => deleted.push('other'), 100);
  await keeper('user-a', 'two', async () => deleted.push('two'), 100);
  await keeper('user-a', 'two', async () => deleted.push('two'), 100);
  ok('같은 사용자 최신 한 개만 남기고 타인은 보존', deleted.join() === 'one');
  keeper.forget('user-a', 'two');
  await keeper('user-a', 'three', async () => {}, 100);
  ok('결과 화면으로 바뀐 확인은 삭제 예약 해제', deleted.join() === 'one');
  const fake = {
    id: 'notice-fake', applicationId: 'app', guildId: 'g', channelId: 'c', user: { id: 'u' },
    reply: async () => 'original-result', deleteReply: async () => {},
  };
  installNoticeCleanup(fake);
  ok('응답 반환값을 바꾸지 않음', await fake.reply({ content: '저장했습니다.', flags: 64 }) === 'original-result');
  const removed = [];
  const interactionFor = (id) => ({
    id, applicationId: 'notice-test', guildId: 'g', channelId: 'c', user: { id: 'u' }, ephemeral: true,
    reply: async () => id, editReply: async () => id,
    deleteReply: async () => removed.push(id),
  });
  const one = interactionFor('one'), two = interactionFor('two');
  installNoticeCleanup(one); installNoticeCleanup(two);
  await one.reply({ content: '저장했습니다.', flags: 64 });
  await two.reply({ content: '고쳤습니다.', flags: 64 });
  ok('실제 응답 래퍼가 이전 확인만 삭제', removed.join() === 'one');
  await two.editReply({ content: '⚠️ 갱신 실패', components: [{}] });
  const three = interactionFor('three'); installNoticeCleanup(three);
  await three.reply({ content: '저장했습니다.', flags: 64 });
  ok('오류·버튼 화면으로 바뀌면 보호', removed.join() === 'one');
}

// 6x) ★ 화면을 만드는 함수는 **전부 toJSON() 을 불러본다**
//
// 디스코드 빌더는 `toJSON()` 안에서 값을 검사한다. 부르지 않으면 아무것도 확인하지 못한다.
// 실제로 `LabelBuilder.setDescription(null)` 이 통과해서 나갔고,
// 「고치기」 를 누르면 `Received one or more errors` 로 창이 아예 안 떴다.
//
// **화면 만드는 함수를 새로 만들면 여기에 한 줄 추가할 것.**
{
  const dj = await import('discord.js');
  // 빌더가 거부하는 값들 — 왜 조건부로 불러야 하는지 남겨둔다 (2026-09-01 실측)
  const rejects = (fn) => {
    try { fn(); return false; } catch { return true; }
  };
  ok('Label.setDescription(null) 은 거부됨 (그래서 조건부로 불러야 함)',
    rejects(() => new dj.LabelBuilder().setLabel('x').setDescription(null)
      .setTextInputComponent(new dj.TextInputBuilder().setCustomId('a').setStyle(1)).toJSON()));
  ok('빈 문자열도 거부됨', rejects(() => new dj.EmbedBuilder().setDescription('').toJSON()));

  const plan = await import('./src/plan/index.js');
  const movie = await import('./src/movie/index.js');
  const poll = await import('./src/poll/index.js');
  const settle = await import('./src/plan/settle.js');

  const samplePlan = {
    title: '오사카', at: Date.now() + 86400_000, hasTime: true, place: '스타필드 하남',
    todos: [{ text: '숙소', doneBy: 'u1' }], notes: ['메모'], refs: [{ label: 'x', url: 'https://a.b' }],
    panelMessageId: null, remindAt: null, createdBy: 'u1',
  };
  // 값이 하나도 없는 경우가 **가장 위험하다.** 그때 null·'' 이 빌더로 흘러간다.
  const emptyPlan = { ...samplePlan, place: null, todos: [], notes: [], refs: [], remindAt: 12345 };
  const sampleItem = { id: 'movie-1', kind: 'movie', title: '영화', year: '2026', overview: null, rating: 7.5, votes: 100, poster: 'https://image.tmdb.org/t/p/w500/a.jpg' };

  const ai = await import('./src/ai/index.js');

  // 방송 기록 화면. 위 6y) 에서 만든 세션을 그대로 재사용하지 않고 새로 만든다 —
  // 이 블록만 따로 돌려도 통과해야 한다.
  const ss = await import('./src/stream/store.js');
  const sp = await import('./src/stream/panel.js');
  await ss.initStreams();
  const scr = ss.openSession('gs', 'chs', '발헤임');
  ss.putStream(scr, { userId: 'u1', url: 'https://www.youtube.com/watch?v=' + 'A'.repeat(11), videoId: 'A'.repeat(11), startedAt: ss.nowSec() - 600, startSource: 'release_timestamp' });
  const scrMark = ss.addMark(scr, 'u1');
  scrMark.at = ss.nowSec() - 300;
  const scrStream = ss.streamOf(scr, 'u1');
  // 설명이 **없는** 마킹이 가장 위험하다 — 그때 setValue('') 가 빌더로 흘러간다.
  const scrEmptySession = { ...scr, game: '', marks: [{ ...scrMark, text: '' }] };

  const screens = {
    '방송 제어판 (기록 중)': () => sp.buildStreamPanel('gs'),
    '방송 제어판 (기록 중 아님)': () => sp.buildStreamPanel('없는서버'),
    '방송 시간 어긋남 창': () => sp.buildOffsetModal(scrStream),
    '방송 설명 채우기 창': () => sp.buildDescModal(scr, scrStream, 0).modal,
    '방송 설명 채우기 창 (설명 없음)': () => sp.buildDescModal(scrEmptySession, scrStream, 0).modal,
    '방송 요약판': () => sp.buildSummary(scr, scrStream)[0],
    '방송 요약판 (마킹 없음)': () => sp.buildSummary({ ...scr, marks: [] }, scrStream)[0],
    '일정 판': () => plan.buildPanel(samplePlan),
    '일정 판 (빈 값)': () => plan.buildPanel(emptyPlan),
    '일정 등록 창': () => plan.buildRegisterModal({ name: '251003-오사카' }),
    '일정 고치기 창': () => plan.buildRegisterModal({ name: 'x' }, samplePlan),
    '일정 고치기 창 (빈 값)': () => plan.buildRegisterModal({ name: 'x' }, emptyPlan),
    '카테고리 고르기': () => plan.buildCategoryPicker(),
    '일정 채널 만들기 창': () => plan.buildCreateChannelModal(),
    '영화 고르기 판': () => movie.buildPicker('g', null, []),
    '영화 고르기 판 (장르·OTT 고름)': () => movie.buildPicker('g', 'action', [8, 1881]),
    '영화 결과': () => movie.buildResult(sampleItem, null, []),
    '영화 결과 (줄거리 없음)': () => movie.buildResult({ ...sampleItem, overview: '', poster: null }, 'action', [8]),
    '영화 결과 없음': () => movie.buildEmpty('g', 'action', [1881]),
    'OTT 설정': () => movie.buildOttSettings('g'),
    '투표 판': () => poll.buildPoll({ question: 'Q', options: [{ label: 'A', image: null }], votes: {}, closed: false, createdBy: 'u', createdAt: Date.now() }),
    '투표 만들기 창': () => poll.buildCreateModal(),
    '망고야 상태': () => ai.buildStatusPanel('g', 'u'),
    '정산 고치기 창': () =>
      settle.buildEditModal(
        { title: 'T', payerId: 'p', total: 100, shares: [{ userId: 'p', amount: 100, sent: false }], createdAt: Date.now() },
        () => '지예'
      ),
    '정산 판': () => settle.buildSettlement({ title: 'T', payerId: 'p', total: 100, shares: [{ userId: 'p', amount: 50, sent: false }, { userId: 'a', amount: 50, sent: false }], createdAt: Date.now() }),
  };

  const broken = [];
  for (const [name, make] of Object.entries(screens)) {
    try {
      const out = make();
      // 임베드·컴포넌트·모달 무엇이든 toJSON 을 실제로 불러 검사를 돌린다.
      if (typeof out.toJSON === 'function') out.toJSON();
      for (const e of out.embeds ?? []) e.toJSON();
      for (const r of out.components ?? []) r.toJSON();
    } catch (err) {
      broken.push(`${name}: ${String(err.message).split('\n')[0].slice(0, 60)}`);
    }
  }
  ok(`화면 ${Object.keys(screens).length}개가 전부 조립됨`, broken.length === 0, broken.join(' | '));
}

// 6t) 봇 나눠 돌리기 (BOT_ROLE)
//
// 역할마다 **실제로 프로세스를 띄워** 확인합니다. config.js 가 import 시점에 한 번만
// 읽히므로, 같은 프로세스 안에서는 역할을 바꿔 볼 수 없기 때문입니다.
// 덤으로 "그 역할로 모듈이 전부 로드되는가" 까지 같이 검사됩니다.
{
  const { execFileSync } = await import('node:child_process');
  const namesFor = (role) => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "const m = await import('./src/commands.js'); console.log(JSON.stringify(m.allCommands.map((c) => c.data.toJSON().name)));"],
      { env: { ...process.env, BOT_ROLE: role, DATA_DIR: './data/verify-role-' + role }, encoding: 'utf8' }
    );
    return JSON.parse(out.trim().split('\n').pop());
  };

  const mango = namesFor('mango');
  const music = namesFor('music');
  const union = [...new Set([...mango, ...music])];

  ok('둘을 합쳐 27개', union.length === 27, `${union.length}개`);
  ok('노래하는 망고 = 음악만',
    music.includes('재생') && music.includes('음량') && !music.includes('읽어주기') && !music.includes('갤러리'),
    music.join(' '));
  ok('망고에는 음악이 아예 없음',
    !mango.includes('재생') && !mango.includes('대기열') && !mango.includes('음량') && mango.includes('갤러리'),
    mango.join(' '));

  // 음성채널에서 나올 방법은 **양쪽 다** 있어야 합니다.
  // 읽어주기도 음성채널에 들어가므로, /나가기 가 음악 쪽에만 있으면 망고가 갇힙니다.
  ok('양쪽 다 음성채널에서 나올 수 있음', mango.includes('나가기') && music.includes('나가기'));

  // 겹치는 것은 **봇마다 따로 있어야 하는 조종 명령어 4개뿐**이어야 합니다.
  const shared = music.filter((n) => mango.includes(n)).sort();
  ok('겹치는 건 조종 명령어 4개뿐',
    JSON.stringify(shared) === JSON.stringify(['기능', '나가기', '도움말', '채널설정'].sort()), shared.join(' '));

  // 잘못된 이름은 조용히 넘어가면 안 됩니다 (전부 꺼진 봇이 됩니다)
  const rejects = (value) => {
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js');"],
        { env: { ...process.env, BOT_ROLE: value }, stdio: 'pipe' });
      return false;
    } catch {
      return true;
    }
  };
  ok('잘못된 BOT_ROLE 은 실행을 멈춤', rejects('음악'));
  // 겸하는 모드(all)는 없앴습니다. 남아 있으면 셋이 되어 분담표가 무너집니다.
  ok('겸하는 모드(all)는 없음', rejects('all'));

  fs.rmSync('./data/verify-role-mango', { recursive: true, force: true });
  fs.rmSync('./data/verify-role-music', { recursive: true, force: true });

  // 읽어주기 음량 조절은 걷어냈습니다 (소유자 요청)
  ok('읽어주기 음량 배선 제거',
    !fs.readFileSync('./src/tts/index.js', 'utf8').includes('volumeScale') &&
    !fs.readFileSync('./src/timer/index.js', 'utf8').includes('volumeScale'));
  ok('/음량 은 음악 전용',
    fs.existsSync('./src/music/volume-commands.js') && !fs.existsSync('./src/volume-commands.js'));

  // 같은 애플리케이션으로 두 번 돌리면 모든 명령에 두 번 답합니다. 반드시 막아야 합니다.
  const cfg = fs.readFileSync('./src/config.js', 'utf8');
  ok('같은 토큰·CLIENT_ID 를 쓰면 막음', cfg.includes('assertDifferentApplications()') &&
    cfg.includes("['DISCORD_TOKEN', 'CLIENT_ID']"));

  // 웹서버를 둘 다 띄우면 나중 쪽이 포트 충돌로 죽습니다
  const ix = fs.readFileSync('./src/index.js', 'utf8');
  ok('갤러리 웹서버는 이미지 담당만', ix.includes("if (inRole('images')) {") && ix.includes('webServer = await startWebServer()'));
  ok('맡지 않은 기능은 메시지도 안 봄', ix.includes("if (inRole('images')) await handleImageMessage") &&
    ix.includes("if (inRole('tts')) await handleTtsMessage"));

  // 로그인 실패는 원인이 갈립니다. 전부 "토큰을 확인하세요" 로 안내하면
  // 인텐트를 안 켠 경우에 엉뚱한 곳을 뒤지게 됩니다 (실제로 겪음).
  ok('인텐트 미설정을 따로 안내', ix.includes('disallowed intents|privileged intent') &&
    ix.includes('MESSAGE CONTENT INTENT'));
  ok('어느 설정 파일인지까지 알려줌', ix.includes("config.role === 'music' ? '.env.music' : '.env'"));

  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  ok('음악 봇 실행·등록 스크립트', Boolean(pkg.scripts['start:music'] && pkg.scripts['deploy:music']));
  ok('역할 파일이 .env 를 이김 (--env-file)', pkg.scripts['start:music'].includes('--env-file=.env.music'));
  ok('.env.music 은 커밋되지 않음', fs.readFileSync('./.gitignore', 'utf8').includes('.env.*'));
  ok('.env.music.example 은 남김', fs.readFileSync('./.gitignore', 'utf8').includes('!.env.music.example') &&
    fs.existsSync('./.env.music.example'));

  // yt-dlp 는 음악 봇만 돌립니다. 쿠키 설정이 음악 쪽 예시에 없으면
  // "쿠키를 어디 적지?" 가 되고, 안내도 엉뚱한 파일을 가리킵니다.
  const musicEnv = fs.readFileSync('./.env.music.example', 'utf8');
  for (const key of ['YTDLP_COOKIES_FILE', 'YTDLP_PROXY', 'YTDLP_EXTRA_ARGS', 'YTDLP_JS_RUNTIME']) {
    ok(`.env.music.example 에 ${key}`, musicEnv.includes(key));
  }
  // 안내가 `.env` 를 가리키면 엉뚱한 파일을 고치게 됩니다.
  // `.env.music` 을 지운 뒤에도 `.env` 가 쿠키 안내에 남아 있으면 실패입니다.
  const yt = fs.readFileSync('./src/music/ytdlp.js', 'utf8');
  const stripped = yt.split('`.env.music`').join('〈음악설정〉');
  ok('쿠키 안내가 .env.music 을 가리킴',
    stripped.includes('〈음악설정〉 의 YTDLP_COOKIES_FILE') &&
    !stripped.includes('.env 의 YTDLP_COOKIES_FILE') &&
    !stripped.includes('`.env` 의 `YTDLP_COOKIES_FILE`'));
}

// 6r) 지난 재생 목록
{
  const h = await import('./src/music/history.js');
  await h.initHistory();
  const T = (n, u, d) => ({ title: n, url: u, duration: d });

  h.record('hg1', T('A곡', 'https://youtu.be/aaa', 200), 1000);
  h.record('hg1', T('B곡', 'https://youtu.be/bbb', 100), 2000);
  ok('최근에 들은 순서로', h.recent('hg1')[0].title === 'B곡');

  h.record('hg1', T('A곡', 'https://youtu.be/aaa', 200), 3000);
  ok('같은 곡을 또 들으면 맨 앞으로', h.recent('hg1')[0].title === 'A곡');
  ok('중복으로 쌓이지 않음', h.count('hg1') === 2);

  h.record('hg2', T('타서버곡', 'https://youtu.be/zzz', 10), 1000);
  ok('서버끼리 섞이지 않음', h.recent('hg1').every((e) => e.title !== '타서버곡'));

  // 드롭다운 값은 100자 제한이라, 넘으면 다시 고를 수 없습니다
  h.record('hg1', T('긴주소', 'https://youtu.be/' + 'x'.repeat(120), 10));
  ok('100자 넘는 주소는 넣지 않음', h.count('hg1') === 2);
  h.record('hg1', { title: '주소없음', url: null });
  ok('주소 없으면 넣지 않음', h.count('hg1') === 2);

  for (let i = 0; i < 80; i++) h.record('hg3', T('곡' + i, 'https://youtu.be/v' + i, 10), i);
  ok('상한을 넘지 않음 (60곡)', h.count('hg3') === 60);
  ok('넘치면 오래된 것부터 밀려남', !h.recent('hg3', 60).some((e) => e.title === '곡0'));

  const t0 = 1_000_000_000_000;
  ok('시간 표시', h.timeAgo(t0 - 30_000, t0) === '방금' && h.timeAgo(t0 - 5 * 60e3, t0) === '5분 전' &&
    h.timeAgo(t0 - 26 * 3600e3, t0) === '어제' && h.timeAgo(t0 - 5 * 86400e3, t0) === '5일 전');

  // 재시작을 견디는가.
  // 시간을 재서 기다리면(setTimeout) 느린 서버에서 어긋납니다 — 실제로 실패했습니다.
  await h.flushHistory();
  const h2 = await import('./src/music/history.js?reload=1');
  await h2.initHistory();
  ok('재시작해도 목록이 남음', h2.recent('hg1').length === 2, `${h2.count('hg1')}곡`);
  ok('저장 완료를 기다릴 수 있음 (시간 재기 금지)', typeof h.flushHistory === 'function' && fs.readFileSync('./src/index.js','utf8').includes('await flushHistory()'));

  const mc = fs.readFileSync('./src/music/commands.js', 'utf8');
  const pn3 = fs.readFileSync('./src/music/panel.js', 'utf8');
  const ga2 = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
  ok('제어판에 지난 곡 버튼', pn3.includes("'m:hist'"));
  ok('/재생 을 비우면 지난 곡 목록', mc.includes("setRequired(false)") && mc.includes('buildHistoryPicker(interaction.guildId)'));
  ok('지난 곡은 재생 중이 아니어도 열림', fs.readFileSync('./src/index.js', 'utf8').includes("startsWith('m:hist')"));
  ok('기록은 실제 재생이 시작될 때만', ga2.includes('AudioPlayerStatus.Playing, () => {') && ga2.includes('recordHistory('));
  ok('여러 곡을 한 번에 담기', mc.includes('setMaxValues(list.length)'));

  const picker = (await import('./src/music/commands.js')).buildHistoryPicker('hg1');
  ok('고르기 화면은 나만 보임', picker.flags === (await import('discord.js')).MessageFlags.Ephemeral);
  ok('고른 값은 곡 주소', JSON.stringify(picker.components[0].toJSON()).includes('youtu.be/aaa'));
  const emptyPicker = (await import('./src/music/commands.js')).buildHistoryPicker('없는서버');
  ok('기록이 없으면 다음에 뭘 할지 안내', emptyPicker.content.includes('/재생') && !emptyPicker.components);
}

// 6s) 음량을 두 번 이상 바꿔도 곡이 처음으로 돌아가지 않는가
{
  const ga = fs.readFileSync('./src/audio/guild-audio.js', 'utf8').replace(/\r\n/g, '\n');
  ok('재생 위치 = 건너뛴 만큼 + 이번에 재생한 만큼',
    ga.includes('this.currentOffsetSec + (this.currentResource?.playbackDuration ?? 0) / 1000'));
  ok('다시 틀 때 기준점을 남김', ga.includes('this.currentOffsetSec = resumeAt;'));
  ok('새 곡에서도 기준점 설정', ga.includes('this.currentOffsetSec = item.resumeAt ?? 0;'));
  ok('이어서 틀 위치는 positionSec 으로', ga.includes('Math.max(0, this.positionSec() + lead)'));

  // 침묵을 없애는 핵심: 준비 → 바꿔치기 → 그 다음에 옛것 끊기
  const rs = ga.slice(ga.indexOf('  async restartAtCurrentPosition()'), ga.indexOf('  isCurrentStill('));
  ok('새 소리를 준비한 뒤에 바꿈', rs.indexOf('await waitForAudio(') < rs.indexOf('this.musicPlayer.play(resource)'));
  ok('옛 소리는 바꾼 뒤에 끊음', rs.indexOf('this.musicPlayer.play(resource)') < rs.indexOf('stopOld?.()'));
  ok('준비에 실패해도 듣던 소리를 안 끊음', rs.includes('prepared.kill()') && !rs.includes('this.killCurrent?.()'));
  ok('준비 시간만큼 앞을 내다봄',
    ga.includes('LEAD_REMOTE_SEC') && ga.includes('LEAD_URL_SEC') && ga.includes('LEAD_PIPE_SEC'));
  ok('yt-dlp 쪽을 더 넉넉히', ga.includes('const LEAD_PIPE_SEC = 3.5;') && ga.includes('const LEAD_REMOTE_SEC = 1.5;'));
  ok('준비 중 또 누르면 앞의 것 버림', rs.includes('++this.restartGen') && ga.includes('gen === this.restartGen'));
  ok('데이터 없는 readable 은 준비된 것이 아님', ga.includes('if (stream.readableLength > 0) finish(true)'));

  // 재시도가 곡을 처음으로 되돌리지 않는가
  ok('재시도할 때 듣던 위치를 넘김', ga.includes('srcLevel: nextLevel, resumeAt: this.positionSec()'));
  // ★ 반대쪽도 지켜야 합니다. srcLevel·resumeAt 을 곡에 계속 붙여두면
  //   🔁 반복·⏮️ 이전 이 곡 **중간**부터 시작하고, 한 번 실패한 곡이
  //   그 실행 동안 가장 느린 단계에 갇힙니다 (미리 뽑아둔 주소가 있어도 못 올라옴).
  ok('반복·이전은 처음부터 (시도 정보를 떼어냄)',
    ga.includes('this.queue.unshift(rewind(outgoing))') && !/unshift\(outgoing\)/.test(ga));
  ok('기록에도 시도 정보를 안 남김', ga.includes('this.history.push(rewind(item))'));
  ok('되돌릴 때 track 과 요청자만 남김',
    ga.includes('const rewind = (item) => ({ track: item.track, requestedBy: item.requestedBy });'));
  ok('재생 실패 판정은 이번 시도만 봄', ga.includes('const played = this.currentResource?.playbackDuration ?? 0;'));
  ok('이어듣기는 남은 길이로 판정', ga.includes('return trackLen - this.currentOffsetSec > 5;'));
  ok('음량 버튼 연타는 모아서 한 번만', ga.includes('clearTimeout(this.volumeTimer)') && ga.includes('this.restartAtCurrentPosition()'));
  ok('곡이 바뀌면 대기 중인 반영 취소', ga.includes("playNext(intent = 'auto') {\n    // 곡이 바뀌므로"));
  ok('끝난 뒤 곡이 바뀌었으면 무시', ga.includes('this.current !== item) return;'));
}

// 6q) 제어판이 재시작·곡 종료 후에 남지 않는가
{
  const reg = fs.readFileSync('./src/panel-registry.js', 'utf8');
  const ga = fs.readFileSync('./src/audio/guild-audio.js', 'utf8').replace(/\r\n/g, '\n');
  const pn = fs.readFileSync('./src/music/panel.js', 'utf8');
  const ip = fs.readFileSync('./src/images/panel.js', 'utf8');
  const ix = fs.readFileSync('./src/index.js', 'utf8');

  // (1) 재시작해도 옛 제어판을 찾아 지울 수 있는가
  ok('제어판 ID 를 디스크에 기억', pn.includes('rememberPanel(MUSIC'));
  ok('갤러리 버튼도 기억', ip.includes('rememberPanel(GALLERY'));
  ok('시작할 때 옛 제어판 정리', ix.includes('cleanupPanelsOnStart('));
  ok('종료할 때도 제어판 정리', ix.includes('deleteMusicPanels(client, adoptMusicPanel)'));

  // ★ 지정된 음악 채팅방의 제어판은 **절대 사라지지 않아야** 합니다.
  //   소유자 요청: "음악 채팅채널로 지정한곳에는 제어판이 항상 보였으면 좋겠어."
  {
    const pnl = fs.readFileSync('./src/music/panel.js', 'utf8');
    const gax = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
    ok('지정된 음악 채팅방을 알아봄', pnl.includes("getSetting(guildId, 'musicTextChannelId') === channelId"));
    // 되찾기와 "비었다" 로 고쳐쓰기를 **한 번에** 해야 그 사이에 거짓말이 안 남습니다.
    ok('되찾으면서 곧바로 비었다고 고침',
      /adoptMusicPanel[\s\S]{0,400}?await message\.edit\(buildPanel\(null, guildId\)\)/.test(pnl));
    ok('없으면 새로 띄움', pnl.includes('export async function ensureHomePanel('));
    ok('켤 때 서버마다 보장', ix.includes('ensureHomePanels(c)'));
    ok('음악 채팅방을 정하면 바로 띄움',
      fs.readFileSync('./src/channel-commands.js', 'utf8').includes('ensureHomePanel(interaction.client'));
    // 나가도 지우지 않고 "비었다" 로 고쳐 씁니다.
    ok('나갈 때 지정 채널이면 안 지움',
      gax.includes('if (isMusicHome(this.guild.id, panel.channelId))') &&
      gax.includes('panel.edit(buildPanel(null, this.guild.id))'));
    // ⚠️ 훑기가 이걸 지우면 재시작마다 사라집니다. (갤러리와 같은 예외가 필요합니다)
    ok('훑기가 남겨둔 제어판은 건드리지 않음',
      reg.includes('const keepMusic = rememberedId(MUSIC, channel.id);') &&
      reg.includes('isMusicPanel(msg, client.user.id) && msg.id !== keepMusic'));
    // 재시작 뒤 첫 재생 때 이미 떠 있는 것을 못 찾으면 제어판이 둘이 됩니다.
    ok('이미 떠 있는 제어판을 되찾아 씀',
      pnl.includes('const known = rememberedId(MUSIC, channel.id);'));
    // 비어 있어도 눌리는 버튼이 있습니다. 오류로 되돌려보내면 먹통으로 보입니다.
    ok('재생 중이 아니어도 음량·새로고침은 동작',
      pnl.includes("if (id !== 'm:refresh' && id !== 'm:vol-' && id !== 'm:vol+')"));
    ok('빈 제어판에도 음량 표시', pnl.includes('const volume = `🔊 ${volumePercent(guildId'));
  }
  ok('registry 를 로그인 전에 초기화', ix.indexOf('await initPanelRegistry()') < ix.indexOf('client.login'));
  ok('갤러리 버튼은 되찾아 재사용', ip.includes('adoptGalleryPanel') && reg.includes('adoptGallery?.('));
  ok('훑기는 봇 자기 메시지만 지움', reg.includes('msg.author?.id !== botId'));
  ok('훑기 전에 members.me 확보', reg.includes('guild.members.fetchMe()'));

  // (2) 곡이 다 끝났는데 제어판이 "지금 재생 중" 으로 굳던 버그
  ok('대기열이 비면 제어판 갱신', ga.includes('if (!item) {') && ga.includes('this.refreshPanel();\n      this.scheduleLeave();'));
  ok('곡이 끝나도 제어판 갱신', ga.includes('this.current = null;\n      this.refreshPanel();'));
  // ★ 소유자 요청: "사람이 한명이라도 음성채팅에 있으면 계속 남아있는걸로"
  //   망고는 읽어주기·타이머 때문에 들어가 있는데, 조용하다고 5분 뒤에 나가버리면
  //   대화 중에 갑자기 사라지고 다시 부르는 것도 사람 몫이 됩니다.
  ok('사람이 있으면 나가지 않음', ga.includes('if (this.hasHumanListener()) return;'));
  ok('봇은 사람으로 세지 않음', ga.includes('channel.members.some((m) => !m.user?.bot)'));
  // 아무도 없어지면 VoiceStateUpdate 가 바로 내보냅니다. 그 길은 그대로 있어야 합니다.
  ok('아무도 없으면 그때 나감',
    fs.readFileSync('./src/index.js', 'utf8').includes("humans === 0"));
  ok('설정 설명에도 적어둠',
    fs.readFileSync('./.env.example', 'utf8').includes('사람이 남아 있으면 이 시간이 지나도'));

  ok('나갈 때 제어판 삭제', ga.includes('panel.delete()') && ga.includes('forgetPanel(MUSIC'));

  // (3) 우클릭 → "연결 끊기" 로 내보낸 경우 (명령어를 거치지 않는 경로)
  const dc = ga.slice(ga.indexOf('VoiceConnectionStatus.Disconnected'), ga.indexOf('await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000)'));
  ok('연결 끊기면 정리 (destroy 호출)', dc.includes('this.destroy()'));
  ok('연결 끊기면 왜 멈췄는지 알림', dc.includes('this.notify('));
  ok('복구 중이면 Ready 까지 확인', dc.includes('VoiceConnectionStatus.Ready'));
  ok('끊김 처리는 한 번만 (중복 방지)', dc.includes('if (this.destroyed) return;'));

  // refreshPanel 은 메시지를 옮기면 안 됩니다 (버튼 응답과 겹쳐 "없는 메시지" 오류가 납니다)
  const rp = ga.slice(ga.indexOf('  refreshPanel() {'), ga.indexOf('  onTrackEnd()'));
  // 버튼을 누른 사람이 기다리게 만들지 않습니다.
  // 400ms 를 자던 것을 없애고, 소리가 실제로 바뀌는 순간 따라 갱신합니다.
  {
    const pnl = fs.readFileSync('./src/music/panel.js', 'utf8');
    ok('버튼 응답 전에 기다리지 않음', !/setTimeout\(r, 400\)/.test(pnl));
    ok('소리가 바뀌면 제어판이 따라옴', ga.includes('this.schedulePanelRefresh();'));
    ok('버튼 응답과 겹치지 않게 미룸', ga.includes('clearTimeout(this.panelTimer)'));
    ok('나갈 때 예약된 갱신도 정리',
      /destroy\(\)[\s\S]*?clearTimeout\(this\.panelTimer\);[\s\S]{0,400}?this\.queue = \[\];/.test(ga));
    ok('나갈 때 직접수신 판정도 취소',
      /destroy\(\)[\s\S]*?clearTimeout\(this\.directCheckTimer\);/.test(ga));
  }

  ok('갱신은 그 자리에서만 (지우거나 다시 보내지 않음)', rp.includes('msg.edit(') && !rp.includes('showPanel('));

  // 빈 제어판이 실제로 "재생 중 없음" 을 보여주는가
  const { buildPanel: bp } = await import('./src/music/panel.js');
  const emptyPanel = bp({ guild: { id: 'g' }, current: null, queue: [], history: [], loop: false });
  ok('빈 제어판은 재생 중이 아님을 알림', JSON.stringify(emptyPanel.embeds[0].toJSON()).includes('재생 중인 곡이 없습니다'));
}

await new Promise((res) => server.close(res));
fs.rmSync('./data/verify-images', { recursive: true, force: true });
fs.rmSync('./data/verify-data', { recursive: true, force: true });
reportFailures();
process.exit(fail === 0 ? 0 : 1);
