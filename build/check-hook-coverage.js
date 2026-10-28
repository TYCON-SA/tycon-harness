#!/usr/bin/env node
/**
 * build/check-hook-coverage.js — el CUARTO control del pre-commit: **un hook que existe en disco
 * tiene casos en el banco, o su deuda está declarada**.
 *
 * ── EL AGUJERO QUE CIERRA ───────────────────────────────────────────────────────────────────────
 * El arnés tiene una regla explícita: *"una pieza nueva entra CON sus casos de prueba o no entra"*.
 * Los tres enumeradores que la hacen cumplir —los casos del banco, `adapters/codex/hooks.json` y
 * el manifiesto de advisors— **son todos listas escritas a mano**. O sea: sólo pueden detectar las
 * piezas que alguien ya se acordó de anotar, justamente lo contrario del caso que la regla existe
 * para atrapar. **Ninguno recorre `scripts/hooks/` en disco**, así que un script de hook puede existir
 * sin ningún caso que lo nombre, también si es un freno que bloquea.
 *
 * Éste enumera EL DISCO. Es la diferencia entre un inventario y un censo.
 *
 * ── ARRANQUE ESCALONADO (decisión D3 del dev) ───────────────────────────────────────────────────
 * Con 9 scripts sin cobertura, encenderlo bloqueando frenaría a todo el equipo el primer día
 * — la vía rápida a que alguien lo apague, o le pase `--no-verify` por encima, y ahí se pierde
 * también para los casos donde importa. Entran con **deuda declarada** en
 * `scripts/controls-bench/hook-debt.json`, con motivo y fecha. Mismo patrón que `divergences` del
 * registro de Codex: la asimetría se permite, el silencio no.
 *
 * ── QUÉ CUENTA COMO CUBIERTO ────────────────────────────────────────────────────────────────────
 * El banco apunta a los DESPACHADORES (`hook-pre-edit.js`), no a cada handler: desde la
 * consolidación H10 los handlers corren in-process adentro. Así que un script cuenta como cubierto
 * si el banco lo nombra como `script`, o si su nombre aparece en la etiqueta del hook o en el id de
 * un caso (la convención `hook-pre-edit.js → on-frontmatter-write`). Exigir un archivo de casos por
 * handler sería exigir que el banco pruebe algo que la herramienta no dispara por separado.
 *
 * ── QUÉ SKILLS CENSA ──────────────────────────────────────────────────────────────────────────
 * Las que ubica el resolvedor de todo el arnés (scripts/lib/skills-dir.js): `TYCON_SKILLS_DIR` o, sin ella, el lugar de
 * instalación. Una raíz de skills que se pidió por variable y no se puede enumerar es ROJO; sin la variable, una raíz
 * que falta (otra máquina, un clon incompleto) sigue siendo un aviso.
 *
 * Uso:  node build/check-hook-coverage.js [--selftest]
 * Exit: 0 al día · 1 hay hooks sin casos ni deuda declarada, o no se pudo censar una raíz de skills pedida por variable
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TCG = path.resolve(__dirname, '..');
// El marcador de la raíz del arnés que el banco lleva como texto (no es una plantilla de JS).
const PH_TCG = '$' + '{TCG}';
const CASES_DIR = path.join(TCG, 'scripts', 'controls-bench', 'cases', 'hooks');
const DEUDA_PATH = path.join(TCG, 'scripts', 'controls-bench', 'hook-debt.json');

/**
 * Dónde están las skills que se censan, y si esa raíz se PIDIÓ por variable. Las ubica el resolvedor de todo el arnés
 * (scripts/lib/skills-dir.js): `TYCON_SKILLS_DIR` —la raíz del clon o su carpeta `skills/`— o, sin ella, el lugar de
 * instalación (~/.claude/agent-skills).
 *
 * 🔴 Armar las rutas con la HOME e ignorar la variable es un error: en una máquina
 *    sin instalación —la CI pública, que exporta la variable— las dos raíces de skills quedarían «sin censar» y el
 *    control saldría verde con hooks sin mirar; con OTRO clon instalado, se censarían las instaladas y no las del repo
 *    que se revisa.
 */
function skillsRoot(env) {
  const asked = String((env || process.env).TYCON_SKILLS_DIR || '').trim();
  const { skills } = require(path.join(TCG, 'scripts', 'lib', 'skills-dir.js')).resolveSkillsDirs(asked);
  return { skills, requested: asked !== '' };
}

/**
 * Las raíces que no se pudieron enumerar: un AVISO si es la instalación de otra máquina o un clon incompleto, y un ROJO
 * si es una raíz de skills que se pidió por variable. No censar lo que se pidió no es un verde.
 */
function missingRoots(faltantes, skills, requested) {
  const blocking = [];
  const notices = [];
  for (const d of faltantes) {
    if (requested && d.startsWith(skills + path.sep)) {
      blocking.push(`no pude enumerar ${d}: TYCON_SKILLS_DIR pide censar esas skills y esa carpeta no está. No censar lo que se pidió no es un verde.`);
    } else {
      notices.push(`no pude enumerar ${d} (¿otra máquina?) — esa raíz queda sin censar`);
    }
  }
  return { blocking, notices };
}

/** Los directorios donde viven hooks, con el filtro de qué archivo de ahí ES un hook. */
function raices(tcg, skills) {
  const out = [
    { dir: path.join(tcg, 'scripts', 'hooks'), filtro: (f) => /\.(js|sh|py)$/.test(f) },
    { dir: path.join(skills, 'tycon-pipeline', 'scripts'), filtro: (f) => /^(on-|hook-).*\.js$/.test(f) },
  ];
  // de cada integración, los guiones que su manifiesto registra como hooks o como entradas del despachador (sus
  // bibliotecas no lo son). Un manifiesto que no se lee no esconde sus hooks: la raíz entera se censa.
  const dir = path.join(tcg, 'integrations');
  let names = [];
  // una carpeta que está y no se puede leer no es «sin integraciones»: va como raíz, y el censo la da por faltante
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) {
    if (e.code !== 'ENOENT') out.push({ dir, filtro: () => true });
    names = [];
  }
  // las rutas, con la regla del manifiesto (scripts/lib/integrations.js): una que sale de la carpeta no elige qué se censa
  const SAFE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
  const safe = (s) => SAFE.test(s) && !s.split('/').some((x) => x === '..' || x === '.');
  for (const n of names) {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, n, 'integration.json'), 'utf8')); } catch (_) { m = null; }
    // un manifiesto que se lee y no declara hooks (un conector de plataforma, una integración de horas sin hooks) no
    // aporta ninguno: sus guiones son bibliotecas; uno con `hooks` que no es una lista no se entiende y se censa entero
    const hooksOk = m && (m.hooks === undefined || Array.isArray(m.hooks));
    const listed = hooksOk ? [...(m.hooks || []).map((h) => h && h.script), ...(Array.isArray(m.dispatch) ? m.dispatch.map((d) => d && d.script) : [])].filter((s) => typeof s === 'string') : null;
    const own = listed && listed.every(safe) ? listed : null;
    const byDir = new Map();
    for (const s of own || []) { const d = path.dirname(s); if (!byDir.has(d)) byDir.set(d, new Set()); byDir.get(d).add(path.basename(s)); }
    if (own === null) out.push({ dir: path.join(dir, n, 'scripts'), filtro: (f) => /\.(js|sh|py)$/.test(f) });
    for (const [d, files] of byDir) out.push({ dir: path.join(dir, n, d), filtro: (f) => files.has(f) });
  }
  return out;
}

/** Un reemplazo generado de un nombre viejo no es un hook propio: sólo lanza al nuevo, que es el que tiene
 *  casos. La marca va en la segunda línea (scripts/lib/legacy-names.js). */
function esReemplazo(abs) {
  try { return require(path.join(TCG, 'scripts', 'lib', 'legacy-names.js')).isShim(fs.readFileSync(abs, 'utf8')); } catch (_e) { return false; }
}

/** Todo lo que hay EN DISCO. `faltantes` = raíces ausentes (otra máquina, clon incompleto). */
function enumerarDisco(rs) {
  const scripts = new Set();
  const faltantes = [];
  for (const { dir, filtro } of rs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_e) { faltantes.push(dir); continue; }
    for (const f of entries) if (filtro(f) && !esReemplazo(path.join(dir, f))) scripts.add(f);
  }
  return { scripts: [...scripts].sort(), faltantes };
}

/** Lo que el banco nombra: scripts explícitos + textos (etiquetas de hook e ids de caso). */
function cobertura(casesDir) {
  const scripts = new Set();
  const textos = [];
  let files = [];
  try { files = fs.readdirSync(casesDir).filter((x) => x.endsWith('.json')).sort(); } catch (_e) { return { scripts, textos }; }
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8')); } catch (_e) { continue; }
    for (const h of d.hooks || []) {
      const cmd = String(h.script || '').trim().split(/\s+/).pop();
      if (cmd) scripts.add(path.basename(cmd));
      if (h.hook) textos.push(String(h.hook));
      for (const c of h.cases || []) if (c.id) textos.push(String(c.id));
    }
  }
  return { scripts, textos };
}

function cubierto(archivo, cob) {
  if (cob.scripts.has(archivo)) return true;
  const raiz = archivo.replace(/\.(js|sh|py)$/, '');
  // El nombre sin extensión, pero NO seguido de otra extensión: `instinct-observe.sh` en una
  // etiqueta no puede dar por cubierto a `instinct-observe.py` — son dos piezas distintas.
  const re = new RegExp(raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\.(js|sh|py))');
  return cob.textos.some((t) => t.includes(archivo) || re.test(t));
}

function leerDeuda(p) {
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(d.debt) ? d.debt : [];
  } catch (_e) { return []; }
}

function comparar(disco, cob, deuda) {
  const declarada = new Map(deuda.filter((d) => d && d.script).map((d) => [d.script, d]));
  const bloqueantes = [];
  const avisos = [];

  for (const f of disco) {
    if (cubierto(f, cob)) {
      if (declarada.has(f)) {
        avisos.push(`\`${f}\` ya tiene casos en el banco — sacá su línea de hook-debt.json (una deuda saldada que sigue anotada vuelve a ser silencio)`);
      }
      continue;
    }
    const d = declarada.get(f);
    if (!d) {
      bloqueantes.push(`\`${f}\` es un hook y NO tiene casos en el banco. Escribile casos en scripts/controls-bench/cases/hooks/, o declará la deuda en scripts/controls-bench/hook-debt.json con motivo y fecha.`);
      continue;
    }
    if (!d.reason || String(d.reason).trim().length < 15) {
      bloqueantes.push(`\`${f}\` está en hook-debt.json sin un motivo de verdad. Una deuda sin motivo es un permiso.`);
    }
  }

  for (const f of declarada.keys()) {
    if (!disco.includes(f)) avisos.push(`\`${f}\` figura en hook-debt.json y ya no existe en disco — sacá su línea`);
  }
  return { bloqueantes, avisos, pendientes: disco.filter((f) => !cubierto(f, cob)).length };
}

// ── selftest ────────────────────────────────────────────────────────────────────────────────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hookcov-'));
  // el mismo criterio con que skills-dir.js reconoce un clon unido (isSingleRepo): skills/tycon-pipeline y agents/ en la raíz
  const ownCloneHasSkills = fs.existsSync(path.join(TCG, 'skills', 'tycon-pipeline')) && fs.existsSync(path.join(TCG, 'agents'));
  const casos = path.join(tmp, 'cases');
  const hooks = path.join(tmp, 'scripts', 'hooks');
  fs.mkdirSync(casos, { recursive: true });
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of ['con-casos.js', 'por-despachador.js', 'sin-nada.js', 'con-deuda.js']) {
    fs.writeFileSync(path.join(hooks, f), '// x\n');
  }
  fs.writeFileSync(path.join(casos, 'a.json'), JSON.stringify({
    hooks: [
      { hook: 'con-casos.js', script: `${PH_TCG}/scripts/hooks/con-casos.js`, event: 'Stop', cases: [{ id: 'x' }] },
      { hook: 'despachador.js → por-despachador', script: `${PH_TCG}/scripts/hooks/despachador.js`, event: 'Stop', cases: [{ id: 'y' }] },
    ],
  }));
  const rs = [{ dir: hooks, filtro: (f) => /\.(js|sh|py)$/.test(f) }];
  const disco = enumerarDisco(rs).scripts;
  const cob = cobertura(casos);

  const sinDeuda = comparar(disco, cob, []);
  const conDeuda = comparar(disco, cob, [
    { script: 'sin-nada.js', reason: 'un motivo suficientemente largo para ser un motivo' },
    { script: 'con-deuda.js', reason: 'otro motivo suficientemente largo para contar' },
  ]);
  const deudaFloja = comparar(disco, cob, [
    { script: 'sin-nada.js', reason: 'x' },
    { script: 'con-deuda.js', reason: 'otro motivo suficientemente largo para contar' },
  ]);
  const deudaSaldada = comparar(disco, cob, [
    { script: 'con-casos.js', reason: 'una deuda que ya no corresponde porque tiene casos' },
    { script: 'sin-nada.js', reason: 'un motivo suficientemente largo para ser un motivo' },
    { script: 'con-deuda.js', reason: 'otro motivo suficientemente largo para contar' },
    { script: 'borrado.js', reason: 'un script que ya no existe en disco, la línea sobra' },
  ]);

  // las integraciones: la que no declara hooks no aporta guiones; la que no se lee se censa entera
  const tcgFalso = path.join(tmp, 'tcg');
  const integracion = (n, manifiesto) => {
    fs.mkdirSync(path.join(tcgFalso, 'integrations', n, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tcgFalso, 'integrations', n, 'scripts', `${n}.js`), '// x\n');
    fs.writeFileSync(path.join(tcgFalso, 'integrations', n, 'integration.json'), manifiesto);
  };
  integracion('conector', JSON.stringify({ name: 'conector', kind: 'platform', connector: 'scripts/conector.js' }));
  integracion('ilegible', '{ esto no es json');
  const censoIntegraciones = enumerarDisco(raices(tcgFalso, path.join(tmp, 'sin-skills')).filter((r) => r.dir.includes(`${path.sep}integrations${path.sep}`))).scripts;

  fs.rmSync(tmp, { recursive: true, force: true });

  const checks = [
    ['una integración que no declara hooks no aporta guiones al censo', !censoIntegraciones.includes('conector.js')],
    ['una integración con el manifiesto ilegible se censa entera', censoIntegraciones.includes('ilegible.js')],
    ['un hook con casos propios no bloquea', !sinDeuda.bloqueantes.some((b) => b.includes('con-casos.js'))],
    ['un handler nombrado por su despachador cuenta como cubierto', !sinDeuda.bloqueantes.some((b) => b.includes('por-despachador.js'))],
    ['un hook sin casos ni deuda BLOQUEA', sinDeuda.bloqueantes.some((b) => b.includes('sin-nada.js'))],
    ['la deuda declarada lo deja pasar', conDeuda.bloqueantes.length === 0],
    ['una deuda sin motivo de verdad BLOQUEA (una deuda sin motivo es un permiso)', deudaFloja.bloqueantes.some((b) => b.includes('sin-nada.js'))],
    ['una deuda ya saldada se avisa', deudaSaldada.avisos.some((a) => a.includes('con-casos.js'))],
    ['una deuda de un script inexistente se avisa', deudaSaldada.avisos.some((a) => a.includes('borrado.js'))],
    ['`instinct-observe.sh` en una etiqueta NO cubre a `instinct-observe.py`',
      !cubierto('instinct-observe.py', { scripts: new Set(), textos: ['instinct-observe.sh'] })],
    // dónde están las skills: TYCON_SKILLS_DIR manda (en sus dos formas), y sin ella, el lugar de instalación
    ['con TYCON_SKILLS_DIR (la carpeta skills/) se censan ESAS skills, y la raíz cuenta como pedida',
      skillsRoot({ TYCON_SKILLS_DIR: path.join(tmp, 'clon', 'skills') }).skills === path.join(tmp, 'clon', 'skills')
        && skillsRoot({ TYCON_SKILLS_DIR: path.join(tmp, 'clon', 'skills') }).requested === true],
    // (sin la variable manda el propio clon cuando trae las skills adentro; si no, el lugar de instalación)
    ['sin TYCON_SKILLS_DIR se censan las del propio clon si trae las skills, o las del lugar de instalación, y la raíz no cuenta como pedida',
      skillsRoot({}).skills === (ownCloneHasSkills
        ? path.join(TCG, 'skills') : path.join(os.homedir(), '.claude', 'agent-skills', 'skills'))
        && skillsRoot({}).requested === false],
    ['una raíz de skills PEDIDA que no se puede enumerar BLOQUEA (no censar lo que se pidió no es un verde)',
      missingRoots([path.join(tmp, 'sk', 'acme', 'scripts')], path.join(tmp, 'sk'), true).blocking.length === 1],
    ['la misma raíz sin haberla pedido es un aviso (otra máquina)',
      missingRoots([path.join(tmp, 'sk', 'acme', 'scripts')], path.join(tmp, 'sk'), false).blocking.length === 0
        && missingRoots([path.join(tmp, 'sk', 'acme', 'scripts')], path.join(tmp, 'sk'), false).notices.length === 1],
    ['una raíz que falta y NO es de las skills pedidas es un aviso',
      missingRoots([path.join(tmp, 'otro', 'scripts', 'hooks')], path.join(tmp, 'sk'), true).blocking.length === 0],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log(`${ok ? '✅' : '❌'} selftest-hook-coverage: ${n}`); if (!ok) bad++; }
  console.log(bad ? `❌ ${bad} rojos` : `✅ selftest-hook-coverage: ${checks.length}/${checks.length} verdes`);
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const { skills, requested } = skillsRoot(process.env);
  const { scripts: disco, faltantes } = enumerarDisco(raices(TCG, skills));
  const missing = missingRoots(faltantes, skills, requested);
  for (const n of missing.notices) console.log(`⚠ hook-coverage: ${n}`);
  if (!disco.length && !missing.blocking.length) { console.log('✅ hook-coverage: nada que censar'); return 0; }

  const cob = cobertura(CASES_DIR);
  const deuda = leerDeuda(DEUDA_PATH);
  const { bloqueantes, avisos, pendientes } = comparar(disco, cob, deuda);
  bloqueantes.unshift(...missing.blocking);

  for (const a of avisos) console.log(`⚠ hook-coverage: ${a}`);
  if (!bloqueantes.length) {
    console.log(`✅ hook-coverage: ${disco.length} hooks en disco · ${disco.length - pendientes} con casos · ${pendientes} con deuda declarada`);
    return 0;
  }
  console.error('❌ hook-coverage — un hook sin casos es un control sin control:');
  for (const b of bloqueantes) console.error(`   · ${b}`);
  return 1;
}

if (require.main === module) process.exit(main());
module.exports = { raices, enumerarDisco, cobertura, cubierto, leerDeuda, comparar, skillsRoot, missingRoots };
