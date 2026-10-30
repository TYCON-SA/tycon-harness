'use strict';
/*
 * human-words.test.js — las palabras que lee una persona: «ejecución» y no «corrida», y «el agente» cuando el texto
 * habla del agente en general y no de una herramienta.
 *
 * T1 HumanWords_SiteSpanishTextsWithoutCorrida   T5 HumanWords_MachineNamesStay
 * T2 HumanWords_SiteNamesTheAgentNotClaude       T6 HumanWords_GenericClaudePhrasesGone
 * T3 HumanWords_ToolExceptionsStay               T7 HumanWords_SiteGuideAnchorFollowsTitle
 * T4 HumanWords_ProgramTextsWithoutCorrida
 * T49 2.79-HumanWords_SinJerga · T50 2.79-HumanWords_PedidoSoloNoAparece · T51 2.79-HumanWords_UnaPalabraPorConcepto
 *
 * T49 y T50 leen la tabla de textos y las cadenas de los programas que arman las páginas; lo que queda a propósito va
 * en EXCEPCIONES, una por clave y con su motivo.
 *
 * Los nombres que lee la máquina (claves, rutas, ids, archivos) siguen diciendo «corrida»: T5 lo cuida. T4 y T6 leen
 * las cadenas de los programas sin sus comentarios, que quedan como están.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const leer = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
const TEXTS = require(path.join(ROOT, 'scripts', 'site', 'texts.js'));
const TABLA = TEXTS.TEXTOS || TEXTS.TEXTS || TEXTS;

// la palabra suelta: pegada a - _ / o a una letra es parte de un nombre de la máquina; un punto, sólo si le sigue una
// letra (`corrida.js`), porque al final de una oración es puntuación
const CORRIDA = /(?<![-_./,A-Za-zÁÉÍÓÚáéíóúñÑ0-9${])corridas?(?![-_/A-Za-zÁÉÍÓÚáéíóúñÑ0-9}])(?!\.[A-Za-z0-9_])(?!:\S)/i;

// Las que nombran una herramienta a propósito, porque el dato cambia según la herramienta: cómo se instala o se
// configura cada una
const HERRAMIENTA_A_PROPOSITO = [
  ['scripts/setup/harness/move-home.js', 'Codex te va a pedir aprobar sus hooks'], // excepción 2: el lado Codex
  ['scripts/setup/harness/report.js', 'Claude Code lee sin preguntar'], // excepción 1: los permisos de Claude Code
];

function entradas() {
  return Object.entries(TABLA).filter(([, v]) => v && typeof v === 'object' && typeof v.es === 'string');
}

// El texto de las cadenas de un programa, sin comentarios ni identificadores. Una pila lleva las plantillas anidadas
// (`… ${ x ? `…` : '…' } …`): dentro de ${ } vuelve a ser código. Una / donde no puede ir una división abre una
// expresión regular, que no es texto.
function cadenas(src) {
  const out = [];
  const pila = []; // 'tpl' = dentro del texto de una plantilla; 'expr' = dentro de ${ } de una plantilla
  let i = 0, prev = '', s = '';
  const enTexto = () => pila[pila.length - 1] === 'tpl';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (enTexto()) {
      if (c === '\\') { s += c + (d || ''); i += 2; continue; }
      if (c === '`') { out.push(s); s = ''; pila.pop(); i++; prev = ')'; continue; }
      if (c === '$' && d === '{') { out.push(s); s = ''; pila.push('expr'); i += 2; prev = '{'; continue; }
      s += c; i++; continue;
    }
    if (c === '/' && d === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
    if (c === '/' && d === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue; }
    // una expresión regular viene después de un operador; también después de `=>` (`(w) => /[$`]/.test(w)`)
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};>]/.test(prev))) {
      let j = i + 1, clase = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') clase = true; else if (src[j] === ']') clase = false; else if (src[j] === '/' && !clase) break;
        j++;
      }
      i = j + 1; prev = ')'; continue;
    }
    if (c === '`') { pila.push('tpl'); i++; continue; }
    if (c === '{' && pila.length) { pila.push('llave'); }
    if (c === '}' && pila.length) {
      const tope = pila.pop();
      if (tope === 'expr') { i++; continue; } // vuelve al texto de la plantilla
    }
    if (c === '"' || c === "'") {
      let j = i + 1, t = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { t += src[j] + (src[j + 1] || ''); j += 2; continue; }
        t += src[j]; j++;
      }
      out.push(t); i = j + 1; prev = ')'; continue;
    }
    if (!/\s/.test(c)) prev = /[A-Za-z0-9_$)\]]/.test(c) ? ')' : c;
    i++;
  }
  // una plantilla larga que es código para el navegador se lee como código: sus comentarios no son texto
  return out.flatMap((t) => (t.length > 1500 && /function\s*\(|=>/.test(t) ? cadenas(t) : [t]));
}

function programas() {
  // los programas del arnés; el freno de producción (scripts/production) y las skills se miran aparte
  const dirs = ['scripts/site', 'scripts/hooks', 'scripts/nightly', 'mods/harness-mods/hooks', 'scripts/ci', 'scripts/metrics',
    'scripts/setup', 'scripts/controls-bench', 'scripts/publishing', 'scripts/tools', 'scripts/instincts', 'scripts/lib'];
  const res = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const r = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|tests?$/.test(e.name)) andar(r); continue; }
      if (/\.(js|mjs|cjs|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) res.push(r);
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(ROOT, d))) andar(d);
  return res;
}

// Los guiones .sh y .ps1 de esas mismas carpetas, y los instaladores de la raíz de scripts/
function guiones() {
  const res = ['scripts/install-tycon-hooks.sh', 'scripts/install-tycon-hooks.ps1'].filter((r) => fs.existsSync(path.join(ROOT, r)));
  const andar = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const r = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|tests?$|^production$/.test(e.name)) andar(r); continue; }
      if (/\.(sh|ps1)$/.test(e.name) && !/\.test\./.test(e.name)) res.push(r);
    }
  };
  for (const d of ['scripts/ci', 'scripts/hooks', 'scripts/setup', 'scripts/metrics', 'scripts/nightly', 'scripts/tools', 'scripts/publishing']) {
    if (fs.existsSync(path.join(ROOT, d))) andar(d);
  }
  return res;
}

// Las cadenas entre comillas de un guion, sin los renglones de comentario ni el código embebido (node -e, python)
function cadenasDeGuion(src) {
  const out = [];
  for (const linea of src.split('\n')) {
    if (/^\s*#/.test(linea)) continue;
    for (const m of linea.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)) {
      if (!/node -e|JSON\.|python|require\(|=>/.test(m[0])) out.push(m[0].slice(1, -1));
    }
  }
  return out;
}

test('T1 HumanWords_SiteSpanishTextsWithoutCorrida @story-8.87 @ac-1', () => {
  const malas = entradas().filter(([, v]) => CORRIDA.test(v.es)).map(([k, v]) => `${k}: ${v.es}`);
  assert.deepStrictEqual(malas, [], 'textos del sitio en castellano que todavía dicen «corrida»');
  assert.strictEqual(TABLA['pestana.corridas'].es, 'Ejecuciones');
  assert.ok(/Ejecuciones/.test(leer('scripts/site/tabs/runs.js').match(/titulo: '[^']*'/)[0]), 'el título de la pestaña');
});

test('T2 HumanWords_SiteNamesTheAgentNotClaude @story-8.87 @ac-4', () => {
  assert.deepStrictEqual(TABLA['pantalla.comoTrabajaClaude'], { es: 'Cómo trabaja el agente', en: 'How the agent works' });
  assert.deepStrictEqual(TABLA['pantalla.comoContestaClaude'], { es: 'Cómo contesta el agente', en: 'How the agent answers' });
  assert.deepStrictEqual(TABLA['pantalla.comoContestaClaude2'], { es: 'cómo contesta el agente', en: 'how the agent answers' });
  const seccion = leer('scripts/lib/org-config.js').match(/id: 'respuesta', titulo: '([^']*)'/);
  assert.ok(seccion, 'la sección respuesta de org-config.js');
  assert.strictEqual(seccion[1], 'Cómo contesta el agente');
});

test('T3 HumanWords_ToolExceptionsStay @story-8.87 @ac-4', () => {
  assert.match(TABLA['pantalla.tecPegaEstaFrase'].es, /Claude Code o Codex/);
  assert.match(TABLA['pantalla.tecPegaEstaFrase'].en, /Claude Code or Codex/);
  // la línea nombra a los cuatro proveedores (antes, «Claude: … · Codex: …»)
  assert.strictEqual(TABLA['pantalla.equivalenciaDelNivel'].es, 'Anthropic: {anthropic} · OpenAI: {openai} · Ollama: {ollama} · Cursor: {cursor}');
});

test('T4 HumanWords_ProgramTextsWithoutCorrida @story-8.87 @ac-2 @ac-7', () => {
  const malas = [];
  for (const f of programas()) {
    for (const s of cadenas(leer(f))) {
      // una cadena que es sólo la palabra, o el prefijo de unas claves («corridas.»), es un identificador
      if (/^corridas?\.?$/i.test(s)) continue;
      if (CORRIDA.test(s.replace(/["'`]corridas?["'`]/gi, ''))) malas.push(`${f}: ${s.slice(0, 100)}`);
    }
    // el texto de una página armada en una plantilla: lo que va entre una etiqueta y la siguiente
    // (los guiones .sh y .ps1 se miran más abajo, con sus cadenas)
    for (const linea of leer(f).split('\n')) {
      if (/^\s*(\/\/|\*)/.test(linea)) continue;
      for (const m of linea.matchAll(/<[a-z/][^>]*>([^<$]*)/g)) if (CORRIDA.test(m[1])) malas.push(`${f}: ${m[1].slice(0, 100)}`);
    }
  }
  // tycon-config.js tiene una copia en el freno de producción que tiene que coincidir con ella en lo que el freno usa
  // (guard-libs-check.js): su texto cambia junto con el freno, que se reinstala aparte
  const conElFreno = (f, s) => f === 'scripts/lib/tycon-config.js' && s.startsWith('buzón de corridas apagado');
  for (let k = malas.length - 1; k >= 0; k--) {
    const [f, ...resto] = malas[k].split(': ');
    if (conElFreno(f, resto.join(': '))) malas.splice(k, 1);
  }
  for (const f of guiones()) {
    for (const s of cadenasDeGuion(leer(f))) {
      if (/^corridas?$/i.test(s)) continue;
      if (CORRIDA.test(s.replace(/["'`]corridas?["'`]/gi, ''))) malas.push(`${f}: ${s.slice(0, 100)}`);
    }
  }
  assert.deepStrictEqual(malas, [], 'textos de programa que todavía dicen «corrida»');
});

test('T5 HumanWords_MachineNamesStay @story-8.87 @ac-3', () => {
  const runs = leer('scripts/site/tabs/runs.js');
  assert.match(runs, /path: '\/corridas'/, 'la ruta de la pestaña');
  assert.match(runs, /pestana: \{ id: 'corridas'/, 'el id de la pestaña');
  assert.ok(TABLA['pestana.corridas'], 'la clave de texts.js');
  assert.match(leer('scripts/metrics/collect-findings.js'), /CLAVES_HALLAZGO = \['corrida',/, 'la clave de los hallazgos');
  assert.match(leer('scripts/tools/site-guide-captures.js'), /contenedor: 'corridas'/, 'el contenedor del buzón');
  assert.ok(JSON.parse(leer('scripts/nightly/dashboard/sources.json')).sources.some((s) => s.id === 'corridas'), 'el id de la fuente del tablero');
  assert.match(leer('scripts/ci/suites-report.js'), /'corridas:runs /, 'el alias viejo de la opción de ejecuciones sigue aceptado');
});

test('T6 HumanWords_GenericClaudePhrasesGone @story-8.87 @ac-5', () => {
  const GENERICO = /\b(Claude|Codex)( Code)? (lee|te|pide|contesta|trabaja|escribe|hace|reads|asks|answers|works|writes)\b/;
  const malas = [];
  for (const f of programas()) {
    for (const s of cadenas(leer(f))) {
      if (!GENERICO.test(s) || HERRAMIENTA_A_PROPOSITO.some(([a, frase]) => a === f && s.includes(frase))) continue;
      malas.push(`${f}: ${s.slice(0, 100)}`);
    }
  }
  assert.deepStrictEqual(malas, [], 'frases que hablan del agente en general con el nombre de una herramienta');
});

test('T7 HumanWords_SiteGuideAnchorFollowsTitle @story-8.87 @ac-6 @story-2.79 @ac-37', () => {
  const es = leer('guides/organization-site.md');
  const en = leer('guides/organization-site.en.md');
  assert.match(es, /^### Cómo trabaja el agente$/m);
  // el título inglés va sin el nombre castellano entre paréntesis
  assert.match(en, /^### How the agent works$/m);
  for (const [g, t] of [['es', es], ['en', en]]) {
    assert.doesNotMatch(t, /Cómo trabaja Claude|How Claude works|Cómo contesta Claude|How Claude answers/, `${g}: el nombre viejo`);
    assert.doesNotMatch(t, /#c(ó|%C3%B3|o)mo-trabaja-claude|#how-claude-works/i, `${g}: un enlace al ancla vieja`);
  }
});

// ── la jerga y «pedido» en lo que se ve (decisiones 5 y 8) ─────────────────────────────────────────────────────────
// La jerga de cada idioma: palabras de quien programa el arnés que una persona no tiene por qué conocer.
const JERGA = {
  es: [/buz[oó]n/i, /\bvolcados?\b/i, /\bhilos?\b/i, /\bfotos?\b/i, /\bcach[eé]\b/i, /\bre-?loops?\b/i, /\bset de revisores\b/i,
    /\bhooks?\b/i, /\bmerge[óo]\b/i, /cleanupPeriodDays/, /\bstory \d+\.\d+/i, /\bwarn\b/i, /\bexecutive\b/i],
  en: [/\bmailbox(es)?\b/i, /\bdumps?\b/i, /\bre-?loops?\b/i, /\breviewer set\b/i, /\bhooks?\b/i, /cleanupPeriodDays/,
    /\bstory \d+\.\d+/i, /\bS\d{2}\b/],
};
const PEDIDO = /\bpedidos?\b/i;
// Las apariciones que quedan, una por clave (de la tabla, o «archivo: comienzo de la cadena»), cada una con su motivo
const EXCEPCIONES = {
  'pantalla.respuestasDentroDelLargoPedido': '«el largo pedido» es el participio (el largo que se pidió), no el sustantivo',
  'pantalla.queLasPruebasCubranLo': '«lo pedido» es el participio, no el sustantivo',
  'pantalla.queNoSeHagaMas': '«lo pedido» es el participio, no el sustantivo',
  // el nombre castellano de una causa lo escribe la noche y lo valida su lista cerrada: el sitio lo traduce, no lo cambia
  'mant.causa.RR-ESCAPE:TYCON_PR_BY_HAND': 'nombre de causa que escribe la noche; su texto no cambia desde el sitio',
  'mant.causa.RR-ESCAPE:PR_A_MANO': 'nombre de causa que escribe la noche; su texto no cambia desde el sitio',
  'mant.causa.RR-ESCAPE:PR_A_MANO/sobra': 'nombre de causa que escribe la noche; su texto no cambia desde el sitio',
};

// Los programas que arman lo que se ve en una página del sitio
function programasDePagina() {
  const tabs = fs.readdirSync(path.join(ROOT, 'scripts/site/tabs')).filter((f) => f.endsWith('.js')).map((f) => `scripts/site/tabs/${f}`);
  return [...tabs, 'scripts/site/static/site.js', 'scripts/site/views.js', 'scripts/nightly/dashboard/runs.js'];
}
// El texto visible de las cadenas de un programa: sin los renglones que escriben en el registro ni lanzan un error (los
// lee quien opera el sitio, no la página), sin etiquetas, atributos ni estilos, y sólo lo que tiene más de una palabra
function textosDePrograma(f) {
  const src = leer(f).split('\n').filter((l) => !/\b(log|console\.\w+)\(|throw new Error\(|process\.std(err|out)\.write\(/.test(l)).join('\n');
  return cadenas(src)
    .filter((s) => !/[{;]\s*[a-z-]+\s*:[^}]*[;}]/.test(s)) // una hoja de estilos
    .map((s) => s.replace(/<[^>]*>?/g, ' ').replace(/\b[\w-]+="[^"]*"/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => /\s/.test(s));
}
// Lo que no está en la lista de excepciones: `{ clave, texto }` de la tabla en un idioma y de los programas de página.
// Los valores con nombre (`{pedido}`) los llena el programa y no se ven: no cuentan
function hallar(rx, idiomas) {
  const malas = [];
  for (const [k, v] of Object.entries(TABLA)) {
    if (!v || typeof v !== 'object') continue;
    for (const idioma of idiomas) {
      const visible = typeof v[idioma] === 'string' ? v[idioma].replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ' ') : null;
      if (visible !== null && rx.some((r) => r.test(visible)) && !EXCEPCIONES[k]) malas.push(`${k} [${idioma}]: ${v[idioma].slice(0, 90)}`);
    }
  }
  for (const f of programasDePagina()) {
    for (const s of textosDePrograma(f)) {
      const clave = `${f}: ${s.slice(0, 40)}`;
      if (rx.some((r) => r.test(s)) && !EXCEPCIONES[clave]) malas.push(`${clave}`);
    }
  }
  return malas;
}

test('T49 2.79-HumanWords_SinJerga @story-2.79 @ac-40', () => {
  for (const motivo of Object.values(EXCEPCIONES)) assert.ok(motivo.length > 20, 'cada excepción dice su motivo');
  const malas = [...hallar(JERGA.es, ['es']), ...hallar(JERGA.en, ['en'])];
  assert.deepStrictEqual(malas, [], 'jerga en el texto visible del sitio');
});

test('T50 2.79-HumanWords_PedidoSoloNoAparece @story-2.79 @ac-41', () => {
  assert.deepStrictEqual(hallar([PEDIDO], ['es']), [], '«pedido» en el texto en castellano: pull request, tarea, solicitud o una frase sin sustantivo');
  // la excepción de un participio sigue siendo un participio
  for (const k of Object.keys(EXCEPCIONES).filter((c) => TABLA[c] && /participio/.test(EXCEPCIONES[c]))) {
    assert.match(TABLA[k].es, /\b(lo|largo) pedido\b/, k);
  }
  // la de una causa es una causa de verdad: su clave sale del código que escribe la noche
  for (const k of Object.keys(EXCEPCIONES).filter((c) => /escribe la noche/.test(EXCEPCIONES[c]))) assert.match(k, /^mant\.causa\./, k);
});

test('T51 2.79-HumanWords_UnaPalabraPorConcepto @story-2.79 @ac-41', () => {
  const malas = [];
  for (const [k, v] of Object.entries(TABLA)) {
    if (!v || typeof v.es !== 'string' || typeof v.en !== 'string') continue;
    if (/change request/i.test(v.en)) malas.push(`${k}: «change request» por «pull request»`);
    // «check» como sustantivo donde el castellano dice «control»; el verbo («check that…», «checks that…») queda
    if (/\bcontrol(es)?\b/i.test(v.es) && /\b(a|the|this|its|one|no|any|every|required|test|new names|query) checks?\b|\bchecks\b(?! (that|whether|if|the|it|its|what|which|first))/i.test(v.en)) {
      malas.push(`${k}: «check» como sustantivo por «control»`);
    }
  }
  assert.deepStrictEqual(malas, [], 'una palabra por concepto (decisión 5)');
});
