'use strict';

/**
 * publishing-guide-tables.test.js — T50 de la story 8.12, tanda R8 (AC 46): las dos tablas de
 * `guides/maintaining/publicacion-espejo.md` dicen lo mismo que `export.js --explain --json`.
 *
 * La guía es lo que lee una persona antes de decidir si algo sale en la copia pública; `--explain` es lo que el
 * exportador hace de verdad. Una tabla vieja (una carpeta que ya no existe, una exclusión que se mudó, una fecha que
 * dice «ésta es la de tal día») miente sin que nadie lo vea. Lo que esta prueba exige, con la gramática que fija la story:
 *   · «Qué entra» (`Repo | Entrada | Decisión`): cada entrada de primer nivel de cada repo, exactamente una vez, con la
 *     decisión de su primera regla (`fija`, `entra`, `afuera`); los globs de adentro de la celda cubren toda regla de la
 *     entrada que no es la entrada entera y todo «afuera» de adentro, y cada uno cubre al menos una (nada viejo).
 *     Lo que saca la tabla privada (`afuera privado`) NO se nombra: la guía viaja en la copia pública y nombrarlo sería
 *     publicar lo que esa tabla oculta. Una entrada cuya primera regla es `afuera privado` no se exige y, si la tabla la
 *     nombra, es un problema; una regla `afuera privado` de adentro no se exige a ninguna celda.
 *     Un glob con comodín en el primer segmento (una regla o un «afuera» que vale para todo el repo) no es de ninguna
 *     entrada: se exige que lo cubra un glob de ALGUNA fila de su repo (no de cada entrada que intersecta, que obligaría
 *     a repetirlo en todas), y cada glob así de la tabla tiene que cubrir alguno (nada viejo).
 *   · «Exclusiones fijas» (`Repo | Nunca sale | Por qué`): las de `--explain`, una a una, con la marca «clase» sólo
 *     donde corresponde; las de nombre viejo no se enumeran (las arma el exportador desde el mapa): una fila las anuncia
 *     y el nombre nuevo de cada una está en la tabla.
 *   · Ninguna fecha en el encabezado de «Qué entra»: la frase que presenta la tabla nombra esta prueba.
 *
 * En la cadena de la tabla, sólo lo que va entre backticks es una ruta o un glob. `x/` = `x/**`; `{a,b}` se expande; un
 * glob de la tabla cubre uno de `--explain` si, pasado a regex, lo matchea como texto (sus `*` cuentan como caracteres).
 *
 * El parser y el comparador son funciones puras: las pruebas de laboratorio de abajo los hacen fallar con tablas y
 * salidas inventadas, así la comparación contra la guía real no puede pasar en vacío.
 *
 * UN SOLO REPO INTERNO (story 8.18): la columna «Repo» es la FUENTE (`arnes` o `agent-skills`). Desde la unión las dos
 * son partes de un mismo repo, que el exportador parte por ruta, y `--explain` sigue dando el primer nivel de cada una:
 * la gramática no cambia. Cambió la tabla: agent-skills ya no trae `.gitignore` ni `README.md` propios. Con un
 * exportador que todavía lee dos repos, el repo único se ve dos veces entero y la comparación da decenas de entradas
 * «de más»: ese rojo es del exportador, no de la guía.
 *
 * Correr: TYCON_SKILLS_DIR=<agent-skills>/skills node --test scripts/tests/publishing-guide-tables.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const EXPORT = path.join(RAIZ, 'scripts', 'publishing', 'export.js');
const GUIDE = path.join(RAIZ, 'guides', 'maintaining', 'publicacion-espejo.md');
const THIS_TEST = 'scripts/tests/publishing-guide-tables.test.js';
const REPOS = ['arnes', 'agent-skills'];
const OLD_NAME_SUFFIX = ', con su nombre de antes de la story 8.9';
const DATE = /\d{4}-\d{2}-\d{2}/;

// ── La gramática: celdas, globs, normalización ──────────────────────────────────────────────────────────────────

/** Las celdas de una fila de tabla markdown (sin las barras de los bordes). */
function cellsOf(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
/** Lo que va entre backticks en una celda: lo único que es ruta o glob. */
function backticked(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}
/** `{a,b}` se expande (el primero, y el resto recursivo). */
function expandBraces(glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  return m[1].split(',').flatMap((alt) => expandBraces(glob.slice(0, m.index) + alt.trim() + glob.slice(m.index + m[0].length)));
}
/** `x/` = `x/**`, y `{a,b}` expandido. */
function normalizeGlob(glob) {
  return expandBraces(glob.trim()).map((g) => (g.endsWith('/') ? `${g}**` : g));
}
/** El glob de la tabla, como regex anclada: `**` cruza carpetas, `*` y `?` no. */
function globRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { re += '.*'; i++; } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
/** Un glob de la tabla cubre uno de `--explain` si lo matchea como texto. */
function covers(tableGlob, explainGlob) {
  return globRegex(tableGlob).test(explainGlob);
}
/** La entrada de primer nivel que nombra una celda de «Entrada»: sin la barra ni el `/**` del final. */
const entryName = (token) => token.trim().replace(/\/\*\*$/, '').replace(/\/+$/, '');
const firstSegment = (glob) => glob.split('/')[0];
const isWholeEntry = (glob, entry) => glob === entry || glob === `${entry}/**`;
// Un glob con comodín en el primer segmento (`**/X.md`, `*/pack.json`) es de todo el repo, no de una entrada.
const isRepoWide = (glob) => /[*?]/.test(firstSegment(glob));
/** La primera palabra de la decisión, sin marcas de markdown. */
const decisionWord = (cell) => ((/^[a-záéíóúñ]+/i.exec(cell.replace(/[*_`]/g, '').trim()) || [''])[0]).toLowerCase();

// ── El parser de la guía ────────────────────────────────────────────────────────────────────────────────────────

/**
 * La tabla de la sección cuyo encabezado contiene `title`: el encabezado, el párrafo que la presenta (el último antes
 * de la tabla) y sus filas con número de línea. `header` son los nombres de columna esperados. Lo que va entre cercas
 * ``` (un `# comentario` de bash, un encabezado o una tabla de ejemplo) no es encabezado ni tabla.
 */
function sectionTable(md, title, header) {
  const lines = md.split('\n');
  const fenced = [];
  let open = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { fenced.push(true); open = !open; continue; }
    fenced.push(open);
  }
  const h = lines.findIndex((l, i) => !fenced[i] && /^#{2,6} /.test(l) && l.includes(title));
  if (h < 0) return { error: `la guía no tiene una sección «${title}»` };
  const level = /^(#+)/.exec(lines[h])[1].length;
  let start = -1;
  for (let i = h + 1; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = /^(#+) /.exec(lines[i]);
    if (m && m[1].length <= level) break;
    if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1])) { start = i; break; }
  }
  if (start < 0) return { error: `la sección «${title}» no tiene tabla` };
  const cols = cellsOf(lines[start]);
  if (cols.join(' | ') !== header.join(' | ')) {
    return { error: `la tabla de «${title}» tiene las columnas «${cols.join(' | ')}» y la gramática dice «${header.join(' | ')}»` };
  }
  let p = start - 1;
  while (p > h && !lines[p].trim()) p--;
  let q = p;
  // la frase nunca incluye el encabezado, aunque el párrafo vaya pegado a él
  while (q - 1 > h && lines[q - 1].trim()) q--;
  const intro = p > h ? lines.slice(q, p + 1).join('\n') : '';
  const rows = [];
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    rows.push({ line: i + 1, text: lines[i], cells: cellsOf(lines[i]) });
  }
  return { heading: lines[h], intro, rows };
}

/** Las dos tablas de la guía. */
function parseGuide(md) {
  return {
    entra: sectionTable(md, 'Qué entra', ['Repo', 'Entrada', 'Decisión']),
    fijas: sectionTable(md, 'Exclusiones fijas', ['Repo', 'Nunca sale', 'Por qué']),
  };
}

// ── El comparador ───────────────────────────────────────────────────────────────────────────────────────────────

// Lo que saca la tabla privada de reemplazos: nunca se nombra en la guía (viaja en la copia pública).
const PRIVATE_RULE = 'afuera privado';
const publicRules = (entry) => entry.reglas.filter((r) => r.tipo !== PRIVATE_RULE);
const isPrivateEntry = (entry) => entry.reglas.length > 0 && entry.reglas[0].tipo === PRIVATE_RULE;

/** «Qué entra» contra `primerNivel` y los «afuera» de `coberturaExclusiones`. Devuelve la lista de problemas. */
function entraProblems(table, explain) {
  if (table.error) return [table.error];
  const problems = [];
  if (DATE.test(table.heading)) problems.push(`«Qué entra»: el encabezado tiene fecha («${table.heading.trim()}»): la tabla se compara con --explain, no es la de un día`);
  if (DATE.test(table.intro)) problems.push(`«Qué entra»: la frase que presenta la tabla tiene fecha (${DATE.exec(table.intro)[0]}): la tabla se compara con --explain, no es la de un día`);
  if (!table.intro.includes(THIS_TEST)) problems.push(`«Qué entra»: la frase que presenta la tabla no dice que la compara con --explain ${THIS_TEST}`);

  const byRepo = new Map(REPOS.map((r) => [r, new Map(explain.primerNivel.filter((p) => p.fuente === r).map((p) => [p.entrada, p]))]));
  const seen = new Map(REPOS.map((r) => [r, new Map()]));
  const wideNamed = new Map(REPOS.map((r) => [r, []]));
  for (const row of table.rows) {
    const where = `«Qué entra» fila de la línea ${row.line}`;
    const [repo, entryCell = '', decisionCell = ''] = row.cells;
    if (!byRepo.has(repo)) { problems.push(`${where}: el repo «${repo}» no es arnes ni agent-skills`); continue; }
    // `{a,b}` se expande también en la columna Entrada (la normalización vale para todo lo que va entre backticks)
    const entries = backticked(entryCell).flatMap(normalizeGlob).map(entryName);
    if (!entries.length) problems.push(`${where}: la columna Entrada no nombra ninguna entrada entre backticks`);
    const decision = decisionWord(decisionCell);
    const globs = backticked(decisionCell).flatMap(normalizeGlob);
    wideNamed.get(repo).push(...globs.filter(isRepoWide).map((g) => ({ glob: g, where })));
    const inner = globs.filter((g) => !isRepoWide(g) && g.includes('/') && !entries.some((e) => isWholeEntry(g, e)));
    for (const entry of entries) {
      seen.get(repo).set(entry, (seen.get(repo).get(entry) || 0) + 1);
      const real = byRepo.get(repo).get(entry);
      if (!real) { problems.push(`${where}: \`${entry}\` no es una entrada de primer nivel de ${repo} en --explain (de más)`); continue; }
      if (isPrivateEntry(real)) { problems.push(`${where}: \`${entry}\` (${repo}) la saca la tabla privada: no se nombra en una guía que viaja`); continue; }
      const want = real.reglas.length ? real.reglas[0].tipo : '(sin regla)';
      if (decision !== want) problems.push(`${where} (\`${entry}\`): la decisión dice «${decision || '(nada)'}» y --explain dice «${want}»`);
      // lo que la celda tiene que cubrir: las reglas de adentro y los «afuera» de adentro de la entrada (las de comodín en
      // el primer segmento son de todo el repo: se exigen abajo, una vez por repo; las de la tabla privada, nunca)
      const required = [
        ...publicRules(real).filter((r) => !isWholeEntry(r.glob, entry) && !isRepoWide(r.glob)).map((r) => ({ glob: r.glob, why: `regla ${r.tipo}` })),
        ...explain.coberturaExclusiones
          .filter((x) => x.origen === 'afuera' && x.fuente === repo && typeof x.glob === 'string'
            && firstSegment(x.glob) === entry && x.glob.includes('/') && !isWholeEntry(x.glob, entry))
          .map((x) => ({ glob: x.glob, why: 'afuera' })),
      ];
      const mine = inner.filter((g) => firstSegment(g) === entry);
      for (const r of required) {
        if (!mine.some((g) => covers(g, r.glob))) problems.push(`${where} (\`${entry}\`): \`${r.glob}\` (${r.why}) no lo cubre ningún glob de la celda Decisión`);
      }
      for (const g of mine) {
        if (!required.some((r) => covers(g, r.glob))) problems.push(`${where} (\`${entry}\`): el glob \`${g}\` no cubre ninguna regla ni «afuera» de --explain (¿viejo?)`);
      }
    }
    for (const g of inner) {
      if (!entries.includes(firstSegment(g))) problems.push(`${where}: el glob \`${g}\` no es de ninguna entrada de la fila`);
    }
  }
  for (const repo of REPOS) {
    for (const [entry, real] of byRepo.get(repo)) {
      if (isPrivateEntry(real)) continue;
      const n = seen.get(repo).get(entry) || 0;
      if (n !== 1) problems.push(`«Qué entra»: \`${entry}\` (${repo}) aparece ${n} veces en la columna Entrada; tiene que aparecer una`);
    }
    // lo de todo el repo (comodín en el primer segmento): alguna fila del repo lo cubre, y cada glob así cubre algo
    const wide = new Map();
    for (const p of byRepo.get(repo).values()) {
      for (const r of publicRules(p)) if (isRepoWide(r.glob)) wide.set(`${r.tipo} ${r.glob}`, { glob: r.glob, why: `regla ${r.tipo}` });
    }
    for (const x of explain.coberturaExclusiones) {
      if (x.origen === 'afuera' && x.fuente === repo && typeof x.glob === 'string' && isRepoWide(x.glob)) wide.set(`afuera ${x.glob}`, { glob: x.glob, why: 'afuera' });
    }
    const named = wideNamed.get(repo);
    for (const r of wide.values()) {
      if (!named.some((n) => covers(n.glob, r.glob))) problems.push(`«Qué entra» (${repo}): \`${r.glob}\` (${r.why}) es de todo el repo y no lo cubre ningún glob de una fila de ${repo}`);
    }
    for (const n of named) {
      if (![...wide.values()].some((r) => covers(n.glob, r.glob))) problems.push(`${n.where}: el glob \`${n.glob}\` no cubre ninguna regla ni «afuera» de --explain (¿viejo?)`);
    }
  }
  return problems;
}

const isOldName = (x) => x.clase === true && typeof x.motivo === 'string' && x.motivo.endsWith(OLD_NAME_SUFFIX);

/** «Exclusiones fijas» contra `exclusionesFijas`. Devuelve la lista de problemas. */
function fijasProblems(table, explain) {
  if (table.error) return [table.error];
  const problems = [];
  const fixed = explain.exclusionesFijas;
  const seen = new Map(REPOS.map((r) => [r, new Map()]));
  let announced = false;
  for (const row of table.rows) {
    const where = `«Exclusiones fijas» fila de la línea ${row.line}`;
    const [repo, globCell = ''] = row.cells;
    const repos = repo === 'los dos' ? REPOS : [repo];
    if (!REPOS.includes(repo) && repo !== 'los dos') { problems.push(`${where}: el repo «${repo}» no es arnes, agent-skills ni «los dos»`); continue; }
    const classRow = row.text.includes('«clase»');
    if (classRow && /nombre viejo/.test(row.text)) announced = true;
    for (const g of backticked(globCell).flatMap(normalizeGlob)) {
      for (const r of repos) {
        const x = fixed.find((f) => f.fuente === r && f.glob === g);
        if (!x) { problems.push(`${where}: \`${g}\` no es una exclusión fija de ${r} en --explain (de más)`); continue; }
        if (isOldName(x)) { problems.push(`${where}: \`${g}\` (${r}) es de nombre viejo: la tabla no las enumera, la fila que las anuncia alcanza`); continue; }
        seen.get(r).set(g, (seen.get(r).get(g) || 0) + 1);
        if (Boolean(x.clase) !== classRow) {
          problems.push(x.clase
            ? `${where}: \`${g}\` (${r}) es de «clase» y la fila no lo dice`
            : `${where}: \`${g}\` (${r}) no es de «clase» y la fila dice «clase»`);
        }
      }
    }
  }
  for (const x of fixed) {
    if (isOldName(x)) continue;
    const n = seen.get(x.fuente) ? seen.get(x.fuente).get(x.glob) || 0 : 0;
    if (n !== 1) problems.push(`«Exclusiones fijas»: \`${x.glob}\` (${x.fuente}) aparece ${n} veces en la columna Nunca sale; tiene que aparecer una`);
  }
  const old = fixed.filter(isOldName);
  if (old.length && !announced) problems.push('«Exclusiones fijas»: falta la fila que anuncia las de nombre viejo (dice «clase» y «nombre viejo»)');
  for (const x of old) {
    const motivo = x.motivo.slice(0, -OLD_NAME_SUFFIX.length);
    const nuevo = fixed.find((f) => f.fuente === x.fuente && !isOldName(f) && f.motivo === motivo);
    if (!nuevo) { problems.push(`«Exclusiones fijas»: una de nombre viejo de ${x.fuente} («${motivo}») no tiene nombre nuevo en --explain`); continue; }
    if (!(seen.get(x.fuente).get(nuevo.glob) > 0)) problems.push(`«Exclusiones fijas»: el nombre nuevo \`${nuevo.glob}\` (${x.fuente}) de una de nombre viejo no está en la tabla`);
  }
  return problems;
}

function guideProblems(md, explain) {
  const t = parseGuide(md);
  return [...entraProblems(t.entra, explain), ...fijasProblems(t.fijas, explain)];
}

// ── La guía real contra el --explain del día ────────────────────────────────────────────────────────────────────

const TEAM = fs.existsSync(path.join(RAIZ, 'perfil-equipo.json'));

function withoutGit(env) {
  const e = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_')) e[k] = v;
  return e;
}

test('T50 Close_PublishingGuideTablesMatchExplain — las dos tablas de la guía coinciden con --explain', { skip: !TEAM && 'NO MEDIDO — copia pública: sin la configuración del equipo (las tablas describen el arnés del equipo)' }, (t) => {
  const r = spawnSync(process.execPath, [EXPORT, '--explain', '--json', '--harness', 'HEAD', '--agent-skills', 'HEAD'],
    { cwd: RAIZ, encoding: 'utf8', env: { ...withoutGit(process.env), TYCON_GUIDES_DIR: RAIZ }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 2 && /repo fuente agent-skills/.test(r.stderr)) { t.skip('NO MEDIDO — sin agent-skills (seteá TYCON_SKILLS_DIR)'); return; }
  assert.strictEqual(r.status, 0, `--explain --json sale 0 (informa, no frena): ${r.stderr}`);
  const explain = JSON.parse(r.stdout);
  assert.ok(explain.primerNivel.length > 0 && explain.exclusionesFijas.length > 0, '--explain trae primer nivel y exclusiones fijas');
  const problems = guideProblems(fs.readFileSync(GUIDE, 'utf8'), explain);
  assert.deepStrictEqual(problems, [], `guides/maintaining/publicacion-espejo.md no coincide con --explain:\n  ${problems.join('\n  ')}`);
});

// ── Laboratorio: el comparador sabe fallar ──────────────────────────────────────────────────────────────────────
// Nombres inventados: esta prueba sale en la copia pública.

const LAB_EXPLAIN = Object.freeze({
  primerNivel: [
    { fuente: 'arnes', entrada: '.lab', tipo: 'carpeta', reglas: [{ tipo: 'fija', glob: '.lab/**' }] },
    { fuente: 'arnes', entrada: 'README.md', tipo: 'archivo', reglas: [{ tipo: 'entra', glob: 'README.md' }] },
    { fuente: 'arnes', entrada: 'docs', tipo: 'carpeta', reglas: [
      { tipo: 'entra', glob: 'docs/**' }, { tipo: 'entra', glob: 'docs/pack/alpha.md' }, { tipo: 'entra', glob: 'docs/pack/beta.md' }] },
    { fuente: 'agent-skills', entrada: 'skills', tipo: 'carpeta', reglas: [
      { tipo: 'entra', glob: 'skills/lab-*/**' }, { tipo: 'entra', glob: 'skills/core/alpha/**' }, { tipo: 'entra', glob: 'skills/core/beta/**' }] },
    { fuente: 'agent-skills', entrada: 'notes', tipo: 'carpeta', reglas: [{ tipo: 'afuera', glob: 'notes/**' }] },
  ],
  exclusionesFijas: [
    { fuente: 'arnes', glob: '.lab/**', motivo: 'lo del laboratorio' },
    { fuente: 'arnes', glob: 'docs/private.md', motivo: 'una guía privada' },
    { fuente: 'arnes', glob: '**/secret*.json', motivo: 'lo privado' },
    { fuente: 'arnes', glob: 'scripts/lab-map.json', motivo: 'el mapa', clase: true },
    { fuente: 'agent-skills', glob: '**/secret*.json', motivo: 'lo privado', clase: true },
    { fuente: 'arnes', glob: '**/hidden*.json', motivo: `lo privado${OLD_NAME_SUFFIX}`, clase: true },
    { fuente: 'agent-skills', glob: '**/hidden*.json', motivo: `lo privado${OLD_NAME_SUFFIX}`, clase: true },
  ],
  coberturaExclusiones: [
    { origen: 'afuera', fuente: 'arnes', glob: 'docs/drafts/one.md' },
    { origen: 'afuera', fuente: 'agent-skills', glob: 'notes/**' },
    { origen: 'afuera', fuente: 'agent-skills', glob: 'skills/core/gamma/**' },
    { origen: 'afuera-privado', fuente: 'arnes', indice: 0 },
    { origen: 'fija', fuente: 'arnes', glob: 'docs/private.md' },
  ],
});
const LAB_GUIDE = [
  '# Guía de laboratorio',
  '',
  '## Qué entra: la lista blanca',
  '',
  'Texto libre de la sección.',
  '',
  `La compara con \`--explain\` la prueba \`${THIS_TEST}\`:`,
  '',
  '| Repo | Entrada | Decisión |',
  '|---|---|---|',
  '| arnes | `.lab/` | fija (ver abajo) |',
  '| arnes | `README.md` | entra |',
  '| arnes | `docs/` | entra (núcleo, menos `docs/drafts/one.md`) · entra (paquete: `docs/pack/*.md`) |',
  '| agent-skills | `skills/` | **entra**: `skills/lab-*/`, `skills/core/{alpha,beta}/`; afuera `skills/core/gamma/` |',
  '| agent-skills | `notes/` | afuera: notas del equipo |',
  '',
  '## Exclusiones fijas',
  '',
  '| Repo | Nunca sale | Por qué |',
  '|---|---|---|',
  '| arnes | `.lab/` `docs/private.md` `**/secret*.json` | lo del equipo |',
  '| arnes | `scripts/lab-map.json` (de «clase») | el mapa |',
  '| agent-skills | `**/secret*.json` (de «clase») | lo privado |',
  '| los dos | las de «clase» con su nombre viejo: las arma el exportador desde el mapa | los nombres viejos no viajan |',
  '',
  '## Otra sección',
  '',
].join('\n');

const clone = (x) => JSON.parse(JSON.stringify(x));
/** Reemplaza `from` por `to` exactamente una vez (si no está, la prueba de laboratorio está mal escrita). */
function edit(md, from, to) {
  assert.strictEqual(md.split(from).length - 1, 1, `la guía de laboratorio tiene «${from}» una vez`);
  return md.replace(from, to);
}
/** Exactamente un problema, y nombra lo que se le pide. */
function oneProblem(problems, ...mentions) {
  assert.strictEqual(problems.length, 1, `un problema, no ${problems.length}:\n  ${problems.join('\n  ')}`);
  for (const m of mentions) assert.ok(problems[0].includes(m), `el problema nombra «${m}»: ${problems[0]}`);
  return problems[0];
}

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: la guía que coincide pasa, y la normalización entiende x/, {a,b} y los globs colapsados', () => {
  assert.deepStrictEqual(guideProblems(LAB_GUIDE, LAB_EXPLAIN), []);
  assert.deepStrictEqual(normalizeGlob('docs/'), ['docs/**']);
  assert.deepStrictEqual(normalizeGlob('skills/core/{alpha,beta}/'), ['skills/core/alpha/**', 'skills/core/beta/**']);
  assert.ok(covers('docs/pack/*.md', 'docs/pack/alpha.md'), 'un glob colapsado cubre su archivo');
  assert.ok(!covers('docs/pack/*.md', 'docs/pack/deep/alpha.md'), '`*` no cruza carpetas');
  assert.ok(covers('skills/lab-*/**', 'skills/lab-*/**'), 'los `*` de --explain cuentan como caracteres');
  assert.ok(covers('guides/bizuit/*.md', 'guides/bizuit/*.md'));
  const parsed = parseGuide(LAB_GUIDE);
  assert.strictEqual(parsed.entra.rows.length, 5);
  assert.strictEqual(parsed.fijas.rows.length, 4);
  assert.ok(parsed.entra.rows[0].line > 0, 'cada fila sabe su línea');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: primer nivel de más, de menos y una decisión cambiada', () => {
  oneProblem(guideProblems(edit(LAB_GUIDE, '| arnes | `README.md` | entra |', '| arnes | `README.md` `ghost/` | entra |'), LAB_EXPLAIN), '`ghost`', 'de más', 'línea 12');
  oneProblem(guideProblems(edit(LAB_GUIDE, '| agent-skills | `notes/` | afuera: notas del equipo |\n', ''), LAB_EXPLAIN), '`notes`', 'aparece 0 veces');
  oneProblem(guideProblems(edit(LAB_GUIDE, '| arnes | `README.md` | entra |', '| arnes | `README.md` | entra |\n| arnes | `README.md` | entra |'), LAB_EXPLAIN), '`README.md`', 'aparece 2 veces');
  oneProblem(guideProblems(edit(LAB_GUIDE, '| arnes | `.lab/` | fija (ver abajo) |', '| arnes | `.lab/` | entra |'), LAB_EXPLAIN), '`.lab`', '«entra»', '«fija»');
  oneProblem(guideProblems(edit(LAB_GUIDE, '| arnes | `README.md` | entra |', '| arnes | `README.md` | entra |\n| los dos | `README.md` | entra |'), LAB_EXPLAIN), '«los dos» no es arnes ni agent-skills');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: un glob de adentro viejo y un «afuera» sin cubrir', () => {
  // un glob que no cubre nada de --explain: nombra la fila y el glob
  oneProblem(guideProblems(edit(LAB_GUIDE, '(paquete: `docs/pack/*.md`)', '(paquete: `docs/pack/*.md` `docs/old-pack/*.md`)'), LAB_EXPLAIN), '`docs/old-pack/*.md`', '¿viejo?', 'línea 13');
  // dentro de unas llaves, cada alternativa cuenta sola
  oneProblem(guideProblems(edit(LAB_GUIDE, '`skills/core/{alpha,beta}/`', '`skills/core/{alpha,beta,delta}/`'), LAB_EXPLAIN), '`skills/core/delta/**`');
  // el «afuera» de adentro que la celda no nombra
  oneProblem(guideProblems(edit(LAB_GUIDE, 'menos `docs/drafts/one.md`', 'menos los borradores'), LAB_EXPLAIN), '`docs/drafts/one.md`', '(afuera)');
  oneProblem(guideProblems(edit(LAB_GUIDE, '; afuera `skills/core/gamma/`', ''), LAB_EXPLAIN), '`skills/core/gamma/**`', '(afuera)');
  // una regla «entra» de adentro sin cubrir
  const problems = guideProblems(edit(LAB_GUIDE, '(paquete: `docs/pack/*.md`)', '(paquete: sus dos guías)'), LAB_EXPLAIN);
  assert.deepStrictEqual(problems.map((p) => /`(docs\/pack\/[^`]+)`/.exec(p)[1]), ['docs/pack/alpha.md', 'docs/pack/beta.md'], problems.join('\n'));
  // un glob de otra entrada en la fila
  oneProblem(guideProblems(edit(LAB_GUIDE, '| arnes | `README.md` | entra |', '| arnes | `README.md` | entra (menos `docs/drafts/one.md`) |'), LAB_EXPLAIN), 'no es de ninguna entrada de la fila');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: una fija de más, una de menos y la marca de clase mal puesta', () => {
  oneProblem(guideProblems(edit(LAB_GUIDE, '`**/secret*.json` | lo del equipo', '`**/secret*.json` `docs/extra.md` | lo del equipo'), LAB_EXPLAIN), '`docs/extra.md`', 'de más');
  oneProblem(guideProblems(edit(LAB_GUIDE, ' `docs/private.md` `**/secret*.json` |', ' `**/secret*.json` |'), LAB_EXPLAIN), '`docs/private.md`', 'aparece 0 veces');
  // `x/` en la tabla es `x/**` de --explain: sin la barra no es la misma
  const bare = guideProblems(edit(LAB_GUIDE, '| arnes | `.lab/` `docs', '| arnes | `.lab` `docs'), LAB_EXPLAIN);
  assert.deepStrictEqual(bare.map((p) => /`([^`]+)`/.exec(p)[1]), ['.lab', '.lab/**'], `\`.lab\` de más y \`.lab/**\` sin nombrar:\n${bare.join('\n')}`);
  oneProblem(guideProblems(edit(LAB_GUIDE, '`scripts/lab-map.json` (de «clase»)', '`scripts/lab-map.json`'), LAB_EXPLAIN), '`scripts/lab-map.json`', 'es de «clase» y la fila no lo dice');
  // la marca en una fila de las que no son de clase: las tres de la fila lo dicen
  const marked = guideProblems(edit(LAB_GUIDE, '| lo del equipo |', '| lo del equipo, de «clase» |'), LAB_EXPLAIN);
  assert.strictEqual(marked.length, 3, marked.join('\n'));
  assert.ok(marked.every((p) => p.includes('no es de «clase» y la fila dice «clase»')), marked.join('\n'));
  // «los dos» con una de clase en un repo y no en el otro: la marca no puede valer para los dos
  const both = guideProblems(edit(edit(LAB_GUIDE, ' `**/secret*.json` | lo del equipo', ' | lo del equipo'),
    '| agent-skills | `**/secret*.json` (de «clase») | lo privado |', '| los dos | `**/secret*.json` (de «clase») | lo privado |'), LAB_EXPLAIN);
  oneProblem(both, '`**/secret*.json` (arnes)', 'no es de «clase»');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: las de nombre viejo se anuncian, no se enumeran, y su nombre nuevo está', () => {
  oneProblem(guideProblems(edit(LAB_GUIDE, 'las de «clase» con su nombre viejo', 'las otras de «clase»'), LAB_EXPLAIN), 'falta la fila que anuncia');
  const listed = guideProblems(edit(LAB_GUIDE, 'las arma el exportador desde el mapa', '`**/hidden*.json`'), LAB_EXPLAIN);
  assert.strictEqual(listed.length, 2, listed.join('\n'));
  assert.ok(listed.every((p) => p.includes('es de nombre viejo')), listed.join('\n'));
  // sin el nombre nuevo en la tabla (en un repo): lo dice por la de nombre viejo, además de la fija que falta
  const noNew = guideProblems(edit(LAB_GUIDE, '| agent-skills | `**/secret*.json` (de «clase») | lo privado |\n', ''), LAB_EXPLAIN);
  assert.ok(noNew.some((p) => p.includes('el nombre nuevo `**/secret*.json` (agent-skills)')), noNew.join('\n'));
  // una de nombre viejo cuyo nombre nuevo --explain no trae
  const orphan = clone(LAB_EXPLAIN);
  orphan.exclusionesFijas.push({ fuente: 'arnes', glob: '**/lost*.json', motivo: `otra cosa${OLD_NAME_SUFFIX}`, clase: true });
  oneProblem(guideProblems(LAB_GUIDE, orphan), 'no tiene nombre nuevo');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: sin fecha en el encabezado, la frase nombra la prueba y la tabla tiene sus columnas', () => {
  oneProblem(guideProblems(edit(LAB_GUIDE, '## Qué entra: la lista blanca', '## Qué entra: la lista blanca (2099-01-01)'), LAB_EXPLAIN), 'encabezado tiene fecha');
  oneProblem(guideProblems(edit(LAB_GUIDE, `La compara con \`--explain\` la prueba \`${THIS_TEST}\`:`, `La compara con \`--explain\` la prueba \`${THIS_TEST}\`; ésta es la del 2099-01-01:`), LAB_EXPLAIN), 'frase que presenta la tabla tiene fecha');
  oneProblem(guideProblems(edit(LAB_GUIDE, `La compara con \`--explain\` la prueba \`${THIS_TEST}\`:`, 'La tabla viva la imprime `--explain`:'), LAB_EXPLAIN), THIS_TEST);
  oneProblem(guideProblems(edit(LAB_GUIDE, '| Repo | Nunca sale | Por qué |', '| Repo | Glob | Por qué |'), LAB_EXPLAIN), 'columnas');
  oneProblem(guideProblems(edit(LAB_GUIDE, '## Exclusiones fijas', '## Lo que nunca sale'), LAB_EXPLAIN), 'no tiene una sección «Exclusiones fijas»');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: un bloque de código no abre ni cierra secciones', () => {
  // un `# comentario` de bash entre el encabezado y la tabla no es un encabezado
  const commented = edit(LAB_GUIDE, 'Texto libre de la sección.', 'Texto libre de la sección.\n\n```bash\n# la tabla viva\nnode export.js --explain\n```');
  assert.deepStrictEqual(guideProblems(commented, LAB_EXPLAIN), []);
  // un encabezado de ejemplo dentro de un bloque, antes de la sección de verdad, no es la sección
  const example = edit(LAB_GUIDE, '# Guía de laboratorio\n', '# Guía de laboratorio\n\n```md\n## Qué entra (2099-01-01)\n| Repo | Entrada | Decisión |\n|---|---|---|\n```\n');
  assert.deepStrictEqual(guideProblems(example, LAB_EXPLAIN), []);
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: con el párrafo pegado al encabezado, el encabezado no es parte de la frase', () => {
  const intro = `## Qué entra: la lista blanca\n\nTexto libre de la sección.\n\nLa compara con \`--explain\` la prueba \`${THIS_TEST}\`:`;
  // el encabezado nombra la prueba y la frase pegada no: falta en la frase
  oneProblem(guideProblems(edit(LAB_GUIDE, intro, `## Qué entra: la lista blanca, \`${THIS_TEST}\`\nUna frase sin la prueba:`), LAB_EXPLAIN), 'no dice', THIS_TEST);
  // la fecha del encabezado se cuenta una vez, no dos
  oneProblem(guideProblems(edit(LAB_GUIDE, intro, `## Qué entra (2099-01-01)\nLa compara con \`--explain\` la prueba \`${THIS_TEST}\`:`), LAB_EXPLAIN), 'encabezado tiene fecha');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: la columna Entrada también expande {a,b}', () => {
  const explain = clone(LAB_EXPLAIN);
  explain.primerNivel.push(
    { fuente: 'arnes', entrada: 'alpha', tipo: 'carpeta', reglas: [{ tipo: 'entra', glob: 'alpha/**' }] },
    { fuente: 'arnes', entrada: 'beta', tipo: 'carpeta', reglas: [{ tipo: 'entra', glob: 'beta/**' }] });
  const md = edit(LAB_GUIDE, '| arnes | `README.md` | entra |', '| arnes | `README.md` | entra |\n| arnes | `{alpha,beta}/` | entra |');
  assert.deepStrictEqual(guideProblems(md, explain), []);
  // cada alternativa cuenta sola: una de más se nombra
  oneProblem(guideProblems(edit(md, '`{alpha,beta}/`', '`{alpha,beta,gamma}/`'), explain), '`gamma`', 'de más');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: lo que saca la tabla privada no se nombra en la guía', () => {
  const explain = clone(LAB_EXPLAIN);
  explain.primerNivel.push({ fuente: 'arnes', entrada: 'zeta', tipo: 'carpeta', reglas: [{ tipo: 'afuera privado', glob: 'zeta/**' }] });
  // la guía no la nombra: no falta nada (nombrarla publicaría lo que la tabla privada oculta)
  assert.deepStrictEqual(guideProblems(LAB_GUIDE, explain), []);
  // si la nombra, es un problema, diga lo que diga la decisión
  const named = edit(LAB_GUIDE, '| arnes | `README.md` | entra |', '| arnes | `README.md` | entra |\n| arnes | `zeta/` | afuera |');
  oneProblem(guideProblems(named, explain), '`zeta`', 'tabla privada', 'no se nombra');
  // una regla privada de adentro de una entrada pública no se exige, y un glob que sólo la cubre sale como viejo
  const inner = clone(LAB_EXPLAIN);
  const readme = inner.primerNivel.find((p) => p.fuente === 'arnes' && p.entrada === 'README.md');
  assert.ok(readme, 'el laboratorio tiene README.md en arnes');
  const docs = inner.primerNivel.find((p) => p.fuente === 'arnes' && p.reglas.length && p.reglas[0].tipo === 'entra' && p.tipo === 'carpeta');
  assert.ok(docs, 'el laboratorio tiene una carpeta que entra en arnes');
  docs.reglas.push({ tipo: 'afuera privado', glob: `${docs.entrada}/secreto/**` });
  assert.deepStrictEqual(guideProblems(LAB_GUIDE, inner), [], 'la regla privada de adentro no se exige');
});

test('T50 Close_PublishingGuideTablesMatchExplain — laboratorio: un glob con comodín en el primer segmento se exige en alguna fila de su repo', () => {
  // un «afuera» de todo el repo que la guía calla: se nombra
  const afuera = clone(LAB_EXPLAIN);
  afuera.coberturaExclusiones.push({ origen: 'afuera', fuente: 'arnes', glob: '**/HISTORY.md' });
  oneProblem(guideProblems(LAB_GUIDE, afuera), '`**/HISTORY.md`', '(afuera)');
  const named = edit(LAB_GUIDE, 'menos `docs/drafts/one.md`)', 'menos `docs/drafts/one.md`; en todo el repo, afuera `**/HISTORY.md`)');
  assert.deepStrictEqual(guideProblems(named, afuera), []);
  // nombrado en una fila del otro repo no vale
  const other = edit(LAB_GUIDE, '| afuera: notas del equipo |', '| afuera: notas del equipo, y `**/HISTORY.md` |');
  assert.ok(guideProblems(other, afuera).some((p) => p.includes('`**/HISTORY.md`') && p.includes('(afuera)')), guideProblems(other, afuera).join('\n'));
  // un glob con comodín que no cubre nada de --explain: viejo
  oneProblem(guideProblems(named, LAB_EXPLAIN), '`**/HISTORY.md`', '¿viejo?');
  // una regla «entra» con comodín en el primer segmento (--explain la pega a cada carpeta que intersecta): una fila alcanza
  const entra = clone(LAB_EXPLAIN);
  for (const p of entra.primerNivel) if (p.fuente === 'arnes' && p.tipo === 'carpeta') p.reglas.push({ tipo: 'entra', glob: '*/pack.json' });
  oneProblem(guideProblems(LAB_GUIDE, entra), '`*/pack.json`', 'regla entra');
  assert.deepStrictEqual(guideProblems(edit(LAB_GUIDE, '(paquete: `docs/pack/*.md`)', '(paquete: `docs/pack/*.md`; de cada carpeta, `*/pack.json`)'), entra), []);
});

module.exports = { parseGuide, guideProblems, entraProblems, fijasProblems, normalizeGlob, covers };
