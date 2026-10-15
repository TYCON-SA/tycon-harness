'use strict';

/**
 * validation-public-notices.test.js — lo que la validación escribe como aviso de Azure no nombra nada privado (story 8.26,
 * tanda C, AC 45, T45).
 *
 * Desde el corte la validación corre sobre los pedidos del repo PÚBLICO, y Azure le devuelve al pedido un control con
 * la cuenta de errores y avisos y un enlace a la corrida. Un aviso (`##vso[task.logissue …]`) es lo que más fácil sale de
 * la corrida: no puede llevar el nombre de un repo de producto, una ruta privada ni el texto libre de un error o de la
 * salida de una suite (que puede traer cualquiera de las dos cosas). La regla: el aviso lleva texto fijo y cuentas; el
 * nombre y el motivo van en la línea de abajo, que es registro común y sólo lo ve quien tiene permiso en Azure.
 *
 * Dos mitades, porque una prueba estática sola no ve lo que llega en tiempo de corrida:
 *   · los YAML de la validación y sus plantillas: ningún `logissue` interpola algo fuera de una lista de variables que
 *     son números o nombres fijos; y los ayudantes que imprimen su primer argumento como aviso (`falla`, `red`) reciben
 *     ahí texto fijo;
 *   · los dos guiones que imprimen avisos con nombres (`pr-verdict.js`, `suites-report.js`), corridos con una marca
 *     inventada en los nombres, los motivos y las rutas: con `--public-notices` la marca no aparece en ningún aviso, y
 *     sigue en el registro (el detalle no se pierde).
 *
 * Correr: node --test scripts/tests/validation-public-notices.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VALIDATION_FILES = [
  'pipelines/azure-pipelines-pr.yml',
  'pipelines/templates/correr-suites.yml',
  'pipelines/templates/traer-repos.yml',
  'pipelines/templates/fetch-snapshot.yml',
];
// Lo que un aviso puede interpolar: cuentas, códigos de salida, segundos y el número de trabajo. Nada que venga de un
// archivo, de un error o de un nombre de repo. (`$APART` se arma en el mismo paso con una cuenta y texto fijo.)
const SAFE = new Set(['$(SUITES_SHARD)', '$(SUITES_OF)', '$CAP', '$RC', '$CODIGO', '$N', '$JOBS_NEEDED', '$RUNNING', '$OF', '$APART',
  '$SEEN', '$TOTAL', '${AGENT_JOBSTATUS}', '$FAILED_N', '$CLONED']);
// Los ayudantes que imprimen su PRIMER argumento como aviso; el resto de sus argumentos va a la línea común.
const HELPERS = ['falla', 'red'];
// El único `$( … )` admitido en el primer argumento de un ayudante: elegir entre dos textos fijos por el código de salida.
const PICK = /\$\(\[ "\$RC" = 1 \] && echo '[^']*' \|\| echo '[^']*'\)/g;
const MARK = 'lab-secret-mark-7f3a';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-notices-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Las interpolaciones de un texto de shell: `$VAR`, `${VAR}`, `$( … )` (sin anidar) y `$(( … ))` aparte. */
function interpolations(text) {
  const out = [];
  const noArith = text.replace(/\$\(\([^)]*\)\)/g, '');
  for (const m of noArith.matchAll(/\$\([^()]*(?:\([^()]*\)[^()]*)*\)|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9]/g)) out.push(m[0]);
  return out;
}

/** Lo que sigue a `from` hasta la comilla doble que cierra, respetando `$( … )` adentro (con sus propias comillas). */
function quoted(line, from) {
  let depth = 0; let out = '';
  for (let i = from; i < line.length; i += 1) {
    const c = line[i];
    if (c === '$' && line[i + 1] === '(') { depth += 1; out += '$('; i += 1; continue; }
    if (c === ')' && depth > 0) { depth -= 1; out += c; continue; }
    if (c === '"' && depth === 0 && line[i - 1] !== '\\') return out;
    out += c;
  }
  return out;
}

/** El primer argumento entre comillas dobles de una llamada `nombre "…"`. */
function firstArg(line, name) {
  const at = line.search(new RegExp(`(^|[\\s;&|({])${name} "`));
  if (at < 0) return null;
  return quoted(line, line.indexOf(`${name} "`, at) + name.length + 2);
}

/**
 * ¿Es segura esta interpolación? `${VAR}` y `$VAR` son la misma variable: la forma con llaves es la que pide el bash 3.2 de
 * macOS cuando la sigue un carácter no ASCII (scripts/ci/check-bash32-quoting.sh), y pasar a llaves no puede volver
 * «de afuera» una variable de la lista (2026-10-15: «${CAP}» en el paso del banco).
 */
const isSafe = (v) => SAFE.has(v) || SAFE.has(v.replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/, '$$$1'));

/** El texto del aviso: desde `##vso[task.logissue` hasta la comilla que cierra el `echo` (lo de después es otra cosa). */
const noticeText = (line) => quoted(line, line.indexOf('##vso[task.logissue'));

test('T45 PublicValidation_LogIssuesFixedTextOnly_NoInterpolationOutsideSafeList', () => {
  const bad = [];
  let issues = 0;
  for (const rel of VALIDATION_FILES) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `falta ${rel}`);
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (line.includes('##vso[task.logissue')) {
        issues += 1;
        const text = noticeText(line);
        const isHelper = /^\s*(falla|red)\(\)/.test(line);
        for (const v of interpolations(text)) {
          if (isSafe(v) || (isHelper && v === '$1')) continue;
          bad.push(`${rel}:${i + 1} interpola ${v}`);
        }
      }
      for (const h of HELPERS) {
        if (new RegExp(`^\\s*${h}\\(\\)`).test(line)) continue;
        const arg = firstArg(line, h);
        if (arg === null) continue;
        for (const v of interpolations(arg.replace(PICK, ''))) {
          if (!isSafe(v)) bad.push(`${rel}:${i + 1} ${h} recibe ${v} en el texto del aviso`);
        }
      }
    });
  }
  assert.ok(issues >= 20, `encontré sólo ${issues} avisos: la búsqueda no está viendo lo que dice mirar`);
  assert.deepStrictEqual(bad, [], `avisos de Azure con texto de afuera (el detalle va en la línea de abajo, sin ##vso):\n  ${bad.join('\n  ')}`);
});

test('T45 PublicValidation_TheRuleItself_CatchesTheCasesItIsFor', () => {
  // la regla misma, para que la de arriba no apruebe por una búsqueda mal escrita
  assert.deepStrictEqual(interpolations('No se pudo clonar $ADO: $ERR — y $(tr x < "$F") y $((A+1))'), ['$ADO', '$ERR', '$(tr x < "$F")']);
  assert.strictEqual(firstArg('  falla "el banco: $(cat x)" "$ERR"', 'falla'), 'el banco: $(cat x)');
  // con llaves o sin ellas, la misma variable; una de afuera sigue siendo de afuera, y un modificador no se normaliza
  assert.ok(isSafe('${CAP}') && isSafe('$CAP'));
  assert.ok(!isSafe('${ERR}') && !isSafe('${CAP:-x}'));
  assert.strictEqual(firstArg(`  [ "$RC" = 0 ] || falla "$([ "$RC" = 1 ] && echo 'uno' || echo 'dos')"`, 'falla').replace(PICK, ''), '');
});

test('T23 PublicValidation_GuardStepNotices_FixedTextAndTheCountOnly_WhatTheGuardSaysGoesToCommonLines', () => {
  // El paso que más cerca está de lo que no puede salir: corre el freno de publicación sobre el pedido (story 8.26,
  // tanda F2). Sus avisos llevan texto fijo y, a lo sumo, la cuenta; lo que el freno dice —el lugar de cada hallazgo—
  // va a líneas comunes del registro, con los `#` cambiados para que Azure no lea una orden en una ruta.
  const yml = fs.readFileSync(path.join(ROOT, 'pipelines/azure-pipelines-pr.yml'), 'utf8').split('\n');
  const end = yml.findIndex((l) => l.includes("displayName: 'El freno de publicación sobre el pedido'"));
  assert.ok(end > 0, 'el paso existe');
  let start = end;
  while (start > 0 && !/^\s*-\s+script:\s*\|/.test(yml[start])) start -= 1;
  const body = yml.slice(start + 1, end);
  const calls = body.filter((l) => firstArg(l, 'red') !== null && !/^\s*red\(\)/.test(l));
  assert.ok(calls.length >= 6, `el paso tiene ${calls.length} avisos: se esperaban los seis caminos rojos`);
  for (const l of calls) assert.deepStrictEqual(interpolations(firstArg(l, 'red')).filter((v) => v !== '$N'), [], `un aviso del paso interpola algo más que la cuenta: ${l.trim()}`);
  assert.ok(!body.some((l) => l.includes('##vso[') && !/^\s*red\(\)/.test(l)), 'todo aviso del paso sale por `red`, que es el que mira la regla de arriba');
  // la cuenta sale de la línea de cuentas del freno, y sólo si son cifras
  assert.ok(body.some((l) => /N="\$\(.*sed -n 's\/\^public-push-guard: verdict=\[a-z\]\* findings=\\\(\[0-9\]\[0-9\]\*\\\) \.\*\/\\1\/p'\)"/.test(l)), 'la cuenta se saca con una expresión que sólo deja pasar cifras');
  // lo que dice el freno se imprime sin `#`
  assert.ok(body.some((l) => /printf '%s\\n' "\$OUT" \| sed 's\/#\/♯\/g'/.test(l)), 'la salida del freno va al registro sin `#`');
});

function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ci', script), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const vsoLines = (out) => out.split('\n').filter((l) => l.includes('##vso['));

test('T45 Verdict_PublicNotices_MarkNeverInANotice_StillInTheLog', () => {
  const now = new Date().toISOString();
  const red = `${MARK}-suite.test.sh`;
  fs.writeFileSync(path.join(tmp, 'now.json'), JSON.stringify({ kind: 'bash-tests', ts: now, failures: [red, 'old.test.sh'],
    motivos: { [red]: `falló en /repos/${MARK}/x`, 'old.test.sh': `motivo ${MARK}` }, notTravelling: [`${MARK}-private.test.sh`],
    notRun: { [`${MARK}-heavy.test.sh`]: `no toca ${MARK}` }, reintentos: { [`${MARK}-flaky.test.sh`]: { primera: 'rojo', segunda: 'verde' } } }));
  fs.writeFileSync(path.join(tmp, 'photo.json'), JSON.stringify({ kind: 'bash-tests', ts: now, failures: ['old.test.sh'], motivos: {} }));
  fs.writeFileSync(path.join(tmp, 'baseline.json'), '{"cases":{}}');
  const base = ['--suites-actual', path.join(tmp, 'now.json'), '--suites-snapshot', path.join(tmp, 'photo.json'), '--baseline', path.join(tmp, 'baseline.json'), '--ado'];
  const pub = run('pr-verdict.js', [...base, '--public-notices']);
  assert.strictEqual(pub.code, 1, pub.out);
  assert.ok(vsoLines(pub.out).length >= 3, `esperaba avisos: ${pub.out}`);
  assert.deepStrictEqual(vsoLines(pub.out).filter((l) => l.includes(MARK)), [], 'ningún aviso de Azure lleva la marca');
  assert.ok(pub.out.split('\n').some((l) => !l.includes('##vso') && l.includes(red)), 'el nombre sigue en el registro');
  // sin la bandera (la 170, sobre el interno) los avisos siguen nombrando: es lo que la lista de avisos de hoy muestra
  const internal = run('pr-verdict.js', base);
  assert.ok(vsoLines(internal.out).some((l) => l.includes(red)), 'sin --public-notices el aviso nombra la suite, como hoy');
  // la ruta de una foto que no se deja leer tampoco sale en un aviso
  const noPhoto = run('pr-verdict.js', ['--suites-actual', path.join(tmp, 'now.json'), '--suites-snapshot', path.join(tmp, `${MARK}`, 'photo.json'),
    '--baseline', path.join(tmp, 'baseline.json'), '--ado', '--public-notices']);
  assert.strictEqual(noPhoto.code, 2, noPhoto.out);
  assert.deepStrictEqual(vsoLines(noPhoto.out).filter((l) => l.includes(MARK)), []);
});

test('T45 SuitesReport_PublicNotices_DisappearedCountedNotNamed', () => {
  fs.writeFileSync(path.join(tmp, 'prev.json'), JSON.stringify({ kind: 'bash-tests', ts: new Date().toISOString(), failures: [], motivos: {},
    ran: ['a.test.sh', `${MARK}-gone.test.sh`] }));
  fs.writeFileSync(path.join(tmp, 'ran.txt'), 'a.test.sh\n');
  fs.mkdirSync(path.join(tmp, 'detail'), { recursive: true });
  const args = ['--rep', path.join(tmp, 'rep.json'), '--build', '1', '--runs', '1', '--failures', '', '--detail', path.join(tmp, 'detail'),
    '--ran', path.join(tmp, 'ran.txt'), '--previous', path.join(tmp, 'prev.json')];
  const pub = run('suites-report.js', [...args, '--public-notices'], { TF_BUILD: 'True' });
  assert.strictEqual(pub.code, 0, pub.out);
  const notices = vsoLines(pub.out);
  assert.strictEqual(notices.length, 1, pub.out);
  assert.doesNotMatch(notices[0], new RegExp(MARK));
  assert.match(notices[0], /1 suite\(s\)/);
  assert.ok(pub.out.includes(`${MARK}-gone.test.sh`), 'el nombre, en el registro');
  const internal = run('suites-report.js', args, { TF_BUILD: 'True' });
  assert.match(vsoLines(internal.out).join('\n'), new RegExp(MARK), 'sin la bandera, como hoy');
});

test('T45 Validation_PassesPublicNoticesWhenTheRepoIsGithub', () => {
  const yml = fs.readFileSync(path.join(ROOT, VALIDATION_FILES[0]), 'utf8');
  const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const script of ['pr-verdict.js', 'suites-report.js']) {
    assert.match(code, new RegExp(`${script.replace('.', '\\.')}[^\\n]*\\$\\{PUBLIC\\[@\\]\\+"\\$\\{PUBLIC\\[@\\]\\}"\\}`), `${script} recibe la bandera`);
  }
  assert.match(code, /\[ "\$\{BUILD_REPOSITORY_PROVIDER:-\}" = GitHub \] && PUBLIC=\(--public-notices\)/, 'la bandera, sólo con un repo de GitHub');
});
