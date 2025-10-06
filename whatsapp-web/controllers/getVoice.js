const fs = require('fs');
const path = require('path');
const UserSession = require('../models/UserSession');
const mime = require('mime-types');

const getVoiceMessages = (clients) => async(req, res) => {
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

        // Get messages from last 15 minutes
        const messages = await chat.fetchMessages({ limit: 100 });
        const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

        const voiceMessages = messages.filter(msg => {
            const isVoice = msg.type === 'audio' ||
                msg.type === 'ptt' ||
                msg.type === 'voice' ||
                (msg.type === 'media' && msg.mimetype && msg.mimetype.startsWith('audio/'));
            const msgDate = new Date(msg.timestamp * 1000);
            return isVoice && msgDate >= fifteenMinutesAgo;
        });

        const unreadVoiceMessages = voiceMessages.filter(msg => !msg.hasRead);

        // Create myvoices directory if it doesn't exist
        const voicesDir = path.join('myvoices');
        if (!fs.existsSync(voicesDir)) {
            fs.mkdirSync(voicesDir, { recursive: true });
        }

        const downloaded = [];
        const downloadedUnread = [];
        const timestampCounters = new Map();

        for (let msg of voiceMessages) {
            try {
                const media = await msg.downloadMedia();
                if (!media) continue;
                let extension = mime.extension(media.mimetype);
                if (media.mimetype === 'audio/mp4' || media.mimetype === 'audio/x-m4a' || media.mimetype === 'audio/aac') {
                    extension = 'm4a';
                } else if (media.mimetype === 'audio/ogg' || media.mimetype === 'audio/opus') {
                    extension = 'ogg';
                } else if (media.mimetype === 'audio/mpeg') {
                    extension = 'mp3';
                }
                const sender = msg.from.split('@')[0];
                let counter = timestampCounters.get(msg.timestamp) || 0;
                counter++;
                timestampCounters.set(msg.timestamp, counter);
                const filename = counter === 1 ?
                    `${sender}_voice_${msg.timestamp}.${extension}` :
                    `${sender}_voice_${msg.timestamp}_${counter}.${extension}`;
                const filepath = path.join(voicesDir, filename);
                if (!fs.existsSync(filepath)) {
                    fs.writeFileSync(filepath, media.data, { encoding: 'base64' });
                }
                const fileInfo = {
                    file: filename,
                    timestamp: new Date(msg.timestamp * 1000),
                    from: msg.from,
                    mimetype: media.mimetype,
                    isUnread: !msg.hasRead,
                    messageType: msg.type
                };
                downloaded.push(fileInfo);
                if (!msg.hasRead) {
                    downloadedUnread.push(fileInfo);
                }
            } catch (e) {
                console.error('Download failed for a message:', e.message);
            }
        }

        // Mark all messages as seen at once
        if (voiceMessages.length > 0) {
            await chat.sendSeen();
        }

        res.json({
            status: 'success',
            allVoiceMessages: downloaded,
            unreadVoiceMessages: downloadedUnread,
            allCount: downloaded.length,
            unreadCount: downloadedUnread.length
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Failed to fetch voice messages', error: err.message });
    }
};
module.exports = getVoiceMessages;