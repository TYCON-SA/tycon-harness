#!/usr/bin/env node
/**
 * docs-no-clone.test.js — las guías dicen `~/.tycon`, «usar no es mantener» y el modo desarrollador, y ninguna nombra un
 * clon como forma de USAR el arnés (T35, la parte de las guías; las portadas públicas las
 * mide public-papers.test.js).
 *
 * Lo que caza: una guía que, en su sección de INSTALACIÓN, siga pidiendo `git clone` para usar el arnés. El clon queda
 * para quien lo mantiene (INSTALL.md §1b «Mantener el arnés: el clon», la portada «Modo desarrollador»): esas secciones
 * sí pueden clonar, y se nombran acá una por una.
 *
 *   T35a · cada guía de instalación dice `~/.tycon/harness` (donde vive la versión instalada) y «usar no es mantener».
 *   T35b · en las secciones de USO de cada guía no hay `git clone`; en las de MANTENER sí puede haber.
 *   T35c · INSTALL.md y la guía del mecanismo nombran el modo desarrollador (`link --local` / `link --managed`) como la
 *          forma de probar antes de publicar.
 *   T35d · el espejo: una guía de juguete con un `git clone` en su sección de uso falla; sin la frase, falla.
 *   T35e · las guías sin dos versiones. Una guía con versión propia en este repo, con bloques internos,
 *          obliga a un segundo pedido por cada cambio hecho en GitHub. Nueve de las once no viven en este repo: son
 *          del público, y lo que decían sólo para el equipo vive en `onboarding/interno/`.
 *          El INSTALL.md espera, declarado en la lista del repo adelgazado (`.tycon/internal-forms.json`, `own`); la
 *          guía de publicación se está yendo (vale declarada con sus bloques, o fuera de la lista sin ninguno).
 *          Se mide: ningún `.md` de lo que viaja trae un marcador de bloque, salvo las que esperan; la lista es la de un
 *          repo adelgazado, con las que esperan declaradas y las nueve sin declarar; y lo mudado está enlazado en su portada, dice
 *          de qué guía salió y queda fuera de la capa del equipo.
 *
 * DÓNDE CORRE: en el público solo, y sobre el árbol ARMADO de los nocturnos (lo privado del equipo con el público
 * encima). Qué mide en cada uno:
 *   · en los dos: la guía del mecanismo y la sección de uso de INSTALL.md (`~/.tycon/harness`, sin `git clone`), el
 *     espejo, y que ningún .md de lo que viaja traiga un marcador de bloque (en el público solo, ninguno; en el árbol
 *     armado, salvo las que esperan);
 *   · sólo en el árbol armado (se reconoce por `.tycon/internal-forms.json`, la lista del repo privado): las tres guías
 *     del alta del equipo (onboarding/), lo que dice la versión del equipo de INSTALL.md («usar no es mantener», el modo
 *     desarrollador y la sección §1b de quien mantiene, que el INSTALL.md del público no trae), la lista del repo
 *     adelgazado y dónde vive lo mudado. En el público solo eso sale SALTEADO o anunciado como NO MEDIDO —nunca verde
 *     por haberlo mirado—; en el árbol armado, que falte es rojo.
 * En un clon pelado del repo privado adelgazado las guías del público no están, y esta prueba lo dice.
 *
 * Correr: node --test scripts/tests/docs-no-clone.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const publicCopy = require('../publishing/public-copy.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** ¿El árbol armado de los nocturnos (lo privado del equipo con el público encima)? Lo dice la lista del repo privado. */
const ARMED = fs.existsSync(path.join(ROOT, '.tycon', 'internal-forms.json'));
const NOT_ARMED = 'NO MEDIDO en el público solo: es del repo privado del equipo (sólo se mide en el árbol armado, donde está .tycon/internal-forms.json)';

/** Las guías de instalación: el archivo, cómo se recorta su sección de USO y qué frases tiene que decir. */
const GUIDES = [
  {
    file: 'INSTALL.md',
    // la sección de uso: todo «## Instalación» (§1 a §6, hasta «## Setup opcional») MENOS §1b, que es lo de quien
    // mantiene (recortar en §1b dejaría §2-§6 sin mirar)
    use: (t) => {
      const whole = t.slice(t.indexOf('## Instalación'), t.indexOf('## Setup opcional'));
      const a = whole.indexOf('### 1b. Mantener el arnés'); const b = whole.indexOf('### 2.', a);
      return a < 0 ? whole : whole.slice(0, a) + whole.slice(b < 0 ? whole.length : b);
    },
    says: ['~/.tycon/harness'],
    // lo que dice la versión del equipo (bloques internos del repo privado); el INSTALL.md del público no lo trae
    saysArmed: ['usar no es mantener', 'link --local', 'link --managed'],
  },
  {
    file: 'onboarding/step-0-mac.md', team: true,
    use: (t) => t,
    says: ['~/.tycon/harness', 'usar el arnés no es mantenerlo', 'get-harness.sh'],
  },
  {
    file: 'onboarding/step-0-windows.md', team: true,
    use: (t) => t,
    says: ['.tycon\\harness', 'usar el arnés no es mantenerlo', 'get-harness.ps1'],
  },
  {
    file: 'onboarding/new-dev-harness-setup.md', team: true,
    // el bloque del prompt entero: es lo que el asistente ejecuta
    use: (t) => t.slice(t.indexOf('═══ INICIO DEL PROMPT ═══'), t.indexOf('═══ FIN DEL PROMPT ═══')),
    says: ['~/.tycon/harness', 'usar no es mantener'],
  },
  {
    file: 'guides/maintaining/mecanismo-de-instalacion.md',
    // la sección de los guiones de entrada (la que explica cómo se instala)
    use: (t) => { const s = t.indexOf('## Los guiones de entrada'); return t.slice(s, t.indexOf('\n## ', s + 3)); },
    says: ['usar el arnés no es mantenerlo', 'link --local', 'link --managed', 'no usa git ni lo pide'],
  },
];
const CLONE = /\bgit clone\b/;
/** Las líneas de un texto que piden clonar (la prosa y el código por igual). */
const cloneLines = (text) => text.split('\n').map((l, i) => ({ n: i + 1, l })).filter((x) => CLONE.test(x.l));
const whole = (t) => t;
/** Las guías que se miden en este árbol: las del alta del equipo (`team`) sólo en el árbol armado. */
const measured = () => {
  const out = GUIDES.filter((g) => !g.team || ARMED);
  const off = GUIDES.filter((g) => g.team && !ARMED).map((g) => g.file);
  if (off.length) console.log(`ℹ️  ${off.join(', ')}: ${NOT_ARMED}`);
  return out;
};

test('T35a Docs_SayTyconHome_UseIsNotMaintain', () => {
  for (const g of measured()) {
    const t = read(g.file);
    for (const s of [...g.says, ...(ARMED ? g.saysArmed || [] : [])]) assert.ok(t.includes(s), `${g.file}: falta «${s}»`);
    if (!ARMED && g.saysArmed) console.log(`ℹ️  ${g.file}: ${g.saysArmed.map((x) => `«${x}»`).join(', ')} — ${NOT_ARMED}`);
  }
});

test('T35b Docs_NoCloneToUse_CloneOnlyForMaintainers', () => {
  for (const g of measured()) {
    const t = read(g.file);
    const use = g.use(t);
    assert.ok(use.length > 200, `${g.file}: no encontré su sección de uso (recortó ${use.length} caracteres)`);
    assert.deepStrictEqual(cloneLines(use).map((x) => `${g.file}:${x.n}: ${x.l.trim().slice(0, 100)}`), [], `${g.file}: la sección de uso pide clonar`);
  }
  // el espejo de lo permitido: la sección de quien mantiene SÍ clona (si dejara de hacerlo, esta prueba lo dice). Esa
  // sección (§1b) es de la versión del equipo de INSTALL.md: en el público solo no está.
  if (!ARMED) { console.log(`ℹ️  INSTALL.md §1b (quien mantiene clona): ${NOT_ARMED}`); return; }
  const install = read('INSTALL.md');
  const maintain = install.slice(install.indexOf('### 1b. Mantener el arnés'), install.indexOf('### 2.'));
  assert.ok(cloneLines(maintain).length >= 2, 'INSTALL.md §1b: la sección de quien mantiene tiene que traer el clon (bash y PowerShell)');
});

test('T35c Docs_DeveloperMode_IsTheWayToTryBeforePublishing', () => {
  // el INSTALL.md del público no explica el modo desarrollador (lo hace la guía del mecanismo): sólo la versión del equipo
  for (const file of ARMED ? ['INSTALL.md', 'guides/maintaining/mecanismo-de-instalacion.md'] : ['guides/maintaining/mecanismo-de-instalacion.md']) {
    const t = read(file);
    assert.match(t, /link --local/, `${file}: no nombra link --local`);
    assert.match(t, /link --managed/, `${file}: no nombra link --managed`);
  }
  if (ARMED) assert.match(read('INSTALL.md'), /probarlo antes de publicar|probar un cambio antes de publicarlo/, 'INSTALL.md: el modo desarrollador es la forma de probar antes de publicar');
  else console.log(`ℹ️  INSTALL.md (el modo desarrollador): ${NOT_ARMED}`);
});

test('T35d Mirror_ToyGuideWithCloneOrWithoutPhraseFails', () => {
  const toy = `## Instalación\n\nmkdir -p ~/SourceCode && git clone <URL> el-arnes\n\n### 1b. Mantener el arnés\n`;
  assert.ok(cloneLines(GUIDES[0].use(toy)).length === 1, 'control: la guía de juguete con un clon en su sección de uso se detecta');
  assert.ok(!whole(toy).includes('usar no es mantener'), 'control: la guía de juguete sin la frase se detecta');
});

// ── T35e · las guías: sin dos versiones ──────────────────────────────────────────────

/** Las guías que tuvieron una versión interna (bloques internos, la marca de las rutas que no viajan) y son sólo del
 *  público: nueve de las once. En el repo privado adelgazado no están; llegan con el público encima. */
const PUBLIC_ONLY_GUIDES = [
  'README.md', 'INDEX.md',   // el índice de guías; README.md es la portada
  'guides/agent-architecture.md', 'guides/ci-gate.md', 'guides/codex-migration.md', 'guides/integrations/instinct-mining.md',
  'guides/maintaining/mecanismo-de-instalacion.md', 'guides/reglas-para-revisores.md',
  'guides/decisions/codex-etapa-d-retro-red.md', 'guides/decisions/controles-apagables-por-config-2026-08-25.md',
];
/** La que espera: el privado tiene la suya, con sus bloques internos, declarada en `own`. Dos casos de prueba que viven
 *  en el público exigen, cuando corren con lo privado, su texto interno: harness-place.test.js T13 y T35 (las líneas
 *  viejas declaradas y el párrafo de los dos nombres, adentro de las marcas del INSTALL). Mientras esté acá, un cambio
 *  de GitHub no llega solo: hay que traerlo a mano. El día que deje de esperar sale de `own`, pasa a la lista de
 *  arriba, y sus bloques, a `onboarding/interno/`. */
const STILL_WITH_AN_INTERNAL_FORM = ['INSTALL.md'];
/** Las que se están yendo del privado: ningún caso del público exige ya su texto interno, y el pedido del privado que
 *  saca su versión entra después que éste. Mientras tanto vale cualquiera de los dos estados, entero: declarada en
 *  `own` y con sus bloques, o fuera de `own` y sin ningún bloque. Cuando el privado la saca, pasa a PUBLIC_ONLY_GUIDES. */
const LEAVING = ['guides/maintaining/publicacion-espejo.md'];
/** Las carpetas que no viajan: ahí un marcador de bloque no publica nada (una story o una medición que lo cita como
 *  ejemplo). De onboarding/ quedan afuera sólo las SUBCARPETAS: los `.md` de su raíz son el texto del alta, que viaja a
 *  cada máquina del equipo, y nadie le saca un bloque por el camino. */
const NOT_TRAVELLING = /^(?:(?:specs|tasks|inbox|qa|_bmad|artifacts|new-product-templates|\.advisors|\.dashboard|\.engram)\/|onboarding\/[^/]+\/)/;
/** Dónde vive lo que se mudó de las guías. Una subcarpeta, a propósito: los `.md` de la RAÍZ de onboarding/ son el texto
 *  del alta y viajan a cada máquina del equipo (scripts/publishing/split.json, `onboarding/*.md` → team). */
const PRIVATE_HOME = 'onboarding/interno';
const tracked = (...args) => execFileSync('git', ['-C', ROOT, 'ls-files', '-z', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
/** ¿Es el árbol armado? Sin el README del público, es un clon pelado del privado: las guías no están y nada de lo de
 *  abajo se puede medir. No se saltea: se dice, en rojo. */
const ARMED_TREE = 'esta prueba corre sobre el árbol armado (lo privado con el público encima, como lo deja scripts/ci/overlay-harness.js --after-cut); en un clon pelado del repo privado no están las guías del público';
/** Las tres de scripts/publishing/split.js, copiadas tal cual (ese guion no las exporta): un glob con barra final es
 *  una carpeta, nunca una ruta exacta; y gana la regla más específica —la ruta exacta, y si no el glob más largo—. */
const asGlob = (glob) => (glob.endsWith('/') ? `${glob}**` : glob);
const isExact = (glob) => !/[*?]/.test(asGlob(glob));
const specificity = (glob) => (isExact(glob) ? Infinity : asGlob(glob).length);
/** Si un glob de split.json toma una ruta lo decide el comparador del exportador, que es el que usa el reparto
 *  (`coincide`: dos asteriscos cruzan carpetas, uno solo y el signo de pregunta no, y dos asteriscos con su barra
 *  también valen por ninguna carpeta). Sin copia propia del comparador: una copia leería distinto la primera forma de
 *  glob que no hubiera previsto. */
const { coincide } = require('../publishing/export.js');
/** A dónde manda el reparto una ruta que el exportador no publica, con la precedencia de split.js y no con el orden del
 *  archivo. Devuelve los destinos de las reglas que empatan arriba: uno solo, o el reparto la da por mal clasificada. */
function destinationsOf(rules, rel) {
  const matching = rules.filter((r) => coincide(r.glob, rel));
  const best = Math.max(...matching.map((r) => specificity(r.glob)));
  return [...new Set(matching.filter((r) => specificity(r.glob) === best).map((r) => r.to))];
}

test('T35e Guides_NoBlockMarkers_InWhatTravels @story-8.26 @ac-35', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'README.md')), ARMED_TREE);
  const mds = tracked('*.md').filter((f) => !NOT_TRAVELLING.test(f));
  assert.ok(mds.length > 100, `control: miré ${mds.length} .md; con tan pocos la cuenta de abajo no dice nada (${ARMED_TREE})`);
  const withMarkers = mds.filter((f) => publicCopy.markerLines(read(f)).length);
  // en el público solo no espera ninguna: las versiones con bloques son del repo privado. Una que se está yendo espera
  // sólo mientras el privado todavía la declara
  const ownNow = ARMED ? (JSON.parse(read('.tycon/internal-forms.json')).own || {}) : {};
  const waiting = ARMED ? [...STILL_WITH_AN_INTERNAL_FORM, ...LEAVING.filter((rel) => rel in ownNow)] : [];
  assert.deepStrictEqual(withMarkers.filter((f) => !waiting.includes(f)), [],
    'un .md de lo que viaja trae marcadores de bloque: lo sólo-interno va a onboarding/interno/ del repo privado, no a un bloque');
  // las que esperan siguen trayendo los suyos: el día que una los pierda, sale de esa lista (y se libera)
  assert.deepStrictEqual(waiting.filter((f) => !withMarkers.includes(f)), [], 'una guía de las que esperan ya no trae bloques: sacala de STILL_WITH_AN_INTERNAL_FORM');
  // el espejo: el lector de marcadores ve uno de verdad (si dejara de verlos, la cuenta de arriba daría 0 siempre)
  assert.strictEqual(publicCopy.markerLines(`uno\n${publicCopy.INTERNAL_START}\ndos\n${publicCopy.INTERNAL_END}\n`).length, 2, 'control: el lector de marcadores no ve un bloque de juguete');
});

test('T35e ThinList_DeclaresTheOnesThatWait_AndNotTheNine @story-8.26 @ac-35', (t) => {
  if (!ARMED) { t.skip(NOT_ARMED); return; }
  const list = JSON.parse(read('.tycon/internal-forms.json'));
  // la lista de un repo adelgazado: sin formas firmadas ni liberadas, con lo que el privado conserva
  assert.strictEqual(list.layout, 'thin', '.tycon/internal-forms.json: el repo privado está adelgazado y la lista no lo dice ("layout": "thin")');
  for (const old of ['forms', 'released']) assert.ok(!(old in list), `.tycon/internal-forms.json: trae "${old}", que es de antes de adelgazar`);
  const own = list.own || {};
  const mirror = list.mirror || {};
  // cada cosa que el privado conserva, con su motivo: sin él, mañana nadie sabe por qué ese archivo no sigue a GitHub
  assert.ok(Object.keys(own).length >= STILL_WITH_AN_INTERNAL_FORM.length, 'control: "own" trae menos rutas que guías que esperan');
  for (const [rel, why] of Object.entries({ ...own, ...mirror })) {
    assert.ok(typeof why === 'string' && why.trim().length >= 20, `${rel}: declarado sin motivo (o con uno que no dice nada)`);
  }
  // las que esperan: declaradas, y con sus bloques (el día que una los pierda, sale de la lista y de `own`)
  for (const rel of STILL_WITH_AN_INTERNAL_FORM) {
    assert.ok(rel in own, `${rel}: tiene su versión en el privado y la lista no la declara en "own"`);
    assert.ok(publicCopy.markerLines(read(rel)).length > 0, `${rel}: declarada en "own" y ya no trae bloques internos: si es igual a la del público, sale de "own" y se borra de acá`);
  }
  // las que se están yendo: un estado o el otro, entero (declarada con bloques, o fuera de `own` sin ninguno)
  for (const rel of LEAVING) {
    const marks = publicCopy.markerLines(read(rel)).length;
    if (rel in own) assert.ok(marks > 0, `${rel}: declarada en "own" y sin bloques internos: si es igual a la del público, sale de "own" y se borra de acá`);
    else assert.strictEqual(marks, 0, `${rel}: ya no está en "own" y trae marcadores de bloque`);
  }
  // las nueve: del público. No se declaran (declararlas sería volver a tener dos versiones) y no traen bloques
  for (const rel of PUBLIC_ONLY_GUIDES) {
    assert.ok(!(rel in own) && !(rel in mirror), `${rel}: es sólo del público y la lista la declara: volvió a tener una versión acá`);
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel}: no está. ${ARMED_TREE}`);
    assert.strictEqual(publicCopy.markerLines(read(rel)).length, 0, `${rel}: es la del público y trae marcadores de bloque`);
  }
  // ninguna guía con bloques que la lista no declare: un .md declarado que no es de los de arriba tampoco los trae
  for (const rel of Object.keys(own).filter((r) => r.toLowerCase().endsWith('.md') && !STILL_WITH_AN_INTERNAL_FORM.includes(r) && !LEAVING.includes(r))) {
    assert.strictEqual(publicCopy.markerLines(read(rel)).length, 0, `${rel}: declarado en "own" y con marcadores de bloque; si espera como el INSTALL, va en STILL_WITH_AN_INTERNAL_FORM con su motivo`);
  }
});

test('T35e PrivateHome_IsIndexedInItsCover_AndOutOfTheTeamLayer @story-8.26 @ac-35', (t) => {
  if (!ARMED) { t.skip(NOT_ARMED); return; }
  const files = tracked(`${PRIVATE_HOME}/**`);
  const cover = `${PRIVATE_HOME}/README.md`;
  assert.ok(files.includes(cover), `falta la portada del privado (${cover})`);
  assert.ok(files.length >= 5, `control: ${PRIVATE_HOME}/ trae ${files.length} archivo(s); esperaba la portada y sus cuatro anexos`);
  const coverText = read(cover);
  const everything = new Set(tracked());
  for (const f of files.filter((x) => x !== cover)) {
    const rel = f.slice(PRIVATE_HOME.length + 1);
    assert.ok(coverText.includes(`(${rel})`), `${f}: la portada no lo enlaza; un anexo que nadie indexa no lo encuentra nadie`);
    // cada anexo de una guía (los de `guides/`) dice de qué guía salió cada pedazo, y esa guía existe: sin eso, el texto
    // mudado queda sin contexto. Un documento propio del privado (no salió de ninguna guía) sólo tiene que estar enlazado.
    if (!rel.startsWith('guides/')) continue;
    const origins = [...read(f).matchAll(/^> Salió de `([^`]+)`, de la sección «[^»]+»/gm)].map((m) => m[1]);
    assert.ok(origins.length >= 1, `${f}: no dice de qué guía salió («> Salió de \`<guía>\`, de la sección «…»»)`);
    for (const guide of origins) assert.ok(everything.has(guide), `${f}: dice que salió de ${guide}, que no está en el repo`);
  }
  // fuera de la capa del equipo: el reparto, con su precedencia, manda cada uno a quien mantiene
  const rules = JSON.parse(read('scripts/publishing/split.json')).rules;
  for (const f of files) assert.deepStrictEqual(destinationsOf(rules, f), ['maintainers'], `${f}: el reparto no lo manda a «maintainers»; lo sólo-interno de las guías es de quien mantiene`);
  // el espejo: la misma cuenta ve que un .md de la raíz de onboarding/ sí va a las máquinas del equipo, y que la
  // precedencia no depende del orden del archivo (con las reglas al revés da lo mismo)
  assert.deepStrictEqual(destinationsOf(rules, 'onboarding/README.md'), ['team'], 'control: un .md de la raíz de onboarding/ ya no va a la capa del equipo; revisar la cuenta de arriba');
  assert.deepStrictEqual(destinationsOf([...rules].reverse(), 'onboarding/README.md'), ['team'], 'control: el destino cambió al dar vuelta el orden de las reglas');
  // y las dos formas de glob que hoy no usa ninguna regla se leen como en split.js: la carpeta con barra final (que
  // no es una ruta exacta: pierde contra el glob más largo) y el `?`, que no cruza carpetas
  const toy = [{ glob: 'x/', to: 'data' }, { glob: 'x/sub/*.md', to: 'team' }, { glob: 'y/?.md', to: 'team' }, { glob: 'z/**/w.md', to: 'maintainers' }];
  assert.deepStrictEqual(destinationsOf(toy, 'x/a.md'), ['data'], 'control: un glob con barra final es la carpeta entera');
  assert.deepStrictEqual(destinationsOf(toy, 'x/sub/a.md'), ['team'], 'control: entre dos reglas gana la más larga, no la carpeta');
  assert.deepStrictEqual([destinationsOf(toy, 'y/a.md'), destinationsOf(toy, 'y/ab.md'), destinationsOf(toy, 'y/a/b.md')], [['team'], [], []], 'control: `?` es un solo carácter y no cruza carpetas');
  assert.deepStrictEqual([destinationsOf(toy, 'z/w.md'), destinationsOf(toy, 'z/a/b/w.md')], [['maintainers'], ['maintainers']], 'control: `**/` vale por ninguna carpeta o por varias');
});

// ── T32 (el paquete está publicado) ─────────────────────────────────────────────
// Las portadas abren con la línea npx como entrada principal (en un bloque de código, con `@latest`), y las tres líneas
// de bajar, leer y correr el guion siguen como la entrada «a mano» (el bloque `install:core` de la referencia). El «sí»
// (`-y`/`--yes` —el de npm antes del nombre, o el nuestro después—) sólo aparece bajo «Sin
// nadie delante» / «With nobody at the keyboard»; en el resto de cada papel, nunca.
const NPX_PAPERS = ['README.md', 'README.es.md', 'getting-started/mac.md', 'getting-started/windows.md', 'getting-started/linux.md', 'getting-started/reference.md', 'getting-started/reference.es.md'];
const NPX_MAIN = 'npx @tyconsa/harness@latest';
/** El papel sin la sección «Sin nadie delante» (desde su título en negrita hasta el siguiente renglón que abre en negrita). */
function outsideUnattended(text) {
  return text.replace(/^\*\*(Sin nadie delante|With nobody at the keyboard)\*\*[\s\S]*?(?=^\*\*|(?![\s\S]))/m, '');
}
/** Los problemas de un papel con la línea npx (vacío = ninguno). */
function npxProblems(text, file) {
  const out = [];
  const rest = outsideUnattended(text);
  if (/\bnpx\s+(-y|--yes)\b/.test(rest)) out.push(`${file}: escribe npx -y / npx --yes fuera de «Sin nadie delante»`);
  for (const line of rest.split('\n').filter((l) => /@tyconsa\/harness/.test(l))) {
    if (/@tyconsa\/harness@latest[^\n`]*(\s-y\b|--yes)/.test(line)) out.push(`${file}: la línea npx con --yes fuera de «Sin nadie delante»: ${line.trim().slice(0, 120)}`);
  }
  for (const line of text.split('\n').filter((l) => /@tyconsa\/harness/.test(l))) {
    if (!/@tyconsa\/harness@latest/.test(line)) out.push(`${file}: la línea npx sin @latest: ${line.trim().slice(0, 120)}`);
    if (/próximamente|coming soon/i.test(line)) out.push(`${file}: la línea npx sigue como «próximamente»: ${line.trim().slice(0, 120)}`);
  }
  return out;
}
const fencesOf = (text) => [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => ({ at: m.index, body: m[1].trim() }));
test('T32 Docs_NpxIsMainEntry_YesOnlyUnattended_ScriptEntryStays', () => {
  for (const f of NPX_PAPERS) assert.deepStrictEqual(npxProblems(read(f), f), [], `${f}: la línea npx`);
  // las portadas: la línea sola, en un bloque, antes de «Instalar con Claude Code»
  for (const [f, guided] of [['README.md', '## Install with Claude Code'], ['README.es.md', '## Instalar con Claude Code']]) {
    const text = read(f);
    const main = fencesOf(text).find((x) => x.body === NPX_MAIN);
    assert.ok(main, `${f}: la entrada principal es la línea npx, sola, en un bloque de código`);
    assert.ok(text.indexOf(guided) > main.at, `${f}: la línea npx va antes del camino con Claude`);
  }
  // la referencia: npx primero; las tres líneas del guion siguen como «a mano»; «Sin nadie delante» suma la línea con --yes
  for (const f of ['getting-started/reference.md', 'getting-started/reference.es.md']) {
    const text = read(f);
    assert.match(text, /<!-- install:core -->[\s\S]*get-harness\.sh[\s\S]*<!-- \/install:core -->/, `${f}: la entrada a mano (install:core con get-harness.sh) sigue`);
    assert.match(text, /<!-- install:unattended -->[\s\S]*get-harness\.sh -- --profile minimal --yes[\s\S]*<!-- \/install:unattended -->/, `${f}: la entrada a mano sin nadie delante sigue`);
    const main = fencesOf(text).find((x) => x.body === NPX_MAIN);
    assert.ok(main && main.at < text.indexOf('<!-- install:core -->'), `${f}: la línea npx va antes de la entrada a mano`);
    assert.ok(fencesOf(text).some((x) => x.body === `${NPX_MAIN} --profile minimal --yes`), `${f}: «Sin nadie delante» trae la línea npx con el perfil y --yes`);
  }
  // el espejo: cada forma prohibida se detecta
  const unattended = '**Sin nadie delante** x\n\n```bash\nnpx @tyconsa/harness@latest --profile minimal --yes\n```\n\n**Otra** y\n';
  assert.deepStrictEqual(npxProblems(unattended, 'x'), [], 'control: con --yes bajo «Sin nadie delante» vale');
  assert.ok(npxProblems(`${unattended}\`npx -y @tyconsa/harness@latest\`\n`, 'x').some((m) => m.includes('-y')), 'control: npx -y fuera de la sección');
  assert.ok(npxProblems('```bash\nnpx @tyconsa/harness@latest --profile minimal --yes\n```\n', 'x').some((m) => m.includes('--yes')), 'control: la línea con --yes fuera de la sección');
  assert.ok(npxProblems('Próximamente: `npx @tyconsa/harness@latest`\n', 'x').some((m) => m.includes('próximamente')), 'control: la nota vieja de «próximamente»');
  assert.ok(npxProblems('`npx @tyconsa/harness`\n', 'x').some((m) => m.includes('@latest')), 'control: sin @latest');
});

// T20 · cada línea npx que escriben las portadas, la referencia y la página del paquete pasa el freno de comandos
// (`scripts/hooks/safety-guard-pre.sh`), una por una; la tubería `curl … | bash` sigue saliendo bloqueada con SUP-C1. El
// arnés no agrega un freno a `npx -y` (frenaría a los devs en sus proyectos): lo que protege es que la portada no lo
// escriba (T32). Corre el freno de verdad, con una HOME de juguete y sin TYCON_SAFETY_OFF.
test('T20 NpxInstaller_PortadaLinesPassGuard', (t) => {
  if (process.platform === 'win32') { t.skip('NO MEDIDO en Windows: el freno es un guion de bash (lo mide el ensayo de Windows)'); return; }
  const { spawnSync } = require('child_process');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'npx-guard-'));
  const env = Object.assign({}, process.env, { HOME: home }); delete env.TYCON_SAFETY_OFF;
  const guard = (command) => spawnSync('bash', [path.join(ROOT, 'scripts', 'hooks', 'safety-guard-pre.sh')], { input: JSON.stringify({ tool_input: { command }, cwd: home }), encoding: 'utf8', env });
  try {
    const lines = new Set();
    for (const f of [...NPX_PAPERS, 'scripts/setup/npm/README.md']) {
      for (const m of read(f).matchAll(/`(npx [^`\n]*@tyconsa\/harness[^`\n]*)`/g)) lines.add(m[1]);
    }
    assert.ok(lines.size >= 1, 'las portadas y la página del paquete escriben la línea npx');
    // y las variantes que la ayuda del instalador y las guías van a escribir cuando el paquete esté publicado
    for (const v of ['--profile full --integrations none --packs all', '--profile minimal --yes', '--team acme/harness-team-profile', '--audience org']) lines.add(`npx @tyconsa/harness@latest ${v}`);
    for (const line of lines) {
      const r = guard(line);
      assert.strictEqual(r.status, 0, `el freno bloquea «${line}»: ${(r.stderr || '').slice(0, 300)}`);
    }
    const curl = /curl -fsSL -o get-harness\.sh (https:\/\/\S+)/.exec(read('getting-started/reference.md'));
    assert.ok(curl, 'la referencia trae la línea de curl del guion de entrada');
    const piped = guard(`curl -fsSL ${curl[1]} | bash`);
    assert.strictEqual(piped.status, 2, `la tubería hacia bash sale bloqueada: ${piped.stderr}`);
    assert.match(piped.stderr, /SUP-C1/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ── T51 (las páginas para usar) ───────────────────────────────────────────────────────────────────
// Las tres páginas guiadas instalan con la línea npx en su parte 1 (el plan con --dry-run y la misma línea sin él, sin
// -y ni --yes: la persona contesta), con el guion de entrada a mano debajo; la referencia en los dos idiomas dice cómo
// pasar por un proxy o por la CA de la empresa y cómo desinstalar.
const GUIDED_PAGES = ['getting-started/mac.md', 'getting-started/windows.md', 'getting-started/linux.md'];
const NPX_GUIDED = 'npx @tyconsa/harness@latest --audience me --profile full --integrations none --packs all';
const REFERENCE_SECTIONS = {
  'getting-started/reference.md': { proxy: '## With a proxy or your company\'s CA', uninstall: '## Uninstall' },
  'getting-started/reference.es.md': { proxy: '## Con un proxy o la CA de tu empresa', uninstall: '## Desinstalar' },
};
/** El texto de una sección `## …` (hasta la siguiente del mismo nivel), o '' si no está. */
function sectionOf(text, title) {
  const at = text.split('\n').findIndex((l) => l.trim() === title);
  if (at < 0) return '';
  const lines = text.split('\n').slice(at + 1);
  const end = lines.findIndex((l) => /^## /.test(l));
  return lines.slice(0, end < 0 ? lines.length : end).join('\n');
}
test('T51 Docs_GuidedPagesUseNpx_ReferenceSaysProxyAndUninstall @story-8.40 @ac-43', () => {
  for (const f of GUIDED_PAGES) {
    const text = read(f);
    const partOne = text.split(/^## Parte 2\b/m)[0];
    const firstText = (/```text\n([\s\S]*?)```/.exec(partOne) || [])[1] || '';
    const lines = firstText.split('\n').map((l) => l.trim());
    assert.ok(lines.includes(`${NPX_GUIDED} --dry-run`), `${f}: la parte 1 muestra el plan con la línea npx y --dry-run`);
    assert.ok(lines.includes(NPX_GUIDED), `${f}: la parte 1 instala con la línea npx, sin --dry-run`);
    assert.doesNotMatch(firstText, /get-harness\.(sh|ps1)\s+--/, `${f}: la parte 1 ya no corre el guion de entrada`);
    assert.match(firstText, /Ok to proceed\?\s+\(y\)/, `${f}: la parte 1 avisa la pregunta propia de npx`);
    assert.match(firstText, /¿Instalo\? \[s\/N\]/, `${f}: la persona contesta la pregunta del instalador`);
    // las herramientas del paso 1 incluyen npx: el paso 2 lo necesita, y en Linux el node de la distribución puede venir sin npm
    const tools = (/^1\. Herramientas:\n([\s\S]*?)^2\. /m.exec(firstText) || [])[1] || '';
    assert.match(tools, /npx --version/, `${f}: el paso 1 mira npx`);
    if (f.endsWith('linux.md')) assert.match(tools, /sudo apt install -y npm/, `${f}: el paso 1 dice cómo se instala npm`);
    // el camino a mano, debajo: el guion de entrada con su plan y su instalación
    const byHand = sectionOf(text, '## Si npx no anda — el guion de entrada, a mano');
    assert.ok(byHand, `${f}: el camino a mano queda abajo`);
    assert.match(byHand, /get-harness\.(sh|ps1)/, `${f}: el camino a mano es el guion de entrada`);
    assert.ok(text.indexOf('## Si npx no anda') > text.indexOf(firstText), `${f}: el camino a mano va después de la parte 1`);
  }
  for (const [f, s] of Object.entries(REFERENCE_SECTIONS)) {
    const text = read(f);
    const proxy = sectionOf(text, s.proxy);
    assert.ok(proxy, `${f}: la sección «${s.proxy}»`);
    for (const k of ['HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) assert.ok(proxy.includes(k), `${f}: «${s.proxy}» nombra ${k}`);
    const uninstall = sectionOf(text, s.uninstall);
    assert.ok(uninstall, `${f}: la sección «${s.uninstall}»`);
    assert.match(uninstall, /harness\.js"? uninstall/, `${f}: «${s.uninstall}» da el comando`);
  }
  // INSTALL.md nombra npx primero: la línea aparece antes que el guion de entrada en «Instalar sin clonar»
  const install = sectionOf(read('INSTALL.md').replace(/^### /gm, '## '), '## 1. Instalar sin clonar');
  assert.ok(install.includes('npx @tyconsa/harness@latest'), 'INSTALL.md: «Instalar sin clonar» nombra la línea npx');
  assert.ok(install.indexOf('npx @tyconsa/harness@latest') < install.indexOf('get-harness'), 'INSTALL.md: npx primero, el guion de entrada después');
  // el camino a mano no instala sin el «sí»: el plan y la instalación van en dos bloques, con la respuesta en el medio
  for (const f of GUIDED_PAGES) {
    const byHand = sectionOf(read(f), '## Si npx no anda — el guion de entrada, a mano');
    const blocks = [...byHand.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 2 && blocks.some((b) => /--dry-run/.test(b) && !/--yes/.test(b)) && blocks.some((b) => /--yes/.test(b) && !/--dry-run/.test(b)), `${f}: el plan y la instalación a mano, en bloques separados`);
  }
});
