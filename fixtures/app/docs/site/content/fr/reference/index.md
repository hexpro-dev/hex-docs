---
title: Référence
description: Pages de consultation sur la compatibilité matérielle des badges et sur l'API de session de badge dans Fixture App.
navTitle: Référence
tags:
  - chips
---

Les pages de référence répondent vite à une question précise. Elles ne
vous guident pas pas à pas dans une tâche : c'est le rôle
[du guide](../guide/index.md).

## Ce que vous trouverez ici

La [matrice de compatibilité des puces](chip-support.md) répertorie
toutes les familles de badges que Fixture App reconnaît, avec la mémoire
utilisable, les modes d'écriture acceptés par chacune et le caractère
irréversible ou non de leurs bits de verrouillage. Consultez-la avant
d'acheter un lot de badges.

L'[API de session de badge](api.md) documente le type `TagSession`, les
enregistrements qu'il renvoie et toutes les erreurs qu'il peut lever.
Elle est écrite pour les développeurs qui intègrent le lecteur de
Fixture App dans une autre app.

## Conventions

Les deux pages emploient la même notation. Les tailles correspondent aux
octets qui vous restent une fois l'en-tête propre au badge déduit, pas
au chiffre imprimé sur l'emballage.

| Notation | Signification |
| -------- | ------- |
| `0x04` | Un octet unique en hexadécimal, tel que l'app l'affiche |
| `216 B` | Mémoire utilisateur utilisable, en-tête exclu |
| `n/a` | Le champ ne s'applique pas à cette famille de badges |
| `RO` | Lecture seule, parce que les bits de verrouillage ont été posés |

Un champ marqué `n/a` est absent, et non nul. Un badge qui annonce `0 B`
a été verrouillé avec une charge utile vide, ce qui est un autre
problème.
