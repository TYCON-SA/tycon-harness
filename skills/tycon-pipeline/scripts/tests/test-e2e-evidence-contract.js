#!/usr/bin/env node
/**
 * Contrato de la evidencia del gate E2E — la red que responde a dos preguntas del dev
 * (2026-08-05): "¿cómo nos aseguramos de que no quedaron instrucciones repetidas?" y
 * "¿cómo nos aseguramos de que el resultado es el mismo que teníamos localmente?".
 *
 * La respuesta a las dos es la misma pieza: UNA definición de qué tiene que traer la
 * evidencia (lib/e2e-evidence.js) que se usa para PRODUCIRLA y para VERIFICARLA. Así,
 * un repo que mantenga su gate propio (Ceibo levanta sus servidores, cosa que el gate
 * genérico no hace) igual se puede chequear contra la misma vara, mecánicamente.
 *
 * Correr: node test-e2e-evidence-contract.js (exit 0 OK / 1 fail)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require(path.join(__dirname, '..', 'lib', 'e2e-evidence.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Reporter JSON de Playwright con los 3 estados que importan.
const REPORTE = {
  suites: [{
    specs: [
      { title: 'lista la vista @ac-1', tests: [{ results: [{ status: 'passed' }] }] },
      { title: '@mutates aprieta Confirmar @ac-3', tests: [{ results: [{ status: 'passed' }] }] },
      { title: 'caso saltado @ac-9', tests: [{ results: [{ status: 'skipped' }] }] },
      { title: 'caso roto @ac-9', tests: [{ results: [{ status: 'failed' }] }] },
    ],
  }],
};

console.log('\n1. Extracción de títulos (lo que produce el contrato)');
{
  const t = lib.passedTitles(REPORTE);
  check('sólo los que PASARON', t.length === 2, JSON.stringify(t));
  check('conserva la marca @mutates y el @ac-N', t.some((x) => /@mutates/.test(x) && /@ac-3/.test(x)), JSON.stringify(t));
  check('no cuela el saltado ni el roto', !t.some((x) => /saltado|roto/.test(x)), JSON.stringify(t));
  check('json roto no explota', lib.passedTitles({}).length === 0);
}

console.log('\n2. Totales (skipped NO es failed — daba evidencia contradictoria)');
{
  const t = lib.totals(REPORTE);
  check('total/passed/failed/skipped correctos',
    t.total === 4 && t.passed === 2 && t.failed === 1 && t.skipped === 1, JSON.stringify(t));
}

console.log('\n3. Verificación del contrato (la misma vara para cualquier gate)');
{
  const completa = [
    '# E2E Gate — X-1 — 20260805T120000Z', '', 'verdict=PASS',
    '**Spec filter**: x.spec.ts', '', '## Playwright Run', '- total: 2', '',
    '## Tests corridos (títulos completos — contrato DODRT-C8)',
    '- lista la vista @ac-1', '- @mutates aprieta Confirmar @ac-3', '',
  ].join('\n');
  check('evidencia completa → cumple', lib.verify(completa).ok);

  const sinTitulos = completa.replace(/^- lista.*$\n^- @mutates.*$/m, '');
  const r1 = lib.verify(sinTitulos.replace('- lista la vista @ac-1\n- @mutates aprieta Confirmar @ac-3\n', ''));
  check('sección presente pero VACÍA → NO cumple (falla silenciosa)', !r1.ok && r1.sinTitulos, JSON.stringify(r1));

  const sinSeccion = completa.split('## Tests corridos')[0];
  const r2 = lib.verify(sinSeccion);
  check('sin la sección → NO cumple', !r2.ok && r2.faltantes.some((f) => f.id === 'tests_corridos'));
  check('el mensaje dice POR QUÉ hace falta', r2.faltantes.some((f) => /@mutates/.test(f.porque)));

  const sinVerdict = completa.replace(/^verdict=PASS$/m, '');
  check('sin verdict → NO cumple', !lib.verify(sinVerdict).ok);
  const sinFilter = completa.replace(/^\*\*Spec filter\*\*:.*$/m, '');
  check('sin spec filter → NO cumple', !lib.verify(sinFilter).ok);
}

console.log('\n4. El gate genérico del harness produce evidencia que CUMPLE');
{
  // Se ejercita el escritor real del gate (sin correr Playwright): mismo bloque de texto.
  const gate = fs.readFileSync(path.join(__dirname, '..', 'e2e-gate.sh'), 'utf8');
  check('el gate usa la pieza única (no una copia del extractor)',
    /lib\/e2e-evidence\.js/.test(gate) && !/out\.push\(sp\.title/.test(gate));
  check('el gate escribe las 3 marcas del contrato',
    /verdict=\$verdict/.test(gate) && /\*\*Spec filter\*\*/.test(gate) && /## Tests corridos/.test(gate));
  check('skipped se emite aparte', /- skipped: \$skipped/.test(gate));
  // Decisión 2026-08-05 (pregunta del dev): omitir una sección cuando está vacía es
  // AMBIGUO — no se distingue "no hubo errores" de "el gate no la escribe". Va siempre,
  // con texto explícito cuando no hay nada. Mismo criterio que "## Tests corridos".
  check('la sección de salida va SIEMPRE, con texto explícito si está vacía',
    /\(sin salida de error\)/.test(gate) && !/\[ -n "\$extra" \] &&/.test(gate));
}

console.log('\n5. CLI `verify` (para chequear la evidencia de CUALQUIER repo)');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
  const buena = path.join(tmp, 'ok.md');
  fs.writeFileSync(buena, ['verdict=PASS', '**Spec filter**: a.spec.ts', '## Tests corridos', '- x @ac-1'].join('\n'));
  const mala = path.join(tmp, 'mal.md');
  fs.writeFileSync(mala, ['verdict=PASS', '**Spec filter**: a.spec.ts'].join('\n'));
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'lib', 'e2e-evidence.js');
  check('evidencia buena → exit 0', spawnSync('node', [cli, 'verify', buena]).status === 0);
  const r = spawnSync('node', [cli, 'verify', mala], { encoding: 'utf8' });
  check('evidencia incompleta → exit 1', r.status === 1);
  check('el error dice cómo arreglarlo', /gate genérico del harness/.test(r.stderr || ''), (r.stderr || '').slice(0, 120));
}

console.log('');
if (failures > 0) { console.error(`✗ ${failures} caso(s) fallando`); process.exit(1); }
console.log('✓ contrato de evidencia E2E — todos los casos verdes');
