'use strict';
/**
 * pr-signature-texts.test.js — el último paso y las guías dicen que la persona aprueba el pull request, no el commit.
 *
 * El commit y el empuje de la rama de trabajo los hace el agente sin preguntar; la ventana de permiso sale al abrir el
 * pull request o al empujar a una rama compartida. Si el nombre del paso o una guía siguen diciendo «¿guardo?» antes de
 * cada commit, la persona espera una pregunta que ya no llega, o aprueba algo que no es lo que el arnés le pide. Lo que
 * se ve dice «pull request», no «pedido».
 *
 *   T15 · el último paso se llama «Preparar el pull request» (id `prepare-commit`) en la tabla de pasos, en su copia de
 *         la extensión y en los textos del sitio, con su objetivo y la fila de la matriz «¿Quién firma?», en los dos
 *         idiomas.
 *   T17 · el archivo del paso, el SKILL, el README en los dos idiomas, INDEX.md y las guías nombran el pull request como
 *         lo que aprueba la persona; ninguna dice que el commit pregunta; la guía de firmas sale del catálogo.
 *
 * stable-data: no crea commits ni lee el reloj; «git-commit» es el nombre de una guía que se lee.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

test('8.242-Pasos_ElPaso11SeLlamaPrepararElPedido (T15) @story-8.242 @ac-12', async () => {
  const { STEPS } = require(path.join(RAIZ, 'skills', 'tycon-pipeline', 'scripts', 'lib', 'steps.js'));
  const paso = STEPS.find((s) => s.number === 11);
  assert.strictEqual(paso.id, 'prepare-commit', 'el identificador no cambia: lo leen los marcadores en vuelo');
  assert.strictEqual(paso.name, 'Preparar el pull request');

  const mjs = await import(path.join(RAIZ, 'mods', 'harness-mods', 'hooks', 'steps.mjs'));
  const copia = mjs.STEPS.find((s) => s.number === 11);
  assert.strictEqual(copia.id, 'prepare-commit');
  assert.strictEqual(copia.name, 'Preparar el pull request', 'la copia de la extensión dice otro nombre que la tabla');

  const { TEXTOS: TEXTS } = require(path.join(RAIZ, 'scripts', 'site', 'texts.js'));
  assert.deepStrictEqual(TEXTS['paso.prepare-commit'], { es: 'Preparar el pull request', en: 'Prepare the pull request' });
  assert.deepStrictEqual(TEXTS['paso.prepare-commit.objetivo'], {
    es: 'Arma el commit y el pull request; el pull request sale con tu sí.',
    en: 'Writes the commit and the pull request; the pull request goes out with your yes.',
  });
  assert.deepStrictEqual(TEXTS['pantalla.corto.guardar'], { es: 'Abrir el pull request · 1', en: 'Open the pull request · 1' });
});

// Las guías del criterio 12: cada una dice, con estas palabras, qué aprueba la persona.
const GUIAS_ES = [
  'skills/tycon-pipeline/steps/step-11-prepare-commit.md',
  'skills/tycon-pipeline/SKILL.md',
  'README.es.md',
  'INDEX.md',
  'guides/firmas-del-arnes.md',
  'guides/git-commit-conventions.md',
  'guides/que-hace-el-arnes.md',
  'guides/coordination.md',
  'guides/workflow-orchestration.md',
  'guides/piezas-del-arnes.md',
  'guides/organization-site.md',
];
const GUIAS_EN = ['README.md', 'guides/organization-site.en.md'];
const DICE_ES = /la persona aprueba el pull request/i;
const DICE_EN = /the person approves the pull request/i;
// Lo que ya no es cierto: una pregunta antes de cada commit.
const YA_NO = [
  /«¿guardo\?»/i,
  /Guardar es un click/i,
  /Saving is a click/i,
  /antes de (cada|commitear)[^.\n]*pregunta/i,
  /before every commit[^.\n]*asks/i,
];

test('8.242-Guias_DicenElPedido (T17) @story-8.242 @ac-12', () => {
  const faltan = [];
  const viejas = [];
  for (const rel of [...GUIAS_ES, ...GUIAS_EN]) {
    const texto = leer(rel);
    const dice = GUIAS_EN.includes(rel) ? DICE_EN : DICE_ES;
    if (!dice.test(texto)) faltan.push(rel);
    for (const re of YA_NO) if (re.test(texto)) viejas.push(`${rel}: ${re}`);
  }
  assert.deepStrictEqual(faltan, [], 'no dicen que la persona aprueba el pull request');
  assert.deepStrictEqual(viejas, [], 'todavía dicen que el commit pregunta');

  assert.match(leer('skills/tycon-pipeline/steps/step-11-prepare-commit.md'), /^# Preparar el pull request/m);
  // el archivo del paso y las guías que lo nombran ya no lo llaman como antes, ni dicen que el commit lo decide la persona
  const conNombreViejo = [];
  for (const rel of ['skills/tycon-pipeline/steps/step-11-prepare-commit.md', 'guides/workflow-orchestration.md', 'guides/organization-site.md', 'guides/organization-site.en.md']) {
    const texto = leer(rel);
    for (const re of [/Preparar el commit/, /Prepare the commit/i, /decide commitear o no/]) if (re.test(texto)) conNombreViejo.push(`${rel}: ${re}`);
  }
  assert.deepStrictEqual(conNombreViejo, [], 'todavía nombran el paso como antes');

  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'tools', 'signatures-guide.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `la guía de firmas no sale del catálogo:\n${r.stdout}${r.stderr}`);
});
