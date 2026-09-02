// 서버(길드) 하나당 음성 상태를 통째로 관리하는 클래스입니다.
//
// 중요한 제약: 봇은 한 서버에서 음성채널에 "딱 하나"만 접속할 수 있습니다.
// 그래서 음악과 TTS가 하나의 커넥션을 나눠 씁니다.
//   - 음악용 플레이어와 TTS용 플레이어를 따로 두고,
//   - TTS가 들어오면 음악을 pause → TTS 재생 → 끝나면 음악 resume 하는 식으로 끼어듭니다.
// 이렇게 하면 음악 듣는 중에 채팅이 와도 음악이 사라지지 않고 잠깐 멈췄다 이어집니다.
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { config } from '../config.js';
import { userError } from '../user-error.js';
import { volumeScale } from '../settings.js';
import {
  createSource,
  hasFreshStreamUrl,
  getTracks,
  noteDirectFailure,
  noteDirectSuccess,
  updateHint,
  SRC_DIRECT,
  SRC_URL,
  SRC_EXTRACT,
} from '../music/ytdlp.js';
import { toOggOpus } from './ffmpeg.js';
import { showPanel, buildPanel, isMusicHome } from '../music/panel.js';
import { forgetPanel, MUSIC } from '../panel-registry.js';
import { record as recordHistory } from '../music/history.js';

// 음량을 바꿀 때 새 스트림을 준비하는 데 걸리는 시간(초)을 미리 잡아둡니다.
// 이만큼 앞을 내다보고 잘라야, 준비가 끝났을 때 옛 소리와 정확히 이어붙습니다.
// 짧으면 조금 되감기고, 길면 반영이 늦어질 뿐 **끊기지는 않습니다.**
const LEAD_REMOTE_SEC = 1.5; // 유튜브 주소를 ffmpeg 이 직접 받는 경우 (0단계)
const LEAD_URL_SEC = 2.5;    // 뽑아둔 주소를 yt-dlp 가 받는 경우 (1단계, 실측 1.4~2.2초)
const LEAD_PIPE_SEC = 3.5;   // 유튜브에서 다시 뽑는 경우 (2단계, 시작만 1초가 넘습니다 — 실측)

/** 로그에 단계 번호만 찍으면 나중에 아무도 못 읽습니다. */
const SRC_LABEL = ['직접 수신', '뽑아둔 주소', '전체 추출'];

/**
 * 곡이 끝나기 **몇 초 전**에 다음 곡 소리를 미리 열어둘지.
 *
 * 실측(소유자 서버, 1코어 ARM): 주소를 이미 뽑아둔 상태에서도 첫 소리까지 9~11초.
 * 그 시간이 **곡과 곡 사이에 그대로 침묵**으로 들어갑니다.
 * 넉넉히 잡아도 손해가 거의 없습니다 — 미리 연 소리는 파이프가 차면 알아서 멈춰 기다립니다.
 */
const PREPARE_LEAD_SEC = 40;

/** 길이를 모르거나 아주 짧은 곡은 이만큼 지난 뒤에 준비를 시작합니다. */
const PREPARE_MIN_DELAY_SEC = 3;

/**
 * 곡을 **처음부터 다시 틀 수 있는 상태**로 되돌립니다.
 *
 * `srcLevel`(어느 단계로 틀지)·`resumeAt`(몇 초부터 틀지) 은 **한 번의 시도에만**
 * 붙는 값입니다. 그대로 들고 다니면 이렇게 됩니다.
 *   · 🔁 반복·⏮️ 이전 이 곡 **중간**(듣다 만 지점)부터 다시 시작한다
 *   · 한 번 실패한 곡이 그 실행 동안 **가장 느린 단계로 고정된다** —
 *     미리 뽑아둔 주소가 생겨도 빠른 단계로 못 올라온다
 */
const rewind = (item) => ({ track: item.track, requestedBy: item.requestedBy });

/** 준비에 걸리는 시간만큼 앞을 내다봐야 바꿔치기가 매끄럽습니다. (restartAtCurrentPosition) */
function leadFor(level) {
  if (level === SRC_DIRECT) return LEAD_REMOTE_SEC;
  if (level === SRC_URL) return LEAD_URL_SEC;
  return LEAD_PIPE_SEC;
}

/**
 * 새 스트림이 **첫 소리를 낼 준비가 될 때까지** 기다립니다.
 * 이게 있어야 "준비되면 바꿔치기" 가 가능하고, 그래야 침묵이 안 생깁니다.
 * @returns {Promise<boolean>} 소리가 나올 수 있으면 true
 */
function waitForAudio(stream, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    if (stream.readableLength > 0) return resolve(true);
    const finish = (okFlag) => {
      clearTimeout(timer);
      stream.off("readable", onReadable);
      stream.off("end", onDead);
      stream.off("error", onDead);
      resolve(okFlag);
    };
    // 데이터 없이 readable 이 뜨는 경우(끝났을 때)가 있어 길이를 함께 봅니다.
    const onReadable = () => { if (stream.readableLength > 0) finish(true); };
    const onDead = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    stream.on("readable", onReadable);
    stream.once("end", onDead);
    stream.once("error", onDead);
  });
}

/** @type {Map<string, GuildAudio>} */
const registry = new Map();

export function getGuildAudio(guild) {
  let ga = registry.get(guild.id);
  if (!ga || ga.destroyed) {
    ga = new GuildAudio(guild);
    registry.set(guild.id, ga);
  }
  return ga;
}

export function peekGuildAudio(guildId) {
  const ga = registry.get(guildId);
  return ga && !ga.destroyed ? ga : null;
}

export class GuildAudio {
  constructor(guild) {
    this.guild = guild;
    this.connection = null;
    this.subscription = null;

    this.musicPlayer = createAudioPlayer({
      behaviors: { noSubscriberBehavior: NoSubscriberBehavior.Pause },
    });
    this.ttsPlayer = createAudioPlayer({
      behaviors: { noSubscriberBehavior: NoSubscriberBehavior.Pause },
    });

    /** @type {{track: object, requestedBy: string}[]} */
    this.queue = [];
    /** 이전곡 기능을 위한 재생 기록 (최근 30곡) */
    this.history = [];
    /** 다음 곡으로 넘어갈 때의 의도. requestPlay() 참고 */
    this.nextIntent = null;
    this.current = null;
    this.currentResource = null;   // 실제로 얼마나 재생됐는지 확인용
    this.currentOffsetSec = 0;     // 이번 리소스가 몇 초 지점부터 시작했는지 (positionSec 참고)
    this.volumeTimer = null;       // 음량 버튼 연타를 모아서 한 번만 반영
    this.panelTimer = null;        // 곡이 바뀐 뒤 제어판 갱신 (schedulePanelRefresh)
    this.prepStartedAt = null;     // 준비를 시작한 시각 (첫 소리까지 몇 초 걸렸는지 로그용)
    this.directCheckTimer = null;  // 직접 수신이 정말 소리를 냈는지 나중에 확인 (confirmDirectLater)
    this.prepareTimer = null;      // 다음 곡 소리를 미리 열어둘 예약 (schedulePrepareNext)
    this.preparing = false;        // 지금 미리 여는 중인지
    /** @type {{item: object, stream: any, level: number, kill: () => void}|null} 미리 열어둔 소리 */
    this.prepared = null;
    this.restartGen = 0;           // 준비 중에 또 눌렸는지 구분 (restartAtCurrentPosition)
    this.usedDirect = false;       // 이번 곡을 "직접 수신"(0단계) 으로 틀었는지
    this.srcLevel = SRC_DIRECT;    // 이번 곡을 어느 단계로 틀었는지 (ytdlp.js 의 SRC_* 참고)
    this.lastStreamError = null;   // ffmpeg 이 남긴 마지막 오류
    this.killCurrent = null;
    this.loop = false;
    this.textChannel = null; // 제어판을 띄울 곳
    this.panelMessage = null; // 띄워둔 제어판 메시지 (곡이 바뀌면 이걸 수정해서 재사용)
    this.leaveTimer = null;
    this.ttsChain = Promise.resolve(); // TTS를 한 번에 하나씩만 말하도록 줄 세우기
    this.destroyed = false;

    this.musicPlayer.on(AudioPlayerStatus.Idle, () => this.onTrackEnd());
    // 지난 재생 기록은 **소리가 실제로 나기 시작한 순간**에만 남깁니다.
    // 대기열에 넣을 때 남기면 재생에 실패한 곡까지 쌓여서, 다시 골라도 또 실패합니다.
    this.musicPlayer.on(AudioPlayerStatus.Playing, () => {
      // 준비를 시작한 뒤 **첫 소리가 날 때까지** 얼마나 걸렸는지 한 줄로 남깁니다.
      // 느릴 때 "곡 정보" 와 "첫 소리" 중 어디가 느린지 로그만 보고 알 수 있어야 합니다.
      if (this.prepStartedAt) {
        const sec = ((Date.now() - this.prepStartedAt) / 1000).toFixed(1);
        this.prepStartedAt = null;
        console.log(`[music] 첫 소리까지 ${sec}초 · ${SRC_LABEL[this.srcLevel]} · ${this.current?.track?.title ?? ''}`);
      }
      if (this.current) recordHistory(this.guild.id, this.current.track);
      // ⚠️ **여기서 곧바로 "직접 수신 성공" 으로 치면 안 됩니다.**
      //    직접 수신이 거부돼도 플레이어는 Playing 을 잠깐 지나갑니다 — 소리는 안 나는데도.
      //    그걸 성공으로 세면 "두 번 연속 실패하면 끈다" 는 장치가 **매번 0으로 되돌아가**
      //    영영 작동하지 않습니다. 실제로 그랬습니다: 서버 로그에 곡마다
      //    "직접 수신 실패" 가 찍히는데도 다음 곡에서 또 직접 수신부터 시도했습니다.
      //    소리가 3초 넘게 **실제로** 났는지 확인한 뒤에 성공으로 칩니다.
      if (this.usedDirect) this.confirmDirectLater();
      // 곡이 실제로 바뀐 순간에 제어판을 맞춰줍니다.
      // 이게 있어서 버튼 처리 쪽이 "다음 곡이 뜰 때까지" 기다릴 필요가 없어졌습니다.
      this.schedulePanelRefresh();
      // ★ 미리 뽑기는 **지금 곡이 실제로 소리를 내기 시작한 뒤에** 시작합니다.
      //   예전에는 playNext() 끝에서 곧바로 시작했는데, 그때는 지금 곡도 아직
      //   yt-dlp 로 뽑는 중입니다. 코어가 하나뿐인 서버에서 둘이 서로를 굶겨
      //   **지금 듣고 싶은 곡이 더 늦게** 나왔습니다. (실측: 22~25초)
      this.prefetchNext();
      // 그리고 곡이 끝나갈 무렵 다음 곡 **소리까지** 미리 열어둡니다. (전환이 즉시가 됩니다)
      this.schedulePrepareNext();
    });
    this.musicPlayer.on('error', (err) => {
      console.error('[music] 재생 오류:', err.message);
      this.notify('⚠️ 재생 중 오류가 났습니다: ' + err.message);
    });
    this.ttsPlayer.on('error', (err) => console.error('[tts] 재생 오류:', err.message));
  }

  // ── 접속 ────────────────────────────────────────────────

  async connect(voiceChannel) {
    if (
      this.connection &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      this.connection.joinConfig.channelId === voiceChannel.id
    ) {
      return this.connection;
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed) return;
      // 채널 이동이나 순간적인 네트워크 끊김이면 스스로 복구됩니다.
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // 돌아오는 "중" 인 것만으로는 부족합니다. 정말 다시 붙는지까지 확인합니다.
        // 여기서 멈추면 죽은 커넥션을 붙잡은 채 제어판이 계속 "재생 중" 이라고 합니다.
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        // 5초 안에 돌아오지 못했습니다. 대부분 **우클릭 → "연결 끊기"** 로 내보낸 경우입니다.
        // /나가기 와 달리 아무 명령도 거치지 않으므로, 여기서 알려주지 않으면
        // 제어판만 조용히 사라져서 "왜 멈췄지?" 가 됩니다.
        if (this.destroyed) return;
        if (this.current || this.queue.length > 0) {
          this.notify('🔌 음성채널에서 연결이 끊겨 재생을 멈췄습니다.\n다시 들으시려면 유튜브 링크를 붙여넣어 주세요.');
        }
        this.destroy(); // 제어판도 여기서 지워집니다
      }
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch {
      this.destroy();
      throw userError(
        '음성채널 접속에 실패했습니다. 봇에게 "연결(Connect)"과 "말하기(Speak)" 권한이 있는지 확인해주세요.'
      );
    }

    this.subscribeTo(this.musicPlayer);
    return this.connection;
  }

  subscribeTo(player) {
    if (!this.connection) return;
    // connection.subscribe()는 이전 구독을 자동으로 끊어주지 않습니다.
    // 두 플레이어가 동시에 소리를 보내면 섞여서 깨지므로 직접 끊어줍니다.
    this.subscription?.unsubscribe();
    this.subscription = this.connection.subscribe(player) ?? null;
  }

  // ── 음악 ────────────────────────────────────────────────

  add(tracks, requestedBy) {
    for (const track of tracks) this.queue.push({ track, requestedBy });
    this.cancelLeaveTimer();

    // 듣고 있는 중에 담았다면 **다음 곡 주소를 지금** 미리 뽑아둡니다.
    //
    // 왜 여기도 필요한가: 재생목록에서 담은 곡은 주소가 비어 있습니다(--flat-playlist).
    // prefetchNext() 는 playNext() 끝에서만 불렸으므로, 재생 중에 재생목록을 담으면
    // **지금 곡이 끝난 뒤에야** 추출이 시작되어 그만큼 조용해졌습니다.
    //
    // 대기 중일 때는 하지 않습니다 — 곧 playNext() 가 그 곡을 바로 틀 텐데,
    // 1코어 서버에서는 쓸데없는 yt-dlp 하나가 opus 인코딩과 CPU를 다툽니다.
    if (this.isPlaying) this.prefetchNext();
  }

  get isPaused() {
    return this.musicPlayer.state.status === AudioPlayerStatus.Paused;
  }

  get isPlaying() {
    const s = this.musicPlayer.state.status;
    return (
      s === AudioPlayerStatus.Playing ||
      s === AudioPlayerStatus.Buffering ||
      s === AudioPlayerStatus.Paused
    );
  }

  playIfIdle() {
    if (this.musicPlayer.state.status === AudioPlayerStatus.Idle) this.playNext();
  }

  /**
   * 곡을 넘길 때의 "의도"를 명시적으로 전달합니다.
   *
   * 왜 필요한가: 곡이 끝나는 것과, 사용자가 /다음 을 누른 것과, /이전곡 을 누른 것은
   * 전부 musicPlayer 를 Idle 로 만들어 같은 경로를 타지만, 해야 할 일이 다릅니다.
   *   auto     — 자연 종료. 반복재생이 켜져 있으면 같은 곡을 다시
   *   next     — 사용자가 건너뜀. 반복재생이라도 다음 곡으로 가야 함
   *   previous — 현재 곡은 대기열 앞으로 되돌리고, 기록에서 이전 곡을 꺼냄
   * 추측(재생 시간 같은 것)으로 구분하면 반드시 어긋납니다.
   */
  requestPlay(intent) {
    this.nextIntent = intent;
    if (this.musicPlayer.state.status === AudioPlayerStatus.Idle) {
      this.nextIntent = null;
      this.playNext(intent);
    } else {
      // stop() → Idle 이벤트 → onTrackEnd() 가 nextIntent 를 읽어 갑니다.
      this.musicPlayer.stop(true);
    }
  }

  pushHistory(item) {
    // 기록에서 꺼내 다시 틀 때도 처음부터 나와야 합니다. (rewind 설명 참고)
    this.history.push(rewind(item));
    if (this.history.length > 30) this.history.shift();
  }

  playNext(intent = 'auto') {
    // 곡이 바뀌므로 대기 중이던 음량 반영은 의미가 없습니다.
    clearTimeout(this.volumeTimer);
    this.volumeTimer = null;
    // 예약해둔 "다음 곡 미리 열기" 도 의미가 없습니다. 지금 곡이 시작되면 다시 겁니다.
    clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    this.killCurrent?.();
    this.killCurrent = null;

    const outgoing = this.current;
    this.current = null;

    // ★ 되돌릴 때는 rewind() 를 반드시 통과시킵니다. 안 그러면 반복·이전이
    //   곡 중간부터 시작하고, 한 번 실패한 곡이 느린 단계에 갇힙니다.
    if (outgoing) {
      if (intent === 'previous') {
        // 이전 곡으로 돌아가므로 현재 곡은 대기열 맨 앞으로 되돌립니다.
        this.queue.unshift(rewind(outgoing));
      } else if (this.loop && intent === 'auto') {
        this.queue.unshift(rewind(outgoing));
      } else {
        this.pushHistory(outgoing);
      }
    }

    if (intent === 'previous') {
      const prev = this.history.pop();
      if (prev) this.queue.unshift(prev);
    }

    const item = this.queue.shift();
    if (!item) {
      // 더 틀 게 없습니다. 제어판이 "지금 재생 중" 인 채로 굳지 않게 갱신합니다.
      this.refreshPanel();
      this.scheduleLeave();
      return;
    }

    this.current = item;

    try {
      this.prepStartedAt = Date.now(); // 첫 소리까지 몇 초 걸렸는지 재려고 (Playing 에서 찍습니다)

      // ★ 미리 열어둔 소리가 **바로 이 곡의 것**이면 그대로 씁니다 → 전환이 즉시입니다.
      //   같은 곡인지는 객체가 같은지로 봅니다. 대기열이 바뀌었거나 재시도로 새로 만든
      //   항목이면 다른 객체라 자동으로 걸러집니다. 안 쓰게 된 것은 반드시 정리합니다.
      let ready = null;
      if (this.prepared) {
        // ⚠️ `dead` 를 **여기서 다시** 봐야 합니다. 준비할 때 살아 있었다는 것은
        //    지금도 살아 있다는 뜻이 아닙니다 (노는 연결은 끊깁니다).
        if (this.prepared.item === item && !this.prepared.dead) {
          ready = this.prepared;
          this.prepared = null;
        } else {
          this.dropPrepared();
        }
      }

      let stream;
      let kill;
      if (ready) {
        ({ stream, kill } = ready);
        this.usedDirect = ready.level === SRC_DIRECT;
        this.srcLevel = ready.level;
        this.lastStreamError = null;
        this.killCurrent = kill;
      } else {
        // 가장 빠른 단계부터 시작합니다. item.srcLevel 은 "그 단계가 실패해서
        // 한 칸 내려가 다시 시도하는 중" 이라는 뜻입니다. (ytdlp.js 의 SRC_* 참고)
        const src = createSource(item.track, { level: item.srcLevel ?? SRC_DIRECT });
        this.usedDirect = src.remote;
        this.srcLevel = src.level;
        this.lastStreamError = null;

        ({ stream, kill } = toOggOpus(src.input, {
          volume: volumeScale(this.guild.id, 'music'),
          seekSec: item.resumeAt ?? 0,
          remote: src.remote,
          onError: (msg) => {
            this.lastStreamError = msg;
          },
        }));
        this.killCurrent = () => {
          kill();
          src.kill();
        };
      }

      const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
      this.currentResource = resource;
      this.currentOffsetSec = item.resumeAt ?? 0;
      this.musicPlayer.play(resource);
      // 텍스트 알림 대신 버튼이 달린 제어판을 보여줍니다. (기존 제어판이 있으면 수정)
      showPanel(this, this.textChannel);
      // ⚠️ 여기서 prefetchNext() 를 부르지 마세요. 지금 곡이 아직 뽑히는 중이라
      //    코어 하나를 두고 다투게 됩니다. 소리가 나기 시작한 뒤(Playing)에 시작합니다.
    } catch (err) {
      console.error('[music] 스트림 생성 실패:', err);
      this.notify('⚠️ **' + item.track.title + '** 을(를) 재생할 수 없어 건너뜁니다.\n' + err.message);
      setImmediate(() => this.playNext());
    }
  }

  /**
   * 바뀐 음량을 **지금 재생 중인 곡에** 바로 반영합니다.
   *
   * ffmpeg 의 -af volume 은 프로세스를 띄울 때 정해지므로, 이미 흐르는 소리는 못 바꿉니다.
   * 그래서 **재생 중이던 지점부터 다시 트는** 방식으로 반영합니다 (약 1초 끊깁니다).
   *
   * AudioPlayer.play() 를 재생 중에 부르면 Idle 이벤트 없이 바로 새 소리로 넘어가므로,
   * onTrackEnd() 가 "곡이 끝났다" 고 오해하지 않습니다. (실제 동작 확인함)
   */
  reapplyVolume() {
    if (!this.current || !this.isPlaying) return false;

    // 🔉 🔊 버튼은 연달아 누르게 됩니다(+10 +10 +10). 누를 때마다 다시 틀면
    // 그때마다 끊기고, 심하면 다시 트는 중에 또 눌러서 엉킵니다.
    // 손을 뗀 뒤 한 번만 반영합니다.
    // 미리 열어둔 다음 곡에는 **바뀌기 전 음량이 박혀 있습니다**(ffmpeg 은 띄울 때 정해집니다).
    // 그대로 쓰면 다음 곡만 옛 음량으로 나옵니다. 버리고 다시 엽니다.
    this.dropPrepared();
    this.schedulePrepareNext();

    const item = this.current;
    clearTimeout(this.volumeTimer);
    this.volumeTimer = setTimeout(() => {
      this.volumeTimer = null;
      if (this.destroyed || this.current !== item) return; // 그 사이 곡이 바뀌었습니다
      this.restartAtCurrentPosition().catch((err) => console.error("[music] 음량 반영:", err.message));
    }, 500);
    return true;
  }

  /**
   * 듣던 지점부터 다시 틉니다. 새 음량이 여기서 적용됩니다.
   *
   * **순서가 핵심이다.** 예전에는 옛 소리를 먼저 끊고 새 스트림을 만들었는데,
   * 그러면 준비되는 몇 초가 통째로 침묵이었다. 게다가 새 스트림이 실패하면
   * 이미 끊어놓은 뒤라 재시도 경로를 타고 **곡이 처음부터** 다시 시작됐다.
   *
   * 그래서 **준비를 다 끝낸 뒤에 바꿔치기하고, 그 다음에 옛것을 끊는다.**
   *   - 침묵이 없다 (준비하는 동안 옛 소리가 계속 난다)
   *   - 실패해도 듣던 소리가 그대로 이어진다 (아무 일도 없던 것이 된다)
   */
  async restartAtCurrentPosition() {
    if (!this.current || !this.isPlaying) return false;

    const item = this.current;
    // 준비 중에 또 눌리면 앞의 것은 버려야 합니다. 세대 번호로 구분합니다.
    const gen = ++this.restartGen;

    let prepared;
    let resumeAt;
    try {
      const src = createSource(item.track, { level: item.srcLevel ?? SRC_DIRECT });

      // 준비하는 동안에도 **옛 소리는 계속 납니다.** 그만큼 앞을 내다보고 잘라야
      // 바꿔치기하는 순간에 겹치지도, 끊기지도 않습니다.
      // yt-dlp 를 거치는 쪽은 시작만 1초가 넘어서(실측) 더 넉넉히 잡습니다.
      const lead = leadFor(src.level);

      // ★ playbackDuration 은 **지금 리소스**가 재생한 시간만 셉니다.
      //   다시 틀면 새 리소스는 0 부터 세므로, 건너뛴 만큼(currentOffsetSec)을
      //   더하지 않으면 **두 번째 조절부터 곡이 처음으로 되돌아갑니다.** (실제로 겪은 버그)
      resumeAt = Math.max(0, this.positionSec() + lead);

      const { stream, kill } = toOggOpus(src.input, {
        volume: volumeScale(this.guild.id, 'music'),
        seekSec: resumeAt,
        remote: src.remote,
        onError: (msg) => {
          this.lastStreamError = msg;
        },
      });
      prepared = {
        stream,
        remote: src.remote,
        level: src.level,
        kill: () => {
          kill();
          src.kill();
        },
      };
    } catch (err) {
      console.error('[music] 음량 반영 실패:', err.message);
      return false;
    }

    // 첫 소리가 나올 준비가 될 때까지 기다립니다. 그동안 옛 소리는 계속 납니다.
    const ready = await waitForAudio(prepared.stream);
    if (!this.isCurrentStill(item, gen) || !ready) {
      prepared.kill();
      if (ready === false && this.isCurrentStill(item, gen)) {
        // 듣던 소리는 멀쩡하므로 아무것도 하지 않습니다. 예전에는 여기서 곡이 처음으로 돌아갔습니다.
        console.warn('[music] 음량 반영 실패 — 듣던 소리를 그대로 둡니다');
      }
      return false;
    }

    // 옛 소리가 잘라둔 지점에 닿을 때까지만 더 기다렸다가 바꿔치기합니다.
    const waitMs = (resumeAt - this.positionSec()) * 1000;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    if (!this.isCurrentStill(item, gen)) {
      prepared.kill();
      return false;
    }

    const stopOld = this.killCurrent;
    this.killCurrent = prepared.kill;
    this.usedDirect = prepared.remote;
    this.srcLevel = prepared.level;

    const resource = createAudioResource(prepared.stream, { inputType: StreamType.OggOpus });
    this.currentResource = resource;
    this.currentOffsetSec = resumeAt; // 다음 번에 위치를 제대로 계산하기 위해 꼭 남깁니다
    this.musicPlayer.play(resource);

    // **바꿔치기한 뒤에** 끊습니다. 먼저 끊으면 그 시간만큼 침묵이 생깁니다.
    stopOld?.();
    return true;
  }

  /** 기다리는 사이에 곡이 바뀌거나 또 눌리지 않았는지 확인합니다. */
  isCurrentStill(item, gen) {
    return !this.destroyed && this.current === item && gen === this.restartGen && this.isPlaying;
  }

  /**
   * 지금 곡의 재생 위치(초).
   *
   * 건너뛰고 시작한 만큼(currentOffsetSec) + 이번 리소스가 재생한 시간.
   * 음량을 바꿀 때마다 리소스가 새로 생기므로 이 둘을 반드시 같이 봐야 합니다.
   */
  positionSec() {
    return this.currentOffsetSec + (this.currentResource?.playbackDuration ?? 0) / 1000;
  }

  /**
   * **보험용** 예약. 평소에는 `prefetchNext()` 가 끝나는 즉시 준비가 걸립니다.
   *
   * 이건 그게 실패했거나 열어둔 소리가 중간에 끊겼을 때, 곡이 끝나갈 무렵
   * 한 번 더 시도하는 길입니다. 지우면 한 번 실패한 곡은 영영 준비 없이 갑니다.
   */
  schedulePrepareNext() {
    clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    if (this.destroyed || this.queue.length === 0) return;

    const len = this.current?.track?.duration ?? 0;
    // 길이를 모르면(라이브 등) 남은 시간을 계산할 수 없습니다. 조금 뒤에 그냥 시작합니다.
    const remain = len > 0 ? len - this.positionSec() : 0;
    const delaySec = len > 0 ? Math.max(PREPARE_MIN_DELAY_SEC, remain - PREPARE_LEAD_SEC) : PREPARE_MIN_DELAY_SEC;

    this.prepareTimer = setTimeout(() => {
      this.prepareTimer = null;
      this.prepareNext().catch((err) => console.warn('[music] 다음 곡 준비:', err.message));
    }, delaySec * 1000);
  }

  /**
   * 다음 곡의 **소리까지** 미리 열어둡니다. (주소만 뽑아두는 prefetchNext 의 다음 단계)
   *
   * 왜 필요한가: 주소를 이미 뽑아뒀어도 실제로 소리가 나기까지 이 서버에서는
   * **9~11초**가 걸립니다(실측). yt-dlp 를 띄우고(3초) 받아오는 시간입니다.
   * 그게 곡과 곡 사이에 그대로 침묵으로 들어갑니다.
   *
   * 열어둔 소리는 파이프가 차면 yt-dlp·ffmpeg 이 알아서 멈춰 기다리므로 CPU 를 거의 안 씁니다.
   * 대신 **연결이 끊길 수 있어서** 죽었는지 표시해두고 쓸 때 다시 확인합니다.
   */
  async prepareNext() {
    const item = this.queue[0];
    if (this.destroyed || !item || this.preparing) return;
    if (this.prepared?.item === item && !this.prepared.dead) return; // 이미 준비해뒀습니다

    this.preparing = true;
    const t0 = Date.now();
    let prepared = null;
    try {
      const src = createSource(item.track, { level: item.srcLevel ?? SRC_DIRECT });
      const { stream, kill } = toOggOpus(src.input, {
        volume: volumeScale(this.guild.id, 'music'),
        remote: src.remote,
        onError: () => {},
      });
      prepared = { item, stream, level: src.level, dead: false, kill: () => { kill(); src.kill(); } };

      // 첫 소리가 나올 준비가 될 때까지 기다립니다. 여기가 오래 걸리는 그 시간입니다.
      const ready = await waitForAudio(stream, 90_000);
      // 기다리는 사이에 대기열이 바뀌었으면 버립니다. (그 곡은 이제 다음 곡이 아닙니다)
      if (!ready || this.destroyed || this.queue[0] !== item) {
        prepared.kill();
        return;
      }

      // ⚠️ **열어둔 소리는 죽을 수 있습니다.** 곡 하나가 다 끝날 때까지 몇 분을 기다리는데,
      //    그동안 유튜브가 노는 연결을 끊습니다. 죽은 걸 모르고 그대로 틀면
      //    "소리가 안 남 → 실패 판정 → 아래 단계로 재시도" 가 되어 **지금보다 나빠집니다.**
      //    첫 바이트가 왔다는 것은 그때 살아 있었다는 뜻일 뿐입니다.
      const onDead = () => {
        prepared.dead = true;
        if (this.prepared !== prepared) return; // 이미 쓰였거나 버려졌습니다
        this.prepared = null;
        prepared.kill();
        console.warn(`[music] 미리 열어둔 소리가 끊겼습니다 · ${item.track.title}`);
        this.schedulePrepareNext(); // 곡이 끝나갈 무렵 다시 열어봅니다
      };
      stream.once('end', onDead);
      stream.once('error', onDead);

      this.dropPrepared(); // 앞서 준비해둔 것이 있으면 정리하고 바꿔 답니다
      this.prepared = prepared;
      console.log(
        `[music] 다음 곡 준비 완료 ${((Date.now() - t0) / 1000).toFixed(1)}초 · ` +
          `${SRC_LABEL[prepared.level]} · ${item.track.title}`
      );
    } catch (err) {
      prepared?.kill();
      console.warn(`[music] 다음 곡 준비 실패 · ${item.track.title}: ${err.message.split('\n')[0]}`);
    } finally {
      this.preparing = false;
    }
  }

  /**
   * 미리 열어둔 소리를 버립니다.
   *
   * ⚠️ **반드시 kill 까지 해야 합니다.** 안 하면 yt-dlp·ffmpeg 프로세스가 남습니다.
   *    코어가 하나뿐인 서버에서는 그게 그대로 다음 곡을 느리게 만듭니다.
   */
  dropPrepared() {
    if (!this.prepared) return;
    this.prepared.kill();
    this.prepared = null;
  }

  /** 대기열을 건드린 뒤: 준비해둔 것이 더 이상 "다음 곡" 이 아니면 버립니다. */
  dropPreparedIfNotNext() {
    if (this.prepared && this.queue[0] !== this.prepared.item) this.dropPrepared();
  }

  /**
   * 대기열의 다음 곡 주소를 **미리** 뽑아둡니다.
   *
   * 왜: yt-dlp 는 켜지기만 해도 약 1초가 걸리고(PyInstaller 번들), 유튜브 응답까지
   * 합치면 곡당 약 2.7초입니다. 이걸 곡이 끝난 뒤에 하면 그 시간만큼 조용해집니다.
   * 지금 곡을 트는 동안 미리 해두면 **곡 전환이 사실상 즉시**가 됩니다.
   * (첫 곡은 어쩔 수 없이 기다려야 합니다)
   */
  prefetchNext() {
    const next = this.queue[0];
    if (!next) return;

    // ⚠️ 여기서 **조용히 빠져나가면 안 됩니다.** 다음 곡이 느렸을 때
    //    "미리 뽑기 줄이 아예 없다" 는 상태가 되어, 안 돈 것인지 실패한 것인지
    //    구분할 수가 없습니다. 실제로 그것 때문에 원인을 못 짚었습니다.
    if (next.prefetching) {
      console.log(`[music] 미리 뽑기 건너뜀 (앞의 것이 아직 도는 중) · ${next.track.title}`);
      return;
    }

    // 주소가 이미 살아 있으면 뽑을 것은 없습니다. 하지만 **소리는 아직 안 열렸을 수 있습니다.**
    // (반복 재생, 지난 곡을 다시 담은 경우) 그러니 준비는 반드시 이어서 겁니다.
    if (hasFreshStreamUrl(next.track)) {
      this.prepareNext().catch((err) => console.warn('[music] 다음 곡 준비:', err.message));
      return;
    }

    next.prefetching = true;
    const t0 = Date.now();
    const took = () => ((Date.now() - t0) / 1000).toFixed(1);
    getTracks(next.track.url)
      .then(([fresh]) => {
        // 미리 뽑는 사이에 대기열이 바뀌었을 수 있으니 아직 그 자리에 있는지 확인합니다.
        if (fresh?.streamUrl && this.queue.includes(next)) {
          next.track.streamUrl = fresh.streamUrl;
          next.track.extractedAt = fresh.extractedAt;
          console.log(`[music] 미리 뽑기 ${took()}초 · ${next.track.title}`);
        }
      })
      .catch((err) => {
        // 미리 뽑기는 실패해도 곡은 나옵니다 — 틀 때 정상 경로로 다시 시도하니까요.
        // 다만 **조용히 실패하면 다음 곡이 왜 느린지 알 수 없습니다.** 그래서 남깁니다.
        console.warn(`[music] 미리 뽑기 실패 (${took()}초) · ${next.track.title}: ${err.message.split('\n')[0]}`);
      })
      .finally(() => {
        next.prefetching = false;
        // ★ 주소가 준비되는 **그 즉시** 소리까지 엽니다.
        //   예전에는 "곡 끝나기 40초 전" 에 걸었는데, 곡을 넘겨가며 듣는 분에게는
        //   그 시점이 아예 오지 않았습니다. (실측: 14초 만에 다음 곡)
        //   여기서 걸면 지금 곡이 시작되고 20초쯤 뒤에는 준비가 끝나 있습니다.
        this.prepareNext().catch((err) => console.warn('[music] 다음 곡 준비:', err.message));
      });
  }

  /**
   * 방금 끝난 곡이 사실은 **재생되지 못한 것**인지 판단합니다.
   *
   * 증상: 대기열에 들어가자마자 사라지고 아무 소리도 안 남. 오류 메시지도 없음.
   * 원인은 보통 재생 주소가 거부되는 것인데(서버 환경에 따라 다름), 조용히 실패하면
   * 사용자는 영영 원인을 알 수 없습니다. 그래서 (1) 파이프 방식으로 자동 재시도하고,
   * (2) 그것도 실패하면 **디스코드에 이유를 알립니다.**
   */
  playedNothing() {
    // 이번 시도가 소리를 냈는지만 봅니다. 3초 넘게 났으면 실패가 아닙니다.
    const played = this.currentResource?.playbackDuration ?? 0;
    if (played >= 3000) return false;

    // 처음부터 튼 것이 아닐 수 있습니다(음량 조절·재시도로 이어듣기).
    // 그때는 **남은 길이**를 봐야 합니다. 곡 끝 무렵이면 3초만 나고 끝나는 게 정상인데,
    // 원곡 전체 길이와 비교하면 멀쩡히 다 들은 곡을 "재생 실패" 로 잘못 알립니다.
    const trackLen = this.current?.track?.duration ?? 0;
    if (trackLen === 0) return true; // 길이를 모르면 실패로 봅니다
    return trackLen - this.currentOffsetSec > 5;
  }

  /**
   * 제어판 내용을 **그 자리에서** 갱신합니다.
   *
   * 곡이 다 끝났는데도 제어판이 "지금 재생 중" 으로 남아 있던 문제를 막습니다.
   * showPanel() 과 달리 **맨 아래로 옮기지 않습니다.** 곡이 끝나는 순간은
   * 버튼 응답(interaction.update)과 겹칠 수 있는데, 여기서 메시지를 지워버리면
   * 그 응답이 "없는 메시지" 오류를 냅니다.
   */
  /**
   * 직접 수신(0단계)이 **정말로 소리를 냈는지** 조금 뒤에 확인합니다.
   *
   * 판정 기준은 `playedNothing()` 과 같습니다 — 3초 넘게 났으면 진짜 소리가 난 것입니다.
   * 이게 없으면 "두 번 연속 실패하면 끈다" 가 작동하지 않아, **곡마다 헛걸음**을 합니다.
   */
  confirmDirectLater() {
    const resource = this.currentResource;
    clearTimeout(this.directCheckTimer);
    this.directCheckTimer = setTimeout(() => {
      this.directCheckTimer = null;
      // 그 사이에 곡이 바뀌었으면 이 확인은 의미가 없습니다.
      if (this.destroyed || this.currentResource !== resource) return;
      if ((resource?.playbackDuration ?? 0) >= 3000) noteDirectSuccess();
    }, 5000);
  }

  /**
   * 곡이 바뀐 것을 제어판에 반영합니다. **버튼 응답과 겹치지 않게 살짝 미룹니다.**
   *
   * 예전에는 `⏮️ 이전` `⏭️ 다음` 버튼을 처리할 때 400ms 를 그냥 잤습니다.
   * 다음 곡 정보가 아직 없는 채로 제어판을 갱신하면 옛 곡이 그대로 보였기 때문입니다.
   * 그 400ms 는 **누른 사람이 고스란히 기다리는 시간**이었습니다.
   * 이제는 버튼에 바로 답하고, 소리가 실제로 바뀌는 순간 여기서 따라 갱신합니다.
   *
   * ⚠️ 미루는 이유: 버튼 응답(interaction.update)이 아직 날아가는 중일 수 있습니다.
   *    같은 메시지를 동시에 두 번 고치면 갱신이 서로를 덮어씁니다.
   * ⚠️ 연달아 불립니다 (곡 전환·일시정지 해제·음량 반영). 마지막 것만 반영합니다.
   */
  schedulePanelRefresh() {
    clearTimeout(this.panelTimer);
    this.panelTimer = setTimeout(() => {
      this.panelTimer = null;
      this.refreshPanel();
    }, 600);
  }

  refreshPanel() {
    const msg = this.panelMessage;
    if (!msg || this.destroyed) return;
    Promise.resolve()
      .then(() => msg.edit(buildPanel(this)))
      .catch(() => {}); // 이미 지워졌으면 그냥 둡니다
  }

  onTrackEnd() {
    if (this.destroyed) return;
    const intent = this.nextIntent ?? 'auto';
    this.nextIntent = null;

    // 사용자가 넘긴 게 아니라 "스스로 끝난" 경우에만 실패인지 따집니다.
    if (intent === 'auto' && this.current && this.playedNothing()) {
      const item = this.current;

      if (this.srcLevel < SRC_EXTRACT) {
        // 이 단계가 거부된 것으로 보입니다. **한 칸 아래 단계로** 다시 시도합니다.
        // 오류 내용을 안 찍으면 왜 실패하는지 영영 알 수 없습니다.
        const nextLevel = this.srcLevel + 1;
        console.warn(
          `[music] ${SRC_LABEL[this.srcLevel]} 실패 → ${SRC_LABEL[nextLevel]}로 재시도: ${item.track.title}` +
            (this.lastStreamError ? `
        ${this.lastStreamError.slice(0, 200)}` : '')
        );
        // 0단계(직접 수신)만 "이 서버에서 아예 안 되는 것" 으로 셉니다.
        if (this.srcLevel === SRC_DIRECT) noteDirectFailure(this.lastStreamError);
        this.current = null;
        // 듣던 위치를 넘겨줍니다. 안 넘기면 **곡이 처음부터** 다시 시작됩니다.
        this.queue.unshift({ ...item, srcLevel: nextLevel, resumeAt: this.positionSec() });
        this.playNext('auto');
        return;
      }

      // 세 단계 모두 실패했습니다. 이제는 조용히 넘어가면 안 됩니다.
      console.error(`[music] 재생 실패: ${item.track.title} ${this.lastStreamError ?? ''}`);
      this.notify(
        `⚠️ **${item.track.title}** 재생에 실패했습니다.\n` +
          (this.lastStreamError ? `\`${this.lastStreamError.slice(0, 300)}\`\n` : '') +
          `유튜브가 서버를 막고 있을 수 있습니다. 계속되면 \`${updateHint()}\` 를 해보세요.`
      );
      this.current = null;
    }

    // 이전곡 요청은 대기열이 비어 있어도 처리해야 합니다 (기록에서 꺼내오므로).
    if (intent === 'previous' || this.queue.length > 0 || (this.loop && this.current)) {
      this.playNext(intent);
    } else {
      this.killCurrent?.();
      this.killCurrent = null;
      if (this.current) this.pushHistory(this.current);
      this.current = null;
      this.refreshPanel();
      this.scheduleLeave();
    }
  }

  /** 다음 곡으로. 반복재생이 켜져 있어도 넘어갑니다. */
  skip() {
    const skipped = this.current;
    this.requestPlay('next');
    return skipped;
  }

  /** 이전 곡으로. 되돌아갈 기록이 없으면 아무것도 하지 않고 false 를 돌려줍니다. */
  previous() {
    if (this.history.length === 0) return false;
    this.requestPlay('previous');
    return true;
  }

  stop() {
    this.queue = [];
    this.dropPrepared(); // 미리 열어둔 소리도 버립니다. 안 그러면 프로세스가 남습니다.
    this.loop = false;
    if (this.current) this.pushHistory(this.current);
    this.current = null;
    this.nextIntent = null;
    this.musicPlayer.stop(true);
    this.killCurrent?.();
    this.killCurrent = null;
  }

  // ── 대기열 편집 ──────────────────────────────────────────
  // 사용자에게 보이는 번호는 1부터 시작합니다. 여기서 0-based 로 바꿉니다.

  /** @returns {object|null} 지운 항목 */
  removeAt(pos) {
    const i = pos - 1;
    if (i < 0 || i >= this.queue.length) return null;
    const removed = this.queue.splice(i, 1)[0];
    this.dropPreparedIfNotNext();
    return removed;
  }

  /** 곡을 다른 순번으로 옮깁니다. @returns {object|null} 옮긴 항목 */
  moveTo(from, to) {
    const fi = from - 1;
    if (fi < 0 || fi >= this.queue.length) return null;
    const [item] = this.queue.splice(fi, 1);
    // 범위를 벗어난 목표 위치는 양 끝으로 붙입니다. (사용자가 큰 숫자를 넣어도 동작)
    const ti = Math.max(0, Math.min(this.queue.length, to - 1));
    this.queue.splice(ti, 0, item);
    this.dropPreparedIfNotNext();
    return item;
  }

  /** 이 곡을 바로 다음에 재생하도록 맨 앞으로 올립니다. */
  bringToFront(pos) {
    return this.moveTo(pos, 1);
  }

  clearQueue() {
    const n = this.queue.length;
    this.queue = [];
    this.dropPrepared();
    return n;
  }

  pause() {
    return this.musicPlayer.pause(true);
  }

  resume() {
    return this.musicPlayer.unpause();
  }

  // ── TTS (음악에 끼어들기) ────────────────────────────────

  /**
   * TTS 음성을 재생합니다. 여러 개가 동시에 들어와도 한 줄로 세워 순서대로 말합니다.
   * @param {() => Promise<import('node:stream').Readable>} makeStream 오디오 스트림을 만들어주는 함수
   * @param {string} [targetChannelId] 이 음성채널에 있을 때만 읽습니다. 순서를 기다리는 동안
   *   봇이 다른 음성채널로 옮겨갔다면 엉뚱한 곳에서 읽게 되므로 그 경우엔 건너뜁니다.
   */
  speak(makeStream, targetChannelId = null) {
    this.ttsChain = this.ttsChain
      .then(() => this.speakNow(makeStream, targetChannelId))
      .catch((err) => console.error('[tts]', err.message));
    return this.ttsChain;
  }

  async speakNow(makeStream, targetChannelId = null) {
    if (!this.connection || this.destroyed) return;

    // 큐에서 기다리는 사이에 봇이 다른 채널로 옮겨갔으면 이 문장은 버립니다.
    if (targetChannelId && this.connection.joinConfig.channelId !== targetChannelId) {
      console.log('[tts] 음성채널이 바뀌어 이 문장은 건너뜁니다.');
      return;
    }

    const musicWasPlaying = this.musicPlayer.state.status === AudioPlayerStatus.Playing;
    if (musicWasPlaying) this.musicPlayer.pause(true);

    let kill = null;
    try {
      const raw = await makeStream();
      // 읽어주기 음량 조절은 없앴습니다(소유자 요청). 원음 그대로 내보냅니다.
      const piped = toOggOpus(raw);
      kill = piped.kill;

      // ★ 소리가 하나도 안 나오는 경우가 있습니다.
      //   (낱자만 있는 글, 한국어 전용 목소리에 일본어 — 둘 다 실측으로 0바이트 확인)
      //   그대로 재생하면 아래 entersState 가 **15초를 기다리다 실패**하고,
      //   그동안 뒤에 온 문장이 전부 밀립니다. 미리 확인하고 건너뜁니다.
      if (!(await waitForAudio(piped.stream, 8_000))) {
        console.warn('[tts] 소리가 나오지 않아 건너뜁니다.');
        return; // finally 에서 정리됩니다
      }

      this.subscribeTo(this.ttsPlayer);
      this.ttsPlayer.play(createAudioResource(piped.stream, { inputType: StreamType.OggOpus }));
      await entersState(this.ttsPlayer, AudioPlayerStatus.Playing, 15_000);
      await entersState(this.ttsPlayer, AudioPlayerStatus.Idle, 10 * 60_000);
    } catch (err) {
      console.error('[tts] 재생 실패:', err.message);
    } finally {
      kill?.();
      this.ttsPlayer.stop(true);
      this.subscribeTo(this.musicPlayer);
      if (musicWasPlaying) this.musicPlayer.unpause();
      this.scheduleLeave();
    }
  }

  // ── 정리 ────────────────────────────────────────────────

  /**
   * 지금 들어가 있는 음성채널에 **사람이 한 명이라도 있는가.** (봇은 안 셉니다)
   *
   * 채널을 못 찾으면 false 입니다 — 그때는 붙잡고 있을 이유가 없습니다.
   */
  hasHumanListener() {
    const channelId = this.connection?.joinConfig?.channelId;
    if (!channelId) return false;
    const channel = this.guild.channels?.cache?.get(channelId);
    if (!channel?.members) return false;
    return channel.members.some((m) => !m.user?.bot);
  }

  /**
   * 할 일이 없어지면 음성채널에서 나갈 준비를 합니다.
   *
   * ⚠️ **사람이 남아 있으면 나가지 않습니다.** (소유자 요청)
   *   망고는 읽어주기·타이머 때문에 들어가 있는데, 조용한 시간이 5분 넘었다고
   *   나가버리면 대화 중에 갑자기 사라집니다. 다시 부르는 것도 사람 몫이 됩니다.
   *   아무도 없어지면 `VoiceStateUpdate` 쪽에서 알아서 내보내므로,
   *   이 타이머는 **아무도 없는데 그 이벤트를 놓친 경우**의 보험입니다.
   */
  scheduleLeave() {
    this.cancelLeaveTimer();
    const sec = config.music.leaveAfterSec;
    if (!sec || sec <= 0) return;
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      if (this.isPlaying || this.queue.length > 0) return;
      if (this.hasHumanListener()) return; // 사람이 있으면 계속 남아 있습니다
      this.destroy();
    }, sec * 1000);
  }

  cancelLeaveTimer() {
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
  }

  notify(content) {
    this.textChannel?.send(content).catch(() => {});
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelLeaveTimer();
    clearTimeout(this.volumeTimer);
    this.volumeTimer = null;
    clearTimeout(this.panelTimer);
    this.panelTimer = null;
    clearTimeout(this.directCheckTimer);
    this.directCheckTimer = null;
    clearTimeout(this.prepareTimer);
    this.prepareTimer = null;
    this.dropPrepared(); // 미리 열어둔 yt-dlp·ffmpeg 이 남지 않게
    this.queue = [];
    this.history = [];
    this.nextIntent = null;
    this.current = null;
    // 봇이 나가면 "지금 재생 중" 은 거짓말이 됩니다. 다만 처리가 두 갈래입니다.
    //   · 지정된 음악 채팅방 → **지우지 않고** "재생 중인 곡이 없습니다" 로 고쳐 씁니다.
    //     소유자 요청: "봇이 음성채널에 없거나 재생중인 곡이 없을때도 계속 보이게"
    //   · 그 밖의 채널     → 예전대로 지웁니다. 안 그러면 아무 채팅방에나 남습니다.
    //
    // ⚠️ 여기서 refreshPanel() 을 쓰면 안 됩니다. 위에서 destroyed 를 이미 켰기 때문에
    //    그 함수는 조용히 아무것도 하지 않습니다. 메시지를 직접 고칩니다.
    const panel = this.panelMessage;
    this.panelMessage = null;
    if (panel) {
      if (isMusicHome(this.guild.id, panel.channelId)) {
        panel.edit(buildPanel(null, this.guild.id)).catch(() => {});
      } else {
        forgetPanel(MUSIC, panel.channelId);
        panel.delete().catch(() => {});
      }
    }
    this.killCurrent?.();
    this.killCurrent = null;
    this.musicPlayer.stop(true);
    this.ttsPlayer.stop(true);
    this.subscription?.unsubscribe();
    this.subscription = null;
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.connection = null;
    registry.delete(this.guild.id);
  }
}
