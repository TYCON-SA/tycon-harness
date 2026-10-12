# Step 0 — Preflight

## Objetivo

Confirmar que el entorno tiene lo necesario para el sweep ANTES de empezar a delegar trabajo a sub-agents.

## Acciones

1. **Verificar `specs_dir`**:
   - Default: `specs/stories/` relativo al cwd.
   - Si no existe → ABORT con mensaje: "specs_dir `<path>` no existe. Pasá `specs_dir=<ruta>` explícito o ejecutá desde el repo de specs."
   - Si existe pero está vacío de `.md` → ABORT con: "specs_dir no contiene stories `.md`."

2. **Verificar formato Mary+GOLD**:
   - Tomar el primer `.md` y confirmar que tiene frontmatter con `^status:`, `^story:`, `^title:`, `^epic:`.
   - Si no matchea → WARN al user: "Los archivos no parecen Mary+GOLD. ¿Continuar? Algunas reglas pueden no aplicar."

3. **Detectar code repos**:
   - Estrategia: hermanos del cwd con `.git/` adentro (Mac/Linux/Windows).
   - Comando: `find "$(dirname "$(pwd)")" -maxdepth 2 -name .git -type d 2>/dev/null | head -10`
   - Filtrar el cwd actual (ya es repo de specs).
   - Si 0 repos detectados → preguntar al user qué repos contienen el código.
   - Si 1-5 repos → usarlos. Si > 5 → preguntar.

4. **Confirmar lista con el user**:
   - Mostrar: "Specs dir: X. Code repos detectados: Y, Z. ¿Continuar?"
   - Si el user dice "no" o "cambiar" → preguntar overrides.

## Output

```yaml
preflight:
  specs_dir: /Users/<dev>/Proyectos/Ceibo/CeiboProject/specs/stories
  code_repos:
    - /Users/<dev>/Proyectos/Ceibo/CeiboBackend
    - /Users/<dev>/Proyectos/Ceibo/CeiboFrontEnd
  format_detected: mary-gold
  story_count: 67
```

## Anti-patterns

- ❌ NO asumir paths sin chequear que existan.
- ❌ NO empezar el sweep si el usuario no confirma la lista de repos.
- ❌ NO continuar si el formato no es Mary+GOLD (las reglas asumen ese formato).
