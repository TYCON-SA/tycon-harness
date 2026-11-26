'use strict';
/**
 * bash-gate-net.js — una parte de on-bash-write-gate.js, el freno de escrituras por consola.
 *
 * Responsabilidad: la red de fallas: las formas de escribir y de nombrar una historia o una constancia, y el registro de fallas que usan las partes (el del despachador, que él conecta al cargar). La carga el arranque del freno antes que nada: no carga nada, así que no puede fallar al cargar.
 *
 * El código viene de on-bash-write-gate.js tal cual, salvo dos reescrituras mecánicas: los `require` locales van
 * relativos a esta carpeta, y las rutas que salían de la carpeta de los guiones suben un nivel más. Cada parte carga
 * sólo las de abajo (la red primero; el despachador, todas).
 */

const os = require('os');

// en un repo sin historias, la palabra suelta no alcanza: cuenta una constancia o la ruta de una historia (de otro repo),
// también armada por partes (`Path('specs') / n`, `os.path.join('stories', f)`, `'specs/' + n + '.md'`)
const NOMBRA_RUTA_DE_HISTORIA = /control-changes|exemptions\.jsonl|(?:^|[\\/'"`\s])(?:\.?specs?|stories)[\\/][^\s'"`]*\.md\b|\bstory-[\w.-]*\.md\b|['"`](?:\.\/)?(?:\.?specs?|stories)\/?['"`]/i;
// las llamadas de un guion que escriben, copian, mueven o borran un archivo
const GUION_ESCRIBE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rename|replace|unlinkSync|rmSync|truncateSync|write_text|write_bytes|copy|copyfile|copy2|copytree|move|remove|unlink|truncate)\s*\(|\bopen\s*\([^)]*,\s*["'][^"']*[wax+]|\bFile\.(?:write|delete|rename)\b|\bFileUtils\.\w+/;
// las formas de escribir, borrar, mover o reponer un archivo desde un comando, sin contar un `open(` que puede ser de lectura
const FORMAS_DE_ESCRIBIR = [
  String.raw`(?:^|[\s;&|(])(?:[^\s;&|()'"]*[\\/])?\\?(?:rm|del|erase|unlink|remove-item|ri|mv|move|mi|move-item|rename-item|ren|cp|copy|copy-item|install|rsync|ditto|scp|dd|truncate|ln)(?:\.exe)?(?=\s)`,
  String.raw`\bgit\b[^\n;&|]*\s(?:checkout|restore|rm|mv)\b`,
  // `--output` de log, diff, show y los que aceptan las opciones de diff, también abreviada (`--out=…`)
  String.raw`\bgit\b[^\n;&|]*\s--ou(?:t(?:p(?:ut?)?)?)?(?=[=\s])`,
  String.raw`\b(?:curl|wget)\b[^\n;&|]*\s(?:-o|-O|--output)`,
  String.raw`>{1,2}(?![&>])(?!\s*/dev/(?:null|stdout|stderr)\b)`,
  String.raw`\btee\b`,
  String.raw`\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|write_bytes)\b`,
  String.raw`\b(?:Set-Content|Out-File|Add-Content)\b|::(?:Write|Append)All`,
  GUION_ESCRIBE.source,
];

// ── la red de abajo: el freno que falla ───────────────────────────────────────────────────────────
// Va antes de todo `require` del arnés: tiene que andar aunque no cargue ninguno, y por eso lee el comando como texto.
// Del lado que frena: suma los editores y las formas de abrir para escribir que el freno normal lee por palabras.
// También con una comilla antes: `bash -c 'rm h.md'`, y el primer comando de una entrada rota, pegado a su comilla.
const LA_RED_ESCRIBE = new RegExp([...FORMAS_DE_ESCRIBIR,
  String.raw`['"\`](?:[^\s;&|()'"]*[\\/])?\\?(?:rm|del|erase|unlink|remove-item|ri|mv|move|mi|move-item|rename-item|ren|cp|copy|copy-item|install|rsync|ditto|scp|dd|truncate|ln)(?:\.exe)?(?=\s)`,
  String.raw`\b(?:g?sed|perl|ruby)\b[^\n;&|]*\s-(?:[A-Za-z0-9]*i|-in-place)`,
  String.raw`\bg?awk\b[^\n;&|]*\s-i\s*inplace\b`,
  String.raw`(?:^|[\s;&|('"\`])(?:ed|ex|sponge|patch)(?=\s)`,
  String.raw`\b(?:n?vim?)\b[^\n;&|]*\s-[a-zA-Z]*[es]\b`,
  String.raw`\bgit\b[^\n;&|]*\sapply\b`,
  String.raw`\bopen\s*\([^)]*\bmode\s*=\s*["'][^"']*[wax+]`,
  String.raw`\.open\s*\(\s*["'][^"']*[wax+]`,
  String.raw`\bopenSync\s*\([^)]*,\s*["'][^"']*[wax+]`,
].join('|'), 'i');
// la carpeta entera también nombra lo que tiene adentro (`rm -rf specs`, `cd specs && sed -i … *.md`), y la ruta pegada a
// lo que la antecede también cuenta (`echo x >specs/a.md`, `dd of=specs/a.md`)
const LA_RED_NOMBRA = new RegExp(`${NOMBRA_RUTA_DE_HISTORIA.source}|\\bstory-[^\\s'"\`]*\\.md\\b|(?:^|[\\s/\\\\'"\`<>=(;:|&])(?:\\.?specs?|stories)(?:[\\\\/][^\\s'"\`]*\\.md\\b|[\\\\/]?(?=[\\s'"\`;&|)]|$))`, 'i');
const frenaLaRed = (texto) => LA_RED_ESCRIBE.test(texto) && LA_RED_NOMBRA.test(texto);
/** Lo último que hace el freno cuando falló sin haber mirado el comando: frena o sigue, y lo deja dicho. */
// en una entrada rota, los saltos de línea siguen escritos como `\n`. En un comando ya leído es otra cosa: `\rm` es `rm`
const textoDeUnaEntradaRota = (cruda) => String(cruda || '').replace(/\\[nrt]/g, ' ');

// El registro de fallas es el del despachador (on-bash-write-gate.js): escribe en la carpeta del estado y sabe qué hacer
// si esa carpeta no se puede saber. Lo conecta él al cargar esta parte, antes de cargar las otras; las partes sólo
// corren dentro del freno, así que sin él no hay a quién decírselo.
let registro = null;
function usarRegistro(f) { registro = f; }
function logHookError(...a) { if (registro) registro(...a); }

module.exports = { NOMBRA_RUTA_DE_HISTORIA, GUION_ESCRIBE, FORMAS_DE_ESCRIBIR, LA_RED_ESCRIBE, LA_RED_NOMBRA, frenaLaRed, textoDeUnaEntradaRota, usarRegistro, logHookError };
