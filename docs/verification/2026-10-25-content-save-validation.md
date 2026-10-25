# 保存前校验与转换失败拒绝

本次改变草稿保存规则。内容语义有 error 时，后台保留本地编辑并定位问题，API 返回 422 且拒绝整个写入。warning、正常空草稿和只改元数据的请求仍可保存。发布要求不变。

结构化 `fieldPath` 从共享校验器传到后台控件。自动保存接收带 revision 的 ready 或 blocked 快照，旧成功或失败不能覆盖新版状态。点击问题后才聚焦，不在输入时自动跳转。服务器拒绝报告不会因为同值元数据刷新而消失。

导入先规划资产 UUID 和上传 basename，再转换所有课时。任何 conversion error 都在上传和创建课程之前拒绝整次导入。CLI 输出完整 conversionReports，真实进程退出码为 1。转换 warning 可以继续。

学员读课错误、重试和块占位仍保留，本次没有新增诊断入口或改动数据库 schema。

## 已完成的验证

以下 API、HTTP 和共享包结果来自本次实施前半程的实际运行。恢复会话时 `/private/tmp` 已清空，原始日志未保留；下列旧日志名用于辨认历史运行，不作为当前可打开的证据。恢复后重新运行的后台和浏览器日志保存在工作区 `.audit/content-verification`。

- API 单测 66 套件、637 项通过。日志 `/private/tmp/content-api-unit-full.log`。
- 独立本地 PostgreSQL 与真实 Nest HTTP，17 套件、109 项通过。日志 `/private/tmp/content-http-integration.log`。
- 摄取与 CLI 定向测试 22 项通过。日志 `/private/tmp/content-ingestion-cli-final.log`。
- 真实 CLI 进程返回 exit 1，完整打印两节课错误，课程、版本、课时和审计计数不变。恢复后重跑仍通过，日志 `../.audit/content-verification/cli-process.log`。
- API 类型检查和 API 构建通过。日志 `/private/tmp/content-api-typecheck-final.log`、`/private/tmp/content-api-build.log`。
- API 改动文件 ESLint 零错误、11 条测试类型警告。日志 `/private/tmp/content-api-scoped-lint.log`。
- admin-contract 8 项通过。共享 lesson-blocks 功能测试 80 项通过，排除了一项已在修改前失败的耗时阈值测试。日志 `/private/tmp/content-contract-green.log`、`/private/tmp/content-shared-scoped-green.log`。

## 最终后台与浏览器验证

- 后台 23 个测试文件、109 项通过。恢复后再次运行，日志 `../.audit/content-verification/admin-tests.log`。
- 后台 TypeScript 检查通过。恢复后再次运行，日志 `../.audit/content-verification/admin-types.log`。
- 后台生产构建通过，构建后核对编辑器文件哈希一致。构建产物保留，原日志 `/private/tmp/content-admin-build-final.log` 已随临时目录清空。
- 使用该生产构建、真实 Nest API、专用本地 PostgreSQL 和原有学员预览渲染器，Chrome 浏览器闭环 1 项通过。日志 `../.audit/content-verification/browser-e2e-complete.log`。覆盖非法图片阻止保存、问题点击聚焦、输入不抢焦点、数据库旧内容保留、上传修复后保存、真实预览、刷新、发布、读课响应 blocks/assets/无 markdown，以及退出。
- 浏览器测试修正了原有精确 label 定位，并补齐原有测试令牌缺少的 issuer。业务鉴权未改动。
- 独立评审模型 gpt-6-astra 找到并复现两处刷新竞争，修复后独立回归 3 项通过。元数据同值刷新不能清除服务器拒绝或重复发送正文；上传资产在旧服务器快照到达时仍保留，服务器确认后仍能反映真实删除。原临时评审报告未保留，此处记录本次会话已完成的评审结果。

一项现有测试要求 bracket-heavy 内容在 1 秒内校验完。该测试在修改前和当前分支均失败，没有放宽断言或在源文件中跳过。原日志 `/private/tmp/content-shared-red.log`、`/private/tmp/content-shared-threshold.log` 已清空。不把共享包描述为全部通过，也没有据此断言性能问题仅由环境导致。

所有数据库运行使用本轮新建的本地 PostgreSQL，监听 `127.0.0.1:55447`。没有连接或修改生产数据库。浏览器对象存储使用本地内存替身，未验证真实 Blob、实验环境、虚拟机或线上部署。这里的正常读课响应是本地证据，不能替代生产响应验证。

## 工作区

分支 `fix/content-ingestion-and-errors`，工作树 `aivirteach-server-content-fixes`，基线 `3966514`。学员 client 没有业务代码改动。未执行数据库迁移变更、生产数据修复或部署。

## 重跑 CLI 拒绝检查

先安装依赖、按当前 schema 生成 Prisma Client、构建 API，并准备已迁移的独立本地 `aivirteach_learning_state` 数据库。脚本要求显式 DATABASE_URL，拒绝远程主机及其他库名。

```sh
DATABASE_URL=postgresql://aivirteach@127.0.0.1:55447/aivirteach_learning_state \
JWT_SECRET=content-save-local-test-secret-at-least-32-characters \
node scripts/verify-content-import-rejection.mjs
```

测试不提供素材文件。若导入在错误转换后仍尝试上传，或 CLI 没有输出完整报告，检查会失败。脚本使用真实 CLI 子进程和真实本地数据库读数，不依赖进程内部的模拟退出码。
