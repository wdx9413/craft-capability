# Craft Datasec 子能力

独立的 TypeScript 脱敏核心、私有映射和宿主 hook 适配。没有 Context、Craft Store 或 MCP 依赖。

安装包配置和使用边界见 [插件说明](../../plugins/craft-datasec/README.md)。

- `rules.ts`：本地规则、重叠匹配选择及文本/JSON 脱敏。
- `vault.ts`：宿主与会话隔离的 HMAC 占位符、AES-256-GCM 加密 JSON 映射和 SessionEnd 清理。
- `hook.ts`：Claude/Codex 契约及本地编辑还原。
- `../../bin/craft-datasec-hook.ts`：标准输入 JSON 到标准输出 JSON 的独立进程入口。
- 插件 bundle 由 Craft 源码仓库的 `scripts/release/build-datasec-plugin.ts` 构建；该构建入口不属于此 npm 子能力包。

```sh
npm run build
npm run typecheck
npm run coverage
```

不会安装 `sanitize`，不会自动注册 hook，也不会修改已有插件或公司 PII 配置。


映射由 Datasec 独立持有，不依赖 Craft 主库。新会话不建数据库；每个占位符通过摘要文件名直接定位不可变的加密 JSON，密文带认证标签并绑定占位符。规则仍为 JSON 文件。密钥和映射文件权限为 0600，宿主与会话目录为 0700；拒绝符号链接和不安全权限。正常 SessionEnd 删除该宿主的会话映射及密钥，进程退出仅清除内存，保留同会话后续 Hook 的受控恢复能力。

旧版无宿主归属的目录只允许通过未指定 host 的兼容读取入口隔离读取，保留原会话密钥、占位符和只读 SQLite；不会猜测归属或跨宿主导入。新 Hook 始终显式传入宿主。旧库必要字段仅为 token、name、value，属于遗留兼容数据，新增映射全部写入加密文件。历史清理必须由明确的会话所有者调用清理入口。
