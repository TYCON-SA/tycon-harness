#!/usr/bin/env node
/**
 * regen.js — deriva un fixture de `stories/` desde una story, y comprueba que mida lo mismo.
 *
 * 🔴 NO regenera ninguno: los nueve fixtures de `stories/` son stories de EJEMPLO inventadas, escritas
 * para la prueba y editadas en el propio archivo. Lo que la prueba mide es su FORMA, fijada en
 * `stories-shape.json`. No volver a
 * sumar un fixture a CASOS con una story real de origen: lo pisaría con su texto.
 *
 * Por qué hay fixtures y no se leen stories de verdad: un test que se saltea cuando no encuentra el
 * archivo es exactamente el `skip-on-not-ok` que `guides/definition-of-done.md` prohíbe — el verde diría
 * "pasó" cuando nadie corrió nada.
 *
 * Para qué queda el guion: para armar un fixture NUEVO desde una story propia cuando aparezca otro modo de
 * falla del parser. Qué conserva `derive()` de la story:
 *   · frontmatter recortado a `story`/`epic`/`status` MÁS cualquier línea que cite el
 *     literal `## Acceptance Criteria`. Esa cita es la que dispara el falso match de
 *     sección: sin ella el fixture no reproduce nada.
 *   · la sección `## Acceptance Criteria` y la tabla de Tests, con la cola de
 *     prosa de cada línea cortada a CAP chars. El corte es lossless para lo que se está
 *     testeando: los dos parsers solo leen prefijos de línea (`^N.`, `^#### AC-N`, `^|`).
 * Y VERIFICA que el fixture devuelva exactamente lo mismo que su origen; falla si no. Después de
 * derivarlo, el texto se reinventa a mano (sólo queda la forma) y se suma a `stories-shape.json`.
 *
 * Correr:
 *   node scripts/tests/fixtures/regen.js <fixture-de-destino.md> <story-de-origen.md>
 */

const fs = require('fs');
const path = require('path');

const CAP = 110;
const OUT = __dirname;
// Sin casos declarados (ver la cabecera): el par destino/origen viene por la línea de comandos.
const CASOS = [];
if (process.argv.length === 4) CASOS.push([process.argv[2], path.resolve(process.argv[3])]);
else if (process.argv.length !== 2) {
  // ni «nada que hacer» ni un par completo: falta o sobra un argumento, y eso no es un verde
  console.error('uso: node regen.js <fixture-de-destino.md> <story-de-origen.md>   (sin argumentos: dice que no hay nada que regenerar)');
  process.exit(2);
}
if (!CASOS.length) {
  console.log('regen.js: no hay fixtures que regenerar — los de stories/ son inventados y se editan en su archivo.');
  console.log('          Para derivar uno nuevo: node regen.js <fixture-de-destino.md> <story-de-origen.md>');
  process.exit(0);
}

const clip = (t) => t.split('\n').map((l) => (l.length > CAP ? l.slice(0, CAP) + ' …' : l)).join('\n');

function derive(src) {
  const c = fs.readFileSync(src, 'utf8');
  const fmMatch = c.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const body = c.slice(fmMatch ? fmMatch[0].length : 0);
  const keep = (fmMatch ? fmMatch[1] : '').split('\n')
    .filter((l) => /^(story|epic|status)\s*:/.test(l) || /#{2}[ \t]+Acceptance Criteria/.test(l));
  const fm = '---\n' + clip(keep.join('\n')) + '\n---\n';
  const ac = (body.match(/^##[ \t]+Acceptance Criteria[\s\S]*?(?=\n##[ \t]|(?![\s\S]))/m) || [''])[0];
  const tests = (body.match(/^#{2,6}[ \t]+Tests\b[\s\S]*?(?=\n#{1,3}[ \t]|(?![\s\S]))/m) || [''])[0];
  // 🔴 Esta cabecera NO puede contener el literal del heading de ACs: un parser con regex sin anclar
  // lo tomaría de aquí en vez de la sección real, y los fixtures fallarían por la misma causa
  // — incluidos los anti-regresión, que existen para dar VERDE contra ese parser y probar que la
  // corrección no rompió lo que ya estaba arreglado.
  return `<!-- FIXTURE recién derivado de una story: falta reinventar el texto (ver la cabecera de regen.js).
     Contenido: frontmatter recortado (se conservan story/epic/status y toda línea que cite
     el heading de la sección de criterios, que es lo que dispara el falso match de sección)
     + esa sección y la tabla de Tests VERBATIM, con la cola de prosa de cada línea cortada
     a ${CAP} chars. El corte es lossless para el parser: solo lee prefijos de línea.
     Después de reinventarlo, sumarlo a tests/fixtures/stories-shape.json. -->

` + fm + '\n' + clip(ac) + '\n\n' + clip(tests) + '\n';
}

const sc = require(path.join(__dirname, '..', '..', 'lib', 'story-checks.js'));
let fallos = 0;
for (const [dest, src] of CASOS) {
  if (!fs.existsSync(src)) {
    console.error(`FALTA el origen: ${src} — fixture ${dest} NO derivado.`);
    fallos++;
    continue;
  }
  const out = derive(src);
  fs.writeFileSync(path.join(OUT, 'stories', dest), out, 'utf8');
  const orig = fs.readFileSync(src, 'utf8');
  const a = sc.parseAcsFromSpec(out);
  const b = sc.parseAcsFromSpec(orig);
  const ta = sc.parseTestsTable(out);
  const tb = sc.parseTestsTable(orig);
  const fiel = a.length === b.length && a.every((v, i) => v === b[i]) && ta.rows.length === tb.rows.length;
  if (!fiel) {
    console.error(`INFIEL ${dest}: fixture acs=${a.length}/rows=${ta.rows.length} vs origen acs=${b.length}/rows=${tb.rows.length}`);
    fallos++;
  } else {
    console.log(`ok  ${dest}  acs=${a.length} rows=${ta.rows.length}`);
  }
}
process.exit(fallos ? 1 : 0);
