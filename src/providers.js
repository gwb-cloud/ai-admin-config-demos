// 模型接入层：与运行环境无关（只依赖全局 fetch），Node 本地服务和浏览器共用同一份。
//   - 预设了国内外常见厂商；任何「OpenAI 兼容接口」都可以用「自定义」接入
//   - 自动适应各家对参数的差异（不支持 JSON 模式、要求 max_completion_tokens、不接受 temperature 等）
//   - 多个模型可组成「备用链」：主模型出错自动换下一个，并对出错的模型短暂冷却，避免每次都先等它超时
//
// profile = { id, provider(预设 id), name?, key, base?, model? }   base/model 为空则用预设默认值

const PRESETS = [
  { id: 'qwen', name: '通义千问（阿里云百炼）', group: '国内', protocol: 'openai', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', envPrefix: 'DASHSCOPE', envKeys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'], note: '百炼控制台 → API-KEY' },
  { id: 'deepseek', name: 'DeepSeek', group: '国内', protocol: 'openai', base: 'https://api.deepseek.com', model: 'deepseek-chat', envPrefix: 'DEEPSEEK', envKeys: ['DEEPSEEK_API_KEY'] },
  { id: 'moonshot', name: 'Kimi（月之暗面）', group: '国内', protocol: 'openai', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', envPrefix: 'MOONSHOT', envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { id: 'zhipu', name: '智谱 GLM', group: '国内', protocol: 'openai', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', envPrefix: 'ZHIPU', envKeys: ['ZHIPU_API_KEY'] },
  { id: 'ark', name: '豆包（火山方舟）', group: '国内', protocol: 'openai', base: 'https://ark.cn-beijing.volces.com/api/v3', model: '', modelRequired: true, envPrefix: 'ARK', envKeys: ['ARK_API_KEY'], note: '「模型」处填推理接入点 ID，形如 ep-xxxxxxxx' },
  { id: 'siliconflow', name: '硅基流动', group: '国内', protocol: 'openai', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', envPrefix: 'SILICONFLOW', envKeys: ['SILICONFLOW_API_KEY'] },
  { id: 'openai', name: 'OpenAI', group: '海外', protocol: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', envPrefix: 'OPENAI', envKeys: ['OPENAI_API_KEY'] },
  { id: 'anthropic', name: 'Claude（Anthropic）', group: '海外', protocol: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001', envPrefix: 'ANTHROPIC', envKeys: ['ANTHROPIC_API_KEY'] },
  { id: 'gemini', name: 'Gemini（Google）', group: '海外', protocol: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', envPrefix: 'GEMINI', envKeys: ['GEMINI_API_KEY'] },
  { id: 'openrouter', name: 'OpenRouter（聚合多家模型）', group: '海外', protocol: 'openai', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', envPrefix: 'OPENROUTER', envKeys: ['OPENROUTER_API_KEY'] },
  { id: 'groq', name: 'Groq', group: '海外', protocol: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', envPrefix: 'GROQ', envKeys: ['GROQ_API_KEY'] },
  { id: 'custom', name: '自定义（OpenAI 兼容接口）', group: '其他', protocol: 'openai', base: '', model: '', baseRequired: true, modelRequired: true, note: '任何兼容 OpenAI chat/completions 的服务：填接口地址（到 /v1 为止）和模型名' },
];
const presetOf = (id) => PRESETS.find((p) => p.id === id) || PRESETS[PRESETS.length - 1];
const resolve = (p) => { const pre = presetOf(p.provider); return { ...p, protocol: pre.protocol, base: (p.base || pre.base || '').replace(/\/+$/, ''), model: p.model || pre.model || '', label: p.name || (pre.id === 'custom' ? `自定义 · ${p.model || '未命名'}` : pre.name) }; };

// ---------- 错误：翻译成人话 ----------
function friendly(status, msg, network) {
  if (network) return '网络请求失败：可能网络不通，或该服务不允许浏览器直接访问（跨域）。本地运行（npm run dev）可以绕开跨域限制';
  if (status === 401 || status === 403) return `Key 无效或没有权限（${status}）${msg ? '：' + String(msg).slice(0, 80) : ''}`;
  if (status === 404) return `接口地址或模型名不对（404）${msg ? '：' + String(msg).slice(0, 80) : ''}`;
  if (status === 429) return '请求太频繁或额度已用完（429）';
  if (status >= 500) return `服务暂时不可用（${status}）`;
  return `${msg || '请求失败'}${status ? `（${status}）` : ''}`;
}
class ModelError extends Error { constructor(message, status, kind) { super(message); this.status = status; this.kind = kind; } }

// 记住每个模型学到的参数适配，避免每次都先失败一遍
const learned = {};

async function callOnce(profile, system, messages, tweaks, fetchImpl, timeoutMs) {
  const p = resolve(profile);
  if (!p.key) throw new ModelError('没有填写 Key', 0, 'config');
  if (!p.base) throw new ModelError('没有填写接口地址', 0, 'config');
  if (!p.model) throw new ModelError('没有填写模型名', 0, 'config');
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let url, headers, body;
  if (p.protocol === 'anthropic') {
    url = p.base + '/v1/messages';
    headers = { 'content-type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
    body = { model: p.model, max_tokens: 2048, system, messages };
  } else {
    url = p.base + '/chat/completions';
    headers = { 'content-type': 'application/json', authorization: `Bearer ${p.key}` };
    body = { model: p.model, messages: [{ role: 'system', content: system }, ...messages] };
    body[tweaks.maxCompletion ? 'max_completion_tokens' : 'max_tokens'] = 2048;
    if (!tweaks.noTemp) body.temperature = 0.2;
    if (!tweaks.noJsonMode) body.response_format = { type: 'json_object' };
  }
  let r;
  try { r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl?.signal }); }
  catch (e) {
    if (e && e.name === 'AbortError') throw new ModelError(`响应超时（>${Math.round(timeoutMs / 1000)} 秒）`, 0, 'timeout');
    throw new ModelError(friendly(0, '', true), 0, 'network');
  } finally { if (timer) clearTimeout(timer); }
  let j = null, raw = '';
  try { raw = await r.text(); j = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }
  if (!r.ok) {
    const msg = (j && (j.error?.message || j.message || (typeof j.error === 'string' ? j.error : ''))) || raw.slice(0, 120);
    const e = new ModelError(friendly(r.status, msg), r.status, 'http'); e.raw = String(msg); throw e;
  }
  const text = p.protocol === 'anthropic' ? (j?.content || []).map((c) => c.text || '').join('') : j?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new ModelError('模型返回的内容格式不对', 0, 'format');
  return text;
}

// 遇到「参数不被接受」的 400：调整参数后重试（最多 3 次调整）
async function callAdaptive(profile, system, messages, fetchImpl, timeoutMs) {
  const tweaks = learned[profile.id] ||= {};
  for (let i = 0; i < 4; i++) {
    try { return await callOnce(profile, system, messages, tweaks, fetchImpl, timeoutMs); }
    catch (e) {
      if (!(e.status === 400 || e.status === 422)) throw e;
      const m = e.raw || e.message;
      if (!tweaks.noJsonMode && /response_format|json_object|json mode|json_schema|不支持.*json/i.test(m)) tweaks.noJsonMode = true;
      else if (!tweaks.maxCompletion && /max_tokens.*max_completion_tokens|max_completion_tokens/i.test(m)) tweaks.maxCompletion = true;
      else if (!tweaks.noTemp && /temperature/i.test(m)) tweaks.noTemp = true;
      else throw e;
    }
  }
  throw new ModelError('参数适配失败', 400, 'http');
}

function parseJsonLoose(text) {
  const m = String(text).replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!m) throw new ModelError('模型没有返回 JSON', 0, 'json');
  try { return JSON.parse(m[0]); } catch { throw new ModelError('模型返回的 JSON 无法解析', 0, 'json'); }
}

// 单个模型：返回 async (system, history) => 对象；输出不是合法 JSON 时自动再要一次
function makeAskModel(profile, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs || 45000;
  return async (system, history) => {
    try { return parseJsonLoose(await callAdaptive(profile, system, history, fetchImpl, timeoutMs)); }
    catch (e) {
      if (e.kind !== 'json') throw e;
      return parseJsonLoose(await callAdaptive(profile, system, [...history, { role: 'user', content: '上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。' }], fetchImpl, timeoutMs));
    }
  };
}

// 备用链：按顺序尝试；出错的模型冷却 3 分钟（期间排到最后），所以主模型挂了不会每次都白等一遍
function makeChain(profiles, opts = {}) {
  const failover = opts.failover !== false;
  const cooldown = opts.cooldownMs ?? 180000;
  const down = opts.downState || {};              // { [profileId]: 解封时间戳 }，由调用方持有，跨请求保留
  const list = profiles.filter((p) => p && p.key);
  if (!list.length) return null;
  const asks = new Map(list.map((p) => [p.id, makeAskModel(p, opts)]));
  return async (system, history) => {
    const now = Date.now();
    const healthy = list.filter((p) => !(down[p.id] > now)), cooling = list.filter((p) => down[p.id] > now);
    const order = failover ? [...healthy, ...cooling] : [list[0]];
    const errors = [];
    for (const p of order) {
      try {
        const out = await asks.get(p.id)(system, history);
        delete down[p.id];
        if (opts.onUsed) opts.onUsed(p, errors.length > 0);
        return out;
      } catch (e) {
        const lab = resolve(p).label;
        errors.push(`${lab}：${e.message}`);
        if (e.kind !== 'json') down[p.id] = Date.now() + cooldown;
        if (!failover) break;
      }
    }
    throw new Error(errors.join('；'));
  };
}

// 测试连接：发一个极小的请求，返回 { ok, ms, error }
async function testProfile(profile, opts = {}) {
  const t0 = Date.now();
  try {
    const out = await makeAskModel(profile, { ...opts, timeoutMs: opts.timeoutMs || 25000 })('你是连通性测试。只输出一个 JSON 对象。', [{ role: 'user', content: '请回复：{"ok":true}' }]);
    return { ok: !!out, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
}

// 从环境变量（.env）解析出模型列表。约定：<前缀>_API_KEY / _MODEL / _BASE_URL；自定义用 LLM_API_KEY + LLM_BASE_URL + LLM_MODEL；
// LLM_ORDER=qwen,deepseek 指定尝试顺序，不写则按预设顺序。
function profilesFromEnv(env) {
  const list = [];
  for (const p of PRESETS) {
    if (p.id === 'custom') continue;
    const key = p.envKeys.map((k) => env[k]).find(Boolean);
    if (key) list.push({ id: p.id, provider: p.id, key, model: env[`${p.envPrefix}_MODEL`] || '', base: env[`${p.envPrefix}_BASE_URL`] || '' });
  }
  if (env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL) list.push({ id: 'custom', provider: 'custom', key: env.LLM_API_KEY, base: env.LLM_BASE_URL, model: env.LLM_MODEL, name: env.LLM_NAME || '自定义模型' });
  const order = String(env.LLM_ORDER || '').split(',').map((s) => s.trim()).filter(Boolean);
  list.sort((a, b) => { const ia = order.indexOf(a.id), ib = order.indexOf(b.id); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  return list;
}

module.exports = { PRESETS, presetOf, resolve, makeAskModel, makeChain, testProfile, profilesFromEnv, parseJsonLoose, ModelError };
