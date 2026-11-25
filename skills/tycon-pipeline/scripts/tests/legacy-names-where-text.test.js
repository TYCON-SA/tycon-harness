'use strict';
// El instalador apila la capa del equipo sólo si cada opción o subcomando renombrado de su mapa de renombres tiene el
// nombre nuevo entero en el texto del archivo de su `where` o de sus partes de lib/ (renamesProblems de
// scripts/setup/harness/team.js). Esta prueba lo busca como subcadena y sólo en el `where`: es más floja que el instalador.
// El `where` es también la llave con que el guion traduce los nombres viejos (aliasArgv), así que no se mueve cuando el
// guion se parte en lib/: si el nombre nuevo queda sólo en las partes, la versión no se instala en ninguna máquina del
// equipo. Esta prueba aplica la misma regla a la tabla propia del arnés (OWN_ARGS de lib/legacy-names.js), que nombra los
// mismos guiones.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const { OWN_ARGS } = require(path.join(__dirname, '..', 'lib', 'legacy-names.js'));

/** Los nombres nuevos de cada `where` que el instalador busca en su texto: `[{ where, kind, name }]`. */
function nombresNuevos(tabla) {
  const out = [];
  for (const [where, porTipo] of Object.entries(tabla)) {
    for (const kind of ['option', 'subcommand']) {
      for (const nuevo of Object.values((porTipo && porTipo[kind]) || {})) out.push({ where, kind, name: String(nuevo).replace(/^-+/, '') });
    }
  }
  return out;
}

/** Los que faltan en el texto de su archivo, para los archivos que trae el árbol. */
function faltantes(raiz, tabla) {
  const faltan = [];
  for (const { where, kind, name } of nombresNuevos(tabla)) {
    const archivo = path.join(raiz, ...where.split('/'));
    if (!fs.existsSync(archivo)) continue;
    if (!fs.readFileSync(archivo, 'utf8').includes(name)) faltan.push(`${where}: ${kind} ${name}`);
  }
  return faltan;
}

// 🔴 Falla con: un guion partido en lib/ cuyo despachador ya no nombra una opción o un subcomando renombrado (la capa del
// equipo deja de instalarse con «el nombre nuevo … no está en … de la versión»).
test('LegacyNames_OwnArgs_NewNameInWhereText — cada nombre nuevo de OWN_ARGS está en el texto de su archivo', () => {
  const lista = nombresNuevos(OWN_ARGS);
  assert.ok(lista.some((x) => x.where.endsWith('/pipeline.js') && x.name === 'marks'), 'la tabla nombra --marks de pipeline.js');
  assert.deepStrictEqual(faltantes(ROOT, OWN_ARGS), [], 'el instalador no apilaría la capa del equipo con estos nombres');
});

// La regla ve lo que tiene que ver: un despachador que perdió el nombre sale en la lista.
test('LegacyNames_OwnArgs_DetectsMissingName — un archivo sin el nombre nuevo sale como faltante', (t) => {
  const raiz = fs.mkdtempSync(path.join(require('os').tmpdir(), 'where-text-'));
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  fs.mkdirSync(path.join(raiz, 'skills', 'x'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'skills', 'x', 'd.js'), "require('./lib/legacy-names.js').aliasArgv('skills/x/d.js'); // --brief\n");
  const tabla = { 'skills/x/d.js': { option: { breve: 'brief', marcas: 'marks' } }, 'skills/x/no-esta.js': { option: { a: 'b' } } };
  assert.deepStrictEqual(faltantes(raiz, tabla), ['skills/x/d.js: option marks']);
});
