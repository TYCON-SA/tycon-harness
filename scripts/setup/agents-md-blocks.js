#!/usr/bin/env node
'use strict';
// agents-md-blocks.js — las reglas siempre presentes del arnés en el archivo de reglas de Codex (`~/.codex/AGENTS.md`),
// escritas DESDE LOS BLOQUES (`claude-md-blocks/*.md`), entre sus marcas (story 8.23, tanda C · AC 22).
//
// ── EL CASO (2026-10-06) ──────────────────────────────────────────────────────────────────────────────────────────
// Hasta acá `AGENTS.md` era una COPIA ENTERA de `~/.claude/CLAUDE.md` (la hacía `sync-claude-md-blocks.sh` al final, y
// la `.ps1` de Windows no la hacía nunca). Tres consecuencias medidas: un dev que sólo usa Codex no recibía ninguna regla
// (no hay `CLAUDE.md` que copiar); en Windows tampoco, usara lo que usara; y lo que la persona escribía a mano en
// `AGENTS.md` se pisaba en cada arranque. Además viajaban los `@import` del `CLAUDE.md`, que Codex no resuelve.
//
// ── QUÉ HACE ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Lo mismo que el sincronizador hace con `CLAUDE.md`, sobre `AGENTS.md` y sin leer `CLAUDE.md`:
//   · cada bloque queda entre `<!-- TYCON_BLOCK:<nombre> START … -->` y `<!-- TYCON_BLOCK:<nombre> END -->`; se localiza
//     por el PREFIJO de la marca (una marca con el texto de antes es el mismo bloque: se actualiza en su lugar);
//   · un bloque con variante por herramienta (`claude-md-blocks/names/<nombre>.codex.md`) lleva el cuerpo de la variante;
//   · lo que hay FUERA de las marcas es de la persona y no se toca, byte a byte (en un `AGENTS.md` que venía siendo copia
//     del `CLAUDE.md`, eso incluye lo personal que ya estaba copiado: queda, y deja de actualizarse solo);
//   · un bloque que requiere una integración (`<!-- requires-integration: x -->`) o un perfil (`<!-- requires-profile:
//     full -->`) se escribe sólo si corresponde; si no, no se agrega y, si estaba, se quita entre sus marcas. «No se pudo
//     saber» (configuración rota) no es «apagada»: lo que falta no se agrega, lo que está queda y se actualiza, y se dice;
//   · una marca de cierre perdida no se adivina: ese bloque no se toca y se avisa;
//   · nunca escribe un `@import`.
// Idempotente (si ya coincide no escribe), escritura atómica, y `--check` sólo mira. Corre igual en Mac, Linux y Windows.
//
// Quién lo llama: el enchufe de Codex del mecanismo (`scripts/setup/harness/tools.js`) y, suelto, el aplicador
// (`install-tycon-hooks.sh` / `.ps1`) en su bloque de Codex. Con `TYCON_REPORT_PIECES` (o `reportFile`) anota su pieza
// —`codex <ruta> AGENTS.md`— como la anotaba el sincronizador; con `--check` y `TYCON_PLAN_PIECES`, su acción en el plan.
// Bajo el mecanismo (`TYCON_HARNESS_SNAPSHOT_DIR` puesta) no deja copia propia: la copia ya la tomó el mecanismo.
// Corrido suelto, antes de cambiar un archivo que tenía contenido deja `<archivo>.bak.<fecha>`, como el sincronizador.
//
// Uso:  node scripts/setup/agents-md-blocks.js [--check] [--target <AGENTS.md>] [--blocks <carpeta>]
// Sale 0 siempre que pudo mirar (también con algo pendiente en `--check`); 2 por uso. Nunca rompe un arranque.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TREE = path.resolve(__dirname, '..', '..');
const TOOL = 'codex';
const PROFILES = ['minimal', 'full'];
const REQUIRES_RE = /^<!--\s*requires-integration:\s*([a-z]+)\s*-->\s*$/;
const PROFILE_RE = /^<!--\s*requires-profile:\s*([a-z]+(?:\s*,\s*[a-z]+)*)\s*-->\s*$/;
const VARIANTS_RE = /^<!--\s*variants:\s*(response)\s*-->\s*$/;
const LOOKS_LIKE_REQUIRES_RE = /^\s*<!--\s*requires-integration\b/i;
const LOOKS_LIKE_PROFILE_RE = /^\s*<!--\s*requires-profile\b/i;

const trimNewlines = (s) => s.replace(/^\n+|\n+$/g, '');
const startPrefix = (name) => `<!-- TYCON_BLOCK:${name} START`;
const markerStart = (name) => `<!-- TYCON_BLOCK:${name} START — generado por scripts/setup/agents-md-blocks.js del arnés · NO EDITAR A MANO (se pisa en la próxima actualización); editá claude-md-blocks/${name}.md y commiteá -->`;
const markerEnd = (name) => `<!-- TYCON_BLOCK:${name} END -->`;

/** La carpeta de Codex y su archivo de reglas (`CODEX_AGENTS_MD_PATH` lo fija; si no, `CODEX_HOME` o `~/.codex`). */
function defaultTarget({ env = process.env, home = os.homedir() } = {}) {
  return env.CODEX_AGENTS_MD_PATH || path.join(env.CODEX_HOME || path.join(home, '.codex'), 'AGENTS.md');
}

/**
 * Un bloque del arnés: `{ body, requires, profiles, bad }`. El cuerpo va sin las líneas de los marcadores de condición
 * (bien o mal escritos: nunca se copian). `bad` = `[clase, línea]` si un marcador está mal escrito o repetido.
 */
function readBlock(file) {
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split('\n');
  let requires = null; let profiles = null; let bad = null; let i = 0;
  for (; i < lines.length; i++) {
    const m = REQUIRES_RE.exec(lines[i]); const p = PROFILE_RE.exec(lines[i]);
    if (m && requires === null) requires = m[1];
    else if (p && profiles === null) {
      profiles = p[1].split(',').map((x) => x.trim());
      if (profiles.some((x) => !PROFILES.includes(x))) bad = ['profile', lines[i].trim()];
    } else if (m || p) bad = [m ? 'integration' : 'profile', lines[i].trim()];
    else break;
  }
  let rest = lines.slice(i);
  if (bad === null) {
    for (let k = 0; k < rest.length; k++) {
      if (!rest[k].trim()) continue;
      if (LOOKS_LIKE_REQUIRES_RE.test(rest[k]) || LOOKS_LIKE_PROFILE_RE.test(rest[k])) {
        bad = [LOOKS_LIKE_REQUIRES_RE.test(rest[k]) ? 'integration' : 'profile', rest[k].trim()];
        rest = [...rest.slice(0, k), ...rest.slice(k + 1)];
      }
      break;   // la primera línea con texto es otra cosa: el cuerpo
    }
  }
  // `<!-- variants: response -->` entre los marcadores de arriba (story 2.31): el texto sale de la carpeta del bloque
  let variants = null;
  for (const line of lines) {
    const v = VARIANTS_RE.exec(line);
    if (v) { variants = v[1]; break; }
    if (!REQUIRES_RE.test(line) && !PROFILE_RE.test(line)) break;
  }
  return { body: trimNewlines(rest.join('\n')), requires, profiles, bad, variants };
}

/** Los bloques a escribir, en orden de nombre: cada uno con el cuerpo que le toca a Codex (la variante, si existe). */
function loadBlocks(blocksDir) {
  let files;
  try { files = fs.readdirSync(blocksDir).filter((f) => f.endsWith('.md')).sort(); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(blocksDir, f);
    try { if (!fs.statSync(full).isFile()) continue; } catch (_) { continue; }
    const name = f.slice(0, -3);
    const b = readBlock(full);
    const variant = path.join(blocksDir, 'names', `${name}.${TOOL}.md`);
    if (fs.existsSync(variant)) b.body = trimNewlines(fs.readFileSync(variant, 'utf8').replace(/^﻿/, ''));
    // un bloque que declara `<!-- variants: response -->` (story 2.31) toma su texto de la carpeta del mismo nombre
    if (b.variants) b.variantDir = path.join(blocksDir, name);
    out.push(Object.assign({ name }, b));
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `{ file }` con la variante que eligió la configuración (`<estilo>.<idioma>.md`), o `{ why }` si no se pudo elegir. */
function pickVariant(dir, { response, responseWhy }) {
  try { fs.readdirSync(dir); } catch (_) { return { why: 'no pude leer su carpeta de variantes' }; }
  if (!response) return { why: responseWhy || 'no pude leer la configuración' };
  const file = path.join(dir, `${response.style}.${response.language}.md`);
  return fs.existsSync(file) ? { file } : { why: `no hay texto para el estilo «${response.style}» en «${response.language}»` };
}
/** El tope de prosa en el texto del estilo: {{max_chars}} y {{max_lines}} (≈ cien caracteres por renglón). */
const fillVariant = (body, n) => body.split('{{max_chars}}').join(String(n)).split('{{max_lines}}').join(String(Math.floor((n + 50) / 100)));

// Una fila de tabla que termina en `<!-- integration: <x> -->` se escribe sólo con esa integración prendida (story 2.31,
// AC 7-8); el marcador nunca se copia. No se pudo saber: la fila queda como estaba en el destino (si estaba, sigue).
const ROW_RE = /^(.*\|)[ \t]*<!--\s*integration:\s*([a-z]+)\s*-->\s*$/;
function filterRows(body, existing, { integrations }) {
  // un AGENTS.md con fines de línea de Windows: la fila que estaba se reconoce igual
  const kept = new Set(existing ? existing.split(/\r?\n/) : []);
  return body.split('\n').flatMap((line) => {
    const m = ROW_RE.exec(line);
    if (!m) return [line];
    const row = m[1].replace(/\s+$/, '');
    const known = integrations && Object.prototype.hasOwnProperty.call(integrations, m[2]);
    if (known) return integrations[m[2]] === false ? [] : [row];
    return kept.has(row) ? [row] : [];
  }).join('\n');
}

/** `{ state: 'on' | 'off' | 'unknown', why }` de un bloque: apagado por una de las dos razones alcanza. */
function blockState(b, { integrations, integrationsWhy, profile, profileWhy }) {
  if (b.bad) return { state: 'unknown', why: null };
  const states = [];
  if (b.requires) {
    if (!integrations) states.push(['unknown', ['integration', integrationsWhy || 'no pude leer la configuración']]);
    else if (!Object.prototype.hasOwnProperty.call(integrations, b.requires)) states.push(['unknown', ['integration', 'el lector no conoce esa integración']]);
    else states.push(integrations[b.requires] === false ? ['off', `integración «${b.requires}» apagada`] : ['on', null]);
  }
  if (b.profiles) {
    if (!profile) states.push(['unknown', ['profile', profileWhy || 'no pude leer el perfil']]);
    else states.push(b.profiles.includes(profile) ? ['on', null] : ['off', `perfil «${profile}»`]);
  }
  const off = states.find((s) => s[0] === 'off');
  if (off) return { state: 'off', why: off[1] };
  const unknown = states.find((s) => s[0] === 'unknown');
  if (unknown) return { state: 'unknown', why: unknown[1] };
  return { state: 'on', why: null };
}

/**
 * El texto con los bloques aplicados. Pura: `{ text, changed: [[nombre, qué]], notes: [líneas], present: [nombres] }`.
 * `present` = los bloques que quedan en su lugar, enteros.
 */
function applyBlocks(original, blocks, facts) {
  let content = original;
  const changed = []; const notes = []; const removed = {}; const unclosed = [];
  const finals = {};   // bloque → su texto entero entre marcas, como debería quedar
  for (const b0 of blocks) {
    const start = markerStart(b0.name); const end = markerEnd(b0.name);
    const i0 = content.indexOf(startPrefix(b0.name));
    const j0 = i0 === -1 ? -1 : content.indexOf(end, i0);
    const existingBody = j0 === -1 ? '' : content.slice(content.indexOf('\n', i0) + 1, j0);
    let b = b0;
    // un bloque con variantes mira primero sus propias condiciones (perfil, integración), como cualquier otro; recién
    // prendido elige el texto. Apagado o sin saber, sigue por el camino común (y sin saber no se toca, abajo)
    if (b0.variantDir && blockState(b0, facts).state === 'on') {
      const v = pickVariant(b0.variantDir, facts);
      if (v.why) {
        // no se pudo elegir el texto: no se inventa uno; lo que había queda tal cual, sin actualizar (story 2.31, AC 6)
        notes.push(`⚠ tycon: bloque AGENTS.md '${b0.name}': no pude saber cómo tiene que contestar el asistente (${v.why}): ${i0 === -1 ? 'no se agrega' : 'queda como estaba'}`);
        if (j0 !== -1) finals[b0.name] = content.slice(i0, j0 + end.length);
        continue;
      }
      b = Object.assign({ name: b0.name }, readBlock(v.file));
      b.body = fillVariant(b.body, facts.response.max_chars);
    }
    b = Object.assign({}, b, { body: filterRows(b.body, existingBody, facts) });
    const { state, why } = blockState(b, facts);
    const desired = `${start}\n${b.body}\n${end}`;
    finals[b.name] = desired;
    const i = i0;
    if (state === 'unknown') {
      const outcome = i === -1 ? 'no se agrega' : 'queda donde está';
      if (b.bad) notes.push(`⚠ tycon: bloque AGENTS.md '${b.name}': su marcador ${b.bad[0] === 'integration' ? 'requires-integration' : 'requires-profile'} está mal escrito o repetido (${b.bad[1]}): ${outcome}`);
      else if (why[0] === 'profile') notes.push(`⚠ tycon: bloque AGENTS.md '${b.name}' requiere el perfil «${b.profiles.join(', ')}» y no pude saber cuál tiene esta máquina (${why[1]}): ${outcome}`);
      else notes.push(`⚠ tycon: bloque AGENTS.md '${b.name}' requiere la integración «${b.requires}» y no pude saber si está prendida (${why[1]}): ${outcome}`);
      if (b0.variantDir) {
        // sin saber sus condiciones no se elige texto: lo que había queda tal cual (su archivo sólo trae la marca)
        if (j0 !== -1) finals[b0.name] = content.slice(i0, j0 + end.length); else delete finals[b0.name];
        continue;
      }
    }
    if (i === -1) {
      if (state !== 'on') continue;
      content = content.trim() === '' ? `${desired}\n` : `${content.replace(/\n+$/, '')}\n\n${desired}\n`;
      changed.push([b.name, 'agregado']);
      continue;
    }
    const j = content.indexOf(end, i);
    if (j === -1) {
      // la marca de cierre se perdió (una edición a mano): no se adivina dónde termina
      notes.push(`⚠ tycon: bloque '${b.name}' de AGENTS.md: falta su marca de cierre — no lo toco; revisalo a mano`);
      unclosed.push(b.name);   // no está al día aunque no se toque (clase 15: la paridad lo daba por verde)
      continue;
    }
    if (state === 'off') {
      // se va entre sus marcas, con el renglón en blanco que el agregado le puso delante (la regla del sincronizador)
      const before = content.slice(0, i).replace(/\n+$/, '');
      let after = content.slice(j + end.length);
      if (after.startsWith('\n')) after = after.slice(1);
      content = before || after ? `${before}\n${after}` : '';
      changed.push([b.name, `quitado (${why})`]);
      removed[b.name] = why;
      continue;
    }
    if (content.slice(i, j + end.length) === desired) continue;
    content = content.slice(0, i) + desired + content.slice(j + end.length);
    changed.push([b.name, 'actualizado']);
  }
  const present = blocks.filter((b) => finals[b.name] !== undefined && content.includes(finals[b.name])).map((b) => b.name);
  return { text: content, changed, notes, present, removed, unclosed };
}

function writeAtomic(target, text) {
  // un AGENTS.md que es un enlace (la configuración en un repo de dotfiles) se escribe en su destino: un rename sobre
  // el enlace lo reemplazaba por un archivo suelto y el destino no se enteraba
  let file = target;
  try { if (fs.lstatSync(target).isSymbolicLink()) file = fs.realpathSync(target); } catch (_) { /* no está, o el enlace cuelga: se escribe en su lugar */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-tycon-${process.pid}`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* no quedó */ } throw e; }
}
function appendLine(file, line) { try { fs.appendFileSync(file, `${line}\n`); return null; } catch (e) { return e; } }

/** Las integraciones y el perfil de la máquina, leídos con el lector del árbol. Nunca tira: sin dato, el motivo. */
function machineFacts({ tree = TREE, home = os.homedir(), env = process.env } = {}) {
  const facts = { integrations: null, integrationsWhy: null, profile: null, profileWhy: null, response: null, responseWhy: null };
  try {
    const C = require(path.join(tree, 'scripts', 'lib', 'tycon-config.js'));
    const read = () => C.leer({ home, env });
    const config = typeof C.sinAnotar === 'function' ? C.sinAnotar(read) : read();
    facts.integrations = C.integraciones(config);
    // cómo contesta el asistente (story 2.31); un árbol de antes no lo sabe: el bloque con variantes queda como estaba
    if (typeof C.respuesta === 'function') facts.response = C.respuesta(config);
    else facts.responseWhy = 'este lector de configuración no conoce `response`';
  } catch (e) {
    facts.integrationsWhy = e && e.name === 'ConfigError' ? 'configuración rota: `node scripts/lib/tycon-config.js validate` dice qué' : `no pude leer la configuración (${(e && e.message ? e.message : String(e)).split('\n')[0]})`;
    facts.responseWhy = facts.integrationsWhy;
  }
  try {
    const r = require(path.join(tree, 'scripts', 'setup', 'harness', 'profile.js')).resolve({ tree, home, env });
    if (r && r.ok) facts.profile = r.value || 'full'; else facts.profileWhy = (r && r.reason) || 'no pude leer el perfil';
  } catch (e) {
    // un árbol de antes de los perfiles: lo de siempre, full
    if (e && e.code === 'MODULE_NOT_FOUND') facts.profile = 'full'; else facts.profileWhy = `no pude leer el perfil (${(e && e.message ? e.message : String(e)).split('\n')[0]})`;
  }
  return facts;
}

/**
 * Deja (o mira, con `check`) los bloques en `target`.
 * @param {object} p  blocksDir · target · check · integrations/integrationsWhy · profile/profileWhy (si no vienen, se leen
 *   de la máquina) · reportFile · planFile · backup (false = sin copia propia) · quiet (no imprime) · env · home · tree
 * @returns {{ok:boolean, changed:boolean, pending:boolean, lines:string[], present:string[], target:string, reason?:string}}
 */
function sync(p = {}) {
  const env = p.env || process.env;
  // el apagado del sincronizador de bloques cubre también AGENTS.md, como siempre (clase 16)
  if (env.TYCON_NO_CLAUDEMD_SYNC === '1') return { ok: true, changed: false, pending: false, lines: ['sync opt-out (TYCON_NO_CLAUDEMD_SYNC=1): AGENTS.md no se toca'], present: [], target: p.target || defaultTarget({ env, home: p.home || os.homedir() }) };
  const home = p.home || os.homedir();
  const tree = p.tree || TREE;
  const target = p.target || defaultTarget({ env, home });
  const blocksDir = p.blocksDir || path.join(tree, 'claude-md-blocks');
  const check = Boolean(p.check);
  const lines = [];
  const say = (l) => { lines.push(l); if (!p.quiet) console.log(l); };
  const out = (extra) => Object.assign({ ok: true, changed: false, pending: false, lines, present: [], target }, extra);

  const blocks = loadBlocks(blocksDir);
  if (!blocks.length) return out({ ok: false, reason: `sin bloques en ${blocksDir}` });
  let original;
  try { original = fs.readFileSync(target, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return out({ ok: false, reason: `no pude leer ${target} (${e.code || e.message})` });
    original = '';
  }
  const facts = (p.integrations !== undefined || p.profile !== undefined)
    ? { integrations: p.integrations === undefined ? null : p.integrations, integrationsWhy: p.integrationsWhy || null, profile: p.profile === undefined ? null : p.profile, profileWhy: p.profileWhy || null, response: p.response || null, responseWhy: p.responseWhy || (p.response ? null : 'no me pasaron cómo contesta el asistente') }
    : machineFacts({ tree, home, env });
  const r = applyBlocks(original, blocks, facts);
  for (const n of r.notes) say(n);
  const differs = r.text !== original;
  const action = !differs ? 'keep' : (original === '' ? 'add' : 'update');
  if (check) {
    for (const [name, what] of r.changed) {
      say(r.removed[name] ? `⚠ tycon: bloque AGENTS.md '${name}' sobra (${r.removed[name]}) — corré node scripts/setup/agents-md-blocks.js` : `⚠ tycon: bloque AGENTS.md '${name}' desactualizado (${what}) — corré node scripts/setup/agents-md-blocks.js`);
    }
    const planFile = p.planFile || env.TYCON_PLAN_PIECES;
    if (planFile && (r.present.length || differs)) {
      const e = appendLine(planFile, `codex\t${path.resolve(target)}\tAGENTS.md\t${action}`);
      // por stdout: harness.js lee esta línea y no muestra un plan incompleto como si estuviera entero
      if (e) say(`⚠ tycon: no pude anotar el bloque AGENTS.md en el plan (${e.code || e.message})`);
    }
    for (const name of r.unclosed || []) say(`⚠ tycon: bloque AGENTS.md '${name}' sin marca de cierre: no está al día — revisalo a mano y corré node scripts/setup/agents-md-blocks.js`);
    return out({ pending: differs || Boolean(r.unclosed && r.unclosed.length), present: r.present });
  }
  if (differs) {
    try {
      const snapshot = Boolean(env.TYCON_HARNESS_SNAPSHOT_DIR);
      // corriendo suelto, la copia de siempre (`<archivo>.bak.<fecha>`, como la del sincronizador); bajo el mecanismo
      // no: la copia ya la tomó él, y otra más es la pila sin tope que la 8.13 vino a cerrar
      if (original && !snapshot && p.backup !== false) {
        const d = new Date(); const two = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
        fs.writeFileSync(`${target}.bak.${stamp}`, original);
        say(`✓ tycon: backup en ${target}.bak.${stamp}`);
      }
      writeAtomic(target, r.text);
    } catch (e) {
      return out({ ok: false, reason: `no pude escribir ${target} (${e.code || e.message})` });
    }
    for (const [name, what] of r.changed) say(`✓ tycon: bloque AGENTS.md '${name}' ${what}`);
  }
  const reportFile = p.reportFile || env.TYCON_REPORT_PIECES;
  if (reportFile && r.present.length) appendLine(reportFile, `codex\t${path.resolve(target)}\tAGENTS.md`);
  return out({ changed: differs, present: r.present });
}

function main(argv) {
  const opts = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--target' && argv[i + 1]) opts.target = argv[++i];
    else if (a === '--blocks' && argv[i + 1]) opts.blocksDir = argv[++i];
    else { process.stderr.write(`agents-md-blocks: opción desconocida «${a}»\nuso: node agents-md-blocks.js [--check] [--target <AGENTS.md>] [--blocks <carpeta>]\n`); return 2; }
  }
  try {
    const r = sync(opts);
    if (!r.ok) console.log(`⚠ tycon: AGENTS.md de Codex: ${r.reason}`);
  } catch (e) {
    // nunca rompe un arranque: lo que pasó se dice y sale 0
    console.log(`⚠ tycon: AGENTS.md de Codex: no pude sincronizar los bloques (${e && e.message ? e.message.split('\n')[0] : e})`);
  }
  return 0;
}

module.exports = { sync, applyBlocks, loadBlocks, readBlock, blockState, machineFacts, defaultTarget, markerStart, markerEnd };
if (require.main === module) process.exit(main(process.argv.slice(2)));
