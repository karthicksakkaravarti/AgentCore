# Claude Code Agent Architecture and Feature Inventory

This document is the clone-planning reference for the full source tree at
`/Users/karthicksakkaravarthi/Projects/ClaudeCode/src`.

It is intentionally a reading and planning artifact. It does not start or
approve any clone implementation. The existing smaller skeleton at
`agent-core/src` is the current miniature core; this document is the gap list
between that skeleton and the full Claude Code agent.

Verification snapshot:

- `src` file count: 1924 files.
- First-level `src/tools` folder count: 44 folders.
- `queryLoop` exists in `src/query.ts`.
- Session storage path is `src/utils/sessionStorage.ts`.

## High-Level Architecture

```text
User keys / terminal
  -> CLI entrypoint
     src/entrypoints/cli.tsx, src/main.tsx, src/bootstrap/state.ts
     Parses flags, configures runtime, mounts the REPL or print mode.

  -> REPL and UI
     src/screens/REPL.tsx, src/ink, src/components, src/state
     React + Ink UI, AppState store, keybindings, paste, voice, dialogs.

  -> Query engine
     src/QueryEngine.ts, src/query.ts
     Async generator lifecycle, context assembly, memory, compaction,
     API calls, tool dispatch, transcript writes.

  -> Model API layer
     src/services/api/claude.ts, src/query/deps.ts
     Anthropic SDK wrapper, streaming and non-streaming calls, retries,
     prompt caching, fallback model handling.

  -> Tool executor
     src/services/tools/toolOrchestration.ts
     src/services/tools/toolExecution.ts
     src/services/tools/StreamingToolExecutor.ts
     Permission gate, hooks, read-only concurrency, tool result messages.

  -> Tool and extension surfaces
     src/tools, src/services/mcp, src/skills, src/tools/AgentTool,
     src/Task.ts, src/tasks.ts
```

Core pattern: every major layer is generator-oriented. User input enters the
REPL or print path, `QueryEngine.submitMessage()` yields SDK/internal messages,
`query()` yields model and tool events, `runTools()` yields tool updates, and
React/Ink renders incrementally. Cancellation flows through shared
`AbortController` instances.

Side systems include remote/CCR WebSockets, bridge/mobile relay, upstream
proxying, plugins, hooks, output styles, task storage, cost tracking, and JSONL
transcripts.

## Feature Inventory

### A. Agent Loop and Model Layer

1. Streaming agent loop: generator-based main loop yielding stream events,
messages, tombstones, summaries, and terminal status.
   Key files: `src/query.ts`, `src/QueryEngine.ts`.

2. API client wrapper: Anthropic SDK calls, streaming and non-streaming paths,
retry, prompt caching, beta headers, structured outputs, cost accounting.
   Key files: `src/services/api/claude.ts`, `src/services/api/client.ts`,
   `src/services/api/withRetry.ts`.

3. Model fallback: handles `FallbackTriggeredError`, discards pending streamed
tool calls, retries with fallback model.
   Key files: `src/query.ts`, `src/services/tools/StreamingToolExecutor.ts`.

4. Concurrency-safe tool batching: read-only/concurrency-safe tools run in
parallel; mutating tools run serially.
   Key files: `src/services/tools/toolOrchestration.ts`.

5. Tool execution pipeline: parses input, runs permission logic, hooks,
handler, post hooks, and maps result into `tool_result`.
   Key files: `src/services/tools/toolExecution.ts`, `src/Tool.ts`.

6. Cost and token tracking: tracks input/output/cache tokens, per-model usage,
duration, and total USD.
   Key files: `src/cost-tracker.ts`, `src/costHook.ts`,
   `src/bootstrap/state.ts`.

7. Effort and fast modes: effort controls and fast-mode availability change
model behavior and request parameters.
   Key files: `src/entrypoints/cli.tsx`, `src/utils/effort.ts`,
   `src/utils/fastMode.ts`.

8. Multi-model swap: model commands and state updates allow mid-session model
changes.
   Key files: `src/commands.ts`, `src/bootstrap/state.ts`,
   `src/utils/model/model.ts`.

### B. Context and System Prompt

9. Modular system prompt: prompt sections are composed from many static and
dynamic fragments.
   Key files: `src/constants/prompts.ts`, `src/constants/systemPromptSections.ts`,
   `src/utils/queryContext.ts`, `src/utils/systemPromptType.ts`.

10. Environment context injection: cwd, date, OS, git status, session state,
permissions, and model context.
    Key files: `src/context.ts`.

11. `CLAUDE.md` discovery: walks project and parent directories, loads memory
files, filters injected memory files.
    Key files: `src/utils/claudemd.ts`, `src/context.ts`.

12. Attachment messages: memory and discovered files are converted into
attachment messages.
    Key files: `src/utils/attachments.ts`.

13. Thinking blocks: extended/adaptive thinking handling and preservation
rules.
    Key files: `src/utils/thinking.ts`, `src/query.ts`,
    `src/services/api/claude.ts`.

14. Memory prefetch during streaming: relevant memory lookup starts while the
model is producing a turn.
    Key files: `src/query.ts`, `src/utils/attachments.ts`.

### C. Memory System

15. Auto-memory directory: project-scoped memory stored under the Claude
config project area.
    Key files: `src/memdir/memdir.ts`, `src/memdir/paths.ts`.

16. `MEMORY.md` index: truncated entrypoint/index for memory references.
    Key files: `src/memdir/memdir.ts`.

17. Memory types: user, feedback, project, reference, and frontmatter-backed
memory metadata.
    Key files: `src/memdir/memoryTypes.ts`.

18. Relevance search: scans memory files to find relevant context.
    Key files: `src/memdir/findRelevantMemories.ts`.

19. Session memory extraction: background/forked extraction of facts into
session memory.
    Key files: `src/services/SessionMemory/sessionMemory.ts`,
    `src/services/SessionMemory/sessionMemoryUtils.ts`.

20. Team memory: agent/team-specific memory paths and synchronization.
    Key files: `src/services/teamMemorySync`, `src/memdir`.

### D. Auto-Compact and Context Compression

21. Token-window monitor: detects approaching context limits and triggers
compaction.
    Key files: `src/services/compact/autoCompact.ts`.

22. Compaction subagent: summarizes history and builds post-compact messages.
    Key files: `src/services/compact/compact.ts`.

23. Per-message token estimation: local token heuristics and micro-compaction.
    Key files: `src/services/compact/microCompact.ts`,
    `src/services/tokenEstimation.ts`.

24. Cross-compaction continuity: budgets, compact boundaries, and preserved
history segments survive compaction.
    Key files: `src/query.ts`, `src/services/compact`.

25. Manual compact command: user-triggered compaction path.
    Key files: `src/commands.ts`, `src/services/compact`.

### E. Sessions and History

26. JSONL transcript per session: persists messages and metadata.
    Key files: `src/utils/sessionStorage.ts`, `src/history.ts`.

27. Session resume: continue/resume flows and interactive resume picker.
    Key files: `src/screens/ResumeConversation.tsx`,
    `src/utils/conversationRecovery.ts`, `src/utils/sessionRestore.ts`,
    `src/utils/sessionStorage.ts`.

28. Session lock files: advisory locking around session storage.
    Key files: `src/utils/sessionStorage.ts`.

29. Cost restoration: restores token/cost state from session metadata.
    Key files: `src/bootstrap/state.ts`, `src/cost-tracker.ts`,
    `src/utils/sessionStorage.ts`.

30. Cached session titles: title/name cache for session listings.
    Key files: `src/utils/sessionStorage.ts`.

31. Paste store: pasted content stored and referenced from messages.
    Key files: `src/history.ts`, `src/utils/sessionStorage.ts`,
    `src/screens/REPL.tsx`.

### F. Built-In Tools

Tool families:

- File: `FileReadTool`, `FileEditTool`, `FileWriteTool`, `NotebookEditTool`,
  `TodoWriteTool`.
- Execution: `BashTool`, `PowerShellTool`, `REPLTool`, `WorkflowTool`.
- Search/Web: `GlobTool`, `GrepTool`, `WebSearchTool`, `WebFetchTool`,
  `ToolSearchTool`.
- Agent/Skill: `AgentTool`, `SkillTool`.
- Tasks: `TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, `TaskListTool`,
  `TaskStopTool`, `TaskOutputTool`.
- Planning: `EnterPlanModeTool`, `ExitPlanModeTool`.
- Worktrees: `EnterWorktreeTool`, `ExitWorktreeTool`.
- Interaction: `AskUserQuestionTool`, `SendMessageTool`,
  `PushNotificationTool`.
- MCP/resources: `MCPTool`, `ListMcpResourcesTool`, `ReadMcpResourceTool`,
  `McpAuthTool`.
- Misc/feature-gated: `BriefTool`, `MonitorTool`, `RemoteTriggerTool`,
  `ScheduleCronTool`, `LSPTool`, `ConfigTool`, `TungstenTool`, `SleepTool`,
  `TeamCreateTool`, `TeamDeleteTool`, `SyntheticOutputTool`.

32. Tool registration via `Tool` interface: schema, prompt, permission,
rendering, read-only/concurrency/destructive metadata.
    Key files: `src/Tool.ts`, `src/tools.ts`.

33. Deferred tool loading: large tool lists can be searched/discovered before
schemas are fully loaded.
    Key files: `src/tools/ToolSearchTool`, `src/utils/toolSearch.ts`,
    `src/services/api/claude.ts`.

34. Tool result truncation/storage: large results are previewed and persisted.
    Key files: `src/utils/toolResultStorage.ts`,
    `src/services/tools/toolExecution.ts`.

35. File state cache: read-file state used for diffing, stale edit detection,
and permission checks.
    Key files: `src/utils/fileStateCache.ts`,
    `src/tools/FileReadTool`, `src/tools/FileEditTool`.

### G. MCP

36. MCP client: connects to external servers and registers MCP tools.
    Key files: `src/services/mcp/client.ts`.

37. Multiple transports: stdio, SSE, HTTP, WebSocket, IDE transports, SDK
control/in-process.
    Key files: `src/services/mcp/types.ts`, `src/services/mcp/InProcessTransport.ts`,
    `src/services/mcp/SdkControlTransport.ts`.

38. MCP scopes/config: local, user, project, managed, dynamic, enterprise,
Claude.ai and IDE sources.
    Key files: `src/services/mcp/config.ts`, `src/services/mcp/types.ts`.

39. OAuth and cross-app access: auth, token refresh, step-up auth, XAA/IdP.
    Key files: `src/services/mcp/auth.ts`, `src/services/mcp/xaa.ts`,
    `src/services/mcp/xaaIdpLogin.ts`, `src/services/oauth`.

40. MCP tool prefixing: normalized `mcp__server__tool` names and prefix
options.
    Key files: `src/tools/MCPTool/MCPTool.ts`,
    `src/services/mcp/normalization.ts`, `src/services/mcp/mcpStringUtils.ts`.

41. MCP resources: list/read resources through tools.
    Key files: `src/tools/ListMcpResourcesTool`,
    `src/tools/ReadMcpResourceTool`.

42. MCP elicitation: server-initiated questions routed back to the user.
    Key files: `src/services/mcp/client.ts`,
    `src/services/mcp/elicitationHandler.ts`.

43. MCP prompts as skills: MCP prompt surfaces can be exposed to the skill
system when enabled.
    Key files: `src/skills/mcpSkillBuilders.ts`, `src/tools/SkillTool`.

### H. Skills and Slash Commands

44. Skill format: Markdown/frontmatter definitions with name, description,
allowed tools, context, agent, effort.
    Key files: `src/skills/loadSkillsDir.ts`.

45. Skill sources: project, user, bundled, plugin, and MCP prompt sources.
    Key files: `src/skills/bundledSkills.ts`, `src/skills/bundled`,
    `src/commands.ts`.

46. `SkillTool`: model-invocable skill expansion and execution.
    Key files: `src/tools/SkillTool`.

47. Slash command types: prompt, local text command, local JSX command.
    Key files: `src/types/command.ts`, `src/commands.ts`.

48. Built-in commands: help, clear, config, theme, cost, session, review,
security review, plan, memory, MCP, plugins, agents, skills, tasks, and more.
    Key files: `src/commands.ts`, `src/commands`.

49. Remote-safe/bridge-safe command lists: allowlists for restricted modes.
    Key files: `src/commands.ts`.

50. Availability gating: commands gated by settings, auth tier, mode, and
feature flags.
    Key files: `src/commands.ts`, `src/utils/auth.ts`.

### I. Hooks

51. Hook events: pre/post tool, failures, user prompt submit, session events,
permission events, setup, subagent events, cwd change, notification,
elicitation.
    Key files: `src/schemas/hooks.ts`, `src/utils/hooks.ts`.

52. Hook types: command, prompt/LLM, and subprocess/script paths.
    Key files: `src/utils/hooks.ts`, `src/utils/hooks`.

53. Hook matchers: tool-name and pattern matchers.
    Key files: `src/utils/hooks.ts`, `src/Tool.ts`.

54. Hook responses: continue/block/approve, updated input, stop reason,
additional context.
    Key files: `src/utils/hooks.ts`, `src/types/hooks.ts`.

55. Hook configuration scopes: project, user, enterprise, and settings layers.
    Key files: `src/utils/settings`, `src/utils/hooks.ts`.

56. Plugin-registered hooks: plugin manifests can add hooks.
    Key files: `src/plugins/builtinPlugins.ts`, `src/types/plugin.ts`.

### J. Permissions

57. Permission modes: default, auto/classifier modes, bypass, plan, and edit
acceptance variants.
    Key files: `src/utils/permissions/permissions.ts`,
    `src/types/permissions.ts`.

58. Allow/deny/ask rule lists: tool and pattern rules such as `Bash(git *)`
or path-matched edit rules.
    Key files: `src/utils/permissions/PermissionRule.ts`.

59. Rule sources: session, local/user/project settings, policy, CLI, hooks,
remote and managed sources.
    Key files: `src/utils/permissions`.

60. Auto-classifier: risk classifier and fallback behavior.
    Key files: `src/utils/permissions/classifierDecision.ts`,
    `src/utils/permissions/autoModeState.ts`.

61. Denial tracking: repeated denials force/prompt fallback behavior.
    Key files: `src/utils/permissions/denialTracking.ts`.

62. Per-tool `checkPermissions`: tool-specific permission checks.
    Key files: individual `src/tools/*/*Tool.ts` files.

63. Path matching: `getPath()` and `preparePermissionMatcher()` support
path/pattern permission checks.
    Key files: `src/Tool.ts`, `src/utils/permissions`.

### K. Plugins

64. Plugin sources: built-in plugin definitions, marketplace metadata,
installed plugins.
    Key files: `src/services/plugins`, `src/types/plugin.ts`.

65. Extension surface: skills, hooks, MCP servers, and output styles.
    Key files: `src/services/plugins`, `src/plugins`, `src/types/plugin.ts`.

66. Plugin enable/disable and operations.
    Key files: `src/services/plugins/pluginOperations.ts`,
    `src/services/plugins/PluginInstallationManager.ts`,
    `src/services/plugins/pluginCliCommands.ts`.

### L. Output Styles

67. Output styles: Markdown prompt files define alternate response styles.
    Key files: `src/outputStyles/loadOutputStylesDir.ts`,
    `src/constants/outputStyles.ts`.

68. Output-style command support.
    Key files: `src/commands.ts`, `src/constants/outputStyles.ts`.

69. Plugin-locked styles and plugin style loading.
    Key files: `src/outputStyles`, `src/services/plugins`.

### M. Subagents and Tasks

70. `AgentTool`: spawns specialized or general-purpose subagents.
    Key files: `src/tools/AgentTool`.

71. Forked agent runtime: isolated messages, tools, permissions, app state,
and cache-safe context.
    Key files: `src/utils/forkedAgent.ts`,
    `src/tools/AgentTool/runAgent.ts`.

72. Task system: background long-running tasks with streaming output/status.
    Key files: `src/Task.ts`, `src/tasks.ts`.

73. Task types: local bash, local agent, remote agent, teammate, workflow,
monitor, dream.
    Key files: `src/Task.ts`.

74. Task storage/logging: task logs and output streaming.
    Key files: `src/Task.ts`, `src/tasks.ts`.

75. Worktrees: isolated git worktree entry/exit tools.
    Key files: `src/tools/EnterWorktreeTool`, `src/tools/ExitWorktreeTool`,
    `src/utils/worktree.ts`.

### N. UI and REPL

76. Custom Ink fork: React terminal renderer, Yoga layout, frame/render
pipeline, ANSI output.
    Key files: `src/ink`, `src/ink.ts`.

77. REPL screen: main interactive component and input lifecycle.
    Key files: `src/screens/REPL.tsx`.

78. Components: message rendering, status line, dialogs, stats, settings,
selectors, banners.
    Key files: `src/components`.

79. Modals/dialogs: promise-based interaction helpers and launchers.
    Key files: `src/interactiveHelpers.tsx`, `src/dialogLaunchers.tsx`.

80. AppState store: shared immutable app state for REPL/tool/task/UI state.
    Key files: `src/state/AppStateStore.ts`, `src/state/AppState.tsx`,
    `src/state/AppState.ts`.

81. Status line: model/cost/task/session/status display.
    Key files: `src/components/StatusLine.tsx`.

82. Stats panel: tokens, costs, durations, tool calls.
    Key files: `src/components/Stats.tsx`.

83. Compact summary banner: visual summary after compaction.
    Key files: `src/components/CompactSummary.tsx`.

### O. Ergonomics

84. Vim mode: normal/operator/motion/text-object state machine.
    Key files: `src/vim`.

85. Custom keybindings: user keybinding config and chord handling.
    Key files: `src/keybindings`.

86. Voice mode: speech-to-text capture and streaming transcription.
    Key files: `src/voice`, `src/services/voice.ts`,
    `src/services/voiceStreamSTT.ts`.

87. Paste detection: bracketed paste handling and paste store.
    Key files: `src/history.ts`, `src/screens/REPL.tsx`,
    `src/utils/sessionStorage.ts`.

88. Desktop handoff: deep link/handoff to desktop app.
    Key files: `src/components/DesktopHandoff.tsx`, `src/deepLink`.

89. Project onboarding: tracks project initialization/CLAUDE.md prompts.
    Key files: `src/projectOnboardingState.ts`, `src/skills/bundled`.

90. Trust dialog: workspace trust flow on unknown projects.
    Key files: `src/entrypoints/init.ts`, `src/screens/REPL.tsx`.

### P. CLI Flags and Entry Modes

91. Interactive mode: full REPL.
    Key files: `src/entrypoints/cli.tsx`, `src/main.tsx`.

92. Print/headless mode: one-shot text/JSON/streaming output.
    Key files: `src/cli/print.ts`, `src/QueryEngine.ts`.

93. Plan mode and init/setup flows.
    Key files: `src/entrypoints/cli.tsx`, `src/tools/EnterPlanModeTool`,
    `src/tools/ExitPlanModeTool`.

94. Offline/local modes and network gating.
    Key files: `src/entrypoints/cli.tsx`, `src/utils/envUtils.ts`.

95. Continue/resume flags.
    Key files: `src/main.tsx`, `src/screens/ResumeConversation.tsx`,
    `src/utils/sessionRestore.ts`.

96. Model, effort, and fast flags.
    Key files: `src/entrypoints/cli.tsx`, `src/utils/model/model.ts`,
    `src/utils/effort.ts`, `src/utils/fastMode.ts`.

97. Tool/permission shortcut flags.
    Key files: `src/entrypoints/cli.tsx`, `src/utils/permissions`.

### Q. Remote, Bridge, and Proxy

98. CCR remote sessions: WebSocket session management.
    Key files: `src/remote/RemoteSessionManager.ts`,
    `src/remote/SessionsWebSocket.ts`.

99. Remote permission bridge: permission arbitration with desktop/remote host.
    Key files: `src/remote/remotePermissionBridge.ts`, `src/bridge`.

100. Bridge layer: relays prompts, tool permissions, and streamed results for
mobile/web/desktop bridges.
     Key files: `src/bridge/bridgeMain.ts`, `src/bridge/replBridge.ts`,
     `src/bridge/bridgeMessaging.ts`, `src/bridge/sessionRunner.ts`.

101. Upstream proxy: corporate proxy and certificate handling.
     Key files: `src/upstreamproxy/upstreamproxy.ts`, `src/upstreamproxy/relay.ts`.

102. SDK message adapter: maps remote/CCR SDK messages into local/internal
message shapes.
     Key files: `src/remote/sdkMessageAdapter.ts`.

103. Server folder: local HTTP/RPC surfaces and server-side helpers.
     Key files: `src/server`.

### R. Cross-Cutting Infrastructure

104. Settings layers: enterprise/user/project/local/CLI precedence.
     Key files: `src/utils/settings`, `src/services/settingsSync`.

105. Migrations: settings/config migrations.
     Key files: `src/migrations`.

106. Telemetry and GrowthBook: feature gates, diagnostics, analytics sinks.
     Key files: `src/services/analytics`, `src/bootstrap`, `src/utils/telemetry`.

107. Post-sampling hooks: non-blocking callbacks after API responses.
     Key files: `src/utils/hooks/postSamplingHooks.ts`, `src/query.ts`.

108. Profiler checkpoints: boot/query profiling instrumentation.
     Key files: `src/utils/headlessProfiler.ts`, `src/utils/queryProfiler.ts`,
     `src/main.tsx`.

109. Schedule/cron tools: recurring agents and scheduled task controls.
     Key files: `src/tools/ScheduleCronTool`.

110. Push notifications: system/user notifications from tools or tasks.
     Key files: `src/tools/PushNotificationTool`,
     `src/services/notifier.ts`.

## End-To-End Flows

### 1. Interactive Turn

`src/screens/REPL.tsx` receives input, calls `QueryEngine.submitMessage()`,
which builds context and delegates to `query()`. `query()` calls
`queryModelWithStreaming()` from `src/services/api/claude.ts`, yields streamed
content, records transcript data through `src/utils/sessionStorage.ts`, and
updates cost state.

### 2. Tool Call

The model emits a `tool_use` block. `src/query.ts` sends it through
`runTools()` in `src/services/tools/toolOrchestration.ts`. That partitions
read-only/concurrent calls from mutating calls. `runToolUse()` in
`src/services/tools/toolExecution.ts` handles permissions, hooks, execution,
and maps the result into a user `tool_result` message for the next model turn.

### 3. Session Resume

CLI resume/continue flags flow through `src/main.tsx` and resume UI helpers.
`src/utils/sessionStorage.ts` reads JSONL transcripts and session metadata;
`src/bootstrap/state.ts` restores cost state; the REPL mounts with prior
history.

### 4. Auto-Compact

Post-sampling logic checks token pressure. `src/services/compact/compact.ts`
builds compacted history, preserving compact boundaries and needed metadata.
`src/query.ts` continues with replaced messages and preserved budget state.

### 5. MCP Tool Invocation

MCP config loads from settings. `src/services/mcp/client.ts` connects to
servers and registers tools. The tool pool includes `mcp__server__tool` names.
At runtime `src/tools/MCPTool/MCPTool.ts` proxies the call, including auth or
elicitation flows when needed.

### 6. Skill or Slash Command

`src/commands.ts` resolves slash commands. Prompt/skill commands load
frontmatter and either inline context or run through `SkillTool`/forked agent
paths with restricted tools.

### 7. Hook Firing

Before and after tool execution, hook matchers in `src/utils/hooks.ts` run.
Responses can approve, block, add context, update inputs, or stop execution.

### 8. Subagent

The model calls `AgentTool`. `src/tools/AgentTool/runAgent.ts` or fork helpers
spawn an isolated agent with selected type/tools/context. The parent receives
the subagent result as the tool result.

### 9. Remote / Bridge

Remote sessions use WebSockets in `src/remote`. Bridge code in `src/bridge`
relays user prompts, permission control requests, and streamed results.

### 10. Background Task

Task tools create and manage entries in app state and disk logs. Output is read
through task output/status tools and cancellation runs through task stop logic.

## Critical Files To Read First

Entry and loop:

- `src/entrypoints/cli.tsx`
- `src/main.tsx`
- `src/bootstrap/state.ts`
- `src/setup.ts`
- `src/QueryEngine.ts`
- `src/query.ts`
- `src/services/api/claude.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/StreamingToolExecutor.ts`

Tool surface:

- `src/Tool.ts`
- `src/tools.ts`
- `src/types/message.ts`
- `src/types/tools.ts`
- `src/tools/BashTool`
- `src/tools/FileEditTool`
- `src/tools/AgentTool`
- `src/tools/SkillTool`
- `src/tools/MCPTool`

Context, memory, compaction:

- `src/context.ts`
- `src/utils/queryContext.ts`
- `src/utils/claudemd.ts`
- `src/utils/attachments.ts`
- `src/memdir/memdir.ts`
- `src/memdir/memoryTypes.ts`
- `src/services/SessionMemory/sessionMemory.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/autoCompact.ts`
- `src/services/compact/microCompact.ts`

Persistence:

- `src/history.ts`
- `src/utils/sessionStorage.ts`
- `src/cost-tracker.ts`
- `src/costHook.ts`

MCP, hooks, permissions, plugins, skills, commands:

- `src/services/mcp/client.ts`
- `src/services/mcp/config.ts`
- `src/services/mcp/types.ts`
- `src/services/mcp/auth.ts`
- `src/services/mcp/xaa.ts`
- `src/utils/hooks.ts`
- `src/schemas/hooks.ts`
- `src/utils/permissions`
- `src/utils/permissions/PermissionRule.ts`
- `src/utils/permissions/classifierDecision.ts`
- `src/utils/permissions/denialTracking.ts`
- `src/services/plugins`
- `src/types/plugin.ts`
- `src/skills/loadSkillsDir.ts`
- `src/skills/bundledSkills.ts`
- `src/skills/mcpSkillBuilders.ts`
- `src/commands.ts`
- `src/types/command.ts`

UI:

- `src/screens/REPL.tsx`
- `src/state/AppStateStore.ts`
- `src/state/AppState.tsx`
- `src/ink`
- `src/components/StatusLine.tsx`
- `src/components/Stats.tsx`
- `src/components/CompactSummary.tsx`

Remote and bridge:

- `src/remote/RemoteSessionManager.ts`
- `src/remote/SessionsWebSocket.ts`
- `src/remote/sdkMessageAdapter.ts`
- `src/bridge/bridgeMain.ts`
- `src/bridge/replBridge.ts`
- `src/bridge/bridgeMessaging.ts`
- `src/bridge/sessionRunner.ts`
- `src/upstreamproxy/upstreamproxy.ts`

Ergonomics:

- `src/vim`
- `src/keybindings`
- `src/voice`

## Suggested Clone Phasing

Phase 1: Skeleton core. Existing `agent-core/src` covers the miniature loop,
tool schema surface, permissions, system prompt, and CLI.

Phase 2: Persistence and context. Add JSONL transcripts, continue/resume,
`CLAUDE.md` discovery, attachments, and modular prompt assembly.

Phase 3: Memory and compaction. Add memory directory layout, `MEMORY.md`,
session memory extraction, auto-compact, and cost tracking.

Phase 4: Slash commands, hooks, and skills. Add command registry, core hook
events, and frontmatter skills.

Phase 5: MCP and plugins. Add stdio and HTTP MCP transports first; defer OAuth
and enterprise auth.

Phase 6: Subagents, tasks, and worktrees. Add forked agent runtime, task store,
task tools, and isolated worktrees.

Phase 7: UI upgrade. Replace plain CLI with Ink REPL, AppState store, status
line, message rendering, and dialogs.

Phase 8: Ergonomics. Add vim mode, keybindings, paste handling, voice, and
project onboarding.

Phase 9: Remote and bridge. Add CCR WebSocket, bridge relay, and remote
permission round-trip.

## Verification Plan

1. Spot-check key paths before each phase starts.
2. Trace one end-to-end flow in source before cloning it.
3. Count tools and commands when scope depends on totals.
4. Keep this artifact documentation-only; implementation starts only after a
phase is selected.

## Open Scope Questions

- Which phase is the MVP target?
- Should the clone stay plain CLI or adopt Ink REPL?
- Is MCP required in the MVP?
- Is remote/bridge support required?
- Should cloud/CCR/proxy features be stripped for a local-only clone?
- Which provider and credentials model should the clone use?
