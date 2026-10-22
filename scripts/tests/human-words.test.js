'use strict';
/*
 * human-words.test.js — las palabras que lee una persona: «ejecución» y no «corrida», y «el agente» cuando el texto
 * habla del agente en general y no de una herramienta.
 *
 * T1 HumanWords_SiteSpanishTextsWithoutCorrida   T5 HumanWords_MachineNamesStay
 * T2 HumanWords_SiteNamesTheAgentNotClaude       T6 HumanWords_GenericClaudePhrasesGone
 * T3 HumanWords_ToolExceptionsStay               T7 HumanWords_SiteGuideAnchorFollowsTitle
 * T4 HumanWords_ProgramTextsWithoutCorrida
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
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};]/.test(prev))) {
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
  assert.strictEqual(TABLA['pantalla.equivalenciaDelNivel'].es, 'Claude: {claude} · Codex: {codex}');
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

test('T7 HumanWords_SiteGuideAnchorFollowsTitle @story-8.87 @ac-6', () => {
  const es = leer('guides/organization-site.md');
  const en = leer('guides/organization-site.en.md');
  assert.match(es, /^### Cómo trabaja el agente$/m);
  assert.match(en, /^### How the agent works \(Cómo trabaja el agente\)$/m);
  for (const [g, t] of [['es', es], ['en', en]]) {
    assert.doesNotMatch(t, /Cómo trabaja Claude|How Claude works|Cómo contesta Claude|How Claude answers/, `${g}: el nombre viejo`);
    assert.doesNotMatch(t, /#c(ó|%C3%B3|o)mo-trabaja-claude|#how-claude-works/i, `${g}: un enlace al ancla vieja`);
  }
});
