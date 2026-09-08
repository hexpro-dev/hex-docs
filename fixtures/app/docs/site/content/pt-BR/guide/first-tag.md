---
title: Leia sua primeira etiqueta
description: Leia uma etiqueta NFC com o Fixture App pela primeira vez e salve o que ela contém.
audience: user
pageKind: howto
navTitle: Primeira leitura
tags:
  - scanning
since: "1.0.0"
redirectFrom:
  - first-tag
---

A primeira leitura leva cerca de dez segundos, com a etiqueta já na
mão. A maior parte desse tempo é encontrar o ponto do telefone onde
fica a antena, que está mais para cima na traseira do que as pessoas
imaginam.

## Antes de começar

O Fixture App usa o leitor NFC do telefone, então não há nada para
parear nem para carregar. Qualquer iPhone a partir do iPhone 7, com iOS
16 ou posterior, consegue ler uma etiqueta.

Você precisa de uma etiqueta com a qual o leitor consiga conversar, e
de um caminho livre até ela:

- [x] Um iPhone 7 ou posterior com iOS 16 ou mais recente
- [x] Fixture App 1.0 ou posterior, instalado pela App Store
- [ ] Uma etiqueta NTAG 213, NTAG 215 ou MIFARE Ultralight
- [ ] Uma capa mais fina que 3 mm, ou nenhuma capa

::include[safety-note]

Nem toda etiqueta responde. Etiquetas MIFARE Classic ficam mudas no
iPhone porque o leitor não fala o protocolo delas, e algumas etiquetas
de controle de acesso só respondem depois de uma troca de senha. A
[Matriz de compatibilidade de chips](../reference/chip-support.md)
lista os chips que foram testados na versão 1.0.

## Leia a etiqueta

::::steps
:::step[Abra o painel de Leitura]
Toque no círculo grande no meio da tela Biblioteca, ou mantenha
pressionado o ícone do app na Tela de Início e escolha Ler. O painel
sobe e a linha de status mostra "Pronto para uma etiqueta".

O leitor fica ativo por 60 segundos. Se nada entrar no alcance, o
painel se fecha sozinho e nada é adicionado à Biblioteca.
:::

:::step[Encoste a etiqueta na parte de cima do telefone]
Apoie a borda superior do telefone rente à etiqueta e mantenha os dois
parados. A linha de status muda para "Etiqueta detectada" e o telefone
emite um clique curto.

A posição importa mais do que a pressão:

- A antena corre ao longo da borda superior, cerca de um centímetro
  abaixo do módulo de câmeras.
- Mantenha a etiqueta alinhada com o telefone, e não inclinada.
- Tire antes do caminho uma carteira MagSafe ou um cartão de metal.
:::

:::step[Confira os registros e salve]
Quando a leitura termina, o painel lista todos os registros NDEF da
etiqueta, na ordem em que estão armazenados. O Fixture App reconhece
registros de URL, de texto e de Wi-Fi e mostra uma prévia de cada um.
Qualquer outra coisa aparece como bytes brutos.

Toque em Salvar para guardar a etiqueta, ou em Descartar para fechar o
painel sem gravar nada na Biblioteca.
:::
::::

:::figure[O painel de Leitura à espera de uma etiqueta no alcance]
![O painel de Leitura à espera de uma etiqueta](../../../assets/scan-screen.png)
:::

:::warning[Uma leitura parcial se parece com um sucesso]
Etiquetas com uma área protegida por senha respondem à primeira parte
da leitura e recusam o resto. O Fixture App mostra o que conseguiu e
coloca "Registros incompletos" abaixo do nome da etiqueta. Procure essa
linha antes de confiar na leitura de uma etiqueta de controle de
acesso.
:::

:::tip
Ative Ajustes > Leitura > Manter painel aberto para ler várias
etiquetas de uma vez. A Biblioteca agrupa tudo dessa sessão sob um
único título.
:::

## Depois da leitura

As etiquetas salvas vão para a Biblioteca, das mais recentes para as
mais antigas, com o tipo de chip e a hora da leitura abaixo do nome.
Tocar em uma delas abre Detalhes da etiqueta, que mostra os bytes
brutos ao lado dos registros decodificados.

![Uma leitura concluída listando três registros NDEF](../../../assets/scan-screen.png)

Renomear uma etiqueta muda apenas o que você vê na Biblioteca. Nada é
gravado de volta na própria etiqueta, a menos que você use o painel de
Gravação, que é um procedimento à parte.

## Se a leitura não terminar

O leitor tenta de novo por conta própria. As duas primeiras tentativas
acontecem em silêncio, com cerca de um segundo entre elas. A partir da
terceira tentativa, o painel passa a informar o que está fazendo:

3. "Ainda procurando" aparece na linha de status e o clique para.
4. O leitor recorre a uma taxa de sondagem mais lenta.
5. A sessão termina com "Etiqueta perdida antes do fim da leitura".

Uma leitura que chega à quinta tentativa duas vezes seguidas costuma
ser problema da etiqueta, e não do telefone.
[Quando a leitura não funciona](troubleshooting.md) percorre as causas
na ordem em que vale a pena verificá-las.
