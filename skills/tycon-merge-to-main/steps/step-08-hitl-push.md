# Step 8 — HITL #2: confirmar push

**Objetivo**: pausa antes del `git push`. Mostrar resumen final, dar última oportunidad de cancelar.

## Acciones

### 8.1 — Presentar resumen

```
✅ Merge listo para pushear

Hash: <merge_commit_hash>
Target: <target>
Source: <source>

Build: ✅ OK
Tests: ✅ <N>/<N> PASS, 0 regresiones

Archivos cambiados: <N>
Commits incluidos en el merge: <N>

Mensaje del merge commit (primera línea):
<subject_line>

Opciones:
(a) Pushear a origin/<target> (recomendado)
(b) Cancelar el push — deja el merge commit local, vos pusheás cuando quieras
(c) Ver el mensaje completo del merge commit antes de decidir
```

### 8.1b — Modo `pr` con el repo en GitHub: decir qué versión sube

En modo `pr` no hay merge local, así que el resumen de arriba habla de la rama y del pedido que se va a crear. Si el
remoto es de GitHub, además se muestra **el número de versión que el pedido va a llevar**, antes de pedir el sí:

```bash
node "${TYCON_GUIDES_DIR:-$HOME/.claude/tycon-harness}/scripts/tools/merge-pr.js" plan --repo <repo> --source <source> --target <target> --keep-mode <mode del Step 0.7>
```

🔴 **Siempre con `--keep-mode`**: el modo y el paso quedaron fijos en el Step 0.7 y este
plan no los cambia; sólo recalcula `suites`, que puede bajar de `server` a `machine` (por ejemplo,
la política de la rama se apagó, o `az` dejó de contestar). Si bajó: **volver al 7.2** y correr las
suites completas en esta máquina (en modo `pr`, sobre el merge de prueba del 7.0) antes de pedir el
sí; la línea `Tests:` lleva el `suitesReason` nuevo. El resumen de 8.1 repite `suitesReason`.

Del JSON: con `step: "9c"` y `version.action: "bump"`, agregar al resumen una línea «la versión sube de
`<version.from>` a `<version.to>`» y decir que el paso siguiente deja ese cambio en un commit de la rama (sólo
`version.json`). Es el plan: el número final se calcula al empujar, con la rama ya al día, y puede ser mayor si entró
otro pedido en el medio. Con `version.action: "none"`, o con `version` en `null`, no hay nada que mostrar. Si el plan
trae `notes` (por ejemplo, falta declarar `merge.check`), van en el resumen: el dev tiene que saber, antes de aprobar,
que el pedido no se va a abrir. El plan dice también de dónde leyó el modo y el control
(`configFrom`): del repo o, en un clon del repo público del arnés, del clon de mantenimiento que declara la máquina. Si
el plan sale 2 no hay modo que suponer: mostrar su motivo y parar.

### 8.2 — Manejar respuesta

**Si elige (a)**: pasar al Step 9 (en modo `pr`: al 9b, con un remoto de Azure DevOps o de GitHub).

**Si elige (b) — cancelar push**:
- Output al usuario:
  ```
  ⚠️ Push cancelado. El merge commit `<merge_commit_hash>` quedó LOCAL en `<target>`.
  
  Para pushear después: `git push origin <target>`
  Para abortar: `git reset --hard HEAD~1` + `git push origin <target> --force-with-lease` (si ya estaba pusheado el reset).
  
  Volviendo a `<source>`...
  ```
- Hacer Step 10 parcial (checkout source) y terminar.

**Si elige (c) — ver mensaje completo**:
- Mostrar `git log -1 --format=%B HEAD` (merge commit body)
- Volver a 8.1 (re-mostrar opciones)

## Edge cases

- **Si Step 7 amendó el merge commit**: el hash cambió. Asegurarse de mostrar el `merge_commit_hash_post_amend`, no el original.

## Output del step

```json
{
  "user_approved_push": true|false
}
```

Pasar al Step 9 solo si `user_approved_push: true`.
