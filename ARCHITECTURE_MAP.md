# VS Code ACP Provider: Architectural Map & Improvement Opportunities

> Generated: 2026-05-20  
> Scope: Analysis of `vscode-acp-provider` codebase  
> Focus: Module organization, coupling patterns, and refactoring leverage points

---

## 1. Current Architecture Summary

### Core Domains

**A. ACP Protocol & Session Lifecycle** (`acpClient.ts`, `acpSessionManager.ts`)
- **acpClient.ts** (712 LOC): ACP connection lifecycle, process spawning, ndjson framing, capability negotiation
- **acpSessionManager.ts** (907 LOC): In-memory session state, MCP server resolution (profile/workspace/plugin), chat turn queueing
- **acpSessionDb.ts**: Disk-backed session storage (SQLite)
- **acpSessionSyncer.ts**: Native ACP session discovery & import

**B. Chat UI & Rendering** (`acpChatParticipant.ts`, `chatRenderingUtils.ts`, `diffRendering.ts`)
- **acpChatParticipant.ts** (1490 LOC): Request handler, slash command completion, tool lifecycle rendering, diff UI
- **chatRenderingUtils.ts** (746 LOC): Tool info extraction, markdown formatting, diff stats, terminal/MCP tool handling
- **diffRendering.ts** (320 LOC): Diff artifact collection, merging, URI creation for side-by-side views
- **turnBuilder.ts**: Session turn reconstruction from ACP notifications

**C. Configuration & Integration**
- **agentRegistry.ts**: Agent config parsing, capabilities detection
- **commandMatching.ts**: Slash command filtering, scoring, namespaced command aliases
- **skillDiscovery.ts**: Skill directory scanning (SKILL.md), path expansion
- **pluginDiscovery.ts** (416 LOC): Plugin manifest discovery (4 manifest locations), format detection
- **pluginCompatibility.ts**: Plugin MCP/hook/skill parsing
- **mcpConfigImporter.ts**: VS Code profile + workspace MCP import

**D. File Write Coordination**
- **fileWriteCoordinator.ts**: Per-URI write queuing (prevents concurrent edits)
- **externalEditTracker.ts**: Registration & resolution of external edits
- **diffContentProvider.ts**: Virtual diff URIs (ccreq:// scheme)

**E. Support Services**
- **extension.ts**: Activation, registration hub
- **permissionPrompts.ts**: ACP permission request handler
- **tracer.ts**: Session event logging
- **chatIdentifiers.ts**: URI normalization for untitled sessions
- **types.ts**: Type definitions (AcpAgentConfigurationEntry, ThinkState, etc.)

### Module Count: 46 TS files, ~8000 LOC (estimated)

---

## 2. Friction Points & Coupling Issues

### High-Coupling Patterns

| Issue | Location | Details |
|-------|----------|---------|
| **Monolithic acpChatParticipant** | acpChatParticipant.ts (1490 LOC) | Handles request routing, tool lifecycle, diff rendering, external edits, permission prompts—all in one class |
| **Cross-Cutting Rendering** | chatRenderingUtils + diffRendering | Tight coupling: diff stats, tool info extraction, URI resolution scattered across utilities |
| **Plugin Discovery Complexity** | pluginDiscovery.ts (416 LOC) | 4 manifest formats (copilot/claude/openplugin), 3 search roots, workspace hints—densely coupled |
| **Session State Fragmentation** | acpSessionManager.ts (907 LOC) | Holds commands, diffs, think state, options; all updates flow through one class |
| **File Write Dependency Injection** | acpClient.ts | Uses `writeTextFileWithCoordinator()` directly; tight coupling to file I/O strategy |
| **Skill + Manual Command Merge** | acpSessionManager + commandMatching | Deduplication logic split; both handle skill/ACP command sources |

### Missing Abstractions

- No separate **"ACP Lifecycle Manager"** — initialization, process spawning, and shutdown mixed in acpClient
- No **"Diff Artifact Builder"** — diff collection, merging, and URI creation scattered
- No **"Plugin Manifest Resolver"** — format detection, location scanning, validation intertwined
- No **"Tool Invocation Renderer"** — tool lifecycle formatting duplicated between turnBuilder and acpChatParticipant

---

## 3. Top 5 Improvement Opportunities (Ranked by Leverage)

### **#1. Extract Tool Lifecycle Renderer (Medium Effort → High Leverage)**
**Impact**: Eliminates duplicate tool rendering logic (acpChatParticipant + turnBuilder); improves testability; enables reusable tool UI.

**Affected Files**: 
- `acpChatParticipant.ts` (1490→1200 LOC)
- `turnBuilder.ts` (515 LOC)
- `chatRenderingUtils.ts` (746 LOC)
- **Action**: Create `ToolLifecycleRenderer` class:
  - `renderToolStarted(toolInfo): ChatResponsePart[]`
  - `renderToolProgress(update): ChatResponsePart[]`
  - `renderToolCompleted(result): ChatResponsePart[]`
  - `renderDiffArtifact(artifact): ChatResponsePart[]`
- **Leverage**: 5–8 call sites, ~200 LOC extracted, single source of truth

---

### **#2. Decompose Plugin Discovery (Low Effort → Medium Leverage)**
**Impact**: Simplifies manifest resolution; enables independent plugin source testing; supports future format additions.

**Affected Files**: `pluginDiscovery.ts` (416 LOC)
- **Action**: Extract:
  - `PluginManifestLocator` — enumerate candidate paths (4 formats)
  - `PluginFormatDetector` — identify format from manifest structure
  - `PluginSearchStrategy` — abstract root/depth scanning (chat settings, copilot CLI, vscode installed)
- **Leverage**: Reduces cyclomatic complexity; enables format-specific handlers

---

### **#3. Extract Session State Container (Medium Effort → High Leverage)**
**Impact**: Centralizes session mutable state; decouples option updates from acpSessionManager; improves testability.

**Affected Files**: `acpSessionManager.ts` (907 LOC)
- **Action**: Create `SessionState` class:
  - `thinkState`, `availableCommands`, `cumulativeToolDiffs`, `cachedOptions`
  - Emitter for `.onDidChange()`
- Then separate:
  - `SessionStateManager` — mutation + notification
  - `SessionLifecycleManager` — creation/load/disposal
- **Leverage**: Reduces class to ~600 LOC; enables independent testing of state rules

---

### **#4. Create Diff Artifact Pipeline (Medium Effort → Medium Leverage)**
**Impact**: Centralizes diff collection, merging, and rendering; enables incremental diff updates; improves maintainability.

**Affected Files**: 
- `diffRendering.ts` (320 LOC)
- `turnBuilder.ts` (515 LOC)
- `acpChatParticipant.ts` (1490 LOC)
- **Action**: Create `ToolDiffPipeline`:
  - `collectDiffs(toolUpdate, workspaceRoot): ToolDiffArtifact[]`
  - `mergeIntoAccumulator(existing, incoming): Map<key, artifact>`
  - `renderDiffParts(artifact[]): ChatResponsePart[]`
- **Leverage**: Eliminates scattered merging logic; ~150 LOC extraction

---

### **#5. Separate File Write Strategy (Low Effort → Medium Leverage)**
**Impact**: Abstracts file I/O coordination; enables pluggable strategies (queue, batch, atomic); simplifies acpClient.

**Affected Files**: `acpClient.ts` (712 LOC), `fileWriteCoordinator.ts`
- **Action**: Extract `FileWriteStrategy` interface:
  ```typescript
  interface FileWriteStrategy {
    write(uri: Uri, content: string): Promise<void>;
  }
  ```
  Inject into acpClient instead of direct import
- **Leverage**: Reduces coupling; enables testing with mock writers

---

## Reference: Important Architecture Documents

- `docs/codebase-knowledge.md` — Session lifecycle, MCP resolution order, ACP client initialization
- `CONTEXT.md` — Domain glossary (ACP Command, Skill, Unified Slash Completion)
- `README.md` — Feature overview, MCP/plugin precedence, configuration shape

---

## Test Coverage Status

- Tests exist for: `acpClient.test.ts`, `chatRenderingUtils.test.ts`, `diffRendering.test.ts`, `turnBuilder.test.ts`, `commandMatching.test.ts`, `chatCommandSerialization.test.ts`, `externalEditTracker.test.ts`, `manualCommandImport.test.ts`, `acpLifecycledChatSessionItemController.test.ts`
- **Gap**: No tests for pluginDiscovery, skillDiscovery, acpSessionSyncer, acpSessionManager orchestration

