/* 浏览器里的「后端」：让两个 demo 在纯静态托管（GitHub Pages）上也能完整运行。
 *
 * 做三件事：
 *  1. 拦截页面对 /api/* 的请求，交给打包进来的引擎（shared/engine.browser.js）在浏览器里响应；
 *  2. 默认离线规则模式（不调用任何模型，不需要 key）；
 *  3. 访客可在左下角「AI 设置」里填自己的 DeepSeek key，之后由浏览器直接调用 DeepSeek（官方接口允许跨域）。
 *     key 只保存在访客自己浏览器的 localStorage，不会写进仓库，也不会发给除 DeepSeek 以外的任何地址。
 *
 * 在 localhost 上默认不拦截（交给 node server.js，可用 .env 里的 key）；地址加 ?static=1 可强制走浏览器引擎。
 */
(function () {
  var local = ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0;
  var force = new URLSearchParams(location.search).get('static') === '1';
  if (local && !force) return;
  if (!window.AdminAI) { console.error('[api-shim] 没有加载到 engine.browser.js'); return; }

  var K = { key: 'ai-demo.deepseek-key', base: 'ai-demo.base', model: 'ai-demo.model' };
  var store = {
    get: function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* 隐私模式等 */ } },
  };
  var realFetch = window.fetch.bind(window);

  function parseJson(text) {
    var m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型没有返回 JSON');
    return JSON.parse(m[0]);
  }

  // 浏览器直连 DeepSeek（OpenAI 兼容接口）；格式不对自动重试一次，与 server.js 行为一致
  function makeAskModel() {
    var key = store.get(K.key);
    if (!key) return null;
    var base = (store.get(K.base) || 'https://api.deepseek.com').replace(/\/$/, '');
    var model = store.get(K.model) || 'deepseek-chat';
    function call(system, messages) {
      return realFetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: model, messages: [{ role: 'system', content: system }].concat(messages), response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 2048 }),
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j.error && j.error.message) || ('接口错误 ' + r.status));
          return j.choices[0].message.content;
        });
      });
    }
    return function (system, history) {
      return call(system, history).then(parseJson).catch(function (e) {
        if (!/JSON/.test(e.message)) throw e;
        return call(system, history.concat([{ role: 'user', content: '上一次输出不是合法 JSON，请严格只输出一个 JSON 对象。' }])).then(parseJson);
      });
    };
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== 0) return realFetch(input, init);
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { /* 空请求体 */ }
    var hasKey = !!store.get(K.key);
    var engine = window.AdminAI.createEngine({ askModel: makeAskModel(), provider: hasKey ? 'deepseek' : 'mock' });
    return Promise.resolve(engine.route(url.split('?')[0], body)).then(function (result) {
      if (result == null) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }).catch(function (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
  };

  /* ---------- 左下角「AI 设置」----------- */
  function ui() {
    var hasKey = !!store.get(K.key);
    var css = document.createElement('style');
    css.textContent = '#aiset-btn{position:fixed;left:14px;bottom:14px;z-index:9000;font:12px/1 -apple-system,"PingFang SC",sans-serif;background:rgba(31,35,41,.82);color:#fff;border:none;border-radius:16px;padding:7px 12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2)}' +
      '#aiset-btn i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:' + (hasKey ? '#00b42a' : '#ff7d00') + '}' +
      '#aiset-mask{position:fixed;inset:0;background:rgba(31,35,41,.45);z-index:9001;display:none;align-items:center;justify-content:center}' +
      '#aiset-box{background:#fff;color:#1f2329;border-radius:12px;width:min(460px,92vw);padding:22px 24px;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.25)}' +
      '#aiset-box h3{margin:0 0 6px;font-size:16px}#aiset-box p{margin:6px 0;color:#646a73;font-size:13px}' +
      '#aiset-box input{width:100%;box-sizing:border-box;border:1px solid #dee0e3;border-radius:8px;padding:9px 12px;font:inherit;margin:8px 0}' +
      '#aiset-box .r{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}' +
      '#aiset-box button{border:1px solid #dee0e3;background:#fff;border-radius:8px;padding:6px 16px;cursor:pointer;font:inherit}#aiset-box button.p{background:#3370ff;border-color:#3370ff;color:#fff}' +
      '#aiset-box .w{background:#fff7ed;border:1px solid #ffd8a8;color:#d46b08;border-radius:8px;padding:6px 10px;font-size:12.5px}';
    document.head.appendChild(css);
    var btn = document.createElement('button');
    btn.id = 'aiset-btn';
    btn.innerHTML = '<i></i>AI 设置 · ' + (hasKey ? 'DeepSeek' : '离线规则模式');
    var mask = document.createElement('div');
    mask.id = 'aiset-mask';
    mask.innerHTML = '<div id="aiset-box"><h3>AI 设置</h3>' +
      '<p>当前：<b>' + (hasKey ? '已接入 DeepSeek（真实 AI）' : '离线规则模式') + '</b>。离线模式不调用任何模型，只能演示内置的常见场景（请假、出差/费用报销等）。</p>' +
      '<p>想体验真实 AI？填入你自己的 DeepSeek API Key：</p>' +
      '<input id="aiset-key" type="password" placeholder="sk-…" autocomplete="off">' +
      '<div class="w">key 只保存在你这台电脑的浏览器里，由浏览器直接发给 DeepSeek，不会经过或保存到本网站的任何服务器。公共电脑请用完点「清除」；建议使用额度受限的 key。</div>' +
      '<div class="r"><button id="aiset-x">取消</button><button id="aiset-clear">清除</button><button class="p" id="aiset-ok">保存并刷新</button></div></div>';
    document.body.appendChild(btn);
    document.body.appendChild(mask);
    btn.onclick = function () { mask.style.display = 'flex'; document.getElementById('aiset-key').focus(); };
    mask.onclick = function (e) { if (e.target === mask) mask.style.display = 'none'; };
    document.getElementById('aiset-x').onclick = function () { mask.style.display = 'none'; };
    document.getElementById('aiset-clear').onclick = function () { store.set(K.key, ''); location.reload(); };
    document.getElementById('aiset-ok').onclick = function () {
      var v = document.getElementById('aiset-key').value.trim();
      if (v) { store.set(K.key, v); location.reload(); } else mask.style.display = 'none';
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();
})();
