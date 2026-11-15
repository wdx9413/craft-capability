# craft-capability

独立的能力源码仓库。包含 6 个可单独打包的子能力：

| 包 | npm 名 |
|---|---|
| `capability/craft-knowledge` | `@craft/capability-knowledge` |
| `capability/craft-memory` | `@craft/capability-memory` |
| `capability/craft-experience` | `@craft/capability-experience` |
| `capability/craft-codebase` | `@craft/capability-codebase` |
| `capability/craft-datasec` | `@craft/capability-datasec` |
| `capability/craft-file-dir-desc` | `@craft/capability-file-dir-desc` |

`capability/craft-eval/` 只放指针说明：评测套件是独立仓库 `craft-eval`，不在此发布。

## 依赖边界

本仓库**不依赖 Craft 内核源码**（`core/` 零引用）。子能力只引用 `craft-common-*`
公共包（含 `craft-common-ontology` 共享概念分类），或以包名引用本仓库内的其他子能力；
`craft` 内核通过 npm 包依赖这些能力，不产生循环依赖。

## 本地联调

子能力通过 `package.json` 的 `craft-common-*` 版本依赖解析公共包，源码里不再有
相对 `common/` 路径，也不需要在本地建 junction。

```text
pnpm install
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

`tsconfig.json` 排除 `dist/` 与生成物；`craft-datasec/build.ts` 需要 `esbuild`，
只在打包时执行，故不在源码 typecheck 范围内。
