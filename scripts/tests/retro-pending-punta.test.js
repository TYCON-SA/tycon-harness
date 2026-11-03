'use strict';
// retro-pending-punta.test.js — qué anota el reclamo de la retrospectiva al abrir un pedido y a qué carpeta manda el
// comando que lo paga. Repos de juguete con git de verdad y una copia del gancho, para que su `.dashboard/` sea el de la
// prueba.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retro-punta-'))); dirs.push(d); return d; };

function env(home) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD|CLAUDE_)/.test(k)) e[k] = v;
  // sin techo de edad para el reclamo ajeno: las entradas sembradas tienen una fecha fija
  return { ...e, HOME: home, USERPROFILE: home, TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS: '100000', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'sin-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00' };
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

const ORIGEN_GH = 'https://github.com/acme/producto.git';
const ORIGEN_AZ = 'https://dev.azure.com/acme/Prod/_git/producto';

/**
 * Un repo bajo el arnés con `dev` local atrasada: el remoto ya conoce un commit más. Devuelve la punta de cada lado.
 * Con `soloLocal`, la rama no está en el remoto y `remota` es null.
 */
function repoConDev({ soloLocal = false, origen = ORIGEN_GH } = {}) {
  // en una carpeta propia: el pedido de Azure busca el repo por nombre también entre los hermanos de su carpeta
  const dir = path.join(tmp(), 'producto');
  fs.mkdirSync(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  fs.mkdirSync(path.join(dir, '.tycon'));
  fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), '');   // versionada: una copia nueva también la trae
  commit(dir, 'base.txt');
  git(dir, ['remote', 'add', 'origin', origen]);
  git(dir, ['checkout', '--quiet', '-b', 'dev']);
  const local = commit(dir, 'local.txt');
  if (soloLocal) return { dir, local, remota: null };
  const remota = commit(dir, 'remota.txt');
  git(dir, ['update-ref', 'refs/remotes/origin/dev', remota]);
  git(dir, ['reset', '--quiet', '--hard', local]);
  git(dir, ['checkout', '--quiet', 'main']);
  return { dir, local, remota };
}

/** Una copia del gancho con sus bibliotecas y un HOME propio: el ledger y el `.dashboard/` son los de esta prueba. */
function laboratorio() {
  const base = tmp();
  const home = path.join(base, 'home');
  const arnes = path.join(base, 'arnes');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.mkdirSync(path.join(arnes, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(arnes, '.dashboard'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), path.join(arnes, 'scripts', 'hooks', 'retro-pending.js'));
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(arnes, 'scripts', 'lib'), { recursive: true });
  const ledger = path.join(home, '.claude', '.tycon-pipeline', 'retro-pending.jsonl');
  const correr = (evento) => {
    const r = spawnSync(process.execPath, [path.join(arnes, 'scripts', 'hooks', 'retro-pending.js')], { input: JSON.stringify(evento), env: env(home), encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    ledger,
    dashboard: path.join(arnes, '.dashboard'),
    pedido: (command, cwd) => correr({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd }),
    cierre: (cwd) => correr({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd }),
    entradas: () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    sembrar: (entrada) => fs.appendFileSync(ledger, `${JSON.stringify({ ts: '2026-10-01T10:00:00.000Z', sessionId: 's1', branch: 'main', cmd: 'x', sha: 'abc123def456', ...entrada })}\n`),
  };
}

const AZ = 'az repos pr create --org https://dev.azure.com/acme --project Prod --source-branch dev --target-branch main';
const GH = 'gh pr create --base main --head dev --title t --body-file cuerpo.md';
const CAPA = `node scripts/lib/platform/platform.js change-request open --repo acme/producto --args '{"targetBranch":"main","sourceBranch":"dev"}'`;

for (const [lector, comando, origen] of [['az', AZ, ORIGEN_AZ], ['gh', GH, ORIGEN_GH], ['la capa de plataforma', CAPA, ORIGEN_GH]]) {
  test(`${lector}: con dev local atrasada anota la punta del remoto`, () => {
    const { dir, local, remota } = repoConDev({ origen });
    const lab = laboratorio();
    lab.pedido(comando, dir);
    const [e] = lab.entradas();
    assert.ok(e, 'el pedido deja su entrada');
    assert.strictEqual(e.sha, remota.slice(0, 12));
    assert.notStrictEqual(e.sha, local.slice(0, 12));
  });

  test(`${lector}: con la rama sólo en este clon anota la punta local`, () => {
    const { dir, local } = repoConDev({ soloLocal: true, origen });
    git(dir, ['checkout', '--quiet', 'main']);
    const lab = laboratorio();
    lab.pedido(comando, dir);
    const [e] = lab.entradas();
    assert.ok(e, 'el pedido deja su entrada');
    assert.strictEqual(e.sha, local.slice(0, 12));
  });
}

test('un pedido abierto desde una copia anota la carpeta principal', () => {
  const { dir } = repoConDev();
  const copia = path.join(tmp(), 'copia');
  git(dir, ['worktree', 'add', '--quiet', '-b', 'tarea', copia, 'main']);
  const lab = laboratorio();
  lab.pedido(GH, copia);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.repoPath, copia);
  assert.strictEqual(e.principal, dir);
});

test('un pedido abierto desde la carpeta principal no repite la carpeta', () => {
  const { dir } = repoConDev();
  const lab = laboratorio();
  lab.pedido(GH, dir);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.repoPath, dir);
  assert.ok(!('principal' in e));
});

for (const [lector, comando, origen] of [['az', AZ.replace(' --source-branch dev', ''), ORIGEN_AZ], ['gh', 'gh pr create --base main --title t --body-file cuerpo.md', ORIGEN_GH]]) {
  test(`${lector}: sin nombrar la rama, con la rama local atrasada, anota la punta del remoto`, () => {
    const { dir, remota } = repoConDev({ origen });
    git(dir, ['checkout', '--quiet', 'dev']);
    const lab = laboratorio();
    lab.pedido(comando, dir);
    const [e] = lab.entradas();
    assert.ok(e, 'el pedido deja su entrada');
    assert.strictEqual(e.sha, remota.slice(0, 12));
  });
}

test('gh: la rama escrita como referencia completa es la misma rama', () => {
  const { dir, remota } = repoConDev();
  const lab = laboratorio();
  lab.pedido('gh pr create --base main --head refs/heads/dev --title t --body-file cuerpo.md', dir);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.sha, remota.slice(0, 12));
});

/** Un repo vacío de verdad: la carpeta principal o la copia que sigue en pie. */
function repoVivo() {
  const dir = tmp();
  git(dir, ['init', '--quiet', '-b', 'main']);
  return dir;
}

test('con la copia borrada, el merge de otra sesión se reclama desde la carpeta principal', () => {
  const principal = repoVivo();
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal, sessionId: 'otra' });
  const salida = JSON.parse(lab.cierre(principal).stdout);
  assert.strictEqual(salida.decision, 'block');
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge abc123def456`), salida.reason);
});

test('con la copia viva, el merge de otra sesión no se reclama desde la carpeta principal', () => {
  const principal = repoVivo();
  const lab = laboratorio();
  lab.sembrar({ repoPath: repoVivo(), principal, sessionId: 'otra' });
  assert.strictEqual(lab.cierre(principal).stdout, '');
});

test('el archivo guardado en el .dashboard de la carpeta principal salda la entrada de la copia borrada', () => {
  const principal = repoVivo();
  fs.mkdirSync(path.join(principal, '.dashboard'));
  fs.writeFileSync(path.join(principal, '.dashboard', 'metrics-x.json'), JSON.stringify({ repo: principal, merge_commit: 'abc123def456aaaa', project: 'x' }));
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal });
  assert.strictEqual(lab.cierre(tmp()).stdout, '');
});

test('una copia que quedó como carpeta sin repo manda el comando a la carpeta principal', () => {
  const principal = repoVivo();
  const restos = tmp();
  const lab = laboratorio();
  lab.sembrar({ repoPath: restos, principal });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge abc123def456`), salida.reason);
});

test('los restos de una copia adentro de otro repo mandan el comando a la carpeta principal', () => {
  const principal = repoVivo();
  const restos = path.join(principal, '.claude', 'worktrees', 'x');
  fs.mkdirSync(restos, { recursive: true });
  const lab = laboratorio();
  lab.sembrar({ repoPath: restos, principal, sessionId: 'otra' });
  const salida = JSON.parse(lab.cierre(principal).stdout);
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge abc123def456`), salida.reason);
});

test('gh: con --head en una variable no toma la punta de la rama actual', () => {
  const { dir, local, remota } = repoConDev();
  git(dir, ['checkout', '--quiet', 'dev']);
  const lab = laboratorio();
  lab.pedido('gh pr create --base main --head "$RAMA" --title t --body-file cuerpo.md', dir);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.sha, local.slice(0, 12));
  assert.notStrictEqual(e.sha, remota.slice(0, 12));
});

// El comando de la skill que saca la sha del registro: desde la carpeta principal paga sólo lo que se paga desde ahí.
function shaDelRegistro(lab, repo) {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tycon-merge-to-main', 'SKILL.md'), 'utf8');
  const programa = skill.match(/node -e '(const fs=require\("fs"\),os=require\("os"\)[^']*retro-pending\.jsonl[^']*)' <repo>/);
  assert.ok(programa, 'la skill trae el comando');
  return spawnSync(process.execPath, ['-e', programa[1], repo], { env: env(path.dirname(path.dirname(path.dirname(lab.ledger)))), encoding: 'utf8' });
}

test('el comando de la skill no devuelve la sha de una copia viva al preguntar por la principal', () => {
  const principal = repoVivo();
  const lab = laboratorio();
  lab.sembrar({ repoPath: principal, sha: 'aaaaaaaaaaaa' });
  lab.sembrar({ repoPath: repoVivo(), principal, sha: 'bbbbbbbbbbbb' });
  assert.strictEqual(shaDelRegistro(lab, principal).stdout.trim(), 'aaaaaaaaaaaa');
});

test('el comando de la skill devuelve la sha de la copia borrada al preguntar por la principal', () => {
  const principal = repoVivo();
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal, sha: 'cccccccccccc' });
  assert.strictEqual(shaDelRegistro(lab, principal).stdout.trim(), 'cccccccccccc');
});

test('una carpeta principal que ya no es un repo no recibe el comando', () => {
  const borrada = path.join(tmp(), 'ya-no-esta');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada, principal: tmp() });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.ok(salida.reason.includes(`--repo "${borrada}" --merge abc123def456`), salida.reason);
});

test('con la copia borrada, el comando del cierre apunta a la carpeta principal', () => {
  const principal = repoVivo();
  const borrada = path.join(tmp(), 'ya-no-esta');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada, principal });
  const { stdout } = lab.cierre(tmp());
  const salida = JSON.parse(stdout);
  assert.strictEqual(salida.decision, 'block');
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge abc123def456`), salida.reason);
  assert.ok(!salida.reason.includes(`--repo "${borrada}"`), salida.reason);
});

test('con la copia viva, el comando del cierre sigue apuntando a la copia', () => {
  const principal = repoVivo();
  const copia = repoVivo();
  const lab = laboratorio();
  lab.sembrar({ repoPath: copia, principal });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.ok(salida.reason.includes(`--repo "${copia}" --merge abc123def456`), salida.reason);
});

test('el archivo del latido corrido en la carpeta principal salda la entrada de la copia borrada', () => {
  const principal = tmp();
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal });
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: principal, merge_commit: 'abc123def456aaaa', project: 'x' }));
  assert.strictEqual(lab.cierre(tmp()).stdout, '');
});

test('el archivo de otro repo no salda la entrada', () => {
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal: tmp() });
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: tmp(), merge_commit: 'abc123def456aaaa', project: 'x' }));
  assert.strictEqual(JSON.parse(lab.cierre(tmp()).stdout).decision, 'block');
});

// Una entrada vieja, sin copia y sin carpeta principal, no se puede pagar con el comando que da: se reclama igual. Qué
// hacer con ella es una decisión pendiente, porque dejar de reclamarla afloja el freno. Esta prueba fija lo de hoy.
test('sin copia y sin carpeta principal, el cierre sigue frenando con la ruta anotada', () => {
  const borrada = path.join(tmp(), 'ya-no-esta');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.strictEqual(salida.decision, 'block');
  assert.ok(salida.reason.includes(`--repo "${borrada}"`), salida.reason);
});

test('con la copia y la carpeta principal borradas, el cierre sigue frenando con la ruta de la copia', () => {
  const borrada = path.join(tmp(), 'ya-no-esta');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada, principal: path.join(tmp(), 'tampoco') });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.strictEqual(salida.decision, 'block');
  assert.ok(salida.reason.includes(`--repo "${borrada}"`), salida.reason);
});
