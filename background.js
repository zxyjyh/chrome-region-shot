// Region Shot · 区域截图（滚动拼接方案）
//
// 为什么不用 captureBeyondViewport 一次性截取：
// 大量网站的主内容放在 overflow:auto 的内部容器里，此时 window.scrollY 恒为 0、
// document.scrollingElement.scrollHeight 等于一屏高度。依赖「文档坐标 + 视口外渲染」
// 会算不出真实范围，只能截到当前可见区域。
//
// 现在的做法：
//   1. 选区阶段探测「真正在滚的那个元素」（window 或内部容器），坐标统一用该容器的内容坐标
//   2. 截图阶段由扩展自己把这个容器一屏一屏滚过去，每屏截一次，最后拼成一张
//   3. 两种滚动方式走同一条代码路径

const MAX_TOTAL_DEVICE = 30000; // 最终画布单边的设备像素上限
const MAX_CANVAS_PIXELS = 16384 * 16384; // Chrome 画布的面积上限，超了会直接创建失败
const SCROLL_SETTLE_MS = 250; // 每屏滚动后等待渲染的时间
const SHOT_DB = 'region-shot'; // 与 editor.js 里的常量保持一致
const SHOT_STORE = 'shots';

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
  const target = { tabId: tab.id };

  // 先附加调试器再让用户框选。
  // 附加调试器会让 Chrome 弹出调试提示条，视口高度会变化约 56px，
  // 如果先框选再附加，选区尺寸就和截图时的视口对不上了。
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    console.warn('[RegionShot] 无法附加调试器（该标签可能已被 DevTools 占用）', e);
    setBadge(tab.id, '!', '#dc2626');
    return;
  }

  try {
    // 1) 选区（返回的是「滚动容器的内容坐标」）
    let sel;
    try {
      sel = await execResult(tab.id, selectionOverlay, [
        'v' + chrome.runtime.getManifest().version,
      ]);
    } catch (e) {
      console.warn('[RegionShot] 注入选区失败', e);
      setBadge(tab.id, '!', '#dc2626');
      return;
    }
    if (!sel) return;
    console.log('[RegionShot] 选区', sel);

    // 2) 滚动截图
    await captureByScroll(tab, target, sel);
  } catch (e) {
    console.error('[RegionShot] 截图失败', e);
    setBadge(tab.id, '!', '#dc2626');
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      /* ignore */
    }
    try {
      await execResult(tab.id, clearMark);
    } catch {
      /* ignore */
    }
  }
}

async function captureByScroll(tab, target, sel) {
  const geo0 = await execResult(tab.id, readGeo, [sel.kind]);
  if (!geo0) throw new Error('找不到滚动容器');

  const dpr = geo0.dpr || 1;
  const contentW = geo0.scrollW || geo0.viewportW;
  const contentH = geo0.scrollH;
  const totalW = Math.min(sel.w, contentW - sel.x, MAX_TOTAL_DEVICE / dpr);
  const totalH = Math.min(sel.h, contentH - sel.y, MAX_TOTAL_DEVICE / dpr);

  console.log('[RegionShot] 滚动参数', JSON.stringify({ sel, geo0, contentW, contentH, totalW, totalH }));

  if (totalH <= 1) throw new Error('选区没有有效高度（内容高度 ' + contentH + '，起点 ' + sel.y + '）');
  if (totalW <= 1) throw new Error('选区没有有效宽度（内容宽度 ' + contentW + '，起点 ' + sel.x + '）');

  // 先横向铺完一行，再纵向推进到下一条带。不预计算分段：
  // 每屏能截多宽/多高取决于当下真实的视口尺寸，按实际截到的尺寸推进才不会漏内容。
  const endY = Math.round(sel.y + totalH);
  const endX = Math.round(sel.x + totalW);
  let py = Math.round(sel.y);
  let stage = null;
  let ctx = null;
  let drawnY = 0; // 已绘制的设备像素高度
  let maxX = 0; // 已绘制到的设备像素宽度
  let scale = dpr; // 设备像素 / CSS 像素，用第一张截图校准
  let i = 0;

  // 吸顶的导航栏会被逐屏拍进去，截图期间先藏起来
  let floating = 0;
  try {
    floating = await execResult(tab.id, hideFloating, [sel.kind]);
    if (floating) {
      console.log('[RegionShot] 隐藏吸顶元素', floating);
      await execResult(tab.id, waitFrames);
      await sleep(80);
    }
  } catch (e) {
    console.warn('[RegionShot] 隐藏吸顶元素失败', e);
  }

  try {
    while (py < endY && i++ < 500) {
      setBadge(tab.id, `${Math.min(99, Math.round(((py - sel.y) / totalH) * 100))}%`);

      let px = Math.round(sel.x);
      let drawnX = 0; // 本行已绘制的设备像素宽度
      let rowH = 0; // 本行可覆盖的 CSS 高度
      let painted = false;

      while (px < endX && i++ < 4000) {
        await execResult(tab.id, scrollToPosition, [sel.kind, py, px]);
        await execResult(tab.id, waitFrames);
        await sleep(SCROLL_SETTLE_MS);

        const g = await execResult(tab.id, readGeo, [sel.kind]);
        if (!g) throw new Error('滚动容器消失了');

        // 实际滚动位置可能被 clamp（已经到边界），据此修正这一屏从哪开始截
        const leadY = Math.max(0, py - g.scrollTop);
        const leadX = Math.max(0, px - g.scrollLeft);
        const availH = g.viewportH - leadY;
        const availW = g.viewportW - leadX;
        const h = Math.min(endY - py, availH);
        const w = Math.min(endX - px, availW);

        if (h <= 2) {
          console.warn('[RegionShot] 无法继续纵向滚动，提前结束', {
            py,
            scrollTop: g.scrollTop,
            viewportH: g.viewportH,
          });
          break;
        }
        if (w <= 2) {
          // 这一行已经横向到头（页面不支持横向滚动，或内容宽度不够）
          if (!painted) {
            console.warn('[RegionShot] 选区宽度越界', { sel, g });
          }
          break;
        }

        // 内容坐标 → 文档坐标
        const xDoc = g.viewportLeftDoc + leadX;
        const yDoc = g.viewportTopDoc + leadY;

        const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
          format: 'png',
          clip: {
            x: xDoc,
            y: yDoc,
            width: w,
            height: h,
            // 坐标是 CSS 像素；Chrome 会自动按设备像素比输出，
            // 这里不能再乘 dpr，否则 Retina 屏上会被放大两次
            scale: 1,
          },
        });

        const bitmap = await createImageBitmap(dataUrlToBlob('data:image/png;base64,' + shot.data));

        if (!stage) {
          scale = bitmap.width / w;
          let canvasW = Math.min(Math.ceil(totalW * scale), MAX_TOTAL_DEVICE);
          let canvasH = Math.min(Math.ceil(totalH * scale), MAX_TOTAL_DEVICE);
          // 单边没超、面积超了也会创建失败，按面积等比缩一次
          if (canvasW * canvasH > MAX_CANVAS_PIXELS) {
            const k = Math.sqrt(MAX_CANVAS_PIXELS / (canvasW * canvasH));
            canvasW = Math.max(1, Math.floor(canvasW * k));
            canvasH = Math.max(1, Math.floor(canvasH * k));
          }
          try {
            stage = new OffscreenCanvas(canvasW, canvasH);
            ctx = stage.getContext('2d');
          } catch (e) {
            bitmap.close();
            throw new Error('画布过大（' + canvasW + '×' + canvasH + '），无法拼接');
          }
        }

        // 这一屏实际覆盖的内容宽高（正常情况下等于 w / h）
        let advanceW = w;
        let advanceH = h;
        try {
          const dstX = Math.round(drawnX);
          const dstY = Math.round(drawnY);
          const drawW = Math.min(bitmap.width, stage.width - dstX);
          const drawH = Math.min(bitmap.height, stage.height - dstY);
          if (drawW <= 0 || drawH <= 0) break;
          ctx.drawImage(bitmap, 0, 0, drawW, drawH, dstX, dstY, drawW, drawH);
          drawnX += drawW;
          maxX = Math.max(maxX, drawnX);
          advanceW = w * (drawW / bitmap.width);
          advanceH = h * (drawH / bitmap.height);
          painted = true;
        } finally {
          bitmap.close();
        }

        px += Math.max(1, Math.round(advanceW));
        rowH = Math.max(rowH, Math.round(advanceH));
        if (drawnX >= stage.width) break;
      }

      if (!painted || rowH <= 0) break;
      drawnY += Math.round(rowH * scale);
      py += rowH;
      if (drawnY >= stage.height) break;
    }
  } finally {
    if (floating) {
      try {
        await execResult(tab.id, restoreFloating, [sel.kind]);
      } catch {
        /* ignore */
      }
    }
  }

  if (!stage || drawnY <= 0 || maxX <= 0) throw new Error('没有可保存的内容');

  // 恢复页面原来的滚动位置
  try {
    await execResult(tab.id, scrollToPosition, [
      sel.kind,
      sel.scrollStart || 0,
      sel.scrollStartX || 0,
    ]);
  } catch {
    /* ignore */
  }

  const usedH = Math.min(stage.height, Math.round(drawnY));
  const usedW = Math.min(stage.width, Math.round(maxX));
  let finalCanvas = stage;
  if (usedH < stage.height || usedW < stage.width) {
    finalCanvas = new OffscreenCanvas(Math.max(1, usedW), Math.max(1, usedH));
    finalCanvas.getContext('2d').drawImage(stage, 0, 0);
  }

  const blob = await finalCanvas.convertToBlob({ type: 'image/png' });
  const filename = `region-${stamp()}.png`;

  // 截图先交给标注编辑器：用户可以在图上加文字/箭头/矩形，确认后再下载。
  // 编辑器打不开（比如 IndexedDB 不可用）就退回原来的直接保存，不让功能退化成失败。
  try {
    await openEditor(blob, filename);
    setBadge(tab.id, 'OK');
    setTimeout(() => setBadge(tab.id, ''), 2500);
  } catch (e) {
    console.warn('[RegionShot] 打开标注编辑器失败，直接保存原图', e);
    await saveWithFallback(tab, await blobToDataUrl(blob), filename);
  }
}

// 把截图交给 editor.html：写进 IndexedDB（service worker 与扩展页面同一 origin 共享），
// 页面读出来后自行删除。用一次性 id 而不是固定 key，连续截几张也不会互相覆盖。
async function openEditor(blob, filename) {
  const id = crypto.randomUUID();
  const db = await openShotDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SHOT_STORE, 'readwrite');
      tx.objectStore(SHOT_STORE).put(blob, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('写入截图数据被中止'));
    });
  } finally {
    db.close();
  }

  const url =
    chrome.runtime.getURL('editor.html') +
    `?id=${encodeURIComponent(id)}&name=${encodeURIComponent(filename)}`;
  try {
    await chrome.tabs.create({ url, active: true });
  } catch (e) {
    // 标签页没打开就没人来取这份原图，别让它留在本地
    await dropShot(id);
    throw e;
  }
}

async function dropShot(id) {
  try {
    const db = await openShotDB();
    await new Promise((resolve) => {
      const tx = db.transaction(SHOT_STORE, 'readwrite');
      tx.objectStore(SHOT_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    db.close();
  } catch {
    /* ignore */
  }
}

function openShotDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHOT_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SHOT_STORE)) db.createObjectStore(SHOT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveWithFallback(tab, dataUrl, filename) {
  let saved = false;

  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    saved = true;
  } catch (e) {
    console.warn('[RegionShot] downloads.download 失败，改用页面下载', e);
  }

  if (!saved) {
    try {
      const r = await execResult(tab.id, saveImage, [dataUrl, filename]);
      saved = r === true;
      if (!saved) console.warn('[RegionShot] 页面下载返回', r);
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

async function execResult(tabId, func, args) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
  });
  return r?.result;
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

// 读取滚动容器的几何与滚动状态
// kind: 'doc'（整个页面） | 'element'（内部滚动容器） | 'iframe'（同源 iframe 内部滚动）
function readGeo(kind) {
  const SCROLLER = 'data-region-shot-scroller';
  const FRAME = 'data-region-shot-frame';
  const dpr = window.devicePixelRatio || 1;

  if (kind === 'iframe') {
    const f = document.querySelector('[' + FRAME + ']');
    if (!f) return null;
    let d = null;
    try {
      d = f.contentDocument;
    } catch {
      return null; // 跨域 iframe 拿不到
    }
    if (!d) return null;
    const se = d.scrollingElement || d.documentElement;
    if (!se) return null;
    const r = f.getBoundingClientRect();
    const visTop = Math.max(0, r.top);
    const visBottom = Math.min(window.innerHeight, r.bottom);
    return {
      scrollTop: se.scrollTop,
      scrollLeft: se.scrollLeft,
      scrollH: se.scrollHeight,
      scrollW: se.scrollWidth,
      viewportTopDoc: visTop + window.scrollY,
      viewportLeftDoc: r.left + window.scrollX,
      viewportH: Math.max(0, visBottom - visTop),
      viewportW: r.width,
      dpr,
    };
  }

  const el =
    kind === 'doc'
      ? document.scrollingElement || document.documentElement
      : document.querySelector('[' + SCROLLER + ']');

  if (!el) return null;

  const isDoc = el === document.scrollingElement;
  const r = isDoc ? { left: 0, top: 0 } : el.getBoundingClientRect();
  const clientH = isDoc ? window.innerHeight : el.clientHeight;

  const visTop = Math.max(0, r.top);
  const visBottom = Math.min(window.innerHeight, r.top + clientH);

  return {
    scrollTop: isDoc ? window.scrollY : el.scrollTop,
    scrollLeft: isDoc ? window.scrollX : el.scrollLeft,
    scrollH: el.scrollHeight,
    scrollW: el.scrollWidth,
    viewportTopDoc: isDoc ? window.scrollY : visTop + window.scrollY,
    viewportLeftDoc: isDoc ? window.scrollX : r.left + window.scrollX,
    viewportH: Math.max(0, visBottom - visTop),
    viewportW: isDoc ? window.innerWidth : el.clientWidth,
    dpr,
  };
}

// 把滚动容器移到指定位置（横向 + 纵向）
function scrollToPosition(kind, top, left) {
  const SCROLLER = 'data-region-shot-scroller';
  const FRAME = 'data-region-shot-frame';
  const hasLeft = typeof left === 'number' && Number.isFinite(left);

  if (kind === 'iframe') {
    const f = document.querySelector('[' + FRAME + ']');
    if (!f) return false;
    let d = null;
    try {
      d = f.contentDocument;
    } catch {
      return false;
    }
    const se = d && (d.scrollingElement || d.documentElement);
    if (!se) return false;
    if (hasLeft) se.scrollLeft = left;
    se.scrollTop = top;
    return true;
  }

  const el =
    kind === 'doc'
      ? document.scrollingElement || document.documentElement
      : document.querySelector('[' + SCROLLER + ']');

  if (!el) return false;
  if (hasLeft) el.scrollLeft = left;
  el.scrollTop = top;
  return true;
}

// 等两帧渲染，避免截到滚动过程中的中间状态
function waitFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  });
}

// 截图期间隐藏 fixed / sticky 元素
//
// 每屏的裁剪区从视口顶部开始，吸顶的导航栏会被完整拍进每一屏：既在长图里
// 重复出现，又把它盖住的正文一起抹掉。截图期间设为 hidden（不影响布局），
// 截完恢复原值。
function hideFloating(kind) {
  const FRAME = 'data-region-shot-frame';
  const docs = [document];
  if (kind === 'iframe') {
    const f = document.querySelector('[' + FRAME + ']');
    try {
      if (f && f.contentDocument) docs.push(f.contentDocument);
    } catch {
      /* 跨域 iframe 拿不到 */
    }
  }

  let n = 0;
  for (const d of docs) {
    const win = d.defaultView || window;
    let all;
    try {
      all = d.querySelectorAll('*');
    } catch {
      continue;
    }
    for (const el of all) {
      if (el.hasAttribute('data-region-shot-float')) continue;
      let pos = '';
      try {
        pos = win.getComputedStyle(el).position;
      } catch {
        continue;
      }
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      el.setAttribute('data-region-shot-float', el.style.getPropertyValue('visibility'));
      el.style.setProperty('visibility', 'hidden', 'important');
      n++;
    }
  }
  return n;
}

function restoreFloating(kind) {
  const FRAME = 'data-region-shot-frame';
  const docs = [document];
  if (kind === 'iframe') {
    const f = document.querySelector('[' + FRAME + ']');
    try {
      if (f && f.contentDocument) docs.push(f.contentDocument);
    } catch {
      /* 跨域 iframe 拿不到 */
    }
  }

  let n = 0;
  for (const d of docs) {
    d.querySelectorAll('[data-region-shot-float]').forEach((el) => {
      const v = el.getAttribute('data-region-shot-float');
      if (v) el.style.setProperty('visibility', v, 'important');
      else el.style.removeProperty('visibility');
      el.removeAttribute('data-region-shot-float');
      n++;
    });
  }
  return n;
}

function clearMark() {
  document
    .querySelectorAll('[data-region-shot-scroller]')
    .forEach((e) => e.removeAttribute('data-region-shot-scroller'));
  document
    .querySelectorAll('[data-region-shot-frame]')
    .forEach((e) => e.removeAttribute('data-region-shot-frame'));
  return true;
}

function selectionOverlay(ver) {
  return new Promise((resolve) => {
    const ID = '__region_shot_overlay__';
    const MARK = 'data-region-shot-scroller';
    const FRAME_MARK = 'data-region-shot-frame';

    document.getElementById(ID)?.remove();
    document
      .querySelectorAll('[' + MARK + ']')
      .forEach((e) => e.removeAttribute(MARK));
    document
      .querySelectorAll('[' + FRAME_MARK + ']')
      .forEach((e) => e.removeAttribute(FRAME_MARK));

    const dpr = window.devicePixelRatio || 1;
    const prevCursor = document.body ? document.body.style.cursor : '';
    let settled = false;
    let target = null; // { kind, el?, frame?, doc? }

    // ---- 探测鼠标下方真正在滚动的东西 ----
    // 返回 { kind: 'doc' | 'element' | 'iframe' }
    const isScrollable = (el) => {
      const cs = getComputedStyle(el);
      return (
        /(auto|scroll|overlay)/.test(cs.overflowY) &&
        el.scrollHeight - el.clientHeight > 8
      );
    };

    const findTargetAt = (x, y) => {
      const stack = document.elementsFromPoint(x, y);
      for (const start of stack) {
        if (start.id === ID || start.closest('#' + ID)) continue;

        // 很多文档站把正文塞在同源 iframe 里，外层页面其实不滚
        if (start.tagName === 'IFRAME') {
          try {
            const d = start.contentDocument;
            const se = d && (d.scrollingElement || d.documentElement);
            if (se && se.scrollHeight - se.clientHeight > 8) {
              return { kind: 'iframe', frame: start, doc: d };
            }
          } catch {
            /* 跨域 iframe 无法访问，退化成整页截图 */
          }
          return { kind: 'doc' };
        }

        let el = start;
        while (el && el !== document.documentElement) {
          if (isScrollable(el)) return { kind: 'element', el };
          el = el.parentElement;
        }
        break; // 只看最上层的非遮罩元素
      }
      return { kind: 'doc' };
    };

    // 屏幕坐标 → 目标滚动容器的内容坐标
    const contentPoint = (clientX, clientY) => {
      const t = target;
      if (t && t.kind === 'iframe') {
        const r = t.frame.getBoundingClientRect();
        const se = t.doc.scrollingElement || t.doc.documentElement;
        return { x: clientX - r.left + se.scrollLeft, y: clientY - r.top + se.scrollTop };
      }
      if (t && t.kind === 'element') {
        const r = t.el.getBoundingClientRect();
        return { x: clientX - r.left + t.el.scrollLeft, y: clientY - r.top + t.el.scrollTop };
      }
      return { x: clientX + window.scrollX, y: clientY + window.scrollY };
    };

    // 读取目标容器当前的滚动位置
    const readScroll = () => {
      const t = target;
      if (t && t.kind === 'iframe') {
        const se = t.doc.scrollingElement || t.doc.documentElement;
        return { x: se.scrollLeft, y: se.scrollTop };
      }
      if (t && t.kind === 'element') {
        return { x: t.el.scrollLeft, y: t.el.scrollTop };
      }
      return { x: window.scrollX, y: window.scrollY };
    };

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
    tip.textContent = ver + ' · 第一步：拖拽确定起点和范围';
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

    // 选区右下角实时尺寸读数：第二阶段选框顶部会滚出视口，没有这个看不出选了多少。
    // 固定宽度，避免滚动时读 offsetWidth 触发重排（见 placeConfirm）
    const info = document.createElement('div');
    info.style.cssText = [
      'position:fixed',
      'right:24px',
      'bottom:76px',
      'z-index:2147483646',
      'width:128px',
      'box-sizing:border-box',
      'text-align:center',
      'padding:6px 12px',
      'background:rgba(17,24,39,0.92)',
      'color:#fff',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
      'border-radius:6px',
      'pointer-events:none',
      'white-space:nowrap',
      'display:none',
    ].join(';');

    document.documentElement.append(root, box, tip, info);
    if (document.body) document.body.style.cursor = 'crosshair';

    // 0 = 待机, 1 = 拖拽中, 2 = 调整结束位置
    let phase = 0;
    let startContentX = 0;
    let startContentY = 0;
    let fixedWidth = 0;
    let fixedHeight = 0;
    let anchorEndX = 0; // 进入第二阶段时的选区右下角（内容坐标）
    let anchorEndY = 0;
    let baseScrollX = 0; // 进入第二阶段时的滚动位置，用来算滚动增量
    let baseScrollY = 0;
    let lastClientX = 0;
    let lastClientY = 0;
    let current = { x: 0, y: 0, w: 0, h: 0 };
    let autoTimer = null;
    let confirmBtn = null;
    let btnBox = { w: 0, h: 0 }; // 按钮尺寸测量一次缓存，滚动时不再读布局
    let scrollRaf = 0;
    let phaseAt = 0;

    // 完成按钮和尺寸读数贴着选区右下角走；选区滚出视口时 clamp 到视口边缘，
    // 保证按钮永远点得到，又不会离用户正在看的地方太远。
    //
    // 注意：这里不能每帧读 offsetWidth。滚动事件每帧都会走到这里，读布局 + 写样式
    // 来回切换会造成 layout thrashing，长页面上滚动手感会垮掉。按钮尺寸测量一次就缓存，
    // 尺寸读数用固定宽度（文字是数字，宽度稳定）。
    const INFO_W = 128;
    const placeConfirm = (sx, sy) => {
      const GAP = 10;
      const EDGE = 8;
      const RIGHT_PAD = 24; // 给右侧滚动条留位置，否则拖滚动条会点到按钮
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (confirmBtn) {
        const btnW = btnBox.w;
        const btnH = btnBox.h;
        let left = sx + current.w + GAP;
        let top = sy + current.h + GAP;
        // 外侧放不下就挪到选区内侧，避免被视口裁掉
        if (left + btnW > vw - RIGHT_PAD) left = sx + current.w - btnW - GAP;
        if (top + btnH > vh - EDGE) top = sy + current.h - btnH - GAP;
        left = Math.max(EDGE, Math.min(left, vw - btnW - RIGHT_PAD));
        top = Math.max(EDGE, Math.min(top, vh - btnH - EDGE));
        Object.assign(confirmBtn.style, {
          left: `${left}px`,
          top: `${top}px`,
          right: 'auto',
          bottom: 'auto',
        });
      }

      if (info.style.display === 'block') {
        const infoH = 30; // padding 6×2 + 13px 行高，固定值，不读布局
        let left = sx + current.w - INFO_W;
        let top = sy + current.h + GAP;
        if (confirmBtn) top = (parseFloat(confirmBtn.style.top) || 0) - infoH - 8;
        left = Math.max(EDGE, Math.min(left, vw - INFO_W - RIGHT_PAD));
        top = Math.max(EDGE, Math.min(top, vh - infoH - EDGE));
        Object.assign(info.style, {
          left: `${left}px`,
          top: `${top}px`,
          right: 'auto',
          bottom: 'auto',
        });
      }
    };

    // 选框用 fixed + 屏幕坐标绘制（目标滚动时由 update 负责重算）
    const paint = () => {
      const t = target;
      let sx;
      let sy;
      if (t && t.kind === 'iframe') {
        const r = t.frame.getBoundingClientRect();
        const se = t.doc.scrollingElement || t.doc.documentElement;
        sx = current.x - se.scrollLeft + r.left;
        sy = current.y - se.scrollTop + r.top;
      } else if (t && t.kind === 'element') {
        const r = t.el.getBoundingClientRect();
        sx = current.x - t.el.scrollLeft + r.left;
        sy = current.y - t.el.scrollTop + r.top;
      } else {
        sx = current.x - window.scrollX;
        sy = current.y - window.scrollY;
      }
      Object.assign(box.style, {
        display: 'block',
        left: `${sx}px`,
        top: `${sy}px`,
        width: `${current.w}px`,
        height: `${current.h}px`,
      });
      if (current.w >= 1 && current.h >= 1) {
        info.style.display = 'block';
        info.textContent = `${Math.round(current.w)} × ${Math.round(current.h)} px`;
      }
      placeConfirm(sx, sy);
    };

    const updateDragging = (clientX, clientY) => {
      const cur = contentPoint(clientX, clientY);
      current = {
        x: Math.min(startContentX, cur.x),
        y: Math.min(startContentY, cur.y),
        w: Math.abs(cur.x - startContentX),
        h: Math.abs(cur.y - startContentY),
      };
      paint();
    };

    // 第二阶段：起点和框选尺寸固定，右下角只跟滚动走。
    // 这里刻意不读鼠标位置——按钮贴在选区右下角，如果选区跟着鼠标跑，
    // 鼠标一靠近按钮选区就把按钮推走，永远点不中。
    const updateAdjusting = () => {
      const s = readScroll();
      const endX = anchorEndX + (s.x - baseScrollX);
      const endY = anchorEndY + (s.y - baseScrollY);
      const left = Math.min(startContentX, endX);
      const right = Math.max(startContentX + fixedWidth, endX);
      const top = Math.min(startContentY, endY);
      const bottom = Math.max(startContentY + fixedHeight, endY);
      current = {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
      };
      paint();
    };

    const stopAuto = () => {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    };

    // 拖到视口四边时自动滚动（第一阶段用，支持横向和纵向）
    const edgeScroll = (clientX, clientY) => {
      const EDGE = 60;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let dx = 0;
      let dy = 0;

      if (clientY > vh - EDGE) {
        dy = Math.max(4, Math.round((clientY - (vh - EDGE)) / 4));
      } else if (clientY < EDGE) {
        dy = -Math.max(4, Math.round((EDGE - clientY) / 4));
      }
      if (clientX > vw - EDGE) {
        dx = Math.max(4, Math.round((clientX - (vw - EDGE)) / 4));
      } else if (clientX < EDGE) {
        dx = -Math.max(4, Math.round((EDGE - clientX) / 4));
      }

      if (dx === 0 && dy === 0) {
        stopAuto();
        return;
      }

      if (!autoTimer) {
        autoTimer = setInterval(() => {
          const t = target;
          if (t && t.kind === 'iframe') {
            const se = t.doc.scrollingElement || t.doc.documentElement;
            se.scrollTop += dy;
            se.scrollLeft += dx;
          } else if (t && t.kind === 'element') {
            t.el.scrollTop += dy;
            t.el.scrollLeft += dx;
          } else {
            window.scrollBy(dx, dy);
          }
          if (phase === 1) updateDragging(lastClientX, lastClientY);
        }, 16);
      }
    };

    const cleanup = () => {
      stopAuto();
      root.remove();
      box.remove();
      tip.remove();
      info.remove();
      if (document.body) document.body.style.cursor = prevCursor;
      document.removeEventListener('keydown', onKey, true);
      root.removeEventListener('mousedown', onDown);
      root.removeEventListener('contextmenu', onContext);
      document.removeEventListener('mousedown', onAnyDown, true);
      document.removeEventListener('mouseup', onAnyUp, true);
      if (confirmBtn) {
        confirmBtn.remove();
        confirmBtn = null;
      }
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('scroll', onScroll, true);
      // iframe 内部的滚动事件不会冒泡到父页面，需要单独解绑
      if (target && target.kind === 'iframe') {
        try {
          target.doc.removeEventListener('scroll', onScroll, true);
        } catch {
          /* ignore */
        }
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!result) {
        resolve(null);
        return;
      }

      let scrollStart = 0;
      let scrollStartX = 0;
      try {
        const t = target;
        if (t && t.kind === 'iframe') {
          const se = t.doc.scrollingElement || t.doc.documentElement;
          scrollStart = se.scrollTop;
          scrollStartX = se.scrollLeft;
        } else if (t && t.kind === 'element') {
          scrollStart = t.el.scrollTop;
          scrollStartX = t.el.scrollLeft;
        } else {
          scrollStart = window.scrollY;
          scrollStartX = window.scrollX;
        }
      } catch {
        /* ignore */
      }

      resolve({ ...result, kind: target ? target.kind : 'doc', scrollStart, scrollStartX });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    };

    const doConfirm = () => {
      if (settled) return;
      if (current.w >= 4 && current.h >= 4) {
        finish({ x: current.x, y: current.y, w: current.w, h: current.h, dpr });
      } else {
        finish(null);
      }
    };

    const onDown = (e) => {
      if (e.button !== 0) return;

      if (phase === 2) {
        doConfirm();
        return;
      }
      e.preventDefault();
      if (phase !== 0) return;

      // 在按下的位置探测真正在滚动的目标
      target = findTargetAt(e.clientX, e.clientY);
      try {
        if (target.kind === 'element') {
          target.el.setAttribute(MARK, '1');
        } else if (target.kind === 'iframe') {
          target.frame.setAttribute(FRAME_MARK, '1');
          // iframe 内部的 scroll 不会冒泡到父页面，得单独监听
          target.doc.addEventListener('scroll', onScroll, true);
        }
      } catch {
        /* ignore */
      }

      phase = 1;
      const p = contentPoint(e.clientX, e.clientY);
      startContentX = p.x;
      startContentY = p.y;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      current = { x: startContentX, y: startContentY, w: 0, h: 0 };
      paint();
    };

    const onMove = (e) => {
      lastClientX = e.clientX;
      lastClientY = e.clientY;

      if (phase === 1) {
        updateDragging(e.clientX, e.clientY);
        edgeScroll(e.clientX, e.clientY);
      }
      // 第二阶段不响应鼠标移动：选区只跟滚动延伸，见 updateAdjusting
    };

    // 第二阶段：按下时只记录位置，不拦默认行为——否则拖滚动条、拖页面、
    // 选中文字都会被当成「点任意位置确认」，用户会觉得页面拖不动。
    // 是否是"点击确认"留到松手时按位移判断。
    let pressX = 0;
    let pressY = 0;
    let pressed = false;

    const onAnyDown = (e) => {
      if (phase !== 2) return;
      pressed = true;
      pressX = e.clientX;
      pressY = e.clientY;
    };

    const onAnyUp = (e) => {
      if (phase !== 2 || !pressed) return;
      pressed = false;
      if (Date.now() - phaseAt < 200) return;
      // 右侧滚动条区域交给浏览器，别把拖动滚动条当成确认
      if (e.clientX > window.innerWidth - 24) return;
      // 拖动超过 6px 就不是点击，不确认
      if (Math.abs(e.clientX - pressX) > 6 || Math.abs(e.clientY - pressY) > 6) return;
      e.preventDefault();
      e.stopPropagation();
      doConfirm();
    };

    // 滚动时刷新选框（容器滚动也要跟着走）。
    // 用 rAF 合并：惯性滚动一帧可能触发好几次 scroll，每次都重排会拖垮手感。
    const onScroll = () => {
      if (phase === 1) {
        updateDragging(lastClientX, lastClientY);
        return;
      }
      if (phase !== 2 || scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (phase === 2) updateAdjusting();
      });
    };

    const onUp = (e) => {
      if (phase !== 1) return;
      stopAuto();
      updateDragging(e.clientX, e.clientY);

      if (current.w < 4 || current.h < 4) {
        finish(null);
        return;
      }

      // 进入第二阶段：宽度和起点固定，底部随鼠标/滚动延伸
      phase = 2;
      phaseAt = Date.now();
      fixedWidth = current.w;
      fixedHeight = current.h;
      startContentX = current.x;
      startContentY = current.y;
      anchorEndX = current.x + current.w;
      anchorEndY = current.y + current.h;
      const s0 = readScroll();
      baseScrollX = s0.x;
      baseScrollY = s0.y;
      box.style.borderColor = '#10b981';
      root.style.background = 'rgba(0,0,0,0.06)';
      tip.textContent = ver + ' · 第二步：上下或左右滚动到结束位置，点「完成截图」或页面任意位置 · Esc 取消';

      root.style.pointerEvents = 'none';

      confirmBtn = document.createElement('div');
      confirmBtn.textContent = '✓ 完成截图';
      confirmBtn.style.cssText = [
        'position:fixed',
        'right:24px',
        'bottom:24px',
        'z-index:2147483647',
        'padding:10px 18px',
        'background:#10b981',
        'color:#fff',
        'font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
        'border-radius:8px',
        'cursor:pointer',
        'box-shadow:0 4px 16px rgba(0,0,0,.25)',
        'pointer-events:auto',
        'user-select:none',
        '-webkit-user-select:none',
      ].join(';');
      confirmBtn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        doConfirm();
      });
      document.documentElement.appendChild(confirmBtn);
      btnBox = { w: confirmBtn.offsetWidth, h: confirmBtn.offsetHeight };
      paint(); // 让按钮立刻贴到选区右下角，而不是先停在视口角上

      // 延迟一个事件循环再挂确认监听：松手后浏览器会补发一次 click，
      // 同步注册会把那次残留事件当成确认
      setTimeout(() => {
        if (settled || phase !== 2) return;
        document.addEventListener('mousedown', onAnyDown, true);
        document.addEventListener('mouseup', onAnyUp, true);
      }, 0);
    };

    const onContext = (e) => {
      e.preventDefault();
      finish(null);
    };

    const onBlur = () => {
      if (phase === 1) finish(null);
    };

    document.addEventListener('keydown', onKey, true);
    root.addEventListener('mousedown', onDown);
    root.addEventListener('contextmenu', onContext);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('scroll', onScroll, true);
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
