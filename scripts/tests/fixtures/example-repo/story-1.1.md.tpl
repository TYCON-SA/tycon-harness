---
epic: 1
story: "1.1"
title: "El saludo: por nombre, y al mundo cuando no hay nombre"
status: ready-for-dev
sprint: 1
priority: "P2"
approach: "[CREATE]"
depends_on: []
files_to_modify:
  - src/greeting.js
  - test/greeting.test.js
---

# Story 1.1: El saludo: por nombre, y al mundo cuando no hay nombre

Status: ready-for-dev

## Story

Como quien prueba el arnés en un repo propio,
quiero una función `greet(name)` con su comportamiento escrito y probado,
para recorrer el pipeline de una story de punta a punta sobre algo chico que cualquiera entiende.

## Acceptance Criteria

1. **Given** un nombre con texto **When** se llama `greet(name)` **Then** devuelve `Hello, <name>!`, con el nombre sin
   los espacios de los bordes (`greet('  Acme  ')` devuelve `Hello, Acme!`).
2. **Given** un nombre ausente, vacío o de sólo espacios **When** se llama `greet(name)` **Then** devuelve
   `Hello, world!`.

### Tests (2 verificaciones)

| # | Test | AC | Nivel | Escenario | Resultado esperado |
|---|------|----|-------|-----------|--------------------|
| T1 | `Greeting_WithName_GreetsByName` | 1 | unit | `greet('Acme')` y `greet('  Acme  ')` | `Hello, Acme!` en los dos |
| T2 | `Greeting_WithoutName_GreetsTheWorld` | 2 | unit | `greet()`, `greet('')` y `greet('   ')` | `Hello, world!` en los tres |

## Tasks / Subtasks

- [ ] [SEQ] Task 1: Salvaguarda — confirmar que `src/greeting.js` exporta `greet` y que `npm test` corre `node --test`
- [ ] [SEQ] Task 2: El saludo por nombre (AC 1) — T1
- [ ] [SEQ] Task 3: El saludo al mundo (AC 2) — T2

### Task Dependencies

Task 1 → Task 2 → Task 3

## Dev Notes

### Qué existe hoy

- **Archivo:** `src/greeting.js` — exporta `greet(name)`.
- **Archivo:** `test/greeting.test.js` — las dos pruebas de la tabla, con el runner nativo de Node (`node:test`).
- **Archivo:** `package.json` — `"test": "node --test"`, sin dependencias.

### Qué hay que hacer (la delta)

El repo es un ejemplo: el módulo y sus dos pruebas ya están. Implementar esta story es confirmar, criterio por
criterio, que el comportamiento escrito arriba es el que las pruebas ejercen, y completar lo que falte.

### Archivos a crear/modificar

| Archivo | Cambio |
|---|---|
| `src/greeting.js` | `greet(name)` cumple los AC 1 y 2 |
| `test/greeting.test.js` | T1 y T2 |

### Lo que NO hay que hacer

- No agregar dependencias: el repo corre con Node pelado.
- No cambiar el runner: `node --test`.

### Cómo verificar que funciona

```bash
npm test
```

### Salvaguarda de BD

No aplica: el repo no tiene base de datos.

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
