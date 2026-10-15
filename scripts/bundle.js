// 把 src/ 下的引擎打成一个浏览器可直接加载的脚本（零依赖的迷你打包器）。
// 产物只暴露一个全局：window.AdminAI = { createEngine }。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['capabilities', 'flow', 'build', 'providers', 'engine'];   // 都用 require('./xxx')，互相引用的名字必须在这里

function bundle() {
  let out = '/* 自动生成，请勿手改：运行 node scripts/build-static.js 重新生成 */\n(function () {\n"use strict";\nconst defs = {};\n';
  for (const m of MODULES) {
    const src = fs.readFileSync(path.join(SRC, m + '.js'), 'utf8');
    out += `defs[${JSON.stringify('./' + m)}] = function (module, exports, require) {\n${src}\n};\n`;
  }
  out += `const cache = {};
function req(name) {
  if (!defs[name]) throw new Error('missing module ' + name);
  if (cache[name]) return cache[name].exports;
  const m = { exports: {} };
  cache[name] = m;
  defs[name](m, m.exports, req);
  return m.exports;
}
window.AdminAI = req('./engine');
})();
`;
  return out;
}

module.exports = { bundle };
