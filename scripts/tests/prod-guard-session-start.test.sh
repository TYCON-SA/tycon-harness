#!/usr/bin/env bash
# prod-guard-session-start.test.sh — el freno de producción sabe cuándo arrancó la sesión, o mira todo.
#
# Caso que lo motiva: una sesión larga, retomada varias veces, no podía usar la puerta de producción ni para `--verify`.
# El freno decía «no pude saber cuándo arrancó esta sesión para elegir su snapshot de shell» y la puerta quedaba cerrada
# para esa sesión. El freno saca el arranque de `ps`, subiendo por los procesos hasta el `claude` que lo llamó, y
# fallaba de tres formas:
#   - con el sistema en castellano, `ps -o lstart=` da «mar. 1 dic. 10:00:00 2026», y esa hora no se entendía (en enero, abril,
#     agosto y diciembre: los otros meses se escriben igual en inglés y se entendían de casualidad);
#   - el proceso de una sesión retomada puede llamarse por su versión (`…/claude/versions/2.1.332 --resume …`), no
#     `claude`, y no se lo reconocía;
#   - sin ningún `claude` arriba, no había nada que elegir.
# Sin el arranque, el freno no sabe cuáles snapshots son de esta sesión. El lado seguro no es frenar para siempre: es
# revisar TODOS los snapshots y además preguntarle al shell de login en vivo. Eso mira más que cualquier arranque bien
# leído, así que no abre nada.
#
# Lo que prueba (con un `ps` de mentira que arma la ascendencia, sin la costura TYCON_PROD_SESSION_SINCE):
#   S1 — sistema en castellano: la hora se entiende y la puerta pasa (rojo contra el freno anterior)
#   S2 — el proceso con nombre de versión cuenta como `claude` (rojo contra el freno anterior)
#   S3 — en castellano, un secuestro en el snapshot de esta sesión sigue frenando
#   S4 — sin `claude` arriba y sin secuestro, la puerta pasa (rojo contra el freno anterior)
#   S5 — sin `claude` arriba, un secuestro en un snapshot viejo frena: se revisan todos, y el aviso lo dice
#   S6 — sin `claude` arriba, un secuestro que sólo ve el shell de login vivo frena aunque haya snapshots limpios
#   S7 — `ps` no entiende la hora en ningún formato: se usa el tiempo transcurrido, y la puerta pasa
#   S8 — la ruta de la versión en un argumento de otro proceso no cuenta como la sesión
#   S9 — un FIFO con nombre de snapshot frena dentro del reloj, no cuelga al freno
#
# 🔴 HOME falso siempre y ninguna base real: la puerta no corre, sólo se le pregunta al freno.
# Con /opt/tycon presente las costuras no existen y la suite se saltea; en una máquina con el freno se corre con
# /opt/tycon escondido: sandbox-exec -f <perfil que niega leer y ver /opt/tycon> bash <esta suite>
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$AQUI/scripts/hooks/prod-access-guard.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ session-start: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ session-start: $1"; fallos=$((fallos+1)); }

if [ -d /opt/tycon ]; then
  echo "⏭ session-start: NO MEDIDO — esta máquina tiene el freno instalado (/opt/tycon): sin costuras de prueba, esta suite corre en el nocturno."
  exit 0
fi
if [ ! -x /bin/zsh ]; then
  echo "⏭ session-start: NO MEDIDO — sin /bin/zsh en esta máquina no se puede preguntarle al shell de login."
  exit 0
fi

PROD=acme-sql.database.windows.net
PUERTA="/opt/tycon/bin/tycon-prod-sql"
# el arranque de la sesión de mentira: 1/12/2026 10:00:00 hora local, y los snapshots alrededor
ARRANQUE_MS="$(node -e 'process.stdout.write(String(new Date(2026,11,1,10,0,0).getTime()))')"
ANTES_MS=$((ARRANQUE_MS - 3600000))
DESPUES_MS=$((ARRANQUE_MS + 60000))

mundo(){ # deja $CASA (HOME falso) y $REPOS (raíz de repos) recién hechos
  CASA="$TMP/casa"; REPOS="$TMP/repos"
  rm -rf "$CASA" "$REPOS"
  mkdir -p "$CASA/.claude/shell-snapshots" "$CASA/.claude/.tycon-pipeline" "$REPOS/backend-acme/.tycon"
  ( cd "$REPOS/backend-acme" && git init -q . ) >/dev/null 2>&1
  printf '{"servers":[{"host":"%s","environment":"produccion","keychain":"tycon-prod-acme"}]}' "$PROD" > "$REPOS/backend-acme/.tycon/production.json"
}
snapshot(){ # $1 = funciones, $2 = epoch-ms del nombre
  printf '# Snapshot file\n\n# Functions\n%s\n# Shell Options\n# Aliases\n\n# Check for rg availability\nrg () { : }\nexport PATH=/usr/bin\n' "$1" > "$CASA/.claude/shell-snapshots/snapshot-zsh-$2-aaaaaa.sh"; }

# ── el `ps` de mentira ─────────────────────────────────────────────────────────────────────────
# Cualquier proceso que no conoce es un bash cuyo padre es 4242; el 4242 es la sesión, con el comando de FAKE_CLAUDE_CMD
# (vacío: no hay `claude` arriba, el 4242 es un bash hijo de 1). La hora sale como la da el `ps` de la Mac: en el idioma
# de LC_ALL, si no LC_TIME, si no LANG. FAKE_LSTART=roto: una hora que no se entiende en ningún idioma.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/ps" <<'PS'
#!/bin/bash
campo=""; pid=""
while [ $# -gt 0 ]; do
  case "$1" in -o) campo="$2"; shift 2 ;; -p) pid="$2"; shift 2 ;; *) shift ;; esac
done
idioma="${LC_ALL:-${LC_TIME:-${LANG:-C}}}"
case "$campo" in
  ppid=,command=)
    if [ "$pid" = 4242 ]; then
      if [ -n "${FAKE_CLAUDE_CMD:-}" ]; then echo "    1 $FAKE_CLAUDE_CMD"; else echo "    1 /bin/bash"; fi
    else echo " 4242 /bin/bash -c algo"; fi ;;
  lstart=)
    if [ "${FAKE_LSTART:-}" = roto ]; then echo "??"; exit 0; fi
    case "$idioma" in es*) echo "mar. 1 dic. 10:00:00 2026  " ;; *) echo "Tue Dec  1 10:00:00 2026" ;; esac ;;
  etime=)
    echo "${FAKE_ETIME:-02:00:00}" ;;
  *) exit 1 ;;
esac
PS
chmod +x "$TMP/bin/ps"

# corre el freno con la puerta canónica; imprime el exit code. $@ = variables extra "K=V"
corre(){
  local payload; payload="$(CMD="$PUERTA $PROD 'select 1'" node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",hook_event_name:"PreToolUse",cwd:"/tmp",tool_input:{command:process.env.CMD,timeout:300000}}))')"
  printf '%s' "$payload" | env -u TYCON_PROD_SESSION_SINCE -u LC_ALL -u LC_TIME HOME="$CASA" ZDOTDIR="$CASA" SHELL=/bin/zsh \
    TYCON_REPOS_ROOT="$REPOS" PATH="$TMP/bin:$PATH" "$@" node "$HOOK" >"$TMP/out" 2>"$TMP/err"
  echo $?
}
espera(){ local etiqueta="$1" quiero="$2"; shift 2
  local rc; rc="$(corre "$@")"
  if [ "$rc" = "$quiero" ]; then ok "$etiqueta"; else no "$etiqueta (rc=$rc, esperaba $quiero) — err: $(head -c 200 "$TMP/err")"; fi
}

# ── S1 · sistema en castellano ─────────────────────────────────────────────────────────────────
mundo; snapshot "" "$DESPUES_MS"
espera "S1 · en castellano, la hora de ps se entiende y la puerta pasa" 0 LANG=es_AR.UTF-8 FAKE_CLAUDE_CMD="claude --resume x"
if grep -q "no pude saber cuándo arrancó" "$TMP/err"; then no "S1 · todavía dice que no supo cuándo arrancó"; fi

# ── S2 · el proceso con nombre de versión ─────────────────────────────────────────────────────
mundo; snapshot "" "$DESPUES_MS"
espera "S2 · …/claude/versions/2.1.332 cuenta como la sesión" 0 LANG=C FAKE_CLAUDE_CMD="/Users/u/.local/share/claude/versions/2.1.332 --resume x"

# ── S3 · en castellano, el secuestro de esta sesión sigue frenando ────────────────────────────
mundo; snapshot "" "$ANTES_MS"; snapshot "tycon-prod-sql () { echo tomada }" "$DESPUES_MS"
espera "S3 · en castellano, un secuestro en el snapshot de esta sesión frena" 2 LANG=es_AR.UTF-8 FAKE_CLAUDE_CMD="claude"
# y el de una sesión anterior no: el arranque se leyó bien, no se cayó a «revisar todo»
mundo; snapshot "tycon-prod-sql () { echo tomada }" "$ANTES_MS"; snapshot "" "$DESPUES_MS"
espera "S3b · en castellano, el secuestro de una sesión anterior no frena" 0 LANG=es_AR.UTF-8 FAKE_CLAUDE_CMD="claude"

# ── S4 · sin `claude` arriba y sin secuestro ──────────────────────────────────────────────────
mundo; snapshot "" "$ANTES_MS"; snapshot "" "$DESPUES_MS"
espera "S4 · sin la sesión en la ascendencia y todo limpio, la puerta pasa" 0 LANG=C FAKE_CLAUDE_CMD=""

# ── S5 · sin `claude` arriba, se revisan todos los snapshots ──────────────────────────────────
mundo; snapshot "tycon-prod-sql () { echo tomada }" "$ANTES_MS"; snapshot "" "$DESPUES_MS"
espera "S5 · sin la sesión en la ascendencia, un secuestro en un snapshot viejo frena" 2 LANG=C FAKE_CLAUDE_CMD=""
if grep -q "snapshot-zsh-$ANTES_MS-aaaaaa.sh" "$TMP/err" && grep -q "sesión nueva" "$TMP/err"; then ok "S5 · el aviso nombra el snapshot y ofrece una sesión nueva"
else no "S5 · el aviso no nombra el snapshot o no ofrece una sesión nueva — err: $(head -c 300 "$TMP/err")"; fi

# ── S6 · sin `claude` arriba, también se pregunta al shell de login vivo ──────────────────────
mundo; snapshot "" "$DESPUES_MS"; printf 'tycon-prod-sql() { echo tomada; }\n' > "$CASA/.zlogin"
espera "S6 · sin la sesión en la ascendencia, un secuestro en .zlogin frena aunque haya snapshots limpios" 2 LANG=C FAKE_CLAUDE_CMD=""

# ── S7 · la hora no se entiende en ningún formato: el tiempo transcurrido ─────────────────────
# stable-data: el freno calcula el arranque como «ahora menos el tiempo transcurrido» con su propio reloj, así que el
# snapshot de esta sesión tiene que nacer ahora; el viejo es de 2001 y queda afuera con cualquier fecha de corrida
mundo; snapshot "tycon-prod-sql () { echo tomada }" "1000000000000"; snapshot "" "$(( $(date +%s) * 1000 ))"
espera "S7 · con la hora rota, el tiempo transcurrido da el arranque y la puerta pasa" 0 LANG=C FAKE_CLAUDE_CMD="claude" FAKE_LSTART=roto FAKE_ETIME=1-02:03:04

# ── S8 · la ruta de la versión nombrada en un argumento no es la sesión ───────────────────────
# Si contara, el arranque sería el de ese proceso y el snapshot de esta sesión podría quedar afuera; sin sesión
# reconocida se revisan todos, y el secuestro de un snapshot viejo frena.
mundo; snapshot "tycon-prod-sql () { echo tomada }" "$ANTES_MS"; snapshot "" "$DESPUES_MS"
espera "S8 · un proceso que sólo NOMBRA …/claude/versions/x en un argumento no cuenta como la sesión" 2 LANG=C FAKE_CLAUDE_CMD="/bin/bash /x/claude/versions/2.1.332"

# ── S9 · un FIFO con nombre de snapshot frena, no cuelga ──────────────────────────────────────
# Leerlo colgaba al freno hasta que el registro lo mataba a los 10 s, y un freno muerto deja pasar el comando.
mundo; snapshot "" "$DESPUES_MS"; mkfifo "$CASA/.claude/shell-snapshots/snapshot-zsh-1-fifo00.sh"
t=$(date +%s)
espera "S9 · sin la sesión en la ascendencia, un FIFO con nombre de snapshot frena" 2 LANG=C FAKE_CLAUDE_CMD=""
t=$(( $(date +%s) - t ))
if [ "$t" -le 5 ]; then ok "S9 · y frena dentro del reloj propio (${t}s)"; else no "S9 · tardó ${t}s (tope 5)"; fi

echo "— session-start: $pasaron ok, $fallos fallos —"
[ "$fallos" -eq 0 ]
