'use strict';

/**
 * guides-moved.test.js — T34 y T38 de la story 8.12, tanda R5 (AC 30 y 34).
 *
 * Las guías de plugins Bizuit pasaron a `guides/bizuit/` y los documentos fechados de decisiones a
 * `guides/decisions/`. Lo que se puede romper sin que nadie lo vea:
 *   - un reemplazo en la ruta vieja que apunta a una ruta que no existe (el revisor que abre la ruta
 *     vieja lee «movida a…» y no encuentra nada), o un reemplazo que falta y deja un 404 a quien la nombra;
 *   - una mención de la ruta vieja que quedó en el repo (sigue andando por el reemplazo, pero la story
 *     de retiro lo borra y ahí se rompe);
 *   - un producto nuevo que nace citando la ruta vieja desde la plantilla.
 *
 * Las rutas viejas salen del mapa (`scripts/lib/renames.json`, entradas `batch: R5`), nunca escritas acá:
 * la copia pública no lleva el mapa, y ahí esta prueba no mide (lo dice; no pasa en silencio).
 *
 * T49 de la tanda R8 (AC 45): `--stale-mentions` en 0 en los dos repos (una sola corrida, compartida con T34), y la
 * sección «Dónde vive cada cosa» de `guides/piezas-del-arnes.md` —el árbol y sus cuatro reglas—, enlazada desde «Qué
 * contiene» del README sin que el README pase su tope. Esas dos partes no necesitan el mapa: miden también en la copia.
 *
 * Correr: TYCON_SKILLS_DIR=<agent-skills>/skills node --test scripts/tests/guides-moved.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP = path.join(ROOT, 'scripts', 'lib', 'renames.json');
const HAS_MAP = fs.existsSync(MAP);
const NOT_MEASURED = !HAS_MAP && 'NO MEDIDO — copia pública sin el mapa';
const L = require(path.join(ROOT, 'scripts', 'lib', 'legacy-names.js'));

/** Las entradas de la tanda R5. Con el mapa y sin entradas R5, el mapa está roto: falla, no se saltea. */
function r5Entries() {
  const all = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.filter((e) => e && e.batch === 'R5');
  assert.ok(all.length > 0, 'el mapa no tiene entradas de la tanda R5');
  for (const e of all) {
    assert.strictEqual(e.kind, 'file', `${e.new}: la R5 mueve archivos sueltos`);
    assert.match(e.new, /^guides\/(bizuit|decisions)\/[^/]+\.md$/, `${e.new}: el destino es guides/bizuit/ o guides/decisions/`);
    assert.strictEqual(path.posix.basename(e.old), path.posix.basename(e.new), `${e.new}: cambia de carpeta, no de nombre`);
  }
  return all;
}
/** Lo que sólo nombra su propio repo no deja reemplazo (como en la 8.9). */
const leavesShim = (e) => Array.isArray(e.callers) && e.callers.some((c) => c !== 'same-repo');

test('T34 R5_Guides_ShimsAndInternalLinks — las 11 guías están en su carpeta nueva', { skip: NOT_MEASURED }, () => {
  const entries = r5Entries();
  // (las cuatro guías Bizuit salieron de la R5 con la story 8.41: se mudaron al paquete bizuit, en la capa del equipo, y un
  // nombre nuevo no puede tener dos viejos)
  assert.strictEqual(entries.length, 11, 'once documentos de decisiones');
  for (const e of entries) {
    assert.ok(fs.existsSync(path.join(ROOT, e.new)), `${e.new} existe`);
    const text = fs.readFileSync(path.join(ROOT, e.new), 'utf8');
    assert.ok(!L.isShim(text), `${e.new} es la guía, no un reemplazo`);
  }
});

test('T34 R5_Guides_ShimsAndInternalLinks — 10 reemplazos con la marca, y cada uno nombra una ruta nueva que existe', { skip: NOT_MEASURED }, () => {
  const entries = r5Entries();
  const withShim = entries.filter(leavesShim);
  assert.strictEqual(withShim.length, 10, '10 de 11 dejan reemplazo');
  for (const e of withShim) {
    const oldAbs = path.join(ROOT, e.old);
    assert.ok(fs.existsSync(oldAbs), `${e.old}: falta el reemplazo`);
    const text = fs.readFileSync(oldAbs, 'utf8');
    assert.ok(L.isGeneratedShim(e.old, text), `${e.old} es el reemplazo generado, tal cual (marca incluida)`);
    assert.strictEqual(L.shimTarget(oldAbs), path.join(ROOT, e.new), `${e.old}: la marca apunta a ${e.new}, que existe`);
    assert.ok(text.split('\n')[0].includes(e.new), `${e.old}: la primera línea dice «movida a ${e.new}»`);
  }
});

test('T34 R5_Guides_ShimsAndInternalLinks — la que sólo nombra su repo no deja reemplazo', { skip: NOT_MEASURED }, () => {
  const noShim = r5Entries().filter((e) => !leavesShim(e));
  assert.strictEqual(noShim.length, 1, 'una sola guía de la R5 no deja reemplazo');
  for (const e of noShim) {
    assert.ok(!fs.existsSync(path.join(ROOT, e.old)), `${e.old}: no deja reemplazo (sólo la nombra su repo)`);
    assert.ok(fs.existsSync(path.join(ROOT, e.new)), `${e.new} existe`);
  }
});

/**
 * UNA corrida de `spanish-names.js --stale-mentions --json` sobre los dos repos, compartida por T34 y T49 (tarda unos
 * 25 s: no se corre dos veces). Devuelve `{ skip }` sin agent-skills, o `{ out }` con la salida leída.
 */
let staleRun = null;
/** Sólo el «falta el checkout de agent-skills» de spanish-names.js es un NO MEDIDO. Cualquier otro rc 2 (un mapa roto, un
 *  glob de `homonyms` que no matchea, aunque su mensaje nombre agent-skills) es un fallo y tiene que verse. */
function skillsCheckoutMissing(r) {
  return r.status === 2 && /no encontré agent-skills \(/.test(`${r.stdout || ''}${r.stderr || ''}`);
}

test('T49 Close_NoStaleMentions_Docs — el salto «sin agent-skills» sólo vale para el checkout que falta', () => {
  assert.ok(skillsCheckoutMissing({ status: 2, stdout: '', stderr: '⛔ no encontré agent-skills (/lab/skills): sin el otro repo no sé si quedan nombres viejos allá' }), 'el checkout que falta: NO MEDIDO');
  assert.ok(!skillsCheckoutMissing({ status: 2, stdout: '', stderr: '⛔ homonyms: el glob lab/**/x.md no matchea ningún archivo de agent-skills' }), 'un glob de homonyms roto que nombra agent-skills: falla, no se saltea');
  assert.ok(!skillsCheckoutMissing({ status: 2, stdout: '', stderr: '⛔ el mapa no se puede leer' }), 'otro rc 2: falla');
  assert.ok(!skillsCheckoutMissing({ status: 1, stdout: '', stderr: 'no encontré agent-skills (/lab/skills)' }), 'con rc distinto de 2 no es el salto');
});

function staleMentions() {
  if (staleRun) return staleRun;
  const env = { ...process.env };
  delete env.TF_BUILD;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'publishing', 'spanish-names.js'), '--stale-mentions', '--json', '--repo', ROOT],
    { encoding: 'utf8', env, cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (skillsCheckoutMissing(r)) { staleRun = { skip: 'NO MEDIDO — sin agent-skills (seteá TYCON_SKILLS_DIR)' }; return staleRun; }
  assert.ok(r.status === 0 || r.status === 1, `--stale-mentions contestó (${r.status}): ${(r.stderr || '').slice(0, 400)}`);
  let out;
  try { out = JSON.parse(r.stdout); } catch (e) { assert.fail(`--stale-mentions --json no devolvió JSON: ${e.message}`); }
  assert.ok(Array.isArray(out.findings), '--stale-mentions --json trae findings');
  staleRun = { out };
  return staleRun;
}
const mentionLine = (f) => `${f.source}:${f.rel}:${f.line} — ${f.old}`;

test('T34 R5_Guides_ShimsAndInternalLinks — --stale-mentions no marca ninguna de las 11 rutas viejas', { skip: NOT_MEASURED }, (t) => {
  const olds = new Set(r5Entries().map((e) => e.old));
  const run = staleMentions();
  if (run.skip) { t.skip(run.skip); return; }
  const ours = run.out.findings.filter((f) => olds.has(f.old)).map(mentionLine);
  assert.deepStrictEqual(ours, [], `quedan menciones de las rutas viejas de la R5:\n${ours.join('\n')}`);
});

// (story 8.41: las guías de BIZUIT y las plantillas de producto se mudaron al paquete bizuit, en la capa del equipo; la
// entrada del mapa de la guía React es ahora la de esa mudanza, y la plantilla viaja como `CLAUDE.md.template`)
test('T38 R5_Templates_NewProductBornWithNewPath — la plantilla de formularios cita la guía React en su ruta nueva', { skip: NOT_MEASURED }, () => {
  const entries = JSON.parse(fs.readFileSync(MAP, 'utf8')).entries.filter((e) => e && e.kind === 'file');
  const react = entries.find((e) => e.new === 'packs/bizuit/guides/bizuit-plugin-react.md');
  assert.ok(react, 'el mapa tiene la entrada de la guía React');
  const file = path.join(ROOT, 'packs', 'bizuit', 'templates', 'forms', 'CLAUDE.md.template');
  if (!fs.existsSync(file)) { console.log('⏭ T38: NO MEDIDO — el árbol no trae el paquete bizuit (viaja en la capa del equipo)'); return; }
  const tpl = fs.readFileSync(file, 'utf8');
  assert.ok(tpl.includes(react.new), `la plantilla nombra ${react.new}`);
  const stale = entries.filter((e) => e.new.startsWith('packs/bizuit/guides/') && tpl.includes(e.old)).map((e) => e.old);
  assert.deepStrictEqual(stale, [], 'la plantilla no nombra ninguna ruta vieja de las guías');
});

// ── T49 · story 8.12, tanda R8 (AC 45) — las guías de entrada citan la ruta nueva y explican dónde vive cada cosa ──────
const PIECES = path.join(ROOT, 'guides', 'piezas-del-arnes.md');
const README = path.join(ROOT, 'INDEX.md');   // el índice: hasta 2026-10-14 se llamaba README.md
const WHERE_TITLE = 'Dónde vive cada cosa';
// las carpetas que el árbol tiene que nombrar, como mínimo
const TREE_DIRS = ['scripts/setup/', 'scripts/hooks/', 'scripts/tools/', 'scripts/lib/', 'scripts/nightly/', 'scripts/instincts/',
  'inbox/', 'pipelines/', 'guides/integrations/', 'guides/maintaining/'];
// las cuatro reglas del árbol, por palabras clave (no por el texto exacto)
const RULES = [
  { name: 'ubicación, con el desempate a scripts/lib/', all: [/ubicaci[óo]n/i, /desempate|dos etapas o m[áa]s/i, /scripts\/lib\//] },
  { name: 'el orden fuera de las carpetas', all: [/\borden\b/i, /numerad|lista (?:can[óo]nica )?del instalador|mapa del arn[ée]s/i] },
  { name: 'el sufijo de rol', all: [/sufijo/i, /-guard\b/, /-notice\b/, /-meter\b/] },
  { name: 'el tipo derivado de la ruta', all: [/\btipo\b/i, /deriva/i, /\bruta\b/i] },
];

/** El texto de la sección `## <title>` (hasta el próximo `## `), o null. */
function section(md, title) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => /^## /.test(l) && l.replace(/^## /, '').replace(/\s*\{#[^}]*\}\s*$/, '').trim() === title);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  return { heading: lines[at], text: lines.slice(at, end < 0 ? lines.length : end).join('\n') };
}
/** Los bloques de código cercados (```) de un texto. */
const codeBlocks = (text) => [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]);

/**
 * ¿El árbol nombra la carpeta `dir`? Escrita entera (`scripts/setup/`), o como árbol: `scripts/` en el nivel de afuera
 * del bloque (o bajo una raíz envolvente sola, como `repo/`) y `setup/` como hijo directo suyo, en una línea más adentro
 * o en la lista de hijos que trae la línea del padre (`guides/   + bizuit/ y decisions/`). Lo que el comentario del padre
 * dice en prosa (`scripts/   (ya no hay setup/)`) no cuenta, y las filas sin nombre (una línea en blanco, un «│» solo)
 * no cortan el subárbol.
 */
function treeNames(block, dir) {
  const wordAt = (text, word) => new RegExp(`(?:^|[^\\w/.-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);
  if (wordAt(block, dir)) return true;
  const segs = dir.replace(/\/$/, '').split('/');
  if (segs.length < 2) return false;
  const rows = block.split('\n').map((l) => {
    const lead = /^[\s│├└─┬┼|`'+\\-]*/.exec(l)[0];
    const rest = l.slice(lead.length);
    const token = (/^\S+/.exec(rest) || [''])[0];
    return { indent: lead.length, token, tail: rest.slice(token.length) };
  });
  // la lista de hijos al principio del comentario del padre: tokens `x/` separados por `+`, `·`, `,` o `y`; la primera
  // palabra que no es ni separador ni carpeta termina la lista (lo que sigue es prosa)
  const listed = (tail) => {
    const out = [];
    for (const w of tail.trim().split(/\s+/).filter(Boolean)) {
      if (/^(?:\+|·|,|y|and|\|)$/.test(w)) continue;
      const t = w.replace(/,$/, '');
      if (!/^[^\s/()]+\/$/.test(t)) break;
      out.push(t);
    }
    return out;
  };
  // el subárbol de la fila i: las filas más adentro, con las filas sin nombre del medio
  const subtreeEnd = (i) => {
    let end = i + 1;
    while (end < rows.length && (rows[end].indent > rows[i].indent || !rows[end].token)) end++;
    return end;
  };
  // el nivel de un tramo: la sangría más chica entre sus filas con nombre (las sin nombre no cuentan)
  const levelOf = (from, to) => Math.min(...rows.slice(from, to).filter((r) => r.token).map((r) => r.indent));
  const find = (from, to, depth) => {
    const level = levelOf(from, to);
    for (let i = from; i < to; i++) {
      const r = rows[i];
      if (!r.token || r.indent !== level || r.token !== `${segs[depth]}/`) continue;
      if (depth === segs.length - 1) return true;
      if (depth === segs.length - 2 && listed(r.tail).includes(`${segs[depth + 1]}/`)) return true;
      if (find(i + 1, subtreeEnd(i), depth + 1)) return true;
    }
    return false;
  };
  if (find(0, rows.length, 0)) return true;
  // una raíz envolvente sola en el nivel de afuera (`repo/`): el nivel de afuera pasa a ser el de sus hijos
  const top = levelOf(0, rows.length);
  const roots = rows.map((r, i) => i).filter((i) => rows[i].token && rows[i].indent === top);
  return roots.length === 1 && rows[roots[0]].token.endsWith('/') && find(roots[0] + 1, subtreeEnd(roots[0]), 0);
}
/** Las anclas que genera un título así: la de GitHub/Azure (minúsculas, sin puntuación, espacios a guiones), sin
 *  acentos, en %-encoding, o el `{#id}` explícito del encabezado. */
function anchorsOf(heading) {
  const explicit = /\{#([^}]+)\}\s*$/.exec(heading);
  const title = heading.replace(/^#+\s*/, '').replace(/\s*\{#[^}]*\}\s*$/, '').trim();
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
  const ascii = slug.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return [...new Set([slug, ascii, encodeURI(slug), ...(explicit ? [explicit[1]] : [])])];
}

test('T49 Close_NoStaleMentions_Docs — --stale-mentions en 0 en los dos repos (no sólo las rutas de la R5)', { skip: NOT_MEASURED }, (t) => {
  const run = staleMentions();
  if (run.skip) { t.skip(run.skip); return; }
  const all = run.out.findings.map(mentionLine);
  assert.deepStrictEqual(all, [], `quedan ${all.length} menciones de rutas viejas fuera de lo permitido:\n${all.join('\n')}`);
});

test('T49 Close_NoStaleMentions_Docs — piezas-del-arnes.md tiene «Dónde vive cada cosa» con el árbol y las cuatro reglas', () => {
  const sec = section(fs.readFileSync(PIECES, 'utf8'), WHERE_TITLE);
  assert.ok(sec, `guides/piezas-del-arnes.md no tiene la sección «## ${WHERE_TITLE}»`);
  const blocks = codeBlocks(sec.text);
  assert.ok(blocks.length > 0, `la sección «${WHERE_TITLE}» no tiene un bloque de código con el árbol`);
  const missing = TREE_DIRS.filter((d) => !blocks.some((b) => treeNames(b, d)));
  assert.deepStrictEqual(missing, [], `el árbol de «${WHERE_TITLE}» no nombra: ${missing.join(' ')}`);
  const prose = sec.text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  const rules = RULES.filter((r) => !r.all.every((re) => re.test(prose))).map((r) => r.name);
  assert.deepStrictEqual(rules, [], `a «${WHERE_TITLE}» le faltan reglas (fuera del árbol): ${rules.join(' · ')}`);
});

test('T49 Close_NoStaleMentions_Docs — el README enlaza «Dónde vive cada cosa» desde «Qué contiene» y no crece (T5 de readme-index)', () => {
  const sec = section(fs.readFileSync(PIECES, 'utf8'), WHERE_TITLE);
  assert.ok(sec, `guides/piezas-del-arnes.md no tiene la sección «## ${WHERE_TITLE}»`);
  const readme = fs.readFileSync(README, 'utf8');
  const contains = section(readme, 'Qué contiene');
  assert.ok(contains, 'el README tiene «## Qué contiene»');
  const links = [...contains.text.matchAll(/\]\((?:\.\/)?guides\/piezas-del-arnes\.md#([^)\s]+)\)/g)].map((m) => m[1]);
  const anchors = anchorsOf(sec.heading);
  assert.ok(links.some((a) => anchors.includes(a)),
    `«Qué contiene» del README no enlaza guides/piezas-del-arnes.md#${anchors[0]} (anclas encontradas: ${links.join(', ') || 'ninguna'})`);
  // el tope es el de T5 de readme-index.test.js: acá sólo el tamaño, sin duplicar el resto de esa prueba
  const bytes = Buffer.byteLength(readme, 'utf8');
  assert.ok(bytes <= 25 * 1024, `el README pesa ${bytes} bytes (tope ${25 * 1024}, T5 de readme-index.test.js)`);
});

test('T49 Close_NoStaleMentions_Docs — laboratorio: el árbol se lee entero o anidado, y el ancla sale del título', () => {
  const nested = [
    'repo/',
    '├─ scripts/',
    '│  ├─ setup/            instalar',
    '│  └─ nightly/          dependencies/ · watcher/',
    '├─ guides/              + bizuit/ y decisions/',
    '├─ pipelines/',
    '│  └─ templates/',
    '└─ inbox/               notes/',
  ].join('\n');
  for (const d of ['scripts/setup/', 'scripts/nightly/', 'guides/bizuit/', 'guides/decisions/', 'pipelines/', 'inbox/', 'pipelines/templates/', 'inbox/notes/']) {
    assert.ok(treeNames(nested, d), `el árbol anidado nombra ${d}`);
  }
  for (const d of ['scripts/tools/', 'guides/setup/', 'scripts/templates/', 'scripts/bizuit/']) assert.ok(!treeNames(nested, d), `el árbol anidado no nombra ${d}`);
  assert.ok(treeNames('scripts/lib/   bibliotecas\n', 'scripts/lib/'), 'la ruta entera');
  assert.ok(!treeNames('otro/scripts/lib/\n', 'scripts/lib/'), 'pegada a otra ruta no cuenta');
  assert.ok(anchorsOf(`## ${WHERE_TITLE}`).includes('dónde-vive-cada-cosa'));
  assert.ok(anchorsOf(`## ${WHERE_TITLE}`).includes('donde-vive-cada-cosa'));
  assert.ok(anchorsOf(`## ${WHERE_TITLE} {#donde}`).includes('donde'));
  const md = `# G\n\n## ${WHERE_TITLE}\n\n\`\`\`\nscripts/lib/\n\`\`\`\n\nLa ubicación.\n\n## Otra\n`;
  assert.strictEqual(codeBlocks(section(md, WHERE_TITLE).text).length, 1);
  assert.strictEqual(section(md, 'Dónde vive'), null, 'el título entero, no un pedazo');
});

test('T49 Close_NoStaleMentions_Docs — laboratorio: una línea en blanco o un «│» solo dentro del subárbol no corta los hijos', () => {
  assert.ok(treeNames('scripts/\n  hooks/\n\n  setup/', 'scripts/setup/'), 'después de una línea en blanco');
  assert.ok(treeNames('repo/\n├─ scripts/\n│  ├─ hooks/\n│\n│  └─ setup/', 'scripts/setup/'), 'después de un «│» solo');
  assert.ok(treeNames('repo/\n├─ scripts/\n│  ├─ hooks/\n│\n│  └─ setup/\n└─ guides/', 'scripts/hooks/'), 'el de antes del separador sigue contando');
  assert.ok(!treeNames('repo/\n├─ scripts/\n│  └─ hooks/\n│\n└─ guides/\n   └─ setup/', 'scripts/setup/'), 'el separador no estira el subárbol hasta la carpeta de al lado');
});

test('T49 Close_NoStaleMentions_Docs — laboratorio: el primer segmento va en el nivel de afuera y el hijo es un token de ruta, no un comentario', () => {
  assert.ok(!treeNames('repo/\n├─ adapters/\n│  └─ scripts/\n│     └─ setup/\n└─ guides/', 'scripts/setup/'), 'un scripts/ anidado en otra carpeta no es el de la raíz');
  assert.ok(!treeNames('adapters/\n  scripts/\n    setup/\nguides/', 'scripts/setup/'), 'sin raíz envolvente, tampoco');
  assert.ok(!treeNames('scripts/   (ya no hay setup/)\n', 'scripts/setup/'), 'el hijo nombrado en el comentario del padre no cuenta');
  assert.ok(!treeNames('scripts/   lo de antes: setup/\n', 'scripts/setup/'), 'tampoco después de prosa');
  assert.ok(!treeNames('scripts/\n  lab/\n    setup/', 'scripts/setup/'), 'un nieto no es el hijo');
  assert.ok(treeNames('guides/   + bizuit/ y decisions/\n', 'guides/decisions/'), 'la lista de hijos en la línea del padre sí cuenta');
  assert.ok(treeNames('repo/\n├─ scripts/\n│  └─ setup/', 'scripts/setup/'), 'bajo una raíz envolvente sí cuenta');
});
