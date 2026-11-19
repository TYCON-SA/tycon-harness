#!/usr/bin/env node
'use strict';
// hostile-command-text.test.js — los que leen el texto de un comando contestan a tiempo con textos armados para trabarlos.
// Un freno que no contesta ya no deja pasar, pero tampoco deja trabajar: la lectura tiene que terminar sola, sin reloj.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL = path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts');
const GATE = path.join(SKILL, 'on-bash-write-gate.js');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'prod-access-guard.js');
const SHELL_PARSE = path.join(ROOT, 'scripts', 'lib', 'shell-parse.js');
const MARKER_COMMAND = path.join(SKILL, 'lib', 'marker-command.js');
const TOPE_MS = 4000;
const LARGO = 60 * 1024;

const llenar = (trozo) => trozo.repeat(Math.ceil(LARGO / trozo.length)).slice(0, LARGO);
const FORMAS = {
  'paréntesis abiertos': llenar('(\n'),
  'heredocs sin cerrar': llenar('<<EOF\n'),
  'marcas de heredoc sueltas': llenar('<<\n'),
  'sustituciones abiertas': llenar('$(\n'),
  'comillas simples sin cerrar': llenar("'a\n"),
  'comillas dobles sin cerrar': llenar('"a\n'),
  'negaciones y tuberías': llenar('!|'),
  comodines: llenar('*?[a'),
  'barras invertidas': llenar('\\\\\n'),
};

/** Corre con la entrada en un archivo: lo que se mide es la lectura del comando, no el canal que lo entrega. */
function conEntrada(texto, correr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostil-entrada-'));
  const ruta = path.join(dir, 'entrada');
  fs.writeFileSync(ruta, texto);
  const fd = fs.openSync(ruta, 'r');
  try { return correr([fd, 'pipe', 'pipe']); } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Corre `codigo` en un proceso aparte y devuelve cuánto tardó: si una lectura no termina, no se lleva la prueba con ella. */
function medir(codigo, entrada) {
  const ini = performance.now();
  const r = conEntrada(entrada, (stdio) => spawnSync(process.execPath, ['-e', codigo], { stdio, encoding: 'utf8', timeout: TOPE_MS * 3, killSignal: 'SIGKILL', maxBuffer: 1 << 24 }));
  return { ms: performance.now() - ini, status: r.status, signal: r.signal, stderr: r.stderr };
}

function aTiempo(nombre, codigo) {
  for (const [forma, texto] of Object.entries(FORMAS)) {
    const r = medir(codigo, texto);
    assert.strictEqual(r.signal, null, `${nombre} no terminó con ${forma}`);
    assert.strictEqual(r.status, 0, `${nombre} se cayó con ${forma}: ${r.stderr.slice(0, 300)}`);
    assert.ok(r.ms < TOPE_MS, `${nombre} tardó ${r.ms} ms con ${forma}`);
  }
}

const LEER = "const t = require('fs').readFileSync(0, 'utf8');";

test('T10 HostileText_EveryReaderAnswersInTime @story-8.308 @ac-10 — shell-parse contesta a tiempo con cada forma hostil', () => {
  aTiempo('shell-parse', `${LEER} const p = require(${JSON.stringify(SHELL_PARSE)});
    p.programasPorEntrada(t); p.sinHeredocs(t); p.segmentos(t); p.tokens(t); p.heredocs(t);`);
});

test('T10b HostileText_MarkerCommand @story-8.308 @ac-10 — marker-command contesta a tiempo con cada forma hostil', () => {
  aTiempo('marker-command', `${LEER} const m = require(${JSON.stringify(MARKER_COMMAND)}); m.tramos(t, 'bash'); m.llamadas(t);`);
});

test('T10c HostileText_WriteGateNet @story-8.308 @ac-10 — la red del freno de escrituras contesta a tiempo', () => {
  aTiempo('frenaLaRed', `${LEER} require(${JSON.stringify(GATE)}).frenaLaRed(t);`);
});

test('T10h HostileText_RewrittenExpressions_AloneInTime @story-8.308 @ac-10 — las dos expresiones reescritas, solas, contestan a tiempo', () => {
  aTiempo('los heredocs de tramos', `${LEER} require(${JSON.stringify(GATE)}).quitarCuerposDeHeredoc(t);`);
  aTiempo('la tubería a un shell', `${LEER} require(${JSON.stringify(GATE)}).vaAUnShell(t);`);
});

test('T10i HostileText_HeredocWalk_SameAsTheExpression @story-8.308 @ac-10 — el recorrido deja lo mismo que la expresión que reemplaza', () => {
  const { quitarCuerposDeHeredoc } = require(GATE);
  const EXPRESION = /((?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*)(?<!\$\(\([^\n]*)(?<!<)<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\2(?=[\s;&|()<>]|$)[^\n]*\n)(?:[\s\S]*?\n)??[ \t]*\3[ \t]*(?=\n|$)/g;
  const igual = (c) => assert.strictEqual(quitarCuerposDeHeredoc(c), c.replace(EXPRESION, '$1'), JSON.stringify(c));
  for (const c of [
    'ls', 'cat <<EOF\nrm x\nEOF\nls', 'cat <<EOF\nEOF\nls', "cat <<'E'\nx\nE", 'cat <<"E" | sh\nx\n  E  \nls', 'cat <<-E\n\tx\n\tE\nls',
    'cat <<E\nsin cierre', 'cat <<<E\nx\nE', 'echo $((1<<2))\nx\n2', 'echo "<<E"\nx\nE', "echo '<<E'\nx\nE", 'echo "a <<E\nx\nE',
    'cat <<A\n<<B\nA\nB', 'cat <<-\nx', 'cat <<$V\nx\n$V', 'cat <<E', '<<E\nE', 'cat <<<<E\nx\nE',
    'cat <<E;ls\nx\nE\nls', 'cat <<E\nx\nE\r\nls\nE',
  ]) igual(c);
  // Donde la expresión vieja se equivocaba, el recorrido hace lo que hace el shell: dos heredocs en un renglón se leen uno
  // detrás del otro, uno sin cierre se come el resto, y un `<<` escapado, entre comillas o en un comentario no abre nada.
  for (const [c, queda] of [
    ['cat <<A <<B\nx\nA\ny\nB\nls', 'cat <<A <<B\n\n\nls'],
    ['cat <<NO <<SI\nx\nSI\nls', 'cat <<NO <<SI\nx\nSI\nls'],
    ['echo x # <<E\nrm y\nE', 'echo x # <<E\nrm y\nE'],
    ['echo "a\\" <<E"\nrm y\nE', 'echo "a\\" <<E"\nrm y\nE'],
    ['echo \\<<E\nrm y\nE', 'echo \\<<E\nrm y\nE'],
  ]) assert.strictEqual(quitarCuerposDeHeredoc(c), queda, JSON.stringify(c));
  // la comparación al azar, donde las dos lecturas coinciden: un solo heredoc por renglón y sin barras invertidas
  const comparable = (c) => !c.includes('\\') && c.split('\n').every((l) => (l.match(/(?<!<)<<(?!<)/g) || []).length < 2);
  const PIEZAS = ['<<', '<<<', '<<-', 'E', 'F', "'", '"', ' ', '\t', '\n', '\n', 'E\n', '\nF', '$((', ';', '|', 'x', '-', '$', '\\'];
  let semilla = 8308;
  let conCuerpo = 0;
  for (let n = 0; n < 4000; n++) {
    let c = '';
    for (let k = 0; k < 14; k++) {
      semilla = (semilla * 1103515245 + 12345) % 2147483648;
      c += PIEZAS[(semilla >> 8) % PIEZAS.length];
    }
    if (!comparable(c)) continue;
    igual(c);
    if (quitarCuerposDeHeredoc(c) !== c) conCuerpo++;
  }
  assert.ok(conCuerpo >= 20, `sólo ${conCuerpo} comandos armados traían un heredoc que se cierra`);
});

function corral(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostil-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'specs', 'story-1.1.md'), '---\nepic: 1\nstory: "1.1"\ntitle: "x"\nstatus: in-progress\n---\n# x\n');
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const env = { HOME: dir, USERPROFILE: dir, TYCON_NO_RUN_CHANGE: '1', TYCON_BASH_GATE_TIMEOUT_S: '50' };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('TYCON_') && k !== 'CLAUDE_CODE_SESSION_ID' && k !== 'HOME') env[k] = v;
  const correr = (guion, command, extra = {}) => {
    const ini = performance.now();
    const entrada = JSON.stringify({ tool_name: 'Bash', session_id: 's-hostil', cwd: repo, tool_input: { command } });
    const r = conEntrada(entrada, (stdio) => spawnSync(process.execPath, [guion], {
      stdio, cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: TOPE_MS * 3, killSignal: 'SIGKILL', maxBuffer: 1 << 24,
    }));
    return { ms: performance.now() - ini, status: r.status, signal: r.signal };
  };
  return { correr };
}

test('T10d HostileText_WriteGate_DecidesWithinItsClock @story-8.308 @ac-10 — el freno entero sale 2 dentro de su reloj, acortado para la prueba', (t) => {
  const c = corral(t);
  for (const [forma, texto] of Object.entries(FORMAS)) {
    const r = c.correr(GATE, `rm specs/story-1.1.md\n${texto}`, { TYCON_BASH_GATE_TIMEOUT_S: '2' });
    assert.strictEqual(r.status, 2, `${forma}: salió ${r.status} (${r.signal})`);
    assert.ok(r.ms < TOPE_MS, `${forma}: tardó ${r.ms} ms`);
  }
});

test('T10f HostileText_ManyPipes_LooksAtMore @story-8.308 @ac-10 — con demasiadas tuberías nada cuenta como texto citado', (t) => {
  const c = corral(t);
  const citado = 'grep "sed -i s/a/b/ specs/story-1.1.md" README.md';
  assert.strictEqual(c.correr(GATE, citado).status, 0, 'citado en un buscador, pasa');
  assert.strictEqual(c.correr(GATE, `${citado} | sh`).status, 2, 'con la salida yendo a un shell, frena');
  assert.strictEqual(c.correr(GATE, `${citado}${' | cat'.repeat(10)}`).status, 0, 'unas tuberías comunes no cambian nada');
  assert.strictEqual(c.correr(GATE, `${citado}${' | cat'.repeat(600)}`).status, 2, 'pasado el tope mira de más');
});

test('T10g HostileText_PipeRuns_AnswerInTime @story-8.308 @ac-10 — una tira de tuberías no multiplica la búsqueda del shell', (t) => {
  const r = corral(t).correr(GATE, `rm specs/story-1.1.md\n${llenar('!|').slice(0, 4000)}`);
  assert.strictEqual(r.status, 2, `salió ${r.status} (${r.signal})`);
  assert.ok(r.ms < TOPE_MS, `tardó ${r.ms} ms`);
});

test('T10e HostileText_ProductionGuard_StillBlocks @story-8.308 @ac-10 — el freno de producción contesta a tiempo y sigue viendo la base', (t) => {
  const c = corral(t);
  for (const [forma, texto] of Object.entries(FORMAS)) {
    const r = c.correr(GUARD, `sqlcmd -S prod-b.database.windows.net -Q "select 1"\n${texto}`);
    assert.strictEqual(r.status, 2, `${forma}: salió ${r.status} (${r.signal})`);
    assert.ok(r.ms < TOPE_MS, `${forma}: tardó ${r.ms} ms`);
  }
});
