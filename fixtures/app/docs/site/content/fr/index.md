---
title: Documentation de Fixture App
description: Lisez et réécrivez les enregistrements NDEF d'un badge NFC depuis un iPhone, sans qu'aucune donnée ne quitte l'appareil.
navTitle: Vue d'ensemble
tags:
  - scanning
---

Fixture App transforme un iPhone en lecteur et en enregistreur de
badges. L'app s'appuie sur le matériel NFC qu'Apple ouvre aux apps
tierces, ce qui impose un badge à la fois, la feuille Scan ouverte.

## Ce que fait Fixture App

Approchez le bord supérieur du téléphone d'un badge et l'app décode le
message NDEF qu'il contient. Vous pouvez ensuite modifier un
enregistrement sur place ou écraser le badge avec un nouveau message.
Rien n'est envoyé nulle part, et aucun historique de scan ne survit à
la fermeture de l'app.

Le lecteur reconnaît les charges utiles suivantes :
- les enregistrements texte, avec le code de langue déclaré par le badge
- les enregistrements URI, y compris les raccourcis `tel:` et `mailto:`
- les enregistrements de transfert Wi-Fi écrits par un téléphone Android
- les charges utiles vCard, affichées sous forme de fiche contact

L'écriture est *destructive*. L'app remplace l'intégralité du message
NDEF au lieu d'y ajouter des enregistrements : ce que contenait le
badge disparaît dès que vous touchez **Écrire**. Un badge verrouillé
reste lisible, et l'écriture s'arrête sur `Tag is permanently locked`
au lieu d'annoncer une réussite.

## Ce qu'il vous faut

Matériel pris en charge : iPhone 7 ou plus récent, sous iOS 16 ou
version ultérieure.\
Badges pris en charge : puces ISO 14443 de type A formatées pour NDEF.

La [matrice de compatibilité des puces](reference/chip-support.md)
répertorie toutes les puces avec lesquelles le lecteur a été testé,
ainsi que la mémoire inscriptible de chacune. Un NTAG213 contient 132
octets, soit une URL courte et pas grand-chose d'autre.

:::note[Lecture en arrière-plan]
iOS ne transmet un badge à une app en arrière-plan que si ce badge
porte un enregistrement URL correspondant au domaine associé de l'app.
Tout le reste exige la feuille Scan ouverte au premier plan.
:::

::include[safety-note]

---

## Pour aller plus loin

Commencez par [Scannez votre premier badge](guide/first-tag.md), qui
traite une lecture et une écriture sur un NTAG215 vierge. Si un badge
ne se lit pas du tout, revérifiez d'abord
[ce qu'il vous faut](#what-you-need). La plupart des échecs viennent
d'une puce que le lecteur ne sait pas adresser, pas d'un défaut du
badge.

Les numéros de build et les notes de version sont publiés sur le
[site de Fixture App](https://example.com/fixture-app). Envoyez vos
corrections sur cette documentation à
[docs@example.com](mailto:docs@example.com).
