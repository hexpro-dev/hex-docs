---
title: Guía
description: Cómo escanear, escribir y organizar etiquetas NFC con Fixture App, desde el primer escaneo hasta una etiqueta que aguanta un lavado.
navTitle: Guía
tags:
  - scanning
---

La guía cubre las partes de Fixture App que usas a diario: leer una
etiqueta, escribir contenido en ella y averiguar qué ha fallado cuando
el teléfono no reacciona. Da por supuesto un iPhone compatible con la
lectura de etiquetas en segundo plano, que son todos los modelos a
partir del iPhone XS.

Por debajo de esta hay dos páginas. La primera vez, léelas en orden.

## Por dónde empezar

1. [Escanea tu primera etiqueta](first-tag.md) recorre la hoja de
   escaneo, la vibración que se dispara en una lectura correcta y la
   lista de registros que aparece una vez descodificada la etiqueta.
   Usa un adhesivo NTAG213, que es el chip de la mayoría de los packs
   de etiquetas baratos.

2. [Cuando un escaneo no funciona](troubleshooting.md) enumera los
   errores que puede devolver la radio NFC y qué significa cada uno en
   la práctica. Allí se tratan los tiempos de espera de la sesión, las
   etiquetas que se leen una vez y nunca más, y el problema de posición
   de la antena que explica la mayoría de los avisos.

Ambas páginas dan por hecho que concediste el permiso de NFC que la app
pide al abrirse por primera vez. Si lo rechazaste, el botón Escanear
queda desactivado y aparece un aviso que dice "NFC no está disponible"
en la parte superior de la pantalla Etiquetas. Borrar la app y volver a
instalarla es la única forma de ver esa petición otra vez.

## Lo que la guía no cubre

Las capacidades de los chips, la distribución de la memoria y los tipos
de registro exactos que acepta cada chip están en la sección de
referencia, no aquí. Si estás eligiendo qué etiquetas comprar, empieza
por la matriz de chips compatibles en lugar de por esta guía.

El esquema de URL de Fixture App, las acciones de Atajos y las
retrollamadas de sesión de etiqueta son material para desarrolladores.
No se repiten en la guía, porque la guía está escrita para alguien que
tiene en la mano un teléfono y un adhesivo.

> Una etiqueta en la que falla la escritura no suele estar defectuosa.
> Las operaciones de escritura necesitan que la etiqueta siga dentro
> del campo durante toda la operación, y una mano que se aparta tras el
> tono de lectura aborta la escritura y deja la etiqueta legible pero
> sin cambios. No te muevas hasta el segundo tono.

## Orden de lectura para un despliegue nuevo

Si vas a preparar más de un puñado de etiquetas, haz una pasada
completa con una sola antes de tocar el resto. Escríbela, vuelve a
leerla con un segundo teléfono y luego bloquéala. Un NTAG213 bloqueado
no se puede reescribir, así que un error detectado en la etiqueta uno
cuesta un adhesivo y un error detectado en la etiqueta doscientas
cuesta una tarde.

La [portada de la documentación](../index.md) enlaza con las secciones
de referencia y de desarrollo cuando las necesites.
