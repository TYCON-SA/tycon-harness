#!/usr/bin/env bash
# Prueba de manifest-engram.js — el índice de memoria de engram se cruza con sus archivos (story 1.6).
#
# La memoria del equipo viaja por git en dos piezas: los chunks (`.engram/chunks/<id>.jsonl.gz`) y el
# índice (`.engram/manifest.json`). `engram sync --import` lee el ÍNDICE: un chunk sin entrada no
# existe para las demás máquinas, y no da error. El 2026-09-17 el commit ad4f498 dejó 205 entradas
# para 210 archivos y nada lo objetó. Acá se prueba el criterio único (la lib), la reparación, y los
# dos consumidores que delegan en ella (el audit y el rescate). El hook y el portón tienen su propia
# red: el banco de controles (04-rebuild-engram.json) y `tycon-ci-gate.js --selftest`.
#
# Sin engram real, sin red, con HOME falso y repos git de mentira. Portable a Linux (corre en el
# nocturno de Azure): nada BSD-only — lo verifica el último caso de esta misma suite.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$AQUI/scripts/lib/manifest-engram.js"
AUDIT="$AQUI/scripts/lib/harness-audit.js"
RESCATE="$AQUI/scripts/setup/engram-rescue-unexported.js"
YO="$AQUI/scripts/tests/manifest-engram.test.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fallos=0
ok(){ echo "✅ manifest-engram: $1"; }
no(){ echo "❌ manifest-engram: $1"; fallos=$((fallos+1)); }

# ── Entorno de mentira ──────────────────────────────────────────────────────────────────────────
# HOME falso: ni el gitconfig del dev ni su ~/.claude entran a la prueba.
export HOME="$TMP/home"; mkdir -p "$HOME"
# story 8.3: la integración engram se declara por variable — esta HOME no tiene perfil del equipo, y sin la llave los
# comandos de engram dicen «apagado» y salen 0 en vez de hacer lo que esta suite mide (con dobles, sin red).
export TYCON_ENGRAM=1
# PATH sin engram: node va por symlink (con nvm vive fuera de /usr/bin); git, gzip y cmp salen de
# /usr/bin y /bin en macOS y en Linux. La rama «no hay importador» se prueba por el camino REAL.
mkdir -p "$TMP/bin"; ln -s "$(command -v node)" "$TMP/bin/node"
export PATH="$TMP/bin:/usr/bin:/bin"
unset ENGRAM_BIN ENGRAM_DATA_DIR TYCON_REPOS_ROOT 2>/dev/null || true
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# Sin los ganchos del dev: estos repos son de mentira (mismo motivo que label-prs.test.sh).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null
HAY_ENGRAM=0; command -v engram >/dev/null 2>&1 && HAY_ENGRAM=1

# ── Helpers ─────────────────────────────────────────────────────────────────────────────────────
N=0
nuevo_repo(){  # deja $R: repo git vacío en main, con .engram/chunks/
  N=$((N+1)); R="$TMP/repo$N"; mkdir -p "$R/.engram/chunks"; cd "$R" || exit 9
  git init -q . && git checkout -q -b main
}
chunk(){  # $1 id · $2 observaciones · $3 sesiones · $4 prompts — un chunk gzip como los de engram
  node -e 'const n=(k)=>Array.from({length:+k},()=>({}));process.stdout.write(JSON.stringify({observations:n(process.argv[1]),sessions:n(process.argv[2]),prompts:n(process.argv[3])})+"\n")' \
    "${2:-1}" "${3:-0}" "${4:-0}" | gzip -c > "$R/.engram/chunks/$1.jsonl.gz"
}
indice(){  # cada arg: id|autor|fecha|sessions|memories|prompts — escrito COMO LO ESCRIBE engram
  node -e 'const fs=require("fs");const chunks=process.argv.slice(2).map((s)=>{const p=s.split("|");return {id:p[0],created_by:p[1]||"t",created_at:p[2]||"2026-01-01T00:00:00Z",sessions:+(p[3]||0),memories:+(p[4]||1),prompts:+(p[5]||0)};});fs.writeFileSync(process.argv[1],JSON.stringify({version:1,chunks},null,2));' \
    "$R/.engram/manifest.json" "$@"
}
commitear(){ git -C "$R" add -A && git -C "$R" commit -qm "$1"; }
cruzar(){  # corre el CLI sobre $R; deja $OUT (archivo), $ERR, $RC
  OUT="$TMP/out-$N.json"
  (cd "$R" && node "$LIB" cross --repo "$R" --json "$@") >"$OUT" 2>"$TMP/err"; RC=$?
  ERR="$(cat "$TMP/err")"
}
reparar(){  # idem con `repair`
  OUT="$TMP/out-$N.json"
  (cd "$R" && node "$LIB" repair --repo "$R" --json "$@") >"$OUT" 2>"$TMP/err"; RC=$?
  ERR="$(cat "$TMP/err")"
}
j(){  # $1 ruta con puntos (a.b.0.c) sobre $OUT → listas unidas por coma · null/undefined literales
  node -e 'let v;try{v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));}catch(e){process.stdout.write("<<no es JSON>>");process.exit(0);}
for(const k of process.argv[2].split(".")){ if(v===null||v===undefined) break; v=v[k]; }
process.stdout.write(v===null?"null":v===undefined?"undefined":Array.isArray(v)?v.map((x)=>typeof x==="object"&&x?(x.id||JSON.stringify(x)):String(x)).join(","):typeof v==="object"?JSON.stringify(v):String(v));' "$OUT" "$1"
}
entrada(){  # $1 id — la entrada tal cual quedó en el índice de $R (JSON en una línea) o «(no está)»
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=m.chunks.filter((c)=>c&&c.id===process.argv[2]);process.stdout.write(e.length?JSON.stringify(e[0]):"(no está)");' "$R/.engram/manifest.json" "$1"
}
ids_indice(){ node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).chunks.map((c)=>c.id).join(","))' "$R/.engram/manifest.json"; }
termina_en_salto(){ [ "$(tail -c 1 "$1" | od -An -c | tr -d ' ')" = '\n' ]; }

[ -f "$LIB" ] || no "no existe scripts/lib/manifest-engram.js — todo lo que sigue va a fallar por eso"

# ════════════════════════════════════════════════════════ EL CRITERIO (ACs 1-4)
# ---------------------------------------------------------------- T1. Cruce_Consistente_Sano
nuevo_repo; chunk aaaa1111; chunk bbbb2222; chunk cccc3333
indice 'aaaa1111' 'bbbb2222' 'cccc3333'
cruzar
[ "$RC" -eq 0 ] && [ "$(j estado)" = "sano" ] && [ "$(j archivos)" = "3" ] && [ "$(j declarados)" = "3" ] \
  && [ "$(j huerfanos)" = "" ] && [ "$(j fantasmas)" = "" ] && [ "$(j duplicados)" = "" ] && [ "$(j regla)" = "sano" ] \
  && ok "T1 3 archivos y 3 entradas → sano, listas vacías, exit 0" \
  || no "T1 consistente dio estado=$(j estado) rc=$RC huerfanos=[$(j huerfanos)] — $ERR"

# ---------------------------------------------------------------- T2. Cruce_HuerfanoFantasmaYDuplicado
nuevo_repo; chunk aaaa1111; chunk bbbb2222; chunk cccc3333
indice 'aaaa1111' 'aaaa1111' 'bbbb2222' 'xxxx9999'
cruzar
[ "$RC" -eq 1 ] && [ "$(j estado)" = "deriva" ] && [ "$(j huerfanos)" = "cccc3333" ] \
  && [ "$(j fantasmas)" = "xxxx9999" ] && [ "$(j duplicados)" = "aaaa1111" ] \
  && ok "T2 huérfano, fantasma y duplicado, cada uno en su lista → deriva, exit 1" \
  || no "T2 dio estado=$(j estado) rc=$RC h=[$(j huerfanos)] f=[$(j fantasmas)] d=[$(j duplicados)] — $ERR"
# el CLI en texto (sin --json) dice lo mismo y sale igual; y nunca sale 2 (es el código de los hooks)
(cd "$R" && node "$LIB" cross --repo "$R") >"$TMP/txt" 2>&1; RCT=$?
[ "$RCT" -eq 1 ] && grep -q "cccc3333" "$TMP/txt" && grep -q "xxxx9999" "$TMP/txt" \
  && ok "T2 el CLI en texto nombra el huérfano y el fantasma, exit 1" \
  || no "T2 el CLI en texto dio rc=$RCT: $(head -3 "$TMP/txt")"

# ---------------------------------------------------------------- T3. Cruce_SinManifest_NoMedido
nuevo_repo; chunk aaaa1111; chunk bbbb2222
cruzar
[ "$RC" -eq 3 ] && [ "$(j estado)" = "no-medido" ] && [ "$(j codigo)" = "sin-manifest" ] \
  && printf '%s' "$(j motivo)" | grep "no hay .engram/manifest.json" >/dev/null \
  && [ "$(j huerfanos)" = "null" ] && [ "$(j fantasmas)" = "null" ] && [ "$(j duplicados)" = "null" ] \
  && [ "$(j archivos)" = "2" ] && [ "$(j declarados)" = "null" ] && [ "$(j regla)" = "no-pude-medir" ] \
  && ok "T3 chunks sin índice → no-medido con motivo, listas null (nunca vacías-como-verde), exit 3" \
  || no "T3 dio estado=$(j estado) rc=$RC motivo=[$(j motivo)] huerfanos=[$(j huerfanos)] — $ERR"

# ---------------------------------------------------------------- T4. Cruce_ManifestRoto_NoMedido
nuevo_repo; chunk aaaa1111
printf '{"version":1,"chunks":[' > "$R/.engram/manifest.json"
cruzar
[ "$RC" -eq 3 ] && [ "$(j estado)" = "no-medido" ] && [ "$(j codigo)" = "no-parsea" ] && [ "$(j huerfanos)" = "null" ] \
  && ok "T4 JSON inválido → no-medido («no parsea»), nunca «0 huérfanos»" \
  || no "T4 JSON inválido dio estado=$(j estado) codigo=$(j codigo) rc=$RC huerfanos=[$(j huerfanos)]"
printf '<<<<<<< HEAD\n{"version":1,"chunks":[]}\n=======\n{"version":1,"chunks":[]}\n>>>>>>> otra\n' > "$R/.engram/manifest.json"
cruzar
[ "$RC" -eq 3 ] && [ "$(j codigo)" = "marcadores" ] && printf '%s' "$(j motivo)" | grep -i "marcadores de conflicto" >/dev/null && [ "$(j huerfanos)" = "null" ] \
  && ok "T4 marcadores de conflicto → no-medido con SU motivo" \
  || no "T4 marcadores dio codigo=$(j codigo) motivo=[$(j motivo)] rc=$RC"
printf '{"version":1}' > "$R/.engram/manifest.json"
cruzar
[ "$RC" -eq 3 ] && [ "$(j codigo)" = "sin-lista" ] && ok "T4 índice sin lista \`chunks\` → no-medido" || no "T4 sin lista dio codigo=$(j codigo) rc=$RC"
printf '{"version":1,"chunks":[{"id":"aaaa1111"},{"created_by":"x"},{"id":7}]}' > "$R/.engram/manifest.json"
cruzar
[ "$RC" -eq 3 ] && [ "$(j codigo)" = "ids-invalidos" ] && [ "$(j huerfanos)" = "null" ] \
  && ok "T4 entradas sin \`id\` de texto → no-medido (no se cruza a medias)" || no "T4 ids inválidos dio codigo=$(j codigo) rc=$RC"

# ---------------------------------------------------------------- T5. Cruce_SinCarpetaChunks_NoMedido
nuevo_repo; rmdir "$R/.engram/chunks"
indice 'aaaa1111' 'bbbb2222'
cruzar
[ "$RC" -eq 3 ] && [ "$(j estado)" = "no-medido" ] && [ "$(j codigo)" = "sin-carpeta-chunks" ] \
  && [ "$(j declarados)" = "2" ] && [ "$(j huerfanos)" = "null" ] && [ "$(j archivos)" = "null" ] \
  && ok "T5 índice con 2 entradas y sin chunks/ → no-medido, declarados=2, huérfanos null" \
  || no "T5 dio estado=$(j estado) codigo=$(j codigo) declarados=$(j declarados) huerfanos=[$(j huerfanos)] rc=$RC"

# ════════════════════════════════════════════════════════ NUEVO vs HEREDADO (AC 2, 3)
# ---------------------------------------------------------------- T6. Clasifica_PerdidaContraHEAD_EsNueva
nuevo_repo; chunk aaaa1111; chunk bbbb2222; chunk cccc3333
indice 'aaaa1111' 'bbbb2222' 'cccc3333'; commitear "3 de 3"
indice 'aaaa1111' 'bbbb2222'          # el escritor que agregó sobre una copia vieja
cruzar
[ "$RC" -eq 1 ] && [ "$(j perdidas)" = "cccc3333" ] && [ "$(j huerfanosNuevos)" = "cccc3333" ] \
  && [ "$(j huerfanosHeredados)" = "" ] && [ "$(j regla)" = "entradas-perdidas" ] && [ "$(j razones.cccc3333)" = "entradas-perdidas" ] \
  && [ "$(j contra.legible)" = "true" ] \
  && ok "T6 🔴 HEAD la declaraba y el índice a commitear ya no → PERDIDA, huérfano NUEVO" \
  || no "T6 dio perdidas=[$(j perdidas)] nuevos=[$(j huerfanosNuevos)] heredados=[$(j huerfanosHeredados)] regla=$(j regla) rc=$RC — $ERR"
# T6b: lo mismo cuando «lo nuevo» es un ÁRBOL de git y no el disco (así mira el portón de CI)
commitear "el índice truncado entra"
node -e 'const l=require(process.argv[1]);const r=l.cruzar(process.argv[2],{arbol:"HEAD",contra:"HEAD~1"});process.stdout.write(JSON.stringify(r));' "$LIB" "$R" >"$OUT" 2>"$TMP/err"
[ "$(j perdidas)" = "cccc3333" ] && [ "$(j huerfanosNuevos)" = "cccc3333" ] && [ "$(j archivos)" = "3" ] \
  && ok "T6b el mismo criterio sobre un árbol de git (arbol=HEAD, contra=HEAD~1)" \
  || no "T6b árbol de git dio perdidas=[$(j perdidas)] archivos=$(j archivos) — $(cat "$TMP/err")"

# ---------------------------------------------------------------- T7. Clasifica_ChunkNuevoSinEntrada_EsNuevo
nuevo_repo; chunk aaaa1111; chunk bbbb2222
indice 'aaaa1111' 'bbbb2222'; commitear "2 de 2"
chunk dddd4444
cruzar
[ "$RC" -eq 1 ] && [ "$(j huerfanosNuevos)" = "dddd4444" ] && [ "$(j razones.dddd4444)" = "chunk-sin-entrada" ] \
  && [ "$(j perdidas)" = "" ] && [ "$(j chunksSinEntrada)" = "dddd4444" ] && [ "$(j regla)" = "chunk-sin-entrada" ] \
  && ok "T7 🔴 archivo nuevo que no está ni en el árbol de HEAD, sin entrada → huérfano NUEVO (chunk-sin-entrada)" \
  || no "T7 dio nuevos=[$(j huerfanosNuevos)] razon=$(j razones.dddd4444) regla=$(j regla) rc=$RC — $ERR"

# ---------------------------------------------------------------- T8. Clasifica_HuerfanoYaEnHEAD_EsHeredado
nuevo_repo; chunk aaaa1111; chunk bbbb2222; chunk cccc3333
indice 'aaaa1111' 'bbbb2222'; commitear "ya nació en deriva: 3 archivos, 2 entradas"
cruzar
[ "$RC" -eq 1 ] && [ "$(j huerfanosHeredados)" = "cccc3333" ] && [ "$(j huerfanosNuevos)" = "" ] && [ "$(j regla)" = "deriva-heredada" ] \
  && ok "T8 el huérfano que ya era huérfano en HEAD es HEREDADO (avisa, no frena)" \
  || no "T8 dio heredados=[$(j huerfanosHeredados)] nuevos=[$(j huerfanosNuevos)] regla=$(j regla) rc=$RC"

# ---------------------------------------------------------------- T9. Clasifica_SinHEADLegible_TodoHeredado
nuevo_repo; chunk aaaa1111; chunk bbbb2222; chunk cccc3333
printf '{"version":1,"chunks":[' > "$R/.engram/manifest.json"; commitear "HEAD con el índice roto"
indice 'aaaa1111' 'bbbb2222'
cruzar
[ "$RC" -eq 1 ] && [ "$(j contra.legible)" = "false" ] && [ -n "$(j contra.motivo)" ] && [ "$(j contra.motivo)" != "null" ] \
  && [ "$(j huerfanosHeredados)" = "cccc3333" ] && [ "$(j huerfanosNuevos)" = "" ] \
  && ok "T9 referencia ilegible → contra.legible=false con motivo, y el huérfano sale HEREDADO (no se frena por lo que no se pudo comparar)" \
  || no "T9 dio legible=$(j contra.legible) motivo=[$(j contra.motivo)] heredados=[$(j huerfanosHeredados)] nuevos=[$(j huerfanosNuevos)] rc=$RC"
nuevo_repo; chunk aaaa1111; chunk bbbb2222; indice 'aaaa1111'      # repo SIN commits
cruzar
[ "$RC" -eq 1 ] && [ "$(j contra.legible)" = "false" ] && [ "$(j huerfanos)" = "bbbb2222" ] && [ "$(j huerfanosHeredados)" = "bbbb2222" ] \
  && ok "T9 repo sin commits: el cruce del disco sale igual, sin referencia" \
  || no "T9 sin commits dio legible=$(j contra.legible) huerfanos=[$(j huerfanos)] rc=$RC — $ERR"

# ════════════════════════════════════════════════════════ LA REPARACIÓN (ACs 13-17)
# ---------------------------------------------------------------- T10. Reparar_RescataEntradaExactaDeLaHistoria
nuevo_repo; chunk aaaa1111; chunk bbbb2222; chunk cccc3333 5 2 1
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|t|2026-02-01T00:00:00Z' 'cccc3333|fer|2026-03-05T10:20:30Z|4|9|2'
commitear "la historia SÍ declaró a cccc3333"; SHA_BUENO=$(git -C "$R" rev-parse HEAD)
ESPERADA=$(entrada cccc3333)
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|t|2026-02-01T00:00:00Z'; commitear "se perdió"
reparar --apply
[ "$RC" -eq 0 ] && [ "$(entrada cccc3333)" = "$ESPERADA" ] && [ "$(j reparadas.0.origen)" = "git:$SHA_BUENO" ] \
  && ok "T10 rescata la entrada EXACTA de la historia (autor fer, su fecha, sus contadores) y anota git:<sha>" \
  || no "T10 quedó [$(entrada cccc3333)] esperaba [$ESPERADA] · origen=$(j reparadas.0.origen) rc=$RC — $ERR"

# ---------------------------------------------------------------- T11. Reparar_RescataDelOtroLadoDelMergeYDeRamaNoMergeada
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "base 1 de 1"
git -C "$R" checkout -q -b a; chunk bbbb2222
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|ana|2026-02-02T00:00:00Z|1|2|0'; commitear "a: agrega bbbb2222"
git -C "$R" checkout -q main; git -C "$R" checkout -q -b b; chunk cccc3333
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'cccc3333|fer|2026-02-03T00:00:00Z|2|6|1'; commitear "b: agrega cccc3333"
ENT_B=$(entrada cccc3333)
git -C "$R" checkout -q main; git -C "$R" checkout -q -b x; chunk dddd4444
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'dddd4444|luz|2026-02-04T00:00:00Z|3|3|3'; commitear "x: agrega dddd4444 (nunca se mergea)"
ENT_X=$(entrada dddd4444); cp "$R/.engram/chunks/dddd4444.jsonl.gz" "$TMP/dddd4444.gz"
git -C "$R" checkout -q a
git -C "$R" merge -q b -m "merge b en a" >/dev/null 2>&1          # conflicto en el índice: los dos agregan al final
git -C "$R" checkout -q --ours .engram/manifest.json && git -C "$R" add -A && git -C "$R" commit -qm "merge de b en a, el índice se queda con un lado" \
  || no "T11 el mundo no reproduce el caso: el merge no dio el conflicto esperado"
cp "$TMP/dddd4444.gz" "$R/.engram/chunks/dddd4444.jsonl.gz"      # el archivo de x llega sin su entrada
cruzar; NACIO="$(j huerfanos)"
reparar --apply
[ "$NACIO" = "cccc3333,dddd4444" ] && [ "$RC" -eq 0 ] && [ "$(entrada cccc3333)" = "$ENT_B" ] && [ "$(entrada dddd4444)" = "$ENT_X" ] \
  && ok "T11 rescata del padre 2 del merge Y de una rama sin mergear (busca en todas las referencias)" \
  || no "T11 nació=[$NACIO] · cccc=[$(entrada cccc3333)] dddd=[$(entrada dddd4444)] rc=$RC — $ERR"

# ---------------------------------------------------------------- T11b. Reparar_RescataDelLadoQueGitPoda
# 🔴 El caso CANÓNICO, que T11 no cubría (pase adversarial, 2026-09-17): un pull con conflicto en el
# índice, resuelto quedándose con un lado (`git checkout --theirs`, la maniobra que la propia guía
# prescribe). El merge queda TREESAME a ese padre para el índice, y `git log` SIN `--full-history`
# poda el otro lado entero: la entrada perdida vive justo ahí, y no está en ningún ref. Sin la
# bandera, `reparar` la reconstruía desde el chunk (autor y fecha equivocados); con el chunk
# ilegible, la declaraba irreparable teniéndola git entera.
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "base publicada"
git -C "$R" checkout -q -b remoto; chunk cccc3333
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'cccc3333|fer|2026-02-03T00:00:00Z|1|1|0'; commitear "el compañero publica cccc3333"
git -C "$R" checkout -q main; chunk bbbb2222
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|luz|2026-02-02T00:00:00Z|3|7|2'; commitear "yo commiteo bbbb2222 local"
ENT_LUZ=$(entrada bbbb2222)
git -C "$R" merge -q remoto -m "pull con conflicto" >/dev/null 2>&1
git -C "$R" checkout -q --theirs .engram/manifest.json && git -C "$R" add -A && git -C "$R" commit -qm "la limpieza se queda con lo publicado"
git -C "$R" branch -q -D remoto        # en un pull real el lado descartado NO es un ref
PODADOS=$(git -C "$R" log --all --format=%H -- .engram/manifest.json | wc -l | tr -d ' ')
reparar --apply
[ "$PODADOS" = "2" ] && [ "$RC" -eq 0 ] && [ "$(entrada bbbb2222)" = "$ENT_LUZ" ] && printf '%s' "$(j reparadas.0.origen)" | grep "^git:" >/dev/null \
  && ok "T11b 🔴 la entrada que vive en el lado del merge que git PODA se rescata exacta de git (luz, sus contadores), no del chunk" \
  || no "T11b podados=$PODADOS (2 = git poda sin --full-history) · bbbb=[$(entrada bbbb2222)] esperaba [$ENT_LUZ] · origen=$(j reparadas.0.origen) rc=$RC"

# ---------------------------------------------------------------- T15b. Reparar_ConSoloFantasmas_NoDiceNadaQueReparar
# Sin huérfanos pero con fantasmas/duplicados, `reparar` decía «✅ no hay nada que reparar» y salía 0
# sobre un índice que el cruce acababa de declarar en deriva (pase adversarial). Ahora lo lista,
# aclara que este comando no lo toca (borrar es otra decisión), y sale 1.
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'xxxx9999|t|2026-02-01T00:00:00Z'
(cd "$R" && node "$LIB" repair --repo "$R") >"$TMP/t15b" 2>&1; RC=$?
[ "$RC" -eq 1 ] && grep -q "xxxx9999" "$TMP/t15b" && ! grep -q "no hay nada que reparar" "$TMP/t15b" \
  && ok "T15b con sólo fantasmas: NO dice «nada que reparar», los lista y sale 1" \
  || no "T15b rc=$RC: $(head -3 "$TMP/t15b")"

# ---------------------------------------------------------------- T16c. Reparar_StageaTambienElChunkQueDeclara
# El caso `chunk-sin-entrada`: el archivo todavía NO está en git. Stagear sólo el índice producía el
# commit INVERSO al que la story combate —una entrada cuyo archivo no viaja— y el cruce del disco lo
# daba por sano porque en disco están los dos (pase adversarial).
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "base"
chunk dddd4444                                   # nuevo, sin entrada, sin stagear
reparar --apply
STAGED=$(git -C "$R" diff --cached --name-only | sort | tr '\n' ' ')
[ "$RC" -eq 0 ] && [ "$STAGED" = ".engram/chunks/dddd4444.jsonl.gz .engram/manifest.json " ] \
  && ok "T16c reparar --apply stagea el índice Y el chunk que acaba de declarar (nada viaja a medias)" \
  || no "T16c staged=[$STAGED] rc=$RC"

# ---------------------------------------------------------------- T16d. Reparar_SiElAddFalla_LoDice
# El `git add` de lo reparado se VERIFICA (cazador de fallos silenciosos, vuelta 2): un chunk que un
# `.gitignore` excluye dejaba el mensaje diciendo «stageado» sin haberlo corroborado. Acá el chunk a
# declarar está ignorado: el índice se escribe, pero se avisa que no se pudo stagear y no se dice
# «reparado».
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "base"
printf '.engram/chunks/eeee5555.jsonl.gz\n' > "$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -qm "ignora el chunk que va a llegar"
chunk eeee5555
reparar --apply
[ "$RC" -ne 0 ] && [ "$(j reparado)" = "false" ] && printf '%s' "$(j avisos)" | grep "no pude stagear" >/dev/null && [ "$(entrada eeee5555)" != "(no está)" ] \
  && ok "T16d si el git add de lo reparado falla, lo dice, no dice «reparado» y sale ≠0 (el índice sí queda escrito)" \
  || no "T16d rc=$RC reparado=$(j reparado) avisos=[$(j avisos)] entrada=[$(entrada eeee5555)]"

# ---------------------------------------------------------------- T12. Reparar_FormatoEngram_ByteAByte_YSoloAgrega
# El índice contra el que se mide, en este orden: el que se le pase (MANIFEST_ENGRAM_REAL=<ruta>, para medir contra
# el índice de verdad de un repo con memoria), el del propio clon si trae memoria (.engram/manifest.json), o uno de
# muestra que arma esta prueba. La muestra se escribe con la forma que escribe engram —JSON con sangría de 2, sin
# salto final, campos en ese orden, autores con acentos— y con fechas en orden, como las deja un índice que creció
# commit a commit. Con la muestra, T12 cuida que el serializador conserve esa forma; con un índice de verdad, además,
# que engram no la haya cambiado.
REAL="${MANIFEST_ENGRAM_REAL:-$AQUI/.engram/manifest.json}"
if [ -z "${MANIFEST_ENGRAM_REAL:-}" ] && [ ! -f "$REAL" ]; then
  REAL="$TMP/indice-de-muestra.json"
  node -e '
const autores = ["ana", "José Ñandú", "dev-mac", "R|D", "Zoë"];
const chunks = [];
for (let i = 0; i < 40; i++) {
  const d = new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + i * 36e5 * 7);
  chunks.push({ id: (0x1a2b3c4d + i * 7919).toString(16).padStart(8, "0"), created_by: autores[i % autores.length],
    created_at: d.toISOString().replace(/\.\d{3}Z$/, "Z"), sessions: i % 3, memories: 1 + (i % 5), prompts: i % 2 });
}
require("fs").writeFileSync(process.argv[1], JSON.stringify({ version: 1, chunks }, null, 2));
' "$REAL"
fi
if [ -f "$REAL" ]; then
  # (i) el serializador ES el de engram: ida y vuelta sobre un índice real, idéntico byte a byte
  node -e 'const l=require(process.argv[1]);const fs=require("fs");fs.writeFileSync(process.argv[3],l.serializar(JSON.parse(fs.readFileSync(process.argv[2],"utf8"))));' "$LIB" "$REAL" "$TMP/ida-y-vuelta.json" 2>"$TMP/err"
  cmp -s "$REAL" "$TMP/ida-y-vuelta.json" \
    && ok "T12 🔴 serializar(parse(índice real)) es idéntico byte a byte — si engram cambia el formato, esto avisa" \
    || no "T12 el ida-y-vuelta del índice real NO es idéntico — $(cat "$TMP/err")"
  # (ii) se le sacan 2 entradas del medio, bien ordenadas respecto de sus vecinas, y se reparan
  nuevo_repo; cp "$REAL" "$R/.engram/manifest.json"
  QUITADAS=$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const c=m.chunks;
for(const x of c) fs.writeFileSync(process.argv[2]+"/"+x.id+".jsonl.gz","");
const buenas=[];for(let i=Math.floor(c.length/4);i<c.length-2&&buenas.length<2;i++){ if(c[i-1].created_at<c[i].created_at&&c[i].created_at<c[i+1].created_at&&(!buenas.length||i>buenas[buenas.length-1]+3)) buenas.push(i); }
process.stdout.write(buenas.map((i)=>c[i].id).join(","));' "$R/.engram/manifest.json" "$R/.engram/chunks")
  commitear "el índice real, completo"
  node -e 'const fs=require("fs");const q=new Set(process.argv[2].split(","));const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.chunks=m.chunks.filter((c)=>!q.has(c.id));fs.writeFileSync(process.argv[1],JSON.stringify(m,null,2));' "$R/.engram/manifest.json" "$QUITADAS"
  cp "$R/.engram/manifest.json" "$TMP/recortado.json"; commitear "pierde 2 del medio"
  reparar --apply
  BORRADAS=$(diff "$TMP/recortado.json" "$R/.engram/manifest.json" | grep -c '^<')
  [ -n "$QUITADAS" ] && [ "$RC" -eq 0 ] && cmp -s "$REAL" "$R/.engram/manifest.json" && [ "$BORRADAS" -eq 0 ] && ! termina_en_salto "$R/.engram/manifest.json" \
    && ok "T12 🔴 reparado = el índice original byte a byte: el diff sólo AGREGA, nada se mueve, sin salto final ($QUITADAS)" \
    || no "T12 quitadas=[$QUITADAS] rc=$RC líneas-borradas=$BORRADAS idéntico=$(cmp -s "$REAL" "$R/.engram/manifest.json" && echo sí || echo NO) — $ERR"
else
  no "T12 no encontré el índice que se pidió medir: $REAL"
fi

# ---------------------------------------------------------------- T13. Reparar_ReconstruyeDesdeElChunkSiNadieLaTuvo
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "base"
chunk zzzz0000 2 1 1
GIT_AUTHOR_NAME=ana GIT_AUTHOR_DATE="2026-04-05T06:07:08-03:00" git -C "$R" add -A >/dev/null
GIT_AUTHOR_NAME=ana GIT_AUTHOR_DATE="2026-04-05T06:07:08-03:00" git -C "$R" commit -qm "ana trae un chunk que nadie declaró nunca"
reparar --apply
[ "$RC" -eq 0 ] && [ "$(entrada zzzz0000)" = '{"id":"zzzz0000","created_by":"ana","created_at":"2026-04-05T09:07:08Z","sessions":1,"memories":2,"prompts":1}' ] \
  && [ "$(j reparadas.0.origen)" = "chunk" ] \
  && ok "T13 nadie la tuvo → se reconstruye del propio chunk y del commit que lo trajo (ana, su fecha en UTC), origen «chunk»" \
  || no "T13 quedó [$(entrada zzzz0000)] origen=$(j reparadas.0.origen) rc=$RC — $ERR"

# ---------------------------------------------------------------- T13b. Reparar_AutorConBarraVertical
# El autor del commit se parte del `%an|%aI` por el ÚLTIMO `|`, no el primero (pase adversarial):
# con un `|` en el nombre, la fecha quedaba ilegible y la entrada se escribía con created_at de 1970.
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "base"
chunk yyyy0000 1 0 0
GIT_AUTHOR_NAME='R|D' GIT_AUTHOR_DATE="2026-05-06T07:08:09Z" git -C "$R" add -A >/dev/null
GIT_AUTHOR_NAME='R|D' GIT_AUTHOR_DATE="2026-05-06T07:08:09Z" git -C "$R" commit -qm "autor con barra"
reparar --apply
[ "$RC" -eq 0 ] && [ "$(entrada yyyy0000)" = '{"id":"yyyy0000","created_by":"R|D","created_at":"2026-05-06T07:08:09Z","sessions":0,"memories":1,"prompts":0}' ] \
  && ok "T13b un autor con «|» en el nombre conserva el nombre entero y su fecha (no 1970)" \
  || no "T13b quedó [$(entrada yyyy0000)] rc=$RC"

# ---------------------------------------------------------------- T6c. Cruzar_ModoArbol_DesdeUnSubdirectorio
# En modo árbol el índice se lee relativo a la RAÍZ (`git show <ref>:<path>`) y los archivos con un
# pathspec: sin `:/`, ese pathspec era relativo al CWD, y con `dir` en un subdirectorio la lista
# salía vacía y TODAS las entradas se reportaban como fantasma (pase adversarial).
nuevo_repo; chunk aaaa1111; chunk bbbb2222; indice 'aaaa1111' 'bbbb2222'; mkdir -p "$R/sub/mas"; echo x > "$R/sub/mas/f.txt"; commitear "2 de 2 con subdirectorio"
node -e 'const l=require(process.argv[1]);const r=l.cruzar(process.argv[2],{arbol:"HEAD",contra:null});process.stdout.write(JSON.stringify(r));' "$LIB" "$R/sub/mas" >"$OUT" 2>"$TMP/err"
[ "$(j estado)" = "sano" ] && [ "$(j archivos)" = "2" ] && [ "$(j fantasmas)" = "" ] \
  && ok "T6c cruzar en modo árbol desde un subdirectorio del repo ve los 2 archivos (pathspec anclado a la raíz)" \
  || no "T6c desde subdirectorio dio estado=$(j estado) archivos=$(j archivos) fantasmas=[$(j fantasmas)] — $(cat "$TMP/err")"

# ---------------------------------------------------------------- T14. Reparar_ChunkIlegible_NoInventa
nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "base"
printf 'esto no es gzip' > "$R/.engram/chunks/rrrr0000.jsonl.gz"; commitear "un archivo que no es un chunk"
cp "$R/.engram/manifest.json" "$TMP/antes-t14.json"
reparar --apply
[ "$RC" -eq 1 ] && [ "$(j noReparadas.0.id)" = "rrrr0000" ] && [ -n "$(j noReparadas.0.motivo)" ] && [ "$(j noReparadas.0.motivo)" != "undefined" ] \
  && [ "$(entrada rrrr0000)" = "(no está)" ] \
  && ok "T14 chunk ilegible y sin historia → NO se inventa: queda en noReparadas con motivo, exit 1" \
  || no "T14 dio noReparadas=[$(j noReparadas.0.id)] motivo=[$(j noReparadas.0.motivo)] índice=[$(entrada rrrr0000)] rc=$RC"
# 🔴 …y si NO hay nada que rescatar, el índice no se toca ni se dice que se escribió. Reescribirlo
# «por las dudas» es un cambio que nadie pidió; decir «índice escrito» sin haber escrito es peor.
(cd "$R" && node "$LIB" repair --apply --repo "$R") >"$TMP/t14.txt" 2>&1
cmp -s "$TMP/antes-t14.json" "$R/.engram/manifest.json" && grep -q "no toqué el índice" "$TMP/t14.txt" \
  && ok "T14 sin nada rescatable: el índice queda intacto y el mensaje lo dice" \
  || no "T14 con 0 rescatables tocó el índice o mintió: $(head -3 "$TMP/t14.txt")"

# ---------------------------------------------------------------- T15. Reparar_NuncaBorra
nuevo_repo; chunk aaaa1111; chunk bbbb2222; chunk cccc3333
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|t|2026-02-01T00:00:00Z' 'cccc3333|t|2026-03-01T00:00:00Z'; commitear "3 de 3"
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|t|2026-02-01T00:00:00Z' 'xxxx9999|t|2026-02-15T00:00:00Z'
reparar --apply
[ "$(ids_indice)" = "aaaa1111,aaaa1111,bbbb2222,xxxx9999,cccc3333" ] && [ "$(j fantasmas)" = "xxxx9999" ] && [ "$(j duplicados)" = "aaaa1111" ] \
  && ok "T15 agrega el huérfano; el fantasma y el duplicado SIGUEN y se listan — borrar es decisión de una persona" \
  || no "T15 el índice quedó [$(ids_indice)] fantasmas=[$(j fantasmas)] duplicados=[$(j duplicados)] rc=$RC"

# ---------------------------------------------------------------- T16. Reparar_EnSecoNoEscribe_ConApplyStageaYVerifica
nuevo_repo; chunk aaaa1111; chunk bbbb2222
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|t|2026-02-01T00:00:00Z'; commitear "2 de 2"
indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "pierde una"
cp "$R/.engram/manifest.json" "$TMP/antes.json"
reparar
[ "$RC" -eq 1 ] && cmp -s "$TMP/antes.json" "$R/.engram/manifest.json" && [ "$(j aplicado)" = "false" ] && [ "$(j reparadas.0.id)" = "bbbb2222" ] \
  && ok "T16 en seco: dice qué haría y de dónde, NO escribe, exit 1" \
  || no "T16 en seco dio rc=$RC aplicado=$(j aplicado) intacto=$(cmp -s "$TMP/antes.json" "$R/.engram/manifest.json" && echo sí || echo NO)"
reparar --apply
STAGED=$(git -C "$R" diff --cached --name-only | tr '\n' ' ')
if [ "$HAY_ENGRAM" -eq 1 ]; then
  no "T16 el entorno de prueba tiene un \`engram\` en /usr/bin o /bin: no puedo probar la rama «sin importador»"
else
  [ "$RC" -eq 0 ] && [ "$STAGED" = ".engram/manifest.json " ] && [ "$(j aplicado)" = "true" ] && [ "$(j verificado.huerfanos)" = "0" ] \
    && printf '%s' "$(j verificado.importador)" | grep "no verifiqué con un importador" >/dev/null \
    && ok "T16 con --apply: índice stageado, cruce posterior 0 huérfanos, y dice «no verifiqué con un importador»" \
    || no "T16 --apply dio rc=$RC staged=[$STAGED] huerfanos-despues=$(j verificado.huerfanos) importador=[$(j verificado.importador)] — $ERR"
fi
reparar
[ "$RC" -eq 0 ] && ok "T16 sin nada que reparar → exit 0" || no "T16 repo ya sano dio rc=$RC"
nuevo_repo; chunk aaaa1111
reparar
[ "$RC" -eq 3 ] && [ "$(j estado)" = "no-medido" ] && ok "T16 sin índice → no se pudo medir, exit 3 (nunca 2)" || no "T16 sin índice dio rc=$RC estado=$(j estado)"
# 🔴 …y sus listas vienen en `null`, NO vacías. Es la regla que hace que un consumidor distraído se
# rompa ruidosamente en vez de mentir: `reparadas: []` es indistinguible de «miré y no había nada
# que reparar», y por ahí se coló el verde falso de `--reindex` (T17c). Mutante que lo pone rojo:
# devolver `[]` en `reparar` cuando el estado es no-medido.
[ "$(j reparadas)" = "null" ] && [ "$(j noReparadas)" = "null" ] \
  && ok "T16 con «no pude medir», reparadas y noReparadas vienen null — nunca vacías" \
  || no "T16 no-medido devolvió reparadas=[$(j reparadas)] noReparadas=[$(j noReparadas)] — tienen que ser null"

# ════════════════════════════════════════════════════════ EL RESCATE DELEGA (ACs 25, 26)
raiz_falsa(){ RAIZ="$TMP/raiz$1"; mkdir -p "$RAIZ"; export TYCON_REPOS_ROOT="$RAIZ"; }
repo_en(){  # $1 ruta relativa a $RAIZ — deja $R con .engram/ y nombre fijado
  R="$RAIZ/$1"; mkdir -p "$R/.engram/chunks"; printf 'proj-%s' "$(basename "$1")" > "$R/.engram-project"
  git -C "$R" init -q . && git -C "$R" checkout -q -b main
}
# ---------------------------------------------------------------- T17. Reindex_RespetaRepo
raiz_falsa 17
repo_en A; chunk aaaa1111; chunk bbbb2222; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "A en deriva"; RA="$R"
repo_en B; chunk cccc3333; chunk dddd4444; indice 'cccc3333|t|2026-01-01T00:00:00Z'; commitear "B en deriva"; RB="$R"
cp "$RB/.engram/manifest.json" "$TMP/B-antes.json"
node "$RESCATE" --reindex --apply --repo A >"$TMP/out17" 2>&1; RC=$?
R="$RA"; A_TIENE="$(ids_indice)"
[ "$A_TIENE" = "aaaa1111,bbbb2222" ] && cmp -s "$TMP/B-antes.json" "$RB/.engram/manifest.json" \
  && ok "T17 --reindex --repo A toca SÓLO A (B queda byte a byte como estaba)" \
  || no "T17 A=[$A_TIENE] B-intacto=$(cmp -s "$TMP/B-antes.json" "$RB/.engram/manifest.json" && echo sí || echo NO) rc=$RC — $(tail -3 "$TMP/out17")"
node "$RESCATE" --reindex --repo Z >"$TMP/out17z" 2>&1; RC=$?
[ "$RC" -eq 2 ] && grep -q "A" "$TMP/out17z" && grep -q "B" "$TMP/out17z" && grep -q "Z" "$TMP/out17z" \
  && ok "T17 una etiqueta desconocida sale 2 nombrando los repos conocidos" \
  || no "T17 --repo Z dio rc=$RC: $(tail -3 "$TMP/out17z")"
# 🔴 T17c — el verde falso que cazó el cazador de fallos silenciosos (2026-09-17). Un índice que el
# criterio NO puede medir (entradas sin `id` de texto — el pre-check propio del rescate no lo cubre)
# salía con las listas vacías, y el rescate imprimía «✅ Todo chunk está en el índice» y código 0.
# Un verde falso dentro del comando que existe para reparar exactamente eso. Mutación que lo pone en
# rojo: sacar el `if (arreglo.estado === 'no-medido')` de `reindexar`, o devolver `[]` en vez de
# `null` desde `reparar` cuando no se pudo medir.
raiz_falsa 17c
repo_en D; chunk aaaa1111
printf '%s' '{"version":1,"chunks":[{"id":7}]}' > "$R/.engram/manifest.json"   # id que no es texto
commitear "un índice que no se puede cruzar"
node "$RESCATE" --reindex --apply --repo D >"$TMP/out17c" 2>&1; RC=$?
ANTES="$(cat "$R/.engram/manifest.json")"
[ "$RC" -ne 0 ] && grep -q "no se pudo medir" "$TMP/out17c" \
  && ! grep -q "Todo chunk en disco está en el índice" "$TMP/out17c" \
  && [ "$ANTES" = '{"version":1,"chunks":[{"id":7}]}' ] \
  && ok "T17c 🔴 un índice que NO se pudo medir no sale como «todo indexado»: rc≠0, lo dice, y no toca el archivo" \
  || no "T17c rc=$RC · dijo-que-no-pudo=$(grep -c 'no se pudo medir' "$TMP/out17c") · mintió=$(grep -c 'Todo chunk en disco' "$TMP/out17c") · índice intacto=$([ "$ANTES" = '{"version":1,"chunks":[{"id":7}]}' ] && echo sí || echo NO)"
unset TYCON_REPOS_ROOT

# ---------------------------------------------------------------- T17b. Reindex_CorreSinBaseLocal
# 🔴 El guard de `~/.engram/engram.db` estaba ANTES de mirar `--reindex`, así que el comando salía 1
# con «nada que hacer» en toda máquina sin base local: un clon recién hecho, un agente de CI, o el
# dev que todavía no corrió engram. O sea que el arreglo que el aviso diario recomienda no arrancaba
# justo donde más falta. El reindex mira ARCHIVOS, no la base. Esta suite corre con HOME falso, así
# que la condición es real; la aserción la deja EXPLÍCITA para que nadie devuelva el guard a su lugar.
raiz_falsa 17b
repo_en E; chunk aaaa1111; chunk bbbb2222; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "E en deriva"
[ ! -f "$HOME/.engram/engram.db" ] || no "T17b el entorno de prueba TIENE base local — el caso no prueba lo que dice"
node "$RESCATE" --reindex --apply --repo E >"$TMP/out17b" 2>&1; RC=$?
! grep -q "nada que hacer" "$TMP/out17b" && [ "$(ids_indice)" = "aaaa1111,bbbb2222" ] \
  && ok "T17b sin base local de engram el --reindex corre igual (mira archivos, no la base)" \
  || no "T17b rc=$RC · dijo-nada-que-hacer=$(grep -c 'nada que hacer' "$TMP/out17b") · índice=[$(ids_indice)]"
unset TYCON_REPOS_ROOT

# ---------------------------------------------------------------- T16b. Reparar_VerificaConImportadorPresente
# La rama del importador REAL: la suite corre sin engram en el PATH (por eso T16 prueba el «no
# verifiqué»), así que acá se pone uno falso que se comporta como el de verdad. Sin esto, el camino
# que da el ✓ («un importador vio los N chunks») no lo ejerce ninguna prueba — y es el que corre en
# la máquina de cualquiera que SÍ tenga engram instalado, o sea casi todo el equipo.
nuevo_repo; chunk aaaa1111; chunk bbbb2222
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|t|2026-02-01T00:00:00Z'; commitear "2 de 2"
indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "pierde una"
# 🔴 El falso imita la salida REAL de engram 1.20.0, capturada el 2026-09-17: «Imported 2 new chunk(s)
# from .engram/» + tres líneas de contadores. La primera versión de este caso decía «imported 2 chunks»
# —un formato que engram no usa— y confirmaba un regex que en la máquina de cualquiera con engram
# instalado no matcheaba NUNCA (lo cazó el pase adversarial). Un doble que no imita al real mide un
# mundo que no existe: la lección de la 1.5, repetida acá y anotada para que no sea tres.
printf '#!/bin/sh\necho "Imported 2 new chunk(s) from .engram/"\necho "  Sessions:     0"\necho "  Observations: 2"\necho "  Prompts:      0"\nexit 0\n' > "$TMP/bin/engram" && chmod +x "$TMP/bin/engram"
reparar --apply
[ "$RC" -eq 0 ] && printf '%s' "$(j verificado.importador)" | grep "vio los 2 chunks" >/dev/null \
  && ok "T16b con un importador presente que confirma: lo dice («vio los 2 chunks»)" \
  || no "T16b con importador que confirma dio [$(j verificado.importador)] rc=$RC"
# …y si el importador ve MENOS de los que hay, lo GRITA en vez de dar el visto bueno.
printf '#!/bin/sh\necho "Imported 1 new chunk(s) from .engram/"\necho "  Sessions:     0"\necho "  Observations: 1"\necho "  Prompts:      0"\nexit 0\n' > "$TMP/bin/engram"
nuevo_repo; chunk aaaa1111; chunk bbbb2222
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|t|2026-02-01T00:00:00Z'; commitear "2 de 2"
indice 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "pierde una"
reparar --apply
printf '%s' "$(j verificado.importador)" | grep "🔴" >/dev/null && printf '%s' "$(j verificado.importador)" | grep "1 chunk" >/dev/null \
  && ok "T16b 🔴 si el importador ve MENOS chunks de los que hay, lo grita — no da el visto bueno" \
  || no "T16b con importador discrepante dio [$(j verificado.importador)]"
rm -f "$TMP/bin/engram"

# ---------------------------------------------------------------- T18. Reindex_DelegaEnLaLib_MismoFormato
raiz_falsa 18
repo_en C; chunk aaaa1111; chunk bbbb2222; chunk cccc3333
indice 'aaaa1111|t|2026-01-01T00:00:00Z' 'bbbb2222|fer|2026-02-02T02:02:02Z|3|1|0' 'cccc3333|t|2026-03-01T00:00:00Z'; commitear "3 de 3"
ESPERADA=$(entrada bbbb2222)
indice 'cccc3333|t|2026-03-01T00:00:00Z' 'aaaa1111|t|2026-01-01T00:00:00Z'; commitear "pierde bbbb2222 y ya venía desordenado"
node "$RESCATE" --reindex --apply --repo C >"$TMP/out18" 2>&1; RC=$?
[ "$(entrada bbbb2222)" = "$ESPERADA" ] && ! termina_en_salto "$R/.engram/manifest.json" \
  && [ "$(ids_indice | sed 's/,bbbb2222//;s/bbbb2222,//')" = "cccc3333,aaaa1111" ] \
  && ok "T18 --reindex delega en la lib: entrada rescatada de git (fer), sin salto final, las existentes no se mueven" \
  || no "T18 bbbb=[$(entrada bbbb2222)] esperaba [$ESPERADA] · orden=[$(ids_indice)] salto-final=$(termina_en_salto "$R/.engram/manifest.json" && echo SÍ || echo no) rc=$RC — $(tail -3 "$TMP/out18")"

# ════════════════════════════════════════════════════════ EL AUDIT DELEGA Y EL ESCANEO VE MÁS HONDO (ACs 18, 20)
# ---------------------------------------------------------------- T19. Audit_DelegaEnLaLib
raiz_falsa 19
repo_en sano;   chunk aaaa1111; indice 'aaaa1111'
repo_en deriva; chunk aaaa1111; chunk cccc3333; indice 'aaaa1111' 'xxxx9999'
repo_en sinman; chunk aaaa1111; chunk bbbb2222
repo_en sinchunks; indice 'aaaa1111' 'bbbb2222'; rmdir "$R/.engram/chunks"
repo_en roto;   chunk aaaa1111; printf '{"version":1,"chunks":[' > "$R/.engram/manifest.json"
node -e 'const a=require(process.argv[1]);const p=require("path");const r=a.engramChunksSinIndexar(process.argv[2]).sort((x,y)=>x.repo<y.repo?-1:1);/* cada fila dice la carpeta de su repo (varias raíces, story 2.67): se verifica y se saca para comparar la forma */if(!r.every((x)=>x.dir===p.join(process.argv[2],x.repo)))throw new Error("dir mal: "+JSON.stringify(r));process.stdout.write(JSON.stringify(r.map(({dir,...x})=>x)));' "$AUDIT" "$RAIZ" >"$TMP/audit.json" 2>"$TMP/err"
[ "$(cat "$TMP/audit.json")" = '[{"repo":"deriva","sinIndexar":["cccc3333"],"fantasma":["xxxx9999"]},{"repo":"roto","manifestIlegible":true,"sinIndexar":[],"fantasma":[]},{"repo":"sinchunks","sinIndexar":[],"fantasma":["aaaa1111","bbbb2222"]},{"repo":"sinman","sinManifest":true,"sinIndexar":["aaaa1111","bbbb2222"],"fantasma":[]}]' ] \
  && ok "T19 engramChunksSinIndexar conserva su forma en los 5 casos (sano ausente · deriva · índice roto · sin carpeta = todo fantasma · sin índice)" \
  || no "T19 el audit devolvió $(cat "$TMP/audit.json") — $(cat "$TMP/err")"
# …y es la LIB la que decide: un audit copiado sin ella no puede cruzar un repo con nombre fijado
mkdir -p "$TMP/audit-solo"; cp "$AUDIT" "$TMP/audit-solo/harness-audit.js"
node -e 'const a=require(process.argv[1]);try{const r=a.engramChunksSinIndexar(process.argv[2]);process.stdout.write("DEVOLVIO:"+JSON.stringify(r));}catch(e){process.stdout.write("TIRO:"+e.message);}' "$TMP/audit-solo/harness-audit.js" "$RAIZ" >"$TMP/audit-solo.txt" 2>/dev/null
grep -q "^TIRO:.*manifest-engram" "$TMP/audit-solo.txt" \
  && ok "T19 un solo criterio: sin la lib el audit lo DICE (no cruza por su cuenta ni devuelve vacío)" \
  || no "T19 el audit sin la lib dio [$(cat "$TMP/audit-solo.txt")] — tendría que tirar nombrando manifest-engram"

# ---------------------------------------------------------------- T20. Scan_VeRepoATresYCuatroNiveles
raiz_falsa 20
repo_en n1
repo_en grupo/n2
repo_en Proyectos/Acme/n3
repo_en Proyectos/Acme/Codigo/n4
mkdir -p "$RAIZ/front/node_modules/paquete/.engram/chunks"; printf 'no' > "$RAIZ/front/node_modules/paquete/.engram-project"
mkdir -p "$RAIZ/a/b/c/d/n5/.engram/chunks"; printf 'no' > "$RAIZ/a/b/c/d/n5/.engram-project"      # 5 niveles: fuera de alcance
VISTOS=$(node -e 'const a=require(process.argv[1]);process.stdout.write(a.scanEngramRepos(process.argv[2]).pinned.map((x)=>x.repo).sort().join(" "));' "$AUDIT" "$RAIZ" 2>"$TMP/err")
[ "$VISTOS" = "Proyectos/Acme/Codigo/n4 Proyectos/Acme/n3 grupo/n2 n1" ] \
  && ok "T20 ve repos a 1, 2, 3 y 4 niveles con su ruta relativa; no entra a node_modules ni baja al 5º" \
  || no "T20 el escaneo vio [$VISTOS] — $(cat "$TMP/err")"
# T20b (corrección del AC 20, medida el 2026-09-17): la carpeta madre con memoria PROPIA no tapa a sus repos
raiz_falsa 20b
repo_en Orbita; repo_en Orbita/OrbitaBackend; repo_en Orbita/OrbitaFrontEnd
VISTOS=$(node -e 'const a=require(process.argv[1]);process.stdout.write(a.scanEngramRepos(process.argv[2]).pinned.map((x)=>x.repo).sort().join(" "));' "$AUDIT" "$RAIZ" 2>"$TMP/err")
[ "$VISTOS" = "Orbita Orbita/OrbitaBackend Orbita/OrbitaFrontEnd" ] \
  && ok "T20b 🔴 una carpeta madre con .engram/ y .git propios NO tapa a sus repos de nivel 2 (así viven 14 repos del equipo)" \
  || no "T20b el escaneo vio [$VISTOS] — la regla de corte se comió repos que hoy se ven"

# ---------------------------------------------------------------- T21. Scan_NoBajaAdentroDeUnRepo
raiz_falsa 21
repo_en grupo/repo2; mkdir -p "$RAIZ/grupo/repo2/vendor/.engram/chunks"; printf 'adentro' > "$RAIZ/grupo/repo2/vendor/.engram-project"
VISTOS=$(node -e 'const a=require(process.argv[1]);process.stdout.write(a.scanEngramRepos(process.argv[2]).pinned.map((x)=>x.repo).sort().join(" "));' "$AUDIT" "$RAIZ" 2>"$TMP/err")
[ "$VISTOS" = "grupo/repo2" ] \
  && ok "T21 no baja adentro de un repo ya detectado a nivel 2 (el sub-repo de nivel 3 no se lista)" \
  || no "T21 el escaneo vio [$VISTOS]"
unset TYCON_REPOS_ROOT

# ════════════════════════════════════════════════════════ EL HOOK SIN NODE (AC 8)
# ---------------------------------------------------------------- T35b. Hook_SinNode_Python3ValidaYElCruceDiceQueNoPudo
# El camino de respaldo de `json_valido` (revisor de cobertura, vuelta 3): sin node, python3 valida
# el índice —el staging de lo del sync sigue— y el cruce, que sí exige node, dice «no pude medir».
# El PATH de este caso lleva jq y python3 pero NO node. Si en la máquina node vive en /usr/bin (un
# Linux con node del sistema) el caso no puede esconderlo: se declara NO MEDIDO, nunca verde.
HOOK="$AQUI/scripts/hooks/engram-pre-commit.sh"
mkdir -p "$TMP/bin-sin-node"; ln -s "$(command -v jq)" "$TMP/bin-sin-node/jq" 2>/dev/null
# `env -i … sh -c` para que el lookup no salga de la tabla hash de ESTA shell, que ya tiene a node.
hay(){ env -i PATH="$TMP/bin-sin-node:/usr/bin:/bin" /bin/sh -c "command -v $1" >/dev/null 2>&1; }
if hay node; then
  no "T35b NO MEDIDO: node vive en /usr/bin o /bin en esta máquina y el caso no puede esconderlo"
elif ! hay python3 || ! hay jq; then
  no "T35b NO MEDIDO: sin python3 o jq alcanzables en /usr/bin:/bin no se puede armar el PATH del caso"
else
  nuevo_repo; chunk aaaa1111; indice 'aaaa1111|t|2026-01-01T00:00:00Z'; printf 'p' > "$R/.engram-project"; commitear "base"
  printf '#!/bin/sh\nexit 0\n' > "$TMP/bin-sin-node/engram"; chmod +x "$TMP/bin-sin-node/engram"
  printf '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"}}' \
    | (cd "$R" && env -i HOME="$HOME" PATH="$TMP/bin-sin-node:/usr/bin:/bin" ENGRAM_BIN="$TMP/bin-sin-node/engram" ENGRAM_HOOK_DEBUG=1 ENGRAM_HOOK_LOG="$TMP/t35b.log" /bin/bash "$HOOK") >"$TMP/t35b.out" 2>"$TMP/t35b.err"; RC=$?
  [ "$RC" -eq 0 ] && grep -q "no pude medir" "$TMP/t35b.err" && grep -q "node no está" "$TMP/t35b.err" && ! grep -q "NO parsea" "$TMP/t35b.err" \
    && ok "T35b sin node: python3 valida el índice (no dice «NO parsea»), y el cruce dice «no pude medir: node no está»" \
    || no "T35b rc=$RC · err=[$(head -c 300 "$TMP/t35b.err")]"
fi

# ════════════════════════════════════════════════════════ LA MEMORIA NO VA AL REPO PÚBLICO (story 8.26, AC 39)
# ---------------------------------------------------------------- Memory_NotInPublicRepo (T39 de la story 8.26)
# Después del corte a GitHub, quien mantiene commitea en un clon del repo PÚBLICO, que no guarda memoria (no trae
# `.engram-project`), y declara en su máquina el clon PRIVADO de mantenimiento, que sí. Decisión de la tanda H1c: al
# commitear en el público NO se exporta nada, en ningún lado; lo pendiente lo exporta y lo prepara el próximo commit
# hecho EN el clon de mantenimiento (`engram sync --project X` exporta todo lo pendiente del proyecto, se haya guardado
# desde la sesión que sea). Se descartó exportar al clon de mantenimiento en cada commit del público: lo que queda ahí
# sin preparar no viaja nunca, y el commit siguiente entra con el índice declarando un trozo que no está. Este caso
# FIJA las dos mitades: nada escrito en el público ni en el otro clon, y el commit del clon de mantenimiento exporta.
M39="$TMP/m39"; mkdir -p "$M39/home/.tycon" "$M39/bin"
PUB39="$M39/public-clone"; MAINT39="$M39/maintainers-clone"
mkdir -p "$PUB39/scripts" "$MAINT39/.engram/chunks"
( cd "$PUB39" && git init -q . && git checkout -q -b main && git remote add origin https://github.com/acme/acme-harness.git \
  && printf '#!/bin/sh\n' > scripts/install-tycon-hooks.sh && printf 'x\n' > a.txt && git add -A && git commit -qm "el público" )
( cd "$MAINT39" && git init -q . && git checkout -q -b main && git remote add origin https://dev.azure.com/acme/harness/_git/acme-harness-internal \
  && printf 'acme\n' > .engram-project && printf '{"version":1,"chunks":[]}' > .engram/manifest.json && git add -A && git commit -qm "el de mantenimiento" )
printf '{ "paths": { "maintainers": "%s" } }\n' "$MAINT39" > "$M39/home/.tycon/config.json"
# el engram de mentira: anota DÓNDE lo corrieron y deja un trozo nuevo en la carpeta actual, como el de verdad
cat > "$M39/bin/engram" <<'EOF_ENGRAM'
#!/bin/sh
pwd -P >> "$ENGRAM_CALLS"
mkdir -p .engram/chunks && printf 'trozo\n' > ".engram/chunks/nuevo-$$.jsonl.gz"
exit 0
EOF_ENGRAM
chmod +x "$M39/bin/engram"
hook39(){ # $1=carpeta de la sesión  $2=comando → deja $RC39 y $M39/err
  node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], tool_input: { command: process.argv[2] } }))' "$1" "$2" \
    | (cd "$1" && HOME="$M39/home" ENGRAM_BIN="$M39/bin/engram" ENGRAM_CALLS="$M39/calls.log" bash "$HOOK") >"$M39/out" 2>"$M39/err"; RC39=$?
}
: > "$M39/calls.log"
printf 'y\n' >> "$PUB39/a.txt"; git -C "$PUB39" add -A
hook39 "$PUB39" 'git commit -m "un cambio en el público"'
[ "$RC39" -eq 0 ] && [ ! -s "$M39/calls.log" ] && [ ! -e "$PUB39/.engram" ] \
  && [ "$(git -C "$PUB39" status --porcelain | tr -d '\n')" = "M  a.txt" ] && [ -z "$(git -C "$MAINT39" status --porcelain)" ] \
  && ok "Memory_NotInPublicRepo (T39): commitear en el clon del público no exporta nada — ni ahí, ni en el clon de mantenimiento" \
  || no "Memory_NotInPublicRepo (T39): rc=$RC39 · engram corrió en [$(tr '\n' ' ' < "$M39/calls.log")] · público=[$(git -C "$PUB39" status --porcelain | tr '\n' ' ')] · mantenimiento=[$(git -C "$MAINT39" status --porcelain | tr '\n' ' ')] · $(head -c 200 "$M39/err")"
# …tampoco cuando la sesión está parada en el de mantenimiento y el commit se hace en el público
: > "$M39/calls.log"
hook39 "$MAINT39" "git -C \"$PUB39\" commit -m \"desde la otra carpeta\""
[ "$RC39" -eq 0 ] && [ ! -s "$M39/calls.log" ] && [ ! -e "$PUB39/.engram" ] && [ -z "$(git -C "$MAINT39" status --porcelain)" ] \
  && ok "Memory_NotInPublicRepo (T39): …ni con la sesión parada en el clon de mantenimiento y el commit en el público" \
  || no "Memory_NotInPublicRepo (T39) desde la otra carpeta: rc=$RC39 · engram corrió en [$(tr '\n' ' ' < "$M39/calls.log")] · mantenimiento=[$(git -C "$MAINT39" status --porcelain | tr '\n' ' ')]"
# la otra mitad: el commit hecho EN el clon de mantenimiento (con la sesión en el público) exporta ahí y lo prepara
: > "$M39/calls.log"
printf 'z\n' > "$MAINT39/nota.txt"; git -C "$MAINT39" add nota.txt
hook39 "$PUB39" "cd \"$MAINT39\" && git commit -m \"la memoria viaja con este commit\""
[ "$(cat "$M39/calls.log")" = "$(cd "$MAINT39" && pwd -P)" ] && git -C "$MAINT39" diff --cached --name-only | grep '^\.engram/chunks/nuevo-' >/dev/null \
  && [ ! -e "$PUB39/.engram" ] \
  && ok "Memory_NotInPublicRepo (T39): el commit siguiente en el clon de mantenimiento exporta ahí lo pendiente y lo deja preparado; el público sigue sin memoria" \
  || no "Memory_NotInPublicRepo (T39) la otra mitad: rc=$RC39 · engram corrió en [$(tr '\n' ' ' < "$M39/calls.log")] · preparado=[$(git -C "$MAINT39" diff --cached --name-only | tr '\n' ' ')] · $(head -c 300 "$M39/err")"

# ════════════════════════════════════════════════════════ LA RED ESTÁ ENCHUFADA (AC 32)
# ---------------------------------------------------------------- T39. SuiteRegistrada_YPortable
node -e 'const d=require(process.argv[1]);const t=[...d.diarias,...(d.semanales||[])];process.exit(t.some((x)=>x.raiz==="arnes"&&x.ruta==="tests/manifest-engram.test.sh")?0:1)' "$AQUI/scripts/tests/suites.json" \
  && ok "T39 la suite está registrada en suites.json (raiz: arnes)" || no "T39 la suite no está en suites.json"
# Los tres giros BSD-only que rompen en el agente Linux. Los patrones se arman en runtime para que
# esta misma línea no se encuentre a sí misma.
BSD=0
for giro in "$(printf 'sed -i %s' "''")" "$(printf 'date %sv' '-')" "$(printf 'stat %sf' '-')"; do
  grep -n -F -- "$giro" "$YO" "$LIB" >/dev/null 2>&1 && { BSD=$((BSD+1)); echo "   giro BSD-only: [$giro]"; }
done
[ "$BSD" -eq 0 ] && ok "T39 ni la suite ni la lib usan giros BSD-only (corre en el nocturno de Linux)" || no "T39 hay $BSD giro(s) BSD-only"

# ---------------------------------------------------------------- T22–T32b: los casos del BANCO existen
# Los casos que ejercen el hook y el aviso diario no son archivos de test: son JSON del banco de
# controles. El chequeo mecánico de cobertura (ACCOV-C1) sólo abre `*.test.sh` / `*.test.js` /
# `*Tests.cs`, así que esos casos le resultan invisibles y los reporta como «declarado sin
# implementación» — un CRITICAL falso, el mismo modo de falla que ya se corrigió en 2026-09-10
# cuando el escáner no abría los `.test.sh`. Acá se verifica desde un archivo que SÍ escanea que
# cada caso está registrado, con su T-ID al lado para que el grep lo encuentre. Si alguien borra un
# caso del banco, esto se pone rojo.
faltan_casos=""
caso_en(){ grep -q "\"$2\"" "$AQUI/scripts/controls-bench/cases/hooks/$1" 2>/dev/null || faltan_casos="$faltan_casos $2"; }
caso_en 04-rebuild-engram.json frena-el-commit-que-pierde-entradas-del-indice          # T22
caso_en 04-rebuild-engram.json con-el-interruptor-apagado-el-mismo-commit-pasa-y-avisa # T23
caso_en 04-rebuild-engram.json frena-el-chunk-nuevo-sin-entrada                        # T24
caso_en 04-rebuild-engram.json avisa-la-deriva-heredada-y-no-frena                     # T25
caso_en 04-rebuild-engram.json pasa-el-commit-sano-y-anota-paso                        # T26
caso_en 04-rebuild-engram.json sin-manifest-no-frena-y-dice-que-no-pudo-medir          # T27
caso_en 04-rebuild-engram.json un-repo-sin-memoria-todavia-no-dice-nada                # T27b
caso_en 04-rebuild-engram.json escape-por-comando-deja-pasar-y-queda-escrito           # T28
caso_en 04-rebuild-engram.json sin-el-criterio-no-frena-y-lo-dice                      # T29
caso_en 04-rebuild-engram.json push-sigue-sin-cruzar                                   # T30
caso_en 04-rebuild-engram.json la-constancia-no-tumba-al-hook                          # T31
caso_en 04-rebuild-engram.json el-primer-commit-de-memoria-no-se-frena-y-el-aviso-no-miente  # T31b
caso_en 15-engram-drift-notice.json el-arreglo-que-aconseja-corre-desde-cualquier-carpeta    # T32
caso_en 15-engram-drift-notice.json sin-el-criterio-el-aviso-lo-dice-y-no-sella-el-dia       # T32b
caso_en 04-rebuild-engram.json frena-lo-que-va-al-commit-aunque-el-disco-este-sano          # T22b
caso_en 04-rebuild-engram.json no-frena-por-un-disco-roto-que-no-va-al-commit               # T22c
caso_en 04-rebuild-engram.json con-commit-a-se-cruza-el-disco-porque-es-lo-que-viaja        # T22d
caso_en 04-rebuild-engram.json un-git-commit-adentro-de-un-string-no-es-un-commit           # T28b
caso_en 04-rebuild-engram.json el-escape-adentro-del-mensaje-no-abre                        # T28c
caso_en 04-rebuild-engram.json indice-con-entradas-sin-carpeta-de-chunks-no-es-silencio     # T27c
caso_en 04-rebuild-engram.json con-commit-a-y-sin-carpeta-de-chunks-dice-que-no-pudo-medir  # T27d
caso_en 04-rebuild-engram.json con-commit-all-tambien-se-cruza-el-disco                     # T22e
caso_en 04-rebuild-engram.json con-a-despues-del-mensaje-tambien-se-cruza-el-disco          # T22f
[ -z "$faltan_casos" ] \
  && ok "T22–T32b los 23 casos del banco están registrados en sus archivos de casos" \
  || no "T22–T32b faltan casos en el banco:$faltan_casos"
# T41b: el congelador del portón (T12 de trimmed-close.test.sh) compara POR FUNCIÓN, no el
# archivo entero — si vuelve al `git diff --quiet` del archivo, toda story que agregue un chequeo
# nace en rojo. Verificado además con 4 mutantes en la corrida (ver el reporte del Step 4).
# T38b/T38c: las dos comprobaciones nuevas del selftest del portón (base de merge · los avisos llegan al
# CLI) viven en tycon-ci-gate.js, que el cruce de cobertura no escanea; se verifica acá que existan.
grep -q "BASE DE MERGE" "$AQUI/scripts/ci/tycon-ci-gate.js" && grep -q "LLEGAN al CLI" "$AQUI/scripts/ci/tycon-ci-gate.js" && grep -q "sin base de merge" "$AQUI/scripts/ci/tycon-ci-gate.js" \
  && ok "T38b T38c T38d el selftest del portón trae la base de merge, los avisos que llegan al CLI y el caso sin base común" \
  || no "T38b/T38c faltan en el selftest del portón"
grep -q "funcion_js" "$AQUI/scripts/tests/trimmed-close.test.sh" 2>/dev/null \
  && ! grep -q 'diff --quiet origin/main -- scripts/ci/tycon-ci-gate.js' "$AQUI/scripts/tests/trimmed-close.test.sh" 2>/dev/null \
  && ok "T41b el congelador del portón compara por función, no el archivo entero" \
  || no "T41b cierre-recortado volvió a congelar el archivo entero de tycon-ci-gate.js"

# ---------------------------------------------------------------- Cli_SalidaGrandePorUnCano_LlegaEntera (story 8.18)
# El CLI cerraba con `process.exit(main(…))` justo después de un `console.log` grande. Con la salida por un caño y un
# lector que tarda, en macOS lo que el caño todavía no tomó se pierde al salir: llegaron 8192 bytes de 12 495 (el
# intermitente de T34 de legacy-names-b3.test.js, 2026-10-04, con la máquina cargada). Acá el reporte pasa de 200 KB
# —más que lo que guarda un caño— y el lector espera antes de leer: lo que llega por el caño tiene que ser, byte a
# byte, lo escrito a un archivo. (En Linux el caño se escribe entero antes de salir: allá esto ya daba verde.)
# 🔴 rojo previo verificado en macOS: con `process.exit(main(…))` por el caño llega sólo el principio.
nuevo_repo; chunk aaaa1111
# shellcheck disable=SC2046  # una palabra por id, a propósito
indice 'aaaa1111' $(node -e 'for (let i = 0; i < 4000; i++) console.log("phantom-" + String(i).padStart(6, "0") + "-0123456789abcdef0123456789abcdef")')
(cd "$R" && node "$LIB" cross --repo "$R" --json) > "$TMP/big-file.json" 2>"$TMP/err"; RCF=$?
(cd "$R" && node "$LIB" cross --repo "$R" --json) 2>>"$TMP/err" | (sleep 1; cat) > "$TMP/big-pipe.json"; RCP=${PIPESTATUS[0]}
BYTES_FILE="$(wc -c < "$TMP/big-file.json" | tr -d ' ')"; BYTES_PIPE="$(wc -c < "$TMP/big-pipe.json" | tr -d ' ')"
[ "$BYTES_FILE" -gt 200000 ] \
  && ok "la salida de prueba es grande de verdad ($BYTES_FILE bytes): más que lo que guarda un caño" \
  || no "la salida de prueba no es grande ($BYTES_FILE bytes): así no se mide nada — $(cat "$TMP/err")"
[ "$RCF" -eq 1 ] && [ "$RCP" -eq 1 ] && cmp -s "$TMP/big-file.json" "$TMP/big-pipe.json" \
  && ok "la salida --json grande llega entera por un caño con un lector lento, y el código de salida es el mismo (1)" \
  || no "por el caño llegaron $BYTES_PIPE bytes de $BYTES_FILE (rc archivo=$RCF · rc caño=$RCP): la salida se cortó al salir"

echo "─────────────"
[ $fallos -eq 0 ] && { echo "✅ manifest-engram: todo verde"; exit 0; } || { echo "❌ manifest-engram: $fallos falla(s)"; exit 1; }
