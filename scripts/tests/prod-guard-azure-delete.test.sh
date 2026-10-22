#!/usr/bin/env bash
# prod-guard-azure-delete.test.sh — el freno de producción frena el borrado del grupo, del recurso y del candado de Azure.
#
# Caso que lo motiva: borrar el grupo de recursos se lleva el servidor entero con sus bases, y el freno lo dejaba pasar
# porque el catálogo declara servidores, no grupos. El freno no puede saber qué contiene un grupo, así que frena todo
# borrado de grupo; `az resource delete` pasa sólo si se lee el tipo y no es de Microsoft.Sql.
#
# 🔴 Este archivo no lleva ningún comando de borrado escrito: los trae `fixtures/prod-guard-azure-delete.json`. El freno
#    instalado lee el contenido de los guiones que un comando ejecuta, y se frenaría a sí mismo.
#
# Lo que prueba (los nombres de la story):
#   T1-T12, T20 — cada fila de la tabla sale 2 («block») o 0 («pass»), con su catálogo y su herramienta
#   T13 — el mensaje dice qué, por qué y el único camino; no nombra la puerta ni el grupo que sale de una variable
#   T14 — el corte deja una línea con la regla `borrado-de-azure`, sin el texto del comando
#   T15 — el vocabulario de constancias y su copia en el freno instalado conocen la regla
#   T16 — con el freno sin poder decidir (entrada ilegible), la familia frena y lo demás pasa
#   T17 — un comando de más de 32 KB con la familia frena; sin ella, pasa
#   T18 — el lanzador sin intérprete y la caída del freno dan el mismo veredicto en cada miembro de la familia
#   T19 — la decisión no ejecuta `az` (un `az` impostor primero en el PATH no deja su marca) y cae dentro del reloj
#   T26 — la guía dice qué se frena, que el freno no sabe qué contiene un grupo, quién borra y los límites
#
# HOME de laboratorio siempre. Con /opt/tycon presente las costuras de prueba no existen y la suite se saltea; en una
# máquina con el freno se corre con /opt/tycon escondido:
#   sandbox-exec -f <perfil que niega leer y ver /opt/tycon> bash scripts/tests/prod-guard-azure-delete.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -d /opt/tycon ]; then
  echo "⏭ azure-delete: esta máquina tiene el freno instalado (/opt/tycon): sin costuras de prueba, esta suite corre en el nocturno."
  exit 0
fi
node - "$AQUI" <<'JS'
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync } = require('child_process');
const AQUI = process.argv[2];
const HOOK = path.join(AQUI, 'scripts/hooks/prod-access-guard.js');
const SHIM = path.join(AQUI, 'scripts/production/node-shim.sh');
const FIX = JSON.parse(fs.readFileSync(path.join(AQUI, 'scripts/tests/fixtures/prod-guard-azure-delete.json'), 'utf8'));
let fallos = 0; let pasaron = 0;
const ok = (m) => { console.log(`✅ azure-delete: ${m}`); pasaron++; };
const no = (m) => { console.log(`❌ azure-delete: ${m}`); fallos++; };

// ── el mundo de laboratorio: HOME falso y una raíz de repos con el catálogo que pide cada fila ──────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-delete-'));
const CASA = path.join(TMP, 'casa'); const REPOS = path.join(TMP, 'repos');
const ESTADO = path.join(CASA, '.claude', '.tycon-pipeline');
function mundo(catalogo) {
  fs.rmSync(CASA, { recursive: true, force: true }); fs.rmSync(REPOS, { recursive: true, force: true });
  fs.mkdirSync(path.join(CASA, '.claude', 'shell-snapshots'), { recursive: true });
  fs.mkdirSync(ESTADO, { recursive: true });
  fs.mkdirSync(REPOS, { recursive: true });
  if (catalogo === 'vacio') return;
  const servers = [{ host: FIX.staging_host, environment: 'no-produccion' }];
  if (catalogo === 'prod') servers.unshift({ host: FIX.prod_host, environment: 'produccion', keychain: 'tycon-prod-acme' });
  const r = path.join(REPOS, 'backend-acme');
  fs.mkdirSync(path.join(r, '.tycon'), { recursive: true });
  spawnSync('git', ['init', '-q', r]);
  fs.writeFileSync(path.join(r, '.tycon', 'production.json'), JSON.stringify({ servers }));
}
const payload = (cmd, tool = 'Bash') => JSON.stringify({ tool_name: tool, hook_event_name: 'PreToolUse', cwd: TMP, tool_input: { command: cmd } });
function corre(entrada, extra = {}) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [HOOK], {
    input: entrada, encoding: 'utf8',
    env: { ...process.env, HOME: CASA, TYCON_REPOS_ROOT: REPOS, TYCON_PROD_SESSION_SINCE: '0', ...extra },
  });
  return { rc: r.status, err: r.stderr || '', ms: Date.now() - t };
}
const esperado = (e) => (e === 'block' ? 2 : 0);

// ── T1-T12 y T20: la tabla ───────────────────────────────────────────────────────────────────────────────────────
const porTest = new Map();
for (const fila of FIX.rows) {
  mundo(fila.catalog);
  const { rc, err } = corre(payload(fila.cmd, fila.tool));
  const l = porTest.get(fila.test) || []; porTest.set(fila.test, l);
  if (rc !== esperado(fila.expect)) l.push(`[${fila.tool}/${fila.catalog}] ${JSON.stringify(fila.cmd)} salió ${rc}, esperaba ${esperado(fila.expect)}${err ? ` — ${err.split('\n').find((x) => /Motivo/.test(x)) || ''}` : ''}`);
}
const NOMBRES = {
  T1: 'GroupDelete_AllForms_Exit2', T2: 'GroupDelete_IgnoresCatalogAndGroupName', T3: 'GroupDelete_GlobalFlagsWrappersAndCmdExtensions_Exit2',
  T4: 'GroupDelete_NonLiteralOrHidden_Exit2', T5: 'ResourceDelete_NamesSqlServer_CatalogDecides', T6: 'ResourceDelete_AllTypesReadableNotSql_Passes',
  T7: 'ResourceDelete_UnreadableType_Exit2', T8: 'LockDelete_Exit2_OtherLockVerbsPass', T9: 'RestDelete_Exit2_OtherMethodsPass',
  T10: 'PowerShell_AzRemoveCmdlets_Exit2', T11: 'SqlServerAndDbDelete_Production_StillExit2', T12: 'SqlDropStatement_Production_AnyCase_Exit2',
  T20: 'ReadOnlyAzCommands_Pass',
};
for (const [t, nombre] of Object.entries(NOMBRES)) {
  const l = porTest.get(t);
  if (!l) { no(`${t} ${nombre}: la tabla no trae filas para esta prueba`); continue; }
  if (l.length) no(`${t} ${nombre}: ${l.length} fila(s) mal:\n   ${l.join('\n   ')}`);
  else ok(`${t} ${nombre}`);
}

// T4 también: el guion que un shell corre y que ya estaba escrito en una carpeta temporal se lee como comandos
{
  mundo('prod');
  const guion = path.join(TMP, 'borra.sh');
  fs.writeFileSync(guion, `${FIX.family.block[0]}\n`);
  const { rc } = corre(payload(`bash ${guion}`));
  if (rc === 2) ok('T4 GroupDelete_NonLiteralOrHidden_Exit2 (el guion que corre bash)');
  else no(`T4 GroupDelete_NonLiteralOrHidden_Exit2: el guion que corre bash salió ${rc}, esperaba 2`);
  // y el guion de PowerShell que ya estaba escrito y corre pwsh
  const ps1 = path.join(TMP, 'borra.ps1');
  fs.writeFileSync(ps1, `${FIX.family.block.find((c) => /^Remove-/.test(c))}\n`);
  const r2 = corre(payload(`pwsh -File ${ps1}`));
  if (r2.rc === 2) ok('T10 PowerShell_AzRemoveCmdlets_Exit2 (el guion que corre pwsh)');
  else no(`T10 PowerShell_AzRemoveCmdlets_Exit2: el guion que corre pwsh salió ${r2.rc}, esperaba 2`);
}

// ── T13: el mensaje ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const mal = [];
  for (const c of FIX.message.cases) {
    mundo('prod');
    const { rc, err } = corre(payload(c.cmd, c.tool));
    if (rc !== 2) { mal.push(`${JSON.stringify(c.cmd)} salió ${rc}`); continue; }
    for (const f of FIX.message.contains) if (!err.includes(f)) mal.push(`${JSON.stringify(c.cmd)}: el mensaje no dice «${f}»`);
    for (const f of FIX.message.never) if (err.includes(f)) mal.push(`${JSON.stringify(c.cmd)}: el mensaje nombra «${f}»`);
    for (const f of c.not_contains) if (err.includes(f)) mal.push(`${JSON.stringify(c.cmd)}: el mensaje trae «${f}», que salió de una variable`);
  }
  if (mal.length) no(`T13 Block_MessageSaysWhyAndPathAndNoDoor:\n   ${mal.join('\n   ')}`); else ok('T13 Block_MessageSaysWhyAndPathAndNoDoor');
}

// ── T14: la constancia, de cada miembro de la familia ────────────────────────────────────────────────────────────
const herramienta = (c) => (/^(Remove|Invoke)-/.test(c) ? 'PowerShell' : 'Bash');
{
  const mal = [];
  for (const cmd of FIX.family.block) {
    mundo('prod');
    const { rc } = corre(payload(cmd, herramienta(cmd)));
    const f = path.join(ESTADO, 'frenos.jsonl');
    const crudo = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const lineas = crudo.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const propia = lineas.find((l) => l.freno === 'prod-access-guard' && l.regla === 'borrado-de-azure' && l.veredicto === 'bloqueo');
    if (rc !== 2 || !propia || crudo.includes(cmd)) mal.push(`${JSON.stringify(cmd)}: rc=${rc}, líneas=${JSON.stringify(lineas)}${crudo.includes(cmd) ? ' (trae el texto del comando)' : ''}`);
  }
  if (mal.length) no(`T14 Block_LeavesRecordWithOwnRule:\n   ${mal.join('\n   ')}`); else ok('T14 Block_LeavesRecordWithOwnRule');
}

// ── T15: el vocabulario y su copia ───────────────────────────────────────────────────────────────────────────────
{
  const mal = [];
  for (const rel of ['scripts/lib/guard-record.js', 'scripts/production/guard-libs/lib/guard-record.js']) {
    delete require.cache[path.join(AQUI, rel)];
    const lib = require(path.join(AQUI, rel));
    if (!lib.FRENOS['prod-access-guard'].reglas.includes('borrado-de-azure')) mal.push(`${rel} no lista la regla`);
    if (lib.reglaNormalizada('prod-access-guard', 'borrado-de-azure') !== 'borrado-de-azure') mal.push(`${rel} la manda a «${lib.REGLA_DESCONOCIDA}»`);
  }
  if (mal.length) no(`T15 GuardRecord_AndDashboardVocabulary_KnowRule: ${mal.join(' · ')}`); else ok('T15 GuardRecord_AndDashboardVocabulary_KnowRule');
}

// ── T16: el freno que no puede decidir ───────────────────────────────────────────────────────────────────────────
// una entrada ilegible es la falla propia que el freno no puede leer: decide sobre el texto crudo
{
  const mal = [];
  mundo('prod');
  for (const c of FIX.family.block) { const { rc } = corre(`{no es json ${c}`); if (rc !== 2) mal.push(`${JSON.stringify(c)} salió ${rc}, esperaba 2`); }
  for (const c of FIX.family.pass) { const { rc } = corre(`{no es json ${c}`); if (rc !== 0) mal.push(`${JSON.stringify(c)} salió ${rc}, esperaba 0`); }
  if (mal.length) no(`T16 OwnFailure_FamilyBlocked_OthersPass:\n   ${mal.join('\n   ')}`); else ok('T16 OwnFailure_FamilyBlocked_OthersPass');
}

// ── T17: el tope de 32 KB ────────────────────────────────────────────────────────────────────────────────────────
{
  mundo('prod');
  const relleno = `echo ${'x'.repeat(33 * 1024)}`;
  const con = corre(payload(`${relleno} ; ${FIX.family.block[0]}`));
  const sin = corre(payload(`${relleno} ; ${FIX.family.pass[1]}`));
  // un texto largo hecho para que una expresión con dos tramos libres retroceda sin fin: el freno decide dentro del reloj
  // el caso del pase adversarial: la palabra del grupo repetida miles de veces y el borrado al final (34 KB). Con una
  // expresión de dos tramos libres no contestaba en 15 s, y el tope del registro (10 s) lo dejaba pasar
  const [az, grupo] = FIX.family.block[0].split(' ');
  const patologico = `echo ${`${az} ${grupo} `.repeat(3700)}; ${FIX.family.block[0]}`;
  const largo = corre(payload(patologico));
  const caida = corre(`{no es json ${patologico}`);
  const mal = [];
  if (con.rc !== 2 || sin.rc !== 0) mal.push(`con la familia salió ${con.rc} (esperaba 2), sin ella ${sin.rc} (esperaba 0)`);
  for (const [nombre, r] of [['por el tope de 32 KB', largo], ['por la caída del freno', caida]]) {
    if (r.rc !== 2 || r.ms > 5000) mal.push(`el texto patológico ${nombre} salió ${r.rc} en ${r.ms} ms (esperaba 2 en menos de 5 s)`);
  }
  if (!mal.length) ok('T17 BigCommand_32KB_FamilyBlocked'); else no(`T17 BigCommand_32KB_FamilyBlocked: ${mal.join(' · ')}`);
}

// ── T18: el lanzador y la caída del freno dicen lo mismo ─────────────────────────────────────────────────────────
// el lanzador, con una raíz sin intérprete, decide sólo con su criterio crudo; la caída del freno, con el suyo
{
  const mal = [];
  const raiz = path.join(TMP, 'raiz-sin-node');
  fs.mkdirSync(raiz, { recursive: true });
  mundo('prod');
  const lanzador = (texto) => spawnSync('bash', [SHIM], { input: texto, encoding: 'utf8',
    env: { ...process.env, HOME: CASA, TYCON_PROD_ROOT: raiz } }).status;
  for (const [lista, rc] of [[FIX.family.block, 2], [FIX.family.pass, 0]]) {
    for (const c of lista) {
      const sh = lanzador(payload(c));
      const js = corre(`{no es json ${c}`).rc;
      if (sh !== rc || js !== rc) mal.push(`${JSON.stringify(c)}: lanzador ${sh}, caída del freno ${js}, esperaba ${rc} en los dos`);
    }
  }
  if (mal.length) no(`T18 Shim_NombraBorrado_InSyncWithHook:\n   ${mal.join('\n   ')}`); else ok('T18 Shim_NombraBorrado_InSyncWithHook');
}

// ── T19: texto puro, sin `az` y dentro del reloj ─────────────────────────────────────────────────────────────────
{
  mundo('prod');
  const bin = path.join(TMP, 'bin'); const marca = path.join(TMP, 'az-corrio');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'az'), `#!/bin/sh\ntouch ${JSON.stringify(marca)}\n`, { mode: 0o755 });
  const mal = [];
  for (const c of FIX.family.block) {
    const r = corre(payload(c, herramienta(c)), { PATH: `${bin}:${process.env.PATH}` });
    if (r.rc !== 2) mal.push(`${JSON.stringify(c)} salió ${r.rc}`);
    if (r.ms > 5000) mal.push(`${JSON.stringify(c)} tardó ${r.ms} ms (el reloj del freno es de 5 s)`);
  }
  if (fs.existsSync(marca)) mal.push('el freno ejecutó el `az` del PATH');
  if (mal.length) no(`T19 Decision_NoAzCall_NoDiskRead_WithinClock: ${mal.join(' · ')}`); else ok('T19 Decision_NoAzCall_NoDiskRead_WithinClock');
}

// ── T26: la guía ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const guia = fs.readFileSync(path.join(AQUI, FIX.guide.file), 'utf8');
  const faltan = FIX.guide.phrases.filter((f) => !guia.includes(f));
  if (faltan.length) no(`T26 Guide_DeclaresFamilyAndLimits: la guía no dice ${faltan.map((f) => `«${f}»`).join(', ')}`);
  else ok('T26 Guide_DeclaresFamilyAndLimits');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nazure-delete: ${pasaron} bien, ${fallos} mal`);
process.exit(fallos ? 1 : 0);
JS
