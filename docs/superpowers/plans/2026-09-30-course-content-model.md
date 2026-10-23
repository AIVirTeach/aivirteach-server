# 课程内容迁移 B：正文只使用结构化 content

## 范围与责任

2026-10-24：本轮只交付 server/client 代码、测试、PR 和数据库交接说明。
Owen 使用 Neon MCP 负责生产数据核验、备份和删列。本轮不创建或执行数据库迁移，不部署。

此前完成的 Enrollment.learningState、LearningSnapshot 和旧进度表删除不属于本计划，不能重复执行。

## 代码合同

- `CourseLesson.content` 是唯一运行时课时正文；Prisma 模型不再包含 `body`。
- 课时 API 返回 `blocks` 数组及 `assets`，不返回课程 `markdown`。
- 无效或缺失的已存内容返回明确错误，不用 Markdown 或空数组掩盖。
- 合法空 blocks 与非法内容不同；草稿可为空，发布继续执行非空及块内容校验。
- Lab 与后台预览共用块渲染；客户端不再提供课程正文 Markdown 回退。
- Markdown 摄取输入、`sourceMarkdown` 和转换器保留；导入结果只写 content。
- 聊天 Markdown、学习状态、快照模型、VM 生命周期不变。

## 代码交付

- [x] Server：移除 body 的查询、写入、草稿复制、DTO 和 Prisma 类型依赖。
- [x] 移除依赖旧字段的历史回填入口，保留课程导入转换能力。
- [x] Client：移除课程 markdown 类型、回退组件和所有调用。
- [x] 验证正文读取、导入、草稿、发布、预览合同与测试。
- [x] 独立审查两个仓库，分别提交 PR，记录验证边界。

## Owen 的生产操作前提

以下不是本轮已完成事项：

- [ ] 核对生产目标、最新代码部署和 migration checksums。
- [ ] 对全部版本运行完整块校验及资产检查，核对转换差异与历史快照引用。
- [ ] 准备新的备份和演练分支，确认无 body-only 课时后再切换运行时。
- [ ] 按 [数据库交接说明](../../verification/2026-10-24-content-only.md) 的顺序部署和删列。
- [ ] 用可追踪的新迁移记录最终 DDL，已执行迁移文件及校验和不得改写。
- [ ] 生产验收通过后关闭计划。

历史生产盘点由用户交接：5 个有课时的版本、32 个课时均有非空 blocks；
该结果仅检查基础 envelope，不证明完整 props、资产或内容等价性，本轮没有重新访问生产数据库。
