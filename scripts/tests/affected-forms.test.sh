#!/usr/bin/env bash
# Prueba de affected-forms.js — qué formularios hay que probar y construir por un cambio.
#
# Nace de una pregunta del dev (2026-09-01): "hacemos las pruebas sólo de los formularios que
# cambiaron, pero construimos todos, ¿está bien?". Medido, los dos criterios estaban mal en algún
# producto: en Totora los 4 formularios se importan entre sí (probar sólo lo cambiado pierde
# roturas) y en FRESNO ninguno depende de otro (construir todos tira 32 de 33).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SH_JS="$AQUI/scripts/ci/affected-forms.js"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ afectados: $1"; }
no(){ echo "❌ afectados: $1"; fallos=$((fallos+1)); }

# Mundo: A ← B (B importa de A), C independiente, y una carpeta común.
mundo(){
  R="$TMP/repo"; rm -rf "$R"
  mkdir -p "$R/form-a/src" "$R/form-b/src" "$R/form-c/src" "$R/shared"
  for f in a b c; do echo '{"name":"form-'"$f"'"}' > "$R/form-$f/package.json"; done
  echo '{"name":"raiz"}' > "$R/package.json"
  echo "export const x = 1;" > "$R/form-a/src/x.ts"
  echo "import { x } from '../../form-a/src/x';" > "$R/form-b/src/y.ts"
  echo "export const z = 3;" > "$R/form-c/src/z.ts"
  echo "export const s = 0;" > "$R/shared/s.ts"
  # 🔴 El mundo es un repo git con una deuda YA DECLARADA en la base (2026-09-05). Sin eso no se
  # puede probar lo que importa: qué pasa cuando una declaración de deuda ENTRA o SALE. HEAD~1
  # tiene que existir, así que van dos commits.
  ( cd "$R" \
    && git init -q 2>/dev/null \
    && git config user.email t@t && git config user.name t \
    && printf '%s\n' "$DEUDA_BASE" > pruebas-pendientes.json \
    && git add -A && git commit -qm base \
    && git commit -q --allow-empty -m segunda ) >/dev/null 2>&1
}
# La deuda que existe en la base del mundo: form-c declarado sin pruebas, form-a con 3 en rojo.
DEUDA_BASE='{"sin_pruebas":[{"formulario":"form-c","motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"}],"con_pruebas_en_rojo":[{"formulario":"form-a","fallan":3,"de":10,"motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"}]}'
deuda(){ printf '%s\n' "$1" > "$R/pruebas-pendientes.json"; }
corre_flags(){ local extra="$1"; shift; printf '%s\n' "$@" | node "$SH_JS" --repo "$R" --changed - $extra 2>"$TMP/err.txt"; }
corre(){ printf '%s\n' "$@" | node "$SH_JS" --repo "$R" --changed - 2>"$TMP/err.txt"; }

mundo
# ---------------------------------------------------------------- 1. el grafo sale del CÓDIGO
G=$(node "$SH_JS" --repo "$R" --graph 2>/dev/null)
echo "$G" | grep -q "form-b -> form-a" && ok "deriva del código que form-b depende de form-a" || no "🔴 no detectó el import cruzado: $G"
echo "$G" | grep -q "form-c -> (nada)" && ok "…y que form-c no depende de nadie" || no "inventó una dependencia de form-c"

# ---------------------------------------------------------------- 2. EL CASO DEL DEV
# Tocar A tiene que arrastrar a B (que lo importa) y NO a C.
R1=$(corre "form-a/src/x.ts")
[ "$(echo "$R1" | sort | tr '\n' ' ')" = "form-a form-b " ] \
  && ok "🔴 tocar form-a arrastra a form-b y NO a form-c (dos de tres)" \
  || no "🔴 el conjunto afectado es incorrecto: [$(echo $R1)]"
grep -q "se suman por dependencia: form-b" "$TMP/err.txt" && ok "…y dice cuál se sumó por dependencia" || no "no explicó por qué se sumó form-b"

# ---------------------------------------------------------------- 3. tocar una hoja no arrastra nada
R2=$(corre "form-c/src/z.ts")
[ "$(echo "$R2" | tr '\n' ' ')" = "form-c " ] && ok "tocar un formulario del que nadie depende afecta sólo a ése" || no "arrastró de más: [$(echo $R2)]"

# ---------------------------------------------------------------- 4. la carpeta común afecta a TODOS
R3=$(corre "shared/s.ts")
[ "$(echo "$R3" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] && ok "un cambio en la carpeta común afecta a TODOS" || no "🔴 un cambio compartido no afectó a todos: [$(echo $R3)]"

# ---------------------------------------------------------------- 5. cualquier cosa fuera de un formulario = todos
R4=$(corre "package.json")
[ "$(echo "$R4" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "un archivo de la raíz también afecta a todos (se juzga por posición, no por una lista de nombres)" \
  || no "🔴 un cambio en la raíz no afectó a todos: [$(echo $R4)]"

# ---------------------------------------------------------------- 6. cadena de dependencias
echo "import { y } from '../../form-b/src/y';" > "$R/form-c/src/z.ts"
R5=$(corre "form-a/src/x.ts")
[ "$(echo "$R5" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "sigue la cadena completa (A → B → C), no sólo un salto" \
  || no "🔴 se quedó en el primer salto: [$(echo $R5)]"
echo "export const z = 3;" > "$R/form-c/src/z.ts"

# ---------------------------------------------------------------- 7. FALLA HACIA MÁS TRABAJO
R6=$(node "$SH_JS" --repo "$R" 2>"$TMP/e7.txt")
[ "$(echo "$R6" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "🔴 sin lista de cambios devuelve TODOS (nunca de menos)" \
  || no "🔴 sin lista de cambios NO devolvió todos: [$(echo $R6)]"
R7=$(node "$SH_JS" --repo "$R" --changed "$TMP/no-existe" 2>/dev/null)
[ "$(echo "$R7" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "…y con una lista ilegible, también" || no "🔴 con lista ilegible devolvió [$(echo $R7)]"

# ---------------------------------------------------------------- 8. un import a un paquete de npm NO es una dependencia
echo "import React from 'react';" > "$R/form-c/src/z.ts"
G2=$(node "$SH_JS" --repo "$R" --graph 2>/dev/null)
echo "$G2" | grep -q "form-c -> (nada)" && ok "un import a un paquete de npm no cuenta como dependencia entre formularios" || no "🔴 confundió un paquete de npm con un formulario"

# ---------------------------------------------------------------- 9. el pipeline y la documentación NO afectan
# 🔴 Caso visto en vivo (2026-09-01): un cambio a `azure-pipelines.yml` disparaba las pruebas de
# los 34 formularios. Era la regla de seguridad funcionando —lo de afuera afecta a todos— pero es
# el caso MÁS FRECUENTE (se edita el pipeline todo el tiempo) y probar los 34 no verifica ese
# cambio mejor que probar uno: el pipeline nuevo ya se está usando en esa misma corrida.
R8=$(corre "azure-pipelines.yml")
[ -z "$(echo "$R8" | tr -d '[:space:]')" ] \
  && ok "🔴 tocar sólo el pipeline no afecta a ningún formulario" \
  || no "🔴 un cambio al pipeline afectó a [$(echo $R8)] — vuelve a probar los 34 por nada"
grep -q "no afectan a ningún formulario" "$TMP/err.txt" && ok "…y lo explica" || no "no explicó por qué no afecta a nadie"

# 🔴 2026-09-02: la memoria del agente (.engram/) tampoco — medido: aparece en casi cada merge de
# 4 de los 5 repos y, con el bump por afectados, habría versionado y desplegado TODOS.
R9b=$(corre ".engram/chunks/abc123.jsonl.gz" ".engram/manifest.json")
[ -z "$(echo "$R9b" | tr -d '[:space:]')" ] && ok "la memoria del agente (.engram/) no afecta a ningún formulario" || no "🔴 .engram/ afectó a [$(echo $R9b)] — cada merge versionaría todos"
R9=$(corre "README.md" "docs/algo.md")
[ -z "$(echo "$R9" | tr -d '[:space:]')" ] && ok "la documentación tampoco afecta" || no "la documentación afectó a [$(echo $R9)]"

# 🔴 …pero CUALQUIER OTRA cosa de afuera SIGUE afectando a todos. La lista es corta a propósito:
# cada entrada de más es un agujero por donde pasa una rotura sin que ninguna prueba la vea.
R10=$(corre "package.json")
[ "$(echo "$R10" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "…pero otro archivo de la raíz SIGUE afectando a todos (la excepción no se generalizó)" \
  || no "🔴 la excepción se comió el caso general: [$(echo $R10)]"

# Y si el cambio mezcla el pipeline con código, manda el código.
R11=$(corre "azure-pipelines.yml" "form-a/src/x.ts")
[ "$(echo "$R11" | sort | tr '\n' ' ')" = "form-a form-b " ] \
  && ok "si el cambio mezcla pipeline y código, manda el código (form-a + su dependiente)" \
  || no "🔴 la mezcla dio [$(echo $R11)]"

# ---------------------------------------------------------------- 10. 🔴 "SIN FORMULARIOS" NO ES "NADA AFECTADO"
# (2026-09-02, revisión adversarial B#4). Devolvía vacío + exit 0 en los dos casos, y el README
# prometía "devuelve todos". Un `--repo` mal resuelto dejaba el pull request VERDE sin construir
# nada. Ahora "no encontré ningún formulario" sale 3, para que quien llama pueda distinguirlo.
mkdir -p "$TMP/sin-forms/cosas"; echo x > "$TMP/sin-forms/cosas/a.ts"
printf 'cosas/a.ts\n' | node "$SH_JS" --repo "$TMP/sin-forms" --changed - >"$TMP/o10.txt" 2>"$TMP/e10.txt"; rc=$?
[ "$rc" -eq 3 ] && ok "🔴 un repo sin formularios sale 3 (no vacío + 0, que se lee como 'nada afectado')" || no "🔴 sin formularios salió $rc: $(cat "$TMP/e10.txt")"
node "$SH_JS" --repo "$TMP/sin-forms" --all >/dev/null 2>&1; rc=$?
[ "$rc" -eq 3 ] && ok "…y --all también sale 3 (no hay 'todos' que devolver)" || no "🔴 --all sin formularios salió $rc"
R12=$(corre "azure-pipelines.yml"); rc=$?
[ "$rc" -eq 0 ] && [ -z "$(echo "$R12" | tr -d '[:space:]')" ] && ok "…mientras que 'nada afectado' sigue siendo vacío + 0" || no "🔴 nada afectado salió $rc / [$(echo $R12)]"

# ---------------------------------------------------------------- 11. 🔴 FORMULARIO BORRADO O RENOMBRADO → no afecta a todos
# (2026-09-02, B#3). Sus rutas viejas no caen en ningún formulario, así que por posición eran "de
# afuera" → TODOS (33 bumps en FRESNO por borrar uno). Se reconoce por el package.json en el diff.
mundo
R13=$(corre "form-viejo/package.json" "form-viejo/src/x.ts"); rc=$?
[ "$rc" -eq 0 ] && [ -z "$(echo "$R13" | tr -d '[:space:]')" ] && ok "🔴 borrar un formulario (su package.json en el diff, carpeta ausente) no afecta a nadie" || no "🔴 un formulario borrado afectó a [$(echo $R13)] (rc=$rc)"
grep -q "borrado" "$TMP/err.txt" && ok "…y lo dice" || no "no explicó que era un formulario borrado"
R14=$(corre "form-viejo/package.json" "form-viejo/src/x.ts" "form-c/src/z.ts")
[ "$(echo "$R14" | tr '\n' ' ')" = "form-c " ] && ok "…y si además cambió otro, sólo ése" || no "🔴 con un borrado y un cambio real dio [$(echo $R14)]"
# 🔴 pero una carpeta COMPARTIDA borrada (sin package.json) SIGUE afectando a todos: es de afuera.
R15=$(corre "shared-vieja/s.ts")
[ "$(echo "$R15" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] && ok "…y una carpeta compartida borrada (sin package.json) sigue afectando a todos" || no "🔴 la excepción del borrado se comió una carpeta compartida: [$(echo $R15)]"

# ---------------------------------------------------------------- 12. 🔴 LOS ARCHIVOS DEL PROPIO ARNÉS
# (2026-09-04). Medido sobre los últimos 80 commits de main de los SEIS repos de formularios: lo
# que más disparaba "afecta a TODOS" eran archivos que sólo LEE EL PIPELINE, nunca el compilador.
# Y en main eso no es sólo tiempo: sube la versión de todos los formularios y los redespliega.
# Pasó en un producto del equipo el 2026-09-04 — ocho formularios redesplegados sin una línea de código nueva.
#
# 🔴 2026-09-23: volvió a pasar, y por la carpeta que faltaba en la lista. `.advisors/` guarda la
# evidencia de cada corrida y VIAJA por git a propósito, así que crece en cada story: es la que
# más cambia de todas. En Totora FrontEnd, un `findings.json` de la corrida CO-3 —de hace un
# mes— mandó a versionar y redesplegar los CUATRO formularios.
mundo
for inerte in pruebas-pendientes.json vulnerabilidades-pendientes.json \
              vulnerabilidades-formularios-pendientes.json .tycon/advisors.yaml \
              .gitleaks.toml .gitleaksignore .gitignore \
              .advisors/pipeline-runs/CO-3-20260822-0918/findings.json \
              .advisors/pipeline-runs/SP-1-2026-09-22/review-roster.json \
              .advisors/dod-runtime/SP-1-runtime-matrix.md \
              .advisors/dod-runtime/OC-3-smoke-ledger.jsonl; do
  RI=$(corre "$inerte"); rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$(echo "$RI" | tr -d '[:space:]')" ]; then
    ok "un archivo del arnés ($inerte) no afecta a ningún formulario"
  else
    no "🔴 $inerte afectó a [$(echo $RI)] (rc=$rc) — el arnés se hace trabajo a sí mismo"
  fi
done

# 🔴 Y LO QUE **NO** ENTRA A LA LISTA, que es la mitad que importa: estos SÍ cambian lo que se
# construye, así que tienen que seguir afectando a todos. Sin este caso, agregar una entrada de más
# a NO_AFECTAN pasaría sin que nada se pusiera rojo — y ése es el fallo caro, el que pierde una
# rotura en vez de gastar minutos.
for peligroso in scripts/build-form.js .npmrc package-lock.json; do
  RP=$(corre "$peligroso")
  if [ "$(echo "$RP" | sort | tr '\n' ' ')" = "form-a form-b form-c " ]; then
    ok "…y $peligroso SIGUE afectando a todos (cambia lo que se construye)"
  else
    no "🔴 $peligroso dejó de afectar a todos: [$(echo $RP)] — eso falla hacia MENOS trabajo"
  fi
done

# 🔴 Un archivo inerte JUNTO a un cambio real no puede tapar el cambio real.
RM=$(corre "pruebas-pendientes.json" "form-c/src/z.ts")
[ "$(echo "$RM" | tr '\n' ' ')" = "form-c " ] && ok "…y un inerte junto a un cambio real no tapa el cambio real" || no "🔴 el inerte alteró el conjunto: [$(echo $RM)]"


# ══════════════════════════════════════════════════════════════════════════════════════════════
# LA DECLARACIÓN DE DEUDA DE PRUEBAS: no afecta al paquete, pero sí a quién se JUZGA (2026-09-05)
#
# Caso real: un pull request de los formularios de un producto del equipo. Decía "<formulario> pagó su deuda de
# pruebas" y lo único que hacía era BORRAR su entrada de pruebas-pendientes.json, sin agregar una
# sola prueba. El pull request salió VERDE —el archivo estaba en NO_AFECTAN, así que no se juzgó a
# nadie— y el rojo llegó recién en main, con el merge ya hecho.
# ══════════════════════════════════════════════════════════════════════════════════════════════

# ---- 12. EL CASO REAL: sale una entrada → ese formulario tiene que probarse
mundo
deuda '{"sin_pruebas":[],"con_pruebas_en_rojo":[{"formulario":"form-a","fallan":3,"de":10,"motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"}]}'
RD=$(corre "pruebas-pendientes.json")
[ "$(echo "$RD" | tr '\n' ' ')" = "form-c " ] \
  && ok "🔴 borrar la deuda de un formulario lo manda a probarse (el caso que lo motivó)" \
  || no "🔴 borrar la deuda no mandó a probar a form-c: [$(echo $RD)] — verde sin haber probado nada"
grep -q "cambió la declaración de deuda de: form-c" "$TMP/err.txt" && ok "…y dice por qué se sumó" || no "no explicó por qué se sumó form-c"

# ---- 13. y en el otro sentido: entra una entrada → también se juzga
# (el veredicto falla si un formulario declarado SIN pruebas ejecuta pruebas: la lista no puede
#  sobrevivir a la deuda que declara, así que declarar también hay que verificarlo)
mundo
deuda '{"sin_pruebas":[{"formulario":"form-c","motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"},{"formulario":"form-a","motivo":"m","fecha":"2026-09-05","revision":"2026-12-01"}],"con_pruebas_en_rojo":[]}'
RE=$(corre "pruebas-pendientes.json")
[ "$(echo "$RE" | sort | tr '\n' ' ')" = "form-a form-b " ] \
  && ok "declarar una deuda nueva también manda a probar (y arrastra a quien lo importa)" \
  || no "🔴 declarar deuda no se juzgó bien: [$(echo $RE)]"

# ---- 14. mover el tope de las que fallan tampoco puede pasar sin que nadie mire
mundo
deuda '{"sin_pruebas":[{"formulario":"form-c","motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"}],"con_pruebas_en_rojo":[{"formulario":"form-a","fallan":9,"de":10,"motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"}]}'
RF=$(corre "pruebas-pendientes.json")
[ "$(echo "$RF" | sort | tr '\n' ' ')" = "form-a form-b " ] \
  && ok "subir el tope de pruebas en rojo manda a probar ese formulario" \
  || no "🔴 el tope se movió sin que nadie lo verificara: [$(echo $RF)]"

# ---- 15. 🔴 Y NO AL REVÉS: editar la prosa del archivo no puede mandar a probar a nadie.
# Sin este caso, la forma barata de "arreglar" el agujero sería mandar a probar TODOS cada vez que
# el archivo se toca — y un control que hace trabajo de más por nada es el que alguien apaga.
mundo
deuda "$(node -e 'const d=JSON.parse(process.argv[1]); d._lea_esto_primero=["texto nuevo"]; console.log(JSON.stringify(d))' "$DEUDA_BASE")"
RG=$(corre "pruebas-pendientes.json"); rc=$?
if [ "$rc" -eq 0 ] && [ -z "$(echo "$RG" | tr -d '[:space:]')" ]; then
  ok "editar sólo la prosa del archivo de deuda no manda a probar a nadie"
else
  no "🔴 tocar la prosa mandó a probar [$(echo $RG)] — ruido que hace que se apague el control"
fi

# ---- 16. el bump de versión NO cambia de conducta (--no-debt)
# Tocar la declaración no cambia una línea del código construido: versionar por eso redesplegaría
# formularios idénticos, que es justo lo que NO_AFECTAN vino a evitar (un producto del equipo, 2026-09-04).
mundo
deuda '{"sin_pruebas":[],"con_pruebas_en_rojo":[]}'
RH=$(corre_flags "--no-debt" "pruebas-pendientes.json"); rc=$?
if [ "$rc" -eq 0 ] && [ -z "$(echo "$RH" | tr -d '[:space:]')" ]; then
  ok "🔴 con --no-debt (el bump de versión) la declaración sigue sin afectar a nadie"
else
  no "🔴 --no-debt versionó [$(echo $RH)] — redespliegue de código idéntico"
fi

# ---- 17. no poder saber qué decía antes = TODOS, nunca "nada"
mundo
rm -rf "$R/.git"
RI2=$(corre "pruebas-pendientes.json")
[ "$(echo "$RI2" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "sin git no se puede saber qué decía la deuda antes → TODOS, el lado seguro" \
  || no "🔴 sin git devolvió [$(echo $RI2)] — 'no sé' no puede leerse como 'nada'"

# ---- 18. archivo de deuda ilegible = TODOS
mundo
deuda '{ esto no es json'
RJ=$(corre "pruebas-pendientes.json")
[ "$(echo "$RJ" | sort | tr '\n' ' ')" = "form-a form-b form-c " ] \
  && ok "una deuda ilegible devuelve TODOS en vez de vaciar el conjunto" \
  || no "🔴 deuda ilegible devolvió [$(echo $RJ)]"

# ---- 19. una deuda sobre un formulario que no existe no rompe ni ensucia el conjunto
mundo
deuda '{"sin_pruebas":[{"formulario":"form-c","motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"},{"formulario":"form-fantasma","motivo":"m","fecha":"2026-09-05","revision":"2026-12-01"}],"con_pruebas_en_rojo":[{"formulario":"form-a","fallan":3,"de":10,"motivo":"m","fecha":"2026-09-01","revision":"2026-12-01"}]}'
RK=$(corre "pruebas-pendientes.json"); rc=$?
if [ "$rc" -eq 0 ] && [ -z "$(echo "$RK" | tr -d '[:space:]')" ]; then
  ok "un formulario fantasma en la deuda se ignora acá (lo juzga la validación de la deuda)"
else
  no "🔴 el fantasma ensució el conjunto: [$(echo $RK)] (rc=$rc)"
fi

echo "─────────────"
if [ "$fallos" -eq 0 ]; then echo "✅ formularios-afectados: todo verde"; exit 0; else echo "❌ formularios-afectados: $fallos falla(s)"; exit 1; fi
