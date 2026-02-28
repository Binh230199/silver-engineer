import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LocalIndex, type  MetadataTypes } from 'vectra';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorEntry {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SimilarResult {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, MetadataTypes>;
}

const INDEX_DIR = 'vector-index';
const EMBED_DIM  = 384; // matches all-MiniLM-L6-v2 and typical small embedding dims

// ---------------------------------------------------------------------------

/**
 * VectorStore — semantic memory for Silver Engineer.
 *
 * Uses `vectra` (pure JS, file-backed) as the default backend.
 * No native binaries — zero cross-compile risk.
 *
 * NOTE: Production upgrade path → swap the embedding call in `embed()` for
 * ruvector's WASM ONNX runtime once the package reaches stable status.
 *
 * Embedding strategy:
 *   - If GitHub Copilot LM is available: use `vscode.lm.computeEmbeddings` (preferred).
 *   - Fallback: lightweight TF-IDF bag-of-words vector approximation (offline, deterministic).
 */
export class VectorStore implements vscode.Disposable {
  private index: LocalIndex | undefined;
  private readonly indexDir: string;

  constructor(ctx: vscode.ExtensionContext) {
    this.indexDir = path.join(ctx.globalStorageUri.fsPath, INDEX_DIR);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await fs.promises.mkdir(this.indexDir, { recursive: true });
    this.index = new LocalIndex(this.indexDir);
    if (!await this.index.isIndexCreated()) {
      await this.index.createIndex();
    }
    console.log('[SilverEngineer] Vector store ready at', this.indexDir);
  }

  async clear(): Promise<void> {
    if (this.index && await this.index.isIndexCreated()) {
      await this.index.deleteIndex();
      await this.index.createIndex();
    }
  }

  dispose(): void {
    // LocalIndex has no explicit close; nothing to tear down
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Index a piece of text. If an entry with the same id already exists,
   * it is overwritten to keep the store deduplicated.
   */
  async upsert(entry: VectorEntry): Promise<void> {
    if (!this.index) return;

    const vector = await this.embed(entry.text);
    await this.index.upsertItem({
      id: entry.id,
      vector,
      metadata: {
        text: entry.text,
        ...(entry.metadata ?? {}),
      },
    });
  }

  async upsertMany(entries: VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.upsert(entry);
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async querySimilar(query: string, topK = 5): Promise<SimilarResult[]> {
    if (!this.index) return [];

    const queryVector = await this.embed(query);
    const results = await this.index.queryItems(queryVector, topK);

    return results.map(r => ({
      id: String(r.item.id),
      text: String(r.item.metadata?.text ?? ''),
      score: r.score,
      metadata: r.item.metadata,
    }));
  }

  // ── Embedding ─────────────────────────────────────────────────────────────

  /**
   * Convert text to a float32 vector.
   *
   * Tier 1 (preferred): vscode.lm.computeEmbeddings when available.
   * Tier 2 (fallback):  Deterministic TF-IDF approximation (offline, no deps).
   */
  private async embed(text: string): Promise<number[]> {
    // Tier 1: VS Code LM embeddings (uses Copilot under the hood — no BYOK)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lm = vscode.lm as any;
    if (typeof lm?.computeEmbeddings === 'function') {
      try {
        const result = await lm.computeEmbeddings('text-embedding-3-small', [text], {}) as { values: number[][] };
        if (result?.values?.[0]) {
          return result.values[0];
        }
      } catch {
        // Fall through to TF-IDF
      }
    }

    // Tier 2: Offline TF-IDF approximation
    return tfidfEmbed(text, EMBED_DIM);
  }
}

// ---------------------------------------------------------------------------
// TF-IDF offline embedding approximation
// ---------------------------------------------------------------------------
// This is a deterministic locality-preserving hash projection, not a true
// semantic embedding. Good enough for keyword matching in small corpora.
// Replace with ruvector WASM for production-grade semantic search.

function tfidfEmbed(text: string, dims: number): number[] {
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  const freq   = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  const vec = new Float64Array(dims).fill(0);
  for (const [token, count] of freq) {
    const hash = murmurhash32(token);
    const idx  = Math.abs(hash) % dims;
    const sign = (hash >>> 31) === 0 ? 1 : -1;
    vec[idx] += sign * (count / tokens.length);
  }

  // L2-normalise
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return Array.from(vec).map(v => v / norm);
}

function murmurhash32(str: string): number {
  let hash = 0xdeadbeef;
  for (let i = 0; i < str.length; i++) {
    let k = str.charCodeAt(i);
    k  = Math.imul(k, 0xcc9e2d51);
    k  = (k << 15) | (k >>> 17);
    k  = Math.imul(k, 0x1b873593);
    hash ^= k;
    hash = (hash << 13) | (hash >>> 19);
    hash = Math.imul(hash, 5) + 0xe6546b64;
  }
  hash ^= str.length;
  hash ^= hash >>> 16;
  hash  = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash  = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash;
}
