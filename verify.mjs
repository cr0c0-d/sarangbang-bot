// 수정 후 재검증. 토큰 없이 확인할 수 있는 것 전부.
process.env.DISCORD_TOKEN = 'x'.repeat(59);
process.env.CLIENT_ID = '123456789012345678';
process.env.GUILD_ID = '123456789012345678, 987654321098765432';
process.env.TTS_TEXT_CHANNEL_ID = '111111111111111111';
process.env.IMAGE_CHANNEL_ID = '222222222222222222';
process.env.IMAGE_DIR = './data/verify-images';
process.env.WEB_PORT = '38473';
process.env.WEB_TOKEN = 'testsecret';
process.env.WEB_BIND = '127.0.0.1';
process.env.DATA_DIR = './data/verify-data';

import fs from 'node:fs';
let fail = 0;
const ok = (label, cond, extra = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (extra ? '  ' + extra : ''));
  if (!cond) fail++;
};

// 1) 명령어 스키마
const { initSettings } = await import('./src/settings.js');
await initSettings();
const { allCommands } = await import('./src/commands.js');
const names = allCommands.map((c) => c.data.toJSON().name);
// 검증은 기본 봇(망고)으로 돕니다. 노래하는 망고 쪽은 아래 6t) 에서
// 따로 프로세스를 띄워 검사합니다 (config 가 import 시점에 한 번만 읽히므로).
ok('망고 명령어 19개 로드 (우클릭 1개 포함)', allCommands.length === 19, `(${allCommands.length}개) ${names.join(' ')}`);
ok('명령어 이름 중복 없음', new Set(names).size === names.length);
ok('영문 명령어 잔존 없음',
  !names.some((n) => /^[a-z]/.test(n)), names.filter((n) => /^[a-z]/.test(n)).join(',') || '없음');
for (const need of ['채널설정', '나가기', '타이머', '타이머목록', '알람등록', '기능', '목소리', '읽어주기', '폴더', '폴더목록', '정리', '갤러리', '도움말', '투표', '영화', '일정', '일정새로', '정산']) {
  ok(`/${need} 존재`, names.includes(need));
}
ok('/읽기중지 제거됨 (나가기로 통합)', !names.includes('읽기중지'));
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
ok('TTS 정제', got === '누군가 야 링크 봐 굵게 크크크', JSON.stringify(got));

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
  //   그래서 3개로 줄인 뒤 **발음 나는 글자로 바꿔야** 읽힙니다.
  ok('ㅋㅋㅋㅋㅋ → 크크크 (3개로 줄이고 글자로)', say('ㅋㅋㅋㅋㅋ') === '크크크', say('ㅋㅋㅋㅋㅋ'));
  ok('ㅎ · ㅠ · ㅜ 도 마찬가지', say('ㅎㅎ') === '흐흐' && say('ㅠㅠ') === '흑흑' && say('ㅜㅜㅜㅜ') === '흑흑흑',
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
  ok('삭제된 영상은 재시도 대상 아님',
    !isTransient('ERROR: [youtube] abc: Video unavailable'));
  ok('삭제된 영상 안내 문구',
    friendlyError('ERROR: Video unavailable').includes('재생할 수 없는 영상'));
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

  ok('기능 목록 7개', Object.keys(st.FEATURES).length === 7, Object.keys(st.FEATURES).join(','));
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
  const ga = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
  ok('재생 실패 감지 함수', ga.includes('playedNothing()'));
  ok('직접수신 실패 시 파이프로 재시도', ga.includes('forcePipe: true'));
  ok('두 방식 다 실패하면 사용자에게 알림', ga.includes('재생에 실패했습니다'));

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
  const gaDirect = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
  ok('실패 원인을 로그에 남김', gaDirect.includes('this.lastStreamError.slice(0, 200)'));
  const cfg = fs.readFileSync('./src/config.js', 'utf8');
  ok('.env 중복 항목 경고', cfg.includes('warnDuplicateEnvKeys'));
  ok('다음 곡 미리 추출', ga.includes('prefetchNext()'));
  ok('추출 결과 캐시', yt.includes('function cacheGet'));
  // 캐시본을 그대로 주면 호출한 쪽에서 streamUrl 을 덮어쓸 때 서로 간섭합니다.
  ok('캐시본을 복사해서 반환 (오염 방지)',
    yt.includes('return withTotal(cached);') && yt.includes('list.map((t) => ({ ...t }))'));
  ok('JS런타임 끄는 스위치', yt.includes('YTDLP_JS_RUNTIME'));
  ok('제한시간을 늘려가며 재시도', yt.includes('TIMEOUT_LADDER = [20_000, 60_000]'));
  ok('타임아웃과 차단 안내를 구분', yt.includes('서버가 느린 것') && yt.includes('IP를 차단'));
  ok('타임아웃 메시지에 실제 초 표기', yt.includes('초 안에 응답하지 않았습니다'));
  const mc2 = fs.readFileSync('./src/music/commands.js', 'utf8');
  ok('추출과 음성접속을 동시에', mc2.includes('Promise.all([getTracks(query), audio.connect(voiceChannel)])'));
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
  const pl = fs.readFileSync('./src/plan/index.js', 'utf8');
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
    title: '오사카', at: pw.parseWhen('10/3 18:30', now).at, hasTime: true, place: '스타필드 하남',
    todos: Array.from({ length: n }, (_, i) => ({ text: `할일${i}`, doneBy: i === 0 ? 'u1' : null })),
    notes: ['체크인 15시'], refs: [{ label: '숙소', url: 'https://discord.com/channels/1/2/3' }],
    panelMessageId: null, remindAt: null, createdBy: 'u1',
  });
  const panel3 = buildPanel(mkPlan(3));
  const pj = JSON.stringify(panel3.components.map((r) => r.toJSON()));
  ok('지도 버튼 2개', pj.includes('map.kakao.com') && pj.includes('map.naver.com'));
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

  ok('둘을 합쳐 23개', union.length === 23, `${union.length}개`);
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
  const ga = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
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
  ok('준비 시간만큼 앞을 내다봄', ga.includes('LEAD_REMOTE_SEC') && ga.includes('LEAD_PIPE_SEC'));
  ok('yt-dlp 쪽을 더 넉넉히', ga.includes('const LEAD_PIPE_SEC = 3.5;') && ga.includes('const LEAD_REMOTE_SEC = 1.5;'));
  ok('준비 중 또 누르면 앞의 것 버림', rs.includes('++this.restartGen') && ga.includes('gen === this.restartGen'));
  ok('데이터 없는 readable 은 준비된 것이 아님', ga.includes('if (stream.readableLength > 0) finish(true)'));

  // 재시도가 곡을 처음으로 되돌리지 않는가
  ok('재시도할 때 듣던 위치를 넘김', ga.includes('forcePipe: true, resumeAt: this.positionSec()'));
  ok('재생 실패 판정은 이번 시도만 봄', ga.includes('const played = this.currentResource?.playbackDuration ?? 0;'));
  ok('이어듣기는 남은 길이로 판정', ga.includes('return trackLen - this.currentOffsetSec > 5;'));
  ok('음량 버튼 연타는 모아서 한 번만', ga.includes('clearTimeout(this.volumeTimer)') && ga.includes('this.restartAtCurrentPosition()'));
  ok('곡이 바뀌면 대기 중인 반영 취소', ga.includes("playNext(intent = 'auto') {\n    // 곡이 바뀌므로"));
  ok('끝난 뒤 곡이 바뀌었으면 무시', ga.includes('this.current !== item) return;'));
}

// 6q) 제어판이 재시작·곡 종료 후에 남지 않는가
{
  const reg = fs.readFileSync('./src/panel-registry.js', 'utf8');
  const ga = fs.readFileSync('./src/audio/guild-audio.js', 'utf8');
  const pn = fs.readFileSync('./src/music/panel.js', 'utf8');
  const ip = fs.readFileSync('./src/images/panel.js', 'utf8');
  const ix = fs.readFileSync('./src/index.js', 'utf8');

  // (1) 재시작해도 옛 제어판을 찾아 지울 수 있는가
  ok('제어판 ID 를 디스크에 기억', pn.includes('rememberPanel(MUSIC'));
  ok('갤러리 버튼도 기억', ip.includes('rememberPanel(GALLERY'));
  ok('시작할 때 옛 제어판 정리', ix.includes('cleanupPanelsOnStart('));
  ok('종료할 때도 제어판 삭제', ix.includes('deleteMusicPanels(client)'));
  ok('registry 를 로그인 전에 초기화', ix.indexOf('await initPanelRegistry()') < ix.indexOf('client.login'));
  ok('갤러리 버튼은 되찾아 재사용', ip.includes('adoptGalleryPanel') && reg.includes('adoptGallery?.('));
  ok('훑기는 봇 자기 메시지만 지움', reg.includes('msg.author?.id !== botId'));
  ok('훑기 전에 members.me 확보', reg.includes('guild.members.fetchMe()'));

  // (2) 곡이 다 끝났는데 제어판이 "지금 재생 중" 으로 굳던 버그
  ok('대기열이 비면 제어판 갱신', ga.includes('if (!item) {') && ga.includes('this.refreshPanel();\n      this.scheduleLeave();'));
  ok('곡이 끝나도 제어판 갱신', ga.includes('this.current = null;\n      this.refreshPanel();'));
  ok('나갈 때 제어판 삭제', ga.includes('panel.delete()') && ga.includes('forgetPanel(MUSIC'));

  // (3) 우클릭 → "연결 끊기" 로 내보낸 경우 (명령어를 거치지 않는 경로)
  const dc = ga.slice(ga.indexOf('VoiceConnectionStatus.Disconnected'), ga.indexOf('await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000)'));
  ok('연결 끊기면 정리 (destroy 호출)', dc.includes('this.destroy()'));
  ok('연결 끊기면 왜 멈췄는지 알림', dc.includes('this.notify('));
  ok('복구 중이면 Ready 까지 확인', dc.includes('VoiceConnectionStatus.Ready'));
  ok('끊김 처리는 한 번만 (중복 방지)', dc.includes('if (this.destroyed) return;'));

  // refreshPanel 은 메시지를 옮기면 안 됩니다 (버튼 응답과 겹쳐 "없는 메시지" 오류가 납니다)
  const rp = ga.slice(ga.indexOf('  refreshPanel() {'), ga.indexOf('  onTrackEnd()'));
  ok('갱신은 그 자리에서만 (지우거나 다시 보내지 않음)', rp.includes('msg.edit(') && !rp.includes('showPanel('));

  // 빈 제어판이 실제로 "재생 중 없음" 을 보여주는가
  const { buildPanel: bp } = await import('./src/music/panel.js');
  const emptyPanel = bp({ guild: { id: 'g' }, current: null, queue: [], history: [], loop: false });
  ok('빈 제어판은 재생 중이 아님을 알림', JSON.stringify(emptyPanel.embeds[0].toJSON()).includes('재생 중인 곡이 없습니다'));
}

await new Promise((res) => server.close(res));
fs.rmSync('./data/verify-images', { recursive: true, force: true });
fs.rmSync('./data/verify-data', { recursive: true, force: true });
console.log(fail === 0 ? '\n✅ 전부 통과' : `\n❌ 실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
