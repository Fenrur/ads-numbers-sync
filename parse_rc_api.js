/**
 * Récupération des données RevenueCat via l'API officielle V2.
 *
 * Remplace parse_trial_data.js (cookies) et parse_refund_data.js (cookies).
 * Expose 3 fonctions avec la même signature pour compatibilité avec sync_all_data.js :
 *   - fetchAndParseTrialData(startDate, endDate)  → trials, converted, pending, abandoned, new customers par jour
 *   - fetchDailyRefunds()                         → { 'YYYY-MM-DD': refundCount } (90j)
 *   - fetchDailyDirectSubs()                      → { 'YYYY-MM-DD': directSubCount } (30j)
 *
 * Charts V2 utilisés :
 *   - charts/customers_new            → measure 0 = New Customers
 *   - charts/trial_conversion_rate    → measure 0 = Trial Starts, 1 = Conversions, 2 = Expirations, 3 = Pending
 *   - charts/refund_rate              → measure 1 = Refunded Transactions
 *   - charts/actives_new              → measure 2 = Direct Subscriptions
 *
 * Doc API V2 : https://www.revenuecat.com/docs/api-v2
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'rc_api_config.json'), 'utf8'));
const API_KEY = config.api_key_v2;
const PROJECT_ID = config.project_id;
const BASE_URL = config.base_url || 'https://api.revenuecat.com/v2';

/**
 * Appelle un chart V2 et retourne le payload JSON complet.
 */
function fetchChart(chartName, startDate, endDate, resolution = 'day') {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({ start_date: startDate, end_date: endDate, resolution });
        const url = `${BASE_URL}/projects/${PROJECT_ID}/charts/${chartName}?${params.toString()}`;
        https.get(url, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Accept': 'application/json',
            },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} on ${chartName}: ${data.slice(0, 300)}`));
                    return;
                }
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Parse error on ${chartName}: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function tsToDate(ts) {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Récupère trials, conversions, pending, abandoned, new customers par jour.
 *
 * Format de retour identique à l'ancien parse_trial_data.js pour compatibilité :
 *   {
 *     'YYYY-MM-DD': {
 *       date: 'YYYY-MM-DD',
 *       incomplete: boolean,
 *       'New Customers': number,
 *       'Trials': number,
 *       'Converted': number,
 *       'Pending': number,
 *       'Abandoned': number
 *     }
 *   }
 */
async function fetchAndParseTrialData(startDate, endDate) {
    try {
        console.log('🚀 RÉCUPÉRATION DES DONNÉES DE CONVERSION D\'ESSAI (API V2)');
        console.log('='.repeat(70));
        console.log(`📅 Période: ${startDate} → ${endDate}\n`);

        // 2 charts à récupérer en parallèle
        const [convChart, custChart] = await Promise.all([
            fetchChart('trial_conversion_rate', startDate, endDate),
            fetchChart('customers_new', startDate, endDate),
        ]);

        const cohorts = {};

        // trial_conversion_rate measures: 0=Trial Starts, 1=Conversions, 2=Expirations, 3=Pending, 4=Conv Rate
        const TRIAL_MEASURES = { 0: 'Trials', 1: 'Converted', 2: 'Abandoned', 3: 'Pending' };
        convChart.values.forEach(item => {
            const date = tsToDate(item.cohort);
            if (!cohorts[date]) cohorts[date] = { date, incomplete: !!item.incomplete };
            const name = TRIAL_MEASURES[item.measure];
            if (name) cohorts[date][name] = item.value;
            if (item.incomplete) cohorts[date].incomplete = true;
        });

        // customers_new measure 0 = New Customers
        custChart.values.forEach(item => {
            const date = tsToDate(item.cohort);
            if (!cohorts[date]) cohorts[date] = { date, incomplete: !!item.incomplete };
            if (item.measure === 0) cohorts[date]['New Customers'] = item.value;
        });

        const sortedDates = Object.keys(cohorts).sort();
        let totals = { customers: 0, trials: 0, converted: 0, pending: 0, abandoned: 0 };
        sortedDates.forEach(d => {
            totals.customers += cohorts[d]['New Customers'] || 0;
            totals.trials += cohorts[d]['Trials'] || 0;
            totals.converted += cohorts[d]['Converted'] || 0;
            totals.pending += cohorts[d]['Pending'] || 0;
            totals.abandoned += cohorts[d]['Abandoned'] || 0;
        });

        console.log('📊 RÉSUMÉ DE LA PÉRIODE:');
        console.log('='.repeat(70));
        console.log(`📅 Du ${startDate} au ${endDate} (${sortedDates.length} jours)`);
        console.log(`👥 Total nouveaux customers: ${totals.customers.toLocaleString()}`);
        console.log(`🔥 Total nouveaux trials: ${totals.trials}`);
        console.log(`✅ Total convertis: ${totals.converted}`);
        console.log(`⏳ Total en attente: ${totals.pending}`);
        console.log(`❌ Total abandonnés: ${totals.abandoned}`);
        if (totals.trials > 0) {
            console.log(`🎯 Taux de conversion global: ${(totals.converted / totals.trials * 100).toFixed(2)}%`);
        }

        // Sauvegarde CSV (même comportement que l'ancien)
        const csvDir = path.join(__dirname, 'archive', 'data', 'trial_conversion');
        if (!fs.existsSync(csvDir)) fs.mkdirSync(csvDir, { recursive: true });
        const csvPath = path.join(csvDir, `trial_conversion_${startDate}_to_${endDate}.csv`);
        const csvLines = ['date,incomplete,new_customers,trials,converted,pending,abandoned'];
        sortedDates.forEach(d => {
            const c = cohorts[d];
            csvLines.push([d, c.incomplete, c['New Customers'] || 0, c['Trials'] || 0, c['Converted'] || 0, c['Pending'] || 0, c['Abandoned'] || 0].join(','));
        });
        fs.writeFileSync(csvPath, csvLines.join('\n'));
        console.log(`💾 Données CSV sauvegardées: ${csvPath}`);

        return cohorts;
    } catch (e) {
        console.error('❌ Erreur fetchAndParseTrialData (API V2):', e.message);
        return null;
    }
}

/**
 * Récupère les refunds quotidiens (90 derniers jours).
 * Retourne { 'YYYY-MM-DD': refundCount, ... }
 *
 * Source : chart V2 `refund_rate`, measure 1 = Refunded Transactions.
 */
async function fetchDailyRefunds() {
    try {
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
        const endDateStr = now.toISOString().slice(0, 10);
        const startDateStr = startDate.toISOString().slice(0, 10);

        console.log('💸 Récupération des refunds quotidiens (API V2)...');
        console.log(`📅 Période: ${startDateStr} → ${endDateStr}`);

        const chart = await fetchChart('refund_rate', startDateStr, endDateStr);
        const dailyRefunds = {};
        chart.values.forEach(v => {
            if (v.measure === 1) {
                const date = tsToDate(v.cohort);
                dailyRefunds[date] = v.value;
            }
        });

        const total = Object.values(dailyRefunds).reduce((a, b) => a + b, 0);
        console.log(`✅ ${Object.keys(dailyRefunds).length} jours, ${total} refunds total`);
        return dailyRefunds;
    } catch (e) {
        console.error('❌ Erreur fetchDailyRefunds (API V2):', e.message);
        return null;
    }
}

/**
 * Récupère les direct subs quotidiens (30 derniers jours).
 * Retourne { 'YYYY-MM-DD': count, ... }
 *
 * Source : chart V2 `actives_new`, measure 2 = Direct Subscriptions.
 */
async function fetchDailyDirectSubs() {
    try {
        const now = new Date();
        const startDate = new Date();
        startDate.setDate(now.getDate() - 30);
        const endDateStr = now.toISOString().slice(0, 10);
        const startDateStr = startDate.toISOString().slice(0, 10);

        console.log('💳 Récupération des direct subs quotidiens (API V2)...');
        console.log(`📅 Période: ${startDateStr} → ${endDateStr}`);

        const chart = await fetchChart('actives_new', startDateStr, endDateStr);
        const dailySubs = {};
        chart.values.forEach(v => {
            if (v.measure === 2) {
                const date = tsToDate(v.cohort);
                dailySubs[date] = v.value;
            }
        });

        const total = Object.values(dailySubs).reduce((a, b) => a + b, 0);
        console.log(`✅ ${Object.keys(dailySubs).length} jours, ${total} direct subs total`);
        return dailySubs;
    } catch (e) {
        console.error('❌ Erreur fetchDailyDirectSubs (API V2):', e.message);
        return null;
    }
}

module.exports = { fetchAndParseTrialData, fetchDailyRefunds, fetchDailyDirectSubs };

// Exécution directe pour test
if (require.main === module) {
    (async () => {
        const today = new Date().toISOString().slice(0, 10);
        const start = new Date(); start.setDate(start.getDate() - 30);
        const startStr = start.toISOString().slice(0, 10);

        console.log('\n=== TEST 1 : fetchAndParseTrialData ===\n');
        const trials = await fetchAndParseTrialData(startStr, today);
        if (trials) {
            console.log('\nÉchantillon (3 derniers jours) :');
            Object.values(trials).slice(-3).forEach(c => console.log(JSON.stringify(c)));
        }

        console.log('\n=== TEST 2 : fetchDailyRefunds ===\n');
        const refunds = await fetchDailyRefunds();
        if (refunds) {
            console.log('Échantillon :');
            Object.entries(refunds).slice(-5).forEach(([d, v]) => console.log(`  ${d}: ${v} refunds`));
        }

        console.log('\n=== TEST 3 : fetchDailyDirectSubs ===\n');
        const subs = await fetchDailyDirectSubs();
        if (subs) {
            console.log('Échantillon :');
            Object.entries(subs).slice(-5).forEach(([d, v]) => console.log(`  ${d}: ${v} direct subs`));
        }
    })();
}
