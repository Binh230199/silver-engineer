import * as vscode from 'vscode';
import { SecretManager } from './core/storage/secrets';
import { GraphStore } from './core/storage/graph';
import { VectorStore } from './core/storage/vectors';
import { SkillsLoader } from './core/skills/loader';
import { FileWatcher } from './core/watcher';
import { registerChatParticipant } from './chat/participant';
import { McpServerManager } from './core/mcp/server';
import { ToolRegistry } from './lm-tools/registry';
import { NotificationManager } from './features/morning-briefing';
import { DashboardPanel, SilverDashboardViewProvider } from './webview/panel';
import { ToolDiscovery } from './core/mcp/discovery';
import type { SilverServices } from './types';

export type { SilverServices };

let services: SilverServices | undefined;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Initialise core services (synchronous / fast) ──────────────────────
  const secrets = new SecretManager(context);
  const graph   = new GraphStore(context);
  const vectors = new VectorStore(context);
  const skills  = new SkillsLoader(context);
  const mcp     = new McpServerManager(context, secrets);

  // Build partial services first so ToolRegistry can hold a reference;
  // the tools property is filled in immediately after.
  const discovery = new ToolDiscovery();
  const partial = { secrets, graph, vectors, skills, mcp, discovery } as SilverServices;
  const tools   = new ToolRegistry(context, partial);
  partial.tools  = tools;
  services = partial;

  // ── Register Chat Participant (@silver) ─────────────────────────────────
  registerChatParticipant(context, services);

  // ── Register LM tools (HITL) ────────────────────────────────────────────
  tools.registerAll();

  // ── Wire MCP server → ToolRegistry HITL invoker ─────────────────────────
  // The MCP server receives tool/call JSON-RPC requests from Copilot and
  // forwards them through the ToolRegistry confirmation dialog before execution.
  mcp.setToolInvoker(async (toolName, args) => {
    const result = await tools.invokeWithConfirmation(toolName, args);
    return result?.output;   // undefined = cancelled; string = success/failure message
  });

  // ── Sidebar webview view provider (fills the Dashboard sidebar panel) ───
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SilverDashboardViewProvider.VIEW_ID,
      new SilverDashboardViewProvider(context, services),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── VS Code commands ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('silver-engineer.openDashboard', () => {
      DashboardPanel.createOrShow(context, services!);
    }),
    vscode.commands.registerCommand('silver-engineer.reloadSkills', async () => {
      await skills.reload();
      vscode.window.showInformationMessage('Silver Engineer: Skills reloaded.');
    }),
    vscode.commands.registerCommand('silver-engineer.showSummary', async () => {
      await NotificationManager.forceSummary(context, services!);
    }),
    vscode.commands.registerCommand('silver-engineer.clearMemory', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Clear ALL Silver Engineer local memory (knowledge graph + vectors)?',
        { modal: true },
        'Yes, clear it',
      );
      if (confirm === 'Yes, clear it') {
        await graph.clear();
        await vectors.clear();
        vscode.window.showInformationMessage('Silver Engineer: Local memory cleared.');
      }
    }),
    vscode.commands.registerCommand('silver-engineer.configureSecrets', async () => {
      await secrets.promptAll();
    }),
    vscode.commands.registerCommand('silver-engineer.pushToGerrit', async () => {
      const config = vscode.workspace.getConfiguration('silverEngineer');
      const branch = config.get<string>('gerritTargetBranch', 'main');
      const result = await services!.tools.invokeWithConfirmation('silver_push_gerrit', { branch });
      if (result?.success) {
        vscode.window.showInformationMessage(`Silver Engineer: ${result.output}`);
      }
    }),
  );

  // ── Background startup tasks (non-blocking) ─────────────────────────────
  // These run after activation returns — no await — keeping startup fast.
  void runBackgroundStartup(context, services);
}

export function deactivate(): void {
  // Clean up MCP server on deactivation
  services?.mcp.stop();
}

// ---------------------------------------------------------------------------
// Background startup (runs post-activation, non-blocking)
// ---------------------------------------------------------------------------

async function runBackgroundStartup(
  context: vscode.ExtensionContext,
  svc: SilverServices,
): Promise<void> {
  try {
    // 1. Restore persisted knowledge graph and vector store
    await svc.graph.load();
    await svc.vectors.load();

    // 2. Load built-in + user-defined skills
    await svc.skills.load();

    // 3. Start embedded MCP server
    await svc.mcp.start();

    // 4. Start File Watcher for .vscode/silver-skills/
    const watcher = new FileWatcher(context, svc.skills);
    await watcher.start();
    context.subscriptions.push(watcher);

    // 5. Scan workspace for tech-stack data to seed the graph
    void svc.graph.scanWorkspace();

    // 6. Daily summary notification (respects lastNotificationDate guard)
    const config = vscode.workspace.getConfiguration('silverEngineer');
    if (config.get<boolean>('enableDailySummary', true)) {
      await NotificationManager.maybeShowDailySummary(context, svc);
    }
  } catch (err) {
    // Background failures must never crash the extension host
    console.error('[SilverEngineer] Background startup error:', err);
  }
}
