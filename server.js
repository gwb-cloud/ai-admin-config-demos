// 本地演示服务（零依赖）：同时提供两个 demo 和 /api/*，可接 .env 里的真实模型。
//   npm run dev  →  http://localhost:3000/            入口页
//                   http://localhost:3000/oneshot/    一句话搭建版（适合放在后台里）
//                   http://localhost:3000/guided/     逐步引导版（适合放在 AI 助手里）
// 模型选择（.env）：DEEPSEEK_API_KEY → Claude(ANTHROPIC_API_KEY) → 百炼(DASHSCOPE_API_KEY) → 都没有则离线规则模式
// 线上网站（GitHub Pages）不使用这个文件，见 scripts/build-static.js 与 site/shared/api-shim.js。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEngine } = require('./src/engine');
const { bundle } = require('./scripts/bundle');

// 零依赖读取 .env（KEY=VALUE），已存在的环境变量优先
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 没有 .env 就算了 */ }

const PORT = process.env.PORT || 3000;
const SITE = path.join(__dirname, 'site');
const provider = () => (process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.ANTHROPIC_API_KEY ? 'claude' : process.env.DASHSCOPE_API_KEY ? 'qwen' : 'mock');

// ---------- LLM providers ----------
async function callAnthropic(system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 2048, system, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'anthropic error');
  return j.content.map((c) => c.text || '').join('');
}
// DeepSeek / 百炼 都是 OpenAI 兼容接口
async function callOpenAICompat(url, key, model, system, messages) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 2048 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `${model} error ${r.status}`);
  return j.choices[0].message.content;
}
const callDeepseek = (sys, msgs) => callOpenAICompat((process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/chat/completions', process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_MODEL || 'deepseek-chat', sys, msgs);
const callDashscope = (sys, msgs) => callOpenAICompat('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', process.env.DASHSCOPE_API_KEY, process.env.DASHSCOPE_MODEL || 'qwen-plus', sys, msgs);

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没有返回 JSON');
  return JSON.parse(m[0]);
}
// 调用当前配置的模型，返回解析后的 JSON；格式不对自动重试一次。离线模式返回 null
const makeAskModel = () => {
  const p = provider();
  if (p === 'mock') return null;
  const call = { deepseek: callDeepseek, claude: callAnthropic, qwen: callDashscope }[p];
  return async (system, history) => {
    try { return parseJson(await call(system, history)); }
    catch (e) { if (!/JSON/.test(e.message)) throw e; return parseJson(await call(system, [...history, { role: 'user', content: '上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。' }])); }
  };
};

// ---------- static + routing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => ok(raw)); });

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) {
      const engine = createEngine({ askModel: makeAskModel(), provider: provider() });
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      const result = await engine.route(url, body);
      return result == null ? json(res, 404, { error: 'not found' }) : json(res, 200, result);
    }
  } catch (e) { return json(res, 400, { error: e.message }); }

  if (url === '/shared/engine.browser.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); return res.end(bundle()); }
  let rel = decodeURIComponent(url);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(SITE, rel);
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end('forbidden'); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) { res.writeHead(301, { location: url + '/' }); return res.end(); }
  if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`AI 配置 demo（模型：${provider()}）\n  入口页      http://localhost:${PORT}/\n  一句话搭建  http://localhost:${PORT}/oneshot/\n  逐步引导    http://localhost:${PORT}/guided/`));
