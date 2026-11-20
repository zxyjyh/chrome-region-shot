# Chrome 应用商店上架材料

> 对应版本：`1.8.4`（三语界面 + 复制图片；1.8.4 选区改为跟随滚动、平滑补齐尾差）
> 更新日期：2026-11-20（初版 2026-11-17 对应 1.7.0；1.8.3 新增三语界面、复制图片；1.8.4 修复选区跳变）
> 配套文件：`privacy-policy.html`（隐私政策页面，需要托管到公网 URL）

---

## 0. 上架前必须先补的 3 件事

| # | 事项 | 说明 |
|---|---|---|
| 1 | **隐私政策公网 URL** | 商店后台的「Privacy policy」字段要求一个可公开访问的 https 地址，不接受本地文件。仓库已公开，把 `privacy-policy.html` 留在根目录，在 GitHub 仓库 Settings → Pages 选择 `main` / `(root)` 即可。启用后 URL 为 `https://zxyjyh.github.io/chrome-region-shot/privacy-policy.html`。 |
| 2 | ~~替换联系邮箱~~ | ✅ 已完成：`privacy-policy.html` 两处都已是 `xiaoyan.zhuxu@gmail.com`。 |
| 3 | **商店素材** | 128×128 图标已在 manifest 声明。商店截图要求 **1280×800（满版，1–5 张）**，已生成 5 张在 `store-assets/`；宣传图 440×280 与精选图 1400×560 是可选项。**注意：440×280 不是商店截图的规格。** |

---

## 1. 商店信息

### 名称
```
Region Shot · 区域截图
```

### 简短描述（说明字段，上限 132 字符，官方已验证）

> 上限出处：<https://developer.chrome.com/docs/webstore/prepare> — "A string of no more than 132 characters that describes your extension."（2026-11-19 抓取）
> 下面三条按「字符数」计的实测值：中文 57、繁體中文 58、English 120。

中文：
```
框选起点和范围，滚到结束位置，把跨多屏的网页区域拼成一张完整 PNG；可加文字、箭头、矩形，也能直接复制到剪贴板。
```

繁體中文：
```
框選起點與範圍，捲動到結束位置，把跨多屏的網頁區域拼成一張完整 PNG；可加文字、箭頭、矩形，也能直接複製到剪貼簿。
```

English:
```
Capture any long page region as a single PNG: pick an area, scroll to the end, annotate, then save or copy to clipboard.
```

### 详细描述（中文）

```
Region Shot 解决一个别的截图工具没解决的问题：你只想截网页里的某一块，但这一块比屏幕高。

常见做法有两种，都不好用——
截整页：图太长，上下全是你不要的页头页脚和侧边栏；
截可视区域：内容一多就截不全，得手动拼。

Region Shot 让你先框出要的那一列，再滚到结束位置，把中间所有内容一次截完，输出一张干净的 PNG。

怎么用

1. 在网页上点扩展图标，或按 Alt+Shift+S
2. 按住拖拽，确定截图区域的起点和范围（按住时拖到屏幕四边会自动滚动）
3. 松开后，用触摸板或滚轮滚动到想结束的位置。选区跟着滚动平滑延伸，不会自己跳动；滚到页面底部时，选区正好覆盖到内容底部，页面最后一段也能截到。选区旁实时显示当前尺寸
4. 点选区右下角的「✓ 完成截图」（或点页面任意位置）；按钮跟着选区走，滚到哪里都点得到
5. 截图完成后打开标注编辑器：加文字、箭头、矩形，可拖动、改颜色和字号，⌘Z 撤销
6. 点「✓ 保存 PNG」存到下载文件夹，或点「复制图片」直接粘贴到微信 / 钉钉等任意应用

框选阶段按 Esc 或点右键取消；编辑器里点「取消」或关掉标签页则不保存。

为触摸板设计

Mac 触摸板上「按住拖拽」和「两指滚动」没法同时做，所以定起点和定终点被拆成两个独立步骤。不需要一直按着，手可以松开。

界面支持简体中文、繁體中文、English

跟随浏览器语言自动选择，也可以在标注编辑器右上角用 🌐 手动切换；框选遮罩和编辑器用同一种语言。

能处理这些页面结构

- 普通整页滚动
- SPA 那种内部滚动容器（主内容区自己滚，页面本身不动）
- 正文塞在 iframe 里的文档站
- 比屏幕宽的页面：宽表格、横向画布、甘特图；选区同时横向和纵向延伸也能正确拼接

扩展会自动判断当前位置该跟随哪个滚动容器。

你需要知道的两件事

- 截图期间页面会自动滚动，顶部会出现 Chrome 的「正在调试此浏览器」提示条，结束后自动消失。这是跨屏拼接必须的，扩展只在截图期间附加调试器，结束立即断开。
- 截图过程全部在本机完成，不联网、不上传。拼接好的图只在扩展内部短暂交接一次（编辑器读取后立即删除）；长期保存的只有界面语言偏好，除此之外不存储任何内容。

已知限制

- 只跟随一个滚动容器，跨不同容器不保证正确
- 跨域 iframe 无法读取内部，退化为只截一屏
- 懒加载内容可能来不及加载
- 长图宽高都限制在约 30000 设备像素内，超出部分截断
- 横向滚动需要页面本身能横向滚动；`overflow-x: hidden` 的页面，超出的右侧部分截不到
- 无法截取 chrome:// 页面、Chrome 应用商店页
```

### 详细描述（繁體中文）

```
Region Shot 解決一個其他截圖工具沒解決的問題：你只想截網頁裡的某一塊，但這一塊比螢幕高。

常見做法有兩種，都不好用——
截整頁：圖太長，上下全是你不要的頁首頁尾和側邊欄；
截可視區域：內容一多就截不全，得手動拼接。

Region Shot 讓你先框出要的那一欄，再捲動到結束位置，把中間所有內容一次截完，輸出一張乾淨的 PNG。

怎麼用

1. 在網頁上點擴充功能圖示，或按 Alt+Shift+S
2. 按住拖曳，確定截圖區域的起點和範圍（按住時拖到螢幕四邊會自動捲動）
3. 放開後，用觸控板或滾輪捲動到想結束的位置。選取區跟著捲動平滑延伸，不會自己跳動；捲到頁面底部時，選取區正好覆蓋到內容底部，頁面最後一段也能截到。選取區旁即時顯示目前尺寸
4. 點選取區右下角的「✓ 完成截圖」（或點頁面任意位置）；按鈕跟著選取區走，捲到哪裡都點得到
5. 截圖完成後開啟標註編輯器：加入文字、箭頭、矩形，可拖動、改顏色和字級，⌘Z 復原
6. 點「✓ 儲存 PNG」存到下載資料夾，或點「複製圖片」直接貼到微信 / 釘釘等任意應用程式

框選階段按 Esc 或點右鍵取消；編輯器裡點「取消」或關掉分頁則不儲存。

為觸控板設計

Mac 觸控板上「按住拖曳」和「兩指捲動」沒辦法同時做，所以定起點和定終點被拆成兩個獨立步驟。不需要一直按著，手可以放開。

介面支援簡體中文、繁體中文、English

跟隨瀏覽器語言自動選擇，也可以在標註編輯器右上角用 🌐 手動切換；框選遮罩和編輯器用同一種語言。

能處理這些頁面結構

- 一般整頁捲動
- SPA 那種內部捲動容器（主內容區自己捲，頁面本身不動）
- 正文塞在 iframe 裡的文件站
- 比螢幕寬的頁面：寬表格、橫向畫布、甘特圖；選取區同時橫向和縱向延伸也能正確拼接

擴充功能會自動判斷目前位置該跟隨哪個捲動容器。

你需要知道的兩件事

- 截圖期間頁面會自動捲動，頂部會出現 Chrome 的「正在偵錯此瀏覽器」提示列，結束後自動消失。這是跨螢幕拼接必須的，擴充功能只在截圖期間附加偵錯工具，結束立即斷開。
- 截圖過程全部在本機完成，不連網、不上傳。拼接好的圖只在擴充功能內部短暫交接一次（編輯器讀取後立即刪除）；長期保存的只有介面語言偏好，除此之外不儲存任何內容。

已知限制

- 只跟隨一個捲動容器，跨不同容器不保證正確
- 跨網域 iframe 無法讀取內部，退化為只截一屏
- 延遲載入內容可能來不及載入
- 長圖寬高都限制在約 30000 裝置像素內，超出部分截斷
- 橫向捲動需要頁面本身能橫向捲動；`overflow-x: hidden` 的頁面，超出的右側部分截不到
- 無法截取 chrome:// 頁面、Chrome 線上應用程式商店頁
```

### 详细描述（English）

```
Region Shot solves a problem most screenshot tools don't: you want to capture one section of a web page, but that section is taller than your screen.

The usual workarounds are both poor. A full-page capture gives you a very tall image full of headers, footers and sidebars you didn't want. A viewport capture cuts off anything longer than one screen.

Region Shot lets you define the start point and width of a region, scroll to where it should end, and receive everything in between as a single clean PNG.

How to use:
1. Click the extension icon, or press Alt+Shift+S
2. Drag to set the starting point and width of the capture area. Dragging to the edge of the window auto-scrolls.
3. Release, then scroll to the point where the capture should end. The selection extends smoothly as you scroll — no automatic jumps; at the end of the page it reaches the real bottom of the content. Live dimensions are shown next to the selection.
4. Click "Done" at the bottom-right of the selection, or click anywhere on the page. The button follows the selection, so it stays reachable while you scroll.
5. The annotation editor opens: add text, arrows and rectangles; drag to move, change colour and font size, ⌘Z to undo.
6. Click "✓ Save PNG" to download, or "Copy image" to paste straight into any app.

Press Esc or right-click to cancel at any stage.

Designed for trackpads: setting the start point and the end point are two separate steps, so you never have to hold a drag and scroll at the same time.

Interface in English, Simplified Chinese and Traditional Chinese

The UI follows your browser language, and can be switched with the 🌐 selector in the editor toolbar; the selection overlay uses the same language.

Handles regular page scrolling, SPA-style inner scroll containers, and documents whose content lives inside an iframe.

Two things to know:
- The page scrolls automatically during capture and Chrome shows a "being debugged" banner, which disappears when the capture finishes. The extension attaches the debugger only for the duration of the capture and detaches immediately afterwards.
- All processing happens on your device. Nothing is sent anywhere. The stitched image is handed off inside the extension once and deleted as soon as the editor reads it; the only thing kept long-term is your interface-language preference.

Known limitations: follows a single scroll container; cross-origin iframes cannot be read; fixed and sticky elements may repeat across segments; lazy-loaded content may not have loaded in time; roughly 30,000 device pixels maximum per dimension; horizontal capture requires the page itself to scroll horizontally; chrome:// pages and the Chrome Web Store cannot be captured.
```

### 分类

- Category：`Tools`（或 `Productivity`）
- 语言：主语言建议填 **English**（审核流程走英文），同时添加中文 listing

---

## 2. 单一用途（Single purpose description）

表单文本框填入：

```
Capture a user-selected rectangular region of the current web page — including content taller than the viewport — let the user annotate it with text, arrows and boxes, and output it as a single PNG image, either saved to disk or copied to the clipboard.

Every permission and every line of code serves this one purpose. The extension has no other feature: it does not block ads, modify pages, manage tabs, collect analytics, or sync anything.
```

---

## 3. 权限逐条理由（Justification for each permission）

> 表单要求英文。每条都尽量具体到「如果不给这个权限，功能会怎样失效」——审核员看的就是这个。

### `activeTab`

```
The extension only needs access to the page the user is actively looking at, and only at the moment they invoke it.

activeTab grants temporary host access to the current tab when the user clicks the extension icon or presses its keyboard shortcut. Without it, the extension would need a persistent host permission for all sites, which is broader than necessary.

Used for: injecting the region-selection overlay into the current tab and controlling its scroll position during capture.

The extension does not request <all_urls>, does not request "tabs", and cannot read any page the user has not explicitly invoked it on.
```

### `scripting`

```
chrome.scripting.executeScript is how the selection UI gets into the page.

Specifically it is used to:
1. Inject the overlay that lets the user drag out a capture region (step 1 of the workflow).
2. Read the current scroll offset and viewport size before each capture segment, so segments line up.
3. Set the scroll offset of the target scroll container to walk down the page screen by screen.
4. Read the final geometry and clean up the overlay afterwards.

There is no other injection. No page script is modified permanently, and no injected code persists after the capture finishes or is cancelled.
```

### `downloads`

```
Used for exactly one call: chrome.downloads.download() to save the finished PNG into the user's Downloads folder.

Without this permission the extension would have to fall back to an in-page blob download, which is less reliable for large images and gives the user less control over where the file lands.

No files are read, enumerated, or deleted. The extension never touches any file other than the one it just produced.
```

### `debugger`

```
Used to capture rendered page content across multiple screens.

Why the built-in APIs are not sufficient:
- chrome.tabs.captureVisibleTab captures only the currently visible viewport, and its output dimensions depend on window state, so successive captures cannot be reliably stitched.
- Page.captureScreenshot through the DevTools Protocol returns a pixel-accurate image of a specified clip rectangle in CSS pixels, which is what makes multi-screen stitching possible.

What the extension does with the permission:
- Attaches to the current tab only after the user starts a capture (never on install, never in the background).
- Sends exactly one CDP command: Page.captureScreenshot. It does not read the DOM, network traffic, cookies, storage, or form values, does not evaluate JavaScript in the page, and does not modify the page.
- Detaches immediately when the capture ends or fails (the detach is in a finally block).

User visibility: Chrome displays its standard "being debugged" infobar for the duration, which is exactly how the user knows the extension is attached. DevTools being open on the same tab prevents attachment, and the extension reports a failure badge and exits in that case.

NOTE: this extension does NOT work in the background. If the debugger permission were granted and the user never clicked the icon, no debug session would ever be created.
```

### `storage`（1.8.0 起）

```
Used for exactly one purpose: remembering the user's interface-language choice.

The extension ships its UI text in English, Simplified Chinese and Traditional Chinese. The annotation editor has a language selector (auto / 简体中文 / 繁體中文 / English). When the user picks one, the value is written with chrome.storage.local.set({ regionShotLang: ... }) and mirrored into the editor page's own localStorage so the editor can read it synchronously without a flash of the wrong language.

background.js calls chrome.storage.local.get('regionShotLang') once per capture, so the region-selection overlay is shown in the same language the user chose.

Stored data: a single string, one of "auto", "zh_CN", "zh_TW", "en". Nothing else is written, no other storage area is used, and no cookies are used.
```

### Host permissions

表单里如果问 "host permissions"，填：

```
None. The extension declares no host_permissions. It relies solely on activeTab, which grants temporary access to the current tab only when the user invokes the extension.

(Test builds add <all_urls>, but the published package does not.)
```

### 标注编辑器页面（1.7.0 新增）

截图完成后会打开 `editor.html` —— 这是扩展自己包内的页面（`chrome-extension://` origin），不是远程页面，也不是内容脚本。

- 打开方式是 `chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?id=…') })`。**`tabs.create` 不需要任何权限**，也没有为此新增 manifest 条目。
- 编辑器保存后调用 `chrome.tabs.getCurrent` / `chrome.tabs.remove` 关闭自己。官方 [tabs API 文档](https://developer.chrome.com/docs/extensions/reference/api/tabs) 写明 "Most features don't require any permissions to use"，`"tabs"` 权限只控制 `Tab` 的 `url`、`pendingUrl`、`title`、`favIconUrl` 四个敏感字段的读取与查询。当前调用不碰这四个字段，所以**不需要声明 `tabs` 权限**。
- 结论：**编辑器本身没有新增任何权限**，不需要为它写 tabs/host 理由。1.8.0 起 manifest 多了 `storage`，那是为「界面语言偏好」加的，理由见上一节。
- 需要在数据使用声明里说明的：截图会在扩展自己的 IndexedDB 里做一次临时交接（已写入 §5 的 Website content 用途说明）；界面语言偏好会写入 `chrome.storage.local` 和编辑器页的 `localStorage`（已写入 §5 的新增说明）。
- 注意：测试脚本 `test/e2e.js` 和 `test/manual-check.js` 会给测试副本额外加 `tabs` 与 `<all_urls>`，那只是为了测试便利，**不要打进提交的 zip**。

---

## 4. 远程代码（Remote code）

选择：**No — I am not using remote code.**

理由（如果表单要求填写）：

```
All executable code ships inside the extension package (background.js, editor.js, i18n.js); there are no CDN imports, no eval(), no new Function(), no remotely loaded scripts, and no dynamic code generation. The two fetch() calls in the codebase read local resources only — the bundled _locales JSON for the selected UI language, and a data: URL the extension itself created in order to save the image when the downloads API fails. Neither contacts a network.
```

---

## 5. 数据使用声明（Privacy practices → Data usage）

### 勾选结论

| 数据类型 | 勾选 | 理由 |
|---|---|---|
| Personally identifiable information | ❌ | 不收集任何身份信息，无登录、无账号 |
| Health information | ❌ | 不涉及 |
| Financial and payment information | ❌ | 不涉及 |
| Authentication information | ❌ | 不读 Cookie、不读 token、不读密码字段 |
| Personal communications | ❌ | 不读邮件、消息、聊天内容 |
| Location | ❌ | 不申请地理位置权限 |
| Web history | ❌ | 没有 `history` 权限，不记录、不读取 URL 列表 |
| **User activity** | ✅ | **见下方说明** |
| **Website content** | ✅ | 见下方说明 |

> **`User activity` 这一项是判断，不是官方明文。** 判断依据：Chrome 官方 User Data FAQ 把 "taking screenshots" 明确列为处理用户数据的例子，并在 Q3 里明确「即使数据只在本地处理、不传输，也必须披露」。框选过程中扩展确实响应鼠标移动和滚动位置——按字面定义属于 user activity。勾选后只需填一段用途说明，不勾则属于未披露处理。**如果你倾向于不勾，风险由你判断**，但我建议勾。

### 界面语言偏好（不在上表任何类别内）

1.8.0 起扩展会在 `chrome.storage.local` 和编辑器页的 `localStorage` 里各存一份界面语言偏好（`auto` / `zh_CN` / `zh_TW` / `en`）。它不是个人身份信息、不是网站内容，也不用于分析或广告。`privacy-policy.html` 第 4 节已写明「除这个语言偏好外不存储任何其他内容」。

### 勾选后需要填的用途说明

**Website content — how it is used:**

```
Read only within the rectangle the user selects, in order to render that region into the PNG the user asked for. After stitching, the image is written once to the extension's own IndexedDB under a one-time random ID so the annotation editor can open it; the editor deletes that record as soon as it reads it, and the record is deleted immediately if the editor cannot be opened. Nothing is transmitted, uploaded, or shared.

Purpose: app functionality only. Not used for analytics, advertising, personalization, or any purpose unrelated to producing the requested screenshot.
```

**User activity — how it is used:**

```
Mouse position and scroll offset are read only while the user is dragging out a selection and scrolling to its end point, so the overlay can follow the pointer and extend the selection as the page scrolls. Nothing is logged, persisted, or transmitted.

Purpose: app functionality only — drawing the selection overlay and computing capture segment boundaries.
```

### 三项 Limited Use 认证

全部勾选（都是事实）：

- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## 6. 审核测试说明（Test instructions）

表单里「Instructions for testing」填：

```
No account or credentials are required. Everything runs locally.

1. Open any long public article, for example https://en.wikipedia.org/wiki/Screenshot
2. Click the Region Shot toolbar icon (or press Alt+Shift+S).
3. In the middle of the article body, press the mouse and drag 200-300px horizontally, then release. A green selection outline appears and a "Done" button appears at the bottom right of the selection.
4. Scroll down with the mouse wheel. The selection extends smoothly with each scroll step and the live dimension indicator updates. Scroll to the end of the page: the selection reaches the real bottom of the content.
5. Click the "Done" button once the selection is several screens tall.
6. The annotation editor opens in a new tab with the stitched image. Add some text, an arrow, or a rectangle, then click "Save PNG" (✓ 保存 PNG), or click "Copy image" to paste the result straight into any app.
7. Optional, to test the storage permission: use the 🌐 selector in the editor toolbar to switch the interface to another language. Start a second capture on the same page and confirm the selection overlay is shown in that language.
8. A PNG is saved to Downloads. It should contain exactly the region that was selected, with no header or sidebar that was outside the selection, and it should include the annotations you just drew at the same positions you placed them.

Expected during steps 3-8: Chrome shows its standard "being debugged" infobar. It disappears automatically when the capture completes.

To verify that nothing is transmitted: open DevTools → Network on any page, run a capture, and observe zero requests originating from the extension. Or simply disconnect from the network — captures still work.

Press Esc or right-click to cancel at any stage.
```

---

## 7. 提交材料清单

- [x] `privacy-policy.html` 邮箱已替换为真实地址；公网 URL 待在 GitHub 仓库 Settings → Pages 启用 `main` / `(root)`
- [ ] 128×128 图标 PNG，manifest 加 `"icons": { "128": "icon128.png" }`
- [x] 1280×800 商店截图（1–5 张，满版无留白）：`store-assets/screenshot-1.png`（框选）、`screenshot-2.png`（滚动延伸）、`screenshot-3.png`（标注）、`screenshot-4.png`（整图预览）、`screenshot-5.png`（导出长图）
- [x] 5 张商店截图已补齐（滚动延伸中 / 完成按钮特写未单独出图，第 2、4 张已覆盖这两个卖点）
- [ ] 打包 zip：`npm run pack` → `dist/region-shot-1.8.3.zip`（清单从 manifest + background 的 `getURL()` 反推：background.js、editor.html/css/js、i18n.js、`_locales/`、icons/、manifest.json；`test/`、`scripts/`、`*.md` 不会进包）
- [ ] 注册 Chrome Web Store 开发者账号（一次性 $5，官方页面：https://chrome.google.com/webstore/devconsole）
- [ ] 填写 Privacy practices 全部字段（本文件 §2–§5）
- [ ] 提交审核

---

## 8. 两个需要你判断的风险点

### ① `debugger` 权限的审核风险

**已核实的事实：** 我读了 [debugger API 官方文档](https://developer.chrome.com/docs/extensions/reference/api/debugger) 和 [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)，页面里**没有**出现「debugger 权限需要额外审核」这类明文条款。

**未核实：** 网上普遍反映带 `debugger` 权限的扩展审核更慢、被要求补充说明的概率更高。我没有找到可以引用的官方原文，所以**这条只能标为「社区说法，未核」**，不作为决策依据。

**能确定的判断：** `debugger` 是 manifest 里权限等级最高的一项，它会让用户看到调试提示条。审核员一定会重点读这一段 justification。所以 §3 里那段 `debugger` 的理由写得最详细——把「为什么不给这个权限功能就做不成」讲清楚，是降低被拒概率最直接的办法。

**如果被拒：** 备选方案是砍掉跨屏能力，改用 `tabs.captureVisibleTab` 只截当前一屏。这会让产品失去核心卖点，所以我建议先按现在的方案提交，被拒再议。

### ② 隐私政策不能写「我们不收集任何数据」

很多截图扩展的隐私政策就写一句「本扩展不收集任何数据」。**按 Chrome 官方的定义，这句话是错的。**

官方 [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) 原文：

> Clipping or scraping content from a website that the user visits, **such as taking screenshots** or capturing data from a web page — 被明确列为 handle user data 的例子。

> **Q3: Does an extension need to disclose user data handling if the data is only processed or stored locally on a user's device?**
> **Yes.** Extensions are required to disclose how they handle user data, even when data is processed or stored locally on a user's device and is not transmitted to external servers or third parties.

所以 `privacy-policy.html` 的写法是「我们处理了网站内容，但只在本机、不上传、不存储」——而不是「我们什么都不碰」。这个区别如果写错，是商店下架的理由。

---

## 9. 事实核对表（本文档中每条断言的来源）

| 断言 | 依据 | 状态 |
|---|---|---|
| 截图属于需披露的用户数据处理 | User Data FAQ 原文 | 已验证（官方页面） |
| 本地处理也必须披露 | User Data FAQ Q3 原文 | 已验证（官方页面） |
| 隐私政策至少说明收集/使用/分享三要素 | User Data FAQ Q7 | 已验证（官方页面） |
| Limited Use 要求网站上有肯定性声明 | limited-use 政策原文 | 已验证（官方页面） |
| 代码无远程网络请求 | `grep -nE "fetch\(|XMLHttpRequest|WebSocket"` → 仅 1 处 `fetch(dataUrl)` | 已验证（读代码） |
| 本地存储内容 | 只用一个 IndexedDB 交接截图，编辑器读到即删；1.8.0 起另有界面语言偏好写入 `chrome.storage.local` + 编辑器页 `localStorage`（`grep -n "chrome.storage"` → background.js:387 读、i18n.js:168 写，均只碰 `regionShotLang`）；无 Cookie | 已验证（读代码，2026-11-19） |
| 简短描述上限 132 字符 | 官方 prepare 页面原文 "A string of no more than 132 characters" | 已验证（官方页面，2026-11-19 抓取） |
| 标题 / 详细描述的字符上限 | — | **未核**（本次抓取的官方页面未写明；实测标题 18 / 18 / 28 字符，详细描述 1132 / 1156 / 2648 字符，远低于常见的 45 / 16000 限制） |
| 唯一 CDP 命令是 `Page.captureScreenshot` | `grep -n "sendCommand"` → 1 处 | 已验证（读代码） |
| detach 在 finally 里 | background.js 的 `runCapture` | 已验证（读代码） |
| 截图后恢复滚动位置 | `scrollToPosition(tab.id, ..., sel.scrollStart, sel.scrollStartX)` | 已验证（读代码 + e2e） |
| manifest 无 host_permissions | manifest.json 实际内容 | 已验证（读代码） |
| 商店截图为 1280×800 或 640×400，1–5 张，满版 | 官方 [Store images](https://developer.chrome.com/docs/webstore/images) 页面 | 已验证（官方页面，2026-11-18 抓取） |
| `chrome.tabs.getCurrent/remove` 不需要 `tabs` 权限 | 官方 tabs API 文档："Most features don't require any permissions to use" | 已验证（官方页面，2026-11-18 抓取） |
| debugger 权限有额外审核 | — | **未核**（未找到官方明文，仅社区说法） |
| 注册费 $5 | 官方 devconsole 页面 | **未核**（本会话未逐字核对金额，提交前请自己看一眼页面） |
