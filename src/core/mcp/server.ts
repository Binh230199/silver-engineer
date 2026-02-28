import * as vscode from 'vscode';
import * as http from 'http';
import * as net from 'net';
import type { SecretManager } from '../storage/secrets';

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * McpServerManager
 *
 * Runs a lightweight MCP-compatible Streamable HTTP server on a dynamically
 * allocated localhost port.  The server is embedded directly in the Extension
 * Host process — no child processes, no external runtime required.
 *
 * After startup it:
 *   1. Finds a free port.
 *   2. Starts the HTTP server.
 *   3. Registers itself with VS Code via vscode.lm.registerMcpServerDefinitionProvider
 *      (when that API is available).
 *   4. Falls back to writing the URL to the workspace settings mcp.servers key.
 */
/**
 * Callback injected by ToolRegistry after both services are created.
 * Decouples MCP ↔ ToolRegistry without a circular import.
 *
 * Returns: the tool output string, or undefined if the user cancelled.
 */
export type ToolInvoker = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string | undefined>;

export class McpServerManager {
  private server: http.Server | undefined;
  private _port: number | undefined;
  private readonly tools: Map<string, McpToolDefinition> = new Map();
  private toolInvoker: ToolInvoker | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    _secrets: SecretManager,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.server) return; // Already running

    const preferredPort = vscode.workspace
      .getConfiguration('silverEngineer')
      .get<number>('mcpPort', 0);

    this._port = await findFreePort(preferredPort);
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this._port, '127.0.0.1', () => resolve());
      this.server!.on('error', reject);
    });

    console.log(`[SilverEngineer] MCP server running on http://127.0.0.1:${this._port}`);

    // Register with VS Code LM if API is available
    this.registerWithVSCode();

    // Also write to mcp.servers as a fallback for older Copilot versions
    await this.patchMcpSettings();
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this._port = undefined;
  }

  isRunning(): boolean {
    return !!this.server && !!this._port;
  }

  get port(): number | undefined {
    return this._port;
  }

  get baseUrl(): string | undefined {
    return this._port ? `http://127.0.0.1:${this._port}` : undefined;
  }

  // ── Tool registration (from ToolRegistry) ────────────────────────────────

  registerTool(tool: McpToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Wire the HITL invoker provided by ToolRegistry.
   * Called from extension.ts after both services are initialised.
   */
  setToolInvoker(fn: ToolInvoker): void {
    this.toolInvoker = fn;
  }

  // ── HTTP handler (MCP JSON-RPC over HTTP) ────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS (loopback only — safe)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      void this.processJsonRpc(body, res);
    });
  }

  private async processJsonRpc(
    body: string,
    res: http.ServerResponse,
  ): Promise<void> {
    let rpcReq: McpRequest;
    try {
      rpcReq = JSON.parse(body) as McpRequest;
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const response = await this.dispatch(rpcReq);
    res.writeHead(200);
    res.end(JSON.stringify(response));
  }

  private async dispatch(req: McpRequest): Promise<McpResponse> {
    switch (req.method) {
      case 'initialize':
        return this.ok(req.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'SilverEngineerMCP', version: '0.1.0' },
          capabilities: { tools: {} },
        });

      case 'tools/list':
        return this.ok(req.id, {
          tools: [...this.tools.values()].map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case 'tools/call': {
        const params = req.params as { name: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) {
          return this.err(req.id, -32602, 'Missing tool name');
        }
        return this.callTool(req.id, params.name, params.arguments ?? {});
      }

      case 'resources/list':
        return this.ok(req.id, { resources: [] });

      case 'prompts/list':
        return this.ok(req.id, { prompts: [] });

      default:
        return this.err(req.id, -32601, `Method not found: ${req.method}`);
    }
  }

  private async callTool(
    id: string | number,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpResponse> {
    if (!this.tools.has(toolName)) {
      return this.err(id, -32602, `Unknown tool: '${toolName}'`);
    }

    if (!this.toolInvoker) {
      // No invoker wired yet (startup race) — inform caller
      return this.ok(id, {
        content: [{ type: 'text', text: `Tool '${toolName}' is not ready yet. Please retry in a moment.` }],
        isError: true,
      });
    }

    try {
      const output = await this.toolInvoker(toolName, args);

      if (output === undefined) {
        // User cancelled the HITL confirmation dialog
        return this.ok(id, {
          content: [{ type: 'text', text: `Action cancelled by user.` }],
          isError: false,
        });
      }

      return this.ok(id, {
        content: [{ type: 'text', text: output }],
        isError: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.err(id, -32603, `Tool execution error: ${msg}`);
    }
  }

  // ── VS Code integration ───────────────────────────────────────────────────

  private registerWithVSCode(): void {
    // Use the MCP provider API when available (VS Code 1.99+)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lm = vscode.lm as any;
    if (typeof lm?.registerMcpServerDefinitionProvider === 'function') {
      const disposable = lm.registerMcpServerDefinitionProvider(
        'silver-engineer.mcp',
        {
          provideMcpServerDefinitions: () => [{
            name: 'Silver Engineer',
            url: this.baseUrl!,
            version: '2024-11-05',
          }],
        },
      );
      this.ctx.subscriptions.push(disposable);
    }
  }

  private async patchMcpSettings(): Promise<void> {
    if (!this._port) return;
    try {
      const config = vscode.workspace.getConfiguration();
      const existing = config.get<Record<string, unknown>>('mcp.servers', {});
      await config.update(
        'mcp.servers',
        {
          ...existing,
          'silver-engineer': { url: `http://127.0.0.1:${this._port}` },
        },
        vscode.ConfigurationTarget.Global,
      );
    } catch {
      // mcp.servers may not exist on older VS Code — safe to ignore
    }
  }

  // ── JSON-RPC helpers ─────────────────────────────────────────────────────

  private ok(id: string | number, result: unknown): McpResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private err(id: string | number, code: number, message: string): McpResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

// ---------------------------------------------------------------------------
// Port utilities
// ---------------------------------------------------------------------------

function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', () => {
      // Preferred port taken — ask OS for one
      const fallback = net.createServer();
      fallback.listen(0, '127.0.0.1', () => {
        const addr = fallback.address() as net.AddressInfo;
        fallback.close(() => resolve(addr.port));
      });
      fallback.on('error', reject);
    });
  });
}
