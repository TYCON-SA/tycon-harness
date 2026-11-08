'use strict';
/**
 * ci-bypass.js — qué comando hace entrar un cambio a la rama principal salteando la cola, la CI o las políticas de la
 * rama. Lo usa el freno de la sesión (scripts/hooks/safety-guard-pre.sh, regla GIT-C5): con una forma legible pide la
 * firma `escape:merge-bypass` en la ventana de permiso; con una forma escondida frena sin ventana.
 *
 * POR QUÉ EXISTE. La cuenta con que trabaja el agente puede ser administradora del repo: GitHub le deja saltear la cola
 * con `gh pr merge --admin`, mergear o cambiar las reglas por la API, y Azure DevOps le deja apagar una política o darse
 * el permiso de saltearla. Con eso la CI y la constancia de los controles dejan de ser la segunda llave.
 *
 * LAS FORMAS (todas piden la misma firma):
 *   · admin-merge: `gh pr merge … --admin` (o `--admin=<verdadero>`), también con el repo entre el grupo y el verbo
 *     (`gh pr -R <d>/<r> merge …`).
 *   · api-merge: `gh api` que escribe sobre `repos/<d>/<r>/pulls/<n>/merge` o `repos/<d>/<r>/merges` (mergear una rama
 *     en otra), que mueve una rama (PATCH sobre `repos/<d>/<r>/git/refs/heads/<rama>`), o `graphql` con
 *     `mergePullRequest`, `mergeBranch`, `updateRef` o `updateRefs`.
 *   · api-rules: `gh api` que escribe sobre una regla (`repos/<d>/<r>/rulesets`, `orgs/<o>/rulesets`) o la protección de
 *     una rama (`repos/<d>/<r>/branches/<rama>/protection…`), o `graphql` con una mutación de reglas o de protección.
 *   · az-bypass: `az repos pr update|create --bypass-policy` cierto; `az repos policy … create|update|delete`;
 *     `az devops security permission update` con los bits 128, 32768, 2048 u 8192 (o un `--allow-bit` que no se lee);
 *     `az rest` o `az devops invoke` que escriben sobre pedidos, políticas o permisos. Vale igual con la ruta completa
 *     del programa y con `python -m azure.cli`.
 * Escribe = método PUT, POST, PATCH o DELETE (`-X PUT`, `-XPUT`, `-X=PUT`, `-iX PUT`, `--method=PUT`); en `gh api`,
 * también un campo (`-f`, `-F`, `--field`, `--raw-field`) o `--input` sin método, que lo vuelven POST.
 *
 * LO ESCONDIDO (`legible: false`): lo que este lector no entiende entero, en un comando con la forma. Una forma que
 * corre adentro de `bash -c`, `sh -c`, `su -c`, `eval`, `$(…)` o comillas invertidas; con el programa en una variable;
 * que lanza `xargs`, `watch`, `parallel`, `find -exec` o cualquier programa que no es una de las envolturas de abajo
 * (`arch`, `flock`, `sudo -E`…); un cuerpo que no se lee (`--body @archivo`, `--in-file`, `--input` en una consulta); o
 * una palabra que arma la terminal donde puede ir la forma (el verbo, el método, la ruta, el número del pedido). Las
 * envolturas que corren el mismo comando con los mismos argumentos (`sudo`, `env`, `time`, `nohup`, `timeout`, `nice`,
 * las palabras de un `if` o un bucle) no esconden nada.
 *
 * LO QUE NO ES UNA FORMA: leer (la regla, la protección, los permisos, las políticas), el camino normal
 * (`gh pr merge --merge|--auto`, encolar con `enqueuePullRequest` aunque el id vaya por una variable de GraphQL,
 * `--bypass-policy false`), y nombrar un comando sin correrlo (`echo`, `grep`, el mensaje de un commit, un texto armado
 * con `$(cat <<'EOF' … EOF)`).
 *
 * USO
 *   require('./ci-bypass.js').leer(comando, { powershell }) → [{ forma, firma, legible, motivo }]
 *   node ci-bypass.js --command-stdin [--windows-shell]   (el comando por la entrada) → un renglón por hallazgo:
 *     `forma=<forma>` o `escondido=<motivo>`. Sale 0 si leyó el comando; distinto de 0 si no pudo. `--windows-shell`: el
 *     comando lo escribió la herramienta de PowerShell (la barra invertida es parte de las rutas).
 */

const gh = require('./gh-pr.js');
const az = require('./az-pr.js');

const FIRMA = 'escape:merge-bypass';
const ESCRIBE = /^(put|post|patch|delete)$/i;
// las envolturas que corren el mismo comando con los mismos argumentos: la forma se lee entera
const ENVUELVE_IGUAL = new Set(['timeout', 'nice', 'stdbuf', 'caffeinate', 'doas', '!', '{', 'if', 'elif', 'then', 'else', 'while', 'until', 'do']);
// los programas que sólo NOMBRAN el comando que los sigue (lo imprimen, lo buscan, lo instalan): no lo corren
const SOLO_NOMBRA = new Set(['echo', 'printf', 'print', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'git', 'man',
  'tldr', 'info', 'which', 'whereis', 'type', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'winget', 'choco', 'scoop', 'cat',
  'less', 'more', 'head', 'tail', 'sed', 'awk', 'jq', 'yq', 'wc', 'sort', 'uniq', 'cut', 'tr', 'ls', 'test', '[', '[[',
  'write-host', 'write-output', 'select-string', 'get-command', 'get-help']);

const legible = (forma, motivo) => ({ forma, firma: FIRMA, legible: true, motivo });
const escondido = (motivo, forma = null) => ({ forma, firma: FIRMA, legible: false, motivo });
const sinComillas = (t) => String(t).replace(/["'\\]/g, '');
// el nombre de un programa sin su carpeta ni su extensión (`C:\tools\gh.exe` → `gh`)
const nombreDe = (t) => String(t || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/, '');

// --- gh ---------------------------------------------------------------------------------------------------------------

const MUTACION_MERGE = /\b(mergePullRequest|mergeBranch|updateRefs?)\b/;
const MUTACION_REGLAS = /\b(createRepositoryRuleset|updateRepositoryRuleset|deleteRepositoryRuleset|updateBranchProtectionRule|deleteBranchProtectionRule|createBranchProtectionRule)\b/;
const RUTA_MERGE = /(^|\/)repos\/[^/\s]+\/[^/\s]+\/(pulls\/[^/\s]+\/merge|merges)\/?(\?|$)/i;
const RUTA_RAMA = /(^|\/)repos\/[^/\s]+\/[^/\s]+\/git\/refs\/heads\/[^\s?]+/i;
const RUTA_REGLAS = /(^|\/)(repos\/[^/\s]+\/[^/\s]+|orgs\/[^/\s]+)\/rulesets(\/|\?|$)|(^|\/)repos\/[^/\s]+\/[^/\s]+\/branches\/[^\s]+\/protection(\/|\?|$)/i;
// una ruta que arma la terminal y puede ser una de las de arriba: empieza o termina con una variable, o nombra una parte
const RUTA_ARMADA_SENSIBLE = /^\$|\$[^/]*$|\/(pulls|branches)\/|\/merges?(\/|\?|$)|rulesets|protection|git\/refs/i;
// Lo que delata la forma en un texto que el lector NO lee entero (`bash -c`, `eval`, una sustitución, una variable, un
// alias): una red gruesa de palabras, no la ortografía exacta. Cualquier escritura de `gh api` con una parte de la forma,
// o un `--admin` que no sea falso, frena. Sólo pruebas sueltas sin cuantificadores anidados: lineal con cualquier texto.
const ESCRIBE_GH = /-[a-zA-Z]*X|--method|(^|\s)-[fF](\s|\S)|--(raw-)?field|--input|\bmutation\b/;
// Una escritura de `gh api` escondida frena con una parte de la forma o con lo que no se lee: una ruta de pedidos o de
// ramas, una consulta GraphQL, un valor que arma la terminal (`$`), un archivo (`@`) o `--input`.
const ghEnTexto = (t) => /--admin(?!\s*=\s*(false|no|0)\b)/i.test(t)
  || (/\bapi\b/i.test(t) && ESCRIBE_GH.test(t)
    && /merge|rulesets|protection|git\/refs|updateRef|RepositoryRuleset|BranchProtection|pulls|branches|graphql|\$|@|--input/i.test(t));
// las opciones de `gh pr merge` que llevan valor: su valor no es el pedido ni puede ser `--admin`
const MERGE_CON_VALOR = new Set(['--subject', '-t', '--body', '-b', '--body-file', '-F', '--match-head-commit', '--author-email', '-A', '--repo', '-R']);
const API_CAMPO = new Set(['-f', '--raw-field', '-F', '--field']);
const API_CON_VALOR = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
const ADMIN_CIERTO = /^--admin(=(true|t|yes|y|1))?$/i;
// el largo máximo de una ruta de `gh api` que se lee con regex (una de verdad tiene decenas de caracteres)
const TOPE_RUTA = 2048;

/** `gh pr merge`: la forma, o null. `ps`: las palabras desde el grupo. */
function deMerge(ps) {
  const k0 = ps.findIndex((p, k) => k >= 1 && p.literal && p.texto === 'merge');
  if (k0 < 0) return null;
  let admin = false;
  for (let k = k0 + 1; k < ps.length; k += 1) {
    const p = ps[k];
    if (!p.literal) {
      // `--subject="$T"`: el valor de una opción con nombre no se vuelve otra opción
      if (/^--[A-Za-z][\w-]*=/.test(p.texto)) continue;
      // gh acepta las opciones en cualquier lugar: una palabra que arma la terminal (también el número) puede ser --admin
      return escondido('una palabra de `gh pr merge` la arma la terminal y puede ser --admin: escribila tal cual, también el número del pedido', 'admin-merge');
    }
    if (ADMIN_CIERTO.test(p.texto)) { admin = true; continue; }
    if (MERGE_CON_VALOR.has(p.texto)) k += 1;
  }
  return admin ? legible('admin-merge', 'gh pr merge con --admin saltea la cola y la CI de main') : null;
}

/** La clave de un campo de `gh api` (`query=…` → `query`), o null si no se ve. */
const claveDe = (v) => { const m = /^([A-Za-z_][\w[\]]*)=/.exec(String(v.texto)); return m ? m[1] : null; };

/** `gh api`: la forma, o null. */
function deApi(ps) {
  let metodo = null;
  let metodoIlegible = false;
  let campos = false;
  let entrada = null;
  const valores = [];
  const sueltas = [];
  const metodoDe = (k) => { const v = ps[k + 1]; if (v && v.literal) metodo = v.texto; else metodoIlegible = true; };
  for (let k = 1; k < ps.length; k += 1) {
    const p = ps[k];
    const t = p.texto;
    if (!p.literal) {
      // el valor de una opción con nombre (`--field=x=$V`): sigue siendo de esa opción
      if (/^--(raw-field|field)=/.test(t)) { campos = true; valores.push({ texto: t.replace(/^--(raw-field|field)=/, ''), literal: false, archivo: t.startsWith('--field') }); continue; }
      if (/^--method=/.test(t)) { metodoIlegible = true; continue; }
      if (/^--input=/.test(t)) { entrada = { texto: t.slice(8), literal: false }; continue; }
      if (/^--[A-Za-z][\w-]*=/.test(t)) continue;
      sueltas.push(p);
      continue;
    }
    if (t === '-X' || t === '--method') { metodoDe(k); k += 1; continue; }
    // `-XPUT`, `-X=PUT`, `-iX PUT`, `-iXPUT`: gh acepta el método pegado y junto con `-i`
    const corta = /^-i*X=?(.*)$/.exec(t);
    if (corta) { if (corta[1]) metodo = corta[1]; else { metodoDe(k); k += 1; } continue; }
    if (/^--method=/.test(t)) { metodo = t.slice(9); continue; }
    if (API_CAMPO.has(t)) { const v = ps[k + 1]; k += 1; campos = true; if (v) valores.push({ ...v, archivo: t === '-F' || t === '--field' }); continue; }
    if (/^(-f|-F)./.test(t)) { campos = true; valores.push({ texto: t.slice(2), literal: true, archivo: t.startsWith('-F') }); continue; }
    if (/^--(raw-field|field)=/.test(t)) { campos = true; valores.push({ texto: t.replace(/^--(raw-field|field)=/, ''), literal: true, archivo: t.startsWith('--field') }); continue; }
    if (t === '--input') { entrada = ps[k + 1] || { texto: '', literal: false }; k += 1; continue; }
    if (/^--input=/.test(t)) { entrada = { texto: t.slice(8), literal: true }; continue; }
    if (API_CON_VALOR.has(t)) { k += 1; continue; }
    if (/^-/.test(t)) continue;
    sueltas.push(p);
  }
  const ruta = sueltas.find((p) => p.literal) || sueltas[0] || null;
  if (!ruta) return null;
  // otra palabra suelta que arma la terminal: puede ser el método (`-X DELETE`), un campo o la ruta misma
  const otraArmada = sueltas.some((p) => p !== ruta && !p.literal);
  const escribe = metodoIlegible || otraArmada || (metodo ? ESCRIBE.test(metodo) : (campos || entrada !== null));
  if (!escribe) return null;
  if (ruta.literal && /^\/?graphql$/i.test(ruta.texto)) {
    if (otraArmada) return escondido('una palabra de `gh api graphql` la arma la terminal: escribila tal cual', 'api-merge');
    const textos = valores.map((v) => v.texto).join('\n');
    if (MUTACION_MERGE.test(textos)) return legible('api-merge', 'mergear o mover una rama por la API saltea la cola y la CI de main');
    if (MUTACION_REGLAS.test(textos)) return legible('api-rules', 'cambiar las reglas o la protección de una rama por la API saltea la CI de main');
    // la consulta que no se lee: armada por la terminal, leída de un archivo o por la entrada. Los otros campos son
    // variables de GraphQL: no vuelven una lectura en una mutación
    const ilegible = entrada !== null || valores.some((v) => {
      const clave = claveDe(v);
      if (clave === null) return true;
      return clave === 'query' && (!v.literal || (v.archivo && /^query=@/.test(v.texto)));
    });
    return ilegible ? escondido('la consulta de `gh api graphql` no se puede leer (la arma la terminal o sale de un archivo): escribila tal cual', 'api-merge') : null;
  }
  const r = ruta.texto;
  // una ruta enorme no pasa por las regex de ruta (con una armada, su tiempo crece con el cuadrado del largo): frena
  if (r.length > TOPE_RUTA) return escondido('la ruta de `gh api` que escribe es demasiado larga para leerla: escribila tal cual', 'api-merge');
  const sensible = ruta.literal ? (RUTA_MERGE.test(r) || RUTA_REGLAS.test(r) || RUTA_RAMA.test(r)) : RUTA_ARMADA_SENSIBLE.test(r);
  if (!sensible) return null;
  if (!ruta.literal || otraArmada || metodoIlegible) return escondido('una palabra de `gh api` que escribe la arma la terminal (el método o la ruta): escribila tal cual', 'api-merge');
  if (RUTA_MERGE.test(r)) return legible('api-merge', 'mergear por la API saltea la cola y la CI de main');
  if (RUTA_REGLAS.test(r)) return legible('api-rules', 'cambiar las reglas o la protección de una rama por la API saltea la CI de main');
  // mover una rama es PATCH; crearla (POST) o borrarla (DELETE) no hace entrar nada a main
  if (/^patch$/i.test(metodo || '')) return legible('api-merge', 'mover una rama por la API saltea la cola y la CI de main');
  return null;
}

function formaDeGh(c) {
  const ps = c.palabras || [];
  const verbo = c.verbo || c.verboTrasOpciones;
  if (c.grupo === 'pr' && verbo === 'merge') return deMerge(ps);
  // el verbo lo arma la terminal y la línea trae --admin: puede ser `merge`
  if (c.grupo === 'pr' && ps[1] && !ps[1].literal && ps.some((p) => p.literal && ADMIN_CIERTO.test(p.texto))) {
    return escondido('el verbo de `gh pr` lo arma la terminal y el comando trae --admin: escribilo tal cual', 'admin-merge');
  }
  if (c.grupo === 'api') return deApi(ps);
  return null;
}

function deGh(cmd, opts) {
  if (!gh.pareceGh(cmd)) return [];
  const texto = sinComillas(cmd);
  const out = [];
  for (const c of gh.comandosGh(cmd, 0, opts)) {
    const palabras = c.palabras || [];
    // sin grupo legible (`gh $G merge …`, adentro de otro intérprete): lo delata el texto
    if (c.grupo === null) {
      if ((c.ilegible.length || palabras.some((p) => !p.literal)) && ghEnTexto(texto)) {
        out.push(escondido(`${c.ilegible[0] || 'el grupo de `gh` lo arma la terminal'}: escribí el comando en su forma exacta, solo`));
      }
      continue;
    }
    // Un alias de gh que guarda la forma (`gh alias set m 'pr merge --admin'`, también la de `az` en un alias de la
    // terminal): el `gh m` que sigue la corre sin nombrarla. Uno que arma la terminal, o los que se importan de un archivo
    // (`gh alias import`), no se leen: frenan igual.
    const deAlias = c.grupo === 'alias' ? (c.verbo || c.verboTrasOpciones) : null;
    if (deAlias === 'import') {
      out.push(escondido('importa alias de `gh` que este freno no lee: definilos de a uno, con `gh alias set`'));
      continue;
    }
    if (deAlias === 'set') {
      const guardado = sinComillas(palabras.map((p) => p.texto).join(' '));
      if (palabras.some((p) => !p.literal) || ghEnTexto(guardado) || azEnTexto(guardado)) {
        out.push(escondido('define un alias de `gh` con la forma, o con un texto que arma la terminal: el comando que lo usa no la nombra. Corré el comando en su forma exacta, solo'));
      }
      continue;
    }
    // `echo gh …`, `grep … gh`, `brew install gh`: lo nombra, no lo corre
    const lanzador = nombreDe(c.lanzadoPor);
    if (c.porOtroPrograma && !c.loLanzaOtro && SOLO_NOMBRA.has(lanzador)) continue;
    const f = formaDeGh(c);
    const cortado = c.ilegible.find((m) => m !== gh.ARMADO);
    if (!f) {
      // el comando se cortó en una sustitución (`gh pr merge $(…) --admin`): lo que sigue no se leyó
      const conForma = c.grupo === 'api' || (c.grupo === 'pr' && (c.verbo || c.verboTrasOpciones || 'merge') === 'merge');
      if (cortado && conForma && ghEnTexto(texto)) out.push(escondido(`${cortado}: escribí el comando en su forma exacta, solo`));
      continue;
    }
    if (!f.legible) { out.push(f); continue; }
    if (c.enSustitucion) out.push(escondido('corre adentro de una sustitución `$(…)`: escribí el comando en su forma exacta, solo', f.forma));
    else if (c.porOtroPrograma && !c.loLanzaOtro) out.push(escondido(`lo corre ${c.lanzadoPor || 'otro programa'}, que este freno no conoce: escribí el comando en su forma exacta, solo`, f.forma));
    else if (c.loLanzaOtro && !ENVUELVE_IGUAL.has(lanzador)) out.push(escondido(`lo lanza ${c.lanzadoPor || 'otro programa'}, que puede cambiarle los argumentos: escribí el comando en su forma exacta, solo`, f.forma));
    else if (cortado) out.push(escondido(`${cortado}: escribí el comando en su forma exacta, solo`, f.forma));
    else out.push(f);
  }
  return out;
}

// --- az ---------------------------------------------------------------------------------------------------------------

const AZ = /(^|\/|\\)az(\.cmd|\.exe)?$/i;
const PYTHON = /(^|\/|\\)py(thon)?(\d+(\.\d+)?)?(\.exe)?$/i;
const BITS = 128 | 32768 | 2048 | 8192;
const RECURSO_AZ = /pullrequests|policy\/configurations|accesscontrolentries|accesscontrollists/i;
const RECURSO_INVOKE = /^(pullrequests|configurations|accesscontrolentries|accesscontrollists)$/i;
// las opciones de az que deciden una forma: az acepta su prefijo único, y el lector las lleva a su nombre entero
const OPCIONES_AZ = ['method', 'http-method', 'uri', 'url', 'body', 'in-file', 'resource', 'allow-bit', 'bypass-policy'];
// La red gruesa de `az` en un texto que el lector no lee entero (ver `ghEnTexto`): el programa junto con una parte de una
// forma, escrita como sea (abreviada, con `=`, partida en renglones). Lineal con cualquier texto.
// `--bypass-policy` también abreviado (`--bypass-pol`), salvo su motivo (`--bypass-policy-reason`) o un valor falso
const salteaPoliticas = (t) => [...t.matchAll(/--bypass-p([a-z-]*)\s*=?\s*(\S*)/gi)]
  .some((m) => !/^olicy-/i.test(m[1]) && !/^(false|no|0)$/i.test(m[2]));
const azEnTexto = (t) => /\baz\b|azure\.cli/i.test(t) && (
  salteaPoliticas(t)
  || (/(?<![\w-])policy\b/i.test(t) && /\b(create|update|delete)\b/i.test(t))   // `policy` suelto, no el de --bypass-policy
  || (/\bpermission\b/i.test(t) && /\bupdate\b/i.test(t))
  || (/\b(rest|invoke)\b/i.test(t) && /\b(put|post|patch|delete)\b/i.test(t)));
const MISMO_PROGRAMA = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'builtin', ...ENVUELVE_IGUAL]);
const LANZA_OTRO = new Set(['xargs', 'watch', 'parallel']);
// `su` le pasa sus argumentos a una terminal: lo que corre va en un texto
const INTERPRETE = /(^|\/|\\)((ba|z|k|da)?sh|pwsh|powershell)(\.exe)?$|^(eval|source|\.|su)$/i;
const PREFIJO_CON_VALOR = new Set(['-n', '-s', '-k', '-u', '-g', '-C']);
// la duración de `timeout`, también con decimales (`1.5`, `0.5m`)
const DURACION = /^\d+(\.\d+)?[smhd]?$/;
// una sustitución que sólo arma un texto (`$(cat <<'EOF' … EOF)`, `$(echo …)`): no corre lo que nombra
const SOLO_DATOS = /^\s*(cat|echo|printf)\b/;

/** Las opciones abreviadas de `OPCIONES_AZ` con su nombre entero (`--meth` → `--method`); las demás, como vienen. */
function nombresEnteros(fichas) {
  return fichas.map((f) => {
    const m = f.esBandera && !f.expande ? /^--([a-z][a-z-]*)(=[\s\S]*)?$/i.exec(f.texto) : null;
    if (!m) return f;
    const n = m[1].toLowerCase();
    const enteras = OPCIONES_AZ.filter((o) => o.startsWith(n));
    return enteras.length === 1 && enteras[0] !== n ? { ...f, texto: `--${enteras[0]}${m[2] || ''}` } : f;
  });
}

/** La forma de un `az` a la vista: `seg` es el segmento entero, `i` el índice del programa. */
function formaDeAz(seg, i) {
  const resto = nombresEnteros(seg.slice(i + 1));
  const pos = [];
  for (const f of resto) { if (f.expande || /^-/.test(f.texto)) break; pos.push(f.texto.toLowerCase()); }
  const v = (nombre, corta = null) => az.valorDe(resto, nombre, corta);
  const [a, b] = pos;
  if (a === 'repos' && b === 'pr' && (pos[2] === 'update' || pos[2] === 'create')) {
    const bp = v('bypass-policy');
    if (bp === null || az.esFalso(bp.texto)) return null;
    if (az.esCierto(bp.texto) && bp.literal) return legible('az-bypass', 'completar el pedido salteando las políticas de la rama');
    return escondido('el valor de --bypass-policy no se puede leer: escribilo tal cual', 'az-bypass');
  }
  if (a === 'repos' && b === 'policy' && pos.slice(2, 4).some((x) => ['create', 'update', 'delete'].includes(x))) {
    return legible('az-bypass', 'crear, cambiar o borrar una política de la rama');
  }
  if (a === 'devops' && b === 'security' && pos[2] === 'permission' && pos[3] === 'update') {
    const bit = v('allow-bit');
    if (bit === null) return null;
    const n = bit.literal && /^\d+$/.test(bit.texto) ? Number(bit.texto) : NaN;
    if (Number.isNaN(n) || (n & BITS) !== 0) return legible('az-bypass', 'darse el permiso de saltear o de cambiar las políticas o los permisos');
    return null;
  }
  if (a === 'rest') {
    const m = v('method', 'm');
    const escribe = m !== null && (!m.literal || ESCRIBE.test(m.texto));
    if (!escribe) return null;
    const uri = v('uri', 'u') || v('url');
    if (!uri) return null;
    const sensible = RECURSO_AZ.test(uri.texto);
    if (!uri.literal && !sensible) {
      return /^\$|dev\.azure\.com|visualstudio\.com|_apis/i.test(uri.texto) ? escondido('la dirección de `az rest` que escribe la arma la terminal: escribila tal cual', 'az-bypass') : null;
    }
    if (!sensible) return null;
    const cuerpo = v('body', 'b');
    if (cuerpo && !cuerpo.literal) return escondido('el cuerpo de `az rest` no se puede leer (sale de un archivo o lo arma la terminal): escribilo tal cual', 'az-bypass');
    return legible('az-bypass', 'escribir por la API sobre un pedido, las políticas o los permisos');
  }
  if (a === 'devops' && b === 'invoke') {
    const m = v('http-method');
    const escribe = m !== null && (!m.literal || ESCRIBE.test(m.texto));
    if (!escribe) return null;
    const recurso = v('resource');
    if (!recurso || (recurso.literal && !RECURSO_INVOKE.test(recurso.texto))) return null;
    if (resto.some((f) => f.esBandera && /^--in-file(=|$)/.test(f.texto))) return escondido('el cuerpo de `az devops invoke` sale de un archivo (--in-file) y no se puede leer', 'az-bypass');
    return legible('az-bypass', 'escribir por la API sobre un pedido, las políticas o los permisos');
  }
  return null;
}

/** El índice del programa de un segmento, salteando asignaciones y envolturas que corren el mismo programa. */
function programa(seg) {
  let k = 0;
  while (k < seg.length) {
    const f = seg[k];
    if (!f.expande && /^[A-Za-z_][A-Za-z0-9_]*=/.test(f.texto)) { k += 1; continue; }
    const t = String(f.texto).toLowerCase();
    if (!f.expande && MISMO_PROGRAMA.has(t)) {
      k += 1;
      // sus opciones (y la duración de `timeout`)
      while (k < seg.length && !seg[k].expande && (/^-/.test(seg[k].texto) || DURACION.test(seg[k].texto) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[k].texto))) {
        k += PREFIJO_CON_VALOR.has(seg[k].texto) ? 2 : 1;
      }
      continue;
    }
    return k;
  }
  return -1;
}

/** Lo de adentro de cada `$(…)` y de cada par de comillas invertidas de un texto, salvo lo que sólo arma un texto. */
function corriendoAdentro(texto) {
  const s = String(texto);
  const out = [];
  for (let k = 0; k < s.length; k += 1) {
    if (s[k] === '$' && s[k + 1] === '(') {
      let hondo = 0;
      let j = k + 1;
      for (; j < s.length; j += 1) {
        if (s[j] === '(') hondo += 1;
        else if (s[j] === ')') { hondo -= 1; if (hondo === 0) break; }
      }
      out.push(s.slice(k + 2, j));
      k = j;
    } else if (s[k] === '`') {
      const j = s.indexOf('`', k + 1);
      out.push(s.slice(k + 1, j < 0 ? s.length : j));
      k = j < 0 ? s.length : j;
    }
  }
  return out.filter((x) => !SOLO_DATOS.test(x));
}

function deAz(cmd, opts) {
  if (!/\baz\b|\bgh\b|azure\.cli|bypass-policy|repos\s+policy|security\s+permission|devops\s+invoke|\brest\b/i.test(cmd)) return [];
  const out = [];
  for (const seg of az.segmentos(cmd, opts)) {
    if (!seg.length) continue;
    // una sustitución que corre una forma
    if (seg.some((f) => f.expande && corriendoAdentro(f.texto).some((t) => azEnTexto(sinComillas(t))))) {
      out.push(escondido('corre adentro de una sustitución: escribí el comando en su forma exacta, solo', 'az-bypass'));
      continue;
    }
    const i = programa(seg);
    if (i < 0) continue;
    const p = seg[i];
    const nombre = String(p.texto).toLowerCase();
    // el programa, también con su ruta completa entre comillas (`"C:\Program Files\…\az.cmd"`)
    if (!p.expande && AZ.test(p.texto)) {
      const f = formaDeAz(seg, i);
      if (f) out.push(f);
      continue;
    }
    // el mismo programa por Python: `python -m azure.cli …`
    if (!p.expande && PYTHON.test(p.texto)) {
      const m = seg.findIndex((f, k) => k > i && !f.expande && f.texto === '-m' && seg[k + 1] && /^azure\.cli$/i.test(seg[k + 1].texto));
      if (m > 0) {
        const f = formaDeAz(seg, m + 1);
        if (f) out.push(f);
        continue;
      }
    }
    const texto = sinComillas(seg.slice(i + 1).map((f) => f.texto).join(' '));
    // el programa en una variable, con lo que sigue en la forma de una de las de arriba
    if (p.expande) {
      if (azEnTexto(`az ${texto}`)) out.push(escondido('el programa llega por una variable: escribí el comando en su forma exacta, solo', 'az-bypass'));
      continue;
    }
    // una terminal, `eval`, `su` o un intérprete con el comando en un texto; o `xargs`, que le agrega argumentos. La red
    // gruesa mira acá también `gh`: el lector de gh-pr.js sólo marca lo escondido que publica, y una escritura de
    // `gh api` con una consulta en un archivo no la ve como tal
    if (INTERPRETE.test(nombre) || LANZA_OTRO.has(nombre)) {
      const deGhAdentro = /\bgh\b/i.test(texto) && ghEnTexto(texto);
      if (azEnTexto(texto) || deGhAdentro) out.push(escondido(`lo corre ${p.texto} adentro de un texto o con otros argumentos: escribí el comando en su forma exacta, solo`, deGhAdentro ? null : 'az-bypass'));
      continue;
    }
    // otro programa con un `az` suelto más adelante: si sólo lo nombra, pasa; si no, puede correrlo (`arch`, `flock`)
    if (SOLO_NOMBRA.has(nombreDe(p.texto))) continue;
    const j = seg.findIndex((f, k) => k > i && f.esBandera && !f.expande && AZ.test(f.texto));
    if (j > 0 && formaDeAz(seg, j)) out.push(escondido(`lo corre ${p.texto}, que este freno no conoce: escribí el comando en su forma exacta, solo`, 'az-bypass'));
  }
  return out;
}

/** Todo lo que el comando saltea, en orden: primero `gh`, después `az`. `powershell`: lo escribió esa herramienta. */
function leer(cmd, { powershell = false } = {}) {
  const texto = String(cmd || '');
  const opts = powershell ? { powershell: true } : {};
  return [...deGh(texto, opts), ...deAz(texto, opts)];
}

module.exports = { leer, FIRMA };

if (require.main === module) {
  if (!process.argv.includes('--command-stdin')) {
    process.stderr.write('uso: node ci-bypass.js --command-stdin [--windows-shell]   (el comando por la entrada)\n');
    process.exit(2);
  }
  let entrada = '';
  try { entrada = require('fs').readFileSync(0, 'utf8'); } catch (e) { process.stderr.write(`no pude leer la entrada (${e.code || e.message})\n`); process.exit(3); }
  const una = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  for (const h of leer(entrada, { powershell: process.argv.includes('--windows-shell') })) {
    process.stdout.write(h.legible ? `forma=${h.forma}\n` : `escondido=${una(h.motivo)}\n`);
  }
}
