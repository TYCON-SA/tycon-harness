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
 * Una historia que existe y no está en borrador no se escribe desde acá: desde un comando no se ve qué queda escrito, y
 * su estado lo cambia marker.js. Frena con o sin ejecución abierta.
 *
 * ── TERCERA: los marcadores de la ejecución ───────────────────────────────────────────────
 * Borrar o mover un marcador (`<estado>/active/`, `<estado>/active.json`, o una carpeta que los contiene), de esta
 * sesión o de otra, frena: la ejecución se cierra con `marker.js clear` o `clear-session`. Cuenta también un guion
 * inline que borra (`unlinkSync`, `os.remove`, `rmtree`…). Con el carril apagado, no.
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
  let t = String(s).replace(/((?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*)(?<!\$\(\([^\n]*)(?<!<)<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\2(?=[\s;&|()<>]|$)[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
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

// lo que vuelve compleja la parte de un comando antes de su `cd`: comillas, sustituciones, paréntesis o llaves, tuberías,
// `||`, un `&` suelto, comentarios, redirecciones, heredocs, escapes y las palabras de control del shell
const ANTES_DEL_CD_COMPLEJO = /['"`(){}|<>#\\]|\$\(|(?:^|[^&])&(?!&)|\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|eval|source|exec|bash|sh|zsh)\b/;

/**
 * La carpeta contra la que se resuelven los destinos relativos del comando. Sólo una forma se sigue:
 * `[VAR=literal; …;] [… &&] cd DIR && <escritura>`, con el primer `cd` del comando, todo lo de antes simple (ver
 * ANTES_DEL_CD_COMPLEJO), `DIR` resuelto sin `$(…)` ni opciones, un `&&` después y cada destino relativo adentro de esa
 * misma cadena de `&&` y antes de cualquier otro `cd`: si el `cd` falla, la escritura no corre, y un `cd` posterior no
 * cambia dónde cayó. Cualquier otra forma resuelve como antes de esta función: con el `cd` del principio (`leadingCd`),
 * salvo que un segundo `cd` venga antes de una escritura relativa, que resuelve contra la carpeta de la sesión.
 */
function cwdDelComando(cmd, baseCwd) {
  return resolverCd(cmd, baseCwd).dir;
}

/**
 * Las carpetas donde puede caer una escritura relativa del comando: una sola, salvo que sea ambiguo (un segundo `cd`
 * antes de una escritura relativa, fuera de la forma mínima). Ahí, la de la sesión, la del `cd` del principio y la de
 * cada `cd` que se pueda resolver (seguido del anterior, o desde la sesión).
 */
function carpetasDelComando(cmd, baseCwd) {
  const r = resolverCd(cmd, baseCwd);
  if (r.forma !== 'ambiguo') return [r.dir];
  const raw = String(cmd || '');
  const out = [baseCwd];
  const d = leadingCd(raw);
  if (d) out.push(resolveTarget(d, baseCwd));
  let previa = baseCwd;
  for (const m of r.s.matchAll(/\bcd[ \t]+(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>'"`]+))/g)) {
    const tok = m[1] ?? m[2] ?? m[3];
    if (!tok || tok.startsWith('-')) continue;
    const ex = expandirRuta(raw.slice(0, m.index + m[0].length), tok);
    if (ex.sinResolver.length) continue;
    previa = resolveTarget(ex.valor, previa, process.platform, { homeVariable: true });
    out.push(previa, resolveTarget(ex.valor, baseCwd, process.platform, { homeVariable: true }));
  }
  return [...new Set(out)];
}

/** Los destinos relativos que escribe un tramo de un comando (con las variables de `raw`); null si alguno no se sabe. */
function relativosDe(raw, texto) {
  const armados = destinosArmados(texto);
  if (armados.some((a) => !a.literal && !a.literales)) return null;
  return [
    ...extractWriteTargets(texto, { keep: () => true }),
    ...destinosBorrados(texto).map((d) => d.raw),
    ...armados.flatMap((a) => (a.literal ? [a.literal] : a.literales)),
  ].filter((t) => { const v = expandirRuta(raw, t).valor; return !path.isAbsolute(v) && !/^~/.test(v) && !/^[A-Za-z]:[\\/]/.test(v); });
}

/** La decisión de `cwdDelComando`: `{ dir, forma: 'sin-cd'|'minima'|'hoy'|'ambiguo', s }`. */
function resolverCd(cmd, baseCwd) {
  const raw = String(cmd || '');
  // los cuerpos de heredoc, en blanco con su largo: las posiciones siguen siendo las del comando
  let s = raw;
  let cds = [];
  // como hoy: el cd del principio (`leadingCd`), salvo que un segundo cd venga antes de una escritura relativa (ahí no se
  // sabe en qué carpeta cae: ambiguo, y la de la sesión)
  const hoy = () => {
    const d = leadingCd(raw);
    if (cds.length > 1) {
      const despues = relativosDe(raw, raw.slice(cds[1].index));
      if (!despues || despues.length) return { dir: baseCwd, forma: 'ambiguo', s };
    }
    return d ? { dir: resolveTarget(d, baseCwd), forma: 'hoy', s } : { dir: baseCwd, forma: 'hoy', s };
  };
  try {
    s = raw.replace(/((?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*)(?<!\$\(\([^\n]*)(?<!<)<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\2(?=[\s;&|()<>]|$)[^\n]*\n)([\s\S]*?)(\n[ \t]*\3[ \t]*(?=\n|$))/g, (m, cab, _q, _d, cuerpo, cierre) => cab + cuerpo.replace(/[^\n]/g, ' ') + cierre);
    cds = [...s.matchAll(/\bcd\b/g)];
    if (!cds.length) return { dir: baseCwd, forma: 'sin-cd', s };
    const m = /(^|;|\n|&&)[ \t]*cd[ \t]+([^\s;&|()<>'"`\\]+)[ \t]*&&/.exec(s.slice(Math.max(0, cds[0].index - 3)));
    if (!m) return hoy();
    const enCd = Math.max(0, cds[0].index - 3) + m.index + m[1].length;
    const antes = raw.slice(0, enCd);
    if (ANTES_DEL_CD_COMPLEJO.test(antes)) return hoy();
    const dirRaw = m[2];
    if (dirRaw.startsWith('-') || dirRaw.includes('$(')) return hoy();
    const ex = expandirRuta(antes + 'cd ' + dirRaw, dirRaw);
    if (ex.sinResolver.length) return hoy();
    const dir = resolveTarget(ex.valor, baseCwd, process.platform, { homeVariable: true });
    // el fin de la cadena de `&&` que arranca en el cd: el primer `;`, `||`, `|`, `&` suelto o fin de línea fuera de
    // comillas y de paréntesis (un heredoc se saltea entero: su cuerpo es parte del comando que lo abre)
    const desde = Math.max(0, cds[0].index - 3) + m.index + m[0].length;
    let fin = raw.length;
    let q = null;
    let nivel = 0;
    const pendientes = [];
    for (let i = desde; i < raw.length; i++) {
      const c = raw[i];
      if (q) { if (c === '\\' && q !== "'") i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(') { nivel++; continue; }
      if (c === ')') { nivel--; continue; }
      const h = /^<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/.exec(raw.slice(i, i + 80));
      if (h) { pendientes.push(h[2]); i += h[0].length - 1; continue; }
      if (c === '\n' && pendientes.length) {
        let j = i;
        while (pendientes.length) {
          const del = pendientes.shift();
          const cierre = new RegExp(`\\n[ \\t]*${del}[ \\t]*(?=\\n|$)`).exec(raw.slice(j));
          if (!cierre) return hoy();
          j += cierre.index + cierre[0].length;
        }
        i = j - 1;
        continue;
      }
      if (nivel > 0) continue;
      if (c === ';' || c === '\n' || c === '|' || (c === '&' && raw[i + 1] !== '&' && raw[i - 1] !== '&')) { fin = i; break; }
    }
    if (q || nivel !== 0) return hoy();
    // un segundo cd corta la cadena: lo que viene después ya no se sabe dónde cae
    if (cds.length > 1) fin = Math.min(fin, cds[1].index);
    const cadena = relativosDe(raw, raw.slice(desde, fin));
    const resto = relativosDe(raw, raw.slice(0, enCd) + '\n' + raw.slice(fin));
    const todos = relativosDe(raw, raw);
    if (!cadena || !resto || !todos) return hoy();
    // cada destino relativo del comando se escribe adentro de la cadena del cd, y nada fuera de ella escribe uno relativo
    return resto.length === 0 && todos.every((t) => cadena.includes(t)) ? { dir, forma: 'minima', s } : hoy();
  } catch (e) {
    logHookError(e);
    try { return hoy(); } catch (_e) { return { dir: baseCwd, forma: 'ambiguo', s }; }
  }
}

// La forma de `$(…)` que el nombre de un informe puede llevar: `$(date +F)` con un formato sólo de dígitos, `-` y `_`.
// Su salida no tiene `/` ni `.`. (`basename` no entra: `basename /` da `/`, y su salida puede abrir una carpeta)
const SUBCOMANDO_EN_DESTINO = String.raw`\$\(date \+(?:%[YmdHMSsjy]|[-_])+\)`;
// el destino entero detrás de `>`, `>>` o `tee`, que termina en un espacio, un operador o el final: nunca en una
// comilla ni en una barra invertida, que lo seguirían (`r-$(date +%s).md'.ts'` escribe un `.ts`)
const DESTINO_CON_SUBCOMANDO = new RegExp(String.raw`((?:^|[^<>&])(?:>{1,2}|\btee(?:[ \t]+-a)?)[ \t]*)((?:[^\s'"|;&<>$\`()\\]|\$\{?[A-Za-z_]\w*\}?|${SUBCOMANDO_EN_DESTINO})+)(?=$|[\s;&|)<>])`, 'g');

/**
 * Qué posiciones de `cmd` son texto de comando: fuera de las comillas y fuera del cuerpo de un heredoc. Un `>` adentro
 * de un mensaje de commit o de un heredoc no es una redirección.
 */
function posicionesDeComando(cmd) {
  const s = String(cmd || '');
  const es = new Array(s.length).fill(true);
  for (const m of s.matchAll(/<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?\n)[ \t]*\2[ \t]*(?=\n|$)/g)) {
    const desde = m.index + m[0].indexOf('\n') + 1;
    for (let i = desde; i < m.index + m[0].length; i++) es[i] = false;
  }
  let q = null;
  for (let i = 0; i < s.length; i++) {
    if (!es[i]) continue;
    const c = s[i];
    if (q) { es[i] = false; if (c === q) q = null; else if (c === '\\' && q === '"') { es[i + 1] = false; i++; } continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { q = c; es[i] = false; }
  }
  return es;
}

/**
 * El comando con cada `$(date +F)` adentro de un destino de escritura `.md` o `.log` cambiado por un comodín de un
 * segmento: `{ cmd, destinos }`, con `destinos` los destinos con comodín (`out/run-*.log`). Sólo cuando el destino es
 * texto de comando, cada `$(…)` está pegado a texto en su segmento (nunca el segmento entero) y la carpeta que se sabe
 * antes del primer `$(…)` pasa `seguro(carpeta, glob)`; si no, ese destino queda como está y frena como hoy.
 */
function subcomandosComoComodin(cmd, seguro) {
  const destinos = [];
  const texto0 = String(cmd || '');
  // un `date` que el comando redefine (función, alias, otro PATH) ya no es el de siempre: su salida no se sabe
  if (/\bdate\s*\(\s*\)|\bfunction\s+date\b|\balias\s+date\b|(?:^|[\s;&|(])(?:export\s+)?PATH=/.test(texto0)) return { cmd, destinos };
  const es = posicionesDeComando(cmd);
  const texto = texto0.replace(DESTINO_CON_SUBCOMANDO, (todo, antes, palabra, en) => {
    const desde = en + antes.length;
    if (!es.slice(desde, desde + palabra.length).every(Boolean)) return todo;
    if (!new RegExp(SUBCOMANDO_EN_DESTINO).test(palabra) || !/\.(?:md|log)$/.test(palabra)) return todo;
    // lo que el shell expande en el destino además del `$(…)`: llaves (`{specs,out}`), comodines escritos y un `~` que
    // no está al principio. Con eso la carpeta no es la que se lee: queda como está
    const sinSub = palabra.replace(new RegExp(SUBCOMANDO_EN_DESTINO, 'g'), '').replace(/\$\{[A-Za-z_]\w*\}/g, '');
    if (/[{}*?[]/.test(sinSub) || /.~/.test(sinSub)) return todo;
    const glob = palabra.replace(new RegExp(SUBCOMANDO_EN_DESTINO, 'g'), '*');
    const segmentos = glob.split('/');
    if (segmentos.some((s) => /^\*+$/.test(s))) return todo;
    const conocida = segmentos.slice(0, segmentos.findIndex((s) => s.includes('*'))).join('/') || '.';
    if (!seguro(conocida, glob)) return todo;
    destinos.push(glob);
    return antes + glob;
  });
  return { cmd: texto, destinos };
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
  // python: Path('f').write_text(…) / pathlib.Path('f').write_bytes(…)
  const rePathWrite = /\bPath\(\s*(['"])([^'"]+)\1\s*\)\s*\.(?:write_text|write_bytes)\s*\(/g;
  while ((m = rePathWrite.exec(raw))) out.add(m[2]);
  // ruby: File.write('f', …) / IO.write / File.binwrite (`File.open('f', 'w')` ya lo ve el `open(` de arriba)
  const reRubyWrite = /\b(?:File|IO)\.(?:write|binwrite)\(\s*(['"])([^'"]+)\1/g;
  while ((m = reRubyWrite.exec(raw))) out.add(m[2]);
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

const INTERPRETES = 'node|nodejs|python[0-9.]*|perl|ruby|pwsh|powershell';
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
  const sinCuerpos = raw.replace(/((?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*)(?<!\$\(\([^\n]*)(?<!<)<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\2(?=[\s;&|()<>]|$)[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  for (const m of sinCuerpos.matchAll(conFlag)) out.push({ script: m[3], argv: argumentosDe(m[4]) });
  // por la entrada: el heredoc o el here-string que llega a un intérprete como su programa, detrás de un envoltorio,
  // en otra etapa de la tubería o con `/dev/stdin`
  for (const p of programasPorEntrada(raw)) {
    // `node - a`: process.argv[1] es '-' y el primer argumento es process.argv[2]; en python, sys.argv[1] ya es `a`
    const argv = !p.conGuion ? [] : /^(?:node|nodejs|bun|deno)$/.test(p.interprete) ? ['-', ...p.despues] : p.despues;
    // un heredoc sin comillas (`<<EOF`): el shell expande las variables del cuerpo antes de correrlo
    out.push({ script: p.cuerpo, argv, expande: !p.comillas });
  }
  return out;
}

// Quién lee el programa de la entrada lo decide el lector compartido, el mismo del freno de producción: los dos juzgan
// igual el mismo comando. Sólo se usa esta función; las variables las sigue resolviendo command-vars.js. Sin el lector
// (una instalación a medias) el portón carga igual, y cada cuerpo de heredoc cuenta como programa: frena de más
let lectorDeEntrada;
function programasPorEntrada(raw) {
  if (lectorDeEntrada === undefined) {
    try { ({ programasPorEntrada: lectorDeEntrada } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'lib', 'shell-parse.js'))); } catch { lectorDeEntrada = null; }
  }
  if (lectorDeEntrada) return lectorDeEntrada(raw);
  return [...raw.matchAll(/(?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*)(?<!\$\(\([^\n]*)(?<!<)<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\1(?=[\s;&|()<>]|$)[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g)]
    .map((m) => ({ interprete: '', conGuion: false, despues: [], cuerpo: m[3], comillas: Boolean(m[1]) }));
}

// los intérpretes que corren un guion guardado en un archivo
const CORRE_ARCHIVO = /^(?:node|nodejs|python[0-9.]*|perl|ruby|bun|deno|tsx|ts-node)$/;
// lo que el guion escribe se lee entero hasta este tamaño; más grande, cuenta si nombra una historia o una constancia
const GUION_TOPE = 256 * 1024;
const GUION_TOPE_DURO = 64 * 1024 * 1024;
const MENCIONA_HISTORIA = /control-changes|stor(?:y|ies)|historia/i;
const EXTENSION_DE = { python: /\.py$/i, node: /\.(?:[cm]?js|[cm]?ts)$/i, perl: /\.p[lm]$/i, ruby: /\.rb$/i };
const familiaDe = (interprete) => (/^python/.test(interprete) ? 'python' : interprete === 'perl' ? 'perl' : interprete === 'ruby' ? 'ruby' : 'node');

/**
 * Las opciones de un intérprete hasta su guion: `{ enLinea, desde, modulos, precargas }`. `enLinea` si el programa va
 * en la línea (`-c`, `-e`: lo ve `scriptsInline`), `desde` la primera palabra que ya no es opción, `modulos` lo que se
 * corre como módulo (`python3 -m x`) y `precargas` los guiones que se cargan antes (`node -r ./p.js`). Cada familia lee
 * sus opciones agrupadas y con el valor pegado (`-Wignore`, `-mx`, `-Ilib`, `--require=./p.js`).
 */
function opcionesDelInterprete(familia, words, i) {
  const r = { enLinea: false, desde: words.length, modulos: [], precargas: [] };
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { r.desde = i + 1; return r; }
    if (!w.startsWith('-') || w === '-') { r.desde = i; return r; }
    if (familia === 'node') {
      const largo = /^(--[\w-]+)(?:=(.*))?$/.exec(w);
      const nombre = largo ? largo[1] : w;
      if (['-e', '-p', '--eval', '--print'].includes(nombre) || /^-[A-Za-z]*[ep]$/.test(w)) r.enLinea = true;
      if (['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(nombre)) {
        const v = largo && largo[2] != null ? largo[2] : words[++i];
        if (v) r.precargas.push(v);
      }
      continue;
    }
    // una opción larga con su valor aparte deja el valor como palabra: no existe como archivo, y se sigue buscando
    if (w.startsWith('--')) continue;
    // opciones cortas agrupadas: la que lleva valor se queda con el resto de la palabra, o con la siguiente
    const conValor = { python: 'WXm', perl: 'IMmlCx0', ruby: 'IrCEFKTWx0' }[familia] || '';
    const enLinea = { python: 'c', perl: 'eE', ruby: 'e' }[familia] || '';
    for (let k = 1; k < w.length; k++) {
      const c = w[k];
      if (enLinea.includes(c)) { r.enLinea = true; break; }
      if (conValor.includes(c)) {
        const v = k + 1 < w.length ? w.slice(k + 1) : (c === 'x' || c === '0' ? '' : words[++i]);
        if (familia === 'python' && c === 'm' && v) r.modulos.push(v);
        if (familia === 'ruby' && c === 'r' && v) r.precargas.push(v);
        break;
      }
    }
  }
  return r;
}

/** La palabra sin los signos del shell que la pegan a un grupo: `(python3`, `p.py)`, `{`. */
const sinGrupo = (w) => String(w).replace(/^[({]+/, '').replace(/[)};]+$/, '');

/**
 * Los guiones que el comando corre desde un archivo (`python3 p.py a`, `time node p.js`, `./x.py`, `python3 -m x`,
 * `node -r ./p.js`), leídos: `[{ interprete, archivo, texto, argv, grande }]`. El intérprete se busca en cualquier
 * palabra del tramo, detrás de cualquier envoltorio (`time`, `sudo -u x`, `nice -10`, `if … then`, `xargs`); el guion
 * es la primera palabra después de sus opciones que existe, desde cada carpeta donde puede estar parado el comando, o
 * que escribe un heredoc del mismo comando. Se lee de su ruta real, la misma que corre el intérprete, y con él los
 * módulos locales que importa. Un guion de la instalación del arnés no cuenta, por la ruta real ya resuelta: el
 * orquestador escribe historias.
 */
function guionesEnArchivo(cmd, bases, instalados = []) {
  const out = [];
  const vistos = new Set();
  const escritos = heredocs(cmd).filter((h) => h.target);
  const todosLosTramos = comandosAnidados(cmd).flatMap((sub) => tramos(sub));
  const palabrasDe = (tramo) => palabras(tramo.trim().replace(PREFIJO, '')).map(sinGrupo).filter((w) => w !== '');
  // la ruta real del guion tal como la abre el intérprete: unida a la carpeta sin normalizar, para que `enlace/..` se
  // resuelva por donde lleva el enlace y no por el texto (la versión nativa: la otra normaliza el `..` antes)
  const rutaReal = (valor, base) => {
    const crudo = valor.startsWith('~/') ? os.homedir() + valor.slice(1) : path.isAbsolute(valor) ? valor : `${base}${path.sep}${valor}`;
    try { return fs.realpathSync.native(crudo); } catch { return null; }
  };
  const instalado = (real) => instalados.some((r) => isInsideReal(r, real)) || versionadoEnElArbolPropio(real);
  const leer = (real) => {
    try {
      const st = fs.statSync(real);
      if (!st.isFile()) return null;
      if (st.size > GUION_TOPE_DURO) return { texto: '', grande: true };
      const texto = fs.readFileSync(real, 'utf8').replace(/\u0000/g, ' ');
      return { texto, grande: st.size > GUION_TOPE };
    } catch { return null; }
  };
  // el guion y los módulos locales que importa, hasta dos niveles y veinte archivos; uno del arnés no se revisa, pero
  // lo que importa pasa la misma prueba
  const agregar = (interprete, real, leido, argv, hondo = 0, exento = false) => {
    if (vistos.has(real) || vistos.size >= 20) return;
    vistos.add(real);
    if (!exento) out.push({ interprete, archivo: real, texto: leido.texto, argv, grande: leido.grande });
    if (hondo >= 2 || (leido.grande && !exento)) return;
    for (const m of importsLocales(familiaDe(interprete), leido.texto, path.dirname(real))) {
      const r = rutaReal(m, path.dirname(real));
      if (!r) continue;
      const l = leer(r);
      if (l) agregar(interprete, r, l, argv, hondo + 1, instalado(r));
    }
  };
  // un guion nombrado: su archivo, la carpeta (`__main__.py`, `index.js`) o el heredoc que lo escribe
  const abrir = (interprete, valor, argv) => {
    for (const base of bases) {
      let real = rutaReal(valor, base);
      if (real && fs.statSync(real).isDirectory()) {
        real = rutaReal(familiaDe(interprete) === 'python' ? '__main__.py' : 'index.js', real);
        if (!real) return false;
      }
      if (real) {
        const leido = leer(real);
        if (!leido) { if (instalado(real)) return true; continue; }
        agregar(interprete, real, leido, argv, 0, instalado(real));
        return true;
      }
      const abs = resolveTarget(valor, base, process.platform, { homeVariable: true });
      const h = escritos.find((x) => resolveTarget(expandirRuta(cmd, x.target).valor, base, process.platform, { homeVariable: true }) === abs);
      if (h) { agregar(interprete, abs, { texto: h.body.replace(/\u0000/g, ' '), grande: false }, argv); return true; }
    }
    return false;
  };
  const argumentos = (ws) => ws.filter((w) => !/^(?:\d|&)?[<>]/.test(w)).map((w) => expandirRuta(cmd, w).valor);
  for (const tramo of todosLosTramos) {
    const words = palabrasDe(tramo);
    // el ejecutable directo con su línea `#!` (`./x.py`, `bin/x`)
    for (let k = 0; k < words.length; k++) {
      if (!words[k].includes('/')) continue;
      const valor = expandirRuta(cmd, words[k]).valor;
      for (const base of bases) {
        const real = rutaReal(valor, base);
        if (!real) continue;
        try {
          const st = fs.statSync(real);
          if (!st.isFile() || !(st.mode & 0o111)) break;
          const linea = fs.readFileSync(real, 'utf8').slice(0, 200).split('\n')[0];
          // `#!/usr/bin/python3` · `#!/usr/bin/env -S python3 -u`: con `env`, el intérprete es su primera palabra
          const partes = linea.startsWith('#!') ? linea.slice(2).trim().split(/\s+/) : [];
          const interprete = nombreDeComando(partes[0]) === 'env'
            ? nombreDeComando(partes.slice(1).find((x) => !x.startsWith('-') && !x.includes('=')))
            : nombreDeComando(partes[0]);
          if (interprete && CORRE_ARCHIVO.test(interprete)) {
            const leido = leer(real);
            if (leido) agregar(interprete, real, leido, argumentos(words.slice(k + 1)), 0, instalado(real));
          }
        } catch { /* no se lee: no es un guion */ }
        break;
      }
    }
    for (let k = 0; k < words.length; k++) {
      const interprete = nombreDeComando(words[k]);
      if (!CORRE_ARCHIVO.test(interprete)) continue;
      const familia = familiaDe(interprete);
      let i = k + 1;
      if (/^(?:bun|deno)$/.test(interprete) && words[i] === 'run') i++;
      const op = opcionesDelInterprete(familia, words, i);
      for (const p of op.precargas) abrir(interprete, p, []);
      for (const m of op.modulos) {
        const rel = m.replace(/\./g, '/');
        if (!abrir(interprete, `${rel}.py`, argumentos(words.slice(op.desde)))) abrir(interprete, `${rel}/__main__.py`, argumentos(words.slice(op.desde)));
      }
      if (op.enLinea || op.modulos.length) continue;
      let hallado = false;
      for (let j = op.desde; j < words.length && !hallado; j++) {
        const w = words[j];
        if (w === '-' || /^\/dev\/(?:stdin|fd\/0)$/.test(w) || /^(?:\d|&)?[<>]/.test(w)) break;
        hallado = abrir(interprete, expandirRuta(cmd, w).valor, argumentos(words.slice(j + 1)));
      }
      // `echo p.py | xargs python3`: el guion llega por la entrada; cuenta cada archivo del comando con su extensión
      if (!hallado && words.slice(0, k).some((w) => nombreDeComando(w) === 'xargs')) {
        for (const w of todosLosTramos.flatMap(palabrasDe)) if (EXTENSION_DE[familia].test(w)) abrir(interprete, expandirRuta(cmd, w).valor, []);
      }
    }
  }
  return out;
}

/** Los módulos locales que importa un guion, como rutas relativas a su carpeta (los de la biblioteca no existen ahí). */
function importsLocales(familia, texto, dir) {
  const out = [];
  if (familia === 'python') {
    for (const m of texto.matchAll(/^[ \t]*(?:from[ \t]+\.?([\w.]+)[ \t]+import\b|import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*))/gm)) {
      for (const n of (m[1] || m[2]).split(',').map((x) => x.trim().replace(/\./g, '/'))) out.push(`${n}.py`, `${n}/__init__.py`);
    }
  } else if (familia === 'ruby') {
    for (const m of texto.matchAll(/\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(/\.rb$/.test(m[1]) ? m[1] : `${m[1]}.rb`);
  } else if (familia === 'node') {
    for (const m of texto.matchAll(/(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g)) {
      out.push(m[2], ...['.js', '.cjs', '.mjs', '.ts', '/index.js'].map((e) => m[2] + e));
    }
  }
  return out.filter((r) => { try { return fs.statSync(path.join(dir, r)).isFile(); } catch { return false; } });
}

/**
 * ¿`real` es un guion del árbol de este freno, y ese árbol es el arnés y no un repo donde se trabaja? Sin git (una
 * versión bajada) es el arnés. En un clon de trabajo, el de quien lo mantiene, cuenta sólo lo versionado y sin
 * cambios: un guion nuevo o cambiado ahí no es del arnés. Si git no responde, tampoco.
 */
function versionadoEnElArbolPropio(real) {
  const arbol = (() => { try { return fs.realpathSync.native(path.resolve(__dirname, '..', '..', '..')); } catch { return null; } })();
  if (!arbol || !isInsideReal(arbol, real)) return false;
  const conGit = (() => {
    for (let d = arbol; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) return true;
      if (path.dirname(d) === d) return false;
    }
  })();
  if (!conGit) return true;
  const rel = path.relative(arbol, real);
  const { spawnSync } = require('child_process');
  // sin el repo de quien llama: un GIT_DIR heredado haría contestar a otro repo; la ruta, literal: `orq-[x].js` no
  // es un patrón que encuentre a `orq-x.js`
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const git = (args) => spawnSync('git', ['-C', arbol, ...args], { encoding: 'utf8', timeout: 3000, env });
  // `-v` marca con minúscula o con `S` lo que git dejó de mirar (`--assume-unchanged`, `--skip-worktree`)
  const versionado = git(['ls-files', '-v', '--error-unmatch', '--', rel]);
  if (versionado.status !== 0) return false;
  const lineas = versionado.stdout.split('\n').filter(Boolean);
  if (lineas.length !== 1 || lineas[0] !== `H ${rel.split(path.sep).join('/')}`) return false;
  const cambios = git(['status', '--porcelain', '--', rel]);
  if (cambios.status !== 0 || cambios.stdout.trim() !== '') return false;
  // versionado en un commit que sólo está en este clon no cuenta: lo pudo escribir quien llama
  const locales = git(['rev-list', '-n1', 'HEAD', '--not', '--remotes']);
  return locales.status === 0 && locales.stdout.trim() === '';
}

/** ¿`p` (ya resuelta) cae adentro de la carpeta `dir`, comparadas por su ruta real? */
function isInsideReal(dir, p) {
  const installedTree = require('./lib/installed-tree.js');
  const d = installedTree.realPath(dir) || path.resolve(dir);
  const rel = path.relative(d, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Lo que un guion en archivo escribe con una ruta que se sabe: las escrituras literales y las que arma con sus
 * argumentos, como si llegara en la línea. `armadosSinSaber` cuenta los destinos que arma de un modo que no se lee
 * (`argparse`, un desempaquetado): con una historia entre los argumentos, cuenta esa historia. Los demás textos del
 * guion no cuentan: un guion que sólo lee una historia no la escribe.
 */
function escritosDelGuion(g) {
  const comillas = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
  const forma = `${g.interprete} - ${g.argv.map(comillas).join(' ')} <<'__TYCON_GUION__'\n${g.texto}\n__TYCON_GUION__`;
  const armados = destinosArmados('', [{ script: g.texto, argv: g.argv }]);
  const perl = [...g.texto.matchAll(/\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*(['"])\+?>{1,2}\s*([^'"\s]+)\1/g)].map((m) => m[2])
    .concat([...g.texto.matchAll(/\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*['"]\+?>{1,2}['"]\s*,\s*(['"])([^'"]+)\1/g)].map((m) => m[2]));
  return {
    rutas: [
      ...extractWriteTargets(forma, { keep: () => true }),
      ...armados.flatMap((a) => (a.literal ? [a.literal] : (a.literales || []))),
      ...perl,
    ],
    armadosSinSaber: armados.some((a) => !a.literal && !a.literales && (!a.ext || a.ext === '.md')),
  };
}

/**
 * El primer argumento de la llamada que abre en `desde` (el carácter después del paréntesis), respetando comillas y
 * paréntesis anidados: `{ arg, fin }` con `fin` en la coma o el paréntesis que lo cierra. Se busca hasta 4 KB: un guion
 * con miles de llamadas sin cerrar no hace recorrer el texto entero por cada una.
 */
function primerArgumento(texto, desde) {
  let nivel = 0;
  let q = null;
  const hasta = Math.min(texto.length, desde + 4096);
  for (let i = desde; i < hasta; i++) {
    const c = texto[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(' || c === '[' || c === '{') nivel++;
    else if (c === ')' || c === ']' || c === '}') { if (nivel === 0) return { arg: texto.slice(desde, i).trim(), fin: i }; nivel--; } else if (c === ',' && nivel === 0) return { arg: texto.slice(desde, i).trim(), fin: i };
  }
  return { arg: texto.slice(desde, hasta).trim(), fin: hasta };
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
/**
 * Cuántas veces se le asigna algo a `nombre` en un script, por cualquier forma que se lea: `nombre = …` (también entre
 * paréntesis o como argumento con nombre: contar de más sólo deja el destino sin resolver), una asignación compuesta
 * (`nombre += …`, `nombre ||= …`, `nombre := …`), un desempaquetado (`a, nombre = …`, `[a, nombre] = …`, `{ nombre } = …`)
 * y la variable de un bucle (`for nombre in …`, `for (const nombre of …)`).
 */
function vecesAsignado(script, nombre) {
  const s = String(script || '');
  const n = String(nombre).replace(/\$/g, '\\$');
  let veces = (s.match(new RegExp(`(?<![\\w$.])${n}[ \\t]*=(?!=)`, 'gm')) || []).length;
  veces += (s.match(new RegExp(`(?<![\\w$.])${n}[ \\t]*(?:\\*\\*|\\/\\/|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^:])=(?!=)`, 'gm')) || []).length;
  // con anotación de tipo: `nombre: str = …` · `let nombre: string = …`
  veces += (s.match(new RegExp(`(?<![\\w$.])${n}[ \\t]*:[^=\\n;:]+=(?!=)`, 'gm')) || []).length;
  // al principio de una sentencia, con o sin corchetes; después de un paréntesis, sólo con corchetes o llaves (sin ellos
  // es una llamada: `open(p, encoding=…)`)
  for (const m of s.matchAll(/(?:(?:^|[;\n])[ \t]*(?:const[ \t]+|let[ \t]+|var[ \t]+)?([[{])?|\([ \t]*([[{]))([\w$ \t]+(?:,[\w$ \t]*)*)[\]}]?[ \t]*=(?!=)/g)) {
    m[1] = m[1] || m[2];
    m[2] = m[3];
    const nombres = m[2].split(',').map((x) => x.trim()).filter(Boolean);
    // sin corchetes, el último nombre ya contó como `nombre = …`; entre corchetes o llaves, ninguno
    const cuentan = m[1] ? nombres : nombres.slice(0, -1);
    if (cuentan.includes(nombre)) veces++;
  }
  veces += (s.match(new RegExp(`\\bfor[ \\t]*\\(?[ \\t]*(?:const[ \\t]+|let[ \\t]+|var[ \\t]+)?${n}[ \\t]+(?:in|of)\\b`, 'g')) || []).length;
  return veces;
}

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
    // cuántas veces se le asigna algo al nombre en el script. Con una, su lado derecho; con varias `nombre = …`, todas:
    // si cada una sale de literales, se juzgan todas las rutas (un script que edita dos archivos con la misma variable);
    // un desempaquetado o un bucle entre ellas no se sabe
    const asignaciones = vecesAsignado(script, expr);
    const simples = [...script.matchAll(new RegExp(`(?<![\\w$.])(?<![,(][ \\t]*)${nombre}[ \\t]*=(?!=)[ \\t]*([^;\\n]+)`, 'gm'))].map((x) => x[1].trim());
    if (asignaciones === 1 && simples.length === 1 && desdeArgv(simples[0])) return { literal: desdeArgv(simples[0]) };
    if (simples.length && simples.length === asignaciones) {
      // el lado derecho entero tiene que salir de literales: `p = 'src/' + n` no se sabe
      const todas = simples.map((der) => literalesDe(der));
      if (todas.every(Boolean)) return { literales: [...new Set(todas.flat())] };
    }
    // el primer parámetro de una función auxiliar (`function edit(p, pares)`, `def rep(p, pares):`): si cada llamada
    // le pasa una ruta literal, ésas son las rutas (y nada le asigna otra cosa)
    const fn = asignaciones === 0 && new RegExp(`(?:function|def)\\s+([A-Za-z_]\\w*)\\s*\\(\\s*${nombre}\\s*[,)]`).exec(script);
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
    // un bucle sobre una lista de rutas literales: `for p in ['a.yaml', 'b.md']` · `for (const p of ['a', 'b'])` (y el
    // bucle es la única asignación del nombre)
    const bucle = asignaciones === 1 && new RegExp(`for\\s*\\(?\\s*(?:const\\s+|let\\s+|var\\s+)?${nombre}\\s+(?:in|of)\\s+(\\[[^\\]]*\\])`).exec(script);
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
      if (k >= 0 && asignaciones === 1 && argv[desde + k - 1] != null) return { literal: argv[desde + k - 1] };
    }
    // por índice: `B, OUTF = sys.argv[1], sys.argv[2]` · `const f = process.argv[2]` (un nombre por índice, en orden).
    // Sólo si es la única asignación de ese nombre en el script: reasignado después, el destino ya no es el argumento
    const porIndice = /(?:^|[;\n]|\b(?:const|let|var)\s)[ \t]*([\w, \t]+?)[ \t]*=[ \t]*((?:(?:sys\.argv|process\.argv)\[\d+\][ \t]*(?:,[ \t]*)?)+)(?=$|[;\n])/gm;
    for (const d of script.matchAll(porIndice)) {
      const nombres = d[1].split(',').map((x) => x.trim()).filter(Boolean);
      const indices = [...d[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
      const k = nombres.indexOf(expr);
      if (k >= 0 && asignaciones === 1 && indices[k] != null && argv[indices[k] - 1] != null) return { literal: argv[indices[k] - 1] };
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
 * `[{ expr, literal?, ext?, cola? }]` (ver leerArmado). `guiones` son los del comando, o los de un archivo ya leído.
 */
function destinosArmados(cmd, guiones = scriptsInline(cmd)) {
  const vistos = new Map();
  for (const { script, argv } of guiones) {
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
    // lo que reemplaza, mueve o copia sobre el destino, su segundo argumento: `os.replace(tmp, <destino>)`,
    // `shutil.move`, `fs.renameSync`, `fs.copyFileSync`
    for (const m of script.matchAll(/\b(?:os\.(?:replace|rename)|shutil\.(?:move|copy|copy2|copyfile)|renameSync|rename|copyFileSync|copyFile)\s*\(/g)) {
      const a = primerArgumento(script, m.index + m[0].length);
      if (script[a.fin] === ',') add(primerArgumento(script, a.fin + 1).arg);
    }
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
  const s = String(cmd || '').replace(/((?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*)(?<!\$\(\([^\n]*)(?<!<)<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\2(?=[\s;&|()<>]|$)[^\n]*\n)[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
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
 * <ruta>`, `git restore <ruta>`): `[{ raw, kind: 'delete'|'restore', base?, quizas?, git? }]`. `base` es la carpeta de un
 * `git -C`. `quizas`: un `git checkout <nombre>` sin `--`, que es una ruta si existe y si no una rama. `git`: lo borra un
 * `git rm`, que deja el borrado en el índice. Lo que sólo toca el
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
      for (const w of resto) if (!w.startsWith('-')) con(w, 'delete', { git: true });
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

// ── los marcadores de la ejecución: se cierran con marker.js, no se borran ni se mueven a mano ─────────────────────────

// las formas de borrar o mover: un comando (también dentro de `bash -c`), una opción (`find -delete`, `rsync --delete`),
// un subcomando de git o la llamada de un guion. Sin ninguna, el comando no se lee de nuevo (es lo de cada comando)
// Los alias cortos de Windows (`del`, `erase`, `rd`, `ren`, `mi`, `ri`) son también palabras de un texto («la deuda del
// cliente»): cuentan sólo donde empieza un comando. Un `find -exec` con un programa que sólo lee no borra
const LECTORES_DE_FIND = String.raw`(?:wc|cat|head|tail|grep|egrep|fgrep|rg|ls|stat|file|echo|printf|du|basename|dirname|readlink|realpath|shasum|sha1sum|sha256sum|md5|md5sum|cksum|jq|diff|cmp|test)(?=[\s;'"]|$)`;
const BORRA_O_MUEVE = new RegExp([
  // el comando con su ruta (`/bin/rm`) o con la barra que saltea un alias (`\rm`) es el mismo comando
  String.raw`(?:^|[\s;&|(` + '`' + String.raw`'"])(?:[^\s;&|()'"` + '`' + String.raw`]*[\\/])?\\?(?:rm|rmdir|unlink|mv|move|remove-item|move-item|rename-item|shred|trash|truncate)(?:\.exe)?(?=[\s;&|)` + '`' + String.raw`'"]|$)`,
  String.raw`(?:^|[;&|(` + '`' + String.raw`'"\n]|\bcmd(?:\.exe)?\s+/[ck])\s*(?:[^\s;&|()'"` + '`' + String.raw`]*[\\/])?\\?(?:del|erase|rd|ren|mi|ri)(?:\.exe)?(?=[\s;&|)` + '`' + String.raw`'"]|$)`,
  String.raw`(?:^|\s)--?delete\b`,
  String.raw`(?:^|\s)-exec(?:dir)?\s+(?!` + LECTORES_DE_FIND + ')',
  String.raw`\bgit\b[^\n;&|]*\s(?:rm|clean|checkout|restore|mv)\b`,
  String.raw`\b(?:unlinkSync|unlink|rmSync|rm|rmdirSync|rmdir|renameSync|rename|rmtree|removedirs|remove|replace|move|delete|rm_rf|rm_r|remove_dir|remove_entry(?:_secure)?)\s*\(`,
  String.raw`\bunlink\b`,
].join('|'), 'i');

/** `a{b,c}d` → `abd`, `acd` (sin anidar; hasta 32 resultados). */
function expandirLlaves(w) {
  let out = [w];
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    const sig = [];
    let cambio = false;
    for (const x of out) {
      const m = /\{([^{}]*,[^{}]*)\}/.exec(x);
      if (!m) { sig.push(x); continue; }
      cambio = true;
      for (const alt of m[1].split(',')) sig.push(x.slice(0, m.index) + alt + x.slice(m.index + m[0].length));
    }
    out = sig.slice(0, 32);
    if (!cambio) break;
  }
  return out;
}

// las opciones cuyo valor es un texto para leer: el título, la descripción o el cuerpo de un pedido, un mensaje
const OPCIONES_DE_TEXTO = new Set(['--title', '--description', '--body', '--comment', '--message', '-m', '--notes']);
// los programas cuyas opciones de texto son un mensaje (en otro programa, `-m` puede ser cualquier cosa)
const CON_MENSAJE = new Set(['git', 'gh', 'az', 'glab', 'hg', 'svn']);
// las opciones con las que un buscador ejecuta otro programa. git y ag aceptan la opción larga abreviada (`--open`) y
// la corta pegada a otras (`-iO`): cuenta cualquier comienzo de dos letras o más de uno de estos nombres
const OPCIONES_QUE_EJECUTAN = ['pre', 'pager', 'open-files-in-pager', 'hostname-bin'];
const BUSCADOR_EJECUTA = {
  test: (w) => {
    if (/^-[A-Za-z0-9]*O/.test(w)) return true;
    const nombre = /^--([^=]{2,})/.exec(w);
    return !!nombre && OPCIONES_QUE_EJECUTAN.some((o) => o.startsWith(nombre[1]) || nombre[1].startsWith(o));
  },
};
const BUSCADORES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
// la salida de un comando que la ejecuta otro: ahí lo citado puede terminar corriendo
const A_UN_SHELL = /\|&?\s*(?:(?:[^\s-]\S*\/)?(?:sudo|env|busybox|command|exec|nohup|nice|time)(?:\s+-\S+)*\s+)*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|xargs|eval|source|python\d*(?:\.\d+)?|node|perl|ruby|php|pwsh|powershell)\b/;

/**
 * Los textos con blancos de un tramo que se citan y no se ejecutan: el patrón y los argumentos de un buscador (`grep`,
 * `rg` sin `--pre`…) y el valor de una opción de texto (`--description`, `--body`, `-m`…). Un texto con `$(` o comillas
 * invertidas no se cita: el shell lo corre antes. Con la salida del comando entero yendo a un shell, nada se cita.
 */
function textosCitados(tramo, entero) {
  const out = new Set();
  if (A_UN_SHELL.test(String(entero || ''))) return out;
  const words = palabras(String(tramo).trim().replace(PREFIJO, '')).filter((w) => w !== '');
  const c = path.basename(words[0] || '').toLowerCase();
  const busca = (BUSCADORES.has(c) || (c === 'git' && words[1] === 'grep'))
    && !words.some((w) => BUSCADOR_EJECUTA.test(w));
  const mensaje = CON_MENSAJE.has(c);
  const citable = (w) => /\s/.test(w) && !/\$\(|`/.test(w);
  words.forEach((w, k) => {
    if (k > 0 && busca && citable(w)) out.add(w);
    if (mensaje && OPCIONES_DE_TEXTO.has(w) && words[k + 1] !== undefined && citable(words[k + 1])) out.add(words[k + 1]);
    const pegado = /^(--[a-z]+)=([\s\S]*)$/.exec(w);
    if (mensaje && pegado && OPCIONES_DE_TEXTO.has(pegado[1]) && citable(pegado[2])) out.add(pegado[2]);
  });
  return out;
}

/**
 * Las palabras del comando, también las de adentro de un texto que corre otro shell (`bash -c '…'`) y los textos de un
 * guion. Lo que sólo se cita (`textosCitados`) no es una palabra del comando.
 */
function palabrasProfundas(cmd) {
  const out = [];
  const ver = (texto, nivel) => {
    for (const tramo of tramos(texto)) {
      const citados = textosCitados(tramo, cmd);
      for (const w of palabras(tramo)) {
        if (!w || citados.has(w)) continue;
        out.push(w);
        if (nivel < 2 && /\s/.test(w)) ver(w, nivel + 1);
      }
    }
  };
  ver(cmd, 0);
  for (const { script } of scriptsInline(cmd)) {
    for (const m of script.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push(m[2]);
  }
  return out;
}

// `cd <carpeta> && ` al principio exacto del comando, con la carpeta escrita tal cual (sin comillas, sin opción y sin
// nada que el shell expanda o que corte el comando), seguido de UN `sed` que nombra sus archivos: ni tubería,
// ni `$(…)`, ni comillas invertidas, ni otro comando, ni redirección, ni salto de línea, ni llaves, `@` o `~` (nombres
// que el shell expande, `{a,b}.md`, `~+/a.md`). Sólo `sed`: un `perl -e` es un programa entero, que puede armar y
// escribir sus archivos desde adentro (`BEGIN{@ARGV=glob …}`). Cualquier otra forma no es ésta: un editor que toma sus
// archivos de una tubería (`ls | xargs sed -i`) o de `$(ls)` escribe en la carpeta del `cd`, y esa carpeta es lo único
// que la nombra.
const CD_INICIAL = /^cd ([^\s'"`$*?[\]{}()<>;&|\\-][^\s'"`$*?[\]{}()<>;&|\\]*) && sed [^\n|;&<>`${}@~]*$/;

/**
 * Las palabras que un editor en el lugar puede escribir: las de `palabrasProfundas`, sin las que tienen espacios. Con
 * la forma de `CD_INICIAL`, la carpeta del `cd` sale de la lista por su posición —la segunda palabra, después de `cd`—:
 * es la base desde la que se resuelven las demás, no algo que el editor escribe. La misma carpeta nombrada otra vez más
 * adelante sigue en la lista.
 */
function palabrasDelEditor(cmd) {
  const ws = palabrasProfundas(cmd).filter((w) => !/\s/.test(w));
  const m = CD_INICIAL.exec(String(cmd || ''));
  if (m && ws[0] === 'cd' && ws[1] === m[1]) ws.splice(1, 1);
  return ws;
}

/**
 * Los pedazos de un tramo donde puede empezar un comando: corta en `&`, `(`, `)` y en `{` o `}` sueltos, fuera de las
 * comillas. Un `$(…)` y unas comillas invertidas quedan enteros en su pedazo: son parte de una palabra.
 */
function piezasDeTramo(tramo) {
  const s = String(tramo);
  const out = [];
  let actual = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { actual += s.slice(i, i + 2); i++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const fin = c === '"' ? cierreDoble(s, i) : s.indexOf(c, i + 1);
      const hasta = fin < 0 ? s.length : fin + 1;
      actual += s.slice(i, hasta);
      i = hasta - 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      let prof = 0;
      let j = i + 1;
      for (; j < s.length; j++) { if (s[j] === '(') prof++; else if (s[j] === ')' && --prof === 0) break; }
      actual += s.slice(i, j + 1);
      i = j;
      continue;
    }
    const llaveSuelta = (c === '{' || c === '}') && /^$|\s$/.test(actual.slice(-1)) && /^$|\s/.test(s[i + 1] || '');
    if (c === '&' || c === '(' || c === ')' || llaveSuelta) { out.push(actual); actual = ''; continue; }
    actual += c;
  }
  out.push(actual);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** El índice de las comillas dobles que cierran las que abren en `i` (con sus escapes), o -1. */
function cierreDoble(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') return j;
  }
  return -1;
}

/**
 * La carpeta de un `cd`, leída de lo que sigue al `cd` como la lee el shell: `{ texto, valor, comodin }`. `valor` es la
 * carpeta sin comillas ni escapes y con sus variables, `'~'` si no hay carpeta, o null si el freno no la sabe resolver:
 * `$(…)`, comillas invertidas, `$'…'`, llaves, `~+`, `cd -` o una variable que no conoce. `comodin` dice si el shell la
 * expande (`*`, `?`, `[…]` fuera de las comillas).
 */
function carpetaDeCd(cmd, resto) {
  let s = String(resto).replace(/^\s+/, '');
  // las opciones del cd (`-P`, `-L`, `-e`, `-@`) y el `--` que las cierra
  for (let m; (m = /^(-[A-Za-z@]+|--)(?=\s|$)\s*/.exec(s));) { s = s.slice(m[0].length); if (m[1] === '--') break; }
  let texto = '';
  let valor = '';
  let dinamico = false;
  let desconocido = false;
  let comodin = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/[\s<>]/.test(c)) break;
    if (c === '\\') { texto += s.slice(i, i + 2); valor += s[i + 1] || ''; i++; continue; }
    if (c === "'") {
      const fin = s.indexOf("'", i + 1);
      const hasta = fin < 0 ? s.length : fin;
      if (s[i - 1] === '$') desconocido = true;
      texto += s.slice(i, hasta + 1);
      valor += s.slice(i + 1, hasta);
      i = hasta;
      continue;
    }
    if (c === '"') {
      const fin = cierreDoble(s, i);
      const hasta = fin < 0 ? s.length : fin;
      const dentro = s.slice(i + 1, hasta);
      if (/\$\(|`/.test(dentro)) desconocido = true;
      if (/\$/.test(dentro)) dinamico = true;
      texto += s.slice(i, hasta + 1);
      valor += dentro.replace(/\\(["\\$`])/g, '$1');
      i = hasta;
      continue;
    }
    if (c === '`' || (c === '$' && s[i + 1] === '(') || c === '{' || c === '}') desconocido = true;
    if (c === '$') dinamico = true;
    if (/[*?[]/.test(c)) comodin = true;
    texto += c;
    valor += c;
  }
  if (!texto) return { texto, valor: '~', comodin: false };
  // `~+`, `~-` y `~otro` (la carpeta de otro usuario) no se resuelven acá
  if (desconocido || texto === '-' || /^~[^/]/.test(texto)) return { texto, valor: null, comodin };
  // con `CDPATH` (en el ambiente o en el comando) un `cd` relativo puede caer en cualquiera de sus carpetas
  const relativo = !/^(?:\/|\.{1,2}(?:\/|$)|~|\$)/.test(valor);
  if (relativo && (process.env.CDPATH || /(?:^|[\s;&|(])(?:export\s+)?CDPATH(?==)/.test(String(cmd)))) return { texto, valor: null, comodin };
  if (dinamico) {
    const ex = expandirRuta(cmd, valor);
    if (ex.sinResolver.length) return { texto, valor: null, comodin };
    valor = ex.valor;
  }
  return { texto, valor, comodin };
}

/**
 * Los `.md` de la carpeta de un `cd`, a cualquier profundidad, sin las carpetas de `NEVER_CODE_SEGMENTS` ni `.git`:
 * `{ mds, incompleta }`. `incompleta` dice por qué la recorrida no llegó a todo (más de 500 `.md`, más de 2000
 * carpetas, una carpeta que no se pudo leer), o es '' si la recorrió entera.
 */
function recorrerCarpetaDeCd(dir) {
  const mds = [];
  const pendientes = [dir];
  const vistas = new Set();
  try { vistas.add(fs.realpathSync(dir)); } catch { vistas.add(dir); }
  let carpetas = 0;
  while (pendientes.length) {
    const d = pendientes.pop();
    if (++carpetas > 2000) return { mds, incompleta: 'más de 2000 carpetas: no la recorro entera' };
    let entradas = [];
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { logHookError(e); return { mds, incompleta: `no pude leer ${d}` }; }
    for (const e of entradas) {
      // un enlace simbólico se sigue: cuenta lo que nombra (una vez cada carpeta real, por si el enlace da la vuelta)
      let esDir = e.isDirectory();
      let esArchivo = e.isFile();
      if (e.isSymbolicLink()) {
        try { const st = fs.statSync(path.join(d, e.name)); esDir = st.isDirectory(); esArchivo = st.isFile(); } catch { /* roto */ }
      }
      if (esDir && !NEVER_CODE_SEGMENTS.has(e.name) && e.name !== '.git') {
        let real = path.join(d, e.name);
        try { real = fs.realpathSync(real); } catch { /* queda la ruta */ }
        if (!vistas.has(real)) { vistas.add(real); pendientes.push(path.join(d, e.name)); }
      } else if (esArchivo && /\.md$/i.test(e.name)) {
        if (mds.length >= 500) return { mds, incompleta: 'más de 500 .md: no la recorro entera' };
        mds.push(path.join(d, e.name));
      }
    }
  }
  return { mds, incompleta: '' };
}

/**
 * Las carpetas de los `cd` del comando, en orden: los que empiezan un comando en un tramo (`cd x`, `(cd x`, `x & cd y`,
 * `then cd x`, `command cd x`, `\cd x`, `pushd x`), sin los cuerpos de los heredocs ni el texto entre comillas, y los
 * de adentro de un `$(…)`, de unas comillas invertidas o de un `bash -c '…'`. Cada una con `carpetaDeCd`, y las
 * variables leídas con el comando hasta ese tramo.
 */
function carpetasDeLosCd(cmd, nivel = 0) {
  const raw = String(cmd || '');
  const out = [];
  let desde = 0;
  for (const tramo of tramos(raw)) {
    const en = raw.indexOf(tramo, desde);
    const hasta = en < 0 ? raw.length : en + tramo.length;
    if (en >= 0) desde = hasta;
    for (const pieza of piezasDeTramo(tramo)) {
      const m = /^(?:(?:if|elif|while|until|then|do|else|time|!|command|builtin)\s+)*\\?(cd|pushd)(?:\s+([\s\S]*))?$/.exec(pieza);
      if (!m) continue;
      // `pushd` sin carpeta, o con `+N`/`-N`, va a una carpeta de su pila, que el freno no conoce
      const resto = m[2] || '';
      if (m[1] === 'pushd' && (!resto.trim() || /^\s*[+-]\d+(?:\s|$)/.test(resto))) out.push({ texto: `pushd ${resto.trim()}`.trim(), valor: null, comodin: false });
      else out.push(carpetaDeCd(raw.slice(0, hasta), resto));
    }
  }
  // lo que corre adentro: el cuerpo de un `$(…)` o de unas comillas invertidas, el guion de un shell con `-c` en
  // cualquier lugar (`xargs sh -c '…'`, `bash --norc -o pipefail -c "…"`, `fish -c`) y lo que corre `eval`. Más hondo
  // que tres niveles no se lee: frena
  const adentro = guionesInternos(raw);
  if (adentro.length && nivel >= 3) return [...out, { texto: '(un comando anidado de más)', valor: null, comodin: false }];
  for (const g of adentro) out.push(...carpetasDeLosCd(g, nivel + 1));
  return out;
}

/**
 * Lo que corre adentro de un comando, un nivel: el cuerpo de cada `$(…)` (con sus paréntesis balanceados) y de cada
 * par de comillas invertidas, fuera de las comillas simples; el guion de un shell con `-c` (con cualquier opción
 * antes); y lo que corre `eval`.
 */
function guionesInternos(cmd) {
  const s = String(cmd || '');
  const out = [];
  // las comillas en las que está cada carácter: entre simples no corre nada; entre dobles, `$(…)` y `…` sí
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '"') { q = q ? null : '"'; continue; }
    if (c === "'" && !q) { q = "'"; continue; }
    if (c === '$' && s[i + 1] === '(') {
      let prof = 0;
      let j = i + 1;
      for (; j < s.length; j++) { if (s[j] === '(') prof++; else if (s[j] === ')' && --prof === 0) break; }
      out.push(s.slice(i + 2, j));
      i = j;
    } else if (c === '`') {
      const fin = s.indexOf('`', i + 1);
      out.push(s.slice(i + 1, fin < 0 ? s.length : fin));
      i = fin < 0 ? s.length : fin;
    }
  }
  const conC = /(?:^|[\s;&|(`])(?:\S*\/)?(?:ba|z|k|da|fi|c|tc)?sh\b(?:\s+(?:--?[A-Za-z][\w-]*|[+-][oO]\s+[^\s+-]\S*))*?\s+-[A-Za-z]*c\s+(?=['"])/g;
  for (const m of s.matchAll(conC)) {
    const i = m.index + m[0].length;
    const fin = s[i] === '"' ? cierreDoble(s, i) : s.indexOf("'", i + 1);
    const cuerpo = s.slice(i + 1, fin < 0 ? s.length : fin);
    out.push(s[i] === '"' ? cuerpo.replace(/\\(["\\$`])/g, '$1') : cuerpo);
  }
  // `eval` corre sus palabras juntas, hasta el primer `;`, `&`, `|` o salto de línea fuera de las comillas
  for (const m of s.matchAll(/(?:^|[\s;&|(`])eval\s+/g)) {
    let j = m.index + m[0].length;
    for (let qq = null; j < s.length; j++) {
      const c = s[j];
      if (qq) { if (c === qq) qq = null; else if (c === '\\' && qq === '"') j++; continue; }
      if (c === '\\') { j++; continue; }
      if (c === "'" || c === '"') { qq = c; continue; }
      if (/[;&|\n]/.test(c)) break;
    }
    out.push(palabras(s.slice(m.index + m[0].length, j)).join(' '));
  }
  return out;
}

/** Lo que borra cada tramo, también los de adentro de `bash -c '…'`, y lo que recorre un `find` que borra. */
function borradosProfundos(cmd) {
  const out = [];
  const ver = (texto, nivel) => {
    for (const d of destinosBorrados(texto)) out.push(d);
    for (const raw of origenesMovidos(texto)) out.push({ raw });
    for (const tramo of tramos(texto)) {
      const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
      const lee = new RegExp(`^${LECTORES_DE_FIND}`);
      const borraEnFind = words.some((w, k) => w === '-delete' || (/^-exec(?:dir)?$/.test(w) && !lee.test(words[k + 1] || '')));
      if (path.basename(words[0] || '').toLowerCase() === 'find' && borraEnFind) {
        for (const w of words.slice(1)) { if (w.startsWith('-') || w === '!' || w === '(') break; out.push({ raw: w }); }
      }
      const citados = textosCitados(tramo, cmd);
      if (nivel < 2) for (const w of palabras(tramo)) if (/\s/.test(w) && !citados.has(w)) ver(w, nivel + 1);
    }
  };
  ver(cmd, 0);
  return out;
}

/** Los orígenes de un `mv` o un `Move-Item` (y sus alias): lo que deja de estar donde estaba. */
function origenesMovidos(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
    if (!words.length) continue;
    const c = nombreDeComando(words[0]);
    if (!['mv', 'move', 'mi', 'move-item', 'rename-item', 'ren'].includes(c)) continue;
    const args = [];
    for (let i = 1; i < words.length; i++) {
      if (/^-(?:destination|t|target-directory|newname)$/i.test(words[i])) { i++; continue; }
      if (/^-(?:path|literalpath)$/i.test(words[i])) { if (words[i + 1]) args.push(words[++i]); continue; }
      if (words[i].startsWith('-')) continue;
      args.push(words[i]);
    }
    // el último es el destino (salvo con -t, que ya se salteó)
    out.push(...(/(?:^|\s)-(?:t|-target-directory)\b/.test(tramo) ? args : args.slice(0, -1)));
  }
  return out;
}

/**
 * Los marcadores de la ejecución (`<estado>/active/`, `<estado>/active.json`) que el comando puede borrar o mover:
 * `[ruta o texto]`. La regla: un comando que borra o mueve algo y nombra un marcador frena. Nombrarlo es una palabra
 * que, expandida (variables, `~`, llaves), cae en uno o en su carpeta, o un texto que lo nombra por la carpeta del estado
 * (`'/.claude/.tycon-pipeline/active/x.json'` armado en un guion). Una carpeta de arriba (`rm -rf ~/.claude`) cuenta
 * sólo si es lo que el comando borra o recorre.
 */
function marcadoresTocados(cmd, cwd, stateDir) {
  if (!BORRA_O_MUEVE.test(String(cmd || ''))) return [];
  // un `git checkout|restore|rm` dice sus rutas (destinosBorrados las lee una por una): si es lo único que borra, el
  // nombre de la carpeta del estado suelto en otro lado del comando (`gh … --json state`) no es lo que borra
  const sinGitLeido = String(cmd).replace(/\bgit\b[^\n;&|$`<>]*\s(?:checkout|restore|rm)\b[^\n;&|$`<>]*/gi, ' ');
  const porTexto = BORRA_O_MUEVE.test(sinGitLeido);
  const { isInside } = require('./lib/atdd-preedit.js');
  const installedTree = require('./lib/installed-tree.js');
  const bases = [...new Set([stateDir, installedTree.realPath(stateDir)].filter(Boolean))];
  const comodin = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  const alcanza = (seg) => expandirLlaves(seg).some((s) => s === 'active' || s === 'active.json'
    || (/[*?[]/.test(s) && (comodin(s).test('active') || comodin(s).test('active.json'))));
  // la ruta cae en un marcador (o en su carpeta); `arriba`: también una carpeta que los contiene
  // el registro de aperturas (`gates.log`) y la copia de una apertura (`.advisors/pipeline-runs/<carpeta>/run-open.json`):
  // las otras dos piezas de una ejecución abierta (lib/open-runs.js)
  const esPiezaDeEjecucion = (r) => bases.some((b) => r === path.join(b, 'gates.log'))
    || (path.basename(r) === 'run-open.json' && path.basename(path.dirname(path.dirname(r))) === 'pipeline-runs');
  const toca = (abs, arriba) => {
    const reales = [...new Set([abs, installedTree.realPath(abs)].filter(Boolean))];
    if (reales.some(esPiezaDeEjecucion)) return true;
    return bases.some((b) => {
      const activos = path.join(b, 'active');
      return reales.some((r) => {
        if (r === activos || r === path.join(b, 'active.json') || isInside(activos, r)) return true;
        if (arriba && isInside(r, activos)) return true;
        const dir = path.dirname(r);
        if (!/[*?[]/.test(path.basename(r))) return false;
        // un comodín: en active/, o al lado de active y active.json, o (si es lo borrado) en una carpeta de arriba
        if (dir === activos || isInside(activos, dir)) return true;
        if (dir === b) return alcanza(path.basename(r));
        return arriba && isInside(dir, activos) && comodin(path.basename(r)).test(path.relative(dir, activos).split(path.sep)[0]);
      });
    });
  };
  const resolver = (raw, base) => {
    const desde = base ? resolveTarget(expandirRuta(cmd, base).valor, cwd, process.platform, { homeVariable: true }) : cwd;
    return resolveTarget(expandirRuta(cmd, raw).valor, desde, process.platform, { homeVariable: true });
  };
  // el nombre de la carpeta del estado en un texto, seguido de nada o de algo que alcanza a un marcador
  const nombre = path.basename(stateDir);
  const nombraPorTexto = (t) => {
    for (let i = t.indexOf(nombre); i >= 0; i = t.indexOf(nombre, i + 1)) {
      if (/[\w.-]/.test(t[i - 1] || '')) continue;
      const resto = t.slice(i + nombre.length);
      if (!resto || /^[\s'"`)]/.test(resto)) return true;
      if (!/^[\\/]/.test(resto)) continue;
      const seg = resto.replace(/^[\\/]+/, '').split(/[\\/\s'"`)]/)[0];
      if (!seg || alcanza(seg)) return true;
    }
    return false;
  };
  const out = [];
  for (const w of palabrasProfundas(cmd)) {
    if (porTexto && nombraPorTexto(w)) { out.push(w); continue; }
    if (/\s/.test(w)) continue;
    for (const x of expandirLlaves(w)) {
      const abs = resolver(x);
      if (toca(abs, false)) { out.push(abs); continue; }
      // un comodín en una carpeta del medio (`~/.claude/.tycon-p*/active`): lo que nombra en el disco
      if (/[*?[]/.test(path.dirname(abs))) for (const r of expandirComodin(abs, cwd)) if (toca(r, false)) out.push(r);
    }
  }
  for (const d of borradosProfundos(cmd)) {
    for (const x of expandirLlaves(d.raw)) { const abs = resolver(x, d.base); if (toca(abs, true)) out.push(abs); }
  }
  return [...new Set(out)];
}

// ── una historia no se escribe por consola ────────────────────────────────────────────────────────────────────────────

/**
 * ¿Algún tramo edita en el lugar los archivos que nombra? `sed`/`perl`/`ruby` con una opción que lleva `i` (`-i`,
 * `-ibak`, `-0pi`, `--in-place`), `awk -i inplace`, `ed` o `ex`. Se lee por palabras con sus comillas (un `;` o un `|`
 * dentro del guion de `sed` no corta) y también detrás de `xargs`, `find -exec` y adentro de `bash -c '…'`.
 */
function editaEnSitio(cmd) {
  const opcionI = (w) => /^-[A-Za-z0-9]*i/.test(w) || /^--in-place\b/.test(w);
  const ver = (texto, nivel) => {
    for (const tramo of tramos(texto)) {
      const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
      for (let k = 0; k < words.length; k++) {
        const c = path.basename(words[k]).toLowerCase().replace(/\.exe$/, '');
        const resto = words.slice(k + 1);
        if (['sed', 'gsed', 'perl', 'ruby'].includes(c) && resto.some(opcionI)) return true;
        if (['awk', 'gawk'].includes(c) && resto.some((w, j) => w === '-iinplace' || (w === '-i' && resto[j + 1] === 'inplace'))) return true;
        if (k === 0 && (c === 'ed' || c === 'ex')) return true;
      }
      const citados = textosCitados(tramo, cmd);
      if (nivel < 2) for (const w of words) if (/\s/.test(w) && !citados.has(w) && ver(w, nivel + 1)) return true;
    }
    return false;
  };
  return ver(String(cmd || ''), 0);
}

/**
 * ¿El guion de `sed` sólo cambia el texto que lee? Sin `r`, `R`, `w`, `W`, `e` ni `F` (leen, escriben o corren algo
 * aparte) y sin los indicadores `w` o `e` de un `s`. Lo que no se sabe leer cuenta como que no.
 */
function guionDeSedSinEfectos(guion) {
  const s = String(guion);
  let i = 0;
  // hasta el delimitador sin escapar (`\/` no corta); -1 si no cierra
  const hasta = (d, j) => { for (; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === d) return j; } return -1; };
  const direccion = () => {
    if (/\d/.test(s[i] || '')) { while (/[\d~]/.test(s[i] || '')) i++; return true; }
    if (s[i] === '$') { i++; return true; }
    if (s[i] === '/' || s[i] === '\\') {
      const d = s[i] === '\\' ? s[++i] : '/';
      const fin = hasta(d, i + 1);
      if (fin < 0) return false;
      i = fin + 1;
      while (/[IM]/.test(s[i] || '')) i++;
    }
    return true;
  };
  while (i < s.length) {
    while (/[\s;{}]/.test(s[i] || '')) i++;
    if (i >= s.length) break;
    if (!direccion()) return false;
    if (s[i] === ',') { i++; if (!direccion()) return false; }
    while (/[\s!]/.test(s[i] || '')) i++;
    const c = s[i++];
    if (c === undefined) return false;
    if (c === '}' || c === '{') continue;
    if (c === 's' || c === 'y') {
      const d = s[i];
      if (!d || /[\s\\\n]/.test(d)) return false;
      const medio = hasta(d, i + 1);
      const fin = medio < 0 ? -1 : hasta(d, medio + 1);
      if (fin < 0) return false;
      i = fin + 1;
      const flags = /^[gGiIpmM\d]*/.exec(s.slice(i))[0];
      i += flags.length;
      if (!/^(?:$|[\s;}])/.test(s.slice(i))) return false;
      continue;
    }
    if ('dDpPnNgGhHxlz='.includes(c)) continue;
    if (c === 'q' || c === 'Q') { while (/\d/.test(s[i] || '')) i++; continue; }
    // el texto de `a`, `i` y `c`, y la etiqueta de `b`, `t`, `T` y `:`, llegan hasta el fin de la línea o del guion
    if ('aic'.includes(c)) { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl + 1; continue; }
    if ('btT:'.includes(c)) { while (i < s.length && !/[;\n]/.test(s[i])) i++; continue; }
    return false;
  }
  return true;
}

/**
 * Los `sed` en el lugar de un comando cuando todos nombran sus archivos tal cual: `[{ sed, opciones, guiones, archivo }]`,
 * con el archivo como palabra (una variable del comando ya resuelta). null si algún editor en el lugar no es así: un
 * `perl`/`ruby`/`awk`/`ed`, un `sed` detrás de `xargs`, `find -exec`, un `for` o adentro de `bash -c`, un archivo con
 * comodín, llaves, `~+`, `$(…)` o una variable que no se resuelve, un guion que lee, escribe o corre algo aparte, o
 * una opción que no se conoce. Con esa forma, lo que el editor escribe es sólo lo que nombra.
 */
function sedsLiterales(cmd) {
  if (FOR_IN.test(String(cmd || ''))) return null;
  const opcionI = (w) => /^-[A-Za-z0-9]*i/.test(w) || /^--in-place\b/.test(w);
  const bsd = process.platform === 'darwin';
  const out = [];
  for (const tramo of tramos(cmd)) {
    // un `$(…)`, comillas invertidas o un subshell (`(cd x && sed -i … a.sh)`): el paréntesis queda pegado a la ruta y
    // el carril de código no la reconoce, así que no es la forma
    const sinComillas = tramo.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
    if (/\$\(|`|[()]/.test(sinComillas)) { if (editaEnSitio(tramo)) return null; continue; }
    const sinRedir = tramo.trim().replace(PREFIJO, '').replace(/[ \t]*(?:&|\d)?>{1,2}(?:\||&)?[ \t]*(?:'[^']*'|"[^"]*"|[^\s'"|;&<>]+)?/g, ' ');
    const words = palabras(sinRedir);
    const k = words.findIndex((w, j) => {
      const c = path.basename(w).toLowerCase().replace(/\.exe$/, '');
      const resto = words.slice(j + 1);
      return (['sed', 'gsed', 'perl', 'ruby'].includes(c) && resto.some(opcionI))
        || (['awk', 'gawk'].includes(c) && resto.some((x, n) => x === '-iinplace' || (x === '-i' && resto[n + 1] === 'inplace')))
        || (j === 0 && (c === 'ed' || c === 'ex'));
    });
    if (k < 0) { if (words.some((w) => /\s/.test(w) && editaEnSitio(w))) return null; continue; }
    if (k !== 0 || !['sed', 'gsed'].includes(path.basename(words[0]))) return null;
    const opciones = [];
    const guiones = [];
    const archivos = [];
    let enLugar = false;
    let finOpciones = false;
    for (let n = 1; n < words.length; n++) {
      const w = words[n];
      if (finOpciones || !w.startsWith('-') || w === '-') { archivos.push(w); continue; }
      if (w === '--') { finOpciones = true; continue; }
      if (w === '-e') { if (n + 1 >= words.length) return null; guiones.push(words[++n]); continue; }
      const m = /^-([Enrsuz]*)(i(.*))?$/.exec(w);
      if (m && (m[1] || m[2] !== undefined)) {
        if (m[1]) opciones.push(`-${m[1]}`);
        // `-i` suelto: en BSD la palabra que sigue es el sufijo de la copia (`-i ''`); en GNU no, y un `-i ''` es el
        // guion vacío seguido del de verdad tomado por archivo: no es la forma (cada sistema lo correría distinto)
        if (m[2] !== undefined) {
          enLugar = true;
          if (m[3] === '' && bsd) n++;
          else if (m[3] === '' && words[n + 1] === '') return null;
        }
        continue;
      }
      if (/^--in-place(?:=.*)?$/.test(w)) { enLugar = true; continue; }
      return null;
    }
    if (!enLugar) return null;
    if (!guiones.length) { if (!archivos.length) return null; guiones.push(archivos.shift()); }
    if (!archivos.length || !guiones.every(guionDeSedSinEfectos)) return null;
    for (const a of archivos) {
      if (!a || /[*?[\]{}]/.test(a) || /^~[+-]/.test(a) || a.includes('@')) return null;
      const ex = expandirRuta(cmd, a);
      if (ex.sinResolver.length || /[*?[\]{}]/.test(ex.valor)) return null;
      out.push({ sed: words[0], opciones, guiones, archivo: ex.valor });
    }
  }
  return out;
}

/**
 * Lo que un `sed` en el lugar dejaría en ese archivo, sin escribirlo: el mismo `sed` con sus guiones, leyendo el texto
 * por la entrada. null si no se pudo correr.
 */
function ensayarSeds(abs, seds) {
  let texto;
  try { texto = fs.readFileSync(abs, 'utf8'); } catch (e) { logHookError(e); return null; }
  for (const s of seds) {
    const r = require('child_process').spawnSync(s.sed, [...s.opciones, ...s.guiones.flatMap((g) => ['-e', g])],
      { input: texto, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] });
    if (r.error || r.status !== 0) return null;
    texto = r.stdout;
  }
  return texto;
}

/** Los `status:` del encabezado de una historia, en orden (vacío sin encabezado). */
function estadosDelEncabezado(texto) {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(String(texto));
  return fm ? [...fm[1].matchAll(/^["']?status["']?\s*:\s*["']?([\w-]+)/gm)].map((m) => m[1].toLowerCase()) : [];
}
// las llamadas de un guion que escriben, copian, mueven o borran un archivo
const GUION_ESCRIBE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rename|replace|unlinkSync|rmSync|truncateSync|write_text|write_bytes|copy|copyfile|copy2|copytree|move|remove|unlink|truncate)\s*\(|\bopen\s*\([^)]*,\s*["'][^"']*[wax+]|\bFile\.(?:write|delete|rename)\b|\bFileUtils\.\w+/;
// las formas de escribir, borrar, mover o reponer un archivo desde un comando: sin ninguna (ni un editor en el lugar), el
// comando no toca una historia
const ESCRIBE = new RegExp([
  String.raw`(?:^|[\s;&|(])(?:[^\s;&|()'"]*[\\/])?\\?(?:rm|del|erase|unlink|remove-item|ri|mv|move|mi|move-item|rename-item|ren|cp|copy|copy-item|install|rsync|ditto|scp|dd|truncate)(?:\.exe)?(?=\s)`,
  String.raw`\bgit\b[^\n;&|]*\s(?:checkout|restore|rm|mv)\b`,
  String.raw`\b(?:curl|wget)\b[^\n;&|]*\s(?:-o|-O|--output)`,
  String.raw`>{1,2}(?![&>])(?!\s*/dev/(?:null|stdout|stderr)\b)`,
  String.raw`\btee\b`,
  String.raw`\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|write_bytes)\b`,
  String.raw`\bopen\s*\(`,
  String.raw`\b(?:Set-Content|Out-File|Add-Content)\b|::(?:Write|Append)All`,
  GUION_ESCRIBE.source,
].join('|'), 'i');
// una palabra suelta del comando cuenta como destino con un editor en el lugar (`editaEnSitio`), o con un
// `for … in <comodín>` que escribe. En un `ls specs/*.md > lista.txt` el comodín sólo se lee
const FOR_IN = /(?:^|[\s;&|(])for\s+\w+\s+in\s/i;

/** El nombre de un comando: sin su ruta (`/bin/mv`), sin la barra que saltea un alias (`\mv`) y sin `.exe`. */
const nombreDeComando = (w) => path.basename(String(w || '').replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '');

/** Los orígenes de un `mv` (o `git mv`, `Move-Item`) cuyo destino no es un `.md`: la historia sale de la vista de los frenos. */
function movidosFueraDeMd(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    let words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '' && !w.startsWith('-'));
    if (nombreDeComando(words[0]) === 'git' && words[1] === 'mv') words = words.slice(1);
    const c = nombreDeComando(words[0]);
    if (!['mv', 'move', 'mi', 'move-item', 'rename-item', 'ren'].includes(c) || words.length < 3) continue;
    if (!/\.md$/i.test(words[words.length - 1])) out.push(...words.slice(1, -1));
  }
  return out;
}

/**
 * Las constancias de cambio de control que el comando pone por otro camino que el guion: lo que deja una copia, un
 * movimiento o un enlace (`cp`, `git mv`, `install`, `rsync`, `ditto`, `scp`, `ln`) en su destino (el último argumento o
 * el de `-t`), también adentro de lo que copia una carpeta entera; lo que se repone desde otra rama (`git checkout <ref>
 * -- x`, `git restore --source`); lo que entra directo al índice (`git update-index`); y un parche (`git apply`, `git am`,
 * `patch`) que las nombra. Un parche que no se puede leer antes de aplicarlo (por la entrada estándar, que no existe
 * todavía, ilegible) y una copia recursiva a un repo de algo que no se puede mirar (remota, que no existe) también
 * cuentan: lo que no se ve no pasa. Las escrituras comunes (`>`, `tee`, `node -e`) las ve `extractWriteTargets`.
 * Casos: scripts/controls-bench/cases/hooks/01-frenos-duros.json
 */
function constanciasTocadas(cmd, cwd, stateDir = null) {
  // las constancias firmadas: las de cambio de control, la del salteo del pase adversarial y el registro del arnés
  // (`gates.log`), que lleva el renglón de la firma del salteo
  const { signedRecordKind } = require('./lib/story-gate.js');
  const installedTree = require('./lib/installed-tree.js');
  const registros = stateDir ? [...new Set([stateDir, installedTree.realPath(stateDir)].filter(Boolean).map((d) => path.join(d, 'gates.log')))] : [];
  const esRegistro = (p) => {
    if (!registros.length || !path.isAbsolute(String(p))) return false;
    const a = path.resolve(String(p));
    return registros.includes(a) || registros.includes(installedTree.realPath(a));
  };
  const isControlApproval = (p) => signedRecordKind(p) !== null || esRegistro(p);
  // una carpeta donde vive una constancia del salteo: la del estado, o la de una ejecución (`pipeline-runs/<carpeta>`)
  const carpetaDeFirma = (d) => {
    const reales = [...new Set([path.resolve(String(d)), installedTree.realPath(path.resolve(String(d)))].filter(Boolean))];
    return reales.some((r) => registros.some((g) => r === path.dirname(g)) || path.basename(path.dirname(r)) === 'pipeline-runs');
  };
  let base = cwd;
  const abs = (raw) => resolveTarget(expandirRuta(cmd, raw).valor, base, process.platform, { homeVariable: true });
  const es = (raw) => isControlApproval(String(raw)) || isControlApproval(abs(raw));
  const esRuta = (p) => isControlApproval(p) || isControlApproval(`${p}/`);
  const out = [];
  const todos = comandosAnidados(cmd).flatMap((sub) => tramos(sub)).flatMap((t) => t.split(/(?<![&>|])&(?![&>])/));
  for (const tramo of todos) {
    base = cwd;
    // sin las redirecciones de lectura con su archivo (`< lista`): no son argumentos de la copia
    const limpio = sinPalabrasDelShell(tramo);
    // las redirecciones y el tee a una constancia, también adentro de `bash -c` (los tramos anidados están en `todos`)
    for (const m of limpio.matchAll(/(?<![<\d&])(?:\d?>>?|&>>?)\|?\s*(['"]?)([^\s<>;&|'"]+)\1/g)) if (es(m[2])) out.push(m[2]);
    const words = palabras(limpio.replace(/(?<![<\d])<(?!<)\s*[^\s<>;&|]+/g, ' ').trim().replace(PREFIJO, '')).filter((w) => w !== '' && w !== '\\');
    let c = nombreDeComando(words[0]);
    let args = words.slice(1);
    if (c === 'xargs') {
      // lo que corre xargs, sin sus opciones (las que llevan valor, con él)
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += /^-(?:[IinLPdEsa]|-(?:replace|max-args|max-lines|max-procs|delimiter|eof|max-chars|arg-file))$/.test(args[i]) ? 2 : 1;
      c = nombreDeComando(args[i]);
      args = args.slice(i + 1);
    }
    const lleva = (opciones) => {
      // las cortas, también juntas (`-qO <ruta>`) o con el valor pegado (`-O<ruta>`); leer de más no frena nada:
      // sólo cuenta lo que nombra un archivo de la firma
      const cortas = opciones.filter((o) => /^-[A-Za-z]$/.test(o)).map((o) => o[1]).join('');
      const r = [];
      for (let i = 0; i < args.length; i++) {
        if ((opciones.includes(args[i]) || (cortas && new RegExp(`^-[A-Za-z]*[${cortas}]$`).test(args[i]))) && args[i + 1]) { r.push(args[++i]); continue; }
        const pegado = opciones.map((o) => (o.startsWith('--') ? new RegExp(`^${o}=(.+)$`).exec(args[i]) : null)).find(Boolean)
          || (cortas ? new RegExp(`^-[A-Za-z]*[${cortas}](.+)$`).exec(args[i]) : null);
        if (pegado) r.push(pegado[1]);
      }
      return r;
    };
    if (c === 'tee') { out.push(...args.filter((w) => !w.startsWith('-')).filter(es)); continue; }
    if (c === 'sponge') { out.push(...args.filter((w) => !w.startsWith('-')).filter(es)); continue; }
    if (c === 'curl' || c === 'wget') { out.push(...lleva(['-o', '--output', '-O', '--output-document']).filter(es)); continue; }
    if (c === 'tar' || c === 'bsdtar' || c === 'unzip' || c === 'cpio') {
      // lo que trae un archivo comprimido no se ve antes de abrirlo: a la carpeta de una constancia, no pasa
      // `tar -xf`, `tar xzf` (el primer argumento sin guion) o `--extract`; `cpio -i` o `--extract`
      // listar (`unzip -l`, `unzip -Z1`, `unzip -t`, `cpio -it`) o mandar a la salida (`unzip -p`) no escribe
      const extrae = c === 'unzip' ? !args.some((w) => /^-[A-Za-z]*[lZtpv]/.test(w))
        : c === 'cpio' ? args.some((w) => /^-[A-Za-z]*i/.test(w) || w === '--extract') && !args.some((w) => /^-[A-Za-z]*t/.test(w) || w === '--list')
          : args.some((w, k) => /^-[A-Za-z]*x/.test(w) || (k === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(w)) || w === '--extract' || w === '--get');
      if (!extrae) continue;
      const dirs = lleva(c === 'unzip' ? ['-d'] : c === 'cpio' ? ['-D', '--directory'] : ['-C', '--directory']);
      const destinos = dirs.length ? dirs.map((d) => abs(d)) : [cwd];
      const enFirma = destinos.find(carpetaDeFirma);
      if (enFirma) { out.push(`${enFirma} (no se puede ver qué trae lo que se descomprime)`); continue; }
      // con los nombres cambiados al extraer (`tar -s`, `--transform`, `--strip-components`), lo que se lista no es lo
      // que queda escrito: dentro de un repo, no pasa
      if (c !== 'unzip' && c !== 'cpio' && args.some((w) => w === '-s' || /^--(?:transform|xform|strip-components)(?:=|$)/.test(w))) {
        if (destinos.some(dentroDeUnRepo)) out.push(`${tramo.trim()} (cambia los nombres al extraer: no se puede ver si trae una constancia)`);
        continue;
      }
      // a cualquier otra carpeta, lo que trae se mira antes: una constancia adentro, o un archivo que no se puede
      // listar (por la entrada estándar, que todavía no existe) dentro de un repo, no pasa
      const lista = contenidoDelArchivo(c, args, tramo, abs);
      if (lista === null) { if (destinos.some(dentroDeUnRepo)) out.push(`${tramo.trim()} (no se puede ver si trae una constancia)`); continue; }
      if (lista.some((e) => /control-changes/i.test(e) || destinos.some((d) => esRuta(path.join(d, e))))) out.push(`${tramo.trim()} (trae una constancia)`);
      continue;
    }
    // otros que extraen y que el freno no sabe listar: `pax -r`, `ditto -x`, `python3 -m zipfile|tarfile -e`. A la
    // carpeta de una constancia o dentro de un repo, no pasan
    const extractor = (c === 'pax' && args.some((w) => /^-[A-Za-z]*r/.test(w))) ? cwd
      : (c === 'ditto' && args.some((w) => /^-[A-Za-z]*x/.test(w))) ? abs(args.filter((w) => !w.startsWith('-')).pop() || '.')
        : (/^python[\d.]*$/.test(c) && args[0] === '-m' && /^(?:zipfile|tarfile)$/.test(args[1] || '') && args.some((w) => w === '-e' || w === '--extract'))
          ? abs(args[args.length - 1] && !args[args.length - 1].startsWith('-') && args.length > 4 ? args[args.length - 1] : '.') : null;
    if (extractor) {
      if (carpetaDeFirma(extractor) || dentroDeUnRepo(extractor)) out.push(`${tramo.trim()} (no se puede ver si trae una constancia)`);
      continue;
    }
    if (c === 'git') {
      // las opciones de git antes del subcomando, con su valor; `-C` cambia la carpeta de las rutas
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) {
        if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/.test(args[i])) {
          if (args[i] === '-C' && args[i + 1]) base = path.resolve(base, args[i + 1]);
          i += 2;
        } else i += 1;
      }
      c = `git ${args[i]}`;
      args = args.slice(i + 1);
    }
    const sueltos = args.filter((w) => !w.startsWith('-') && !w.startsWith('<'));
    if (['cp', 'mv', 'git mv', 'install', 'rsync', 'ditto', 'scp', 'ln'].includes(c)) {
      const copia = destinoDeLaCopia(args, ['cp', 'mv', 'install', 'ln'].includes(c));
      if (!copia) continue;
      if (es(copia.destino)) { out.push(copia.destino); continue; }
      // cp, install, scp y rsync sólo bajan a una carpeta con su opción
      const recursiva = !['cp', 'install', 'scp', 'rsync'].includes(c) || args.some((w) => /^-[A-Za-z]*[rRa][A-Za-z]*$/.test(w) || w === '--recursive' || w === '--archive');
      const destino = abs(copia.destino);
      let esCarpeta = copia.carpeta || /[\\/]$/.test(copia.destino);
      try { esCarpeta = esCarpeta || fs.statSync(destino).isDirectory(); } catch (_) { /* un destino nuevo es el nombre de la copia */ }
      for (const o of copia.origenes) {
        const adentro = /[\\/]\.?$/.test(o);
        const lugar = esCarpeta && !adentro ? path.join(destino, path.basename(o.replace(/[\\/]\.?$/, ''))) : destino;
        if (esRuta(lugar)) { out.push(o); break; }
        if (!recursiva) continue;
        // un enlace a una carpeta se sigue: la copia trae lo de adentro
        let st = null;
        try { st = fs.statSync(abs(o)); } catch (_) { /* remoto, o todavía no existe */ }
        if (!st) {
          if (dentroDeUnRepo(destino)) { out.push(`${o} (no se puede ver qué trae)`); break; }
          continue;
        }
        if (!st.isDirectory()) continue;
        const hallados = nombresDeConstancia(abs(o));
        if (hallados === null) {
          if (dentroDeUnRepo(destino)) { out.push(`${o} (no pude revisar todo lo que trae)`); break; }
          continue;
        }
        if (hallados.some((rel) => esRuta(path.join(lugar, rel)))) { out.push(o); break; }
      }
    } else if (c === 'git update-index' || (c === 'git checkout' && (args.indexOf('--') > 0 ? args.slice(0, args.indexOf('--')).some((w) => !w.startsWith('-')) : sueltos.length >= 2 || (sueltos.length === 1 && args.some((w) => /^--pathspec-from-file(?:=|$)/.test(w))))) || (c === 'git restore' && args.some((w) => /^(?:--source|-s)/.test(w)))) {
      out.push(...sueltos.flatMap((w) => w.split(',')).filter(es));
      // una carpeta repuesta desde otra rama (`git checkout otra -- .`) trae las constancias que esa rama tenga distintas:
      // se le pregunta a git cuáles cambiarían; si git no contesta, la carpeta que las puede contener no pasa
      const desdeRef = c === 'git checkout' ? (args.indexOf('--') > 0 ? args.slice(0, args.indexOf('--')).find((w) => !w.startsWith('-')) : sueltos[0])
        : c === 'git restore' ? lleva(['--source', '-s'])[0] : null;
      // una ref que empieza con guion sería una opción de `git diff` (`--output=<archivo>`): no se le pregunta a git
      if (desdeRef && desdeRef.startsWith('-')) out.push(`${tramo.trim()} (no pude ver qué constancias trae ${desdeRef})`);
      else if (desdeRef && args.some((w) => /^--pathspec-from-file(?:=|$)/.test(w))) out.push(`${tramo.trim()} (las rutas vienen de un archivo: no pude ver qué constancias trae ${desdeRef})`);
      else if (desdeRef) {
        const fuentes = c === 'git restore' ? lleva(['--source', '-s']) : [desdeRef];
        const rutas = (c === 'git checkout' && args.indexOf('--') > 0 ? args.slice(args.indexOf('--') + 1) : sueltos.filter((w) => !fuentes.includes(w)))
          .filter((w) => w && !w.startsWith('-') && !es(w));
        if (rutas.length) {
          // `checkout <ref> -- <rutas>` escribe lo que la ref trae y no borra lo que no tiene (lo que en el diff aparece
          // como agregado); `restore --source` también borra, así que cuenta todo
          const filtro = c === 'git checkout' ? ['--diff-filter=a'] : [];
          const r = require('child_process').spawnSync('git', ['-C', base, 'diff', '--name-only', ...filtro, '--end-of-options', desdeRef, '--', ...rutas],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
          if (r.error || r.status !== 0) {
            const raiz = require('child_process').spawnSync('git', ['-C', base, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
            const top = raiz.status === 0 ? String(raiz.stdout).trim() : null;
            // sin la raíz del repo, una ruta suelta a un archivo no puede traer una constancia; una carpeta, un patrón o
            // una ruta que nombra la carpeta de las constancias, sí
            const esCarpeta = (w) => { try { return fs.statSync(abs(w)).isDirectory(); } catch (_) { return false; } };
            const cubre = (w) => /[*?[]/.test(w) || w.startsWith(':') || (top
              ? ['.github', '.tycon'].some((d) => { const rel = path.relative(abs(w), path.join(top, d)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); })
              : w === '.' || esCarpeta(w) || /(?:^|[\\/])(?:\.github|\.tycon|control-changes)(?:[\\/]|$)/i.test(w));
            const dudosas = rutas.filter(cubre);
            if (dudosas.length) out.push(`${tramo.trim()} (no pude ver qué constancias trae ${desdeRef})`);
          } else {
            const traidas = String(r.stdout).split(/\r?\n/).filter(Boolean).filter((p) => isControlApproval(p));
            if (traidas.length) out.push(...traidas.map((p) => `${p} (desde ${desdeRef})`));
          }
        }
      }
    } else if (c === 'git apply' || c === 'git am' || c === 'patch') {
      const textos = [];
      const heredoc = /<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/.exec(tramo);
      if (heredoc) {
        const cuerpo = new RegExp(`<<-?[ \\t]*(['"]?)${heredoc[2]}\\1[^\\n]*\\n([\\s\\S]*?)\\n[ \\t]*${heredoc[2]}[ \\t]*(?=\\n|$)`).exec(cmd);
        textos.push(cuerpo ? cuerpo[2] : null);
      }
      const entrada = /(?<!<)<(?!<)\s*([^\s<>;&|]+)/.exec(tramo);
      // la marca del texto en línea (`<<'EOF'`) no es un archivo
      const sinMarca = heredoc ? args.filter((w) => w !== heredoc[2] && !/^<</.test(w)) : args;
      const parches = c === 'patch' ? parchesDePatch(sinMarca) : sinMarca.filter((w) => !w.startsWith('-') && !w.startsWith('<'));
      if (entrada) parches.push(entrada[1]);
      for (const p of parches) {
        try { textos.push(fs.readFileSync(abs(p), 'utf8')); } catch (e) { out.push(`${p} (no se pudo leer el parche: ${e.code || e.message})`); }
      }
      const porEntrada = !heredoc && !entrada && (parches.length === 0 || args.includes('-'));
      if (porEntrada) out.push(`${tramo.trim()} (un parche por la entrada estándar no se puede mirar antes)`);
      for (const t of textos) {
        if (t === null) out.push(`${tramo.trim()} (no encontré el final del texto del parche)`);
        else if (parcheNombraConstancia(t, isControlApproval)) out.push(tramo.trim());
      }
    }
  }
  return [...new Set(out)];
}

/**
 * El destino y los orígenes de una copia: el de `-t`/`--target-directory` (siempre una carpeta, en los comandos donde
 * `-t` es eso: en `rsync` es otra cosa), o el último argumento.
 */
function destinoDeLaCopia(args, conT) {
  let t = null;
  const sueltos = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--target-directory' || (conT && w === '-t')) { t = args[++i]; continue; }
    const pegado = conT ? /^(?:--target-directory=|-t)(.+)$/.exec(w) : /^--target-directory=(.+)$/.exec(w);
    if (pegado) { t = pegado[1]; continue; }
    if (w.startsWith('-') || w.startsWith('<')) continue;
    sueltos.push(w);
  }
  if (t) return { destino: t, origenes: sueltos, carpeta: true };
  if (sueltos.length < 2) return null;
  return { destino: sueltos[sueltos.length - 1], origenes: sueltos.slice(0, -1), carpeta: false };
}

/** Los archivos de parche de un `patch`: el de `-i`/`--input`, o el segundo argumento suelto (el primero es el que se parcha). */
function parchesDePatch(args) {
  const out = [];
  const sueltos = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '-i' || w === '--input') { if (args[i + 1]) out.push(args[++i]); continue; }
    const pegado = /^(?:--input=|-i)(.+)$/.exec(w);
    if (pegado) { out.push(pegado[1]); continue; }
    // las opciones de `patch` que llevan su valor aparte no son el archivo a parchar
    if (/^-[pdoDrBVYzFgx]$/.test(w)) { i++; continue; }
    if (!w.startsWith('-') && !w.startsWith('<')) sueltos.push(w);
  }
  if (sueltos.length >= 2) out.push(sueltos[1]);
  return out;
}

/** ¿El texto de un parche nombra una constancia? Con las rutas que git escribe entre comillas y con escapes octales. */
function parcheNombraConstancia(texto, isControlApproval) {
  const t = String(texto).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  if (/control-changes/i.test(t)) return true;
  const rutas = [];
  for (const linea of t.split(/\r?\n/)) {
    let m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(linea);
    if (m) { rutas.push(m[1], m[2]); continue; }
    m = /^(?:\+\+\+|---)\s+"?(?:[ab]\/)?([^"\t]+)"?/.exec(linea) || /^(?:rename|copy) (?:from|to) (.+)$/.exec(linea);
    if (m) rutas.push(m[1].trim());
  }
  return rutas.some((r) => isControlApproval(r));
}

/** El archivo que lee un `tar` (`-f x`, `-xzf x`, `-fx`, `--file=x`, `xzf x`), o null si lee la entrada estándar. */
function archivoDeTar(args) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--file' || w === '-f') return args[i + 1] && args[i + 1] !== '-' ? args[i + 1] : null;
    let m = /^--file=(.+)$/.exec(w);
    if (m) return m[1] === '-' ? null : m[1];
    // en un grupo de letras, la `f` se lleva lo que sigue pegado o la palabra siguiente
    m = /^-[A-Za-z]*f(.*)$/.exec(w);
    if (m && !w.startsWith('--')) { const a = m[1] || args[i + 1]; return a && a !== '-' ? a : null; }
    if (i === 0 && /^[A-Za-z]*f[A-Za-z]*$/.test(w)) return args[1] && args[1] !== '-' ? args[1] : null;
  }
  return null;
}

/**
 * Las rutas que trae un archivo que `tar`, `unzip` o `cpio` va a abrir, listadas antes con la misma herramienta; null
 * si no se pueden ver (por la entrada estándar, un archivo que no existe, la herramienta que falla o tarda).
 */
function contenidoDelArchivo(c, args, tramo, abs) {
  const { spawnSync } = require('child_process');
  const correr = (bin, argv, input) => {
    const r = spawnSync(bin, argv, { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    return r.error || r.status !== 0 ? null : String(r.stdout).split(/\r?\n/).filter(Boolean);
  };
  if (c === 'cpio') {
    const entrada = /(?<!<)<(?!<)\s*([^\s<>;&|]+)/.exec(tramo);
    if (!entrada) return null;
    let datos;
    try { datos = fs.readFileSync(abs(entrada[1])); } catch (_) { return null; }
    return correr('cpio', ['-it'], datos);
  }
  if (c === 'unzip') {
    const i = args.findIndex((w, k) => !w.startsWith('-') && args[k - 1] !== '-d');
    if (i < 0 || !fs.existsSync(abs(args[i]))) return null;
    return correr('unzip', ['-Z1', abs(args[i])]);
  }
  const archivo = archivoDeTar(args);
  if (!archivo || !fs.existsSync(abs(archivo))) return null;
  return correr(c, ['-tf', abs(archivo)]);
}

/** Lo que se llama como una constancia adentro de una carpeta, en rutas relativas; null si no se pudo revisar entera. */
function nombresDeConstancia(dir, tope = 20000) {
  const out = [];
  const pendientes = [''];
  let vistos = 0;
  while (pendientes.length) {
    const rel = pendientes.shift();
    let entradas;
    try { entradas = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (_) { return null; }
    for (const e of entradas) {
      if (++vistos > tope) return null;
      const r = path.join(rel, e.name);
      if (/^control-changes/i.test(e.name)) out.push(r);
      let carpeta = e.isDirectory();
      // un enlace a una carpeta se sigue (`cp -L`, `rsync -L`); el tope corta un enlace que vuelve sobre sí
      if (e.isSymbolicLink()) { try { carpeta = fs.statSync(path.join(dir, r)).isDirectory(); } catch (_) { carpeta = false; } }
      if (carpeta && e.name !== '.git') pendientes.push(r);
    }
  }
  return out;
}

// lo que el shell pone delante de un comando sin cambiar cuál corre: `{`, `then`, `do`, `!`, `xargs` con sus opciones
const PALABRA_DEL_SHELL = /^(?:(?:\{|then|do|else|elif|if|while|until|!|time)\s+|xargs\s+(?:(?:-[InLPdEs]\s+\S+|-\S+)\s+)*)/;

/** El tramo sin sus prefijos ni las palabras del shell que van delante del comando. */
function sinPalabrasDelShell(tramo) {
  let t = String(tramo).trim();
  for (;;) {
    const n = t.replace(PREFIJO, '').replace(PALABRA_DEL_SHELL, '').trim();
    if (n === t) return t;
    t = n;
  }
}

/**
 * El comando y lo que corre adentro de él: `$(…)`, comillas invertidas, `bash -c '…'`, `eval …` y `find … -exec …`.
 * Cada uno se mira como otro comando.
 */
function comandosAnidados(cmd, hondo = 0) {
  const out = [cmd];
  if (hondo > 3) return out;
  const sumar = (c) => { if (c && String(c).trim()) out.push(...comandosAnidados(String(c), hondo + 1)); };
  for (const m of String(cmd).matchAll(/\$\(((?:[^()]|\([^()]*\))*)\)/g)) sumar(m[1]);
  for (const m of String(cmd).matchAll(/`([^`]*)`/g)) sumar(m[1]);
  for (const tramo of tramos(cmd)) {
    const w = palabras(sinPalabrasDelShell(tramo)).filter((x) => x !== '');
    const c = nombreDeComando(w[0]);
    if (['bash', 'sh', 'zsh', 'dash'].includes(c)) {
      const i = w.findIndex((x, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
      if (i > 0) sumar(w[i + 1]);
    }
    if (c === 'eval') sumar(w.slice(1).join(' '));
    if (c === 'find') {
      const i = w.findIndex((x) => x === '-exec' || x === '-execdir' || x === '-ok');
      if (i >= 0) {
        const fin = w.findIndex((x, k) => k > i && (x === ';' || x === '+' || x === '\\;' || x === '\\'));
        sumar(w.slice(i + 1, fin < 0 ? undefined : fin).join(' '));
      }
    }
  }
  return out;
}

/** ¿La ruta queda adentro de un repo de git? Sube desde la carpeta que exista más cerca. */
function dentroDeUnRepo(p) {
  let d = path.resolve(p);
  for (;;) {
    try { if (fs.existsSync(path.join(d, '.git'))) return true; } catch (_) { return true; }
    const arriba = path.dirname(d);
    if (arriba === d) return false;
    d = arriba;
  }
}

/** Los destinos de los que copian sin que `extractWriteTargets` los vea: `install`, `rsync`, `ditto`, `scp`, `curl -o`, `wget -O`. */
function destinosDeCopia(cmd) {
  const out = [];
  for (const tramo of tramos(cmd)) {
    const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
    const c = nombreDeComando(words[0]);
    if (['install', 'rsync', 'ditto', 'scp'].includes(c)) {
      const sueltos = words.slice(1).filter((w) => !w.startsWith('-'));
      if (sueltos.length >= 2) out.push(sueltos[sueltos.length - 1]);
    }
    if (c === 'curl' || c === 'wget') {
      for (let i = 1; i < words.length; i++) {
        if (/^(?:-o|--output|-O|--output-document)$/.test(words[i]) && words[i + 1]) out.push(words[i + 1]);
        const pegado = /^(?:--output|--output-document)=(.+)$/.exec(words[i]);
        if (pegado) out.push(pegado[1]);
      }
    }
  }
  return out;
}

/**
 * Las rutas que un comodín (`specs/*.md`, `specs/story-2.?`) nombra en el disco, desde `base` (hasta 200 en cada
 * tramo). Si se le pasa `aviso`, `aviso.recortado` queda en true cuando algún tramo pasó de 200.
 */
function expandirComodin(patron, base, aviso) {
  const absoluto = path.isAbsolute(patron) ? patron : path.join(base, patron);
  const partes = absoluto.split(/[\\/]+/);
  let actuales = [partes[0] === '' ? path.sep : `${partes[0]}${path.sep}`];
  const aRegex = (g) => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  for (const parte of partes.slice(1)) {
    if (!parte) continue;
    const sig = [];
    for (const dir of actuales) {
      if (!/[*?[]/.test(parte)) { sig.push(path.join(dir, parte)); continue; }
      let nombres = [];
      try { nombres = fs.readdirSync(dir); } catch { continue; }
      const re = aRegex(parte);
      for (const n of nombres) if (re.test(n) && (!n.startsWith('.') || parte.startsWith('.'))) sig.push(path.join(dir, n));
    }
    if (aviso && sig.length > 200) aviso.recortado = true;
    actuales = sig.slice(0, 200);
    if (!actuales.length) break;
  }
  return actuales.filter((p) => fs.existsSync(p));
}

/**
 * El estado de una historia: `'draft'`, otro estado, `''` (historia sin `status:`), o null si no es una historia. Sin la
 * marca de orden de bytes y con CRLF. Un archivo que existe y no se puede leer cuenta como historia (del lado que frena).
 */
function estadoDeHistoria(abs) {
  let texto = '';
  try { texto = fs.readFileSync(abs, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n'); } catch (e) { logHookError(e); return '?'; }
  let declares = (t) => /^---[\s\S]*?^[ \t]*story[ \t]*:/m.test(t);
  try { ({ declaresStoryIdentity: declares } = require('./lib/story-discovery.js')); } catch { /* la forma de siempre */ }
  if (!declares(texto)) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(texto);
  const estado = fm && /^["']?status["']?\s*:\s*["']?([\w-]+)/m.exec(fm[1]);
  return estado ? estado[1].toLowerCase() : '';
}

/**
 * Las historias que el comando puede escribir: sus destinos de escritura, el destino de un guion que sale de una ruta
 * literal (`const f='…'`) y, con un editor en el lugar o un `for` que escribe, cada palabra y cada comodín que nombra
 * (`ls … | xargs sed -i`, `find specs -name '*.md' -exec sed -i`). Se resuelven desde la carpeta de la sesión, cada `cd`
 * y cada carpeta de un `find`. Desde un comando no se ve qué queda escrito: la historia se edita con Edit/Write y el
 * estado lo cambia marker.js. Un borrador pasa sólo si el comando lo reescribe entero con un heredoc legible que lo
 * deja en borrador (ahí lo juzga el freno de la historia sin validar); escribirle encima de otra forma podría cerrarla.
 */
function historiasPorConsola(cmd, cwd, targets, sesion = cwd, destinosConComodin = []) {
  const enSitio = editaEnSitio(cmd);
  if (!enSitio && !ESCRIBE.test(String(cmd || ''))) return [];
  // con todos los editores en el lugar escritos como `sed` que nombra sus archivos, lo que escriben es lo que nombran:
  // la carpeta de un `cd` es desde dónde se leen, y una historia que tocan se ensaya para ver si le cambia el estado
  const seds = enSitio ? sedsLiterales(cmd) : null;
  const resolver = (raw, base) => resolveTarget(expandirRuta(cmd, raw).valor, base, process.platform, { homeVariable: true });
  const bases = [cwd];
  for (const m of String(cmd).matchAll(/(?:^|[\s;&|(])cd\s+(['"]?)([^\s'";&|)]+)\1/g)) bases.push(resolver(m[2], cwd));
  // con un editor en el lugar, la carpeta de cada `cd` cuenta por las historias que tiene, salvo en la forma exacta de
  // un solo `sed` que nombra sus archivos: desde la sesión y desde el `cd` anterior, con su comodín expandido; la que no
  // se sabe resolver frena
  const carpetasDeCd = [];
  const cdSinResolver = [];
  if (enSitio && !CD_INICIAL.test(String(cmd))) {
    // un comodín puede dejar varias carpetas: el `cd` que sigue se resuelve desde todas
    let previas = [sesion];
    const absoluta = (v, b) => resolveTarget(v, b, process.platform, { homeVariable: true });
    for (const c of carpetasDeLosCd(cmd)) {
      if (c.valor == null) { cdSinResolver.push(`cd ${c.texto}`); continue; }
      // `cd` solo va a HOME: mueve la base del `cd` que sigue, pero la HOME entera no es una carpeta de historias
      if (!c.texto) { previas = [os.homedir()]; continue; }
      const desde = [...new Set([...previas, sesion])];
      const aviso = {};
      const halladas = c.comodin
        ? desde.flatMap((b) => expandirComodin(c.valor.replace(/^~(?=\/|$)/, os.homedir()), b, aviso))
        : desde.map((b) => absoluta(c.valor, b));
      // `expandirComodin` corta en 200 por tramo: con un tramo recortado no se sabe si quedó una carpeta afuera
      if (aviso.recortado) cdSinResolver.push(`cd ${c.texto} (más de 200 carpetas)`);
      (seds ? bases : carpetasDeCd).push(...halladas);
      previas = c.comodin ? (halladas.length ? halladas : previas.map((b) => absoluta(c.valor, b))) : halladas.slice(0, previas.length);
    }
  }
  for (const tramo of tramos(cmd)) {
    const words = palabras(tramo.trim().replace(PREFIJO, '')).filter((w) => w !== '');
    const i = words.findIndex((w) => path.basename(w) === 'find');
    if (i >= 0) for (const w of words.slice(i + 1)) { if (w.startsWith('-') || w === '!' || w === '(') break; bases.push(resolver(w, cwd)); }
  }
  // un guion que escribe, copia, mueve o borra: cuenta cada texto que nombra (`glob.glob('specs/*.md')`, `'h.md'`)
  const textosDeGuion = scriptsInline(cmd).filter(({ script }) => GUION_ESCRIBE.test(script))
    .flatMap(({ script }) => [...script.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]).filter((t) => !/\s/.test(t)));
  const destinosB = destinosBorrados(cmd);
  const borrados = destinosB.map((d) => d.raw);
  // lo que sólo se repone (`git checkout -- x`, `git restore x`): cuenta si la historia tiene cambios que perdería
  // (desde otra rama o commit, `git checkout <ref> -- x` o `git restore --source`, la cambia aunque no tenga cambios)
  const conRef = /\bgit\b[^\n;&|]*\scheckout\s+(?!--)[^\s-]\S*\s+--|\bgit\b[^\n;&|]*\srestore\b[^\n;&|]*\s(?:--source|-s)\b/.test(String(cmd));
  const soloRepone = new Set(conRef ? [] : destinosB.filter((d) => d.kind === 'restore').map((d) => d.raw));
  const nombradas = seds ? seds.map((x) => x.archivo) : palabrasDelEditor(cmd);
  const crudos = [
    ...targets,
    ...destinosArmados(cmd).flatMap((a) => (a.literal ? [a.literal] : (a.literales || []))),
    // lo que borra, repone (`git checkout -- h.md`, `git restore`) o saca de `.md` con un `mv`: también la toca
    ...borrados,
    ...movidosFueraDeMd(cmd),
    ...destinosDeCopia(cmd),
    ...textosDeGuion,
    ...(enSitio || FOR_IN.test(cmd) ? nombradas : []),
  ];
  // una carpeta cuenta por las historias que tiene adentro cuando el comando la borra, la repone o la edita en el lugar
  // (`git checkout <rama> -- specs/`, `git restore .`, `grep -rl x specs | xargs sed -i`)
  const porCarpeta = new Set([...borrados, ...(enSitio ? nombradas : [])]);
  const adentro = (dir) => {
    const out = [];
    const ver = (d, nivel) => {
      let entradas = [];
      try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entradas) {
        if (out.length >= 500) return;
        if (e.isDirectory() && nivel < 4 && !NEVER_CODE_SEGMENTS.has(e.name) && e.name !== '.git') ver(path.join(d, e.name), nivel + 1);
        else if (e.isFile() && /\.md$/i.test(e.name)) out.push(path.join(d, e.name));
      }
    };
    ver(dir, 0);
    return out;
  };
  const vistos = new Set();
  const repuestos = new Set();   // las que sólo se nombran como algo que se repone
  const otros = new Set();
  // lo que nombra otra cosa que un `sed` ensayable: ésas no se ensayan
  const noSoloSed = new Set();
  const deSed = new Set(seds ? nombradas : []);
  const sedsDe = new Map();
  // el paréntesis que cierra un subshell no es parte de la ruta: `(cd specs; echo x >> h.md)`. Una variable que puede no
  // haber quedado puesta (`cd wt && f=specs/h.md && python3 - "$f" <<EOF`) cuenta también por lo que valdría si corrió
  const valoresDe = (raw) => {
    const limpio = String(raw).replace(/\)+$/, '');
    return [...new Set([expandirRuta(cmd, limpio).valor, expandirRuta(cmd, limpio, { posibles: true }).valor])];
  };
  for (const raw of crudos) for (const valor of valoresDe(raw)) {
    // una palabra que no nombra un archivo no es un destino: el `))` que cierra una cuenta queda vacío sin sus
    // paréntesis, y la `/` suelta de un guion (`'s/^a /b /'`) no es la raíz que el editor escribe; la raíz que se
    // borra o que es destino de una escritura sigue contando
    if (!valor || (/^\/+$/.test(valor) && !borrados.includes(raw) && !targets.includes(raw))) continue;
    const anotar = (abs) => {
      vistos.add(abs);
      (soloRepone.has(raw) ? repuestos : otros).add(abs);
      if (!deSed.has(raw)) noSoloSed.add(abs);
      else sedsDe.set(abs, [...(sedsDe.get(abs) || []), ...seds.filter((x) => x.archivo === raw)]);
    };
    for (const base of bases) {
      const rutas = /[*?[]/.test(valor) ? expandirComodin(valor.replace(/^~(?=\/|$)/, os.homedir()), base)
        : [resolveTarget(valor, base, process.platform, { homeVariable: true })];
      for (const abs of rutas) {
        let esCarpeta = false;
        try { esCarpeta = porCarpeta.has(raw) && !NEVER_CODE_SEGMENTS.has(path.basename(abs)) && fs.statSync(abs).isDirectory(); } catch { /* no existe */ }
        if (esCarpeta) { for (const md of adentro(abs)) anotar(md); continue; }
        if (/\.md$/i.test(abs) && fs.existsSync(abs)) anotar(abs);
      }
    }
  }
  for (const dir of new Set(carpetasDeCd)) {
    let esCarpeta = false;
    try { esCarpeta = !NEVER_CODE_SEGMENTS.has(path.basename(dir)) && fs.statSync(dir).isDirectory(); } catch { /* no existe */ }
    if (!esCarpeta) continue;
    const { mds, incompleta } = recorrerCarpetaDeCd(dir);
    // sin recorrerla entera (los topes, una carpeta que no se puede leer) puede quedar una historia sin mirar
    if (incompleta) cdSinResolver.push(`cd ${dir} (${incompleta})`);
    for (const md of mds) { vistos.add(md); otros.add(md); }
  }
  // un destino con un `$(date …)` puede caer en cualquier archivo de su carpeta: si la carpeta tiene
  // historias, cuentan todas (salga `.md` o `.log`)
  // (con las variables del comando, y desde cada carpeta donde puede estar parado: `cd a; cd ../b`, `cd a || cd b`)
  const basesDelDestino = [...new Set([...bases, sesion, ...carpetasDelComando(cmd, sesion)])];
  for (const glob of destinosConComodin) {
    const carpeta = path.dirname(expandirRuta(cmd, glob).valor);
    const aviso = {};
    const carpetas = basesDelDestino.flatMap((b) => (/[*?[]/.test(carpeta) ? expandirComodin(carpeta, b, aviso)
      : [resolveTarget(carpeta, b, process.platform, { homeVariable: true })]));
    // con un tramo del comodín recortado no se sabe si quedó afuera una carpeta con historias
    if (aviso.recortado) cdSinResolver.push(`${glob} (más de 200 carpetas)`);
    for (const dir of new Set(carpetas)) {
      let nombres = [];
      try { nombres = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
        // una carpeta que no existe no tiene historias; una que no se puede leer, no se sabe
        if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') { logHookError(e); cdSinResolver.push(`${glob} (no pude leer ${dir})`); }
        continue;
      }
      for (const e of nombres) {
        if (!/\.md$/i.test(e.name)) continue;
        const p = path.join(dir, e.name);
        // un enlace simbólico a una historia cuenta como la historia
        let esArchivo = e.isFile();
        if (e.isSymbolicLink()) { try { esArchivo = fs.statSync(p).isFile(); } catch { /* roto */ } }
        if (esArchivo) { vistos.add(p); otros.add(p); }
      }
    }
  }
  // reponer una historia sin cambios no le cambia nada: pasa (`git restore .` después de tocar código)
  const conCambios = (abs) => {
    const r = require('child_process').spawnSync('git', ['-C', path.dirname(abs), 'status', '--porcelain', '--', abs],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return r.error || r.status !== 0 || String(r.stdout).trim() !== '';
  };
  for (const abs of repuestos) if (!otros.has(abs) && !conCambios(abs)) vistos.delete(abs);
  // el cuerpo de un heredoc que reescribe el archivo entero (`>`, no `>>`)
  const enteros = new Map();
  for (const h of heredocs(cmd)) {
    if (!h.target || !new RegExp(`(?:^|[^>])>\\s*['"]?${h.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(cmd)) continue;
    enteros.set(resolveTarget(expandirRuta(cmd, h.target).valor, cwd, process.platform, { homeVariable: true }), h.body);
  }
  const sinResolver = cdSinResolver.map((t) => `(la carpeta de \`${t}\`, que no sé resolver: puede tener historias)`);
  return [...sinResolver, ...[...vistos].filter((abs) => {
    const estado = estadoDeHistoria(abs);
    if (estado === null) return false;
    // un `sed` que deja el estado del encabezado como estaba no la cierra: pasa como el cuerpo editado con Edit
    if (sedsDe.has(abs) && !noSoloSed.has(abs)) {
      let antes = null;
      try { antes = fs.readFileSync(abs, 'utf8'); } catch (e) { logHookError(e); }
      const despues = antes == null ? null : ensayarSeds(abs, [...new Set(sedsDe.get(abs))]);
      const ea = estadosDelEncabezado(antes || '');
      if (despues != null && ea.length && JSON.stringify(ea) === JSON.stringify(estadosDelEncabezado(despues))) return false;
    }
    if (estado !== 'draft') return true;
    // el estado del encabezado del cuerpo (todos sus `status:` en borrador), no un `status: draft` cualquiera más abajo
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(enteros.get(abs) || '');
    const estados = fm ? [...fm[1].matchAll(/^["']?status["']?\s*:\s*["']?([\w-]+)/gm)].map((m) => m[1].toLowerCase()) : [];
    return !(estados.length && estados.every((e) => e === 'draft'));
  })];
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
function frenoBorrarYArmados({ cmd, cwd, stateDir, sessionId, io, isInside, via, codex = false }) {
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
  const deLaStory = [];
  let declarados = null;
  // los archivos del repo que la story declara (files_to_create, files_to_modify, files_to_delete), por ruta real. La
  // story puede nombrarlos desde otra raíz (`app/src/a.ts` en un repo de specs): cuenta el final de la ruta, desde una
  // carpeta, y sólo si nombra una carpeta (`a.ts` a secas no dice cuál)
  const nombrados = () => {
    if (declarados) return declarados;
    declarados = new Set();
    let texto = '';
    try { texto = marker.storyPath ? fs.readFileSync(marker.storyPath, 'utf8') : ''; } catch (_) { return declarados; }
    const ts = require('./lib/test-scope.js');
    const finales = [...ts.parseDeclaredFiles(texto), ...ts.parseFilesToDelete(texto)]
      .map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '')).filter((f) => f.includes('/') && !f.split('/').includes('..'));
    for (const d of adentro) {
      const abs = real(d.abs);
      const posix = abs.split(path.sep).join('/');
      const rel = path.relative(repoReal, abs).split(path.sep).join('/');
      // desde una raíz más arriba (`acme-web/src/a.ts`) o desde una carpeta del repo (`app/src/a.ts` con el repo en `app`)
      if (finales.some((f) => posix.endsWith(`/${f}`) || f === rel || (rel.includes('/') && f.endsWith(`/${rel}`)))) declarados.add(abs);
    }
    return declarados;
  };
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
    // un `git rm` de un archivo que la story declara: es parte de la historia, pasa y se anota como tocado
    if (d.git && esCodigo(d.abs) && !esCarpeta && !/[*?[]/.test(d.raw) && lista && lista.length && nombrados().has(real(d.abs))) {
      deLaStory.push(d);
      continue;
    }
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
    anotarEscriturasConsola(stateDir, sessionId, [...pasan.filter((d) => d.kind === 'delete'), ...deLaStory].map((d) => d.abs), 'delete');
    if (deLaStory.length) anotarBorradosDeLaStory({ stateDir, sessionId, marker, rutas: deLaStory.map((d) => d.abs), via });
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
  return { block: lv.mensaje(frena, marker.storyId, { borrarODeshacer: deCodigo.length > 0, armado: armados.length > 0, codex }) + '\n' };
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
  const re = /(^|[\n;&|][ \t]*)([^\n]*?)(?<=(?:^|\n)(?:[^"'\n]|"[^"\n]*"|'[^'\n]*')*)(?<!\$\(\([^\n]*)(?<!<)<<(?!<)-?[ \t]*(['"]?)([^\s'"<>;&|()$`\\-][^\s'"<>;&|()$`\\]*)\3(?=[\s;&|()<>]|$)([^\n]*)\n([\s\S]*?)\n[ \t]*\4[ \t]*(?=\n|$)/g;
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
/**
 * Lo que un `git rm` borra con permiso de la story: va a los archivos tocados de la corrida y a sus eventos (como una
 * edición por el editor, para que la vuelta siguiente de revisores lo mire), con su línea en gates.log. Se anota antes de
 * que el comando corra: si `git rm` falla, el archivo sigue y la corrida lo tiene de más, no de menos.
 */
function anotarBorradosDeLaStory({ stateDir, sessionId, marker, rutas, via }) {
  const archivo = path.join(stateDir, 'active', `${String(sessionId || '_nosession').replace(/[/\\]/g, '_')}.json`);
  try {
    const m = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    const ts = new Date().toISOString();
    m.filesTouched = Array.isArray(m.filesTouched) ? m.filesTouched : [];
    m.fileEvents = Array.isArray(m.fileEvents) ? m.fileEvents : [];
    for (const p of rutas) {
      if (!m.filesTouched.includes(p)) m.filesTouched.push(p);
      m.fileEvents.push({ path: p, ts });
    }
    if (m.fileEvents.length > 500) m.fileEvents = m.fileEvents.slice(-500);
    m.lastTouch = ts;
    const tmp = `${archivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, archivo);
  } catch (e) { logHookError(e); }
  try {
    fs.appendFileSync(path.join(stateDir, 'gates.log'), JSON.stringify({
      ts: new Date().toISOString(), sessionId, repoPath: marker.repoPath, name: 'ledger-visible', status: 'story-delete',
      storyId: marker.storyId || null, files: rutas.length, paths: rutas, via,
    }) + '\n', 'utf8');
  } catch (e) { logHookError(e); }
}

function anotarEscriturasConsola(stateDir, sessionId, rutas, kind = null) {
  const legacy = require('./lib/legacy-names.js');
  const where = 'skills/tycon-pipeline/scripts/on-bash-write-gate.js';
  if (!rutas.length || legacy.readEnv('TYCON_NO_RUN_CHANGE', { where }) === '1') return;
  const nueva = path.join(stateDir, 'console-writes');
  let dir;
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
// Con la ejecución perdida, lo único que pasa por la terminal es leer y la salida: cada tramo del comando, un programa de
// esta lista con palabras literales, sin redirecciones, sin `$(…)`, sin heredocs y sin asignaciones delante.
const LEE = new Set(['cat', 'ls', 'grep', 'head', 'tail']);
const MARKER_LEE = new Set(['get', 'list-all', 'find-by-story', 'clear-session', 'restore']);
const PIPELINE_LEE = new Set(['risk-class', 'followups-status']);
// El programa vale por su nombre sólo si es el del sistema: sin ruta (lo busca el PATH), en una carpeta del sistema, o
// el mismo node que corre este gancho. Un `./cat` plantado en el repo no es leer.
const CARPETAS_DEL_SISTEMA = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];
function programaDelSistema(texto) {
  const t = String(texto);
  if (!/[\\/]/.test(t)) return true;
  if (CARPETAS_DEL_SISTEMA.some((c) => t.startsWith(c))) return true;
  try { return fs.realpathSync(t) === fs.realpathSync(process.execPath); } catch { return false; }
}
function esteGuion(arg, guion, cwd) {
  if (guion !== 'marker.js' && guion !== 'pipeline.js') return false;
  // `~` entre comillas no lo expande el shell: si en la carpeta hay un `~`, no se sabe cuál corre
  if (/^~[\\/]/.test(arg) && fs.existsSync(path.join(cwd || process.cwd(), '~'))) return false;
  try {
    const dado = path.resolve(cwd || process.cwd(), arg.replace(/^~(?=[\\/])/, os.homedir()));
    return fs.realpathSync(dado) === fs.realpathSync(path.join(__dirname, guion));
  } catch { return false; }
}
function soloLee(cmd, shell, cwd) {
  const { tramos, subs, abierta } = require('./lib/marker-command.js').tramos(String(cmd), shell);
  if (subs.length || abierta || !tramos.length) return false;
  return tramos.every((t) => {
    const w = t.palabras;
    if ((t.heredocs && t.heredocs.length) || !w.length) return false;
    if (w.some((x) => !x.literal || /[<>]/.test(x.texto))) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w[0].texto)) return false;
    if (!programaDelSistema(w[0].texto)) return false;
    const prog = path.basename(w[0].texto.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
    if (LEE.has(prog)) return true;
    if (prog === 'git') return ['status', 'diff', 'log'].includes(w[1] && w[1].texto) && !w.some((x) => /^--output\b/.test(x.texto));
    if (prog !== 'node' && prog !== 'nodejs') return false;
    const guion = w[1] ? path.basename(w[1].texto.replace(/\\/g, '/')).toLowerCase() : '';
    // el nombre no alcanza: un marker.js cualquiera podría escribir; vale sólo el guion de esta misma carpeta
    if (!esteGuion(w[1] && w[1].texto, guion, cwd)) return false;
    const sub = w[2] && w[2].texto;
    // clear-session sólo es la salida con --lost; sin él, sacaría la ejecución sin la frase del dueño
    if (guion === 'marker.js') return MARKER_LEE.has(sub) && (sub !== 'clear-session' || w.some((x) => x.texto === '--lost'));
    if (guion === 'pipeline.js') return PIPELINE_LEE.has(sub) || (sub === 'run-dir' && !w.some((x) => x.texto === '--create'));
    return false;
  });
}

// La ejecución de la sesión perdió una pieza (lib/open-runs.js): frena todo lo que no es leer o la salida, antes de mirar
// destinos. No poder preguntar no es estar sana.
function ejecucionPerdida(event) {
  if (event?.tool_name && event.tool_name !== 'Bash' && event.tool_name !== 'PowerShell') return null;
  const cmd = event?.tool_input?.command;
  if (!cmd) return null;
  const or = require('./lib/open-runs.js');
  const sessionId = resolveSessionId(event?.session_id);
  let p;
  try { p = or.perdida({ sid: sessionId, cwd: nativePath(event?.cwd || process.cwd()) }); } catch (e) {
    p = { caso: 'ilegible', falta: `no pude revisar las piezas de la ejecución (${e.message})`, sesion: String(sessionId) };
  }
  if (!p) return null;
  if (soloLee(cmd, event?.tool_name === 'PowerShell' ? 'powershell' : 'bash', nativePath(event?.cwd || process.cwd()))) return null;
  const io = require('./lib/story-gate-io.js');
  io.appendLog(io.DEFAULT_STATE_DIR, 'gates.log', sessionId, { name: 'story-gate', status: 'blocked', kind: 'ejecucion-perdida', via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`, story: p.story, reason: `ejecución perdida (${p.caso}): ${p.falta}` });
  return { block: or.cartel(p, { markerJs: path.join(__dirname, 'marker.js') }) + '\n' };
}

function handle(event, opts = {}) {
  {
    let perdida = null;
    try { perdida = ejecucionPerdida(event); } catch (e) { logHookError(e); perdida = { block: `🔴 EJECUCIÓN PERDIDA — no pude revisar las piezas de la ejecución (${e.message}): frena hasta poder mirarlas.\n` }; }
    if (perdida) return perdida;
  }
  let deprecado = null;
  try {
    const cmd = event?.tool_input?.command;
    if (cmd && (!event?.tool_name || event.tool_name === 'Bash' || event.tool_name === 'PowerShell')) {
      const baseCwd = nativePath(event?.cwd || process.cwd());
      deprecado = require('./on-deprecated-edit.js').porLaTerminal({
        cmd, cwd: cwdDelComando(cmd, baseCwd),
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
  const io = require('./lib/story-gate-io.js');
  const stateDir = opts.stateDir || io.DEFAULT_STATE_DIR;
  const installedTree = require('./lib/installed-tree.js');
  const installedRoots = Array.isArray(opts.installedRoots) ? opts.installedRoots : io.defaultInstalledRoots();
  const { isInside } = require('./lib/atdd-preedit.js');
  // Con un comando ambiguo (varios cd), de las carpetas donde puede caer una escritura relativa vale la que hace caer en
  // el repo de la corrida una de código o un manifiesto (alcanza con una para frenar); si no hay, la que hace caer
  // cualquiera (una carpeta, un borrado); si tampoco, la primera. El lado que frena
  const carpetas = carpetasDelComando(cmd, baseCwd);
  let cwd = carpetas[0];
  if (carpetas.length > 1) {
    try {
      const marcador = io.readMarker(stateDir, resolveSessionId(event?.session_id));
      const repoCorrida = marcador && marcador.repoPath;
      const relativos = relativosDe(String(cmd), String(cmd)) || [];
      const enRepo = (c, soloCodigo) => repoCorrida && relativos.some((t) => {
        const abs = resolveTarget(expandirRuta(cmd, t).valor, c, process.platform, { homeVariable: true });
        const adentro = isInside(repoCorrida, abs) || isInside(installedTree.realPath(repoCorrida), installedTree.realPath(abs));
        return adentro && (!soloCodigo || isCodeFile(abs) || isManifestFile(abs));
      });
      cwd = carpetas.find((c) => enRepo(c, true)) || carpetas.find((c) => enRepo(c, false)) || carpetas[0];
    } catch (e) { logHookError(e); }
  }
  // el estado y el árbol instalado del arnés se miran por ruta real, sea cual sea la extensión; las constancias de los
  // cambios de control, por su final
  const stateReal = installedTree.realPath(stateDir);
  const { signedRecordKind } = require('./lib/story-gate.js');
  const protegido = (abs) => {
    const real = installedTree.realPath(abs);
    return isInside(stateDir, abs) || isInside(stateReal, real) || installedTree.inside(installedRoots, real, { real: true })
      || signedRecordKind(abs) !== null || signedRecordKind(real) !== null;
  };
  // un `.md` también se mira en un `sed -i`: puede ser una historia en borrador (el freno de historia sin validar)
  // (con las variables del comando expandidas: `sed -i … "$F"` con `F=story.md`)
  const keep = (t) => {
    const valor = expandirRuta(cmd, t).valor;
    return /\.md$/i.test(t) || /\.md$/i.test(String(valor)) || protegido(resolveTarget(valor, cwd, process.platform, { homeVariable: true }));
  };
  // las constancias de cambio de control, sin interruptor: como el freno de Edit y Write
  const constancias = constanciasTocadas(cmd, cwd, stateDir);
  if (constancias.length) {
    const sg = require('./lib/story-gate.js');
    // el registro del arnés y la carpeta de una ejecución son estado del pipeline; lo demás, su constancia
    const kind = constancias.map((c) => sg.signedRecordKind(String(c).replace(/ \(.*\)$/, ''))).find(Boolean)
      || (constancias.some((c) => /(^|[\\/])gates\.log$|\(no se puede ver qué trae lo que se descomprime\)$/.test(String(c))) ? 'state-dir' : 'control-approvals');
    return { block: sg.blockMessage({ kind }, { filePath: constancias[0], via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}` }) + '\n' };
  }
  // un guion guardado en un archivo (`python3 p.py`, `node p.js <historia>`): lo que escribe se mira como si llegara por
  // la entrada. La constancia frena sin interruptor; la historia, con el freno de historias prendido
  {
    for (const g of guionesEnArchivo(cmd, [...new Set([cwd, baseCwd])], installedRoots)) {
      const via = `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 100)} (el guion ${path.basename(g.archivo)})`;
      // uno muy grande no se lee entero: si escribe y nombra una historia o una constancia, frena
      if (g.grande) {
        if (!g.texto || (GUION_ESCRIBE.test(g.texto) && MENCIONA_HISTORIA.test(g.texto))) {
          return { block: `⛔ tycon-pipeline — GUION QUE NO SE PUEDE LEER ENTERO\n\n  ${g.archivo}\n  (detectado en ${via})\n  Es demasiado grande para ver qué escribe, y nombra una historia o una constancia. Una historia se edita con\n  la herramienta de edición (Edit/Write); una constancia la firma una persona.\n` };
        }
        continue;
      }
      const escritos = escritosDelGuion(g);
      const resolver = (t) => resolveTarget(t, cwd, process.platform, { homeVariable: true });
      // un destino que arma de un modo que no se lee (`argparse`, un desempaquetado) puede ser cualquier argumento
      const abs = [...escritos.rutas, ...(escritos.armadosSinSaber ? g.argv : [])].map(resolver);
      const constancia = abs.find((p) => signedRecordKind(p) !== null || signedRecordKind(installedTree.realPath(p) || p) !== null);
      if (constancia) {
        const sg = require('./lib/story-gate.js');
        return { block: sg.blockMessage({ kind: sg.signedRecordKind(constancia) || 'control-approvals' }, { filePath: constancia, via }) + '\n' };
      }
      const historias = skillOff ? [] : abs.filter((p) => /\.md$/i.test(p) && fs.existsSync(p) && estadoDeHistoria(p) !== null);
      if (historias.length) return { block: require('./lib/story-gate.js').storyByConsoleMessage(historias, via) + '\n' };
    }
  }
  if (!laneOff) {
    // los marcadores de la ejecución, de esta sesión o de otra, con la ejecución abierta o no
    const tocados = marcadoresTocados(cmd, cwd, stateDir);
    if (tocados.length) {
      return { block: require('./lib/story-gate.js').markerDeleteMessage(tocados, `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`) + '\n' };
    }
    const r = frenoBorrarYArmados({
      cmd, cwd, stateDir, sessionId: resolveSessionId(event?.session_id), io, isInside,
      via: `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`,
      codex: require('./lib/story-skill-gate-io.js').isCodexEvent(event),
    });
    if (r) return r;
  }
  // un `$(date …)` en el nombre de un informe se lee como un comodín: el destino entero, ya no «sin
  // resolver». La carpeta que se sabe no puede tocar el estado del pipeline ni el árbol instalado
  // desde cada carpeta donde puede estar parado el comando (`cd a || cd b`, dos `cd` seguidos), y siguiendo los enlaces
  // simbólicos que el comodín puede nombrar
  const basesPosibles = [...new Set([cwd, baseCwd, ...carpetas])];
  const sub = subcomandosComoComodin(cmd, (conocida, glob) => {
    // una variable que no se resuelve deja la carpeta sin saber: frena como hoy
    const ex = expandirRuta(cmd, conocida);
    if (ex.sinResolver.length) return false;
    const exGlob = expandirRuta(cmd, glob);
    if (exGlob.sinResolver.length) return false;
    const zonas = [stateDir, stateReal, ...installedRoots, ...installedRoots.map((r) => installedTree.realPath(r))];
    const toca = (p) => { const real = installedTree.realPath(p); return zonas.some((z) => isInside(z, p) || isInside(z, real) || isInside(p, z) || isInside(real, z)); };
    for (const base of basesPosibles) {
      if (toca(resolveTarget(ex.valor, base, process.platform, { homeVariable: true }))) return false;
      // lo que el comodín nombra en el disco, carpeta por carpeta (un enlace que da al estado); con un tramo recortado
      // no se sabe si quedó uno afuera
      const partes = exGlob.valor.split('/');
      for (let i = partes.findIndex((s) => s.includes('*')); i >= 0 && i < partes.length; i++) {
        const aviso = {};
        for (const p of expandirComodin(partes.slice(0, i + 1).join('/') || '.', base, aviso)) if (toca(p)) return false;
        if (aviso.recortado) return false;
      }
    }
    return true;
  });
  const cmdDestinos = sub.cmd;
  const targets = extractWriteTargets(cmdDestinos, { keep });
  if (!skillOff) {
    // una historia que existe y no está en borrador no se escribe por consola (con o sin ejecución abierta)
    const historias = historiasPorConsola(cmd, cwd, targets, baseCwd, sub.destinos);
    if (historias.length) {
      return { block: require('./lib/story-gate.js').storyByConsoleMessage(historias, `Bash: ${String(cmd).replace(/\s+/g, ' ').slice(0, 120)}`) + '\n' };
    }
  }
  if (!targets.length) return null;

  const sessionId = resolveSessionId(event?.session_id);
  // Con las variables del comando (y del ambiente) expandidas; lo no resuelto queda anotado para el mensaje
  const resueltos = destinosResueltos(cmdDestinos, cwd, process.platform, { keep });
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
        // anclada al cwd quede afuera (con la sesión parada en otra carpeta, pasaría callado). Por ruta real también: la
        // sesión puede llegar al repo por un enlace y el marcador guarda la ruta real (o al revés)
        dentroDelRepo: (f, repo) => isInside(repo, f) || isInside(installedTree.realPath(repo), installedTree.realPath(f)) || sinResolverDe.has(f),
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
        return { block: lv.mensaje(vis.files, marker && marker.storyId, { sinResolver, codex: require('./lib/story-skill-gate-io.js').isCodexEvent(event) }) + '\n' };
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
      const hds = heredocs(cmdDestinos);
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
      const hds = heredocs(cmdDestinos);
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

module.exports = { handle, resolveTarget, cwdDelComando, destinosResueltos, extractWriteTargets, destinosArmados, destinosBorrados, stripNonCommandText, leadingCd, heredocs, heredocBodies, inlineStoryText, nameSuggestsStory, renameOrCopyOfExistingStory };

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
