import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as yaml from 'js-yaml';
import type {
  WorkflowDefinition,
  WorkflowStep,
  StepResult,
  WorkflowRunResult,
} from './types';

// ---------------------------------------------------------------------------
// WorkflowEngine
//
// Reads .github/workflows/silver/*.yml from the workspace, parses them,
// and executes with full branching logic:
//   - step types: agent, prompt, shell
//   - expect / on_fail (abort | continue | retry(max: N))
//   - condition expressions (steps.<id>.passed)
//   - {{variable}} interpolation
//
// This is the orchestration layer that makes @silver /run truly agentic:
// it drives multiple LLM calls and shell commands under a defined flow,
// not just a single prompt.
// ---------------------------------------------------------------------------

export class WorkflowEngine {

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Lists all available workflows from .github/workflows/silver/*.yml
   */
  listWorkflows(): { name: string; description: string; file: string }[] {
    const dir = this.workflowDir();
    if (!dir || !fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
      .flatMap(f => {
        try {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8');
          const def = yaml.load(raw) as WorkflowDefinition;
          return [{ name: def.name ?? path.basename(f, '.yml'), description: def.description ?? '', file: f }];
        } catch {
          return [];
        }
      });
  }

  /**
   * Loads a workflow by name (matches `name:` field in YAML, or filename without extension).
   */
  loadWorkflow(name: string): WorkflowDefinition | null {
    const dir = this.workflowDir();
    if (!dir || !fs.existsSync(dir)) return null;

    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const def = yaml.load(raw) as WorkflowDefinition;
        const defName = def.name ?? path.basename(f, '.yml');
        if (defName === name || path.basename(f, '.yml') === name || path.basename(f, '.yaml') === name) {
          return def;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Executes a workflow, streaming progress to the chat response stream.
   * Returns a full run result including per-step outcomes.
   */
  async run(
    workflow: WorkflowDefinition,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<WorkflowRunResult> {
    const variables = new Map<string, string>();
    const stepResults = new Map<string, StepResult>();

    // ── Populate built-in variables (git remote, platform, push command) ──
    populateGitVariables(variables);

    stream.markdown(`## ⚙️ Workflow: \`${workflow.name}\`\n`);
    if (workflow.description) {
      stream.markdown(`> ${workflow.description}\n`);
    }
    // Show detected platform info
    const platform = variables.get('git_platform');
    const pushCmd = variables.get('git_push_cmd');
    if (platform) {
      stream.markdown(`> 🌐 Platform: **${platform}** — push: \`${pushCmd}\`\n`);
    }
    stream.markdown(`\n**${workflow.steps.length} steps** — running now…\n\n`);
    stream.markdown('---\n\n');

    const results: StepResult[] = [];

    for (const step of workflow.steps) {
      if (token.isCancellationRequested) break;

      // ── Evaluate condition ──────────────────────────────────────────────
      if (step.condition) {
        const conditionPassed = evaluateCondition(step.condition, stepResults);
        if (!conditionPassed) {
          const r: StepResult = { id: step.id, passed: true, output: '', skipped: true };
          stepResults.set(step.id, r);
          results.push(r);
          stream.markdown(`⏭️ **\`${step.id}\`** — skipped *(condition not met)*\n\n`);
          continue;
        }
      }

      // ── Execute with retry support ─────────────────────────────────────
      const maxRetries = parseRetry(step.on_fail);
      let attempt = 0;
      let stepResult: StepResult | null = null;

      while (attempt <= maxRetries) {
        if (attempt > 0) {
          stream.markdown(`  🔄 Retry ${attempt}/${maxRetries}…\n`);
        }

        stepResult = await this.runStep(step, variables, stream, token);
        if (stepResult.passed) break;

        attempt++;
        if (attempt > maxRetries) break;
      }

      if (!stepResult) {
        stepResult = { id: step.id, passed: false, output: '', skipped: false, failReason: 'unknown' };
      }

      // Capture output variable
      if (step.output && stepResult.output) {
        variables.set(step.output, stepResult.output);
      }

      stepResults.set(step.id, stepResult);
      results.push(stepResult);

      // ── Handle failure ─────────────────────────────────────────────────
      if (!stepResult.passed) {
        const strategy = step.on_fail ?? 'abort';
        if (strategy === 'abort' || strategy.startsWith('retry')) {
          // retry exhausted → abort
          stream.markdown(`\n❌ **Workflow aborted** at step \`${step.id}\`\n`);
          if (stepResult.failReason) {
            stream.markdown(`> ${stepResult.failReason}\n`);
          }
          return {
            workflowName: workflow.name,
            passed: false,
            steps: results,
            abortedAt: step.id,
          };
        }
        // continue — already logged in runStep
      }
    }

    const allPassed = results.every(r => r.passed || r.skipped);
    stream.markdown('\n---\n');
    if (allPassed) {
      stream.markdown('### ✅ Workflow completed successfully\n');
    } else {
      const failed = results.filter(r => !r.passed && !r.skipped).map(r => r.id).join(', ');
      stream.markdown(`### ⚠️ Workflow completed with failures: \`${failed}\`\n`);
    }

    return { workflowName: workflow.name, passed: allPassed, steps: results };
  }

  // ── Private step runners ───────────────────────────────────────────────

  private async runStep(
    step: WorkflowStep,
    variables: Map<string, string>,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<StepResult> {
    const label = interpolate(step.description ?? step.id, variables);
    stream.markdown(`### 🔹 \`${step.id}\` — ${label}\n\n`);

    try {
      switch (step.type) {
        case 'agent':  return await this.runAgentStep(step, variables, stream, token);
        case 'prompt': return await this.runPromptStep(step, variables, stream, token);
        case 'shell':  return this.runShellStep(step, variables, stream);
        default: {
          stream.markdown(`> ⚠️ Unknown step type: \`${(step as WorkflowStep).type}\`\n\n`);
          return { id: step.id, passed: false, output: '', skipped: false, failReason: `unknown type: ${step.type}` };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.markdown(`> ❌ Step threw: ${msg}\n\n`);
      return { id: step.id, passed: false, output: '', skipped: false, failReason: msg };
    }
  }

  /**
   * Runs an 'agent' step: loads .github/agents/<name>.agent.md, calls LLM.
   */
  private async runAgentStep(
    step: WorkflowStep,
    variables: Map<string, string>,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<StepResult> {
    const agentName = step.agent ?? '';
    const { body: agentBody, model: agentModel } = this.loadAgentPrompt(agentName);
    if (!agentBody) {
      const msg = `.github/agents/${agentName}.agent.md not found`;
      stream.markdown(`> ⚠️ ${msg}\n\n`);
      return { id: step.id, passed: false, output: '', skipped: false, failReason: msg };
    }

    let inputText = this.resolveInput(step.input, variables);

    // If staged diff is empty, auto-stage all modified tracked files and retry
    if (step.input === 'git_diff_staged' && !inputText.trim()) {
      const cwd = resolveGitCwd();
      try {
        execSync('git add -u', { encoding: 'utf8', cwd });
        inputText = this.resolveInput(step.input, variables);
        if (inputText.trim()) {
          stream.markdown('> ℹ️ Nothing was staged — auto-staged all modified tracked files (`git add -u`)\n\n');
        }
      } catch { /* fall through to guard below */ }
    }

    // Guard: if input source declared but still empty after auto-stage attempt
    if (step.input && !inputText.trim()) {
      const msg = step.input === 'git_diff_staged'
        ? 'No changes to stage — working tree is clean'
        : `Input \`${step.input}\` resolved to empty`;
      stream.markdown(`> ⚠️ ${msg}\n\n`);
      return { id: step.id, passed: false, output: '', skipped: false, failReason: msg };
    }

    const model = await selectModel(agentModel);
    if (!model) {
      return { id: step.id, passed: false, output: '', skipped: false, failReason: 'No LM available' };
    }

    const messages: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(
        '[SYSTEM] You are a code reviewer. Apply the instructions below autonomously. ' +
        'Do NOT ask for more input. Review only what is provided in the diff below. ' +
        'End your response with exactly `[PASS]` or `[FAIL]` on its own line.\n\n' +
        `## Agent Instructions\n${agentBody}`,
      ),
      vscode.LanguageModelChatMessage.User(
        `## Staged Diff to Review\n\`\`\`diff\n${inputText}\n\`\`\``,
      ),
    ];

    let output = '';
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
      stream.markdown(chunk);
      output += chunk;
    }
    stream.markdown('\n\n');

    const passed = checkExpect(output, step.expect);
    if (!passed) {
      const failReason = step.expect
        ? `Expected \`${step.expect}\` not found in output`
        : 'Step failed';
      stream.markdown(`> ❌ ${failReason}\n\n`);
      return { id: step.id, passed: false, output, skipped: false, failReason };
    }

    stream.markdown(`> ✅ Passed\n\n`);
    return { id: step.id, passed: true, output, skipped: false };
  }

  /**
   * Runs a 'prompt' step: loads prompt file, calls LLM, optionally captures output.
   */
  private async runPromptStep(
    step: WorkflowStep,
    variables: Map<string, string>,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<StepResult> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return skipNoWorkspace(step.id);

    const promptFile = step.prompt ?? '';
    const promptPath = path.join(wsFolder.uri.fsPath, promptFile);

    if (!fs.existsSync(promptPath)) {
      const msg = `Prompt file not found: ${promptFile}`;
      stream.markdown(`> ⚠️ ${msg}\n\n`);
      return { id: step.id, passed: false, output: '', skipped: false, failReason: msg };
    }

    let promptContent = fs.readFileSync(promptPath, 'utf8');
    // Strip YAML frontmatter if present
    promptContent = promptContent.replace(/^---[\s\S]*?---\s*\n/, '').trim();
    // Interpolate variables into prompt body
    promptContent = interpolate(promptContent, variables);

    const inputText = this.resolveInput(step.input, variables);
    const fullPrompt = inputText
      ? `${promptContent}\n\n## Input\n${inputText}`
      : promptContent;

    const model = await selectModel();
    if (!model) {
      return { id: step.id, passed: false, output: '', skipped: false, failReason: 'No LM available' };
    }

    const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];

    let output = '';
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
      stream.markdown(chunk);
      output += chunk;
    }
    stream.markdown('\n\n');

    const passed = checkExpect(output, step.expect);
    if (!passed) {
      const failReason = step.expect ? `Expected \`${step.expect}\` not found` : 'Step failed';
      stream.markdown(`> ❌ ${failReason}\n\n`);
      return { id: step.id, passed: false, output, skipped: false, failReason };
    }

    // If this step's output will be captured as a variable, strip markdown
    // code fences so the raw value can be used directly in shell commands.
    const capturedOutput = step.output ? stripCodeFences(output) : output;

    if (step.output) {
      stream.markdown(`> 📋 Output captured to \`{{${step.output}}}\`\n\n`);
    }

    stream.markdown(`> ✅ Passed\n\n`);
    return { id: step.id, passed: true, output: capturedOutput, skipped: false };
  }

  /**
   * Runs a 'shell' step: executes a command, captures stdout.
   */
  private runShellStep(
    step: WorkflowStep,
    variables: Map<string, string>,
    stream: vscode.ChatResponseStream,
  ): StepResult {
    const cwd = resolveGitCwd();
    const rawCmd = step.command ?? '';
    const cmd = interpolate(rawCmd, variables);

    stream.markdown(`\`\`\`\n$ ${cmd}\n\`\`\`\n\n`);

    try {
      const stdout = execSync(cmd, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        cwd,
      }).trim();

      if (stdout) stream.markdown(`\`\`\`\n${stdout}\n\`\`\`\n\n`);

      const passed = checkExpect(stdout, step.expect);
      if (!passed) {
        const failReason = step.expect ? `Expected \`${step.expect}\` not found in output` : 'Command failed';
        stream.markdown(`> ❌ ${failReason}\n\n`);
        return { id: step.id, passed: false, output: stdout, skipped: false, failReason };
      }

      stream.markdown('> ✅ Passed\n\n');
      return { id: step.id, passed: true, output: stdout, skipped: false };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? String(err);
      stream.markdown(`\`\`\`\n${stderr}\n\`\`\`\n\n`);
      stream.markdown('> ❌ Command failed\n\n');
      return { id: step.id, passed: false, output: stderr, skipped: false, failReason: stderr.slice(0, 200) };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private workflowDir(): string | null {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return null;
    return path.join(wsFolder.uri.fsPath, '.github', 'workflows', 'silver');
  }

  private loadAgentPrompt(agentName: string): { body: string; model?: string } {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return { body: '' };
    const agentPath = path.join(wsFolder.uri.fsPath, '.github', 'agents', `${agentName}.agent.md`);
    if (!fs.existsSync(agentPath)) return { body: '' };
    try {
      const raw = fs.readFileSync(agentPath, 'utf8');
      // Extract model from YAML frontmatter
      const fmMatch = raw.match(/^---([\s\S]*?)---\s*\n/);
      let model: string | undefined;
      if (fmMatch) {
        const modelMatch = fmMatch[1].match(/^model:\s*(.+)$/m);
        if (modelMatch) model = modelMatch[1].trim();
      }
      const body = raw.replace(/^---[\s\S]*?---\s*\n/, '').trim();
      return { body, model };
    } catch { return { body: '' }; }
  }

  private resolveInput(input: string | undefined, variables: Map<string, string>): string {
    if (!input) return '';

    // Variable reference
    const varMatch = input.match(/^\{\{(.+)\}\}$/);
    if (varMatch) return variables.get(varMatch[1].trim()) ?? '';

    const cwd = resolveGitCwd();
    const opts = { encoding: 'utf8' as const, maxBuffer: 512 * 1024, cwd };

    try {
      switch (input) {
        case 'git_diff_staged':
          return execSync('git diff --staged', opts);
        case 'git_diff_last_commit':
          return execSync('git diff HEAD~1..HEAD', opts);
        case 'commit_message_last':
          return execSync('git log -1 --pretty=%B', opts).trim();
        default:
          return interpolate(input, variables);
      }
    } catch {
      return `(could not resolve input: ${input})`;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Selects the best available LM. Tries the agent-specified model first,
 * then falls back through claude → gpt-4o → any available model.
 */
async function selectModel(hint?: string): Promise<vscode.LanguageModelChat | null> {
  // Try the agent-specified model (e.g. 'claude-sonnet-4-5')
  if (hint) {
    // hint may be 'claude-sonnet-4-5' → family='claude', or 'gpt-4o' → family='gpt-4o'
    const family = hint.startsWith('claude') ? 'claude' : hint;
    const byHint = await vscode.lm.selectChatModels({ family });
    if (byHint.length > 0) return byHint[0];
    // Try exact id match
    const byId = await vscode.lm.selectChatModels({ id: hint });
    if (byId.length > 0) return byId[0];
  }
  // Fallback chain: claude → gpt-4o → any
  for (const family of ['claude', 'gpt-4o', 'copilot']) {
    const m = await vscode.lm.selectChatModels({ family });
    if (m.length > 0) return m[0];
  }
  const any = await vscode.lm.selectChatModels({});
  return any[0] ?? null;
}

function checkExpect(output: string, expect?: string): boolean {
  if (!expect) return true;
  return output.includes(expect);
}

/**
 * Evaluates a condition expression like "steps.review.passed && steps.static.passed"
 * Only supports: steps.<id>.passed references, &&, ||, !, parentheses.
 */
function evaluateCondition(condition: string, results: Map<string, StepResult>): boolean {
  // Replace steps.<id>.passed with true/false
  let expr = condition.replace(/steps\.([a-zA-Z0-9_-]+)\.passed/g, (_m, id) => {
    const r = results.get(id);
    return r ? String(r.passed) : 'false';
  });

  // Replace steps.<id>.skipped
  expr = expr.replace(/steps\.([a-zA-Z0-9_-]+)\.skipped/g, (_m, id) => {
    const r = results.get(id);
    return r ? String(r.skipped) : 'false';
  });

  // Evaluate only if safe (only contains booleans, logic operators, parens)
  if (/^[true|false|&&|\|\||!|\s|()]+$/.test(expr)) {
    try {
      // eslint-disable-next-line no-new-func
      return Boolean(new Function(`return (${expr})`)());
    } catch { return false; }
  }

  return false;
}

/**
 * Parses 'retry(max: N)' → returns N. Returns 0 for any other value.
 */
function parseRetry(onFail?: string): number {
  if (!onFail) return 0;
  const m = onFail.match(/retry\s*\(\s*max\s*:\s*(\d+)\s*\)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Replaces {{variable_name}} placeholders in a string.
 */
function interpolate(text: string, variables: Map<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_m, key) => variables.get(key.trim()) ?? _m);
}

/**
 * Strips markdown code fences from LLM output.
 * Handles: ```\ntext\n``` and ```lang\ntext\n```
 * Returns the inner content trimmed.
 */
function stripCodeFences(text: string): string {
  const fenced = text.trim().match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) return fenced[1].trim();
  // Also strip inline single backticks if the whole thing is wrapped
  const inline = text.trim().match(/^`([^`]+)`$/);
  if (inline) return inline[1].trim();
  return text.trim();
}

function skipNoWorkspace(id: string): StepResult {
  return { id, passed: false, output: '', skipped: false, failReason: 'No workspace folder open' };
}

/**
 * Returns the git repository root for the currently active editor file.
 * Falls back to the first workspace folder if no editor is open or the
 * file is not inside a git repo.
 *
 * This correctly handles workspaces where the open folder (e.g. d:\AI) is
 * a different git repo than the file being edited (e.g. d:\AI\silver-engineer).
 */
function resolveGitCwd(): string | undefined {
  // 1. Try active editor's file path first
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri && activeUri.scheme === 'file') {
    const fileDir = path.dirname(activeUri.fsPath);
    try {
      const root = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf8',
        cwd: fileDir,
      }).trim();
      if (root) return root;
    } catch { /* not a git repo, fall through */ }
  }
  // 2. Fall back to workspace folder
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// ---------------------------------------------------------------------------
// Git platform detection
// ---------------------------------------------------------------------------

/**
 * Detects the git remote URL, infers the platform (gerrit/github/gitlab/bitbucket),
 * and populates built-in variables:
 *   {{git_remote_url}}  — raw remote URL
 *   {{git_branch}}      — current branch name
 *   {{git_platform}}    — gerrit | github | gitlab | bitbucket | unknown
 *   {{git_push_cmd}}    — the correct push command for this platform/branch
 */
function populateGitVariables(variables: Map<string, string>): void {
  const cwd = resolveGitCwd();
  const opts = { encoding: 'utf8' as const, cwd };

  try {
    const remoteUrl = execSync('git remote get-url origin', opts).trim();
    variables.set('git_remote_url', remoteUrl);

    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    variables.set('git_branch', branch);

    const platform = detectPlatform(remoteUrl);
    variables.set('git_platform', platform);
    variables.set('git_push_cmd', buildPushCmd(platform, branch));

    // Last 5 commit messages — used by prompts to infer project commit format
    const recentCommits = execSync(
      'git log -5 --pretty=format:"- %s"',
      opts,
    ).trim();
    variables.set('git_recent_commits', recentCommits);
  } catch {
    // Non-git workspace — leave variables unset
    variables.set('git_platform', 'unknown');
    variables.set('git_push_cmd', 'git push');
    variables.set('git_recent_commits', '(no git history)');
  }
}

function detectPlatform(remoteUrl: string): string {
  const u = remoteUrl.toLowerCase();
  if (u.includes('github.com'))    return 'github';
  if (u.includes('gitlab.com') || u.includes('gitlab'))  return 'gitlab';
  if (u.includes('bitbucket.org')) return 'bitbucket';
  // Gerrit detection: ssh port 29418, or /a/ HTTP prefix, or explicit gerrit hostname
  if (u.includes(':29418') || u.includes('/a/') || u.includes('gerrit')) return 'gerrit';
  // Self-hosted GitLab/GitHub patterns — fall back to inspecting refs
  return 'unknown';
}

/**
 *
 * @param platform
 * @param branch
 * @returns
 */
function buildPushCmd(platform: string, branch: string): string {
  switch (platform) {
    case 'github':
    case 'gitlab':
    case 'bitbucket':
      return `git push origin HEAD:${branch}`;
    case 'gerrit':
      return `git push origin HEAD:refs/for/${branch}`;
    default:
      // Unknown: try generic push; user can override via workflow YAML
      return `git push origin HEAD:${branch}`;
  }
}
