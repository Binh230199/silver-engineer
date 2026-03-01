import * as vscode from 'vscode';
import { execSync } from 'child_process';
import type { SilverServices } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  output: string;
  data?: unknown;
}

/**
 * Strategy interface: each tool is one strategy.
 * Command pattern: invoke() encapsulates the action.
 */
export interface SilverTool {
  name: string;
  description: string;
  /** Called BEFORE invocation — returns the confirmation message to show the user. */
  prepareConfirmation(input: ToolInput): string;
  /** Called AFTER user confirms. Executes the action. */
  invoke(input: ToolInput, svc: SilverServices): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Built-in tool strategies
// ---------------------------------------------------------------------------

const commitCodeTool: SilverTool = {
  name: 'silver_commit_code',
  description: 'Stage and commit files with a conventional commit message.',
  prepareConfirmation(input) {
    const msg   = input['message'] as string ?? '(no message)';
    const files = (input['files'] as string[] | undefined)?.join(', ') ?? 'all staged files';
    return `Commit **"${msg}"** to git (files: ${files})`;
  },
  async invoke(input, _svc) {
    const msg = input['message'] as string;
    const files = input['files'] as string[] | undefined;
    const terminal = vscode.window.createTerminal({ name: 'Silver: git commit', hideFromUser: true });
    if (files?.length) {
      terminal.sendText(`git add ${files.map(f => `"${f}"`).join(' ')}`);
    }
    terminal.sendText(`git commit -m "${msg.replace(/"/g, '\\"')}"`);
    terminal.dispose();
    return { success: true, output: `Committed: ${msg}` };
  },
};

const updateJiraTool: SilverTool = {
  name: 'silver_update_jira',
  description: 'Update a Jira issue (status, comment, assignee).',
  prepareConfirmation(input) {
    const key     = input['issueKey'] as string ?? '?';
    const status  = input['status']   as string | undefined;
    const comment = input['comment']  as string | undefined;
    const parts   = [];
    if (status)  parts.push(`status → **${status}**`);
    if (comment) parts.push(`add comment: "${comment}"`);
    return `Update Jira ${key}: ${parts.join(', ')}`;
  },
  async invoke(input, svc) {
    const key     = input['issueKey'] as string;
    const status  = input['status']   as string | undefined;
    const comment = input['comment']  as string | undefined;
    const baseUrl = vscode.workspace.getConfiguration('silverEngineer').get<string>('jiraBaseUrl', '');
    const token   = await svc.secrets.get('silver.jiraApiToken' as never);
    const email   = await svc.secrets.get('silver.jiraEmail'    as never);

    if (!baseUrl || !token || !email) {
      return { success: false, output: 'Jira not configured. Run "Silver Engineer: Configure API Credentials".' };
    }

    const headers: Record<string, string> = {
      'Authorization': `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };

    let lastOutput = '';

    if (status) {
      const transRes = await fetch(`${baseUrl}/rest/api/3/issue/${key}/transitions`, { headers });
      const trans = (await transRes.json()) as { transitions: Array<{ id: string; name: string }> };
      const match = trans.transitions.find(t => t.name.toLowerCase() === status.toLowerCase());
      if (match) {
        await fetch(`${baseUrl}/rest/api/3/issue/${key}/transitions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ transition: { id: match.id } }),
        });
        lastOutput = `${key} transitioned to ${status}`;
      }
    }

    if (comment) {
      await fetch(`${baseUrl}/rest/api/3/issue/${key}/comment`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] } }),
      });
      lastOutput = lastOutput ? lastOutput + '; comment added' : `Comment added to ${key}`;
    }

    return { success: true, output: lastOutput || `${key} updated` };
  },
};

const generateComponentTool: SilverTool = {
  name: 'silver_generate_component',
  description: 'Scaffold a new source component from a skill template.',
  prepareConfirmation(input) {
    const skill  = input['skillName']   as string ?? '?';
    const target = input['targetPath']  as string ?? '?';
    return `Generate **${skill}** component at \`${target}\``;
  },
  async invoke(input, svc) {
    const skillName  = input['skillName']  as string;
    const targetPath = input['targetPath'] as string;
    const params     = input['params']     as Record<string, string> | undefined;

    const skill = svc.skills.findByName(skillName);
    if (!skill) {
      return { success: false, output: `Skill '${skillName}' not found. Run /skills to list available skills.` };
    }

    let content = skill.fullContent;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        content = content.replaceAll(`{{${k}}}`, v);
      }
    }

    const uri = vscode.Uri.file(targetPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    await vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));

    return { success: true, output: `Generated ${targetPath} using skill '${skillName}'` };
  },
};

const recallTool: SilverTool = {
  name: 'silver_recall',
  description: 'Query the local Knowledge Graph + vector store for relevant context.',
  prepareConfirmation(input) {
    return `Query local memory: "${input['query'] as string}"`;
  },
  async invoke(input, svc) {
    const query = input['query'] as string;
    const topK  = (input['topK'] as number | undefined) ?? 5;

    const [graphNodes, vectorResults] = await Promise.all([
      Promise.resolve(svc.graph.findRelated(query)),
      svc.vectors.querySimilar(query, topK),
    ]);

    const lines: string[] = [];
    if (graphNodes.length > 0) {
      lines.push('**Graph nodes:**');
      graphNodes.slice(0, 5).forEach(n => lines.push(`- ${n}`));
    }
    if (vectorResults.length > 0) {
      lines.push('**Semantic matches:**');
      vectorResults.forEach(r => lines.push(`- (${r.score.toFixed(2)}) ${r.text}`));
    }

    return {
      success: true,
      output: lines.length > 0 ? lines.join('\n') : 'No relevant context found yet.',
      data: { graphNodes, vectorResults },
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: Code Review (ai_git_push workflow)
// ---------------------------------------------------------------------------

/**
 * Parses the conventional commit type from a commit message prefix.
 * e.g. "fix(bluetooth): ..." → "fix"
 */
function parseCommitType(msg: string): string {
  const match = msg.match(/^([a-z]+)[(:)]/i);
  return match?.[1]?.toLowerCase() ?? 'other';
}

/**
 * Maps commit type to the name of the reviewer skill to load.
 */
function reviewerSkillName(commitType: string): string {
  switch (commitType) {
    case 'fix':  case 'fixbug':  return 'reviewer-bugfix';
    case 'feat': case 'feature': return 'reviewer-feature';
    case 'static':               return 'reviewer-static';
    default:                     return 'reviewer-light';
  }
}

const reviewCodeTool: SilverTool = {
  name: 'silver_review_code',
  description: 'Capture staged git diff + commit message and return them for AI review.',
  prepareConfirmation(input) {
    const scope = (input['scope'] as string ?? 'staged') === 'last-commit' ? 'last commit' : 'staged changes';
    return `Run AI code review on ${scope}`;
  },
  async invoke(input, _svc) {
    const scope = (input['scope'] as string ?? 'staged') === 'last-commit' ? 'HEAD~1..HEAD' : '--staged';
    try {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const opts = { encoding: 'utf8' as const, maxBuffer: 512 * 1024, cwd };
      const diff = execSync(`git diff ${scope}`, opts);
      if (!diff.trim()) {
        return {
          success: false,
          output: scope === '--staged'
            ? 'Nothing staged. Run `git add <files>` first, or use scope=last-commit to review the last commit.'
            : 'No changes found in last commit.',
        };
      }
      const commitMsg = execSync('git log -1 --pretty=%B', opts).trim();
      const commitType = parseCommitType(commitMsg);
      const skillName  = reviewerSkillName(commitType);
      return {
        success: true,
        output: [
          `**Commit:** \`${commitMsg}\``,
          `**Type:** \`${commitType}\` → reviewer: \`${skillName}\``,
          `**Diff size:** ${diff.split('\n').length} lines`,
          '',
          'Use `@silver /review` to run the full review, or ask me to review this diff now.',
        ].join('\n'),
        data: { diff, commitMsg, commitType, skillName },
      };
    } catch (err) {
      return { success: false, output: `Git error: ${String(err)}` };
    }
  },
};

const pushGerritTool: SilverTool = {
  name: 'silver_push_gerrit',
  description: 'Push current commit to Gerrit for review (refs/for/<branch>).',
  prepareConfirmation(input) {
    const branch = input['branch'] as string ?? 'main';
    return `Push to Gerrit **refs/for/${branch}**`;
  },
  async invoke(input, _svc) {
    const branch = (input['branch'] as string ?? 'main');
    const terminal = vscode.window.createTerminal({ name: 'Silver: git push' });
    terminal.show();
    terminal.sendText(`git push origin HEAD:refs/for/${branch}`);
    return { success: true, output: `Pushing to refs/for/${branch}… (see terminal for output)` };
  },
};

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  /** Plugin-like registry of all tools (Strategy Pattern + Command Pattern) */
  private readonly registry = new Map<string, SilverTool>();

  constructor(
    _ctx: vscode.ExtensionContext,
    private readonly svc: SilverServices,
  ) {}

  // ── Registration ──────────────────────────────────────────────────────────

  registerAll(): void {
    [commitCodeTool, updateJiraTool, generateComponentTool, recallTool,
      reviewCodeTool, pushGerritTool].forEach(t => this.register(t));
  }

  register(tool: SilverTool): void {
    this.registry.set(tool.name, tool);
  }

  // ── HITL manual invocation ────────────────────────────────────────────────

  /**
   * Invoke a tool with explicit HITL confirmation dialog before execution.
   * Returns undefined if the user cancels.
   */
  async invokeWithConfirmation(
    toolName: string,
    input: ToolInput,
  ): Promise<ToolResult | undefined> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return { success: false, output: `Unknown tool: ${toolName}` };
    }

    const confirmationMessage = tool.prepareConfirmation(input);
    const answer = await vscode.window.showInformationMessage(
      `🤖 Silver Engineer wants to: ${confirmationMessage}`,
      { modal: true },
      'Allow',
      'Cancel',
    );

    if (answer !== 'Allow') {
      return undefined; // User cancelled
    }

    return tool.invoke(input, this.svc);
  }

  // ── Agentic Loop (Think → Try → Observe → Adjust) ────────────────────────

  /**
   * Runs a bounded agentic loop for multi-step workflow commands.
   * The loop is capped at maxIterations to prevent infinite LM spending.
   */
  async runAgenticLoop(
    intent: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('silverEngineer');
    const maxIter = config.get<number>('maxAgentLoopIterations', 10);

    const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
    const model  = models[0];
    if (!model) {
      stream.markdown('> ⚠️  No language model available for agentic loop.');
      return;
    }

    const toolList = [...this.registry.values()]
      .map(t => `- \`${t.name}\`: ${t.description}`)
      .join('\n');

    let history: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(
        `[SYSTEM] You are executing a workflow step-by-step.\n` +
        `Available tools:\n${toolList}\n\n` +
        `To call a tool, respond ONLY with JSON: {"tool":"name","input":{...}}\n` +
        `When the workflow is complete, respond with: {"done":true,"summary":"..."}`,
      ),
      vscode.LanguageModelChatMessage.User(`Execute workflow: ${intent}`),
    ];

    for (let i = 0; i < maxIter; i++) {
      if (token.isCancellationRequested) break;

      const response = await model.sendRequest(history, {}, token);
      let raw = '';
      for await (const chunk of response.text) {
        raw += chunk;
      }

      // Try to parse the model's decision
      let decision: { tool?: string; input?: ToolInput; done?: boolean; summary?: string };
      try {
        decision = JSON.parse(raw.trim());
      } catch {
        // Model responded with plain text — treat as final answer
        stream.markdown(raw);
        break;
      }

      if (decision.done) {
        stream.markdown(`✅ **Workflow complete**: ${decision.summary ?? 'Done.'}`);
        break;
      }

      if (decision.tool && decision.input) {
        stream.markdown(`\n⚙️ **Step ${i + 1}**: ${this.registry.get(decision.tool)?.prepareConfirmation(decision.input) ?? decision.tool}\n`);

        const result = await this.invokeWithConfirmation(decision.tool, decision.input);
        if (!result) {
          stream.markdown('> 🚫 User cancelled. Workflow stopped.');
          break;
        }

        const observation = `Tool result: ${result.output}`;
        stream.markdown(`> ${observation}\n`);

        // Feed observation back for next iteration
        history = [
          ...history,
          vscode.LanguageModelChatMessage.Assistant(raw),
          vscode.LanguageModelChatMessage.User(observation),
        ];
      } else {
        // Unexpected format — surface it
        stream.markdown(raw);
        break;
      }
    }
  }
}
