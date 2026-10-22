'use strict';
/**
 * test-scope-table.test.js — la tabla de casos del freno de pruebas sin alcance, corrida con el bash con el que el arnés
 * corre sus guiones en esta máquina: en Windows, el de Git (`findGitBash()`); en la Mac y en Linux, el del PATH.
 *
 * La misma tabla la corre `test-scope-guard.test.sh` con el bash de la Mac. Ésta existe para que corra también en el
 * ensayo de Windows (escenario `portable` de la 182, paso `suites`), que corre suites de Node: el freno es un guion de
 * bash que llama a Node, y en Windows eso pasa por el bash de Git, sus rutas y sus finales de línea.
 *
 * Correr:   node scripts/tests/test-scope-table.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findGitBash } = require('../lib/git-bash.js');

const RAIZ = path.join(__dirname, '..', '..');
const GUARD = path.join(RAIZ, 'scripts', 'hooks', 'test-scope-guard-pre.sh').replace(/\\/g, '/');
const { casos } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'test-scope-guard-cases.json'), 'utf8'));
const A_LA_VEZ = 4;
const TOPE_MS = 30000;   // un freno que se cuelga es un rojo con nombre, no una suite colgada

/** El freno con un caso: su código de salida (o por qué no lo hay). */
function frena(bash, casa, c) {
  const env = Object.assign({}, process.env, { HOME: casa, USERPROFILE: casa });
  delete env.TYCON_TEST_SCOPE_GUARD;
  delete env.TYCON_FULL_SUITE;
  return new Promise((listo) => {
    const p = spawn(bash, [GUARD], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    const reloj = setTimeout(() => { p.kill('SIGKILL'); listo(`venció el tope de ${TOPE_MS} ms`); }, TOPE_MS);
    p.on('error', (e) => { clearTimeout(reloj); listo(`no arrancó: ${e.code || e.message}`); });
    p.on('close', (codigo) => { clearTimeout(reloj); listo(codigo); });
    p.stdin.on('error', () => {});
    p.stdin.end(JSON.stringify({ tool_name: c.herramienta || 'Bash', tool_input: { command: c.cmd }, cwd: casa }));
  });
}

async function correrTabla() {
  const bash = findGitBash();
  assert.ok(bash.path, `no hay con qué correr el freno: ${bash.reason}`);
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scope-table-'));
  const mal = [];
  try {
    let siguiente = 0;
    const trabajador = async () => {
      while (siguiente < casos.length) {
        const c = casos[siguiente++];
        const dio = await frena(bash.path, casa, c);
        const espera = c.espera === 'frena' ? 2 : 0;
        if (dio !== espera) mal.push({ c, dio, espera });
      }
    };
    await Promise.all(Array.from({ length: A_LA_VEZ }, trabajador));
  } finally {
    fs.rmSync(casa, { recursive: true, force: true });
  }
  return mal;
}

// se lanza una sola vez para W1 y W2; un rechazo (sin bash) se guarda y lo dice cada prueba, no queda suelto
const resultado = correrTabla().catch((e) => ({ error: e }));
const tabla = async () => { const r = await resultado; if (r.error) throw r.error; return r; };
const lista = (m) => m.map((x) => `  esperaba ${x.espera} y dio ${x.dio}${x.c.herramienta ? ` (${x.c.herramienta})` : ''}: ${JSON.stringify(x.c.cmd)}`).join('\n');

test('W1 Guard_MeasuredCases_GitBash @story-7.52 @ac-7 — la tabla entera da lo esperado con el bash del arnés', async () => {
  // el mínimo sigue a la tabla: una que se achica en silencio deja formas sin probar
  assert.ok(casos.length >= 550, `la tabla trae ${casos.length} casos`);
  const mal = await tabla();
  assert.strictEqual(mal.length, 0, `${mal.length} de ${casos.length} casos no dan lo esperado:\n${lista(mal)}`);
});

test('W2 Guard_751Passes_StillPass_GitBash @story-7.52 @ac-6 — lo que pasaba en la 7.51 sigue pasando', async () => {
  const mal = (await tabla()).filter((x) => x.c.grupo === 'pasan-7.51' && x.espera === 0);
  assert.strictEqual(mal.length, 0, `${mal.length} de los que pasaban en la 7.51 ahora frenan:\n${lista(mal)}`);
});

test('W3 Reader_HostileInput_DecidesFast @story-7.52 @ac-3 — un comando enorme o retorcido frena rápido, sin colgarse ni romperse', () => {
  const { analizar } = require('../lib/test-scope.js');
  const formas = {
    'pwsh repetido hasta el tope y la suite al final': 'pwsh '.repeat(50000) + 'dotnet test',
    'más largo que el tope': 'x'.repeat(300 * 1024) + ' npm test',
    'docker exec anidado treinta veces': 'docker exec c '.repeat(30) + 'dotnet test',
    'un prefijo repetido miles de veces': 'nice '.repeat(20000) + 'npm test',
    'envoltorios anidados': 'bash -c "'.repeat(12) + 'npm test' + '"'.repeat(12),
  };
  for (const [que, cmd] of Object.entries(formas)) {
    // stable-data: el reloj sólo mide cuánto tarda la lectura, no depende de la fecha
    const ini = Date.now();
    const r = analizar(cmd);
    const ms = Date.now() - ini;
    assert.strictEqual(r.veredicto, 'frena', `${que}: dio ${r.veredicto}`);
    assert.ok(ms < 3000, `${que}: tardó ${ms} ms`);
  }
});
