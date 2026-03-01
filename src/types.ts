/**
 * Shared service container interface — split into its own file to prevent
 * circular imports between extension.ts and toolRegistry.ts.
 */

import type { SecretManager }   from './core/storage/secrets';
import type { GraphStore }      from './core/storage/graph';
import type { VectorStore }     from './core/storage/vectors';
import type { SkillsLoader }    from './core/skills/loader';
import type { ToolRegistry }    from './lm-tools/registry';
import type { ToolDiscovery }   from './core/mcp/discovery';
import type { WorkflowEngine }  from './features/workflow-engine/engine';

export interface SilverServices {
  secrets:   SecretManager;
  graph:     GraphStore;
  vectors:   VectorStore;
  skills:    SkillsLoader;
  tools:     ToolRegistry;
  discovery: ToolDiscovery;
  workflows: WorkflowEngine;
}
