'use strict';
/**
 * secret-scan-evidence-hashes.test.js — gitleaks no toma por claves las huellas de la evidencia del arnés, y sigue frenando
 * todo lo demás.
 *
 * La evidencia (.advisors/) guarda la huella git de cada archivo con su ruta como clave; la regla generic-api-key de
 * gitleaks la tomaba por clave cuando la ruta decía «api» o «credentials», y frenaba pedidos de producto. La excepción
 * vive en scripts/ci/secret-scan/evidence-hashes.toml y las plantillas de pipelines la copian tal cual.
 *
 * Sin red ni docker: la prueba lee la excepción del archivo (sus rutas y su expresión) y la ejercita contra la expresión de
 * generic-api-key de gitleaks v8.30.1 (la versión fija de las plantillas), con el motor de expresiones de Node: las
 * formas que usan las dos (clases, cuantificadores, `(?-i:…)`) se leen igual en RE2 y en JavaScript.
 * Correr: node --test scripts/tests/secret-scan-evidence-hashes.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CANON = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'secret-scan', 'evidence-hashes.toml'), 'utf8');
const BLOQUE = CANON.slice(CANON.indexOf('\n[[allowlists]]\n') + 1).trimEnd();
const literales = (clave) => {
  const m = BLOQUE.match(new RegExp(`^${clave} = \\[(.*)\\]$`, 'm'));
  return m ? [...m[1].matchAll(/'''(.*?)'''/g)].map((x) => x[1]) : [];
};
const RUTAS = literales('paths').map((r) => new RegExp(r));
const EXPRESIONES = literales('regexes').map((r) => new RegExp(r));

// generic-api-key de gitleaks v8.30.1 (cmd/generate/config/rules/generic.go, armada por GenerateSemiGenericRegex). Allá
// es toda sin mayúsculas salvo «api», con `(?i)` y `(?-i:…)`; Node 22 (el piso del arnés) no lee banderas por tramo, así
// que cada letra de lo que no distingue mayúsculas va como su clase: `[aA]`.
const sinMayusculas = (t) => t.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const PALABRAS = ['access', 'auth', 'credential', 'creds', 'key', 'passw(?:or)?d', 'secret', 'token'].map(sinMayusculas);
const GENERIC = new RegExp(`[\\w.-]{0,50}?(?:${PALABRAS.slice(0, 2).join('|')}|[Aa]pi|API|${PALABRAS.slice(2).join('|')})`
  + `(?:[ \\t\\w.-]{0,20})[\\s'"]{0,3}(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)[\\x60'"\\s=]{0,5}`
  + `([\\w.=-]{10,150}|[a-zA-Z0-9][a-zA-Z0-9+/]{11,}={0,3})(?:[\\x60'"\\s;]|\\\\[nrNR]|$)`, 'g');

/** Lo que gitleaks frenaría en `renglon` del archivo `ruta`: cada tramo de generic-api-key que la excepción no cubre. */
function frena(ruta, renglon, { conExcepcion = true } = {}) {
  const tramos = [...renglon.matchAll(GENERIC)].map((m) => m[0]);
  const cubre = (tramo) => conExcepcion && RUTAS.some((r) => r.test(ruta)) && EXPRESIONES.some((r) => r.test(tramo));
  return tramos.filter((t) => !cubre(t));
}

const HUELLA = 'e031681306d9c4dae767c1478a64a61cf5e44952';
const LEDGER = '.advisors/dod-runtime/9.9-smoke-ledger.jsonl';
const renglonConHuellas = `{"ts":"2026-11-20T00:00:00Z","huellas":{"scripts/tests/lib/fake-ado-api.js":"${HUELLA}","config/credentials.json":"${HUELLA}"}}`;

test('GitleaksHuellas_LaExcepcionSeLee — una ruta y una expresión, con condición AND y sobre el tramo', () => {
  assert.strictEqual(RUTAS.length, 1);
  assert.strictEqual(EXPRESIONES.length, 1);
  assert.match(BLOQUE, /^condition = "AND"$/m);
  assert.match(BLOQUE, /^regexTarget = "match"$/m, 'sobre el renglón entero taparía un secreto de verdad en el mismo renglón');
});

// 🔴 Falla con: la excepción ausente o que no cubre la huella (rojo antes: sin ella, las dos rutas frenan).
test('GitleaksHuellas_HuellaConRutaApiBajoAdvisors_Pasa', () => {
  assert.strictEqual(frena(LEDGER, renglonConHuellas, { conExcepcion: false }).length, 2, 'sin la excepción, gitleaks frena las dos');
  assert.deepStrictEqual(frena(LEDGER, renglonConHuellas), []);
  assert.deepStrictEqual(frena('.advisors/dod-runtime/9.9-e2e-gate-20261120T000000Z.md', `- huellas: {"tests/api.test.ts":"${HUELLA}"}`), []);
});

// 🔴 Falla con: una excepción que no mira la carpeta.
test('GitleaksHuellas_MismaHuellaFueraDeAdvisors_Frena', () => {
  assert.strictEqual(frena('docs/huellas.jsonl', renglonConHuellas).length, 2);
  assert.strictEqual(frena('src/.advisorsx/a.jsonl', renglonConHuellas).length, 2);
});

// 🔴 Falla con: una excepción que tapa el renglón entero o cualquier valor bajo .advisors/.
test('GitleaksHuellas_ClaveRealBajoAdvisors_Frena', () => {
  const real = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dcAbCdEf';
  assert.strictEqual(frena(LEDGER, `{"cmd":"curl -H 'x'","api_key":"${real}"}`).length, 1);
  // en el mismo renglón que una huella: la huella pasa y la clave no
  const mixto = `{"huellas":{"scripts/tests/lib/fake-ado-api.js":"${HUELLA}"},"api_key":"${real}"}`;
  assert.deepStrictEqual(frena(LEDGER, mixto).map((t) => t.includes(real)), [true]);
});

// 🔴 Falla con: una excepción que deja pasar cualquier 40 hex, sin mirar que la clave sea un archivo.
test('GitleaksHuellas_40HexConClaveQueNoEsRuta_Frena', () => {
  for (const clave of ['api_key', 'token', 'auth', 'api.token', 'credentials']) {
    assert.strictEqual(frena(LEDGER, `{"${clave}":"${HUELLA}"}`).length, 1, clave);
  }
  // en mayúsculas no es una huella de git
  assert.strictEqual(frena(LEDGER, `{"scripts/tests/lib/fake-ado-api.js":"${HUELLA.toUpperCase()}"}`).length, 1);
});

// 🔴 Falla con: una plantilla que no lleva la excepción tal cual, o que no le pasa la configuración a gitleaks.
// Las del paquete bizuit viven en el repo privado: se miran donde el árbol las trae (el armado sobre el público), y
// `TYCON_PACKS_DIR` apunta a otro lado para mirarlas desde su copia.
test('GitleaksHuellas_LasPlantillasLlevanLaExcepcion', (t) => {
  const dir = path.join(ROOT, 'scripts', 'setup', 'harness', 'team-stories');
  const paquete = path.join(process.env.TYCON_PACKS_DIR || path.join(ROOT, 'packs'), 'bizuit', 'templates', 'pipelines');
  const plantillas = ['azure/stories-gate.yml', 'github/stories-gate.yml'].map((f) => path.join(dir, f));
  if (fs.existsSync(paquete)) plantillas.push(...['stories-gate.yml', 'forms-ci.yml', 'backend-ci.yml'].map((f) => path.join(paquete, f)));
  else t.diagnostic(`sin el paquete bizuit en ${paquete}: sus tres plantillas se miran en el árbol armado`);
  for (const ruta of plantillas) {
    const f = path.relative(ROOT, ruta);
    const texto = fs.readFileSync(ruta, 'utf8');
    const sinSangria = texto.split('\n').map((l) => l.trim()).join('\n');
    assert.ok(sinSangria.includes(BLOQUE.split('\n').map((l) => l.trim()).join('\n')), `${f}: no lleva la excepción tal cual`);
    assert.match(texto, /--config \/cfg\/gitleaks\.toml/, `${f}: no le pasa la configuración a gitleaks`);
    assert.match(texto, /:\/cfg\/gitleaks\.toml:ro/, `${f}: no monta la configuración`);
    assert.match(texto, /path = "\/repo\/\.gitleaks\.toml"/, `${f}: el .gitleaks.toml del repo tiene que seguir valiendo`);
    assert.match(texto, /useDefault = true/, `${f}: sin .gitleaks.toml del repo, las reglas de fábrica`);
  }
});
