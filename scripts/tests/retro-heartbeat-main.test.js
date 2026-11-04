'use strict';
// retro-heartbeat-main.test.js — un latido de retrospectiva es sólo de un commit que entró a main, y uno falso se anula
// sin borrarlo. El reclamo de un pedido abierto espera a que entre y entonces pide el commit que dejó en main
// (scripts/hooks/retro-pending.js); el latido rechaza lo que no está en la línea de main y anula con quién, cuándo y por
// qué (scripts/metrics/retro-heartbeat.js); un latido anulado no cuenta para nadie (retro-coverage.js, weekly-review.js,
// dashboard-metrics.js, sdlc-stage-metrics.js, el tablero). Repos de juguete con git de verdad, `az` y `gh` de mentira en
// el PATH, y un buzón de mentira en el mismo proceso. Sin red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const HEARTBEAT = path.join(ROOT, 'scripts', 'metrics', 'retro-heartbeat.js');
const UPLOAD = path.join(ROOT, 'scripts', 'metrics', 'upload-runs.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'latido-main-'))); dirs.push(d); return d; };

function env(home, extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD|CLAUDE_|CODEX_|GH_|AZURE_)/.test(k)) e[k] = v;
  return { ...e, HOME: home, USERPROFILE: home, TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS: '100000', TYCON_RETRO_ASK_REMOTE: '0',
    TYCON_PROFILE: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'sin-global'),
    GIT_AUTHOR_NAME: 'Persona B', GIT_AUTHOR_EMAIL: 'b@example.com', GIT_COMMITTER_NAME: 'Persona B', GIT_COMMITTER_EMAIL: 'b@example.com',
    GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00', ...extra };
}
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(os.tmpdir()), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(dir, nombre) {
  fs.writeFileSync(path.join(dir, nombre), `${nombre}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', nombre]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * La forma del caso del reporte, con nombres inventados (repo `acme-backend`): main con un commit directo y una fusión,
 * dev con tres fusiones a dev, y una rama con un pedido abierto que no entró. Sin remoto: la línea de main es `main`.
 */
function repoDelCaso(base = tmp()) {
  const dir = path.join(base, 'acme-backend');
  fs.mkdirSync(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Persona B']);
  fs.mkdirSync(path.join(dir, '.tycon'));
  fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), '');
  commit(dir, 'base.txt');
  const directo = commit(dir, 'directo.txt');
  git(dir, ['checkout', '--quiet', '-b', 'dev']);
  const fusionesADev = [];
  for (const n of [1, 2, 3]) {
    git(dir, ['checkout', '--quiet', '-b', `tarea-${n}`]);
    commit(dir, `tarea-${n}.txt`);
    git(dir, ['checkout', '--quiet', 'dev']);
    git(dir, ['merge', '--quiet', '--no-ff', '-m', `fusión de tarea-${n} a dev`, `tarea-${n}`]);
    fusionesADev.push(git(dir, ['rev-parse', 'HEAD']));
  }
  git(dir, ['checkout', '--quiet', '-b', 'pedido-abierto', 'main']);
  const puntaDeRama = commit(dir, 'rama.txt');
  git(dir, ['checkout', '--quiet', 'main']);
  git(dir, ['merge', '--quiet', '--no-ff', '-m', 'fusión de dev a main', 'dev']);
  const fusionAMain = git(dir, ['rev-parse', 'HEAD']);
  return { dir, directo, fusionAMain, fusionesADev, puntaDeRama };
}

/** `az` y `gh` de mentira: contestan lo que diga `<bin>/respuesta-<az|gh>` y anotan cada llamada en `<bin>/llamadas`. */
function binDeMentira(base, { conGit = true } = {}) {
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const herramienta of ['az', 'gh']) {
    const archivo = path.join(bin, herramienta);
    fs.writeFileSync(archivo, `#!/bin/sh
echo "${herramienta} $*" >> "${bin}/llamadas"
R="${bin}/respuesta-${herramienta}"
[ -f "${bin}/demora" ] && exec sleep "$(cat "${bin}/demora")"
[ -f "${bin}/error-${herramienta}" ] && { cat "${bin}/error-${herramienta}" >&2; exit 1; }
[ -f "$R" ] && cat "$R"
exit 0
`);
    fs.chmodSync(archivo, 0o755);
  }
  if (!conGit) for (const h of ['az', 'gh']) fs.rmSync(path.join(bin, h));
  return bin;
}
const llamadas = (bin) => (fs.existsSync(path.join(bin, 'llamadas')) ? fs.readFileSync(path.join(bin, 'llamadas'), 'utf8').split('\n').filter(Boolean) : []);

/** Una copia del gancho con sus bibliotecas y un HOME propio. `bin` va adelante en el PATH. */
function laboratorio({ bin = null, extra = {} } = {}) {
  const base = tmp();
  const home = path.join(base, 'home');
  const arnes = path.join(base, 'arnes');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.mkdirSync(path.join(arnes, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(arnes, '.dashboard'));
  const gancho = path.join(arnes, 'scripts', 'hooks', 'retro-pending.js');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), gancho);
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(arnes, 'scripts', 'lib'), { recursive: true });
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  const ledger = path.join(estado, 'retro-pending.jsonl');
  const entorno = () => env(home, { ...(bin ? { PATH: `${bin}${path.delimiter}${process.env.PATH}` } : {}), ...extra });
  const correr = (evento, mas = {}) => {
    const r = spawnSync(process.execPath, [gancho], { input: JSON.stringify(evento), env: { ...entorno(), ...mas }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const renglones = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    home, estado, ledger, gancho, entorno,
    dashboard: path.join(arnes, '.dashboard'),
    pedido: (command, cwd, salida, mas) => correr({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd,
      ...(salida === undefined ? {} : { tool_response: { stdout: salida, stderr: '', interrupted: false } }) }, mas),
    cierre: (cwd, mas, sesion = 's1') => correr({ session_id: sesion, hook_event_name: 'Stop', stop_hook_active: false, cwd }, mas),
    arranque: (cwd, mas) => correr({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup', cwd }, mas),
    renglones,
    entradas: () => renglones().filter((e) => e.repoPath),
    sembrar: (entrada) => fs.appendFileSync(ledger, `${JSON.stringify({ ts: '2026-10-05T10:00:00.000Z', sessionId: 'otra', branch: 'main', cmd: 'gh pr create --base main --head dev', sha: 'abc123def456', ...entrada })}\n`),
  };
}
const motivoDelCierre = (r) => (r.stdout ? JSON.parse(r.stdout).reason : '');

/** Un latido válido de `sha` en `repo`, escrito a mano en `dir` (el formato del latido real). */
function latido(dir, repo, sha, { anulado = null, vueltas = null, nombre = null } = {}) {
  const { METRICS } = require(path.join(ROOT, 'scripts', 'lib', 'dashboard-metrics.js'));
  const metrics = {};
  for (const k of Object.keys(METRICS)) metrics[k] = { value: null, unavailable_reason: 'no la mide esta prueba' };
  if (vueltas !== null) metrics.advisor_rerun_loop_iterations = { value: vueltas };
  const doc = { schema_version: '2.0', project: 'acme-backend', captured_at: '2026-10-25', ts: '2026-10-25T10:00:00.000Z', repo, merge_commit: sha,
    story: null, generated_by: ['retro', 'latido.js'].join('-'), metrics, ...(anulado ? { anulado } : {}) };
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, nombre || `metrics-2026-10-25-acme-backend-adhoc-${sha.slice(0, 7)}.json`);
  fs.writeFileSync(archivo, JSON.stringify(doc, null, 2) + '\n');
  return archivo;
}
const ANULADO = { quien: 'Persona B', cuando: '2026-11-03T22:00:00.000Z', motivo: 'fusión a dev' };

function latidoReal(args, home, extra = {}) {
  const r = spawnSync(process.execPath, [HEARTBEAT, ...args], { env: env(home, extra), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ── qué se reclama ───────────────────────────────────────────────────────────────────────────────

test('T1 Pedido_Anota_NumeroYEsperando: el número del pedido de az y de gh, y sin número como hoy', () => {
  const { dir } = repoDelCaso();
  const lab = laboratorio({ extra: { TYCON_RETRO_ASK_PR: '0' } });
  git(dir, ['checkout', '--quiet', 'pedido-abierto']);
  const az = lab.pedido('az repos pr create --source-branch pedido-abierto --target-branch main', dir, JSON.stringify({ pullRequestId: 101, status: 'active' }, null, 2));
  let e = lab.entradas().pop();
  assert.strictEqual(e.pr, 101, az.stderr);
  assert.strictEqual(e.estado, 'esperando');
  assert.strictEqual(e.plataforma, 'azure');
  assert.match(az.stderr, /pedido 101[^\n]*esperando que entre/);
  assert.doesNotMatch(az.stderr, /retro-heartbeat\.js/, 'un pedido abierto no pide el latido');

  git(dir, ['checkout', '--quiet', '-b', 'otra-rama']);
  commit(dir, 'otra.txt');
  lab.pedido('gh pr create --base main --title t --body b', dir, 'https://github.com/acme/acme-backend/pull/57\n');
  e = lab.entradas().pop();
  assert.strictEqual(e.pr, 57);
  assert.strictEqual(e.estado, 'esperando');
  assert.strictEqual(e.plataforma, 'github');

  git(dir, ['checkout', '--quiet', '-b', 'tercera']);
  commit(dir, 'tercera.txt');
  const sin = lab.pedido('az repos pr create --source-branch tercera --target-branch main', dir, 'algo que no es JSON');
  e = lab.entradas().pop();
  assert.strictEqual(e.pr, undefined);
  assert.strictEqual(e.estado, undefined);
  assert.match(sin.stderr, /no pude leer el número del pedido/);
});

function pedidoEsperando(lab, dir, salida = JSON.stringify({ pullRequestId: 101 })) {
  git(dir, ['checkout', '--quiet', 'pedido-abierto']);
  lab.pedido('az repos pr create --source-branch pedido-abierto --target-branch main', dir, salida);
  git(dir, ['checkout', '--quiet', 'main']);
  return lab.entradas().pop();
}

test('T2 Pedido_Esperando_NoFrenaElCierre', () => {
  const { dir } = repoDelCaso();
  const lab = laboratorio({ extra: { TYCON_RETRO_ASK_PR: '0' } });
  pedidoEsperando(lab, dir);
  const r = lab.cierre(dir);
  assert.strictEqual(r.stdout, '', `no frena: ${r.stdout}`);
});

test('T3 Pedido_Entro_ReclamaElCommitDeMain: la entrada reclama el commit de main, y su latido la cubre', () => {
  const caso = repoDelCaso();
  const base = tmp();
  const bin = binDeMentira(base);
  const lab = laboratorio({ bin });
  pedidoEsperando(lab, caso.dir);
  fs.writeFileSync(path.join(bin, 'respuesta-az'), JSON.stringify({ status: 'completed', merge: caso.fusionAMain }));
  const r = lab.cierre(caso.dir);
  const motivo = motivoDelCierre(r);
  assert.match(motivo, new RegExp(caso.fusionAMain.slice(0, 12)), `reclama el commit de main: ${r.stdout}${r.stderr}`);
  assert.doesNotMatch(motivo, new RegExp(caso.puntaDeRama.slice(0, 12)), 'no la punta de la rama');
  const cambio = lab.renglones().find((l) => l.tipo === 'pedido');
  assert.strictEqual(cambio.estado, 'entro');
  assert.ok(caso.fusionAMain.startsWith(cambio.merge));
  latido(lab.dashboard, caso.dir, caso.fusionAMain);
  assert.strictEqual(lab.cierre(caso.dir).stdout, '', 'cubierta por el latido del commit de main');
});

test('T4 Pedido_Consulta_TopeYUnaCadaDiezMinutos: corta en el tope y no vuelve a consultar antes de diez minutos', () => {
  const { dir } = repoDelCaso();
  const bin = binDeMentira(tmp());
  fs.writeFileSync(path.join(bin, 'demora'), '5');
  fs.writeFileSync(path.join(bin, 'respuesta-az'), JSON.stringify({ status: 'completed', merge: 'x' }));
  const lab = laboratorio({ bin, extra: { TYCON_RETRO_ASK_PR_MS: '400' } });
  pedidoEsperando(lab, dir);
  const t0 = Date.now();
  const r1 = lab.cierre(dir);
  assert.ok(Date.now() - t0 < 4000, `cortó en el tope (${Date.now() - t0} ms)`);
  assert.strictEqual(r1.stdout, '', 'una consulta que no contesta no frena');
  assert.strictEqual(llamadas(bin).length, 1);
  assert.ok(fs.existsSync(path.join(lab.estado, 'retro-pending-consultas.json')));
  lab.cierre(dir);
  assert.strictEqual(llamadas(bin).length, 1, 'la segunda vez, antes de diez minutos, no consulta');
  // un archivo de consultas roto no frena: se consulta de nuevo
  fs.writeFileSync(path.join(lab.estado, 'retro-pending-consultas.json'), '{roto');
  lab.cierre(dir);
  assert.strictEqual(llamadas(bin).length, 2);
});

test('T5 Pedido_Abandonado_SeCierra: abandonado en Azure y cerrado sin entrar en GitHub', () => {
  for (const [plataforma, respuesta, comando, salida] of [
    ['az', { status: 'abandoned', merge: null }, 'az repos pr create --source-branch pedido-abierto --target-branch main', JSON.stringify({ pullRequestId: 101 })],
    ['gh', { state: 'CLOSED', mergeCommit: null }, 'gh pr create --base main --title t --body b', 'https://github.com/acme/acme-backend/pull/101\n'],
  ]) {
    const { dir } = repoDelCaso();
    const bin = binDeMentira(tmp());
    const lab = laboratorio({ bin });
    git(dir, ['checkout', '--quiet', 'pedido-abierto']);
    lab.pedido(comando, dir, salida);
    git(dir, ['checkout', '--quiet', 'main']);
    fs.writeFileSync(path.join(bin, `respuesta-${plataforma}`), JSON.stringify(respuesta));
    assert.strictEqual(lab.cierre(dir).stdout, '', plataforma);
    const cambio = lab.renglones().find((l) => l.tipo === 'pedido');
    assert.strictEqual(cambio && cambio.estado, 'abandonado', plataforma);
    assert.match(cambio.motivo, /el pedido 101 se abandonó: no hay fusión que reclamar/);
    const a = lab.arranque(dir, { TYCON_RETRO_PENDING_MIN_AGE_MIN: '0' });
    assert.doesNotMatch(a.stdout, /101/, `${plataforma}: no se reclama nunca más`);
    const antes = llamadas(bin).length;
    lab.cierre(dir);
    assert.strictEqual(llamadas(bin).length, antes, `${plataforma}: cerrada, no se consulta más`);
  }
});

test('T6 Pedido_NoSePudoConsultar_AvisoSinFrenar: sin la herramienta y con error de permiso', () => {
  for (const sinHerramienta of [true, false]) {
    const { dir } = repoDelCaso();
    const bin = binDeMentira(tmp(), { conGit: !sinHerramienta });
    if (!sinHerramienta) fs.writeFileSync(path.join(bin, 'error-az'), 'ERROR: TF400813: The user is not authorized to access this resource.');
    // sin la herramienta: un PATH con sólo git
    const soloGit = path.join(tmp(), 'sologit');
    fs.mkdirSync(soloGit);
    fs.symlinkSync(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(), path.join(soloGit, 'git'));
    const lab = laboratorio(sinHerramienta ? { extra: { PATH: soloGit } } : { bin });
    pedidoEsperando(lab, dir);
    assert.strictEqual(lab.cierre(dir).stdout, '', 'no frena');
    const a = lab.arranque(dir, { TYCON_RETRO_PENDING_MIN_AGE_MIN: '0' });
    assert.match(a.stdout, /no sé si el pedido 101 entró: /, a.stdout);
    if (!sinHerramienta) assert.match(a.stdout, /not authorized|permiso|TF400813/);
  }
});

test('T7 PushDirecto_ComoHoy: un push a main se anota y se reclama ese commit', () => {
  const base = tmp();
  const remoto = path.join(base, 'remoto.git');
  git(base, ['init', '--quiet', '--bare', '-b', 'main', remoto]);
  const { dir } = repoDelCaso(base);
  git(dir, ['remote', 'add', 'origin', remoto]);
  git(dir, ['push', '--quiet', 'origin', 'main']);
  const nuevo = commit(dir, 'nuevo.txt');
  git(dir, ['push', '--quiet', 'origin', 'main']);
  const lab = laboratorio({ extra: { TYCON_RETRO_ASK_PR: '0' } });
  lab.pedido('git push origin main', dir);
  const e = lab.entradas().pop();
  assert.strictEqual(e.sha, nuevo.slice(0, 12));
  assert.strictEqual(e.pr, undefined);
  assert.match(motivoDelCierre(lab.cierre(dir)), new RegExp(nuevo.slice(0, 12)));
});

test('T8 EntradaVieja_FueraDeMain_NoFrenaYAvisaConCorregir', () => {
  const caso = repoDelCaso();
  const lab = laboratorio({ extra: { TYCON_RETRO_ASK_PR: '0' } });
  const deDev = caso.fusionesADev[1].slice(0, 12);
  const enMain = caso.directo.slice(0, 12);
  const anuladoEnMain = caso.fusionAMain.slice(0, 12);
  lab.sembrar({ repoPath: caso.dir, sha: deDev });
  lab.sembrar({ repoPath: caso.dir, sha: enMain });
  lab.sembrar({ repoPath: caso.dir, sha: anuladoEnMain, cmd: 'git push origin main' });
  latido(lab.dashboard, caso.dir, caso.fusionAMain, { anulado: ANULADO });
  // una que entró con un commit fuera de la línea de main
  const deDev3 = caso.fusionesADev[2].slice(0, 12);
  lab.sembrar({ repoPath: caso.dir, sha: caso.puntaDeRama.slice(0, 12), pr: 7, plataforma: 'azure', estado: 'esperando', cmd: 'az repos pr create -t main' });
  fs.appendFileSync(lab.ledger, `${JSON.stringify({ ts: '2026-10-06T10:00:00.000Z', tipo: 'pedido', entrada: { repo: caso.dir, sha: caso.puntaDeRama.slice(0, 12) }, estado: 'entro', merge: deDev3 })}\n`);

  const motivo = motivoDelCierre(lab.cierre(caso.dir));
  assert.match(motivo, new RegExp(enMain), 'la que está en main se reclama como hoy');
  for (const sha of [deDev, anuladoEnMain, deDev3]) assert.doesNotMatch(motivo, new RegExp(sha), `${sha} no frena`);
  const a = lab.arranque(caso.dir, { TYCON_RETRO_PENDING_MIN_AGE_MIN: '0' });
  for (const sha of [deDev, anuladoEnMain, deDev3]) {
    assert.match(a.stdout, new RegExp(`${sha}[^\\n]*\\n?[^\\n]*--correct`), `${sha} sale en el aviso con --correct: ${a.stdout}`);
  }
});

// ── qué acepta el latido ─────────────────────────────────────────────────────────────────────────

test('T9 Latido_FueraDeMain_Sale2: la punta de una rama sale 2 y no escribe', () => {
  const caso = repoDelCaso();
  const out = path.join(tmp(), 'salida');
  const r = latidoReal(['--repo', caso.dir, '--merge', caso.puntaDeRama, '--out', out], tmp());
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`${caso.puntaDeRama.slice(0, 7)} no está en la línea de main \\(main\\): un latido es de lo que entró`));
  assert.ok(!fs.existsSync(out) || !fs.readdirSync(out).length);
});

test('T10 Latido_SinPoderTraerMain_UsaLaLocalOSale2', () => {
  const caso = repoDelCaso();
  git(caso.dir, ['remote', 'add', 'origin', path.join(tmp(), 'no-existe.git')]);
  git(caso.dir, ['update-ref', 'refs/remotes/origin/main', caso.fusionAMain]);
  const home = tmp();
  let out = path.join(tmp(), 'salida');
  let r = latidoReal(['--repo', caso.dir, '--merge', caso.directo, '--out', out], home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /no pude traer main[^\n]*uso la referencia local origin\/main/);
  assert.strictEqual(fs.readdirSync(out).length, 1);

  // la local no trae el commit
  const nuevo = commit(caso.dir, 'despues.txt');
  out = path.join(tmp(), 'salida');
  r = latidoReal(['--repo', caso.dir, '--merge', nuevo, '--out', out], home);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no está en la línea de main \(origin\/main\)/);

  // ninguna referencia de main
  git(caso.dir, ['update-ref', '-d', 'refs/remotes/origin/main']);
  git(caso.dir, ['branch', '-m', 'main', 'trabajo']);
  r = latidoReal(['--repo', caso.dir, '--merge', caso.directo, '--out', path.join(tmp(), 'salida')], home);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no hay referencia de main/);
});

test('T11 Latido_EnLaLineaDeMain_Escribe: una fusión a main y un commit directo', () => {
  const caso = repoDelCaso();
  const out = path.join(tmp(), 'salida');
  for (const sha of [caso.fusionAMain, caso.directo]) {
    const r = latidoReal(['--repo', caso.dir, '--merge', sha, '--out', out], tmp());
    assert.strictEqual(r.status, 0, r.stderr);
  }
  assert.strictEqual(fs.readdirSync(out).length, 2);
});

test('T12 Latido_LosCuatroDelCaso_Sale2', () => {
  const caso = repoDelCaso();
  const out = path.join(tmp(), 'salida');
  for (const sha of [caso.puntaDeRama, ...caso.fusionesADev]) {
    const r = latidoReal(['--repo', caso.dir, '--merge', sha, '--out', out], tmp());
    assert.strictEqual(r.status, 2, `${sha}: ${r.stderr}`);
    assert.match(r.stderr, /un latido es de lo que entró/);
  }
  assert.ok(!fs.existsSync(out));
});

// ── anular sin borrar ────────────────────────────────────────────────────────────────────────────

test('T13 Anular_AgregaQuienCuandoMotivo', () => {
  const caso = repoDelCaso();
  const out = path.join(tmp(), 'salida');
  const archivo = latido(out, caso.dir, caso.fusionesADev[0]);
  const antes = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const r = latidoReal(['--annul', '--sha', caso.fusionesADev[0].slice(0, 7), '--reason', 'fusión a dev', '--repo', caso.dir, '--out', out], tmp());
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(archivo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.stdout, /anulado: sube como versión nueva en la próxima subida/);
  const despues = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  assert.strictEqual(despues.anulado.motivo, 'fusión a dev');
  assert.match(despues.anulado.quien, /Persona B/);
  assert.ok(!Number.isNaN(Date.parse(despues.anulado.cuando)));
  delete despues.anulado;
  assert.deepStrictEqual(despues, antes, 'el resto igual');
});

test('T14 Anular_SinMotivoOSinLatidoODosRepos_Sale2', () => {
  const caso = repoDelCaso();
  const out = path.join(tmp(), 'salida');
  const archivo = latido(out, caso.dir, caso.fusionesADev[0]);
  const original = fs.readFileSync(archivo, 'utf8');
  const sha = caso.fusionesADev[0].slice(0, 7);
  for (const args of [['--annul', '--sha', sha, '--out', out], ['--annul', '--sha', sha, '--reason', '   ', '--out', out]]) {
    const r = latidoReal(args, tmp());
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /--reason/);
  }
  // un archivo de latidos roto se nombra: el que había que anular podía ser ése
  fs.writeFileSync(path.join(out, 'metrics-2026-10-25-roto-adhoc-abcdef0.json'), '{roto');
  let r = latidoReal(['--annul', '--sha', 'abcdef0', '--reason', 'x', '--out', out], tmp());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /ningún latido/);
  assert.match(r.stderr, /no pude leer 1: [^\n]*metrics-2026-10-25-roto-adhoc-abcdef0\.json/);
  fs.rmSync(path.join(out, 'metrics-2026-10-25-roto-adhoc-abcdef0.json'));
  assert.strictEqual(fs.readFileSync(archivo, 'utf8'), original, 'no tocó nada');
  // el mismo commit en dos repos
  latido(out, '/otro/repo', caso.fusionesADev[0], { nombre: `metrics-2026-10-25-otro-adhoc-${sha}.json` });
  r = latidoReal(['--annul', '--sha', sha, '--reason', 'x', '--out', out], tmp());
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--repo/);
  assert.strictEqual(fs.readFileSync(archivo, 'utf8'), original);
});

test('T15 Anular_YaAnulado_Sale0SinCambiar', () => {
  const caso = repoDelCaso();
  const out = path.join(tmp(), 'salida');
  const archivo = latido(out, caso.dir, caso.fusionesADev[0], { anulado: ANULADO });
  const antes = fs.readFileSync(archivo, 'utf8');
  const r = latidoReal(['--annul', '--sha', caso.fusionesADev[0], '--reason', 'otra vez', '--out', out], tmp());
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ya está anulado desde 2026-11-03/);
  assert.strictEqual(fs.readFileSync(archivo, 'utf8'), antes);
});

test('T16 Validar_AnuladoCompletoOIncompleto', () => {
  const { validate, METRICS } = require(path.join(ROOT, 'scripts', 'lib', 'dashboard-metrics.js'));
  const metrics = {};
  for (const k of Object.keys(METRICS)) metrics[k] = { value: null, unavailable_reason: 'x' };
  const doc = (anulado) => ({ schema_version: '2.0', project: 'p', captured_at: '2026-10-25', repo: '/x/p', merge_commit: 'a'.repeat(40), metrics, anulado });
  assert.ok(validate(doc(ANULADO)).ok);
  const sinMotivo = validate(doc({ quien: 'q', cuando: '2026-11-03T22:00:00.000Z' }));
  assert.ok(!sinMotivo.ok);
  assert.match(sinMotivo.errors.join(' '), /anulado\.motivo/);
  const fechaRara = validate(doc({ quien: 'q', cuando: 'ayer', motivo: 'm' }));
  assert.ok(!fechaRara.ok);
  assert.match(fechaRara.errors.join(' '), /anulado\.cuando/);
});

test('T17 Subir_AnuladoVaComoVersionNueva: el anulado sube a merges/v<n>/ y la versión nueva lo trae', async () => {
  const base = tmp();
  const blobs = path.join(base, 'blobs');
  const srv = http.createServer((req, res) => {
    const trozos = [];
    req.on('data', (c) => trozos.push(c));
    req.on('end', () => {
      if (req.method !== 'PUT') { res.writeHead(403); return res.end(); }
      const destino = path.join(blobs, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (fs.existsSync(destino) && req.headers['if-none-match'] === '*') { res.writeHead(409); return res.end('<Error><Code>BlobAlreadyExists</Code></Error>'); }
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, Buffer.concat(trozos));
      res.writeHead(201); res.end();
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const cfg = path.join(base, 'cfg.json');
    const firma = ['FIRMA', '%2B', 'deprueba', '%3D'].join('');
    fs.writeFileSync(cfg, JSON.stringify({ cuenta: 'cuentadeprueba', contenedor: 'corridas', tenant: '00000000-0000-0000-0000-000000000000', politica: 'subida-prueba', vence: '2099-01-01', sas: `sv=2022-11-02&si=subida-prueba&sr=c&spr=https&sig=${firma}` }));
    const merges = path.join(base, 'merges');
    const sha = 'd'.repeat(40);
    const archivo = latido(merges, '/x/acme-backend', sha);
    const subir = () => new Promise((ok) => {
      const p = spawn(process.execPath, [UPLOAD, '--json'], { env: env(path.join(base, 'casa'), { TYCON_MAILBOX_JSON: cfg, TYCON_MAILBOX_URL_BASE: `http://127.0.0.1:${srv.address().port}`,
        TYCON_TIMING_HISTORY: path.join(base, 'no-existe'), TYCON_UPLOADS_LOG: path.join(base, 'estado', 'mailbox-uploads.json'), TYCON_MACHINE: 'maq-a', TYCON_MERGES_DIR: merges }) });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (status) => ok({ status, err }));
    });
    let r = await subir();
    assert.strictEqual(r.status, 0, r.err);
    const nombre = path.basename(archivo);
    assert.ok(fs.existsSync(path.join(blobs, 'corridas', 'maq-a', 'merges', nombre)));
    const a = latidoReal(['--annul', '--sha', sha, '--reason', 'fusión a dev', '--out', merges], path.join(base, 'casa'));
    assert.strictEqual(a.status, 0, a.stderr);
    r = await subir();
    assert.strictEqual(r.status, 0, r.err);
    const versiones = fs.readdirSync(path.join(blobs, 'corridas', 'maq-a', 'merges')).filter((d) => /^v\d{8}T\d{9}Z$/.test(d));
    assert.strictEqual(versiones.length, 1, 'una versión nueva');
    const subido = JSON.parse(fs.readFileSync(path.join(blobs, 'corridas', 'maq-a', 'merges', versiones[0], nombre), 'utf8'));
    assert.strictEqual(subido.anulado.motivo, 'fusión a dev');
    // la bajada se queda con la versión más nueva de cada archivo (download-runs.test.sh, T19): la anulada
    const viejo = JSON.parse(fs.readFileSync(path.join(blobs, 'corridas', 'maq-a', 'merges', nombre), 'utf8'));
    assert.strictEqual(viejo.anulado, undefined, 'la versión vieja queda como estaba: el buzón sólo crea');
  } finally { srv.close(); }
});

// ── lo que no cuenta ─────────────────────────────────────────────────────────────────────────────

test('T18 Cubierto_NoCuentaElAnulado: metricsIn, el reclamo, el barrido y la revisión de la semana', () => {
  const caso = repoDelCaso();
  const RC = require(path.join(ROOT, 'scripts', 'lib', 'retro-coverage.js'));
  const dir = path.join(tmp(), 'dash');
  latido(dir, caso.dir, caso.fusionAMain, { anulado: ANULADO });
  assert.strictEqual(RC.metricsIn(dir).length, 0, 'metricsIn no trae el anulado');
  assert.deepStrictEqual(RC.coveringRecords({ repoPath: caso.dir, sha: caso.fusionAMain }, [dir]), [], 'el barrido lo ve sin cubrir');
  // el reclamo: la entrada sólo cubierta por el anulado no queda cubierta (sale en el aviso, T8)
  const lab = laboratorio({ extra: { TYCON_RETRO_ASK_PR: '0' } });
  lab.sembrar({ repoPath: caso.dir, sha: caso.fusionAMain.slice(0, 12), cmd: 'git push origin main' });
  latido(lab.dashboard, caso.dir, caso.fusionAMain, { anulado: ANULADO });
  const a = lab.arranque(caso.dir, { TYCON_RETRO_PENDING_MIN_AGE_MIN: '0' });
  assert.match(a.stdout, new RegExp(caso.fusionAMain.slice(0, 12)));
  // la revisión de la semana lee los latidos de git
  const WR = require(path.join(ROOT, 'scripts', 'nightly', 'weekly-review', 'weekly-review.js'));
  latido(path.join(caso.dir, '.dashboard'), caso.dir, caso.fusionAMain, { anulado: ANULADO });
  latido(path.join(caso.dir, '.dashboard'), caso.dir, caso.directo);
  git(caso.dir, ['add', '-A']);
  git(caso.dir, ['commit', '--quiet', '-m', 'latidos']);
  const into = new Map();
  const ilegibles = [];
  WR.retrosDe(caso.dir, 'HEAD', into, ilegibles);
  assert.deepStrictEqual(ilegibles, []);
  assert.ok(into.has(caso.directo), 'el no anulado está');
  assert.ok(!into.has(caso.fusionAMain), 'el anulado no cuenta como retro');
});

test('T19 Tablero_NoCuentaAnulados_YLosNombra', () => {
  const dm = require(path.join(ROOT, 'scripts', 'lib', 'dashboard-metrics.js'));
  const sdlc = require(path.join(ROOT, 'scripts', 'metrics', 'sdlc-stage-metrics.js'));
  const dir = path.join(tmp(), 'dash');
  for (let i = 0; i < 5; i++) latido(dir, '/x/acme-backend', String(i + 1).repeat(40), { vueltas: 1, anulado: i < 2 ? ANULADO : null });
  const { records, counts } = dm.loadPorMerge([dir]);
  assert.strictEqual(records.filter((r) => r.status === 'ok').length, 3);
  assert.strictEqual(counts.anulados, 2);
  assert.strictEqual(counts.total, 3, 'los anulados no son fusiones');
  const fp = sdlc.firstPassFromDashboard(dir);
  assert.strictEqual(fp.den, 3);
  assert.strictEqual(fp.num, 3);
  assert.strictEqual(dm.lineaDeAnulados(counts), '2 latidos anulados');
  // un anulado bajado a merges/ saca al mismo merge de la carpeta de la máquina
  const dos = path.join(tmp(), 'dash2');
  latido(dos, '/x/acme-backend', 'e'.repeat(40), { vueltas: 1 });
  latido(path.join(dos, 'merges'), '/x/acme-backend', 'e'.repeat(40), { vueltas: 1, anulado: ANULADO });
  const otro = dm.loadPorMerge([dos]);
  assert.strictEqual(otro.records.filter((r) => r.status === 'ok').length, 0);
  assert.strictEqual(otro.counts.anulados, 1);
  // el tablero: la ficha del contrato cuenta sólo las tres fusiones y nombra los dos anulados
  const tablero = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js')).colectar({ dir });
  let contrato = null;
  const buscar = (o, prof = 0) => {
    if (!o || typeof o !== 'object' || prof > 6 || contrato) return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'contrato_v2' && v && typeof v === 'object' && 'estado' in v) { contrato = v; return; }
      buscar(v, prof + 1);
    }
  };
  buscar(tablero);
  assert.ok(contrato, 'el tablero trae la ficha del contrato');
  assert.strictEqual(contrato.total, 3, JSON.stringify(contrato));
  assert.match(contrato.detalle, /2 latidos anulados/);
});

// ── lo que confirmó el pase adversarial (cada prueba nace de su reproducción) ─────────────────────

test('Adversarial_PedidoDeLaCapaEnAzure_LeeSuNumero: platform.js change-request open contesta value.id', () => {
  const { dir } = repoDelCaso();
  git(dir, ['remote', 'add', 'origin', 'https://dev.azure.com/acme/producto/_git/acme-backend']);
  const lab = laboratorio({ extra: { TYCON_RETRO_ASK_PR: '0' } });
  const args = path.join(tmp(), 'args.json');
  fs.writeFileSync(args, JSON.stringify({ sourceBranch: 'pedido-abierto', targetBranch: 'main', text: 't' }));
  const r = lab.pedido(`node scripts/lib/platform/platform.js change-request open --repo acme/producto/acme-backend --auto-complete --args '@${args}'`, dir,
    JSON.stringify({ ok: true, value: { id: 6215, url: 'https://dev.azure.com/acme/g1/_apis/git/repositories/g2/pullRequests/6215', modo: 'auto' } }));
  const e = lab.entradas().pop();
  assert.strictEqual(e && e.pr, 6215, `${r.stderr}`);
  assert.strictEqual(e.estado, 'esperando');
  assert.strictEqual(e.plataforma, 'azure');
  assert.doesNotMatch(r.stderr, /--merge/, 'no pide el latido de la punta');
});

test('Adversarial_PedidoSinNumero_NoPideElLatidoDeLaPunta', () => {
  const { dir } = repoDelCaso();
  const lab = laboratorio({ extra: { TYCON_RETRO_ASK_PR: '0' } });
  git(dir, ['checkout', '--quiet', 'pedido-abierto']);
  const r = lab.pedido('az repos pr create --source-branch pedido-abierto --target-branch main', dir, 'sin número');
  git(dir, ['checkout', '--quiet', 'main']);
  assert.match(r.stderr, /no pude leer el número del pedido[^\n]*--correct/);
  assert.doesNotMatch(r.stderr, /--merge/, 'el latido de la punta sale 2: no se pide');
  assert.strictEqual(lab.cierre(dir).stdout, '', 'y no frena el cierre');
});

test('Adversarial_LatidoDeUnAnulado_NoSeReescribe', () => {
  const caso = repoDelCaso();
  const out = path.join(tmp(), 'salida');
  const home = tmp();
  assert.strictEqual(latidoReal(['--repo', caso.dir, '--merge', caso.directo, '--out', out], home).status, 0);
  assert.strictEqual(latidoReal(['--annul', '--sha', caso.directo, '--reason', 'prueba', '--out', out], home).status, 0);
  const r = latidoReal(['--repo', caso.dir, '--merge', caso.directo, '--out', out], home);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /está anulado/);
  const archivos = fs.readdirSync(out);
  assert.strictEqual(archivos.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(out, archivos[0]), 'utf8')).anulado, 'la anulación sigue');
});

test('Adversarial_AnuladoEnLaCarpeta_SacaLaCopiaViejaDeMerges', () => {
  const dm = require(path.join(ROOT, 'scripts', 'lib', 'dashboard-metrics.js'));
  for (const nombre of [null, 'metrics-otro-nombre.json']) {
    const dir = path.join(tmp(), 'dash');
    latido(dir, '/x/acme-backend', 'f'.repeat(40), { vueltas: 1, anulado: ANULADO });
    latido(path.join(dir, 'merges'), '/x/acme-backend', 'f'.repeat(40), { vueltas: 1, nombre });
    const { records, counts } = dm.loadPorMerge([dir]);
    assert.strictEqual(counts.total, 0, `${nombre}: el merge anulado no cuenta`);
    assert.strictEqual(counts.anulados, 1);
    assert.strictEqual(records.filter((r) => r.status === 'ok').length, 0);
  }
});

test('Adversarial_Tablero_NingunDenominadorCuentaAnulados', () => {
  const dir = path.join(tmp(), 'dash');
  for (let i = 0; i < 3; i++) latido(dir, '/x/acme-backend', String(i + 1).repeat(40), { vueltas: 1, anulado: i < 1 ? ANULADO : null });
  const tablero = require(path.join(ROOT, 'scripts', 'nightly', 'dashboard', 'dashboard.js')).colectar({ dir });
  const hallados = {};
  const buscar = (o, prof = 0) => {
    if (!o || typeof o !== 'object' || prof > 6) return;
    for (const [k, v] of Object.entries(o)) {
      if (['fechas_declaradas', 'contrato_v2'].includes(k) && v && typeof v === 'object' && 'estado' in v && !(k in hallados)) hallados[k] = v;
      else buscar(v, prof + 1);
    }
  };
  buscar(tablero);
  assert.strictEqual(hallados.fechas_declaradas && hallados.fechas_declaradas.total, 2, JSON.stringify(hallados.fechas_declaradas));
  assert.strictEqual(hallados.contrato_v2.total, 2);
});

test('Adversarial_JuntarLaBajada_GanaLaVersionAnulada', () => {
  const MM = require(path.join(ROOT, 'scripts', 'lib', 'merge-metrics.js'));
  const base = tmp();
  const hacia = path.join(base, 'hacia');
  const desde = path.join(base, 'desde');
  latido(hacia, '/x/acme-backend', 'a'.repeat(40), { vueltas: 1, nombre: 'metrics-a.json' });
  latido(desde, '/x/acme-backend', 'a'.repeat(40), { vueltas: 1, nombre: 'metrics-a.json', anulado: ANULADO });
  const resultado = path.join(base, 'resultado.json');
  fs.writeFileSync(resultado, JSON.stringify({ estado: 'bajado', completo: true }));
  MM.juntar({ desde, hacia, resultado });
  const quedo = fs.readdirSync(hacia).filter((f) => /^metrics-/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(hacia, f), 'utf8')));
  assert.ok(quedo.length >= 1);
  assert.ok(quedo.every((d) => d.anulado), `queda la versión anulada: ${JSON.stringify(quedo.map((d) => Boolean(d.anulado)))}`);
});

test('Adversarial_Barrido_UnAnuladoGuardadoEnMainNoCubre', () => {
  const caso = repoDelCaso();
  latido(path.join(caso.dir, '.dashboard'), caso.dir, caso.directo, { anulado: ANULADO });
  git(caso.dir, ['add', '-A']);
  git(caso.dir, ['commit', '--quiet', '-m', 'chore: dash']);
  const base = tmp();
  const anotados = path.join(base, 'latidos.txt');
  const falso = path.join(base, 'latido-falso.js');
  fs.writeFileSync(falso, `require('fs').appendFileSync(${JSON.stringify(anotados)}, process.argv.slice(2).join(' ') + '\\n');`);
  const cfg = path.join(base, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ no_piden_retro: [] }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics', 'retro-sweep.js'), '--repo', `acme=${caso.dir}`, '--out', path.join(base, 'out'), '--config', cfg],
    { env: env(path.join(base, 'casa'), { TYCON_RETRO_SWEEP_HEARTBEAT: falso, TYCON_TODAY: '2026-10-01' }), encoding: 'utf8' });
  const corridos = fs.existsSync(anotados) ? fs.readFileSync(anotados, 'utf8') : '';
  assert.match(corridos, new RegExp(`--merge ${caso.directo.slice(0, 7)}`), `el barrido le corre el latido al merge cuyo único latido está anulado: ${r.stdout}${r.stderr}`);
});

// ── guía ─────────────────────────────────────────────────────────────────────────────────────────

test('T20 Guia_DiceQueSeReclamaYComoSeAnula', () => {
  const guia = fs.readFileSync(path.join(ROOT, 'guides', 'piezas-del-arnes.md'), 'utf8');
  assert.match(guia, /pedido[^\n]*se reclama cuando entra[^\n]*commit[^\n]*main/i);
  assert.match(guia, /latido[^\n]*sólo acepta commits de la línea de main/i);
  assert.match(guia, /retro-heartbeat\.js --annul --sha/);
});
