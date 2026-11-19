// 第二阶段交互检查（真实窗口 headful）
//
// 专门验证「框选之后」这一段的操作手感，对应之前用户反馈的两类回归：
//   1. 滚动没反应 / 选区不跟着延伸
//   2. 页面拖不动（拖动被误判成「点任意位置确认」）
//
// 用法：node test/second-phase-check.js
//      node test/second-phase-check.js --keep
//
// 检查项：
//   - 滚轮能滚动页面
//   - 选区跟着滚动延伸
//   - 完成按钮跟着选区走
//   - 在页面上拖动（位移 > 6px）不会确认截图
//   - 拖动之后还能继续滚动
//   - 原地点击能确认，并打开标注编辑器
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'region-shot-phase2');
const EXT = path.join(TMP, 'ext');
const DL = path.join(TMP, 'dl');
const PROFILE = path.join(TMP, 'profile');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9365);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8965);

const KEEP = process.argv.includes('--keep');

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
    const file = path.join(__dirname, 'pages', name);
    if (!name || !fs.existsSync(file)) {
      res.writeHead(404); res.end('no page'); return;
    }
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

const report = [];
const check = (name, ok, detail = '') => {
  report.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

(async () => {
  prepareExtension();
  const server = await startServer();
  const { proc } = await launchChrome();

  try {
    const browser = connect((await getJSON('/json/version')).webSocketDebuggerUrl);
    await browser.ready;

    const list = await getJSON('/json/list');
    const pageTarget = list.find((t) => t.type === 'page');
    const pageConn = connect(pageTarget.webSocketDebuggerUrl);
    await pageConn.ready;
    await pageConn.send('Page.enable');

    const evalPage = async (expr) =>
      (await pageConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
        .result.value;

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
      (await swConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
        .result.value;

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
    if (started !== 'ok') throw new Error('触发失败: ' + started);

    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await evalPage(`!!document.getElementById('__region_shot_overlay__')`);
      if (ready) break;
      await sleep(200);
    }
    if (!ready) throw new Error('遮罩未注入');

    const base = { button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };
    const state = () => evalPage(`(() => {
      const els = [...document.documentElement.children];
      const box = els.find(e => e.style && e.style.borderColor === 'rgb(16, 185, 129)');
      const btn = els.find(e => e.textContent === '✓ 完成截图');
      const r = box ? box.getBoundingClientRect() : null;
      const b = btn ? btn.getBoundingClientRect() : null;
      return {
        overlay: !!document.getElementById('__region_shot_overlay__'),
        y: Math.round(window.scrollY),
        boxH: r ? Math.round(r.height) : 0,
        boxBottom: r ? Math.round(r.bottom) : 0,
        btnX: b ? Math.round(b.left) : -1,
        btnY: b ? Math.round(b.top) : -1,
      };
    })()`);

    // ---- 框选 ----
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 140, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 440, y: 280, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 420, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 760, y: 420, ...base });
    await sleep(350);

    const s0 = await state();
    check('松手后进入第二阶段', s0.overlay && s0.boxH >= 250 && s0.btnX > 0, JSON.stringify(s0));

    // ---- 1. 滚轮滚动 ----
    for (let i = 0; i < 12; i++) {
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 100, pointerType: 'mouse',
      });
      await sleep(40);
    }
    await sleep(500);
    const s1 = await state();
    check('滚轮能滚动页面', s1.y - s0.y > 500, `scrollY ${s0.y} → ${s1.y}`);
    check('选区跟着滚动延伸', s1.boxH > s0.boxH + 500, `高度 ${s0.boxH} → ${s1.boxH}`);
    // 注意：选区底部在屏幕上的位置本来就不变（底边跟着滚动锚定），
    // 所以这里断言的是「按钮一直贴着选区右下角」，不是「按钮位置变了」
    const btnGapOk = (s) => Math.abs(s.btnY - s.boxBottom) <= 60;
    check(
      '完成按钮始终贴着选区右下角',
      btnGapOk(s0) && btnGapOk(s1),
      `选区底 ${s0.boxBottom}/${s1.boxBottom}，按钮 ${s0.btnY}/${s1.btnY}`
    );

    // ---- 2. 在页面上拖动（模拟拖选/拖页面）----
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 300, ...base });
    for (let i = 1; i <= 10; i++) {
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: 500 - i * 15, y: 300 + i * 12, ...base,
      });
      await sleep(20);
    }
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 350, y: 420, ...base });
    await sleep(400);
    const s2 = await state();
    check('拖动页面没有被误判成确认', s2.overlay && s2.btnX > 0, `overlay=${s2.overlay}`);

    // ---- 3. 拖动之后还能继续滚 ----
    for (let i = 0; i < 8; i++) {
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 100, pointerType: 'mouse',
      });
      await sleep(40);
    }
    await sleep(500);
    const s3 = await state();
    check('拖动之后还能继续滚动', s3.y - s2.y > 300, `scrollY ${s2.y} → ${s3.y}`);
    check('选区继续延伸', s3.boxH >= s2.boxH, `高度 ${s2.boxH} → ${s3.boxH}`);

    // ---- 4. 原地点击确认 ----
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 320, y: 620, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 320, y: 620, ...base });

    let edTarget = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const l = await getJSON('/json/list');
      edTarget = l.find((t) => t.type === 'page' && (t.url || '').includes('/editor.html'));
      if (edTarget) break;
    }
    check('原地点击能确认并打开编辑器', !!edTarget);

    if (edTarget) {
      const edConn = connect(edTarget.webSocketDebuggerUrl);
      await edConn.ready;
      const evalEd = async (expr) =>
        (await edConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
          .result.value;
      let edReady = false;
      for (let i = 0; i < 60; i++) {
        edReady = await evalEd(`document.body.dataset.ready === '1'`);
        if (edReady) break;
        await sleep(200);
      }
      const bmp = edReady ? await evalEd(`({ w: bmp.width, h: bmp.height })`) : null;
      check('编辑器就绪且拿到了原图', !!edReady && !!bmp && bmp.w > 300, JSON.stringify(bmp));
      // 关掉编辑器，避免残留
      await evalEd(`document.getElementById('cancel').click()`).catch(() => {});
      edConn.ws.close();
    }

    swConn.ws.close();
    pageConn.ws.close();
    browser.ws.close();
  } finally {
    try { proc.kill(); } catch {}
    server.close();
    await sleep(600);
    if (!KEEP) {
      try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
    }
  }

  const failed = report.filter((r) => !r.ok);
  console.log(`\n${report.length - failed.length}/${report.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
