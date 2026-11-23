#!/usr/bin/env node
'use strict';
// Fila 64: el freno de constancias mira lo escrito en la carpeta, no el comando. Antes de un `git commit` o un `git push`,
// cada constancia nueva del repo tiene que tener la huella que deja `approve` en esta máquina.
// 🔴 Falla con: una constancia escrita a mano (con cualquier comando) que llega al commit o al empuje, la escrita y
//    commiteada en el mismo comando que llega al empuje, un cartel sin salida, o un freno de más sobre lo que vino de
//    main o ya estaba empujado.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '..');
const gate = require(path.join(SCRIPTS, 'on-bash-write-gate.js'));
const huellas = require(path.join(SCRIPTS, 'lib', 'control-change-prints.js'));

const FIRMA = '{"hash":"abc","rules":[{"path":"scripts/x.js","blob":"1111111111111111111111111111111111111111"}],"at":"2026-11-22","by":"dueño"}\n';

function git(dir, ...args) {
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-11-22T10:00:00 +0000', GIT_COMMITTER_DATE: '2026-11-22T10:00:00 +0000' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  return execFileSync('git', ['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
}

// un repo con su origen: main con una constancia vieja, empujado, y una rama de trabajo que sigue a la suya
function corral() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huellas-')));
  const origen = path.join(raiz, 'origen.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origen]);
  const repo = path.join(raiz, 'repo');
  fs.mkdirSync(path.join(repo, '.github', 'control-changes'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.github', 'control-changes', 'vieja.json'), FIRMA.replace('abc', 'vieja'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origen);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'trabajo');
  git(repo, 'push', '-q', '-u', 'origin', 'trabajo');
  const stateDir = path.join(raiz, 'estado');
  fs.mkdirSync(stateDir);
  const correr = (command, cwd = repo) => gate.handle({ tool_name: 'Bash', session_id: 'huellas', cwd, tool_input: { command } }, { stateDir });
  const constancia = (nombre, texto = FIRMA.replace('abc', nombre)) => { fs.writeFileSync(path.join(repo, '.github', 'control-changes', `${nombre}.json`), texto); return texto; };
  return { raiz, repo, stateDir, correr, constancia };
}

test('T1 Commit_ConstanciaEscritaAMano_FrenaYDiceComoSeguir', () => {
  const c = corral();
  c.constancia('nueva');
  const r = c.correr('git add -A && git commit -m x');
  assert.ok(r && r.block, 'frena');
  assert.match(r.block, /CONSTANCIA SIN HUELLA/);
  assert.match(r.block, /\.github\/control-changes\/nueva\.json/);
  assert.match(r.block, /OTRA máquina: empujá desde esa máquina, o firmala de nuevo acá/, 'sin callejón: firmar acá o empujar desde allá');
  assert.match(r.block, /Si no la escribió approve: sacala/);
});

test('T2 Commit_ConLaHuellaDeApprove_Pasa', () => {
  const c = corral();
  const texto = c.constancia('firmada');
  huellas.anotar({ stateDir: c.stateDir, repo: c.repo, archivo: '.github/control-changes/firmada.json', texto });
  assert.strictEqual(c.correr('git add -A && git commit -m x'), null);
});

test('T3 EscritaYCommiteadaEnElMismoComando_FrenaAlEmpujar', () => {
  // el commit en el mismo comando no la ve (todavía no existe al mirar): la ve el empuje, que mira lo que la rama trae
  const c = corral();
  c.constancia('colada');
  git(c.repo, 'add', '-A'); git(c.repo, 'commit', '-q', '-m', 'colada');
  const r = c.correr('git push');
  assert.ok(r && r.block, 'frena el empuje');
  assert.match(r.block, /el empuje lleva .*colada\.json/);
});

test('T4 YaEmpujadaOVenidaDeMain_NoFrena', () => {
  const c = corral();
  // ya empujada en la rama remota (una firma de antes de las huellas): no se pide otra vez
  c.constancia('empujada');
  git(c.repo, 'add', '-A'); git(c.repo, 'commit', '-q', '-m', 'empujada'); git(c.repo, 'push', '-q');
  assert.strictEqual(c.correr('git push'), null, 'ya está igual en la rama remota');
  // la de main, traída con checkout: está igual en origin/main
  fs.rmSync(path.join(c.repo, '.github', 'control-changes', 'vieja.json'));
  git(c.repo, 'commit', '-q', '-am', 'saca la vieja');
  git(c.repo, 'checkout', 'origin/main', '--', '.github/control-changes/vieja.json');
  assert.strictEqual(c.correr('git commit -m x'), null, 'la de main no se pide');
});

test('T5 ConDashC_DesdeOtraCarpeta_Frena', () => {
  const c = corral();
  c.constancia('lejos');
  const r = c.correr(`git -C ${c.repo} commit -am x`, c.raiz);
  assert.ok(r && r.block, 'frena con -C');
  assert.match(r.block, /lejos\.json/);
});

test('T6 RegistroJsonl_RenglonNuevoSinHuella_Frena', () => {
  const c = corral();
  fs.mkdirSync(path.join(c.repo, '.tycon'), { recursive: true });
  fs.writeFileSync(path.join(c.repo, '.tycon', 'control-changes.jsonl'), FIRMA.replace('abc', 'renglon'));
  const r = c.correr('git add -A && git commit -m x');
  assert.ok(r && r.block, 'frena');
  assert.match(r.block, /control-changes\.jsonl/);
  huellas.anotar({ stateDir: c.stateDir, repo: c.repo, archivo: '.tycon/control-changes.jsonl', texto: FIRMA.replace('abc', 'renglon').trim() });
  assert.strictEqual(c.correr('git add -A && git commit -m x'), null, 'con su huella pasa');
});

test('T8 CarpetaDelRepoDeMantenimiento_YDesdeUnaSubcarpeta_Frena', () => {
  // las constancias del repo de mantenimiento viven en .tycon/control-changes/; el comando puede correr en una subcarpeta
  const c = corral();
  fs.mkdirSync(path.join(c.repo, '.tycon', 'control-changes'), { recursive: true });
  fs.writeFileSync(path.join(c.repo, '.tycon', 'control-changes', 'priv.json'), FIRMA.replace('abc', 'priv'));
  fs.mkdirSync(path.join(c.repo, 'docs'));
  const r = c.correr('git commit -am x', path.join(c.repo, 'docs'));
  assert.ok(r && r.block, 'frena');
  assert.match(r.block, /\.tycon\/control-changes\/priv\.json/);
});

// del pase: renombre, índice, otra rama, envolturas y -C sin resolver
test('T9 RenombradaYEditada_FrenaAlEmpujar', () => {
  const c = corral();
  git(c.repo, 'mv', '.github/control-changes/vieja.json', '.github/control-changes/movida.json');
  fs.appendFileSync(path.join(c.repo, '.github/control-changes/movida.json'), '{"forjado":true}\n');
  git(c.repo, 'commit', '-q', '-am', 'mueve');
  const r = c.correr('git push');
  assert.ok(r && r.block, 'frena');
  assert.match(r.block, /movida\.json/);
});

test('T10 ElIndiceSeMira_AgregadaYBorradaDelDisco_Frena', () => {
  const c = corral();
  c.constancia('indice');
  git(c.repo, 'add', '-A');
  fs.rmSync(path.join(c.repo, '.github/control-changes/indice.json'));
  const r = c.correr('git commit -m x');
  assert.ok(r && r.block, 'frena: el índice la lleva');
  assert.match(r.block, /indice\.json/);
});

test('T11 EmpujarOtraRamaOTodas_MiraLoQueSeEmpuja', () => {
  const c = corral();
  git(c.repo, 'checkout', '-q', '-b', 'otra');
  c.constancia('deotra');
  git(c.repo, 'add', '-A'); git(c.repo, 'commit', '-q', '-m', 'otra');
  git(c.repo, 'checkout', '-q', 'trabajo');
  for (const cmd of ['git push origin otra', 'git push origin otra:main', 'git push --all']) {
    const r = c.correr(cmd);
    assert.ok(r && r.block, `frena: ${cmd}`);
    assert.match(r.block, /deotra\.json/);
  }
  assert.strictEqual(c.correr('git push'), null, 'la rama de HEAD está limpia');
});

test('T12 Envolturas_YDashCSinResolver_Frenan', () => {
  const c = corral();
  c.constancia('envuelta');
  for (const cmd of ['bash -c "git commit -am x"', "sh -c 'git add -A && git commit -m x'"]) {
    const r = c.correr(cmd);
    assert.ok(r && r.block, `frena: ${cmd}`);
  }
  const r = c.correr('git -C "$REPO_X" commit -m x');
  assert.ok(r && r.block, 'una carpeta sin resolver frena');
  assert.match(r.block, /no pude resolver la carpeta/);
});

// de la segunda vuelta: lo que no es una rama a empujar no frena, y un comodín o una opción con valor no la esconden
test('T13 Empuje_RedireccionesOpcionesYBorrados_NoFrenanDeMas', () => {
  const c = corral();
  git(c.repo, 'checkout', '-q', '-b', 'sucia');
  c.constancia('sucia');
  git(c.repo, 'add', '-A'); git(c.repo, 'commit', '-q', '-m', 'sucia');
  git(c.repo, 'checkout', '-q', 'trabajo');
  for (const cmd of ['git push origin trabajo 2>&1', 'git push origin trabajo > /tmp/salida.txt', 'git push -o ci.skip origin trabajo',
    'git push origin --delete ya-borrada', 'git push origin :ya-borrada', 'git push --repo=origin trabajo']) {
    assert.strictEqual(c.correr(cmd), null, `no frena: ${cmd}`);
  }
  for (const cmd of ['git push origin refs/heads/*:refs/heads/*', 'git push -o x origin sucia', 'git --namespace n push origin sucia']) {
    const r = c.correr(cmd);
    assert.ok(r && r.block, `frena: ${cmd}`);
  }
});

// T14 a T17 · fila 81 (pase del pedido único #1502), la parte de las constancias: el empuje desde otra carpeta escrito de
// formas que no se leían. Desde la carpeta de arriba del repo, con una constancia sin huella ya commiteada en la rama.
function conConstanciaCommiteada() {
  const c = corral();
  c.constancia('escondida');
  git(c.repo, 'add', '-A'); git(c.repo, 'commit', '-q', '-m', 'escondida');
  return c;
}
const frenaDesdeArriba = (c, cmd) => {
  const r = c.correr(cmd, c.raiz);
  assert.ok(r && r.block, `frena: ${cmd}`);
  assert.match(r.block, /escondida\.json/, cmd);
};

test('T14 Empuje_AdentroDeUnParentesisODeUnGrupo_Frena', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['(cd repo && git push)', '{ cd repo && git push; }', '( cd repo; git push )']) frenaDesdeArriba(c, cmd);
});

test('T15 Empuje_ConDosCdEnCadena_Frena', () => {
  const c = conConstanciaCommiteada();
  fs.mkdirSync(path.join(c.raiz, 'otra'), { recursive: true });
  for (const cmd of ['cd otra && cd ../repo && git push', 'cd repo && cd . && git push', 'cd otra; cd ../repo; git commit -m x; git push']) frenaDesdeArriba(c, cmd);
});

test('T16 Empuje_DestinoConVariableOSustitucion_Frena', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['B=trabajo; cd repo && git push origin "$B"', 'cd repo && git push origin "$(git branch --show-current)"',
    'cd repo && git push origin $B']) frenaDesdeArriba(c, cmd);
});

test('T17 Empuje_WorkTreeAparteHeredocYRenglonPartido_Frena', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of [`git --work-tree ${c.repo} --git-dir ${c.repo}/.git push`, `git --git-dir=${c.repo}/.git push`,
    `bash <<'EOF'\ncd repo && git push\nEOF`, 'cd repo && git \\\n  push']) frenaDesdeArriba(c, cmd);
});

// T18 a T21 · lo que encontró el pase de la fila 81: cd con opciones, env -C con la carpeta aparte, las variables de git,
// --git-dir sin --work-tree (que sigue mirando la carpeta de trabajo), carpetas sin resolver y el tope de carpetas.
test('T18 Empuje_CdConOpcionesEnvCYVariablesDeGit_Frena', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['cd -P repo && git commit -m x && git push', 'cd -- repo && git push', 'cd -L repo; git push',
    'env -C repo git push', 'GIT_DIR=repo/.git GIT_WORK_TREE=repo git push', 'export GIT_DIR=repo/.git; git push']) frenaDesdeArriba(c, cmd);
});

test('T19 Commit_GitDirSinWorkTree_MiraTambienLaCarpetaDeTrabajo', () => {
  // desde el repo con la constancia sin huella, el `.git` de otro: `git add` toma los archivos de acá
  const c = corral();
  c.constancia('aca');
  const otro = path.join(c.raiz, 'otro');
  fs.mkdirSync(otro);
  git(otro, 'init', '-q', '-b', 'main');
  const r = c.correr(`git --git-dir=${otro}/.git add -A && git --git-dir=${otro}/.git commit -m x`);
  assert.ok(r && r.block, 'frena');
  assert.match(r.block, /aca\.json/);
});

test('T20 Empuje_CarpetaSinResolver_FrenaComoGitC', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['cd "$(echo repo)" && git push', 'for d in repo; do cd $d; git push; done', 'git --git-dir="$X/.git" push',
    'git --work-tree $Y push']) {
    const r = c.correr(cmd, c.raiz);
    assert.ok(r && r.block, `frena: ${cmd}`);
    assert.match(r.block, /CONSTANCIA SIN MIRAR|escondida\.json/, cmd);
  }
  // sin commit ni empuje, un cd sin resolver no importa
  assert.strictEqual(c.correr('cd "$(echo repo)" && git status', c.raiz), null);
});

test('T21 Empuje_MuchosCd_FrenaSinTardar', () => {
  const c = conConstanciaCommiteada();
  const cds = Array.from({ length: 200 }, (_, k) => `cd /tmp/no-existe-${k}`).join(' && ');
  // stable-data: el reloj mide cuánto tarda el freno, no da una fecha que se compare
  const desde = Date.now();
  const r = c.correr(`${cds} && git push`, c.raiz);
  assert.ok(Date.now() - desde < 4000, `tardó ${Date.now() - desde} ms`);
  assert.ok(r && r.block, 'con más carpetas que el tope no se sabe dónde corre: frena');
  assert.match(r.block, /CONSTANCIA SIN MIRAR/);
});

// T22 a T25 · lo que encontró la vuelta de regresiones: el empuje adentro de una sustitución después de un cd, el `-c`
// con comillas pegadas y el `-C ""`; y lo que frenaba de más: un cd después del git o en un comentario, y el texto de un
// mensaje de commit que nombra cd o GIT_DIR.
test('T22 Empuje_AdentroDeUnaSustitucionDespuesDeUnCd_Frena', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['cd repo && echo $(git push)', 'cd repo && echo `git push`', 'cd repo; x=$(git push)',
    'cd repo && find . -maxdepth 0 -exec git push \\;']) frenaDesdeArriba(c, cmd);
});

test('T23 Empuje_ConUnaOpcionConComillasPegadasOConCVacio_Frena', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['cd repo && git -c user.name="AB" push', "cd repo && git -c user.name='AB' -c user.email=\"a@b.c\" push",
    'cd repo && git -C "" push']) frenaDesdeArriba(c, cmd);
});

test('T24 CommitLimpio_CdConVariableDespuesOEnUnComentario_Pasa', () => {
  const c = corral();
  for (const cmd of ['git commit --allow-empty -m a; cd $X', 'git push\ncd $X', '# cd $X\ngit push', 'git push && cd "$(pwd)"']) {
    assert.strictEqual(c.correr(cmd), null, cmd);
  }
  // antes del empuje sigue frenando: no se sabe dónde corre
  assert.match(c.correr('cd $X && git push').block, /CONSTANCIA SIN MIRAR/);
});

test('T25 CommitLimpio_ElMensajeNombraCdOGitDir_Pasa', () => {
  const c = corral();
  for (const cmd of ["git commit --allow-empty -m 'cd $X and GIT_DIR=$Y'", "git commit --allow-empty -m \"$(cat <<'EOF'\nfix: cd $X\nGIT_DIR=$Y\nEOF\n)\"",
    'git commit --allow-empty -F - <<EOF\ncd $X\nexport GIT_DIR=$Y\nEOF']) {
    assert.strictEqual(c.correr(cmd), null, cmd);
  }
});

// T26 y T27 · lo que dejó la tercera vuelta (ya pasaba en main): un comentario al final del empuje se tomaba como el
// remoto y su refspec; y un cd con una sustitución sin comillas o con un comodín no se leía como carpeta sin resolver.
test('T26 Empuje_ConUnComentarioAlFinal_Frena', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['cd repo && git push # x', 'git -C repo push # cd otra', 'cd repo && git push --dry-run # nota']) frenaDesdeArriba(c, cmd);
});

test('T27 Empuje_DespuesDeUnCdConSustitucionSinComillasOComodin_FrenaSinMirar', () => {
  const c = conConstanciaCommiteada();
  for (const cmd of ['cd $(echo repo) && git push', 'cd `echo repo` && git push', 'cd $(pwd)/repo && git push', 'cd rep* && git push',
    'cd $(git rev-parse --show-toplevel) && git commit -m x']) {
    const r = c.correr(cmd, c.raiz);
    assert.ok(r && r.block, `frena: ${cmd}`);
    assert.match(r.block, /CONSTANCIA SIN MIRAR/, cmd);
  }
});

test('T7 SinConstanciasNuevas_OComandosQueNoSonCommitNiPush_ComoAntes', () => {
  const c = corral();
  assert.strictEqual(c.correr('git commit -m x'), null);
  assert.strictEqual(c.correr('git push'), null);
  c.constancia('suelta');
  assert.strictEqual(c.correr('git status'), null, 'mirar no frena');
  assert.strictEqual(c.correr('echo commit push'), null, 'no es git');
});
