# 课程内容模型：剩余迁移 B

2026-10-22 清理：原 Task 1–12 主体已由 server PR #20 实现；PR #22 明确保留本计划的原因是 Task 13 迁移 B。已完成的实施步骤已移除，历史可从 Git 找回。admin 令牌守卫已被 PR #24 的运营鉴权替代，不再重复实施旧守卫。

## 当前证据与范围

- `apps/api/prisma/schema.prisma` 仍有 `Progress.currentLessonId`、`Enrollment.currentModuleId`。
- `apps/api/src/admin/backfill/content-model-backfill.service.ts` 仍读取旧进度字段和 body；不能只删 schema 后再生成类型。
- `apps/api/src/courses/lesson-response.ts` 仍下发 `markdown: lesson.body`。课时块设计规定迁移 B 也移除 body/markdown；client 仍有 Markdown 回退消费者。
- 当前没有生产回填完整性、观察期和旧客户端退出使用的核实记录。本次不执行数据库变更。

## 剩余执行清单

- [ ] 核实生产迁移 A/回填结果、未转换内容和进度映射，确认观察期满足要求。
- [ ] 明确 B 的合同：旧进度字段删除、body 删除、markdown 响应删除是否同批发布。核查 client、CLI 摄取、回填命令、草稿服务、测试及外部响应消费者，列出实际迁移顺序；不能只删两列。
- [ ] 迁移或移除旧字段消费者，保留必要的历史恢复流程；确认客户端块渲染已上线，旧数据无需 Markdown 回退。
- [ ] 编写位于 `apps/api/prisma/migrations/` 的迁移，制作前后对比与备份恢复方案；不可逆操作仍须 Owen 明确确认。
- [ ] 用本地数据库演练：有旧进度、空 content、非法 content、正常块课程；数据不丢失，类型检查、相关单测和读课/发版 E2E 通过。
- [ ] 经确认后按已验证顺序备份、部署兼容代码、执行迁移，并记录生产结果与回滚边界。

设计依据：[课程内容模型](../specs/2026-09-29-course-content-model-design.md)、[课时块](../specs/2026-10-01-lesson-blocks-design.md)。后台编辑属于独立的 [4b 计划](2026-10-07-admin-console-4b-course-editor.md)。
