#!/usr/bin/env node
'use strict';

/**
 * on-deprecated-edit.js — editar código deprecado sin una historia que lo pida avisa o frena.
 *
 * El repo declara su código deprecado (`lib/deprecated.js`): congelado se toca sólo para arreglarlo, con una historia
 * abierta que declare el archivo en `files_to_modify` (o `files_to_create`) y traiga `deprecated_reason:`; muerto no
 * se toca. Fuera de eso, editar avisa con `deprecated.edit: warn` (el valor por omisión) y frena con `block`.
 *
 * Corre en las dos cadenas del despachador (`dispatch.js`): antes de editar frena (modo `block`), después de editar
 * avisa (modo `warn`: el aviso de antes de editar no le llega al modelo, el de después sí, por `additionalContext`).
 * La terminal pasa por `on-bash-write-gate.js`, que usa `porLaTerminal`. Borrar o mover lo deprecado no es editarlo:
 * es el desenlace que se busca, y pasa siempre.
 *
 * El mensaje dice la entrada, el nivel y el motivo, y nunca cómo apagar el freno. Lo que no se pudo mirar no frena
 * (queda `unknown-*` en gates.log).
 */

const fs = require('fs');
const path = require('path');

const dep = require('./lib/deprecated.js');
const io = require('./lib/story-gate-io.js');

const NIVEL = { frozen: 'congelado', dead: 'muerto' };
const EDITORES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

function anotar(stateDir, sessionId, obj) {
  io.appendLog(stateDir, 'gates.log', sessionId, { name: 'deprecated-edit', ...obj });
}

function mensaje({ rel, c, accion, via }) {
  const donde = c.source === 'mark' ? 'la marca `harness-deprecated:` en la cabecera del archivo' : `la entrada \`${c.entry.path}\` de .tycon/advisors.yaml`;
  const regla = c.level === 'dead'
    ? 'Un archivo muerto no se toca, aunque una historia lo declare. Borrarlo o moverlo sí se puede.'
    : 'Un archivo congelado se toca sólo para arreglarlo, con una historia abierta que lo declare en `files_to_modify` y traiga `deprecated_reason:` en su frontmatter.';
  return [
    `${accion === 'block' ? '🔴 FRENADO' : '🟠 Ojo'}: ${rel} está deprecado (${NIVEL[c.level]}): ${c.reason}.`,
    `   Lo dice ${donde}.${via ? ` (${via})` : ''}`,
    `   ${regla}`,
    accion === 'block' ? '   Si hace falta tocarlo, hablalo con la persona: lo que se decida va a la historia o a la lista.' : '   No lo tomes de ejemplo para código nuevo.',
  ].join('\n');
}

/**
 * Qué hacer con una escritura a `abs`.
 * @returns {{action: 'pass'|'warn'|'block', message: string}|null}  null si no está deprecado
 */
function decidir({ abs, sessionId, stateDir, via }) {
  const repo = dep.raizDelRepo(abs, { stateDir, sessionId });
  if (!repo) return null;
  const lista = dep.leerLista(repo, { stateDir, sessionId });
  const c = dep.clasificar(repo, abs, { lista, stateDir, sessionId });
  if (!c) return null;
  const marker = io.readMarker(stateDir, sessionId);
  let storyText = '';
  if (marker && marker.storyPath) {
    try { storyText = fs.readFileSync(marker.storyPath, 'utf8'); } catch (e) {
      // sin la historia no hay autorización que mirar: se decide como sin historia, y queda dicho por qué
      anotar(stateDir, sessionId, { status: 'unknown-historia-ilegible', repoPath: repo, file: marker.storyPath, reason: (e && e.code) || 'no se pudo leer' });
    }
  }
  const rel = dep.relativa(repo, abs) || abs;
  if (storyText && dep.historiaAutoriza({ repo, storyText, archivo: abs, clasificacion: c })) {
    anotar(stateDir, sessionId, { status: 'passed', repoPath: repo, file: rel, level: c.level, storyId: marker.storyId, via: via || null });
    return { action: 'pass', message: '' };
  }
  const action = lista.edit === 'block' ? 'block' : 'warn';
  return { action, message: mensaje({ rel, c, accion: action, via }), repo, rel, c };
}

/**
 * Bajo Codex, `apply_patch` llega como un Edit por archivo (scripts/lib/hook-io.js), con el parche original en
 * `tool_input`. Un `*** Delete File:` o un `*** Update File:` con `*** Move to:` borra o mueve: no es editar.
 */
function borraOMuevePorParche(event, abs) {
  if (!event || event.tool_name_raw !== 'apply_patch') return false;
  const ti = event.tool_input || {};
  const parche = String(ti.command || ti.patch || ti.input || '');
  const cwd = (event.cwd && String(event.cwd)) || process.cwd();
  const bloques = parche.split(/\n(?=\*\*\* (?:Add|Update|Delete) File: )/);
  for (const b of bloques) {
    const m = b.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/m);
    if (!m || path.resolve(cwd, m[2].trim()) !== abs) continue;
    if (m[1] === 'Delete') return true;
    if (m[1] === 'Update' && /^\*\*\* Move to: /m.test(b)) return true;
  }
  return false;
}

/** Para el despachador: `{ block }` antes de editar, `{ systemMessage, reminder }` después; null si no hay nada. */
function handle(event, opts = {}) {
  if (!event || !EDITORES.has(event.tool_name)) return null;
  const fp = event.tool_input && (event.tool_input.file_path || event.tool_input.notebook_path);
  if (!fp) return null;
  const stateDir = opts.stateDir || io.DEFAULT_STATE_DIR;
  const sessionId = event.session_id || null;
  const abs = path.resolve((event.cwd && String(event.cwd)) || process.cwd(), String(fp));
  if (borraOMuevePorParche(event, abs)) return null;   // borrar o mover lo deprecado pasa siempre
  const despues = event.hook_event_name === 'PostToolUse' || event.tool_response !== undefined;
  const d = decidir({ abs, sessionId, stateDir });
  if (!d || d.action === 'pass') return null;
  if (!despues && d.action === 'block') {
    anotar(stateDir, sessionId, { status: 'blocked', repoPath: d.repo, file: d.rel, level: d.c.level });
    return { block: d.message + '\n' };
  }
  if (despues && d.action === 'warn') {
    anotar(stateDir, sessionId, { status: 'warned', repoPath: d.repo, file: d.rel, level: d.c.level });
    return { systemMessage: d.message, reminder: d.message };
  }
  return null;
}

// Borrar no escribe nada (el lector de la puerta no devuelve destinos para `rm`), y lo que se juzga son los destinos
// que ese lector resuelve —con comillas, redirecciones y heredocs—, nunca el texto del comando partido a mano. Los `mv`
// se juzgan destino por destino: el destino nuevo de algo deprecado es moverlo (pasa); un destino que ya existe es
// pisarlo; mover algo vivo adentro de lo deprecado es crear ahí. Una carpeta no se edita: lo que se juzga es el archivo
// que queda adentro.

// El lector de la puerta separa por `;`, `&&`, `||`, `|` y saltos, pero no por un `&` suelto: se lo presenta como `;`.
const AMPERSAND_SUELTO = /(^|[^&>|])&(?![&>])/g;

/** Los comandos de una línea, partidos sólo por separadores que no están entre comillas. */
function comandos(cmd) {
  const out = [];
  let actual = ''; let comilla = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (comilla) { if (c === comilla) comilla = null; actual += c; continue; }
    if (c === '"' || c === "'") { comilla = c; actual += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') { out.push(actual); actual = ''; continue; }
    actual += c;
  }
  out.push(actual);
  return out.map((s) => s.trim()).filter(Boolean);
}

function palabras(seg) {
  return (seg.match(/(?:'[^']*'|"[^"]*"|\S+)/g) || []).map((t) => t.replace(/^['"]|['"]$/g, ''));
}

/** Los traslados del comando: por cada `mv`, cada origen con el archivo en el que termina. */
function traslados(cmd, cwd) {
  const out = [];
  for (const seg of comandos(cmd)) {
    const p = palabras(seg);
    let i = 0;
    while (p[i] === 'sudo') i++;
    if (p[i] === 'git') i++;
    if (p[i] !== 'mv') continue;
    let dir = null; const args = [];
    for (let j = i + 1; j < p.length; j++) {
      if (p[j] === '-t' || p[j] === '--target-directory') { dir = p[++j]; continue; }
      if (/^--target-directory=/.test(p[j])) { dir = p[j].split('=')[1]; continue; }
      if (p[j].startsWith('-')) continue;
      args.push(p[j]);
    }
    const destino = dir || args.pop();
    if (!destino) continue;
    const absDestino = path.resolve(cwd, destino);
    let esCarpeta = false;
    try { esCarpeta = fs.statSync(absDestino).isDirectory(); } catch (_e) { esCarpeta = !!dir || args.length > 1; }
    for (const o of args) {
      const origen = path.resolve(cwd, o);
      out.push({ origen, final: esCarpeta ? path.join(absDestino, path.basename(origen)) : absDestino });
    }
  }
  return out;
}

function clasificarRuta(abs, stateDir, sessionId) {
  const repo = dep.raizDelRepo(abs, { stateDir, sessionId });
  return repo ? dep.clasificar(repo, abs, { stateDir, sessionId }) : null;
}

/**
 * La terminal: las escrituras de un comando (`sed -i`, heredoc, redirección, `cp`, `mv` encima) sobre lo deprecado.
 * @param {{cmd, cwd, destinos: (cmd, cwd) => string[], sessionId, stateDir, via, soloAvisar}} args  `destinos` es el lector de
 *   la puerta; `soloAvisar` (después del comando) devuelve sólo los avisos de `warn`, sin anotarlos otra vez
 * @returns {{block: string}|{aviso: string}|null}
 */
function porLaTerminal({ cmd, cwd, destinos, sessionId, stateDir, via, soloAvisar = false }) {
  const texto = String(cmd).replace(AMPERSAND_SUELTO, '$1;');
  const movidos = new Set();     // destinos nuevos de algo deprecado: pasan
  const objetivos = new Set();
  for (const t of traslados(texto, cwd)) {
    const yaExiste = fs.existsSync(t.final);
    if (!yaExiste && clasificarRuta(t.origen, stateDir, sessionId)) movidos.add(t.final);
    else objetivos.add(t.final);
  }
  for (const abs of destinos(texto, cwd)) {
    let esCarpeta = false;
    try { esCarpeta = fs.statSync(abs).isDirectory(); } catch (_e) { esCarpeta = false; }
    if (!esCarpeta) objetivos.add(abs);
  }
  const avisos = [];
  for (const abs of objetivos) {
    if (movidos.has(abs)) continue;
    const d = decidir({ abs, sessionId, stateDir, via });
    if (!d || d.action === 'pass') continue;
    if (soloAvisar) { if (d.action === 'warn') avisos.push(d.message); continue; }
    anotar(stateDir, sessionId, { status: d.action === 'block' ? 'blocked' : 'warned', repoPath: d.repo, file: d.rel, level: d.c.level, via: via || null });
    if (d.action === 'block') return { block: d.message + '\n' };
    avisos.push(d.message);
  }
  return avisos.length ? { aviso: avisos.join('\n\n') } : null;
}

module.exports = { handle, decidir, porLaTerminal };

if (require.main === module) {
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch (_e) { event = null; }
  let r = null;
  try { r = handle(event || {}); } catch (e) {
    // falla abierto, pero dicho: un freno que tiró sin dejar rastro es un freno apagado sin que nadie lo sepa
    r = null;
    try { anotar(io.DEFAULT_STATE_DIR, (event && event.session_id) || null, { status: 'unknown-error', reason: (e && e.message) || String(e) }); } catch (_e) { /* el registro no frena */ }
    process.stderr.write(`⚠ on-deprecated-edit: ${(e && e.message) || e}\n`);
  }
  if (r && r.block) { process.stderr.write(r.block); process.exit(2); }
  if (r && r.systemMessage) process.stdout.write(JSON.stringify({ systemMessage: r.systemMessage, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.reminder } }));
  process.exit(0);
}
