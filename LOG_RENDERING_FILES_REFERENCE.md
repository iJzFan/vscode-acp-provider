# ACP 日志渲染链路 - 文件快速参考

## 按链路顺序的文件地图

### 阶段 1: 日志采集与脱敏
```
src/tracer.ts
├─ 类: Tracer
├─ 关键方法: trace(notification)
├─ 行范围: 7-115
├─ 缺口: 行11 - logLevel 过滤严格
└─ 脱敏逻辑: redactLargeContent() 行17-79
```

### 阶段 2: 原始通知接收
```
src/acpClient.ts
├─ 类: AcpClientImpl
├─ 关键方法: loadSession() 行237-283
├─ 通知收集: 行253-256
├─ 缺口: Agent 端可能有过滤
└─ 日志输出: logChannel (行309, 415, 427等)
```

### 阶段 3a: 历史记录重建（离线）
```
src/turnBuilder.ts
├─ 类: TurnBuilder
├─ 关键方法: processNotification() 行55-105
├─ 已处理类型: 行59-103 (7种)
├─ 缺口: 行98-103 - 5种无处理
│  ├─ available_commands_update
│  ├─ current_mode_update
│  ├─ config_option_update
│  ├─ session_info_update
│  └─ usage_update
├─ Diff 处理: collectToolDiffArtifacts() 行235-244
└─ 最终输出: getTurns() 行107-127
```

### 阶段 3b: 流式 UI 渲染（在线）
```
src/acpChatParticipant.ts
├─ 类: AcpChatParticipant
├─ 关键方法: renderSessionUpdate() 行599-802
├─ 通知分发: switch(update.sessionUpdate) 行605-800
├─ 已处理: agent_message_chunk(606), agent_thought_chunk(615), 
│          tool_call(625), tool_call_update(668), plan(771)
├─ 缺口: 行775-779 - 5种无处理
│  ├─ available_commands_update
│  ├─ current_mode_update
│  ├─ config_option_update
│  ├─ session_info_update
│  └─ usage_update
└─ 辅助渲染方法:
   ├─ renderPlanUpdate() 行858-908
   ├─ renderToolDiffArtifacts() 行1140-1153
   └─ logToolCallLifecycle() 行1061-1081
```

### 阶段 2.5: 工具输出格式化
```
src/chatRenderingUtils.ts
├─ 关键函数: getToolInfo() 行68-180
├─ 字段提取: 行104-139
│  ├─ 缺口: formatted_output > aggregated_output > output
│  └─ 影响: 多字段时只取第一个
├─ 输出清理: sanitizeToolOutput() 行182-189
│  ├─ 缺口: 行183-184 - CLIXML 硬截断
│  └─ 影响: Windows PowerShell 长输出被截
├─ 其他辅助: parseQuestions() 行327-397
└─ Diff 处理: buildDiffMarkdown(), toInlineDiff() 等
```

### 阶段 4: 会话管理与历史恢复
```
src/acpSessionManager.ts
├─ 类: SessionManager
├─ 关键方法: createOrGet() 行314-496
├─ 历史恢复: 行400-426
│  ├─ loadSession() 调用 & 通知获取
│  ├─ TurnBuilder 序列化
│  └─ 缺口: 双重过滤可能丢失通知
├─ 会话同步: syncSessionState() 行534-553
└─ Diff 管理: recordToolDiffArtifacts(), getCumulativeToolDiffArtifacts() 等
```

### 阶段 0: 扩展激活
```
src/extension.ts
├─ 函数: activate() 行54-354
├─ OutputChannel 创建: 行55-57
│  └─ const outputChannel = vscode.window.createOutputChannel("ACP Client", {log: true})
├─ SessionDb 创建: 行70
└─ ACP 注册: registerAgents() 行74-79
```

---

## 文件依赖关系

```
extension.ts (激活点)
    ↓
acpClient.ts (Agent 连接)
    ├─→ tracer.ts (日志脱敏)
    └─→ acpSessionManager.ts (会话管理)
        └─→ turnBuilder.ts (历史序列化)
            └─→ chatRenderingUtils.ts (字段提取)
                └─→ diffRendering.ts (diff 处理)

    ↓ (并行)

acpChatParticipant.ts (UI 渲染)
    ├─→ chatRenderingUtils.ts (字段提取)
    ├─→ diffRendering.ts (diff 展示)
    └─→ vscode 官方 API (输出 UI 部分)
```

---

## 快速查找表

| 需求 | 文件 | 行号范围 |
|------|------|---------|
| 修改日志级别过滤 | tracer.ts | 11 |
| 添加 5 种缺失类型处理 | turnBuilder.ts | 98-103 |
| 添加 5 种缺失类型渲染 | acpChatParticipant.ts | 775-779 |
| 修改工具输出字段提取 | chatRenderingUtils.ts | 104-139 |
| 修改 CLIXML 处理 | chatRenderingUtils.ts | 183-184 |
| 检查历史恢复逻辑 | acpSessionManager.ts | 400-426 |
| 检查通知接收 | acpClient.ts | 250-282 |
| 检查 Diff 累积 | acpChatParticipant.ts | 1140-1153 |
| 查看完整渲染分发 | acpChatParticipant.ts | 599-802 |

---

## 测试文件位置

```
src/tracer.test.ts (如果存在)
src/turnBuilder.test.ts
src/chatRenderingUtils.test.ts
src/acpChatParticipant.test.ts (如果存在)
src/acpClient.test.ts
```

通常测试文件与源文件同名，但以 `.test.ts` 结尾。
