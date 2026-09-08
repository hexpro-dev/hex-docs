---
title: Guide
description: Comment scanner, écrire et organiser des badges NFC avec Fixture App, du premier scan à un badge qui survit à un passage en machine.
navTitle: Guide
tags:
  - scanning
---

Ce guide couvre les parties de Fixture App que vous utilisez tous les
jours : lire un badge, y écrire une charge utile et comprendre ce qui a
échoué quand le téléphone reste muet. Il suppose un iPhone capable de
lire les badges en arrière-plan, c'est-à-dire tous les modèles à partir
de l'iPhone XS.

Deux pages sont rattachées à celle-ci. La première fois, lisez-les dans
l'ordre.

## Par où commencer

1. [Scannez votre premier badge](first-tag.md) détaille la feuille Scan,
   le retour haptique déclenché par une lecture réussie et la liste des
   enregistrements qui apparaît une fois le badge décodé. La page
   utilise un autocollant NTAG213, la puce que l'on trouve dans la
   plupart des lots de badges bon marché.

2. [Quand un scan échoue](troubleshooting.md) répertorie les erreurs que
   la radio NFC peut renvoyer et ce que chacune signifie en pratique.
   Les expirations de session, les badges qui ne se lisent qu'une seule
   fois et le problème de position de l'antenne, à l'origine de la
   plupart des signalements, y sont tous traités.

Les deux pages supposent que vous avez accepté la demande d'autorisation
NFC au premier lancement. Si vous l'avez refusée, le bouton Scan est
désactivé et une bannière « NFC indisponible » s'affiche en haut de
l'écran Badges. Supprimer puis réinstaller l'app est le seul moyen de
revoir cette demande.

## Ce que le guide ne couvre pas

Les capacités des puces, l'organisation de leur mémoire et les types
d'enregistrements que chacune accepte se trouvent dans la section de
référence, pas ici. Si vous choisissez des badges à acheter, commencez
par la matrice de compatibilité des puces plutôt que par ce guide.

Le schéma d'URL de Fixture App, les actions de raccourcis et les rappels
de session de badge relèvent de la documentation destinée aux
développeurs. Ils ne sont pas repris dans le guide, qui est écrit pour
quelqu'un qui tient un téléphone et un autocollant.

> Un badge dont l'écriture échoue n'est en général pas défectueux. Une
> écriture exige que le badge reste dans le champ pendant toute
> l'opération, et une main qui s'éloigne après le signal sonore de
> lecture interrompt l'écriture : le badge reste lisible, mais
> inchangé. Ne bougez plus jusqu'au second signal sonore.

## Ordre de lecture pour un nouveau déploiement

Si vous préparez plus d'une poignée de badges, faites un passage complet
sur un seul badge avant de toucher aux autres. Écrivez-le, relisez-le
sur un deuxième téléphone, puis verrouillez-le. Un NTAG213 verrouillé ne
peut plus être réécrit : une erreur repérée sur le premier badge coûte
un autocollant, une erreur repérée sur le deux centième coûte un
après-midi.

L'[accueil de la documentation](../index.md) renvoie aux sections de
référence et développeur quand vous en avez besoin.
