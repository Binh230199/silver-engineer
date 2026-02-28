import * as vscode from 'vscode';

/**
 * Try to invoke any registered LM tool (MCP or extension) by name.
 *
 * Returns the text content of the result, or undefined if:
 *   - the API is not available (VS Code < 1.93)
 *   - the tool is not registered (user hasn't set up that MCP server)
 *   - the invocation fails for any reason
 *
 * This is the ONLY way silver-engineer touches external MCP tools.
 * The extension never manages MCP servers — users configure their own
 * servers (C++ binaries, SaaS SDKs, .vscode/mcp.json) independently.
 * We just call by name and gracefully skip if unavailable.
 */
export async function tryInvokeTool(
  toolName: string,
  input: Record<string, unknown>,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  const invokeFn = (vscode.lm as Record<string, unknown>)['invokeTool'] as
    | ((
        name: string,
        opts: { input: Record<string, unknown> },
        token: vscode.CancellationToken,
      ) => Thenable<{ content: Array<{ value?: string }> }>)
    | undefined;

  if (typeof invokeFn !== 'function') return undefined;

  try {
    const result = await invokeFn(toolName, { input }, token);
    return result?.content?.map(c => c.value ?? '').join('\n').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Try a list of tool name candidates in order, return first success.
 * Useful when different MCP server implementations use different names
 * for the same logical operation.
 */
export async function tryInvokeToolFallback(
  candidates: Array<{ name: string; input: Record<string, unknown> }>,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  for (const { name, input } of candidates) {
    const result = await tryInvokeTool(name, input, token);
    if (result) return result;
  }
  return undefined;
}

/**
 * Extract a Jira-style ticket ID from a string (commit message, branch name, etc.)
 * Matches patterns like RRRSE-3050, ABC-123, JIRA-1.
 */
export function extractTicketId(text: string): string | undefined {
  const m = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m?.[1];
}
