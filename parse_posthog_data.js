#!/usr/bin/env node
/**
 * Module pour récupérer les données de paywall views depuis PostHog
 * Utilise l'API HogQL pour compter les événements paywall_viewed (source=onboarding)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration PostHog (depuis posthog_config.json — gitignored)
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'posthog_config.json'), 'utf8'));
const POSTHOG_HOST = config.host || 'eu.i.posthog.com';
const PROJECT_ID = config.project_id;
const API_KEY = config.api_key;

/**
 * Effectue une requête POST vers l'API PostHog
 */
function postRequest(path, body) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const options = {
            hostname: POSTHOG_HOST,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Length': Buffer.byteLength(bodyStr)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode, data }));
        });
        req.setTimeout(30000, () => { req.destroy(new Error('PostHog request timeout (30s)')); });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

/**
 * Récupère les paywall_viewed quotidiens (derniers 30 jours, source=onboarding)
 * Retourne { 'YYYY-MM-DD': count, ... } ou null en cas d'erreur
 */
async function fetchDailyPaywallViews() {
    try {
        console.log('📊 Récupération des paywall views depuis PostHog...');

        // Cache-bust: use count(DISTINCT person_id) instead of count() + unique query string
        const hogqlQuery = "SELECT toDate(timestamp) as day, count(DISTINCT person_id) as cnt FROM events WHERE event = 'paywall_viewed' AND JSONExtractString(properties, 'source') = 'onboarding' AND timestamp >= today() - interval 30 day GROUP BY day ORDER BY day";

        const response = await postRequest(`/api/projects/${PROJECT_ID}/query/`, {
            query: {
                kind: 'HogQLQuery',
                query: hogqlQuery
            },
            refresh: 'blocking'
        });

        if (response.statusCode !== 200) {
            console.log('❌ Erreur HTTP PostHog:', response.statusCode);
            try {
                const errorBody = JSON.parse(response.data);
                console.log('   Détails:', errorBody.detail || errorBody.message || response.data.substring(0, 200));
            } catch (e) {
                console.log('   Réponse:', response.data.substring(0, 200));
            }
            return null;
        }

        const data = JSON.parse(response.data);

        if (!data.results || !Array.isArray(data.results)) {
            console.log('❌ Format de réponse PostHog inattendu');
            console.log('   Response keys:', Object.keys(data));
            console.log('   Raw (200 chars):', response.data.substring(0, 200));
            return null;
        }

        console.log(`   ${data.results.length} lignes reçues de PostHog`);

        const dailyPaywallViews = {};
        for (const row of data.results) {
            // row = [day, cnt]
            const day = row[0];   // 'YYYY-MM-DD'
            const cnt = row[1];   // nombre
            if (day && cnt !== undefined) {
                dailyPaywallViews[day] = cnt;
            }
        }

        const totalViews = Object.values(dailyPaywallViews).reduce((a, b) => a + b, 0);
        console.log(`✅ ${Object.keys(dailyPaywallViews).length} jours, ${totalViews} paywall views total`);

        return dailyPaywallViews;

    } catch (error) {
        console.error('❌ Erreur récupération paywall views PostHog:', error.message);
        return null;
    }
}

/**
 * Récupère les accept wall quotidiens
 * = users qui acceptent le trial depuis l'onboarding (step=trial_confirmation)
 * Retourne { 'YYYY-MM-DD': count, ... } ou null
 */
async function fetchDailyAcceptWall() {
    try {
        console.log('✅ Récupération des accept wall depuis PostHog...');

        const hogql = "SELECT toDate(timestamp) as day, count(DISTINCT person_id) as cnt FROM events WHERE event = 'onboarding_step_viewed' AND JSONExtractString(properties, 'step') = 'trial_confirmation' AND timestamp >= today() - interval 30 day GROUP BY day ORDER BY day";

        const response = await postRequest(`/api/projects/${PROJECT_ID}/query/`, {
            query: { kind: 'HogQLQuery', query: hogql },
            refresh: 'blocking'
        });

        if (response.statusCode !== 200) {
            console.log('❌ Erreur HTTP PostHog accept wall:', response.statusCode);
            return null;
        }

        const data = JSON.parse(response.data);
        const dailyAccept = {};
        for (const row of (data.results || [])) {
            if (row[0] && row[1] !== undefined) {
                dailyAccept[row[0]] = row[1];
            }
        }

        const total = Object.values(dailyAccept).reduce((a, b) => a + b, 0);
        console.log(`✅ ${Object.keys(dailyAccept).length} jours, ${total} accept wall total`);
        return dailyAccept;

    } catch (error) {
        console.error('❌ Erreur récupération accept wall PostHog:', error.message);
        return null;
    }
}

/**
 * Récupère les decline paywall quotidiens (source=onboarding)
 * = users qui ferment le paywall et confirment le refus de l'essai gratuit
 * Retourne { 'YYYY-MM-DD': count, ... } ou null
 */
async function fetchDailyDeclineWall() {
    try {
        console.log('🚫 Récupération des decline wall depuis PostHog...');

        const hogql = "SELECT toDate(timestamp) as day, count(DISTINCT person_id) as cnt FROM events WHERE event = 'paywall_decline_confirmed' AND JSONExtractString(properties, 'source') = 'onboarding' AND timestamp >= today() - interval 30 day GROUP BY day ORDER BY day";

        const response = await postRequest(`/api/projects/${PROJECT_ID}/query/`, {
            query: { kind: 'HogQLQuery', query: hogql },
            refresh: 'blocking'
        });

        if (response.statusCode !== 200) {
            console.log('❌ Erreur HTTP PostHog decline wall:', response.statusCode);
            return null;
        }

        const data = JSON.parse(response.data);
        const dailyDecline = {};
        for (const row of (data.results || [])) {
            if (row[0] && row[1] !== undefined) {
                dailyDecline[row[0]] = row[1];
            }
        }

        const total = Object.values(dailyDecline).reduce((a, b) => a + b, 0);
        console.log(`✅ ${Object.keys(dailyDecline).length} jours, ${total} decline wall total`);
        return dailyDecline;

    } catch (error) {
        console.error('❌ Erreur récupération decline wall PostHog:', error.message);
        return null;
    }
}

/**
 * Récupère les first opens quotidiens (nouveaux utilisateurs uniques)
 * = users dont le tout premier onboarding_step_viewed step=welcome est ce jour-là
 * Retourne { 'YYYY-MM-DD': count, ... } ou null
 */
async function fetchDailyFirstOpens() {
    try {
        console.log('📱 Récupération des first opens depuis PostHog...');
        console.log('   (basé sur premier onboarding_step_viewed step=welcome par person_id)');

        const hogql = "SELECT toDate(toString(first_welcome)) as day, count() as cnt FROM (SELECT person_id, min(timestamp) as first_welcome FROM events WHERE event = 'onboarding_step_viewed' AND JSONExtractString(properties, 'step') = 'welcome' GROUP BY person_id HAVING toDate(toString(first_welcome)) >= today() - interval 30 day) GROUP BY day ORDER BY day";

        const response = await postRequest(`/api/projects/${PROJECT_ID}/query/`, {
            query: { kind: 'HogQLQuery', query: hogql },
            refresh: 'blocking'
        });

        if (response.statusCode !== 200) {
            console.log('❌ Erreur HTTP PostHog first opens:', response.statusCode);
            return null;
        }

        const data = JSON.parse(response.data);
        const dailyFirstOpens = {};
        for (const row of (data.results || [])) {
            if (row[0] && row[1] !== undefined) {
                dailyFirstOpens[row[0]] = row[1];
            }
        }

        const total = Object.values(dailyFirstOpens).reduce((a, b) => a + b, 0);
        console.log(`✅ ${Object.keys(dailyFirstOpens).length} jours, ${total} first opens total`);
        return dailyFirstOpens;

    } catch (error) {
        console.error('❌ Erreur récupération first opens PostHog:', error.message);
        return null;
    }
}

/**
 * Exécute une requête HogQL et retourne les résultats
 */
async function hogqlQuery(query) {
    const response = await postRequest(`/api/projects/${PROJECT_ID}/query/`, {
        query: { kind: 'HogQLQuery', query },
        refresh: 'blocking'
    });

    if (response.statusCode !== 200) {
        const err = JSON.parse(response.data);
        throw new Error(`HogQL error: ${err.detail || response.statusCode}`);
    }

    return JSON.parse(response.data).results || [];
}

/**
 * Calcule la rétention pour une cohorte hebdomadaire
 * @param weekStart - Date du lundi (YYYY-MM-DD)
 * @param windowDays - Jour de rétention ciblé (7 ou 30)
 * @param windowMargin - Marge autour du jour (±margin jours)
 * @returns { cohortSize, retainedCount } ou null si la fenêtre n'est pas encore passée
 */
async function fetchCohortRetention(weekStart, windowDays, windowMargin) {
    // Calculer les dates
    const start = new Date(weekStart + 'T00:00:00Z');
    const weekEnd = new Date(start);
    weekEnd.setDate(start.getDate() + 7);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    // La fenêtre de rétention doit être entièrement passée
    // Pour le dernier user de la cohorte (dimanche), sa fenêtre se termine à J+windowDays+windowMargin
    const latestWindowEnd = new Date(weekEnd);
    latestWindowEnd.setDate(weekEnd.getDate() + windowDays + windowMargin);

    // Utiliser UTC pour today (cohérence avec latestWindowEnd qui est en UTC)
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    if (latestWindowEnd > todayUTC) {
        return null; // Fenêtre pas encore passée
    }

    const minDay = windowDays - windowMargin;
    const maxDay = windowDays + windowMargin + 1; // +1 car < exclusive

    // Cohorte = first welcome step (vrais nouveaux users)
    // Rétention = app_opened dans la fenêtre J+N
    const results = await hogqlQuery(`SELECT count(DISTINCT fo.person_id) as cohort_size, count(DISTINCT ret.person_id) as retained FROM (SELECT person_id, min(timestamp) as first_welcome FROM events WHERE event = 'onboarding_step_viewed' AND properties.step = 'welcome' GROUP BY person_id HAVING toDate(toString(first_welcome)) >= toDate('${weekStart}') AND toDate(toString(first_welcome)) < toDate('${weekEndStr}')) fo LEFT JOIN events ret ON ret.person_id = fo.person_id AND ret.event = 'app_opened' AND ret.timestamp >= fo.first_welcome + INTERVAL ${minDay} DAY AND ret.timestamp < fo.first_welcome + INTERVAL ${maxDay} DAY`);

    if (results.length === 0) return null;

    return {
        cohortSize: results[0][0],
        retainedCount: results[0][1]
    };
}

/**
 * Récupère les données de rétention pour toutes les cohortes de la feuille Cohortes
 * @param cohortWeeks - Array de dates de début de semaine ['2026-03-16', '2026-03-23', ...]
 * @returns { 'YYYY-MM-DD': { cohortSize, retainedJ7, retainedJ30 }, ... }
 */
/**
 * Récupère la taille d'une cohorte (nombre de first welcome step dans la semaine)
 * Utilise onboarding_step_viewed (step=welcome) pour ne compter que les vrais nouveaux users
 * (exclut les anciens users qui ont mis à jour et reçu PostHog)
 */
async function fetchCohortSize(weekStart) {
    const start = new Date(weekStart + 'T00:00:00Z');
    const weekEnd = new Date(start);
    weekEnd.setDate(start.getDate() + 7);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const results = await hogqlQuery(`SELECT count(*) FROM (SELECT person_id FROM events WHERE event = 'onboarding_step_viewed' AND properties.step = 'welcome' GROUP BY person_id HAVING toDate(toString(min(timestamp))) >= toDate('${weekStart}') AND toDate(toString(min(timestamp))) < toDate('${weekEndStr}'))`);

    return (results.length > 0 && results[0][0]) ? results[0][0] : 0;
}

async function fetchAllCohortRetention(cohortWeeks) {
    try {
        console.log('📊 Calcul de la rétention par cohorte (PostHog)...');

        const results = {};

        for (const weekStart of cohortWeeks) {
            // Toujours récupérer la taille de la cohorte
            const cohortSize = await fetchCohortSize(weekStart);

            // J7 : fenêtre J+6 à J+8 (±1)
            const j7 = await fetchCohortRetention(weekStart, 7, 1);

            // J30 : fenêtre J+28 à J+32 (±2)
            const j30 = await fetchCohortRetention(weekStart, 30, 2);

            if (cohortSize > 0) {
                results[weekStart] = {
                    cohortSize,
                    retainedJ7: j7 ? j7.retainedCount : null,
                    retainedJ30: j30 ? j30.retainedCount : null,
                };
                const sizeStr = `cohorte=${cohortSize}`;
                const j7Str = j7 ? `J7=${j7.retainedCount} (${(j7.retainedCount/cohortSize*100).toFixed(1)}%)` : 'J7=pending';
                const j30Str = j30 ? `J30=${j30.retainedCount} (${(j30.retainedCount/cohortSize*100).toFixed(1)}%)` : 'J30=pending';
                console.log(`   ${weekStart}: ${sizeStr}, ${j7Str}, ${j30Str}`);
            }

            await new Promise(resolve => setTimeout(resolve, 300));
        }

        console.log(`✅ ${Object.keys(results).length} cohortes avec données`);
        return results;

    } catch (error) {
        console.error('❌ Erreur calcul rétention:', error.message);
        return {};
    }
}

module.exports = { fetchDailyPaywallViews, fetchDailyFirstOpens, fetchDailyAcceptWall, fetchDailyDeclineWall, fetchAllCohortRetention };

// Exécution directe pour test
if (require.main === module) {
    (async () => {
        const data = await fetchDailyPaywallViews();
        if (data) {
            console.log('\n📊 Paywall views par jour:');
            Object.keys(data).sort().forEach(date => {
                console.log(`   ${date}: ${data[date]}`);
            });
        }

        // Test rétention
        console.log('\n');
        const retention = await fetchAllCohortRetention(['2026-03-16', '2026-03-23']);
        console.log('\nRétention:', JSON.stringify(retention, null, 2));

        console.log('\n🎉 Terminé !');
    })();
}
