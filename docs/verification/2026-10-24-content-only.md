# 内容迁移 B：代码合同与数据库交接

## 本轮范围

本轮负责代码，不执行数据库迁移、不生成删列迁移文件、不修改生产数据、不部署。
Prisma schema 表示代码的目标模型，不代表生产数据库已经删列。
历史 migration SQL 不改写。生产删列和正式迁移记录由 Owen 通过 Neon MCP 及迁移工具另行处理。

## 合同

`CourseLesson.content` 是唯一运行时课时正文。
课时 API 返回 `blocks` 数组和资源字典，不再返回 `markdown`。
服务端对 envelope、块属性和资产引用校验失败时返回错误，不回退到旧正文。
合法空数组仍是合法的读取结果；发布必须满足既有非空及内容校验规则。

Markdown 仍是课程导入格式。摄取保留 `sourceMarkdown`、`sourceRange` 与转换器，转换后的结构化正文写入 content。
转换错误保持可见，不把失败结果伪装成成功的空课时。
依赖旧字段的 `course:backfill-content-model` 历史命令退役。
后台草稿 DTO、复制与编辑路径不再读取或写入 body。

Client 的课时 API 边界要求 blocks 数组；正式 Lab 与预览继续共用块渲染。
删除课程 Markdown 回退不影响聊天 Markdown、学习状态、快照或 VM 生命周期。

## 部署前必须由数据库负责人核查

用户交接的基础盘点是 32 个课时都有非空 blocks，本轮没有重新查询生产。
该盘点不能替代完整校验。正式操作前需要：

1. 确认 Neon 项目、分支、数据库，以及生产 API/admin/client 的实际版本。
2. 对所有草稿、已发布和历史版本运行 `LessonEnvelopeSchema` 与 `validateLessonContent`，传入该课程真实资产 ID 集合。
3. 检查转换报告、正文和资源的差异，确认没有只靠 body 保存的内容。
4. 验证历史 LearningSnapshot 引用的版本及正文仍可读取。不要改写快照状态。
5. 创建新的备份与演练分支。旧学习状态迁移之前的备份不能替代本次备份。

## 切换顺序

本次新代码不声明也不查询 body；旧物理列保留且具有现有默认值时，新代码应可先在旧数据库上运行。
这是需要在演练分支核实的兼容条件，不是本轮生产验证结论。

1. 完成全部内容校验。任何生产依赖的课时无效时，先解决数据，不能直接部署强制 blocks 读取。
2. 部署新的 client 和 admin，然后部署新的 API。新 client 可消费旧 API 的 blocks 并忽略额外 markdown；新 admin 应能消费旧 API 的额外 body。此双向接入需要通过演练确认。
3. 确认旧 API 实例及旧 CLI 不再访问数据库，核实真实编辑、预览、发布与读课流程。
4. Owen 确认后执行独立删列操作，并用正式迁移记录对齐仓库与数据库。仅通过 MCP 删列不等于 Prisma 迁移历史已完成。
5. 核对 schema diff、迁移校验和、数据数量以及运行时流程，再关闭计划。

旧 admin 的 DTO 要求 body，不能在仍使用旧 admin 服务代码时切换到移除 body 的新 API。
删列前回滚代码与删列后恢复数据库是两件事。删列后旧 API 不可直接回滚；备份恢复会影响备份之后的写入。

## 验证记录

- API：66 套件、631 项单元测试通过。删除历史回填命令后，其专属测试同步退役；不能把测试数量下降误读为未运行。
- Admin：23 个文件、92 项测试通过；Next 生产构建通过。
- 共享包：lesson-blocks 79 项、admin-contract 6 项测试通过。
- API 构建、覆盖 src/test 的 TypeScript 检查通过。
- Client：237 项单元测试、8 项构建产物 HTTP 渲染测试通过；类型检查及 Cloudflare 生产构建通过。
- 独立审查最初发现 editor 仍引用 body，已修复；复查未发现仍未修复的确定缺陷。独立运行 server 58 项、client 64 项定向测试及 admin TypeScript 检查通过。
- 未执行数据库/HTTP 集成测试、浏览器验收、生产数据核验、DDL、真实 Labs/VM 验证或部署。Client 的 8 项 HTTP 测试只覆盖页面壳，不等同完整业务 E2E。
