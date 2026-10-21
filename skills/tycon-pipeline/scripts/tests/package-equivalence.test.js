'use strict';

/**
 * package-equivalence.test.js — el equipo no nota el paso a paquetes de revisores.
 *
 * Cada caso armado de `lib/equivalence-cases.js` recorre una rama de la matriz que el pipeline
 * tenía escrita en su código antes de pasar a paquetes (sólo .cs; .tsx con React, con Next y sin
 * framework; los dos juntos; sólo config de plugin; dependencia nueva; .sh; secretos; plugin
 * Bizuit; .tsx + plugin.json; y los que trae cada paquete en su carpeta). Se corre el pipeline NUEVO con los paquetes reales
 * instalados y se compara, caso por caso, contra la **foto dorada** que
 * `package-equivalence.js snapshot --base <sha>` tomó del `pipeline.js` de `main` antes del paso a paquetes.
 *
 * Por qué una foto y no correr el viejo acá: esa versión ya no existe en ningún
 * checkout, y la prueba tiene que seguir valiendo. La foto lleva el sha adentro; regenerarla es
 * una decisión explícita (`foto --base <sha>`), no un efecto de correr la suite.
 *
 * Una sola diferencia es un rojo, no una tolerancia.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SCRIPTS, '..', '..', '..');
const PIPELINE = path.join(SCRIPTS, 'pipeline.js');
const PACKS_REALES = path.join(RAIZ, 'packs');
const FOTO = path.join(__dirname, 'fixtures', 'equivalence-main.json');
const HOME_AISLADO = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-home-'));

const { CASOS, medir, sinOrden, casosDePaquetes, leerFoto } = require('../lib/equivalence-cases.js');
const { SKIP_PUBLIC, absentReviewers } = require('./lib/public-copy.js');

/** Los revisores que nombra la foto de un caso (en cualquiera de sus tres grupos). */
const revisoresDe = (f) => [...new Set([...(f.base || []), ...(f.completitud || []), ...(f.conditional || [])])];

// Un paquete trae sus propios casos y su foto en su carpeta. La foto que viaja no nombra
// ningún caso de paquete; el repo del equipo los mide igual, y donde el paquete no está sus casos no existen.
test('Equivalencia_PackCases_ComeFromThePackFolderWithTheirOwnPhoto', () => {
  const packs = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-packs-'));
  fs.mkdirSync(path.join(packs, 'prueba'));
  fs.mkdirSync(path.join(packs, 'sin-casos'));
  fs.writeFileSync(path.join(packs, 'prueba', 'equivalence-cases.js'),
    "module.exports = ({ base, agregar, TS }) => [{ nombre: 'ruta-de-prueba', armar(d) { base(d, { 'src/tienda/a.ts': TS }); agregar(d, 'src/tienda/a.ts', 'export const b = 2;\\n'); return { files: ['src/tienda/a.ts'] }; } }];\n");
  fs.writeFileSync(path.join(packs, 'prueba', 'equivalence-main.json'), JSON.stringify({ base_sha: 'a'.repeat(40), casos: { 'ruta-de-prueba': { base: ['rev-de-prueba'] } } }));
  const delPaquete = casosDePaquetes(packs);
  assert.deepEqual(delPaquete.map((c) => [c.nombre, c.paquete]), [['ruta-de-prueba', 'prueba']], 'el caso sale de la carpeta del paquete, con su paquete');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-pack-caso-'));
  assert.deepEqual(delPaquete[0].armar(dir), { files: ['src/tienda/a.ts'] }, 'el caso se arma con las piezas del núcleo');
  // la foto entera = la que viaja + la de cada paquete con casos
  const publica = path.join(packs, 'publica.json');
  fs.writeFileSync(publica, JSON.stringify({ base_sha: 'a'.repeat(40), tomada_en: 'hoy', casos: { 'solo-cs': { base: ['x'] } } }));
  const entera = leerFoto(publica, delPaquete);
  assert.deepEqual(Object.keys(entera.casos).sort(), ['ruta-de-prueba', 'solo-cs']);
  assert.equal(entera.base_sha, 'a'.repeat(40), 'los datos de la foto que viaja se conservan');
  // un caso en las dos fotos es un error, no «gana una»
  fs.writeFileSync(publica, JSON.stringify({ base_sha: 'a'.repeat(40), tomada_en: 'hoy', casos: { 'ruta-de-prueba': {} } }));
  assert.throws(() => leerFoto(publica, delPaquete), /ruta-de-prueba.*en la foto que viaja y en la de un paquete/);
  // la foto de un paquete que no se deja leer es un error, no «sin casos»
  fs.writeFileSync(path.join(packs, 'prueba', 'equivalence-main.json'), '{ roto');
  fs.writeFileSync(publica, JSON.stringify({ casos: {} }));
  assert.throws(() => leerFoto(publica, delPaquete), /no se deja leer/);
  // un archivo de casos que no exporta la función es un error con su ruta
  fs.writeFileSync(path.join(packs, 'prueba', 'equivalence-cases.js'), 'module.exports = [];\n');
  delete require.cache[require.resolve(path.join(packs, 'prueba', 'equivalence-cases.js'))];
  assert.throws(() => casosDePaquetes(packs), /equivalence-cases\.js.*función/);
  // sin carpeta de paquetes no hay casos de paquete (la copia de un núcleo sin paquetes)
  assert.deepEqual(casosDePaquetes(path.join(packs, 'no-existe')), []);
});

// `snapshot --out <otra ruta>` es una foto de ENSAYO y no puede pisar la foto dorada
// de un paquete (`--out` redirige todo lo que el comando escribe); y dos fotos tomadas de bases
// distintas no se comparan como si fueran una.
test('Equivalencia_SnapshotOut_KeepsTrialPhotosAwayFromThePack', () => {
  const { destinoDeFoto } = require('../lib/equivalence-cases.js');
  const dorada = path.join(SCRIPTS, 'tests', 'fixtures', 'equivalence-main.json');
  const delPaquete = { nombre: 'ruta-de-prueba', paquete: 'prueba', foto: path.join('/packs', 'prueba', 'equivalence-main.json') };
  const delNucleo = { nombre: 'solo-cs' };
  // la foto de siempre: cada cosa a su lugar
  assert.equal(destinoDeFoto(delNucleo, dorada, dorada), dorada);
  assert.equal(destinoDeFoto(delPaquete, dorada, dorada), delPaquete.foto);
  // una foto de ensayo: TODO al lado de --out, nada sobre el paquete
  const ensayo = path.join(os.tmpdir(), 'ensayo', 'foto.json');
  assert.equal(destinoDeFoto(delNucleo, ensayo, dorada), ensayo);
  assert.equal(destinoDeFoto(delPaquete, ensayo, dorada), path.join(os.tmpdir(), 'ensayo', 'foto.prueba.json'));
  // la misma ruta dorada escrita de otra forma sigue siendo la dorada
  assert.equal(destinoDeFoto(delPaquete, path.join(SCRIPTS, 'tests', '..', 'tests', 'fixtures', 'equivalence-main.json'), dorada), delPaquete.foto);
});

test('Equivalencia_PhotosFromDifferentBases_AreNotMerged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-bases-'));
  const publica = path.join(dir, 'publica.json');
  const delPaquete = path.join(dir, 'paquete.json');
  fs.writeFileSync(publica, JSON.stringify({ base_sha: 'a'.repeat(40), casos: { uno: {} } }));
  fs.writeFileSync(delPaquete, JSON.stringify({ base_sha: 'b'.repeat(40), casos: { dos: {} } }));
  assert.throws(() => leerFoto(publica, [{ nombre: 'dos', paquete: 'prueba', foto: delPaquete }]), /bases distintas/);
  fs.writeFileSync(delPaquete, JSON.stringify({ base_sha: 'a'.repeat(40), casos: { dos: {} } }));
  assert.deepEqual(Object.keys(leerFoto(publica, [{ nombre: 'dos', paquete: 'prueba', foto: delPaquete }]).casos).sort(), ['dos', 'uno']);
  // un caso de paquete que su foto no trae es un error con nombre: no se compara contra `undefined`
  assert.throws(() => leerFoto(publica, [{ nombre: 'tres', paquete: 'prueba', foto: delPaquete }]), /«tres».*no está en la foto/);
});

test('Equivalencia_PublicPhoto_HoldsNoPackCase — la foto que viaja no trae los casos de ningún paquete', (t) => {
  const publica = JSON.parse(fs.readFileSync(FOTO, 'utf8'));
  const dePaquete = CASOS.filter((c) => c.paquete).map((c) => c.nombre);
  assert.deepEqual(Object.keys(publica.casos).filter((n) => dePaquete.includes(n)), [], 'un caso de paquete quedó en la foto que viaja');
  assert.deepEqual(Object.keys(publica.casos).sort(), CASOS.filter((c) => !c.paquete).map((c) => c.nombre).sort(),
    'la foto que viaja cubre exactamente los casos del núcleo');
  // Cada paquete instalado que trae su archivo de casos aporta al menos uno: un archivo que se carga y no aporta nada es
  // un rojo, no «sin casos». Cuántos trae cada uno lo dice su archivo, no un número escrito acá (un «al menos 2» fijo
  // es contar a mano los casos de un paquete privado, y sacar ese paquete o sus casos pondría rojo este caso).
  const conArchivo = fs.readdirSync(PACKS_REALES).filter((p) => fs.existsSync(path.join(PACKS_REALES, p, 'equivalence-cases.js'))).sort();
  for (const p of conArchivo) {
    assert.ok(CASOS.some((c) => c.paquete === p), `el paquete ${p} trae equivalence-cases.js y no aportó ningún caso`);
  }
  if (!conArchivo.length) t.diagnostic(`ningún paquete instalado trae casos de equivalencia${SKIP_PUBLIC ? ` (${SKIP_PUBLIC})` : ''}: no hay casos de paquete que medir`);
});

let foto = null;
test('la foto dorada existe, viene de main y cubre todos los casos', () => {
  foto = leerFoto(FOTO);
  assert.match(foto.base_sha, /^[0-9a-f]{40}$/, 'sha del pipeline.js de main del que se tomó la foto');
  assert.ok(foto.tomada_en, 'fecha de la foto');
  const nombres = CASOS.map((c) => c.nombre).sort();
  assert.deepEqual(Object.keys(foto.casos).sort(), nombres, 'la foto cubre exactamente los casos de hoy');
});

// Una TYCON_PACKS_DEFAULT de sólo espacios es «sin poner» para el cargador; medir() la tiene que tratar igual y
// declarar el default de la foto, no pasarla tal cual (sin arnés el cargador saldría 2).
test('Equivalencia_PacksDefaultBlank_TreatedAsUnset', (t) => {
  // la foto del primer caso nombra revisores de los paquetes del equipo: sin ellos (la copia pública) no se mide
  if (SKIP_PUBLIC) { t.skip(`${SKIP_PUBLIC}: la foto nombra revisores de los paquetes del equipo — NO MEDIDO acá, se mide en el repo del equipo`); return; }
  const antes = process.env.TYCON_PACKS_DEFAULT;
  process.env.TYCON_PACKS_DEFAULT = '   ';
  try {
    const caso = CASOS[0];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-blank-'));
    const { files } = caso.armar(dir);
    const r = medir({ pipeline: PIPELINE, repo: dir, files,
      env: { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-blank-home-')), TYCON_SESSION_ID: 'equivalencia-blank', TYCON_PACKS_DIR: PACKS_REALES } });
    const dorada = foto || leerFoto(FOTO);
    assert.deepEqual(sinOrden(r), dorada.casos[caso.nombre], 'con la variable en blanco, el mismo set que la foto (todos los paquetes)');
  } finally {
    if (antes === undefined) delete process.env.TYCON_PACKS_DEFAULT; else process.env.TYCON_PACKS_DEFAULT = antes;
  }
});

test('Equivalencia_ReposRootExplicito_NoDeduceLaRaiz — con --repos-root el informe no le pide la raíz al arnés: el default es perezoso', () => {
  // El default de `--repos-root` no se evalúa ANTES de mirar el flag (semántica de argumentos de JS): si no, frenaría
  // con «sin raíz de repos» aunque la raíz viniera en la línea de comandos. Acá NO hay arnés que consultar (HOME aislado
  // sin el enlace, sin TYCON_GUIDES_DIR ni TCG): si se dedujera, saldría 2 con ese mensaje.
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-repos-root-'));
  const out = path.join(vacio, 'informe.md');
  const r = require('child_process').spawnSync(process.execPath,
    [path.join(SCRIPTS, 'package-equivalence.js'), 'report', '--base', 'HEAD', '--commits', '1', '--repos-root', vacio, '--out', out], {
      encoding: 'utf8', timeout: 300000,
      // Sin arnés que consultar, el default de los paquetes lo da la variable (que manda sobre todo)
      env: { PATH: process.env.PATH, HOME: HOME_AISLADO, TYCON_SESSION_ID: 'equivalencia-test', TYCON_PACKS_DIR: PACKS_REALES, TYCON_PACKS_DEFAULT: 'all' },
    });
  assert.doesNotMatch((r.stderr || '') + (r.stdout || ''), /sin raíz de repos/, 'no dedujo la raíz: la pasaron');
  assert.notEqual(r.status, 2, `no frena por la raíz (rc ${r.status}): ${(r.stderr || '').slice(0, 300)}`);
  assert.ok(fs.existsSync(out), 'el informe se escribió');
});

for (const caso of CASOS) {
  test(`Equivalencia_CasosArmados_MismoSetSuperficieYModelo · ${caso.nombre}`, (t) => {
    assert.ok(foto, 'la foto se leyó');
    // La foto de algunos casos nombra a un revisor del paquete de clientes, que la copia pública no
    // trae (ni el manifiesto ni la definición). Ese caso no se puede comparar afuera: se saltea DICIÉNDOLO. En el repo
    // del equipo `absentReviewers()` es siempre [] y el caso se mide entero. (Al que no viaja se lo reconoce porque le
    // falta su definición, no por una lista de nombres.)
    const queNoViajan = absentReviewers(revisoresDe(foto.casos[caso.nombre]));
    if (queNoViajan.length) {
      t.skip(`${SKIP_PUBLIC}: la foto de este caso nombra a ${queNoViajan.join(' y ')}, que no viaja${queNoViajan.length > 1 ? 'n' : ''} — NO MEDIDO acá, se mide en el repo del equipo`);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-caso-'));
    const { files } = caso.armar(dir);
    const nuevo = medir({
      pipeline: PIPELINE, repo: dir, files,
      env: { HOME: HOME_AISLADO, TYCON_SESSION_ID: 'equivalencia-test', TYCON_PACKS_DIR: PACKS_REALES },
    });
    // el orden no es contrato (check-count y el marker comparan conjuntos): se compara sin él
    assert.deepEqual(sinOrden(nuevo), foto.casos[caso.nombre]);
  });
}
