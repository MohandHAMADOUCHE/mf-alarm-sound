# MF Alarm Sound

Extension MF Alarm Sound : alerte sonore + popup Ack quand des pastilles d’alarme apparaissent sur une page Overview déjà ouverte et filtrée.

À l’activation, la veille est liée **à cet onglet uniquement** (permission site demandée une fois).

## Prérequis

- Firefox 142+ (ou Edge / Chromium)
- Un onglet Overview déjà ouvert et filtré comme en exploitation

## Installation

Firefox (recommandé) : [addons.mozilla.org — MF Alarm Sound](https://addons.mozilla.org/fr/firefox/addon/mf-alarm-sound/)

Dev / Edge :

```bash
./scripts/pack.sh
```

Version unique : fichier `VERSION` (stampée dans les 2 manifests au pack).

| Navigateur | Fichier |
|---|---|
| Firefox | AMO (ci-dessus) ou `dist/mf-alarm-sound-*.xpi` via `about:debugging` |
| Edge / Chrome | dossier `dist/chromium` (mode développeur) |

Puis : Overview au premier plan → icône de l’extension → **Activer**.

Firefox : le bouton se place dans la barre d’outils (`default_area: navbar`). Les fenêtres privées restent à autoriser une fois dans le gestionnaire de modules (ou à l’install fichier / AMO — pas via `about:debugging` temporaire).

## Comportement

- Alerte sur les pastilles apparues depuis moins de 10 minutes (Erreur / Expiré / Warning, réglables)
- Intervalle du bip, son, volume : onglet Réglages
- **Ack** : met en sourdine les alarmes affichées ; une **nouvelle** alarme → son + popup
- La veille suit **un seul onglet** ; les autres pages du même site sont ignorées
- Si l’onglet de veille est fermé alors que la veille est active, un **nouvel onglet** Overview est rouvert en arrière-plan (même URL / filtres, resync dès qu’ils changent). À l’alarme → popup seulement ; **Ouvrir MF** / **Ack** ramène cet onglet au premier plan. Pour le fermer définitivement : désactiver la veille d’abord
- Fin d’alarme : fermeture automatique de la popup d’alerte

Sources audio (CC0) : `SOUNDS.md`.
