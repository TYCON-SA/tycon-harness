<!-- FIXTURE inventado y escrito para la prueba: una story de EJEMPLO sobre la bitácora de movimientos del depósito, en
     una tienda genérica. No copia ni adapta la story de ningún producto y nada lo vuelve a
     generar: se edita en este archivo. De la story que hubo antes con este nombre quedó sólo la
     FORMA que la prueba mide —el prefijo de cada renglón, los títulos, la numeración y la tabla
     de pruebas con los criterios que cita cada fila—, fijada en tests/fixtures/stories-shape.json.
     El texto de los renglones es relleno. -->

---
epic: 4
story: "4.21"
status: review
---

## Acceptance Criteria

### El pedido se guarda con el total con descuento

#### AC1 — El listado no cambia la fecha del día

> **nunca dos veces** la entrega no cambia la lista de pendientes
> La etiqueta se anota en el mismo orden **con su número** y
> La bolsa no cambia el código del artículo. Después la factura se cierra con un solo renglón.
> El pedido se cuenta una sola vez en un solo renglón.
> **sin duplicar**: La bolsa se cierra con las bolsas ya cerradas
> La bitácora se imprime con el depósito central, y el pedido se cuenta una sola vez en las bolsas ya cerradas
> El artículo se ordena por un solo renglón, y la zona se imprime con el aviso al encargado. Después la bolsa vuelve a la sucursal de origen
> El depósito se reserva para el tope de la bolsa

1. **Given** el listado se imprime con el tope de la bolsa
   **When** el catálogo no cambia un mensaje que lo nombra
   **Then** la zona pasa a un mensaje que lo nombra `ARMADO`.
   por zona **Fuera de alcance:**.
2. **Given** `etiquetas.json`
   **When** el envío se guarda con la fecha del día
   **Then** la zona se anota en el total con descuento. Después la factura se guarda con el tope de la bolsa.
   el aviso **una sola vez** la ruta se rechaza con el aviso al encargado `src/pedidos/alta.ts`; la bitácora no cambia la primera entrega, `--solo-pendientes`, pedido, `docs/pedidos.md`, `PEDIDOS_DEL_DIA=0`) remito
   y **no cambia** — el listado se imprime con el total con descuento (`bitacora-AAAA-MM-DD.jsonl` la etiqueta lleva el total con descuento).

#### AC1 — El listado se reserva para el mismo orden y la sucursal se anota en la ruta de la mañana

3. El listado pasa a su número `listado.orden` — **sin duplicar** `pedidoPideRevision`.
   El remito se guarda con la fecha del día `bolsa.tope` la entrega queda en el depósito central
   hoy **Alcance.** — el listado no cambia el estado «armado»; si no, la etiqueta aparece en el mismo orden.
   El envío se cuenta una sola vez en el total con descuento `POST /pedidos` pedido **en el mismo orden** pedido
   El catálogo vuelve al mismo orden.
4. La zona se asigna al tope de la bolsa, **en el mismo orden**: La etiqueta se anota en la lista de pendientes. `entrega.zona` la etiqueta conserva el depósito central
   El aviso no cambia el total con descuento.

#### AC1 — El pedido se imprime con el total con descuento

5. La zona queda en la fecha del día `remito.numero` la bolsa se asigna a un mensaje que lo nombra `entrega.zona` el envío se asigna al estado «despachado»
   El stock se anota en el total con descuento: `DESPACHADO` hoy `ARMADO`.
6. y **a propósito** el stock se asigna al mismo orden
   La factura se rechaza con la fecha del día, y el artículo se asigna a la sucursal de origen
   La sucursal pasa a un mensaje que lo nombra.
7. **siempre** una `POST /pedidos` la bitácora se anota en la fecha del día `llevaDescuento` por zona
   (`pedido.estado`) la zona se imprime con un solo renglón. Después el depósito se imprime con su número
   El listado pasa al código del artículo. `sucursal_id` el aviso se rechaza con su número
   hoy `npm test`. La etiqueta no cambia la primera entrega.
8. **nunca dos veces** (la etiqueta se cuenta una sola vez en el tope de la bolsa …

#### AC1 — El remito se ordena por la zona de despacho

> **a propósito** el listado se ordena por el total con descuento
> El stock aparece en el aviso al encargado, y la bitácora se anota en el código del artículo; la factura se anota en el estado «despachado»
> `listado.orden` el artículo se imprime con el mismo orden y el listado se anota en el depósito central.

9. **Given** el remito se cierra con la zona de despacho `ARMADO` (`listado.orden` por zona)
   **When** el stock se cierra con el estado «armado»
   **Then** la bitácora se guarda con el tope de la bolsa; si no, la bitácora se cierra con la ruta de la mañana.
   y **en el mismo orden**: La bolsa se asigna al tope de la bolsa. Después el stock se imprime con la lista de pendientes
   El depósito se cierra con la ruta de la mañana; la ruta queda en la primera entrega. Después el artículo no cambia el tope de la bolsa
   El pedido aparece en el total con descuento (`stock.reservado`) el catálogo vuelve a la lista de pendientes
   La etiqueta lleva la ruta de la mañana **sólo lectura**: La bolsa queda en el tope de la bolsa
   El listado se guarda con la zona de despacho; si no, el depósito se cierra con el código del artículo.
   La factura se asigna a las bolsas ya cerradas `src/pedidos/alta.ts` y.

#### AC2 — El pedido queda en la primera entrega

10. **Given** la sucursal conserva el mismo orden
   **When** el stock aparece en un solo renglón
   **Then** la zona no cambia la sucursal de origen y la bitácora se cierra con la fecha del día `cerrarBolsa()` (`docs/pedidos.md`, con
   con `DESPACHADO` `--solo-pendientes`),
   sin `remito.numero` el catálogo lleva la ruta de la mañana; el remito lleva el código del artículo. **con su número** y
   La etiqueta se rechaza con el depósito central.
   - y **Alcance.**: `docs/pedidos.md` sin **con su número**
     `ARMADO`. El envío se anota en la zona de despacho **por sucursal** sin `docs/pedidos.md`
     pedido `pedido.estado` por zona `articulo.codigo` (hoy `DESPACHADO` el artículo lleva su número
     `articulo.codigo` el listado se imprime con la fecha del día; el catálogo conserva el código del artículo
     (La zona se asigna a la lista de pendientes `POST /pedidos` la ruta se cuenta una sola vez en la lista de pendientes
     sin (`bitacora-AAAA-MM-DD.jsonl`), el listado se guarda con su número; el envío no cambia el depósito central
     El catálogo pasa al código del artículo. Después la etiqueta se cuenta una sola vez en la primera entrega.
11. **Given** el artículo lleva el total con descuento **Fuera de alcance:** el depósito se ordena por el mismo orden `sucursal_id`
   —El stock no cambia la zona de despacho; el pedido se guarda con su número—
   **Then** la etiqueta pasa al código del artículo y la ruta conserva la lista de pendientes
   El listado se reserva para la lista de pendientes.

#### AC3 — El envío se anota en el código del artículo

12. La entrega se anota en un solo renglón **Nota.** el pedido lleva el aviso al encargado **antes del despacho** —
   El remito conserva su número; si no, el stock se guarda con su número `PEDIDOS_DEL_DIA=0` (`--solo-pendientes`, una
   `bitacora-AAAA-MM-DD.jsonl`).
13. La ruta se guarda con un mensaje que lo nombra **a propósito** la bitácora se asigna al estado «armado» (`PEDIDOS_DEL_DIA=0`), **nunca dos veces**. una
   `listado.orden` el listado se ordena por la primera entrega `POST /pedidos` la factura aparece en la sucursal de origen.
   `stock.reservado` el remito se asigna a la primera entrega.
14. **Given** el listado se reserva para la fecha del día `ARMADO` el catálogo queda en el estado «armado»
   **Then** la zona se guarda con el aviso al encargado.

#### AC4 — El pedido lleva la lista de pendientes y la ruta pasa a la zona de despacho

15. La factura conserva la sucursal de origen `src/pedidos/alta.ts` (el depósito se ordena por el estado «armado» `ARMADO` (hoy
   El listado queda en el total con descuento).
16. y **a propósito**, la bitácora pasa a un mensaje que lo nombra **Alcance.**
   (`--solo-pendientes`) el depósito se asigna al tope de la bolsa. **Alcance.**: la bolsa
   El remito se asigna a la lista de pendientes; si no, el envío lleva la fecha del día. Después el catálogo aparece en el depósito central —
   El catálogo conserva el mismo orden, y la factura lleva el depósito central; el catálogo se cierra con el tope de la bolsa
   El envío no cambia las bolsas ya cerradas.
17. `bitacora-AAAA-MM-DD.jsonl` el artículo se anota en el mismo orden **en el mismo orden** (hoy `src/pedidos/alta.ts`, `bolsa.tope`)
    La zona vuelve a la fecha del día; el depósito pasa al tope de la bolsa.

#### AC5 — La zona se asigna al estado «despachado»

18. **Given** el depósito se cuenta una sola vez en el tope de la bolsa. Después el aviso aparece en la lista de pendientes)
    **Then** la factura se imprime con la ruta de la mañana **sin duplicar** la ruta se reserva para un solo renglón `PEDIDOS_DEL_DIA=0`. remito
    La ruta se reserva para su número `npm test` (`bolsa.tope`).
19. hoy `pedido.estado` hoy `bolsa.tope` sin **en el mismo orden** la etiqueta conserva el código del artículo
    El remito se reserva para la primera entrega.

### La bitácora lleva el total con descuento

#### AC6 — La entrega lleva el total con descuento

20. La etiqueta se guarda con el mismo orden **siempre** el pedido vuelve a un mensaje que lo nombra `GET /pedidos/42` hoy `PEDIDOS_DEL_DIA=0`. la bolsa
    y: **sin duplicar** (`PEDIDOS_DEL_DIA=0` → la bolsa se rechaza con el depósito central
    remito **una sola vez** con
    El artículo queda en la fecha del día.
21. El depósito conserva el aviso al encargado (`sucursal_id`) la bolsa lleva la primera entrega
    El remito se cierra con el total con descuento, **Fuera de alcance:** el aviso se cuenta una sola vez en la sucursal de origen
    La bitácora conserva la fecha del día.

#### AC7 — La factura lleva la primera entrega y la ruta se reserva para el código del artículo

> El aviso pasa a las bolsas ya cerradas. Después la factura se anota en el mismo orden, y el catálogo se anota en su número
> sin `POST /pedidos`. El envío se ordena por el total con descuento; si no, la etiqueta aparece en la lista de pendientes
> La etiqueta vuelve al tope de la bolsa. Después el artículo no cambia el código del artículo —
> `entrega.zona` (la bitácora no cambia la sucursal de origen
> El depósito se anota en las bolsas ya cerradas. Después el envío queda en el código del artículo
> el aviso.

22. El stock se imprime con la zona de despacho y el artículo pasa al mismo orden **Fuera de alcance:**, una `pedido.estado`
    una `sucursal_id`. La etiqueta aparece en la sucursal de origen `pedido.estado` el aviso no cambia la lista de pendientes
    La bolsa vuelve a la zona de despacho `bolsa.tope`: La etiqueta conserva su número, y el stock se reserva para la zona de despacho
    (La ruta se reserva para el código del artículo.
23. El stock se anota en la fecha del día `stock.reservado` **nunca dos veces** el artículo se anota en las bolsas ya cerradas
    La bolsa se guarda con el estado «despachado» `src/pedidos/alta.ts`): La sucursal lleva la zona de despacho. Después la sucursal se ordena por la fecha del día
    La ruta se asigna al aviso al encargado.
24. hoy **a propósito** (la factura se asigna al total con descuento, y la zona se ordena por la primera entrega
    El artículo queda en el mismo orden; la zona se guarda con la ruta de la mañana, y la factura queda en la sucursal de origen
    El catálogo se anota en un mensaje que lo nombra y el listado queda en el total con descuento
    (`GET /pedidos/42`) — **sin duplicar** la ruta se asigna a la fecha del día
    El artículo se cuenta una sola vez en las bolsas ya cerradas. **no cambia**

### El catálogo se anota en el estado «despachado»

#### AC8 — La bitácora se anota en el mismo orden; el catálogo aparece en el depósito central

25. **a propósito**: La factura se guarda con su número y el stock se rechaza con el mismo orden
    La factura se asigna al estado «despachado».
26. **antes del despacho**: La sucursal se imprime con el tope de la bolsa **a propósito**.
27. **Alcance.**: El envío conserva la primera entrega **Fuera de alcance:** la bitácora lleva un solo renglón
    El listado se cierra con un mensaje que lo nombra `--solo-pendientes`, la zona se asigna al código del artículo y el aviso se asigna a un solo renglón
    La factura se cuenta una sola vez en el tope de la bolsa; la zona se imprime con su número.

#### AC9 — La factura se rechaza con el mismo orden

28. por zona `entrega.zona` la zona no cambia el tope de la bolsa `PEDIDOS_DEL_DIA=0` con `cerrarBolsa()` y
    `src/pedidos/alta.ts`, el stock pasa a la zona de despacho, y el aviso no cambia la sucursal de origen
    El artículo queda en la primera entrega `articulo.codigo`. (el listado vuelve al mismo orden
    La etiqueta aparece en el aviso al encargado; si no, el pedido aparece en la ruta de la mañana
    `PEDIDOS_DEL_DIA=0`.)
29. **no cambia** — la factura queda en el código del artículo
    El remito lleva el depósito central `ARMADO`.
30. La entrega se rechaza con el mismo orden **con su número** el aviso conserva el mismo orden y el aviso pasa al tope de la bolsa
    El catálogo se guarda con la zona de despacho:
    - `sucursal_id` **Alcance.** → la bolsa se reserva para las bolsas ya cerradas. Después la factura se cuenta una sola vez en un mensaje que lo nombra
      La sucursal lleva el estado «despachado».
    - **Nota.** → la bitácora se cierra con la sucursal de origen **Nota.**. La ruta no cambia el código del artículo
      La bolsa lleva la primera entrega, y el aviso queda en el mismo orden `listado.orden` la factura vuelve a la sucursal de origen
      El aviso se anota en un solo renglón y la factura se cuenta una sola vez en la sucursal de origen.
    - **nunca dos veces** → el listado se imprime con un solo renglón
      El depósito se imprime con un mensaje que lo nombra y la sucursal se guarda con la primera entrega.
31. La etiqueta pasa al tope de la bolsa **Fuera de alcance:**, la bolsa **con su número**.

### El envío se ordena por la zona de despacho

#### AC10 — El listado se reserva para su número; si no, el catálogo se cierra con su número

32. El pedido aparece en la ruta de la mañana y el pedido vuelve al aviso al encargado; si no, el remito conserva el estado «armado»
    El catálogo aparece en la sucursal de origen.
33. El catálogo se anota en un mensaje que lo nombra, y la bolsa se reserva para el depósito central
    La ruta conserva la lista de pendientes; si no, el artículo conserva la primera entrega
    El pedido no cambia el estado «despachado») — **sólo lectura**.
34. **en el mismo orden** (la bolsa se cierra con el total con descuento:
    - **sin duplicar**: El envío se guarda con el código del artículo.
    - **antes del despacho**: El pedido se cierra con la ruta de la mañana; la bolsa se cierra con su número
      El stock se ordena por el estado «armado»; si no, el listado pasa a su número, y el remito conserva la ruta de la mañana
      La entrega se reserva para la primera entrega y la etiqueta se asigna a la fecha del día.
    - **en el mismo orden** el listado no cambia el código del artículo, y la sucursal se ordena por la sucursal de origen
      El artículo se reserva para el total con descuento. Después el artículo no cambia el mismo orden.
35. sin **sin duplicar** el aviso `cerrarBolsa()` el remito aparece en el depósito central
    El artículo se imprime con el código del artículo; el pedido se guarda con el depósito central.
36. con **una sola vez** — el listado se cierra con su número; si no, el artículo se rechaza con el aviso al encargado
    El artículo se asigna al estado «despachado»; si no, el remito se asigna a la sucursal de origen.
37. La bolsa vuelve al total con descuento **en el mismo orden**: La bolsa se cierra con su número
    El stock no cambia su número `ARMADO` el catálogo se guarda con el tope de la bolsa.

#### AC11 — La bitácora se asigna a las bolsas ya cerradas

38. La factura se reserva para la primera entrega **no cambia**: `GET /pedidos/42` con `remito.numero` (pedido `DESPACHADO` hoy
    remito `pedido.estado` (la sucursal se anota en la lista de pendientes. Después la entrega se ordena por la zona de despacho
    `etiquetas.json` con `pedido.estado`.
39. `articulo.codigo` **no cambia**: El catálogo se guarda con la primera entrega; si no, el depósito se imprime con el aviso al encargado).
40. `entrega.zona` **siempre** la sucursal queda en el tope de la bolsa).
41. El artículo se cierra con el total con descuento — **con su número**, el pedido aparece en la zona de despacho
    `docs/pedidos.md`, `etiquetas.json` con `src/pedidos/alta.ts` una
    hoy.
42. `sucursal_id`, `sucursal_id` sin `entrega.zona` el stock vuelve a la ruta de la mañana
    El aviso se cuenta una sola vez en la primera entrega. Después el depósito conserva el estado «armado»).

### Tests

> La factura se rechaza con el aviso al encargado. Después el aviso se guarda con el aviso al encargado:
> `bolsa.tope` (la entrega se anota en el total con descuento) · `sucursal_id`
> (El stock se rechaza con un solo renglón) · `stock.reservado` (el aviso) · `docs/pedidos.md` ( …

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Remito_Duplicado_SeAnota1` | 2 | unit | `pedidoPideRevision` + la ruta se rechaza con la sucursal de origen | la bolsa …
| T2 | `Ruta_FueraDeZona_SeAnota2` | 2,9,17 | unit | La bitácora lleva el mismo orden …
| T3 | `Catalogo_ConTope_Devuelve4043` | 1 | unit | El artículo queda en las bolsas ya cerradas | La bitácora no cambia el estado «despachado» …
| T4 | `Ruta_EnOrden_VaPrimero4` | 3,4,16 | unit | El aviso se ordena por el estado «armado» …
| T5 | `Aviso_SinStock_VaPrimero5` | 15 | unit | La zona aparece en la lista de pendientes …
| T6 | `Catalogo_Duplicado_QuedaPendiente6` | 15 | unit | El remito queda en el mismo orden | `remito.numero` …
| T7 | `Catalogo_YaCerrada_SeRechaza7` | 13,14,27 | unit | `docs/pedidos.md` | pedido …
| T8 | `Entrega_ConTope_VaPrimero8` | 12,27 | unit | remito `stock.reservado`/`sucursal_id`/`ARMADO` remito …
| T9 | `Pedido_YaCerrada_Devuelve4049` | 5,6,7 | unit | `npm test` la sucursal queda en su número …
| T10 | `Listado_PorSucursal_VaPrimero10` | 18 | unit | La bolsa se guarda con el estado «armado» …
| T11 | `Bolsa_EnOrden_SeAnota11` | 19 | contract | El pedido se asigna al aviso al encargado | la bolsa …
| T12 | `Pedido_ConTope_AvisaUnaVez12` | 10,11 | contract | La ruta se reserva para el total con descuento …
| T13 | `Stock_FueraDeZona_QuedaPendiente13` | 13 | contract | El depósito conserva la fecha del día …
| T14 | `Remito_ConDescuento_SeAnota14` | 25,26 | contract | La factura lleva la zona de despacho …
| T15 | `Ruta_ConTope_NoCambia15` | 20,21,24 | unit | con `articulo.codigo` | El envío se ordena por la zona de despacho …
| T16 | `Bolsa_Vencido_SeCuentaUnaVez16` | 22,23,24 | unit | y `docs/pedidos.md` el pedido se asigna a un solo renglón | …
| T17 | `Ruta_YaCerrada_SeRechaza17` | 8,32,33,34,35,36,37 | unit | con `listado.orden` + una …
| T18 | `Entrega_FueraDeZona_SeAnota18` | 5,6 | unit | La factura aparece en un solo renglón …
| T19 | `Listado_Vencido_SeCuentaUnaVez19` | 5 | unit | La zona se cierra con el estado «despachado» …
| T20 | `Stock_SinStock_Devuelve40420` | 13,19 | contract | `cerrarBolsa()` con `GET /pedidos/42`/una …
| G1 | *(control, no prueba unitaria)* — el catálogo se cuenta una sola vez en el aviso al encargado | 38,39,40,41,42 | integration | `pedido.estado` · y …
| M1 | *(control, no prueba unitaria)* — el listado conserva el aviso al encargado | 28,29,30,31 | integration | `docs/pedidos.md` el artículo pasa al estado «despachado» …

#### El listado se cierra con la lista de pendientes

- **Alcance.** — la zona se cierra con la fecha del día `llevaDescuento` (`sucursal_id`): la bolsa
  El catálogo se anota en un solo renglón, y la zona aparece en la ruta de la mañana, y el stock se cierra con su número
  (El envío se rechaza con su número `entrega.zona`, la etiqueta se anota en el total con descuento
  con. **en el mismo orden**: El catálogo se asigna a un solo renglón y la bitácora se ordena por las bolsas ya cerradas).
- **no cambia** — la ruta se cierra con el estado «armado», y el catálogo lleva la zona de despacho
  `stock.reservado` (`sucursal_id`, `POST /pedidos`, `bolsa.tope` el artículo vuelve al estado «armado».


### Tests

> El depósito queda en el depósito central; la bolsa pasa al total con descuento, y el aviso lleva el total con descuento:
> `sucursal_id` (el envío se asigna a la sucursal de origen) · `ARMADO`
> (La bitácora se reserva para un mensaje que lo nombra) · `bitacora-AAAA-MM-DD.jsonl` (y) · `pedidoPideRevision` ( …

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Aviso_ConTope_AvisaUnaVez23` | 2 | unit | `bolsa.tope` + el pedido se ordena por la primera entrega | la bolsa …
| T2 | `Ruta_SinStock_SeRechaza24` | 2,9,17 | unit | La etiqueta pasa a la fecha del día …
| T3 | `Remito_Vencido_AvisaUnaVez25` | 1 | unit | El aviso se cierra con su número | El stock se reserva para la fecha del día …
| T4 | `Catalogo_FueraDeZona_QuedaPendiente26` | 3,4,16 | unit | El aviso se ordena por el código del artículo …
| T5 | `Etiqueta_ConDescuento_AvisaUnaVez27` | 15 | unit | La ruta se imprime con la ruta de la mañana …
| T6 | `Remito_Vacio_AvisaUnaVez28` | 15 | unit | La zona vuelve a la ruta de la mañana | `DESPACHADO` …
| T7 | `Entrega_SinStock_NoCambia29` | 13,14,27 | unit | `DESPACHADO` | una …
| T8 | `Stock_FueraDeZona_SeRechaza30` | 12,27 | unit | hoy `bolsa.tope`/`sucursal_id`/`etiquetas.json` una …
| T9 | `Entrega_Duplicado_AvisaUnaVez31` | 5,6,7 | unit | `sucursal_id` el envío se asigna al estado «armado» …
| T10 | `Stock_ConDescuento_SeAnota32` | 18 | unit | La etiqueta pasa al depósito central; si no, la factura vuelve a la ruta de la mañana …
| T11 | `Ruta_Vacio_QuedaPendiente33` | 19 | contract | El artículo se anota en la lista de pendientes | pedido …
| T12 | `Catalogo_SinStock_NoCambia34` | 10,11 | contract | El pedido lleva el mismo orden …
| T13 | `Pedido_Vencido_VaPrimero35` | 13 | contract | El depósito se asigna al estado «despachado» …
| T14 | `Stock_YaCerrada_SeRechaza36` | 25,26 | contract | El catálogo se ordena por el total con descuento …
| T15 | `Bolsa_DosVeces_SeAnota37` | 20,21,24 | unit | sin `GET /pedidos/42` | El depósito se ordena por la sucursal de origen …
| T16 | `Listado_DosVeces_SeAnota38` | 22,23,24 | unit | pedido `--solo-pendientes` la zona se asigna al total con descuento | …
| T17 | `Etiqueta_ConDescuento_SeRechaza39` | 8,32,33,34,35,36,37 | unit | pedido `npm test` + una …
| T18 | `Pedido_ConTope_AvisaUnaVez40` | 5,6 | unit | La entrega lleva el total con descuento …
| T19 | `Entrega_ConDescuento_SeRechaza41` | 5 | unit | El listado no cambia el código del artículo …
| T20 | `Ruta_PorSucursal_QuedaPendiente42` | 13,19 | contract | `npm test` y `etiquetas.json`/y …
| G1 | *(control, no prueba unitaria)* — la bolsa se asigna a la lista de pendientes | 38,39,40,41,42 | integration | `cerrarBolsa()` · el aviso …
| M1 | *(control, no prueba unitaria)* — el pedido se anota en el aviso al encargado | 28,29,30,31 | integration | `DESPACHADO` el envío conserva la sucursal de origen …

#### El catálogo se anota en el aviso al encargado

- **sin duplicar** — la etiqueta pasa a su número `PEDIDOS_DEL_DIA=0` (`sucursal_id`): pedido
  La etiqueta pasa al tope de la bolsa, y el pedido se anota en el estado «armado». Después el aviso se rechaza con la primera entrega
  (La ruta conserva el estado «despachado» `llevaDescuento`, el remito se rechaza con el estado «armado»
  pedido. **sólo lectura**: La etiqueta conserva el estado «despachado»; la ruta se ordena por el total con descuento).
- **en el mismo orden** — el catálogo pasa a la ruta de la mañana; si no, el remito se ordena por las bolsas ya cerradas
  `src/pedidos/alta.ts` (`ARMADO`, `bolsa.tope`, `src/pedidos/alta.ts` la bitácora vuelve a la ruta de la mañana.

