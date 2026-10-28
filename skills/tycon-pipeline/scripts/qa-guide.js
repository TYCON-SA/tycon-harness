#!/usr/bin/env node
/**
 * qa-guide.js — genera una GUÍA DE PRUEBA MANUAL en HTML, pensada para un TESTER humano
 * (control de calidad sobre lo que se verificó automáticamente). Regla DODRT-C7.
 * Una guía paso a paso para probar a mano lo que ya se probó automáticamente: un html pensado para
 * un tester, guardado con los documentos de trabajo de la historia.
 *
 * NO reemplaza la verificación automática (la matriz DODRT-C6) — la COMPLEMENTA: le da a un
 * humano responsable una checklist facilitada (qué hacer, qué esperar, pasó/falló + notas) para
 * cada AC, indicando cómo se verificó automáticamente y, cuando aplica, la razón de que un AC no
 * sea verificable corriendo la app.
 *
 * Fuentes (todo derivado, no inventado):
 *   - Story spec: texto de cada AC (## Acceptance Criteria) + tabla ### Tests (Escenario/Esperado)
 *     + `runtime_not_verifiable:` (razones de los imposibles).
 *   - runtime-matrix.js compute(): estado por-AC (corrido / waiveado / etc.) + evidencia.
 *   - <sid>-smoke-ledger.jsonl: el comando real que corrió cada smoke (referencia técnica).
 *   - Preámbulo opcional (setup del entorno) — <workspace>/<repo>/specs/qa/preamble.md o --preamble.
 *
 * Uso:
 *   node qa-guide.js --story <abs .md> [--out <abs .html>] [--preamble <abs .md>]
 * Salida por defecto: <...>/specs/qa/<basename-sin-ext>-guia-qa.html (docs de trabajo de la story).
 * Exit: 0 ok · 2 error.
 */

'use strict';
// el piso de Node: con uno viejo, este guion se vuelve a lanzar con el Node del arnés o lo dice en una línea
if (require.main === module) { try { require('./lib/node-floor.js').guard(); } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; } }
const fs = require('fs');
const path = require('path');
const os = require('os');
const smokeSecrets = require(path.join(__dirname, 'lib', 'smoke-secrets.js'));

function readStory(p) {
  const content = fs.readFileSync(p, 'utf8');
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return { content, fm: fm ? fm[1] : '' };
}

// AC número → texto completo (une líneas hasta el próximo `N.` o `### ` o fin de la sección).
// La sección se resuelve con lib/story-checks.js — misma anclada-a-línea-y-sin-frontmatter que
// usa mech-check. Un regex local sin anclar matchearía el literal citado en un comentario del
// frontmatter (que va primero y por eso ganaría) y devolvería como "sección de ACs" el resto del
// frontmatter → 0 ACs, y la guía de QA saldría sin ningún criterio que probar. Por eso se usa la
// sección que resuelve lib/story-checks.js.
function parseAcsWithText(content) {
  const sc = require(path.join(__dirname, 'lib', 'story-checks.js'));

  // 🔴 PRIMERO el parser CANÓNICO, y sólo después el local.
  //
  // El de abajo entiende ACs como lista numerada (`1. ...`) y NADA más. Hay stories que
  // los escriben como encabezado (`### AC1 — título`), un formato que el corpus usa y que
  // `parseAcsFromSpec` sí soporta. Para esas stories esta función devolvería 0 ACs
  // mientras el ENCABEZADO de la guía —que sale de la matriz, o sea del parser canónico— diría
  // "4 ACs". La guía se generaría con el resumen correcto y el cuerpo VACÍO: ni un caso que probar.
  //
  // Es la misma clase de bug que ya está documentada arriba en este archivo: dos parsers leyendo
  // el MISMO documento y contestando distinto. La cura no es un tercer regex, es usar el canónico.
  const nums = sc.parseAcsFromSpec(content);
  if (nums.length) {
    const textos = sc.acTextsFromSpec(content, { maxChars: 1200 });
    const conTexto = nums
      .map((n) => ({ n, text: String(textos[n] || '').replace(/\s+/g, ' ').trim() }))
      .filter((a) => a.text);
    if (conTexto.length) return conTexto;
  }

  const section = sc.acSectionOf(content);
  if (section == null) return [];
  const lines = section.split('\n');
  const acs = [];
  let cur = null;
  for (const line of lines) {
    const acM = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (acM) {
      if (cur) acs.push(cur);
      cur = { n: parseInt(acM[1], 10), text: acM[2].trim() };
    } else if (cur && line.trim() && !/^#{2,}\s/.test(line)) {
      cur.text += ' ' + line.trim();
    } else if (/^#{2,}\s/.test(line)) {
      if (cur) { acs.push(cur); cur = null; }
    }
  }
  if (cur) acs.push(cur);
  // limpiar markdown básico para el HTML (lo escapamos aparte; acá solo colapsamos espacios)
  for (const a of acs) a.text = a.text.replace(/\s+/g, ' ').trim();
  return acs;
}

// Pasos + descripción de tester EN CRIOLLO (fuente separada de la tabla ### Tests y del texto
// del AC, ambos dev-facing). Archivo `<repo>/qa/<sid>-pasos.md` por-AC:
//   ## AC 1
//   Al abrir una devolución, el listado arranca vacío y aparece el botón para agregar artículos. ← desc (criollo)
//   - Abrí un pedido de devolución y andá a la pestaña "Listado".                              ← hacé
//     → El listado está vacío y aparece el botón "+ Agregar artículo".                          ← tenés que ver
// La descripción (texto suelto antes del primer `-`) reemplaza al texto técnico del AC en la card.
// Rol/usuario con el que se prueba un AC. Valor centinela para "sin login — lo verifica el
// sistema" (AC no operables a mano: system-verified). Un `Usuario:` puede listar VARIOS roles
// separados por `;` (ej. una prueba de 2 pestañas: encargado en una, admin en la otra).
const ROLE_NONE = '__none__';
function normalizeRoles(raw) {
  const parts = String(raw == null ? '' : raw).split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && /^(—|-|n\/?a|ninguno|sin\s+login|sistema)$/i.test(parts[0])) return [ROLE_NONE];
  return parts;
}

// Rol/usuario por defecto declarado UNA vez al tope del archivo de pasos ("Usuario por defecto:
// Encargado general"). Se aplica a los AC que NO declaran su propio `Usuario:`.
function parseDefaultRole(md) {
  if (!md) return null;
  const m = md.match(/^\s*Usuario\s+por\s+defecto\s*:\s*(.+?)\s*$/im);
  return m ? normalizeRoles(m[1]) : null;
}

// Modo primera vez: la persona trabaja sola. La guía dice cómo abrir la app con una línea
// «Abrir la app: …» al tope del archivo de pasos (está escrita para el dev, que es quien la levanta) y ningún paso le
// pide algo al equipo.
function parseOpenApp(md) {
  if (!md) return null;
  const m = md.match(/^\s*Abrir\s+la\s+app\s*:\s*(.+?)\s*$/im);
  return m ? m[1] : null;
}

/** Los renglones del archivo de pasos que nombran al equipo como personas. */
function teamLines(md) {
  return String(md || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /\b(al|el|del|tu)\s+equipo\b/i.test(l));
}

/** ¿La historia la escribió el modo primera vez? La marca y la constancia del guion; ante cualquier duda, no. */
function isFirstTimeStory(fm, storyAbs, storyId) {
  if (!/^origin:\s*["']?first-time["']?\s*$/m.test(fm || '')) return false;
  let record;
  try { record = require(path.join(__dirname, 'lib', 'first-time-record.js')); } catch (e) {
    console.error(`⚠️  qa-guide: no pude cargar first-time-record.js (${e && e.message ? e.message : e}): la revisión de modo primera vez no corre`);
    return false;
  }
  return record.isRecorded(os.homedir(), storyAbs, storyId);
}

// Resuelve el/los rol(es) de prueba de un AC para el badge del header.
//   - `pasosRole` explícito (`Usuario:` del AC) gana siempre; `[ROLE_NONE]` → "sin login".
//   - Sin explícito: SOLO los AC genuinamente no-verificables por la app (tier 'wv') caen a
//     "sin login". Un AC 'pend' (todavía no corrido) o 'run' (verificado) mantiene el rol default
//     — se va a correr/se corrió con ese usuario. Si 'pend' cayera a sin-login, el default se
//     rompería en guías sin evidencia runtime.
function resolveRoles(pasosRole, tier, defaultRole) {
  if (pasosRole && pasosRole.length) {
    if (pasosRole.length === 1 && pasosRole[0] === ROLE_NONE) return { roles: [], roleNone: true };
    return { roles: pasosRole, roleNone: false };
  }
  if (tier === 'wv') return { roles: [], roleNone: true };
  if (defaultRole && defaultRole.length) {
    if (defaultRole.length === 1 && defaultRole[0] === ROLE_NONE) return { roles: [], roleNone: true };
    return { roles: defaultRole, roleNone: false };
  }
  return { roles: [], roleNone: false };
}

function parsePasos(md) {
  const out = {};
  if (!md) return out;
  const parts = md.split(/^##\s+AC\s+(\d+)\b[^\n]*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const n = parseInt(parts[i], 10);
    const body = parts[i + 1] || '';
    const pairs = [];
    const descLines = [];
    let cur = null;
    let seenStep = false;
    let role = null;
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      // `Usuario: <rol>` (opcionalmente con 👤) ANTES de los pasos → rol de prueba del AC.
      const roleM = !seenStep && line.match(/^\s*(?:👤\s*)?Usuario\s*:\s*(.+?)\s*$/i);
      if (roleM) { role = normalizeRoles(roleM[1]); continue; }
      const h = line.match(/^\s*-\s+(.*)$/);
      const v = line.match(/^\s*(?:→|->)\s+(.*)$/);
      if (h) { seenStep = true; if (cur) pairs.push(cur); cur = { escenario: h[1].trim(), esperado: '' }; }
      else if (v && cur) { cur.esperado = (cur.esperado ? cur.esperado + ' ' : '') + v[1].trim(); }
      else if (cur && line.trim() && !/^#/.test(line)) {
        if (cur.esperado) cur.esperado += ' ' + line.trim();
        else cur.escenario += ' ' + line.trim();
      } else if (!seenStep && line.trim() && !/^#/.test(line)) {
        descLines.push(line.trim());
      }
    }
    if (cur) pairs.push(cur);
    const desc = descLines.join(' ').trim();
    if (pairs.length || desc || role) out[n] = { desc, pairs, role };
  }
  return out;
}

// ¿El bloque de un AC trae pasos para el tester? Pasos «- …» o una descripción: los pasos numerados («1. …»), la forma
// más común en las guías reales, quedan como descripción. Un «Usuario:» suelto no son pasos. La guía y su chequeo
// preguntan acá: con dos reglas, la guía avisaba «sin pasos» de un AC que el chequeo daba por cubierto.
function tienePasos(b) {
  return !!(b && ((b.pairs && b.pairs.length) || (b.desc && b.desc.trim())));
}

// Secuencia (orden + secciones) del archivo de pasos: el ORDEN en que aparecen los `## AC N`
// define el orden en que el tester los recorre (optimizado para terminar rápido, reusando setup);
// las líneas `## GRUPO <título>` renderizan un separador de sección. Devuelve [{group}|{ac}] en orden.
function parsePasosSequence(md) {
  const seq = [];
  if (!md) return seq;
  for (const line of md.split('\n')) {
    const g = line.match(/^##\s+GRUPO\s+(.+?)\s*$/i);
    const a = line.match(/^##\s+AC\s+(\d+)\b/);
    if (g) seq.push({ group: g[1].trim() });
    else if (a) seq.push({ ac: parseInt(a[1], 10) });
  }
  return seq;
}

// Tabla de pruebas → filas con TODAS las columnas por header (Escenario/Esperado incluidos). El título lo encuentra
// story-checks.js, con cualquier mayúscula y nivel.
function parseTestsFull(content) {
  const sec = require(path.join(__dirname, 'lib', 'story-checks.js')).storySection(content, 'tests');
  if (!sec) return [];
  const lines = sec.text.split('\n').filter((l) => /^\s*\|/.test(l));
  if (lines.length < 2) return [];
  const split = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/\*/g, ''));
  const idx = {
    tid: header.findIndex((h) => /^(t-?id|id)$/.test(h)),
    name: header.findIndex((h) => /test|nombre|descrip/.test(h)),
    ac: header.findIndex((h) => /^acs?$/.test(h)),
    nivel: header.findIndex((h) => /nivel|level|tipo/.test(h)),
    esc: header.findIndex((h) => /escenario|scenario|acci/.test(h)),
    esp: header.findIndex((h) => /esperado|expected|resultado/.test(h)),
  };
  if (idx.tid === -1) idx.tid = 0;
  const rows = [];
  for (const line of lines.slice(1)) {
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue;
    const c = split(line);
    if (c.every((x) => x === '')) continue;
    const acRefs = [];
    const acSrc = idx.ac !== -1 ? (c[idx.ac] || '') : c.join(' ');
    for (const am of acSrc.matchAll(/(?:AC\s*)?#?\s*(\d+)/g)) acRefs.push(parseInt(am[1], 10));
    rows.push({
      tid: (c[idx.tid] || '').replace(/[`*]/g, '').trim(),
      nivel: idx.nivel !== -1 ? (c[idx.nivel] || '') : '',
      escenario: idx.esc !== -1 ? (c[idx.esc] || '') : '',
      esperado: idx.esp !== -1 ? (c[idx.esp] || '') : '',
      acRefs: [...new Set(acRefs)],
    });
  }
  return rows;
}

function readSmokeLedgerByAc(evidenceDirs, sid) {
  const byAc = {};
  for (const dir of evidenceDirs) {
    const f = path.join(dir, `${sid}-smoke-ledger.jsonl`);
    if (!isFile(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.exit !== 0 || !Array.isArray(e.acs)) continue;
      // Tapado al mostrarlo: la guía se commitea, y un registro anterior al tapado de lib/smoke-secrets.js puede
      // traer la contraseña tal cual.
      const cmd = smokeSecrets.redact(e.cmd || '').text;
      for (const n of e.acs) { (byAc[n] = byAc[n] || []).push(cmd); }
    }
  }
  return byAc;
}

function isFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
// Detector de JERGA DE SOFTWARE en un paso de tester (candado del criollo, regla DODRT-C7).
// Marca lo que un tester del negocio NO entendería: identificadores de código (camelCase,
// PascalCase multi-palabra), CONSTANTES, nombres de tabla (PREFIJO_/snake_case), referencias
// `archivo:línea`, llamadas `.metodo()`, código entre backticks y códigos HTTP crudos (4xx/5xx).
// NO marca vocabulario del DOMINIO del producto: las siglas de uso general están acá, y las de un rubro las declara el
// repo del producto en `.tycon/advisors.yaml` → `qa_guide_terms` (qaGuideTerms).
const JARGON_ALLOW = new Set(['ID', 'OK', 'PDF', 'URL']);
function detectJargon(text, extra = []) {
  if (!text) return [];
  const permitidas = new Set([...JARGON_ALLOW, ...extra]);
  const found = new Set();
  const patterns = [
    /`[^`]+`/g,                              // código entre backticks
    /\b[a-z]+[A-Z][a-zA-Z]+\b/g,             // camelCase (openCasePinned)
    /\b[A-Z][a-z]+[A-Z][a-zA-Z]+\b/g,        // PascalCase multi (RoleConstants, PedidosService)
    /\b[A-Z]{2,}_[A-Z0-9_]+\b/g,             // CONSTANT_CASE (ORDER_RBAC_VIOLATION)
    /\b[A-Za-z]\w*_[A-Za-z]\w*\b/g,          // snake_case / PREFIJO_Articulos
    /\b\w+:\d{2,4}\b/g,                      // archivo:línea (PedidosService:891)
    /\.[a-zA-Z_]\w*\(\)/g,                   // .metodo()
    /\b[45]\d\d\b/g,                         // HTTP 4xx/5xx crudo
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const tok = m[0];
      if (permitidas.has(tok.replace(/[`]/g, ''))) continue;
      // permitir números sueltos que NO son HTTP (ej "3 bolsas") — el patrón HTTP ya acota a 4xx/5xx
      found.add(tok);
    }
  }
  return [...found];
}

/**
 * Las siglas del rubro que el repo declara en `.tycon/advisors.yaml` (o `.yml`) → `qa_guide_terms`, en una línea
 * (`[A, B]`) o en renglones (`- A`). Sólo en el primer nivel, como `qa_guide`: anidada es una llave de otro bloque. Sin
 * repo, sin archivo o sin la llave, ninguna.
 */
function qaGuideTerms(repoRoot) {
  if (!repoRoot) return [];
  let txt = null;
  for (const nombre of ['advisors.yaml', 'advisors.yml']) {
    try { txt = fs.readFileSync(path.join(repoRoot, '.tycon', nombre), 'utf8'); break; } catch { /* el siguiente nombre */ }
  }
  if (txt === null) return [];
  const limpio = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
  const out = [];
  let juntando = false;
  for (const l of txt.split(/\r?\n/)) {
    if (juntando) {
      const item = l.match(/^\s+-\s*(.+)$/);
      if (item) { const t = limpio(item[1]); if (t) out.push(t); continue; }
      if (!l.trim() || /^\s*#/.test(l)) continue;
      juntando = false;
    }
    const m = l.match(/^qa_guide_terms\s*:\s*(.*)$/);
    if (!m) continue;
    const v = m[1].replace(/\s+#.*$/, '').trim();
    if (v === '') { juntando = true; continue; }
    const flow = v.match(/^\[(.*)\]$/);
    for (const x of flow ? flow[1].split(',') : [v]) { const t = limpio(x); if (t) out.push(t); }
  }
  return out;
}

// markdown inline mínimo (código `x`, negrita **x**) → HTML, sobre texto YA escapado.
function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Qué probó el arnés, en llano, para la insignia de cada criterio: `{ tier, badge, como }`. `como` sólo cuando lo probó
// corriendo la app (de punta a punta, o con un humo).
function estadoDelArnes(pa) {
  const v = (pa && pa.verdict) || 'NOT-RUN';
  if (v === 'RUNTIME') {
    const e2e = pa.fuentes && Array.isArray(pa.fuentes.e2e) && pa.fuentes.e2e.length > 0;
    return { tier: 'run', badge: '✓ el arnés ya lo probó', como: `Lo probó corriendo la app${e2e ? ', con una prueba de punta a punta' : ''}. Probarlo a mano es un segundo control.` };
  }
  if (v === 'NOT-VERIFIABLE' || v === 'WAIVED-USER') return { tier: 'wv', badge: 'La app no lo muestra: lo cubre una prueba del código', como: null };
  return { tier: 'pend', badge: 'El arnés no lo probó: probalo a mano', como: null };
}

// «el 20/10 a las 10:31», en la hora de la máquina que genera la guía
function cuandoEnLlano(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const dd = (n) => String(n).padStart(2, '0');
  return `el ${dd(d.getDate())}/${dd(d.getMonth() + 1)} a las ${dd(d.getHours())}:${dd(d.getMinutes())}`;
}

function renderHtml({ sid, title, preambleHtml, cards, stats, generatedAt, embeddedState, outFileName, manual = null }) {
  // con la opción de la organización prendida: quién marcó cada criterio a mano, y lo que falta
  const conMarca = manual && manual.prendida;
  const marcaDe = (c) => {
    if (!conMarca) return '';
    const m = (manual.marcas || {})[c.n];
    if (!m) return `<div class="manual manual-falta">✋ Falta que una persona lo marque como probado a mano.</div>`;
    return `<div class="manual manual-hecha">✋ ${c.tier === 'wv' ? 'Revisado' : 'Probado'} a mano por ${esc(m.quien)}, ${esc(cuandoEnLlano(m.ts))}.</div>`;
  };
  const criteriosConMarca = cards.filter((c) => !c.groupTitle);
  const faltan = conMarca ? (manual.faltan || []) : [];
  const avisoMarca = conMarca ? `<div class="aviso-manual"><b>Tu organización pide que una persona marque cada criterio como probado a mano.</b>
    ${faltan.length ? `Falta marcar ${faltan.length} de ${criteriosConMarca.length}: ${faltan.length > 1 ? 'los criterios' : 'el criterio'} ${esc(faltan.map((f) => f.n).join(', '))}. La historia no se cierra hasta que esté${faltan.length > 1 ? 'n' : ''} marcado${faltan.length > 1 ? 's' : ''}.` : 'Todos los criterios están marcados.'}
    ${manual.error ? `<br>No se pudieron leer las marcas (${esc(manual.error)}): la guía las muestra como faltantes.<br>` : ''}
    Para marcarlo, decíselo al agente en el chat, nombrando el criterio («probé a mano el criterio N»): el arnés te muestra qué vas a marcar y anota tu respuesta. El agente no puede marcarlo por vos.</div>` : '';
  const rows = cards.map((c) => c.groupTitle ? `
    <h2 class="group">${esc(c.groupTitle)}</h2>` : `
    <section class="ac" data-ac="${c.n}" data-tier="${c.tier}">
      <header>
        <span class="acnum">Criterio ${c.n}</span>
        <span class="badge badge-${c.tier}">${esc(c.badge)}</span>${
          c.roleNone ? `\n        <span class="badge badge-none">Sin login — lo verifica el sistema</span>`
          : (c.roles || []).map((r) => `\n        <span class="badge badge-role" title="Usuario con el que probar este AC">${esc(r)}</span>`).join('')
        }
      </header>
      <p class="actext">${mdInline(c.text)}</p>
      ${c.como ? `<p class="tiernote">${esc(c.como)}</p>` : ''}
      ${c.tierNote ? `<p class="tiernote">${mdInline(c.tierNote)}</p>` : ''}
      ${c.pruebas.length ? `<div class="block"><h4>Qué probar a mano</h4>${c.pruebas.map((p) => `
        <div class="prueba">
          ${p.escenario ? `<div class="do"><span class="dolabel">Hacé:</span> ${mdInline(p.escenario)}</div>` : ''}
          ${p.esperado ? `<div class="exp"><span class="explabel">Tenés que ver:</span> ${mdInline(p.esperado)}</div>` : ''}
        </div>`).join('')}</div>` : (c.needsPasos ? `<p class="faltan">✍️ Faltan los pasos en lenguaje de tester para este AC — pedíselos al dev. (Abajo queda el detalle técnico.)</p>` : '')}
      ${(c.acTextTech || c.tecnica.length || c.cmds.length) ? `<details class="cmds"><summary>Detalle técnico (para el dev)</summary>${
        c.acTextTech ? `<div class="prueba"><div class="do"><span class="dolabel">AC (texto técnico):</span> ${mdInline(c.acTextTech)}</div></div>` : ''
      }${
        c.tecnica.map((p) => `<div class="prueba"><div class="do"><span class="dolabel">Escenario:</span> ${mdInline(p.escenario)}</div>${p.esperado ? `<div class="exp"><span class="explabel">Esperado:</span> ${mdInline(p.esperado)}</div>` : ''}</div>`).join('')
      }${c.cmds.map((x) => `<pre>${esc(x)}</pre>`).join('')}</details>` : ''}
      <div class="verdict">
        <div class="opts">
          <label><input type="radio" name="v${c.n}" value="pass"> ✅ Pasó</label>
          <label><input type="radio" name="v${c.n}" value="fail"> ❌ Falló</label>
          <label><input type="radio" name="v${c.n}" value="na"> ⏭️ No aplica</label>
          <button type="button" class="clr" onclick="limpiar(${c.n})">Limpiar</button>
        </div>
        <textarea placeholder="Notas del tester (qué viste, capturas, nº de orden usada...)" data-notes="${c.n}"></textarea>
      </div>
      ${marcaDe(c)}
    </section>`).join('\n');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guía QA — Story ${esc(sid)}</title>
<style>
  :root{--bg:#f7f8fa;--card:#fff;--ink:#1a2028;--muted:#5b6470;--line:#e3e7ec;--accent:#2563eb;
    --run:#0a7d32;--wv:#7c3aed;--pend:#c2410c;}
  @media (prefers-color-scheme:dark){:root{--bg:#0f1319;--card:#171c24;--ink:#e6e9ee;--muted:#9aa4b0;--line:#2a313b;}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:24px 18px 80px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--muted);margin:0 0 18px}
  .summary{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 24px}
  .pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:13px}
  .pill b{color:var(--accent)}
  .preamble{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:24px}
  .preamble h2{font-size:16px;margin:0 0 8px} .preamble pre{white-space:pre-wrap}
  h2.group{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)}
  h2.group:first-of-type{margin-top:8px}
  .ac{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px;scroll-margin-top:12px}
  .ac header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .acnum{font-weight:700}
  .badge{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;border-radius:6px;padding:3px 8px;color:#fff}
  .badge-run{background:var(--run)} .badge-wv{background:var(--wv)} .badge-pend{background:var(--pend)}
  .badge-role{background:#0e7490} .badge-none{background:#64748b;text-transform:none;letter-spacing:0}
  .actext{margin:0 0 8px}
  .tiernote{color:var(--muted);font-size:13px;margin:0 0 10px;border-left:3px solid var(--line);padding-left:10px}
  .block{margin:12px 0} .block h4{margin:0 0 6px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
  .prueba{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;background:rgba(127,127,127,.04)}
  .prueba .do{margin-bottom:6px} .prueba .exp{color:var(--ink)}
  .dolabel,.explabel{display:inline-block;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.03em;margin-right:6px}
  .dolabel{color:var(--accent)} .explabel{color:var(--run)}
  @media (prefers-color-scheme:dark){.explabel{color:#4ade80}}
  code{background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px;font-size:13px}
  details.cmds{margin:8px 0} details.cmds summary{cursor:pointer;color:var(--muted);font-size:13px}
  pre{background:rgba(127,127,127,.1);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:12.5px}
  .faltan{color:var(--pend);font-size:13px;margin:8px 0;border-left:3px solid var(--pend);padding-left:10px}
  .verdict{display:flex;flex-direction:column;gap:8px;margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}
  .verdict .opts{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .verdict label{margin-right:6px;font-size:14px;cursor:pointer}
  .verdict textarea{width:100%;min-height:52px;border:1px solid var(--line);border-radius:8px;padding:8px;background:transparent;color:inherit;font:inherit;resize:vertical}
  button.clr{background:transparent;color:var(--muted);border:1px solid var(--line);padding:3px 10px;font-size:12px;border-radius:6px;margin-left:auto}
  button.clr:hover{color:var(--ink);border-color:var(--muted)}
  .toolbar{position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:5;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line);margin-bottom:16px}
  button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  .prog{color:var(--muted);font-size:13px;margin-left:auto}
  .saved{color:var(--run);font-size:13px} @media (prefers-color-scheme:dark){.saved{color:#4ade80}}
  .ac.done-pass{border-color:var(--run)} .ac.done-fail{border-color:#c0392b}
  .manual{margin-top:12px;padding:10px 12px;border-radius:8px;font-size:14px}
  .manual-falta{border:1px solid var(--pend)} .manual-hecha{border:1px solid var(--run)}
  .aviso-manual{border:1px solid var(--pend);border-radius:10px;padding:12px 14px;margin:0 0 18px}
  .aviso-manual b{display:block;margin-bottom:4px}
  .storage-note{background:rgba(37,99,235,.08);border:1px solid var(--accent);border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:16px;color:var(--ink)}
</style></head>
<body><div class="wrap">
  <div class="toolbar">
    <button onclick="guardar()">💾 Guardar</button>
    <span class="saved" id="saved"></span>
    <span class="prog" id="prog"></span>
  </div>
  <script id="qa-state" type="application/json">${JSON.stringify(embeddedState || {})}</script>
  <h1>Guía de prueba manual — Story ${esc(sid)}</h1>
  <p class="sub">${esc(title)} · generada ${esc(generatedAt)} · la guía dice qué probó el arnés; lo demás se prueba a mano</p>
  <div class="summary">
    <span class="pill"><b>${stats.total}</b> criterios</span>
    <span class="pill">✓ el arnés ya probó <b>${stats.runtime}</b></span>
    <span class="pill"><b>${stats.pending != null ? stats.pending : Math.max(0, stats.total - stats.runtime - stats.waived - stats.notVerifiable)}</b> para probar a mano</span>
    <span class="pill"><b>${stats.waived + stats.notVerifiable}</b> que la app no puede mostrar</span>${conMarca ? `
    <span class="pill">✋ marcados a mano <b>${criteriosConMarca.length - faltan.length}</b> de ${criteriosConMarca.length}</span>` : ''}
  </div>
  ${avisoMarca}
  <div class="storage-note">
    📝 Tus respuestas (Pasó / Falló / No aplica + notas) se van recordando mientras trabajás. Cuando
    termines (o cuando quieras cortar), tocá <b>💾 Guardar</b>: escribe tus selecciones dentro de
    <b>este mismo archivo HTML</b>, así quedan guardadas y viajan con la historia. Cada caso tiene
    un botón <b>Limpiar</b> para borrar su selección.
  </div>
  ${preambleHtml ? `<div class="preamble"><h2>Antes de empezar — preparar el entorno</h2>${preambleHtml}</div>` : ''}
  ${rows}
</div>
<script>
  var SID=${JSON.stringify(sid)};
  // Nombre del archivo que "Guardar" sobrescribe — DEBE ser el mismo que generó el pipeline
  // (basename del story), no un derivado del SID, o Guardar crea un archivo huérfano paralelo.
  var FNAME=${JSON.stringify(outFileName || (String(sid).replace(/\./g, '-') + '-guia-qa.html'))};
  var KEY='qa-guide:'+SID;
  // Estado inicial = lo guardado DENTRO del archivo (script#qa-state) ∪ lo que quedó en este
  // navegador (localStorage, por si hubo ediciones sin Guardar). El archivo es la base.
  function embedded(){try{return JSON.parse(document.getElementById('qa-state').textContent||'{}')}catch(e){return {}}}
  function local(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){return {}}}
  function saveLocal(s){try{localStorage.setItem(KEY,JSON.stringify(s))}catch(e){}}
  var state=Object.assign({},embedded(),local());
  function dirtyMark(){var el=document.getElementById('saved');if(el)el.textContent='● cambios sin guardar';}
  function apply(){
    document.querySelectorAll('.ac').forEach(function(sec){
      var n=sec.getAttribute('data-ac'), v=state['v'+n];
      sec.classList.remove('done-pass','done-fail');
      if(v==='pass')sec.classList.add('done-pass'); if(v==='fail')sec.classList.add('done-fail');
      var r=sec.querySelector('input[value="'+v+'"]'); if(r)r.checked=true; else {var rs=sec.querySelectorAll('input[type=radio]');rs.forEach(function(x){x.checked=false});}
      var t=sec.querySelector('textarea'); if(t)t.value=state['n'+n]!=null?state['n'+n]:'';
    });
    var tot=document.querySelectorAll('.ac').length, done=Object.keys(state).filter(function(k){return k[0]==='v'&&state[k]}).length;
    document.getElementById('prog').textContent=done+' / '+tot+' evaluados';
  }
  document.addEventListener('change',function(e){
    var m=e.target.name&&e.target.name.match(/^v(\\d+)$/);
    if(m){state['v'+m[1]]=e.target.value;saveLocal(state);apply();dirtyMark();}
    if(e.target.hasAttribute&&e.target.hasAttribute('data-notes')){state['n'+e.target.getAttribute('data-notes')]=e.target.value;saveLocal(state);dirtyMark();}
  });
  document.addEventListener('input',function(e){
    if(e.target.hasAttribute&&e.target.hasAttribute('data-notes')){state['n'+e.target.getAttribute('data-notes')]=e.target.value;saveLocal(state);dirtyMark();}
  });
  window.limpiar=function(n){delete state['v'+n];delete state['n'+n];saveLocal(state);apply();dirtyMark();};
  // Guardar = escribir el estado DENTRO de este archivo HTML. Con la File System Access API
  // (Chrome/Edge) se sobrescribe el archivo abierto o se elige dónde; si no, cae a descarga.
  window.guardar=async function(){
    document.getElementById('qa-state').textContent=JSON.stringify(state);
    var full='<!doctype html>\\n'+document.documentElement.outerHTML;
    var fname=FNAME;
    try{
      if(window.showSaveFilePicker){
        var h=await window.showSaveFilePicker({suggestedName:fname,types:[{description:'HTML',accept:{'text/html':['.html']}}]});
        var w=await h.createWritable();await w.write(full);await w.close();
        document.getElementById('saved').textContent='✓ guardado en el archivo';return;
      }
    }catch(e){if(e&&e.name==='AbortError'){return;}}
    var b=new Blob([full],{type:'text/html'});var a=document.createElement('a');
    a.href=URL.createObjectURL(b);a.download=fname;a.click();
    document.getElementById('saved').textContent='✓ descargado — reemplazá el archivo original con éste';
  };
  window.addEventListener('beforeunload',function(e){if(document.getElementById('saved').textContent.indexOf('sin guardar')>=0){e.preventDefault();e.returnValue='';}});
  apply();
</script>
</body></html>`;
}

// ¿La story toca UI (donde un tester humano aporta)? Fuente única: lib/ui-signal.js (señal genérica + evidence.fe_paths del repo; nada de productos en duro).
// La firma (content, fm) se mantiene: acá el frontmatter llega ya separado.
function isUiStory(content, fm, repoRoot) {
  return require(path.join(__dirname, 'lib', 'ui-signal.js')).touchesUiParts(fm, content, repoRoot);
}

// Dónde viven la guía del tester, las revisiones de legibilidad y la maqueta de una story, y con qué clave.
// La maqueta la ubica esta MISMA función, para que su nombre y el que busca la revisión no puedan discrepar.
// La guía se nombra con la CLAVE de la story: con un número que se repite en el repo, dos stories que
// comparten la carpeta qa/ escribirían y leerían el mismo `<id>-pasos.md`, y el chequeo de una daría por buena la guía de la
// otra. Con número único la clave es el número: el nombre de siempre. Si la matriz no computa, tira: no hay clave.
function qaLocation(storyPath) {
  const abs = path.resolve(storyPath);
  const matrix = require(path.join(__dirname, 'runtime-matrix.js')).compute({ storyPath: abs });
  if (matrix.structuralError) throw new Error(`la matriz no computa (${matrix.structuralError})`);
  const sid = matrix.sid;
  const qk = matrix.key || sid;
  const qaDir = require(path.join(__dirname, 'lib', 'qa-dir.js')).qaDirFor(abs, [qk, sid]);
  return { qaDir, qk, sid, repoRoot: matrix.repoRoot, matrix };
}

// Dónde se buscan las pantallas de la story: su repo, el workspace (rutas escritas desde ahí) y los repos acompañantes
// declarados en `.tycon/advisors.yaml`, cada uno en el worktree de la rama de la story — el mismo criterio con que la
// matriz y el portón de pruebas eligen el hermano (`companionRoots`). Una ruta que nombra a un hermano (`<hermano>/x`,
// `../<hermano>/x`, `(<hermano>) x`) se busca sólo en el que se eligió: en el checkout principal estaría el código de
// otra rama. Una config que no se puede leer se DICE: callada, las pantallas de un acompañante se
// leerían como «no están en el disco» sin que nadie supiera por qué.
function screenSearch(repoRoot, notes, storyPath) {
  if (!repoRoot) return { roots: [], resolve: undefined };
  const roots = screenRoots(repoRoot, notes, storyPath);
  const companions = roots.slice(2);
  const lib = require(path.join(__dirname, 'lib', 'companion-repos.js'));
  // El repo de git de una carpeta (el mismo para el checkout principal y todos sus worktrees), o null.
  const repoGit = (dir) => {
    const r = require('child_process').spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    return r.status === 0 ? lib.real(String(r.stdout || '').trim()) : null;
  };
  const propio = repoGit(repoRoot);
  if (!propio && notes) notes.push(`no pude identificar el repo git de la story (${repoRoot}): una pantalla escrita como «(<repo de la story>) ruta» se busca en la carpeta con ese nombre, que puede estar en otra rama`);
  const resolve = (entrada) => {
    const pref = lib.parseRepoPrefixed(entrada);
    if (pref) {
      let { root } = lib.resolveRepoRef(pref.ref, repoRoot, companions);
      if (!root) return undefined;
      // `(<repo de la story>) x` desde su worktree: la carpeta vecina con ese nombre es el checkout principal, en otra rama.
      if (propio && repoGit(root) === propio) root = repoRoot;
      const abs = path.join(root, pref.rest);
      // Como las otras dos formas, la ruta no sale de su repo.
      const r = lib.real(root);
      const x = lib.real(abs);
      return x === r || x.startsWith(r + path.sep) ? abs : null;
    }
    const d = String(entrada || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
    const r = lib.resolveDeclared(d, repoRoot, companions);
    if (r.where) return path.join(r.root, r.rel);
    const nombra = companions.some((c) => { const n = lib.label(c); return d.startsWith(`${n}/`) || d.startsWith(`../${n}/`); });
    return nombra ? null : undefined;
  };
  return { roots, resolve };
}

function screenRoots(repoRoot, notes, storyPath) {
  if (!repoRoot) return [];
  const { parseEvidenceConfig } = require(path.join(__dirname, 'lib', 'evidence-config.js'));
  let companions = [];
  const decir = (m) => { if (notes) notes.push(m); };
  // `parseEvidenceConfig` trata un yaml ilegible como «sin yaml»: acá se mira si existe y no se lee.
  for (const name of ['advisors.yaml', 'advisors.yml']) {
    const f = path.join(repoRoot, '.tycon', name);
    if (fs.existsSync(f)) {
      try { fs.accessSync(f, fs.constants.R_OK); } catch (e) { decir(`no pude leer ${path.join('.tycon', name)} (${e.code || e.message}): las pantallas se buscan sólo en el repo de la story y en su carpeta`); }
      break;
    }
  }
  try {
    const cfg = parseEvidenceConfig(repoRoot);
    companions = cfg.roots || [];
    for (const m of cfg.missing || []) decir(`repo acompañante declarado que no está en el disco (sus pantallas no se pueden encontrar): ${m}`);
    for (const w of cfg.warnings || []) decir(w);
    // Cada hermano, en el worktree de la rama de la story (o el declarado, con su aviso): la misma elección que la matriz.
    if (companions.length) {
      try { companions = require(path.join(__dirname, 'lib', 'companion-repos.js')).companionRoots(repoRoot, storyPath); } catch (e) {
        decir(`no pude elegir el worktree de los repos acompañantes (${e.message}): sus pantallas se buscan en las carpetas declaradas, que pueden estar en otra rama`);
      }
    }
  } catch (e) {
    decir(`no pude leer los repos acompañantes de .tycon/advisors.yaml (${e.message}): las pantallas se buscan sólo en el repo de la story y en su carpeta`);
  }
  return [repoRoot, path.dirname(repoRoot), ...companions];
}

// Un campo del archivo de legibilidad de la pantalla: `clave: a, b` en la línea, o `clave:` y debajo `- a` / `- b`.
function readListField(md, key) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l.trim()));
  if (i === -1) return { present: false, values: [] };
  const inline = lines[i].trim().slice(key.length + 1).trim();
  if (inline) return { present: true, values: inline.split(',').map((v) => v.trim().replace(/^`|`$/g, '')).filter(Boolean) };
  const values = [];
  for (const l of lines.slice(i + 1)) {
    const m = l.match(/^\s*-\s*(.+?)\s*$/);
    if (!m) { if (l.trim()) break; continue; }
    values.push(m[1].replace(/^`|`$/g, ''));
  }
  return { present: true, values };
}

// ── Capa 4 de la PANTALLA ─────────────────────────────────────────────────────────────────────────────
// Una ventana puede pasar todos los controles y verse «inentendible» en staging si la capa 4 lee sólo la guía:
// las marcas sobre textos de la pantalla se «resolverían» reescribiendo la guía, y el texto malo quedaría en el
// código. Por eso: (a) la pasada del tester también
// lee la pantalla y deja `<clave>-legibilidad-ui.md`; (b) una marca citada con «» que sigue en la pantalla frena.
function uiReadabilityCheck({ content, fm, qaDir, qk, repoRoot, storyPath }) {
  const ui = require(path.join(__dirname, 'lib', 'ui-texts.js'));
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const problems = []; const notes = [];
  const busqueda = screenSearch(repoRoot, notes, storyPath);
  const { found, missing } = ui.screenFiles(fm, body, busqueda.roots, busqueda.resolve);
  // Una pantalla declarada que no está no se puede revisar: frena. Callada, una story cuyas
  // pantallas no se encuentran pasaría el candado sin que nadie mirara nada.
  if (missing.length) problems.push(`(7) Pantallas declaradas por la story que no están en el disco (no se pueden revisar): ${missing.join(', ')} — si la story ya no las toca, sacalas de la lista; si viven en otro repo, declaralo en .tycon/advisors.yaml → evidence.companion_repos`);
  // Una pantalla que está pero no se lee tampoco se puede revisar, haya o no marcas citadas.
  for (const s of found) {
    try { fs.accessSync(s.abs, fs.constants.R_OK); } catch (e) { problems.push(`(7) No pude leer la pantalla ${s.rel} (${e.code || e.message}): no se puede revisar lo que no se ve.`); }
  }

  const uiPath = path.join(qaDir, `${qk}-legibilidad-ui.md`);
  if (!isFile(uiPath)) {
    problems.push(`(7) Falta la revisión de legibilidad de la PANTALLA (la pasada del "tester no técnico" sobre los textos y las capturas): ${uiPath} con "veredicto: OK", "screens:" y "captures:"`);
  } else {
    const md = fs.readFileSync(uiPath, 'utf8');
    // Tolera el veredicto en negrita (`**veredicto**: OK`, `veredicto: **OK**`), como lo escribe un revisor.
    if (!/^[\s*_-]*veredicto[*_]*\s*:\s*[*_]*\s*ok\b/im.test(md)) {
      problems.push(`(7) La revisión de la pantalla no tiene "veredicto: OK" — las marcas se resuelven EN LA PANTALLA (el código), no en la guía; después se re-revisa: ${uiPath}`);
    }
    const caps = readListField(md, 'captures');
    if (!caps.present || !caps.values.length) {
      problems.push(`(7) La revisión de la pantalla no dice qué capturas miró — agregá "captures:" con las rutas, o "captures: ninguna — <motivo>": ${uiPath}`);
    } else {
      for (const c of caps.values.filter((v) => /\.(png|jpe?g|webp)$/i.test(v))) {
        const cands = path.isAbsolute(c) ? [c] : [path.join(qaDir, c), repoRoot && path.join(repoRoot, c)].filter(Boolean);
        if (!cands.some(isFile)) problems.push(`(7) "captures:" nombra una captura que no existe: ${c}`);
      }
    }
    const scr = readListField(md, 'screens');
    const cubre = (rel) => scr.values.some((v) => rel === v || rel.endsWith(`/${v}`) || v.endsWith(`/${rel}`) || v === rel);
    const sinLeer = found.map((s) => s.rel).filter((rel) => !cubre(rel));
    if (!scr.present) problems.push(`(7) La revisión de la pantalla no dice qué pantallas leyó — agregá "screens:" con cada una: ${found.map((s) => s.rel).join(', ') || '(la story no declara ninguna en disco)'}`);
    else if (sinLeer.length) problems.push(`(7) La revisión de la pantalla no leyó estas pantallas de la story: ${sinLeer.join(', ')} — pasale sus textos (qa-guide.js --ui-texts) y re-revisá`);
  }

  // (8) Una marca resuelta sólo en la guía: el texto citado sigue en una pantalla de la story.
  for (const file of [`${qk}-legibilidad.md`, `${qk}-legibilidad-ui.md`].map((f) => path.join(qaDir, f)).filter(isFile)) {
    // Una línea `differs:` declara una diferencia con la maqueta, no es una marca de la revisión (como
    // `keep:`). Se vacía conservando la numeración: una `differs:` cuyo texto sigue en la pantalla no frena acá.
    const sinDiffers = fs.readFileSync(file, 'utf8').split('\n').map((l) => (/\bdiffers:/.test(l) ? '' : l)).join('\n');
    for (const mk of ui.quotedMarks(sinDiffers)) {
      const hits = ui.whereInScreens(mk.quote, found);
      for (const h of hits.filter((x) => x.unreadable)) problems.push(`(8) No pude leer ${h.rel} (${h.unreadable}) para ver si la marca «${mk.quote}» sigue en la pantalla: no mirar no es «ya no está».`);
      const vistos = hits.filter((x) => !x.unreadable);
      if (!vistos.length) continue;
      const donde = vistos.map((h) => `${h.rel}:${h.line}`).join(', ');
      if (mk.keep) notes.push(`marca que se queda a propósito («${mk.quote}» sigue en ${donde}) — keep: ${mk.keep}`);
      else problems.push(`(8) La marca «${mk.quote}» (${path.basename(file)}:${mk.line}) se resolvió en la guía, pero el texto sigue en la pantalla: ${donde}. Corregí la PANTALLA; si el texto se queda a propósito, escribí en esa línea "keep: <por qué>".`);
    }
  }
  return { problems, notes, screens: found, missing };
}

// ── Capas 9 y 10 de la PANTALLA ─────────────────────────────────────────────────────────────────────────
// El dueño aprueba una maqueta con el plan (mockup.js) y queda su
// huella; acá se exige que (9) la maqueta aprobada esté intacta, y (10) lo construido tenga sus textos. Sin aprobación
// anotada (stories sin aprobación, o el chequeo corrido fuera del pipeline) no se compara y se dice; con
// `--mockup-sha` (lo pasa «Preparar el commit» desde el marcador) borrar el archivo de aprobación no saltea la comparación.
function mockupLayers({ qaDir, qk, mockupSha, screens }) {
  const mk = require(path.join(__dirname, 'mockup.js'));
  const problems = []; const notes = [];
  const mockupPath = path.join(qaDir, `${qk}-mockup.html`);
  const approvalPath = path.join(qaDir, `${qk}-mockup-approval.json`);
  const uiPath = path.join(qaDir, `${qk}-legibilidad-ui.md`);
  const h12 = (s) => String(s || '').slice(0, 12);
  const ap = mk.readApproval(approvalPath);
  if (ap.state === 'absent' && !mockupSha) {
    notes.push('sin maqueta aprobada: no se compara (story aprobada antes de la 7.30, o fuera del pipeline)');
    return { problems, notes };
  }
  // (9) la maqueta aprobada, intacta
  if (ap.state === 'absent') {
    problems.push(`(9) el pipeline aprobó una maqueta (${h12(mockupSha)}) y su aprobación no está en el repo: ${approvalPath} — va en el commit junto con la maqueta`);
    return { problems, notes };
  }
  if (ap.state === 'bad') {
    problems.push(`(9) no pude leer la aprobación de la maqueta (${approvalPath}): ${ap.error}`);
    return { problems, notes };
  }
  if (mockupSha && ap.data.sha256 !== mockupSha) {
    problems.push(`(9) el pipeline aprobó una maqueta (${h12(mockupSha)}) y la del repo es otra (${h12(ap.data.sha256)}): ${approvalPath}`);
    return { problems, notes };
  }
  let html;
  try { html = fs.readFileSync(mockupPath, 'utf8'); } catch (e) {
    problems.push(`(9) la maqueta aprobada no está (o no se puede leer: ${e.code || e.message}): ${mockupPath}`);
    return { problems, notes };
  }
  const hoy = mk.mockupHash(html);
  if (hoy !== ap.data.sha256) {
    problems.push(`(9) la maqueta cambió después de aprobada (aprobada ${h12(ap.data.sha256)}, hoy ${h12(hoy)}): mostrásela al dueño y aprobala de nuevo: marker.js approve-mockup --approved "<cita>"`);
    return { problems, notes };
  }
  const v = mk.validateMockupHtml(html);
  if (!v.ok) {
    problems.push(`(9) la maqueta no pasa mockup.js check: ${v.findings.map((x) => (x.line ? `línea ${x.line}: ` : '') + x.what).join('; ')}`);
    return { problems, notes };
  }
  // (10) lo construido tiene los textos de la maqueta
  if (!isFile(uiPath)) return { problems, notes };   // la capa (7) ya pide el archivo
  const md = fs.readFileSync(uiPath, 'utf8');
  const nombre = path.basename(mockupPath);
  const campo = readListField(md, 'mockup');
  if (!campo.present || !campo.values.some((x) => x === nombre || x.endsWith(`/${nombre}`))) {
    problems.push(`(10) la revisión de la pantalla no nombra la maqueta aprobada: agregá "mockup: ${nombre}" en ${uiPath} (la pasada del tester compara la pantalla contra ella)`);
  }
  // El motivo va en la MISMA línea: con `\s*` un `mockup-compare: no —` vacío tomaría la línea de abajo.
  const imposible = md.match(/^[ \t]*[-*]?[ \t]*mockup-compare:[ \t]*no[ \t]*[—–-]+[ \t]*(\S.*?)[ \t]*$/im);
  if (imposible) {
    notes.push(`comparación con la maqueta declarada imposible: ${imposible[1]}`);
    return { problems, notes };
  }
  if (!screens.length) {
    problems.push(`(10) no se puede comparar contra la maqueta: no encontré pantallas de la story en el disco (busco .tsx, .jsx, .vue, .svelte en files_to_create, files_to_modify y la File List). Si las pantallas son de otro tipo, escribí \`mockup-compare: no — <motivo>\` en ${uiPath}`);
    return { problems, notes };
  }
  // la capa (9) ya exigió `check` en 0 (con la meta generator), así que mockupTexts no da null acá
  const cmp = mk.compareWithScreens({ texts: mk.mockupTexts(html), screens, md });
  for (const u of cmp.unreadable) problems.push(`(10) no pude leer la pantalla ${u.rel} (${u.error}) para compararla con la maqueta: no mirar no es «está» ni «falta».`);
  for (const t of cmp.missing) {
    problems.push(`(10) la maqueta muestra el ${t.kind} «${t.text}» (pantalla «${t.screenName || t.screen + 1}») y no está en ninguna pantalla de la story: corregí la pantalla, o actualizá la maqueta y aprobala de nuevo; si el texto está y el chequeo no lo ve (textos de traducción), escribí \`- «${t.text}» — differs: <por qué>\` en ${uiPath}`);
  }
  for (const w of cmp.warnings || []) notes.push(`aviso: la maqueta muestra el motivo «${w.text}» de una casilla deshabilitada (pantalla «${w.screenName || w.screen + 1}») y no lo encontré ni como atributo title ni como texto: si es un tooltip armado de otra forma, no hace falta nada`);
  for (const d of cmp.declared) notes.push(`diferencia declarada con la maqueta: «${d.text}» — differs: ${d.motivo}`);
  for (const x of cmp.extras) notes.push(`en la pantalla y no en la maqueta: «${x.text}» (${x.rel}:${x.line})`);
  return { problems, notes };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
  const storyPath = opt('--story');
  if (!storyPath || !isFile(storyPath)) {
    console.error('qa-guide.js: --story <abs .md> requerido y existente.');
    process.exit(2);
  }
  const abs = path.resolve(storyPath);
  const { content, fm } = readStory(abs);

  let loc;
  try { loc = qaLocation(abs); } catch (e) {
    console.error(`qa-guide.js: ${e.message}.`);
    process.exit(2);
  }
  const { matrix, sid, qk, qaDir: qaDirStory } = loc;
  const titleM = content.match(/^#\s+(.+)$/m);
  const title = titleM ? titleM[1].replace(/[#*`]/g, '').trim() : sid;

  const acs = parseAcsWithText(content);
  const tests = parseTestsFull(content);
  // La atribución de evidencia la decide runtime-matrix.js (repo de la story + companions
  // declarados): esta guía usa los MISMOS dirs, no re-barre el workspace.
  // Una copia local del barrido por hermanos mostraría en la guía smokes de OTROS repos.
  const evidenceDirs = matrix.evidenceDirs || [];
  // El registro de humos se nombra con la CLAVE de la evidencia, que la matriz ya calculó.
  const smokeByAc = readSmokeLedgerByAc(evidenceDirs, matrix.key || sid);

  // preámbulo (setup del entorno) — --preamble o convención specs/qa/preamble.md del repo de la story
  let preambleHtml = '';
  const preamblePath = opt('--preamble') ||
    [path.join(qaDirStory, 'preamble.md')].find(isFile);
  if (preamblePath && isFile(preamblePath)) {
    const md = fs.readFileSync(preamblePath, 'utf8');
    // render muy básico: encabezados, listas, code fences, párrafos.
    preambleHtml = md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```([\s\S]*?)```/g, (_m, code) => `<pre>${code.trim()}</pre>`)
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .split(/\n{2,}/).map((b) => /^<(h3|ul|pre)/.test(b.trim()) ? b : (b.trim() ? `<p>${b.trim()}</p>` : '')).join('\n');
  }

  // Pasos EN CRIOLLO para el tester (fuente separada de la tabla dev): --steps o <repo>/qa/<clave>-pasos.md
  let pasosByAc = {};
  let sequence = [];
  let defaultRole = null;
  let openApp = null;
  let pasosRaw = '';
  const pasosPath = opt('--steps') ||
    [path.join(qaDirStory, `${qk}-pasos.md`)].find(isFile);
  // Lo viejo: con número compartido, `<id>-pasos.md` / `<id>-legibilidad.md` no dicen de cuál story son. No cuentan,
  // no se tocan, y se nombran para que nadie crea que la guía falta por descuido.
  const qaViejos = qk === sid ? [] : [`${sid}-pasos.md`, `${sid}-legibilidad.md`]
    .map((f) => path.join(qaDirStory, f)).filter(isFile);
  if (pasosPath && isFile(pasosPath)) {
    const rawMd = fs.readFileSync(pasosPath, 'utf8');
    pasosByAc = parsePasos(rawMd);
    sequence = parsePasosSequence(rawMd);
    defaultRole = parseDefaultRole(rawMd);
    openApp = parseOpenApp(rawMd);
    pasosRaw = rawMd;
  }

  // ── MODO --ui-texts: los textos que ve el usuario en cada pantalla de la story, sin el código alrededor.
  // Es el insumo de la pasada del "tester no técnico" sobre la pantalla («Probar en vivo», parte 7), junto con las capturas del gate.
  if (argv.includes('--ui-texts')) {
    const ui = require(path.join(__dirname, 'lib', 'ui-texts.js'));
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
    const avisos = [];
    const busqueda = screenSearch(matrix.repoRoot, avisos, abs);
    const { found, missing } = ui.screenFiles(fm, body, busqueda.roots, busqueda.resolve);
    for (const a of avisos) console.log(`· ${a}`);
    if (!found.length) console.log(`qa-guide --ui-texts: la story ${sid} no declara pantallas que estén en el disco (.tsx/.jsx/.vue/.svelte).`);
    for (const s of found) {
      console.log(`## ${s.rel}`);
      const ts = ui.visibleTexts(fs.readFileSync(s.abs, 'utf8'));
      if (!ts.length) console.log('- (sin textos visibles detectados: mirá las capturas)');
      for (const t of ts) console.log(`- ${t.text}`);
      console.log('');
    }
    for (const m of missing) console.log(`· declarada y no está en el disco: ${m}`);
    // Con una maqueta aprobada, lo que la pantalla tiene distinto de ella es insumo de la pasada del tester.
    const mk = require(path.join(__dirname, 'mockup.js'));
    const qaDirU = qaDirStory;
    const mockupPath = path.join(qaDirU, `${qk}-mockup.html`);
    const ap = mk.readApproval(path.join(qaDirU, `${qk}-mockup-approval.json`));
    if (ap.state === 'bad') console.log(`· no pude leer la aprobación de la maqueta: ${ap.error}`);
    if (ap.state === 'ok' && !isFile(mockupPath)) console.log(`· la maqueta aprobada no está: ${mockupPath}`);
    const textosMaqueta = ap.state === 'ok' && isFile(mockupPath) ? mk.mockupTexts(fs.readFileSync(mockupPath, 'utf8')) : null;
    if (ap.state === 'ok' && isFile(mockupPath) && !textosMaqueta) console.log(`· la maqueta aprobada no es una maqueta de mockup.js (sin la meta generator): ${mockupPath}`);
    if (textosMaqueta) {
      const uiPath = path.join(qaDirU, `${qk}-legibilidad-ui.md`);
      const cmp = mk.compareWithScreens({ texts: textosMaqueta, screens: found,
        md: isFile(uiPath) ? fs.readFileSync(uiPath, 'utf8') : '' });
      const lista = (xs, f) => (xs.length ? xs.forEach((x) => console.log(f(x))) : console.log('- (ninguno)'));
      console.log(`## Maqueta aprobada (${path.basename(mockupPath)})`);
      console.log('### En la maqueta y no en la pantalla');
      lista(cmp.missing, (t) => `- «${t.text}» (${t.kind}, pantalla «${t.screenName || t.screen + 1}»)`);
      console.log('### En la pantalla y no en la maqueta');
      lista(cmp.extras, (x) => `- «${x.text}» (${x.rel}:${x.line})`);
      if ((cmp.warnings || []).length) {
        console.log('### Avisos: motivos de casillas deshabilitadas que no encontré');
        lista(cmp.warnings, (t) => `- «${t.text}» (pantalla «${t.screenName || t.screen + 1}»)`);
      }
      console.log('### Diferencias declaradas');
      lista(cmp.declared, (d) => `- «${d.text}» — differs: ${d.motivo}`);
      for (const u of cmp.unreadable) console.log(`· no pude leer ${u.rel} (${u.error}) para compararla con la maqueta`);
    }
    process.exit(0);
  }

  // ── MODO --check (candado DODRT-C7): para una story de UI, la guía de tester tiene que estar
  // LISTA antes de cerrar. Exige los 4 pasos: (1) archivo de pasos-tester, (2) que cubra cada AC
  // verificado corriendo, (3) sin jerga de software (determinístico), (4) review de legibilidad
  // independiente con "veredicto: OK". 1-3 son candados duros infakeables (chequean el texto real);
  // 4 es un artefacto de la pasada del "tester no técnico" (evidencia, tier DoD).
  if (argv.includes('--check')) {
    const isUi = isUiStory(content, fm, matrix.repoRoot);
    if (!isUi) { console.log(`qa-guide --check: story ${sid} no toca UI → no requiere guía de tester.`); process.exit(0); }
    const problems = [];
    const qaDir = qaDirStory;
    // las siglas del rubro que declara el repo del producto no son jerga
    const siglas = qaGuideTerms(matrix.repoRoot);
    const runtimeAcs = acs.map((a) => a.n).filter((n) => (matrix.perAc[n] || {}).verdict === 'RUNTIME');
    // 🔴 La ruta del mensaje se CALCULA de la misma forma que la búsqueda. Si no, el mensaje indica
    // `specs/qa/...` mientras el script busca en `<repo>/qa/...`: manda a crear el archivo donde nunca
    // se lo encuentra, y el gate sigue fallando aunque se obedezca. Una story nueva lo muestra en frío.
    const pasosEsperado = path.join(qaDirStory, `${qk}-pasos.md`);
    if (!pasosPath) problems.push(`(1) Falta el archivo de pasos-tester: ${pasosEsperado}`);
    const sinPasos = runtimeAcs.filter((n) => !tienePasos(pasosByAc[n]));
    if (sinPasos.length) problems.push(`(2) ACs verificados corriendo SIN pasos-tester: ${sinPasos.map((n) => '#' + n).join(', ')}`);
    for (const n of Object.keys(pasosByAc)) {
      const b = pasosByAc[n];
      const txt = [b.desc, ...b.pairs.flatMap((p) => [p.escenario, p.esperado])].join(' ');
      const j = detectJargon(txt, siglas);
      if (j.length) problems.push(`(3) AC #${n}: los pasos tienen JERGA de software (reescribir en criollo): ${j.slice(0, 6).join(', ')}`);
    }
    const readPath = path.join(qaDir, `${qk}-legibilidad.md`);
    if (!isFile(readPath)) problems.push(`(4) Falta la review de legibilidad (pasada del "tester no técnico"): ${readPath} con "veredicto: OK"`);
    else if (!/veredicto:\s*ok/i.test(fs.readFileSync(readPath, 'utf8'))) problems.push(`(4) La review de legibilidad no tiene "veredicto: OK" — resolver las marcas del tester y re-revisar.`);
    // (5) DODRT-C7: cada AC verificado corriendo declara CON QUÉ USUARIO se prueba
    // (badge de rol en la guía). Explícito por AC (`Usuario: <rol>`) o un `Usuario por defecto:`
    // al tope del archivo. Un `Usuario: —` (sin login) cuenta como declarado.
    const sinRol = runtimeAcs.filter((n) => {
      const b = pasosByAc[n];
      const explicit = b && b.role && b.role.length;
      return !explicit && !(defaultRole && defaultRole.length);
    });
    // (6) DESCRIPCIÓN EN CRIOLLO: un aviso al generar la guía no alcanza, y acá se exige. Sin
    // esto, la guía podría cerrar en verde mostrándole al tester el texto TÉCNICO del criterio (nombres de
    // método, tablas, Given/When/Then). Un aviso que no frena es un aviso que se ignora.
    // Calibrado para no pedir de más: sólo se exige descripción cuando el texto del AC NO se
    // entiende solo — si ya está en castellano llano, sirve como titular y no hay nada que
    // reescribir. El juez es el mismo detector de jerga del punto (3).
    const sinDesc = acs.filter((a) => {
      const b = pasosByAc[a.n];
      if (b && b.desc && b.desc.trim()) return false;      // ya tiene descripción propia
      return detectJargon(a.text || '', siglas).length > 0;         // el AC solo se lee con jerga
    });
    if (sinDesc.length) {
      problems.push(
        `(6) ACs cuyo titular en la guía sería el texto TÉCNICO del criterio (el tester lee nombres ` +
        `de método/tablas en vez de qué se espera): ${sinDesc.map((a) => '#' + a.n).join(', ')}. ` +
        `Agregá una línea en criollo bajo el "## AC N" de ${pasosPath || pasosEsperado}. ` +
        `Aplica también a los ACs no verificables por la app: igual aparecen en la guía y el tester los lee.`,
      );
    }
    if (isFirstTimeStory(fm, abs, (fm.match(/^story:\s*["']?([^"'\s#]+)/m) || [])[1] || sid)) {
      for (const l of teamLines(pasosRaw)) {
        problems.push(`(7) Modo primera vez: la persona trabaja sola y no tiene a quién pedirle. Reescribí el paso para que diga qué hacer, sin pedírselo al equipo: «${l}» (${pasosPath || pasosEsperado})`);
      }
      if (!openApp) problems.push(`(7) Modo primera vez: falta la línea «Abrir la app: <dónde se levanta> · <qué dirección se abre>» al tope de ${pasosPath || pasosEsperado}. La persona trabaja sola: la guía le dice cómo abrir la app.`);
    }
    if (sinRol.length) problems.push(`(5) ACs verificados corriendo SIN usuario de prueba declarado — agregá 'Usuario: <rol>' en el bloque del AC de ${pasosEsperado}, o un 'Usuario por defecto: <rol>' al tope del archivo: ${sinRol.map((n) => '#' + n).join(', ')}`);
    // La pantalla de una tanda bloqueada no se revisa en esta corrida: puede estar a medias en el disco, y su
    // maqueta es de esa tanda. La guía de los criterios de backend, sí. Si lo que cambió en el repo toca pantalla, se
    // revisa igual.
    const uiSignal = require(path.join(__dirname, 'lib', 'ui-signal.js'));
    const alcance = uiSignal.screenScope(content, matrix.repoRoot, { changed: uiSignal.changedFiles(matrix.repoRoot) });
    if (alcance.note && !alcance.blocked.length) console.log(`   · ${alcance.note}`);
    let pantalla = { problems: [], notes: [], screens: [] };
    const deTandaBloqueada = alcance.blocked.length > 0;
    if (!deTandaBloqueada) {
      pantalla = uiReadabilityCheck({ content, fm, qaDir, qk, repoRoot: matrix.repoRoot, storyPath: abs });
      problems.push(...pantalla.problems);
      for (const nota of pantalla.notes) console.log(`   · ${nota}`);
      const maqueta = mockupLayers({ qaDir, qk, mockupSha: opt('--mockup-sha'), screens: pantalla.screens });
      problems.push(...maqueta.problems);
      for (const nota of maqueta.notes) console.log(`   · ${nota}`);
    } else {
      if (alcance.note) console.log(`   · ${alcance.note}`);
      if (opt('--mockup-sha') || isFile(path.join(qaDir, `${qk}-mockup-approval.json`))) {
        console.log(`   · la maqueta aprobada es de la tanda bloqueada ${alcance.blocked.join(', ')}: se compara cuando la tanda deje de estar bloqueada.`);
      }
    }
    if (problems.length) {
      console.error(`🔴 qa-guide --check FALLÓ (story ${sid}) — la guía de tester o la revisión de la pantalla no están listas:`);
      for (const p of problems) console.error(`   - ${p}`);
      for (const v of qaViejos) console.error(`   · ${v} no cuenta: el número ${sid} lo comparten varias stories de este repo y ese archivo no dice de cuál es (no se tocó). La guía de esta story va en ${qk}-….`);
      process.exit(2);
    }
    console.log(`✅ qa-guide --check OK (story ${sid}): pasos-tester presentes, cubren los ${runtimeAcs.length} ACs corridos, sin jerga, legibilidad OK, usuario de prueba declarado, los ${acs.length} ACs con titular legible, y ${!deTandaBloqueada ? `la pantalla revisada (${pantalla.screens.length} archivo/s)` : `la pantalla sin revisar: es de la tanda bloqueada ${alcance.blocked.join(', ')}`}.`);
    process.exit(0);
  }

  function buildCard(a) {
    const pa = matrix.perAc[a.n] || { verdict: 'NOT-RUN' };
    const t = estadoDelArnes(pa);
    const acTests = tests.filter((r) => r.acRefs.includes(a.n));
    const tecnica = acTests
      .map((r) => ({ escenario: r.escenario, esperado: r.esperado }))
      .filter((p) => p.escenario || p.esperado);
    const pasos = pasosByAc[a.n] || { desc: '', pairs: [] };
    const pruebas = pasos.pairs || [];
    const headline = pasos.desc || a.text;
    const acTextTech = pasos.desc ? a.text : null;
    const cmds = (smokeByAc[a.n] || []).filter(Boolean);
    let tierNote = null;
    if (pa.verdict === 'NOT-VERIFIABLE' || pa.verdict === 'WAIVED-USER') {
      tierNote = `No se puede verificar corriendo la app: ${pa.declReason || '(razón no declarada)'}. ` +
        `Cubierto por el test **${pa.coveredBy || (pa.code || []).join(', ') || 'de código'}** — el tester puede revisar que ese test exista y pase, o inspeccionar la base/el esquema directamente.`;
    }
    const needsPasos = !tienePasos(pasosByAc[a.n]) && pa.verdict === 'RUNTIME';
    const needsDesc = !pasos.desc;
    // Rol/usuario de prueba (badge del header): explícito en pasos.md (`Usuario:`), o el default.
    const { roles, roleNone } = resolveRoles(pasos.role, t.tier, defaultRole);
    const needsRole = t.tier !== 'wv' && !roleNone && roles.length === 0;
    return { n: a.n, text: headline, acTextTech, tier: t.tier, badge: t.badge, como: t.como, tierNote, pruebas, tecnica, cmds, needsPasos, needsDesc, roles, roleNone, needsRole };
  }

  // ORDEN pensado para el tester: si el archivo de pasos define una secuencia (orden de los `## AC N`
  // + `## GRUPO`), la guía sigue ESE orden (flujo que reusa setup → termina antes); los ACs no listados
  // van al final. Sin archivo de pasos → orden numérico de la spec.
  const cardByN = {};
  for (const a of acs) cardByN[a.n] = buildCard(a);
  let cards = [];
  if (sequence.length) {
    const usados = new Set();
    for (const s of sequence) {
      if (s.group) cards.push({ groupTitle: s.group });
      else if (cardByN[s.ac]) { cards.push(cardByN[s.ac]); usados.add(s.ac); }
    }
    const resto = acs.map((a) => a.n).filter((n) => !usados.has(n)).sort((x, y) => x - y);
    if (resto.length) { cards.push({ groupTitle: 'Otros ACs' }); for (const n of resto) cards.push(cardByN[n]); }
  } else {
    cards = acs.map((a) => cardByN[a.n]);
  }

  const stats = {
    total: matrix.stats.total,
    runtime: matrix.stats.runtime,
    waived: matrix.stats.waived,
    notVerifiable: matrix.stats.notVerifiable,
    pending: acs.filter((a) => estadoDelArnes(matrix.perAc[a.n]).tier === 'pend').length,
  };

  // Con la opción de la organización prendida, quién marcó cada criterio a mano y qué falta.
  let manual = null;
  try {
    const mc = require(path.join(__dirname, 'lib', 'manual-checks.js'));
    if (mc.prendida().prendida) {
      const storyId = (fm.match(/^story:\s*["']?([^"'\s#]+)/m) || [])[1] || sid;
      const runDir = require(path.join(__dirname, 'pipeline.js')).resolveRunDir(matrix.repoRoot || path.dirname(abs), String(storyId), false, abs);
      const stateDir = require(path.join(__dirname, 'lib', 'story-gate-io.js')).DEFAULT_STATE_DIR;
      const v = runDir ? mc.validas({ runDir, stateDir, storyId }) : { marcas: {} };
      manual = { prendida: true, marcas: v.marcas, faltan: acs.filter((a) => !v.marcas[a.n]).map((a) => ({ n: a.n, text: a.text })) };
    }
  } catch (e) {
    console.error(`· no pude leer las marcas a mano (${e.message})`);
    manual = { prendida: true, marcas: {}, faltan: acs.map((a) => ({ n: a.n, text: a.text })), error: e.message };
  }

  // Determinar el path de salida ANTES de render, para preservar el estado del tester ya guardado.
  let out = opt('--out');
  if (!out) {
    out = path.join(qaDirStory, path.basename(abs, '.md') + '-guia-qa.html');
  }
  // Si ya existe una guía con respuestas del tester guardadas, preservarlas (script#qa-state).
  let embeddedState = {};
  if (isFile(out)) {
    const prev = fs.readFileSync(out, 'utf8');
    const mm = prev.match(/<script id="qa-state"[^>]*>([\s\S]*?)<\/script>/);
    if (mm) { try { embeddedState = JSON.parse(mm[1]) || {}; } catch { embeddedState = {}; } }
  }

  const html = renderHtml({
    outFileName: path.basename(out),
    manual, sid, title, preambleHtml: (openApp ? `<p><strong>Abrir la app:</strong> ${esc(openApp)}</p>` : '') + preambleHtml, cards, stats, embeddedState,
    generatedAt: (opt('--now') || 'ahora'),
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf8');
  const faltan = cards.filter((c) => c.needsPasos).map((c) => c.n);
  const sinDesc = cards.filter((c) => c.needsDesc).map((c) => c.n);
  console.log(`✅ Guía QA generada: ${out}`);
  console.log(`   ${stats.total} ACs · ${stats.runtime} verificados corriendo · ${stats.waived + stats.notVerifiable} no verificables por la app`);
  // La ruta que se sugiere es la MISMA que se busca: un mensaje con la ruta `specs/qa/` fija no sirve
  // cuando la búsqueda es `<carpeta padre de la story>/../qa/` — en un repo con las
  // stories en `specs/` eso es `qa/`, y el dev escribe el archivo donde el mensaje dice.
  const pasosHint = path.relative(process.cwd(), path.join(qaDirStory, `${qk}-pasos.md`)) || `${qk}-pasos.md`;
  for (const v of qaViejos) console.log(`   ⚠ ${v} no cuenta: el número ${sid} lo comparten varias stories de este repo (no se tocó). La guía de esta story va en ${pasosHint}.`);
  if (faltan.length) console.log(`   ⚠ Sin pasos-tester: AC ${faltan.join(', ')} — escribir en ${pasosHint}`);
  if (sinDesc.length) console.log(`   ⚠ Sin descripción criolla (el titular queda en texto técnico del AC): AC ${sinDesc.join(', ')} — agregar una línea de descripción en ${pasosHint}`);
  const sinRol = cards.filter((c) => c.needsRole).map((c) => c.n);
  if (sinRol.length) console.log(`   ⚠ Sin usuario de prueba declarado: AC ${sinRol.join(', ')} — agregar 'Usuario: <rol>' en ${pasosHint} (o 'Usuario por defecto:' al tope)`);

  // --open: abrir la guía en el navegador al generarla —
  // SOLO con el flag explícito, nunca por default: qa-guide corre también desde hooks
  // (on-pre-commit --check no pasa por acá, pero cualquier automatización futura que
  // genere no debe abrir ventanas sin pedirlo). Cross-platform, fail-open (best-effort).
  if (process.argv.includes('--open')) {
    try {
      const { spawn } = require('child_process');
      const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'cmd'
        : 'xdg-open';
      const args = process.platform === 'win32' ? ['/c', 'start', '', out] : [out];
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      console.log('   🌐 Guía abierta en el navegador (--open)');
    } catch (e) {
      console.log(`   ⚠ No pude abrir la guía en el navegador (${e.message}) — abrila a mano: ${out}`);
    }
  }
  process.exit(0);
}

module.exports = { estadoDelArnes, cuandoEnLlano, parseAcsWithText, parseTestsFull, parsePasos, tienePasos, parseDefaultRole, resolveRoles, parsePasosSequence, detectJargon, JARGON_ALLOW, qaGuideTerms, isUiStory, renderHtml, qaLocation, parseOpenApp, teamLines, mockupLayers };
if (require.main === module) {
  // La opción vieja sigue andando hasta el retiro
  require('./lib/legacy-names.js').aliasArgv('skills/tycon-pipeline/scripts/qa-guide.js');
  main();
}
