// 打出可直接上传到 Chrome 应用商店的 zip
//
// 用法：node scripts/pack.js [--out 目录]
//
// 设计原则：要打包哪些文件**从 manifest 反推**，不手写清单。
// 手写清单会在加功能时漏文件，而漏文件只有等审核报错或用户装了才发现的。
// 反过来，只要文件没被 manifest 引用，就不该进包——test/、scripts/、*.md 因此天然被排除。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const OUT_DIR = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dist');

const errors = [];
const warn = [];

function fail(msg) { errors.push(msg); }

// ---------- 读 manifest ----------
const manifestPath = path.join(ROOT, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('找不到 manifest.json');
  process.exit(1);
}
const rawManifest = fs.readFileSync(manifestPath, 'utf8');
let manifest;
try {
  manifest = JSON.parse(rawManifest);
} catch (e) {
  console.error(`manifest.json 不是合法 JSON：${e.message}`);
  console.error('提示：manifest 里不能有注释，Chrome 会报「无法解析清单」');
  process.exit(1);
}

// ---------- 基础校验 ----------
if (manifest.manifest_version !== 3) fail(`manifest_version 应为 3，实际 ${manifest.manifest_version}`);

const version = String(manifest.version || '');
// Chrome 版本号：1-4 段，每段 0-65535 的整数
if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(version) || version.split('.').some((n) => Number(n) > 65535)) {
  fail(`version "${version}" 格式不合法（应为 1-4 段数字，每段 0-65535）`);
}

if (!manifest.name) fail('缺少 name');
if (!manifest.description) {
  fail('缺少 description');
} else if (manifest.description.length > 132) {
  fail(`description 超长：${manifest.description.length} 字符，上限 132`);
}
if (!manifest.icons) fail('缺少 icons 字段（商店要求）');
else if (!manifest.icons['128']) fail('icons 缺少 128 尺寸');

// ---------- 从 manifest 反推文件清单 ----------
const files = new Set(['manifest.json']);

function addFile(p, where) {
  if (!p) return;
  const rel = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  if (files.has(rel)) return;
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    fail(`${where} 引用了不存在的文件：${rel}`);
    return;
  }
  files.add(rel);
}

if (manifest.background) {
  addFile(manifest.background.service_worker, 'background.service_worker');
  (manifest.background.scripts || []).forEach((s) => addFile(s, 'background.scripts'));
}
if (manifest.icons) Object.values(manifest.icons).forEach((p) => addFile(p, 'icons'));
if (manifest.action && manifest.action.default_icon) {
  const di = manifest.action.default_icon;
  (typeof di === 'string' ? [di] : Object.values(di)).forEach((p) => addFile(p, 'action.default_icon'));
}
if (manifest.options_page) addFile(manifest.options_page, 'options_page');
if (manifest.options_ui && manifest.options_ui.page) addFile(manifest.options_ui.page, 'options_ui.page');
(manifest.content_scripts || []).forEach((cs, i) => {
  (cs.js || []).forEach((s) => addFile(s, `content_scripts[${i}].js`));
  (cs.css || []).forEach((s) => addFile(s, `content_scripts[${i}].css`));
});
(manifest.web_accessible_resources || []).forEach((w, i) => {
  (w.resources || []).forEach((r) => {
    if (/[*{}]/.test(r)) return; // 通配符不展开，手工确认
    addFile(r, `web_accessible_resources[${i}]`);
  });
});

// ---------- 运行时打开的扩展页面 ----------
// editor.html 这类页面不在 manifest 里（background 用 chrome.tabs.create 打开），
// 从 background 的 getURL() 反查，再顺着页面 HTML 的 src/href 收集资源。
// 不写死文件清单：以后再加页面/样式，也不会漏进包。
function collectPage(page, where) {
  if (files.has(page)) return;
  addFile(page, where);
  if (!files.has(page) || !page.endsWith('.html')) return;
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const ref = m[1].trim();
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(ref)) continue; // 远程、绝对路径、锚点
    collectPage(ref.replace(/^\.\//, ''), `${page} 引用`);
  }
}

const bgWorker = manifest.background && manifest.background.service_worker;
if (bgWorker && fs.existsSync(path.join(ROOT, bgWorker))) {
  const code = fs.readFileSync(path.join(ROOT, bgWorker), 'utf8');
  for (const m of code.matchAll(/getURL\(\s*['"]([^'"]+\.html)['"]/g)) {
    collectPage(m[1], `${bgWorker} getURL`);
  }
}

// ---------- 杂项检查 ----------
for (const f of files) {
  if (f.includes('__MACOSX') || f.endsWith('.DS_Store')) fail(`文件清单里混进了系统垃圾：${f}`);
  if (/\.(map|md)$/.test(f)) warn.push(`${f} 看起来不像运行时文件，确认一下是否真的需要`);
}

// localservice worker 里如果用了 importScripts 的远程地址，会被当成远程代码直接拒
const bg = manifest.background && manifest.background.service_worker;
if (bg && files.has(bg)) {
  const code = fs.readFileSync(path.join(ROOT, bg), 'utf8');
  if (/importScripts\(\s*['"]https?:/.test(code)) fail('background 里 importScripts 了远程地址，会被判定为远程代码并拒绝');
  if (/\beval\s*\(/.test(code)) warn.push('background 里出现 eval(，审核会重点看');
}

if (errors.length) {
  console.error('\n✗ 打包前检查失败：');
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}
warn.forEach((w) => console.warn('! ' + w));

// ---------- 打包 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const zipName = `region-shot-${version || 'unknown'}.zip`;
const zipPath = path.join(OUT_DIR, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const fileList = [...files].sort();
try {
  // -X 不写入 macOS 的 uid/gid 等额外属性，-q 安静模式
  execFileSync('zip', ['-r', '-X', '-q', zipPath, ...fileList], { cwd: ROOT });
} catch (e) {
  console.error('调用 zip 失败：' + e.message);
  process.exit(1);
}

// ---------- 校验产物 ----------
function listZip() {
  return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
}
const entries = listZip();

if (!entries.includes('manifest.json')) {
  console.error('\n✗ 产物里 manifest.json 不在根目录。Chrome 会拒收这种包。');
  process.exit(1);
}
const junk = entries.filter((e) => e.startsWith('__MACOSX') || e.endsWith('.DS_Store'));
if (junk.length) {
  console.error('\n✗ 产物里含系统垃圾：' + junk.join(', '));
  process.exit(1);
}
// 完整性：解压后逐字节比对
for (const f of fileList) {
  const inZip = execFileSync('unzip', ['-p', zipPath, f], { maxBuffer: 256 * 1024 * 1024 });
  const onDisk = fs.readFileSync(path.join(ROOT, f));
  if (!inZip.equals(onDisk)) {
    console.error(`\n✗ ${f} 在 zip 里与磁盘内容不一致`);
    process.exit(1);
  }
}

// ---------- 报告 ----------
const size = fs.statSync(zipPath).size;
console.log('✓ 打包完成\n');
console.log(`  产物    ${path.relative(ROOT, zipPath)}`);
console.log(`  版本    ${version}`);
console.log(`  大小    ${(size / 1024).toFixed(1)} KB`);
console.log(`  文件    ${fileList.length} 个\n`);
for (const f of fileList) {
  const s = fs.statSync(path.join(ROOT, f)).size;
  console.log(`    ${f.padEnd(40)} ${(s / 1024).toFixed(1).padStart(7)} KB`);
}

// 和 package.json 的版本对一下，避免两处版本号漂移
const pkgPath = path.join(ROOT, 'package.json');
if (fs.existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version && pkg.version !== version) {
      console.log(`\n! package.json 的 version (${pkg.version}) 与 manifest (${version}) 不一致，以 manifest 为准`);
    }
  } catch { /* package.json 坏了不阻塞打包 */ }
}

console.log('\n下一步：开发者信息中心 → 添加新商品 → 上传这个 zip');
