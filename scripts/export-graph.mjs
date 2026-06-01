// scripts/export-graph.mjs
// Live-ish visualization of the ADR-NNN KNOWLEDGE graph (TASK-992 + TASK-988):
// tasks ↔ features ↔ gotchas ↔ workspaces ↔ code_refs. This is NOT the graphify
// code graph (graphify-out/ — an unrelated LLM-extracted map of the source). The
// two must not share an output directory. Emits two artifacts under
// knowledge-graph-out/:
//   - graph.json — node-link JSON for tooling
//   - graph.html — self-contained, zero-dependency interactive viewer
//
// Design (CONV-1780297694257-1): static SQLite -> JSON + standalone HTML. "Live"
// = re-run this script (the data is stdio-only; graph_edges is not on the HTTP
// remote allowlist, so a true HTTP-served graph would force an unjustified
// allowlist+PG expansion per ADR-026). The viewer INLINES its data and uses a
// hand-rolled SVG force layout — no CDN, no vendored bundle, double-click opens
// offline on Windows (file:// blocks fetch() of a sibling .json).
//
// Usage:
//   node scripts/export-graph.mjs [--out <dir>] [--project <id>]
// --project scopes the graph to one project (nodes owned by it + edges whose
// both endpoints are in it). Omit for the global, all-projects graph.
// Reads CHODA_DB_PATH / CHODA_DATA_DIR for the DB (same resolution as the
// migrate-*.mjs scripts). No shebang (Windows autocrlf breaks the ESM loader).

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const args = process.argv.slice(2)
const outDir = argValue('--out') ?? path.join(process.cwd(), 'knowledge-graph-out')
const projectFilter = argValue('--project') // optional — scope to one project
const dbPath = resolveDbPath()

function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

function resolveDbPath() {
  if (process.env.CHODA_DB_PATH) return process.env.CHODA_DB_PATH
  const dataDir = process.env.CHODA_DATA_DIR ?? path.join(process.cwd(), 'data')
  return path.join(dataDir, 'database', 'choda-deck.db')
}

// Tables may be absent on an old DB — every read is guarded.
function safeAll(db, sql) {
  try {
    return db.prepare(sql).all()
  } catch {
    return []
  }
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`[graph] DB not found at ${dbPath}`)
    process.exit(1)
  }
  console.log(`[graph] DB:  ${dbPath}`)
  console.log(`[graph] scope: ${projectFilter ? `project=${projectFilter}` : 'global (all projects)'}`)
  const db = new Database(dbPath, { readonly: true })

  // ── Node label/kind sources ────────────────────────────────────────────────
  const tasks = new Map(
    safeAll(db, 'SELECT id, title, status FROM tasks').map((r) => [r.id, r])
  )
  const knowledge = new Map(
    safeAll(db, 'SELECT slug, type, title, file_path FROM knowledge_index').map((r) => [r.slug, r])
  )
  const workspaces = new Map(
    safeAll(db, 'SELECT id, label FROM workspaces').map((r) => [r.id, r])
  )
  const codeRefs = new Map(
    safeAll(db, 'SELECT slug, path, symbol FROM code_refs').map((r) => [r.slug, r])
  )

  // --project <id>: the relationships table has no project_id, so scope by NODE
  // membership — collect every raw id owned by the project across the four node
  // tables, then keep only edges with BOTH endpoints in that set (cross-project
  // edges are dropped in project mode). Null when unscoped (global graph).
  let inProject = null
  if (projectFilter) {
    inProject = new Set()
    const add = (sql) => {
      try {
        for (const r of db.prepare(sql).all(projectFilter)) inProject.add(r.id)
      } catch {
        /* table absent */
      }
    }
    add('SELECT id FROM tasks WHERE project_id = ?')
    add('SELECT slug AS id FROM knowledge_index WHERE project_id = ?')
    add('SELECT id FROM workspaces WHERE project_id = ?')
    add('SELECT slug AS id FROM code_refs WHERE project_id = ?')
  }
  const edgeInScope = (a, b) => !inProject || (inProject.has(a) && inProject.has(b))

  // Resolve a raw id (as stored in the edge tables) to {kind, label, extra...}.
  // Order matters only where id spaces could overlap; in practice they're
  // disjoint (TASK-*, kebab slugs, workspace ids) — unknowns degrade gracefully.
  function resolve(rawId) {
    if (tasks.has(rawId)) {
      const t = tasks.get(rawId)
      return { kind: 'task', label: t.title || rawId, status: t.status, path: null }
    }
    if (knowledge.has(rawId)) {
      const k = knowledge.get(rawId)
      const kind = ['feature', 'gotcha', 'code_ref'].includes(k.type) ? k.type : 'knowledge'
      return { kind, label: k.title || rawId, status: null, path: k.file_path ?? null }
    }
    if (workspaces.has(rawId)) {
      const w = workspaces.get(rawId)
      return { kind: 'workspace', label: w.label || rawId, status: null, path: null }
    }
    if (codeRefs.has(rawId)) {
      const c = codeRefs.get(rawId)
      return { kind: 'code_ref', label: c.symbol || c.path || rawId, status: null, path: c.path }
    }
    return { kind: 'unknown', label: rawId, status: null, path: null }
  }

  // ── Edges ────────────────────────────────────────────────────────────────
  // Generic typed edges (DEPENDS_ON + the 5 TASK-992 edges) carry no attribute.
  const relRows = safeAll(db, 'SELECT from_id, to_id, type FROM relationships')
  // TOUCHES lives in its own table and carries relation (modifies|reference).
  const touchRows = safeAll(
    db,
    'SELECT task_id, code_ref_slug, relation FROM task_code_refs'
  )

  const nodeIds = new Set()
  const edges = []
  const nodeKey = (rawId, kind) => `${kind}:${rawId}`

  for (const r of relRows) {
    if (!edgeInScope(r.from_id, r.to_id)) continue
    const fk = resolve(r.from_id)
    const tk = resolve(r.to_id)
    const sid = nodeKey(r.from_id, fk.kind)
    const tid = nodeKey(r.to_id, tk.kind)
    nodeIds.add(sid)
    nodeIds.add(tid)
    edges.push({ source: sid, target: tid, type: r.type, relation: null })
  }
  for (const t of touchRows) {
    if (!edgeInScope(t.task_id, t.code_ref_slug)) continue
    const sid = nodeKey(t.task_id, resolve(t.task_id).kind)
    const tid = nodeKey(t.code_ref_slug, resolve(t.code_ref_slug).kind)
    nodeIds.add(sid)
    nodeIds.add(tid)
    edges.push({ source: sid, target: tid, type: 'TOUCHES', relation: t.relation })
  }

  // Materialize node objects (only nodes that appear in an edge).
  const seen = new Map()
  const nodes = []
  for (const id of nodeIds) {
    const idx = id.indexOf(':')
    const rawId = id.slice(idx + 1)
    const r = resolve(rawId)
    if (seen.has(id)) continue
    seen.set(id, true)
    nodes.push({
      id,
      rawId,
      kind: r.kind,
      label: r.label,
      status: r.status,
      path: r.path
    })
  }

  db.close()

  const edgeTypeCounts = {}
  for (const e of edges) edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] ?? 0) + 1
  const kindCounts = {}
  for (const n of nodes) kindCounts[n.kind] = (kindCounts[n.kind] ?? 0) + 1

  const graph = {
    generatedAt: new Date().toISOString(),
    project: projectFilter ?? null,
    counts: { nodes: nodes.length, edges: edges.length, byKind: kindCounts, byEdgeType: edgeTypeCounts },
    nodes,
    edges
  }

  fs.mkdirSync(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'graph.json')
  const htmlPath = path.join(outDir, 'graph.html')
  fs.writeFileSync(jsonPath, JSON.stringify(graph, null, 2), 'utf8')
  fs.writeFileSync(htmlPath, renderHtml(graph), 'utf8')

  console.log(`[graph] nodes: ${nodes.length}  edges: ${edges.length}`)
  console.log(`[graph] by kind:      ${fmtCounts(kindCounts)}`)
  console.log(`[graph] by edge type: ${fmtCounts(edgeTypeCounts)}`)
  console.log(`[graph] wrote ${jsonPath}`)
  console.log(`[graph] wrote ${htmlPath}`)
}

function fmtCounts(obj) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join('  ')
}

// Self-contained viewer. Data is inlined (no fetch — works on file://). The
// force layout, drag/pan/zoom, filtering and selection are vanilla JS/SVG.
function renderHtml(graph) {
  const data = JSON.stringify(graph)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>choda graph — ADR-NNN knowledge graph</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f1a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; height: 100vh; overflow: hidden; }
  #stage { flex: 1; position: relative; }
  svg { width: 100%; height: 100%; display: block; cursor: grab; }
  svg.panning { cursor: grabbing; }
  .edge { stroke-opacity: 0.55; stroke-width: 1.5; }
  .edge.dim { stroke-opacity: 0.06; }
  .edge.hidden { display: none; }
  .node circle { stroke: #0f0f1a; stroke-width: 2; cursor: pointer; }
  .node text { font-size: 10px; fill: #cdd3e0; pointer-events: none; paint-order: stroke; stroke: #0f0f1a; stroke-width: 3px; }
  .node.dim { opacity: 0.12; }
  .node.sel circle { stroke: #fff; stroke-width: 3; }
  #sidebar { width: 300px; background: #1a1a2e; border-left: 1px solid #2a2a4e; display: flex; flex-direction: column; overflow-y: auto; }
  .sec { padding: 12px 14px; border-bottom: 1px solid #2a2a4e; }
  h1 { font-size: 14px; letter-spacing: .02em; }
  h1 small { color: #6a6a8e; font-weight: 400; }
  h3 { font-size: 11px; color: #8a8aae; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .06em; }
  .legend-item, .filter-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; cursor: pointer; }
  .swatch { width: 12px; height: 12px; border-radius: 3px; flex: none; }
  .swatch.line { height: 3px; border-radius: 2px; }
  .count { margin-left: auto; color: #6a6a8e; font-variant-numeric: tabular-nums; }
  .filter-item input { accent-color: #4E79A7; }
  #info .empty { color: #555; font-style: italic; font-size: 12px; }
  #info .field { font-size: 12px; line-height: 1.6; word-break: break-word; }
  #info .field b { color: #fff; }
  .nbr { display: block; font-size: 12px; padding: 2px 6px; margin: 2px 0; border-radius: 3px; cursor: pointer; border-left: 3px solid #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nbr:hover { background: #2a2a4e; }
  .nbr .et { color: #8a8aae; font-size: 10px; }
  #hint { position: absolute; bottom: 10px; left: 12px; font-size: 11px; color: #4a4a6e; }
  button.mini { background: #24243e; color: #cdd3e0; border: 1px solid #3a3a5e; border-radius: 5px; padding: 4px 9px; font-size: 11px; cursor: pointer; }
  button.mini:hover { border-color: #4E79A7; }
</style>
</head>
<body>
<div id="stage">
  <svg id="svg"><g id="viewport"><g id="edges"></g><g id="nodes"></g></g></svg>
  <div id="hint">drag node · drag bg to pan · scroll to zoom · click node to focus</div>
</div>
<div id="sidebar">
  <div class="sec"><h1>choda graph <small>· ADR-NNN</small></h1>
    <div style="font-size:12px;color:#8a8aae;margin-top:4px" id="meta"></div>
    <div style="font-size:11px;color:#6a6a8e;margin-top:2px">scroll zoom · drag node/bg · click to focus</div>
    <div style="margin-top:8px"><button class="mini" id="reset">reset view</button> <button class="mini" id="clear">clear focus</button></div>
  </div>
  <div class="sec"><h3>Selection</h3><div id="info"><div class="empty">click a node</div></div></div>
  <div class="sec"><h3>Node types</h3><div id="legend"></div></div>
  <div class="sec"><h3>Edge types (toggle)</h3><div id="filters"></div></div>
</div>
<script>
const DATA = ${data};
const KIND_COLOR = { task:'#4E79A7', feature:'#59A14F', gotcha:'#E15759', code_ref:'#B07AA1', workspace:'#F28E2B', knowledge:'#76B7B2', decision:'#76B7B2', unknown:'#888' };
const EDGE_COLOR = { REALIZES:'#59A14F', IN:'#F28E2B', ABOUT:'#E15759', PINS:'#B07AA1', INTEGRATES_WITH:'#EDC948', TOUCHES:'#4E79A7', DEPENDS_ON:'#9c9c9c', IMPLEMENTS:'#76B7B2', USES_TECH:'#76B7B2', DECIDED_BY:'#76B7B2' };
const kc = (k)=>KIND_COLOR[k]||'#888';
const ec = (t)=>EDGE_COLOR[t]||'#9c9c9c';

const svg = document.getElementById('svg');
const viewport = document.getElementById('viewport');
const gEdges = document.getElementById('edges');
const gNodes = document.getElementById('nodes');
const SVGNS='http://www.w3.org/2000/svg';

const W = ()=>svg.clientWidth, H = ()=>svg.clientHeight;
const nodes = DATA.nodes.map(n=>({ ...n, x: Math.random()*W(), y: Math.random()*H(), vx:0, vy:0 }));
const byId = new Map(nodes.map(n=>[n.id,n]));
const edges = DATA.edges.map(e=>({ ...e, s: byId.get(e.source), t: byId.get(e.target) })).filter(e=>e.s&&e.t);
const deg = new Map(); nodes.forEach(n=>deg.set(n.id,0));
edges.forEach(e=>{ deg.set(e.s.id,deg.get(e.s.id)+1); deg.set(e.t.id,deg.get(e.t.id)+1); });

const hiddenTypes = new Set();

// ── build SVG ──
const edgeEls = edges.map(e=>{
  const l=document.createElementNS(SVGNS,'line');
  l.setAttribute('class','edge'); l.setAttribute('stroke',ec(e.type)); e.el=l; gEdges.appendChild(l); return l;
});
const nodeEls = nodes.map(n=>{
  const g=document.createElementNS(SVGNS,'g'); g.setAttribute('class','node');
  const c=document.createElementNS(SVGNS,'circle');
  const r=5+Math.min(7,deg.get(n.id)); c.setAttribute('r',r); c.setAttribute('fill',kc(n.kind)); n.r=r;
  const tx=document.createElementNS(SVGNS,'text'); tx.setAttribute('x',r+3); tx.setAttribute('y',4);
  tx.textContent = n.label.length>26 ? n.label.slice(0,25)+'…' : n.label;
  g.appendChild(c); g.appendChild(tx); g.addEventListener('mousedown',ev=>startDragNode(ev,n));
  g.addEventListener('click',ev=>{ev.stopPropagation(); select(n);});
  n.gel=g; gNodes.appendChild(g); return g;
});

// ── force sim ──
let alpha=1;
function tick(){
  if(alpha<0.005){ requestAnimationFrame(tick); return; }
  alpha*=0.985;
  const cx=W()/2, cy=H()/2;
  for(let i=0;i<nodes.length;i++){
    const a=nodes[i];
    for(let j=i+1;j<nodes.length;j++){
      const b=nodes[j]; let dx=a.x-b.x, dy=a.y-b.y; let d2=dx*dx+dy*dy||0.01;
      const f=2600/d2; const d=Math.sqrt(d2); const fx=dx/d*f, fy=dy/d*f;
      a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
    }
    a.vx+=(cx-a.x)*0.0016; a.vy+=(cy-a.y)*0.0016;
  }
  for(const e of edges){
    let dx=e.t.x-e.s.x, dy=e.t.y-e.s.y; const d=Math.sqrt(dx*dx+dy*dy)||0.01;
    const f=(d-90)*0.02; const fx=dx/d*f, fy=dy/d*f;
    e.s.vx+=fx; e.s.vy+=fy; e.t.vx-=fx; e.t.vy-=fy;
  }
  for(const n of nodes){ if(n.fixed) continue; n.x+=n.vx*alpha; n.y+=n.vy*alpha; n.vx*=0.82; n.vy*=0.82; }
  render(); requestAnimationFrame(tick);
}
function render(){
  for(const e of edges) if(e.el.style.display!=='none'){ e.el.setAttribute('x1',e.s.x);e.el.setAttribute('y1',e.s.y);e.el.setAttribute('x2',e.t.x);e.el.setAttribute('y2',e.t.y); }
  for(const n of nodes) n.gel.setAttribute('transform',\`translate(\${n.x},\${n.y})\`);
}
function reheat(a=0.7){ alpha=Math.max(alpha,a); }

// ── pan / zoom ──
let view={x:0,y:0,k:1};
function applyView(){ viewport.setAttribute('transform',\`translate(\${view.x},\${view.y}) scale(\${view.k})\`); }
svg.addEventListener('wheel',ev=>{ ev.preventDefault(); const s=ev.deltaY<0?1.1:0.9; const r=svg.getBoundingClientRect();
  const mx=ev.clientX-r.left, my=ev.clientY-r.top; view.x=mx-(mx-view.x)*s; view.y=my-(my-view.y)*s; view.k*=s; applyView(); },{passive:false});
let panning=null;
svg.addEventListener('mousedown',ev=>{ if(ev.target.closest('.node'))return; panning={px:ev.clientX,py:ev.clientY,ox:view.x,oy:view.y}; svg.classList.add('panning'); clearFocus(); });
window.addEventListener('mousemove',ev=>{
  if(panning){ view.x=panning.ox+(ev.clientX-panning.px); view.y=panning.oy+(ev.clientY-panning.py); applyView(); }
  if(dragN){ const p=toWorld(ev); dragN.x=p.x; dragN.y=p.y; reheat(0.3); }
});
window.addEventListener('mouseup',()=>{ panning=null; svg.classList.remove('panning'); if(dragN){dragN.fixed=false;dragN=null;} });
function toWorld(ev){ const r=svg.getBoundingClientRect(); return { x:(ev.clientX-r.left-view.x)/view.k, y:(ev.clientY-r.top-view.y)/view.k }; }
let dragN=null;
function startDragNode(ev,n){ ev.stopPropagation(); dragN=n; n.fixed=true; const p=toWorld(ev); n.x=p.x; n.y=p.y; }

// ── selection / focus ──
function neighbors(n){ const out=[]; for(const e of edges){ if(hiddenTypes.has(e.type))continue; if(e.s===n)out.push({e,other:e.t,dir:'out'}); else if(e.t===n)out.push({e,other:e.s,dir:'in'}); } return out; }
function select(n){
  const nb=neighbors(n); const keep=new Set([n.id]); nb.forEach(x=>keep.add(x.other.id));
  nodeEls.forEach((g,i)=>{ const nn=nodes[i]; g.classList.toggle('dim',!keep.has(nn.id)); g.classList.toggle('sel',nn===n); });
  edges.forEach(e=>{ const on=(e.s===n||e.t===n)&&!hiddenTypes.has(e.type); e.el.classList.toggle('dim',!on); });
  const info=document.getElementById('info');
  info.innerHTML='';
  info.appendChild(field('', '<b>'+esc(n.label)+'</b>'));
  info.appendChild(field('kind', '<span style="color:'+kc(n.kind)+'">'+n.kind+'</span>'));
  info.appendChild(field('id', esc(n.rawId)));
  if(n.status) info.appendChild(field('status', esc(n.status)));
  if(n.path) info.appendChild(field('path', esc(n.path)));
  const h=document.createElement('div'); h.style.cssText='margin-top:8px;color:#8a8aae;font-size:11px'; h.textContent=nb.length+' neighbor(s)'; info.appendChild(h);
  nb.sort((a,b)=>a.e.type.localeCompare(b.e.type)).forEach(x=>{
    const a=document.createElement('a'); a.className='nbr'; a.style.borderLeftColor=ec(x.e.type);
    const arrow=x.dir==='out'?'→':'←'; const rel=x.e.relation?(' ('+x.e.relation+')'):'';
    a.innerHTML='<span class="et">'+x.e.type+rel+' '+arrow+'</span> '+esc(x.other.label);
    a.onclick=()=>select(x.other); info.appendChild(a);
  });
}
function field(k,v){ const d=document.createElement('div'); d.className='field'; d.innerHTML=(k?('<b>'+k+':</b> '):'')+v; return d; }
function clearFocus(){ nodeEls.forEach(g=>g.classList.remove('dim','sel')); edges.forEach(e=>e.el.classList.remove('dim')); document.getElementById('info').innerHTML='<div class="empty">click a node</div>'; }
function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// ── sidebar: legend + filters + meta ──
function buildSidebar(){
  document.getElementById('meta').textContent = (DATA.project?('project: '+DATA.project+' · '):'all projects · ')+DATA.counts.nodes+' nodes · '+DATA.counts.edges+' edges · '+new Date(DATA.generatedAt).toLocaleString();
  const leg=document.getElementById('legend');
  Object.entries(DATA.counts.byKind).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{
    const d=document.createElement('div'); d.className='legend-item';
    d.innerHTML='<span class="swatch" style="background:'+kc(k)+'"></span>'+k+'<span class="count">'+v+'</span>'; leg.appendChild(d);
  });
  const fil=document.getElementById('filters');
  Object.entries(DATA.counts.byEdgeType).sort((a,b)=>b[1]-a[1]).forEach(([t,v])=>{
    const lab=document.createElement('label'); lab.className='filter-item';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true;
    cb.onchange=()=>{ if(cb.checked)hiddenTypes.delete(t); else hiddenTypes.add(t);
      edges.forEach(e=>{ if(e.type===t) e.el.style.display=cb.checked?'':'none'; }); reheat(0.2); };
    lab.appendChild(cb);
    const sw=document.createElement('span'); sw.className='swatch line'; sw.style.background=ec(t); sw.style.width='14px'; lab.appendChild(sw);
    const tx=document.createElement('span'); tx.textContent=t; lab.appendChild(tx);
    const c=document.createElement('span'); c.className='count'; c.textContent=v; lab.appendChild(c);
    fil.appendChild(lab);
  });
}
document.getElementById('reset').onclick=()=>{ view={x:0,y:0,k:1}; applyView(); reheat(0.6); };
document.getElementById('clear').onclick=clearFocus;

buildSidebar(); applyView(); requestAnimationFrame(tick);
</script>
</body>
</html>
`
}

main()
