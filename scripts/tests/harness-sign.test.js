'use strict';
/**
 * harness-sign.test.js — `harness sign <firma>` y la salida de emergencia (esquema de frenos, etapa D).
 *
 * Todo en proceso: la terminal, el registro común, los niveles del perfil, la casa y la hora se pasan como parámetros.
 *
 *   T1 · un id que no está en el catálogo se rechaza, sin registro ni permiso.
 *   T2 · la firma se da en la terminal de la persona: sin terminal no firma nada.
 *   T3 · sin «firmo», no firma.
 *   T4 · la rutina firmada queda en el registro, por la vía `command`, con quién, quién la pidió, sobre qué y el motivo.
 *   T5 · una excepción (nivel 2) pide motivo; y la organización puede subir el nivel, nunca bajarlo.
 *   T6 · si el registro no escribe, el comando lo dice y sale con error; la emergencia no queda vigente.
 *   T7 · la emergencia pide motivo y el comando exacto; deja un permiso de un solo uso.
 *   T8 · un comando distinto no consume el permiso, y el permiso sigue vigente para el suyo.
 *   T9 · vencido (más de 30 minutos), no sirve.
 *   T10 · la emergencia de `git commit` la consume el próximo commit de ese repo, y no el de otro repo.
 *   T11 · la emergencia nunca va por la ventana ni por la delegación: la firma sólo la terminal.
 *   T12 · por la consola: un id desconocido sale 2 y la ayuda de harness.js nombra `sign`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sign = require('../lib/harness-sign.js');

const RAIZ = path.join(__dirname, '..', '..');
const HARNESS = path.join(RAIZ, 'scripts', 'setup', 'harness.js');
const AHORA = Date.parse('2026-10-30T09:00:00Z');
const MIN = 60000;

function casaNueva(t) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sign-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  return casa;
}

// la terminal de la persona: contesta lo que se le diga; `hay: false` es la consola del agente
function terminal(respuesta = 'firmo', { hay = true } = {}) {
  const preguntas = [];
  return { preguntas, hay: () => hay, preguntar: (m) => { preguntas.push(m); return respuesta; } };
}

// el registro común: guarda los renglones; `falla` lo hace devolver ok:false como appendSignature
function registro({ falla = null } = {}) {
  const renglones = [];
  const append = (r) => {
    if (falla) return { ok: false, error: falla };
    renglones.push(r);
    return { ok: true, path: '/registro/signatures.jsonl' };
  };
  return { renglones, append };
}

function firmar(casa, extra = {}) {
  return sign.sign({ casa, ahora: AHORA, signer: 'el-dev', cwd: casa, tty: terminal(), levels: {}, ...extra });
}

test('T1 · un id que no está en el catálogo se rechaza, sin registro ni permiso', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  const r = firmar(casa, { id: 'no-existe', reason: 'x', append: reg.append });
  assert.strictEqual(r.code, 2);
  assert.match(r.lines.join('\n'), /no-existe/);
  assert.strictEqual(reg.renglones.length, 0);
  assert.deepStrictEqual(sign.permisos(casa), []);
});

test('T2 · sin terminal no firma nada', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  const r = firmar(casa, { id: 'plan-approval', append: reg.append, tty: terminal('firmo', { hay: false }) });
  assert.strictEqual(r.code, 2);
  assert.match(r.lines.join('\n'), /terminal/);
  assert.strictEqual(reg.renglones.length, 0);
});

test('T3 · sin «firmo», no firma', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  const r = firmar(casa, { id: 'plan-approval', append: reg.append, tty: terminal('no') });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(reg.renglones.length, 0);
});

test('T4 · la rutina firmada queda en el registro con quién, quién la pidió, sobre qué y el motivo', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  const tty = terminal();
  const r = firmar(casa, { id: 'plan-approval', append: reg.append, tty, orderedBy: 'coordinadora', target: 'ses-a', reason: 'plan revisado' });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  assert.strictEqual(reg.renglones.length, 1);
  assert.deepStrictEqual(
    { ...reg.renglones[0], home: undefined },
    { signature: 'plan-approval', via: 'command', signer: 'el-dev', orderedBy: 'coordinadora', target: 'ses-a', reason: 'plan revisado', source: 'harness sign', home: undefined },
  );
  // la terminal dice qué se firma y su nivel antes de pedir «firmo»
  assert.match(tty.preguntas[0], /aprobar el plan/);
  assert.match(tty.preguntas[0], /nivel 1/);
});

test('T5 · una excepción pide motivo; la organización sube el nivel y nunca lo baja', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  // nivel 2 en el catálogo: sin motivo no firma
  let r = firmar(casa, { id: 'critical-waiver', append: reg.append });
  assert.strictEqual(r.code, 2);
  assert.match(r.lines.join('\n'), /motivo/);
  // la rutina, subida a 2 por el perfil: pide motivo
  r = firmar(casa, { id: 'plan-approval', append: reg.append, levels: { 'plan-approval': 2 } });
  assert.strictEqual(r.code, 2);
  assert.match(r.lines.join('\n'), /nivel 2/);
  // una excepción que el perfil quisiera bajar a 1 sigue en 2: pide motivo igual
  r = firmar(casa, { id: 'critical-waiver', append: reg.append, levels: { 'critical-waiver': 1 } });
  assert.strictEqual(r.code, 2);
  assert.strictEqual(sign.nivelEfectivo('critical-waiver', { 'critical-waiver': 1 }), 2);
  assert.strictEqual(sign.nivelEfectivo('plan-approval', { 'plan-approval': 3 }), 3);
  assert.strictEqual(reg.renglones.length, 0);
  // sin poder leer el perfil no se sabe qué subió la organización: se pide motivo también para la rutina
  r = firmar(casa, { id: 'plan-approval', append: reg.append, levels: null });
  assert.strictEqual(r.code, 2);
  assert.match(r.lines.join('\n'), /perfil/);
});

test('T6 · si el registro no escribe, el comando lo dice y sale con error; la emergencia no queda vigente', (t) => {
  const casa = casaNueva(t);
  const reg = registro({ falla: 'EACCES' });
  let r = firmar(casa, { id: 'plan-approval', append: reg.append });
  assert.strictEqual(r.code, 1);
  assert.match(r.lines.join('\n'), /EACCES/);
  r = firmar(casa, { id: 'emergency', reason: 'borrar la carpeta de pruebas colgada', command: 'rm -rf /tmp/x', append: reg.append });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(sign.permisos(casa), []);
  assert.strictEqual(sign.consumir({ casa, comando: 'rm -rf /tmp/x', ahora: AHORA }), null);
});

test('T7 · la emergencia pide motivo y el comando exacto; deja un permiso de un solo uso', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  let r = firmar(casa, { id: 'emergency', command: 'rm -rf /tmp/x', append: reg.append });
  assert.strictEqual(r.code, 2, 'sin motivo');
  r = firmar(casa, { id: 'emergency', reason: '   ', command: 'rm -rf /tmp/x', append: reg.append });
  assert.strictEqual(r.code, 2, 'un motivo en blanco no es motivo');
  r = firmar(casa, { id: 'emergency', reason: 'borrar la carpeta de pruebas colgada', append: reg.append });
  assert.strictEqual(r.code, 2, 'sin el comando');
  assert.match(r.lines.join('\n'), /--/);
  assert.strictEqual(reg.renglones.length, 0);

  r = firmar(casa, { id: 'emergency', reason: 'borrar la carpeta de pruebas colgada', command: 'rm -rf /tmp/x', append: reg.append });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  assert.deepStrictEqual([reg.renglones[0].signature, reg.renglones[0].via, reg.renglones[0].target, reg.renglones[0].reason],
    ['emergency', 'command', 'rm -rf /tmp/x', 'borrar la carpeta de pruebas colgada']);
  const usado = sign.consumir({ casa, comando: 'rm -rf /tmp/x', ahora: AHORA + MIN });
  assert.ok(usado && usado.ok, 'el comando exacto lo consume');
  assert.strictEqual(usado.permiso.motivo, 'borrar la carpeta de pruebas colgada');
  assert.strictEqual(sign.consumir({ casa, comando: 'rm -rf /tmp/x', ahora: AHORA + 2 * MIN }), null, 'una sola vez');
});

test('T8 · un comando distinto no consume el permiso, y el permiso sigue vigente para el suyo', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  assert.strictEqual(firmar(casa, { id: 'emergency', reason: 'borrar la carpeta colgada', command: 'rm -rf /tmp/x', append: reg.append }).code, 0);
  for (const otro of ['rm -rf /tmp/y', 'rm -rf /tmp/x ', ' rm -rf /tmp/x', 'rm -rf /tmp/x; rm -rf ~', 'RM -rf /tmp/x']) {
    assert.strictEqual(sign.consumir({ casa, comando: otro, ahora: AHORA + MIN }), null, `«${otro}» no es el comando firmado`);
  }
  assert.strictEqual(sign.consumirCommit({ casa, repo: casa, ahora: AHORA + MIN }), null, 'no es un commit');
  assert.ok(sign.consumir({ casa, comando: 'rm -rf /tmp/x', ahora: AHORA + MIN }).ok);
});

test('T9 · vencido, no sirve', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  assert.strictEqual(firmar(casa, { id: 'emergency', reason: 'borrar la carpeta colgada', command: 'rm -rf /tmp/x', append: reg.append }).code, 0);
  const r = sign.consumir({ casa, comando: 'rm -rf /tmp/x', ahora: AHORA + 31 * MIN });
  assert.ok(r && r.ok === false, 'vencido no vale');
  assert.match(r.motivo, /venci/);
  assert.strictEqual(sign.consumir({ casa, comando: 'rm -rf /tmp/x', ahora: AHORA + 2 * MIN }), null, 'y no queda para después');
});

test('T10 · la emergencia de git commit la consume el próximo commit de ese repo, no el de otro', (t) => {
  const casa = casaNueva(t);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sign-repo-'));
  const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sign-otro-'));
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(otro, { recursive: true, force: true }); });
  const reg = registro();
  const r = firmar(casa, { id: 'emergency', reason: 'el catálogo de producción tiene un servidor de baja', command: 'git commit -m "x"', cwd: repo, append: reg.append });
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  assert.strictEqual(sign.consumirCommit({ casa, repo: otro, ahora: AHORA + MIN }), null, 'otro repo no');
  assert.ok(sign.consumirCommit({ casa, repo, ahora: AHORA + MIN }).ok, 'ese repo sí');
  assert.strictEqual(sign.consumirCommit({ casa, repo, ahora: AHORA + 2 * MIN }), null, 'una sola vez');
  // vencido tampoco
  assert.strictEqual(firmar(casa, { id: 'emergency', reason: 'el catálogo de producción tiene un servidor de baja', command: 'git commit -m "y"', cwd: repo, append: reg.append }).code, 0);
  assert.strictEqual(sign.consumirCommit({ casa, repo, ahora: AHORA + 31 * MIN }).ok, false);
});

test('T11 · la emergencia la firma sólo la terminal, nunca la ventana ni la delegación', (t) => {
  const casa = casaNueva(t);
  const reg = registro();
  for (const via of ['window', 'delegation']) {
    const r = firmar(casa, { id: 'emergency', reason: 'borrar la carpeta colgada', command: 'rm -rf /tmp/x', append: reg.append, via });
    assert.strictEqual(r.code, 2, via);
    assert.match(r.lines.join('\n'), /terminal/);
  }
  assert.strictEqual(reg.renglones.length, 0);
  assert.deepStrictEqual(sign.permisos(casa), []);
});

// El freno real lee los permisos de la casa de la cuenta (real-home.js: HOME no la cambia), así que la prueba firma ahí,
// con un comando que no existe en ninguna otra parte, y borra lo suyo al terminar.
test('T13 · el freno de seguridad deja pasar el comando firmado, tal cual y una sola vez', (t) => {
  const HOOK = path.join(RAIZ, 'scripts', 'hooks', 'safety-guard-pre.sh');
  const marca = `${process.pid}-${Date.now()}`;
  // stable-data: es el texto que se le pasa al freno, que nunca lo corre
  const firmado = `sqlcmd -Q "DROP DATABASE prueba_${marca.replace(/-/g, '_')}"`;
  const reg = registro();
  t.after(() => {
    const dir = sign.carpeta();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.readFileSync(p, 'utf8').includes(marca.replace(/-/g, '_'))) fs.rmSync(p); } catch (_) { /* ya no está */ }
    }
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sign-freno-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const freno = (comando) => spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 's-sign', tool_name: 'Bash', tool_input: { command: comando }, cwd: home }),
    env: { ...process.env, HOME: home, TYCON_SAFETY_OFF: '' }, encoding: 'utf8',
  });
  // sin la emergencia, frena y el cartel dice cómo se firma
  let r = freno(firmado);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /harness\.js sign emergency --reason/);
  assert.strictEqual(sign.sign({ id: 'emergency', reason: 'limpiar la carpeta de la prueba', command: firmado, tty: terminal(), append: reg.append, signer: 'prueba', levels: {} }).code, 0);
  // otro texto no la consume
  r = freno(`${firmado} `);
  assert.strictEqual(r.status, 2, 'un espacio de más no es el comando firmado');
  r = freno(firmado);
  assert.strictEqual(r.status, 0, r.stderr);
  r = freno(firmado);
  assert.strictEqual(r.status, 2, 'una sola vez');
});

// El permiso es un archivo: si el agente lo pudiera escribir, se daría la emergencia solo. Vive en la carpeta de estado,
// que los frenos de escritura cuidan entera, igual que los registros de la ventana de permiso.
// 🔴 rojo: mudar el permiso a una carpeta fuera del estado (o sacar el estado de la regla) deja escribirlo.
test('T14 · los frenos de escritura cuidan el permiso igual que los registros de la ventana', () => {
  const SCRIPTS = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
  const gate = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
  const estado = path.dirname(sign.carpeta());
  const ventana = path.join(estado, 'owner-window', 'x.json');
  const permiso = path.join(sign.carpeta(), 'x.json');
  for (const archivo of [ventana, permiso]) {
    // Edit y Write
    const r = gate.computeStoryGate({ filePath: archivo, stateDir: estado, homeDir: os.homedir(), repoRoot: null });
    assert.deepStrictEqual([r.action, r.kind], ['block', 'state-dir'], archivo);
    // la consola: redirección, copia y un intérprete
    for (const comando of [`echo x > ${archivo}`, `cp /tmp/x ${archivo}`, `node -e "require('fs').writeFileSync('${archivo}','x')"`]) {
      const ev = JSON.stringify({ session_id: 's-sign', tool_name: 'Bash', tool_input: { command: comando }, cwd: os.tmpdir() });
      const c = spawnSync(process.execPath, [path.join(SCRIPTS, 'on-bash-write-gate.js')], { input: ev, encoding: 'utf8' });
      assert.strictEqual(c.status, 2, `${comando}: ${c.stdout}${c.stderr}`);
      assert.match(c.stdout + c.stderr, /ESCRITURA DIRECTA AL ESTADO/, comando);
    }
  }
});

test('T12 · por la consola: un id desconocido sale 2 y la ayuda nombra sign', () => {
  const r = spawnSync(process.execPath, [HARNESS, 'sign', 'no-existe', '--reason', 'x'], { encoding: 'utf8', env: { ...process.env, HOME: os.tmpdir() } });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no-existe/);
  const h = spawnSync(process.execPath, [HARNESS, '--help'], { encoding: 'utf8' });
  assert.match(h.stdout, /\bsign\b/);
  // lo que sigue a `--` es el comando, un solo argumento entre comillas, aunque empiece con guiones: partido en
  // palabras se pierden las comillas de adentro y nunca sería el texto exacto que corre el agente
  const { parse } = require(HARNESS);
  const p = parse(['sign', 'emergency', '--reason', 'motivo', '--', 'git commit -m "x"']);
  assert.deepStrictEqual([p.cmd, p.args, p.opts.reason, p.opts.command], ['sign', ['emergency'], 'motivo', 'git commit -m "x"']);
  const partido = parse(['sign', 'emergency', '--reason', 'motivo', '--', 'git', 'commit', '-m', 'x']);
  assert.match(partido.error, /comillas/);
});
