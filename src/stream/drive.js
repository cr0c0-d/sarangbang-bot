// 클립을 구글 드라이브에 **사본으로** 올립니다. (선택 기능)
//
// ⚠️ **이 파일은 실제 구글 API 로 검증하지 못했습니다.** (2026-09-03)
//    다른 기능들은 전부 돌려보고 만들었지만(yt-dlp 구간 추출, 고정 주소 해석 등),
//    이건 자격증명이 필요해서 확인하지 못했습니다. verify 는 "우리 코드가 의도한 대로
//    요청을 만드는가" 만 봅니다 — **구글이 그 요청을 받아주는지는 확인하지 않았습니다.**
//    처음 쓸 때 오류가 나면 응답 원문이 그대로 보이게 해뒀으니 그걸 보고 고치세요.
//
// ★ **로컬 파일을 지우지 않습니다.** 사본만 올립니다.
//   올렸다고 해놓고 실제로는 반쪽만 갔을 때 원본까지 지우면, 클립이 사라지고
//   웹페이지가 404 가 됩니다. 그러면 되돌릴 방법이 없습니다.
//   로컬 파일은 기존 예산·개수 상한이 알아서 관리합니다(clips.js).
//   → 드라이브는 **더하기만** 하는 기능입니다. 안 되면 답에 오류 한 줄이 붙고 끝입니다.
//
// 왜 googleapis 패키지를 안 쓰나: REST 로 세 번 부르면 되는 일에 의존성을 늘릴 이유가
// 없습니다. TMDB·제미나이도 같은 방식으로 붙였습니다(fetch 만 씀).
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { userError } from '../user-error.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

/** 설정이 갖춰졌는가. 하나라도 없으면 이 기능은 **조용히 꺼집니다.** */
export function enabled() {
  const d = config.drive;
  return Boolean(d.clientId && d.clientSecret && d.refreshToken);
}

/** 무엇이 빠졌는지 알려줍니다. 없으면 어디서 받는지까지 적습니다. */
export function missingConfigMessage() {
  const d = config.drive;
  const miss = [];
  if (!d.clientId) miss.push('GDRIVE_CLIENT_ID');
  if (!d.clientSecret) miss.push('GDRIVE_CLIENT_SECRET');
  if (!d.refreshToken) miss.push('GDRIVE_REFRESH_TOKEN');
  return (
    `구글 드라이브 업로드가 설정되지 않았습니다. \`.env\` 에 ${miss.join(', ')} 가 필요합니다.\n` +
    '받는 방법은 README 의 "클립을 구글 드라이브에 올리기" 를 보세요.\n' +
    '**설정하지 않아도 됩니다** — 클립은 웹페이지에서 그대로 보고 받을 수 있습니다.'
  );
}

// 토큰은 한 시간쯤 삽니다. 매번 새로 받으면 업로드마다 왕복이 하나 늘어납니다.
let cachedToken = null;
let cachedUntil = 0;

/** @internal 검증용. 캐시를 비웁니다. */
export function resetTokenCache() {
  cachedToken = null;
  cachedUntil = 0;
}

async function accessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const body = new URLSearchParams({
    client_id: config.drive.clientId,
    client_secret: config.drive.clientSecret,
    refresh_token: config.drive.refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(config.drive.timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    // ⚠️ 원인을 지어내지 말고 **구글이 한 말을 그대로** 보여줍니다. (ARCHITECTURE 3.1-4)
    throw userError(
      `구글 인증에 실패했습니다 (HTTP ${res.status}).\n` +
        `구글이 한 말: ${text.slice(0, 400)}\n\n` +
        (text.includes('invalid_grant')
          ? '→ `GDRIVE_REFRESH_TOKEN` 이 만료되거나 취소됐습니다. README 의 순서로 다시 받아주세요.'
          : '→ `.env` 의 GDRIVE_CLIENT_ID · GDRIVE_CLIENT_SECRET 를 확인해주세요.')
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw userError(`구글 응답을 읽지 못했습니다: ${text.slice(0, 200)}`);
  }
  if (!json.access_token) {
    throw userError(`구글이 토큰을 주지 않았습니다: ${text.slice(0, 300)}`);
  }

  cachedToken = json.access_token;
  // 만료 1분 전에 버립니다. 경계에서 실패하지 않게.
  cachedUntil = Date.now() + Math.max(60, (Number(json.expires_in) || 3600) - 60) * 1000;
  return cachedToken;
}

/**
 * 파일 하나를 올립니다. multipart 한 번에 보냅니다 —
 * 클립은 상한이 180초(약 34MB)라 이어올리기(resumable)가 필요하지 않습니다.
 *
 * @returns {Promise<{id: string, link: string}>}
 */
export async function uploadClip(filePath, name) {
  if (!enabled()) throw userError(missingConfigMessage());

  const token = await accessToken();
  const bytes = await fs.readFile(filePath);

  const metadata = { name, mimeType: 'video/mp4' };
  if (config.drive.folderId) metadata.parents = [config.drive.folderId];

  // multipart/related 를 손으로 조립합니다. 경계 문자열은 본문에 나올 수 없는 것으로.
  const boundary = `mango${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: video/mp4\r\n\r\n'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  const res = await fetch(`${UPLOAD_URL}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: Buffer.concat([head, bytes, tail]),
    signal: AbortSignal.timeout(config.drive.timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    throw userError(
      `드라이브 업로드에 실패했습니다 (HTTP ${res.status}).\n` +
        `구글이 한 말: ${text.slice(0, 400)}\n\n` +
        (res.status === 404
          ? '→ `GDRIVE_FOLDER_ID` 가 잘못됐거나 그 폴더에 권한이 없습니다.'
          : res.status === 403
            ? '→ 구글 클라우드 프로젝트에서 **Google Drive API** 를 켰는지 확인해주세요.'
            : '→ 위 원문이 원인입니다. 클립 파일은 서버에 그대로 있습니다.')
    );
  }

  const id = JSON.parse(text).id;
  if (!id) throw userError(`드라이브가 파일 ID 를 주지 않았습니다: ${text.slice(0, 200)}`);

  // 링크로 볼 수 있게 합니다. 실패해도 업로드 자체는 성공이므로 막지 않습니다
  // (드라이브에서 손으로 공유하면 됩니다).
  let shared = true;
  if (config.drive.shareAnyone) {
    shared = await fetch(`${FILES_URL}/${id}/permissions?supportsAllDrives=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      signal: AbortSignal.timeout(config.drive.timeoutMs),
    })
      .then((r) => r.ok)
      .catch(() => false);
  }

  return {
    id,
    link: `https://drive.google.com/file/d/${id}/view`,
    shared,
  };
}
