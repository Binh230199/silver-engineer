import * as vscode from 'vscode';
import type { SilverServices } from './types';

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
    // Check if the MCP server is running and Copilot LM is available
    const mcpReady = svc.mcp.isRunning();
    const lmAvailable = await isLmAvailable();

    if (!mcpReady || !lmAvailable) {
      if (forced) {
        vscode.window.showWarningMessage(
          'Silver Engineer: MCP server or Copilot LM not available. Please check your setup.',
        );
      }
      return;
    }

    // Collect context from the graph (colleagues + open tickets)
    const graphContext = svc.graph.buildDailySummaryContext();

    // Build a concise prompt to send to the LM
    const summaryPrompt = buildSummaryPrompt(graphContext);

    // Request a summary from the first available LM model
    const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
    if (!model) {
      return;
    }

    const messages = [
      vscode.LanguageModelChatMessage.User(summaryPrompt),
    ];

    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let summary = '';
    for await (const chunk of response.text) {
      summary += chunk;
    }

    // Truncate for toast display — full text available in Chat
    const short = summary.length > 200 ? summary.slice(0, 197) + '…' : summary;

    const action = await vscode.window.showInformationMessage(
      `🪄 Silver Engineer — ${short}`,
      'Open in Chat',
      'Dismiss',
    );

    if (action === 'Open in Chat') {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: `@silver /summary ${summary}`,
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

function buildSummaryPrompt(graphContext: string): string {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  return [
    `Today is ${today}.`,
    'You are Silver Engineer, a senior AI assistant embedded in VS Code.',
    'Based on the knowledge graph context below, write a concise 2-3 sentence',
    'summary of what the developer likely needs to focus on today.',
    'Focus on actionable work items. Be brief and direct.',
    '',
    '--- Knowledge Graph Context ---',
    graphContext || '(no prior context yet — consider asking the user about their work)',
  ].join('\n');
}
