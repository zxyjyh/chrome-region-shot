// Region Shot · 区域截图（CDP 方案）
//
// 放弃“截图时滚动页面”的做法，改用 Chrome 调试协议的 Page.captureScreenshot：
// captureBeyondViewport 可以直接渲染视口之外的区域，因此不需要真的滚动，
// 也就没有“滚不动 / 滚动距离对不上 / 固定元素重复”这些问题。
//
// 选区语义：用户框出 x 范围和起点 y，扩展截取「从选区顶部到页面底部」的该 x 范围内容。

const MAX_SEGMENT_DEVICE = 16000; // 单次 CDP 截图的设备像素高度上限
const MAX_TOTAL_DEVICE = 30000; // 最终画布的设备像素高度上限

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

  // 1) 选区（只需要 x 范围和一屏内的起点，不需要滚动）
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

  const target = { tabId: tab.id };

  // 2) 附加调试器
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    console.warn('[RegionShot] 无法附加调试器（该标签可能已被 DevTools 占用）', e);
    setBadge(tab.id, '!', '#dc2626');
    return;
  }

  try {
    await captureWithCdp(tab, target, rect);
  } catch (e) {
    console.error('[RegionShot] CDP 截图失败', e);
    setBadge(tab.id, '!', '#dc2626');
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      /* ignore */
    }
  }
}

async function captureWithCdp(tab, target, rect) {
  const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
  const content = metrics.cssContentSize || metrics.contentSize;
  const vv = metrics.cssVisualViewport || metrics.visualViewport || {};
  const pageY = vv.pageY || 0;
  const pageX = vv.pageX || 0;

  const dpr = rect.dpr || 1;
  const startY = Math.max(0, pageY + rect.y); // 选区顶部在文档中的坐标
  const docH = content.height || 0;
  const avail = Math.max(0, docH - startY);
  const totalH = Math.min(avail, MAX_TOTAL_DEVICE / dpr);

  console.log('[RegionShot] 文档', { docH, pageY, startY, avail, totalH, dpr });

  if (totalH <= 1) {
    console.warn('[RegionShot] 选区下方没有可截取内容（页面可能不足一屏）');
    setBadge(tab.id, '!', '#dc2626');
    return;
  }

  const segCssH = Math.max(200, Math.floor(MAX_SEGMENT_DEVICE / dpr));
  const segCount = Math.ceil(totalH / segCssH);

  let stage = null;
  let ctx = null;
  let y = 0;

  for (let i = 0; i < segCount; i++) {
    const offset = i * segCssH;
    const h = Math.min(segCssH, totalH - offset);
    setBadge(tab.id, `${i + 1}/${segCount}`);

    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: pageX + rect.x,
        y: startY + offset,
        width: rect.w,
        height: h,
        scale: 1,
      },
    });

    const bitmap = await createImageBitmap(
      dataUrlToBlob('data:image/png;base64,' + shot.data)
    );

    if (!stage) {
      // 用第一段返回的像素高度推算总高度，兼容不同 deviceScaleFactor
      const scaleY = bitmap.height / h;
      const totalPx = Math.ceil(totalH * scaleY);
      stage = new OffscreenCanvas(bitmap.width, Math.min(totalPx, MAX_TOTAL_DEVICE));
      ctx = stage.getContext('2d');
    }

    try {
      const drawH = Math.min(bitmap.height, stage.height - y);
      if (drawH <= 0) break;
      ctx.drawImage(bitmap, 0, 0, bitmap.width, drawH, 0, y, bitmap.width, drawH);
      y += drawH;
      if (drawH < bitmap.height) break; // 达到画布上限
    } finally {
      bitmap.close();
    }
  }

  if (!stage || y <= 0) {
    console.warn('[RegionShot] 没有可保存的内容');
    setBadge(tab.id, '!', '#dc2626');
    return;
  }

  // 裁掉画布底部多余部分
  let finalCanvas = stage;
  if (y < stage.height) {
    finalCanvas = new OffscreenCanvas(stage.width, y);
    finalCanvas.getContext('2d').drawImage(stage, 0, 0);
  }

  const blob = await finalCanvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  await saveWithFallback(tab, dataUrl, `region-${stamp()}.png`);
}

async function saveWithFallback(tab, dataUrl, filename) {
  let saved = false;

  // 先试 downloads API；data URL 过长时它会抛错
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
    tip.textContent = '拖拽选择宽度和起点 · 松手后自动截取到页面底部 · Esc 取消';
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

    // 选区阶段拦住滚轮/触摸板滑动，避免坐标错位
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

      if (w < 4) {
        finish(null);
        return;
      }

      // 高度只用来确定起点，实际会一直截到页面底部；太薄视为误触
      if (h < 4) {
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

// 兜底下载：在页面里用 blob URL 触发下载，绕开 downloads API 对超长 data URL 的限制
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
