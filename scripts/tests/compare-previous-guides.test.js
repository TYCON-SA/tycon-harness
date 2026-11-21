'use strict';
/**
 * compare-previous-guides.test.js — los pasos y el formato dicen cómo se compara con main (@story-8.167).
 *
 * El freno de «Preparar el commit» por la comparación con main sólo sirve si quien implementa sabe cuándo comparar,
 * qué no queda aislado, cómo se resuelve una diferencia y cómo se pide la exención. Si los textos no lo dicen, el agente
 * choca con el freno sin saber la salida, o escribe la exención en el frontmatter, que no exime.
 *
 *   T17 · Pasos_DicenCuandoYComoResolver: step-10 dice cuándo comparar, los topes, cómo pedir la exención, lo que sigue
 *         sin aislar, lo que se niega a comparar y que el humo comparado corre el guion por la ruta del clon; step-11
 *         dice qué frena, las dos salidas (declarar o arreglar) y el aviso de cada exención.
 *   T18 · Formato_DescribeCambiosYExencion: story-format describe «Cambios de comportamiento» con su regla y dice que la
 *         exención no va en el frontmatter; la guía de firmas lista compare-waiver de nivel 1, delegable sólo con el
 *         pedido al perfil que firma el dueño.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8').replace(/\s+/g, ' ');

// stable-data: only reads guide text.
test('T17 Pasos_DicenCuandoYComoResolver @story-8.167 @ac-15', () => {
  const paso10 = leer('skills/tycon-pipeline/steps/step-10-live-check.md');
  for (const [que, re] of [
    ['cuándo comparar', /compare-candidates --story/],
    ['el humo comparado', /smoke-run\.sh <dir> <spec\.md> --compare --/],
    ['los topes', /TYCON_COMPARE_MAX/],
    ['el tope de cada corrida', /TYCON_COMPARE_TIMEOUT_MS/],
    ['el tope total', /TYCON_COMPARE_TOTAL_MS/],
    ['la exención', /marker\.js compare-waiver --story/],
    ['lo que sigue sin aislar', /Lo que sigue sin aislar/],
    ['sin el freno de mano', /fuera de los ganchos de seguridad/],
    ['lo que corta cada encierro', /sandbox-exec.*unshare/],
    ['lo que se niega a comparar', /no comparado: toca lo real/],
    ['sudo', /sudo/],
    ['la ruta del clon', /ruta del clon, no por el arnés instalado bajo `\$HOME`/],
    ['{raiz}', /\{raiz\}/],
    ['--covers', /--covers <archivo>\[:<subcomando>\]/],
    ['«no comparado» no cumple', /«No comparado», por la causa que sea, cuenta como si no hubiera humo/],
  ]) assert.match(paso10, re, `step-10 no dice ${que}`);
  const paso11 = leer('skills/tycon-pipeline/steps/step-11-prepare-commit.md');
  for (const [que, re] of [
    ['el freno', /compare-previous-gate/],
    ['sin humo ni exención', /sin humo comparado que lo cubra ni exención firmada/],
    ['la diferencia sin declarar', /diferencia con main que la historia no declara/],
    ['declarar', /## Cambios de comportamiento/],
    ['arreglar', /arreglando el código/],
    ['declarar es papeleo', /Declarar es papeleo: no dispara la vuelta de revisores/],
    ['la exención', /marker\.js compare-waiver/],
    ['el aviso de cada exención', /Cada exención y cada candidato «cubierto por declaración» sale como aviso/],
    ['el texto del pedido', /compare-avisos\.md/],
  ]) assert.match(paso11, re, `step-11 no dice ${que}`);
});

test('T18 Formato_DescribeCambiosYExencion @story-8.167 @ac-16', () => {
  const formato = leer('story-format.md');
  assert.match(formato, /## Cambios de comportamiento/);
  assert.match(formato, /un prefijo suyo que termina en un espacio/, 'la regla para emparejar');
  assert.match(formato, /no va en el frontmatter/);
  assert.match(formato, /compare_exempt:` no exime/);
  assert.match(formato, /marker\.js compare-waiver --story/);
  const firmas = leer('guides/firmas-del-arnes.md');
  assert.match(firmas, /\| `compare-waiver` \| 1 · rutina \|/, 'en la tabla de niveles, nivel 1');
  assert.match(firmas, /\*\*Eximir un comando de la comparación con main\*\* \(`compare-waiver`\)/, 'quién la firma');
  assert.match(firmas, /delegable sólo cuando el perfil del equipo la suma a `approvals\.delegated_signing`, con un pedido al perfil que firma el dueño/);
  assert.match(firmas, /Hasta entonces, es tuya/);
});
