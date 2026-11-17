// 把 icons/*.svg 渲染成扩展需要的 PNG 尺寸
//
// 用法：node scripts/build-icons.js
// 依赖：Chrome、Node 18+、ws 模块（与 test/e2e.js 相同）
//
// 为什么小尺寸单独一套 SVG：
//   128px 的角标框缩到 16px 时线宽只剩 1px，会和背景糊成一团。
//   所以 16/32 用元素更少、线更粗的专用图形（icons/icon-16.svg、icon-32.svg）。

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const ICONS = path.join(ROOT, 'icons');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CDP_PORT || 9343);
const TMP = path.join(os.tmpdir(), 'region-shot-icons');

// 哪个 SVG 出哪个尺寸
const JOBS = [
  { svg: 'icon-full.svg', size: 128, out: 'icon128.png' },
  { svg: 'icon-full.svg', size: 48, out: 'icon48.png' },
  { svg: 'icon-32.svg', size: 32, out: 'icon32.png' },
  { svg: 'icon-16.svg', size: 16, out: 'icon16.png' },
];

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

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

const getJSON = (p) =>
  new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
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

(async () => {
  // 端口被上一次崩溃残留的 Chrome 占着时，新实例会静默退出，然后连到旧实例上失败
  if (!(await portFree(PORT))) {
    throw new Error(`调试端口 ${PORT} 被占用，先执行：pkill -f "region-shot-icons/profile" 或设置 CDP_PORT=其他端口`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 一个页面按尺寸排好所有图标，逐个截图
  const cells = JOBS.map((j, i) => {
    const svg = fs.readFileSync(path.join(ICONS, j.svg), 'utf8')
      .replace(/width="\d+"/, `width="${j.size}"`)
      .replace(/height="\d+"/, `height="${j.size}"`);
    return `<div id="c${i}" style="width:${j.size}px;height:${j.size}px;display:inline-block;vertical-align:top;margin:8px">${svg}</div>`;
  }).join('\n');

  const html = `<!doctype html><html><head><meta charset="utf-8">
  <style>html,body{margin:0;padding:0;background:transparent}</style></head>
  <body style="padding:20px">${cells}</body></html>`;
  const htmlPath = path.join(TMP, 'icons.html');
  fs.writeFileSync(htmlPath, html);

  fs.rmSync(path.join(TMP, 'profile'), { recursive: true, force: true });
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(TMP, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=600,600',
    'about:blank',
  ], { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { await getJSON('/json/version'); up = true; break; } catch { await sleep(250); }
  }
  if (!up) throw new Error('Chrome 启动失败');

  const list = await getJSON('/json/list');
  const c = connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  // 双保险：页面底色也显式清成透明
  await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

  try {
    await c.send('Page.navigate', { url: 'file://' + htmlPath });
    await sleep(800);

    for (let i = 0; i < JOBS.length; i++) {
      const j = JOBS[i];
      const rect = await c.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => { const r = document.getElementById('c${i}').getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`,
      });
      const box = JSON.parse(rect.result.value);
      if (Math.round(box.w) !== j.size || Math.round(box.h) !== j.size) {
        throw new Error(`${j.out} 渲染尺寸不对：${box.w}x${box.h}，期望 ${j.size}x${j.size}`);
      }
      const shot = await c.send('Page.captureScreenshot', {
        format: 'png',
        omitBackground: true,
        clip: { x: box.x, y: box.y, width: j.size, height: j.size, scale: 1 },
      });
      const out = path.join(ICONS, j.out);
      const buf = Buffer.from(shot.data, 'base64');
      // 断言：必须是 RGBA，否则圆角外侧会变成不透明的白色方块
      if (buf.readUInt32BE(16) !== j.size || buf.readUInt32BE(20) !== j.size) {
        throw new Error(`${j.out} 输出尺寸不是 ${j.size}x${j.size}`);
      }
      if (buf[25] !== 6) {
        throw new Error(`${j.out} 没有 alpha 通道（colorType=${buf[25]}），omitBackground 未生效`);
      }
      fs.writeFileSync(out, buf);
      const s = fs.statSync(out);
      console.log(`${j.out.padEnd(12)} ${j.size}x${j.size} RGBA  ${(s.size / 1024).toFixed(1)}KB  ← ${j.svg}`);
    }
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    // 必须等端口真正释放再删 profile，否则进程还活着但目录没了，下次会连到幽灵实例
    for (let i = 0; i < 50 && !(await portFree(PORT)); i++) await sleep(100);
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }

  console.log('\n图标已生成到 icons/');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
