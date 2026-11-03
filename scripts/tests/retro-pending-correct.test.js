'use strict';
// retro-pending-correct.test.js — las entradas del reclamo de la retrospectiva que anotaron el commit equivocado: la
// punta que se le pregunta al remoto al abrir el pedido, la rama de origen anotada aparte, la corrección que hace una
// persona (sin borrar la entrada), el aviso de «ese commit ya estaba en main» y la carpeta principal de una entrada vieja
// que no la anotó. Repos de juguete con git de verdad, un remoto en una carpeta y una copia del gancho con su HOME.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retro-corregir-'))); dirs.push(d); return d; };

function env(home) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD|CLAUDE_)/.test(k)) e[k] = v;
  return { ...e, HOME: home, USERPROFILE: home, TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_GATE_FOREIGN_MAX_AGE_DAYS: '100000', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'sin-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
    GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00' };
}
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(os.tmpdir()), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const existe = (dir, sha) => spawnSync('git', ['-C', dir, 'cat-file', '-e', `${sha}^{commit}`], { env: env(os.tmpdir()) }).status === 0;
function commit(dir, nombre) {
  fs.writeFileSync(path.join(dir, nombre), `${nombre}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', nombre]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * Un repo bajo el arnés cuyo `origin` es una carpeta: `dev` tiene un commit en el remoto que esta copia no trajo, así que
 * su `origin/dev` quedó atrás. Devuelve la punta vieja (la que conoce la copia) y la del remoto.
 */
function repoConRemotoAdelante() {
  const base = tmp();
  const remoto = path.join(base, 'remoto.git');
  const dir = path.join(base, 'producto');
  git(base, ['init', '--quiet', '--bare', '-b', 'main', remoto]);
  fs.mkdirSync(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  fs.mkdirSync(path.join(dir, '.tycon'));
  fs.writeFileSync(path.join(dir, '.tycon', 'advisors.yaml'), '');
  commit(dir, 'base.txt');
  git(dir, ['remote', 'add', 'origin', remoto]);
  git(dir, ['push', '--quiet', 'origin', 'main']);
  git(dir, ['checkout', '--quiet', '-b', 'dev']);
  const vieja = commit(dir, 'vieja.txt');
  git(dir, ['push', '--quiet', 'origin', 'dev']);
  // otra copia sube un commit más a dev; ésta no trae nada
  const otra = path.join(base, 'otra');
  git(base, ['clone', '--quiet', '-b', 'dev', remoto, otra]);
  const nueva = commit(otra, 'nueva.txt');
  git(otra, ['push', '--quiet', 'origin', 'dev']);
  git(dir, ['checkout', '--quiet', 'main']);
  return { dir, vieja, nueva };
}

/** Un repo bajo el arnés sin remoto: `main` con dos commits y `dev` con uno que no entró. */
function repoConMain() {
  const dir = path.join(tmp(), 'producto');
  fs.mkdirSync(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  fs.mkdirSync(path.join(dir, '.tycon'));
  const viejo = commit(dir, 'viejo.txt');
  const real = commit(dir, 'real.txt');
  git(dir, ['checkout', '--quiet', '-b', 'dev']);
  const fuera = commit(dir, 'fuera.txt');
  git(dir, ['checkout', '--quiet', 'main']);
  return { dir, viejo, real, fuera };
}

/** Una copia del gancho con sus bibliotecas y un HOME propio: el registro y el `.dashboard/` son los de esta prueba. */
function laboratorio() {
  const base = tmp();
  const home = path.join(base, 'home');
  const arnes = path.join(base, 'arnes');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.mkdirSync(path.join(arnes, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(arnes, '.dashboard'));
  const gancho = path.join(arnes, 'scripts', 'hooks', 'retro-pending.js');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), gancho);
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(arnes, 'scripts', 'lib'), { recursive: true });
  const ledger = path.join(home, '.claude', '.tycon-pipeline', 'retro-pending.jsonl');
  const correr = (evento) => {
    const r = spawnSync(process.execPath, [gancho], { input: JSON.stringify(evento), env: env(home), encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const renglones = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    ledger,
    dashboard: path.join(arnes, '.dashboard'),
    pedido: (command, cwd) => correr({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd }),
    cierre: (cwd) => correr({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd }),
    arranque: (cwd) => correr({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup', cwd }),
    corregir: (args, cwd) => {
      const r = spawnSync(process.execPath, [gancho, '--correct', ...args], { cwd, env: env(home), encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    renglones,
    entradas: () => renglones().filter((e) => e.repoPath),
    sembrar: (entrada) => fs.appendFileSync(ledger, `${JSON.stringify({ ts: '2026-10-05T10:00:00.000Z', sessionId: 'otra', branch: 'main', cmd: 'gh pr create --base main --head dev', sha: 'abc123def456', ...entrada })}\n`),
  };
}
const corto = (sha) => sha.slice(0, 12);
const motivoDelCierre = (lab, cwd) => { const { stdout } = lab.cierre(cwd); return stdout ? JSON.parse(stdout).reason : ''; };

// ── al abrir el pedido ───────────────────────────────────────────────────────────────────────────

test('con la referencia del remoto vieja en la copia, anota la punta que contesta el remoto y la trae', () => {
  const { dir, vieja, nueva } = repoConRemotoAdelante();
  assert.ok(!existe(dir, nueva), 'la copia no conoce la punta nueva');
  const lab = laboratorio();
  lab.pedido('gh pr create --base main --head dev --title t --body-file cuerpo.md', dir);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.sha, corto(nueva));
  assert.notStrictEqual(e.sha, corto(vieja));
  assert.ok(existe(dir, nueva), 'la punta del remoto quedó en la copia, para el latido');
});

test('sin respuesta del remoto, anota la referencia de la copia', () => {
  const { dir, vieja } = repoConRemotoAdelante();
  git(dir, ['remote', 'set-url', 'origin', path.join(tmp(), 'no-existe.git')]);
  const lab = laboratorio();
  lab.pedido('gh pr create --base main --head dev --title t --body-file cuerpo.md', dir);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.strictEqual(e.sha, corto(vieja));
});

test('el pedido anota la rama de origen aparte de la rama destino', () => {
  const { dir } = repoConRemotoAdelante();
  const lab = laboratorio();
  lab.pedido('gh pr create --base main --head dev --title t --body-file cuerpo.md', dir);
  const [e] = lab.entradas();
  assert.strictEqual(e.branch, 'main');
  assert.strictEqual(e.origen, 'dev');
});

test('el pedido sin --head anota como origen la rama en la que está la carpeta', () => {
  const { dir } = repoConRemotoAdelante();
  git(dir, ['checkout', '--quiet', 'dev']);
  const lab = laboratorio();
  lab.pedido('gh pr create --base main --title t --body-file cuerpo.md', dir);
  const [e] = lab.entradas();
  assert.strictEqual(e.origen, 'dev');
});

test('el pedido con --head en una variable no inventa la rama de origen', () => {
  const { dir } = repoConRemotoAdelante();
  const lab = laboratorio();
  lab.pedido('gh pr create --base main --head "$RAMA" --title t --body-file cuerpo.md', dir);
  const [e] = lab.entradas();
  assert.ok(e, 'el pedido deja su entrada');
  assert.ok(!('origen' in e), JSON.stringify(e));
});

// ── la corrección ────────────────────────────────────────────────────────────────────────────────

test('corregir agrega un renglón con quién, cuándo y por qué, y no borra la entrada', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  const r = lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'la copia tenía dev atrasada'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const [entrada, correccion] = lab.renglones();
  assert.strictEqual(entrada.sha, corto(viejo), 'la entrada queda como estaba');
  assert.strictEqual(correccion.tipo, 'correccion');
  assert.deepStrictEqual(correccion.entrada, { repo: dir, sha: corto(viejo), ts: '2026-10-05T10:00:00.000Z' });
  assert.strictEqual(correccion.real, corto(real));
  assert.strictEqual(correccion.motivo, 'la copia tenía dev atrasada');
  assert.ok(correccion.quien, 'anota quién');
  assert.ok(Date.parse(correccion.ts), 'anota cuándo');
  assert.ok(!('repoPath' in correccion) && !('sha' in correccion), 'los lectores que no la conocen la saltean');
});

test('después de corregir, el cierre reclama el commit real y no el anotado', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  lab.corregir(['--sha', corto(viejo), '--real', corto(real), '--reason', 'm'], dir);
  const motivo = motivoDelCierre(lab, dir);
  assert.ok(motivo.includes(`--merge ${corto(real)}`), motivo);
  assert.ok(!motivo.includes(`--merge ${corto(viejo)}`), motivo);
});

test('el archivo del commit real salda la entrada corregida', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], dir);
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: dir, merge_commit: real, project: 'x' }));
  assert.strictEqual(lab.cierre(dir).stdout, '');
});

test('el archivo del commit anotado ya no salda la entrada corregida', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], dir);
  fs.writeFileSync(path.join(lab.dashboard, 'metrics-x.json'), JSON.stringify({ repo: dir, merge_commit: viejo, project: 'x' }));
  assert.ok(motivoDelCierre(lab, dir).includes(`--merge ${corto(real)}`));
});

test('corrige una entrada que hoy no se reclama (vieja y de otra carpeta)', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo), ts: '2025-01-01T00:00:00.000Z' });
  const r = lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], tmp());
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(lab.renglones().filter((c) => c.tipo === 'correccion').length, 1);
});

test('sin motivo no corrige', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  const r = lab.corregir(['--sha', corto(viejo), '--real', real], dir);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(lab.renglones().length, 1);
});

test('con un commit real que no existe en el repo no corrige', () => {
  const { dir, viejo } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  const r = lab.corregir(['--sha', corto(viejo), '--real', 'deadbeefdead', '--reason', 'm'], dir);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no existe/);
  assert.strictEqual(lab.renglones().length, 1);
});

test('una entrada exenta no se corrige', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo), exento: 'solo-tests-docs' });
  assert.strictEqual(lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], dir).status, 2);
});

test('con la misma sha en dos carpetas pide --repo, y con --repo corrige sólo esa', () => {
  const a = repoConMain();
  const b = path.join(tmp(), 'otra-copia');
  git(a.dir, ['worktree', 'add', '--quiet', '--detach', b, 'main']);
  const lab = laboratorio();
  lab.sembrar({ repoPath: a.dir, sha: corto(a.viejo) });
  lab.sembrar({ repoPath: b, sha: corto(a.viejo) });
  const ambigua = lab.corregir(['--sha', corto(a.viejo), '--real', a.real, '--reason', 'm'], a.dir);
  assert.strictEqual(ambigua.status, 2);
  assert.ok(ambigua.stderr.includes(a.dir) && ambigua.stderr.includes(b), ambigua.stderr);
  const r = lab.corregir(['--sha', corto(a.viejo), '--repo', b, '--real', a.real, '--reason', 'm'], a.dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const [c] = lab.renglones().filter((x) => x.tipo === 'correccion');
  assert.strictEqual(c.entrada.repo, b);
});

test('con la copia borrada y sin carpeta principal anotada, se corrige desde la principal y el latido va ahí', () => {
  const { dir, viejo, real } = repoConMain();
  const borrada = path.join(tmp(), 'copia-de-un-nombre-cualquiera');
  const lab = laboratorio();
  lab.sembrar({ repoPath: borrada, sha: corto(viejo) });
  const r = lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`--repo "${dir}" --merge ${corto(real)}`), r.stdout);
  assert.ok(motivoDelCierre(lab, dir).includes(`--repo "${dir}" --merge ${corto(real)}`));
});

test('con la copia borrada, desde una carpeta que no tiene el commit no corrige', () => {
  const { viejo, real } = repoConMain();
  // otro repo, con otra historia (los de repoConMain tienen las mismas shas: misma fecha, mismo contenido)
  const otro = tmp();
  git(otro, ['init', '--quiet', '-b', 'main']);
  commit(otro, 'otro.txt');
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(tmp(), 'ya-no-esta'), sha: corto(viejo) });
  const r = lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], otro);
  assert.strictEqual(r.status, 2);
  assert.strictEqual(lab.renglones().length, 1);
});

// ── el aviso de «ya estaba en main» ──────────────────────────────────────────────────────────────

test('si el commit del pedido ya estaba en main antes del pedido, el cierre lo dice con el comando de corregir', () => {
  const { dir, viejo } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  const motivo = motivoDelCierre(lab, dir);
  assert.match(motivo, /ya estaba en main antes del pedido/);
  assert.ok(motivo.includes(`--correct --repo "${dir}" --sha ${corto(viejo)}`), motivo);
});

test('el aviso de arranque también lo dice', () => {
  const { dir, viejo } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  assert.match(lab.arranque(dir).stdout, /ya estaba en main antes del pedido/);
});

test('un commit que no entró a main no lleva el aviso', () => {
  const { dir, fuera } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(fuera) });
  const motivo = motivoDelCierre(lab, dir);
  assert.ok(motivo.includes(`--merge ${corto(fuera)}`), motivo);
  assert.doesNotMatch(motivo, /ya estaba en main/);
});

test('un commit que entró a main después del pedido no lleva el aviso', () => {
  const { dir, viejo } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo), ts: '2026-09-01T10:00:00.000Z' });
  assert.doesNotMatch(motivoDelCierre(lab, dir), /ya estaba en main/);
});

test('un push a main no lleva el aviso: anota lo que acaba de subir', () => {
  const { dir, viejo } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo), cmd: 'git push origin main' });
  assert.doesNotMatch(motivoDelCierre(lab, dir), /ya estaba en main/);
});

test('una entrada corregida no lleva el aviso', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], dir);
  assert.doesNotMatch(motivoDelCierre(lab, dir), /ya estaba en main/);
});

// ── la carpeta principal de una entrada que no la anotó ──────────────────────────────────────────

test('una copia --slot-N borrada sin carpeta principal anotada manda el latido al hermano sin el sufijo', () => {
  const { dir, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: `${dir}--slot-1`, sha: corto(real), cmd: 'git push origin main' });
  assert.ok(motivoDelCierre(lab, dir).includes(`--repo "${dir}" --merge ${corto(real)}`));
});

test('una copia --wt-… borrada también encuentra su hermano', () => {
  const { dir, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: `${dir}--wt-tarea`, sha: corto(real), cmd: 'git push origin main' });
  assert.ok(motivoDelCierre(lab, dir).includes(`--repo "${dir}" --merge ${corto(real)}`));
});

test('una copia borrada de .claude/worktrees encuentra el repo que la contenía', () => {
  const { dir, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: path.join(dir, '.claude', 'worktrees', 'x'), sha: corto(real), cmd: 'git push origin main' });
  assert.ok(motivoDelCierre(lab, dir).includes(`--repo "${dir}" --merge ${corto(real)}`));
});

test('un hermano sin el commit de la entrada no cuenta como su principal', () => {
  const { dir } = repoConMain();
  const lab = laboratorio();
  const copia = `${dir}--slot-1`;
  lab.sembrar({ repoPath: copia, sha: 'abcdefabcdef', cmd: 'git push origin main' });
  // desde la carpeta que agrupa a los dos: la copia queda a un nivel, dentro del alcance del cierre
  assert.ok(motivoDelCierre(lab, path.dirname(dir)).includes(`--repo "${copia}" --merge abcdefabcdef`));
});
