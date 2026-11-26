'use strict';
/**
 * row-177-write-gate.test.js — el freno de escrituras no deja escribir una constancia por ninguno de los seis caminos
 * indirectos.
 *
 * Una constancia (una exención, un cambio de control, una exención en vivo, las aprobaciones de una ejecución) la anota el
 * arnés con la firma de una persona. El freno frena escribirla directo; estas pruebas cubren los caminos indirectos: un guion de shell que ya estaba en el disco, un comodín en el nombre, la copia de una carpeta, un enlace duro, el
 * `Move to` de un parche de Codex y una ruta armada. Y lo que no tiene que frenar. Repos de git y HOME temporales, sin red:
 * el freno de consola corre como proceso, como lo corre Claude Code, y el de Edit y Write por su borde (`evaluate`).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..');
const RAIZ = path.join(SCRIPTS, '..', '..', '..');
const GATE = path.join(SCRIPTS, 'on-bash-write-gate.js');
const sg = require(path.join(SCRIPTS, 'lib', 'story-gate.js'));
const io = require(path.join(SCRIPTS, 'lib', 'story-gate-io.js'));
const { editEventsFrom } = require(path.join(RAIZ, 'scripts', 'lib', 'hook-io.js'));
const SID = 's-fila-177';
const FILA = '{"story":"9.9","campo":"advisors_exempt"}';

/** Un repo con constancias commiteadas, una carpeta de afuera con un guion y una copia de `.tycon`, y una casa vacía. */
function lab(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fila177-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const fuera = path.join(dir, 'fuera');
  const estado = path.join(dir, 'estado');
  for (const d of [r, home, estado, path.join(fuera, 'src', '.tycon'), path.join(r, 'src'), path.join(r, 'build'),
    path.join(r, '.tycon'), path.join(r, '.advisors', 'pipeline-runs', 'r1'), path.join(r, 'sub', '.advisors', 'pipeline-runs', 'r2')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const escribir = (rel, txt) => fs.writeFileSync(path.join(r, rel), txt);
  escribir('README.md', 'x\n');
  escribir('src/a.js', '1\n');
  escribir('build/b.js', '1\n');
  escribir('.tycon/exemptions.jsonl', `${FILA}\n`);
  escribir('.tycon/runtime-waivers.jsonl', '{"story":"9.9"}\n');
  escribir('.advisors/pipeline-runs/r1/approvals.jsonl', '{"tipo":"automatica"}\n');
  escribir('sub/.advisors/pipeline-runs/r2/approvals.jsonl', '{"tipo":"automatica"}\n');
  fs.writeFileSync(path.join(fuera, 'src', '.tycon', 'exemptions.jsonl'), `${FILA}\n`);
  const fecha = '2026-11-26T00:00:00Z';
  const git = (...a) => execFileSync('git', ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0', ...a], { cwd: r, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: fecha, GIT_COMMITTER_DATE: fecha } });
  git('init', '-q', '-b', 'main', '.');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { dir, r, home, fuera, estado, git, escribir };
}

/** Un guion de shell fuera del repo que agrega una línea a `rel` (relativa a la carpeta donde corre). */
function guion(l, nombre, rel, { ejecutable = true, cabeza = '#!/bin/sh\n' } = {}) {
  const g = path.join(l.fuera, nombre);
  fs.writeFileSync(g, `${cabeza}echo '${FILA}' >> ${rel}\n`);
  if (ejecutable) fs.chmodSync(g, 0o755);
  return g;
}

/** El freno de consola sobre `command`, corrido en `cwd` (el repo). `{ status, stderr }`. */
function consola(l, command, cwd = l.r) {
  const env = { ...process.env, HOME: l.home, USERPROFILE: l.home };
  for (const k of Object.keys(env)) if (/^TYCON_|^CLAUDE_CODE_SESSION_ID$|^CODEX_/.test(k)) delete env[k];
  env.TYCON_GUIDES_DIR = RAIZ;
  const p = spawnSync(process.execPath, [GATE], { cwd, env, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: SID, cwd, tool_name: 'Bash', tool_input: { command } }) });
  return { status: p.status, stderr: p.stderr || '' };
}
const frena = (l, cmd, motivo = cmd) => { const p = consola(l, cmd); assert.strictEqual(p.status, 2, `${motivo}: debía frenar\n${p.stderr}`); return p; };
const pasa = (l, cmd, motivo = cmd) => { const p = consola(l, cmd); assert.strictEqual(p.status, 0, `${motivo}: debía pasar\n${p.stderr}`); return p; };

/** El freno de Edit y Write sobre `filePath`, por su borde, con el estado de la prueba. */
function edicion(l, filePath) {
  return io.evaluate({ filePath, sessionId: SID, cwd: l.r, via: 'Edit', stateDir: l.estado }).verdict;
}

test('T1 Freno_LasDosConstanciasNuevas', (t) => {
  const l = lab(t);
  const waivers = '.tycon/runtime-waivers.jsonl';
  const aprob = '.advisors/pipeline-runs/r1/approvals.jsonl';
  const aprobSub = 'sub/.advisors/pipeline-runs/r2/approvals.jsonl';
  // por consola: redirección, tee, cp, mv y sed -i
  for (const f of [waivers, aprob, aprobSub]) {
    const p = frena(l, `echo x >> ${f}`);
    assert.match(p.stderr, f === waivers ? /marker\.js runtime-waiver/ : /comandos de `marker\.js`/, 'el mensaje nombra quién lo escribe');
    frena(l, `echo x | tee -a ${f}`);
    frena(l, `cp README.md ${f}`);
    frena(l, `sed -i '' 's/a/b/' ${f}`);
  }
  // por Edit y Write
  for (const f of [waivers, aprob, aprobSub]) {
    const v = edicion(l, path.join(l.r, f));
    assert.strictEqual(v.action, 'block', `Edit sobre ${f}`);
    assert.strictEqual(v.kind, f === waivers ? 'runtime-waivers' : 'run-approvals');
  }
  // leerlos pasa
  for (const f of [waivers, aprob]) pasa(l, `cat ${f}`);
  // git: traer `runtime-waivers.jsonl` de otra rama frena, como `.tycon/exemptions.jsonl`
  l.git('checkout', '-q', '-b', 'otra');
  l.escribir(waivers, '{"story":"9.9"}\n{"story":"1.1"}\n');
  l.git('commit', '-q', '-am', 'otra');
  l.git('checkout', '-q', 'main');
  frena(l, 'git merge otra', 'traer una rama que cambia runtime-waivers.jsonl');
  frena(l, 'git reset --hard otra', 'resetear a una rama que cambia runtime-waivers.jsonl');
  frena(l, 'git cherry-pick otra', 'elegir un commit que cambia runtime-waivers.jsonl');
  // cambiar de rama sin cambios propios pasa, como con `.tycon/exemptions.jsonl`; con la constancia sin commitear, frena
  pasa(l, 'git checkout otra', 'cambiar de rama sin cambios propios');
  l.escribir(waivers, '{"story":"9.9"}\n{"story":"2.2"}\n');
  frena(l, 'git checkout otra', 'cambiar de rama con runtime-waivers.jsonl sin commitear');
  l.git('checkout', '--', waivers);
  // el comando instalado que la escribe no nombra el archivo: pasa
  pasa(l, `node "${path.join(SCRIPTS, 'marker.js')}" runtime-waiver --help`);
});

test('T2 Camino1_GuionDeShell_Frena', (t) => {
  const l = lab(t);
  for (const rel of ['.tycon/exemptions.jsonl', '.advisors/pipeline-runs/r1/adversarial-skips.jsonl', '.tycon/control-changes.jsonl']) {
    const g = guion(l, `g-${path.basename(rel, '.jsonl')}.sh`, rel);
    const antes = fs.existsSync(path.join(l.r, rel)) ? fs.readFileSync(path.join(l.r, rel), 'utf8') : null;
    for (const cmd of [`sh ${g}`, `bash ${g}`, `zsh ${g}`, `dash ${g}`, `ksh ${g}`, `. ${g}`, `source ${g}`, `env bash ${g}`,
      `time bash ${g}`, `nice -n 5 sh ${g}`, `echo | xargs sh ${g}`, `sh < ${g}`, `bash -s < ${g}`]) {
      const p = frena(l, cmd, `${cmd} (${rel})`);
      assert.match(p.stderr, /no se escribe a mano|no se toca a mano/, `${cmd}: el mensaje de la constancia`);
    }
    assert.strictEqual(fs.existsSync(path.join(l.r, rel)) ? fs.readFileSync(path.join(l.r, rel), 'utf8') : null, antes, 'el archivo no cambió');
  }
  // como programa: con `#!` de un shell, y uno que termina en .sh aunque no tenga `#!`
  const prog = guion(l, 'prog', '.tycon/exemptions.jsonl', { cabeza: '#!/usr/bin/env bash\n' });
  frena(l, prog, 'programa con #! de bash');
  const sinCabeza = guion(l, 'sin-cabeza.sh', '.tycon/exemptions.jsonl', { cabeza: '' });
  frena(l, sinCabeza, 'programa .sh sin #!');
  frena(l, `cd ${l.fuera} && cd ${l.r} && ./../fuera/sin-cabeza.sh`, 'programa con ruta relativa');
  // un guion que corre otro guion
  const adentro = path.join(l.fuera, 'llama.sh');
  fs.writeFileSync(adentro, `#!/bin/sh\nsh ${path.join(l.fuera, 'g-exemptions.sh')}\n`);
  frena(l, `sh ${adentro}`, 'un guion que corre otro');
  // uno que no se lee entero y nombra la constancia
  const grande = path.join(l.fuera, 'grande.sh');
  fs.writeFileSync(grande, `#!/bin/sh\n${'# relleno\n'.repeat(30000)}echo x >> .tycon/exemptions.jsonl\n`);
  frena(l, `sh ${grande}`, 'guion grande que nombra la constancia');
});

test('T3 Camino2_ComodinEnElNombre_Frena', (t) => {
  const l = lab(t);
  frena(l, `echo '${FILA}' >> .tycon/exempt*.jsonl`);
  frena(l, `echo '${FILA}' >> .tycon/exemptions.json[l]`);
  frena(l, `cd .tycon; echo '${FILA}' >> exemptions*`);
  frena(l, `echo x | tee -a .github/control-changes/*.json`);
  frena(l, 'echo x >> .advisors/pipeline-runs/r1/appro*.jsonl', 'el registro de una ejecución');
  frena(l, 'echo x >> .tycon/runtime-w?ivers.jsonl', 'una exención en vivo');
  // un comodín que no la alcanza pasa
  pasa(l, 'echo x >> .tycon/notas-*.txt');
});

test('T4 Camino3_CopiaDeCarpeta_Frena', (t) => {
  const l = lab(t);
  frena(l, `cp -R ${l.fuera}/src/.tycon .`);
  frena(l, `rsync -a ${l.fuera}/src/ .`);
  frena(l, `mv ${l.fuera}/src/.tycon .`);
  frena(l, 'cp -R $X .tycon', 'un origen que no se lee hacia una carpeta de constancias');
  frena(l, 'cp -R "$X/." .advisors/pipeline-runs/r1', 'hacia la carpeta de una ejecución');
  // un origen de otra máquina no se ve: frena hacia cualquier carpeta del repo
  frena(l, 'scp -r host:carpeta/. .', 'una copia remota a la raíz del repo');
  frena(l, 'rsync -a host:carpeta/ src/', 'una copia remota a otra carpeta del repo');
});

test('T5 Camino4_EnlaceDuro_Frena', (t) => {
  const l = lab(t);
  frena(l, 'ln .tycon/exemptions.jsonl h.jsonl');
  frena(l, 'link .tycon/exemptions.jsonl h.jsonl');
  frena(l, 'cp -l .tycon/exemptions.jsonl h.jsonl');
  frena(l, 'cp --link .tycon/runtime-waivers.jsonl h.jsonl');
  // un enlace hecho antes: escribir en él es escribir la constancia
  const h = path.join(l.r, 'h.jsonl');
  fs.linkSync(path.join(l.r, '.tycon', 'exemptions.jsonl'), h);
  frena(l, 'echo x >> h.jsonl', 'escribir en el enlace');
  frena(l, `echo x >> ${h}`, 'escribir en el enlace por su ruta entera');
  const v = edicion(l, h);
  assert.strictEqual(v.action, 'block', 'Edit y Write sobre el enlace');
  assert.strictEqual(v.kind, 'exemptions');
  // un enlace simbólico hacia una carpeta cualquiera pasa
  pasa(l, 'ln -s src enlace-a-src');
});

test('T6 Camino5_CodexMoveTo_Frena', (t) => {
  const l = lab(t);
  fs.writeFileSync(path.join(l.r, 'notas.txt'), 'a\n');
  const parche = (destino) => ({ hook_event_name: 'PreToolUse', session_id: SID, cwd: l.r, tool_name: 'apply_patch',
    tool_input: { command: `*** Begin Patch\n*** Update File: notas.txt\n*** Move to: ${destino}\n@@\n-a\n+b\n*** End Patch\n` } });
  const eventos = editEventsFrom(parche('.tycon/exemptions.jsonl'));
  assert.deepStrictEqual(eventos.map((e) => e.tool_input.file_path), [path.join(l.r, 'notas.txt'), path.join(l.r, '.tycon', 'exemptions.jsonl')]);
  assert.strictEqual(eventos[1].tool_input.move_from, path.join(l.r, 'notas.txt'));
  const veredictos = eventos.map((e) => io.evaluate({ filePath: e.tool_input.file_path, sessionId: SID, cwd: l.r, via: 'apply_patch', stateDir: l.estado }).verdict);
  assert.strictEqual(veredictos[1].action, 'block', 'el destino es la constancia');
  assert.strictEqual(veredictos[1].kind, 'exemptions');
  // hacia un archivo cualquiera: dos eventos, el destino no es una constancia
  const comun = editEventsFrom(parche('docs/notas.txt'));
  assert.strictEqual(comun.length, 2);
  assert.notStrictEqual(io.evaluate({ filePath: comun[1].tool_input.file_path, sessionId: SID, cwd: l.r, via: 'apply_patch', stateDir: l.estado }).verdict.kind, 'exemptions');
  // los tres ganchos que ya leían el `Move to` saltean el evento del destino: dan lo mismo que hoy
  for (const g of ['on-frontmatter-write.js', 'on-deprecated-edit.js', 'on-planning-artifact.js']) {
    assert.strictEqual(require(path.join(SCRIPTS, g)).handle(comun[1], {}), null, `${g}: el destino no se juzga dos veces`);
  }
});

test('T7 Camino6_RutaArmada_Frena', (t) => {
  const l = lab(t);
  for (const f of ['exemptions.jsonl', 'control-changes.jsonl']) {
    for (const cmd of [`echo x >> .ty*/${f}`, `echo x >> .tycon*/${f}`, `echo x >> \`echo .tycon\`/${f}`,
      `D=$(echo .tycon); echo x >> $D/${f}`, `echo x | tee -a $(echo .tycon)/${f}`, `cp README.md $(echo .tycon)/${f}`]) {
      frena(l, cmd, `${cmd}`);
    }
  }
});

test('T8 NoFrenaDeMas', (t) => {
  const l = lab(t);
  for (const cmd of ['cp -R src/ dist/', 'rsync -a build/ out/', 'cp -R "$SRC/." .', 'rm -f *.log', 'cat .tycon/exemptions.jsonl',
    'ln -s src enlace', 'cd .tycon && ls', 'echo x | tee $(mktemp)', 'echo x > "$OUT/$NAME"', 'echo x > "$RUN/plan.md"']) {
    pasa(l, cmd);
  }
  // un guion de shell que no nombra constancias
  const build = path.join(l.fuera, 'build.sh');
  fs.writeFileSync(build, '#!/bin/sh\necho hecho > build/salida.txt\n');
  pasa(l, `sh ${build}`);
  // las suites del arnés que arman constancias en carpetas temporales
  for (const s of ['exemptions-record.test.js', 'approvals.test.js']) pasa(l, `node --test "${path.join(__dirname, s)}"`);
  // un `Move to` de Codex hacia un archivo cualquiera: ver T6
  // con una ejecución abierta y su approvals.jsonl sin commitear, git lo mueve como hoy
  const aprob = '.advisors/pipeline-runs/r1/approvals.jsonl';
  l.git('checkout', '-q', '-b', 'otra');
  l.escribir(aprob, '{"tipo":"automatica"}\n{"tipo":"automatica","x":1}\n');
  l.git('commit', '-q', '-am', 'otra');
  const propio = l.git('rev-parse', 'HEAD').trim();
  l.git('checkout', '-q', 'main');
  l.escribir(aprob, '{"tipo":"automatica"}\n{"tipo":"automatica","y":2}\n');
  pasa(l, 'git stash', 'guardar el cambio');
  l.git('stash');
  pasa(l, 'git checkout otra', 'cambiar de rama');
  pasa(l, 'git stash pop');
  pasa(l, `git cherry-pick ${propio}`);
  pasa(l, 'git merge otra');
  // frenan a propósito: el freno no sabe adónde apunta la variable
  frena(l, 'echo x > "$OUT/exemptions.jsonl"');
  frena(l, 'echo x > .tycon/$NAME');
});

test('T9 RutasDeWindows', (t) => {
  // las rutas con barras invertidas, letra de unidad y mayúsculas se leen como las de Linux
  for (const p of ['C:\\r\\.tycon\\runtime-waivers.jsonl', '/c/r/.TYCON/Runtime-Waivers.jsonl', 'C:/r/.tycon/runtime-waivers.jsonl']) {
    assert.strictEqual(sg.signedRecordKind(p), 'runtime-waivers', p);
  }
  for (const p of ['C:\\r\\.advisors\\pipeline-runs\\x\\approvals.jsonl', '/c/r/Sub/.Advisors/Pipeline-Runs/x/Approvals.jsonl']) {
    assert.strictEqual(sg.signedRecordKind(p), 'run-approvals', p);
  }
  for (const p of ['C:\\r\\.tycon', '/c/r/.TYCON/Control-Changes/', 'C:/r/.github/control-changes', 'C:\\r\\tasks\\pending-approvals',
    'C:\\r\\.advisors\\pipeline-runs\\r1']) {
    assert.ok(sg.isRecordsDir(p), p);
  }
  for (const p of ['C:\\r\\src', '/c/r/.advisors/pipeline-runs', 'C:/r/.tycon/otra']) assert.ok(!sg.isRecordsDir(p), p);
  assert.ok(sg.isRecordFileName('Exemptions.JSONL'));
  assert.ok(!sg.isRecordFileName('exemptions.jsonl.bak'));
  // mayúsculas en la consola (la Mac y Windows no las distinguen)
  const l = lab(t);
  frena(l, 'echo x >> .TYCON/Exempt*.jsonl', 'comodín con mayúsculas');
  frena(l, 'cp -R $X .TYCON', 'copia con mayúsculas');
  frena(l, 'echo x >> .Ty*/Exemptions.jsonl', 'ruta armada con mayúsculas');
  // un archivo con un solo nombre no se compara por inodo
  assert.strictEqual(io.constanciaDelMismoArchivo(path.join(l.r, 'README.md'), [l.r]), null);
  fs.linkSync(path.join(l.r, '.tycon', 'runtime-waivers.jsonl'), path.join(l.r, 'w.jsonl'));
  assert.strictEqual(io.constanciaDelMismoArchivo(path.join(l.r, 'w.jsonl'), [l.r]), path.join(l.r, '.tycon', 'runtime-waivers.jsonl'));
});
