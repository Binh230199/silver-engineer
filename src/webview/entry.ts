/**
 * Silver Engineer — Webview entry bundle (runs inside the Webview iframe)
 *
 * Communicates with the Extension Host via acquireVsCodeApi().postMessage.
 * Renders the Knowledge Graph using a lightweight canvas-based force layout
 * (no heavy D3/React dep — keeps webview.js under ~50 KB).
 */

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

interface NodeData { id: string; label: string; type: string; weight: number }
interface EdgeData { source: string; target: string; type: string }
interface GraphPayload { nodes: NodeData[]; edges: EdgeData[] }

// ---------------------------------------------------------------------------

const vscode = acquireVsCodeApi();

// Positions for force-sim
const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  // Wire buttons
  document.getElementById('btn-summary')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openChat', query: '@silver /summary' });
  });
  document.getElementById('btn-skills')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openChat', query: '@silver /skills' });
  });
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'requestGraph' });
  });

  // Signal ready → Extension Host will push graph data
  vscode.postMessage({ type: 'ready' });
});

// ---------------------------------------------------------------------------
// Receive messages from Extension Host
// ---------------------------------------------------------------------------

window.addEventListener('message', (event) => {
  const msg = event.data as { type: string; payload?: unknown };
  if (msg.type === 'graphData') {
    renderGraph(msg.payload as GraphPayload);
  }
});

// ---------------------------------------------------------------------------
// Force-directed graph renderer (vanilla canvas)
// ---------------------------------------------------------------------------

function renderGraph(data: GraphPayload): void {
  const statsEl = document.getElementById('stats');
  if (statsEl) {
    statsEl.textContent = `${data.nodes.length} nodes · ${data.edges.length} edges`;
  }

  const canvas = document.getElementById('graph-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;

  const container = canvas.parentElement!;
  canvas.width  = container.clientWidth  || 600;
  canvas.height = container.clientHeight || 400;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Initialise positions for new nodes
  for (const node of data.nodes) {
    if (!positions.has(node.id)) {
      positions.set(node.id, {
        x:  Math.random() * canvas.width,
        y:  Math.random() * canvas.height,
        vx: 0, vy: 0,
      });
    }
  }

  // Remove stale positions
  const nodeIds = new Set(data.nodes.map(n => n.id));
  for (const key of positions.keys()) {
    if (!nodeIds.has(key)) positions.delete(key);
  }

  let frame = 0;
  const MAX_FRAMES = 120;

  function tick(): void {
    if (frame++ > MAX_FRAMES) return; // settle after N frames
    simulate(data);
    draw(ctx!, canvas!, data);
    requestAnimationFrame(tick);
  }

  tick();
}

function simulate(data: GraphPayload): void {
  const alpha = 0.08;
  const repulsion = 800;
  const spring = 0.05;
  const springLen = 100;
  const damping = 0.85;

  // Repulsion
  for (const a of data.nodes) {
    const pa = positions.get(a.id)!;
    for (const b of data.nodes) {
      if (a.id === b.id) continue;
      const pb = positions.get(b.id)!;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = repulsion / (dist * dist);
      pa.vx += (dx / dist) * force * alpha;
      pa.vy += (dy / dist) * force * alpha;
    }
  }

  // Spring attraction
  for (const e of data.edges) {
    const pa = positions.get(e.source);
    const pb = positions.get(e.target);
    if (!pa || !pb) continue;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const stretch = (dist - springLen) * spring;
    pa.vx += (dx / dist) * stretch;
    pa.vy += (dy / dist) * stretch;
    pb.vx -= (dx / dist) * stretch;
    pb.vy -= (dy / dist) * stretch;
  }

  // Integrate + dampen + clamp to canvas
  for (const node of data.nodes) {
    const p = positions.get(node.id)!;
    p.vx *= damping;
    p.vy *= damping;
    p.x  += p.vx;
    p.y  += p.vy;
  }
}

const TYPE_COLORS: Record<string, string> = {
  Person:     '#4FC3F7',
  Technology: '#81C784',
  Module:     '#FFB74D',
  WorkItem:   '#F48FB1',
  Decision:   '#CE93D8',
};

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  data: GraphPayload,
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Edges
  ctx.strokeStyle = 'rgba(150,150,150,0.4)';
  ctx.lineWidth   = 1;
  for (const e of data.edges) {
    const pa = positions.get(e.source);
    const pb = positions.get(e.target);
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // Nodes
  ctx.font = '11px var(--vscode-font-family, monospace)';
  for (const node of data.nodes) {
    const p = positions.get(node.id)!;
    const r = 8 + node.weight * 6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = TYPE_COLORS[node.type] ?? '#999';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(node.label.slice(0, 12), p.x, p.y + r + 12);
  }
}
