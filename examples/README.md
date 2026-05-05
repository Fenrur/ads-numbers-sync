# Examples

Copie chaque `*.example.json` à la racine du projet (sans le `.example`) et remplis avec tes vraies clés.

```bash
cp examples/sync_config.example.json sync_config.json
cp examples/tiktok_api_config.example.json tiktok_api_config.json
cp examples/rc_api_config.example.json rc_api_config.json
cp examples/asc_api_config.example.json asc_api_config.json
cp examples/posthog_config.example.json posthog_config.json
```

Les fichiers à la racine sont gitignored.

Pour le service account Google : télécharge ton fichier JSON depuis Google Cloud Console et place-le à la racine sous le nom `service-account.json` (ou adapte le chemin dans `sync_config.json`).

Pour App Store Connect : place le fichier `.p8` à la racine et adapte `key_file` dans `asc_api_config.json`.
