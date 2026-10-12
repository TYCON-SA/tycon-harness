#!/usr/bin/env bash
# prod-guard-shell-forms.test.sh — el freno de producción lee los nombres como los lee el shell (story 8.14).
#
# Caso que lo motiva (pase adversarial de la tanda P de la 8.9, 2026-09-30): `rm -f …/production-{index,memory}.json`
# pasaba el freno — el partidor cortaba la palabra en las llaves y el nombre protegido nunca llegaba entero. Medidas 119
# formas del shell contra main 6e01463: 65 no hacían lo que tenían que hacer. Este archivo es esa medición, vuelta
# prueba: `scripts/tests/fixtures/prod-guard-shell-forms.json` trae las filas y lo que cada una tiene que hacer.
#
# Lo que prueba:
#   T7-T13 — la prueba respaldada (R1-R6 y `echo {a,b}`), cada una con su nombre
#   T14    — toda fila «frena» sale 2 (si no, la lista de las que no)
#   T15    — toda fila «pasa» sale 0, los límites del AC 22 incluidos (para que un cambio que los empiece a frenar se vea)
#   T16    — la columna «toca» se vuelve a medir en esta corrida: las filas medidas por el shell con zsh y bash REALES
#            (bloque 1: expandir las palabras y mirar por inodo; bloque 2: zsh ejecuta el comando sobre copias). Un shell
#            que cambió hace fallar la fila en vez de dejarla vieja; un shell que falta sale NO MEDIDO (≠ 0), nunca verde.
#            Sólo donde /bin/bash es 3.2 (las Mac del equipo): con otro bash, T16 dice que no se mide y la suite sigue.
#
# 🔴 HOME de laboratorio siempre, y los nombres protegidos se arman al correr (el fixture los trae como @NI@…): el
#    freno vivo frena un comando que los lleva enteros. Con /opt/tycon presente las costuras no existen y la suite se
#    saltea; en una máquina con el freno se corre con /opt/tycon escondido:
#      sandbox-exec -f <perfil que niega leer /opt/tycon> bash scripts/tests/prod-guard-shell-forms.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -d /opt/tycon ]; then
  echo "⏭ shell-forms: esta máquina tiene el freno instalado (/opt/tycon): sin costuras de prueba, esta suite corre en el nocturno."
  exit 0
fi
node - "$AQUI" <<'JS'
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync } = require('child_process');
const AQUI = process.argv[2];
const HOOK = path.join(AQUI, 'scripts/hooks/prod-access-guard.js');
const FIX = JSON.parse(fs.readFileSync(path.join(AQUI, 'scripts/tests/fixtures/prod-guard-shell-forms.json'), 'utf8'));
let fallos = 0; let pasaron = 0; let noMedido = 0;
const ok = (m) => { console.log(`✅ shell-forms: ${m}`); pasaron++; };
const no = (m) => { console.log(`❌ shell-forms: ${m}`); fallos++; };
const nm = (m) => { console.log(`⏭ shell-forms: NO MEDIDO — ${m}`); noMedido++; };

// ── los nombres, armados al correr ─────────────────────────────────────────────────────────────
const N = {
  NI: 'production' + '-index.json', NM: 'production' + '-memory.json',
  OI: 'produccion' + '-indice.json', OM: 'produccion' + '-memoria.json',
  CAT: 'production' + '.json', OCAT: 'produccion' + '.json',
};
const nombres = (s) => String(s)
  .replace(/@NI@/g, 'production' + '-index').replace(/@NM@/g, 'production' + '-memory')
  .replace(/@OI@/g, 'produccion' + '-indice').replace(/@OM@/g, 'produccion' + '-memoria')
  .replace(/@CAT@/g, N.CAT).replace(/@OCAT@/g, N.OCAT);

// ── el mundo de laboratorio ────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-forms-'));
const CASA = path.join(TMP, 'casa'); const REPOS = path.join(TMP, 'repos'); const R = path.join(REPOS, 'r');
const PIPE = path.join(CASA, '.claude', '.tycon-pipeline');
const CATALOGO = '{"servers":[{"host":"x.database.windows.net","environment":"produccion","keychain":"tycon-prod-x"}]}';
function mundo() {
  fs.rmSync(CASA, { recursive: true, force: true }); fs.rmSync(REPOS, { recursive: true, force: true });
  fs.mkdirSync(path.join(CASA, '.claude', 'shell-snapshots'), { recursive: true });
  fs.mkdirSync(path.join(PIPE, 'timing-history'), { recursive: true });
  fs.mkdirSync(path.join(R, '.tycon'), { recursive: true });
  spawnSync('git', ['init', '-q', '.'], { cwd: R });
  fs.writeFileSync(path.join(R, '.tycon', N.CAT), CATALOGO);
  fs.writeFileSync(path.join(R, '.tycon', N.OCAT), '{"servers":[]}');
  for (const k of ['NI', 'NM', 'OI', 'OM']) fs.writeFileSync(path.join(PIPE, N[k]), '{}');
  for (const f of ['timing-x.json', 'active-x.json', 'STOP_AUTONOMY']) fs.writeFileSync(path.join(PIPE, f), '{}');
  fs.writeFileSync(path.join(CASA, '.claude', 'shell-snapshots', `snapshot-zsh-${Date.now()}-aaaaaa.sh`),
    '# Snapshot file\n# Functions\n# Aliases\nexport PATH=/usr/bin\n');
}
const protegidos = () => ({
  NI: path.join(PIPE, N.NI), NM: path.join(PIPE, N.NM), OI: path.join(PIPE, N.OI), OM: path.join(PIPE, N.OM),
  CAT: path.join(R, '.tycon', N.CAT), OCAT: path.join(R, '.tycon', N.OCAT),
});
mundo();

const paraElFreno = (s) => nombres(s).replace(/<P>/g, '~/.claude/.tycon-pipeline').replace(/<R>/g, R);
function corre(cmd) {
  const payload = JSON.stringify({ tool_name: 'Bash', hook_event_name: 'PreToolUse', cwd: '/tmp', tool_input: { command: cmd } });
  const r = spawnSync('node', [HOOK], {
    input: payload, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: CASA, TYCON_REPOS_ROOT: REPOS, TYCON_PROD_SESSION_SINCE: '0' },
  });
  return { rc: r.status, motivo: ((r.stderr || '').match(/Motivo: (.*)/) || [])[1] || '' };
}
const esperado = (f) => (f.expect === 'block' ? 2 : 0);
const resultado = new Map();
for (const f of FIX.rows) resultado.set(f.id, corre(paraElFreno(f.cmd)));

// ── T7-T13: la prueba respaldada ───────────────────────────────────────────────────────────────
const nombradas = [
  ['T7 BackedUpProbe_R1_FullNameStillBlocks', 'R1'], ['T8 BackedUpProbe_R2_BraceNewNamesBlocks', 'R2'],
  ['T9 BackedUpProbe_R3_BraceOldNamesBlocks', 'R3'], ['T10 BackedUpProbe_R4_SedOnCatalogStillBlocks', 'R4'],
  ['T11 BackedUpProbe_R5_SedOnCatalogWithBracesBlocks', 'R5'], ['T12 BackedUpProbe_R6_WildcardStillBlocks', 'R6'],
  ['T13 BackedUpProbe_EchoBracesPasses', 'N2'],
];
for (const [t, id] of nombradas) {
  const f = FIX.rows.find((x) => x.id === id); const r = resultado.get(id);
  if (r.rc === esperado(f)) ok(`${t} (${id} → ${r.rc})`);
  else no(`${t} (${id}: rc=${r.rc}, esperaba ${esperado(f)}) ${r.motivo}`);
}

// ── T14 / T15: todas las filas ─────────────────────────────────────────────────────────────────
for (const [t, tipo] of [['T14 ShellFormsTable_EveryBlockRow_Exits2', 'block'], ['T15 ShellFormsTable_EveryPassRow_Exits0', 'pass']]) {
  const filas = FIX.rows.filter((f) => f.expect === tipo);
  const mal = filas.filter((f) => resultado.get(f.id).rc !== esperado(f));
  if (!mal.length) ok(`${t} (${filas.length} filas)`);
  else no(`${t}: ${mal.length} de ${filas.length} no — ${mal.map((f) => `${f.id}=${resultado.get(f.id).rc}`).join(' ')}`);
}

// ── T16: la columna «toca», medida otra vez ────────────────────────────────────────────────────
const SHELLS = { zsh: '/bin/zsh', bash: '/bin/bash' };
const faltan = Object.entries(SHELLS).filter(([, p]) => !fs.existsSync(p)).map(([n]) => n);
const inodos = () => new Map(Object.entries(protegidos()).map(([k, p]) => [fs.statSync(p).ino, k]));
function expande(shell, pre, palabras, cwd) {
  const imprimir = shell === 'zsh' ? 'print -rl --' : "printf '%s\\n'";
  const script = `${pre ? pre + '; ' : ''}${imprimir} ${palabras}`;
  const args = shell === 'zsh' ? ['-f', '-c', script] : ['--norc', '--noprofile', '-c', script];
  const r = spawnSync(SHELLS[shell], args, { cwd, encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: CASA } });
  const ino = inodos(); const tocados = new Set();
  for (const w of (r.stdout || '').split('\n').filter(Boolean)) {
    try { const k = ino.get(fs.statSync(path.isAbsolute(w) ? w : path.join(cwd, w)).ino); if (k) tocados.add(k); } catch { /* no existe */ }
  }
  return tocados;
}
function ejecuta(f) {
  mundo();
  const antes = Object.fromEntries(Object.entries(protegidos()).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));
  const script = `${f.opts || ''}\n${nombres(f.zsh).replace(/\/tmp\/lab814-/g, path.join(TMP, 'lab814-'))}`;
  fs.writeFileSync(path.join(TMP, 'lab814-script.sh'), 'true\n');
  spawnSync('/bin/zsh', ['-f', '-c', script], { cwd: TMP, encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: CASA, P: PIPE, R } });
  const tocados = new Set();
  for (const [k, p] of Object.entries(protegidos())) {
    let ahora = null; try { ahora = fs.readFileSync(p, 'utf8'); } catch { /* desapareció */ }
    if (ahora !== antes[k]) tocados.add(k);
  }
  mundo();
  return tocados;
}
// La referencia de T16 son los shells de las Mac del equipo: zsh y el bash 3.2 de macOS, que es lo que el freno modela.
// Donde /bin/bash es otro (el agente Linux de la CI trae el 5.x, que lee distinto las llaves con paso y con ceros), la
// columna «toca» no se puede re-medir: se dice y no cuenta como rojo ni como verde de T16 (decisión del dueño,
// 2026-10-03, «por ahora»: [DEF-8.14-A-CI-LINUX]). En la plataforma de referencia, un shell que falta sigue saliendo ≠ 0.
const bashVersion = (() => {
  const r = spawnSync('/bin/bash', ['--version'], { encoding: 'utf8' });
  const m = /version (\d+\.\d+)/.exec(r.stdout || '');
  return m ? m[1] : null;
})();
const offReference = bashVersion !== null && bashVersion !== '3.2';
if (offReference) console.log(`⏭ shell-forms: T16 ShellFormsTable_TouchColumn_StillHolds no se mide acá: /bin/bash es ${bashVersion} y la referencia es zsh + bash 3.2 (las Mac del equipo). T7-T15 sí corrieron.`);
else if (faltan.length) nm(`T16 ShellFormsTable_TouchColumn_StillHolds: falta ${faltan.join(', ')}`);
else {
  const mal = []; let medidas = 0;
  for (const f of FIX.rows) {
    let medido = null;
    if (f.touchesSource === 'shell-expande') {
      const cwd = f.cwd === 'P' ? PIPE : f.cwd === 'R' ? R : TMP;
      const pre = /^cd\s/.test(f.pre) ? '' : paraElFreno(f.pre).replace(/~\/\.claude/g, '$HOME/.claude');
      const palabras = paraElFreno(f.words);
      medido = new Set([...expande('zsh', pre, palabras, cwd), ...expande('bash', pre, palabras, cwd)]);
    } else if (f.touchesSource === 'shell-ejecuta') medido = ejecuta(f);
    if (medido === null) continue;
    medidas++;
    const a = [...medido].sort().join(','); const b = [...f.touches].sort().join(',');
    if (a !== b) mal.push(`${f.id} (medido «${a || 'nada'}», fixture «${b || 'nada'}»)`);
  }
  if (!mal.length) ok(`T16 ShellFormsTable_TouchColumn_StillHolds (${medidas} filas medidas con zsh y bash)`);
  else no(`T16 ShellFormsTable_TouchColumn_StillHolds: ${mal.join(' · ')}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`shell-forms: ${pasaron} bien · ${fallos} mal${noMedido ? ` · ${noMedido} NO MEDIDO` : ''}`);
process.exit(fallos ? 1 : noMedido ? 3 : 0);
JS
