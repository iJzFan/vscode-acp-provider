# ACP 日志未渲染缺口详细分析

## 缺口 #1: 日志级别过滤器
**位置**: `src/tracer.ts:10-14`
```typescript
trace(notification: SessionNotification): void {
  if (this.channel.logLevel === LogLevel.Trace) {  // ← 严格过滤
    const contentStr = JSON.stringify(this.redactLargeContent(notification));
    this.channel.trace(contentStr);
  }
  // 其他级别通知 LOST！
}
```
**影响**: 如果日志通道设置为 `Info`/`Warn`/`Error`，**所有会话通知都不会被记录到日志文件**

---

## 缺口 #2: TurnBuilder 无处理的 sessionUpdate 类型
**位置**: `src/turnBuilder.ts:55-105`

```typescript
processNotification(notification: SessionNotification): void {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      // ✅ 已处理

    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
      break;  // ← **无处理！**
  }
}
```

**5 种无处理的类型**：
- `available_commands_update` - 命令列表变化
- `current_mode_update` - 模式切换
- `config_option_update` - 配置更改
- `session_info_update` - 会话元数据
- `usage_update` - token 使用统计

**影响**: 历史记录缺少这些通知相关的 turn

---

## 缺口 #3: ChatParticipant 双重处理风险
**位置**: `src/acpChatParticipant.ts:599-802`

TurnBuilder 和 ChatParticipant 都有 `processNotification()` 但:
- **TurnBuilder**: 用于**历史记录重建**（离线）
- **ChatParticipant**: 用于**流式 UI 渲染**（在线）

**问题**: 两者的处理逻辑**略有不同**
- TurnBuilder 不处理 5 种类型
- ChatParticipant 也不处理它们
- 导致**某些通知类型在任何地方都无处理**

---

## 缺口 #4: 工具输出字段提取优先级
**位置**: `src/chatRenderingUtils.ts:104-139`

```typescript
if ("formatted_output" in toolCallUpdate.rawOutput && ...) {
  response.output = toolCallUpdate.rawOutput.formatted_output;
} else if ("aggregated_output" in toolCallUpdate.rawOutput && ...) {
  response.output = toolCallUpdate.rawOutput.aggregated_output;
} else if ("output" in toolCallUpdate.rawOutput && ...) {
  response.output = toolCallUpdate.rawOutput.output;
} else {
  response.output = JSON.stringify(toolCallUpdate.rawOutput, null, 2);
}
```

**隐藏的逻辑**: 只提取**第一个存在**的字段
- 如果同时有多个字段，其他字段被**忽略**
- 可能导致重要内容丢失

---

## 缺口 #5: PowerShell CLIXML 截断
**位置**: `src/chatRenderingUtils.ts:182-189`

```typescript
function sanitizeToolOutput(output: string): string | undefined {
  const clixmlMarkerIndex = output.indexOf(POWERSHELL_CLIXML_MARKER);
  const withoutCliXml = clixmlMarkerIndex >= 0
    ? output.slice(0, clixmlMarkerIndex)  // ← 截断！
    : output;
  // ...
}
```

**影响**: Windows PowerShell 输出中，`#< CLIXML` 标记**之后的所有内容被丢弃**

---

## 缺口 #6: 会话历史恢复时的通知损失
**位置**: `src/acpSessionManager.ts:400-426`

```typescript
const response = await this.client.loadSession(...);
// response.notifications 来自 Agent
const turnBuilder = new TurnBuilder(...);
response.notifications.forEach(notification =>
  turnBuilder.processNotification(notification),
);
const history = turnBuilder.getTurns();
```

**问题**: 
- Agent 端 `loadSession()` 可能有**过滤逻辑**
- 某些通知类型可能不被 Agent 返回
- TurnBuilder 又过滤了 5 种类型
- **双重过滤导致信息丢失**

---

## 诊断清单

- [ ] 检查 VS Code OutputChannel 日志级别是否设为 `Trace`
- [ ] 对比 Agent 返回的 `notifications` vs 实际会话更新
- [ ] 验证 `getToolInfo()` 是否取到了所有 rawOutput 字段
- [ ] 测试 PowerShell 工具输出是否被 CLIXML 截断
- [ ] 检查是否有自定义日志过滤中间件
