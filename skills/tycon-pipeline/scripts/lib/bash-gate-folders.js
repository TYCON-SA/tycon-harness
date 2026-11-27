'use strict';
/**
 * bash-gate-folders.js — la carpeta del comando nombrada de otra forma, y los bucles que recorren lo que lista un `find`,
 * para el freno de escrituras por consola (A50).
 *
 * `conCarpetasNombradas` y `conCarpetasPorTramo` escriben `$PWD`, `$(pwd)`, `~+`, `$OLDPWD` y la raíz de git como la
 * carpeta que nombran, para que el freno de historias lea el comando una vez más (`rm $PWD/specs/h.md` borra la historia
 * igual que `rm specs/h.md`). `ordenesDeBucles` arma lo que corre el cuerpo de un `for … in $(find …)` o de un
 * `find … | while read`, con la variable reemplazada por cada historia que alcanza el `find`.
 */
const os = require('os');
const path = require('path');

/**
 * El comando con las formas que nombran la carpeta desde donde corre escritas como esa carpeta (A50): `$PWD` y `${PWD}`
 * (también con `:-`, `:=` o un recorte), `$(pwd)` con o sin `-P`/`-L` y por `command`, `builtin` o `/bin/pwd`, `` `pwd` ``,
 * `~+`, `$(realpath .)` y `$OLDPWD` (con `carpetaAnterior`). La raíz del repo (`$(git rev-parse --show-toplevel)`), con
 * `raiz`. Lo que no se nombra queda igual. Sirve para leer el comando una vez más: un `rm $PWD/specs/h.md` borra la
 * historia igual que `rm specs/h.md`.
 */
function conCarpetasNombradas(cmd, carpeta, { raiz = null, carpetaAnterior = null } = {}) {
  let s = String(cmd)
    // la forma sola entre comillas dobles y pegada a lo que sigue (`"$PWD"/docs`): sin las comillas, para que la palabra no
    // se parta en dos (la carpeta sola quedaría como la raíz de un `find`)
    .replace(/"(\$\{?PWD\}?|\$\(\s*(?:command\s+|builtin\s+)?(?:\/bin\/)?pwd(?:\s+-[LP])?\s*\))"(?=[^\s;&|)])/g, () => (/[\s'"$`\\]/.test(carpeta) ? `"${carpeta}"` : carpeta))
    .replace(/\$\{PWD(?:(?::?[-=])[^}]*|%%?[^}]*)?\}|\$PWD(?!\w)/g, () => carpeta)
    .replace(/\$\(\s*(?:command\s+|builtin\s+)?(?:\/bin\/)?pwd(?:\s+-[LP])?\s*\)|`\s*(?:\/bin\/)?pwd(?:\s+-[LP])?\s*`/g, () => carpeta)
    .replace(/\$\(\s*realpath\s+\.\s*\)/g, () => carpeta)
    .replace(/(^|[\s=:"'(])~\+(?=[\/\s"';&|)]|$)/g, (m, a) => `${a}${carpeta}`);
  if (carpetaAnterior) s = s.replace(/\$\{OLDPWD\}|\$OLDPWD(?!\w)/g, () => carpetaAnterior);
  if (raiz) s = s.replace(/\$\(\s*git\s+(?:-C\s+\.\s+)?rev-parse\s+--show-toplevel(?:\s+2>\s*\/dev\/null)?\s*\)/g, () => raiz);
  return s;
}

/**
 * Como `conCarpetasNombradas`, tramo por tramo: después de cada `cd <carpeta>`, la carpeta del comando es ésa y
 * `$OLDPWD` la de antes (`cd /tmp && echo x >> $PWD/h.md` escribe en /tmp). La carpeta del `cd` se lee con la de antes.
 * Un `cd` que no se resuelve (una variable, un comodín) deja la carpeta como estaba.
 */
// un `cd` o un `pushd` con sus opciones (`-P`, `-L`, `-e`, `-@`, `--`) y la carpeta adonde va
const CD_DEL_TRAMO = /(?:^|[\s;&|('"])(?:cd|pushd)\s+(?:(?:-[LPe@]+|--)\s+)*(['"]?)([^\s'";&|)`]+)\1/g;

function conCarpetasPorTramo(cmd, carpeta, { raiz = null } = {}) {
  const texto = String(cmd);
  // los lugares donde cambia la carpeta: cada `cd`, cada paréntesis que abre (guarda la carpeta) y el que cierra (la
  // devuelve: `(cd /tmp && ls); rm $PWD/h.md` borra en la carpeta de antes). Los paréntesis entre comillas no cuentan
  const cambios = [...texto.matchAll(CD_DEL_TRAMO)].map((m) => ({ at: m.index + m[0].length, cd: m[2] }));
  // sólo los paréntesis de un grupo: los de una sustitución (`$(…)`) no mueven la carpeta de afuera, y cortar en ellos
  // partiría la sustitución que se escribe
  let q = null;
  const abiertos = [];
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (q) { if (ch === q && (q === "'" || texto[i - 1] !== '\\')) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '(') {
      const grupo = texto[i - 1] !== '$';
      abiertos.push(grupo);
      if (grupo) cambios.push({ at: i + 1, abre: true });
    } else if (ch === ')' && abiertos.length && abiertos.pop()) cambios.push({ at: i, cierra: true });
  }
  cambios.sort((a, b) => a.at - b.at || (a.cierra ? -1 : 1));
  let actual = carpeta;
  let anterior = carpeta;
  const guardadas = [];
  let desde = 0;
  let out = '';
  for (const c of cambios) {
    out += conCarpetasNombradas(texto.slice(desde, c.at), actual, { raiz, carpetaAnterior: anterior });
    desde = c.at;
    if (c.abre) { guardadas.push([actual, anterior]); continue; }
    if (c.cierra) { if (guardadas.length) [actual, anterior] = guardadas.pop(); continue; }
    const destino = conCarpetasNombradas(c.cd, actual, { raiz, carpetaAnterior: anterior });
    if (/[$*?[{`]/.test(destino)) continue;
    const previa = actual;
    actual = destino === '-' ? anterior : path.resolve(actual, destino.replace(/^~(?=\/|$)/, os.homedir()));
    anterior = previa;
  }
  return out + conCarpetasNombradas(texto.slice(desde), actual, { raiz, carpetaAnterior: anterior });
}

/**
 * Lo que corre el cuerpo de un bucle que recorre lo que lista un `find`: `for f in $(find …); do … $f …; done` y
 * `find … | while read f; do … $f …; done`. Cada orden del cuerpo, con la variable reemplazada por cada historia que
 * alcanza el `find` (`alcanzadas(palabras del find)`); sin historias, nada. Las palabras del `find` las parte `palabras`.
 */
function ordenesDeBucles(cmd, { palabras, alcanzadas, citar }) {
  const s = String(cmd || '');
  if (!/\bfind\b/.test(s) || !/\bdone\b/.test(s)) return [];
  const out = [];
  const conCada = (cuerpo, variable, items) => {
    const v = new RegExp(`"?\\$(?:\\{${variable}\\}|${variable}(?!\\w))"?`, 'g');
    for (const item of items) out.push(cuerpo.replace(v, () => citar(item)));
  };
  // for f in $(find …) / `find …`; do …; done
  for (const m of s.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*?)\s*[;\n]\s*do\b([\s\S]*?)\bdone\b/g)) {
    const finds = [...m[2].matchAll(/\$\(\s*(find\b[^)]*)\)|`\s*(find\b[^`]*)`/g)].map((x) => x[1] || x[2]);
    const items = finds.flatMap((f) => alcanzadas(palabras(f).filter((w) => w !== '')));
    if (items.length) conCada(m[3], m[1], items);
  }
  // find … | while read [-r] f; do …; done
  for (const m of s.matchAll(/(\bfind\b[^|;&]*)\|\s*while\s+(?:IFS=\S*\s+)?read\s+(?:-[rd]\s+(?:''\s+)?)*([A-Za-z_]\w*)\s*;\s*do\b([\s\S]*?)\bdone\b/g)) {
    const items = alcanzadas(palabras(m[1]).filter((w) => w !== ''));
    if (items.length) conCada(m[3], m[2], items);
  }
  return out;
}

module.exports = { conCarpetasNombradas, conCarpetasPorTramo, CD_DEL_TRAMO, ordenesDeBucles };
