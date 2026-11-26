'use strict';
// retro-pending-budget.test.js — el aviso de arranque y el cierre del turno de scripts/hooks/retro-pending.js no juzgan
// el registro entero. El arranque no le pregunta a la plataforma, mira primero lo de su carpeta y corta en su tope; el
// cierre del turno mira sólo los merges de su sesión y los de cerca, y pregunta sólo por los pedidos de esos repos; más
// de tres entradas que ningún latido paga van en una línea con la ruta del archivo que las lista. Repos de juguete con git
// de verdad, y `az`, `gh` y `git` envueltos en el PATH para anotar cada llamada. Sin red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retro-tope-'))); dirs.push(d); return d; };

function env(home, extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD|CLAUDE_|CODEX_|GH_|AZURE_)/.test(k)) e[k] = v;
  return { ...e, HOME: home, USERPROFILE: home, TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS: '100000', TYCON_RETRO_ASK_REMOTE: '0',
    TYCON_PROFILE: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'sin-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
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

/** Un repo bajo el arnés con `origin` en Azure DevOps (sin fetch: nadie lo trae) y un commit en `main`. */
function repo(nombre) {
  const dir = path.join(tmp(), nombre);
  fs.mkdirSync(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  fs.mkdirSync(path.join(dir, '.tycon'));
  fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), '');
  const base = commit(dir, 'base.txt');
  git(dir, ['remote', 'add', 'origin', `https://dev.azure.com/acme/producto/_git/${nombre}`]);
  return { dir, base };
}

/** `az`, `gh` y `git` envueltos: anotan cada llamada en `<bin>/llamadas` (git sigue andando: llama al de verdad). */
function binDeMentira() {
  const bin = path.join(tmp(), 'bin');
  fs.mkdirSync(bin);
  for (const h of ['az', 'gh']) {
    fs.writeFileSync(path.join(bin, h), `#!/bin/sh\necho "${h} $*" >> "${bin}/llamadas"\nexit 1\n`);
    fs.chmodSync(path.join(bin, h), 0o755);
  }
  const gitDeVerdad = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "git $*" >> "${bin}/llamadas"\nexec "${gitDeVerdad}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return bin;
}
const llamadas = (bin) => (fs.existsSync(path.join(bin, 'llamadas')) ? fs.readFileSync(path.join(bin, 'llamadas'), 'utf8').split('\n').filter(Boolean) : []);

/** Una copia del gancho con sus bibliotecas y un HOME propio; `bin` va adelante en el PATH. */
function laboratorio(bin) {
  const base = tmp();
  const home = path.join(base, 'home');
  const arnes = path.join(base, 'arnes');
  const estado = path.join(home, '.claude', '.tycon-pipeline');
  fs.mkdirSync(estado, { recursive: true });
  fs.mkdirSync(path.join(arnes, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(arnes, '.dashboard'));
  const gancho = path.join(arnes, 'scripts', 'hooks', 'retro-pending.js');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), gancho);
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(arnes, 'scripts', 'lib'), { recursive: true });
  // la consulta del pedido va por la capa de plataforma, que lee sus conectores de integrations/
  fs.cpSync(path.join(ROOT, 'integrations'), path.join(arnes, 'integrations'), { recursive: true });
  const ledger = path.join(estado, 'retro-pending.jsonl');
  const correr = (evento, extra = {}) => {
    const r = spawnSync(process.execPath, [gancho], { input: JSON.stringify(evento), env: env(home, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra }), encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    estado,
    cierre: (cwd, extra) => correr({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd }, extra),
    arranque: (cwd, extra) => correr({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup', cwd }, { TYCON_RETRO_PENDING_MIN_AGE_MIN: '0', ...extra }),
    sembrar: (entrada) => fs.appendFileSync(ledger, `${JSON.stringify({ ts: '2026-10-05T10:00:00.000Z', sessionId: 'otra', branch: 'main', cmd: 'git push origin main', ...entrada })}\n`),
  };
}
/** Un pedido abierto con su número, esperando que entre (lo que el gancho anota al abrirlo). */
const esperando = (dir, pr) => ({ repoPath: dir, sha: 'abc123def456', pr, plataforma: 'azure', estado: 'esperando', entrega: 'pedido', cmd: 'az repos pr create --source-branch dev --target-branch main' });
const motivoDelCierre = (r) => (r.stdout ? JSON.parse(r.stdout).reason || '' : '');

test('T1 Arranque_NoPreguntaALaPlataforma: el arranque no pregunta por los pedidos abiertos; el cierre del turno sí', () => {
  const bin = binDeMentira();
  const { dir } = repo('acme-backend');
  const lab = laboratorio(bin);
  lab.sembrar(esperando(dir, 101));
  const a = lab.arranque(dir);
  assert.strictEqual(a.status, 0, a.stderr);
  assert.deepStrictEqual(llamadas(bin).filter((l) => /^(az|gh) /.test(l)), [], 'el arranque no llama a la plataforma');
  lab.cierre(dir);
  assert.ok(llamadas(bin).some((l) => /^az .*--id 101\b/.test(l)), `el cierre del turno pregunta por el pedido: ${llamadas(bin).join('\n')}`);
});

test('T2 Cierre_SoloPreguntaPorLosPedidosDeSuRepo: un pedido abierto de otro repo se pregunta desde el cierre de una sesión en ese repo', () => {
  const bin = binDeMentira();
  const aca = repo('acme-backend');
  const otro = repo('acme-frontend');
  const lab = laboratorio(bin);
  lab.sembrar(esperando(otro.dir, 202));
  lab.cierre(aca.dir);
  assert.deepStrictEqual(llamadas(bin).filter((l) => /--id 202\b/.test(l)), [], 'desde otro repo no pregunta');
  lab.cierre(otro.dir);
  assert.ok(llamadas(bin).some((l) => /^az .*--id 202\b/.test(l)), `desde su repo sí: ${llamadas(bin).join('\n')}`);
});

test('T3 Cierre_NoJuzgaLoDeOtroRepo: el cierre del turno no corre git en el repo de un merge ajeno lejano, y sigue frenando por el suyo', () => {
  const bin = binDeMentira();
  const aca = repo('acme-backend');
  const otro = repo('acme-frontend');
  const lab = laboratorio(bin);
  lab.sembrar({ repoPath: otro.dir, sha: otro.base.slice(0, 12) });
  lab.sembrar({ repoPath: aca.dir, sha: aca.base.slice(0, 12), sessionId: 's1' });
  const motivo = motivoDelCierre(lab.cierre(aca.dir));
  assert.match(motivo, new RegExp(aca.base.slice(0, 12)), 'el merge de esta sesión sigue frenando el cierre');
  assert.deepStrictEqual(llamadas(bin).filter((l) => l.includes(otro.dir)), [], 'no corre git en el otro repo');
});

test('T4 Arranque_TopeCero: con tope cero el arranque no juzga nada, lo dice, y el cierre del turno lo sigue reclamando', () => {
  const bin = binDeMentira();
  const aca = repo('acme-backend');
  const lab = laboratorio(bin);
  lab.sembrar({ repoPath: aca.dir, sha: aca.base.slice(0, 12), sessionId: 's1' });
  const a = lab.arranque(aca.dir, { TYCON_RETRO_NOTICE_MS: '0' });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.match(a.stdout, /no llegó a mirar 1 entrada\(s\) de este proyecto, las más viejas: las reclama el cierre del turno/, a.stdout);
  assert.doesNotMatch(a.stdout, new RegExp(aca.base.slice(0, 12)), 'no lista lo que no juzgó');
  assert.deepStrictEqual(llamadas(bin).filter((l) => l.includes(aca.dir)), [], 'no corre git en el repo');
  assert.match(motivoDelCierre(lab.cierre(aca.dir)), new RegExp(aca.base.slice(0, 12)), 'el cierre del turno lo reclama');
});

test('T5 Arranque_NoPagablesEnUnaLinea: más de tres entradas que ningún latido paga van en una línea con la ruta de su lista', () => {
  const bin = binDeMentira();
  const { dir } = repo('acme-backend');
  const lab = laboratorio(bin);
  // pedidos sin su número: ningún latido los paga (se corrigen con --correct)
  const shas = ['a1', 'b2', 'c3', 'd4', 'e5'].map((p) => `${p}0000000000`);
  for (const sha of shas) lab.sembrar({ repoPath: dir, sha, cmd: 'gh pr create --base main --head dev' });
  const { stdout } = lab.arranque(dir);
  const linea = stdout.split('\n').filter((l) => /un latido no puede pagar/.test(l));
  assert.strictEqual(linea.length, 1, stdout);
  assert.match(linea[0], /5 entrada\(s\) de este proyecto que un latido no puede pagar/, linea[0]);
  for (const sha of shas) assert.ok(!stdout.includes(sha), `${sha} no va en el aviso: ${stdout}`);
  const archivo = path.join(lab.estado, 'retro-pending-no-pagables.txt');
  assert.ok(linea[0].includes(archivo), `la línea nombra el archivo: ${linea[0]}`);
  const lista = fs.readFileSync(archivo, 'utf8');
  for (const sha of shas) assert.match(lista, new RegExp(`${dir} @ ${sha}[^\\n]*--correct --repo "${dir}" --sha ${sha}`), lista);
});
