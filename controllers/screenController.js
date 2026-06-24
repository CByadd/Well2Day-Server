const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ASSETS_DIR, ASSET_BASE_URL, TYPES, ensureAssetDirs, getTypeDir, safeFilename, assetUrl, ensureDir, managedMediaUrl } = require('../config/assets');

let mediaTableCapabilities = null;

function isOwnAssetUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const base = (process.env.ASSET_BASE_URL || 'https://api.well2day.in/assets').replace(/\/$/, '');
    return url.startsWith(base + '/');
}

function deleteAssetFileByUrl(url) {
    if (!isOwnAssetUrl(url)) return;
    try {
        const base = (process.env.ASSET_BASE_URL || 'https://api.well2day.in/assets').replace(/\/$/, '');
        const rest = url.slice(base.length).replace(/^\//, '').replace(/\//g, path.sep);
        const fullPath = path.join(ASSETS_DIR, rest);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            console.log('[ADSCAPE] Deleted local asset:', fullPath);
        }
    } catch (e) {
        console.error('[ADSCAPE] Error deleting local asset:', e.message);
    }
}

function parseManagedMediaUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const base = (process.env.ASSET_BASE_URL || 'https://api.well2day.in/assets').replace(/\/$/, '');
    const match = url.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/media/([^/]+)/`));
    return match ? String(match[1]) : null;
}

function getRequestBaseUrl(req) {
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
    const forwardedHost = (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim();
    const proto = forwardedProto || req.protocol || 'https';
    const host = forwardedHost || req.get('host');
    return host ? `${proto}://${host}`.replace(/\/$/, '') : null;
}

function rewriteAssetUrlForRequest(url, req) {
    if (!url || typeof url !== 'string') return url;
    const requestBase = getRequestBaseUrl(req);
    if (!requestBase) return url;

    const assetIndex = url.indexOf('/assets/');
    if (assetIndex < 0) return url;

    return `${requestBase}${url.substring(assetIndex)}`;
}

async function ensureManagedMediaTable() {
    try {
        await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS media (
                id VARCHAR(36) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                type VARCHAR(20) NOT NULL,
                path VARCHAR(512) NOT NULL,
                url TEXT NOT NULL,
                size BIGINT,
                format VARCHAR(20),
                duration FLOAT,
                created_by UUID,
                created_at TIMESTAMP DEFAULT NOW(),
                tags TEXT
            )
        `);

        const folderColumnRows = await prisma.$queryRawUnsafe(`
            SELECT 1
            FROM information_schema.columns
            WHERE table_name = 'media' AND column_name = 'folder_id'
            LIMIT 1
        `);

        mediaTableCapabilities = {
            hasFolderId: Array.isArray(folderColumnRows) && folderColumnRows.length > 0
        };
    } catch (e) {
        console.error('[ADSCAPE] Failed to ensure media table:', e.message);
        throw e;
    }
}

function buildManagedScreenAssetLocation({ mediaId, originalName, screenId, assetKind, slotIndex = null }) {
    const base = path.basename(originalName || 'image.png');
    const ext = path.extname(base) || '.png';
    const fallbackName = assetKind === 'logo'
        ? `logo-${screenId}`
        : `flow-${screenId}-${Number(slotIndex) + 1}`;
    const name = path.basename(base, ext) || fallbackName;
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || fallbackName;
    const filename = `${mediaId}-${safe}${ext.toLowerCase()}`;
    const relativePath = assetKind === 'logo'
        ? path.join('media', 'screens', String(screenId), 'logo', 'images', filename).replace(/\\/g, '/')
        : path.join('media', 'screens', String(screenId), 'flow-drawer', 'images', filename).replace(/\\/g, '/');
    const absolutePath = path.join(ASSETS_DIR, relativePath.replace(/\//g, path.sep));

    return {
        filename,
        relativePath,
        absolutePath,
        url: managedMediaUrl(mediaId, filename)
    };
}

async function saveScreenAssetManaged({ buffer, originalName, mimetype, size, screenId, assetKind, slotIndex = null }) {
    ensureAssetDirs();
    await ensureManagedMediaTable();

    const mediaId = crypto.randomUUID();
    const managedLocation = buildManagedScreenAssetLocation({
        mediaId,
        originalName,
        screenId,
        assetKind,
        slotIndex
    });

    ensureDir(path.dirname(managedLocation.absolutePath));
    fs.writeFileSync(managedLocation.absolutePath, buffer);

    if (!fs.existsSync(managedLocation.absolutePath)) {
        throw new Error(`Managed asset write did not persist: ${managedLocation.absolutePath}`);
    }

    const tags = JSON.stringify(
        assetKind === 'logo'
            ? [`screen:${screenId}`, 'logo']
            : [`screen:${screenId}`, 'flow-drawer', `slot:${slotIndex + 1}`]
    );

    if (mediaTableCapabilities?.hasFolderId) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO media (id, name, type, path, url, size, format, duration, created_by, tags, folder_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, NULL)`,
            mediaId,
            originalName || managedLocation.filename,
            'image',
            managedLocation.relativePath,
            managedLocation.url,
            size || null,
            mimetype ? String(mimetype).split('/')[1] : null,
            tags
        );
    } else {
        await prisma.$executeRawUnsafe(
            `INSERT INTO media (id, name, type, path, url, size, format, duration, created_by, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8)`,
            mediaId,
            originalName || managedLocation.filename,
            'image',
            managedLocation.relativePath,
            managedLocation.url,
            size || null,
            mimetype ? String(mimetype).split('/')[1] : null,
            tags
        );
    }

    console.log(`[ADSCAPE] Saved managed ${assetKind} asset to:`, managedLocation.absolutePath);
    return managedLocation.url;
}

async function deleteManagedMediaByUrl(url) {
    const mediaId = parseManagedMediaUrl(url);
    if (!mediaId) return false;

    try {
        const row = await prisma.$queryRawUnsafe(
            'SELECT id, path FROM media WHERE id = $1 LIMIT 1',
            mediaId
        ).then((result) => (result && result[0]) || null);

        if (!row) return false;

        const fullPath = path.join(ASSETS_DIR, String(row.path).replace(/\//g, path.sep));
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            console.log('[ADSCAPE] Deleted managed asset:', fullPath);
        }

        await prisma.$executeRawUnsafe('DELETE FROM media WHERE id = $1', mediaId);
        return true;
    } catch (e) {
        console.error('[ADSCAPE] Error deleting managed asset:', e.message);
        return false;
    }
}

function saveBufferToAssets(buffer, originalName, prefix) {
    ensureAssetDirs();
    const dir = getTypeDir(TYPES.IMAGES);
    const ext = path.extname(originalName || '') || '.png';
    const filename = safeFilename(`${prefix}${path.basename(originalName || `image${ext}`)}`);
    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, buffer);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Asset write did not persist: ${fullPath}`);
    }
    console.log('[ADSCAPE] Saved asset to:', fullPath);
    return assetUrl(TYPES.IMAGES, filename);
}

/**
 * Register or update an Adscape player
 * POST /api/adscape/register
 */
exports.registerPlayer = async (req, res) => {
    try {
        const {
            screenId,
            appVersion,
            flowType,
            deviceName,
            screenWidth,
            screenHeight,
            ipAddress,
            location,
            osVersion,
            appVersionCode
        } = req.body || {};

        if (!screenId || !appVersion) {
            return res.status(400).json({ error: 'screenId and appVersion required' });
        }

        // Check if player already exists to preserve admin-configured values
        const existingPlayer = await prisma.adscapePlayer.findUnique({
            where: { screenId: String(screenId) }
        });

        // Preserve admin-configured deviceName and location if they exist
        // Device registration should NOT overwrite admin-configured values
        const updateData = {
            appVersion: String(appVersion),
            ...(flowType !== undefined && flowType !== null ? { flowType: String(flowType) } : {}),
            screenWidth: screenWidth ? Number(screenWidth) : null,
            screenHeight: screenHeight ? Number(screenHeight) : null,
            ipAddress: ipAddress ? String(ipAddress) : null,
            osVersion: osVersion ? String(osVersion) : null,
            appVersionCode: appVersionCode ? String(appVersionCode) : null,
            lastSeen: new Date(),
            isActive: true,
            updatedAt: new Date()
        };

        // Preserve admin-configured deviceName - only update if not already set
        if (existingPlayer && existingPlayer.deviceName && existingPlayer.deviceName.trim() !== '') {
            // Admin has configured a deviceName, preserve it (don't overwrite with device-sent value)
            updateData.deviceName = existingPlayer.deviceName;
            console.log('[ADSCAPE] Preserving admin-configured deviceName:', existingPlayer.deviceName);
        } else {
            // No existing deviceName, use incoming value (or null)
            updateData.deviceName = deviceName ? String(deviceName) : null;
        }

        // Preserve admin-configured location - only update if not already set
        if (existingPlayer && existingPlayer.location && existingPlayer.location.trim() !== '') {
            // Admin has configured a location, preserve it (don't overwrite with device-sent value)
            updateData.location = existingPlayer.location;
            console.log('[ADSCAPE] Preserving admin-configured location:', existingPlayer.location);
        } else {
            // No existing location, use incoming value (or null)
            updateData.location = location ? String(location) : null;
        }

        // Upsert Adscape player registration
        const player = await prisma.adscapePlayer.upsert({
            where: { screenId: String(screenId) },
            update: updateData,
            create: {
                screenId: String(screenId),
                appVersion: String(appVersion),
                flowType: flowType ? String(flowType) : null,
                deviceName: deviceName ? String(deviceName) : null,
                screenWidth: screenWidth ? Number(screenWidth) : null,
                screenHeight: screenHeight ? Number(screenHeight) : null,
                ipAddress: ipAddress ? String(ipAddress) : null,
                location: location ? String(location) : null,
                osVersion: osVersion ? String(osVersion) : null,
                appVersionCode: appVersionCode ? String(appVersionCode) : null,
                lastSeen: new Date(),
                isActive: true
            }
        });

        console.log('[ADSCAPE] Player registered:', { screenId, appVersion, flowType });

        return res.json({
            ok: true,
            player: {
                id: player.id,
                screenId: player.screenId,
                appVersion: player.appVersion,
                flowType: player.flowType,
                isActive: player.isActive
            }
        });
    } catch (e) {
        console.error('[ADSCAPE] Registration error:', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * Get a specific player by screenId
 * GET /api/adscape/player/:screenId
 */
exports.getPlayer = async (req, res) => {
    try {
        const { screenId } = req.params;

        // Use raw SQL to fetch player to avoid Prisma error if heightCalibration column doesn't exist
        let player;
        try {
            const playerResult = await prisma.$queryRaw`
                SELECT * FROM "AdscapePlayer" WHERE "screenId" = ${String(screenId)} LIMIT 1
            `;
            if (playerResult && playerResult.length > 0) {
                player = playerResult[0];
            } else {
                return res.status(404).json({ error: 'Player not found' });
            }
        } catch (e) {
            // Fallback to Prisma if raw SQL fails
            player = await prisma.adscapePlayer.findUnique({
                where: { screenId: String(screenId) }
            });
            if (!player) {
                return res.status(404).json({ error: 'Player not found' });
            }
        }

        // Get playlistId, heightCalibration, heightCalibrationEnabled, paymentAmount, logoUrl, flowDrawerEnabled, flowDrawerSlotCount, hideScreenId, hideAppMargin, and flow drawer images using raw SQL (columns might not exist yet)
        let playlistId = null;
        let heightCalibration = 0;
        let heightCalibrationEnabled = true;
        let paymentAmount = null;
        let logoUrl = null;
        let flowDrawerEnabled = true;
        let flowDrawerSlotCount = 2;
        let hideScreenId = false;
        let hideAppMargin = false;
        let flowDrawerSlots = [];
        let flowDrawerImage1Url = null;
        let flowDrawerImage2Url = null;
        let flowDrawerImage3Url = null;
        let flowDrawerImage4Url = null;
        let flowDrawerImage5Url = null;
        let smsEnabled = false;
        let smsLimitPerScreen = null;
        let smsSentCount = 0;
        let whatsappEnabled = false;
        let whatsappLimitPerScreen = null;
        let whatsappSentCount = 0;
        let appMode = "F1";
        let rotation = "landscape";
        try {
            const configResult = await prisma.$queryRaw`
                SELECT "playlistId", "heightCalibration", "heightCalibrationEnabled", "paymentAmount", "logoUrl", "flowDrawerEnabled", "flowDrawerSlotCount", "hideScreenId", "hideAppMargin", "appMode", "rotation",
                       "flowDrawerImage1Url", "flowDrawerImage2Url", "flowDrawerImage3Url", "flowDrawerImage4Url", "flowDrawerImage5Url"
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (configResult && configResult.length > 0) {
                playlistId = configResult[0].playlistId || null;
                if (configResult[0].heightCalibration !== null && configResult[0].heightCalibration !== undefined) {
                    heightCalibration = configResult[0].heightCalibration;
                }
                if (configResult[0].heightCalibrationEnabled !== null && configResult[0].heightCalibrationEnabled !== undefined) {
                    heightCalibrationEnabled = Boolean(configResult[0].heightCalibrationEnabled);
                }
                if (configResult[0].paymentAmount !== null && configResult[0].paymentAmount !== undefined) {
                    paymentAmount = configResult[0].paymentAmount;
                }
                if (configResult[0].logoUrl !== null && configResult[0].logoUrl !== undefined) {
                    logoUrl = configResult[0].logoUrl;
                }
                if (configResult[0].flowDrawerEnabled !== null && configResult[0].flowDrawerEnabled !== undefined) {
                    flowDrawerEnabled = Boolean(configResult[0].flowDrawerEnabled);
                }
                if (configResult[0].flowDrawerSlotCount !== null && configResult[0].flowDrawerSlotCount !== undefined) {
                    flowDrawerSlotCount = parseInt(configResult[0].flowDrawerSlotCount) || 2;
                }
                if (configResult[0].hideScreenId !== null && configResult[0].hideScreenId !== undefined) {
                    hideScreenId = Boolean(configResult[0].hideScreenId);
                }
                if (configResult[0].hideAppMargin !== null && configResult[0].hideAppMargin !== undefined) {
                    hideAppMargin = Boolean(configResult[0].hideAppMargin);
                }
                if (configResult[0].appMode !== null && configResult[0].appMode !== undefined) {
                    appMode = String(configResult[0].appMode);
                }
                if (configResult[0].rotation !== null && configResult[0].rotation !== undefined) {
                    rotation = String(configResult[0].rotation);
                }

                // Get individual URL fields
                flowDrawerImage1Url = rewriteAssetUrlForRequest(configResult[0].flowDrawerImage1Url || null, req);
                flowDrawerImage2Url = rewriteAssetUrlForRequest(configResult[0].flowDrawerImage2Url || null, req);
                flowDrawerImage3Url = rewriteAssetUrlForRequest(configResult[0].flowDrawerImage3Url || null, req);
                flowDrawerImage4Url = rewriteAssetUrlForRequest(configResult[0].flowDrawerImage4Url || null, req);
                flowDrawerImage5Url = rewriteAssetUrlForRequest(configResult[0].flowDrawerImage5Url || null, req);

                // Build slots array from individual URL fields based on slot count
                flowDrawerSlots = [];
                if (flowDrawerSlotCount >= 1) flowDrawerSlots.push(flowDrawerImage1Url);
                if (flowDrawerSlotCount >= 2) flowDrawerSlots.push(flowDrawerImage2Url);
                if (flowDrawerSlotCount >= 3) flowDrawerSlots.push(flowDrawerImage3Url);
                if (flowDrawerSlotCount >= 4) flowDrawerSlots.push(flowDrawerImage4Url);
                if (flowDrawerSlotCount >= 5) flowDrawerSlots.push(flowDrawerImage5Url);

                console.log('[ADSCAPE] Loaded flow drawer config:', {
                    slotCount: flowDrawerSlotCount,
                    slotsLength: flowDrawerSlots.length,
                    enabled: flowDrawerEnabled,
                    imageUrls: {
                        1: flowDrawerImage1Url,
                        2: flowDrawerImage2Url,
                        3: flowDrawerImage3Url,
                        4: flowDrawerImage4Url,
                        5: flowDrawerImage5Url
                    }
                });
            }
        } catch (e) {
            // Columns might not exist yet, use defaults
            console.log('[ADSCAPE] Config columns might not exist yet, using defaults:', e.message);
        }
        try {
            const smsResult = await prisma.$queryRawUnsafe(
                `SELECT COALESCE("smsEnabled", false) as "smsEnabled", "smsLimitPerScreen", COALESCE("smsSentCount", 0) as "smsSentCount" FROM "AdscapePlayer" WHERE "screenId" = $1 LIMIT 1`,
                String(screenId)
            );
            if (smsResult && smsResult[0]) {
                smsEnabled = Boolean(smsResult[0].smsEnabled);
                smsLimitPerScreen = smsResult[0].smsLimitPerScreen != null ? Number(smsResult[0].smsLimitPerScreen) : null;
                smsSentCount = (smsResult[0].smsSentCount != null ? Number(smsResult[0].smsSentCount) : 0) || 0;
            }
        } catch (e) {
            console.log('[ADSCAPE] SMS config columns may not exist, using defaults:', e.message);
        }
        try {
            const waResult = await prisma.$queryRawUnsafe(
                `SELECT COALESCE("whatsappEnabled", false) as "whatsappEnabled", "whatsappLimitPerScreen", COALESCE("whatsappSentCount", 0) as "whatsappSentCount" FROM "AdscapePlayer" WHERE "screenId" = $1 LIMIT 1`,
                String(screenId)
            );
            if (waResult && waResult[0]) {
                whatsappEnabled = Boolean(waResult[0].whatsappEnabled);
                whatsappLimitPerScreen = waResult[0].whatsappLimitPerScreen != null ? Number(waResult[0].whatsappLimitPerScreen) : null;
                whatsappSentCount = (waResult[0].whatsappSentCount != null ? Number(waResult[0].whatsappSentCount) : 0) || 0;
            }
        } catch (e) {
            console.log('[ADSCAPE] WhatsApp config columns may not exist, using defaults:', e.message);
        }

        return res.json({
            ok: true,
            player: {
                screenId: player.screenId,
                appVersion: player.appVersion,
                flowType: player.flowType,
                deviceName: player.deviceName,
                screenWidth: player.screenWidth,
                screenHeight: player.screenHeight,
                ipAddress: player.ipAddress,
                location: player.location,
                osVersion: player.osVersion,
                appVersionCode: player.appVersionCode,
                heightCalibration: heightCalibration,
                heightCalibrationEnabled: heightCalibrationEnabled,
                paymentAmount: paymentAmount,
                flowDrawerEnabled: flowDrawerEnabled,
                flowDrawerSlotCount: flowDrawerSlotCount,
                flowDrawerSlots: flowDrawerSlots,
                hideScreenId: hideScreenId,
                hideAppMargin: hideAppMargin,
                appMode: appMode,
                rotation: rotation,
                lastSeen: player.lastSeen,
                isActive: player.isActive,
                isEnabled: player.isActive, // Also include isEnabled for Android app compatibility
                createdAt: player.createdAt,
                updatedAt: player.updatedAt,
                playlistId: playlistId,
                logoUrl: logoUrl,
                flowDrawerImage1Url: flowDrawerImage1Url,
                flowDrawerImage2Url: flowDrawerImage2Url,
                flowDrawerImage3Url: flowDrawerImage3Url,
                flowDrawerImage4Url: flowDrawerImage4Url,
                flowDrawerImage5Url: flowDrawerImage5Url,
                smsEnabled: smsEnabled,
                smsLimitPerScreen: smsLimitPerScreen,
                smsSentCount: smsSentCount,
                whatsappEnabled: whatsappEnabled,
                whatsappLimitPerScreen: whatsappLimitPerScreen,
                whatsappSentCount: whatsappSentCount
            }
        });
    } catch (e) {
        console.error('[ADSCAPE] Get player error:', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * Get all players
 * GET /api/adscape/players
 */
exports.getAllPlayers = async (req, res) => {
    try {
        // Filter by role: super_admin sees all, admin sees only assigned screens
        const whereClause = req.user.role === 'super_admin'
            ? {}
            : { screenId: { in: req.user.assignedScreenIds } };

        // Try to get players with heightCalibration, paymentAmount, playlistId, flowDrawerEnabled using raw SQL, fallback if columns don't exist
        let players;
        try {
            if (req.user.role === 'super_admin') {
                players = await prisma.$queryRaw`
                    SELECT 
                        id, "screenId", "appVersion", "flowType", "deviceName", 
                        "screenWidth", "screenHeight", "ipAddress", location, 
                        "osVersion", "lastSeen", "isActive", "createdAt",
                        COALESCE("heightCalibration", 0) as "heightCalibration",
                        "paymentAmount", "playlistId", COALESCE("flowDrawerEnabled", true) as "flowDrawerEnabled",
                        "appMode", "rotation"
                    FROM "AdscapePlayer"
                    ORDER BY "createdAt" DESC
                `;
            } else {
                const screenIds = req.user.assignedScreenIds;
                if (screenIds.length === 0) {
                    players = [];
                } else {
                    players = await prisma.$queryRaw`
                        SELECT 
                            id, "screenId", "appVersion", "flowType", "deviceName", 
                            "screenWidth", "screenHeight", "ipAddress", location, 
                            "osVersion", "lastSeen", "isActive", "createdAt",
                            COALESCE("heightCalibration", 0) as "heightCalibration",
                            "paymentAmount", "playlistId", COALESCE("flowDrawerEnabled", true) as "flowDrawerEnabled",
                            "appMode", "rotation"
                        FROM "AdscapePlayer"
                        WHERE "screenId" = ANY(${screenIds})
                        ORDER BY "createdAt" DESC
                    `;
                }
            }
        } catch (e) {
            // Column doesn't exist yet, use raw SQL without heightCalibration
            console.log('[ADSCAPE] heightCalibration column does not exist, fetching without it');
            if (req.user.role === 'super_admin') {
                const rawPlayers = await prisma.$queryRaw`
                    SELECT 
                        id, "screenId", "appVersion", "flowType", "deviceName", 
                        "screenWidth", "screenHeight", "ipAddress", location, 
                        "osVersion", "lastSeen", "isActive", "createdAt"
                    FROM "AdscapePlayer"
                    ORDER BY "createdAt" DESC
                `;
                players = rawPlayers.map(p => ({ ...p, heightCalibration: 0, paymentAmount: null, playlistId: null, flowDrawerEnabled: true, appMode: "F1", rotation: "landscape" }));
            } else {
                const screenIds = req.user.assignedScreenIds;
                if (screenIds.length === 0) {
                    players = [];
                } else {
                    const rawPlayers = await prisma.$queryRaw`
                        SELECT 
                            id, "screenId", "appVersion", "flowType", "deviceName", 
                            "screenWidth", "screenHeight", "ipAddress", location, 
                            "osVersion", "lastSeen", "isActive", "createdAt"
                        FROM "AdscapePlayer"
                        WHERE "screenId" = ANY(${screenIds})
                        ORDER BY "createdAt" DESC
                    `;
                    players = rawPlayers.map(p => ({ ...p, heightCalibration: 0, paymentAmount: null, playlistId: null, flowDrawerEnabled: true, appMode: "F1", rotation: "landscape" }));
                }
            }
        }

        // Get BMI counts for all screens
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayEnd = new Date(today);
        todayEnd.setHours(23, 59, 59, 999);

        const [totalCounts, todayCounts] = await Promise.all([
            prisma.bMI.groupBy({
                by: ['screenId'],
                _count: { _all: true }
            }),
            prisma.bMI.groupBy({
                by: ['screenId'],
                where: {
                    timestamp: {
                        gte: today,
                        lte: todayEnd
                    }
                },
                _count: { _all: true }
            })
        ]);

        const totalCountMap = Object.fromEntries(totalCounts.map(c => [c.screenId, c._count._all]));
        const todayCountMap = Object.fromEntries(todayCounts.map(c => [c.screenId, c._count._all]));

        return res.json({
            ok: true,
            players: players.map(player => ({
                id: player.id,
                screenId: player.screenId,
                appVersion: player.appVersion,
                flowType: player.flowType,
                deviceName: player.deviceName,
                screenWidth: player.screenWidth,
                screenHeight: player.screenHeight,
                ipAddress: player.ipAddress,
                location: player.location,
                osVersion: player.osVersion,
                heightCalibration: player.heightCalibration ?? 0,
                paymentAmount: player.paymentAmount ?? null,
                playlistId: player.playlistId ?? null,
                flowDrawerEnabled: player.flowDrawerEnabled ?? true,
                appMode: player.appMode ?? "F1",
                rotation: player.rotation ?? "landscape",
                lastSeen: player.lastSeen,
                isActive: player.isActive,
                createdAt: player.createdAt,
                todayData: todayCountMap[player.screenId] || 0,
                totalData: totalCountMap[player.screenId] || 0
            }))
        });
    } catch (e) {
        console.error('[ADSCAPE] Get all players error:', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * Update player flow type
 * PUT /api/adscape/player/:screenId/flow-type
 */
exports.updateFlowType = async (req, res, io) => {
    try {
        const { screenId } = req.params;
        const { flowType } = req.body;

        if (!flowType) {
            return res.status(400).json({ error: 'flowType required' });
        }

        // Normalize flowType: "Normal" becomes null, otherwise keep as is
        const normalizedFlowType = flowType === 'Normal' || flowType === 'normal' || flowType === '' ? null : String(flowType);

        const player = await prisma.adscapePlayer.update({
            where: { screenId: String(screenId) },
            data: { flowType: normalizedFlowType }
        });

        console.log('[ADSCAPE] Flow type updated:', { screenId, flowType: normalizedFlowType });

        // Emit real-time update to Android app via WebSocket
        if (io) {
            io.to(`screen:${String(screenId)}`).emit('flow-type-changed', {
                screenId: String(screenId),
                flowType: normalizedFlowType
            });
            console.log('[ADSCAPE] Flow type change emitted to screen:', screenId);
        }

        return res.json({
            ok: true,
            player: {
                screenId: player.screenId,
                flowType: player.flowType
            }
        });
    } catch (e) {
        console.error('[ADSCAPE] Update flow type error:', e);
        return res.status(500).json({ error: 'Failed to update flow type' });
    }
};

/**
 * Update player status (last seen, isActive)
 * POST /api/players/update-status
 */
exports.updatePlayerStatus = async (req, res) => {
    try {
        const { screenId, isActive } = req.body || {};

        if (!screenId) {
            return res.status(400).json({ error: 'screenId required' });
        }

        const player = await prisma.adscapePlayer.update({
            where: { screenId: String(screenId) },
            data: {
                lastSeen: new Date(),
                ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {})
            }
        });

        console.log('[ADSCAPE] Player status updated:', { screenId, isActive: player.isActive });

        return res.json({
            ok: true,
            player: {
                screenId: player.screenId,
                lastSeen: player.lastSeen,
                isActive: player.isActive
            }
        });
    } catch (e) {
        console.error('[ADSCAPE] Update player status error:', e);
        return res.status(500).json({ error: 'Failed to update player status' });
    }
};

/**
 * Get player by registration code (8-digit code derived from screenId)
 * GET /api/adscape/player-by-code/:code
 */
exports.getPlayerByCode = async (req, res) => {
    try {
        const { code } = req.params;

        if (!code || code.length !== 8) {
            return res.status(400).json({ error: 'Invalid registration code. Must be 8 digits.' });
        }

        // Find player by matching the last 8 characters of screenId
        // or by a generated code (for now, we'll search by screenId ending)
        const players = await prisma.adscapePlayer.findMany({
            where: {
                screenId: {
                    endsWith: code
                }
            }
        });

        if (players.length === 0) {
            return res.status(404).json({ error: 'Player not found' });
        }

        // If multiple matches, return the first one
        const player = players[0];

        return res.json({
            ok: true,
            player: {
                screenId: player.screenId,
                appVersion: player.appVersion,
                flowType: player.flowType,
                deviceName: player.deviceName,
                screenWidth: player.screenWidth,
                screenHeight: player.screenHeight,
                ipAddress: player.ipAddress,
                location: player.location,
                osVersion: player.osVersion,
                appVersionCode: player.appVersionCode,
                lastSeen: player.lastSeen,
                isActive: player.isActive,
                createdAt: player.createdAt,
                updatedAt: player.updatedAt
            }
        });
    } catch (e) {
        console.error('[ADSCAPE] Get player by code error:', e);
        return res.status(500).json({ error: 'internal_error' });
    }
};

/**
 * Upload logo for screen
 * POST /api/adscape/player/:screenId/logo
 */
exports.uploadLogo = async (req, res) => {
    try {
        const { screenId } = req.params;

        if (!req.file) {
            return res.status(400).json({ error: 'No logo file provided' });
        }

        // Check if player exists
        const player = await prisma.adscapePlayer.findUnique({
            where: { screenId: String(screenId) }
        });

        if (!player) {
            return res.status(404).json({ error: 'Player not found' });
        }

        await deleteManagedMediaByUrl(player.logoUrl);
        deleteAssetFileByUrl(player.logoUrl);

        const logoUrlNew = await saveScreenAssetManaged({
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            screenId: String(screenId),
            assetKind: 'logo'
        });

        const updatedPlayer = await prisma.adscapePlayer.update({
            where: { screenId: String(screenId) },
            data: {
                logoUrl: logoUrlNew,
                updatedAt: new Date()
            }
        });

        console.log('[ADSCAPE] Logo uploaded for screen:', screenId);

        return res.json({
            ok: true,
            logoUrl: rewriteAssetUrlForRequest(logoUrlNew, req),
            player: {
                screenId: updatedPlayer.screenId,
                logoUrl: rewriteAssetUrlForRequest(updatedPlayer.logoUrl, req)
            }
        });
    } catch (error) {
        console.error('[ADSCAPE] Upload logo error:', error);
        return res.status(500).json({ error: 'Failed to upload logo' });
    }
};

/**
 * Get logo for screen
 * GET /api/adscape/player/:screenId/logo
 */
exports.getLogo = async (req, res) => {
    try {
        const { screenId } = req.params;

        // Use raw SQL to fetch logoUrl (column might not exist in older schemas)
        let logoUrl = null;
        try {
            const logoResult = await prisma.$queryRaw`
                SELECT "logoUrl" 
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (logoResult && logoResult.length > 0) {
                logoUrl = logoResult[0].logoUrl || null;
            }
        } catch (e) {
            // Column doesn't exist yet or error, return 404
            console.log('[ADSCAPE] Logo column might not exist yet or error:', e.message);
            return res.status(404).json({ ok: false, error: 'Logo not found' });
        }

        if (!logoUrl) {
            return res.status(404).json({ ok: false, error: 'Logo not found' });
        }

        return res.json({
            ok: true,
            logoUrl: logoUrl
        });
    } catch (error) {
        console.error('[ADSCAPE] Get logo error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to get logo' });
    }
};

/**
 * Delete logo for screen
 * DELETE /api/adscape/player/:screenId/logo
 */
exports.deleteLogo = async (req, res) => {
    try {
        const { screenId } = req.params;

        // Check if player exists
        const player = await prisma.adscapePlayer.findUnique({
            where: { screenId: String(screenId) }
        });

        if (!player) {
            return res.status(404).json({ ok: false, error: 'Player not found' });
        }

        await deleteManagedMediaByUrl(player.logoUrl);
        deleteAssetFileByUrl(player.logoUrl);

        // Update player to remove logoUrl
        const updatedPlayer = await prisma.adscapePlayer.update({
            where: { screenId: String(screenId) },
            data: { logoUrl: null, updatedAt: new Date() }
        });

        return res.json({
            ok: true,
            message: 'Logo deleted successfully',
            player: {
                screenId: updatedPlayer.screenId,
                logoUrl: null
            }
        });
    } catch (error) {
        console.error('[ADSCAPE] Delete logo error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to delete logo' });
    }
};

/**
 * Upload flow drawer image for screen
 * POST /api/adscape/player/:screenId/flow-drawer-image/:imageNumber
 */
exports.uploadFlowDrawerImage = async (req, res, io) => {
    try {
        const { screenId, imageNumber } = req.params;

        if (!req.file) {
            return res.status(400).json({ ok: false, error: 'No image file provided' });
        }

        const slotIndex = parseInt(imageNumber) - 1; // Convert to 0-based index
        if (slotIndex < 0) {
            return res.status(400).json({ ok: false, error: 'Image number must be 1 or greater' });
        }

        // Check if player exists
        const player = await prisma.adscapePlayer.findUnique({
            where: { screenId: String(screenId) }
        });

        if (!player) {
            return res.status(404).json({ ok: false, error: 'Player not found' });
        }

        // Get current slot count
        let slotCount = 2; // Default
        let oldImageUrl = null;

        try {
            const configResult = await prisma.$queryRaw`
                SELECT "flowDrawerSlotCount", "flowDrawerImage1Url", "flowDrawerImage2Url",
                       "flowDrawerImage3Url", "flowDrawerImage4Url", "flowDrawerImage5Url"
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (configResult && configResult.length > 0) {
                slotCount = configResult[0].flowDrawerSlotCount || 2;
                // Get old image URL for the slot being updated
                if (slotIndex === 0) oldImageUrl = configResult[0].flowDrawerImage1Url;
                else if (slotIndex === 1) oldImageUrl = configResult[0].flowDrawerImage2Url;
                else if (slotIndex === 2) oldImageUrl = configResult[0].flowDrawerImage3Url;
                else if (slotIndex === 3) oldImageUrl = configResult[0].flowDrawerImage4Url;
                else if (slotIndex === 4) oldImageUrl = configResult[0].flowDrawerImage5Url;
            }
        } catch (e) {
            // Columns might not exist yet, use defaults
            console.log('[ADSCAPE] Flow drawer slot columns might not exist yet, using defaults');
        }

        if (slotIndex >= 5) {
            return res.status(400).json({ ok: false, error: 'Image number must be between 1 and 5' });
        }

        // If the admin increased slot count in the UI but hasn't saved the config yet,
        // allow the image upload and expand the stored slot count to fit the incoming slot.
        const requiredSlotCount = slotIndex >= 4 ? 5 : Math.max(2, slotIndex + 1);
        if (slotCount < requiredSlotCount) {
            const effectiveSlotCount = requiredSlotCount === 4 ? 5 : requiredSlotCount;
            await prisma.$executeRaw`
                UPDATE "AdscapePlayer"
                SET "flowDrawerSlotCount" = ${effectiveSlotCount},
                    "updatedAt" = NOW()
                WHERE "screenId" = ${String(screenId)}
            `;
            slotCount = effectiveSlotCount;
            console.log('[ADSCAPE] Auto-expanded flowDrawerSlotCount during upload to:', slotCount, 'for screen:', screenId);
        }

        await deleteManagedMediaByUrl(oldImageUrl);
        deleteAssetFileByUrl(oldImageUrl);

        const imageUrlNew = await saveScreenAssetManaged({
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            screenId: String(screenId),
            assetKind: 'flow-drawer',
            slotIndex
        });

        const fieldMap = {
            0: 'flowDrawerImage1Url',
            1: 'flowDrawerImage2Url',
            2: 'flowDrawerImage3Url',
            3: 'flowDrawerImage4Url',
            4: 'flowDrawerImage5Url'
        };

        const fieldName = fieldMap[slotIndex];
        if (!fieldName) {
            return res.status(400).json({ ok: false, error: 'Invalid slot number' });
        }

        try {
            await prisma.$executeRawUnsafe(`
                UPDATE "AdscapePlayer"
                SET "${fieldName}" = $1,
                    "updatedAt" = NOW()
                WHERE "screenId" = $2
            `, imageUrlNew, String(screenId));
        } catch (e) {
            console.error('[ADSCAPE] Error updating flow drawer image field:', e);
            throw e;
        }

        // Fetch updated URLs to return in response
        let updatedSlots = [];
        try {
            const updatedResult = await prisma.$queryRaw`
                SELECT "flowDrawerImage1Url", "flowDrawerImage2Url",
                       "flowDrawerImage3Url", "flowDrawerImage4Url", "flowDrawerImage5Url"
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (updatedResult && updatedResult.length > 0) {
                if (slotCount >= 1) updatedSlots.push(rewriteAssetUrlForRequest(updatedResult[0].flowDrawerImage1Url || null, req));
                if (slotCount >= 2) updatedSlots.push(rewriteAssetUrlForRequest(updatedResult[0].flowDrawerImage2Url || null, req));
                if (slotCount >= 3) updatedSlots.push(rewriteAssetUrlForRequest(updatedResult[0].flowDrawerImage3Url || null, req));
                if (slotCount >= 4) updatedSlots.push(rewriteAssetUrlForRequest(updatedResult[0].flowDrawerImage4Url || null, req));
                if (slotCount >= 5) updatedSlots.push(rewriteAssetUrlForRequest(updatedResult[0].flowDrawerImage5Url || null, req));
            }
        } catch (e) {
            console.log('[ADSCAPE] Error fetching updated slots:', e.message);
        }

        console.log(`[ADSCAPE] Flow drawer image ${slotIndex + 1} uploaded for screen:`, screenId);

        if (io) {
            const payload = {
                screenId: String(screenId),
                slotCount,
                slots: updatedSlots,
                reason: 'flow_drawer_upload'
            };
            io.to(`screen:${String(screenId)}`).emit('flow-drawer-images-updated', payload);
            io.to(`screen:${String(screenId)}`).emit('screen-config-changed', payload);
            console.log('[ADSCAPE] Flow drawer upload emitted to screen:', payload);
        }

        return res.json({
            ok: true,
            imageUrl: rewriteAssetUrlForRequest(imageUrlNew, req),
            imageNumber: slotIndex + 1,
            slots: updatedSlots,
            slotCount: slotCount
        });
    } catch (error) {
        console.error('[ADSCAPE] Upload flow drawer image error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to upload flow drawer image' });
    }
};

/**
 * Get flow drawer images for screen
 * GET /api/adscape/player/:screenId/flow-drawer-images
 */
exports.getFlowDrawerImages = async (req, res) => {
    try {
        const { screenId } = req.params;

        // Simplified: just return basic image URLs
        let imageUrls = [];

        try {
            const imageResult = await prisma.$queryRaw`
                SELECT "flowDrawerImage1Url", "flowDrawerImage2Url", 
                       "flowDrawerImage3Url", "flowDrawerImage4Url", "flowDrawerImage5Url"
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;

            if (imageResult && imageResult.length > 0) {
                const urls = [
                    rewriteAssetUrlForRequest(imageResult[0].flowDrawerImage1Url || null, req),
                    rewriteAssetUrlForRequest(imageResult[0].flowDrawerImage2Url || null, req),
                    rewriteAssetUrlForRequest(imageResult[0].flowDrawerImage3Url || null, req),
                    rewriteAssetUrlForRequest(imageResult[0].flowDrawerImage4Url || null, req),
                    rewriteAssetUrlForRequest(imageResult[0].flowDrawerImage5Url || null, req)
                ];
                
                // Filter out null/empty URLs
                imageUrls = urls.filter(url => url && url.trim() !== '');
            }
        } catch (e) {
            console.log('[ADSCAPE] Flow drawer image columns might not exist yet:', e.message);
        }

        console.log('[ADSCAPE] Simplified flow drawer response:', {
            screenId: String(screenId),
            imageCount: imageUrls.length
        });

        return res.json({
            ok: true,
            imageUrls: imageUrls
        });
    } catch (error) {
        console.error('[ADSCAPE] Get flow drawer images error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to get flow drawer images' });
    }
};

/**
 * Delete flow drawer image for screen
 * DELETE /api/adscape/player/:screenId/flow-drawer-image/:imageNumber
 */
exports.deleteFlowDrawerImage = async (req, res, io) => {
    try {
        const { screenId, imageNumber } = req.params;

        const slotIndex = parseInt(imageNumber) - 1; // Convert to 0-based index
        if (slotIndex < 0) {
            return res.status(400).json({ ok: false, error: 'Image number must be 1 or greater' });
        }

        // Check if player exists
        const player = await prisma.adscapePlayer.findUnique({
            where: { screenId: String(screenId) }
        });

        if (!player) {
            return res.status(404).json({ ok: false, error: 'Player not found' });
        }

        // Get current slot count and image URL for the slot
        let slotCount = 2; // Default
        let imageUrl = null;

        try {
            const configResult = await prisma.$queryRaw`
                SELECT "flowDrawerSlotCount", "flowDrawerImage1Url", "flowDrawerImage2Url",
                       "flowDrawerImage3Url", "flowDrawerImage4Url", "flowDrawerImage5Url"
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (configResult && configResult.length > 0) {
                slotCount = configResult[0].flowDrawerSlotCount || 2;
                // Get image URL for the slot being deleted
                if (slotIndex === 0) imageUrl = configResult[0].flowDrawerImage1Url;
                else if (slotIndex === 1) imageUrl = configResult[0].flowDrawerImage2Url;
                else if (slotIndex === 2) imageUrl = configResult[0].flowDrawerImage3Url;
                else if (slotIndex === 3) imageUrl = configResult[0].flowDrawerImage4Url;
                else if (slotIndex === 4) imageUrl = configResult[0].flowDrawerImage5Url;
            }
        } catch (e) {
            // Columns might not exist yet, try legacy fields
            console.log('[ADSCAPE] Flow drawer slot columns might not exist yet, trying legacy fields');
            if (slotIndex === 0) imageUrl = player.flowDrawerImage1Url;
            else if (slotIndex === 1) imageUrl = player.flowDrawerImage2Url;
        }

        // Validate slot index
        if (slotIndex >= slotCount || slotIndex >= 5) {
            return res.status(400).json({ ok: false, error: `Image number must be between 1 and ${Math.min(slotCount, 5)}` });
        }
        if (!imageUrl) {
            return res.status(404).json({ ok: false, error: 'Flow drawer image not found' });
        }

        await deleteManagedMediaByUrl(imageUrl);
        deleteAssetFileByUrl(imageUrl);

        // Determine which field to clear based on slot index
        const fieldMap = {
            0: 'flowDrawerImage1Url',
            1: 'flowDrawerImage2Url',
            2: 'flowDrawerImage3Url',
            3: 'flowDrawerImage4Url',
            4: 'flowDrawerImage5Url'
        };

        const fieldName = fieldMap[slotIndex];
        if (!fieldName) {
            return res.status(400).json({ ok: false, error: 'Invalid slot number' });
        }

        // Update player to clear the individual URL field using raw SQL
        try {
            await prisma.$executeRawUnsafe(`
                UPDATE "AdscapePlayer"
                SET "${fieldName}" = NULL,
                    "updatedAt" = NOW()
                WHERE "screenId" = $1
            `, String(screenId));
        } catch (e) {
            console.error('[ADSCAPE] Error updating flow drawer image field:', e);
            throw e;
        }

        // Fetch updated URLs to return in response
        let updatedSlots = [];
        try {
            const updatedResult = await prisma.$queryRaw`
                SELECT "flowDrawerImage1Url", "flowDrawerImage2Url",
                       "flowDrawerImage3Url", "flowDrawerImage4Url", "flowDrawerImage5Url"
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (updatedResult && updatedResult.length > 0) {
                if (slotCount >= 1) updatedSlots.push(updatedResult[0].flowDrawerImage1Url || null);
                if (slotCount >= 2) updatedSlots.push(updatedResult[0].flowDrawerImage2Url || null);
                if (slotCount >= 3) updatedSlots.push(updatedResult[0].flowDrawerImage3Url || null);
                if (slotCount >= 4) updatedSlots.push(updatedResult[0].flowDrawerImage4Url || null);
                if (slotCount >= 5) updatedSlots.push(updatedResult[0].flowDrawerImage5Url || null);
            }
        } catch (e) {
            console.log('[ADSCAPE] Error fetching updated slots:', e.message);
        }

        if (io) {
            const payload = {
                screenId: String(screenId),
                slotCount,
                slots: updatedSlots,
                reason: 'flow_drawer_delete'
            };
            io.to(`screen:${String(screenId)}`).emit('flow-drawer-images-updated', payload);
            io.to(`screen:${String(screenId)}`).emit('screen-config-changed', payload);
            console.log('[ADSCAPE] Flow drawer delete emitted to screen:', payload);
        }

        return res.json({
            ok: true,
            message: 'Flow drawer image deleted successfully',
            imageNumber: slotIndex + 1,
            slots: updatedSlots,
            slotCount: slotCount
        });
    } catch (error) {
        console.error('[ADSCAPE] Delete flow drawer image error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to delete flow drawer image' });
    }
};

/**
 * Update screen configuration
 * PUT /api/adscape/player/:screenId/config
 */
exports.updateScreenConfig = async (req, res, io) => {
    try {
        const { screenId } = req.params;
        const { flowType, isActive, deviceName, location, heightCalibration, heightCalibrationEnabled, paymentAmount, playlistId, logoUrl, flowDrawerEnabled, flowDrawerSlotCount, hideScreenId, hideAppMargin, smsEnabled, smsLimitPerScreen, resetSmsCount, whatsappEnabled, whatsappLimitPerScreen, resetWhatsAppCount, appMode, rotation } = req.body || {};

        console.log('[ADSCAPE] Update screen config request:', {
            screenId,
            playlistId,
            body: req.body
        });

        const updateData = {};

        if (appMode !== undefined) {
            updateData.appMode = appMode ? String(appMode) : "F1";
        }

        if (rotation !== undefined) {
            updateData.rotation = rotation ? String(rotation) : "landscape";
        }

        if (flowType !== undefined) {
            // Normalize flowType: "Normal" becomes null, otherwise keep as is
            updateData.flowType = flowType === 'Normal' || flowType === 'normal' || flowType === '' ? null : String(flowType);
        }

        if (isActive !== undefined) {
            updateData.isActive = Boolean(isActive);
        }

        if (deviceName !== undefined) {
            updateData.deviceName = deviceName ? String(deviceName) : null;
        }

        if (location !== undefined) {
            updateData.location = location ? String(location) : null;
        }

        if (heightCalibration !== undefined) {
            // Allow null or empty string to clear the calibration (will use default 0 from database)
            if (heightCalibration === null || heightCalibration === undefined || heightCalibration === "") {
                updateData.heightCalibration = 0; // Use 0 instead of null since schema has @default(0)
            } else {
                const numValue = Number(heightCalibration);
                if (isNaN(numValue)) {
                    return res.status(400).json({ error: 'heightCalibration must be a valid number' });
                }
                updateData.heightCalibration = numValue;
            }
        }

        if (heightCalibrationEnabled !== undefined) {
            updateData.heightCalibrationEnabled = Boolean(heightCalibrationEnabled);
        }

        if (paymentAmount !== undefined) {
            // Allow null or empty string to clear the payment amount
            if (paymentAmount === null || paymentAmount === undefined || paymentAmount === "") {
                updateData.paymentAmount = null;
            } else {
                const numValue = Number(paymentAmount);
                if (isNaN(numValue) || numValue < 0) {
                    return res.status(400).json({ error: 'paymentAmount must be a valid positive number' });
                }
                updateData.paymentAmount = numValue;
            }
        }

        if (flowDrawerEnabled !== undefined) {
            updateData.flowDrawerEnabled = Boolean(flowDrawerEnabled);
        }

        if (hideScreenId !== undefined) {
            updateData.hideScreenId = Boolean(hideScreenId);
        }
        if (hideAppMargin !== undefined) {
            updateData.hideAppMargin = Boolean(hideAppMargin);
        }
        if (smsEnabled !== undefined) {
            updateData.smsEnabled = Boolean(smsEnabled);
        }
        if (smsLimitPerScreen !== undefined) {
            if (smsLimitPerScreen === null || smsLimitPerScreen === '') {
                updateData.smsLimitPerScreen = null;
            } else {
                const n = parseInt(smsLimitPerScreen, 10);
                if (isNaN(n) || n < 0) {
                    return res.status(400).json({ error: 'smsLimitPerScreen must be a non-negative integer or empty' });
                }
                updateData.smsLimitPerScreen = n;
            }
        }
        if (whatsappEnabled !== undefined) {
            updateData.whatsappEnabled = Boolean(whatsappEnabled);
        }
        if (whatsappLimitPerScreen !== undefined) {
            if (whatsappLimitPerScreen === null || whatsappLimitPerScreen === '') {
                updateData.whatsappLimitPerScreen = null;
            } else {
                const n = parseInt(whatsappLimitPerScreen, 10);
                if (isNaN(n) || n < 0) {
                    return res.status(400).json({ error: 'whatsappLimitPerScreen must be a non-negative integer or empty' });
                }
                updateData.whatsappLimitPerScreen = n;
            }
        }

        if (flowDrawerSlotCount !== undefined) {
            const slotCount = parseInt(flowDrawerSlotCount);
            if (slotCount !== 2 && slotCount !== 3 && slotCount !== 5) {
                return res.status(400).json({ error: 'flowDrawerSlotCount must be 2, 3, or 5' });
            }
            console.log('[ADSCAPE] Updating flowDrawerSlotCount to:', slotCount, 'for screen:', screenId);
            // Handle slot count update using raw SQL
            try {
                await prisma.$executeRaw`
                    UPDATE "AdscapePlayer"
                    SET "flowDrawerSlotCount" = ${slotCount},
                        "updatedAt" = NOW()
                    WHERE "screenId" = ${String(screenId)}
                `;
                console.log('[ADSCAPE] Successfully updated flowDrawerSlotCount');
            } catch (e) {
                // Column doesn't exist, create it first
                if (e.code === '42703' || e.message?.includes('does not exist')) {
                    console.log('[ADSCAPE] flowDrawerSlotCount column does not exist, creating it...');
                    await prisma.$executeRawUnsafe(`
                        ALTER TABLE "AdscapePlayer" 
                        ADD COLUMN IF NOT EXISTS "flowDrawerSlotCount" INTEGER DEFAULT 2
                    `);
                    // Now update it
                    await prisma.$executeRaw`
                        UPDATE "AdscapePlayer"
                        SET "flowDrawerSlotCount" = ${slotCount},
                            "updatedAt" = NOW()
                        WHERE "screenId" = ${String(screenId)}
                    `;
                } else {
                    throw e;
                }
            }

            // Resize slots array if needed
            try {
                const configResult = await prisma.$queryRaw`
                    SELECT "flowDrawerSlots" 
                    FROM "AdscapePlayer" 
                    WHERE "screenId" = ${String(screenId)} 
                    LIMIT 1
                `;
                let slots = [];
                if (configResult && configResult.length > 0 && configResult[0].flowDrawerSlots) {
                    slots = JSON.parse(JSON.stringify(configResult[0].flowDrawerSlots));
                }

                // Resize array to match new slot count
                while (slots.length < slotCount) {
                    slots.push(null);
                }
                if (slots.length > slotCount) {
                    slots = slots.slice(0, slotCount);
                }

                // Update slots array
                await prisma.$executeRaw`
                    UPDATE "AdscapePlayer"
                    SET "flowDrawerSlots" = ${JSON.stringify(slots)}::jsonb,
                        "updatedAt" = NOW()
                    WHERE "screenId" = ${String(screenId)}
                `;
            } catch (e) {
                // Column might not exist yet, create it
                if (e.code === '42703' || e.message?.includes('does not exist')) {
                    console.log('[ADSCAPE] flowDrawerSlots column does not exist, creating it...');
                    await prisma.$executeRawUnsafe(`
                        ALTER TABLE "AdscapePlayer" 
                        ADD COLUMN IF NOT EXISTS "flowDrawerSlots" JSONB
                    `);
                    // Initialize with empty array
                    const emptySlots = Array(slotCount).fill(null);
                    await prisma.$executeRaw`
                        UPDATE "AdscapePlayer"
                        SET "flowDrawerSlots" = ${JSON.stringify(emptySlots)}::jsonb,
                            "updatedAt" = NOW()
                        WHERE "screenId" = ${String(screenId)}
                    `;
                }
            }
        }

        if (resetSmsCount === true) {
            try {
                await prisma.$executeRawUnsafe(
                    `ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "smsSentCount" INTEGER DEFAULT 0`
                );
                await prisma.$executeRawUnsafe(
                    `UPDATE "AdscapePlayer" SET "smsSentCount" = 0 WHERE "screenId" = $1`,
                    String(screenId)
                );
                console.log('[ADSCAPE] Reset SMS count for screen:', screenId);
            } catch (e) {
                if (e.code !== '42703' && !(e.message && e.message.includes('does not exist'))) {
                    console.warn('[ADSCAPE] Reset SMS count error:', e.message);
                }
            }
        }

        if (Object.keys(updateData).length === 0 && playlistId === undefined && flowDrawerSlotCount === undefined && (smsEnabled === undefined && smsLimitPerScreen === undefined) && (whatsappEnabled === undefined && whatsappLimitPerScreen === undefined) && !(resetSmsCount === true) && !(resetWhatsAppCount === true) && appMode === undefined && rotation === undefined) {
            return res.status(400).json({ error: 'At least one field required for update' });
        }

        // Update player config
        let player = null;
        if (Object.keys(updateData).length > 0) {
            // Check if heightCalibration, heightCalibrationEnabled, paymentAmount, flowDrawerEnabled, or hideScreenId is in updateData - if so, use raw SQL to update them
            // (This is a workaround until Prisma client is regenerated on Vercel)
            const hasHeightCalibration = 'heightCalibration' in updateData;
            const hasHeightCalibrationEnabled = 'heightCalibrationEnabled' in updateData;
            const hasPaymentAmount = 'paymentAmount' in updateData;
            const hasFlowDrawerEnabled = 'flowDrawerEnabled' in updateData;
            const hasHideScreenId = 'hideScreenId' in updateData;
            const hasHideAppMargin = 'hideAppMargin' in updateData;
            const hasSmsEnabled = 'smsEnabled' in updateData;
            const hasSmsLimitPerScreen = 'smsLimitPerScreen' in updateData;
            const hasWhatsAppEnabled = 'whatsappEnabled' in updateData;
            const hasWhatsAppLimitPerScreen = 'whatsappLimitPerScreen' in updateData;
            const hasAppMode = 'appMode' in updateData;
            const hasRotation = 'rotation' in updateData;
            const heightCalibrationValue = updateData.heightCalibration;
            const heightCalibrationEnabledValue = updateData.heightCalibrationEnabled;
            const paymentAmountValue = updateData.paymentAmount;
            const flowDrawerEnabledValue = updateData.flowDrawerEnabled;
            const hideScreenIdValue = updateData.hideScreenId;
            const hideAppMarginValue = updateData.hideAppMargin;
            const smsEnabledValue = updateData.smsEnabled;
            const smsLimitPerScreenValue = updateData.smsLimitPerScreen;
            const whatsappEnabledValue = updateData.whatsappEnabled;
            const whatsappLimitPerScreenValue = updateData.whatsappLimitPerScreen;
            const appModeValue = updateData.appMode;
            const rotationValue = updateData.rotation;

            if (hasHeightCalibration || hasHeightCalibrationEnabled || hasPaymentAmount || hasFlowDrawerEnabled || hasHideScreenId || hasHideAppMargin || hasSmsEnabled || hasSmsLimitPerScreen || hasWhatsAppEnabled || hasWhatsAppLimitPerScreen || hasAppMode || hasRotation) {
                // Remove raw-SQL-managed fields from updateData for Prisma update
                const { heightCalibration, heightCalibrationEnabled, paymentAmount, flowDrawerEnabled, hideScreenId, hideAppMargin, smsEnabled, smsLimitPerScreen, whatsappEnabled, whatsappLimitPerScreen, appMode: appModeField, rotation: rotationField, ...prismaUpdateData } = updateData;

                // Update other fields with Prisma if there are any
                if (Object.keys(prismaUpdateData).length > 0) {
                    player = await prisma.adscapePlayer.update({
                        where: { screenId: String(screenId) },
                        data: prismaUpdateData
                    });
                } else {
                    // Only heightCalibration to update, fetch player first using raw SQL
                    try {
                        const playerResult = await prisma.$queryRaw`
                            SELECT * FROM "AdscapePlayer" WHERE "screenId" = ${String(screenId)} LIMIT 1
                        `;
                        if (playerResult && playerResult.length > 0) {
                            player = playerResult[0];
                        }
                    } catch (e) {
                        // Fallback to Prisma
                        player = await prisma.adscapePlayer.findUnique({
                            where: { screenId: String(screenId) }
                        });
                    }
                }

                // Update heightCalibration and paymentAmount using raw SQL
                // First check if columns exist, if not create them
                const updateFields = [];
                const updateValues = [];

                if (hasHeightCalibration) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "heightCalibration" = ${heightCalibrationValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        // Column doesn't exist, create it first
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] heightCalibration column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "heightCalibration" DOUBLE PRECISION DEFAULT 0
                            `);
                            // Now update it
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "heightCalibration" = ${heightCalibrationValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }

                if (hasHeightCalibrationEnabled) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "heightCalibrationEnabled" = ${heightCalibrationEnabledValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        // Column doesn't exist, create it first
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] heightCalibrationEnabled column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "heightCalibrationEnabled" BOOLEAN DEFAULT true
                            `);
                            // Now update it
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "heightCalibrationEnabled" = ${heightCalibrationEnabledValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }

                if (hasPaymentAmount) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "paymentAmount" = ${paymentAmountValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        // Column doesn't exist, create it first
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] paymentAmount column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "paymentAmount" DOUBLE PRECISION
                            `);
                            // Now update it
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "paymentAmount" = ${paymentAmountValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }

                if (hasFlowDrawerEnabled) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "flowDrawerEnabled" = ${flowDrawerEnabledValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        // Column doesn't exist, create it first
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] flowDrawerEnabled column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "flowDrawerEnabled" BOOLEAN DEFAULT true
                            `);
                            // Now update it
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "flowDrawerEnabled" = ${flowDrawerEnabledValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }

                if (hasHideScreenId) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "hideScreenId" = ${hideScreenIdValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        // Column doesn't exist, create it first
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] hideScreenId column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "hideScreenId" BOOLEAN DEFAULT false
                            `);
                            // Now update it
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "hideScreenId" = ${hideScreenIdValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }

                if (hasHideAppMargin) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "hideAppMargin" = ${hideAppMarginValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] hideAppMargin column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "hideAppMargin" BOOLEAN DEFAULT false
                            `);
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "hideAppMargin" = ${hideAppMarginValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }
                if (hasSmsEnabled) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "smsEnabled" = ${smsEnabledValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                        console.log('[ADSCAPE] Updated smsEnabled to', smsEnabledValue, 'for screen:', screenId);
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            await prisma.$executeRawUnsafe(`ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "smsEnabled" BOOLEAN DEFAULT false`);
                            await prisma.$executeRaw`UPDATE "AdscapePlayer" SET "smsEnabled" = ${smsEnabledValue} WHERE "screenId" = ${String(screenId)}`;
                            console.log('[ADSCAPE] Created smsEnabled column and set to', smsEnabledValue, 'for screen:', screenId);
                        } else throw e;
                    }
                }
                if (hasSmsLimitPerScreen) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "smsLimitPerScreen" = ${smsLimitPerScreenValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            await prisma.$executeRawUnsafe(`ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "smsLimitPerScreen" INTEGER`);
                            await prisma.$executeRaw`UPDATE "AdscapePlayer" SET "smsLimitPerScreen" = ${smsLimitPerScreenValue} WHERE "screenId" = ${String(screenId)}`;
                        } else throw e;
                    }
                }
                if (hasWhatsAppEnabled) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "whatsappEnabled" = ${whatsappEnabledValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                        console.log('[ADSCAPE] Updated whatsappEnabled to', whatsappEnabledValue, 'for screen:', screenId);
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            await prisma.$executeRawUnsafe(`ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "whatsappEnabled" BOOLEAN DEFAULT false`);
                            await prisma.$executeRaw`UPDATE "AdscapePlayer" SET "whatsappEnabled" = ${whatsappEnabledValue} WHERE "screenId" = ${String(screenId)}`;
                            console.log('[ADSCAPE] Created whatsappEnabled column and set to', whatsappEnabledValue, 'for screen:', screenId);
                        } else throw e;
                    }
                }
                if (hasWhatsAppLimitPerScreen) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "whatsappLimitPerScreen" = ${whatsappLimitPerScreenValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            await prisma.$executeRawUnsafe(`ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "whatsappLimitPerScreen" INTEGER`);
                            await prisma.$executeRaw`UPDATE "AdscapePlayer" SET "whatsappLimitPerScreen" = ${whatsappLimitPerScreenValue} WHERE "screenId" = ${String(screenId)}`;
                        } else throw e;
                    }
                }
                if (resetWhatsAppCount === true) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "whatsappSentCount" = 0
                            WHERE "screenId" = ${String(screenId)}
                        `;
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            await prisma.$executeRawUnsafe(`ALTER TABLE "AdscapePlayer" ADD COLUMN IF NOT EXISTS "whatsappSentCount" INTEGER DEFAULT 0`);
                            await prisma.$executeRaw`UPDATE "AdscapePlayer" SET "whatsappSentCount" = 0 WHERE "screenId" = ${String(screenId)}`;
                        } else {
                            console.warn('[ADSCAPE] Reset WhatsApp count error:', e.message);
                        }
                    }
                }
                if (hasAppMode) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "appMode" = ${appModeValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                        console.log('[ADSCAPE] Updated appMode to', appModeValue, 'for screen:', screenId);
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] appMode column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "appMode" VARCHAR(20) DEFAULT 'F1'
                            `);
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "appMode" = ${appModeValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }
                if (hasRotation) {
                    try {
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "rotation" = ${rotationValue}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                        console.log('[ADSCAPE] Updated rotation to', rotationValue, 'for screen:', screenId);
                    } catch (e) {
                        if (e.code === '42703' || e.message?.includes('does not exist')) {
                            console.log('[ADSCAPE] rotation column does not exist, creating it...');
                            await prisma.$executeRawUnsafe(`
                                ALTER TABLE "AdscapePlayer" 
                                ADD COLUMN IF NOT EXISTS "rotation" VARCHAR(20) DEFAULT 'landscape'
                            `);
                            await prisma.$executeRaw`
                                UPDATE "AdscapePlayer"
                                SET "rotation" = ${rotationValue}
                                WHERE "screenId" = ${String(screenId)}
                            `;
                        } else {
                            throw e;
                        }
                    }
                }

                // Fetch updated player using raw SQL to avoid Prisma error
                try {
                    const playerResult = await prisma.$queryRaw`
                        SELECT * FROM "AdscapePlayer" WHERE "screenId" = ${String(screenId)} LIMIT 1
                    `;
                    if (playerResult && playerResult.length > 0) {
                        player = playerResult[0];
                    }
                } catch (e) {
                    // Fallback to Prisma
                    player = await prisma.adscapePlayer.findUnique({
                        where: { screenId: String(screenId) }
                    });
                }
            } else {
                // No heightCalibration, use normal Prisma update
                player = await prisma.adscapePlayer.update({
                    where: { screenId: String(screenId) },
                    data: updateData
                });
            }
        } else {
            player = await prisma.adscapePlayer.findUnique({
                where: { screenId: String(screenId) }
            });
        }

        // Handle playlist assignment (store directly in AdscapePlayer table)
        // Always process playlist assignment if provided (even if null to clear)
        if (playlistId !== undefined) {
            try {
                console.log('[ADSCAPE] Processing playlist assignment:', {
                    screenId,
                    playlistId,
                    playlistIdType: typeof playlistId
                });

                // Determine the playlist ID to use (null if empty string or 'none')
                const finalPlaylistId = playlistId && playlistId !== '' && playlistId !== 'none'
                    ? String(playlistId)
                    : null;

                console.log('[ADSCAPE] Final playlist ID determined:', finalPlaylistId);

                // Update playlistId in AdscapePlayer table using raw SQL (column might not exist yet)
                try {
                    await prisma.$executeRaw`
                        UPDATE "AdscapePlayer"
                        SET "playlistId" = ${finalPlaylistId}
                        WHERE "screenId" = ${String(screenId)}
                    `;
                    console.log('[ADSCAPE] PlaylistId updated successfully in AdscapePlayer table');
                } catch (e) {
                    // Column doesn't exist, create it first
                    if (e.code === '42703' || e.message?.includes('does not exist')) {
                        console.log('[ADSCAPE] playlistId column does not exist, creating it...');
                        await prisma.$executeRawUnsafe(`
                            ALTER TABLE "AdscapePlayer" 
                            ADD COLUMN IF NOT EXISTS "playlistId" VARCHAR(255)
                        `);
                        // Now update it
                        await prisma.$executeRaw`
                            UPDATE "AdscapePlayer"
                            SET "playlistId" = ${finalPlaylistId}
                            WHERE "screenId" = ${String(screenId)}
                        `;
                        console.log('[ADSCAPE] playlistId column created and updated successfully');
                    } else {
                        throw e;
                    }
                }

                // Verify the save by reading it back
                try {
                    const verifyResult = await prisma.$queryRaw`
                        SELECT "playlistId" FROM "AdscapePlayer" WHERE "screenId" = ${String(screenId)} LIMIT 1
                    `;
                    console.log('[ADSCAPE] Verification - saved playlistId:', verifyResult[0]?.playlistId);
                } catch (e) {
                    console.log('[ADSCAPE] Could not verify playlistId (column might not exist yet)');
                }

                console.log('[ADSCAPE] Playlist assignment completed:', { screenId, playlistId: finalPlaylistId });
            } catch (playlistError) {
                console.error('[ADSCAPE] Error updating playlist assignment:', playlistError);
                console.error('[ADSCAPE] Error details:', playlistError.message);
                console.error('[ADSCAPE] Error stack:', playlistError.stack);
                // Log error but don't fail the whole request - screen config update can still succeed
                // The error will be visible in logs for debugging
            }
        } else {
            console.log('[ADSCAPE] No playlist assignment data provided - skipping playlist update');
        }

        console.log('[ADSCAPE] Screen config updated:', { screenId, ...updateData, playlistId });

        // Get current playlistId from AdscapePlayer
        let currentPlaylistId = null;
        try {
            const playlistResult = await prisma.$queryRaw`
                SELECT "playlistId" FROM "AdscapePlayer" WHERE "screenId" = ${String(screenId)} LIMIT 1
            `;
            if (playlistResult && playlistResult.length > 0) {
                currentPlaylistId = playlistResult[0].playlistId || null;
            }
        } catch (e) {
            // Column might not exist yet
        }

        // Emit real-time update if flowType changed
        if (io && updateData.flowType !== undefined) {
            io.to(`screen:${String(screenId)}`).emit('flow-type-changed', {
                screenId: String(screenId),
                flowType: updateData.flowType
            });
            console.log('[ADSCAPE] Flow type change emitted to screen:', screenId);
        }

        // Emit real-time update if appMode changed
        if (io && updateData.appMode !== undefined) {
            io.to(`screen:${String(screenId)}`).emit('screen-mode-changed', {
                screenId: String(screenId),
                appMode: updateData.appMode,
                mode: updateData.appMode
            });
            console.log('[ADSCAPE] Screen mode change emitted to screen:', screenId, 'newMode:', updateData.appMode);
        }

        // Emit real-time update if rotation changed
        if (io && updateData.rotation !== undefined) {
            io.to(`screen:${String(screenId)}`).emit('screen-rotation-changed', {
                screenId: String(screenId),
                rotation: updateData.rotation
            });
            console.log('[ADSCAPE] Screen rotation change emitted to screen:', screenId, 'newRotation:', updateData.rotation);
        }

        // Emit screen-config-changed event when playlist or config is updated
        // This allows Android app to immediately detect playlist changes
        // Emit if playlist was updated OR if screen config (isActive) was updated
        const playlistWasUpdated = playlistId !== undefined;
        const configWasUpdated = updateData.isActive !== undefined || updateData.deviceName !== undefined || updateData.location !== undefined;

        if (io && (playlistWasUpdated || configWasUpdated)) {
            io.to(`screen:${String(screenId)}`).emit('screen-config-changed', {
                screenId: String(screenId),
                playlistId: currentPlaylistId,
                isEnabled: player.isActive, // Map isActive to isEnabled for Android app
                flowType: player.flowType
            });
            console.log('[ADSCAPE] Screen config change emitted to screen:', screenId, {
                playlistId: currentPlaylistId,
                isEnabled: player.isActive,
                reason: playlistWasUpdated ? 'playlist_updated' : 'config_updated'
            });
        }

        // Get heightCalibration from player (it might be updated via raw SQL)
        let heightCalibrationValue = 0;
        try {
            const heightCalResult = await prisma.$queryRaw`
                SELECT COALESCE("heightCalibration", 0) as "heightCalibration" 
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (heightCalResult && heightCalResult.length > 0) {
                heightCalibrationValue = Number(heightCalResult[0].heightCalibration) || 0;
            }
        } catch (e) {
            // Column doesn't exist, use default 0
            heightCalibrationValue = 0;
        }

        // Get logoUrl from player
        let logoUrlValue = null;
        try {
            const logoResult = await prisma.$queryRaw`
                SELECT "logoUrl" 
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (logoResult && logoResult.length > 0) {
                logoUrlValue = logoResult[0].logoUrl || null;
            }
        } catch (e) {
            // Column doesn't exist yet or error, use null
            logoUrlValue = null;
        }

        // Get flowDrawerEnabled from player
        let flowDrawerEnabledValue = true;
        try {
            const drawerResult = await prisma.$queryRaw`
                SELECT COALESCE("flowDrawerEnabled", true) as "flowDrawerEnabled" 
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (drawerResult && drawerResult.length > 0) {
                flowDrawerEnabledValue = Boolean(drawerResult[0].flowDrawerEnabled);
            }
        } catch (e) {
            // Column doesn't exist yet, use default true
            flowDrawerEnabledValue = true;
        }

        // Get hideScreenId from player
        let hideScreenIdValue = false;
        try {
            const hideScreenIdResult = await prisma.$queryRaw`
                SELECT COALESCE("hideScreenId", false) as "hideScreenId" 
                FROM "AdscapePlayer" 
                WHERE "screenId" = ${String(screenId)} 
                LIMIT 1
            `;
            if (hideScreenIdResult && hideScreenIdResult.length > 0) {
                hideScreenIdValue = Boolean(hideScreenIdResult[0].hideScreenId);
            }
        } catch (e) {
            // Column doesn't exist yet, use default false
            hideScreenIdValue = false;
        }

        return res.json({
            ok: true,
            player: {
                screenId: player.screenId,
                flowType: player.flowType,
                isActive: player.isActive,
                isEnabled: player.isActive, // Also include isEnabled for Android app compatibility
                deviceName: player.deviceName,
                location: player.location,
                heightCalibration: heightCalibrationValue,
                playlistId: currentPlaylistId,
                logoUrl: logoUrlValue,
                flowDrawerEnabled: flowDrawerEnabledValue,
                hideScreenId: hideScreenIdValue
            }
        });
    } catch (e) {
        console.error('[ADSCAPE] Update screen config error:', e);
        return res.status(500).json({ error: 'Failed to update screen config' });
    }
};

/**
 * Delete a player
 * DELETE /api/adscape/player/:screenId
 */
exports.deletePlayer = async (req, res) => {
    try {
        const { screenId } = req.params;

        await prisma.adscapePlayer.delete({
            where: { screenId: String(screenId) }
        });

        console.log('[ADSCAPE] Player deleted:', { screenId });

        return res.json({ ok: true, message: 'Player deleted successfully' });
    } catch (e) {
        console.error('[ADSCAPE] Delete player error:', e);
        return res.status(500).json({ error: 'Failed to delete player' });
    }
};



