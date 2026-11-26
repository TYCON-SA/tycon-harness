'use strict';
/**
 * signed-record-approval-paths.test.js — los seis caminos por los que una constancia se escribe sin pasar por el freno
 * de escrituras dan rojo en la CI.
 *
 * Cada camino se corre de verdad con `bash -c` en un repo de juguete, sin el freno: un guion de shell guardado afuera,
 * un comodín en el nombre del destino, la copia de una carpeta entera, un enlace duro, el `Move to` de un parche de Codex
 * (lo que deja en el árbol) y una ruta armada que el freno no resuelve. Después del commit, el portón en `freno` da
 * `constancia-sin-cuadro`, sea cual sea el camino. Una línea escrita con el registro de una aprobación pasa. Esto prueba
 * la CI sola: que el freno cierre cada camino lo prueban sus propias pruebas. Casa temporal, sin red.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

// la casa es temporal antes de cargar nada del arnés: ninguna prueba lee ni escribe la de la persona
const CASA = fs.mkdtempSync(path.join(os.tmpdir(), 'cuadro-caminos-casa-'));
process.env.HOME = CASA;
process.env.USERPROFILE = CASA;
for (const v of ['TYCON_HOME', 'XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'TYCON_CI_BASE']) delete process.env[v];
process.on('exit', () => fs.rmSync(CASA, { recursive: true, force: true }));

const RAIZ = path.join(__dirname, '..', '..');
const SRA = require(path.join(RAIZ, 'scripts', 'lib', 'signed-record-approval.js'));
const gate = require(path.join(RAIZ, 'scripts', 'ci', 'tycon-ci-gate.js'));

const FECHA = '2026-11-25T10:00:00Z';
const hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const EXENCIONES = '.tycon/exemptions.jsonl';
const CAMBIOS = '.tycon/control-changes.jsonl';
const LINEA = {
  [EXENCIONES]: (n) => ({ story: `9.${n}`, campo: 'advisors_exempt', archivo: `specs/story-9.${n}-algo.md`, via: 'ventana', sesion: 's', ts: FECHA }),
  [CAMBIOS]: (n) => ({ hash: hex(`cambio-${n}`), rules: [{ path: 'scripts/ci/x.js', blob: hex(`blob-${n}`).slice(0, 40) }], at: FECHA, by: 'persona' }),
};
const FIRMA = { [EXENCIONES]: 'advisors_exempt', [CAMBIOS]: 'control-change' };
const ENV = () => ({ ...process.env, GIT_AUTHOR_DATE: FECHA, GIT_COMMITTER_DATE: FECHA, GIT_CONFIG_NOSYSTEM: '1' });
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Un repo con una línea vieja en cada constancia; `afuera` es una carpeta fuera del repo para los guiones y las copias. */
function repo(t) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'cuadro-caminos-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const dir = path.join(raiz, 'repo');
  const afuera = path.join(raiz, 'afuera');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(afuera, { recursive: true });
  const git = (...a) => execFileSync('git', ['-c', 'user.email=lab@example.invalid', '-c', 'user.name=lab', '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0', ...a], { cwd: dir, stdio: 'pipe', encoding: 'utf8', env: ENV() });
  const base = {};
  for (const rel of [EXENCIONES, CAMBIOS]) base[rel] = `${JSON.stringify(LINEA[rel](1))}\n`;
  for (const [rel, txt] of Object.entries({ 'README.md': 'x\n', 'notas.txt': 'notas\n', ...base })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  git('init', '-q', '-b', 'main', '.');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { raiz, dir, afuera, git, base: git('rev-parse', 'HEAD').trim(), viejo: base };
}

/** Corre el camino con bash en el repo, sin el freno, y commitea lo que dejó. */
function correr(r, comando) {
  const p = spawnSync('bash', ['-c', comando], { cwd: r.dir, encoding: 'utf8', env: ENV() });
  assert.strictEqual(p.status, 0, `bash -c ${comando}: ${p.stderr}`);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'camino');
}

function enFreno(r) {
  const antes = SRA.MODO;
  SRA.MODO = 'freno';
  try { return gate.revisar({ repo: r.dir, base: r.base, staged: false, hoy: '2026-11-25' }); } finally { SRA.MODO = antes; }
}

/**
 * Los caminos del freno, cada uno con la forma de comando que deja la línea nueva en `rel`. `prep` arma antes lo que el
 * camino necesita: el guion afuera, la carpeta de origen, el archivo que el parche mueve.
 */
function caminos(rel) {
  const nombre = path.posix.basename(rel);
  const carpeta = path.posix.dirname(rel);
  const fila = (r) => JSON.stringify(LINEA[rel](2));
  const conLaNueva = (r) => `${r.viejo[rel]}${fila(r)}\n`;
  const guion = (r) => {
    const g = path.join(r.afuera, 'g.sh');
    fs.writeFileSync(g, `#!/bin/sh\necho ${q(fila(r))} >> ${rel}\n`);
    fs.chmodSync(g, 0o755);
    return g;
  };
  const deUnaCopia = (r) => {
    const x = path.join(r.afuera, 'x');
    fs.writeFileSync(x, conLaNueva(r));
    return x;
  };
  return [
    ['1 guion de shell con sh', (r) => `sh ${q(guion(r))}`],
    ['1 guion de shell con bash', (r) => `bash ${q(guion(r))}`],
    ['1 guion de shell con .', (r) => `. ${q(guion(r))}`],
    ['1 guion de shell con source', (r) => `source ${q(guion(r))}`],
    ['1 guion de shell detrás de env', (r) => `env bash ${q(guion(r))}`],
    ['1 guion de shell corrido como programa', (r) => q(guion(r))],
    ['1 guion de shell por la entrada', (r) => `sh < ${q(guion(r))}`],
    ['1 guion de shell por la entrada con bash -s', (r) => `bash -s < ${q(guion(r))}`],
    ['2 comodín en el nombre', (r) => `echo ${q(fila(r))} >> ${carpeta}/${nombre.slice(0, 6)}*.jsonl`],
    ['2 corchetes en el nombre', (r) => `echo ${q(fila(r))} >> ${carpeta}/${nombre.replace(/l$/, '[l]')}`],
    ['2 comodín después de cd', (r) => `cd ${carpeta}; echo ${q(fila(r))} >> ${nombre.slice(0, 6)}*`],
    ['3 copia de la carpeta entera', (r) => {
      const origen = path.join(r.afuera, 'src', carpeta);
      fs.mkdirSync(origen, { recursive: true });
      for (const [otro, txt] of Object.entries(r.viejo)) if (path.posix.dirname(otro) === carpeta) fs.writeFileSync(path.join(origen, path.posix.basename(otro)), txt);
      fs.writeFileSync(path.join(origen, nombre), conLaNueva(r));
      return `cp -R ${q(origen)} .`;
    }],
    ['4 enlace duro', (r) => `ln ${rel} h.jsonl && echo ${q(fila(r))} >> h.jsonl && rm h.jsonl`],
    ['5 Move to de un parche de Codex', (r) => {
      // el parche actualiza notas.txt y lo mueve a la constancia: en el árbol queda la constancia con la línea nueva
      fs.writeFileSync(path.join(r.dir, 'notas.txt'), conLaNueva(r));
      return `mv notas.txt ${rel}`;
    }],
    ['6 comodín en la carpeta', (r) => `echo ${q(fila(r))} >> .ty*/${nombre}`],
    ['6 comodín en la carpeta con .tycon*', (r) => `echo ${q(fila(r))} >> .tycon*/${nombre}`],
    ['6 comillas invertidas', (r) => `echo ${q(fila(r))} >> \`echo .tycon\`/${nombre}`],
    ['6 una variable armada antes', (r) => `D=$(echo .tycon); echo ${q(fila(r))} >> $D/${nombre}`],
    ['6 tee a una ruta con $()', (r) => `echo ${q(fila(r))} | tee -a $(echo .tycon)/${nombre} > /dev/null`],
    ['6 cp a una ruta con $()', (r) => `cp ${q(deUnaCopia(r))} $(echo .tycon)/${nombre}`],
  ];
}

test('T21 CI_LosSeisCaminos_Rojo: cada camino corrido de verdad deja una línea sin cuadro, y el portón en freno la frena', (t) => {
  const casos = [
    ...caminos(EXENCIONES).map(([n, c]) => [EXENCIONES, n, c]),
    // el camino 6 da lo mismo con el registro de los cambios de control
    ...caminos(CAMBIOS).filter(([n]) => n.startsWith('6 ')).map(([n, c]) => [CAMBIOS, n, c]),
  ];
  const vistos = new Set();
  for (const [rel, nombre, armar] of casos) {
    const r = repo(t);
    correr(r, armar(r));
    // el camino escribió de verdad: la línea nueva está, y las viejas siguen
    const ahora = fs.readFileSync(path.join(r.dir, rel), 'utf8');
    assert.ok(ahora.startsWith(r.viejo[rel]) && ahora.includes(JSON.stringify(LINEA[rel](2))), `${nombre} (${rel}) no escribió la línea: ${ahora}`);
    const res = enFreno(r);
    const dichos = res.hallazgos.filter((h) => h.regla === gate.REGLA_DEL_CUADRO);
    assert.deepStrictEqual(dichos.map((h) => [h.archivo, h.linea]), [[rel, 2]], `${nombre} (${rel}): ${JSON.stringify(res.hallazgos)}`);
    assert.match(dichos[0].mensaje, /no trae el cuadro del dueño/);
    vistos.add(nombre.slice(0, 1));
  }
  assert.deepStrictEqual([...vistos].sort(), ['1', '2', '3', '4', '5', '6'], 'los seis caminos');

  // la misma línea escrita por el escritor, con el registro de una aprobación, pasa por cualquier camino
  for (const rel of [EXENCIONES, CAMBIOS]) {
    const r = repo(t);
    const aprobada = SRA.conCuadro(LINEA[rel](2), SRA.aprobacionDe({ codigo: 0, via: 'click', registro: { aprobacion: hex(`ok-${rel}`), aprobada_en: FECHA } }, FIRMA[rel]));
    correr(r, `D=$(echo .tycon); echo ${q(JSON.stringify(aprobada))} >> $D/${path.posix.basename(rel)}`);
    const res = enFreno(r);
    assert.deepStrictEqual(res.hallazgos.filter((h) => h.regla === gate.REGLA_DEL_CUADRO), [], `${rel}: ${JSON.stringify(res.hallazgos)}`);
  }
});
