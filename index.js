// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: [
            'http://localhost:5173',
            'http://localhost:5174',
            'http://localhost:3000',
            'http://localhost:8080',
            'https://bmi-client.vercel.app',
            'https://bmi-client.onrender.com',
            'https://adscape.co.in',
            'https://admin.adscape.co.in',
            'https://billboard-admin-x.vercel.app',
            'http://127.0.0.1:5500',
            'https://bmi-client.onrender.com',
            'https://bmi-admin-pi.vercel.app',
            'http://4.240.88.83',
            'https://api.well2day.in',
            'https://app.well2day.in',
            'https://admin.well2day.in'


        ],
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
        credentials: true
    }
});
// Prisma - use shared instance
const prisma = require('./db');

// Enhanced CORS configuration
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8080',
    'http://localhost:8081',
    'http://localhost:8082',
    'https://bmi-client.vercel.app',
    'https://bmi-client.onrender.com',
    'https://adscape.co.in',
    'https://admin.adscape.co.in',
    'https://billboard-admin-x.vercel.app',
    'http://127.0.0.1:5500',
    'https://bmi-admin-pi.vercel.app',
    'http://4.240.88.83',
    'https://api.well2day.in',
    'https://app.well2day.in',
    'https://admin.well2day.in',
];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'X-Requested-With', 'Range'],
    exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
    credentials: true,
    maxAge: 86400
}));

// Manual CORS middleware to ensure headers are always present
app.use((req, res, next) => {
    const origin = req.headers.origin;

    // Reflect the origin if present (required for credentials: true)
    if (origin) {
        res.header('Access-Control-Allow-Origin', origin);
    } else {
        // Fallback for requests without origin (though browsers always send it for CORS)
        res.header('Access-Control-Allow-Origin', '*');
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning, X-Requested-With, Range');
    res.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400'); // 24 hours

    // Handle OPTIONS preflight requests immediately
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

app.use(express.json({ limit: '1024mb' }));
app.use(express.urlencoded({ limit: '1024mb', extended: true }));
// Basic request logger
app.use((req, _res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    if (req.method !== 'GET') {
        try {
            console.log('[HTTP] body:', JSON.stringify(req.body));
            console.log('[HTTP] body type:', typeof req.body);
            console.log('[HTTP] body length:', req.body ? Object.keys(req.body).length : 'null');
        } catch (e) {
            console.log('[HTTP] body parse error:', e.message);
        }
    }
    next();
});

// BMI Flow Routes
const bmiFlowRoutes = require('./routes/bmiFlowRoutes');

// Admin Panel Routes
const adminRoutes = require('./routes/adminRoutes');
const screenRoutes = require('./routes/screenRoutes');
const billboardRoutes = require('./routes/billboardRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const slotRoutes = require('./routes/slotRoutes');
const registrationRoutes = require('./routes/registrationRoutes');

// Track last connection failure (so SOCKET_STATUS can report "why" when no one is connected)
let lastConnectionError = null;
io.engine.on('connection_error', (err) => {
    lastConnectionError = {
        code: err.code,
        message: err.message,
        context: err.context,
        at: new Date().toISOString()
    };
    console.log('[SOCKET] ❌ Connection attempt failed:', err.code, err.message, err.context || '');
});

// Players join rooms by screenId
io.on('connection', (socket) => {
    lastConnectionError = null; // clear so next "why NO" is not stale
    console.log('[SOCKET] ✅✅✅ NEW CONNECTION ESTABLISHED');
    console.log('[SOCKET] Socket ID:', socket.id);
    console.log('[SOCKET] Client IP:', socket.handshake.address);
    console.log('[SOCKET] Transport:', socket.conn.transport.name);
    console.log('[SOCKET] Total connected sockets:', io.sockets.sockets.size);

    socket.on('player-join', (data) => {
        try {
            const screenId = String(data?.screenId || '');
            console.log('═══════════════════════════════════════════════════════════════');
            console.log('[SOCKET] 🔔🔔🔔 PLAYER-JOIN EVENT RECEIVED 🔔🔔🔔');
            console.log('[SOCKET] Socket ID:', socket.id);
            console.log('[SOCKET] Screen ID:', screenId);
            console.log('[SOCKET] Data:', JSON.stringify(data));
            console.log('═══════════════════════════════════════════════════════════════');

            if (screenId) {
                const roomName = `screen:${screenId}`;

                // Leave any previous rooms this socket might be in (except its own socket room)
                const currentRooms = Array.from(socket.rooms).filter(room => room !== socket.id);
                if (currentRooms.length > 0) {
                    currentRooms.forEach(room => socket.leave(room));
                    console.log(`[SOCKET] Left previous rooms: ${currentRooms.join(", ")}`);
                }

                socket.join(roomName);
                const room = io.sockets.adapter.rooms.get(roomName);
                const roomSize = room ? room.size : 0;
                const isInRoom = socket.rooms.has(roomName);

                console.log(`[SOCKET] ✅✅✅ Socket ${socket.id} joined room: ${roomName}`);
                console.log(`[SOCKET] Room members count: ${roomSize}`);
                console.log(`[SOCKET] Room exists: ${room !== undefined}`);
                console.log(`[SOCKET] Socket is in room: ${isInRoom}`);
                console.log(`[SOCKET] All rooms for this socket: ${Array.from(socket.rooms).join(", ")}`);

                // Verify room membership
                if (!isInRoom) {
                    console.log(`[SOCKET] ⚠️⚠️⚠️ WARNING: Socket claims to have joined but is not in room!`);
                    // Try joining again
                    socket.join(roomName);
                    console.log(`[SOCKET] Retried join, now in room: ${socket.rooms.has(roomName)}`);
                }

                // Emit confirmation back to client
                socket.emit('room-joined', {
                    roomName: roomName,
                    screenId: screenId,
                    roomSize: roomSize,
                    socketId: socket.id,
                    confirmed: true
                });
                console.log(`[SOCKET] ✅ Sent room-joined confirmation to socket ${socket.id}`);
                console.log(`[SOCKET] Room ${roomName} now has ${roomSize} member(s)`);
            } else {
                console.log('[SOCKET] ⚠️⚠️⚠️ player-join received but screenId is empty or invalid');
                socket.emit('room-join-error', { error: 'screenId is required' });
            }
        } catch (e) {
            console.error('[SOCKET] ❌❌❌ player-join error:', e);
            socket.emit('room-join-error', { error: e.message });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('[SOCKET] ⚠️ Socket disconnected');
        console.log('[SOCKET] Socket ID:', socket.id);
        console.log('[SOCKET] Reason:', reason);
        console.log('[SOCKET] Remaining connected sockets:', io.sockets.sockets.size);
    });

    // Handle ping/pong for connection health
    socket.on('ping', () => {
        socket.emit('pong');
    });
});

// Periodic socket connection status log (interval in seconds, default 30)
const SOCKET_STATUS_INTERVAL_MS = (parseInt(process.env.SOCKET_STATUS_INTERVAL_SEC, 10) || 30) * 1000;

function logSocketStatus() {
    const totalSockets = io.sockets.sockets.size;
    const screenRooms = [];
    io.sockets.adapter.rooms.forEach((socketsSet, roomName) => {
        if (String(roomName).startsWith('screen:')) {
            screenRooms.push({ room: roomName, size: socketsSet.size });
        }
    });
    const established = totalSockets > 0;
    console.log('[SOCKET_STATUS] ─── ' + new Date().toISOString() + ' ───');
    console.log('[SOCKET_STATUS] Connections established: ' + (established ? 'YES' : 'NO') + ' | Total sockets: ' + totalSockets);
    if (screenRooms.length) {
        console.log('[SOCKET_STATUS] Screen rooms: ' + screenRooms.map(r => r.room + '(' + r.size + ')').join(', '));
    } else {
        console.log('[SOCKET_STATUS] Screen rooms: (none)');
    }
    if (!established) {
        if (lastConnectionError) {
            console.log('[SOCKET_STATUS] Why NO: last attempt failed — code ' + lastConnectionError.code + ' "' + lastConnectionError.message + '" at ' + lastConnectionError.at);
            console.log('[SOCKET_STATUS_] Code hints: 3=proxy/WebSocket headers, 4=allowRequest/CORS, 5=protocol version. See server/NGINX_SOCKET_IO.md');
        } else {
            console.log('[SOCKET_STATUS] Why NO: no client has reached this server yet. Check: Nginx proxies /socket.io/ with Upgrade+Connection; client uses https://api.well2day.in; CORS allows origin. See server/NGINX_SOCKET_IO.md');
        }
    }
}

logSocketStatus(); // Log once at startup
setInterval(logSocketStatus, SOCKET_STATUS_INTERVAL_MS);

// Serve static assets from ASSETS_DIR at /assets (for local dev; in production Nginx typically serves https://api.well2day.in/assets from /var/www/assets)
const ASSETS_DIR = process.env.ASSETS_DIR || '/var/www/assets';
const mediaAssetController = require('./controllers/mediaController')(null);
app.get('/assets/media/:mediaId/:filename', mediaAssetController.serveMediaAsset);
app.get('/assets/:type/:filename', mediaAssetController.serveLegacyAsset);
app.use('/assets', express.static(ASSETS_DIR));

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Internal polling status (Direct DB fetch)
app.get('/api/payment-status/:bmiId', async (req, res) => {
    try {
        const { bmiId } = req.params;
        const record = await prisma.bMI.findUnique({
            where: { id: bmiId },
            select: { paymentStatus: true }
        });
        return res.json({ ok: true, paymentStatus: !!record?.paymentStatus });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Health Tips
const healthTipsController = require('./controllers/healthTipsController');
app.get('/api/health-tips/:category', healthTipsController.getHealthTips);


// Mount BMI Flow Routes
app.use('/api', bmiFlowRoutes(io));

// Mount Auth Routes
app.use('/api', require('./routes/authRoutes'));

// Mount OTP Routes
app.use('/api', require('./routes/otpRoutes'));

// Mount Admin Panel Routes
app.use('/api', adminRoutes);
console.log('[SERVER] Admin routes mounted at /api');
app.use('/api', screenRoutes(io)); // Pass io for real-time updates
app.use('/api/billboards', billboardRoutes(io));
app.use('/api', campaignRoutes(io));
app.use('/api', slotRoutes);
app.use('/api/registrations', registrationRoutes);
app.use('/api/media', require('./routes/mediaRoutes')(io));
app.use('/api/folders', require('./routes/folderRoutes')(io));
app.use('/api', require('./routes/playlistRoutes')(io));
app.use('/api', require('./routes/scheduleRoutes'));
app.use('/api', require('./routes/defaultAssetRoutes'));
app.use('/api', require('./routes/appReleaseRoutes')(io));
const paymentRoutes = require('./routes/paymentRoutes');
app.use('/api', paymentRoutes(io));
console.log('[SERVER] Payment routes mounted at /api');

// Asset Cleanup Service - Scheduled task
const assetCleanupService = require('./services/assetCleanupService');

// Run asset cleanup every 24 hours (86400000 ms)
// Note: This cleans up assets on the server if stored there
// For Android devices, they should call the cleanup API endpoint periodically
const ASSET_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Initial cleanup on server start (after 1 minute delay)
setTimeout(() => {
    console.log('[ASSET_CLEANUP] Running initial asset cleanup check...');
    // Note: This would need the actual path where assets are stored on the server
    // For now, this is a placeholder - Android devices will handle their own cleanup
}, 60000);

// Periodic cleanup
setInterval(() => {
    console.log('[ASSET_CLEANUP] Running periodic asset cleanup...');
    // Note: This would need the actual path where assets are stored on the server
    // For now, this is a placeholder - Android devices will handle their own cleanup
}, ASSET_CLEANUP_INTERVAL);

// Playlist Cleanup Service - Scheduled task to clear expired playlist assignments
const playlistCleanupService = require('./services/playlistCleanupService');

// Start playlist cleanup service (runs every hour by default)
// This will automatically delete playlist assignments that have expired (end_date < current time)
const PLAYLIST_CLEANUP_INTERVAL_MINUTES = parseInt(process.env.PLAYLIST_CLEANUP_INTERVAL_MINUTES || '60', 10);
playlistCleanupService.startPlaylistCleanupService(PLAYLIST_CLEANUP_INTERVAL_MINUTES);

// API endpoint for asset cleanup (can be called by Android devices or manually)
app.post('/api/assets/cleanup', async (req, res) => {
    try {
        const { directoryPath, retentionDays } = req.body;
        const retention = retentionDays || assetCleanupService.ASSET_RETENTION_DAYS;

        if (!directoryPath) {
            return res.status(400).json({
                error: 'directoryPath is required',
                message: 'Provide the path to the directory containing assets to clean up'
            });
        }

        const results = await assetCleanupService.cleanupAssets(directoryPath, retention);

        res.json({
            ok: true,
            message: `Asset cleanup completed. Deleted: ${results.deleted}, Errors: ${results.errors}`,
            results
        });
    } catch (error) {
        console.error('[ASSET_CLEANUP] API error:', error);
        res.status(500).json({
            error: 'Asset cleanup failed',
            message: error.message
        });
    }
});

// API endpoint to get asset statistics
app.get('/api/assets/stats', async (req, res) => {
    try {
        const { directoryPath, retentionDays } = req.query;
        const retention = retentionDays ? parseInt(retentionDays, 10) : assetCleanupService.ASSET_RETENTION_DAYS;

        if (!directoryPath) {
            return res.status(400).json({
                error: 'directoryPath is required',
                message: 'Provide the path to the directory containing assets'
            });
        }

        const stats = await assetCleanupService.getAssetStats(directoryPath, retention);

        res.json({
            ok: true,
            retentionDays: retention,
            stats
        });
    } catch (error) {
        console.error('[ASSET_CLEANUP] Stats API error:', error);
        res.status(500).json({
            error: 'Failed to get asset stats',
            message: error.message
        });
    }
});


const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Server listening on :${PORT}`);
    console.log('[SOCKET] Socket.IO at /socket.io/ — if behind Nginx, proxy WebSocket for that path (see server/NGINX_SOCKET_IO.md)');
});

// Set server timeouts for large file uploads
server.timeout = 10 * 60 * 1000; // 10 minutes
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;



// Global error handler
app.use((err, req, res, next) => {
    console.error('[SERVER] Global error:', err);
    res.status(500).json({
        error: 'internal_server_error',
        message: err.message,
        path: req.path
    });
});

// Catch-all route (must be last)
app.use('*', (req, res) => {
    console.log(`[SERVER] 404 for ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        error: 'not_found',
        message: `Endpoint ${req.method} ${req.originalUrl} not found`,
        path: req.originalUrl
    });
});
