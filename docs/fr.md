# Shinobi

Amène dans Gladys les caméras d'un serveur [Shinobi](https://shinobi.video/) (l'enregistreur vidéo
réseau auto-hébergé) : leur image, le mouvement détecté par Shinobi, les objets vus par un plugin de
détection d'objets, leur mode (surveillance, enregistrement, désactivée) et leur état en ligne. Les
détections en direct de Shinobi lancent des scènes, avec l'image du moment, qu'une scène peut vous
envoyer. Les scènes peuvent aussi passer une caméra en enregistrement, ou la remettre en surveillance
seule.

Testée contre un vrai serveur Shinobi en Docker (l'image officielle d'octobre 2026) avec une caméra
réseau simulée et la détection de mouvement intégrée de Shinobi, pas encore sur une installation en
service avec de vraies caméras, ni avec un plugin de détection d'objets : vos retours sont les
bienvenus sur [GitHub](https://github.com/guim31/gladys-shinobi/issues) ou sur le forum Gladys.

## Ce qu'il faut

- Gladys 5.1 ou plus récent.
- Shinobi, joignable depuis Gladys sur son port web (8080 par défaut). Un Shinobi à jour est
  préférable : les détections en direct ont été testées sur le Shinobi d'octobre 2026.
- Les caméras (moniteurs) déjà ajoutées dans Shinobi, avec :
  - l'**API JPEG** activée (réglages du moniteur, section JPEG API) : Gladys y lit les images ;
  - le **détecteur** activé, avec la détection de mouvement intégrée de Shinobi, pour **Mouvement** ;
  - un plugin de détection d'objets (Tensorflow, YOLO, DeepStack…) connecté à Shinobi et la détection
    d'objets activée pour le moniteur, pour **Objet détecté**. Le détecteur intégré de Shinobi ne voit
    que le mouvement.
- Une **clé d'API** de votre compte Shinobi. Dans Shinobi, cliquez sur votre nom d'utilisateur (en
  haut à gauche), puis **API**, et ajoutez une clé : IP `0.0.0.0` (ou l'adresse de Gladys), avec les
  permissions de voir et contrôler les moniteurs, voir les instantanés, et **Can Authenticate
  Websocket** (détections en direct).
- La **clé de groupe** de votre compte : dans Shinobi, votre nom d'utilisateur, puis **Paramètres**
  (Group Key).

## Installation

1. Dans Gladys, ouvrez **Intégrations**, trouvez **Shinobi** et installez-la.
2. Dans son onglet **Configuration**, renseignez :
   - **Adresse de Shinobi** : l'adresse de l'ordinateur où tourne Shinobi, ex. `192.168.1.20`. Sans
     port, 8080 est utilisé ; ajoutez `:port` s'il a été changé, ou `https://` derrière un proxy
     inverse.
   - **Clé d'API** et **Clé de groupe** : voir plus haut.
   - **Rafraîchissement des images** : fréquence d'envoi de l'image de chaque caméra à Gladys (de 10
     secondes à 15 minutes, 1 minute par défaut). Une détection en envoie aussi une aussitôt.
   - **Fin d'une détection** : Shinobi envoie chaque détection, jamais sa fin. **Mouvement** et **Objet
     détecté** repassent à 0 après ce délai sans nouvelle détection (30 secondes par défaut). Les
     déclencheurs suivent le même délai : une détection relance une scène une fois ce délai écoulé.
   - **Langue des noms** : la langue des noms de fonctionnalités donnés à l'ajout d'une caméra.
3. Enregistrez, puis ouvrez l'onglet **Découverte** : un appareil par caméra. Ajoutez celles que vous
   voulez.
4. **Vérifier la connexion** montre ce que lit l'intégration : si les détections arrivent en direct,
   chaque caméra, son mode, si elle est en ligne, et ce qui manque (API JPEG désactivée, pas de
   détecteur).

## Les appareils Gladys

Chaque moniteur Shinobi devient une caméra Gladys, nommée comme dans Shinobi, avec :

| Fonctionnalité    | Ce que c'est                                                                         |
| ----------------- | ------------------------------------------------------------------------------------ |
| **Image**         | L'image de la caméra, envoyée au rythme choisi et aussitôt lors d'une détection.     |
| **Mouvement**     | 1 quand le détecteur de mouvement de Shinobi a vu du mouvement à l'instant, sinon 0. |
| **Objet détecté** | 1 quand un plugin a vu un objet à l'instant, sinon 0. Si le moniteur en a un.        |
| **Mode**          | Surveillance, Enregistrement, En veille ou Désactivée. Une liste : modifiable.       |

L'arrivée du flux se voit sur l'appareil lui-même : une caméra dont le flux est perdu apparaît
injoignable dans Gladys (et déclenche **Shinobi : caméra hors ligne**). **Mode** est une liste à
dessein, jamais un interrupteur qu'un assistant vocal basculerait par erreur. Un instantané Shinobi trop lourd est réduit dans l'intégration pour tenir dans Gladys (150 Ko
par image).

## Widget du tableau de bord

**Caméra Shinobi** affiche l'image d'une caméra, le mouvement, les objets vus à l'instant (ex.
« person, car »), le mode et l'état en ligne, et deux boutons : **Enregistrer** (ou **Surveillance
seule** pendant l'enregistrement) et **Nouvelle image**.

## Scènes

### Déclencheurs

- **Shinobi : mouvement détecté** : le détecteur de mouvement de Shinobi voit du mouvement sur une
  caméra. Filtres : la caméra (vide = toutes) et la région (un nom de région dessinée dans Shinobi,
  vide = toutes). Variables : le nom de la caméra, la région (vide pour toute l'image) et la confiance
  en % (la part de l'image qui a changé). L'image du moment est envoyée d'abord à Gladys.
- **Shinobi : objet détecté** : un plugin de détection d'objets voit un objet. Filtres : la caméra et
  l'objet (étiquette, comme le plugin la nomme : `person`, `car`, `dog`…). Variables : le nom de la
  caméra, l'objet et la confiance en %. Un événement par objet vu.
- **Shinobi : caméra hors ligne** : une caméra en surveillance ou en enregistrement perd son flux
  depuis 30 secondes, ou Shinobi lui-même ne répond plus. Pas déclenché pour une caméra désactivée ou
  en veille dans Shinobi, ni pour le redémarrage qui suit un changement de mode.

### Actions

- **Shinobi : enregistrer ou surveiller** : **Enregistrement** passe une caméra en enregistrement
  continu, **Surveillance seule** la remet en surveillance seule (Shinobi continue d'enregistrer sur
  détection si le moniteur est réglé ainsi). La clé d'API doit avoir la permission de contrôler les
  moniteurs.

L'action du cœur **Envoyer une image de caméra** envoie la dernière image d'une caméra : juste après
**Shinobi : mouvement détecté** ou **Shinobi : objet détecté**, c'est l'image de ce moment.

### Idées de scènes

- **Quelqu'un à la porte** : **Shinobi : objet détecté**, caméra « Entrée », objet `person` →
  **Envoyer une image de caméra** de cette caméra sur votre téléphone, avec
  `{{triggerEvent.data.score}}` % dans le texte.
- **Mouvement dans l'allée la nuit** : **Shinobi : mouvement détecté**, région `driveway` → allumer
  l'éclairage extérieur cinq minutes.
- **Enregistrer en votre absence** : tout le monde quitte la maison → **Shinobi : enregistrer ou
  surveiller**, Enregistrement, sur la caméra de l'entrée ; Surveillance seule au retour.
- **Caméra perdue** : **Shinobi : caméra hors ligne** → envoyer un message avec le nom de la caméra.

## Dépannage

- **« Shinobi ne répond pas à cette adresse »** : ouvrez `http://<adresse>:8080` dans un navigateur.
  Vérifiez le port et qu'aucun pare-feu ne bloque Gladys.
- **« Quelque chose répond, mais pas comme Shinobi »** : l'adresse ou le port mène à un autre service.
  Saisissez l'adresse de Shinobi, sans chemin de page (un chemin est conservé derrière un proxy
  inverse).
- **« Shinobi refuse la clé d'API ou la clé de groupe »** : recopiez les deux depuis Shinobi ; vérifiez
  l'IP autorisée pour la clé (`0.0.0.0` pour toutes).
- **« Pas de détections en direct : donnez à la clé d'API la permission Can Authenticate
  Websocket »** : modifiez la clé dans Shinobi (nom d'utilisateur → API). Sans elle, les états sont
  lus une fois par minute et aucune détection n'arrive à Gladys.
- **« API JPEG désactivée »** : activez l'API JPEG dans les réglages du moniteur ; sans elle, Shinobi
  n'a qu'une image de remplacement.
- **Mouvement reste à 0** : le détecteur du moniteur est désactivé, ou sa sensibilité trop haute pour
  ce qui bouge (réglages du détecteur dans Shinobi). La liste d'événements de Shinobi montre s'il
  détecte.
- **Un proxy inverse** : il doit laisser passer les WebSockets sur `/socket.io/`.
- **Plus de détails** : les logs de l'intégration (Intégrations → Shinobi → Logs) ; passez `LOG_LEVEL`
  à `debug` pour voir chaque requête (jamais avec la clé).

## Limites

- Pas de vidéo en direct : Gladys affiche des images, envoyées au rythme choisi (Gladys garde 12
  images par minute et par caméra au plus). Le direct et les enregistrements se regardent dans
  Shinobi.
- Shinobi envoie les détections, pas leur fin : **Mouvement** et **Objet détecté** restent actifs le
  délai choisi après la dernière.
- Régions et étiquettes se filtrent telles qu'écrites dans Shinobi : les filtres de scène ne
  comparent que du texte.
- Désactiver une caméra se fait par la liste **Mode** ou dans Shinobi, pas par une action de scène.
- Les enregistrements passés, l'historique des événements, le PTZ et les timelapses ne sont pas
  couverts.
- Les détections en direct demandent un Shinobi récent : l'image 2021 de Docker Hub ne les envoie pas
  (les états sont alors lus chaque minute).
- Un groupe Shinobi (une clé de groupe) par intégration.
- Développée sans le matériel : vos retours sont les bienvenus. Testée avec l'image officielle de
  Shinobi en Docker et une caméra simulée ; les objets ont été simulés par l'API de Shinobi lui-même,
  sans plugin.

Cette intégration n'est pas affiliée à Shinobi Systems.
