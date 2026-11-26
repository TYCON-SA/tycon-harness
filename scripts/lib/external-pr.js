'use strict';
/**
 * external-pr.js — un pedido de alguien de afuera del equipo no se encola ni se mergea sin la firma del dueño. Lo usa el
 * freno de la sesión (scripts/hooks/safety-guard-pre.sh, regla GIT-C7): con un pedido de afuera pide la firma
 * `escape:external-pr` en la ventana de permiso; si no puede saber de quién es el pedido, frena.
 *
 * POR QUÉ EXISTE. Un repo público recibe pedidos desde forks. La rama principal no exige una aprobación (la regla de
 * GitHub frenaría también los pedidos del equipo, que abre la cuenta del dueño, y su excepción la usarían igual las
 * sesiones): lo único que separa el pedido de afuera de main es que nadie lo encole. Este freno lo hace explícito.
 *
 * LAS FORMAS: `gh pr merge <n>` (con y sin `--auto`; también con la dirección del pedido), `gh api graphql` con
 * `enqueuePullRequest`, `enablePullRequestAutoMerge` o `mergePullRequest`, y `gh api` que escribe sobre
 * `repos/<d>/<r>/pulls/<n>/merge`. `gh pr merge --disable-auto` no encola nada: no es una forma.
 *
 * QUIÉN ES DEL EQUIPO: la lista `pull_requests.team_authors` del perfil del equipo (tycon-config.js), y sólo ella. Un bot es de
 * afuera salvo que esté en la lista (`app/<nombre>`). Sin lista, es del equipo
 * sólo la cuenta con la que el CLI está autenticado en la máquina (la que abre los pedidos del equipo); si no se puede
 * leer, frena.
 *
 * LO QUE FRENA SIN VENTANA («no sé de quién es» nunca deja pasar): una forma que no se lee entera (el número o el repo
 * los arma la terminal, corre adentro de otro programa), un `gh pr merge` sin número, un pedido sin repo después de un
 * `cd`, la configuración rota, y un `gh` que no contesta (sin red, sin sesión) o que contesta algo que no se lee.
 *
 * USO
 *   require('./external-pr.js').leer(comando) → [{ repo, numero } | { repo, id } | { ilegible }]
 *   require('./external-pr.js').decidir(comando, { cwd, home, env, run }) → { firmas: [detalle…] } | { frena } | null
 *   node external-pr.js --event-stdin   (el evento del gancho por la entrada) → `firma=<detalle>` o `frena=<motivo>`,
 *     un renglón cada uno; nada si no hay forma. Sale 0 si leyó el evento.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const gh = require('./command-readers.js').lectorDe('gh');

const FIRMA = 'escape:external-pr';
const MUTACION = /\b(enqueuePullRequest|enablePullRequestAutoMerge|mergePullRequest)\b/;
const RUTA_MERGE = /^\/?repos\/([^/\s]+\/[^/\s]+)\/pulls\/(\d+)\/merge\/?$/i;
const DIRECCION = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/i;
// la red gruesa: un texto que nombra una forma, aunque el lector no la encuentre entera
const EN_TEXTO = /merge|enqueuePullRequest/i;
const ESCRIBE = /^(put|post|patch|delete)$/i;
// los verbos de pedidos que sólo leen: la red gruesa no cuenta la palabra «merge» de su --json o su --jq
const VERBOS_QUE_LEEN = new Set(['view', 'list', 'status', 'checks', 'diff']);
const MERGE_CON_VALOR = new Set(['--subject', '-t', '--body', '-b', '--body-file', '-F', '--match-head-commit', '--author-email', '-A', '--repo', '-R']);
const API_CAMPO = new Set(['-f', '--raw-field', '-F', '--field']);
const TIEMPO_GH_MS = 6000;
// lo que cambia la cuenta con que corre el CLI: su grupo `auth` o una variable de su llave o de su configuración
const CAMBIA_CUENTA = /\bauth\s+(switch|login|logout|refresh|setup-git|token)\b|\b(GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\s*=/;
// los programas que sólo NOMBRAN el comando que los sigue (lo imprimen o lo buscan): no lo corren (como ci-bypass.js)
const SOLO_NOMBRA = new Set(['echo', 'printf', 'print', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'git', 'man', 'which', 'type', 'cat',
  'less', 'head', 'tail', 'sed', 'awk', 'jq', 'wc', 'sort', 'cut', 'tr', 'ls', 'test', 'write-host', 'write-output', 'select-string']);
const PALABRAS_DE_LA_TERMINAL = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '{', '!']);
const nombreDe = (t) => String(t || '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/, '');

/**
 * El repo del comando: `-R`/`--repo` o `GH_REPO` (`{ repo }`), o la carpeta desde donde corre (`{ repo: null, carpeta }`,
 * la del último `cd` literal, o null para la de la sesión). Lo que no se sabe es `{ ilegible }`: el repo o la carpeta
 * que arma la terminal, otro servidor (`GH_HOST`, `--hostname`), o un `gh repo set-default` en la misma línea (cambia el
 * repo de la carpeta después de que el freno preguntó).
 */
function repoDe(c, cmd) {
  if (c.repoDesconocido) return { ilegible: 'el repo lo arma la terminal: escribí -R <organización>/<repo> tal cual' };
  if (/\bGH_HOST\b|--hostname\b|\bGH_ENTERPRISE_TOKEN\b/.test(cmd)) return { ilegible: 'el comando cambia el servidor de GitHub: este freno sólo pregunta al de siempre' };
  if (c.repo) return { repo: c.repo };
  if (/\brepo\s+set-default\b/.test(cmd)) return { ilegible: 'cambia el repo de la carpeta en la misma línea: agregale -R <organización>/<repo> al merge' };
  if (c.cdIncierto || c.cwdDesconocido) return { ilegible: 'cambia a una carpeta que arma la terminal y no dice el repo: agregale -R <organización>/<repo>' };
  const cds = c.cds || [];
  return { repo: null, carpeta: cds.length ? cds[cds.length - 1] : null };
}

/** `gh pr merge`: el pedido, o null si no encola nada. */
function deMerge(ps, c, cmd) {
  const k0 = ps.findIndex((p, k) => k >= 1 && p.literal && p.texto === 'merge');
  let sel = null;
  for (let k = k0 + 1; k < ps.length; k += 1) {
    const p = ps[k];
    if (!p.literal) return { ilegible: 'una palabra de `gh pr merge` la arma la terminal: escribí el número del pedido tal cual' };
    if (p.texto === '--disable-auto') return null;
    if (MERGE_CON_VALOR.has(p.texto)) { k += 1; continue; }
    if (p.texto.startsWith('-')) continue;
    if (sel === null) sel = p.texto;
  }
  if (sel === null) return { ilegible: '`gh pr merge` sin el número del pedido: escribilo, así se sabe de quién es' };
  const d = DIRECCION.exec(sel);
  if (d) return { repo: d[1], numero: Number(d[2]) };
  if (!/^#?\d+$/.test(sel) || Number(sel.replace(/^#/, '')) < 1) return { ilegible: `«${sel}» no es el número de un pedido: escribí el número` };
  const r = repoDe(c, cmd);
  return r.ilegible ? r : { repo: r.repo, carpeta: r.carpeta, numero: Number(sel.replace(/^#/, '')) };
}

/** `gh api`: el pedido de una mutación o de la ruta de merge, o null si no es una forma. */
function deApi(ps, c, cmd) {
  const valores = [];
  const sueltas = [];
  let metodo = null;
  for (let k = 1; k < ps.length; k += 1) {
    const p = ps[k];
    const t = p.texto;
    if (p.literal && API_CAMPO.has(t)) { const v = ps[k + 1]; k += 1; if (v) valores.push(v); continue; }
    if (p.literal && /^(-f|-F)./.test(t)) { valores.push({ texto: t.slice(2), literal: true }); continue; }
    if (/^--(raw-field|field)=/.test(t)) { valores.push({ texto: t.replace(/^--(raw-field|field)=/, ''), literal: p.literal }); continue; }
    if (p.literal && (t === '-X' || t === '--method')) { const v = ps[k + 1]; k += 1; metodo = v && v.literal ? v.texto : '?'; continue; }
    if (p.literal && /^-i*X./.test(t)) { metodo = t.replace(/^-i*X=?/, ''); continue; }
    if (/^--method=/.test(t)) { metodo = p.literal ? t.slice(9) : '?'; continue; }
    if (p.literal && /^-/.test(t)) { if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--input', '-p', '--preview', '--cache'].includes(t)) k += 1; continue; }
    sueltas.push(p);
  }
  const ruta = sueltas[0];
  if (!ruta) return null;
  if (ruta.literal && /^\/?graphql$/i.test(ruta.texto)) {
    const consulta = valores.find((v) => /^query=/.test(v.texto));
    // una consulta que arma la terminal, en un comando que nombra la forma: no se sabe qué pedido encola
    if (consulta && !consulta.literal) return { ilegible: 'la consulta de `gh api graphql` la arma la terminal: escribila tal cual' };
    if (!consulta || !MUTACION.test(consulta.texto)) return null;
    if (/@|^query=-$/.test(consulta.texto.slice(6, 7))) return { ilegible: 'la consulta de `gh api graphql` sale de un archivo: escribila tal cual' };
    const pedidos = [];
    for (const m of consulta.texto.matchAll(/pullRequestId\s*:\s*(?:"([^"\\]+)"|\$([A-Za-z_]\w*)|([^\s,})]+))/g)) {
      if (m[1]) { pedidos.push({ id: m[1] }); continue; }
      if (!m[2]) return { ilegible: 'no se lee qué pedido encola la consulta: escribí su id tal cual' };
      const vs = valores.filter((x) => x.texto.startsWith(`${m[2]}=`));
      if (vs.length !== 1 || !vs[0].literal || /^@/.test(vs[0].texto.slice(m[2].length + 1))) {
        return { ilegible: 'no se lee qué pedido encola la consulta (su variable falta, se repite o sale de un archivo): escribí su id tal cual' };
      }
      pedidos.push({ id: vs[0].texto.slice(m[2].length + 1) });
    }
    // una mutación sin `pullRequestId` a la vista: no se sabe qué pedido es
    const mutaciones = (consulta.texto.match(new RegExp(MUTACION.source, 'g')) || []).length;
    if (!pedidos.length || pedidos.length < mutaciones) return { ilegible: 'no se lee qué pedido encola cada mutación de la consulta: escribí sus ids tal cual' };
    return pedidos;
  }
  if (!ruta.literal) return EN_TEXTO.test(ruta.texto) ? { ilegible: 'la ruta de `gh api` la arma la terminal: escribila tal cual' } : null;
  const m = RUTA_MERGE.exec(ruta.texto);
  if (!m) return null;
  // leer si el pedido ya entró (GET) no mergea nada: escribe con un método, o con campos o `--input` sin método
  const escribe = metodo ? (metodo === '?' || ESCRIBE.test(metodo)) : (valores.length > 0 || ps.some((p) => p.literal && /^--input/.test(p.texto)));
  return escribe ? { repo: m[1], numero: Number(m[2]) } : null;
}

/** Los pedidos que el comando encola o mergea: `{ repo, numero }`, `{ repo, id }` o `{ ilegible }`. */
function leer(comando) {
  const cmd = String(comando || '');
  if (!EN_TEXTO.test(cmd)) return [];
  const out = [];
  for (const c of gh.comandosGh(cmd, 0, {})) {
    const ps = c.palabras || [];
    const verbo = c.verbo || c.verboTrasOpciones;
    // `echo gh …`, `grep … gh`: lo nombra, no lo corre
    if (c.porOtroPrograma && !c.loLanzaOtro && SOLO_NOMBRA.has(nombreDe(c.lanzadoPor))) continue;
    let f = null;
    if (c.grupo === 'pr' && verbo === 'merge') f = deMerge(ps, c, cmd);
    else if (c.grupo === 'api') f = deApi(ps, c, cmd);
    else if (c.grupo === null && (c.ilegible.length || ps.some((p) => !p.literal))) {
      out.push({ ilegible: `${c.ilegible[0] || 'el `gh` lo arma la terminal'}: escribí el comando en su forma exacta, solo` });
      continue;
    } else if (c.grupo === 'pr' && ps[1] && !ps[1].literal) f = { ilegible: 'el verbo de `gh pr` lo arma la terminal: escribilo tal cual' };
    if (!f) continue;
    if (Array.isArray(f)) {
      if (c.enSustitucion || c.porOtroPrograma || c.loLanzaOtro) out.push({ ilegible: `lo corre ${c.lanzadoPor || 'otro programa'}: escribí el comando en su forma exacta, solo` });
      else out.push(...f);
      continue;
    }
    if (!f.ilegible && (c.enSustitucion || (c.porOtroPrograma && !c.loLanzaOtro) || c.loLanzaOtro)) {
      f = { ilegible: `lo corre ${c.lanzadoPor || 'otro programa'}: escribí el comando en su forma exacta, solo` };
    }
    out.push(f);
  }
  // la forma está en el texto y el lector no la encontró: no se sabe qué pedido es
  if (!out.length && !/^\s*(echo|printf|grep|rg|git)\b/.test(cmd)) {
    // un comando de pedidos con un verbo de lectura escrito tal cual (el número puede ir en una variable) ya se leyó: la
    // palabra «merge» en su --json o su --jq es un campo, no un merge. Sólo por lista y sólo esos verbos: una consulta a
    // la API acepta opciones pegadas (`-iX PUT`) que no se leen con certeza, y sigue en la red. Nunca cuenta lo lanzado
    // por otro programa (`xargs -I{}`, `timeout`), una palabra con un `{}` que se llena al correr, ni un comando cuya
    // salida corre otra terminal (`| bash`).
    // Una palabra de la terminal delante (el `do` de un bucle, el `then` de un `if`, un `!`) no es otro programa: el `gh`
    // corre con sus argumentos a la vista, como solo.
    const correLaSalida = /\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh|source|eval|\.)(?:\s|$|[);&|])/.test(cmd);
    const loLanzaUnPrograma = (c) => (c.porOtroPrograma || c.loLanzaOtro) && !PALABRAS_DE_LA_TERMINAL.has(nombreDe(c.lanzadoPor));
    const yaLeido = (c) => {
      const ps = c.palabras || [];
      if (correLaSalida || c.grupo !== 'pr' || loLanzaUnPrograma(c) || ps.some((p) => /\{\}/.test(p.texto))) return false;
      return !!(ps[1] && ps[1].literal) && VERBOS_QUE_LEEN.has(c.verbo || c.verboTrasOpciones);
    };
    const nombra = gh.comandosGh(cmd, 0, {}).some((c) => !yaLeido(c) && (c.grupo === null || c.enSustitucion || (c.porOtroPrograma && !SOLO_NOMBRA.has(nombreDe(c.lanzadoPor)))));
    if (nombra) out.push({ ilegible: 'el comando nombra un merge que este freno no lee entero: escribilo en su forma exacta, solo' });
  }
  return out;
}

/** ¿El comando trae sus pedidos enteros a la vista? (la ventana de permiso no firma lo escondido) */
const aLaVista = (comando) => { const l = leer(comando); return l.length > 0 && l.every((x) => !x.ilegible); };

/** Una cuenta para comparar: en minúsculas, y un bot como `app/<nombre>` aunque se escriba `<nombre>[bot]`. */
const cuentaComparable = (x) => { const t = String(x).trim().toLowerCase(); const b = /^(.+)\[bot\]$/.exec(t); return b ? `app/${b[1]}` : t; };

/**
 * Las cuentas del equipo: `{ cuentas }` o `{ error }`. Las de `pull_requests.team_authors` del perfil; si el perfil no
 * las declara, la cuenta con la que el CLI está autenticado en esta máquina (la que abre los pedidos del equipo: un autor
 * de afuera nunca es ella). Si esa cuenta no se puede leer, no se sabe quién es del equipo.
 */
function cuentasDelEquipo({ home, env = process.env, arnes, cwd, run = spawnSync } = {}) {
  let c;
  try { c = require('./tycon-config.js').leerParaHook({ home, env, arnes }); } catch (e) { return { error: `no pude leer la configuración (${e.message})` }; }
  if (!c.ok) return { error: 'la configuración del arnés está rota' };
  const v = require('./tycon-config.js').valor(c.config, 'pull_requests.team_authors');
  if (Array.isArray(v)) return { cuentas: v.map(cuentaComparable) };
  const r = run('gh', ['api', 'user', '--jq', '.login'], { cwd, encoding: 'utf8', timeout: TIEMPO_GH_MS, windowsHide: true, env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
  const yo = r && !r.error && r.status === 0 ? String(r.stdout || '').trim() : '';
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(yo) || yo === 'null') return { error: 'el perfil no dice quiénes son del equipo y no pude leer con qué cuenta está autenticado el CLI de GitHub' };
  return { cuentas: [cuentaComparable(yo)] };
}

/** Lo que dice GitHub del pedido: `{ autor, numero, titulo, archivos, repo }` o `{ error }`. */
function datosDelPedido(p, { cwd, env = process.env, run = spawnSync } = {}) {
  const opciones = { cwd, encoding: 'utf8', timeout: TIEMPO_GH_MS, windowsHide: true, env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } };
  let args;
  if (p.id) {
    args = ['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequest{number title changedFiles author{__typename login} repository{nameWithOwner}}}}', '-f', `id=${p.id}`];
  } else {
    args = ['pr', 'view', String(p.numero), '--json', 'number,title,changedFiles,author', ...(p.repo ? ['-R', p.repo] : [])];
  }
  const r = run('gh', args, { ...opciones, windowsHide: true });
  if (r.error || r.status !== 0) {
    const porque = r.error ? (r.error.code === 'ETIMEDOUT' ? 'no contestó a tiempo' : r.error.code || r.error.message) : String(r.stderr || '').trim().split('\n')[0] || `salió ${r.status}`;
    return { error: `no pude preguntarle a GitHub de quién es el pedido (${String(porque).slice(0, 160)})` };
  }
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { return { error: 'GitHub contestó algo que no se lee' }; }
  const d = p.id ? j && j.data && j.data.node : j;
  if (!d || !Number.isInteger(d.number) || !d.author || typeof d.author.login !== 'string') return { error: 'GitHub no dijo de quién es el pedido' };
  // `gh pr view` nombra a un bot `app/<nombre>`; GraphQL lo dice por su tipo
  const autor = d.author.__typename === 'Bot' && !d.author.login.startsWith('app/') ? `app/${d.author.login}` : d.author.login;
  return { autor, numero: d.number, titulo: String(d.title || ''), archivos: Number.isInteger(d.changedFiles) ? d.changedFiles : null, repo: p.repo || (d.repository && d.repository.nameWithOwner) || null };
}

/** El renglón que ve el dueño: el autor, el número, el título y cuántos archivos toca. */
function detalleDe(d) {
  const titulo = d.titulo.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `el pedido ${d.repo ? `${d.repo}#` : '#'}${d.numero} de ${d.autor}, que no es del equipo: «${titulo}», ${d.archivos === null ? 'archivos sin contar' : `${d.archivos} archivo${d.archivos === 1 ? '' : 's'}`}`;
}

/**
 * Lo que decide el freno: null (no hay forma, o todos los pedidos son del equipo), `{ frena }` o `{ firmas: [detalle] }`.
 */
function decidir(comando, { cwd, home, env = process.env, arnes, run } = {}) {
  const pedidos = leer(comando);
  if (!pedidos.length) return null;
  const ilegible = pedidos.find((x) => x.ilegible);
  if (ilegible) return { frena: ilegible.ilegible };
  // cambiar de cuenta en la misma línea: el freno miró con la cuenta de antes, y el merge corre con otra (la cuenta
  // activa también decide quién es del equipo cuando el perfil no trae la lista)
  if (CAMBIA_CUENTA.test(String(comando))) return { frena: 'el comando cambia la cuenta de GitHub en la misma línea que el merge: cambiala en otra llamada, antes' };
  const eq = cuentasDelEquipo({ home, env, arnes, cwd, run });
  if (eq.error) return { frena: `${eq.error}: no sé quién es del equipo` };
  const firmas = [];
  for (const p of pedidos) {
    const d = datosDelPedido(p, { cwd: p.carpeta && path.isAbsolute(p.carpeta) ? p.carpeta : cwd, env, run });
    if (d.error) return { frena: d.error };
    if (!eq.cuentas.includes(cuentaComparable(d.autor))) firmas.push(detalleDe(d));
  }
  return firmas.length ? { firmas } : null;
}

module.exports = { FIRMA, leer, aLaVista, cuentaComparable, cuentasDelEquipo, datosDelPedido, detalleDe, decidir };

if (require.main === module) {
  const fs = require('fs');
  let evento;
  try { evento = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '') || '{}'); } catch (e) {
    process.stdout.write(`frena=no pude leer el evento del gancho (${e.message})\n`);
    process.exit(0);
  }
  const comando = evento && evento.tool_input && typeof evento.tool_input.command === 'string' ? evento.tool_input.command : '';
  let r;
  try { r = decidir(comando, { cwd: evento.cwd && path.isAbsolute(String(evento.cwd)) ? evento.cwd : process.cwd() }); } catch (e) { r = { frena: `el freno se cayó (${e.message})` }; }
  const una = (t) => String(t).replace(/[\r\n]+/g, ' ');
  if (r && r.frena) process.stdout.write(`frena=${una(r.frena)}\n`);
  else if (r && r.firmas) for (const f of r.firmas) process.stdout.write(`firma=${una(f)}\n`);
  process.exit(0);
}
