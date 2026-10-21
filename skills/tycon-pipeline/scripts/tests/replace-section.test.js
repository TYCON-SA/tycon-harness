#!/usr/bin/env node
'use strict';
/**
 * replace-section.test.js — la receta de reemplazo de tramos (T10-T11).
 *
 * QUÉ CUIDA: la receta registrada para reemplazar un tramo grande de un archivo de código con el pipeline abierto.
 * Caso: reemplazar ~300 líneas de un archivo de pruebas sin la receta obliga a escribir por
 * consola con el escape del freno y a hacer después un Edit chico para que el registro vea el archivo. La receta
 * (`replace-section.js`) hace el reemplazo por la MISMA cadena que un Edit: los frenos del Edit antes de escribir
 * (`dispatch.js pre-edit`) y el registro de ediciones después (`dispatch.js post-edit`).
 *
 * Cada caso corre el guion real con un HOME de juguete: el estado del pipeline vive ahí, nunca en el de la máquina.
 *
 * Correr: node --test skills/tycon-pipeline/scripts/tests/replace-section.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const ARBOL = path.resolve(SCRIPTS, '..', '..', '..');
const RECETA = path.join(SCRIPTS, 'replace-section.js');
const SID = 'sesion-receta-725';

function corral({ planAprobado = true } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'receta-725-')));
  const home = path.join(raiz, 'home');
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const estado = require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  const archivo = path.join(repo, 'src', 'Servicio.cs');
  fs.writeFileSync(archivo, Array.from({ length: 10 }, (_, i) => `linea ${i + 1}`).join('\n') + '\n');
  const nuevo = path.join(raiz, 'nuevo.txt');
  fs.writeFileSync(nuevo, 'reemplazo A\nreemplazo B\n');
  const marker = {
    storyId: '9.9', repoPath: repo, sessionId: SID,
    stepsCompleted: planAprobado ? [0, 1, 2, 3] : [0, 1, 2],
    stepsPending: planAprobado ? [4, 5, 6, 7, 8] : [3, 4, 5, 6, 7, 8],
    filesTouched: [],   // la forma que deja marker.js start

    // el test ya se tocó: el portón ATDD deja pasar el primer código
    fileEvents: [{ path: path.join(repo, 'tests', 'servicio.test.js'), ts: new Date(Date.now() - 60000).toISOString() }],
  };
  const markerPath = path.join(estado, 'active', `${SID}.json`);
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  return { raiz, home, repo, archivo, nuevo, markerPath };
}

function receta(c, args) {
  const env = { ...process.env, HOME: c.home, CLAUDE_CODE_SESSION_ID: SID, TYCON_GUIDES_DIR: ARBOL };
  for (const k of ['TYCON_STORY_GATE', 'TYCON_ATDD_PREEDIT_GATE', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'TYCON_HOME']) delete env[k];
  return spawnSync(process.execPath, [RECETA, ...args], { cwd: c.repo, encoding: 'utf8', env, input: '' });
}

test('T10 ReplaceSection_ReemplazaYRegistra — el tramo queda reemplazado y el registro lo ve', () => {
  const c = corral();
  const r = receta(c, ['--file', 'src/Servicio.cs', '--from', '3', '--to', '5', '--with', c.nuevo]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const lineas = fs.readFileSync(c.archivo, 'utf8').split('\n');
  assert.deepEqual(lineas.slice(0, 5), ['linea 1', 'linea 2', 'reemplazo A', 'reemplazo B', 'linea 6']);
  assert.equal(lineas.filter(Boolean).length, 9, 'tres líneas por dos: nueve');
  const marker = JSON.parse(fs.readFileSync(c.markerPath, 'utf8'));
  assert.ok((marker.fileEvents || []).some((e) => e.path === c.archivo), `el registro tiene que ver el archivo: ${JSON.stringify(marker.fileEvents)}`);
});

test('T11 ReplaceSection_FrenoDelEdit_NoTocaElArchivo — si un freno del Edit para, no se escribe', () => {
  const c = corral({ planAprobado: false });
  const antes = fs.readFileSync(c.archivo, 'utf8');
  const r = receta(c, ['--file', 'src/Servicio.cs', '--from', '3', '--to', '5', '--with', c.nuevo]);
  assert.equal(r.status, 2, `con el plan sin aprobar el carril frena: stdout ${r.stdout} stderr ${r.stderr}`);
  assert.ok(r.stderr.trim().length > 0, 'con el mensaje del freno');
  assert.equal(fs.readFileSync(c.archivo, 'utf8'), antes, 'el archivo no cambió');
});

test('T11b ReplaceSection_RangoInvalido_SaleDosSinTocar', () => {
  const c = corral();
  const antes = fs.readFileSync(c.archivo, 'utf8');
  for (const [desde, hasta] of [['8', '3'], ['5', '40'], ['0', '2'], ['x', '2']]) {
    const r = receta(c, ['--file', 'src/Servicio.cs', '--from', desde, '--to', hasta, '--with', c.nuevo]);
    assert.equal(r.status, 2, `--from ${desde} --to ${hasta}: ${r.stderr}`);
  }
  const sinWith = receta(c, ['--file', 'src/Servicio.cs', '--from', '1', '--to', '2']);
  assert.equal(sinWith.status, 2, 'sin --with no hay qué poner');
  assert.equal(fs.readFileSync(c.archivo, 'utf8'), antes);
});

// T25 — seguridad: por consola, la receta no pasa por las reglas de permisos del Edit de la
// herramienta, así que no puede escribir fuera del repo de la corrida ni de la carpeta desde donde se la llama (con la
// ruta real: un enlace no la saca).
test('T25 ReplaceSection_FueraDelRepoYDeLaCarpeta_NoEscribe', () => {
  const c = corral();
  const afuera = path.join(c.raiz, 'afuera.cs');
  fs.writeFileSync(afuera, 'uno\ndos\n');
  const r = receta(c, ['--file', afuera, '--from', '1', '--to', '1', '--with', c.nuevo]);
  assert.equal(r.status, 2, `stdout ${r.stdout} stderr ${r.stderr}`);
  assert.match(r.stderr, /fuera del repo/);
  assert.equal(fs.readFileSync(afuera, 'utf8'), 'uno\ndos\n');
  // un enlace adentro del repo que apunta afuera tampoco
  fs.symlinkSync(afuera, path.join(c.repo, 'src', 'enlace.cs'));
  const e = receta(c, ['--file', 'src/enlace.cs', '--from', '1', '--to', '1', '--with', c.nuevo]);
  assert.equal(e.status, 2, e.stderr);
  assert.equal(fs.readFileSync(afuera, 'utf8'), 'uno\ndos\n');
});

// T27 — seguridad: sin repo de la corrida, la carpeta de la llamada vale sólo si es un repo
// git; y nunca algo bajo `.git/` (un hook de git es código que corre solo).
test('T27 ReplaceSection_SinRepoYDentroDeGit_NoEscribe', () => {
  const c = corral();
  // sin marcador: la carpeta de la llamada (el repo de juguete, que NO es git) no alcanza
  fs.rmSync(c.markerPath);
  const r = receta(c, ['--file', 'src/Servicio.cs', '--from', '1', '--to', '1', '--with', c.nuevo]);
  assert.equal(r.status, 2, `sin repo de la corrida ni repo git en la carpeta: ${r.stderr}`);
  // con repo git y el archivo bajo .git/
  const c2 = corral();
  require('child_process').execFileSync('git', ['-C', c2.repo, 'init', '-q']);
  const hook = path.join(c2.repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, 'echo uno\n');
  const g = receta(c2, ['--file', hook, '--from', '1', '--to', '1', '--with', c2.nuevo]);
  assert.equal(g.status, 2, g.stderr);
  assert.match(g.stderr, /\.git/);
  assert.equal(fs.readFileSync(hook, 'utf8'), 'echo uno\n');
  // en un disco que no distingue mayúsculas (macOS), `.GIT/hooks/…` es el mismo lugar
  const mayus = path.join(c2.repo, '.GIT', 'hooks', 'pre-commit');
  if (fs.existsSync(mayus)) {
    const m = receta(c2, ['--file', mayus, '--from', '1', '--to', '1', '--with', c2.nuevo]);
    assert.equal(m.status, 2, m.stderr);
    assert.equal(fs.readFileSync(hook, 'utf8'), 'echo uno\n');
  }
});

// T30 — seguridad: un archivo que no es UTF-8 (un .cs en Windows-1252) no se reescribe: leerlo
// como UTF-8 cambia en silencio los bytes de las líneas que ni se tocaron.
test('T30 ReplaceSection_ArchivoQueNoEsUtf8_NoEscribe', () => {
  const c = corral();
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x64, 0x6f, 0x73, 0x0a]);   // «café\ndos\n» en Latin-1
  fs.writeFileSync(c.archivo, latin1);
  const r = receta(c, ['--file', 'src/Servicio.cs', '--from', '2', '--to', '2', '--with', c.nuevo]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /UTF-8/);
  assert.ok(fs.readFileSync(c.archivo).equals(latin1), 'los bytes del archivo no cambiaron');
  // y un contenido nuevo que no es UTF-8 tampoco entra
  const c2 = corral();
  const antes = fs.readFileSync(c2.archivo);
  fs.writeFileSync(c2.nuevo, latin1);
  const w = receta(c2, ['--file', 'src/Servicio.cs', '--from', '2', '--to', '2', '--with', c2.nuevo]);
  assert.equal(w.status, 2, w.stderr);
  assert.match(w.stderr, /UTF-8/);
  assert.ok(fs.readFileSync(c2.archivo).equals(antes));
});

// T23 — dos detalles: un archivo con finales CRLF no puede quedar mezclado,
// y el mensaje cuenta LÍNEAS, no saltos (un reemplazo sin salto final es una línea igual).
test('T23 ReplaceSection_ArchivoCrlf_ConservaLosFinalesYCuentaLineas', () => {
  const c = corral();
  fs.writeFileSync(c.archivo, 'a\r\nb\r\nc\r\nd\r\n');
  fs.writeFileSync(c.nuevo, 'X\r\nY');   // sin salto al final
  const r = receta(c, ['--file', 'src/Servicio.cs', '--from', '2', '--to', '3', '--with', c.nuevo]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(c.archivo, 'utf8'), 'a\r\nX\r\nY\r\nd\r\n', 'el salto agregado es el del archivo (CRLF)');
  assert.match(r.stdout, /\(2 → 2\)/, `dos líneas por dos: ${r.stdout}`);
});
