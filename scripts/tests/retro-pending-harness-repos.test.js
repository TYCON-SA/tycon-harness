'use strict';
// retro-pending-harness-repos.test.js — los repos del arnés (el privado de Azure y el público de GitHub) se anotan y piden
// su retrospectiva como un repo de producto, y las exenciones de siempre valen igual para ellos. Repos de juguete con git
// de verdad, una copia del gancho con su HOME propia e identidades del arnés de mentira: sin red.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// las identidades del arnés de la prueba: una de Azure (el privado) y una de GitHub (el público)
const ARNES_PRIVADO = 'https://dev.azure.com/acme/Arnes/_git/arnes-privado';
const ARNES_PUBLICO = 'https://github.com/acme/arnes-publico.git';

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retro-arnes-'))); dirs.push(d); return d; };

function env(home) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|TYCON_|BUILD_|SYSTEM_|TF_BUILD|CLAUDE_)/.test(k)) e[k] = v;
  // sin carpetas de laboratorio: estos repos viven en el temporal y se miden como repos de verdad
  // sin la consulta al remoto: los `origin` son direcciones de mentira, y una prueba no sale a la red
  return { ...e, HOME: home, USERPROFILE: home, TYCON_RETRO_LAB_DIRS: '', TYCON_RETRO_ASK_REMOTE: '0',
    TYCON_HARNESS_IDENTITIES: `${ARNES_PRIVADO},${ARNES_PUBLICO}`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'sin-global'),
    GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.invalid', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.invalid',
    GIT_AUTHOR_DATE: '2026-10-01T10:00:00', GIT_COMMITTER_DATE: '2026-10-01T10:00:00' };
}
function git(dir, args) {
  const r = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-C', dir, ...args], { env: env(os.tmpdir()), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(dir, archivos, asunto) {
  for (const [nombre, texto] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, nombre)), { recursive: true });
    fs.writeFileSync(path.join(dir, nombre), texto);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', asunto]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** Un repo en `<tmp>/<nombre>` con un commit de base; `origen` (o ninguno) y `.tycon/` sólo si se pide. */
function repo({ nombre = 'repo', origen = null, tycon = false } = {}) {
  const dir = path.join(tmp(), nombre);
  fs.mkdirSync(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  commit(dir, { 'base.txt': 'base\n', ...(tycon ? { '.tycon/advisors.yaml': '' } : {}) }, 'base');
  if (origen) git(dir, ['remote', 'add', 'origin', origen]);
  return dir;
}

/**
 * Lo que deja un `git push origin main`: `origin/main` estaba en la base y ahora está en la punta, con su reflog
 * (`origin/main@{1}` es lo que lee el gancho para saber qué trajo el push). La referencia se crea primero y se mueve
 * después: con un solo `update-ref` no existiría `@{1}` y el gancho no sabría qué trajo.
 */
function empujar(dir, commits) {
  const base = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['update-ref', '-m', 'push', 'refs/remotes/origin/main', base]);
  for (const [archivos, asunto] of commits) commit(dir, archivos, asunto);
  const punta = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['update-ref', '-m', 'push', 'refs/remotes/origin/main', punta]);
  return punta;
}

/** Una copia del gancho con sus bibliotecas y un HOME propio: el registro es el de esta prueba. */
function laboratorio() {
  const base = tmp();
  const home = path.join(base, 'home');
  const arnes = path.join(base, 'gancho');
  fs.mkdirSync(path.join(home, '.claude', '.tycon-pipeline'), { recursive: true });
  fs.mkdirSync(path.join(arnes, 'scripts', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(arnes, '.dashboard'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'hooks', 'retro-pending.js'), path.join(arnes, 'scripts', 'hooks', 'retro-pending.js'));
  fs.cpSync(path.join(ROOT, 'scripts', 'lib'), path.join(arnes, 'scripts', 'lib'), { recursive: true });
  const gancho = path.join(arnes, 'scripts', 'hooks', 'retro-pending.js');
  const ledger = path.join(home, '.claude', '.tycon-pipeline', 'retro-pending.jsonl');
  return {
    comando: (command, cwd) => spawnSync(process.execPath, [gancho], { input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd }), env: env(home), encoding: 'utf8' }),
    juzgar: (dir) => JSON.parse(spawnSync(process.execPath, [gancho, '--judge', dir], { env: env(home), encoding: 'utf8' }).stdout),
    entradas: () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

/** El gancho salió 0 y sin traza de error: lo que no anotó lo decidió, no se le cayó. */
function terminoBien(r, que) {
  assert.strictEqual(r.status, 0, `${que}: el gancho salió ${r.status} (stderr: ${r.stderr})`);
  assert.doesNotMatch(r.stderr, /Error|at .+:\d+:\d+/, `${que}: el gancho dejó una traza de error`);
}

test('RetroPending_PushToMainInPrivateHarnessRepo_IsRecorded @story-8.269 @ac-11', () => {
  const dir = repo({ origen: ARNES_PRIVADO, tycon: true });
  const punta = empujar(dir, [[{ 'scripts/a.js': 'a\n' }, 'feat: algo']]);
  const lab = laboratorio();
  const r = lab.comando('git push origin main', dir);
  const entradas = lab.entradas();
  assert.strictEqual(entradas.length, 1, `el push a main del privado deja su renglón (stderr: ${r.stderr})`);
  assert.strictEqual(entradas[0].repoPath, dir);
  assert.strictEqual(entradas[0].sha, punta.slice(0, 12));
  assert.strictEqual(entradas[0].exento, undefined);

  // el pedido hacia main por Azure también: la carpeta se llama como el repo del remoto, que es como lo busca el lector
  const pedido = repo({ nombre: 'arnes-privado', origen: ARNES_PRIVADO, tycon: true });
  git(pedido, ['checkout', '--quiet', '-b', 'tarea']);
  const tarea = commit(pedido, { 'scripts/e.js': 'e\n' }, 'feat: por pedido');
  const labPedido = laboratorio();
  const rp = labPedido.comando('az repos pr create --org https://dev.azure.com/acme --project Arnes --source-branch tarea --target-branch main', pedido);
  const enPedido = labPedido.entradas();
  assert.strictEqual(enPedido.length, 1, `el pedido de Azure hacia main del privado deja su renglón (stderr: ${rp.stderr})`);
  assert.strictEqual(enPedido[0].repoPath, pedido);
  assert.strictEqual(enPedido[0].sha, tarea.slice(0, 12));
});

test('RetroPending_PrCreateInPublicHarnessRepo_IsRecorded @story-8.269 @ac-12', () => {
  const dir = repo({ origen: ARNES_PUBLICO });
  assert.ok(!fs.existsSync(path.join(dir, '.tycon')) && !fs.existsSync(path.join(dir, '.advisors')));
  git(dir, ['checkout', '--quiet', '-b', 'tarea']);
  const punta = commit(dir, { 'scripts/b.js': 'b\n' }, 'feat: otra cosa');
  const lab = laboratorio();
  const r = lab.comando('gh pr create --base main --head tarea --title t --body-file cuerpo.md', dir);
  const entradas = lab.entradas();
  assert.strictEqual(entradas.length, 1, `el pedido hacia main del público deja su renglón (stderr: ${r.stderr})`);
  assert.strictEqual(entradas[0].repoPath, dir);
  assert.strictEqual(entradas[0].sha, punta.slice(0, 12));
});

test('RetroPending_JudgeHarnessRepo_WouldRecord @story-8.269 @ac-13', () => {
  const lab = laboratorio();
  const dir = repo({ origen: ARNES_PRIVADO, tycon: true });
  empujar(dir, [[{ 'scripts/a.js': 'a\n' }, 'feat: algo']]);
  const j = lab.juzgar(dir);
  assert.strictEqual(j.arnes, true);
  assert.strictEqual(j.arnes_por, 'remoto');
  assert.strictEqual(j.registraria, true, 'un repo del arnés se anotaría');

  const retro = repo({ origen: ARNES_PRIVADO, tycon: true });
  empujar(retro, [[{ '.dashboard/metrics-x.json': '{}\n' }, 'chore(retro): métricas del merge']]);
  const jr = lab.juzgar(retro);
  assert.strictEqual(jr.arnes, true);
  assert.strictEqual(jr.retro, true);
  assert.strictEqual(jr.registraria, false, 'la salida de una retrospectiva no se anota, tampoco en el arnés');

  // `registraria` contesta lo mismo que el gancho: una carpeta con nombre de arnés, sin origin ni .tycon/ ni .advisors/,
  // es un repo suelto y no se anota
  const suelto = repo({ nombre: 'tycon-harness' });
  empujar(suelto, [[{ 'scripts/g.js': 'g\n' }, 'feat: suelto']]);
  const js = lab.juzgar(suelto);
  assert.strictEqual(js.arnes, true);
  assert.strictEqual(js.arnes_por, 'carpeta');
  assert.strictEqual(js.registraria, false, 'el juicio no pide una retrospectiva que el gancho no reclama');
  const r = lab.comando('git push origin main', suelto);
  assert.strictEqual(lab.entradas().length, 0, 'y el gancho, en efecto, no lo anota');
  terminoBien(r, 'carpeta suelta con nombre de arnés');
});

test('RetroPending_HarnessRepo_ExemptionsStillApply @story-8.269 @ac-14 @ac-16', () => {
  const casos = [
    { que: 'sólo chore(retro', commits: [[{ '.dashboard/m.json': '{}\n' }, 'chore(retro): métricas']], espera: 'nada' },
    { que: 'sólo tests y documentos', commits: [[{ 'scripts/tests/x.test.js': 'x\n', 'guides/x.md': 'texto\n' }, 'test: más pruebas']], espera: 'exento' },
    { que: 'mixto', commits: [[{ '.dashboard/m.json': '{}\n' }, 'chore(retro): métricas'], [{ 'scripts/c.js': 'c\n' }, 'fix: algo']], espera: 'pide' },
  ];
  for (const c of casos) {
    const lab = laboratorio();
    const dir = repo({ origen: ARNES_PRIVADO, tycon: true });
    empujar(dir, c.commits);
    const r = lab.comando('git push origin main', dir);
    const entradas = lab.entradas();
    // «sin renglón» tiene que ser una decisión del gancho, no un gancho que se cayó
    if (c.espera === 'nada') { assert.strictEqual(entradas.length, 0, `${c.que}: sin renglón`); terminoBien(r, c.que); }
    else {
      assert.strictEqual(entradas.length, 1, `${c.que}: un renglón`);
      if (c.espera === 'exento') assert.strictEqual(entradas[0].exento, 'solo-tests-docs', `${c.que}: renglón exento`);
      else assert.strictEqual(entradas[0].exento, undefined, `${c.que}: renglón que pide retrospectiva`);
    }
  }
  // un repo suelto (sin origin, sin .tycon/ ni .advisors/) no debe retrospectiva, se llame como se llame su carpeta
  for (const nombre of ['suelto', 'tycon-harness']) {
    const lab = laboratorio();
    const dir = repo({ nombre });
    empujar(dir, [[{ 'scripts/d.js': 'd\n' }, 'feat: suelto']]);
    const r = lab.comando('git push origin main', dir);
    assert.strictEqual(lab.entradas().length, 0, `repo suelto en «${nombre}»: sin renglón`);
    terminoBien(r, `repo suelto en «${nombre}»`);
  }
  // reconocido sólo por el nombre de la carpeta pero con `.tycon/`: se anota como cualquier repo bajo el arnés
  const lab = laboratorio();
  const conTycon = repo({ nombre: 'tycon-harness', tycon: true });
  empujar(conTycon, [[{ 'scripts/f.js': 'f\n' }, 'feat: con .tycon']]);
  lab.comando('git push origin main', conTycon);
  assert.strictEqual(lab.entradas().length, 1, 'carpeta con nombre de arnés, sin origin y con .tycon/: un renglón');
});
