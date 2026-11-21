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
  fs.cpSync(path.join(ROOT, 'integrations'), path.join(arnes, 'integrations'), { recursive: true });   // el lector de gh vive en su conector
  // quién es la coordinadora lo lee la biblioteca del pipeline, como en el arnés instalado
  fs.cpSync(path.join(ROOT, 'skills', 'tycon-pipeline', 'scripts', 'lib'), path.join(arnes, 'skills', 'tycon-pipeline', 'scripts', 'lib'), { recursive: true });
  const ledger = path.join(home, '.claude', '.tycon-pipeline', 'retro-pending.jsonl');
  const correr = (evento, extra = {}) => {
    const r = spawnSync(process.execPath, [gancho], { input: JSON.stringify(evento), env: { ...env(home), ...extra }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const renglones = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    ledger,
    dashboard: path.join(arnes, '.dashboard'),
    pedido: (command, cwd) => correr({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd }),
    cierre: (cwd) => correr({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd }),
    arranque: (cwd, extra) => correr({ session_id: 's2', hook_event_name: 'SessionStart', source: 'startup', cwd }, extra),
    home,
    corregir: (args, cwd, extra = {}) => {
      const r = spawnSync(process.execPath, [gancho, '--correct', ...args], { cwd, env: { ...env(home), ...extra }, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    renglones,
    entradas: () => renglones().filter((e) => e.repoPath),
    sembrar: (entrada) => fs.appendFileSync(ledger, `${JSON.stringify({ ts: '2026-10-05T10:00:00.000Z', sessionId: 'otra', branch: 'main', cmd: 'gh pr create --base main --head dev', sha: 'abc123def456', ...entrada })}\n`),
  };
}
const corto = (sha) => sha.slice(0, 12);
const motivoDelCierre = (lab, cwd) => { const { stdout } = lab.cierre(cwd); return stdout ? JSON.parse(stdout).reason : ''; };

// ── a qué rama llega el empuje ───────────────────────────────────────────────────────────────────

/** Un repo bajo el arnés con `main` siguiendo a `origin/main`; `origin` no existe: ninguna prueba sale a la red. */
function repoConSeguimiento() {
  const { dir } = repoConMain();
  git(dir, ['remote', 'add', 'origin', path.join(path.dirname(dir), 'no-esta.git')]);
  for (const r of ['main', 'otra']) git(dir, ['update-ref', `refs/remotes/origin/${r}`, 'HEAD']);
  git(dir, ['branch', '--quiet', '-u', 'origin/main', 'main']);
  return dir;
}
const pideLatido = (lab, dir, command) => {
  fs.rmSync(lab.ledger, { force: true });
  lab.pedido(command, dir);
  return lab.renglones().length > 0;
};

// T11 RetroPending_PushDestination — @story-8.288 @ac-13 @ac-14
// 🔴 Falla con: tomar por refspec lo que no lo es (una redirección, una variable, una sustitución) o el `push` de
// `-c push.default=…`: el destino sale con un nombre que no es main y un empuje real a main queda sin latido.
test('T11 RetroPending_WordsThatAreNotARefspec_AskAsBefore @story-8.288 @ac-14', () => {
  const dir = repoConSeguimiento();
  const lab = laboratorio();
  for (const c of [
    'git push origin 2>&1', 'git push origin 2>&1 | tail -5', 'git push origin > /tmp/empuje.log', 'git push origin @',
    'git push origin "$RAMA"', 'git push origin $(git branch --show-current)', 'git push origin `git branch --show-current`',
    'git push origin HEAD:$DESTINO', 'git -c push.default=current push', 'git -c push.default=current push origin main',
    'git -C . push origin main', 'git push --mirror origin', 'git push --delete origin otra', 'git push -d origin otra',
    "git push origin 'refs/heads/*:refs/heads/*'",
  ]) assert.ok(pideLatido(lab, dir, c), `con HEAD en main pide el latido: ${c}`);
});

test('T11 RetroPending_RedirectionsAndGitOptions_KeepTheRealDestination @story-8.288 @ac-13', () => {
  const dir = repoConSeguimiento();
  const lab = laboratorio();
  for (const c of [
    'git push origin otra 2>&1', 'git push origin otra 2>&1 | tail -5', 'git push origin otra > /tmp/empuje.log 2>&1',
    'git push origin otra 2>/dev/null', 'git -c push.default=current push origin otra', 'git -C . push origin otra',
  ]) assert.ok(!pideLatido(lab, dir, c), `va a otra: no pide el latido: ${c}`);
});

test('T11 RetroPending_NoRefspec_FollowsPushDefault @story-8.288 @ac-14', () => {
  const dir = repoConSeguimiento();
  const lab = laboratorio();
  git(dir, ['checkout', '--quiet', '-b', 'otra']);
  git(dir, ['branch', '--quiet', '-u', 'origin/main', 'otra']);
  assert.ok(!pideLatido(lab, dir, 'git push'), 'con `simple`, otro nombre: git lo rechaza y no llega a main');
  assert.ok(pideLatido(lab, dir, 'git -c push.default=upstream push'), '`upstream` sí va a la rama que sigue');
  assert.ok(!pideLatido(lab, dir, 'git -c push.default=current push'), '`current` va a la rama del mismo nombre');
  git(dir, ['checkout', '--quiet', 'main']);
  git(dir, ['branch', '--quiet', '-u', 'origin/otra', 'main']);
  assert.ok(!pideLatido(lab, dir, 'git push'), 'una main que sigue a origin/otra no llega a main');
  git(dir, ['config', 'push.default', 'current']);
  assert.ok(pideLatido(lab, dir, 'git push'), 'con `current`, la main va a main aunque siga a otra');
});

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

// Renglón 362 de la lista semanal: la coordinadora corrigió una entrada y el registro la anotó con el usuario de git de la
// máquina, como si la hubiera corregido la persona.
test('corregir desde la coordinadora dice que fue ella; desde otra sesión, el usuario de git', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  const estado = path.join(lab.home, '.claude', '.tycon-pipeline');
  fs.appendFileSync(path.join(estado, 'gates.log'), `${JSON.stringify({ ts: '2026-10-05T09:00:00.000Z', name: 'relay-designation', status: 'ok', sesion: 'sesion-coord', rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  const r = lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'otra punta'], dir, { CLAUDE_CODE_SESSION_ID: 'sesion-coord' });
  assert.strictEqual(r.status, 0, r.stderr);
  const c = lab.renglones().find((x) => x.tipo === 'correccion');
  assert.strictEqual(c.por, 'coordinadora');
  assert.match(c.quien, /^la coordinadora \(sesión sesion-coord/, c.quien);
  assert.match(r.stdout, /la coordinadora/, r.stdout);
  // la misma corrección desde otra sesión: el usuario de git, sin `por`
  const otro = repoConMain();
  const lab2 = laboratorio();
  lab2.sembrar({ repoPath: otro.dir, sha: corto(otro.viejo) });
  fs.appendFileSync(path.join(lab2.home, '.claude', '.tycon-pipeline', 'gates.log'), `${JSON.stringify({ ts: '2026-10-05T09:00:00.000Z', name: 'relay-designation', status: 'ok', sesion: 'sesion-coord', rol: 'coordinadora', quien: 'el dueño', cita: 'Esta sesión es la coordinadora' })}\n`);
  const r2 = lab2.corregir(['--sha', corto(otro.viejo), '--real', otro.real, '--reason', 'otra punta'], otro.dir, { CLAUDE_CODE_SESSION_ID: 'sesion-persona' });
  const c2 = lab2.renglones().find((x) => x.tipo === 'correccion');
  assert.ok(!('por' in c2), JSON.stringify(c2));
  assert.doesNotMatch(c2.quien, /coordinadora/, c2.quien);
});

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

test('un commit real que no trae al anotado no corrige', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(real) });
  const r = lab.corregir(['--sha', corto(real), '--real', viejo, '--reason', 'm'], dir);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /no trae al anotado/);
  assert.strictEqual(lab.renglones().length, 1);
});

test('si no puede escribir en el registro, lo dice y sale con error', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  fs.chmodSync(lab.ledger, 0o444);
  try {
    const r = lab.corregir(['--sha', corto(viejo), '--real', real, '--reason', 'm'], dir);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /no pude escribir la corrección/);
    assert.doesNotMatch(r.stdout, /queda corregida/);
  } finally { fs.chmodSync(lab.ledger, 0o644); }
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

// Un pedido creado no es un merge: el commit de un pedido sin su número no frena el cierre, aunque esté en main.
test('si el commit del pedido ya estaba en main antes del pedido, no frena y el aviso lo dice con el comando de corregir', () => {
  const { dir, viejo } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  assert.doesNotMatch(motivoDelCierre(lab, dir), new RegExp(corto(viejo)));
  const { stdout } = lab.arranque(dir);
  assert.match(stdout, /ya estaba en main antes del pedido/);
  assert.ok(stdout.includes(`--correct --repo "${dir}" --sha ${corto(viejo)}`), stdout);
});

test('el aviso de arranque también lo dice', () => {
  const { dir, viejo } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(viejo) });
  assert.match(lab.arranque(dir).stdout, /ya estaba en main antes del pedido/);
});

// La entrada vieja de un pedido cuyo commit no entró a main no frena el cierre: su latido no se puede escribir (el
// latido sólo acepta la línea de main), y el aviso de arranque la lista con el comando de --correct.
test('un commit que no entró a main no frena el cierre y sale en el aviso con --correct', () => {
  const { dir, fuera } = repoConMain();
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(fuera) });
  const motivo = motivoDelCierre(lab, dir);
  assert.doesNotMatch(motivo, new RegExp(corto(fuera)), motivo);
  const { stdout } = lab.arranque(dir);
  assert.match(stdout, new RegExp(`${corto(fuera)}[^\\n]*--correct`), stdout);
  assert.doesNotMatch(stdout, /ya estaba en main/);
});

// Este control corre en cada arranque y en cada cierre de turno, con una entrada por cada pedido de cada copia de trabajo.
test('las copias de trabajo de un repo comparten la lista de main: git la calcula una sola vez', () => {
  const { dir, fuera } = repoConMain();
  const copias = ['a', 'b', 'c'].map((n) => {
    const copia = `${dir}--wt-${n}`;
    git(dir, ['worktree', 'add', '--quiet', '-b', `copia-${n}`, copia, 'dev']);
    return copia;
  });
  const lab = laboratorio();
  // con número (sin estado: una entrada vieja), que es la que se juzga contra la línea de main
  for (const copia of copias) lab.sembrar({ repoPath: copia, sha: corto(fuera), pr: 7 });
  const traza = path.join(tmp(), 'git.trace');
  const { stdout } = lab.arranque(path.dirname(dir), { GIT_TRACE: traza });
  for (const copia of copias) assert.ok(stdout.includes(`${copia} @ ${corto(fuera)}`), stdout);
  const listas = fs.readFileSync(traza, 'utf8').split('\n').filter((l) => /built-in: git rev-list --first-parent/.test(l));
  assert.strictEqual(listas.length, 1, listas.join('\n'));
});

test('dos clones del mismo proyecto no comparten la lista de main', () => {
  const { dir } = repoConMain();
  const clon = `${dir}-clon`;
  git(path.dirname(dir), ['clone', '--quiet', '-b', 'main', dir, clon]);
  const nuevo = commit(dir, 'nuevo.txt');
  const lab = laboratorio();
  lab.sembrar({ repoPath: dir, sha: corto(nuevo), pr: 7 });
  lab.sembrar({ repoPath: clon, sha: corto(nuevo), pr: 7 });
  const { stdout } = lab.arranque(path.dirname(dir));
  const [reclamado, noSePaga] = stdout.split('un latido no puede pagar');
  assert.ok(reclamado.includes(`${dir} @ ${corto(nuevo)}`), stdout);
  assert.ok(noSePaga.includes(`${clon} @ ${corto(nuevo)}`), stdout);
  assert.ok(!noSePaga.includes(`${dir} @ ${corto(nuevo)}`), stdout);
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

test('un hermano sin el commit de la entrada no cuenta como su principal', () => {
  const { dir } = repoConMain();
  const lab = laboratorio();
  const copia = `${dir}--slot-1`;
  lab.sembrar({ repoPath: copia, sha: 'abcdefabcdef', cmd: 'git push origin main' });
  // desde la carpeta que agrupa a los dos: la copia queda a un nivel. Sin la copia ni un hermano con el commit, ningún latido
  // la paga: no corta, y el aviso nombra la copia, no al hermano
  const { stdout } = lab.cierre(path.dirname(dir));
  const salida = JSON.parse(stdout);
  assert.strictEqual(salida.decision, undefined, stdout);
  assert.ok(salida.systemMessage.includes(`${copia} @ abcdefabcdef`) && !salida.systemMessage.includes(`--repo "${dir}"`), salida.systemMessage);
});

// ── el mismo commit anotado desde dos copias del mismo repo ─────────

test('--correct con la carpeta de una copia corrige todas las copias de esa entrega', () => {
  const { dir, viejo, real } = repoConMain();
  const lab = laboratorio();
  for (const n of ['a', 'b']) lab.sembrar({ repoPath: `${dir}--wt-${n}`, principal: dir, sha: corto(viejo) });
  const r = lab.corregir(['--repo', `${dir}--wt-a`, '--sha', corto(viejo), '--real', real, '--reason', 'la copia tenía dev atrasada'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const corregidas = lab.renglones().filter((x) => x.tipo === 'correccion').map((x) => x.entrada.repo).sort();
  assert.deepStrictEqual(corregidas, [`${dir}--wt-a`, `${dir}--wt-b`]);
});

test('de dos copias del mismo commit se juzga la que trae el número del pedido, en cualquier orden', () => {
  for (const orden of [['sin', 'con'], ['con', 'sin']]) {
    const { dir, fuera } = repoConMain();
    const lab = laboratorio();
    const entradas = {
      sin: { repoPath: `${dir}--wt-a`, principal: dir, sha: corto(fuera) },
      con: { repoPath: dir, sha: corto(fuera), pr: 77, plataforma: 'azure', estado: 'esperando' },
    };
    for (const k of orden) lab.sembrar(entradas[k]);
    const { stdout } = lab.arranque(dir, { TYCON_RETRO_ASK_PR: '0' });
    assert.doesNotMatch(stdout, /pedido sin su número/, `${orden.join(',')}: ${stdout}`);
    assert.doesNotMatch(motivoDelCierre(lab, dir), new RegExp(corto(fuera)));
  }
});
