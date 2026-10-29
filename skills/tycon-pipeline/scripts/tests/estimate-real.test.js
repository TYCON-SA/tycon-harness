'use strict';

/**
 * estimate-real.test.js — `pipeline.js estimate-real`: lo real de una historia, anotado al cerrarla.
 *
 * Lo que no se puede perder: las horas salen sólo de la constancia que deja `work-signal stop` con los segundos que
 * informa la herramienta de horas, nunca de un número que se pase a mano (así el modelo no puede escribir lo real); sin
 * horas no se escribe nada y el cierre sigue; reintentar el cierre con la misma ejecución no duplica la línea. Todo en
 * laboratorios: HOME propio, una herramienta de horas de mentira y un repo de historias de acme; nada toca la máquina.
 *
 *   T19 · un `stop` de 10800 segundos y después `estimate-real`: la línea `real` de 3 h en el registro del repo del spec.
 *   T20 · sin `stop` previo, un `stop` sin segundos y uno con una acción: `sin_horas`, salida 0, nada escrito.
 *   T38 · dos llamadas con la misma `--run`: una sola línea y `ya_anotado`; sin `--run`, salida 2.
 *   T42 · `--hours` sale 2 sin escribir; un `stop` posterior sin segundos deja sin horas (vale la última constancia).
 *   AccionConConstancia · una herramienta que informa por una acción: `work-signal stop --action-done <id>` lee las horas
 *     del resultado de la llamada que cerró esa entrada; sin esa llamada, con otro id, sin intervalo o en Codex, no anota.
 *
 * Correr:   node --test skills/tycon-pipeline/scripts/tests/estimate-real.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const PIPELINE = path.join(__dirname, '..', 'pipeline.js');
const REGISTRO = path.join('.tycon', 'estimates.jsonl');

function tmp(p) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); }

/** La herramienta de horas de mentira: en `stop` contesta lo que diga FAKE_STOP (`10800`, `none` o `action`). */
function herramienta() {
  const dir = tmp('estimate-real-int-');
  const own = path.join(dir, 'fake');
  fs.mkdirSync(path.join(own, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(own, 'integration.json'), JSON.stringify({ name: 'fake', label: 'De mentira', kind: 'timeTracking', onWork: 'scripts/on-work.js', hooks: [], dispatch: [], settings: [] }));
  fs.writeFileSync(path.join(own, 'scripts', 'on-work.js'), [
    "let raw = ''; process.stdin.on('data', (c) => { raw += c; }); process.stdin.on('end', () => {",
    "  const ev = JSON.parse(raw); const modo = process.env.FAKE_STOP || 'none';",
    "  const out = ev.event !== 'stop' ? {} : modo === 'action' ? { action: 'cerrá la entrada y sumá las de la historia' }",
    "    : modo === 'action-id' ? { action: 'cerrá la entrada entry-4242 con mcp__fake__cerrar', entryId: 'entry-4242' } : modo === 'none' ? {} : { seconds: Number(modo) };",
    "  process.stdout.write(JSON.stringify(out) + '\\n');",
    "});",
  ].join('\n'));
  return dir;
}
const INTEGRACIONES = herramienta();

/** Un laboratorio: HOME propio y un repo de historias de acme (git) con una historia de una épica. */
function lab() {
  const home = tmp('estimate-real-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const repo = tmp('estimate-real-repo-');
  fs.mkdirSync(path.join(repo, 'specs'));
  const spec = path.join(repo, 'specs', 'story-3.2-algo.md');
  fs.writeFileSync(spec, '---\nepic: 3\nstory: "3.2"\ntitle: "El tablero de pedidos"\nstatus: review\n---\n\n# Story 3.2\n');
  const env = { HOME: home, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync('git', ['init', '-q', repo], { env: Object.assign({}, process.env, env) });
  return { home, repo, spec };
}

function correr(l, args, fakeStop, extra) {
  const env = Object.assign({}, process.env, {
    HOME: l.home, USERPROFILE: l.home, TYCON_HOME: path.join(l.home, '.tycon'), TYCON_PROFILE: '0', TYCON_GUIDES_DIR: RAIZ,
    TYCON_INTEGRATIONS_DIR: INTEGRACIONES, TYCON_TIME_TRACKING: 'fake', FAKE_STOP: fakeStop || 'none',
    GIT_CONFIG_GLOBAL: path.join(l.home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_SESSION_ID: 'ses-estimate-real',
  });
  Object.assign(env, extra || {});
  for (const k of ['TCG', 'TYCON_CLOCKIFY']) delete env[k];
  const r = spawnSync(process.execPath, [PIPELINE, ...args], { cwd: l.repo, env, encoding: 'utf8', timeout: 60000 });
  let json = null;
  try { json = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (_) { json = null; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const stop = (l, modo) => correr(l, ['work-signal', 'stop', '--story', l.spec, '--repo', l.repo], modo);
const real = (l, extra) => correr(l, ['estimate-real', '--story', l.spec, ...extra]);
function lineas(repo) {
  const f = path.join(repo, REGISTRO);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)) : [];
}

test('T19 EstimateReal_ConHoras @story-2.75 @ac-15', () => {
  const l = lab();
  const s = stop(l, '10800');
  assert.strictEqual(s.status, 0, s.stderr);
  assert.strictEqual(s.json.seconds, 10800);
  const r = real(l, ['--run', 'r1']);
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  assert.strictEqual(r.json.ok, true, r.stdout);
  assert.deepStrictEqual(lineas(l.repo).map((x) => [x.nivel, x.historia, x.epica, x.valor, x.unidad, x.ejecucion]), [['real', '3.2', '3', 3, 'hours', 'r1']]);
  const paso = fs.readFileSync(path.join(__dirname, '..', '..', 'steps', 'close-work-item.md'), 'utf8');
  assert.match(paso, /pipeline\.js estimate-real --story <[^>]+> --run </, 'el paso de cierre nombra el comando');
  assert.doesNotMatch(paso, /estimate-real[^\n]*--hours/, 'y no le pasa horas');
});

test('T20 EstimateReal_SinHoras @story-2.75 @ac-16', () => {
  for (const modo of [null, 'none', 'action']) {
    const l = lab();
    if (modo) assert.strictEqual(stop(l, modo).status, 0);
    const r = real(l, ['--run', 'r1']);
    assert.deepStrictEqual([r.status, r.json && r.json.ok, r.json && r.json.reason], [0, false, 'sin_horas'], `${modo}: ${r.stdout}${r.stderr}`);
    assert.ok(r.json.motivo, 'dice por qué');
    if (modo === 'action') assert.match(r.json.motivo, /acci[oó]n/);
    assert.deepStrictEqual(lineas(l.repo), [], 'nada escrito');
  }
});

test('T38 EstimateReal_ReintentoNoDuplica @story-2.75 @ac-35', () => {
  const l = lab();
  stop(l, '7200');
  assert.strictEqual(real(l, ['--run', 'r1']).json.ok, true);
  const otra = real(l, ['--run', 'r1']);
  assert.deepStrictEqual([otra.status, otra.json.ok, otra.json.reason], [0, true, 'ya_anotado']);
  assert.strictEqual(lineas(l.repo).length, 1, 'una sola línea');
  const sinRun = real(l, []);
  assert.strictEqual(sinRun.status, 2, sinRun.stdout);
  assert.match(sinRun.stderr + sinRun.stdout, /--run/);
});

test('EstimateReal_SalidasDeError @story-2.75 @ac-16 @ac-19', () => {
  const l = lab();
  // un spec que no está, uno sin story: y uno fuera de git sin --repo: salida 2, nada escrito
  assert.strictEqual(correr(l, ['estimate-real', '--story', path.join(l.repo, 'specs', 'no-esta.md'), '--run', 'r1']).status, 2);
  const sinId = path.join(l.repo, 'specs', 'story-sin-id.md');
  fs.writeFileSync(sinId, '---\nepic: 3\ntitle: "Sin id"\n---\n');
  assert.strictEqual(correr(l, ['estimate-real', '--story', sinId, '--run', 'r1']).status, 2);
  const suelto = path.join(tmp('estimate-real-suelto-'), 'story-3.2-algo.md');
  fs.copyFileSync(l.spec, suelto);
  const fuera = { ...l, spec: suelto };
  stop(fuera, '3600');
  const sinGit = real(fuera, ['--run', 'r1']);
  assert.strictEqual(sinGit.status, 2, sinGit.stdout);
  assert.match(sinGit.json.reason, /--repo/);
  // con horas y sin epic: sale 2; 0 segundos no anota
  const sinEpica = path.join(l.repo, 'specs', 'story-3.7-algo.md');
  fs.writeFileSync(sinEpica, '---\nstory: "3.7"\ntitle: "Sin épica"\n---\n');
  const s7 = { ...l, spec: sinEpica };
  stop(s7, '3600');
  assert.strictEqual(real(s7, ['--run', 'r1']).status, 2);
  stop(l, '0');
  assert.deepStrictEqual([real(l, ['--run', 'r1']).json.reason], ['sin_horas']);
  assert.deepStrictEqual(lineas(l.repo), [], 'nada escrito');
  // una reapertura: dos cierres con su sha, dos líneas que el informe suma
  stop(l, '3600');
  assert.strictEqual(real(l, ['--run', 'r1']).json.ok, true);
  stop(l, '7200');
  assert.strictEqual(real(l, ['--run', 'r2']).json.ok, true);
  assert.deepStrictEqual(lineas(l.repo).map((x) => [x.valor, x.ejecucion]), [[1, 'r1'], [2, 'r2']]);
  const informe = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'lib', 'estimates.js'), 'report', '--repo', l.repo, '--story', '3.2', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: l.home }) });
  const j = JSON.parse(informe.stdout);
  assert.deepStrictEqual([j.real.horas, j.real.cierres, j.real.varios_cierres], [3, 2, true]);
  // una constancia rota: salida 3
  const dir = fs.readdirSync(l.home, { recursive: true }).map(String).filter((p) => p.includes('horas-reales') && p.endsWith('.jsonl'));
  assert.ok(dir.length, 'la constancia quedó en el estado del HOME de laboratorio');
  for (const p of dir) fs.appendFileSync(path.join(l.home, p), '{rota\n');
  const rota = real(l, ['--run', 'r3']);
  assert.strictEqual(rota.status, 3, rota.stdout);
});

// ── lo que confirmó el pase adversarial ────────────────────────────────────────────────────────────────────────────

test('Adversarial_RutaConOtraCaja_EncuentraLaConstancia @story-2.75 @ac-15', (t) => {
  const l = lab();
  const otra = l.spec.replace(`${path.sep}specs${path.sep}`, `${path.sep}SPECS${path.sep}`);
  if (!fs.existsSync(otra)) { t.skip('el disco distingue mayúsculas: no hay otra caja para la misma ruta'); return; }
  stop(l, '3600');
  const r = real({ ...l, spec: otra }, ['--run', 'r1']);
  assert.strictEqual(r.json.ok, true, r.stdout);
});

test('Adversarial_StopSinStory_ConMarcadorRelativo @story-2.75 @ac-15', () => {
  const l = lab();
  const marker = spawnSync(process.execPath, [path.join(__dirname, '..', 'marker.js'), 'set', JSON.stringify({ storyId: '3.2', storyPath: path.join('specs', 'story-3.2-algo.md'), repoPath: l.repo })],
    { cwd: l.repo, encoding: 'utf8', env: Object.assign({}, process.env, { HOME: l.home, USERPROFILE: l.home, TYCON_HOME: path.join(l.home, '.tycon'), CLAUDE_CODE_SESSION_ID: 'ses-estimate-real' }) });
  assert.strictEqual(marker.status, 0, marker.stderr);
  // el stop sin --story, desde otra carpeta: la constancia queda con la ruta de la historia, no la de la carpeta
  const env = Object.assign({}, process.env, {
    HOME: l.home, USERPROFILE: l.home, TYCON_HOME: path.join(l.home, '.tycon'), TYCON_PROFILE: '0', TYCON_GUIDES_DIR: RAIZ,
    TYCON_INTEGRATIONS_DIR: INTEGRACIONES, TYCON_TIME_TRACKING: 'fake', FAKE_STOP: '3600', CLAUDE_CODE_SESSION_ID: 'ses-estimate-real',
  });
  const s = spawnSync(process.execPath, [PIPELINE, 'work-signal', 'stop'], { cwd: l.home, env, encoding: 'utf8' });
  assert.strictEqual(s.status, 0, s.stderr);
  assert.strictEqual(real(l, ['--run', 'r1']).json.ok, true);
});

test('Adversarial_StopSinEvento_DejaConstanciaVacia @story-2.75 @ac-16', () => {
  const l = lab();
  stop(l, '10800');
  // un stop posterior sin el evento de trabajo del arnés: no informó tiempo, y eso también es la última constancia
  const sinEvento = tmp('estimate-real-sin-evento-');
  fs.mkdirSync(path.join(sinEvento, 'scripts', 'lib'), { recursive: true });
  const env = Object.assign({}, process.env, {
    HOME: l.home, USERPROFILE: l.home, TYCON_HOME: path.join(l.home, '.tycon'), TYCON_PROFILE: '0', TYCON_GUIDES_DIR: sinEvento,
    TYCON_INTEGRATIONS_DIR: INTEGRACIONES, TYCON_TIME_TRACKING: 'fake', CLAUDE_CODE_SESSION_ID: 'ses-estimate-real',
  });
  const s = spawnSync(process.execPath, [PIPELINE, 'work-signal', 'stop', '--story', l.spec, '--repo', l.repo], { cwd: l.repo, env, encoding: 'utf8' });
  assert.strictEqual(s.status, 0, s.stderr);
  const r = real(l, ['--run', 'r1']);
  assert.deepStrictEqual([r.json.ok, r.json.reason], [false, 'sin_horas'], r.stdout);
  assert.deepStrictEqual(lineas(l.repo), []);
});

test('T42 EstimateReal_HorasDelRegistro @story-2.75 @ac-15 @ac-16', () => {
  const l = lab();
  stop(l, '10800');
  // el número no se pasa a mano: sale 2 y no escribe
  const mano = real(l, ['--run', 'r1', '--hours', '99']);
  assert.strictEqual(mano.status, 2, mano.stdout);
  assert.match(mano.stderr + mano.stdout, /registro de horas/);
  assert.deepStrictEqual(lineas(l.repo), []);
  // un stop posterior sin segundos: vale la última constancia, no las 3 h viejas
  stop(l, 'none');
  const r = real(l, ['--run', 'r2']);
  assert.deepStrictEqual([r.status, r.json.ok, r.json.reason], [0, false, 'sin_horas'], r.stdout);
  assert.deepStrictEqual(lineas(l.repo), []);
});

/** La conversación de la sesión del laboratorio: el `stop` con su salida real y las llamadas que se le pasen. */
function conversacion(l, salidaStop, llamadas, { emision = `node ${PIPELINE} work-signal stop --story ${l.spec} --repo ${l.repo}`, antes = [] } = {}) {
  const dir = path.join(l.home, '.claude', 'projects', 'repo');
  fs.mkdirSync(dir, { recursive: true });
  let padre = null;
  let n = 0;
  const regs = [];
  const poner = (r) => { const uuid = `u${++n}`; regs.push({ ...r, uuid, parentUuid: padre, sessionId: 'ses-estimate-real' }); padre = uuid; };
  const pasos = [...antes, ['Bash', { command: emision }, salidaStop], ...llamadas];
  pasos.forEach(([name, input, resultado, err], i) => {
    poner({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `p${i}`, name, input }] } });
    poner({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `p${i}`, content: resultado, ...(err ? { is_error: true } : {}) }] } });
  });
  fs.writeFileSync(path.join(dir, 'ses-estimate-real.jsonl'), regs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('EstimateReal_AccionConConstancia @story-2.75 @ac-15 @ac-16', () => {
  const CERRADA = JSON.stringify({ id: 'entry-4242', start: '2026-10-29T10:00:00Z', end: '2026-10-29T12:30:00Z' });
  const accion = (l) => {
    const s = stop(l, 'action-id');
    assert.strictEqual(s.status, 0, s.stderr);
    assert.match(s.stderr, /--action-done/, 'el stop con acción dice cómo dejar las horas');
    return s.stdout.trim();
  };
  const cerrar = (l, extra) => correr(l, ['work-signal', 'stop', '--story', l.spec, '--action-done', 'entry-4242'], 'action-id', extra);

  // la llamada que cerró la entrada trae su intervalo: 2,5 h con constancia, y estimate-real las anota
  let l = lab();
  conversacion(l, accion(l), [['mcp__fake__cerrar', { id: 'entry-4242' }, CERRADA]],
    { antes: [['mcp__fake__abrir', {}, JSON.stringify({ id: 'entry-4242', start: '2026-10-29T07:00:00-03:00', end: '2026-10-29T07:00:00-03:00' })]] });
  let r = cerrar(l);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual([r.json.recorded, r.json.seconds, r.json.herramienta], [true, 9000, 'mcp__fake__cerrar']);
  const e = real(l, ['--run', 'r1']);
  assert.strictEqual(e.json.ok, true, e.stdout + e.stderr);
  assert.deepStrictEqual(lineas(l.repo).map((x) => [x.nivel, x.valor]), [['real', 2.5]]);

  // lo que no es constancia: no anota, sale 1 y estimate-real sigue sin horas
  const casos = [
    ['sin la llamada', (x) => conversacion(x, accion(x), [])],
    ['otra entrada, más larga', (x) => conversacion(x, accion(x), [['mcp__fake__cerrar', {}, JSON.stringify({ id: 'entry-9999', start: '2026-10-01T00:00:00Z', end: '2026-10-29T00:00:00Z' })]]), 'entry-9999'],
    ['sin el intervalo', (x) => conversacion(x, accion(x), [['mcp__fake__cerrar', {}, '{"id":"entry-4242"}']])],
    ['un resultado con error', (x) => conversacion(x, accion(x), [['mcp__fake__cerrar', {}, CERRADA, true]])],
    ['otra herramienta', (x) => conversacion(x, accion(x), [['mcp__memoria__guardar', {}, CERRADA]])],
    ['un stop que sólo se nombra', (x) => conversacion(x, accion(x), [['mcp__fake__cerrar', {}, CERRADA]], { emision: `echo "node pipeline.js work-signal stop"` })],
    ['Codex', (x) => conversacion(x, accion(x), [['mcp__fake__cerrar', {}, CERRADA]]), null, { CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: 'ses-estimate-real' }],
    // otra entrada de una semana que sólo nombra el id en su descripción
    ['otra entrada que nombra el id', (x) => conversacion(x, accion(x), [['mcp__fake__crear', {}, JSON.stringify({ id: 'entry-1111', description: 'entry-4242', start: '2026-10-22T10:00:00Z', end: '2026-10-29T10:00:00Z' })]])],
    // el inicio con que se abrió en esta conversación no se mueve al cerrar
    ['el inicio movido al cerrar', (x) => {
      const abrir = ['mcp__fake__abrir', {}, JSON.stringify({ id: 'entry-4242', start: '2026-10-29T10:00:00Z', end: '2026-10-29T10:00:00Z' })];
      const s = accion(x);
      conversacion(x, s, [['mcp__fake__cerrar', {}, JSON.stringify({ id: 'entry-4242', start: '2026-10-20T10:00:00Z', end: '2026-10-29T12:30:00Z' })]], { antes: [abrir] });
    }],
    // el stop fue de otra historia
    ['el stop de otra historia', (x) => conversacion(x, accion(x), [['mcp__fake__cerrar', {}, CERRADA]], { emision: `node ${PIPELINE} work-signal stop --story ${path.join(x.repo, 'specs', 'otra.md')} --repo ${x.repo}` })],
  ];
  for (const [caso, armar, id, extra] of casos) {
    l = lab();
    armar(l);
    r = id ? correr(l, ['work-signal', 'stop', '--story', l.spec, '--action-done', id], 'action-id') : cerrar(l, extra);
    assert.strictEqual(r.status, 1, `${caso}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /no anoto horas/, caso);
    const x = real(l, ['--run', 'r1']);
    assert.deepStrictEqual([x.json.ok, x.json.reason], [false, 'sin_horas'], caso);
    assert.deepStrictEqual(lineas(l.repo), [], `${caso}: nada escrito`);
  }
});
