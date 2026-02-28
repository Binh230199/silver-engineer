import * as vscode from 'vscode';
import { execSync } from 'child_process';
import type { SilverServices } from '../types';
import { extractTicketId } from '../core/mcp/tools';

const PARTICIPANT_ID = 'silver-engineer.silver-engineer';

// ---------------------------------------------------------------------------
// Chat Participant registration
// ---------------------------------------------------------------------------

/**
 * Creates the @silver Chat Participant when the API is available.
 * If vscode.chat is not present (older VS Code), falls back gracefully.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  svc: SilverServices,
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    console.warn('[SilverEngineer] Chat Participant API not available on this VS Code version.');
    return;
  }

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    (request, chatContext, stream, token) =>
      handleRequest(request, chatContext, stream, token, svc),
  );

  participant.iconPath = new vscode.ThemeIcon('hubot');
  participant.followupProvider = {
    provideFollowups(result, _ctx, _token) {
      const followups: vscode.ChatFollowup[] = [];
      if (result.metadata?.suggestSummary) {
        followups.push({ prompt: '/summary', label: 'Show today\'s summary' });
      }
      if (result.metadata?.suggestGraph) {
        followups.push({ prompt: '/graph', label: 'Open Knowledge Graph' });
      }
      return followups;
    },
  };

  context.subscriptions.push(participant);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  svc: SilverServices,
): Promise<vscode.ChatResult> {

  // ── Slash-command routing ──────────────────────────────────────────────
  switch (request.command) {
    case 'summary':  return handleSummaryCommand(stream, token, svc);
    case 'skills':   return handleSkillsCommand(stream, svc);
    case 'graph':    return handleGraphCommand(stream);
    case 'workflow': return handleWorkflowCommand(request.prompt, stream, token, svc);
    case 'review':   return handleReviewCommand(request.prompt, stream, token, svc);
    case 'tools':    return handleToolsCommand(stream, svc);
  }

  // ── Generic LM query with context injection ───────────────────────────
  return handleGenericQuery(request, chatContext, stream, token, svc);
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------

async function handleSummaryCommand(
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  svc: SilverServices,
): Promise<vscode.ChatResult> {
  stream.markdown('## 📋 Today\'s Summary\n\n');
  const graphCtx = svc.graph.buildDailySummaryContext();

  const model = await selectModel();
  if (!model) {
    stream.markdown('> ⚠️  No Copilot language model available. Please ensure GitHub Copilot is active.');
    return { metadata: {} };
  }

  const messages = [
    vscode.LanguageModelChatMessage.User(
      '[SYSTEM] You are Silver Engineer — a senior AI pair-programmer with persistent project memory. ' +
      'Produce a focused work digest based on the graph context provided.',
    ),
    vscode.LanguageModelChatMessage.User(
      `Knowledge graph context:\n${graphCtx || '(empty)'}\n\nProvide today's actionable work summary.`,
    ),
  ];

  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    stream.markdown(chunk);
  }

  return { metadata: { suggestGraph: true } };
}

async function handleSkillsCommand(
  stream: vscode.ChatResponseStream,
  svc: SilverServices,
): Promise<vscode.ChatResult> {
  const skills = svc.skills.listAll();
  stream.markdown('## 🛠️ Loaded Skills\n\n');

  if (skills.length === 0) {
    stream.markdown(
      '> No custom skills loaded yet.\n' +
      '> Add `.md` files to `.vscode/silver-skills/` to define your own workflows.\n',
    );
  } else {
    for (const skill of skills) {
      stream.markdown(`- **${skill.name}** — ${skill.description}\n`);
    }
  }

  stream.markdown(
    '\n> Add custom skills by placing Markdown files in `.vscode/silver-skills/`.',
  );
  return { metadata: {} };
}

async function handleGraphCommand(
  stream: vscode.ChatResponseStream,
): Promise<vscode.ChatResult> {
  stream.markdown('Opening Knowledge Graph dashboard…\n');
  await vscode.commands.executeCommand('silver-engineer.openDashboard');
  return { metadata: { suggestSummary: true } };
}

async function handleToolsCommand(
  stream: vscode.ChatResponseStream,
  svc: SilverServices,
): Promise<vscode.ChatResult> {
  stream.markdown('## 🔌 MCP Tool Discovery\n\n');
  stream.markdown('Scanning registered tools and matching to Silver Engineer intents…\n\n');

  // Invalidate cache so we always get a fresh scan
  svc.discovery.invalidate();
  const diagnosis = svc.discovery.diagnose();

  let anyFound = false;
  for (const [intent, result] of Object.entries(diagnosis)) {
    if (result === 'not found') {
      stream.markdown(`- ⚪ **${intent}** — no matching tool found\n`);
    } else {
      stream.markdown(`- ✅ **${intent}** → \`${result.tool}\` (score ${result.score})\n`);
      anyFound = true;
    }
  }

  stream.markdown('\n');
  if (!anyFound) {
    stream.markdown(
      '> No external MCP tools detected.\n' +
      '> Configure your MCP servers in `.vscode/mcp.json` and reload the window.\n',
    );
  } else {
    stream.markdown('> Tools are auto-discovered by keyword matching on tool name + description.\n');
  }

  return { metadata: {} };
}

async function handleWorkflowCommand(
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  svc: SilverServices,
): Promise<vscode.ChatResult> {
  stream.markdown(`## ⚙️ Workflow: \`${prompt || 'unspecified'}\`\n\n`);
  // Delegate to the agentic loop in ToolRegistry
  await svc.tools.runAgenticLoop(prompt, stream, token);
  return { metadata: {} };
}

// ---------------------------------------------------------------------------
// /review — ai_git_push workflow
// ---------------------------------------------------------------------------

/**
 * Parses the conventional commit type prefix from a commit message.
 */
function parseCommitType(msg: string): string {
  const m = msg.match(/^([a-z]+)[(:)]/i);
  return m?.[1]?.toLowerCase() ?? 'other';
}

/**
 * Maps commit type → reviewer skill name.
 */
function reviewerSkillName(t: string): string {
  switch (t) {
    case 'fix': case 'fixbug':   return 'reviewer-bugfix';
    case 'feat': case 'feature': return 'reviewer-feature';
    case 'static':               return 'reviewer-static';
    default:                     return 'reviewer-light';
  }
}

async function handleReviewCommand(
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  svc: SilverServices,
): Promise<vscode.ChatResult> {
  stream.markdown('## 🔍 Code Review\n\n');

  // ─ 1. Capture git diff ──────────────────────────────────────────────────
  // Prompt override: "last-commit" or "staged" (default)
  const useLastCommit = /last.?commit|head/i.test(prompt);
  const diffScope     = useLastCommit ? 'HEAD~1..HEAD' : '--staged';

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let diff = '';
  let commitMsg = '';
  try {
    const opts = { encoding: 'utf8' as const, maxBuffer: 512 * 1024, cwd };
    diff      = execSync(`git diff ${diffScope}`, opts);
    commitMsg = execSync('git log -1 --pretty=%B', opts).trim();
  } catch (err) {
    stream.markdown(`> ⚠️  Git error: ${String(err)}`);
    return { metadata: {} };
  }

  if (!diff.trim()) {
    stream.markdown(
      useLastCommit
        ? '> No changes in last commit.'
        : '> **Nothing staged.** Run `git add <files>` first, or use `/review last-commit`.',
    );
    return { metadata: {} };
  }

  const commitType  = parseCommitType(commitMsg);
  const skillName   = reviewerSkillName(commitType);
  const diffLines   = diff.split('\n').length;

  stream.markdown(
    `| | |\n|---|---|\n` +
    `| **Commit** | \`${commitMsg.split('\n')[0]}\` |\n` +
    `| **Type** | \`${commitType}\` |\n` +
    `| **Reviewer** | \`${skillName}\` |\n` +
    `| **Diff** | ${diffLines} lines |\n\n`,
  );

  // ─ 2. Load reviewer skill instructions ────────────────────────────────
  const matchedSkills = await svc.skills.findRelevant(skillName);
  const skillContent  = matchedSkills[0]?.fullContent ?? '';

  if (!skillContent) {
    stream.markdown(`> ⚠️  Skill \`${skillName}\` not found. Add \`.vscode/silver-skills/${skillName}.md\` for custom review rules. Using built-in LLM knowledge.\n\n`);
  }

  // ─ 2b. Enrich with external MCP tools (best-effort, no-op if unavailable) ─
  //
  // Architecture: we call tools BY NAME only. We do NOT manage MCP servers.
  // The user configures their MCP servers (C++ binaries, SaaS SDKs, mcp.json)
  // independently. If the tool is registered → we get the data. If not → skip.
  //
  let externalContext = '';

  if (commitType === 'fix' || commitType === 'fixbug') {
    const ticketId = extractTicketId(commitMsg);
    if (ticketId) {
      stream.markdown(`> 🔍 Looking up Jira ticket **${ticketId}**…\n`);
      const jiraData = await svc.discovery.invoke(
        'JIRA_GET_ISSUE',
        { issueKey: ticketId, key: ticketId, issue_id: ticketId },
        token,
      );

      if (jiraData) {
        externalContext += `\n\n## Jira Ticket: ${ticketId}\n${jiraData}`;
        stream.markdown(`> ✅ Jira context loaded for **${ticketId}**\n\n`);
      } else {
        stream.markdown(`> ⚪ Jira MCP tool not available — reviewing without ticket context.\n\n`);
      }
    }
  }

  // ─ 3. Truncate diff if too large (> 400 lines) ────────────────────────
  const MAX_DIFF_LINES = 400;
  const diffForReview  = diffLines > MAX_DIFF_LINES
    ? diff.split('\n').slice(0, MAX_DIFF_LINES).join('\n') + `\n\n... [truncated: ${diffLines - MAX_DIFF_LINES} more lines]`
    : diff;

  if (diffLines > MAX_DIFF_LINES) {
    stream.markdown(`> ⚠️  Diff truncated to ${MAX_DIFF_LINES} lines (was ${diffLines}). Review the full diff manually for very large changes.\n\n`);
  }

  // ─ 4. Run LLM review ──────────────────────────────────────────────────
  const model = await selectModel();
  if (!model) {
    stream.markdown('> ⚠️  No language model available.');
    return { metadata: {} };
  }

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(
      '[SYSTEM] You are a code reviewer. ' +
      'Apply the reviewer instructions below exactly. ' +
      'End your response with exactly `[PASS]` or `[FAIL]` on its own line.' +
      (skillContent ? `\n\n## Reviewer Instructions\n${skillContent}` : ''),
    ),
    vscode.LanguageModelChatMessage.User(
      `## Commit Message\n${commitMsg}` +
      externalContext +
      `\n\n## Diff\n\`\`\`diff\n${diffForReview}\n\`\`\``,
    ),
  ];

  let fullResponse = '';
  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    stream.markdown(chunk);
    fullResponse += chunk;
  }

  // ─ 5. Parse PASS / FAIL and offer push button ────────────────────────
  const passed = /\[PASS\]/.test(fullResponse);
  const failed = /\[FAIL\]/.test(fullResponse);

  stream.markdown('\n\n---\n');
  if (passed && !failed) {
    stream.markdown('### ✅ Review passed\n');
    stream.button({
      command: 'silver-engineer.pushToGerrit',
      title: '↑ Push to Gerrit',
    });
  } else if (failed) {
    stream.markdown('### ❌ Issues found — fix before pushing\n');
    stream.button({
      command: 'workbench.action.terminal.new',
      title: '🛠 Open Terminal',
    });
  } else {
    stream.markdown('> ⚠️  No `[PASS]` / `[FAIL]` tag found in review. Check the response above manually.\n');
  }

  return { metadata: {} };
}

// ---------------------------------------------------------------------------
// Generic query with context injection (GraphRAG)
// ---------------------------------------------------------------------------

async function handleGenericQuery(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  svc: SilverServices,
): Promise<vscode.ChatResult> {

  const model = await selectModel();
  if (!model) {
    stream.markdown('> ⚠️  No Copilot language model available.');
    return { metadata: {} };
  }

  // Inject KG context relevant to the query
  const [vectorResults, graphContext] = await Promise.all([
    svc.vectors.querySimilar(request.prompt, 5),
    Promise.resolve(svc.graph.buildDailySummaryContext()),
  ]);

  // Resolve matching skills (progressive disclosure)
  const matchedSkills = await svc.skills.findRelevant(request.prompt);
  const skillsContext = matchedSkills
    .map(s => `### Skill: ${s.name}\n${s.fullContent}`)
    .join('\n\n');

  // Build system prompt with all injected context
  const systemContent = buildSystemPrompt(graphContext, vectorResults, skillsContext);

  // Reconstruct the chat history for multi-turn context
  const history = buildHistory(chatContext);

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(systemContent),
    ...history,
    vscode.LanguageModelChatMessage.User(request.prompt),
  ];

  const response = await model.sendRequest(messages, {}, token);
  for await (const chunk of response.text) {
    stream.markdown(chunk);
  }

  // Surface a button to trigger an agentic action if the model suggested one
  stream.button({
    command: 'silver-engineer.openDashboard',
    title: '$(hubot) Open Dashboard',
  });

  return { metadata: { suggestGraph: true } };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  // Prefer gpt-4o, fall back to any available model
  const preferred = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
  if (preferred.length > 0) return preferred[0];

  const any = await vscode.lm.selectChatModels({});
  return any[0];
}

function buildSystemPrompt(
  graphContext: string,
  vectorResults: Array<{ text: string; score: number }>,
  skillsContext: string,
): string {
  const parts = [
    'You are Silver Engineer — a senior AI pair-programmer with persistent local memory.',
    'You have access to a Knowledge Graph that tracks the user\'s tech stack, colleagues, and work patterns.',
    '',
    '## Knowledge Graph Summary',
    graphContext || '(no prior knowledge yet)',
    '',
  ];

  if (vectorResults.length > 0) {
    parts.push('## Semantically Relevant Past Context');
    for (const r of vectorResults) {
      parts.push(`- (score ${r.score.toFixed(2)}) ${r.text}`);
    }
    parts.push('');
  }

  if (skillsContext) {
    parts.push('## Loaded Skills / Workflow Templates');
    parts.push(skillsContext);
    parts.push('');
  }

  parts.push(
    'Always be concise, direct, and actionable.',
    'When suggesting a state-changing action (commit, file edit, Jira update), use the appropriate tool and wait for human confirmation before executing.',
  );

  return parts.join('\n');
}

function buildHistory(chatContext: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];
  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => p.value.value)
        .join('');
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }
  return messages;
}
