'use strict';
// import-line.js — la línea de ~/.claude/CLAUDE.md que carga en cada sesión el índice de guías del arnés.
//
// El índice se llama `INDEX.md`; `README.md` es la portada para personas (la que muestra GitHub). Una máquina con la
// línea que apunta a `README.md` cargaría la portada en vez del índice, así que esa línea se reescribe a la nueva en su
// lugar, una sola vez y sin tocar el resto del archivo, en tres momentos:
//   · el aplicador del árbol NUEVO (install-tycon-hooks.sh / .ps1) la corre con `--fix` en cada instalación y en cada
//     actualización: el programa que decide la actualización es el instalado antes, pero el aplicador ya es el nuevo, así
//     que la misma actualización deja la línea nueva antes de la sesión siguiente;
//   · `harness.js` (install y cada arranque) la reescribe si la encuentra, y la agrega si no está;
//   · el aviso sincrónico del arranque (scripts/hooks/branch-guard-notice.js), si la sesión arrancó con la línea vieja, la
//     reescribe y además le pasa el índice a ESA sesión, que ya había leído el CLAUDE.md.
// También reconoce la línea con el nombre viejo del lugar: la pasa a INDEX.md con ese
// mismo nombre; mudarla al lugar es de `harness.js relocate`, nunca de una actualización.
//
// Este archivo viaja en la copia fija del programa: sólo `require` dentro de scripts/setup/harness/.
// Uso suelto (lo llama el aplicador): node import-line.js --fix [--check] [--quiet] [<CLAUDE.md>] — sale 0 siempre; dice
// qué hizo (con --quiet, sólo si cambió algo o no pudo). Sin ruta, ~/.claude/CLAUDE.md o $CLAUDE_MD_PATH.
// Casos: scripts/tests/import-line.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const PLACE = require('./place.js');

const INDEX_FILE = 'INDEX.md';
const OLD_INDEX_FILE = 'README.md';
const lineFor = (place, file) => `@~/.claude/${place}/${file}`;
/** La línea de hoy. */
const IMPORT_LINE = lineFor(PLACE.PLACE_NAME, INDEX_FILE);
/** La de hoy con el nombre viejo del lugar: vale (el nombre viejo resuelve) y sólo `relocate` la muda. */
const LEGACY_LINE = lineFor(PLACE.LEGACY_PLACE_NAME, INDEX_FILE);
/** Las formas viejas, las que apuntan a README.md como si fuera el índice: pasan a INDEX.md con el mismo nombre del lugar. */
const OLD_FORMS = Object.freeze([lineFor(PLACE.PLACE_NAME, OLD_INDEX_FILE), lineFor(PLACE.LEGACY_PLACE_NAME, OLD_INDEX_FILE)]);
/** Las que valen hoy. */
const CURRENT_FORMS = Object.freeze([IMPORT_LINE, LEGACY_LINE]);
/** Todas las formas que son «la línea del índice»: la de hoy primero. */
const ALL_FORMS = Object.freeze([...CURRENT_FORMS, ...OLD_FORMS]);
/** Las que nombran el lugar con su nombre viejo (las que muda `relocate`). */
const LEGACY_PLACE_FORMS = Object.freeze(ALL_FORMS.filter((l) => l.includes(`/${PLACE.LEGACY_PLACE_NAME}/`)));

const trimmed = (l) => l.replace(/\r$/, '').trim();
const isIndexLine = (l) => ALL_FORMS.includes(trimmed(l));
const isLegacy = (l) => LEGACY_PLACE_FORMS.includes(l);

/**
 * El texto con UNA línea del índice, apuntando a INDEX.md, en el lugar de la primera que aparezca (vieja o nueva); las
 * demás se van. El nombre del lugar se conserva: una máquina que todavía carga por el nombre viejo sigue así hasta que
 * la persona corre `relocate` (que pasa `relocate: true`). Si hay líneas con los dos nombres, queda la del lugar.
 * El resto del texto, y los finales de línea, no se tocan. → { text, changed, present }
 */
function rewrite(text, { relocate = false } = {}) {
  const lines = String(text).split('\n');
  const found = lines.map(trimmed).filter((t) => ALL_FORMS.includes(t));
  if (!found.length) return { text, changed: 0, present: false };
  const target = relocate || found.some((t) => !isLegacy(t)) ? IMPORT_LINE : LEGACY_LINE;
  let kept = false;
  let changed = 0;
  const out = [];
  for (const l of lines) {
    const t = trimmed(l);
    if (!ALL_FORMS.includes(t)) { out.push(l); continue; }
    if (kept) { changed++; continue; }
    kept = true;
    if (t === target) { out.push(l); continue; }
    out.push(l.replace(t, target));
    changed++;
  }
  return { text: changed ? out.join('\n') : text, changed, present: true };
}

/** ¿El texto tiene una forma VIEJA de la línea? (la sesión que lo leyó cargó la portada, o nada) */
const hasOldForm = (text) => String(text).split('\n').some((l) => OLD_FORMS.includes(trimmed(l)));

const claudeMdPath = (env = process.env, home = os.homedir()) => env.CLAUDE_MD_PATH || path.join(home, '.claude', 'CLAUDE.md');

/**
 * Reescribe la línea en el archivo, sólo si tiene una forma vieja o repetida. Nunca la agrega (eso es de `harness.js`):
 * un CLAUDE.md sin la línea es de alguien que no quiere el índice, o de una instalación a medias que repara el arranque.
 * Escribe a un temporal y lo cambia de nombre. → { status: 'fixed'|'ok'|'absent'|'no-file'|'error', changed, file, reason? }
 */
function fixFile(file, { check = false } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { status: 'no-file', changed: 0, file } : { status: 'error', changed: 0, file, reason: (e && e.code) || String(e) };
  }
  const r = rewrite(text);
  if (!r.present) return { status: 'absent', changed: 0, file };
  if (!r.changed) return { status: 'ok', changed: 0, file };
  if (check) return { status: 'fixed', changed: r.changed, file, dryRun: true };
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, r.text);
    fs.renameSync(tmp, file);
  } catch (e) {
    return { status: 'error', changed: 0, file, reason: (e && e.code) || String(e) };
  }
  return { status: 'fixed', changed: r.changed, file };
}

function main(argv) {
  const check = argv.includes('--check');
  const quiet = argv.includes('--quiet');
  if (!argv.includes('--fix')) { process.stderr.write('uso: node import-line.js --fix [--check] [--quiet] [<CLAUDE.md>]\n'); return 2; }
  const file = argv.find((a) => !a.startsWith('--')) || claudeMdPath();
  const r = fixFile(file, { check });
  const say = {
    fixed: `${check ? '(simulado) ' : ''}la línea del índice en ${file} pasa a INDEX.md`,
    ok: `la línea del índice en ${file} ya es la de hoy`,
    absent: `${file} no trae la línea del índice: no la agrego (la repone harness.js al arrancar)`,
    'no-file': `${file} no existe: nada que reescribir`,
    error: `no pude reescribir la línea del índice en ${file} (${r.reason}): la reescribe el próximo arranque`,
  };
  if (!quiet || r.status === 'fixed' || r.status === 'error') process.stdout.write(`${say[r.status]}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { INDEX_FILE, IMPORT_LINE, LEGACY_LINE, OLD_FORMS, CURRENT_FORMS, ALL_FORMS, LEGACY_PLACE_FORMS, rewrite, hasOldForm, isIndexLine, fixFile, claudeMdPath, main };
