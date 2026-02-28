import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import Graph from 'graphology';

// ---------------------------------------------------------------------------
// Node / Edge types
// ---------------------------------------------------------------------------

export type NodeType = 'Person' | 'Technology' | 'Module' | 'Decision' | 'WorkItem';
export type EdgeType = 'WorksWith' | 'ReviewedBy' | 'UsedIn' | 'Contributed' | 'DependsOn' | 'Resolved';

export interface SilverNode {
  type: NodeType;
  label: string;
  weight: number;          // trust / frequency weight 0–1
  metadata: Record<string, unknown>;
  updatedAt: string;       // ISO timestamp
}

export interface SilverEdge {
  type: EdgeType;
  weight: number;
  metadata: Record<string, unknown>;
}

const GRAPH_FILE = 'knowledge-graph.json';
const AUTOSAVE_INTERVAL_MS = 60_000; // autosave every 60 s

// ---------------------------------------------------------------------------

/**
 * GraphStore — in-memory Knowledge Graph using graphology.
 *
 * Persists to `ExtensionContext.globalStorageUri/knowledge-graph.json`.
 * Provides:
 *  - Node/edge CRUD
 *  - Tech-stack scan from workspace files
 *  - Daily summary context builder for LM injection
 *  - Semantic keyword search (light, no vectors)
 */
export class GraphStore implements vscode.Disposable {
  private readonly graph = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });
  private saveTimer: ReturnType<typeof setInterval> | undefined;
  private readonly storagePath: string;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.storagePath = path.join(ctx.globalStorageUri.fsPath, GRAPH_FILE);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await fs.promises.mkdir(this.ctx.globalStorageUri.fsPath, { recursive: true });
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = await fs.promises.readFile(this.storagePath, 'utf8');
        const serialized = JSON.parse(raw) as object;
        this.graph.import(serialized);
        console.log(`[SilverEngineer] Graph loaded: ${this.graph.order} nodes, ${this.graph.size} edges`);
        // Migration: purge legacy auto-seeded nodes (Technology + Person) if
        // no real WorkItem data exists — these were seeded by old versions of
        // scanWorkspace() and carry no useful information.
        this.purgeLegacySeedNodes();
      } catch (err) {
        console.error('[SilverEngineer] Graph load error (will start fresh):', err);
      }
    }

    // Start auto-save timer
    this.saveTimer = setInterval(() => void this.save(), AUTOSAVE_INTERVAL_MS);
  }

  async save(): Promise<void> {
    try {
      await fs.promises.mkdir(this.ctx.globalStorageUri.fsPath, { recursive: true });
      const serialized = JSON.stringify(this.graph.export(), null, 2);
      await fs.promises.writeFile(this.storagePath, serialized, 'utf8');
    } catch (err) {
      console.error('[SilverEngineer] Graph save error:', err);
    }
  }

  async clear(): Promise<void> {
    this.graph.clear();
    await this.save();
  }

  dispose(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    void this.save();
  }

  // ── Node / Edge CRUD ──────────────────────────────────────────────────────

  upsertNode(id: string, attrs: SilverNode): void {
    if (this.graph.hasNode(id)) {
      this.graph.mergeNodeAttributes(id, { ...attrs, updatedAt: new Date().toISOString() });
    } else {
      this.graph.addNode(id, { ...attrs, updatedAt: new Date().toISOString() });
    }
  }

  upsertEdge(source: string, target: string, attrs: SilverEdge): void {
    if (!this.graph.hasNode(source) || !this.graph.hasNode(target)) return;
    if (this.graph.hasEdge(source, target)) {
      // Reinforce weight (trust increase on repeated observation)
      const current = this.graph.getEdgeAttribute(source, target, 'weight') as number ?? 0.5;
      this.graph.setEdgeAttribute(source, target, 'weight', Math.min(1, current + 0.1));
    } else {
      this.graph.addEdge(source, target, attrs);
    }
  }

  reinforceEdge(source: string, target: string, delta = 0.2): void {
    if (!this.graph.hasEdge(source, target)) return;
    const current = this.graph.getEdgeAttribute(source, target, 'weight') as number ?? 0.5;
    this.graph.setEdgeAttribute(source, target, 'weight', Math.min(1, current + delta));
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  findRelated(keyword: string): string[] {
    const kw = keyword.toLowerCase();
    const results: string[] = [];
    this.graph.forEachNode((nodeId, attrs) => {
      const node = attrs as SilverNode;
      if (
        node.label.toLowerCase().includes(kw) ||
        nodeId.toLowerCase().includes(kw)
      ) {
        results.push(`[${node.type}] ${node.label}`);
      }
    });
    return results;
  }

  buildDailySummaryContext(): string {
    if (this.graph.order === 0) return '';

    const lines: string[] = [];

    // List high-weight colleagues
    const colleagues: string[] = [];
    this.graph.forEachNode((_id, attrs) => {
      const node = attrs as SilverNode;
      if (node.type === 'Person' && node.weight > 0.4) {
        colleagues.push(node.label);
      }
    });
    if (colleagues.length) {
      lines.push(`Key colleagues: ${colleagues.slice(0, 5).join(', ')}`);
    }

    // List tech stack
    const tech: string[] = [];
    this.graph.forEachNode((_id, attrs) => {
      const node = attrs as SilverNode;
      if (node.type === 'Technology') {
        tech.push(node.label);
      }
    });
    if (tech.length) {
      lines.push(`Tech stack: ${tech.slice(0, 8).join(', ')}`);
    }

    // Open work items
    const items: string[] = [];
    this.graph.forEachNode((_id, attrs) => {
      const node = attrs as SilverNode;
      if (node.type === 'WorkItem') {
        items.push(node.label);
      }
    });
    if (items.length) {
      lines.push(`Open work items: ${items.slice(0, 5).join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Returns true only when the graph contains actual work items (tickets,
   * tasks, bugs). Tech stack and person nodes alone are NOT actionable data
   * and should not trigger an LLM summary.
   */
  hasActionableData(): boolean {
    let found = false;
    this.graph.forEachNode((_id, attrs) => {
      if ((attrs as SilverNode).type === 'WorkItem') found = true;
    });
    return found;
  }

  /**
   * Removes Technology and Person nodes that were auto-seeded by old versions
   * of scanWorkspace() when no real WorkItem data exists.
   * Safe to call on every load — a no-op if graph is already clean.
   */
  private purgeLegacySeedNodes(): void {
    if (this.hasActionableData()) return; // real data present — don't touch

    const toRemove: string[] = [];
    this.graph.forEachNode((id, attrs) => {
      const type = (attrs as SilverNode).type;
      if (type === 'Technology' || type === 'Person') toRemove.push(id);
    });

    if (toRemove.length > 0) {
      toRemove.forEach(id => this.graph.dropNode(id));
      console.log(`[SilverEngineer] Purged ${toRemove.length} legacy seed node(s) from graph`);
      void this.save();
    }
  }

  /** Export graph data for Webview visualisation */
  exportForVisualisation(): { nodes: unknown[]; edges: unknown[] } {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];

    this.graph.forEachNode((id, attrs) => {
      nodes.push({ id, ...(attrs as SilverNode) });
    });
    this.graph.forEachEdge((id, attrs, source, target) => {
      edges.push({ id, source, target, ...(attrs as SilverEdge) });
    });

    return { nodes, edges };
  }

  // ── Workspace scanning ────────────────────────────────────────────────────

  /**
   * Scans workspace config files to detect tech stack.
   * NOT called automatically — must be explicitly triggered by the user
   * (e.g. via a command), so the graph never gets pre-seeded with defaults.
   */
  async scanWorkspace(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const userId = 'user:current';
    // Only upsert Person node if we actually find something worth tracking
    let foundAny = false;

    for (const folder of folders) {
      const found = await this.scanFolder(folder.uri.fsPath, userId);
      if (found) foundAny = true;
    }

    if (foundAny) {
      // Ensure the Person node exists only when there is real data to link
      this.upsertNode(userId, {
        type: 'Person',
        label: 'You',
        weight: 1,
        metadata: {},
        updatedAt: new Date().toISOString(),
      });
      await this.save();
    }
  }

  private async scanFolder(folderPath: string, userId: string): Promise<boolean> {
    const packageJsonPath  = path.join(folderPath, 'package.json');
    const pomXmlPath       = path.join(folderPath, 'pom.xml');
    const requirementsPath = path.join(folderPath, 'requirements.txt');
    const cargoPath        = path.join(folderPath, 'Cargo.toml');

    let found = false;

    if (fs.existsSync(packageJsonPath)) {
      found = (await this.scanPackageJson(packageJsonPath, userId)) || found;
    }
    if (fs.existsSync(requirementsPath)) {
      this.addTechNode('Python', userId); found = true;
    }
    if (fs.existsSync(pomXmlPath)) {
      this.addTechNode('Java / Maven', userId); found = true;
    }
    if (fs.existsSync(cargoPath)) {
      this.addTechNode('Rust', userId); found = true;
    }

    return found;
  }

  private async scanPackageJson(filePath: string, userId: string): Promise<boolean> {
    try {
      const raw  = await fs.promises.readFile(filePath, 'utf8');
      const pkg  = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      const frameworkMap: Record<string, string> = {
        react: 'React', vue: 'Vue', '@angular/core': 'Angular',
        express: 'Express', fastify: 'Fastify', nestjs: 'NestJS',
        typescript: 'TypeScript', webpack: 'Webpack', vite: 'Vite',
        jest: 'Jest', vitest: 'Vitest',
      };

      // Only add Node.js node if it is a runtime dependency (not just tooling)
      const runtimeDeps = Object.keys(pkg.dependencies ?? {});
      if (runtimeDeps.length > 0) {
        this.addTechNode('Node.js / JavaScript', userId);
      }

      let found = false;
      for (const [dep, label] of Object.entries(frameworkMap)) {
        if (dep in deps) {
          this.addTechNode(label, userId);
          found = true;
        }
      }
      return found;
    } catch {
      return false;
    }
  }

  private addTechNode(name: string, userId: string): void {
    const id = `tech:${name.toLowerCase().replace(/\s+/g, '-')}`;
    this.upsertNode(id, { type: 'Technology', label: name, weight: 0.8, metadata: {}, updatedAt: new Date().toISOString() });
    this.upsertEdge(userId, id, { type: 'UsedIn', weight: 0.8, metadata: {} });
  }
}
