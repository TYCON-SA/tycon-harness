'use strict';
// org-config-repo-key.test.js — la clave con que el formulario «Tu tecnología» del sitio distingue los repos de la
// organización (scripts/lib/org-config.js, código del navegador): un repo que vive en grupos (namespace) se distingue por
// su grupo y su servidor, y las claves de Azure DevOps y GitHub quedan como estaban.
//
// stable-data: sin red; saca la función del código de la pantalla y la corre.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ORG = require(path.join(__dirname, '..', 'lib', 'org-config.js'));

/** La función `claveDeRepo` del código de la pantalla, sacada por sus llaves. */
function claveDeRepo() {
  const fuente = ORG.pantalla();
  const desde = fuente.indexOf('function claveDeRepo(');
  assert.ok(desde >= 0, 'la pantalla trae su función claveDeRepo');
  let depth = 0;
  let fin = -1;
  for (let i = fuente.indexOf('{', desde); i < fuente.length; i++) {
    if (fuente[i] === '{') depth++;
    else if (fuente[i] === '}' && --depth === 0) { fin = i + 1; break; }
  }
  return new Function(`${fuente.slice(desde, fin)}; return claveDeRepo;`)();
}

/** Los repos que siguen libres después de usar `usados`, como los calcula el formulario. */
const libres = (clave, todos, usados) => todos.filter((x) => usados.map(clave).indexOf(clave(x)) < 0);

const GL = (namespace, host) => ({ platform: 'gitlab', ...(host ? { host } : {}), namespace, repo: 'servicio' });

test('T6 SitioTecnologia_GitlabMismoNombre @story-1.2 @ac-5', () => {
  const clave = claveDeRepo();
  const a = GL('producto/plataforma', 'gitlab.example.com');
  const b = GL('producto/otra', 'gitlab.example.com');
  assert.notStrictEqual(clave(a), clave(b));
  assert.deepStrictEqual(libres(clave, [a, b], [a]), [b], 'usar uno deja al otro en la lista de libres');
});

test('T7 SitioTecnologia_GitlabOtroServidor @story-1.2 @ac-5', () => {
  const clave = claveDeRepo();
  const propio = GL('producto/plataforma', 'gitlab.example.com');
  const publico = GL('producto/plataforma');
  const otro = GL('producto/plataforma', 'git.otra.example');
  assert.strictEqual(new Set([clave(propio), clave(publico), clave(otro)]).size, 3, 'el mismo grupo y repo en servidores distintos son claves distintas');
  assert.strictEqual(clave(GL('Producto/Plataforma', 'GitLab.Example.com')), clave(propio), 'sin mayúsculas, como la identidad del lector');
});

test('Regresión: las claves de Azure DevOps y GitHub quedan como estaban @story-1.2 @ac-6', () => {
  const clave = claveDeRepo();
  assert.strictEqual(clave({ platform: 'azure', org: 'Acme', project: 'Prod%20A', repo: 'Back' }), 'azure/acme/prod a/back');
  assert.strictEqual(clave({ platform: 'github', org: 'acme', repo: 'web' }), 'github/acme//web');
  assert.strictEqual(clave(null), '');
});
