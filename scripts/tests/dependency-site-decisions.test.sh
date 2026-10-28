#!/usr/bin/env bash
# dependency-site-decisions.test.sh — Aceptar y Rechazar desde el sitio llegan al pull request de la ficha.
#
# Corre `scripts/ci/open-pr-per-finding.sh` (la fase de las decisiones del sitio) contra un repo de operaciones local
# (bare) y un árbol armado como el de la noche, con:
#   · GitHub: el `gh` de mentira (`scripts/tests/lib/fake-gh.js`), que también mergea de verdad en el repo bare;
#   · Azure: un `az` de mentira escrito acá, que sirve los pull requests desde un JSON, junta la rama en `main` al
#     completarlo y anota cada llamada.
# Cero red. Los casos:
#   S1 SitioGh_AceptarMergea · S2 SitioGh_RechazarCierraConMotivo · S3 SitioGh_PedidoCambiadoNoSeAplica
#   S4 SitioGh_SinGuardarNoDecide · S5 SitioAz_AceptarMergea · S6 SitioAz_RechazarCierraConMotivo
#   S7 SitioAz_NoSePudoMergear · S8 SitioAz_NadaQuedaVarado · S9 SitioGh_VeredictoConNota
# Uso: bash dependency-site-decisions.test.sh [S1 S5 …]   (sin argumentos corre todos)

set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAKE="$RAIZ/scripts/tests/lib/fake-gh.js"
OPERATIONS_REPO="acme-org/acme-operations"
HOY="2026-10-14"; export EL="2026-10-13"
SCRIPT_DEPS="scripts/nightly/dependencies/nightly-dependencies.js"
COLA="inbox/dependencies"

export HARNESS_TREE=arbol-de-prueba
unset AGENT_TEMPDIRECTORY GUARD_EXIT
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
       GIT_CONFIG_KEY_1=maintenance.auto GIT_CONFIG_VALUE_1=false GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_DATE="2026-10-14T05:00:00Z" GIT_COMMITTER_DATE="2026-10-14T05:00:00Z"
# la espera de la plataforma, en cero: un caso que tendría que esperar lo dice en vez de dormir
export TYCON_PR_WAIT_SECONDS=0

FALLOS=0; CASO=""; T=""; RC=0
TMPS=()
limpiar() { local d; for d in ${TMPS[@]+"${TMPS[@]}"}; do rm -rf "$d"; done; }
trap limpiar EXIT
caso() { CASO="$1 [$2]"; echo; echo "== $1 $2"; }
ok()  { echo "  ok   — $CASO: $1"; }
mal() {
  echo "  MAL  — $CASO: $1"; FALLOS=$((FALLOS+1))
  if [ -n "$T" ] && [ -s "$T/salida.txt" ]; then tail -n 6 "$T/salida.txt" | cut -c1-240 | sed 's/^/         salida: /'; fi
}
si() { local d="$1"; shift; if "$@" > /dev/null 2>&1; then ok "$d"; else mal "$d"; fi; }
contiene()    { grep -qE -- "$2" <<< "$1"; }
literal()     { grep -qF -- "$2" <<< "$1"; }
no_contiene() { ! grep -qE -- "$2" <<< "$1"; }
igual()       { [ "$1" = "$2" ]; }
quiero() { [ "${#ARGS[@]}" -eq 0 ] && return 0; local a; for a in "${ARGS[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }
ARGS=("$@")

# ── Fixture ────────────────────────────────────────────────────────────────────────────────────
montar() {
  T="$(mktemp -d)"; TMPS+=("$T"); mkdir -p "$T/bin"; : > "$T/gh.log"; : > "$T/az.log"
  git init -q --bare "$T/remoto.git"; git -C "$T/remoto.git" symbolic-ref HEAD refs/heads/main
  git clone -q "$T/remoto.git" "$T/semilla" 2>/dev/null; git -C "$T/semilla" symbolic-ref HEAD refs/heads/main
  local e; for e in pending promoted archived decisions; do mkdir -p "$T/semilla/$COLA/$e"; : > "$T/semilla/$COLA/$e/.gitkeep"; done
  sembrar base
  doble_az
}
sembrar() { git -C "$T/semilla" add -A; git -C "$T/semilla" -c user.email=b@b -c user.name=b commit -q -m "$1"; git -C "$T/semilla" push -q origin main; }
ficha() { # <estado> <id> [línea extra]...
  local E="$1" ID="$2" l V=pendiente; shift 2; [ "$E" = promoted ] && V=util
  { echo "id: $ID"; echo "detectado: 2026-10-10"; echo "veredicto: $V"; echo "paquete: browserslist"; echo "severidad: high"
    echo "noches: ${NOCHES:-2}"; for l in "$@"; do printf '%s\n' "$l"; done
    echo "ids:"; echo "  - $ID"; echo "repos:"; echo "  - A/A"; } > "$T/semilla/$COLA/$E/$ID.yaml"
}
decision() { # <id> <accion> <pr> <pr_repo|null> [motivo]
  node -e 'const [f,id,accion,pr,repo,motivo]=process.argv.slice(1);
    const d={ fuente:"dependencias", id, accion, quien:"lead@acme.example", el:process.env.EL, pr, pr_repo:repo==="null"?null:repo };
    if (motivo!==undefined) d.motivo=motivo;
    require("fs").writeFileSync(f, JSON.stringify(d));' "$T/semilla/$COLA/decisions/$1.json" "$@"
}
# La rama de un pedido como la dejó la noche que lo abrió: la ficha de AHORA en promoted/. Después, `main` cambia la
# ficha (otra noche la anotó): mergear esa rama vieja chocaría.
rama_vieja() { # <id>
  local ID="$1" B="dependencias/$1"
  git -C "$T/semilla" checkout -q -b "$B"
  sed 's/^veredicto: pendiente$/veredicto: util/' "$T/semilla/$COLA/pending/$ID.yaml" > "$T/semilla/$COLA/promoted/$ID.yaml"
  git -C "$T/semilla" rm -q "$COLA/pending/$ID.yaml"; git -C "$T/semilla" add -A
  git -C "$T/semilla" -c user.email=b@b -c user.name=b commit -q -m "rama de $ID"; git -C "$T/semilla" push -q origin "$B"
  git -C "$T/semilla" checkout -q main
  sed -i.bak 's/^noches: .*/noches: 5/' "$T/semilla/$COLA/pending/$ID.yaml"; rm -f "$T/semilla/$COLA/pending/$ID.yaml.bak"
  sembrar "otra noche anota $ID"
}
armar_arbol() {
  local J="$T/job"; rm -rf "$J"; mkdir -p "$J/scripts/ci" "$J/scripts/nightly"
  cp "$RAIZ/scripts/ci/open-pr-per-finding.sh" "$RAIZ/scripts/ci/legacy-options.sh" "$RAIZ/scripts/ci/push-nightly-data.js" "$J/scripts/ci/"
  cp -R "$RAIZ/scripts/nightly/dependencies" "$RAIZ/scripts/nightly/findings" "$J/scripts/nightly/"
  cp -R "$RAIZ/scripts/lib" "$J/scripts/lib"
  echo 'process.exit(Number(process.env.GUARD_EXIT || 0));' > "$J/scripts/ci/overlay-harness.js"
  printf '{"repos":[]}\n' > "$J/scripts/nightly/dependencies/repos.json"
  git -C "$J" init -q; git -C "$J" symbolic-ref HEAD refs/heads/main
  git -C "$T/remoto.git" archive main inbox | tar -x -C "$J"
  git -C "$J" config user.name 'github-actions[bot]'; git -C "$J" config user.email 'bot@example.invalid'
  git -C "$J" add -A -f; git -C "$J" commit -q -m "arnés y datos [local]"
  git -C "$J" remote add origin "$T/remoto.git"; git -C "$J" fetch -q origin main
}
publicar() { sembrar fixture; armar_arbol; }
estado_gh() { # <js con los pull requests>
  OPERATIONS_REPO="$OPERATIONS_REPO" REMOTE_PATH="$T/remoto.git" node -e '
    const OPERATIONS_REPO=process.env.OPERATIONS_REPO;
    const P=(number, ref, state, x={})=>({ number, state, merged_at:null, created_at:"2026-10-11T08:00:00Z",
      closed_at: state==="closed"?"2026-10-12T09:00:00Z":null, title:"pr "+number, body:"", head:{ ref },
      base:{ ref:"main", repo:{ full_name:OPERATIONS_REPO } }, user:{ login:"github-actions[bot]", type:"Bot" }, requested_reviewers:[], ...x });
    const extra=eval("("+process.argv[2]+")");
    require("fs").writeFileSync(process.argv[1], JSON.stringify({ user:"github-actions[bot]", now:"2026-10-14T05:00:00Z",
      remotes:{ [OPERATIONS_REPO]:process.env.REMOTE_PATH }, pulls:{}, comments:{}, reviews:{}, issues:{}, ...extra }, null, 2));
  ' "$T/gh.json" "$1"
}
# El `az` de mentira: pull requests desde AZ_STATE (lista), hilos por número, merge real en el bare al completar.
#   `lag: n` en un pull request = las primeras n consultas todavía muestran la punta vieja de la rama;
#   `complete_fails: "<texto>"` = completarlo falla con ese texto.
doble_az() {
  cat > "$T/bin/az" <<'AZ'
#!/usr/bin/env node
const fs=require('fs'), cp=require('child_process');
const a=process.argv.slice(2);
fs.appendFileSync(process.env.AZ_LOG, JSON.stringify(a)+'\n');
const arg=(k)=>{ const i=a.indexOf(k); return i<0?undefined:a[i+1]; };
const st=JSON.parse(fs.readFileSync(process.env.AZ_STATE,'utf8'));
const save=()=>fs.writeFileSync(process.env.AZ_STATE, JSON.stringify(st,null,1));
// el merge lo firma una identidad fija: en una HOME vacía git no tiene a quién poner
const ID_MERGE={GIT_AUTHOR_NAME:'azure',GIT_AUTHOR_EMAIL:'azure@acme.example',GIT_COMMITTER_NAME:'azure',GIT_COMMITTER_EMAIL:'azure@acme.example',GIT_AUTHOR_DATE:'2026-10-14T05:00:00Z',GIT_COMMITTER_DATE:'2026-10-14T05:00:00Z'};
const git=(...x)=>{ const r=cp.spawnSync('git',['-c','maintenance.auto=false','-C',process.env.AZ_REMOTE,...x],{encoding:'utf8',env:{...process.env,...ID_MERGE}}); if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);} return r.stdout.trim(); };
const punta=(ref)=>{ const r=cp.spawnSync('git',['-C',process.env.AZ_REMOTE,'rev-parse','-q','--verify',ref],{encoding:'utf8'}); return r.status===0?r.stdout.trim():null; };
const vista=(p)=>({ ...p, repository:{ id:'id-repo', name:'repo', project:{ id:'id-proyecto', name:'proyecto' } } });
const cmd=a.slice(0,3).join(' ');
if (cmd==='repos pr show') {
  const p=st.prs.find((x)=>String(x.pullRequestId)===arg('--id')); if(!p){process.stderr.write('no existe\n');process.exit(1);}
  if (p.status==='active') {
    if (p.lag>0) p.lag--; else { const t=punta(p.sourceRefName); if (t) p.lastMergeSourceCommit={ commitId:t }; }
    save();
  }
  console.log(JSON.stringify(vista(p))); process.exit(0);
}
if (cmd==='repos pr list') {
  const r='refs/heads/'+arg('--source-branch');
  console.log(JSON.stringify(st.prs.filter((p)=>p.sourceRefName===r).map(vista))); process.exit(0);
}
if (cmd==='repos pr update') {
  const p=st.prs.find((x)=>String(x.pullRequestId)===arg('--id')); if(!p){process.stderr.write('no existe\n');process.exit(1);}
  const s=arg('--status');
  if (s==='abandoned') { p.status='abandoned'; p.closedDate='2026-10-14T05:00:00Z'; save(); process.exit(0); }
  if (s==='completed') {
    if (p.complete_fails) { process.stderr.write(p.complete_fails+'\n'); process.exit(1); }
    const cab=git('rev-parse',p.sourceRefName), dst=git('rev-parse','refs/heads/main');
    if (!p.lastMergeSourceCommit || p.lastMergeSourceCommit.commitId!==cab) { process.stderr.write('se completó contra una punta vieja\n'); process.exit(1); }
    const arbol=git('merge-tree','--write-tree',dst,cab).split('\n')[0];
    const nuevo=git('commit-tree',arbol,'-p',dst,'-m','Merged PR '+p.pullRequestId);
    git('update-ref','refs/heads/main',nuevo,dst);
    if (arg('--delete-source-branch')==='true') git('update-ref','-d',p.sourceRefName);
    p.status='completed'; p.closedDate='2026-10-14T05:00:00Z'; save(); process.exit(0);
  }
}
if (cmd==='devops invoke --org' || a[0]==='devops') {
  const n=arg('--route-parameters') && a.find((x)=>x.startsWith('pullRequestId=')).split('=')[1];
  st.threads=st.threads||{}; st.threads[n]=st.threads[n]||[];
  if (arg('--http-method')==='POST') { st.threads[n].push(JSON.parse(fs.readFileSync(arg('--in-file'),'utf8'))); save(); process.exit(0); }
  console.log(JSON.stringify({ value:st.threads[n] })); process.exit(0);
}
process.stderr.write('az de mentira: no sé contestar '+a.join(' ')+'\n'); process.exit(1);
AZ
  chmod +x "$T/bin/az"
}
estado_az() { # <json de la lista de pull requests>
  printf '{"prs":%s}\n' "$1" > "$T/az.json"
}

correr_gh() { # [más argumentos]
  ( cd "$T/job" && TYCON_GH_CMD="$FAKE" FAKE_GH_STATE="$T/gh.json" FAKE_GH_LOG="$T/gh.log" \
      bash scripts/ci/open-pr-per-finding.sh --platform github --repo "$OPERATIONS_REPO" --queue "$COLA" --branch dependencias \
        --script "$SCRIPT_DEPS" --today "$HOY" "$@" ) > "$T/salida.txt" 2>&1 < /dev/null
  RC=$?
}
correr_az() { # [más argumentos]
  ( cd "$T/job" && PATH="$T/bin:$PATH" AZ_STATE="$T/az.json" AZ_LOG="$T/az.log" AZ_REMOTE="$T/remoto.git" \
      bash scripts/ci/open-pr-per-finding.sh --queue "$COLA" --branch dependencias --script "$SCRIPT_DEPS" \
        --org https://dev.azure.test/org --project proyecto --repo repo --today "$HOY" "$@" ) > "$T/salida.txt" 2>&1 < /dev/null
  RC=$?
}
SALIDA() { cat "$T/salida.txt"; }
enmain() { git -C "$T/remoto.git" show "main:$COLA/$1" 2>/dev/null; }    # <ruta dentro de la cola>
hay_en_main() { git -C "$T/remoto.git" cat-file -e "main:$COLA/$1" 2>/dev/null; }
no_hay_en_main() { ! hay_en_main "$1"; }
val_gh() { node -e 'const st=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const R=process.argv[3];try{console.log(String(eval(process.argv[2])))}catch(e){console.log("!error: "+e.message)}' "$T/gh.json" "$1" "$OPERATIONS_REPO"; }
nllam_gh() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);console.log(l.filter((e)=>eval(process.argv[2])).length)' "$T/gh.log" "$1"; }
val_az() { node -e 'const st=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));try{console.log(String(eval(process.argv[2])))}catch(e){console.log("!error: "+e.message)}' "$T/az.json" "$1"; }
nllam_az() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);console.log(l.filter((a)=>eval(process.argv[2])).length)' "$T/az.log" "$1"; }

# ══════════════════════════════════════════════════════════════════════════════════════════════
if quiero S1; then
  caso "S1 SitioGh_AceptarMergea" "aceptar mergea el pedido de la ficha, sin chocar con lo que main anotó después"
  montar
  ficha pending aa11 "pr: 12" "pr_repo: $OPERATIONS_REPO" "decision_fallida: 2026-10-12" 'motivo_decision_fallida: "no se pudo"'
  sembrar "ficha"; rama_vieja aa11
  decision aa11 aceptar 12 "$OPERATIONS_REPO"
  estado_gh '{ pulls:{ [OPERATIONS_REPO]:[ P(12,"dependencias/aa11","open") ] } }'
  publicar
  correr_gh
  si "sale 0" [ "$RC" = 0 ]
  si "mergea el #12 una vez, por squash y sobre la punta que empujó" [ "$(nllam_gh 'e.method==="PUT"&&/pulls\/12\/merge$/.test(e.ruta)&&e.cuerpo.merge_method==="squash"&&/^[0-9a-f]{40}$/.test(e.cuerpo.sha)')" = 1 ]
  si "el #12 queda mergeado" [ "$(val_gh '!!st.pulls[R][0].merged_at')" = true ]
  si "en main la ficha está en promoted/ con util y el día de la decisión" bash -c '[[ "$1" =~ (^|$'"'\n'"')veredicto:\ util ]] && [[ "$1" == *"decidido_en_sitio: '"$EL"'"* ]]' _ "$(enmain promoted/aa11.yaml)"
  si "…con lo que main anotó después (noches: 5)" contiene "$(enmain promoted/aa11.yaml)" '^noches: 5$'
  si "…sin la marca de la decisión que no se aplicó antes" no_contiene "$(enmain promoted/aa11.yaml)" 'decision_fallida'
  si "…y ya no en pending/" no_hay_en_main pending/aa11.yaml
  si "la decisión se borró de main" no_hay_en_main decisions/aa11.json
  si "no anota ninguna decisión fallida" no_contiene "$(SALIDA)" 'no se aplicó'
fi

if quiero S2; then
  caso "S2 SitioGh_RechazarCierraConMotivo" "rechazar cierra el pedido y el motivo va como comentario y a la ficha, sin pasar por la consola"
  montar
  ficha pending bb22 "pr: 14" "pr_repo: $OPERATIONS_REPO"
  sembrar "ficha"
  MOTIVO='no viaja al navegador, @lider: $(touch PWNED) `id` "comillas" ##vso[task.complete result=Succeeded]'
  decision bb22 reject 14 "$OPERATIONS_REPO" "$MOTIVO"
  estado_gh '{ pulls:{ [OPERATIONS_REPO]:[ P(14,"dependencias/bb22","open") ] } }'
  publicar
  correr_gh
  si "sale 0" [ "$RC" = 0 ]
  si "cierra el #14 sin mergearlo" [ "$(val_gh 'st.pulls[R][0].state+" "+!!st.pulls[R][0].merged_at')" = "closed false" ]
  CUERPO=$(val_gh '(st.comments[R+"#14"]||[]).map((c)=>c.body).join("|")')
  si "el comentario lleva el motivo tal cual escribió la persona" literal "$CUERPO" 'no viaja al navegador'
  si "…con \$(…) y las comillas literales, sin ejecutar nada" bash -c '[[ "$1" == *"\$(touch PWNED) \`id\` \"comillas\""* ]] && [ ! -e "$2/job/PWNED" ]' _ "$CUERPO" "$T"
  si "…y el @ sin mencionar a nadie" bash -c '[[ "$1" != *"@lider"* ]]' _ "$CUERPO"
  F=$(enmain pending/bb22.yaml)
  si "la ficha sigue viva en pending/ con su rechazo del día de la decisión" bash -c '[[ "$1" == *"rechazado: '"$EL"'"* ]] && [[ "$1" == *"veredicto: pendiente"* ]]' _ "$F"
  si "…y el motivo de la persona, no «sin motivo escrito»" bash -c '[[ "$1" == *"motivo_rechazo:"*"no viaja al navegador"* ]] && [[ "$1" != *"sin motivo escrito"* ]]' _ "$F"
  si "la decisión se borró de main" no_hay_en_main decisions/bb22.json
  si "el motivo no se imprime (ni su ##vso[ llega a la consola)" no_contiene "$(SALIDA)" 'touch PWNED|##vso\[task\.complete'
fi

if quiero S3; then
  caso "S3 SitioGh_PedidoCambiadoNoSeAplica" "(c) si el pedido no es el que vio la persona, no se toca y queda anotado"
  montar
  ficha pending cc33 "pr: 15" "pr_repo: $OPERATIONS_REPO"     # la persona vio el 12
  ficha pending dd44 "pr: 13" "pr_repo: $OPERATIONS_REPO"     # el 13 ya está cerrado
  ficha pending ee55 "pr: 16" "pr_repo: acme-org/otro"        # de otro repo
  ficha promoted ff66 "pr: 17" "pr_repo: $OPERATIONS_REPO"    # ya no está pendiente
  sembrar "fichas"
  decision cc33 aceptar 12 "$OPERATIONS_REPO"
  decision dd44 reject 13 "$OPERATIONS_REPO" "no aplica"
  decision ee55 aceptar 16 "acme-org/otro"
  decision ff66 aceptar 17 "$OPERATIONS_REPO"
  estado_gh '{ pulls:{ [OPERATIONS_REPO]:[ P(12,"dependencias/x","open"), P(13,"dependencias/dd44","closed"), P(15,"dependencias/cc33","open"), P(17,"dependencias/ff66","open") ] } }'
  publicar
  correr_gh
  si "sale 0 (no aplicar es un aviso, no un fallo)" [ "$RC" = 0 ]
  si "no mergea ni cierra nada" [ "$(nllam_gh 'e.method==="PUT"||e.method==="PATCH"')" = 0 ]
  si "ni comenta" [ "$(nllam_gh 'e.method==="POST"&&/comments$/.test(e.ruta)')" = 0 ]
  si "el pedido cambiado: la ficha anota el día y el porqué" bash -c '[[ "$1" == *"decision_fallida: '"$HOY"'"* ]] && [[ "$1" == *"motivo_decision_fallida:"*"#12"*"#15"* ]]' _ "$(enmain pending/cc33.yaml)"
  # alguien ya lo cerró en GitHub: eso sí es un rechazo (lo anota la fase de siempre), y el rechazo borra la marca
  si "el pedido cerrado: la salida dice que ya no está abierto" contiene "$(SALIDA)" 'dd44: la decisión del sitio no se aplicó — el #13 ya no está abierto'
  si "…y la ficha queda con el rechazo de quien lo cerró, sin la marca" bash -c '[[ "$1" == *"rechazado: 2026-10-12"* ]] && [[ "$1" != *"decision_fallida"* ]]' _ "$(enmain pending/dd44.yaml)"
  si "el de otro repo: también anotado" contiene "$(enmain pending/ee55.yaml)" "^decision_fallida: $HOY$"
  si "la que ya no estaba pendiente no se marca" no_contiene "$(enmain promoted/ff66.yaml)" 'decision_fallida'
  si "las cuatro decisiones se borraron" bash -c '! git -C "$1" ls-tree -r --name-only main | grep "decisions/.*\.json" >/dev/null' _ "$T/remoto.git"
  si "la salida lo dice" contiene "$(SALIDA)" 'cc33: la decisión del sitio no se aplicó'
fi

if quiero S4; then
  caso "S4 SitioGh_SinGuardarNoDecide" "la pasada que no puede escribir no aplica nada"
  montar
  ficha pending aa11 "pr: 12" "pr_repo: $OPERATIONS_REPO"; sembrar "ficha"
  decision aa11 aceptar 12 "$OPERATIONS_REPO"
  estado_gh '{ pulls:{ [OPERATIONS_REPO]:[ P(12,"dependencias/aa11","open") ] } }'
  publicar
  correr_gh --record-only --no-save
  si "sale 0" [ "$RC" = 0 ]
  si "no mergea" [ "$(nllam_gh 'e.method==="PUT"')" = 0 ]
  si "la decisión sigue en el disco" [ -f "$T/job/$COLA/decisions/aa11.json" ]
fi

if quiero S5; then
  caso "S5 SitioAz_AceptarMergea" "en Azure: espera a que el pedido tome la rama rehecha, lo completa y la ficha queda en main"
  montar
  ficha pending aa11 "pr: 5255"; sembrar "ficha"; rama_vieja aa11
  decision aa11 aceptar 5255 null
  ficha pending bb22 "pr: 5256"; sembrar "otra"
  decision bb22 aceptar 5256 null
  VIEJA=$(git -C "$T/remoto.git" rev-parse refs/heads/dependencias/aa11)
  estado_az "[{\"pullRequestId\":5255,\"status\":\"active\",\"sourceRefName\":\"refs/heads/dependencias/aa11\",\"creationDate\":\"2026-10-11T08:00:00Z\",\"lastMergeSourceCommit\":{\"commitId\":\"$VIEJA\"}},
              {\"pullRequestId\":5256,\"status\":\"active\",\"sourceRefName\":\"refs/heads/dependencias/bb22\",\"creationDate\":\"2026-10-11T08:00:00Z\",\"lag\":9}]"
  publicar
  correr_az --record-only
  si "sale 0" [ "$RC" = 0 ]
  si "completa el 5255 por squash y borra su rama" [ "$(nllam_az 'a.includes("update")&&a.includes("5255")&&a.includes("completed")&&a.join(" ").includes("--squash true")&&a.join(" ").includes("--delete-source-branch true")')" = 1 ]
  si "el 5255 queda completado" [ "$(val_az 'st.prs[0].status')" = completed ]
  si "en main la ficha está en promoted/ con util y el día" bash -c '[[ "$1" == *"veredicto: util"* ]] && [[ "$1" == *"decidido_en_sitio: '"$EL"'"* ]] && [[ "$1" == *"noches: 5"* ]]' _ "$(enmain promoted/aa11.yaml)"
  si "…y no en pending/, y su decisión se borró" bash -c '! git -C "$1" cat-file -e main:inbox/dependencies/pending/aa11.yaml 2>/dev/null && ! git -C "$1" cat-file -e main:inbox/dependencies/decisions/aa11.json 2>/dev/null' _ "$T/remoto.git"
  si "el 5256 (Azure no tomó la rama todavía) no se completa" [ "$(nllam_az 'a.includes("update")&&a.includes("5256")')" = 0 ]
  si "…su decisión queda para mañana y la ficha no se marca" bash -c 'git -C "$1" cat-file -e main:inbox/dependencies/decisions/bb22.json && ! git -C "$1" show main:inbox/dependencies/pending/bb22.yaml | grep decision_fallida >/dev/null' _ "$T/remoto.git"
  si "…y lo dice" contiene "$(SALIDA)" 'bb22: el .*5256 se aceptó en el sitio y no se pudo confirmar'
fi

if quiero S6; then
  caso "S6 SitioAz_RechazarCierraConMotivo" "en Azure: abandona el pedido y deja el motivo en un hilo"
  montar
  ficha pending bb22 "pr: 5430"; sembrar "ficha"
  decision bb22 reject 5430 null 'es de desarrollo; @dev1 lo revisó'
  estado_az '[{"pullRequestId":5430,"status":"active","sourceRefName":"refs/heads/dependencias/bb22","creationDate":"2026-10-11T08:00:00Z"}]'
  publicar
  correr_az --record-only
  si "sale 0" [ "$RC" = 0 ]
  si "abandona el 5430" [ "$(val_az 'st.prs[0].status')" = abandoned ]
  si "el hilo lleva el motivo, con el @ desactivado" [ "$(val_az 'JSON.stringify(st.threads["5430"]).includes("es de desarrollo; @​dev1 lo revisó")')" = true ]
  si "…y llega por archivo (--in-file), no armado en la línea de comandos" [ "$(nllam_az 'a.includes("--in-file")&&!a.join(" ").includes("es de desarrollo")')" = 1 ]
  F=$(enmain pending/bb22.yaml)
  si "la ficha anota el rechazo con el motivo de la persona" bash -c '[[ "$1" == *"rechazado: '"$EL"'"* ]] && [[ "$1" == *"es de desarrollo"* ]]' _ "$F"
  si "la decisión se borró" no_hay_en_main decisions/bb22.json
fi

if quiero S7; then
  caso "S7 SitioAz_NoSePudoMergear" "si Azure no lo completa, la ficha lo anota y vuelve a decidirse"
  montar
  ficha pending cc33 "pr: 6000"; sembrar "ficha"
  decision cc33 aceptar 6000 null
  estado_az '[{"pullRequestId":6000,"status":"active","sourceRefName":"refs/heads/dependencias/cc33","creationDate":"2026-10-11T08:00:00Z","complete_fails":"TF401027: la política de la rama pide un revisor"}]'
  publicar
  correr_az --record-only
  si "sale 0" [ "$RC" = 0 ]
  si "el 6000 sigue activo" [ "$(val_az 'st.prs[0].status')" = active ]
  F=$(enmain pending/cc33.yaml)
  si "la ficha sigue pendiente y anota el porqué de Azure" bash -c '[[ "$1" == *"veredicto: pendiente"* ]] && [[ "$1" == *"decision_fallida: '"$HOY"'"* ]] && [[ "$1" == *"TF401027"* ]]' _ "$F"
  si "la decisión se borró: vuelve a «Te toca decidir»" no_hay_en_main decisions/cc33.json
fi

if quiero S8; then
  caso "S8 SitioAz_NadaQuedaVarado" "una rama que la noche no puede rehacer, un merge sin confirmar tres noches y un motivo «-»"
  montar
  ficha pending dd44 "pr: 7001"; ficha pending ee55 "pr: 7002"; ficha pending ff66 "pr: 7003"; sembrar "fichas"
  decision dd44 aceptar 7001 null
  EL=2026-10-11 decision ee55 aceptar 7002 null
  decision ff66 reject 7003 null '-'
  estado_az '[{"pullRequestId":7001,"status":"active","sourceRefName":"refs/heads/a-mano/dd44","creationDate":"2026-10-11T08:00:00Z"},
              {"pullRequestId":7002,"status":"active","sourceRefName":"refs/heads/dependencias/ee55","creationDate":"2026-10-11T08:00:00Z","lag":99},
              {"pullRequestId":7003,"status":"active","sourceRefName":"refs/heads/dependencias/ff66","creationDate":"2026-10-11T08:00:00Z"}]'
  publicar
  correr_az --record-only
  si "sale 0" [ "$RC" = 0 ]
  si "el de otra rama no se completa" [ "$(nllam_az 'a.includes("update")&&a.includes("7001")')" = 0 ]
  si "…y vuelve a decidirse, diciendo por qué" bash -c '[[ "$1" == *"decision_fallida: '"$HOY"'"* ]] && [[ "$1" == *"a-mano/dd44"* ]]' _ "$(enmain pending/dd44.yaml)"
  si "el que no se confirmó en tres noches vuelve a decidirse" bash -c '[[ "$1" == *"decision_fallida: '"$HOY"'"* ]] && [[ "$1" == *"3 noches"* ]]' _ "$(enmain pending/ee55.yaml)"
  si "…y su decisión se borró" no_hay_en_main decisions/ee55.json
  si "el motivo «-» llega al hilo como motivo" [ "$(val_az 'JSON.stringify(st.threads["7003"]).includes("Motivo: -")')" = true ]
  si "…y a la ficha" contiene "$(enmain pending/ff66.yaml)" '^motivo_rechazo: "-"$'
fi

if quiero S9; then
  caso "S9 SitioGh_VeredictoConNota" "una ficha con «veredicto: pendiente # nota» llega a promoted/ como útil, igual que la sin nota"
  montar
  ficha pending gg77 "pr: 14" "pr_repo: $OPERATIONS_REPO"
  sed -i.bak 's/^veredicto: pendiente$/veredicto: "pendiente" # decision-en-curso/' "$T/semilla/$COLA/pending/gg77.yaml" && rm -f "$T/semilla/$COLA/pending/gg77.yaml.bak"
  sembrar "ficha"; rama_vieja gg77
  decision gg77 aceptar 14 "$OPERATIONS_REPO"
  estado_gh '{ pulls:{ [OPERATIONS_REPO]:[ P(14,"dependencias/gg77","open") ] } }'
  publicar
  correr_gh
  si "sale 0" [ "$RC" = 0 ]
  si "el #14 queda mergeado" [ "$(val_gh '!!st.pulls[R][0].merged_at')" = true ]
  si "en main la ficha está en promoted/ con util y el día de la decisión" bash -c '[[ "$1" =~ (^|$'"'\n'"')veredicto:\ util ]] && [[ "$1" == *"decidido_en_sitio: '"$EL"'"* ]]' _ "$(enmain promoted/gg77.yaml)"
  si "…sin el veredicto pendiente" no_contiene "$(enmain promoted/gg77.yaml)" 'pendiente'
fi

echo
if [ "$FALLOS" = 0 ]; then echo "✅ dependency-site-decisions: todo en orden"; exit 0; fi
echo "❌ dependency-site-decisions: $FALLOS fallo(s)"; exit 1
