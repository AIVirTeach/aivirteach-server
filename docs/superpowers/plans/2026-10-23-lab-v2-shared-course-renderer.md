# Lab V2 与后台预览共用课程渲染计划

状态：客户端实现和自动化检查已完成，浏览器验收待执行。实现见 [client PR #21](https://github.com/AIVirTeach/aivirteach-client/pull/21)，验证记录在 client 的 `docs/verification/lab-v2-shared-renderer.md`。后台 UI PR #32 已合并并部署。本计划保留到人工验收完成，不能把代码完成视为全部验收完成。

## 目标与现状

运营在后台编辑课程后，预览使用与正式 Lab V2 相同的课程展示组件、样式和块渲染规则。发布后，正式 Lab 按既有课程版本与学员 enrollment 规则读取内容，不再展示与后台数据无关的静态课程 HTML。

实施前核对的 client 入口，以下静态 HTML 描述为历史基线；当前实现见文末实施记录：

- `app/preview/lesson/PreviewClient.tsx` 接收草稿消息，使用 `LessonBlocks`。
- `app/components/CourseLessonContent.tsx` 在 V1 使用 `LessonBlocks`，无 blocks 时回退 Markdown。
- `app/workspace/workspace-v2.tsx` 当时通过 `courseDesignUrl(selectedDesign)` 加载静态 HTML，并通过 iframe DOM 操作接入复制到 VM。
- `app/lib/api.ts` 的 `courseDesigns()` 返回内置设计列表，不能证明正式课程已接入后台发布数据。

这补充了 [4b 计划](2026-10-07-admin-console-4b-course-editor.md) 中明确留出的 V2 接线工作。课程模型计划中的“迁移 B”仍然指删除旧 `body/markdown` 字段，是另一项工作。

## 所有权与接口

渲染代码只维护在 client 仓库。不发布 React npm 包，不在 server 或 admin 复制渲染器。server 继续负责草稿、校验、发布和学员内容 API；admin 继续负责表单及 iframe 通道。

调用关系如下，组件名是拟定名称，实施时按现有目录调整：

```text
正式 Lab：课程 API -> 已发布内容适配 -> CourseLessonView
后台预览：admin postMessage -> 草稿消息适配 -> CourseLessonView
CourseLessonView -> 共用 Lab 课程布局、主题、LessonBlocks
```

`CourseLessonView` 接收课时标题、模块标题、blocks、assets 和明确的交互能力。数据模型沿用现有 client 类型；来自 API 和消息的数据分别在各自边界解析。组件本身不请求 API、不读取运营会话、不解析 postMessage，也不决定课程版本。

交互能力用明确的模式表达：正式模式由 Lab 提供复制到 VM 等回调，预览模式不执行 VM、进度或测评提交。普通复制代码等纯客户端行为保持可用。草稿校验问题由预览入口展示，不因此复制课程布局。

首期一致性范围是课程内容区域，包括标题、块、字体、间距、颜色和内容交互。Lab 外层聊天、VM 和完整课程导航不是课时预览的一部分。全课程导航预览需要单独确认数据范围，不伪造现有消息中没有的数据。

## 设计选择

采用 client 内共用 React 组件：两个入口直接引用同一模块，业务回调由 Lab 注入。将当前 Lab V2 视觉效果转成数据驱动组件，不能仅把旧 V1 预览换个路径便宣称完成。

曾考虑让预览加载整个 workspace 页面，但这会带入登录、VM、聊天和学员状态。课时预览不需要这些依赖。独立复制一套相似页面会产生样式和逻辑漂移；发布前端包也不符合已确认的维护方式。

保留 `/preview/lesson`、ready 握手和现有草稿消息。实施默认不修改 server/admin。若发现必要数据缺失，先列出具体字段、来源、兼容方式和测试，再修订协议；不能通过预览页读取运营凭证或拼接任意 HTML 补齐。

## 实施顺序

### 1. 固定数据及交互边界

- [x] 核对 client 最新 main 的课程 API 类型、课时选择与 enrollment 版本规则。记录发布后既有学员与新学员分别读取哪个版本。
- [x] 盘点静态课程 HTML 的布局、步骤、代码复制、图片和各类特殊交互，映射到现有 13 类块。无法表达的功能列出缺口，不把任意 HTML 放进内容数据。
- [x] 定义共用组件 props、两种输入适配和交互能力；确认现有 title/moduleTitle/blocks/assets 足够覆盖课时预览。
- [x] 固定代表性内容 fixture，包括长标题、图片、步骤、代码、未知或不完整块，以及无 blocks 的旧课程。

### 2. 提取 Lab 课程展示

- [x] 在 client 内提取 Lab V2 课程布局和主题，复用现有 `LessonBlocks` 分发，补齐其 Lab 视觉呈现。保留 V1 调用兼容，不复制另一套块分发器。
- [x] 将依赖 iframe DOM 查询的复制逻辑改为组件事件和 Lab 回调，保留复制到 VM 的结果与错误反馈。
- [x] 以容器宽度实现响应式布局，使后台窄预览和 Lab 侧栏采用同一规则。

### 3. 接入两个入口

- [x] 正式 Lab 用课程 API 内容驱动共用组件，保留加载、失败、空课时和快速切换课时的正确状态，避免迟到响应覆盖当前课时。
- [x] 预览页将现有 postMessage 草稿交给同一组件；保留未收到内容状态、来源校验和最新草稿更新。
- [x] 明确空 blocks 与缺失 blocks 的差别，保留旧课程需要的 Markdown 回退。删除旧字段由迁移 B 单独处理。
- [x] 迁移所有正式课程调用后，检查其他消费者，再移除 V2 静态课程选择及 DOM 桥接的死代码；示例文件有独立用途则保留并标明用途。

### 4. 验证与交付

- [x] 单元测试覆盖两个适配器输入等价、块类型覆盖、草稿诊断、旧内容回退和预览禁用真实副作用。
- [ ] 回调与请求状态测试已覆盖复制结果、课时切换、迟到响应和卸载；预览连续更新、V1 实际交互及真实 VM 仍需浏览器验收。
- [x] 通过 client 类型检查、相关测试和生产构建。
- [ ] 在获准使用浏览器的验收环节，以相同 fixture、主题和容器宽度比较正式 Lab 与预览，检查实际视觉和键盘交互。未执行时保留待验收状态。
- [ ] 验证后台编辑 -> 草稿预览 -> 保存 -> 发布 -> 正式 Lab 按版本规则读取的完整流程。使用专用测试课程，不改真实课程内容。
- [ ] 部署后记录 client 版本、预览地址、origin/CSP 配置与实际 ready/payload 往返结果。上线前后端无需变化的结论必须以协议兼容检查为依据。

## 完成标准

两个入口引用同一课程展示模块，实际展示符合 Lab V2 视觉；后台编辑可预览，发布内容能按版本规则出现在正式 Lab。预览不写学员状态、不触发 VM 操作。测试、浏览器验收和部署证据分别记录，不以编译通过代替展示一致性验收。

## 2026-10-23 实施记录

- 正式 Lab 与预览直接导入 client 的 `CourseLessonView`，13 类块共用 `LessonBlocks`，未修改 server API、数据库或 admin 消息协议。静态 HTML 保留为设计参考，正式入口已移除静态设计选择和 DOM 剪贴板桥接。
- 实际课程读取规则为最新已发布版本，不按 enrollment 固定旧版本。发布后重载工作区可刷新目录；新旧学员重新读取课时都会看到最新发布内容。
- client 21 个测试文件、163 项测试、类型检查、针对改动的 ESLint、生产构建及 8 项产物 HTTP 页面测试通过。两入口使用相同 fixture 的 13 类块 HTML 一致。
- 后台版本 `aacaf55` 已部署至 Vercel，部署 ID `dpl_9maXoKw8vFCcwLvXisK45wWkSGc1`。既有运营账户登录生产 API 成功，并已通过认证 HTTP 请求确认新版后台课程列表可用。
- 未使用浏览器，也未修改生产课程进行测试。像素一致性、iframe 实际消息往返、编辑到发布全流程和真实 VM 交互保留待验收。4c 和旧字段迁移 B 不在本次范围内。
