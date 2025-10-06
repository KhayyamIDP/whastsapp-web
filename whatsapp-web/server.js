require('dotenv').config();
const express = require('express');
const app = require('./app');
const path = require('path');
const fs = require('fs');
const sequelize = require('./config/database');
const { Client, LocalAuth } = require('whatsapp-web.js');
const UserSession = require('./models/UserSession');
const cron = require('node-cron');
const monitorClients = require('./services/monitorClients');
const { Sequelize } = require('sequelize');
const { default: pLimit } = require('p-limit');

const port = process.env.PORT || 3001;

// تنظیمات محدودیت منابع
const MAX_CONCURRENT_INITIALIZATIONS = 2;
const INITIALIZATION_TIMEOUT = 60000; // 1 minute

// Helper function for timeout
const initializeWithTimeout = (client, timeoutMs = INITIALIZATION_TIMEOUT) => {
    return Promise.race([
        client.initialize(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Client initialize timeout')), timeoutMs)
        )
    ]);
};

// تابع بهبود یافته cleanup
async function cleanupClient(client, clientId, userSession, qrCodePath, clientSessionPath, clients) {
    console.log(`🧹 Cleaning up client ${clientId}...`);

    try {
        // پاکسازی منابع کلاینت
        if (client) {
            try {
                if (client.pupPage && !client.pupPage.isClosed()) {
                    await client.pupPage.close();
                }
                if (client.pupBrowser && client.pupBrowser.isConnected()) {
                    await client.pupBrowser.close();
                }
                await client.destroy();
            } catch (error) {
                console.error(`❌ Error destroying client ${clientId}:`, error.message);
            }
        }

        // حذف از حافظه
        if (clients && clients[clientId]) {
            delete clients[clientId];
        }

        // پاکسازی فایل ها
        const cleanupPromises = [];

        if (qrCodePath && fs.existsSync(qrCodePath)) {
            cleanupPromises.push(fs.promises.unlink(qrCodePath).catch(err =>
                console.error(`Error deleting QR: ${err.message}`)
            ));
        }

        if (clientSessionPath && fs.existsSync(clientSessionPath)) {
            cleanupPromises.push(fs.promises.rm(clientSessionPath, {
                recursive: true,
                force: true
            }).catch(err =>
                console.error(`Error deleting session path: ${err.message}`)
            ));
        }

        await Promise.allSettled(cleanupPromises);

        // بروزرسانی دیتابیس (حذف کامل نشست)
        if (userSession) {
            try {
                // First, ensure the session object is up-to-date if it's managed by Sequelize
                if (userSession.destroy) {
                    await userSession.destroy();
                } else {
                    // Fallback for plain objects
                    await UserSession.destroy({ where: { userId: clientId } });
                }
            } catch (error) {
                console.error(`❌ Error destroying session in database for ${clientId}:`, error.message);
            }
        }

        console.log(`✅ Cleanup completed for client ${clientId}`);

    } catch (error) {
        console.error(`❌ Error during cleanup for client ${clientId}:`, error);
    }
}

// تابع بهبود یافته initialization کلاینت ها
const initializeClients = async() => {
    try {
        console.log('🔄 Starting client initialization process...');

        // همگام سازی دیتابیس
        await sequelize.sync();
        console.log('✅ Database synchronized');

        // پیدا کردن سشن های متصل
        const connectedSessions = await UserSession.findAll({
            where: { status: 'connected' }
        });

        console.log(`📊 Found ${connectedSessions.length} connected sessions in database`);

        // پاکسازی سشن های غیر متصل
        const deletedCount = await UserSession.destroy({
            where: {
                status: {
                    [Sequelize.Op.ne]: 'connected'
                }
            }
        });

        if (deletedCount > 0) {
            console.log(`🗑️ Deleted ${deletedCount} non-connected sessions from database`);
        }

        // محدود کردن همزمانی initialization
        const initLimit = pLimit(MAX_CONCURRENT_INITIALIZATIONS);

        // آمار initialization
        let successCount = 0;
        let failureCount = 0;

        const initializationTasks = connectedSessions.map(session =>
            initLimit(async() => {
                const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${session.userId}`);

                // بررسی وجود فایل سشن
                if (!fs.existsSync(sessionPath)) {
                    console.log(`❌ Session path not found for user ${session.userId}, deleting from database...`);
                    await session.destroy();
                    return;
                }

                console.log(`⚙️ Initializing client for user ${session.userId}...`);

                let client;
                try {
                    // تنظیمات بهینه کلاینت
                    client = new Client({
                        authStrategy: new LocalAuth({
                            clientId: session.userId,
                            dataPath: path.join(__dirname, '.wwebjs_auth')
                        }),
                        puppeteer: {
                            headless: true,
                            args: [
                                '--headless=new',
                                '--no-sandbox',
                                '--disable-setuid-sandbox',
                                '--disable-dev-shm-usage',
                                '--disable-gpu',
                                '--disable-software-rasterizer',
                                '--single-process',
                                '--no-zygote',
                                '--disable-features=VizDisplayCompositor',
                                '--memory-pressure-off'
                            ],
                            defaultViewport: null
                        }
                    });

                    // تنظیم event handlers برای monitoring
                    client.on('disconnected', async(reason) => {
                        console.log(`🔌 Client ${session.userId} disconnected: ${reason}`);
                        await cleanupClient(client, session.userId, session, null, sessionPath, app.clients);
                    });

                    client.on('error', async(error) => {
                        console.error(`❌ Client ${session.userId} error:`, error.message);
                        await cleanupClient(client, session.userId, session, null, sessionPath, app.clients);
                    });

                    app.clients[session.userId] = client;

                    // initialization با timeout
                    await initializeWithTimeout(client, INITIALIZATION_TIMEOUT);

                    // بروزرسانی آخرین فعالیت
                    await session.update({ lastActivity: new Date() });

                    console.log(`✅ Client ${session.userId} initialized successfully`);
                    successCount++;

                } catch (error) {
                    console.error(`❌ Failed to initialize client ${session.userId}:`, error.message);
                    failureCount++;

                    // پاکسازی کلاینت ناموفق
                    await cleanupClient(client, session.userId, session, null, sessionPath, app.clients);
                }
            })
        );

        // اجرای همه initialization ها
        await Promise.allSettled(initializationTasks);

        console.log(`📊 Client initialization completed: ${successCount} successful, ${failureCount} failed`);

        // گزارش نهایی
        const finalActiveCount = Object.keys(app.clients).length;
        console.log(`✅ ${finalActiveCount} clients are now active and ready`);

        // آزادسازی حافظه
        if (global.gc) {
            global.gc();
            console.log('🧹 Garbage collection completed');
        }

    } catch (error) {
        console.error('❌ Error during client initialization:', error);
    }
};

// تابع شروع سرور با مدیریت خطا
const startServer = async() => {
    try {
        // تست اتصال دیتابیس
        await sequelize.authenticate();
        console.log('✅ Database connection established successfully');

        // شروع سرور
        const server = app.listen(port, '0.0.0.0', async() => {
            console.log(`🚀 Server is running on http://0.0.0.0:${port}`);
            console.log(`🏠 Local access: http://127.0.0.1:${port}`);

            // تنظیم cron job برای monitoring
            cron.schedule('*/15 * * * *', async() => {
                try {
                    console.log('⏰ Running scheduled monitoring...');
                    await monitorClients(app.clients);
                    console.log('✅ Scheduled monitoring completed');
                } catch (error) {
                    console.error('❌ Error in scheduled monitoring:', error);
                }
            });

            console.log('⏰ Monitoring cron job scheduled (every 15 minutes)');

            // اجرای initialization کلاینت ها
            await initializeClients();
        });

        // مدیریت خاتمه برنامه (Graceful Shutdown)
        const shutdown = async(signal) => {
            console.log(`\n🚦 Received ${signal}. Shutting down gracefully...`);

            // ۱. بستن سرور HTTP
            server.close(() => {
                console.log('✅ HTTP server closed.');
            });

            // ۲. قطع اتصال تمام کلاینت‌های فعال
            const activeClients = Object.values(app.clients);
            if (activeClients.length > 0) {
                console.log(`🔌 Disconnecting ${activeClients.length} active clients...`);
                await Promise.all(
                    activeClients.map(client => client.destroy().catch(err => console.error(`Error destroying a client: ${err.message}`)))
                );
                console.log('✅ All clients disconnected.');
            }

            // ۳. بستن اتصال دیتابیس
            try {
                await sequelize.close();
                console.log('💾 Database connection closed.');
            } catch (error) {
                console.error('❌ Error closing database connection:', error);
            }

            // ۴. خروج از برنامه
            process.exit(0);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

// مدیریت خطاهای پیش بینی نشده
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('🔥 Uncaught Exception:', error);
    process.exit(1);
});

// اجرای برنامه
startServer();