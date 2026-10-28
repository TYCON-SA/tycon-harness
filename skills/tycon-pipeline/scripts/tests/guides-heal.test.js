'use strict';
// guides-heal.test.js — la sanadora del clon del arnés destraba de verdad y su consejo a mano funciona (T12-T14).
//
// Lo que no se puede perder:
//   · Con un conflicto que HEAD no tiene (DU: lo publicado borró un archivo que el dev había tocado), `unstick` destraba:
//     `rm --cached` para ése (no trae marcadores y no se le piden) y `checkout HEAD --` para los UU. Exigir
//     marcadores en todos devolvería «parece resuelto a mano», falso, y el clon no se repararía nunca.
//   · Los rechazos de siempre siguen: un UU sin marcadores (resuelto a mano) o un stash que no es un autostash.
//   · El consejo a mano (`manualAdvice`) se CORRE, no se lee: un comando por tipo, rutas y carpeta citadas, y `git stash`
//     antes del merge cuando un archivo tocado después choca con lo publicado.
//
// Laboratorio: repos de juguete bajo `mktemp` (nunca bajo una ruta del arnés), git sin la configuración de la máquina.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { unstick, manualAdvice, collidingFiles } = require('../lib/guides-heal.js');

const ENV = Object.assign({}, process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'Lab', GIT_AUTHOR_EMAIL: 'lab@example.com', GIT_COMMITTER_NAME: 'Lab', GIT_COMMITTER_EMAIL: 'lab@example.com',
});
for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete ENV[k];
// la misma forma que makeGit de la sanadora: devuelve stdout recortado, tira si git falla
const git = (dir, args, opts = {}) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args],
  { encoding: 'utf8', env: ENV, timeout: opts.timeout || 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (dir, args) => { try { return git(dir, args); } catch { return null; } };

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'tycon-guides-heal-'));
if (/tycon-claude-guides|agent-skills|\.claude/.test(BASE)) throw new Error(`el laboratorio cayó en ${BASE}`);
process.on('exit', () => fs.rmSync(BASE, { recursive: true, force: true }));
let n = 0;
const write = (dir, rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
const unmerged = (dir) => git(dir, ['ls-files', '-u']).split('\n').filter(Boolean).length;

/** Un clon trabado como lo deja el arranque: lo publicado borra `du` y cambia `uu`; el dev tocó los dos. */
function stuck({ du = 'skills/acme/SKILL.md', uu = 'skills/own/SKILL.md', parent = BASE, extra = {} } = {}) {
  const root = path.join(parent, `lab-${++n}`);
  const up = path.join(root, 'up');
  const clone = path.join(root, 'clon');
  fs.mkdirSync(up, { recursive: true });
  git(up, ['init', '-q', '-b', 'main']);
  write(up, du, 'ajena v1\n'); if (uu) write(up, uu, 'propia v1\n');
  for (const [rel, s] of Object.entries(extra)) write(up, rel, s);
  git(up, ['add', '-A']); git(up, ['commit', '-q', '-m', 'A']);
  git(root, ['clone', '-q', up, clone]);
  git(up, ['rm', '-q', '--', du]); if (uu) write(up, uu, 'propia v2\n');
  git(up, ['add', '-A']); git(up, ['commit', '-q', '-m', 'B: retiro']);
  write(clone, du, 'ajena, tocada por el dev\n'); if (uu) write(clone, uu, 'propia, tocada por el dev\n');
  tryGit(clone, ['pull', '-q', '--ff-only', '--autostash']);
  return { up, clone };
}
/** Corre, en orden, las líneas `git -C …` del consejo; devuelve el primer exit code distinto de 0 (o 0). */
function runAdvice(advice, cwd = BASE) {
  for (const line of advice.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('git -C '))) {
    try { execFileSync('bash', ['-c', line], { cwd, env: ENV, stdio: 'ignore' }); } catch (e) { return e.status || 1; }
  }
  return 0;
}

test('T12 GuidesHeal_DuYUu_Destraba — un DU y un UU con autostash: destraba, lo del dev queda en el disco y en el stash', () => {
  const { clone } = stuck();
  assert.ok(unmerged(clone) > 0, 'el laboratorio no quedó trabado');
  const r = unstick(git, clone);
  assert.strictEqual(r && r.unstuck, true, `no destrabó: ${JSON.stringify(r)}`);
  assert.strictEqual(unmerged(clone), 0, 'quedaron conflictos');
  assert.strictEqual(fs.readFileSync(path.join(clone, 'skills/acme/SKILL.md'), 'utf8'), 'ajena, tocada por el dev\n');
  assert.match(git(clone, ['stash', 'list']), /autostash/);
  assert.deepStrictEqual([...r.files].sort(), ['skills/acme/SKILL.md', 'skills/own/SKILL.md']);
});

test('T12 GuidesHeal_SoloDu_Destraba — sólo un DU (ningún archivo con marcadores): destraba igual', () => {
  const { clone } = stuck({ uu: null });
  assert.ok(unmerged(clone) > 0, 'el laboratorio no quedó trabado');
  const r = unstick(git, clone);
  assert.strictEqual(r && r.unstuck, true, `no destrabó: ${JSON.stringify(r)}`);
  assert.strictEqual(unmerged(clone), 0);
});

test('T13 GuidesHeal_Rechazos_Siguen — un UU resuelto a mano y un stash que no es autostash no se tocan', () => {
  const a = stuck();
  write(a.clone, 'skills/own/SKILL.md', 'resuelto por el dev, sin marcadores\n');
  const before = unmerged(a.clone);
  const r = unstick(git, a.clone);
  assert.strictEqual(r && r.unstuck, false);
  assert.match(r.reason, /resuelto a mano/);
  assert.strictEqual(unmerged(a.clone), before, 'tocó el índice');

  const root = path.join(BASE, `lab-${++n}`);
  const up = path.join(root, 'up'); const clone = path.join(root, 'clon');
  fs.mkdirSync(up, { recursive: true }); git(up, ['init', '-q', '-b', 'main']);
  write(up, 'skills/acme/SKILL.md', 'v1\n'); git(up, ['add', '-A']); git(up, ['commit', '-q', '-m', 'A']);
  git(root, ['clone', '-q', up, clone]);
  git(up, ['rm', '-q', 'skills/acme/SKILL.md']); git(up, ['commit', '-q', '-m', 'B']);
  write(clone, 'skills/acme/SKILL.md', 'mío\n');
  git(clone, ['stash', 'push', '-q', '-m', 'guardado a mano']); git(clone, ['fetch', '-q']);
  git(clone, ['merge', '-q', '--ff-only', 'origin/main']); tryGit(clone, ['stash', 'apply', '-q']);
  const u0 = unmerged(clone);
  assert.ok(u0 > 0, 'el laboratorio sin autostash no quedó trabado');
  const r2 = unstick(git, clone);
  assert.strictEqual(r2 && r2.unstuck, false);
  assert.match(r2.reason, /no viene de un autostash/);
  assert.strictEqual(unmerged(clone), u0, 'tocó el índice');
});

test('T13 GuidesHeal_FalloParcial_SeDice — el rm --cached anda y el checkout falla: no dice «no toqué nada», nombra lo que ya sacó', () => {
  const { clone } = stuck();
  // el mismo git, salvo que el checkout falla (un disco lleno, un permiso): la única forma de partir los dos pasos
  const gitCheckoutFalla = (dir, args, opts) => { if (args[0] === 'checkout') throw new Error('checkout: disco lleno'); return git(dir, args, opts); };
  const r = unstick(gitCheckoutFalla, clone);
  assert.strictEqual(r && r.unstuck, false);
  assert.deepStrictEqual(r.gone, ['skills/acme/SKILL.md'], JSON.stringify(r));
  assert.match(r.reason, /saqu[eé] del índice.*skills\/acme\/SKILL\.md/, r.reason);
  assert.match(r.reason, /checkout/, r.reason);
  // y un rm --cached que falla sí es «no toqué nada»: el motivo lo dice
  const b = stuck();
  const gitRmFalla = (dir, args, opts) => { if (args[0] === 'rm') throw new Error('rm: index.lock'); return git(dir, args, opts); };
  const r2 = unstick(gitRmFalla, b.clone);
  assert.strictEqual(r2 && r2.unstuck, false);
  assert.match(r2.reason, /rm --cached falló/, r2.reason);
  assert.ok(unmerged(b.clone) > 0, 'con el rm fallido el índice tiene que quedar como estaba');
});

test('FUP-8.5.1-sello-parcial — heal() a medias: el aviso lo dice y el sello de la sesión guarda partial y gone', { skip: process.getuid && process.getuid() === 0 ? 'como root el permiso de la carpeta no frena el checkout' : false }, () => {
  const { clone } = stuck();
  // el checkout de la UU no puede escribir (carpeta de sólo lectura); el rm --cached de la DU sólo toca el índice
  const ro = path.join(clone, 'skills/own');
  fs.chmodSync(ro, 0o555);
  const stateDir = path.join(BASE, `estado-${++n}`);
  let msg;
  try {
    msg = require('../lib/guides-heal.js').heal({ sessionId: 'sesion-fup', stateDir, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone }) });
  } finally { fs.chmodSync(ro, 0o755); }
  assert.match(String(msg), /a medias/, String(msg));
  const sello = JSON.parse(fs.readFileSync(require('../lib/guides-heal.js').stampPath(stateDir, 'sesion-fup'), 'utf8'));
  assert.strictEqual(sello.result, 'stuck', JSON.stringify(sello));
  assert.strictEqual(sello.partial, true, JSON.stringify(sello));
  assert.deepStrictEqual(sello.gone, ['skills/acme/SKILL.md'], JSON.stringify(sello));
});

test('T14 GuidesHeal_ConsejoAMano_Separado — DU + UU bajo una carpeta con espacio: un comando por tipo, citados, y corridos destraban', () => {
  fs.mkdirSync(path.join(BASE, 'con espacio'), { recursive: true });
  const { clone } = stuck({ parent: path.join(BASE, 'con espacio'), du: 'skills/con espacio/SKILL.md' });
  const advice = manualAdvice(git, clone, collidingFiles(git, clone));
  const lines = advice.split('\n').map((l) => l.trim());
  const rm = lines.filter((l) => l.includes('rm --cached'));
  const co = lines.filter((l) => l.includes('checkout HEAD'));
  assert.strictEqual(rm.length, 1, advice); assert.strictEqual(co.length, 1, advice);
  assert.ok(rm[0].startsWith(`git -C '${clone}' rm --cached -- 'skills/con espacio/SKILL.md'`), rm[0]);
  assert.ok(!rm[0].includes('skills/own'), rm[0]);
  assert.ok(co[0].startsWith(`git -C '${clone}' checkout HEAD -- skills/own/SKILL.md`), co[0]);
  assert.ok(!co[0].includes('con espacio/SKILL'), co[0]);
  assert.strictEqual(runAdvice(advice), 0, advice);
  assert.strictEqual(unmerged(clone), 0);
});

test('T14 GuidesHeal_TrabadoYAtrasado_StashAntesDelMerge — un archivo tocado después que lo publicado cambia: git stash, y la secuencia entra', () => {
  const { up, clone } = stuck({ extra: { 'docs/NOTAS.md': 'notas v1\n' } });
  write(clone, 'docs/NOTAS.md', 'notas, tocadas después de trabarse\n');
  write(up, 'docs/NOTAS.md', 'notas v2\n'); git(up, ['commit', '-q', '-am', 'C']); git(clone, ['fetch', '-q', 'origin']);
  const advice = manualAdvice(git, clone, collidingFiles(git, clone));
  const cmds = advice.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('git -C '));
  const iStash = cmds.findIndex((l) => / stash$/.test(l.split('#')[0].trim()));
  const iMerge = cmds.findIndex((l) => l.includes('merge --ff-only'));
  assert.ok(iStash >= 0 && iStash < iMerge, advice);
  assert.strictEqual(runAdvice(advice), 0, advice);
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), git(up, ['rev-parse', 'HEAD']));
});

// T10: con el estado del mecanismo nuevo (`harness-state.json`, schema ≥ 1) la sanadora se hace a
// un lado —registra `delegated` y no toca git—; sin estado hace lo de siempre. La referencia entre repos tolera las dos
// situaciones hasta el retiro (regla «entre repos»).
function behind({ parent = BASE } = {}) {
  const root = path.join(parent, `lab-${++n}`);
  const up = path.join(root, 'up');
  const clone = path.join(root, 'clon');
  fs.mkdirSync(up, { recursive: true });
  git(up, ['init', '-q', '-b', 'main']);
  write(up, 'skills/own/SKILL.md', 'v1\n');
  git(up, ['add', '-A']); git(up, ['commit', '-q', '-m', 'A']);
  git(root, ['clone', '-q', up, clone]);
  write(up, 'skills/own/SKILL.md', 'v2\n'); git(up, ['commit', '-q', '-am', 'B']);
  git(clone, ['fetch', '-q', 'origin']);
  return { up, clone };
}

test('T10 GuidesHeal_DelegatesWithState — con harness-state.json legible registra delegated y no toca el clon atrasado', () => {
  const { up, clone } = behind();
  const stateDir = path.join(BASE, `estado-${++n}`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'harness-state.json'), JSON.stringify({ schema: 1, mode: 'managed', tree: clone }) + '\n');
  const before = git(clone, ['rev-parse', 'HEAD']);
  const { heal, stampPath } = require('../lib/guides-heal.js');
  const msg = heal({ sessionId: 'sesion-t10a', stateDir, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.strictEqual(msg, null, String(msg));
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before, 'con estado, la sanadora no avanza el clon');
  assert.notStrictEqual(git(clone, ['rev-parse', 'HEAD']), git(up, ['rev-parse', 'HEAD']), 'el laboratorio tiene que estar atrasado de verdad');
  const sello = JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t10a'), 'utf8'));
  assert.strictEqual(sello.result, 'delegated', JSON.stringify(sello));
});

test('T10 GuidesHeal_WithoutState_HealsAsToday — sin estado hace lo de hoy: avanza el clon atrasado', () => {
  const { up, clone } = behind();
  const stateDir = path.join(BASE, `estado-${++n}`);
  const { heal, stampPath } = require('../lib/guides-heal.js');
  const msg = heal({ sessionId: 'sesion-t10b', stateDir, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.match(String(msg), /al día|puse al día|atrás/, String(msg));
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), git(up, ['rev-parse', 'HEAD']), 'sin estado, la sanadora avanza el clon');
  const sello = JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t10b'), 'utf8'));
  assert.strictEqual(sello.result, 'healed', JSON.stringify(sello));
});

// T35: la sanadora es el TERCER actualizador —avanza el clon del arnés por su cuenta en el primer
// mensaje de la sesión—. Desde la unión de los dos repos ese clon puede ser el lugar del que salen las skills (la máquina
// de un solo árbol): si `main` vuelve a un árbol de antes de la unión, avanzar deja a la máquina sin skills. No avanza, y
// lo dice. Si las skills salen de OTRO clon (la máquina de dos clones), sigue a `main` como siempre: es el retorno.
function unified({ parent = BASE, tip = 'without-skills' } = {}) {
  const root = path.join(parent, `lab-${++n}`);
  const up = path.join(root, 'up');
  const clone = path.join(root, 'clon');
  fs.mkdirSync(up, { recursive: true });
  git(up, ['init', '-q', '-b', 'main']);
  write(up, 'skills/tycon-pipeline/SKILL.md', 'la skill\n'); write(up, 'agents/reviewer.md', 'un revisor\n'); write(up, 'scripts/install-tycon-hooks.sh', '#!/bin/sh\n');
  git(up, ['add', '-A']); git(up, ['commit', '-q', '-m', 'la unión: el arnés con las skills']);
  git(root, ['clone', '-q', up, clone]);
  if (tip === 'without-skills') { git(up, ['rm', '-r', '-q', 'skills', 'agents']); git(up, ['commit', '-q', '-m', 'retorno: main vuelve al árbol de antes de la unión']); }
  else { write(up, 'skills/tycon-pipeline/SKILL.md', 'la skill, v2\n'); git(up, ['commit', '-q', '-am', 'una versión nueva, con las skills']); }
  git(clone, ['fetch', '-q', 'origin']);
  return { up, clone };
}
/** Una HOME de juguete cuyo `~/.claude/agent-skills` es `target` (un enlace), o una carpeta aparte si no se pasa. */
function homeWith(target) {
  const home = path.join(BASE, `home-${++n}`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (target) fs.symlinkSync(target, path.join(home, '.claude', 'agent-skills'));
  else write(path.join(home, '.claude', 'agent-skills'), 'skills/tycon-pipeline/SKILL.md', 'la skill del clon viejo\n');
  return home;
}

test('T35 GuidesHeal_TipWithoutSkills_NotApplied — un solo árbol y lo publicado ya no trae las skills: no avanza, y lo dice', () => {
  const { up, clone } = unified();
  const home = homeWith(clone);
  const stateDir = path.join(BASE, `estado-${++n}`);
  const before = git(clone, ['rev-parse', 'HEAD']);
  const { heal, stampPath } = require('../lib/guides-heal.js');
  const msg = heal({ sessionId: 'sesion-t35a', stateDir, home, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before, 'la sanadora avanzó a una punta sin skills');
  assert.notStrictEqual(before, git(up, ['rev-parse', 'HEAD']), 'el laboratorio tiene que estar atrasado de verdad');
  assert.ok(fs.existsSync(path.join(clone, 'skills', 'tycon-pipeline', 'SKILL.md')), 'las skills tienen que seguir');
  assert.match(String(msg), /la versión nueva no trae las skills: no se aplica/, String(msg));
  const sello = JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t35a'), 'utf8'));
  assert.strictEqual(sello.result, 'no-skills', JSON.stringify(sello));
});

test('T35 GuidesHeal_TwoClones_FollowsMain — espejo: las skills salen de OTRO clon → el clon del arnés sí sigue a main (el retorno de antes de la llave)', () => {
  const { up, clone } = unified();
  const home = homeWith(null);
  const stateDir = path.join(BASE, `estado-${++n}`);
  const { heal, stampPath } = require('../lib/guides-heal.js');
  heal({ sessionId: 'sesion-t35b', stateDir, home, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), git(up, ['rev-parse', 'HEAD']), 'con dos clones la sanadora tiene que seguir a main');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'agent-skills', 'skills', 'tycon-pipeline', 'SKILL.md')), 'las skills del otro clon no se tocan');
  assert.strictEqual(JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t35b'), 'utf8')).result, 'healed');
});

test('T35 GuidesHeal_TipWithSkills_Advances — espejo: un solo árbol y una versión nueva que SÍ trae las skills: avanza', () => {
  const { up, clone } = unified({ tip: 'with-skills' });
  const home = homeWith(clone);
  const stateDir = path.join(BASE, `estado-${++n}`);
  const { heal } = require('../lib/guides-heal.js');
  heal({ sessionId: 'sesion-t35c', stateDir, home, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), git(up, ['rev-parse', 'HEAD']), 'una versión con las skills tiene que avanzar');
});

// T35: «no pude mirar» no es «no trae las skills».
// Preguntar con `git cat-file -e <commit>:skills/tycon-pipeline` contesta lo mismo si el árbol no trae la
// carpeta que si git no pudo leerlo (un objeto que falta, un candado, un tiempo agotado: la sanadora corre con 8 s por
// llamada). Con el árbol de HEAD sin leer se entendería «de esta copia no salen las skills» y se avanzaría: a una punta sin
// skills. Con el de lo publicado sin leer se frenaría —bien—, pero diciendo «no trae las skills», que no sería cierto.
// Cómo se mide: un `git` de laboratorio delante del PATH que falla (128) sólo cuando le preguntan por el árbol de UN
// commit; todo lo demás va al git de verdad.
const NO_SH = process.platform === 'win32' ? 'el git de laboratorio es un guion de sh' : false;
function blindGit(rev) {
  const bin = path.join(BASE, `bin-${++n}`);
  fs.mkdirSync(bin, { recursive: true });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: ENV }).trim();
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    '# git de laboratorio (guides-heal.test.js): «no puedo leer el árbol» de un commit; lo demás, al git de verdad',
    'case " $* " in',
    `  *" ls-tree "*"${rev}^{tree}"*|*" cat-file "*"${rev}:"*) echo "fatal: unable to read tree (laboratorio)" >&2; exit 128 ;;`,
    'esac',
    `exec "${real}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${ENV.PATH}` };
}

test('T35 GuidesHeal_CannotReadHead_NotApplied — no se pudo leer el árbol de HEAD: no avanza (no es «de acá no salen las skills»), y lo dice', { skip: NO_SH }, () => {
  const { up, clone } = unified();
  const home = homeWith(clone);
  const stateDir = path.join(BASE, `estado-${++n}`);
  const before = git(clone, ['rev-parse', 'HEAD']);
  const { heal, stampPath } = require('../lib/guides-heal.js');
  const msg = heal({ sessionId: 'sesion-t35d', stateDir, home, env: Object.assign({}, ENV, blindGit('HEAD'), { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.notStrictEqual(before, git(up, ['rev-parse', 'HEAD']), 'el laboratorio tiene que estar atrasado de verdad');
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before, 'sin poder leer el árbol de HEAD la sanadora avanzó a una punta sin skills');
  assert.ok(fs.existsSync(path.join(clone, 'skills', 'tycon-pipeline', 'SKILL.md')), 'las skills tienen que seguir');
  assert.match(String(msg), /no pude mirar/, String(msg));
  assert.match(String(msg), /HEAD/, String(msg));
  assert.match(String(msg), /unable to read tree \(laboratorio\)/, `el aviso trae lo que dijo git: ${msg}`);
  assert.doesNotMatch(String(msg), /no trae las skills/, String(msg));
  const sello = JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t35d'), 'utf8'));
  assert.strictEqual(sello.result, 'skills-unknown', JSON.stringify(sello));
  assert.strictEqual(sello.rev, 'HEAD', JSON.stringify(sello));
});

test('T35 GuidesHeal_CannotReadTip_NotApplied — no se pudo leer el árbol de lo publicado (que SÍ trae las skills): no avanza, y no dice «no las trae»', { skip: NO_SH }, () => {
  const { up, clone } = unified({ tip: 'with-skills' });
  const home = homeWith(clone);
  const stateDir = path.join(BASE, `estado-${++n}`);
  const before = git(clone, ['rev-parse', 'HEAD']);
  const { heal, stampPath } = require('../lib/guides-heal.js');
  const msg = heal({ sessionId: 'sesion-t35e', stateDir, home, env: Object.assign({}, ENV, blindGit('origin/main'), { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.notStrictEqual(before, git(up, ['rev-parse', 'HEAD']), 'el laboratorio tiene que estar atrasado de verdad');
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before, 'sin poder mirar lo publicado, no se avanza');
  assert.match(String(msg), /no pude mirar/, String(msg));
  assert.match(String(msg), /origin\/main/, String(msg));
  assert.doesNotMatch(String(msg), /no trae las skills/, String(msg));
  const sello = JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t35e'), 'utf8'));
  assert.strictEqual(sello.result, 'skills-unknown', JSON.stringify(sello));
  assert.strictEqual(sello.rev, 'origin/main', JSON.stringify(sello));
  // el comando que el aviso nombra para ver el error es el mismo que la guarda corre: con el git de verdad, contesta
  const cmd = /(git -C .* ls-tree .*skills\/tycon-pipeline)/.exec(String(msg));
  assert.ok(cmd, `el aviso nombra el comando para ver el error: ${msg}`);
  assert.strictEqual(execFileSync('bash', ['-c', cmd[1]], { encoding: 'utf8', env: ENV }).trim(), 'skills/tycon-pipeline', cmd[1]);
});

// …y «de esta copia salen las skills» se decide por QUÉ carpeta es, no por cómo está escrita su ruta:
// en un disco que no distingue mayúsculas, un enlace `~/.claude/agent-skills` escrito con
// otra caja que el del arnés es el MISMO clon. Letra por letra daría «son dos clones» y la guarda no correría.
test('T35 GuidesHeal_SameCloneOtherCase_GuardApplies — el enlace de las skills nombra el mismo clon con otras mayúsculas: la guarda corre igual', (t) => {
  const { up, clone } = unified();
  const other = path.join(path.dirname(path.dirname(clone)), path.basename(path.dirname(clone)).toUpperCase(), path.basename(clone));   // …/LAB-N/clon
  let same = false;
  try { same = other !== clone && fs.statSync(other).ino === fs.statSync(clone).ino; } catch { same = false; }
  if (!same) { t.skip('NO MEDIDO: este disco distingue mayúsculas (la misma carpeta en otra caja no existe)'); return; }
  const home = homeWith(other);
  const stateDir = path.join(BASE, `estado-${++n}`);
  const before = git(clone, ['rev-parse', 'HEAD']);
  const { heal, stampPath, skillsComeFrom } = require('../lib/guides-heal.js');
  assert.strictEqual(skillsComeFrom(clone, home), true, 'el enlace en otra caja nombra el mismo clon');
  assert.strictEqual(skillsComeFrom(clone, homeWith(null)), false, 'espejo: otra carpeta es otro clon');
  const msg = heal({ sessionId: 'sesion-t35f', stateDir, home, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.notStrictEqual(before, git(up, ['rev-parse', 'HEAD']), 'el laboratorio tiene que estar atrasado de verdad');
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before, 'la sanadora avanzó a una punta sin skills');
  assert.match(String(msg), /la versión nueva no trae las skills: no se aplica/, String(msg));
  assert.strictEqual(JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t35f'), 'utf8')).result, 'no-skills');
});

// …y «no pude mirar de dónde salen las skills» tampoco es «de acá no salen».
// `skillsComeFrom` con dos respuestas, si `~/.claude/agent-skills` no se dejara
// resolver (un enlace a una carpeta sin permisos, un disco que no responde), daría «son dos clones» y la sanadora avanzaría
// a una punta sin skills. Por eso son tres respuestas: sí · no · no pude mirar; con «no pude mirar» no avanza y lo dice.
test('T35 GuidesHeal_CannotTellWhereSkillsComeFrom_NotApplied — no se pudo resolver de dónde salen las skills: no avanza, y lo dice', { skip: process.platform === 'win32' ? 'los permisos de carpeta de este laboratorio son de POSIX' : false }, (t) => {
  const { up, clone } = unified();
  const locked = path.join(BASE, `locked-${++n}`);
  fs.mkdirSync(locked, { recursive: true });
  fs.symlinkSync(clone, path.join(locked, 'agent-skills'));
  const home = homeWith(path.join(locked, 'agent-skills'));   // ~/.claude/agent-skills → <sin permisos>/agent-skills → el clon
  fs.chmodSync(locked, 0o000);
  let blind;
  try { fs.realpathSync(path.join(home, '.claude', 'agent-skills')); blind = false; } catch { blind = true; }
  if (!blind) { fs.chmodSync(locked, 0o755); t.skip('NO MEDIDO: la carpeta sin permisos se deja resolver igual (¿corre como root?)'); return; }
  const stateDir = path.join(BASE, `estado-${++n}`);
  const before = git(clone, ['rev-parse', 'HEAD']);
  const { heal, stampPath, skillsComeFrom } = require('../lib/guides-heal.js');
  let msg; let from;
  try {
    from = skillsComeFrom(clone, home);
    msg = heal({ sessionId: 'sesion-t35g', stateDir, home, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  } finally { fs.chmodSync(locked, 0o755); }
  assert.strictEqual(from, null, 'no se pudo mirar: ni «sí» ni «no»');
  assert.notStrictEqual(before, git(up, ['rev-parse', 'HEAD']), 'el laboratorio tiene que estar atrasado de verdad');
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before, 'sin saber de dónde salen las skills la sanadora avanzó a una punta sin skills');
  assert.ok(fs.existsSync(path.join(clone, 'skills', 'tycon-pipeline', 'SKILL.md')), 'las skills tienen que seguir');
  assert.match(String(msg), /no pude mirar si de esta copia salen las skills/, String(msg));
  assert.match(String(msg), /EACCES/, `el aviso trae la causa: ${msg}`);
  const sello = JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t35g'), 'utf8'));
  assert.strictEqual(sello.result, 'skills-unknown', JSON.stringify(sello));
  // espejo: con la carpeta legible otra vez, el enlace nombra este clon: la guarda de siempre («no trae las skills»)
  assert.strictEqual(skillsComeFrom(clone, home), true, 'legible, el enlace nombra este clon');
  const again = heal({ sessionId: 'sesion-t35h', stateDir, home, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.match(String(again), /la versión nueva no trae las skills: no se aplica/, String(again));
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before);
});

test('T10 GuidesHeal_BrokenStateIsNotAbsent —un estado ilegible no es «sin estado»: se hace a un lado igual y lo registra', () => {
  const { clone } = behind();
  const stateDir = path.join(BASE, `estado-${++n}`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'harness-state.json'), '{ roto');
  const before = git(clone, ['rev-parse', 'HEAD']);
  const { heal, stampPath } = require('../lib/guides-heal.js');
  heal({ sessionId: 'sesion-t10c', stateDir, env: Object.assign({}, ENV, { TYCON_GUIDES_HEAL_REPO: clone, TYCON_NO_AUTOINSTALL: '1' }) });
  assert.strictEqual(git(clone, ['rev-parse', 'HEAD']), before, 'con un estado roto tampoco se toca git (8.3 AC 2: roto no es «no instalado»)');
  const sello = JSON.parse(fs.readFileSync(stampPath(stateDir, 'sesion-t10c'), 'utf8'));
  assert.strictEqual(sello.result, 'delegated', JSON.stringify(sello));
  assert.strictEqual(sello.state, 'broken', JSON.stringify(sello));
});
