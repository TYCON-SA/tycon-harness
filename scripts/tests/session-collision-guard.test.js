'use strict';
// stable-data: los repos de juguete sólo se inicializan (git init), nunca se commitea en ellos; las horas son las de las transcripciones recién escritas.
// session-collision-guard.test.js — which live sessions count as "on this same checkout". A session's transcript folder
// is named after its cwd, so a sibling checkout whose name starts like this one (`…/harness-maintainers--wt-X` next to
// `…/harness-maintainers`) shares the folder-name prefix. What decides is the cwd the transcript recorded; a transcript
// without a readable cwd still counts by its folder. Each case runs the real hook with a toy HOME and toy git repos.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'session-collision-guard.js');

function toy() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scg-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return { root, home };
}
function repo(t, name) {
  const d = path.join(t.root, name);
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', d]);
  return d;
}
// A transcript as Claude Code writes it: in the folder named after `folderOf`, with `cwd` in its first line (or none).
function transcript(t, folderOf, id, cwd) {
  const dir = path.join(t.home, '.claude', 'projects', folderOf.replace(/[/\\:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const first = { type: 'user', ...(cwd ? { cwd } : {}), message: { role: 'user', content: `pedido de ${id}` } };
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify(first)}\n`);
}
function run(t, event, cwd, extra = {}) {
  const env = { ...process.env, HOME: t.home, USERPROFILE: t.home };
  for (const k of ['TYCON_SESSION_GUARD', 'TYCON_SESSION_GUARD_MIN', 'TYCON_HOME']) delete env[k];
  const payload = event === 'SessionStart'
    ? { hook_event_name: 'SessionStart', cwd, session_id: 'la-mia' }
    : { hook_event_name: 'PreToolUse', cwd, session_id: 'la-mia', tool_name: 'Bash', tool_input: { command: 'git commit -m algo' }, ...extra };
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), cwd, env, encoding: 'utf8', timeout: 20000 });
}

test('T5 Choque_PuestoConPrefijoComun_NoEsElMismoCheckout @story-8.274 @ac-7 @ac-9: la sesión de un puesto no frena al checkout; una sin cwd legible cuenta por la carpeta', () => {
  // 🔴 mutación: volver a contar por el prefijo de la carpeta sin mirar el cwd (frena por la sesión del puesto), o
  // dejar de contar la transcripción sin cwd (la última parte deja de frenar)
  const t = toy();
  const checkout = repo(t, 'harness-maintainers');
  const puesto = repo(t, 'harness-maintainers--wt-X');
  transcript(t, puesto, 'aaaa1111-del-puesto', puesto);
  const freno = run(t, 'PreToolUse', checkout);
  assert.strictEqual(freno.status, 0, freno.stderr);
  const aviso = run(t, 'SessionStart', checkout);
  assert.strictEqual(aviso.status, 0, aviso.stderr);
  assert.doesNotMatch(aviso.stdout, /session-guard/, aviso.stdout);
  // el puesto, en su carpeta, sí ve a su propia sesión
  assert.strictEqual(run(t, 'PreToolUse', puesto).status, 2);
  // sin cwd legible no se sabe de dónde es: cuenta por la carpeta, como siempre
  transcript(t, puesto, 'bbbb2222-sin-cwd', null);
  const sinCwd = run(t, 'PreToolUse', checkout);
  assert.strictEqual(sinCwd.status, 2, sinCwd.stderr);
  assert.match(sinCwd.stderr, /bbbb2222/);
  assert.doesNotMatch(sinCwd.stderr, /aaaa1111/, 'la del puesto sigue sin contar');
});

test('T5b Choque_SesionQueSeMudoAUnPuesto_CuentaDondeEstaAhora @story-8.274 @ac-9: manda el último cwd de la transcripción, no el primero', () => {
  // 🔴 mutación: leer sólo el primer cwd (la sesión que arrancó en el checkout y se mudó al puesto deja de frenar ahí, y
  // sigue frenando en el checkout donde ya no trabaja). Caso del pase adversarial: así quedan las transcripciones de
  // las sesiones que entran a un worktree después de arrancar.
  const t = toy();
  const checkout = repo(t, 'harness-maintainers');
  const puesto = repo(t, 'harness-maintainers--wt-Z');
  const dir = path.join(t.home, '.claude', 'projects', puesto.replace(/[/\\:]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const linea = (cwd) => `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'seguimos' } })}\n`;
  fs.writeFileSync(path.join(dir, 'iiii9999-mudada.jsonl'), linea(checkout) + linea(checkout) + linea(puesto));
  const enElPuesto = run(t, 'PreToolUse', puesto);
  assert.strictEqual(enElPuesto.status, 2, enElPuesto.stderr);
  assert.match(enElPuesto.stderr, /iiii9999/);
  assert.strictEqual(run(t, 'PreToolUse', checkout).status, 0, 'en el checkout ya no trabaja');
});

test('T6 Choque_MismoCheckoutOSubcarpeta_SigueAvisando @story-8.274 @ac-8: otra sesión en el mismo checkout o en una subcarpeta frena y avisa', () => {
  // 🔴 mutación: comparar el cwd por igualdad sola (la subcarpeta deja de frenar)
  const t = toy();
  const checkout = repo(t, 'harness-maintainers');
  transcript(t, checkout, 'cccc3333-misma', checkout);
  const misma = run(t, 'PreToolUse', checkout);
  assert.strictEqual(misma.status, 2, misma.stderr);
  assert.match(misma.stderr, /OTRA sesi[oó]n viva[\s\S]*cccc3333/);
  assert.match(run(t, 'SessionStart', checkout).stdout, /ya hay 1 otra\(s\) sesión\(es\) viva\(s\) sobre este mismo checkout/);

  const t2 = toy();
  const c2 = repo(t2, 'harness-maintainers');
  const sub = path.join(c2, 'scripts');
  fs.mkdirSync(sub);
  transcript(t2, sub, 'dddd4444-subcarpeta', sub);
  const r = run(t2, 'PreToolUse', c2);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /dddd4444/);

  // Codex no ordena por carpeta: la de la propia transcripción mezcla repos y el cwd va en el `payload` del arranque.
  // 🔴 mutación: leer sólo el `cwd` de primer nivel (la de Codex deja de contar)
  const t3 = toy();
  const c3 = repo(t3, 'harness-maintainers');
  const otro = repo(t3, 'harness-maintainers--wt-Y');
  const mezcla = path.join(t3.root, 'codex-sessions');
  fs.mkdirSync(mezcla);
  const meta = (cwd) => `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n`;
  fs.writeFileSync(path.join(mezcla, 'la-mia.jsonl'), meta(c3));
  fs.writeFileSync(path.join(mezcla, 'ffff6666-codex-aca.jsonl'), meta(c3));
  fs.writeFileSync(path.join(mezcla, 'gggg7777-codex-puesto.jsonl'), meta(otro));
  const codex = run(t3, 'PreToolUse', c3, { transcript_path: path.join(mezcla, 'la-mia.jsonl') });
  assert.strictEqual(codex.status, 2, codex.stderr);
  assert.match(codex.stderr, /ffff6666/);
  assert.doesNotMatch(codex.stderr, /gggg7777/);
  // sin cwd legible no se sabe de dónde es: cuenta también en la carpeta que mezcla repos (callarla no avisaría nunca)
  // 🔴 mutación: descartar la transcripción sin cwd en la carpeta mezclada
  fs.writeFileSync(path.join(mezcla, 'hhhh8888-codex-sin-cwd.jsonl'), '{"type":"otra cosa"}\n');
  assert.match(run(t3, 'PreToolUse', c3, { transcript_path: path.join(mezcla, 'la-mia.jsonl') }).stderr, /hhhh8888/);
});

test('T7 Choque_ClaveQueEmpiezaIgual_NoCuenta @story-8.274 @ac-9: …/repo no ve a una sesión de …/repo-otro', () => {
  // 🔴 mutación: aceptar el cwd como prefijo sin el separador (`…/repo-otro` empieza con `…/repo`)
  const t = toy();
  const r1 = repo(t, 'repo');
  const otro = repo(t, 'repo-otro');
  transcript(t, otro, 'eeee5555-otro', otro);
  const r = run(t, 'PreToolUse', r1);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(run(t, 'PreToolUse', otro).status, 2, 'en su propio repo sí cuenta');
});
