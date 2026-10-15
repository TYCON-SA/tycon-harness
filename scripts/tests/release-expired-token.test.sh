#!/usr/bin/env bash
# release-expired-token.test.sh — un permiso de GitHub guardado que venció no frena la actualización del repo público.
#
# El caso (2026-10-14, la máquina de un dev): cargó un permiso (`harness.js config set github.token`) para esquivar el tope
# de consultas; el permiso venció y el arnés dejó de actualizarse con «el permiso de GitHub guardado venció o se revocó
# (401). creá un permiso nuevo…». El repo del arnés es público: el permiso no hacía falta. Desde ahora, ante un 401 de un
# repo que se lee sin permiso, el arnés sigue sin él por las rutas públicas y lo dice en UNA línea, sin frenar.
#
# El GitHub de juguete contesta 401 a todo pedido a la API con un permiso que no conoce (`reject_unknown_token`), como
# GitHub con un permiso vencido, y 200 sin permiso.
#
#   T1 · ExpiredToken_Startup_UpdatesWithoutIt — el arranque baja la versión nueva; el aviso dice que venció, que no hace
#        falta y cómo sacarlo; después del 401 ningún pedido lleva el permiso; no cuenta como fallo; el permiso sigue guardado.
#   T2 · ExpiredToken_NoticeOnce — el arranque siguiente no repite el aviso (y sigue al día sin mandar el permiso).
#   T3 · ExpiredToken_ManualUpdate_SaysIt_DoctorNotRed — `update --check` a mano sale 0 y dice la línea; `doctor --json` la
#        trae en amarillo y nada en rojo.
#   T4 · ExpiredToken_Unset_ClearsMark — sacado el permiso, el arranque siguiente borra la marca y no manda credencial.
#   T5 · ExpiredToken_FreshInstall_Works — una instalación nueva con el permiso vencido guardado se instala y lo dice.
#   T6 · ExpiredToken_PrivateRepo_Unchanged — con el repo privado (info/refs sin permiso da 401) el 401 se dice como siempre.
#
# Laboratorio: scripts/tests/lib/harness-lab.sh (la máquina de juguete y el GitHub de juguete). Nunca ~/.claude ni el
# checkout real. Sin red real: todo en localhost.
# Uso: bash scripts/tests/release-expired-token.test.sh [--only T1|T2|…]
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/scripts/tests/lib/harness-lab.sh"
export TYCON_UPDATE_APPLY=auto
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in --only) ONLY="${2:-}"; shift 2 ;; *) shift ;; esac
done
corre() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }
FALLOS=0
ok()  { echo "  ok   — $1"; }
mal() { echo "  MAL  — $1"; FALLOS=$((FALLOS+1)); }
BASE="$(mktemp -d)"
case "$BASE" in *tycon-claude-guides*|*agent-skills*|*/.claude*) echo "❌ release-expired-token: el laboratorio cayó en ${BASE}"; exit 1 ;; esac
trap 'rm -rf "$BASE"; kill $(jobs -p) 2>/dev/null' EXIT
VENCIDO='permiso-vencido-del-laboratorio'
j() { python3 -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print($2)" "$1" 2>/dev/null; }
ESTADO() { printf '%s' "$LAB_HOME/.claude/.tycon-pipeline/harness-state.json"; }
estado() { j "$(ESTADO)" "$1"; }
limpia() { : > "$LAB_RELEASE_LOG"; }
# cuántos pedidos del registro del juguete llevaron credencial (después del primer 401, tiene que ser ninguno)
con_permiso() { local n; n="$(grep -c '"auth":true' "$LAB_RELEASE_LOG" 2>/dev/null)"; printf '%s' "${n:-0}"; }
FALLA() { printf "%s" "$LAB_HOME/.claude/.tycon-pipeline/harness/update-failure.json"; }
# el estado con la última mirada (y el último intento) una hora atrás: el arranque siguiente vuelve a mirar
envejece() {
  python3 - "$(ESTADO)" <<'PY'
import json, sys, datetime
f = sys.argv[1]; d = json.load(open(f, encoding='utf-8'))
old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
for k in ('last_fetch', 'last_fetch_failed'):
    if d.get(k): d[k] = old
json.dump(d, open(f, 'w', encoding='utf-8'), indent=2)
PY
}
guarda_vencido() { printf "%s" "$VENCIDO" | harness config set github.token >/dev/null 2>&1 || mal "no pude guardar el permiso de prueba"; }
# el aviso: que venció, que no hace falta porque el repo es público, y cómo sacarlo
es_aviso() { case "$1" in *"venció"*"no hace falta"*"público"*"config unset github.token"*) return 0 ;; *) return 1 ;; esac; }

# ── una máquina con la 2026.10.07.1 instalada sin permiso; después se guarda el permiso vencido ──
harness_lab_create "$BASE/lab"
harness_lab_release_server
harness_lab_publish_stable 2026.10.07.1
harness_lab_release_fresh_home
out="$(harness install --version 2026.10.07.1 --yes 2>&1)"; rc=$?
[ "$rc" = 0 ] || mal "la instalación de partida salió $rc: $out"
harness_lab_release_control '{ "auth": "none", "reject_unknown_token": true }'
guarda_vencido

# ───────────────────────────────────────────── T1 ─────────────────────────────────────────────
if corre T1 || corre T2 || corre T3 || corre T4; then
  echo "T1 · el arranque con el permiso vencido baja la versión nueva por las rutas públicas y lo dice"
  harness_lab_publish_stable 2026.10.07.2
  envejece
  limpia
  out="$(harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "el arranque sale 0" || mal "el arranque salió $rc: $out"
  v="$(estado "[s for s in d['sources'] if s.get('kind')=='release'][0]['version']")"
  [ "$v" = 2026.10.07.2 ] && ok "quedó instalada la 2026.10.07.2" || mal "quedó «${v}»: $out · $(harness_lab_release_log | tail -5)"
  aviso="$(estado "d.get('notice') or ''")"
  es_aviso "$aviso" && ok "el aviso dice que venció, que no hace falta y cómo sacarlo" || mal "el aviso no es el esperado: «${aviso}» · salida: $out"
  es_aviso "$out" && ok "la línea del arranque lo dice" || mal "la línea del arranque no lo dice: «${out}»"
  case "$aviso$out" in *"creá un permiso"*) mal "todavía pide crear un permiso" ;; *) ok "no pide crear un permiso" ;; esac
  n401="$(grep -c '"auth":true' "$LAB_RELEASE_LOG")"
  [ "$n401" = 1 ] && ok "un solo pedido llevó el permiso (el que contestó 401)" || mal "$n401 pedidos llevaron el permiso: $(harness_lab_release_log)"
  [ ! -s "$(FALLA)" ] && ok "no cuenta como «no se pudo actualizar»" || mal "lo contó como fallo: $(cat "$(FALLA)")"
  harness_release config show 2>&1 | grep -q 'github.token' && ok "el permiso sigue guardado (no se borra solo)" || mal "el permiso desapareció de la configuración"
  [ -n "$(estado "d.get('token_expired_notice') or ''")" ] && ok "el estado anota que ya se avisó" || mal "sin token_expired_notice"
  grep -rqs -- "$VENCIDO" "$LAB_HOME/.claude/.tycon-pipeline" && mal "el valor del permiso quedó escrito en el estado o el registro" || ok "el valor del permiso no quedó escrito en el estado ni en el registro"

  echo "T2 · el arranque siguiente no repite el aviso"
  envejece
  limpia
  out="$(harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "segundo arranque: sale 0" || mal "segundo arranque salió $rc: $out"
  es_aviso "$(estado "d.get('notice') or ''")$out" && mal "segundo arranque: repite el aviso: $out" || ok "segundo arranque: no repite el aviso"
  [ "$(con_permiso)" -le 1 ] && ok "segundo arranque: a lo sumo el pedido que vuelve a dar 401 lleva el permiso" || mal "segundo arranque: $(con_permiso) pedidos con permiso"
  [ ! -s "$(FALLA)" ] && ok "segundo arranque: sin fallo anotado" || mal "segundo arranque: fallo anotado: $(cat "$(FALLA)")"

  echo "T3 · update --check a mano lo dice y sale 0; doctor lo pinta amarillo, no rojo"
  harness_lab_publish_stable 2026.10.07.3
  out="$(harness_release update --check 2>&1)"; rc=$?
  [ "$rc" = 0 ] || [ "$rc" = 3 ] && ok "update --check sale $rc (hay versión nueva o al día), no 2" || mal "update --check salió $rc: $out"
  case "$out" in *2026.10.07.3*) ok "update --check ve la versión nueva" ;; *) mal "update --check no ve la 2026.10.07.3: $out" ;; esac
  es_aviso "$out" && ok "update --check dice la línea" || mal "update --check no dice la línea: $out"
  dj="$(harness_release doctor --json 2>/dev/null)"
  printf '%s' "$dj" > "$BASE/doctor.json"
  w="$(j "$BASE/doctor.json" "len([x for x in d['warn'] if 'config unset github.token' in x])")"
  f="$(j "$BASE/doctor.json" "len([x for x in d['fail'] if 'permiso' in x or '401' in x])")"
  [ "$w" = 1 ] && ok "doctor lo dice en amarillo" || mal "doctor no lo dice en amarillo: $dj"
  [ "$f" = 0 ] && ok "doctor no lo pinta rojo" || mal "doctor lo pinta rojo: $dj"

  echo "T4 · sacado el permiso, la marca se borra y no viaja ninguna credencial"
  harness_release config unset github.token >/dev/null 2>&1 || mal "config unset falló"
  envejece
  limpia
  out="$(harness_release startup 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "arranque sin permiso: sale 0" || mal "arranque sin permiso salió $rc: $out"
  [ -z "$(estado "d.get('token_expired_notice') or ''")" ] && ok "la marca se borró" || mal "la marca sigue: $(harness_lab_state)"
  [ "$(con_permiso)" = 0 ] && ok "ningún pedido llevó credencial" || mal "$(con_permiso) pedidos llevaron credencial"
  v="$(estado "[s for s in d['sources'] if s.get('kind')=='release'][0]['version']")"
  [ "$v" = 2026.10.07.3 ] && ok "y bajó la 2026.10.07.3" || mal "quedó «${v}»"
fi

# ───────────────────────────────────────────── T5 ─────────────────────────────────────────────
if corre T5; then
  echo "T5 · una instalación nueva con el permiso vencido guardado se instala y lo dice"
  harness_lab_release_fresh_home
  guarda_vencido
  limpia
  out="$(harness install --version latest --yes 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "install latest sale 0" || mal "install latest salió $rc: $out"
  es_aviso "$out" && ok "install dice la línea" || mal "install no dice la línea: $out"
fi

# ───────────────────────────────────────────── T6 ─────────────────────────────────────────────
if corre T6; then
  echo "T6 · con el repo privado, el 401 se dice como siempre"
  harness_lab_release_control '{ "auth": "token:el-permiso-que-sirve" }'
  harness_lab_release_fresh_home
  guarda_vencido
  limpia
  out="$(harness install --version latest --yes 2>&1)"; rc=$?
  [ "$rc" != 0 ] && ok "install no sale 0 ($rc)" || mal "install salió 0 con un repo privado y el permiso vencido"
  case "$out" in *"venció o se revocó (401)"*"creá un permiso"*) ok "dice el 401 y pide un permiso nuevo, como antes" ;; *) mal "el 401 no se dice como antes: $out" ;; esac
  es_aviso "$out" && mal "dice que el permiso no hace falta con un repo privado" || ok "no dice que el permiso no hace falta"
fi

kill "$LAB_RELEASE_PROCESS" 2>/dev/null
if [ "$FALLOS" -gt 0 ]; then echo "❌ release-expired-token: $FALLOS falla(s)"; exit 1; fi
echo "✅ release-expired-token: todo en verde"
