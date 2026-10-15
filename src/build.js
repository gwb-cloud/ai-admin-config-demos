// 一句话搭建：一次生成 基础信息 + 表单字段 + 审批流程，再让管理员一次性确认。
//
// 设计取舍（与前三步的「逐项追问」互补）：
//   - 效率优先：管理员没说的部分，AI 按业界通行做法补全，而不是追问
//   - 透明兜底：AI 替管理员做的每个选择都列在 assumptions 里，分「关键规则 / 常规默认」两档，
//     管理员看一眼、点一次确认；不对的直接对话修改
//   - 只有真的无法判断场景时才反问（ask）
//   - 模型输出仍然一律走各 capability 的 apply 校验（类型/通讯录/角色/条件字段/假勤控件组上限…），不信任模型
const { CAPABILITIES, DIRECTORY } = require('./capabilities');

const { approvalBasic: B, approvalForm: F, approvalFlow: FL } = CAPABILITIES;

const listForm = (fs) => fs.fields.filter((f) => ['money', 'number', 'date', 'select'].includes(f.type)).map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options, currency: f.currency }));
const isEmpty = (st) => !st.basic.name && !st.form.fields.length && !st.flow.nodes.length;

function buildPrompt(st, prevAssumptions) {
  const fresh = isEmpty(st);
  return `你是企业管理后台的「审批搭建助手」。管理员用一句话（或几句话）描述想要的审批，你要一次性把整个审批搭建出来：基础信息 + 表单字段 + 审批流程，然后让管理员一次性确认。

## 核心原则
1. 效率优先：管理员没说的部分，用业界通行做法补全，不要追问。目标是他看一眼就能点「确认」。
2. 透明兜底：你替他做的每一个选择，都必须写进 assumptions，用大白话，分两档：
   - key=true「关键规则」：会改变业务结果的策略——谁审批（审批层级/角色）、谁能发起、金额或天数阈值、抄送给谁、是否按条件分流。
   - key=false「常规默认」：币种、日期格式、字段是否必填、下拉选项、提示语、是否在工作台展示等。
   管理员亲口说过的内容不用列。assumptions 是「当前仍然有效的完整清单」，不是只列本轮新增；管理员推翻的要删掉。
3. 只有真的无法判断业务场景时（例如只说"配置一个审批"）才返回 ask 让他选场景；其余一律直接搭建，不要为了稳妥而反问。
4. 管理员很专业、说得很细：严格照他说的做，少做假设，assumptions 自然很少。
5. 管理员是新手（如"做个请假审批"）：按最常见的最佳实践搭好，reply 用一两句大白话说明搭了什么，别用术语。

## 能力说明
### ① 基础信息 basic（patch 对象）
${B.ref()}

### ② 表单字段 form（ops 数组）
${F.ref()}
ops 格式：{"op":"add","field":{"label":"","type":"","required":true,"options":[],"withTime":false,"currency":"CNY","children":[...]}} | {"op":"update","target":"字段id或名称","set":{...}} | {"op":"remove","target":"字段id或名称"}

### ③ 审批流程 flow（ops 数组）
${FL.ref()}
ops 格式：{"op":"add","node":{"kind":"approval|notify|branch",...}}（分支内节点必须内联在 branches[].nodes 里，不要引用尚不存在的 id）| {"op":"update","target":"节点id/分支id/条件id/flow/start/end 或名称","set":{...}} | {"op":"remove","target":"..."}。
条件里的 field 可以直接写表单字段「名称」（字段 id 要创建后才有）。

## 通讯录（审批人尽量不用具体人名）
${DIRECTORY.map((d) => `${d.name}(${d.dept})`).join('、')}

## 当前状态
${fresh ? '（全新搭建，当前为空）' : `基础信息：${JSON.stringify(B.view(st.basic))}
表单字段：${JSON.stringify(F.view(st.form))}
审批流程：${JSON.stringify(FL.view(st.flow))}
这是在已有方案上的「增量修改」：用 update/remove/add 精确改动，id 取自上面的状态，不要整体重建；basic 只给变更字段；没被提到的部分保持不变。`}
上一轮的假设清单：${JSON.stringify(prevAssumptions || [])}

## 输出：只输出一个 JSON 对象，不要 markdown 代码块
{
 "reply": "给管理员的一两句话",
 "ask": null 或 {"title":"想搭建哪类审批？","options":[{"label":"请假","desc":"一句话"}]},
 "basic": {...} 或 null,
 "form": [ops] 或 null,
 "flow": [ops] 或 null,
 "assumptions": [{"step":"basic|form|flow","key":true,"text":"审批层级：先由直属上级审批，再由 HRBP 审批"}]
}

## 搭建规则
- basic（全新搭建要给齐）：name ≤20 字；description 一句≤50 字；category 从枚举里选最贴切的；initiator 默认 {"scope":"all","members":[]}（除非管理员限定）；showInWorkbench 默认 true。
- form（全新搭建全是 add，4~8 个字段为宜）：每个 add 都要带完整属性——type、required(true/false)、select/multiselect 的 options(≥2 项)、date/daterange 的 withTime、money 的 currency(默认 "CNY")、detail 的 children（每一列也要完整）。字段名称要贴合业务、简短。
  假勤场景（请假/补卡/加班）优先用对应的假勤系统控件组 leave/punchfix/overtime（整个表单最多 1 个；它自动同步假期类型、余额、时间范围等，无需再建这些字段），再补充事由、附件等。
- flow（全新搭建全是 add，节点 ≤6 个）：审批人优先用 manager / deptHead / role(只能用清单里的角色) / self，不要编造人名，除非管理员点名才用 members。每个 approval 都要带完整属性：approver、emptyApprover(默认 autoPass)、sameAsSubmitter(默认 self)，审批人可能多人时(role/多成员)再加 multiMode(默认 any)。最后追加一个 {"op":"update","target":"flow","set":{"repeatApprover":"once"}}。
  「其他情况」是条件分支节点自带的固定出口，不要自己再建一个叫「其他情况/否则」的分支；条件分支节点里只建「满足条件才进入」的分支，不满足的自动走「其他情况」（通常什么都不做，即流程继续往下）。职务角色(role)类审批人必须同时给 multiMode。
  条件分支只能引用你刚创建的 number/money/date/select 表单字段（用字段名称引用），且只在业务确有必要时使用（如金额分级）；阈值给业界常见值，并写成 key=true 的假设。若用了假勤控件组，它里面的天数不能做条件，别硬凑分支。
- reply、assumptions 的描述必须与你实际输出的 ops 完全一致（职务角色只能用清单里有的，不要在文字里说成别的角色）。
- 绝不输出 confirm 之类的操作；"整体是否确认"只由管理员点击。reply 不要说"已完成"。`;
}

// ---------- 离线兜底：两个常见场景的完整方案 ----------
const A = (extra) => ({ op: 'add', node: { kind: 'approval', emptyApprover: 'autoPass', sameAsSubmitter: 'self', ...extra } });
const MOCKS = [
  {
    re: /请假|休假/,
    reply: '（离线规则模式）已按常规的请假审批搭好：用系统的请假控件组 + 事由 + 附件，先直属上级、再 HRBP 审批。',
    basic: { name: '请假申请', description: '员工请假审批，自动同步假期类型与余额', category: '考勤管理', initiator: { scope: 'all', members: [] }, showInWorkbench: true },
    form: [
      { op: 'add', field: { label: '请假', type: 'leave' } },
      { op: 'add', field: { label: '请假事由', type: 'textarea', required: true } },
      { op: 'add', field: { label: '附件', type: 'attachment', required: false } },
    ],
    flow: [A({ approver: { type: 'manager' } }), A({ approver: { type: 'role', role: 'HRBP' }, multiMode: 'any' }), { op: 'update', target: 'flow', set: { repeatApprover: 'once' } }],
    assumptions: [
      { step: 'flow', key: true, text: '审批层级：先由发起人的直属上级审批，再由 HRBP 审批' },
      { step: 'basic', key: true, text: '所有员工都可以发起请假' },
      { step: 'form', key: false, text: '用系统的「请假」控件组，自动同步假期类型与余额，不再单独建请假类型/天数字段' },
      { step: 'form', key: false, text: '请假事由必填，附件选填' },
      { step: 'basic', key: false, text: '分组归到「考勤管理」，并在员工工作台展示' },
      { step: 'flow', key: false, text: '找不到审批人时自动通过；审批人与提交人同一人时由提交人自己审批；同一审批人重复出现仅审批一次' },
    ],
  },
  {
    re: /出差|报销|费用|经费/,
    reply: '（离线规则模式）已按常规的费用报销搭好：事由、日期、费用明细、附件，直属上级审批，超过 5000 元再加财务总监。',
    basic: { name: '费用报销', description: '员工费用报销审批', category: '财务管理', initiator: { scope: 'all', members: [] }, showInWorkbench: true },
    form: [
      { op: 'add', field: { label: '报销事由', type: 'textarea', required: true } },
      { op: 'add', field: { label: '发生日期', type: 'daterange', withTime: false, required: true } },
      { op: 'add', field: { label: '报销金额', type: 'money', currency: 'CNY', required: true } },
      { op: 'add', field: { label: '费用明细', type: 'detail', required: true, children: [
        { label: '费用类型', type: 'select', options: ['交通', '住宿', '餐饮', '其他'], required: true },
        { label: '金额', type: 'money', currency: 'CNY', required: true },
        { label: '说明', type: 'text', required: false },
      ] } },
      { op: 'add', field: { label: '发票附件', type: 'attachment', required: false } },
    ],
    flow: [
      A({ approver: { type: 'manager' } }),
      { op: 'add', node: { kind: 'branch', branches: [{ name: '大额', conditions: [[{ field: '报销金额', op: 'gt', value: 5000 }]], nodes: [{ kind: 'approval', approver: { type: 'role', role: '财务总监' }, emptyApprover: 'autoPass', multiMode: 'any', sameAsSubmitter: 'self' }] }] } },
      { op: 'update', target: 'flow', set: { repeatApprover: 'once' } },
    ],
    assumptions: [
      { step: 'flow', key: true, text: '审批层级：先由直属上级审批' },
      { step: 'flow', key: true, text: '报销金额超过 5000 元时，再加「财务总监」审批（5000 是常见门槛，请按公司制度调整）' },
      { step: 'basic', key: true, text: '所有员工都可以发起报销' },
      { step: 'form', key: false, text: '费用类型选项：交通 / 住宿 / 餐饮 / 其他；金额币种为人民币' },
      { step: 'form', key: false, text: '事由、日期、金额、费用明细必填；发票附件选填' },
      { step: 'flow', key: false, text: '找不到审批人时自动通过；审批人与提交人同一人时由提交人自己审批；重复审批人仅审批一次' },
    ],
  },
];
function mockBuild(text) {
  const m = MOCKS.find((x) => x.re.test(text));
  if (!m) return { reply: '（离线规则模式）我还不确定你要搭建哪类审批，请选一个场景。', ask: { title: '想搭建哪类审批？', options: [{ label: '请假审批', desc: '考勤类，用请假控件组' }, { label: '费用报销', desc: '财务类，含费用明细与金额分级' }] } };
  const { re, ...rest } = m; // eslint-disable-line no-unused-vars
  return { ask: null, ...rest, basic: { ...rest.basic, name: /出差/.test(text) ? '出差报销' : rest.basic.name } };
}

// ---------- 统一处理：模型输出 → 三个 capability 逐个校验应用 → 汇总 ----------
async function handleBuild(body, askModel) {
  const st = { basic: body.states?.basic || B.empty(), form: body.states?.form || F.empty(), flow: body.states?.flow || FL.empty() };
  const history = (body.messages || []).slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const prev = Array.isArray(body.assumptions) ? body.assumptions.slice(0, 30) : [];

  let out;
  try { out = askModel ? await askModel(buildPrompt(st, prev), history) : mockBuild(lastUser); }
  catch (e) { return { status: 'error', reply: `模型调用失败：${e.message}` }; }

  if (out.ask && Array.isArray(out.ask.options) && out.ask.options.length) {
    return { status: 'ask', reply: String(out.reply || ''), ask: { title: String(out.ask.title || '想搭建哪类审批？').slice(0, 40), options: out.ask.options.slice(0, 6).map((o) => ({ label: String(o.label || '').slice(0, 20), desc: String(o.desc || '').slice(0, 40) })).filter((o) => o.label) } };
  }

  const errors = [];
  const tag = (step, r) => r.errors.forEach((e) => errors.push(`${{ basic: '基础信息', form: '表单', flow: '流程' }[step]}：${e.message}`));
  const b = B.apply(out.basic, st.basic, {});
  const f = F.apply(out.form, st.form, {});
  const flowCtx = { basic: b.next, form: listForm(f.next) };
  const fl = FL.apply(out.flow, st.flow, { ctx: flowCtx });
  tag('basic', b); tag('form', f); tag('flow', fl);

  const forceOf = (r) => Object.fromEntries(r.errors.filter((e) => e.field).map((e) => [e.field, e.message]));
  const ctxFor = { name: b.next.name, category: b.next.category, description: b.next.description, ...flowCtx };
  // 追问只保留「真缺」的信息；整体确认由总览页一次完成，所以去掉各步自己的 confirm
  const qs = (cap, next, r, ctx) => cap.questions(next, forceOf(r), { context: ctx, offline: !askModel }).filter((q) => q.field !== 'confirm');
  const questions = { basic: qs(B, b.next, b, ctxFor), form: qs(F, f.next, f, ctxFor), flow: qs(FL, fl.next, fl, ctxFor) };

  const assumptions = (Array.isArray(out.assumptions) ? out.assumptions : [])
    .filter((a) => a && typeof a.text === 'string' && ['basic', 'form', 'flow'].includes(a.step))
    .slice(0, 20).map((a) => ({ step: a.step, key: !!a.key, text: a.text.slice(0, 140) }));

  const pack = (cap, r) => ({ next: r.next, rows: r.rows, touched: r.touched, missing: cap.missing(r.next), changed: r.touched.length > 0 });
  return {
    status: Object.values(questions).some((q) => q.length) ? 'need_info' : 'ready',
    reply: String(out.reply || ''),
    applied: { basic: pack(B, b), form: pack(F, f), flow: pack(FL, fl) },
    assumptions, questions, errors,
  };
}

module.exports = { handleBuild, buildPrompt };
