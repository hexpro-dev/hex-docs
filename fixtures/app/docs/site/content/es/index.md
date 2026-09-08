---
title: Documentación de Fixture App
description: Lee y reescribe los registros NDEF de una etiqueta NFC desde un iPhone, sin que nada salga del dispositivo.
navTitle: Vista general
tags:
  - scanning
---

Fixture App convierte un iPhone en un lector y un grabador de
etiquetas. Funciona sobre el hardware NFC que Apple expone a las apps
de terceros, de modo que solo se lee una etiqueta cada vez y con la
hoja de escaneo abierta.

## Qué hace Fixture App

Acerca el borde superior del teléfono a una etiqueta y la app
descodifica el mensaje NDEF que contiene. Desde ahí puedes editar un
registro sobre la marcha o sobrescribir la etiqueta con uno nuevo. No
se sube nada, y ningún historial de escaneos sobrevive al cierre de la
app.

El lector entiende estos tipos de contenido:
- registros de texto, con el código de idioma que declara la etiqueta
- registros URI, incluidos los atajos `tel:` y `mailto:`
- registros de traspaso Wi-Fi escritos por un teléfono Android
- contenidos vCard, que se muestran como una ficha de contacto

La escritura es *destructiva*. La app sustituye el mensaje NDEF
completo en lugar de añadir contenido al final, así que lo que hubiera
en la etiqueta desaparece en cuanto tocas **Escribir**. Una etiqueta
bloqueada sigue siendo legible, y el grabador se detiene con
`Tag is permanently locked` en lugar de informar de que ha ido bien.

## Qué necesitas

Hardware compatible: iPhone 7 o posterior, con iOS 16 o posterior.\
Etiquetas compatibles: chips ISO 14443 de tipo A formateados para NDEF.

La [matriz de chips compatibles](reference/chip-support.md) enumera
todos los chips con los que se ha probado el lector y cuánta memoria
escribible tiene cada uno. Un NTAG213 admite 132 bytes, es decir, una
URL corta y poco más.

:::note[Escaneo en segundo plano]
iOS entrega una etiqueta a una app en segundo plano solo cuando la
etiqueta lleva un registro URL que coincide con el dominio asociado de
la app. Todo lo demás requiere la hoja de escaneo abierta en primer
plano.
:::

::include[safety-note]

---

## Por dónde seguir

Empieza por [Escanea tu primera etiqueta](guide/first-tag.md), que
cubre una lectura y una escritura en un NTAG215 en blanco. Si una
etiqueta no se lee en absoluto, vuelve a comprobar primero
[qué necesitas](#what-you-need). La mayoría de los fallos se deben a un
chip al que el lector no puede dirigirse, no a un defecto de la
etiqueta.

Los números de compilación y las notas de versión están en el
[sitio de Fixture App](https://example.com/fixture-app). Envía
correcciones de esta documentación a
[docs@example.com](mailto:docs@example.com).
