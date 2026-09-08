---
title: Referencia
description: Páginas de consulta sobre la compatibilidad del hardware de etiquetas y la API de sesión de etiqueta de Fixture App.
navTitle: Referencia
tags:
  - chips
---

Las páginas de referencia responden rápido a una pregunta concreta. No
te llevan de la mano por una tarea, que es para lo que está
[la guía](../guide/index.md).

## Qué hay aquí

La [matriz de chips compatibles](chip-support.md) enumera todas las
familias de etiquetas que reconoce Fixture App, con la memoria
utilizable, los modos de escritura que acepta cada una y si sus bits de
bloqueo son irreversibles. Consúltala antes de comprar un lote de
etiquetas.

La [API de sesión de etiqueta](api.md) documenta el tipo `TagSession`,
los registros que devuelve y todos los errores que puede lanzar. Está
escrita para desarrolladores que integran el lector de Fixture App en
otra app.

## Convenciones

Ambas páginas usan la misma notación. Los tamaños son los bytes de los
que dispones después de la cabecera propia de la etiqueta, no la cifra
impresa en el envase.

| Notación | Significado |
| -------- | ------- |
| `0x04` | Un solo byte en hexadecimal, tal como lo imprime la app |
| `216 B` | Memoria de usuario utilizable, sin contar la cabecera |
| `n/a` | El campo no se aplica a esa familia de etiquetas |
| `RO` | Solo lectura, porque se han fijado los bits de bloqueo |

Un campo marcado como `n/a` está ausente, no vale cero. Una etiqueta
que informa de `0 B` se ha bloqueado con un contenido vacío, que es un
problema distinto.
