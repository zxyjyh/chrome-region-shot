// 真实窗口（headful）视觉检查
//
// 和 e2e.js 的区别：e2e 在 headless 下断言像素，这里开一个真实 Chrome 窗口，
// 用接近真人使用的窗口尺寸走一遍，并把每步的界面截到 test/shots/manual/，
// 供人眼检查顶栏布局、文字渲染、选中框这类只有看得见才能判断的东西。
//
// 用法：node test/manual-check.js
//      node test/manual-check.js --keep    # 不删临时 profile / 下载目录
//
// 检查项：多行文字、矩形、拖动、撤销、选中文字改字号、保存
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readImage } = require('./png.js');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'area-screenshot-manual');
const EXT = path.join(TMP, 'ext');
const DL = path.join(TMP, 'dl');
const PROFILE = path.join(TMP, 'profile');
const SHOTS = path.join(__dirname, 'shots', 'manual');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9345);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8945);

const KEEP = process.argv.includes('--keep');

function loadWS() {
  try {
    return require('ws');
  } catch {
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

function prepareExtension() {
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.mkdirSync(EXT, { recursive: true });

  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  fs.writeFileSync(
    path.join(EXT, 'background.js'),
    bg + '\n\n// manual-check 专用导出（仅测试副本）\nself.__selftest = { runCapture };\n'
  );

  const iconsSrc = path.join(ROOT, 'icons');
  fs.mkdirSync(path.join(EXT, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(iconsSrc)) {
    if (f.endsWith('.png')) fs.copyFileSync(path.join(iconsSrc, f), path.join(EXT, 'icons', f));
  }

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

  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,980',
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
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  prepareExtension();
  const server = await startServer();
  const { proc } = await launchChrome();

  try {
    const browser = connect((await getJSON('/json/version')).webSocketDebuggerUrl);
    await browser.ready;
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

    const list = await getJSON('/json/list');
    const pageTarget = list.find((t) => t.type === 'page');
    const pageConn = connect(pageTarget.webSocketDebuggerUrl);
    await pageConn.ready;
    await pageConn.send('Page.enable');
    const evalPage = async (expr) =>
      (await pageConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    await pageConn.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/demo-article.html` });
    await sleep(1500);
    const viewport = await evalPage(`JSON.stringify({ w: innerWidth, h: innerHeight, docH: document.documentElement.scrollHeight })`);
    console.log('  页面视口:', viewport);

    // 给吸顶导航染一个只有测试会用的绿色：它一旦被拍进长图，导出图里就能查出来
    await evalPage(`document.querySelector('.nav').style.background = '#00ff00'`);

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

    // ---- 1. 框选 ----
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
      ready = await evalPage(`!!document.getElementById('__area_screenshot_overlay__')`);
      if (ready) break;
      await sleep(200);
    }
    if (!ready) throw new Error('遮罩未注入');

    const geom = await evalPage(`(() => {
      const r = document.getElementById('scroller') ? document.getElementById('scroller').getBoundingClientRect() : { top: 0, height: innerHeight };
      return { top: r.top, h: r.height, iw: innerWidth, ih: innerHeight };
    })()`);

    const base = { button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' };
    const x0 = 240, x1 = 1200;
    const y0 = Math.round(geom.top + 120);
    const y1 = Math.round(geom.top + 460);

    await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x0 + x1) / 2, y: (y0 + y1) / 2, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, ...base });
    await sleep(400);

    // 框选后的界面（商店截图素材之一）
    await shot(pageConn, 'step1-selection.png');

    // ---- 2. 滚动延伸 ----
    for (let i = 0; i < 30; i++) {
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 700, y: Math.round(geom.top + 300), deltaX: 0, deltaY: 100, pointerType: 'mouse',
      });
      await sleep(45);
    }
    await sleep(700);
    const scrolled = await evalPage(`window.scrollY`);
    console.log('  滚动后 scrollY:', scrolled);
    await shot(pageConn, 'step2-scrolling.png');

    // ---- 3. 完成 ----
    const btn = await evalPage(`(() => {
      const b = document.getElementById('__area_screenshot_confirm__');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!btn) throw new Error('找不到完成按钮');
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, ...base });
    await pageConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, ...base });

    // ---- 4. 编辑器 ----
    let edTarget = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const l = await getJSON('/json/list');
      edTarget = l.find((t) => t.type === 'page' && (t.url || '').includes('/editor.html'));
      if (edTarget) break;
    }
    if (!edTarget) throw new Error('没有打开标注编辑器：' + (await evalSW('JSON.stringify(self.__st || null)')));

    const edConn = connect(edTarget.webSocketDebuggerUrl);
    await edConn.ready;
    await edConn.send('Page.enable');
    await edConn.send('Runtime.enable');
    const evalEd = async (expr) =>
      (await edConn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

    let edReady = false;
    for (let i = 0; i < 60; i++) {
      edReady = await evalEd(`document.body.dataset.ready === '1'`);
      if (edReady) break;
      await sleep(200);
    }
    if (!edReady) throw new Error('编辑器未就绪：' + (await evalEd(`document.getElementById('hint').textContent`)));

    const imgSize = await evalEd(`JSON.stringify({ w: view.width, h: view.height, iw: bmp.width, ih: bmp.height, zoom })`);
    console.log('  编辑器:', imgSize);
    await shot(edConn, 'step3-editor-open.png');

    // 顶栏是否折行：所有控件在同一行的垂直中心
    const bar = await evalEd(`(() => {
      const els = [...document.querySelectorAll('#bar .group, #bar .actions, #bar .brand')];
      const rs = els.map(e => e.getBoundingClientRect());
      const tops = rs.map(r => Math.round(r.top));
      return JSON.stringify({ tops, maxBottom: Math.max(...rs.map(r => r.bottom)), barH: document.getElementById('bar').getBoundingClientRect().height });
    })()`);
    console.log('  顶栏布局:', bar);
    check('顶栏不折行（高度 ≤ 80px）', JSON.parse(bar).barH <= 80, `高度=${JSON.parse(bar).barH}px`);

    const wantW = await evalEd('bmp.width'); // 原图物理像素（Retina 下是逻辑宽的 2 倍）
    const geo = await evalEd(`(() => {
      const r = document.getElementById('view').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
    const z = geo.width / wantW; // 原图坐标 → 屏幕坐标
    console.log(`  原图宽 ${wantW}，显示宽 ${geo.width}，zoom=${z.toFixed(3)}`);

    const click = async (conn, x, y) => {
      await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, ...base });
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, ...base });
    };
    const drag = async (conn, x1, y1, x2, y2) => {
      await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, ...base });
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x1 + x2) / 2, y: (y1 + y2) / 2, ...base });
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x2, y: y2, ...base });
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, ...base });
    };
    const key = async (conn, params) => {
      await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    };

    // 选红色（浅色页面上最清楚）
    await evalEd(`document.querySelectorAll('.swatch')[0].click()`);

    // ---- 5. 多行文字 ----
    await click(edConn, geo.left + 110 * z, geo.top + 120 * z);
    await sleep(300);
    const inputShown = await evalEd(`document.getElementById('input').style.display !== 'none'`);
    check('点击画布出现输入框', inputShown);

    await edConn.send('Input.insertText', { text: '滚动截图不是一次拍照\n而是一次有状态的拼接' });
    await sleep(200);
    const inputVal = await evalEd(`document.getElementById('input').value`);
    check('输入框支持多行', inputVal.includes('\n'), JSON.stringify(inputVal));

    await key(edConn, { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(300);
    const markState = await evalEd(`JSON.stringify(marks.map(m => ({ type: m.type, lines: m.text ? m.text.split('\\n').length : 0 })))`);
    check('多行文字成为一个标注', JSON.parse(markState)[0]?.lines === 2, markState);
    await shot(edConn, 'step4-multiline-text.png');

    // ---- 6. 矩形 ----
    await evalEd(`document.querySelector('[data-tool="rect"]').click()`);
    await drag(edConn, geo.left + 380 * z, geo.top + 560 * z, geo.left + 880 * z, geo.top + 760 * z);
    await sleep(300);
    const rectState = await evalEd(`JSON.stringify(marks.map(m => m.type))`);
    check('矩形工具画出矩形', JSON.parse(rectState).includes('rect'), rectState);
    await shot(edConn, 'step5-rect.png');

    // ---- 7. 拖动文字 ----
    await evalEd(`document.querySelector('[data-tool="select"]').click()`);
    const before = await evalEd(`JSON.stringify({ x: marks[0].x, y: marks[0].y })`);
    const p0 = JSON.parse(before);
    await drag(
      edConn,
      geo.left + (p0.x + 10) * z, geo.top + (p0.y + 10) * z,
      geo.left + (p0.x + 70) * z, geo.top + (p0.y + 180) * z
    );
    await sleep(300);
    const after = await evalEd(`JSON.stringify({ x: marks[0].x, y: marks[0].y })`);
    const moved = JSON.parse(before).x !== JSON.parse(after).x;
    check('文字可以拖动', moved, `${before} → ${after}`);
    await shot(edConn, 'step6-moved.png');

    // ---- 8. 撤销 ----
    await key(edConn, { key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 });
    await sleep(300);
    const undone = await evalEd(`JSON.stringify({ x: marks[0].x, y: marks[0].y, n: marks.length })`);
    const restored = Math.abs(JSON.parse(undone).x - JSON.parse(before).x) < 2;
    check('⌘Z 撤销拖动', restored, undone);
    await shot(edConn, 'step7-undo.png');

    // ---- 9. 选中文字改字号（现状检查，不预设结论）----
    await click(edConn, geo.left + (JSON.parse(undone).x + 20) * z, geo.top + (JSON.parse(undone).y + 20) * z);
    await sleep(200);
    const selectedNow = await evalEd(`JSON.stringify(selected ? selected.type : null)`);
    const sizeBefore = await evalEd(`selected ? selected.size : null`);
    await evalEd(`(() => {
      const s = document.getElementById('size');
      s.value = '48';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(200);
    const sizeAfter = await evalEd(`selected ? selected.size : null`);
    check('选中文字后字号滑块生效', selectedNow === '"text"' && sizeAfter !== sizeBefore,
      `selected=${selectedNow} 字号 ${sizeBefore} → ${sizeAfter}`);
    await shot(edConn, 'step8-size.png');

    // ---- 10. 保存 ----
    await evalEd(`setZoom(0.12)`);
    await sleep(400);
    await shot(edConn, 'step9-zoom-out.png');

    const saveAt = await evalEd(`(() => {
      const r = document.getElementById('save').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await click(edConn, saveAt.x, saveAt.y);

    let file = null;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const files = fs.readdirSync(DL).filter((f) => f.endsWith('.png'));
      if (files.length) { file = path.join(DL, files[0]); break; }
    }
    if (!file) throw new Error('保存后没有产出文件');
    await sleep(600);

    const img = readImage(file);
    const exported = path.join(SHOTS, 'step10-exported.png');
    fs.copyFileSync(file, exported);
    check('导出尺寸 = 选区尺寸', img.w === wantW, `${img.w}x${img.h}（期望宽 ${wantW}）`);
    console.log(`  导出图像: ${img.w}x${img.h}`);

    // 文字与矩形区域里应出现红色像素（页面底色是浅灰/白）
    const redIn = (x0, y0, x1, y1) => {
      for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
          const [r, g, b] = img.pixel(x, y);
          if (r > 170 && g < 110 && b < 110) return true;
        }
      }
      return false;
    };
    check('导出图含文字标注', redIn(80, 100, 900, 320), '文字撤销后回到 (110,120) 起');
    check('导出图含矩形标注', redIn(360, 540, 900, 780), '');

    // 吸顶导航（被染成 #00ff00）不应出现在长图里
    let green = 0;
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const [r, g, b] = img.pixel(x, y);
        if (r < 40 && g > 220 && b < 40) green++;
      }
    }
    check('吸顶导航没有被拍进长图', green === 0, `绿色像素 ${green}`);

    // 多行文字是否真的占了两行：文字的垂直像素跨度 > 一行高度
    let minY = Infinity, maxY = -Infinity;
    for (let y = 80; y < 420; y++) {
      for (let x = 80; x < 360; x++) {
        const [r, g, b] = img.pixel(x, y);
        if (r > 170 && g < 110 && b < 110) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
    }
    check('多行文字垂直跨度足够', maxY - minY > 40, `y ${minY}..${maxY}（跨度 ${maxY - minY}px）`);

    // 编辑器页是否在保存后自行关闭
    await sleep(1500);
    const stillOpen = (await getJSON('/json/list')).some((t) => (t.url || '').includes('/editor.html'));
    check('保存后编辑器自动关闭', !stillOpen);

    // 关掉编辑器/页面连接
    try { edConn.ws.close(); } catch {}
  } finally {
    try { proc.kill(); } catch {}
    server.close();
    if (!KEEP) {
      await sleep(500);
      try {
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch {}
    }
  }

  const failed = report.filter((r) => !r.ok);
  console.log(`\n${report.length - failed.length}/${report.length} 通过，截图在 ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  try { console.error('截图目录：', SHOTS); } catch {}
  process.exit(1);
});

async function shot(conn, name) {
  const { data } = await conn.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
}
