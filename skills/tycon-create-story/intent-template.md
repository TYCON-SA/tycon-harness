---
id: story-{{epic_num}}.{{story_num}}-{{story_slug}}
status: draft
objective: "{{qué se quiere resolver y por qué importa, sin el cómo}}"
outcomes:
  - "{{lo que se ve cuando está resuelto}}"
---

<!--
La intención de la historia, en formato IntentSpec 1.2 (https://intentspec.org/spec). Va al lado de la historia, con su
mismo nombre y `.intent.md`. Dice el qué y el por qué; el cómo va en la historia. Las reglas, en story-format.md,
sección «La intención». Se aprueba cuando no le queda nada que bloquee, y desde ahí queda congelada: lo que se sepa
después va a la historia.

Lo que falta aclarar se marca en el texto con [falta: Q<n>] o [falta: R<n>], con su fila abajo.
Opcionales de IntentSpec: las secciones ## Constraints, ## Edge Cases (escenario: resultado) y ## Verification.
-->

# {{story_title}}

## Preguntas abiertas

<!--
Lo que no se sabe. Una fila por pregunta, o «Ninguna.» sola si no hay ninguna.
Bloquea: sí | no. Estado: abierta | supuesta | encontrada | contestada | descartada.
Fuente: persona:<nombre> | repo:<archivo:línea> | memoria:<id> | pedido:<número> | —
Una supuesta no bloquea; una encontrada lleva fuente repo: o memoria:; una contestada o descartada, persona:.
-->

| # | Pregunta | Por qué importa | Quién contesta | Bloquea | Estado | Respuesta | Fuente |
|---|---|---|---|---|---|---|---|
| Q1 | {{la pregunta}} | {{qué cambia según la respuesta}} | {{quién la sabe}} | sí | abierta |  | — |

## Decisiones reservadas

<!--
Lo que decide una persona, no el agente: el agente propone, no decide. Una fila por decisión, o «Ninguna.» sola
(«Ninguna, porque <motivo>.» cuando el riesgo pide decir por qué).
Estado: abierta | tomada | descartada. Fuente: persona:<nombre> | —
Con decisiones, en lugar de «Ninguna.»:

| # | Decisión | Por qué es de una persona | Quién decide | Propuesta del agente | Estado | Respuesta | Fuente |
|---|---|---|---|---|---|---|---|
| R1 | {{la decisión}} | {{por qué no la toma el agente}} | {{quién}} | {{lo que propone el agente}} | abierta |  | — |
-->

Ninguna.
