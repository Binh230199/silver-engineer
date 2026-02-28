import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Skill types
// ---------------------------------------------------------------------------

export interface SkillMeta {
  /** Unique key (derived from filename) */
  name: string;
  /** One-line description extracted from the SKILL.md frontmatter or first heading */
  description: string;
  /** Absolute path on disk */
  filePath: string;
  /** source: 'builtin' | 'user' */
  source: 'builtin' | 'user';
}

export interface LoadedSkill extends SkillMeta {
  /** Full markdown body — loaded lazily only when needed */
  fullContent: string;
}

// ---------------------------------------------------------------------------

/**
 * SkillsLoader
 *
 * Implements the "Progressive Disclosure" pattern:
 *   - `listAll()` returns only metadata (cheap).
 *   - `findRelevant(query)` returns full content only for matched skills.
 *   - User skills are loaded from `.vscode/silver-skills/*.md`.
 *   - Built-in skills are bundled inside the extension.
 */
export class SkillsLoader {
  private skills = new Map<string, LoadedSkill>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await this.loadBuiltins();
    await this.loadUserSkills();
    console.log(`[SilverEngineer] Skills loaded: ${this.skills.size}`);
  }

  async reload(): Promise<void> {
    this.skills.clear();
    await this.load();
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  listAll(): SkillMeta[] {
    return [...this.skills.values()].map(({ name, description, filePath, source }) => ({
      name, description, filePath, source,
    }));
  }

  findByName(name: string): LoadedSkill | undefined {
    return this.skills.get(name) ?? this.skills.get(name.toLowerCase());
  }

  /**
   * Returns full content only for skills whose name/description match the query.
   * This "Progressive Disclosure" keeps the LM context window lean.
   */
  async findRelevant(query: string): Promise<LoadedSkill[]> {
    const kw = query.toLowerCase();
    return [...this.skills.values()].filter(s =>
      s.name.toLowerCase().includes(kw) ||
      s.description.toLowerCase().includes(kw),
    );
  }

  // ── Registration (called by FileWatcher) ─────────────────────────────────

  registerUserSkill(filePath: string): void {
    const skill = parseSkillFile(filePath, 'user');
    if (skill) {
      this.skills.set(skill.name, skill);
      console.log(`[SilverEngineer] User skill registered: ${skill.name}`);
    }
  }

  unregisterUserSkill(filePath: string): void {
    const name = skillNameFromPath(filePath);
    this.skills.delete(name);
  }

  // ── Private loaders ───────────────────────────────────────────────────────

  private async loadBuiltins(): Promise<void> {
    // In VSIX builds, templates are copied to dist/skills/templates/
    // In dev (F5 / tsc), fall back to src/core/skills/templates/
    const candidates = [
      path.join(this.ctx.extensionUri.fsPath, 'dist', 'skills', 'templates'),
      path.join(this.ctx.extensionUri.fsPath, 'src', 'core', 'skills', 'templates'),
    ];

    const dir = candidates.find(d => fs.existsSync(d));
    if (!dir) return;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const full = path.join(dir, file);
      const skill = parseSkillFile(full, 'builtin');
      if (skill) this.skills.set(skill.name, skill);
    }
  }

  private async loadUserSkills(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;

    const dir = path.join(wsFolder.uri.fsPath, '.vscode', 'silver-skills');
    if (!fs.existsSync(dir)) return;

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const full = path.join(dir, file);
      const skill = parseSkillFile(full, 'user');
      if (skill) this.skills.set(skill.name, skill);
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseSkillFile(filePath: string, source: 'builtin' | 'user'): LoadedSkill | null {
  try {
    const raw  = fs.readFileSync(filePath, 'utf8');
    const name = skillNameFromPath(filePath);

    // Extract description from first H1 or H2 or description: frontmatter line
    const descMatch =
      raw.match(/^description:\s*(.+)$/im)?.[1]?.trim() ??
      raw.match(/^##?\s+(.+)$/m)?.[1]?.trim() ??
      name;

    return { name, description: descMatch, filePath, source, fullContent: raw };
  } catch {
    return null;
  }
}

function skillNameFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).toLowerCase().replace(/\s+/g, '-');
}
