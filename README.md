# Ads Numbers Sync

Automatisation Node.js qui synchronise **5 sources de données** (TikTok Ads, RevenueCat, App Store Connect, PostHog, Google Sheets) dans une feuille Google Sheets pour piloter ses campagnes ads quotidiennement.

> Initialement développée pour [Punchlines](https://punchlines.app) (app iOS d'affirmations positives), réutilisable pour n'importe quelle app freemium qui fait du TikTok Ads + RevenueCat.

## 📊 Ce que ça récupère

| Source | Données | Fréquence |
|--------|---------|-----------|
| **TikTok Ads API** | Spend, Impressions, Clics, Installs, Trials par jour et par campagne | Quotidien |
| **RevenueCat API V2** | Trials lancés, Converted, Pending, Abandoned, Direct subs, Refunds | Quotidien |
| **App Store Connect** | Installs (Sales API), Impressions, Vues fiche produit (Analytics Reports) | Quotidien |
| **PostHog** | First opens, Paywall views, Accept/Decline wall, Cohortes rétention J7/J30 | Quotidien |
| **Google Sheets** | Écriture de tout dans la feuille "Daily numbers" + onglet "Cohortes" | Sortie |

## 📋 Template Google Sheet (à dupliquer)

👉 **[Faire une copie du template](https://docs.google.com/spreadsheets/d/1mzCr-gAH-N9vmIT5K_87EBuyIvsXQQMhoHJlTDkg0rw/copy)**

Ce template contient tous les onglets et formules attendus par les scripts (Daily numbers, Dashboard, Cohortes, History). Tu cliques, ça crée une copie dans ton propre Drive, et tu n'as plus qu'à connecter ton service account dessus (cf. étape Google Sheets ci-dessous).

> Lien partagé public en lecture seule : [voir le template](https://docs.google.com/spreadsheets/d/1mzCr-gAH-N9vmIT5K_87EBuyIvsXQQMhoHJlTDkg0rw/edit?usp=sharing)

## 🚀 Installation

```bash
git clone https://github.com/harryjmg/ads-numbers-sync.git
cd ads-numbers-sync
npm install
```

## 🔑 Configuration (5 configs à créer)

Copie les fichiers d'exemple à la racine et remplis avec tes vraies clés :

```bash
cp examples/sync_config.example.json sync_config.json
cp examples/tiktok_api_config.example.json tiktok_api_config.json
cp examples/rc_api_config.example.json rc_api_config.json
cp examples/asc_api_config.example.json asc_api_config.json
cp examples/posthog_config.example.json posthog_config.json
```

### 1. Google Sheets (`sync_config.json` + `service-account.json`)

- **Duplique le [template Google Sheet](https://docs.google.com/spreadsheets/d/1mzCr-gAH-N9vmIT5K_87EBuyIvsXQQMhoHJlTDkg0rw/copy)** dans ton Drive
- Crée un **service account** Google Cloud → télécharge sa clé JSON → place-la à la racine sous le nom `service-account.json`
- Active l'API Google Sheets dans le projet GCP
- **Partage ta copie du sheet** avec l'email du service account (en tant qu'éditeur)
- Récupère l'ID du sheet dans son URL (`docs.google.com/spreadsheets/d/{SHEET_ID}/edit`)
- Renseigne `sync_config.json` :
  ```json
  {
    "sheet_id": "ton_sheet_id_ici",
    "sheet_name": "Daily numbers",
    "service_account_file": "service-account.json"
  }
  ```

**Structure attendue du Google Sheet** (onglet "Daily numbers") :

| Col | Contenu |
|-----|---------|
| A | Date (DD/MM/YYYY) |
| B | Spend TikTok |
| C | Changelog (manuel) |
| D-G | Impressions / Clics / Installs / Trials TikTok |
| H-J | Impressions / Vues produit / Installs ASC |
| K-N | First open / Paywall views / Accept wall / Decline wall (PostHog) |
| O-S | Installs / Trials / Converted / Pending / Abandoned (RevenueCat) |
| T | Direct subs |
| U | Refunded |

Headers ligne 11, données ligne 12+. Les colonnes sont détectées par leur libellé donc l'ordre exact est flexible.

### 2. TikTok Ads (`tiktok_api_config.json`)

- Crée une app sur [TikTok for Business Developers](https://business-api.tiktok.com/)
- Génère un `access_token` long-lived avec scope `Ads management - Read`
- Récupère ton `advertiser_id` dans Ads Manager

```json
{
  "app_id": "...",
  "app_secret": "...",
  "access_token": "...",
  "advertiser_id": "..."
}
```

### 3. RevenueCat API V2 (`rc_api_config.json`)

- Va sur [RevenueCat → Project Settings → API Keys](https://app.revenuecat.com/)
- Crée une **clé V2** avec ces permissions cochées (READ uniquement) :
  - `customer:read`
  - `charts_metrics:charts:read` ⭐ (indispensable pour les charts utilisés)
  - `charts_metrics:overview:read`
- Récupère ton `project_id` (commence par `proj`)

```json
{
  "api_key_v2": "sk_...",
  "project_id": "projXXXXXXXX",
  "base_url": "https://api.revenuecat.com/v2"
}
```

> **Note** : ce script utilise les charts V2 publics : `trial_conversion_rate`, `customers_new`, `refund_rate`, `actives_new`. Cohorte par **Trial Start Date** (et non First Seen Date — ça compte comme +5 à 10% sur les chiffres trials/converted).

### 4. App Store Connect (`asc_api_config.json` + `AuthKey_*.p8`)

- Génère une **API Key** App Store Connect dans [Users and Access → Keys](https://appstoreconnect.apple.com/) avec le rôle "Sales and Reports"
- Télécharge le fichier `.p8` et place-le à la racine
- Pour les Analytics Reports (impressions, vues fiche), tu dois avoir créé une **report request ongoing** + récupéré son `report_request_id` (cf. [doc Apple](https://developer.apple.com/documentation/appstoreconnectapi/download_analytics_reports))

```json
{
  "key_id": "ABCDEF1234",
  "issuer_id": "12345678-1234-1234-1234-123456789abc",
  "key_file": "AuthKey_ABCDEF1234.p8",
  "vendor_number": "12345678",
  "app_id": "1234567890",
  "ongoing_report_request_id": "abc...",
  "snapshot_report_request_id": "def..."
}
```

### 5. PostHog (`posthog_config.json`)

- Va sur [PostHog → Settings → Personal API Keys](https://app.posthog.com/settings/user-api-keys)
- Crée une clé avec scope `query:read`
- Récupère ton `project_id` numérique dans Settings → Project

```json
{
  "host": "eu.i.posthog.com",
  "project_id": "123456",
  "api_key": "phx_..."
}
```

> Adapte les `event` names dans `parse_posthog_data.js` selon les events que ton app envoie (`paywall_viewed`, `onboarding_step_viewed`, etc.).

## ▶️ Utilisation

### Run manuel

```bash
./sync_ads.sh
```

ou directement :

```bash
node sync_all_data.js
```

### Automatiser à 5h00 chaque matin (macOS — launchd)

Crée un fichier `~/Library/LaunchAgents/com.your-app.sync-ads.plist` :

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.your-app.sync-ads</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/path/to/ads-numbers-sync/sync_ads.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/ads-numbers-sync</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>5</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/path/to/ads-numbers-sync/logs/sync_ads.log</string>
  <key>StandardErrorPath</key>
  <string>/path/to/ads-numbers-sync/logs/sync_ads_error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

Puis :

```bash
launchctl load ~/Library/LaunchAgents/com.your-app.sync-ads.plist
```

### Automatiser sur Linux — cron

```cron
0 5 * * * cd /path/to/ads-numbers-sync && ./sync_ads.sh >> logs/sync_ads.log 2>&1
```

## 🐛 Troubleshooting

| Erreur | Cause | Solution |
|--------|-------|----------|
| `getaddrinfo ENOTFOUND` | Wifi endormi à 5h | Souvent transitoire, relance le sync à la main |
| `HTTP 401/403 RevenueCat` | Permissions de la clé V2 incomplètes | Vérifier que `charts_metrics:charts:read` est coché |
| `HTTP 401 TikTok` | `access_token` expiré | Régénérer un long-lived token |
| `HTTP 401 ASC` | Clé `.p8` mal placée ou expirée | Vérifier `key_file` dans `asc_api_config.json` |
| Données ASC du jour J manquantes | ASC Sales API a 1j de retard, Analytics Reports 2-3j | Normal, attendre |
| Timeout global 5 min | ASC très lent ou réseau | Augmenter le timeout dans `sync_all_data.js` (chercher `5 * 60 * 1000`) |

## 📁 Structure du projet

```
.
├── sync_all_data.js          # orchestrateur principal
├── parse_tiktok_data.js      # TikTok Ads API
├── parse_rc_api.js           # RevenueCat API V2
├── parse_asc_data.js         # App Store Connect
├── parse_posthog_data.js     # PostHog
├── sync_ads.sh               # script shell wrapper
├── package.json
├── .gitignore
└── examples/                 # configs exemples (placeholder)
    ├── sync_config.example.json
    ├── tiktok_api_config.example.json
    ├── rc_api_config.example.json
    ├── asc_api_config.example.json
    └── posthog_config.example.json
```

## 📝 License

MIT — fais-en ce que tu veux.
