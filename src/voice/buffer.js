// 🎧 지난 N초 소리 되돌리기 — 음성채널 대화의 웃긴 순간을 뒤늦게 저장합니다.
//
// ⚠️ **실제 디스코드에서 수신이 되는지 아직 확인하지 못했습니다.** 확인용 진단은
// `/관리자 음성수신확인` 입니다 (voice-probe.js). 그래서 이 기능은 **기본 꺼짐**이고,
// 안 되더라도 아무것도 망가지지 않게 만들었습니다 —
// 켤 때 귀가 열렸는지 스스로 확인하고, 받은 게 없으면 그렇게 말합니다.
// 자세한 내용은 docs/음성녹음-기획.md.
//
// ── 왜 이런 구조인가 ────────────────────────────────────────
//
// **통째로 녹음하지 않습니다.** 4시간 6명이면 700MB~1.7GB 인데, 마지막 30초만 들고 있으면
// 3.6MB 이고 **디스크에 아무것도 안 남습니다.** 200배 차이입니다 (기획 2절).
//
// **버퍼에는 opus 를 그대로 담습니다. 디코딩하지 않습니다.** 그래서 평소 CPU 는 사실상 0 이고,
// 디코딩·섞기는 **버튼을 눌렀을 때 한 번만** 돕니다. 1코어 ARM 을 고려한 선택입니다.
//
// **패킷에는 시간 정보가 없습니다.** 수신 스트림은 RTP 헤더를 떼고 opus 페이로드만 주고,
// 디스코드는 말하지 않는 동안 패킷을 보내지 않습니다. 그래서 **도착 시각을 직접 찍고
// 조용한 구간을 무음으로 메웁니다.** 안 그러면 사람별 트랙이 서로 밀립니다.
// 그 계산(`layoutTrack`)은 순수 함수로 떼어 verify 가 토큰 없이 검사합니다.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import OpusScript from 'opusscript';
import { EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice';
import { config } from '../config.js';
import { folderPath, safeClipName } from '../stream/clips.js';
import { botDeafState } from './probe.js';
import { userError } from '../user-error.js';

const RATE = 48_000;
const CHANNELS = 2;
const FRAME_MS = 20;
/** int16 스테레오 48kHz → 1ms 당 192바이트. 샘플 경계는 4바이트입니다. */
export const BYTES_PER_MS = (RATE * CHANNELS * 2) / 1000;
const SAMPLE_BYTES = CHANNELS * 2;

/** 링버퍼가 들고 있을 시간. 요청 구간보다 넉넉히 둬서 경계에서 잘리지 않게 합니다. */
const KEEP_SLACK_MS = 5_000;

// ── 순수 계산 (verify 가 토큰 없이 검사하는 부분) ──────────────────

/** 오래된 패킷을 버립니다. 링버퍼가 이 함수 하나로 유지됩니다. */
export function pruneTrack(packets, cutoffMs) {
  let drop = 0;
  while (drop < packets.length && packets[drop].at < cutoffMs) drop += 1;
  if (drop > 0) packets.splice(0, drop);
  return packets;
}

/**
 * 한 사람의 패킷들을 **도착 시각 위치에** 놓고 나머지는 무음으로 둡니다.
 *
 * `Buffer.alloc` 이 0으로 채우므로 **아무것도 안 놓은 자리가 곧 무음**입니다.
 * 지터로 패킷이 뭉쳐 도착하면 앞 프레임과 겹치는데, 그때는 덮어쓰지 않고
 * **뒤에 이어 붙입니다** — 겹친 쪽을 버리면 말소리가 사라집니다.
 *
 * @param packets `{ at, data }` 배열 (도착 순서)
 * @param decode  opus 패킷 하나 → PCM Buffer. 테스트에서는 가짜를 넣습니다.
 */
export function layoutTrack(packets, { fromMs, toMs, decode }) {
  const totalMs = Math.max(0, toMs - fromMs);
  const out = Buffer.alloc(Math.round(totalMs) * BYTES_PER_MS);
  if (out.length === 0) return out;
  let cursor = 0;
  let used = 0;
  for (const packet of packets) {
    // 구간보다 앞선 것은 버리고, 뒤선 것에서 멈춥니다 (도착 순서라 그 뒤도 다 뒤입니다).
    if (packet.at < fromMs - FRAME_MS) continue;
    if (packet.at > toMs) break;
    let pcm;
    try {
      pcm = decode(packet.data);
    } catch {
      // 한 프레임이 깨져도 그 자리만 무음으로 두고 계속합니다.
      continue;
    }
    if (!pcm?.length) continue;
    const raw = Math.round((packet.at - fromMs) * BYTES_PER_MS);
    const aligned = Math.max(0, raw - (raw % SAMPLE_BYTES));
    const start = Math.max(aligned, cursor);
    if (start >= out.length) break;
    const copied = Buffer.from(pcm.buffer ?? pcm, pcm.byteOffset ?? 0, pcm.length).copy(out, start);
    cursor = start + copied;
    used += 1;
  }
  return Object.assign(out, { frames: used });
}

/** 사람별 트랙을 하나로 섞습니다. int16 더하기에 상한을 씌웁니다 (안 씌우면 찢어집니다). */
export function mixTracks(tracks) {
  const kept = tracks.filter((t) => t?.length);
  if (kept.length === 0) return Buffer.alloc(0);
  if (kept.length === 1) return kept[0];
  const length = Math.max(...kept.map((t) => t.length));
  const out = Buffer.alloc(length - (length % SAMPLE_BYTES));
  for (let i = 0; i + 1 < out.length; i += 2) {
    let sum = 0;
    for (const track of kept) if (i + 1 < track.length) sum += track.readInt16LE(i);
    out.writeInt16LE(Math.max(-32_768, Math.min(32_767, sum)), i);
  }
  return out;
}

// ── 링버퍼 상태 ────────────────────────────────────────────

/** @type {Map<string, { channelId: string, byUserId: Map<string, {at:number,data:Buffer}[]>, armedBy: string, armedAt: number, wasSelfDeaf: boolean, receiver: any, onSpeaking: Function, streams: any[] }>} */
const armed = new Map();

export function armedIn(guildId) {
  return armed.get(guildId) ?? null;
}

export function isArmed(guildId, channelId = null) {
  const state = armed.get(guildId);
  if (!state) return false;
  return channelId ? state.channelId === channelId : true;
}

/** 지금 버퍼에 들고 있는 대략의 양. 제어판에 보여줍니다. */
export function bufferedInfo(guildId) {
  const state = armed.get(guildId);
  if (!state) return null;
  let packets = 0;
  let bytes = 0;
  for (const track of state.byUserId.values()) {
    packets += track.length;
    for (const p of track) bytes += p.data.length;
  }
  return { people: state.byUserId.size, packets, bytes, since: state.armedAt };
}

function keepMs() {
  return config.voice.clipSec * 1_000 + KEEP_SLACK_MS;
}

/**
 * 소리 기록을 켭니다.
 *
 * ★ **귀가 실제로 열렸는지 확인하고, 안 열렸으면 켜지 않습니다.**
 * 조용히 켜두면 나중에 버튼을 눌렀을 때 "받은 게 없다" 만 나오고 왜인지 알 수 없습니다.
 */
export async function arm(audio, channel, userId) {
  const guildId = channel.guild.id;
  const existing = armed.get(guildId);
  if (existing) return { already: true, channelId: existing.channelId };

  const connection = audio.connection;
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    throw userError('음성채널 연결이 준비되지 않았습니다. 잠시 뒤에 다시 해보세요.');
  }

  const wasSelfDeaf = connection.joinConfig.selfDeaf !== false;
  if (wasSelfDeaf) {
    // 커넥션을 끊지 않고 귀만 엽니다. 재생 중인 음악·읽어주기는 이어집니다
    // (`self_deaf` 는 받기, `self_mute` 는 보내기 — 3.6-11).
    connection.rejoin({ selfDeaf: false });
    await new Promise((r) => {
      const t = setTimeout(r, 1_500);
      t.unref?.();
    });
  }

  const deaf = botDeafState(channel.guild);
  if (deaf?.serverDeaf) {
    if (wasSelfDeaf) connection.rejoin({ selfDeaf: true });
    throw userError(
      '서버에서 망고를 **헤드셋 차단(서버 음소거)** 해뒀습니다. 그것부터 풀어야 소리를 받을 수 있습니다.'
    );
  }
  if (deaf?.selfDeaf) {
    throw userError(
      '망고의 귀를 여는 데 실패했습니다. 소리를 받을 수 없어 켜지 않았습니다.\n' +
        '`/관리자 음성수신확인` 으로 자세한 상태를 볼 수 있습니다.'
    );
  }

  const receiver = connection.receiver;
  const state = {
    channelId: channel.id,
    byUserId: new Map(),
    armedBy: userId,
    armedAt: Date.now(),
    wasSelfDeaf,
    receiver,
    onSpeaking: null,
    streams: [],
  };

  const watch = (speakerId) => {
    if (receiver.subscriptions.has(speakerId)) return;
    // ⚠️ `receiver.subscribe()`(받기)는 `connection.subscribe()`(보내기)와 다른 것입니다.
    // 불변조건 1 의 `subscribeTo()` 를 건드리지 않습니다.
    const stream = receiver.subscribe(speakerId, { end: { behavior: EndBehaviorType.Manual } });
    state.streams.push(stream);
    stream.on('data', (chunk) => {
      const now = Date.now();
      let track = state.byUserId.get(speakerId);
      if (!track) {
        track = [];
        state.byUserId.set(speakerId, track);
      }
      track.push({ at: now, data: chunk });
      pruneTrack(track, now - keepMs());
    });
    stream.on('error', (err) => {
      // 복호화 실패가 여기로 옵니다. 원문을 남깁니다 (3.1-4) — 원인을 추측하지 않습니다.
      console.warn('[voice-buffer] 수신 오류:', speakerId, err?.message ?? err);
    });
  };

  state.onSpeaking = (speakerId) => watch(speakerId);
  receiver.speaking.on('start', state.onSpeaking);
  for (const member of channel.members.values()) if (!member.user.bot) watch(member.id);

  armed.set(guildId, state);
  return { already: false, channelId: channel.id, people: state.byUserId.size };
}

/** 소리 기록을 끕니다. 버퍼는 메모리에만 있었으므로 그대로 사라집니다. */
export function disarm(guildId, audio = null) {
  const state = armed.get(guildId);
  if (!state) return false;
  armed.delete(guildId);
  try {
    state.receiver?.speaking?.off?.('start', state.onSpeaking);
  } catch {
    // 이미 정리된 커넥션입니다.
  }
  for (const stream of state.streams) {
    try {
      stream.destroy();
    } catch {
      // 이미 닫힌 스트림입니다.
    }
  }
  state.byUserId.clear();
  const connection = audio?.connection;
  if (state.wasSelfDeaf && connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try {
      connection.rejoin({ selfDeaf: true });
    } catch (err) {
      console.warn('[voice-buffer] 귀 막기 복원 실패:', err.message);
    }
  }
  return true;
}

/** 음성채널에서 나간 사람의 버퍼를 버립니다. 안 버리면 켜둔 동안 계속 쌓입니다. */
export function forgetSpeaker(guildId, userId) {
  const state = armed.get(guildId);
  if (!state) return;
  state.byUserId.delete(userId);
  try {
    state.receiver?.subscriptions?.get?.(userId)?.destroy?.();
  } catch {
    // 이미 닫혔습니다.
  }
}

// ── 저장 ──────────────────────────────────────────────────

/** PCM 을 ffmpeg 표준입력으로 넣어 m4a 로 만듭니다. 임시 파일을 만들지 않습니다. */
function encodeM4a(pcm, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
        '-c:a', 'aac', '-b:a', '128k',
        outPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] }
    );
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 종료코드 ${code}${err ? ` · ${err.trim().split('\n').slice(-3).join(' / ')}` : ''}`));
    });
    child.stdin.on('error', () => {
      // ffmpeg 이 먼저 죽으면 EPIPE 가 납니다. 종료코드로 이미 보고합니다.
    });
    child.stdin.end(pcm);
  });
}

/**
 * 지금 기준 지난 N초를 파일로 남깁니다.
 *
 * 받은 게 없으면 **만들지 않고 그렇게 알려줍니다.** 빈 파일을 남기면 수신이 막힌 것을
 * "소리가 조용했다" 로 오해하게 됩니다.
 */
export async function saveLast(guildId, { folder, seconds = null, name = null } = {}) {
  const state = armed.get(guildId);
  if (!state) return { ok: false, reason: 'off' };

  const span = Math.max(5, Math.min(config.voice.clipSec, seconds ?? config.voice.clipSec));
  const toMs = Date.now();
  const fromMs = toMs - span * 1_000;

  const tracks = [];
  const speakers = [];
  for (const [userId, packets] of state.byUserId) {
    if (packets.length === 0) continue;
    // 사람마다 디코더를 새로 만듭니다. opus 디코더는 상태를 들고 있어 섞어 쓰면 깨집니다.
    const decoder = new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO);
    try {
      const track = layoutTrack(packets, { fromMs, toMs, decode: (buf) => decoder.decode(buf) });
      if (track.frames > 0) {
        tracks.push(track);
        speakers.push(userId);
      }
    } finally {
      decoder.delete?.();
    }
  }

  if (tracks.length === 0) {
    return { ok: false, reason: 'silent', people: state.byUserId.size };
  }

  const dir = folderPath(folder);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  // 이름은 우리가 만들지만 그래도 클립 규칙을 통과시킵니다. 예외를 만들면 언젠가 새는 곳이 됩니다.
  const file = safeClipName(`소리-${name ? `${name}-` : ''}${stamp}`) + '.m4a';
  const outPath = path.join(dir, file);

  await encodeM4a(mixTracks(tracks), outPath);
  const stat = await fs.stat(outPath).catch(() => null);
  return { ok: true, file, bytes: stat?.size ?? 0, speakers, seconds: span };
}
