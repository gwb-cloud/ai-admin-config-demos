// 发布前检查（本地 `npm run check`，CI 部署前也会跑）。任何一项失败都会以非 0 退出，阻止部署。
// 原因：静态站点的错误只有在访客打开页面时才会暴露，所以要在发布前把能验证的都验证掉。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bundle } = require('./bundle');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed++; console.log('  ✗ ' + m); };
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('1. 语法检查');
for (const f of ['server.js', 'src/capabilities.js', 'src/flow.js', 'src/build.js', 'src/engine.js', 'scripts/bundle.js', 'scripts/build-static.js', 'scripts/check.js', 'site/shared/api-shim.js']) {
  try { new vm.Script(rd(f).replace(/^#!.*\n/, ''), { filename: f }); ok(f); } catch (e) { bad(`${f}：${e.message}`); }
}
for (const f of ['site/oneshot/index.html', 'site/guided/index.html']) {         // 页面里内联脚本也要能解析
  const scripts = [...rd(f).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { scripts.forEach((s) => new vm.Script(s, { filename: f })); ok(`${f}（${scripts.length} 段内联脚本）`); } catch (e) { bad(`${f}：${e.message}`); }
}

console.log('2. 页面引用');
for (const f of ['site/oneshot/index.html', 'site/guided/index.html']) {
  const h = rd(f);
  h.includes('../shared/engine.browser.js') && h.includes('../shared/api-shim.js') ? ok(`${f} 已引入引擎与垫片`) : bad(`${f} 缺少 engine.browser.js / api-shim.js 引用`);
}
rd('site/index.html').includes('./oneshot/') && rd('site/index.html').includes('./guided/') ? ok('入口页指向两个 demo') : bad('入口页缺少两个 demo 的链接');

console.log('3. 浏览器引擎冒烟测试（离线规则模式）');
(async () => {
  try {
    const win = {};
    vm.runInNewContext(bundle(), { window: win, structuredClone, console });
    const eng = win.AdminAI.createEngine({ askModel: null, provider: 'mock' });
    const meta = eng.meta();
    meta.provider === 'mock' && meta.caps.approvalFlow ? ok('引擎加载，meta 正常') : bad('meta 异常');

    const b = await eng.route('/api/build', { messages: [{ role: 'user', content: '做一个出差费用报销' }] });
    const a = b.applied;
    b.status !== 'error' && a.basic.next.name && a.form.next.fields.length >= 3 && a.flow.next.nodes.length >= 2 ? ok(`一句话搭建：「${a.basic.next.name}」${a.form.next.fields.length} 个字段、${a.flow.next.nodes.length} 个节点`) : bad('一句话搭建没有产出完整方案');

    const q = await eng.route('/api/answer', { capability: 'approvalBasic', answers: {} });
    q.questions[0]?.field === 'name' ? ok('引导：基础信息第一题是「名称」') : bad('引导首题不对');

    const f = await eng.route('/api/chat', { capability: 'approvalForm', context: { name: '请假申请' }, messages: [{ role: 'user', content: '开始设计表单' }] });
    f.questions.some((x) => x.field === 'discovery') ? ok('引导：表单步骤会先推荐字段') : bad('表单步骤没有推荐字段');

    const guard = await eng.route('/api/answer', { capability: 'approvalForm', config: { fields: [{ id: 'f1', label: 'x', type: 'text', required: true, options: [], withTime: null, currency: null, children: [] }], confirmed: false }, answers: { confirm: 'yes' } });
    guard.next.confirmed === true ? ok('确认流程：必填齐全时可确认') : bad('确认流程异常');
    const evil = await eng.route('/api/chat', { capability: 'approvalForm', messages: [{ role: 'user', content: '加上 请假天数（数字）' }] });
    evil.next && evil.next.confirmed === false ? ok('模型路径不能自行「确认完成」') : bad('确认校验异常');
  } catch (e) { bad('引擎冒烟测试抛错：' + e.stack.split('\n').slice(0, 2).join(' | ')); }

  console.log('4. 密钥与敏感信息扫描');
  const hits = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      if (['.git', 'node_modules', 'dist'].includes(n)) continue;
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (n === '.env') { hits.push(`${path.relative(ROOT, p)}（.env 不应出现在仓库里）`); continue; }
      if (/\.(png|jpg|ico|woff2?)$/.test(n)) continue;
      const t = fs.readFileSync(p, 'utf8');
      if (/sk-[A-Za-z0-9]{20,}/.test(t)) hits.push(`${path.relative(ROOT, p)}：疑似 API Key`);
    }
  })(ROOT);
  hits.length ? hits.forEach((h) => bad(h)) : ok('未发现 API Key / .env');

  console.log(failed ? `\n检查失败：${failed} 项` : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
