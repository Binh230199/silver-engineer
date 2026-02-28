# Silver Engineer — Handover Document
**Date:** 2026-02-28
**From:** Previous chat session
**Purpose:** Continue development in a new chat window

---

## How to use this document

Paste the following prompt into the new chat:

```
Read #file:.github/skills/silver-engineer-dev/SKILL.md then read #file:.github/prompts/continue-silver-engineer.prompt.md — I want to continue developing the Silver Engineer VS Code extension. [describe what you want to do]
```

---

## Project Location

```
d:\AI\silver-engineer\       ← workspace root (open THIS folder in VS Code)
```

---

## Current Status — Everything Working ✅

| Feature | Status |
|---|---|
| `@silver` chat participant | ✅ Working |
| `/summary`, `/skills`, `/graph`, `/workflow` | ✅ Working |
| `/review` (ai_git_push pre-push review) | ✅ Working |
| Daily summary notification | ✅ Working |
| Knowledge Graph (sidebar dashboard) | ✅ Working |
| MCP HTTP server | ✅ Working |
| Skills system (hot-reload) | ✅ Working |
| HITL tool confirmation | ✅ Working |
| VSIX packaged | ✅ `silver-engineer-0.1.0.vsix` (1.19 MB) |

---

## Repository Structure

```
silver-engineer/
├── .github/
│   ├── copilot-instructions.md        ← project-level AI rules
│   ├── agents/
│   │   ├── reviewer-bugfix.agent.md   ← bug fix reviewer
│   │   ├── reviewer-feature.agent.md  ← feature reviewer
│   │   ├── reviewer-static.agent.md   ← MISRA/AUTOSAR reviewer
│   │   ├── reviewer-light.agent.md    ← light reviewer (test/docs/format)
│   │   ├── bug-fixer.agent.md
│   │   └── tester.agent.md
│   ├── prompts/
│   │   ├── continue-silver-engineer.prompt.md  ← MAIN HANDOVER CONTEXT
│   │   ├── setup-guide.md                      ← machine setup guide
│   │   └── plan-silverEngineer.prompt.md       ← original design plan
│   ├── skills/
│   │   └── silver-engineer-dev/SKILL.md        ← full architecture reference
│   └── workflows/
│       └── ci.yml
├── src/                    ← TypeScript source (13 modules)
├── scripts/
│   ├── generate-icon.js
│   └── obfuscate.js
├── assets/
│   └── icon.png            ← generated, 128×128
├── .vscode/
│   ├── launch.json         ← F5 to run extension
│   ├── tasks.json          ← build + watch tasks
│   └── silver-skills/      ← user skill overrides (6 files)
│       ├── reviewer-bugfix.md
│       ├── reviewer-feature.md
│       ├── reviewer-static.md
│       ├── reviewer-light.md
│       └── daily-standup.md
├── dist/                   ← built output (gitignore this)
├── package.json
├── tsconfig.json
├── esbuild.config.js
└── .vscodeignore
```

---

## Key Technical Decisions (do NOT undo these)

| Decision | Reason |
|---|---|
| Participant ID = `silver-engineer.silver-engineer` | Must match `{publisher}.{name}` exactly |
| `encoder.json` + `vocab.bpe` copied to `dist/` | gpt-3-encoder uses `fs.readFileSync(__dirname/...)` at runtime |
| `mcpServerDefinitionProviders` in package.json | Required by VS Code or MCP provider registration fails |
| `SilverServices` in `src/types.ts` | Breaks circular import between `extension.ts` ↔ `toolRegistry.ts` |
| `ToolInvoker` callback in `mcpServer.ts` | Breaks circular import between MCP ↔ ToolRegistry |
| Skill templates copied to `dist/skills/templates/` | `src/` is excluded from VSIX |
| ESLint pinned to `^8.56.0` | `@typescript-eslint` v7 has peer conflict with eslint v9 |
| `.User('[SYSTEM] ...')` instead of `.System()` | `.System()` doesn't exist on stable VS Code API |

---

## Pending Work

### At the Company Machine
1. **Jira credentials**: `Ctrl+Shift+P → Silver Engineer: Configure API Credentials`
2. **VS Code settings**:
   ```json
   "silverEngineer.jiraBaseUrl": "https://company.atlassian.net",
   "silverEngineer.jiraProjectKey": "PROJ",
   "silverEngineer.gerritTargetBranch": "main"
   ```
3. **Gerrit integration**: Replace `silver_commit_code` tool with Gerrit REST API calls (see SKILL.md "Gerrit Integration" section)
4. **Company MCP tools**: Register internal tools via `McpServerManager.registerTool()`

### Nice-to-have
- Replace TF-IDF fallback with `ruvector` WASM when package stabilizes
- Add more `.vscode/silver-skills/` for team-specific workflows (deployment, incident, sprint retro)
- Auto-scan git log to populate KG with colleague nodes

---

## How to Add a New Workflow (e.g., deployment runbook)

Just drop a `.md` file in `.vscode/silver-skills/`:

```markdown
---
name: deploy-staging
description: Deployment runbook for staging environment
triggers: ["deploy", "staging", "release"]
---
# Deploy to Staging
## Pre-checks
1. Run all tests: `npm test`
2. Check no uncommitted changes
...
```

The FileWatcher picks it up automatically — no extension rebuild needed.
Then use: `@silver how do I deploy to staging?`

---

## Quick Commands Reference

```powershell
# Build
node esbuild.config.js                   # dev
node esbuild.config.js --production      # prod
node esbuild.config.js --watch           # watch

# Type check
npx tsc --noEmit

# Package + Install
npx vsce package --no-dependencies --allow-missing-repository
code --install-extension silver-engineer-0.1.0.vsix --force

# Debug (F5 alternative)
# Open d:\AI\silver-engineer in VS Code → F5
```

---

## Files NOT in Git (must handle manually)

| File/Dir | Why excluded | Action needed |
|---|---|---|
| `node_modules/` | gitignore | `npm install` on new machine |
| `dist/` | gitignore | `node esbuild.config.js` on new machine |
| `*.vsix` | gitignore | rebuild with vsce |
| OS keychain secrets | never in Git | re-enter via Configure API Credentials |

---

## GitHub Repo Setup (first time)

```powershell
cd d:\AI\silver-engineer
git init         # if not done yet
git add .
git commit -m "feat(init): initial silver-engineer extension"
git remote add origin https://github.com/YOUR_USERNAME/silver-engineer.git
git push -u origin main
```

Make the repo **private** — contains proprietary workflow descriptions.
