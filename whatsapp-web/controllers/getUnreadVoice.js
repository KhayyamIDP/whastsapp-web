const fs = require('fs');
const path = require('path');
const UserSession = require('../models/UserSession');
const mime = require('mime-types');

function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_\-]/gi, '_');
}

const getUnreadVoiceMessages = (clients) => async (req, res) => {
    const { id, chatId } = req.query;

    if (!id || !chatId) {
        return res.status(400).json({ status: 'error', message: 'id and chatId are required' });
    }

    try {
        const userSession = await UserSession.findOne({
            where: {
                userId: id,
                status: 'connected'
            }
        });

        if (!userSession) {
            return res.status(404).json({ status: 'error', message: 'Client not found or disconnected' });
        }

        if (!clients[id]) {
            await UserSession.update({ status: 'disconnected' }, { where: { userId: id } });
            return res.status(404).json({ status: 'error', message: 'Client session not found' });
        }

        const chat = await clients[id].getChatById(chatId);
        if (!chat) {
            return res.status(404).json({ status: 'error', message: 'Chat not found' });
        }

        const messages = await chat.fetchMessages({ limit: 100 });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const unreadVoiceMessages = messages.filter(msg => {
            const isVoice = msg.type === 'audio' || msg.type === 'ptt';
            const msgDate = new Date(msg.timestamp * 1000);
            const isToday = msgDate >= today;
            const isUnread = (msg.hasRead === false || (msg.ack !== undefined && msg.ack < 3));
            return isVoice && isToday && isUnread;
        });

        // Create voices directory if it doesn't exist
        const voicesDir = path.join('myvoices');
        if (!fs.existsSync(voicesDir)) {
            fs.mkdirSync(voicesDir, { recursive: true });
        }

        const downloaded = [];
        for (let msg of unreadVoiceMessages) {
            try {
                const media = await msg.downloadMedia();
                if (!media) continue;
        
                const contact = await msg.getContact();
                const senderName = contact.name || contact.number;
        
                const date = new Date(msg.timestamp * 1000);
                const formattedDate = date.toISOString().replace(/[:.]/g, '-');
        
                const filename = `${sanitizeFilename(senderName)}_${formattedDate}.mp3`;
                const filepath = path.join(voicesDir, filename);
        
                if (fs.existsSync(filepath)) {
                    console.log(`File already exists, skipping: ${filename}`);
                    continue;
                }
        
                fs.writeFileSync(filepath, media.data, { encoding: 'base64' });
        
                downloaded.push({
                    file: filename,
                    timestamp: date,
                    from: msg.from,
                    senderName: senderName
                });
        
            } catch (e) {
                console.error('Download failed for a message:', e.message);
            }
        }
        await chat.sendSeen();
        return res.json({ status: 'success', downloaded });

    } catch (err) {
        console.error('Error fetching unread voice messages:', err.message);
        return res.status(500).json({ status: 'error', message: 'Failed to fetch unread voice messages', error: err.message });
    }
};

module.exports = getUnreadVoiceMessages;
