import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { SilverServices } from '../types';

const VIEW_TYPE  = 'silver-engineer.dashboard';
const VIEW_TITLE = 'Silver Engineer';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openChat';    query: string }
  | { type: 'runCommand';  command: string; args?: unknown[] }
  | { type: 'requestGraph' }
  | { type: 'confirmEdge'; source: string; target: string; confirmed: boolean };

/**
 * DashboardPanel
 *
 * Hosts the Webview panel for Knowledge Graph visualisation and workflow management.
 *
 * Architecture:
 *   Extension Host ←→ postMessage bridge ←→ Webview (dist/webview.js)
 *
 * The Webview JS (entry.ts → webview.js) drives the UI.
 * All VS Code API calls route back through executeCommand / postMessage.
 */
export class DashboardPanel implements vscode.Disposable {
  private static instance: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  // ── Factory ───────────────────────────────────────────────────────────────

  static createOrShow(
    ctx: vscode.ExtensionContext,
    svc: SilverServices,
  ): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    DashboardPanel.instance = new DashboardPanel(ctx, svc);
  }

  // ── Constructor ───────────────────────────────────────────────────────────

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly svc: SilverServices,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      VIEW_TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(ctx.extensionUri, 'dist'),
          vscode.Uri.joinPath(ctx.extensionUri, 'assets'),
        ],
        retainContextWhenHidden: true,
      },
    );

    this.panel.iconPath = new vscode.ThemeIcon('hubot');
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    // Receive messages from the Webview
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(
        (msg: WebviewMessage) => void this.handleMessage(msg),
      ),
    );

    // Clean up on panel close
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  // ── Message bridge ────────────────────────────────────────────────────────

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Push initial graph data to the Webview
        await this.sendGraphData();
        break;

      case 'openChat':
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: msg.query,
        });
        break;

      case 'runCommand':
        await vscode.commands.executeCommand(msg.command, ...(msg.args ?? []));
        break;

      case 'requestGraph':
        await this.sendGraphData();
        break;

      case 'confirmEdge':
        // User confirmed a suggested relationship → reinforce edge weight
        if (msg.confirmed) {
          this.svc.graph.reinforceEdge(msg.source, msg.target, 0.3);
        }
        break;
    }
  }

  private async sendGraphData(): Promise<void> {
    const data = this.svc.graph.exportForVisualisation();
    await this.panel.webview.postMessage({ type: 'graphData', payload: data });
  }

  // ── HTML generation ───────────────────────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const webviewJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'),
    );

    const nonce = generateNonce();

    // Read from template file or fall back to inline
    const templatePath = path.join(this.ctx.extensionUri.fsPath, 'src', 'webview', 'index.html');
    if (fs.existsSync(templatePath)) {
      return fs.readFileSync(templatePath, 'utf8')
        .replace('{{nonce}}', nonce)
        .replace('{{cspSource}}', webview.cspSource)
        .replace('{{webviewJsUri}}', webviewJsUri.toString());
    }

    // Inline fallback (used when bundled)
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' ${webview.cspSource};
             style-src ${webview.cspSource} 'unsafe-inline';
             img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Silver Engineer</title>
  <style>
    body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
    #app { padding: 16px; }
    h1 { font-size: 1.2em; font-weight: 600; }
    #graph-container { width: 100%; height: 420px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
    .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 6px 14px; cursor: pointer; margin: 4px 4px 4px 0; font-size: 0.85em; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .stats { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  </style>
</head>
<body>
  <div id="app">
    <h1>🪄 Silver Engineer — Knowledge Graph</h1>
    <div class="stats" id="stats">Loading graph…</div>
    <div id="graph-container">
      <canvas id="graph-canvas" style="width:100%;height:100%;"></canvas>
    </div>
    <br>
    <button class="btn" id="btn-summary">📋 Daily Summary</button>
    <button class="btn" id="btn-skills">🛠️ Skills</button>
    <button class="btn" id="btn-refresh">🔄 Refresh</button>
  </div>
  <script nonce="${nonce}" src="${webviewJsUri}"></script>
</body>
</html>`;
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    DashboardPanel.instance = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// ---------------------------------------------------------------------------
// Sidebar WebviewViewProvider
// ---------------------------------------------------------------------------

/**
 * SilverDashboardViewProvider
 *
 * Implements vscode.WebviewViewProvider so the "SILVER ENGINEER: DASHBOARD"
 * sidebar panel actually renders content.
 *
 * This is the correct API for views declared as { "type": "webview" } in
 * package.json contributes.views. DashboardPanel (above) still handles the
 * standalone panel opened by the openDashboard command.
 */
export class SilverDashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'silver-engineer.dashboard';

  private _view: vscode.WebviewView | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly svc: SilverServices,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.ctx.extensionUri, 'assets'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => void this.handleMessage(msg),
    );

    // Push graph data whenever the view becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.sendGraphData();
    });
  }

  // ── same handlers as DashboardPanel ──────────────────────────────────────

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':           await this.sendGraphData(); break;
      case 'requestGraph':    await this.sendGraphData(); break;
      case 'openChat':
        await vscode.commands.executeCommand('workbench.action.chat.open', { query: msg.query });
        break;
      case 'runCommand':
        await vscode.commands.executeCommand(msg.command, ...(msg.args ?? []));
        break;
      case 'confirmEdge':
        if (msg.confirmed) this.svc.graph.reinforceEdge(msg.source, msg.target, 0.3);
        break;
    }
  }

  private async sendGraphData(): Promise<void> {
    if (!this._view) return;
    const data = this.svc.graph.exportForVisualisation();
    await this._view.webview.postMessage({ type: 'graphData', payload: data });
  }

  private buildHtml(webview: vscode.Webview): string {
    const webviewJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'),
    );
    const nonce = generateNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' ${webview.cspSource};
             style-src ${webview.cspSource} 'unsafe-inline';
             img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Silver Engineer</title>
  <style>
    body { margin:0; padding:0; background:var(--vscode-sideBar-background); color:var(--vscode-foreground); font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); }
    #app { padding:12px; }
    h2 { font-size:1em; font-weight:600; margin:0 0 8px; }
    #graph-container { width:100%; height:300px; border:1px solid var(--vscode-panel-border); border-radius:4px; overflow:hidden; }
    .btn { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:3px; padding:5px 12px; cursor:pointer; margin:4px 4px 4px 0; font-size:0.82em; }
    .btn:hover { background:var(--vscode-button-hoverBackground); }
    .stats { font-size:0.78em; color:var(--vscode-descriptionForeground); margin:6px 0; }
  </style>
</head>
<body>
  <div id="app">
    <h2>🪄 Knowledge Graph</h2>
    <div class="stats" id="stats">Loading…</div>
    <div id="graph-container">
      <canvas id="graph-canvas" style="width:100%;height:100%;"></canvas>
    </div>
    <br>
    <button class="btn" id="btn-summary">📋 Summary</button>
    <button class="btn" id="btn-skills">🛠️ Skills</button>
    <button class="btn" id="btn-refresh">🔄 Refresh</button>
  </div>
  <script nonce="${nonce}" src="${webviewJsUri}"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
