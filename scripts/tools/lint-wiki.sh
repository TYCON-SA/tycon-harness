#!/usr/bin/env bash
# lint-wiki.sh — chequea integridad de specs/wiki/topics/
#
# Reglas:
#   1. Cada story listada en `related_stories` de un topic page debe tener
#      `topics: [<slug>]` en su frontmatter (alineación bidireccional).
#   2. Cada story con `topics: [<slug>]` en su frontmatter debe existir como
#      page en `specs/wiki/topics/<slug>.md` y estar mencionada ahí.
#   3. `pending_decisions` con `blocking` se reportan como warnings.
#
# Exit code: 0 si OK, 1 si errors.
#
# Perf: hacer `grep -lE` sobre TODO stories/*.md por CADA related_id de CADA topic sería
# O(topics × ids × N_stories) y ~1300 forks (grep/sed/tr por archivo, ×2 pasadas): con 270 stories
# pasaría >90s y reventaría el timeout del git pre-commit (parecería "colgado"). Por eso se construyen
# 2 índices con UNA pasada awk cada uno y los cross-checks leen esos índices chicos.
# Compatible con el bash 3.2 de macOS (sin `declare -A`; comparación de STRING forzada
# en awk con `("" )` para que "13.3" != "13.30").

set -uo pipefail

# Resolución del specs/ a lintear, en orden de precedencia:
#   1. Primer argumento    → ./lint-wiki.sh /ruta/al/repo/specs
#   2. Env SPECS_DIR       → SPECS_DIR=... ./lint-wiki.sh
#   3. Raíz del repo git desde el cwd  ← el caso normal (pre-commit del repo, o
#      correrlo a mano parado en el repo). Permite que este script viva SOLO en
#      el arnés y que los proyectos lo referencien por path, sin copia.
#   4. Fallback: ../../specs relativo al script, que vive en scripts/tools/
#      (cuando el script SÍ vive dentro del repo que lintea — compatibilidad con
#      clones viejos, que traen el script en scripts/, donde es ../specs).
if [ "${1:-}" != "" ]; then
  SPECS_DIR="$1"
elif [ "${SPECS_DIR:-}" != "" ]; then
  : # ya viene por env
elif GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -d "$GIT_ROOT/specs" ]; then
  SPECS_DIR="$GIT_ROOT/specs"
else
  SPECS_DIR="$(cd "$(dirname "$0")/../../specs" 2>/dev/null && pwd || true)"
fi

if [ -z "${SPECS_DIR:-}" ] || [ ! -d "$SPECS_DIR" ]; then
  echo "❌ No encontré el directorio specs/ a lintear."
  echo "   Pasalo como argumento (./lint-wiki.sh /ruta/al/repo/specs), por env"
  echo "   SPECS_DIR=..., o corré el script parado dentro del repo."
  exit 1
fi

WIKI_DIR="$SPECS_DIR/wiki/topics"
STORIES_DIR="$SPECS_DIR/stories"

errors=0
warnings=0

if [ ! -d "$WIKI_DIR" ]; then
  echo "❌ No existe $WIKI_DIR — el wiki no está inicializado."
  exit 1
fi

echo "Lint wiki — $WIKI_DIR"
echo ""

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/wikilint.XXXXXX")
trap 'rm -rf "$TMPD"' EXIT
STORY_IDX="$TMPD/stories.tsv"   # id <TAB> basename <TAB> topicscsv
TOPIC_IDX="$TMPD/topics.tsv"    # slug <TAB> related_csv

# ── Índice de stories: 1 sola pasada awk (id, basename, topicscsv) ──
awk '
  function flush(){ if (pf != "") print psid "\t" pbase "\t" ptop }
  FILENAME != pf { flush(); pf=FILENAME; psid=""; ptop=""; nn=split(FILENAME,aa,"/"); pbase=aa[nn] }
  psid == "" && /^story:/  { s=$0; sub(/^story:[[:space:]]*"?/,"",s); sub(/[" #\t].*/,"",s); psid=s }
  ptop == "" && /^topics:/ { t=$0; sub(/^topics:[[:space:]]*\[/,"",t); sub(/\].*/,"",t); gsub(/[ "]/,"",t); ptop=t }
  END { flush() }
' "$STORIES_DIR"/*.md > "$STORY_IDX"

# ── Índice de topics: 1 sola pasada awk (slug, related_csv) ──
awk '
  function flush(){ if (pf != "") print pslug "\t" prel }
  FILENAME != pf { flush(); pf=FILENAME; prel=""; nn=split(FILENAME,aa,"/"); b=aa[nn]; sub(/\.md$/,"",b); pslug=b }
  prel == "" && /^related_stories:/ { r=$0; sub(/^related_stories:[[:space:]]*\[/,"",r); sub(/\].*/,"",r); gsub(/[ "]/,"",r); prel=r }
  END { flush() }
' "$WIKI_DIR"/*.md > "$TOPIC_IDX"

# Lookups (awk con comparación de STRING forzada: "" evita que == trate "13.3"=="13.30")
story_topics() { awk -F'\t' -v id="$1" '($1"")==(id""){print $3; found=1; exit} END{if(!found)print "__NONE__"}' "$STORY_IDX"; }
story_base()   { awk -F'\t' -v id="$1" '($1"")==(id""){print $2; exit}' "$STORY_IDX"; }
topic_related(){ awk -F'\t' -v s="$1" '($1"")==(s""){print $2; exit}' "$TOPIC_IDX"; }

# ====== Pasada 1: topic → stories ======
while IFS=$'\t' read -r topic_slug related; do
  echo "📄 $topic_slug"
  if [ -z "$related" ]; then
    echo "  ⚠ falta campo related_stories en frontmatter"
    warnings=$((warnings + 1))
  else
    OLDIFS=$IFS; IFS=','
    for story_id in $related; do
      [ -z "$story_id" ] && continue
      topics_csv=$(story_topics "$story_id")
      if [ "$topics_csv" = "__NONE__" ]; then
        echo "  ❌ Story $story_id mencionada pero no existe archivo en $STORIES_DIR"
        errors=$((errors + 1)); continue
      fi
      case ",$topics_csv," in
        *",$topic_slug,"*) : ;;
        *) base=$(story_base "$story_id")
           echo "  ❌ Story $story_id ($base) — falta 'topics: [$topic_slug]' en frontmatter"
           errors=$((errors + 1)) ;;
      esac
    done
    IFS=$OLDIFS
  fi

  # Pending decisions con flag blocking (per-topic awk; ~8 topics)
  while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    echo "  🟡 pending decision: $pid (blocks sprint planning)"
    warnings=$((warnings + 1))
  done < <(awk '/^pending_decisions:/{f=1;next} f&&/^[a-zA-Z_]+:/{f=0} f&&/^[[:space:]]*-[[:space:]]*id:/{s=$0;sub(/.*id:[[:space:]]*/,"",s);print s}' "$WIKI_DIR/$topic_slug.md")
done < "$TOPIC_IDX"

# ====== Pasada 2: stories → topics (búsqueda inversa) ======
echo ""
echo "🔄 Búsqueda inversa (stories → topics)"
while IFS=$'\t' read -r story_id base topics_csv; do
  [ -z "$topics_csv" ] && continue
  OLDIFS=$IFS; IFS=','
  for t in $topics_csv; do
    [ -z "$t" ] && continue
    if [ ! -f "$WIKI_DIR/$t.md" ]; then
      echo "  ❌ Story $story_id declara topic [$t] — no existe $WIKI_DIR/$t.md"
      errors=$((errors + 1)); continue
    fi
    rel=$(topic_related "$t")
    case ",$rel," in
      *",$story_id,"*) : ;;
      *) echo "  ❌ Story $story_id declara topic [$t] — $t.md no la lista en related_stories"
         errors=$((errors + 1)) ;;
    esac
  done
  IFS=$OLDIFS
done < "$STORY_IDX"

# ====== Resumen ======
echo ""
echo "─────────────────────────────"
if [ "$errors" -eq 0 ] && [ "$warnings" -eq 0 ]; then
  echo "✅ OK — sin errors, sin warnings"
elif [ "$errors" -eq 0 ]; then
  echo "✅ Backlinks OK — $warnings warning(s) (pending decisions)"
else
  echo "❌ $errors error(s), $warnings warning(s)"
fi

exit $((errors > 0 ? 1 : 0))
