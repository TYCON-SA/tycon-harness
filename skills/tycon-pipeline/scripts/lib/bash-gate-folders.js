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
 * El cuerpo de un bucle que empieza en `desde` (justo después de su `do`): hasta su `done`, contando los `do`/`done`
 * de los bucles de adentro (`do for g in 1 2; do …; done; rm $f; done`). `{ cuerpo, fin }` o null sin `done`.
 */
function cuerpoHastaDone(s, desde) {
  // sólo donde va una orden (al principio, o tras `;`, `&`, `|`, un renglón o un paréntesis): `echo done` no cierra nada
  const re = /(^|[;&|\n(){}][ \t]*)(do|done)(?=$|[\s;&|(){}])/g;
  re.lastIndex = desde;
  let hondo = 1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    hondo += m[2] === 'do' ? 1 : -1;
    if (hondo === 0) return { cuerpo: s.slice(desde, m.index + m[1].length), fin: m.index + m[0].length };
  }
  // sin cerrar así (`do` tras un `then`, por ejemplo): hasta el último `done`, que mirar de más no deja pasar nada
  const ultimo = s.lastIndexOf('done');
  return ultimo > desde ? { cuerpo: s.slice(desde, ultimo), fin: ultimo + 4 } : null;
}

/** El `do` que abre el bucle después de `desde`, salteando blancos, `;` y renglones: su final, o -1. */
function despuesDelDo(s, desde) {
  let i = desde;
  while (i < s.length && /[\s;]/.test(s[i])) i++;
  return s.startsWith('do', i) && (i + 2 === s.length || /[\s;]/.test(s[i + 2])) ? i + 2 : -1;
}

/**
 * Lo que corre el cuerpo de un bucle que recorre lo que lista un `find`: `for f in $(find …); do … $f …; done`,
 * `find … [| filtro] | while read f; do … $f …; done` y `while read f; do …; done < <(find …)` (también `<<< "$(find …)"`).
 * Cada orden del cuerpo, con la variable reemplazada por cada historia que alcanza el `find` (`alcanzadas(palabras del
 * find, recursivo)`, recursivo si el cuerpo borra carpetas enteras), escrita como la ve el comando (`ruta`). Sin
 * historias, nada. Se recorre el texto una vez, sin expresiones que se coman los mismos blancos (un `for … in` con miles
 * de espacios no tarda).
 */
function ordenesDeBucles(cmd, { palabras, alcanzadas, citar, ruta = (x) => x }) {
  const s = String(cmd || '');
  if (!/\bfind\b/.test(s) || !/\bdone\b/.test(s)) return [];
  const out = [];
  const recursivoEn = (cuerpo) => /\brm\b[^;&|\n]*\s-[a-zA-Z]*[rR]|\brm\b[^;&|\n]*--recursive/.test(cuerpo);
  const deFind = (texto, cuerpo) => {
    const w = palabras(texto).filter((x) => x !== '');
    const i = w.findIndex((x) => /(?:^|\/)g?find$/.test(x));
    return i < 0 ? [] : alcanzadas(w.slice(i), recursivoEn(cuerpo));
  };
  const conCada = (cuerpo, variable, items) => {
    // sólo `$f` y `${f}`: las comillas de alrededor quedan como estaban (`echo "Borrando $f"; rm "$f"`)
    const v = new RegExp(`\\$(?:\\{${variable}\\}|${variable}(?!\\w))`, 'g');
    for (const item of items) {
      const r = ruta(item);
      out.push(cuerpo.replace(v, () => (/^[\w@%+=:,./~-]+$/.test(r) ? r : citar(r).replace(/^'|'$/g, ''))));
    }
  };
  const finDeTramo = (desde) => { const m = /[;\n]/.exec(s.slice(desde)); return m ? desde + m.index : -1; };

  // for f in <lista>; do …; done
  for (const m of s.matchAll(/(?:^|[\s;&|(){}])for[ \t]+([A-Za-z_]\w*)[ \t]+in(?=[ \t])/g)) {
    const fl = finDeTramo(m.index + m[0].length);
    if (fl < 0) continue;
    const lista = s.slice(m.index + m[0].length, fl);
    const d = despuesDelDo(s, fl);
    if (d < 0) continue;
    const c = cuerpoHastaDone(s, d);
    if (!c) continue;
    const items = [...lista.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)].flatMap((x) => deFind(x[1] || x[2], c.cuerpo));
    if (items.length) conCada(c.cuerpo, m[1], items);
  }

  // [productor |] while [IFS=…] read [opciones] [variables]; do …; done [< <(find …) | <<< "$(find …)"]
  for (const m of s.matchAll(/(?:^|[\s;&|(){}])while[ \t]+(?:IFS=\S*[ \t]+)?read\b/g)) {
    const fr = finDeTramo(m.index + m[0].length);
    if (fr < 0) continue;
    // la variable: la primera palabra que no es una opción ni su valor; sin ninguna, REPLY
    const resto = s.slice(m.index + m[0].length, fr).trim().split(/\s+/).filter(Boolean);
    let variable = 'REPLY';
    for (let k = 0; k < resto.length; k++) {
      if (/^-[a-zA-Z]*[dpntu]$/.test(resto[k])) { k++; continue; }
      if (resto[k].startsWith('-')) continue;
      if (/^[A-Za-z_]\w*$/.test(resto[k])) { variable = resto[k]; break; }
    }
    const d = despuesDelDo(s, fr);
    if (d < 0) continue;
    const c = cuerpoHastaDone(s, d);
    if (!c) continue;
    // el productor: el primer programa de la tubería que llega al `while` (con filtros en el medio), o lo que entra por
    // `< <(…)` o `<<< "$(…)"` después del `done`
    const antes = s.slice(0, m.index + 1);
    const tuberia = antes.replace(/[|&\s({]+$/, '');
    const inicio = Math.max(tuberia.lastIndexOf(';'), tuberia.lastIndexOf('\n'), tuberia.lastIndexOf('&&'), tuberia.lastIndexOf('||'));
    const productores = antes.trimEnd().endsWith('|') || /\|\s*[({]?\s*$/.test(antes) ? [tuberia.slice(inicio + 1).split('|')[0]] : [];
    const despues = s.slice(c.fin, c.fin + 4000);
    const entrada = /^\s*(?:<\s*<\(|<<<\s*"?\$\()([^)]*)\)/.exec(despues);
    if (entrada) productores.push(entrada[1]);
    const items = productores.flatMap((p) => deFind(p, c.cuerpo));
    if (items.length) conCada(c.cuerpo, variable, items);
  }
  return out;
}

module.exports = { conCarpetasNombradas, conCarpetasPorTramo, CD_DEL_TRAMO, ordenesDeBucles };
