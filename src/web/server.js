// 이미지 갤러리 웹서버.
//
// 왜 웹페이지인가:
//   디스코드에서는 사진을 한 장씩 눌러서 받아야 합니다. 여러 장을 한 번에 받으려면
//   ZIP으로 묶는 수밖에 없는데, 사용자는 "묶지 말고 여러 장을 한 번에" 받길 원했습니다.
//   브라우저는 링크를 연달아 클릭해주면 파일을 한 장씩 각각 저장할 수 있으므로,
//   체크박스로 고르고 버튼 한 번 누르면 전부 개별 파일로 내려받는 페이지를 띄웁니다.
//   (크롬은 처음 한 번 "여러 파일을 다운로드하시겠습니까?" 를 묻고, 허용하면 그다음부터 조용합니다.)
import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { inRole } from '../settings.js';
import { listClips, filePath as clipFilePath, deleteClip } from '../stream/clips.js';
import {
  listFolders,
  listFiles,
  filePath,
  folderPath,
  createFolder,
  moveFiles,
  deleteFiles,
  baseDir,
} from '../images/store.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

function safeCompare(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function createWebServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');

  // ── 인증 ──
  // 보기·내려받기는 **누구나** 가능합니다. 링크를 아는 사람이면 그대로 열립니다.
  // (소유자 요청: 친구들이 비개발자라서 로그인·암호 단계를 두면 아무도 안 씀)
  //
  // 다만 **삭제·이동·폴더생성은 되돌릴 수 없으므로** WEB_TOKEN 으로 막습니다.
  // 공개 포트는 자동 스캐너에 금방 발견되는데, 그때 사진이 통째로 지워지면 답이 없습니다.
  // 친구들은 이 기능을 쓸 일이 없고, 소유자만 한 번 암호를 넣으면 됩니다.
  const checkToken = (req) => {
    const header = req.headers.authorization ?? '';
    const [scheme, value] = header.split(' ');
    if (scheme !== 'Basic' || !value) return false;
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    return safeCompare(pass, config.images.webToken);
  };

  /** 삭제·이동 같은 되돌릴 수 없는 작업용. JSON 으로 401 을 돌려줍니다. */
  const requireToken = (req, res, next) => {
    if (!config.images.webToken) return next(); // 암호를 안 걸었으면 그대로 통과
    if (checkToken(req)) return next();
    res.status(401).json({ error: '관리 암호가 필요합니다. (.env 의 WEB_TOKEN)' });
  };

  /** 폴더 목록처럼 **소유자만 볼 페이지**용. 브라우저 로그인창을 띄웁니다. */
  const requireTokenPage = (req, res, next) => {
    if (!config.images.webToken) return next();
    if (checkToken(req)) return next();
    res
      .set('WWW-Authenticate', 'Basic realm="Gallery Admin", charset="UTF-8"')
      .status(401)
      .type('html')
      .send(
        layout(
          '관리자 전용',
          '<main style="padding:40px;text-align:center">' +
            '<h2>관리자 전용 페이지입니다</h2>' +
            '<p class="muted">비밀번호 칸에 봇 설정의 <code>WEB_TOKEN</code> 값을 넣으세요. 아이디는 아무거나 됩니다.</p>' +
            '</main>'
        )
      );
  };

  // ── 루트: 안내만 (폴더 이름을 노출하지 않음) ──
  // 친구들은 /갤러리 명령이 준 /f/<폴더> 링크로 바로 들어옵니다.
  // 루트에 폴더 목록을 두면 자기 채널이 아닌 폴더까지 다 보이므로 여기서는 감춥니다.
  app.get('/', (req, res) => {
    res.type('html').send(layout('이미지 갤러리', landingPage()));
  });

  // ── 폴더 목록: 소유자 전용 ──
  app.get('/folders', requireTokenPage, async (req, res, next) => {
    try {
      const folders = await listFolders();
      res.type('html').send(layout('폴더 목록', foldersPage(folders)));
    } catch (e) {
      next(e);
    }
  });

  // ── 폴더 안 갤러리 ──
  app.get('/f/:folder', async (req, res, next) => {
    try {
      const folder = req.params.folder;
      const files = await listFiles(folder);
      res.type('html').send(layout(folder, galleryPage(folder, files)));
    } catch (e) {
      next(e);
    }
  });

  // ── 이미지 원본 (브라우저에서 보기) ──
  app.get('/img/:folder/:file', (req, res, next) => {
    try {
      res.sendFile(filePath(req.params.folder, req.params.file), {
        headers: { 'Cache-Control': 'private, max-age=3600' },
      });
    } catch (e) {
      next(e);
    }
  });

  // ── 이미지 다운로드 (저장 강제) ──
  app.get('/dl/:folder/:file', (req, res, next) => {
    try {
      res.download(filePath(req.params.folder, req.params.file), req.params.file);
    } catch (e) {
      next(e);
    }
  });

  // ── 방송 클립 ──
  //
  // 갤러리와 **같은 인증 경계**입니다 (3.6-3): 보기·내려받기는 주소를 알면 누구나,
  // 삭제만 WEB_TOKEN. 라이브 자체가 일부공개(주소만 알면 누구나)라서 클립을 더 잠글 이유가 없습니다.
  //
  // ⚠️ `res.sendFile` 을 쓰면 Range 요청이 자동으로 처리됩니다.
  //    그래야 브라우저에서 재생 중 앞뒤로 건너뛸 수 있습니다.
  if (inRole('stream')) {
    app.get('/c/:folder', async (req, res, next) => {
      try {
        const folder = req.params.folder;
        const files = await listClips(folder);
        res.type('html').send(layout(`클립 ${folder}`, clipPage(folder, files)));
      } catch (e) {
        next(e);
      }
    });

    app.get('/clip/:folder/:file', (req, res, next) => {
      try {
        res.sendFile(clipFilePath(req.params.folder, req.params.file), {
          headers: { 'Cache-Control': 'private, max-age=3600' },
        });
      } catch (e) {
        next(e);
      }
    });

    app.get('/cdl/:folder/:file', (req, res, next) => {
      try {
        res.download(clipFilePath(req.params.folder, req.params.file), req.params.file);
      } catch (e) {
        next(e);
      }
    });

    app.post('/api/clip-delete', requireToken, async (req, res, next) => {
      try {
        const { folder, files } = req.body ?? {};
        if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: '파일이 없습니다.' });
        let deleted = 0;
        for (const f of files) if (await deleteClip(folder, f)) deleted++;
        res.json({ deleted });
      } catch (e) {
        next(e);
      }
    });
  }

  // ── 관리 API ──
  app.post('/api/move', requireToken, async (req, res, next) => {
    try {
      const { from, files, to } = req.body ?? {};
      if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: '파일이 없습니다.' });
      await createFolder(to);
      const moved = await moveFiles(from, files, to);
      res.json({ moved });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/delete', requireToken, async (req, res, next) => {
    try {
      const { folder, files } = req.body ?? {};
      if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: '파일이 없습니다.' });
      const deleted = await deleteFiles(folder, files);
      res.json({ deleted });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/folder', requireToken, async (req, res, next) => {
    try {
      const name = await createFolder(req.body?.name);
      res.json({ name });
    } catch (e) {
      next(e);
    }
  });

  app.use((err, req, res, _next) => {
    console.error('[web]', err.message);
    res.status(err.status === 404 || err.code === 'ENOENT' ? 404 : 500).send(esc(err.message));
  });

  return app;
}

export function startWebServer() {
  const app = createWebServer();
  return new Promise((resolve) => {
    const server = app.listen(config.images.webPort, config.images.webBind, () => {
      const scope = config.images.webBind === '127.0.0.1' ? '이 컴퓨터 안에서만' : '외부 접속 허용';
      console.log(
        `[web] 이미지 갤러리: ${config.images.webPublicUrl}  (${scope}, 저장 위치: ${baseDir()})`
      );
      if (!config.images.webToken && config.images.webBind !== '127.0.0.1') {
        console.warn(
          '[web] 경고: WEB_TOKEN 이 비어 있습니다. 사진 삭제·이동도 누구나 할 수 있습니다.'
        );
      }
      // 외부에 열어놨는데 주소가 localhost 면 친구들은 그 링크를 열 수 없습니다.
      // /갤러리 가 알려주는 주소가 곧 친구들이 받는 링크이므로, 여기서 미리 알려줍니다.
      if (
        config.images.webBind === '0.0.0.0' &&
        /localhost|127\.0\.0\.1/.test(config.images.webPublicUrl)
      ) {
        console.warn(
          [
            '[web] 경고: 외부 접속은 열려 있는데 WEB_PUBLIC_URL 이 localhost 입니다.',
            '      /갤러리 가 알려주는 주소를 친구들이 열 수 없습니다.',
            `      .env 의 WEB_PUBLIC_URL 을 http://<서버IP>:${config.images.webPort} 로 바꿔주세요.`,
          ].join('\n')
        );
      }
      resolve(server);
    });
  });
}

// ── HTML ────────────────────────────────────────────────────

function layout(title, body) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 이미지 갤러리</title>
<style>
  :root {
    --bg: #ffffff; --fg: #16181d; --muted: #656b7a; --line: #e3e6ec;
    --card: #f6f7f9; --accent: #5865f2; --accent-fg: #ffffff; --danger: #d43d51;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d; --fg: #e8eaf0; --muted: #9aa1b1; --line: #2c3038;
      --card: #1e2128; --accent: #5865f2; --accent-fg: #ffffff; --danger: #f0616f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.55 -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
    padding-bottom: 96px;
  }
  a { color: inherit; }
  header {
    position: sticky; top: 0; z-index: 5; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 14px 20px;
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  }
  header h1 { font-size: 17px; margin: 0; font-weight: 650; }
  .muted { color: var(--muted); font-size: 13px; }
  main { padding: 20px; max-width: 1400px; margin: 0 auto; }
  .btn {
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
    padding: 7px 13px; border-radius: 8px; font-size: 13px; cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn.danger { color: var(--danger); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }

  .folders { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  .folder {
    display: block; text-decoration: none; padding: 16px; border: 1px solid var(--line);
    border-radius: 12px; background: var(--card);
  }
  .folder:hover { border-color: var(--accent); }
  .folder b { display: block; font-size: 15px; margin-bottom: 4px; word-break: break-all; }

  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
  .cell { position: relative; border: 2px solid transparent; border-radius: 10px; overflow: hidden; background: var(--card); }
  .cell.sel { border-color: var(--accent); }
  .cell img {
    width: 100%; aspect-ratio: 1; object-fit: cover; display: block; cursor: pointer;
    background: var(--card);
  }
  .cell .cap { padding: 6px 8px; font-size: 11px; color: var(--muted); word-break: break-all; }
  .cell .tick {
    position: absolute; top: 8px; left: 8px; width: 24px; height: 24px; border-radius: 6px;
    background: rgba(0,0,0,.55); color: #fff; display: flex; align-items: center;
    justify-content: center; font-size: 14px; cursor: pointer; user-select: none;
  }
  .cell.sel .tick { background: var(--accent); }
  .cell .open {
    position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border-radius: 6px;
    background: rgba(0,0,0,.55); color: #fff; display: flex; align-items: center;
    justify-content: center; font-size: 13px; text-decoration: none;
  }

  .bar {
    position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg);
    border-top: 1px solid var(--line); padding: 12px 20px; display: flex;
    align-items: center; gap: 10px; flex-wrap: wrap; z-index: 10;
  }
  .bar .count { font-weight: 650; }
  .empty { color: var(--muted); padding: 40px 0; text-align: center; }
  input[type=text] {
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
    padding: 7px 10px; border-radius: 8px; font: inherit; font-size: 13px;
  }
</style>
</head>
<body>${body}</body>
</html>`;
}

/** 루트에 오는 사람에게 보여줄 안내. 폴더 이름은 일부러 노출하지 않습니다. */
function landingPage() {
  return `<header><h1>🖼️ 이미지 갤러리</h1></header>
<main>
  <p>사진은 디스코드 채널별로 정리되어 있습니다.</p>
  <p class="muted">보려는 채널에서 <code>/갤러리</code> 를 입력하면 그 채널의 사진 링크가 나옵니다.</p>
  <p style="margin-top:28px"><a class="btn" href="/folders">폴더 목록 보기 (관리자)</a></p>
</main>`;
}

function foldersPage(folders) {
  const total = folders.reduce((a, f) => a + f.count, 0);
  const cards = folders
    .map(
      (f) => `<a class="folder" href="/f/${encodeURIComponent(f.name)}">
        <b>${esc(f.name)}</b>
        <span class="muted">${f.count}장 · ${fmtBytes(f.bytes)}</span>
      </a>`
    )
    .join('');

  return `<header><h1>📁 폴더 목록</h1><span class="muted">${folders.length}개 폴더 · 총 ${total}장</span></header>
<main>${cards ? `<div class="folders">${cards}</div>` : '<p class="empty">아직 저장된 이미지가 없습니다.<br>디스코드에서 지정한 채널에 이미지를 올려보세요.</p>'}</main>`;
}

/**
 * 방송 클립 목록 페이지.
 *
 * 사진 갤러리와 다르게 **여러 개를 한꺼번에 받을 일이 거의 없습니다** (한 개가 수 MB 라서).
 * 그래서 체크박스·일괄 다운로드를 만들지 않고, 카드마다 재생기와 받기 버튼만 둡니다.
 */
function clipPage(folder, files) {
  const cards = files
    .map((f) => {
      const src = `/clip/${encodeURIComponent(folder)}/${encodeURIComponent(f.name)}`;
      const dl = `/cdl/${encodeURIComponent(folder)}/${encodeURIComponent(f.name)}`;
      const when = new Date(f.mtime).toLocaleString('ko-KR');
      // ⚠️ 소리만인 클립을 `<video>` 로 보여주면 **검은 화면**이 나옵니다.
      //    사람은 "재생이 안 된다" 고 생각합니다. 종류에 맞는 태그를 씁니다.
      const player = f.audio
        ? `<div class="audio-wrap"><span class="audio-badge">🎧 소리만</span>
             <audio src="${esc(src)}" controls preload="metadata"></audio></div>`
        : `<video src="${esc(src)}" controls preload="metadata" playsinline></video>`;
      return `<div class="clip" data-name="${esc(f.name)}">
        ${player}
        <div class="clip-info">
          <b>${esc(f.name.replace(/\.[a-z0-9]+$/i, ''))}</b>
          <span class="muted">${fmtBytes(f.bytes)} · ${esc(when)}${f.audio ? ' · 화면 없음' : ''}</span>
        </div>
        <div class="clip-actions">
          <a class="btn primary" href="${esc(dl)}">⬇️ 받기</a>
          <button class="btn danger" data-del>🗑️</button>
        </div>
      </div>`;
    })
    .join('');

  return `<header>
  <h1>🎥 방송 클립</h1>
  <span class="muted">${files.length}개 · ${fmtBytes(files.reduce((a, f) => a + f.bytes, 0))}</span>
</header>
<main>
  ${
    files.length
      ? `<div class="clips">${cards}</div>`
      : '<p class="empty">이 방송에는 아직 만든 클립이 없습니다.<br>디스코드의 요약판에서 <b>🎥 클립 만들 순간 고르기</b> 로 만드세요.</p>'
  }
</main>
<style>
  .clips { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  .clip { border: 1px solid var(--line); border-radius: 12px; background: var(--card); overflow: hidden; }
  .clip video { width: 100%; display: block; background: #000; aspect-ratio: 16/9; }
  .audio-wrap {
    aspect-ratio: 16/9; background: var(--bg); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 12px; border-bottom: 1px solid var(--line);
  }
  .audio-badge { font-size: 13px; color: var(--muted); }
  .audio-wrap audio { width: 92%; }
  .clip-info { padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 2px; }
  .clip-info b { font-size: 14px; word-break: break-all; }
  .clip-actions { padding: 8px 12px 12px; display: flex; gap: 8px; }
  .clip-actions .btn { text-decoration: none; }
  .empty { color: var(--muted); text-align: center; padding: 60px 20px; line-height: 1.9; }
</style>
<script>
(function () {
  var folder = ${JSON.stringify(folder)};
  document.querySelectorAll('.clip').forEach(function (card) {
    card.querySelector('[data-del]').addEventListener('click', function () {
      var name = card.dataset.name;
      if (!confirm(name + ' 을 지웁니다. 되돌릴 수 없습니다.')) return;
      fetch('/api/clip-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folder, files: [name] }),
      }).then(function (r) {
        if (r.status === 401) { alert('관리 암호가 필요합니다. (봇 설정의 WEB_TOKEN)'); return; }
        if (!r.ok) { alert('지우지 못했습니다.'); return; }
        card.remove();
      }).catch(function () { alert('연결에 실패했습니다.'); });
    });
  });
})();
</script>`;
}

function galleryPage(folder, files) {
  const cells = files
    .map((f) => {
      const src = `/img/${encodeURIComponent(folder)}/${encodeURIComponent(f.name)}`;
      const who = f.meta?.author ? ` · ${esc(f.meta.author)}` : '';
      return `<div class="cell" data-name="${esc(f.name)}">
        <div class="tick" data-tick>✓</div>
        <a class="open" href="${src}" target="_blank" rel="noopener" title="원본 보기">⤢</a>
        <img src="${src}" loading="lazy" alt="${esc(f.name)}">
        <div class="cap">${fmtBytes(f.size)}${who}</div>
      </div>`;
    })
    .join('');

  // 뒤로가기(폴더 목록) 버튼은 일부러 없습니다.
  // 폴더 목록은 소유자 전용이고, 친구들은 자기 채널 폴더만 보면 되기 때문입니다.
  return `<header>
  <h1>${esc(folder)}</h1>
  <span class="muted">${files.length}장</span>
</header>
<main>
  ${files.length ? `<div class="grid" id="grid">${cells}</div>` : '<p class="empty">이 폴더에는 이미지가 없습니다.</p>'}
</main>

<div class="bar">
  <button class="btn" id="all">전체 선택</button>
  <button class="btn" id="none">선택 해제</button>
  <span class="count" id="count">0장 선택</span>
  <button class="btn primary" id="dl" disabled>⬇️ 선택한 사진 받기</button>
  <input type="text" id="dest" placeholder="옮길 폴더 이름" style="width:150px">
  <button class="btn" id="move" disabled>📂 옮기기</button>
  <button class="btn danger" id="del" disabled>🗑️ 삭제</button>
</div>

<script>
(function () {
  var folder = ${JSON.stringify(folder)};
  var grid = document.getElementById('grid');
  var selected = new Set();
  var lastIndex = -1;

  function cells() { return grid ? Array.prototype.slice.call(grid.querySelectorAll('.cell')) : []; }

  function render() {
    cells().forEach(function (c) {
      c.classList.toggle('sel', selected.has(c.dataset.name));
    });
    var n = selected.size;
    document.getElementById('count').textContent = n + '장 선택';
    ['dl', 'move', 'del'].forEach(function (id) {
      document.getElementById(id).disabled = n === 0;
    });
  }

  function toggle(cell, index, shift) {
    if (shift && lastIndex >= 0) {
      // 시프트를 누른 채 클릭하면 이전에 고른 것부터 여기까지 한꺼번에 선택합니다.
      var list = cells();
      var a = Math.min(lastIndex, index), b = Math.max(lastIndex, index);
      for (var i = a; i <= b; i++) selected.add(list[i].dataset.name);
    } else {
      var name = cell.dataset.name;
      if (selected.has(name)) selected.delete(name); else selected.add(name);
      lastIndex = index;
    }
    render();
  }

  cells().forEach(function (cell, i) {
    cell.querySelector('[data-tick]').addEventListener('click', function (e) {
      e.preventDefault(); toggle(cell, i, e.shiftKey);
    });
    cell.querySelector('img').addEventListener('click', function (e) {
      e.preventDefault(); toggle(cell, i, e.shiftKey);
    });
  });

  document.getElementById('all').addEventListener('click', function () {
    cells().forEach(function (c) { selected.add(c.dataset.name); });
    render();
  });
  document.getElementById('none').addEventListener('click', function () {
    selected.clear(); lastIndex = -1; render();
  });

  // 핵심 기능: 고른 사진을 ZIP으로 묶지 않고 한 장씩 전부 내려받습니다.
  document.getElementById('dl').addEventListener('click', function () {
    var names = Array.from(selected);
    var btn = this;
    btn.disabled = true;
    var i = 0;
    (function next() {
      if (i >= names.length) {
        btn.disabled = false;
        btn.textContent = '⬇️ 선택한 사진 받기';
        return;
      }
      var name = names[i++];
      btn.textContent = '받는 중… ' + i + '/' + names.length;
      var a = document.createElement('a');
      a.href = '/dl/' + encodeURIComponent(folder) + '/' + encodeURIComponent(name);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 브라우저가 다운로드를 따라잡을 시간을 줍니다. 너무 빠르면 일부를 놓칩니다.
      setTimeout(next, 350);
    })();
  });

  document.getElementById('move').addEventListener('click', function () {
    var to = document.getElementById('dest').value.trim();
    if (!to) { alert('옮길 폴더 이름을 입력하세요.'); return; }
    post('/api/move', { from: folder, files: Array.from(selected), to: to });
  });

  document.getElementById('del').addEventListener('click', function () {
    if (!confirm(selected.size + '장을 정말 삭제할까요? 되돌릴 수 없습니다.')) return;
    post('/api/delete', { folder: folder, files: Array.from(selected) });
  });

  // 보기·내려받기는 암호가 없습니다. 삭제·이동만 관리 암호를 요구합니다.
  // 한 번 넣으면 이 브라우저 탭에서는 다시 묻지 않습니다.
  function adminAuth(forget) {
    if (forget) sessionStorage.removeItem('galleryToken');
    var t = null;
    try { t = sessionStorage.getItem('galleryToken'); } catch (e) {}
    if (!t) {
      t = window.prompt('관리 암호를 입력하세요 (봇 설정의 WEB_TOKEN)');
      if (!t) return null;
      try { sessionStorage.setItem('galleryToken', t); } catch (e) {}
    }
    return 'Basic ' + btoa('admin:' + t);
  }

  function post(url, body, retried) {
    var auth = adminAuth(false);
    if (!auth) return;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 401) {
        if (retried) { alert('암호가 틀렸습니다.'); return null; }
        adminAuth(true);              // 저장된 암호를 버리고 다시 묻습니다
        return post(url, body, true);
      }
      return r.json();
    }).then(function (j) {
      if (!j) return;
      if (j.error) alert(j.error); else location.reload();
    }).catch(function (e) { alert(e.message); });
  }

  render();
})();
</script>`;
}
