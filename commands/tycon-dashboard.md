---
description: Genera y abre las dos páginas del tablero — la del equipo (la arma el proceso de la noche, a pedido) y la de las corridas de todas las máquinas
allowed-tools: Bash(node:*), Bash(az:*), Bash(gh:*), Bash(git:*), Bash(mkdir:*), Read
---

Generá y abrí en el navegador las dos páginas del tablero, sin pedirle a la persona ningún dato que el arnés ya sabe:

1. **El tablero del equipo** (la página `tablero-del-arnes.html`, en el repo de operaciones de la organización): lo arma el
   proceso de la noche `team-dashboard`. Acá se lanza a pedido, se sigue **de fondo** y, cuando termina bien, se trae la
   página y se abre.
2. **La vista de corridas**: las corridas del pipeline de todas las máquinas, bajadas del buzón de corridas. Se arma en
   esta máquina en segundos.

Las dos órdenes son de Bash: en Windows, la terminal de Claude Code es Git Bash y sirven igual. Cada orden corre con la
entrada cerrada (`< /dev/null`) y **mirando su código de salida**: una salida vacía de una orden que falló es «no pude
mirar», nunca «no hay».

## 0 · Dónde está todo

```bash
ARNES="${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}"
test -f "$ARNES/scripts/setup/harness.js" || echo "SIN ARNÉS en $ARNES"
# una carpeta propia, fuera de todo repo, para lo que este comando baja y escribe
DIR="$(node -p 'require("path").join(require("os").tmpdir(), "tycon-dashboard")')"; mkdir -p "$DIR"
# el repo de operaciones de la organización: { platform, org, project (sólo azure), repo }
node "$ARNES/scripts/lib/team-repos.js" "$ARNES/team-repos.json" --json < /dev/null; echo "rc=$?"
# su clon en esta máquina, si hay (exit 3 = no declarado)
node "$ARNES/scripts/lib/tycon-config.js" get paths.operations < /dev/null; echo "rc=$?"
```

- `SIN ARNÉS` → decí que el arnés no está instalado en esta máquina y pará.
- `team-repos.js` sale 0 → usá `data.operations`. Sale 1 o 2 → no hay de dónde saber dónde vive el repo de operaciones
  ni su proceso de la noche. **Decilo así y pedí los datos una sola vez**, todos juntos: la plataforma (Azure DevOps o
  GitHub), la organización, el proyecto (sólo Azure) y el repo de operaciones. Con eso seguís; no los vuelvas a pedir en
  la sesión. La vista de corridas (punto 2) no los necesita: armala igual.
- **No abras ni muestres `~/.tycon/config.json`** (puede traer credenciales): los valores salen de estas órdenes.

## 1 · Lanzar el tablero del equipo (y seguirlo de fondo)

Con `operations.platform`:

**azure** (`ORG=https://dev.azure.com/<org>`, `PROJ=<project>`, `REPO=<repo>`):

```bash
# el proceso es el del repo de operaciones cuyo YAML es pipelines/team-dashboard.yml (no se adivina por el nombre)
for id in $(az pipelines list --org "$ORG" --project "$PROJ" --repository "$REPO" --repository-type tfsgit --query "[].id" -o tsv < /dev/null); do
  [ "$(az pipelines show --org "$ORG" --project "$PROJ" --id "$id" --query process.yamlFilename -o tsv < /dev/null)" = "pipelines/team-dashboard.yml" ] && echo "def=$id"
done
# ¿ya hay una corrida en marcha? Entonces se sigue ésa: no se encola otra
az pipelines runs list --org "$ORG" --project "$PROJ" --pipeline-ids "$DEF" --top 5 --query "[?status!='completed'].id" -o tsv < /dev/null; echo "rc=$?"
# si no hay ninguna:
az pipelines run --org "$ORG" --project "$PROJ" --id "$DEF" --branch main --query id -o tsv < /dev/null; echo "rc=$?"
```

Si no aparece ningún `def=`, decí que el repo de operaciones no tiene dado de alta el proceso del tablero
(`pipelines/team-dashboard.yml`) y seguí con el punto 2. Si encolar falla, decí el error tal cual: no reintentes.

Seguí la corrida **de fondo** (en Claude Code, Bash con `run_in_background`), con un tope de 40 minutos:

```bash
for i in $(seq 1 120); do
  R="$(az pipelines runs show --org "$ORG" --project "$PROJ" --id "$RUN" --query "[status,result]" -o tsv < /dev/null)" || { echo "NO PUDE MIRAR la corrida $RUN"; exit 2; }
  case "$R" in completed*) echo "terminó: $R"; exit 0 ;; esac
  sleep 20
done
echo "SIGUE CORRIENDO después de 40 minutos: corrida $RUN"; exit 3
```

**github** (`REPO=<org>/<repo>`):

```bash
gh run list --repo "$REPO" --workflow team-dashboard.yml --limit 5 --json databaseId,status --jq '.[] | select(.status != "completed") | .databaseId' < /dev/null; echo "rc=$?"
# si no hay ninguna en marcha: anotá la más nueva de antes, lanzá, y la corrida es la primera con otro número
ANTES="$(gh run list --repo "$REPO" --workflow team-dashboard.yml --limit 1 --json databaseId --jq '.[0].databaseId' < /dev/null)"
gh workflow run team-dashboard.yml --repo "$REPO" --ref main < /dev/null; echo "rc=$?"
gh run list --repo "$REPO" --workflow team-dashboard.yml --limit 1 --json databaseId --jq '.[0].databaseId' < /dev/null   # repetir cada 5 s hasta que no sea $ANTES
```

De fondo: `gh run watch "$RUN" --repo "$REPO" --exit-status < /dev/null > /dev/null; echo "rc=$?"` y después
`gh run view "$RUN" --repo "$REPO" --json conclusion --jq .conclusion`.

**Mientras corre, no esperes: hacé el punto 2.** La notificación de fondo llega sola.

## 2 · La vista de corridas de todas las máquinas

```bash
node "$ARNES/scripts/metrics/download-runs.js" --json < /dev/null > "$DIR/bajada.json"; echo "rc=$?"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.completo, r.estado, r.motivo||"")' "$DIR/bajada.json"
# la carpeta donde quedó lo bajado
BUZON="$(node -e 'const p=require("path"),os=require("os");let s;try{s=require(process.argv[1]).stateDir(os.homedir())}catch(e){s=p.join(os.homedir(),".claude",".tycon-pipeline")}console.log(process.env.TYCON_MAILBOX_DIR||p.join(s,"corridas-buzon"))' "$ARNES/scripts/setup/harness/tycon-home.js")"
```

| Lo que dice la bajada | Qué hacés | Qué le decís |
|---|---|---|
| `completo` true | `dashboard.js --view runs --mailbox "$BUZON"` | nada: es la vista entera |
| estado `sin_az`, `sin_sesion`, `sin_permiso` o `apagado` | `dashboard.js --view runs --local-only` | «esta máquina no puede leer el buzón (el motivo, en una línea): la vista trae **sólo las corridas de esta máquina**» |
| otro estado, o salió 1 o 2 | con `"$BUZON"` si la carpeta existe; si no, `--local-only` | «no se pudo bajar lo nuevo del buzón (el estado): la vista trae lo que ya estaba bajado» o «sólo las de esta máquina» |

```bash
node "$ARNES/scripts/nightly/dashboard/dashboard.js" --view runs --mailbox "$BUZON" < /dev/null; echo "rc=$?"   # o --local-only
```

La página queda en la ruta de la línea `Página escrita: <ruta>`. Abrila (sirve en Mac, Windows y Linux):

```bash
node -e 'const p=require("path").resolve(process.argv[1]),{spawn}=require("child_process");const [c,a]=process.platform==="darwin"?["open",[p]]:process.platform==="win32"?["cmd",["/c","start","",p]]:["xdg-open",[p]];spawn(c,a,{detached:true,stdio:"ignore",windowsHide:true}).unref()' "<ruta>"
```

Si `dashboard.js` no sale 0, no hay página nueva: decilo con su error y no abras una vieja.

## 3 · Cuando el tablero del equipo termina

| Resultado | Qué hacés |
|---|---|
| Azure `succeeded` · GitHub `success` | traés la página y la abrís |
| Azure `partiallySucceeded` | la traés y la abrís, y decís que salió **parcial** (lo dice la propia página arriba) |
| `failed`, `canceled`, `NO PUDE MIRAR` o 40 minutos sin terminar | no abrís nada: decís cómo terminó y el enlace a la corrida |

Traer la página de `main` del repo de operaciones, **sin tocar el checkout de nadie**:

```bash
# con clon (paths.operations): sólo actualiza la referencia remota, no mueve la carpeta de trabajo
git -C "$OPS" fetch --quiet origin main < /dev/null && git -C "$OPS" show origin/main:artifacts/tablero-del-arnes.html > "$DIR/tablero-del-arnes.html"; echo "rc=$?"
# sin clon, Azure:
az devops invoke --org "$ORG" --area git --resource items --route-parameters project="$PROJ" repositoryId="$REPO" \
  --query-parameters path=/artifacts/tablero-del-arnes.html versionDescriptor.version=main versionDescriptor.versionType=branch download=true '$format=octetStream' \
  --api-version 7.1 --accept-media-type application/octet-stream --out-file "$DIR/tablero-del-arnes.html" -o none < /dev/null; echo "rc=$?"
# sin clon, GitHub:
gh api "repos/$REPO/contents/artifacts/tablero-del-arnes.html?ref=main" -H "Accept: application/vnd.github.raw" < /dev/null > "$DIR/tablero-del-arnes.html"; echo "rc=$?"
```

Antes de abrirla, mirá que sea **de esta corrida** (el sello que la página trae adentro):

```bash
node -e 'const s=require(process.argv[1]).leer(require("fs").readFileSync(process.argv[2],"utf8"));console.log(s.sello?`corrida ${s.sello.corrida} · generada ${s.sello.generado} · buzón ${s.sello.buzon.estado}`:`sin sello: ${s.motivo}`)' "$ARNES/scripts/nightly/dashboard/seal.js" "$DIR/tablero-del-arnes.html"
```

Si la corrida del sello no es la que lanzaste, la publicada todavía es otra: decí de cuándo es y no la presentes como la
de recién. Si el sello dice `buzón no_leido`, las fichas del equipo salen sin número: decilo.

## Qué le contás

Corto y en castellano llano, sin rutas salvo que las pida:

- Qué abriste: «abrí el tablero del equipo (recién generado)» y «abrí la vista de corridas de N máquinas».
- Lo parcial, una línea cada cosa: la vista sólo con esta máquina y por qué, el tablero naranja o con el buzón sin leer.
- Lo que no salió, con su motivo, y si queda algo para hacer.

Mientras el tablero del equipo corre de fondo, decí una vez que tarda unos minutos y que avisás al terminar.

## Reglas duras

- No encoles dos corridas: si hay una en marcha, seguís ésa. Si falla, no la relances sola: lo decide la persona.
- No escribas en ningún repo: las dos páginas van a la carpeta de este comando o a la que elige el generador, fuera de
  todo repo. No hagas `pull`, `checkout` ni `commit` en el clon de operaciones.
- No pidas un login de `az` ni de `gh` desde acá: sin sesión, decilo y seguí con lo que se pueda.
