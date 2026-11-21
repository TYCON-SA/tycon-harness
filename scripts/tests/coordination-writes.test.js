'use strict';
/**
 * coordination-writes.test.js — la sesión designada coordinadora no cambia archivos de los repos ni de la copia instalada
 * del arnés: el freno se lo niega por Edit, Write y la consola, y le dice que lo encargue a una sesión. Lo suyo (la
 * memoria, lo de fuera de los repos) pasa; las demás sesiones, y todas sin coordinadora, no notan nada. Todo con una
 * casa de juguete: nada lee la casa real.
 * stable-data: las horas de los renglones del registro son fijas; ninguna prueba depende del día.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const PIPE = path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts');
const CW = require('../lib/coordination-writes.js');
const HANDLER = require(path.join(PIPE, 'on-coordination-write.js'));
const BASH = require(path.join(PIPE, 'on-bash-write-gate.js'));
const { CHAINS } = require(path.join(PIPE, 'dispatch.js'));
const { designacionVigente } = require(path.join(PIPE, 'lib', 'critical-waivers.js'));
const { stateDir } = require(path.join(PIPE, 'lib', 'state-dir.js'));

const COORD = 'ses-coord';
const OTRA = 'ses-otra';
const NIEGA = 'Sos la coordinadora';
const ENCARGA = 'Encargáselo a una sesión';
// los otros frenos de la consola, apagados: estas pruebas miran sólo el de la coordinadora
const SOLO_ESTE = { TYCON_STORY_GATE: 'off', TYCON_STORY_SKILL_GATE: 'off', TYCON_COORDINATION_WRITE_GUARD: undefined, TYCON_NO_RUN_CHANGE: '1' };

function conEnv(vars, fn) {
  const antes = {};
  for (const k of Object.keys(vars)) { antes[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
  }
}

/** La casa de juguete: un repo `acme`, su worktree, la copia instalada del arnés con un enlace a ella, y notas fuera. */
function casaNueva(t) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coord-writes-')));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const casa = path.join(raiz, 'casa');
  const estado = stateDir(casa);
  fs.mkdirSync(path.join(estado, 'coordination'), { recursive: true });
  const repo = path.join(raiz, 'acme');
  fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'guias'), { recursive: true });
  const puesto = path.join(raiz, 'acme--slot-2');
  fs.mkdirSync(puesto);
  fs.writeFileSync(path.join(puesto, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'slot-2')}\n`);
  const arnes = path.join(raiz, 'instalado', 'harness');
  fs.mkdirSync(path.join(arnes, 'skills', 'tycon-x'), { recursive: true });
  fs.mkdirSync(path.join(casa, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(arnes, 'skills', 'tycon-x'), path.join(casa, '.claude', 'skills', 'tycon-x'));
  const memoria = path.join(casa, '.claude', 'projects', 'p', 'memory');
  fs.mkdirSync(memoria, { recursive: true });
  const notas = path.join(raiz, 'notas');
  fs.mkdirSync(notas);
  return { raiz, casa, estado, repo, puesto, arnes, memoria, notas };
}

const renglon = (r) => `${JSON.stringify(r)}\n`;
// El renglón de la designación se arma a mano, con la forma que lee designacionVigente: designar() de critical-waivers.js
// sólo arma la entrada (pide el id de la sesión del ambiente y una frase que nombre el rol) y no escribe el registro; lo
// escribe marker.js designate-relay con el ok de una persona.
const designacion = (sesion) => renglon({ ts: '2026-11-04T20:00:00.000Z', name: 'relay-designation', status: 'ok', sesion, rol: 'coordinadora', quien: 'el dev', cita: 'Esta sesión es la coordinadora' });
const retirada = (sesion) => renglon({ ts: '2026-11-04T21:00:00.000Z', name: 'relay-designation', status: 'retirada', sesion, rol: 'coordinadora', quien: 'la persona', via: 'click' });
const registro = (toy) => path.join(toy.estado, 'gates.log');
const designar = (toy, sesion = COORD) => fs.appendFileSync(registro(toy), designacion(sesion));
const retirar = (toy, sesion = COORD) => fs.appendFileSync(registro(toy), retirada(sesion));

const opts = (toy) => ({ home: toy.casa, stateDir: toy.estado, installedRoots: [toy.arnes] });
const editar = (toy, archivo, sid = COORD, tool = 'Edit') => HANDLER.handle(
  { hook_event_name: 'PreToolUse', session_id: sid, tool_name: tool, tool_input: { file_path: archivo }, cwd: toy.raiz }, opts(toy));
const consola = (toy, cmd, sid = COORD, cwd = toy.raiz) => conEnv(SOLO_ESTE, () => BASH.handle(
  { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command: cmd }, cwd }, opts(toy)));
const negada = (r) => Boolean(r && r.block && r.block.includes(NIEGA));
const erroresDeGanchos = (toy) => { try { return fs.readFileSync(path.join(toy.estado, 'hook-errors.log'), 'utf8'); } catch { return ''; } };

test('T1 Coordinadora_EditEnRepo_SeNiega @story-8.212 @ac-1', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  const archivo = path.join(toy.repo, 'guias', 'x.md');
  const r = editar(toy, archivo);
  assert.ok(r && r.block, 'la coordinadora no edita un archivo de un repo');
  assert.ok(r.block.includes(NIEGA) && r.block.includes(ENCARGA), r.block);
  assert.ok(r.block.includes(archivo), 'la negativa nombra la ruta');
  assert.ok(negada(editar(toy, archivo, COORD, 'Write')), 'Write también');
  // sin la carpeta del estado, la saca de la casa (como el despachador, que no la pasa)
  assert.strictEqual(CW.currentCoordinator({ home: toy.casa }).session, COORD);
  assert.ok(negada(HANDLER.handle({ session_id: COORD, tool_name: 'Edit', tool_input: { file_path: archivo } }, { home: toy.casa, installedRoots: [toy.arnes] })));
});

test('T2 Coordinadora_WorktreeGitYArnes_SeNiegan @story-8.212 @ac-2', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  for (const archivo of [
    path.join(toy.puesto, 'a.js'),
    path.join(toy.repo, '.git', 'hooks', 'x'),
    path.join(toy.arnes, 'skills', 'tycon-x', 'SKILL.md'),
    path.join(toy.casa, '.claude', 'skills', 'tycon-x', 'SKILL.md'),
  ]) assert.ok(negada(editar(toy, archivo)), archivo);
});

test('T3 Coordinadora_Consola_SeNiega @story-8.212 @ac-3', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  fs.writeFileSync(path.join(toy.repo, 'a.md'), 'a\n');
  fs.writeFileSync(path.join(toy.repo, 'a.js'), 'a\n');
  fs.writeFileSync(path.join(toy.repo, 'd'), 'd\n');
  for (const cmd of [
    'echo x > acme/a.md',
    "sed -i '' s/a/b/ acme/a.js",
    'cp notas/b acme/c',
    'rm acme/d',
    `node -e "require('fs').writeFileSync('acme/e','x')"`,
    'git -C acme checkout -- a.md',
    'cd notas && cd .. && echo x > acme/g.md',
  ]) assert.ok(negada(consola(toy, cmd)), cmd);
  // lo que un guion de archivo escribe por dentro no se mira (decisión 10)
  fs.writeFileSync(path.join(toy.notas, 'guion.js'), "require('fs').writeFileSync(process.argv[2], 'x');\n");
  assert.ok(!negada(consola(toy, 'node notas/guion.js acme/f')), 'el guion de archivo pasa (decisión 10)');
});

test('T4 Coordinadora_ArchivoNuevo_SeNiega @story-8.212 @ac-4', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  assert.ok(negada(editar(toy, path.join(toy.repo, 'nueva', 'carpeta', 'x.md'), COORD, 'Write')));
  assert.ok(negada(consola(toy, 'mkdir -p acme/otra && echo x > acme/otra/y.md')));
});

test('T5 Coordinadora_LoSuyo_Pasa @story-8.212 @ac-5', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  for (const archivo of [path.join(toy.estado, 'coordination', 'tablero.json'), path.join(toy.memoria, 'm.md'), path.join(toy.notas, 'encargo.md')]) {
    assert.strictEqual(editar(toy, archivo, COORD, 'Write'), null, archivo);
  }
  assert.ok(!negada(consola(toy, `echo x > ${path.join(toy.notas, 'encargo.md')}`)), 'el encargo por consola');
  // con la casa dentro de un repo de juguete: el estado y la memoria siguen pasando; los encargos pasan por estar fuera
  fs.mkdirSync(path.join(toy.raiz, '.git'));
  assert.strictEqual(editar(toy, path.join(toy.estado, 'coordination', 'tablero.json'), COORD, 'Write'), null, 'el estado');
  assert.strictEqual(editar(toy, path.join(toy.memoria, 'm.md'), COORD, 'Write'), null, 'la memoria');
});

test('T6 OtraSesion_Pasa @story-8.212 @ac-6', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  assert.strictEqual(editar(toy, path.join(toy.repo, 'a.md'), OTRA), null);
  assert.ok(!negada(consola(toy, 'echo x > acme/a.md', OTRA)));
});

test('T7 SinDesignacion_Pasa @story-8.212 @ac-7', (t) => {
  const toy = casaNueva(t);
  const archivo = path.join(toy.repo, 'a.md');
  assert.strictEqual(editar(toy, archivo), null, 'sin registro, nadie es coordinadora');
  designar(toy);
  designar(toy, OTRA);
  assert.strictEqual(editar(toy, archivo), null, 'la designación pasó a otra sesión: la anterior escribe');
  assert.ok(negada(editar(toy, archivo, OTRA)), 'la nueva queda frenada');
  retirar(toy, OTRA);
  assert.strictEqual(editar(toy, archivo, OTRA), null, 'retirada, nadie es coordinadora');
  assert.strictEqual(editar(toy, archivo), null, 'y la retirada no le devuelve el rol a la anterior');
});

test('T8 SinDato_PasaYAnota @story-8.212 @ac-8', (t) => {
  const toy = casaNueva(t);
  const archivo = path.join(toy.repo, 'a.md');
  // un registro roto: es una carpeta, no se puede leer
  fs.mkdirSync(registro(toy));
  assert.strictEqual(editar(toy, archivo), null, 'registro ilegible: pasa');
  assert.match(erroresDeGanchos(toy), /coordination-write/, 'y lo anota');
  fs.rmSync(registro(toy), { recursive: true, force: true });
  designar(toy);
  const antes = erroresDeGanchos(toy).length;
  const sinSesion = HANDLER.handle({ tool_name: 'Edit', tool_input: { file_path: archivo }, cwd: toy.raiz }, opts(toy));
  assert.strictEqual(sinSesion, null, 'evento sin session_id: pasa');
  assert.ok(erroresDeGanchos(toy).length > antes, 'y lo anota');
  assert.ok(!negada(consola(toy, 'echo x > "$NO_DEFINIDA/a.md"')), 'destino sin resolver: pasa');
  conEnv({ TYCON_COORDINATION_WRITE_GUARD: '0' }, () => {
    assert.strictEqual(editar(toy, archivo), null, 'apagado, pasa');
  });
});

test('T9 Coordinadora_ComandosQueNoEscriben_Pasan @story-8.212 @ac-9', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  for (const cmd of ['git -C acme status', 'node x/coordination.js open --name a', 'cd acme && gh pr view 1']) {
    assert.ok(!negada(consola(toy, cmd)), cmd);
  }
});

test('T10 Despachador_OrdenDelHandler @story-8.212 @ac-1', () => {
  const nombres = CHAINS['pre-edit'].map((h) => h.name);
  const i = nombres.indexOf('on-coordination-write');
  assert.ok(i >= 0, 'el handler está en la lista de antes de editar');
  assert.ok(i > nombres.indexOf('on-controls-off'), 'después de on-controls-off');
  assert.ok(i < nombres.indexOf('on-story-gate'), 'antes de on-story-gate');
  const h = CHAINS['pre-edit'][i];
  assert.deepStrictEqual(h.steps, ['all']);
  assert.strictEqual(h.effect, 'blocks');
});

test('T12 Designacion_ConMemoria @story-8.212 @ac-11', (t) => {
  const toy = casaNueva(t);
  const log = registro(toy);
  // un registro de 14 MB sin designación
  const relleno = renglon({ ts: '2026-11-04T19:00:00.000Z', name: 'story-gate', status: 'pass', sesion: 'ses-x', reason: 'r'.repeat(380) });
  fs.writeFileSync(log, relleno.repeat(Math.ceil((14 * 1024 * 1024) / relleno.length)));
  const lecturas = { enteras: 0, aperturas: 0 };
  const orig = { readFileSync: fs.readFileSync, openSync: fs.openSync };
  fs.readFileSync = function (p, ...r) { if (String(p) === log) lecturas.enteras++; return orig.readFileSync.call(fs, p, ...r); };
  fs.openSync = function (p, ...r) { if (String(p) === log) lecturas.aperturas++; return orig.openSync.call(fs, p, ...r); };
  t.after(() => { fs.readFileSync = orig.readFileSync; fs.openSync = orig.openSync; });
  const quien = () => CW.currentCoordinator({ stateDir: toy.estado });
  const igualQueEntero = (r) => {
    const d = designacionVigente({ dir: toy.estado });
    assert.strictEqual(r.session, d ? d.sesion : null, 'el mismo resultado que leer el registro entero');
  };

  assert.strictEqual(quien().session, null, 'la primera lee el registro');
  const cuenta = { ...lecturas };
  assert.strictEqual(quien().session, null);
  assert.deepStrictEqual(lecturas, cuenta, 'la segunda no lo lee: la memoria alcanza');

  designar(toy);
  const r3 = quien();
  assert.strictEqual(r3.session, COORD, 'lo agregado trae la designación');
  assert.strictEqual(lecturas.enteras, cuenta.enteras, 'sin leerlo entero');
  assert.ok(lecturas.aperturas > cuenta.aperturas, 'sólo lo agregado');
  igualQueEntero(r3);

  retirar(toy);
  const r4 = quien();
  assert.strictEqual(r4.session, null, 'una retirada agregada deja sin coordinadora');
  igualQueEntero(r4);

  fs.writeFileSync(log, designacion(OTRA));
  const enteras = lecturas.enteras;
  assert.strictEqual(quien().session, OTRA, 'achicado: se lee entero');
  assert.ok(lecturas.enteras > enteras);

  // sin poder escribir la memoria: el mismo resultado
  fs.rmSync(path.join(toy.estado, 'coordination'), { recursive: true, force: true });
  fs.writeFileSync(path.join(toy.estado, 'coordination'), 'no es una carpeta');
  assert.strictEqual(quien().session, OTRA);
  designar(toy);
  assert.strictEqual(quien().session, COORD);
});

// Lo que encontró el pase adversarial: cada clase con su prueba.

test('T3b Coordinadora_ConsolaComandosQueEscriben_SeNiegan @story-8.212 @ac-3', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  for (const f of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(toy.repo, f), 'a\n');
  fs.writeFileSync(path.join(toy.notas, 'o.txt'), 'o\n');
  for (const cmd of [
    // el origen de un mv sale del repo
    'mv acme/a.md notas/',
    'mv -f acme/b.md /tmp/',
    'cd acme && mv c.md ../notas/c.md',
    'git -C acme mv a.md z.md',
    // lo que el lector de siempre no reconoce
    'touch acme/n.md',
    'mkdir -p acme/nueva',
    'chmod 644 acme/a.md',
    'install -m 644 notas/o.txt acme/i.txt',
    'rsync -a notas/ acme/',
    'curl -o acme/c.html http://x',
    'wget -O acme/w.html http://x',
    'dd if=/dev/zero of=acme/z bs=1 count=1',
    'find acme -name x -delete',
    'vim acme/a.md',
    // los git que cambian el árbol de trabajo
    'git -C acme reset --hard',
    'git -C acme clean -fd',
    'cd acme && git clean -fdx',
    'git -C acme checkout una-rama',
    'git -C acme switch otra',
    'git -C acme stash',
    'git -C acme restore .',
    // el cd en otro renglón, con || exit y con cd --
    'cd acme\necho x > f',
    'cd acme || exit; echo x > f',
    'cd -- acme && echo x > f',
    // las demás ramas: descargas a la carpeta, editores en el lugar, find que borra, git rm y tee
    'cd acme && wget http://x',
    'cd acme && curl -O http://x/f',
    "gsed -i 's/a/b/' acme/a.md",
    "awk -i inplace '{print}' acme/a.md",
    'find acme -name x -exec rm {} \\;',
    'git -C acme rm a.md',
    'echo x | tee acme/t.md',
  ]) assert.ok(negada(consola(toy, cmd)), cmd);
});

test('T9b Coordinadora_MayorQueNoEsRedireccion_Pasa @story-8.212 @ac-3 @ac-9', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  // desde el propio repo, como trabaja la coordinadora: lo que no escribe no frena
  for (const cmd of [
    'echo $((1>2))',
    'echo x\\>y',
    'echo ${x:-a>b}',
    'echo x | tee >(cat >/dev/null)',
    'git stash list',
    'git log --oneline -1',
    'git fetch -q origin',
    'chmod 644 /tmp/fuera-de-repos.txt',
    // los gemelos que no cambian el árbol de trabajo
    'git reset --soft HEAD',
    'git clean -n',
    'git stash show',
    'wget -O - http://x',
    'find . -name x',
    'find . -name x -exec cat {} \\;',
  ]) assert.ok(!negada(consola(toy, cmd, COORD, toy.repo)), cmd);
});

test('T8b SinDato_CdSinResolver_Pasa @story-8.212 @ac-8', (t) => {
  const toy = casaNueva(t);
  designar(toy);
  // el cd va a una carpeta que no se sabe: lo relativo puede caer en cualquier lado y pasa
  for (const cmd of ['cd "$TMPDIR" && echo x > f', 'cd $SP && echo x > f', 'cd "$(mktemp -d)" && echo x > f']) {
    assert.ok(!negada(consola(toy, cmd, COORD, toy.repo)), cmd);
  }
  // lo absoluto se sabe igual
  assert.ok(negada(consola(toy, `cd "$TMPDIR" && echo x > ${path.join(toy.repo, 'f')}`, COORD, toy.repo)));
});

test('T12b Designacion_RenglonAMedias_YRegistroReescrito @story-8.212 @ac-11', (t) => {
  const toy = casaNueva(t);
  const log = registro(toy);
  const quien = () => CW.currentCoordinator({ stateDir: toy.estado }).session;
  // la primera lectura, entera, llega con un renglón a medio escribir: al completarse se tiene que ver
  const otra = designacion(OTRA);
  fs.writeFileSync(log, designacion(COORD) + otra.slice(0, 40));
  assert.strictEqual(quien(), COORD);
  fs.appendFileSync(log, otra.slice(40));
  assert.strictEqual(quien(), OTRA, 'el renglón completado cuenta');
  // el registro se vacía y vuelve a crecer en el mismo archivo, más largo que lo guardado
  const fd = fs.openSync(log, 'r+');
  fs.ftruncateSync(fd, 0);
  fs.closeSync(fd);
  const relleno = renglon({ ts: '2026-11-04T19:00:00.000Z', name: 'story-gate', status: 'pass', sesion: 'ses-x', reason: 'r'.repeat(300) });
  fs.appendFileSync(log, relleno.repeat(4) + designacion(COORD));
  assert.strictEqual(quien(), COORD, 'reescrito: se lee entero, no desde el desplazamiento viejo');
  // el mismo tamaño con otra hora: otra designación del mismo largo se ve
  const AAAA = 'ses-aaaa';
  const BBBB = 'ses-bbbb';
  fs.writeFileSync(log, designacion(AAAA));
  fs.utimesSync(log, new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:00:00Z'));
  assert.strictEqual(quien(), AAAA);
  fs.writeFileSync(log, designacion(BBBB));
  fs.utimesSync(log, new Date('2026-11-04T11:00:00Z'), new Date('2026-11-04T11:00:00Z'));
  assert.strictEqual(quien(), BBBB, 'mismo tamaño, otra hora: se lee de nuevo');
  // otro archivo en el mismo lugar (otro ino): se lee entero aunque empiece igual
  const lecturas = { enteras: 0 };
  const leer = fs.readFileSync;
  fs.readFileSync = function (p, ...r) { if (String(p) === log) lecturas.enteras++; return leer.call(fs, p, ...r); };
  t.after(() => { fs.readFileSync = leer; });
  const nuevo = `${log}.nuevo`;
  fs.writeFileSync(nuevo, designacion(BBBB) + designacion(AAAA));
  fs.renameSync(nuevo, log);
  assert.strictEqual(quien(), AAAA);
  assert.strictEqual(lecturas.enteras, 1, 'otro ino: una lectura entera');
});

test('T12c Designacion_SinCarpetaDeCoordinacion_GuardaLaMemoria @story-8.212 @ac-11', (t) => {
  // una máquina sin coordinadora no tiene `<estado>/coordination/`: la memoria se guarda igual y no se anota un error
  const toy = casaNueva(t);
  fs.rmSync(path.join(toy.estado, 'coordination'), { recursive: true, force: true });
  fs.writeFileSync(registro(toy), renglon({ ts: '2026-11-04T19:00:00.000Z', name: 'story-gate', status: 'pass', sesion: 'ses-x' }));
  const lecturas = { enteras: 0 };
  const leer = fs.readFileSync;
  fs.readFileSync = function (p, ...r) { if (String(p) === registro(toy)) lecturas.enteras++; return leer.call(fs, p, ...r); };
  t.after(() => { fs.readFileSync = leer; });
  assert.strictEqual(CW.currentCoordinator({ stateDir: toy.estado }).session, null);
  assert.strictEqual(CW.currentCoordinator({ stateDir: toy.estado }).session, null);
  assert.ok(fs.existsSync(path.join(toy.estado, 'coordination', CW.MEMO)), 'la memoria quedó guardada');
  assert.strictEqual(lecturas.enteras, 1, 'la segunda llamada no lee el registro');
  assert.doesNotMatch(erroresDeGanchos(toy), /coordination-write/, 'y no se anota ningún error');
});
