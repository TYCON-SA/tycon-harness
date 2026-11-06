#!/usr/bin/env bash
# Prueba de pr-auto-complete-guard.js — el freno que impide armar un pull request A MANO sin
# auto-complete, o con squash.
#
# 🔴 Un agente puede crear un pull request suelto, sin auto-complete, aunque el skill de merge sepa crearlo
# bien. Una regla escrita («usá el skill») es justo lo que puede fallar; esto no depende de que nadie se acuerde.
#
# 🔴 Los casos 11 a 18 son los SEIS caminos por los que un freno armado a la ligera se deja pasar.
# Sin ellos, un verde no significaría nada.
#
# Sin red: el freno mira sólo el texto del comando.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$AQUI/scripts/hooks/pr-auto-complete-guard.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME/.claude"   # la constancia del escape se escribe acá, no en el HOME real
fallos=0; casos=0
ok(){ casos=$((casos+1)); echo "✅ pr-sin-ac: $1"; }
no(){ casos=$((casos+1)); echo "❌ pr-sin-ac: $1"; fallos=$((fallos+1)); }

# El sujeto de esta prueba es un script de Node: pedirle a python3 que arme el JSON metería un
# intérprete más (y 39 arranques) en la suite diaria, que tiene poco margen de tiempo.
# 🔴 HOME aislado: el hook deja constancia de cada escape en
# `$HOME/.claude/.tycon-pipeline/bypass.log`, y esta suite lo ejercita (caso 8) — sin aislar,
# escribiría escapes de PRUEBA en el registro de escapes HUMANOS del dev y después afirmaría sobre
# ese registro vivo: el assert podría pasar con datos de otro.
export HOME="$TMP/home"; mkdir -p "$HOME/.claude/.tycon-pipeline"
corre(){ # <comando>
  node -e 'process.stdout.write(JSON.stringify({tool_input:{command:process.argv[1]}}))' "$1" \
    | node "$HOOK" >"$TMP/out.txt" 2>"$TMP/err.txt"
  echo $?
}
BASE='az repos pr create --organization https://dev.azure.com/org-del-equipo --project Ceibo --repository CeiboBackend --source-branch fix/health-build-info --target-branch main --title "fix(health): x"'
# Con la tercera bandera (8.164): sin `--delete-source-branch` explícito el pedido ya no está bien armado.
BIEN="$BASE --auto-complete true --squash false --delete-source-branch true"

# ---------------------------------------------------------------- 1. 🔴 EL COMANDO TAL CUAL SE TIPEÓ
rc=$(corre "$BASE --description \"a\" \"\" \"b\" -o json")
[ "$rc" -eq 2 ] && ok "🔴 el comando del caso real (sin auto-complete) queda BLOQUEADO (exit 2)" || no "🔴 dejó pasar el comando del caso real ($rc)"
grep -q "tycon-merge-to-main" "$TMP/err.txt" && ok "…y dice el camino: el skill de merge" || no "no nombró el skill"
grep -q "auto-complete true --squash false" "$TMP/err.txt" && ok "…y las dos banderas exactas si igual va a mano" || no "no dijo las banderas"
grep -q "source=fix/health-build-info" "$TMP/err.txt" && ok "…con la rama del comando ya puesta en la invocación del skill" || no "no propagó la rama"

# ---------------------------------------------------------------- 2. el comando del skill pasa
rc=$(corre "$BASE --description \"\$(cat /tmp/pr-body.md)\" --auto-complete true --delete-source-branch true --squash false -o json")
[ "$rc" -eq 0 ] && ok "el comando que arma el skill (auto-complete true, squash false, borrar la rama) pasa" || no "🔴 bloqueó al skill ($rc)"

# ---------------------------------------------------------------- 3. auto-complete puesto pero con squash → bloquea
rc=$(corre "$BASE --auto-complete true --squash true")
[ "$rc" -eq 2 ] && ok "🔴 con auto-complete pero --squash true, BLOQUEA (rompe las notas de versión)" || no "🔴 dejó pasar el squash ($rc)"
grep -q "notas de versión" "$TMP/err.txt" && ok "…y explica por qué el squash rompe" || no "no explicó el squash"

# ---------------------------------------------------------------- 4. auto-complete en false explícito → bloquea
rc=$(corre "$BASE --auto-complete false --squash false")
[ "$rc" -eq 2 ] && ok "--auto-complete false explícito también bloquea" || no "🔴 dejó pasar --auto-complete false ($rc)"

# ---------------------------------------------------------------- 5. la forma --flag=valor también se entiende
rc=$(corre "$BASE --auto-complete=true --squash=false --delete-source-branch=true")
[ "$rc" -eq 0 ] && ok "la forma --auto-complete=true se reconoce" || no "🔴 no entendió --flag=valor ($rc)"

# ---------------------------------------------------------------- 6. un borrador no se toca, y lo dice
rc=$(corre "$BASE --draft true")
[ "$rc" -eq 0 ] && ok "un borrador (--draft true) no se toca: no se completa solo por definición" || no "🔴 bloqueó un borrador ($rc)"
rc=$(corre "$BASE --draft")
[ "$rc" -eq 0 ] && ok "…también con --draft a secas (para az vale true)" || no "🔴 bloqueó --draft a secas ($rc)"
grep -q "borrador" "$TMP/err.txt" && ok "…y deja dicho que fue un borrador" || no "dejó pasar el borrador en silencio"

# ---------------------------------------------------------------- 7. sólo mira crear y actualizar
for otro in "az repos pr list --org https://x --status active" "az repos pr show --id 1" "az repos pr create --help" "git status" "echo 'az repos pr create sin banderas'"; do
  rc=$(corre "$otro")
  [ "$rc" -eq 0 ] || { no "🔴 bloqueó un comando que no arma un PR: $otro"; break; }
done
[ "$rc" -eq 0 ] && ok "listar, mostrar, --help, comandos ajenos y una MENCIÓN dentro de un echo no se tocan"

# ---------------------------------------------------------------- 8. la salida explícita: SÓLO como prefijo, y con constancia
rc=$(corre "TYCON_PR_BY_HAND=1 $BASE")
[ "$rc" -eq 0 ] && ok "TYCON_PR_BY_HAND=1 PEGADO al comando deja pasar" || no "🔴 bloqueó pese a la salida explícita ($rc)"
grep -q "Queda dicho" "$TMP/err.txt" && ok "…y deja constancia en stderr" || no "🔴 dejó pasar en silencio"
grep -q "PR_A_MANO" "$HOME/.claude/.tycon-pipeline/bypass.log" 2>/dev/null && ok "…y en el bypass.log común, con su tipo, como el freno de tests" || no "🔴 no quedó en el bypass.log"
rc=$(TYCON_PR_BY_HAND=1 corre "$BASE")
[ "$rc" -eq 2 ] && ok "🔴 exportada en el ENTORNO no vale: un escape permanente es un freno apagado" || no "🔴 honró la variable desde el entorno ($rc)"
rc=$(corre "$BASE --description \"si hace falta: TYCON_PR_BY_HAND=1\"")
[ "$rc" -eq 2 ] && ok "🔴 el token dentro de un texto no vale" || no "🔴 un comentario con el token abrió el freno ($rc)"
rc=$(corre "$BASE && echo TYCON_PR_BY_HAND=1")
[ "$rc" -eq 2 ] && ok "🔴 el token en otro segmento del mismo comando no vale" || no "🔴 el token al final de la cadena abrió el freno ($rc)"

# ---------------------------------------------------------------- 9. apagado del todo
rc=$(TYCON_PR_AUTO_COMPLETE_GUARD=0 corre "$BASE")
[ "$rc" -eq 0 ] && ok "TYCON_PR_AUTO_COMPLETE_GUARD=0 apaga el freno" || no "🔴 no respetó el apagado ($rc)"

# ---------------------------------------------------------------- 10. entrada rota → no bloquea, pero lo DICE
rc=$(printf 'esto no es json' | node "$HOOK" >/dev/null 2>"$TMP/err.txt"; echo $?)
[ "$rc" -eq 0 ] && ok "entrada ilegible: no bloquea (un freno que rompe la sesión por un bug propio se apaga)" || no "🔴 bloqueó con entrada ilegible ($rc)"
grep -q "no pude leer" "$TMP/err.txt" && ok "…pero lo dice: 'no miré' no puede parecer 'está bien'" || no "🔴 no pudo leer y se calló"

# ---------------------------------------------------------------- 11. 🔴 una bandera escrita DENTRO del título no es una bandera
rc=$(corre "$BASE --title \"nota: --auto-complete true --squash false\"")
[ "$rc" -eq 2 ] && ok "🔴 '--auto-complete true' adentro del título NO cuenta como bandera" || no "🔴 un título con el texto de la bandera abrió el freno ($rc)"

# ---------------------------------------------------------------- 12. 🔴 dos creaciones encadenadas: cada una con SUS banderas
rc=$(corre "$BIEN && az repos pr create --org https://x --project P --repository OTRO --source-branch fix/otro --target-branch main --title t")
[ "$rc" -eq 2 ] && ok "🔴 la segunda creación encadenada, sin banderas, BLOQUEA aunque la primera esté bien" || no "🔴 la segunda heredó las banderas de la primera ($rc)"
grep -q "OTRO" "$TMP/err.txt" && ok "…y señala CUÁL de las dos está mal" || no "no dijo cuál"
rc=$(corre "if [ -n \"\$ID\" ]; then az repos pr update --id \$ID --auto-complete true --squash false; else $BASE; fi")
[ "$rc" -eq 2 ] && ok "🔴 el create de la rama else no se salva con las banderas del update de la rama then" || no "🔴 las banderas del update salvaron al create ($rc)"

# ---------------------------------------------------------------- 13. 🔴 la forma corta: `--squash` a secas vale true para az
rc=$(corre "$BASE --auto-complete true --squash -o json")
[ "$rc" -eq 2 ] && ok "🔴 '--squash' a secas (= true) BLOQUEA aunque le siga '-o json'" || no "🔴 leyó '--squash -o' como squash=-o y dejó pasar ($rc)"
rc=$(corre "$BASE --auto-complete --squash false --delete-source-branch")
[ "$rc" -eq 0 ] && ok "'--auto-complete' a secas (= true) pasa" || no "🔴 bloqueó '--auto-complete' a secas, que para az es true ($rc)"

# ---------------------------------------------------------------- 14. 🔴 los sinónimos de az: yes/no/1/0/y/n/t/f
rc=$(corre "$BASE --auto-complete yes --squash no --delete-source-branch y")
[ "$rc" -eq 0 ] && ok "'--auto-complete yes --squash no' pasa (az los acepta)" || no "🔴 rechazó sinónimos válidos ($rc)"
rc=$(corre "$BASE --auto-complete true --squash yes")
[ "$rc" -eq 2 ] && ok "🔴 '--squash yes' BLOQUEA" || no "🔴 dejó pasar '--squash yes' ($rc)"

# ---------------------------------------------------------------- 15. 🔴 la última bandera repetida es la que toma az
rc=$(corre "$BIEN --auto-complete false")
[ "$rc" -eq 2 ] && ok "🔴 '--auto-complete true … --auto-complete false' BLOQUEA (az toma el último)" || no "🔴 juzgó por el primero ($rc)"
rc=$(corre "$BASE --squash false --auto-complete true --squash true")
[ "$rc" -eq 2 ] && ok "🔴 '--squash false … --squash true' BLOQUEA" || no "🔴 juzgó el squash por el primero ($rc)"

# ---------------------------------------------------------------- 16. 🔴 sin --squash explícito NO alcanza: lo decide la política de la rama
rc=$(corre "$BASE --auto-complete true")
[ "$rc" -eq 2 ] && ok "🔴 auto-complete sin '--squash false' explícito BLOQUEA (lo decidiría la política de la rama)" || no "🔴 dejó pasar sin squash explícito ($rc)"
grep -q "política de la rama" "$TMP/err.txt" && ok "…y explica por qué hace falta explícito" || no "no explicó el squash implícito"

# ---------------------------------------------------------------- 17. 🔴 el comando partido en varias líneas con \\ es UN comando
rc=$(corre "$(printf 'az repos pr create --org https://x --project P --repository R \\\n  --source-branch fix/x --target-branch main --title t \\\n  --auto-complete \\\n  true \\\n  --squash false --delete-source-branch true')")
[ "$rc" -eq 0 ] && ok "🔴 con continuaciones de línea, el valor en la línea siguiente se lee bien" || no "🔴 leyó la barra de continuación como valor ($rc)"

# ---------------------------------------------------------------- 18. 🔴 la otra puerta: `pr update` que apaga lo que hay que tener
rc=$(corre "az repos pr update --id 2859 --auto-complete false")
[ "$rc" -eq 2 ] && ok "🔴 'pr update --auto-complete false' BLOQUEA (mismo resultado por la otra puerta)" || no "🔴 dejó apagar el auto-complete por update ($rc)"
rc=$(corre "az repos pr update --id 2859 --squash true")
[ "$rc" -eq 2 ] && ok "🔴 'pr update --squash true' BLOQUEA" || no "🔴 dejó prender el squash por update ($rc)"
rc=$(corre "az repos pr update --id 2859 --auto-complete true --squash false --description \"x\"")
[ "$rc" -eq 0 ] && ok "'pr update' que prende auto-complete y apaga squash (el 9b.2 del skill) pasa" || no "🔴 bloqueó el update del skill ($rc)"
rc=$(corre "az repos pr update --id 2859 --title \"otro título\"")
[ "$rc" -eq 0 ] && ok "'pr update' que no toca esas dos banderas pasa" || no "🔴 bloqueó un update inocente ($rc)"

# ---------------------------------------------------------------- 19. 🔴 el valor ENTRE COMILLAS es válido para az
rc=$(corre "$BASE --auto-complete \"true\" --squash 'false' --delete-source-branch \"true\"")
[ "$rc" -eq 0 ] && ok "🔴 '--auto-complete \"true\"' (comillas en el VALOR) pasa: es válido para az" || no "🔴 bloqueó un comando correcto por las comillas ($rc) — un freno que corta el camino bueno se apaga"
rc=$(corre "az repos pr update --id 5 --squash \"true\"")
[ "$rc" -eq 2 ] && ok "🔴 …y '--squash \"true\"' en un update sigue BLOQUEANDO" || no "🔴 las comillas abrieron la puerta del update ($rc)"

# ---------------------------------------------------------------- 20. 🔴 `&` de fondo también separa
rc=$(corre "$BIEN & az repos pr create --org https://x --source-branch ci/b --target-branch main --title t")
[ "$rc" -eq 2 ] && ok "🔴 dos creaciones separadas por '&' se juzgan por separado" || no "🔴 la segunda heredó las banderas por el '&' ($rc)"
rc=$(corre "$BIEN 2>&1")
[ "$rc" -eq 0 ] && ok "…y '2>&1' NO se confunde con un separador" || no "🔴 leyó la redirección como separador ($rc)"

# ---------------------------------------------------------------- 21. 🔴 az acepta opciones globales antes del grupo
rc=$(corre "az -o json repos pr create --org https://x --source-branch ci/a --target-branch main --title t")
[ "$rc" -eq 2 ] && ok "🔴 'az -o json repos pr create' NO esquiva el freno" || no "🔴 las opciones globales lo esquivaron ($rc)"
rc=$(corre "az repos pr \\
  create --org https://x --source-branch ci/a --target-branch main --title t")
[ "$rc" -eq 2 ] && ok "🔴 una continuación de línea entre 'pr' y 'create' tampoco lo esquiva" || no "🔴 la continuación lo esquivó ($rc)"

# ---------------------------------------------------------------- 22. 🔴 publicar un borrador es la tercera puerta
rc=$(corre "az repos pr update --id 5 --draft false")
[ "$rc" -eq 2 ] && ok "🔴 publicar un borrador ('--draft false') sin las banderas BLOQUEA" || no "🔴 el camino borrador→publicar quedó abierto ($rc)"
rc=$(corre "az repos pr update --id 5 --draft false --auto-complete true --squash false --delete-source-branch false")
[ "$rc" -eq 0 ] && ok "…y publicarlo CON las tres banderas pasa" || no "🔴 bloqueó una publicación correcta ($rc)"

# ---------------------------------------------------------------- 23. 🔴 código adentro de una cadena que ejecuta otro intérprete
rc=$(corre "bash -c \"az repos pr create --target-branch main --title t\"")
[ "$rc" -eq 2 ] && ok "🔴 'bash -c \"az repos pr create…\"' BLOQUEA: no puedo leer lo que se ejecuta" || no "🔴 el intérprete lo escondió ($rc)"
rc=$(corre "echo \"az repos pr create --target-branch main\"")
[ "$rc" -eq 0 ] && ok "…pero un 'echo' con el mismo texto NO se toca: echo no ejecuta nada" || no "🔴 bloqueó un echo ($rc)"

# ---------------------------------------------------------------- 24. 🔴 sólo los PR a main
rc=$(corre "az repos pr create --org https://x --source-branch feat/x --target-branch dev --title t")
[ "$rc" -eq 0 ] && ok "🔴 un PR a 'dev' NO se toca: el skill es el camino de main, no de dev" || no "🔴 frenó un PR a dev con un consejo equivocado ($rc)"

# ---------------------------------------------------------------- 25. 🔴 la rama del mensaje, tal cual
rc=$(corre "az repos pr create --org https://x --source-branch fix/Health-Build --target-branch main --title t")
grep -q "source=fix/Health-Build" "$TMP/err.txt" && ok "🔴 la rama del mensaje conserva las mayúsculas (git distingue)" || no "🔴 el mensaje sugiere una rama que no existe"
rc=$(corre "az repos pr create --org https://x -s fix/corta -t main --title t")
grep -q "source=fix/corta" "$TMP/err.txt" && ok "…y entiende la forma corta '-s'" || no "🔴 no leyó '-s' y sugiere <rama>"

# ---------------------------------------------------------------- 26. 🔴 un comentario con apóstrofo no desarma el freno
rc=$(corre "$(printf '# no uses el skill, don%s t\naz repos pr create --org https://x --source-branch ci/a --target-branch main --title t' "'")")
[ "$rc" -eq 2 ] && ok "🔴 un comentario con apóstrofo NO se traga el comando de la línea siguiente" || no "🔴 una comilla suelta desarmó el freno ($rc)"

# ---------------------------------------------------------------- 27. 🔴 2ª REVISIÓN: el escape acepta las mismas escrituras que el detector
rc=$(corre "TYCON_PR_BY_HAND=1 command az repos pr create --target-branch main --title t")
[ "$rc" -eq 0 ] && ok "🔴 el escape vale con 'command az' (el detector también lo entiende)" || no "🔴 el escape no sirve para una forma que el detector sí ve ($rc)"
rc=$(corre "TYCON_PR_BY_HAND=true az repos pr create --target-branch main --title t")
[ "$rc" -eq 0 ] && ok "…y con '=true', no sólo '=1'" || no "🔴 el escape sólo entiende '=1' ($rc)"
rc=$(corre "TYCON_PR_BY_HAND=1 az repos pr update --id 5 --auto-complete false")
[ "$rc" -eq 0 ] && ok "🔴 …y también sirve para el update (retener una entrega es un caso legítimo)" || no "🔴 el update no tiene escape: eso empuja a apagar el freno para siempre ($rc)"

# ---------------------------------------------------------------- 28. 🔴 3ª REVISIÓN: capturar el id es la forma MÁS común
rc=$(corre "PR=\$($BASE)")
[ "$rc" -eq 2 ] && ok "🔴 'PR=\$(az repos pr create …)' BLOQUEA: una sustitución de comandos ES un comando" || no "🔴 capturar la salida en una variable esquivó el freno ($rc)"
rc=$(corre "PR=\$( $BASE )")
[ "$rc" -eq 2 ] && ok "…con espacios adentro del paréntesis, el MISMO veredicto (antes uno pasaba y el otro no)" || no "🔴 el espacio cambió el veredicto ($rc)"
rc=$(corre "PR=\`$BASE\`")
[ "$rc" -eq 2 ] && ok "…y con comillas invertidas también" || no "🔴 las comillas invertidas lo esquivaron ($rc)"
rc=$(corre "($BASE)")
[ "$rc" -eq 2 ] && ok "…y adentro de una subshell '( … )'" || no "🔴 la subshell lo esquivó ($rc)"
rc=$(corre "PR=\$($BIEN)")
[ "$rc" -eq 0 ] && ok "…y capturar la salida de un comando BIEN armado sigue pasando" || no "🔴 bloqueó una captura correcta ($rc)"

# ---------------------------------------------------------------- 29. 🔴 3ª REVISIÓN: el cuerpo de un heredoc es TEXTO
# Este repo documenta el comando MAL armado por convención (el registro de incidentes, las guías,
# el encabezado del propio freno). Sin esto, el freno saltaba justo cuando alguien iba a escribir
# el incidente que lo motivó — y escribir un archivo no ejecuta nada.
rc=$(corre "$(printf 'cat >> doc.md <<%sEOF%s\nEl agente corrio: az repos pr create --target-branch main --title x\nEOF' "'" "'")")
[ "$rc" -eq 0 ] && ok "🔴 un heredoc que DOCUMENTA el comando malo no se toca: escribir un archivo no ejecuta nada" || no "🔴 bloqueó la escritura del incidente que lo motivó ($rc)"
rc=$(corre "$(printf 'cat > f <<%sEOF%s\ntexto cualquiera\nEOF\naz repos pr create --org https://x --source-branch ci/a --target-branch main --title t' "'" "'")")
[ "$rc" -eq 2 ] && ok "…pero el comando de VERDAD después del heredoc sigue bloqueado" || no "🔴 el heredoc tapó el comando que venía después ($rc)"

# ---------------------------------------------------------------- 30. 🔴 3ª REVISIÓN: lo que estaba verde SIN prueba
# Los tres se rompieron a propósito y las dos suites seguían verdes. El peor: si se rompiera la
# forma corta del destino, TODO PR a dev quedaría bloqueado y nadie se enteraría.
rc=$(corre "az repos pr create --org https://x -s feat/x -t dev --title t")
[ "$rc" -eq 0 ] && ok "🔴 un PR a dev con la forma CORTA del destino ('-t dev') tampoco se toca" || no "🔴 la forma corta del destino no se lee: todo PR a dev quedaría bloqueado ($rc)"
rc=$(corre "$BASE --auto-complete true --squash false --delete-source-branch true --target-branch refs/heads/main")
[ "$rc" -eq 0 ] && ok "el destino escrito como 'refs/heads/main' se reconoce igual" || no "🔴 no reconoció refs/heads/main ($rc)"
rc=$(corre "az repos pr update --id 42 --auto-complete false")
grep -q "va a main" "$TMP/err.txt" && no "🔴 el mensaje del update afirma 'va a main' y el update NO dice a qué rama apunta" || ok "🔴 el mensaje del update NO afirma 'a main': ese comando no lleva el destino"

# ---------------------------------------------------------------- 31-34. el prefijo que sobra no es un salteo (story 1.32)
# La medición de una semana: de 40 pedidos a mano con el prefijo, 19 pasaban igual sin él y quedaban anotados como salteos.
ST="$HOME/.claude/.tycon-pipeline"
limpia(){ rm -f "$ST/bypass.log" "$ST/frenos.jsonl"; }
saltos(){ local n; n=$(grep -c '"PR_A_MANO"' "$ST/bypass.log" 2>/dev/null); echo "${n:-0}"; }
veredicto(){ [ -f "$ST/frenos.jsonl" ] && tail -1 "$ST/frenos.jsonl" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).veredicto||""))' || printf 'ninguna'; }
ORG='--org https://dev.azure.com/org-del-equipo'

# 31 — T1 PrefijoDeMas_NoEsSalteo (AC 1)
while IFS='|' read -r esperado cmd; do
  limpia; rc=$(corre "TYCON_PR_BY_HAND=1 $cmd")
  lineas=$(grep -c . "$TMP/err.txt")
  [ "$rc" -eq 0 ] && [ "$(saltos)" = 0 ] && [ "$(veredicto)" = "$esperado" ] && grep -q "el prefijo sobra" "$TMP/err.txt" && [ "$lineas" -eq 1 ] \
    && ok "T1 con el prefijo de más pasa sin salteo, constancia «${esperado}» y un aviso en una línea: ${cmd:0:60}" \
    || no "T1 prefijo de más: rc=$rc salteos=$(saltos) constancia=$(veredicto) líneas=$lineas — ${cmd:0:80}"
done <<EOF
paso|$BIEN
ninguna|$BASE --draft true
paso|az repos pr update $ORG --id 4919 --draft false --auto-complete true --squash false --delete-source-branch false
paso|az repos pr update $ORG --id 4920 --description "otra descripción"
ninguna|az repos pr create $ORG -s feat/x -t dev --title t
EOF
# un comando con un tramo que sobra y otro que lo necesita: cada uno por su lado
limpia; rc=$(corre "TYCON_PR_BY_HAND=1 $BIEN && TYCON_PR_BY_HAND=1 $BASE --auto-complete false --squash false")
[ "$rc" -eq 0 ] && [ "$(saltos)" = 1 ] && grep -q "el prefijo sobra" "$TMP/err.txt" && [ "$(veredicto)" = escape ] \
  && ok "T1 comando mixto: un aviso de que sobra y un solo PR_A_MANO, constancia escape" \
  || no "T1 comando mixto: rc=$rc salteos=$(saltos) constancia=$(veredicto)"

# 32 — T2 PrefijoNecesario_SigueSiendoSalteo (AC 2)
while read -r cmd; do
  limpia; rc=$(corre "TYCON_PR_BY_HAND=1 $cmd")
  [ "$rc" -eq 0 ] && [ "$(saltos)" = 1 ] && [ "$(veredicto)" = escape ] && ! grep -q "el prefijo sobra" "$TMP/err.txt" \
    && ok "T2 el prefijo que hace falta sigue siendo un salteo: ${cmd:0:60}" \
    || no "T2 prefijo necesario: rc=$rc salteos=$(saltos) constancia=$(veredicto) — ${cmd:0:80}"
done <<EOF
$BASE
az repos pr update $ORG --id 5001 --auto-complete false
az repos pr update $ORG --id 5002 --squash true
EOF

# 33 — T3 CartelDelPedidoQueEsperaAprobacion (AC 3)
limpia; rc=$(corre "$BASE")
[ "$rc" -eq 2 ] && grep -q -- "--draft true" "$TMP/err.txt" && grep -q -- "--draft false --auto-complete true --squash false" "$TMP/err.txt" \
  && ok "T3 un create a main sin entrada automática nombra el borrador y la publicación completa" || no "T3 el cartel del create no nombra el borrador ($rc)"
limpia; rc=$(corre "az repos pr update $ORG --id 5003 --auto-complete false")
[ "$rc" -eq 2 ] && grep -q "Para retener una entrega ya encolada" "$TMP/err.txt" \
  && ok "T3 el update que apaga la entrada automática nombra el prefijo para retener" || no "T3 el cartel del update no dice cómo retener ($rc)"
limpia; rc=$(corre "$BASE && az repos pr update $ORG --id 5004 --auto-complete false")
[ "$rc" -eq 2 ] && grep -q -- "--draft true" "$TMP/err.txt" && grep -q "Para retener una entrega ya encolada" "$TMP/err.txt" \
  && ok "T3 con los dos frenados en un comando salen las dos líneas" || no "T3 los dos juntos no muestran las dos líneas ($rc)"

# 34 — T4 MalArmados_SiguenFrenando (AC 4): los 4 del caso real, sin el prefijo
while read -r cmd; do
  limpia; rc=$(corre "$cmd")
  [ "$rc" -eq 2 ] && grep -q "publica un borrador" "$TMP/err.txt" \
    && ok "T4 un mal armado sigue frenando, con su falta: ${cmd:0:70}" || no "T4 dejó pasar un mal armado o frenó por otra causa ($rc): ${cmd:0:80}"
done <<EOF
az repos pr update $ORG --id 4919 --draft false -o json
az repos pr update $ORG --id 5019 --draft false --auto-complete true --delete-source-branch true -o json
az repos pr update $ORG --id 5024 --draft false --auto-complete true --delete-source-branch true -o json
az repos pr update $ORG --id 5187 --draft false --description "algo"
EOF

# ---------------------------------------------------------------- ENCOLAR NO PIDE CORRER SUITES EN LA MÁQUINA
# Lo afectado lo corre el portón antes de guardar (.test-gate.yaml) y lo entero la cola: encolar no agrega otra pasada.
# Un repo del arnés de juguete con el criterio de verdad del instalador y una rama que lo toca, sin ninguna constancia.
correEn(){ # <cwd> <comando>
  node -e 'process.stdout.write(JSON.stringify({cwd:process.argv[1],tool_input:{command:process.argv[2]}}))' "$1" "$2" \
    | node "$HOOK" >"$TMP/out.txt" 2>"$TMP/err.txt"
  echo $?
}
JUG="$TMP/arnes-de-juguete"
mkdir -p "$JUG/scripts/ci" "$JUG/scripts/setup"
cp "$AQUI/scripts/ci/heavy-suites.json" "$AQUI/scripts/ci/suites-for-change.js" "$JUG/scripts/ci/"
echo base > "$JUG/scripts/setup/instalar.js"
g(){ GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z" git -C "$JUG" -c maintenance.auto=false -c user.name=prueba -c user.email=prueba@example.invalid "$@" >/dev/null 2>&1; }
g init -q -b main; g add -A; g commit -qm base; g update-ref refs/remotes/origin/main HEAD; g checkout -qb fix/instalador
echo cambio > "$JUG/scripts/setup/instalar.js"; g commit -qam "toca el instalador"
GH_AUTO='gh pr merge 77 --merge --auto'
AZ_PUBLICA="az repos pr update $ORG --id 6081 --draft false --auto-complete true --squash false --delete-source-branch false -o json"

# E1 — encolar un cambio del instalador pasa, y el freno no menciona pruebas ni deja constancia de otro freno
limpia; rc=$(correEn "$JUG" "$GH_AUTO")
[ "$rc" -eq 0 ] && ! grep -qi "portable" "$TMP/err.txt" && ok "E1 encolar con gh un cambio del instalador no pide correr nada" || no "E1 frenó o pidió algo al encolar ($rc): $(head -c 200 "$TMP/err.txt")"
grep -q "pr-sin-portables" "$ST/frenos.jsonl" 2>/dev/null && no "E1 anotó un freno retirado" || ok "E1 …y no anota un freno retirado"

# E2 — un pedido de Azure publicado desde una carpeta del arnés pasa: esa carpeta no dice nada del repo del pedido
limpia; rc=$(correEn "$JUG" "$AZ_PUBLICA")
[ "$rc" -eq 0 ] && ok "E2 un pedido de Azure desde un worktree del arnés no frena" || no "E2 frenó un pedido de Azure bien armado ($rc): $(head -c 200 "$TMP/err.txt")"
limpia; rc=$(correEn "$JUG" "cd /tmp/otro-repo && $AZ_PUBLICA")
[ "$rc" -eq 0 ] && ok "E2 …tampoco con un cd a otro repo en el mismo comando" || no "E2 frenó con el cd a otro repo ($rc): $(head -c 200 "$TMP/err.txt")"

# E3 — el prefijo viejo no rompe nada ni deja constancia de un salteo
limpia; rc=$(correEn "$JUG" "TYCON_PORTABLE_BY_HAND=1 $GH_AUTO")
[ "$rc" -eq 0 ] && ! grep -q "PORTABLE_A_MANO" "$ST/bypass.log" 2>/dev/null && ok "E3 un comando con el prefijo viejo pasa y no anota salteo" || no "E3 el prefijo viejo frenó o anotó un salteo ($rc)"

# E4 — lo que este freno sí mira sigue igual, parado en la misma carpeta
limpia; rc=$(correEn "$JUG" "gh pr merge 77 --squash --auto")
[ "$rc" -eq 2 ] && grep -q "aplasta los commits" "$TMP/err.txt" && ok "E4 un gh pr merge que aplasta sigue frenando" || no "E4 dejó pasar un merge que aplasta ($rc)"
limpia; rc=$(correEn "$JUG" "az repos pr update $ORG --id 6081 --draft false -o json")
[ "$rc" -eq 2 ] && grep -q "publica un borrador" "$TMP/err.txt" && ok "E4 publicar un borrador sin sus banderas sigue frenando" || no "E4 dejó pasar un borrador sin banderas ($rc)"

# ---------------------------------------------------------------- 8.164-SinBorrarRama_Frena @story-8.164 @ac-1 (T1)
# 🔴 Sin `--delete-source-branch` explícito, la rama sobrevive al pedido: el 1/11 había 1.019 ramas ya entradas. `false`
# sólo vale desde una rama de larga vida (§9b.4 del paso de merge), que el freno tiene que poder VER en el comando.
limpia
AZM='az repos pr create --org https://x --project P --repository R --target-branch main --title t --auto-complete true --squash false'
for caso in \
  "frena|$AZM --source-branch story/x" \
  "frena|$AZM --source-branch story/x --delete-source-branch false" \
  "frena|$AZM --delete-source-branch false" \
  "pasa|$AZM --source-branch dev --delete-source-branch false" \
  "pasa|$AZM -s refs/heads/main --delete-source-branch false" \
  "pasa|$AZM --source-branch story/x --delete-source-branch true" \
  "frena|az repos pr update --id 5 --draft false --auto-complete true --squash false" \
  "pasa|az repos pr update --id 5 --draft false --auto-complete true --squash false --delete-source-branch false" \
  "pasa|az repos pr update --id 5 --auto-complete true --squash false" \
  "frena|$AZM --source-branch dev --delete-source-branch true" \
  "frena|$AZM -s refs/heads/main --delete-source-branch true" \
  "frena|$AZM -s DEV --delete-source-branch true" \
  "frena|$AZM -s Refs/Heads/Master --delete-source-branch true" \
  "frena|$AZM --delete-source-branch true" \
  "frena|$AZM -s dev --delete-source-branch" \
  "pasa|$AZM -s story/dev --delete-source-branch true" \
  "pasa|$AZM -s dev-fix --delete-source-branch true" \
  "pasa|$AZM -s feature/master --delete-source-branch true" \
  "frena|$AZM -s story/dev --delete-source-branch false" \
  "frena|$AZM -s story/x --delete-source-branch maybe" \
  "frena|$AZM -s story/x --delete-source-branch 2" \
  "frena|$AZM -s story/x --delete-source-branch=" \
  "pasa|$AZM --sour dev -s story/x --delete-source-branch true" \
  "frena|$AZM -s story/x --sour dev --delete-source-branch true" \
  "pasa|$AZM -s dev --delete-source-branch true --delete-source-branch false" \
  "frena|$AZM -s dev --delete-source-branch false --delete-source-branch true" \
  "frena|$AZM -sdev --delete-source-branch true" \
  "pasa|$AZM -sstory/x --delete-source-branch true" \
  "frena|$AZM -s=dev --delete-source-branch true" \
  "frena|$AZM --sour=dev --delete-source-branch true" \
  "pasa|$AZM --sour=story/x --delete-source-branch true" \
  "frena|$AZM -s story/x --delete-source-branch=true -s=main" \
  "pasa|az repos pr create --org https://x --project P --repository R -tdev --title t -s story/x" \
  "frena-otra|az repos pr create --org https://x --project P --repository R -tmain --title t -s story/x" \
  "frena-otra|az repos pr create --org https://x --project P --repository R -t story/y --target main --title t -s story/x" \
  "frena|$AZM -s \"\$BRANCH\" --delete-source-branch true" \
  "frena|$AZM -s \"\$(echo dev)\" --delete-source-branch true" \
  "frena|$AZM -s 'de*' --delete-source-branch true" \
  "frena|$AZM -s 'de?' --delete-source-branch true" \
  "frena|$AZM -s 'd[e]v' --delete-source-branch true" \
  "frena|$AZM -s @rama.txt --delete-source-branch true" \
  "frena|az repos pr create --org https://x --project P --repository R -t \"\$T\" --title t -s story/x --auto-complete true --squash false --delete-source-branch true" \
  "frena|$AZM -s story/x --delete-source-branch \"\$B\"" \
  "frena|az repos pr create --org https://x --project P --repository R --target-branch main --title t -s story/x --auto-complete \"\$A\" --squash false --delete-source-branch true" \
  "frena|az repos pr create --org https://x --project P --repository R --target-branch main --title t -s story/x --auto-complete true --squash \"\$Q\" --delete-source-branch true" \
  "frena|az repos pr update --id 5 --draft \"\$D\" --auto-complete true --squash false --delete-source-branch false" \
  "frena|az repos pr create --org https://x --project P --repository R --target-branch main --title \$T -s story/x --auto-complete true --squash false --delete-source-branch true" \
  "pasa|az repos pr create --org https://x --project P --repository R --target-branch main --title \"\$T\" -s story/x --auto-complete true --squash false --delete-source-branch true" \
  "pasa|az repos pr create --org https://x --project P --repository R --target-branch main --title=x\"\$T\" -s story/x --auto-complete true --squash false --delete-source-branch true" \
  "pasa|$AZM -s story/x --delete-source-branch true --description \"\$(cat x)\"" \
  "pasa|$AZM -s story/x --delete-source-branch true --description @desc.md" \
  "frena|az repos pr update --id 5 --draft false --auto-complete true --squash false --delete-source-branch true" \
  "frena|az repos pr update --id 5 --delete-source-branch true" \
  "frena|az repos pr update --id 5 --delete-source-branch" \
  "frena|az repos pr update --id 5 --draft false --auto-complete true --squash false --delete-source true" \
  "frena|$AZM -s dev --delete-source-branch false '--delete-source-branch' true" \
  "frena|$AZM -s story/x --delete-source-branch true '-s' dev" \
  "frena|$AZM -s story/x --delete-source-branch true \"--source-branch\" dev" \
  "frena|$AZM -s story/x --delete-source-branch false --draft true \$X" \
  "frena|az repos pr create --org https://x --project P --repository R --target-branch dev --title t \$X" \
  "frena|az repos pr update --id 5 \$X" \
  "frena|$AZM --source-branch={feat,dev} --delete-source-branch true" \
  "frena|$AZM -s{feature/x,dev} --delete-source-branch true" \
  "frena|$AZM -s story/{a..c} --delete-source-branch true" \
  "pasa|X=\$Y $AZM -s story/x --delete-source-branch true" \
  "frena|timeout -s KILL 60 $AZM --delete-source-branch true" \
  "pasa|timeout -s KILL 60 $AZM -s story/x --delete-source-branch true" \
  "pasa|$AZM -s story/x --delete-source-branch true --description 'arreglo {a,b} y \$HOME'" \
  "frena|$AZM -s{story/x,\"dev\"} --delete-source-branch true" \
  "frena|$AZM -s ' dev' --delete-source-branch true" \
  "frena|$AZM -s 'main ' --delete-source-branch true" \
  "frena|$AZM -s DEV --delete-source-branch true" \
  "frena|$AZM --delete-source-branch true -s story/x -s{\"a b\",dev}" \
  "frena|$AZM --delete-source-branch true -s story/x '-s dev'" \
  "frena|$AZM --delete-source-branch true -s story/x '--source-branch= main'" \
  "frena|$AZM --delete-source-branch true -s story/x \"\$F\" dev" \
  "frena|$AZM --delete-source-branch true -s story/x --draft \"\$F\" dev" \
  "frena|az repos pr update --id 5 \"\$F\" true" \
  "frena|$AZM -s story/x --delete-source-branch true \"-\$X\" dev" \
  "frena|az repos pr update --id 5 \"--delete-source-\$X\" true" \
  "pasa|$AZM -s story/x --delete-source-branch true --title \"\$T\"" \
  "pasa|$AZM -s story/x --delete-source-branch true --title 'usá -s dev'"; do
  esperado="${caso%%|*}"; cmd="${caso#*|}"
  rc=$(corre "$cmd")
  falta=$(node -e 'const az=require(process.argv[1]); const s=az.segmentos(process.argv[2])[0]; process.stdout.write(String(az.faltasDe(s).faltas.length > 0))' "$AQUI/scripts/lib/az-pr.js" "$cmd" 2>/dev/null)
  # Un «frena» tiene que frenar por la regla de esta historia (la tercera bandera, lo que no se lee o una expansión
  # partida), no por otra falta cualquiera. `frena-otra` es un caso que frena por las dos banderas de antes.
  texto=$(node -e 'const az=require(process.argv[1]); process.stdout.write(az.faltasDe(az.segmentos(process.argv[2])[0]).faltas.join(" | "))' "$AQUI/scripts/lib/az-pr.js" "$cmd" 2>/dev/null)
  if [ "$esperado" = frena ]; then
    [ "$rc" -eq 2 ] && [ "$falta" = true ] && echo "$texto" | grep -E -- 'delete-source-branch|no puedo leer|fuera de comillas' >/dev/null \
      && ok "8.164-SinBorrarRama_Frena frena por la regla nueva y faltasDe coincide: $cmd" || no "8.164-SinBorrarRama_Frena dejó pasar o frenó por otra cosa ($rc, faltasDe=$falta, «${texto}»): $cmd"
  elif [ "$esperado" = frena-otra ]; then
    [ "$rc" -eq 2 ] && [ "$falta" = true ] \
      && ok "8.164-SinBorrarRama_Frena frena y faltasDe coincide: $cmd" || no "8.164-SinBorrarRama_Frena dejó pasar ($rc, faltasDe=$falta): $cmd"
  else
    [ "$rc" -eq 0 ] && [ "$falta" = false ] \
      && ok "8.164-SinBorrarRama_Frena pasa y faltasDe coincide: $cmd" || no "8.164-SinBorrarRama_Frena frenó un pedido bien armado ($rc, faltasDe=$falta): $cmd"
  fi
done
corre "$AZM --source-branch story/x" >/dev/null
grep -q -- "--auto-complete true --squash false --delete-source-branch" "$TMP/err.txt" \
  && ok "8.164-SinBorrarRama_Frena el mensaje trae el comando con las tres banderas" || no "8.164-SinBorrarRama_Frena el mensaje no trae las tres banderas juntas"
# Un `update` no dice la rama: la falta pide `false` (o el skill, o el escape) y no recomienda `true`, que también frena.
for cmd in "az repos pr update --id 5 --draft false --auto-complete true --squash false" \
           "az repos pr update --id 5 --draft false --auto-complete true --squash false --delete-source-branch true"; do
  texto=$(node -e 'const az=require(process.argv[1]); process.stdout.write(az.faltasDe(az.segmentos(process.argv[2])[0]).faltas.join(" | "))' "$AQUI/scripts/lib/az-pr.js" "$cmd" 2>/dev/null)
  echo "$texto" | grep -- '--delete-source-branch false' >/dev/null && ! echo "$texto" | grep 'Va en `true`' >/dev/null \
    && ok "8.164-SinBorrarRama_Frena la falta de un update pide false y no recomienda true: ${cmd:26:60}" \
    || no "8.164-SinBorrarRama_Frena la falta de un update no pide false o recomienda true («${texto}»): ${cmd:26:60}"
done
# Lo que no se puede leer se nombra: el aviso dice cuál valor no pudo leer.
corre "$AZM -s \"\$BRANCH\" --delete-source-branch true" >/dev/null
grep -q 'no puedo leer' "$TMP/err.txt" && grep -q -- '\$BRANCH' "$TMP/err.txt" \
  && ok "8.164-SinBorrarRama_Frena un origen ilegible se nombra en el aviso" || no "8.164-SinBorrarRama_Frena el aviso no nombra el valor ilegible: $(head -c 300 "$TMP/err.txt")"
rm -f "$HOME/.claude/.tycon-pipeline/bypass.log"
rc=$(corre "TYCON_PR_BY_HAND=1 $AZM --source-branch story/x")
[ "$rc" -eq 0 ] && grep -q "PR_A_MANO" "$HOME/.claude/.tycon-pipeline/bypass.log" 2>/dev/null \
  && ok "8.164-SinBorrarRama_Frena el escape lo saltea y queda registrado" || no "8.164-SinBorrarRama_Frena el escape no pasó o no dejó constancia ($rc)"
# La lista de larga vida del freno es la del paso de merge, la única declarada (§9b.4).
PASO="$AQUI/skills/tycon-merge-to-main/steps/step-09b-create-change-request.md"
del_paso=$(grep -m1 'Declaradas acá' "$PASO" | grep -o '`[a-z]*`' | tr -d '`' | sort | tr '\n' ' ')
del_freno=$(node -e 'process.stdout.write(require(process.argv[1]).RAMAS_DE_LARGA_VIDA.slice().sort().join(" ") + " ")' "$AQUI/scripts/lib/az-pr.js" 2>/dev/null)
[ -n "$del_freno" ] && [ "$(echo "$del_paso" | tr -s ' ')" = "$(echo "$del_freno" | tr -s ' ')" ] \
  && ok "8.164-SinBorrarRama_Frena la lista de larga vida del freno es la de §9b.4 ($del_freno)" || no "8.164-SinBorrarRama_Frena las listas difieren: paso «${del_paso}» · freno «${del_freno}»"

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ pr-sin-auto-complete: todo verde ($casos casos)"; exit 0; } || { echo "❌ pr-sin-auto-complete: $fallos falla(s) de $casos"; exit 1; }
