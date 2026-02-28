# Silver Engineer — Copilot Instructions

These instructions apply to every Copilot interaction in the `silver-engineer` workspace.

---

## Project Identity

This is **Silver Engineer** — a VS Code extension that provides:
- `@silver` Chat Participant with GraphRAG context injection
- Embedded MCP HTTP server with HITL tool invocation
- Local Knowledge Graph (graphology) + Vector Store (vectra)
- Skills system (builtin templates + `.vscode/silver-skills/*.md` hot-reload)
- `/review` command: ai_git_push-style pre-push code review

**Extension ID:** `silver-engineer.silver-engineer`
**Publisher:** `silver-engineer`
**Min VS Code:** `^1.95.0`

---

## Commit Convention (Conventional Commits)

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

| Type | Usage |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `test` | Tests only |
| `static` | Static analysis violations |
| `refactor` | Restructure without behavior change |
| `docs` | Documentation only |
| `format` | Whitespace/formatting only |
| `chore` | Build scripts, CI, dependencies |

---

## Agent Routing (ai_git_push)

| Commit type | Reviewer agent |
|---|---|
| `fix` / `fixbug` | `reviewer-bugfix` |
| `feat` / `feature` | `reviewer-feature` |
| `static` | `reviewer-static` |
| `test` / `docs` / `format` / `chore` / `refactor` | `reviewer-light` |

All reviewer agents end with `[PASS]` or `[FAIL]` — parsed by the ai_git_push script.

---

## Architecture Rules (never break these)

1. `chatParticipants[].id` in `package.json` === `"silver-engineer.silver-engineer"`
2. `PARTICIPANT_ID` in `src/chatParticipant.ts` === `"silver-engineer.silver-engineer"`
3. `esbuild.config.js` `copyRuntimeAssets()` must copy `encoder.json` + `vocab.bpe` to `dist/`
4. All proposed VS Code API calls wrapped in `typeof x === 'function'` guards
5. `SilverServices` interface lives ONLY in `src/types.ts`
6. `ToolRegistry` never imports `McpServerManager` directly — uses `ToolInvoker` callback
7. `dist/skills/templates/` is how built-in skills reach the VSIX (not `src/skills/templates/`)
8. No `LanguageModelChatMessage.System()` — use `.User('[SYSTEM] ...')` pattern

---

## Build Pipeline

```powershell
node esbuild.config.js              # dev build (sourcemaps)
node esbuild.config.js --production # prod build (minified)
node esbuild.config.js --watch      # watch mode
npx tsc --noEmit                    # type-check
npx vsce package --no-dependencies --allow-missing-repository
code --install-extension silver-engineer-0.1.0.vsix --force
```

---

## Skills Available

| Skill | Path | Purpose |
|---|---|---|
| Silver Engineer Dev | `.github/skills/silver-engineer-dev/SKILL.md` | Full architecture, build, debug, extend guide |

---

## General Principles

- **Shift-Left Quality**: Always type-check (`npx tsc --noEmit`) before packaging
- **Scope discipline**: Each commit does exactly one thing
- **HITL first**: Any state-changing action (git push, file write, Jira update) requires user confirmation
- **No broken windows**: No new TODOs, commented-out code, or magic numbers
