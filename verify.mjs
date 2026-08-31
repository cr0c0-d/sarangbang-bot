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
ok('명령어 24개 로드', allCommands.length === 24, `(${allCommands.length}개) ${names.join(' ')}`);
ok('명령어 이름 중복 없음', new Set(names).size === names.length);
ok('영문 명령어 잔존 없음',
  !names.some((n) => /^[a-z]/.test(n)), names.filter((n) => /^[a-z]/.test(n)).join(',') || '없음');
for (const need of ['채널설정', '채널확인', '채널해제', '재생', '핑', '나가기', '이전곡', '대기열제거', '순서이동', '대기열비우기']) {
  ok(`/${need} 존재`, names.includes(need));
}
ok('/읽기중지 제거됨 (나가기로 통합)', !names.includes('읽기중지'));
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
ok('TTS 정제', got === '누군가 야 링크 봐 kek 굵게 ㅋㅋㅋ', JSON.stringify(got));

// 6b) /목소리 선택지가 Edge TTS 에 실제로 존재하는 목소리인가
// (이 검사가 없어서 실재하지 않는 목소리 6개가 들어간 적이 있습니다)
{
  const { listVoices } = await import('./src/tts/synth.js');
  const real = new Set((await listVoices('ko-')).map((v) => v.shortName));
  const cmd = allCommands.find((c) => c.data.toJSON().name === '목소리');
  const choices = cmd.data.toJSON().options[0].choices.map((c) => c.value);
  for (const v of choices) ok(`목소리 실재 ${v}`, real.has(v));
  const { config } = await import('./src/config.js');
  ok('기본 목소리 실재', real.has(config.tts.voice), config.tts.voice);
  ok('기본 목소리가 다국어', config.tts.voice.includes('Multilingual'), config.tts.voice);
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

await new Promise((res) => server.close(res));
fs.rmSync('./data/verify-images', { recursive: true, force: true });
fs.rmSync('./data/verify-data', { recursive: true, force: true });
console.log(fail === 0 ? '\n✅ 전부 통과' : `\n❌ 실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
