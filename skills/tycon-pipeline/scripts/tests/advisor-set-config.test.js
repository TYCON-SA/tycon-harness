'use strict';

/**
 * advisor-set-config.test.js — la superficie de CONFIG como disparador (FIX-4(a) y (b), 2026-08-25).
 *
 * EL AGUJERO QUE CIERRA: el arnés publica una tabla de "superficie vigilada" que incluye la config
 * de plugins, los `appsettings*.json` y los `.env`. **Su propia selección no podía entregarlos
 * nunca**: un commit que sólo toca archivos de configuración se clasificaba como "sólo
 * documentación" y el set de revisores quedaba vacío. O sea que reglas escritas sobre secretos
 * (SEC-C2/C8/C9), cadenas de conexión y settings faltantes (DOTNET-C6 — en producción resuelve a
 * nulo en silencio) existían, estaban documentadas, y no podían dispararse por su propio objeto.
 *
 * Los dos casos que sostienen el diseño y no se pueden perder:
 *   · `un-cambio-de-script-NO-dispara-nada`: 16% de los commits de un repo real tocan package.json,
 *     pero sólo el 7% de ésos cambia una dependencia. Sin esa discriminación, esto sería caro.
 *   · `el-set-base-de-un-diff-con-codigo-no-cambia`: lo nuevo es una rama para diffs SIN código.
 *     Si tocara el set base, encarecería cada entrega del equipo.
 *
 * Lanza `pipeline.js` → throttle DIARIO.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PIPELINE = path.join(path.resolve(__dirname, '..'), 'pipeline.js');

function git(dir, ...args) { spawnSync('git', ['-C', dir, ...args], { stdio: 'ignore' }); }

function repo({ deps } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'advset-'));
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
    name: 'x', dependencies: deps || { react: '18.2.0' }, scripts: { build: 'vite build' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(d, 'plugin.json.example'), '{"defaultSettings":{}}\n');
  fs.writeFileSync(path.join(d, 'appsettings.json'), '{"Logging":{}}\n');
  fs.writeFileSync(path.join(d, 'appsettings.Development.json'), '{"Logging":{}}\n');
  fs.writeFileSync(path.join(d, '.env.example'), 'X=1\n');
  fs.writeFileSync(path.join(d, 'README.md'), 'doc\n');
  fs.writeFileSync(path.join(d, 'src', 'A.cs'), 'class A {}\n');
  git(d, 'init', '-q', '-b', 'main', '.');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'base');
  return d;
}

// 🔴 HOME y el id de sesión, AISLADOS (2026-09-06). `pipeline.js advisors` deja una marca
// `step5-start` en `$HOME/.claude/.tycon-pipeline/advisor-runs/<sesión>.jsonl` — el ground-truth
// con el que el arnés decide si los revisores corrieron. Sin esto, las 12 invocaciones de esta
// suite escribían 12 eventos FALSOS en el ledger de la sesión que la estuviera corriendo.
// El env va como LISTA BLANCA y no como `{...process.env, HOME}`: `CLAUDE_CODE_SESSION_ID` gana
// sobre `TYCON_SESSION_ID` en `lib/session-id.js`, así que heredarlo dejaría el id vivo aunque el
// HOME estuviera aislado. Mismo patrón que el test hermano `advisor-ledger-cli.test.js`.
const HOME_AISLADO = fs.mkdtempSync(path.join(os.tmpdir(), 'advset-home-'));

// Los revisores de convenciones (.NET / React / Next) viven en el paquete `bizuit` desde la story
// 8.2: esta suite lo INSTALA explícitamente (`TYCON_PACKS_DIR` a los paquetes del repo) en vez de
// depender de que estén escritos en el código. Si `packs/bizuit` desaparece, esto se pone rojo.
const PACKS_REALES = path.resolve(__dirname, '..', '..', '..', '..', 'packs');
// Story 8.7 (AC 8): un repo que no declara `packs:` activa los paquetes que diga la configuración (`packs.default`, default
// «ninguno»), y para leerla el cargador ubica el arnés. Con la HOME aislada no lo encuentra solo: se resuelve antes y se
// declara el default de esta suite («todos los instalados», lo que contaba desde la 8.2).
const ARNES = require('../lib/harness-path.js').rutaArnesHook().dir;

function set(d, ...files) {
  const r = spawnSync(process.execPath, [PIPELINE, 'advisors', '--repo', d, '--files', ...files],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: HOME_AISLADO,
        LANG: 'en_US.UTF-8',
        TYCON_SESSION_ID: 'advisor-set-config-test',
        TYCON_PACKS_DIR: PACKS_REALES,
        TYCON_PACKS_DEFAULT: 'all',
        ...(ARNES ? { TYCON_GUIDES_DIR: ARNES } : {}),
      },
    });
  const j = JSON.parse(r.stdout || '{}');
  return (j.all || []).slice().sort();
}

// ── El registro VIVO, fotografiado antes de correr un solo caso ───────────────────────────────
// Lo lee el último test del archivo. Ver el comentario de `set()` y el caso de cierre.
const { sessionIdFileKey } = require('../lib/session-id.js');
const LEDGER_VIVO = path.join(os.homedir(), '.claude', '.tycon-pipeline', 'advisor-runs',
  `${sessionIdFileKey()}.jsonl`);
function tamanoLedgerVivo() {
  try { return fs.statSync(LEDGER_VIVO).size; } catch { return -1; } // -1 = no existe
}
const LEDGER_ANTES = tamanoLedgerVivo();

const DOTNET = 'tycon-plugin-dotnet-conventions';
const SB = 'tycon-plugin-security-basics';
const REACT = 'tycon-plugin-react-conventions';
const NEXT = 'tycon-plugin-nextjs-conventions';

// ── FIX-4(b) — config de plugins y secretos ───────────────────────────────────────────────────
test('la config de plugin selecciona el revisor .NET (DOTNET-C6: un setting faltante resuelve a nulo en producción)', () => {
  assert.deepEqual(set(repo(), 'plugin.json.example'), [DOTNET]);
});

test('appsettings y .env seleccionan el revisor de seguridad (SEC-C2/C8/C9)', () => {
  const d = repo();
  assert.deepEqual(set(d, 'appsettings.json'), [SB]);
  assert.deepEqual(set(d, '.env.example'), [SB]);
});

test('appsettings.Development.json NO dispara — hay repos que lo regeneran en cada build', () => {
  // Un disparador que se activa solo entrena a ignorarlo, y ahí se pierde también donde importaba.
  assert.deepEqual(set(repo(), 'appsettings.Development.json'), []);
});

test('pero el Development junto al de verdad no tapa al de verdad', () => {
  assert.deepEqual(set(repo(), 'appsettings.Development.json', 'appsettings.json'), [SB]);
});

test('un diff de puro docs sigue sin revisores', () => {
  assert.deepEqual(set(repo(), 'README.md'), []);
});

// ── FIX-4(a) — dependencias ───────────────────────────────────────────────────────────────────
test('un cambio de VERSIÓN de dependencia dispara el revisor de convenciones (REACT-W14)', () => {
  const d = repo({ deps: { react: '18.2.0' } });
  const p = path.join(d, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.dependencies.react = '18.3.0';
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  assert.deepEqual(set(d, 'package.json'), [REACT]);
});

test('con next, el revisor que entra es el de Next', () => {
  const d = repo({ deps: { react: '18.2.0', next: '14.0.0' } });
  const p = path.join(d, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.dependencies.zod = '3.0.0';
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  assert.deepEqual(set(d, 'package.json'), [NEXT]);
});

test('un cambio de SCRIPT no dispara nada', () => {
  // 🔴 La discriminación que hace barato al disparador: medido en un repo real, 115 de 730 commits
  // tocan package.json y sólo 8 cambian una dependencia. Sin esto, el 16% de los commits pagaría
  // un revisor de más.
  const d = repo();
  const p = path.join(d, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.scripts.build = 'vite build --mode x';
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  assert.deepEqual(set(d, 'package.json'), []);
});

test('un package.json sin cambios no dispara nada', () => {
  assert.deepEqual(set(repo(), 'package.json'), []);
});

test('sin react ni next, un cambio de dependencia no trae revisor de convenciones', () => {
  // Las convenciones de React/Next no aplican a un script de Node: sería ruido garantizado.
  const d = repo({ deps: { lodash: '4.0.0' } });
  const p = path.join(d, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.dependencies.lodash = '4.1.0';
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  assert.deepEqual(set(d, 'package.json'), []);
});

// ── no-regresión ──────────────────────────────────────────────────────────────────────────────
test('el set base de un diff CON código no cambia', () => {
  const d = repo();
  const base = set(d, 'src/A.cs');
  assert.ok(base.includes(DOTNET) && base.includes(SB) && base.includes('tycon-plugin-tests-coverage'),
    `lo nuevo es una rama para diffs SIN código; si tocara el set base encarecería cada entrega (dio: ${base.join(', ')})`);
});

// ── PIPE-DETECT (2026-09-17) — los guiones `.sh` son código ───────────────────────────────────
// Los guiones de CI del arnés despliegan y frenan en producción, y un diff de sólo `.sh` salía
// «sólo docs»: cero revisores de código. Sumados a mano sobre `scripts/ci/*.sh` encontraron un
// nombre crudo en una URL, un error tragado, una orden ejecutada dentro de `$(( ))` y un tamaño no
// numérico que hacía salir 0. Medido sobre 296 corridas: 42 tocaron un `.sh`, 4 sólo `.sh`.
// Sin filtro por palabras clave, a propósito: en un guion casi todo es «tragar un error»
// (`|| true`, `2>/dev/null`, `set -e` ausente) y el filtro no filtraría nada.
const SFH = 'tycon-silent-failure-hunter';
const { advisorAffectedByDelta } = require('../pipeline.js');

function conGuion(rel, contenido = '#!/usr/bin/env bash\ncurl -s "$URL/$NOMBRE" || true\n') {
  const d = repo();
  fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  fs.writeFileSync(path.join(d, rel), contenido);
  return d;
}

test('un diff de sólo `.sh` suma el revisor de seguridad y el de fallos silenciosos', () => {
  const d = conGuion('scripts/ci/humo.sh');
  assert.deepEqual(set(d, 'scripts/ci/humo.sh'), [SB, SFH].sort());
});

test('un `.test.sh` NO suma el de fallos silenciosos (una prueba no es superficie de producción)', () => {
  const d = conGuion('scripts/tests/lab-tool.test.sh');
  const s = set(d, 'scripts/tests/lab-tool.test.sh');
  assert.ok(!s.includes(SFH), `no debía entrar ${SFH}: ${JSON.stringify(s)}`);
});

test('un `.sh` bajo tests/ tampoco lo suma, aunque no se llame .test.sh', () => {
  const d = conGuion('scripts/tests/lib/doble.sh');
  assert.ok(!set(d, 'scripts/tests/lib/doble.sh').includes(SFH));
});

test('un diff de sólo `.md` sigue siendo sólo docs aunque el repo tenga guiones', () => {
  const d = conGuion('scripts/ci/humo.sh');
  assert.deepEqual(set(d, 'README.md'), []);
});

test('un `.sh` junto a un `.cs` no cambia el set base del `.cs` (sólo puede sumar el de fallos silenciosos)', () => {
  const d = conGuion('scripts/ci/humo.sh');
  const s = set(d, 'src/A.cs', 'scripts/ci/humo.sh');
  assert.ok(s.includes(DOTNET) && s.includes(SB) && s.includes(SFH), JSON.stringify(s));
});

test('un `.sh` junto a un archivo de config NO tapa al revisor de esa config (FIX-4 sigue valiendo)', () => {
  // Lo cazó el revisor de fallos silenciosos sobre este mismo arreglo: la rama «sólo guiones»
  // devolvía [seguridad] y pisaba la de config — plugin.json perdía al revisor .NET, en silencio.
  const d = conGuion('scripts/ci/humo.sh');
  assert.deepEqual(set(d, 'plugin.json.example', 'scripts/ci/humo.sh'), [DOTNET, SB, SFH].sort());
  const p = path.join(d, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.dependencies.react = '18.3.0';
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  assert.deepEqual(set(d, 'package.json', 'scripts/ci/humo.sh'), [REACT, SB, SFH].sort());
});

test('el re-loop NO saltea a los dos revisores si el arreglo vive en un `.sh`', () => {
  for (const a of [SB, SFH]) {
    const r = advisorAffectedByDelta(a, ['/repo/scripts/ci/humo.sh']);
    assert.equal(r.affected, true, `${a}: ${r.reason}`);
  }
});

test('pero el re-loop sí saltea al de fallos silenciosos si lo único tocado es un `.test.sh`', () => {
  assert.equal(advisorAffectedByDelta(SFH, ['/repo/scripts/tests/lab-tool.test.sh']).affected, false);
});

// ── El caso que vigila a esta misma suite (2026-09-06) ────────────────────────────────────────
// 🔴 rojo previo: quitarle el `env` aislado a `set()`. Verificado: la suite escribe 12 eventos
//    `step5-start` en el ledger de la sesión que la corre.
//
// QUÉ PASÓ. `pipeline.js advisors` deja una marca `step5-start` en
// `~/.claude/.tycon-pipeline/advisor-runs/<sesión>.jsonl` — el ground-truth con el que el arnés
// decide si los revisores corrieron. Esta suite lo invoca 12 veces; sin `env` aislado esas 12
// marcas caían en el ledger de la sesión REAL que estuviera corriendo la suite. Medido en la
// corrida de la story 2.3: su ledger terminó con **51 `step5-start` sobre 69 líneas** — 48 falsos
// (cuatro ráfagas de 12) y 3 reales. Y como el roster de revisores se arma «desde el último
// `step5-start`», el cursor quedaba parado al final del archivo: la constancia de autoría de esa
// story se armó sobre un ledger envenenado por su propia suite de pruebas.
//
// El nocturno NO es el vector (allá no hay `CLAUDE_CODE_SESSION_ID` y todo cae en `_nosession`):
// el vector es la máquina del dev, que es justo donde el ledger significa algo.
test('la suite no escribe en el registro vivo del arnés', () => {
  const despues = tamanoLedgerVivo();
  assert.equal(despues, LEDGER_ANTES,
    `esta suite tocó ${LEDGER_VIVO} (antes ${LEDGER_ANTES} bytes, después ${despues}). ` +
    'Algún spawn de pipeline.js está corriendo sin HOME ni id de sesión aislados y le está ' +
    'escribiendo eventos falsos al ledger de la sesión que corre los tests.');
});
