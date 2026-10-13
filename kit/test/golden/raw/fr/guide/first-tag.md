# Scannez votre premier badge

Une premi\u00e8re lecture prend une dizaine de secondes, badge en main.
L'essentiel de ce temps sert \u00e0 trouver l'endroit o\u00f9 se loge l'antenne,
plus haut au dos du t\u00e9l\u00e9phone qu'on ne l'imagine.

## Avant de commencer

Fixture App utilise le lecteur NFC du t\u00e9l\u00e9phone : il n'y a rien \u00e0
appairer ni \u00e0 recharger. Tout iPhone \u00e0 partir de l'iPhone 7, sous iOS 16
ou une version ult\u00e9rieure, peut lire un badge.

Il vous faut un badge auquel le lecteur sait parler, et un acc\u00e8s d\u00e9gag\u00e9
jusqu'\u00e0 lui :

- [x] Un iPhone 7 ou plus r\u00e9cent sous iOS 16 ou une version ult\u00e9rieure
- [x] Fixture App 1.0 ou plus r\u00e9cent, install\u00e9 depuis l'App Store
- [ ] Un badge NTAG 213, NTAG 215 ou MIFARE Ultralight
- [ ] Une coque de moins de 3 mm d'\u00e9paisseur, ou pas de coque du tout

> **Attention\u00a0: Ne forcez pas un badge contre le t\u00e9l\u00e9phone**
>
> Fixture App a besoin d'environ deux secondes de contact pour terminer une
> \u00e9criture. Appuyer plus fort ne raccourcit pas ce d\u00e9lai, et un badge pli\u00e9
> contre une coque m\u00e9tallique peut fissurer l'antenne log\u00e9e dans l'inlay.

Gardez le badge \u00e0 plat et immobile jusqu'\u00e0 ce que la feuille Scan affiche
la barre de confirmation verte. Si l'\u00e9criture est interrompue, le badge
conserve son contenu pr\u00e9c\u00e9dent : une \u00e9criture rat\u00e9e peut \u00eatre retent\u00e9e
sans risque.

Tous les badges ne r\u00e9pondent pas. Les badges MIFARE Classic restent
muets sur iPhone parce que le lecteur ne parle pas leur protocole, et
certains badges de contr\u00f4le d'acc\u00e8s ne r\u00e9pondent qu'apr\u00e8s un \u00e9change de
mot de passe. La
[matrice de compatibilit\u00e9 des puces](hexdocs:page/reference/chip-support.md)
r\u00e9pertorie les puces test\u00e9es avec la version 1.0.

## Lire le badge

1. **Ouvrir la feuille Scan**

   Touchez le grand cercle au milieu de l'\u00e9cran Biblioth\u00e8que, ou maintenez
   le doigt sur l'ic\u00f4ne de l'app sur l'\u00e9cran d'accueil et choisissez Scan.
   La feuille remonte et la ligne d'\u00e9tat indique \u00ab Pr\u00eat pour un badge \u00bb.

   Le lecteur reste actif pendant 60 secondes. Si rien n'entre dans son
   champ, la feuille se referme d'elle-m\u00eame et rien n'est ajout\u00e9 \u00e0 la
   Biblioth\u00e8que.

2. **Tenir le badge contre le haut du t\u00e9l\u00e9phone**

   Posez le bord sup\u00e9rieur du t\u00e9l\u00e9phone \u00e0 plat contre le badge et gardez
   les deux immobiles. La ligne d'\u00e9tat passe \u00e0 \u00ab Badge d\u00e9tect\u00e9 \u00bb et le
   t\u00e9l\u00e9phone \u00e9met un bref tic.

   La position compte davantage que la pression :

   - L'antenne court le long du bord sup\u00e9rieur, \u00e0 environ un centim\u00e8tre
     sous le bloc photo.
   - Gardez le badge parall\u00e8le au t\u00e9l\u00e9phone plut\u00f4t qu'en biais.
   - \u00c9cartez d'abord un portefeuille MagSafe ou une carte m\u00e9tallique.

3. **V\u00e9rifier les enregistrements et enregistrer**

   Une fois la lecture termin\u00e9e, la feuille liste tous les enregistrements
   NDEF du badge, dans leur ordre de stockage. Fixture App reconna\u00eet les
   enregistrements URL, texte et Wi-Fi, et affiche un aper\u00e7u de chacun. Le
   reste est pr\u00e9sent\u00e9 sous forme d'octets bruts.

   Touchez Enregistrer pour conserver le badge, ou Ignorer pour fermer la
   feuille sans rien inscrire dans la Biblioth\u00e8que.

![La feuille Scan en attente d'un badge](hexdocs:asset/b9922ff72601d007f508e4b11a31c7cd3215b8115dfd0ab2da6a584f98bbacb7.png)

**La feuille Scan, en attente d'un badge \u00e0 port\u00e9e**

> **Avertissement\u00a0: Une lecture partielle ressemble \u00e0 une r\u00e9ussite**
>
> Les badges dot\u00e9s d'une zone prot\u00e9g\u00e9e par mot de passe r\u00e9pondent \u00e0 la
> premi\u00e8re partie de la lecture et refusent le reste. Fixture App affiche
> ce qu'il a obtenu et indique \u00ab Enregistrements incomplets \u00bb sous le nom
> du badge. Cherchez cette mention avant de vous fier \u00e0 la lecture d'un
> badge de contr\u00f4le d'acc\u00e8s.

> **Conseil\u00a0:** Activez R\u00e9glages > Scan > Garder la feuille ouverte pour lire plusieurs
> badges \u00e0 la suite. La Biblioth\u00e8que regroupe tout ce qui provient de
> cette session sous un m\u00eame titre.

## Apr\u00e8s la lecture

Les badges enregistr\u00e9s arrivent dans la Biblioth\u00e8que, du plus r\u00e9cent au
plus ancien, avec le type de puce et l'heure de la lecture sous le nom.
En toucher un ouvre D\u00e9tail du badge, qui affiche les octets bruts \u00e0 c\u00f4t\u00e9
des enregistrements d\u00e9cod\u00e9s.

![Une lecture termin\u00e9e affichant trois enregistrements NDEF](hexdocs:asset/b9922ff72601d007f508e4b11a31c7cd3215b8115dfd0ab2da6a584f98bbacb7.png)

Renommer un badge ne change que ce que vous voyez dans la Biblioth\u00e8que.
Rien n'est r\u00e9\u00e9crit sur le badge lui-m\u00eame tant que vous n'utilisez pas la
feuille \u00c9criture, qui est une proc\u00e9dure distincte.

## Si la lecture n'aboutit pas

Le lecteur r\u00e9essaie de lui-m\u00eame. Les deux premi\u00e8res tentatives passent
inaper\u00e7ues, \u00e0 environ une seconde d'intervalle. \u00c0 partir de la
troisi\u00e8me, la feuille rend compte de ce qu'elle fait :

3. \u00ab Recherche en cours \u00bb s'affiche dans la ligne d'\u00e9tat et le tic
   s'arr\u00eate.
4. Le lecteur repasse \u00e0 une fr\u00e9quence d'interrogation plus lente.
5. La session se termine sur \u00ab Badge perdu avant la fin de la lecture \u00bb.

Une lecture qui atteint la cinqui\u00e8me tentative deux fois de suite vient
en g\u00e9n\u00e9ral du badge, pas du t\u00e9l\u00e9phone.
[Quand un scan \u00e9choue](hexdocs:page/guide/troubleshooting.md) passe en revue les causes
dans l'ordre o\u00f9 il vaut la peine de les v\u00e9rifier.
