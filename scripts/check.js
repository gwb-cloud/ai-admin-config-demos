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
for (const f of ['server.js', 'src/capabilities.js', 'src/flow.js', 'src/build.js', 'src/engine.js', 'src/providers.js', 'scripts/bundle.js', 'scripts/build-static.js', 'scripts/check.js', 'site/shared/api-shim.js']) {
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

  console.log('4. 模型接入层（用假接口模拟各种厂商的行为，不联网）');
  try {
    const P = require('../src/providers');
    const mkRes = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
    const okOpenAI = (content) => mkRes(200, { choices: [{ message: { content } }] });
    const hist = [{ role: 'user', content: 'hi' }];

    // 4.1 OpenAI 兼容：厂商不接受 max_tokens / response_format 时自动适应
    let calls = [];
    const f1 = async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if ('max_tokens' in body) return mkRes(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
      if ('response_format' in body) return mkRes(400, { error: { message: 'response_format json_object is not supported by this model' } });
      return okOpenAI('好的 {"ok":true,"n":1}');
    };
    const r1 = await P.makeAskModel({ id: 't1', provider: 'openai', key: 'k' }, { fetch: f1 })('sys', hist);
    r1.ok === true && calls.length === 3 && !('response_format' in calls[2]) && 'max_completion_tokens' in calls[2] ? ok('参数自适应：max_tokens / JSON 模式被拒后自动调整并成功') : bad('参数自适应失败：' + JSON.stringify(calls.map(Object.keys)));

    // 4.2 Claude 协议：请求头与请求体格式
    let seen;
    const f2 = async (url, init) => { seen = { url, h: init.headers, b: JSON.parse(init.body) }; return mkRes(200, { content: [{ text: '{"a":2}' }] }); };
    const r2 = await P.makeAskModel({ id: 't2', provider: 'anthropic', key: 'k' }, { fetch: f2 })('sys', hist);
    r2.a === 2 && seen.url.endsWith('/v1/messages') && seen.h['x-api-key'] === 'k' && seen.h['anthropic-dangerous-direct-browser-access'] === 'true' && seen.b.system === 'sys' && !seen.b.response_format ? ok('Claude 协议：地址、请求头、请求体正确') : bad('Claude 请求格式不对');

    // 4.3 主模型出错 → 自动换备用，并对出错的模型冷却（第二次请求不再先试它）
    let primary = 0, backup = 0;
    const f3 = async (url) => { if (url.includes('primary.test')) { primary++; return mkRes(503, { error: { message: 'overloaded' } }); } backup++; return okOpenAI('{"from":"backup"}'); };
    const down = {}, used = [];
    const chain = P.makeChain([{ id: 'a', provider: 'custom', key: 'k', base: 'https://primary.test/v1', model: 'm' }, { id: 'b', provider: 'custom', key: 'k', base: 'https://backup.test/v1', model: 'm' }], { fetch: f3, downState: down, onUsed: (p, sw) => used.push([p.id, sw]) });
    const c1 = await chain('s', hist), c2 = await chain('s', hist);
    c1.from === 'backup' && c2.from === 'backup' && primary === 1 && backup === 2 && used[0][1] === true ? ok('备用链：主模型 503 后自动切换；冷却期内不再重试主模型') : bad(`备用链异常：primary=${primary} backup=${backup}`);

    // 4.4 全部失败：报错里要说清每个模型的原因；关闭自动切换时只试主模型
    const f4 = async (url) => { throw new TypeError('Failed to fetch'); };
    const allBad = P.makeChain([{ id: 'x', provider: 'qwen', key: 'k' }, { id: 'y', provider: 'moonshot', key: 'k' }], { fetch: f4, downState: {} });
    const e4 = await allBad('s', hist).then(() => null, (e) => e.message);
    e4 && e4.includes('通义千问') && e4.includes('Kimi') && e4.includes('跨域') ? ok('全部失败：错误信息列出每个模型的原因（含跨域提示）') : bad('全部失败的提示不对：' + e4);
    let n5 = 0; const f5 = async () => { n5++; throw new TypeError('x'); };
    await P.makeChain([{ id: 'p', provider: 'qwen', key: 'k' }, { id: 'q', provider: 'moonshot', key: 'k' }], { fetch: f5, downState: {}, failover: false })('s', hist).catch(() => {});
    n5 === 1 ? ok('关闭自动切换时只试主模型') : bad('关闭自动切换后仍在重试');

    // 4.5 错误翻译 + 非 JSON 自动重试一次
    const f6 = async () => mkRes(401, { error: { message: 'Invalid API key' } });
    const e6 = await P.makeAskModel({ id: 'z', provider: 'openai', key: 'bad' }, { fetch: f6 })('s', hist).then(() => '', (e) => e.message);
    e6.includes('Key 无效') ? ok('401 → 「Key 无效或没有权限」') : bad('401 的提示不对：' + e6);
    let n7 = 0; const f7 = async () => (++n7 === 1 ? okOpenAI('抱歉我来解释一下') : okOpenAI('{"ok":1}'));
    const r7 = await P.makeAskModel({ id: 'w', provider: 'deepseek', key: 'k' }, { fetch: f7 })('s', hist);
    r7.ok === 1 && n7 === 2 ? ok('输出不是 JSON 时自动重试一次') : bad('JSON 重试异常');

    // 4.6 .env 解析：多厂商 + 顺序
    const pe = P.profilesFromEnv({ DASHSCOPE_API_KEY: 'a', DEEPSEEK_API_KEY: 'b', LLM_ORDER: 'deepseek,qwen', LLM_API_KEY: 'c', LLM_BASE_URL: 'https://x/v1', LLM_MODEL: 'm1' });
    pe.map((p) => p.id).join(',') === 'deepseek,qwen,custom' ? ok('.env：多个厂商 + 自定义，顺序按 LLM_ORDER') : bad('.env 解析异常：' + pe.map((p) => p.id));

    // 4.7 浏览器引擎包里带上了模型接入层
    const win2 = {}; vm.runInNewContext(bundle(), { window: win2, structuredClone, console });
    win2.AdminAI.providers && win2.AdminAI.providers.PRESETS.length >= 10 ? ok(`浏览器引擎包含 ${win2.AdminAI.providers.PRESETS.length} 个厂商预设`) : bad('浏览器引擎里没有 providers');
  } catch (e) { bad('模型接入层测试抛错：' + e.stack.split('\n').slice(0, 3).join(' | ')); }

  console.log('5. 密钥与敏感信息扫描');
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
