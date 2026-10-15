// 生成可直接发布到 GitHub Pages 的静态站点：dist/
//   dist/index.html            入口页
//   dist/oneshot/ dist/guided/ 两个 demo
//   dist/shared/engine.browser.js  引擎（由 src/ 打包而来）
//   dist/shared/api-shim.js        浏览器里的「后端」
const fs = require('fs');
const path = require('path');
const { bundle } = require('./bundle');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SITE, DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'shared', 'engine.browser.js'), bundle());
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');      // 告诉 GitHub Pages 不要用 Jekyll 处理

const list = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : list.push(p); } })(DIST);
for (const p of list) console.log(`  ${path.relative(DIST, p).padEnd(34)} ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
console.log(`已生成 ${list.length} 个文件 → dist/`);
