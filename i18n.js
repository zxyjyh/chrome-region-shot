// Region Shot · 编辑页文案与语言切换
//
// 两层语言机制：
//   - manifest 的名称/描述、网页遮罩提示 → Chrome 标准 _locales + chrome.i18n，跟随浏览器语言
//   - 本页 → 这份语言包。默认跟随浏览器，用户也可以在下拉里手动指定；
//     偏好同时写入 localStorage（本页同步读取，避免闪烁）和 chrome.storage（框选阶段从那里读）。
'use strict';

const I18N = {
  zh_CN: {
    editorTitle: 'Region Shot · 标注',
    brandTitle: 'Region Shot 标注编辑器',
    brandTag: '标注',
    toolsAria: '标注工具',
    toolText: '文字',
    toolTextTitle: '文字（T）',
    toolArrow: '箭头',
    toolArrowTitle: '箭头（A）',
    toolRect: '矩形',
    toolRectTitle: '矩形（R）',
    toolSelect: '选择',
    toolSelectTitle: '选择并拖动（V）',
    paletteAria: '颜色',
    fontSize: '字号',
    undoTitle: '撤销（⌘Z）',
    delTitle: '删除选中（Delete）',
    cancel: '取消',
    copy: '复制图片',
    copyTitle: '复制到剪贴板，可直接粘贴到微信 / 钉钉',
    savePng: '✓ 保存 PNG',
    langTitle: '界面语言',
    langAuto: '自动',
    hintText: '点击图片任意位置添加文字 · 拖动可调整位置 · Delete 删除 · ⌘Z 撤销',
    hintArrow: '按住拖动画箭头 · Delete 删除选中',
    hintRect: '按住拖动画矩形 · Delete 删除选中',
    hintSelect: '点击标注选中，拖动调整位置 · Delete 删除 · ⌘Z 撤销',
    zoomOut: '缩小',
    zoomIn: '放大',
    fit: '适应宽度',
    exporting: '导出中…',
    exportTooLarge: '导出失败：图片过大，浏览器无法编码为 PNG',
    saveFailed: '保存失败，请重试',
    copying: '复制中…',
    copied: '✓ 已复制',
    copyHint: '已复制到剪贴板，去微信 / 钉钉里粘贴（⌘V / Ctrl+V）',
    copyFailed: '复制失败，请改用「✓ 保存 PNG」',
    loadFailed: '找不到截图数据（可能已被清理），请重新截图',
  },

  zh_TW: {
    editorTitle: 'Region Shot · 標註',
    brandTitle: 'Region Shot 標註編輯器',
    brandTag: '標註',
    toolsAria: '標註工具',
    toolText: '文字',
    toolTextTitle: '文字（T）',
    toolArrow: '箭頭',
    toolArrowTitle: '箭頭（A）',
    toolRect: '矩形',
    toolRectTitle: '矩形（R）',
    toolSelect: '選取',
    toolSelectTitle: '選取並拖動（V）',
    paletteAria: '顏色',
    fontSize: '字型大小',
    undoTitle: '復原（⌘Z）',
    delTitle: '刪除選取（Delete）',
    cancel: '取消',
    copy: '複製圖片',
    copyTitle: '複製到剪貼簿，可直接貼到微信 / 釘釘',
    savePng: '✓ 儲存 PNG',
    langTitle: '介面語言',
    langAuto: '自動',
    hintText: '點擊圖片任意位置加入文字 · 拖動可調整位置 · Delete 刪除 · ⌘Z 復原',
    hintArrow: '按住拖動畫箭頭 · Delete 刪除選取',
    hintRect: '按住拖動畫矩形 · Delete 刪除選取',
    hintSelect: '點擊標註選取，拖動調整位置 · Delete 刪除 · ⌘Z 復原',
    zoomOut: '縮小',
    zoomIn: '放大',
    fit: '符合寬度',
    exporting: '匯出中…',
    exportTooLarge: '匯出失敗：圖片過大，瀏覽器無法編碼為 PNG',
    saveFailed: '儲存失敗，請重試',
    copying: '複製中…',
    copied: '✓ 已複製',
    copyHint: '已複製到剪貼簿，到微信 / 釘釘裡貼上（⌘V / Ctrl+V）',
    copyFailed: '複製失敗，請改用「✓ 儲存 PNG」',
    loadFailed: '找不到截圖資料（可能已被清理），請重新截圖',
  },

  en: {
    editorTitle: 'Region Shot · Annotate',
    brandTitle: 'Region Shot annotation editor',
    brandTag: 'Annotate',
    toolsAria: 'Annotation tools',
    toolText: 'Text',
    toolTextTitle: 'Text (T)',
    toolArrow: 'Arrow',
    toolArrowTitle: 'Arrow (A)',
    toolRect: 'Rectangle',
    toolRectTitle: 'Rectangle (R)',
    toolSelect: 'Select',
    toolSelectTitle: 'Select and move (V)',
    paletteAria: 'Colors',
    fontSize: 'Font size',
    undoTitle: 'Undo (⌘Z)',
    delTitle: 'Delete selected (Delete)',
    cancel: 'Cancel',
    copy: 'Copy image',
    copyTitle: 'Copy to clipboard, then paste it into any app',
    savePng: '✓ Save PNG',
    langTitle: 'Interface language',
    langAuto: 'Auto',
    hintText: 'Click anywhere on the image to add text · Drag to reposition · Delete to remove · ⌘Z to undo',
    hintArrow: 'Drag to draw an arrow · Delete to remove the selection',
    hintRect: 'Drag to draw a rectangle · Delete to remove the selection',
    hintSelect: 'Click a mark to select it, drag to move · Delete to remove · ⌘Z to undo',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    fit: 'Fit width',
    exporting: 'Exporting…',
    exportTooLarge: 'Export failed: the image is too large for the browser to encode as PNG.',
    saveFailed: 'Save failed, please try again',
    copying: 'Copying…',
    copied: '✓ Copied',
    copyHint: 'Copied to clipboard. Paste it into WeChat, DingTalk, or any other app (⌘V / Ctrl+V).',
    copyFailed: 'Copy failed. Please use “✓ Save PNG” instead.',
    loadFailed: 'Screenshot data not found (it may have been cleaned up). Please capture again.',
  },
};

const I18N_LANG_KEY = 'regionShotLang'; // localStorage 与 chrome.storage 共用，只存语言偏好
const I18N_LEGACY_KEY = 'regionShotEditorLang'; // 1.8.0 用过的旧 key，读取时一次性兼容
const I18N_MODES = ['auto', 'zh_CN', 'zh_TW', 'en'];

let i18nMode = 'auto'; // auto | zh_CN | zh_TW | en
let i18nLang = 'zh_CN'; // 实际生效的语言

// 浏览器语言 → 三选一。zh-HK / zh-MO / zh-Hant 一律按繁体处理
function i18nDetect() {
  let ui = '';
  try {
    ui = String(chrome.i18n.getUILanguage() || '');
  } catch {
    /* 非扩展环境（比如直接用浏览器打开这个文件）*/
  }
  if (!ui) ui = navigator.language || 'en';
  ui = ui.toLowerCase().replace('_', '-');
  if (ui.startsWith('zh')) return /-(tw|hk|mo)|hant/.test(ui) ? 'zh_TW' : 'zh_CN';
  return 'en';
}

function tr(key) {
  const pack = I18N[i18nLang] || I18N.zh_CN;
  const val = pack[key] != null ? pack[key] : I18N.zh_CN[key];
  return val != null ? val : key;
}

function i18nSetMode(mode) {
  i18nMode = I18N_MODES.includes(mode) ? mode : 'auto';
  i18nLang = i18nMode === 'auto' ? i18nDetect() : i18nMode;
  try {
    localStorage.setItem(I18N_LANG_KEY, i18nMode);
  } catch {
    /* 隐私模式等场景下写不了，不影响本次使用 */
  }
  // 同一份偏好写进 chrome.storage，框选阶段（background）从那里读
  try {
    const p = chrome.storage.local.set({ [I18N_LANG_KEY]: i18nMode });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 非扩展环境忽略 */
  }
}

// 把 data-i18n / data-i18n-title / data-i18n-aria 应用到 DOM
function i18nApply() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = tr(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = tr(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', tr(el.dataset.i18nAria));
  });
  document.title = tr('editorTitle');
  document.documentElement.lang =
    i18nLang === 'zh_CN' ? 'zh-CN' : i18nLang === 'zh_TW' ? 'zh-TW' : 'en';
}

function i18nInit() {
  let stored = 'auto';
  try {
    stored =
      localStorage.getItem(I18N_LANG_KEY) ||
      localStorage.getItem(I18N_LEGACY_KEY) ||
      'auto';
  } catch {
    /* ignore */
  }
  i18nSetMode(stored);
  const sel = document.getElementById('lang');
  if (sel) sel.value = i18nMode;
  i18nApply();
}

i18nInit();
