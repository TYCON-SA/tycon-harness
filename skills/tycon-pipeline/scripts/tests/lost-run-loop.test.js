#!/usr/bin/env node
'use strict';
// lost-run-loop.test.js — la ejecución perdida pide la firma una vez por turno, da comandos que andan en Windows y se
// frena antes de borrar su carpeta (@story-8.318).
//
// Tres partes:
//   · el cierre de turno (on-stop-dod-gate.js) frena el primer Stop con la ejecución perdida y deja cerrar el segundo
//     seguido, con el cartel para la persona; un contador por sesión y apertura en la carpeta del estado. Editar, la
//     consola, el commit y `marker.js clear` siguen frenados;
//   · el cartel trae dos formas por salida (la de la ventana y la de la terminal), con la ruta estable de marker.js bajo
//     la carpeta personal, sin `~` ni la carpeta numerada de la versión. Los seis lugares que la imprimen usan la misma
//     función (lib/open-runs.js formasDeSalida). En Windows, la T13 pega cada comando en las tres consolas;
//   · la consola frena borrar o mover una carpeta que contiene la carpeta de una ejecución abierta (abierta según
//     gates.log), y `git worktree prune` si poda una así.
//
// Cada prueba arma su casa y su repo con mkdtemp; nada corre contra el estado real. Los comandos que juzga la consola van
// en el evento, no en la línea de un comando.
//
// Correr: node --test skills/tycon-pipeline/scripts/tests/lost-run-loop.test.js < /dev/null

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const OR = path.join(SCRIPTS, 'lib', 'open-runs.js');
const PERDIDA = /EJECUCIÓN PERDIDA/;
const ANTES = /CERRÁ LA EJECUCIÓN ANTES/;
const WIN = process.platform === 'win32';
// stable-data: los commits de juguete llevan fecha fija y el mantenimiento de git apagado
const FECHA = '2026-01-01T10:00:00';

function git(cwd, ...a) {
  return execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', cwd, ...a], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Una casa y un repo de juguete: `{ home, repo, base, ... }`, con las funciones para abrir, perder y correr ganchos. */
function entorno({ nombreCasa = 'home' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lost-run-loop-')));
  const home = path.join(base, nombreCasa);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.symlinkSync(RAIZ, path.join(home, '.claude', 'agent-skills'), WIN ? 'junction' : 'dir');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'inicio');
  const env = (sid, extra = {}) => {
    const e = { ...process.env };
    for (const k of Object.keys(e)) if (/^TYCON_|^CODEX_SESSION_ID$|^CLAUDE_CODE_SESSION_ID$/.test(k)) delete e[k];
    Object.assign(e, { HOME: home, USERPROFILE: home, TYCON_LANE_LLM: '0', TYCON_HOME: '', TYCON_TIME_TRACKING: 'none',
      TYCON_MUTATION_CHECK: 'off', TYCON_GUIDES_DIR: RAIZ });
    if (sid) e.CLAUDE_CODE_SESSION_ID = sid;
    return Object.assign(e, extra);
  };
  const or = require(OR);
  const estado = () => require(path.join(SCRIPTS, 'lib', 'state-dir.js')).stateDir(home);
  const gates = () => path.join(estado(), 'gates.log');
  const contador = (sid) => path.join(estado(), 'lost-run-stop', `${sid}.json`);
  const renglones = () => (fs.existsSync(gates()) ? fs.readFileSync(gates(), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  /** Abre la ejecución de `sid` en `dir` (un repo o una carpeta de trabajo), con su marcador y su copia. */
  const abrir = (sid, dir = repo, story = '9.9') => {
    const runDir = path.join(dir, '.advisors', 'pipeline-runs', `${story}-${sid}`);
    const a = or.abrir({ sid, story, repo: dir, runDir, home });
    fs.mkdirSync(path.join(estado(), 'active'), { recursive: true });
    fs.writeFileSync(or.markerPath(sid, home), JSON.stringify({ storyId: story, sessionId: sid, repoPath: dir, runDir: a.runDir, lastTouch: new Date().toISOString() }));
    return a;
  };
  /** La pierde: borra la copia de la apertura (caso c). */
  const perder = (sid, a) => fs.unlinkSync(path.join(a.runDir, 'run-open.json'));
  const gancho = (script, sid, evento, extra, cwd = repo) => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
      input: JSON.stringify({ ...(sid ? { session_id: sid } : {}), cwd, ...evento }), env: env(null, extra), encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stderr || '') + (r.stdout || '') };
  };
  const turno = (sid, evento = {}, extra) => gancho('on-stop-dod-gate.js', sid, { hook_event_name: 'Stop', ...evento }, extra);
  const consola = (sid, command, cwd = repo, tool_name = 'Bash') => gancho('on-bash-write-gate.js', sid, { tool_name, tool_input: { command } }, {}, cwd);
  const editar = (sid) => gancho('on-story-gate.js', sid, { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.js') } });
  const commit = (sid) => gancho('on-pre-commit.js', sid, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
  const marker = (sid, args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'marker.js'), ...args], { encoding: 'utf8', env: env(sid), input: '', cwd: repo });
  return { base, home, repo, env, or, estado, gates, contador, renglones, abrir, perder, gancho, turno, consola, editar, commit, marker };
}

const frena = (r) => r.status === 2 || /"decision"\s*:\s*"block"/.test(r.stdout);
const salida = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop() || '{}'); } catch { return {}; } };

/** Una carpeta de trabajo de git al lado del repo, con su rama. */
function carpetaDeTrabajo(E, nombre = 'repo-wt-a') {
  const wt = path.join(E.base, nombre);
  git(E.repo, 'worktree', 'add', '-q', '-b', `feat/${nombre}`, wt);
  return wt;
}

// ── Un pedido de firma por turno (AC 1-7) ────────────────────────────────────────────────────────────────────────────

test('T1 EjecucionPerdida_CierreDeTurno_PrimerIntento_Frena @story-8.318 @ac-1 — frena con el cartel y anota el contador', () => {
  const E = entorno();
  const a = E.abrir('s-t1');
  E.perder('s-t1', a);
  const r = E.turno('s-t1');
  assert.ok(frena(r), r.out);
  assert.match(salida(r).reason, PERDIDA);
  const c = JSON.parse(fs.readFileSync(E.contador('s-t1'), 'utf8'));
  assert.strictEqual(c.sesion, 's-t1');
  assert.strictEqual(c.apertura, a.ts, 'el contador nombra la apertura');
  assert.strictEqual(c.frenos, 1);
});

test('T2 EjecucionPerdida_CierreDeTurno_SegundoIntento_DejaCerrarConAviso @story-8.318 @ac-2 — el segundo pasa con systemMessage; la ejecución restaurada borra el contador', () => {
  const E = entorno();
  const a = E.abrir('s-t2');
  E.perder('s-t2', a);
  assert.ok(frena(E.turno('s-t2')));
  const r = E.turno('s-t2');
  assert.ok(!frena(r), r.out);
  const o = salida(r);
  assert.ok(!o.decision, 'sin block');
  assert.match(o.systemMessage, PERDIDA, 'el cartel va a la persona');
  assert.match(o.systemMessage, /a la segunda/);
  assert.ok(E.renglones().some((l) => l.name === 'story-gate' && l.kind === 'ejecucion-perdida-espera' && l.sessionId === 's-t2'), 'renglón de la espera');
  assert.ok(!fs.existsSync(E.contador('s-t2')), 'el contador se borró');
  // la ejecución restaurada (vuelve su copia) con el contador en 1: el Stop sin pérdida lo borra
  assert.ok(frena(E.turno('s-t2')));
  assert.ok(fs.existsSync(E.contador('s-t2')));
  fs.writeFileSync(path.join(a.runDir, 'run-open.json'), JSON.stringify({ sesion: 's-t2', story: '9.9', runDir: a.runDir, ts: a.ts }));
  assert.ok(!frena(E.turno('s-t2')));
  assert.ok(!fs.existsSync(E.contador('s-t2')), 'el Stop sano borró el contador');
  // la misma apertura vuelve a perderse: el primer Stop frena otra vez
  E.perder('s-t2', a);
  assert.ok(frena(E.turno('s-t2')), 'vuelve a frenar en su primer Stop');
});

test('T3 EjecucionPerdida_CierreDeTurno_TurnoSiguienteVuelveAFrenar @story-8.318 @ac-3 — Stop, Stop y el de un turno nuevo', () => {
  const E = entorno();
  const a = E.abrir('s-t3');
  E.perder('s-t3', a);
  assert.ok(frena(E.turno('s-t3')));
  assert.ok(!frena(E.turno('s-t3')));
  assert.ok(frena(E.turno('s-t3')), 'el turno nuevo frena otra vez');
});

test('T4 EjecucionPerdida_CierreDeTurno_StopHookActiveNoDecide @story-8.318 @ac-4 — con stop_hook_active true en el primero, frena', () => {
  const E = entorno();
  const a = E.abrir('s-t4');
  E.perder('s-t4', a);
  const r = E.turno('s-t4', { stop_hook_active: true });
  assert.ok(frena(r), r.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(E.contador('s-t4'), 'utf8')).frenos, 1);
  // y con false en el segundo, igual deja cerrar: el campo no decide
  assert.ok(!frena(E.turno('s-t4', { stop_hook_active: false })));
});

test('T5 EjecucionPerdida_ConsolaYCommit_SiguenFrenandoTrasDejarCerrar @story-8.318 @ac-5 — editar, escribir por consola, commit y marker.js clear', () => {
  const E = entorno();
  const a = E.abrir('s-t5');
  E.perder('s-t5', a);
  E.turno('s-t5');
  assert.ok(!frena(E.turno('s-t5')), 'el turno se dejó cerrar');
  for (const [que, r] of [['editar', E.editar('s-t5')], ['consola', E.consola('s-t5', 'echo x > src/b.js')], ['commit', E.commit('s-t5')]]) {
    assert.ok(frena(r), `${que}: ${r.out}`);
    assert.match(r.out, PERDIDA, que);
  }
  const m = E.marker('s-t5', ['clear']);
  assert.strictEqual(m.status, 3, m.stderr);
  assert.match(m.stderr, /está perdida/);
});

test('T6 EjecucionPerdida_CierreDeTurno_ContadorRotoOViejo @story-8.318 @ac-6 — sin poder anotar frena y lo dice; el de otra apertura vuelve a 0', { skip: WIN && 'los permisos de una carpeta no se niegan igual en Windows' }, () => {
  const E = entorno();
  const a = E.abrir('s-t6');
  E.perder('s-t6', a);
  // la carpeta del contador es un archivo: no se puede anotar
  fs.writeFileSync(path.join(E.estado(), 'lost-run-stop'), 'no es una carpeta');
  for (let i = 0; i < 2; i++) {
    const r = E.turno('s-t6');
    assert.ok(frena(r), r.out);
    assert.match(r.stderr, /no pude (?:leer|anotar) el contador/);
  }
  fs.unlinkSync(path.join(E.estado(), 'lost-run-stop'));
  // un contador de otra apertura no cuenta
  fs.mkdirSync(path.join(E.estado(), 'lost-run-stop'));
  fs.writeFileSync(E.contador('s-t6'), JSON.stringify({ sesion: 's-t6', apertura: '2020-01-01T00:00:00.000Z', frenos: 1 }));
  assert.ok(frena(E.turno('s-t6')), 'el de otra apertura frena');
  assert.strictEqual(JSON.parse(fs.readFileSync(E.contador('s-t6'), 'utf8')).apertura, a.ts);
  // un contador que no se puede leer frena y lo dice
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(E.contador('s-t6'), 0o000);
    try {
      const r = E.turno('s-t6');
      assert.ok(frena(r), r.out);
      assert.match(r.stderr, /no pude leer el contador/);
    } finally { fs.chmodSync(E.contador('s-t6'), 0o644); }
  }
});

test('T7 EjecucionPerdida_CierreDeTurno_EventoDeCodex @story-8.318 @ac-7 — con turn_id y sin stop_hook_active: frena el primero, deja el segundo', () => {
  const E = entorno();
  const a = E.abrir('s-t7');
  E.perder('s-t7', a);
  assert.ok(frena(E.turno('s-t7', { turn_id: 'turno-1' })));
  assert.ok(!frena(E.turno('s-t7', { turn_id: 'turno-1' })));
});

// ── Comandos que andan (AC 8-12) ─────────────────────────────────────────────────────────────────────────────────────

const RUTA_ESTABLE = (home) => `node "${home}/.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js"`;

test('T8 Cartel_DaFormaDeVentanaYDeTerminal @story-8.318 @ac-8 — los cuatro comandos con la ruta absoluta entre comillas', () => {
  const or = require(OR);
  const home = path.join(os.tmpdir(), 'casa de prueba');
  const t = or.cartel({ sesion: 's-t8', story: '9.9', falta: 'copia', desde: '2026-11-19T10:00:00Z' }, { home });
  const n = RUTA_ESTABLE(home);
  for (const c of [`${n} clear-session s-t8 --lost`, `${n} restore s-t8`,
    `${n} clear-session s-t8 --lost --terminal --for-session s-t8`, `${n} restore s-t8 --terminal --for-session s-t8`]) {
    assert.ok(t.includes(c), `falta «${c}» en:\n${t}`);
  }
  assert.doesNotMatch(t, /~|versions[\\/]/);
});

test('T9 Cartel_SinSesionOCarpetaRara @story-8.318 @ac-8 — sin sesión da SIN_SESION_TERMINAL; con $ sale con $HOME y va en la terminal', () => {
  const or = require(OR);
  const { SIN_SESION_TERMINAL } = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  const sin = or.cartel({ sesion: '_nosession', story: '9.9', falta: 'copia' }, { home: '/casa' });
  assert.ok(sin.includes(SIN_SESION_TERMINAL), sin);
  assert.doesNotMatch(sin, /--for-session _nosession/);
  const rara = or.cartel({ sesion: 's-t9', story: '9.9', falta: 'copia' }, { home: '/casa$rara' });
  assert.match(rara, /"\$HOME\/\.claude\/agent-skills\/skills\/tycon-pipeline\/scripts\/marker\.js" restore s-t9 --terminal --for-session s-t9/);
  assert.match(rara, /va en la terminal/);
  assert.doesNotMatch(rara, /En la ventana de permiso/, 'sin la forma de la ventana');
});

test('T10 Cartel_MismasFormasEnLosSeisLugares @story-8.318 @ac-9 — el Stop, la consola, editar, el commit, marker.js set y el aviso del arranque', () => {
  const E = entorno();
  const a = E.abrir('s-t10');
  E.perder('s-t10', a);
  const n = RUTA_ESTABLE(E.home);
  const comandos = [`${n} clear-session s-t10 --lost`, `${n} restore s-t10`,
    `${n} clear-session s-t10 --lost --terminal --for-session s-t10`, `${n} restore s-t10 --terminal --for-session s-t10`];
  const stop = E.turno('s-t10');
  const textos = {
    stop: salida(stop).reason || stop.out,
    consola: E.consola('s-t10', 'echo x > src/b.js').out,
    editar: E.editar('s-t10').out,
    commit: E.commit('s-t10').out,
    set: E.marker('s-t10', ['set', JSON.stringify({ storyId: '9.9' })]).stderr,
    arranque: terminada(E, 's-t10') && require(path.join(SCRIPTS, 'lib', 'finished-open.js')).machine({ home: E.home, stateDir: E.estado(), isAlive: () => false })
      .items.map((i) => i.texto).join('\n'),
  };
  for (const [donde, t] of Object.entries(textos)) {
    for (const c of comandos) assert.ok(t.includes(c), `${donde}: falta «${c}» en:\n${t}`);
    assert.doesNotMatch(t, new RegExp(`node ${path.join(SCRIPTS, 'marker.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${donde}: arma la ruta con __dirname`);
  }
});

// el aviso del arranque nombra sólo las ejecuciones con todos sus pasos hechos: el marcador queda así
function terminada(E, sid) {
  const S = require(path.join(SCRIPTS, 'lib', 'steps.js'));
  const f = E.or.markerPath(sid, E.home);
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), scheme: 2, stepScheme: 2, stepsPending: [], stepsCompleted: S.STEPS.map((x) => x.id) }));
  return true;
}

test('T11 Cartel_RutaEstable_ConVersionesEnlazadas @story-8.318 @ac-10 — el gancho lanzado desde versions/<v>/ no imprime esa carpeta', () => {
  const E = entorno();
  const a = E.abrir('s-t11');
  E.perder('s-t11', a);
  const v = path.join(E.home, '.tycon', 'versions', '9.9.9');
  fs.mkdirSync(path.dirname(v), { recursive: true });
  fs.symlinkSync(RAIZ, v, WIN ? 'junction' : 'dir');
  const r = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', path.join(v, 'skills', 'tycon-pipeline', 'scripts', 'on-stop-dod-gate.js')], {
    input: JSON.stringify({ session_id: 's-t11', cwd: E.repo, hook_event_name: 'Stop' }), env: E.env(null, { TYCON_RELEASE_LINKS: '1' }), encoding: 'utf8',
  });
  const t = salida({ stdout: r.stdout || '' }).reason || '';
  assert.match(t, PERDIDA, r.stdout + r.stderr);
  assert.doesNotMatch(t, /versions[\\/]/);
  assert.ok(t.includes(RUTA_ESTABLE(E.home)), t);
});

test('T12 Cartel_DiceCuandoNoHayVentana @story-8.318 @ac-11 — no dice «no el agente»; nombra la consola Bash, PowerShell y Codex', () => {
  const t = require(OR).cartel({ sesion: 's-t12', story: '9.9', falta: 'copia' }, { home: '/casa' });
  assert.doesNotMatch(t, /no el agente/);
  assert.match(t, /el agente la lanza por la consola Bash y la persona la aprueba en el cuadro/);
  assert.match(t, /consola PowerShell de la herramienta o en Codex no hay cuadro/);
});

test('T13 Cartel_ComandoImpreso_CorreEnPowerShell51PwshYCmd @story-8.318 @ac-12 @story-8.319 @ac-9 — cada comando impreso, con get, llega a marker.js en las tres consolas', { skip: !WIN && 'sólo en Windows: la corre el trabajo windows de la CI del pedido' }, () => {
  // una carpeta personal y un archivo con espacio y acento: el rojo aparece aunque la máquina no los tenga (8.319, AC 9)
  const E = entorno({ nombreCasa: 'Carpeta Ñandú' });
  const or = require(OR);
  const { salidas } = or.formasDeSalida({ sesion: 's-t13' }, { home: E.home });
  const conGet = [];
  for (const x of salidas) {
    for (const forma of [x.ventana, x.terminal]) conGet.push(forma.replace(/ (?:clear-session s-t13 --lost|restore s-t13)/, ' get'));
  }
  // la 8.319: la forma de la terminal de una firma sobre un archivo, y la del arreglo rápido con --repo
  const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));
  const archivo = path.join(E.base, 'Carpeta Ñandú', 'a b.md');
  const firma = ow.formasDeFirmar('ALLOW_DOD_EVIDENCE_WRITE', archivo, 's-t13', { casa: E.home }).terminal;
  assert.ok(firma, 'la forma de la terminal de sign-file');
  conGet.push(firma.replace(' sign-file ALLOW_DOD_EVIDENCE_WRITE ', ' get '));
  const { signatureCommand } = require(path.join(SCRIPTS, 'lib', 'home-command.js'));
  conGet.push(`${signatureCommand('.claude/agent-skills/skills/tycon-pipeline/scripts/marker.js', E.home)} get --reason "arreglo de prueba" --data sin-cambio --file src/a.js --terminal --for-session s-t13 --repo "${E.repo}"`);
  const consolas = [
    ['powershell.exe', (c) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c], { encoding: 'utf8', env: E.env('s-t13') })],
    ['pwsh', (c) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', c], { encoding: 'utf8', env: E.env('s-t13') })],
    ['cmd.exe', (c) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${c}"`], { encoding: 'utf8', env: E.env('s-t13'), windowsVerbatimArguments: true })],
  ];
  for (const [nombre, correr] of consolas) {
    for (const c of conGet) {
      const r = correr(c);
      assert.ok(!(r.error && r.error.code === 'ENOENT'), `falta ${nombre} en esta máquina`);
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert.doesNotMatch(out, /MODULE_NOT_FOUND|Cannot find module|no se reconoce|is not recognized|ParserError/, `${nombre}: ${c}\n${out}`);
      assert.ok(r.status !== null, `${nombre}: ${c} no terminó`);
    }
  }
});

// ── Frenar antes de perder la ejecución (AC 13-17, 20) ─────────────────────────────────────────────────────────────

test('T14 WorktreeRemove_ConEjecucionAbierta_Frena @story-8.318 @ac-13 — remove, --force y git -C <principal> worktree remove <relativa>', () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  E.abrir('s-t14', wt);
  for (const c of [`git worktree remove ${wt}`, `git worktree remove --force ${wt}`, `git -C ${E.repo} worktree remove ../repo-wt-a`]) {
    const r = E.consola('s-t14', c, E.base);
    assert.ok(frena(r), `${c}: ${r.out}`);
    assert.match(r.out, ANTES, c);
    assert.ok(r.out.includes(`${RUTA_ESTABLE(E.home)} clear`), r.out);
  }
  assert.ok(fs.existsSync(wt));
  assert.ok(E.renglones().some((l) => l.kind === 'borra-ejecucion-abierta'), 'anotado en gates.log');
});

test('T15 MoverCarpetaConEjecucionAbierta_Frena @story-8.318 @ac-13 — git worktree move, mv, Move-Item y Rename-Item', () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  E.abrir('s-t15', wt);
  for (const [c, tool] of [[`git worktree move ${wt} ${wt}-2`, 'Bash'], [`mv ${wt} ${wt}-2`, 'Bash'], [`Move-Item ${wt} ${wt}-2`, 'PowerShell'], [`Rename-Item ${wt} repo-wt-b`, 'PowerShell']]) {
    const r = E.consola('s-t15', c, E.base, tool);
    assert.ok(frena(r), `${c}: ${r.out}`);
    assert.match(r.out, ANTES, c);
  }
});

test('T16 RmCarpetaConEjecucionAbierta_Frena @story-8.318 @ac-13 — rm -rf de la carpeta y la de arriba, Remove-Item, rd y cmd /c rmdir; de otra sesión nombra clear-session', () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  E.abrir('s-otra', wt);
  const casos = [[`rm -rf ${wt}`, 'Bash'], [`rm -r ${E.base}`, 'Bash'], [`Remove-Item -Recurse -Force ${wt}`, 'PowerShell'],
    [`Remove-Item -LiteralPath "${wt}" -Recurse`, 'PowerShell'], [`rd /s /q ${wt}`, 'PowerShell'], [`cmd /c rmdir /s /q ${wt}`, 'PowerShell']];
  for (const [c, tool] of casos) {
    const r = E.consola('s-t16', c, E.repo, tool);
    assert.ok(frena(r), `${c}: ${r.out}`);
    assert.match(r.out, ANTES, c);
    assert.ok(r.out.includes(`${RUTA_ESTABLE(E.home)} clear-session s-otra`), `${c}: ${r.out}`);
    assert.match(r.out, /story 9\.9 \(sesión s-otra\)/);
  }
  assert.ok(fs.existsSync(wt));
});

test('T16b BorrarCarpeta_FormasDelPaseAdversarial @story-8.318 @ac-13 @ac-15 — las que el pase encontró: frenan las que borran, pasan las que no', () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  E.abrir('s-otra', wt);
  const frenan = [
    [`mv -T ${wt} ${wt}-2`, 'Bash'], [`if true; then rm -rf ${wt}; fi`, 'Bash'], [`time rm -rf ${wt}`, 'Bash'], [`! rm -rf ${wt}`, 'Bash'],
    [`for x in 1; do rm -rf ${wt}; done`, 'Bash'], [`{ rm -rf ${wt}; }`, 'Bash'], ['rm -rf {nada,repo-wt-a}', 'Bash'], ['rm -rf $PWD/repo-wt-a', 'Bash'],
    ['rm -rf "$(pwd)/repo-wt-a"', 'Bash'], ['rm -rf ./repo-wt-$X', 'Bash'], [`Remove-Item ${E.base}/nada,${wt} -Recurse`, 'PowerShell'],
    ['(cd repo && rm -rf ../repo-wt-a)', 'Bash'], ['pushd repo; rm -rf ../repo-wt-a', 'Bash'], [`bash -c "rm -rf ${wt}"`, 'Bash'],
    [`git -C /no/existe -C ${E.repo} worktree remove ../repo-wt-a`, 'Bash'],
    // la segunda vuelta del pase
    [`echo x | xargs rm -rf ${wt}`, 'Bash'], [`find ${wt} -maxdepth 0 -exec rm -rf {} +`, 'Bash'],
    [`Move-Item -Path ${wt} -Destination ${wt}-2`, 'PowerShell'], [`Rename-Item -LiteralPath ${wt} -NewName repo-wt-b`, 'PowerShell'],
    [`rni ${wt} repo-wt-b`, 'PowerShell'], [`bash -c 'cd ${E.repo} && rm -rf ../repo-wt-a'`, 'Bash'],
    // la tercera vuelta
    [`cd ${E.repo} >/dev/null 2>&1 && rm -rf ../repo-wt-a`, 'Bash'], [`cd ${wt} && rm -rf $(pwd)`, 'Bash'], [`trash ${wt}`, 'Bash'],
    [`rd /s/q ${wt}`, 'PowerShell'], [`eval rm -rf ${wt}`, 'Bash'], ['rm -rf repo-wt-"a"', 'Bash'], ['rm -rf repo-wt\\-a', 'Bash'],
    ['rm -rf repo-wt-*', 'Bash'], [`mv -vt /tmp ${wt}`, 'Bash'],
    // la cuarta vuelta
    [`sudo -u nadie rm -rf ${wt}`, 'Bash'], [`env -u X rm -rf ${wt}`, 'Bash'], [`time -p rm -rf ${wt}`, 'Bash'], [`rm -rf \\\n  ${wt}`, 'Bash'],
    [`find -L ${wt} -exec rm -rf {} +`, 'Bash'], ['rm -rf "${PWD:?}/repo-wt-a"', 'Bash'], ['rm -rf repo-wt-{a..c}', 'Bash'],
    [`cd "${E.base}" && rm -rf repo-wt-a`, 'Bash'],
  ];
  for (const [c, tool] of frenan) {
    const r = E.consola('s-t16b', c, E.base, tool);
    assert.match(r.out, ANTES, `${c}: ${r.out}`);
  }
  // `rm -rf *` adentro de la carpeta de trabajo no se lleva `.advisors`: el comodín no casa con un nombre con punto
  const adentro = E.consola('s-t16b', 'rm -rf *', wt);
  assert.doesNotMatch(adentro.out, ANTES, adentro.out);
  const pasan = [`echo "rm -rf ${wt}"`, `rm -f ${wt}`, 'rm -rf nada-*', `git -C ${E.repo} worktree prune`, `find ${E.base} -name '*.tmp' -exec rm -rf {} +`, 'git worktree prune --dry-run', 'git worktree prune -n', `rmdir ${wt}`, `git commit -m "git worktree remove ${wt}"`];
  for (const c of pasan) {
    const r = E.consola('s-t16b', c, c.startsWith('git worktree') ? E.repo : E.base);
    assert.doesNotMatch(r.out, ANTES, `${c}: ${r.out}`);
  }
});

test('T16c BorrarCarpeta_SinRetrocesoNiEscapeIncompleto @story-8.318 @ac-13 — CodeQL del pedido: el freno no se cuelga y cita bien', () => {
  const gate = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
  // las dos entradas que hacían retroceder la expresión de los envoltorios, y la de las palabras de control
  // crece en línea con el largo: cuatro veces más largo tarda a lo sumo unas ocho veces más (una que retrocede, miles),
  // y nunca más de 10 s. Un tope fijo depende de la máquina: en la CI esto tarda el doble
  // la mediana de tres: una pausa del recolector en una sola medida no la vuelve roja
  const una = (texto) => { const t0 = process.hrtime.bigint(); gate.carpetasQueBorraOMueve(texto); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const mide = (texto) => [una(texto), una(texto), una(texto)].sort((a, b) => a - b)[1];
  for (const [cabeza, pieza] of [['env', ' -/env'], ['env', ' -c 0'], ['if', ' ( '], ['then', '  ']]) {
    mide(`${cabeza}${pieza.repeat(500)}`);
    const corto = mide(`${cabeza}${pieza.repeat(5000)}`);
    const largo = mide(`${cabeza}${pieza.repeat(20000)}`);
    assert.ok(largo < 10000 && largo < corto * 8 + 300, `${cabeza}${pieza}…: ${Math.round(corto)} ms con 5000 y ${Math.round(largo)} ms con 20000`);
  }
  // un comodín con muchas estrellas no cuelga la comparación con la ejecución abierta
  const or = require(OR);
  const t1 = Date.now();
  assert.strictEqual(or.casaConComodin(`/a/${'b'.repeat(3000)}c`, `/a/${'*b'.repeat(40)}*x`), true, 'con muchas estrellas vale la carpeta fija: frena de más');
  assert.ok(Date.now() - t1 < 2000);
  // una ruta con barra invertida y comilla detrás de xargs: la palabra vuelve igual
  const raro = 'a\\"b';
  const r = gate.carpetasQueBorraOMueve(`echo x | xargs rm -rf '${raro}'`);
  assert.deepStrictEqual(r.rutas.map((x) => x.raw), [raro]);
  // y los envoltorios siguen viéndose
  assert.deepStrictEqual(gate.carpetasQueBorraOMueve('sudo -u nadie nice -5 env -u X rm -rf /a/wt').rutas.map((x) => x.raw), ['/a/wt']);
});

test('T17b WorktreePrune_RutaPorUnEnlace_Frena @story-8.318 @ac-14 — la apertura anotada por un enlace y git con la ruta real', { skip: WIN && 'los enlaces de carpeta no se arman igual en Windows' }, () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  const enlace = path.join(E.base, 'enlace');
  fs.symlinkSync(E.base, enlace, 'dir');
  E.or.abrir({ sid: 's-otra', story: '9.9', repo: path.join(enlace, 'repo-wt-a'), runDir: path.join(enlace, 'repo-wt-a', '.advisors', 'pipeline-runs', '9.9-x'), home: E.home });
  fs.rmSync(wt, { recursive: true, force: true });
  const r = E.consola('s-t17b', 'git worktree prune', E.repo);
  assert.match(r.out, ANTES, r.out);
});

test('T17 WorktreePrune_ConEjecucionAbiertaEnLaLista_Frena @story-8.318 @ac-14 — poda una carpeta con la apertura vigente; sin ninguna, pasa; sin el campo prunable, frena', () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  const a = E.abrir('s-otra', wt);
  fs.rmSync(wt, { recursive: true, force: true });
  const r = E.consola('s-t17', 'git worktree prune', E.repo);
  assert.ok(frena(r), r.out);
  assert.match(r.out, ANTES);
  assert.ok(r.out.includes(a.runDir), r.out);
  // sin ninguna carpeta así (la ejecución ya cerrada), pasa
  E.or.cerrar({ sid: 's-otra', sesion: 's-otra', home: E.home, motivo: 'prueba' });
  const p = E.consola('s-t17', 'git worktree prune', E.repo);
  assert.ok(!frena(p), p.out);
  if (WIN) return;
  // un git sin el campo prunable (anterior a 2.31), con una ejecución abierta en la máquina: frena y lo dice
  E.abrir('s-viva');
  const bin = path.join(E.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf 'worktree %s\\nHEAD 0000\\nbranch refs/heads/main\\n\\nworktree %s\\nHEAD 0000\\nbranch refs/heads/feat/x\\n\\n' '${E.repo}' '${wt}'\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const viejo = E.gancho('on-bash-write-gate.js', 's-t17', { tool_name: 'Bash', tool_input: { command: 'git worktree prune' } }, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.ok(frena(viejo), viejo.out);
  assert.match(viejo.out, /no pude saber qué se poda/);
});

test('T18 BorrarSinEjecucionAbierta_Pasa @story-8.318 @ac-15 — sin copia, con la apertura cerrada y con una copia de antes del registro', () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  const formas = [`rm -rf ${wt}`, `git worktree remove --force ${wt}`, `mv ${wt} ${wt}-2`];
  const pasan = (que) => {
    for (const c of formas) {
      const r = E.consola('s-t18', c, E.base);
      assert.doesNotMatch(r.out, ANTES, `${que}: ${c}: ${r.out}`);
    }
  };
  pasan('sin copia');
  E.abrir('s-cerrada', wt);
  E.or.cerrar({ sid: 's-cerrada', sesion: 's-cerrada', home: E.home, motivo: 'prueba' });
  pasan('con la apertura cerrada');
  const vieja = path.join(wt, '.advisors', 'pipeline-runs', '9.9-vieja');
  fs.mkdirSync(vieja, { recursive: true });
  fs.writeFileSync(path.join(vieja, 'run-open.json'), JSON.stringify({ sesion: 's-vieja', story: '9.9', runDir: vieja, ts: '2026-01-01T00:00:00Z' }));
  pasan('con una copia de antes del registro');
});

test('T21 BorrarCarpeta_RegistroIlegible_Frena @story-8.318 @ac-17 — la consola frena con el motivo', { skip: (WIN || (process.getuid && process.getuid() === 0)) && 'los permisos de lectura no se niegan igual en Windows ni como root' }, () => {
  const E = entorno();
  const wt = carpetaDeTrabajo(E);
  E.abrir('s-otra', wt);
  fs.chmodSync(E.gates(), 0o000);
  try {
    const r = E.consola('s-t21', `rm -rf ${wt}`, E.base);
    assert.ok(frena(r), r.out);
    assert.match(r.out, /no pude leer el registro de aperturas/);
  } finally { fs.chmodSync(E.gates(), 0o644); }
});

test('T23 SalidaPerdida_FirmaLostRunSinCambios @story-8.318 @ac-19 @ac-20 — clear-session --lost y restore sin firma no salen; un borrado suelto no lee gates.log', () => {
  const E = entorno();
  const a = E.abrir('s-t23');
  E.perder('s-t23', a);
  for (const args of [['clear-session', 's-t23', '--lost'], ['restore', 's-t23']]) {
    const r = E.marker('s-t23', args);
    assert.notStrictEqual(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(E.or.markerPath('s-t23', E.home)), `${args.join(' ')} no cerró sin la firma`);
  }
  // una ejecución sana: borrar un archivo suelto no frena ni lee gates.log (con el registro ilegible, no frena)
  const F = entorno();
  F.abrir('s-sana');
  // la casa de la prueba antes de cargar el freno: su carpeta del estado sale de la casa al cargarlo
  const casa = process.env.HOME;
  process.env.HOME = F.home;
  const gate = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
  const leidos = [];
  const leer = fs.readFileSync;
  fs.readFileSync = function (p, ...r) { if (String(p).endsWith('gates.log')) leidos.push(p); return leer.call(this, p, ...r); };
  try {
    assert.strictEqual(gate.borraEjecucionAbierta({ tool_name: 'Bash', session_id: 's-sana', cwd: F.repo, tool_input: { command: 'rm src/a.js' } }), null);
    assert.strictEqual(gate.borraEjecucionAbierta({ tool_name: 'Bash', session_id: 's-sana', cwd: F.repo, tool_input: { command: 'ls -la' } }), null);
    // lo que sólo toca lo versionado o borra por nombre no se lee como borrar la carpeta
    for (const c of ['git checkout -- .', 'git restore .', 'git rm -r src', "find . -name '*.tmp' -delete"]) {
      assert.strictEqual(gate.borraEjecucionAbierta({ tool_name: 'Bash', session_id: 's-sana', cwd: F.repo, tool_input: { command: c } }), null, c);
    }
  } finally { fs.readFileSync = leer; process.env.HOME = casa; }
  assert.deepStrictEqual(leidos, [], 'no leyó gates.log');
  // borrar la carpeta de las ejecuciones del repo sí frena: ahí vive la copia
  const r = F.consola('s-sana', 'rm -rf .advisors');
  assert.ok(frena(r), r.out);
  assert.match(r.out, ANTES);
});

// ── Las guías (AC 21) ────────────────────────────────────────────────────────────────────────────────────────────────

test('T24 Guias_DicenLaEsperaYElBorrado @story-8.318 @ac-21 — safety-guard.md y el paso 11', () => {
  const guia = fs.readFileSync(path.join(RAIZ, 'guides', 'safety-guard.md'), 'utf8');
  const seccion = guia.slice(guia.indexOf('La ejecución perdida'));
  assert.match(seccion, /a la segunda/);
  assert.match(seccion, /--terminal --for-session/);
  assert.match(seccion, /siguen frenados/);
  assert.match(seccion, /marker\.js clear` antes de borrar/);
  const paso = fs.readFileSync(path.join(SCRIPTS, '..', 'steps', 'step-11-prepare-commit.md'), 'utf8');
  assert.match(paso, /antes de borrar o mover su carpeta/);
});
