// 「配置能力」注册表：一个后台功能点 = 一个 capability。
//
// 统一接口（对话层/前端只依赖这些，不关心具体业务）：
//   empty()                       初始状态（必填项一律是「未确认」，没有默认值）
//   missing(state)                必填缺项路径
//   apply(patch, state, opts)     校验并应用补丁 → { next, touched, rows, errors }
//   questions(state, force, hints)服务端生成的追问卡片（结构化）
//   answersToPatch(answers,state) 把卡片回答翻译成补丁（不经过模型）
//   promptSpec(state, ctx)        给模型的 schema/规则/输出约定
//   mock(text, state, ctx)        没配 API Key 时的离线规则解析
//
// 铁律：模型只负责「提取 + 标歧义」；缺项判断、追问、状态(need_info/ready)全部由服务端决定。

const DIRECTORY = [
  { name: '陈一', dept: '产品部' }, { name: '林二', dept: '研发部' }, { name: '周三', dept: '研发部' },
  { name: '吴四', dept: '行政部' }, { name: '张三', dept: '财务部' }, { name: '李四', dept: '财务部' }, { name: '王五', dept: '人事部' },
];
const CATEGORIES = ['财务管理', '考勤管理', '人事管理', '行政管理', '其他'];
const uniq = (a) => [...new Set(a)];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// =====================================================================
// ① 审批流 · 基础信息
// =====================================================================
const BASIC_Q = {
  name: () => ({ kind: 'text', title: '这个审批流叫什么名称？', placeholder: '最多 20 字，如：出差报销', maxLength: 20 }),
  category: () => ({ kind: 'single', title: '归到哪个分组？', options: CATEGORIES.map((v) => ({ value: v, label: v })) }),
  'initiator.scope': () => ({ kind: 'single', title: '谁可以发起这个审批？', options: [{ value: 'all', label: '全员' }, { value: 'specified', label: '指定人员' }] }),
  'initiator.members': (c) => ({
    kind: 'multi', title: '请选择可以发起的人员',
    dependsOn: { field: 'initiator.scope', equals: 'specified', current: c.initiator?.scope },
    options: DIRECTORY.map((d) => ({ value: d.name, label: d.name, hint: d.dept })), selected: c.initiator?.members || [],
  }),
  showInWorkbench: () => ({ kind: 'single', title: '是否在工作台展示？', hint: '关闭后，已添加该审批的用户工作台入口将自动移除', options: [{ value: true, label: '展示' }, { value: false, label: '不展示' }] }),
};
const BASIC_LABEL = { name: '名称', description: '说明', category: '分组', initiator: '谁可以发起', showInWorkbench: '是否在工作台展示' };
const bfmt = (k, v) => v == null ? '（未设置）' : k === 'initiator' ? (v.scope === 'all' ? '全员' : '指定人员：' + (v.members.join('、') || '（未选）')) : k === 'showInWorkbench' ? (v ? '展示' : '不展示') : (v === '' ? '（空）' : v);

const approvalBasic = {
  title: '审批流 · 基础信息',
  empty: () => ({ name: '', description: '', category: null, initiator: null, showInWorkbench: null }),
  labels: { 'name': '名称', 'category': '分组', 'initiator.scope': '谁可以发起', 'initiator.members': '发起人员', 'showInWorkbench': '工作台展示' },

  missing(c) {
    const m = [];
    if (!c.name) m.push('name');
    if (!c.category) m.push('category');
    if (!c.initiator) m.push('initiator.scope');
    else if (c.initiator.scope === 'specified' && !c.initiator.members?.length) m.push('initiator.members');
    if (typeof c.showInWorkbench !== 'boolean') m.push('showInWorkbench');
    return m;
  },

  questions(c, force = {}) {
    const fields = this.missing(c);
    for (const f of Object.keys(force)) if (!fields.includes(f) && BASIC_Q[f]) fields.push(f);
    const order = Object.keys(BASIC_Q);
    return fields.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((f) => ({ field: f, reason: force[f] || null, ...BASIC_Q[f](c) }));
  },

  answersToPatch(a, c) {
    const patch = {};
    for (const k of ['name', 'category', 'showInWorkbench']) if (a[k] !== undefined) patch[k] = a[k];
    const scope = a['initiator.scope'] ?? c.initiator?.scope;
    if (a['initiator.scope'] !== undefined || a['initiator.members'] !== undefined) {
      patch.initiator = { scope, members: scope === 'all' ? [] : a['initiator.members'] ?? c.initiator?.members ?? [] };
    }
    return patch;
  },

  apply(patch, c) {
    const clean = {}, errors = [];
    if (patch && typeof patch === 'object') {
      for (const [k, v] of Object.entries(patch)) {
        if (!BASIC_LABEL[k]) { errors.push({ field: null, message: `忽略未知字段 ${k}` }); continue; }
        if (k === 'name' || k === 'description') {
          const max = k === 'name' ? 20 : 50;
          if (typeof v !== 'string') { errors.push({ field: k, message: `${BASIC_LABEL[k]}必须是文字` }); continue; }
          const s = v.trim();
          if (k === 'name' && !s) { errors.push({ field: k, message: '名称不能为空' }); continue; }
          if (s.length > max) { errors.push({ field: k, message: `${BASIC_LABEL[k]}超过 ${max} 字（当前 ${s.length}）` }); continue; }
          clean[k] = s;
        } else if (k === 'category') {
          if (!CATEGORIES.includes(v)) { errors.push({ field: k, message: `分组「${v}」不存在` }); continue; }
          clean[k] = v;
        } else if (k === 'showInWorkbench') {
          if (typeof v !== 'boolean') { errors.push({ field: k, message: '工作台展示必须是开/关' }); continue; }
          clean[k] = v;
        } else if (k === 'initiator') {
          if (!v || !['all', 'specified'].includes(v.scope)) { errors.push({ field: 'initiator.scope', message: '发起范围只能是全员或指定人员' }); continue; }
          if (v.scope === 'all') { clean[k] = { scope: 'all', members: [] }; continue; }
          const names = uniq(Array.isArray(v.members) ? v.members : []);
          const unknown = names.filter((n) => !DIRECTORY.some((d) => d.name === n));
          if (unknown.length) errors.push({ field: 'initiator.members', message: `通讯录里找不到：${unknown.join('、')}，请从下方通讯录选择` });
          clean[k] = { scope: 'specified', members: names.filter((n) => !unknown.includes(n)) };
        }
      }
    }
    for (const k of Object.keys(clean)) if (same(clean[k], c?.[k])) delete clean[k];
    const rows = Object.entries(clean).map(([k, v]) => ({ label: BASIC_LABEL[k], old: bfmt(k, c[k]), new: bfmt(k, v) }));
    return { next: { ...c, ...clean }, touched: Object.keys(clean), rows, errors };
  },

  ref() {
    return `name(必填,≤20字) | description(选填,≤50字) | category(必填,枚举：${CATEGORIES.join('/')}) | initiator(必填,{scope:"all"|"specified", members:通讯录姓名[]}) | showInWorkbench(必填,boolean，关闭后已添加该审批的用户工作台入口将自动移除)`;
  },
  view: (c) => c,

  promptSpec(c) {
    return `你是企业管理后台的「配置助手」，通过对话帮管理员完成「审批流 · 基础信息」。只能修改下列字段。

## 字段（required 为必填）
name(必填,≤20字) | description(选填,≤50字) | category(必填,枚举：${CATEGORIES.join('/')}) | initiator(必填,{scope:"all"|"specified", members:通讯录姓名[]}) | showInWorkbench(必填,boolean)

## 当前表单值（null/空串 = 管理员还没确认）
${JSON.stringify(c, null, 2)}

## 通讯录
${DIRECTORY.map((d) => `${d.name}(${d.dept})`).join('、')}

## 输出：只输出一个 JSON 对象，不要 markdown 代码块
{"reply":"一两句话，说明你提取了什么","patch":{仅含管理员明确说出的字段}或null,"clarify":[{"field":"name|category|initiator.scope|initiator.members|showInWorkbench","reason":"为什么要再确认"}]}

## 硬性规则
1. 绝不猜测、绝不使用默认值；没明说的字段不要放进 patch（不能因为名字像财务就填财务管理）。
2. 有歧义/矛盾/人名对不上通讯录 → 放进 clarify 写清 reason，patch 里不放它。
3. 缺失的必填项不需要你追问——系统会弹出选择卡片。
4. initiator 变更必须给完整 {scope, members}；"加上某人"请基于当前成员合并。
5. reply 里不要说"已完成"，是否完整由系统判定。`;
  },

  mock(text, c) {
    const patch = {};
    const clarify = [];
    const nameM = text.match(/[「“"『]([^」”"』]{1,30})[」”"』]/) || text.match(/(?:叫|名为|名称(?:是|为|改成|改为)?)\s*([^\s，,。、]{2,20})/);
    if (nameM) patch.name = nameM[1].trim();
    const catM = text.match(/(?:分组|归到|放到|归入|分到)[^，。]*?(财务|考勤|人事|行政|其他)/);
    if (catM) patch.category = catM[1] === '其他' ? '其他' : catM[1] + '管理';
    const descM = text.match(/(?:说明|描述|备注)[:：是为写]?\s*([^。\n]{1,50})/);
    if (descM) patch.description = descM[1].trim();
    if (/全员|所有人|任何人|不限制/.test(text) && /发起/.test(text)) patch.initiator = { scope: 'all', members: [] };
    else if (/(指定|只有|仅|限|加上|再加|添加)/.test(text) && /(发起|加上|再加|添加)/.test(text)) {
      const hit = DIRECTORY.filter((d) => text.includes(d.name)).map((d) => d.name);
      const unknown = text.includes('赵六'); // demo：离线模式下用「赵六」模拟通讯录里没有的人
      const base = /加上|再加|添加/.test(text) && c.initiator?.scope === 'specified' ? c.initiator.members : [];
      const members = uniq([...base, ...hit, ...(unknown ? ['赵六'] : [])]);
      if (members.length) patch.initiator = { scope: 'specified', members };
      else clarify.push({ field: 'initiator.members', reason: '没有识别到通讯录里的人名' });
    }
    if (/(不|无需|关闭|隐藏).{0,6}工作台/.test(text)) patch.showInWorkbench = false;
    else if (/(展示|显示|开启|放).{0,6}工作台/.test(text)) patch.showInWorkbench = true;
    const keys = Object.keys(patch);
    return {
      reply: keys.length ? `（离线规则模式）我从你的话里提取到：${keys.map((k) => BASIC_LABEL[k]).join('、')}。` : '（离线规则模式）这句话里没有提取到可配置的内容。',
      patch: keys.length ? patch : null, clarify,
    };
  },
};

// =====================================================================
// ② 审批流 · 表单设计
// =====================================================================
// 与真实后台「设计表单」控件库对齐（来源：蜂巢管理平台 · 审批工作台 · 设计表单）
const TYPES = { text: '单行文本', textarea: '多行文本', number: '数字', money: '金额', select: '单选', multiselect: '多选', date: '日期', daterange: '日期区间', detail: '明细', contact: '联系人', bank: '银行账户', dept: '部门', attachment: '附件上传', image: '图片', leave: '请假控件组', punchfix: '补卡控件组', overtime: '加班控件组' };
const GROUP_TYPES = ['leave', 'punchfix', 'overtime'];   // 假勤系统控件组：整个表单最多 1 个，自动同步数据，没有「必填」等属性
const NO_REQ = (t) => GROUP_TYPES.includes(t);
const TYPE_KEYS = Object.keys(TYPES);
const CURRENCIES = [{ value: 'CNY', label: '人民币 CNY' }, { value: 'USD', label: '美元 USD' }, { value: 'EUR', label: '欧元 EUR' }];
const DETAIL_COLS = ['费用类型|select|', '金额|money|', '发生日期|date|', '说明|text|'];
const ATTRN = { label: '名称', type: '类型', required: '必填', options: '选项', withTime: '日期格式', currency: '币种', children: '明细列', placeholder: '默认提示', unit: '单位', min: '最小值', max: '最大值' };

// 场景字段库：服务端兜底，保证“先问客户要什么”时一定有候选可选
const LIBRARY = [
  [/出差/, ['出差事由|textarea|说明出差目的', '出差城市|text|', '出差日期|daterange|', '预计费用|money|', '同行人员|contact|', '费用明细|detail|按项目列出', '附件|attachment|行程单等']],
  [/请假|休假/, ['请假类型|select|事假/病假/年假', '请假日期|daterange|', '请假事由|textarea|', '工作交接人|contact|', '附件|attachment|病假条等']],
  [/报销|费用|经费/, ['报销事由|textarea|', '报销金额|money|', '费用明细|detail|', '所属部门|dept|', '发票附件|attachment|']],
  [/采购/, ['采购事由|textarea|', '采购明细|detail|', '预算金额|money|', '期望到货日期|date|', '供应商|text|']],
  [/用章|用印/, ['用章类型|select|公章/合同章/财务章', '文件名称|text|', '用章事由|textarea|', '用章日期|date|', '盖章文件|attachment|']],
];
const GENERIC = ['申请事由|textarea|', '申请日期|date|', '所属部门|dept|', '申请金额|money|', '附件|attachment|'];

const parseSug = (s) => { const [label, type, reason] = String(s).split('|'); return { label: (label || '').trim(), type: TYPE_KEYS.includes(type) ? type : null, reason: reason || '' }; };
const libraryFor = (ctx) => { const t = `${ctx?.name || ''}${ctx?.description || ''}`; return (LIBRARY.find(([re]) => re.test(t))?.[1] || GENERIC).map(parseSug); };
const normSug = (x) => (x && typeof x.label === 'string' && x.label.trim().length <= 20 && x.label.trim() && TYPE_KEYS.includes(x.type)) ? { label: x.label.trim(), type: x.type, reason: String(x.reason || '').slice(0, 20) } : null;

const flat = (s) => s.fields.flatMap((f) => [{ f, p: null }, ...f.children.map((c) => ({ f: c, p: f }))]);
const find = (s, id) => flat(s).find((x) => x.f.id === id);
const plabel = ({ f, p }) => (p ? `${p.label} › ${f.label}` : f.label);
const isSel = (t) => t === 'select' || t === 'multiselect';
const isDate = (t) => t === 'date' || t === 'daterange';
const fv = (a, v) => v == null ? '（未设置）' : a === 'type' ? TYPES[v] : a === 'required' ? (v ? '必填' : '选填') : a === 'withTime' ? (v ? '年-月-日 时:分' : '年-月-日') : a === 'currency' ? (CURRENCIES.find((c) => c.value === v)?.label || v) : a === 'options' ? v.join('、') : v;

const cleanOptions = (arr) => uniq((Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter((x) => x && x.length <= 20)).slice(0, 50);

const approvalForm = {
  title: '审批流 · 表单设计',
  empty: () => ({ fields: [], confirmed: false }),

  missing(s) {
    const m = [];
    if (!s.fields.length) m.push('fields');
    for (const { f } of flat(s)) {
      if (!f.type) m.push(`${f.id}.type`);
      else {
        if (isSel(f.type) && f.options.length < 2) m.push(`${f.id}.options`);
        if (isDate(f.type) && typeof f.withTime !== 'boolean') m.push(`${f.id}.withTime`);
        if (f.type === 'money' && !f.currency) m.push(`${f.id}.currency`);
        if (f.type === 'detail' && !f.children.length) m.push(`${f.id}.children`);
      }
      if (!NO_REQ(f.type) && typeof f.required !== 'boolean') m.push(`${f.id}.required`);
    }
    if (!m.length && !s.confirmed) m.push('confirmed');
    return m;
  },

  _q(path, s) {
    const i = path.lastIndexOf('.'), id = path.slice(0, i), attr = path.slice(i + 1), hit = find(s, id);
    if (!hit) return null;
    const { f, p } = hit, name = `「${plabel(hit)}」`;
    if (attr === 'type') return { kind: 'single', title: `${name}是什么类型的字段？`, options: TYPE_KEYS.filter((t) => !(p && (t === 'detail' || NO_REQ(t))) && !(NO_REQ(t) && flat(s).some((x) => x.f !== f && NO_REQ(x.f.type)))).map((t) => ({ value: t, label: TYPES[t] })) };
    if (attr === 'options') return { kind: 'list', title: `${name}有哪些可选项？`, hint: '用顿号、逗号或换行分隔，至少 2 项', placeholder: '如：事假、病假、年假' };
    if (attr === 'withTime') return { kind: 'single', title: `${name}用哪种日期格式？`, options: [{ value: false, label: '年-月-日' }, { value: true, label: '年-月-日 时:分' }] };
    if (attr === 'currency') return { kind: 'single', title: `${name}的币种？`, options: CURRENCIES };
    if (attr === 'children') {
      const have = f.children.map((c) => c.label);
      return { kind: 'multi', allowCustom: true, title: `${name}明细里包含哪些列？`, hint: '选中即确认列的类型，也可以补充其他列', options: DETAIL_COLS.map(parseSug).filter((x) => !have.includes(x.label)).map((x) => ({ value: `${x.label}|${x.type}`, label: x.label, hint: TYPES[x.type] })) };
    }
    return null;
  },

  questions(s, force = {}, hints = {}) {
    const qs = [];
    const have = flat(s).map((x) => x.f.label);
    let sug = (hints.suggestions || []).map(normSug).filter(Boolean).filter((x) => !have.includes(x.label));
    if (!s.fields.length && !sug.length) sug = hints.offline ? libraryFor(hints.context) : GENERIC.map(parseSug);   // 在线时以模型推荐为准，兜底只用通用 5 项
    if (sug.length) {
      qs.push({
        field: 'discovery', kind: 'multi', allowCustom: true, allowEmpty: !!s.fields.length,
        title: s.fields.length ? '还可以考虑下面这些字段，需要吗？' : `做「${hints.context?.name || '这个审批'}」，通常需要收集下面这些信息，你们需要哪些？`,
        hint: '选中即确认字段类型（见右侧小字）；没有想要的，可以在下方补充其他字段',
        options: sug.map((x) => ({ value: `${x.label}|${x.type}`, label: x.label, hint: TYPES[x.type] + (x.reason ? ` · ${x.reason}` : '') })),
      });
    }
    const paths = uniq([...this.missing(s), ...Object.keys(force)]).filter((p) => !['fields', 'confirmed'].includes(p) && !p.endsWith('.required'));
    for (const p of paths) { const q = this._q(p, s); if (q) qs.push({ field: p, reason: force[p] || null, ...q }); }
    const lacking = flat(s).filter(({ f }) => !NO_REQ(f.type) && typeof f.required !== 'boolean');
    if (lacking.length) qs.push({ field: 'required', kind: 'multi', allowEmpty: true, title: '勾选「必填」的字段（不勾选 = 选填）', hint: '是否必填必须由你确认，系统不会默认', options: lacking.map((x) => ({ value: x.f.id, label: plabel(x), hint: x.f.type ? TYPES[x.f.type] : '' })) });
    if (!qs.length && s.fields.length && !s.confirmed) qs.push({ field: 'confirm', kind: 'single', title: `已有 ${flat(s).length} 个字段，还需要补充别的吗？`, options: [{ value: 'yes', label: '没有了，就这些' }, { value: 'more', label: '还要补充' }] });
    return qs;
  },

  answersToPatch(a, s) {
    const ops = [];
    const add = (x, parent) => ops.push({ op: 'add', ...(parent ? { parent } : {}), field: parseSug(x) });
    const custom = (v, parent) => (Array.isArray(v) ? v : []).forEach((l) => ops.push({ op: 'add', ...(parent ? { parent } : {}), field: { label: l, type: null } }));
    for (const [k, v] of Object.entries(a)) {
      if (k === 'discovery') v.forEach((x) => add(x));
      else if (k === 'discovery.custom') custom(v);
      else if (k === 'required') {
        for (const { f } of flat(s).filter(({ f }) => !NO_REQ(f.type) && typeof f.required !== 'boolean')) ops.push({ op: 'update', target: f.id, set: { required: v.includes(f.id) } });
      } else if (k === 'confirm') { if (v === 'yes') ops.push({ op: 'confirm' }); }
      else if (k.endsWith('.children.custom')) custom(v, k.slice(0, -'.children.custom'.length));
      else {
        const i = k.lastIndexOf('.'), id = k.slice(0, i), attr = k.slice(i + 1);
        if (attr === 'children') v.forEach((x) => add(x, id));
        else ops.push({ op: 'update', target: id, set: { [attr]: v } });
      }
    }
    return ops;
  },

  apply(ops, state, opts = {}) {
    const s = structuredClone(state), errors = [], touched = new Set(), rows = [];
    if (!Array.isArray(ops)) return { next: s, touched: [], rows, errors };
    let n = Math.max(0, ...flat(s).flatMap(({ f }) => f.id.match(/\d+/g) || []).map(Number)) + 1;
    let changed = false;
    const err = (field, message) => errors.push({ field, message });

    const resolve = (t) => {
      const list = flat(s);
      const byId = list.find((x) => x.f.id === t);
      if (byId) return byId;
      const byLabel = list.filter((x) => x.f.label === String(t).trim());
      if (byLabel.length === 1) return byLabel[0];
      err(null, byLabel.length ? `有多个叫「${t}」的字段，请说明是哪一个` : `找不到字段「${t}」`);
      return null;
    };
    // 把 spec 里的属性清洗后写进字段（只写与类型相关的属性）
    const setAttrs = (f, spec, parent) => {
      if ('type' in spec && spec.type != null) {
        if (!TYPE_KEYS.includes(spec.type) || (parent && (spec.type === 'detail' || NO_REQ(spec.type)))) { err(`${f.id}.type`, `「${f.label}」不支持类型「${TYPES[spec.type] || spec.type}」`); }
        else if (NO_REQ(spec.type) && flat(s).some((x) => x.f !== f && NO_REQ(x.f.type))) { err(`${f.id}.type`, '假勤系统控件组整个表单最多只能添加一个'); }
        else if (f.type !== spec.type) { f.type = spec.type; f.options = []; f.withTime = null; f.currency = null; f.unit = null; f.min = null; f.max = null; if (NO_REQ(spec.type)) { f.required = null; f.placeholder = null; } if (spec.type !== 'detail') f.children = []; }
      }
      if ('required' in spec && spec.required != null) { if (typeof spec.required === 'boolean') f.required = spec.required; else err(`${f.id}.required`, '必填只能是是/否'); }
      if (isSel(f.type) && 'options' in spec) { f.options = cleanOptions(spec.options); if (f.options.length < 2) err(`${f.id}.options`, `「${f.label}」的选项至少要 2 项`); }
      if (isDate(f.type) && typeof spec.withTime === 'boolean') f.withTime = spec.withTime;
      // 选填属性：仅在管理员明确提到时才设置，不追问
      if (!NO_REQ(f.type) && typeof spec.placeholder === 'string') f.placeholder = spec.placeholder.trim().slice(0, 30) || null;
      if (f.type === 'number' && typeof spec.unit === 'string') f.unit = spec.unit.trim().slice(0, 6) || null;
      if ((f.type === 'number' || f.type === 'money')) for (const k of ['min', 'max']) if (typeof spec[k] === 'number' && isFinite(spec[k])) f[k] = spec[k];
      if (f.min != null && f.max != null && f.min > f.max) { err(`${f.id}.max`, `「${f.label}」最小值不能大于最大值`); f.min = null; f.max = null; }
      if (f.type === 'money' && spec.currency != null) { if (CURRENCIES.some((c) => c.value === spec.currency)) f.currency = spec.currency; else err(`${f.id}.currency`, `币种「${spec.currency}」不支持`); }
    };
    const create = (spec, parent) => {
      const label = typeof spec?.label === 'string' ? spec.label.trim() : '';
      if (!label || label.length > 20) { err(null, `字段名称需为 1~20 字：「${spec?.label ?? ''}」`); return null; }
      const siblings = parent ? parent.children : s.fields;
      if (siblings.some((x) => x.label === label)) { err(null, `已存在同名字段「${label}」`); return null; }
      if (flat(s).length >= 30) { err(null, '字段数量已达上限 30'); return null; }
      const f = { id: parent ? `${parent.id}_c${n++}` : `f${n++}`, label, type: null, required: null, options: [], withTime: null, currency: null, placeholder: null, unit: null, min: null, max: null, children: [] };
      setAttrs(f, spec, parent);
      siblings.push(f); touched.add(f.id); changed = true;
      rows.push({ label: parent ? `新增列（明细表「${parent.label}」）` : '新增字段', new: `${label} · ${f.type ? TYPES[f.type] : '类型待确认'}` });
      if (f.type === 'detail' && Array.isArray(spec.children)) for (const c of spec.children) create(c, f);
      return f;
    };

    for (const op of ops.slice(0, 40)) {
      if (!op || typeof op !== 'object') continue;
      if (op.op === 'add') {
        let parent = null;
        if (op.parent) { const h = resolve(op.parent); if (!h) continue; if (h.f.type !== 'detail' || h.p) { err(null, `「${h.f.label}」不是明细表，不能添加列`); continue; } parent = h.f; }
        create(op.field, parent);
      } else if (op.op === 'update') {
        const h = resolve(op.target); if (!h) continue;
        const { f, p } = h, set = op.set || {};
        if (typeof set.label === 'string') {
          const l = set.label.trim(), sib = p ? p.children : s.fields;
          if (!l || l.length > 20) err(null, '字段名称需为 1~20 字');
          else if (sib.some((x) => x !== f && x.label === l)) err(null, `已存在同名字段「${l}」`);
          else if (l !== f.label) { rows.push({ label: `修改「${f.label}」名称`, old: f.label, new: l }); f.label = l; touched.add(f.id); changed = true; }
        }
        const before = structuredClone(f);
        setAttrs(f, set, p);
        for (const a of ['type', 'required', 'options', 'withTime', 'currency', 'placeholder', 'unit', 'min', 'max']) {
          if (!same(before[a], f[a])) { rows.push({ label: `修改「${plabel(h)}」${ATTRN[a]}`, old: fv(a, before[a]), new: fv(a, f[a]) }); touched.add(f.id); changed = true; }
        }
      } else if (op.op === 'remove') {
        const h = resolve(op.target); if (!h) continue;
        (h.p ? h.p.children : s.fields).splice((h.p ? h.p.children : s.fields).indexOf(h.f), 1);
        rows.push({ label: '删除字段', old: plabel(h) }); touched.add(h.f.id); changed = true;
      } else if (op.op === 'confirm') {
        if (!opts.trusted) { err(null, '「确认字段已齐」只能由管理员点击确认'); continue; }
        if (this.missing(s).filter((m) => m !== 'confirmed').length) { err(null, '还有必填信息未确认，不能完成'); continue; }
        s.confirmed = true;
      }
    }
    if (changed) s.confirmed = false;   // 任何字段变动都要重新确认「是否齐了」
    return { next: s, touched: [...touched], rows, errors };
  },

  // 控件库说明与状态视图：单步访谈(promptSpec)和「一句话搭建」(build.js)共用
  ref() {
    return `${TYPE_KEYS.map((t) => `${t}=${TYPES[t]}`).join('、')}
这是真实后台「设计表单」的控件库，只能用这些类型。约束：明细 detail 的子列不能再是 detail 或假勤控件组；leave/punchfix/overtime 是「假勤系统控件组」，整个表单最多 1 个，自动同步假勤数据，没有必填/提示等属性，只有管理员明确要请假/补卡/加班控件时才用。联系人 contact 即选人控件。
各类型的属性：所有类型都有 label、required、placeholder(默认提示，选填)；select/multiselect 有 options；date/daterange 有 withTime(false=年-月-日, true=年-月-日 时:分)；money 有 currency(CNY/USD/EUR)、min、max；number 有 unit、min、max；detail 有 children。`;
  },
  view(s) {
    return s.fields.map(function f(x) { return { id: x.id, label: x.label, type: x.type, required: x.required, options: x.options, withTime: x.withTime, currency: x.currency, placeholder: x.placeholder, unit: x.unit, min: x.min, max: x.max, children: x.children.map(f) }; });
  },

  promptSpec(s, ctx) {
    return `你是企业管理后台的「配置助手」，正在帮管理员设计审批表单。你的工作方式是「访谈」：弄清客户需要收集哪些信息，再把它们识别成表单字段。

## 上下文（第一步已配置的审批流）
${JSON.stringify(ctx || {})}

## 可用字段类型
${this.ref()}

## 当前表单（id 用于定位；required/type 为 null 表示管理员还没确认）
${JSON.stringify(this.view(s))}

## 输出：只输出一个 JSON 对象，不要 markdown 代码块
{
 "reply": "一两句话，说明你理解了什么 / 为什么推荐这些",
 "ops": [ {"op":"add","field":{"label":"","type":可省略,"required":可省略,"options":可省略}}
        | {"op":"add","parent":"明细表字段id","field":{...}}
        | {"op":"update","target":"字段id或名称","set":{"label|type|required|options|withTime|currency|placeholder|unit|min|max":...}}
        | {"op":"remove","target":"字段id或名称"} ],
 "clarify": [ {"field":"字段id.属性，如 f2.type","reason":"为什么要再确认"} ],
 "suggestions": [ {"label":"","type":"字段类型","reason":"≤10字"} ]
}

## 硬性规则
1. 只提取管理员「明确说出」的字段和属性；绝不猜测。管理员没明说类型（如只说"加个请假天数"）→ add 时不要写 type，系统会弹卡片问。只有他明确说了控件（"金额字段""下拉选择""附件"）才写 type。required/options/withTime/currency 同理，没说就省略；placeholder/unit/min/max 是选填属性，只在管理员明确提到时才写，系统不会追问。
2. 管理员问"还需要什么/有什么推荐/不知道要哪些"，或这是对话开始时：在 suggestions 里结合审批名称/分组/说明，给 5~8 个该场景典型的字段（type 必填且必须来自上面的控件库，供管理员勾选确认；明细类用 detail），此时 ops 置空。不要把 suggestions 直接加成字段。
3. 表述有歧义（如"金额"是预估还是实报）→ 放进 clarify，不要 ops。
4. 绝不输出 confirm 操作；"字段是否齐了"只由管理员点击确认。
5. reply 里不要说"表单已完成"，是否完成由系统判定。`;
  },

  mock(text, s, ctx) {
    const ops = [];
    const wantSug = /开始|推荐|还需要|有什么|不知道/.test(text);
    const strip = (x) => x.replace(/[「」"“”]|字段|控件|一个|个/g, '').trim();
    for (const clause of text.split(/[。；;\n]/)) {
      let m;
      if ((m = clause.match(/(?:删除|去掉|移除)(.+)/))) m[1].split(/[、，,和]/).map(strip).filter(Boolean).forEach((t) => ops.push({ op: 'remove', target: t }));
      else if ((m = clause.match(/(.+?)(?:改成|设为|设置为|改为)?(必填|选填)/)) && s.fields.length) ops.push({ op: 'update', target: strip(m[1]), set: { required: m[2] === '必填' } });
      else if ((m = clause.match(/(?:加上|加个|加一个|增加|添加|新增|再加)(.+)/))) {
        for (const item of m[1].split(/[、，,和及]/).map((x) => x.trim()).filter(Boolean)) {
          const tm = item.match(/^(.+?)[（(]([^）)]+)[）)]$/);
          const typeWord = tm?.[2]; const label = strip(tm ? tm[1] : item);
          const map = { 金额: 'money', 下拉: 'select', 单选: 'select', 多选: 'multiselect', 日期区间: 'daterange', 日期: 'date', 附件: 'attachment', 人员: 'contact', 联系人: 'contact', 银行账户: 'bank', 图片: 'image', 部门: 'dept', 数字: 'number', 多行文本: 'textarea', 单行文本: 'text', 明细: 'detail', 明细表: 'detail' };
          ops.push({ op: 'add', field: { label, ...(typeWord && map[typeWord] ? { type: map[typeWord] } : {}) } });
        }
      }
    }
    return {
      reply: ops.length ? `（离线规则模式）我识别到 ${ops.length} 项字段改动。` : wantSug ? `（离线规则模式）根据「${ctx?.name || '这个审批'}」，我整理了常见字段，你看看需要哪些。` : '（离线规则模式）这句话里没有识别到字段改动。可以说：“加上 请假天数（数字）、附件”。',
      ops, clarify: [], suggestions: [],
    };
  },
};

const approvalFlow = require('./flow')({ DIRECTORY, uniq, same });

module.exports = { CAPABILITIES: { approvalBasic, approvalForm, approvalFlow }, DIRECTORY, TYPES };
