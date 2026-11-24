'use strict';
// Casos de scripts/ci/check-profile-only.js: con el filtro de la configuración sano no frena; si la máquina, una variable
// o un perfil que no es el del árbol pisan una clave que vale sólo el perfil, frena; y lo que no puede medir no es verde.
// Cada caso corre el control sobre una copia de laboratorio de scripts/lib, con una casa vacía.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..', '..');
const CONTROL = path.join(RAIZ, 'scripts', 'ci', 'check-profile-only.js');

/** Un árbol de laboratorio con scripts/lib copiado; `cambiar(texto)` reescribe su tycon-config.js. */
function arbol(cambiar) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'check-profile-only-'));
  fs.cpSync(path.join(RAIZ, 'scripts', 'lib'), path.join(d, 'scripts', 'lib'), { recursive: true });
  if (cambiar) {
    const f = path.join(d, 'scripts', 'lib', 'tycon-config.js');
    const antes = fs.readFileSync(f, 'utf8');
    const despues = cambiar(antes);
    assert.notStrictEqual(despues, antes, 'el cambio de laboratorio no se aplicó');
    fs.writeFileSync(f, despues);
  }
  return d;
}
function correr(d) {
  const casa = fs.mkdtempSync(path.join(os.tmpdir(), 'check-profile-only-casa-'));
  const r = spawnSync(process.execPath, [CONTROL, '--root', d], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: casa, USERPROFILE: casa } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const FILTRO = '      if (PROFILE_ONLY.includes(ruta)) {\n';

test('CheckProfileOnly_FilterIntact_Passes', () => {
  const r = correr(arbol());
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /no las pisa la máquina, una variable ni otro perfil/);
});

test('CheckProfileOnly_FilterRemoved_Stops', () => {
  // 🔴 mutación: sin el filtro, el archivo de la máquina y el perfil por variable mandan en las claves del perfil
  const r = correr(arbol((t) => t.replace(FILTRO, '      if (false && PROFILE_ONLY.includes(ruta)) {\n')));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /approvals\.levels/);
});

test('CheckProfileOnly_OnlyTheMachineLeaks_Stops', () => {
  // 🔴 mutación: el filtro deja pasar sólo el archivo de la máquina (el perfil por variable sigue afuera)
  const r = correr(arbol((t) => t.replace(FILTRO, `${FILTRO}        if (enMaquina) { valores[seccion][clave] = planoMaquina[ruta]; origenes[ruta] = 'maquina'; continue; }\n`)));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /de maquina/);
});

test('CheckProfileOnly_OnlyTheNamedProfileLeaks_Stops', () => {
  // 🔴 mutación: el filtro toma el perfil nombrado por variable (TYCON_PROFILE) en vez del perfil del árbol
  const r = correr(arbol((t) => t.replace(
    "if (Object.prototype.hasOwnProperty.call(planoArbol, ruta)) { valores[seccion][clave] = planoArbol[ruta]; origenes[ruta] = 'perfil'; }",
    "if (Object.prototype.hasOwnProperty.call(planoPerfil, ruta)) { valores[seccion][clave] = planoPerfil[ruta]; origenes[ruta] = 'perfil'; }")));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /de perfil/);
});

test('CheckProfileOnly_Red_LeavesNoLabFolders', () => {
  const antes = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('profile-only-')));
  const r = correr(arbol((t) => t.replace(FILTRO, '      if (false && PROFILE_ONLY.includes(ruta)) {\n')));
  assert.strictEqual(r.status, 1, r.out);
  const quedan = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('profile-only-') && !antes.has(n));
  assert.deepStrictEqual(quedan, [], 'el control dejó sus carpetas de laboratorio');
});

test('CheckProfileOnly_OneKeyLeftOut_StopsAndNamesIt', () => {
  const r = correr(arbol((t) => t.replace(FILTRO, "      if (PROFILE_ONLY.includes(ruta) && ruta !== 'site.url') {\n")));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /site\.url/);
  assert.doesNotMatch(r.out, /approvals\.levels/);
});

test('CheckProfileOnly_ConfigAppliesShorterList_SignedListRules', () => {
  // la configuración aplica una lista más corta que la firmada: se mide con la firmada
  const r = correr(arbol((t) => t.replace("const PROFILE_ONLY = require('./profile-only.js');",
    "const PROFILE_ONLY = Object.freeze(require('./profile-only.js').filter((r) => r !== 'qa.manual_check'));")));
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /qa\.manual_check/);
});

test('CheckProfileOnly_UnknownType_NotMeasuredIsNotGreen', () => {
  // una clave de la lista con un tipo que el control no sabe armar: no medido, nunca verde
  const d = arbol((t) => t.replace("site: Object.freeze({", "site: Object.freeze({ lab_key: 'un-tipo-nuevo',"));
  fs.writeFileSync(path.join(d, 'scripts', 'lib', 'profile-only.js'), "module.exports = Object.freeze(['site.lab_key']);\n");
  const r = correr(d);
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /no sé armar un valor de laboratorio para site\.lab_key/);
});

test('CheckProfileOnly_ConfigDoesNotLoad_NotMeasured', () => {
  const r = correr(arbol((t) => `${t}\nthrow new Error('rota a propósito');\n`));
  assert.strictEqual(r.status, 2, r.out);
  assert.match(r.out, /la configuración del árbol no carga/);
});
