// Region Shot · 区域截图（滚动拼接）
// 设计要点：截图数据全程在 background 内处理，不通过 executeScript 传大图，
//          避免大 dataUrl 序列化失败导致“只截一屏、页面不滚动”。

const CAPTURE_INTERVAL_MS = 650; // captureVisibleTab 有每秒约 2 次的配额
const MAX_FRAMES = 80;
const MAX_STAGE_HEIGHT = 16384; // 拼接画布最大高度（设备像素）

chrome.action.onClicked.addListener((tab) => {
  runCapture(tab).catch((err) => console.error('[RegionShot]', err));
});

async function runCapture(tab) {
  if (!tab.id) return;

  if (!/^(https?|file):/i.test(tab.url || '')) {
    console.warn('[RegionShot] 当前页面不支持截图:', tab.url);
    return;
  }

  // 1) 选区
  let rect;
  try {
    const [sel] = await exec(tab.id, selectionOverlay);
    rect = sel?.result;
  } catch (e) {
    console.warn('[RegionShot] 注入选区失败', e);
    return;
  }
  if (!rect) return;
  console.log('[RegionShot] 选区', rect);

  const dpr = rect.dpr || 1;
  const outW = Math.max(1, Math.round(rect.w * dpr));
  const outH = Math.max(1, Math.round(rect.h * dpr));

  // 2) 初始化滚动状态（记录初始位置、确定滚动容器）
  try {
    await exec(tab.id, initStage, [rect]);
  } catch (e) {
    console.warn('[RegionShot] 初始化滚动失败', e);
    return;
  }

  // 3) 在 background 里逐屏裁剪、拼接
  let stage = new OffscreenCanvas(outW, outH);
  let ctx = stage.getContext('2d');
  let y = 0;
  let keepHeight = outH;

  try {
    for (let i = 0; i < MAX_FRAMES; i++) {
      const shot = await captureVisibleTabRetry(tab.windowId);
      const frame = await drawOneFrame(ctx, stage, shot, rect, keepHeight, y);
      if (!frame) break;

      stage = frame.stage;
      ctx = frame.ctx;
      y = frame.y;

      const [stepRes] = await exec(tab.id, scrollStep, [rect]);
      const step = stepRes?.result;
      console.log('[RegionShot] 第', i + 1, '屏', step);

      if (!step || step.moved <= 0 || step.atBottom) break;

      keepHeight = Math.round(step.moved * dpr);
      await sleep(CAPTURE_INTERVAL_MS);
    }
  } catch (e) {
    console.warn('[RegionShot] 截图循环中断', e);
  }

  // 4) 恢复页面滚动位置
  try {
    await exec(tab.id, restoreScroll);
  } catch {
    /* ignore */
  }

  if (y <= 0) {
    console.warn('[RegionShot] 没有可保存的内容');
    return;
  }

  const blob = await stage.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);

  await chrome.downloads.download({
    url: dataUrl,
    filename: `region-${stamp()}.png`,
    saveAs: false,
  });
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

async function drawOneFrame(ctx, stage, dataUrl, rect, keepHeight, y) {
  let bitmap;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    bitmap = await createImageBitmap(blob);
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

    if (drawW <= 0 || keep <= 0) return null;

    const need = y + keep;
    if (need > MAX_STAGE_HEIGHT) return null;

    let s = stage;
    let c = ctx;

    // 画布不够高时扩容，保留已有内容
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

    // mousemove / mouseup 挂在 window 上，鼠标移出窗口再松开也能结束
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

    // 窗口失焦等异常情况兜底，避免遮罩残留挡住页面
    const onBlur = () => {
      if (dragging) finish(null);
    };

    document.addEventListener('keydown', onKey, true);
    root.addEventListener('mousedown', onDown);
    root.addEventListener('contextmenu', onContext);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onBlur);
  });
}

function initStage(rect) {
  const ID = '__region_shot_stage__';
  document.getElementById(ID)?.remove();
  document.querySelector('[data-region-shot-scroll="1"]')?.removeAttribute('data-region-shot-scroll');
  delete document.documentElement.dataset.rsInitWindowY;
  delete document.documentElement.dataset.rsInitTargetY;

  // 记录初始滚动位置，结束后恢复
  document.documentElement.dataset.rsInitWindowY = String(window.scrollY);

  // 优先用 window 滚动；只有页面本身不可滚时，才找选区内最近的可滚动祖先
  const se = document.scrollingElement || document.documentElement;
  const pageScrollable = se.scrollHeight > se.clientHeight + 2;

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

  return true;
}

function scrollStep(rect) {
  const h = rect.h;
  const target = document.querySelector('[data-region-shot-scroll="1"]');
  const useWindow = !target;

  const html = document.documentElement;
  const prevHtmlBehavior = html.style.scrollBehavior;
  const prevTargetBehavior = target ? target.style.scrollBehavior : '';

  // 临时关闭平滑滚动，保证截图时已经到位
  html.style.scrollBehavior = 'auto';
  if (target) target.style.scrollBehavior = 'auto';

  const before = useWindow ? window.scrollY : target.scrollTop;

  if (useWindow) {
    window.scrollBy(0, h);
  } else {
    target.scrollTop = before + h;
  }

  const after = useWindow ? window.scrollY : target.scrollTop;
  const maxScroll = useWindow
    ? Math.max(0, (document.scrollingElement || html).scrollHeight - window.innerHeight)
    : Math.max(0, target.scrollHeight - target.clientHeight);

  html.style.scrollBehavior = prevHtmlBehavior;
  if (target) target.style.scrollBehavior = prevTargetBehavior;

  return {
    moved: Math.max(0, after - before),
    atBottom: after >= maxScroll - 1,
    mode: useWindow ? 'window' : 'element',
  };
}

function restoreScroll() {
  const docEl = document.documentElement;
  const initY = parseFloat(docEl.dataset.rsInitWindowY || '');
  if (!Number.isNaN(initY)) {
    window.scrollTo({ top: initY, behavior: 'auto' });
  }

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
