# 사랑방봇 (sarangbang-bot) 설계 문서

이 문서는 **다른 개발자 또는 LLM 에이전트가 이 프로젝트를 처음 열었을 때
코드를 다 읽지 않고도 안전하게 수정할 수 있도록** 쓰였습니다.
"무엇을 하는가"보다 **"왜 이렇게 되어 있는가"와 "건드리면 깨지는 것"**에 무게를 둡니다.

작성 시점: 2026-08-31 / 소유자: jychoi@archseoul.com

---

## 0. 한 문단 요약

**사랑방봇(sarangbang-bot)** — Node.js(ESM) 단일 프로세스 디스코드 봇.
하나의 봇 계정으로 세 가지 기능을 제공한다.
(1) 유튜브 링크/검색어 → 음성채널 음악 스트리밍, (2) 특정 채팅방 글 → 음성채널 TTS 낭독,
(3) 특정 채널의 이미지 → 로컬 폴더 자동 정리 + 다중 선택 개별 다운로드 웹 갤러리.
외부 유료 API를 쓰지 않는다. 상태는 대부분 메모리에 있고, 채널 설정과 이미지 메타데이터만 JSON 파일로 남는다.
소유자의 개인 서버 **2~3개**에서 함께 쓴다. 런타임 상태는 길드별로 분리되어 있다(9절 3번 참고).

---

## 1. 환경 전제

| 항목 | 값 | 비고 |
|---|---|---|
| Node.js | v24.15.0에서 개발·검증 | `engines: >=20`. top-level await, `Readable.fromWeb`, 전역 `fetch` 사용 |
| 모듈 시스템 | ESM (`"type": "module"`) | 모든 상대 import는 **확장자 `.js` 필수** |
| OS | Windows 11에서 개발, Linux 이식 고려 | 경로는 전부 `node:path`로 조립 |
| ffmpeg | `ffmpeg-static` npm 패키지 | 시스템 PATH에 의존하지 않음 |
| yt-dlp | `bin/yt-dlp.exe` (Windows) / `bin/yt-dlp` | `npm run update-ytdlp`로 받음. **git에 커밋 안 함** |
| Python | **불필요** | TTS도 Node 구현체(`msedge-tts`)를 씀 |

### 검증된 의존성 버전

```
discord.js        14.27.0
@discordjs/voice   0.19.2
prism-media         1.3.5   (@discordjs/voice가 내부적으로 사용)
libsodium-wrappers          (음성 암호화. 없으면 음성 연결 자체가 실패)
ffmpeg-static               (libopus 인코더 + Ogg Opus 먹서 포함 확인함)
msedge-tts                  (Microsoft Edge TTS 웹소켓 래퍼)
express                     (이미지 갤러리)
opusscript                  (예비용. 현재 경로에서는 실제로 쓰이지 않음 — 3.3절 참고)
dotenv
```

---

## 2. 파일 지도

```
src/
  index.js              진입점. 클라이언트 생성, 이벤트 라우팅, 웹서버 기동, 종료 처리
  config.js             .env 파싱 + 필수값 검증. 값이 없으면 여기서 프로세스를 죽인다
  commands.js           모든 슬래시 명령어를 모으는 곳 + /핑, /도움말
  channel-commands.js   /채널설정 /채널확인 /채널해제
  settings.js           ★ 명령어로 바꾼 설정을 기억 (data/settings.json). .env 를 덮어씀
  deploy-commands.js    슬래시 명령어를 디스코드에 등록 (npm run deploy)

  audio/
    ffmpeg.js           아무 오디오 → Ogg Opus 48kHz 스테레오 변환 (spawn 래퍼)
    guild-audio.js      ★ 서버당 음성 상태 전체. 음악 큐 + TTS 끼어들기 조정

  music/
    ytdlp.js            yt-dlp 프로세스 래퍼. 메타데이터 조회 + 오디오 스트림 생성
    commands.js         /재생 등 음악 명령어 + 채팅방 유튜브 링크 자동 감지

  timer/
    index.js            TTS 타이머 + 단어 등록 (data/timers.json 에 저장)

  tts/
    synth.js            텍스트 → mp3 스트림 (msedge-tts) + 연결 예열
    index.js            메시지 정제(멘션/이모지/링크 처리) + TTS 명령어

  images/
    store.js            ★ 디스크 저장소. 경로 안전장치, 폴더 결정 규칙, 메타데이터
    commands.js         이미지 자동 저장 훅 + /폴더 등 명령어

  web/
    server.js           Express 갤러리. HTML/CSS/JS를 이 파일 안에 문자열로 들고 있음

scripts/update-ytdlp.mjs  yt-dlp 바이너리 다운로더
bin/                      yt-dlp 바이너리 (gitignore)
data/settings.json        /채널설정 으로 바꾼 값 (gitignore)
data/timers.json          진행 중인 타이머 + 등록한 알람 단어 (gitignore)
data/images/              저장된 이미지 + _meta.json + _folders.json (gitignore)
```

★ 표시된 세 파일이 이 프로젝트의 무게중심이다. 수정 전에 반드시 읽을 것.

---

## 3. 핵심 설계 결정과 근거

각 항목은 **"왜 다른 방법을 쓰지 않았는지"**를 포함한다. 되돌리기 전에 읽을 것.

### 3.1 유튜브 추출: `ytdl-core` 계열이 아니라 `yt-dlp` 바이너리

- `ytdl-core` / `@distube/ytdl-core` 같은 순수 JS 라이브러리는 유튜브가 서명 알고리즘을
  바꿀 때마다 깨지고, 수리까지 며칠씩 걸린다. 개인용 봇이 가장 자주 죽는 원인이다.
- `yt-dlp`는 대응이 며칠이 아니라 몇 시간 단위다. **음악이 안 나오면 90%는
  `npm run update-ytdlp` 로 해결된다.** 이 사실이 README와 에러 메시지에 박혀 있어야 한다.
- 바이너리를 npm 패키지(`youtube-dl-exec` 등)로 받지 않고 `scripts/update-ytdlp.mjs`로
  직접 받는 이유: npm 패키지의 postinstall이 회사 프록시/방화벽에서 자주 실패하고,
  버전을 우리가 원할 때 갱신할 수 없기 때문.

### 3.1-1 yt-dlp 오류 처리: 프로세스 단위 재시도 + 오진 방지

**일시적 오류는 `run()` 안에서 프로세스를 새로 띄워 재시도한다** (25초 × 최대 3회).

- 대표 사례 `The page needs to be reloaded.` 는 유튜브가 간헐적으로 뱉는 거부다.
  같은 영상이 몇 초 뒤엔 정상 동작한다 (실측 확인).
- yt-dlp 자체 `--extractor-retries`(기본 3회)로는 안 잡힌다. 이 오류를 재시도 대상으로
  분류하지 않기 때문이다. **프로세스를 새로 띄워야** 웹페이지와 player JSON을 다시 받는다.
- 재시도 대상은 `isTransient()` 의 목록으로 판단한다. `Video unavailable` 처럼
  다시 해도 안 되는 오류는 **재시도하지 않는다** (사용자를 75초 기다리게 하면 안 되므로).
- 재시도는 **메타데이터 조회(`getTracks`) 경로에만** 있다.
  스트림(`createStream`)은 이미 ffmpeg에 연결된 뒤라 같은 방식으로 재시도할 수 없다.
  스트림 단계에서 이 오류가 실제로 문제가 되는 것을 확인하기 전에는 트랙 단위 재시도를 만들지 말 것.
  (만든다면 `playbackDuration` 같은 추측이 아니라 `skip()`/`stop()` 이 세우는 명시적 플래그로 구분해야 한다)

**"일시적" 분류는 확정이 아니다.** `The page needs to be reloaded` 는 진짜 일시적 딸꾹질일 때도 있고,
**클라우드 IP 차단의 다른 얼굴**일 때도 있다(실측 확인: 같은 서버에서 재시도 3회 후에도 실패,
verbose 로 보면 `playability status: LOGIN_REQUIRED`). 그래서 재시도를 다 쓰고 실패하면
`run()` 이 "일시적이 아닐 수 있다 + IP 차단 가능성 + 진단 명령" 을 메시지에 덧붙인다.
"잠시 뒤 다시 시도하세요" 만 남기면 소유자가 원인을 영원히 못 찾는다.

**yt-dlp 에 JS 런타임을 항상 넘긴다.** `extraArgs()` 가 `--js-runtimes node:${process.execPath}` 를 붙인다.
yt-dlp 는 유튜브 추출에 JS 런타임이 필요한데 기본으로 찾는 건 `deno` 뿐이고 보통 안 깔려 있다
(서버에서 `JS runtimes: none` + deprecation 경고 확인). 이 봇은 Node 로 돌아가므로
`process.execPath` 가 항상 유효한 node 경로다 — 어느 OS에서도 추가 설치가 필요 없다.

**`friendlyError()` 에서 짧은 단어로 오류를 분류하지 말 것.**
예전에 `stderr.includes('bot')` 으로 유튜브 차단을 판별했는데,
프로젝트 폴더 이름이 `sarangbang-bot` 이라 **경로가 찍힌 아무 오류나 "유튜브 차단" 으로 오진**했다.
특히 쿠키 파일 경로가 틀렸을 때 "쿠키를 설정하세요" 라고 안내하는 최악의 조합이 된다.
지금은 `'sign in to confirm'` 전체 문구로만 판별하고, `verify.mjs` 에 회귀 검사가 있다.

### 3.1-2 추출은 곡당 딱 한 번만 — 속도의 핵심

**측정값 (2026-08-31, 가정용 IP):**

| 항목 | 시간 |
|---|---|
| yt-dlp 추출 1회 | **약 2.8초** — `--dump-single-json`, `--print`, `--get-url` 모두 비슷 |
| 추출 후 ffmpeg 이 주소에서 첫 바이트 받기 | **약 100~150ms** |

즉 **무엇을 요청하든 추출 비용은 고정**이다(유튜브 응답 대기). 우리가 줄일 수 있는 건 **횟수**뿐이다.

초기 구현은 `getTracks`(2.8초) → `createStream`(yt-dlp 재실행 2.75초)로 **두 번** 추출해서
첫 곡 재생까지 약 5.5초가 걸렸다. 지금은 `getTracks` 가 `--print` 로
**제목·길이·썸네일·재생주소를 한 번에** 받아오고, 재생할 때 그 주소를 ffmpeg 에 직접 넘긴다.
→ **5.5초 → 2.7초** (실측)

- `createSource(track)` 가 판단한다: 주소가 신선하면(`hasFreshStreamUrl`, 90분) 주소를 그대로,
  아니면 yt-dlp 재실행. 재생목록에서 꺼낸 곡은 주소가 없으므로 후자를 탄다.
- 재생목록은 `--flat-playlist` 로 목록만 가볍게 받는다. 수십 곡의 주소를 미리 다 뽑으면
  오히려 느리고, 대부분 재생 전에 만료된다.
- `-f` 로 **오디오 포맷을 하나만** 고르는 것이 중요하다. 여러 개가 뽑히면 `%(urls)s` 가
  여러 줄이 되어 `--print` 의 줄 순서가 어긋난다. 그래서 `%(urls)s` 를 **마지막**에 둔다.
- 주소는 직접 HTTP 로 받으므로 ffmpeg 에 `-reconnect` 계열 옵션을 붙였다.
  유튜브 CDN 은 긴 곡에서 간헐적으로 연결을 끊는다.

### 3.2 오디오 경로: `yt-dlp → ffmpeg(libopus) → Ogg Opus → discord.js`

```
yt-dlp -o -            ffmpeg -c:a libopus -f opus       @discordjs/voice
(webm/m4a 등)   ──►    (Ogg Opus 48kHz 2ch)        ──►   StreamType.OggOpus
                                                          = 컨테이너만 벗김
```

- 디스코드 음성은 **48kHz 스테레오 Opus**만 받는다.
- 만약 `StreamType.Arbitrary`로 넘기면 discord.js가 내부적으로 PCM으로 풀었다가
  JS Opus 인코더(`opusscript`)로 다시 인코딩한다. `opusscript`는 순수 JS라 느리고,
  1코어짜리 무료 VPS에서는 음이 끊긴다.
- 우리가 미리 ffmpeg의 **네이티브 libopus**로 인코딩해두면 discord.js는 Ogg 컨테이너만
  벗겨서 그대로 보낸다. 재인코딩이 없다 = CPU가 거의 안 든다.
- `opusscript`는 이 경로에서 실제로 호출되지 않지만, 누군가 `StreamType.Arbitrary`로
  바꿨을 때 즉시 죽지 않도록 남겨둔 안전망이다.
- 검증됨: 3분 33초짜리 곡에서 8초 만에 2.5MB Opus 수신, ffmpeg이 `Audio: opus, 48000 Hz, stereo` 출력.

### 3.3 서버당 음성 커넥션은 **하나**뿐이다 — 음악과 TTS의 공존 방식

**제약**: 디스코드 봇은 한 서버(길드)에서 음성채널에 동시에 하나만 접속할 수 있다.
음악용 봇과 TTS용 봇을 따로 만들면 이 제약이 없지만, 사용자는 봇 하나를 원했다.

**해결**: `GuildAudio` 하나가 커넥션 1개 + 플레이어 2개(`musicPlayer`, `ttsPlayer`)를 들고,
구독을 갈아끼우며 TTS가 음악에 **끼어든다**.

```
음악 재생 중  ──TTS 요청──►  musicPlayer.pause(true)
                             subscription.unsubscribe()
                             connection.subscribe(ttsPlayer)
                             ttsPlayer.play(...)  → Playing → Idle 대기
                             connection.subscribe(musicPlayer)
                             musicPlayer.unpause()   ──►  음악 이어서 재생
```

**⚠️ 반드시 지켜야 하는 것 — `connection.subscribe()`는 이전 구독을 끊어주지 않는다.**
`@discordjs/voice` 0.19.2 소스(`VoiceConnection.subscribe`)를 직접 확인했다.
이 메서드는 `state.subscription`만 덮어쓸 뿐, 이전 `PlayerSubscription`을 해제하지 않는다.
두 플레이어가 동시에 구독된 채로 남으면 **둘 다 오디오 패킷을 보내서 소리가 깨진다.**
그래서 `GuildAudio.subscribeTo()`가 항상 `this.subscription?.unsubscribe()`를 먼저 호출한다.
**이 순서를 바꾸거나 생략하지 말 것.**

**대안으로 검토했다가 버린 것들**
- TTS를 음악 큐 뒤에 붙이기 → 노래 끝날 때까지 안 읽어줘서 쓸모없음
- 음악을 끊고 TTS만 → 노래가 사라져서 화남
- 두 소리를 ffmpeg으로 실시간 믹싱 → 구현 복잡도가 v1에 안 맞음

### 3.4 TTS 엔진: `msedge-tts`

- 무료, 가입/API키 불필요, 한국어 음질이 좋다.
- **Edge TTS 가 실제로 주는 한국어 목소리는 3개뿐이다** (2026-08-31 `getVoices()` 실측):
  `ko-KR-HyunsuMultilingualNeural`, `ko-KR-SunHiNeural`, `ko-KR-InJoonNeural`.
  개발 중 Azure 전체 카탈로그에서 가져온 이름 6개를 선택지에 넣었다가, 실재하지 않아
  런타임에 실패할 뻔했다. `data.toJSON()` 은 이름이 문법적으로 유효하면 통과시키므로 못 잡는다.
  그래서 `verify.mjs` 가 **선택지를 `listVoices()` 결과와 대조한다.** 목소리를 건드리면 이 검사를 꼭 돌릴 것.
- **기본 목소리는 `ko-KR-HyunsuMultilingualNeural`(다국어)이다.** 실측 비교:

  | 입력 | SunHi (한국어 전용) | Hyunsu (다국어) |
  |---|---|---|
  | 영어 | 5.2초 (한국어 발음으로 늘어짐) | 3.6초 (자연스러움) |
  | 일본어 | **0 바이트 — 무음, 에러도 없음** | 2.7초 |
  | 중국어 | 2.6초 (한자 음독) | 2.5초 |
  | 한영 혼합 | 4.0초 | 4.0초 |

  Hyunsu 가 지는 입력이 없고 SunHi 에는 조용한 실패 모드가 있다. 언어 감지 로직을 넣는 것보다
  "전부 처리하는 목소리를 기본으로" 두는 쪽이 코드도 적고 오탐 경로도 없다.
- **TTS가 느린 원인은 합성이 아니라 "식은 연결"이다.** 실측:
  연결을 새로 맺은 뒤 첫 발화 **약 950~1900ms**, 따뜻한 연결에서는 **43~81ms**.
  마이크로소프트가 유휴 웹소켓을 끊기 때문에 채팅이 띄엄띄엄 오면 매번 첫 발화 비용을 문다.
  그래서 `synth.js` 가 아주 짧은 문장(`'음'`)을 45초마다 합성해 **연결을 데워둔다**.
  - `prewarm()` 은 봇 시작 시(TTS 설정된 서버가 있으면)와 **누가 음성채널에 들어올 때** 호출한다.
    음성채널 입장은 곧 읽어주기를 쓸 신호이므로 예열 타이밍이 정확하다.
  - 30분간 아무도 안 쓰면 예열을 멈춘다(쓸데없는 통신 방지). 다음 사용 시 다시 시작된다.
  - mp3→Ogg Opus 변환(ffmpeg)은 약 170ms 로 병목이 아니다. msedge-tts 의 webm/opus 출력은
    24kHz 모노라 디스코드(48kHz)에 그대로 못 쓴다 — 변환을 없애려 하지 말 것.
- Google Translate TTS는 200자 제한 + 비공식 + 레이트리밋이 빡세다.
- 인터넷이 필요하다(마이크로소프트 서버와 웹소켓). **오프라인에서는 TTS가 동작하지 않는다.**
- 웹소켓 연결을 `synth.js`에서 캐시하고, 실패하면 한 번 새로 만들어 재시도한다.
  마이크로소프트가 유휴 연결을 끊기 때문에 이 재시도가 없으면 조용히 실패한다.
- 검증됨: "안녕하세요…" → 57KB mp3 생성 → ffmpeg으로 4.78초 Ogg Opus 변환 성공.

### 3.4-1 음성채널은 텍스트 채널이기도 하다

디스코드 음성채널에는 **자체 채팅창**이 있다. discord.js 에서 음성채널은
`isTextBased()` 와 `isVoiceBased()` 를 **둘 다 true** 로 돌려준다
(`BaseGuildVoiceChannel` 에 `TextBasedChannel` 이 적용되어 있어 `messages` 프로퍼티를 가진다).
그 채팅에 올라온 메시지의 `message.channel.type` 은 `GuildVoice` 다.

- 그래서 채널 종류를 검사할 때 **`ChannelType` 목록을 하드코딩하지 말고**
  `isTextBased()` / `isVoiceBased()` 를 쓴다.
  (초기 구현은 `[GuildText, GuildAnnouncement]` 목록으로 검사해서, 사용자가 음성채널 안의 채팅을
  읽어주기 채팅방으로 고를 수 없었다.)
- `resolveTtsVoiceChannel()` 은 **글이 올라온 곳이 음성채널이면 그 채널에서 읽어준다.**
  음성채널 채팅에 쓴 글을 다른 채널에서 읽는 건 말이 안 되기 때문이다.
  우선순위: 명시 설정 > 글이 올라온 음성채널 > 글쓴이가 들어가 있는 음성채널.

### 3.4-2 TTS 타이머: 재시작을 견뎌야 한다

`src/timer/index.js`. 시간이 되면 TTS로 음성채널에 알리고 채팅으로 멘션한다.

**`data/timers.json` 에 저장한다.** 진행 중인 타이머를 메모리에만 두면
배포로 재시작할 때마다 사라진다 — 60분 타이머를 걸어놓고 배포하면 그냥 없어진다.
`initTimers()` 가 시작 시 되살리고, **이미 지난 것은 3초 뒤 발동시키며
"몇 분 늦었다"고 밝힌다**(조용히 삼키면 사용자는 알람이 안 왔다고만 생각한다).

- `setTimeout` 은 약 24.8일이 한계다. 최대 24시간으로 제한해 그 근처에 가지 않는다.
- 등록 단어(`words`)는 서버별로 저장한다. `/타이머` 의 **자동완성**이
  프리셋과 등록 단어를 함께 보여주므로 사용자가 외울 것이 없다.
  자동완성은 `interaction.isAutocomplete()` 로 `index.js` 에서 분기한다.
- `/타이머` 는 **등록 단어를 시간 해석보다 먼저** 확인한다.
  "라면" 처럼 시간으로 읽히지 않는 값을 받으려면 이 순서여야 한다.
- `parseMinutes()` 는 `15` `15분` `1시간 30분` `90m` `1h30m` `30초` 를 받는다.
  `0` 과 음수는 거부한다(즉시 발동하는 타이머는 사용자 의도가 아니다).
- **알람은 멘션으로 알린다.** 음악 제어판은 `SuppressNotifications` 로 조용히 갱신하지만,
  알람은 알림이 울리지 않으면 존재 이유가 없다. 이 차이는 의도적이다.
- 버튼 `customId` 는 `t:` 로 시작한다 (음악은 `m:`). `index.js` 가 앞머리로 분기한다.

### 3.5 이미지 일괄 다운로드: ZIP이 아니라 **웹 갤러리**

**사용자의 원래 요구**: "여러 장 선택하고 다운로드 버튼을 누르면 한 장씩 다 내려받기.
디스코드는 개별적으로 눌러야 해서 귀찮다." — 즉 **ZIP은 명시적으로 원하지 않는다.**

- 디스코드 봇 업로드 한도: 부스트 없음 10MB / 레벨2 25MB / 레벨3 100MB.
  사진 몇 장이면 넘는다. ZIP 첨부는 애초에 성립하지 않는다.
- 디스코드 UI에는 "여러 장 선택 → 개별 저장" 기능이 없다. 봇으로도 만들 수 없다.
- 브라우저는 같은 출처의 `<a download>`를 연달아 클릭하면 파일을 각각 저장한다.
  그래서 Express로 작은 갤러리를 띄우고, 체크박스 다중선택 + 순차 클릭으로 구현했다.
  크롬은 최초 1회 "여러 파일을 다운로드하시겠습니까?"를 묻고, 허용하면 이후 조용하다.
- 클릭 간격 **350ms**는 임의값이 아니다. 너무 빠르면 브라우저가 일부 요청을 버린다.
  줄이려면 실제로 20장 이상으로 테스트해볼 것.

### 3.6 폴더 결정 규칙 (외울 명령어를 줄이는 쪽으로)

`store.js` `resolveFolder(channel, channelId)` — 위에서부터 먼저 맞는 것을 쓴다.

1. 메시지가 **스레드** 안에 있으면 → **스레드 이름**
2. 그 채널에 `/폴더 <이름>`으로 지정한 값이 있으면 → 그 이름 (`_folders.json`에 저장)
3. **채널 이름** (기본값)
4. 채널 이름을 알 수 없을 때만 → 오늘 날짜 `YYYY-MM-DD`

**감시 대상은 기본이 "전부"다.** `settings.js` 의 `imageChannelAllowed()` 가 판단하는데,
`imageChannelIds` 가 비어 있으면 **봇이 볼 수 있는 모든 채널**을 저장한다(소유자 요구).
목록이 있으면 그 채널들만. 즉 이 설정은 on/off 가 아니라 **필터**다.
실질적인 경계는 디스코드 권한이다 — 봇이 못 보는 채널은 메시지 자체가 오지 않는다.
`imagesEnabled()` 는 항상 `true` 를 돌려준다(하위호환용으로 남겨둠).

3번이 기본값인 이유: 사용자가 아무 설정도 하지 않아도 `#여행사진` 채널의 사진이
`여행사진` 폴더로 가는 게 가장 예측 가능하고, 외울 명령어가 0개다.
(초기 구현은 날짜가 기본값이었는데, 채널이 여러 개면 날짜 폴더 하나에 다 섞여서 쓸모없었다.)

⚠️ **채널 이름을 바꾸면 그때부터 새 폴더가 생긴다.** 이전 사진은 옛 이름 폴더에 남는다.
요구사항상 불가피하며, 데이터가 사라지는 것은 아니다. 갤러리의 "옮기기"로 합칠 수 있다.

⚠️ **폴더 이름 공간은 서버 전체에서 하나다.** 저장 경로에 길드 구분이 없으므로,
서로 다른 서버의 `#사진` 채널 둘은 같은 `data/images/사진` 에 쌓인다.
파일이 덮어써지지는 않지만(중복 이름에 `-1` 이 붙는다) 갤러리에서 섞여 보인다.

**의도적으로 이 상태를 유지하고 있다.** 경로에 길드 차원을 넣으려면
`folderPath` / `filePath` / `listFolders` / `listFiles` / `moveFiles` / `deleteFiles` /
`_meta.json` 키 형식 / 웹 라우트 3개 / 갤러리 템플릿 2개 / `/갤러리` URL 조립을 모두 고쳐야 하고,
그 중 앞의 두 개가 **불변조건 2(경로 탈출 방어)** 의 핵심이다. 이득 대비 위험이 크다.

**우회 수단이 이미 있다**: `/폴더 <이름>` 은 채널별로 저장되고 채널 이름 기본값을 이긴다.
한쪽 서버에서 `/폴더 B서버사진` 을 실행하면 영구히 분리된다.
사용자가 실제로 이 충돌에 불편을 겪는다고 말하기 전에는 재구조화하지 말 것.
할 때는 **명령어 등록 변경 같은 다른 작업과 묶지 말고 단독으로** 하고, 경로 검사를 다시 검증할 것.

`explainFolder()` 는 `/폴더확인` 이 "왜 이 폴더인지"를 사람 말로 보여주기 위한 짝 함수다.
규칙을 바꾸면 두 함수를 같이 고쳐야 한다.

### 3.6-1 음악 제어판: 버튼 + 메시지 재사용

`music/panel.js` 가 임베드 + 버튼 + 드롭다운을 만든다. `customId` 는 `m:` 로 시작하고
`index.js` 의 `InteractionCreate` 에서 `isButton() || isStringSelectMenu()` 로 분기한다.

**왜 슬래시 명령어가 아니라 버튼인가**: 이 봇은 비개발자 친구들이 함께 쓴다.
`/순서이동 3 1` 을 외우게 하면 아무도 안 쓴다. 소유자가 명시적으로 요구한 제약이다.

**제어판은 항상 채팅방의 맨 아래에 있어야 한다** (소유자 요구: "곡을 추가할 때마다
밀려올라가서 불편하다"). `showPanel()` 의 규칙:

1. 제어판이 **이미 맨 아래**면 → 그 메시지를 **수정**만 한다 (채팅방이 안 더러워짐)
2. 다른 메시지에 **밀려 올라갔으면** → 옛 제어판을 **지우고 맨 아래에 다시** 띄운다
3. 새로 보낼 때는 **`MessageFlags.SuppressNotifications`** 를 붙인다 → 푸시 알림이 울리지 않는다
   (소유자 요구: "알림은 따로 안 울렸으면 좋겠다")

맨 아래인지는 `channel.messages.fetch({limit:1})` 로 확인한다. API 호출 1회가 늘지만
"밀려났는데 그대로 수정" 하는 것보다 낫다.

**동시 호출을 `audio.panelChain` 으로 직렬화한다.** 곡 추가와 곡 전환이 겹치면
제어판이 두 개 생긴다.

그리고 **유튜브 링크 메시지는 성공 시 삭제한다**(`handleMusicMessage`).
이게 쌓이는 것이 제어판이 밀려나는 주된 원인이다.
**`Manage Messages` 권한이 필요하다** — 없으면 삭제가 실패하므로 ✅ 반응으로 대체하고
콘솔에 경고를 남긴다(재생 자체는 정상 동작). 초대 권한 숫자가 3263552 → 3271744 로 바뀌었다.
실패했거나 일부만 성공한 메시지는 **지우지 않는다** — 무엇을 보냈는지 봐야 하므로.

**드롭다운은 25개 제한**이 있다(디스코드 규격). 대기열이 더 길면 앞 25곡만 담긴다.

### 3.6-2 대기열 이동의 "의도"를 추측하지 말 것

`requestPlay(intent)` / `playNext(intent)` 의 `intent` 는 `'auto' | 'next' | 'previous'` 다.

곡이 자연 종료된 것, 사용자가 `/다음` 을 누른 것, `/이전곡` 을 누른 것은 **전부
`musicPlayer` 를 Idle 로 만들어 같은 `onTrackEnd()` 경로를 탄다.** 그런데 해야 할 일이 다르다.

| intent | 동작 |
|---|---|
| `auto` | 반복재생이 켜져 있으면 같은 곡을 다시, 아니면 기록에 넣고 다음 곡 |
| `next` | 반복재생이라도 **다음 곡으로** (건너뛰기가 같은 곡을 또 트면 안 됨) |
| `previous` | 현재 곡을 대기열 맨 앞으로 되돌리고, `history` 에서 이전 곡을 꺼냄 |

`nextIntent` 필드에 담아 `onTrackEnd()` 가 읽어간다.
**재생 시간(`playbackDuration`)이나 `current` 가 null 인지 같은 것으로 추측하지 말 것.**
초기 구현이 `skip()` 에서 `loop` 를 잠깐 끄고 `current` 를 null 로 만드는 방식이었는데,
정상 동작이 순서의 우연에 의존하고 있어서 다음 사람이 반드시 깨뜨린다.

### 3.6-3 웹 갤러리 인증: 보기는 공개, 파괴적 작업만 잠금

소유자 결정: **"링크만 있다면 아무나 접근 가능하게 하자"** — 친구들이 비개발자라
로그인·암호 단계를 두면 아무도 안 쓴다. 디스코드 OAuth2 기반 채널 권한 연동도 검토했으나
공수 대비 이득이 낮다고 판단해 보류했다(필요해지면 그때 별도 작업으로).

그래서 인증을 **전역 미들웨어에서 경로별로** 나눴다.

| 경로 | 인증 | 이유 |
|---|---|---|
| `GET /f/:folder`, `/img/...`, `/dl/...` | **없음** | 친구들이 링크만 열면 되도록 |
| `GET /` | 없음 | 안내만. **폴더 이름을 노출하지 않는다** |
| `GET /folders` | `requireTokenPage` | 전체 폴더 목록은 소유자 전용 |
| `POST /api/*` | `requireToken` | 삭제·이동은 되돌릴 수 없음 |

인증 실패 응답이 두 종류인 이유:
- `requireToken` (API용) → **JSON 401, `WWW-Authenticate` 없음.**
  브라우저 로그인창이 뜨면 안 되므로. 페이지의 JS 가 직접 암호를 물어 헤더에 붙인다.
- `requireTokenPage` (페이지용) → **`WWW-Authenticate` 포함 401.**
  소유자만 오는 페이지이므로 브라우저 기본 로그인창을 띄우는 게 편하다.

**폴더 이름이 새어나가지 않게 하는 것도 요구사항이다** ("폴더목록을 볼 수 있는건 나만").
그래서 두 곳을 막았다.
1. 루트에서 폴더 목록을 없애고 안내 페이지로 대체
2. 갤러리 페이지의 **이동 대상 폴더 datalist 를 제거** — 인증 없이 렌더되는 HTML 이라
   다른 채널 폴더 이름이 그대로 노출됐다

또 **폴더 안에 "뒤로가기(폴더 목록)" 버튼을 두지 않는다.** 친구가 자기 채널이 아닌
폴더로 넘어갈 통로가 되기 때문이다. 되살리지 말 것.

`/갤러리` 명령은 **그 채널의 폴더**로 바로 링크한다(`resolveFolder`).
목록 링크를 주면 친구들이 401 페이지로 가버린다.

**보기까지 공개하면서 삭제도 공개하면 안 된다.** 공개 포트는 자동 스캐너에 금방 발견되고,
그때 사진이 통째로 지워지면 복구 방법이 없다. 친구들은 삭제·이동을 쓸 일이 없으므로
이 구분은 요청한 편의성을 전혀 해치지 않는다. **이 경계를 없애지 말 것.**

브라우저 쪽은 관리 요청에만 `Authorization: Basic` 을 붙이고, 암호를 `sessionStorage` 에
캐시해 탭 안에서 다시 묻지 않는다. 401 이 오면 캐시를 버리고 한 번 더 묻는다.

### 3.7 메시지 핸들러 우선순위 (채널이 겹칠 때의 동작)

`index.js`의 `MessageCreate` 처리 순서는 의도적으로 이렇게 되어 있다.

```js
await handleImageMessage(message);            // 막지 않음 (early return 없음)
if (await handleMusicMessage(message)) return; // 처리하면 여기서 끝
await handleTtsMessage(message);
```

- **이미지 저장은 다른 기능을 막지 않는다.** 사진에 설명글을 달아 올리면
  저장도 되고 그 글을 읽어주기도 한다. (초기 구현은 early return이라 캡션이 안 읽혔다 — 고침)
- **음악과 TTS는 배타적이다.** 유튜브 링크를 소리내어 읽는 건 의미가 없으므로
  음악이 처리한 메시지는 TTS로 넘기지 않는다.
- **`MUSIC_TEXT_CHANNEL_ID`가 비어 있으면 모든 채널에서 링크를 감지한다.**
  그래서 TTS 채팅방에 유튜브 링크를 써도 읽어주지 않고 재생된다.
  의도된 동작이며 `.env.example`에도 적어두었다. 바꾸려면 음악 채널을 명시적으로 지정하면 된다.

### 3.8 설정은 명령어가 `.env` 를 덮어쓴다

`settings.js` 가 채널 설정의 단일 진입점이다. 우선순위는:

1. `/채널설정` 으로 지정한 값 — `data/settings.json`, 서버(길드)별로 저장
2. `.env` 값
3. 없음 → 그 기능은 꺼진 것으로 취급

**이 구조의 위험은 "조용한 무시"다.** 사용자가 `.env` 를 고치고 재시작했는데
명령어 설정이 이미 있으면 아무 일도 안 일어난다. 에러도 없다.
그래서 `getWithSource()` 가 값과 **출처**를 함께 돌려주고, `/채널확인` 과 시작 로그가
항상 `명령어로 지정` / `.env 기본값` 을 같이 표시한다. **이 표시를 없애지 말 것.**

부수 효과: 채널이 런타임에 바뀔 수 있으므로 **슬래시 명령어는 기능 on/off와 무관하게 전부 등록한다.**
(예전에는 `.env` 가 비면 해당 모듈 명령어를 등록하지 않았는데, 그러면
"설정하려는데 설정할 명령어가 없는" 상태가 된다.)

기능 on/off 판정도 `config` 가 아니라 `ttsEnabled(guildId)` / `imagesEnabled(guildId)` 를 쓸 것.

### 3.9 슬래시 명령어는 길드 단위로 등록한다

`deploy-commands.js`가 `Routes.applicationGuildCommands(clientId, guildId)`를 쓴다.
전역(`applicationCommands`) 등록은 디스코드 전파에 최대 1시간이 걸려서,
초보자가 "봇이 고장났다"고 오해하는 대표적인 지점이다. 개인용 단일 서버이므로 길드 등록이 옳다.

---

## 4. 불변조건 (Invariants) — 어기면 조용히 깨진다

1. **`GuildAudio.subscribeTo()`를 거치지 않고 `connection.subscribe()`를 직접 부르지 말 것.**
   3.3절 참고. 소리가 깨진다.
2. **디스크에 경로를 쓰기 전 반드시 `store.js`의 `folderPath()` / `filePath()`를 통과시킬 것.**
   이 두 함수가 `..`, 드라이브 문자, Windows 금지문자를 걷어내고,
   최종 경로가 `data/images` 안쪽인지 `startsWith` 로 다시 검사한다.
   웹 갤러리의 `/img/:folder/:file`, `/dl/...`이 사용자 입력을 그대로 받으므로
   **이 검사를 우회하면 서버의 임의 파일이 읽힌다.**
3. **`MessageContent` 인텐트가 없으면 `message.content`가 빈 문자열이 된다.**
   개발자 포털에서 켜야 하고, 코드는 정상인데 TTS와 링크 감지만 조용히 죽는다.
   증상이 "에러는 없는데 아무 반응이 없다"라면 여기부터 볼 것.
4. **`libsodium-wrappers`를 지우지 말 것.** 음성 암호화용이고, 없으면 음성 연결 시점에
   예외가 난다. 순수 JS라 Windows에서 빌드툴이 필요없다(`sodium-native`는 컴파일러가 필요).
5. **ESM이므로 상대 import에 `.js` 확장자를 반드시 붙일 것.**
6. **`.env`를 절대 커밋하지 말 것.** 토큰이 노출되면 디스코드가 자동으로 무효화한다.
7. **슬래시 명령어를 추가·개명하면 반드시 `npm run deploy` 를 실행할 것.**
   `PUT applicationGuildCommands` 는 명령어 집합을 통째로 교체하므로 옛 이름은 자동으로 사라지지만,
   deploy 를 안 돌리면 디스코드에는 옛 이름이 그대로 남아 "고쳤는데 안 바뀐다"가 된다.
8. **채널 설정을 읽을 때 `config.*` 를 직접 보지 말고 `settings.js` 를 거칠 것.**
   `config` 만 보면 `/채널설정` 으로 지정한 값이 무시된다. 3.8절 참고.
9. **`/목소리` 선택지에 새 목소리를 넣으면 `npm run verify` 로 실재를 확인할 것.**
   Azure 카탈로그에는 있어도 Edge TTS 무료 엔드포인트에는 없는 목소리가 많다. 3.4절 참고.
10. **숨김 응답은 `ephemeral: true`가 아니라 `flags: MessageFlags.Ephemeral`로 쓸 것.**
   discord.js 14.27에서 `ephemeral` 옵션은 deprecated 되어, 쓸 때마다 콘솔에 경고를 찍는다
   (`InteractionResponses.js`에서 확인). 동작은 하지만 경고가 도배되면 소유자가
   "뭔가 고장났다"고 오해한다. 새 명령어를 추가할 때도 `MessageFlags`를 import 해서 쓸 것.

---

## 5. 상태 모델: `GuildAudio`

서버 ID → `GuildAudio` 인스턴스를 `guild-audio.js`의 모듈 전역 `registry` Map이 들고 있다.
**서버 재시작하면 전부 사라진다. 큐는 의도적으로 영속화하지 않는다.**

```
없음 ──getGuildAudio()──► 생성됨 ──connect()──► Ready
                                                  │
                            ┌─────────────────────┼──────────────────────┐
                            │                     │                      │
                     playNext() 루프         speak() 체인          leaveTimer
                     (musicPlayer)          (ttsPlayer)          (기본 300초)
                            │                     │                      │
                            └─────────────────────┴──────────────────────┘
                                                  ▼
                                            destroy() → registry에서 제거
```

- `destroy()`는 여러 번 불릴 수 있다(`destroyed` 플래그로 방어). 타이머·자식 프로세스·
  커넥션을 전부 정리한다.
- `peekGuildAudio()`는 파괴된 인스턴스를 `null`로 걸러준다. **명령어 핸들러는
  `getGuildAudio()`가 아니라 `peekGuildAudio()`를 써야 한다** — 안 그러면 "재생 중이 없다"고
  답해야 할 상황에서 빈 인스턴스를 새로 만든다.
- `killCurrent`는 현재 곡의 yt-dlp + ffmpeg 자식 프로세스를 죽이는 함수다.
  곡을 넘길 때 반드시 호출해야 좀비 프로세스가 안 쌓인다.
- TTS는 `ttsChain` 프로미스 체인으로 **직렬화**된다. 동시에 여러 메시지가 와도
  한 번에 하나씩 순서대로 읽는다. 이걸 없애면 소리가 겹쳐서 뭉개진다.
- `speak(makeStream, targetChannelId)`의 두 번째 인자는 **줄 서 있는 동안 봇이 다른
  음성채널로 옮겨갔는지** 확인하기 위한 것이다. `TTS_VOICE_CHANNEL_ID`가 비어 있으면
  "말한 사람이 있는 음성채널"로 따라가므로, A채널 사용자와 B채널 사용자가 연달아 글을 쓰면
  커넥션이 옮겨간다. 이때 앞 문장을 그대로 재생하면 **엉뚱한 채널에서 읽고, 음악도 엉뚱한
  곳에서 재개된다.** 그래서 채널이 바뀌었으면 그 문장은 버린다. 이 가드를 지우지 말 것.

---

## 6. 데이터 형식

### `data/images/_meta.json`
키는 `"<폴더명>/<파일명>"`.
```json
{
  "2026-08-31/20260831-141900_photo.png": {
    "folder": "2026-08-31",
    "file": "20260831-141900_photo.png",
    "originalName": "photo.png",
    "size": 184320, "width": 1920, "height": 1080,
    "author": "someone", "authorId": "123...",
    "channelId": "222...", "messageId": "333...",
    "messageUrl": "https://discord.com/channels/...",
    "uploadedAt": "2026-08-31T14:19:00.000Z"
  }
}
```
파일이 지워져도 항목이 남을 수 있다. `listFiles()`는 **디스크를 진실의 원천으로 삼고**
메타데이터는 있으면 붙여주는 방식이라, 불일치가 있어도 갤러리는 정상 동작한다.

쓰기는 `writeChain` 프로미스 체인으로 직렬화한다(동시 저장 시 JSON 깨짐 방지).

### `data/settings.json`
```json
{
  "<길드ID>": {
    "musicTextChannelId": "<채널ID>",
    "musicVoiceChannelId": "<채널ID>",
    "ttsTextChannelId": "<채널ID>",
    "ttsVoiceChannelId": "<채널ID>",
    "imageChannelIds": ["<채널ID>", "..."]
  }
}
```
키 목록은 `settings.js` 의 `KEYS` 가 단일 출처다. 설정을 추가하려면 거기에만 넣으면
`/채널설정` 선택지와 `/채널확인` 표시가 자동으로 따라온다.

### `data/images/_folders.json`
```json
{ "<채널ID>": "<폴더명>" }
```

### Track 객체 (`ytdlp.js` → `guild-audio.js`)
```js
{ title: string, url: string, duration: number|null, uploader: string|null, thumbnail: string|null }
```
큐에는 `{ track, requestedBy }` 형태로 들어간다.

---

## 7. 알려진 함정 (Gotchas)

| 증상 | 원인 | 대처 |
|---|---|---|
| 음악이 갑자기 전부 안 나옴 | 유튜브가 추출 방식을 바꿈 | `npm run update-ytdlp` |
| `The page needs to be reloaded` | 유튜브의 일시적 거부 | 자동 재시도됨(아래 참고). 계속되면 update-ytdlp |
| `Sign in to confirm you're not a bot` | 데이터센터 IP 차단 (AWS/GCP/Oracle에서 흔함) | `.env`의 `YTDLP_COOKIES_FILE`에 쿠키 파일 지정 |
| TTS·링크감지가 에러 없이 무반응 | `MessageContent` 인텐트 꺼짐 | 개발자 포털에서 켜고 재시작 |
| 슬래시 명령어가 안 보임 | `npm run deploy` 안 함 / 봇이 `applications.commands` 없이 초대됨 | 재초대 후 deploy |
| 명령어 이름이 옛것으로 보임 | 개명 후 deploy 안 함 | `npm run deploy` |
| `.env` 를 고쳤는데 반영 안 됨 | `/채널설정` 값이 우선함 | `/채널확인` 으로 출처 보고 `/채널해제` |
| 일본어 TTS가 무음 | 한국어 전용 목소리 | 다국어 목소리로 변경 (3.4절) |
| 음성 연결 시 예외 | `libsodium-wrappers` 누락 | `npm install` |
| 소리가 깨지고 겹침 | 두 플레이어가 동시 구독됨 | 3.3절, `subscribeTo()` 확인 |
| 갤러리에서 일부만 다운로드됨 | 클릭 간격이 짧음 / 브라우저가 다중 다운로드를 막음 | 350ms 간격 조정, 브라우저 권한 허용 |
| 이미지 폴더가 `2026 08 31`처럼 깨짐 | `safeFolderName`의 문자 클래스를 잘못 수정함 | 하이픈·공백은 **지우면 안 됨** |
| 사진이 "어제" 날짜 폴더에 들어감 | 서버 OS 시간대가 UTC | `timedatectl set-timezone Asia/Seoul` (아래 참고) |

**날짜는 현지 시각 기준이다.** `store.js`의 `localDate()` / `localStamp()`가 `getFullYear()` 등
현지 시각 메서드를 쓴다. `toISOString()`으로 되돌리지 말 것 — UTC가 되어 한국시간 오전 0~9시에
올린 사진이 전날 폴더로 들어간다. 대신 **서버 OS의 시간대를 Asia/Seoul로 맞춰야** 의도대로 동작한다.

**과거에 실제로 났던 버그**: `safeFolderName`의 정규식이 하이픈까지 치환하도록 잘못 들어가서
날짜 폴더 `2026-08-31`이 `2026 08 31`이 될 뻔했다. 현재는
`/[<>:"/\\|?*\x00-\x1f]/g` 로, **Windows 금지문자와 제어문자만** 지운다.
여기 손대면 `2026-08-31`이 그대로 유지되는지 반드시 다시 확인할 것.

---

## 8. 검증 방법 (토큰 없이 가능한 것들)

디스코드 토큰 없이도 아래는 전부 확인할 수 있다. 큰 변경 후 돌려볼 것.

```bash
# 문법 검사 (전체 파일)
node --check src/index.js

# yt-dlp 동작 + 버전
./bin/yt-dlp.exe --version

# ffmpeg 인코더 확인 (libopus / opus 먹서가 나와야 함)
node -e "import('ffmpeg-static').then(m=>console.log(m.default))"
```

그리고 저장소 루트의 **`verify.mjs`** 가 나머지를 자동으로 확인한다. 코드를 고쳤으면 이걸 돌릴 것.

```bash
npm run verify
```

더미 `process.env` 값을 채운 뒤 각 모듈을 동적 import 해서 아래를 검사한다.
(마지막에 Windows에서 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 이
찍힐 수 있는데, `process.exit()`와 소켓 종료가 겹쳐서 나는 libuv 잡음이다.
그 위에 `✅ 전부 통과`가 찍혔으면 정상이다.)

- 슬래시 명령어 20개 전부 `data.toJSON()` 통과, `execute` 존재, 이름 중복 없음, 영문 이름 잔존 없음
- `/목소리` 선택지가 `listVoices()` 결과에 실재하고, 기본 목소리가 다국어인지
- 폴더 결정 4순위(스레드 > /폴더 > 채널명 > 날짜)가 순서대로 적용되는지
- 설정 우선순위: 명령어 지정이 `.env` 를 덮어쓰고, 해제하면 되돌아가는지
- `index.js`가 import 하는 이름이 각 모듈에 실제로 존재 (index.js는 실행하면 로그인을
  시도하므로 직접 import 할 수 없어, 소스를 정규식으로 읽어 검사한다)
- `MessageFlags.` 를 쓰는 파일이 전부 그걸 import 했는가 (누락되면 런타임 ReferenceError)
- `ephemeral: true` 잔존 없음 (4절 불변조건 7)
- `"../../Windows"` → `"Windows"`, `"C:\\Windows"` → `"C Windows"` 로 무해화되고
  최종 경로가 `data/images` 안에 머무름
- `"2026-08-31"` 이 변형되지 않음
- `resolveFolder(null, id)` → 날짜, `resolveFolder(스레드, id)` → 스레드 이름
- TTS 정제: `<@1> 야 https://youtu.be/a 봐 <:kek:9> **굵게** ㅋㅋㅋㅋㅋ`
  → `누군가 야 링크 봐 kek 굵게 ㅋㅋㅋ`
- 유튜브 링크 감지 / 일반 문장은 `null`
- 웹 갤러리: 인증 없이 401, 틀린 암호 401, 맞으면 200, 경로 탈출 요청은 4xx

**검증이 닿지 못하는 곳**: 실제 디스코드 토큰을 쓰는 모든 것.
인텐트가 실제로 켜졌는지, `npm run deploy` 가 통과하는지, `joinVoiceChannel` 이 Ready 까지
가는지, 반응(✅) 권한이 있는지는 **봇을 실제로 띄워봐야만 알 수 있다.**
README의 "잘 되는지 확인하는 순서" 1~7단계가 그 역할을 한다.

---

## 9. 아직 안 한 것 / 다음에 할 만한 것

우선순위 순.

1. **자동 테스트가 없다.** 위 8절의 검증을 `node:test`로 옮기면 좋다.
2. **큐 영속화 없음.** 재시작하면 재생목록이 날아간다. 개인용이라 의도적이지만,
   필요하면 `data/queue.json`에 저장.
3. **다중 서버는 지원한다.** 런타임 상태(`registry`, `settings.js`, TTS 설정)가 모두 길드 ID로
   분리되어 있고, `GUILD_ID` 는 쉼표 목록을 받아 `deploy-commands.js` 가 서버별로 등록한다
   (한 곳이 실패해도 나머지는 등록되고, 실패한 길드 ID를 이름으로 알려준다).
   남은 한계는 **이미지 폴더 이름 공간이 서버 전체에서 공유된다**는 것 — 3.6절 참고.
4. **이미지 중복 저장 방지 없음.** 같은 사진을 두 번 올리면 두 번 저장된다.
   해시(sha256) 기반 중복 제거를 넣을 수 있다.
5. **갤러리에 페이지네이션 없음.** 한 폴더에 수천 장이 쌓이면 브라우저가 느려진다.
6. **웹 갤러리 인증이 Basic Auth 단일 비밀번호.** 외부에 열어둘 거라면
   HTTPS(리버스 프록시) + 더 나은 인증이 필요하다.
7. **볼륨 조절 명령어 없음.** `GuildAudio.volume` 필드는 있고 ffmpeg에 전달되지만,
   곡이 바뀔 때만 반영된다(재생 중 변경 불가). 실시간 조절은 `inlineVolume`이 필요하고
   그러면 3.2절의 재인코딩 회피가 깨진다. **트레이드오프를 이해하고 결정할 것.**

---

## 10. VPS 이전 시 체크리스트

1. Node 20+ 설치
2. `git clone` 후 `npm install`
3. **`npm run update-ytdlp`** — 바이너리는 커밋되지 않으므로 반드시 다시 받아야 하고,
   리눅스용을 받는다(스크립트가 플랫폼을 자동 판별)
4. `.env` 생성. 특히 바꿔야 할 것:
   - `IMAGE_DIR` — 리눅스 절대경로(예: `/home/ubuntu/sarangbang-bot/data/images`)
   - `WEB_PUBLIC_URL` — `http://<서버IP>:3000`
   - `WEB_TOKEN` — **외부에 열리므로 반드시 긴 문자열로 설정**
5. 방화벽/보안그룹에서 웹 포트 개방 (기본 3000)
6. `npm run deploy` 후 `npm start`
7. 상시 구동은 `pm2` 또는 systemd 서비스
8. **유튜브 IP 차단을 각오할 것** — 7절 표 참고. 무료 티어에서 가장 흔한 실패 원인이다.

### 무료 호스팅 현실 평가
- t3.micro(1GB RAM)면 개인 서버 1개 기준 성능은 충분하다. 3.2절 덕분에 CPU도 여유.
- 음성 스트리밍 트래픽은 대략 30MB/시간. 프리티어 한도로 문제없다.
- 진짜 병목은 성능이 아니라 **유튜브의 데이터센터 IP 차단**이다.
- Oracle Cloud Always Free가 AWS 프리티어보다 조건이 낫다(기간 무제한). 단 IP 문제는 동일하고,
  **놀고 있으면 인스턴스를 회수해가는 정책**이 있어 조용한 개인 봇에는 오히려 위험하다.
  구체적인 절차와 대응은 **[ORACLE-CLOUD.md](ORACLE-CLOUD.md)** 에 따로 정리했다.
  (2026-08-31 확인 기준 ARM Always Free 총량은 2 OCPU / 12GB이고, 이 봇은 1 OCPU / 6GB로 충분하다.
  linux-arm64용 ffmpeg-static에 `--enable-libopus`가 들어 있음을 바이너리에서 직접 확인했으므로
  3.2절의 오디오 경로가 ARM에서도 그대로 성립한다.)
- 이미지 저장은 디스크를 계속 먹는다. 프리티어 스토리지 한도를 주기적으로 볼 것.
