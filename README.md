# AI 配置审批流 · Demo

用自然语言配置管理后台（以「配置审批流」为例）。同一个目标，两种交互形态：

| | 一句话搭建版 | 逐步引导版 |
|---|---|---|
| 地址 | `/oneshot/` | `/guided/` |
| 适合放进 | **管理后台**本身 | **AI 助手**对话里 |
| 体验 | 列表页点「✨ AI 搭建」→ 说一句话 → AI 搭好基础信息 + 表单 + 流程 → 确认一次 → 生成草稿进入编辑器；编辑器右下角常驻「✨ AI 调整」 | 全屏向导，一次只问一题；每题有大白话讲解、推荐项和理由；左侧进度、右侧实时预览；可「问问 AI」、可一键沿用推荐 |
| 核心取舍 | 效率优先：AI 先做默认选择，但每个选择都列出来（分「关键规则 / 常规默认」），你确认一次 | 引导优先：不替你默认，逐项讲清楚再让你选 |

线上地址（发布成功后）：`https://gwb-cloud.github.io/ai-admin-config-demos/`

## 网站上的 AI 是怎么回事

网站是纯静态的（GitHub Pages），**没有后端，也不带任何 API Key**：

- 默认是**离线规则模式**：不调用任何模型，只能演示内置的常见场景（请假、出差/费用报销等）。
- 想体验**真实 AI**：打开任一 demo，点左下角「AI 设置」，填入你自己的 DeepSeek Key。Key 只保存在你这台电脑的浏览器里，由浏览器直接发给 DeepSeek，不会经过、也不会保存到网站上。公共电脑用完请点「清除」。

## 第一次发布到网站（GitHub Desktop，按顺序点）

> 前提：本机 GitHub Desktop 已登录 `gwb-cloud` 账号。

**1. 把本地文件夹加进 GitHub Desktop**
菜单栏 **File → Add Local Repository…** → 点 **Choose…** 选择 `Documents/GitHub/ai-admin-config-demos` → 点 **Add Repository**。
（文件夹里已经有一次本地提交，不用再点 Commit。）

**2. 发布到 GitHub**
窗口顶部点蓝色按钮 **Publish repository** →
- **Name**：`ai-admin-config-demos`（改名的话，网站地址里也会变）
- **Keep this code private**：
  - **取消勾选 = 公开**（免费账号想用 GitHub Pages 必须公开）
  - 勾选 = 私有（私有仓库使用 Pages 需要付费套餐 Pro/Team）
- 点 **Publish Repository**。

**3. 打开 Pages 开关（只需做一次）**
浏览器打开 `https://github.com/gwb-cloud/ai-admin-config-demos` → 顶部 **Settings** → 左侧 **Pages** → **Build and deployment** 里的 **Source** 选 **GitHub Actions**。

**4. 触发部署**
顶部点 **Actions** → 左侧选 **部署 Demo 到 GitHub Pages** → 右侧 **Run workflow** → 绿色 **Run workflow**。
> 第一次 Publish 时会自动跑一次，但那时 Pages 还没打开，所以会标红 ✗——这是正常的，打开 Pages 后手动再跑一次即可。

等约 1 分钟变成绿色 ✓，点进这次运行，在 **deploy** 那一行下面能看到网站地址。

**5. 确认真的上线了**
打开 `https://gwb-cloud.github.io/ai-admin-config-demos/`，两个 demo 都点开试一下（左下角「AI 设置」按钮能看到就说明脚本加载成功）。

## 之后怎么更新

改完文件 → GitHub Desktop 里写一句说明 → **Commit to main** → **Push origin**。推送后会自动检查并重新部署，约 1 分钟生效。
**发布前检查没过的话不会部署**（Actions 里会标红，点进去能看到是哪一项）。

## 本地运行（可选，可以用 .env 里的真实模型）

```bash
cp .env.example .env     # 然后编辑 .env，填入 DEEPSEEK_API_KEY（.env 不会被提交）
npm run dev              # 入口 http://localhost:3000/
npm run check            # 发布前检查：语法 + 引擎冒烟测试 + 密钥扫描
npm run build            # 生成 dist/（部署用的静态站点），一般不用手动跑
```

没有 Node 依赖要安装，`node >= 18` 即可。

## 目录

```
site/                 网站源文件（会被原样发布）
  index.html            入口页
  oneshot/index.html    一句话搭建版（单文件）
  guided/index.html     逐步引导版（单文件）
  shared/api-shim.js    浏览器里的「后端」+ 左下角「AI 设置」
src/                  引擎（与运行环境无关的纯逻辑，Node 和浏览器共用）
  capabilities.js       基础信息 / 表单设计 两个能力
  flow.js               配置流程能力
  build.js              一句话搭建
  engine.js             对话引擎与路由
scripts/              打包 / 构建 / 发布前检查
server.js             本地演示服务（可接真实模型）
.github/workflows/    GitHub Actions 自动部署
```

更多开发背景与注意事项见 [CLAUDE.md](CLAUDE.md)。
