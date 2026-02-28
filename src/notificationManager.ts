import * as vscode from 'vscode';
import type { SilverServices } from './types';
import { tryInvokeToolFallback, tryInvokeTool } from './mcpTools';

const STATE_KEY = 'silver.lastNotificationDate'; // stored in globalState (NOT secrets)

/**
 * NotificationManager
 *
 * Implements the anti-annoyance "show once per calendar day" contract.
 *
 * Logic:
 *   1. Read lastNotificationDate from globalState.
 *   2. If today's date differs → gather daily digest via MCP → summarise → notify.
 *   3. Update lastNotificationDate so it won't fire again until tomorrow.
 *
 * Notifications use showInformationMessage (corner toast), never modal dialogs.
 */
export class NotificationManager {
  /**
   * Called automatically on startup.
   * Resolves quickly: it only triggers heavy work if today is a new day.
   */
  static async maybeShowDailySummary(
    ctx: vscode.ExtensionContext,
    svc: SilverServices,
  ): Promise<void> {
    const today = todayKey();
    const last  = ctx.globalState.get<string>(STATE_KEY);

    if (last === today) {
      return; // Already shown today — do nothing
    }

    // Mark BEFORE fetching so that a crash/reload doesn't re-trigger
    await ctx.globalState.update(STATE_KEY, today);

    // Fetch and summarise (best-effort — errors are swallowed)
    try {
      await NotificationManager.runSummary(ctx, svc, false);
    } catch (err) {
      console.error('[SilverEngineer] Daily summary error:', err);
    }
  }

  /**
   * Explicitly triggered by the "Show Today's Summary" command.
   * Always runs regardless of lastNotificationDate.
   */
  static async forceSummary(
    ctx: vscode.ExtensionContext,
    svc: SilverServices,
  ): Promise<void> {
    try {
      await NotificationManager.runSummary(ctx, svc, true);
    } catch (err) {
      vscode.window.showErrorMessage(`Silver Engineer: summary failed — ${(err as Error).message}`);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private static async runSummary(
    _ctx: vscode.ExtensionContext,
    svc: SilverServices,
    forced: boolean,
  ): Promise<void> {
    const lmAvailable = await isLmAvailable();
    if (!lmAvailable) {
      if (forced) {
        vscode.window.showWarningMessage(
          'Silver Engineer: Copilot LM not available. Please check your setup.',
        );
      }
      return;
    }

    const token = new vscode.CancellationTokenSource().token;

    // ── Fetch live data from external MCP tools (best-effort) ─────────────
    //
    // We call tools BY NAME only. We never manage MCP servers.
    // If the tool is registered (user has configured mcp.json) → we get data.
    // If not → that section is silently skipped.
    const [jiraData, coverityData, gerritData] = await Promise.all([
      // Jira: open issues assigned to current user
      tryInvokeToolFallback([
        { name: 'jira_search_issues',   input: { jql: 'assignee = currentUser() AND status != Done AND updated >= -1d ORDER BY updated DESC', maxResults: 10 } },
        { name: 'jira_get_my_issues',   input: { status: 'open' } },
        { name: 'jira_list_issues',     input: { assignee: 'me', resolved: false } },
      ], token),

      // Coverity: new static analysis defects since yesterday
      tryInvokeToolFallback([
        { name: 'coverity_get_defects',      input: { status: 'new', since: yesterdayIso() } },
        { name: 'coverity_list_issues',      input: { filter: 'new' } },
        { name: 'get_coverity_issues',       input: { newOnly: true } },
      ], token),

      // Gerrit: open changes waiting for review
      tryInvokeToolFallback([
        { name: 'gerrit_list_changes',       input: { q: 'is:open reviewer:self', limit: 10 } },
        { name: 'gerrit_get_pending_review', input: {} },
        { name: 'list_gerrit_changes',       input: { status: 'open' } },
      ], token),
    ]);

    // Also pull Confluence notifications if available (non-blocking)
    const confluenceData = await tryInvokeTool('confluence_get_notifications', { limit: 5 }, token)
      ?? await tryInvokeTool('confluence_list_tasks', { assignee: 'me', complete: false }, token);

    // ── Build LLM prompt with all available context ────────────────────────
    const graphContext = svc.graph.buildDailySummaryContext();
    const summaryPrompt = buildSummaryPrompt(
      graphContext, jiraData, coverityData, gerritData, confluenceData,
    );

    const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
    if (!model) return;

    const messages = [vscode.LanguageModelChatMessage.User(summaryPrompt)];
    const response = await model.sendRequest(messages, {}, token);

    let summary = '';
    for await (const chunk of response.text) {
      summary += chunk;
    }

    const short = summary.length > 200 ? summary.slice(0, 197) + '…' : summary;

    const action = await vscode.window.showInformationMessage(
      `🪄 Silver Engineer — ${short}`,
      'Open in Chat',
      'Dismiss',
    );

    if (action === 'Open in Chat') {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@silver /summary`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

async function isLmAvailable(): Promise<boolean> {
  try {
    const models = await vscode.lm.selectChatModels({});
    return models.length > 0;
  } catch {
    return false;
  }
}

function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function buildSummaryPrompt(
  graphContext: string,
  jiraData?: string,
  coverityData?: string,
  gerritData?: string,
  confluenceData?: string,
): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const parts = [
    `Today is ${today}.`,
    'You are Silver Engineer, a senior AI assistant embedded in VS Code.',
    'Write a concise morning briefing (3-5 bullet points max).',
    'Mention specific counts and IDs where available. Be direct and actionable.',
    '',
  ];

  parts.push('--- Knowledge Graph ---');
  parts.push(graphContext || '(no prior context)');
  parts.push('');

  if (jiraData) {
    parts.push('--- Jira (open tickets) ---');
    parts.push(jiraData);
    parts.push('');
  }
  if (coverityData) {
    parts.push('--- Coverity (new static defects) ---');
    parts.push(coverityData);
    parts.push('');
  }
  if (gerritData) {
    parts.push('--- Gerrit (pending review) ---');
    parts.push(gerritData);
    parts.push('');
  }
  if (confluenceData) {
    parts.push('--- Confluence (tasks/notifications) ---');
    parts.push(confluenceData);
    parts.push('');
  }

  if (!jiraData && !coverityData && !gerritData && !confluenceData) {
    parts.push('(No external MCP tools available — summary based on local knowledge graph only)');
  }

  return parts.join('\n');
}
