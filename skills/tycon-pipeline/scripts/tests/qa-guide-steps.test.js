#!/usr/bin/env node
/**
 * qa-guide-steps.test.js — la guía del tester y su chequeo cuentan los pasos con la misma regla.
 *
 * Caso: al generar la guía salía «Sin pasos-tester» para un criterio que `--check` daba por cubierto con el mismo
 * archivo de pasos. Los pasos estaban escritos numerados («1. …»), la forma más común en las guías reales: la guía
 * sólo contaba como pasos las líneas «- …», y el chequeo aceptaba cualquier cosa bajo el «## AC N», aun un «Usuario:»
 * suelto.
 *
 * Cada prueba arma una story de pantalla con un criterio probado de verdad (un humo con `smoke-run.sh`) y corre
 * `qa-guide.js` como lo corre el pipeline, con una HOME de juguete.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/qa-guide-steps.test.js < /dev/null
 */
'use strict';
// stable-data: la hora de ahora es a propósito: la matriz descarta la evidencia más vieja que el código, y una hora fija
// se pudriría. El código de juguete se fecha una hora antes del humo, que corre en el momento.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..');
const QA = path.join(SCRIPTS, 'qa-guide.js');
const SMOKE_RUN = path.join(SCRIPTS, 'smoke-run.sh');

const tmpDirs = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Una story de pantalla con un criterio que no es de pantalla, probado con un humo: el criterio queda corrido. */
function storyCorrida(pasos) {
  const repo = path.join(tmp('qa-pasos-'), 'Proj');
  const dodDir = path.join(repo, '.advisors', 'dod-runtime');
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  for (const d of ['specs/stories', 'specs/qa', 'src']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  fs.mkdirSync(dodDir, { recursive: true });
  const code = path.join(repo, 'src', 'Pantalla.tsx');
  fs.writeFileSync(code, 'export const P = () => <p>Facturas</p>;\n');
  const hace1h = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(code, hace1h, hace1h);
  const storyPath = path.join(repo, 'specs', 'stories', '9-9-fixture.md');
  fs.writeFileSync(storyPath, [
    '---', 'story: 9.9', 'status: in-progress', 'files_to_modify:', '  - src/Pantalla.tsx', '---', '',
    '## Acceptance Criteria', '', '1. **Given** una factura, **Then** el total es la suma de los renglones. @sin-pantalla', '',
    '### Tests', '', '| ID | Test | AC | Nivel | Escenario | Esperado |', '|---|---|---|---|---|---|',
    '| T1 | `Factura.Total` | 1 | unit | x | y |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'specs', 'qa', '9.9-pasos.md'), pasos);
  fs.writeFileSync(path.join(repo, 'specs', 'qa', '9.9-legibilidad.md'), 'veredicto: OK\n');
  fs.writeFileSync(path.join(repo, 'specs', 'qa', '9.9-legibilidad-ui.md'), 'veredicto: OK\nscreens:\n  - src/Pantalla.tsx\ncaptures: ninguna — sin E2E en esta prueba\n');
  const home = tmp('qa-pasos-home-');
  const smoke = spawnSync('bash', [SMOKE_RUN, dodDir, '9.9', '--acs', '1', '--pass-if', 'el total es la suma', '--', 'true'],
    { env: { ...process.env, HOME: home }, cwd: repo, encoding: 'utf8' });
  assert.equal(smoke.status, 0, `${smoke.stdout}\n${smoke.stderr}`);
  return { repo, storyPath, home };
}

function qa(f, ...flags) {
  const env = { ...process.env, HOME: f.home };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [QA, '--story', f.storyPath, ...flags], { encoding: 'utf8', input: '', env, cwd: f.repo });
  return { rc: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const NUMERADOS = [
  'Usuario por defecto: cliente', '', '## AC 1 — el total queda bien', '',
  'Cargá una factura y mirá el total.', '',
  '1. Entrá a la lista de facturas.', '2. Abrí la primera.', '',
  '**Está bien si**: el total coincide con la suma de los renglones.', '',
].join('\n');

test('Generar_PasosNumerados_SinAvisoEnFalso @story-7.34 @ac-11 — pasos numerados: ni la guía ni el chequeo los dan por faltantes', () => {
  // 🔴 rojo: la guía decía «Sin pasos-tester: AC 1» y `--check` lo daba por cubierto, con el mismo archivo.
  const f = storyCorrida(NUMERADOS);
  const gen = qa(f);
  assert.equal(gen.rc, 0, gen.out);
  assert.match(gen.out, /1 verificados corriendo/, gen.out);
  assert.doesNotMatch(gen.out, /Sin pasos-tester/, gen.out);
  const chk = qa(f, '--check');
  assert.doesNotMatch(chk.out, /\(2\) ACs verificados corriendo SIN pasos-tester/, chk.out);
});

test('SoloUsuario_AvisaYCheckRechaza @story-7.34 @ac-11 — un «Usuario:» suelto no son pasos, para los dos', () => {
  // 🔴 rojo: `--check` daba por cubierto un criterio que sólo declaraba con qué usuario probar.
  const f = storyCorrida('## AC 1\nUsuario: cliente\n');
  const gen = qa(f);
  assert.equal(gen.rc, 0, gen.out);
  assert.match(gen.out, /Sin pasos-tester: AC 1/, gen.out);
  const chk = qa(f, '--check');
  assert.equal(chk.rc, 2, chk.out);
  assert.match(chk.out, /\(2\) ACs verificados corriendo SIN pasos-tester: #1/, chk.out);
});

test('Check_SinGuiaHtml_FrenaYDiceElComando — sin la guía HTML el chequeo da rojo y dice cómo generarla, sin generarla', () => {
  const f = storyCorrida(NUMERADOS);
  const html = path.join(f.repo, 'specs', 'qa', '9-9-fixture-guia-qa.html');
  const sin = qa(f, '--check');
  assert.equal(sin.rc, 2, sin.out);
  assert.match(sin.out, /Falta la guía HTML/, sin.out);
  assert.ok(sin.out.includes(html), sin.out);
  assert.ok(sin.out.includes(`${QA} --story ${f.storyPath}`), `dice el comando que la genera: ${sin.out}`);
  assert.ok(!fs.existsSync(html), 'el chequeo no la genera');
  assert.equal(qa(f).rc, 0);
  const con = qa(f, '--check');
  assert.doesNotMatch(con.out, /Falta la guía HTML/, con.out);
});
