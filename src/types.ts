/**
 * Shared service container interface — split into its own file to prevent
 * circular imports between extension.ts and toolRegistry.ts.
 */

import type { SecretManager }   from './secretManager';
import type { GraphStore }      from './graphStore';
import type { VectorStore }     from './vectorStore';
import type { SkillsLoader }    from './skills/loader';
import type { McpServerManager } from './mcpServer';
import type { ToolRegistry }    from './toolRegistry';
import type { ToolDiscovery }   from './toolDiscovery';

export interface SilverServices {
  secrets:   SecretManager;
  graph:     GraphStore;
  vectors:   VectorStore;
  skills:    SkillsLoader;
  mcp:       McpServerManager;
  tools:     ToolRegistry;
  discovery: ToolDiscovery;
}
