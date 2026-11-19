// 生成 Chrome 应用商店展示截图（1280×800）
//
// 素材来自真实运行：把扩展装进 Chrome，在 demo 页上走一遍「框选 → 滚动 → 标注」，
// 截下界面，再用 HTML 海报把界面和文案合成商店要求的 1280×800 满版图。
//
// 用法：node scripts/store-shots.js
// 输出：store-assets/screenshot-1.png … screenshot-5.png
//       store-assets/raw/（中间素材，可单独使用）
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'store-assets');
const RAW = path.join(OUT, 'raw');
const TMP = path.join(os.tmpdir(), 'region-shot-store');
const EXT = path.join(TMP, 'ext');
const DL = path.join(TMP, 'dl');
const PROFILE = path.join(TMP, 'profile');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9355);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8955);

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
        r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
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
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  fs.writeFileSync(path.join(EXT, 'background.js'), bg + '\n\nself.__selftest = { runCapture };\n');
  fs.mkdirSync(path.join(EXT, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'icons'))) {
    if (f.endsWith('.png')) fs.copyFileSync(path.join(ROOT, 'icons', f), path.join(EXT, 'icons', f));
  }
  for (const f of ['editor.html', 'editor.css', 'editor.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(EXT, f));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  if (!manifest.permissions.includes('tabs')) manifest.permissions.push('tabs');
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function startServer() {
  const server = http.createServer((req, res) => {
    const name = req.url === '/' ? '' : req.url.split('?')[0].replace(/^\//, '');
    if (name.startsWith('store-assets/')) {
      const f = path.join(ROOT, name);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': f.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(f));
        return;
      }
    }
    const file = path.join(ROOT, 'test', 'pages', name);
    if (!name || !fs.existsSync(file)) { res.writeHead(404); res.end('no page'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', () => r(server)));
}

async function launchChrome() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 80; i++) {
    try { version = await getJSON('/json/version'); break; } catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome 启动失败');
  return { proc, version };
}

(async () => {
  fs.rmSync(RAW, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  for (const f of fs.readdirSync(OUT)) {
    if (f.startsWith('screenshot-')) fs.rmSync(path.join(OUT, f));
  }

  prepareExtension();
  const server = await startServer();
  const { proc } = await launchChrome();

  try {
    const browser = connect((await getJSON('/json/version')).webSocketDebuggerUrl);
    await browser.ready;
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

    const list = await getJSON('/json/list');
    const pageConn = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await pageConn.ready;
    await pageConn.send('Page.enable');
    const evalPage = async (expr) =>
      (await pageConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    await pageConn.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/demo-article.html` });
    await sleep(1500);

    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
    await sleep(1800);

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
      (await swConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    const started = await evalSW(`(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => (t.url || '').includes('127.0.0.1'));
      if (!tab) return 'no-tab';
      self.__st = { done: false, err: null };
      self.__selftest.runCapture(tab).then(
        () => { self.__st.done = true; },
        (e) => { self.__st.err = String((e && e.message) || e); }
      );
      return 'ok';
    })()`);
    if (started !== 'ok') throw new Error('触发失败');

    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await evalPage(`!!document.getElementById('__region_shot_overlay__')`);
      if (ready) break;
      await sleep(200);
    }
    if (!ready) throw new Error('遮罩未注入');

    const base = { button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };
    const x0 = 240, x1 = 1200, y0 = 120, y1 = 460;
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x0 + x1) / 2, y: (y0 + y1) / 2, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, ...base });
    await sleep(400);
    await shot(pageConn, 'selection.png');

    for (let i = 0; i < 22; i++) {
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 700, y: 300, deltaX: 0, deltaY: 100, pointerType: 'mouse',
      });
      await sleep(45);
    }
    await sleep(700);
    await shot(pageConn, 'scrolling.png');

    const btn = await evalPage(`(() => {
      const b = [...document.documentElement.children].find(e => e.textContent === '✓ 完成截图');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, ...base });

    let edTarget = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const l = await getJSON('/json/list');
      edTarget = l.find((t) => t.type === 'page' && (t.url || '').includes('/editor.html'));
      if (edTarget) break;
    }
    if (!edTarget) throw new Error('没有打开标注编辑器');

    const edConn = connect(edTarget.webSocketDebuggerUrl);
    await edConn.ready;
    await edConn.send('Page.enable');
    const evalEd = async (expr) =>
      (await edConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    for (let i = 0; i < 60; i++) {
      if (await evalEd(`document.body.dataset.ready === '1'`)) break;
      await sleep(200);
    }
    await sleep(400);

    const geo = await evalEd(`(() => {
      const r = document.getElementById('view').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, bmpW: bmp.width, bmpH: bmp.height };
    })()`);
    const z = geo.width / geo.bmpW;
    console.log('  原图', geo.bmpW, 'x', geo.bmpH, 'zoom', z.toFixed(3));

    // 先记录一张干净的编辑器图（空标注）
    await shot(edConn, 'editor-empty.png');

    // ---- 摆放演示标注 ----
    // 坐标是原图像素；内容位置对应 demo 页当前可见区域（原图 960 宽，zoom=1）
    const marks = [
      { type: 'rect', x1: 56, y1: 296, x2: 904, y2: 530, size: 6, color: '#ef4444' },
      { type: 'text', x: 56, y: 618, text: '等渲染稳定，再截下一屏', size: 34, color: '#ef4444' },
      { type: 'arrow', x1: 700, y1: 640, x2: 890, y2: 542, size: 5, color: '#ef4444' },
    ];
    await evalEd(`marks = ${JSON.stringify(marks)}; selected = null; render();`);
    await sleep(400);
    await shot(edConn, 'editor.png');

    // 缩小到能看见整张长图
    await evalEd(`setZoom(0.28)`);
    await sleep(500);
    await shot(edConn, 'editor-full.png');

    // 导出
    await evalEd(`marks = ${JSON.stringify(marks)}; setZoom(${z});`);
    await sleep(300);
    const saveAt = await evalEd(`(() => {
      const r = document.getElementById('save').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await edConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: saveAt.x, y: saveAt.y, ...base });
    await edConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: saveAt.x, y: saveAt.y, ...base });

    let file = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const files = fs.readdirSync(DL).filter((f) => f.endsWith('.png'));
      if (files.length) { file = path.join(DL, files[0]); break; }
    }
    if (file) {
      await sleep(600);
      fs.copyFileSync(file, path.join(RAW, 'exported.png'));
      console.log('  导出图已保存');
    }

    // ---- 合成 1280×800 商店截图 ----
    await pageConn.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const n of [1, 2, 3, 4, 5]) {
      await pageConn.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/store-assets/poster.html?slide=${n}` });
      await sleep(1200);
      const { data } = await pageConn.send('Page.captureScreenshot', {
        format: 'png', clip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 },
      });
      fs.writeFileSync(path.join(OUT, `screenshot-${n}.png`), Buffer.from(data, 'base64'));
      console.log(`  store-assets/screenshot-${n}.png`);
    }
  } finally {
    try { proc.kill(); } catch {}
    server.close();
    await sleep(500);
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
  }
  console.log('\n完成');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});

async function shot(conn, name) {
  const { data } = await conn.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(RAW, name), Buffer.from(data, 'base64'));
}
