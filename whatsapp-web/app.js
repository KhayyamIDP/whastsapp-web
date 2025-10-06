const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const { createClient, logoutClient } = require('./controllers/createClient');
const getStatus = require('./controllers/getStatus');
const getVoiceMessages = require('./controllers/getVoice');
const getUnreadVoiceMessages = require('./controllers/getUnreadVoice');
const sendMessageAndFile = require('./controllers/sendMessage');
const { getChats, getRecentLongMessages, getMessagesByTimestamp } = require('./controllers/getchats');
const verifyApiKey = require('./middleware/auth');
const getServiceStatus = require('./controllers/getServiceStatus');
const checkWhatsAppServer = require('./controllers/checkWhatsAppServer');

const app = express();

app.use(bodyParser.json());

// Make clients accessible as an app property
app.clients = {};
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// Helper function to check client status
const checkClientStatus = async(clientId) => {
    if (!app.clients[clientId]) {
        return { exists: false, status: 'not_found' };
    }

    try {
        const state = await app.clients[clientId].getState();
        return { exists: true, status: state };
    } catch (err) {
        return { exists: true, status: 'error', error: err.message };
    }
};

if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR);
}

// Apply API key authentication to all routes
app.use(verifyApiKey);

app.get('/clients', (req, res) => {
    const clientIds = Object.keys(app.clients);
    res.status(200).json({ status: 'success', active_clients: clientIds });
});

// Add a new route to check client status
app.get('/client-status/:id', async(req, res) => {
    const { id } = req.params;
    const status = await checkClientStatus(id);
    res.json(status);
});
app.get('/voice', getVoiceMessages(app.clients));
app.get('/unread-voice', getUnreadVoiceMessages(app.clients));
app.post('/send-message-file', sendMessageAndFile(app.clients));
app.get('/status', getStatus(app.clients));
app.post('/new-client', createClient(app.clients));
app.get('/chats', getChats(app.clients));
app.get('/messages', getRecentLongMessages(app.clients));
app.get('/filter', (req, res, next) => {
    getMessagesByTimestamp(app.clients)(req, res, next);
});
app.get('/report', getServiceStatus(app.clients));
app.get('/check', checkWhatsAppServer());

// Add the logout route
app.delete('/api/:userId/logout', async(req, res) => {
    try {
        const result = await logoutClient(req.params.userId, app.clients);
        res.json(result);
    } catch (error) {
        res.status(400).json(false);
    }
});

// Serve QR codes with authentication
app.use('/qrcodes/:id.png', verifyApiKey, (req, res, next) => {
    const filePath = path.join(__dirname, 'qrcodes', `${req.params.id}.png`);
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            return res.status(404).json({ status: 'error', message: 'فایل یافت نشد' });
        }
        next();
    });
});
app.use('/qrcodes', verifyApiKey, express.static(path.join(__dirname, 'qrcodes')));

module.exports = app;