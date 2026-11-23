'use strict';
/**
 * review-answer-owner-click.test.js — `marker.js review-answer` anota «skip» y «wait» a la pregunta de revisar el plan o
 * el código sólo con el click del dueño o su terminal; «review», sin firma. De punta a punta: el freno de verdad (el de la
 * copia del arnés) y después el guion, con el registro que dejó el freno.
 *
 *   ReviewAnswer_SkipOWaitSinElDueno_NoSeAnota — la coordinadora para otra sesión, o la propia sesión: sin el click, el
 *     freno da el cuadro y no corre nada; el guion corrido sin el registro del freno, con la ventana o con la delegación
 *     tampoco anota
 *   ReviewAnswer_ReviewSinClick_SeAnota — «review» se anota sin firma y la cuarta vuelta se puede lanzar
 *   ReviewAnswer_SkipConElClickDeOtroPedido_NoSeAnota — el click a «esperar», o al cuadro de otra versión del plan, no
 *     anota «seguir sin revisión»
 *   ReviewAnswer_SkipConElClickDeEsePedido_SeAnotaUnaVez — con el click a ese mismo pedido: el renglón con su vía, la
 *     pregunta cerrada, la sesión sigue sin revisión y el plan lo firma una persona; el mismo click no sirve dos veces
 *   ReviewAnswer_WaitConElClick_CierraLaPregunta — «esperar» con el click cierra la pregunta
 *   ReviewAnswer_LaTerminalDelDueno_Anota — desde la terminal del dueño (un pty), sin sesión; `--terminal` con «review»
 *     no se acepta
 *   ReviewAnswerCodigo_* — lo mismo para la pregunta del código, con la firma `code-review-answer`: sin el dueño no se
 *     anota, «review» sí, el click de otro pedido (otra respuesta, otro diff, la pregunta del plan) no sirve, el de ese
 *     pedido anota una vez con su vía y es la respuesta del portón del pase, y la terminal del dueño anota
 *
 * El laboratorio: tests/lib/review-answer-lab.js. 0 deps (node:test).
 *
 * stable-data: las horas son las de la corrida de la prueba; ninguna se compara con una fecha fija.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib/review-answer-lab.js');

const { laboratorio, salida, SKIP, WAIT, REVIEW, SKIP_CODIGO, WAIT_CODIGO, REVIEW_CODIGO, COORD, DESTINO, PR, COPIA } = L;
const MARKER = path.join(COPIA, 'skills', 'tycon-pipeline', 'scripts', 'marker.js');
const { arbolDelGuion } = require(path.join(COPIA, 'scripts', 'tests', 'lib', 'window-passed.js'));

test('ReviewAnswer_SkipOWaitSinElDueno_NoSeAnota', (t) => {
  const lab = laboratorio(t);
  for (const args of [SKIP, WAIT]) {
    const x = lab.pedir(COORD, args);
    assert.strictEqual(x.freno.decision, 'deny', salida(x));
    assert.strictEqual(x.r, null, 'el freno no deja correr el comando');
  }
  const propia = lab.pedir(DESTINO, SKIP.slice(0, 5));
  assert.strictEqual(propia.freno.decision, 'deny', salida(propia));
  // el guion solo, sin el registro del freno, con la ventana dada por pasada o con la delegación: no anota
  const cmd = lab.comando(SKIP);
  for (const ventana of [{ arbol: { arbol: arbolDelGuion(lab.home, cmd), pid: 301, ahora: Date.now() } }, {}, { delegadaPor: COORD }, { via: 'mensaje' }]) {
    const r = lab.correr(COORD, SKIP, ventana);
    assert.notStrictEqual(r.status, 0, `${JSON.stringify(ventana).slice(0, 60)}: ${r.stdout}${r.stderr}`);
  }
  const r = lab.correr(DESTINO, SKIP.slice(0, 5), {});
  assert.notStrictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(lab.respuestas(), [], 'no se escribió nada');
  assert.deepStrictEqual(lab.abiertas(), [`${DESTINO}/plan`], 'la pregunta sigue a la vista');
  assert.ok(lab.accion().alDueno.llega, 'la cuarta vuelta sigue esperando a una persona');
});

test('ReviewAnswer_ReviewSinClick_SeAnota', (t) => {
  const lab = laboratorio(t);
  const x = lab.pedir(COORD, REVIEW);
  assert.strictEqual(x.freno.decision, 'none', salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  assert.deepStrictEqual(lab.respuestas().map((j) => [j.choice, j.via || null, j.quien]), [['review', null, `coordinadora ${COORD}`]]);
  assert.deepStrictEqual(lab.abiertas(), []);
  const p = PR.preparar({ lanza: COORD, destino: DESTINO, estado: lab.estado, home: lab.home, delegacion: lab.delegacion, config: L.CONFIG });
  assert.strictEqual(p.codigo, 0, p.motivo);
});

test('ReviewAnswer_SkipConElClickDeOtroPedido_NoSeAnota', (t) => {
  const lab = laboratorio(t);
  lab.click(WAIT);
  let x = lab.pedir(COORD, SKIP);
  assert.strictEqual(x.freno.decision, 'deny', salida(x));
  lab.click(SKIP);
  lab.plan();
  x = lab.pedir(COORD, SKIP);
  assert.strictEqual(x.freno.decision, 'deny', salida(x));
  assert.deepStrictEqual(lab.respuestas(), []);
  assert.deepStrictEqual(lab.abiertas(), [`${DESTINO}/plan`]);
});

test('ReviewAnswer_SkipConElClickDeEsePedido_SeAnotaUnaVez', (t) => {
  const lab = laboratorio(t);
  lab.click(SKIP);
  const x = lab.pedir(COORD, SKIP);
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'click'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  const [r] = lab.respuestas();
  assert.deepStrictEqual([r.choice, r.via, r.quien], ['skip', 'click', `coordinadora ${COORD}`]);
  assert.deepStrictEqual(lab.abiertas(), []);
  const a = lab.accion();
  assert.deepStrictEqual([a.decision, a.alDueno || null], ['skip', null], JSON.stringify(a));
  // el mismo click no sirve dos veces
  const otra = lab.pedir(COORD, SKIP);
  assert.strictEqual(otra.freno.decision, 'deny', salida(otra));
  assert.strictEqual(lab.respuestas().length, 1);
});

test('ReviewAnswer_WaitConElClick_CierraLaPregunta', (t) => {
  const lab = laboratorio(t);
  lab.click(WAIT);
  const x = lab.pedir(COORD, WAIT);
  assert.strictEqual(x.r && x.r.status, 0, salida(x));
  assert.deepStrictEqual(lab.respuestas().map((j) => [j.choice, j.via]), [['wait', 'click']]);
  assert.deepStrictEqual(lab.abiertas(), []);
});

// la terminal del dueño: un pty de Python escribe «firmo» cuando la terminal lo pide
const CON_TERMINAL = [
  'import os, sys, pty, select',
  'resp = os.environ.pop("RESPUESTA_TTY", "")',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
  'out = b""',
  'enviada = False',
  'while True:',
  '    r, _, _ = select.select([fd], [], [], 20)',
  '    if not r: break',
  '    try: d = os.read(fd, 4096)',
  '    except OSError: break',
  '    if not d: break',
  '    out += d',
  '    if not enviada and "firmo".encode() in out:',
  '        os.write(fd, (resp + "\\n").encode()); enviada = True',
  '_, st = os.waitpid(pid, 0)',
  'sys.stdout.write(out.decode("utf8", "replace"))',
  'sys.exit(os.waitstatus_to_exitcode(st))',
].join('\n');

test('ReviewAnswer_LaTerminalDelDueno_Anota', (t) => {
  const lab = laboratorio(t);
  const env = { ...lab.env, RESPUESTA_TTY: 'firmo' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'TYCON_HOME']) delete env[k];
  // `--terminal` es para lo que firma el dueño: con «review» no se acepta
  const conReview = spawnSync(process.execPath, [MARKER, ...REVIEW, '--terminal'], { cwd: lab.repo, encoding: 'utf8', env });
  assert.notStrictEqual(conReview.status, 0, conReview.stdout + conReview.stderr);
  assert.deepStrictEqual(lab.respuestas(), []);
  const r = process.platform === 'win32' ? null : spawnSync('python3', ['-c', CON_TERMINAL, process.execPath, MARKER, ...SKIP, '--terminal'], { cwd: lab.repo, encoding: 'utf8', env, timeout: 60000 });
  if (!r || r.error) {
    console.log('⏭ la respuesta por la terminal: NO MEDIDA — sin Python o en Windows');
    return;
  }
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(lab.respuestas().map((j) => [j.choice, j.via, j.quien]), [['skip', 'terminal', 'terminal del dueño']]);
  assert.deepStrictEqual(lab.abiertas(), []);
});

// ── La pregunta del código: «skip» y «wait» con la firma code-review-answer ─────────────────────────────────────────

test('ReviewAnswerCodigo_SkipOWaitSinElDueno_NoSeAnota', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  for (const args of [SKIP_CODIGO, WAIT_CODIGO]) {
    const x = lab.pedir(COORD, args);
    assert.strictEqual(x.freno.decision, 'deny', salida(x));
    assert.strictEqual(x.r, null, 'el freno no deja correr el comando');
  }
  const propia = lab.pedir(DESTINO, SKIP_CODIGO.slice(0, 5));
  assert.strictEqual(propia.freno.decision, 'deny', salida(propia));
  // el guion solo, sin el registro del freno, con la ventana dada por pasada, con la delegación o con un «aprobado»
  const cmd = lab.comando(SKIP_CODIGO);
  for (const ventana of [{ arbol: { arbol: arbolDelGuion(lab.home, cmd), pid: 301, ahora: Date.now() } }, {}, { delegadaPor: COORD }, { via: 'mensaje' }]) {
    const r = lab.correr(COORD, SKIP_CODIGO, ventana);
    assert.notStrictEqual(r.status, 0, `${JSON.stringify(ventana).slice(0, 60)}: ${r.stdout}${r.stderr}`);
  }
  assert.deepStrictEqual(lab.respuestas(), [], 'no se escribió nada');
  assert.deepStrictEqual(lab.abiertas().filter((p) => p.endsWith('/code')), [`${DESTINO}/code`], 'la pregunta sigue a la vista');
});

test('ReviewAnswerCodigo_ReviewSinClick_SeAnota', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  const x = lab.pedir(COORD, REVIEW_CODIGO);
  assert.strictEqual(x.freno.decision, 'none', salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  assert.deepStrictEqual(lab.respuestas().map((j) => [j.kind, j.choice, j.via || null]), [['code', 'review', null]]);
  assert.deepStrictEqual(lab.abiertas().filter((p) => p.endsWith('/code')), []);
});

test('ReviewAnswerCodigo_SkipConElClickDeOtroPedido_NoSeAnota', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  lab.click(WAIT_CODIGO);
  let x = lab.pedir(COORD, SKIP_CODIGO);
  assert.strictEqual(x.freno.decision, 'deny', salida(x));
  lab.click(SKIP_CODIGO);
  lab.cambio();
  x = lab.pedir(COORD, SKIP_CODIGO);
  assert.strictEqual(x.freno.decision, 'deny', salida(x));
  // el click a «seguir sin revisión» del plan tampoco
  lab.click(SKIP);
  x = lab.pedir(COORD, SKIP_CODIGO);
  assert.strictEqual(x.freno.decision, 'deny', salida(x));
  assert.deepStrictEqual(lab.respuestas(), []);
});

test('ReviewAnswerCodigo_SkipConElClickDeEsePedido_SeAnotaUnaVez', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  lab.click(SKIP_CODIGO);
  const x = lab.pedir(COORD, SKIP_CODIGO);
  assert.deepStrictEqual([x.freno.decision, x.freno.via], ['allow', 'click'], salida(x));
  assert.strictEqual(x.r.status, 0, salida(x));
  const [r] = lab.respuestas();
  assert.deepStrictEqual([r.kind, r.choice, r.via, r.quien], ['code', 'skip', 'click', `coordinadora ${COORD}`]);
  const h = PR.huellaDe({ estado: lab.estado, sesion: DESTINO, kind: 'code' }).huella;
  assert.strictEqual(PR.respuestaDe({ estado: lab.estado, sesion: DESTINO, kind: 'code', huella: h }), 'skip', 'es la respuesta que lee el portón del pase');
  assert.deepStrictEqual(lab.abiertas().filter((p) => p.endsWith('/code')), []);
  const otra = lab.pedir(COORD, SKIP_CODIGO);
  assert.strictEqual(otra.freno.decision, 'deny', salida(otra));
  assert.strictEqual(lab.respuestas().length, 1, 'el mismo click no sirve dos veces');
});

test('ReviewAnswerCodigo_LaTerminalDelDueno_Anota', (t) => {
  const lab = laboratorio(t);
  lab.preguntarCodigo();
  const env = { ...lab.env, RESPUESTA_TTY: 'firmo' };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_OPTIONS', 'CI', 'TF_BUILD', 'GITHUB_ACTIONS', 'TYCON_HOME']) delete env[k];
  const conReview = spawnSync(process.execPath, [MARKER, ...REVIEW_CODIGO, '--terminal'], { cwd: lab.repo, encoding: 'utf8', env });
  assert.notStrictEqual(conReview.status, 0, conReview.stdout + conReview.stderr);
  const r = process.platform === 'win32' ? null : spawnSync('python3', ['-c', CON_TERMINAL, process.execPath, MARKER, ...WAIT_CODIGO, '--terminal'], { cwd: lab.repo, encoding: 'utf8', env, timeout: 60000 });
  if (!r || r.error) {
    console.log('⏭ la respuesta al código por la terminal: NO MEDIDA — sin Python o en Windows');
    return;
  }
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(lab.respuestas().map((j) => [j.kind, j.choice, j.via, j.quien]), [['code', 'wait', 'terminal', 'terminal del dueño']]);
});
