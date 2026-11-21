'use strict';
/**
 * approver.test.js — quién aprueba una firma depende del repo, no de la máquina.
 *
 * En los repos del arnés las firmas son del dueño; en cualquier otro repo, aunque sea la máquina del dueño, las aprueba
 * el dev, y la ventana dice «Lo aprobás vos». Lo decide scripts/lib/approver.js con el remoto del repo
 * (scripts/lib/harness-repo.js), nunca con la carpeta ni con la máquina.
 *
 *   T1 · un repo cuyo remoto es el del arnés: el dueño.
 *   T2 · un repo de producto, con otro remoto: vos.
 *   T3 · una carpeta fuera de todo repo: vos.
 *   T4 · si no se puede juzgar el repo: vos (el texto, no un permiso: la firma la pide el freno igual).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { approverOf } = require(path.resolve(__dirname, '..', 'lib', 'approver.js'));

const ARNES = 'https://github.com/acme/harness';
const opts = { identidades: [ARNES] };

function repo(t, remoto) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  if (remoto) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remoto]);
  fs.mkdirSync(path.join(dir, 'sub'));
  return dir;
}

// aprobador T1 Approver_RepoDelArnes_ElDueno
// 🔴 Falla con: el repo del arnés leído como de producto, o una subcarpeta que no hereda el repo.
test('aprobador T1 Approver_RepoDelArnes_ElDueno', (t) => {
  const dir = repo(t, `${ARNES}.git`);
  for (const d of [dir, path.join(dir, 'sub')]) {
    const a = approverOf(d, opts);
    assert.strictEqual(a.maintainers, true, d);
    assert.strictEqual(a.label, 'Firma del dueño');
    assert.strictEqual(a.terminal, 'la terminal del dueño');
  }
});

// aprobador T2 Approver_RepoDeProducto_Vos
// 🔴 Falla con: un repo de producto que muestra «el dueño», aunque la máquina sea la del dueño.
test('aprobador T2 Approver_RepoDeProducto_Vos', (t) => {
  const a = approverOf(path.join(repo(t, 'https://dev.azure.com/acme/Producto/_git/backend'), 'sub'), opts);
  assert.strictEqual(a.maintainers, false);
  assert.strictEqual(a.label, 'Lo aprobás vos');
  assert.strictEqual(a.terminal, 'tu terminal');
});

// aprobador T3 Approver_FueraDeUnRepo_Vos
// 🔴 Falla con: una carpeta suelta leída como del arnés.
test('aprobador T3 Approver_FueraDeUnRepo_Vos', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approver-suelta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(approverOf(dir, opts).maintainers, false);
});

// aprobador T4 Approver_NoSePuedeJuzgar_Vos
// 🔴 Falla con: un error al leer el repo que tira abajo el freno, o que dice «el dueño» sin saberlo.
test('aprobador T4 Approver_NoSePuedeJuzgar_Vos', () => {
  const a = approverOf('/no/existe', { judge: () => { throw new Error('roto'); } });
  assert.strictEqual(a.maintainers, false);
  assert.strictEqual(a.label, 'Lo aprobás vos');
});

// Los guiones del pipeline cuyos mensajes lee el agente. «El dueño» ahí dice quién firma sólo en los repos del arnés;
// en los demás confunde, y «vos» lo leería el agente como propio. Dicen «una persona».
const GUIONES = path.resolve(__dirname, '..', '..', 'skills', 'tycon-pipeline', 'scripts');
// lo que nombra al dueño y no es un mensaje: el campo `quien` de la constancia del salteo (es del registro) y el dueño de
// un candado, que es el proceso que lo tiene
const NO_ES_MENSAJE = [/quien: 'dueño'/, /quien !== 'dueño'/, /no tiene dueño escrito/];

/** Los textos entre comillas de un renglón de código (sin los comentarios de renglón entero). */
function textos(renglon) {
  if (/^\s*(\/\/|\*|\/\*)/.test(renglon)) return [];
  return [...renglon.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`?/g)].map((m) => m[0]);
}

// aprobador T7 Mensajes_AlAgente_SinElDueno
// 🔴 Falla con: un mensaje de los guiones del pipeline que todavía dice que algo lo firma «el dueño».
test('aprobador T7 Mensajes_AlAgente_SinElDueno', () => {
  const malos = [];
  for (const dir of [GUIONES, path.join(GUIONES, 'lib')]) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((r, i) => {
        if (NO_ES_MENSAJE.some((re) => re.test(r))) return;
        if (textos(r).some((t) => /dueño/.test(t))) malos.push(`${path.relative(GUIONES, path.join(dir, f))}:${i + 1}`);
      });
    }
  }
  // el freno de seguridad: sus carteles también los lee el agente
  const freno = path.resolve(__dirname, '..', 'hooks', 'safety-guard-pre.sh');
  fs.readFileSync(freno, 'utf8').split('\n').forEach((r, i) => {
    if (!/^\s*#/.test(r) && /"[^"]*dueño[^"]*"/.test(r)) malos.push(`safety-guard-pre.sh:${i + 1}`);
  });
  assert.deepStrictEqual(malos, [], 'mensajes que nombran al dueño');
});

// aprobador T8 Mensajes_LaCoordinadoraTampoco
// 🔴 Falla con: el ok de guardar que la coordinadora no puede dar, con un mensaje que ya no dice que ella tampoco firma.
test('aprobador T8 Mensajes_LaCoordinadoraTampoco', () => {
  const t = fs.readFileSync(path.join(GUIONES, 'lib', 'save-ok.js'), 'utf8');
  assert.match(t, /Lo firma una persona: ni el agente ni la coordinadora/);
});
