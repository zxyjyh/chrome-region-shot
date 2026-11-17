// 端到端自测：把扩展真实加载进 Chrome，用真实输入事件走完整流程，检查下载出的 PNG 内容
//
// 用法：node test/e2e.js
//      node test/e2e.js --dpr 2        # 模拟 Retina
//      node test/e2e.js --keep         # 保留临时文件便于排查
//
// 依赖：Chrome（默认 /Applications/Google Chrome.app）、Node 18+、ws 模块
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readImage, nameToColor } = require('./png.js');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'region-shot-e2e');
const EXT = path.join(TMP, 'ext');
const DL = path.join(TMP, 'dl');
const PROFILE = path.join(TMP, 'profile');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9335);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8935);

const args = process.argv.slice(2);
const DPR = Number((args.includes('--dpr') ? args[args.indexOf('--dpr') + 1] : '1')) || 1;
const KEEP = args.includes('--keep');

function loadWS() {
  try {
    return require('ws');
  } catch {
    // 全局安装的 ws（nvm 场景常见）
    const { execSync } = require('child_process');
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(root, 'ws'));
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

// 生成测试副本：产品代码 + 导出入口 + 测试用权限
function prepareExtension() {
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(EXT, { recursive: true });

  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  fs.writeFileSync(
    path.join(EXT, 'background.js'),
    bg + '\n\n// e2e 测试专用导出（仅存在于测试副本）\nself.__selftest = { runCapture, captureByScroll, readGeo };\n'
  );

  // manifest 的 icons 指向 icons/*.png，测试副本也必须带上，否则 Chrome 拒绝加载
  const iconsSrc = path.join(ROOT, 'icons');
  if (fs.existsSync(iconsSrc)) {
    const iconsDst = path.join(EXT, 'icons');
    fs.mkdirSync(iconsDst, { recursive: true });
    for (const f of fs.readdirSync(iconsSrc)) {
      if (f.endsWith('.png')) fs.copyFileSync(path.join(iconsSrc, f), path.join(iconsDst, f));
    }
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

  const size = DPR === 1 ? ['--window-size=800,600'] : [`--force-device-scale-factor=${DPR}`, '--window-size=1600,1200'];
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    ...size,
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await getJSON('/json/version'); break; } catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome 启动失败');
  return { proc, version };
}

async function runCase(page, dpr) {
  const label = `page=${page} dpr=${dpr}`;
  const browser = connect((await getJSON('/json/version')).webSocketDebuggerUrl);
  await browser.ready;
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  const list = await getJSON('/json/list');
  const pageTarget = list.find((t) => t.type === 'page');
  const pageConn = connect(pageTarget.webSocketDebuggerUrl);
  await pageConn.ready;
  await pageConn.send('Page.enable');
  await pageConn.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/${page}` });
  await sleep(1200);

  const evalPage = async (expr) =>
    (await pageConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

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
  if (started !== 'ok') throw new Error('触发失败: ' + started);

  // 图标点击入口是否已注册（用户点工具栏图标走的就是这条）
  const hasActionListener = await evalSW('chrome.action.onClicked.hasListeners()');
  if (!hasActionListener) throw new Error('chrome.action.onClicked 没有监听器 → 点图标不会触发');

  // 等遮罩注入
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await evalPage(`!!document.getElementById('__region_shot_overlay__')`);
    if (ready) break;
    await sleep(200);
  }
  if (!ready) throw new Error('遮罩未注入');

  // 第一步：真实拖拽
  const geom = await evalPage(`(() => {
    const r = document.getElementById('scroller').getBoundingClientRect();
    return { top: r.top, h: r.height };
  })()`);
  const y0 = Math.round(geom.top + 40);
  const y1 = Math.round(geom.top + Math.min(340, geom.h - 20));
  const x0 = 100, x1 = 600;
  const base = { button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };

  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x0 + x1) / 2, y: (y0 + y1) / 2, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, ...base });
  await sleep(300);

  // 关键断言：松手后不能自动开始截图（此前的 bug 就是这里）
  const phase2 = await evalPage(`(() => {
    const overlay = document.getElementById('__region_shot_overlay__');
    const btn = [...document.documentElement.children].find(e => e.textContent === '✓ 完成截图');
    return { overlay: !!overlay, btn: btn ? btn.getBoundingClientRect().toJSON() : null };
  })()`);
  if (!phase2.overlay || !phase2.btn) {
    throw new Error('松手后遮罩消失/按钮不存在 → 发生了自动确认');
  }

  // 第二步：用真实的滚动手势（wheel，等价于 Mac 触摸板两指滑动）
  const wheelX = Math.round(geom.top ? 400 : 400);
  const wheelY = Math.round(geom.top + Math.min(200, geom.h / 2));
  const beforeScroll = await evalPage(`window.__testScrollTop ? window.__testScrollTop() : 0`);
  for (let i = 0; i < 30; i++) {
    await pageConn.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: wheelX, y: wheelY, deltaX: 0, deltaY: 100, pointerType: 'mouse',
    });
    await sleep(40);
  }
  await sleep(500);
  const afterScroll = await evalPage(`window.__testScrollTop ? window.__testScrollTop() : 0`);
  console.log(`    滚动手势: ${beforeScroll} → ${afterScroll}`);
  if (afterScroll - beforeScroll < 500) {
    throw new Error(`真实滚动手势无效（${beforeScroll} → ${afterScroll}），页面滚不动`);
  }

  const boxH = await evalPage(`(() => {
    const el = [...document.documentElement.children].find(e => e.style && e.style.borderColor === 'rgb(16, 185, 129)');
    return el ? el.getBoundingClientRect().height : null;
  })()`);
  if (!boxH || boxH < 1000) throw new Error('滚动后选框没有延伸，高度=' + boxH);

  // 第三步：点完成按钮
  const btn = await evalPage(`(() => {
    const b = [...document.documentElement.children].find(e => e.textContent === '✓ 完成截图');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, ...base });

  // 等文件
  let file = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const files = fs.readdirSync(DL).filter((f) => f.endsWith('.png'));
    if (files.length) { file = path.join(DL, files[0]); break; }
  }
  if (!file) {
    const st = await evalSW('JSON.stringify(self.__st || null)');
    throw new Error('没有产出文件，SW=' + st);
  }
  await sleep(600);

  const img = readImage(file);
  const seq = img.rowSamples(Math.max(20, Math.floor(img.h / 10))).map((s) => nameToColor(s.rgb));
  const expect = ['RED', 'GREEN', 'BLUE', 'YELLOW'];
  let k = 0;
  for (const c of seq) if (c === expect[k]) k++;
  const seqOk = k === expect.length;

  fs.unlinkSync(file);
  swConn.ws.close();
  pageConn.ws.close();
  browser.ws.close();

  const wantW = 500 * dpr;
  const wantH = 3300 * dpr;
  const sizeOk = Math.abs(img.w - wantW) <= 2 && Math.abs(img.h - wantH) <= 2;

  return {
    label,
    pass: seqOk && sizeOk,
    detail: `图像 ${img.w}x${img.h}（期望 ${wantW}x${wantH}）颜色 ${seq.join(',')}`,
  };
}

(async () => {
  prepareExtension();
  const server = await startServer();
  let chromeProc = (await launchChrome()).proc;

  const results = [];
  try {
    for (const page of ['inner-scroll.html', 'window-scroll.html', 'iframe-scroll.html']) {
      try {
        results.push(await runCase(page, DPR));
      } catch (e) {
        results.push({ label: `page=${page} dpr=${DPR}`, pass: false, detail: e.message });
      }
      // 每个用例之间重启浏览器，避免扩展/下载状态串味
      chromeProc.kill();
      await sleep(800);
      chromeProc = (await launchChrome()).proc;
    }
  } finally {
    try { chromeProc.kill(); } catch {}
    server.close();
  }

  console.log('\n========== 结果 ==========');
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}  ${r.detail}`);
    if (!r.pass) allPass = false;
  }
  if (!KEEP) {
    await sleep(500);
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch {
      /* Chrome 可能还在写 profile，忽略 */
    }
  }
  console.log(allPass ? '\n全部通过' : '\n存在失败');
  process.exit(allPass ? 0 : 1);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
