'use strict';
/**
 * ps1-readable.test.js — los guiones de PowerShell del arnés se dejan LEER por el PowerShell que trae Windows
 * (5.1), y el instalador, si no hay PowerShell 7, lo DICE en vez de dejar la máquina sin controles callada
 * (PowerShell 7 es un requisito y se controla).
 *
 * La falla que caza: Windows PowerShell 5.1 lee un `.ps1` UTF-8
 * sin marca de codificación como Windows-1252. Ahí los bytes de una raya (—), una flecha (→) o una Ó quedan como
 * comillas tipográficas, que el analizador de PowerShell toma por comillas de verdad: el texto se cierra antes de
 * tiempo y el archivo entero no se puede leer (13 errores de sintaxis en `install-tycon-hooks.ps1`). Como una línea
 * de arranque que envuelve todo en `try { … } catch {}` lo calla, la máquina queda con 0 controles y sin una línea de aviso.
 *
 * Lo que no se puede perder:
 *   T1 · todo `.ps1` versionado y escrito a mano empieza con la marca de codificación (BOM). Los reemplazos generados
 *        (`tycon-legacy-shim`) no la llevan: los escribe `legacy-names.js` y se miden en T2.
 *   T2 · TODO `.ps1` versionado, leído como lo lee 5.1, no tiene errores de sintaxis (con el `pwsh` de esta máquina: el
 *        analizador es el mismo; lo que cambia es la decodificación, que acá se reproduce). Con su control del rojo:
 *        el mismo texto sin la marca sí da errores.
 *   T3 · el instalador con un PowerShell más viejo que 7: UNA línea por la salida estándar, salida 1, sin tildes, y no
 *        escribe nada en la carpeta de usuario. Con pwsh 7 la guarda sólo dispara por la variable de prueba, y entonces
 *        la línea DICE que la versión es simulada; el mensaje de verdad (qué falta, el comando para instalarlo y cómo
 *        volver a correrlo) se comprueba en el código, y su corrida real es la del pipeline de Windows.
 *   T4 · lo mismo el guion de los bloques del CLAUDE.md lanzado suelto.
 *   T5 · la variable de prueba no sirve para saltear la guarda: sólo simula una versión MÁS VIEJA que la real.
 *   T6 · `harness.js`: el requisito que falta trae su comando de instalación, y `doctor` lista los requisitos también
 *        sin instalar.
 *
 * Sin `pwsh` en el PATH: T2 a T5 dicen «NO MEDIDO» (salteadas, no verdes). T1 y T6 corren igual.
 * Lo que NO mide: un Windows PowerShell 5.1 de verdad. Eso lo mide el pipeline de Windows (`pipelines/azure-pipelines-windows.yml`:
 * su tabla «¿Cada PowerShell puede leer los .ps1 del arnés de hoy?» y las máquinas `ps51`). Con un Windows PowerShell 5.1 real, los tres
 * guiones del arranque dan 0 errores de sintaxis, y la máquina con sólo 5.1 recibe la línea «tycon: FALTA PowerShell 7 (pwsh)…» y `doctor` marca el requisito en rojo.
 * 🔴 Nunca la HOME real: cada caso arma la suya en el temporal, y los `XDG_*` de pwsh van fuera de ella.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const INSTALLER = path.join(RAIZ, 'scripts', 'install-tycon-hooks.ps1');
const SYNC = path.join(RAIZ, 'scripts', 'setup', 'sync-claude-md-blocks.ps1');
const HARNESS = path.join(RAIZ, 'scripts', 'setup', 'harness.js');
const PARSER = path.join(__dirname, 'lib', 'parse-ps1-legacy.ps1');
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-ps-readable-'));
require('./lib/lab-guard.js').labGuard(BASE, 'ps1-readable');
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));

const which = (name) => {
  for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const p = path.join(d, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* siguiente */ }
    }
  }
  return null;
};
const PWSH = which('pwsh');
const sinPwsh = PWSH ? false : 'NO MEDIDO: no hay pwsh en el PATH (lo mide el pipeline de Windows)';

const ps1Files = () => execFileSync('git', ['ls-files', '-z', '*.ps1'], { cwd: RAIZ }).toString().split('\0').filter(Boolean);
const isGeneratedShim = (buf) => buf.toString('utf8').split('\n').slice(0, 4).some((l) => /tycon-legacy-shim:/.test(l));

/** Una carpeta de usuario de laboratorio y un ambiente que no hereda nada de quien corre la prueba. */
function lab(name, extra = {}) {
  const home = path.join(BASE, name, 'home');
  const xdg = path.join(BASE, name, 'xdg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const env = Object.assign({
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CACHE_HOME: path.join(xdg, 'cache'), XDG_DATA_HOME: path.join(xdg, 'data'), XDG_CONFIG_HOME: path.join(xdg, 'config'),
    TYCON_NO_NIGHTLY_EXAM: '1', POWERSHELL_TELEMETRY_OPTOUT: '1', NO_COLOR: '1',
  }, extra);
  return { home, env };
}
const filesIn = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir);
  return out;
};
/** Los errores de sintaxis de cada archivo, leído como lo lee Windows PowerShell 5.1: `{ archivo: cantidad }`. */
function parseAsWindowsPowerShell(files, cwd) {
  const r = spawnSync(PWSH, ['-NoProfile', '-File', PARSER, ...files], { cwd, encoding: 'utf8', env: lab('parser').env, timeout: 120000 });
  assert.strictEqual(r.status, 0, `el analizador no corrió: ${r.stderr || r.stdout}`);
  const out = {};
  for (const line of r.stdout.split(/\r?\n/).filter(Boolean)) {
    const m = /^(\d+)\t(\d)\t(.*?)\t(.*?)\t(\d+)\t(.*)$/.exec(line);
    assert.ok(m, `línea que no entiendo del analizador: ${line}`);
    out[m[3]] = { errors: Number(m[1]), bom: m[2] === '1', first: m[4], newOnly: Number(m[5]), newFirst: m[6] };
  }
  return out;
}

test('T1 Ps1_HandWritten_StartsWithBom', () => {
  const files = ps1Files();
  assert.ok(files.length >= 9, `esperaba los .ps1 del arnés; hay ${files.length}`);
  const without = [];
  let shims = 0;
  for (const f of files) {
    const b = fs.readFileSync(path.join(RAIZ, f));
    if (b.subarray(0, 3).equals(BOM)) continue;
    if (isGeneratedShim(b)) { shims += 1; continue; }
    without.push(f);
  }
  assert.deepStrictEqual(without, [], `sin la marca de codificación (BOM), Windows PowerShell 5.1 los lee como Windows-1252 y una raya o una flecha dentro de un texto le cierra las comillas. Guardalos como UTF-8 con BOM: ${without.join(', ')}`);
  assert.ok(shims < files.length, 'no todo puede ser un reemplazo generado');
});

test('T2 Ps1_AsWindowsPowerShellReadsIt_ParsesClean', { skip: sinPwsh }, () => {
  const files = ps1Files();
  const res = parseAsWindowsPowerShell(files, RAIZ);
  assert.strictEqual(Object.keys(res).length, files.length, 'el analizador miró todos los archivos');
  const bad = Object.entries(res).filter(([, v]) => v.errors > 0).map(([f, v]) => `${f}: ${v.errors} error(es) — ${v.first}`);
  assert.deepStrictEqual(bad, [], `Windows PowerShell 5.1 no puede leer:\n  ${bad.join('\n  ')}`);
  // …y ninguno usa un operador que sólo entiende PowerShell 7 (`??`, `?.`, el ternario, `&&`, `||`): el analizador de
  // esta máquina es el de 7 y no los da por error, pero con uno solo 5.1 no puede leer el archivo y la guarda no corre
  const modern = Object.entries(res).filter(([, v]) => v.newOnly > 0).map(([f, v]) => `${f}: ${v.newOnly} — ${v.newFirst}`);
  assert.deepStrictEqual(modern, [], `sintaxis que sólo entiende PowerShell 7 (con eso, 5.1 no puede leer el archivo y no avisa nada):\n  ${modern.join('\n  ')}`);

  // el control del rojo: el instalador SIN la marca vuelve a no poder leerse, y un texto con una raya también
  const dir = path.join(BASE, 't2-red');
  fs.mkdirSync(dir, { recursive: true });
  const installer = fs.readFileSync(INSTALLER);
  assert.ok(installer.subarray(0, 3).equals(BOM));
  fs.writeFileSync(path.join(dir, 'no-bom.ps1'), installer.subarray(3));
  fs.writeFileSync(path.join(dir, 'dash.ps1'), Buffer.from('$a = "uno — dos"\nWrite-Output "tres → cuatro"\n', 'utf8'));
  fs.writeFileSync(path.join(dir, 'dash-bom.ps1'), Buffer.concat([BOM, Buffer.from('$a = "uno — dos"\nWrite-Output "tres → cuatro"\n', 'utf8')]));
  fs.writeFileSync(path.join(dir, 'modern.ps1'), Buffer.concat([BOM, Buffer.from('$a = $b ?? 1\n$c = $a ? 1 : 2\nnode x && node y\n$d = ${a}?.Length\n', 'utf8')]));
  const red = parseAsWindowsPowerShell(['no-bom.ps1', 'dash.ps1', 'dash-bom.ps1', 'modern.ps1'], dir);
  assert.ok(red['modern.ps1'].newOnly >= 4, `los operadores de PowerShell 7 se tienen que contar: ${JSON.stringify(red['modern.ps1'])}`);
  assert.ok(red['no-bom.ps1'].errors > 0, 'el instalador sin la marca tiene que dar errores: si da 0, esta prueba no mide nada');
  assert.ok(red['dash.ps1'].errors > 0, 'una raya dentro de un texto, sin la marca, tiene que dar errores');
  assert.strictEqual(red['dash-bom.ps1'].errors, 0, 'el mismo texto con la marca se lee bien');
});

test('T3 Installer_OlderPowerShell_SaysItAndWritesNothing', { skip: sinPwsh }, () => {
  const { home, env } = lab('t3', { TYCON_PS_MAJOR_FOR_TEST: '5' });
  const r = spawnSync(PWSH, ['-NoProfile', '-File', INSTALLER], { encoding: 'utf8', env, timeout: 120000 });
  assert.strictEqual(r.status, 1, `salida ${r.status}: ${r.stdout}${r.stderr}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim());
  assert.strictEqual(lines.length, 1, `UNA línea por la salida estándar, hubo ${lines.length}: ${r.stdout}`);
  // con pwsh 7 la guarda sólo dispara por la variable de prueba: lo DICE (una máquina sana con la variable olvidada no
  // puede recibir «te falta PowerShell 7»), y no instala
  assert.match(lines[0], /^tycon: la variable TYCON_PS_MAJOR_FOR_TEST=5 esta puesta y simula un PowerShell viejo/);
  assert.match(lines[0], /NO instalo nada/);
  assert.match(lines[0], /sacala del entorno/);
  // el mensaje de verdad (el que ve un 5.1; medido en el pipeline de Windows) está en el código, con sus tres pasos
  const src = fs.readFileSync(INSTALLER, 'utf8');
  const real = /Write-Output \("tycon: FALTA PowerShell 7 \(pwsh\): los controles del equipo NO quedaron instalados\. " \+\s+"Este instalador no corre con Windows PowerShell \$TyconPsMajor\. " \+\s+"Pasos: 1\) winget install Microsoft\.PowerShell  2\) cerrar y volver a abrir la terminal y VS Code  " \+\s+"3\) pwsh -NoProfile -ExecutionPolicy Bypass -File `"\$TyconSelf`""\)/;
  assert.match(src, real, 'el mensaje para un PowerShell viejo de verdad: qué falta, el comando para instalarlo y cómo volver a correrlo');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch((real.exec(src) || [''])[0], /[^\x00-\x7F]/, 'sin tildes ni símbolos');
  // eslint-disable-next-line no-control-regex
  assert.match(lines[0], /^[\x20-\x7E]+$/, 'sin tildes ni símbolos: 5.1 escribe la consola en la página de códigos de la máquina');
  assert.strictEqual(r.stderr.trim(), '', 'nada por la salida de error: la línea de arranque vieja se la traga');
  assert.deepStrictEqual(filesIn(home), [], 'no escribió nada en la carpeta de usuario');
});

test('T4 SyncBlocks_OlderPowerShell_SaysItAndWritesNothing', { skip: sinPwsh }, () => {
  const { home, env } = lab('t4', { TYCON_PS_MAJOR_FOR_TEST: '5' });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const md = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(md, '# mío\n');
  const r = spawnSync(PWSH, ['-NoProfile', '-File', SYNC], { encoding: 'utf8', env, timeout: 120000 });
  assert.strictEqual(r.status, 1, `salida ${r.status}: ${r.stdout}${r.stderr}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim());
  assert.strictEqual(lines.length, 1, r.stdout);
  assert.match(lines[0], /^tycon: la variable TYCON_PS_MAJOR_FOR_TEST=5 esta puesta y simula un PowerShell viejo/);
  assert.match(lines[0], /NO se sincronizaron/);
  assert.match(fs.readFileSync(SYNC, 'utf8'), /tycon: FALTA PowerShell 7 \(pwsh\): las reglas del equipo NO se sincronizaron[^\n]*\n[^\n]*winget install Microsoft\.PowerShell/);
  // eslint-disable-next-line no-control-regex
  assert.match(lines[0], /^[\x20-\x7E]+$/);
  assert.strictEqual(fs.readFileSync(md, 'utf8'), '# mío\n', 'el CLAUDE.md quedó como estaba');
  assert.deepStrictEqual(filesIn(home), [path.join('.claude', 'CLAUDE.md')]);
});

test('T5 Guard_TestVariableCannotSkipIt', { skip: sinPwsh }, () => {
  // una versión MAYOR que la real no se acepta: con pwsh 7 la guarda no dispara, y con 5.1 seguiría disparando
  const { env } = lab('t5', { TYCON_PS_MAJOR_FOR_TEST: '99' });
  const r = spawnSync(PWSH, ['-NoProfile', '-File', INSTALLER, '-Check'], { encoding: 'utf8', env, timeout: 120000 });
  assert.doesNotMatch(r.stdout + r.stderr, /FALTA PowerShell 7/);
  for (const f of [INSTALLER, SYNC]) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /\[int\]\$env:TYCON_PS_MAJOR_FOR_TEST -lt \$TyconPsMajor/, `${path.basename(f)}: la variable sólo puede BAJAR la versión`);
    assert.strictEqual((src.match(/TYCON_PS_MAJOR_FOR_TEST/g) || []).length >= 2, true);
  }
  // la guarda va antes del primer requisito que se controla, o sea, antes de cualquier escritura
  const src = fs.readFileSync(INSTALLER, 'utf8');
  assert.ok(src.indexOf('if ($TyconPsMajor -lt 7)') > 0);
  assert.ok(src.indexOf('if ($TyconPsMajor -lt 7)') < src.indexOf("Get-Command node -ErrorAction SilentlyContinue"), 'la guarda de PowerShell va antes que la de node');
});

test('T6 Harness_MissingRequirement_BringsItsInstallCommand', () => {
  const { requirementChecks, requirementsFor } = require(HARNESS);
  assert.deepStrictEqual(requirementsFor('win32'), ['git', 'pwsh']);
  // un PATH de juguete: git está y responde; pwsh no está
  const bin = path.join(BASE, 't6', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const fake = (name, body) => { const p = path.join(bin, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`); fs.chmodSync(p, 0o755); };
  if (process.platform === 'win32') return;   // los ejecutables de juguete son guiones de sh: en Windows lo mide el pipeline
  fake('git', 'echo "git version 2.99.0"');
  const ctx = { platform: 'win32', env: { PATH: bin } };
  let res = requirementChecks(ctx);
  assert.deepStrictEqual(res.map((r) => [r.name, Boolean(r.problem)]), [['git', false], ['pwsh', true]]);
  assert.match(res[1].problem, /^falta pwsh en el PATH — requisitos: Git, PowerShell 7 \(pwsh\) y Node \d+\+/);
  assert.match(res[1].problem, / — instalar: winget install Microsoft\.PowerShell$/);
  assert.strictEqual(res[0].version, 'git version 2.99.0');
  // uno que está y no arranca cuenta como faltante, y también trae el comando
  fake('pwsh', 'exit 1');
  res = requirementChecks(ctx);
  assert.match(res[1].problem, /^pwsh está en el PATH .* pero no responde a --version/);
  assert.match(res[1].problem, /winget install Microsoft\.PowerShell$/);
  // PowerShell 6 también se llama pwsh: no alcanza
  fake('pwsh', 'echo "PowerShell 6.2.7"');
  res = requirementChecks(ctx);
  assert.match(res[1].problem, /pero es PowerShell 6\.2\.7: hace falta PowerShell 7 o más nuevo/);
  assert.match(res[1].problem, /winget install Microsoft\.PowerShell$/);
  // con los dos: sin problemas
  fake('pwsh', 'echo "PowerShell 7.9.9"');
  assert.deepStrictEqual(requirementChecks(ctx).map((r) => r.problem), [null, null]);
  // en los otros sistemas no se inventa un comando
  fs.rmSync(path.join(bin, 'git'));
  const posix = requirementChecks({ platform: 'linux', env: { PATH: bin } });
  assert.match(posix[0].problem, /^falta git en el PATH/);
  assert.doesNotMatch(posix[0].problem, /instalar:/);

  // doctor, sin instalar: lista los requisitos igual (es cuando más falta saberlo) y sigue saliendo 3
  const { home, env } = lab('t6-doctor');
  const r = spawnSync(process.execPath, [HARNESS, 'doctor'], { encoding: 'utf8', env, timeout: 60000 });
  assert.strictEqual(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /requisito git: /);
  assert.match(r.stdout, /no instalado/);
  assert.deepStrictEqual(filesIn(home), [], 'doctor no escribe');

  // un requisito que falta: rojo para una persona; AVISO dentro de la comprobación de salud de una actualización
  // (ahí doctor juzga el árbol nuevo, y un PATH de sesión corto no puede hacer volver atrás una actualización sana)
  const empty = path.join(BASE, 't6', 'empty-bin');
  fs.mkdirSync(empty, { recursive: true });
  const person = JSON.parse(spawnSync(process.execPath, [HARNESS, 'doctor', '--json'], { encoding: 'utf8', env: Object.assign({}, env, { PATH: empty }), timeout: 60000 }).stdout);
  assert.ok(person.fail.some((x) => /^falta git en el PATH/.test(x)), JSON.stringify(person));
  const health = JSON.parse(spawnSync(process.execPath, [HARNESS, 'doctor', '--json'], { encoding: 'utf8', env: Object.assign({}, env, { PATH: empty, TYCON_HARNESS_HEALTH: '1' }), timeout: 60000 }).stdout);
  assert.ok(health.warn.some((x) => /^falta git en el PATH/.test(x)), JSON.stringify(health));
  assert.ok(!health.fail.some((x) => /en el PATH/.test(x)), JSON.stringify(health));
});

// ── la guarda, leída en cada .ps1 ────────────────────────────────────────────────────
// Los TRES .ps1 que buscan la carpeta de usuario (el instalador, el de los bloques y el respaldo del arranque) llevan la
// guarda de PowerShell 7 arriba, antes de escribir nada, en ASCII y con sintaxis que 5.1 entiende (T2 mide la sintaxis).
// 🔴 sin guarda, bootstrap-fallback.ps1 con 5.1 crearía ~/.claude/.tycon-pipeline/harness y seguiría.
const FALLBACK = path.join(RAIZ, 'scripts', 'setup', 'harness', 'bootstrap-fallback.ps1');
// Los cuatro .ps1 de scripts/setup/ que el instalador llama o que se corren a mano también llevan la guarda. 🔴 Sin
// ella, con 5.1 seguirían (y el de sqlite3 escribiría su sello en la carpeta de usuario).
const SETUP_GUARDED = ['check-engram-version.ps1', 'ensure-sqlite3.ps1', 'install-codegraph.ps1', 'install-clockify-mcp.ps1']
  .map((f) => path.join(RAIZ, 'scripts', 'setup', f));
const GUARDED = [INSTALLER, SYNC, FALLBACK, ...SETUP_GUARDED];
/** El código de la guarda: desde `$TyconPsMajor = $PSVersionTable…` hasta el cierre de `if ($TyconPsMajor -lt 7) { … }`. */
function guardOf(src) {
  const a = src.indexOf('$TyconPsMajor = $PSVersionTable.PSVersion.Major');
  const b = src.indexOf('if ($TyconPsMajor -lt 7) {', a);
  if (a < 0 || b < 0) return null;
  const end = src.indexOf('\n}\n', b);
  return end < 0 ? null : { start: a, end: end + 3, text: src.slice(a, end + 3) };
}
// lo primero que puede escribir o lanzar algo: una escritura de PowerShell, de .NET, o un programa de afuera
const FIRST_WRITE = /^(?!\s*#).*(New-Item|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|Remove-Item|WriteAllText|AppendAllText|GetTempFileName|Start-Process|&\s*(git|node|pwsh|bash)\b)/m;

test('T7 Guard_InEveryHomeLookingPs1_AtTop_Ascii_BeforeAnyWrite', () => {
  assert.strictEqual(GUARDED.length, 7, 'los siete .ps1 con la guarda');
  for (const f of GUARDED) {
    // la marca de codificación (la exige T1 para todo .ps1 escrito a mano): sin ella 5.1 ni llega a leer la guarda
    assert.ok(fs.readFileSync(f).subarray(0, 3).equals(BOM), `${path.basename(f)}: sin la marca de codificación (BOM)`);
    const src = fs.readFileSync(f, 'utf8');
    const g = guardOf(src);
    assert.ok(g, `${path.basename(f)}: no encontré la guarda de PowerShell 7`);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(g.text, /[^\x00-\x7F]/, `${path.basename(f)}: la guarda tiene que ser ASCII (5.1 escribe la consola en la página de códigos de la máquina)`);
    assert.match(g.text, /\[int\]\$env:TYCON_PS_MAJOR_FOR_TEST -lt \$TyconPsMajor/, `${path.basename(f)}: la variable de prueba sólo puede BAJAR la versión`);
    assert.match(g.text, /winget install Microsoft\.PowerShell/, `${path.basename(f)}: la línea dice cómo instalarlo`);
    assert.match(g.text, /exit 1/, `${path.basename(f)}: sale distinto de 0`);
    const m = FIRST_WRITE.exec(src);
    assert.ok(!m || m.index > g.start, `${path.basename(f)}: algo escribe o lanza un programa antes de la guarda: «${m && m[0].trim()}»`);
  }
});

test('T8 BootstrapFallback_OlderPowerShell_SaysItAndWritesNothing', { skip: sinPwsh }, () => {
  const { home, env } = lab('t8', { TYCON_PS_MAJOR_FOR_TEST: '5' });
  const r = spawnSync(PWSH, ['-NoProfile', '-File', FALLBACK], { encoding: 'utf8', env, timeout: 120000 });
  assert.strictEqual(r.status, 1, `salida ${r.status}: ${r.stdout}${r.stderr}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim());
  assert.strictEqual(lines.length, 1, `UNA línea, hubo ${lines.length}: ${r.stdout}`);
  assert.match(lines[0], /^tycon: la variable TYCON_PS_MAJOR_FOR_TEST=5 esta puesta y simula un PowerShell viejo/);
  assert.match(lines[0], /NO corrio/);
  assert.match(fs.readFileSync(FALLBACK, 'utf8'), /tycon: FALTA PowerShell 7 \(pwsh\): el respaldo del arranque NO corrio[^\n]*\n[^\n]*winget install Microsoft\.PowerShell/);
  // eslint-disable-next-line no-control-regex
  assert.match(lines[0], /^[\x20-\x7E]+$/);
  assert.strictEqual(r.stderr.trim(), '');
  assert.deepStrictEqual(filesIn(home), [], 'no escribió nada en la carpeta de usuario');
});

test('T9 SetupPs1_OlderPowerShell_SaysItAndWritesNothing', { skip: sinPwsh }, () => {
  for (const f of SETUP_GUARDED) {
    const name = path.basename(f);
    const { home, env } = lab(`t9-${name}`, { TYCON_PS_MAJOR_FOR_TEST: '5' });
    const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', f], { cwd: home, encoding: 'utf8', env, timeout: 120000, input: '' });
    assert.strictEqual(r.status, 1, `${name}: salida ${r.status}: ${r.stdout}${r.stderr}`);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim());
    assert.strictEqual(lines.length, 1, `${name}: UNA línea, hubo ${lines.length}: ${r.stdout}`);
    assert.match(lines[0], /^tycon: la variable TYCON_PS_MAJOR_FOR_TEST=5 esta puesta y simula un PowerShell viejo/, name);
    assert.match(lines[0], /sacala del entorno/, name);
    // eslint-disable-next-line no-control-regex
    assert.match(lines[0], /^[\x20-\x7E]+$/, `${name}: sin tildes ni símbolos`);
    assert.strictEqual(r.stderr.trim(), '', `${name}: nada por la salida de error`);
    assert.deepStrictEqual(filesIn(home), [], `${name}: no escribió nada en la carpeta de usuario`);
    // el mensaje de verdad (el que ve un 5.1): qué no se hizo y el comando para instalarlo
    assert.match(fs.readFileSync(f, 'utf8'), /tycon: FALTA PowerShell 7 \(pwsh\): [^\n]*\n[^\n]*winget install Microsoft\.PowerShell/, name);
  }
});
