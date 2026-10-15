/* 浏览器里的「后端」：让两个 demo 在纯静态托管（GitHub Pages）上也能完整运行。
 *
 * 做三件事：
 *  1. 拦截页面对 /api/* 的请求，交给打包进来的引擎（shared/engine.browser.js）在浏览器里响应；
 *  2. 默认离线规则模式（不调用任何模型，不需要 key）；
 *  3. 左下角「AI 设置」：访客可保存一个或多个自己的模型（通义千问/DeepSeek/Kimi/智谱/豆包/OpenAI/Claude/Gemini/任意 OpenAI 兼容接口），
 *     由浏览器直接调用厂商接口；可测试连接；主模型出错时自动换用下一个。
 *     key 只保存在访客自己浏览器的 localStorage，不会写进仓库，也不会发给除所选厂商以外的任何地址。
 *
 * 在 localhost 上默认不拦截（交给 node server.js，用 .env 里的 key）；地址加 ?static=1 可强制走浏览器引擎。
 */
(function () {
  var local = ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0;
  var force = new URLSearchParams(location.search).get('static') === '1';
  if (local && !force) return;
  if (!window.AdminAI) { console.error('[api-shim] 没有加载到 engine.browser.js'); return; }

  var P = window.AdminAI.providers;
  var K = { profiles: 'ai-demo.profiles', active: 'ai-demo.active', failover: 'ai-demo.failover' };
  var LEGACY = { key: 'ai-demo.deepseek-key', base: 'ai-demo.base', model: 'ai-demo.model' };
  var store = {
    get: function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* 隐私模式等 */ } },
  };
  var realFetch = window.fetch.bind(window);

  /* ---------- 已保存的模型 ---------- */
  function loadProfiles() { try { return JSON.parse(store.get(K.profiles) || '[]'); } catch (e) { return []; } }
  function saveProfiles(list) { store.set(K.profiles, list.length ? JSON.stringify(list) : ''); }
  // 兼容旧版本（只存了一个 DeepSeek key）：迁移成一个模型
  (function migrate() {
    var old = store.get(LEGACY.key);
    if (old && !loadProfiles().length) {
      saveProfiles([{ id: 'p' + Date.now(), provider: 'deepseek', key: old, base: store.get(LEGACY.base), model: store.get(LEGACY.model) }]);
    }
    if (old) { store.set(LEGACY.key, ''); store.set(LEGACY.base, ''); store.set(LEGACY.model, ''); }
  })();
  function ordered() {
    var act = store.get(K.active), ps = loadProfiles();
    return ps.filter(function (p) { return p.id === act; }).concat(ps.filter(function (p) { return p.id !== act; }));
  }
  var label = function (p) { return P.resolve(p).label; };
  var down = {};          // 出错模型的冷却状态（本页面生命周期内）
  var lastNote = '';      // 例如「已自动切换到 xxx」

  function currentSetup() {
    var ps = ordered();
    if (!ps.length) return { askModel: null, provider: 'mock', providerName: '离线规则模式' };
    var failover = store.get(K.failover) !== '0';
    var ask = P.makeChain(ps, {
      failover: failover, downState: down,
      onUsed: function (p, switched) { lastNote = switched ? '已自动切换到 ' + label(p) : ''; refreshChip(); },
    });
    return { askModel: ask, provider: ps[0].provider, providerName: ps.length > 1 && failover ? label(ps[0]) + '（备用：' + ps.slice(1).map(label).join('、') + '）' : label(ps[0]) };
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== 0) return realFetch(input, init);
    var body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { /* 空请求体 */ }
    var engine = window.AdminAI.createEngine(currentSetup());
    return Promise.resolve(engine.route(url.split('?')[0], body)).then(function (result) {
      if (result == null) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    }).catch(function (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
  };

  /* ---------- 左下角「AI 设置」 ---------- */
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else if (k.slice(0, 2) === 'on') e[k] = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var btn, mask, box, dirtyTransition = false;
  function chipText() { var ps = ordered(); return ps.length ? setup().providerName + (lastNote ? ' · ' + lastNote : '') : '离线规则模式'; }
  function setup() { return currentSetup(); }
  function refreshChip() {
    if (btn) { btn.firstChild.style.background = loadProfiles().length ? '#00b42a' : '#ff7d00'; btn.lastChild.textContent = 'AI 设置 · ' + (loadProfiles().length ? label(ordered()[0]) + (ordered().length > 1 && store.get(K.failover) !== '0' ? ' +备用' : '') : '离线规则模式') + (lastNote ? '（' + lastNote + '）' : ''); }
    var chip = document.getElementById('prov'); if (chip) chip.textContent = chipText();
  }

  var form = { provider: 'qwen' };
  function render() {
    var ps = ordered(), hadAny = ps.length > 0;
    box.innerHTML = '';
    box.appendChild(h('h3', { text: 'AI 设置' }));
    box.appendChild(h('p', { text: hadAny ? '已接入真实 AI。主模型出错时可自动换用下一个，不用手动切换。' : '当前是离线规则模式：不调用任何模型，只能演示内置的常见场景（请假、出差/费用报销等）。添加一个模型即可体验真实 AI。' }));

    if (hadAny) {
      var list = h('div', { class: 'ps' });
      ps.forEach(function (p, i) {
        var res = h('span', { class: 'rs', text: p._res || '' });
        var row = h('div', { class: 'pr' }, [
          h('label', {}, [h('input', { type: 'radio', name: 'act' }), h('b', { text: label(p) }), h('small', { text: ' ' + (P.resolve(p).model || '（未填模型）') }), i === 0 ? h('span', { class: 'tg', text: '主模型' }) : null]),
          h('button', { text: '测试', onclick: function () { res.className = 'rs'; res.textContent = '测试中…'; P.testProfile(p, { fetch: realFetch }).then(function (r) { res.className = 'rs ' + (r.ok ? 'ok' : 'er'); res.textContent = r.ok ? '✓ 可用（' + r.ms + ' ms）' : '✗ ' + r.error; }); } }),
          h('button', { text: '删除', onclick: function () { var rest = loadProfiles().filter(function (x) { return x.id !== p.id; }); saveProfiles(rest); if (store.get(K.active) === p.id) store.set(K.active, ''); dirtyTransition = dirtyTransition || !rest.length; render(); refreshChip(); } }),
          res,
        ]);
        var radio = row.querySelector('input'); radio.checked = i === 0;
        radio.onchange = function () { store.set(K.active, p.id); render(); refreshChip(); };
        list.appendChild(row);
      });
      box.appendChild(list);
      var fo = h('label', { class: 'fo' }, [h('input', { type: 'checkbox' }), ' 主模型出错时，自动换用下一个已保存的模型（出错的模型会暂停使用 3 分钟）']);
      fo.firstChild.checked = store.get(K.failover) !== '0';
      fo.firstChild.onchange = function (e) { store.set(K.failover, e.target.checked ? '1' : '0'); refreshChip(); };
      box.appendChild(fo);
    }

    box.appendChild(h('h4', { text: hadAny ? '添加另一个模型（作为备用或换成它）' : '添加模型' }));
    var pre = P.presetOf(form.provider);
    var sel = h('select', {});
    ['国内', '海外', '其他'].forEach(function (g) {
      var og = h('optgroup', { label: g });
      P.PRESETS.filter(function (x) { return x.group === g; }).forEach(function (x) { var o = h('option', { value: x.id, text: x.name }); if (x.id === form.provider) o.selected = true; og.appendChild(o); });
      sel.appendChild(og);
    });
    sel.onchange = function () { form = { provider: sel.value }; render(); };
    var key = h('input', { type: 'password', placeholder: 'API Key', autocomplete: 'off', id: 'f-key' });
    var model = h('input', { type: 'text', placeholder: pre.model ? '模型名，默认 ' + pre.model : '模型名（必填）', id: 'f-model' });
    var base = h('input', { type: 'text', placeholder: pre.base || 'https://你的服务/v1', id: 'f-base' });
    var advanced = h('details', pre.baseRequired ? { open: 'open' } : {}, [h('summary', { text: '接口地址（一般不用改）' }), base]);
    var msg = h('div', { class: 'msg' });
    function collect() { return { id: 'p' + Date.now(), provider: form.provider, key: key.value.trim(), model: model.value.trim(), base: base.value.trim() }; }
    function problems(p) {
      if (!p.key) return '请填写 API Key';
      if (!(p.model || pre.model)) return '请填写模型名';
      if (!(p.base || pre.base)) return '请填写接口地址';
      return '';
    }
    function commit(p) {
      var was = loadProfiles().length;
      saveProfiles(loadProfiles().concat([p]));
      if (!was) { store.set(K.active, p.id); dirtyTransition = true; }
      render(); refreshChip();
    }
    var save = h('button', { class: 'p', text: '测试并保存', onclick: function () {
      var p = collect(), pr = problems(p); if (pr) { msg.className = 'msg er'; msg.textContent = pr; return; }
      msg.className = 'msg'; msg.textContent = '正在测试连接…'; save.disabled = true;
      P.testProfile(p, { fetch: realFetch }).then(function (r) {
        save.disabled = false;
        if (r.ok) { commit(p); return; }
        msg.className = 'msg er'; msg.textContent = '✗ ' + r.error + '　';
        msg.appendChild(h('a', { href: '#', text: '仍要保存', onclick: function (e) { e.preventDefault(); commit(p); } }));
      });
    } });
    box.appendChild(h('div', { class: 'fm' }, [h('label', { text: '厂商' }), sel, pre.note ? h('div', { class: 'nt', text: pre.note }) : null, h('label', { text: 'Key' }), key, h('label', { text: '模型' }), model, advanced, msg, h('div', { class: 'r' }, [save])]));
    box.appendChild(h('div', { class: 'w', text: 'Key 只保存在你这台电脑的浏览器里，由浏览器直接发给你选择的厂商，不会经过或保存到本网站的任何服务器。公共电脑用完请删除；建议使用额度受限的 key。' }));
    box.appendChild(h('div', { class: 'r' }, [h('button', { text: '关闭', onclick: close })]));
  }
  function close() { mask.style.display = 'none'; if (dirtyTransition) location.reload(); }   // 离线 ↔ 真实模型切换时刷新，让页面按新模式初始化

  function ui() {
    var css = document.createElement('style');
    css.textContent = '#aiset-btn{position:fixed;left:14px;bottom:14px;z-index:9000;font:12px/1 -apple-system,"PingFang SC",sans-serif;background:rgba(31,35,41,.85);color:#fff;border:none;border-radius:16px;padding:7px 12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2);max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#aiset-btn i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px}' +
      '#aiset-mask{position:fixed;inset:0;background:rgba(31,35,41,.45);z-index:9001;display:none;align-items:center;justify-content:center}' +
      '#aiset-box{background:#fff;color:#1f2329;border-radius:12px;width:min(560px,94vw);max-height:90vh;overflow:auto;padding:22px 24px;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.25)}' +
      '#aiset-box h3{margin:0 0 4px;font-size:17px}#aiset-box h4{margin:16px 0 6px;font-size:14px}#aiset-box p{margin:4px 0 8px;color:#646a73;font-size:13px}' +
      '#aiset-box input[type=text],#aiset-box input[type=password],#aiset-box select{width:100%;box-sizing:border-box;border:1px solid #dee0e3;border-radius:8px;padding:8px 12px;font:inherit;margin:3px 0 8px;background:#fff}' +
      '#aiset-box .fm label{font-size:12.5px;color:#646a73}#aiset-box .nt{font-size:12px;color:#3370ff;margin:-4px 0 6px}' +
      '#aiset-box .r{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}' +
      '#aiset-box button{border:1px solid #dee0e3;background:#fff;border-radius:8px;padding:5px 14px;cursor:pointer;font:inherit}#aiset-box button.p{background:#3370ff;border-color:#3370ff;color:#fff}#aiset-box button:disabled{opacity:.5}' +
      '#aiset-box .w{background:#fff7ed;border:1px solid #ffd8a8;color:#d46b08;border-radius:8px;padding:6px 10px;font-size:12.5px;margin-top:10px}' +
      '#aiset-box .pr{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed #e5e6eb;flex-wrap:wrap}#aiset-box .pr label{flex:1 1 220px;min-width:0;display:flex;align-items:center;gap:6px;cursor:pointer;flex-wrap:wrap}#aiset-box .pr button{white-space:nowrap}' +
      '#aiset-box .pr small{color:#8f959e}#aiset-box .tg{background:#e8f0ff;color:#3370ff;font-size:11px;border-radius:8px;padding:0 6px;margin-left:4px;white-space:nowrap}' +
      '#aiset-box .rs{font-size:12px;color:#8f959e;flex-basis:100%;padding-left:22px}#aiset-box .rs:empty{display:none}#aiset-box .rs.ok{color:#00b42a}#aiset-box .rs.er{color:#f54a45}' +
      '#aiset-box .fo{display:block;font-size:12.5px;color:#40454d;margin-top:8px}' +
      '#aiset-box .msg{font-size:12.5px;color:#646a73;min-height:18px}#aiset-box .msg.er{color:#f54a45}#aiset-box details summary{cursor:pointer;font-size:12.5px;color:#646a73}';
    document.head.appendChild(css);
    btn = h('button', { id: 'aiset-btn' }, [h('i'), h('span')]);
    mask = h('div', { id: 'aiset-mask' }); box = h('div', { id: 'aiset-box' }); mask.appendChild(box);
    document.body.appendChild(btn); document.body.appendChild(mask);
    btn.onclick = function () { dirtyTransition = false; render(); mask.style.display = 'flex'; };
    mask.onclick = function (e) { if (e.target === mask) close(); };
    refreshChip();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();
})();
