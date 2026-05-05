#!/usr/bin/env node
const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration - Chargée depuis tiktok_api_config.json
const CONFIG_FILE = path.join(__dirname, 'tiktok_api_config.json');

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('❌ Fichier tiktok_api_config.json non trouvé');
        console.error('   Créez ce fichier avec: app_id, app_secret, access_token, advertiser_id');
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    console.log('✅ Configuration TikTok API chargée');
    console.log(`   Advertiser ID: ${config.advertiser_id}`);
    return config;
}

// Fonction pour faire une requête GET à l'API TikTok
function makeApiRequest(endpoint, params, accessToken) {
    return new Promise((resolve, reject) => {
        const queryString = Object.entries(params)
            .map(([key, value]) => {
                const encodedValue = typeof value === 'object'
                    ? encodeURIComponent(JSON.stringify(value))
                    : encodeURIComponent(value);
                return `${key}=${encodedValue}`;
            })
            .join('&');

        const url = `https://business-api.tiktok.com/open_api/v1.3${endpoint}?${queryString}`;

        const options = {
            method: 'GET',
            headers: {
                'Access-Token': accessToken
            }
        };

        const req = https.request(url, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve(jsonData);
                } catch (e) {
                    reject(new Error(`Erreur parsing JSON: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// Récupère les données TikTok pour une date spécifique
async function fetchTikTokDataForDate(dateStr, config) {
    try {
        console.log(`📡 Récupération données TikTok pour ${dateStr}...`);

        const params = {
            advertiser_id: config.advertiser_id,
            report_type: 'BASIC',
            dimensions: ['stat_time_day'],
            metrics: ['spend', 'impressions', 'clicks', 'real_time_app_install', 'start_trial'],
            data_level: 'AUCTION_ADVERTISER',
            start_date: dateStr,
            end_date: dateStr
        };

        const response = await makeApiRequest('/report/integrated/get/', params, config.access_token);

        if (response.code !== 0) {
            console.log(`⚠️  Erreur API pour ${dateStr}: ${response.message} (code: ${response.code})`);
            return {
                date: dateStr,
                budget: 0,
                impressions: 0,
                clicks: 0,
                installs: 0,
                trials: 0
            };
        }

        if (!response.data || !response.data.list || response.data.list.length === 0) {
            console.log(`⚠️  Pas de données pour ${dateStr}`);
            return {
                date: dateStr,
                budget: 0,
                impressions: 0,
                clicks: 0,
                installs: 0,
                trials: 0
            };
        }

        const metrics = response.data.list[0].metrics;

        const resultData = {
            date: dateStr,
            budget: metrics.spend ? parseFloat(metrics.spend) : 0,
            impressions: metrics.impressions ? parseInt(metrics.impressions) : 0,
            clicks: metrics.clicks ? parseInt(metrics.clicks) : 0,
            installs: metrics.real_time_app_install ? parseInt(metrics.real_time_app_install) : 0,
            trials: metrics.start_trial ? parseInt(metrics.start_trial) : 0
        };

        console.log(`✅ ${dateStr}: Budget=${resultData.budget}€, Impressions=${resultData.impressions}, Clics=${resultData.clicks}, Installs=${resultData.installs}, Trials=${resultData.trials}`);
        return resultData;

    } catch (error) {
        console.error(`❌ Erreur pour ${dateStr}:`, error.message);
        return null;
    }
}

// Fonction principale pour récupérer les données sur une période
async function fetchAndParseTikTokData(startDate, endDate) {
    try {
        const config = loadConfig();

        console.log('🚀 Démarrage récupération données TikTok Ads (API officielle)...');
        console.log(`📅 Période: ${startDate} → ${endDate}`);

        const results = [];
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T23:59:59Z');

        for (let current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
            const dateStr = current.toISOString().split('T')[0];
            const dailyData = await fetchTikTokDataForDate(dateStr, config);

            if (dailyData) {
                results.push(dailyData);
            }

            // Pause entre les requêtes pour respecter les rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`\n📊 RÉCAPITULATIF - ${results.length} jours récupérés:`);
        results.forEach(day => {
            console.log(`   ${day.date}: Budget=${day.budget}€, Impressions=${day.impressions}, Clics=${day.clicks}`);
        });

        return results;

    } catch (error) {
        console.error('❌ Erreur générale:', error.message);
        throw error;
    }
}

// Export pour utilisation dans d'autres scripts
module.exports = {
    fetchAndParseTikTokData,
    fetchTikTokDataForDate,
    loadConfig
};

// Exécution directe
if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.length >= 2) {
        const startDate = args[0];
        const endDate = args[1];

        fetchAndParseTikTokData(startDate, endDate)
            .then(results => {
                console.log('\n🎉 Récupération terminée !');

                const dir = 'archive/data/tiktok_data';
                fs.mkdirSync(dir, { recursive: true });
                const filename = `${dir}/tiktok_data_${startDate}_to_${endDate}_${new Date().toISOString().split('T')[0]}.json`;
                fs.writeFileSync(filename, JSON.stringify(results, null, 2));
                console.log(`💾 Données sauvegardées: ${filename}`);
            })
            .catch(error => {
                console.error('💥 Échec:', error.message);
                process.exit(1);
            });
    } else {
        console.log('Usage: node parse_tiktok_data.js YYYY-MM-DD YYYY-MM-DD');
        console.log('Exemple: node parse_tiktok_data.js 2025-12-01 2025-12-09');
    }
}
