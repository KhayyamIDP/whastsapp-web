const https = require('https');
const { Client } = require('whatsapp-web.js');
const { notifyServiceStatus } = require('../services/slackService');

const checkWhatsAppServer = () => async(req, res) => {
    try {
        // Quick check of WhatsApp API servers first (faster)
        const apiStatus = await checkWhatsAppAPIServers();

        // If any API server is accessible, return true immediately
        const isAnyServerAccessible = Object.values(apiStatus).some(status => status === true);
        if (isAnyServerAccessible) {
            return res.json(true);
        }

        // If API servers are not accessible, try a quick WhatsApp Web check
        const canConnect = await checkWhatsAppWebConnection();

        // If WhatsApp is down, send notification to Slack
        if (!canConnect) {
            try {
                await notifyServiceStatus({
                    service: {
                        isRunning: false,
                        activeClients: 0
                    },
                    sessions: {
                        total: 0,
                        connected: 0,
                        pending: 0,
                        disconnected: 0
                    },
                    timestamp: new Date().toISOString()
                });
                console.log('WhatsApp down notification sent to Slack');
            } catch (slackError) {
                console.error('Failed to send WhatsApp down notification to Slack:', slackError);
            }
        }

        return res.json(canConnect);

    } catch (err) {
        console.error('Error checking WhatsApp server status:', err);
        return res.json(false);
    }
};

// Function to check WhatsApp Web connection - optimized for speed
const checkWhatsAppWebConnection = () => {
    return new Promise((resolve) => {
        // Create a temporary client with minimal settings for faster initialization
        const tempClient = new Client({
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                timeout: 5000 // 5 seconds timeout for Puppeteer
            }
        });

        // Shorter timeout
        let connectionTimeout = setTimeout(() => {
            tempClient.destroy();
            resolve(false);
        }, 5000); // 5 seconds timeout

        tempClient.on('qr', () => {
            clearTimeout(connectionTimeout);
            tempClient.destroy();
            resolve(true);
        });

        tempClient.on('ready', () => {
            clearTimeout(connectionTimeout);
            tempClient.destroy();
            resolve(true);
        });

        tempClient.on('auth_failure', () => {
            clearTimeout(connectionTimeout);
            tempClient.destroy();
            resolve(false);
        });

        tempClient.initialize().catch(() => {
            clearTimeout(connectionTimeout);
            tempClient.destroy();
            resolve(false);
        });
    });
};

// Function to check WhatsApp API servers - optimized for speed
const checkWhatsAppAPIServers = () => {
    return new Promise((resolve) => {
        // Check only the most critical server
        const server = 'web.whatsapp.com';

        const results = {};

        // Set a very short timeout
        const requestTimeout = setTimeout(() => {
            results[server] = false;
            resolve(results);
        }, 3000); // 3 seconds timeout

        https.get(`https://${server}`, (res) => {
            clearTimeout(requestTimeout);
            results[server] = res.statusCode >= 200 && res.statusCode < 300;
            resolve(results);
        }).on('error', () => {
            clearTimeout(requestTimeout);
            results[server] = false;
            resolve(results);
        });
    });
};

module.exports = checkWhatsAppServer;