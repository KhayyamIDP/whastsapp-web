const { MessageMedia } = require('whatsapp-web.js');
const UserSession = require('../models/UserSession');

const sendMessageAndFile = (clients) => async(req, res) => {
    const { id, chatId, message, filePath } = req.body;

    if (!id || !chatId || !message || !filePath) {
        return res.status(400).json({
            status: 'error',
            message: 'id, chatId, message, and filePath are required'
        });
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

        // Send text message
        await chat.sendMessage(message);

        // Create media from file path
        const media = MessageMedia.fromFilePath(filePath);

        // Send file
        await chat.sendMessage(media);

        res.json({
            status: 'success',
            message: 'Message and file sent successfully'
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to send message and file',
            error: err.message
        });
    }
};

module.exports = sendMessageAndFile;