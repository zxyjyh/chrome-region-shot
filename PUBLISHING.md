# Chrome 应用商店上架 · 操作指南

> 依据：Chrome 官方开发者文档（2026-11-17 抓取核对），来源见文末。
> 配套：`store-listing.md` 是用来往表单里复制粘贴的文案，本文讲的是**点哪里、按什么顺序点**。

---

## 一、一次性准备

| 项目 | 说明 |
|---|---|
| Google 账号 | 建议新建一个专用账号。官方明确建议：因为你会收到重要通知、且删除账号后该邮箱不能复用，用干净的新邮箱更省事 |
| 支付方式 | 注册开发者账号需支付**一次性注册费**。官方文档只写「一次性注册费」，**没有在页面上标明金额**，以注册页面实际显示为准 |
| 发布商名称 | 会显示在每个商品标题下方，必填 |
| 验证邮箱 | 必填。所有通知都发到这个地址 |
| 实际地址 | 只有**收费**（含内购/订阅）的商品才强制要求。免费分发不用填 |

> 一个开发者账号最多发布 **20 个**扩展。超了要单独申请，且会审查你的历史记录。

---

## 二、六步流程

### 第 1 步：注册开发者账号

1. 打开 <https://chrome.google.com/webstore/devconsole>
2. 用 Google 账号登录
3. 阅读并同意开发者协议和政策
4. 支付一次性注册费
5. 进入「帐号」页（左侧菜单），填写：
   - 发布商名称（必填）
   - 验证联系邮箱（点「添加电子邮件」→ 收信 → 点验证链接）
   - 「受信任的测试人员帐号」可选，不支持群组邮箱

### 第 2 步：打包 zip

**硬性要求：`manifest.json` 必须在 zip 的根目录，不能套一层文件夹。**

```bash
npm run pack
```

要打包哪些文件是从 manifest 反推的（`icons`、`background.service_worker`、`action.default_icon` 等字段指向什么就打什么），所以 `test/`、`scripts/`、`*.md` 天然被排除——不会漏文件，也不会混进无关文件。

脚本会在打包前检查这些并直接报错退出：

| 检查项 | 为什么 |
|---|---|
| manifest 是合法 JSON | 带注释的 manifest 会导致「无法解析清单」 |
| `version` 格式 1–4 段数字 | Chrome 只接受这种格式，且新版本必须更大 |
| `description` ≤ 132 字符 | 商店硬限制 |
| `icons` 存在且含 128 | 商店要求 |
| 所有 manifest 引用的文件真实存在 | 漏文件在本地能跑、装到别人机器上才崩 |
| background 没有 `importScripts('https://...')` | 会被判定为远程代码直接拒绝 |
| 产物里 `manifest.json` 在根目录 | 否则 Chrome 拒收 |
| 产物里没有 `__MACOSX` / `.DS_Store` | macOS 打包常见垃圾 |
| 产物内容与磁盘逐字节一致 | 确认压缩没出错 |

打包后自查：

```bash
unzip -l dist/region-shot-1.6.0.zip
```

输出里必须能看到顶格的 `manifest.json`。

### 第 3 步：上传

1. 开发者信息中心 → **添加新商品**
2. 选择文件 → 选中 zip → 上传
3. manifest 和 zip 都校验通过后，进入下一页

> ⚠️ **上传之后，manifest 里的元数据（name / version / icons / description）就不能在后台修改了。** 要改只能改 manifest、升版本号、重新打包上传。所以上传前一定检查一遍。

### 第 4 步：填写四个标签页

上传后左侧会出现四个标签：

**① Package（打包）**
只读，显示刚上传的包信息。

**② 商品详情（Store listing）**
- 名称、简短描述、详细描述
- 分类（建议 Tools 或 Productivity）
- 语言
- 图形素材：128×128 图标、**1280×800 商店截图（1–5 张，满版）**、可选宣传图 440×280 与精选图 1400×560

**③ 隐私权（Privacy）** ← 这一页最容易被打回
- 单一用途说明
- 每个权限的理由（逐条文本框）
- 远程代码声明（选 No）
- 数据使用声明（复选框）
- 三项 Limited Use 认证
- 隐私政策 URL

四项的**现成文案**都在 `store-listing.md` §2–§5，直接复制。

**④ 分发（Distribution）**
- 是否收费（本扩展：免费）
- 列出哪些国家/地区
- 可见性：公开 / 不公开（仅链接）/ 私密

> 如果后台出现「交易者身份声明（Trader status）」之类的欧盟 DSA 字段，按你的实际情况如实选。

### 第 5 步：提交审核

点「提交审核」→ 弹出确认框。

确认框里有一个「审核通过后自动发布」的复选框：
- **勾上**：审核一过就自动上线
- **取消勾选**：审核通过后先停着，你手动点发布。适合想挑时间上线的场景

> 推迟发布有 30 天期限，过期会退回草稿，得重新提交审核。

### 第 6 步：等审核

官方文档（最后更新 2021 年）的说法：**大多数提交在 24 小时内审完，90% 以上在三天内**。超过三周没动静可以联系开发者支持。

> 这是 2021 年的数据，现在的实际时长可能更长，别把这个当 SLA。

---

## 三、审核为什么可能变慢 / 被拒

官方原文列出了会触发「更仔细检查」的信号：

- **新开发者**
- **新附加信息**
- **危险的权限请求**
- **重大代码更改**

以及：

> 「对于请求广泛的主机权限或**敏感的执行权限**的扩展程序……审核过程可能需要更长的时间。」

官方点名 `tabs` 和 `downloads` 是「敏感的执行权限」。我们用了 `downloads`，还用了权限等级更高的 `debugger`。

**这意味着你这个扩展几乎必然会被人工细看，`debugger` 那段理由写得好不好，直接决定过不过。** `store-listing.md` §3 里那段是照「不给这个权限功能就做不成」的逻辑写的，别删减。

其他官方明确提到会拖慢或导致拒绝的情况：

- 申请了用不到的权限（会被直接拒）
- 代码被混淆（**明令禁止**）
- 使用远程代码却未声明（会被拒）

---

## 四、这个项目现在的阻塞项

**已完成的部分：**

- ✅ **manifest 已有 `icons` 字段** —— 16/32/48/128 四套，源文件在 `icons/*.svg`，`npm run icons` 可重新生成
- ✅ **打包脚本就绪** —— `npm run pack`，自动从 manifest 反推文件清单、校验后输出到 `dist/`
- ✅ **产物已验证可被 Chrome 加载** —— 解压后 `Extensions.loadUnpacked` 成功，service worker 正常启动，图标资源返回 `200 image/png`
- ✅ **功能未退化** —— `npm test` 三个页面用例全部 PASS

**还差的部分（需要你本人操作）：**

- [ ] **隐私政策里的邮箱还是占位符** —— `privacy-policy.html` 里两处 `[请替换为你的联系邮箱]` / `[Replace with your contact email]`
- [ ] **隐私政策没有公网 URL** —— 后台只收 https 地址。最省事：把这个 html 推到 GitHub Pages
- [ ] **商店展示截图** —— 1280×800、满版，1–5 张；`store-assets/` 里已有 5 张（注意：这和扩展图标不是一回事）
- [ ] **注册开发者账号并付注册费**
- [ ] **在后台逐项填表** —— 文案在 `store-listing.md`

> ⚠️ 顺序仍然关键：**manifest 一旦上传就锁死**。如果之后还要改 `name` / `version` / `icons` / `description`，只能升版本号重新打包重新提交。所以上面的邮箱和隐私政策要先搞定，再上传。

---

## 五、上线之后

- **更新版本**：改 manifest 的 `version`（必须比上一版高）→ 重新打包 → 后台上传 → 再次审核。每次更新都走同样的审核流程
- **回滚**：不能直接回滚到旧版本，只能改回代码 + 升版本号 + 重新提交
- **收费**：Chrome 应用商店支持开发者自行收费，但必须**明确告诉用户卖家是你、不是 Google**。用官方支付通道则要在帐号页填实际地址
- **被拒申诉**：拒绝通知里会有原因和申诉入口，按原因改完重新提交

---

## 六、官方来源

| 内容 | 页面 |
|---|---|
| 注册开发者账号 | <https://developer.chrome.com/docs/webstore/register> |
| 设置帐号 | <https://developer.chrome.com/docs/webstore/set-up-account> |
| 准备并打包 | <https://developer.chrome.com/docs/webstore/prepare> |
| 发布流程 | <https://developer.chrome.com/docs/webstore/publish> |
| 填写隐私权字段 | <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> |
| 审核流程与时长 | <https://developer.chrome.com/docs/webstore/review-process> |
| 用户数据 FAQ | <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq> |
| 有限使用政策 | <https://developer.chrome.com/docs/webstore/program-policies/limited-use> |
| 开发者控制台 | <https://chrome.google.com/webstore/devconsole> |

**未核实项：** 注册费的具体金额。官方开发文档只写「一次性注册费」未标数字，网上常见的说法是 5 美元，但我没在官方页面上核到，以注册页面实际显示为准。
