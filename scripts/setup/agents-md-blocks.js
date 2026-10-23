#!/usr/bin/env node
'use strict';
// agents-md-blocks.js — las reglas siempre presentes del arnés en el archivo de reglas de Codex (`~/.codex/AGENTS.md`),
// escritas DESDE LOS BLOQUES (`claude-md-blocks/*.md`), entre sus marcas.
//
// ── POR QUÉ NO ES UNA COPIA ───────────────────────────────────────────────────────────────────────────────────────
// Copiar `~/.claude/CLAUDE.md` entero a `AGENTS.md` tendría tres consecuencias: un dev que sólo usa Codex no recibiría
// ninguna regla (no hay `CLAUDE.md` que copiar); en Windows tampoco; y lo que la persona escribe a mano en
// `AGENTS.md` se pisaría en cada arranque. Además viajarían los `@import` del `CLAUDE.md`, que Codex no resuelve.
//
// ── QUÉ HACE ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Lo mismo que el sincronizador hace con `CLAUDE.md`, sobre `AGENTS.md` y sin leer `CLAUDE.md`:
//   · cada bloque queda entre `<!-- TYCON_BLOCK:<nombre> START … -->` y `<!-- TYCON_BLOCK:<nombre> END -->`; se localiza
//     por el PREFIJO de la marca (una marca con otro texto detrás del prefijo es el mismo bloque: se actualiza en su lugar);
//   · un bloque con variante por herramienta (`claude-md-blocks/names/<nombre>.codex.md`) lleva el cuerpo de la variante;
//   · lo que hay FUERA de las marcas es de la persona y no se toca, byte a byte (en un `AGENTS.md` que ya era copia
//     del `CLAUDE.md`, eso incluye lo personal que ya estaba copiado: queda, y deja de actualizarse solo);
//   · un bloque que requiere una integración (`<!-- requires-integration: x -->`) o un perfil (`<!-- requires-profile:
//     full -->`) se escribe sólo si corresponde; si no, no se agrega y, si estaba, se quita entre sus marcas. «No se pudo
//     saber» (configuración rota) no es «apagada»: lo que falta no se agrega, lo que está queda y se actualiza, y se dice;
//   · una marca de cierre perdida no se adivina: ese bloque no se toca y se avisa;
//   · nunca escribe un `@import`;
//   · los bloques de los paquetes que activa la organización (`packs/<p>/claude-md-blocks/<n>.md`, el bloque `packs/<p>/<n>`)
//     se escriben igual; uno `packs/…` ya escrito cuyo paquete dejó de estar activo, o que ya no lo trae, se quita entre sus
//     marcas. Sin saber qué paquetes activa la organización, queda donde está y se dice.
// Idempotente (si ya coincide no escribe), escritura atómica, y `--check` sólo mira. Corre igual en Mac, Linux y Windows.
//
// Quién lo llama: el enchufe de Codex del mecanismo (`scripts/setup/harness/tools.js`) y, suelto, el aplicador
// (`install-tycon-hooks.sh` / `.ps1`) en su bloque de Codex. Con `TYCON_REPORT_PIECES` (o `reportFile`) anota su pieza
// —`codex <ruta> AGENTS.md`— como la anota el sincronizador; con `--check` y `TYCON_PLAN_PIECES`, su acción en el plan.
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
const PACK_BLOCK_RE = /<!--\s*TYCON_BLOCK:(packs\/[^/\s>]+\/[^/\s>]+)\s+START/g;
/** El archivo del que sale un bloque, como lo nombra su marca (`claude-md-blocks/<n>.md`, o el de su paquete). */
const INDEX_BLOCK = 'harness-index';
const blockSource = (name) => {
  if (name === INDEX_BLOCK) return 'el bloque harnessIndexBlock de scripts/setup/agents-md-blocks.js';
  const m = /^packs\/([^/]+)\/([^/]+)$/.exec(name);
  return m ? `packs/${m[1]}/claude-md-blocks/${m[2]}.md` : `claude-md-blocks/${name}.md`;
};

/**
 * El bloque que le da a Codex el índice del arnés. Claude Code carga el índice (`INDEX.md`) con un `@import` en su
 * CLAUDE.md, en cualquier perfil; Codex no expande las líneas `@` del AGENTS.md, y los bloques de reglas exigen el perfil
 * full: sin este bloque, una máquina sólo con Codex arranca sin saber qué guía leer. Por eso el índice va ENTERO
 * adentro, debajo de dónde está el arnés y dónde están las skills: con sólo su ruta, el modelo tenía que ir a leerlo, y
 * no lo hacía. El tope de 32 KiB de Codex vale para los AGENTS.md del proyecto, no para el de su carpeta: un AGENTS.md
 * global de más de 40 KB se lee completo. Una línea del índice que empiece con `@` no se copia (nunca un `@import`). Sin
 * INDEX.md en el árbol el bloque queda apagado: no se escribe, se saca si estaba y se avisa.
 */
function harnessIndexBlock(tree, home, env = process.env, platform = process.platform) {
  const index = path.join(tree, 'INDEX.md');
  const block = { name: INDEX_BLOCK, body: '', requires: null, profiles: null, bad: null, variants: null };
  if (!fs.existsSync(index)) return Object.assign(block, { off: `el árbol ${tree} no trae INDEX.md` });
  // con `~` si cuelga de HOME, y con `/` en cualquier sistema: es texto para el modelo, no una ruta que se abra acá
  const corto = (p) => (home && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p).split(path.sep).join('/');
  // las skills van a la carpeta de Codex (CODEX_HOME, o ~/.codex), como las despliega deploy-shared-skills.js
  const skillsDir = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills');
  const skills = corto(skillsDir);
  // El comando entero de cada guion del pipeline: sin él, el modelo lo busca, y las skills son enlaces al arnés que
  // `find` sin -L no recorre. En Windows Codex corre los comandos en PowerShell, que no expande `~` para `node`: la
  // carpeta del usuario va como $env:USERPROFILE, y fuera de ella la ruta absoluta.
  // Una ruta con espacios o caracteres raros va ENTERA entre comillas simples, que no expanden nada: entre comillas
  // dobles, un `$(…)` o un acento grave del nombre de la carpeta se ejecutaría al pegar el comando.
  const guion = (nombre) => {
    if (platform !== 'win32') {
      const ruta = `${skills}/tycon-pipeline/scripts/${nombre}`;
      if (!/[^\w@%+=:,./~-]/.test(ruta)) return `node ${ruta}`;
      const abs = [skillsDir, 'tycon-pipeline', 'scripts', nombre].join('/');
      return `node '${abs.replace(/'/g, "'\\''")}'`;
    }
    const rel = ['tycon-pipeline', 'scripts', nombre];
    const abs = [skillsDir.split('/').join('\\'), ...rel].join('\\');
    // comillas dobles sólo con caracteres seguros: PowerShell expande `$`, el acento grave y toma también las comillas
    // tipográficas como comillas; cualquier otra cosa va entre comillas simples, con toda comilla simple doblada
    if (!/^[\w .\\:-]+$/.test(abs)) return `node '${abs.replace(/['‘’‚‛]/g, (c) => c + c)}'`;
    const casa = home ? home.split('/').join('\\') : '';
    const enCasa = casa && abs.toLowerCase().startsWith(casa.toLowerCase() + '\\');
    return `node "${enCasa ? `$env:USERPROFILE${abs.slice(casa.length)}` : abs}"`;
  };
  // un comando con acento grave adentro no entra entre una sola comilla invertida de Markdown
  const codigo = (s) => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);
  let body = [
    '# El arnés',
    '',
    `El arnés de desarrollo está instalado en \`${corto(tree)}\`. Antes de cada tarea leé su índice, \`${corto(index)}\`: dice`,
    `qué guía leer según la tarea, y sus rutas son relativas a esa carpeta. Sus skills están en \`${skills}/\`; para`,
    `implementar una story, la del pipeline: \`${skills}/tycon-pipeline/SKILL.md\`.`,
    '',
    'Los guiones del pipeline se corren con el comando entero, tal cual:',
    `${codigo(`${guion('pipeline.js')} <subcomando>`)} y ${codigo(`${guion('marker.js')} <subcomando>`)}. No hace falta`,
    'buscarlos: las carpetas de las skills son enlaces al arnés, y `find` sin `-L` no entra en ellas. Para buscar adentro,',
    '`find -L` o `ls -R`.',
  ].join('\n');
  let indice;
  try { indice = fs.readFileSync(index, 'utf8'); } catch (e) { return Object.assign(block, { off: `no se pudo leer ${index}: ${e.message}` }); }
  if (indice.charCodeAt(0) === 0xfeff) indice = indice.slice(1);
  indice = trimNewlines(indice.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('@')).join('\n'));
  if (indice) body += `\n\nEl índice, tal como está en esa carpeta:\n\n${indice}`;
  return Object.assign(block, { body });
}

/**
 * El árbol que nombra el bloque del índice: el instalado (el que Codex usa de verdad), si trae INDEX.md; si no, el de
 * este archivo. Corrido a mano desde un clon o una copia de trabajo, AGENTS.md no queda apuntando a esa carpeta.
 */
function installedTree(fallback) {
  try {
    const repo = require(path.join(__dirname, '..', 'lib', 'skills-dir.js')).resolveInstalledSkillsDirs('').repo;
    if (fs.existsSync(path.join(repo, 'INDEX.md'))) return repo;
  } catch (_) { /* sin el lector: el árbol de este archivo */ }
  return fallback;
}
const markerStart = (name) => `<!-- TYCON_BLOCK:${name} START — generado por scripts/setup/agents-md-blocks.js del arnés · NO EDITAR A MANO (se pisa en la próxima actualización); editá ${blockSource(name)} y commiteá -->`;
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
  // `<!-- variants: response -->` entre los marcadores de arriba: el texto sale de la carpeta del bloque
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
    // un bloque que declara `<!-- variants: response -->` toma su texto de la carpeta del mismo nombre
    if (b.variants) b.variantDir = path.join(blocksDir, name);
    out.push(Object.assign({ name }, b));
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Los bloques de los paquetes activos del árbol (`{ blocks, active }`), o `{ blocks: [], active: null, why }` si no se pudo
 * saber qué paquetes activa la organización. Un árbol sin el lector (anterior a los bloques de paquete): ninguno, sin quitar.
 */
function loadPackBlocks({ tree, env, home }) {
  let PP;
  try { PP = require(path.join(tree, 'scripts', 'lib', 'pack-pieces.js')); } catch (_) { return { blocks: [], active: null, why: 'no encontré el lector de paquetes (scripts/lib/pack-pieces.js)' }; }
  if (typeof PP.blocksOf !== 'function') return { blocks: [], active: null, why: 'este lector de paquetes no conoce los bloques de paquete' };
  let r;
  try { r = PP.blocksOf({ tree, env, home }); } catch (e) { return { blocks: [], active: null, why: `no pude leer los bloques de los paquetes (${String((e && e.message) || e).split('\n')[0]})` }; }
  if (!r || !Array.isArray(r.active)) return { blocks: [], active: null, why: (r && r.error) || 'no pude saber qué paquetes activa la organización' };
  const blocks = [];
  for (const b of r.blocks) {
    try { blocks.push(Object.assign({ name: b.name }, readBlock(b.file), { variants: null })); } catch (_) { /* ilegible: no se escribe */ }
  }
  return { blocks, active: r.active, why: null };
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

// Una fila de tabla que termina en `<!-- integration: <x> -->` se escribe sólo con esa integración prendida;
// el marcador nunca se copia. No se pudo saber: la fila queda como estaba en el destino (si estaba, sigue).
const ROW_RE = /^(.*\|)[ \t]*<!--\s*integration:\s*([a-z0-9-]+)\s*-->\s*$/;
// El lugar de las filas de las herramientas de horas: cada una trae las suyas en su carpeta (`tool-names.codex.md`, con
// los nombres que ve Codex) y se escriben las de la elegida
const TIME_ROWS_RE = /^<!--\s*time-tool-rows\s*-->\s*$/;
/** Las herramientas de horas del árbol (las integraciones de horas de `integrations/`), por su manifiesto. */
// lo que no se pudo leer se dice (`notes`): un manifiesto o un archivo de filas que no se lee no es «sin filas».
// Las herramientas: las integraciones de horas que da la biblioteca de integraciones; un manifiesto de una carpeta con
// nombre válido que la biblioteca no pudo leer entra como «no se sabe» (`unknown`: sus filas quedan como estaban)
const NAME_RE = /^[a-z0-9-]+$/;
const TABLE_ROW_RE = /^\|.*\|\s*$/;
function timeTools(integrationsDir, notes = []) {
  const unknown = new Set();
  let listing;
  try { listing = require(path.join(integrationsDir, '..', 'scripts', 'lib', 'integrations.js')).listManifests({ dir: integrationsDir }); } catch (e) {
    notes.push(`⚠ tycon: no pude leer las integraciones (${e.code || e.message}): las filas de la herramienta de horas quedan como estaban`);
    return { names: [], unknown, failed: true };
  }
  for (const b of listing.problems) {
    if (!NAME_RE.test(b.name)) continue;
    notes.push(`⚠ tycon: la integración ${b.name} tiene el manifiesto roto (${b.reasons.join('; ')}): si es una herramienta de horas, sus filas de la tabla de nombres de tools quedan como estaban`);
    unknown.add(b.name);
  }
  const names = listing.manifests.filter((m) => m.kind === 'timeTracking' && NAME_RE.test(m.name)).map((m) => m.name).concat([...unknown]);
  return { names, unknown, failed: false };
}
function expandTimeRows(body, integrationsDir, tools, notes = []) {
  return body.split('\n').flatMap((line) => {
    if (!TIME_ROWS_RE.test(line)) return [line];
    return tools.flatMap((n) => {
      let text;
      try { text = fs.readFileSync(path.join(integrationsDir, n, 'tool-names.codex.md'), 'utf8'); } catch (e) {
        if (e.code !== 'ENOENT') notes.push(`⚠ tycon: no pude leer integrations/${n}/tool-names.codex.md (${e.code || e.message}): la tabla de nombres de tools no trae sus filas`);
        return [];   // sin nombres de tools, sin filas
      }
      // sólo las filas de tabla: otra línea del archivo no se copia, y se dice
      return text.split(/\r?\n/).filter((r) => r.trim()).flatMap((r) => {
        if (TABLE_ROW_RE.test(r) && !r.includes('<!--')) return [`${r.replace(/\s+$/, '')} <!-- integration: ${n} -->`];
        notes.push(`⚠ tycon: integrations/${n}/tool-names.codex.md trae una línea que no es una fila de tabla («${r.trim().slice(0, 60)}»): no se copia`);
        return [];
      });
    });
  }).join('\n');
}
function filterRows(body, existing, { integrations, timeTool = null, integrationsDir = path.join(TREE, 'integrations'), timeNotes = [] }) {
  // un AGENTS.md con fines de línea de Windows: la fila que estaba se reconoce igual
  const kept = new Set(existing ? existing.split(/\r?\n/) : []);
  const { names: tools, unknown, failed } = timeTools(integrationsDir, timeNotes);
  if (timeTool && timeTool !== 'none' && !failed && !tools.includes(timeTool)) timeNotes.push(`⚠ tycon: la herramienta de horas elegida («${timeTool}») no es una integración de horas de este arnés: la tabla de nombres de tools no trae filas suyas`);
  return expandTimeRows(body, integrationsDir, tools, timeNotes).split('\n').flatMap((line) => {
    const m = ROW_RE.exec(line);
    if (!m) return [line];
    const row = m[1].replace(/\s+$/, '');
    // una herramienta de horas va si es la elegida; sin saber cuál (o sin poder leer sus archivos), la fila queda como estaba
    if (tools.includes(m[2])) return timeTool && !unknown.has(m[2]) ? (timeTool === m[2] ? [row] : []) : (kept.has(row) ? [row] : []);
    const known = integrations && Object.prototype.hasOwnProperty.call(integrations, m[2]);
    if (known) return integrations[m[2]] === false ? [] : [row];
    return kept.has(row) ? [row] : [];
  }).join('\n');
}

/** `{ state: 'on' | 'off' | 'unknown', why }` de un bloque: apagado por una de las dos razones alcanza. */
function blockState(b, { integrations, integrationsWhy, profile, profileWhy }) {
  if (b.bad) return { state: 'unknown', why: null };
  if (b.off) return { state: 'off', why: b.off };
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
        // no se pudo elegir el texto: no se inventa uno; lo que había queda tal cual, sin actualizar
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
      unclosed.push(b.name);   // no está al día aunque no se toque (la paridad lo daría por verde)
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
  // un bloque de paquete escrito que ya no corresponde (paquete inactivo, o que ya no lo trae) se va entre sus marcas;
  // sin saber qué paquetes activa la organización, queda (`facts.packs` ausente: quien llama no los miró, nada se quita)
  const names = new Set(blocks.map((b) => b.name));
  const written = [...new Set([...content.matchAll(PACK_BLOCK_RE)].map((m) => m[1]))].filter((n) => !names.has(n)).sort();
  for (const name of written) {
    if (!facts.packs) continue;
    if (!Array.isArray(facts.packs.active)) { notes.push(`⚠ tycon: bloque AGENTS.md '${name}': no pude saber si su paquete está activo (${facts.packs.why}): queda donde está`); continue; }
    const end = markerEnd(name);
    const i = content.indexOf(startPrefix(name));
    const j = content.indexOf(end, i);
    if (j === -1) { notes.push(`⚠ tycon: bloque '${name}' de AGENTS.md: falta su marca de cierre — no lo toco; revisalo a mano`); unclosed.push(name); continue; }
    const pack = name.split('/')[1];
    const why = facts.packs.active.includes(pack) ? `el paquete «${pack}» ya no lo trae` : `el paquete «${pack}» no está activo`;
    const before = content.slice(0, i).replace(/\n+$/, '');
    let after = content.slice(j + end.length);
    if (after.startsWith('\n')) after = after.slice(1);
    content = before || after ? `${before}\n${after}` : '';
    changed.push([name, `quitado (${why})`]);
    removed[name] = why;
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
    // la herramienta de horas elegida (con la llave vieja leída) y dónde están las suyas; un lector anterior no la sabe
    // un valor que no es un nombre de integración es «no se sabe», como en el lector y en el .sh y el .ps1
    if (typeof C.timeTracking === 'function') {
      const v = (C.sinAnotar || ((f) => f()))(() => C.timeTracking(config)).value;
      if (typeof v === 'string' && /^[a-z0-9-]+$/.test(v)) facts.timeTool = v;
      else facts.timeToolWhy = `la herramienta de horas elegida no es un nombre de integración («${String(v).slice(0, 40)}»)`;
    } else facts.timeToolWhy = 'este lector de configuración no dice la herramienta de horas';
    facts.integrationsDir = path.join(tree, 'integrations');
    // cómo contesta el asistente; un árbol anterior no lo sabe: el bloque con variantes queda como estaba
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
    // un árbol anterior a los perfiles: full
    if (e && e.code === 'MODULE_NOT_FOUND') facts.profile = 'full'; else facts.profileWhy = `no pude leer el perfil (${(e && e.message ? e.message : String(e)).split('\n')[0]})`;
  }
  return facts;
}

/**
 * Deja (o mira, con `check`) los bloques en `target`.
 * @param {object} p  blocksDir · target · check · integrations/integrationsWhy · profile/profileWhy (si no vienen, se leen
 *   de la máquina) · packs (`{ blocks, active, why }` de loadPackBlocks; si no viene, se lee del árbol) · reportFile ·
 *   planFile · backup (false = sin copia propia) · quiet (no imprime) · env · home · tree
 * @returns {{ok:boolean, changed:boolean, pending:boolean, lines:string[], present:string[], target:string, reason?:string}}
 */
function sync(p = {}) {
  const env = p.env || process.env;
  // el apagado del sincronizador de bloques cubre también AGENTS.md
  if (env.TYCON_NO_CLAUDEMD_SYNC === '1') return { ok: true, changed: false, pending: false, lines: ['sync opt-out (TYCON_NO_CLAUDEMD_SYNC=1): AGENTS.md no se toca'], present: [], target: p.target || defaultTarget({ env, home: p.home || os.homedir() }) };
  const home = p.home || os.homedir();
  const tree = p.tree || TREE;
  const target = p.target || defaultTarget({ env, home });
  const blocksDir = p.blocksDir || path.join(tree, 'claude-md-blocks');
  const check = Boolean(p.check);
  const lines = [];
  const say = (l) => { lines.push(l); if (!p.quiet) console.log(l); };
  const out = (extra) => Object.assign({ ok: true, changed: false, pending: false, lines, present: [], target }, extra);

  const core = loadBlocks(blocksDir);
  if (!core.length) return out({ ok: false, reason: `sin bloques en ${blocksDir}` });
  const indexBlock = harnessIndexBlock(p.tree || installedTree(tree), home, env, p.platform || process.platform);
  if (indexBlock.off) say(`⚠ tycon: AGENTS.md queda sin el bloque del índice del arnés: ${indexBlock.off}`);
  core.push(indexBlock);
  const packs = p.packs !== undefined ? p.packs : loadPackBlocks({ tree, env, home });
  const blocks = core.concat(packs ? packs.blocks : []).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let original;
  try { original = fs.readFileSync(target, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return out({ ok: false, reason: `no pude leer ${target} (${e.code || e.message})` });
    original = '';
  }
  const facts = (p.integrations !== undefined || p.profile !== undefined)
    ? { integrations: p.integrations === undefined ? null : p.integrations, integrationsWhy: p.integrationsWhy || null, profile: p.profile === undefined ? null : p.profile, profileWhy: p.profileWhy || null, response: p.response || null, responseWhy: p.responseWhy || (p.response ? null : 'no me pasaron cómo contesta el asistente'), timeTool: p.timeTool || null, integrationsDir: path.join(tree, 'integrations') }
    : machineFacts({ tree, home, env });
  const timeNotes = facts.timeToolWhy ? [`⚠ tycon: ${facts.timeToolWhy}: las filas de la herramienta de horas quedan como estaban`] : [];
  const r = applyBlocks(original, blocks, Object.assign({}, facts, { packs, timeNotes }));
  for (const n of r.notes) say(n);
  for (const n of [...new Set(timeNotes)]) say(n);
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
      // no: la copia ya la tomó él, y otra más sería una pila sin tope
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

module.exports = { sync, applyBlocks, loadBlocks, loadPackBlocks, readBlock, blockState, machineFacts, defaultTarget, markerStart, markerEnd };
if (require.main === module) process.exit(main(process.argv.slice(2)));
