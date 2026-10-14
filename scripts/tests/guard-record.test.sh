#!/usr/bin/env bash
# guard-record.test.sh — red de la constancia de los frenos previos a la herramienta (story 2.6).
#
# Por qué existe: un freno que frenó no dejaba rastro en ningún lugar que la cuenta pueda leer. De los
# seis, dos anotaban sólo el escape, uno sólo los bloqueos (y con el comando en claro), tres nada. Así,
# un freno que funcionó todo el mes se ve igual que uno que nunca se disparó: ausente.
#
# Lo que prueba:
#   T1 — una línea por decisión, con sus campos, por cada freno y veredicto válidos
#   T2 — el veredicto es el que fue (bloqueo ≠ paso), con los hooks REALES
#   T3 — lo que no le compete al freno no se anota (el denominador no se infla)
#   T4 — la línea no lleva el contenido: ni comando, ni ruta, ni contraseña; sí la huella
#   T5 — el motivo es un código de la lista cerrada; uno libre sale `otra` y la línea se escribe igual
#   T6 — no poder anotar NO rompe el freno (la constancia es ayuda, no evidencia)
#   T7 — una decisión, UNA línea: el escape declarado no suma además un «paso»
#   T8 — «no pude preguntar» no se anota como «verifiqué y está bien»
#   T9 — el veredicto es el del COMANDO, no el de cada segmento
#  T10 — lo que el freno declara fuera de su alcance no entra en su denominador
#  T11 — el escape se anota por lo que el comando HACE, no por nombrarlo
#  T12 — un bloqueo por falla propia del freno también queda escrito
#  T13 — la constancia no depende del nombre con que el freno encuentra su biblioteca (el de ahora o el de antes),
#        y que no encuentre ninguna no queda callado (story 8.7: en la copia pública sólo está el de ahora)
#
# 🔴 HOME falso siempre: la constancia vive bajo el home, en la carpeta de estado del arnés.
# Correr: bash scripts/tests/guard-record.test.sh
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$AQUI/scripts/lib/guard-record.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0; pasaron=0
ok(){ echo "✅ constancia: $1"; pasaron=$((pasaron+1)); }
no(){ echo "❌ constancia: $1"; fallos=$((fallos+1)); }

ESTADO=".claude/.tycon-pipeline"
CASA=""
mundo(){ CASA="$TMP/casa"; rm -rf "$CASA"; mkdir -p "$CASA/$ESTADO"; }
REG(){ echo "$CASA/$ESTADO/frenos.jsonl"; }
lineas(){ if [ -f "$(REG)" ]; then wc -l < "$(REG)" | tr -d ' '; else echo 0; fi; }

# anota vía el CLI de la lib; el comando va por STDIN (nunca por argv: argv se ve en `ps`)
anotar(){ # $1 freno  $2 regla  $3 veredicto  $4 comando
  printf '%s' "${4:-}" | HOME="$CASA" node "$LIB" --guard "$1" --rule "$2" --verdict "$3" --cmd-stdin 2>/dev/null
}

# corre un hook real con un comando; imprime su exit code
correr(){ # $1 ruta del hook  $2 comando
  local ev
  ev="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$2")"
  case "$1" in
    *.js) printf '%s' "$ev" | HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" node "$1" >/dev/null 2>&1 ;;
    *)    printf '%s' "$ev" | HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" bash "$1" >/dev/null 2>&1 ;;
  esac
  echo $?
}

SG="$AQUI/scripts/hooks/safety-guard-pre.sh"
TS="$AQUI/scripts/hooks/test-scope-guard-pre.sh"
PF="$AQUI/scripts/hooks/push-phantom-ref-notice.js"
P1="$AQUI/scripts/hooks/pr-one-per-repo-guard.js"
P2="$AQUI/scripts/hooks/pr-auto-complete-guard.js"

# ── T1 — una línea por decisión, con sus campos ───────────────────────────────────────────────
mundo
anotar safety-guard GIT-C1 bloqueo 'git push --force origin main'
anotar test-scope-guard suite-completa paso 'npm test -- archivo.test.ts'
anotar pr-sin-auto-complete sin-auto-complete escape 'az repos pr create'
if [ "$(lineas)" = "3" ]; then
  faltan=$(HOME="$CASA" node -e '
    const fs=require("fs"), path=require("path");
    const p=path.join(process.env.HOME,".claude",".tycon-pipeline","frenos.jsonl");
    const ls=fs.readFileSync(p,"utf8").trim().split("\n").map(l=>JSON.parse(l));
    const req=["ts","freno","regla","veredicto"];
    process.stdout.write(String(ls.filter(l=>req.some(k=>!l[k])).length));
  ')
  if [ "$faltan" = "0" ]; then ok "T1 tres decisiones, tres líneas, con sus cuatro campos"
  else no "T1 hay $faltan línea(s) sin todos los campos"; fi
else
  no "T1 esperaba 3 líneas, hay $(lineas)"
fi

# ── T2 — el veredicto es el que fue, con los hooks REALES ─────────────────────────────────────
mundo
ec_block=$(correr "$SG" 'rm -rf /')
ec_pass=$(correr "$TS" 'npm test -- scripts/tests/uno.test.ts')
veredictos=$(HOME="$CASA" node -e '
  const fs=require("fs"), path=require("path");
  const p=path.join(process.env.HOME,".claude",".tycon-pipeline","frenos.jsonl");
  if(!fs.existsSync(p)){process.stdout.write("(sin registro)");process.exit(0)}
  const ls=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
  process.stdout.write(ls.map(l=>l.freno+":"+l.veredicto).sort().join(" "));
')
if [ "$ec_block" = "2" ] && echo "$veredictos" | grep "safety-guard:bloqueo" >/dev/null \
   && echo "$veredictos" | grep "test-scope-guard:paso" >/dev/null; then
  ok "T2 el que frenó anota bloqueo y el que dejó pasar anota paso ($veredictos)"
else
  no "T2 veredictos=[$veredictos] exit_del_bloqueo=$ec_block exit_del_paso=$ec_pass"
fi

# ── T3 — lo que no compete no se anota ────────────────────────────────────────────────────────
mundo
for c in 'ls -la' 'cat README.md' 'git status --short'; do
  for h in "$SG" "$TS" "$PF" "$P1" "$P2"; do correr "$h" "$c" >/dev/null; done
done
if [ "$(lineas)" = "0" ]; then ok "T3 tres comandos inocentes × cinco frenos → cero líneas"
else no "T3 el denominador se infló: $(lineas) línea(s) por comandos que no competen"; fi

# ── T4 — la línea no lleva el contenido ───────────────────────────────────────────────────────
mundo
SECRETO='S3cr3t-Cliente-Rioplatense'
anotar safety-guard SQL-C1 bloqueo "sqlcmd -S host -U sa -P $SECRETO -Q 'DROP DATABASE prod' # /Users/usuarioa/x"
salida="$(cat "$(REG)" 2>/dev/null || true)"
fuga=0
for m in "$SECRETO" "/Users/usuarioa" "sqlcmd" "DROP DATABASE"; do
  if echo "$salida" | grep -F "$m" >/dev/null; then fuga=1; echo "    ↳ se filtró: $m"; fi
done
huella=$(echo "$salida" | grep -cE '"sha256":"[0-9a-f]{64}"' || true)
if [ "$fuga" = "0" ] && [ "$huella" = "1" ]; then
  ok "T4 ni contraseña, ni ruta, ni comando; sí la huella"
else
  no "T4 fuga=$fuga huella=$huella"
fi

# ── T5 — el motivo es un código; uno libre sale `otra` ────────────────────────────────────────
mundo
anotar test-scope-guard "el dev estaba apurado y corrio /Users/deva/proyecto" bloqueo 'npm test'
reg="$(cat "$(REG)" 2>/dev/null || true)"
if echo "$reg" | grep '"regla":"otra"' >/dev/null && ! echo "$reg" | grep -F "/Users/deva" >/dev/null; then
  ok "T5 motivo libre → regla otra, y la prosa no se escribe"
else
  no "T5 la línea quedó: $reg"
fi
# el freno antes de publicar (story 8.26, tanda F1): sus cinco reglas son códigos; cualquier otra cosa sale `otra`
mundo
for regla in finding could-not-look unreadable-text; do anotar public-push-guard "$regla" bloqueo 'gh pr create'; done
for regla in clean generic-only; do anotar public-push-guard "$regla" paso 'gh pr create'; done
anotar public-push-guard "lo del cliente Zorblax" bloqueo 'gh pr create --title "lo de Zorblax"'
reg="$(cat "$(REG)" 2>/dev/null || true)"
codigos="$(echo "$reg" | grep -o '"freno":"public-push-guard","regla":"[a-z-]*","veredicto":"[a-z]*"' | sed 's/.*"regla":"\([a-z-]*\)","veredicto":"\([a-z]*\)"/\1=\2/' | tr '\n' ' ')"
if [ "$codigos" = "finding=bloqueo could-not-look=bloqueo unreadable-text=bloqueo clean=paso generic-only=paso otra=bloqueo " ] && ! echo "$reg" | grep -i "zorblax" >/dev/null; then
  ok "T5 el freno antes de publicar anota sus cinco reglas por su código; una frase suelta sale otra, y su texto no se escribe"
else
  no "T5 (freno antes de publicar) quedó: $codigos"
fi
# el control de historia interna (story 8.26, tanda G3): cuatro reglas y los cuatro veredictos; lo demás sale `otra`
mundo
anotar internal-history finding bloqueo 'commit'
anotar internal-history finding aviso 'commit'
anotar internal-history finding escape 'commit'
anotar internal-history could-not-look bloqueo 'commit'
anotar internal-history disabled escape 'commit'
anotar internal-history clean paso 'commit'
anotar internal-history "la story de un cliente Zorblax" bloqueo 'commit con lo de Zorblax'
reg="$(cat "$(REG)" 2>/dev/null || true)"
codigos="$(echo "$reg" | grep -o '"freno":"internal-history","regla":"[a-z-]*","veredicto":"[a-z]*"' | sed 's/.*"regla":"\([a-z-]*\)","veredicto":"\([a-z]*\)"/\1=\2/' | tr '\n' ' ')"
if [ "$codigos" = "finding=bloqueo finding=aviso finding=escape could-not-look=bloqueo disabled=escape clean=paso otra=bloqueo " ] && ! echo "$reg" | grep -i "zorblax" >/dev/null; then
  ok "T5 el control de historia interna anota sus cuatro reglas por su código; una frase suelta sale otra, y su texto no se escribe"
else
  no "T5 (historia interna) quedó: $codigos"
fi

# ── T6 — no poder anotar NO rompe el freno ────────────────────────────────────────────────────
mundo
chmod 500 "$CASA/$ESTADO"
ec=$(correr "$SG" 'rm -rf /')
chmod 700 "$CASA/$ESTADO"
if [ "$ec" = "2" ]; then
  ok "T6 con la carpeta sin permiso el freno frena igual (exit 2)"
else
  no "T6 el freno cambió de comportamiento al no poder anotar (exit=$ec, esperaba 2)"
fi

# ── T7 — una decisión, UNA línea: el escape no suma además un «paso» ──────────────────────────
# 🔴 rojo previo (defecto real, 2026-09-16): con TYCON_PR_BY_HAND=1 el freno anotaba «escape» y
#    después, como ya no quedaban problemas, también «paso» — dos líneas para una sola decisión,
#    inflando el denominador con algo que no pasó.
mundo
correr "$P2" 'TYCON_PR_BY_HAND=1 az repos pr create --source-branch x --target-branch main --title t' >/dev/null
n=$(lineas); v=$(grep -o '"veredicto":"[a-z]*"' "$(REG)" 2>/dev/null | sort -u | tr '\n' ' ')
if [ "$n" = "1" ] && echo "$v" | grep 'escape' >/dev/null; then
  ok "T7 el escape declarado deja UNA línea (escape), no dos"
else
  no "T7 quedaron $n línea(s): $v"
fi

# ── T8 — «no pude preguntar» no se anota como «verifiqué y está bien» ─────────────────────────
# 🔴 rojo previo (defecto real, 2026-09-16): si la consulta a Azure fallaba, el freno seguía de
#    largo y al final anotaba «paso» — mezclando «no miré» con «miré y está bien», que es
#    exactamente la distinción que esta story existe para no perder.
mundo
ev_pr="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:"az repos pr create --source-branch x --target-branch main --title t"}}))')"
printf '%s' "$ev_pr" | HOME="$CASA" TYCON_PR_ONE_PER_REPO=1 PATH=/usr/bin:/bin node "$P1" >/dev/null 2>&1
if [ "$(lineas)" = "0" ]; then
  ok "T8 sin poder consultar los pull requests no se anota nada (no es una decisión)"
else
  no "T8 anotó $(lineas) línea(s) sin haber podido verificar: $(cat "$(REG)")"
fi

# ── T9 — el veredicto es el del COMANDO, no el de cada segmento ───────────────────────────────
# 🔴 rojo previo (defecto real, hallado EN VIVO por el revisor de fallos silenciosos en la vuelta 2):
#    un comando con dos `pr create` —uno salteado con el escape y otro mal armado— escribía DOS
#    líneas, `escape` y `bloqueo`. Dos decisiones donde hubo una; y encima el `escape` quedaba
#    anotado como si algo hubiera pasado, cuando el comando entero murió en 2 y no corrió nada.
mundo
correr "$P2" 'TYCON_PR_BY_HAND=1 az repos pr create --source-branch a --target-branch main --title a && az repos pr create --source-branch b --target-branch main --title b' >/dev/null
n=$(lineas); v=$(grep -o '"veredicto":"[a-z]*"' "$(REG)" 2>/dev/null | tr '\n' ' ')
if [ "$n" = "1" ] && echo "$v" | grep 'bloqueo' >/dev/null; then
  ok "T9 dos pull requests, uno salteado y otro mal armado → UNA línea, y dice bloqueo"
else
  no "T9 quedaron $n línea(s): $v"
fi

# ── T10 — lo que el freno declara FUERA de su alcance no entra en su denominador ──────────────
# 🔴 rojo previo (defecto real, revisor spec-first vuelta 2): un pull request que va a `dev`, un
#    borrador y un `--help` son cosas que este freno declara fuera de su alcance y no juzga —
#    anotarles un «paso» infla su denominador con comandos que nunca miró. Es el espejo exacto
#    del arreglo de «no pude preguntar» en el freno hermano.
mundo
correr "$P2" 'az repos pr create --source-branch x --target-branch dev --title t' >/dev/null
correr "$P2" 'az repos pr create --source-branch x --target-branch main --title t --draft true' >/dev/null
correr "$P2" 'az repos pr create --help' >/dev/null
fuera=$(lineas)
correr "$P2" 'az repos pr create --source-branch x --target-branch main --title t --auto-complete true --squash false' >/dev/null
dentro=$(lineas)
if [ "$fuera" = "0" ] && [ "$dentro" = "1" ]; then
  ok "T10 lo declarado fuera de alcance no deja línea; lo que sí juzga, sí"
else
  no "T10 fuera de alcance dejó $fuera línea(s) y lo juzgado dejó $((dentro-fuera))"
fi

# ── T11 — el escape se anota por lo que el comando HACE, no por nombrarlo ────────────────────
# 🔴 rojo previo (defecto real, hallado por el pase adversarial ejecutando el código): el escape se
#    reconoce por el texto, así que un mensaje de commit, un heredoc o un `grep` que MENCIONEN la
#    variable lo disparaban. Medido sobre el registro real de esta máquina: 135 de 516 entradas
#    (26 %) no son escapes de verdad — y es el tipo dominante de la ficha de escapes.
mundo
correr "$TS" 'echo "ojo: TYCON_FULL_SUITE=1 npm test es el escape"' >/dev/null
correr "$TS" 'git commit -m "documenta TYCON_FULL_SUITE=1 en la guia"' >/dev/null
mencion=$(lineas)
correr "$TS" 'TYCON_FULL_SUITE=1 npm test' >/dev/null
legitimo=$(lineas)
v=$(grep -o '"veredicto":"[a-z]*"' "$(REG)" 2>/dev/null | tr '\n' ' ')
if [ "$mencion" = "0" ] && [ "$legitimo" = "1" ] && echo "$v" | grep 'escape' >/dev/null; then
  ok "T11 mencionar el escape no lo anota; usarlo de verdad sí"
else
  no "T11 menciones=$mencion legítimo=$legitimo veredictos=[$v]"
fi

# ── T12 — un bloqueo por falla PROPIA del freno también queda escrito ─────────────────────────
# 🔴 rojo previo (defecto real, pase adversarial): era el único camino de bloqueo del freno de
#    producción que no pasaba por su función de frenar, así que frenaba y para la cuenta no existía.
mundo
printf '%s' '{"tool_input":{"command":"sqlcmd -S prod.db' \
  | HOME="$CASA" node "$AQUI/scripts/hooks/prod-access-guard.js" >/dev/null 2>&1; ec=$?
reg="$(cat "$(REG)" 2>/dev/null || true)"
if [ "$ec" = "2" ] && echo "$reg" | grep '"regla":"no-pude-mirar"' >/dev/null && echo "$reg" | grep '"veredicto":"bloqueo"' >/dev/null; then
  ok "T12 el freno que no pudo decidir frena Y deja su línea"
else
  no "T12 exit=$ec reg=[$reg]"
fi

# ── T13 — la constancia no depende del NOMBRE con que el freno encuentra su biblioteca (story 8.7) ──
# El freno de producción cargaba la biblioteca de constancias sólo por su nombre de antes del renombre a inglés. En
# el repo del equipo ese nombre es un reemplazo generado; la copia pública no lo lleva, y ahí la carga fallaba adentro
# de un `catch` callado: el freno frenaba y para la cuenta no existía (era el T12 rojo de la copia). En /opt/tycon
# andaba, porque el instalador copia la biblioteca con los dos nombres.
# Tres arneses de laboratorio con el freno REAL: la biblioteca sólo con el nombre nuevo (la copia pública), sólo con el
# de antes (una instalación vieja) y sin ninguna. El nombre de antes sale del instalador, no se escribe acá.
# 🔴 rojo previo: con el freno de antes, «sólo el nombre nuevo» frena sin dejar línea, y «sin ninguna» no lo dice.
OLD_RECORD_REL="$(sed -n 's/^NOMBRE_VIEJO_CONSTANCIA=//p' "$AQUI/scripts/production/install-guard.sh" | head -1)"
guard_lab(){ # $1 carpeta  $2 new|old|none → un arnés mínimo: el freno y la biblioteca bajo ese nombre
  local d="$1"; rm -rf "$d"; mkdir -p "$d/scripts/hooks" "$d/scripts/lib"
  cp "$AQUI/scripts/hooks/prod-access-guard.js" "$d/scripts/hooks/"
  case "$2" in
    new) cp "$LIB" "$d/scripts/lib/guard-record.js" ;;
    old) cp "$LIB" "$d/scripts/${OLD_RECORD_REL}" ;;
  esac
}
guard_lab_run(){ # $1 carpeta → corre el freno del laboratorio con un pedido ilegible que nombra una base; deja $ec y $reg
  printf '%s' '{"tool_input":{"command":"sqlcmd -S prod.db' \
    | HOME="$CASA" node "$1/scripts/hooks/prod-access-guard.js" >/dev/null 2>&1; ec=$?
  reg="$(cat "$(REG)" 2>/dev/null || true)"
}
if [ -z "$OLD_RECORD_REL" ]; then
  no "T13 no encontré NOMBRE_VIEJO_CONSTANCIA en scripts/production/install-guard.sh: sin el nombre de antes no se puede armar el caso"
else
  mundo; guard_lab "$TMP/g-new" new; guard_lab_run "$TMP/g-new"
  if [ "$ec" = "2" ] && echo "$reg" | grep '"regla":"no-pude-mirar"' >/dev/null && echo "$reg" | grep '"veredicto":"bloqueo"' >/dev/null; then
    ok "T13 con la biblioteca sólo bajo el nombre nuevo (la copia pública) el freno frena Y deja su línea"
  else
    no "T13 sólo el nombre nuevo: exit=$ec reg=[$reg]"
  fi
  mundo; guard_lab "$TMP/g-old" old; guard_lab_run "$TMP/g-old"
  if [ "$ec" = "2" ] && echo "$reg" | grep '"regla":"no-pude-mirar"' >/dev/null && echo "$reg" | grep '"veredicto":"bloqueo"' >/dev/null; then
    ok "T13 con la biblioteca sólo bajo el nombre de antes (una instalación vieja) el freno frena Y deja su línea"
  else
    no "T13 sólo el nombre de antes: exit=$ec reg=[$reg]"
  fi
  # sin ninguna de las dos: frenar no depende de la constancia, y que no se pudo anotar no queda callado
  mundo; guard_lab "$TMP/g-none" none; guard_lab_run "$TMP/g-none"
  hook_errors="$(cat "$CASA/$ESTADO/hook-errors.log" 2>/dev/null || true)"
  if [ "$ec" = "2" ] && [ -z "$reg" ] && echo "$hook_errors" | grep 'no pudo cargar la biblioteca de constancias' >/dev/null; then
    ok "T13 sin la biblioteca el freno frena igual, y que no pudo anotar queda dicho en hook-errors.log"
  else
    no "T13 sin la biblioteca: exit=$ec reg=[$reg] hook-errors=[$(echo "$hook_errors" | head -c 300)]"
  fi
  # el camino de todos los días (la función de frenar, no la de la falla propia), con el arnés entero menos el nombre
  # de antes: es lo que tiene la copia pública
  mundo; rm -rf "$TMP/g-full"; mkdir -p "$TMP/g-full/scripts/hooks" "$TMP/g-full/scripts/production"
  cp -R "$AQUI/scripts/lib" "$TMP/g-full/scripts/lib"; rm -f "$TMP/g-full/scripts/${OLD_RECORD_REL}"
  cp "$AQUI/scripts/hooks/prod-access-guard.js" "$TMP/g-full/scripts/hooks/"
  cp "$AQUI/scripts/production/production-index.js" "$TMP/g-full/scripts/production/"
  ec="$(correr "$TMP/g-full/scripts/hooks/prod-access-guard.js" 'sqlcmd -S servidor-de-juguete.example -Q "select 1"')"
  reg="$(cat "$(REG)" 2>/dev/null || true)"
  if [ "$ec" = "2" ] && echo "$reg" | grep '"freno":"prod-access-guard"' >/dev/null && echo "$reg" | grep '"veredicto":"bloqueo"' >/dev/null; then
    ok "T13 un servidor sin declarar, con la biblioteca sólo bajo el nombre nuevo: frena por su función de frenar Y deja su línea"
  else
    no "T13 función de frenar con sólo el nombre nuevo: exit=$ec reg=[$reg]"
  fi
fi

# ══ Story 7.2 — los tres hooks del CIERRE también dejan constancia ══════════════════════════════
# El número que decide si el cierre recortado alcanza —cuántas veces `on-frontmatter-write` y
# `on-pre-commit` rechazan una evidencia— no existía: esos hooks (en agent-skills) no anotaban nada.
# Los hooks se corren REALES desde agent-skills (`TYCON_SKILLS_DIR` apunta a un clon mientras el
# cambio no está en main). Sin agent-skills en la máquina, la parte no se puede medir y lo dice.
SKILLS72="${TYCON_SKILLS_DIR:-$HOME/.claude/agent-skills/skills}"
FW="$SKILLS72/tycon-pipeline/scripts/on-frontmatter-write.js"
PC="$SKILLS72/tycon-pipeline/scripts/on-pre-commit.js"
EG="$SKILLS72/tycon-pipeline/scripts/on-dod-evidence-guard.js"

# Un repo efímero con una story que declara E2E (el gatillo de «requiere evidencia runtime»).
repo72(){ # $1 carpeta
  local r="$1"; rm -rf "$r"; mkdir -p "$r/specs" "$r/.advisors/dod-runtime"
  git -C "$r" init -q -b main
  printf '%s\n' '---' 'story: "9.1"' 'epic: "9"' 'status: in-progress' '---' '# Story 9.1 historia-confidencial' '' \
    '## Acceptance Criteria' '1. AC uno con E2E' > "$r/specs/historia-confidencial.md"
  git -C "$r" add -A && git -C "$r" -c user.email=b@b -c user.name=b commit -q -m base
}
# Evento Edit que pasa la story a done; lo imprime por stdout.
ev_done(){ node -e 'process.stdout.write(JSON.stringify({tool_name:"Edit",session_id:"s72",tool_input:{file_path:process.argv[1],old_string:"status: in-progress",new_string:"status: done"}}))' "$1"; }
# ¿Todas las líneas del registro tienen EXACTAMENTE las cinco claves y ningún valor con ruta/story?
lineas_limpias(){ HOME="$CASA" node -e '
  const fs=require("fs"),path=require("path");
  const p=path.join(process.env.HOME,".claude",".tycon-pipeline","frenos.jsonl");
  if(!fs.existsSync(p)){process.stdout.write("sin-registro");process.exit(0)}
  const ok=["ts","freno","regla","veredicto","sha256"].join(",");
  const malas=fs.readFileSync(p,"utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l))
    .filter(l=>Object.keys(l).sort().join(",")!==ok.split(",").sort().join(",")
      || !/^[0-9a-f]{64}$|^$/.test(l.sha256||"") || /historia-confidencial|\/|specs/.test(l.freno+l.regla+l.veredicto));
  process.stdout.write(String(malas.length));
'; }
de72(){ grep -o "\"freno\":\"$1\",\"regla\":\"[a-z-]*\",\"veredicto\":\"[a-z]*\"" "$(REG)" 2>/dev/null | sed 's/"freno":"[^"]*",//' | tr '\n' ' '; }

if [ ! -f "$FW" ] || [ ! -f "$PC" ] || [ ! -f "$EG" ]; then
  no "7.2 NO MEDIDO: no encontré los hooks del cierre en $SKILLS72 (TYCON_SKILLS_DIR) — sin agent-skills no se puede verificar"
else
  # ── 7.2-T1 — Constancia_HooksDelCierre_AnotanBloqueoYPaso ─────────────────────────────────────
  # 🔴 rojo previo: contra los hooks de origin/main de agent-skills, cero líneas.
  mundo; R="$TMP/r72"; repo72 "$R"
  ev_done "$R/specs/historia-confidencial.md" | (cd "$R" && HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" node "$FW" >/dev/null 2>&1); ec_sin=$?
  echo "# evidencia" > "$R/.advisors/dod-runtime/9.1-20260916-1200.md"
  ev_done "$R/specs/historia-confidencial.md" | (cd "$R" && HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" node "$FW" >/dev/null 2>&1); ec_con=$?
  fw="$(de72 on-frontmatter-write)"
  # on-pre-commit: story a done con corrida de revisores posterior al corte y SIN roster → frena por roster
  R2="$TMP/r72b"; repo72 "$R2"
  node -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("status: in-progress","status: done\ndod_runtime_exempt: true\ndod_runtime_exempt_reason: \"prueba\""))' "$R2/specs/historia-confidencial.md"
  git -C "$R2" add -A
  mkdir -p "$R2/.advisors/pipeline-runs/9.1-20260915-1200" && echo '[]' > "$R2/.advisors/pipeline-runs/9.1-20260915-1200/findings.json"
  ev_pc="$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",session_id:"s72",cwd:process.argv[1],tool_input:{command:"git commit -m \"cierre de historia-confidencial, avisar a juan.perez@cliente.com\""}}))' "$R2")"
  printf '%s' "$ev_pc" | (cd "$R2" && HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" node "$PC" >/dev/null 2>&1); ec_pc=$?
  pc="$(de72 on-pre-commit)"
  # on-dod-evidence-guard: escribir evidencia a mano → frena; el self-audit → pasa
  ev_w(){ node -e 'process.stdout.write(JSON.stringify({tool_name:"Write",session_id:"s72",tool_input:{file_path:process.argv[1],content:"x"}}))' "$1"; }
  ev_w "$R/.advisors/dod-runtime/9.1-20260916-1300.md" | HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" node "$EG" >/dev/null 2>&1; ec_eg=$?
  ev_w "$R/.advisors/dod-runtime/9.1-self-audit-iter1.md" | HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" node "$EG" >/dev/null 2>&1
  eg="$(de72 on-dod-evidence-guard)"
  limpias="$(lineas_limpias)"
  if [ "$ec_sin" = "2" ] && [ "$ec_con" = "0" ] && [ "$ec_pc" = "2" ] && [ "$ec_eg" = "2" ] \
     && echo "$fw" | grep '"regla":"evidencia-ausente","veredicto":"bloqueo"' >/dev/null \
     && echo "$fw" | grep '"regla":"evidencia-ok","veredicto":"paso"' >/dev/null \
     && echo "$pc" | grep '"regla":"roster","veredicto":"bloqueo"' >/dev/null \
     && echo "$eg" | grep '"regla":"escritura-manual","veredicto":"bloqueo"' >/dev/null \
     && echo "$eg" | grep '"regla":"archivo-exento","veredicto":"paso"' >/dev/null \
     && [ "$(lineas)" = "5" ] && [ "$limpias" = "0" ]; then
    ok "7.2-T1 los tres hooks del cierre anotan cada decisión (bloqueo y paso), una línea cada una, sin ruta ni story"
  else
    no "7.2-T1 exits sin/con/pc/eg=$ec_sin/$ec_con/$ec_pc/$ec_eg líneas=$(lineas) sucias=$limpias fw=[$fw] pc=[$pc] eg=[$eg]"
  fi

  # ── 7.2-T2 — Constancia_SinLib_ElHookDecideIgual ──────────────────────────────────────────────
  # La lib no está (TYCON_GUIDES_DIR a una carpeta vacía): mismo exit y mismo stderr, y sin registro.
  mundo; R="$TMP/r72c"; repo72 "$R"; VACIA="$TMP/vacia"; mkdir -p "$VACIA"
  ev_done "$R/specs/historia-confidencial.md" | (cd "$R" && HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" node "$FW" 2>"$TMP/err-con" >"$TMP/out-con"); e1=$?
  rm -f "$(REG)"
  ev_done "$R/specs/historia-confidencial.md" | (cd "$R" && HOME="$CASA" TYCON_GUIDES_DIR="$VACIA" node "$FW" 2>"$TMP/err-sin" >"$TMP/out-sin"); e2=$?
  if [ "$e1" = "2" ] && [ "$e1" = "$e2" ] && cmp -s "$TMP/err-con" "$TMP/err-sin" && cmp -s "$TMP/out-con" "$TMP/out-sin" && [ ! -f "$(REG)" ]; then
    ok "7.2-T2 sin la lib el hook decide igual (mismo exit, misma salida) y no deja registro"
  else
    no "7.2-T2 exit con/sin=$e1/$e2 salida-igual=$(cmp -s "$TMP/err-con" "$TMP/err-sin" && echo si || echo no) registro=$( [ -f "$(REG)" ] && echo existe || echo ausente)"
  fi

  # ── 7.2-T2b — las suites de agent-skills no ensucian el registro real (vuelta 1) ─────────────────
  # 🔴 rojo previo (pase adversarial): story-discovery, unit, el humo de DoD, step-7c-macro y story-skill-gate
  #    llaman a estos hooks con el HOME real y el instalador las corre en cada arranque → decisiones de prueba
  #    en el frenos.jsonl que sube al buzón. Con TYCON_CLOSURE_RECORD=off el hook no anota; y esas suites lo ponen.
  #    El nombre viejo del interruptor (story 8.9) sigue apagando: sale del mapa de renombres, no se escribe acá.
  VIEJO_CIERRE="$(node -e 'const e=(require(process.argv[1]).entries||[]).find((x)=>x&&x.kind==="env"&&x.new==="TYCON_CLOSURE_RECORD");process.stdout.write(e?e.old:"")' "$AQUI/scripts/lib/renames.json" 2>/dev/null)"
  eoff=""; registro=""
  for interruptor in TYCON_CLOSURE_RECORD ${VIEJO_CIERRE:+"$VIEJO_CIERRE"}; do
    mundo; R="$TMP/r72d"; rm -rf "$R"; repo72 "$R"
    ev_done "$R/specs/historia-confidencial.md" | (cd "$R" && env HOME="$CASA" TYCON_GUIDES_DIR="$AQUI" "$interruptor=off" node "$FW" >/dev/null 2>&1); eoff="$eoff $interruptor:$?"
    [ -f "$(REG)" ] && registro="$registro $interruptor"
  done
  sin_marca=""
  for t in story-discovery.test.js unit.test.js dod-hook-smoke-test.sh step-7c-macro.test.js story-skill-gate.test.js; do
    f="$SKILLS72/tycon-pipeline/scripts/tests/$t"
    # agent-skills puede estar un pull atrás o adelante (story 8.9): vale el nombre nuevo o el viejo del interruptor
    [ -f "$f" ] && grep -qE "TYCON_CLOSURE_RECORD${VIEJO_CIERRE:+|$VIEJO_CIERRE}" "$f" || sin_marca="$sin_marca $t"
  done
  # La copia pública (story 8.7) sale sin el perfil del equipo y sin el mapa de renombres: ahí no hay nombre viejo que
  # probar. Se mide la mitad del nombre nuevo y se dice que la otra no se midió. En el repo del equipo, que el mapa no
  # traiga el nombre viejo sigue siendo un rojo.
  PUBLIC_COPY=0
  if [ ! -f "$AQUI/perfil-equipo.json" ] || [ ! -f "$AQUI/scripts/lib/renames.json" ]; then PUBLIC_COPY=1; fi
  if [ "$PUBLIC_COPY" = 1 ] && [ -z "$VIEJO_CIERRE" ]; then
    echo "⏭ constancia: 7.2-T2b NO MEDIDO para el nombre viejo del interruptor — copia pública sin el mapa de renombres. No es un verde."
    if [ "$eoff" = " TYCON_CLOSURE_RECORD:2" ] && [ -z "$registro" ] && [ -z "$sin_marca" ]; then
      ok "7.2-T2b con el interruptor apagado (sólo el nombre nuevo: la copia pública no tiene el viejo) el hook decide igual y no anota; las 5 suites de agent-skills lo ponen"
    else
      no "7.2-T2b (copia pública, sólo el nombre nuevo) exits=[$eoff] anotaron=[$registro] suites-sin-interruptor:[$sin_marca]"
    fi
  elif [ -n "$VIEJO_CIERRE" ] && [ "$eoff" = " TYCON_CLOSURE_RECORD:2 $VIEJO_CIERRE:2" ] && [ -z "$registro" ] && [ -z "$sin_marca" ]; then
    ok "7.2-T2b con el interruptor apagado (nombre nuevo y viejo del mapa) el hook decide igual y no anota; las 5 suites de agent-skills lo ponen"
  else
    no "7.2-T2b viejo-del-mapa=[${VIEJO_CIERRE}] exits=[$eoff] anotaron=[$registro] suites-sin-interruptor:[$sin_marca]"
  fi
fi

echo "─────────────────────────────"
echo "constancia-freno: $pasaron ok · $fallos fallos"
[ "$fallos" = "0" ] || exit 1
