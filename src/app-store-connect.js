#!/usr/bin/env node
/**
 * Module pour récupérer les données depuis App Store Connect
 * - Installs : Sales and Trends API (Product Type "1" = premiers téléchargements)
 * - Impressions + Page Views : Analytics Reports API (Discovery and Engagement)
 */

const jwt = require('jsonwebtoken');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Configuration
const CONFIG_FILE = path.join(__dirname, '..', 'asc_api_config.json');

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error('❌ Fichier asc_api_config.json non trouvé');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function generateToken(config) {
    const privateKey = fs.readFileSync(path.join(__dirname, '..', config.key_file), 'utf8');
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
        { iss: config.issuer_id, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' },
        privateKey,
        { algorithm: 'ES256', header: { alg: 'ES256', kid: config.key_id, typ: 'JWT' } }
    );
}

function apiGet(apiPath, token) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.appstoreconnect.apple.com',
            path: apiPath,
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token }
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, data: data }); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Requête GET qui retourne du contenu gzippé (Sales reports)
 */
function apiGetGzip(apiPath, token) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.appstoreconnect.apple.com',
            path: apiPath,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/a-gzip'
            }
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                let content;
                try { content = zlib.gunzipSync(buf).toString(); }
                catch (e) { content = buf.toString(); }
                resolve({ status: res.statusCode, data: content });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function downloadGzip(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadGzip(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                try { resolve(zlib.gunzipSync(buffer).toString('utf8')); }
                catch (e) { resolve(buffer.toString('utf8')); }
            });
        }).on('error', reject);
    });
}

async function apiGetAll(basePath, token) {
    let allData = [];
    let nextUrl = basePath;
    while (nextUrl) {
        const res = await apiGet(nextUrl, token);
        if (res.status !== 200 || !res.data.data) break;
        allData = allData.concat(res.data.data);
        nextUrl = res.data.links && res.data.links.next
            ? res.data.links.next.replace('https://api.appstoreconnect.apple.com', '')
            : null;
    }
    return allData;
}

// ============================================================
// INSTALLS via Sales and Trends API
// ============================================================

/**
 * Récupère les premiers téléchargements via le Sales Report SUMMARY
 * Product Type "1" = App downloads (premiers téléchargements)
 * Retourne { 'YYYY-MM-DD': count, ... }
 */
async function fetchDailyInstalls(config, token) {
    console.log('   🔍 Installs (Sales API)...');

    const dailyInstalls = {};
    const today = new Date();

    // Récupérer les 30 derniers jours (le rapport du jour même n'est jamais dispo)
    for (let daysAgo = 2; daysAgo <= 30; daysAgo++) {
        const date = new Date(today);
        date.setDate(today.getDate() - daysAgo);
        const dateStr = date.toISOString().split('T')[0];

        const params = `filter[frequency]=DAILY&filter[reportDate]=${dateStr}&filter[reportSubType]=SUMMARY&filter[reportType]=SALES&filter[vendorNumber]=${config.vendor_number}`;

        const res = await apiGetGzip(`/v1/salesReports?${params}`, token);

        if (res.status === 404) {
            // Pas encore disponible, on arrête de remonter
            continue;
        }

        if (res.status !== 200) {
            console.log(`   ⚠️  Erreur ${res.status} pour ${dateStr}`);
            continue;
        }

        const lines = res.data.trim().split('\n');
        if (lines.length < 2) continue;

        const headers = lines[0].split('\t');
        const appleIdIdx = headers.indexOf('Apple Identifier');
        const unitsIdx = headers.indexOf('Units');
        const productTypeIdx = headers.indexOf('Product Type Identifier');

        let downloads = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols[appleIdIdx] === config.app_id && cols[productTypeIdx] === '1') {
                downloads += parseInt(cols[unitsIdx]) || 0;
            }
        }

        dailyInstalls[dateStr] = downloads;

        // Petite pause pour le rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const total = Object.values(dailyInstalls).reduce((a, b) => a + b, 0);
    console.log(`   ✅ Installs: ${Object.keys(dailyInstalls).length} jours, ${total} total`);

    return Object.keys(dailyInstalls).length > 0 ? dailyInstalls : null;
}

// ============================================================
// IMPRESSIONS + PAGE VIEWS via Analytics Reports API
// ============================================================

/**
 * Parse un TSV Analytics et retourne les totaux par date, filtrés par Event type
 */
function parseTSVByDateAndEvent(content, eventFilter) {
    const lines = content.trim().split('\n');
    if (lines.length < 2) return {};

    const headers = lines[0].split('\t');
    const dateIdx = headers.findIndex(h => h === 'Date');
    const eventIdx = headers.findIndex(h => h === 'Event');
    const countsIdx = headers.findIndex(h => h === 'Counts');

    if (dateIdx < 0 || eventIdx < 0 || countsIdx < 0) return {};

    const byDate = {};
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        if (cols[eventIdx] !== eventFilter) continue;
        const date = cols[dateIdx];
        const count = parseInt(cols[countsIdx]) || 0;
        byDate[date] = (byDate[date] || 0) + count;
    }

    return byDate;
}

/**
 * Récupère les données d'un Analytics Report par event type
 */
async function fetchAnalyticsReportData(reportRequestIds, reportName, eventFilter, token) {
    for (const reqId of reportRequestIds) {
        const reports = await apiGetAll(
            `/v1/analyticsReportRequests/${reqId}/reports?limit=200`, token
        );
        const report = reports.find(r => r.attributes.name === reportName);
        if (!report) continue;

        const instances = await apiGetAll(
            `/v1/analyticsReports/${report.id}/instances?limit=200`, token
        );
        if (instances.length === 0) continue;

        const merged = {};

        for (const instance of instances) {
            const segs = await apiGet(
                `/v1/analyticsReportInstances/${instance.id}/segments`, token
            );
            if (segs.status !== 200 || !segs.data.data) continue;

            for (const seg of segs.data.data) {
                if (!seg.attributes.url) continue;
                const content = await downloadGzip(seg.attributes.url);
                const byDate = parseTSVByDateAndEvent(content, eventFilter);
                Object.assign(merged, byDate);
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (Object.keys(merged).length > 0) return merged;
    }

    return null;
}

// ============================================================
// FONCTION PRINCIPALE
// ============================================================

/**
 * Récupère toutes les métriques ASC
 * Retourne { installs: {...}, impressions: {...}, pageViews: {...} }
 */
async function fetchDailyASCData() {
    try {
        const config = loadConfig();
        const token = generateToken(config);

        console.log('📱 Récupération données App Store Connect...');

        // 1. Installs via Sales API (données exactes)
        const installs = await fetchDailyInstalls(config, token);

        // 2. Impressions + Page Views via Analytics Reports (données opt-in, approximatives)
        const reportRequestIds = [
            config.ongoing_report_request_id,
            config.snapshot_report_request_id
        ].filter(Boolean);

        let impressions = null;
        let pageViews = null;

        if (reportRequestIds.length > 0) {
            console.log('   🔍 Impressions...');
            impressions = await fetchAnalyticsReportData(
                reportRequestIds,
                'App Store Discovery and Engagement Standard',
                'Impression',
                token
            );
            if (impressions) {
                const total = Object.values(impressions).reduce((a, b) => a + b, 0);
                console.log(`   ✅ Impressions: ${Object.keys(impressions).length} jours, ${total} total`);
            } else {
                console.log('   ⚠️  Pas de données impressions');
            }

            console.log('   🔍 Vues produit...');
            pageViews = await fetchAnalyticsReportData(
                reportRequestIds,
                'App Store Discovery and Engagement Standard',
                'Page view',
                token
            );
            if (pageViews) {
                const total = Object.values(pageViews).reduce((a, b) => a + b, 0);
                console.log(`   ✅ Vues produit: ${Object.keys(pageViews).length} jours, ${total} total`);
            } else {
                console.log('   ⚠️  Pas de données vues produit');
            }
        }

        return { installs, impressions, pageViews };

    } catch (error) {
        console.error('❌ Erreur récupération données ASC:', error.message);
        return { installs: null, impressions: null, pageViews: null };
    }
}

module.exports = { fetchDailyASCData, generateToken, loadConfig };

// Exécution directe pour test
if (require.main === module) {
    fetchDailyASCData().then(data => {
        ['installs', 'impressions', 'pageViews'].forEach(key => {
            if (data[key]) {
                console.log(`\n📊 ${key} par jour:`);
                Object.keys(data[key]).sort().forEach(date => {
                    console.log(`   ${date}: ${data[key][date]}`);
                });
            }
        });
        console.log('\n🎉 Terminé !');
    });
}
