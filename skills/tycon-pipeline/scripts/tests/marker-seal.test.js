#!/usr/bin/env node
'use strict';
// marker-seal.test.js — el marcador cambiado a mano frena (@story-8.121).
//
// Cada escritura legítima del marcador pasa por lib/marker-seal.js, que deja un sello con la huella (sha256) de lo que
// escribió, con un candado por sesión. Una ejecución abierta con `sellado: true` cuyo marcador no coincide con su sello
// (cambiado con cualquier programa, vuelto a una versión anterior, o sin sello) frena la edición, la consola, el cierre
// del turno y el commit con «MARCADOR DE LA EJECUCIÓN CAMBIADO A MANO». La salida es `clear-session --lost` con la firma
// del dueño; `restore` no la saca, porque conserva el marcador que hay en disco.
//
// Corre los guiones reales en una HOME y un repo de juguete. Los comandos que juzgan los ganchos van en las tablas de
// abajo, no en la línea de un comando: el freno de esta máquina los frenaría.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/marker-seal.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const { conVentana } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'window-passed.js'));
const { inHarnessCopy } = require(path.join(RAIZ, 'scripts', 'tests', 'lib', 'harness-copy.js'));
const sello = require(path.join(SCRIPTS, 'lib', 'marker-seal.js'));
const TUID = 'toolu_8121b';
const CAMBIADO = /MARCADOR DE LA EJECUCIÓN CAMBIADO A MANO/;
const huella = (texto) => crypto.createHash('sha256').update(texto).digest('hex');

function entorno() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-seal-'));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'));
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'tycon-harness'));
  fs.mkdirSync(path.join(repo, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  // stable-data: los commits de juguete llevan fecha fija y el mantenimiento de git apagado
  const FECHA = '2026-01-01T10:00:00';
  const git = (...a) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', repo, ...a], {
    stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA },
  });
  git('init', '-q', '-b', 'feat/x');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const story = path.join(repo, 'specs', 'story-9.9-sello.md');
  fs.writeFileSync(story, ['---', 'story: "9.9"', 'title: "sello"', 'status: ready-for-dev', 'files_to_modify:', '  - src/a.js', '---',
    '# Story 9.9', '', '### Tests', '', '| # | Test |', '|---|---|', '| T1 | a |', '', '## Dev Agent Record', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'inicio');

  const env = (sid, extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none',
      TYCON_MUTATION_CHECK: 'off', TYCON_WAIT_NOTICE: '', TYCON_GUIDES_DIR: RAIZ });
    if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
    return Object.assign(e, extra);
  };
  const correr = (script, args, sid, extra) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: env(sid, extra), input: '', cwd: repo,
  });
  const estado = () => require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  const gates = () => path.join(estado(), 'gates.log');
  const activo = (sid) => path.join(estado(), 'active', `${sid}.json`);
  const selloDe = (sid) => path.join(estado(), 'seals', `${sid}.json`);
  const leerSello = (sid) => JSON.parse(fs.readFileSync(selloDe(sid), 'utf8'));
  const renglones = () => (fs.existsSync(gates()) ? fs.readFileSync(gates(), 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  const apertura = (sid) => renglones().filter((l) => l.name === 'run-open' && l.sesion === sid).pop();
  // escribir por la librería, como un escritor legítimo
  const escribir = (sid, cambio) => {
    const m = JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
    cambio(m);
    const r = sello.escribir({ sid, estado: estado(), marker: m });
    assert.ok(r.ok, `la librería no escribió: ${r.motivo}`);
  };
  const arrancar = (sid) => {
    const r = correr('pipeline.js', ['start', '--story', story, '--repo', repo, '--brief'], sid);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    // el plan aprobado, escrito por la librería: la edición de código pasa con la ejecución sana
    escribir(sid, (m) => {
      m.stepsCompleted = [...new Set([...(m.stepsCompleted || []), 'validate-story', 'plan', 'approve-plan'])];
      m.stepsPending = (m.stepsPending || []).filter((x) => !['validate-story', 'plan', 'approve-plan'].includes(x));
    });
  };
  const gancho = (script, sid, evento, extra) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
      input: JSON.stringify({ ...(sid ? { session_id: sid } : {}), tool_use_id: TUID, cwd: repo, ...evento }), env: env(null, extra), encoding: 'utf8',
    });
    return { status: r.status, out: (r.stderr || '') + (r.stdout || '') };
  };
  const editar = (sid) => gancho('on-story-gate.js', sid, { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.js') } });
  const editado = (sid) => gancho('on-edit.js', sid, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.js') } });
  const consola = (sid, command) => {
    const r = spawnSync(process.execPath, [inHarnessCopy(path.join(SCRIPTS, 'on-bash-write-gate.js'))], {
      input: JSON.stringify({ session_id: sid, tool_use_id: TUID, cwd: repo, tool_name: 'Bash', tool_input: { command } }),
      env: env(null), encoding: 'utf8',
    });
    return { status: r.status, out: (r.stderr || '') + (r.stdout || '') };
  };
  const turno = (sid) => gancho('on-stop-dod-gate.js', sid, { hook_event_name: 'Stop' });
  const commit = (sid) => gancho('on-pre-commit.js', sid, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  const frenado = (r) => r.status === 2 || /"decision":"block"/.test(r.out);
  // el cambio a mano: un programa que no es la librería reescribe el marcador
  const aMano = (sid, cambio) => {
    const m = JSON.parse(fs.readFileSync(activo(sid), 'utf8'));
    cambio(m);
    fs.writeFileSync(activo(sid), JSON.stringify(m, null, 2) + '\n');
  };
  return { home, repo, story, env, correr, estado, gates, activo, selloDe, leerSello, renglones, apertura, escribir, arrancar,
    editar, editado, consola, turno, commit, frenado, aMano };
}

const coincide = (E, sid) => {
  const texto = fs.readFileSync(E.activo(sid));
  assert.strictEqual(E.leerSello(sid).huella, huella(texto), 'la huella del sello es la del marcador');
};

// ── La huella por escritura (AC 14) ───────────────────────────────────────────────────────────────────────────────────

test('T19 MarcadorCambiado_HuellaPorEscritura @story-8.121 @ac-14 — cada escritura legítima deja el sello con la huella', () => {
  const E = entorno();
  E.arrancar('s-t19');
  assert.strictEqual(E.apertura('s-t19').sellado, true, 'la apertura trae sellado: true');
  coincide(E, 's-t19');
  const pasos = [
    ['marker.js', () => { const r = E.correr('marker.js', ['run-check', 'build', '--', process.execPath, '-e', '0'], 's-t19'); assert.strictEqual(r.status, 0, r.stderr + r.stdout); }],
    ['on-edit.js', () => E.editado('s-t19')],
    ['on-bash-write-gate.js', () => require(path.join(SCRIPTS, 'on-bash-write-gate.js')).anotarBorradosDeLaStory({
      stateDir: E.estado(), sessionId: 's-t19', marker: { repoPath: E.repo, storyId: '9.9' }, rutas: [path.join(E.repo, 'src', 'a.js')], via: 'git rm' })],
    ['wait-notice.js', () => {
      const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(RAIZ, 'scripts', 'hooks', 'wait-notice.js'))}).noteFindingsWait('s-t19')`],
        { env: E.env(null), encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
    }, () => {
      // «Hallazgos» abierto: los revisores y el pase cerrados, Hallazgos pendiente
      E.escribir('s-t19', (m) => {
        m.stepsCompleted = [...new Set([...(m.stepsCompleted || []), 'reviewers', 'adversarial-pass'])];
        m.stepsPending = [...new Set([...(m.stepsPending || []).filter((x) => !['reviewers', 'adversarial-pass'].includes(x)), 'findings'])];
      });
    }],
    ['on-stop-dod-gate.js', () => {
      E.turno('s-t19');
      assert.ok(!('waitingForHuman' in JSON.parse(fs.readFileSync(E.activo('s-t19'), 'utf8'))), 'el cierre de turno escribió');
    }, () => E.escribir('s-t19', (m) => { m.autonomous = true; m.waitingForHuman = true; })],
  ];
  for (const [quien, paso, preparar] of pasos) {
    if (preparar) preparar();
    const antes = E.leerSello('s-t19');
    paso();
    const despues = E.leerSello('s-t19');
    assert.notStrictEqual(despues.huella, antes.huella, `${quien}: escribió y dejó un sello nuevo`);
    assert.strictEqual(despues.previa, antes.huella, `${quien}: la previa es la huella de antes`);
    assert.strictEqual(despues.sesion, 's-t19');
    coincide(E, 's-t19');
    assert.doesNotMatch(E.editar('s-t19').out, CAMBIADO, `${quien}: la ejecución sigue sana`);
  }
});

// ── El cambio a mano frena (AC 15) ────────────────────────────────────────────────────────────────────────────────────

const FORMAS = [
  ['node -e', (f) => `node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1]));m.stepsCompleted.push('reviewers');fs.writeFileSync(process.argv[1],JSON.stringify(m))" ${f}`],
  ['python3 -c', (f) => `python3 -c "import json,sys;p=sys.argv[1];m=json.load(open(p));m['autonomous']=False;json.dump(m,open(p,'w'))" ${f}`],
  ['sed -i', (f) => `sed -i.bak 's/"storyId"/"storyId" /' ${f} && rm -f ${f}.bak`],
];

test('T20 MarcadorCambiado_AManoFrena @story-8.121 @ac-15 — el marcador cambiado frena; un escritor no lo blanquea; restore no lo saca', () => {
  let corridas = 0;
  for (const [nombre, forma] of FORMAS) {
    const E = entorno();
    const sid = `s-t20-${corridas}`;
    E.arrancar(sid);
    const antes = fs.readFileSync(E.activo(sid), 'utf8');
    spawnSync('bash', ['-c', forma(E.activo(sid))], { stdio: 'ignore' });
    if (fs.readFileSync(E.activo(sid), 'utf8') === antes) continue; // esta máquina no trae el programa
    corridas++;
    for (const [donde, r] of [['edición', E.editar(sid)], ['consola', E.consola(sid, 'echo x > src/b.js')], ['turno', E.turno(sid)], ['commit', E.commit(sid)]]) {
      assert.ok(E.frenado(r), `${nombre} · ${donde}: ${r.out}`);
      assert.match(r.out, CAMBIADO, `${nombre} · ${donde}`);
    }
    assert.match(E.editar(sid).out, /9\.9/, `${nombre}: el cartel nombra la historia`);
    assert.match(E.editar(sid).out, /--lost/, `${nombre}: el cartel dice la salida`);
    assert.doesNotMatch(E.editar(sid).out, /restore/, `${nombre}: el cartel no ofrece restore`);
  }
  assert.ok(corridas >= 2, `se corrieron ${corridas} formas`);

  // un escritor legítimo después del cambio no lo sella: lo anota y la pregunta sigue frenando
  const E = entorno();
  E.arrancar('s-t20b');
  E.aMano('s-t20b', (m) => { m.stepsCompleted.push('reviewers'); });
  const selloAntes = E.leerSello('s-t20b');
  E.editado('s-t20b');
  assert.deepStrictEqual(E.leerSello('s-t20b'), selloAntes, 'on-edit.js no selló el marcador cambiado');
  assert.ok(E.renglones().some((l) => l.name === 'marker-seal-mismatch' && l.sesion === 's-t20b'), 'quedó el renglón del desacuerdo');
  assert.match(E.editar('s-t20b').out, CAMBIADO);
  // restore, aun firmado, no lo saca: conservaría lo tocado a mano
  const marcadorCambiado = fs.readFileSync(E.activo('s-t20b'), 'utf8');
  const rr = E.correr('marker.js', ['restore', 's-t20b'], 's-t20b', conVentana({}));
  assert.notStrictEqual(rr.status, 0, 'restore sacó un marcador cambiado');
  assert.match(rr.stderr + rr.stdout, /--lost/);
  assert.strictEqual(fs.readFileSync(E.activo('s-t20b'), 'utf8'), marcadorCambiado, 'restore no escribió');
  // con la firma, clear-session --lost la cierra; también con el marcador roto
  fs.writeFileSync(E.activo('s-t20b'), '{ roto');
  const rl = E.correr('marker.js', ['clear-session', 's-t20b', '--lost'], 's-t20b', conVentana({}));
  assert.strictEqual(rl.status, 0, rl.stderr + rl.stdout);
  assert.ok(!fs.existsSync(E.selloDe('s-t20b')), 'el cierre borró el sello');
  assert.doesNotMatch(E.editar('s-t20b').out, CAMBIADO);

  // volver a la versión anterior, sin candado, frena
  const F = entorno();
  F.arrancar('s-t20c');
  const vieja = fs.readFileSync(F.activo('s-t20c'));
  F.escribir('s-t20c', (m) => { m.lastTouch = new Date().toISOString(); });
  fs.writeFileSync(F.activo('s-t20c'), vieja);
  assert.match(F.editar('s-t20c').out, CAMBIADO, 'la versión anterior sin candado frena');
});

// ── El sello que falta o no se lee (AC 16) ────────────────────────────────────────────────────────────────────────────

test('T21 MarcadorCambiado_SelloQueFaltaOIlegible_Frena @story-8.121 @ac-16 — sin sello, roto o de otra sesión frena; una apertura sin sellado no', () => {
  const casos = [
    ['borrado', (E, sid) => fs.rmSync(E.selloDe(sid))],
    ['roto', (E, sid) => fs.writeFileSync(E.selloDe(sid), '{ roto')],
    ['de otra sesión', (E, sid) => fs.writeFileSync(E.selloDe(sid), JSON.stringify({ ...E.leerSello(sid), sesion: 'otra' }))],
  ];
  for (const [nombre, romper] of casos) {
    const E = entorno();
    E.arrancar('s-t21');
    romper(E, 's-t21');
    const r = E.editar('s-t21');
    assert.strictEqual(r.status, 2, `${nombre}: ${r.out}`);
    assert.match(r.out, CAMBIADO, nombre);
    assert.match(r.out, /sello/i, `${nombre}: el cartel dice qué pasa con el sello`);
  }
  // una apertura de antes del sello (sin `sellado`) no se juzga por el sello
  const E = entorno();
  E.arrancar('s-t21v');
  const lineas = fs.readFileSync(E.gates(), 'utf8').split('\n').map((l) => {
    try { const o = JSON.parse(l); if (o.name === 'run-open' && o.sesion === 's-t21v') { delete o.sellado; return JSON.stringify(o); } } catch { /* otra */ }
    return l;
  });
  fs.writeFileSync(E.gates(), lineas.join('\n'));
  E.aMano('s-t21v', (m) => { m.stepsCompleted.push('reviewers'); });
  fs.rmSync(E.selloDe('s-t21v'));
  assert.doesNotMatch(E.editar('s-t21v').out, CAMBIADO);
});

// ── La búsqueda sobre el código (AC 14) ───────────────────────────────────────────────────────────────────────────────

test('T22 Censo_NadieEscribeElMarcadorPorFuera @story-8.121 @ac-14 — sólo la librería escribe el marcador', () => {
  const { escritoresDelMarcador } = sello;
  const hallados = escritoresDelMarcador(RAIZ).map((h) => `${h.archivo}:${h.funcion}`);
  assert.deepStrictEqual(hallados, [], `escriben el marcador por fuera de la librería: ${hallados.join(', ')}`);
  // una escritura nueva de cada forma, en un archivo de juguete, se nombra
  const J = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-seal-censo-'));
  fs.mkdirSync(path.join(J, 'scripts'));
  fs.writeFileSync(path.join(J, 'scripts', 'juguete.js'), [
    "const fs = require('fs'); const path = require('path');",
    "function porCarpeta(estado, sid, m) { fs.writeFileSync(path.join(estado, 'active', `${sid}.json`), JSON.stringify(m)); }",
    'function porNombre({ markerPath }, m) { fs.writeFileSync(markerPath, JSON.stringify(m)); }',
    "function otraCosa(f) { fs.writeFileSync(f, 'x'); }",
  ].join('\n'));
  assert.deepStrictEqual(escritoresDelMarcador(J).map((h) => h.funcion).sort(), ['porCarpeta', 'porNombre']);
});

// ── La primera capa (AC 21) ───────────────────────────────────────────────────────────────────────────────────────────

test('T23 PrimeraCapa_Sellos_Frenan @story-8.121 @ac-21 — borrar o mover el sello frena; escribirle también', () => {
  const E = entorno();
  E.arrancar('s-t23');
  const s = E.selloDe('s-t23');
  for (const c of [`rm ${s}`, `mv ${s} /tmp/x`, `\\rm -f ${s}`]) {
    const r = E.consola('s-t23', c);
    assert.strictEqual(r.status, 2, `${c}: ${r.out}`);
    assert.match(r.out, /BORRADO DEL ESTADO DEL PIPELINE/, c);
  }
  const r = E.consola('s-t23', `echo '{}' > ${s}`);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /ESCRITURA DIRECTA AL ESTADO DEL PIPELINE|estado del pipeline/i);
});

// ── No-regresión (AC 22) ──────────────────────────────────────────────────────────────────────────────────────────────

test('T24 NoRegresion_EscriturasConcurrentes_NoFrenan @story-8.121 @ac-22 — muchas escrituras y dos procesos a la vez no frenan', async () => {
  const E = entorno();
  E.arrancar('s-t24');
  for (let i = 0; i < 200; i++) E.escribir('s-t24', (m) => { m.lastTouch = `t-${i}`; });
  coincide(E, 's-t24');
  // dos procesos de la misma sesión escriben a la vez, y la pregunta corre en medio
  const LIB = path.join(SCRIPTS, 'lib', 'marker-seal.js');
  const hijo = (n) => spawn(process.execPath, ['-e', [
    `const s = require(${JSON.stringify(LIB)}); const fs = require('fs');`,
    `for (let i = 0; i < 50; i++) { const m = JSON.parse(fs.readFileSync(${JSON.stringify(E.activo('s-t24'))}, 'utf8')); m.lastTouch = 'p${n}-' + i;`,
    `  const r = s.escribir({ sid: 's-t24', estado: ${JSON.stringify(E.estado())}, marker: m }); if (!r.ok) { console.error(r.motivo); process.exit(1); } }`,
  ].join('\n')], { stdio: ['ignore', 'ignore', 'pipe'] });
  const fin = (p) => new Promise((res) => { let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (code) => res({ code, err })); });
  const procesos = [hijo(1), hijo(2)];
  const or = require(path.join(SCRIPTS, 'lib', 'open-runs.js'));
  const preguntas = [];
  const vigilar = setInterval(() => { preguntas.push(or.perdida({ sid: 's-t24', cwd: E.repo, home: E.home })); }, 5);
  const salidas = await Promise.all(procesos.map(fin));
  clearInterval(vigilar);
  for (const s of salidas) assert.strictEqual(s.code, 0, s.err);
  assert.ok(preguntas.length > 0);
  assert.deepStrictEqual(preguntas.filter(Boolean), [], 'la pregunta frenó una ejecución sana');
  coincide(E, 's-t24');
  // la revisión del sello lee sólo el sello y el marcador
  const leidos = [];
  const original = fs.readFileSync;
  fs.readFileSync = function espia(f, ...resto) { leidos.push(String(f)); return original.call(fs, f, ...resto); };
  try { assert.strictEqual(sello.revisar({ sid: 's-t24', estado: E.estado() }), null); } finally { fs.readFileSync = original; }
  assert.deepStrictEqual([...new Set(leidos)].sort(), [E.activo('s-t24'), E.selloDe('s-t24')].sort());
  // el cierre borra el sello
  assert.strictEqual(E.correr('marker.js', ['clear', '--discard'], 's-t24').status, 0);
  assert.ok(!fs.existsSync(E.selloDe('s-t24')), 'el sello se borró al cerrar');
  assert.doesNotMatch(E.editar('s-t24').out, CAMBIADO);
});
