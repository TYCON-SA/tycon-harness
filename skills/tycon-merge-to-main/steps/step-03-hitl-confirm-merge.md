# Step 3 — HITL #1: confirmar merge + revisar mensaje

**Objetivo**: pausa obligatoria. Mostrar al usuario lo que se va a mergear + el mensaje generado, permitir editar el mensaje, confirmar antes de tocar el repo.

## Acciones

### 3.1 — Presentar el preview

Output al usuario:

**Antes del preview**: si el Step 0.6 dejó `unpushed_findings` no vacío, abrir con la tabla 🔴
(repo · rama · commits solo locales · wip?) + los repos "⚠ no escaneado" si los hubo. Es
información para la decisión del dev, no un abort — pero la pregunta de abajo se hace CON esto
a la vista: sin esto se aprueba promover el front sin saber que el backend está solo en la máquina.

```
🔍 Preview del merge: <source> → <target>

⚠️ Trabajo sin subir en el grupo (si aplica):
  🔴 <repo> → <rama>: <N> commit(s) solo locales
  ⚠ <repo>: no escaneado (<motivo>)

Commits a mergear (<N>):
  <hash> <subject>
  <hash> <subject>
  ...

Archivos cambiados: <N>
Top dirs: <list>

📝 Mensaje de merge generado:

────────────────────────────────────────
<full_message del Step 2>
────────────────────────────────────────

Opciones:
(a) Continuar con este mensaje (recomendado)
(b) Editar mensaje (te paso el mensaje, lo editás, me lo devolvés)
(c) Ver diff completo de los commits antes de decidir
(d) Cancelar el merge
```

### 3.2 — Manejar respuesta

**Si elige (a)**: pasar al Step 4 con el mensaje sin cambios.

**Si elige (b) — editar mensaje**:
1. Mostrar el mensaje completo en un bloque copiable
2. Pedir al usuario que pegue la versión editada
3. Validar que tenga al menos:
   - Primera línea con formato `merge: ... -> ... — ...`
   - Trailer `Co-Authored-By:`
4. Si validación falla → mostrar qué falta y pedir de nuevo
5. Reemplazar `full_message` y volver a 3.1 (mostrar preview con el nuevo mensaje, opción de seguir editando)

**Si elige (c) — ver diff completo**:
1. Ejecutar `git log -p origin/<target>..origin/<source>` (pipear a `head -500` para no saturar) — **siempre `origin/<target>`, no `<target>` local, para evitar comparación stale**
2. Mostrar el output al usuario
3. Volver a 3.1 (re-mostrar el menú de opciones)

**Si elige (d) — cancelar**:
- Si Step 0 hizo `git stash push` → ofrecer `git stash pop` para restaurar
- Terminar el skill con mensaje:
  ```
  ❌ Merge cancelado por el usuario. Repo en estado original (rama `<current_branch_at_start>`, sin cambios).
  ```

## Edge cases

- **Mensaje editado con conflict markers o caracteres raros**: rechazar y pedir de nuevo.
- **Usuario edita y borra la sección "Commits incluidos"**: aceptar — es decisión del usuario, no es campo obligatorio (solo subject + trailer son obligatorios).
- **Usuario edita y pone un mensaje genérico tipo "merge dev to main"**: avisar una vez ("⚠️ El mensaje quedó genérico, va a perder valor en `git log`. ¿Seguir igual?") pero no forzar — su llamada.

## Output del step

```json
{
  "approved_message": "<full message final, posiblemente editado>",
  "user_edited": true|false,
  "should_continue": true
}
```

Pasar al Step 4 solo si `should_continue: true`.
