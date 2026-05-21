# ACP Client.log 内容渲染链路排查报告

## 执行摘要
ACP Client.log 日志内容从产生到 UI 渲染的完整链路已识别。**可能的缺口点**：日志层级过滤（Trace级别）、通知内容过滤、某些 `sessionUpdate` 类型无对应渲染逻辑。

---

## 日志产生 → UI 渲染完整链路

### 1️⃣ **日志产生层** (src/tracer.ts)
- **函数**: `Tracer.trace(notification)`
- **过滤机制**: 
  - ✅ 仅当 `logLevel === LogLevel.Trace` 时记录
  - ✅ 大内容自动脱敏（text、diff、output）
  - ⚠️ **缺口**: 如果日志级别非 Trace，则**完全不记录通知**

### 2️⃣ **通知采集/解析** (src/acpClient.ts + src/acpSessionManager.ts)
- **来源**: Agent 进程 via ACP SDK (`connection.onSessionUpdate`)
- **存储方案**:
  - 新会话: `createSession()` → 无历史
  - 载入旧会话: `loadSession()` → 返回 `SessionNotification[]`
- **关键过滤**:
  ```typescript
  // acpClient.ts:253-257
  notifications.push(notification);  // 所有通知都收集
  ```

### 3️⃣ **通知→历史记录映射** (src/turnBuilder.ts)
- **核心函数**: `TurnBuilder.processNotification(notification)`
- **处理的 sessionUpdate 类型**:
  - ✅ `agent_message_chunk` → Markdown
  - ✅ `agent_thought_chunk` → Progress 部分
  - ✅ `tool_call` → ChatToolInvocationPart
  - ✅ `tool_call_update` → Tool 完成状态 + Diff
  - ✅ `plan` → Markdown 表格
  - ❌ **无处理**: `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`

### 4️⃣ **状态管理** (src/acpSessionManager.ts)
- **会话恢复**: 载入时调用 `TurnBuilder.getTurns()`（行 417-421）
- **会话同步**: `syncSessionState()` 更新内存活跃会话
- **Diff 追踪**: `recordToolDiffArtifacts()` 累积文件修改

### 5️⃣ **UI 渲染入口** (src/acpChatParticipant.ts)
- **主处理器**: `renderSessionUpdate(notification, response, session)`（行 599-802）
- **渲染路由**:
  - `agent_message_chunk` → `response.markdown()`
  - `agent_thought_chunk` → `response.thinkingProgress()`
  - `tool_call` → `response.beginToolInvocation()`
  - `tool_call_update` (完成) → `response.push(ChatToolInvocationPart)`
  - `plan` → `renderPlanUpdate()` (TodoList 工具 or Markdown)

---

## 识别的可能缺口点

| # | 缺口位置 | 症状 | 原因 | 影响范围 |
|---|---------|------|------|---------|
| **1** | Tracer.trace() | 日志级别非 Trace 时无记录 | 仅 `if(logLevel === Trace)` | 所有通知都可能漏记 |
| **2** | turnBuilder.processNotification() | 5 种 sessionUpdate 无处理 | 无 case 分支 | `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update` |
| **3** | chatRenderingUtils.getToolInfo() | 输出提取逻辑多重嵌套 | 优先级: `formatted_output` > `aggregated_output` > `output` | tool 输出可能取错字段 |
| **4** | sanitizeToolOutput() | PowerShell CLIXML 截断 | 正则匹配前 N 字符 | Windows 工具输出被截断 |
| **5** | turnBuilder + chatParticipant 双重处理 | 通知被处理两次 | 两个类都有 `processNotification()` | 可能导致数据不一致 |

---

## 文件职责映射

| 文件 | 职责 |
|------|------|
| `tracer.ts` | 日志采集与脱敏 |
| `acpClient.ts` | Agent 连接 & 通知原始接收 |
| `acpSessionManager.ts` | 会话生命周期、磁盘 I/O、历史恢复 |
| `turnBuilder.ts` | 通知→历史记录序列化 |
| `chatRenderingUtils.ts` | 通知字段提取 & 工具输出格式化 |
| `acpChatParticipant.ts` | UI 流式渲染执行 |

---

## 最相关的诊断步骤

1. **验证日志级别**：检查 OutputChannel 是否设为 Trace
2. **检查通知流**：在 `acpClient.ts:253` 和 `acpChatParticipant.ts:602` 插入断点
3. **对比 TurnBuilder vs ChatParticipant**：两者是否处理相同通知集合
4. **核实文件提取**：查看 `chatRenderingUtils.getToolInfo()` 的字段优先级
