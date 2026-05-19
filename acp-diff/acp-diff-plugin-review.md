# Plan: enable ACP filesystem capabilities and terminal support

## Goal

在 v0.4.9 中启用 ACP 客户端 filesystem capabilities（`readTextFile` / `writeTextFile`）和 terminal 支持，使代理可以通过协议直接读写文件和使用终端功能。

但 `out/acpClient.js` 编译产物存在文件头错误，需要同时修复。

## Background

前一版本 v0.4.8 已添加了 Command Palette action `ACP: Import Auggie manual commands`，以及相应的 parser tests。

当前工作中为 ACP Client 新增了 `fs.readTextFile`、`fs.writeTextFile` 以及 terminal 支持，然而编译产出的 `out/acpClient.js` 文件头被错误拼接，导致扩展无法正常加载。

## Root cause

`package.json` 声明 `"type": "commonjs"`，但损坏后的 `out/acpClient.js` 文件开头包含了如下顶层片段：

```js
const openDoc = vscode.workspace.textDocuments.find(...);
...
const bytes = await vscode.workspace.fs.readFile(uri);
```

顶层 `await` 在 CommonJS 模块中非法，扩展宿主解析时抛出语法错误。

## Current state confirmed before repair

- `out/acpClient.js` 已在 `AcpClientImpl` 内部实现了 `readTextFile`/`writeTextFile` 方法和 capability 开关，但编译产物文件头损坏
- 工作区是 **安装后的扩展包**，没有 `src/` 或 `tsconfig.json`，因此这次修复应直接针对 `out/` 产物

## Repair strategy

### 1. Restore the compiled CommonJS prologue in `out/acpClient.js`

将文件顶部替换为正常的 TypeScript 编译输出前导：

- `"use strict";`
- `__createBinding`
- `__setModuleDefault`
- `__importStar`

并删除误插入到顶层的残缺方法体。

### 2. Preserve the intended ACP filesystem hotfix

保留 `AcpClientImpl` 内部已经存在的下列方法与 capability 开关：

- `CLIENT_CAPABILITIES.fs.readTextFile = true`
- `CLIENT_CAPABILITIES.fs.writeTextFile = true`
- `async readTextFile(params)`
- `async writeTextFile(params)`

也就是说：**修的是文件结构，不是回退功能。**

### 3. Ship as a patch hotfix

根据仓库版本策略，这是 bug fix + feature enablement，版本号从：

- `0.4.8` → `0.4.9`

对应 `CHANGELOG.md` 中的条目：

- **v0.4.9**: Enabled ACP client filesystem capabilities (`readTextFile` / `writeTextFile`) and terminal support so agents can read/write files and use terminal features directly through the protocol.

## Validation plan

1. 打开 `out/acpClient.js`，确认文件从 `"use strict";` 开始
2. 确认顶层不再出现裸 `await`
3. 运行语法校验，确保 `out/acpClient.js` 可被 CommonJS 解析
4. 尝试运行 `npm run compile`
   - 如果失败，应记录原因：安装包不包含 `tsconfig.json` / `src/`，无法在当前目录重新编译

## Files changed by the hotfix

| File | Action | Reason |
|------|--------|--------|
| `out/acpClient.js` | **Modify** | 恢复合法的 CommonJS 模块头，移除误插入的顶层 `await` |
| `package.json` | **Modify** | patch 版本升级到 `0.4.9` |
| `CHANGELOG.md` | **Modify** | 记录 v0.4.9 的 filesystem capabilities + terminal 支持启用 |

## Notes

- 原 `acp-client-patch.diff` 文件顶部存在孤立的 `+` 行，格式不合法，需要重写为干净的 unified diff
- 如需长期修复，应该在真正的源码仓库中修正后重新编译并重新打包 VSIX；本次仅修复本机已安装扩展使其恢复可用
