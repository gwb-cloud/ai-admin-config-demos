// ③ 审批流 · 配置流程
// 与真实后台「配置审批流 → 配置流程」对齐（节点：审批人 / 通知 / 条件分支；固定的 发起 / 结束）。
// 接口与 capabilities.js 中其他 capability 完全一致，对话层/前端不用改。
//
// 状态是一棵树：
//   { nodes:[node], repeatApprover:null|'once'|'each', startCc:[person], endCc:[person], confirmed:false }
//   node = approval{ approver, emptyApprover, emptyMembers, multiMode, sameAsSubmitter }
//        | notify{ recipients:[person] }
//        | branch{ branches:[{id,name,groups:[[cond]],nodes}], def:{id,nodes} }   // def = 固定的「其他情况」
//   person = { type, members:[姓名], role }      cond = { id, field, op, value }

module.exports = ({ DIRECTORY, uniq, same }) => {
  const DEPTS = ['产品部', '研发部', '财务部', '行政部', '人事部'];
  const ROLES = ['部门经理', '财务总监', '总经理', 'HRBP', '行政主管'];
  const PERSON = { members: '指定成员', self: '发起人自己', role: '职务角色', manager: '直属上级', deptHead: '部门负责人' };
  const EMPTY = { autoPass: '自动通过', specified: '指定人员审批', admin: '转交给审批模板管理员' };
  const MULTI = { all: '会签（需所有审批人同意）', any: '或签（任一审批人同意即可）' };
  const SAME = { self: '由提交人对自己审批', skip: '自动跳过', manager: '转交给直属上级审批', deptHead: '转交给部门负责人审批' };
  const REPEAT = { once: '仅审批一次，后续重复的审批节点均自动同意', each: '不自动同意，每个节点都需要审批' };
  const OPS = { eq: '等于', lt: '小于', lte: '小于等于', gt: '大于', gte: '大于等于', neq: '不等于', in: '属于' };
  const CMP = ['eq', 'lt', 'lte', 'gt', 'gte', 'neq'];
  const NODE_KINDS = ['approval', 'notify', 'branch'];
  const MAX_NODES = 30;

  // ---------- 树工具 ----------
  function* walk(list) {
    for (const n of list) {
      yield n;
      if (n.kind === 'branch') { for (const b of n.branches) yield* walk(b.nodes); yield* walk(n.def.nodes); }
    }
  }
  const allNodes = (s) => [...walk(s.nodes)];

  function locate(s, id) {
    if (['flow', 'start', 'end'].includes(id)) return { t: id };
    let res = null;
    const visit = (list) => {
      for (const n of list) {
        if (res) return;
        if (n.id === id) { res = { t: 'node', n, list }; return; }
        if (n.kind === 'branch') {
          for (const b of n.branches) {
            if (b.id === id) { res = { t: 'branch', b, n }; return; }
            for (const g of b.groups) for (const c of g) if (c.id === id) { res = { t: 'cond', c, b, n, g }; return; }
            visit(b.nodes);
          }
          if (n.def.id === id) { res = { t: 'def', n }; return; }
          visit(n.def.nodes);
        }
      }
    };
    visit(s.nodes);
    return res;
  }

  // 展示名（用户可见、可被指代）：没起名的按类型编号
  function names(s) {
    const m = {};
    let a = 0, nf = 0, bn = 0, br = 0;
    const visit = (list) => {
      for (const n of list) {
        if (n.kind === 'approval') m[n.id] = n.name || `审批${++a}`;
        else if (n.kind === 'notify') m[n.id] = n.name || `通知${++nf}`;
        else {
          m[n.id] = n.name || `条件分支节点${++bn}`;
          for (const b of n.branches) { m[b.id] = b.name || `条件分支${++br}`; visit(b.nodes); }
          m[n.def.id] = '其他情况'; visit(n.def.nodes);
        }
      }
    };
    visit(s.nodes);
    return m;
  }

  const fieldInfo = (ctx, id) => {
    if (id === 'initiator.dept') return { id, label: '发起人所在部门', type: 'dept' };
    if (id === 'initiator.role') return { id, label: '发起人的角色', type: 'role' };
    // 既可以用字段 id，也可以用字段名称引用（一次性搭建时表单字段 id 还没生成，模型只能写名称）
    const f = (ctx?.form || []).find((x) => (x.id === id || x.label === id) && ['money', 'number', 'date', 'select'].includes(x.type));
    return f ? { id: f.id, label: f.label, type: f.type, options: f.options || [], currency: f.currency } : null;
  };
  const condFieldOptions = (ctx) => [
    { value: 'initiator.dept', label: '发起人所在部门' },
    { value: 'initiator.role', label: '发起人的角色' },
    ...(ctx?.form || []).filter((f) => ['money', 'number', 'date', 'select'].includes(f.type)).map((f) => ({ value: f.id, label: f.label, hint: { money: '金额', number: '数字', date: '日期', select: '单选' }[f.type] })),
  ];

  // ---------- 文字摘要 ----------
  const ptext = (p) => !p ? '待确认' : p.type === 'members' ? (p.members.join('、') || '成员待选') : p.type === 'role' ? `${p.role || '角色待选'}（职务角色）` : PERSON[p.type];
  const vtext = (c, info) => c.value == null ? '待确认' : Array.isArray(c.value) ? c.value.join('、') : (info?.type === 'money' ? `${c.value}${info.currency ? ' ' + info.currency : ''}` : String(c.value));
  const ctext = (c, ctx) => { const i = fieldInfo(ctx, c.field); return `${i?.label || '字段待确认'} ${OPS[c.op] || '运算符待确认'} ${vtext(c, i)}`; };
  const sumApproval = (n) => [`审批人：${ptext(n.approver)}`,
    n.emptyApprover && `为空时：${EMPTY[n.emptyApprover]}${n.emptyApprover === 'specified' ? '（' + (n.emptyMembers.join('、') || '人员待选') + '）' : ''}`,
    n.multiMode && `多人：${MULTI[n.multiMode].slice(0, 2)}`,
    n.sameAsSubmitter && `同一人：${SAME[n.sameAsSubmitter]}`].filter(Boolean).join(' · ');
  const sumNode = (n) => n.kind === 'approval' ? sumApproval(n) : n.kind === 'notify' ? `抄送：${n.recipients.map(ptext).join('；') || '待确认'}` : `${n.branches.length} 个条件分支 + 其他情况`;
  const sumBranch = (b, ctx) => b.groups.length ? b.groups.map((g) => g.map((c) => ctext(c, ctx)).join(' 且 ')).join(' 或 ') : '条件待确认';

  // 方案（不是管理员亲口说的）里的条件取值/人员名单一律剥掉，只留结构，具体值由系统追问——防止模型用 0、示例人名等占位值悄悄「默认」
  const stripGuess = (o) => Array.isArray(o) ? o.map(stripGuess)
    : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'value' && k !== 'members').map(([k, v]) => [k, stripGuess(v)])) : o;
  const normSug = (x) => (x && typeof x.label === 'string' && x.label.trim() && Array.isArray(x.ops) && x.ops.length)
    ? { label: x.label.trim().slice(0, 30), desc: String(x.desc || '').slice(0, 60), ops: stripGuess(x.ops.filter((o) => o && typeof o === 'object' && o.op !== 'confirm').slice(0, 20)) } : null;

  const fallbackTemplates = (ctx) => {
    const money = (ctx?.form || []).find((f) => f.type === 'money');
    const ap = (person) => ({ op: 'add', node: { kind: 'approval', approver: person } });
    const t = [
      { label: '直属上级审批', desc: '发起人的直属上级审批', ops: [ap({ type: 'manager' })] },
      { label: '部门负责人审批', desc: '发起人所在部门的负责人审批', ops: [ap({ type: 'deptHead' })] },
      { label: '直属上级 → 财务总监', desc: '先直属上级，再由职务角色「财务总监」审批', ops: [ap({ type: 'manager' }), ap({ type: 'role', role: '财务总监' })] },
    ];
    if (money) t.push({ label: '按金额分级审批', desc: `直属上级审批；「${money.label}」满足条件时再加财务总监（具体条件数值稍后问你）`, ops: [ap({ type: 'manager' }), { op: 'add', node: { kind: 'branch', branches: [{ name: '大额', conditions: [[{ field: money.id }]], nodes: [{ kind: 'approval', approver: { type: 'role', role: '财务总监' } }] }] } }] });
    return t;
  };

  // ---------- capability ----------
  return {
    title: '审批流 · 配置流程',
    empty: () => ({ nodes: [], repeatApprover: null, startCc: [], endCc: [], confirmed: false }),

    missing(s) {
      const m = [];
      const nodes = allNodes(s);
      if (!nodes.some((n) => n.kind === 'approval')) m.push('flow.nodes');
      const personMissing = (p, prefix) => {
        if (p.type === 'members' && !p.members.length) m.push(`${prefix}.members`);
        if (p.type === 'role' && !p.role) m.push(`${prefix}.role`);
      };
      for (const n of nodes) {
        if (n.kind === 'approval') {
          const p = n.approver;
          if (!p) m.push(`${n.id}.approver`);
          else {
            personMissing(p, `${n.id}.approver`);
            if (['manager', 'deptHead', 'role'].includes(p.type)) {
              if (!n.emptyApprover) m.push(`${n.id}.emptyApprover`);
              else if (n.emptyApprover === 'specified' && !n.emptyMembers.length) m.push(`${n.id}.emptyMembers`);
            }
            if ((p.type === 'role' || (p.type === 'members' && p.members.length > 1)) && !n.multiMode) m.push(`${n.id}.multiMode`);
            if (!n.sameAsSubmitter) m.push(`${n.id}.sameAsSubmitter`);
          }
        } else if (n.kind === 'notify') {
          if (!n.recipients.length) m.push(`${n.id}.recipients`);
          n.recipients.forEach((p, j) => personMissing(p, `${n.id}.recipients.${j}`));
        } else {
          for (const b of n.branches) {
            if (!b.groups.length) m.push(`${b.id}.conditions`);
            for (const g of b.groups) for (const c of g) {
              if (!c.field) m.push(`${c.id}.field`);
              else { if (!c.op) m.push(`${c.id}.op`); if (c.value == null || (Array.isArray(c.value) && !c.value.length)) m.push(`${c.id}.value`); }
            }
          }
        }
      }
      if (nodes.some((n) => n.kind === 'approval') && !s.repeatApprover) m.push('flow.repeatApprover');
      if (!m.length && !s.confirmed) m.push('confirmed');
      return m;
    },

    _q(path, s, ctx, nm) {
      const i = path.indexOf('.'), id = path.slice(0, i), rest = path.slice(i + 1), loc = locate(s, id);
      if (!loc) return null;
      const memberOpts = DIRECTORY.map((d) => ({ value: d.name, label: d.name, hint: d.dept }));
      const personTypes = Object.entries(PERSON).map(([v, l]) => ({ value: v, label: l }));
      const roles = ROLES.map((r) => ({ value: r, label: r }));
      const one = (obj, dflt) => Object.entries(obj).map(([v, l]) => ({ value: v, label: l + (v === dflt ? '（后台默认）' : '') }));

      if (loc.t === 'flow' && rest === 'repeatApprover') return { kind: 'single', title: '同一审批人在流程中重复出现时怎么处理？（全局设置）', hint: '作用于整个审批流的所有审批节点', defaultValue: 'once', options: one(REPEAT, 'once') };
      if (loc.t === 'node' && loc.n.kind === 'approval') {
        const name = `「${nm[id]}」`;
        if (rest === 'approver') return { kind: 'single', title: `${name}的审批人是？`, options: personTypes };
        if (rest === 'approver.members') return { kind: 'multi', title: `${name}由哪些成员审批？`, hint: '最多 25 人', options: memberOpts, selected: loc.n.approver?.members || [] };
        if (rest === 'approver.role') return { kind: 'single', title: `${name}由哪个职务角色审批？`, options: roles };
        if (rest === 'emptyApprover') return { kind: 'single', title: `${name}找不到审批人时怎么处理？`, hint: '例如发起人没有直属上级、角色下没有人', defaultValue: 'autoPass', options: one(EMPTY, 'autoPass') };
        if (rest === 'emptyMembers') return { kind: 'multi', title: `${name}找不到审批人时，指定谁来审批？`, options: memberOpts, selected: loc.n.emptyMembers };
        if (rest === 'multiMode') return { kind: 'single', title: `${name}有多位审批人，采用什么审批方式？`, defaultValue: 'any', options: one(MULTI, 'any') };
        if (rest === 'sameAsSubmitter') return { kind: 'single', title: `${name}的审批人与提交人是同一人时怎么处理？`, defaultValue: 'self', options: one(SAME, 'self') };
      }
      if (loc.t === 'node' && loc.n.kind === 'notify') {
        const name = `「${nm[id]}」`;
        if (rest === 'recipients') return { kind: 'single', title: `${name}要通知谁（抄送人）？`, options: personTypes };
        let m;
        if ((m = rest.match(/^recipients\.(\d+)\.members$/))) return { kind: 'multi', title: `${name}抄送哪些成员？`, hint: '最多 100 人', options: memberOpts, selected: loc.n.recipients[+m[1]]?.members || [] };
        if ((m = rest.match(/^recipients\.(\d+)\.role$/))) return { kind: 'single', title: `${name}抄送哪个职务角色？`, options: roles };
      }
      if (loc.t === 'branch' && rest === 'conditions') return { kind: 'single', title: `「${nm[id]}」在满足什么条件时进入？先选条件字段`, hint: '先选字段，运算符和取值接着问；更多条件可以之后对话补充', options: condFieldOptions(ctx) };
      if (loc.t === 'cond') {
        const info = fieldInfo(ctx, loc.c.field), who = info ? `「${nm[loc.b.id]}」的条件「${info.label}」` : `「${nm[loc.b.id]}」的条件`;
        if (rest === 'field') return { kind: 'single', title: `${who}选哪个字段？`, options: condFieldOptions(ctx) };
        if (rest === 'op') return { kind: 'single', title: `${who}怎么比较？`, options: CMP.map((v) => ({ value: v, label: OPS[v] })) };
        if (rest === 'value') {
          const op = OPS[loc.c.op] || '';
          if (info?.type === 'dept') return { kind: 'multi', title: `${who}属于哪些部门？`, options: DEPTS.map((d) => ({ value: d, label: d })), selected: loc.c.value || [] };
          if (info?.type === 'role') return { kind: 'multi', title: `${who}属于哪些角色？`, options: ROLES.map((d) => ({ value: d, label: d })), selected: loc.c.value || [] };
          if (info?.type === 'select') return { kind: 'multi', title: `${who}属于哪些选项？`, options: (info.options || []).map((d) => ({ value: d, label: d })), selected: loc.c.value || [] };
          if (info?.type === 'date') return { kind: 'text', title: `${who}${op}哪一天？`, placeholder: 'YYYY-MM-DD，如 2026-12-31', maxLength: 10 };
          return { kind: 'number', title: `${who}${op}多少？`, placeholder: info?.type === 'money' ? `金额数值${info.currency ? '（' + info.currency + '）' : ''}` : '数值' };
        }
      }
      return null;
    },

    questions(s, force = {}, hints = {}) {
      const ctx = hints.context || {}, nm = names(s), qs = [];
      const approvals = allNodes(s).filter((n) => n.kind === 'approval').length;
      // 方案先试跑：结构性错误（引用不存在的节点、不支持的类型等）的方案直接丢弃，不让管理员选到坏方案
      const sound = (x) => !this.apply(x.ops, this.empty(), { ctx }).errors.some((e) => !e.field);
      let sug = (hints.suggestions || []).map(normSug).filter(Boolean).filter(sound);
      if (!approvals && !sug.length) sug = fallbackTemplates(ctx);   // 在线时以模型方案为准，兜底用通用方案
      if (sug.length) {
        qs.push({
          field: 'flow.nodes', kind: 'single', allowEmpty: approvals > 0,
          title: approvals ? '还有下面这些流程方案可以参考，要采用吗？' : `「${ctx.basic?.name || '这个审批'}」的流程大致怎么走？`,
          hint: '选一个作为起点，之后可以继续调整；也可以直接在对话里描述。方案里没定的细节（人员、阈值等）我会再问你',
          options: sug.map((x) => ({ value: JSON.stringify(x.ops), label: x.label, hint: x.desc })),
        });
      }
      const paths = uniq([...this.missing(s), ...Object.keys(force)]).filter((p) => !['flow.nodes', 'confirmed'].includes(p));
      for (const p of paths) { const q = this._q(p, s, ctx, nm); if (q) qs.push({ field: p, reason: force[p] || null, ...q }); }
      if (!qs.length && approvals && !s.confirmed) {
        qs.push({ field: 'confirm', kind: 'single', title: '流程已经配置完整，确认没有要调整的了吗？', hint: '发起/结束节点的「抄送人」是选填，还没设置；需要的话直接告诉我，如「结束后抄送行政主管」', options: [{ value: 'yes', label: '没有了，就这样' }, { value: 'more', label: '还要调整' }] });
      }
      return qs;
    },

    answersToPatch(a, s) {
      const ops = [];
      const personOf = (id, rest) => {
        const loc = locate(s, id); if (!loc || loc.t !== 'node') return null;
        let m;
        if (rest.startsWith('approver')) return { n: loc.n, p: loc.n.approver, kind: 'approver' };
        if ((m = rest.match(/^recipients\.(\d+)/))) return { n: loc.n, p: loc.n.recipients[+m[1]], kind: 'recipient', j: +m[1] };
        return null;
      };
      for (const [k, v] of Object.entries(a)) {
        if (k === 'confirm') { if (v === 'yes') ops.push({ op: 'confirm' }); continue; }
        if (k === 'flow.nodes') { try { for (const o of JSON.parse(v)) if (o && o.op !== 'confirm') ops.push(o); } catch { /* ignore */ } continue; }
        const i = k.indexOf('.'), id = k.slice(0, i), rest = k.slice(i + 1), loc = locate(s, id);
        if (!loc) continue;
        if (id === 'flow') { ops.push({ op: 'update', target: 'flow', set: { [rest]: v } }); continue; }
        if (loc.t === 'branch' && rest === 'conditions') { ops.push({ op: 'update', target: id, set: { conditions: [[{ field: v }]] } }); continue; }
        if (loc.t === 'cond') { ops.push({ op: 'update', target: id, set: { [rest]: v } }); continue; }
        if (loc.t === 'node' && loc.n.kind === 'notify') {
          if (rest === 'recipients') { ops.push({ op: 'update', target: id, set: { recipients: [...loc.n.recipients, { type: v }] } }); continue; }
          const pr = personOf(id, rest);
          if (pr?.p) {
            const attr = rest.split('.').pop();
            const list = loc.n.recipients.map((p, j) => (j === pr.j ? { ...p, [attr]: v } : p));
            ops.push({ op: 'update', target: id, set: { recipients: list } });
          }
          continue;
        }
        if (loc.t === 'node' && loc.n.kind === 'approval') {
          if (rest === 'approver') ops.push({ op: 'update', target: id, set: { approver: { type: v } } });
          else if (rest === 'approver.members' || rest === 'approver.role') ops.push({ op: 'update', target: id, set: { approver: { ...loc.n.approver, [rest.split('.')[1]]: v } } });
          else ops.push({ op: 'update', target: id, set: { [rest]: v } });
        }
      }
      return ops;
    },

    apply(ops, state, opts = {}) {
      const s = structuredClone(state), ctx = opts.ctx || {}, errors = [], touched = new Set(), rows = [];
      if (!Array.isArray(ops)) return { next: s, touched: [], rows, errors };
      const err = (field, message) => errors.push({ field, message });
      const ids = JSON.stringify(s).match(/"id":"[a-z](\d+)"/g) || [];
      let n = Math.max(0, ...ids.map((x) => +x.match(/(\d+)/)[1])) + 1;
      let changed = false;
      const touch = (id) => { touched.add(id); changed = true; };
      const clean = (v, max = 20) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

      // person：人员/角色对不上通讯录时保留已识别部分，其余由追问卡片确认
      const cleanPerson = (spec, cap, prefix, strict) => {
        if (!spec || !PERSON[spec.type]) { err(strict ? null : prefix, `人员类型「${spec?.type ?? ''}」不支持，可选：${Object.values(PERSON).join('、')}`); return null; }
        const p = { type: spec.type, members: [], role: null };
        if (spec.type === 'members') {
          const names_ = uniq(Array.isArray(spec.members) ? spec.members : []);
          const unknown = names_.filter((x) => !DIRECTORY.some((d) => d.name === x));
          if (unknown.length) err(`${prefix}.members`, `通讯录里找不到：${unknown.join('、')}，请从下方通讯录选择`);
          if (names_.length > cap) err(`${prefix}.members`, `最多选 ${cap} 人，已超出`);
          p.members = names_.filter((x) => !unknown.includes(x)).slice(0, cap);
        }
        if (spec.type === 'role' && spec.role != null) {
          if (ROLES.includes(spec.role)) p.role = spec.role; else err(`${prefix}.role`, `职务角色「${spec.role}」不存在，可选：${ROLES.join('、')}`);
        }
        if (strict && ((p.type === 'members' && !p.members.length) || (p.type === 'role' && !p.role))) { err(null, '抄送人没有说清楚是谁，请补充具体成员或角色'); return null; }
        return p;
      };

      // cond：字段/运算符/取值逐项校验，不合法的项置空并追问
      const setCond = (c, spec) => {
        if ('field' in spec && spec.field != null) {
          const info = fieldInfo(ctx, spec.field);
          if (!info) err(`${c.id}.field`, `条件字段「${spec.field}」不可用（仅支持发起人部门/角色，以及表单里的金额、数字、日期、单选字段）`);
          else if (c.field !== info.id) { c.field = info.id; c.op = null; c.value = null; }
        }
        const info = fieldInfo(ctx, c.field);
        if (!info) return;
        if (['dept', 'role', 'select'].includes(info.type)) c.op = 'in';
        else if ('op' in spec && spec.op != null) { if (CMP.includes(spec.op)) c.op = spec.op; else err(`${c.id}.op`, `运算符「${spec.op}」不支持`); }
        if ('value' in spec && spec.value != null) {
          const v = spec.value;
          if (info.type === 'dept' || info.type === 'role' || info.type === 'select') {
            const pool = info.type === 'dept' ? DEPTS : info.type === 'role' ? ROLES : info.options;
            const arr = uniq(Array.isArray(v) ? v : [v]);
            const bad = arr.filter((x) => !pool.includes(x));
            if (bad.length) err(`${c.id}.value`, `「${bad.join('、')}」不在可选范围内：${pool.join('、')}`);
            const good = arr.filter((x) => pool.includes(x));
            c.value = good.length ? good : null;
          } else if (info.type === 'date') {
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) c.value = v; else err(`${c.id}.value`, '日期格式需为 YYYY-MM-DD');
          } else if (typeof v === 'number' && isFinite(v)) c.value = v;
          else if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) c.value = Number(v);
          else err(`${c.id}.value`, '条件取值需要是数字');
        }
      };
      const newCond = (spec) => { const c = { id: `k${n++}`, field: null, op: null, value: null }; setCond(c, spec || {}); return c; };
      const newGroups = (conds) => {
        const groups = Array.isArray(conds) ? (conds.length && !Array.isArray(conds[0]) ? [conds] : conds) : [];
        return groups.slice(0, 5).map((g) => (Array.isArray(g) ? g : []).slice(0, 5).map(newCond)).filter((g) => g.length);
      };

      const setApproval = (node, set) => {
        if ('name' in set && clean(set.name)) node.name = clean(set.name);
        if ('approver' in set && set.approver != null) { const p = cleanPerson(set.approver, 25, `${node.id}.approver`); if (p) node.approver = p; }
        if (set.emptyApprover != null) { if (EMPTY[set.emptyApprover]) node.emptyApprover = set.emptyApprover; else err(`${node.id}.emptyApprover`, `「${set.emptyApprover}」不是有效的处理方式`); }
        if (Array.isArray(set.emptyMembers)) {
          const bad = set.emptyMembers.filter((x) => !DIRECTORY.some((d) => d.name === x));
          if (bad.length) err(`${node.id}.emptyMembers`, `通讯录里找不到：${bad.join('、')}`);
          node.emptyMembers = uniq(set.emptyMembers.filter((x) => !bad.includes(x))).slice(0, 25);
        }
        if (set.multiMode != null) { if (MULTI[set.multiMode]) node.multiMode = set.multiMode; else err(`${node.id}.multiMode`, `「${set.multiMode}」不是有效的审批方式`); }
        if (set.sameAsSubmitter != null) { if (SAME[set.sameAsSubmitter]) node.sameAsSubmitter = set.sameAsSubmitter; else err(`${node.id}.sameAsSubmitter`, `「${set.sameAsSubmitter}」不是有效的处理方式`); }
      };
      const setRecipients = (node, list) => {
        if (!Array.isArray(list)) return;
        node.recipients = list.slice(0, 20).map((p, j) => cleanPerson(p, 100, `${node.id}.recipients.${j}`)).filter(Boolean);
      };

      const createBranch = (node, spec, depth) => {
        const b = { id: `b${n++}`, name: clean(spec?.name), groups: newGroups(spec?.conditions), nodes: [] };
        node.branches.push(b); touch(b.id);
        for (const ns of Array.isArray(spec?.nodes) ? spec.nodes : []) createNode(ns, b.nodes, null, depth + 1);
        return b;
      };
      const createNode = (spec, list, index, depth = 0) => {
        if (!spec || !NODE_KINDS.includes(spec.kind)) { err(null, `不支持的节点类型「${spec?.kind ?? ''}」，可用：审批人、通知、条件分支`); return null; }
        if (depth > 3) { err(null, '条件分支嵌套太深'); return null; }
        if (allNodes(s).length >= MAX_NODES) { err(null, `节点数量已达上限 ${MAX_NODES}`); return null; }
        const node = { id: `n${n++}`, kind: spec.kind, name: clean(spec.name) };
        if (spec.kind === 'approval') Object.assign(node, { approver: null, emptyApprover: null, emptyMembers: [], multiMode: null, sameAsSubmitter: null });
        if (spec.kind === 'notify') node.recipients = [];
        if (spec.kind === 'branch') Object.assign(node, { branches: [], def: { id: `d${n++}`, nodes: [] } });
        list.splice(index == null ? list.length : index, 0, node);
        if (spec.kind === 'approval') setApproval(node, spec);
        if (spec.kind === 'notify') setRecipients(node, spec.recipients);
        if (spec.kind === 'branch') { for (const bs of Array.isArray(spec.branches) && spec.branches.length ? spec.branches : [{}]) createBranch(node, bs, depth); }
        touch(node.id);
        const nm = names(s);
        rows.push({ label: `新增节点「${nm[node.id]}」`, new: sumNode(node) });
        return node;
      };

      const resolve = (t) => {
        const direct = locate(s, String(t));
        if (direct) return direct;
        const nm = names(s), hit = Object.entries(nm).filter(([, l]) => l === String(t).trim());
        if (hit.length === 1) return locate(s, hit[0][0]);
        err(null, hit.length ? `有多个叫「${t}」的节点，请说明是哪一个` : `AI 的提案引用了不存在的节点（${t}），这一步已忽略`);
        return null;
      };
      const listFor = (parent) => {
        if (!parent || parent === 'main') return s.nodes;
        const loc = resolve(parent);
        if (loc?.t === 'branch') return loc.b.nodes;
        if (loc?.t === 'def') return loc.n.def.nodes;
        if (loc) err(null, '只能往主流程、条件分支或「其他情况」里添加节点');
        return null;
      };

      for (const op of ops.slice(0, 40)) {
        if (!op || typeof op !== 'object') continue;
        if (op.op === 'add') {
          const list = listFor(op.parent); if (!list) continue;
          let idx = op.at === 'start' ? 0 : null;
          if (op.after) { const l = resolve(op.after); if (!l || l.t !== 'node' || l.list !== list) { err(null, `找不到要插入位置之前的节点「${op.after}」`); continue; } idx = list.indexOf(l.n) + 1; }
          createNode(op.node, list, idx);
        } else if (op.op === 'addBranch') {
          const l = resolve(op.target);
          if (!l || l.t !== 'node' || l.n.kind !== 'branch') { if (l) err(null, '只能给条件分支节点添加分支'); continue; }
          if (l.n.branches.length >= 10) { err(null, '一个条件分支节点最多 10 个分支'); continue; }
          const b = createBranch(l.n, op.branch || {}, 0);
          rows.push({ label: '新增条件分支', new: `${names(s)[b.id]}：${sumBranch(b, ctx)}` });
        } else if (op.op === 'update') {
          const l = resolve(op.target); if (!l) continue;
          const set = op.set || {};
          if (l.t === 'flow') {
            if (set.repeatApprover != null) { if (REPEAT[set.repeatApprover]) { if (s.repeatApprover !== set.repeatApprover) { rows.push({ label: '同一审批人重复出现', old: REPEAT[s.repeatApprover] || '（未设置）', new: REPEAT[set.repeatApprover] }); s.repeatApprover = set.repeatApprover; touch('flow'); } } else err('flow.repeatApprover', `「${set.repeatApprover}」不是有效选项`); }
          } else if (l.t === 'start' || l.t === 'end') {
            if (Array.isArray(set.cc)) {
              const key = l.t === 'start' ? 'startCc' : 'endCc';
              s[key] = set.cc.slice(0, 20).map((p, j) => cleanPerson(p, 100, `${l.t}.cc.${j}`, true)).filter(Boolean);
              rows.push({ label: `${l.t === 'start' ? '发起' : '结束'}节点抄送人`, new: s[key].map(ptext).join('；') || '（空）' }); touch(l.t);
            }
          } else if (l.t === 'node') {
            const before = sumNode(l.n), nmBefore = names(s)[l.n.id];
            if (l.n.kind === 'approval') setApproval(l.n, set);
            else if (l.n.kind === 'notify') { if ('name' in set && clean(set.name)) l.n.name = clean(set.name); if ('recipients' in set) setRecipients(l.n, set.recipients); }
            else if ('name' in set && clean(set.name)) l.n.name = clean(set.name);
            const after = sumNode(l.n);
            if (before !== after || nmBefore !== names(s)[l.n.id]) { rows.push({ label: `修改「${nmBefore}」`, old: before, new: after }); touch(l.n.id); }
          } else if (l.t === 'branch') {
            const before = sumBranch(l.b, ctx);
            if ('name' in set && clean(set.name)) l.b.name = clean(set.name);
            if ('conditions' in set) l.b.groups = newGroups(set.conditions);
            const after = sumBranch(l.b, ctx);
            rows.push({ label: `修改「${names(s)[l.b.id]}」条件`, old: before, new: after }); touch(l.b.id);
          } else if (l.t === 'cond') {
            const before = ctext(l.c, ctx);
            setCond(l.c, set);
            const after = ctext(l.c, ctx);
            if (before !== after) { rows.push({ label: `修改「${names(s)[l.b.id]}」条件`, old: before, new: after }); touch(l.b.id); touch(l.c.id); }
          } else err(null, '「其他情况」没有条件可以设置');
        } else if (op.op === 'remove') {
          const l = resolve(op.target); if (!l) continue;
          if (l.t === 'node') { const label = names(s)[l.n.id]; l.list.splice(l.list.indexOf(l.n), 1); rows.push({ label: '删除节点', old: `${label}（${sumNode(l.n)}）` }); touch(l.n.id); }
          else if (l.t === 'branch') {
            if (l.n.branches.length <= 1) { err(null, '条件分支节点至少保留一个分支；要整体删除请删除该分支节点'); continue; }
            const label = names(s)[l.b.id]; l.n.branches.splice(l.n.branches.indexOf(l.b), 1); rows.push({ label: '删除条件分支', old: label }); touch(l.b.id);
          } else if (l.t === 'cond') { l.g.splice(l.g.indexOf(l.c), 1); if (!l.g.length) l.b.groups.splice(l.b.groups.indexOf(l.g), 1); rows.push({ label: '删除条件', old: ctext(l.c, ctx) }); touch(l.b.id); }
          else err(null, '发起、结束和「其他情况」是固定的，不能删除');
        } else if (op.op === 'confirm') {
          if (!opts.trusted) { err(null, '「确认流程已完整」只能由管理员点击确认'); continue; }
          if (this.missing(s).filter((m) => m !== 'confirmed').length) { err(null, '还有必填信息未确认，不能完成'); continue; }
          s.confirmed = true;
        }
      }
      if (changed) s.confirmed = false;
      return { next: s, touched: [...touched], rows, errors };
    },

    ref() {
      return `流程固定为：发起 → 若干节点 → 结束。节点类型只有三种：审批人 approval、通知 notify（抄送）、条件分支 branch。
- person（审批人/抄送人）：{"type": members|self|role|manager|deptHead, "members":[姓名], "role":角色名}。members=指定成员(审批≤25人/抄送≤100人，姓名必须在通讯录)，self=发起人自己，role=职务角色(${ROLES.join('/')})，manager=直属上级，deptHead=部门负责人。
- approval 属性：approver(person)、emptyApprover(审批人为空时: autoPass自动通过/specified指定人员审批/admin转交给审批模板管理员)、emptyMembers(emptyApprover=specified 时的人员)、multiMode(多人审批: all会签/any或签)、sameAsSubmitter(审批人与提交人同一人时: self由提交人对自己审批/skip自动跳过/manager转交直属上级/deptHead转交部门负责人)。
- notify 属性：recipients: person[]。
- flow 全局：repeatApprover(once仅审批一次后续重复自动同意 / each不自动同意每个节点都审批)。
- branch 节点：branches[{name, conditions, nodes}]，外加固定的「其他情况」（不满足任何分支时走，id 见 def）。conditions 是条件组数组：组与组之间「或」，组内条件「且」，如 [[c1,c2],[c3]]。
  条件 {field, op, value}：field=initiator.dept(发起人所在部门，op固定in，value=部门名数组，可选：${DEPTS.join('/')}) | initiator.role(发起人的角色，op=in，value=角色名数组) | 表单字段id(仅 money/number/date/select 类型可用：money/number/date 的 op 取 eq/lt/lte/gt/gte/neq，value 为数字或 YYYY-MM-DD；select 的 op=in，value 为选项数组)。
- start/end 节点可选设置抄送人：update target "start"/"end"，set {cc:[person]}。`;
    },
    view(s) {
      const compact = (list) => list.map((n) => n.kind === 'branch'
        ? { id: n.id, kind: 'branch', name: n.name, branches: n.branches.map((b) => ({ id: b.id, name: b.name, conditions: b.groups.map((g) => g.map((c) => ({ id: c.id, field: c.field, op: c.op, value: c.value }))), nodes: compact(b.nodes) })), def: { id: n.def.id, nodes: compact(n.def.nodes) } }
        : n.kind === 'approval' ? { id: n.id, kind: 'approval', name: n.name, approver: n.approver, emptyApprover: n.emptyApprover, emptyMembers: n.emptyMembers, multiMode: n.multiMode, sameAsSubmitter: n.sameAsSubmitter }
          : { id: n.id, kind: 'notify', name: n.name, recipients: n.recipients });
      return { nodes: compact(s.nodes), repeatApprover: s.repeatApprover };
    },

    promptSpec(s, ctx) {
      return `你是企业管理后台的「配置助手」，正在帮管理员配置审批流程（第三步）。你的工作方式是「访谈」：弄清业务怎么审，再把它翻译成流程节点。

## 真实后台的能力
${this.ref()}

## 上下文
第一步基础信息：${JSON.stringify(ctx?.basic || {})}
第二步表单字段（条件分支只能用其中 money/number/date/select）：${JSON.stringify(ctx?.form || [])}

## 通讯录
${DIRECTORY.map((d) => `${d.name}(${d.dept})`).join('、')}

## 当前流程（id 用于定位；null/空表示管理员还没确认）
${JSON.stringify(this.view(s))}

## 输出：只输出一个 JSON 对象，不要 markdown 代码块
{
 "reply": "一两句话，说明你理解了什么 / 为什么这么建议",
 "ops": [ {"op":"add","parent":"main或分支id(b..)或其他情况id(d..)，默认main","after":"在哪个节点id之后，可省略","at":"start|end，默认end","node":{"kind":"approval|notify|branch", ...}}
        | {"op":"addBranch","target":"分支节点id","branch":{"name":"","conditions":[[...]],"nodes":[...]}}
        | {"op":"update","target":"节点id/分支id/条件id/flow/start/end 或名称","set":{...}}
        | {"op":"remove","target":"节点id/分支id/条件id"} ],
 "clarify": [ {"field":"id.属性，如 n1.approver、k3.value","reason":"为什么要再确认"} ],
 "suggestions": [ {"label":"方案名","desc":"一句话说明","ops":[同上 ops]} ]
}

## 硬性规则
1. 只提取管理员「明确说出」的内容，绝不猜测。他没明说的属性一律省略，系统会弹卡片问——尤其是：审批人具体是谁、条件的数值/部门/角色、多人审批方式、审批人为空时的处理、同一人时的处理。不要替管理员做这些决定。
2. 人名必须在通讯录、角色/部门必须在上面的清单、条件字段必须来自表单字段；对不上 → 放进 clarify，不要硬凑。
3. 对话开始或管理员问"怎么设计/有什么推荐"时：在 suggestions 里给 2~4 个符合该审批场景的流程方案，此时 ops 置空。方案 ops 里只写业务上确定的结构，不要编造金额阈值、人名、日期——这些字段直接省略（不要写 0、null、空串或示例值），系统会追问。
4. 新建条件分支时，它内部的节点必须一次性写在同一个 branch 节点的 branches[].nodes 里（条件分支里再套审批/通知也一样内联）。绝不要引用尚不存在的 id（如 b1、n2）；parent/after/target 只能引用「当前流程」里已经存在的 id。
5. 管理员说"超过5000要财务总监审批"这类话，他明确给了数值，可以直接写进 branch 条件；说"金额大的要额外审批"没给数值，则只给 field，不写 value。
6. 绝不输出 confirm；"流程是否完整"只由管理员点击确认。reply 里不要说"流程已完成"。`;
    },

    mock(text, s, ctx) {
      const ops = [];
      const money = (ctx?.form || []).find((f) => f.type === 'money');
      const personFrom = (t) => {
        for (const r of ROLES) if (t.includes(r)) return { type: 'role', role: r };
        const hit = DIRECTORY.filter((d) => t.includes(d.name)).map((d) => d.name);
        if (hit.length) return { type: 'members', members: hit };
        if (/直属上级|上级/.test(t)) return { type: 'manager' };
        if (/部门负责人|部门主管/.test(t)) return { type: 'deptHead' };
        if (/自己|本人/.test(t)) return { type: 'self' };
        return null;
      };
      for (const clause of text.split(/[。；;\n]/)) {
        let m;
        if ((m = clause.match(/(?:金额|费用)[^，,]*?(超过|大于等于|大于|不低于|小于等于|小于|不超过|低于)\s*(\d+(?:\.\d+)?)[^，,]*?(?:需要|要|加|由)?([^，,]*?)(?:审批|批准)/)) && money) {
          const op = { 超过: 'gt', 大于: 'gt', 大于等于: 'gte', 不低于: 'gte', 小于: 'lt', 低于: 'lt', 小于等于: 'lte', 不超过: 'lte' }[m[1]];
          const p = personFrom(m[3]);
          ops.push({ op: 'add', node: { kind: 'branch', branches: [{ conditions: [[{ field: money.id, op, value: +m[2] }]], nodes: [{ kind: 'approval', ...(p ? { approver: p } : {}) }] }] } });
        } else if ((m = clause.match(/抄送(.+)/))) {
          const p = personFrom(m[1]); ops.push({ op: 'add', node: { kind: 'notify', ...(p ? { recipients: [p] } : {}) } });
        } else if ((m = clause.match(/(?:删除|去掉|移除)(.+)/))) ops.push({ op: 'remove', target: m[1].replace(/[「」]/g, '').trim() });
        else if ((m = clause.match(/(?:加|增加|添加|新增|再加|先由|由|然后)(.*?)(?:审批|批准|审核)/))) {
          const p = personFrom(m[1]); ops.push({ op: 'add', node: { kind: 'approval', ...(p ? { approver: p } : {}) } });
        }
      }
      const wantSug = /开始|推荐|怎么设计|有什么|不知道/.test(text);
      return {
        reply: ops.length ? `（离线规则模式）我识别到 ${ops.length} 项流程改动。` : wantSug ? '（离线规则模式）我整理了几个常见流程方案，你选一个作为起点。' : '（离线规则模式）这句话里没有识别到流程改动。可以说：“加一个部门负责人审批”“金额超过5000需要财务总监审批”“抄送行政主管”。',
        ops, clarify: [], suggestions: [],
      };
    },
  };
};
