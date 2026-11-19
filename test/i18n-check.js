// 多语言检查（真实窗口 headful）
//
// 验证三种语言的自动检测与手动切换：
//   - --lang=zh-CN：编辑页默认简体；切繁体 / 英文立即生效；重新打开编辑页沿用偏好；切回「自动」恢复简体
//   - --lang=en-US：编辑页默认英文；manifest 名称走英文
//   - --lang=zh-TW：编辑页默认繁体；manifest 名称走繁体
//
// 用法：node test/i18n-check.js
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'region-shot-i18n');
const EXT = path.join(TMP, 'ext');
const PROFILE = path.join(TMP, 'profile');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_PORT = Number(process.env.CDP_PORT || 9367);

const SRC_W = 400;
const SRC_H = 260;
const SRC_RGB = [30, 144, 255];

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

const getJSON = (p, port) =>
  new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (r) => {
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

const report = [];
const check = (name, ok, detail = '') => {
  report.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

async function launchChrome(lang, port) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  // macOS 上 --lang 不影响 chrome.i18n 的 UI 语言，必须预写 profile 偏好
  fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(PROFILE, 'Default', 'Preferences'),
    JSON.stringify({
      intl: {
        app_locale: lang,
        accept_languages: `${lang},${lang.split('-')[0]}`,
      },
    })
  );
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    `--lang=${lang}`,
    // macOS 上 Chrome 不认 --lang，但会读 Cocoa 的 AppleLanguages 默认值
    '-AppleLanguages',
    `(${lang})`,
    '--window-size=1280,860',
    '--window-position=40,40',
    'about:blank',
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 80; i++) {
    try { version = await getJSON('/json/version', port); break; } catch { await sleep(250); }
  }
  if (!version) throw new Error(`Chrome 启动失败（--lang=${lang}）`);
  return proc;
}

// 打开一个编辑器页：造图 → 写 IndexedDB → chrome.tabs.create
async function openEditor(env) {
  const { browser, evalSW, port } = env;
  const before = new Set((await getJSON('/json/list', port)).map((t) => t.id));

  const created = await evalSW(`(async () => {
    const c = new OffscreenCanvas(${SRC_W}, ${SRC_H});
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgb(${SRC_RGB.join(',')})';
    ctx.fillRect(0, 0, ${SRC_W}, ${SRC_H});
    const blob = await c.convertToBlob({ type: 'image/png' });

    const id = crypto.randomUUID();
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('region-shot', 1);
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

    const url = chrome.runtime.getURL('editor.html') + '?id=' + encodeURIComponent(id) + '&name=i18n-test.png';
    await chrome.tabs.create({ url, active: true });
    return 'ok';
  })()`);
  if (created !== 'ok') throw new Error('构造截图失败: ' + created);

  let target = null;
  for (let i = 0; i < 60; i++) {
    const list = await getJSON('/json/list', port);
    target = list.find((t) => t.type === 'page' && (t.url || '').includes('/editor.html') && !before.has(t.id));
    if (target) break;
    await sleep(250);
  }
  if (!target) throw new Error('编辑器标签页未打开');

  const conn = connect(target.webSocketDebuggerUrl);
  await conn.ready;
  await conn.send('Page.enable');
  await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const evalEd = async (expr) =>
    (await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))
      .result.value;

  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await evalEd(`document.body.dataset.ready === '1'`);
    if (ready) break;
    await sleep(200);
  }
  if (!ready) throw new Error('编辑器未就绪');

  return {
    evalEd,
    close() {
      conn.ws.close();
      return browser.send('Target.closeTarget', { targetId: target.id }).catch(() => {});
    },
  };
}

const editorState = (evalEd) => evalEd(`(() => ({
  htmlLang: document.documentElement.lang,
  select: document.getElementById('lang').value,
  save: document.getElementById('save').textContent.trim(),
  copy: document.getElementById('copy').textContent.trim(),
  cancel: document.getElementById('cancel').textContent.trim(),
  toolText: document.querySelector('[data-tool="text"] span').textContent.trim(),
  hint: document.getElementById('hint').textContent.trim(),
  title: document.title,
}))()`);

const switchLang = (evalEd, mode) => evalEd(`(() => {
  const s = document.getElementById('lang');
  s.value = ${JSON.stringify(mode)};
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return s.value;
})()`);

async function withChrome(lang, port, fn) {
  const proc = await launchChrome(lang, port);
  let browser = null;
  try {
    browser = connect((await getJSON('/json/version', port)).webSocketDebuggerUrl);
    await browser.ready;

    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
    await sleep(1500);

    let sw = null;
    for (let i = 0; i < 40; i++) {
      const l = await getJSON('/json/list', port);
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

    await fn({ browser, evalSW, port });
    swConn.ws.close();
  } finally {
    if (browser) browser.ws.close();
    try { proc.kill(); } catch {}
    await sleep(500);
  }
}

(async () => {
  prepareExtension();
  let port = BASE_PORT;

  // ---- 第 1 轮：zh-CN，测自动检测 + 手动切换 + 偏好持久化 ----
  await withChrome('zh-CN', port++, async (env) => {
    const uiLang = await env.evalSW(`chrome.i18n.getUILanguage()`);
    check('浏览器 UI 语言是 zh-CN', uiLang === 'zh-CN', uiLang);
    const extName = await env.evalSW(`chrome.i18n.getMessage('extName')`);
    check('manifest 名称走简体', extName === 'Region Shot · 区域截图', extName);

    const ed = await openEditor(env);
    const s0 = await editorState(ed.evalEd);
    check('自动：编辑页默认简体', s0.htmlLang === 'zh-CN' && s0.select === 'auto' && s0.save === '✓ 保存 PNG', JSON.stringify(s0));
    check('自动：静态文案是简体', s0.cancel === '取消' && s0.copy === '复制图片' && s0.toolText === '文字' && s0.title === 'Region Shot · 标注');

    await switchLang(ed.evalEd, 'zh_TW');
    const s1 = await editorState(ed.evalEd);
    check('手动切繁体立即生效', s1.htmlLang === 'zh-TW' && s1.save === '✓ 儲存 PNG' && s1.copy === '複製圖片', JSON.stringify(s1));
    check('繁体：提示与标题同步', s1.hint.includes('點擊圖片') && s1.title === 'Region Shot · 標註', s1.hint);

    await switchLang(ed.evalEd, 'en');
    const s2 = await editorState(ed.evalEd);
    check('手动切英文立即生效', s2.htmlLang === 'en' && s2.save === '✓ Save PNG' && s2.copy === 'Copy image' && s2.cancel === 'Cancel', JSON.stringify(s2));
    check('英文：提示与标题同步', s2.hint.includes('Click anywhere') && s2.title === 'Region Shot · Annotate', s2.hint);

    // 框选阶段沿用编辑页的偏好：偏好写入 chrome.storage，background 能解析并读到对应语言包
    const stored = await env.evalSW(`chrome.storage.local.get('regionShotLang')`);
    check('语言偏好同步到 chrome.storage', stored.regionShotLang === 'en', JSON.stringify(stored));
    const resolved = await env.evalSW(`(async () => resolveOverlayLang(await getLangPref()))()`);
    check('框选阶段解析到同一语言', resolved === 'en', resolved);
    const msgs = await env.evalSW(`overlayMessages('en')`);
    check('框选遮罩文案包可读取（英文）', !!msgs && msgs.done === '✓ Done', JSON.stringify(msgs));
    await ed.close();

    // 重新打开一个编辑器页，验证偏好持久化（localStorage）
    const ed2 = await openEditor(env);
    const s3 = await editorState(ed2.evalEd);
    check('重新打开沿用英文偏好', s3.select === 'en' && s3.save === '✓ Save PNG', JSON.stringify(s3));

    await switchLang(ed2.evalEd, 'auto');
    const s4 = await editorState(ed2.evalEd);
    check('切回自动后跟随浏览器（简体）', s4.select === 'auto' && s4.htmlLang === 'zh-CN' && s4.save === '✓ 保存 PNG', JSON.stringify(s4));
    await ed2.close();
  });

  // ---- 第 2 轮：en-US，测默认英文 ----
  await withChrome('en-US', port++, async (env) => {
    const uiLang = await env.evalSW(`chrome.i18n.getUILanguage()`);
    check('浏览器 UI 语言是 en-US', uiLang.startsWith('en'), uiLang);
    const extName = await env.evalSW(`chrome.i18n.getMessage('extName')`);
    check('manifest 名称走英文', extName === 'Region Shot · Region Capture', extName);
    const overlay = await env.evalSW(`chrome.i18n.getMessage('overlayStep2')`);
    check('遮罩提示文案走英文', /Step 2/.test(overlay), overlay);

    const ed = await openEditor(env);
    const s = await editorState(ed.evalEd);
    check('自动：编辑页默认英文', s.htmlLang === 'en' && s.select === 'auto' && s.save === '✓ Save PNG', JSON.stringify(s));
    await ed.close();
  });

  // ---- 第 3 轮：zh-TW，测默认繁体 ----
  await withChrome('zh-TW', port++, async (env) => {
    const uiLang = await env.evalSW(`chrome.i18n.getUILanguage()`);
    check('浏览器 UI 语言是 zh-TW', /zh-(TW|HK|MO)/i.test(uiLang), uiLang);
    const extName = await env.evalSW(`chrome.i18n.getMessage('extName')`);
    check('manifest 名称走繁体', extName === 'Region Shot · 區域截圖', extName);
    const overlay = await env.evalSW(`chrome.i18n.getMessage('overlayDone')`);
    check('遮罩完成按钮文案走繁体', overlay === '✓ 完成截圖', overlay);

    const ed = await openEditor(env);
    const s = await editorState(ed.evalEd);
    check('自动：编辑页默认繁体', s.htmlLang === 'zh-TW' && s.select === 'auto' && s.save === '✓ 儲存 PNG', JSON.stringify(s));
    await ed.close();
  });

  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}

  const failed = report.filter((r) => !r.ok);
  console.log(`\n${report.length - failed.length}/${report.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch {}
  process.exit(1);
});
