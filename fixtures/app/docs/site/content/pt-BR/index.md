---
title: Documentação do Fixture App
description: Leia e regrave os registros NDEF de uma etiqueta NFC a partir de um iPhone, sem que nada saia do dispositivo.
navTitle: Visão geral
tags:
  - scanning
---

O Fixture App transforma um iPhone em leitor e gravador de etiquetas.
Ele funciona sobre o hardware NFC que a Apple expõe a apps de
terceiros, o que significa uma etiqueta por vez, com o painel de
Leitura aberto.

## O que o Fixture App faz

Encoste a borda superior do telefone em uma etiqueta e o app decodifica
a mensagem NDEF gravada nela. A partir daí, você pode editar um
registro no lugar ou substituir a etiqueta por uma mensagem nova. Nada
é enviado para fora do aparelho, e nenhum histórico de leituras
sobrevive ao fechamento do app.

O leitor entende estes payloads:
- registros de texto, com o código de idioma que a etiqueta declara
- registros URI, incluindo os atalhos `tel:` e `mailto:`
- registros de transferência de Wi-Fi gravados por um telefone Android
- payloads vCard, exibidos como um cartão de contato

A gravação é *destrutiva*. O app substitui a mensagem NDEF inteira em
vez de acrescentar dados a ela, então tudo o que estava na etiqueta
desaparece no momento em que você toca em **Gravar**. Uma etiqueta
bloqueada continua legível, e o gravador para com
`Tag is permanently locked` em vez de informar sucesso.

## O que você precisa

Hardware compatível: iPhone 7 ou posterior, com iOS 16 ou posterior.\
Etiquetas compatíveis: chips ISO 14443 Tipo A formatados para NDEF.

A [Matriz de compatibilidade de chips](reference/chip-support.md) lista
todos os chips com os quais o leitor foi testado e quanta memória
gravável cada um tem. Um NTAG213 comporta 132 bytes, o que dá uma URL
curta e pouco mais.

:::note[Leitura em segundo plano]
O iOS entrega uma etiqueta a um app em segundo plano apenas quando a
etiqueta carrega um registro de URL correspondente ao domínio associado
do app. Todo o resto exige o painel de Leitura aberto em primeiro
plano.
:::

::include[safety-note]

---

## Para onde ir agora

Comece por [Leia sua primeira etiqueta](guide/first-tag.md), que cobre
uma leitura e uma gravação em um NTAG215 vazio. Se uma etiqueta não for
lida de jeito nenhum, revise antes [o que você precisa](#what-you-need).
A maioria das falhas é um chip que o leitor não consegue endereçar, e
não um defeito na etiqueta.

Os números de build e as notas de versão ficam no
[site do Fixture App](https://example.com/fixture-app). Envie correções
desta documentação para [docs@example.com](mailto:docs@example.com).
