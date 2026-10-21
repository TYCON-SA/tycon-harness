#!/usr/bin/env bash
# deploy-record.test.sh — el ayudante que anota cada despliegue en su corrida.
#
# Qué se prueba acá, con el ayudante cargado por `source` y sin red:
#   · la CLAVE identifica el despliegue y no la corrida (T2)
#   · el entorno: declarado primero, derivado después, y la discrepancia se dice (T9)
#   · fuera de una corrida de Azure no se anota nada (T10)
#   · texto de afuera no puede fijar comandos de la corrida (T13)
#   · la línea tiene exactamente las claves que documenta la cabecera, leídas DE la cabecera (T14)
# Los casos que corren los humos de verdad (con su curl de mentira) viven en smoke.test.sh.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AYUDANTE="$DIR/../ci/deploy-record.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OK=0; MAL=0
ok() { echo "✅ registro-despliegue: $1"; OK=$((OK+1)); }
no() { echo "❌ registro-despliegue: $1"; MAL=$((MAL+1)); }
command -v jq >/dev/null || { echo "⚠️ registro-despliegue: falta jq — suite salteada (no es verde)"; exit 0; }
[ -f "$AYUDANTE" ] || { echo "❌ registro-despliegue: no existe $AYUDANTE"; exit 1; }

# Una corrida simulada: todas las variables que el agente de Azure pone, en un entorno limpio.
limpio() { # limpio <var=valor>... -- <comando bash>
  local asignaciones=()
  while [ "$1" != "--" ]; do asignaciones+=("$1"); shift; done; shift
  env -i PATH="$PATH" HOME="$TMP" "${asignaciones[@]}" bash -c "set -u; . '$AYUDANTE'; $*"
}
CORRIDA=(TF_BUILD=True SYSTEM_TEAMPROJECT=Totora BUILD_REPOSITORY_NAME=Backend SYSTEM_STAGENAME=Deploy SYSTEM_JOBNAME=DeployToStaging BUILD_BUILDID=100)
linea() { grep '^\[registro-despliegue\] ' | sed 's/^\[registro-despliegue\] //'; }
nuevo_tmp() { local d; d="$(mktemp -d "$TMP/job.XXXXXX")"; printf '%s' "$d"; }

# ── T2 · la clave identifica el despliegue, no la corrida ────────────────────────────────────────
J1=$(nuevo_tmp); J2=$(nuevo_tmp); J3=$(nuevo_tmp); J4=$(nuevo_tmp); J5=$(nuevo_tmp); J6=$(nuevo_tmp)
C1=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$J1" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234' | linea | jq -r .clave)
C2=$(limpio "${CORRIDA[@]}" BUILD_BUILDID=999 AGENT_TEMPDIRECTORY="$J2" -- 'sleep 1; registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234def' | linea | jq -r .clave)
C3=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$J3" -- 'registro_despliegue desplegado plugin totorabackend 1.0.215 abc1234' | linea | jq -r .clave)
C4=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$J4" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 9999999' | linea | jq -r .clave)
C5=$(limpio "${CORRIDA[@]}" SYSTEM_STAGENAME=DeployAcmeStaging SYSTEM_JOBNAME=DeployToAcmeStaging AGENT_TEMPDIRECTORY="$J5" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234' | linea | jq -r .clave)
C6=$(limpio "${CORRIDA[@]}" ENVIRONMENT_NAME=production AGENT_TEMPDIRECTORY="$J6" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234' | linea | jq -r .clave)
if printf '%s' "$C1" | grep -E '^d-[0-9a-f]{16}$' >/dev/null; then ok "T2 la clave tiene forma d-<16 hexadecimales> ($C1)"; else no "T2 la clave no tiene forma d-<16 hex>: '$C1'"; fi
[ -n "$C1" ] && [ "$C1" = "$C2" ] && ok "T2 otra ejecución (otro build, otro ts, hash largo con el mismo prefijo) → MISMA clave" || no "🔴 T2 dos ejecuciones del mismo despliegue dan claves distintas ($C1 vs $C2) — la 2.11 lo contaría dos veces"
[ "$C1" != "$C3" ] && ok "T2 otra versión → otra clave" || no "T2 otra versión dio la misma clave"
[ "$C1" != "$C4" ] && ok "T2 otro hash → otra clave" || no "T2 otro hash dio la misma clave"
[ "$C1" != "$C5" ] && ok "T2 el otro staging de Pacara (otro stage/job) → otra clave" || no "🔴 T2 los dos stagings de la misma ejecución dan la misma clave — uno se come al otro"
[ "$C1" != "$C6" ] && ok "T2 otro entorno → otra clave" || no "T2 otro entorno dio la misma clave"

# Sin hash: null en la línea y la clave igual existe (con sin-hash adentro, no con un hash inventado)
J7=$(nuevo_tmp)
L7=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$J7" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 ""' | linea)
[ "$(printf '%s' "$L7" | jq -r '.hash')" = "null" ] && printf '%s' "$L7" | jq -e '.clave|test("^d-")' >/dev/null && ok "T2 sin hash → hash null y clave presente" || no "T2 sin hash no dio hash null con clave: $L7"

# ── T9 · entorno declarado primero, derivado después ────────────────────────────────────────────
entorno_de() { # entorno_de <agent-tmp> <var=valor>... → imprime "entorno fuente" y el stdout del aviso aparte
  local d="$1"; shift
  env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True AGENT_TEMPDIRECTORY="$d" "$@" bash -c "set -u; . '$AYUDANTE'; registro_entorno > '$d/aviso.txt'; echo \"\$REG_ENTORNO \$REG_ENTORNO_FUENTE\""
}
D=$(nuevo_tmp); mkdir -p "$D/tycon-despliegue"; echo staging > "$D/tycon-despliegue/entorno"
R=$(entorno_de "$D" ENVIRONMENT_NAME=production)
[ "$R" = "staging declarado" ] && ok "T9 declarado staging gana sobre el derivado" || no "T9 declarado staging con ENVIRONMENT_NAME=production dio '$R'"
grep -q 'logissue type=warning' "$D/aviso.txt" && grep -q 'staging' "$D/aviso.txt" && grep -q 'produccion' "$D/aviso.txt" && ok "T9 …y la discrepancia se avisa con los dos valores" || no "🔴 T9 la regla derivada contradice al declarado y no se avisó: $(cat "$D/aviso.txt")"
D=$(nuevo_tmp); mkdir -p "$D/tycon-despliegue"; echo staging > "$D/tycon-despliegue/entorno"
R=$(entorno_de "$D")
[ "$R" = "staging declarado" ] && [ ! -s "$D/aviso.txt" ] && ok "T9 declarado y derivado coinciden → sin aviso" || no "T9 coincidencia dio '$R' o avisó de más: $(cat "$D/aviso.txt")"
D=$(nuevo_tmp)
R=$(entorno_de "$D" ENVIRONMENT_NAME=prod-totora)
[ "$R" = "produccion derivado" ] && ok "T9 ENVIRONMENT_NAME=prod-totora (Pacara) → produccion, sin comparar contra un literal" || no "🔴 T9 prod-totora dio '$R' — comparar contra 'production' pierde Pacara"
D=$(nuevo_tmp)
R=$(entorno_de "$D" RESOURCES_PIPELINE_CI_RUNID=9)
[ "$R" = "produccion derivado" ] && ok "T9 RESOURCES_PIPELINE_CI_RUNID sola → produccion" || no "T9 RESOURCES_PIPELINE_CI_RUNID dio '$R'"
D=$(nuevo_tmp)
R=$(entorno_de "$D")
[ "$R" = "staging derivado" ] && ok "T9 sin nada → staging derivado" || no "T9 sin nada dio '$R'"
D=$(nuevo_tmp); mkdir -p "$D/tycon-despliegue"; echo prod > "$D/tycon-despliegue/entorno"
R=$(entorno_de "$D" ENVIRONMENT_NAME=production)
[ "$R" = "produccion derivado" ] && ok "T9 un archivo declarado con 'prod' (inválido) se ignora y se deriva" || no "T9 declarado inválido dio '$R'"
D=$(nuevo_tmp)
env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_declarar_entorno produccion" > "$D/out.txt"
[ "$(cat "$D/tycon-despliegue/entorno" 2>/dev/null)" = "produccion" ] && ok "T9 registro_declarar_entorno produccion deja el archivo del job" || no "T9 declarar no dejó el archivo"
# El entorno se recibe también con el nombre de la opción de deploy-plugin.sh («production») y se
# sigue GRABANDO «produccion», el valor que leen los lectores del registro y los registros ya escritos.
D=$(nuevo_tmp)
env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_declarar_entorno production; echo rc=\$?" > "$D/out.txt"
[ "$(cat "$D/tycon-despliegue/entorno" 2>/dev/null)" = "produccion" ] && grep -q 'rc=0' "$D/out.txt" && ! grep -q 'logissue' "$D/out.txt" \
  && ok "T9 registro_declarar_entorno production deja «produccion» en el archivo del job, sin aviso" \
  || no "🔴 T9 declarar 'production' no grabó «produccion» o avisó: $(cat "$D/out.txt") · archivo=$(cat "$D/tycon-despliegue/entorno" 2>/dev/null)"
D=$(nuevo_tmp)
env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_declarar_entorno prod" > "$D/out.txt"
[ ! -f "$D/tycon-despliegue/entorno" ] && grep -q 'logissue type=warning' "$D/out.txt" && ok "T9 declarar 'prod' no escribe el archivo y avisa" || no "T9 declarar un valor inválido escribió o no avisó"

# Un --environment explícito que no se pudo dejar para el humo no se pierde callado
SAL=$(env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True AGENT_TEMPDIRECTORY="$TMP/no-existe/job" bash -c "set -u; . '$AYUDANTE'; registro_declarar_entorno produccion; echo rc=\$?")
printf '%s' "$SAL" | grep 'logissue type=warning' >/dev/null && printf '%s' "$SAL" | grep 'rc=1' >/dev/null && ok "T9 sin directorio del job, declarar el entorno avisa y devuelve 1" || no "🔴 T9 declarar sin directorio del job se perdió en silencio: $SAL"

# Perder la marca (o la etiqueta) no escribe nada por stderr — el 2>/dev/null tiene que tapar la redirección
D=$(nuevo_tmp); mkdir -p "$D/tycon-despliegue"; chmod 555 "$D/tycon-despliegue"
env -i PATH="$PATH" HOME="$TMP" "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234; echo rc=\$?" >"$D/../out.txt" 2>"$D/../err.txt"
if [ -w "$D/tycon-despliegue" ]; then ok "T9 (se corre como root: el directorio de sólo lectura no aplica — caso no medido acá)"
else
  [ ! -s "$D/../err.txt" ] && grep -q '^\[registro-despliegue\]' "$D/../out.txt" && grep -q 'rc=0' "$D/../out.txt" && ok "T9 sin poder escribir la marca: se anota, rc 0 y NADA por stderr" || no "🔴 T9 perder la marca escribió por stderr: $(head -2 "$D/../err.txt")"
  env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_declarar_entorno staging" >"$D/../out2.txt" 2>"$D/../err2.txt"
  [ ! -s "$D/../err2.txt" ] && grep -q 'logissue type=warning' "$D/../out2.txt" && ok "T9 sin poder escribir el entorno: avisa por stdout y NADA por stderr" || no "🔴 T9 declarar sin permiso escribió por stderr: $(head -2 "$D/../err2.txt")"
fi
chmod 755 "$D/tycon-despliegue"

# ── T10 · fuera de Azure no se anota nada ────────────────────────────────────────────────────────
for tf in "" False true; do
  D=$(nuevo_tmp)
  if [ -n "$tf" ]; then SAL=$(env -i PATH="$PATH" HOME="$TMP" TF_BUILD="$tf" AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234; registro_declarar_entorno staging; echo rc=\$?" 2>&1)
  else SAL=$(env -i PATH="$PATH" HOME="$TMP" AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234; registro_declarar_entorno staging; echo rc=\$?" 2>&1); fi
  if [ "$SAL" = "rc=0" ] && [ ! -e "$D/tycon-despliegue" ]; then ok "T10 TF_BUILD='${tf:-<ausente>}' → ni línea, ni etiqueta, ni aviso, ni archivos"; else no "🔴 T10 TF_BUILD='${tf:-<ausente>}' anotó algo fuera de Azure: $SAL"; fi
done
# Cargar el ayudante no imprime nada ni cambia las opciones del shell que lo carga
SAL=$(env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True bash -c "set -uo pipefail; before=\$-; . '$AYUDANTE'; [ \"\$-\" = \"\$before\" ] && echo iguales" 2>&1)
[ "$SAL" = "iguales" ] && ok "T10 cargar el ayudante no imprime ni cambia set -u/pipefail del guion" || no "T10 cargar el ayudante imprimió o cambió opciones: '$SAL'"

# ── T13 · texto de afuera no fija comandos de la corrida ─────────────────────────────────────────
D=$(nuevo_tmp)
SAL=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$D" -- 'registro_despliegue desplegado plugin "x##vso[task.setvariable variable=a]1" 1.0.214 abc1234; echo rc=$?')
printf '%s' "$SAL" | grep '^\[registro-despliegue\]' >/dev/null && no "🔴 T13 un artefacto con ##vso[ se anotó" || ok "T13 artefacto con ##vso[ → no se anota"
printf '%s' "$SAL" | grep '##vso\[task.setvariable' >/dev/null && no "🔴 T13 el ##vso[task.setvariable llegó a stdout: $SAL" || ok "T13 …y el comando no aparece en ningún lado de la salida"
printf '%s' "$SAL" | grep 'logissue type=warning' >/dev/null && printf '%s' "$SAL" | grep 'rc=1' >/dev/null && ok "T13 …avisa con el nombre saneado y devuelve 1" || no "T13 no avisó o no devolvió 1: $SAL"
D=$(nuevo_tmp)
SAL=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$D" -- 'registro_despliegue desplegado plugin totorabackend 1.0:2 abc1234; echo rc=$?')
printf '%s' "$SAL" | grep '^\[registro-despliegue\]\|addbuildtag' >/dev/null && no "🔴 T13 una versión con ':' se anotó (Azure rechaza la etiqueta)" || ok "T13 versión con ':' → no se anota"
D=$(nuevo_tmp)
SAL=$(limpio "${CORRIDA[@]}" 'SYSTEM_STAGENAME=Deploy; rm -rf x' AGENT_TEMPDIRECTORY="$D" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234; echo rc=$?')
printf '%s' "$SAL" | grep '^\[registro-despliegue\]' >/dev/null && no "🔴 T13 un destino con espacios y ';' se anotó" || ok "T13 destino fuera de su juego → no se anota"
D=$(nuevo_tmp)
L=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$D" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 zzz' | linea)
[ "$(printf '%s' "$L" | jq -r .hash 2>/dev/null)" = "null" ] && ok "T13 hash inválido → hash null, y el despliegue sí se anota" || no "T13 hash inválido no quedó null o no se anotó: '$L'"
# Ningún ##vso[ inesperado: sólo addbuildtag y logissue
D=$(nuevo_tmp)
SAL=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$D" ENVIRONMENT_NAME=production -- 'mkdir -p "$AGENT_TEMPDIRECTORY/tycon-despliegue"; echo staging > "$AGENT_TEMPDIRECTORY/tycon-despliegue/entorno"; registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234')
OTROS=$(printf '%s\n' "$SAL" | grep -o '##vso\[[a-z.]*' | grep -v -e '##vso\[build.addbuildtag' -e '##vso\[task.logissue' || true)
[ -z "$OTROS" ] && ok "T13 los únicos comandos de la ejecución son addbuildtag y logissue" || no "T13 apareció otro comando: $OTROS"

# ── T14 · la línea tiene exactamente las claves que documenta la cabecera ───────────────────────
DOC=$(grep -m1 '^# CLAVES:' "$AYUDANTE" | sed 's/^# CLAVES://' | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ')
[ -n "$DOC" ] && ok "T14 la cabecera documenta las claves (# CLAVES:)" || no "T14 la cabecera no tiene la línea # CLAVES:"
D=$(nuevo_tmp)
L=$(limpio "${CORRIDA[@]}" AGENT_TEMPDIRECTORY="$D" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234' | linea)
REAL=$(printf '%s' "$L" | jq -r 'keys[]' 2>/dev/null | sort | tr '\n' ' ')
[ -n "$REAL" ] && [ "$REAL" = "$DOC" ] && ok "T14 la línea tiene exactamente las claves documentadas" || no "🔴 T14 claves de la línea ($REAL) ≠ documentadas ($DOC)"
[ "$(printf '%s' "$DOC" | wc -w | tr -d ' ')" = "15" ] && ok "T14 son 15 claves" || no "T14 la cabecera no documenta 15 claves: $DOC"
grep -q '^# PREFIJO: \[registro-despliegue\]' "$AYUDANTE" && ok "T14 la cabecera documenta el prefijo" || no "T14 la cabecera no documenta el prefijo"
for et in 'desplegado' '<artefacto>-<version>' 'despliegue-intentado'; do
  grep '^# ETIQUETAS:' "$AYUDANTE" | grep -F "$et" >/dev/null && ok "T14 la cabecera documenta la etiqueta $et" || no "T14 la cabecera no documenta la etiqueta $et"
done
printf '%s' "$L" | jq -e '.v==1 and .estado=="desplegado" and .tipo=="plugin" and .entorno=="staging" and .entorno_fuente=="derivado" and .proyecto=="Totora" and .repo=="Backend" and .destino=="Deploy/DeployToStaging" and .artefacto=="totorabackend" and .version=="1.0.214" and .hash=="abc1234" and .build=="100" and .build_ci=="100" and (.ts|test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' >/dev/null && ok "T14 cada clave vale lo que dice el contrato" || no "T14 valores fuera de contrato: $L"
D=$(nuevo_tmp)
L=$(limpio "${CORRIDA[@]}" RESOURCES_PIPELINE_CI_RUNID=77 AGENT_TEMPDIRECTORY="$D" -- 'registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234' | linea)
[ "$(printf '%s' "$L" | jq -r .build_ci)" = "77" ] && [ "$(printf '%s' "$L" | jq -r .build)" = "100" ] && ok "T14 en producción build_ci es el CI promovido y build el de producción" || no "T14 build/build_ci mal: $L"
D=$(nuevo_tmp)
L=$(env -i PATH="$PATH" HOME="$TMP" TF_BUILD=True AGENT_TEMPDIRECTORY="$D" bash -c "set -u; . '$AYUDANTE'; registro_despliegue desplegado plugin totorabackend 1.0.214 abc1234" | linea)
printf '%s' "$L" | jq -e '.proyecto==null and .repo==null and .destino==null and .build==null and .build_ci==null' >/dev/null && ok "T14 variables de Azure ausentes → null, nunca \"\"" || no "T14 ausentes no quedaron null: $L"

echo "─────────────"
if [ "$MAL" -eq 0 ]; then echo "✅ registro-despliegue: todo verde ($OK casos)"; exit 0; fi
echo "❌ registro-despliegue: $MAL falla(s) de $((OK+MAL))"; exit 1
