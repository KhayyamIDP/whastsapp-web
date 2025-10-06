const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const UserSession = require('../models/UserSession');
const { v4: uuidv4 } = require('uuid');
const { notifyQrGenerated, notifyClientReady, notifyClientDisconnected } = require('../services/slackService');
const EventEmitter = require('events');

const sessionsPath = path.join(__dirname, '..', '.wwebjs_auth');
const qrcodesPath = path.join(__dirname, '..', 'qrcodes');

// محدودیت تعداد کلاینت های همزمان
const MAX_CONCURRENT_CLIENTS = 100;
const MAX_PENDING_CLIENTS = 10;

// صف انتظار برای کلاینت ها
const clientQueue = [];
const pendingClients = new Set();

// Event Emitter برای مدیریت صف
const queueManager = new EventEmitter();

// Create necessary directories
if (!fs.existsSync(qrcodesPath)) {
    fs.mkdirSync(qrcodesPath, { recursive: true });
}
if (!fs.existsSync(sessionsPath)) {
    fs.mkdirSync(sessionsPath, { recursive: true });
}

// Helper function to wait for a specified time
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// بهبود یافته resolveExecutablePath با اولویت بندی بهتر
function resolveExecutablePath() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_PATH,
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium'
    ].filter(Boolean);

    const validPath = candidates.find(p => {
        try {
            return fs.existsSync(p) && fs.accessSync(p, fs.constants.X_OK) === undefined;
        } catch {
            return false;
        }
    });

    if (!validPath) {
        console.warn('[puppeteer] No valid Chrome/Chromium executable found. This may cause issues.');
    }

    return validPath;
}

// تابع بهینه سازی شده برای پاک کردن فایل
const safeDeleteFile = async(filePath, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            if (fs.existsSync(filePath)) {
                await fsPromises.unlink(filePath);
                console.log(`✅ File deleted: ${path.basename(filePath)}`);
            }
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return true; // File already deleted
            if (i === maxRetries - 1) {
                console.error(`❌ Failed to delete file after ${maxRetries} attempts: ${filePath}`, error.message);
                return false;
            }
            console.log(`⏳ Retry ${i + 1}/${maxRetries} to delete file: ${path.basename(filePath)}`);
            await wait(1000 * (i + 1)); // Progressive delay
        }
    }
    return false;
};

// تابع بهینه سازی شده برای پاک کردن دایرکتوری
const safeDeleteDirectory = async(dirPath, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            if (fs.existsSync(dirPath)) {
                await fsPromises.rm(dirPath, { recursive: true, force: true });
                console.log(`✅ Directory deleted: ${path.basename(dirPath)}`);
            }
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return true; // Directory already deleted
            if (i === maxRetries - 1) {
                console.error(`❌ Failed to delete directory after ${maxRetries} attempts: ${dirPath}`, error.message);
                return false;
            }
            console.log(`⏳ Retry ${i + 1}/${maxRetries} to delete directory: ${path.basename(dirPath)}`);
            await wait(2000 * (i + 1)); // Progressive delay
        }
    }
    return false;
};

// چک کردن تعداد کلاینت های فعال
function getActiveClientCount(clients) {
    return Object.keys(clients).length;
}

// چک کردن تعداد کلاینت های در انتظار
function getPendingClientCount() {
    return pendingClients.size;
}

// تنظیمات بهینه و پایدار Puppeteer برای سرور Ubuntu
function getPuppeteerConfig() {
    const execPath = resolveExecutablePath();

    return {
        headless: true,
        executablePath: execPath,
        args: [
            '--headless=new',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            // '--single-process', // این فلگ حذف شد چون باعث ناپایداری می شود
            '--no-zygote',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
        ],
        defaultViewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: true,
    };
}


// This is the core logic for creating a client. It's now a standalone async function.
const createClientInternal = async(clients, req, res) => {
    let newId;
    let client;
    let userSession;
    let cleanup = false;
    let timeouts = [];

    try {
        newId = uuidv4();
        pendingClients.add(newId);
        const clientSessionPath = path.join(sessionsPath, `session-${newId}`);
        const qrCodePath = path.join(qrcodesPath, `${newId}.png`);

        console.log(`🚀 Creating client ${newId} (Active: ${getActiveClientCount(clients)}, Pending: ${getPendingClientCount()})`);

        userSession = await UserSession.create({
            userId: newId,
            sessionId: newId,
            status: 'initializing',
            sessionPath: clientSessionPath
        });

        client = new Client({
            authStrategy: new LocalAuth({
                clientId: newId,
                dataPath: sessionsPath,
            }),
            puppeteer: getPuppeteerConfig(),
            qrMaxRetries: 3,
            authTimeoutMs: 120000,
            qrTimeoutMs: 90000,
            restartOnAuthFail: false
        });

        clients[newId] = client;
        let qrGenerated = false;
        let isInitialized = false;
        let isResponseSent = false;

        const overallTimeout = setTimeout(async() => {
            if (!isInitialized && !cleanup) {
                console.log(`⏰ Client ${newId} overall timeout. Cleaning up...`);
                cleanup = true;
                await cleanupClient(client, newId, userSession, qrCodePath, clientSessionPath, clients);
            }
        }, 5 * 60 * 1000);
        timeouts.push(overallTimeout);

        const qrTimeout = setTimeout(async() => {
            if (!qrGenerated && !isResponseSent && !cleanup) {
                console.error(`⏰ QR generation timeout for client ${newId}`);
                cleanup = true;
                if (res && !res.headersSent) {
                    res.status(408).json({
                        status: 'timeout',
                        message: 'QR code generation timed out',
                        clientId: newId
                    });
                    isResponseSent = true;
                }
                await cleanupClient(client, newId, userSession, qrCodePath, clientSessionPath, clients);
            }
        }, 90000);
        timeouts.push(qrTimeout);

        let scanTimeout;

        client.on('qr', async(qr) => {
            if (!qrGenerated && !cleanup) {
                console.log(`📱 QR Code generated for client ${newId}`);
                qrGenerated = true;
                clearTimeout(qrTimeout);

                try {
                    await qrcode.toFile(qrCodePath, qr, {
                        type: 'png',
                        errorCorrectionLevel: 'M',
                        margin: 1,
                        width: 256,
                        scale: 4
                    });

                    scanTimeout = setTimeout(async() => {
                        if (!isInitialized && !cleanup) {
                            console.log(`📱 QR scan timeout for client ${newId} - cleaning up unused session`);
                            cleanup = true;
                            await cleanupClient(client, newId, userSession, qrCodePath, clientSessionPath, clients);
                        }
                    }, 10 * 60 * 1000);
                    timeouts.push(scanTimeout);

                    await Promise.all([
                        notifyQrGenerated(newId).catch(err =>
                            console.warn(`Failed to notify QR generation: ${err.message}`)
                        ),
                        userSession.update({
                            status: 'pending_scan',
                            lastActivity: new Date()
                        })
                    ]);

                    if (res && !res.headersSent && !isResponseSent) {
                        res.status(200).json({
                            status: 'success',
                            message: 'QR code generated successfully',
                            clientId: newId,
                            qrUrl: `/qrcodes/${newId}.png`,
                            scanTimeout: 600000
                        });
                        isResponseSent = true;
                    }

                } catch (err) {
                    console.error(`❌ Error handling QR code for client ${newId}:`, err);
                    if (res && !res.headersSent && !isResponseSent) {
                        res.status(500).json({
                            status: 'error',
                            message: 'Failed to generate QR code',
                            error: err.message
                        });
                        isResponseSent = true;
                    }
                    cleanup = true;
                    await cleanupClient(client, newId, userSession, qrCodePath, clientSessionPath, clients);
                }
            }
        });

        client.on('ready', async() => {
            if (!cleanup) {
                timeouts.forEach(timeout => clearTimeout(timeout));
                timeouts = [];
                isInitialized = true;
                console.log(`✅ Client ${newId} is ready!`);
                pendingClients.delete(newId);
                try {
                    await Promise.all([
                        notifyClientReady(newId).catch(err =>
                            console.warn(`Failed to notify client ready: ${err.message}`)
                        ),
                        safeDeleteFile(qrCodePath),
                        userSession.update({
                            status: 'connected',
                            lastActivity: new Date()
                        })
                    ]);
                } catch (err) {
                    console.error(`❌ Error in ready event for client ${newId}:`, err);
                }
            }
        });

        client.on('authenticated', () => {
            if (!cleanup) {
                console.log(`🔐 Client ${newId} authenticated successfully`);
                if (scanTimeout) {
                    clearTimeout(scanTimeout);
                }
            }
        });

        client.on('auth_failure', async(msg) => {
            if (!cleanup) {
                console.error(`🔐 Client ${newId} authentication failed:`, msg);
                cleanup = true;
                timeouts.forEach(timeout => clearTimeout(timeout));
                await cleanupClient(client, newId, userSession, qrCodePath, clientSessionPath, clients);
            }
        });

        client.on('disconnected', async(reason) => {
            if (!cleanup) {
                console.log(`🔌 Client ${newId} disconnected: ${reason}`);
                cleanup = true;
                timeouts.forEach(timeout => clearTimeout(timeout));
                await cleanupClient(client, newId, userSession, qrCodePath, clientSessionPath, clients);
                try {
                    await notifyClientDisconnected(newId, reason).catch(err =>
                        console.warn(`Failed to notify client disconnection: ${err.message}`)
                    );
                } catch (err) {
                    console.error(`❌ Error notifying disconnection for client ${newId}:`, err);
                }
            }
        });

        client.on('error', async(error) => {
            if (!cleanup) {
                console.error(`❌ Client ${newId} error:`, error);
                cleanup = true;
                timeouts.forEach(timeout => clearTimeout(timeout));
                await cleanupClient(client, newId, userSession, qrCodePath, clientSessionPath, clients);
            }
        });

        console.log(`⚙️ Initializing client ${newId}...`);
        await userSession.update({ status: 'initializing' });
        await client.initialize();
        console.log(`✅ Client ${newId} initialization completed`);

    } catch (err) {
        console.error('❌ Failed to create new client:', err.message);
        if (newId) {
            await cleanupClient(client, newId, userSession, path.join(qrcodesPath, `${newId}.png`), path.join(sessionsPath, `session-${newId}`), clients);
        }
        if (res && !res.headersSent) {
            return res.status(500).json({
                status: 'error',
                message: 'Internal server error while creating client',
                error: err.message
            });
        }
    }
};

const createClient = (clients) => (req, res) => {
    const activeCount = getActiveClientCount(clients);
    const pendingCount = getPendingClientCount();

    if (activeCount >= MAX_CONCURRENT_CLIENTS) {
        if (clientQueue.length >= 10) {
            return res.status(429).json({
                status: 'error',
                message: 'Server is at maximum capacity. Please try again later.',
                activeClients: activeCount,
                queueLength: clientQueue.length
            });
        }
        console.log(`📋 Adding client to queue (Active: ${activeCount}, Queue: ${clientQueue.length})`);
        clientQueue.push({ clients, req, res });
        return res.status(202).json({
            status: 'queued',
            message: 'Your request has been queued and will be processed shortly.',
            position: clientQueue.length,
            activeClients: activeCount
        });
    }

    if (pendingCount >= MAX_PENDING_CLIENTS) {
        return res.status(429).json({
            status: 'error',
            message: 'Too many pending connections. Please try again later.',
            pendingClients: pendingCount
        });
    }

    createClientInternal(clients, req, res);
};

function processQueue(clients) {
    if (clientQueue.length === 0) return;

    const activeCount = getActiveClientCount(clients);
    const pendingCount = getPendingClientCount();

    if (activeCount < MAX_CONCURRENT_CLIENTS && pendingCount < MAX_PENDING_CLIENTS) {
        const queueItem = clientQueue.shift();
        if (queueItem) {
            console.log(`📋 Processing queued client request (Queue: ${clientQueue.length}, Active: ${activeCount}, Pending: ${pendingCount})`);
            createClientInternal(queueItem.clients, queueItem.req, queueItem.res);
        }
    }
}


async function cleanupClient(client, clientId, userSession, qrCodePath, clientSessionPath, clients) {
    console.log(`🧹 Starting cleanup for client ${clientId}`);

    try {
        pendingClients.delete(clientId);

        if (client) {
            try {
                if (client.pupPage && !client.pupPage.isClosed()) {
                    await client.pupPage.close();
                }
            } catch (err) {
                // Ignore errors on page close as browser might be already gone
            }
            try {
                if (client.pupBrowser && client.pupBrowser.isConnected()) {
                    await client.pupBrowser.close();
                }
            } catch (err) {
                // Ignore errors on browser close as it might have crashed
            }
            try {
                await client.destroy();
                console.log(`🗑️ Client destroyed for ${clientId}`);
            } catch (err) {
                // Ignore error, client might be in a bad state
            }
        }

        if (clients && clients[clientId]) {
            delete clients[clientId];
            console.log(`🗑️ Client ${clientId} removed from memory`);
        }

        const cleanupPromises = [];
        if (qrCodePath) {
            cleanupPromises.push(safeDeleteFile(qrCodePath));
        }
        if (clientSessionPath) {
            cleanupPromises.push(safeDeleteDirectory(clientSessionPath));
        }
        await Promise.all(cleanupPromises);

        if (userSession) {
            try {
                await userSession.destroy();
                console.log(`💾 Database session destroyed for client ${clientId}`);
            } catch (err) {
                console.error(`❌ Error destroying database session for client ${clientId}:`, err.message);
            }
        }

        setImmediate(() => {
            processQueue(clients);
        });

    } catch (err) {
        console.error(`❌ Error during cleanup for client ${clientId}:`, err);
    }

    console.log(`✅ Cleanup completed for client ${clientId} (Active: ${getActiveClientCount(clients)}, Pending: ${getPendingClientCount()})`);
}

async function logoutClient(userId, clients) {
    try {
        console.log(`🚪 Starting logout process for user ${userId}`);

        const session = await UserSession.findOne({
            where: { userId: userId }
        });

        if (!session) {
            console.warn(`⚠️ Logout attempt for non-existent session: ${userId}`);
            return true;
        }

        const client = clients[userId];
        const qrCodePath = path.join(qrcodesPath, `${userId}.png`);
        const clientSessionPath = path.join(sessionsPath, `session-${userId}`);

        await cleanupClient(client, userId, session, qrCodePath, clientSessionPath, clients);

        console.log(`✅ Logout completed successfully for user ${userId}`);
        return true;

    } catch (error) {
        console.error(`❌ Error during logout for user ${userId}:`, error);
        throw error;
    }
}


async function cleanupStaleSessions(clients) {
    try {
        const now = new Date();
        const staleThreshold = new Date(now - 6 * 60 * 60 * 1000);
        const veryOldThreshold = new Date(now - 24 * 60 * 60 * 1000);

        const staleSessions = await UserSession.findAll({
            where: {
                [require('sequelize').Op.or]: [{
                        status: ['pending_scan', 'initializing'],
                        lastActivity: {
                            [require('sequelize').Op.lt]: staleThreshold
                        }
                    },
                    {
                        status: ['disconnected', 'error', 'timeout'],
                        lastActivity: {
                            [require('sequelize').Op.lt]: veryOldThreshold
                        }
                    }
                ]
            }
        });

        if (staleSessions.length > 0) {
            console.log(`🧹 Found ${staleSessions.length} stale sessions to cleanup`);
            for (const session of staleSessions) {
                try {
                    const client = clients[session.userId];
                    const qrCodePath = path.join(qrcodesPath, `${session.userId}.png`);
                    const clientSessionPath = path.join(sessionsPath, `session-${session.userId}`);
                    await cleanupClient(client, session.userId, session, qrCodePath, clientSessionPath, clients);
                    console.log(`✅ Cleaned up stale session: ${session.userId}`);
                } catch (err) {
                    console.error(`❌ Error cleaning up stale session ${session.userId}:`, err);
                }
            }
        }
        return staleSessions.length;
    } catch (error) {
        console.error('❌ Error during stale session cleanup:', error);
        return 0;
    }
}

function getClientHealth(clientId, clients) {
    const client = clients[clientId];
    if (!client) {
        return { status: 'not_found', healthy: false };
    }
    const health = {
        status: 'unknown',
        healthy: false,
        details: {
            hasPage: !!client.pupPage,
            pageOpen: client.pupPage && !client.pupPage.isClosed(),
            hasBrowser: !!client.pupBrowser,
            browserConnected: client.pupBrowser && client.pupBrowser.isConnected && client.pupBrowser.isConnected(),
            hasInfo: !!client.info,
            hasWid: !!(client.info && client.info.wid),
            memoryUsage: process.memoryUsage()
        }
    };
    const { hasPage, pageOpen, hasBrowser, browserConnected, hasInfo, hasWid } = health.details;
    if (hasPage && pageOpen && hasBrowser && browserConnected && hasInfo && hasWid) {
        health.status = 'ready';
        health.healthy = true;
    } else if (hasPage && pageOpen && hasBrowser && browserConnected) {
        health.status = 'initializing';
        health.healthy = false;
    } else if (hasPage || hasBrowser) {
        health.status = 'starting';
        health.healthy = false;
    } else {
        health.status = 'disconnected';
        health.healthy = false;
    }
    return health;
}

function getServerStatus(clients) {
    const activeCount = getActiveClientCount(clients);
    const pendingCount = getPendingClientCount();
    const queueLength = clientQueue.length;
    const memUsage = process.memoryUsage();
    return {
        server: {
            activeClients: activeCount,
            pendingClients: pendingCount,
            queueLength: queueLength,
            maxConcurrent: MAX_CONCURRENT_CLIENTS,
            maxPending: MAX_PENDING_CLIENTS,
            memory: {
                rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
                heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
                external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
            }
        },
        clients: Object.keys(clients).reduce((acc, id) => {
            acc[id] = getClientHealth(id, clients);
            return acc;
        }, {})
    };
}

module.exports = {
    createClient,
    logoutClient,
    cleanupStaleSessions,
    getClientHealth,
    getServerStatus,
    processQueue
};
