'use strict';
/**
 * save-ok.test.js — el ok de guardar una story (commit, push y los pedidos) es una firma con constancia.
 *
 * La biblioteca (`lib/save-ok.js`) en proceso, sobre repos de git descartables con su `origin/main`: la huella de cada
 * repo, si el ok sigue valiendo, si la corrida terminó limpia, lo sensible y el aviso al dueño con un canal de mentira.
 * El guion (`marker.js approve-save`) sólo en lo que sale antes de la firma: ninguna prueba abre la ventana ni escribe
 * en el estado de la cuenta.
 *
 * stable-data: las horas de la corrida son fijas; ninguna se compara con el reloj.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const SO = require('../lib/save-ok.js');
const MARKER = path.join(__dirname, '..', 'marker.js');
const { SIGNATURES, GROUPS, expand, SENSITIVE } = require(path.join(RAIZ, 'scripts', 'lib', 'signatures.js'));
const DS = require(path.join(RAIZ, 'scripts', 'lib', 'delegated-signing.js'));
const ow = require(path.join(RAIZ, 'scripts', 'lib', 'owner-window.js'));

const ANTES = '2026-10-29T10:00:00.000Z';
const DESPUES = '2026-10-29T11:00:00.000Z';

function sh(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Un repo con `origin/main` en el primer commit y la rama de la story sacada. `archivos`: { ruta: contenido }. */
function repo(t, archivos = { 'LEEME.md': 'hola\n' }) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  sh(d, 'init', '-q', '-b', 'main');
  for (const [r, c] of Object.entries(archivos)) escribir(d, r, c);
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'base');
  sh(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh(d, 'checkout', '-q', '-b', 'story/la-prueba');
  return d;
}
// cada archivo con la hora fija de antes de la corrida: «el último cambio» no depende del reloj de la máquina
function escribir(d, r, c) {
  const f = path.join(d, r);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, c);
  fs.utimesSync(f, new Date(ANTES), new Date(ANTES));
}

/** La corrida limpia sobre `repos`: preparación cerrada con estas huellas, pruebas y pase después del último cambio. */
function corridaLimpia(repos, extra = {}) {
  return {
    storyId: '9.99', startedAt: ANTES, repoPath: repos[0], storyPath: path.join(repos[0], 'specs', 'story-9.99.md'),
    stepsCompleted: ['start', 'validate-story', 'plan', 'approve-plan', 'implement', 'run-tests', 'reviewers', 'findings', 'prepare-commit'],
    prepareCommitHuellas: SO.huellas(repos),
    checks: { tests: 'green' }, checksProvenance: { tests: 'test-gate' }, checksAt: { tests: DESPUES },
    adversarial: { runId: 'r1', launchedAt: DESPUES, sessionId: 'ses-a' },
    adversarialPasses: [{ ts: DESPUES, tipo: '5b', confirmados: 2, veredicto: 'no-listo' }],
    fileEvents: [{ path: path.join(repos[0], 'LEEME.md'), ts: ANTES, code: true }],
    ...extra,
  };
}
const canalQueEntrega = () => ({ canales: ['telegram'], mail: null, chat: null, origen: 'perfil', problema: null });
const entrega = (orden) => (o) => { orden.push(['aviso', o.texto]); return { resultados: [{ canal: 'telegram', entregado: true }], entregado: true }; };
/** La firma por delegación con todo lo de afuera inyectado: el orden de lo que pasó queda en `orden`. */
function porDelegacion(marker, { repos, findings = [], firmas = [], canales = canalQueEntrega, mandar, orden = [] } = {}) {
  return SO.antesDeFirmar({
    via: 'delegacion', marker, repos, findings, firmasDeLaCorrida: firmas, canales, mandar: mandar || entrega(orden),
  });
}

test('Catalogo_Save_GuionOtraSesion_FueraDeGrupos (T1) @story-8.143 @ac-1', () => {
  const s = SIGNATURES.find((x) => x.id === 'save');
  assert.ok(s, '«save» en el catálogo');
  assert.strictEqual(s.kind, 'guion');
  assert.strictEqual(s.otherSession, 'yes');
  assert.match(s.command, /^marker\.js approve-save/);
  for (const g of Object.keys(GROUPS)) {
    assert.ok(!expand(g).includes('save'), `el grupo ${g} no la trae`);
    assert.ok(!expand(g, { restringe: true }).includes('save'), `el grupo ${g} restringido no la trae`);
  }
  assert.ok(Array.isArray(SENSITIVE) && SENSITIVE.length, 'la lista de lo sensible vive en el catálogo');
});

test('ApproveSave_SinFirma_NoEscribe (T2) @story-8.143 @ac-1 @ac-2', (t) => {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-casa-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const activos = path.join(casa, '.claude', '.tycon-pipeline', 'active');
  fs.mkdirSync(activos, { recursive: true });
  const archivo = path.join(activos, 'ses-a.json');
  const texto = JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', startedAt: ANTES, lastTouch: new Date().toISOString() });
  fs.writeFileSync(archivo, texto);
  const env = { ...process.env, HOME: casa, CLAUDE_CODE_SESSION_ID: 'ses-a' };
  for (const k of ['TYCON_HOME', 'TYCON_SESSION_ID', 'CODEX_SESSION_ID', 'NODE_TEST_CONTEXT']) delete env[k];
  const r = spawnSync(process.execPath, [MARKER, 'approve-save'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(fs.readFileSync(archivo, 'utf8'), texto, 'el marcador quedó igual byte a byte');
  // para otra sesión sin ejecución abierta: sale 2 antes de pedir nada
  const otra = spawnSync(process.execPath, [MARKER, 'approve-save', '--for-session', 'ses-z'], { encoding: 'utf8', env });
  assert.strictEqual(otra.status, 2, otra.stderr);
  assert.match(otra.stderr, /no tiene una ejecución abierta/);
});

test('ApproveSave_Ventana_EscribeHuellas (T3) @story-8.143 @ac-2', (t) => {
  const a = repo(t);
  const b = repo(t);
  escribir(a, 'LEEME.md', 'cambiado\n');
  escribir(a, 'nuevo.js', 'module.exports = 1;\n');      // sin seguimiento
  escribir(b, 'LEEME.md', 'por consola\n');              // ningún fileEvent lo nombra
  const sinCambios = repo(t);
  const indiceA = fs.readFileSync(path.join(a, '.git', 'index'));
  const marker = corridaLimpia([a]);
  const repos = SO.reposDeLaCorrida({ marker, hermanos: [b, sinCambios] });
  assert.deepStrictEqual(repos.sort(), [a, b].sort(), 'el de la story y el hermano con cambios; el hermano sin cambios no');
  const r = SO.antesDeFirmar({ via: 'ventana', marker, repos });
  assert.strictEqual(r.codigo, 0, r.motivo);
  assert.deepStrictEqual(fs.readFileSync(path.join(a, '.git', 'index')), indiceA, 'el índice de la persona no se tocó');
  const ok = SO.constancia({ marker, via: 'ventana', por: 'ses-a', previo: r, ahora: DESPUES });
  assert.strictEqual(ok.via, 'ventana');
  assert.strictEqual(ok.por, 'ses-a');
  assert.strictEqual(ok.storyId, '9.99');
  assert.strictEqual(ok.startedAt, ANTES);
  assert.strictEqual(ok.huellas.length, 2, 'una huella por repo');
  const ha = ok.huellas.find((h) => h.repo === a);
  assert.strictEqual(ha.rama, 'story/la-prueba');
  assert.strictEqual(ha.base, sh(a, 'rev-parse', 'origin/main'));
  // el árbol trae el archivo nuevo: es el árbol del commit que guardaría todo
  sh(a, 'add', '-A');
  assert.strictEqual(ha.arbol, sh(a, 'write-tree'));
});

test('SaveCheck_Vigente_Commiteado_Cambiado (T4) @story-8.143 @ac-3', (t) => {
  const a = repo(t);
  escribir(a, 'LEEME.md', 'cambiado\n');
  const saveOk = { storyId: '9.99', startedAt: ANTES, huellas: SO.huellas([a]) };
  assert.strictEqual(SO.vigente({ saveOk }).ok, true, 'sin cambios');
  sh(a, 'add', '-A');
  sh(a, 'commit', '-q', '-m', 'lo mismo');
  assert.strictEqual(SO.vigente({ saveOk }).ok, true, 'commiteado igual');
  const conPush = SO.vigente({ saveOk, push: { remoto: 'origin', rama: 'story/la-prueba' }, repoActual: a });
  assert.strictEqual(conPush.ok, true, conPush.motivo);
  assert.strictEqual(SO.vigente({ saveOk, push: { remoto: 'origin', rama: 'main' }, repoActual: a }).ok, false, 'a main no');
  assert.strictEqual(SO.vigente({ saveOk, push: { remoto: 'origin', rama: 'otra' }, repoActual: a }).ok, false, 'a otra rama no');
  escribir(a, 'LEEME.md', 'después del ok\n');
  const cambiado = SO.vigente({ saveOk });
  assert.strictEqual(cambiado.ok, false);
  assert.ok(cambiado.motivo.includes(a), 'nombra el repo');
  sh(a, 'checkout', '-q', '--', 'LEEME.md');
  sh(a, 'checkout', '-q', '-b', 'otra');
  assert.strictEqual(SO.vigente({ saveOk }).ok, false, 'otra rama');
  assert.strictEqual(SO.vigente({ saveOk: null }).ok, false, 'sin saveOk');
});

test('Delegada_StoryLimpia_Firma (T5) @story-8.143 @ac-4 @ac-6', (t) => {
  const a = repo(t);
  escribir(a, 'LEEME.md', 'cambiado\n');
  const orden = [];
  const marker = corridaLimpia([a]);
  const r = porDelegacion(marker, { repos: [a], orden });
  assert.strictEqual(r.codigo, 0, r.motivo);
  orden.push(['constancia']);
  const ok = SO.constancia({ marker, via: 'delegacion', por: 'ses-coord', previo: r, ahora: DESPUES });
  assert.strictEqual(ok.via, 'delegacion');
  assert.deepStrictEqual(ok.canales, ['telegram'], 'la constancia nombra el canal que entregó');
  assert.deepStrictEqual(orden.map((x) => x[0]), ['aviso', 'constancia'], 'el aviso sale antes que la constancia');
  const linea = orden[0][1];
  assert.ok(!linea.includes('\n'), 'una línea');
  assert.match(linea, /9\.99/);
  assert.match(linea, /coordinadora/);
  assert.match(linea, /0 críticos/);
  assert.match(linea, /2 confirmados/);
  assert.ok(linea.includes(path.basename(a)), 'nombra el repo');
  // un fetch movió la base después de prepare-commit: el código que se guarda es el mismo
  sh(a, 'stash', '-q');
  sh(a, 'commit', '-q', '--allow-empty', '-m', 'main avanzó');
  sh(a, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  sh(a, 'reset', '-q', '--hard', 'HEAD~1');
  sh(a, 'stash', 'pop', '-q');
  escribir(a, 'LEEME.md', 'cambiado\n');
  assert.strictEqual(porDelegacion(marker, { repos: [a] }).codigo, 0, 'con la base movida firma igual');
  // el pase salteado por la regla del portón (sin firma)
  const salteo = corridaLimpia([a], { adversarial: undefined, adversarialPasses: [], adversarialSkip: { motivo: 'riesgo bajo', at: DESPUES } });
  const o2 = [];
  assert.strictEqual(porDelegacion(salteo, { repos: [a], orden: o2 }).codigo, 0);
  assert.match(o2[0][1], /salteado por la regla/);
});

test('Delegada_NoLimpia_Sale2 (T6) @story-8.143 @ac-4', (t) => {
  const a = repo(t);
  escribir(a, 'LEEME.md', 'cambiado\n');
  const casos = [
    ['sin prepare-commit', corridaLimpia([a], { stepsCompleted: ['start'] }), /prepar/i],
    ['tests anteriores al último cambio', corridaLimpia([a], { checksAt: { tests: ANTES }, fileEvents: [{ path: path.join(a, 'LEEME.md'), ts: DESPUES, code: true }] }), /pruebas/],
    ['el pase lanzado sin resultado', corridaLimpia([a], { adversarialPasses: [] }), /pase/],
    ['el pase salteado con firma', corridaLimpia([a], { adversarial: undefined, adversarialPasses: [], adversarialSkip: { motivo: 'x', at: DESPUES, firmado: { via: 'ventana' } } }), /firma/],
    ['el pase abandonado', corridaLimpia([a], { adversarialSkip: { abandonado: true, runId: 'r1', at: DESPUES } }), /pase/],
    ['tests manual-forced', corridaLimpia([a], { checksProvenance: { tests: 'manual-forced' } }), /test-gate/],
  ];
  for (const [nombre, m, re] of casos) {
    const orden = [];
    const r = porDelegacion(m, { repos: [a], orden });
    assert.strictEqual(r.codigo, 2, nombre);
    assert.match(r.motivo, re, `${nombre}: ${r.motivo}`);
    assert.strictEqual(orden.length, 0, `${nombre}: no avisa`);
  }
  const m = corridaLimpia([a]);
  escribir(a, 'LEEME.md', 'después de prepare-commit\n');
  assert.match(porDelegacion(m, { repos: [a] }).motivo, /cambió/, 'un cambio después de prepare-commit');
  escribir(a, 'LEEME.md', 'cambiado\n');
  const critico = porDelegacion(m, { repos: [a], findings: [{ rule_id: 'X-C1', severity: 'CRITICAL', disposition: 'waived' }] });
  assert.strictEqual(critico.codigo, 2);
  assert.match(critico.motivo, /CRITICAL/);
  const exencion = porDelegacion(m, { repos: [a], firmas: [{ name: 'runtime-waiver-signed', destino: 'ses-a', ts: DESPUES }] });
  assert.strictEqual(exencion.codigo, 2);
  assert.match(exencion.motivo, /runtime-waiver/);
  sh(a, 'update-ref', '-d', 'refs/remotes/origin/main');
  const sinBase = porDelegacion(m, { repos: [a] });
  assert.strictEqual(sinBase.codigo, 2);
  assert.ok(sinBase.motivo.includes(a), 'nombra el repo sin base');
});

test('Delegada_Sensible_Sale2 (T7) @story-8.143 @ac-5', (t) => {
  const base = { 'scripts/lib/signatures.js': 'x\n', 'scripts/lib/otro.js': 'y\n', 'LEEME.md': 'z\n' };
  const casos = [
    ['scripts/lib/owner-window.js', (d) => escribir(d, 'scripts/lib/owner-window.js', 'a\n')],
    ['scripts/lib/notify.js', (d) => escribir(d, 'scripts/lib/notify.js', 'a\n')],
    ['scripts/lib/OWNER-WINDOW.js', (d) => escribir(d, 'scripts/lib/OWNER-WINDOW.js', 'a\n')],
    ['scripts/lib/signatures.js', (d) => sh(d, 'mv', 'scripts/lib/signatures.js', 'scripts/lib/firmas.js')],
    ['scripts/lib/usa.js', (d) => escribir(d, 'scripts/lib/usa.js', "const s = require('./signatures.js');\n")],
    ['team-profile.json', (d) => escribir(d, 'team-profile.json', '{}\n')],
  ];
  for (const [archivo, cambiar] of casos) {
    const d = repo(t, base);
    cambiar(d);
    const s = SO.sensibles({ repos: [d] });
    assert.ok(s.some((x) => x.archivo.toLowerCase() === archivo.toLowerCase()), `${archivo}: ${JSON.stringify(s)}`);
    const r = porDelegacion(corridaLimpia([d]), { repos: [d] });
    assert.strictEqual(r.codigo, 2, archivo);
    assert.ok(r.motivo.includes(archivo), `${archivo}: ${r.motivo}`);
  }
  const limpio = repo(t, base);
  escribir(limpio, 'LEEME.md', 'nada sensible\n');
  assert.deepStrictEqual(SO.sensibles({ repos: [limpio] }), []);
});

test('Ventana_NoLimpiaNiSensible_Firma (T8) @story-8.143 @ac-4 @ac-5', (t) => {
  const a = repo(t);
  escribir(a, 'scripts/lib/owner-window.js', 'a\n');
  const m = corridaLimpia([a], { stepsCompleted: ['start'] });
  const r = SO.antesDeFirmar({ via: 'ventana', marker: m, repos: [a], findings: [{ rule_id: 'X-C1', severity: 'CRITICAL', disposition: 'waived' }] });
  assert.strictEqual(r.codigo, 0, 'el dueño decide');
});

test('Delegada_SinCanal_Sale1 (T9) @story-8.143 @ac-6', (t) => {
  const a = repo(t);
  escribir(a, 'LEEME.md', 'cambiado\n');
  const m = corridaLimpia([a]);
  const casos = [
    ['sin lista en el perfil', () => ({ canales: ['telegram'], origen: 'antes', problema: null })],
    ['la lista vacía', () => ({ canales: [], origen: 'perfil', problema: null })],
  ];
  for (const [nombre, canales] of casos) {
    let llamado = false;
    const r = porDelegacion(m, { repos: [a], canales, mandar: () => { llamado = true; return { resultados: [], entregado: true }; } });
    assert.strictEqual(r.codigo, 1, nombre);
    assert.strictEqual(llamado, false, `${nombre}: no manda nada`);
  }
  const falla = porDelegacion(m, { repos: [a], mandar: () => ({ resultados: [{ canal: 'telegram', entregado: false, motivo: 'sin red' }], entregado: false }) });
  assert.strictEqual(falla.codigo, 1, 'el canal que falla');
  const ninguno = porDelegacion(m, { repos: [a], mandar: () => ({ resultados: [], entregado: true }) });
  assert.strictEqual(ninguno.codigo, 1, '«ningún canal» no es una entrega');
});

const HUELLA = 'a1b2c3d4e5f60718';
function casaConDesignada(t, { confirmada = true } = {}) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'save-ok-firmas-'));
  t.after(() => fs.rmSync(casa, { recursive: true, force: true }));
  const estado = path.join(casa, '.claude', '.tycon-pipeline');
  fs.mkdirSync(path.join(estado, 'active'), { recursive: true });
  fs.writeFileSync(path.join(estado, 'active', 'ses-a.json'), JSON.stringify({ sessionId: 'ses-a', storyId: '9.99', startedAt: ANTES }));
  const d = { name: 'relay-designation', status: 'ok', ts: '2026-10-29T08:00:00.000Z', sesion: 'ses-coord', rol: 'coordinadora', quien: 'dueño', cita: 'Esta sesión es la coordinadora' };
  const lineas = [d];
  if (confirmada) lineas.push(DS.confirmationRecord(d, '2026-10-29T08:01:00.000Z'));
  fs.writeFileSync(path.join(estado, 'gates.log'), `${lineas.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return { casa, estado };
}
const PERFIL = { delegated_signing: ['save'], owner_only: [], delegated_machines: [{ id: HUELLA, label: 'Mac de prueba' }] };
const delega = (casa, estado, o = {}) => DS.delegaSinVentana({
  firma: 'save', sesion: o.sesion || 'ses-coord', destino: o.destino || 'ses-a', home: casa, estado,
  perfil: o.perfil || (() => PERFIL), huella: o.huella || (() => ({ huella: HUELLA })),
});

test('Save_OwnerOnly_O_SinDelegar_PideVentana (T10) @story-8.143 @ac-7', (t) => {
  const { casa, estado } = casaConDesignada(t);
  assert.strictEqual(delega(casa, estado).ok, true, 'con todo, se delega');
  const casos = [
    ['save en owner_only', () => ({ ...PERFIL, owner_only: ['save'] })],
    ['save fuera de delegated_signing', () => ({ ...PERFIL, delegated_signing: ['plan-approval'] })],
    ['un perfil que delega escape-phrases', () => ({ ...PERFIL, delegated_signing: ['escape-phrases'] })],
    ['un perfil ilegible', () => { throw new Error('roto'); }],
    ['delegated_signing que no es una lista', () => ({ ...PERFIL, delegated_signing: { save: true } })],
  ];
  for (const [nombre, perfil] of casos) assert.strictEqual(delega(casa, estado, { perfil }).ok, false, nombre);
});

test('ApproveSave_ForSession_OtraCorrida_Sale2 (T11) @story-8.143 @ac-8', () => {
  const vio = { storyId: '9.99', startedAt: ANTES };
  const r = (corrida) => ow.fijarDestino({ r: { destino: 'ses-a', via: 'delegacion', sesion: 'ses-coord', registro: { corrida: vio } }, propia: 'ses-coord', necesitaMarcador: true, leerMarcador: () => corrida, env: {} });
  assert.strictEqual(r({ storyId: '9.99', startedAt: ANTES }).codigo, 0, 'la misma corrida');
  assert.strictEqual(r({ storyId: '9.100', startedAt: ANTES }).codigo, 2, 'otra story');
  assert.strictEqual(r({ storyId: '9.99', startedAt: DESPUES }).codigo, 2, 'la misma story, cerrada y vuelta a abrir');
  assert.strictEqual(r(null).codigo, 2, 'sin corrida');
});

test('PrepareCommit_OkDeGuardar_PorConstancia (T15) @story-8.143 @ac-9', () => {
  const texto = fs.readFileSync(path.join(__dirname, '..', '..', 'steps', 'step-11-prepare-commit.md'), 'utf8');
  assert.match(texto, /save-check/);
  assert.match(texto, /save-check[^\n]*(antes del commit|antes de commitear)/i);
  assert.match(texto, /antes de cada push/i);
  assert.match(texto, /cada pedido/i);
  assert.match(texto, /otra sesión[^\n]*no alcanza/i);
  assert.match(texto, /marker\.js clear[^\n]*después del último push/i);
});
