// yt-dlp 바이너리를 bin/ 폴더에 내려받습니다.
// 공식 배포처: https://github.com/yt-dlp/yt-dlp/releases
// 유튜브가 사이트를 바꾸면 yt-dlp도 자주 업데이트되므로,
// 음악이 안 나올 때 `npm run update-ytdlp` 를 다시 실행하면 대부분 해결됩니다.
import { createWriteStream } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(ROOT, 'bin');

function assetFor(platform, arch) {
  if (platform === 'win32') return { name: 'yt-dlp.exe', file: 'yt-dlp.exe' };
  if (platform === 'darwin') return { name: 'yt-dlp_macos', file: 'yt-dlp' };
  if (platform === 'linux') {
    if (arch === 'arm64') return { name: 'yt-dlp_linux_aarch64', file: 'yt-dlp' };
    if (arch === 'arm') {
      // 32비트 ARM은 yt-dlp가 .zip 으로만 배포합니다 (비압축 바이너리가 없음).
      // 라즈베리파이라면 64비트 OS를 쓰는 편이 훨씬 편합니다.
      throw new Error(
        '32비트 ARM(armv7l)은 자동 설치를 지원하지 않습니다.\n' +
          '  - 64비트 OS(arm64)를 쓰시면 그대로 동작합니다.\n' +
          '  - 꼭 32비트를 써야 한다면 직접 설치하세요:\n' +
          '      pip install -U "yt-dlp[default]"  후  which yt-dlp 로 나온 파일을 bin/yt-dlp 로 복사'
      );
    }
    return { name: 'yt-dlp_linux', file: 'yt-dlp' };
  }
  throw new Error(`지원하지 않는 플랫폼입니다: ${platform}/${arch}`);
}

// YTDLP_PATH 로 다른 yt-dlp(예: pip 로 깐 것)를 쓰고 있다면, 여기서 bin/ 을 갱신해봐야
// **봇이 쓰는 것은 안 바뀝니다.** 조용히 엉뚱한 파일을 새로 받는 대신 어떻게 갱신하는지 알려줍니다.
const custom = (process.env.YTDLP_PATH ?? '').trim();
if (custom) {
  console.log(`이 봇은 bin/ 이 아니라 아래 yt-dlp 를 씁니다 (.env* 의 YTDLP_PATH):\n  ${custom}\n`);
  console.log('pip 로 깐 것이라면 이렇게 갱신하세요:');
  console.log(`  ${path.dirname(custom)}/pip install -U "yt-dlp[default]"\n`);
  console.log('bin/ 쪽을 굳이 새로 받으시려면 YTDLP_PATH 를 잠시 비우고 다시 실행하세요.');
  process.exit(0);
}

const asset = assetFor(process.platform, process.arch);
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset.name}`;
const dest = path.join(BIN_DIR, asset.file);

await mkdir(BIN_DIR, { recursive: true });
console.log(`내려받는 중: ${url}`);

const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) throw new Error(`다운로드 실패 (HTTP ${res.status})`);

await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
if (process.platform !== 'win32') await chmod(dest, 0o755);

console.log(`완료: ${dest}`);
