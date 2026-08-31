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
import { createStream } from '../music/ytdlp.js';
import { toOggOpus } from './ffmpeg.js';

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
    this.current = null;
    this.killCurrent = null;
    this.loop = false;
    this.volume = 1;
    this.textChannel = null; // "지금 재생 중" 같은 알림을 보낼 곳
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

  playNext() {
    this.killCurrent?.();
    this.killCurrent = null;

    if (this.loop && this.current) {
      this.queue.unshift(this.current);
    }

    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      this.scheduleLeave();
      return;
    }

    this.current = item;

    try {
      const ytStream = createStream(item.track.url);
      const { stream, kill } = toOggOpus(ytStream, { volume: this.volume });
      this.killCurrent = kill;

      const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
      this.musicPlayer.play(resource);
      this.notify('▶️ 재생 중: **' + item.track.title + '**');
    } catch (err) {
      console.error('[music] 스트림 생성 실패:', err);
      this.notify('⚠️ **' + item.track.title + '** 을(를) 재생할 수 없어 건너뜁니다.\n' + err.message);
      setImmediate(() => this.playNext());
    }
  }

  onTrackEnd() {
    if (this.destroyed) return;
    if (this.queue.length > 0 || this.loop) this.playNext();
    else {
      this.killCurrent?.();
      this.killCurrent = null;
      this.current = null;
      this.scheduleLeave();
    }
  }

  skip() {
    const skipped = this.current;
    // stop()을 부르면 Idle 이벤트가 떠서 다음 곡으로 자동으로 넘어갑니다.
    // 반복재생 중이면 "건너뛰기"가 같은 곡을 또 트는 게 되므로 잠깐 꺼둡니다.
    const wasLoop = this.loop;
    this.loop = false;
    this.current = null;
    this.musicPlayer.stop(true);
    this.loop = wasLoop;
    return skipped;
  }

  stop() {
    this.queue = [];
    this.loop = false;
    this.current = null;
    this.musicPlayer.stop(true);
    this.killCurrent?.();
    this.killCurrent = null;
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
    this.current = null;
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
