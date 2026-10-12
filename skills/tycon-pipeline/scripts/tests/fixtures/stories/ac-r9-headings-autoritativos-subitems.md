<!-- FIXTURE inventado de cero y escrito a mano: una story de EJEMPLO sobre cupones de descuento en
     el carrito de una tienda genérica. No copia ni adapta la story de ningún producto, y
     tests/fixtures/regen.js NO lo regenera. Reemplaza al dato que hubo antes con este mismo nombre
     de archivo, que sí venía de una story real: de aquél quedó sólo la FORMA que la prueba mide, y
     es lo que hay que cuidar al editarlo — 8 títulos `AC-N`, listas numeradas que REINICIAN en 1
     bajo cada título (sub-criterios, no criterios), sub-ítems que arrancan en negrita, y una tabla
     de Tests cuya columna AC mezcla número pelado y lista (`2, 6`), con una fila que cita un
     sub-criterio (`AC-2.6`) en el escenario. -->

---
epic: 'cart-coupons'
story: 'R-9'
status: review
---

## Acceptance Criteria

### AC-1 — Alta de un cupón desde el panel de la tienda

**Given** un usuario con permiso para editar el catálogo,
**When** guarda un cupón nuevo,
**Then**:
1. El cupón queda con código, porcentaje, fecha de vencimiento y tope de usos; el código se guarda en mayúsculas.
2. Un código repetido se rechaza con un mensaje que lo nombra, sin crear un segundo cupón.
3. El porcentaje acepta de 1 a 90; fuera de ese rango el formulario no deja guardar.
4. La lista de cupones muestra el nuevo sin recargar la página.

### AC-2 — Validación del código al aplicarlo en el carrito

**Given** un carrito con artículos,
**When** el comprador escribe un código y toca «Aplicar»,
**Then**:
1. `CouponCode.Normalize(string? raw)` quita los espacios y pasa a mayúsculas antes de buscar.
2. Un código que no existe devuelve `COUPON_NOT_FOUND` y el carrito queda como estaba.
3. Un cupón vencido devuelve `COUPON_EXPIRED`, con la fecha en el mensaje.
4. Un cupón sin usos disponibles devuelve `COUPON_EXHAUSTED`.
5. `null` o sólo espacios: no se consulta nada y el campo marca «escribí un código».
6. Un código con caracteres fuera de `^[A-Z0-9-]{4,16}$` se rechaza por formato **sin** consultar la base.

### AC-3 — Cálculo del descuento sobre el subtotal

**Given** un cupón válido aplicado,
**When** se recalcula el carrito,
**Then**:
1. El descuento se calcula sobre el subtotal de los artículos, sin contar el envío.
2. El importe se redondea a dos decimales, siempre hacia abajo.
3. Un carrito vacío da descuento 0, sin error.

### AC-4 — Un solo cupón por pedido

**Given** un carrito que ya tiene un cupón,
**When** el comprador aplica otro,
**Then**:
1. El segundo reemplaza al primero, y el resumen avisa cuál quedó.
2. El reemplazo queda anotado en la bitácora del pedido, con los dos códigos.
3. Si el segundo no es válido, el primero sigue aplicado.

### AC-5 — El resumen del pedido muestra el descuento

**Given** un pedido con cupón,
**When** se abre el resumen,
**Then**:
1. Aparece la línea «Descuento (CÓDIGO)» con el importe en negativo, entre el subtotal y el envío.
2. El total es subtotal menos descuento más envío.
3. Sin cupón, la línea no aparece (ni en cero).
4. **Mantiene sin cambios** el formato de moneda y el orden de las demás líneas del resumen.
5. El remito y la factura llevan la misma línea, con el mismo importe.
6. **Actualizar el texto de ayuda** del campo de cupón: hoy dice que se pueden combinar dos.

### AC-6 — Vencimiento y tope de usos

**Given** un cupón con tope de usos,
**When** un pedido que lo usa cambia de estado,
**Then**:
1. Confirmar el pedido descuenta un uso; anularlo lo devuelve.
2. El uso se descuenta al confirmar, no al aplicar el código en el carrito.
3. Dos pedidos que compiten por el último uso: sólo uno se confirma con descuento.
4. El cupón vence al terminar el día indicado, en la hora de la tienda.

### AC-7 — Quitar el cupón

**Given** un carrito con cupón,
**When** el comprador toca «Quitar»,
**Then**:
1. El total vuelve al importe sin descuento y el campo queda vacío.
2. Quitarlo no consume ni devuelve usos.

### AC-8 — No regresión

**Given** la implementación completa,
**When** corre el pipeline,
**Then**:
1. La compilación termina sin errores ni avisos nuevos.
2. La suite completa pasa: las pruebas de antes más las nuevas.
3. Un pedido sin cupón se calcula y se confirma igual que antes.
4. Las pantallas de catálogo y de envíos no cambian.
5. Los revisores del pipeline cierran sin hallazgos críticos.

### Tests (resumen tabla)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `ApplyCoupon_ValidCode_DiscountsAndCountsUse` | 2, 6 | unit | código vigente, pedido confirmado | descuento aplicado y un uso menos |
| T2 | `Normalize_NullOrBlank_SkipsLookup` | 2 | unit | `null` / `"  "` | no consulta; pide un código |
| T3 | `Apply_UnknownCode_ReturnsNotFound` | 2 | unit | `'NOEXISTE'` | `COUPON_NOT_FOUND`, carrito igual |
| T4 | `Apply_BadFormat_RejectsWithoutLookup` | 2 | unit | `'ab!'` (sub-criterio AC-2.6) | rechazo por formato, sin consulta |
| T5 | `Apply_ExpiredCode_ReturnsExpired` | 2 | unit | cupón de ayer | `COUPON_EXPIRED` con la fecha |
| T6 | `Discount_ExcludesShipping` | 3 | unit | subtotal 100, envío 20, cupón 10% | descuento 10 |
| T7 | `Discount_RoundsDown` | 3 | unit | subtotal 33,33, cupón 15% | 4,99 |
| T8 | `SecondCoupon_ReplacesFirst` | 4 | unit | dos códigos válidos seguidos | queda el segundo y hay nota en la bitácora |
| T9 | `SecondCoupon_Invalid_KeepsFirst` | 4 | unit | válido y después uno vencido | sigue el primero |
| T10 | `Summary_ShowsDiscountLine` | 5 | unit | pedido con cupón | línea en negativo entre subtotal y envío |
| T11 | `Summary_NoCoupon_HidesLine` | 5 | unit | pedido sin cupón | la línea no está |
| T12 | `CreateCoupon_DuplicateCode_Rejected` | 1 | integration | alta con un código ya usado | rechazo, un solo cupón en la base |
| T13 | `RemoveCoupon_RestoresTotal` | 7 | unit | quitar el cupón | total sin descuento, usos intactos |
| T14 | `Apply_ExhaustedCode_ReturnsExhausted` | 2 | integration | cupón con tope 1 ya usado | `COUPON_EXHAUSTED` |

> **AC-8** (no regresión) no tiene fila propia a propósito: lo cubren los controles del pipeline.

### Fuera de alcance

- Cupones por artículo o por categoría.
- Combinar un cupón con otra promoción.
- Envío gratis por cupón.
