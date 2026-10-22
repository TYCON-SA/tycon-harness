#!/usr/bin/env bash
# config-shell-consumers.test.sh — los consumidores de shell y python del lector de configuración del
# arnés, corridos de verdad.
#
# Qué defiende, MIDIENDO y no leyendo: `scripts/ci/validate-pipeline-in-ado.sh` resuelve las dos
# variables de la organización en el MISMO orden que el lector (con las dos definidas y distintas consulta
# la organización que muestra `tycon-config.js explain`), y `integrations/instincts/scripts/instinct-observe.js`
# expande una `~` literal en TYCON_REPOS_ROOT (si no, atribuye la observación al último nombre de
# carpeta del cwd en vez de al repo). Un consumidor que lee la misma variable que el lector tiene que llegar
# al MISMO valor: si no, «una sola cadena, siempre la misma» es mentira en ese consumidor.
#
# Cómo corre: sin red. Un `curl` de mentira anota la URL que le pidieron y contesta como Azure; la grabadora
# de instintos escribe su JSONL en un temporal. 🔴 Nada acá toca el HOME real: HOME temporal, PATH con los dobles adelante,
# TYCON_PROFILE=0 (el perfil del equipo no entra en juego).
# 🔴 Sin pipes sobre el comando medido: el exit code REAL es el veredicto.
set -u
TCG="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALIDAR="$TCG/scripts/ci/validate-pipeline-in-ado.sh"
OBSERVE="$TCG/integrations/instincts/scripts/instinct-observe.js"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/config-consumidores.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
FALLAS=0
ok() { echo "✅ config-consumidores: $1"; }
bad() { echo "❌ config-consumidores: $1"; FALLAS=$((FALLAS + 1)); }

# un curl de mentira: anota lo que le pidieron y contesta como Azure cuando el pipeline es válido
mkdir -p "$BASE/bin" "$BASE/home/.claude"
LOG="$BASE/curl.log"
cat > "$BASE/bin/curl" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "$LOG"
echo '{"finalYaml":"stages: []"}'
SH
chmod +x "$BASE/bin/curl"
# EXTRA_ENV nunca queda vacío: bash 3.2 (macOS) trata "${vacio[@]}" con set -u como variable sin definir
EXTRA_ENV=(TYCON_NOTHING_SET=1)
correr() { # $@ = argumentos del script; HOME temporal, PATH con el curl de mentira, sin perfil del equipo
  env -i PATH="$BASE/bin:$PATH" HOME="$BASE/home" AZURE_DEVOPS_EXT_PAT=de-mentira TYCON_PROFILE=0 "${EXTRA_ENV[@]}" bash "$VALIDAR" "$@"
}

# ── T1 · con las DOS variables definidas y distintas gana TYCON_ADO_ORG, como en el lector ──────────
: > "$LOG"
EXTRA_ENV=(TYCON_ADO_ORG=https://dev.azure.com/nueva ADO_ORG=https://dev.azure.com/vieja)
salida="$(correr --project Proy --pipeline 7 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'dev.azure.com/nueva/Proy/_apis/pipelines/7/runs' "$LOG" && ! grep -q 'dev.azure.com/vieja' "$LOG"; then
  ok "T1 con TYCON_ADO_ORG y ADO_ORG distintas, consulta la organización que dice el lector (TYCON_ADO_ORG)"
else bad "T1 consultó otra organización (rc=$rc) — curl: $(tr '\n' ' ' < "$LOG" | head -c 200) — $salida"; fi

# ── T1b · sólo ADO_ORG (la variable previa al lector) sigue valiendo ──────────────────
: > "$LOG"
EXTRA_ENV=(ADO_ORG=https://dev.azure.com/vieja)
correr --project Proy --pipeline 7 >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'dev.azure.com/vieja/Proy/' "$LOG"; then ok "T1b ADO_ORG sola sigue valiendo"
else bad "T1b ADO_ORG sola no valió (rc=$rc)"; fi

# ── T2 · sin variable y con ~/.claude/tycon.json ROTO: frena con archivo, clave y motivo (exit 2) ───
#         — no con «sin organización», que es lo que esta prueba prohíbe: un archivo roto no se lee como ausente
printf '{ "integrations": { "engram": "si" } }' > "$BASE/home/.claude/tycon.json"
EXTRA_ENV=(TYCON_NOTHING_SET=1)
salida="$(correr --project Proy --pipeline 7 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$salida" | grep -q 'tycon.json' && printf '%s' "$salida" | grep -q 'integrations.engram' \
   && ! printf '%s' "$salida" | grep -q 'sin organización'; then
  ok "T2 configuración rota: nombra el archivo y la clave, sale 2, y no la disfraza de «sin organización»"
else bad "T2 configuración rota mal reportada (rc=$rc): $salida"; fi
rm -f "$BASE/home/.claude/tycon.json"

# ── T3b · el lector no pudo contestar (sin node en el PATH): «no pude preguntar», exit 2 — nunca «apagado» ────────
#          (regla 5 del bloque ADO: un rc 127 dejaría ORG vacío y se leería como apagada, exit 0)
: > "$LOG"
SIN_NODE="$BASE/bin-sin-node"; mkdir -p "$SIN_NODE"; ln -sf "$BASE/bin/curl" "$SIN_NODE/curl"
for b in bash sh mktemp cat tr head rm sed grep dirname python3; do p="$(command -v "$b" 2>/dev/null)"; [ -n "$p" ] && ln -sf "$p" "$SIN_NODE/$b"; done
salida="$(env -i PATH="$SIN_NODE" HOME="$BASE/home" AZURE_DEVOPS_EXT_PAT=de-mentira TYCON_PROFILE=0 bash "$VALIDAR" --project Proy --pipeline 7 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$salida" | grep -qi 'no pude leer' && ! printf '%s' "$salida" | grep -qi 'apagad' && [ ! -s "$LOG" ]; then
  ok "T3b sin node el lector no contesta: sale 2 con «no pude leer», no «apagado», y no consulta nada"
else bad "T3b sin node (rc=$rc): $salida"; fi

# ── T3 · sin variable y sin nada configurado: Azure DevOps APAGADO — lo dice en una línea, sale 0 y no consulta ──
#         nada. Nunca «válido» ni «0».
: > "$LOG"
salida="$(correr --project Proy --pipeline 7 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$salida" | grep -qi 'Azure DevOps apagad' && [ ! -s "$LOG" ] \
   && ! printf '%s' "$salida" | grep -qiE 'válido|ninguno'; then
  ok "T3 Azure DevOps apagado: lo dice, sale 0 y no consulta nada"
else bad "T3 Azure DevOps apagado (rc=$rc): $salida"; fi

# ── T4 · instinct-observe.js: `~` en TYCON_REPOS_ROOT se expande — la observación es del repo ──────
mkdir -p "$BASE/home/Proyectos/miRepo/sub" "$BASE/obs"
printf '{"session_id":"abcdefgh","tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"%s"}' "$BASE/home/Proyectos/miRepo/sub" \
  | env -i PATH="$PATH" HOME="$BASE/home" TYCON_PROFILE=0 TYCON_INSTINCTS=1 TYCON_INSTINCT_OBS_DIR="$BASE/obs" \
      TYCON_REPOS_ROOT='~/Proyectos' node "$OBSERVE"
if cat "$BASE/obs"/*.jsonl 2>/dev/null | grep -q '"project":"miRepo"'; then
  ok "T4 instinct-observe.js: con TYCON_REPOS_ROOT='~/Proyectos' la observación se atribuye al repo (miRepo), no a «sub»"
else bad "T4 instinct-observe.js atribuyó mal la observación: $(cat "$BASE/obs"/*.jsonl 2>/dev/null | head -c 300)"; fi

# ── T5 · el resumen de integraciones del instalador PowerShell (reproducible con pwsh 7):
#         `$true -eq 'detect'` es True en PowerShell (convierte la cadena al tipo del operando izquierdo), así que TODA
#         integración prendida sale como «(detect)». Se ejecuta el bloque REAL del .ps1 (recortado entre sus dos marcas)
#         con un JSON de mentira. Sin pwsh en la máquina: NO MEDIDO, nunca verde.
PS1="$TCG/scripts/install-tycon-hooks.ps1"
if command -v pwsh >/dev/null 2>&1; then
  cat > "$BASE/resumen.ps1" <<'PS'
$src = Get-Content -Raw $args[0]
$ini = $src.IndexOf('$prend = @(); $apag = @()'); $fin = $src.IndexOf('Write-Host "tycon: integraciones', $ini)
if ($ini -lt 0 -or $fin -lt 0) { 'sin-bloque'; exit 3 }
$Integ = @{}
$j = $args[1] | ConvertFrom-Json
foreach ($p in $j.PSObject.Properties) { $Integ[$p.Name] = $p.Value }
Invoke-Expression $src.Substring($ini, $fin - $ini)
"prendidas: $sp | apagadas: $sa"
PS
  salida="$(pwsh -NoProfile -File "$BASE/resumen.ps1" "$PS1" '{"ado":true,"clockify":true,"engram":false,"codegraph":false,"mailbox":true,"codex":"detect","nightly":true,"telegram":false}' 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$salida" = "prendidas: ado clockify mailbox codex(detect) nightly | apagadas: engram codegraph telegram" ]; then
    ok "T5 el resumen del instalador PowerShell distingue prendida (true) de «detect» y de apagada"
  else bad "T5 resumen del .ps1 (rc=$rc): $salida"; fi
else
  echo "⏭ config-consumidores: T5 NO MEDIDO — sin pwsh en esta máquina no se ejecuta el bloque del instalador PowerShell"
fi

# ── T3 (re-entrada) · el lugar donde re-entra un hook del arnés: el .ps1 y el .sh dan el mismo ──────────────────────
#         Casos: (índices del arnés de cada elemento, None = ajeno ; el índice del que entra) → posición esperada.
#         Los dos instaladores llaman al MISMO aplicador, scripts/setup/apply-hooks.js:
#         «el .ps1 y el .sh dan el mismo» vale por construcción, y se prueba la función real del aplicador.
APPLY_JS="$TCG/scripts/setup/apply-hooks.js"
CASOS_LUGAR='[[[0,null,2],1,1],[[null,3,null],1,1],[[null,null],1,2],[[0,1,null,4],3,2],[[],5,0],[[4,5],1,0]]'
ESPERADO="$(node -e 'console.log(JSON.parse(process.argv[1]).map((c) => c[2]).join(" "))' "$CASOS_LUGAR")"
sal_sh="$(node -e 'const m = require(process.argv[1]); console.log(JSON.parse(process.argv[2]).map((c) => m.lugarCanonico(c[0], c[1])).join(" "))' "$APPLY_JS" "$CASOS_LUGAR" 2>&1)"
if [ "$sal_sh" = "$ESPERADO" ]; then ok "T3 el aplicador re-inserta en el lugar canónico ($sal_sh)"
else bad "T3 lugar canónico del aplicador: esperado [$ESPERADO] salió [$sal_sh]"; fi
# Quién es «del arnés» se decide por la INVOCACIÓN (la ruta entre comillas, completa), no por
# un pedazo del texto: «retro-pending.js» no es «pending.js», y un comando que sólo menciona la ruta no es ese hook.
cat > "$BASE/indice.js" <<'JS'
const m = require(process.argv[2]);
const t = (x) => (x === null ? 'None' : String(x));
const H = (command) => ({ command });
// Mac y Linux: por la ruta absoluta entre comillas (la regla del bloque de Python que había en el .sh)
const orden = new Map([['SessionStart\0/x/hooks/pending.js', 0], ['SessionStart\0/x/hooks/retro-pending.js', 1]]);
const px = (ev, c) => t(m.harnessIndexOf(ev, H(c), { windows: false, orden }));
const posix = [px('SessionStart', 'node "/x/hooks/retro-pending.js"'), px('SessionStart', 'node "/x/hooks/pending.js"'),
  px('SessionStart', 'bash -c "cat /x/hooks/pending.js; echo listo"'), px('Stop', 'node "/x/hooks/pending.js"')];
// Windows: por la ruta del guion en su repo, con cualquier raíz (la regla que tenía el .ps1 desde la W3a)
const ordenWin = [{ ev: 'SessionStart', repoPath: 'pending.js', idx: 0 }, { ev: 'SessionStart', repoPath: 'retro-pending.js', idx: 1 },
  { ev: 'PreToolUse', repoPath: 'guard-pre.sh', idx: 2 }, { ev: 'PreToolUse', repoPath: 'lab-skill/scripts/gate.js', idx: 3 }];
const wx = (ev, c) => t(m.harnessIndexOf(ev, H(c), { windows: true, ordenWin }));
const win1 = [wx('SessionStart', 'node "C:/a/hooks/retro-pending.js"'), wx('SessionStart', 'node "C:/a/hooks/pending.js"'),
  wx('SessionStart', 'bash -c "cat C:/a/hooks/pending.js; echo"')];
// story 8.17, W3a (T91): un .sh de la lista es del arnés igual que un .js — con la ruta de Windows y con la de Git Bash —;
// otro guion cuyo nombre termina igual, un comando que sólo lo menciona y el mismo guion en otro evento, no; y una ruta
// escrita con barras de Windows es la misma ruta. Desde la W4, también con la ruta absoluta del bash de Git.
const win2 = [wx('PreToolUse', 'bash "C:/a/hooks/guard-pre.sh"'), wx('PreToolUse', 'bash "/c/a/hooks/guard-pre.sh"'),
  wx('PreToolUse', 'bash "C:/a/hooks/other-guard-pre.sh"'), wx('PreToolUse', 'bash -c "cat C:/a/hooks/guard-pre.sh"'),
  wx('Stop', 'bash "C:/a/hooks/guard-pre.sh"'), wx('PreToolUse', 'node "C:\\a\\skills\\lab-skill\\scripts\\gate.js"'),
  wx('PreToolUse', '"C:/Program Files/Git/bin/bash.exe" "C:/a/hooks/guard-pre.sh"')];
console.log(`${posix.join(' ')}|${win1.join(' ')}|${win2.join(' ')}`);
JS
sal_ix="$(node "$BASE/indice.js" "$APPLY_JS" 2>&1)"
IFS='|' read -r ix_posix ix_win1 ix_win2 <<< "$sal_ix"
if [ "$ix_posix" = "1 0 None None" ]; then ok "T3 el aplicador (Mac y Linux) reconoce un hook del arnés por su invocación completa, no por un pedazo del texto"
else bad "T3 índice del arnés en Mac y Linux: esperado [1 0 None None] salió [$ix_posix]"; fi
if [ "$ix_win1" = "1 0 None" ]; then ok "T3 el aplicador (Windows) reconoce un hook del arnés por su invocación completa"
else bad "T3 índice del arnés en Windows: esperado [1 0 None] salió [$ix_win1]"; fi
if [ "$ix_win2" = "2 2 None None None 3 2" ]; then ok "T91 el orden canónico de Windows cuenta a un .sh del arnés (ruta de Windows, de Git Bash y con el bash de Git), y no a uno parecido ni a un comando que sólo lo menciona"
else bad "T91 índice del arnés en Windows con un .sh: esperado [2 2 None None None 3 2] salió [$ix_win2]"; fi
# …y el .ps1 ya no lleva su propia copia de esas reglas: llama al mismo aplicador, con la regla de Windows
if grep -q "apply-hooks.js" "$PS1" && grep -q "'--platform', 'windows'" "$PS1" && ! grep -q '# >>> lugar-canonico' "$PS1"; then
  ok "T3 el .ps1 llama al aplicador con --platform windows y no lleva una copia propia del orden canónico"
else bad "T3 el .ps1 no llama a apply-hooks.js con --platform windows, o todavía trae su propio bloque de orden canónico"; fi

[ "$FALLAS" -eq 0 ] && { echo "config-consumidores: todo verde"; exit 0; }
echo "config-consumidores: $FALLAS en rojo"; exit 1
