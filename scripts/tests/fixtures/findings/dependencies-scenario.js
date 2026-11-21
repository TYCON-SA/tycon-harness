// Una noche de dependencias de mentira para las pruebas del ciclo de la ficha: las fichas que hay antes
// y lo que midió la noche. Sin nombres reales: repos «acme», «globex» e «initech»; paquetes públicos cualquiera.
//
// `armar(dir)` deja las fichas en `dir/{pending,promoted,archived}`; `snapshot` y `cfg` son lo que la vigilancia
// recibe. Las fichas que salen con N=1 están en `dependencies-expected/` (las escribió el código de antes de la
// extracción): con las mismas entradas, la pieza común tiene que dejarlas igual, byte a byte.

const fs = require('fs');
const path = require('path');

const PIE = [
  '# Qué decidir: se arregla (subir el paquete) o se declara como deuda en el',
  '# pending-vulnerabilities.json del repo, con motivo y fecha de revisión.',
  '# Lo que NO se decide vuelve a aparecer todas las noches, y a los 7 días',
  "# se archiva como 'ignorado' — que cuenta PEOR que descartado con motivo.",
  '',
];

const ficha = (lineas) => [...lineas, ...PIE].join('\n');

const FICHAS = {
  // pendiente que dejó de aparecer en su único repo, medido
  'pending/aaaa1111.yaml': ficha(['id: aaaa1111', 'detectado: 2026-10-10', 'veredicto: pendiente', 'paquete: lodash',
    'severidad: high', 'noches: 3', 'ids:', '  - aaaa1111', 'repos:', '  - acme/acme', 'avisos:', '  - https://x/GHSA-aaaa']),
  // pendiente que sigue apareciendo sin declarar
  'pending/bbbb2222.yaml': ficha(['id: bbbb2222', 'detectado: 2026-10-11', 'veredicto: pendiente', 'paquete: minimist',
    'severidad: high', 'noches: 2', 'ids:', '  - bbbb2222', 'repos:', '  - acme/acme', 'avisos:', '  - https://x/GHSA-bbbb']),
  // aceptada que hoy está declarada como deuda en todos sus repos
  'promoted/cccc3333.yaml': ficha(['id: cccc3333', 'detectado: 2026-10-09', 'veredicto: util', 'paquete: qs',
    'severidad: high', 'noches: 5', 'pr: 101', 'ids:', '  - cccc3333', 'repos:', '  - globex/globex', 'avisos:',
    '  - https://x/GHSA-cccc']),
  // cerrada por deuda que vuelve a aparecer sin declarar
  'archived/dddd4444.yaml': ficha(['id: dddd4444', 'detectado: 2026-10-01', 'veredicto: descartado', 'paquete: ws',
    'severidad: high', 'noches: 4', 'descartado: 2026-10-05', 'motivo: "declarada como deuda en acme/acme (vence 2026-10-20)"',
    'ids:', '  - dddd4444', 'declarada_en:', '  - acme/acme (vence 2026-10-20)', 'avisos:', '  - https://x/GHSA-dddd']),
  // aceptada ya resuelta antes del cambio, que sigue sin aparecer: no se toca
  'promoted/eeee5555.yaml': ficha(['id: eeee5555', 'detectado: 2026-10-02', 'veredicto: util', 'paquete: y18n',
    'severidad: high', 'noches: 2', 'pr: 99', 'resuelto: 2026-10-08',
    'motivo: "la vulnerabilidad dejó de aparecer en todos sus repos, medidos esta noche"', 'ids:', '  - eeee5555',
    'repos:', '  - acme/acme', 'avisos:', '  - https://x/GHSA-eeee']),
  // pendiente en un repo que esta noche no se midió: no se decide nada
  'pending/hhhh8888.yaml': ficha(['id: hhhh8888', 'detectado: 2026-10-12', 'veredicto: pendiente', 'paquete: semver',
    'severidad: high', 'noches: 1', 'ids:', '  - hhhh8888', 'repos:', '  - initech/initech', 'avisos:',
    '  - https://x/GHSA-hhhh']),
};

const HOY = '2026-10-20';

const cfg = { repos: [
  { producto: 'acme', ruta: 'acme', tipo: 'npm', activo: true },
  { producto: 'globex', ruta: 'globex', tipo: 'npm', activo: true },
  { producto: 'initech', ruta: 'initech', tipo: 'npm', activo: true },
] };

const snapshot = {
  fecha: HOY,
  repos: [
    { producto: 'acme', ruta: 'acme', medido: true },
    { producto: 'globex', ruta: 'globex', medido: true },
    { producto: 'initech', ruta: 'initech', medido: false },
  ],
  hallazgos: [{ id: 'bbbb2222', noches: 3 }, { id: 'dddd4444', noches: 1 }],
  presencias: [
    { id: 'bbbb2222', paquete: 'minimist', repos: [{ repo: 'acme/acme', declarada: false }] },
    { id: 'cccc3333', paquete: 'qs', repos: [{ repo: 'globex/globex', declarada: true, vence: '2026-12-01' }] },
    { id: 'dddd4444', paquete: 'ws', repos: [{ repo: 'acme/acme', declarada: false }] },
  ],
};

function armar(dir) {
  for (const [rel, txt] of Object.entries(FICHAS)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, txt);
  }
}

/** Todas las fichas de `dir` como { 'carpeta/archivo': texto }, ordenadas. */
function foto(dir) {
  const out = {};
  for (const c of ['pending', 'promoted', 'archived']) {
    const d = path.join(dir, c);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).sort()) out[`${c}/${f}`] = fs.readFileSync(path.join(d, f), 'utf8');
  }
  return out;
}

module.exports = { FICHAS, HOY, cfg, snapshot, armar, foto };
