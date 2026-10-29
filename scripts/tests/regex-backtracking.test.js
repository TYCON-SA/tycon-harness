#!/usr/bin/env node
'use strict';
// regex-backtracking.test.js — las expresiones que el análisis de código marcó porque un texto armado las cuelga
// (retroceso exponencial) ya no se cuelgan, y siguen reconociendo lo que reconocían.
//
// Lo que no se puede perder:
//   · cada expresión se lee del archivo donde vive, no de una copia: si vuelve la forma vieja, la prueba lo ve;
//   · el texto armado es el que nombra la alerta, repetido miles de veces; con la forma vieja, 25 repeticiones ya
//     tardan más de un segundo y cada una más duplica el tiempo;
//   · corre en un proceso aparte con tope de tiempo: una expresión colgada da rojo, no cuelga la suite.
// stable-data: no crea commits (los comandos de git son textos de muestra) y el reloj sólo mide cuánto tarda.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const REPETICIONES = 5000;
const TOPE_MS = 4000;

/** La expresión literal que empieza en `ancla` dentro del archivo, con sus banderas, como texto. */
function literal(rel, ancla) {
  const texto = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  const i = texto.indexOf(ancla);
  assert.ok(i >= 0, `${rel}: no encontré «${ancla}»`);
  const desde = texto.indexOf('/', i + ancla.length - 1);
  let j = desde + 1;
  let clase = false;
  for (; j < texto.length; j++) {
    const ch = texto[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '[') clase = true;
    else if (ch === ']') clase = false;
    else if (ch === '/' && !clase) break;
  }
  const banderas = /^[dgimsuyv]*/.exec(texto.slice(j + 1))[0];
  return texto.slice(desde, j + 1) + banderas;
}

/** Corre la expresión sobre el texto armado y sobre los casos normales, en otro proceso, con tope de tiempo. */
function medir(rx, armado, normales) {
  const programa = `const rx = ${rx}; const t = (s) => { rx.lastIndex = 0; return rx.test(s); };
    const normales = ${JSON.stringify(normales)}; const no = normales.filter((s) => !t(s));
    const a = Date.now(); t(${armado}); process.stdout.write(JSON.stringify({ ms: Date.now() - a, no }));`;
  const r = spawnSync(process.execPath, ['-e', programa], { encoding: 'utf8', timeout: TOPE_MS });
  assert.ok(!r.error && r.status === 0, `la expresión no terminó en ${TOPE_MS} ms con el texto armado (${r.error ? r.error.code : r.stderr})`);
  return JSON.parse(r.stdout);
}

const CASOS = [
  {
    nombre: 'Gate_ShellWithC_DashOptions — el shell con -c después de opciones -O',
    archivo: 'skills/tycon-pipeline/scripts/on-bash-write-gate.js', ancla: 'const conC = /',
    armado: `'sh' + ' -O -A'.repeat(${REPETICIONES}) + ' x'`,
    normales: ['bash -c "x"', "bash -O extglob -c 'x'", 'sh +o posix -e -c "y"', 'zsh --norc -xc "z"', 'ls; /bin/bash -c "q"', "bash -o +x -c 'x'", "bash -o +o -c 'x'", "sh +o posix +O x -c 'y'"],
  },
  {
    nombre: 'Gate_ShellWithC_PlusValues — el shell con valores que empiezan con +',
    archivo: 'skills/tycon-pipeline/scripts/on-bash-write-gate.js', ancla: 'const conC = /',
    armado: `'sh' + ' -o +o +o -o +x'.repeat(${REPETICIONES}) + ' x'`,
    normales: ["bash -o +x -c 'x'", "sh -o - -e -c 'x'", "bash +O - -c 'x'", "sh -O -- -c 'x'"],
  },
  {
    nombre: 'Gate_PipeToShell_EnvWithDashSlash — un pipe a env con opciones que parecen rutas',
    archivo: 'skills/tycon-pipeline/scripts/on-bash-write-gate.js', ancla: 'const A_UN_SHELL = /',
    armado: `'|env' + ' -/env'.repeat(${REPETICIONES}) + ' !'`,
    normales: ['x | bash', 'x |& /usr/bin/env -i sudo -E python3', 'x | nohup node', 'x | /bin/sh', 'x | env -S node', 'x | /env bash'],
  },
  {
    nombre: 'Gate_ArgvByIndex_TabsBetween — la lectura de argv por índice con tabuladores entre medio',
    archivo: 'skills/tycon-pipeline/scripts/on-bash-write-gate.js', ancla: 'const porIndice = /',
    armado: `'\\t=sys.argv[0]' + '\\tsys.argv[0]'.repeat(${REPETICIONES}) + '!'`,
    normales: ['a, b = sys.argv[1], sys.argv[2]', 'const x = process.argv[2];', 'r = sys.argv[1]', 'let y=process.argv[3]'],
  },
  {
    nombre: 'StartupLine_PullFlags_DoubleDash — las opciones del pull con guiones repetidos',
    archivo: 'scripts/setup/harness/startup-line.js', ancla: 'const PULL_FLAGS_RX = /',
    armado: `' -' + '-- -'.repeat(${REPETICIONES}) + '!'`,
    normales: [' --ff-only', ' -q --rebase=false', '', ' --ff-only  '],
  },
  {
    nombre: 'AzPr_RepoPrCreate_SpacedDashes — az con opciones vacías y espacios antes de repos pr',
    archivo: 'scripts/lib/az-pr.js', ancla: '!f.esBandera && /',
    armado: `'az ' + '   -!'.repeat(${REPETICIONES}) + ' x'`,
    normales: ['az repos pr create', 'az --org x repos pr update', 'AZ.cmd -o json repos pr create', 'az --only-show-errors repos pr create', 'az -x repos pr create'],
  },
  {
    nombre: 'CollisionGuard_GitWrite_DashCDoubleDash — git con -C y guiones repetidos',
    archivo: 'scripts/hooks/session-collision-guard.js', ancla: 'const GIT_ESCRIBE = /',
    armado: `'git' + ' -C --'.repeat(${REPETICIONES}) + ' x'`,
    normales: ['git commit -m x', 'git -C /tmp/r -c user.name=x commit', 'git --no-pager checkout x', 'git -c core.x=1 merge y', 'git stash pop', 'git -C - commit'],
  },
  {
    nombre: 'CollisionGuard_GitWrite_DoubleDashDash — git con «-- -» repetido',
    archivo: 'scripts/hooks/session-collision-guard.js', ancla: 'const GIT_ESCRIBE = /',
    armado: `'git ' + '-- -'.repeat(${REPETICIONES}) + '!'`,
    normales: ['git reset --hard', 'git cherry-pick abc'],
  },
];

for (const c of CASOS) {
  test(c.nombre, () => {
    const r = medir(literal(c.archivo, c.ancla), c.armado, c.normales);
    assert.deepStrictEqual(r.no, [], `dejó de reconocer: ${r.no.join(' · ')}`);
    assert.ok(r.ms < 1000, `el texto armado tardó ${r.ms} ms`);
  });
}

test('RegexBacktracking_NoMatches_StaySilent — lo que no reconocía lo sigue sin reconocer', () => {
  const rx = (a, b) => new Function(`return ${literal(a, b)}`)();
  assert.strictEqual(rx('scripts/hooks/session-collision-guard.js', 'const GIT_ESCRIBE = /').test('git stash list'), false);
  assert.strictEqual(rx('scripts/hooks/session-collision-guard.js', 'const GIT_ESCRIBE = /').test('git log --oneline'), false);
  assert.strictEqual(rx('scripts/setup/harness/startup-line.js', 'const PULL_FLAGS_RX = /').test(' origin main'), false);
  assert.strictEqual(rx('scripts/lib/az-pr.js', '!f.esBandera && /').test('az repos pr list'), false);
  assert.strictEqual(rx('skills/tycon-pipeline/scripts/on-bash-write-gate.js', 'const A_UN_SHELL = /').test('x | grep bash'), false);
});
