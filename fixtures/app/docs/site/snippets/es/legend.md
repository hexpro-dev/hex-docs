---
title: Cómo leer la matriz
---

| Estado | Significado |
| --- | --- |
| ✅ | Verificado en hardware. Fixture App lee y escribe todos los tipos de registro que admite el chip, incluidas las páginas NDEF bloqueadas. |
| ⚠️ | Parcial. La lectura funciona, la escritura no, normalmente porque el chip viene con una contraseña del fabricante que Fixture App no puede establecer. |
| ❌ | No compatible. El chip se reconoce durante el descubrimiento, y la sesión termina antes de cualquier escritura, así que la etiqueta queda intacta. |
| — | No aplicable. Este chip no tiene una superficie NDEF que Fixture App pueda usar. |

El estado se registra por revisión del chip, así que comprueba la
revisión indicada en la fila en lugar del nombre de familia impreso en
el envase.
