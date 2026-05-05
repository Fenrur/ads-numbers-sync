#!/usr/bin/env node
/**
 * Script de synchronisation TikTok Ads + RevenueCat → Google Sheets
 * Version single-sheet: toutes les données sur "Daily numbers"
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Configuration depuis sync_config.json (gitignored)
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'sync_config.json'), 'utf8'));
const SHEET_ID = CFG.sheet_id;
const SHEET_NAME = CFG.sheet_name || 'Daily numbers';
const SERVICE_ACCOUNT_FILE = path.isAbsolute(CFG.service_account_file)
    ? CFG.service_account_file
    : path.join(__dirname, CFG.service_account_file);

// Import des modules de données
// RevenueCat : migré du scraping cookies vers l'API V2 officielle (5 mai 2026).
// Anciens scripts conservés dans archive/scripts/cookies-method/.
const { fetchAndParseTrialData, fetchDailyRefunds, fetchDailyDirectSubs } = require('./parse_rc_api.js');
const { fetchAndParseTikTokData } = require('./parse_tiktok_data.js');
const { fetchDailyASCData } = require('./parse_asc_data.js');
const { fetchDailyPaywallViews, fetchDailyFirstOpens, fetchDailyAcceptWall, fetchDailyDeclineWall, fetchAllCohortRetention } = require('./parse_posthog_data.js');

/**
 * Initialise l'authentification Google Sheets
 */
async function initializeAuth() {
    const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
    const auth = new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    console.log('🔑 Authentification Google Sheets...');
    const sheets = google.sheets({ version: 'v4', auth });
    console.log('✅ Authentification réussie');
    return sheets;
}

/**
 * Parse une date DD/MM/YYYY → YYYY-MM-DD
 */
function parseDateFromSheet(dateValue) {
    if (!dateValue) return null;
    const dateStr = dateValue.toString().trim();

    const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) {
        const [_, day, month, year] = match;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) return dateStr;
    return null;
}

/**
 * Convertit un index de colonne en lettre (0=A, 25=Z, 26=AA...)
 */
function getColumnLetter(index) {
    if (index < 26) return String.fromCharCode(65 + index);
    return String.fromCharCode(64 + Math.floor(index / 26)) + String.fromCharCode(65 + (index % 26));
}

/**
 * Lit le sheet et détecte la structure des colonnes via source row + header row
 */
async function analyzeSheet(sheets) {
    console.log('📋 Lecture du tableau...');

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1:Z500`
    });

    const rows = response.data.values || [];

    // Trouver la ligne source (contient "Source ➔") et la ligne d'en-têtes (contient "Jour")
    let sourceRowIndex = -1;
    let headerRowIndex = -1;

    for (let i = 0; i < Math.min(15, rows.length); i++) {
        const row = rows[i] || [];
        const rowText = row.join(' ').toLowerCase();
        if (rowText.includes('source')) sourceRowIndex = i;
        if (rowText.includes('jour')) {
            headerRowIndex = i;
            break;
        }
    }

    if (headerRowIndex === -1) throw new Error('Ligne d\'en-têtes non trouvée');

    const sourceRow = sourceRowIndex >= 0 ? rows[sourceRowIndex] : [];
    const headerRow = rows[headerRowIndex];

    console.log(`✅ En-têtes trouvés ligne ${headerRowIndex + 1}`);

    // Mapper les colonnes en combinant source + header
    const columnMap = {};
    headerRow.forEach((header, index) => {
        const h = (header || '').toString().toLowerCase().trim();
        const source = (sourceRow[index] || '').toString().toLowerCase().trim();

        if (h.includes('jour') || h.includes('date')) {
            columnMap.date = index;
        } else if (source.includes('tiktok')) {
            if (h === 'spent') columnMap.spentTiktok = index;
            else if (h === 'impressions') columnMap.impressionsTiktok = index;
            else if (h.includes('clic')) columnMap.clicksTiktok = index;
            else if (h === 'installs') columnMap.installsTiktok = index;
            else if (h === 'trials') columnMap.trialsTiktok = index;
        } else if (source === 'asc') {
            if (h === 'installs') columnMap.installsASC = index;
            else if (h === 'impressions') columnMap.impressionsASC = index;
            else if (h.includes('vue') || h.includes('page')) columnMap.pageViewsASC = index;
        } else if (source.includes('posthog') || source === 'ph') {
            if (h.includes('paywall') && !h.includes('decline') && !h.includes('accept')) columnMap.paywallViews = index;
            else if (h.includes('accept')) columnMap.acceptWall = index;
            else if (h.includes('decline')) columnMap.declineWall = index;
            else if (h.includes('first') || h.includes('premier') || h.includes('welcome')) columnMap.firstOpens = index;
        } else if (source === 'rc') {
            if (h === 'installs') columnMap.installsRC = index;
            else if (h === 'trials') columnMap.trialsRC = index;
            else if (h === 'converted') columnMap.converted = index;
            else if (h === 'pending') columnMap.pending = index;
            else if (h === 'abandoned') columnMap.abandoned = index;
            else if (h.includes('direct')) columnMap.directSubs = index;
            else if (h.includes('refund')) columnMap.refunded = index;
        }
    });

    console.log('🔍 Colonnes détectées:', columnMap);

    // Analyser les dates et identifier les données manquantes
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const maxDateStr = yesterday.toISOString().split('T')[0];

    const dateRows = []; // { date, rowIndex }
    const missingTikTokDates = [];

    for (let i = headerRowIndex + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        if (columnMap.date !== undefined && row[columnMap.date]) {
            const dateStr = parseDateFromSheet(row[columnMap.date]);
            if (dateStr && dateStr <= maxDateStr) {
                dateRows.push({ date: dateStr, rowIndex: i });

                // Vérifier si les données TikTok manquent
                const hasSpent = row[columnMap.spentTiktok] &&
                    parseFloat(row[columnMap.spentTiktok].toString().replace(/[€\s]/g, '').replace(',', '.')) !== 0;
                if (!hasSpent) missingTikTokDates.push(dateStr);
            }
        }
    }

    console.log(`📊 ${dateRows.length} dates ≤ hier, ${missingTikTokDates.length} manquent données TikTok`);

    return { headerRowIndex, columnMap, dateRows, missingTikTokDates, rows };
}

/**
 * Lit les données RC actuelles pour le suivi des changements
 */
function readCurrentData(rows, sheetData) {
    const currentData = {};
    for (const { date, rowIndex } of sheetData.dateRows) {
        const row = rows[rowIndex] || [];
        currentData[date] = {
            trials: parseInt(row[sheetData.columnMap.trialsRC]) || 0,
            converted: parseInt(row[sheetData.columnMap.converted]) || 0,
            pending: parseInt(row[sheetData.columnMap.pending]) || 0,
            abandoned: parseInt(row[sheetData.columnMap.abandoned]) || 0,
        };
    }
    return currentData;
}

/**
 * Construit toutes les mises à jour et les envoie en batch
 */
async function updateSheet(sheets, sheetData, tiktokData, revenuecatData, refundData, directSubsData, ascData, paywallData, firstOpensData, acceptWallData, declineWallData) {
    console.log('\n📝 Préparation des mises à jour...');

    const currentData = readCurrentData(sheetData.rows, sheetData);
    const updates = [];
    const changes = [];

    // Map date → rowIndex (1-indexed pour l'API Sheets)
    // Exclure la date du jour (données incomplètes)
    const today = new Date().toISOString().split('T')[0];
    const dateToRow = {};
    sheetData.dateRows.forEach(({ date, rowIndex }) => {
        if (date === today) return; // Ne jamais écrire les données du jour en cours
        dateToRow[date] = rowIndex + 1;
    });
    console.log(`   (date du jour ${today} exclue des mises à jour)`);

    const cols = sheetData.columnMap;

    // === TikTok Ads ===
    if (tiktokData && tiktokData.length > 0) {
        for (const day of tiktokData) {
            const row = dateToRow[day.date];
            if (!row) continue;

            if (cols.spentTiktok !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.spentTiktok)}${row}`, values: [[day.budget]] });
            }
            if (cols.impressionsTiktok !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.impressionsTiktok)}${row}`, values: [[day.impressions]] });
            }
            if (cols.clicksTiktok !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.clicksTiktok)}${row}`, values: [[day.clicks]] });
            }
            if (cols.installsTiktok !== undefined && day.installs !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.installsTiktok)}${row}`, values: [[day.installs]] });
            }
            if (cols.trialsTiktok !== undefined && day.trials !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.trialsTiktok)}${row}`, values: [[day.trials]] });
            }
        }
    }

    // === RevenueCat (trial conversion) ===
    if (revenuecatData && Object.keys(revenuecatData).length > 0) {
        for (const [date, data] of Object.entries(revenuecatData)) {
            const row = dateToRow[date];
            if (!row) continue;

            const oldData = currentData[date] || { trials: 0, converted: 0, pending: 0, abandoned: 0 };
            const newData = {
                installs: data['New Customers'] || 0,
                trials: data['Trials'] || 0,
                converted: data['Converted'] || 0,
                pending: data['Pending'] || 0,
                abandoned: data['Abandoned'] || 0,
            };

            // Tracker les changements
            if (oldData.trials !== newData.trials || oldData.converted !== newData.converted ||
                oldData.pending !== newData.pending || oldData.abandoned !== newData.abandoned) {
                changes.push({ date, old: oldData, new: newData });
            }

            if (cols.installsRC !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.installsRC)}${row}`, values: [[newData.installs]] });
            }
            if (cols.trialsRC !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.trialsRC)}${row}`, values: [[newData.trials]] });
            }
            if (cols.converted !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.converted)}${row}`, values: [[newData.converted]] });
            }
            if (cols.pending !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.pending)}${row}`, values: [[newData.pending]] });
            }
            if (cols.abandoned !== undefined) {
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.abandoned)}${row}`, values: [[newData.abandoned]] });
            }
        }
    }

    // === Refunds quotidiens ===
    if (refundData && cols.refunded !== undefined) {
        for (const [date, count] of Object.entries(refundData)) {
            const row = dateToRow[date];
            if (!row) continue;
            updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.refunded)}${row}`, values: [[count]] });
        }
    }

    // === ASC (Installs, Impressions, Page Views) ===
    if (ascData) {
        if (ascData.installs && cols.installsASC !== undefined) {
            for (const [date, count] of Object.entries(ascData.installs)) {
                const row = dateToRow[date];
                if (!row) continue;
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.installsASC)}${row}`, values: [[count]] });
            }
        }
        if (ascData.impressions && cols.impressionsASC !== undefined) {
            for (const [date, count] of Object.entries(ascData.impressions)) {
                const row = dateToRow[date];
                if (!row) continue;
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.impressionsASC)}${row}`, values: [[count]] });
            }
        }
        if (ascData.pageViews && cols.pageViewsASC !== undefined) {
            for (const [date, count] of Object.entries(ascData.pageViews)) {
                const row = dateToRow[date];
                if (!row) continue;
                updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.pageViewsASC)}${row}`, values: [[count]] });
            }
        }
    }

    // === Direct subs quotidiens ===
    if (directSubsData && cols.directSubs !== undefined) {
        for (const [date, count] of Object.entries(directSubsData)) {
            const row = dateToRow[date];
            if (!row) continue;
            updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.directSubs)}${row}`, values: [[count]] });
        }
    }

    // === Paywall views (PostHog) ===
    if (paywallData && cols.paywallViews !== undefined) {
        for (const [date, count] of Object.entries(paywallData)) {
            const row = dateToRow[date];
            if (!row) continue;
            updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.paywallViews)}${row}`, values: [[count]] });
        }
    }

    // === First opens (PostHog) ===
    if (firstOpensData && cols.firstOpens !== undefined) {
        for (const [date, count] of Object.entries(firstOpensData)) {
            const row = dateToRow[date];
            if (!row) continue;
            updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.firstOpens)}${row}`, values: [[count]] });
        }
    }

    // === Accept wall (PostHog) ===
    if (acceptWallData && cols.acceptWall !== undefined) {
        for (const [date, count] of Object.entries(acceptWallData)) {
            const row = dateToRow[date];
            if (!row) continue;
            updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.acceptWall)}${row}`, values: [[count]] });
        }
    }

    // === Decline wall (PostHog) ===
    if (declineWallData && cols.declineWall !== undefined) {
        for (const [date, count] of Object.entries(declineWallData)) {
            const row = dateToRow[date];
            if (!row) continue;
            updates.push({ range: `${SHEET_NAME}!${getColumnLetter(cols.declineWall)}${row}`, values: [[count]] });
        }
    }

    // Exécuter le batch update
    if (updates.length > 0) {
        console.log(`📊 ${updates.length} mises à jour à effectuer...`);
        const response = await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SHEET_ID,
            resource: { valueInputOption: 'RAW', data: updates }
        });
        console.log(`✅ ${response.data.totalUpdatedCells || updates.length} cellules mises à jour`);
    } else {
        console.log('ℹ️  Aucune mise à jour nécessaire');
    }

    // Afficher les changements RC
    if (changes.length > 0) {
        console.log('\n📊 CHANGEMENTS REVENUECAT');
        console.log('='.repeat(60));
        changes.forEach(({ date, old, new: n }) => {
            console.log(`\n   📅 ${date}:`);
            ['trials', 'converted', 'pending', 'abandoned'].forEach(metric => {
                if (old[metric] !== n[metric]) {
                    const arrow = n[metric] > old[metric] ? '📈' : '📉';
                    const diff = n[metric] - old[metric];
                    console.log(`      ${arrow} ${metric}: ${old[metric]} → ${n[metric]} (${diff >= 0 ? '+' : ''}${diff})`);
                }
            });
        });
    }

    return { updatedCells: updates.length, changes };
}

/**
 * Synchronise la feuille Cohortes — 100% PostHog
 * Colonne C = taille cohorte (first app_opened), D = retenus J7, F = retenus J30
 */
async function syncCohortes(sheets) {
    try {
        // Lire la feuille Cohortes pour trouver les semaines
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Cohortes!B10:G50',
            valueRenderOption: 'FORMATTED_VALUE'
        });

        const rows = response.data.values || [];
        if (rows.length === 0) {
            console.log('   ⚠️  Pas de données dans Cohortes');
            return;
        }

        // Lire les dates de début de semaine (colonne B = index 0 dans le range)
        const cohortWeeks = [];
        const weekRows = [];

        for (let i = 0; i < rows.length; i++) {
            const cellValue = rows[i][0];
            if (!cellValue) continue;

            const dateStr = parseDateFromSheet(cellValue);
            if (dateStr) {
                cohortWeeks.push(dateStr);
                weekRows.push({ weekStart: dateStr, row: i + 10 });
            }
        }

        if (cohortWeeks.length === 0) {
            console.log('   ⚠️  Aucune semaine trouvée dans Cohortes');
            return;
        }

        console.log(`   📅 ${cohortWeeks.length} semaines trouvées`);

        // Tout vient de PostHog : cohort size + rétention J7/J30
        const retentionData = await fetchAllCohortRetention(cohortWeeks);

        const updates = [];
        for (const { weekStart, row } of weekRows) {
            const data = retentionData[weekStart];
            if (!data) continue;

            // C = taille de la cohorte PostHog (first app_opened dans la semaine)
            if (data.cohortSize > 0) {
                updates.push({
                    range: `Cohortes!C${row}`,
                    values: [[data.cohortSize]]
                });
            }

            // D = retenus J7
            if (data.retainedJ7 !== null) {
                updates.push({
                    range: `Cohortes!D${row}`,
                    values: [[data.retainedJ7]]
                });
            }

            // F = retenus J30
            if (data.retainedJ30 !== null) {
                updates.push({
                    range: `Cohortes!F${row}`,
                    values: [[data.retainedJ30]]
                });
            }
        }

        // Écrire les mises à jour
        if (updates.length > 0) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: SHEET_ID,
                resource: { valueInputOption: 'RAW', data: updates }
            });
            console.log(`   ✅ ${updates.length} cellules Cohortes mises à jour`);
        } else {
            console.log('   ℹ️  Aucune mise à jour Cohortes (pas encore assez de recul)');
        }

    } catch (error) {
        console.error('   ❌ Erreur sync Cohortes:', error.message);
    }
}

/**
 * Synchronise la feuille History : ajoute automatiquement les mois manquants
 * Réplique le pattern de formules du dernier mois existant
 */
async function syncHistory(sheets) {
    try {
        console.log('📊 Synchronisation feuille History...');

        // 1. Lire les mois existants (dates en serial number)
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'History!B4:B50',
            valueRenderOption: 'UNFORMATTED_VALUE'
        });

        const cells = response.data.values || [];
        let lastRow = 3; // header = row 3
        let lastYear = null, lastMonth = null;

        for (let i = 0; i < cells.length; i++) {
            const serial = cells[i] ? cells[i][0] : null;
            if (serial === undefined || serial === null || serial === '') continue;
            const date = new Date((serial - 25569) * 86400000);
            lastYear = date.getUTCFullYear();
            lastMonth = date.getUTCMonth() + 1;
            lastRow = i + 4;
        }

        if (!lastYear) {
            console.log('   ⚠️  Aucun mois trouvé dans History');
            return;
        }

        // 2. Calculer les mois à ajouter (dernier existant+1 → mois en cours)
        const now = new Date();
        const currentYM = now.getFullYear() * 100 + (now.getMonth() + 1);

        const monthsToAdd = [];
        let y = lastYear, m = lastMonth;
        while (true) {
            m++;
            if (m > 12) { m = 1; y++; }
            if (y * 100 + m > currentYM) break;
            monthsToAdd.push({ year: y, month: m });
        }

        if (monthsToAdd.length === 0) {
            console.log('   ℹ️  History à jour');
            return;
        }

        // 3. Construire les formules pour chaque nouveau mois
        const DN = "'Daily numbers'";
        const values = [];

        for (let i = 0; i < monthsToAdd.length; i++) {
            const { year, month } = monthsToAdd[i];
            const r = lastRow + 1 + i;
            const prevR = r - 1;
            const sumifs = (col) => `SUMIFS(${DN}!${col}:${col};${DN}!$A:$A;">="&$B${r};${DN}!$A:$A;"<="&EOMONTH($B${r};0))`;

            values.push([
                `=DATE(${year};${month};1)`,                           // B: Mois
                `=${sumifs('B')}`,                                      // C: Spend
                `=IF(C${r}>0;C${r}/DAY(EOMONTH($B${r};0));"—")`,     // D: Spend/j
                `=${sumifs('J')}`,                                      // E: Installs
                `=${sumifs('P')}`,                                      // F: Trials
                `=${sumifs('Q')}+${sumifs('T')}`,                       // G: Clients
                `=IF(E${r}>0;C${r}/E${r};"—")`,                       // H: CPI
                `=IF(E${r}>0;F${r}/E${r};"—")`,                       // I: %ITT
                `=IF(F${r}>0;C${r}/F${r};"—")`,                       // J: Coût/trial
                `=IF(F${r}>0;${sumifs('Q')}/F${r};"—")`,              // K: %TTP
                `=IF(G${r}>0;C${r}/G${r};"—")`,                       // L: Coût/client
                `=G${r}*Dashboard!$B$3`,                                // M: Revenu
                `=IF(C${r}>0;M${r}/C${r};"—")`,                       // N: ROAS
                `=IF(AND(M${r}<>0;C${r}<>0);M${r}-C${r};"—")`,        // O: Bénéfices
                `=IF(OR(O${r}="—";O${prevR}="—");"—";IF(O${r}>O${prevR};"▲";IF(O${r}<O${prevR};"▼";"►")))`, // P: Variation
            ]);
        }

        const startRow = lastRow + 1;
        const endRow = startRow + values.length - 1;

        await sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `History!B${startRow}:P${endRow}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values }
        });

        // 4. Appliquer les formats numériques
        const meta = await sheets.spreadsheets.get({
            spreadsheetId: SHEET_ID,
            fields: 'sheets(properties(sheetId,title))'
        });
        const histSheetId = meta.data.sheets.find(s => s.properties.title === 'History').properties.sheetId;

        const fmtRequests = [];
        const numFmt = (startCol, endCol, type, pattern) => {
            fmtRequests.push({
                repeatCell: {
                    range: { sheetId: histSheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
                    cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
                    fields: 'userEnteredFormat.numberFormat'
                }
            });
        };

        numFmt(1, 2, 'DATE', 'MMMM YYYY');        // B: Mois
        numFmt(2, 4, 'NUMBER', '#,##0 "€"');        // C-D: Spend, Spend/j
        numFmt(4, 7, 'NUMBER', '#,##0');             // E-G: Installs, Trials, Clients
        numFmt(7, 8, 'NUMBER', '#,##0.00 "€"');      // H: CPI
        numFmt(8, 9, 'PERCENT', '0.0%');             // I: %ITT
        numFmt(9, 10, 'NUMBER', '#,##0.00 "€"');     // J: Coût/trial
        numFmt(10, 11, 'PERCENT', '0.0%');           // K: %TTP
        numFmt(11, 12, 'NUMBER', '#,##0.00 "€"');    // L: Coût/client
        numFmt(12, 13, 'NUMBER', '#,##0 "€"');       // M: Revenu
        numFmt(13, 14, 'NUMBER', '0.00');            // N: ROAS
        numFmt(14, 15, 'NUMBER', '#,##0 "€"');       // O: Bénéfices

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            resource: { requests: fmtRequests }
        });

        const names = monthsToAdd.map(m => `${m.year}-${String(m.month).padStart(2, '0')}`);
        console.log(`   ✅ ${monthsToAdd.length} mois ajoutés: ${names.join(', ')}`);

    } catch (error) {
        console.error('   ❌ Erreur sync History:', error.message);
    }
}

/**
 * Fonction principale
 */
async function syncAllData() {
    // Kill the process after 5 minutes max to avoid zombie processes
    const globalTimeout = setTimeout(() => {
        console.error('\n💥 TIMEOUT GLOBAL (5 min) — arrêt forcé');
        process.exit(1);
    }, 5 * 60 * 1000);
    globalTimeout.unref();

    console.log('🚀 SYNCHRONISATION → Better Ads Numbers');
    console.log('='.repeat(60));

    try {
        // 1. Auth
        const sheets = await initializeAuth();

        // 2. Analyser le sheet
        const sheetData = await analyzeSheet(sheets);

        if (sheetData.dateRows.length === 0) {
            console.log('\nℹ️  Aucune date passée trouvée dans le tableau. Rien à synchroniser.');
            return;
        }

        const errors = [];

        // 3. TikTok : seulement les dates manquantes
        let tiktokData = null;
        try {
            if (sheetData.missingTikTokDates.length > 0) {
                console.log(`\n🎯 Récupération TikTok pour ${sheetData.missingTikTokDates.length} dates...`);
                const startDate = sheetData.missingTikTokDates[0];
                const endDate = sheetData.missingTikTokDates[sheetData.missingTikTokDates.length - 1];
                tiktokData = await fetchAndParseTikTokData(startDate, endDate);
                tiktokData = tiktokData.filter(day => sheetData.missingTikTokDates.includes(day.date));
            } else {
                console.log('\n✅ Données TikTok à jour');
            }
        } catch (e) { console.error('❌ TikTok:', e.message); errors.push('TikTok'); }

        // 4. RevenueCat trial conversion (30 derniers jours)
        let revenuecatData = null;
        try {
            console.log('\n🎯 Récupération RevenueCat (30 derniers jours)...');
            const endDate = new Date().toISOString().split('T')[0];
            const startDate30 = new Date();
            startDate30.setDate(startDate30.getDate() - 30);
            const startDate = startDate30.toISOString().split('T')[0];
            revenuecatData = await fetchAndParseTrialData(startDate, endDate);
        } catch (e) { console.error('❌ RevenueCat:', e.message); errors.push('RevenueCat'); }

        // 5. Refunds quotidiens (90 derniers jours)
        let refundData = null;
        try {
            console.log('\n💸 Récupération refunds quotidiens...');
            refundData = await fetchDailyRefunds();
        } catch (e) { console.error('❌ Refunds:', e.message); errors.push('Refunds'); }

        // 6. Direct subs quotidiens (30 derniers jours)
        let directSubsData = null;
        try {
            console.log('\n💳 Récupération direct subs...');
            directSubsData = await fetchDailyDirectSubs();
        } catch (e) { console.error('❌ Direct subs:', e.message); errors.push('DirectSubs'); }

        // 7. PostHog (Paywall views + First opens + Decline wall)
        let paywallData = null, firstOpensData = null, acceptWallData = null, declineWallData = null;
        try {
            console.log('\n📊 Récupération données PostHog...');
            paywallData = await fetchDailyPaywallViews();
            firstOpensData = await fetchDailyFirstOpens();
            acceptWallData = await fetchDailyAcceptWall();
            declineWallData = await fetchDailyDeclineWall();
        } catch (e) { console.error('❌ PostHog:', e.message); errors.push('PostHog'); }

        // 8. App Store Connect (Installs, Impressions, Page Views)
        let ascData = null;
        try {
            console.log('\n📱 Récupération données ASC...');
            ascData = await fetchDailyASCData();
        } catch (e) { console.error('❌ ASC:', e.message); errors.push('ASC'); }

        // 9. Écriture dans le sheet Daily numbers
        const result = await updateSheet(sheets, sheetData, tiktokData, revenuecatData, refundData, directSubsData, ascData, paywallData, firstOpensData, acceptWallData, declineWallData);

        // 10. Sync Cohortes (100% PostHog : cohort size + rétention)
        try {
            console.log('\n📊 Synchronisation feuille Cohortes...');
            await Promise.race([
                syncCohortes(sheets),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Cohortes timeout (2 min)')), 120000))
            ]);
        } catch (e) { console.error('❌ Cohortes:', e.message); errors.push('Cohortes'); }

        // 11. Sync History (ajout automatique des mois manquants)
        console.log('\n📅 Synchronisation feuille History...');
        await syncHistory(sheets);

        // 12. Résumé
        console.log('\n🎉 SYNCHRONISATION TERMINÉE');
        console.log('='.repeat(60));
        if (tiktokData) console.log(`   • ${tiktokData.length} jours TikTok synchronisés`);
        if (revenuecatData) console.log(`   • ${Object.keys(revenuecatData).length} jours RevenueCat traités`);
        if (refundData) console.log(`   • ${Object.keys(refundData).length} jours de refunds traités`);
        if (directSubsData) console.log(`   • ${Object.keys(directSubsData).length} jours de direct subs traités`);
        if (acceptWallData) console.log(`   • ${Object.keys(acceptWallData).length} jours d'accept wall PostHog traités`);
        if (declineWallData) console.log(`   • ${Object.keys(declineWallData).length} jours de decline wall PostHog traités`);
        if (paywallData) console.log(`   • ${Object.keys(paywallData).length} jours de paywall views PostHog traités`);
        if (firstOpensData) console.log(`   • ${Object.keys(firstOpensData).length} jours de first opens PostHog traités`);
        if (ascData && ascData.installs) console.log(`   • ${Object.keys(ascData.installs).length} jours d'installs ASC`);
        if (ascData && ascData.impressions) console.log(`   • ${Object.keys(ascData.impressions).length} jours d'impressions ASC`);
        if (ascData && ascData.pageViews) console.log(`   • ${Object.keys(ascData.pageViews).length} jours de page views ASC`);
        console.log(`   • ${result.updatedCells} cellules mises à jour`);
        console.log(`   • ${result.changes.length} dates avec changements RC`);
        if (errors.length > 0) console.log(`   ⚠️  Sources en erreur: ${errors.join(', ')}`);

    } catch (error) {
        console.error('\n💥 ERREUR:', error.message);
        throw error;
    }
}

// Exécution
if (require.main === module) {
    syncAllData()
        .then(() => console.log('\n✅ Script terminé'))
        .catch(error => {
            console.error('\n💥 Échec:', error.message);
            process.exit(1);
        });
}

module.exports = { syncAllData };
