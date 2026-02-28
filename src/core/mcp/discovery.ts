import * as vscode from 'vscode';
import { tryInvokeTool } from './tools';

// ---------------------------------------------------------------------------
// Intent definitions
// ---------------------------------------------------------------------------
// Each intent describes a logical operation we want to perform.
// `keywords` is an array of OR-groups: every group must have at least one
// match in the tool's name+description for the tool to qualify.
//
// Example: JIRA_MY_ISSUES requires:
//   - at least one of ["jira", "atlassian"] AND
//   - at least one of ["issue", "ticket", "task", "bug"] AND
//   - at least one of ["list", "search", "get", "my", "assigned"]
//
// This reliably matches:
//   "jira_search_issues", "get_my_jira_tickets", "list_atlassian_tasks", etc.
// ---------------------------------------------------------------------------

export type IntentKey =
  | 'JIRA_MY_ISSUES'
  | 'JIRA_GET_ISSUE'
  | 'COVERITY_DEFECTS'
  | 'GERRIT_PENDING'
  | 'GERRIT_PUSH'
  | 'CONFLUENCE_NOTIFICATIONS';

interface IntentDefinition {
  /** Human-readable description of what we want (used as fallback LLM hint) */
  description: string;
  /** AND-of-OR keyword groups matched against name + description (lowercased) */
  keywords: string[][];
  /** Minimum score threshold (number of groups matched) — default: all groups */
  minScore?: number;
}

const INTENTS: Record<IntentKey, IntentDefinition> = {
  JIRA_MY_ISSUES: {
    description: 'List open Jira issues/tickets assigned to me',
    keywords: [
      ['jira', 'atlassian'],
      ['issue', 'ticket', 'task', 'story', 'bug'],
      ['list', 'search', 'get', 'my', 'assigned', 'find', 'query'],
    ],
  },
  JIRA_GET_ISSUE: {
    description: 'Get details of a specific Jira issue by key',
    keywords: [
      ['jira', 'atlassian'],
      ['issue', 'ticket', 'get', 'read', 'fetch', 'detail'],
    ],
    minScore: 2,
  },
  COVERITY_DEFECTS: {
    description: 'List new Coverity static analysis defects',
    keywords: [
      ['coverity', 'static', 'defect', 'analysis', 'sast'],
      ['list', 'get', 'find', 'issue', 'defect', 'violation', 'error'],
    ],
    minScore: 1,
  },
  GERRIT_PENDING: {
    description: 'List Gerrit code review changes pending my review',
    keywords: [
      ['gerrit', 'review', 'changelist', 'change'],
      ['list', 'get', 'pending', 'open', 'incoming', 'find'],
    ],
    minScore: 1,
  },
  GERRIT_PUSH: {
    description: 'Push a commit to Gerrit for code review',
    keywords: [
      ['gerrit'],
      ['push', 'submit', 'upload', 'send'],
    ],
  },
  CONFLUENCE_NOTIFICATIONS: {
    description: 'List Confluence tasks or notifications',
    keywords: [
      ['confluence', 'wiki', 'atlassian'],
      ['notification', 'task', 'mention', 'watch', 'list', 'get'],
    ],
    minScore: 1,
  },
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreToolForIntent(
  tool: vscode.LanguageModelToolInformation,
  intent: IntentDefinition,
): number {
  const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase().replace(/[_\-\.]/g, ' ');
  let score = 0;
  for (const group of intent.keywords) {
    if (group.some(kw => haystack.includes(kw))) {
      score++;
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// ToolDiscovery
// ---------------------------------------------------------------------------

export interface DiscoveredTool {
  name: string;
  description: string;
  score: number;
}

/**
 * ToolDiscovery scans vscode.lm.tools at runtime and matches available tools
 * to logical intents using keyword scoring.
 *
 * This means the extension works with ANY MCP server — official, community,
 * or custom C++ binaries — without hardcoding tool names.
 */
export class ToolDiscovery {
  private cache: Map<IntentKey, DiscoveredTool | null> = new Map();

  /**
   * Clear the discovery cache (call after MCP server reconnect / reload).
   */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Find the best-matching registered tool for a given intent.
   * Returns undefined if no tool scores above the threshold.
   *
   * Results are cached in-process (mcp.json rarely changes mid-session).
   */
  findToolForIntent(intent: IntentKey): DiscoveredTool | undefined {
    if (this.cache.has(intent)) {
      return this.cache.get(intent) ?? undefined;
    }

    const def = INTENTS[intent];
    const threshold = def.minScore ?? def.keywords.length; // all groups must match by default

    // vscode.lm.tools is a readonly array available from VS Code 1.90+
    const allTools = (vscode.lm as Record<string, unknown>)['tools'] as
      vscode.LanguageModelToolInformation[] | undefined;

    if (!allTools || allTools.length === 0) {
      this.cache.set(intent, null);
      return undefined;
    }

    let best: DiscoveredTool | undefined;
    for (const tool of allTools) {
      const score = scoreToolForIntent(tool, def);
      if (score >= threshold && (!best || score > best.score)) {
        best = { name: tool.name, description: tool.description ?? '', score };
      }
    }

    this.cache.set(intent, best ?? null);
    return best;
  }

  /**
   * Invoke the best tool for an intent, or return undefined if none found.
   * Logs which tool was selected (useful for debugging).
   */
  async invoke(
    intent: IntentKey,
    input: Record<string, unknown>,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    const tool = this.findToolForIntent(intent);
    if (!tool) return undefined;

    console.log(`[SilverEngineer] ToolDiscovery: ${intent} → "${tool.name}" (score ${tool.score})`);
    return tryInvokeTool(tool.name, input, token);
  }

  /**
   * List all discovered tools grouped by intent (for diagnostics / @silver /skills).
   */
  diagnose(): Record<string, { tool: string; score: number } | 'not found'> {
    const result: Record<string, { tool: string; score: number } | 'not found'> = {};
    for (const key of Object.keys(INTENTS) as IntentKey[]) {
      const found = this.findToolForIntent(key);
      result[key] = found ? { tool: found.name, score: found.score } : 'not found';
    }
    return result;
  }
}
