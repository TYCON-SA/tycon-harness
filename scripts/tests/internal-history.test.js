'use strict';
// internal-history.test.js — lo publicado no cuenta la historia interna con números de pull request (story 8.10.3,
// tanda B, AC 10 · T10).
//
// POR QUÉ EXISTE: la copia pública traía un centenar de números de pull request del repo del equipo —en comentarios de
// «caso disparador», en guías, en pruebas—. Desde afuera no llevan a nada: son ruido para quien no conoce la historia.
// Se reescribieron dejando la lección sin el número. Un número que una prueba usa como DATO (el título de un commit que
// un control tiene que reconocer, un comando de laboratorio) queda, declarado con su archivo, el valor EXACTO y el motivo
// en `fixtures/internal-history-allowed.json` — nunca un archivo entero.
//
// Qué fija:
//   · ningún archivo publicado trae un número fuera de esa lista (la expresión es la de la medición de la story);
//   · cada entrada de la lista sigue apareciendo donde dice (una declaración que ya no hace falta, sale).
// Corre en el repo y en la copia. En el repo, «publicado» es la lista blanca resuelta por el exportador (`whatShips`,
// paquetes públicos) y se lee el archivo del disco; en la copia, todo archivo de la copia. Cuál de los dos es se sabe
// por la tabla privada de reemplazos, que nunca viaja.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const LISTA = 'scripts/tests/fixtures/internal-history-allowed.json';
// La expresión de la medición de la story, más las formas que el pase de revisión encontró sueltas (spec-first de la
// tanda B): el plural, «de prueba» en el medio, y el «!» con que Azure DevOps nombra un pull request. Vive en un solo
// lugar desde la story 8.26 (tanda G1): la forma `pr-number` del control de historia interna, que mira la prosa al
// commitear; así las dos redes ven lo mismo.
const NUMERO_DE_PR = require('../publishing/internal-history.js').FORMS['pr-number'].re;
const EN_EL_REPO = fs.existsSync(path.join(RAIZ, 'scripts', 'publishing', 'replacements.json'));

function publicados() {
  if (!EN_EL_REPO) {
    const out = [];
    (function walk(dir, base) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel);
        else if (e.isFile()) out.push(rel);
      }
    })(RAIZ, '');
    return out;
  }
  const ex = require('../publishing/export.js');
  const ctx = { repos: { arnes: { dir: RAIZ }, 'agent-skills': { dir: RAIZ } } };
  const base = path.join(RAIZ, 'scripts', 'publishing');
  ex.prepararFuentes(ctx, { arnes: 'HEAD', 'agent-skills': 'HEAD' }, {
    lista: path.join(base, 'allowlist.json'), reemplazos: path.join(base, 'replacements.json'),
    denegados: path.join(base, 'denylist.json'), publicRepos: path.join(base, 'public-repos.json'),
  });
  // la ruta en el repo de cada archivo que sale (un sintético se lee desde su `from`, que es lo que viaja con su texto)
  const rutas = new Set();
  for (const p of ex.whatShips(ctx).packages) {
    // un sintético viaja con el texto de su `from` («synthetic-source»), no con el del archivo que reemplaza
    for (const [, a] of p.files) if (a.ruta && a.kind !== 'synthetic') rutas.add(a.ruta);
  }
  return [...rutas].filter((r) => fs.existsSync(path.join(RAIZ, r)));
}

// Los ejemplos se arman por partes (`n`): este archivo viaja y la prueba de abajo lo recorre como a cualquier otro.
test('InternalHistory_Expression_SeesLooseForms', () => {
  const ve = (t) => [...t.matchAll(NUMERO_DE_PR)].map((m) => m[0]);
  const n = (palabra, numero) => `${palabra} ${numero}`;
  assert.deepStrictEqual(ve(`el ${n('PR', 1234)} y el ${n('pull request', '#5678')}`), [n('PR', 1234), n('pull request', '#5678')]);
  assert.deepStrictEqual(ve(`Evidencia (${n('PR de prueba', 4321)}, del arnés)`), [n('PR de prueba', 4321)]);
  assert.deepStrictEqual(ve(`(${n('PR', '!2345')}, rename)`), [n('PR', '!2345')]);
  assert.deepStrictEqual(ve(`los ${n('pull requests', 1111)} y 2222`), [n('pull requests', 1111)]);
  assert.deepStrictEqual(ve('«Merged PR <id>: …» y un pull request (2026-09-05)'), [], 'un marcador o una fecha no son un número de pull request');
});

test('PublishedFiles_PrNumbers_OnlyDeclaredTestData', () => {
  const declarados = JSON.parse(fs.readFileSync(path.join(RAIZ, LISTA), 'utf8')).allowed;
  assert.ok(Array.isArray(declarados), `${LISTA}: sin «allowed»`);
  for (const e of declarados) {
    assert.ok(e && e.file && e.form && e.value && e.reason && String(e.reason).trim(), `${LISTA}: cada entrada necesita file, form, value y reason (${JSON.stringify(e)})`);
  }
  // la lista la comparte el control de historia interna de la prosa (story 8.26, tanda G1): esta prueba mira sólo los
  // números de pull request; las demás formas las cuida scripts/tests/internal-history-guard.test.js
  const permitidos = declarados.filter((e) => e.form === 'pr-number');
  const archivos = publicados();
  assert.ok(archivos.length > 100, `pocos archivos publicados (${archivos.length}): la lista no se resolvió`);
  const vistos = new Set();
  const fuera = [];
  for (const f of archivos) {
    if (f === LISTA) continue;
    const datos = fs.readFileSync(path.join(RAIZ, f));
    if (datos.includes(0)) continue;
    datos.toString('utf8').split('\n').forEach((linea, i) => {
      for (const m of linea.matchAll(NUMERO_DE_PR)) {
        const ok = permitidos.find((e) => e.file === f && m[0] === e.value);
        if (ok) vistos.add(`${ok.file}\0${ok.value}`);
        else fuera.push(`${f}:${i + 1}: «${m[0]}»`);
      }
    });
  }
  assert.deepStrictEqual(fuera, [], 'números de pull request en lo publicado, fuera de la lista de datos de prueba');
  const sobran = permitidos.filter((e) => !vistos.has(`${e.file}\0${e.value}`)).map((e) => `${e.file}: «${e.value}»`);
  assert.deepStrictEqual(sobran, [], 'declaraciones que ya no aparecen (o el archivo ya no se publica): sacalas de la lista');
});

// La prosa que se publica, entera, en cero (story 8.26, tanda G3, AC 56 · T59). Las guías y las portadas, las skills,
// los revisores y los bloques dicen la regla y su porqué, sin el caso; lo que es un dato o el ejemplo de un formato
// está declarado con su motivo. Con la prosa en cero, el control frena por escrito: quien agrega una forma no crea el
// commit. Corre en el repo y en la copia (ahí el control mira en modo público: lo que dejaría de llevar a algún lado).
test('PublishedProse_ZeroForms_GuardBlocksByDefault', () => {
  const ih = require('../publishing/internal-history.js');
  const d = ih.run({ mode: 'all', repo: RAIZ, ref: 'HEAD', config: null });
  assert.strictEqual(d.outcome, 'counted', 'el control pudo mirar');
  const quedan = Object.entries(d.files).map(([file, forms]) => `${file}: ${Object.entries(forms).map(([form, n]) => `${form} ${n}`).join(', ')}`);
  assert.deepStrictEqual(quedan, [], 'formas de historia interna en la prosa que se publica, fuera de lo declarado');
  assert.strictEqual(d.total, 0);
  assert.ok(d.looked > 100, `pocos archivos de prosa mirados (${d.looked}): el cero sería un cero vacío`);
  assert.deepStrictEqual(d.stale, [], 'una declaración que ya no hace falta, sale');
  // el modo ESCRITO es frenar, y ninguna forma quedó escrita por debajo sin decir por qué
  const config = JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'publishing', 'internal-history.json'), 'utf8'));
  assert.strictEqual(config.mode, 'block', 'con la prosa en cero el control frena: el modo escrito es `block`');
  for (const [form, c] of Object.entries(config.forms)) {
    assert.ok(c.mode === 'block' || (c.mode === 'warn' && String(c.why || '').trim()), `${form}: frena, o avisa diciendo por qué`);
  }
});
