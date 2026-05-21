# ACP 日志渲染链路 - 精确代码位置

## 📍 完整链路地图

```
Agent进程 (stdio)
    ↓
acpClient.ts:550-550 [onSessionUpdate 事件]
    ↓
tracer.ts:10-14 [Tracer.trace() - 日志采集 + 脱敏]
    ├─ ⚠️ 日志级别过滤: if(logLevel === Trace)
    └─ redactLargeContent() 脱敏 (行17-79)
    ↓
acpChatParticipant.ts:599-802 [renderSessionUpdate() - 流式渲染]
    ├─ agent_message_chunk (606-613)
    ├─ agent_thought_chunk (615-623)
    ├─ tool_call (625-666)
    ├─ tool_call_update (668-769)
    ├─ plan (771-773)
    └─ ❌ 无: available_commands_update, config_option_update等
    ↓
vscode.ChatResponseStream [最终UI渲染]
```

---

## 🔑 关键函数速查

| 函数 | 文件 | 行号 | 用途 |
|------|------|------|------|
| `Tracer.trace()` | tracer.ts | 10 | 日志脱敏采集 |
| `renderSessionUpdate()` | acpChatParticipant.ts | 599 | 主渲染分发 |
| `getToolInfo()` | chatRenderingUtils.ts | 68 | 工具输出提取 |
| `sanitizeToolOutput()` | chatRenderingUtils.ts | 182 | 清理 CLIXML |
| `processNotification()` | turnBuilder.ts | 55 | 历史记录序列化 |
| `createOrGet()` | acpSessionManager.ts | 314 | 会话恢复 |
| `loadSession()` | acpClient.ts | 237 | Agent通知接收 |

---

## ⚠️ 五大缺口精确位置

### 缺口1: 日志级别门槛
- **文件**: tracer.ts
- **行号**: 11
- **代码**: `if (this.channel.logLevel === LogLevel.Trace)`
- **修复方向**: 改为 `logLevel !== LogLevel.Off`

### 缺口2: TurnBuilder 无处理类型
- **文件**: turnBuilder.ts
- **行号**: 98-103
- **缺失处理**: `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`
- **修复方向**: 为各类型添加 case 分支并构建对应 Part

### 缺口3: ChatParticipant 同样无处理
- **文件**: acpChatParticipant.ts
- **行号**: 775-779
- **代码**: `case "current_mode_update": { break; }`
- **修复方向**: 添加渲染逻辑（参考 plan 的 renderPlanUpdate）

### 缺口4: 工具输出字段冲突
- **文件**: chatRenderingUtils.ts
- **行号**: 104-139
- **问题**: 只取第一个存在的字段
- **修复方向**: 考虑合并多字段或记录取舍逻辑

### 缺口5: CLIXML 硬截断
- **文件**: chatRenderingUtils.ts
- **行号**: 183-184
- **代码**: `output.slice(0, clixmlMarkerIndex)`
- **修复方向**: 改为解析和转义 CLIXML，而非丢弃

---

## 🧪 测试验证点

1. **日志收集测试** (tracer.ts)
   - 设 logLevel 为各级别，验证日志是否写入

2. **通知流测试** (acpClient.ts:253)
   - 在 `notifications.push()` 处打断点，验证所有通知类型

3. **历史重建测试** (acpSessionManager.ts:418)
   - 对比磁盘会话的 notification 数 vs 最终 history turns 数

4. **输出完整性测试** (chatRenderingUtils.ts:104)
   - 对于同时包含多字段的 rawOutput，验证哪个字段被用

5. **CLIXML 截断测试** (chatRenderingUtils.ts:183)
   - PowerShell 工具的长输出是否被完整显示
