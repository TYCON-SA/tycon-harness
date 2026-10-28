'use strict';
/**
 * adversarial-skip-signed.test.js — el pase adversarial no se saltea sin una constancia firmada por el dueño.
 *
 * Todo pedido de saltear (la bandera, la variable, `deep_review: off`, `set-size liviana` con código) es un pedido: sin
 * constancia el pase corre, y el pedido anota la muestra que el dueño firma en la ventana o en su terminal
 * (`marker.js sign-adversarial-skip`). La constancia vale para una ejecución y la ata su renglón en el `gates.log` de la
 * casa de la cuenta.
 *
 * Todo en proceso: la casa, el árbol de procesos, la terminal y la hora se pasan como parámetros. Ninguna prueba finge
 * la constancia por el ambiente; las de subproceso sólo prueban la dirección segura (sin constancia, el pase corre), y
 * las que cambian `HOME` lo hacen para probar que no cuenta.
 *
 * Un árbol es una lista `{ pid, ppid, inicio, comando }`. El del freno: la herramienta (100), el freno (200) y su
 * consulta (201). El del guion: la herramienta (100), la consola con la envoltura medida (300) y el guion (301).
 *
 * stable-data: las horas son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const MARKER = path.join(SCRIPTS, 'marker.js');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const sk = require('../lib/adversarial-skip.js');
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
const { SIGNATURES } = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
const pipeline = require('../pipeline.js');
const roster = require('../lib/review-roster.js');

const AHORA = Date.parse('2026-10-27T13:00:00Z');
const INICIO = 'Tue Oct 27 10:00:00 2026';
const EJECUCION = '2026-10-27T12:00:00.000Z';
const DEL_ENTORNO = ['TYCON_NO_DEEP_REVIEW', 'DOD_BYPASS', 'TYCON_5B_EARLY', 'CLAUDE_CODE_SESSION_ID', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_TEST_CONTEXT'];

function carpetaTemporal(t, prefijo) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefijo));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** La casa de la cuenta de la prueba, con el marcador de la sesión `ses-a` (de ahí sale la story del texto de la ventana). */
function casaNueva(t) {
  const casa = carpetaTemporal(t, 'adv-skip-casa-');
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  fs.writeFileSync(path.join(activos, 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', storyPath: '/r/specs/story-9.99.md' }));
  return casa;
}

const gates = (casa) => { try { return fs.readFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'gates.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
const lineas = (carpeta, archivo = sk.FILE) => { try { return fs.readFileSync(path.join(carpeta, archivo), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };

/** Un repo de juguete con su story y la carpeta de la ejecución. `docs`: la story declara sólo documentación. */
function repoNuevo(t, { docs = false, codigo = false } = {}) {
  const repo = carpetaTemporal(t, 'adv-skip-repo-');
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  const scope = docs ? ['files_to_create: []', 'files_to_modify:', '  - README.md']
    : codigo ? ['files_to_create: []', 'files_to_modify:', '  - src/a.js'] : [];
  const story = path.join(repo, 'specs', 'story-9.99.md');
  fs.writeFileSync(story, ['---', 'story: "9.99"', 'epic: 9', 'status: in-progress', ...scope, '---', '', '## Acceptance Criteria', '1. x', ''].join('\n'));
  const carpeta = path.join(repo, '.advisors', 'pipeline-runs', '9.99-20261027120000');
  fs.mkdirSync(carpeta, { recursive: true });
  return { repo, story, carpeta };
}

const herramienta = () => ({ pid: 100, ppid: 1, inicio: INICIO, comando: '/Applications/x/native-binary/claude --output-format stream-json --verbose' });
const BASE = [{ pid: 1, ppid: 0, inicio: 'Mon Oct 26 08:00:00 2026', comando: '/sbin/launchd' }];
function envolver(casa, cmd) {
  return `/bin/zsh -c source ${casa}/.claude/shell-snapshots/snapshot-zsh-1793030721191-z5n7vi.sh 2>/dev/null || true`
    + ' && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true'
    + " && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true"
    + ` && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-b725-cwd`;
}
const arbolDelFreno = () => [...BASE, herramienta(),
  { pid: 200, ppid: 100, inicio: INICIO, comando: '/bin/bash /h/scripts/hooks/safety-guard-pre.sh' },
  { pid: 201, ppid: 200, inicio: INICIO, comando: 'node /h/scripts/lib/owner-window.js gate' }];
const arbolDelGuion = (casa, cmd, consola) => [...BASE, herramienta(),
  { pid: 300, ppid: 100, inicio: INICIO, comando: consola || envolver(casa, cmd) },
  { pid: 301, ppid: 300, inicio: INICIO, comando: cmd }];
const evento = (command) => ({ session_id: 'ses-a', tool_use_id: 'toolu_01', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const pedir = (casa, cmd, escapes = []) => ow.decidir({ evento: evento(cmd), escapes, arbol: arbolDelFreno(), pid: 201, casa, ahora: AHORA });

const MOTIVO = 'sólo cambia un texto de ayuda';
const firmaCmd = (motivo = MOTIVO, extra = '') => `node ${MARKER} sign-adversarial-skip --story 9.99 --reason "${motivo}"${extra}`;
const firmaArgv = (motivo = MOTIVO, extra = []) => [MARKER, 'sign-adversarial-skip', '--story', '9.99', '--reason', motivo, ...extra];
const TTY_FIRMA = { windows: false, hay: () => true, preguntar: () => 'firmo' };

/** La muestra de la ejecución de la prueba, anotada en la casa. */
function mostrar(casa, carpeta, camino = '--no-deep-review', ahora = AHORA - 60000) {
  return sk.muestra({ story: '9.99', carpeta, ejecucion: EJECUCION, camino, casa, ahora });
}

/** Firma el salteo por la ventana: el freno anota el pedido y el guion lo consume. Devuelve lo de `firmarSalteo`. */
function firmarPorVentana(casa, { motivo = MOTIVO } = {}) {
  const cmd = firmaCmd(motivo);
  const r = pedir(casa, cmd);
  assert.strictEqual(r.decision, 'ask', r.texto);
  return sk.firmarSalteo({
    story: '9.99', motivo, argv: firmaArgv(motivo), sesion: 'ses-a', casa, ahora: AHORA, maquina: 'mmmmmmmmmmmmmmmm',
    exigir: (o) => ow.exigir({ ...o, pid: 301, arbol: arbolDelGuion(casa, cmd), ahora: AHORA }),
  });
}

function firmarPorTerminal(casa, { motivo = MOTIVO, tty = TTY_FIRMA } = {}) {
  return sk.firmarSalteo({
    story: '9.99', motivo, argv: firmaArgv(motivo, ['--terminal']), sesion: null, casa, ahora: AHORA, maquina: 'mmmmmmmmmmmmmmmm',
    exigir: (o) => ow.exigir({ ...o, tty, ahora: AHORA }),
  });
}

const corridaDe = (repo, story) => ({ sessionId: 'ses-a', storyId: '9.99', storyPath: story, repoPath: repo, startedAt: EJECUCION });
const portón = (args, { casa, corrida }) => pipeline.deepReviewGateDeLaCorrida({ args: { files: [], filesDeclarado: true, ...args }, corrida, casa, mostrar: true });

// ── El catálogo y la ventana ────────────────────────────────────────────────────────────────────────────────────────

test('AdversarialSkip_Catalogo_ElComandoEsFirmaGuion (T56)', (t) => {
  const s = SIGNATURES.find((x) => x.id === 'adversarial-skip');
  assert.match(s.command, /^marker\.js sign-adversarial-skip\b/);
  assert.doesNotMatch(s.command, /todavía no existe/);
  assert.strictEqual(s.kind, 'guion');
  assert.strictEqual(s.otherSession, 'no');
  assert.match(s.terminal, /marker\.js sign-adversarial-skip .*--terminal/);
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'firmas-del-arnes.md'), 'utf8');
  assert.doesNotMatch(guia, /sign-adversarial-skip \(todavía no existe\)/, 'la guía trae el comando real');
  // la forma canónica pide la ventana
  const casa = casaNueva(t);
  const r = pedir(casa, firmaCmd());
  assert.strictEqual(r.decision, 'ask', r.texto);
  assert.deepStrictEqual(r.firmas, ['adversarial-skip']);
  // la escondida no tiene forma canónica, y con --quote se niega sin preguntar
  const escondida = `cd /r && ${firmaCmd()}`;
  assert.notStrictEqual(pedir(casaNueva(t), escondida).decision, 'ask', 'escondida detrás de cd no pide la ventana');
  const conCita = pedir(casaNueva(t), firmaCmd(MOTIVO, ' --quote "dale"'));
  assert.notStrictEqual(conCita.decision, 'ask', 'con --quote no pide la ventana');
  // el guion corrido desde un node -e no pasa por la ventana
  const casa2 = casaNueva(t);
  pedir(casa2, firmaCmd());
  const v = ow.verificar({ firma: 'adversarial-skip', argv: firmaArgv(), pid: 301, arbol: arbolDelGuion(casa2, firmaCmd(), `node -e "require('child_process').execSync('${firmaCmd()}')"`), casa: casa2, ahora: AHORA });
  assert.strictEqual(v.ok, false, 'escondida en node -e no verifica');
});

// ── La muestra y la firma ───────────────────────────────────────────────────────────────────────────────────────────

test('AdversarialSkip_FirmaPorTerminal_EscribeEnOrden (T2)', async (t) => {
  await t.test('por la ventana: renglón, línea y aprobación, en ese orden', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    const orden = [];
    const r = sk.firmarSalteo({
      story: '9.99', motivo: MOTIVO, argv: firmaArgv(), sesion: 'ses-a', casa, ahora: AHORA, maquina: 'mmmmmmmmmmmmmmmm',
      exigir: (o) => {
        pedir(casa, firmaCmd());
        orden.push(lineas(carpeta).length ? 'linea-antes-del-renglon' : 'renglon');
        return ow.exigir({ ...o, pid: 301, arbol: arbolDelGuion(casa, firmaCmd()), ahora: AHORA });
      },
      aprobar: () => orden.push(lineas(carpeta).length ? 'aprobacion' : 'aprobacion-sin-linea'),
    });
    assert.strictEqual(r.codigo, 0, r.motivo);
    assert.deepStrictEqual(orden, ['renglon', 'aprobacion']);
    const [l] = lineas(carpeta);
    assert.strictEqual(l.via, 'ventana');
    assert.strictEqual(l.quien, 'dueño');
    assert.strictEqual(l.story, '9.99');
    assert.strictEqual(l.carpeta, sk.carpetaReal(carpeta));
    assert.strictEqual(l.ejecucion, EJECUCION);
    assert.strictEqual(l.camino, '--no-deep-review');
    assert.strictEqual(l.motivo, MOTIVO);
    assert.strictEqual(l.maquina, 'mmmmmmmmmmmmmmmm');
    assert.strictEqual(l.huella, sk.huella(l));
    const firmado = gates(casa).filter((g) => g.name === 'adversarial-skip-signed');
    assert.strictEqual(firmado.length, 1);
    assert.strictEqual(firmado[0].via, 'ventana');
    assert.ok(firmado[0].resumen.startsWith(`huella ${l.huella} `), firmado[0].resumen);
  });
  await t.test('la aprobación de siempre queda en approvals.jsonl', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    assert.strictEqual(firmarPorVentana(casa).codigo, 0);
    const [a] = lineas(carpeta, 'approvals.jsonl');
    assert.ok(a, 'hay línea en approvals.jsonl');
    assert.strictEqual(a.tipo, 'manual');
    assert.match(a.que, /pase adversarial/);
  });
  await t.test('por la terminal: vía terminal', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    const r = firmarPorTerminal(casa);
    assert.strictEqual(r.codigo, 0, r.motivo);
    assert.strictEqual(lineas(carpeta)[0].via, 'terminal');
    assert.strictEqual(gates(casa).filter((g) => g.name === 'adversarial-skip-signed')[0].via, 'terminal');
  });
  await t.test('sin la ventana ni la terminal no escribe nada', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    const r = sk.firmarSalteo({ story: '9.99', motivo: MOTIVO, argv: firmaArgv(), sesion: 'ses-a', casa, ahora: AHORA,
      exigir: (o) => ow.exigir({ ...o, pid: 301, arbol: arbolDelGuion(casa, firmaCmd()), ahora: AHORA }) });
    assert.strictEqual(r.codigo, 1);
    assert.deepStrictEqual(lineas(carpeta), []);
    assert.deepStrictEqual(gates(casa).filter((g) => g.name === 'adversarial-skip-signed'), []);
    // sin terminal sale 2 (AC 4)
    const r2 = firmarPorTerminal(casa, { tty: { windows: false, hay: () => false, preguntar: () => 'firmo' } });
    assert.strictEqual(r2.codigo, 2);
    // la terminal que no firma
    assert.strictEqual(firmarPorTerminal(casa, { tty: { windows: false, hay: () => true, preguntar: () => 'no' } }).codigo, 1);
    assert.deepStrictEqual(lineas(carpeta), []);
  });
  await t.test('--quote, --relayed-by y --ok se niegan sin preguntar', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    for (const b of [['--quote', 'dale'], ['--relayed-by', 'coordinadora'], ['--ok']]) {
      let llamado = false;
      const r = sk.firmarSalteo({ story: '9.99', motivo: MOTIVO, argv: firmaArgv(MOTIVO, b), casa, ahora: AHORA, exigir: () => { llamado = true; return { codigo: 0, via: 'ventana' }; } });
      assert.strictEqual(r.codigo, 1, b[0]);
      assert.strictEqual(llamado, false, `${b[0]}: no pide la firma`);
    }
    assert.deepStrictEqual(lineas(carpeta), []);
  });
  await t.test('sin muestra sale 1 sin escribir nada', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    let llamado = false;
    const r = sk.firmarSalteo({ story: '9.99', motivo: MOTIVO, argv: firmaArgv(), casa, ahora: AHORA, exigir: () => { llamado = true; return { codigo: 0 }; } });
    assert.strictEqual(r.codigo, 1);
    assert.match(r.motivo, /muestra|pedido/);
    assert.strictEqual(llamado, false);
    assert.deepStrictEqual(lineas(carpeta), []);
    // la muestra de otra story no sirve
    sk.muestra({ story: '9.98', carpeta, ejecucion: EJECUCION, camino: '--no-deep-review', casa, ahora: AHORA - 1000 });
    assert.strictEqual(sk.firmarSalteo({ story: '9.99', motivo: MOTIVO, argv: firmaArgv(), casa, ahora: AHORA, exigir: () => ({ codigo: 0 }) }).codigo, 1);
  });
  await t.test('con dos muestras vale la última', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta, '--no-deep-review', AHORA - 120000);
    mostrar(casa, carpeta, 'deep_review: off', AHORA - 60000);
    assert.strictEqual(firmarPorTerminal(casa).codigo, 0);
    assert.strictEqual(lineas(carpeta)[0].camino, 'deep_review: off');
  });
});

test('AdversarialSkip_RegistroNoSeEscribe_NoFirma (T16)', async (t) => {
  await t.test('una línea vieja ilegible: no firma', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    fs.writeFileSync(path.join(carpeta, sk.FILE), '{roto\n');
    let llamado = false;
    const r = sk.firmarSalteo({ story: '9.99', motivo: MOTIVO, argv: firmaArgv(MOTIVO, ['--terminal']), casa, ahora: AHORA, exigir: () => { llamado = true; return { codigo: 0, via: 'terminal' }; } });
    assert.notStrictEqual(r.codigo, 0);
    assert.strictEqual(llamado, false);
    assert.strictEqual(fs.readFileSync(path.join(carpeta, sk.FILE), 'utf8'), '{roto\n');
  });
  await t.test('el renglón no quedó: la línea no se escribe', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    // una firma que dice que firmó y no dejó su renglón
    const r = sk.firmarSalteo({ story: '9.99', motivo: MOTIVO, argv: firmaArgv(MOTIVO, ['--terminal']), casa, ahora: AHORA, exigir: () => ({ codigo: 0, via: 'terminal' }) });
    assert.strictEqual(r.codigo, 2);
    assert.match(r.motivo, /registro|renglón/);
    assert.deepStrictEqual(lineas(carpeta), []);
  });
  await t.test('gates.log que no se escribe: no firma', (tt) => {
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) { tt.skip('los permisos de sólo lectura no frenan a root ni en Windows'); return; }
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt);
    mostrar(casa, carpeta);
    const log = path.join(casa, '.claude', '.tycon-pipeline', 'gates.log');
    fs.chmodSync(log, 0o444);
    tt.after(() => { try { fs.chmodSync(log, 0o644); } catch (_) { /* la casa ya se borró */ } });
    const r = firmarPorTerminal(casa);
    assert.notStrictEqual(r.codigo, 0);
    assert.deepStrictEqual(lineas(carpeta), []);
  });
});

// ── Lo que vale y lo que no ─────────────────────────────────────────────────────────────────────────────────────────

function firmadaEn(t) {
  const casa = casaNueva(t);
  const { repo, story, carpeta } = repoNuevo(t);
  mostrar(casa, carpeta);
  assert.strictEqual(firmarPorTerminal(casa).codigo, 0);
  return { casa, repo, story, carpeta };
}

test('AdversarialSkip_ConstanciaAjena_NoVale (T8)', (t) => {
  const { casa, carpeta } = firmadaEn(t);
  assert.strictEqual(sk.vigente({ story: '9.99', carpeta, ejecucion: EJECUCION, casa }).ok, true);
  const otraStory = sk.vigente({ story: '9.98', carpeta, ejecucion: EJECUCION, casa });
  assert.strictEqual(otraStory.ok, false);
  assert.match(otraStory.motivo, /otra story/);
  const cerrada = sk.vigente({ story: '9.99', carpeta, ejecucion: '2026-10-28T09:00:00.000Z', casa });
  assert.strictEqual(cerrada.ok, false);
  assert.match(cerrada.motivo, /ejecución (ya )?cerrada/);
  // la línea copiada a la carpeta de otra ejecución
  const otra = path.join(path.dirname(carpeta), '9.99-20261028090000');
  fs.mkdirSync(otra);
  fs.copyFileSync(path.join(carpeta, sk.FILE), path.join(otra, sk.FILE));
  const copiada = sk.vigente({ story: '9.99', carpeta: otra, ejecucion: EJECUCION, casa });
  assert.strictEqual(copiada.ok, false);
  assert.match(copiada.motivo, /otra ejecución/);
});

test('AdversarialSkip_LineaSinRenglon_NoVale (T17)', (t) => {
  const casa = casaNueva(t);
  const { carpeta } = repoNuevo(t);
  const l = { ts: new Date(AHORA).toISOString(), story: '9.99', carpeta, ejecucion: EJECUCION, camino: '--no-deep-review', motivo: MOTIVO, via: 'terminal', quien: 'dueño', maquina: 'm' };
  l.huella = sk.huella(l);
  fs.writeFileSync(path.join(carpeta, sk.FILE), `${JSON.stringify(l)}\n`);
  const v = sk.vigente({ story: '9.99', carpeta, ejecucion: EJECUCION, casa });
  assert.strictEqual(v.ok, false);
  assert.match(v.motivo, /registro/);
});

test('AdversarialSkip_HuellaCompleta_CualquierCampoLaRompe (T40)', (t) => {
  const { casa, carpeta } = firmadaEn(t);
  const [l] = lineas(carpeta);
  const cambios = { story: '9.99 ', carpeta: `${carpeta}/`, ejecucion: '2026-10-27T12:00:00.001Z', camino: 'deep_review: off', motivo: 'otro', ts: '2026-10-27T13:00:01.000Z', via: 'ventana', quien: 'agente' };
  for (const [k, v] of Object.entries(cambios)) {
    fs.writeFileSync(path.join(carpeta, sk.FILE), `${JSON.stringify({ ...l, [k]: v })}\n`);
    // la carpeta y la ejecución se piden iguales a las de la corrida, la story también: se pregunta con lo que trae la línea
    const r = sk.vigente({ story: k === 'story' ? v : '9.99', carpeta: k === 'carpeta' ? v : carpeta, ejecucion: k === 'ejecucion' ? v : EJECUCION, casa });
    assert.strictEqual(r.ok, false, `${k} cambiado`);
  }
  for (const k of ['story', 'carpeta']) {
    const nula = { ...l, [k]: null };
    nula.huella = sk.huella(nula);
    fs.writeFileSync(path.join(carpeta, sk.FILE), `${JSON.stringify(nula)}\n`);
    assert.strictEqual(sk.vigente({ story: k === 'story' ? null : '9.99', carpeta: k === 'carpeta' ? null : carpeta, ejecucion: EJECUCION, casa }).ok, false, `${k} nulo`);
  }
});

// ── El portón ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('AdversarialSkip_PedidoSinConstancia_ElPaseCorreYMuestra (T1)', (t) => {
  const casa = casaNueva(t);
  const { repo, story, carpeta } = repoNuevo(t);
  const r = portón({ repo, story, noDeepReview: true, noDeepReviewFrom: '--no-deep-review' }, { casa, corrida: corridaDe(repo, story) });
  assert.strictEqual(r.result.run, true, r.result.reason);
  assert.match(r.result.reason, /pedido/);
  const [m] = gates(casa).filter((g) => g.name === 'adversarial-skip-shown');
  assert.ok(m, 'anotó la muestra');
  assert.strictEqual(m.story, '9.99');
  assert.strictEqual(m.carpeta, sk.carpetaReal(carpeta));
  assert.strictEqual(m.ejecucion, EJECUCION);
  assert.strictEqual(m.camino, '--no-deep-review');
  assert.match(m.huella, /^[0-9a-f]{8,16}$/);
  assert.match(r.texto, /sign-adversarial-skip --story 9\.99 --reason/);
  assert.match(r.texto, /--terminal/);
  assert.deepStrictEqual(r.result.sign_commands.length, 2);
});

test('AdversarialSkip_ConConstancia_SalteaYLoNombra (T3)', (t) => {
  const { casa, repo, story } = firmadaEn(t);
  for (const pedido of [{ noDeepReview: true, noDeepReviewFrom: '--no-deep-review' }, {}]) {
    const r = portón({ repo, story, ...pedido }, { casa, corrida: corridaDe(repo, story) });
    assert.strictEqual(r.result.run, false, JSON.stringify(pedido));
    assert.match(r.result.reason, /constancia/);
    assert.match(r.result.reason, /terminal/);
    assert.strictEqual(r.result.adversarial_skip.via, 'terminal');
    assert.strictEqual(r.result.adversarial_skip.quien, 'dueño');
    assert.ok(r.result.adversarial_skip.cuando);
    assert.match(r.result.adversarial_skip.huella, /^[0-9a-f]{16}$/);
  }
  // mark-adversarial-skipped anota `firmado` en lugar de `forzado`
  const r = portón({ repo, story }, { casa, corrida: corridaDe(repo, story) });
  const salteo = sk.salteoDelPorton(r.result, { archivos: 0, abandonado: false, runId: null, at: new Date(AHORA).toISOString() });
  assert.deepStrictEqual(Object.keys(salteo.firmado).sort(), ['cuando', 'huella', 'quien', 'via']);
  assert.strictEqual('forzado' in salteo, false);
});

test('AdversarialSkip_DeepReviewOff_EsUnPedido (T6)', (t) => {
  const casa = casaNueva(t);
  const { repo, story } = repoNuevo(t);
  fs.mkdirSync(path.join(repo, '.tycon'));
  fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), 'deep_review: off\n');
  const r = portón({ repo, story }, { casa, corrida: corridaDe(repo, story) });
  assert.strictEqual(r.result.run, true, r.result.reason);
  assert.match(r.result.reason, /deep_review: off/);
  assert.match(r.result.reason, /pedido/);
  assert.strictEqual(gates(casa).filter((g) => g.name === 'adversarial-skip-shown')[0].camino, 'deep_review: off');
  // commiteado o no, lo mismo: el portón lee el archivo
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=prueba', '-c', 'user.email=prueba@ejemplo.test', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  for (const a of [['init', '-q'], ['add', '.tycon/advisors.yaml'], ['commit', '-q', '--no-verify', '-m', 'deep_review off']]) {
    const g = git(...a);
    assert.strictEqual(g.status, 0, g.stderr);
  }
  assert.strictEqual(git('ls-files', '--error-unmatch', '.tycon/advisors.yaml').status, 0, 'quedó commiteado');
  const commiteado = portón({ repo, story }, { casa, corrida: corridaDe(repo, story) }).result;
  assert.strictEqual(commiteado.run, true, commiteado.reason);
  assert.match(commiteado.reason, /deep_review: off/);
  // run-size sigue sin tomar `off` como salteo (sólo lee `always`)
  const { repo: r2, story: s2 } = repoNuevo(t, { codigo: true });
  fs.mkdirSync(path.join(r2, '.tycon'));
  fs.writeFileSync(path.join(r2, '.tycon', 'advisors.yaml'), 'deep_review: off\n');
  assert.notStrictEqual(pipeline.computeRunSize({ repo: r2, story: s2 }).size, 'liviana');
});

test('AdversarialSkip_SalteoDeLaMaquina_SinFirma (T22)', (t) => {
  const casa = casaNueva(t);
  const { repo, story } = repoNuevo(t, { docs: true });
  const r = portón({ repo, story }, { casa, corrida: corridaDe(repo, story) });
  assert.strictEqual(r.result.run, false);
  assert.strictEqual(r.result.risk, 'liviana');
  assert.strictEqual(r.result.adversarial_skip, undefined, 'el salteo de la máquina no trae constancia');
  assert.deepStrictEqual(gates(casa).filter((g) => g.name === 'adversarial-skip-shown'), [], 'sin pedido no hay muestra');
});

test('AdversarialSkip_CasaFalsa_NoVale (T38)', (t) => {
  // la casa falsa tiene todo firmado; la de la cuenta, nada
  const { casa: falsa, repo, story } = firmadaEn(t);
  const real = casaNueva(t);
  const antes = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = falsa;
  process.env.USERPROFILE = falsa;
  t.after(() => { for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const r = pipeline.deepReviewGateDeLaCorrida({ args: { repo, story, files: [], filesDeclarado: true, noDeepReview: true, noDeepReviewFrom: '--no-deep-review' },
    corrida: corridaDe(repo, story), userInfo: () => ({ homedir: real }), mostrar: true });
  assert.strictEqual(r.result.run, true, 'con HOME a la casa falsa, la constancia no vale');
  assert.match(r.result.reason, /registro/);
});

test('AdversarialSkip_SegundaCapaYNegativos (T23)', (t) => {
  // los escapes siguen pidiendo la ventana (8.139 B)
  const casa = casaNueva(t);
  const r = pedir(casa, `node ${PIPELINE} deep-review-gate --no-deep-review --files a.js`, ['escape:no-deep-review']);
  assert.strictEqual(r.decision, 'ask', r.texto);
  // el «Sí» del escape no saltea sin constancia
  const { repo, story } = repoNuevo(t);
  const g = portón({ repo, story, noDeepReview: true, noDeepReviewFrom: '--no-deep-review' }, { casa, corrida: corridaDe(repo, story) });
  assert.strictEqual(g.result.run, true);
  // sin corrida no hay constancia posible: el pase corre igual y lo dice
  const sinCorrida = portón({ repo, story, noDeepReview: true, noDeepReviewFrom: 'TYCON_NO_DEEP_REVIEW=1' }, { casa, corrida: null });
  assert.strictEqual(sinCorrida.result.run, true);
  // la función pura, sin la constancia inyectada, nunca saltea por el pedido
  assert.strictEqual(pipeline.computeDeepReviewGate({ repo, story, files: [], noDeepReview: true }).run, true);
});

// ── Los consumidores de marker.js ───────────────────────────────────────────────────────────────────────────────────

function entornoLimpio(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TYCON_SESSION_ID: 'ses-sub' };
  for (const k of DEL_ENTORNO) if (k !== 'TYCON_SESSION_ID') delete env[k];
  return env;
}
function marcadorEn(home, repo, story) {
  const activos = path.join(home, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  const m = { sessionId: 'ses-sub', storyId: '9.99', storyPath: story, repoPath: repo, startedAt: EJECUCION, stepsCompleted: [], schema: 2 };
  fs.writeFileSync(path.join(activos, 'ses-sub.json'), JSON.stringify(m));
  return path.join(activos, 'ses-sub.json');
}

test('AdversarialSkip_SetSizeLivianaConCodigo_PideFirma (T7)', async (t) => {
  await t.test('set-size liviana con código, sin constancia: sale 1 sin cambiar el tamaño', (tt) => {
    const home = carpetaTemporal(tt, 'adv-skip-home-');
    const { repo, story } = repoNuevo(tt, { codigo: true });
    const mk = marcadorEn(home, repo, story);
    const r = spawnSync(process.execPath, [MARKER, 'set-size', 'liviana', '--reason', 'apuro'], { encoding: 'utf8', env: entornoLimpio(home) });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /sign-adversarial-skip/);
    assert.match(r.stderr, /--terminal/);
    assert.strictEqual(JSON.parse(fs.readFileSync(mk, 'utf8')).size, undefined, 'el tamaño no cambió');
  });
  await t.test('set-size liviana sin código declarado: como hoy', (tt) => {
    const home = carpetaTemporal(tt, 'adv-skip-home-');
    const { repo, story } = repoNuevo(tt, { docs: true });
    const mk = marcadorEn(home, repo, story);
    const r = spawnSync(process.execPath, [MARKER, 'set-size', 'liviana', '--reason', 'sólo docs'], { encoding: 'utf8', env: entornoLimpio(home) });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(mk, 'utf8')).size, 'liviana');
  });
  await t.test('la muestra y la constancia, en proceso', (tt) => {
    const casa = casaNueva(tt);
    const { carpeta } = repoNuevo(tt, { codigo: true });
    const p = sk.pedirFirma({ story: '9.99', carpeta, ejecucion: EJECUCION, camino: 'set-size liviana', casa, ahora: AHORA });
    assert.strictEqual(p.ok, false);
    assert.match(p.texto, /sign-adversarial-skip/);
    assert.strictEqual(gates(casa).filter((g) => g.name === 'adversarial-skip-shown')[0].camino, 'set-size liviana');
    assert.strictEqual(firmarPorTerminal(casa).codigo, 0);
    assert.strictEqual(sk.pedirFirma({ story: '9.99', carpeta, ejecucion: EJECUCION, camino: 'set-size liviana', casa, ahora: AHORA }).ok, true);
  });
  await t.test('mark-adversarial-skipped con el pedido y sin constancia: sale 2 con los comandos', (tt) => {
    const home = carpetaTemporal(tt, 'adv-skip-home-');
    const { repo, story } = repoNuevo(tt);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
    const mk = marcadorEn(home, repo, story);
    for (const [args, env] of [[['--no-deep-review'], {}], [[], { TYCON_NO_DEEP_REVIEW: '1' }]]) {
      const r = spawnSync(process.execPath, [MARKER, 'mark-adversarial-skipped', ...args, '--files', 'src/a.js'], { encoding: 'utf8', env: { ...entornoLimpio(home), ...env } });
      assert.strictEqual(r.status, 2, r.stderr);
      assert.match(r.stderr, /sign-adversarial-skip/);
      const m = JSON.parse(fs.readFileSync(mk, 'utf8'));
      assert.strictEqual(m.adversarialSkip, undefined, 'no anotó el salteo');
      assert.notStrictEqual(m.deepReviewDone, true);
    }
  });
});

test('AdversarialSkip_VariableDelAmbiente_EsUnPedido (T5)', (t) => {
  const home = carpetaTemporal(t, 'adv-skip-home-');
  const { repo, story } = repoNuevo(t);
  marcadorEn(home, repo, story);
  const r = spawnSync(process.execPath, [PIPELINE, 'deep-review-gate', '--repo', repo, '--story', story, '--files'],
    { encoding: 'utf8', env: { ...entornoLimpio(home), TYCON_NO_DEEP_REVIEW: '1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.strictEqual(v.run, true, v.reason);
  assert.match(v.reason, /TYCON_NO_DEEP_REVIEW=1/);
  assert.match(v.reason, /pedido/);
  assert.match(r.stderr, /sign-adversarial-skip/);
  // start: la variable es un pedido, y lo dice con los comandos
  const s = spawnSync(process.execPath, [PIPELINE, 'start', '--repo', repo, '--story', story],
    { encoding: 'utf8', env: { ...entornoLimpio(home), TYCON_NO_DEEP_REVIEW: '1' } });
  assert.match(s.stderr, /TYCON_NO_DEEP_REVIEW=1 es un pedido/);
  assert.match(s.stderr, /sign-adversarial-skip/);
});

// ── Los cierres y el registro de autoría ────────────────────────────────────────────────────────────────────────────

test('AdversarialSkip_CierresReverifican (T18)', (t) => {
  const { casa, carpeta } = firmadaEn(t);
  const [l] = lineas(carpeta);
  const marker = { storyId: '9.99', startedAt: EJECUCION, adversarialSkip: { firmado: { via: l.via, quien: l.quien, cuando: l.ts, huella: l.huella } } };
  assert.strictEqual(sk.reverificar({ marker, carpeta, casa }), null, 'la constancia se sostiene');
  // un marcador sin salteo firmado no pide nada
  assert.strictEqual(sk.reverificar({ marker: { storyId: '9.99', startedAt: EJECUCION }, carpeta, casa }), null);
  // la línea cambiada después
  fs.writeFileSync(path.join(carpeta, sk.FILE), `${JSON.stringify({ ...l, motivo: 'otro' })}\n`);
  assert.match(String(sk.reverificar({ marker, carpeta, casa })), /no vale|huella/);
  // el registro borrado
  fs.writeFileSync(path.join(carpeta, sk.FILE), `${JSON.stringify(l)}\n`);
  fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'gates.log'), '');
  assert.match(String(sk.reverificar({ marker, carpeta, casa })), /registro/);
  // la constancia vigente es otra que la que anotó el salteo
  const otra = { ...marker, adversarialSkip: { firmado: { ...marker.adversarialSkip.firmado, huella: '0000000000000000' } } };
  assert.ok(sk.reverificar({ marker: otra, carpeta, casa }));
});

test('AdversarialSkip_CierresReverifican_ElTamañoForzado (T18)', async (t) => {
  await t.test('set-size liviana firmado: se reverifica como el salteo', (tt) => {
    const { casa, carpeta } = firmadaEn(tt);
    const [l] = lineas(carpeta);
    const firmado = { via: l.via, quien: l.quien, cuando: l.ts, huella: l.huella };
    const marker = { storyId: '9.99', startedAt: EJECUCION, size: 'liviana', sizeForced: { reason: 'x', firmado } };
    assert.deepStrictEqual(sk.firmasDelSalteo(marker).map((f) => f.camino), ['set-size liviana']);
    assert.strictEqual(sk.reverificar({ marker, carpeta, casa }), null, 'la constancia se sostiene');
    assert.match(String(sk.reverificar({ marker: { ...marker, sizeForced: { firmado: { ...firmado, huella: '0000000000000000' } } }, carpeta, casa })), /set-size liviana/);
    // vuelta a completa: el tamaño forzado ya no saltea nada
    assert.deepStrictEqual(sk.firmasDelSalteo({ ...marker, size: 'completa' }), []);
    fs.writeFileSync(path.join(casa, '.claude', '.tycon-pipeline', 'gates.log'), '');
    assert.match(String(sk.reverificar({ marker, carpeta, casa })), /registro/);
  });
  // los dos cierres de verdad, como subproceso: sin constancia en la casa de la cuenta, frenan (la dirección segura)
  for (const paso of ['findings', 'prepare-commit']) {
    await t.test(`complete-step ${paso} con el tamaño forzado sin constancia: frena`, (tt) => {
      const home = carpetaTemporal(tt, 'adv-skip-home-');
      const { repo, story, carpeta } = repoNuevo(tt, { codigo: true });
      fs.writeFileSync(path.join(carpeta, 'findings.json'), '[]\n');
      const mk = marcadorEn(home, repo, story);
      const m = JSON.parse(fs.readFileSync(mk, 'utf8'));
      const firmado = { via: 'terminal', quien: 'dueño', cuando: '2026-10-27T12:20:00.000Z', huella: 'abcdefabcdefabcd' };
      fs.writeFileSync(mk, JSON.stringify({ ...m, size: 'liviana', sizeForced: { by: 'x', reason: 'y', at: '2026-10-27T12:30:00.000Z', from: null, firmado } }));
      const r = spawnSync(process.execPath, [MARKER, 'complete-step', paso], { encoding: 'utf8', env: entornoLimpio(home) });
      assert.strictEqual(r.status, 1, r.stderr);
      assert.match(r.stderr, /constancia que ya no vale/);
      assert.ok(gates(home).some((g) => g.name === 'adversarial-skip-recheck' && g.status === 'blocked' && g.step === paso), 'queda en gates.log');
    });
  }
});

test('AdversarialSkip_RegistroDeAutoria_LoTrae (T19)', (t) => {
  const carpeta = carpetaTemporal(t, 'adv-skip-roster-');
  const firmado = { via: 'ventana', quien: 'dueño', cuando: '2026-10-27T13:00:00.000Z', huella: 'abcdefabcdefabcd' };
  // escrito antes del salteo: el salteo lo completa
  roster.write(carpeta, { lines: [], story: '9.99', sessionId: 'ses-a' });
  roster.anotarSalteo(carpeta, firmado);
  assert.deepStrictEqual(roster.read(carpeta).adversarial, { salteado: true, via: 'ventana', quien: 'dueño', cuando: '2026-10-27T13:00:00.000Z' });
  // escrito después: el campo se conserva
  roster.write(carpeta, { lines: [], story: '9.99', sessionId: 'ses-a' });
  assert.deepStrictEqual(roster.read(carpeta).adversarial, { salteado: true, via: 'ventana', quien: 'dueño', cuando: '2026-10-27T13:00:00.000Z' });
  // y si el salteo se conoce al escribirlo
  const otra = carpetaTemporal(t, 'adv-skip-roster-');
  roster.write(otra, { lines: [], story: '9.99', sessionId: 'ses-a', adversarialSkip: firmado });
  assert.strictEqual(roster.read(otra).adversarial.salteado, true);
  // sin salteo firmado, no hay campo
  const sin = carpetaTemporal(t, 'adv-skip-roster-');
  roster.write(sin, { lines: [], story: '9.99', sessionId: 'ses-a' });
  assert.strictEqual(roster.read(sin).adversarial, undefined);
  // un roster que está y no se lee no es «no hay roster»: lo dice
  const roto = carpetaTemporal(t, 'adv-skip-roster-');
  fs.writeFileSync(roster.rosterPath(roto), '{ roto');
  assert.throws(() => roster.anotarSalteo(roto, firmado), /no se lee/);
});

test('AdversarialSkip_NoPudeLeer_NoEsNoHay', (t) => {
  // el registro de la casa que está y no se lee: la firma no dice «no hay una muestra», dice que no lo pudo leer
  const casa = casaNueva(t);
  const reg = path.join(casa, '.claude', '.tycon-pipeline', 'gates.log');
  fs.mkdirSync(reg);
  assert.throws(() => sk.ultimaMuestra({ story: '9.99', casa }), /no pude leer el registro/);
  const r = firmarPorTerminal(casa);
  assert.strictEqual(r.codigo, 2);
  assert.match(r.motivo, /no pude leer el registro/);
  assert.doesNotMatch(r.motivo, /no hay una muestra/);
  // los renglones de firma rotos se cuentan cuando ninguna firma vale
  const { casa: c2, carpeta } = firmadaEn(t);
  const g = path.join(c2, '.claude', '.tycon-pipeline', 'gates.log');
  fs.writeFileSync(g, '{"name":"adversarial-skip-signed", roto\n');
  assert.match(sk.vigente({ story: '9.99', carpeta, ejecucion: EJECUCION, casa: c2 }).motivo, /1 renglón\(es\) de firma ilegible/);
});

test('AdversarialSkip_SinCorrida_NoOfreceComandos', (t) => {
  // sin corrida abierta no hay ejecución que firmar: el pase corre y no se ofrecen comandos que no pueden servir
  const casa = casaNueva(t);
  const { repo, story } = repoNuevo(t);
  const r = portón({ repo, story, noDeepReview: true, noDeepReviewFrom: '--no-deep-review' }, { casa, corrida: null });
  assert.strictEqual(r.result.run, true);
  assert.strictEqual(r.result.sign_commands, undefined);
  assert.match(r.result.skip_request.muestra, /sin corrida abierta/);
  // con la corrida, sí los ofrece
  const con = portón({ repo, story, noDeepReview: true, noDeepReviewFrom: '--no-deep-review' }, { casa, corrida: corridaDe(repo, story) });
  assert.strictEqual(con.result.sign_commands.length, 2);
});

test('AdversarialSkip_StartSinCorrida_NoOfreceComandos', (t) => {
  // start sin marcador todavía: el pedido se dice, sin una muestra con story y ejecución vacías ni comandos que no sirven
  for (const [nombre, env, yaml] of [['la variable', { TYCON_NO_DEEP_REVIEW: '1' }, null], ['deep_review: off', {}, 'deep_review: off\n']]) {
    const home = carpetaTemporal(t, 'adv-skip-home-');
    const { repo, story } = repoNuevo(t);
    if (yaml) { fs.mkdirSync(path.join(repo, '.tycon')); fs.writeFileSync(path.join(repo, '.tycon', 'advisors.yaml'), yaml); }
    const s = spawnSync(process.execPath, [PIPELINE, 'start', '--repo', repo, '--story', story], { encoding: 'utf8', env: { ...entornoLimpio(home), ...env } });
    assert.match(s.stderr, /es un pedido de saltear el pase adversarial/, nombre);
    assert.match(s.stderr, /no hay una corrida abierta/, nombre);
    assert.doesNotMatch(s.stderr, /sign-adversarial-skip/, `${nombre}: sin corrida no hay comandos de firma`);
    if (yaml) assert.match(s.stderr, /deep_review: off es un pedido/);
  }
});

// ── Lo que confirmó el pase adversarial (pruebas tomadas de step-05b-probes de la corrida) ──────────────────────────

test('AdversarialSkip_LivianaSinFirma_ConCodigoTocado_ElPaseCorre', (t) => {
  // la story declara sólo un .md y el cambio toca código: `set-size liviana` no pide firma (ve lo declarado), y el
  // portón no puede creerle al tamaño forzado sin la firma
  const { repo, story } = repoNuevo(t, { docs: true });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), Array.from({ length: 401 }, (_, i) => `const v${i} = ${i};`).join('\n'));
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=prueba', '-c', 'user.email=prueba@ejemplo.test', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  for (const a of [['init', '-q'], ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'base']]) assert.strictEqual(git(...a).status, 0);
  const files = [path.join(repo, 'src', 'a.js')];
  assert.strictEqual(pipeline.computeRunSize({ story, repo }).size, 'liviana', 'lo declarado solo es liviano');
  const sinFirma = pipeline.computeRunSize({ story, repo, files, runSize: { size: 'liviana', reason: 'sólo docs' } });
  assert.strictEqual(sinFirma.size, 'completa', sinFirma.reason);
  assert.match(sinFirma.reason, /sin la firma del dueño/);
  const g = pipeline.computeDeepReviewGate({ story, repo, files, runSize: { size: 'liviana', reason: 'sólo docs' } });
  assert.strictEqual(g.run, true, g.reason);
  // con la firma, el forzado vale; sin código tocado, también
  assert.strictEqual(pipeline.computeRunSize({ story, repo, files, runSize: { size: 'liviana', reason: 'x', firmado: true } }).size, 'liviana');
  assert.strictEqual(pipeline.computeRunSize({ story, repo, files: [], runSize: { size: 'liviana', reason: 'x' } }).size, 'liviana');
});

test('AdversarialSkip_DosFirmasDeLaEjecucion_CadaCaminoSeSostiene', (t) => {
  // una segunda firma válida de la misma ejecución no tumba la primera: los cierres no frenan, y firmar de nuevo sirve
  const { casa, carpeta } = firmadaEn(t);
  mostrar(casa, carpeta, 'set-size liviana', AHORA - 30000);
  assert.strictEqual(firmarPorTerminal(casa, { motivo: 'otro motivo' }).codigo, 0);
  const [a, b] = lineas(carpeta);
  assert.notStrictEqual(a.huella, b.huella);
  for (const l of [a, b]) {
    const firmado = { via: l.via, quien: l.quien, cuando: l.ts, huella: l.huella };
    for (const marker of [
      { storyId: '9.99', startedAt: EJECUCION, adversarialSkip: { firmado } },
      { storyId: '9.99', startedAt: EJECUCION, size: 'liviana', sizeForced: { reason: 'x', firmado } },
    ]) assert.strictEqual(sk.reverificar({ marker, carpeta, casa }), null, `${l.huella} se sostiene`);
  }
  assert.match(String(sk.reverificar({ marker: { storyId: '9.99', startedAt: EJECUCION, adversarialSkip: { firmado: { huella: '0000000000000000' } } }, carpeta, casa })), /ya no vale/);
});

test('AdversarialSkip_RegistroDeAutoria_NoArrastraUnSalteoViejo', (t) => {
  const carpeta = carpetaTemporal(t, 'adv-skip-roster-');
  const firmado = { via: 'terminal', quien: 'dueño', cuando: '2026-10-27T13:00:00.000Z', huella: 'abcdefabcdefabcd' };
  roster.write(carpeta, { lines: [], story: '9.99', sessionId: 'ses-a', adversarialSkip: firmado });
  assert.strictEqual(roster.read(carpeta).adversarial.salteado, true);
  // quien escribe con el marcador dice la verdad de la ejecución: sin salteo (otra ejecución, o `set-size completa`), sale
  roster.write(carpeta, { lines: [], story: '9.99', sessionId: 'ses-a', adversarialSkip: undefined });
  assert.strictEqual(roster.read(carpeta).adversarial, undefined);
  // sin marcador, viaja el anterior
  roster.write(carpeta, { lines: [], story: '9.99', sessionId: 'ses-a', adversarialSkip: firmado });
  roster.write(carpeta, { lines: [], story: '9.99', sessionId: 'ses-a' });
  assert.strictEqual(roster.read(carpeta).adversarial.salteado, true);
  // el pase corrió: el salteo sale del roster que existe
  roster.quitarSalteo(carpeta);
  assert.strictEqual(roster.read(carpeta).adversarial, undefined);
  assert.strictEqual(roster.quitarSalteo(carpetaTemporal(t, 'adv-skip-roster-')), null, 'sin roster no escribe nada');
});

test('AdversarialSkip_RutaRelativaOEnlace_LaMismaEjecucion', (t) => {
  // el portón y el marcador llegan a la misma carpeta: con un --repo relativo, por un enlace, o con la story del
  // marcador relativa a su repo
  const casa = casaNueva(t);
  const { repo, story, carpeta } = repoNuevo(t);
  const real = fs.realpathSync(carpeta);
  const enlace = path.join(carpetaTemporal(t, 'adv-skip-enlace-'), 'repo');
  fs.symlinkSync(repo, enlace);
  const relativa = path.relative(process.cwd(), repo);
  for (const [nombre, args, corrida] of [
    ['--repo relativo', { repo: relativa, story }, corridaDe(repo, story)],
    ['el repo por un enlace', { repo: enlace, story: path.join(enlace, 'specs', 'story-9.99.md') }, corridaDe(enlace, path.join(enlace, 'specs', 'story-9.99.md'))],
    ['la story del marcador relativa', { repo, story }, { ...corridaDe(repo, story), storyPath: 'specs/story-9.99.md' }],
  ]) {
    const antes = gates(casa).length;
    const r = portón({ ...args, noDeepReview: true, noDeepReviewFrom: '--no-deep-review' }, { casa, corrida });
    assert.strictEqual(r.result.sign_commands && r.result.sign_commands.length, 2, `${nombre}: hay ejecución`);
    const m = gates(casa).slice(antes).find((g) => g.name === 'adversarial-skip-shown');
    assert.strictEqual(m.carpeta, real, `${nombre}: la muestra nombra la carpeta real`);
  }
  // la muestra relativa también se anota absoluta: la firma no escribe donde esté parado quien firma
  assert.strictEqual(mostrar(casa, path.relative(process.cwd(), carpeta)).renglon.carpeta, real);
  assert.strictEqual(firmarPorTerminal(casa).codigo, 0);
  assert.strictEqual(lineas(real).length, 1);
  for (const c of [carpeta, real, path.join(enlace, '.advisors', 'pipeline-runs', '9.99-20261027120000')]) {
    assert.strictEqual(sk.vigente({ story: '9.99', carpeta: c, ejecucion: EJECUCION, casa }).ok, true, c);
  }
});

test('AdversarialSkip_ConsolaSinInterprete_NoEscribeLaConstancia', (t) => {
  // el registro y la constancia del salteo, por las formas de consola que no pasan por un intérprete; lo mismo
  // apuntado afuera pasa (el freno protege los archivos de la firma, no cualquier destino)
  const bash = require('../on-bash-write-gate.js');
  const estado = carpetaTemporal(t, 'adv-skip-estado-');
  const { repo, carpeta } = repoNuevo(t);
  const registro = path.join(estado, 'gates.log');
  const constancia = path.join(carpeta, 'adversarial-skips.jsonl');
  const afuera = path.join(carpetaTemporal(t, 'adv-skip-afuera-'), 'x.txt');
  const formas = (d) => [
    `/bin/cp /tmp/g ${d}`, `command cp /tmp/g ${d}`, `install -m 644 /tmp/g ${d}`, `ditto /tmp/g ${d}`,
    `rsync /tmp/g ${d}`, `curl -s -o ${d} https://ejemplo.test/g`, `curl -so ${d} https://ejemplo.test/g`, `curl -o${d} https://ejemplo.test/g`,
    `wget -qO ${d} https://ejemplo.test/g`, `wget --output-document=${d} https://ejemplo.test/g`,
    `cat /tmp/g | sponge ${d}`, `bash -c "cp /tmp/g ${d}"`, `echo /tmp/g | xargs -I{} cp {} ${d}`,
  ];
  const corre = (cmd) => bash.handle({ tool_name: 'Bash', session_id: 'adv-skip-consola', cwd: repo, tool_input: { command: cmd } }, { stateDir: estado });
  for (const d of [registro, constancia]) {
    for (const cmd of formas(d)) assert.ok(corre(cmd)?.block, `frena: ${cmd}`);
  }
  for (const cmd of [`tar -xzf /tmp/g.tgz -C ${carpeta}`, `unzip -o /tmp/g.zip -d ${carpeta}`]) assert.ok(corre(cmd)?.block, `frena: ${cmd}`);
  for (const cmd of [...formas(afuera), `tar -xzf /tmp/g.tgz -C ${path.dirname(afuera)}`, `tar -czf /tmp/g.tgz ${carpeta}`]) {
    assert.ok(!corre(cmd)?.block, `pasa: ${cmd}`);
  }
});

test('AdversarialSkip_PedidoQueNoHaceFalta_NoPideFirma', (t) => {
  // el pase ya no corría (corrida liviana): el pedido no anota muestra ni pide una firma que nadie necesita
  const casa = casaNueva(t);
  const { repo, story } = repoNuevo(t, { docs: true });
  const r = portón({ repo, story, noDeepReview: true, noDeepReviewFrom: '--no-deep-review' }, { casa, corrida: corridaDe(repo, story) });
  assert.strictEqual(r.result.run, false, r.result.reason);
  assert.match(r.result.reason, /no hace falta/);
  assert.strictEqual(r.result.skip_request, undefined);
  assert.strictEqual(r.result.sign_commands, undefined);
  assert.strictEqual(r.texto, '');
  assert.strictEqual(gates(casa).filter((g) => g.name === 'adversarial-skip-shown').length, 0);
});
