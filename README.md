# 🪄 Silver Engineer

> A senior-engineer AI assistant embedded in VS Code — with persistent local memory, embedded MCP server, Skills system, and Human-in-the-Loop workflow execution.

---

## Features

| Capability | Description |
|---|---|
| **@silver Chat Participant** | Ask `@silver` anything in VS Code Chat. Powered by GitHub Copilot — no BYOK required. |
| **Local Knowledge Graph** | Remembers your tech stack, collaborators, and past decisions (persisted locally). |
| **GraphRAG** | Semantic search + graph traversal injected into every LM prompt. |
| **Embedded MCP Server** | Local Streamable HTTP MCP server auto-started — connects Copilot to Jira, GitHub, and custom tools. |
| **Agent Skills** | Extensible SKILL.md files for guided workflows (unit test, code review, and more). |
| **Human-in-the-Loop (HITL)** | Every state-changing action (commit, Jira update, file generation) requires explicit confirmation. |
| **Daily Summary** | Once-per-day digest of open tickets and priorities — shown as a non-modal toast. |
| **Secure Credentials** | All API tokens stored in OS keychain via VS Code `SecretStorage`. Never in `settings.json`. |

---

## Prerequisites

| Requirement | Version |
|---|---|
| Visual Studio Code | ≥ 1.95.0 |
| GitHub Copilot (Chat) | Active subscription |

No additional runtime (Node.js, Python, etc.) required on the end-user's machine.

---

## Installation (private VSIX)

1. Download the latest `silver-engineer-*.vsix` from the releases page or CI artefacts.
2. In VS Code, open the **Extensions** view (`Ctrl+Shift+X`).
3. Click the `⋯` menu → **Install from VSIX…** → select the file.
4. Reload VS Code when prompted.
5. Run **Silver Engineer: Configure API Credentials** to set up Jira / GitHub tokens.

---

## Quick Start

```
# Talk to Silver Engineer in Chat
@silver What should I focus on today?
@silver /summary
@silver /skills
@silver /graph
@silver /workflow "create a new React component called UserCard"
```

---

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for **Silver Engineer**:

| Setting | Default | Description |
|---|---|---|
| `silverEngineer.jiraBaseUrl` | `""` | Your Jira instance URL |
| `silverEngineer.jiraProjectKey` | `""` | Project key for daily digest |
| `silverEngineer.githubOrg` | `""` | GitHub org for PR/issue summaries |
| `silverEngineer.enableDailySummary` | `true` | Show daily work summary |
| `silverEngineer.maxAgentLoopIterations` | `10` | Max HITL loop iterations |
| `silverEngineer.mcpPort` | `0` | MCP server port (0 = auto) |
| `silverEngineer.enableTelemetry` | `false` | Opt-in anonymous telemetry |

### API Credentials

Run `Silver Engineer: Configure API Credentials` (Command Palette → `Ctrl+Shift+P`).

Credentials are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). They are **never** written to `settings.json` or any file on disk.

---

## Adding Custom Skills

1. Create `.vscode/silver-skills/` in your project root.
2. Add any `.md` file following this format:

```markdown
description: <one-line description Silver uses for skill matching>

## Skill: my-skill-name

### Purpose
...

### Trigger
Use this skill when ...

### Behaviour
...
```

3. The extension will automatically detect and load the new skill. No restart needed.

---

## Architecture

```
silver-engineer/
├── src/
│   ├── extension.ts          # Activation (onStartupFinished), lifecycle
│   ├── chatParticipant.ts    # @silver Chat Participant + LM streaming
│   ├── mcpServer.ts          # Embedded Streamable HTTP MCP server
│   ├── toolRegistry.ts       # HITL tool registration + agentic loop
│   ├── graphStore.ts         # Knowledge Graph (graphology)
│   ├── vectorStore.ts        # Vector store (vectra, offline TF-IDF fallback)
│   ├── secretManager.ts      # SecretStorage wrapper
│   ├── notificationManager.ts# Daily digest (once-per-day guard)
│   ├── fileWatcher.ts        # .vscode/silver-skills/ watcher
│   ├── skills/
│   │   ├── loader.ts         # SKILL.md parser (progressive disclosure)
│   │   └── templates/        # Built-in skills
│   └── webview/
│       ├── panel.ts          # Webview host + message bridge
│       ├── entry.ts          # Webview JS entry (bundled as webview.js)
│       └── index.html        # Webview HTML template
├── scripts/
│   └── obfuscate.js          # Light IP-protection of AI-core bundle
└── .github/workflows/
    └── ci.yml                # Build → Obfuscate → Package → Upload .vsix
```

### Key design decisions

| Decision | Choice | Reason |
|---|---|---|
| Activation | `onStartupFinished` | Non-blocking; zero impact on IDE startup time |
| LM access | GitHub Copilot via `vscode.lm` | No BYOK, no API keys in the extension |
| Vector store | `vectra` (pure JS) + TF-IDF fallback | Zero native bindings — works on any OS/arch |
| Graph | `graphology` (pure JS) | Lightweight in-memory graph, JSON-serialisable |
| MCP server | In-process Streamable HTTP | Zero user setup; shares Extension Host runtime |
| Credentials | `ExtensionContext.secrets` | OS keychain — never stored in settings or files |
| Obfuscation | Light (string array + identifier renaming) | Protects IP without Marketplace flags |

---

## Development

```bash
# Clone and install
git clone <repo>
cd silver-engineer
npm install

# Watch mode (rebuilds on save)
npm run watch

# Launch in Extension Development Host
# Press F5 in VS Code (uses .vscode/launch.json)

# Build production bundle
npm run build:prod

# Package .vsix
npm run package
```

---

## Privacy & Security

- **No code or prompt content is ever transmitted** to external servers by the extension itself.
- All LM interactions go through GitHub Copilot's own infrastructure (subject to Copilot's privacy policy).
- The local knowledge graph and vector store live exclusively at `~/.vscode/globalStorage/silver-engineer.silver-engineer/`.
- To delete all local memory: run **Silver Engineer: Clear Local Memory** from the Command Palette.
- The embedded MCP server listens on `127.0.0.1` only. It is never reachable from outside the machine.

---

## License

UNLICENSED — Private distribution only. Not for redistribution.
