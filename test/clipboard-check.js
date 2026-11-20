// 剪贴板复制检查（真实窗口 headful）
//
// 验证「复制图片」按钮真的把成品 PNG 写进了系统剪贴板：
//   1. 用 OffscreenCanvas 造一张已知尺寸/颜色的图，写进 IndexedDB，打开编辑器
//   2. 用 CDP 发真实鼠标点击（满足 Clipboard API 的用户手势要求）
//   3. 用 AppleScript 把系统剪贴板里的 PNG 数据落盘，解码验证内容
//
// 用法：node test/clipboard-check.js
//
// 注意：会临时覆盖系统剪贴板，测试前备份文本内容，结束后恢复。
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { decodePNG } = require('./png');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'area-screenshot-clip');
const EXT = path.join(TMP, 'ext');
const PROFILE = path.join(TMP, 'profile');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9366);

const SRC_W = 400;
const SRC_H = 260;
const SRC_RGB = [30, 144, 255]; // #1e90ff

function loadWS() {
  try {
    return require('ws');
  } catch {
    const { execSync } = require('child_process');
    return require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'ws'));
  }
}
const WebSocket = loadWS();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJSON = (p) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => {
          try { res(JSON.parse(b)); } catch (e) { rej(e); }
        });
      })
      .on('error', rej);
  });

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ready = new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  return { ws, send, ready };
}

function prepareExtension() {
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(EXT, { recursive: true });
  fs.mkdirSync(path.join(EXT, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'icons'))) {
    if (f.endsWith('.png')) fs.copyFileSync(path.join(ROOT, 'icons', f), path.join(EXT, 'icons', f));
  }
  for (const f of ['background.js', 'editor.html', 'editor.css', 'editor.js', 'i18n.js', 'manifest.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(EXT, f));
  }
  fs.cpSync(path.join(ROOT, '_locales'), path.join(EXT, '_locales'), { recursive: true });
}

async function launchChrome() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,860',
    '--window-position=40,40',
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 80; i++) {
    try { version = await getJSON('/json/version'); break; } catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome 启动失败');
  return { proc, version };
}

// ---- 系统剪贴板（macOS）----

function backupClipboard() {
  try {
    return execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function restoreClipboard(text) {
  if (text == null) return;
  try {
    execFileSync('/usr/bin/pbcopy', { input: text });
  } catch {}
}

function clipboardInfo() {
  try {
    return execFileSync('/usr/bin/osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return 'clipboard info 失败: ' + e.message;
  }
}

// pbpaste 只支持 txt/rtf/ps，图片必须走 AppleScript 拿原始 PNG 数据
function readClipboardPNG() {
  const out = path.join(TMP, 'clip.png');
  const script = `on run argv
  set outPath to item 1 of argv
  try
    set pngData to the clipboard as «class PNGf»
  on error
    return "no-png"
  end try
  set outFile to open for access (POSIX file outPath) with write permission
  set eof outFile to 0
  write pngData to outFile
  close access outFile
  return "ok"
end run`;
  const res = execFileSync('/usr/bin/osascript', ['-e', script, out], { encoding: 'utf8' }).trim();
  if (res !== 'ok') throw new Error(`剪贴板里没有 PNG（${res}；类型：${clipboardInfo()}）`);
  return fs.readFileSync(out);
}

const report = [];
const check = (name, ok, detail = '') => {
  report.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

(async () => {
  const clipBackup = backupClipboard();
  prepareExtension();
  const { proc } = await launchChrome();

  try {
    const browser = connect((await getJSON('/json/version')).webSocketDebuggerUrl);
    await browser.ready;

    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
    await sleep(1500);

    let sw = null;
    for (let i = 0; i < 40; i++) {
      const l = await getJSON('/json/list');
      sw = l.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
      if (sw) break;
      await sleep(250);
    }
    if (!sw) throw new Error('找不到扩展 service worker');

    const swConn = connect(sw.webSocketDebuggerUrl);
    await swConn.ready;
    const evalSW = async (expr) =>
      (await swConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
        .result.value;

    // 造图 → 写 IndexedDB → 打开编辑器
    const created = await evalSW(`(async () => {
      const c = new OffscreenCanvas(${SRC_W}, ${SRC_H});
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(${SRC_RGB.join(',')})';
      ctx.fillRect(0, 0, ${SRC_W}, ${SRC_H});
      const blob = await c.convertToBlob({ type: 'image/png' });

      const id = crypto.randomUUID();
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('area-screenshot', 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('shots')) d.createObjectStore('shots');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('shots', 'readwrite');
        tx.objectStore('shots').put(blob, id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();

      const url = chrome.runtime.getURL('editor.html') + '?id=' + encodeURIComponent(id) + '&name=clip-test.png';
      await chrome.tabs.create({ url, active: true });
      return 'ok';
    })()`);
    if (created !== 'ok') throw new Error('构造截图失败: ' + created);

    let edTarget = null;
    for (let i = 0; i < 60; i++) {
      const l = await getJSON('/json/list');
      edTarget = l.find((t) => t.type === 'page' && (t.url || '').includes('/editor.html'));
      if (edTarget) break;
      await sleep(250);
    }
    if (!edTarget) throw new Error('编辑器标签页未打开');

    const edConn = connect(edTarget.webSocketDebuggerUrl);
    await edConn.ready;
    await edConn.send('Page.enable');
    // 窗口可能不在前台，模拟焦点，避免 Clipboard API 报 Document is not focused
    await edConn.send('Target.activateTarget', { targetId: edTarget.id }).catch(() => {});
    await edConn.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

    const evalEd = async (expr) =>
      (await edConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
        .result.value;

    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evalEd(`document.body.dataset.ready === '1'`);
      if (ready) break;
      await sleep(200);
    }
    const bmp = ready ? await evalEd(`({ w: bmp.width, h: bmp.height })`) : null;
    check('编辑器就绪并拿到原图', !!ready && bmp && bmp.w === SRC_W && bmp.h === SRC_H, JSON.stringify(bmp));

    // 真实鼠标点击（Clipboard API 需要用户激活，程序化 .click() 不满足）
    const rect = await evalEd(`(() => {
      const b = document.getElementById('copy').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    const base = { button: 'left', clickCount: 1, pointerType: 'mouse' };
    await edConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, ...base, buttons: 1 });
    await edConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, ...base, buttons: 0 });

    await sleep(1200);

    const state = await evalEd(`({
      text: document.getElementById('copy').textContent.trim(),
      hint: document.getElementById('hint').textContent,
      open: true,
    })`);
    check('点击后按钮反馈「已复制」', /已复制|已複製|Copied/.test(state.text), JSON.stringify(state.text));
    check('提示文案指向微信 / 钉钉', /微信|钉钉|WeChat|DingTalk/.test(state.hint), state.hint);

    // 系统剪贴板：这是唯一的外部裁判物
    let png = null;
    let decodeErr = null;
    try {
      png = readClipboardPNG();
    } catch (e) {
      decodeErr = e.message;
    }
    let img = null;
    try {
      if (png) img = decodePNG(png);
    } catch (e) {
      decodeErr = e.message;
    }
    check('系统剪贴板里是有效 PNG', !!img, decodeErr || `${png ? png.length + ' 字节' : '空'}`);
    check('PNG 尺寸与原图一致', !!img && img.w === SRC_W && img.h === SRC_H, img ? `${img.w}x${img.h}` : '');

    if (img) {
      const px = img.pixel(10, 10);
      const near = (a, b) => Math.abs(a - b) <= 2;
      const same = px.every((v, i) => near(v, SRC_RGB[i]));
      check('像素内容与原图一致', same, `剪贴板 rgb(${px.join(',')}) vs 原图 rgb(${SRC_RGB.join(',')})`);
    }

    // 复制不应关掉标签页
    const alive = (await getJSON('/json/list')).some((t) => (t.url || '').includes('/editor.html'));
    check('复制后编辑器标签页保持打开', alive);

    swConn.ws.close();
    edConn.ws.close();
    browser.ws.close();
  } finally {
    try { proc.kill(); } catch {}
    restoreClipboard(clipBackup);
    await sleep(600);
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
  }

  const failed = report.filter((r) => !r.ok);
  console.log(`\n${report.length - failed.length}/${report.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
