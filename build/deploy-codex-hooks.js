#!/usr/bin/env node
/**
 * build/deploy-codex-hooks.js — despliega adapters/codex/hooks.json a ~/.codex/hooks.json
 * con MERGE QUIRÚRGICO. Lo invoca install-tycon-hooks.sh dentro del
 * bloque TYCON_CODEX=1; nunca corre solo en máquinas sin la llave.
 *
 * Filosofía = la del instalador de settings.json de Claude: lo que el dev escribió a mano en
 * ~/.codex/hooks.json queda INTACTO; solo se reemplazan las entradas TYCON. La propiedad se
 * detecta por PATH en el comando (contiene el clon del arnés o el de agent-skills)
 * — sin markers que se pierdan al editar a mano.
 *
 * - ${TCG} y ${SKILLS} del fragmento se sustituyen por las rutas reales de esta máquina.
 * - Al archivo desplegado va SOLO la clave estándar `hooks` (el __doc y pending_e2 del
 *   fragmento son metadata del repo — tolerancia de claves extrañas en Codex no probada).
 * - Backup una sola vez (~/.codex/hooks.json.bak-tycon) antes del primer cambio.
 * - Atomic write. Idempotente: correrlo dos veces deja el mismo archivo.
 * - Exit 0 con línea "sin cambios" o "desplegado" — el instalador imprime el aviso de TRUST
 *   solo cuando hubo cambios (Codex aprueba cada hook por su contenido: cada cambio pide aprobarlo de nuevo;
 *   se re-aprueba con /hooks en una sesión interactiva).
 *
 * Uso: node deploy-codex-hooks.js [--dry-run] [--selftest]
 *      env: CODEX_HOME (default ~/.codex) · TYCON_SKILLS_DIR (default ~/.claude/agent-skills)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TCG = path.resolve(__dirname, '..');
// Resolución TOLERANTE (raíz O carpeta de skills — las dos semánticas conviven documentadas).
// La variante «instalada», porque estas rutas quedan ESCRITAS en ~/.codex/hooks.json:
// con «el propio clon primero» los comandos pasarían a apuntar al clon del arnés.
const SKILLS = require(path.join(__dirname, '..', 'scripts', 'lib', 'skills-dir.js')).resolveInstalledSkillsDirs().repo;

/**
 * El fragmento con `${TCG}` y `${SKILLS}` cambiados por las rutas de esta máquina, texto por texto.
 *
 * 🔴 POR QUÉ NO SOBRE EL JSON ENTERO. Reemplazar en el fragmento ya serializado y volver a leerlo falla: con una ruta de
 * Windows (`C:\<carpeta de la persona>\.tycon\harness`) las barras invertidas caen SIN escapar adentro de un texto de JSON
 * y la lectura tira («Bad escaped character»), y el despliegue de hooks de Codex falla entero en cualquier Windows.
 * Reemplazando en cada texto, la ruta entra tal cual y quien serializa después la escapa.
 */
function substitute(fragment, tcg, skills, { interp = harnessInterpreter() } = {}) {
  // un comando del arnés que arranca con `node ` sale con el intérprete que decide
  // harness-node.js#interpreter MIRANDO EL DISCO (el Node propio del arnés, o `node`): la misma regla que el aplicador de
  // Claude Code, así quien despliega y quien audita (harness-parity.js, que llama a esta función) no se contradicen
  const prefix = (interp && interp.prefix) || 'node';
  const withInterp = (orig, str) => (prefix !== 'node' && /^node \$\{(?:TCG|SKILLS)\}/.test(orig) ? `${prefix}${str.slice('node'.length)}` : str);
  // una ruta con espacio («C:\\Users\\Nombre Apellido»): el trozo del comando que la lleva va entre comillas dobles, si no el
  // hook queda escrito y no corre nunca
  const quoted = (str, name, value) => {
    if (!/\s/.test(value)) return str.split(name).join(value);
    return str.replace(new RegExp(`(\\S*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\S*)`, 'g'), (m0, pre, post) => (pre.startsWith('"') ? m0.split(name).join(value) : `"${pre}${value}${post}"`));
  };
  const walk = (x) => {
    if (typeof x === 'string') return withInterp(x, quoted(quoted(x, '${TCG}', tcg), '${SKILLS}', skills));
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return walk(fragment);
}

/** El intérprete de los hooks `.js` de esta máquina o `node` si el módulo no está (un árbol viejo). */
function harnessInterpreter(env = process.env) {
  try { return require(path.join(TCG, 'scripts', 'setup', 'harness', 'harness-node.js')).interpreter({ tree: TCG, env }); } catch (e) {
    // sólo si lo que falta es el propio harness-node.js (árbol viejo); si falta algo que él pide, se dice
    if (e && e.code === 'MODULE_NOT_FOUND' && /harness-node\.js/.test(String(e.message).split('\n')[0])) return { prefix: 'node', own: false };
    throw e;
  }
}

// ── Qué hooks del fragmento registra ESTA máquina ────────────────────────────────────────────────────────────────────
// El fragmento trae TODOS los hooks del lado Codex. Desplegado entero, con una integración apagada sus hooks (los de
// engram, Clockify y los nocturnos) quedarían registrados en Codex igual. Del lado Claude Code no, porque el aplicador
// (scripts/setup/apply-hooks.js) decide cada uno por el `when` de scripts/setup/hooks-list.json.
// La decisión es la MISMA del aplicador (`decide`, con la configuración leída por `readConfig`) y la usan quien
// despliega y quien audita (scripts/lib/harness-parity.js): no pueden mirar listas distintas.
//   · sólo se filtran los hooks de una integración (`when: integration:*`); lo de siempre, los opt-in y el perfil siguen
//     como están en Codex. La decisión es la misma de Mac y Linux en las dos
//     plataformas: lo que Windows excluye por `platforms.windows` tampoco se filtra acá.
//   · el barrido de Clockify no está en la lista (del lado Claude Code no lo registra el aplicador): su integración va en
//     NOT_IN_HOOKS_LIST. El hook de CodeGraph tampoco está, y NO se filtra: del lado Claude Code lo registra
//     install-codegraph.sh sin mirar la llave `codegraph`, que es informativa y el perfil del equipo no trae (atarlo a
//     la llave lo sacaría de Codex a quien tiene CodeGraph instalado).
//   · sin el aplicador o la lista al lado (este archivo copiado suelto a un laboratorio): todo el fragmento.
//     Con la configuración rota o ilegible, también todo, y se dice: el aplicador tampoco toca nada en ese caso.
const NOT_IN_HOOKS_LIST = Object.freeze({
  'clocki/scripts/sweep.js': 'integration:clockify',
});

/** El `spec` de la lista que nombra el comando de un hook del fragmento (`@tcg:<guion>` o `<skill>/…`), o null. */
function specOf(command) {
  const c = String(command || '');
  let m = /\$\{TCG\}\/scripts\/hooks\/(\S+)/.exec(c);
  if (m) return `@tcg:${m[1].replace(/"$/, '')}`;
  m = /\$\{SKILLS\}\/skills\/(\S+)/.exec(c);
  return m ? m[1].replace(/"$/, '') : null;
}

/**
 * El fragmento con los hooks que esta máquina registra.
 * @param {{hooks: object}} raw  el fragmento tal cual (con ${TCG} y ${SKILLS})
 * @param {{env?: object, tcg?: string}} [opts]
 * @returns {{fragment: object, dropped: {event: string, spec: string, when: string}[], filtered: boolean, aviso: string|null,
 *   integrations?: object}}  `integrations`: los valores leídos (sólo si se filtró), para la huella de deploy-codex-all.js
 */
function activeFragment(raw, { env = process.env, tcg = TCG } = {}) {
  const asIs = (aviso) => ({ fragment: raw, dropped: [], filtered: false, aviso });
  const listFile = path.join(tcg, 'scripts', 'setup', 'hooks-list.json');
  let ah;
  try { ah = require(path.join(tcg, 'scripts', 'setup', 'apply-hooks.js')); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return asIs(null);
    throw e;
  }
  if (!fs.existsSync(listFile)) return asIs(null);
  const list = ah.loadList(listFile);   // una lista rota tira: no es «no hay hooks»
  const cfg = ah.readConfig({ env, libDir: path.join(tcg, 'scripts', 'lib') });
  if (cfg.integ.state !== 'ok') {
    return asIs(`la configuración del arnés ${cfg.integ.state === 'rota' ? 'está ROTA' : 'no se pudo leer'}: los hooks de Codex de las integraciones quedan registrados sin filtrar, como antes`);
  }
  const extra = Object.entries(NOT_IN_HOOKS_LIST).map(([spec, when]) => ({ event: null, spec, when, platforms: { windows: true } }));
  const all = list.hooks.concat(extra);
  const gated = all.filter((h) => /^integration:/.test(h.when));
  const { active } = ah.decide({ hooks: gated }, { env, integ: cfg.integ, profile: { state: 'ok', value: 'full' }, minimalIds: null, platform: 'posix' });
  const dropped = [];
  const keep = (event, command) => {
    const spec = specOf(command);
    if (!spec) return true;
    const hits = all.filter((h) => h.spec === spec);
    const sameEvent = hits.filter((h) => h.event === event);
    const relevant = sameEvent.length ? sameEvent : hits;
    if (!relevant.length || relevant.some((h) => !/^integration:/.test(h.when))) return true;
    if (relevant.some((h) => active.includes(h))) return true;
    dropped.push({ event, spec, when: relevant[0].when });
    return false;
  };
  const hooks = {};
  for (const [event, groups] of Object.entries(raw.hooks || {})) {
    const kept = [];
    for (const g of groups) {
      const hs = (g.hooks || []).filter((h) => keep(event, h.command));
      if (hs.length) kept.push(Object.assign({}, g, { hooks: hs }));
    }
    if (kept.length) hooks[event] = kept;
  }
  return { fragment: Object.assign({}, raw, { hooks }), dropped, filtered: true, aviso: null, integrations: cfg.integ.values };
}

/**
 * Las formas de los comandos del fragmento, con ${TCG} y ${SKILLS} como "cualquier ruta".
 *
 * 🔴 POR QUÉ. Detectar la propiedad sólo por la ruta de ESTE clon no alcanza. Corrido desde
 * una copia temporal (las sesiones trabajan en clones descartables para no pisar el checkout
 * compartido), las entradas de la ruta real parecerían ajenas: se conservarían y se sumarían las de la
 * copia, y cada hook del arnés quedaría registrado varias veces, algunas apuntando a copias que ya
 * no existen — Codex correría cada aviso varias veces y algunas fallarían, sin error visible. Con las formas de cada comando, un hook del arnés se reconoce venga de la ruta que
 * venga, y el próximo despliegue desde el clon de siempre limpia lo que dejaron las copias.
 */
function plantillas(fragmentoCrudo) {
  const out = [];
  const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const recorrer = (x) => {
    if (Array.isArray(x)) return x.forEach(recorrer);
    if (!x || typeof x !== 'object') return;
    if (typeof x.command === 'string' && /\$\{(TCG|SKILLS)\}/.test(x.command)) {
      // el `node` del principio puede estar escrito como la ruta del Node del arnés, con o sin comillas
      const head = /^node /.test(x.command) ? '(?:node|[^\\s"]*/node(?:\\.exe)?|"[^"]*/node(?:\\.exe)?") ' : '';
      const body = head ? x.command.slice('node '.length) : x.command;
      out.push(new RegExp('^' + head + body.split(/\$\{(?:TCG|SKILLS)\}/).map(escapar).join('\\S+') + '$'));
    }
    Object.values(x).forEach(recorrer);
  };
  recorrer((fragmentoCrudo && fragmentoCrudo.hooks) || {});
  return out;
}

function isTycon(command, tcg, skills, formas = []) {
  const c = String(command);
  if (c.includes(tcg) || c.includes(skills) || formas.some((re) => re.test(c))) return true;
  // Un hook que apunta a scripts de una copia temporal tampoco es configuración del dev, aunque el
  // arnés ya no lo tenga: lo dejó un despliegue desde una copia.
  const ruta = (c.match(/(\/\S*\/(?:scripts|skills)\/\S+)/) || [])[1];
  return Boolean(ruta) && enCarpetaTemporal(ruta);
}

/**
 * ¿Esta ruta vive en una carpeta temporal? Un despliegue desde una copia temporal no toca la
 * configuración de Codex de la máquina: sus hooks tienen que apuntar al clon de siempre, no a una
 * carpeta que se borra sola. Se permite si el destino TAMBIÉN es temporal (las pruebas).
 */
function enCarpetaTemporal(p) {
  // Una ruta que todavía no existe se resuelve por su antepasado más cercano que sí: en macOS las
  // carpetas temporales viven detrás de un enlace (/var → /private/var), y sin esto un destino
  // nuevo parecería no temporal.
  const real = (x) => {
    let actual = path.resolve(x), resto = [];
    for (;;) {
      try { return path.join(fs.realpathSync(actual), ...resto.reverse()); } catch (_) { /* sube */ }
      const padre = path.dirname(actual);
      if (padre === actual) return path.resolve(x);
      resto.push(path.basename(actual)); actual = padre;
    }
  };
  const r = real(p);
  const raices = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map(real);
  return raices.some((t) => r === t || r.startsWith(t + path.sep));
}

/** núcleo puro (testeable offline): merge del fragmento sobre el hooks.json existente */
function merge(existing, fragment, tcg, skills, formas = []) {
  const out = JSON.parse(JSON.stringify(existing || {}));
  out.hooks = out.hooks || {};
  const events = new Set([...Object.keys(out.hooks), ...Object.keys(fragment.hooks || {})]);
  for (const event of events) {
    const kept = [];
    for (const group of out.hooks[event] || []) {
      // de cada grupo existente se conservan SOLO los comandos ajenos; los TYCON se re-generan
      const foreign = (group.hooks || []).filter((h) => !isTycon(h.command, tcg, skills, formas));
      if (foreign.length) kept.push(Object.assign({}, group, { hooks: foreign }));
    }
    const ours = fragment.hooks && fragment.hooks[event] ? fragment.hooks[event] : [];
    const merged = kept.concat(JSON.parse(JSON.stringify(ours)));
    if (merged.length) out.hooks[event] = merged;
    else delete out.hooks[event];
  }
  return out;
}

function selftest() {
  const tcg = '/x/tcg', skills = '/x/skills';
  const frag = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${tcg}/scripts/hooks/safety-guard-pre.sh` }] }] } };
  const existing = {
    otra_clave_del_dev: true,
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /home/dev/mi-hook-propio.sh' }, { type: 'command', command: `bash ${tcg}/scripts/hooks/viejo-tycon.sh` }] },
      ],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node /home/dev/despedida.js' }] }],
    },
  };
  const m1 = merge(existing, frag, tcg, skills);
  const flat = JSON.stringify(m1);
  const checks = [
    ['el hook propio del dev se preserva', flat.includes('mi-hook-propio.sh')],
    ['el TYCON viejo se reemplaza (no se acumula)', !flat.includes('viejo-tycon.sh')],
    ['el TYCON nuevo queda', flat.includes('safety-guard-pre.sh')],
    ['los eventos ajenos quedan intactos', flat.includes('despedida.js')],
    ['las claves top-level del dev quedan', m1.otra_clave_del_dev === true],
    ['idempotente: merge(merge(x)) === merge(x)', JSON.stringify(merge(m1, frag, tcg, skills)) === flat],
    ['sustitución de ${TCG}/${SKILLS}', JSON.stringify(substitute({ hooks: { X: [{ hooks: [{ command: 'node ${TCG}/a ${SKILLS}/b' }] }] } }, tcg, skills)).includes('/x/tcg/a /x/skills/b')],
    // una ruta de Windows no rompe el fragmento, y lo desplegado se vuelve a leer con la ruta entera
    ['sustitución con una ruta de Windows (barras invertidas): no tira y la ruta queda entera', (() => {
      const win = 'C:\\Users\\dev\\.tycon\\harness';
      let out;
      try { out = substitute({ hooks: { X: [{ hooks: [{ command: 'node ${TCG}/scripts/hooks/a.js' }] }] } }, win, win, { interp: { prefix: 'node' } }); } catch (_) { return false; }
      const cmd = JSON.parse(JSON.stringify(out, null, 1)).hooks.X[0].hooks[0].command;
      return cmd === `node ${win}/scripts/hooks/a.js`;
    })()],
    ['un hook con la ruta de Windows se reconoce como del arnés al re-desplegar (no se acumula)', (() => {
      const win = 'C:\\Users\\dev\\.tycon\\harness';
      const f = substitute({ hooks: { X: [{ hooks: [{ type: 'command', command: 'node ${TCG}/scripts/hooks/a.js' }] }] } }, win, win);
      const once = merge(null, f, win, win);
      return JSON.stringify(merge(once, f, win, win)) === JSON.stringify(once) && once.hooks.X.length === 1;
    })()],
    // con el Node del arnés, el `node` del principio sale con su ruta; lo demás del comando igual
    ['con el Node del arnés, node ${TCG}/… sale con su ruta y bash ${TCG}/… no cambia', (() => {
      const own = { prefix: '/h/.tycon/node/current/bin/node' };
      const out = substitute({ hooks: { X: [{ hooks: [{ command: 'node ${TCG}/scripts/hooks/a.js' }, { command: 'bash ${TCG}/scripts/hooks/b.sh' }] }] } }, tcg, skills, { interp: own });
      const cmds = out.hooks.X[0].hooks.map((h) => h.command);
      return cmds[0] === `${own.prefix} ${tcg}/scripts/hooks/a.js` && cmds[1] === `bash ${tcg}/scripts/hooks/b.sh`;
    })()],
    ['un hook del arnés en cualquiera de las dos formas, desde otra copia, se reconoce por la forma (no se duplica)', (() => {
      const crudo = { hooks: { X: [{ hooks: [{ type: 'command', command: 'node ${TCG}/scripts/hooks/a.js' }] }] } };
      const formas = plantillas(crudo);
      return formas.some((re) => re.test('/h/.tycon/node/current/bin/node /otra/copia/scripts/hooks/a.js'))
        && formas.some((re) => re.test('"/mi casa/.tycon/node/current/bin/node" /otra/copia/scripts/hooks/a.js'))
        && formas.some((re) => re.test('node /otra/copia/scripts/hooks/a.js'));
    })()],
  ];
  let bad = 0;
  for (const [name, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-deploy: ${name}`); if (!ok) bad++; }
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (enCarpetaTemporal(TCG) && !enCarpetaTemporal(codexHome)) {
    console.log(`⚠ deploy-codex-hooks: NO desplegado — el arnés corre desde una copia temporal (${TCG}). Los hooks de Codex de la máquina se despliegan desde el clon de siempre.`);
    return 0;
  }
  const target = path.join(codexHome, 'hooks.json');
  const crudo = JSON.parse(fs.readFileSync(path.join(TCG, 'adapters', 'codex', 'hooks.json'), 'utf8'));
  // sólo los hooks que esta máquina registra; las formas (`plantillas`) salen del fragmento ENTERO, así un hook de una
  // integración que se apagó se reconoce como del arnés y se saca del hooks.json que ya estaba desplegado
  let act;
  try { act = activeFragment(crudo); } catch (e) {
    // una lista de hooks rota no es «no hay hooks»: no se despliega nada y se dice por qué (el aplicador hace lo mismo)
    console.log(`✗ deploy-codex-hooks: NO desplegado — ${(e && e.message) || e}`);
    return 1;
  }
  if (act.aviso) console.log(`⚠ deploy-codex-hooks: ${act.aviso}`);
  const fragment = substitute(act.fragment, TCG, SKILLS);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { existing = null; }
  const merged = merge(existing, { hooks: fragment.hooks }, TCG, SKILLS, plantillas(crudo));
  const next = JSON.stringify(merged, null, 1) + '\n';
  const current = existing !== null ? fs.readFileSync(target, 'utf8') : null;
  if (current === next) { console.log('deploy-codex-hooks: sin cambios'); return 0; }
  if (process.argv.includes('--dry-run')) { console.log('deploy-codex-hooks: CAMBIARÍA (dry-run)'); return 0; }
  fs.mkdirSync(codexHome, { recursive: true });
  const bak = target + '.bak-tycon';
  if (current !== null && !fs.existsSync(bak)) fs.writeFileSync(bak, current);
  const tmp = target + '.tmp-tycon';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, target);
  console.log(`deploy-codex-hooks: DESPLEGADO → ${target} (backup: ${current !== null ? bak : 'no había archivo previo'})`);
  if (act.dropped.length) {
    console.log(`deploy-codex-hooks: sin registrar porque su integración está apagada: ${act.dropped.map((d) => `${d.spec.replace(/^@tcg:/, '')} (${d.when.split(':')[1]})`).join(' · ')}`);
  }
  // Codex aprueba cada control por su contenido: uno que cambió vuelve a pedir aprobación, y sin ella no corre. La marca
  // ⚠ es la que hace que el informe de la instalación repita el renglón (report.warningLines y tools.js NOTICE_RE).
  console.log('⚠ Qué sigue en Codex: abrí codex, escribí /hooks y aprobá los controles nuevos. Sin eso no corren, y Codex no avisa.');
  return 0;
}

module.exports = { substitute, plantillas, merge, enCarpetaTemporal, activeFragment, specOf, harnessInterpreter, NOT_IN_HOOKS_LIST, SKILLS, TCG, FRAGMENT: path.join(TCG, 'adapters', 'codex', 'hooks.json') };
if (require.main === module) process.exit(main());
