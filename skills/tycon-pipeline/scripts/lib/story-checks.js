/**
 * lib/story-checks.js — checks DETERMINISTAS de story Mary+GOLD.
 *
 * Extrae a código las reglas mecánicas que hoy ejecutan advisors LLM (Sonnet,
 * 2-3 min + tokens por iteración del paso de revisores). El patrón es "executor determinista
 * + LLM solo para ambiguos": pipeline.js mech-check corre esto inline (~ms) y el
 * orquestador invoca el advisor LLM correspondiente SOLO si hay `ambiguous`.
 *
 * Reglas cubiertas (cita el rule ID del catálogo en cada finding):
 *   ACCOV-C1  cada test de la tabla ### Tests existe implementado (grep por
 *             T-ID / nombre PascalCase / [Trait("AC","N")] / tag @ac-N).
 *   ACCOV-C5  cada AC numerado tiene ≥1 test asignado en la tabla ### Tests.
 *   DEFTR-C1  cada item pending del bloque `pipelines:` tiene trazabilidad
 *             (TODO(Story-N-deferral) en código o entry en tasks/todo.md).
 *   DEFTR-C2  cada *.skip() / [Fact(Skip=...)] AGREGADO está anotado con deferral.
 *   WIRING-C1 componente React exportado nuevo sin ningún import/uso externo.
 *
 * Contrato AC↔test (story-format.md §6):
 *   - Tabla ### Tests con columna `AC` (lista de números).
 *   - xUnit:    [Trait("Story","4.5.3")] [Trait("AC","1")]
 *   - vitest:   describe/it con tag literal '@story-4.5.3' / '@ac-1'
 *   - Playwright: idem en el título del test.
 * El matching por T-ID/nombre sigue funcionando como fallback para stories viejas.
 *
 * Consumidores: pipeline.js mech-check (paso de revisores),on-pre-commit.js (gate commit),
 * tycon-story-validator VAL-W11 (paso «Validar la historia», vía validate ya en tabla).
 * 0 deps. Fail-safe: cualquier error de parse → finding 'ambiguous', nunca throw.
 */

const fs = require('fs');
const path = require('path');

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// ── Parsers de spec ───────────────────────────────────────────────────────────

// El frontmatter NO es cuerpo de la story. Los comentarios del frontmatter citan
// headings de la prosa (`# AC1-AC5: ...`, "`## Acceptance Criteria` (callout Alcance)"),
// así que buscar secciones sobre el archivo entero matchea DENTRO del frontmatter.
function stripFrontmatter(s) {
  const m = (s || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return m ? s.slice(m[0].length) : (s || '');
}

// Sección `## Acceptance Criteria` → texto, o null si la story no la tiene.
// 🔴 ANCLADA a principio de línea y sin frontmatter. Un regex sin `^` ni flag `m` matchearía
// el literal EN CUALQUIER POSICIÓN, incluido dentro de un backtick del frontmatter — y como el
// frontmatter va primero, ganaría él. La "sección" resultante sería el resto del frontmatter: 0 items
// numerados → `parseAcsFromSpec` devolvería [] → en `runStoryChecks` las dos ramas de ACCOV-C5
// piden `acs.length`, así que el check NO correría y no emitiría NADA (ni finding, ni ambiguous, ni ok).
// Silencio total, no subconteo. `pipeline.js` usa la misma forma anclada.
//
// 🔴 Una sola función lee las secciones de la story, y todos los lectores pasan por ella: una expresión propia en
// otro archivo es la que queda atrás cuando cambia el formato, y un título que no se reconoce deja la story sin
// criterios, sin el revisor de cobertura de criterios y con el paso de revisores en verde (la guardiana de
// tests/story-headings.test.js frena una expresión propia nueva).
// El título se reconoce sin importar mayúsculas y con `##` o `###`; también en castellano. Las palabras de cada
// título viven en TITLE_WORDS para quien necesita el texto del título (el resumen de la story para los revisores).
// `tests-result` y los títulos `Tests corridos` de la evidencia no son la tabla de la story.
const TITLE_WORDS = {
  criteria: 'acceptance criteria|criterios de aceptaci[oó]n',
  tests: 'tests(?![\\w-])(?![ \\t]+corridos)',
};
const HEADING_LINE = /^(#{1,6})[ \t]/;
const FENCE_LINE = /^[ \t]*(```|~~~)/;
const TESTS_TITLE_LINE = new RegExp(`^#{2,6}[ \\t]+(?:${TITLE_WORDS.tests})`, 'i');
const SECTIONS = {
  // Criterios: nivel 2 o 3. Termina en el próximo título de su nivel o más alto —salvo un título de criterio
  // (`### AC-1`), que con el título de la sección en `###` está a su mismo nivel— o en el título de pruebas.
  // Un título de pruebas más hondo que el de criterios corta sólo si debajo hay una tabla: la de story-format es
  // `### Tests` con su tabla, pero hay stories que usan `### Tests` como grupo de criterios (sus criterios en viñetas)
  // y quedarían sin ellos.
  criteria: {
    title: new RegExp(`^(#{2,3})[ \\t]+(?:${TITLE_WORDS.criteria})\\b[^\\n]*$`, 'i'),
    ends: (line, level, lines, i) => {
      const h = HEADING_LINE.exec(line);
      if (!h) return false;
      if (TESTS_TITLE_LINE.test(line)) return h[1].length <= level || tableBelow(lines, i);
      return h[1].length <= level && !FORM['titulo-ac'].re.test(line);
    },
  },
  // Pruebas: nivel 2 a 6 (75 stories reales la escriben con `##`). Termina en el próximo título de nivel 1 a 3, salvo
  // un título de pruebas más hondo: `## Tests` con `### Tests (N verificaciones)` y la tabla debajo es la misma sección.
  tests: {
    title: new RegExp(`^(#{2,6})[ \\t]+(?:${TITLE_WORDS.tests})[^\\n]*$`, 'i'),
    ends: (line, level) => {
      const h = HEADING_LINE.exec(line);
      return !!h && h[1].length <= 3 && !(h[1].length > level && TESTS_TITLE_LINE.test(line));
    },
  },
};

// ¿Hay una fila de tabla debajo del título de la línea `i`, antes del próximo título?
function tableBelow(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    if (HEADING_LINE.test(lines[j])) return false;
    if (/^[ \t]*\|/.test(lines[j])) return true;
  }
  return false;
}

// Sección de la story → `{ text, level, title }`, o null si no la tiene. `kind`: `criteria` o `tests`.
// Lo que va dentro de un bloque ``` no es un título: un `# comentario` de bash o de Gherkin cortaría la sección y la
// story perdería criterios.
function storySection(specContent, kind) {
  const def = SECTIONS[kind];
  if (!def) throw new Error(`storySection: tipo desconocido «${kind}» (criteria | tests)`);
  const lines = stripFrontmatter(specContent).split('\n');
  let start = -1;
  let level = 0;
  let enBloque = false;
  for (let i = 0; i < lines.length && start < 0; i++) {
    if (FENCE_LINE.test(lines[i])) { enBloque = !enBloque; continue; }
    const m = enBloque ? null : def.title.exec(lines[i]);
    if (m) { start = i; level = m[1].length; }
  }
  if (start < 0) return null;
  let end = lines.length;
  enBloque = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (FENCE_LINE.test(lines[i])) { enBloque = !enBloque; continue; }
    if (!enBloque && def.ends(lines[i], level, lines, i)) { end = i; break; }
  }
  return { text: lines.slice(start + 1, end).join('\n'), level, title: lines[start].trim() };
}

function acSectionOf(specContent) {
  const s = storySection(specContent, 'criteria');
  return s ? s.text : null;
}

// Las formas de criterio que el arnés reconoce, en UN lugar. Las tres primeras mandan: las otras sólo se prueban si
// ésas no dan ninguno, así una story que usa una de las tres cuenta siempre lo mismo. `numbered: false` = sin número propio: se
// numeran 1..n en el orden del documento. Una forma nueva entra acá, con su caso en tests/story-headings.test.js.
const AC_FORMS = [
  { name: 'titulo-ac', numbered: true, re: /^#{2,4}[ \t]+AC[-#\s]?(\d+)\b/, example: '### AC-1 — título' },
  { name: 'numerada', numbered: true, re: /^[ \t]*(\d+)\.[ \t]+\S/, example: '1. **Given** … **When** … **Then** …' },
  { name: 'vineta-ac', numbered: true, re: /^[ \t]*[-*][ \t]+\*\*AC[-#\s]?(\d+)\*\*/, example: '- **AC1**: texto (o con `*`)' },
  { name: 'ac-negrita', numbered: true, re: /^[ \t]*\*\*AC[-#\s]?(\d+)\b/, example: '**AC-1: título**' },
  { name: 'ac-vineta-titulada', numbered: true, re: /^[ \t]*[-*][ \t]+\*\*AC[-#\s]?(\d+)\b(?!\*\*)/, example: '- **AC1 — título**: texto' },
  // Gherkin y «Dado» sin importar mayúsculas, con viñeta o sin ella, y «Dada/Dados/Dadas»: sólo cuentan cuando la
  // story no usa ninguna forma vieja, así que una línea de prosa que empiece así no suma criterios a una story normal.
  { name: 'gherkin', numbered: false, re: /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?given\b/i, example: 'GIVEN … / WHEN … / THEN … (suelto o en un bloque ```gherkin)' },
  { name: 'dado', numbered: false, re: /^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?dad[oa]s?\b/i, example: '**Dado** … **Cuando** … **Entonces** …' },
];
const FORM = Object.fromEntries(AC_FORMS.map((f) => [f.name, f]));
const OLD_FORMS = ['titulo-ac', 'numerada', 'vineta-ac'];

// Con qué forma nueva escribe la story sus criterios, si las viejas no dan ninguno: `{ form, starts }`, con un
// arranque por criterio (`n` = su número). Lee también dentro de los bloques ``` (el Gherkin vive ahí).
function newFormStarts(section) {
  const lines = section.split('\n');
  const numbered = [];
  for (let i = 0; i < lines.length; i++) {
    for (const name of ['ac-negrita', 'ac-vineta-titulada']) {
      const m = FORM[name].re.exec(lines[i]);
      if (m) { numbered.push({ line: i, n: parseInt(m[1], 10) }); break; }
    }
  }
  if (numbered.length) return { form: 'ac-numerada', starts: numbered };
  for (const name of ['gherkin', 'dado']) {
    const starts = [];
    lines.forEach((l, i) => { if (FORM[name].re.test(l)) starts.push({ line: i, n: starts.length + 1 }); });
    if (starts.length) return { form: name, starts };
  }
  return { form: null, starts: [] };
}

// ACs declarados en `## Acceptance Criteria`. Dos estilos conviven en el repo y son
// EXCLUYENTES entre sí — la story declara sus ACs como headings `### AC-N — …` O como
// una lista numerada, nunca las dos cosas:
//   (a) headings `### AC-N`, con listas numeradas ADENTRO que son sub-criterios
//   (b) lista numerada `N. …` corrida, con headings que son títulos de GRUPO
//   (c) bullets `- **ACN**: texto` (stories `epic: Hotfix` escritas en prosa)
//
// 🔴 Cómo se distingue (a) de (b). Un criterio que devuelve SOLO los headings AC-N y corta convierte
// todo caso (b) en subconteo silencioso: un spec con 11 headings de grupo y 42 ACs numerados daría
// 11 de 42, con 31 ACs invisibles para ACCOV-C5, la matriz runtime y la evidencia DoD por-AC. El
// criterio correcto no es la PRESENCIA de headings sino el ALCANCE de la numeración:
//   · Si los numerados reinician (`1,2,3,1,2,…`) son listas separadas, una por heading
//     ⇒ sub-criterios ⇒ mandan los headings. (8 headings, numerados que reinician en 1.)
//   · Si corren como UNA sola secuencia creciente que además pasa el último heading
//     ⇒ los headings no alcanzan a nombrarlos ⇒ la lista ES el universo de ACs.
//     (headings hasta AC11, numerados 1→42.)
//   · Una sola corrida que NO pasa el último heading son los sub-items del primer heading
//     ⇒ mandan los headings. (6 headings, 3 sub-items dentro de AC1.)
// El "pasa el último heading" es lo que separa una lista de ACs de tres sub-items de un único
// heading: sin esa condición, los sub-items también forman corrida creciente y se leen como ACs.
//
// 🔴 El universo numerado es TODO item numerado, no solo los que arrancan con `**`. El fallback
// plano solo corre con CERO matches: una story que mezcla estilos (`1. **Given** …` junto a
// `12. texto pelado`) contaría solo los bold y descartaría el resto en silencio. El riesgo que
// motivaría el filtro (listas numeradas anidadas en prosa) se midió sobre el corpus de stories: no
// cambia ni un universo. Y el error que evita es peor que el que causaría — un AC de más se ve como
// finding ruidoso de ACCOV-C5 y un humano lo resuelve; un AC de menos es un verde falso que nadie ve.
function parseAcsFromSpec(specContent) {
  if (!specContent) return [];
  const section = acSectionOf(specContent);
  if (section == null) return [];
  const uniq = (arr) => [...new Set(arr)].sort((a, b) => a - b);
  const all = (form) => [...section.matchAll(new RegExp(FORM[form].re.source, 'gm'))].map((m) => parseInt(m[1], 10));
  // `AC-1`, `AC 1`, `AC#1` y `AC1` son todas notaciones vivas en el corpus.
  const headings = all('titulo-ac');
  const numbered = all('numerada');  // en ORDEN DE DOCUMENTO: el orden es la señal de reinicio
  const bullets = all('vineta-ac');
  if (!headings.length && !numbered.length && !bullets.length) return uniq(newFormStarts(section).starts.map((s) => s.n));

  if (headings.length) {
    let singleRun = numbered.length > 0;
    for (let i = 1; i < numbered.length; i++) {
      if (numbered[i] <= numbered[i - 1]) { singleRun = false; break; }
    }
    const alcanzaMas = numbered.length && Math.max(...numbered) > Math.max(...headings);
    return uniq(singleRun && alcanzaMas ? numbered : headings);
  }
  if (numbered.length) return uniq(numbered);
  return uniq(bullets);
}

// Los criterios de la story y, si no hay ninguno, por qué: `{ acs, found, reason }`. `found` dice si tiene título de
// criterios. Lo usan los que fallan cerrado ante una story sin criterios: el set de revisores y el pre-commit.
function criteriaOf(specContent) {
  const found = storySection(specContent || '', 'criteria') !== null;
  const acs = parseAcsFromSpec(specContent);
  const reason = acs.length ? null
    : found ? `la sección de criterios no trae ninguna forma reconocida (${AC_FORMS.map((f) => f.example).join(' · ')})`
      : 'no tiene título de criterios (`## Acceptance Criteria` o `## Criterios de aceptación`, con ## o ###)';
  return { acs, found, reason };
}

// AC → su TEXTO, para poder MOSTRARLE al usuario qué está aprobando.
//
// 🔴 Por qué existe: el prompt de `marker.js runtime-waiver` muestra la RAZÓN por la que un AC no se
// puede verificar corriendo, y el test que lo cubre — pero el texto del AC también hace falta. Sin él,
// el usuario aprueba saltear la verificación de algo que el propio prompt no le dice qué es: la excusa
// sin el hecho.
//
// Devuelve `{ [n]: texto }` — prosa aplanada y acotada, apta para un prompt de terminal. Best-effort
// por diseño: si un AC no se puede aislar, se omite del mapa y el llamador cae a su texto de siempre
// (nunca rompe el waiver por no poder citar). Cubre los tres estilos que `parseAcsFromSpec` reconoce:
// heading (`### AC-1`), lista numerada (`1. **Given** …`) y bullet (`- **AC1**`).
function acTextsFromSpec(specContent, { maxChars = 600 } = {}) {
  const out = {};
  if (!specContent) return out;
  const section = acSectionOf(specContent);
  if (section == null) return out;
  const lines = section.split('\n');
  // Marcadores de arranque de AC, en el mismo orden de preferencia que parseAcsFromSpec: las formas viejas y, si no
  // hay ninguna, la otra forma que use la story. El Gherkin vive dentro de los bloques ```: en esa
  // forma el contenido del bloque se lee.
  const OLD_START = OLD_FORMS.map((name) => FORM[name].re);
  const hasOld = lines.some((l) => OLD_START.some((re) => re.test(l)));
  const nueva = hasOld ? null : newFormStarts(section);
  const nuevaPorLinea = new Map(nueva ? nueva.starts.map((s) => [s.line, s.n]) : []);
  const leerBloques = !!nueva && nueva.form === 'gherkin';
  const startOf = (line, i) => {
    if (nueva) return nuevaPorLinea.has(i) ? nuevaPorLinea.get(i) : null;
    for (const re of OLD_START) {
      const m = re.exec(line);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };
  let cur = null;
  let buf = [];
  let enFence = false; // dentro de un ``` … ``` — su contenido no es prosa del AC (salvo en Gherkin)
  const flush = () => {
    if (cur === null) return;
    const texto = limpiarProsa(buf.join(' '), maxChars);
    // First-wins: en una story con headings Y numerados, el primero que aparece es el que nombra al AC.
    if (texto && out[cur] === undefined) out[cur] = texto;
    cur = null;
    buf = [];
  };
  for (const [i, raw] of lines.entries()) {
    // El filtrado de fences y citas es POR LÍNEA y va acá, no en `limpiarProsa`: una vez que las
    // líneas se juntan en un solo string, `^`/`$` no distinguen dónde empieza cada una.
    if (/^[ \t]*```/.test(raw)) { enFence = !enFence; continue; }
    if (enFence && !leerBloques) continue;
    const n = startOf(raw, i);
    if (n !== null) {
      flush();
      cur = n;
      buf = [raw];
      continue;
    }
    // Un heading de nivel 2-4 que NO es un AC cierra el bloque (`### Tests`, `### Doctrina`, …).
    if (/^#{2,4}[ \t]+\S/.test(raw)) { flush(); continue; }
    // Las citas son notas al margen del autor (correcciones, decisiones, historia) — no el AC.
    if (/^[ \t]*>/.test(raw)) continue;
    if (cur !== null) buf.push(raw);
  }
  flush();
  return out;
}

// Prosa de markdown → una línea legible en una terminal: sin marcadores de AC, sin citas, sin
// bloques de código, sin énfasis, sin backticks, espacios colapsados y con tope de largo.
function limpiarProsa(s, maxChars) {
  let t = String(s || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');            // bloques de código enteros
  t = t.replace(/^\s*#{2,4}\s+AC[-#\s]?\d+\s*:?\s*/i, ' '); // "### AC-3:"
  t = t.replace(/^\s*\d+\.\s+/, ' ');                // "3. "
  t = t.replace(/^\s*-\s+\*\*AC[-#\s]?\d+\*\*\s*:?\s*/i, ' ');
  t = t.replace(/^\s*>.*$/gm, ' ');                  // blockquotes (notas, correcciones)
  t = t.replace(/\|/g, ' ');                         // tablas embebidas
  // Énfasis. El `_` SÓLO cuenta como énfasis si NO está entre caracteres de palabra: si no,
  // `ERROR_CASE` se muestra como `ERRORCASE` y el AC que el tester lee deja de decir lo que dice
  // el spec.
  t = t.replace(/\*\*|\*/g, '');
  t = t.replace(/(^|\W)__(?=\S)|(?<=\S)__($|\W)/g, '$1$2');
  t = t.replace(/(^|\W)_(?=\S)|(?<=\S)_($|\W)/g, '$1$2');
  t = t.replace(/`/g, '');                           // backticks
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars - 1).trimEnd()}…`;
  return t;
}

// Tabla de Tests → rows { tid, name, acRefs:[n], nivel, raw } + `warnings`.
// Detecta columnas por header (T-ID/ID, Test/Nombre, AC, Nivel) con fallback
// posicional (col 0 = id, col 1 = nombre). acRefs: columna AC si existe, sino
// cualquier `AC ?#?N` en el texto de la fila (práctica actual texto-libre).
//
// 🔴 El heading se acepta en CUALQUIER nivel, no solo `### Tests`. story-format.md §6 lo escribe
// como H3, pero varias stories del corpus lo tienen como `## Tests`; un regex literal `### Tests`
// devolvería `found:false` con `rows:[]`. Downstream eso no se lee como "no pude parsear" sino como
// "no hay tests": la matriz runtime pierde su voto de la columna AC (runtime-matrix.js une sección ∪
// tabla justamente como defensa contra parsers que subcuentan) y ACCOV-C5 emite un CRITICAL FALSO
// ("la story NO tiene tabla ### Tests") sobre stories que sí la tienen. Si además la sección AC no
// parsea, no queda señal de ningún tipo.
//
// 🔴 Y devuelve `warnings` en vez de callar: una tabla que no se pudo leer tiene que
// distinguirse de una story sin tests. Con las dos dando `rows: []` el consumidor no
// podría separarlas — que es la forma exacta del falso verde que este archivo existe
// para cerrar. Campo aditivo: los consumidores que solo leen rows/found no se enteran.
function parseTestsTable(specContent) {
  const empty = (extra) => ({ rows: [], hasAcColumn: false, found: false, headingLevel: 0, warnings: [], ...extra });
  if (!specContent) return empty();
  const body = stripFrontmatter(specContent);
  const sec = storySection(specContent, 'tests');
  if (!sec) {
    // ¿Hay una tabla markdown en el cuerpo pero ningún heading `Tests`? Entonces el
    // problema es el heading, y callar sería exactamente el modo de falla de arriba.
    const w = /^[ \t]*\|.*\|/m.test(body)
      ? ['No se encontró ningún heading `Tests` (esperaba `### Tests`, story-format §6), pero el cuerpo tiene tablas markdown — si la tabla de tests está bajo otro título, este parser NO la ve.']
      : [];
    return empty({ warnings: w });
  }
  const headingLevel = sec.level;
  const warnings = [];
  if (headingLevel !== 3) {
    warnings.push(`La tabla de tests está bajo un heading H${headingLevel} (\`${'#'.repeat(headingLevel)} Tests\`); story-format §6 la define como H3 (\`### Tests\`). Se parseó igual, pero conviene normalizarla.`);
  }
  const lines = sec.text.split('\n').filter((l) => /^\s*\|/.test(l));
  if (lines.length < 2) {
    return empty({
      found: true, headingLevel,
      warnings: [...warnings, 'Hay un heading `Tests` pero NO se pudo leer ninguna fila de tabla debajo (¿tabla sin filas, o escrita en otro formato?). Todo check que valide "cada AC tiene test" estaría validando contra CERO tests.'],
    });
  }

  const splitRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const header = splitRow(lines[0]).map((h) => h.toLowerCase().replace(/\*/g, ''));
  const idx = {
    tid: header.findIndex((h) => /^(t-?id|id)$/.test(h)),
    name: header.findIndex((h) => /test|nombre|descrip/.test(h)),
    ac: header.findIndex((h) => /^acs?$/.test(h)),
    nivel: header.findIndex((h) => /nivel|level|tipo/.test(h)),
  };
  if (idx.tid === -1) idx.tid = 0;
  if (idx.name === -1) idx.name = Math.min(1, header.length - 1);

  const rows = [];
  for (const line of lines.slice(1)) {
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue; // separador |---|---|
    const cells = splitRow(line);
    if (cells.every((c) => c === '')) continue;
    const tid = (cells[idx.tid] || '').replace(/\*/g, '').trim();
    const name = (cells[idx.name] || '').replace(/\*/g, '').trim();
    const acRefs = new Set();
    const acSource = idx.ac !== -1 ? (cells[idx.ac] || '') : cells.join(' ');
    for (const am of acSource.matchAll(/(?:AC\s*)?#\s*(\d+)|(?:^|[\s,])(\d+)(?:\.\d+)?(?=[\s,]|$)/g)) {
      // Con columna AC dedicada aceptamos números pelados; en texto libre solo `AC #N`/`#N`.
      // Notación sub-AC `N.M` (ej `2.6` = sub-item 6 de AC-2) resuelve al AC padre N:
      // sin eso, `2.6` daría acRefs=[] y el test no cubriría nada.
      if (idx.ac !== -1) {
        const n = am[1] || am[2];
        if (n) acRefs.add(parseInt(n, 10));
      } else if (am[1]) {
        acRefs.add(parseInt(am[1], 10));
      }
    }
    if (tid || name) {
      rows.push({ tid, name, acRefs: [...acRefs], nivel: idx.nivel !== -1 ? (cells[idx.nivel] || '') : null, raw: line.trim() });
    }
  }
  if (!rows.length) {
    warnings.push('La tabla de tests se encontró pero NO produjo ninguna fila utilizable (¿solo header y separador?). Todo check que valide "cada AC tiene test" estaría validando contra CERO tests.');
  }
  return { rows, hasAcColumn: idx.ac !== -1, found: true, headingLevel, warnings };
}

// Bloque frontmatter `pipelines:` → [{ name, status, acs:[N], acsPending:[N], pendingItems:[texto] }].
// Acepta las DOS formas que conviven en el repo:
//   (a) LISTA — la que documenta story-format.md §1.1 y valida tycon-story-validator VAL-C6:
//         pipelines:
//           - name: A-backend
//             status: done
//             acs: [1, 2]
//           - name: C-frontend
//             status: blocked
//             acs_pending: [7]
//   (b) MAPA — la forma de mapa (sigue apareciendo en stories viejas):
//         pipelines:
//           A-backend:
//             status: done
// Lee las dos formas: una story escrita como la guía manda (lista) y la de mapa. `acs`/`acs_pending`
// se extraen de arrays inline `[..]`.
function parsePipelinesBlock(specContent) {
  const fmMatch = (specContent || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const lines = fmMatch[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^pipelines\s*:\s*$/.test(l));
  if (start === -1) return [];
  const parseIntArray = (raw) =>
    (raw.match(/-?\d+/g) || []).map(Number); // "[0, 1, 2]" → [0,1,2]; tolera comentario inline
  const out = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // fin del bloque pipelines
    // (a) LISTA: `  - name: X` abre una entrada. Se chequea ANTES que el pendingItem genérico
    // (`- texto`) para no tragarse el `- name:` como un ítem pendiente.
    const listNameM = line.match(/^\s*-\s*name\s*:\s*["']?([\w-]+)/);
    if (listNameM) { current = { name: listNameM[1], status: null, blockedBy: null, acs: [], acsPending: [], pendingItems: [] }; out.push(current); continue; }
    // (b) MAPA: `  X:` (indent 2, valor vacío) abre una entrada.
    const mapNameM = line.match(/^\s{2}([\w-]+)\s*:\s*$/);
    if (mapNameM && indent === 2) { current = { name: mapNameM[1], status: null, blockedBy: null, acs: [], acsPending: [], pendingItems: [] }; out.push(current); continue; }
    if (!current) continue;
    const statusM = line.match(/^\s+status\s*:\s*["']?([\w-]+)/);
    if (statusM) { current.status = statusM[1]; continue; }
    // `blocked_by`: lo lee VAL-C6 sin modelo. Sin comillas ni comentario inline; vacío → ''.
    const blockedM = line.match(/^\s+blocked_by\s*:\s*(.*?)\s*$/);
    if (blockedM) { current.blockedBy = blockedM[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim(); continue; }
    const acsM = line.match(/^\s+acs\s*:\s*(\[.*\])/);
    if (acsM) { current.acs = parseIntArray(acsM[1]); continue; }
    const acsPendM = line.match(/^\s+acs_pending\s*:\s*(\[.*\])/);
    if (acsPendM) { current.acsPending = parseIntArray(acsPendM[1]); continue; }
    const itemM = line.match(/^\s+-\s*(.+?)\s*$/);
    if (itemM) current.pendingItems.push(itemM[1].replace(/^["']|["']$/g, ''));
  }
  return out;
}

// ACs legítimamente diferidos = `acs_pending` de cualquier pipeline cuyo status NO es `done`.
// story-format.md §1.1: un AC en `acs_pending` de un pipeline blocked/pending está declarado como
// diferido con su razón — no es un gap de cobertura, es deuda documentada.
function deferredAcs(specContent) {
  const set = new Set();
  for (const p of parsePipelinesBlock(specContent)) {
    if (p.status && p.status !== 'done') for (const n of p.acsPending) set.add(n);
  }
  return set;
}

// ── Búsqueda en código ────────────────────────────────────────────────────────

// 🔴 `.test.sh` también es prueba: el arnés declara sus suites en bash (`scripts/tests/*.test.sh`,
// registradas en `scripts/tests/suites.json`). Sin esta extensión, `walkFiles` no las abre y
// ACCOV-C1 da CRITICAL falso por «test declarado sin implementación»: los tests con sufijo (T2b, T3b)
// aparecen ausentes estando rotulados literalmente en la suite, mientras los T-ID numéricos «pasan» por
// coincidencia de substring en OTRAS suites `.js`. Un CRITICAL mecánico falso cuesta una vuelta de
// advisor y enseña a desconfiar del control.
// Qué es prueba y qué es código lo dice lib/code-files.js (pytest, Go, .NET, JS/TS y suites bash), con lo
// que sume la organización. `TEST_FILE_RE` y `CODE_EXT_RE` quedan con su nombre para los llamadores de este módulo.
const codeFiles = require('./code-files.js');
const TEST_FILE_RE = { test: (f) => codeFiles.isTestFile(f) };
function isCodeFile(f, { extra } = {}) {
  return codeFiles.isSource(f, { extra: extra !== undefined ? extra : require('./stack-config.js').orgExtra() });
}
const CODE_EXT_RE = { test: (f) => isCodeFile(f) };

// Walk recursivo acotado (skip node_modules/bin/obj/.git). Cap de archivos para
// repos gigantes — los checks son sobre el delta de la story, no un sweep total.
/**
 * Raíces de los repos compañeros (absolutas, existentes). Con la story en un repo git, la búsqueda de la evidencia
 * (lib/companion-repos.js): el worktree del compañero en la rama de la story, y si no hay, el declarado con su aviso.
 * Desde un worktree, la ruta declarada puede caer en un checkout de otra tarea y el control leería sus pruebas. Con la
 * story fuera de un repo git, los declarados tal cual: esa búsqueda tomaría la rama de `--repo`. Un declarado que no
 * está en disco se avisa: si no, el crítico por la prueba que no encuentra parece real. Fail-open: sin config, o con la
 * config rota, [].
 */
function companionRoots(repo, storyPath) {
  try {
    const faltante = (nombre, quien) => process.stderr.write(
      `[hermanos] el repo hermano «${nombre}» que declara ${quien}/.tycon/advisors.yaml no está en disco: sus pruebas NO se leen\n`);
    let roots;
    if (storyPath && repoDeLaStory(storyPath)) {
      roots = require('./companion-repos.js').companionRoots(repo, storyPath, { onMissing: faltante });
    } else {
      const ev = require('./evidence-config.js').parseEvidenceConfig(repo);
      for (const m of ev.missing || []) faltante(m, repo);
      roots = ev.roots;
    }
    return Array.isArray(roots) ? roots.filter((r) => path.resolve(r) !== path.resolve(repo)) : [];
  } catch { return []; }
}

/** La raíz del repo git donde vive la story (la carpeta con `.git`, archivo o carpeta), o null fuera de un repo. */
function repoDeLaStory(storyPath) {
  let d = path.dirname(path.resolve(storyPath));
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const arriba = path.dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

function walkFiles(root, predicate, cap = 8000) {
  const out = [];
  const stack = [root];
  // `venv`, `site-packages` y `__pycache__` (Python): las pruebas de los paquetes instalados llenarían el tope antes de
  // llegar a las del proyecto, y ACCOV-C1 daría un crítico falso (casos: tests/code-files.test.js).
  const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.next', 'coverage', 'playwright-report', 'test-results',
    'venv', 'site-packages', '__pycache__']);
  // Cap de DIRECTORIOS visitados: un cap sólo sobre archivos MATCHEADOS deja pasar un monorepo con
  // pocos matches pero miles de dirs, que se walkea entero en cada invocación inline.
  let dirsVisited = 0;
  const DIR_CAP = 4000;
  while (stack.length && out.length < cap && dirsVisited++ < DIR_CAP) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(dir, e.name));
      } else if (predicate(e.name, path.join(dir, e.name))) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  return out;
}

// ¿Existe implementación para un test declarado en la tabla?
// Orden de matching (de más fuerte a más débil):
//   1. Trait/tag del contrato: [Trait("AC","N")] con Story matching / '@story-X @ac-N'
//   2. T-ID literal (T1, FullUI-2, E2E-3...) en algún archivo de test.
//   3. Nombre PascalCase / texto del test (normalizado) como substring.
// normCache: norm(contenido-completo) se recomputaría por CADA fila de la tabla × CADA test file —
// O(rows×corpus). Cache por archivo.
const _normCache = new Map();
function findTestImplementation(testFiles, contentsCache, row, storyId) {
  const evidence = [];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameNorm = norm(row.name).slice(0, 60);
  for (const f of testFiles) {
    const c = contentsCache.get(f);
    if (!c) continue;
    // (1) contrato Trait/tag por AC
    if (storyId && row.acRefs.length) {
      const storyTagged = c.includes(`Trait("Story","${storyId}")`) || c.includes(`Trait("Story", "${storyId}")`) || c.includes(`@story-${storyId}`)
        || c.includes(`@pytest.mark.story("${storyId}")`) || c.includes(`@pytest.mark.story('${storyId}')`);
      if (storyTagged) {
        for (const ac of row.acRefs) {
          if (c.includes(`Trait("AC","${ac}")`) || c.includes(`Trait("AC", "${ac}")`) || c.includes(`@ac-${ac}`)
            || c.includes(`@pytest.mark.ac(${ac})`)) {
            evidence.push({ file: f, via: `contrato Trait/tag AC#${ac}` });
          }
        }
      }
    }
    // (2) T-ID literal
    if (row.tid && row.tid.length >= 2 && c.includes(row.tid)) {
      evidence.push({ file: f, via: `T-ID literal '${row.tid}'` });
    }
    // (3) nombre normalizado como substring (mín 12 chars para evitar matches triviales)
    if (nameNorm.length >= 12) {
      let nc = _normCache.get(f);
      if (nc === undefined || nc.__src !== c) {
        nc = Object.assign(Object.create(null), { __src: c, value: norm(c) });
        _normCache.set(f, nc);
      }
      if (nc.value.includes(nameNorm)) {
        evidence.push({ file: f, via: 'nombre del test (normalizado)' });
      }
    }
  }
  return evidence;
}

// ── Checks ────────────────────────────────────────────────────────────────────

/**
 * runStoryChecks({ repo, storyPath, files }) → {
 *   findings:  [{ rule, severity, status:'fail', detail }],   // mecánicamente CONFIRMADOS
 *   ambiguous: [{ rule, detail }],                            // requieren juicio LLM
 *   ok:        [{ rule, detail }],                            // checks que pasaron
 *   stats
 * }
 */
function runStoryChecks({ repo, storyPath, files = [] }) {
  const findings = [];
  const ambiguous = [];
  const ok = [];
  const story = readText(storyPath);
  if (!story) {
    return { findings: [], ambiguous: [{ rule: 'MECH', detail: `story ilegible: ${storyPath}` }], ok: [], stats: {} };
  }
  const fmStoryId = (story.match(/^story\s*:\s*["']?([\w.\-]+)/m) || [])[1] || null;
  const acs = parseAcsFromSpec(story);
  const table = parseTestsTable(story);

  // Cache de contenidos de test files del repo (una pasada).
  // Los tests pueden vivir en un repo COMPAÑERO declarado (`.tycon/advisors.yaml →
  // evidence.companion_repos`, el mismo mecanismo de la evidencia de DoD): mirar sólo este repo daría
  // CRITICAL falso para los tests que viven en el compañero. Sin config o con el módulo ausente → sólo este repo.
  // la ruta relativa a la raíz: `tests/api/helpers.py` es prueba de pytest por la carpeta, no por el nombre
  const esPrueba = (raiz) => (n, abs) => TEST_FILE_RE.test(abs ? path.relative(raiz, abs) : n);
  const testFiles = walkFiles(repo, esPrueba(repo));
  const companeros = companionRoots(repo, storyPath);
  for (const raiz of companeros) {
    for (const f of walkFiles(raiz, esPrueba(raiz))) if (!testFiles.includes(f)) testFiles.push(f);
  }
  const contentsCache = new Map();
  for (const f of testFiles) contentsCache.set(f, readText(f));

  // ── ACCOV-C5: cada AC con ≥1 test asignado en la tabla ──
  if (acs.length && table.found) {
    const covered = new Set(table.rows.flatMap((r) => r.acRefs));
    // Un AC en `acs_pending` de un pipeline no-done está declarado como diferido (story-format §1.1)
    // — NO es un gap de cobertura. El propio mensaje de C5 ofrece esta salida ("o marca literal de
    // deferral en pipelines:"): sin ella se bloquearían las stories que sí declaran su deferral
    // como manda la guía.
    const deferred = deferredAcs(story);
    const uncovered = acs.filter((a) => !covered.has(a) && !deferred.has(a));
    if (uncovered.length) {
      if (table.hasAcColumn) {
        findings.push({
          rule: 'ACCOV-C5', severity: 'CRITICAL', status: 'fail',
          detail: `ACs sin test asignado en la tabla ### Tests (columna AC): ${uncovered.map((n) => `#${n}`).join(', ')}. Cada AC necesita ≥1 T-ID (o marca literal de deferral en pipelines:).`,
        });
      } else {
        // Sin columna AC el mapping es texto-libre → no se puede confirmar mecánicamente.
        ambiguous.push({
          rule: 'ACCOV-C5',
          detail: `La tabla ### Tests no tiene columna AC; refs texto-libre no cubren: ${uncovered.map((n) => `#${n}`).join(', ')}. Confirmar con juicio (¿el test cubre el AC aunque no lo cite?) o agregar columna AC (story-format §6).`,
        });
      }
    } else {
      ok.push({ rule: 'ACCOV-C5', detail: `${acs.length} ACs, todos con ≥1 test asignado en la tabla.` });
    }
  } else if (acs.length && !table.found) {
    findings.push({ rule: 'ACCOV-C5', severity: 'CRITICAL', status: 'fail', detail: `La story tiene ${acs.length} ACs pero NO tiene tabla ### Tests.` });
  } else if (!acs.length) {
    // 🔴 NO CALLARSE cuando el parseo falla. Las dos ramas de arriba piden `acs.length`, así que
    // una story cuya sección AC no parsea saldría del check sin emitir NADA — ni finding, ni
    // ambiguous, ni ok. Y "sin findings" downstream se lee como "pasó", que es el falso verde
    // estructural exacto que ACCOV-C5 existe para cerrar: la story se ve limpia porque el
    // instrumento no pudo mirarla. Es `ambiguous` y no `finding` porque una story legítimamente
    // sin ACs existe (spikes, chores) — pero pasa por juicio, no por silencio.
    ambiguous.push({
      rule: 'ACCOV-C5',
      detail: acSectionOf(story) == null
        ? 'No se encontró la sección de criterios (`## Acceptance Criteria` o `## Criterios de aceptación`, con ## o ###, a principio de línea y fuera del frontmatter). Sin ACs parseables NINGÚN check de cobertura por-AC puede correr — confirmar si la story realmente no tiene ACs o si el formato los está escondiendo.'
        : `La sección de criterios existe pero no se pudo extraer ningún AC de ella (formas reconocidas: ${AC_FORMS.map((f) => f.example).join(' · ')}; story-format.md §6). Sin ACs parseables NINGÚN check de cobertura por-AC puede correr.`,
    });
  }
  // Una tabla que no se pudo leer NO es lo mismo que una story sin tests — se avisa.
  for (const w of (table.warnings || [])) ambiguous.push({ rule: 'ACCOV-C5', detail: w });

  // ── ACCOV-C1: cada test de la tabla existe implementado ──
  if (table.rows.length) {
    const missing = [];
    const weak = [];
    for (const row of table.rows) {
      const ev = findTestImplementation(testFiles, contentsCache, row, fmStoryId);
      if (ev.length === 0) missing.push(row);
      else if (!ev.some((e) => e.via.startsWith('contrato') || e.via.startsWith('T-ID'))) weak.push({ row, ev });
    }
    if (missing.length) {
      findings.push({
        rule: 'ACCOV-C1', severity: 'CRITICAL', status: 'fail',
        detail: `Tests de la tabla SIN implementación encontrada (grep por Trait/tag, T-ID y nombre sobre ${testFiles.length} test files): ${missing.map((r) => r.tid || r.name).join(' | ')}`,
      });
    }
    for (const w of weak) {
      ambiguous.push({
        rule: 'ACCOV-C1',
        detail: `'${w.row.tid || w.row.name}' solo matchea por nombre normalizado (${w.ev[0].file}) — confirmar que ES ese test (no homónimo) y que no es tautológico (ACCOV-C3).`,
      });
    }
    if (!missing.length && !weak.length) {
      ok.push({ rule: 'ACCOV-C1', detail: `${table.rows.length} tests de la tabla, todos con implementación encontrada.` });
    }
  }

  // ── DEFTR-C1: items pending del bloque pipelines: con trazabilidad ──
  const pipelines = parsePipelinesBlock(story);
  const pendingPipelines = pipelines.filter((p) => p.status && p.status !== 'done');
  if (pendingPipelines.length) {
    // la deuda se anota en el repo de la story: si la story vive en otro repo que el código (las del arnés viven en el
    // privado), se lee también su tasks/todo.md
    const raices = [path.resolve(repo)];
    const raizStory = repoDeLaStory(storyPath);
    if (raizStory && !raices.includes(raizStory)) raices.push(raizStory);
    const todoMd = raices.map((r) => readText(path.join(r, 'tasks', 'todo.md'))).join('\n');
    const deferralTag = fmStoryId ? `Story-${fmStoryId}-deferral` : null;
    const codeHasTag = deferralTag
      ? testFiles.some((f) => (contentsCache.get(f) || '').includes(deferralTag)) ||
        walkFiles(repo, (n) => CODE_EXT_RE.test(n) && !TEST_FILE_RE.test(n), 4000)
          .some((f) => readText(f).includes(deferralTag))
      : false;
    // el número entero de la story: el de otra story que empieza igual (uno más largo, o con un punto más) no cuenta
    const todoHasStory = fmStoryId
      ? new RegExp(`(^|[^\\w.])${fmStoryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w]|\\.\\d)`, 'm').test(todoMd)
      : false;
    if (!codeHasTag && !todoHasStory) {
      findings.push({
        rule: 'DEFTR-C1', severity: 'CRITICAL', status: 'fail',
        detail: `pipelines pending (${pendingPipelines.map((p) => p.name).join(', ')}) sin trazabilidad: no hay TODO(${deferralTag || 'Story-N-deferral'}) en código ni mención de la story en tasks/todo.md (${raices.length > 1 ? 'ni en el del código ni en el de la story' : 'del repo'}). Deuda fantasma.`,
      });
    } else {
      ok.push({ rule: 'DEFTR-C1', detail: `pipelines pending con trazabilidad (${codeHasTag ? 'TODO en código' : ''}${codeHasTag && todoHasStory ? ' + ' : ''}${todoHasStory ? 'tasks/todo.md' : ''}).` });
    }
  }

  // ── DEFTR-C2: skips en los files del diff sin anotación de deferral ──
  const diffTestFiles = files.filter((f) => TEST_FILE_RE.test(f));
  for (const f of diffTestFiles) {
    const abs = path.isAbsolute(f) ? f : path.join(repo, f);
    const c = readText(abs);
    if (!c || !codeFiles.hasSkipMark(c, f)) continue;
    const annotated = /deferral|Story-[\w.]+-deferral|pipelines\./i.test(c);
    if (!annotated) {
      findings.push({
        rule: 'DEFTR-C2', severity: 'WARNING', status: 'fail',
        detail: `${f} tiene tests skippeados sin anotación de deferral (esperaba comentario con 'Story-N-deferral' o referencia a pipelines.X).`,
      });
    }
  }

  // ── WIRING-C1: componente React exportado nuevo sin uso externo ──
  const newComponents = files.filter((f) => /\.tsx$/.test(f) && !TEST_FILE_RE.test(f) && !/\.stories\./.test(f));
  if (newComponents.length) {
    const allCodeFiles = walkFiles(repo, (n) => /\.(ts|tsx)$/.test(n), 6000);
    // Cache de contenidos: sin él se releería CADA archivo del repo POR componente nuevo
    // (O(componentes×corpus) de I/O).
    const codeCache = new Map();
    const readCached = (f2) => {
      let v = codeCache.get(f2);
      if (v === undefined) { v = readText(f2); codeCache.set(f2, v); }
      return v;
    };
    for (const f of newComponents) {
      const abs = path.isAbsolute(f) ? f : path.join(repo, f);
      const c = readText(abs);
      const expM = c.match(/export\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w+)/);
      if (!expM) continue;
      const compName = expM[1];
      const absNorm = path.resolve(abs);
      const used = allCodeFiles.some((other) => {
        if (path.resolve(other) === absNorm) return false;
        const oc = readCached(other);
        return oc.includes(compName);
      });
      if (!used) {
        ambiguous.push({
          rule: 'WIRING-C1',
          detail: `Componente '${compName}' (${f}) exportado y SIN referencias en otros .ts/.tsx del repo — posible 'código done, feature dead'. Confirmar con juicio (¿se monta dinámicamente / vía registry / plugin.json?).`,
        });
      }
    }
  }

  return {
    findings,
    ambiguous,
    ok,
    stats: {
      acs: acs.length,
      table_rows: table.rows.length,
      table_has_ac_column: table.hasAcColumn,
      test_files_scanned: testFiles.length,
      companion_roots: companeros,
      story_id: fmStoryId,
    },
  };
}

// ── VAL-C5 / VAL-C6 sin modelo ──────────────────────────────────────────────────────────────────
//
// Las dos reglas por las que el validador de stories se re-lanza después de implementar son chequeos
// mecánicos: una marca de deuda de la PROPIA story en un archivo tocado (VAL-C5) y una tanda `blocked`
// sin causa (VAL-C6). Medido: VAL-C5 tiene 0 hallazgos.
// Corren acá para que `pipeline.js` pueda dejar de relanzar al validador en un re-loop sin perder
// esas dos reglas.
//
// 🔴 APARTE de `runStoryChecks` a propósito: ésa la consume `on-pre-commit.js`, y un CRITICAL nuevo ahí
//    frenaría commits que hoy pasan. Ésta la usa sólo la decisión del re-loop.
const BLOCKED_BY_VACIO = new Set(['', 'tbd', 'unknown', '?', '-', 'n/a']);

/** Las marcas de deuda de UNA story, con el id exacto (`2.10` no es `2.1`). */
function patronesDeDeuda(id) {
  const n = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fin = '(?![\\w]|\\.\\d)';
  return [
    new RegExp(`TODO\\(Story-${n}-deferral\\)`),
    new RegExp(`\\b(?:FIXME|HACK|XXX):?\\s*Story\\s*${n}${fin}`),
    new RegExp(`\\[DEF-${n}-`),
    new RegExp(`\\bDEFERRED-${n}${fin}`),
    new RegExp(`\\bStory\\s*${n}${fin}\\s*deferred\\b`, 'i'),
    new RegExp(`\\bpendiente\\s*Story\\s*${n}${fin}`, 'i'),
    new RegExp(`\\bStory\\s*${n}${fin}\\s*pendiente\\b`, 'i'),
  ];
}

/**
 * VAL-C5 y VAL-C6 sin modelo. → { findings, ok, ambiguous }
 * `ambiguous` = no se pudo mirar algo (story ilegible o sin id, archivo ilegible): quien decide un
 * descuento lo trata como «no pude mirar» e invoca al validador.
 */
function runValidatorChecks({ repo, storyPath, files = [] }) {
  const findings = [];
  const ok = [];
  const ambiguous = [];
  const story = readText(storyPath);
  const id = (story.match(/^story\s*:\s*["']?([\w.\-]+)/m) || [])[1] || null;
  if (!story || !id) {
    return { findings, ok, ambiguous: [{ rule: 'VAL', detail: `story ilegible o sin id: ${storyPath}` }] };
  }
  const patrones = patronesDeDeuda(id);
  const propia = path.resolve(storyPath);
  for (const f of files) {
    const abs = path.resolve(path.isAbsolute(f) ? f : path.join(repo, f));
    if (abs === propia || /(^|[/\\])tasks[/\\]todo\.md$/.test(abs)) continue;
    let c;
    try { c = fs.readFileSync(abs, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') continue; // un archivo borrado por la story no tiene deuda
      ambiguous.push({ rule: 'VAL-C5', detail: `no pude leer ${f} (${(e && e.code) || 'error'})` });
      continue;
    }
    const lineas = c.split('\n');
    for (let i = 0; i < lineas.length; i++) {
      if (patrones.some((p) => p.test(lineas[i]))) {
        findings.push({ rule: 'VAL-C5', severity: 'CRITICAL', status: 'fail', detail: `${f}:${i + 1} tiene una marca de deuda de la propia story ${id}. No puede pasar a review con deuda abierta en el código (Gate 1 del DoD).` });
      }
    }
  }
  // «Sin deuda» sólo si se leyó todo: con un archivo sin leer, no mirado no es limpio.
  if (!findings.length && !ambiguous.length) ok.push({ rule: 'VAL-C5', detail: `sin marcas de deuda de la story ${id} en ${files.length} archivo(s).` });
  for (const p of parsePipelinesBlock(story)) {
    if (p.status !== 'blocked') continue;
    if (p.blockedBy === null || BLOCKED_BY_VACIO.has(String(p.blockedBy).toLowerCase())) {
      findings.push({ rule: 'VAL-C6', severity: 'CRITICAL', status: 'fail', detail: `la tanda ${p.name} está blocked sin blocked_by concreto (${p.blockedBy === null ? 'ausente' : `«${p.blockedBy}»`}).` });
    }
  }
  return { findings, ok, ambiguous };
}

module.exports = {
  runValidatorChecks,
  parseAcsFromSpec,
  acTextsFromSpec,
  parseTestsTable,
  parsePipelinesBlock,
  deferredAcs,
  runStoryChecks,
  walkFiles,
  acSectionOf,
  storySection,
  criteriaOf,
  AC_FORMS,
  TITLE_WORDS,
  stripFrontmatter,
  isCodeFile,
};
