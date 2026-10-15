// 本地演示服务（零依赖）：同时提供两个 demo 和 /api/*，可接 .env 里的真实模型。
//   npm run dev  →  http://localhost:3000/            入口页
//                   http://localhost:3000/oneshot/    一句话搭建版（适合放在后台里）
//                   http://localhost:3000/guided/     逐步引导版（适合放在 AI 助手里）
//
// 模型在 .env 里配置，配几个就用几个（详见 .env.example）：
//   - 每个厂商一个 key：DASHSCOPE_API_KEY(通义千问/百炼)、DEEPSEEK_API_KEY、MOONSHOT_API_KEY、ZHIPU_API_KEY、ARK_API_KEY、
//     SILICONFLOW_API_KEY、OPENAI_API_KEY、ANTHROPIC_API_KEY、GEMINI_API_KEY、OPENROUTER_API_KEY、GROQ_API_KEY
//   - 任意 OpenAI 兼容服务：LLM_API_KEY + LLM_BASE_URL + LLM_MODEL
//   - 配了多个时，主模型出错会自动换下一个（LLM_FAILOVER=0 关闭；LLM_ORDER=qwen,deepseek 指定顺序）
//   - 一个都没配则离线规则模式
// 线上网站（GitHub Pages）不使用这个文件，见 scripts/build-static.js 与 site/shared/api-shim.js。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEngine, providers } = require('./src/engine');
const { bundle } = require('./scripts/bundle');

// 零依赖读取 .env（KEY=VALUE），已存在的环境变量优先
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 没有 .env 就算了 */ }

const PORT = process.env.PORT || 3000;
const SITE = path.join(__dirname, 'site');
const downState = {};        // 出错模型的冷却状态，跨请求保留：主模型挂了之后，后续请求直接走备用，不再每次先等它超时

function modelSetup() {
  const list = providers.profilesFromEnv(process.env);
  if (!list.length) return { askModel: null, provider: 'mock', providerName: '离线规则模式' };
  const failover = process.env.LLM_FAILOVER !== '0';
  const names = list.map((p) => providers.resolve(p).label);
  const askModel = providers.makeChain(list, {
    failover, downState,
    onUsed: (p, switched) => { if (switched) console.log(`[模型] 主模型出错，已自动切换到 ${providers.resolve(p).label}`); },
  });
  return { askModel, provider: list[0].id, providerName: list.length > 1 && failover ? `${names[0]}（备用：${names.slice(1).join('、')}）` : names[0] };
}

// ---------- static + routing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => ok(raw)); });

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) {
      const engine = createEngine(modelSetup());
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      const result = await engine.route(url, body);
      return result == null ? json(res, 404, { error: 'not found' }) : json(res, 200, result);
    }
  } catch (e) { return json(res, 400, { error: e.message }); }

  if (url === '/shared/engine.browser.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); return res.end(bundle()); }
  let rel = decodeURIComponent(url);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(SITE, rel);
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end('forbidden'); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) { res.writeHead(301, { location: url + '/' }); return res.end(); }
  if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`AI 配置 demo（模型：${modelSetup().providerName}）\n  入口页      http://localhost:${PORT}/\n  一句话搭建  http://localhost:${PORT}/oneshot/\n  逐步引导    http://localhost:${PORT}/guided/`));
