'use strict';
// Lo que el freno de producción lee de un comando largo no crece con el cuadrado del largo: un freno que no termina a
// tiempo deja pasar en Codex, que no tiene `onFailure`. Cada pieza se compara con la expresión regular que reemplaza
// (VIEJA_*) en miles de textos al azar, y tiene que decir lo mismo; y se mide con una entrada de 64 KB armada para que
// esa expresión se cuelgue, y tiene que tardar poco.
// Las copias de shell-parse.js (scripts/lib y la del freno en scripts/production/guard-libs/lib) se prueban las dos.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const COPIAS = {
  compartida: require(path.join(ROOT, 'scripts', 'lib', 'shell-parse.js')),
  freno: require(path.join(ROOT, 'scripts', 'production', 'guard-libs', 'lib', 'shell-parse.js')),
};
// lo que tarda una sola vuelta con la entrada armada; la de antes tardaba entre 2 y 6 s con 64 KB
const TOPE_MS = 300;
const LARGO = 64 * 1024;
const VUELTAS = 4000;

// textos al azar con piezas de un alfabeto: un generador fijo, para que una falla se pueda repetir
function azar(semilla) {
  let s = semilla >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function textos(piezas, semilla, n = VUELTAS, largo = 14) {
  const r = azar(semilla);
  const out = [];
  for (let i = 0; i < n; i++) {
    let t = '';
    const L = Math.floor(r() * largo);
    for (let k = 0; k < L; k++) t += piezas[Math.floor(r() * piezas.length)];
    out.push(t);
  }
  return out;
}
const repetido = (pieza) => pieza.repeat(Math.ceil(LARGO / pieza.length)).slice(0, LARGO);
function tarda(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// ── las de antes, tal como estaban ─────────────────────────────────────────────────────────────
const VIEJA_PRINTF = /^[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[a-zA-Z]/;
const VIEJA_BORDES = /^[\\"'`({$]+|[\\"'`)}]+$/g;
const VIEJA_BARRAS = /\/+$/;
const VIEJA_CORCHETES = /\[[^\]]*\]/g;
const VIEJA_SHELL_ANTES = /(?:^|[\s;&|(])(?:sudo\s+)?(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)(?:\s+-[A-Za-z]+)*\s*$/;
const VIEJA_SHELL_DESPUES = /\|\s*(?:sudo\s+)?(?:\S*\/)?(?:bash|sh|zsh|dash|ksh)(?=\s|$)/;
const VIEJA_CITADOS = /\$'((?:\\.|[^'\\])*)'|'([^']*)'|"((?:\\.|[^"\\])*)"/g;
function viejosCitados(texto) {
  const out = [];
  for (const m of String(texto).matchAll(VIEJA_CITADOS)) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(['\\])/g, '$1'));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[3].replace(/\\(["\\$`])/g, '$1'));
  }
  return out;
}

for (const [cual, sp] of Object.entries(COPIAS)) {
  test(`T1 RegexLentas_Printf_IgualYLineal (${cual}) @fila-74: el largo de un %… de printf, igual que antes y sin colgarse`, () => {
    const viejo = (fmt, i) => { const m = VIEJA_PRINTF.exec(fmt.slice(i)); return m ? m[0].length : 0; };
    for (const t of textos(['0', '00', '-', '+', ' ', '#', '1', '9', '*', '.', 'd', 's', 'x', '%', 'Z', '\\'], 741)) {
      for (let i = 0; i <= t.length; i++) assert.strictEqual(sp.largoDeEspecificadorPrintf(t, i), viejo(t, i), `${JSON.stringify(t)} desde ${i}`);
    }
    for (const p of ['0', '0 ', '-0', '0.', '#0+']) {
      const s = `%${repetido(p)}`;
      const ms = tarda(() => sp.largoDeEspecificadorPrintf(s, 1));
      assert.ok(ms < TOPE_MS, `«${p}»×64 KB tardó ${ms.toFixed(0)} ms`);
    }
  });

  test(`T2 RegexLentas_BarrasFinales_IgualYLineal (${cual}) @fila-74: sacar las barras del final, igual que antes`, () => {
    for (const t of textos(['/', '//', 'a', '.', ' ', 'b/'], 742)) assert.strictEqual(sp.sinBarrasFinales(t), t.replace(VIEJA_BARRAS, ''), JSON.stringify(t));
    for (const p of ['/', '/a', '//x']) {
      const s = `${repetido(p)}x`;
      const ms = tarda(() => sp.sinBarrasFinales(s));
      assert.ok(ms < TOPE_MS, `«${p}»×64 KB tardó ${ms.toFixed(0)} ms`);
    }
  });

  test(`T4 RegexLentas_ShellAntes_IgualYLineal (${cual}) @fila-74: «la línea del heredoc termina en un shell», igual que antes`, () => {
    const piezas = [' ', '\t', ';', '&', '|', '(', '/', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'sudo ', 's', 'h', 'a', '-x', ' -e', 'x', '.', '\n'];
    for (const t of textos(piezas, 744, VUELTAS * 2)) assert.strictEqual(sp.SHELL_ANTES.test(t), VIEJA_SHELL_ANTES.test(t), JSON.stringify(t));
    for (const p of ['(', ';&', '/', 'a/', ' sudo', 'bash ', '/bash ']) {
      const s = `${repetido(p)}x`;
      const ms = tarda(() => sp.SHELL_ANTES.test(s));
      assert.ok(ms < TOPE_MS, `«${p}»×64 KB tardó ${ms.toFixed(0)} ms`);
    }
  });

  test(`T5 RegexLentas_ShellDespues_IgualYLineal (${cual}) @fila-74: «el heredoc sigue en una tubería a un shell», igual que antes`, () => {
    const piezas = [' ', '\t', '|', '/', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'sudo ', 's', 'h', 'a', 'x', ';', '\n', '-'];
    for (const t of textos(piezas, 745, VUELTAS * 2)) assert.strictEqual(sp.SHELL_DESPUES.test(t), VIEJA_SHELL_DESPUES.test(t), JSON.stringify(t));
    for (const p of ['|', '|/', '/', '/sh', '| ', 'a/sh/']) {
      const s = `${repetido(p)}x`;
      const ms = tarda(() => sp.SHELL_DESPUES.test(s));
      assert.ok(ms < TOPE_MS, `«${p}»×64 KB tardó ${ms.toFixed(0)} ms`);
    }
  });
}

test('T3 RegexLentas_BordesDeUnaPalabra_IgualYLineal @fila-74: las comillas y paréntesis de los bordes de una palabra, igual que antes', () => {
  // vive adentro del freno, sin bibliotecas (la usa su criterio de emergencia), y el freno no se puede cargar desde una
  // prueba: lee la entrada apenas arranca. Se toma la función del archivo, como T17c toma la lista de clientes
  const fs = require('fs');
  const fuente = fs.readFileSync(path.join(ROOT, 'scripts', 'hooks', 'prod-access-guard.js'), 'utf8');
  const cuerpo = /^function sinComillasDeLosBordes\(palabra\) \{\n[\s\S]*?\n\}\n/m.exec(fuente);
  assert.ok(cuerpo, 'el freno no trae sinComillasDeLosBordes');
  const sinComillasDeLosBordes = new Function(`${cuerpo[0]}; return sinComillasDeLosBordes;`)();
  for (const t of textos(['\\', '"', "'", '`', '(', ')', '{', '}', '$', 'a', 'z', '-'], 743)) {
    assert.strictEqual(sinComillasDeLosBordes(t), t.replace(VIEJA_BORDES, ''), JSON.stringify(t));
  }
  for (const p of [')}', '")', "'`", '\\']) {
    const s = `${repetido(p)}x`;
    const ms = tarda(() => sinComillasDeLosBordes(s));
    assert.ok(ms < TOPE_MS, `«${p}»×64 KB tardó ${ms.toFixed(0)} ms`);
  }
});

test('T6 RegexLentas_Citados_IgualYLineal @fila-74: los textos entre comillas, los mismos que antes y sin colgarse', () => {
  const sp = COPIAS.compartida;
  for (const t of textos(['$', "'", '"', '\\', 'a', ' ', '$\'', '\\"', "\\'", 'b'], 746, VUELTAS * 2)) {
    assert.deepStrictEqual(sp.textosEntreComillas(t), viejosCitados(t), JSON.stringify(t));
  }
  for (const p of ['\\"', '"\\"', "$'\\'", '"a\\']) {
    const s = repetido(p);
    const ms = tarda(() => sp.textosEntreComillas(s));
    assert.ok(ms < TOPE_MS, `«${p}»×64 KB tardó ${ms.toFixed(0)} ms`);
  }
});

test('T7 RegexLentas_Corchetes_SinEfecto @fila-74: cambiar los corchetes por x no cambia si queda algo que no sea * o ?', () => {
  // por eso el freno ya no los cambia: la pregunta da lo mismo sin el reemplazo, que crecía con el cuadrado del largo
  for (const t of textos(['[', ']', '*', '?', 'a', '[a]', '[*]', '[]'], 747)) {
    assert.strictEqual(/[^*?]/.test(t), /[^*?]/.test(t.replace(VIEJA_CORCHETES, 'x')), JSON.stringify(t));
  }
});
