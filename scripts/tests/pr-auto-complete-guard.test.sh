#!/usr/bin/env bash
# Prueba de pr-auto-complete-guard.js — el freno que impide armar un pull request A MANO sin
# auto-complete, o con squash.
#
# 🔴 Nace de un pull request del backend de un producto del equipo (2026-09-03): el skill de merge sabía crear el PR
# bien y el agente lo creó suelto, sin auto-complete. Lo vio el dev en la pantalla de Azure. Una
# regla escrita («usá el skill») es justo lo que falló; esto no depende de que nadie se acuerde.
#
# 🔴 Los casos 11 a 18 son los SEIS caminos por los que la primera versión se dejaba pasar, cazados
# por la revisión adversarial del mismo día. Sin ellos, un verde no significaría nada.
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

# El sujeto de esta prueba es un script de Node: pedirle a python3 que arme el JSON metía un
# intérprete más (y 39 arranques) en la suite diaria, que ya se pasó de tiempo una vez.
# 🔴 HOME aislado (2026-09-06): el hook deja constancia de cada escape en
# `$HOME/.claude/.tycon-pipeline/bypass.log`, y esta suite lo ejercita (caso 8) — sin aislar,
# escribía escapes de PRUEBA en el registro de escapes HUMANOS del dev y después afirmaba sobre
# ese registro vivo. Medido: los 9 escapes reales del log no tenían la huella del test, o sea que
# el assert pasaba con datos de otro. Misma familia que el hallazgo #3 del pase del 2026-09-06.
export HOME="$TMP/home"; mkdir -p "$HOME/.claude/.tycon-pipeline"
corre(){ # <comando>
  node -e 'process.stdout.write(JSON.stringify({tool_input:{command:process.argv[1]}}))' "$1" \
    | node "$HOOK" >"$TMP/out.txt" 2>"$TMP/err.txt"
  echo $?
}
BASE='az repos pr create --organization https://dev.azure.com/org-del-equipo --project Ceibo --repository CeiboBackend --source-branch fix/health-build-info --target-branch main --title "fix(health): x"'
BIEN="$BASE --auto-complete true --squash false"

# ---------------------------------------------------------------- 1. 🔴 EL CASO REAL (tal cual se tipeó)
rc=$(corre "$BASE --description \"a\" \"\" \"b\" -o json")
[ "$rc" -eq 2 ] && ok "🔴 el comando del caso real (sin auto-complete) queda BLOQUEADO (exit 2)" || no "🔴 dejó pasar el comando del caso real ($rc)"
grep -q "tycon-merge-to-main" "$TMP/err.txt" && ok "…y dice el camino: el skill de merge" || no "no nombró el skill"
grep -q "auto-complete true --squash false" "$TMP/err.txt" && ok "…y las dos banderas exactas si igual va a mano" || no "no dijo las banderas"
grep -q "source=fix/health-build-info" "$TMP/err.txt" && ok "…con la rama del comando ya puesta en la invocación del skill" || no "no propagó la rama"

# ---------------------------------------------------------------- 2. el comando del skill pasa
rc=$(corre "$BASE --description \"\$(cat /tmp/pr-body.md)\" --auto-complete true --delete-source-branch false --squash false -o json")
[ "$rc" -eq 0 ] && ok "el comando que arma el skill (auto-complete true, squash false) pasa" || no "🔴 bloqueó al skill ($rc)"

# ---------------------------------------------------------------- 3. auto-complete puesto pero con squash → bloquea
rc=$(corre "$BASE --auto-complete true --squash true")
[ "$rc" -eq 2 ] && ok "🔴 con auto-complete pero --squash true, BLOQUEA (rompe las notas de versión)" || no "🔴 dejó pasar el squash ($rc)"
grep -q "notas de versión" "$TMP/err.txt" && ok "…y explica por qué el squash rompe" || no "no explicó el squash"

# ---------------------------------------------------------------- 4. auto-complete en false explícito → bloquea
rc=$(corre "$BASE --auto-complete false --squash false")
[ "$rc" -eq 2 ] && ok "--auto-complete false explícito también bloquea" || no "🔴 dejó pasar --auto-complete false ($rc)"

# ---------------------------------------------------------------- 5. la forma --flag=valor también se entiende
rc=$(corre "$BASE --auto-complete=true --squash=false")
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
rc=$(corre "$BASE --auto-complete --squash false")
[ "$rc" -eq 0 ] && ok "'--auto-complete' a secas (= true) pasa" || no "🔴 bloqueó '--auto-complete' a secas, que para az es true ($rc)"

# ---------------------------------------------------------------- 14. 🔴 los sinónimos de az: yes/no/1/0/y/n/t/f
rc=$(corre "$BASE --auto-complete yes --squash no")
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
rc=$(corre "$(printf 'az repos pr create --org https://x --project P --repository R \\\n  --source-branch fix/x --target-branch main --title t \\\n  --auto-complete \\\n  true \\\n  --squash false')")
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

# ---------------------------------------------------------------- 19. 🔴 2ª REVISIÓN: el valor ENTRE COMILLAS es válido para az
rc=$(corre "$BASE --auto-complete \"true\" --squash 'false'")
[ "$rc" -eq 0 ] && ok "🔴 '--auto-complete \"true\"' (comillas en el VALOR) pasa: es válido para az" || no "🔴 bloqueó un comando correcto por las comillas ($rc) — un freno que corta el camino bueno se apaga"
rc=$(corre "az repos pr update --id 5 --squash \"true\"")
[ "$rc" -eq 2 ] && ok "🔴 …y '--squash \"true\"' en un update sigue BLOQUEANDO" || no "🔴 las comillas abrieron la puerta del update ($rc)"

# ---------------------------------------------------------------- 20. 🔴 2ª REVISIÓN: `&` de fondo también separa
rc=$(corre "$BIEN & az repos pr create --org https://x --source-branch ci/b --target-branch main --title t")
[ "$rc" -eq 2 ] && ok "🔴 dos creaciones separadas por '&' se juzgan por separado" || no "🔴 la segunda heredó las banderas por el '&' ($rc)"
rc=$(corre "$BIEN 2>&1")
[ "$rc" -eq 0 ] && ok "…y '2>&1' NO se confunde con un separador" || no "🔴 leyó la redirección como separador ($rc)"

# ---------------------------------------------------------------- 21. 🔴 2ª REVISIÓN: az acepta opciones globales antes del grupo
rc=$(corre "az -o json repos pr create --org https://x --source-branch ci/a --target-branch main --title t")
[ "$rc" -eq 2 ] && ok "🔴 'az -o json repos pr create' NO esquiva el freno" || no "🔴 las opciones globales lo esquivaron ($rc)"
rc=$(corre "az repos pr \\
  create --org https://x --source-branch ci/a --target-branch main --title t")
[ "$rc" -eq 2 ] && ok "🔴 una continuación de línea entre 'pr' y 'create' tampoco lo esquiva" || no "🔴 la continuación lo esquivó ($rc)"

# ---------------------------------------------------------------- 22. 🔴 2ª REVISIÓN: publicar un borrador es la tercera puerta
rc=$(corre "az repos pr update --id 5 --draft false")
[ "$rc" -eq 2 ] && ok "🔴 publicar un borrador ('--draft false') sin las banderas BLOQUEA" || no "🔴 el camino borrador→publicar quedó abierto ($rc)"
rc=$(corre "az repos pr update --id 5 --draft false --auto-complete true --squash false")
[ "$rc" -eq 0 ] && ok "…y publicarlo CON las dos banderas pasa" || no "🔴 bloqueó una publicación correcta ($rc)"

# ---------------------------------------------------------------- 23. 🔴 2ª REVISIÓN: código adentro de una cadena que ejecuta otro intérprete
rc=$(corre "bash -c \"az repos pr create --target-branch main --title t\"")
[ "$rc" -eq 2 ] && ok "🔴 'bash -c \"az repos pr create…\"' BLOQUEA: no puedo leer lo que se ejecuta" || no "🔴 el intérprete lo escondió ($rc)"
rc=$(corre "echo \"az repos pr create --target-branch main\"")
[ "$rc" -eq 0 ] && ok "…pero un 'echo' con el mismo texto NO se toca: echo no ejecuta nada" || no "🔴 bloqueó un echo ($rc)"

# ---------------------------------------------------------------- 24. 🔴 2ª REVISIÓN: sólo los PR a main
rc=$(corre "az repos pr create --org https://x --source-branch feat/x --target-branch dev --title t")
[ "$rc" -eq 0 ] && ok "🔴 un PR a 'dev' NO se toca: el skill es el camino de main, no de dev" || no "🔴 frenó un PR a dev con un consejo equivocado ($rc)"

# ---------------------------------------------------------------- 25. 🔴 2ª REVISIÓN: la rama del mensaje, tal cual
rc=$(corre "az repos pr create --org https://x --source-branch fix/Health-Build --target-branch main --title t")
grep -q "source=fix/Health-Build" "$TMP/err.txt" && ok "🔴 la rama del mensaje conserva las mayúsculas (git distingue)" || no "🔴 el mensaje sugiere una rama que no existe"
rc=$(corre "az repos pr create --org https://x -s fix/corta -t main --title t")
grep -q "source=fix/corta" "$TMP/err.txt" && ok "…y entiende la forma corta '-s'" || no "🔴 no leyó '-s' y sugiere <rama>"

# ---------------------------------------------------------------- 26. 🔴 2ª REVISIÓN: un comentario con apóstrofo no desarma el freno
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
rc=$(corre "$BASE --auto-complete true --squash false --target-branch refs/heads/main")
[ "$rc" -eq 0 ] && ok "el destino escrito como 'refs/heads/main' se reconoce igual" || no "🔴 no reconoció refs/heads/main ($rc)"
rc=$(corre "az repos pr update --id 42 --auto-complete false")
grep -q "va a main" "$TMP/err.txt" && no "🔴 el mensaje del update afirma 'va a main' y el update NO dice a qué rama apunta" || ok "🔴 el mensaje del update NO afirma 'a main': ese comando no lleva el destino"

echo "─────────────"
[ "$fallos" -eq 0 ] && { echo "✅ pr-sin-auto-complete: todo verde ($casos casos)"; exit 0; } || { echo "❌ pr-sin-auto-complete: $fallos falla(s) de $casos"; exit 1; }
