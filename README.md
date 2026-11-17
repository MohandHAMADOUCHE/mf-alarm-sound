# MF Alarm Sound

Extension MF Alarm Sound : alerte sonore + popup Ack quand des pastilles d’alarme apparaissent sur une page Overview déjà ouverte et filtrée.

À l’activation, la veille est liée **à cet onglet uniquement** (permission site demandée une fois).

## Prérequis

- Firefox 142+ (ou Edge / Chromium)
- Un onglet Overview déjà ouvert et filtré comme en exploitation

## Installation

```bash
./scripts/pack.sh
```

Version unique : fichier `VERSION` (stampée dans les 2 manifests au pack).

| Navigateur | Fichier |
|---|---|
| Firefox | `dist/mf-alarm-sound-*.xpi` via `about:debugging` |
| Edge / Chrome | dossier `dist/chromium` (mode développeur) |

Puis : Overview au premier plan → icône de l’extension → **Activer**.

Firefox : le bouton se place dans la barre d’outils (`default_area: navbar`). Les fenêtres privées restent à autoriser une fois dans le gestionnaire de modules (ou à l’install fichier / AMO — pas via `about:debugging` temporaire).

## Comportement

- Alerte sur les pastilles apparues depuis moins de 10 minutes (Erreur / Expiré / Warning, réglables)
- Intervalle du bip, son, volume : onglet Réglages
- **Ack** : met en sourdine les alarmes affichées ; une **nouvelle** alarme → son + popup
- La veille suit **un seul onglet** ; les autres pages du même site sont ignorées
- **Onglet fantôme** : si l’onglet de veille est fermé, il est recréé en arrière-plan. L’URL / les apps du filtre sont resynchronisées dès qu’elles changent sur l’onglet de veille. À l’alarme → popup seulement ; **Ouvrir MF** / **Ack** ramène l’onglet au premier plan
- Fin d’alarme : fermeture automatique de la popup d’alerte

Sources audio (CC0) : `SOUNDS.md`.
