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

  // 标注编辑器（截图完成后打开的那个扩展页面）
  for (const f of ['editor.html', 'editor.css', 'editor.js', 'i18n.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(EXT, f));
  }
  fs.cpSync(path.join(ROOT, '_locales'), path.join(EXT, '_locales'), { recursive: true });

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
  // 第二阶段滚动后选区下边界贴住视口底部，图片高度 = 结束滚动位置 + 视口高度 - 选区上边缘
  const topContentY = page === 'window-scroll.html' ? y0 : y0 - geom.top;
  const clientH = await evalPage(`(() => {
    if ('${page}' === 'inner-scroll.html') return document.getElementById('scroller').clientHeight;
    if ('${page}' === 'iframe-scroll.html') {
      const d = document.getElementById('scroller').contentDocument;
      return (d.scrollingElement || d.documentElement).clientHeight;
    }
    return document.scrollingElement.clientHeight;
  })()`);
  const base = { button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };

  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x0 + x1) / 2, y: (y0 + y1) / 2, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, ...base });
  await sleep(300);

  // 关键断言：松手后不能自动开始截图（此前的 bug 就是这里）
  const phase2 = await evalPage(`(() => {
    const overlay = document.getElementById('__region_shot_overlay__');
    const btn = document.getElementById('__region_shot_confirm__');
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
  // 滚到真正的底部：选区在接近底部时会平滑补齐尾差，到底时下边界 = 内容底部；
  // 如果停在离底部还有几十像素的位置，期望高度会按视口底算，但选区还差一点。
  await evalPage(`(window.__testScrollTo ? window.__testScrollTo(1e9) : window.scrollTo(0, 1e9))`);
  await sleep(400);
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

  // 回归：第二阶段拖动不能被当成「点任意位置确认」，否则页面拖不动、滚动条也拖不动
  const scrollTopBeforeProbes = await evalPage(
    `window.__testScrollTop ? window.__testScrollTop() : window.scrollY`
  );
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 200, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 200, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 200, ...base });
  await sleep(250);
  const stillOpenAfterDrag = await evalPage(`!!document.getElementById('__region_shot_overlay__')`);
  if (!stillOpenAfterDrag) throw new Error('拖动被误判成点击确认，截图提前结束');

  // 回归：点在右侧滚动条区域也不能确认（点击滚动条轨道会让浏览器自己滚一屏，这是预期行为）
  const vw = await evalPage(`window.innerWidth`);
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vw - 10, y: 200, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vw - 10, y: 200, ...base });
  await sleep(250);
  const stillOpenAfterScrollbar = await evalPage(`!!document.getElementById('__region_shot_overlay__')`);
  if (!stillOpenAfterScrollbar) throw new Error('点击滚动条区域被误判成确认');

  // 探针可能改变了滚动位置（滚动条点击会滚一屏），恢复后再继续
  await evalPage(
    `(window.__testScrollTo ? window.__testScrollTo(${scrollTopBeforeProbes}) : window.scrollTo(0, ${scrollTopBeforeProbes}))`
  );
  await sleep(500);

  // 第三步：点完成按钮
  const btn = await evalPage(`(() => {
    const b = document.getElementById('__region_shot_confirm__');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  // 回归：按钮跟着选区走，鼠标移到按钮上时按钮不能被推走（否则永远点不中）
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y, ...base });
  await sleep(120);
  const btnAfter = await evalPage(`(() => {
    const b = document.getElementById('__region_shot_confirm__');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (Math.abs(btnAfter.x - btn.x) > 2 || Math.abs(btnAfter.y - btn.y) > 2) {
    throw new Error(
      `鼠标移到按钮上后按钮移动了（${Math.round(btn.x)},${Math.round(btn.y)} → ` +
      `${Math.round(btnAfter.x)},${Math.round(btnAfter.y)}），用户会点不中`
    );
  }
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, ...base });

  // 第四步：标注编辑器 —— 截图完成后不再直接下载，而是打开编辑页
  let edTarget = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const l = await getJSON('/json/list');
    edTarget = l.find((t) => t.type === 'page' && (t.url || '').includes('/editor.html'));
    if (edTarget) break;
  }
  if (!edTarget) {
    const st = await evalSW('JSON.stringify(self.__st || null)');
    throw new Error('截图完成后没有打开标注编辑器，SW=' + st);
  }

  const edConn = connect(edTarget.webSocketDebuggerUrl);
  await edConn.ready;
  const evalEd = async (expr) =>
    (await edConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
      .result.value;

  let edReady = false;
  for (let i = 0; i < 50; i++) {
    edReady = await evalEd(`document.body.dataset.ready === '1'`);
    if (edReady) break;
    await sleep(200);
  }
  if (!edReady) {
    const msg = await evalEd(`document.getElementById('hint').textContent`).catch(() => '?');
    throw new Error('标注编辑器没有就绪：' + msg);
  }

  const wantW = 500 * dpr;
  const wantH = Math.round(afterScroll + clientH - topContentY) * dpr;
  const geo = await evalEd(`(() => {
    const r = document.getElementById('view').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
  if (!(geo.width > 100)) throw new Error('编辑器画布尺寸异常：' + JSON.stringify(geo));
  const zoom = geo.width / wantW; // 显示坐标 = 原图坐标 × zoom

  const edClick = async (x, y) => {
    await edConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, ...base });
    await edConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, ...base });
  };
  const edDrag = async (x1, y1, x2, y2) => {
    await edConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, ...base });
    await edConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x1 + x2) / 2, y: (y1 + y2) / 2, ...base });
    await edConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x2, y: y2, ...base });
    await edConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, ...base });
  };

  // 选白色（色板第 6 个），在红色背景上才检查得到
  await evalEd(`document.querySelectorAll('.swatch')[5].click()`);

  // 4.1 点击画布 → 出现输入框 → 真实键入文字 → 回车提交
  await edClick(geo.left + 40 * zoom, geo.top + 40 * zoom);
  await sleep(200);
  const inputShown = await evalEd(`document.getElementById('input').style.display !== 'none'`);
  if (!inputShown) throw new Error('在画布上点击后没有出现文字输入框');

  await edConn.send('Input.insertText', { text: 'MARK' });
  await edConn.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await edConn.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(200);
  const inputHidden = await evalEd(`document.getElementById('input').style.display === 'none'`);
  if (!inputHidden) throw new Error('回车后文字输入框没有收起');

  // 4.2 画一条白色箭头
  await evalEd(`document.querySelector('[data-tool="arrow"]').click()`);
  const toolOn = await evalEd(
    `document.querySelector('[data-tool="arrow"]').classList.contains('is-on')`
  );
  if (!toolOn) throw new Error('点击箭头工具后工具状态没有切换');
  // y 选 300：headless 视口只有 ~457px 高，拖到 420 会落到视口外，事件根本不派发
  await edDrag(geo.left + 60 * zoom, geo.top + 300 * zoom, geo.left + 300 * zoom, geo.top + 300 * zoom);
  await sleep(200);

  // 4.2.1 拖动文字再撤销：验证移动与历史栈
  const lightInView = async (x, y, w, h) => evalEd(`(() => {
    const v = document.getElementById('view');
    const r = v.width / ${wantW};
    const d = v.getContext('2d').getImageData(
      Math.round(${x} * r), Math.round(${y} * r), Math.round(${w} * r), Math.round(${h} * r)
    ).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++;
    return n;
  })()`);

  const lightBefore = await lightInView(30, 30, 220, 50);
  if (!lightBefore) throw new Error('文字没有画到编辑器的画布上');

  await edDrag(geo.left + 45 * zoom, geo.top + 45 * zoom, geo.left + 145 * zoom, geo.top + 145 * zoom);
  await sleep(200);
  const lightMoved = await lightInView(130, 130, 220, 50);
  if (!lightMoved) throw new Error('拖动后文字没有移动');

  for (const type of ['keyDown', 'keyUp']) {
    await edConn.send('Input.dispatchKeyEvent', {
      type, key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90,
    });
  }
  await sleep(200);
  const lightRestored = await lightInView(30, 30, 220, 50);
  if (lightRestored < lightBefore * 0.8) {
    throw new Error(`撤销后文字没有回到原位（${lightBefore} → ${lightRestored}）`);
  }

  // 诊断：箭头是否真的落在显示画布上（显示像素 = 原图坐标 × view.width/wantW）
  const arrowPixels = await evalEd(`(() => {
    const v = document.getElementById('view');
    const c = v.getContext('2d');
    const r = v.width / ${wantW};
    const d = c.getImageData(Math.round(30 * r), Math.round(270 * r), Math.round(320 * r), Math.round(60 * r)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++;
    return n;
  })()`);
  if (!arrowPixels) throw new Error('箭头没有画到编辑器的画布上');

  // 4.3 保存
  const saveAt = await evalEd(`(() => {
    const b = document.getElementById('save');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await edClick(saveAt.x, saveAt.y);

  // 等文件
  let file = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const files = fs.readdirSync(DL).filter((f) => f.endsWith('.png'));
    if (files.length) { file = path.join(DL, files[0]); break; }
  }
  if (!file) {
    const st = await evalSW('JSON.stringify(self.__st || null)');
    const list = await getJSON('/json/list');
    let edState = 'closed';
    if (edConn.ws.readyState === 1) {
      edState = await evalEd(
        `JSON.stringify({ hint: document.getElementById('hint').textContent, save: document.getElementById('save').textContent })`
      ).catch((e) => String(e));
    }
    throw new Error(
      '没有产出文件，SW=' + st + ' 编辑器=' + edState +
      ' targets=' + list.map((t) => t.type + ':' + t.url).join(' | ')
    );
  }
  await sleep(600);

  const img = readImage(file);
  const seq = img.rowSamples(Math.max(20, Math.floor(img.h / 10))).map((s) => nameToColor(s.rgb));
  const expect = ['RED', 'GREEN', 'BLUE', 'YELLOW'];
  let k = 0;
  for (const c of seq) if (c === expect[k]) k++;
  const seqOk = k === expect.length;

  // 标注是否真的画进导出图：红底 (255,0,0) 上找白色像素
  const hasLight = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(img.h, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(img.w, Math.ceil(x1)); x++) {
        const [r, g, b] = img.pixel(x, y);
        if (r > 200 && g > 200 && b > 200) return true;
      }
    }
    return false;
  };
  const textOk = hasLight(20, 20, 460, 180);
  const arrowOk = hasLight(40, 260, 330, 340);

  fs.unlinkSync(file);
  edConn.ws.close();
  swConn.ws.close();
  pageConn.ws.close();
  browser.ws.close();

  const sizeOk = Math.abs(img.w - wantW) <= 2 && Math.abs(img.h - wantH) <= 2;

  return {
    label,
    pass: seqOk && sizeOk && textOk && arrowOk,
    detail:
      `图像 ${img.w}x${img.h}（期望 ${wantW}x${wantH}）颜色 ${seq.join(',')} ` +
      `文字=${textOk ? 'OK' : '缺失'} 箭头=${arrowOk ? 'OK' : '缺失'}`,
  };
}

// 横向 + 纵向都超出一屏：验证二维拼接和选区的双向延伸
async function runHorizontalCase(page, dpr) {
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

  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await evalPage(`!!document.getElementById('__region_shot_overlay__')`);
    if (ready) break;
    await sleep(200);
  }
  if (!ready) throw new Error('遮罩未注入');

  const base = { button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };
  const x0 = 100, y0 = 100, x1 = 700, y1 = 500;
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x0 + x1) / 2, y: (y0 + y1) / 2, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, ...base });
  await sleep(300);

  // 真实滚动手势：先横向滚到最右，再纵向滚到底
  for (let i = 0; i < 20; i++) {
    await pageConn.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 400, y: 300, deltaX: 100, deltaY: 0, pointerType: 'mouse',
    });
    await sleep(40);
  }
  for (let i = 0; i < 20; i++) {
    await pageConn.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 100, pointerType: 'mouse',
    });
    await sleep(40);
  }
  await sleep(500);

  const sel = await evalPage(`(() => {
    const el = [...document.documentElement.children].find(e => e.style && e.style.borderColor === 'rgb(16, 185, 129)');
    const s = document.getElementById('scroller');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + s.scrollLeft),
      y: Math.round(r.top + s.scrollTop),
      w: Math.round(r.width),
      h: Math.round(r.height),
      sl: s.scrollLeft,
      st: s.scrollTop,
      sw: s.scrollWidth,
      sh: s.scrollHeight,
    };
  })()`);
  if (!sel) throw new Error('第二阶段选框不存在');
  if (sel.sl < 300) throw new Error('真实横向滚动没生效，scrollLeft=' + sel.sl);
  if (sel.st < 300) throw new Error('真实纵向滚动没生效，scrollTop=' + sel.st);
  if (sel.w <= 900) throw new Error('横向滚动后选区没有变宽，宽度=' + sel.w);
  if (sel.h <= 900) throw new Error('纵向滚动后选区没有变高，高度=' + sel.h);

  // 按钮现在跟随选区，位置不固定，必须读实际坐标
  const btn = await evalPage(`(() => {
    const b = document.getElementById('__region_shot_confirm__');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!btn) throw new Error('找不到完成按钮');
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, ...base });
  await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, ...base });

  let edTarget = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const l = await getJSON('/json/list');
    edTarget = l.find((t) => t.type === 'page' && (t.url || '').includes('/editor.html'));
    if (edTarget) break;
  }
  if (!edTarget) {
    const st = await evalSW('JSON.stringify(self.__st || null)');
    throw new Error('截图完成后没有打开标注编辑器，SW=' + st);
  }

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
  if (!edReady) {
    const msg = await evalEd(`document.getElementById('hint').textContent`).catch(() => '?');
    throw new Error('标注编辑器没有就绪：' + msg);
  }

  const bmp = await evalEd(`({ w: bmp.width, h: bmp.height })`);
  // 选区可能滚过了内容边界，实际能截到的部分以内容尺寸为准
  const expectW = Math.min(sel.w, sel.sw - sel.x) * dpr;
  const expectH = Math.min(sel.h, sel.sh - sel.y) * dpr;
  if (Math.abs(bmp.w - expectW) > 4) throw new Error(`原图宽度 ${bmp.w} ≠ 期望 ${expectW}`);
  if (Math.abs(bmp.h - expectH) > 4) throw new Error(`原图高度 ${bmp.h} ≠ 期望 ${expectH}`);

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
  if (!file) throw new Error('没有产出文件');

  const img = readImage(file);
  fs.unlinkSync(file);
  edConn.ws.close();
  swConn.ws.close();
  pageConn.ws.close();
  browser.ws.close();

  // 页面坐标 → 内容坐标（减去选区起点），采样 4×4 色块。
  // 点都落在两种窗口尺寸下都能覆盖的范围内（dpr=2 时窗口更大、可滚范围更小）
  const probes = [
    [250, 250, 'RED'],
    [750, 250, 'GREEN'],
    [250, 750, 'GREEN'],
    [750, 750, 'BLUE'],
    [250, 1250, 'BLUE'],
  ];
  const bad = [];
  for (const [px, py, want] of probes) {
    const cx = Math.round((px - sel.x) * dpr);
    const cy = Math.round((py - sel.y) * dpr);
    if (cx < 0 || cy < 0 || cx >= img.w || cy >= img.h) {
      bad.push(`(${px},${py}) 越界`);
      continue;
    }
    const got = nameToColor(img.pixel(cx, cy));
    if (got !== want) bad.push(`(${px},${py}) 期望 ${want} 实际 ${got}`);
  }

  const sizeOk = Math.abs(img.w - bmp.w) <= 2 && Math.abs(img.h - bmp.h) <= 2;
  return {
    label,
    pass: sizeOk && bad.length === 0,
    detail:
      `图像 ${img.w}x${img.h}（选区 ${sel.w}x${sel.h}）` +
      (bad.length ? ' 采样失败: ' + bad.join('; ') : ' 采样 OK'),
  };
}

(async () => {
  prepareExtension();
  const server = await startServer();
  let chromeProc = (await launchChrome()).proc;

  const results = [];
  try {
    for (const page of ['inner-scroll.html', 'window-scroll.html', 'iframe-scroll.html', 'horizontal-scroll.html']) {
      try {
        results.push(
          page === 'horizontal-scroll.html'
            ? await runHorizontalCase(page, DPR)
            : await runCase(page, DPR)
        );
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
