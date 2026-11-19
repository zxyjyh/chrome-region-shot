// Region Shot · 标注编辑器
//
// 数据流：background 拼接完成后把 PNG 写进 IndexedDB（扩展 origin 下 service worker
// 与扩展页面共享同一份），用一次性的 id 打开本页；本页读出来立刻删除记录。
//
// 标注全部按「原图像素坐标」保存：显示时按 zoom 缩放重绘，导出时按原尺寸重绘，
// 所以画布上看到的位置和导出的位置一致，跟窗口大小、缩放比例无关。

'use strict';

const SHOT_DB = 'region-shot';
const SHOT_STORE = 'shots';

const MAX_VIEW_PIXELS = 40e6; // 显示画布的总像素上限，超大图降 dpr 而不是卡死
const LINE_HEIGHT = 1.25; // 文字行高倍数，显示与导出一致
const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

const COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#111827'];

// 工具 → 底部提示文案的 key（文案在 i18n.js）
const HINT_KEYS = { text: 'hintText', arrow: 'hintArrow', rect: 'hintRect', select: 'hintSelect' };

const params = new URLSearchParams(location.search);
const shotId = params.get('id');
const filename = params.get('name') || `region-${stamp()}.png`;

const stageWrap = document.getElementById('stageWrap');
const view = document.getElementById('view');
const input = document.getElementById('input');
const hint = document.getElementById('hint');
const statusEl = document.getElementById('status');
const sizeInput = document.getElementById('size');
const sizeVal = document.getElementById('sizeVal');
const zoomVal = document.getElementById('zoomVal');
const saveBtn = document.getElementById('save');
const copyBtn = document.getElementById('copy');
const delBtn = document.getElementById('del');
const undoBtn = document.getElementById('undo');

let bmp = null;
let zoom = 1;
let autoFit = true;
let tool = 'text';
let color = COLORS[0];
let size = 32;
let marks = [];
let history = [];
let selected = null;
let drag = null;
let editing = null;
let measureCtx = null;
let raf = 0;

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async () => {
  buildPalette();
  bindUI();
  setTool('text');

  try {
    const blob = await readShot(shotId);
    if (!blob) throw new Error(tr('loadFailed'));
    bmp = await createImageBitmap(blob);
  } catch (e) {
    fail(e.message || String(e));
    return;
  }

  measureCtx = document.createElement('canvas').getContext('2d');

  // 默认字号跟着图宽走，让不同分辨率下的标注视觉大小一致
  size = clamp(Math.round(bmp.width / 28), 18, 64);
  sizeInput.value = size;
  sizeVal.textContent = size;

  fitWidth();
  document.body.dataset.ready = '1';
})();

function fail(msg) {
  statusEl.classList.add('err');
  hint.textContent = msg;
  saveBtn.disabled = true;
  console.error('[RegionShot 标注]', msg);
}

function openDB() {
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

async function readShot(key) {
  if (!key) return null;
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      // 读完就删：这份原图只在交接时用一次，没理由留在本地
      const tx = db.transaction(SHOT_STORE, 'readwrite');
      const store = tx.objectStore(SHOT_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const v = req.result;
        store.delete(key);
        resolve(v || null);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  if (!bmp) return;

  const w = Math.max(1, Math.round(bmp.width * zoom));
  const h = Math.max(1, Math.round(bmp.height * zoom));

  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const area = w * dpr * h * dpr;
  if (area > MAX_VIEW_PIXELS) dpr = Math.max(1, dpr * Math.sqrt(MAX_VIEW_PIXELS / area));

  const cw = Math.max(1, Math.round(w * dpr));
  const ch = Math.max(1, Math.round(h * dpr));
  if (view.width !== cw || view.height !== ch) {
    view.width = cw;
    view.height = ch;
  }
  view.style.width = w + 'px';
  view.style.height = h + 'px';

  const ctx = view.getContext('2d');
  ctx.setTransform(cw / bmp.width, 0, 0, ch / bmp.height, 0, 0);
  ctx.clearRect(0, 0, bmp.width, bmp.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0);
  drawMarks(ctx, marks, true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  updateButtons();
}

function requestRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    render();
  });
}

function drawMarks(ctx, list, withSelection) {
  for (const m of list) {
    if (m.type === 'text') drawText(ctx, m);
    else if (m.type === 'arrow') drawArrow(ctx, m);
    else if (m.type === 'rect') drawRect(ctx, m);
  }
  if (withSelection && selected && list.includes(selected)) drawSelection(ctx, selected);
}

function drawText(ctx, m) {
  const lines = String(m.text).split('\n');
  const lh = m.size * LINE_HEIGHT;
  ctx.save();
  ctx.font = fontOf(m.size);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // 描边让文字在任何底色上都读得出来；描边颜色按文字亮度反着取
  ctx.lineWidth = Math.max(2, m.size / 7);
  ctx.strokeStyle = outlineFor(m.color);
  ctx.fillStyle = m.color;
  lines.forEach((line, i) => {
    if (!line) return;
    ctx.strokeText(line, m.x, m.y + i * lh);
    ctx.fillText(line, m.x, m.y + i * lh);
  });
  ctx.restore();
}

function drawArrow(ctx, m) {
  const lw = Math.max(2, m.size);
  const ang = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
  const head = Math.max(lw * 4, 14);
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(m.x1, m.y1);
  ctx.lineTo(m.x2 - Math.cos(ang) * head * 0.75, m.y2 - Math.sin(ang) * head * 0.75);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(m.x2, m.y2);
  ctx.lineTo(m.x2 - Math.cos(ang - 0.42) * head, m.y2 - Math.sin(ang - 0.42) * head);
  ctx.lineTo(m.x2 - Math.cos(ang + 0.42) * head, m.y2 - Math.sin(ang + 0.42) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawRect(ctx, m) {
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.lineWidth = Math.max(2, m.size);
  ctx.lineJoin = 'miter';
  ctx.strokeRect(
    Math.min(m.x1, m.x2),
    Math.min(m.y1, m.y2),
    Math.abs(m.x2 - m.x1),
    Math.abs(m.y2 - m.y1)
  );
  ctx.restore();
}

function drawSelection(ctx, m) {
  const b = boundsOf(m);
  const pad = Math.max(6, m.size * 0.35);
  // 线宽和虚线按 1/zoom 反算，屏幕上永远是几个像素
  const unit = 1 / Math.max(zoom, 0.001);
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = Math.max(1, 2 * unit);
  ctx.setLineDash([8 * unit, 5 * unit]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.restore();
}

function boundsOf(m) {
  if (m.type === 'text') {
    measureCtx.font = fontOf(m.size);
    const lines = String(m.text).split('\n');
    let w = 0;
    for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
    return {
      x: m.x,
      y: m.y,
      w: Math.max(w, m.size * 0.6),
      h: lines.length * m.size * LINE_HEIGHT,
    };
  }
  return {
    x: Math.min(m.x1, m.x2),
    y: Math.min(m.y1, m.y2),
    w: Math.abs(m.x2 - m.x1),
    h: Math.abs(m.y2 - m.y1),
  };
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function bindUI() {
  view.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onKey);
  view.addEventListener('dblclick', onDblClick);

  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      commitInput(false);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      commitInput(true);
    }
    ev.stopPropagation();
  });
  input.addEventListener('input', autoGrow);
  input.addEventListener('blur', () => {
    if (editing) commitInput(false);
  });

  // 字号滑块：选中的文字实时跟着变，一次调节只留一条撤销记录
  let sizeSnapshot = null;
  sizeInput.addEventListener('focus', () => {
    sizeSnapshot = selected && selected.type === 'text' ? JSON.stringify(marks) : null;
  });
  sizeInput.addEventListener('input', () => {
    size = Number(sizeInput.value);
    sizeVal.textContent = size;
    if (selected && selected.type === 'text') {
      selected.size = size;
      requestRender();
    }
  });
  sizeInput.addEventListener('change', () => {
    if (sizeSnapshot && JSON.stringify(marks) !== sizeSnapshot) history.push(sizeSnapshot);
    sizeSnapshot = null;
    requestRender();
  });

  undoBtn.addEventListener('click', undo);
  delBtn.addEventListener('click', deleteSelected);
  document.getElementById('save').addEventListener('click', save);
  copyBtn.addEventListener('click', copyImage);

  // 语言切换：立即重绘静态文案，并同步当前工具提示与按钮状态
  const langSel = document.getElementById('lang');
  if (langSel) {
    langSel.addEventListener('change', () => {
      i18nSetMode(langSel.value);
      i18nApply();
      statusEl.classList.remove('err');
      hint.textContent = tr(HINT_KEYS[tool] || 'hintText');
      if (!saveBtn.disabled) saveBtn.textContent = tr('savePng');
      if (!copyBtn.disabled) copyBtn.textContent = tr('copy');
    });
  }
  document.getElementById('cancel').addEventListener('click', closeTab);
  document.getElementById('zoomIn').addEventListener('click', () => setZoom(zoom * 1.25));
  document.getElementById('zoomOut').addEventListener('click', () => setZoom(zoom / 1.25));
  document.getElementById('fit').addEventListener('click', fitWidth);

  window.addEventListener('resize', () => {
    if (autoFit) fitWidth();
  });
}

function onDown(ev) {
  if (!bmp || ev.button !== 0) return;
  if (editing) {
    commitInput(false);
    return;
  }
  ev.preventDefault();
  try {
    view.setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }

  const p = toImage(ev);
  const hit = hitTest(p);

  if (hit) {
    selected = hit;
    drag = {
      kind: 'move',
      mark: hit,
      snapshot: JSON.stringify(marks),
      dx: p.x - anchorX(hit),
      dy: p.y - anchorY(hit),
    };
    requestRender();
    return;
  }

  selected = null;

  if (tool === 'text') {
    openInput(p);
    requestRender();
    return;
  }
  if (tool === 'select') {
    requestRender();
    return;
  }

  pushHistory();
  const m = {
    type: tool,
    x1: p.x,
    y1: p.y,
    x2: p.x,
    y2: p.y,
    color,
    size: Math.max(2, size / 8), // 箭头/矩形的 size 是线宽，文字的 size 是字号
  };
  marks.push(m);
  selected = m;
  drag = { kind: 'create', mark: m };
  requestRender();
}

function onMove(ev) {
  if (!drag) return;
  const p = toImage(ev);
  const m = drag.mark;

  if (drag.kind === 'move') {
    moveMarkTo(m, p.x - drag.dx, p.y - drag.dy);
  } else {
    m.x2 = p.x;
    m.y2 = p.y;
  }
  requestRender();
}

function onUp(ev) {
  if (!drag) return;
  const d = drag;
  drag = null;
  try {
    view.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }

  if (d.kind === 'move') {
    // 只在真的移动过时才留一步历史，避免「点一下」也占一次撤销
    if (JSON.stringify(marks) !== d.snapshot) history.push(d.snapshot);
  } else {
    const m = d.mark;
    const tiny =
      m.type === 'arrow'
        ? Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 6
        : Math.abs(m.x2 - m.x1) < 5 && Math.abs(m.y2 - m.y1) < 5;
    if (tiny) {
      // 只是点了一下没拖动，不留下空图形
      marks = marks.filter((x) => x !== m);
      selected = null;
      history.pop();
    }
  }
  trimHistory();
  render();
}

function onDblClick(ev) {
  if (!bmp) return;
  const hit = hitTest(toImage(ev));
  if (hit && hit.type === 'text') {
    ev.preventDefault();
    openEdit(hit);
  }
}

function onKey(ev) {
  if (document.activeElement === input) return;

  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && (ev.key === 'z' || ev.key === 'Z')) {
    ev.preventDefault();
    undo();
    return;
  }
  if (ev.key === 'Escape') {
    selected = null;
    render();
    return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if (selected) {
      ev.preventDefault();
      deleteSelected();
    }
    return;
  }
  if (mod) return;

  const k = ev.key.toLowerCase();
  if (k === 't') setTool('text');
  else if (k === 'a') setTool('arrow');
  else if (k === 'r') setTool('rect');
  else if (k === 'v') setTool('select');
}

function setTool(t) {
  tool = t;
  document
    .querySelectorAll('[data-tool]')
    .forEach((b) => b.classList.toggle('is-on', b.dataset.tool === t));
  hint.textContent = tr(HINT_KEYS[t] || 'hintText');
  view.style.cursor = t === 'select' ? 'default' : 'crosshair';
}

// ---------------------------------------------------------------------------
// 文字输入
// ---------------------------------------------------------------------------

function openInput(p) {
  editing = { mode: 'new', x: p.x, y: p.y };
  showInput({ x: p.x, y: p.y, text: '', color, size });
}

function openEdit(m) {
  editing = { mode: 'edit', mark: m };
  showInput(m);
}

function showInput(m) {
  const fs = Math.max(13, m.size * zoom);
  input.value = m.text || '';
  input.style.display = 'block';
  input.style.left = m.x * zoom + 'px';
  input.style.top = m.y * zoom + 'px';
  input.style.fontSize = fs + 'px';
  input.style.color = m.color || color;
  input.style.width =
    Math.min(Math.max(160, (bmp.width - m.x) * zoom), Math.max(240, stageWrap.clientWidth * 0.5)) +
    'px';
  autoGrow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
}

function commitInput(cancel) {
  const e = editing;
  if (!e) return;
  editing = null;
  input.style.display = 'none';

  const text = input.value.trim();
  if (cancel) {
    render();
    return;
  }

  if (e.mode === 'new') {
    if (text) {
      pushHistory();
      const m = { type: 'text', x: e.x, y: e.y, text, color, size };
      marks.push(m);
      selected = m;
    }
  } else {
    const m = e.mark;
    if (!text) {
      if (marks.includes(m)) {
        pushHistory();
        marks = marks.filter((x) => x !== m);
        selected = null;
      }
    } else if (m.text !== text) {
      pushHistory();
      m.text = text;
      selected = m;
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// 命中测试 / 拖动
// ---------------------------------------------------------------------------

function hitTest(p) {
  // 容差按屏幕像素反算：长图缩到 10% 时，原图 7px 在屏幕上只剩 0.7px，根本点不中
  const screenPad = 7 / Math.max(zoom, 0.001);

  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    const tol = Math.max(screenPad, m.size * 1.5);

    if (m.type === 'text') {
      const b = boundsOf(m);
      const pad = Math.max(screenPad, m.size * 0.35);
      if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
        return m;
      }
    } else if (m.type === 'arrow') {
      if (distToSegment(p, { x: m.x1, y: m.y1 }, { x: m.x2, y: m.y2 }) <= tol) return m;
    } else if (rectBorderDistance(p, m) <= tol) {
      return m;
    }
  }
  return null;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rectBorderDistance(p, m) {
  const x1 = Math.min(m.x1, m.x2);
  const x2 = Math.max(m.x1, m.x2);
  const y1 = Math.min(m.y1, m.y2);
  const y2 = Math.max(m.y1, m.y2);
  const dist = (a, b) => distToSegment(p, a, b);
  return Math.min(
    dist({ x: x1, y: y1 }, { x: x2, y: y1 }),
    dist({ x: x2, y: y1 }, { x: x2, y: y2 }),
    dist({ x: x2, y: y2 }, { x: x1, y: y2 }),
    dist({ x: x1, y: y2 }, { x: x1, y: y1 })
  );
}

function anchorX(m) {
  return m.type === 'text' ? m.x : m.x1;
}

function anchorY(m) {
  return m.type === 'text' ? m.y : m.y1;
}

function moveMarkTo(m, nx, ny) {
  if (m.type === 'text') {
    m.x = clamp(nx, 0, bmp.width - 10);
    m.y = clamp(ny, 0, bmp.height - 10);
    return;
  }
  const dx = nx - m.x1;
  const dy = ny - m.y1;
  m.x1 += dx;
  m.y1 += dy;
  m.x2 += dx;
  m.y2 += dy;
}

// ---------------------------------------------------------------------------
// 历史 / 删除
// ---------------------------------------------------------------------------

function pushHistory() {
  history.push(JSON.stringify(marks));
  trimHistory();
}

function trimHistory() {
  while (history.length > 60) history.shift();
}

function undo() {
  if (!history.length) return;
  marks = JSON.parse(history.pop());
  selected = null;
  render();
}

function deleteSelected() {
  if (!selected) return;
  pushHistory();
  marks = marks.filter((m) => m !== selected);
  selected = null;
  render();
}

function updateButtons() {
  undoBtn.disabled = history.length === 0;
  delBtn.disabled = !selected;
}

// ---------------------------------------------------------------------------
// 缩放
// ---------------------------------------------------------------------------

function fitWidth() {
  if (!bmp) return;
  const avail = Math.max(120, stageWrap.clientWidth - 48);
  zoom = clamp(avail / bmp.width, 0.02, 1);
  autoFit = true;
  render();
  updateZoom();
}

function setZoom(z) {
  zoom = clamp(z, 0.02, 2);
  autoFit = false;
  render();
  updateZoom();
}

function updateZoom() {
  zoomVal.textContent = Math.round(zoom * 100) + '%';
}

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

function buildPalette() {
  const box = document.getElementById('palette');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === color ? ' is-on' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      color = c;
      box.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('is-on', s === b));
      // 当前选中文字时直接换色，符合直觉
      if (selected && selected.type === 'text') {
        pushHistory();
        selected.color = c;
        render();
      }
    });
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

// 按原图尺寸重绘成品：画布上的 selection 虚线、缩放都不进成品
async function composeBlob() {
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  drawMarks(ctx, marks, false);

  try {
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null; // 超大图可能直接抛
  }
}

async function save() {
  if (!bmp) return;
  if (editing) commitInput(false);

  saveBtn.disabled = true;
  saveBtn.textContent = tr('exporting');

  const blob = await composeBlob();
  if (!blob) {
    saveBtn.disabled = false;
    saveBtn.textContent = tr('savePng');
    fail(tr('exportTooLarge'));
    return;
  }

  const result = await download(blob, filename);
  if (result === 'api') {
    closeTab();
    return;
  }
  if (result === 'anchor') {
    // 走 <a download> 时页面一关就会释放 blob URL，可能把正在进行的下载掐断，
    // 所以多留几秒再关
    setTimeout(closeTab, 4000);
    return;
  }
  saveBtn.disabled = false;
  saveBtn.textContent = tr('savePng');
  fail(tr('saveFailed'));
}

async function copyImage() {
  if (!bmp) return;
  if (editing) commitInput(false);

  copyBtn.disabled = true;
  copyBtn.textContent = tr('copying');

  const blob = await composeBlob();
  if (!blob) {
    copyBtn.disabled = false;
    copyBtn.textContent = tr('copy');
    fail(tr('exportTooLarge'));
    return;
  }

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch (e) {
    console.warn('[RegionShot 标注] 复制到剪贴板失败', e);
    copyBtn.disabled = false;
    copyBtn.textContent = tr('copy');
    fail(tr('copyFailed'));
    return;
  }

  // 不关标签页：用户接下来要去微信 / 钉钉里粘贴
  statusEl.classList.remove('err');
  hint.textContent = tr('copyHint');
  copyBtn.textContent = tr('copied');
  setTimeout(() => {
    copyBtn.textContent = tr('copy');
    copyBtn.disabled = false;
  }, 2000);
}

async function download(blob, name) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: name, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'api';
  } catch (e) {
    console.warn('[RegionShot 标注] downloads.download 失败，改用页面下载', e);
  }
  URL.revokeObjectURL(url);

  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(a.href);
    }, 60000);
    return 'anchor';
  } catch (e) {
    console.warn('[RegionShot 标注] 页面下载也失败', e);
    return false;
  }
}

function closeTab() {
  try {
    chrome.tabs.getCurrent((t) => {
      if (t) chrome.tabs.remove(t.id);
      else window.close();
    });
  } catch {
    window.close();
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function toImage(ev) {
  const r = view.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
}

function fontOf(px) {
  return `600 ${px}px ${FONT_FAMILY}`;
}

function outlineFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'rgba(0,0,0,.55)';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.58 ? 'rgba(0,0,0,.6)' : 'rgba(255,255,255,.8)';
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
