---
title: Scannez votre premier badge
description: Lisez un badge NFC avec Fixture App pour la première fois et enregistrez ce qu'il contient.
audience: user
pageKind: howto
navTitle: Premier scan
tags:
  - scanning
since: "1.0.0"
redirectFrom:
  - first-tag
---

Une première lecture prend une dizaine de secondes, badge en main.
L'essentiel de ce temps sert à trouver l'endroit où se loge l'antenne,
plus haut au dos du téléphone qu'on ne l'imagine.

## Avant de commencer

Fixture App utilise le lecteur NFC du téléphone : il n'y a rien à
appairer ni à recharger. Tout iPhone à partir de l'iPhone 7, sous iOS 16
ou une version ultérieure, peut lire un badge.

Il vous faut un badge auquel le lecteur sait parler, et un accès dégagé
jusqu'à lui :

- [x] Un iPhone 7 ou plus récent sous iOS 16 ou une version ultérieure
- [x] Fixture App 1.0 ou plus récent, installé depuis l'App Store
- [ ] Un badge NTAG 213, NTAG 215 ou MIFARE Ultralight
- [ ] Une coque de moins de 3 mm d'épaisseur, ou pas de coque du tout

::include[safety-note]

Tous les badges ne répondent pas. Les badges MIFARE Classic restent
muets sur iPhone parce que le lecteur ne parle pas leur protocole, et
certains badges de contrôle d'accès ne répondent qu'après un échange de
mot de passe. La
[matrice de compatibilité des puces](../reference/chip-support.md)
répertorie les puces testées avec la version 1.0.

## Lire le badge

::::steps
:::step[Ouvrir la feuille Scan]
Touchez le grand cercle au milieu de l'écran Bibliothèque, ou maintenez
le doigt sur l'icône de l'app sur l'écran d'accueil et choisissez Scan.
La feuille remonte et la ligne d'état indique « Prêt pour un badge ».

Le lecteur reste actif pendant 60 secondes. Si rien n'entre dans son
champ, la feuille se referme d'elle-même et rien n'est ajouté à la
Bibliothèque.
:::

:::step[Tenir le badge contre le haut du téléphone]
Posez le bord supérieur du téléphone à plat contre le badge et gardez
les deux immobiles. La ligne d'état passe à « Badge détecté » et le
téléphone émet un bref tic.

La position compte davantage que la pression :

- L'antenne court le long du bord supérieur, à environ un centimètre
  sous le bloc photo.
- Gardez le badge parallèle au téléphone plutôt qu'en biais.
- Écartez d'abord un portefeuille MagSafe ou une carte métallique.
:::

:::step[Vérifier les enregistrements et enregistrer]
Une fois la lecture terminée, la feuille liste tous les enregistrements
NDEF du badge, dans leur ordre de stockage. Fixture App reconnaît les
enregistrements URL, texte et Wi-Fi, et affiche un aperçu de chacun. Le
reste est présenté sous forme d'octets bruts.

Touchez Enregistrer pour conserver le badge, ou Ignorer pour fermer la
feuille sans rien inscrire dans la Bibliothèque.
:::
::::

:::figure[La feuille Scan, en attente d'un badge à portée]
![La feuille Scan en attente d'un badge](../../../assets/scan-screen.png)
:::

:::warning[Une lecture partielle ressemble à une réussite]
Les badges dotés d'une zone protégée par mot de passe répondent à la
première partie de la lecture et refusent le reste. Fixture App affiche
ce qu'il a obtenu et indique « Enregistrements incomplets » sous le nom
du badge. Cherchez cette mention avant de vous fier à la lecture d'un
badge de contrôle d'accès.
:::

:::tip
Activez Réglages > Scan > Garder la feuille ouverte pour lire plusieurs
badges à la suite. La Bibliothèque regroupe tout ce qui provient de
cette session sous un même titre.
:::

## Après la lecture

Les badges enregistrés arrivent dans la Bibliothèque, du plus récent au
plus ancien, avec le type de puce et l'heure de la lecture sous le nom.
En toucher un ouvre Détail du badge, qui affiche les octets bruts à côté
des enregistrements décodés.

![Une lecture terminée affichant trois enregistrements NDEF](../../../assets/scan-screen.png)

Renommer un badge ne change que ce que vous voyez dans la Bibliothèque.
Rien n'est réécrit sur le badge lui-même tant que vous n'utilisez pas la
feuille Écriture, qui est une procédure distincte.

## Si la lecture n'aboutit pas

Le lecteur réessaie de lui-même. Les deux premières tentatives passent
inaperçues, à environ une seconde d'intervalle. À partir de la
troisième, la feuille rend compte de ce qu'elle fait :

3. « Recherche en cours » s'affiche dans la ligne d'état et le tic
   s'arrête.
4. Le lecteur repasse à une fréquence d'interrogation plus lente.
5. La session se termine sur « Badge perdu avant la fin de la lecture ».

Une lecture qui atteint la cinquième tentative deux fois de suite vient
en général du badge, pas du téléphone.
[Quand un scan échoue](troubleshooting.md) passe en revue les causes
dans l'ordre où il vaut la peine de les vérifier.
