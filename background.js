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

const MAX_TOTAL_DEVICE = 30000; // 最终画布的设备像素高度上限
const SCROLL_SETTLE_MS = 250; // 每屏滚动后等待渲染的时间

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
      sel = await execResult(tab.id, selectionOverlay);
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
  const contentH = geo0.scrollH;
  const totalH = Math.min(sel.h, contentH - sel.y, MAX_TOTAL_DEVICE / dpr);

  console.log('[RegionShot] 滚动参数', JSON.stringify({ sel, geo0, contentH, totalH }));

  if (totalH <= 1) throw new Error('选区没有有效高度（内容高度 ' + contentH + '，起点 ' + sel.y + '）');

  // 不用预计算分段：每屏能截多高取决于当下真实的视口高度，
  // 按「实际截到的高度」推进才能保证不漏内容
  const endY = Math.round(sel.y + totalH);
  let pos = Math.round(sel.y);
  let stage = null;
  let ctx = null;
  let drawn = 0;
  let i = 0;

  while (pos < endY && i++ < 500) {
    setBadge(tab.id, `${Math.min(99, Math.round(((pos - sel.y) / totalH) * 100))}%`);

    await execResult(tab.id, scrollToOffset, [sel.kind, pos]);
    await execResult(tab.id, waitFrames);
    await sleep(SCROLL_SETTLE_MS);

    const g = await execResult(tab.id, readGeo, [sel.kind]);
    if (!g) throw new Error('滚动容器消失了');

    // 实际滚动位置可能被 clamp（已经到底），据此修正这一屏从哪开始截
    const lead = Math.max(0, pos - g.scrollTop);
    const avail = g.viewportH - lead;
    const h = Math.min(endY - pos, avail);

    if (h <= 2) {
      console.warn('[RegionShot] 无法继续滚动，提前结束', {
        pos,
        scrollTop: g.scrollTop,
        viewportH: g.viewportH,
      });
      break;
    }

    // 内容坐标 → 文档坐标
    const dx = sel.x - g.scrollLeft;
    const xDoc = g.viewportLeftDoc + dx;
    const wDoc = Math.min(sel.w, g.viewportW - dx);

    if (wDoc <= 2) {
      console.warn('[RegionShot] 选区宽度越界', { sel, g });
      break;
    }

    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: xDoc,
        y: g.viewportTopDoc + lead,
        width: wDoc,
        height: h,
        // 坐标是 CSS 像素；Chrome 会自动按设备像素比输出，
        // 这里不能再乘 dpr，否则 Retina 屏上会被放大两次
        scale: 1,
      },
    });

    const bitmap = await createImageBitmap(dataUrlToBlob('data:image/png;base64,' + shot.data));

    if (!stage) {
      const scaleY = bitmap.height / h;
      const totalPx = Math.ceil(totalH * scaleY);
      stage = new OffscreenCanvas(bitmap.width, Math.min(totalPx, MAX_TOTAL_DEVICE));
      ctx = stage.getContext('2d');
    }

    // 这一屏实际覆盖的内容高度（正常情况下等于 h）
    let advance = h;
    try {
      const drawH = Math.min(bitmap.height, stage.height - drawn);
      if (drawH <= 0) break;
      ctx.drawImage(bitmap, 0, 0, bitmap.width, drawH, 0, drawn, bitmap.width, drawH);
      drawn += drawH;
      advance = h * (drawH / bitmap.height);
    } finally {
      bitmap.close();
    }

    pos += Math.round(advance);
    if (drawn >= stage.height) break;
  }

  if (!stage || drawn <= 0) throw new Error('没有可保存的内容');

  // 恢复页面原来的滚动位置
  try {
    await execResult(tab.id, scrollToOffset, [sel.kind, sel.scrollStart || 0]);
  } catch {
    /* ignore */
  }

  let finalCanvas = stage;
  if (drawn < stage.height) {
    finalCanvas = new OffscreenCanvas(stage.width, drawn);
    finalCanvas.getContext('2d').drawImage(stage, 0, 0);
  }

  const blob = await finalCanvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  await saveWithFallback(tab, dataUrl, `region-${stamp()}.png`);
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
    viewportTopDoc: isDoc ? window.scrollY : visTop + window.scrollY,
    viewportLeftDoc: isDoc ? window.scrollX : r.left + window.scrollX,
    viewportH: Math.max(0, visBottom - visTop),
    viewportW: isDoc ? window.innerWidth : el.clientWidth,
    dpr,
  };
}

// 把滚动容器移到指定位置
function scrollToOffset(kind, offset) {
  const SCROLLER = 'data-region-shot-scroller';
  const FRAME = 'data-region-shot-frame';

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
    se.scrollTop = offset;
    return true;
  }

  const el =
    kind === 'doc'
      ? document.scrollingElement || document.documentElement
      : document.querySelector('[' + SCROLLER + ']');

  if (!el) return false;
  el.scrollTop = offset;
  return true;
}

// 等两帧渲染，避免截到滚动过程中的中间状态
function waitFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  });
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

function selectionOverlay() {
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
    tip.textContent = 'v1.6.0 · 第一步：拖拽确定起点和宽度';
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

    // 右下角实时尺寸读数：第二阶段选框顶部会滚出视口，没有这个看不出选了多少
    const info = document.createElement('div');
    info.style.cssText = [
      'position:fixed',
      'right:24px',
      'bottom:76px',
      'z-index:2147483646',
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
    let lastClientX = 0;
    let lastClientY = 0;
    let current = { x: 0, y: 0, w: 0, h: 0 };
    let autoTimer = null;
    let confirmBtn = null;
    let phaseAt = 0;

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

    // 第二阶段：x 和顶部固定，底部跟随鼠标在容器内容中的位置（滚动时自动延伸）
    const updateAdjusting = (clientX, clientY) => {
      const cur = contentPoint(clientX, clientY);
      const top = Math.min(startContentY, cur.y);
      const bottom = Math.max(startContentY, cur.y);
      current = {
        x: startContentX,
        y: top,
        w: fixedWidth,
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

    // 拖到视口上下边缘时自动滚动（第一阶段用）
    const edgeScroll = (clientY) => {
      const EDGE = 60;
      const vh = window.innerHeight;
      let dy = 0;

      if (clientY > vh - EDGE) {
        dy = Math.max(4, Math.round((clientY - (vh - EDGE)) / 4));
      } else if (clientY < EDGE) {
        dy = -Math.max(4, Math.round((EDGE - clientY) / 4));
      }

      if (dy === 0) {
        stopAuto();
        return;
      }

      if (!autoTimer) {
        autoTimer = setInterval(() => {
          const t = target;
          if (t && t.kind === 'iframe') {
            const se = t.doc.scrollingElement || t.doc.documentElement;
            se.scrollTop += dy;
          } else if (t && t.kind === 'element') {
            t.el.scrollTop += dy;
          } else {
            window.scrollBy(0, dy);
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
      document.removeEventListener('mousedown', onConfirm, true);
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
      try {
        const t = target;
        if (t && t.kind === 'iframe') {
          const se = t.doc.scrollingElement || t.doc.documentElement;
          scrollStart = se.scrollTop;
        } else if (t && t.kind === 'element') {
          scrollStart = t.el.scrollTop;
        } else {
          scrollStart = window.scrollY;
        }
      } catch {
        /* ignore */
      }

      resolve({ ...result, kind: target ? target.kind : 'doc', scrollStart });
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
      e.preventDefault();

      if (phase === 2) {
        doConfirm();
        return;
      }
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
        edgeScroll(e.clientY);
      } else if (phase === 2) {
        updateAdjusting(e.clientX, e.clientY);
      }
    };

    // 第二阶段点击任意位置确认
    const onConfirm = (e) => {
      if (phase !== 2) return;
      if (Date.now() - phaseAt < 200) return;
      e.preventDefault();
      e.stopPropagation();
      doConfirm();
    };

    // 滚动时刷新选框（容器滚动也要跟着走）
    const onScroll = () => {
      if (phase === 1) updateDragging(lastClientX, lastClientY);
      else if (phase === 2) updateAdjusting(lastClientX, lastClientY);
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
      startContentX = current.x;
      startContentY = current.y;
      box.style.borderColor = '#10b981';
      root.style.background = 'rgba(0,0,0,0.06)';
      tip.textContent = 'v1.6.0 · 第二步：滚动到结束位置，点右下角「完成截图」或页面任意位置 · Esc 取消';

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

      // 延迟一个事件循环再挂确认监听：松手后浏览器会补发一次 click，
      // 同步注册会把那次残留事件当成确认
      setTimeout(() => {
        if (settled || phase !== 2) return;
        document.addEventListener('mousedown', onConfirm, true);
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
