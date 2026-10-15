#!/usr/bin/env node
'use strict';
// guard-libs-check.js — la copia propia del freno de producción contra las bibliotecas compartidas (2026-10-14).
//
// POR QUÉ EXISTE. El freno instalado en /opt/tycon carga bibliotecas que el resto del arnés también usa (la raíz de repos,
// la configuración, dónde vive cada cosa en la máquina…). Hasta el 2026-10-14 el instalador copiaba las compartidas y el
// aviso de arranque las comparaba contra lo publicado: como cambian casi todos los días por motivos que no son del freno,
// el aviso pedía reinstalar —con la contraseña del Mac— casi en cada versión. Decisión del dueño: el freno lleva su PROPIA
// copia (scripts/production/guard-libs/), que se instala y se compara, y que se actualiza a conciencia.
//
// QUÉ HACE. Para quien mantiene el arnés, no para los devs: por cada copia, mira si la compartida cambió en algo que el freno
// USA. Parte cada archivo en sus piezas de primer nivel (funciones, constantes, el bloque que exporta), toma como usadas
// las que nombran el freno, la puerta, el índice o las otras copias (y lo que esas piezas nombran adentro del archivo), y
// compara pieza por pieza sin los comentarios. Una diferencia en lo que el freno no usa se dice y no frena; una en lo que
// usa frena hasta que alguien decide, y dice qué difiere. La decisión queda en sources.json (`reviewed`: el blob de la
// compartida cuando se decidió), así que no vuelve a frenar hasta que la compartida cambie otra vez.
// Es una lectura de texto, no un intérprete: ante la duda, una pieza se toma por usada (avisa de más, nunca de menos).
//
// Uso:
//   node scripts/production/guard-libs-check.js [--repo <dir>] [--all] [--json]   mira (0 bien · 1 hay que decidir · 2 no pude)
//   node scripts/production/guard-libs-check.js refresh <copia> [--repo <dir>]   la copia pasa a ser la compartida (el freno cambia)
//   node scripts/production/guard-libs-check.js keep <copia> [--repo <dir>]      queda la copia; se anota que se miró
// <copia> es la ruta dentro de guard-libs/ (lib/repos-root.js) o la de la compartida (scripts/lib/repos-root.js).
// Lo corre scripts/tests/install-guard.test.sh (T34).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARGS = process.argv.slice(2);
const valueOf = (flag) => { const i = ARGS.indexOf(flag); return i >= 0 ? ARGS[i + 1] : null; };
// lo que no es una opción (ni el valor de --repo): el subcomando y la copia
const POSITIONAL = ARGS.filter((a, i) => !a.startsWith('--') && ARGS[i - 1] !== '--repo');
const ROOT = path.resolve(valueOf('--repo') || path.join(__dirname, '..', '..'));
const COPY_DIR = path.join(ROOT, 'scripts', 'production', 'guard-libs');
const SOURCES = path.join(COPY_DIR, 'sources.json');
const SELF = 'node scripts/production/guard-libs-check.js';
// lo que corre del freno además de la copia: ahí se busca qué usa de cada biblioteca
const GUARD_FILES = ['scripts/hooks/prod-access-guard.js', 'scripts/production/production-index.js', 'scripts/production/tycon-prod-sql'];

const blobOf = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const die = (msg, code) => { console.error(`guard-libs-check: ${msg}`); process.exit(code); };

function readSources() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(SOURCES, 'utf8')); } catch (e) { die(`no pude leer ${path.relative(ROOT, SOURCES)} (${e.message})`, 2); }
  if (!doc || !Array.isArray(doc.files)) die(`${path.relative(ROOT, SOURCES)} no trae «files»`, 2);
  for (const f of doc.files) {
    if (!f || typeof f.copy !== 'string' || typeof f.source !== 'string' || typeof f.reviewed !== 'string') die(`${path.relative(ROOT, SOURCES)}: entrada inválida ${JSON.stringify(f)}`, 2);
  }
  return doc;
}

// una entrada por línea, como está escrito a mano: un cambio de decisión es una línea en el diff
function writeSources(doc) {
  const lines = doc.files.map((f) => `    ${JSON.stringify({ copy: f.copy, source: f.source, reviewed: f.reviewed }).replace(/^\{/, '{ ').replace(/\}$/, ' }').replace(/","/g, '", "').replace(/":"/g, '": "')}`);
  fs.writeFileSync(SOURCES, `{\n  "__doc": ${JSON.stringify(doc.__doc || '')},\n  "files": [\n${lines.join(',\n')}\n  ]\n}\n`);
}

// ── las piezas de primer nivel ────────────────────────────────────────────────────────────────────────────────────────
// Empieza una pieza cada línea en la columna 0 que no cierra nada ni sigue una expresión ni es un comentario.
const STARTS = /^(?![\s})\]/*.,?:+\-`|&]|$)/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
function normalize(lines) {
  return lines.filter((l) => !COMMENT_LINE.test(l)).map((l) => l.replace(/\s+$/, '')).filter(Boolean).join('\n');
}
function pieces(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (STARTS.test(line) && !COMMENT_LINE.test(line)) { cur = { first: line, lines: [line] }; out.push(cur); } else if (cur) cur.lines.push(line);
  }
  const seen = new Map();
  return out.map((p) => {
    const l = p.first;
    let m; let kind = 'stmt'; let names = []; let key;
    if ((m = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(l)) || (m = /^class\s+([\w$]+)/.exec(l))) { kind = 'decl'; names = [m[1]]; }
    else if ((m = /^(?:const|let|var)\s+([\w$]+)\s*=/.exec(l))) { kind = 'decl'; names = [m[1]]; }
    else if ((m = /^(?:const|let|var)\s*\{([^}]*)\}\s*=/.exec(l))) { kind = 'decl'; names = m[1].split(',').map((x) => x.split(':').pop().trim()).filter(Boolean); }
    else if (/^module\.exports\s*=/.test(l)) kind = 'exports';
    else if ((m = /^(?:module\.)?exports\.([\w$]+)\s*=/.exec(l))) { kind = 'decl'; names = [m[1]]; }
    else if (/^if\s*\(\s*require\.main\s*===\s*module\b/.test(l)) kind = 'main';
    if (kind === 'decl') key = names.join(', ');
    else if (kind === 'exports') key = 'module.exports';
    else if (kind === 'main') key = 'el bloque de línea de comandos';
    else key = `«${l.trim().slice(0, 60)}»`;
    const n = (seen.get(key) || 0) + 1; seen.set(key, n);
    if (n > 1) key = `${key} (#${n})`;
    return { key, kind, names, code: normalize(p.lines) };
  });
}
const esc = (name) => name.replace(/[$]/g, '\\$');
// adentro del mismo archivo una pieza nombra a otra por su nombre suelto
const mentions = (text, name) => new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`).test(text);
// desde otro archivo sólo se llega por lo que exporta: `lib.nombre`, `lib['nombre']` o `const { nombre } = require(…)`.
// Por el nombre suelto, `cli` aparecía en «mssql-cli» del freno y se tomaba por usado (medido con la copia de /opt).
function usedFromOutside(outside, name) {
  if (new RegExp(`\\.\\s*${esc(name)}(?![\\w$])`).test(outside)) return true;
  if (new RegExp(`\\[\\s*['"]${esc(name)}['"]\\s*\\]`).test(outside)) return true;
  for (const m of outside.matchAll(/\{([^{}]*)\}\s*=\s*require\s*\(/g)) if (m[1].split(',').some((x) => x.split(':')[0].trim() === name)) return true;
  return false;
}
const exportedNames = (code) => {
  const body = /\{([\s\S]*)\}/.exec(code);
  const map = new Map();
  if (!body) return map;
  for (const part of body[1].split(',')) {
    const m = /^\s*([\w$]+)\s*(?::\s*([\s\S]+?))?\s*$/.exec(part);
    if (m) map.set(m[1], (m[2] || m[1]).trim());
  }
  return map;
};

/** Qué piezas de la copia usa el freno: lo que nombran los de afuera, y lo que esas piezas nombran adentro. */
function usedKeys(copyPieces, outside) {
  const used = new Set();
  for (const p of copyPieces) {
    if (p.kind === 'stmt') used.add(p.key);                                       // corre al cargar
    else if (p.kind === 'decl' && p.names.some((n) => usedFromOutside(outside, n))) used.add(p.key);
  }
  for (let grew = true; grew;) {
    grew = false;
    const usedCode = copyPieces.filter((p) => used.has(p.key)).map((p) => p.code).join('\n');
    for (const p of copyPieces) {
      if (!used.has(p.key) && p.kind === 'decl' && p.names.some((n) => mentions(usedCode, n))) { used.add(p.key); grew = true; }
    }
  }
  return used;
}

/** La diferencia entre la copia y la compartida, partida en lo que el freno usa y lo que no. */
function compare(copyText, sourceText, outside) {
  const c = pieces(copyText); const s = pieces(sourceText);
  const used = usedKeys(c, outside);
  const byKeyS = new Map(s.map((p) => [p.key, p]));
  const byKeyC = new Map(c.map((p) => [p.key, p]));
  const inUse = []; const notInUse = [];
  for (const p of c) {
    if (p.kind === 'exports') {
      const q = byKeyS.get(p.key);
      const ec = exportedNames(p.code); const es = q ? exportedNames(q.code) : new Map();
      for (const [name, value] of ec) {
        if (es.get(name) === value) continue;
        (usedFromOutside(outside, name) ? inUse : notInUse).push(`${name} (${es.has(name) ? 'se exporta distinto' : 'la compartida ya no lo exporta'})`);
      }
      for (const name of es.keys()) if (!ec.has(name)) notInUse.push(`${name} (sólo lo exporta la compartida)`);
      continue;
    }
    const q = byKeyS.get(p.key);
    const where = used.has(p.key) ? inUse : notInUse;
    if (!q) where.push(`${p.key} (ya no está en la compartida)`);
    else if (q.code !== p.code) where.push(`${p.key} (cambió)`);
  }
  for (const q of s) if (!byKeyC.has(q.key)) notInUse.push(`${q.key} (sólo en la compartida)`);
  return { inUse, notInUse };
}

function examine(doc) {
  const results = [];
  const problems = [];
  const listed = new Set(doc.files.map((f) => f.copy));
  // cada archivo de la carpeta está declarado, y cada declarado existe
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
  for (const f of walk(COPY_DIR)) if (f !== 'sources.json' && !listed.has(f)) problems.push(`guard-libs/${f} no está declarado en sources.json: la copia propia tiene que decir de qué biblioteca sale cada archivo`);
  const copies = new Map();
  for (const f of doc.files) {
    try { copies.set(f.copy, fs.readFileSync(path.join(COPY_DIR, f.copy))); } catch { problems.push(`falta la copia guard-libs/${f.copy}`); }
  }
  const guardText = GUARD_FILES.map((g) => { try { return fs.readFileSync(path.join(ROOT, g), 'utf8'); } catch { problems.push(`no pude leer ${g}: sin él no sé qué usa el freno`); return ''; } }).join('\n');
  for (const f of doc.files) {
    const copy = copies.get(f.copy);
    if (!copy) continue;
    let source;
    try { source = fs.readFileSync(path.join(ROOT, f.source)); } catch { problems.push(`no existe la biblioteca compartida ${f.source} (de la que sale guard-libs/${f.copy})`); continue; }
    const r = { copy: f.copy, source: f.source, sourceBlob: blobOf(source), copyBlob: blobOf(copy), reviewed: f.reviewed };
    if (r.copyBlob === r.sourceBlob) { r.state = 'same'; results.push(r); continue; }
    const outside = guardText + '\n' + [...copies].filter(([k]) => k !== f.copy).map(([, v]) => v.toString('utf8')).join('\n');
    Object.assign(r, compare(copy.toString('utf8'), source.toString('utf8'), outside));
    // sólo comentarios distintos (la copia de tycon-config.js no lleva dos direcciones de ejemplo que el freno de publicar
    // toma por correos): para el freno es la misma
    if (!r.inUse.length && !r.notInUse.length) r.state = 'comments';
    else r.state = r.sourceBlob === f.reviewed ? 'decided' : (r.inUse.length ? 'decide' : 'unused');
    results.push(r);
  }
  return { results, problems };
}

function list(items, max = 8) { return items.slice(0, max).join(', ') + (items.length > max ? ` (+${items.length - max})` : ''); }

function check() {
  const doc = readSources();
  const { results, problems } = examine(doc);
  const all = ARGS.includes('--all');
  if (ARGS.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ results, problems }, null, 2)}\n`);
  } else {
    console.log('la copia propia del freno (scripts/production/guard-libs/) contra las bibliotecas compartidas:');
    for (const r of results) {
      if (r.state === 'same') { if (all) console.log(`  ✔ ${r.copy}: igual a ${r.source}`); continue; }
      if (r.state === 'comments') { if (all) console.log(`  ✔ ${r.copy}: igual a ${r.source} salvo comentarios`); continue; }
      if (r.state === 'decided') {
        console.log(`  ✔ ${r.copy}: difiere de ${r.source}, y ya se decidió dejar la copia`);
        if (all && (r.inUse.length || r.notInUse.length)) console.log(`      en lo que el freno usa: ${list(r.inUse) || 'nada'} · en lo que no: ${list(r.notInUse) || 'nada'}`);
        continue;
      }
      if (r.state === 'unused') { console.log(`  · ${r.copy}: ${r.source} difiere sólo en lo que el freno no usa — ${list(r.notInUse)}. No hace falta decidir.`); continue; }
      console.log(`  ⚠ ${r.copy}: ${r.source} cambió en lo que el freno usa — ${list(r.inUse)}`);
      if (r.notInUse.length) console.log(`      además, en lo que el freno no usa: ${list(r.notInUse)}`);
      console.log(`      decidí: refrescar la copia (el freno cambia y quien lo tiene reinstala una vez) → ${SELF} refresh ${r.copy}`);
      console.log(`              o dejarla como está (se anota que se miró)                              → ${SELF} keep ${r.copy}`);
    }
    if (!results.some((r) => r.state !== 'same' && r.state !== 'comments') && !all) console.log('  ✔ todas iguales a las compartidas en lo que el freno ejecuta');
    for (const p of problems) console.log(`  ⛔ ${p}`);
  }
  process.exit(problems.length || results.some((r) => r.state === 'decide') ? 1 : 0);
}

function decide(action) {
  const which = POSITIONAL[1];
  if (!which) die(`falta qué copia: ${SELF} ${action} <copia>`, 2);
  const doc = readSources();
  const f = doc.files.find((x) => x.copy === which || x.source === which || `scripts/production/guard-libs/${x.copy}` === which);
  if (!f) die(`${which} no es una copia declarada en sources.json (${doc.files.map((x) => x.copy).join(', ')})`, 2);
  let source;
  try { source = fs.readFileSync(path.join(ROOT, f.source)); } catch (e) { die(`no pude leer ${f.source} (${e.message})`, 2); }
  f.reviewed = blobOf(source);
  if (action === 'refresh') {
    fs.writeFileSync(path.join(COPY_DIR, f.copy), source);
    writeSources(doc);
    console.log(`guard-libs/${f.copy} es ahora igual a ${f.source}. El freno cambió: cuando esto llegue a main, el aviso de arranque le va a pedir reinstalar una vez a cada máquina con el freno.`);
  } else {
    writeSources(doc);
    console.log(`queda guard-libs/${f.copy} como está; se anotó que ${f.source} (blob ${f.reviewed.slice(0, 7)}) ya se miró. No vuelve a avisar hasta que la compartida cambie otra vez.`);
  }
}

if (require.main === module) {
  const command = POSITIONAL[0] || 'check';
  if (command === 'refresh' || command === 'keep') decide(command);
  else if (command === 'check') check();
  else die(`no entiendo «${command}»: check, refresh <copia> o keep <copia>`, 2);
}

module.exports = { pieces, compare, usedKeys };
