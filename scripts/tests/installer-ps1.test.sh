#!/usr/bin/env bash
# installer-ps1.test.sh — el instalador de Windows (`install-tycon-hooks.ps1`) y su sync de bloques
# (`setup/sync-claude-md-blocks.ps1`), por EJECUCIÓN con `pwsh` (story 8.7, tanda C · pase adversarial).
#
# La falla que caza: el `.ps1` se escribió «por lectura», sin máquina Windows, y sus pruebas sólo lo leían. Así pasó
# sin que nadie lo viera (2026-10-03, hallazgo 17): en una máquina limpia `-Check` salía 1 con un error de PowerShell
# en vez de listar qué falta, y sin `-Check` —sobre el `settings.json` que deja `harness.js install`, que sólo trae
# `hooks.SessionStart`— el aplicador moría con «The property 'Stop' cannot be found on this object» sin registrar un
# solo hook. Causa: las guardas `-not $x.PSObject.Properties.Match('nombre')`. `Match()` devuelve una colección que
# PowerShell da por verdadera AUNQUE ESTÉ VACÍA, así que la guarda nunca entra. Es una clase: había nueve.
#
# Cómo mide (todo con el `pwsh` de esta máquina; la semántica de esas guardas es del motor, no del sistema operativo):
#   · un clon de laboratorio armado acá: copia de `scripts/` (sin sus pruebas) y `claude-md-blocks/`, más
#     `skills/tycon-pipeline` y `agents/` de juguete en la raíz (la forma del repo único) con un archivo vacío por
#     cada hook que el set canónico busca en agent-skills.
#   · HOME y USERPROFILE temporales, y los `XDG_*` de pwsh fuera de la HOME: lo que aparece en la HOME lo escribió el
#     instalador, no pwsh. `env -i`: nada del ambiente de quien corre se cuela.
#   · lo esperado sale de LA lista de hooks (`scripts/setup/hooks-list.json`, story 8.17 W3 y W4: el `.ps1` ya no lleva
#     tablas propias, llama a `scripts/setup/apply-hooks.js --platform windows`): los registros que Windows no excluye,
#     decididos por su `when` con una lógica escrita en esta prueba, cruzados con lo que el lector de configuración dice
#     que está prendido y con los archivos que existen en el clon: cada hook esperado, UNA vez, en su evento y con su
#     matcher; un `.js` como `node "…"` y un `.sh` como `bash "…"` (story 8.17, W3W4: la ruta absoluta del bash de Git
#     del AC 29 se fue, medido en un agente Windows). Y «no pierde nada»: sacando esos hooks, el `settings.json` queda igual al de partida
#     (mismas claves, mismos valores, mismo orden).
#   · un `node` intermediario delante del PATH anota con qué argumentos se llama al paso de terceros (hallazgo 3):
#     el paso va apagado (`TYCON_THIRD_PARTY=0`), así que su salida no lo dice. Con el mismo intermediario se ve que el
#     `.ps1` le pregunta a `scripts/lib/skills-dir.js` dónde están las skills (story 8.18, sección (i)).
#   · (story 8.18, tramo 3) llamado por la misma carpeta escrita con otras mayúsculas no registra nada dos veces
#     (sección (j); en un disco que las distingue, NO MEDIDO), y un `core.hooksPath` local cuya carpeta esconde la vista
#     reducida de un clon re-apuntado no se borra por «vestigial» (sección (k), sobre un clon de git de laboratorio).
#   · (regresión 182 measure #12408, 2026-10-08) sección (z): el clon y la HOME en «usuario de práctica» y la consola
#     de pwsh puesta en Latin1 antes de llamar al `.ps1` —lo que Windows hace solo cuando lo lanza harness.js o un hook—:
#     `-Check` tiene que encontrar la carpeta de skills igual, porque el `.ps1` fija UTF-8 él mismo.
#   · el sync `.ps1` corre sobre los mismos bloques de juguete que el `.sh` y el `CLAUDE.md` se compara BYTE A BYTE
#     (hallazgos 11 y 16: un marcador `requires-integration` casi bien escrito no es un bloque común).
#   · story 8.17, tanda W3a (T90 a T93): el `.ps1` registraba 29 de los 42 controles que el `.sh` registra en una máquina
#     del equipo (medido en un agente Windows: corridas 11686 y 11709); faltaban, entre otros, los dos frenos de comandos.
#     Acá lo esperado NO sale de la lista de hooks sino de una lista escrita en esta prueba, control por control
#     (secciones n a q): cada uno una vez, en su evento y con su matcher; un `.sh` como `bash "…"` (la forma de la
#     W3a, que volvió en la W3W4) y un `.js` como
#     `node "…"`; los opt-in por variable se registran y se SACAN; un `.sh` con finales `\r\n` no se registra y se dice;
#     un guion que falta se nombra. Con las integraciones prendidas por variable (lo de fábrica de una máquina del equipo).
#     (Las secciones de la W3a se llamaban f a m en `main`; al juntarse con las f a k de la story 8.18 pasaron a n a u,
#     en el mismo orden: f→n, g→o, h→p, i→q, j→r, k→s, l→t, m→u.)
#   · (story 8.26, tanda H1c · AC 65 e) sección (gh): el aviso de la carpeta GLOBAL de hooks de git — calla si es la que
#     el instalador llena, avisa con las dos rutas y el comando si es otra, tiene su aviso si no existe, dice «no pude
#     comparar» si es relativa o (en Windows) tiene forma de Unix, y nunca cambia la configuración de git.
# 🔴 Nunca la HOME real: antes de correr el instalador, pwsh dice qué HOME y qué USERPROFILE ve; si no son las de
#    laboratorio, la prueba se niega. Sin red, sin docker, sin sudo. `launchctl` de mentira, examen nocturno y entorno
#    gráfico apagados.
# Sin `pwsh` en el PATH: UNA línea «NO MEDIDO» y exit 0 — ni verde ni rojo.
# Lo que NO mide: Windows de verdad (rutas con `\`, junctions, PowerShell 5.1). Esa deuda sigue declarada en el `.ps1`.
# Correr: bash scripts/tests/installer-ps1.test.sh [<raíz del clon bajo prueba>]   (entre 1,5 y 2,5 min con las secciones
#         de la W3a, unas 45 corridas del .ps1 de 1 a 3 s cada una; antes de la W3a medía 44 s)

set -uo pipefail
ROOT="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd)"
PS1_INSTALLER="$ROOT/scripts/install-tycon-hooks.ps1"

if ! command -v pwsh >/dev/null 2>&1; then
  echo "⏭ installer-ps1: NO MEDIDO — no hay pwsh en esta máquina"
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "⏭ installer-ps1: NO MEDIDO — no hay node en esta máquina"
  exit 0
fi
[ -f "$PS1_INSTALLER" ] || { echo "❌ installer-ps1: $ROOT no es un clon del arnés (sin scripts/install-tycon-hooks.ps1)"; exit 1; }

T="$(mktemp -d /tmp/installer-ps1.XXXXXX)" && T="$(cd "$T" && pwd -P)" || { echo "❌ installer-ps1: no pude crear la carpeta temporal"; exit 1; }
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/tmp" "$T/xdg" "$T/bin"
FAILURES=0; TOTAL=0
ok() { TOTAL=$((TOTAL+1)); echo "✅ installer-ps1: $1"; }
no() { TOTAL=$((TOTAL+1)); FAILURES=$((FAILURES+1)); echo "❌ installer-ps1: $1"; }
brief() { tail -2 "$1" 2>/dev/null | sed $'s/\x1b\\[[0-9;]*m//g' | tr '\n' ' ' | cut -c1-"${2:-300}"; }   # <archivo> [largo]: el final de una salida, en un renglón y sin colores

# ── el clon de laboratorio: el repo único (scripts/ + skills/ y agents/ de juguete en la raíz) ─────────────────
CLONE="$T/clone"; mkdir -p "$CLONE/agents" "$CLONE/skills/tycon-pipeline"
( cd "$ROOT" && tar cf - --exclude=scripts/tests --exclude=node_modules --exclude=.bench scripts claude-md-blocks ) | ( cd "$CLONE" && tar xf - )
[ -f "$CLONE/scripts/install-tycon-hooks.ps1" ] || { echo "❌ installer-ps1: no pude armar el clon de laboratorio"; exit 1; }
printf '# skill de juguete\n' > "$CLONE/skills/tycon-pipeline/SKILL.md"
printf '# revisor de juguete\n' > "$CLONE/agents/lab-reviewer.md"
# un archivo vacío por cada hook que la lista busca en las skills (los que no llevan `@tcg:`). Desde la story 8.17 (W3 y
# W4) la lista es scripts/setup/hooks-list.json: el .ps1 ya no lleva tabla propia, llama a apply-hooks.js
HOOKS_LIST="$ROOT/scripts/setup/hooks-list.json"
node -e 'for (const h of require(process.argv[1]).hooks) if (!h.spec.startsWith("@tcg:")) console.log(h.spec)' "$HOOKS_LIST" | sort -u | while IFS= read -r rel; do
  mkdir -p "$CLONE/skills/$(dirname "$rel")" && : > "$CLONE/skills/$rel"
done
[ -n "$(find "$CLONE/skills" -name '*.js' | head -1)" ] || { echo "❌ installer-ps1: no pude leer los hooks de las skills de $HOOKS_LIST"; exit 1; }

# ── el ambiente: nada de la máquina real ──────────────────────────────────────────────────────────────────────
printf '#!/bin/sh\n# launchctl de mentira: no carga nada en la máquina real\nexit 0\n' > "$T/bin/launchctl"; chmod +x "$T/bin/launchctl"
REAL_NODE="$(command -v node)"
NODE_CALLS="$T/node-calls.log"; : > "$NODE_CALLS"
# el intermediario: anota los argumentos y le pasa la posta al node de verdad
# (story 8.36) a la tanda del aplicador (`applier-batch.js --plan <archivo>`) le anota además cada paso de su plan como
# la llamada suelta que reemplaza («(tanda) scripts/…/<guion>.js <argumentos>»): lo que se mira acá es a quién se le
# pregunta y con qué, no cuántos procesos lo hacen. El que lee el plan no hereda NODE_OPTIONS (no lo cuenta el T4).
cat > "$T/bin/node" <<EOF
#!/bin/sh
printf "%s\\n" "\$*" >> "$NODE_CALLS"
case "\$1 \$2" in *applier-batch.js\ --plan) env -u NODE_OPTIONS "$REAL_NODE" -e 'const at = { "skills-dir": "lib", "tycon-config": "lib", "legacy-names": "lib", "canonical-path": "lib", "apply-hooks": "setup", "install-third-party": "publishing" }; for (const s of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).steps) console.log("(tanda) scripts/" + at[s.script] + "/" + s.script + ".js " + s.args.join(" "))' "\$3" >> "$NODE_CALLS" 2>/dev/null ;; esac
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$T/bin/node"
# cómo empieza el comando de un .sh registrado: `bash "<ruta del guion>"`. La W4 (AC 29) lo había pasado a la ruta
# absoluta del bash de Git entre comillas; la W3W4 lo volvió atrás (medido en el agente Windows, corrida 11979: lanzado
# por PowerShell era un error de sintaxis, y Claude Code lanza los hooks con el bash de Git, donde `bash` ya es ése).
SH_PREFIX='bash '
# TYCON_NO_GIT_HOOKS=1: los hooks globales de git que el .ps1 deja desde la W4 (AC 32) no son de esta prueba
SAFE=(TYCON_PROFILE=0 TYCON_NO_GIT_HOOKS=1 TYCON_CODEX=0 TYCON_THIRD_PARTY=0 TYCON_NO_NIGHTLY_EXAM=1 TYCON_NO_GUI_ENV=1 "LAUNCHCTL_BIN=$T/bin/launchctl"
  TYCON_NO_AZ_PROJECTS_REFRESH=1 TYCON_NO_AGENTSMD_POINTER=1 TYCON_NO_ENGRAM_VERSION_CHECK=1 TYCON_NO_SQLITE_CHECK=1
  TYCON_NO_CLAUDEMD_SYNC=1 TYCON_MAILBOX_URL_BASE=http://127.0.0.1:9 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  GIT_TERMINAL_PROMPT=0 POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off)
lab_env() { # <home> [VAR=val ...] -- <comando…>: el comando, con la HOME de laboratorio y sin el ambiente de quien corre
  local h="$1"; shift
  local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ $# -gt 0 ] && shift
  ( cd "$h" && env -i HOME="$h" USERPROFILE="$h" PATH="$T/bin:$PATH" TMPDIR="$T/tmp" LANG="${LANG:-en_US.UTF-8}" \
      XDG_CACHE_HOME="$T/xdg/cache" XDG_DATA_HOME="$T/xdg/data" XDG_CONFIG_HOME="$T/xdg/config" \
      "${SAFE[@]}" ${extra[@]+"${extra[@]}"} "$@" )
}
installer() { # <home> [VAR=val ...] [-- <args del instalador>] → corre el .ps1 del clon; exit code REAL
  local h="$1"; shift
  local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ $# -gt 0 ] && shift
  # PS1_ENTRY: por qué ruta se lo llama (por defecto, la carpeta del clon; (f) lo llama por el enlace de la HOME)
  # LAB_INSTALLER=<otro .ps1> delante de la llamada: el instalador de OTRA copia del clon de laboratorio (W3a); si están
  # las dos, gana LAB_INSTALLER (ningún caso las pone juntas)
  lab_env "$h" ${extra[@]+"${extra[@]}"} -- pwsh -NoProfile -NonInteractive -File "${LAB_INSTALLER:-${PS1_ENTRY:-$CLONE/scripts/install-tycon-hooks.ps1}}" "$@"
}
new_home() { local h; h="$(mktemp -d "$T/home-$1.XXXXXX")" && echo "$h"; }   # <nombre> → una HOME vacía (ni `.claude` trae)
listing() { # <carpeta>: todo lo que hay, con la suma de cada archivo — «no escribió nada» se prueba comparando dos
  ( cd "$1" && { find . -mindepth 1 \( -type d -o -type l \) | LC_ALL=C sort; find . -type f -exec cksum {} + | LC_ALL=C sort; } )
}

# 🔴 el candado: ¿qué HOME ve pwsh? Si no es la de laboratorio, no se corre nada.
GUARD="$(new_home guard)"
printf '"$HOME|$env:USERPROFILE"\n' > "$T/guard.ps1"
SEEN="$(lab_env "$GUARD" -- pwsh -NoProfile -NonInteractive -File "$T/guard.ps1" 2>&1)"
if [ "$SEEN" != "$GUARD|$GUARD" ]; then
  echo "❌ installer-ps1: pwsh no ve la HOME de laboratorio (ve «${SEEN}», esperaba «${GUARD}|${GUARD}») — no corro el instalador"
  exit 1
fi
if [ -n "$(find "$GUARD" -mindepth 1 | head -1)" ]; then
  echo "❌ installer-ps1: pwsh escribe en la HOME al arrancar ($(find "$GUARD" -mindepth 1 | head -3 | tr '\n' ' ')) — el «no escribió nada» no se podría medir"
  exit 1
fi

# ── lo esperado, de las tablas del propio .ps1 ────────────────────────────────────────────────────────────────
lab_env "$GUARD" -- node "$CLONE/scripts/lib/tycon-config.js" integrations --json > "$T/integrations.json" 2> "$T/integrations.err"
[ $? -eq 0 ] || { echo "❌ installer-ps1: el lector de configuración no contestó en el laboratorio: $(brief "$T/integrations.err")"; exit 1; }
cat > "$T/check.js" <<'JS'
'use strict';
// check.js — lo que el aplicador .ps1 tiene que dejar, leído de LA lista de hooks (story 8.17, W3 y W4: el .ps1 ya no
// lleva tablas propias; llama a scripts/setup/apply-hooks.js, que lee scripts/setup/hooks-list.json).
//   listing <lista> <clon> <integraciones.json> <salida de -Check>     el listado de -Check nombra exactamente lo que falta
//   settings <lista> <clon> <integraciones.json> <settings.json> <queda.json>   cada hook esperado UNA vez; sin ellos, queda igual a <queda.json>
// Lo esperado en Windows: los registros con `platforms.windows !== false`, decididos por su `when` con una lógica escrita
// ACÁ (no la de apply-hooks.js: si saliera de ahí, un error de su decisión no se vería) para la configuración de
// laboratorio, que no trae perfil (= full): `always` va; `integration:<llave>` con la llave en true (y su `override`,
// puesto, por encima en los dos sentidos); `optin:<VAR>` con `default` on salvo VAR=0, u off sólo con VAR=1; `needs`
// (el plugin de Telegram) no está en el laboratorio. Y el archivo tiene que estar en el clon.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const [mode, listFile, clone, integFile, a, b] = process.argv.slice(2);
const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const integ = JSON.parse(fs.readFileSync(integFile, 'utf8'));

// CHECK_VARS="VAR=valor VAR2=valor" son las variables de la corrida que se juzga (vacío: lo de fábrica).
const vars = {};
for (const kv of String(process.env.CHECK_VARS || '').split(/\s+/).filter(Boolean)) { const i = kv.indexOf('='); vars[kv.slice(0, i)] = kv.slice(i + 1); }
const isOn = (h) => {
  const [kind, arg] = [h.when.slice(0, h.when.indexOf(':') < 0 ? h.when.length : h.when.indexOf(':')), h.when.slice(h.when.indexOf(':') + 1)];
  if (kind === 'always') return true;
  if (kind === 'integration') return h.override && vars[h.override] ? vars[h.override] !== '0' : integ[arg] === true;
  if (h.needs) return false;
  return h.default === 'on' ? vars[arg] !== '0' : vars[arg] === '1';
};
// `@tcg:x` vive en scripts/hooks/ del clon; lo demás, en skills/. El comando termina en esa ruta, entre comillas.
const tailOf = (spec) => (spec.startsWith('@tcg:') ? `/scripts/hooks/${spec.slice(5)}"` : `/skills/${spec}"`);
// el intérprete sale de la extensión: un .js con `node "`, un .sh con `bash "` (W3W4)
const headOf = (spec) => (spec.endsWith('.sh') ? 'bash "' : 'node "');

const expected = [];   // { event, matcher, relpath (el spec) }
for (const h of list.hooks) {
  if (h.platforms && h.platforms.windows === false) continue;   // Windows lo deja afuera (windows-support.json)
  const file = h.spec.startsWith('@tcg:') ? path.join(clone, 'scripts', 'hooks', h.spec.slice(5)) : path.join(clone, 'skills', h.spec);
  if (!fs.existsSync(file)) continue;                       // el guion no está en el clon: no se espera
  if (!isOn(h)) continue;                                   // su integración o su variable lo deja apagado
  expected.push({ event: h.event, matcher: h.matcher || '', relpath: h.spec });
}
if (expected.length < 10) { console.log(`sólo ${expected.length} hooks esperados: no leí bien ${listFile}`); process.exit(2); }

const norm = (m) => String(m || '').split('|').map((x) => x.trim()).filter(Boolean).sort().join('|');
const isCmdOf = (cmd, e) => cmd.startsWith(headOf(e.relpath)) && cmd.endsWith(tailOf(e.relpath));
const isOurs = (event, hook) => {
  const cmd = hook && typeof hook.command === 'string' ? hook.command : '';
  return expected.some((e) => e.event === event && isCmdOf(cmd, e));
};
const bad = [];

if (mode === 'listing') {
  const out = fs.readFileSync(a, 'utf8');
  const head = /(\d+) hooks faltan en/.exec(out);
  const listed = [...out.matchAll(/^ {2}\+ (\S+) \(matcher='([^']*)'\) \S+ (\S+) {2}\[/gm)].map((m) => `${m[1]}|${m[2] === '*' ? '' : norm(m[2])}|${m[3]}`).sort();
  const want = expected.map((e) => `${e.event}|${norm(e.matcher)}|${e.relpath}`).sort();
  if (!head) bad.push('no dice «N hooks faltan»');
  else if (Number(head[1]) !== want.length) bad.push(`dice que faltan ${head[1]} y son ${want.length}`);
  for (const w of want) if (!listed.includes(w)) bad.push(`no nombra ${w}`);
  for (const l of listed) if (!want.includes(l)) bad.push(`nombra de más ${l}`);
} else if (mode === 'settings') {
  const got = JSON.parse(fs.readFileSync(a, 'utf8'));
  const hooks = (got && got.hooks) || {};
  for (const e of expected) {
    let n = 0;
    for (const entry of hooks[e.event] || []) {
      if (norm(entry.matcher) !== norm(e.matcher)) continue;
      for (const h of entry.hooks || []) {
        const cmd = h && typeof h.command === 'string' ? h.command : '';
        if (isCmdOf(cmd, e)) n++;
      }
    }
    if (n !== 1) bad.push(`${e.event} (${e.matcher || '*'}) ${e.relpath}: está ${n} veces`);
  }
  // sin lo que el aplicador agrega, queda lo de antes: mismas claves, mismos valores, mismo orden
  const stripped = JSON.parse(JSON.stringify(got));
  const left = JSON.parse(fs.readFileSync(b, 'utf8'));
  for (const event of Object.keys(stripped.hooks || {})) {
    const bucket = [];
    for (const entry of stripped.hooks[event]) {
      if (!Array.isArray(entry.hooks)) { bucket.push(entry); continue; }
      const mine = entry.hooks.filter((h) => !isOurs(event, h));
      if (mine.length === 0 && entry.hooks.length > 0) continue;   // un bloque que sólo tiene hooks del arnés
      entry.hooks = mine; bucket.push(entry);
    }
    if (bucket.length === 0 && !(left.hooks && event in left.hooks)) delete stripped.hooks[event];
    else stripped.hooks[event] = bucket;
  }
  try { assert.deepStrictEqual(stripped, left); } catch (e) {
    bad.push('perdió o cambió algo de lo que había: ' + String(e.message).split('\n').slice(0, 12).join(' ⏎ '));
  }
} else { console.log(`modo desconocido: ${mode}`); process.exit(2); }

if (bad.length) { console.log(bad.slice(0, 6).join(' · ')); process.exit(1); }
console.log(`${expected.length} hooks`);
JS
check() { # <modo> <archivo…>: una línea con lo que encontró; exit 0 sólo si cumple (con el node de verdad, sin anotar)
  # INTEG_FILE=<otro integrations.json> y CHECK_VARS="VAR=valor …" delante de la llamada: las integraciones y las variables de ESA corrida (W3a)
  node "$T/check.js" "$1" "$HOOKS_LIST" "$CLONE" "${INTEG_FILE:-$T/integrations.json}" "${@:2}" 2>&1 | head -3 | tr '\n' ' '
  return "${PIPESTATUS[0]}"
}

# ── La suite corre por partes (2026-10-14, public-ci: tardaba ~440 s en el agente de GitHub y en uno lento pasó los
# 900 s del tope, a punto de terminar). Entera —a mano— corre todos los bloques; como parte
# (`installer-ps1.p<k>.test.sh`), sólo los suyos. Lo de afuera de los bloques —el laboratorio de arriba y las
# funciones y listas de la tanda W3a— corre siempre: un bloque no puede depender de lo que dejó otro
# (scripts/tests/lib/suite-parts.sh). La parte 1 va de (a) a (r); la 2, de (u) al final.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/suite-parts.sh"
suite_parts 2
if suite_part 1; then   # ── parte 1 de 2: de (a) a (k) ──

# ═══ (a) -Check sobre una HOME vacía: exit 0, lista lo que falta, no escribe nada ═══════════════════════════════
HA="$(new_home check-empty)"
BEFORE="$(listing "$HA")"
: > "$NODE_CALLS"
installer "$HA" -- -Check > "$T/a.out" 2>&1; RC=$?
AFTER="$(listing "$HA")"
if [ "$RC" -eq 0 ]; then ok "(a) -Check sobre una HOME sin settings.json sale 0"
else no "(a) -Check sobre una HOME sin settings.json salió $RC: $(brief "$T/a.out")"; fi
R="$(check listing "$T/a.out")"; CK=$?
if [ "$CK" -eq 0 ]; then ok "(a) -Check lista lo que falta: los ${R% } que el clon trae, ni uno más"
else no "(a) -Check no lista lo que falta: ${R}·$(brief "$T/a.out" 200)"; fi
if [ "$BEFORE" = "$AFTER" ] && [ -z "$AFTER" ]; then ok "(a) -Check no escribió nada: la HOME sigue vacía"
else no "(a) -Check escribió en la HOME: $(echo "$AFTER" | head -5 | tr '\n' ' ')"; fi
# hallazgo 3: sin el enlace todavía, la revisión de terceros mira el clon (como el resto de la corrida), no un enlace que no existe
if grep -qF "install-third-party.js --repo $CLONE --check" "$NODE_CALLS" && ! grep -q "install-third-party.js --repo $HA/" "$NODE_CALLS"; then
  ok "(a) -Check sin el enlace: el paso de terceros recibe el clon (--repo <clon> --check)"
else no "(a) -Check sin el enlace: el paso de terceros recibió «$(grep 'install-third-party.js' "$NODE_CALLS" | sed 's/.*install-third-party.js//' | head -1)» (esperaba --repo $CLONE --check)"; fi

# ═══ (b) sin -Check sobre una HOME vacía: exit 0 y los hooks registrados ════════════════════════════════════════
HB="$(new_home install-empty)"
printf '{\n  "$schema": "https://json.schemastore.org/claude-code-settings.json",\n  "hooks": {}\n}\n' > "$T/b.left.json"
: > "$NODE_CALLS"
T0=$SECONDS
installer "$HB" > "$T/b.out" 2>&1; RC=$?
ELAPSED_INSTALL=$((SECONDS - T0))
R="$(check settings "$HB/.claude/settings.json" "$T/b.left.json")"; CK=$?
if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ]; then ok "(b) sin -Check sobre una HOME vacía: sale 0 y registra los ${R% }, cada uno una vez"
else no "(b) sin -Check sobre una HOME vacía (rc $RC): ${R}·$(brief "$T/b.out")"; fi
# el espejo del hallazgo 3: la llamada de siempre al paso de terceros no cambió
if grep -qF "install-third-party.js --repo $HB/.claude/agent-skills" "$NODE_CALLS" && ! grep -q 'install-third-party.js.*--check' "$NODE_CALLS"; then
  ok "(b) el espejo: instalando, el paso de terceros recibe el enlace de siempre (--repo ~/.claude/agent-skills, sin --check)"
else no "(b) instalando, el paso de terceros recibió «$(grep 'install-third-party.js' "$NODE_CALLS" | sed 's/.*install-third-party.js//' | head -1)»"; fi
# lo sano: sobre lo ya instalado, una segunda corrida no cambia settings.json y -Check no encuentra nada que falte
cp "$HB/.claude/settings.json" "$T/b.settings.json"
installer "$HB" > "$T/b2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$HB/.claude/settings.json" "$T/b.settings.json"; then ok "(b) una segunda corrida sale 0 y deja settings.json byte a byte igual (reconoce lo ya registrado)"
else no "(b) una segunda corrida (rc $RC) cambió settings.json o falló: $(brief "$T/b2.out")"; fi
: > "$NODE_CALLS"
installer "$HB" -- -Check > "$T/b3.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && ! grep -q 'hooks faltan' "$T/b3.out" && cmp -s "$HB/.claude/settings.json" "$T/b.settings.json" \
   && grep -qF "install-third-party.js --repo $HB/.claude/agent-skills --check" "$NODE_CALLS"; then
  ok "(b) -Check sobre lo ya instalado: sale 0, no falta nada, no toca settings.json, y el paso de terceros mira el enlace"
else no "(b) -Check sobre lo ya instalado (rc $RC): $(grep -c 'hooks faltan' "$T/b3.out") aviso(s) de faltantes · $(brief "$T/b3.out" 200)"; fi

# el hermano del caso de la HOME vacía: un settings.json que EXISTE y está vacío (0 bytes: una escritura truncada, un
# `touch`). El .sh y startup-line.js lo leen como `{}`; el .ps1 salía 1 con un error de PowerShell, con y sin -Check.
HZ="$(new_home zero-bytes)"; mkdir -p "$HZ/.claude"; : > "$HZ/.claude/settings.json"; echo '{"hooks": {}}' > "$T/z.left.json"
BEFORE="$(listing "$HZ")"
installer "$HZ" -- -Check > "$T/z1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'hooks faltan' "$T/z1.out" && [ "$(listing "$HZ")" = "$BEFORE" ]; then ok "(b) -Check sobre un settings.json de 0 bytes: sale 0, lista lo que falta y no escribe nada"
else no "(b) -Check sobre un settings.json de 0 bytes (rc $RC): $(brief "$T/z1.out")"; fi
installer "$HZ" > "$T/z2.out" 2>&1; RC=$?
R="$(check settings "$HZ/.claude/settings.json" "$T/z.left.json")"; CK=$?
if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ]; then ok "(b) sin -Check sobre un settings.json de 0 bytes: sale 0 y registra los ${R% }, como en una HOME vacía"
else no "(b) sin -Check sobre un settings.json de 0 bytes (rc $RC): ${R}·$(brief "$T/z2.out")"; fi

# ═══ (c) sin -Check sobre el settings.json que deja `harness.js install` en una HOME limpia ═════════════════════
# sólo trae hooks.SessionStart con la línea de arranque (startup-line.js, rama addIfMissing); el aplicador corre como
# lo lanza harness.js: con el candado tomado y la copia hecha
HC="$(new_home startup-line)"
cat > "$T/make-settings.js" <<'JS'
const path = require('path');
const [clone, home] = process.argv.slice(2);
const sl = require(path.join(clone, 'scripts', 'setup', 'harness', 'startup-line.js'));
const r = sl.migrate(path.join(home, '.claude', 'settings.json'), { home, platform: 'win32', nodeOk: true, addIfMissing: true, backup: false });
if (!r.changed) { console.log(r.reason); process.exit(1); }
JS
if lab_env "$HC" -- "$REAL_NODE" "$T/make-settings.js" "$CLONE" "$HC" > "$T/c.make.out" 2>&1 \
   && [ "$(node -e 'const s=require(process.argv[1]);console.log(Object.keys(s).join()+"/"+Object.keys(s.hooks).join()+"/"+s.hooks.SessionStart.length)' "$HC/.claude/settings.json")" = "hooks/SessionStart/1" ]; then
  cp "$HC/.claude/settings.json" "$T/c.left.json"
  ln -s "$CLONE" "$HC/.claude/agent-skills"   # harness.js install deja el enlace antes de lanzar el aplicador
  installer "$HC" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_GIT_BASH_HEALTH=1 "TYCON_HARNESS_SNAPSHOT_DIR=$T/tmp" > "$T/c.out" 2>&1; RC=$?
  R="$(check settings "$HC/.claude/settings.json" "$T/c.left.json")"; CK=$?
  if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ]; then ok "(c) sobre el settings.json de una instalación limpia (sólo hooks.SessionStart): sale 0, registra los ${R% } y la línea de arranque queda intacta"
  else no "(c) sobre el settings.json de una instalación limpia (rc $RC): ${R}·$(brief "$T/c.out")"; fi
  FIRST="$(node -e 'const s=require(process.argv[1]),o=require(process.argv[2]);console.log(JSON.stringify(s.hooks.SessionStart[0].hooks[0])===JSON.stringify(o.hooks.SessionStart[0].hooks[0])?"same":"moved")' "$HC/.claude/settings.json" "$T/c.left.json" 2>&1)"
  if [ "$FIRST" = same ]; then ok "(c) la línea de arranque sigue primera en SessionStart, con sus mismas claves"
  else no "(c) la línea de arranque ya no es la primera de SessionStart, o cambió ($FIRST)"; fi
else
  no "(c) no pude armar el settings.json de partida con startup-line.js: $(brief "$T/c.make.out")"
fi

# ═══ (d) el espejo: un settings.json con hooks en varios eventos y claves propias no pierde nada ════════════════
HD="$(new_home team-settings)"; mkdir -p "$HD/.claude"; ln -s "$CLONE" "$HD/.claude/agent-skills"
cat > "$HD/.claude/settings.json" <<'JSON'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "opus",
  "env": { "LAB_FLAG": "1", "LAB_EMPTY": "" },
  "permissions": { "allow": ["Bash(ls:*)", "Read(//tmp/**)"], "deny": [], "defaultMode": "acceptEdits" },
  "statusLine": { "type": "command", "command": "echo lab", "padding": 0 },
  "labOwnKey": { "nested": [1, 2.5, { "a": null, "b": false }], "text": "ñandú — «comillas» <a&b> 'x'" },
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "echo lab-session-start", "timeout": 5 } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "echo lab-prompt" } ] } ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo lab-pre-bash" } ] },
      { "matcher": "Write|Edit", "hooks": [ { "type": "command", "command": "echo lab-pre-edit" } ] }
    ],
    "PostToolUse": [ { "matcher": "Read", "hooks": [ { "type": "command", "command": "echo lab-post-read" } ] } ],
    "Notification": [ { "hooks": [ { "type": "command", "command": "echo lab-notification" } ] } ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "echo lab-stop" } ] } ]
  }
}
JSON
cp "$HD/.claude/settings.json" "$T/d.left.json"
installer "$HD" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_GIT_BASH_HEALTH=1 > "$T/d.out" 2>&1; RC=$?
R="$(check settings "$HD/.claude/settings.json" "$T/d.left.json")"; CK=$?
if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ]; then ok "(d) el espejo: un settings.json con hooks en seis eventos y claves propias sale 0, suma los ${R% } y no pierde nada"
else no "(d) un settings.json con hooks y claves propias (rc $RC): ${R}·$(brief "$T/d.out")"; fi

# ═══ (e) la clase entera: bloques sin `hooks`, hooks sin `command` ══════════════════════════════════════════════
# las otras guardas de la misma forma: un bloque sin `hooks` se conserva; uno con el matcher de un hook del arnés lo recibe
HE="$(new_home odd-shapes)"; mkdir -p "$HE/.claude"; ln -s "$CLONE" "$HE/.claude/agent-skills"
cat > "$HE/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell" },
      { "matcher": "Read", "hooks": [ { "type": "prompt", "prompt": "un hook sin command" } ] }
    ],
    "PostToolUse": [ { "matcher": "Glob" } ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "echo lab-stop" } ] } ]
  }
}
JSON
# lo que queda sin los hooks del arnés: todo, menos el bloque `Bash|PowerShell` que estaba vacío y ahora es del arnés
cat > "$T/e.left.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [ { "matcher": "Read", "hooks": [ { "type": "prompt", "prompt": "un hook sin command" } ] } ],
    "PostToolUse": [ { "matcher": "Glob" } ],
    "Stop": [ { "hooks": [ { "type": "command", "command": "echo lab-stop" } ] } ]
  }
}
JSON
installer "$HE" TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_GIT_BASH_HEALTH=1 > "$T/e.out" 2>&1; RC=$?
R="$(check settings "$HE/.claude/settings.json" "$T/e.left.json")"; CK=$?
if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ]; then ok "(e) bloques sin «hooks» y un hook sin «command»: sale 0, registra los ${R% } y conserva lo que había"
else no "(e) bloques sin «hooks» y un hook sin «command» (rc $RC): ${R}·$(brief "$T/e.out")"; fi

# ═══ (f) llamado por el enlace `~/.claude/tycon-harness`: ningún hook dos veces (story 8.18, AC 36) ═══════
# El par del arreglo del `.sh`: aquél reconocía sus hooks por la ruta con que lo llamaban y, llamado por el enlace,
# registraba 32 por segunda vez (ensayo del alta, 2026-10-03). El `.ps1` los reconoce por la ruta DENTRO del repo: da
# lo mismo por dónde se llegue. Acá queda medido, en los dos órdenes, para que nadie lo «arregle» a la ruta absoluta.
# (pwsh no resuelve el enlace: `$PSScriptRoot` es la ruta con que se lo llamó — medido el 2026-10-04.)
BY_LINK="$HB/.claude/tycon-harness/scripts/install-tycon-hooks.ps1"
if [ -L "$HB/.claude/tycon-harness" ] && [ -f "$BY_LINK" ]; then
  PS1_ENTRY="$BY_LINK" installer "$HB" > "$T/f1.out" 2>&1; RC=$?
  if [ "$RC" -eq 0 ] && cmp -s "$HB/.claude/settings.json" "$T/b.settings.json"; then ok "(f) por el enlace, sobre lo que registró la carpeta del clon: sale 0 y settings.json queda byte a byte igual (nada dos veces)"
  else no "(f) por el enlace (rc $RC) cambió settings.json o falló: $(brief "$T/f1.out")"; fi
  PS1_ENTRY="$BY_LINK" installer "$HB" -- -Check > "$T/f2.out" 2>&1; RC=$?
  if [ "$RC" -eq 0 ] && ! grep -q 'hooks faltan' "$T/f2.out"; then ok "(f) por el enlace con -Check: no dice que falte ningún hook"
  else no "(f) por el enlace con -Check (rc $RC): $(grep 'hooks faltan' "$T/f2.out" | head -1 | cut -c1-200)"; fi
else
  no "(f) la instalación de (b) no dejó el enlace ~/.claude/tycon-harness: no hay por dónde llamarlo"
fi
# el orden inverso: una HOME que sólo tiene el enlace; primero por el enlace, después por la carpeta del clon
HF="$(new_home by-link)"; mkdir -p "$HF/.claude"; ln -s "$CLONE" "$HF/.claude/tycon-harness"
PS1_ENTRY="$HF/.claude/tycon-harness/scripts/install-tycon-hooks.ps1" installer "$HF" > "$T/f3.out" 2>&1; RC=$?
N_BY_LINK="$(grep -c "\"node \\\\\"$HF/.claude/tycon-harness/scripts/hooks/" "$HF/.claude/settings.json" 2>/dev/null || true)"
if [ "$RC" -eq 0 ] && [ "${N_BY_LINK:-0}" -ge 10 ]; then ok "(f) la vara del orden inverso: llamado por el enlace, registra sus hooks con la ruta del enlace ($N_BY_LINK)"
else no "(f) la vara del orden inverso (rc $RC): ${N_BY_LINK:-0} hooks con la ruta del enlace — $(brief "$T/f3.out")"; fi
cp "$HF/.claude/settings.json" "$T/f.settings.json" 2>/dev/null
installer "$HF" > "$T/f4.out" 2>&1; RC=$?
R="$(check settings "$HF/.claude/settings.json" "$T/b.left.json")"; CK=$?
if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ] && cmp -s "$HF/.claude/settings.json" "$T/f.settings.json"; then ok "(f) orden inverso: después, por la carpeta del clon, los ${R% } siguen una vez cada uno y settings.json no cambia"
else no "(f) orden inverso (rc $RC): ${R}·$(brief "$T/f4.out")"; fi

# ═══ (g) la máquina del equipo en la transición: el .ps1 calla, y la carpeta desconocida avisa (story 8.18, AC 28) ═
# Dos clones: `~/.claude/agent-skills` es un clon real (carpeta con `.git`, `skills/tycon-pipeline` y `agents/`) y
# `skills` y `agents` son enlaces a su interior; el clon del arnés ya trae `skills/` y `agents/`. Callar lo decide
# canonical-path.js (`separateSkillsClone`), igual para el `.sh` (harness-install.test.sh, T29) y para este archivo: acá
# se ejecuta el `.ps1`. En Windows los enlaces son junctions: eso sigue NO MEDIDO.
HT="$(new_home transition)"; OLD_CLONE="$HT/.claude/agent-skills"
mkdir -p "$OLD_CLONE/.git" && cp -R "$CLONE/skills" "$OLD_CLONE/skills" && cp -R "$CLONE/agents" "$OLD_CLONE/agents"
ln -s "$OLD_CLONE/skills" "$HT/.claude/skills"; ln -s "$OLD_CLONE/agents" "$HT/.claude/agents"; ln -s "$CLONE" "$HT/.claude/tycon-claude-guides"
said_links() { grep -c -e 'hay una carpeta real' -e 'no lo muevo' -e 'apunta a otro lado' "$1" || true; }   # <salida>: las líneas de los enlaces del repo único
links_of() { ( cd "$1/.claude" && for n in agent-skills skills agents; do if [ -L "$n" ]; then echo "$n -> $(readlink "$n")"; elif [ -d "$n" ]; then echo "$n = carpeta"; else echo "$n = falta"; fi; done ); }
LINKS_BEFORE="$(links_of "$HT")"
installer "$HT" > "$T/g1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(said_links "$T/g1.out")" = 0 ] && [ "$(links_of "$HT")" = "$LINKS_BEFORE" ]; then ok "(g) dos clones (la transición): el .ps1 sale 0, no dice nada de los enlaces y no mueve ninguno"
else no "(g) dos clones (rc $RC): $(said_links "$T/g1.out") línea(s) sobre los enlaces — $(grep -e 'carpeta real' -e 'no lo muevo' "$T/g1.out" | head -2 | tr '\n' ' ' | cut -c1-300) · enlaces: $(links_of "$HT" | tr '\n' ' ')"; fi
if grep -q "\"node \\\\\"$HT/.claude/agent-skills/skills/tycon-pipeline/scripts/" "$HT/.claude/settings.json" 2>/dev/null; then ok "(g) …y los hooks de las skills nombran la ruta fija ~/.claude/agent-skills (el clon viejo), como hoy"
else no "(g) los hooks de las skills no nombran ~/.claude/agent-skills: $(grep -m1 'tycon-pipeline/scripts' "$HT/.claude/settings.json" | cut -c1-200)"; fi
installer "$HT" -- -Check > "$T/g2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(said_links "$T/g2.out")" = 0 ]; then ok "(g) …también con -Check"
else no "(g) dos clones con -Check (rc $RC): $(grep -e 'carpeta real' -e 'no lo muevo' "$T/g2.out" | head -2 | tr '\n' ' ' | cut -c1-300)"; fi
# (error) callar vale sólo para el estado conocido: la misma carpeta SIN su .git no es un clon de agent-skills
rmdir "$OLD_CLONE/.git"
installer "$HT" > "$T/g3.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(grep -c 'hay una carpeta real, no un enlace: no la piso' "$T/g3.out")" = 1 ] && [ "$(links_of "$HT")" = "$LINKS_BEFORE" ]; then ok "(g) (error) una carpeta real que NO es un clon de agent-skills: el .ps1 avisa como siempre, y no la pisa"
else no "(g) (error) carpeta desconocida (rc $RC): $(grep -c 'no la piso' "$T/g3.out") aviso(s) — $(brief "$T/g3.out" 200)"; fi

# ═══ (h) Windows queda con la llave apagada: la máquina le gana al perfil (story 8.18, AC 38 · T40) ═════════════
# Decisión del dueño (2026-10-03): las máquinas Windows del equipo no re-apuntan su clon viejo hasta probar una, con él
# mirando. Cómo: `update.skills_source: separate` en el `tycon.json` de la máquina, que le gana al perfil del equipo el
# día que el perfil diga `unified`. La clave la lee el mismo lector en los tres sistemas (Node); el `.ps1` no re-apunta
# nada por su cuenta. Lo que NO mide: una máquina Windows de verdad (ida y vuelta con el dueño mirando: pendiente).
printf '{ "update": { "skills_source": "unified" } }\n' > "$T/lab-profile.json"   # un perfil de laboratorio: el del equipo no se toca
HK="$(new_home key-off)"; mkdir -p "$HK/.claude"; printf '{ "update": { "skills_source": "separate" } }\n' > "$HK/.claude/tycon.json"
KEY="$(lab_env "$HK" "TYCON_PROFILE=$T/lab-profile.json" -- "$REAL_NODE" "$CLONE/scripts/lib/tycon-config.js" get update.skills_source 2> "$T/h1.err")"; RC=$?
lab_env "$HK" "TYCON_PROFILE=$T/lab-profile.json" -- "$REAL_NODE" "$CLONE/scripts/lib/tycon-config.js" explain > "$T/h1.explain" 2>&1
if [ "$RC" -eq 0 ] && [ "$KEY" = separate ] && grep -q 'update\.skills_source = .*separate.*(maquina' "$T/h1.explain"; then ok "(h) con el perfil en unified y la máquina en separate, la llave queda en separate, y explain dice que viene de la máquina"
else no "(h) la máquina no le gana al perfil (rc $RC): la llave dio «${KEY}» — $(grep 'skills_source' "$T/h1.explain" | head -1) $(brief "$T/h1.err" 160)"; fi
HK2="$(new_home key-on)"
KEY="$(lab_env "$HK2" "TYCON_PROFILE=$T/lab-profile.json" -- "$REAL_NODE" "$CLONE/scripts/lib/tycon-config.js" get update.skills_source 2> "$T/h2.err")"; RC=$?
if [ "$RC" -eq 0 ] && [ "$KEY" = unified ]; then ok "(h) el espejo: sin esa línea en la máquina, la del perfil vale (unified)"
else no "(h) el espejo (rc $RC): sin la línea de la máquina la llave dio «${KEY}» (esperaba unified) $(brief "$T/h2.err" 160)"; fi
# el .ps1 con la llave apagada y el perfil en unified: la transición sigue como en (g), y el clon viejo no se toca
mkdir -p "$OLD_CLONE/.git"; cp "$HK/.claude/tycon.json" "$HT/.claude/tycon.json"
OLD_BEFORE="$(listing "$OLD_CLONE")"
installer "$HT" "TYCON_PROFILE=$T/lab-profile.json" > "$T/h3.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(said_links "$T/h3.out")" = 0 ] && [ "$(links_of "$HT")" = "$LINKS_BEFORE" ] && [ "$(listing "$OLD_CLONE")" = "$OLD_BEFORE" ]; then ok "(h) el .ps1 con el perfil en unified y la máquina en separate: calla, no mueve un enlace y no toca el clon viejo"
else no "(h) el .ps1 con la llave apagada (rc $RC): $(brief "$T/h3.out" 240)"; fi
# por lectura: ninguno de los dos instaladores cambia el remoto de un clon (re-apuntar vive en Node: harness.js)
if ! grep -q -e 'set-url' -e 'skills_source' "$PS1_INSTALLER" "$ROOT/scripts/install-tycon-hooks.sh"; then ok "(h) por lectura: ni el .ps1 ni el .sh leen la llave ni cambian el remoto de un clon (re-apuntar y deshacer viven en Node, igual en los tres sistemas)"
else no "(h) un instalador nombra la llave o cambia un remoto: $(grep -n -e 'set-url' -e 'skills_source' "$PS1_INSTALLER" "$ROOT/scripts/install-tycon-hooks.sh" | head -2 | cut -c1-200)"; fi

# ═══ (i) dónde están las skills: el .ps1 le pregunta a la regla, y lo que escribe nombra lo instalado (8.18, AC 12) ═
# El par del cambio del `.sh` (harness-install.test.sh, CANARY): el `.ps1` traía la ruta de las skills escrita; ahora se la
# pregunta a scripts/lib/skills-dir.js con la variante de quien ESCRIBE (`--installed`) y sin la variable. Este archivo
# no corre las suites rápidas: sólo escribe. Lo que se mide acá, por ejecución con pwsh: que pregunta; que en la máquina
# de dos clones los hooks siguen nombrando ~/.claude/agent-skills aunque TYCON_SKILLS_DIR apunte al clon de trabajo
# (hallazgo I12: si escribiera con la regla de quien lee, cambiarían los hooks registrados); y que sin skills en ningún
# lado sale 1 con la línea de siempre. En Windows: NO MEDIDO.
# 🔴 rojo previo (medido sobre 4e0c60a7, 2026-10-04): el .ps1 no llamaba a skills-dir.js.
HV="$(new_home skills-rule)"; OLD_V="$HV/.claude/agent-skills"
mkdir -p "$OLD_V/.git" && cp -R "$CLONE/skills" "$OLD_V/skills" && cp -R "$CLONE/agents" "$OLD_V/agents"
ln -s "$OLD_V/skills" "$HV/.claude/skills"; ln -s "$OLD_V/agents" "$HV/.claude/agents"; ln -s "$CLONE" "$HV/.claude/tycon-claude-guides"
: > "$NODE_CALLS"
installer "$HV" "TYCON_SKILLS_DIR=$CLONE/skills" > "$T/i1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -qF "scripts/lib/skills-dir.js --skills --installed" "$NODE_CALLS"; then ok "(i) el .ps1 le pregunta a skills-dir.js dónde están las skills, con la variante de quien escribe (--skills --installed)"
else no "(i) el .ps1 (rc $RC) no llamó a skills-dir.js --skills --installed: «$(grep 'skills-dir' "$NODE_CALLS" | head -2 | tr '\n' ' ' | cut -c1-200)» $(brief "$T/i1.out" 160)"; fi
N_INSTALLED="$(grep -c "\"node \\\\\"$HV/.claude/agent-skills/skills/" "$HV/.claude/settings.json" 2>/dev/null || true)"
N_CLONE="$(grep -c "\"node \\\\\"$CLONE/skills/" "$HV/.claude/settings.json" 2>/dev/null || true)"
if [ "${N_INSTALLED:-0}" -ge 5 ] && [ "${N_CLONE:-1}" = 0 ]; then ok "(i) el espejo (I12): con dos clones y TYCON_SKILLS_DIR en el clon de trabajo, los $N_INSTALLED hooks de las skills nombran ~/.claude/agent-skills; ninguno, el clon"
else no "(i) con dos clones y la variable en el clon de trabajo: ${N_INSTALLED:-0} hooks nombran lo instalado y ${N_CLONE:-?} el clon de trabajo"; fi
# (error) un clon SIN skills/ y una HOME sin agent-skills: sale 1 con la línea de siempre, y no registra un solo hook
BARE="$T/clone-bare"; mkdir -p "$BARE"; cp -R "$CLONE/scripts" "$BARE/scripts"; cp -R "$CLONE/claude-md-blocks" "$BARE/claude-md-blocks"
HN="$(new_home no-skills)"
PS1_ENTRY="$BARE/scripts/install-tycon-hooks.ps1" installer "$HN" > "$T/i2.out" 2>&1; RC=$?
# (pwsh parte el texto de un Write-Error en varios renglones: la frase y la ruta se buscan en la salida, no en un renglón)
if [ "$RC" -eq 1 ] && grep -q 'agent-skills no encontrado' "$T/i2.out" && grep -qF "$HN/.claude/agent-skills/skills" "$T/i2.out" \
   && ! grep -q '"command": "node ' "$HN/.claude/settings.json" 2>/dev/null; then
  ok "(i) (error) un clon sin skills/ y sin ~/.claude/agent-skills: el .ps1 sale 1, dice «agent-skills no encontrado» con dónde las buscó, y no registra ningún hook"
else no "(i) (error) sin skills en ningún lado (rc $RC): $(grep -c 'agent-skills no encontrado' "$T/i2.out") mención(es) — $(brief "$T/i2.out" 240)"; fi

# ═══ (j) llamado por la misma carpeta escrita con otras mayúsculas: ningún hook dos veces (8.18, tramo 3 · clase 14) ═
# El par del arreglo del `.sh` (installer-repeated-hooks.test.sh, CASE): en un disco que no distingue mayúsculas, aquél
# comparaba la ruta real letra por letra y, llamado por la misma carpeta en otra caja, registró 27 hooks por segunda
# vez. El `.ps1` reconoce sus hooks por la ruta DENTRO del repo y sin mirar la caja: la carpeta por la que se llega no
# entra en la comparación. Acá queda medido con pwsh, en los dos órdenes (es la vara: no tenía el defecto, y que nadie se
# lo ponga). En un disco que SÍ distingue mayúsculas la otra ruta no existe: NO MEDIDO.
OTHER_CLONE="$T/CLONE"
if [ "$OTHER_CLONE/scripts/install-tycon-hooks.ps1" -ef "$CLONE/scripts/install-tycon-hooks.ps1" ]; then
  PS1_ENTRY="$OTHER_CLONE/scripts/install-tycon-hooks.ps1" installer "$HB" > "$T/j1.out" 2>&1; RC=$?
  if [ "$RC" -eq 0 ] && cmp -s "$HB/.claude/settings.json" "$T/b.settings.json"; then ok "(j) por la misma carpeta en otra caja, sobre lo ya registrado: sale 0 y settings.json queda byte a byte igual (nada dos veces)"
  else no "(j) por la otra caja (rc $RC) cambió settings.json o falló: $(brief "$T/j1.out")"; fi
  PS1_ENTRY="$OTHER_CLONE/scripts/install-tycon-hooks.ps1" installer "$HB" -- -Check > "$T/j2.out" 2>&1; RC=$?
  if [ "$RC" -eq 0 ] && ! grep -q 'hooks faltan' "$T/j2.out"; then ok "(j) por la otra caja con -Check: no dice que falte ningún hook"
  else no "(j) por la otra caja con -Check (rc $RC): $(grep 'hooks faltan' "$T/j2.out" | head -1 | cut -c1-200)"; fi
  # el orden inverso: una HOME instalada por la otra caja; después, por la carpeta del clon
  HJ="$(new_home other-case)"
  PS1_ENTRY="$OTHER_CLONE/scripts/install-tycon-hooks.ps1" installer "$HJ" > "$T/j3.out" 2>&1; RC=$?
  N_OTHER="$(grep -c "\"node \\\\\"$OTHER_CLONE/scripts/hooks/" "$HJ/.claude/settings.json" 2>/dev/null || true)"
  if [ "$RC" -eq 0 ] && [ "${N_OTHER:-0}" -ge 10 ]; then ok "(j) la vara del orden inverso: llamado por la otra caja, registra sus hooks con esa ruta ($N_OTHER)"
  else no "(j) la vara del orden inverso (rc $RC): ${N_OTHER:-0} hooks con la ruta en otra caja — $(brief "$T/j3.out")"; fi
  cp "$HJ/.claude/settings.json" "$T/j.settings.json" 2>/dev/null
  installer "$HJ" > "$T/j4.out" 2>&1; RC=$?
  R="$(check settings "$HJ/.claude/settings.json" "$T/b.left.json")"; CK=$?
  if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ] && cmp -s "$HJ/.claude/settings.json" "$T/j.settings.json"; then ok "(j) orden inverso: después, por la carpeta del clon, los ${R% } siguen una vez cada uno y settings.json no cambia"
  else no "(j) orden inverso (rc $RC): ${R}·$(brief "$T/j4.out")"; fi
else
  echo "⏭ installer-ps1: NO MEDIDO — (j) este disco distingue mayúsculas: $OTHER_CLONE no es $CLONE"
fi

# ═══ (k) el core.hooksPath local cuya carpeta no está en el disco no es vestigial si el repo la sigue (8.18 · clase 21) ═
# El caso: un clon viejo de agent-skills con `core.hooksPath = .githooks` (el repo sigue esa carpeta, con un hook de
# verdad). Re-apuntado al repo unido, la vista reducida (sparse-checkout) esconde `.githooks/`; el lazo del `.ps1` miraba
# sólo el disco, la dio por vestigial y BORRÓ la clave de `.git/config`; la vuelta no la repuso. Tres respuestas, no
# dos: la carpeta está y se lee → se cuentan sus hooks; no está pero el repo la sigue → no es vestigial, no se toca; no
# se pudo mirar → tampoco se toca, y se dice. El par del `.sh`: installer-repeated-hooks.test.sh (HOOKSPATH).
# Hasta la W4 el lazo del `.ps1` corría sólo cuando la corrida registraba o sacaba un hook (había una salida temprana):
# por eso cada corrida parte de un settings.json sin hooks, como una actualización que trae hooks nuevos. Desde la W4
# (AC 30) no hay salida temprana; partir de cero sigue siendo válido.
gq() { env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_COMMON_DIR GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com git -c core.hooksPath=/dev/null "$@"; }
HP="$(new_home hooks-path)"; OLD_P="$HP/.claude/agent-skills"
mkdir -p "$OLD_P/.githooks" && cp -R "$CLONE/skills" "$OLD_P/skills" && cp -R "$CLONE/agents" "$OLD_P/agents" \
  && printf '#!/bin/sh\n# hook del repo viejo (laboratorio)\nexit 0\n' > "$OLD_P/.githooks/pre-commit" \
  && gq -C "$OLD_P" init -q -b main && gq -C "$OLD_P" add -A >/dev/null 2>&1 && gq -C "$OLD_P" commit -q -m "lab: el repo viejo, con .githooks/pre-commit" \
  && gq -C "$OLD_P" config --local core.hooksPath .githooks || no "(k) no pude armar el clon viejo de laboratorio con .githooks/ y su hooksPath local"
ln -s "$OLD_P/skills" "$HP/.claude/skills"; ln -s "$OLD_P/agents" "$HP/.claude/agents"; ln -s "$CLONE" "$HP/.claude/tycon-claude-guides"
hooks_path() { gq -C "$OLD_P" config --local --get core.hooksPath; }
said_hooks_path() { grep -e 'core.hooksPath LOCAL' -e 'core.hooksPath local' "$1" | tr '\n' ' ' | cut -c1-320; }   # <salida>: lo que el lazo dijo del clon
fresh_run() { printf '{ "hooks": {} }\n' > "$HP/.claude/settings.json"; installer "$HP" > "$1" 2>&1; }   # <salida>: una corrida que registra hooks (llega al lazo)
view_on() {
  gq -C "$OLD_P" config --local core.sparseCheckout true && gq -C "$OLD_P" config --local core.sparseCheckoutCone false \
    && printf '/*\n!/*/\n/agents/\n/skills/\n/packs/\n' > "$OLD_P/.git/info/sparse-checkout" && gq -C "$OLD_P" sparse-checkout reapply
}
view_off() {
  printf '/*\n' > "$OLD_P/.git/info/sparse-checkout" && gq -C "$OLD_P" sparse-checkout reapply \
    && gq -C "$OLD_P" config --local --unset core.sparseCheckout && gq -C "$OLD_P" config --local --unset core.sparseCheckoutCone && rm -f "$OLD_P/.git/info/sparse-checkout"
}
mkdir -p "$HP/.claude"; cp "$OLD_P/.git/config" "$T/k.config.before"
fresh_run "$T/k1.out"; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'core.hooksPath LOCAL con 1 hook(s) reales.*no lo toco' "$T/k1.out" && cmp -s "$T/k.config.before" "$OLD_P/.git/config"; then ok "(k) la vara: con la carpeta en el disco y un hook de verdad, el .ps1 sale 0, dice «no lo toco» y no toca .git/config"
else no "(k) la vara (rc $RC): «$(said_hooks_path "$T/k1.out")» · hooksPath: $(hooks_path)"; fi
if view_on > "$T/k.view.out" 2>&1 && [ ! -e "$OLD_P/.githooks" ] && [ -d "$OLD_P/skills" ]; then
  cp "$OLD_P/.git/config" "$T/k.config.hidden"
  fresh_run "$T/k2.out"; RC=$?
  if [ "$RC" -eq 0 ] && grep -q 'core.hooksPath LOCAL.*vista reducida.*no lo toco' "$T/k2.out" && ! grep -q 'vestigial removido' "$T/k2.out"; then ok "(k) con .githooks/ escondida por la vista reducida: el .ps1 sale 0 y dice que NO es vestigial y que no lo toca"
  else no "(k) con .githooks/ escondida (rc $RC) el lazo dijo: «$(said_hooks_path "$T/k2.out")»"; fi
  if [ "$(hooks_path)" = .githooks ] && cmp -s "$T/k.config.hidden" "$OLD_P/.git/config"; then ok "(k) …y no borra la clave: .git/config queda byte a byte"
  else no "(k) con .githooks/ escondida: hooksPath «$(hooks_path)» — .git/config $(cmp -s "$T/k.config.hidden" "$OLD_P/.git/config" && echo igual || echo CAMBIÓ)"; fi
  if view_off > "$T/k.view.out" 2>&1 && [ -f "$OLD_P/.githooks/pre-commit" ] && cmp -s "$T/k.config.before" "$OLD_P/.git/config"; then ok "(k) después de la vuelta: .githooks/ en el disco y .git/config byte a byte el de antes de la ida"
  else no "(k) después de la vuelta: $(diff "$T/k.config.before" "$OLD_P/.git/config" | head -3 | tr '\n' ' ')$(brief "$T/k.view.out" 160)"; fi
else
  no "(k) no pude poner la vista reducida en el clon de laboratorio: $(brief "$T/k.view.out" 200)"
fi
# (story 8.16, tanda C · AC 23; pase adversarial, clase 11) en minimal el lazo no mira el core.hooksPath de ningún repo:
# uno vestigial (una carpeta vacía) queda como está, y no se dice nada de él
mkdir -p "$OLD_P/.vacia" && gq -C "$OLD_P" config --local core.hooksPath .vacia
printf '{ "install": { "profile": "minimal" } }\n' > "$HP/.claude/tycon.json"
fresh_run "$T/k-min.out"; RC=$?
if [ "$RC" -eq 0 ] && [ "$(hooks_path)" = .vacia ] && ! grep -q 'core.hooksPath' "$T/k-min.out"; then ok "(k) en minimal el .ps1 no toca el core.hooksPath de los repos (uno vestigial queda)"
else no "(k) en minimal (rc $RC): hooksPath «$(hooks_path)» · «$(said_hooks_path "$T/k-min.out")»"; fi
rm -f "$HP/.claude/tycon.json"; rmdir "$OLD_P/.vacia" 2>/dev/null; gq -C "$OLD_P" config --local core.hooksPath .githooks
# (no pude mirar) una carpeta que ESTÁ y no se deja leer no es «sin hooks»
if [ "$(id -u)" = 0 ]; then echo "⏭ installer-ps1: NO MEDIDO — (k) «no pude mirar»: corriendo como root no hay carpeta que no se deje leer"; else
  mkdir -p "$OLD_P/.githooks" && gq -C "$OLD_P" config --local core.hooksPath .githooks   # de nuevo: este caso no depende de cómo salieron los de arriba
  chmod 000 "$OLD_P/.githooks"; fresh_run "$T/k3.out"; RC=$?; chmod 755 "$OLD_P/.githooks"
  if [ "$RC" -eq 0 ] && grep -q 'core.hooksPath LOCAL.*no pude mirar.*no lo toco' "$T/k3.out" && [ "$(hooks_path)" = .githooks ]; then ok "(k) (no pude mirar) una carpeta que no se deja leer: sale 0, dice que no pudo mirar y no toca la clave"
  else no "(k) (no pude mirar) (rc $RC): «$(said_hooks_path "$T/k3.out")» · hooksPath: «$(hooks_path)»"; fi
fi
# (espejo) lo vestigial de verdad se sigue destapando: sólo *.sample; y una carpeta que no existe y que el repo no sigue
mkdir -p "$OLD_P/.git/lab-hooks" && : > "$OLD_P/.git/lab-hooks/pre-commit.sample" && gq -C "$OLD_P" config --local core.hooksPath .git/lab-hooks
fresh_run "$T/k4.out"; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'core.hooksPath local vestigial removido' "$T/k4.out" && [ -z "$(hooks_path)" ]; then ok "(k) (espejo) una carpeta con sólo *.sample: la destapa (la clave se va) y lo dice"
else no "(k) (espejo) sólo *.sample (rc $RC): «$(said_hooks_path "$T/k4.out")» · hooksPath: «$(hooks_path)»"; fi
gq -C "$OLD_P" config --local core.hooksPath lab-no-such-hooks
fresh_run "$T/k5.out"; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'core.hooksPath local vestigial removido' "$T/k5.out" && [ -z "$(hooks_path)" ]; then ok "(k) (espejo) una carpeta que no existe y que el repo no sigue: la destapa, como siempre"
else no "(k) (espejo) carpeta inexistente (rc $RC): «$(said_hooks_path "$T/k5.out")» · hooksPath: «$(hooks_path)»"; fi

fi   # ── fin de la parte 1 (de (a) a (k)); lo que sigue, hasta (n), corre en las dos partes ──

# ═══ story 8.17, tanda W3a · el .ps1 registra lo que faltaba (T90 a T93) ════════════════════════════════════════
# Lo esperado de estas secciones está ESCRITO ACÁ, control por control: si saliera de las tablas del .ps1, una fila que
# falta en la tabla no se vería (así vivieron los 15 huecos). Todas las corridas con TYCON_HARNESS_LOCK_HELD=1 y
# TYCON_HARNESS_GIT_BASH_HEALTH=1 (lo que pone un harness.js de esta tanda): miden el aplicador, no el mecanismo de
# instalación que lo lanza. Sin la segunda variable es la sección u.
cat > "$T/hookq.js" <<'JS'
'use strict';
// hookq.js <settings.json> <evento> <matcher|*> <relpath> → «<n>\t<comando del primero>»: cuántos hooks de ese evento
// (y de ese matcher; `*` = cualquiera) invocan ese guion —su comando termina en `/<relpath>"`—.
const fs = require('fs');
const [file, event, matcher, relpath] = process.argv.slice(2);
const norm = (m) => String(m || '').split('|').map((x) => x.trim()).filter(Boolean).sort().join('|');
let s;
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`ilegible\t${e.message}`); process.exit(0); }
const found = [];
for (const entry of ((s && s.hooks) || {})[event] || []) {
  if (matcher !== '*' && norm(entry.matcher) !== norm(matcher)) continue;
  for (const h of entry.hooks || []) {
    const cmd = h && typeof h.command === 'string' ? h.command : '';
    if (cmd.endsWith('/' + relpath + '"')) found.push(cmd);
  }
}
console.log(`${found.length}\t${found[0] || ''}`);
JS
cat > "$T/shape.js" <<'JS'
'use strict';
// shape.js <settings.json> <trozo de ruta> → de los comandos que nombran ese trozo (los del arnés en ese laboratorio),
// los que NO tienen la forma `node "<ruta>"` o `bash "<ruta>"` sin `$`, sin acento grave y sin comillas adentro.
// Todos cumplen: «<n> <cuántos con bash>» y exit 0.
const fs = require('fs');
const [file, needle] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const cmds = [];
for (const bucket of Object.values(s.hooks || {})) for (const entry of bucket) for (const h of entry.hooks || []) {
  if (h && typeof h.command === 'string' && h.command.includes(needle)) cmds.push(h.command);
}
const viaBash = (c) => /^bash "[^"$`]+"$/.test(c);
const bad = cmds.filter((c) => !/^node "[^"$`]+"$/.test(c) && !viaBash(c));
if (bad.length) { console.log(bad.slice(0, 3).join(' · ')); process.exit(1); }
console.log(`${cmds.length} ${cmds.filter(viaBash).length}`);
JS
hook_n() { node "$T/hookq.js" "$1" "$2" "$3" "$4" | cut -f1; }      # <settings> <evento> <matcher|*> <relpath> → cuántas veces está
hook_cmd() { node "$T/hookq.js" "$1" "$2" "$3" "$4" | cut -f2-; }   # ídem → el comando con que está
wrong_counts() { # <settings> <n> <evento|matcher|relpath>…: los que NO están <n> veces en su evento y con su matcher (y <n> en el evento entero); vacío = todos cumplen
  local s="$1" want="$2" spec ev m rel n any bad=""; shift 2
  for spec in "$@"; do
    ev="${spec%%|*}"; rel="${spec##*|}"; m="${spec#*|}"; m="${m%|*}"
    n="$(hook_n "$s" "$ev" "$m" "$rel")"; any="$(hook_n "$s" "$ev" '*' "$rel")"
    { [ "$n" = "$want" ] && [ "$any" = "$want" ]; } || bad="$bad ${rel}(${ev}: ${n} con su matcher, ${any} en el evento)"
  done
  printf '%s' "$bad"
}
same_cmd() { [ "$(hook_cmd "$1" "$2" "$3" "$4")" = "$5" ]; }   # <settings> <evento> <matcher> <relpath> <comando esperado, entero>
sh_state3() { local s="$1" r out=""; for r in safety-guard-pre.sh test-scope-guard-pre.sh engram-pre-commit.sh; do out="$out$(hook_n "$s" PreToolUse '*' "$r")"; done; printf '%s' "$out"; }   # <settings> → cuántas veces está cada .sh, en cualquier matcher
hook_order() { # <settings>: una línea por hook, en el orden del archivo (evento, matcher, guion) — para decir QUÉ quedó fuera de lugar
  node -e 'const s=require(process.argv[1]);for(const[e,b]of Object.entries(s.hooks||{}))for(const x of b)for(const h of x.hooks||[])console.log(e,x.matcher||"*",String(h.command||"").split("/").pop())' "$1" 2>&1
}

# los que faltaban y tienen sentido en Windows (AC 64), los dos reemplazados que sobraban, lo que queda afuera con su
# motivo en windows-support.json (AC 68) y el opt-in que nace apagado
MISSING_CONTROLS=(
  "PreToolUse|Bash|PowerShell|safety-guard-pre.sh" "PreToolUse|Bash|PowerShell|test-scope-guard-pre.sh" "PreToolUse|Bash|PowerShell|engram-pre-commit.sh"
  "PreToolUse|Bash|PowerShell|push-phantom-ref-notice.js" "PreToolUse|Bash|PowerShell|pr-auto-complete-guard.js"
  "PreToolUse|Bash|PowerShell|tycon-pipeline/scripts/on-bash-write-gate.js" "PostToolUse|Skill|tycon-pipeline/scripts/on-skill-invoke.js"
  "PostToolUse|Artifact|artifact-archive.js" "UserPromptSubmit||rebuild-before-verify.js" "Stop||large-read-meter.js"
  "SessionStart||dependencies-notice.js" "SessionStart||lane-llm-notice.js"
)
DUPLICATES=("PostToolUse|Write|tycon-ado-story-wi/scripts/on-story-create.js" "PostToolUse|Write|tycon-story-followup-link/scripts/on-story-create.js")
EXCLUDED_ON_WINDOWS=("SessionStart||harness-bootstrap-heal.sh" "PreToolUse|Bash|PowerShell|pr-one-per-repo-guard.js" "SessionStart||telegram-zombie-sweep.sh" "PostToolUse|Bash|PowerShell|missing-path-notice.js")
OFF_BY_DEFAULT=("PreToolUse|Bash|PowerShell|session-collision-guard.js" "SessionStart||session-collision-guard.js")
# lanzado por un harness.js de esta tanda en adelante: el candado tomado Y el aviso de que la salud que lo va a juzgar
# sabe revisar un .sh con el bash de Git (sin el aviso, el .ps1 deja los .sh para la corrida siguiente: sección u)
HELD=(TYCON_HARNESS_LOCK_HELD=1 TYCON_HARNESS_GIT_BASH_HEALTH=1)
# lo de fábrica de una máquina del equipo: las tres integraciones que su perfil prende, acá por variable (el perfil no
# viaja al clon de laboratorio)
TEAM=(TYCON_CLOCKIFY=1 TYCON_ENGRAM=1 TYCON_NIGHTLY=1)
lab_env "$GUARD" "${TEAM[@]}" -- node "$CLONE/scripts/lib/tycon-config.js" integrations --json > "$T/integrations-team.json" 2> "$T/integrations-team.err"
[ $? -eq 0 ] || { echo "❌ installer-ps1: el lector de configuración no contestó con las integraciones del equipo: $(brief "$T/integrations-team.err")"; exit 1; }

if suite_part 1; then   # ── parte 1 de 2: de (n) a (r) ──

# ── (n) T90 · Ps1_RegistersMissingControls_EachOnce_DuplicatesGone ──────────────────────────────────────────────
HT="$(new_home team)"; ST="$HT/.claude/settings.json"
installer "$HT" "${HELD[@]}" "${TEAM[@]}" > "$T/t.out" 2>&1; RC=$?
BAD="$(wrong_counts "$ST" 1 "${MISSING_CONTROLS[@]}")"
if [ "$RC" -eq 0 ] && [ -z "$BAD" ]; then ok "(n) T90 con lo de fábrica de una máquina del equipo, los doce controles que faltaban quedan registrados: cada uno una vez, en su evento y con su matcher"
else no "(n) T90 controles que faltaban (rc $RC), no están una vez:${BAD:- —} · $(brief "$T/t.out" 200)"; fi
R="$(INTEG_FILE="$T/integrations-team.json" check settings "$ST" "$T/b.left.json")"; CK=$?
if [ "$CK" -eq 0 ] && [ "${R% }" = "40 hooks" ]; then ok "(n) T90 la lista entera: 40 controles, cada uno una vez (los 43 del .sh en una máquina del equipo, menos los tres que Windows deja afuera)"
else no "(n) T90 la lista entera con lo de fábrica del equipo (esperaba «40 hooks»): ${R}"; fi
BAD="$(wrong_counts "$ST" 0 "${DUPLICATES[@]}" "${EXCLUDED_ON_WINDOWS[@]}" "${OFF_BY_DEFAULT[@]}")"
if [ -z "$BAD" ]; then ok "(n) T90 no registra los dos reemplazados, ni lo que Windows deja afuera, ni el opt-in que nace apagado"
else no "(n) T90 registró lo que no va:$BAD"; fi
# Doctor_ExpectedCount_EqualsInstaller_MatcherCounts (pase adversarial de la W3a, B5): la cuenta de `doctor` sobre lo
# que este instalador dejó es la suya —39, cada fila con su matcher— y sin la fila PostToolUse/Bash de
# rebuild-before-verify.js dice que falta ESA (antes: 38 y «todos registrados», mientras -Check decía que faltaba una)
cat > "$T/doctor-count.js" <<'JS'
'use strict';
// doctor-count.js <árbol> <home> <integraciones.json> [drop-bash-rebuild] → «<esperados> <faltantes> <etiquetas>»
// (el árbol es el repo: el clon de laboratorio no copia scripts/tests/, donde vive la lista de condiciones; las dos
// listas de hooks son las mismas)
const fs = require('fs');
const path = require('path');
const [clone, home, integFile, drop] = process.argv.slice(2);
const settings = path.join(home, '.claude', 'settings.json');
if (drop) {
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  for (const b of s.hooks.PostToolUse || []) if (b.matcher === 'Bash|PowerShell') b.hooks = (b.hooks || []).filter((h) => !/rebuild-before-verify\.js"$/.test(h.command || ''));
  fs.writeFileSync(settings, JSON.stringify(s, null, 2));
}
const M = require(path.join(clone, 'scripts', 'setup', 'harness', 'managed.js'));
const r = M.expectedControls({ platform: 'win32', tree: clone, integrations: JSON.parse(fs.readFileSync(integFile, 'utf8')), home, env: { TYCON_SETTINGS_PATH: settings } });
console.log(`${r.expected.length} ${r.missing.length} ${r.missing.map((c) => c.label).join(' · ')}`);
JS
HDC="$(new_home doctor-count)"
installer "$HDC" "${HELD[@]}" "${TEAM[@]}" > "$T/dc.out" 2>&1; RC=$?
DC="$(lab_env "$HDC" -- node "$T/doctor-count.js" "$ROOT" "$HDC" "$T/integrations-team.json" 2>&1)"
if [ "$RC" -eq 0 ] && [ "$DC" = "40 0 " ]; then ok "(n) la cuenta de doctor sobre lo que dejó el instalador es la suya: 40 controles esperados, ninguno falta"
else no "(n) la cuenta de doctor no es la del instalador (rc $RC): «${DC}» (esperaba «40 0 »)"; fi
DC="$(lab_env "$HDC" -- node "$T/doctor-count.js" "$ROOT" "$HDC" "$T/integrations-team.json" drop-bash-rebuild 2>&1)"
CK="$(installer "$HDC" "${HELD[@]}" "${TEAM[@]}" -- -Check 2>&1 | grep -c "+ PostToolUse (matcher='Bash|PowerShell') → @tcg:rebuild-before-verify.js")"   # (W4: el .ps1 imprime el spec de la lista)
case "$DC" in "40 1 PostToolUse [Bash|PowerShell] @tcg:rebuild-before-verify.js") ok "(n) sin la fila PostToolUse/Bash de rebuild-before-verify.js, doctor dice que falta ESA (con su matcher), como -Check" ;;
  *) no "(n) sin la fila Bash de rebuild-before-verify.js doctor dice «${DC}» (esperaba «40 1 PostToolUse [Bash|PowerShell] @tcg:rebuild-before-verify.js»); -Check la nombra $CK vez/veces" ;; esac
[ "$CK" = 1 ] || no "(n) -Check no nombra la fila Bash de rebuild-before-verify.js que falta ($CK)"
# una máquina que YA trae los dos reemplazados (los registraba este mismo instalador): se sacan, y lo ajeno de ese bloque queda
HU="$(new_home had-duplicates)"; mkdir -p "$HU/.claude"; ln -s "$CLONE" "$HU/.claude/agent-skills"
printf '{\n  "hooks": {\n    "PostToolUse": [ { "matcher": "Write", "hooks": [\n      { "type": "command", "command": "node \\"%s/tycon-ado-story-wi/scripts/on-story-create.js\\"" },\n      { "type": "command", "command": "node \\"%s/tycon-story-followup-link/scripts/on-story-create.js\\"" },\n      { "type": "command", "command": "echo lab-post-write" } ] } ]\n  }\n}\n' \
  "$HU/.claude/agent-skills/skills" "$HU/.claude/agent-skills/skills" > "$HU/.claude/settings.json"
if [ "$(wrong_counts "$HU/.claude/settings.json" 1 "${DUPLICATES[@]}")" != "" ]; then no "(n) T90 no pude armar la máquina que ya trae los dos reemplazados"; fi
installer "$HU" "${HELD[@]}" "${TEAM[@]}" > "$T/u.out" 2>&1; RC=$?
BAD="$(wrong_counts "$HU/.claude/settings.json" 0 "${DUPLICATES[@]}")"
if [ "$RC" -eq 0 ] && [ -z "$BAD" ] && grep -q 'echo lab-post-write' "$HU/.claude/settings.json" && [ "$(grep -c -- '- PostToolUse .*on-story-create\.js' "$T/u.out")" = 2 ]; then
  ok "(n) T90 una máquina que ya traía los dos «on-story-create.js» reemplazados: se sacan, se dice, y el hook ajeno de ese bloque queda"
else no "(n) T90 una máquina con los dos reemplazados (rc $RC):${BAD:- —} · $(grep -c -- '- PostToolUse .*on-story-create\.js' "$T/u.out") línea(s) de aviso · $(brief "$T/u.out" 200)"; fi

# ── (o) T91 · Ps1_InterpreterByExtension_ShAsBash_SecondRunIdentical_NoShellMetachars ───────────────────────────
BAD=""
for rel in safety-guard-pre.sh test-scope-guard-pre.sh engram-pre-commit.sh; do
  same_cmd "$ST" PreToolUse 'Bash|PowerShell' "$rel" "$SH_PREFIX\"$CLONE/scripts/hooks/$rel\"" || BAD="$BAD $rel(«$(hook_cmd "$ST" PreToolUse 'Bash|PowerShell' "$rel")»)"
done
same_cmd "$ST" Stop '' large-read-meter.js "node \"$CLONE/scripts/hooks/large-read-meter.js\"" || BAD="$BAD large-read-meter.js(«$(hook_cmd "$ST" Stop '' large-read-meter.js)»)"
same_cmd "$ST" PreToolUse 'Bash|PowerShell' tycon-pipeline/scripts/on-bash-write-gate.js "node \"$HT/.claude/agent-skills/skills/tycon-pipeline/scripts/on-bash-write-gate.js\"" || BAD="$BAD on-bash-write-gate.js(«$(hook_cmd "$ST" PreToolUse 'Bash|PowerShell' tycon-pipeline/scripts/on-bash-write-gate.js)»)"
if [ -z "$BAD" ]; then ok "(o) T91 el intérprete sale de la extensión: un .sh queda como bash \"<ruta>\" y un .js como node \"<ruta>\""
else no "(o) T91 el comando no es <intérprete> \"<ruta>\":$BAD"; fi
cp "$ST" "$T/t.settings.json"
installer "$HT" "${HELD[@]}" "${TEAM[@]}" > "$T/t2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(hook_n "$ST" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh)" = 1 ] && cmp -s "$ST" "$T/t.settings.json"; then ok "(o) T91 con los .sh registrados, una segunda corrida deja settings.json byte a byte igual"
else no "(o) T91 la segunda corrida (rc $RC) cambió settings.json o no había .sh registrado: $(brief "$T/t2.out")"; fi
# un espacio en la carpeta (la del usuario y la del clon): cada ruta en un nivel de comillas, sin `$`, sin acento grave,
# sin comillas adentro
SPACED="$T/lab space"; mkdir -p "$SPACED" && cp -R "$CLONE" "$SPACED/clone"
HS="$(mktemp -d "$SPACED/home.XXXXXX")"
LAB_INSTALLER="$SPACED/clone/scripts/install-tycon-hooks.ps1" installer "$HS" "${HELD[@]}" "${TEAM[@]}" > "$T/s.out" 2>&1; RC=$?
R="$(node "$T/shape.js" "$HS/.claude/settings.json" "lab space" 2>&1)"; CK=$?
if [ "$RC" -eq 0 ] && [ "$CK" -eq 0 ] && [ "$R" = "40 3" ]; then ok "(o) T91 con un espacio en la carpeta: los 40 comandos (3 con bash) son <intérprete> \"<ruta>\", sin \$, sin acento grave y sin comillas adentro"
else no "(o) T91 con un espacio en la carpeta (rc $RC, esperaba «40 3»): $R · $(brief "$T/s.out" 200)"; fi
cp "$HS/.claude/settings.json" "$T/s.settings.json"
LAB_INSTALLER="$SPACED/clone/scripts/install-tycon-hooks.ps1" installer "$HS" "${HELD[@]}" "${TEAM[@]}" > "$T/s2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$HS/.claude/settings.json" "$T/s.settings.json"; then ok "(o) T91 con un espacio en la carpeta, la segunda corrida deja settings.json byte a byte igual"
else no "(o) T91 con un espacio en la carpeta, la segunda corrida (rc $RC) cambió settings.json: $(brief "$T/s2.out")"; fi
# un .sh que ya estaba registrado con OTRA forma de ruta (la de Git Bash) y el matcher de antes (`Bash`): «ya está» se
# decide por la ruta del guion dentro del repo, no se duplica, y pasa al matcher nuevo (`Bash|PowerShell`, 2026-10-04,
# sección v); el espejo, en la misma máquina: el .sh que no estaba, entra. Su comando queda tal cual estaba (W3W4: ya
# no se reescribe a la ruta del bash de Git) y la corrida siguiente no toca nada.
HO="$(new_home other-path-form)"; mkdir -p "$HO/.claude"; ln -s "$CLONE" "$HO/.claude/agent-skills"
printf '{\n  "hooks": {\n    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bash \\"/c/lab/.claude/tycon-claude-guides/scripts/hooks/safety-guard-pre.sh\\"" } ] } ]\n  }\n}\n' > "$HO/.claude/settings.json"
installer "$HO" "${HELD[@]}" > "$T/o.out" 2>&1; RC=$?
SO="$HO/.claude/settings.json"
if [ "$RC" -eq 0 ] && [ "$(hook_n "$SO" PreToolUse '*' safety-guard-pre.sh)" = 1 ] && [ "$(hook_n "$SO" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh)" = 1 ] \
   && same_cmd "$SO" PreToolUse 'Bash|PowerShell' test-scope-guard-pre.sh "$SH_PREFIX\"$CLONE/scripts/hooks/test-scope-guard-pre.sh\""; then
  ok "(o) T91 un .sh ya registrado con otra forma de ruta y el matcher de antes no se duplica y pasa al matcher nuevo; el espejo: el .sh que no estaba, entra"
else no "(o) T91 un .sh ya registrado con otra forma de ruta (rc $RC): safety-guard está $(hook_n "$SO" PreToolUse '*' safety-guard-pre.sh) vez/veces ($(hook_n "$SO" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh) con «Bash|PowerShell») como «$(hook_cmd "$SO" PreToolUse '*' safety-guard-pre.sh)»; test-scope-guard «$(hook_cmd "$SO" PreToolUse 'Bash|PowerShell' test-scope-guard-pre.sh)» · $(brief "$T/o.out" 200)"; fi
cp "$SO" "$T/o.settings.json"
installer "$HO" "${HELD[@]}" > "$T/o2.out" 2>&1; RC2=$?
if [ "$RC" -eq 0 ] && same_cmd "$T/o.settings.json" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh 'bash "/c/lab/.claude/tycon-claude-guides/scripts/hooks/safety-guard-pre.sh"' && [ "$RC2" -eq 0 ] && cmp -s "$SO" "$T/o.settings.json"; then
  ok "(o) ese .sh con otra forma de ruta y el matcher de antes conserva su comando tal cual (sólo cambia el matcher); la siguiente corrida no cambia nada"
else no "(o) un .sh con otra forma de ruta y el matcher de antes: tras la primera corrida quedó «$(hook_cmd "$T/o.settings.json" PreToolUse '*' safety-guard-pre.sh)» (esperaba el de antes, bash \"/c/lab/…/safety-guard-pre.sh\"); la segunda (rc $RC2) $(cmp -s "$SO" "$T/o.settings.json" && echo 'no cambió nada' || echo "lo cambió a «$(hook_cmd "$SO" PreToolUse '*' safety-guard-pre.sh)»")"; fi
# lo que dejó la W3a (y la forma de hoy): los .sh con el matcher nuevo y `bash "<ruta>"`, entre dos hooks ajenos. Quedan
# una vez cada uno, en su mismo lugar y con su mismo matcher; lo ajeno queda; la segunda corrida no cambia nada.
HW3A="$(new_home w3a-bare-bash)"; mkdir -p "$HW3A/.claude"; ln -s "$CLONE" "$HW3A/.claude/agent-skills"; SW3A="$HW3A/.claude/settings.json"
printf '{\n  "hooks": {\n    "PreToolUse": [ { "matcher": "Bash|PowerShell", "hooks": [\n      { "type": "command", "command": "echo lab-antes" },\n      { "type": "command", "command": "bash \\"%s/scripts/hooks/safety-guard-pre.sh\\"" },\n      { "type": "command", "command": "bash \\"%s/scripts/hooks/test-scope-guard-pre.sh\\"" },\n      { "type": "command", "command": "echo lab-despues" } ] } ]\n  }\n}\n' "$CLONE" "$CLONE" > "$SW3A"
w3a_order() { node -e 'const s=require(process.argv[1]);const b=(s.hooks.PreToolUse||[]).find((e)=>e.matcher==="Bash|PowerShell");console.log(b?b.hooks.map((h)=>/^echo /.test(h.command)?h.command.slice(5):h.command.split("/").pop().replace(/"$/,"")).filter((x)=>/^lab-|guard-pre/.test(x)).join(" "):"sin bloque")' "$1" 2>&1; }   # <settings>: lo ajeno y los dos frenos, en su orden
installer "$HW3A" "${HELD[@]}" > "$T/w3a1.out" 2>&1; RC=$?
cp "$SW3A" "$T/w3a.settings.json"
installer "$HW3A" "${HELD[@]}" > "$T/w3a2.out" 2>&1; RC2=$?
if [ "$RC" -eq 0 ] && [ "$RC2" -eq 0 ] && [ -z "$(wrong_counts "$SW3A" 1 "PreToolUse|Bash|PowerShell|safety-guard-pre.sh" "PreToolUse|Bash|PowerShell|test-scope-guard-pre.sh")" ] \
   && same_cmd "$T/w3a.settings.json" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh "$SH_PREFIX\"$CLONE/scripts/hooks/safety-guard-pre.sh\"" \
   && same_cmd "$T/w3a.settings.json" PreToolUse 'Bash|PowerShell' test-scope-guard-pre.sh "$SH_PREFIX\"$CLONE/scripts/hooks/test-scope-guard-pre.sh\"" \
   && [ "$(w3a_order "$T/w3a.settings.json")" = "lab-antes safety-guard-pre.sh test-scope-guard-pre.sh lab-despues" ] && cmp -s "$SW3A" "$T/w3a.settings.json"; then
  ok "(o) los .sh registrados como «bash \"<ruta>\"» quedan una vez cada uno, en su lugar y con su matcher; lo ajeno queda; la segunda corrida no cambia nada"
else no "(o) los .sh registrados como «bash \"<ruta>\"» (rc $RC y $RC2): $(wrong_counts "$SW3A" 1 "PreToolUse|Bash|PowerShell|safety-guard-pre.sh" "PreToolUse|Bash|PowerShell|test-scope-guard-pre.sh") · safety «$(hook_cmd "$T/w3a.settings.json" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh)» · orden «$(w3a_order "$T/w3a.settings.json")» · segunda corrida $(cmp -s "$SW3A" "$T/w3a.settings.json" && echo igual || echo CAMBIÓ) · $(brief "$T/w3a1.out" 200)"; fi
# (Hasta la W3W4 acá se medía «sin el bash de Git, ningún .sh se registra» y sus avisos: el aplicador ya no busca el
# bash de Git ni manda esos avisos, así que no hay nada que medir.)

# ── (p) T92 · Ps1_OptIn_OffRemoves_BrokenConfigKeeps ────────────────────────────────────────────────────────────
team_run() { installer "$HT" "${HELD[@]}" "$@" > "$T/h.out" 2>&1; }   # [VAR=val …]: una corrida sobre la máquina del equipo, con ESAS variables
n_of() { hook_n "$ST" "$1" '*' "$2"; }                            # <evento> <relpath>: cuántas veces está en la máquina del equipo
back_to_factory() { # <qué se apagó>: con todo de fábrica otra vez, settings.json vuelve a ser byte a byte el de la instalación fresca
  team_run "${TEAM[@]}"; local rc=$?
  if [ "$rc" -eq 0 ] && cmp -s "$ST" "$T/t.settings.json"; then ok "(p) T92 $1: al volver a lo de fábrica, settings.json queda byte a byte como el de una instalación fresca (cada hook en su lugar)"
  else no "(p) T92 $1: al volver a lo de fábrica (rc $rc) settings.json no es el de la instalación fresca: $(diff <(hook_order "$T/t.settings.json") <(hook_order "$ST") | head -6 | tr '\n' ' ')"; fi
}
# el espejo primero: con todo de fábrica, los tres .sh están
if [ "$(n_of PreToolUse safety-guard-pre.sh)$(n_of PreToolUse test-scope-guard-pre.sh)$(n_of PreToolUse engram-pre-commit.sh)" = 111 ]; then ok "(p) T92 el espejo: con todo de fábrica, los tres .sh están registrados"
else no "(p) T92 el espejo: con todo de fábrica no están los tres .sh (safety $(n_of PreToolUse safety-guard-pre.sh), test-scope $(n_of PreToolUse test-scope-guard-pre.sh), engram $(n_of PreToolUse engram-pre-commit.sh))"; fi
# T90, el camino de las máquinas del equipo: una instalada ANTES de esta tanda (sin los doce controles) los recibe cada uno
# en su lugar, y queda igual que una instalada de cero
cat > "$T/strip.js" <<'JS'
'use strict';
// strip.js <settings.json> <evento|matcher|relpath>…: saca esos hooks del archivo (y los bloques y eventos que queden
// vacíos), como estaba una máquina instalada antes de que el instalador los registrara. Dice cuántos sacó.
const fs = require('fs');
const [file, ...specs] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
let gone = 0;
for (const spec of specs) {
  const event = spec.slice(0, spec.indexOf('|'));
  const relpath = spec.slice(spec.lastIndexOf('|') + 1);
  const bucket = [];
  for (const entry of s.hooks[event] || []) {
    const kept = (entry.hooks || []).filter((h) => !String(h.command || '').endsWith('/' + relpath + '"'));
    gone += (entry.hooks || []).length - kept.length;
    if (kept.length) { entry.hooks = kept; bucket.push(entry); }
  }
  if (bucket.length) s.hooks[event] = bucket; else delete s.hooks[event];
}
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
console.log(gone);
JS
STRIPPED="$(node "$T/strip.js" "$ST" "${MISSING_CONTROLS[@]}" 2>&1)"
if [ "$STRIPPED" = 12 ] && [ -z "$(wrong_counts "$ST" 0 "${MISSING_CONTROLS[@]}")" ]; then back_to_factory "(T90) una máquina instalada antes de esta tanda, sin los doce controles"
else no "(p) T90 no pude armar la máquina instalada antes de esta tanda (saqué «${STRIPPED}» hooks, esperaba 12)"; fi
team_run "${TEAM[@]}" TYCON_SAFETY_GUARD=0; RC=$?
if [ "$RC" -eq 0 ] && [ "$(n_of PreToolUse safety-guard-pre.sh)$(n_of PreToolUse test-scope-guard-pre.sh)$(n_of PreToolUse engram-pre-commit.sh)" = 011 ] && grep -q -- '- PreToolUse .*safety-guard-pre\.sh' "$T/h.out"; then
  ok "(p) T92 TYCON_SAFETY_GUARD=0: el freno de comandos se saca, se dice, y los otros dos quedan"
else no "(p) T92 TYCON_SAFETY_GUARD=0 (rc $RC): safety $(n_of PreToolUse safety-guard-pre.sh), test-scope $(n_of PreToolUse test-scope-guard-pre.sh), engram $(n_of PreToolUse engram-pre-commit.sh) · $(brief "$T/h.out" 200)"; fi
back_to_factory "TYCON_SAFETY_GUARD=0"
team_run "${TEAM[@]}" TYCON_TEST_SCOPE_GUARD=0; RC=$?
if [ "$RC" -eq 0 ] && [ "$(n_of PreToolUse safety-guard-pre.sh)$(n_of PreToolUse test-scope-guard-pre.sh)$(n_of PreToolUse engram-pre-commit.sh)" = 101 ]; then ok "(p) T92 TYCON_TEST_SCOPE_GUARD=0: el freno de pruebas sin filtro se saca y los otros dos quedan"
else no "(p) T92 TYCON_TEST_SCOPE_GUARD=0 (rc $RC): safety $(n_of PreToolUse safety-guard-pre.sh), test-scope $(n_of PreToolUse test-scope-guard-pre.sh), engram $(n_of PreToolUse engram-pre-commit.sh) · $(brief "$T/h.out" 200)"; fi
back_to_factory "TYCON_TEST_SCOPE_GUARD=0 (el .sh del medio vuelve entre los otros dos: el orden canónico cuenta a los .sh)"
team_run "${TEAM[@]}" TYCON_ENGRAM_HOOK=0; RC=$?
if [ "$RC" -eq 0 ] && [ "$(n_of PreToolUse engram-pre-commit.sh)$(n_of SessionStart engram-drift-notice.js)$(n_of PreToolUse safety-guard-pre.sh)" = 011 ]; then ok "(p) T92 TYCON_ENGRAM_HOOK=0 con la integración engram prendida: se saca engram-pre-commit.sh y el aviso de engram queda"
else no "(p) T92 TYCON_ENGRAM_HOOK=0 con engram prendido (rc $RC): engram-pre-commit $(n_of PreToolUse engram-pre-commit.sh), engram-drift-notice $(n_of SessionStart engram-drift-notice.js) · $(brief "$T/h.out" 200)"; fi
team_run TYCON_CLOCKIFY=1 TYCON_NIGHTLY=1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(n_of PreToolUse engram-pre-commit.sh)$(n_of SessionStart engram-drift-notice.js)$(n_of PreToolUse safety-guard-pre.sh)" = 001 ]; then ok "(p) T92 la integración engram apagada: engram-pre-commit.sh no queda (y el aviso de engram tampoco)"
else no "(p) T92 la integración engram apagada (rc $RC): engram-pre-commit $(n_of PreToolUse engram-pre-commit.sh), engram-drift-notice $(n_of SessionStart engram-drift-notice.js) · $(brief "$T/h.out" 200)"; fi
team_run TYCON_CLOCKIFY=1 TYCON_NIGHTLY=1 TYCON_ENGRAM_HOOK=1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(n_of PreToolUse engram-pre-commit.sh)$(n_of SessionStart engram-drift-notice.js)" = 10 ]; then ok "(p) T92 TYCON_ENGRAM_HOOK=1 con la integración apagada: la variable manda, engram-pre-commit.sh se registra"
else no "(p) T92 TYCON_ENGRAM_HOOK=1 con engram apagado (rc $RC): engram-pre-commit $(n_of PreToolUse engram-pre-commit.sh), engram-drift-notice $(n_of SessionStart engram-drift-notice.js) · $(brief "$T/h.out" 200)"; fi
back_to_factory "la integración engram apagada y vuelta a prender"
# la configuración ROTA: el de la integración queda como estaba (registrado en esta máquina; sin registrar en una nueva),
# los dos frenos se registran igual (story 8.16: sin saber el perfil, decisión del dueño), y una variable puesta
# (TYCON_ENGRAM_HOOK) manda también ahí
printf '{ "integrations": { "engram": "si" } }' > "$HT/.claude/tycon.json"
team_run; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'ROTA' "$T/h.out" && cmp -s "$ST" "$T/t.settings.json"; then ok "(p) T92 con la configuración rota, engram-pre-commit.sh queda como estaba (registrado) y settings.json no cambia"
else no "(p) T92 con la configuración rota sobre la máquina del equipo (rc $RC): engram-pre-commit $(n_of PreToolUse engram-pre-commit.sh), safety $(n_of PreToolUse safety-guard-pre.sh) · $(grep -c ROTA "$T/h.out") aviso(s) de rota · $(brief "$T/h.out" 200)"; fi
team_run TYCON_ENGRAM_HOOK=0; RC=$?
if [ "$RC" -eq 0 ] && [ "$(n_of PreToolUse engram-pre-commit.sh)$(n_of SessionStart engram-drift-notice.js)" = 01 ]; then ok "(p) T92 con la configuración rota y TYCON_ENGRAM_HOOK=0: la variable manda, se saca; el aviso de engram queda como estaba"
else no "(p) T92 con la configuración rota y TYCON_ENGRAM_HOOK=0 (rc $RC): engram-pre-commit $(n_of PreToolUse engram-pre-commit.sh), engram-drift-notice $(n_of SessionStart engram-drift-notice.js)"; fi
HB="$(new_home broken-config)"; mkdir -p "$HB/.claude"; ln -s "$CLONE" "$HB/.claude/agent-skills"; printf '{ "integrations": { "engram": "si" } }' > "$HB/.claude/tycon.json"
installer "$HB" "${HELD[@]}" > "$T/hb.out" 2>&1; RC=$?
SB="$HB/.claude/settings.json"
# Desde la story 8.16 (tanda C · AC 23) los dos frenos dependen del perfil de instalación (en minimal no entran sin su
# variable), pero con la configuración rota —sin saber el perfil— se registran igual (decisión del dueño, 2026-10-04)
if [ "$RC" -eq 0 ] && [ "$(hook_n "$SB" PreToolUse '*' engram-pre-commit.sh)$(hook_n "$SB" PreToolUse '*' safety-guard-pre.sh)$(hook_n "$SB" PreToolUse '*' test-scope-guard-pre.sh)" = 011 ]; then
  ok "(p) T92 con la configuración rota en una máquina nueva: engram-pre-commit.sh queda como estaba (sin registrar) y los dos frenos se registran igual"
else no "(p) T92 con la configuración rota en una máquina nueva (rc $RC): engram-pre-commit $(hook_n "$SB" PreToolUse '*' engram-pre-commit.sh), safety $(hook_n "$SB" PreToolUse '*' safety-guard-pre.sh), test-scope $(hook_n "$SB" PreToolUse '*' test-scope-guard-pre.sh) · $(brief "$T/hb.out" 200)"; fi
rm -f "$HT/.claude/tycon.json"
back_to_factory "la configuración rota, ya arreglada"
# el opt-in que nace apagado: sólo con su variable en 1, y se saca al volver a lo de fábrica
HG="$(new_home session-guard)"; SG="$HG/.claude/settings.json"
installer "$HG" "${HELD[@]}" TYCON_SESSION_GUARD=1 > "$T/g1.out" 2>&1; RC=$?
BAD="$(wrong_counts "$SG" 1 "${OFF_BY_DEFAULT[@]}")"
installer "$HG" "${HELD[@]}" > "$T/g2.out" 2>&1; RC2=$?
BAD2="$(wrong_counts "$SG" 0 "${OFF_BY_DEFAULT[@]}")"
if [ "$RC" -eq 0 ] && [ "$RC2" -eq 0 ] && [ -z "$BAD" ] && [ -z "$BAD2" ]; then ok "(p) T92 el opt-in que nace apagado: con TYCON_SESSION_GUARD=1 se registra en sus dos eventos, y sin la variable se saca"
else no "(p) T92 el opt-in que nace apagado (rc $RC y $RC2): con la variable:${BAD:- bien}; sin la variable:${BAD2:- bien}"; fi

# ── (q) T93 · Ps1_CrlfScriptNotRegistered_MissingScriptNamed ────────────────────────────────────────────────────
# otra copia del clon: un .sh de la lista con finales \r\n (un freno así sale 255: no frena), y dos guiones de la lista borrados
CRLF_CLONE="$T/clone-crlf"; cp -R "$CLONE" "$CRLF_CLONE"
awk '{ printf "%s\r\n", $0 }' "$CLONE/scripts/hooks/safety-guard-pre.sh" > "$CRLF_CLONE/scripts/hooks/safety-guard-pre.sh"
rm -f "$CRLF_CLONE/scripts/hooks/large-read-meter.js" "$CRLF_CLONE/skills/tycon-pipeline/scripts/on-bash-write-gate.js"
crlf_installer() { LAB_INSTALLER="$CRLF_CLONE/scripts/install-tycon-hooks.ps1" installer "$@"; }
crlf_notice() { grep 'safety-guard-pre\.sh' "$1" | grep -c 'rm --cached'; }   # <salida>: las líneas que nombran el guion con su remedio
HR="$(new_home crlf)"; SR="$HR/.claude/settings.json"
crlf_installer "$HR" "${HELD[@]}" > "$T/r.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(hook_n "$SR" PreToolUse '*' safety-guard-pre.sh)" = 0 ] && [ "$(crlf_notice "$T/r.out")" = 1 ]; then ok "(q) T93 un .sh de la lista con finales \\r\\n no se registra, y UNA línea lo nombra con el remedio"
else no "(q) T93 un .sh con \\r\\n (rc $RC): está registrado $(hook_n "$SR" PreToolUse '*' safety-guard-pre.sh) vez/veces, $(crlf_notice "$T/r.out") línea(s) con su nombre y el remedio · $(brief "$T/r.out" 200)"; fi
if [ "$(hook_n "$SR" PreToolUse '*' test-scope-guard-pre.sh)$(hook_n "$SR" PreToolUse '*' push-phantom-ref-notice.js)$(hook_n "$SR" Stop '*' blocking-meter.js)" = 111 ] && ! grep -q 'test-scope-guard-pre\.sh.*rm --cached' "$T/r.out"; then
  ok "(q) T93 el espejo: el .sh sano de al lado se registra sin aviso, y los demás controles también"
else no "(q) T93 el espejo: con un .sh con \\r\\n, los demás no quedaron bien (test-scope $(hook_n "$SR" PreToolUse '*' test-scope-guard-pre.sh), push-phantom $(hook_n "$SR" PreToolUse '*' push-phantom-ref-notice.js), blocking-meter $(hook_n "$SR" Stop '*' blocking-meter.js))"; fi
if [ "$(hook_n "$SR" Stop '*' large-read-meter.js)$(hook_n "$SR" PreToolUse '*' tycon-pipeline/scripts/on-bash-write-gate.js)" = 00 ] \
   && [ "$(grep -c 'large-read-meter\.js.*no está en el disco' "$T/r.out")" = 1 ] && [ "$(grep -c 'tycon-pipeline/scripts/on-bash-write-gate\.js.*no está en el disco' "$T/r.out")" = 1 ]; then
  ok "(q) T93 un guion de la lista que no está en el disco: no se registra y una línea lo dice por su nombre (uno del arnés y uno de las skills)"
else no "(q) T93 un guion que falta: $(grep -c 'no está en el disco' "$T/r.out") línea(s) de aviso · $(grep 'no está en el disco' "$T/r.out" | head -2 | tr '\n' ' ' | cut -c1-240)"; fi
cp "$SR" "$T/r.settings.json"
crlf_installer "$HR" "${HELD[@]}" > "$T/r2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$SR" "$T/r.settings.json" && [ "$(crlf_notice "$T/r2.out")" = 1 ] && [ "$(grep -c 'no está en el disco' "$T/r2.out")" = 2 ]; then ok "(q) T93 la segunda corrida no cambia settings.json y lo vuelve a decir (el .sh con \\r\\n y los dos que faltan)"
else no "(q) T93 la segunda corrida con un .sh con \\r\\n (rc $RC): $(crlf_notice "$T/r2.out") aviso(s) de \\r\\n, $(grep -c 'no está en el disco' "$T/r2.out") de guion que falta · $(brief "$T/r2.out" 200)"; fi
# ya estaba registrado (con el matcher de antes): queda —pasa al matcher nuevo— y avisa. Su comando, `bash "<ruta>"`,
# queda tal cual
HK="$(new_home crlf-registered)"; mkdir -p "$HK/.claude"; ln -s "$CRLF_CLONE" "$HK/.claude/agent-skills"; SK="$HK/.claude/settings.json"
printf '{\n  "hooks": {\n    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bash \\"%s/scripts/hooks/safety-guard-pre.sh\\"" } ] } ]\n  }\n}\n' "$CRLF_CLONE" > "$SK"
crlf_installer "$HK" "${HELD[@]}" > "$T/k.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(hook_n "$SK" PreToolUse '*' safety-guard-pre.sh)" = 1 ] && same_cmd "$SK" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh "bash \"$CRLF_CLONE/scripts/hooks/safety-guard-pre.sh\"" && [ "$(crlf_notice "$T/k.out")" = 1 ]; then
  ok "(q) T93 un .sh con \\r\\n que ya estaba registrado: queda registrado y una línea avisa, con el remedio"
else no "(q) T93 un .sh con \\r\\n ya registrado (rc $RC): está $(hook_n "$SK" PreToolUse '*' safety-guard-pre.sh) vez/veces, $(crlf_notice "$T/k.out") aviso(s) · $(brief "$T/k.out" 200)"; fi
# con -Check: lo dice, no lo cuenta entre «los que faltan» (correr el instalador no lo registraría) y no escribe nada
HV="$(new_home crlf-check)"
crlf_installer "$HV" "${HELD[@]}" -- -Check > "$T/v.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(crlf_notice "$T/v.out")" = 1 ] && ! grep -q '+ PreToolUse .*safety-guard-pre\.sh' "$T/v.out" && grep -q '+ PreToolUse .*test-scope-guard-pre\.sh' "$T/v.out" && [ -z "$(listing "$HV")" ]; then
  ok "(q) T93 -Check con un .sh con \\r\\n: lo dice con su remedio, no lo cuenta entre los que faltan (el sano sí) y no escribe nada"
else no "(q) T93 -Check con un .sh con \\r\\n (rc $RC): $(crlf_notice "$T/v.out") aviso(s) · $(brief "$T/v.out" 200)"; fi
# el espejo: en el clon sano, ni un aviso de finales de línea ni de guion que falta
if ! grep -q 'rm --cached' "$T/t.out" && ! grep -q 'no está en el disco' "$T/t.out"; then ok "(q) T93 el espejo: con el clon sano no hay aviso de \\r\\n ni de guion que falta"
else no "(q) T93 el espejo: el clon sano dio un aviso de \\r\\n o de guion que falta: $(grep -E 'rm --cached|no está en el disco' "$T/t.out" | head -2 | tr '\n' ' ' | cut -c1-240)"; fi
# Ps1_EolRemedy_TwoCommands_NoDoubleAmpersand · el remedio impreso va en DOS comandos («… y después …»), como el que
# imprime `normalizeEol` (sources.js): PowerShell 5.1 no acepta `&&`, y quien lo copia ahí se queda sin remedio
two_step_remedy() { grep 'safety-guard-pre\.sh' "$1" | grep -c 'rm --cached -r -q \.  *y después  *git -C .* reset --hard -q'; }   # <salida>
if [ "$(two_step_remedy "$T/r.out")" = 1 ] && [ "$(two_step_remedy "$T/k.out")" = 1 ] && [ "$(two_step_remedy "$T/v.out")" = 1 ] \
   && ! grep -q '&&' "$T/r.out" && ! grep -q '&&' "$T/k.out" && ! grep -q '&&' "$T/v.out"; then
  ok "(q) el remedio de los finales de línea va en dos comandos («… y después …»), sin && (sin registrar, ya registrado y con -Check)"
else no "(q) el remedio de los finales de línea no va en dos comandos sin &&: $(two_step_remedy "$T/r.out")/$(two_step_remedy "$T/k.out")/$(two_step_remedy "$T/v.out") línea(s) con «y después» (sin registrar/ya registrado/-Check) · $(grep -c '&&' "$T/r.out") con && · $(grep 'safety-guard-pre\.sh' "$T/r.out" | head -1 | cut -c1-260)"; fi

# ── (s) Ps1_UnreadableShScript_NotRegistered_RetriedNextRun · primera vuelta de revisión de la W3a ───────────────
# Tres resultados, no dos: el guion tiene \r\n / no tiene / NO SE PUDO LEER. Antes, un error al leerlo se leía como «no
# tiene»: con el archivo tomado por otro programa (un antivirus, un editor), un .sh con \r\n quedaba registrado como si
# frenara, sin una línea. «No lo pude leer» va como el \r\n: si no estaba registrado NO se registra, si ya estaba queda,
# y una línea lo nombra con el motivo y «se vuelve a intentar en la próxima corrida». También con -Check.
# Cómo se hace ilegible acá: sin permiso de lectura (chmod 000). Corriendo como root el permiso no frena nada: ahí el
# guion pasa a ser una carpeta con su nombre (existe, y leerla como archivo falla igual).
UNREAD_CLONE="$T/clone-unreadable"; cp -R "$CLONE" "$UNREAD_CLONE"
UNREAD_SH="$UNREAD_CLONE/scripts/hooks/safety-guard-pre.sh"
UNREAD_HOW="sin permiso de lectura"
make_unreadable() { chmod 000 "$UNREAD_SH"; if [ -r "$UNREAD_SH" ]; then rm -f "$UNREAD_SH"; mkdir "$UNREAD_SH"; UNREAD_HOW="una carpeta con su nombre (corre como root)"; fi; }
make_readable() { if [ -d "$UNREAD_SH" ]; then rmdir "$UNREAD_SH"; else rm -f "$UNREAD_SH"; fi; cp "$CLONE/scripts/hooks/safety-guard-pre.sh" "$UNREAD_SH"; }
unread_installer() { LAB_INSTALLER="$UNREAD_CLONE/scripts/install-tycon-hooks.ps1" installer "$@"; }
unread_notice() { grep 'safety-guard-pre\.sh' "$1" | grep 'no pude leer' | grep -c 'se vuelve a intentar en la próxima corrida'; }   # <salida>: las líneas que lo nombran, con el motivo y el reintento
make_unreadable
HQ="$(new_home unreadable)"; SQ="$HQ/.claude/settings.json"
unread_installer "$HQ" "${HELD[@]}" > "$T/q.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(hook_n "$SQ" PreToolUse '*' safety-guard-pre.sh)" = 0 ] && [ "$(unread_notice "$T/q.out")" = 1 ] && grep 'safety-guard-pre\.sh' "$T/q.out" | grep 'NO quedó registrado' >/dev/null; then
  ok "(s) un .sh de la lista que no se puede leer (${UNREAD_HOW}) NO se registra, y UNA línea lo nombra con el motivo y «se vuelve a intentar en la próxima corrida»"
else no "(s) un .sh que no se puede leer (${UNREAD_HOW}; rc $RC): está registrado $(hook_n "$SQ" PreToolUse '*' safety-guard-pre.sh) vez/veces, $(unread_notice "$T/q.out") línea(s) con el motivo y el reintento · $(grep 'safety-guard-pre\.sh' "$T/q.out" | head -1 | cut -c1-240)"; fi
if [ "$(hook_n "$SQ" PreToolUse '*' test-scope-guard-pre.sh)$(hook_n "$SQ" Stop '*' blocking-meter.js)" = 11 ] && ! grep 'test-scope-guard-pre\.sh' "$T/q.out" | grep 'no pude leer' >/dev/null; then
  ok "(s) el espejo, en la misma corrida: el .sh legible de al lado se registra sin aviso, y los demás controles también"
else no "(s) el espejo en la misma corrida: test-scope $(hook_n "$SQ" PreToolUse '*' test-scope-guard-pre.sh), blocking-meter $(hook_n "$SQ" Stop '*' blocking-meter.js) · $(grep -c 'no pude leer' "$T/q.out") aviso(s) de ilegible"; fi
# con -Check: lo dice, no lo cuenta entre «los que faltan» (correr el instalador no lo registraría) y no escribe nada
HQC="$(new_home unreadable-check)"
unread_installer "$HQC" "${HELD[@]}" -- -Check > "$T/qc.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(unread_notice "$T/qc.out")" = 1 ] && ! grep -q '+ PreToolUse .*safety-guard-pre\.sh' "$T/qc.out" && grep -q '+ PreToolUse .*test-scope-guard-pre\.sh' "$T/qc.out" && [ -z "$(listing "$HQC")" ]; then
  ok "(s) -Check con un .sh que no se puede leer: lo dice con el motivo, no lo cuenta entre los que faltan (el legible sí) y no escribe nada"
else no "(s) -Check con un .sh que no se puede leer (rc $RC): $(unread_notice "$T/qc.out") aviso(s) · contado entre los que faltan: $(grep -c '+ PreToolUse .*safety-guard-pre\.sh' "$T/qc.out") · $(brief "$T/qc.out" 200)"; fi
# el espejo: el mismo guion, legible y sano, en la corrida siguiente → registrado, sin aviso (era «se vuelve a intentar»)
make_readable
unread_installer "$HQ" "${HELD[@]}" > "$T/q2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(hook_n "$SQ" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh)" = 1 ] && same_cmd "$SQ" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh "$SH_PREFIX\"$UNREAD_CLONE/scripts/hooks/safety-guard-pre.sh\"" && [ "$(grep -c 'no pude leer' "$T/q2.out")" = 0 ]; then
  ok "(s) el espejo: legible y sano en la corrida siguiente, queda registrado y sin aviso"
else no "(s) el espejo, legible y sano (rc $RC): está $(hook_n "$SQ" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh) vez/veces, $(grep -c 'no pude leer' "$T/q2.out") aviso(s) de ilegible · $(brief "$T/q2.out" 200)"; fi
# ya estaba registrado y deja de poder leerse: queda registrado, settings.json no cambia, y una línea avisa
cp "$SQ" "$T/q.settings.json"
make_unreadable
unread_installer "$HQ" "${HELD[@]}" > "$T/q3.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$SQ" "$T/q.settings.json" && [ "$(hook_n "$SQ" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh)" = 1 ] && [ "$(unread_notice "$T/q3.out")" = 1 ] && grep 'safety-guard-pre\.sh' "$T/q3.out" | grep 'Queda registrado' >/dev/null; then
  ok "(s) un .sh ya registrado que deja de poder leerse: queda registrado (settings.json byte a byte igual) y una línea avisa, con el motivo y el reintento"
else no "(s) un .sh ya registrado que deja de poder leerse (rc $RC): está $(hook_n "$SQ" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh) vez/veces, $(unread_notice "$T/q3.out") aviso(s) · $(grep 'safety-guard-pre\.sh' "$T/q3.out" | head -1 | cut -c1-240)"; fi
make_readable

# ── (t) Ps1_UnsafePathChar_HookNotRegistered_Named · primera vuelta de revisión de la W3a ────────────────────────
# El comando se escribe `node "<ruta>"` o `bash "<ruta>"` y Claude Code se lo pasa a un shell: con `$`, acento grave o
# comilla doble en la ruta del clon o de la carpeta de usuario, el shell leería OTRA cosa. Ese hook no se registra y una
# línea lo dice (el guion y qué carácter); nunca un comando roto. El espejo —un espacio en la carpeta, que sí se
# registra— es el caso de (o).
unsafe_cmds() { node -e 'const s=require(process.argv[1]);let n=0,all=0;for(const b of Object.values(s.hooks||{}))for(const e of b)for(const h of e.hooks||[]){all++;const c=String(h.command||"");if(/[$`]/.test(c)||(c.match(/"/g)||[]).length!==2)n++;}console.log(n+" de "+all)' "$1" 2>&1; }   # <settings>: «<comandos con $, acento grave o comillas de más> de <todos>»
unsafe_notice() { grep 'NO quedó registrado' "$1" | grep 'su ruta trae' | grep -c "$2"; }   # <salida> <texto>: las líneas de ruta insegura que traen ese texto
DOLLAR_DIR="$T/lab\$usr"; mkdir -p "$DOLLAR_DIR"
# (1) la carpeta de usuario trae `$`: los diez guiones de las skills (su ruta pasa por ~/.claude) no se registran; los del clon, sí
HP="$(mktemp -d "$DOLLAR_DIR/home.XXXXXX")"; SP="$HP/.claude/settings.json"
installer "$HP" "${HELD[@]}" "${TEAM[@]}" > "$T/p.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(unsafe_cmds "$SP")" = "0 de 30" ] && [ "$(hook_n "$SP" PreToolUse '*' tycon-pipeline/scripts/on-bash-write-gate.js)$(hook_n "$SP" UserPromptSubmit '*' clocki/scripts/on-prompt.js)" = 00 ]; then
  ok "(t) con \$ en la carpeta de usuario: los guiones cuya ruta lo trae NO se registran (ningún comando con \$ en settings.json; quedan los 29 del clon)"
else no "(t) con \$ en la carpeta de usuario (rc $RC): comandos inseguros «$(unsafe_cmds "$SP")» (esperaba «0 de 30»), on-bash-write-gate $(hook_n "$SP" PreToolUse '*' tycon-pipeline/scripts/on-bash-write-gate.js) · $(brief "$T/p.out" 200)"; fi
if [ "$(unsafe_notice "$T/p.out" '«\$»')" = 10 ] && [ "$(unsafe_notice "$T/p.out" 'tycon-pipeline/scripts/on-bash-write-gate\.js (PreToolUse)')" = 1 ] && [ "$(unsafe_notice "$T/p.out" 'clocki/scripts/on-prompt\.js (UserPromptSubmit)')" = 1 ]; then
  ok "(t) …y una línea por cada uno lo dice: el guion y el carácter (\$)"
else no "(t) con \$ en la carpeta de usuario: $(unsafe_notice "$T/p.out" '«\$»') línea(s) que nombran el carácter (esperaba 10) · $(grep 'su ruta trae' "$T/p.out" | head -1 | cut -c1-240)"; fi
if [ "$(hook_n "$SP" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh)$(hook_n "$SP" Stop '*' large-read-meter.js)" = 11 ] && ! grep 'su ruta trae' "$T/p.out" | grep 'safety-guard-pre\.sh' >/dev/null; then
  ok "(t) el espejo, en la misma corrida: los guiones del clon (su ruta no trae \$) se registran sin aviso, .sh y .js"
else no "(t) el espejo en la misma corrida: safety-guard $(hook_n "$SP" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh), large-read-meter $(hook_n "$SP" Stop '*' large-read-meter.js)"; fi
cp "$SP" "$T/p.settings.json"
installer "$HP" "${HELD[@]}" "${TEAM[@]}" > "$T/p2.out" 2>&1; RC=$?
installer "$HP" "${HELD[@]}" "${TEAM[@]}" -- -Check > "$T/p3.out" 2>&1; RC3=$?
if [ "$RC" -eq 0 ] && [ "$RC3" -eq 0 ] && cmp -s "$SP" "$T/p.settings.json" && [ "$(unsafe_notice "$T/p2.out" '«\$»')" = 10 ] && [ "$(unsafe_notice "$T/p3.out" '«\$»')" = 10 ] && ! grep -q 'hooks faltan' "$T/p3.out"; then
  ok "(t) la segunda corrida no cambia settings.json y lo vuelve a decir; -Check lo dice y no los cuenta entre los que faltan"
else no "(t) la segunda corrida o -Check con \$ en la carpeta de usuario (rc $RC y $RC3): $(unsafe_notice "$T/p2.out" '«\$»') y $(unsafe_notice "$T/p3.out" '«\$»') línea(s) · $(grep -c 'hooks faltan' "$T/p3.out") aviso(s) de faltantes"; fi
# (2) el clon trae `$` en su ruta: los guiones del clon —los tres .sh entre ellos— no se registran; los de las skills, sí
cp -R "$CLONE" "$DOLLAR_DIR/clone"
HPC="$(new_home dollar-clone)"; SPC="$HPC/.claude/settings.json"
LAB_INSTALLER="$DOLLAR_DIR/clone/scripts/install-tycon-hooks.ps1" installer "$HPC" "${HELD[@]}" "${TEAM[@]}" > "$T/pc.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(unsafe_cmds "$SPC")" = "0 de 10" ] && [ "$(hook_n "$SPC" PreToolUse '*' safety-guard-pre.sh)$(hook_n "$SPC" PreToolUse '*' test-scope-guard-pre.sh)$(hook_n "$SPC" PreToolUse '*' engram-pre-commit.sh)" = 000 ] \
   && [ "$(unsafe_notice "$T/pc.out" '«\$»')" = 30 ] && [ "$(unsafe_notice "$T/pc.out" 'safety-guard-pre\.sh (PreToolUse)')" = 1 ] && [ "$(hook_n "$SPC" PreToolUse 'Bash|PowerShell' tycon-pipeline/scripts/on-bash-write-gate.js)" = 1 ]; then
  ok "(t) con \$ en la ruta del clon: sus 29 guiones —los tres .sh entre ellos— no se registran y cada uno se nombra; los 10 de las skills (ruta sin \$) quedan"
else no "(t) con \$ en la ruta del clon (rc $RC): comandos inseguros «$(unsafe_cmds "$SPC")» (esperaba «0 de 10»), $(unsafe_notice "$T/pc.out" '«\$»') línea(s) (esperaba 30), safety-guard $(hook_n "$SPC" PreToolUse '*' safety-guard-pre.sh) · $(brief "$T/pc.out" 200)"; fi

# ── (r) Ps1_LegacyEngramHookRemoved_OwnLookalikeKept · las formas viejas de engram-pre-commit.sh ────────────────
# El .sh las saca desde julio (LEGACY_FRAGMENTS): la copia suelta en ~/.claude/hooks/ y la variante escrita a mano con
# el sync adentro. El .ps1 no tenía ese paso, y con «ya está» decidido por el nombre del guion tomaba la copia vieja por
# la del arnés: seguía corriendo el guion viejo y el nuevo no se registraba nunca. Y al revés: con engram apagado sacaba
# CUALQUIER hook que se llamara igual, también uno propio de la persona en otra carpeta. La regla: un hook del arnés es
# el guion EN SU LUGAR DEL REPO (`…/scripts/hooks/<guion>` o `…/skills/<ruta>`), no cualquiera con ese nombre.
cat > "$T/legacy.js" <<'JS'
'use strict';
// legacy.js <settings.json> <home> <carpeta propia> <with-legacy|own-only>: un settings.json con un hook PROPIO de la
// persona que se llama igual que el del arnés (en otra carpeta), otro ajeno, y —con `with-legacy`— las dos formas viejas.
const fs = require('fs');
const [file, home, own, mode] = process.argv.slice(2);
const cmd = (command) => ({ type: 'command', command });
const hooks = [];
if (mode === 'with-legacy') {
  hooks.push(cmd(`bash "${home}/.claude/hooks/engram-pre-commit.sh"`));
  hooks.push(cmd('bash -c \'CMD=$(cat); case "$CMD" in *"git commit"*|*"git push"*) REPO=$(git rev-parse --show-toplevel 2>/dev/null); engram sync;; esac\''));
}
hooks.push(cmd(`bash "${own}/engram-pre-commit.sh"`));
hooks.push(cmd('echo lab-pre-bash'));
fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks }] } }, null, 2) + '\n');
JS
OWN_DIR="$T/own-hooks"
legacy_home() { # <nombre> <with-legacy|own-only> → una HOME con ese settings.json y el enlace a las skills
  local h; h="$(new_home "$1")" && mkdir -p "$h/.claude" && ln -s "$CLONE" "$h/.claude/agent-skills" && node "$T/legacy.js" "$h/.claude/settings.json" "$h" "$OWN_DIR" "$2" && echo "$h"
}
legacy_state() { # <settings>: «<copia vieja> <variante a mano> <la del arnés> <la propia> <el otro ajeno>», cuántas veces está cada una
  local s="$1"
  printf '%s %s %s %s %s' "$(hook_n "$s" PreToolUse '*' .claude/hooks/engram-pre-commit.sh)" "$(grep -c 'rev-parse --show-toplevel' "$s")" \
    "$(hook_n "$s" PreToolUse 'Bash|PowerShell' scripts/hooks/engram-pre-commit.sh)" "$(hook_n "$s" PreToolUse '*' own-hooks/engram-pre-commit.sh)" "$(grep -c 'echo lab-pre-bash' "$s")"
}
legacy_lines() { grep -c -- '- PreToolUse .*legacy' "$1"; }   # <salida>: los renglones que dicen que se sacó una forma vieja
# con la integración engram prendida: las dos formas viejas se van, entra la del arnés UNA vez, lo propio y lo ajeno quedan
HL="$(legacy_home legacy-engram-on with-legacy)"; SL="$HL/.claude/settings.json"
if [ "$(legacy_state "$SL")" != "1 1 0 1 1" ]; then no "(r) no pude armar la máquina con las formas viejas de engram-pre-commit.sh: «$(legacy_state "$SL")»"; fi
installer "$HL" "${HELD[@]}" "${TEAM[@]}" > "$T/l.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(legacy_state "$SL")" = "0 0 1 1 1" ] && same_cmd "$SL" PreToolUse 'Bash|PowerShell' scripts/hooks/engram-pre-commit.sh "$SH_PREFIX\"$CLONE/scripts/hooks/engram-pre-commit.sh\"" && [ "$(legacy_lines "$T/l.out")" = 2 ]; then
  ok "(r) las formas viejas de engram-pre-commit.sh (la copia en ~/.claude/hooks y la escrita a mano) se sacan y se dice; entra la del arnés una vez; el hook propio que se llama igual y el ajeno quedan"
else no "(r) las formas viejas con engram prendido (rc $RC): quedó «$(legacy_state "$SL")» (esperaba «0 0 1 1 1»: vieja, a mano, del arnés, propia, ajena) · $(legacy_lines "$T/l.out") renglón(es) de aviso · $(brief "$T/l.out" 200)"; fi
cp "$SL" "$T/l.settings.json"
installer "$HL" "${HELD[@]}" "${TEAM[@]}" > "$T/l2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$SL" "$T/l.settings.json" && [ "$(legacy_lines "$T/l2.out")" = 0 ]; then ok "(r) la segunda corrida deja settings.json byte a byte igual y no vuelve a sacar nada"
else no "(r) la segunda corrida tras sacar las formas viejas (rc $RC) cambió settings.json: «$(legacy_state "$SL")» · $(brief "$T/l2.out" 200)"; fi
# con la integración engram apagada, y con TYCON_ENGRAM_HOOK=0: las formas viejas se sacan igual (como el .sh), la del
# arnés no entra, y el hook propio que se llama igual NO se toca
HF="$(legacy_home legacy-engram-off with-legacy)"; SF="$HF/.claude/settings.json"
installer "$HF" "${HELD[@]}" > "$T/lf.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(legacy_state "$SF")" = "0 0 0 1 1" ] && [ "$(legacy_lines "$T/lf.out")" = 2 ]; then ok "(r) con la integración engram apagada: las formas viejas se sacan igual, la del arnés no entra y el hook propio que se llama igual queda"
else no "(r) las formas viejas con engram apagado (rc $RC): quedó «$(legacy_state "$SF")» (esperaba «0 0 0 1 1») · $(legacy_lines "$T/lf.out") renglón(es) de aviso · $(brief "$T/lf.out" 200)"; fi
HZ0="$(legacy_home legacy-hook-var-off with-legacy)"; SZ0="$HZ0/.claude/settings.json"
installer "$HZ0" "${HELD[@]}" "${TEAM[@]}" TYCON_ENGRAM_HOOK=0 > "$T/lz.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(legacy_state "$SZ0")" = "0 0 0 1 1" ] && [ "$(hook_n "$SZ0" SessionStart '*' engram-drift-notice.js)" = 1 ]; then ok "(r) con TYCON_ENGRAM_HOOK=0: las formas viejas se sacan igual, la del arnés no entra y el hook propio queda"
else no "(r) las formas viejas con TYCON_ENGRAM_HOOK=0 (rc $RC): quedó «$(legacy_state "$SZ0")» (esperaba «0 0 0 1 1») · $(brief "$T/lz.out" 200)"; fi
# el espejo: sin formas viejas no se saca nada; y el hook propio que se llama igual no es «ya está»: la del arnés entra
HN="$(legacy_home own-lookalike own-only)"; SN="$HN/.claude/settings.json"
installer "$HN" "${HELD[@]}" "${TEAM[@]}" > "$T/ln.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(legacy_state "$SN")" = "0 0 1 1 1" ] && [ "$(legacy_lines "$T/ln.out")" = 0 ] && ! grep -q 'removí' "$T/ln.out"; then ok "(r) el espejo: sin formas viejas no se saca nada, y un hook propio que se llama igual que el del arnés no cuenta como «ya está»: el del arnés entra y el propio queda"
else no "(r) el espejo sin formas viejas (rc $RC): quedó «$(legacy_state "$SN")» (esperaba «0 0 1 1 1») · $(grep -c 'removí' "$T/ln.out") aviso(s) de removido · $(brief "$T/ln.out" 200)"; fi
installer "$HN" "${HELD[@]}" > "$T/ln2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(legacy_state "$SN")" = "0 0 0 1 1" ]; then ok "(r) al apagar la integración engram se saca el del arnés y el hook propio que se llama igual queda"
else no "(r) al apagar engram con un hook propio que se llama igual (rc $RC): quedó «$(legacy_state "$SN")» (esperaba «0 0 0 1 1») · $(brief "$T/ln2.out" 200)"; fi

fi   # ── fin de la parte 1 ──

if suite_part 2; then   # ── parte 2 de 2: de (u) al final ──

# ── (u) Ps1_LaunchedByOldHarness_ShDeferredToNextRun · pase adversarial de la W3a (B1) ─────────────────────────────
# La actualización que TRAE esta tanda la juzga la salud de la versión anterior (harness.js la carga antes de mover el
# árbol), y esa salud revisa cada .sh del reporte con el primer `bash` del PATH: en Windows puede ser el lanzador de WSL,
# que sale 1 con un guion sano, y la actualización volvería atrás para siempre. Un harness.js de esta tanda en adelante
# lanza el .ps1 con TYCON_HARNESS_GIT_BASH_HEALTH=1 (su salud sabe usar el bash de Git); uno de antes, no. Lanzado por
# harness.js (TYCON_HARNESS_LOCK_HELD=1) SIN esa variable, el .ps1 no registra los .sh en esa corrida —no saca los que ya
# estén, y no los pone en el reporte—, y lo dice en una línea; los .js, como siempre. Suelto, registra todo.
OLD_HARNESS=TYCON_HARNESS_LOCK_HELD=1
SH_HOOKS=(safety-guard-pre.sh test-scope-guard-pre.sh engram-pre-commit.sh)
sh_state() { local s="$1" r out=""; for r in "${SH_HOOKS[@]}"; do out="$out$(hook_n "$s" PreToolUse 'Bash|PowerShell' "$r")"; done; printf '%s' "$out"; }   # <settings> → «111» = los tres una vez
# (el reporte nombra un hook por evento y guion: las dos filas PostToolUse de rebuild-before-verify.js son UN id, así que
# los 39 registrados son 38 ids)
report_sh() { node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.filter((p)=>p.kind==="hook"&&/\.sh$/.test(p.id)).length+" de "+r.filter((p)=>p.kind==="hook").length)}catch(e){console.log("ilegible: "+e.message)}' "$1"; }   # <reporte> → «<hooks .sh> de <hooks>»
deferred_notice() { grep 'se registran en la corrida siguiente' "$1" | grep -c 'harness.js de una versión anterior'; }   # <salida>
HM="$(new_home old-harness)"; SM="$HM/.claude/settings.json"
installer "$HM" "$OLD_HARNESS" "${TEAM[@]}" -- -ReportJson "$T/m1.report.json" > "$T/m1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(sh_state "$SM")" = 000 ] && [ "$(report_sh "$T/m1.report.json")" = "0 de 36" ] && [ "$(deferred_notice "$T/m1.out")" = 1 ] \
   && grep 'se registran en la corrida siguiente' "$T/m1.out" | grep 'safety-guard-pre\.sh' >/dev/null; then
  ok "(u) lanzado por un harness.js de antes (sin TYCON_HARNESS_GIT_BASH_HEALTH): ningún .sh en settings.json ni en el reporte (sus 35 ids de hook son .js), y UNA línea dice que se registran en la corrida siguiente"
else no "(u) lanzado por un harness.js de antes (rc $RC): .sh registrados «$(sh_state "$SM")» (esperaba 000), reporte «$(report_sh "$T/m1.report.json")» (esperaba «0 de 36»), $(deferred_notice "$T/m1.out") línea(s) · $(brief "$T/m1.out" 200)"; fi
if [ "$(hook_n "$SM" Stop '*' large-read-meter.js)$(hook_n "$SM" PreToolUse 'Bash|PowerShell' push-phantom-ref-notice.js)$(hook_n "$SM" UserPromptSubmit '*' rebuild-before-verify.js)" = 111 ]; then ok "(u) …en esa misma corrida los .js se registran como siempre"
else no "(u) lanzado por un harness.js de antes, los .js no quedaron: large-read-meter $(hook_n "$SM" Stop '*' large-read-meter.js), push-phantom $(hook_n "$SM" PreToolUse 'Bash|PowerShell' push-phantom-ref-notice.js)"; fi
# la corrida siguiente, ya con un harness.js de esta tanda: quedan los tres, una vez cada uno, en el reporte y sin la línea
installer "$HM" "${HELD[@]}" "${TEAM[@]}" -- -ReportJson "$T/m2.report.json" > "$T/m2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(sh_state "$SM")" = 111 ] && [ "$(report_sh "$T/m2.report.json")" = "3 de 39" ] && [ "$(deferred_notice "$T/m2.out")" = 0 ]; then
  ok "(u) el espejo: la corrida siguiente con TYCON_HARNESS_GIT_BASH_HEALTH=1 registra los tres .sh una vez cada uno, los reporta y no dice nada"
else no "(u) la corrida siguiente con la variable (rc $RC): .sh «$(sh_state "$SM")» (esperaba 111), reporte «$(report_sh "$T/m2.report.json")» (esperaba «3 de 39»), $(deferred_notice "$T/m2.out") línea(s) · $(brief "$T/m2.out" 200)"; fi
# otra vez un harness.js de antes, con los .sh ya registrados: no los saca (settings.json byte a byte igual) y no los reporta
cp "$SM" "$T/m.settings.json"
installer "$HM" "$OLD_HARNESS" "${TEAM[@]}" -- -ReportJson "$T/m3.report.json" > "$T/m3.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$SM" "$T/m.settings.json" && [ "$(report_sh "$T/m3.report.json")" = "0 de 36" ] && [ "$(deferred_notice "$T/m3.out")" = 0 ]; then
  ok "(u) un harness.js de antes sobre una máquina con los .sh ya registrados: no los saca (settings.json byte a byte igual), no los reporta y no dice que faltan"
else no "(u) un harness.js de antes con los .sh ya registrados (rc $RC): settings.json $(cmp -s "$SM" "$T/m.settings.json" && echo igual || echo CAMBIÓ), reporte «$(report_sh "$T/m3.report.json")», $(deferred_notice "$T/m3.out") línea(s)"; fi
# suelto (a mano, sin harness.js): registra todo, sin la línea
HMS="$(new_home standalone-sh)"
installer "$HMS" "${TEAM[@]}" > "$T/m4.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(sh_state "$HMS/.claude/settings.json")" = 111 ] && [ "$(deferred_notice "$T/m4.out")" = 0 ]; then ok "(u) el espejo: corrido suelto (sin harness.js) registra los tres .sh, sin la línea"
else no "(u) corrido suelto (rc $RC): .sh «$(sh_state "$HMS/.claude/settings.json")» (esperaba 111), $(deferred_notice "$T/m4.out") línea(s) · $(brief "$T/m4.out" 200)"; fi
# W4 · AC 34 · corrido suelto toma el candado de scripts/setup/harness/lock.js (el mismo de harness.js) y lo suelta al
# salir; con el candado tomado por otra sesión se va diciendo «otra sesión está instalando», sale 0 y no escribe nada
LOCK_DIR="$HMS/.claude/.tycon-pipeline/harness/harness.lock"
if [ ! -e "$LOCK_DIR" ]; then ok "(u) AC 34 · corrido suelto suelta el candado al terminar"
else no "(u) AC 34 · corrido suelto dejó el candado tomado ($LOCK_DIR)"; fi
HLK="$(new_home locked)"
lab_env "$HLK" -- node -e 'const r=require(process.argv[1]).acquire(require("os").homedir());process.exit(r.ok?0:1)' "$CLONE/scripts/setup/harness/lock.js" > "$T/lk0.out" 2>&1
# el que lo tomó ya terminó: a nombre de un proceso VIVO (esta prueba), que es «otra sesión» (story 8.23, AC 37: el de un
# proceso muerto se pisa en el acto)
printf '%s\n' "$$" > "$HLK/.claude/.tycon-pipeline/harness/harness.lock/pid"
LK_BEFORE="$(listing "$HLK")"
installer "$HLK" "${TEAM[@]}" > "$T/lk1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q 'otra sesión está instalando' "$T/lk1.out" && [ ! -e "$HLK/.claude/settings.json" ] && [ "$(listing "$HLK")" = "$LK_BEFORE" ]; then
  ok "(u) AC 34 · con el candado tomado por otra sesión, corrido suelto sale 0, dice «otra sesión está instalando» y no escribe nada"
else no "(u) AC 34 · con el candado tomado (rc $RC): $(grep -c 'otra sesión está instalando' "$T/lk1.out") línea(s), settings.json $([ -e "$HLK/.claude/settings.json" ] && echo ESCRITO || echo 'sin escribir') · $(brief "$T/lk1.out" 200)"; fi
# -Check no se juzga con ninguna salud: lista los .sh entre los que faltan aunque lo lance un harness.js de antes
HMC="$(new_home old-harness-check)"
installer "$HMC" "$OLD_HARNESS" "${TEAM[@]}" -- -Check > "$T/m5.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && grep -q '+ PreToolUse .*safety-guard-pre\.sh' "$T/m5.out" && [ "$(deferred_notice "$T/m5.out")" = 0 ] && [ -z "$(listing "$HMC")" ]; then ok "(u) -Check lanzado por un harness.js de antes: lista los .sh entre los que faltan, sin la línea, y no escribe nada"
else no "(u) -Check lanzado por un harness.js de antes (rc $RC): $(grep -c '+ PreToolUse .*\.sh' "$T/m5.out") .sh listado(s), $(deferred_notice "$T/m5.out") línea(s) · $(brief "$T/m5.out" 200)"; fi

# ── (v) Ps1_ShellMatcherWidened_OneEntryPerScript (2026-10-04) ────────────────────────────────────────────────────
# En Windows Claude Code corre los comandos con su herramienta PowerShell, y un hook con matcher `Bash` solo no se dispara
# (medido en una sesión real: los frenos instalados no frenaban). Los que miran comandos pasaron a `Bash|PowerShell`. Una
# máquina ya instalada los tiene con `Bash`, y como los matchers se comparan como conjuntos el instalador agregaba el
# nuevo y dejaba el viejo (en Bash, el freno dos veces). La misma pieza con un matcher más angosto se MUEVE al nuevo, con
# su comando tal cual; una copia que sobre se saca; lo ajeno de ese bloque queda donde estaba.
SHELL_ROWS=(
  "PreToolUse|Bash|PowerShell|safety-guard-pre.sh" "PreToolUse|Bash|PowerShell|test-scope-guard-pre.sh" "PreToolUse|Bash|PowerShell|engram-pre-commit.sh"
  "PreToolUse|Bash|PowerShell|push-phantom-ref-notice.js" "PreToolUse|Bash|PowerShell|pr-auto-complete-guard.js" "PreToolUse|Bash|PowerShell|public-push-guard.js"
  "PreToolUse|Bash|PowerShell|tycon-pipeline/scripts/on-pre-commit.js" "PreToolUse|Bash|PowerShell|tycon-pipeline/scripts/on-bash-write-gate.js"
  "PostToolUse|Bash|PowerShell|retro-pending.js" "PostToolUse|Bash|PowerShell|unpushed-work-notice.js" "PostToolUse|Bash|PowerShell|failed-query-notice.js"
)
cat > "$T/widen.js" <<'JS'
'use strict';
// widen.js old <src> <dst>   → la misma settings.json «de antes»: cada `Bash|PowerShell` como `Bash`, con un hook ajeno
//                              en cada uno de esos bloques
// widen.js both <src> <dst>  → la de ahora MÁS el freno con el matcher viejo, en un bloque aparte
// widen.js state <settings>  → «<hooks del arnés con Bash solo> <ajenos con Bash>/<ajenos en total>»
const fs = require('fs');
const [mode, a, b] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(a, 'utf8'));
const ours = (c) => /^(node|bash) "/.test(String(c || ''));   // un .js con node, un .sh con bash (W3W4)
if (mode === 'old') {
  for (const ev of ['PreToolUse', 'PostToolUse']) for (const e of s.hooks[ev] || []) if (e.matcher === 'Bash|PowerShell') {
    e.matcher = 'Bash'; e.hooks.push({ type: 'command', command: `echo lab-${ev}-bash` });
  }
  fs.writeFileSync(b, JSON.stringify(s, null, 2) + '\n');
} else if (mode === 'both') {
  const sg = s.hooks.PreToolUse.flatMap((e) => e.hooks).find((h) => /safety-guard-pre\.sh"$/.test(h.command));
  s.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: sg.command }] });
  fs.writeFileSync(b, JSON.stringify(s, null, 2) + '\n');
} else {
  let narrow = 0, foreignBash = 0, foreign = 0;
  for (const [ev, bucket] of Object.entries(s.hooks || {})) for (const e of bucket) for (const h of e.hooks || []) {
    if (/^(Pre|Post)ToolUse$/.test(ev) && e.matcher === 'Bash' && ours(h.command)) narrow++;
    if (/^echo lab-(Pre|Post)ToolUse-bash$/.test(h.command)) { foreign++; if (e.matcher === 'Bash') foreignBash++; }
  }
  console.log(`${narrow} ${foreignBash}/${foreign}`);
}
JS
HW="$(new_home widen)"; SW="$HW/.claude/settings.json"
installer "$HW" "${HELD[@]}" "${TEAM[@]}" > "$T/n0.out" 2>&1
node "$T/widen.js" old "$SW" "$SW"; cp "$SW" "$T/n.old.json"
if [ "$(node "$T/widen.js" state "$SW")" != "12 2/2" ]; then no "(v) no pude armar la settings.json de antes: «$(node "$T/widen.js" state "$SW")» (esperaba «12 2/2»)"; fi
installer "$HW" "${HELD[@]}" "${TEAM[@]}" > "$T/n1.out" 2>&1; RC=$?
BAD="$(wrong_counts "$SW" 1 "${SHELL_ROWS[@]}")"
RB="$(hook_n "$SW" PostToolUse 'Bash|PowerShell' rebuild-before-verify.js)$(hook_n "$SW" PostToolUse 'Edit|Write' rebuild-before-verify.js)$(hook_n "$SW" PostToolUse '*' rebuild-before-verify.js)"
if [ "$RC" -eq 0 ] && [ -z "$BAD" ] && [ "$RB" = 112 ] && [ "$(node "$T/widen.js" state "$SW")" = "0 2/2" ]; then
  ok "(v) una settings.json de antes (matcher «Bash»): cada guion queda UNA vez, con «Bash|PowerShell»; rebuild-before-verify.js sigue también con «Edit|Write»; lo ajeno sigue con «Bash»"
else no "(v) una settings.json de antes (rc $RC):${BAD:- —} · rebuild «${RB}» (esperaba 112) · estado «$(node "$T/widen.js" state "$SW")» (esperaba «0 2/2») · $(brief "$T/n1.out" 200)"; fi
N="$(grep -c 'matcher ampliado' "$T/n1.out")"
OLD_SG="$(node -e 'const s=require(process.argv[1]);for(const e of s.hooks.PreToolUse)for(const h of e.hooks)if(/safety-guard-pre\.sh"$/.test(h.command))console.log(h.command)' "$T/n.old.json")"
if [ "$N" = 12 ] && same_cmd "$SW" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh "$OLD_SG"; then ok "(v) el reporte dice cada matcher ampliado (12) y el guion conserva su comando tal cual"
else no "(v) el reporte nombra $N matcher(s) ampliado(s) (esperaba 12); safety-guard quedó «$(hook_cmd "$SW" PreToolUse 'Bash|PowerShell' safety-guard-pre.sh)» (antes «${OLD_SG}»)"; fi
cp "$SW" "$T/n.after.json"
installer "$HW" "${HELD[@]}" "${TEAM[@]}" > "$T/n2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$SW" "$T/n.after.json"; then ok "(v) una segunda corrida deja settings.json byte a byte igual"
else no "(v) la segunda corrida (rc $RC) cambió settings.json: $(diff <(hook_order "$T/n.after.json") <(hook_order "$SW") | head -4 | tr '\n' ' ')"; fi
# el viejo y el nuevo a la vez (una máquina que volvió a una versión anterior y después avanzó): queda uno, y se dice
HW2="$(new_home widen-both)"; SW2="$HW2/.claude/settings.json"
installer "$HW2" "${HELD[@]}" "${TEAM[@]}" > "$T/n3.out" 2>&1
node "$T/widen.js" both "$SW2" "$SW2"
installer "$HW2" "${HELD[@]}" "${TEAM[@]}" > "$T/n4.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ -z "$(wrong_counts "$SW2" 1 "${SHELL_ROWS[@]}")" ] && grep -- '- PreToolUse' "$T/n4.out" | grep 'safety-guard-pre\.sh' | grep 'matcher viejo' >/dev/null; then
  ok "(v) el viejo y el nuevo a la vez: queda uno, y se dice"
else no "(v) el viejo y el nuevo a la vez (rc $RC):$(wrong_counts "$SW2" 1 "${SHELL_ROWS[@]}") · $(grep 'safety-guard' "$T/n4.out" | head -1 | cut -c1-200)"; fi
# -Check sobre la de antes: sale 0, no escribe, y nombra lo que falta con su matcher nuevo
HW3="$(new_home widen-check)"; mkdir -p "$HW3/.claude"; ln -s "$CLONE" "$HW3/.claude/agent-skills"; cp "$T/n.old.json" "$HW3/.claude/settings.json"
installer "$HW3" "${HELD[@]}" "${TEAM[@]}" -- -Check > "$T/n5.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$HW3/.claude/settings.json" "$T/n.old.json" && grep -q "+ PreToolUse (matcher='Bash|PowerShell') → @tcg:safety-guard-pre.sh" "$T/n5.out"; then
  ok "(v) -Check sobre la de antes: sale 0, no escribe y nombra el freno con su matcher nuevo"
else no "(v) -Check sobre la de antes (rc $RC): $(grep -m1 'safety-guard' "$T/n5.out" | cut -c1-200) · $(cmp -s "$HW3/.claude/settings.json" "$T/n.old.json" && echo 'sin escribir' || echo 'ESCRIBIÓ')"; fi

# ═══ el sync de bloques: un marcador `requires-integration` CASI bien escrito (hallazgos 11 y 16) ═══════════════
# Los seis bloques de juguete de integrations-off.test.sh (T32), por el .sh y por el .ps1: el CLAUDE.md, byte a byte.
SLAB="$T/sync-lab"
SYNC_ENV=(TYCON_NO_CLAUDEMD_SYNC=0)   # SAFE lo apaga para el instalador; acá es lo que se mide
sync_sh() { local h="$1"; shift; lab_env "$h" "${SYNC_ENV[@]}" "$@" -- bash "$SLAB/scripts/setup/sync-claude-md-blocks.sh"; }
sync_ps1() { local h="$1"; shift; lab_env "$h" "${SYNC_ENV[@]}" "$@" -- pwsh -NoProfile -NonInteractive -File "$SLAB/scripts/setup/sync-claude-md-blocks.ps1"; }
sync_home() { # <nombre> [seed]: una HOME con `.claude`; con `seed`, un CLAUDE.md a mano con tres bloques viejos
  local h; h="$(new_home "$1")" && mkdir -p "$h/.claude" || return 1
  if [ "${2:-}" = seed ]; then
    printf '# notas del dev\n\nuna regla escrita a mano\n' > "$h/.claude/CLAUDE.md"
    for b in upper blank bom; do printf '\n<!-- TYCON_BLOCK:%s START -->\nVIEJO\n<!-- TYCON_BLOCK:%s END -->\n' "$b" "$b" >> "$h/.claude/CLAUDE.md"; done
  fi
  echo "$h"
}
has_block() { grep -q "TYCON_BLOCK:$2 START" "$1" 2>/dev/null; }   # <archivo> <bloque>
names() { awk -F'\t' '$1 == "block" { sub(/^TYCON_BLOCK:/, "", $3); print $3 }' "$1" 2>/dev/null | LC_ALL=C sort | tr '\n' ' '; }   # <archivo de piezas>: los bloques anotados
same_as_sh() { # <caso> <home del .sh> <home del .ps1> <salida .sh> <salida .ps1>: el CLAUDE.md byte a byte, y lo que dijeron
  if [ -f "$2/.claude/CLAUDE.md" ] && cmp -s "$2/.claude/CLAUDE.md" "$3/.claude/CLAUDE.md"; then ok "sync · $1: el CLAUDE.md del .ps1 es byte a byte el del .sh"
  else no "sync · $1: el CLAUDE.md del .ps1 no es el del .sh: $(diff "$2/.claude/CLAUDE.md" "$3/.claude/CLAUDE.md" 2>&1 | head -6 | tr '\n' ' ' | cut -c1-300)"; fi
  if [ "$(grep -v 'backup en' "$4")" = "$(grep -v 'backup en' "$5")" ]; then ok "sync · $1: el .ps1 dice lo mismo que el .sh"
  else no "sync · $1: el .ps1 no dice lo mismo que el .sh: $(diff <(grep -v 'backup en' "$4") <(grep -v 'backup en' "$5") | head -4 | tr '\n' ' ' | cut -c1-300)"; fi
}
sync_section() {
  mkdir -p "$SLAB/scripts/setup" "$SLAB/claude-md-blocks"
  cp -R "$ROOT/scripts/lib" "$SLAB/scripts/lib"
  cp "$ROOT/scripts/setup/sync-claude-md-blocks.sh" "$ROOT/scripts/setup/sync-claude-md-blocks.ps1" "$SLAB/scripts/setup/"
  printf '<!-- requires-integration: ADO -->\n# regla\ntexto de upper\n' > "$SLAB/claude-md-blocks/upper.md"
  printf '<!-- requires-integration: ado-org -->\n# regla\ntexto de dashed\n' > "$SLAB/claude-md-blocks/dashed.md"
  printf '<!-- requires-integration: ado, clockify -->\n# regla\ntexto de multi\n' > "$SLAB/claude-md-blocks/multi.md"
  printf '\n<!-- requires-integration: ado -->\n# regla\ntexto de blank\n' > "$SLAB/claude-md-blocks/blank.md"
  printf '\357\273\277<!-- requires-integration: ado -->\n# regla\ntexto de bom\n' > "$SLAB/claude-md-blocks/bom.md"
  printf '<!-- una nota cualquiera -->\n# regla común\ntexto de plain\n' > "$SLAB/claude-md-blocks/plain.md"

  # bloque ausente, Azure DevOps apagado
  S1="$(sync_home marker-absent-sh)"; P1="$(sync_home marker-absent-ps1)"
  sync_sh "$S1" > "$T/s1.sh.out" 2>&1; sync_ps1 "$P1" > "$T/s1.ps1.out" 2>&1; RC=$?
  MD="$P1/.claude/CLAUDE.md"; BAD=""
  [ "$RC" -eq 0 ] || BAD="$BAD salió $RC;"
  for b in upper dashed multi blank; do
    has_block "$MD" "$b" && BAD="$BAD $b(se escribió)"
    [ "$(grep -c "bloque CLAUDE.md '$b': su marcador requires-integration está mal escrito (.*; va en la primera línea, exacto: <!-- requires-integration: nombre -->): no se agrega\$" "$T/s1.ps1.out")" = 1 ] || BAD="$BAD $b(sin su línea)"
  done
  if [ -z "$BAD" ] && ! grep -q 'requires-integration' "$MD" 2>/dev/null; then ok "sync .ps1 · un marcador casi bien escrito (mayúsculas, guion, dos nombres, fuera de la primera línea): el bloque no se agrega, el comentario no se copia y UNA línea lo dice"
  else no "sync .ps1 · marcador casi bien escrito:$BAD · $(grep -c 'requires-integration' "$MD" 2>/dev/null) comentario(s) copiado(s) · $(brief "$T/s1.ps1.out" 200)"; fi
  if ! has_block "$MD" bom && ! grep -q "'bom'" "$T/s1.ps1.out"; then ok "sync .ps1 · un BOM delante del marcador no cambia nada: apagada, el bloque no se escribe (y sin aviso: está bien escrito)"
  else no "sync .ps1 · con BOM delante del marcador: $(has_block "$MD" bom && echo 'el bloque se escribió') $(grep "'bom'" "$T/s1.ps1.out" | head -1 | cut -c1-160)"; fi
  if has_block "$MD" plain && grep -q '^<!-- una nota cualquiera -->$' "$MD"; then ok "sync .ps1 · el espejo: un bloque cuya primera línea es OTRO comentario es un bloque común (se escribe entero)"
  else no "sync .ps1 · el espejo: un bloque con otro comentario en su primera línea no se escribió entero"; fi
  same_as_sh "bloques ausentes, Azure DevOps apagado" "$S1" "$P1" "$T/s1.sh.out" "$T/s1.ps1.out"

  # bloque presente (viejo), Azure DevOps apagado: el mal escrito queda y se actualiza; el bien escrito (con BOM) se va
  S2="$(sync_home marker-present-sh seed)"; P2="$(sync_home marker-present-ps1 seed)"
  sync_sh "$S2" "TYCON_REPORT_PIECES=$T/s2.sh.pieces" > "$T/s2.sh.out" 2>&1; sync_ps1 "$P2" "TYCON_REPORT_PIECES=$T/s2.ps1.pieces" > "$T/s2.ps1.out" 2>&1
  MD="$P2/.claude/CLAUDE.md"
  if has_block "$MD" upper && grep -q '^texto de upper$' "$MD" && has_block "$MD" blank && grep -q '^texto de blank$' "$MD" && ! grep -q '^VIEJO$' "$MD" \
     && ! grep -q 'requires-integration' "$MD" && ! has_block "$MD" bom \
     && [ "$(grep "'upper'" "$T/s2.ps1.out" | grep -c 'mal escrito.*: queda donde está$')" = 1 ]; then
    ok "sync .ps1 · marcador mal escrito y bloque presente: queda, se actualiza sin el comentario y una línea lo dice; el bien escrito con BOM se quita (apagada)"
  else no "sync .ps1 · marcador mal escrito y bloque presente: $(brief "$T/s2.ps1.out" 240)"; fi
  same_as_sh "bloques presentes, Azure DevOps apagado" "$S2" "$P2" "$T/s2.sh.out" "$T/s2.ps1.out"

  # Azure DevOps prendido: el bloque con BOM entra, sin el marcador ni el BOM
  S3="$(sync_home marker-on-sh)"; P3="$(sync_home marker-on-ps1)"
  sync_sh "$S3" TYCON_ADO_ORG=https://dev.azure.com/acme > "$T/s3.sh.out" 2>&1; sync_ps1 "$P3" TYCON_ADO_ORG=https://dev.azure.com/acme > "$T/s3.ps1.out" 2>&1
  MD="$P3/.claude/CLAUDE.md"
  if has_block "$MD" bom && grep -q '^texto de bom$' "$MD" && ! grep -q 'requires-integration' "$MD" && ! LC_ALL=C grep -q "$(printf '\357\273\277')" "$MD" && ! has_block "$MD" upper; then
    ok "sync .ps1 · el espejo: con la integración prendida el bloque bien escrito (con BOM) se escribe, sin el marcador ni el BOM; el mal escrito sigue sin agregarse"
  else no "sync .ps1 · con la integración prendida: $(brief "$T/s3.ps1.out" 240)"; fi
  same_as_sh "Azure DevOps prendido" "$S3" "$P3" "$T/s3.sh.out" "$T/s3.ps1.out"

  # el registro de lo instalado (-ReportJson) anota «en su lugar» los mismos bloques que el sync .sh. Hasta la W4 el
  # instalador tenía su propia regla para eso (Record-BlocksInPlace, que servía a la salida temprana «sin cambios en
  # settings.json») y acá se la medía recortada del .ps1; la W4 sacó la salida temprana (AC 30) y con ella la función:
  # cada corrida llega al sync, que anota los bloques. Se mide por ejecución, con el instalador entero sobre un clon con
  # estos bloques de juguete: dos corridas sobre el mismo CLAUDE.md sembrado; la segunda, sin nada que cambiar, anota lo
  # mismo que la primera (lo que la salida temprana perdía).
  WANT="$(names "$T/s2.sh.pieces")"
  local BCL P4; BCL="$(blocks_clone sync "$SLAB/claude-md-blocks")"; P4="$(sync_home marker-present-installer seed)"
  LAB_INSTALLER="$BCL/scripts/install-tycon-hooks.ps1" installer "$P4" "${HELD[@]}" "${SYNC_ENV[@]}" -- -ReportJson "$T/s4a.report.json" > "$T/s4a.out" 2>&1; RC=$?
  LAB_INSTALLER="$BCL/scripts/install-tycon-hooks.ps1" installer "$P4" "${HELD[@]}" "${SYNC_ENV[@]}" -- -ReportJson "$T/s4b.report.json" > "$T/s4b.out" 2>&1; RC2=$?
  if [ -n "$WANT" ] && [ "$RC" -eq 0 ] && [ "$RC2" -eq 0 ] && [ "$(report_blocks "$T/s4a.report.json")" = "$WANT" ] && [ "$(report_blocks "$T/s4b.report.json")" = "$WANT" ] && [ "$(names "$T/s2.ps1.pieces")" = "$WANT" ]; then
    ok "el registro del .ps1 (-ReportJson, dos corridas: la segunda sin nada que cambiar) y el sync .ps1 anotan «en su lugar» los mismos bloques que el sync .sh ($WANT)"
  else no "el registro de los bloques: el sync .sh anota «${WANT}», el sync .ps1 «$(names "$T/s2.ps1.pieces")», el instalador .ps1 «$(report_blocks "$T/s4a.report.json")» y en la segunda corrida «$(report_blocks "$T/s4b.report.json")» (rc $RC y $RC2) $(brief "$T/s4b.out" 160)"; fi
}
blocks_clone() { # <nombre> <carpeta de bloques> → una copia del clon de laboratorio con ESOS bloques de CLAUDE.md
  local c="$T/clone-blocks-$1"; rm -rf "$c"; cp -R "$CLONE" "$c" && rm -rf "$c/claude-md-blocks" && cp -R "$2" "$c/claude-md-blocks" && echo "$c"
}
report_blocks() { # <reporte de -ReportJson> → los bloques que anota, como `names`
  node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const p of r)if(p.kind==="block")console.log(String(p.id).replace(/^TYCON_BLOCK:/,""))}catch(e){}' "$1" | LC_ALL=C sort -u | tr '\n' ' '
}
# el .sh es la referencia y corre con python3: sin él no hay contra qué comparar
# ── (v) T26 · Applier_Ps1_PlanJson_ByExecution (story 8.16, tanda B · AC 20) ───────────────────────────────────────
# `-Check -PlanJson <archivo>` escribe `[{kind, where, id, action}]` y nada más: en una HOME vacía todo es `add`; después de
# instalar, los hooks son `keep`; la HOME queda igual por hash; `-PlanJson` sin `-Check` sale 2. Lo lee harness.js install.
hhash() { ( cd "$1" && find . -print | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then printf '%s -> %s\n' "$f" "$(readlink "$f")"; elif [ -f "$f" ]; then printf '%s ' "$f"; shasum -a 256 < "$f"; else printf '%s/\n' "$f"; fi
  done ) | shasum -a 256 | cut -d' ' -f1; }
plan_check() { # <plan.json> <acción esperada para los hooks> → «ok» o el motivo
  python3 - "$1" "$2" <<'PY'
import json, sys
try: p = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e: print("ilegible: %s" % e); sys.exit(0)
if not isinstance(p, list) or not p: print("vacío"); sys.exit(0)
bad = [x for x in p if not set(["kind", "where", "id", "action"]) <= set(x) or x["action"] not in ("add", "update", "remove", "keep")]
hooks = [x for x in p if x["kind"] == "hook"]
wrong = [x["id"] for x in hooks if x["action"] != sys.argv[2]]
print("ok" if not bad and hooks and not wrong else "forma %d · hooks %d · no-%s %s" % (len(bad), len(hooks), sys.argv[2], wrong[:3]))
PY
}
HV="$(new_home plan-empty)"; V0="$(hhash "$HV")"
# con el sync de bloques prendido (SAFE lo apaga para el resto de la suite): así el plan trae también los bloques
installer "$HV" "${TEAM[@]}" TYCON_NO_CLAUDEMD_SYNC=0 -- -Check -PlanJson "$T/plan-v1.json" > "$T/v1.out" 2>&1; RC=$?
R="$(plan_check "$T/plan-v1.json" add)"
if [ "$RC" -eq 0 ] && [ "$R" = ok ] && [ "$(hhash "$HV")" = "$V0" ]; then ok "(v) T26 -Check -PlanJson en una HOME vacía: el plan trae cada hook con «add», y la HOME queda igual"
else no "(v) T26 HOME vacía (rc $RC): ${R} · HOME $( [ "$(hhash "$HV")" = "$V0" ] && echo igual || echo CAMBIADA ) · $(brief "$T/v1.out" 200)"; fi
python3 -c "import json,sys; k={x['kind'] for x in json.load(open(sys.argv[1]))}; sys.exit(0 if {'hook','link','block'} <= k else 1)" "$T/plan-v1.json" 2>/dev/null \
  && ok "(v) T26 …y cubre los enlaces y los bloques de CLAUDE.md, además de los hooks" || no "(v) T26 el plan no trae enlaces o bloques: $(head -c 300 "$T/plan-v1.json")"
HI="$(new_home plan-installed)"
installer "$HI" "${HELD[@]}" "${TEAM[@]}" > /dev/null 2>&1
V1="$(hhash "$HI")"
installer "$HI" "${TEAM[@]}" -- -Check -PlanJson "$T/plan-v2.json" > "$T/v2.out" 2>&1; RC=$?
R="$(plan_check "$T/plan-v2.json" keep)"
if [ "$RC" -eq 0 ] && [ "$R" = ok ] && [ "$(hhash "$HI")" = "$V1" ]; then ok "(v) T26 instalado: cada hook del plan es «keep», y la HOME queda igual"
else no "(v) T26 instalado (rc $RC): ${R} · $(brief "$T/v2.out" 200)"; fi
# las skills de terceros (con el paso prendido): cada una con la ruta de ~/.claude/agent-skills, como el reporte
installer "$HV" TYCON_THIRD_PARTY=1 -- -Check -PlanJson "$T/plan-v4.json" > "$T/v4.out" 2>&1; RC=$?
TP="$(python3 -c "
import json,os,sys
p=json.load(open(sys.argv[1])); tp=[x for x in p if x['kind']=='third-party']
root=os.path.normpath(sys.argv[2])+os.sep
print(len(tp), sum(1 for x in tp if not os.path.normpath(x['where']).startswith(root)))" "$T/plan-v4.json" "$HV/.claude/agent-skills" 2>/dev/null)"
case "$RC|$TP" in 0\|0\ *|0\|) no "(v) T26 con el paso de terceros prendido el plan no trae skills de terceros (rc $RC, «${TP}»)" ;;
  0\|*\ 0) ok "(v) T26 con el paso de terceros prendido: ${TP% *} skills de terceros en el plan, con la ruta de ~/.claude/agent-skills" ;;
  *) no "(v) T26 skills de terceros en el plan (rc $RC): «${TP}» · $(brief "$T/v4.out" 200)" ;; esac
# un hook viejo (uno que absorbió el despachador de ediciones): el plan lo trae con «remove», y -Check no lo saca
HR="$(new_home plan-remove)"; installer "$HR" "${HELD[@]}" "${TEAM[@]}" > /dev/null 2>&1
python3 - "$HR/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p, encoding="utf-8"))
s.setdefault("hooks", {}).setdefault("PostToolUse", []).append({"matcher": "Edit|Write", "hooks": [{"type": "command", "command": 'node "/viejo/agent-skills/skills/tycon-pipeline/scripts/on-edit.js"'}]})
json.dump(s, open(p, "w", encoding="utf-8"), indent=2)
PY
V2="$(hhash "$HR")"
installer "$HR" "${TEAM[@]}" -- -Check -PlanJson "$T/plan-v5.json" > "$T/v5.out" 2>&1; RC=$?
NR="$(python3 -c "import json,sys; print(sum(1 for x in json.load(open(sys.argv[1])) if x['kind']=='hook' and x['action']=='remove' and 'on-edit.js' in x['id']))" "$T/plan-v5.json" 2>/dev/null)"
if [ "$RC" -eq 0 ] && [ "${NR:-0}" -ge 1 ] && [ "$(hhash "$HR")" = "$V2" ]; then ok "(v) T26 con un hook viejo de más: el plan lo trae con «remove», y -Check no lo saca"
else no "(v) T26 hook viejo (rc $RC): ${NR:-0} remove · HOME $( [ "$(hhash "$HR")" = "$V2" ] && echo igual || echo CAMBIADA ) · $(brief "$T/v5.out" 200)"; fi
# un bloque escrito que pide una integración apagada: el sync lo saca al aplicar, y el plan lo dice con «remove»
HB="$(new_home plan-block-off)"; mkdir -p "$HB/.claude"
REQ="$(grep -l '^<!-- requires-integration:' "$CLONE"/claude-md-blocks/*.md | head -1)"
if [ -n "$REQ" ]; then
  BN="$(basename "$REQ" .md)"
  printf '# lo mío\n<!-- TYCON_BLOCK:%s START — viejo -->\nviejo\n<!-- TYCON_BLOCK:%s END -->\n' "$BN" "$BN" > "$HB/.claude/CLAUDE.md"
  installer "$HB" TYCON_NO_CLAUDEMD_SYNC=0 -- -Check -PlanJson "$T/plan-v6.json" > "$T/v6.out" 2>&1; RC=$?
  ACT="$(python3 -c "import json,sys; print(next((x['action'] for x in json.load(open(sys.argv[1])) if x['kind']=='block' and x['id']=='TYCON_BLOCK:'+sys.argv[2]), 'ninguna'))" "$T/plan-v6.json" "$BN" 2>/dev/null)"
  [ "$RC" -eq 0 ] && [ "$ACT" = remove ] && ok "(v) T26 un bloque escrito cuya integración está apagada: el plan lo trae con «remove»" || no "(v) T26 bloque con la integración apagada (rc $RC): acción «${ACT}» · $(brief "$T/v6.out" 200)"
else no "(v) T26 no hay ningún bloque con requires-integration para probar el «remove»"; fi
installer "$HV" -- -PlanJson "$T/plan-v3.json" > "$T/v3.out" 2>&1; RC=$?
if [ "$RC" -eq 2 ] && [ ! -e "$T/plan-v3.json" ] && [ "$(hhash "$HV")" = "$V0" ] && grep -q -- '-Check' "$T/v3.out"; then ok "(v) T26 -PlanJson sin -Check sale 2 con una línea y no escribe"
else no "(v) T26 -PlanJson sin -Check (rc $RC): $(brief "$T/v3.out" 200)"; fi

# ── (w) T39 · Applier_Ps1_Profile_ByExecution_BlocksByteIdenticalToSh (story 8.16, tanda C · AC 29) ─────────────────
# El .ps1 lee el perfil igual que el .sh (`tycon-config.js get install.profile`) y filtra SUS listas: en minimal registra
# sólo los hooks de su tabla que la lista de efectos marca `minimal`, saca los demás si estaban, y los dos frenos que nacen
# prendidos sólo entran con su variable en `1`; con la configuración rota no toca lo del perfil. Su sync de bloques
# obedece `requires-profile` y deja el CLAUDE.md byte a byte como el del .sh; su plan y su reporte reconocen esos bloques.
ps1_ids() { # <settings.json> → «EVENTO:ruta de su spec» de cada hook del arnés (`@tcg:` lo de scripts/hooks/), ordenado
  python3 - "$1" <<'PY' | LC_ALL=C sort -u
import json, re, sys
try: s = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception: sys.exit(0)
for ev, groups in (s.get("hooks") or {}).items():
    for g in groups:
        for h in g.get("hooks", []):
            for q in re.findall(r'"([^"]+)"', h.get("command", "")):
                q = q.replace("\\", "/")
                if "/scripts/hooks/" in q: print("%s:@tcg:%s" % (ev, q.split("/scripts/hooks/", 1)[1]))
                elif "/skills/" in q: print("%s:%s" % (ev, q.split("/skills/", 1)[1]))
PY
}
# lo esperado en minimal: los hooks de la tabla del .ps1 que la lista de efectos marca `minimal`, sin los de una
# integración (apagadas en el laboratorio) ni el freno de sesiones (nace apagado)
# (desde la W3 y W4 de la story 8.17 «su tabla» es la lista única, sin lo que excluye de Windows)
python3 - "$ROOT/scripts/setup/install-effects.json" "$HOOKS_LIST" > "$T/w-minimal.txt" <<'PY'
import json, sys
eff = json.load(open(sys.argv[1], encoding="utf-8"))["effects"]
hl = json.load(open(sys.argv[2], encoding="utf-8"))["hooks"]
rows = set("%s:%s" % (h["event"], h["spec"]) for h in hl if (h.get("platforms") or {}).get("windows") is not False)
for e in eff:
    # los opt-in de minimal que nacen prendidos cuentan (el freno de comandos, 2026-10-05); el de sesiones nace apagado
    if e["kind"] == "hook" and "minimal" in e["profiles"] and not e["when"].startswith("integration:") and e["when"] != "optin:TYCON_SESSION_GUARD" and e["id"] in rows:
        print(e["id"])
PY
LC_ALL=C sort -u -o "$T/w-minimal.txt" "$T/w-minimal.txt"
prof_home() { local h; h="$(new_home "$1")" && mkdir -p "$h/.claude" && printf '{ "install": { "profile": "%s" } }\n' "$2" > "$h/.claude/tycon.json" && echo "$h"; }
HW="$(prof_home w-minimal minimal)"
installer "$HW" -- > "$T/w1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ -s "$T/w-minimal.txt" ] && cmp -s <(ps1_ids "$HW/.claude/settings.json") "$T/w-minimal.txt"; then ok "(w) T39 minimal: el .ps1 registra sólo los hooks de su tabla que son de minimal ($(wc -l < "$T/w-minimal.txt" | tr -d ' '))"
else no "(w) T39 minimal (rc $RC): $(diff "$T/w-minimal.txt" <(ps1_ids "$HW/.claude/settings.json") | grep '^[<>]' | head -5 | tr '\n' ' ') · $(brief "$T/w1.out" 200)"; fi
HW2="$(prof_home w-minimal-sg minimal)"
# la variable manda en los dos sentidos: el freno de pruebas (sólo de full) entra con su variable en 1; el de comandos
# destructivos (de los dos perfiles desde el 2026-10-05) sale con la suya en 0
installer "$HW2" TYCON_TEST_SCOPE_GUARD=1 TYCON_SAFETY_GUARD=0 -- > "$T/w2.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && ps1_ids "$HW2/.claude/settings.json" | grep -x 'PreToolUse:@tcg:test-scope-guard-pre.sh' >/dev/null && ! ps1_ids "$HW2/.claude/settings.json" | grep 'safety-guard' >/dev/null; then ok "(w) T39 minimal + TYCON_TEST_SCOPE_GUARD=1 + TYCON_SAFETY_GUARD=0: entra el de pruebas, sale el de comandos"
else no "(w) T39 minimal + TYCON_TEST_SCOPE_GUARD=1 + TYCON_SAFETY_GUARD=0 (rc $RC): $(ps1_ids "$HW2/.claude/settings.json" | grep guard | tr '\n' ' ') · $(brief "$T/w2.out" 200)"; fi
grep -qx 'PreToolUse:@tcg:safety-guard-pre.sh' "$T/w-minimal.txt" && ok "(w) T39 el freno de comandos destructivos está entre los de minimal" || no "(w) T39 la lista de minimal no trae el freno de comandos destructivos"
HW3="$(prof_home w-switch full)"
installer "$HW3" -- > "$T/w3a.out" 2>&1
N_FULL="$(ps1_ids "$HW3/.claude/settings.json" | wc -l | tr -d ' ')"
printf '{ "install": { "profile": "minimal" } }\n' > "$HW3/.claude/tycon.json"
installer "$HW3" -- > "$T/w3b.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$N_FULL" -gt "$(wc -l < "$T/w-minimal.txt" | tr -d ' ')" ] && cmp -s <(ps1_ids "$HW3/.claude/settings.json") "$T/w-minimal.txt" && grep -q 'fuera del perfil minimal' "$T/w3b.out"; then
  ok "(w) T39 de full ($N_FULL hooks) a minimal: el .ps1 saca los de full, con el motivo en su salida"
else no "(w) T39 de full a minimal (rc $RC, full $N_FULL): $(ps1_ids "$HW3/.claude/settings.json" | wc -l | tr -d ' ') hooks · $(grep -c 'fuera del perfil minimal' "$T/w3b.out") motivo(s) · $(brief "$T/w3b.out" 200)"; fi
cp "$HW3/.claude/settings.json" "$T/w3-full-then-min.json"
printf '{ "install": { "profile": "full" } }\n' > "$HW3/.claude/tycon.json"; installer "$HW3" -- > "$T/w3c.out" 2>&1
ps1_ids "$HW3/.claude/settings.json" > "$T/w3-full.txt"
printf '{ "install": { "profile": "medio" } }\n' > "$HW3/.claude/tycon.json"; installer "$HW3" -- > "$T/w4.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && cmp -s <(ps1_ids "$HW3/.claude/settings.json") "$T/w3-full.txt" && grep -q 'perfil de instalacion queda como estaba' "$T/w4.out"; then ok "(w) T39 configuración rota: el .ps1 no saca ni agrega lo del perfil, y lo dice"
else no "(w) T39 configuración rota (rc $RC): $(diff "$T/w3-full.txt" <(ps1_ids "$HW3/.claude/settings.json") | grep '^[<>]' | head -4 | tr '\n' ' ') · $(brief "$T/w4.out" 200)"; fi

sync_profile_section() {
  local SLAB="$T/sync-lab-profile"
  mkdir -p "$SLAB/scripts/setup" "$SLAB/claude-md-blocks"
  cp -R "$ROOT/scripts/lib" "$SLAB/scripts/lib"
  cp "$ROOT/scripts/setup/sync-claude-md-blocks.sh" "$ROOT/scripts/setup/sync-claude-md-blocks.ps1" "$SLAB/scripts/setup/"
  printf '<!-- requires-profile: full -->\n# de full\ntexto de full\n' > "$SLAB/claude-md-blocks/de-full.md"
  printf '<!-- requires-integration: ado -->\n<!-- requires-profile: full -->\n# los dos\ntexto de los dos\n' > "$SLAB/claude-md-blocks/los-dos.md"
  printf '<!--requires-profile full-->\n# casi\ntexto de casi\n' > "$SLAB/claude-md-blocks/casi.md"
  printf '# común\ntexto común\n' > "$SLAB/claude-md-blocks/comun.md"
  local modo
  for modo in minimal full medio; do
    local S P; S="$(sync_home "prof-$modo-sh")"; P="$(sync_home "prof-$modo-ps1")"
    sync_sh "$S" TYCON_INSTALL_PROFILE=$modo TYCON_ADO_ORG=https://dev.azure.com/acme > "$T/sp-$modo.sh.out" 2>&1
    sync_ps1 "$P" TYCON_INSTALL_PROFILE=$modo TYCON_ADO_ORG=https://dev.azure.com/acme > "$T/sp-$modo.ps1.out" 2>&1
    same_as_sh "T39 requires-profile, perfil ${modo}" "$S" "$P" "$T/sp-$modo.sh.out" "$T/sp-$modo.ps1.out"
  done
  # de full a minimal sobre lo ya escrito: el .ps1 lo quita igual que el .sh
  S="$(sync_home prof-switch-sh)"; P="$(sync_home prof-switch-ps1)"
  sync_sh "$S" TYCON_INSTALL_PROFILE=full > /dev/null 2>&1; sync_ps1 "$P" TYCON_INSTALL_PROFILE=full > /dev/null 2>&1
  sync_sh "$S" TYCON_INSTALL_PROFILE=minimal > "$T/sp-sw.sh.out" 2>&1; sync_ps1 "$P" TYCON_INSTALL_PROFILE=minimal > "$T/sp-sw.ps1.out" 2>&1
  same_as_sh "T39 requires-profile, de full a minimal" "$S" "$P" "$T/sp-sw.sh.out" "$T/sp-sw.ps1.out"
  # el registro del instalador anota «en su lugar» un bloque con el marcador del perfil (lo que el sync deja en full).
  # Hasta la W4 se medía la función Record-BlocksInPlace recortada del .ps1; la W4 la sacó (cada corrida llega al sync,
  # que anota): ahora, por ejecución, el instalador entero con -ReportJson, dos veces (la segunda, sin nada que cambiar)
  S="$(sync_home prof-record)"; sync_sh "$S" TYCON_INSTALL_PROFILE=full "TYCON_REPORT_PIECES=$T/sp-rec.sh.pieces" > /dev/null 2>&1
  local WANT BCL P RC RC2; WANT="$(names "$T/sp-rec.sh.pieces")"
  BCL="$(blocks_clone profile "$SLAB/claude-md-blocks")"; P="$(sync_home prof-record-installer)"
  LAB_INSTALLER="$BCL/scripts/install-tycon-hooks.ps1" installer "$P" "${HELD[@]}" "${SYNC_ENV[@]}" TYCON_INSTALL_PROFILE=full -- -ReportJson "$T/sp-rec1.report.json" > "$T/sp-rec1.out" 2>&1; RC=$?
  LAB_INSTALLER="$BCL/scripts/install-tycon-hooks.ps1" installer "$P" "${HELD[@]}" "${SYNC_ENV[@]}" TYCON_INSTALL_PROFILE=full -- -ReportJson "$T/sp-rec2.report.json" > "$T/sp-rec.out" 2>&1; RC2=$?
  if printf '%s' "$WANT" | grep 'de-full' >/dev/null && [ "$RC" -eq 0 ] && [ "$RC2" -eq 0 ] && [ "$(report_blocks "$T/sp-rec1.report.json")" = "$WANT" ] && [ "$(report_blocks "$T/sp-rec2.report.json")" = "$WANT" ]; then
    ok "(w) T39 el registro del instalador .ps1 (dos corridas) anota «en su lugar» los bloques con requires-profile ($WANT)"
  else no "(w) T39 bloques con requires-profile en su lugar: el sync .sh «${WANT}», el instalador .ps1 «$(report_blocks "$T/sp-rec1.report.json")» y en la segunda corrida «$(report_blocks "$T/sp-rec2.report.json")» (rc $RC y $RC2) $(brief "$T/sp-rec.out" 160)"; fi
}

if command -v python3 >/dev/null 2>&1; then sync_section; sync_profile_section
else echo "⏭ installer-ps1: NO MEDIDO — el sync .ps1 contra el .sh: no hay python3 en esta máquina"; fi
# el plan del .ps1 con el perfil: un bloque de full escrito sale «remove» en minimal (Record-BlocksPlan, con su regla)
HWP="$(prof_home w-plan-min minimal)"
installer "$HWP" TYCON_NO_CLAUDEMD_SYNC=0 -- > /dev/null 2>&1
printf '{ "install": { "profile": "full" } }\n' > "$HWP/.claude/tycon.json"; installer "$HWP" TYCON_NO_CLAUDEMD_SYNC=0 -- > /dev/null 2>&1
printf '{ "install": { "profile": "minimal" } }\n' > "$HWP/.claude/tycon.json"
installer "$HWP" TYCON_NO_CLAUDEMD_SYNC=0 -- -Check -PlanJson "$T/plan-w.json" > "$T/wp.out" 2>&1; RC=$?
ACT="$(python3 -c "import json,sys; print(next((x['action'] for x in json.load(open(sys.argv[1])) if x['kind']=='block' and x['id']=='TYCON_BLOCK:response-style'), 'ninguna'))" "$T/plan-w.json" 2>/dev/null)"
[ "$RC" -eq 0 ] && [ "$ACT" = remove ] && ok "(w) T39 el plan del .ps1 en minimal trae «remove» para el bloque de estilo escrito" || no "(w) T39 plan del .ps1 en minimal (rc $RC): acción «${ACT}» · $(brief "$T/wp.out" 200)"

# ═══ (x) W4 · AC 33 y 36 — una sola carpeta de usuario y los defectos ya vistos (story 8.17 · T48, T49) ═══════════════
# La guarda de PowerShell 7 en los tres .ps1 (AC 35) la mide ps1-readable.test.js (T7 y T8): leída en cada uno y, en el
# respaldo del arranque, por ejecución. Lo que el .ps1 deja de hacer con settings.json (el «ya está» y las fechas o
# claves con mayúsculas) lo mide apply-hooks.test.js: el .ps1 ya no lee ni escribe settings.json.
w4_home_section() {
  local W="$T/w4" f fn first="" same=1 h u rc
  mkdir -p "$W"
  # (x1) AC 33 · los tres .ps1 que buscan la carpeta de usuario usan LA MISMA función, y nada más la busca por su cuenta
  # 🔴 rojo previo: el instalador usaba $env:USERPROFILE para settings.json y $HOME para el CLAUDE.md; el respaldo, $env:HOME
  local strays=""
  for f in scripts/install-tycon-hooks.ps1 scripts/setup/sync-claude-md-blocks.ps1 scripts/setup/harness/bootstrap-fallback.ps1; do
    fn="$(awk '/^function Get-TyconHome/{p=1} p{print} p&&/^}/{exit}' "$ROOT/$f")"
    if [ -z "$fn" ]; then same=0; strays="$strays ${f##*/}(sin la función)"; continue; fi
    if [ -z "$first" ]; then first="$fn"; elif [ "$fn" != "$first" ]; then same=0; strays="$strays ${f##*/}(otra versión de la función)"; fi
    # fuera de la función y de los comentarios, nadie lee la carpeta de usuario por su cuenta
    local own
    own="$(awk '/^function Get-TyconHome/{p=1} !p{print NR": "$0} p&&/^}/{p=0}' "$ROOT/$f" | grep -vE '^[0-9]+: *#' | grep -E '\$env:USERPROFILE|\$env:HOME|\$HOME\b|GetFolderPath\(' | head -2 | tr '\n' ' ')"
    [ -n "$own" ] && { same=0; strays="$strays ${f##*/}: $own"; }
  done
  [ "$same" = 1 ] && ok "(x) AC 33 · los tres .ps1 (instalador, bloques, respaldo del arranque) usan la misma Get-TyconHome y ninguno lee HOME o USERPROFILE por su cuenta" \
    || no "(x) AC 33 · la carpeta de usuario no sale de una sola función:$strays"
  # (x2) AC 33 · la función devuelve lo mismo que os.homedir() de Node: en Windows USERPROFILE (si no, la del perfil); en
  # Linux y Mac HOME. La rama de Windows se prueba pasándole la plataforma.
  cat > "$W/home-fn.ps1" <<'PS'
param([string]$Src)
$s = [IO.File]::ReadAllText($Src)
$m = [regex]::Match($s, '(?ms)^function Get-TyconHome.*?^\}')
if (-not $m.Success) { 'sin-funcion'; exit 3 }
Invoke-Expression $m.Value
"win=$(Get-TyconHome -Platform 'Win32NT')"
"unix=$(Get-TyconHome -Platform 'Unix')"
"here=$(Get-TyconHome)"
"profile=$([Environment]::GetFolderPath('UserProfile'))"
PS
  h="$(new_home w4-fn-home)"; u="$(new_home w4-fn-up)"
  lab_env "$h" "USERPROFILE=$u" -- pwsh -NoProfile -NonInteractive -File "$W/home-fn.ps1" -Src "$PS1_INSTALLER" > "$W/x2a.out" 2>&1
  local node_home; node_home="$(lab_env "$h" "USERPROFILE=$u" -- node -p 'require("os").homedir()')"
  lab_env "$h" -- env -u USERPROFILE pwsh -NoProfile -NonInteractive -File "$W/home-fn.ps1" -Src "$PS1_INSTALLER" > "$W/x2b.out" 2>&1
  local prof; prof="$(sed -n 's/^profile=//p' "$W/x2b.out")"
  if grep -qx "win=$u" "$W/x2a.out" && grep -qx "unix=$h" "$W/x2a.out" && grep -qx "here=$node_home" "$W/x2a.out" \
     && [ -n "$prof" ] && grep -qx "win=$prof" "$W/x2b.out"; then
    ok "(x) AC 33 · Get-TyconHome = os.homedir(): Windows → USERPROFILE (sin ella, la carpeta del perfil); Linux/Mac → HOME; en esta máquina, lo mismo que Node ($node_home)"
  else no "(x) AC 33 · Get-TyconHome no da lo de os.homedir() (Node: $node_home): $(tr '\n' ' ' < "$W/x2a.out") · sin USERPROFILE: $(tr '\n' ' ' < "$W/x2b.out")"; fi
  # (x3) AC 33 · con HOME distinta de USERPROFILE, la instalación entera queda en UNA carpeta: la de os.homedir()
  h="$(new_home w4-one-home)"; u="$(new_home w4-other-up)"
  installer "$h" "USERPROFILE=$u" TYCON_NO_CLAUDEMD_SYNC=0 -- > "$W/x3.out" 2>&1; rc=$?
  # una máquina nueva recibe el lugar del arnés (story 8.19, tanda C: ya no el nombre viejo); el nombre, de place.js
  local place; place="$(node -p "require(process.argv[1]).PLACE_NAME" "$ROOT/scripts/setup/harness/place.js")"
  if [ "$rc" -eq 0 ] && [ -f "$h/.claude/settings.json" ] && [ -f "$h/.claude/CLAUDE.md" ] && [ -L "$h/.claude/$place" ] && [ -z "$(find "$u" -mindepth 1 | head -1)" ]; then
    ok "(x) AC 33 · HOME distinta de USERPROFILE: settings.json, CLAUDE.md y los enlaces, todos en la carpeta de os.homedir(); la otra, vacía"
  else no "(x) AC 33 · HOME distinta de USERPROFILE (rc $rc): en HOME $(cd "$h" && find . -maxdepth 2 -mindepth 2 | LC_ALL=C sort | head -6 | tr '\n' ' ') · en USERPROFILE $(cd "$u" && find . -mindepth 1 -maxdepth 2 | head -4 | tr '\n' ' ') · $(brief "$W/x3.out" 200)"; fi
}
w4_defects_section() {
  local W="$T/w4" h rc
  mkdir -p "$W"
  # (x4) AC 36 · el refresco de fondo (la lista de proyectos de Azure DevOps) con una carpeta de usuario con espacio y
  # acento: la ruta del guion llega entera. 🔴 rojo previo: Start-Process con un arreglo junta los argumentos con
  # espacios sin comillas (la ruta se partía en dos); y -WindowStyle, fuera de Windows, cortaba el instalador.
  h="$(new_home 'w4 espacio acentó')"; mkdir -p "$h/.claude" "$W/bin-az"; ln -s "$CLONE" "$h/.claude/tycon-claude-guides"
  printf '#!/bin/sh\n# az de mentira: sólo la lista de proyectos\ncase "$*" in *"project list"*) echo %s ;; *) exit 1 ;; esac\n' "'[{\"name\":\"Lab\"}]'" > "$W/bin-az/az"; chmod +x "$W/bin-az/az"
  PS1_ENTRY="$h/.claude/tycon-claude-guides/scripts/install-tycon-hooks.ps1" installer "$h" "PATH=$W/bin-az:$T/bin:$PATH" TYCON_NO_AZ_PROJECTS_REFRESH=0 TYCON_ADO_ORG=https://dev.azure.com/acme -- > "$W/x4.out" 2>&1; rc=$?
  local cache="$h/.claude/.tycon-pipeline/az-projects.json" i=0
  while [ ! -s "$cache" ] && [ "$i" -lt 30 ]; do sleep 0.5; i=$((i+1)); done
  if [ "$rc" -eq 0 ] && grep -q '"Lab"' "$cache" 2>/dev/null; then ok "(x) AC 36 · una carpeta de usuario con espacio y acento: el refresco de fondo recibe la ruta entera y deja la lista de proyectos"
  else no "(x) AC 36 · refresco de fondo con espacio y acento (rc $rc): $([ -s "$cache" ] && echo 'la lista salió sin el proyecto' || echo 'no dejó la lista') · $(grep -F 'failed-query-notice' "$NODE_CALLS" | tail -1 | cut -c1-200) · $(brief "$W/x4.out" 200)"; fi
  # (x4b) la subida de corridas al buzón (2026-10-15): el arranque de Windows nunca la lanzaba, y las corridas de una
  # máquina Windows no llegaban al buzón ni al tablero. Ahora, como en Mac: de fondo (no frena el arranque), con la
  # ventana oculta y su registro agregado (`--log`). Con la carpeta de usuario con espacio y acento, la ruta llega
  # entera. Sin la llave del buzón la subida dice `sin_config` en su registro: ésa es la prueba de que se lanzó.
  # 🔴 rojo previo: el .ps1 no nombraba upload-runs.js, y no quedaba ningún registro.
  h="$(new_home 'w4 buzón espacio')"; mkdir -p "$h/.claude"; ln -s "$CLONE" "$h/.claude/tycon-claude-guides"
  printf '{ "integrations": { "mailbox": true } }\n' > "$h/.claude/tycon.json"
  PS1_ENTRY="$h/.claude/tycon-claude-guides/scripts/install-tycon-hooks.ps1" installer "$h" TYCON_MAILBOX_JSON="$W/no-esta.json" -- > "$W/x4b.out" 2>&1; rc=$?
  local up="$h/.claude/.tycon-pipeline/upload-runs.log"; i=0
  while ! grep -q 'sin_config' "$up" 2>/dev/null && [ "$i" -lt 40 ]; do sleep 0.5; i=$((i+1)); done
  if [ "$rc" -eq 0 ] && grep -q 'sin_config' "$up" 2>/dev/null && grep -qF "upload-runs.js --budget-ms 90000 --log $up" "$NODE_CALLS"; then
    ok "(x) la subida de corridas al buzón: el arranque de Windows la lanza de fondo, con la ruta entera, y deja su registro"
  else no "(x) la subida de corridas al buzón (rc $rc): $([ -f "$up" ] && echo "registro: $(head -c 160 "$up")" || echo 'no quedó registro') · $(grep -F 'upload-runs' "$NODE_CALLS" | tail -1 | cut -c1-200) · $(brief "$W/x4b.out" 200)"; fi
  # …y no se lanza con la llave de apagado, con -Check, dentro de un agente de CI ni con el buzón apagado
  local variante lanzadas=""
  for variante in apagada check ci sin-buzon; do
    h="$(new_home "w4-buzon-$variante")"; mkdir -p "$h/.claude"; ln -s "$CLONE" "$h/.claude/tycon-claude-guides"
    [ "$variante" = sin-buzon ] && printf '{ "integrations": { "mailbox": false } }\n' > "$h/.claude/tycon.json" || printf '{ "integrations": { "mailbox": true } }\n' > "$h/.claude/tycon.json"
    : > "$NODE_CALLS"
    case "$variante" in
      apagada) installer "$h" TYCON_MAILBOX_JSON="$W/no-esta.json" TYCON_NO_UPLOAD_RUNS=1 -- > /dev/null 2>&1 ;;
      check) installer "$h" TYCON_MAILBOX_JSON="$W/no-esta.json" -- -Check > /dev/null 2>&1 ;;
      ci) installer "$h" TYCON_MAILBOX_JSON="$W/no-esta.json" TF_BUILD=True -- > /dev/null 2>&1 ;;
      sin-buzon) installer "$h" TYCON_MAILBOX_JSON="$W/no-esta.json" -- > /dev/null 2>&1 ;;
    esac
    sleep 1
    if grep -qF 'upload-runs.js' "$NODE_CALLS" || [ -e "$h/.claude/.tycon-pipeline/upload-runs.log" ]; then lanzadas="$lanzadas $variante"; fi
  done
  [ -z "$lanzadas" ] && ok "(x) la subida de corridas al buzón NO se lanza con TYCON_NO_UPLOAD_RUNS=1, con -Check, dentro de un agente de CI ni con el buzón apagado" \
    || no "(x) la subida de corridas se lanzó donde no debía:$lanzadas"
  # (x5) AC 36 · un error de requisitos sale como UNA línea limpia, no como un error de PowerShell (con su «Line |» y sus
  # colores). 🔴 rojo previo: Write-Error con $ErrorActionPreference='Stop' imprimía siete renglones de PowerShell.
  local bare="$W/clone-bare"; mkdir -p "$bare"; cp -R "$CLONE/scripts" "$bare/scripts"; cp -R "$CLONE/claude-md-blocks" "$bare/claude-md-blocks"
  h="$(new_home w4-no-skills)"
  PS1_ENTRY="$bare/scripts/install-tycon-hooks.ps1" installer "$h" > "$W/x5.out" 2>&1; rc=$?
  local esc; esc="$(printf '\033')"
  if [ "$rc" -eq 1 ] && [ "$(grep -c 'agent-skills no encontrado' "$W/x5.out")" = 1 ] && grep -q "^✗ tycon: agent-skills no encontrado — .*$h/.claude/agent-skills/skills.* — ver el README.md del arnés, 'Instalación'\$" "$W/x5.out" \
     && ! grep -qE 'Write-Error|Line \||~~~~|CategoryInfo' "$W/x5.out" && ! grep -qF "$esc" "$W/x5.out"; then
    ok "(x) AC 36 · sin agent-skills: sale 1 con UNA línea limpia («✗ tycon: agent-skills no encontrado — … — ver …»), sin el formato de error de PowerShell"
  else no "(x) AC 36 · sin agent-skills (rc $rc): $(grep -c '' "$W/x5.out") renglón(es) · $(brief "$W/x5.out" 240)"; fi
  local nocp="$W/clone-nocp"; mkdir -p "$nocp"; cp -R "$CLONE/scripts" "$nocp/scripts"; rm -f "$nocp/scripts/lib/canonical-path.js"
  h="$(new_home w4-link-nocp)"
  PS1_ENTRY="$nocp/scripts/install-tycon-hooks.ps1" installer "$h" -- -Link "$CLONE" > "$W/x5b.out" 2>&1; rc=$?
  if [ "$rc" -eq 2 ] && [ "$(grep -c '' "$W/x5b.out")" = 1 ] && grep -qx 'install-tycon-hooks.ps1: -Link necesita node y scripts/lib/canonical-path.js' "$W/x5b.out"; then
    ok "(x) AC 36 · -Link sin la biblioteca de enlaces: sale 2 con una línea limpia"
  else no "(x) AC 36 · -Link sin la biblioteca de enlaces (rc $rc): $(grep -c '' "$W/x5b.out") renglón(es) · $(brief "$W/x5b.out" 240)"; fi
  # (x6) AC 36 · un bloque con \r\n (lo que deja un clon de Windows con autocrlf) deja el MISMO CLAUDE.md que el .sh, byte
  # a byte; también sobre un CLAUDE.md que ya traía \r\n. Y la segunda corrida no toca nada.
  # 🔴 rojo previo: el .sh lee con saltos universales (python: \r\n → \n) y el .ps1 copiaba los \r al CLAUDE.md.
  if ! command -v python3 >/dev/null 2>&1; then echo "⏭ installer-ps1: NO MEDIDO — (x) AC 36 bloque con \\r\\n: no hay python3 (el .sh es la referencia)"; return; fi
  local SL="$W/sync-lab"; mkdir -p "$SL/scripts/setup" "$SL/claude-md-blocks"
  cp -R "$ROOT/scripts/lib" "$SL/scripts/lib"; cp "$ROOT/scripts/setup/sync-claude-md-blocks.sh" "$ROOT/scripts/setup/sync-claude-md-blocks.ps1" "$SL/scripts/setup/"
  printf '# regla de Windows\r\nlínea uno\r\n\r\nlínea dos\r\n' > "$SL/claude-md-blocks/crlf.md"
  printf '# regla común\nlínea\n' > "$SL/claude-md-blocks/lf.md"
  local mode s p
  for mode in fresh seeded; do
    s="$(new_home "w4-crlf-$mode-sh")"; p="$(new_home "w4-crlf-$mode-ps1")"; mkdir -p "$s/.claude" "$p/.claude"
    if [ "$mode" = seeded ]; then
      for h in "$s" "$p"; do printf '# notas del dev\r\n\r\nuna regla a mano\r\n\r\n<!-- TYCON_BLOCK:crlf START -->\r\nVIEJO\r\n<!-- TYCON_BLOCK:crlf END -->\r\n' > "$h/.claude/CLAUDE.md"; done
    fi
    lab_env "$s" TYCON_NO_CLAUDEMD_SYNC=0 -- bash "$SL/scripts/setup/sync-claude-md-blocks.sh" > "$W/x6-$mode.sh.out" 2>&1
    lab_env "$p" TYCON_NO_CLAUDEMD_SYNC=0 -- pwsh -NoProfile -NonInteractive -File "$SL/scripts/setup/sync-claude-md-blocks.ps1" > "$W/x6-$mode.ps1.out" 2>&1
    if [ -f "$s/.claude/CLAUDE.md" ] && cmp -s "$s/.claude/CLAUDE.md" "$p/.claude/CLAUDE.md"; then ok "(x) AC 36 · bloque con \\r\\n ($mode): el CLAUDE.md del .ps1 es byte a byte el del .sh"
    else no "(x) AC 36 · bloque con \\r\\n ($mode): el CLAUDE.md del .ps1 no es el del .sh: $(cmp "$s/.claude/CLAUDE.md" "$p/.claude/CLAUDE.md" 2>&1 | head -1) · \\r en el del .ps1: $(LC_ALL=C grep -c $'\r' "$p/.claude/CLAUDE.md" 2>/dev/null)"; fi
    cp "$p/.claude/CLAUDE.md" "$W/x6-$mode.before"
    lab_env "$p" TYCON_NO_CLAUDEMD_SYNC=0 -- pwsh -NoProfile -NonInteractive -File "$SL/scripts/setup/sync-claude-md-blocks.ps1" > "$W/x6-$mode.again.out" 2>&1
    if cmp -s "$W/x6-$mode.before" "$p/.claude/CLAUDE.md" && [ ! -s "$W/x6-$mode.again.out" ]; then ok "(x) AC 36 · bloque con \\r\\n ($mode): la segunda corrida del .ps1 no toca nada y calla"
    else no "(x) AC 36 · bloque con \\r\\n ($mode): la segunda corrida cambió el CLAUDE.md o habló: $(brief "$W/x6-$mode.again.out" 200)"; fi
  done
}
w4_home_section
w4_defects_section

# ═══ el guion de entrada de Windows: get-harness.ps1 (story 8.16, tanda E · T59) ═══════════════════════════════
# Escrito por lectura, sin máquina Windows: acá se mide con el pwsh de esta máquina que PARSEA (y con el BOM que
# Windows PowerShell 5.1 necesita para leer los acentos), que no usa sintaxis que 5.1 no lea, y —desde la story 8.23,
# tanda E, SIN git— que con un PATH de mentira sin tar sale 1 nombrándolo sin bajar nada, que un node viejo se nombra
# con su versión y el piso de harness.js, que con el repo público baja el comprimido por el «GitHub» de juguete (la
# redirección a codeload sin credencial) y le pasa la posta a harness.js install --version latest --repo con las opciones
# tal cual, que con el repo privado y sin permiso sale 1 con la única acción, que TYCON_GITHUB_TOKEN se guarda e instala
# sin que el valor salga en pantalla, y que un permiso que no vale sale 1. Correrlo en Windows de punta a punta queda
# para el 182 (hoy corre el bloque del clon).
get_harness_ps1_section() {
  local src="$ROOT/scripts/publishing/public-files/scripts/setup/get-harness.ps1" gl="$T/get-harness" gh h rc floor
  # en el repo interno es un papel con marcadores (public-files/…); en la copia pública ya está en scripts/setup/ con el
  # nombre real del repo puesto por el exportador (el mismo que trae su línea $Repo). Desde la story 8.23 (tanda E) el
  # guion NO clona: baja la versión por la API de GitHub (acá, el «GitHub» de juguete) y corre install --version latest.
  local copy=0 pub=""
  if [ ! -f "$src" ] && [ -f "$ROOT/scripts/setup/get-harness.ps1" ]; then copy=1; src="$ROOT/scripts/setup/get-harness.ps1"; fi
  [ -f "$src" ] || { no "get-harness.ps1 · no existe ${src#"$ROOT"/}"; return; }
  mkdir -p "$gl/bin-notar" "$gl/bin-oldnode" "$gl/bin-full" "$gl/remotes"
  gh="$gl/get-harness.ps1"
  if [ "$copy" = 0 ]; then
    # los marcadores, como los pone el exportador (con un nombre inventado); el BOM queda
    sed -e 's/{{public-org}}/example-org/g' -e 's/{{public-repo}}/example-harness/g' "$src" > "$gh"
  else
    pub="$(node -e 'const r=require(process.argv[1]).remotes[0];console.log(r.replace(/^https:\/\/github\.com\//,""))' "$ROOT/scripts/setup/public-remotes.json" 2>/dev/null)"
    [ -n "$pub" ] || { no "get-harness.ps1 · (copia) no hay scripts/setup/public-remotes.json con el remoto público"; return; }
    if grep -q '{{public-' "$src"; then no "get-harness.ps1 · (copia) quedan marcadores sin reemplazar: $(grep -n '{{public-' "$src" | head -2 | tr '\n' ' ')"
    elif grep -qxF "\$Repo = '${pub}'" "$src"; then ok "get-harness.ps1 · (copia) los marcadores vienen puestos: \$Repo es ${pub}"
    else no "get-harness.ps1 · (copia) la dirección de fábrica no es la del remoto público (${pub}): $(grep -n '^\$Repo = ' "$src" | head -1)"; fi
    # el nombre real se cambia por el inventado (el BOM queda)
    sed -e "s#^\\\$Repo = '${pub//./\\.}'#\$Repo = 'example-org/example-harness'#" "$src" > "$gh"
    grep -qxF "\$Repo = 'example-org/example-harness'" "$gh" || { no "get-harness.ps1 · (copia) no pude ponerle el nombre inventado (¿cambió la forma de su línea \$Repo?)"; return; }
  fi
  # (la ruta `/git/ref/heads/<rama>` de la API de GitHub no es una invocación de git: se descuenta antes de mirar)
  # (la primera línea trae el BOM UTF-8 antes del `#`: se saca antes de descontar los comentarios)
  # (y los nombres de las rutas públicas de la story 8.34 —`<repo>.git/info/refs`, `git-upload-pack`— tampoco)
  ps1_code() { LC_ALL=C sed '1s/^\xef\xbb\xbf//' "$src" | grep -vE '^\s*#' | sed -e 's#/git/##g' -e 's#\.git/info/refs##g' -e 's#git-upload-pack##g'; }
  if ! ps1_code | grep -wE 'git|--depth' >/dev/null; then ok "get-harness.ps1 · no invoca git ni lo pide (sin clon: la versión se baja como archivos)"
  else no "get-harness.ps1 · todavía nombra git fuera de los comentarios: $(ps1_code | grep -nwE 'git|--depth' | head -2 | tr '\n' ' ')"; fi
  if [ "$(head -c 3 "$src" | od -An -tx1 | tr -d ' \n')" = efbbbf ]; then ok "get-harness.ps1 · empieza con el BOM UTF-8 (Windows PowerShell 5.1 lee mal un .ps1 sin él)"
  else no "get-harness.ps1 · no empieza con el BOM UTF-8"; fi
  cat > "$gl/parse.ps1" <<'PS'
param([string]$File)
$errs = $null; $tokens = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$tokens, [ref]$errs)
if ($errs.Count) { $errs | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }
"ok"
PS
  if pwsh -NoProfile -NonInteractive -File "$gl/parse.ps1" -File "$src" > "$gl/parse.out" 2>&1; then ok "get-harness.ps1 · parsea sin errores"
  else no "get-harness.ps1 · errores de parseo: $(brief "$gl/parse.out")"; fi
  # nada exclusivo de PowerShell 7 fuera de los comentarios (?? ?. && ||; el ternario no se busca: su forma choca con texto común): así 5.1 lo lee y dice qué falta
  if grep -v '^[[:space:]]*#' "$src" | grep -nE '\?\?|\?\.|&&|\|\||-Parallel' > "$gl/ps7.out"; then no "get-harness.ps1 · sintaxis de PowerShell 7 que 5.1 no lee: $(head -3 "$gl/ps7.out" | tr '\n' ' ')"
  else ok "get-harness.ps1 · sin ?? ?. && || ni -Parallel: Windows PowerShell 5.1 lo lee hasta el chequeo de versión"; fi
  floor="$(sed -n 's/^const NODE_FLOOR = \([0-9][0-9]*\);.*/\1/p' "$ROOT/scripts/setup/harness.js")"
  if grep -qE "^\\\$NodeFloor = ${floor}( |\$)" "$src"; then ok "get-harness.ps1 · el piso de Node es el de harness.js (${floor})"
  else no "get-harness.ps1 · el piso de Node no es el de harness.js (${floor}): $(grep -n 'NodeFloor =' "$src" | head -1)"; fi

  # el remoto: un arnés de juguete cuyo harness.js anota sus argumentos, publicado en `main` de un bare que sirve el
  # «GitHub» de juguete (scripts/tests/fixtures/toy-release-server.js: la ref, el comprimido por codeload, el permiso)
  local seed="$gl/seed" calls="$gl/calls.log" n_calls api srv
  mkdir -p "$seed/scripts/setup"
  printf '%s\n' "require('fs').appendFileSync(process.env.GET_HARNESS_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');" > "$seed/scripts/setup/harness.js"
  labgit() { env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Lab GIT_AUTHOR_EMAIL=lab@example.com \
    GIT_COMMITTER_NAME=Lab GIT_COMMITTER_EMAIL=lab@example.com git -c core.hooksPath=/dev/null "$@"; }
  labgit -C "$seed" init -q -b main && labgit -C "$seed" add -A && labgit -C "$seed" commit -q -m "versión 1" \
    && labgit -C "$gl/remotes" clone -q --bare "$seed" "$gl/remotes/stub.git" \
    || { no "get-harness.ps1 · no pude armar el remoto de juguete"; return; }
  printf '{ "auth": "none" }\n' > "$gl/control.json"; : > "$gl/requests.log"; rm -f "$gl/ports.env"
  node "$ROOT/scripts/tests/fixtures/toy-release-server.js" --repo "$gl/remotes/stub.git" --org example-org --name example-harness \
    --git "$(command -v git)" --control "$gl/control.json" --log "$gl/requests.log" --port-file "$gl/ports.env" > "$gl/server.out" 2>&1 &
  srv=$!
  for _i in $(seq 1 100); do [ -f "$gl/ports.env" ] && break; sleep 0.1; done
  api="$(sed -n 's/^API=//p' "$gl/ports.env" 2>/dev/null)"
  [ -n "$api" ] || { no "get-harness.ps1 · el GitHub de juguete no arrancó: $(brief "$gl/server.out")"; kill "$srv" 2>/dev/null; return; }
  local t real
  for t in pwsh bash; do real="$(command -v "$t")" && ln -sf "$real" "$gl/bin-notar/$t" && ln -sf "$real" "$gl/bin-oldnode/$t" && ln -sf "$real" "$gl/bin-full/$t"; done
  ln -sf "$REAL_NODE" "$gl/bin-notar/node"; ln -sf "$REAL_NODE" "$gl/bin-full/node"
  for t in tar python3; do real="$(command -v "$t")" && ln -sf "$real" "$gl/bin-oldnode/$t" && ln -sf "$real" "$gl/bin-full/$t"; done
  real="$(command -v gzip)" && ln -sf "$real" "$gl/bin-full/gzip"   # el tar de GNU (Linux) descomprime llamando a gzip por el PATH; el de Mac y Windows lo trae adentro
  real="$(command -v python3)" && ln -sf "$real" "$gl/bin-notar/python3"
  printf '#!/usr/bin/env bash\nif [ "${1:-}" = --version ]; then echo v18.0.0; exit 0; fi\nexec "%s" "$@"\n' "$REAL_NODE" > "$gl/bin-oldnode/node"; chmod +x "$gl/bin-oldnode/node"
  # ps_gh <home> <bin> [VAR=valor …] -- <args…> — el guion con un PATH de mentira (sólo esa carpeta), la HOME de laboratorio
  # y el GitHub de juguete como API (TYCON_RELEASE_API: la variable de prueba que entiende el guion, como release.js)
  ps_gh() { local hh="$1" bin="$2"; shift 2
    local extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ $# -gt 0 ] && shift
    ( cd "$hh" && env -i HOME="$hh" USERPROFILE="$hh" PATH="$bin" TMPDIR="$T/tmp" LANG="${LANG:-en_US.UTF-8}" \
        XDG_CACHE_HOME="$T/xdg/cache" XDG_DATA_HOME="$T/xdg/data" XDG_CONFIG_HOME="$T/xdg/config" \
        GET_HARNESS_CALLS="$calls" TYCON_RELEASE_API="$api" ${extra[@]+"${extra[@]}"} \
        POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off "$bin/pwsh" -NoProfile -NonInteractive -File "$gh" "$@" ) < /dev/null; }
  tmp_left() { ls -d "$T/tmp"/get-harness.* 2>/dev/null | wc -l | tr -d ' '; }

  local permit="permiso-de-laboratorio-ps1"   # no es un secreto (el detector toma por uno a un literal al lado de TOKEN)
  local INSTALL_CALL='["install","--version","latest","--repo","example-org/example-harness"'
  h="$(new_home gh-help)"
  ps_gh "$h" "$gl/bin-full" -- --help > "$gl/help.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'uso: pwsh -File get-harness.ps1' "$gl/help.out" && grep -qF 'sin terminal (instalación desatendida): agregá `-- --profile minimal --yes`' "$gl/help.out" && [ -z "$(find "$h" -mindepth 1 | head -1)" ] && [ ! -s "$gl/requests.log" ]; then
    ok "get-harness.ps1 · --help: el uso y la línea de la instalación desatendida, sale 0 sin escribir nada ni tocar la red"
  else no "get-harness.ps1 · --help (rc $rc): $(brief "$gl/help.out")"; fi
  if grep -qF './get-harness.ps1 --profile minimal --yes' "$gl/help.out"; then ok "get-harness.ps1 · la ayuda dice la forma que anda desde una sesión (./get-harness.ps1 --profile minimal --yes)"
  else no "get-harness.ps1 · la ayuda no dice cómo se llama desde una sesión: $(brief "$gl/help.out")"; fi
  # C1 · desde una sesión de PowerShell el `--` no llega al guion: las opciones de install tienen que andar igual sin él
  h="$(new_home gh-session)"
  printf '& $args[0] -- --yes\n' > "$gl/session.ps1"
  ( cd "$h" && env -i HOME="$h" USERPROFILE="$h" PATH="$gl/bin-full" TMPDIR="$T/tmp" LANG="${LANG:-en_US.UTF-8}" \
      XDG_CACHE_HOME="$T/xdg/cache" XDG_DATA_HOME="$T/xdg/data" XDG_CONFIG_HOME="$T/xdg/config" \
      GET_HARNESS_CALLS="$calls" TYCON_RELEASE_API="$api" POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off \
      "$gl/bin-full/pwsh" -NoProfile -NonInteractive -File "$gl/session.ps1" "$gh" ) < /dev/null > "$gl/session.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(tail -1 "$calls" 2>/dev/null)" = "${INSTALL_CALL},\"--yes\"]" ]; then ok "get-harness.ps1 · llamado desde una sesión de PowerShell (que se come el --): --yes llega igual a install --version latest --repo"
  else no "get-harness.ps1 · desde una sesión de PowerShell (rc $rc; llamada: $(tail -1 "$calls" 2>/dev/null)): $(brief "$gl/session.out")"; fi
  # sin tar: una línea que lo nombra, nada bajado, nada escrito
  h="$(new_home gh-notar)"; n_calls="$(wc -l < "$calls" 2>/dev/null | tr -d ' ')"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-notar" -- -- --yes > "$gl/notar.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && [ "$(grep -c 'falta tar' "$gl/notar.out")" = 1 ] && ! grep -q 'falta node\|falta git' "$gl/notar.out" && [ -z "$(find "$h" -mindepth 1 | head -1)" ] && [ "$(wc -l < "$calls" 2>/dev/null | tr -d ' ')" = "$n_calls" ] && [ ! -s "$gl/requests.log" ]; then
    ok "get-harness.ps1 · con un PATH sin tar: sale 1 con UNA línea que lo nombra (y su sugerencia), sin bajar nada ni escribir en la HOME; git no está entre los requisitos"
  else no "get-harness.ps1 · sin tar (rc $rc): $(brief "$gl/notar.out")"; fi
  h="$(new_home gh-oldnode)"
  ps_gh "$h" "$gl/bin-oldnode" -- > "$gl/oldnode.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -q "18\.0\.0.*${floor}" "$gl/oldnode.out" && [ -z "$(find "$h" -mindepth 1 | head -1)" ]; then
    ok "get-harness.ps1 · con node 18: sale 1 nombrando la versión que hay y la que pide (${floor}), sin bajar nada"
  else no "get-harness.ps1 · con node 18 (rc $rc): $(brief "$gl/oldnode.out")"; fi
  # repo público, con todo en su lugar: baja por la API (la redirección a codeload sin credencial), corre install y borra la temporal
  h="$(new_home gh-full)"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-full" -- -- --profile minimal --yes > "$gl/full.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(tail -1 "$calls" 2>/dev/null)" = "${INSTALL_CALL},\"--profile\",\"minimal\",\"--yes\"]" ] && grep -q '"host":"codeload"' "$gl/requests.log" \
     && ! grep -q '"host":"codeload".*"auth":true' "$gl/requests.log" && [ "$(tmp_left)" = 0 ]; then
    ok "get-harness.ps1 · repo público, con todo en su lugar: baja el comprimido por la API (codeload sin credencial), corre harness.js install --version latest --repo con las opciones tal cual y borra la temporal"
  else no "get-harness.ps1 · con todo en su lugar (rc $rc; llamada: $(tail -1 "$calls" 2>/dev/null); codeload $(grep -c codeload "$gl/requests.log"); temporales $(tmp_left)): $(brief "$gl/full.out")"; fi
  # repo PRIVADO, sin permiso y sin terminal: sale 1 con la única acción, nada bajado, nada escrito
  printf '{ "auth": "token:%s" }\n' "$permit" > "$gl/control.json"
  h="$(new_home gh-private)"; n_calls="$(wc -l < "$calls" | tr -d ' ')"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-full" -- -- --yes > "$gl/private.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -q 'TYCON_GITHUB_TOKEN' "$gl/private.out" && grep -q 'github.com/settings/' "$gl/private.out" && [ "$(wc -l < "$calls" | tr -d ' ')" = "$n_calls" ] \
     && ! grep -q '/tarball/' "$gl/requests.log" && [ -z "$(find "$h" -mindepth 1 | head -1)" ]; then
    ok "get-harness.ps1 · repo privado, sin permiso y sin terminal: sale 1 con la única acción (el enlace para crearlo, TYCON_GITHUB_TOKEN), no baja nada y no escribe"
  else no "get-harness.ps1 · privado sin permiso (rc $rc): $(brief "$gl/private.out")"; fi
  # con TYCON_GITHUB_TOKEN: guarda el permiso (config set github.token, por stdin) e instala; el valor no queda en la salida ni viaja a codeload
  h="$(new_home gh-token)"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-full" TYCON_GITHUB_TOKEN="$permit" -- -- --yes > "$gl/token.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && grep -q '"config","set","github.token"' "$calls" && [ "$(tail -1 "$calls")" = "${INSTALL_CALL},\"--yes\"]" ] \
     && ! grep -q '"host":"codeload".*"auth":true' "$gl/requests.log" && ! grep -qF "$permit" "$gl/token.out"; then
    ok "get-harness.ps1 · con TYCON_GITHUB_TOKEN: guarda el permiso (config set github.token) e instala; el valor no sale en pantalla ni viaja a codeload"
  else no "get-harness.ps1 · con TYCON_GITHUB_TOKEN (rc $rc; llamadas: $(tail -2 "$calls" | tr '\n' ' ')): $(brief "$gl/token.out")"; fi
  # un permiso que no vale: 401, sale 1 diciéndolo, nada bajado
  h="$(new_home gh-badtoken)"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-full" TYCON_GITHUB_TOKEN="otro-$permit" -- -- --yes > "$gl/bad.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -qiE 'no vale|venci|401' "$gl/bad.out" && ! grep -q '/tarball/' "$gl/requests.log" && [ "$(tmp_left)" = 0 ]; then ok "get-harness.ps1 · un permiso que no vale: sale 1 diciéndolo (venció o se revocó) y no baja nada"
  else no "get-harness.ps1 · permiso que no vale (rc $rc): $(brief "$gl/bad.out")"; fi
  # un permiso que VENCIÓ con el repo público (2026-10-14): GitHub contesta 401 aunque el repo se lea sin permiso. El guion
  # sigue sin él (main de info/refs, el comprimido de codeload) y no lo guarda; el de la variable lo dice el guion, el guardado
  # en ~/.tycon/config.json lo dice install (acá un harness.js de juguete: se mide que se instala sin mandarlo y sin guardarlo)
  local gitb cl; gitb="$(sed -n 's/^GIT=//p' "$gl/ports.env")"; cl="$(sed -n 's/^CODELOAD=//p' "$gl/ports.env")"
  printf '{ "auth": "none", "reject_unknown_token": true }\n' > "$gl/control.json"
  h="$(new_home gh-expired-env)"; : > "$gl/requests.log"; n_calls="$(wc -l < "$calls" | tr -d ' ')"
  ps_gh "$h" "$gl/bin-full" TYCON_RELEASE_GIT="$gitb" TYCON_RELEASE_ARCHIVE="$cl" TYCON_GITHUB_TOKEN="vencido-$permit" -- -- --yes > "$gl/expired-env.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(tail -1 "$calls")" = "${INSTALL_CALL},\"--yes\"]" ] && ! tail -n +"$((n_calls+1))" "$calls" | grep '"config","set"' >/dev/null \
     && grep -q 'TYCON_GITHUB_TOKEN venció o se revocó (401), pero no hace falta' "$gl/expired-env.out" && grep -q '"host":"codeload"' "$gl/requests.log" \
     && ! grep -q '/tarball/' "$gl/requests.log" && ! grep -qF "vencido-$permit" "$gl/expired-env.out"; then
    ok "get-harness.ps1 · TYCON_GITHUB_TOKEN vencido con el repo público: instala sin él (info/refs y codeload), lo dice y no lo guarda"
  else no "get-harness.ps1 · TYCON_GITHUB_TOKEN vencido (rc $rc; llamadas: $(tail -2 "$calls" | tr '\n' ' ')): $(brief "$gl/expired-env.out")"; fi
  h="$(new_home gh-expired-saved)"; : > "$gl/requests.log"; n_calls="$(wc -l < "$calls" | tr -d ' ')"
  mkdir -p "$h/.tycon" && printf '{ "github": { "token": "vencido-%s" } }\n' "$permit" > "$h/.tycon/config.json"
  ps_gh "$h" "$gl/bin-full" TYCON_RELEASE_GIT="$gitb" TYCON_RELEASE_ARCHIVE="$cl" -- -- --yes > "$gl/expired-saved.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(tail -1 "$calls")" = "${INSTALL_CALL},\"--yes\"]" ] && ! tail -n +"$((n_calls+1))" "$calls" | grep '"config","set"' >/dev/null \
     && grep -q '"host":"codeload"' "$gl/requests.log" && ! grep -q '/tarball/' "$gl/requests.log" && ! grep -q 'no vale (401)' "$gl/expired-saved.out"; then
    ok "get-harness.ps1 · el permiso guardado vencido con el repo público: instala sin él (info/refs y codeload), sin frenar"
  else no "get-harness.ps1 · permiso guardado vencido (rc $rc): $(brief "$gl/expired-saved.out")"; fi
  printf '{ "auth": "token:%s" }\n' "$permit" > "$gl/control.json"
  # una redirección a un esquema que no es http(s) (un servidor hostil que manda a file://) no se sigue: sale 1 diciéndolo y
  # sin llamar a install; una TYCON_RELEASE_API que no es http(s) sale 2 antes de tocar la red (vuelta 2 de la E, seguridad)
  local redir_pid; node -e 'const s=require("http").createServer((q,r)=>{r.writeHead(302,{Location:"file:///etc/passwd"});r.end()});s.listen(0,"127.0.0.1",()=>require("fs").writeFileSync(process.argv[1],String(s.address().port)))' "$gl/redir.port" & redir_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -s "$gl/redir.port" ] && break; sleep 0.2; done
  h="$(new_home gh-redir)"; n_calls="$(wc -l < "$calls" | tr -d ' ')"
  ps_gh "$h" "$gl/bin-full" TYCON_RELEASE_API="http://127.0.0.1:$(cat "$gl/redir.port")" -- -- --yes > "$gl/redir.out" 2>&1; rc=$?
  kill "$redir_pid" 2>/dev/null; wait "$redir_pid" 2>/dev/null
  if [ "$rc" -eq 1 ] && grep -q 'esquema que no es http' "$gl/redir.out" && ! grep -q 'GitHub contestó' "$gl/redir.out" && [ "$(wc -l < "$calls" | tr -d ' ')" = "$n_calls" ] && [ "$(tmp_left)" = 0 ]; then ok "get-harness.ps1 · una redirección a file:// no se sigue: sale 1 diciéndolo (una sola vez: sin el genérico «GitHub contestó»), sin bajar ni llamar a install"
  else no "get-harness.ps1 · redirección a file:// (rc $rc): $(brief "$gl/redir.out")"; fi
  # la misma redirección hostil pero en la BAJADA del comprimido (main ya resuelta): el motivo una sola vez, sin el genérico
  # «no pude bajar el comprimido (GitHub contestó …)» (vuelta 5 de la E)
  node -e 'const s=require("http").createServer((q,r)=>{if(/\/git\/ref\//.test(q.url)){r.writeHead(200,{"Content-Type":"application/json"});r.end(JSON.stringify({object:{sha:"0123456789abcdef0123456789abcdef01234567"}}));return}r.writeHead(302,{Location:"file:///etc/passwd"});r.end()});s.listen(0,"127.0.0.1",()=>require("fs").writeFileSync(process.argv[1],String(s.address().port)))' "$gl/redir2.port" & redir_pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -s "$gl/redir2.port" ] && break; sleep 0.2; done
  h="$(new_home gh-redir2)"; n_calls="$(wc -l < "$calls" | tr -d ' ')"
  ps_gh "$h" "$gl/bin-full" TYCON_RELEASE_API="http://127.0.0.1:$(cat "$gl/redir2.port")" -- -- --yes > "$gl/redir2.out" 2>&1; rc=$?
  kill "$redir_pid" 2>/dev/null; wait "$redir_pid" 2>/dev/null
  if [ "$rc" -eq 1 ] && grep -q 'a una carpeta temporal' "$gl/redir2.out" && grep -q 'esquema que no es http' "$gl/redir2.out" && ! grep -q 'GitHub contestó' "$gl/redir2.out" && [ "$(wc -l < "$calls" | tr -d ' ')" = "$n_calls" ] && [ "$(tmp_left)" = 0 ]; then ok "get-harness.ps1 · una redirección a file:// en la bajada del comprimido (main ya resuelta): sale 1 con el motivo una sola vez, sin el genérico, sin llamar a install"
  else no "get-harness.ps1 · redirección a file:// en la bajada (rc $rc): $(brief "$gl/redir2.out")"; fi
  h="$(new_home gh-badapi)"
  ps_gh "$h" "$gl/bin-full" TYCON_RELEASE_API="file:///tmp/no-es-una-api" -- -- --yes > "$gl/badapi.out" 2>&1; rc=$?
  if [ "$rc" -eq 2 ] && grep -q 'TYCON_RELEASE_API tiene que empezar con http' "$gl/badapi.out" && [ -z "$(find "$h" -mindepth 1 | head -1)" ]; then ok "get-harness.ps1 · una TYCON_RELEASE_API que no es http(s): sale 2 diciéndolo, antes de tocar la red o la HOME"
  else no "get-harness.ps1 · API con otro esquema (rc $rc): $(brief "$gl/badapi.out")"; fi
  # el PRIMER listado del tar (-tvzf, el que ve los enlaces) falla y el segundo (-tzf) anda: el guion tiene que frenar igual —cada
  # listado guarda su código; el segundo no tapa al primero (vuelta 3 de la E, cobertura)—. Un tar de mentira que sólo falla en -tvzf
  mkdir -p "$gl/bin-tarshim"; for f in "$gl"/bin-full/*; do ln -sf "$(readlink "$f")" "$gl/bin-tarshim/$(basename "$f")"; done
  real="$(command -v tar)"; rm -f "$gl/bin-tarshim/tar"   # era un enlace al tar real: escribir a través de él es escribir en /usr/bin
  # el tar de mentira imprime UNA línea antes de fallar: así lo que frena es el código (-tvzf salió 1), no un listado vacío
  printf '#!/bin/bash\ncase " $* " in *" -tvzf "*) echo "-rw-r--r-- 0 0 0 0 Jan 1 00:00 x/roto"; exit 1 ;; esac\nexec "%s" "$@"\n' "$real" > "$gl/bin-tarshim/tar"; chmod +x "$gl/bin-tarshim/tar"
  printf '{ "auth": "none" }\n' > "$gl/control.json"
  h="$(new_home gh-tarshim)"; n_calls="$(wc -l < "$calls" | tr -d ' ')"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-tarshim" -- -- --yes > "$gl/tarshim.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -q 'no se pudo leer' "$gl/tarshim.out" && grep -q '/tarball/' "$gl/requests.log" && [ "$(wc -l < "$calls" | tr -d ' ')" = "$n_calls" ] && [ "$(tmp_left)" = 0 ]; then
    ok "get-harness.ps1 · si falla el primer listado del tar (-tvzf) aunque el segundo ande: sale 1 diciéndolo, no abre el comprimido ni llama a install"
  else no "get-harness.ps1 · primer listado del tar roto (rc $rc; llamadas nuevas $(( $(wc -l < "$calls" | tr -d ' ') - n_calls ))): $(brief "$gl/tarshim.out")"; fi
  # con `-- --tool codex` (sólo Codex) bash y python3 no hacen falta fuera de Windows: el guion pasa los requisitos y baja
  # (pase adversarial de la E, clase 17). Un PATH con pwsh, node y tar, sin python3 ni bash
  printf '{ "auth": "none" }\n' > "$gl/control.json"
  mkdir -p "$gl/bin-codex"; for t in pwsh tar gzip; do real="$(command -v "$t")" && ln -sf "$real" "$gl/bin-codex/$t"; done; ln -sf "$REAL_NODE" "$gl/bin-codex/node"   # gzip: el tar de GNU lo llama (170 #12461)
  h="$(new_home gh-codex)"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-codex" -- -- --tool codex --yes > "$gl/codex.out" 2>&1; rc=$?
  if ! grep -q 'falta python3\|falta bash' "$gl/codex.out" && grep -q '/tarball/' "$gl/requests.log" && [ "$(tail -1 "$calls" 2>/dev/null)" = "${INSTALL_CALL},\"--tool\",\"codex\",\"--yes\"]" ]; then
    ok "get-harness.ps1 · con -- --tool codex y sin python3 ni bash: no son requisitos (los pide el aplicador de Claude Code), baja e instala"
  else no "get-harness.ps1 · con -- --tool codex sin python3 (rc $rc; llamada: $(tail -1 "$calls" 2>/dev/null)): $(brief "$gl/codex.out")"; fi
  # T14 (story 8.34) · sin permiso y con las rutas públicas del juguete (TYCON_RELEASE_GIT / _ARCHIVE): main de info/refs y el
  # comprimido de codeload, sin ninguna consulta a la API; con la API agotada (por la API: con permiso), la hora del tope
  local gitb cdl reset hora
  gitb="$(sed -n 's/^GIT=//p' "$gl/ports.env")"; cdl="$(sed -n 's/^CODELOAD=//p' "$gl/ports.env")"
  printf '{ "auth": "none" }\n' > "$gl/control.json"
  h="$(new_home gh-public)"; : > "$gl/requests.log"
  ps_gh "$h" "$gl/bin-full" TYCON_RELEASE_GIT="$gitb" TYCON_RELEASE_ARCHIVE="$cdl" -- -- --yes > "$gl/public.out" 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(tail -1 "$calls" 2>/dev/null)" = "${INSTALL_CALL},\"--yes\"]" ] && grep -q 'info/refs' "$gl/requests.log" && grep -q '/tar.gz/' "$gl/requests.log" && ! grep -q '"host":"api"' "$gl/requests.log"; then
    ok "get-harness.ps1 · T14 sin permiso: main de info/refs y el comprimido de codeload, sin ninguna consulta a la API; corre install"
  else no "get-harness.ps1 · T14 sin permiso por las rutas públicas (rc $rc; pedidos: $(sed 's/.*"path":"\([^"]*\)".*/\1/' "$gl/requests.log" | tr '\n' ' ')): $(brief "$gl/public.out")"; fi
  reset=$(( $(date +%s) + 2400 )); hora="$(node -e 'const d=new Date(Number(process.argv[1])*1000);console.log(`${d.getHours()}`.padStart(2,"0")+":"+`${d.getMinutes()}`.padStart(2,"0"))' "$reset")"
  printf '{ "auth": "none", "ratelimit": true, "ratelimit_reset": %s }\n' "$reset" > "$gl/control.json"
  h="$(new_home gh-limited)"; n_calls="$(wc -l < "$calls" | tr -d ' ')"
  ps_gh "$h" "$gl/bin-full" TYCON_GITHUB_TOKEN="$permit" -- -- --yes > "$gl/limited.out" 2>&1; rc=$?
  if [ "$rc" -eq 1 ] && grep -q "hasta las $hora" "$gl/limited.out" && ! grep -q 'GitHub contestó 403' "$gl/limited.out" && [ "$(wc -l < "$calls" | tr -d ' ')" = "$n_calls" ]; then
    ok "get-harness.ps1 · T14 la API en su tope: sale 1 con la hora ($hora), sin «GitHub contestó 403» y sin llamar a install"
  else no "get-harness.ps1 · T14 la API en su tope (rc $rc): $(brief "$gl/limited.out")"; fi
  printf '{ "auth": "none" }\n' > "$gl/control.json"
  kill "$srv" 2>/dev/null; wait "$srv" 2>/dev/null
}
if command -v git >/dev/null 2>&1; then get_harness_ps1_section
else echo "⏭ installer-ps1: NO MEDIDO — get-harness.ps1: no hay git en esta máquina"; fi

# ── (y) Ps1_FailureAfterLock_SaidAndLockReleased · story 8.17, W3W4 (revisores de fallos silenciosos, de spec primero y de
#    cobertura; pase adversarial, clase 15) ─────────────────────────────────────────────────────────────────────────────
# Con $ErrorActionPreference='Stop' global, un sitio sin envolver que tiraba DESPUÉS de tomar el candado mataba el
# instalador sin pasar por Exit-Installer: el candado quedaba tomado (hasta 10 min nadie más instalaba), no llegaba a
# Write-PieceReport y no se decía nada propio (sólo el error crudo de PowerShell). 🔴 rojo previo de cada caso, abajo.
no_ps_error() { ! grep -qE -e '^[[:space:]]*Line \|' -e '^install-tycon-hooks\.ps1: Exception' "$1"; }   # <salida>: sin el formato de error crudo de PowerShell
lock_free() { lab_env "$1" -- node -e 'const r=require(process.argv[1]).acquire(require("os").homedir());if(r.ok)require(process.argv[1]).release(require("os").homedir());process.exit(r.ok?0:1)' "$CLONE/scripts/setup/harness/lock.js" > /dev/null 2>&1; }   # <home>: otro instalador puede tomar el candado YA
# (1) Install-GitHook falla (TYCON_GIT_HOOKS_DIR es un ARCHIVO: New-Item -ItemType Directory tira). 🔴 antes: rc 1, el
# candado quedaba tomado y no había reporte.
HGF="$(new_home githook-fail)"; : > "$HGF/not-a-dir"
installer "$HGF" TYCON_NO_GIT_HOOKS=0 "TYCON_GIT_HOOKS_DIR=$HGF/not-a-dir" -- -ReportJson "$T/y1.report.json" > "$T/y1.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && [ "$(grep -c 'no pude dejar el pre-commit global de git' "$T/y1.out")" = 1 ] && [ "$(grep -c 'no pude dejar el post-commit global de git' "$T/y1.out")" = 1 ] \
   && [ "$(grep -c 'no pude dejar el pre-push global de git' "$T/y1.out")" = 1 ] \
   && no_ps_error "$T/y1.out" && [ ! -e "$HGF/.claude/.tycon-pipeline/harness/harness.lock" ] && lock_free "$HGF" && [ -s "$T/y1.report.json" ]; then
  ok "(y) un hook global de git que no se puede escribir: UNA línea por hook, sigue hasta el final (reporte escrito, sale 0) y suelta el candado (otro instalador entra enseguida)"
else no "(y) hook global de git que falla (rc $RC): $(grep -c 'no pude dejar el' "$T/y1.out") línea(s), candado $([ -e "$HGF/.claude/.tycon-pipeline/harness/harness.lock" ] && echo TOMADO || echo suelto), reporte $([ -s "$T/y1.report.json" ] && echo escrito || echo FALTA) · $(brief "$T/y1.out" 240)"; fi
# (1b) story 8.26, tanda F1 (AC 52): el pre-push global —el freno antes de publicar— también lo deja el instalador de
# Windows. El de la persona pasa a pre-push.local, y el nuestro queda byte a byte como el del arnés, con saltos de línea
# de Unix (lo corre el bash de Git: con CRLF la primera línea no es un intérprete).
HGP="$(new_home githook-pre-push)"; mkdir -p "$HGP/git-hooks"; printf '#!/bin/sh\necho ajeno\n' > "$HGP/git-hooks/pre-push"
installer "$HGP" TYCON_NO_GIT_HOOKS=0 "TYCON_GIT_HOOKS_DIR=$HGP/git-hooks" > "$T/y1b.out" 2>&1; RC=$?
PUSH_SRC="$(dirname "$PS1_INSTALLER")/hooks/git-pre-push-global.sh"
if [ "$RC" -eq 0 ] && [ -f "$PUSH_SRC" ] && cmp -s <(tr -d '\r' < "$PUSH_SRC") "$HGP/git-hooks/pre-push" && grep -q 'echo ajeno' "$HGP/git-hooks/pre-push.local" \
   && grep -q 'pre-push global de git actualizado' "$T/y1b.out" && no_ps_error "$T/y1b.out"; then
  ok "(y) el pre-push global en Windows: el del arnés queda puesto (igual al del árbol, con saltos de Unix) y el de la persona pasa a pre-push.local"
else no "(y) el pre-push global en Windows (rc $RC): $(ls "$HGP/git-hooks" 2>/dev/null | tr '\n' ' ') · $(grep -n 'pre-push' "$T/y1b.out" | head -3 | cut -c1-200 | tr '\n' ' ')"; fi
# y volver a instalar no lo toca (ni vuelve a mover nada)
installer "$HGP" TYCON_NO_GIT_HOOKS=0 "TYCON_GIT_HOOKS_DIR=$HGP/git-hooks" > "$T/y1c.out" 2>&1
if ! grep -q 'pre-push global de git actualizado' "$T/y1c.out" && grep -q 'echo ajeno' "$HGP/git-hooks/pre-push.local" && [ -z "$(ls "$HGP/git-hooks" | grep 'pre-push.bak' || true)" ]; then
  ok "(y) el pre-push global en Windows: instalar otra vez no cambia nada"
else no "(y) el pre-push global en Windows, segunda instalación: $(ls "$HGP/git-hooks" | tr '\n' ' ')"; fi
# (2) el esqueleto de settings.json no se puede escribir (~/.claude sin permiso de escritura; el candado vive más adentro
# y sí se toma). 🔴 antes: Set-Content tiraba y el candado quedaba tomado.
HSK="$(new_home skeleton-fail)"; mkdir -p "$HSK/.claude/.tycon-pipeline/harness"; chmod 555 "$HSK/.claude"
if [ -w "$HSK/.claude" ]; then echo "⏭ installer-ps1: NO MEDIDO — (y) esqueleto que no se puede escribir: corre como root"
else
  installer "$HSK" > "$T/y2.out" 2>&1; RC=$?
  if [ "$RC" -eq 1 ] && [ "$(grep -c 'no pude crear .*settings.json' "$T/y2.out")" = 1 ] && no_ps_error "$T/y2.out" && [ ! -e "$HSK/.claude/.tycon-pipeline/harness/harness.lock" ] && lock_free "$HSK"; then
    ok "(y) el esqueleto de settings.json que no se puede escribir: UNA línea, sale 1 por Exit-Installer y suelta el candado"
  else no "(y) esqueleto que falla (rc $RC): $(grep -c 'no pude crear' "$T/y2.out") línea(s), candado $([ -e "$HSK/.claude/.tycon-pipeline/harness/harness.lock" ] && echo TOMADO || echo suelto) · $(brief "$T/y2.out" 240)"; fi
fi
chmod 755 "$HSK/.claude"
# (3) sin scripts/setup/harness/lock.js el instalador sigue sin candado y LO DICE. 🔴 antes: seguía callado.
NOLOCK_CLONE="$T/clone-nolock"; cp -R "$CLONE" "$NOLOCK_CLONE"; rm -f "$NOLOCK_CLONE/scripts/setup/harness/lock.js"
HNL="$(new_home nolock)"
LAB_INSTALLER="$NOLOCK_CLONE/scripts/install-tycon-hooks.ps1" installer "$HNL" > "$T/y3.out" 2>&1; RC=$?
if [ "$(grep -c 'falta .*lock\.js.*sigo sin candado' "$T/y3.out")" = 1 ] && no_ps_error "$T/y3.out"; then ok "(y) sin lock.js: UNA línea «sigo sin candado» (rc $RC)"
else no "(y) sin lock.js (rc $RC): $(grep -c 'sigo sin candado' "$T/y3.out") línea(s) · $(brief "$T/y3.out" 200)"; fi
# (4) código muerto (W3W4): el aplicador ya no manda los avisos `no-git-bash*` (un .sh va con `bash "<ruta>"`, sin buscar
# el bash de Git), así que el .ps1 no los traduce
if ! grep -q 'no-git-bash' "$PS1_INSTALLER"; then ok "(y) sin los avisos no-git-bash* en el .ps1 (el aplicador ya no los manda)"
else no "(y) el .ps1 todavía traduce avisos no-git-bash*: $(grep -n 'no-git-bash' "$PS1_INSTALLER" | cut -c1-60 | head -3 | tr '\n' ' ')"; fi
# (5) código muerto (revisor de cobertura de AC): la tabla de integraciones y la lista de lo que se removía por llave las
# calculaba el .ps1 y ya no las usaba nadie (desde la W3 lo decide apply-hooks.js)
if ! grep -qE 'HooksDeIntegracion|RemoverPorLlave' "$PS1_INSTALLER"; then ok "(y) sin \$HooksDeIntegracion ni \$RemoverPorLlave (código muerto desde la W3)"
else no "(y) el .ps1 todavía calcula \$HooksDeIntegracion o \$RemoverPorLlave: $(grep -nE 'HooksDeIntegracion|RemoverPorLlave' "$PS1_INSTALLER" | head -2 | tr '\n' ' ')"; fi

# ═══ (z) una carpeta con acento y una consola que NO es UTF-8 (Windows lanzado sin consola: 182 measure #12408) ════════
# PowerShell decodifica lo que node imprime con [Console]::OutputEncoding; lanzado por harness.js o por un hook, en Windows
# es la página de códigos OEM de la máquina, y una ruta con acento vuelve con otros bytes: `Test-Path` no la encuentra y
# el .ps1 salía 1 diciendo que la carpeta de skills «no trae tycon-pipeline» (verde hasta la 8.23 A2, rojo en main desde la
# B). Acá se reproduce poniendo la consola en Latin1 ANTES de llamar al .ps1, con el clon y la HOME en «usuario de
# práctica»: el .ps1 tiene que fijar UTF-8 él mismo, encontrar la carpeta de skills y listar lo que falta, como en (a).
ACC="$T/usuario de práctica"; mkdir -p "$ACC/home"; cp -R "$CLONE" "$ACC/clone"
cat > "$T/latin1.ps1" <<'EOF'
param([string]$Installer)
[Console]::OutputEncoding = [System.Text.Encoding]::Latin1
$OutputEncoding = [System.Text.Encoding]::Latin1
& $Installer -Check
exit $LASTEXITCODE
EOF
: > "$NODE_CALLS"
lab_env "$ACC/home" -- pwsh -NoProfile -NonInteractive -File "$T/latin1.ps1" -Installer "$ACC/clone/scripts/install-tycon-hooks.ps1" > "$T/z.out" 2>&1; RC=$?
if [ "$RC" -eq 0 ] && ! grep -q 'no trae tycon-pipeline\|no encontrado' "$T/z.out"; then
  ok "(z) -Check desde un clon en «usuario de práctica», con la consola en Latin1, sale 0 y encuentra la carpeta de skills (el .ps1 fija UTF-8 él mismo)"
else no "(z) -Check desde «usuario de práctica» con la consola en Latin1 salió $RC: $(brief "$T/z.out")"; fi
R="$(check listing "$T/z.out")"; CK=$?
if [ "$CK" -eq 0 ]; then ok "(z) y lista lo que falta: los ${R% } que el clon trae, ni uno más (la salida llega legible)"
else no "(z) con la consola en Latin1 el listado de -Check no es el de siempre: ${R}·$(brief "$T/z.out" 200)"; fi
# el espejo: lo que lo arregla está escrito en el .ps1 (si alguien lo saca, (z) vuelve a rojo; esto dice por qué)
if grep -q 'OutputEncoding = \[System.Text.UTF8Encoding\]::new(\$false)' "$PS1_INSTALLER"; then ok "(z) el .ps1 fija [Console]::OutputEncoding en UTF-8 antes de llamar a node"
else no "(z) el .ps1 no fija [Console]::OutputEncoding en UTF-8: en Windows sin consola una ruta con acento se destroza"; fi

# ═══ (gh) T79 · el aviso de la carpeta GLOBAL de hooks de git (story 8.26, tanda H1c · AC 65 e) ══════════════════════
# El caso: los hooks de git del arnés —entre ellos el pre-push, el freno antes de publicar— corren sólo si la carpeta
# global de hooks de git es la que el instalador llena. El .ps1 avisaba únicamente cuando git no tenía ninguna: con OTRA
# llenaba la suya, no decía nada, y ningún hook del arnés corría. Es el gemelo de harness-install.test.sh, T79.
# Lo que se mide por EJECUCIÓN acá (pwsh en esta máquina, con la configuración global de git en un archivo propio):
# ninguna · la del instalador (entera, con `~`, por un enlace, desde un archivo incluido) · otra · no existe · relativa ·
# con los hooks de git apagados · y que el archivo de configuración queda byte a byte en todos.
# Lo que sólo pasa en Windows —una ruta con forma de Unix o de Git Bash, las mayúsculas, `\` por `/`— se mide llamando a
# la función que decide con la plataforma por parámetro (como Get-TyconHome en la sección x).
# Lo que NO mide: Windows de verdad (un junction, la unidad, el `~` de Git for Windows): esa corrida es aparte.
HGH="$(new_home global-hooks)"; GH_OURS="$HGH/git-hooks"; GH_LAB="$T/gh"; mkdir -p "$GH_LAB"; GH_CFG="$GH_LAB/gitconfig"
gh_set() { : > "$GH_CFG"; [ -z "${1:-}" ] || git config --file "$GH_CFG" core.hooksPath "$1"; cp "$GH_CFG" "$GH_CFG.before"; }   # <valor o vacío>
gh_run() { installer "$HGH" TYCON_NO_GIT_HOOKS=0 "TYCON_GIT_HOOKS_DIR=$GH_OURS" "GIT_CONFIG_GLOBAL=$GH_CFG" "$@" > "$T/gh.out" 2>&1; RC=$?; }   # [VAR=val …] [-- <args>]
# lo que el .ps1 dijo de la carpeta global: el renglón que la nombra y los sangrados que lo siguen
gh_said() { awk '/core\.hooksPath global/ { on = 1; print; next } on && /^    [^ ]/ { print; next } { on = 0 }' "$T/gh.out"; }
gh_same() { cmp -s "$GH_CFG" "$GH_CFG.before"; }
gh_brief() { gh_said | tr '\n' '|' | cut -c1-600; }
gh_quiet() { # <caso>: sale 0, no dice nada de la carpeta global y no toca la configuración
  if [ "$RC" -eq 0 ] && [ -z "$(gh_said)" ] && gh_same && no_ps_error "$T/gh.out"; then ok "(gh) $1: calla, y no toca la configuración de git"
  else no "(gh) $1 (rc $RC, configuración $(gh_same && echo igual || echo CAMBIADA)): dijo «$(gh_brief)» · $(brief "$T/gh.out" 200)"; fi
}
gh_warned() { # <caso> <lo que git usa> <texto de la cabecera>…: UN aviso con esa cabecera, las dos rutas y el comando
  local name="$1" uses="$2" said head good=1; shift 2
  said="$(gh_said)"
  [ "$RC" -eq 0 ] && [ "$(printf '%s\n' "$said" | grep -c 'core\.hooksPath global')" = 1 ] && no_ps_error "$T/gh.out" || good=0
  for head in "$@"; do case "$(printf '%s\n' "$said" | head -1)" in *"$head"*) ;; *) good=0 ;; esac; done
  [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    git usa:             ${uses}")" = 1 ] || good=0
  [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    el instalador llena: ${GH_OURS}")" = 1 ] || good=0
  [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    para apuntarlo:      git config --global core.hooksPath \"${GH_OURS}\"")" = 1 ] || good=0
  gh_same || good=0
  if [ "$good" = 1 ]; then ok "(gh) ${name}: avisa una vez, con las dos rutas y el comando, y no toca la configuración de git"
  else no "(gh) ${name} (rc $RC, configuración $(gh_same && echo igual || echo CAMBIADA)): dijo «$(gh_brief)» · $(brief "$T/gh.out" 200)"; fi
}
# git no tiene ninguna: el aviso de siempre (esta primera corrida, además, deja los hooks en la carpeta del instalador)
gh_set ""; gh_run
GH_TODAY="$(printf '%s\n%s' '⚠ git no tiene core.hooksPath global — los hooks del arnés NO corren. Activalo con:' "    git config --global core.hooksPath ${GH_OURS}")"
if [ "$RC" -eq 0 ] && [ "$(gh_said)" = "$GH_TODAY" ] && gh_same && [ -f "$GH_OURS/pre-push" ]; then ok "(gh) git no tiene ninguna: el aviso de siempre con su comando, y el pre-push queda en la carpeta del instalador"
else no "(gh) git no tiene ninguna (rc $RC, pre-push $([ -f "$GH_OURS/pre-push" ] && echo puesto || echo FALTA)): dijo «$(gh_brief)» · $(brief "$T/gh.out" 200)"; fi
gh_run -- -Check
if [ "$RC" -eq 0 ] && [ "$(gh_said)" = "$GH_TODAY" ] && gh_same; then ok "(gh) git no tiene ninguna, con -Check: el mismo aviso"
else no "(gh) ninguna con -Check (rc $RC): dijo «$(gh_brief)»"; fi
# es la del instalador: calla
gh_set "$GH_OURS"; gh_run; gh_quiet "es la del instalador (la ruta entera)"
gh_set '~/git-hooks'; gh_run; gh_quiet "es la del instalador (escrita con ~)"
ln -s "$GH_OURS" "$GH_LAB/enlace" || no "(gh) no pude crear el enlace a la carpeta del instalador"
gh_set "$GH_LAB/enlace"; gh_run; gh_quiet "es un enlace a la del instalador (la misma carpeta)"
# puesta desde un archivo incluido: `git config --global` no sigue los `include` si no se le pide
git config --file "$GH_LAB/incluido" core.hooksPath "$GH_OURS" && : > "$GH_CFG" && git config --file "$GH_CFG" include.path "$GH_LAB/incluido" && cp "$GH_CFG" "$GH_CFG.before" \
  || no "(gh) no pude armar la configuración con un archivo incluido"
gh_run; gh_quiet "es la del instalador, puesta desde un archivo incluido"
# un git de antes de 2.18 no conoce `--type=path`: el valor se toma tal cual, y el `~` lo expande el .ps1
mkdir -p "$GH_LAB/old-git" \
  && printf '#!/bin/sh\n# un git que no conoce --type=path (laboratorio)\nfor a in "$@"; do case "$a" in --type=path) echo "error: unknown option" >&2; exit 129 ;; esac; done\nexec "%s" "$@"\n' "$(command -v git)" > "$GH_LAB/old-git/git" \
  && chmod +x "$GH_LAB/old-git/git" || no "(gh) no pude armar el git de antes"
gh_set '~/git-hooks'; gh_run "PATH=$GH_LAB/old-git:$T/bin:$PATH"; gh_quiet "es la del instalador escrita con ~, con un git que no conoce --type=path"
# git ya apunta a la carpeta del instalador y esa carpeta todavía no existe (se mira antes de instalar): es la del
# instalador, no «otra» ni «una que no existe» (el .ps1 ya dice aparte que sus hooks faltan)
gh_set "$GH_LAB/todavia-no"; gh_run "TYCON_GIT_HOOKS_DIR=$GH_LAB/todavia-no" -- -Check
gh_quiet "es la del instalador, que todavía no existe (con -Check)"
if [ ! -e "$GH_LAB/todavia-no" ]; then ok "(gh) …y -Check no la crea"; else no "(gh) -Check creó la carpeta del instalador (${GH_LAB}/todavia-no)"; fi
# es otra: las dos rutas y el comando
mkdir -p "$GH_LAB/otra"
gh_set "$GH_LAB/otra"; gh_run
gh_warned "es otra" "$GH_LAB/otra" "apunta a OTRA carpeta" "NO corren" "freno antes de publicar"
gh_run -- -Check
gh_warned "es otra, con -Check" "$GH_LAB/otra" "apunta a OTRA carpeta" "NO corren" "freno antes de publicar"
# con los hooks de git apagados no se mira nada (las mismas condiciones que el aviso de siempre)
gh_run TYCON_NO_GIT_HOOKS=1; gh_quiet "es otra, con TYCON_NO_GIT_HOOKS=1"
# apunta a una carpeta que no existe
gh_set "$GH_LAB/no-esta"; gh_run
gh_warned "no existe" "$GH_LAB/no-esta" "carpeta que NO existe" "NO corren" "freno antes de publicar"
if [ ! -e "$GH_LAB/no-esta" ]; then ok "(gh) no existe: el .ps1 no la crea"; else no "(gh) no existe: el .ps1 creó ${GH_LAB}/no-esta"; fi
# relativa: cada repo usa la suya, no hay con qué comparar
gh_set ".githooks"; gh_run
gh_warned "relativa" ".githooks" "no pude comparar" "relativa" "freno antes de publicar"
# lo que sólo pasa en Windows: la función que decide, con la plataforma por parámetro
cat > "$GH_LAB/compare-fn.ps1" <<'PS'
param([string]$Src, [string]$Other, [string]$Installed, [string]$Via, [string]$ViaRelative, [string]$ViaChain, [string]$ViaOther)
$s = [IO.File]::ReadAllText($Src)
foreach ($n in 'Get-TyconHome', 'Compare-GlobalHooksDir') {
    $m = [regex]::Match($s, "(?ms)^function $n.*?^\}")
    if (-not $m.Success) { "sin-funcion=$n"; exit 3 }
    Invoke-Expression $m.Value
}
# 🔴 las rutas de ejemplo NO tienen forma de carpeta de usuario: esta prueba viaja en la copia pública, y el detector de
# publicación lee una ruta así como la de la máquina de alguien y frena la copia entera
$ours = 'C:\herramientas\git-hooks'
"git-bash=$(Compare-GlobalHooksDir -Configured '/c/herramientas/git-hooks' -Installed $ours -Platform 'Win32NT')"
"unix-root=$(Compare-GlobalHooksDir -Configured '/usr/share/git-hooks' -Installed $ours -Platform 'Win32NT')"
"relative=$(Compare-GlobalHooksDir -Configured '.githooks' -Installed $ours -Platform 'Win32NT')"
"case-and-slashes=$(Compare-GlobalHooksDir -Configured 'c:/HERRAMIENTAS/git-hooks/' -Installed $ours -Platform 'Win32NT')"
"tilde=$(Compare-GlobalHooksDir -Configured '~/git-hooks' -Installed $ours -Platform 'Win32NT' -HomeDir 'C:\herramientas')"
"missing-drive=$(Compare-GlobalHooksDir -Configured 'D:\no\such\git-hooks' -Installed $ours -Platform 'Win32NT')"
"missing-share=$(Compare-GlobalHooksDir -Configured '\\acme-server\share\git-hooks' -Installed $ours -Platform 'Win32NT')"
"unix-case=$(Compare-GlobalHooksDir -Configured '/no/such/GIT-HOOKS' -Installed '/no/such/git-hooks' -Platform 'Unix')"
# una carpeta que no se deja mirar (acá, un Get-Item que tira): la función contesta, no mata al instalador
"unreadable=$(& { function Get-Item { throw 'no se deja mirar (laboratorio)' }; Compare-GlobalHooksDir -Configured $Other -Installed $Installed })"
# la misma carpeta alcanzada por un enlace que NO es la última carpeta de la ruta (en Windows, un junction intermedio:
# un perfil redirigido): se resuelve la ruta entera, tramo por tramo. $Via llega por un enlace absoluto, $ViaRelative
# por uno escrito relativo, $ViaChain por un enlace a otro enlace; $ViaOther llega por el enlace a OTRA carpeta
"mid-link=$(Compare-GlobalHooksDir -Configured $Via -Installed $Installed)"
"mid-link-reversed=$(Compare-GlobalHooksDir -Configured $Installed -Installed $Via)"
"mid-link-relative=$(Compare-GlobalHooksDir -Configured $ViaRelative -Installed $Installed)"
"mid-link-chain=$(Compare-GlobalHooksDir -Configured $ViaChain -Installed $Installed)"
"mid-link-other=$(Compare-GlobalHooksDir -Configured $ViaOther -Installed $Installed)"
PS
# el laboratorio del enlace intermedio: la carpeta de usuario de juguete alcanzada por un enlace, por uno relativo y por
# un enlace a ese enlace; y, dentro de ella, otra carpeta de hooks que NO es la del instalador
mkdir -p "$HGH/otros-hooks" && ln -s "$HGH" "$GH_LAB/casa" && ln -s "../$(basename "$HGH")" "$GH_LAB/casa-relativa" && ln -s "$GH_LAB/casa" "$GH_LAB/casa-encadenada" \
  || no "(gh) no pude armar los enlaces intermedios"
lab_env "$HGH" -- pwsh -NoProfile -NonInteractive -File "$GH_LAB/compare-fn.ps1" -Src "$PS1_INSTALLER" -Other "$GH_LAB/otra" -Installed "$GH_OURS" \
  -Via "$GH_LAB/casa/git-hooks" -ViaRelative "$GH_LAB/casa-relativa/git-hooks" -ViaChain "$GH_LAB/casa-encadenada/git-hooks" -ViaOther "$GH_LAB/casa/otros-hooks" > "$T/gh-fn.out" 2>&1
gh_fn() { # <nombre del caso> <respuesta esperada> <qué prueba>
  if grep -qx -- "$1=$2" "$T/gh-fn.out"; then ok "(gh) en Windows, $3 → $2"
  else no "(gh) en Windows, $3: esperaba «$2» y dio «$(sed -n "s/^$1=//p" "$T/gh-fn.out")» · $(brief "$T/gh-fn.out" 200)"; fi
}
gh_fn git-bash unix-form "una ruta con forma de Git Bash (/c/herramientas/…) no se puede comparar"
gh_fn unix-root unix-form "una ruta con forma de Unix (/usr/…) no se puede comparar"
gh_fn relative relative "una ruta relativa no se puede comparar"
gh_fn case-and-slashes same "la del instalador con otras mayúsculas, con / y con una barra al final es la misma"
gh_fn tilde same "la del instalador escrita con ~ es la misma"
gh_fn missing-drive missing "una ruta con unidad que no está en el disco no existe (no es «relativa» ni «forma de Unix»)"
gh_fn missing-share missing "una carpeta compartida (\\\\servidor\\…) que no está no existe (no es «forma de Unix»)"
if grep -qx -- "unix-case=missing" "$T/gh-fn.out"; then ok "(gh) fuera de Windows las mayúsculas cuentan: otra caja no se da por la misma sin mirar el disco"
else no "(gh) fuera de Windows, otra caja: dio «$(sed -n 's/^unix-case=//p' "$T/gh-fn.out")»"; fi
if grep -qx -- "unreadable=unreadable" "$T/gh-fn.out"; then ok "(gh) una carpeta que no se deja mirar: la función contesta «unreadable» (no tira: el instalador sigue)"
else no "(gh) una carpeta que no se deja mirar: dio «$(sed -n 's/^unreadable=//p' "$T/gh-fn.out")» · $(brief "$T/gh-fn.out" 200)"; fi
# el enlace intermedio (medido acá con pwsh en modo Unix; el junction intermedio de Windows lo mide la corrida de Windows)
gh_mid() { # <nombre del caso> <respuesta esperada> <qué prueba>
  if grep -qx -- "$1=$2" "$T/gh-fn.out"; then ok "(gh) $3 → $2"
  else no "(gh) $3: esperaba «$2» y dio «$(sed -n "s/^$1=//p" "$T/gh-fn.out")» · $(brief "$T/gh-fn.out" 200)"; fi
}
gh_mid mid-link same "la del instalador alcanzada por un enlace que no es la última carpeta de la ruta es la misma"
gh_mid mid-link-reversed same "…también al revés (la del instalador es la que llega por el enlace)"
gh_mid mid-link-relative same "…por un enlace intermedio escrito relativo"
gh_mid mid-link-chain same "…por un enlace a otro enlace"
gh_mid mid-link-other other "el espejo: por el mismo enlace intermedio, OTRA carpeta sigue siendo otra"
# …y el instalador entero: git usa la del instalador por el enlace intermedio → calla
gh_set "$GH_LAB/casa/git-hooks"; gh_run -- -Check; gh_quiet "es la del instalador alcanzada por un enlace intermedio (con -Check)"
gh_set "$GH_LAB/casa/otros-hooks"; gh_run -- -Check
gh_warned "es otra, alcanzada por el mismo enlace intermedio (con -Check)" "$GH_LAB/casa/otros-hooks" "apunta a OTRA carpeta" "NO corren"

# git no contesta: no es «git no tiene carpeta global de hooks». Con un git cuya lectura de la clave sale con otro
# código (acá 128, lo que da una configuración rota) el .ps1 dice que no pudo leerla, con el código, y no afirma más
gh_unread() { # <caso> <texto de la cabecera>…: UN aviso «no pude leer», sin el de «git no tiene», y la carpeta del instalador
  local name="$1" said head good=1; shift
  said="$(gh_said)"
  [ "$RC" -eq 0 ] && [ "$(printf '%s\n' "$said" | grep -c 'core\.hooksPath global')" = 1 ] && no_ps_error "$T/gh.out" || good=0
  for head in "no pude leer la carpeta global de hooks de git" "$@"; do case "$(printf '%s\n' "$said" | head -1)" in *"$head"*) ;; *) good=0 ;; esac; done
  [ "$(printf '%s\n' "$said" | grep -c -x -F -- "    el instalador llena: ${GH_OURS}")" = 1 ] || good=0
  if grep -q -e 'git no tiene core.hooksPath global' -e 'apunta a OTRA carpeta' -e 'Activalo con' "$T/gh.out"; then good=0; fi
  gh_same || good=0
  if [ "$good" = 1 ]; then ok "(gh) ${name}: dice que no pudo leerla, con el motivo, y no afirma que git no tenga ninguna"
  else no "(gh) ${name} (rc $RC): dijo «$(gh_brief)» · $(brief "$T/gh.out" 200)"; fi
}
mkdir -p "$GH_LAB/broken-git" \
  && printf '#!/bin/sh\n# un git cuya lectura de la carpeta global de hooks falla (laboratorio)\ncase "$*" in *config*--global*core.hooksPath*) echo "fatal: configuracion rota (laboratorio)" >&2; exit 128 ;; esac\nexec "%s" "$@"\n' "$(command -v git)" > "$GH_LAB/broken-git/git" \
  && chmod +x "$GH_LAB/broken-git/git" || no "(gh) no pude armar el git que falla"
gh_set "$GH_LAB/otra"; gh_run "PATH=$GH_LAB/broken-git:$T/bin:$PATH"
gh_unread "git falla al leer la clave (sale 128)" "git config salió 128"
if [ "$(gh_said | grep -c -x -F -- '    git dijo:            fatal: configuracion rota (laboratorio)')" = 1 ]; then ok "(gh) …y trae lo que git dijo"
else no "(gh) git falla al leer la clave: no trae lo que git dijo: «$(gh_brief)»"; fi
gh_run "PATH=$GH_LAB/broken-git:$T/bin:$PATH" -- -Check
gh_unread "git falla al leer la clave, con -Check" "git config salió 128"
# git no está: tampoco es «no tiene». Un PATH armado a mano con lo que el .ps1 necesita para arrancar, y sin git
mkdir -p "$GH_LAB/no-git" && for tool in pwsh bash sh python3 env; do
  p="$(command -v "$tool" 2>/dev/null)" && ln -sf "$p" "$GH_LAB/no-git/$tool"
done && cp "$T/bin/node" "$T/bin/launchctl" "$GH_LAB/no-git/" || no "(gh) no pude armar el PATH sin git"
if env -i "PATH=$GH_LAB/no-git" /bin/sh -c 'command -v git' >/dev/null 2>&1; then no "(gh) git sigue en el PATH armado: el caso «git no está» no mide nada"
else
  gh_set "$GH_LAB/otra"; gh_run "PATH=$GH_LAB/no-git" -- -Check
  gh_unread "git no está en el PATH (con -Check)" "no pude lanzar git"
fi

# ═══ (ab) story 8.36 · la tanda: menos procesos de Node por arranque, y lo mismo hecho (T4, T6, T7, T8) ═══════════════
# El aplicador corre en cada arranque. Cada proceso de Node cuesta ~50-100 ms en lanzarse desde PowerShell en Windows.
# Cada Node que arranca se cuenta con `NODE_OPTIONS=--require <contador>`, que ve también los que un guion lanza por su
# cuenta con su propia ruta de node (el intermediario del PATH no los ve). Lo hecho se compara contra el mismo aplicador
# SIN la tanda (las llamadas sueltas de antes, que quedan como respaldo): la misma salida en el mismo orden, el mismo
# settings.json, el mismo reporte de piezas y el mismo CLAUDE.md, byte a byte.
COUNTER="$T/node-counter.js"; COUNTED="$T/node-counted.txt"
cat > "$COUNTER" <<EOF
require('fs').appendFileSync('$COUNTED', (process.argv[1] ? require('path').basename(process.argv[1]) : '-e') + '\n');
EOF
count_of() { grep -c -x -F -- "$1" "$COUNTED" 2>/dev/null || true; }   # <guion>: cuántas veces arrancó en la corrida contada
# los clones de comparación: sin la tanda, y con una tanda que sale 1 sin dejar su resultado
CLONE_NB="$T/clone-nobatch"; CLONE_BAD="$T/clone-badbatch"; CLONE_CUT="$T/clone-cutbatch"   # (el cortado lo arma T7b)
CLONE_MISS="$T/clone-missing"; CLONE_MISS_NB="$T/clone-missing-nobatch"   # sin skills-dir.js, con la tanda y sin ella (T7c)
cp -R "$CLONE" "$CLONE_NB" && rm -f "$CLONE_NB/scripts/setup/applier-batch.js" \
  && cp -R "$CLONE" "$CLONE_BAD" && printf 'process.exit(1);\n' > "$CLONE_BAD/scripts/setup/applier-batch.js" \
  || no "(ab) no pude armar los clones de comparación"
ab_norm() { # <archivo> <home>: la salida o el archivo, con la HOME y los tres clones escritos igual, y sin sellos de hora
  sed -e "s#$2#<HOME>#g" -e "s#$CLONE_NB#<CLONE>#g" -e "s#$CLONE_BAD#<CLONE>#g" -e "s#$CLONE_CUT#<CLONE>#g" \
    -e "s#$CLONE_MISS_NB#<CLONE>#g" -e "s#$CLONE_MISS#<CLONE>#g" -e "s#$CLONE#<CLONE>#g" \
    -e 's#\(\.bak[.-][A-Za-z-]*\)[0-9][0-9TZ:.-]*#\1<SELLO>#g' "$1" 2>/dev/null
}
ab_run() { # <clon> <home> <nombre> [VAR=val …]: una corrida como la del arranque (candado tomado, con reporte), contada
  local clone="$1" h="$2" name="$3"; shift 3
  : > "$COUNTED"
  LAB_INSTALLER="$clone/scripts/install-tycon-hooks.ps1" installer "$h" "${HELD[@]}" "NODE_OPTIONS=--require $COUNTER" "$@" \
    -- --report-json "$h/report.json" > "$T/ab-$name.out" 2>&1
  AB_RC=$?
  cp "$COUNTED" "$T/ab-$name.counted" 2>/dev/null
}
ab_same() { # <nombre> <home A> <home B> <etiqueta>: lo hecho por la corrida A (con la tanda) igual que por la B
  local name="$1" ha="$2" hb="$3" what="$4" diffs=""
  [ "$(ab_norm "$T/ab-$name-a.out" "$ha")" = "$(ab_norm "$T/ab-$name-b.out" "$hb")" ] || diffs="$diffs salida"
  [ "$(ab_norm "$ha/.claude/settings.json" "$ha")" = "$(ab_norm "$hb/.claude/settings.json" "$hb")" ] || diffs="$diffs settings.json"
  [ "$(ab_norm "$ha/report.json" "$ha")" = "$(ab_norm "$hb/report.json" "$hb")" ] || diffs="$diffs reporte"
  cmp -s "$ha/.claude/CLAUDE.md" "$hb/.claude/CLAUDE.md" || diffs="$diffs CLAUDE.md"
  if [ -z "$diffs" ]; then ok "$what: la misma salida en el mismo orden, el mismo settings.json, el mismo reporte y el mismo CLAUDE.md"
  else
    no "$what: distinto en:$diffs"
    diff <(ab_norm "$T/ab-$name-a.out" "$ha") <(ab_norm "$T/ab-$name-b.out" "$hb") | head -12 | sed 's/^/      /'
  fi
}
ab_pair() { # <nombre> <clon B> <setup> [VAR=val …]: dos HOME iguales armadas por <setup>, una corrida con la tanda y otra con B
  local name="$1" cloneb="$2" setup="$3"; shift 3
  AB_A="$(new_home "ab-$name-a")"; AB_B="$(new_home "ab-$name-b")"
  "$setup" "$AB_A" "$CLONE"; "$setup" "$AB_B" "$cloneb"   # cada HOME, armada por el clon que la va a correr
  ab_run "$CLONE" "$AB_A" "$name-a" "$@"; AB_RC_A=$AB_RC
  ab_run "$cloneb" "$AB_B" "$name-b" "$@"; AB_RC_B=$AB_RC
  [ "$AB_RC_A" = "$AB_RC_B" ] || no "(ab) $name: la corrida con la tanda salió $AB_RC_A y la de comparación $AB_RC_B · $(brief "$T/ab-$name-a.out" 200)"
}
# los estados: una máquina ya instalada (lo de cada arranque), una por estrenar con la configuración rota y la línea del
# índice vieja en CLAUDE.md, y una por estrenar sana con el sync de bloques prendido
ab_installed() { LAB_INSTALLER="$2/scripts/install-tycon-hooks.ps1" installer "$1" "${HELD[@]}" > /dev/null 2>&1; printf '# mío\n@~/.claude/tycon-harness/INDEX.md\n' > "$1/.claude/CLAUDE.md"; }
ab_broken_old() { mkdir -p "$1/.claude"; printf '{ roto' > "$1/.claude/tycon.json"; printf '# mío\n@~/.claude/tycon-harness/README.md\n' > "$1/.claude/CLAUDE.md"; }
ab_fresh() { mkdir -p "$1/.claude"; printf '# mío\n@~/.claude/tycon-harness/README.md\n' > "$1/.claude/CLAUDE.md"; }

# ── T4 · Ps1_NodeProcessesPerRun: una corrida del arranque en una máquina ya instalada lanza como mucho 3 Node ──────
# (la tanda de lectura, la de aplicación y la línea del índice, que queda suelta; la tanda A sola dejaba 9)
ab_pair steady "$CLONE_NB" ab_installed
N_A=$(wc -l < "$T/ab-steady-a.counted" | tr -d ' '); N_B=$(wc -l < "$T/ab-steady-b.counted" | tr -d ' ')
echo "ℹ installer-ps1: (ab) procesos de Node en una corrida del arranque — con la tanda: $N_A ($(sort "$T/ab-steady-a.counted" | uniq -c | awk '{printf "%s %s · ", $2, $1}')) · sin ella: $N_B"
# El tope es 3. Con la capa del equipo (el árbol trae scripts/lib/renames.json, como en cada máquina del equipo y en el
# nocturno, que pone el público encima del privado) es 4: la llamada a legacy-names.js quedó afuera de la tanda de la
# 8.36, y ése es el cuarto. Aceptado por el dueño el 2026-10-15 (nocturno 13535); meterla en la tanda está anotado como
# pendiente en tasks/todo.md del repo de mantenimiento. Con capa, el de más tiene que ser ése y no otro.
AB_CAP=3; AB_WHY="≤ 3"
if [ -f "$CLONE/scripts/lib/renames.json" ]; then AB_CAP=4; AB_WHY="≤ 4 con la capa del equipo: legacy-names.js va afuera de la tanda"; fi
if [ "$AB_CAP" = 4 ] && [ "$N_A" = 4 ] && ! grep -qx 'legacy-names.js' "$T/ab-steady-a.counted"; then
  no "T4 con la capa del equipo el cuarto proceso de Node tenía que ser legacy-names.js: $(sort "$T/ab-steady-a.counted" | tr '\n' ' ')"
elif [ "$AB_RC_A" = 0 ] && [ "$N_A" -gt 0 ] && [ "$N_A" -le "$AB_CAP" ]; then ok "T4 una corrida del arranque lanza $N_A procesos de Node ($AB_WHY; sin la tanda, $N_B)"
else no "T4 una corrida del arranque lanzó $N_A procesos de Node (tope $AB_CAP; salió $AB_RC_A) · $(brief "$T/ab-steady-a.out" 200)"; fi
ab_same steady "$AB_A" "$AB_B" "T6 máquina ya instalada, con la tanda y sin ella"

# ── T6 · Ps1_SameOutputOrderAndClaudeMd: configuración rota, hooks por agregar, la línea del índice vieja ───────────
ab_pair broken "$CLONE_NB" ab_broken_old TYCON_NO_CLAUDEMD_SYNC=0
ab_same broken "$AB_A" "$AB_B" "T6 configuración rota y la línea del índice vieja, con la tanda y sin ella"
ab_pair fresh "$CLONE_NB" ab_fresh TYCON_NO_CLAUDEMD_SYNC=0
ab_same fresh "$AB_A" "$AB_B" "T6 máquina por estrenar con el sync de bloques, con la tanda y sin ella"
AB_FRESH_A="$AB_A"

# ── T8 · Sync_UsesGivenConfig_NoNode: el sync llamado por el aplicador no le pregunta a Node; suelto, sí ─────────────
TC_A=$(grep -c -x -F -- tycon-config.js "$T/ab-fresh-a.counted" 2>/dev/null || true)
if [ "$TC_A" = 0 ]; then ok "T8 con el sync prendido, ninguna corrida de tycon-config.js en un proceso propio (la configuración se lee una vez, en la tanda)"
else no "T8 con el sync prendido, tycon-config.js arrancó $TC_A vez/veces en un proceso propio"; fi
SYNC_H="$(new_home ab-sync)"; ab_fresh "$SYNC_H"
: > "$COUNTED"
lab_env "$SYNC_H" TYCON_NO_CLAUDEMD_SYNC=0 "NODE_OPTIONS=--require $COUNTER" -- pwsh -NoProfile -NonInteractive -File "$CLONE/scripts/setup/sync-claude-md-blocks.ps1" > "$T/ab-sync.out" 2>&1
TC_S=$(count_of tycon-config.js)
if [ "${TC_S:-0}" -ge 1 ]; then ok "T8 el sync corrido suelto le pregunta a tycon-config.js como antes ($TC_S vez/veces)"
else no "T8 el sync corrido suelto no le preguntó a tycon-config.js · $(brief "$T/ab-sync.out" 200)"; fi
# el espejo: después de la corrida del aplicador (su sync usó lo que el aplicador leyó), el sync suelto —que le pregunta
# a Node él mismo— sobre esa misma HOME no tiene nada que cambiar
cp "$AB_FRESH_A/.claude/CLAUDE.md" "$T/ab-fresh-claude.md" 2>/dev/null
lab_env "$AB_FRESH_A" TYCON_NO_CLAUDEMD_SYNC=0 -- pwsh -NoProfile -NonInteractive -File "$CLONE/scripts/setup/sync-claude-md-blocks.ps1" > "$T/ab-sync2.out" 2>&1
if [ -s "$T/ab-fresh-claude.md" ] && cmp -s "$T/ab-fresh-claude.md" "$AB_FRESH_A/.claude/CLAUDE.md"; then ok "T8 el sync suelto, preguntando él mismo, no cambia nada de lo que dejó el sync del aplicador con lo que el aplicador leyó"
else no "T8 el sync suelto cambió el CLAUDE.md que dejó el del aplicador · $(diff "$T/ab-fresh-claude.md" "$AB_FRESH_A/.claude/CLAUDE.md" | head -4 | tr '\n' ' ' | cut -c1-200)"; fi

# ── T7 · Ps1_WithoutBatch_SeparateCalls: una tanda que sale 1 sin su resultado deja lo mismo que sin la tanda ──────────
ab_pair badbatch "$CLONE_BAD" ab_fresh TYCON_NO_CLAUDEMD_SYNC=0
ab_same badbatch "$AB_A" "$AB_B" "T7 con una tanda que sale 1 sin resultado (las llamadas sueltas de respaldo)"

# ── T6b · con el paso de terceros prendido, el plan y el reporte quedan en el mismo orden que sin la tanda ─────────────
# (pase adversarial de la tanda B: el registro de hooks, dentro de la tanda, anotaba sus piezas antes que las de
# terceros que este archivo anota después; ahora van a un temporal propio y se suman en su lugar de siempre). Sin red:
# el plan con -Check (la revisión de terceros no baja nada) y el reporte con un manifiesto vacío y una skill de terceros
# ya «completa» en el estado.
printf '{\n  "third_party": []\n}\n' > "$T/tp-empty-manifest.json"
ab_tp_state() { mkdir -p "$1/.claude/.tycon-pipeline"; printf '{"entries":{"skills/tycon-pipeline/":{"complete":true}}}\n' > "$1/.claude/.tycon-pipeline/third-party-state.json"; }
for side in a b; do
  clone="$CLONE"; [ "$side" = b ] && clone="$CLONE_NB"
  h="$(new_home "ab-tpplan-$side")"
  LAB_INSTALLER="$clone/scripts/install-tycon-hooks.ps1" installer "$h" "${HELD[@]}" TYCON_THIRD_PARTY=1 -- -Check -PlanJson "$h/plan.json" > "$T/ab-tpplan-$side.out" 2>&1
  eval "TP_PLAN_$side=\"\$h\""
done
if [ -s "$TP_PLAN_a/plan.json" ] && [ "$(ab_norm "$TP_PLAN_a/plan.json" "$TP_PLAN_a")" = "$(ab_norm "$TP_PLAN_b/plan.json" "$TP_PLAN_b")" ] \
   && [ "$(ab_norm "$T/ab-tpplan-a.out" "$TP_PLAN_a")" = "$(ab_norm "$T/ab-tpplan-b.out" "$TP_PLAN_b")" ]; then
  ok "T6b con terceros prendido, -Check -PlanJson da el mismo plan, en el mismo orden, con la tanda y sin ella"
else no "T6b con terceros prendido, el plan con la tanda y sin ella difiere · $(diff <(ab_norm "$TP_PLAN_a/plan.json" "$TP_PLAN_a") <(ab_norm "$TP_PLAN_b/plan.json" "$TP_PLAN_b") | head -4 | tr '\n' ' ' | cut -c1-200)"; fi
ab_tp_fresh() { ab_fresh "$1"; ab_tp_state "$1"; }
ab_pair tpreport "$CLONE_NB" ab_tp_fresh TYCON_THIRD_PARTY=1 "TYCON_THIRD_PARTY_MANIFEST=$T/tp-empty-manifest.json"
ab_same tpreport "$AB_A" "$AB_B" "T6b con terceros prendido y una skill de terceros completa, con la tanda y sin ella (el reporte, en el mismo orden)"
grep -q '"kind": "third-party"' "$AB_A/report.json" 2>/dev/null && ok "T6b el reporte trae la pieza de terceros (el caso mide algo)" \
  || no "T6b el reporte no trae ninguna pieza de terceros: el caso no mide el orden"

# ── T6c · el aviso apagado con TYCON_NO_CANONICAL_PATH=1: igual con la tanda y sin ella ─────────────────────────────────
ab_pair nocanon "$CLONE_NB" ab_installed TYCON_NO_CANONICAL_PATH=1
ab_same nocanon "$AB_A" "$AB_B" "T6c con el aviso del lugar apagado (TYCON_NO_CANONICAL_PATH=1), con la tanda y sin ella"

# ── T7c · un guion que falta: ese paso no entra a la tanda y corre suelto; el resto sale de la tanda ────────────────────
cp -R "$CLONE" "$CLONE_MISS" && rm -f "$CLONE_MISS/scripts/lib/skills-dir.js" \
  && cp -R "$CLONE_NB" "$CLONE_MISS_NB" && rm -f "$CLONE_MISS_NB/scripts/lib/skills-dir.js" \
  || no "(ab) no pude armar los clones sin skills-dir.js"
ab_pair missing "$CLONE_MISS_NB" ab_installed
# (ab_pair arma la A con $CLONE: se rehace con el clon al que le falta el guion)
AB_A="$(new_home ab-missing2-a)"; ab_installed "$AB_A" "$CLONE_MISS"; ab_run "$CLONE_MISS" "$AB_A" missing-a; AB_RC_A=$AB_RC
[ "$AB_RC_A" = "$AB_RC_B" ] || no "(ab) missing: con la tanda salió $AB_RC_A y sin ella $AB_RC_B"
ab_same missing "$AB_A" "$AB_B" "T7c sin scripts/lib/skills-dir.js en el clon, con la tanda y sin ella"
grep -q 'applier-batch.js' "$T/ab-missing-a.counted" && ok "T7c …y la tanda corrió igual para el resto de los pasos" \
  || no "T7c sin skills-dir.js la tanda no corrió: $(sort "$T/ab-missing-a.counted" | uniq -c | tr '\n' ' ')"

# ── T7d · un -Link que no se puede cumplir, con la biblioteca: sin tanda de lectura, sale 2 y no toca nada más ─────────
for side in a b; do
  clone="$CLONE"; [ "$side" = b ] && clone="$CLONE_NB"
  h="$(new_home "ab-badlink-$side")"
  : > "$COUNTED"
  LAB_INSTALLER="$clone/scripts/install-tycon-hooks.ps1" installer "$h" "${HELD[@]}" "NODE_OPTIONS=--require $COUNTER" -- -Link "$T/no-esta-$side" > "$T/ab-badlink-$side.out" 2>&1
  eval "BL_RC_$side=\$?; BL_H_$side=\"\$h\""
  cp "$COUNTED" "$T/ab-badlink-$side.counted"
done
BL_OUT_A="$(ab_norm "$T/ab-badlink-a.out" "$BL_H_a" | sed "s#$T/no-esta-a#<NO-ESTA>#g")"; BL_OUT_B="$(ab_norm "$T/ab-badlink-b.out" "$BL_H_b" | sed "s#$T/no-esta-b#<NO-ESTA>#g")"
if [ "$BL_RC_a" = 2 ] && [ "$BL_RC_b" = 2 ] && [ "$BL_OUT_A" = "$BL_OUT_B" ] && ! grep -q 'applier-batch.js' "$T/ab-badlink-a.counted" \
   && [ "$(listing "$BL_H_a" | sed "s#$BL_H_a##g")" = "$(listing "$BL_H_b" | sed "s#$BL_H_b##g")" ]; then
  ok "T7d un -Link imposible sale 2, sin tanda de lectura, con la misma salida y la misma HOME que sin la tanda"
else no "T7d -Link imposible: rc $BL_RC_a/$BL_RC_b · tanda: $(grep -c applier-batch.js "$T/ab-badlink-a.counted") · $(brief "$T/ab-badlink-a.out" 160)"; fi

# ── T7b · una tanda que se corta a mitad: lo anotado se usa, lo que falta corre suelto, y se dice ─────────────────────
# La tanda de verdad, con la tercera escritura de su resultado rota: en cada tanda corren dos pasos y queda anotado uno.
# El segundo ya hizo su trabajo y se repite suelto (no lo vuelve a hacer; su aviso puede no salir). Lo que importa: el
# mismo settings.json, el mismo reporte y el mismo CLAUDE.md que sin la tanda, y una línea que lo dice.
cp -R "$CLONE" "$CLONE_CUT" && mv "$CLONE_CUT/scripts/setup/applier-batch.js" "$CLONE_CUT/scripts/setup/applier-batch-real.js" \
  && cat > "$CLONE_CUT/scripts/setup/applier-batch.js" <<'EOF' || no "(ab) no pude armar el clon con la tanda que se corta"
// laboratorio (installer-ps1, T7b): la tanda de verdad, con la tercera escritura de SU resultado rota (sólo esa: los
// pasos también escriben con un renombrado, y ésos tienen que andar)
const fs = require('fs');
const path = require('path');
const out = path.resolve(process.argv[process.argv.indexOf('--out') + 1]);
const rename = fs.renameSync;
let n = 0;
fs.renameSync = (a, b) => {
  if (path.resolve(String(b)) === out && ++n === 3) throw Object.assign(new Error('disco lleno (laboratorio)'), { code: 'EIO' });
  return rename(a, b);
};
process.exitCode = require('./applier-batch-real.js').main(process.argv.slice(2));
EOF
AB_A="$(new_home ab-cut-a)"; AB_B="$(new_home ab-cut-b)"; ab_fresh "$AB_A" "$CLONE_CUT"; ab_fresh "$AB_B" "$CLONE_NB"
ab_run "$CLONE_CUT" "$AB_A" cut-a TYCON_NO_CLAUDEMD_SYNC=0; AB_RC_A=$AB_RC
ab_run "$CLONE_NB" "$AB_B" cut-b TYCON_NO_CLAUDEMD_SYNC=0; AB_RC_B=$AB_RC
cut_diffs=""
[ "$AB_RC_A" = "$AB_RC_B" ] || cut_diffs="$cut_diffs código($AB_RC_A/$AB_RC_B)"
[ "$(ab_norm "$AB_A/.claude/settings.json" "$AB_A")" = "$(ab_norm "$AB_B/.claude/settings.json" "$AB_B")" ] || cut_diffs="$cut_diffs settings.json"
[ "$(ab_norm "$AB_A/report.json" "$AB_A")" = "$(ab_norm "$AB_B/report.json" "$AB_B")" ] || cut_diffs="$cut_diffs reporte"
cmp -s "$AB_A/.claude/CLAUDE.md" "$AB_B/.claude/CLAUDE.md" || cut_diffs="$cut_diffs CLAUDE.md"
CUT_SAID="$(grep 'la tanda de Node se cortó antes de terminar' "$T/ab-cut-a.out" | grep -c 'applier-batch: no pude escribir el resultado.*(EIO)' || true)"   # con su causa
if [ -z "$cut_diffs" ] && [ "$CUT_SAID" = 2 ]; then ok "T7b una tanda que se corta a mitad deja el mismo settings.json, reporte y CLAUDE.md que sin ella, y lo dice (una línea por tanda)"
else no "T7b tanda cortada: distinto en:${cut_diffs:- nada} · avisos: $CUT_SAID (esperaba 2) · $(brief "$T/ab-cut-a.out" 200)"; fi

# ── Esta prueba viaja en la copia pública: no puede traer escrita una ruta con forma de carpeta de usuario ─────────────
# (story 8.26, tanda H1c: dos rutas de ejemplo de ese tipo hacían que el detector de publicación las leyera como la ruta
# de la máquina de alguien y frenara la copia entera; el pre-commit no lo ve, lo veía recién la validación de la rama).
# El patrón se arma por pedazos para que esta línea no se encuentre a sí misma.
USER_DIR_SHAPES="$(printf '%s|%s|%s|%s' 'C:[\\/]+Us''ers[\\/]' '/c/Us''ers/' '/Us''ers/[A-Za-z]' '/ho''me/[a-z]')"
if grep -nE "$USER_DIR_SHAPES" "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
  no "T79 la prueba trae escrita una ruta con forma de carpeta de usuario: el detector de publicación la frena (líneas: $(grep -nE "$USER_DIR_SHAPES" "${BASH_SOURCE[0]}" | cut -d: -f1 | tr '\n' ' '))"
else
  ok "T79 la prueba no trae escrita ninguna ruta con forma de carpeta de usuario (viaja en la copia pública)"
fi
fi   # ── fin de la parte 2 ──

echo
[ -z "${ELAPSED_INSTALL:-}" ] || echo "ℹ installer-ps1: una instalación entera del .ps1 con pwsh tardó ${ELAPSED_INSTALL} s"   # (la mide (b), en la parte 1)
if [ "$FAILURES" -gt 0 ]; then echo "❌ installer-ps1: $FAILURES de $TOTAL en rojo"; exit 1; fi
echo "✅ installer-ps1: todo verde ($TOTAL chequeos)"; exit 0
