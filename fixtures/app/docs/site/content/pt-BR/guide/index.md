---
title: Guia
description: Como ler, gravar e organizar etiquetas NFC com o Fixture App, da primeira leitura até uma etiqueta que sobrevive a uma lavagem.
navTitle: Guia
tags:
  - scanning
---

O guia cobre as partes do Fixture App que você usa todo dia: ler uma
etiqueta, gravar um payload nela e descobrir o que deu errado quando o
telefone não responde. Ele pressupõe um iPhone com suporte a leitura de
etiquetas em segundo plano, ou seja, todos os modelos a partir do
iPhone XS.

Duas páginas ficam abaixo desta. Na primeira vez, leia-as na ordem.

## Por onde começar

1. [Leia sua primeira etiqueta](first-tag.md) percorre o painel de
   Leitura, o retorno tátil que dispara em uma leitura bem-sucedida e a
   lista de registros que aparece assim que a etiqueta é decodificada.
   Ela usa um adesivo NTAG213, que é o chip da maioria dos pacotes de
   etiquetas baratas.

2. [Quando a leitura não funciona](troubleshooting.md) lista os erros
   que o rádio NFC pode retornar e o que cada um significa na prática.
   Tempos limite de sessão, etiquetas que são lidas uma vez e nunca
   mais, e o problema de posição da antena que responde pela maioria
   dos relatos estão todos lá.

As duas páginas pressupõem que você concedeu ao app a permissão de NFC
pedida na primeira execução. Se você recusou, o botão Ler fica
desativado e um aviso com o texto "NFC indisponível" aparece no topo da
tela Etiquetas. Apagar e reinstalar o app é a única forma de ver esse
pedido de novo.

## O que o guia não cobre

Capacidades dos chips, layouts de memória e os tipos exatos de registro
que cada chip aceita ficam na seção de referência, e não aqui. Se você
está escolhendo etiquetas para comprar, comece pela matriz de
compatibilidade de chips em vez deste guia.

O esquema de URL do Fixture App, as ações de atalhos e os callbacks de
sessão de etiqueta são material para desenvolvedores. Eles não se
repetem no guia, porque o guia foi escrito para quem está com um
telefone e um adesivo na mão.

> Uma etiqueta que falha na gravação normalmente não está com defeito.
> A gravação exige que a etiqueta permaneça no campo durante toda a
> operação, e uma mão que se afasta depois do tom de leitura aborta a
> gravação, deixando a etiqueta legível, porém inalterada. Fique parado
> até o segundo tom.

## Ordem de leitura para uma nova implantação

Se você vai configurar mais do que um punhado de etiquetas, faça o
processo completo em uma delas antes de mexer nas outras. Grave, leia
de volta em um segundo telefone e então bloqueie. Um NTAG213 bloqueado
não pode ser regravado, então um erro descoberto na primeira etiqueta
custa um adesivo, e um erro descoberto na etiqueta duzentos custa uma
tarde.

A [página inicial da documentação](../index.md) leva às seções de
referência e de desenvolvedor quando você precisar delas.
