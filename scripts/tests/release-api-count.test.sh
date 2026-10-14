#!/usr/bin/env bash
# release-api-count.test.sh — cuántas consultas a la API de GitHub gasta cada operación de una versión bajada (story 8.34).
#
# Sin permiso guardado, la API de GitHub tiene un tope de 60 consultas por hora POR CONEXIÓN, aunque el repo sea público:
# dos máquinas que comparten conexión se quedaban sin consultas. Desde la 8.34, sin permiso el arnés mira por `info/refs`
# (lo que lee `git ls-remote`, sin el programa git) y el número por el raw de cada commit, y baja por codeload. A la API le
# queda UNA consulta por bajada (`git/commits/<sha>`, el árbol con el que se verifica: decisión D1 = A del dueño).
#
# Lo que no se puede perder:
#   T2  · ApiCount_PerOperation — sin permiso: mirar sin novedad 0 · mirar con versión nueva 0 · bajar 1 (+0 por terceros) ·
#         instalar 1 · `migrate --to-home` 1.
#   T3  · Check_SameTip_NoRawRequest — dos miradas seguidas sin publicar nada: la segunda pide sólo `info/refs`.
#   T4  · Check_LatestChannel_OneRefsRequest — canal latest: las dos ramas salen de UN `info/refs`; las notas de hoy.
#   T5  · NoGitOnPath_ChecksAndUpdates — con un `git` testigo en el PATH: mira y actualiza sin invocarlo nunca.
#   T6  · Fallback_GithubDown_UsesApi_404DoesNot — `info/refs` sin red o ilegible → la API, anotado; 401/404 → no cae;
#         raw caído → una consulta (ese version.json).
#   T7  · Download_Codeload_NoAuthHeader — la bajada y los terceros por codeload `tar.gz`, sin Authorization.
#   T8  · Verify_TamperedOrWrongCommit_Refused — comprimido cambiado o cortado: nada instalado, el motivo dicho.
#   T9  · Verify_VersionJsonMatchesRaw — el raw dice un número y el árbol otro: no se instala, y lo dice.
#   T10 · WithToken_SameApiRequestsAsBaseline — con permiso: los pedidos a la API, pedido por pedido, iguales a la línea de
#         base grabada sobre el código anterior a la 8.34 (`--record-baseline` la graba; fixtures/release-api-baseline-token.txt).
#   T11 · RateLimit_WaitsUntilReset_NotAFailure — con la API agotada: el aviso en el primer arranque y no en los dos
#         siguientes, ningún pedido a la API antes de la hora, sin «no se pudo actualizar»; pasada la hora, se baja.
#   T12 · RateLimit_ManualUpdate_TriesOnce — `update` a mano durante la espera: un pedido, sale 2, la hora, sin «5000».
#   T13 · Toy_Anonymous304Charges — el juguete: un 304 sin credencial gasta; con credencial, no.
#   T18 · InstallVersion_ApiWithLimitText — `install --version <n>` sin permiso con la API agotada: el tope y su hora.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (la máquina sin arnés + el GitHub de juguete con sus cuatro escuchas:
# api, git, raw y codeload). Nunca ~/.claude ni el checkout real. 🔴 Sin pipes sobre el comando medido.
#
# Partida en dos (scripts/tests/lib/suite-parts.sh: ninguna suite pasa de 45 s): release-api-count.p1/.p2.test.sh.
# Uso: bash scripts/tests/release-api-count.test.sh [--only T2|T3|…] [--record-baseline]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$RAIZ/scripts/tests/lib/suite-parts.sh"
suite_parts 2
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
ONLY=""; RECORD=0
while [ $# -gt 0 ]; do
  case "$1" in --only) ONLY="${2:-}"; shift 2 ;; --record-baseline) RECORD=1; shift ;; *) shift ;; esac
done
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
case "$BASE" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ release-api-count: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
BASELINE="$RAIZ/scripts/tests/fixtures/release-api-baseline-token.txt"
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
TYCON_DIR() { printf '%s' "$LAB_HOME/.tycon"; }
# los pedidos del registro del juguete a un host (api | git | raw | codeload) que matchean un patrón (vacío: todos)
pedidos() { local n; n="$(grep -- "\"host\":\"$1\"" "$LAB_RELEASE_LOG" 2>/dev/null | grep -c -- "${2:-}")"; printf '%s' "${n:-0}"; }
api() { pedidos api "${1:-}"; }
limpia() { : > "$LAB_RELEASE_LOG"; }
# los pedidos a la API, normalizados (método y ruta, los sha y las llaves tapados): lo que se compara contra la línea de base
api_seq() {
  python3 - "$LAB_RELEASE_LOG" <<'PY'
import json, re, sys
for line in open(sys.argv[1], encoding='utf-8'):
    try: o = json.loads(line)
    except Exception: continue
    if o.get('host') != 'api': continue
    p = re.sub(r'[0-9a-f]{40}', '<sha>', o.get('path', ''))
    p = re.sub(r'(token=)[^&]*', r'\1<llave>', p)
    print(f"{o.get('method')} {p}")
PY
}
# el estado con la última mirada (y el último intento) una hora atrás: el arranque siguiente vuelve a mirar
envejece() {
  python3 - "$(ESTADO)" <<'PY'
import json, sys, datetime
f = sys.argv[1]; d = json.load(open(f, encoding='utf-8'))
old = (datetime.datetime.utcnow() - datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
for k in ('last_fetch', 'last_fetch_failed'):
    if d.get(k): d[k] = old
json.dump(d, open(f, 'w', encoding='utf-8'), indent=2)
PY
}
# instala la versión `latest` (o un número) en una HOME fresca; deja INSTALL_OUT y INSTALL_RC
instala() {
  harness_lab_release_fresh_home
  INSTALL_OUT="$(harness install --version "${1:-latest}" --yes 2>&1)"; INSTALL_RC=$?
}
# una máquina con la 2026.10.07.1 instalada sin permiso
maquina() {
  harness_lab_create "$1"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  instala 2026.10.07.1
  [ "$INSTALL_RC" = 0 ] || mal "la instalación de partida salió $INSTALL_RC: $INSTALL_OUT"
}

if suite_part 1; then   # ── parte 1 de 2 ──
# ───────────────────────────────────────────── T13 ────────────────────────────────────────────
if corre T13; then
  echo "T13 · el juguete: un 304 sin credencial gasta cuota; con credencial, no"
  harness_lab_create "$BASE/lab13"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  ref="$LAB_RELEASE_API/repos/$LAB_RELEASE_ORG/$LAB_RELEASE_NAME/git/ref/heads/main"
  quedan() { curl -s -D - -o /dev/null "$@" "$ref" | tr -d '\r' | sed -n 's/^[Xx]-[Rr]ate[Ll]imit-[Rr]emaining: //p'; }
  etag="$(curl -s -D - -o /dev/null "$ref" | tr -d '\r' | sed -n 's/^[Ee][Tt]ag: //p')"
  a="$(quedan)"; b="$(quedan -H "If-None-Match: $etag")"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$ref")"
  [ "$code" = 304 ] && ok "If-None-Match igual: 304" || mal "If-None-Match: $code"
  [ -n "$a" ] && [ -n "$b" ] && [ "$b" -lt "$a" ] && ok "sin credencial, el 304 bajó la cuota ($a → $b)" || mal "sin credencial el 304 no gastó: $a → $b"
  harness_lab_release_control '{ "auth": "token:la-del-juguete" }'
  a="$(quedan -H 'Authorization: token la-del-juguete' -H "If-None-Match: $etag")"
  b="$(quedan -H 'Authorization: token la-del-juguete' -H "If-None-Match: $etag")"
  [ -n "$a" ] && [ "$a" = "$b" ] && ok "con credencial, el 304 no gasta ($a → $b)" || mal "con credencial el 304 gastó: $a → $b"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T2 · T3 · T5 · T7 ─────────────────────────────
if corre T2 || corre T3 || corre T5 || corre T7; then
  echo "T2 · T3 · T5 · T7 · sin permiso: mirar 0 consultas, bajar 1, terceros 0, sin git, codeload sin credencial"
  harness_lab_create "$BASE/lab2"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  harness_lab_git_witness
  : > "$LAB_GIT_WITNESS_LOG"
  limpia
  instala latest
  [ "$INSTALL_RC" = 0 ] && ok "install latest sin permiso sale 0" || mal "install latest salió $INSTALL_RC: $INSTALL_OUT"
  [ "$(api)" = 1 ] && ok "install latest: 1 consulta a la API (el árbol del commit)" || mal "install latest gastó $(api) consultas: $(api_seq | tr '\n' ' ')"
  [ "$(api 'git/commits/')" = 1 ] && ok "…y es git/commits/<sha>" || mal "la consulta no es git/commits: $(api_seq | tr '\n' ' ')"
  [ "$(pedidos git 'info/refs')" -ge 1 ] && ok "miró por info/refs" || mal "no pidió info/refs: $(harness_lab_release_log)"
  [ "$(pedidos codeload "/$LAB_RELEASE_ORG/$LAB_RELEASE_NAME/tar.gz/")" = 1 ] && ok "bajó por codeload tar.gz" || mal "no bajó por codeload tar.gz: $(harness_lab_release_log)"
  [ "$(grep -c '"auth":true' "$LAB_RELEASE_LOG")" = 0 ] && ok "ningún pedido llevó credencial" || mal "algún pedido llevó credencial"

  # T3: al día, dos veces: la primera 1 info/refs y 0 raw; la segunda, lo mismo
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "al día: --check sale 0 ($out)" || mal "al día: --check salió $rc: $out"
  [ "$(api)" = 0 ] && ok "mirar sin novedad: 0 consultas a la API" || mal "mirar sin novedad gastó $(api): $(api_seq | tr '\n' ' ')"
  [ "$(pedidos git 'info/refs')" = 1 ] && [ "$(pedidos raw)" = 0 ] && ok "un info/refs y ningún raw" || mal "info/refs $(pedidos git 'info/refs'), raw $(pedidos raw)"
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ "$(pedidos git 'info/refs')" = 1 ] && [ "$(pedidos raw)" = 0 ] && [ "$(api)" = 0 ] && ok "T3: la segunda mirada pide sólo info/refs" || mal "T3: rc $rc, info/refs $(pedidos git 'info/refs'), raw $(pedidos raw), api $(api)"

  # versión nueva: 0 API, 1 raw; la segunda mirada con la misma punta ya no pide el raw
  harness_lab_publish_stable 2026.10.07.2
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "versión nueva: --check sale 3" || mal "versión nueva: --check salió $rc: $out"
  case "$out" in *2026.10.07.2*) ok "dice 2026.10.07.2" ;; *) mal "no dice el número: $out" ;; esac
  [ "$(api)" = 0 ] && ok "mirar con versión nueva: 0 consultas a la API" || mal "mirar con novedad gastó $(api): $(api_seq | tr '\n' ' ')"
  [ "$(pedidos raw '/version.json')" = 1 ] && ok "el número, del raw por commit" || mal "raw: $(pedidos raw)"
  [ "$(pedidos raw '/main/')" = 0 ] && ok "nunca el raw por rama" || mal "pidió el raw por rama"
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && [ "$(pedidos raw)" = 0 ] && [ "$(api)" = 0 ] && ok "T3: la misma punta otra vez: sin raw" || mal "T3 punta nueva repetida: rc $rc, raw $(pedidos raw), api $(api)"

  # bajar: 1 consulta; con un origen de terceros (del mismo repo), 0 más, por codeload
  tp_commit="$(harness_lab_remote_head main)"
  tp_tree="$(harness_lab_git "$LAB_REMOTE_TREE" rev-parse "$tp_commit:skills/tycon-pipeline")"
  manifest="{ \"retirement\": \"done\", \"third_party\": [ { \"name\": \"lab-third\", \"install\": \"download\", \"origin\": \"https://github.com/$LAB_RELEASE_ORG/$LAB_RELEASE_NAME\", \"commit\": \"$tp_commit\", \"path\": \"skills/tycon-pipeline\", \"tree\": \"$tp_tree\", \"target\": \"skills/lab-third\", \"license\": \"MIT\" } ] }"
  harness_lab_publish_stable 2026.10.07.3 scripts/publishing/third-party-skills.json "$manifest"
  : > "$LAB_GIT_WITNESS_LOG"
  limpia
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "update --yes sin permiso aplica" || mal "update --yes salió $rc: $out"
  [ "$(estado "d['version']['number']")" = 2026.10.07.3 ] && ok "quedó la 2026.10.07.3" || mal "quedó $(estado "d['version']['number']")"
  [ -f "$(TYCON_DIR)/harness/skills/lab-third/SKILL.md" ] && ok "T7: la skill de terceros quedó, verificada" || mal "falta skills/lab-third: $out"
  [ "$(api)" = 1 ] && ok "bajar con terceros: 1 consulta a la API" || mal "bajar gastó $(api): $(api_seq | tr '\n' ' ')"
  [ "$(api tarball)" = 0 ] && ok "T7: ningún tarball por la API" || mal "pidió tarball a la API"
  [ "$(pedidos codeload "tar.gz/$tp_commit")" = 1 ] && ok "T7: los terceros, por codeload tar.gz" || mal "terceros: $(harness_lab_release_log)"
  [ "$(grep '"host":"codeload"' "$LAB_RELEASE_LOG" | grep -c '"auth":true')" = 0 ] && ok "T7: codeload sin Authorization" || mal "la credencial viajó a codeload"
  [ ! -s "$LAB_GIT_WITNESS_LOG" ] && ok "T5: git no se invocó al mirar ni al actualizar" || mal "T5: git se invocó: $(head -3 "$LAB_GIT_WITNESS_LOG")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T4 ─────────────────────────────────────────────
if corre T4; then
  echo "T4 · canal latest: las dos ramas de UN info/refs, y las notas de hoy"
  maquina "$BASE/lab4"
  harness_lab_publish_stable 2026.10.07.2
  harness_release channel latest >/dev/null 2>&1
  harness_lab_publish_sync 2026.10.07.5
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "mirror/sync mayor: 3" || mal "latest mayor: salió $rc: $out"
  case "$out" in *2026.10.07.5*) ok "dice 2026.10.07.5" ;; *) mal "no dice 2026.10.07.5: $out" ;; esac
  [ "$(pedidos git 'info/refs')" = 1 ] && [ "$(api)" = 0 ] && ok "un solo info/refs, 0 API" || mal "info/refs $(pedidos git 'info/refs'), api $(api)"
  harness_lab_publish_sync 2026.10.07.1
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "mirror/sync menor: lee main (3 por la 2026.10.07.2)" || mal "latest menor: salió $rc: $out"
  case "$out" in *"latest lee main"*) ok "dice que latest lee main" ;; *) mal "no lo dice: $out" ;; esac
  [ "$(pedidos git 'info/refs')" = 1 ] && [ "$(api)" = 0 ] && ok "un solo info/refs, 0 API" || mal "info/refs $(pedidos git 'info/refs'), api $(api)"
  harness_lab_delete_sync
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "sin mirror/sync: lee main" || mal "sin sync: salió $rc: $out"
  case "$out" in *"no tiene mirror/sync"*) ok "dice que el remoto no tiene mirror/sync" ;; *) mal "no lo dice: $out" ;; esac
  [ "$(api)" = 0 ] && ok "0 API" || mal "api $(api)"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T6 ─────────────────────────────────────────────
if corre T6; then
  echo "T6 · el respaldo: info/refs sin red o ilegible → la API, anotado; 401 → no cae; raw caído → una consulta"
  maquina "$BASE/lab6"
  harness_lab_publish_stable 2026.10.07.2
  LOGF="$LAB_HOME/.claude/.tycon-pipeline/harness/startup.log"
  limpia
  out="$(TYCON_RELEASE_GIT=http://127.0.0.1:9 harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "github.com sin contestar: mira por la API (3)" || mal "git caído: salió $rc: $out"
  [ "$(api 'git/ref/heads/main')" -ge 1 ] && ok "…con la ref de la API" || mal "no cayó a la API: $(api_seq | tr '\n' ' ')"
  grep -q "por la API" "$LOGF" 2>/dev/null && ok "…y lo anotó en el registro" || mal "el registro no dice que miró por la API: $(tail -3 "$LOGF" 2>/dev/null)"
  harness_lab_release_control '{ "auth": "none", "git_garbage": true }'
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && [ "$(api 'git/ref/heads/main')" -ge 1 ] && ok "info/refs ilegible: cae a la API (3)" || mal "ilegible: rc $rc, api $(api_seq | tr '\n' ' '): $out"
  harness_lab_release_control '{ "auth": "none", "git_down": true }'
  limpia
  out="$(TYCON_UPDATE_NETWORK_BUDGET_S=6 harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && [ "$(api 'git/ref/heads/main')" -ge 1 ] && ok "info/refs que no contesta: cae a la API (3)" || mal "git mudo: rc $rc, api $(api_seq | tr '\n' ' '): $out"
  # un repo que no se ve (privado, sin permiso): GitHub contesta 401 a info/refs; no cae a la API
  harness_lab_release_control '{ "auth": "token:la-buena" }'
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "repo que no se ve: --check sale 2" || mal "repo privado: salió $rc: $out"
  case "$out" in *"config set github.token"*) ok "…con la acción de hoy (pegar un permiso)" ;; *) mal "sin la acción: $out" ;; esac
  [ "$(api)" = 0 ] && ok "…y no cayó a la API" || mal "cayó a la API: $(api_seq | tr '\n' ' ')"
  # el raw caído: ese único version.json por la API
  harness_lab_release_control '{ "auth": "none", "raw_down": true }'
  limpia
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "raw caído: igual 3" || mal "raw caído: salió $rc: $out"
  [ "$(api)" = 1 ] && [ "$(api 'contents/version.json')" = 1 ] && ok "…con UNA consulta: ese version.json" || mal "raw caído gastó: $(api_seq | tr '\n' ' ')"
  # el raw contesta otra cosa que el version.json (la página de un proxy que filtra, con 200 o con 404), o no contesta:
  # también es «raw caído» → ese único version.json por la API, dentro del tope (pase adversarial de la story 8.34)
  # (cada caso con una punta NUEVA: el número de una punta ya vista queda guardado y no se vuelve a pedir)
  v=3
  for bloqueo in 200 404; do
    harness_lab_publish_stable "2026.10.07.$v"; v=$((v + 1))
    harness_lab_release_control "{ \"auth\": \"none\", \"raw_block\": $bloqueo }"
    limpia
    out="$(harness_release update --check 2>&1)"; rc=$?
    [ "$rc" = 3 ] && [ "$(api 'contents/version.json')" = 1 ] && ok "raw con una página de proxy ($bloqueo): cae a la API (3, una consulta)" || mal "raw con página de proxy $bloqueo: rc $rc, api $(api_seq | tr '\n' ' '): $out"
  done
  harness_lab_release_control '{ "auth": "none" }'
  harness_lab_publish_stable "2026.10.07.$v"
  limpia
  t0=$(date +%s)
  out="$(TYCON_RELEASE_RAW="$LAB_RELEASE_MUTE_PROXY" TYCON_UPDATE_NETWORK_BUDGET_S=8 harness_release update --check 2>&1)"; rc=$?
  t1=$(date +%s)
  [ "$rc" = 3 ] && [ "$(api 'contents/version.json')" = 1 ] && ok "raw que no contesta: al respaldo le queda reloj (3, una consulta, $((t1 - t0)) s)" || mal "raw mudo: rc $rc en $((t1 - t0)) s, api $(api_seq | tr '\n' ' '): $out"
  harness_lab_release_control '{ "auth": "none" }'
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

fi   # ── fin de la parte 1 ──

if suite_part 2; then   # ── parte 2 de 2 ──
# ───────────────────────────────────────────── T8 · T9 ────────────────────────────────────────
if corre T8 || corre T9; then
  echo "T8 · T9 · la verificación: comprimido cambiado o cortado, y el número del raw contra el del árbol"
  maquina "$BASE/lab8"
  harness_lab_publish_stable 2026.10.07.2
  for modo in tamper truncate; do
    harness_lab_release_control "{ \"auth\": \"none\", \"$modo\": true }"
    out="$(harness_release update --yes 2>&1)"; rc=$?
    [ "$rc" != 0 ] && ok "T8 $modo: no aplica (sale $rc)" || mal "T8 $modo: aplicó"
    [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "T8 $modo: sigue la 2026.10.07.1" || mal "T8 $modo: quedó $(estado "d['version']['number']")"
    case "$out" in *"no coincide"*|*"no se instala"*) ok "T8 $modo: dice el motivo" ;; *) mal "T8 $modo: sin motivo: $out" ;; esac
    [ -z "$(ls "$(TYCON_DIR)/incoming" 2>/dev/null)" ] && ok "T8 $modo: nada en incoming/" || mal "T8 $modo: quedó incoming/: $(ls "$(TYCON_DIR)/incoming")"
  done
  # (una punta NUEVA: la de la 2026.10.07.2 ya quedó vista —y su número guardado— en las vueltas de arriba)
  harness_lab_publish_stable 2026.10.07.3
  harness_lab_release_control '{ "auth": "none", "raw_version": "2026.10.07.9" }'
  out="$(harness_release update --yes 2>&1)"; rc=$?
  [ "$rc" != 0 ] && ok "T9: el raw dice otro número que el árbol: no aplica (sale $rc)" || mal "T9: aplicó"
  [ "$(estado "d['version']['number']")" = 2026.10.07.1 ] && ok "T9: sigue la 2026.10.07.1" || mal "T9: quedó $(estado "d['version']['number']")"
  case "$out" in *2026.10.07.9*2026.10.07.3*|*2026.10.07.3*2026.10.07.9*) ok "T9: dice los dos números" ;; *) mal "T9: no dice los dos números: $out" ;; esac
  [ -z "$(ls "$(TYCON_DIR)/incoming" 2>/dev/null)" ] && ok "T9: nada en incoming/" || mal "T9: quedó incoming/"
  harness_lab_release_control '{ "auth": "none" }'
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T11 · T12 ──────────────────────────────────────
if corre T11 || corre T12; then
  echo "T11 · T12 · el tope de la API: esperar hasta la hora, avisar una vez, no contarlo como fallo; update a mano intenta una vez"
  maquina "$BASE/lab11"
  harness_lab_publish_stable 2026.10.07.2
  reset=$(( $(date +%s) + 3600 ))
  hora="$(python3 -c "import time,sys; print(time.strftime('%H:%M', time.localtime(int(sys.argv[1]))))" "$reset")"
  harness_lab_release_control "{ \"auth\": \"none\", \"ratelimit\": true, \"ratelimit_reset\": $reset }"
  envejece
  limpia
  out="$(harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "primer arranque: sale 0" || mal "primer arranque salió $rc"
  [ "$(api)" = 1 ] && ok "primer arranque: UNA consulta (la que contestó el tope)" || mal "primer arranque: $(api) consultas: $(api_seq | tr '\n' ' ')"
  [ -n "$(estado "d.get('api_limited_until') or ''")" ] && ok "el estado guarda api_limited_until" || mal "sin api_limited_until: $(harness_lab_state)"
  aviso="$(estado "d.get('notice') or ''")"
  case "$aviso" in *2026.10.07.2*"$hora"*"No hace falta hacer nada"*) ok "el aviso: la versión, la hora local ($hora) y que no hace falta nada" ;; *) mal "el aviso no es el esperado: «${aviso}» · salida: $out" ;; esac
  case "$aviso$out" in *5000*) mal "el texto dice «5000»" ;; *) ok "sin «5000»" ;; esac
  for n in 2 3; do
    envejece
    limpia
    out="$(harness_release startup 2>&1)"; rc=$?
    [ "$(api)" = 0 ] && ok "arranque $n: 0 consultas a la API" || mal "arranque $n: $(api) consultas: $(api_seq | tr '\n' ' ')"
    [ "$(pedidos git 'info/refs')" -ge 1 ] && ok "arranque $n: sigue mirando por info/refs" || mal "arranque $n: no miró"
    case "$(estado "d.get('notice') or ''")$out" in *"$hora"*) mal "arranque $n: repite el aviso" ;; *) ok "arranque $n: no repite el aviso" ;; esac
  done
  case "$(harness_release doctor 2>&1)" in *"$hora"*) ok "doctor dice la espera y su hora" ;; *) mal "doctor no dice la espera" ;; esac
  [ ! -s "$LAB_HOME/.claude/.tycon-pipeline/harness/update-failure.json" ] && ok "la espera no cuenta como fallo" || mal "contó la espera como fallo: $(cat "$LAB_HOME/.claude/.tycon-pipeline/harness/update-failure.json")"
  case "$(harness_release startup 2>&1)" in *"no se pudo actualizar"*) mal "dice «no se pudo actualizar»" ;; *) ok "sin «no se pudo actualizar»" ;; esac

  # T12: update a mano durante la espera: intenta una vez y sale 2 con el mismo texto
  if corre T12 || [ -z "$ONLY" ]; then
    limpia
    out="$(harness_release update --yes 2>&1)"; rc=$?
    [ "$rc" = 2 ] && ok "T12: update a mano en la espera sale 2" || mal "T12: salió $rc: $out"
    [ "$(api)" = 1 ] && ok "T12: intentó una vez (1 consulta)" || mal "T12: $(api) consultas: $(api_seq | tr '\n' ' ')"
    case "$out" in *"$hora"*) ok "T12: dice la hora" ;; *) mal "T12: sin la hora: $out" ;; esac
    case "$out" in *5000*) mal "T12: dice «5000»: $out" ;; *) ok "T12: sin «5000»" ;; esac
  fi

  # pasada la hora: el primer arranque baja la versión
  python3 - "$(ESTADO)" <<'PY'
import json, sys
f = sys.argv[1]; d = json.load(open(f, encoding='utf-8'))
d['api_limited_until'] = '2020-01-01T00:00:00.000Z'
json.dump(d, open(f, 'w', encoding='utf-8'), indent=2)
PY
  harness_lab_release_control '{ "auth": "none" }'
  out="$(harness_release startup 2>&1)"; rc=$?
  [ "$(estado "d['version']['number']")" = 2026.10.07.2 ] && ok "pasada la hora, el primer arranque baja la 2026.10.07.2" || mal "pasada la hora no bajó: $(estado "d['version']['number']") · $out"
  [ -z "$(estado "d.get('api_limited_until') or ''")" ] && ok "y la espera se borra" || mal "la espera sigue: $(estado "d.get('api_limited_until')")"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T11 (sin versión esperando) ────────────────────
if corre T11; then
  echo "T11 · una espera del tope sin ninguna versión esperando no deja a doctor diciendo «se baja sola»"
  maquina "$BASE/lab11b"
  python3 - "$(ESTADO)" <<'PY'
import json, sys, datetime
f = sys.argv[1]; d = json.load(open(f, encoding='utf-8'))
d['api_limited_until'] = (datetime.datetime.utcnow() + datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
d['last_fetch'] = None; d['last_fetch_failed'] = None
json.dump(d, open(f, 'w', encoding='utf-8'), indent=2)
PY
  out="$(harness_release startup 2>&1)"
  [ -z "$(estado "d.get('api_limited_until') or ''")" ] && ok "al día: la espera se borra" || mal "al día y la espera sigue: $(estado "d.get('api_limited_until')")"
  case "$(harness_release doctor 2>&1)" in *"se baja sola"*) mal "doctor sigue diciendo que una versión se baja sola" ;; *) ok "doctor no anuncia una versión que no hay" ;; esac
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T18 ────────────────────────────────────────────
if corre T18; then
  echo "T18 · install --version <n> sin permiso con la API agotada: sigue por la API y dice el tope y su hora"
  harness_lab_create "$BASE/lab18"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.07.1
  reset=$(( $(date +%s) + 1800 ))
  hora="$(python3 -c "import time,sys; print(time.strftime('%H:%M', time.localtime(int(sys.argv[1]))))" "$reset")"
  harness_lab_release_control "{ \"auth\": \"none\", \"ratelimit\": true, \"ratelimit_reset\": $reset }"
  instala 2026.10.07.1
  [ "$INSTALL_RC" = 2 ] && ok "sale 2" || mal "salió $INSTALL_RC: $INSTALL_OUT"
  case "$INSTALL_OUT" in *"$hora"*) ok "dice la hora ($hora)" ;; *) mal "sin la hora: $INSTALL_OUT" ;; esac
  case "$INSTALL_OUT" in *5000*) mal "dice «5000»" ;; *) ok "sin «5000»" ;; esac
  [ ! -d "$(TYCON_DIR)/harness" ] && ok "no instaló nada" || mal "dejó ~/.tycon/harness"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi

# ───────────────────────────────────────────── T2 (mudanza) · T10 ─────────────────────────────
if corre T2 || corre T10; then
  echo "T2 · T10 · migrate --to-home sin permiso: lo de una bajada · con permiso: los pedidos a la API iguales a la línea de base"
  # sin permiso: la máquina instalada desde el clon se muda; gasta lo de una bajada (1) y nada para mirar
  harness_lab_create "$BASE/lab2m"
  harness_lab_release_server
  harness_lab_publish_stable 2026.10.08.1
  harness install --yes >"$BASE/lab2m/install.out" 2>&1 || mal "la instalación desde el clon falló: $(tail -3 "$BASE/lab2m/install.out" | tr '\n' ' ')"
  limpia
  out="$(harness migrate --to-home 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "migrate --to-home sin permiso sale 0" || mal "migrate salió $rc: $out"
  [ "$(api)" = 1 ] && ok "migrate --to-home: 1 consulta a la API" || mal "migrate gastó $(api): $(api_seq | tr '\n' ' ')"
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null

  # con permiso: la misma secuencia de operaciones; la API pedido por pedido
  harness_lab_create "$BASE/lab10"
  harness_lab_release_server
  harness_lab_release_control '{ "auth": "token:permiso-del-laboratorio" }'
  harness_lab_publish_stable 2026.10.08.1
  printf 'permiso-del-laboratorio' | harness config set github.token >/dev/null 2>&1
  SEQ="$BASE/seq.txt"; : > "$SEQ"
  paso() { printf '## %s\n' "$1" >> "$SEQ"; api_seq >> "$SEQ"; limpia; }
  limpia
  harness install --yes >/dev/null 2>&1;               paso "install desde el clon"
  harness migrate --to-home >/dev/null 2>&1;           paso "migrate --to-home"
  harness_release update --check >/dev/null 2>&1;      paso "update --check al día"
  harness_release update --check >/dev/null 2>&1;      paso "update --check al día, otra vez"
  harness_lab_publish_stable 2026.10.08.2
  harness_release update --check >/dev/null 2>&1;      paso "update --check con versión nueva"
  harness_release update --yes >/dev/null 2>&1;        paso "update --yes"
  harness_lab_release_fresh_home
  printf 'permiso-del-laboratorio' | harness config set github.token >/dev/null 2>&1
  limpia
  harness install --version latest --yes >/dev/null 2>&1;      paso "install --version latest"
  harness_lab_release_fresh_home
  printf 'permiso-del-laboratorio' | harness config set github.token >/dev/null 2>&1
  limpia
  harness install --version 2026.10.08.1 --yes >/dev/null 2>&1; paso "install --version 2026.10.08.1"
  if [ "$RECORD" = 1 ]; then
    cp "$SEQ" "$BASELINE" && ok "línea de base grabada en $BASELINE ($(grep -vc '^##' "$SEQ") pedidos)"
  elif [ ! -f "$BASELINE" ]; then
    mal "falta la línea de base $BASELINE (se graba con --record-baseline sobre el código anterior a la 8.34)"
  elif diff -u "$BASELINE" "$SEQ" >"$BASE/seq.diff"; then
    ok "con permiso, los pedidos a la API son los de la línea de base ($(grep -vc '^##' "$SEQ") pedidos, pedido por pedido)"
  else
    mal "con permiso, los pedidos a la API cambiaron: $(head -30 "$BASE/seq.diff")"
  fi
  kill "$LAB_RELEASE_PROCESS" 2>/dev/null
fi
fi   # ── fin de la parte 2 ──

if [ "$FALLOS" -gt 0 ]; then echo "❌ release-api-count: $FALLOS falla(s)"; exit 1; fi
echo "✅ release-api-count: todo en verde"
