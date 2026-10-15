// 对话引擎：与运行环境无关的纯逻辑（不依赖 fs / http / process），同一份代码既跑在 Node 服务里，也被打包进浏览器。
//   - 本地：server.js 用它提供 /api/*（可接 .env 里的真模型）
//   - GitHub Pages：scripts/build-static.js 把它打进 shared/engine.browser.js，由 api-shim.js 在浏览器里响应 /api/*
//
// askModel：async (system, history) => 已解析的 JSON 对象；传 null 表示离线，由各 capability 自带的规则解析兜底。
const { CAPABILITIES } = require('./capabilities');
const { handleBuild } = require('./build');
const providers = require('./providers');

function createEngine({ askModel = null, provider = 'mock', providerName = '' } = {}) {
  // ---------- 统一出口 ----------
  // 校验补丁 → 应用 → 服务端计算缺项并生成追问卡片 → 返回结构化结果。
  // status 由服务端判定，不信任模型是否“觉得完成了”。
  function finalize(cap, state, out, ctx, trusted) {
    const { next, touched, rows, errors } = cap.apply(out.patch ?? out.ops, state, { trusted, ctx });
    const force = {};
    for (const e of errors) if (e.field) force[e.field] = e.message;
    for (const c of out.clarify || []) if (c && c.field && !force[c.field]) force[c.field] = String(c.reason || '请再确认一下');
    const questions = cap.questions(next, force, { suggestions: out.suggestions, context: ctx, offline: !askModel });
    const asked = new Set(questions.map((q) => q.field));
    return {
      status: questions.length ? 'need_info' : 'ready',
      reply: String(out.reply || ''),
      changed: touched.length > 0,
      touched, rows, next, questions,
      missing: cap.missing(next),
      errors: errors.filter((e) => !e.field || !asked.has(e.field)).map((e) => e.message),
    };
  }

  function getCap(body) {
    const cap = CAPABILITIES[body.capability];
    if (!cap) throw new Error('unknown capability');
    return cap;
  }

  async function chat(body) {
    const cap = getCap(body);
    const state = body.config || cap.empty();
    const ctx = body.context || {};
    const history = (body.messages || []).slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
    const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';
    let out;
    try {
      out = askModel ? await askModel(cap.promptSpec(state, ctx), history) : cap.mock(lastUser, state, ctx);
    } catch (e) {
      return { status: 'error', reply: `模型调用失败：${e.message}`, questions: [], missing: cap.missing(state), errors: [], rows: [], touched: [], changed: false, next: state };
    }
    return finalize(cap, state, out, ctx, false);   // 模型输出一律不可信
  }

  // 管理员点选卡片后的回答：不经过模型，由服务端翻译成补丁再走同一套校验
  function answer(body) {
    const cap = getCap(body);
    const state = body.config || cap.empty();
    const patch = cap.answersToPatch(body.answers || {}, state);
    // reask：管理员想回头改某一项——把这些字段强制重新生成成追问
    const clarify = (body.reask || []).map((f) => ({ field: String(f), reason: '重新确认这一项' }));
    return finalize(cap, state, { reply: '', patch, clarify }, body.context || {}, true);
  }

  // 向导里的「问问 AI」：用大白话解释当前这一题，不替管理员做决定
  async function help(body) {
    if (!askModel) return { reply: null };           // 离线：由前端用内置讲解兜底
    const c = body.context || {};
    const system = `你是企业审批配置向导里的「AI 教练」，面向完全不懂配置的行政/HR。管理员正在回答这一题：「${String(body.title || '').slice(0, 80)}」（所属步骤：${String(body.step || '')}）。
当前审批：${JSON.stringify({ name: c.name, category: c.category })}。
${body.options ? `可选项：${JSON.stringify(body.options).slice(0, 600)}` : ''}
请用大白话回答他的疑问，不超过 120 字：先直接回答，再结合这个审批举一个具体例子；如果有选项，说明各自适合什么情况，并说出你倾向哪个、为什么，但不要替他决定。
只输出一个 JSON：{"reply":"..."}`;
    try {
      const out = await askModel(system, [{ role: 'user', content: String(body.text || '').slice(0, 300) }]);
      return { reply: String(out.reply || '').slice(0, 400) || null };
    } catch (e) { return { reply: null, error: e.message }; }
  }

  const build = (body) => handleBuild(body, askModel);

  const meta = () => ({
    provider,
    providerName: providerName || (askModel ? provider : '离线规则模式'),
    caps: Object.fromEntries(Object.entries(CAPABILITIES).map(([k, c]) => [k, { title: c.title, empty: c.empty(), labels: c.labels || {} }])),
  });

  // 统一路由：path 形如 '/api/chat'，供 server.js 与浏览器里的 api-shim.js 共用
  async function route(path, body) {
    switch (path) {
      case '/api/meta': return meta();
      case '/api/chat': return chat(body);
      case '/api/answer': return answer(body);
      case '/api/build': return build(body);
      case '/api/help': return help(body);
      default: return null;
    }
  }
  return { meta, chat, answer, build, help, route };
}

module.exports = { createEngine, providers };
