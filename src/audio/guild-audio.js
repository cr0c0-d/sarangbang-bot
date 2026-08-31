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
import { createSource } from '../music/ytdlp.js';
import { toOggOpus } from './ffmpeg.js';
import { showPanel } from '../music/panel.js';

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
    this.killCurrent = null;
    this.loop = false;
    this.volume = 1;
    this.textChannel = null; // 제어판을 띄울 곳
    this.panelMessage = null; // 띄워둔 제어판 메시지 (곡이 바뀌면 이걸 수정해서 재사용)
    this.leaveTimer = null;
    this.ttsChain = Promise.resolve(); // TTS를 한 번에 하나씩만 말하도록 줄 세우기
    this.destroyed = false;

    this.musicPlayer.on(AudioPlayerStatus.Idle, () => this.onTrackEnd());
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
      // 채널 이동이나 순간적인 네트워크 끊김이면 스스로 복구됩니다.
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    } catch {
      this.destroy();
      throw new Error(
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
    this.history.push(item);
    if (this.history.length > 30) this.history.shift();
  }

  playNext(intent = 'auto') {
    this.killCurrent?.();
    this.killCurrent = null;

    const outgoing = this.current;
    this.current = null;

    if (outgoing) {
      if (intent === 'previous') {
        // 이전 곡으로 돌아가므로 현재 곡은 대기열 맨 앞으로 되돌립니다.
        this.queue.unshift(outgoing);
      } else if (this.loop && intent === 'auto') {
        this.queue.unshift(outgoing);
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
      this.scheduleLeave();
      return;
    }

    this.current = item;

    try {
      // 이미 뽑아둔 재생 주소가 살아 있으면 ffmpeg 이 직접 받습니다 (yt-dlp 재추출 생략).
      const src = createSource(item.track);
      const { stream, kill } = toOggOpus(src.input, { volume: this.volume, remote: src.remote });
      this.killCurrent = () => {
        kill();
        src.kill();
      };

      const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
      this.musicPlayer.play(resource);
      // 텍스트 알림 대신 버튼이 달린 제어판을 보여줍니다. (기존 제어판이 있으면 수정)
      showPanel(this, this.textChannel);
    } catch (err) {
      console.error('[music] 스트림 생성 실패:', err);
      this.notify('⚠️ **' + item.track.title + '** 을(를) 재생할 수 없어 건너뜁니다.\n' + err.message);
      setImmediate(() => this.playNext());
    }
  }

  onTrackEnd() {
    if (this.destroyed) return;
    const intent = this.nextIntent ?? 'auto';
    this.nextIntent = null;

    // 이전곡 요청은 대기열이 비어 있어도 처리해야 합니다 (기록에서 꺼내오므로).
    if (intent === 'previous' || this.queue.length > 0 || (this.loop && this.current)) {
      this.playNext(intent);
    } else {
      this.killCurrent?.();
      this.killCurrent = null;
      if (this.current) this.pushHistory(this.current);
      this.current = null;
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
    return this.queue.splice(i, 1)[0];
  }

  /** 곡을 다른 순번으로 옮깁니다. @returns {object|null} 옮긴 항목 */
  moveTo(from, to) {
    const fi = from - 1;
    if (fi < 0 || fi >= this.queue.length) return null;
    const [item] = this.queue.splice(fi, 1);
    // 범위를 벗어난 목표 위치는 양 끝으로 붙입니다. (사용자가 큰 숫자를 넣어도 동작)
    const ti = Math.max(0, Math.min(this.queue.length, to - 1));
    this.queue.splice(ti, 0, item);
    return item;
  }

  /** 이 곡을 바로 다음에 재생하도록 맨 앞으로 올립니다. */
  bringToFront(pos) {
    return this.moveTo(pos, 1);
  }

  clearQueue() {
    const n = this.queue.length;
    this.queue = [];
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
      const piped = toOggOpus(raw);
      kill = piped.kill;

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

  scheduleLeave() {
    this.cancelLeaveTimer();
    const sec = config.music.leaveAfterSec;
    if (!sec || sec <= 0) return;
    this.leaveTimer = setTimeout(() => {
      if (!this.isPlaying && this.queue.length === 0) this.destroy();
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
    this.queue = [];
    this.history = [];
    this.nextIntent = null;
    this.current = null;
    this.panelMessage = null;
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
