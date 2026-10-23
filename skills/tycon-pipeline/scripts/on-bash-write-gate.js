#!/usr/bin/env node
/**
 * tycon-pipeline PreToolUse hook (matcher: Bash|PowerShell) — la segunda puerta del portón de CARRIL.
 *
 * El portón de carril vive en PreToolUse Edit|Write (`on-story-gate.js`). Pero un archivo también se
 * escribe por Bash: `cat > src/Foo.cs <<'EOF'`, `sed -i`, `tee`, `perl -pi`, `cp`, un `python3 -c
 * "open(...,'w')"`. Y no hace falta malicia para ir por ahí: en "auto mode" el propio arnés INSTRUYE
 * editar con sed/heredocs en vez de Edit/Write. Sin
 * esta puerta, el portón tendría un agujero del tamaño de la puerta.
 *
 * Qué hace: extrae del comando los paths que el comando VA A ESCRIBIR (redirecciones, tee, sed -i,
 * perl -i, cp/mv destino, open(...,'w'), writeFileSync, Set-Content/Out-File), se queda con los que
 * son CÓDIGO (mismo criterio que el portón: `lib/story-gate.js#isCodeFile`), y corre sobre cada uno el
 * MISMO cálculo (`lib/story-gate-io.js#evaluate`). Si alguno bloquea, el comando se deniega con el
 * mismo mensaje (indicando que vino por Bash).
 *
 * Es BEST-EFFORT a propósito: un parser de shell completo acá sería más frágil que útil. Lo que no
 * reconoce (git apply, patch, herramientas con --write) pasa. La red de fondo sigue siendo la misma
 * que para el resto del arnés: el diff en el commit. Conservador en la extracción para no dar falsos
 * positivos: sólo el token DESPUÉS de `>`/`>>`/`tee`, sólo tokens con extensión de código tras
 * `sed -i`/`perl -i`, sólo el ÚLTIMO token de un `cp`/`mv`.
 *
 * Exit: 0 deja pasar · 2 deniega (stderr = mensaje). Fail-open VISIBLE: errores a hook-errors.log.
 * Escape: el mismo del portón (env TYCON_STORY_GATE=off · config commiteada del repo).
 *
 * ── SEGUNDA RESPONSABILIDAD: la puerta Bash del freno de STORY A MANO ────────────────
 * El caso que motiva ese freno son los heredocs de Bash —
 * un hook que sólo mirara Edit|Write no habría frenado nada. Sobre los MISMOS targets extraídos
 * arriba, para cada `.md` que NO existe: si el contenido (cuerpo del heredoc, o el texto inline
 * de un `printf`/`echo -e` con `\n`) declara identidad de story, o —sin contenido legible— el
 * nombre lo sugiere (`story-*.md`, `stories/*.md`), corre `lib/story-skill-gate-io.js#evaluate`. Lo mismo
 * para cada `.md` que existe: si es una historia en borrador, escribirle encima desde acá (`sed -i`, un heredoc)
 * pide la constancia del validador, porque desde un comando no se ve qué estado queda.
 * Por Bash se acepta ser MÁS conservador (nombre + ruta) cuando el
 * contenido no se puede parsear (`cp plantilla.md specs/story-x.md`); el costo es un `.md` con
 * nombre de story que no lo es, en un repo del arnés, escrito por Bash sin el skill — raro, y
 * con escape auditado. Kill-switch propio: TYCON_STORY_SKILL_GATE=off (independiente del carril).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { stateDir: stateDirOf } = require('./lib/state-dir.js');   // la carpeta del estado, de una sola pieza
const { isCodeFile, isManifestFile, NEVER_CODE_SEGMENTS } = require('./lib/story-gate.js');
const { resolveSessionId } = require('./lib/session-id.js');
// Con respaldo, como en dispatch.js y on-write-collision.js: sin la lib (un skill instalado a medias) el portón no puede
// morir al cargar —saldría 1, que no frena, y sin dejar constancia—: resuelve las rutas como antes.
let nativePath = (p) => p;
try { ({ nativePath } = require('./lib/path-shape.js')); } catch { /* sin normalización de rutas: conducta previa */ }

// ── extracción de targets de escritura ────────────────────────────────────────────────────────────

const Q = `(?:'([^']*)'|"([^"]*)"|([^\\s'"|;&<>]+))`; // token: 'x' | "x" | bare
function tok(m, i) { return m[i] ?? m[i + 1] ?? m[i + 2] ?? null; }

function splitSegments(cmd) {
  // Separadores de comandos (no dentro de comillas — aproximación: split simple alcanza para lo
  // que buscamos; las comillas raras caen del lado conservador = no se extrae nada).
  return String(cmd).split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter(Boolean);
}

/**
 * Los destinos de un cp / mv: con `-t` / `--target-directory` (también `-rt`, `-t<carpeta>`), la carpeta y cada archivo
 * que llega a ella; si no, el último token una vez sacadas las redirecciones del final (`cp a b 2>&1`).
 */
function cpMvDest(seg) {
  // un comentario al final no es parte del comando
  const sinComentario = seg.replace(/(^|\s)#.*$/, '');
  const sinRedir = sinComentario.replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
  const words = (sinRedir.trim().match(new RegExp(Q, 'g')) || []).map((w) => {
    const mm = w.match(new RegExp(`^${Q}$`));
    return mm ? tok(mm, 1) : null;
  }).filter(Boolean);
  // con varios -t vale el último, como en cp
  let dir = null;
  const fuera = new Set([0]);   // el nombre del comando, y lo que nombra la carpeta
  for (let i = 0; i < words.length; i++) {
    const largo = /^--target-directory=(.+)$/.exec(words[i]);
    const pegado = /^-t(.+)$/.exec(words[i]);
    if (largo) { dir = largo[1]; fuera.add(i); } else if ((/^-[a-zA-Z]*t$/.test(words[i]) || words[i] === '--target-directory') && words[i + 1]) {
      dir = words[i + 1]; fuera.add(i).add(i + 1); i++;
    } else if (pegado) { dir = pegado[1]; fuera.add(i); }
  }
  // sin -t: el último argumento que no es una opción (`cp a b -f`, `Copy-Item a b -Force`, `cp a b --`)
  if (dir === null) { const t = words.slice(1).filter((w) => !w.startsWith('-')).pop(); return t ? [t] : []; }
  const fuentes = words.filter((w, i) => !fuera.has(i) && !w.startsWith('-'));
  return [dir, ...fuentes.map((f) => `${dir.replace(/[\\/]+$/, '')}/${f.split(/[\\/]/).pop()}`)];
}

function lastWord(seg) {
  const words = seg.trim().match(new RegExp(Q, 'g')) || [];
  if (!words.length) return null;
  const m = words[words.length - 1].match(new RegExp(`^${Q}$`));
  return m ? tok(m, 1) : null;
}

/**
 * Limpia del comando lo que NO es comando:
 *  - los CUERPOS de los heredocs (el mensaje de commit HEREDOC del equipo, un .md escrito por heredoc que
 *    cita `> src/x.ts` o `a.ts -> b.ts`) — se conserva la línea de apertura (`cat > f <<EOF`), que es donde
 *    está el target real;
 *  - los strings entre comillas que NO son el token inmediato tras `>`/`>>`/`tee` (`-m "..."`, `-e "..."`,
 *    `grep "sed -i"`), para que su contenido no se lea como redirecciones ni como archivos.
 */
function stripNonCommandText(s) {
  // Heredocs: <<EOF / <<-EOF / <<'EOF' / <<"EOF" … hasta la línea que es sólo el delimitador.
  let t = String(s).replace(/(<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\2[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  // Strings entre comillas que no siguen a un operador de redirección / tee: se vacían (quedan las comillas), salvo
  // los que pueden ser un nombre de archivo (sin espacios ni operadores): `cp a "<dir>/b.md"` sigue nombrando su destino.
  t = t.replace(/(^|[^>\w])(?<!tee[ \t]+)(?<!>[ \t]*)(['"])((?:\\.|(?!\2)[^\\])*)\2/g,
    (m, pre, q, body) => (/^[^\s'"|;&<>`()]+$/.test(body) ? m : `${pre}${q}${q}`));
  return t;
}

/** `cd <dir> && …` al inicio: el dir contra el que resolver targets relativos (best-effort). */
function leadingCd(cmd) {
  const m = String(cmd || '').match(/^\s*cd\s+(?:'([^']*)'|"([^"]*)"|([^\s;&|]+))\s*(?:&&|;)/);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** Devuelve los paths (tal cual aparecen) que el comando escribe. */
function extractWriteTargets(cmd, { keep = null } = {}) {
  const out = new Set();
  const raw = String(cmd || '');
  const s = stripNonCommandText(raw);

  // 1) redirecciones: `> f`, `>> f`, `2> f`, `&> f`, `>| f`, `>& f` (no `>&2`, no `<`)
  const reRedirect = new RegExp(`(?:^|[^<>&])(?:&|\\d)?>{1,2}(?:\\||&(?![\\d-]))?[ \\t]*${Q}`, 'g');
  let m;
  while ((m = reRedirect.exec(s))) {
    const t = tok(m, 1);
    if (t && !t.startsWith('&') && !/^\/dev\//.test(t)) out.add(t);
  }

  // 2) tee [-a] f1 [f2 …]
  const reTee = /\btee\b((?:[ \t]+-[a-zA-Z]+)*)((?:[ \t]+(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+))+)/g;
  while ((m = reTee.exec(s))) {
    const args = m[2].match(new RegExp(Q, 'g')) || [];
    for (const a of args) {
      const mm = a.match(new RegExp(`^${Q}$`));
      const t = mm ? tok(mm, 1) : null;
      if (t && !t.startsWith('-')) out.add(t);
    }
  }

  // 3) sed -i / --in-place / perl -i / -pi / -ni : todo token con extensión de código del segmento, o que quien llama
  //    quiere mirar igual (`keep`: el estado y el árbol instalado, sea cual sea la extensión)
  for (const seg of splitSegments(s)) {
    // Anclados al INICIO del segmento: `grep -i "sed" src/a.ts` no es un sed -i.
    const head = seg.trim().replace(/^(?:\w+=\S+\s+)*(?:sudo\s+)?/, '');
    const isSedI = /^sed\b/.test(head) && /(^|\s)(-i\b|-[a-zA-Z]*i[a-zA-Z]*\b(?=\s)|--in-place)/.test(head);
    const isPerlI = /^perl\b/.test(head) && /(^|\s)-[a-zA-Z]*i\S*(\s|$)/.test(head);
    if (isSedI || isPerlI) {
      const words = seg.match(new RegExp(Q, 'g')) || [];
      // el nombre del comando y, si no hay -e / -f, la expresión (el primer argumento) no son archivos: `keep` no los mira
      const conExpresionAparte = /(^|\s)(-[a-zA-Z]*[ef]|--expression|--file)/.test(head) || isPerlI;
      let args = 0;
      let esValorDeE = false;   // lo que sigue a -e / --expression es la expresión, no un archivo
      let anterior = null;
      // en el comando escrito, ¿hay un `-i ''` de verdad (el sufijo vacío de Mac) o es una expresión que se vació?
      const sufijoVacio = /(^|\s)-i\s+(''|"")(\s|$)/.test(raw);
      for (const w of words.slice(1)) {
        const mm = w.match(new RegExp(`^${Q}$`));
        const t = mm ? tok(mm, 1) : null;
        if (t == null) continue;
        const previo = anterior; anterior = t;
        if (t.startsWith('-')) { esValorDeE = /^(-[a-zA-Z]*e|--expression)$/.test(t); continue; }
        if (esValorDeE) { esValorDeE = false; continue; }
        // `sed -i ''` (Mac): el `''` es el sufijo de -i. Si no, una expresión con espacios llega vaciada y ocupa su lugar
        if (t === '') { if (!(isSedI && previo === '-i' && sufijoVacio)) args++; continue; }
        args++;
        const esExpresion = !conExpresionAparte && args === 1;
        if (isCodeFile(t) || isManifestFile(t) || (keep && !esExpresion && keep(t))) out.add(t);
      }
    }
    // 4) cp / mv → destino = último token del segmento. También sus formas de PowerShell (Copy-Item /
    //    Move-Item y sus alias copy / cpi / move / mi; no distingue mayúsculas): por la herramienta PowerShell de
    //    Windows.
    if (/^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:cp|mv)\b/.test(seg.trim()) || /^(?:copy-item|move-item|copy|cpi|move|mi)\b/i.test(seg.trim())) {
      for (const t of cpMvDest(seg)) out.add(t);
    }
  }

  // 5) scripts inline: open('f','w'|'a'), writeFileSync('f'), fs.writeFile('f', Set-Content/Out-File —
  //    sobre el comando CRUDO (viven dentro de strings que stripNonCommandText vacía a propósito)
  const rePyOpen = /\bopen\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[wa]/g;
  while ((m = rePyOpen.exec(raw))) out.add(m[2]);
  const reNodeWrite = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\(\s*(['"`])([^'"`]+)\1/g;
  while ((m = reNodeWrite.exec(raw))) out.add(m[2]);
  const rePs = /\b(?:Set-Content|Out-File|Add-Content)\b(?:\s+-(?:Path|LiteralPath|FilePath))?\s+(['"]?)([^\s'"]+)\1/gi;
  while ((m = rePs.exec(raw))) out.add(m[2]);
  // [IO.File]::WriteAllText / AppendAllText / WriteAllLines('f', …): escriben como Set-Content
  const reDotNet = /\[(?:system\.)?io\.file\]::(?:writealltext|appendalltext|writealllines|appendalllines|writeallbytes)\(\s*(['"])([^'"]+)\1/gi;
  while ((m = reDotNet.exec(raw))) out.add(m[2]);

  // 6) dd of=… y truncate … <file>: dos escritores que, sin esta extracción, permitirían escribir el estado
  //    del pipeline esquivando esta puerta.
  const reDd = /\bdd\b[^\n|;&]*?\bof=(['"]?)([^\s'"]+)\1/g;
  while ((m = reDd.exec(s))) out.add(m[2]);
  for (const seg of splitSegments(s)) {
    if (/^(?:\w+=\S+\s+)*(?:sudo\s+)?truncate\b/.test(seg.trim())) {
      const t = lastWord(seg);
      if (t && !t.startsWith('-')) out.add(t);
    }
  }

  return [...out];
}

// ── lo que el registro tampoco ve: un intérprete que escribe en un destino armado, y borrar o deshacer ────────────

const INTERPRETES = 'node|nodejs|python[0-9.]*|perl|pwsh|powershell';
// un destino escrito como una sola ruta literal, o la salida estándar: no está armado. Con un `$` adentro no es literal:
// perl, PowerShell y el shell interpolan entre comillas dobles
const DESTINO_LITERAL = /^(?:(['"])[^'"$]*\1|`[^`$]*`|\d+|process\.std(?:out|err)(?:\.fd)?|sys\.std(?:out|err)|['"]?\/dev\/std(?:out|err)['"]?)$/;

/** Las palabras de un tramo de comando, con sus comillas resueltas (`'a b'` es una palabra). */
function palabras(tramo) {
  return (String(tramo).match(new RegExp(Q, 'g')) || []).map((w) => {
    const mm = w.match(new RegExp(`^${Q}$`));
    return mm ? tok(mm, 1) : null;
  }).filter((w) => w != null);
}

/** Los argumentos que siguen a un script, sin redirecciones; el `--` de node no cuenta (node lo saca de `process.argv`). */
function argumentosDe(resto) {
  const sinRedir = String(resto || '').replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
  const w = palabras(sinRedir).filter((x) => x !== '');
  return w[0] === '--' ? w.slice(1) : w;
}

/**
 * Los scripts inline del comando con sus argumentos: `[{ script, argv }]`. Un script va después de `-e`, `-c`, `-p`,
 * `--eval` o `-Command` (con o sin opciones antes), o por la entrada estándar con un heredoc (`python3 - a <<EOF`,
 * `node <<EOF`). Sólo se mira el texto del script: lo que otro comando menciona (un mensaje de commit, un `.md` escrito
 * por heredoc) no es un script.
 */
function scriptsInline(cmd) {
  const raw = String(cmd || '');
  const out = [];
  const inicio = `(?:^|[\\s;&|(\`])(?:[^\\s;&|()'"]*[\\\\/])?(?:${INTERPRETES})(?:\\.exe)?`;
  // cada parte con una sola lectura posible: una barra invertida es siempre escape, una opción empieza con letra
  const conFlag = new RegExp(`${inicio}((?:\\s+-{1,2}[A-Za-z][\\w-]*(?:=[^\\s'"]+)?)*?)\\s+(?:-[a-zA-Z]*[epc]|--eval|--print|-Command)\\s+(['"])((?:\\\\[\\s\\S]|(?!\\2)[^\\\\])*)\\2([^\\n;&|]*)`, 'gi');
  // sin los cuerpos de los heredocs: un `node -e` adentro de un `.md` que se escribe es texto, no un comando
  const sinCuerpos = raw.replace(/(<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\2[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  for (const m of sinCuerpos.matchAll(conFlag)) out.push({ script: m[3], argv: argumentosDe(m[4]) });
  const porEntrada = new RegExp(`(?:^|[\\s;&|(\`])(?:[^\\s;&|()'"]*[\\\\/])?(${INTERPRETES})(?:\\.exe)?([^\\n<|;&]*)<<-?[ \\t]*(['"]?)([A-Za-z_]\\w*)\\3[^\\n]*\\n([\\s\\S]*?)\\n[ \\t]*\\4[ \\t]*(?=\\n|$)`, 'gi');
  for (const m of raw.matchAll(porEntrada)) {
    const antes = palabras(m[2]).filter((x) => x !== '');
    const i = antes.indexOf('-');
    // `node - a`: process.argv[1] es '-' y el primer argumento es process.argv[2]; en python, sys.argv[1] ya es `a`
    const desde = i < 0 ? -1 : (/^node/i.test(m[1]) ? i : i + 1);
    // un heredoc sin comillas (`<<EOF`): el shell expande las variables del cuerpo antes de correrlo
    out.push({ script: m[5], argv: desde >= 0 ? antes.slice(desde) : antes.filter((x) => !x.startsWith('-')), expande: !m[3] });
  }
  return out;
}

/**
 * El primer argumento de la llamada que abre en `desde` (el carácter después del paréntesis), respetando comillas y
 * paréntesis anidados: `{ arg, fin }` con `fin` en la coma o el paréntesis que lo cierra.
 */
function primerArgumento(texto, desde) {
  let nivel = 0;
  let q = null;
  for (let i = desde; i < texto.length; i++) {
    const c = texto[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(' || c === '[' || c === '{') nivel++;
    else if (c === ')' || c === ']' || c === '}') { if (nivel === 0) return { arg: texto.slice(desde, i).trim(), fin: i }; nivel--; } else if (c === ',' && nivel === 0) return { arg: texto.slice(desde, i).trim(), fin: i };
  }
  return { arg: texto.slice(desde).trim(), fin: texto.length };
}

/**
 * Las rutas que una expresión nombra si sale sólo de literales: `'a.ts'`, `['a', 'b']`, `os.path.expanduser('~/x')`,
 * `path.join('a', 'b')`, `Path('a')`. null si algo no es literal.
 */
function literalesDe(expr) {
  const e = String(expr || '').trim();
  // con `$VAR` adentro también: quien lo juzga la expande con las variables del comando (un heredoc sin comillas)
  const lit = /^(['"])([^'"]*)\1$/.exec(e);
  if (lit) return [lit[2]];
  const partes = (cuerpo) => {
    const out = [];
    let desde = 0;
    while (desde < cuerpo.length) {
      const a = primerArgumento(cuerpo, desde);
      const l = /^(['"])([^'"]*)\1$/.exec(a.arg);
      if (!l) return null;
      out.push(l[2]);
      desde = a.fin + 1;
      if (cuerpo[a.fin] !== ',') break;
    }
    return out.length ? out : null;
  };
  const lista = /^\[([\s\S]*)\]$/.exec(e);
  if (lista) return partes(lista[1]);
  const llamada = /^(os\.path\.expanduser|os\.path\.abspath|os\.path\.join|path\.join|path\.resolve|Path)\s*\(([\s\S]*)\)$/.exec(e);
  if (llamada) {
    const p = partes(llamada[2]);
    if (!p) return null;
    return /join|resolve/.test(llamada[1]) ? [p.join('/')] : (p.length === 1 ? p : null);
  }
  return null;
}

/**
 * Lo que se sabe de un destino armado sin ejecutar el script: `literal` si es una variable que el mismo script asigna a
 * una ruta literal (`const p = 'src/a.ts'`) o un argumento del comando, `ext` si termina en un literal con extensión
 * (`dir + '/findings.json'`).
 */
function leerArmado(expr, script, argv) {
  // `process.argv[k]` / `sys.argv[k]` / `$ARGV[k]` (perl cuenta desde 0), con o sin una cola literal
  const desdeArgv = (e) => {
    const m = /^(?:(?:process|sys)\.argv\[(\d+)\]|\$ARGV\[(\d+)\])\s*(?:\+\s*(['"`])([^'"`]*)\3)?$/.exec(e);
    if (!m) return null;
    const k = m[1] != null ? Number(m[1]) - 1 : Number(m[2]);
    return argv[k] != null ? argv[k] + (m[4] || '') : null;
  };
  const deArgv = desdeArgv(expr);
  if (deArgv) return { literal: deArgv };
  const directos = literalesDe(expr);
  if (directos) return { literales: directos };
  if (/^\$?[A-Za-z_][\w$]*$/.test(expr)) {
    const nombre = expr.replace(/\$/g, '\\$');
    // el lado derecho entero tiene que salir de literales: `p = 'src/' + n` no se sabe
    const m = new RegExp(`(?:^|[^\\w$.=!<>])${nombre}\\s*=(?!=)\\s*([^;\\n]+)`).exec(script);
    if (m) {
      const der = m[1].trim();
      if (desdeArgv(der)) return { literal: desdeArgv(der) };
      const lits = literalesDe(der);
      if (lits) return { literales: lits };
    }
    // el primer parámetro de una función auxiliar (`function edit(p, pares)`, `def rep(p, pares):`): si cada llamada
    // le pasa una ruta literal, ésas son las rutas
    const fn = new RegExp(`(?:function|def)\\s+([A-Za-z_]\\w*)\\s*\\(\\s*${nombre}\\s*[,)]`).exec(script);
    if (fn) {
      const rutas = [];
      let todas = true;
      for (const c of script.matchAll(new RegExp(`(?<!(?:function|def)\\s+)\\b${fn[1]}\\s*\\(`, 'g'))) {
        const a = primerArgumento(script, c.index + c[0].length);
        const lits = literalesDe(a.arg);
        if (!lits) { todas = false; break; }
        rutas.push(...lits);
      }
      if (todas && rutas.length) return { literales: rutas };
    }
    // un bucle sobre una lista de rutas literales: `for p in ['a.yaml', 'b.md']` · `for (const p of ['a', 'b'])`
    const bucle = new RegExp(`for\\s*\\(?\\s*(?:const\\s+|let\\s+|var\\s+)?${nombre}\\s+(?:in|of)\\s+(\\[[^\\]]*\\])`).exec(script);
    if (bucle) {
      const lits = literalesDe(bucle[1]);
      if (lits) return { literales: lits };
    }
    // `const [a, b] = process.argv.slice(1)` · `a, b = sys.argv[1:]`
    const re = /(?:\[([\w$,\s]+)\]|(?:^|;)\s*([\w,\s]+?))\s*=\s*(?:process\.argv\.slice\((\d+)\)|sys\.argv\[(\d+):\])/gm;
    for (const d of script.matchAll(re)) {
      const nombres = String(d[1] || d[2]).split(',').map((x) => x.trim());
      const k = nombres.indexOf(expr);
      const desde = Number(d[3] || d[4]);
      if (k >= 0 && argv[desde + k - 1] != null) return { literal: argv[desde + k - 1] };
    }
  }
  // la cola es un literal (`dir + '/findings.json'`, `"'$R'/x.md"`): su extensión dice qué clase de archivo es
  const cola = String(expr).replace(/['"`\s)]+$/, '');
  const fin = /([^'"`+\s,(]*\.([A-Za-z0-9]+))$/.exec(cola);
  if (fin && /['"`]/.test(expr) && cola.length < String(expr).length) return { ext: `.${fin[2].toLowerCase()}`, cola: fin[1] };
  return {};
}

/**
 * Los destinos con que un script inline nombra el archivo que escribe, cuando no son una ruta literal:
 * `[{ expr, literal?, ext?, cola? }]` (ver leerArmado).
 */
function destinosArmados(cmd) {
  const vistos = new Map();
  for (const { script, argv } of scriptsInline(cmd)) {
    const add = (e) => {
      const x = String(e || '').trim();
      if (x && !DESTINO_LITERAL.test(x) && !vistos.has(x)) vistos.set(x, { expr: x, ...leerArmado(x, script, argv) });
    };
    const llamadas = (re, quePasa) => {
      for (const m of script.matchAll(re)) {
        const a = primerArgumento(script, m.index + m[0].length);
        if (!quePasa || quePasa(a)) add(a.arg);
      }
    };
    llamadas(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/g);
    // python: open(<destino>, 'w'|'a'|'x'|'+'); sin modo es lectura
    llamadas(/\bopen\s*\(/g, (a) => script[a.fin] === ',' && /^\s*(?:mode\s*=\s*)?[rbt]*['"][^'"]*[wax+]/.test(script.slice(a.fin + 1)));
    // python: Path(<destino>).write_text / write_bytes
    llamadas(/\bPath\s*\(/g, (a) => /^\)\s*\.(?:write_text|write_bytes)\s*\(/.test(script.slice(a.fin)));
    // perl: open(my $fh, '>', <destino>)
    for (const m of script.matchAll(/\bopen\s*\(?\s*(?:my\s+)?\$\w+\s*,\s*['"]\+?>{1,2}['"]\s*,\s*/g)) add(primerArgumento(script, m.index + m[0].length).arg.replace(/\)\s*;?$/, ''));
    // powershell: Set-Content / Out-File / Add-Content con una variable o una expresión, y [IO.File]::Write*
    for (const m of script.matchAll(/\b(?:Set-Content|Out-File|Add-Content)\b(?:\s+-(?:Path|LiteralPath|FilePath))?\s+([$(][^\s'"]*)/gi)) add(m[1]);
    llamadas(/\[(?:system\.)?io\.file\]::(?:writealltext|appendalltext|writealllines|appendalllines|writeallbytes)\s*\(/gi);
  }
  return [...vistos.values()];
}

/** Los tramos de un comando (`;`, `&&`, `||`, `|`, salto de línea), sin cortar adentro de las comillas ni de los heredocs. */
function tramos(cmd) {
  const s = String(cmd || '').replace(/(<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\2[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  const out = [];
  let q = null;
  let actual = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { actual += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; actual += c; continue; }
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      if (actual.trim()) out.push(actual);
      actual = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    actual += c;
  }
  if (actual.trim()) out.push(actual);
  return out;
}

// los prefijos que no cambian qué comando corre
const PREFIJO = /^(?:\(\s*|[A-Za-z_]\w*=\S*\s+|sudo\s+(?:-\S+\s+)*|command\s+|exec\s+|nice\s+(?:-n\s+\S+\s+)?|nohup\s+|env\s+(?:-\S+\s+)*(?:[A-Za-z_]\w*=\S*\s+)*|timeout\s+(?:-\S+\s+)*\S+\s+)+/;
// los parámetros de Remove-Item que llevan un valor que no es la ruta
const PS_CON_VALOR = /^-(?:filter|include|exclude|erroraction|ea|credential|stream|warningaction|wa|informationaction|ia)$/i;

/**
 * Lo que el comando borra (`rm`, `del`, `Remove-Item` y sus alias, `git rm`) o deshace (`git checkout [<ref>] [--]
 * <ruta>`, `git restore <ruta>`): `[{ raw, kind: 'delete'|'restore', base?, quizas? }]`. `base` es la carpeta de un
 * `git -C`. `quizas`: un `git checkout <nombre>` sin `--`, que es una ruta si existe y si no una rama. Lo que sólo toca el
 * índice (`git restore --staged`, `git rm --cached`) no cambia el archivo.
 */
function destinosBorrados(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    const sinComentario = tramo.replace(/(^|\s)#.*$/, '').replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
    const words = palabras(sinComentario.trim().replace(PREFIJO, '')).filter((w) => w !== '').map((w) => w.replace(/\)+$/, '')).filter(Boolean);
    if (!words.length) continue;
    const c = path.basename(words[0].replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '');
    if (['rm', 'del', 'erase', 'remove-item', 'ri', 'rmdir', 'rd', 'unlink'].includes(c)) {
      for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (/^-(?:path|literalpath)$/i.test(w)) { if (words[i + 1]) out.push({ raw: words[++i], kind: 'delete' }); continue; }
        if (PS_CON_VALOR.test(w)) { i++; continue; }
        if (w.startsWith('-') || /^\/[a-z]$/i.test(w)) continue;
        out.push({ raw: w, kind: 'delete' });
      }
      continue;
    }
    if (c !== 'git') continue;
    // las opciones de git antes del subcomando; `-C <carpeta>` cambia contra qué se resuelven las rutas
    let i = 1;
    let base = null;
    while (i < words.length && words[i].startsWith('-')) {
      if (words[i] === '-C') { base = base ? `${base}/${words[i + 1]}` : words[i + 1]; i += 2; continue; }
      if (words[i] === '-c' || words[i] === '--git-dir' || words[i] === '--work-tree' || words[i] === '--namespace') { i += 2; continue; }
      i++;
    }
    const sub = words[i];
    const resto = words.slice(i + 1);
    const con = (raw, kind, extra) => out.push({ raw, kind, ...(base ? { base } : {}), ...extra });
    if (sub === 'rm') {
      if (resto.includes('--cached')) continue;
      for (const w of resto) if (!w.startsWith('-')) con(w, 'delete');
    } else if (sub === 'checkout') {
      if (resto.some((w) => /^-(?:b|B|-orphan|-detach)$/.test(w))) continue;
      const corte = resto.indexOf('--');
      if (corte >= 0) { for (const w of resto.slice(corte + 1)) con(w, 'restore'); continue; }
      const sueltos = resto.filter((w) => !w.startsWith('-'));
      // `git checkout <ref> <ruta>…`: lo que sigue al primero son rutas; uno solo puede ser una rama o una ruta
      if (sueltos.length >= 2) for (const w of sueltos.slice(1)) con(w, 'restore');
      if (sueltos.length) con(sueltos[0], 'restore', { quizas: true });
    } else if (sub === 'restore') {
      if (resto.some((w) => w === '--staged' || w === '-S') && !resto.some((w) => w === '--worktree' || w === '-W')) continue;
      for (let k = 0; k < resto.length; k++) {
        if (resto[k] === '--source' || resto[k] === '-s') { k++; continue; }
        if (resto[k] === '--' || resto[k].startsWith('-')) continue;
        con(resto[k], 'restore');
      }
    }
  }
  return out;
}

/** Lo que git sigue en esa ruta (un archivo, una carpeta, un comodín): `[rutas absolutas]`, o null si no se pudo preguntar. */
function seguidos(repo, abs) {
  const r = require('child_process').spawnSync('git', ['-C', repo, 'ls-files', '-z', '--full-name', '--', abs],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  const top = require('child_process').spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  const raiz = top.status === 0 ? String(top.stdout).trim() : repo;
  return String(r.stdout).split('\0').filter(Boolean).map((f) => path.join(raiz, f));
}

/**
 * Con el pipeline abierto: borrar o deshacer código del repo de la corrida, o escribir desde un intérprete en un destino
 * que no es una ruta literal, frenan como edición invisible. Lo borrado que pasa (node_modules, un archivo que git no
 * sigue) queda en `console-writes` con `kind: "delete"`, para el control al cerrar; si el comando frena, no corre y no se
 * anota nada.
 */
function frenoBorrarYArmados({ cmd, cwd, stateDir, sessionId, io, isInside, via }) {
  const borrados = destinosBorrados(cmd).map((d) => {
    const base = d.base ? resolveTarget(expandirRuta(cmd, d.base).valor, cwd, process.platform, { homeVariable: true }) : cwd;
    return { ...d, abs: resolveTarget(expandirRuta(cmd, d.raw).valor, base, process.platform, { homeVariable: true }) };
  }).filter((d) => !d.quizas || fs.existsSync(d.abs));
  const todosLosArmados = destinosArmados(cmd);
  if (!borrados.length && !todosLosArmados.length) return null;
  const lv = require('./lib/ledger-visible.js');
  const marker = io.readMarker(stateDir, sessionId);
  if (!lv.pipelineAbierto(marker) || !marker.repoPath) return null;
  const repo = marker.repoPath;
  // por ruta real también: `/var` y `/private/var` (o un enlace en el medio) son el mismo repo
  const real = (p) => {
    try { return fs.realpathSync(p); } catch (_) { /* no existe: su carpeta */ }
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch (_) { return p; }
  };
  const repoReal = real(repo);
  const enElRepo = (abs) => isInside(repo, abs) || isInside(repoReal, real(abs)) || real(abs) === repoReal;
  const esCodigo = (abs) => isCodeFile(abs) || isManifestFile(abs);
  const esDelRegistro = (abs) => enElRepo(abs) && esCodigo(abs);
  // lo que se sabe sin ejecutar: una variable con su ruta literal, un argumento, o una cola con extensión que no es código
  const armados = todosLosArmados.filter((a) => {
    // `'$SP/x.cs'` en un script entre comillas dobles: el shell expande `$SP` antes de correrlo. Si el comando (o el
    // ambiente) la define, es esa ruta
    const entre = /^(['"])(.*)\1$/.exec(a.expr);
    if (entre && /\$/.test(entre[2])) {
      const ex = expandirRuta(cmd, entre[2]);
      if (!ex.sinResolver.length) return esDelRegistro(resolveTarget(ex.valor, cwd, process.platform, { homeVariable: true }));
    }
    if (a.literal) return esDelRegistro(resolveTarget(expandirRuta(cmd, a.literal).valor, cwd, process.platform, { homeVariable: true }));
    if (a.literales) {
      return a.literales.some((l) => {
        const ex = expandirRuta(cmd, l);
        // una variable que nadie define: se juzga por la extensión que se ve (`$SP/x.json` no es código)
        if (ex.sinResolver.length) return !path.extname(l) || esCodigo(l);
        return esDelRegistro(resolveTarget(ex.valor, cwd, process.platform, { homeVariable: true }));
      });
    }
    if (a.ext) return isCodeFile(`x${a.ext}`) || isManifestFile(a.cola);
    return true;
  }).map((a) => a.expr);
  const adentro = borrados.filter((d) => enElRepo(d.abs));
  const deCodigo = [];
  const pasan = [];
  for (const d of adentro) {
    // un archivo de código: deshacerlo frena siempre; borrarlo, si git lo sigue (uno de prueba de la sesión pasa).
    // Una carpeta, `.` o un comodín: frena si git sigue código adentro. Sin poder preguntarle a git, del lado seguro.
    // node_modules, dist, bin… (las carpetas que nunca son código de la historia) pasan sin preguntarle a git
    const rel = path.relative(repoReal, real(d.abs)).split(path.sep);
    if (rel.some((seg) => NEVER_CODE_SEGMENTS.has(seg))) { pasan.push(d); continue; }
    // un archivo que no es código (`notas.md`) tampoco: a git se le pregunta por lo que puede tener código adentro
    let esCarpeta = false;
    try { esCarpeta = fs.statSync(d.abs).isDirectory(); } catch (_) { /* no existe: lo decide su forma */ }
    if (!esCodigo(d.abs) && !esCarpeta && !/[*?[]/.test(d.raw) && path.extname(d.abs)) { pasan.push(d); continue; }
    const lista = seguidos(repoReal, real(d.abs));
    if (esCodigo(d.abs)) {
      if (d.kind === 'restore' || lista === null || lista.length) deCodigo.push(d.abs); else pasan.push(d);
      continue;
    }
    if (lista === null) { deCodigo.push(`${d.abs} (no pude preguntarle a git qué sigue adentro)`); continue; }
    const codigoAdentro = lista.filter(esCodigo);
    if (codigoAdentro.length) deCodigo.push(`${d.abs} (${codigoAdentro.length} archivo(s) de código que git sigue)`);
    else pasan.push(d);
  }
  const frena = [...new Set(deCodigo), ...armados.map((e) => `(destino armado) ${e}`)];
  if (!frena.length) {
    anotarEscriturasConsola(stateDir, sessionId, pasan.filter((d) => d.kind === 'delete').map((d) => d.abs), 'delete');
    return null;
  }
  const linea = (status, extra) => {
    try {
      fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
        ts: new Date().toISOString(), sessionId, repoPath: repo, name: 'ledger-visible', status,
        storyId: marker.storyId || null, files: frena.length, paths: frena, via, ...extra,
      }) + '\n', 'utf8');
    } catch (e) { logHookError(e); }
  };
  if (String(process.env.TYCON_LEDGER_VISIBLE || '').toLowerCase() === 'off') {
    linea('escaped', { reason: 'TYCON_LEDGER_VISIBLE=off en el ambiente de la sesión' });
    anotarEscriturasConsola(stateDir, sessionId, pasan.filter((d) => d.kind === 'delete').map((d) => d.abs), 'delete');
    return null;
  }
  linea('blocked', { forma: deCodigo.length ? 'borrar-o-deshacer' : 'destino-armado' });
  return { block: lv.mensaje(frena, marker.storyId, { borrarODeshacer: deCodigo.length > 0, armado: armados.length > 0 }) + '\n' };
}

// ── contenido escrito (para el freno de story-a-mano) ───────────────────────────────────────────

/**
 * Heredocs del comando: [{ body, target }] — el cuerpo (lo que stripNonCommandText descarta a
 * propósito) y el target de SU línea de apertura (`cat > f <<EOF` / `cat <<EOF > f` / `tee f <<EOF`),
 * o null si la línea no redirige a un archivo. La atribución importa: el cuerpo de un heredoc que
 * reescribe una story EXISTENTE no se le atribuye a cualquier `.md` nuevo del mismo comando.
 */
function heredocs(cmd) {
  const out = [];
  const re = /(^|[\n;&|][ \t]*)([^\n]*?)<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\3([^\n]*)\n([\s\S]*?)\n[ \t]*\4[ \t]*(?=\n|$)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) {
    const line = `${m[2]} ${m[5]}`;
    const t = extractWriteTargets(line);
    out.push({ body: m[6], target: t.length === 1 ? t[0] : null });
  }
  return out;
}
/** Compat: sólo los cuerpos. */
function heredocBodies(cmd) { return heredocs(cmd).map((h) => h.body); }

/**
 * Frontmatter inline: `printf '---\nstory: "9.9"\n…' > f.md` / `echo -e`. Se des-escapan los `\n`
 * y se toma desde el primer `---` de línea. Devuelve el texto si declara identidad de story, si no null.
 */
function inlineStoryText(cmd, declares) {
  const t = String(cmd || '').replace(/\\n/g, '\n');
  // El `---` abre al inicio, tras un salto de línea o tras la comilla que abre el string.
  const m = t.match(/(^|[\n'"`])---\n/);
  if (!m) return null;
  const slice = t.slice(m.index + m[1].length);
  return declares(slice) ? slice : null;
}

/**
 * `mv|cp <origen> <destino>` donde el ORIGEN existe y ES una story (frontmatter con story:+status:):
 * renombrar o duplicar una story existente no es crearla a mano. Devuelve
 * { src, dest } absolutos o null. Sólo el primer segmento cp/mv del comando.
 */
/**
 * El destino de una escritura, absoluto y en la forma nativa de la máquina. En Windows un destino puede venir como
 * `C:\a\b`, `C:/a/b` o `/c/a/b` (la de Git Bash, que es con lo que corre el comando): las tres son el mismo archivo,
 * y sin pasarlas por una sola función la tercera no encontraría su repo y el portón dejaría pasar.
 * Fuera de Windows es lo de siempre.
 */
function resolveTarget(target, cwd, platform = process.platform, { homeVariable = false } = {}) {
  const P = platform === 'win32' ? path.win32 : path;
  let expanded = String(target).replace(/^~(?=\/|$)/, os.homedir());
  // `$HOME` sólo lo expande quien ya lo expandía (los destinos de una escritura): acá no cambia qué se expande
  if (homeVariable) expanded = expanded.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir());
  expanded = nativePath(expanded, platform);
  return P.isAbsolute(expanded) ? expanded : P.resolve(nativePath(cwd, platform), expanded);
}

// ── variables del comando ─────────────────────────────────────
// `SP=<scratchpad>; python3 -c "open('$SP/x.cs','w')"` sale frenado como «EDICIÓN INVISIBLE»: el destino se resuelve
// tal cual, `<repo>/$SP/x.cs`, y queda adentro del repo de la corrida.
// Las variables las expande `lib/command-vars.js`: con el valor que tenían EN ESE PUNTO del comando, y si el comando no
// las asignó, con el ambiente. Lo que no se puede saber sin ejecutar (`$(…)`, `${VAR:-x}`, una variable que nadie
// define) queda «sin resolver»: se resuelve como siempre (del lado seguro: si cae en el repo, frena) y queda marcado,
// para que el mensaje diga que no se pudo resolver en vez de presentarlo como código del repo sin más.
// (Un lector compartido, `scripts/lib/shell-parse.js`, no sirve acá:
// da rutas falsas — la cabecera de command-vars.js dice por qué.)
const { expandirRuta } = require('./lib/command-vars.js');

/**
 * Cada destino de escritura del comando, con su ruta absoluta: `[{ raw, abs, sinResolver: [nombres] }]`.
 * `sinResolver` lista lo que no se pudo resolver (vacía si se resolvió todo).
 */
function destinosResueltos(cmd, cwd, platform = process.platform, { keep = null } = {}) {
  return extractWriteTargets(cmd, { keep }).map((raw) => {
    const { valor, sinResolver } = expandirRuta(cmd, raw);
    return { raw, abs: resolveTarget(valor, cwd, platform, { homeVariable: true }), sinResolver };
  });
}

function renameOrCopyOfExistingStory(cmd, cwd) {
  const seg = splitSegments(stripNonCommandText(cmd)).find((sg) => /^(?:\w+=\S+\s+)*(?:sudo\s+)?(?:cp|mv|git\s+mv)\b/.test(sg.trim()));
  if (!seg) return null;
  const words = (seg.match(new RegExp(Q, 'g')) || []).map((w) => { const mm = w.match(new RegExp(`^${Q}$`)); return mm ? tok(mm, 1) : null; }).filter((w) => w && !w.startsWith('-'));
  if (words.length < 3) return null;
  const abs = (t) => resolveTarget(t, cwd);
  const src = abs(words[words.length - 2]);
  const dest = abs(words[words.length - 1]);
  try {
    const { probeStoryFile } = require('./lib/story-discovery.js');
    return fs.existsSync(src) && probeStoryFile(src) ? { src, dest } : null;
  } catch { return null; }
}

/** El nombre sugiere story cuando no hay contenido legible (cp / mv / tee desde un pipe). */
function nameSuggestsStory(abs) {
  const s = String(abs || '').replace(/\\/g, '/');
  return /(^|\/)story[-_.][^/]*\.md$/i.test(s) || /\/stories\/[^/]+\.md$/i.test(s);
}

// ── hook ──────────────────────────────────────────────────────────────────────────────────────────

function logHookError(e) {
  try {
    const dir = path.join(stateDirOf(os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-errors.log'),
      `[${new Date().toISOString()}] on-bash-write-gate FAILED OPEN: ${(e && e.stack) || e}\n\n`, 'utf8');
  } catch { /* noop */ }
}

/**
 * Anota dónde escribe un comando de consola, en
 * `<estado>/console-writes/<sesión>.jsonl`: una línea `{path, ts}` por destino. Lo lee
 * `scripts/metrics/run-change.js` (el arnés) al archivar la corrida, para saber en qué
 * repos buscar el cambio: sin esto, un repo que la corrida tocó sólo por consola no se mira nunca.
 * 🔴 NO va a `file-events/` ni al marcador: esos los leen los frenos de ATDD, y una escritura por consola
 *    ahí cambiaría sus veredictos. Es un registro, no un control: nunca cambia la decisión y un error al
 *    escribir no rompe nada. Apagado: TYCON_NO_RUN_CHANGE=1.
 * Si la carpeta todavía tiene el nombre en castellano, la primera anotación se lleva la vieja
 * entera (`prepareStateWrite` del puente) y el lector mira las dos mientras dure el renombre. Con un arnés anterior al
 * renombre el puente devuelve la vieja (es la que lee ese arnés). Si la migración falla, queda en hook-errors.log y la
 * anotación va a la vieja: perderla sería callar.
 */
function anotarEscriturasConsola(stateDir, sessionId, rutas, kind = null) {
  const legacy = require('./lib/legacy-names.js');
  const where = 'skills/tycon-pipeline/scripts/on-bash-write-gate.js';
  if (!rutas.length || legacy.readEnv('TYCON_NO_RUN_CHANGE', { where }) === '1') return;
  const nueva = path.join(stateDir, 'console-writes');
  let dir = nueva;
  try { dir = legacy.prepareStateWrite(nueva, { where }); } catch (e) {
    logHookError(e);
    try { dir = legacy.legacyStatePath(nueva) || nueva; } catch (_) { dir = nueva; }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const sid = String(sessionId || 'sin-sesion').replace(/[^\w.-]/g, '_');
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), rutas.map((p) => JSON.stringify(kind ? { path: p, ts, kind } : { path: p, ts })).join('\n') + '\n', 'utf8');
  } catch (e) { logHookError(e); /* el registro no puede trabar un comando, pero no se pierde callado */ }
}

/**
 * La puerta entera: primero el código deprecado del repo (on-deprecated-edit.js), que frena por su cuenta y no depende
 * de los demás frenos de esta puerta; después el carril y la historia a mano. Un aviso de lo deprecado viaja como
 * `aviso` si nada frena.
 */
function handle(event, opts = {}) {
  let deprecado = null;
  try {
    const cmd = event?.tool_input?.command;
    if (cmd && (!event?.tool_name || event.tool_name === 'Bash' || event.tool_name === 'PowerShell')) {
      const baseCwd = nativePath(event?.cwd || process.cwd());
      const cdDir = leadingCd(cmd);
      deprecado = require('./on-deprecated-edit.js').porLaTerminal({
        cmd, cwd: cdDir ? resolveTarget(cdDir, baseCwd) : baseCwd,
        // todo destino, sea o no código: lo deprecado puede ser una guía, un esquema o una configuración
        destinos: (c, cwd) => destinosResueltos(c, cwd, process.platform, { keep: () => true }).map((d) => d.abs),
        sessionId: resolveSessionId(event?.session_id),
        stateDir: opts.stateDir || require('./lib/story-gate-io.js').DEFAULT_STATE_DIR,
        via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`,
      });
    }
  } catch (e) { logHookError(e); deprecado = null; }
  if (deprecado && deprecado.block) return deprecado;
  return handleCarrilEHistoria(event, opts) || deprecado;
}

function handleCarrilEHistoria(event, opts = {}) {
  const laneOff = String(process.env.TYCON_STORY_GATE || '').toLowerCase() === 'off';
  const skillOff = String(process.env.TYCON_STORY_SKILL_GATE || '').toLowerCase() === 'off';
  // Bash, o la herramienta PowerShell de Claude Code en Windows (misma entrada)
  if (event?.tool_name && event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return null;
  const cmd = event?.tool_input?.command;
  if (!cmd) return null;
  const baseCwd = nativePath(event?.cwd || process.cwd());
  const cdDir = leadingCd(cmd);
  const cwd = cdDir ? resolveTarget(cdDir, baseCwd) : baseCwd;
  const io = require('./lib/story-gate-io.js');
  const stateDir = opts.stateDir || io.DEFAULT_STATE_DIR;
  const installedTree = require('./lib/installed-tree.js');
  const installedRoots = Array.isArray(opts.installedRoots) ? opts.installedRoots : io.defaultInstalledRoots();
  const { isInside } = require('./lib/atdd-preedit.js');
  // el estado y el árbol instalado del arnés se miran por ruta real, sea cual sea la extensión
  const stateReal = installedTree.realPath(stateDir);
  const protegido = (abs) => {
    const real = installedTree.realPath(abs);
    return isInside(stateDir, abs) || isInside(stateReal, real) || installedTree.inside(installedRoots, real, { real: true });
  };
  // un `.md` también se mira en un `sed -i`: puede ser una historia en borrador (el freno de historia sin validar)
  // (con las variables del comando expandidas: `sed -i … "$F"` con `F=story.md`)
  const keep = (t) => {
    const valor = expandirRuta(cmd, t).valor;
    return /\.md$/i.test(t) || /\.md$/i.test(String(valor)) || protegido(resolveTarget(valor, cwd, process.platform, { homeVariable: true }));
  };
  if (!laneOff) {
    const r = frenoBorrarYArmados({
      cmd, cwd, stateDir, sessionId: resolveSessionId(event?.session_id), io, isInside,
      via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`,
    });
    if (r) return r;
  }
  const targets = extractWriteTargets(cmd, { keep });
  if (!targets.length) return null;

  const sessionId = resolveSessionId(event?.session_id);
  // Con las variables del comando (y del ambiente) expandidas; lo no resuelto queda anotado para el mensaje
  const resueltos = destinosResueltos(cmd, cwd, process.platform, { keep });
  const absTargets = resueltos.map((d) => d.abs);
  const sinResolverDe = new Map(resueltos.filter((d) => d.sinResolver.length).map((d) => [d.abs, d]));
  // Antes de decidir y aunque los frenos estén apagados: dónde escribió la consola es un dato de la
  // corrida, no una decisión del freno.
  anotarEscriturasConsola(stateDir, sessionId, absTargets);
  if (laneOff && skillOff) return null;
  const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`;

  // ── Portón de CARRIL (código + estado del pipeline) ──────────────────────────────────────────
  if (!laneOff) {
    const passedCode = [];
    for (const abs of absTargets) {
      // un destino con una variable sin resolver PUEDE ser código aunque su ruta cruda no tenga la extensión
      // (`cat > $F`, `src/x.$EXT`): para el registro cuenta como código
      // …salvo que la extensión ESCRITA (sin variables) diga que no es código: `$OUT/notes.md` pasa como cualquier .md
      const extLiteral = /\.([^./\\$`{}]+)$/.exec(path.basename(abs));
      // un manifiesto o su lock: para el registro es código; para el carril, no
      const quizasCodigo = isCodeFile(abs) || isManifestFile(abs) || (sinResolverDe.has(abs) && !extLiteral);
      const enProtegido = protegido(abs);
      if (!quizasCodigo && !enProtegido) continue;
      if (isCodeFile(abs) || enProtegido) {
        const r = io.evaluate({ filePath: abs, sessionId, cwd, via, stateDir, installedRoots });
        if (r.verdict.action === 'block') return { block: r.message + '\n' };
      }
      if (quizasCodigo) passedCode.push(abs);
    }
    // ── TERCERA RESPONSABILIDAD: que el REGISTRO no se quede ciego ────────────────
    // El carril ya dijo que esta sesión PUEDE editar. Falta la otra mitad: si la edición va por
    // Bash con el pipeline abierto, el hook PostToolUse Edit|Write no la ve y `smart-reloop` se
    // queda sin delta (corren 7 revisores en vez de 2-3). Es el conflicto que declara la cabecera de este
    // archivo —"en auto mode el propio arnés INSTRUYE editar con sed/heredocs"— resuelto para el carril y
    // no para el registro. Se frena la edición invisible en vez de enseñarle al arnés a adivinarla.
    if (passedCode.length) {
      const lv = require('./lib/ledger-visible.js');
      const marker = io.readMarker(stateDir, sessionId);
      const vis = lv.evaluarVisibilidad({
        marker,
        codeTargets: passedCode,
        // un destino con una variable sin resolver PUEDE caer en el repo: cuenta como adentro, aunque la ruta cruda
        // anclada al cwd quede afuera (con la sesión parada en otra carpeta, pasaría callado)
        dentroDelRepo: (f, repo) => isInside(repo, f) || sinResolverDe.has(f),
        off: process.env.TYCON_LEDGER_VISIBLE,
      });
      if (vis.escaped && vis.escaped.length) {
        // El escape del dev deja su línea: el mensaje del freno lo promete, y la línea se escribe.
        try {
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'escaped',
            storyId: (marker && marker.storyId) || null, files: vis.escaped.length, paths: vis.escaped, via,
            reason: 'TYCON_LEDGER_VISIBLE=off en el ambiente de la sesión',
          }) + '\n', 'utf8');
        } catch (e) { logHookError(e); }
      }
      if (vis.block) {
        try {
          // Constancia en gates.log (misma forma que el resto). El freno NO depende de esto: si el
          // log falla, igual se frena — al revés sería un control que se apaga solo.
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'blocked',
            storyId: (marker && marker.storyId) || null, files: vis.files.length, via,
          }) + '\n', 'utf8');
        } catch { /* el freno no depende del log */ }
        const sinResolver = vis.files.filter((f) => sinResolverDe.has(f))
          .map((f) => ({ file: f, vars: sinResolverDe.get(f).sinResolver }));
        return { block: lv.mensaje(vis.files, marker && marker.storyId, { sinResolver }) + '\n' };
      }
      // Un destino sin resolver que pasa (sin corrida abierta, o con el escape) no queda callado: constancia en
      // gates.log con la ruta. No suma al cupo ad-hoc: no se sabe qué archivo es.
      const dudosos = passedCode.filter((f) => sinResolverDe.has(f));
      if (dudosos.length) {
        try {
          fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
            ts: new Date().toISOString(), sessionId,
            repoPath: (marker && marker.repoPath) || null, name: 'ledger-visible', status: 'unresolved-passed',
            storyId: (marker && marker.storyId) || null, files: dudosos.length, paths: dudosos, via,
            reason: vis.reason || 'destino con una variable sin resolver',
          }) + '\n', 'utf8');
        } catch (e) { logHookError(e); }
      }
    }

    // Cupo ad-hoc: Bash no tiene PostToolUse nuestro, así que el registro va acá (best-effort: el
    // comando puede fallar después, pero sin esto un hotfix hecho con heredocs nunca suma al cupo).
    for (const abs of passedCode.filter((f) => isCodeFile(f))) {   // un destino sin resolver no suma al cupo: no se sabe cuál es
      try { io.recordAdhocFile(stateDir, sessionId, abs); } catch { /* best-effort */ }
    }
  }

  // ── Freno de STORY A MANO — la puerta Bash ─────────────────────────────────────
  if (!skillOff) {
    const mdNew = absTargets.filter((abs) => /\.md$/i.test(abs) && !fs.existsSync(abs));
    // una historia que existe y está en borrador: escribirle encima desde acá puede pasarla a ready-for-dev sin el validador
    const mdDraft = absTargets.filter((abs) => /\.md$/i.test(abs) && fs.existsSync(abs));
    if (mdDraft.length) {
      const sio = require('./lib/story-skill-gate-io.js');
      const hds = heredocs(cmd);
      const sameFile = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
      const resolveT = (t) => { const d = resueltos.find((x) => x.raw === t); return d ? d.abs : resolveTarget(t, cwd); };
      for (const abs of mdDraft) {
        const own = hds.find((h) => h.target && sameFile(resolveT(h.target), abs));
        // con `>>` el cuerpo del heredoc no es el archivo entero: no se sabe qué estado queda
        const r = sio.evaluate({ absPath: abs, content: own && !/>>/.test(cmd) ? own.body : null, sessionId, via, event, stateDir });
        if (r.verdict.action === 'block') return { block: r.message + '\n' };
      }
    }
    if (mdNew.length) {
      const sio = require('./lib/story-skill-gate-io.js');
      let declares = (t) => /^---[\s\S]*?^[ \t]*story[ \t]*:/m.test(t);
      try { ({ declaresStoryIdentity: declares } = require('./lib/story-discovery.js')); } catch { /* fallback regex */ }
      const hds = heredocs(cmd);
      const sameFile = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
      // el mismo destino que se juzgó arriba, con las variables del comando expandidas
      const resolveT = (t) => { const d = resueltos.find((x) => x.raw === t); return d ? d.abs : resolveTarget(t, cwd); };
      // Un cuerpo sin target atribuible sólo se usa si el comando escribe UN solo .md nuevo.
      const orphanBody = hds.filter((h) => !h.target && declares(h.body)).map((h) => h.body)[0] || null;
      const inline = hds.length ? null : inlineStoryText(cmd, declares);
      const renamedStory = renameOrCopyOfExistingStory(cmd, cwd);
      for (const abs of mdNew) {
        const own = hds.find((h) => h.target && sameFile(resolveT(h.target), abs));
        let content = own ? own.body : null;
        if (!content && !own && mdNew.length === 1) content = orphanBody || inline;
        // `mv`/`cp` desde una story EXISTENTE: es renombrar/duplicar, no crear. Pasa y queda medido.
        if (!content && renamedStory && sameFile(renamedStory.dest, abs)) {
          sio.logUnknown({ absPath: abs, sessionId, via, stateDir, kind: 'unknown-rename', reason: `renombrado/copia de una story existente (${path.basename(renamedStory.src)})` });
          continue;
        }
        const r = sio.evaluate({
          absPath: abs, content, nameHint: !content && nameSuggestsStory(abs),
          sessionId, via, event, stateDir,
        });
        if (r.verdict.action === 'block') return { block: r.message + '\n' };
      }
    }
  }
  return null;
}

module.exports = { handle, resolveTarget, destinosResueltos, extractWriteTargets, destinosArmados, destinosBorrados, stripNonCommandText, leadingCd, heredocs, heredocBodies, inlineStoryText, nameSuggestsStory, renameOrCopyOfExistingStory };

if (require.main === module) {
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch { event = null; }
  let r = null;
  try { r = handle(event || {}); } catch (e) { logHookError(e); r = null; }
  if (r && r.block) { process.stderr.write(r.block); process.exit(2); }
  // Antes de cerrar «Aprobar el plan», el arnés le muestra a la persona el plan si el agente no lo hizo (lib/plan-display.js) y,
  // si la historia cambia una pantalla en un repo sin prueba con navegador, la oferta de prepararla (lib/browser-test.js).
  // Van en un solo aviso.
  const avisos = [];
  // el código deprecado que se escribe por la terminal con `deprecated.edit: warn`
  if (r && r.aviso) avisos.push({ systemMessage: r.aviso, anotar() {} });
  const pedido = {
    command: event && event.tool_input && event.tool_input.command,
    sessionId: resolveSessionId(event && event.session_id), stateDir: require('./lib/story-gate-io.js').DEFAULT_STATE_DIR,
  };
  try { const pd = require('./lib/plan-display.js').planParaMostrar(pedido); if (pd) avisos.push(pd); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar el plan para mostrarlo (${e.message})\n`); }
  // antes de eximir un crítico, el arnés se lo muestra a la persona: el ok vale si responde a eso (lib/critical-display.js)
  try { const cd = require('./lib/critical-display.js').paraMostrar(pedido); if (cd) avisos.push(cd); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar el crítico para mostrarlo (${e.message})\n`); }
  // antes de marcar criterios como probados a mano, el arnés le muestra a la persona cuáles (lib/manual-checks.js)
  try { const mc = require('./lib/manual-checks.js').paraMostrar(pedido); if (mc) avisos.push(mc); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar los criterios para mostrarlos (${e.message})\n`); }
  // antes de firmar un criterio que no se puede probar en vivo, el arnés se lo muestra a la persona (lib/waiver-display.js)
  try { const wd = require('./lib/waiver-display.js').paraMostrar(pedido); if (wd) avisos.push(wd); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude armar el criterio para mostrarlo (${e.message})\n`); }
  try { const of = require('./lib/browser-test.js').offerToShow(pedido); if (of) avisos.push(of); } catch (e) { logHookError(e); process.stderr.write(`⚠️  no pude decidir si va la oferta de la prueba con navegador (${e.message})\n`); }
  if (avisos.length) {
    process.stdout.write(JSON.stringify({ systemMessage: avisos.map((a) => a.systemMessage).join('\n\n') }));
    for (const a of avisos) { try { a.anotar(); } catch (e) { logHookError(e); } }
  }
  process.exit(0);
}
