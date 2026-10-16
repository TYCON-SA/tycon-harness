#!/usr/bin/env node
'use strict';
/**
 * npm-package-version.js — la versión del paquete de npm sube cuando cambia lo que el paquete trae (story 8.40, AC 11).
 *
 * El paquete `@tyconsa/harness` (scripts/setup/npm/) tiene su propia versión semver, que no es el número del arnés: npm
 * rechaza republicar una versión, y el workflow que publica (.github/workflows/npm-publish.yml) sale rojo si encuentra
 * la versión ya publicada con otro contenido. Para que eso no se descubra después del merge, la CI pública lo exige en
 * el pedido: si el rango toca algo bajo scripts/setup/npm/, `version` de su package.json tiene que ser MAYOR que la de
 * la base. Un pedido que no toca la carpeta no la mira. `version.json` del arnés no tiene nada que ver con esto.
 *
 * USO:  node scripts/ci/npm-package-version.js [--root <dir>] --range <base>...<punta>
 *   0 = no toca la carpeta, o la versión sube · 1 = la carpeta cambia y la versión no sube (o no es semver) ·
 *   2 = no pude mirar (el rango no resuelve, uso)
 * Lo corre scripts/ci/public-ci.sh en el paso `version`; sus pruebas: scripts/tests/npm-package.test.js (T10, T11).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const DIR = 'scripts/setup/npm/';
// la gramática de semver.org: cada identificador de la prerelease no vacío y, si es numérico, sin ceros adelante (`a..b`,
// `a.` o `01` los rechaza o los normaliza npm: el control tiene que verlos en el pedido, no `npm stage publish` después).
// Sin metadatos de build (`+…`): npm los saca al publicar, y el workflow buscaría en el registro una versión que no queda
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);

/** [mayor, menor, parche, prerelease|null] o null si no es una versión que npm publique TAL CUAL (también: hasta 256 caracteres y números seguros, como el semver de npm). */
function parseSemver(v) {
  const s = String(v || '');
  const m = s.length <= 256 ? SEMVER.exec(s) : null;
  if (!m || [m[1], m[2], m[3]].some((n) => !Number.isSafeInteger(Number(n)))) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] || null];
}
/**
 * <0, 0 o >0. Una prerelease es menor que la versión sin ella; entre dos prereleases, como dice semver §11: identificador
 * por identificador, los numéricos por número (`alpha.2` < `alpha.10`), un numérico menor que uno alfanumérico, y con todo
 * lo anterior igual, la que tiene más identificadores es mayor. Las dos tienen que pasar parseSemver (sin `+…`).
 */
function compareSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  const p = x[3].split('.'), q = y[3].split('.'); const num = (s) => /^\d+$/.test(s);
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    if (num(p[i]) && num(q[i])) return Number(p[i]) - Number(q[i]);
    if (num(p[i]) !== num(q[i])) return num(p[i]) ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return p.length - q.length;
}

function git(root, args) { return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); }

/** { code, lines } para el rango. */
function check({ root, base, tip }) {
  for (const x of [base, tip]) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${x}^{commit}`]).status !== 0) return { code: 2, lines: [`no pude mirar: ${x} no resuelve a un commit en ${root}`] };
  }
  const diff = git(root, ['diff', '--name-only', `${base}...${tip}`, '--', DIR]);
  if (diff.status !== 0) return { code: 2, lines: [`no pude mirar: git diff falló (${diff.stderr.trim()})`] };
  if (!diff.stdout.trim()) return { code: 0, lines: [`el rango no toca ${DIR}: no miro la versión del paquete`] };
  const versionAt = (ref) => {
    const s = git(root, ['show', `${ref}:${DIR}package.json`]);
    if (s.status !== 0) return { missing: true };
    try { return { version: JSON.parse(s.stdout).version }; } catch (e) { return { broken: e.message }; }
  };
  const after = versionAt(tip);
  if (after.missing) return { code: 0, lines: [`el rango saca ${DIR}package.json: no hay versión que exigir`] };
  if (after.broken || !parseSemver(after.version)) return { code: 1, lines: [`la versión de ${DIR}package.json no es semver («${after.version}»${after.broken ? `: ${after.broken}` : ''}): el paquete cambia: subí version en ${DIR}package.json`] };
  const before = versionAt(git(root, ['merge-base', base, tip]).stdout.trim() || base);
  if (before.missing || before.broken || !parseSemver(before.version)) return { code: 0, lines: [`el paquete es nuevo en este rango (versión ${after.version})`] };
  if (compareSemver(after.version, before.version) > 0) return { code: 0, lines: [`el paquete cambia y su versión sube: ${before.version} → ${after.version}`] };
  return { code: 1, lines: [`el paquete cambia: subí version en ${DIR}package.json (la base dice ${before.version} y el pedido ${after.version})`] };
}

function main(argv) {
  let root = process.cwd(), range = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]);
    else if (argv[i] === '--range' && argv[i + 1]) range = argv[++i];
    else { process.stderr.write(`opción desconocida: ${argv[i]}\n`); range = ''; break; }
  }
  const m = /^(.+?)\.\.\.(.+)$/.exec(range);
  if (!m) { process.stderr.write('uso: node scripts/ci/npm-package-version.js [--root <dir>] --range <base>...<punta>\n'); return 2; }
  const r = check({ root, base: m[1], tip: m[2] });
  for (const l of r.lines) console.log(`${r.code === 0 ? '✅' : r.code === 1 ? '❌' : '⛔'} npm-package-version: ${l}`);
  return r.code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseSemver, compareSemver, check };
