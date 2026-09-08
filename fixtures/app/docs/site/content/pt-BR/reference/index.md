---
title: Referência
description: Páginas de consulta sobre a compatibilidade de hardware das etiquetas e a API de sessão de etiqueta do Fixture App.
navTitle: Referência
tags:
  - chips
---

As páginas de referência respondem rapidamente a uma pergunta
específica. Elas não conduzem você por uma tarefa, que é para o que
serve [o guia](../guide/index.md).

## O que há aqui

A [Matriz de compatibilidade de chips](chip-support.md) lista todas as
famílias de etiquetas que o Fixture App reconhece, com a memória
utilizável, os modos de gravação que cada uma aceita e se os bits de
bloqueio são irreversíveis. Consulte-a antes de comprar um lote de
etiquetas.

A [API de sessão de etiqueta](api.md) documenta o tipo `TagSession`, os
registros que ele retorna e todos os erros que ele pode lançar. Foi
escrita para desenvolvedores que integram o leitor do Fixture App a
outro app.

## Convenções

As duas páginas usam a mesma notação. Os tamanhos são os bytes
disponíveis para você depois do cabeçalho da própria etiqueta, e não o
número impresso na embalagem.

| Notação | Significado |
| -------- | ------- |
| `0x04` | Um único byte em hexadecimal, como o app o imprime |
| `216 B` | Memória de usuário utilizável, sem o cabeçalho |
| `n/a` | O campo não se aplica a essa família de etiquetas |
| `RO` | Somente leitura, porque os bits de bloqueio foram definidos |

Um campo marcado como `n/a` está ausente, e não em zero. Uma etiqueta
que informa `0 B` foi bloqueada com um payload vazio, o que é um
problema diferente.
