// Region Shot · 区域截图（滚动拼接）
//
// 关键修正（相对上一版）：
// 1. service worker 里不再用 fetch(dataUrl) 解码截图（MV3 worker 环境不稳定），
//    改为手动 base64 -> Uint8Array -> Blob。
// 2. 滚动直接操作 document.scrollingElement.scrollTop，不再依赖 window.scrollBy。
// 3. 选区阶段拦截 wheel 事件，避免 Mac 触摸板两指滑动把页面滚走、选区错位。
// 4. 用扩展图标角标显示进度，失败时显示 "!"，方便定位卡在哪里。

const CAPTURE_INTERVAL_MS = 650; // captureVisibleTab 有每秒约 2 次的配额
const MAX_FRAMES = 80;
const MAX_STAGE_HEIGHT = 16384; // 拼接画布最大高度（设备像素）

chrome.action.onClicked.addListener((tab) => {
  runCapture(tab).catch((err) => {
    console.error('[RegionShot]', err);
    if (tab?.id) setBadge(tab.id, '!', '#dc2626');
  });
});

async function runCapture(tab) {
  if (!tab.id) return;

  if (!/^(https?|file):/i.test(tab.url || '')) {
    console.warn('[RegionShot] 当前页面不支持截图:', tab.url);
    setBadge(tab.id, '!', '#dc2626');
    return;
  }

  setBadge(tab.id, '');

  // 1) 选区
  let rect;
  try {
    const [sel] = await exec(tab.id, selectionOverlay);
    rect = sel?.result;
  } catch (e) {
    console.warn('[RegionShot] 注入选区失败', e);
    setBadge(tab.id, '!', '#dc2626');
    return;
  }
  if (!rect) return;
  console.log('[RegionShot] 选区', rect);

  const dpr = rect.dpr || 1;
  const outW = Math.max(1, Math.round(rect.w * dpr));
  const outH = Math.max(1, Math.round(rect.h * dpr));

  // 2) 初始化滚动状态
  try {
    const [r] = await exec(tab.id, initStage, [rect]);
    console.log('[RegionShot] 滚动环境', r?.result);
  } catch (e) {
    console.warn('[RegionShot] 初始化滚动失败', e);
    setBadge(tab.id, '!', '#dc2626');
    return;
  }

  // 3) 逐屏截图 + 在 background 内拼接
  let stage = new OffscreenCanvas(outW, outH);
  let ctx = stage.getContext('2d');
  let y = 0;
  let keepHeight = outH;
  let frames = 0;

  try {
    for (let i = 0; i < MAX_FRAMES; i++) {
      setBadge(tab.id, String(i + 1));

      const shot = await captureVisibleTabRetry(tab.windowId);
      const frame = await drawOneFrame(ctx, stage, shot, rect, keepHeight, y);
      if (!frame) {
        console.warn('[RegionShot] 第', i + 1, '帧绘制失败');
        break;
      }

      stage = frame.stage;
      ctx = frame.ctx;
      y = frame.y;
      frames++;

      const [stepRes] = await exec(tab.id, scrollStep, [rect]);
      const step = stepRes?.result;
      console.log('[RegionShot] 第', i + 1, '屏', step);

      if (!step || step.moved <= 0 || step.atBottom) break;

      keepHeight = Math.round(step.moved * dpr);
      await sleep(CAPTURE_INTERVAL_MS);
    }
  } catch (e) {
    console.warn('[RegionShot] 截图循环中断', e);
    setBadge(tab.id, '!', '#dc2626');
  }

  // 4) 恢复页面滚动位置
  try {
    await exec(tab.id, restoreScroll);
  } catch {
    /* ignore */
  }

  if (frames === 0 || y <= 0) {
    console.warn('[RegionShot] 没有可保存的内容');
    setBadge(tab.id, '!', '#dc2626');
    return;
  }

  // 5) 导出并保存
  const blob = await stage.convertToBlob({ type: 'image/png' });
  const filename = `region-${stamp()}.png`;
  const dataUrl = await blobToDataUrl(blob);

  let saved = false;

  // 先试 downloads API；data URL 过长时它会抛错，再退回页面内 blob 下载
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    saved = true;
  } catch (e) {
    console.warn('[RegionShot] downloads.download 失败，改用页面下载', e);
  }

  if (!saved) {
    try {
      const [r] = await exec(tab.id, saveImage, [dataUrl, filename]);
      saved = r?.result === true;
      if (!saved) console.warn('[RegionShot] 页面下载返回', r?.result);
    } catch (e) {
      console.warn('[RegionShot] 页面下载失败', e);
    }
  }

  if (saved) {
    setBadge(tab.id, 'OK');
    setTimeout(() => setBadge(tab.id, ''), 2500);
  } else {
    setBadge(tab.id, '!', '#dc2626');
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function exec(tabId, func, args) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ tabId, text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    /* tab 可能已关闭 */
  }
}

async function captureVisibleTabRetry(windowId) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      lastErr = e;
      await sleep(700);
    }
  }
  throw lastErr;
}

// data URL 手动解码，避免 service worker 里 fetch(data:) 的不确定性
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const m = head.match(/data:([^;]+)/);
  const mime = m ? m[1] : 'image/png';

  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function drawOneFrame(ctx, stage, dataUrl, rect, keepHeight, y) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  } catch (e) {
    console.warn('[RegionShot] 解码截图失败', e);
    return null;
  }

  try {
    const dpr = rect.dpr || 1;
    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const availW = Math.max(0, bitmap.width - sx);
    const availH = Math.max(0, bitmap.height - sy);
    const drawW = Math.min(Math.round(rect.w * dpr), availW);
    const fullH = Math.min(Math.round(rect.h * dpr), availH);
    const keep = Math.min(keepHeight, fullH);

    if (drawW <= 0 || keep <= 0) {
      console.warn('[RegionShot] 选区超出截图范围', { sx, sy, availW, availH, drawW, keep });
      return null;
    }

    const need = y + keep;
    if (need > MAX_STAGE_HEIGHT) {
      console.warn('[RegionShot] 达到画布高度上限', MAX_STAGE_HEIGHT);
      return null;
    }

    let s = stage;
    let c = ctx;

    if (need > s.height) {
      const next = new OffscreenCanvas(
        s.width,
        Math.min(MAX_STAGE_HEIGHT, Math.max(need, s.height * 2))
      );
      next.getContext('2d').drawImage(s, 0, 0);
      s = next;
      c = s.getContext('2d');
    }

    // 每帧只取底部 keep 高度，避免与上一帧重叠
    c.drawImage(bitmap, sx, sy + fullH - keep, drawW, keep, 0, y, drawW, keep);
    return { stage: s, ctx: c, y: y + keep };
  } finally {
    bitmap.close();
  }
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ============================================================================
// 以下函数会被序列化后注入页面执行，必须自包含（不能引用外部变量）
// ============================================================================

function selectionOverlay() {
  return new Promise((resolve) => {
    const ID = '__region_shot_overlay__';
    document.getElementById(ID)?.remove();

    const dpr = window.devicePixelRatio || 1;
    const prevCursor = document.body ? document.body.style.cursor : '';
    let settled = false;

    const root = document.createElement('div');
    root.id = ID;
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'cursor:crosshair',
      'background:rgba(0,0,0,0.18)',
      'user-select:none',
      '-webkit-user-select:none',
      'touch-action:none',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'border:2px solid #3b82f6',
      'background:rgba(59,130,246,0.15)',
      'box-sizing:border-box',
      'pointer-events:none',
      'display:none',
    ].join(';');

    const tip = document.createElement('div');
    tip.textContent = '拖拽选择区域 · 松手后自动向下滚动拼接 · Esc 取消';
    tip.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'left:50%',
      'top:16px',
      'transform:translateX(-50%)',
      'padding:6px 14px',
      'background:rgba(17,24,39,0.92)',
      'color:#fff',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
      'border-radius:6px',
      'pointer-events:none',
      'white-space:nowrap',
    ].join(';');

    document.documentElement.append(root, box, tip);
    if (document.body) document.body.style.cursor = 'crosshair';

    let sx = 0;
    let sy = 0;
    let dragging = false;

    const cleanup = () => {
      root.remove();
      box.remove();
      tip.remove();
      if (document.body) document.body.style.cursor = prevCursor;
      document.removeEventListener('keydown', onKey, true);
      root.removeEventListener('mousedown', onDown);
      root.removeEventListener('contextmenu', onContext);
      root.removeEventListener('wheel', onWheel, { passive: false });
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      Object.assign(box.style, {
        display: 'block',
        left: `${sx}px`,
        top: `${sy}px`,
        width: '0px',
        height: '0px',
      });
    };

    // 选区阶段拦住滚轮/触摸板滑动，否则页面会滚走、鼠标坐标和画面错位
    const onWheel = (e) => {
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!dragging) return;
      const x = Math.min(sx, e.clientX);
      const y = Math.min(sy, e.clientY);
      Object.assign(box.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${Math.abs(e.clientX - sx)}px`,
        height: `${Math.abs(e.clientY - sy)}px`,
      });
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;

      const x = Math.min(sx, e.clientX);
      const y = Math.min(sy, e.clientY);
      const w = Math.abs(e.clientX - sx);
      const h = Math.abs(e.clientY - sy);

      if (w < 4 || h < 4) {
        finish(null);
        return;
      }
      finish({ x, y, w, h, dpr });
    };

    const onContext = (e) => {
      e.preventDefault();
      finish(null);
    };

    const onBlur = () => {
      if (dragging) finish(null);
    };

    document.addEventListener('keydown', onKey, true);
    root.addEventListener('mousedown', onDown);
    root.addEventListener('contextmenu', onContext);
    root.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onBlur);
  });
}

function initStage(rect) {
  document.getElementById('__region_shot_stage__')?.remove();
  document.querySelector('[data-region-shot-scroll="1"]')?.removeAttribute('data-region-shot-scroll');
  delete document.documentElement.dataset.rsInitWindowY;
  delete document.documentElement.dataset.rsInitTargetY;

  const se = document.scrollingElement || document.documentElement;
  const pageScrollable = se.scrollHeight > se.clientHeight + 2;

  // 记录页面的初始滚动位置
  document.documentElement.dataset.rsInitWindowY = String(se.scrollTop);

  // 优先用页面滚动；只有页面本身不可滚时，才找选区内最近的可滚动祖先
  if (!pageScrollable) {
    const cx = Math.min(window.innerWidth - 1, Math.max(0, rect.x + rect.w / 2));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, rect.y + rect.h / 2));
    let el = document.elementFromPoint(cx, cy);

    while (el && el !== document.documentElement && el !== document.body) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 2) {
        el.setAttribute('data-region-shot-scroll', '1');
        document.documentElement.dataset.rsInitTargetY = String(el.scrollTop);
        break;
      }
      el = el.parentElement;
    }
  }

  // 兜底：有的页面是 html 不可滚、body 自己 overflow:auto，上面的遍历会跳过 body
  if (!document.querySelector('[data-region-shot-scroll="1"]') && document.body) {
    const bs = getComputedStyle(document.body);
    if (
      /(auto|scroll)/.test(bs.overflowY) &&
      document.body.scrollHeight > document.body.clientHeight + 2
    ) {
      document.body.setAttribute('data-region-shot-scroll', '1');
      document.documentElement.dataset.rsInitTargetY = String(document.body.scrollTop);
    }
  }

  const target = document.querySelector('[data-region-shot-scroll="1"]');
  return {
    mode: target ? 'element' : 'window',
    pageScrollable,
    scrollTop: se.scrollTop,
    scrollHeight: se.scrollHeight,
    viewportHeight: se.clientHeight,
  };
}

function scrollStep(rect) {
  const h = rect.h;
  const target = document.querySelector('[data-region-shot-scroll="1"]');
  const html = document.documentElement;
  const prevHtmlBehavior = html.style.scrollBehavior;
  const prevTargetBehavior = target ? target.style.scrollBehavior : '';

  // 临时关闭平滑滚动，保证截图时已经到位
  html.style.scrollBehavior = 'auto';
  if (target) target.style.scrollBehavior = 'auto';

  let before;
  let after;
  let maxScroll;
  let mode;

  if (target) {
    mode = 'element';
    before = target.scrollTop;
    target.scrollTop = before + h;
    after = target.scrollTop;
    maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
  } else {
    mode = 'window';
    const se = document.scrollingElement || html;
    before = se.scrollTop;
    se.scrollTop = before + h;
    after = se.scrollTop;
    maxScroll = Math.max(0, se.scrollHeight - se.clientHeight);
  }

  html.style.scrollBehavior = prevHtmlBehavior;
  if (target) target.style.scrollBehavior = prevTargetBehavior;

  return {
    moved: Math.max(0, after - before),
    atBottom: after >= maxScroll - 1,
    mode,
    scrollTop: after,
    maxScroll,
  };
}

function restoreScroll() {
  const docEl = document.documentElement;
  const se = document.scrollingElement || docEl;
  const initY = parseFloat(docEl.dataset.rsInitWindowY || '');
  if (!Number.isNaN(initY)) se.scrollTop = initY;

  const target = document.querySelector('[data-region-shot-scroll="1"]');
  const initTargetY = parseFloat(docEl.dataset.rsInitTargetY || '');
  if (target) {
    if (!Number.isNaN(initTargetY)) target.scrollTop = initTargetY;
    target.removeAttribute('data-region-shot-scroll');
  }

  delete docEl.dataset.rsInitWindowY;
  delete docEl.dataset.rsInitTargetY;
  return true;
}

// 兜底下载：downloads API 对过长的 data URL 会失败，改在页面里用 blob URL 触发下载
async function saveImage(dataUrl, filename) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 10000);

    return true;
  } catch (e) {
    return String(e);
  }
}
