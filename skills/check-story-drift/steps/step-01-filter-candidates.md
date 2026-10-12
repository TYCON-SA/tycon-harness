# Step 1 — Filtrar candidatas

## Objetivo

Identificar las stories cuyo `status:` matchea el filtro (default `ready-for-dev*`) y son candidatas a drift.

## Acciones

1. **Listar todas las stories**:
   ```bash
   cd <specs_dir>
   for f in *.md; do
     status=$(grep -m1 '^status:' "$f" | sed 's/status: //')
     story_id=$(grep -m1 '^story:' "$f" | sed 's/story: //;s/[",]//g')
     sprint=$(grep -m1 '^sprint:' "$f" | sed 's/sprint: //')
     echo "$story_id|$status|$sprint|$f"
   done
   ```

2. **Filtrar por status**:
   - Default: `status:` matchea `^ready-for-dev` (cubre `ready-for-dev` y `ready-for-dev-FINAL`).
   - Si el user pasó `filter=in-progress` o similar, aplicar ese regex.

3. **Intersectar con `target_stories` si vino**:
   - Si el user pasó `target_stories=2.4,6.1,9.1`, filtrar solo esas IDs.
   - Si no, todas las candidatas.

4. **Output al user** (preview antes de delegar):
   ```
   Detected N candidates for drift sweep:
   - 1.10 (1-10-validacion-por-sucursal.md)
   - 2.4 (2-4-folios-de-envio.md)
   - 6.1 (6-1-listado-de-rutas-en-tiempo-real.md)
   - ...
   ```

5. **Si > 20 candidates**, advertir: "El sweep va a delegar 2 agents por candidate → ~N agents en total. Esto puede tomar varios minutos. ¿Continuar o filtrar más?"

## Decisión de scope

Si el user no acota, el skill scanea TODAS las candidates. Para sprints concretos:

```bash
# Si el user dice "solo Sprint 2"
candidates=$(grep -l "^sprint: 2$" *.md | xargs -I{} grep -l "^status: ready-for-dev" {})
```

## Output

```yaml
candidates:
  - story_id: "1.10"
    file: "1-10-validacion-por-sucursal.md"
    sprint: 8
    status: "ready-for-dev-FINAL"
  - story_id: "2.4"
    file: "2-4-folios-de-envio.md"
    sprint: 2
    status: "ready-for-dev-FINAL"
  # ...
total_candidates: 13
estimated_agents: 26  # 2 passes × candidates
```

## Anti-patterns

- ❌ NO incluir stories `done`, `review`, `eliminated` por error.
- ❌ NO mezclar candidates con stories `in-progress` salvo pedido explícito.
- ❌ NO continuar al Step 2 sin que el user confirme el alcance si > 20 candidates.
