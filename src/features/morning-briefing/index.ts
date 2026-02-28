import * as vscode from 'vscode';
import type { SilverServices } from '../../types';

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
    const { discovery } = svc;

    // ── Fetch live data via ToolDiscovery (best-effort, all parallel) ──────
    //
    // ToolDiscovery scans vscode.lm.tools and matches tools by keyword scoring
    // — no hardcoded tool names. Works with any MCP server.
    const [jiraData, coverityData, gerritData, confluenceData] = await Promise.all([
      discovery.invoke('JIRA_MY_ISSUES',          { jql: 'assignee = currentUser() AND status != Done AND updated >= -1d', maxResults: 10 }, token),
      discovery.invoke('COVERITY_DEFECTS',         { status: 'new', since: yesterdayIso() }, token),
      discovery.invoke('GERRIT_PENDING',           { q: 'is:open reviewer:self', limit: 10 }, token),
      discovery.invoke('CONFLUENCE_NOTIFICATIONS', { limit: 5 }, token),
    ]);

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
// Exported — reused by chat /summary command
// ---------------------------------------------------------------------------

export interface DailyContext {
  prompt: string;
  hasLiveData: boolean;
}

/**
 * Gathers daily context from MCP tools + Knowledge Graph.
 * Used by both the startup toast and the @silver /summary chat command.
 */
export async function gatherDailyContext(
  svc: SilverServices,
  token: vscode.CancellationToken,
): Promise<DailyContext> {
  const { discovery } = svc;

  const [jiraData, coverityData, gerritData, confluenceData] = await Promise.all([
    discovery.invoke('JIRA_MY_ISSUES',          { jql: 'assignee = currentUser() AND status != Done AND updated >= -1d', maxResults: 10 }, token),
    discovery.invoke('COVERITY_DEFECTS',         { status: 'new', since: yesterdayIso() }, token),
    discovery.invoke('GERRIT_PENDING',           { q: 'is:open reviewer:self', limit: 10 }, token),
    discovery.invoke('CONFLUENCE_NOTIFICATIONS', { limit: 5 }, token),
  ]);

  const graphContext = svc.graph.buildDailySummaryContext();
  const hasLiveData  = !!(jiraData || coverityData || gerritData || confluenceData);
  const prompt       = buildSummaryPrompt(graphContext, jiraData, coverityData, gerritData, confluenceData);

  return { prompt, hasLiveData };
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
    'Write a concise morning briefing (3-5 bullet points max) based ONLY on the data provided below.',
    'Do NOT invent tasks, issues, or recommendations that are not in the data.',
    'If a section is empty or says "(no prior context)", skip it entirely.',
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
