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
//   - 选区跟着滚动延伸，下边界贴住视口底部（覆盖整个可视区域）
//   - 完成按钮跟着选区走
//   - 在页面上拖动（位移 > 6px）不会确认截图
//   - 拖动之后还能继续滚动
//   - 滚到页面底部后选区延伸到内容底部
//   - 离开边界再滚回，选区按滚动量 1:1 收缩 / 恢复
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
      const btn = document.getElementById('__region_shot_confirm__');
      const r = box ? box.getBoundingClientRect() : null;
      const b = btn ? btn.getBoundingClientRect() : null;
      const se = document.scrollingElement || document.documentElement;
      return {
        overlay: !!document.getElementById('__region_shot_overlay__'),
        y: Math.round(window.scrollY),
        boxW: r ? Math.round(r.width) : 0,
        boxH: r ? Math.round(r.height) : 0,
        boxBottom: r ? Math.round(r.bottom) : 0,
        boxBottomContent: r ? Math.round(r.bottom + window.scrollY) : 0,
        clientH: se.clientHeight,
        contentH: se.scrollHeight,
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
    // 滚动时选区下边界应该贴住视口底部（内容坐标 = scrollY + 视口高度），
    // 而不是钉在拖动结束时的屏幕位置——否则选区下方永远有一条未被选中的内容带
    check(
      '选区下边界贴住视口底部',
      Math.abs(s1.boxBottom - s1.clientH) <= 1 &&
        Math.abs(s1.boxBottomContent - (s1.y + s1.clientH)) <= 1,
      `屏幕底 ${s1.boxBottom} vs 视口高 ${s1.clientH}；内容底 ${s1.boxBottomContent} vs ${s1.y}+${s1.clientH}`
    );
    check('只纵向滚动时宽度保持拖动尺寸', s1.boxW === s0.boxW, `宽 ${s0.boxW} → ${s1.boxW}`);
    // 按钮贴在选区右下角，选区右下角现在贴视口底，所以按钮应钳在视口右下区域内
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
    // 5 次 × 100 ≈ 480px，停在页面底部之前，把「滚到最底」留给 3.5
    for (let i = 0; i < 5; i++) {
      await pageConn.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 100, pointerType: 'mouse',
      });
      await sleep(40);
    }
    await sleep(500);
    const s3 = await state();
    check('拖动之后还能继续滚动', s3.y - s2.y > 300, `scrollY ${s2.y} → ${s3.y}`);
    check('选区继续延伸', s3.boxH >= s2.boxH, `高度 ${s2.boxH} → ${s3.boxH}`);

    // ---- 3.5 滚到页面最底部：选区必须延伸到内容底部 ----
    // 回归：下边界只跟滚动增量的话，到底后底边会停在视口中间，页面最后一段截不到。
    // 现在下边界贴视口底，滚到最底 = 视口底 = 内容底。
    await evalPage(`window.scrollTo(0, document.scrollingElement.scrollHeight)`);
    await sleep(400);
    const sBottom = await state();
    check(
      '滚到页面底部后选区延伸到内容底部',
      sBottom.y + sBottom.clientH >= sBottom.contentH - 2 &&
        Math.abs(sBottom.boxBottomContent - sBottom.contentH) <= 2,
      JSON.stringify(sBottom)
    );

    // ---- 3.6 离开边界再滚回：按滚动量 1:1 收缩 / 恢复 ----
    await evalPage(`window.scrollTo(0, Math.max(0, window.scrollY - 400))`);
    await sleep(300);
    const sUp = await state();
    check(
      '离开边界后选区按滚动量 1:1 收缩',
      Math.abs(sBottom.boxH - sUp.boxH - (sBottom.y - sUp.y)) <= 4,
      `高度 ${sBottom.boxH} → ${sUp.boxH}，滚动 ${sBottom.y} → ${sUp.y}`
    );
    await evalPage(`window.scrollTo(0, document.scrollingElement.scrollHeight)`);
    await sleep(300);
    const sEnd = await state();
    check(
      '滚回底部时选区按滚动量 1:1 恢复',
      Math.abs(sEnd.boxH - sUp.boxH - (sEnd.y - sUp.y)) <= 4,
      `高度 ${sUp.boxH} → ${sEnd.boxH}，滚动 ${sUp.y} → ${sEnd.y}`
    );
    check(
      '回到内容底部（选区完整）',
      Math.abs(sEnd.boxH - sBottom.boxH) <= 2,
      `高度 ${sEnd.boxH} vs ${sBottom.boxH}`
    );

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
      // 期望：截图高度按选区高 × dpr（dpr 由图像宽 / 选区宽算出），
      // 证明拼出来的图真的包含滚到底的那一段，而不只是选区框画到了底
      const dpr = bmp ? bmp.w / sBottom.boxW : 0;
      const wantImgH = sBottom.boxH * dpr;
      check(
        '编辑器就绪且拿到了原图',
        !!edReady && !!bmp && bmp.w > 300,
        JSON.stringify(bmp)
      );
      check(
        '原图高度覆盖到页面底部（拼图完整）',
        !!bmp && Math.abs(bmp.h - wantImgH) <= 4,
        `图像 ${bmp && bmp.w}x${bmp && bmp.h}，期望高 ${Math.round(wantImgH)}（选区 ${sBottom.boxW}x${sBottom.boxH} dpr ${dpr}）`
      );
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
