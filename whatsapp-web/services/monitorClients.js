// services/monitorClients.js
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const UserSession = require('../models/UserSession');
const { safeDeleteFile, safeDeleteDirectory } = require('./cleanupHelpers');

const sessionsPath = path.join(__dirname, '..', '.wwebjs_auth');
const EXPIRATION_TIME = 25 * 60 * 1000;

const monitorClients = async(clients) => {
    console.log(`[Monitor] Checking for expired or inactive clients...`);
    const now = Date.now();

    const expiredSessions = await UserSession.findAll({
        where: {
            status: ['error', 'disconnected', 'timeout']
        }
    });

    for (const session of expiredSessions) {
        const lastActivity = session.lastActivity || session.createdAt;
        const age = now - new Date(lastActivity).getTime();

        if (age > EXPIRATION_TIME) {
            const sessionId = session.sessionId;
            const qrCodePath = session.qrCodePath;
            const sessionFolder = path.join(sessionsPath, `session-${sessionId}`);

            if (qrCodePath && fs.existsSync(qrCodePath)) {
                await safeDeleteFile(qrCodePath);
            }

            if (fs.existsSync(sessionFolder)) {
                await safeDeleteDirectory(sessionFolder);
            }

            if (clients[sessionId]) {
                try {
                    await clients[sessionId].destroy();
                } catch (err) {
                    console.error(`[Monitor] Failed to destroy client ${sessionId}:`, err.message);
                }
                delete clients[sessionId];
            }

            await session.destroy();
            console.log(`[Monitor] Deleted expired session from database: ${sessionId}`);
        }
    }

    console.log(`[Monitor] Done.`);
};

module.exports = monitorClients;