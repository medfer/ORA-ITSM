# ORA ITSM

Outil ITSM léger pour le contrat de **support Microsoft ORA** (via Black Star Iraq, forfait **40 h / mois**) :
gestion des incidents et demandes, **SLA**, **temps passé** et **rapport mensuel**.

- Frontend : HTML / CSS / JavaScript sans framework (`public/`)
- Backend : Node.js 22 + Express (`server/`)
- Base de données : **SQLite** (module intégré `node:sqlite`, aucun module natif à compiler), un seul fichier `/data/ora-itsm.db`
- Déploiement : **Docker** (image unique, base dans un volume)

## Fonctionnalités

| Module | Détail |
|---|---|
| Tickets | Incident, demande de service, changement, problème · priorités P1–P4 · catégories Microsoft (M365, Exchange, Teams, Entra ID, Intune, Azure…) · n° de cas Microsoft · assignation · historique des modifications |
| SLA | Délai de 1re réponse et de résolution par priorité · 24/7 ou heures ouvrées (par défaut dim.–jeu. 08:00–16:00, UTC+3) · **pause** automatique en « Attente client » · états Respecté / À risque (75 %) / Dépassé |
| Temps passé | Saisie par ticket ou hors ticket (réunions, revues) · facturable ou non · formats `1h30`, `45m`, `1,5` |
| Forfait | Suivi en temps réel des heures consommées vs 40 h · alerte à 80 % (paramétrable) · dépassement hors forfait |
| Rapports | Rapport mensuel imprimable / PDF (heures, SLA par priorité, tickets par catégorie/type, détail des interventions, zone de signature) · export CSV (Excel) des temps et des tickets · tendance 12 mois |
| Rôles | **Administrateur** (tout), **Ingénieur** (tickets, temps, rapports), **Client** (ouvre et suit ses tickets, ne voit pas les notes internes) |

## Démarrage rapide avec Docker (serveur)

```bash
git clone <ce dépôt> ora-itsm && cd ora-itsm
cp .env.example .env        # définir ADMIN_EMAIL et ADMIN_PASSWORD
docker compose up -d --build
```

Ouvrir `http://<ip-du-serveur>:8080` et se connecter avec le compte admin défini dans `.env`
(par défaut `admin@ora-itsm.local` / `ChangeMe!2026` — **à changer immédiatement**).

Puis dans **Paramètres** : vérifier le forfait, les heures ouvrées, les délais SLA, et créer les comptes
ingénieurs et le(s) compte(s) client ORA.

### HTTPS (recommandé)

Placer un reverse proxy devant le conteneur, par exemple Caddy (certificat Let's Encrypt automatique) :

```
itsm.votre-domaine.com {
    reverse_proxy 127.0.0.1:8080
}
```

et limiter le port dans `docker-compose.yml` à `"127.0.0.1:8080:8080"`.

### Sauvegardes

La base entière tient dans le volume `ora-data`. Sauvegarde à chaud :

```bash
./scripts/backup.sh /srv/backups/ora-itsm      # garde les 30 dernières
# cron quotidien à 2 h :
# 0 2 * * * cd /opt/ora-itsm && ./scripts/backup.sh /srv/backups/ora-itsm
```

Restauration : arrêter le conteneur, copier le fichier sauvegardé vers `/data/ora-itsm.db` dans le volume, redémarrer.

### Mise à jour

```bash
git pull && docker compose up -d --build
```

Le schéma est créé automatiquement au démarrage ; les données du volume sont conservées.

## Lancement sans Docker (poste de dev)

Prérequis : Node.js ≥ 22.13.

```bash
npm install
npm start          # http://localhost:8080 — base dans ./data/ora-itsm.db
npm test           # tests SLA + API
```

Variables d'environnement : `PORT` (8080), `DATA_DIR` (`./data`), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (utilisées uniquement à la création du premier compte).

## Règles de calcul

- **1re réponse** : premier passage hors du statut « Nouveau » ou première réponse publique d'un ingénieur.
- **Résolution** : passage en « Résolu », « Clôturé » ou « Annulé ». Rouvrir un ticket efface la date de résolution.
- **Pause SLA** : le temps passé en « Attente client » est ajouté à l'échéance de résolution. « Attente Microsoft » ne met pas en pause (engagement du prestataire).
- **Forfait** : seules les saisies *facturables* sont décomptées des 40 h ; le mois est déterminé par la date de l'intervention.
- **Conformité SLA du mois** : réponse = tickets créés dans le mois dont la 1re réponse est acquise ou dépassée ; résolution = tickets résolus dans le mois.

## SLA par défaut (modifiables dans Paramètres)

| Priorité | 1re réponse | Résolution | Calendrier |
|---|---|---|---|
| P1 Critique | 30 min | 4 h | 24/7 |
| P2 Haute | 1 h | 8 h | heures ouvrées |
| P3 Moyenne | 4 h | 24 h (3 j ouvrés) | heures ouvrées |
| P4 Basse | 8 h | 40 h (5 j ouvrés) | heures ouvrées |

## Structure

```
server/index.js   API REST (auth, tickets, temps, rapports, paramètres)
server/db.js      schéma SQLite, paramètres par défaut, compte admin initial
server/sla.js     calcul des échéances (heures ouvrées, pause)
public/           interface web (index.html, app.js, style.css)
test/             tests node:test
Dockerfile, docker-compose.yml, scripts/backup.sh
```
