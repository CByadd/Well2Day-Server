// OTA self-update for the kiosk Android app.
// Release metadata + per-screen install reports live in small JSON files (no DB migration);
// the APK itself is stored under ASSETS_DIR/apk and served like any other asset.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const { ASSETS_DIR, ASSET_BASE_URL, ensureDir, safeFilename } = require('../config/assets');
const { authenticateToken, requireSuperAdmin } = require('../middleware/authMiddleware');

const DATA_DIR = process.env.OTA_DATA_DIR || path.join(__dirname, '..', 'data');
const RELEASES_FILE = path.join(DATA_DIR, 'app-releases.json'); // { [packageName]: release }
const REPORTS_FILE = path.join(DATA_DIR, 'app-update-reports.json'); // { [screenId]: lastReport }
const APK_DIR = path.join(ASSETS_DIR, 'apk');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeJson(file, data) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(file + '.tmp', file);
}
function isTargeted(release, screenId) {
    return !release.screenIds?.length || release.screenIds.includes(String(screenId || ''));
}

module.exports = (io) => {
    const router = express.Router();

    // Kiosk: GET /api/app-release/latest?package=com.example.playerapp.f3.f1&screenId=12345678
    // -> { release: {versionCode, versionName, url, sha256, size} } or { release: null }
    router.get('/app-release/latest', (req, res) => {
        const release = readJson(RELEASES_FILE)[String(req.query.package || '')];
        if (!release || !isTargeted(release, req.query.screenId)) return res.json({ release: null });
        const { versionCode, versionName, url, sha256, size } = release;
        res.json({ release: { versionCode, versionName, url, sha256, size } });
    });

    // Kiosk: POST /api/app-release/report { screenId, packageName, status: installed|failed|rolled_back, versionCode, error }
    router.post('/app-release/report', async (req, res) => {
        const { screenId, packageName, status, versionCode, error } = req.body || {};
        if (!screenId || !status) return res.status(400).json({ error: 'screenId and status required' });
        const reports = readJson(REPORTS_FILE);
        reports[String(screenId)] = {
            packageName: packageName || null,
            status: String(status),
            versionCode: versionCode != null ? Number(versionCode) : null,
            error: error ? String(error).slice(0, 2000) : null,
            at: new Date().toISOString(),
        };
        writeJson(REPORTS_FILE, reports);
        console.log('[OTA] Report from', screenId, reports[String(screenId)]);
        if (versionCode != null) {
            await prisma.adscapePlayer
                .updateMany({ where: { screenId: String(screenId) }, data: { appVersionCode: String(versionCode) } })
                .catch((e) => console.error('[OTA] Failed to update appVersionCode:', e.message));
        }
        res.json({ ok: true });
    });

    // Admin: current releases + every screen's installed versionCode and last OTA report
    router.get('/app-releases', authenticateToken, requireSuperAdmin, async (_req, res) => {
        try {
            const screens = await prisma.adscapePlayer.findMany({
                select: { screenId: true, deviceName: true, location: true, appVersionCode: true, lastSeen: true },
                orderBy: { lastSeen: 'desc' },
            });
            res.json({ releases: readJson(RELEASES_FILE), reports: readJson(REPORTS_FILE), screens });
        } catch (e) {
            console.error('[OTA] list error:', e);
            res.status(500).json({ error: 'internal_error' });
        }
    });

    // Admin: multipart upload. Fields: apk (file), packageName, versionCode, versionName, screenIds (comma separated, optional).
    // versionCode is entered by the admin; each kiosk re-checks it from the APK itself before installing.
    // Re-uploading the same versionCode replaces the release (e.g. to widen a staged rollout).
    router.post('/app-releases', authenticateToken, requireSuperAdmin, upload.single('apk'), (req, res) => {
        const { packageName, versionName } = req.body || {};
        const versionCode = parseInt(req.body?.versionCode, 10);
        if (!req.file || !packageName || !Number.isInteger(versionCode) || versionCode <= 0) {
            return res.status(400).json({ error: 'apk, packageName and a positive integer versionCode are required' });
        }
        if (req.file.buffer.subarray(0, 2).toString() !== 'PK') {
            return res.status(400).json({ error: 'File is not an APK (zip)' });
        }
        const releases = readJson(RELEASES_FILE);
        const current = releases[packageName];
        if (current && versionCode < current.versionCode) {
            return res.status(400).json({ error: `versionCode must be >= current release (${current.versionCode})` });
        }

        ensureDir(APK_DIR);
        const filename = safeFilename(`${packageName}-${versionCode}.apk`);
        fs.writeFileSync(path.join(APK_DIR, filename), req.file.buffer);
        const screenIds = String(req.body.screenIds || '').split(',').map((s) => s.trim()).filter(Boolean);
        const release = {
            packageName,
            versionCode,
            versionName: versionName || String(versionCode),
            url: `${ASSET_BASE_URL}/apk/${filename}`,
            sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
            size: req.file.size,
            screenIds,
            publishedAt: new Date().toISOString(),
            publishedBy: req.user.email,
        };
        releases[packageName] = release;
        writeJson(RELEASES_FILE, releases);

        const payload = { packageName, versionCode };
        if (screenIds.length) screenIds.forEach((id) => io.to(`screen:${id}`).emit('app-update-available', payload));
        else io.emit('app-update-available', payload);
        console.log('[OTA] Published', release);
        res.json({ ok: true, release });
    });

    return router;
};
