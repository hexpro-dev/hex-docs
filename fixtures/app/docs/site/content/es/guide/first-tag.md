---
title: Escanea tu primera etiqueta
description: Lee una etiqueta NFC con Fixture App por primera vez y guarda lo que contiene.
audience: user
pageKind: howto
navTitle: Primer escaneo
tags:
  - scanning
since: "1.0.0"
redirectFrom:
  - first-tag
---

La primera lectura lleva unos diez segundos una vez tienes la etiqueta
en la mano. Casi todo ese tiempo se va en encontrar el punto del
teléfono donde está la antena, que queda más arriba en la parte trasera
de lo que la gente espera.

## Antes de empezar

Fixture App usa el lector NFC del teléfono, así que no hay nada que
emparejar ni nada que cargar. Cualquier iPhone a partir del iPhone 7,
con iOS 16 o posterior, puede leer una etiqueta.

Necesitas una etiqueta con la que el lector pueda hablar y un camino
despejado hasta ella:

- [x] Un iPhone 7 o posterior con iOS 16 o más reciente
- [x] Fixture App 1.0 o posterior, instalada desde la App Store
- [ ] Una etiqueta NTAG 213, NTAG 215 o MIFARE Ultralight
- [ ] Una funda de menos de 3 mm, o ninguna funda

::include[safety-note]

No todas las etiquetas responden. Las etiquetas MIFARE Classic se
quedan mudas en el iPhone porque el lector no habla su protocolo, y
algunas etiquetas de control de acceso solo responden tras un
intercambio de contraseña. La
[matriz de chips compatibles](../reference/chip-support.md) enumera los
chips que se han probado con la versión 1.0.

## Lee la etiqueta

::::steps
:::step[Abre la hoja de escaneo]
Toca el círculo grande del centro de la pantalla Biblioteca, o mantén
pulsado el icono de la app en la pantalla de inicio y elige Escanear.
La hoja sube y la línea de estado dice "Preparado para una etiqueta".

El lector permanece activo durante 60 segundos. Si no se acerca nada al
alcance, la hoja se cierra sola y no se añade nada a la Biblioteca.
:::

:::step[Apoya la etiqueta contra la parte superior del teléfono]
Apoya el borde superior del teléfono plano contra la etiqueta y mantén
los dos quietos. La línea de estado cambia a "Etiqueta detectada" y el
teléfono emite un chasquido corto.

La posición importa más que la presión:

- La antena recorre el borde superior, aproximadamente un centímetro
  por debajo del módulo de cámaras.
- Mantén la etiqueta paralela al teléfono en lugar de en ángulo.
- Aparta antes una cartera MagSafe o una tarjeta metálica.
:::

:::step[Revisa los registros y guarda]
Cuando termina la lectura, la hoja enumera todos los registros NDEF de
la etiqueta, en el orden en que están almacenados. Fixture App reconoce
los registros URL, de texto y de Wi-Fi, y muestra una vista previa de
cada uno. Todo lo demás aparece como bytes en bruto.

Toca Guardar para conservar la etiqueta, o Descartar para cerrar la
hoja sin escribir nada en la Biblioteca.
:::
::::

:::figure[La hoja de escaneo, esperando a que se acerque una etiqueta]
![La hoja de escaneo esperando una etiqueta](../../../assets/scan-screen.png)
:::

:::warning[Una lectura parcial parece una lectura correcta]
Las etiquetas con una zona protegida por contraseña responden a la
primera parte de una lectura y rechazan el resto. Fixture App muestra
lo que ha obtenido y pone "Registros incompletos" bajo el nombre de la
etiqueta. Busca esa línea antes de fiarte de la lectura de una etiqueta
de control de acceso.
:::

:::tip
Activa Ajustes > Escaneo > Mantener la hoja abierta para leer varias
etiquetas de una vez. La Biblioteca agrupa todo lo de esa sesión bajo
un único encabezado.
:::

## Después de la lectura

Las etiquetas guardadas van a la Biblioteca, las más recientes primero,
con el tipo de chip y la hora de la lectura debajo del nombre. Al tocar
una se abre Detalle de la etiqueta, que muestra los bytes en bruto
junto a los registros descodificados.

![Una lectura completada con tres registros NDEF](../../../assets/scan-screen.png)

Cambiar el nombre de una etiqueta solo afecta a lo que ves en la
Biblioteca. No se escribe nada en la etiqueta salvo que uses la hoja de
escritura, que es un procedimiento aparte.

## Si la lectura no termina

El lector reintenta por su cuenta. Los dos primeros intentos ocurren en
silencio, con un segundo aproximado entre uno y otro. A partir del
tercer intento, la hoja empieza a informar de lo que hace:

3. "Sigo buscando" aparece en la línea de estado y el chasquido se
   detiene.
4. El lector baja a una frecuencia de sondeo más lenta.
5. La sesión termina con "Etiqueta perdida antes de terminar la
   lectura".

Una lectura que llega al quinto intento dos veces seguidas suele ser
cosa de la etiqueta, no del teléfono.
[Cuando un escaneo no funciona](troubleshooting.md) repasa las causas
en el orden en que conviene comprobarlas.
