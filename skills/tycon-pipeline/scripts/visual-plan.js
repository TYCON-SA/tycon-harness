#!/usr/bin/env node
/**
 * visual-plan.js — Renderiza un "plan visual" HTML offline (single-file, 0-deps, sin red)
 * para el HITL Checkpoint #1 (Step 3) del tycon-pipeline.
 *
 * Filosofía TYCON: el determinismo vive en el script (template HTML fijo), el juicio
 * vive en el LLM (extrae el contenido del plan BMAD y lo pasa como JSON estructurado).
 * NADA sale de la máquina: el HTML guarda el estado en localStorage del browser y el
 * feedback vuelve por copy-paste ("Exportar feedback"), sin servidor ni nube.
 *
 * Uso:
 *   node visual-plan.js render --data <plan.json|-> --out <plan.html> [--story <spec.md>] [--open]
 *   node visual-plan.js schema           # imprime el JSON schema esperado (referencia)
 *   node visual-plan.js demo --out <f>    # genera un HTML de ejemplo
 *
 * --data -  lee el JSON desde stdin.
 * --story   (opcional) lee el frontmatter de la story para autocompletar title/pills/chip
 *           si el JSON no los trae.
 *
 * El JSON (todos los campos opcionales salvo `title`):
 *   {
 *     "storyId": "8.3",
 *     "title":   "Historial de Auditoría + Export PDF/Excel",
 *     "chip":    { "cls": "warn|ok|bad", "text": "En progreso · parte A" },
 *     "metaLine":"texto chico bajo el título (fuente, alcance, etc.)",
 *     "pills":   ["P0", "Sprint 7", "Epic 8"],   // si falta y hay --story, se derivan
 *     "objetivo":"texto (acepta `code` y **bold**)",
 *     "callouts":[{ "kind":"warn|bad", "html":"texto con `code`/**bold**" }],
 *     "context": { "title":"Decisión de arquitectura", "body":"...", "bullets":["...","..."] },
 *     "fileMap": [{ "group":"Backend — nuevo", "items":[
 *                   { "tag":"new|mod|del", "path":"Foo.cs", "note":"qué hace" } ]}],
 *     "flow":    [{ "k":"Tabla", "v":"CEIX_LogEntries", "s":"particionada", "accent":false }],
 *     "tasks":   [{ "seq":"T1", "title":"...", "desc":"..." }],
 *     "code":    [{ "fname":"archivo.cs", "body":"línea1\n+ agregada\n- borrada\n// comentario" }],
 *     "questions":[
 *        { "head":"¿Pregunta?", "ctx":"contexto chico",
 *          "options":[{ "label":"Opción A", "recommended":true }, { "label":"Opción B" }] },
 *        { "head":"Texto libre", "free":true }
 *     ],
 *     "approve": { "label":"Aprobado, implementá" }   // texto de la primera opción (opcional)
 *   }
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ----------------------------- helpers ----------------------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// inline markdown chico: `code` y **bold** sobre texto ya escapado
function fmt(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/* ---------------------- story frontmatter parse -------------------- */
function readFrontmatter(storyPath) {
  let raw;
  try { raw = fs.readFileSync(storyPath, 'utf8'); } catch (e) { return {}; }
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].replace(/^["']|["']$/g, '').trim();
  }
  return fm;
}
function pillsFromFrontmatter(fm) {
  const p = [];
  if (fm.priority) p.push(fm.priority.replace(/["']/g, ''));
  if (fm.sprint) p.push('Sprint ' + fm.sprint);
  if (fm.epic) p.push('Epic ' + fm.epic);
  if (fm.approach) p.push(fm.approach.replace(/[\[\]"']/g, ''));
  const pedido = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'platform', 'work-item-field.js')).idOf(fm);
  if (pedido) p.push('Pedido #' + pedido);
  return p;
}

/* --------------------------- code coloring ------------------------- */
function renderCodeBody(body) {
  return String(body || '').split('\n').map(line => {
    const e = esc(line);
    if (/^\s*\/\//.test(line)) return '<span class="c-cmt">' + e + '</span>';
    if (/^\+/.test(line)) return '<span class="c-add">' + e + '</span>';
    if (/^-/.test(line)) return '<span class="c-del">' + e + '</span>';
    // comentario inline al final
    return e.replace(/(\/\/.*)$/, '<span class="c-cmt">$1</span>');
  }).join('\n');
}

/* ------------------------------ render ----------------------------- */
function renderHtml(model) {
  const m = model || {};
  const title = m.title || 'Plan de implementación';
  const storyId = m.storyId || title;
  const chip = m.chip || { cls: 'warn', text: 'Pendiente de aprobación' };
  const pills = Array.isArray(m.pills) ? m.pills : [];
  const approveLabel = (m.approve && m.approve.label) || 'Aprobado, implementá';

  // numeración dinámica de secciones presentes
  let n = 0; const sec = () => ++n;

  let body = '';

  // 1. Objetivo (+ callouts)
  if (m.objetivo || (m.callouts && m.callouts.length)) {
    const cs = (m.callouts || []).map(c =>
      `<div class="callout${c.kind === 'bad' ? ' bad' : ''}">${fmt(c.html)}</div>`).join('');
    body += `<section><h2><span class="num">${sec()}</span>Objetivo</h2>` +
      (m.objetivo ? `<p class="lead">${fmt(m.objetivo)}</p>` : '') + cs + `</section>`;
  }

  // 2. Contexto / decisión (opcional)
  if (m.context && (m.context.body || (m.context.bullets || []).length)) {
    const bl = (m.context.bullets || []).map(b => `<li>${fmt(b)}</li>`).join('');
    body += `<section><h2><span class="num">${sec()}</span>${esc(m.context.title || 'Contexto')}</h2>` +
      (m.context.body ? `<p class="lead">${fmt(m.context.body)}</p>` : '') +
      (bl ? `<ul class="tight">${bl}</ul>` : '') + `</section>`;
  }

  // 3. Mapa de archivos
  if (m.fileMap && m.fileMap.length) {
    let tree = '';
    for (const g of m.fileMap) {
      if (g.group) tree += `<div class="grp">${esc(g.group)}</div>`;
      for (const it of (g.items || [])) {
        tree += `<div class="row"><span class="tag ${esc(it.tag || 'mod')}">${esc(it.tag || 'mod')}</span>` +
          `<code>${esc(it.path)}</code>` +
          (it.note ? `<span class="note">— ${fmt(it.note)}</span>` : '') + `</div>`;
      }
    }
    body += `<section><h2><span class="num">${sec()}</span>Mapa de archivos</h2><div class="tree">${tree}</div></section>`;
  }

  // 4. Flujo
  if (m.flow && m.flow.length) {
    const nodes = m.flow.map((f, i) => {
      const node = `<div class="node${f.accent ? ' accent' : ''}">` +
        `<div class="k">${esc(f.k || '')}</div><div class="v">${fmt(f.v || '')}</div>` +
        (f.s ? `<div class="s">${esc(f.s)}</div>` : '') + `</div>`;
      return node + (i < m.flow.length - 1 ? `<div class="arrow">→</div>` : '');
    }).join('');
    body += `<section><h2><span class="num">${sec()}</span>Flujo de datos</h2><div class="flow">${nodes}</div></section>`;
  }

  // 5. Pasos (con semáforo)
  if (m.tasks && m.tasks.length) {
    const rows = m.tasks.map((t, i) => {
      const id = 't' + (i + 1);
      const seq = t.seq ? `<span class="seq">${esc(t.seq)}</span>` : '';
      return `<div class="task"><div class="body"><div class="title">${seq}${fmt(t.title)}</div>` +
        (t.desc ? `<div class="desc">${fmt(t.desc)}</div>` : '') + `</div>` +
        `<select class="status" data-task="${id}"><option value="">— estado —</option>` +
        `<option value="ok">🟢 Listo</option><option value="warn">🟡 En duda</option>` +
        `<option value="bad">🔴 Bloqueado</option></select></div>`;
    }).join('');
    body += `<section><h2><span class="num">${sec()}</span>Pasos · marcá el semáforo de cada uno</h2>${rows}</section>`;
  }

  // 6. Código
  if (m.code && m.code.length) {
    const blocks = m.code.map(c =>
      `<div class="code"><div class="cap"><span class="fname">${esc(c.fname || '')}</span>` +
      `<button onclick="copyCode(this)">Copiar</button></div><pre>${renderCodeBody(c.body)}</pre></div>`).join('');
    body += `<section><h2><span class="num">${sec()}</span>${esc(m.codeTitle || 'Detalle de código')}</h2>${blocks}</section>`;
  }

  // 7. Preguntas abiertas
  if (m.questions && m.questions.length) {
    const qs = m.questions.map((q, i) => {
      const qid = 'q' + (i + 1);
      let inner = '';
      if (q.free) {
        inner = `<textarea name="${qid}" placeholder="${esc(q.placeholder || 'Escribí acá...')}"></textarea>`;
      } else {
        inner = `<div class="opts">` + (q.options || []).map(o =>
          `<label class="opt"><input type="radio" name="${qid}" value="${esc(o.label)}">` +
          `<span>${fmt(o.label)}${o.recommended ? '<span class="rec">recomendado</span>' : ''}</span></label>`
        ).join('') + `</div>`;
      }
      return `<div class="q" data-q="${qid}"><div class="qhead"><span class="qmark">?</span>${fmt(q.head)}</div>` +
        (q.ctx ? `<div class="qctx">${fmt(q.ctx)}</div>` : '') + inner + `</div>`;
    }).join('');
    body += `<section><h2><span class="num">${sec()}</span>Preguntas abiertas · necesito tu decisión</h2>${qs}</section>`;
  }

  // 8. Decisión (siempre)
  body += `<section><h2><span class="num">${sec()}</span>Decisión</h2>` +
    `<div class="approve-row" id="approveRow">` +
    `<label><input type="radio" name="approve" value="APROBADO — ${esc(approveLabel)}"><span>✅ ${esc(approveLabel)}</span></label>` +
    `<label><input type="radio" name="approve" value="CAMBIOS — ver comentarios"><span>✏️ Pedir cambios</span></label>` +
    `<label><input type="radio" name="approve" value="BLOQUEADO — no avanzar"><span>⛔ Bloqueado</span></label></div>` +
    `<textarea name="finalComment" placeholder="Comentario general para Claude (opcional)..."></textarea></section>`;

  const pillsHtml = pills.map(p => {
    const cls = /^P0/i.test(p) ? ' p0' : /sprint/i.test(p) ? ' sp' : '';
    return `<span class="pill${cls}">${esc(p)}</span>`;
  }).join('');

  return TEMPLATE
    .replace(/__TITLE__/g, esc(title))
    .replace(/__STORYID__/g, esc(storyId))
    .replace('__CHIP_CLS__', esc(chip.cls || 'warn'))
    .replace('__CHIP_TXT__', esc(chip.text || 'Pendiente de aprobación'))
    .replace('__CHIP_DEFAULT__', esc(chip.text || 'Pendiente de aprobación'))
    .replace('__METALINE__', m.metaLine ? fmt(m.metaLine) : 'todo se guarda en tu navegador, nada sale de tu máquina')
    .replace('__PILLS__', pillsHtml)
    .replace('__BODY__', body);
}

/* ----------------------------- template ---------------------------- */
const TEMPLATE = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Plan Visual — __TITLE__</title>
<style>
:root{--bg:#f6f7f9;--surface:#fff;--ink:#1a1d23;--muted:#646c7a;--line:#e4e7ec;--accent:#3b5bdb;--accent-soft:#eef2ff;
--ok:#16a34a;--ok-soft:#e7f6ec;--warn:#d97706;--warn-soft:#fdf3e3;--bad:#dc2626;--bad-soft:#fdecec;
--radius:12px;--shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
code{font-family:var(--mono);font-size:.85em;background:#eef0f3;padding:.1em .4em;border-radius:5px}
header.top{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top-inner{max-width:940px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.top h1{font-size:16px;margin:0;font-weight:650;flex:1;min-width:200px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font-size:12.5px;font-weight:600;border:1px solid transparent}
.chip .dot{width:9px;height:9px;border-radius:50%}
.chip.ok{background:var(--ok-soft);color:#15803d;border-color:#bbe9c8}.chip.ok .dot{background:var(--ok)}
.chip.warn{background:var(--warn-soft);color:#b45309;border-color:#f5d9a8}.chip.warn .dot{background:var(--warn)}
.chip.bad{background:var(--bad-soft);color:#b91c1c;border-color:#f3bcbc}.chip.bad .dot{background:var(--bad)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);flex-wrap:wrap}.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{width:9px;height:9px;border-radius:50%;display:inline-block}
main{max-width:940px;margin:0 auto;padding:28px 24px 120px}
.meta{font-size:13px;color:var(--muted);margin:-6px 0 22px}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}
.pill{font-size:11.5px;font-weight:700;letter-spacing:.02em;padding:4px 10px;border-radius:7px;background:#eef0f3;color:#475063}
.pill.p0{background:var(--bad-soft);color:#b91c1c}.pill.sp{background:var(--accent-soft);color:var(--accent)}
section{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:22px 24px;margin-bottom:20px}
section>h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 16px;font-weight:700;display:flex;align-items:center;gap:8px}
section>h2 .num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:700}
p.lead{margin:0 0 10px;font-size:15px}
ul.tight{margin:6px 0 0;padding-left:20px;font-size:13.5px}ul.tight li{margin:3px 0}
.callout{border-left:3px solid var(--warn);background:var(--warn-soft);border-radius:0 9px 9px 0;padding:12px 15px;font-size:13.5px;margin:12px 0}
.callout.bad{border-color:var(--bad);background:var(--bad-soft)}
.tree{font-family:var(--mono);font-size:13px;line-height:1.95}
.grp{font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:14px 0 4px}.grp:first-child{margin-top:0}
.tree .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tag{font-family:var(--sans);font-size:10.5px;font-weight:700;letter-spacing:.03em;padding:1px 7px;border-radius:5px;text-transform:uppercase}
.tag.new{background:var(--ok-soft);color:#15803d}.tag.mod{background:var(--warn-soft);color:#b45309}.tag.del{background:var(--bad-soft);color:#b91c1c}
.tree .note{font-family:var(--sans);color:var(--muted);font-size:12px}
.flow{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}
.node{flex:1;min-width:140px;background:#fff;border:1.5px solid var(--line);border-radius:10px;padding:11px 13px}
.node.accent{border-color:var(--accent);background:var(--accent-soft)}
.node .k{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:700;margin-bottom:3px}
.node .v{font-size:13px;font-weight:600}.node .s{font-size:11px;color:var(--muted);margin-top:2px;font-family:var(--mono)}
.arrow{display:flex;align-items:center;justify-content:center;color:#c1c7d0;font-size:20px;padding:0 5px;font-weight:700}
@media(max-width:680px){.flow{flex-direction:column}.arrow{transform:rotate(90deg);padding:4px 0}}
.task{display:flex;align-items:flex-start;gap:12px;padding:13px 0;border-top:1px solid var(--line)}.task:first-of-type{border-top:none}
.task .body{flex:1}.task .title{font-weight:600;font-size:14px}
.task .title .seq{font-family:var(--mono);font-size:11px;color:var(--accent);background:var(--accent-soft);padding:1px 6px;border-radius:5px;margin-right:7px}
.task .desc{font-size:12.5px;color:var(--muted);margin-top:3px}
select.status{font-family:var(--sans);font-size:12.5px;font-weight:600;border-radius:8px;padding:5px 9px;border:1px solid var(--line);cursor:pointer;background:#fff;min-width:120px}
select.status[data-v=ok]{color:#15803d;border-color:#bbe9c8;background:var(--ok-soft)}
select.status[data-v=warn]{color:#b45309;border-color:#f5d9a8;background:var(--warn-soft)}
select.status[data-v=bad]{color:#b91c1c;border-color:#f3bcbc;background:var(--bad-soft)}
.code{position:relative;background:#0f172a;border-radius:10px;margin:12px 0;overflow:hidden}
.code .cap{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-bottom:1px solid #1e293b}
.code .cap .fname{font-family:var(--mono);font-size:12px;color:#94a3b8}
.code .cap button{background:#1e293b;color:#cbd5e1;border:none;border-radius:6px;padding:4px 10px;font-size:11.5px;cursor:pointer}
.code .cap button:hover{background:#334155}
.code pre{margin:0;padding:14px;overflow-x:auto;color:#e2e8f0;font-family:var(--mono);font-size:12px;line-height:1.6}
.code .c-add{color:#86efac}.code .c-del{color:#fca5a5}.code .c-cmt{color:#64748b;font-style:italic}
.q{padding:16px 0;border-top:1px solid var(--line)}.q:first-of-type{border-top:none}
.q .qhead{font-weight:600;font-size:14.5px;margin-bottom:9px;display:flex;gap:8px}.q .qhead .qmark{color:var(--accent);font-weight:800}
.q .qctx{font-size:12.5px;color:var(--muted);margin:-4px 0 10px 22px}
.opts{display:flex;flex-direction:column;gap:7px;margin-bottom:8px}
.opt{display:flex;align-items:flex-start;gap:9px;font-size:13.5px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;cursor:pointer;transition:.12s}
.opt:hover{border-color:var(--accent);background:var(--accent-soft)}.opt input{margin-top:3px}.opt.checked{border-color:var(--accent);background:var(--accent-soft)}
.opt .rec{font-size:10.5px;font-weight:700;color:#15803d;background:var(--ok-soft);padding:1px 6px;border-radius:5px;margin-left:6px}
textarea{width:100%;font-family:var(--sans);font-size:13.5px;border:1px solid var(--line);border-radius:9px;padding:9px 11px;resize:vertical;min-height:48px;color:var(--ink)}
textarea:focus,select:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.approve-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.approve-row label{flex:1;min-width:150px;display:flex;align-items:center;gap:9px;padding:12px 14px;border:1.5px solid var(--line);border-radius:10px;cursor:pointer;font-weight:600;font-size:14px}
.approve-row label.sel-ok{border-color:var(--ok);background:var(--ok-soft);color:#15803d}
.approve-row label.sel-warn{border-color:var(--warn);background:var(--warn-soft);color:#b45309}
.approve-row label.sel-bad{border-color:var(--bad);background:var(--bad-soft);color:#b91c1c}
.bar{position:fixed;bottom:0;left:0;right:0;z-index:40;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);border-top:1px solid var(--line)}
.bar-inner{max-width:940px;margin:0 auto;padding:12px 24px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.bar .spacer{flex:1}
.btn{font-family:var(--sans);font-size:13.5px;font-weight:600;border-radius:9px;padding:9px 16px;border:1px solid var(--line);background:#fff;cursor:pointer;transition:.12s}
.btn:hover{border-color:#c7ccd6;background:#fafbfc}.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.btn.primary:hover{background:#324bc0}.btn.ghost{border:none;background:none;color:var(--muted)}
.toast{position:fixed;bottom:78px;left:50%;transform:translateX(-50%) translateY(20px);background:#1a1d23;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;opacity:0;pointer-events:none;transition:.25s;z-index:50}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.modal-bg{position:fixed;inset:0;background:rgba(16,24,40,.5);z-index:60;display:none;align-items:center;justify-content:center;padding:24px}.modal-bg.show{display:flex}
.modal{background:#fff;border-radius:14px;max-width:680px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden}
.modal h3{margin:0;padding:18px 22px;border-bottom:1px solid var(--line);font-size:15px}
.modal .mbody{padding:18px 22px;overflow:auto}.modal textarea{min-height:320px;font-family:var(--mono);font-size:12.5px}
.modal .mfoot{padding:14px 22px;border-top:1px solid var(--line);display:flex;gap:10px;justify-content:flex-end}
.usage{background:var(--accent-soft);border:1px solid #c7d2fe;border-radius:10px;padding:13px 16px;font-size:13px;color:#3730a3;margin-bottom:22px}.usage b{color:#312e81}
@media print{.bar,.usage,.code .cap button{display:none}header.top{position:static}body{background:#fff}section{break-inside:avoid;box-shadow:none}}
</style></head><body>
<header class="top"><div class="top-inner">
<h1>📐 __TITLE__</h1>
<span class="chip __CHIP_CLS__" id="overallChip"><span class="dot"></span><span id="overallTxt">__CHIP_TXT__</span></span>
<div class="legend"><span><i style="background:var(--ok)"></i>Listo</span><span><i style="background:var(--warn)"></i>En duda</span><span><i style="background:var(--bad)"></i>Bloqueado</span></div>
</div></header>
<main>
<div class="meta">__METALINE__</div>
<div class="pills">__PILLS__</div>
<div class="usage"><b>Cómo funciona (offline):</b> revisá el plan, marcá el semáforo de cada paso, respondé las preguntas abiertas y elegí Aprobar / Pedir cambios. Después tocá <b>Exportar feedback</b> abajo → se copia un texto con tus respuestas que le pegás de vuelta a Claude. No hay servidor.</div>
__BODY__
</main>
<div class="bar"><div class="bar-inner">
<button class="btn ghost" onclick="resetPlan()">Reiniciar</button><div class="spacer"></div>
<button class="btn" onclick="window.print()">Imprimir / PDF</button>
<button class="btn" onclick="downloadFeedback()">Descargar .md</button>
<button class="btn primary" onclick="exportFeedback()">📋 Exportar feedback</button>
</div></div>
<div class="toast" id="toast"></div>
<div class="modal-bg" id="modalBg"><div class="modal">
<h3>Feedback exportado — copialo y pegámelo de vuelta</h3>
<div class="mbody"><textarea id="exportText" readonly></textarea></div>
<div class="mfoot"><button class="btn" onclick="closeModal()">Cerrar</button><button class="btn primary" onclick="copyExport()">Copiar al portapapeles</button></div>
</div></div>
<script>
const KEY='plan-visual:__STORYID__', CHIP_DEFAULT='__CHIP_DEFAULT__';
function saveState(){const s={fields:{},tasks:{}};
document.querySelectorAll('textarea[name], input[type=radio]:checked').forEach(el=>{s.fields[el.name]=el.value;});
document.querySelectorAll('select.status').forEach(sel=>{s.tasks[sel.dataset.task]=sel.value;});
try{localStorage.setItem(KEY,JSON.stringify(s));}catch(e){}}
function loadState(){let s;try{s=JSON.parse(localStorage.getItem(KEY));}catch(e){}if(!s)return;
Object.entries(s.fields||{}).forEach(([k,v])=>{const ta=document.querySelector('textarea[name="'+k+'"]');if(ta){ta.value=v;}
const rb=document.querySelector('input[name="'+k+'"][value="'+CSS.escape(v)+'"]');if(rb){rb.checked=true;}});
Object.entries(s.tasks||{}).forEach(([k,v])=>{const sel=document.querySelector('select.status[data-task="'+k+'"]');if(sel){sel.value=v;}});refreshUI();}
function refreshUI(){document.querySelectorAll('select.status').forEach(sel=>sel.setAttribute('data-v',sel.value));
document.querySelectorAll('.opt').forEach(o=>{const i=o.querySelector('input');o.classList.toggle('checked',i.checked);});
document.querySelectorAll('#approveRow label').forEach(l=>{const i=l.querySelector('input');l.className='';
if(i.checked){l.classList.add(i.value.startsWith('APROBADO')?'sel-ok':i.value.startsWith('CAMBIOS')?'sel-warn':'sel-bad');}});
const ap=document.querySelector('input[name=approve]:checked'),chip=document.getElementById('overallChip'),txt=document.getElementById('overallTxt');
if(!ap){chip.className='chip warn';txt.textContent=CHIP_DEFAULT;}
else if(ap.value.startsWith('APROBADO')){chip.className='chip ok';txt.textContent='Aprobado';}
else if(ap.value.startsWith('CAMBIOS')){chip.className='chip warn';txt.textContent='Cambios pedidos';}
else{chip.className='chip bad';txt.textContent='Bloqueado';}}
document.addEventListener('input',()=>{refreshUI();saveState();});
document.addEventListener('change',()=>{refreshUI();saveState();});
function buildFeedback(){const L=[];L.push('# Feedback del plan: __TITLE__');
const ap=document.querySelector('input[name=approve]:checked');L.push('\\n**Decisión:** '+(ap?ap.value:'(sin elegir)'));
const fc=document.querySelector('textarea[name=finalComment]').value.trim();if(fc)L.push('**Comentario general:** '+fc);
const tasks=document.querySelectorAll('.task');if(tasks.length){L.push('\\n## Estado de los pasos');
tasks.forEach(t=>{const title=t.querySelector('.title').innerText.trim().replace(/\\s+/g,' ');const sel=t.querySelector('select.status');
const map={ok:'🟢 Listo',warn:'🟡 En duda',bad:'🔴 Bloqueado','':'— sin marcar'};L.push('- '+title+': '+map[sel.value]);});}
const qs=document.querySelectorAll('.q');if(qs.length){L.push('\\n## Respuestas a preguntas abiertas');
qs.forEach(q=>{const head=q.querySelector('.qhead').innerText.replace('?','').trim();const radio=q.querySelector('input[type=radio]:checked');
const ta=q.querySelector('textarea');const ans=radio?radio.value:(ta?ta.value.trim():'');L.push('- '+head+'\\n  → '+(ans||'(sin responder)'));});}
return L.join('\\n');}
function exportFeedback(){document.getElementById('exportText').value=buildFeedback();document.getElementById('modalBg').classList.add('show');}
function copyExport(){const t=document.getElementById('exportText');t.select();navigator.clipboard.writeText(t.value).then(()=>toast('Copiado ✓'));}
function copyCode(btn){const pre=btn.closest('.code').querySelector('pre');navigator.clipboard.writeText(pre.innerText).then(()=>{btn.textContent='Copiado ✓';setTimeout(()=>btn.textContent='Copiar',1500);});}
function downloadFeedback(){const blob=new Blob([buildFeedback()],{type:'text/markdown'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='plan-feedback.md';a.click();toast('Descargado ✓');}
function closeModal(){document.getElementById('modalBg').classList.remove('show');}
function resetPlan(){if(confirm('¿Borrar todas tus respuestas de este plan?')){localStorage.removeItem(KEY);location.reload();}}
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800);}
document.getElementById('modalBg').addEventListener('click',e=>{if(e.target.id==='modalBg')closeModal();});
loadState();
</script></body></html>`;

/* ------------------------------ demo ------------------------------- */
const DEMO = {
  storyId: 'demo', title: 'Plan de ejemplo', chip: { cls: 'warn', text: 'Pendiente de aprobación' },
  pills: ['P1', 'Sprint 7', 'Epic 8'],
  objetivo: 'Demostrar el render del plan visual con `code` y **bold**.',
  callouts: [{ kind: 'warn', html: 'Esto es un **callout** de ejemplo.' }],
  fileMap: [{ group: 'Backend — nuevo', items: [{ tag: 'new', path: 'Foo.cs', note: 'crea `Foo`' }, { tag: 'mod', path: 'Bar.cs', note: 'extiende' }] }],
  flow: [{ k: 'Origen', v: 'tabla', s: 'sql' }, { k: 'Lógica', v: 'service', accent: true }, { k: 'UI', v: 'pantalla' }],
  tasks: [{ seq: 'T1', title: 'Hacer X', desc: 'detalle de X' }, { seq: 'T2', title: 'Hacer Y' }],
  code: [{ fname: 'ej.cs', body: '// comentario\nvar x = 1;\n+ linea agregada\n- linea borrada' }],
  questions: [
    { head: '¿Opción A o B?', ctx: 'contexto chico', options: [{ label: 'A', recommended: true }, { label: 'B' }] },
    { head: 'Texto libre', free: true }
  ],
  approve: { label: 'Aprobado, implementá' }
};

/**
 * --open: el guion abre el plan en el navegador, en Mac, Linux y Windows (un `open <archivo>`
 * pedido al asistente sólo existe en Mac). Best-effort, como `qa-guide.js --open`:
 * si no puede abrirlo lo dice con la ruta, y el plan ya quedó escrito.
 */
function openInBrowser(file, what = 'el plan') {
  const fallback = (why) => console.error(`⚠ No pude abrir ${what} en el navegador (${why}) — abrilo a mano: ${file}`);
  try {
    const { spawn } = require('child_process');
    const win = process.platform === 'win32';
    const cmd = process.platform === 'darwin' ? 'open' : win ? 'cmd' : 'xdg-open';
    const args = win ? ['/c', 'start', '', file] : [file];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => fallback(e.code || e.message));
    child.unref();
  } catch (e) {
    fallback(e.message);
  }
}

/* ------------------------------ main ------------------------------- */
function main() {
  const cmd = process.argv[2];
  if (cmd === 'schema') {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(11, 52).join('\n'));
    return;
  }
  if (cmd === 'demo') {
    const out = arg('--out') || 'plan-visual-demo.html';
    fs.writeFileSync(out, renderHtml(DEMO));
    console.log(JSON.stringify({ ok: true, out, mode: 'demo' }));
    return;
  }
  if (cmd === 'render') {
    const dataArg = arg('--data');
    const out = arg('--out');
    const story = arg('--story');
    if (!dataArg || !out) {
      console.error('uso: visual-plan.js render --data <plan.json|-> --out <plan.html> [--story <spec.md>]');
      process.exit(2);
    }
    let raw;
    try {
      raw = dataArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(dataArg, 'utf8');
    } catch (e) { console.error('no pude leer --data: ' + e.message); process.exit(2); }
    let model;
    try { model = JSON.parse(raw); } catch (e) { console.error('JSON inválido en --data: ' + e.message); process.exit(2); }
    if (story) {
      const fm = readFrontmatter(story);
      if (!model.pills || !model.pills.length) model.pills = pillsFromFrontmatter(fm);
      if (!model.title && fm.title) model.title = fm.title;
      if (!model.storyId && fm.story) model.storyId = fm.story.replace(/["']/g, '');
    }
    if (!model.title) { console.error('falta `title` en el JSON'); process.exit(2); }
    fs.writeFileSync(out, renderHtml(model));
    console.log(JSON.stringify({ ok: true, out, storyId: model.storyId || null }));
    if (process.argv.includes('--open')) openInBrowser(out);
    return;
  }
  console.error('comandos: render | demo | schema');
  process.exit(2);
}
// La maqueta (mockup.js) reusa `esc` y `openInBrowser`; un `require` no corre `main()`.
module.exports = { renderHtml, esc, openInBrowser };
if (require.main === module) main();
