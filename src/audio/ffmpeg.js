// 어떤 오디오든 ffmpeg으로 Ogg Opus(48kHz 스테레오)로 바꿔서 디스코드에 바로 먹입니다.
//
// 왜 이렇게 하나:
//   디스코드 음성은 Opus만 받습니다. 이 변환을 JS 라이브러리로 하면 CPU를 많이 먹는데,
//   ffmpeg의 네이티브 libopus로 미리 변환해두면 discord.js는 컨테이너만 벗겨내면 되므로
//   1코어짜리 저가 VPS에서도 여유롭게 돌아갑니다.
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

/**
 * @param {import('node:stream').Readable | string} input  스트림 또는 파일 경로
 * @param {{ volume?: number, seekSec?: number }} [opts]
 * @returns {{ stream: import('node:stream').Readable, kill: () => void }}
 */
export function toOggOpus(input, opts = {}) {
  const { volume = 1, seekSec = 0, remote = false, onError = null } = opts;
  const isStream = typeof input !== 'string';

  const args = ['-hide_banner', '-loglevel', 'error'];

  // 인터넷 주소를 직접 받을 때는 중간에 끊겨도 스스로 다시 붙게 해둡니다.
  // (유튜브 CDN 은 긴 곡에서 간헐적으로 연결을 끊습니다)
  if (remote) {
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5'
    );
  }

  if (seekSec > 0) args.push('-ss', String(seekSec));
  args.push('-i', isStream ? 'pipe:0' : input);

  args.push(
    '-vn',                    // 영상 트랙 버리기
    '-map_metadata', '-1',
    '-ac', '2',               // 스테레오
    '-ar', '48000'            // 디스코드가 요구하는 샘플레이트
  );

  if (volume !== 1) args.push('-af', `volume=${volume}`);

  args.push(
    '-c:a', 'libopus',
    '-b:a', '96k',
    '-vbr', 'on',
    '-application', 'audio',
    '-frame_duration', '20',
    '-f', 'opus',             // Ogg Opus 컨테이너
    'pipe:1'
  );

  const child = spawn(ffmpegPath, args, {
    stdio: [isStream ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 4000) stderr = stderr.slice(-2000);
  });
  child.on('close', (code) => {
    // 실패했는데 아무 데도 안 알리면 "곡이 조용히 사라지는" 증상이 됩니다.
    // 여기서 잡아 호출한 쪽(guild-audio)이 사용자에게 알릴 수 있게 넘겨줍니다.
    if (code !== 0 && code !== null) {
      const msg = stderr.trim().split('\n').slice(-3).join(' | ') || `ffmpeg 종료 코드 ${code}`;
      console.error('[ffmpeg]', msg);
      onError?.(msg);
    }
  });

  if (isStream) {
    input.pipe(child.stdin);
    // 앞 프로세스(yt-dlp)가 먼저 죽으면 EPIPE가 나는데, 정상 종료 과정이라 무시합니다.
    child.stdin.on('error', () => {});
    input.on('error', () => {});
  }

  const kill = () => {
    if (!child.killed) child.kill('SIGKILL');
    if (isStream && typeof input.destroy === 'function') input.destroy();
  };

  return { stream: child.stdout, kill };
}
