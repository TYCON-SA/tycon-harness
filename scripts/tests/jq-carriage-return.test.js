#!/usr/bin/env node
'use strict';
/**
 * jq-carriage-return.test.js — los frenos de shell con el jq de Windows, y un comando que trae un `\r`.
 *
 * QUÉ CUIDA: el `jq` nativo de Windows escribe cada salto de línea como `\r\n` salvo con `-b`. Los tres frenos de shell
 * que leen la entrada (`safety-guard-pre.sh`, `test-scope-guard-pre.sh`, `engram-pre-commit.sh`) leían el comando,
 * `tool_name` y lo que devuelve el cruce de memoria con esos `\r`: un comando de varios renglones pasaba sin frenar,
 * «PowerShell\r» apagaba las reglas de PowerShell y «sano\r» no era «sano». Ahora leen con `jq -b`; un `jq` que no lo
 * conoce falla y lee `node`. Y un `\r` que de verdad viene en el comando (o, en PowerShell, otro separador que no es un
 * espacio) lo frena siempre el freno de seguridad (CMD-C1).
 *
 * Cada caso corre por tres caminos: con un `jq` que imita al de Windows (escribe `\r\n` salvo con `-b`, y anota que
 * corrió y con qué), con un `jq` de Windows que no conoce `-b`, y con un `jq` que falla (el respaldo con `node`). Sin
 * `jq` real en la máquina, sólo se mide el respaldo, y la prueba lo dice.
 *
 * Correr: node --test scripts/tests/jq-carriage-return.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const HOOKS = path.join(RAIZ, 'scripts', 'hooks');

const LAB = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-crlf-'));
process.on('exit', () => fs.rmSync(LAB, { recursive: true, force: true }));
const REAL_JQ = (spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout || '').trim();
const MARCA = path.join(LAB, 'jq-de-windows-corrio');
const A_CRLF = `node -e 'process.stdin.on("data",(d)=>process.stdout.write(d.toString().replace(/\\n/g,"\\r\\n")))'`;

// el jq de Windows: con -b escribe \n; sin -b, cada salto de línea como \r\n. Anota sus argumentos.
const BIN_WIN = path.join(LAB, 'bin-win');
fs.mkdirSync(BIN_WIN);
fs.writeFileSync(path.join(BIN_WIN, 'jq'), `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(MARCA)}
for a in "$@"; do [ "$a" = "-b" ] && { b=1; break; }; done
if [ -n "\${b:-}" ]; then exec ${JSON.stringify(REAL_JQ)} "$@"; fi   # el -b sigue: en Windows el jq real sin -b escribe \\r\\n
${JSON.stringify(REAL_JQ)} "$@" | ${A_CRLF}
exit "\${PIPESTATUS[0]}"
`, { mode: 0o755 });
// un jq de Windows viejo, que no conoce -b: con -b falla; sin -b escribe \r\n
const BIN_VIEJO = path.join(LAB, 'bin-viejo');
fs.mkdirSync(BIN_VIEJO);
fs.writeFileSync(path.join(BIN_VIEJO, 'jq'), `#!/usr/bin/env bash
for a in "$@"; do [ "$a" = "-b" ] && { echo "jq: Unknown arguments: -b" >&2; exit 2; }; done
${JSON.stringify(REAL_JQ)} "$@" | ${A_CRLF}
exit "\${PIPESTATUS[0]}"
`, { mode: 0o755 });
// sin jq que sirva: el freno cae al respaldo con node
const BIN_SIN = path.join(LAB, 'bin-sin-jq');
fs.mkdirSync(BIN_SIN);
fs.writeFileSync(path.join(BIN_SIN, 'jq'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

const CAMINOS = REAL_JQ
  ? [['jq de Windows', BIN_WIN], ['jq de Windows sin -b', BIN_VIEJO], ['respaldo con node', BIN_SIN]]
  : [['respaldo con node', BIN_SIN]];
/** Sin jq real, los caminos de jq no se miden: la prueba lo dice en vez de callarlo. */
const avisarSinJq = (t) => { if (!REAL_JQ) t.diagnostic('no medido: no hay jq en esta máquina, sólo se probó el respaldo con node'); };

/** Corre un freno con un comando por un camino de lectura, con tope de tiempo: { status, stderr, home, jqArgs }. */
function correr(hook, { tool = 'Bash', command, bin, env = {}, cwd }) {
  const home = fs.mkdtempSync(path.join(LAB, 'home-'));
  const e = { ...process.env, HOME: home, USERPROFILE: home, ...env };
  // en Windows la variable se llama `Path`: una `PATH` aparte al lado deja a spawn sin encontrar bash
  const clavePath = Object.keys(e).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  e[clavePath] = `${bin}${path.delimiter}${e[clavePath] || ''}`;
  for (const k of Object.keys(e)) if (/^TYCON_/.test(k) && !(k in env)) delete e[k];
  if (fs.existsSync(MARCA)) fs.rmSync(MARCA);
  const r = spawnSync('bash', [path.join(HOOKS, hook)], {
    input: JSON.stringify({ session_id: 's-crlf', tool_use_id: 'u-crlf', tool_name: tool, tool_input: { command }, cwd: cwd || home }),
    env: e, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
  });
  assert.ok(!r.error, `${hook} no terminó en 60 s (${r.error && r.error.code}): ${JSON.stringify(command)}`);
  return { status: r.status, stderr: r.stderr || '', home, jqArgs: fs.existsSync(MARCA) ? fs.readFileSync(MARCA, 'utf8') : '' };
}

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — el jq de Windows se usa, y con -b', (t) => {
  if (!REAL_JQ) { t.diagnostic('no medido: no hay jq en esta máquina (el freno lee con node, que no agrega \\r)'); return; }
  for (const hook of ['safety-guard-pre.sh', 'test-scope-guard-pre.sh']) {
    const r = correr(hook, { command: 'ls', bin: BIN_WIN });
    assert.ok(r.jqArgs, `${hook}: el jq de Windows de la prueba no corrió (el camino de jq no se estaría midiendo)`);
    assert.ok(r.jqArgs.split('\n').filter(Boolean).every((l) => /(^| )-b( |$)/.test(l)), `${hook}: leyó con jq sin -b: ${r.jqArgs}`);
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — freno de seguridad: varios renglones, sin \\r', (t) => {
  avisarSinJq(t);
  for (const [camino, bin] of CAMINOS) {
    // un comando común de varios renglones no frena (el jq de Windows no le agrega ningún \r)
    let r = correr('safety-guard-pre.sh', { command: 'ls -la\npwd', bin });
    assert.strictEqual(r.status, 0, `${camino}: un comando de dos renglones no tenía que frenar · ${r.stderr.slice(0, 200)}`);
    // y lo que va en el segundo renglón se ve
    r = correr('safety-guard-pre.sh', { command: 'echo listo\nrm -rf ~', bin });
    assert.strictEqual(r.status, 2, `${camino}: el rm del segundo renglón tenía que frenar · ${r.stderr.slice(0, 200)}`);
    // tool_name leído por ese camino sigue siendo PowerShell: una regla que sólo es de PowerShell sigue prendida
    // stable-data: es el texto del comando que se le pasa al freno, no se ejecuta
    r = correr('safety-guard-pre.sh', { tool: 'PowerShell', command: "$Env:TYCON_NEW_NAMES = '0'; git commit -m x", bin });
    assert.strictEqual(r.status, 2, `${camino}: con tool_name leído así, las reglas de PowerShell se apagaron · ${r.stderr.slice(0, 200)}`);
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — CMD-C1: un \\r en el comando frena siempre', (t) => {
  avisarSinJq(t);
  const casos = [
    'r\rm -rf ~',                     // en medio de una palabra
    'ls\r',                           // al final
    'echo a \r# ; npm test',          // pegado a un #: bash corre lo que sigue
    "cat <<EOF\r\nhola\nEOF\ncd /tmp", // en la palabra de un heredoc
    'git push --force\rorigin main',
    'echo listo\r\nls',               // un \r\n escrito en el comando
  ];
  // en PowerShell el \r es un salto de línea: tampoco se borra ni se lee como espacio
  const casosPs = ['Get-ChildItem\rRemove-Item -Recurse -Force ~', 'Get-ChildItem\r', 'Write-Output a\r\nGet-Date'];
  for (const [camino, bin] of CAMINOS) {
    for (const [tool, command] of [...casos.map((c) => ['Bash', c]), ...casosPs.map((c) => ['PowerShell', c])]) {
      const r = correr('safety-guard-pre.sh', { tool, command, bin });
      assert.strictEqual(r.status, 2, `${camino} · ${tool}: ${JSON.stringify(command)} tenía que frenar · ${r.stderr.slice(0, 200)}`);
      assert.match(r.stderr, /CMD-C1/, `${camino} · ${tool}: ${JSON.stringify(command)} frenó por otra regla`);
    }
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — CMD-C1: en PowerShell, los separadores que no son un espacio', (t) => {
  avisarSinJq(t);
  // los que PowerShell toma como espacio y las reglas no: \f, \v, NEL, los de línea y párrafo, y la categoría de
  // espacios de Unicode entera (del duro al ogham)
  const raros = ['\f', '\v', '\u0085', '\u2028', '\u2029', '\u00a0', '\u1680', '\u202f', '\u205f', '\u3000'];
  for (let c = 0x2000; c <= 0x200a; c++) raros.push(String.fromCharCode(c));
  const nombre = (c) => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  for (const [camino, bin] of CAMINOS) {
    for (const c of raros) {
      const command = `Remove-Item -Recurse -Force${c}~`;
      const r = correr('safety-guard-pre.sh', { tool: 'PowerShell', command, bin });
      assert.strictEqual(r.status, 2, `${camino}: PowerShell con ${nombre(c)} tenía que frenar · ${r.stderr.slice(0, 200)}`);
      assert.match(r.stderr, /CMD-C1/);
      // en Bash no son separadores: un texto que los trae pasa
      const b = correr('safety-guard-pre.sh', { command: `printf "a${c}b"`, bin });
      assert.strictEqual(b.status, 0, `${camino}: ${nombre(c)} en Bash no tenía que frenar · ${b.stderr.slice(0, 200)}`);
    }
    // en PowerShell un comando común pasa
    assert.strictEqual(correr('safety-guard-pre.sh', { tool: 'PowerShell', command: 'Get-ChildItem C:\\x', bin }).status, 0, `${camino}: PowerShell común`);
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — CMD-C1: la misma copia en los tres frenos', () => {
  const bloque = (f) => {
    const s = fs.readFileSync(path.join(HOOKS, f), 'utf8');
    const i = s.indexOf('# --- CMD-C1 (copia');
    const j = s.indexOf('# --- fin CMD-C1');
    assert.ok(i >= 0 && j > i, `${f}: no trae el bloque CMD-C1`);
    return s.slice(i, j);
  };
  const base = bloque('safety-guard-pre.sh');
  for (const f of ['test-scope-guard-pre.sh', 'engram-pre-commit.sh']) {
    assert.strictEqual(bloque(f), base, `${f}: su copia de CMD-C1 no es igual a la del freno de seguridad`);
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — CMD-C1: con el freno de seguridad apagado, los otros dos frenan', (t) => {
  avisarSinJq(t);
  const casos = [['Bash', 'echo a \r# ; npm test'], ['Bash', 'git com\rmit -m x'], ['PowerShell', 'Get-ChildItem\rRemove-Item -Recurse -Force ~'],
    ['PowerShell', 'Remove-Item -Recurse -Force ~']];
  for (const [camino, bin] of CAMINOS) for (const [tool, command] of casos) {
    const apagado = correr('safety-guard-pre.sh', { tool, command, bin, env: { TYCON_SAFETY_OFF: '1' } });
    assert.strictEqual(apagado.status, 0, `${camino}: el freno de seguridad apagado tenía que dejar pasar (si no, la prueba no mide nada)`);
    for (const hook of ['test-scope-guard-pre.sh', 'engram-pre-commit.sh']) {
      const r = correr(hook, { tool, command, bin, env: { TYCON_SAFETY_OFF: '1' } });
      assert.strictEqual(r.status, 2, `${hook} · ${camino} · ${tool}: ${JSON.stringify(command)} tenía que frenar · ${r.stderr.slice(0, 200)}`);
      assert.match(r.stderr, /CMD-C1/, `${hook} · ${camino}: frenó sin decir CMD-C1`);
    }
  }
  // y un comando común sigue pasando por los dos
  for (const hook of ['test-scope-guard-pre.sh', 'engram-pre-commit.sh']) {
    assert.strictEqual(correr(hook, { command: 'ls -la\npwd', bin: CAMINOS[0][1] }).status, 0, `${hook}: un comando común de dos renglones`);
    assert.strictEqual(correr(hook, { command: 'printf "a\fb"', bin: CAMINOS[0][1] }).status, 0, `${hook}: un \\f en Bash`);
  }
});

// Limitación: en Windows no se mide. El bash de mentira es un guion sin .exe y Windows no lo lanza, y BASH_ENV se lee
// antes de que bash sepa qué guion corre (`$0` dice «bash»), así que tampoco sirve para contar.
test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — el freno no se relanza a sí mismo', { skip: process.platform === 'win32' && 'el bash de mentira que cuenta es un guion sin .exe y Windows no lo lanza; el freno es el mismo guion, se mide en la Mac' }, () => {
  // un bash de mentira delante en el PATH anota cada vez que alguien corre el freno con bash: tiene que ser una sola
  const realBash = (spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout || '').trim();
  const binCuenta = fs.mkdtempSync(path.join(LAB, 'bin-cuenta-'));
  const cuenta = path.join(binCuenta, 'cuenta.log');
  fs.writeFileSync(path.join(binCuenta, 'bash'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(cuenta)}\nexec ${JSON.stringify(realBash)} "$@"\n`, { mode: 0o755 });
  for (const hook of ['safety-guard-pre.sh', 'test-scope-guard-pre.sh']) for (const [camino, bin] of CAMINOS) {
    for (const command of ['echo listo\rrm -rf ~', 'ls -la\npwd', 'npm te\rst']) {
      if (fs.existsSync(cuenta)) fs.rmSync(cuenta);
      correr(hook, { command, bin: `${binCuenta}${path.delimiter}${bin}` });
      const veces = (fs.existsSync(cuenta) ? fs.readFileSync(cuenta, 'utf8') : '').split('\n').filter((l) => l.includes(hook)).length;
      assert.strictEqual(veces, 1, `${hook} · ${camino} · ${JSON.stringify(command)}: el freno se corrió ${veces} veces con bash`);
    }
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — en bash un \\r no separa comandos ni abre un comentario', () => {
  // por eso un \r no se puede «normalizar»: bash lo lee como una letra más
  const d = fs.mkdtempSync(path.join(LAB, 'bash-'));
  spawnSync('bash', ['-c', 'echo listo\rtouch MARCA-SEGUNDO'], { cwd: d, encoding: 'utf8' });
  assert.ok(!fs.existsSync(path.join(d, 'MARCA-SEGUNDO')), 'bash corrió lo que venía después del \\r como un comando aparte');
  spawnSync('bash', ['-c', 'echo a \r# ; touch MARCA-COMENTARIO'], { cwd: d, encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(d, 'MARCA-COMENTARIO')), 'bash tomó «\\r#» como comentario');
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — freno de alcance de pruebas', (t) => {
  avisarSinJq(t);
  for (const [camino, bin] of CAMINOS) {
    let r = correr('test-scope-guard-pre.sh', { command: 'echo listo\nnpm test', bin });
    assert.strictEqual(r.status, 2, `${camino}: el npm test del segundo renglón tenía que frenar · ${r.stderr.slice(0, 200)}`);
    r = correr('test-scope-guard-pre.sh', { command: 'ls -la\npwd', bin });
    assert.strictEqual(r.status, 0, `${camino}: un comando de dos renglones no tenía que frenar · ${r.stderr.slice(0, 200)}`);
    // el consejo de PowerShell sale sólo si tool_name se leyó como PowerShell
    r = correr('test-scope-guard-pre.sh', { tool: 'PowerShell', command: 'npm test', bin });
    assert.strictEqual(r.status, 2, `${camino}: npm test tenía que frenar`);
    assert.match(r.stderr, /En PowerShell/, `${camino}: tool_name no se leyó como PowerShell · ${r.stderr.slice(0, 300)}`);
  }
});

/** Un repo con memoria: un trozo en el índice (sano) o fuera de él (huérfano), con el trozo preparado para el commit. */
function repoConMemoria(sano) {
  const zlib = require('zlib');
  const r = fs.mkdtempSync(path.join(LAB, sano ? 'memoria-sana-' : 'memoria-rota-'));
  const fechas = { GIT_AUTHOR_DATE: '2026-10-24T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-24T10:00:00Z' };
  const git = (...a) => spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...a], { cwd: r, encoding: 'utf8', env: { ...process.env, ...fechas } });
  git('init', '-q', '.'); git('checkout', '-q', '-b', 'main');
  git('config', 'user.email', 'prueba@example.com'); git('config', 'user.name', 'prueba');
  fs.writeFileSync(path.join(r, '.engram-project'), 'proj-crlf');
  fs.mkdirSync(path.join(r, '.engram', 'chunks'), { recursive: true });
  // el commit de antes: índice vacío y sano, contra el que se compara el nuevo
  fs.writeFileSync(path.join(r, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks: [] }, null, 2));
  git('add', '-A'); git('commit', '-qm', 'memoria sana');
  fs.writeFileSync(path.join(r, '.engram', 'chunks', 'aaaa1111.jsonl.gz'), zlib.gzipSync(JSON.stringify({ observations: [{}], sessions: [], prompts: [] }) + '\n'));
  const chunks = sano ? [{ id: 'aaaa1111', created_by: 't', created_at: '2026-01-01T00:00:00Z', sessions: 0, memories: 1, prompts: 0 }] : [];
  fs.writeFileSync(path.join(r, '.engram', 'manifest.json'), JSON.stringify({ version: 1, chunks }, null, 2));
  git('add', '-A');
  return r;
}

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — aviso de memoria: el cruce leído sin \\r', (t) => {
  avisarSinJq(t);
  // un engram de mentira: el aviso lo llama para exportar la memoria antes de cruzar
  const binEngram = fs.mkdtempSync(path.join(LAB, 'bin-engram-'));
  fs.writeFileSync(path.join(binEngram, 'engram'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const [camino, bin] of CAMINOS) for (const sano of [true, false]) {
    const repo = repoConMemoria(sano);
    const log = path.join(LAB, `cruce-${sano ? 'sano' : 'roto'}-${camino.replace(/\W+/g, '-')}.log`);
    const r = correr('engram-pre-commit.sh', { command: 'git commit -m x', bin, cwd: repo, env: { ENGRAM_BIN: path.join(binEngram, 'engram'), TYCON_ENGRAM_HOOK: '1', ENGRAM_HOOK_LOG: log, ENGRAM_HOOK_DEBUG: '1' } });
    // el aviso llegó al cruce: un 0 por una salida temprana no cuenta como «sano»
    assert.match(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', /match commit=1/, `${camino}: el aviso no vio el commit, el cruce no se midió`);
    if (sano) assert.strictEqual(r.status, 0, `${camino}: con la memoria sana el commit tenía que pasar · ${r.stderr.slice(0, 300)}`);
    else assert.strictEqual(r.status, 2, `${camino}: con un trozo fuera del índice el commit tenía que frenar · ${r.stderr.slice(0, 300)}`);
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — aviso de memoria: el commit se ve', (t) => {
  avisarSinJq(t);
  const casos = [
    ['git status\ngit commit -m x', /match commit=1/],
    ['git status\ngit push', /push=1/],
    ['echo "a\\\\" ; git commit -m "x"', /match commit=1/],   // una barra escapada antes de la comilla no esconde el commit
    ['git status\ngit log', /match commit=0 push=0/],
  ];
  for (const [camino, bin] of CAMINOS) for (const [command, espera] of casos) {
    const log = path.join(LAB, `engram-${camino.replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2)}.log`);
    const r = correr('engram-pre-commit.sh', { command, bin, env: { ENGRAM_HOOK_LOG: log, ENGRAM_HOOK_DEBUG: '1' } });
    const texto = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.match(texto, espera, `${camino}: ${JSON.stringify(command)}: ${texto.slice(0, 300)}`);
    if (bin === BIN_WIN) {
      assert.ok(r.jqArgs, 'engram-pre-commit.sh: el jq de Windows de la prueba no corrió');
      assert.ok(r.jqArgs.split('\n').filter(Boolean).every((l) => /(^| )-b( |$)/.test(l)), `engram-pre-commit.sh: leyó con jq sin -b: ${r.jqArgs}`);
    }
  }
});

test('T12 LectoresDeLosFrenos_SinRetornoDeCarro @story-8.115 @ac-11 — alcance de pruebas: el escape queda anotado sin \\r', (t) => {
  avisarSinJq(t);
  // la línea de bypass.log escribe el comando como texto JSON (to_json_text): por los tres caminos, el mismo y sin \r
  const command = 'TYCON_FULL_SUITE=1 npm test';
  for (const [camino, bin] of CAMINOS) {
    const r = correr('test-scope-guard-pre.sh', { command, bin, env: { TYCON_FULL_SUITE: '1' } });
    const archivo = path.join(r.home, '.claude', '.tycon-pipeline', 'bypass.log');
    assert.ok(fs.existsSync(archivo), `${camino}: el escape no quedó anotado · ${r.stderr.slice(0, 200)}`);
    const lineas = fs.readFileSync(archivo, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lineas.length, 1, `${camino}: el escape se anotó ${lineas.length} veces`);
    assert.strictEqual(JSON.parse(lineas[0]).command, `${command}\n`, `${camino}: el comando anotado cambió: ${lineas[0]}`);
  }
});
