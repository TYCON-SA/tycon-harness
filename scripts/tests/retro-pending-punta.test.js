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
  // sin la consulta al remoto: los `origin` de estos repos son direcciones de mentira, y una prueba no sale a la red
  return { ...e, HOME: home, USERPROFILE: home, TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_ASK_REMOTE: '0', TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS: '100000', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'sin-global'),
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
  fs.mkdirSync(path.join(arnes, 'scripts', 'setup', 'harness'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'setup', 'harness', 'tycon-home.js'), path.join(arnes, 'scripts', 'setup', 'harness', 'tycon-home.js'));
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
    sembrar: (entrada) => fs.appendFileSync(ledger, `${JSON.stringify({ ts: '2026-10-01T10:00:00.000Z', sessionId: 's1', branch: 'main', cmd: 'x', sha: SHA, ...entrada })}\n`),
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
  // un commit vacío con autor y fecha fijos: todos los repos de juguete conocen el mismo commit, el que siembra el registro
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'base']);
  return dir;
}
// el commit que siembra el registro: el latido sólo paga un commit que la carpeta conoce
const SHA_ENTERO = git(repoVivo(), ['rev-parse', 'HEAD']);
const SHA = SHA_ENTERO.slice(0, 12);

test('con la copia borrada, el merge de otra sesión se reclama desde la carpeta principal', () => {
  const principal = repoVivo();
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal, sessionId: 'otra' });
  const salida = JSON.parse(lab.cierre(principal).stdout);
  assert.strictEqual(salida.decision, 'block');
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge ${SHA}`), salida.reason);
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
  fs.writeFileSync(path.join(principal, '.dashboard', 'metrics-x.json'), JSON.stringify({ repo: principal, merge_commit: SHA_ENTERO, project: 'x' }));
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
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge ${SHA}`), salida.reason);
});

test('los restos de una copia adentro de otro repo mandan el comando a la carpeta principal', () => {
  const principal = repoVivo();
  const restos = path.join(principal, '.claude', 'worktrees', 'x');
  fs.mkdirSync(restos, { recursive: true });
  const lab = laboratorio();
  lab.sembrar({ repoPath: restos, principal, sessionId: 'otra' });
  const salida = JSON.parse(lab.cierre(principal).stdout);
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge ${SHA}`), salida.reason);
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

// Un pedido abierto con un comando largo (fila 95): el registro guarda el comando cortado, y que es un pedido se decide
// con el comando entero. Con el corte, la entrada parecía un empuje a main y el cierre pedía el latido de un merge que no
// existe, con la punta de la rama.
test('un pedido con un comando largo sigue siendo un pedido aunque el registro corte el comando', () => {
  const { dir, local } = repoConDev({ soloLocal: true });
  git(dir, ['checkout', '--quiet', 'main']);
  const lab = laboratorio();
  const largo = `cat ${path.join(dir, 'una', 'carpeta', 'con', 'un', 'nombre', 'largo', 'para', 'que', 'el', 'registro', 'corte', 'cuerpo.md')}; ${GH}`;
  assert.ok(largo.indexOf('gh pr create') > 120, `el pedido queda después del corte: ${largo.indexOf('gh pr create')}`);
  lab.pedido(largo, dir);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.sha, local.slice(0, 12));
  assert.doesNotMatch(e.cmd, /pr create/, 'el registro guarda el comando cortado');
  assert.strictEqual(e.entrega, 'pedido', 'que es un pedido queda anotado aparte');
  assert.strictEqual(e.tipo, undefined, '`tipo` es de los renglones que no son entradas');
  const salida = lab.cierre(dir).stdout;
  assert.strictEqual(salida ? JSON.parse(salida).decision : undefined, undefined, `el cierre no pide el latido de un pedido: ${salida}`);
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
  const principal = tmp();
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada, principal });
  // ningún latido lo paga: no corta, y el aviso da el comando de corregir, no el del latido en una carpeta sin repo
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.strictEqual(salida.decision, undefined, salida.systemMessage);
  assert.match(salida.systemMessage, /ningún latido lo paga/);
  assert.ok(!salida.systemMessage.includes(`--repo "${principal}"`), salida.systemMessage);
});

test('con la copia borrada, el comando del cierre apunta a la carpeta principal', () => {
  const principal = repoVivo();
  const borrada = path.join(tmp(), 'ya-no-esta');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada, principal });
  const { stdout } = lab.cierre(tmp());
  const salida = JSON.parse(stdout);
  assert.strictEqual(salida.decision, 'block');
  assert.ok(salida.reason.includes(`--repo "${principal}" --merge ${SHA}`), salida.reason);
  assert.ok(!salida.reason.includes(`--repo "${borrada}"`), salida.reason);
});

test('con la copia viva, el comando del cierre sigue apuntando a la copia', () => {
  const principal = repoVivo();
  const copia = repoVivo();
  const lab = laboratorio();
  lab.sembrar({ repoPath: copia, principal });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.ok(salida.reason.includes(`--repo "${copia}" --merge ${SHA}`), salida.reason);
});

test('el archivo del latido corrido en la carpeta principal salda la entrada de la copia borrada', () => {
  const principal = tmp();
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal });
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: principal, merge_commit: SHA_ENTERO, project: 'x' }));
  assert.strictEqual(lab.cierre(tmp()).stdout, '');
});

test('el archivo de otro repo no salda la entrada', () => {
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), principal: repoVivo() });
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: tmp(), merge_commit: SHA_ENTERO, project: 'x' }));
  assert.strictEqual(JSON.parse(lab.cierre(tmp()).stdout).decision, 'block');
});

// Caso: el latido corrido desde una copia del repo (`<repo>--wt-X`) deja su archivo con la ruta de la copia. El aviso no lo
// reconocía para el merge anotado desde la carpeta principal: lo seguía pidiendo y mandaba el latido a la principal, que
// no tenía el commit y pedía un git fetch.
test('el archivo del latido corrido desde una copia borrada <repo>--wt-X salda la entrada de la carpeta principal', () => {
  const base = tmp();
  const principal = path.join(base, 'producto');
  fs.mkdirSync(principal);
  git(principal, ['init', '--quiet', '-b', 'main']);
  git(principal, ['commit', '--quiet', '--allow-empty', '-m', 'base']);
  const lab = laboratorio();
  lab.sembrar({ repoPath: principal });
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: path.join(base, 'producto--wt-X'), merge_commit: SHA_ENTERO, project: 'x' }));
  assert.strictEqual(lab.cierre(tmp()).stdout, '');
});

test('el archivo del latido corrido desde una copia viva <repo>--wt-X salda la entrada de la carpeta principal', () => {
  const base = tmp();
  const principal = path.join(base, 'producto');
  fs.mkdirSync(principal);
  git(principal, ['init', '--quiet', '-b', 'main']);
  git(principal, ['commit', '--quiet', '--allow-empty', '-m', 'base']);
  const copia = path.join(base, 'producto--wt-X');
  git(principal, ['worktree', 'add', '--quiet', '-b', 'tarea', copia, 'main']);
  const lab = laboratorio();
  lab.sembrar({ repoPath: principal });
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: copia, merge_commit: SHA_ENTERO, project: 'x' }));
  assert.strictEqual(lab.cierre(tmp()).stdout, '');
});

test('un repo aparte que se llama <repo>--wt-X no salda la entrada de <repo>', () => {
  const base = tmp();
  const principal = path.join(base, 'producto');
  const otro = path.join(base, 'producto--wt-X');
  for (const d of [principal, otro]) {
    fs.mkdirSync(d);
    git(d, ['init', '--quiet', '-b', 'main']);
    git(d, ['commit', '--quiet', '--allow-empty', '-m', 'base']);
  }
  const lab = laboratorio();
  lab.sembrar({ repoPath: principal });
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: otro, merge_commit: SHA_ENTERO, project: 'x' }));
  assert.strictEqual(JSON.parse(lab.cierre(tmp()).stdout).decision, 'block');
});

// Una entrada sin copia y sin carpeta principal no la paga ningún latido (pide el repo y el commit): no corta el turno,
// se avisa una vez con el comando de corregir. Cortar por ella era pedir algo que nadie puede hacer.
test('sin copia y sin carpeta principal, el cierre avisa sin cortar', () => {
  const borrada = path.join(tmp(), 'ya-no-esta');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.strictEqual(salida.decision, undefined, salida.systemMessage);
  assert.ok(salida.systemMessage.includes(borrada) && /ningún latido lo paga/.test(salida.systemMessage), salida.systemMessage);
  // el mismo aviso no se repite en el cierre siguiente
  assert.strictEqual(lab.cierre(tmp()).stdout, '');
  // con la lista vacía se olvida: si la misma entrada vuelve, se avisa otra vez
  fs.writeFileSync(lab.ledger, '');
  assert.strictEqual(lab.cierre(tmp()).stdout, '');
  lab.sembrar({ repoPath: borrada });
  assert.match(JSON.parse(lab.cierre(tmp()).stdout).systemMessage, /ningún latido lo paga/);
});

test('con la copia y la carpeta principal borradas, el cierre avisa sin cortar', () => {
  const borrada = path.join(tmp(), 'ya-no-esta');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada, principal: path.join(tmp(), 'tampoco') });
  const salida = JSON.parse(lab.cierre(tmp()).stdout);
  assert.strictEqual(salida.decision, undefined, salida.systemMessage);
  assert.match(salida.systemMessage, /ningún latido lo paga/);
});

// Un merge de otra sesión en un repo donde esta sesión no trabaja no lo salda ella: se avisa con el comando para quien sí.
test('el merge de otra sesión en otro repo cercano avisa sin cortar, con su comando', () => {
  const workspace = tmp();
  const repo = path.join(workspace, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '--quiet', '-b', 'main']);
  git(repo, ['commit', '--quiet', '--allow-empty', '-m', 'base']);
  const lab = laboratorio();
  lab.sembrar({ repoPath: repo, sessionId: 'otra' });
  const salida = JSON.parse(lab.cierre(workspace).stdout);
  assert.strictEqual(salida.decision, undefined, salida.systemMessage);
  assert.ok(salida.systemMessage.includes(`--repo "${repo}" --merge ${SHA}`), salida.systemMessage);
  assert.match(salida.systemMessage, /de la sesión otra/);
});

// ── la sesión en la carpeta que agrupa los repos de un producto (no es un repo) ──
/** Una carpeta que no es un repo, con un repo hijo bajo el arnés por cada `[nombre, origin]`. */
function carpetaPadre(hijos) {
  const padre = path.join(tmp(), 'producto-a');
  fs.mkdirSync(padre);
  for (const [nombre, origen] of hijos) {
    const dir = path.join(padre, nombre);
    fs.mkdirSync(dir);
    git(dir, ['init', '--quiet', '-b', 'main']);
    fs.mkdirSync(path.join(dir, '.tycon'));
    fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), '');
    commit(dir, 'base.txt');
    git(dir, ['remote', 'add', 'origin', origen]);
    git(dir, ['checkout', '--quiet', '-b', 'dev']);
    commit(dir, 'dev.txt');
    git(dir, ['checkout', '--quiet', 'main']);
  }
  return padre;
}
const AZ_BACKEND = 'https://dev.azure.com/acme/producto-a/_git/backend';
const AZ_FRONTEND = 'https://dev.azure.com/acme/producto-a/_git/frontend';
const CAPA_BACKEND = `node scripts/lib/platform/platform.js change-request open --repo '{"platform":"azure","org":"acme","project":"producto-a","repo":"backend"}' --auto-complete --args '{"targetBranch":"main","sourceBranch":"dev"}'`;

test('la capa desde la carpeta padre anota el repo hijo cuyo origin es el --repo', () => {
  const padre = carpetaPadre([['backend', AZ_BACKEND], ['frontend', AZ_FRONTEND]]);
  const lab = laboratorio();
  lab.pedido(CAPA_BACKEND, padre);
  const [e, otra] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(otra, undefined);
  assert.strictEqual(e.repoPath, path.join(padre, 'backend'));
});

test('la capa desde la carpeta padre sin ningún hijo con ese origin queda sin ubicar', () => {
  const padre = carpetaPadre([['backend', 'https://dev.azure.com/acme/producto-a/_git/otro'], ['frontend', AZ_FRONTEND]]);
  const lab = laboratorio();
  const r = lab.pedido(CAPA_BACKEND, padre);
  assert.deepStrictEqual(lab.entradas(), []);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no pude resolver a qué repo fue/);
});

test('la capa desde la carpeta padre con dos hijos con ese origin queda sin ubicar', () => {
  const padre = carpetaPadre([['backend', AZ_BACKEND], ['backend-copia', AZ_BACKEND], ['frontend', AZ_FRONTEND]]);
  const lab = laboratorio();
  const r = lab.pedido(CAPA_BACKEND, padre);
  assert.deepStrictEqual(lab.entradas(), []);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no pude resolver a qué repo fue/);
});

test('la capa con cd al repo hijo sigue anotando ese repo', () => {
  const padre = carpetaPadre([['backend', AZ_BACKEND], ['frontend', AZ_FRONTEND]]);
  const lab = laboratorio();
  lab.pedido(`cd '${path.join(padre, 'backend')}' && ${CAPA_BACKEND}`, padre);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.repoPath, path.join(padre, 'backend'));
});

test('gh con --repo desde la carpeta padre anota el repo hijo cuyo origin es el --repo', () => {
  const padre = carpetaPadre([['backend', 'https://github.com/acme/backend.git'], ['frontend', 'https://github.com/acme/frontend.git']]);
  const lab = laboratorio();
  lab.pedido('gh pr create --repo acme/backend --base main --head dev --title t --body-file cuerpo.md', padre);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.repoPath, path.join(padre, 'backend'));
});

test('gh sin --repo desde la carpeta padre queda sin ubicar', () => {
  const padre = carpetaPadre([['backend', 'https://github.com/acme/backend.git']]);
  const lab = laboratorio();
  const r = lab.pedido('gh pr create --base main --head dev --title t --body-file cuerpo.md', padre);
  assert.deepStrictEqual(lab.entradas(), []);
  assert.strictEqual(r.status, 2);
});
