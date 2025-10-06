const UserSession = require('../models/UserSession');
const fs = require('fs');
const path = require('path');


const getChats = (clients) => async(req, res) => {
    const { id } = req.query;

    try {
        // Check if client exists in database
        const userSession = await UserSession.findOne({
            where: {
                userId: id,
            }
        });

        if (!userSession) {
            return res.status(404).json({ status: 'error', message: 'Client not found or disconnected' });
        }
        // console.log('Received client ID:', clients);

        if (!clients[id]) {
            // Update client status to disconnected in database
            await UserSession.update({ status: 'disconnected' }, { where: { userId: id } });
            return res.status(404).json({ status: 'error', message: 'Client session not found' });
        }

        const chats = await clients[id].getChats();
        const groupDetails = chats.map(group => ({
            id: group.id._serialized,
            name: group.name || 'Unnamed Group',
            unreadCount: group.unreadCount,
            isMuted: group.isMuted,
            muteExpiration: group.muteExpiration ? new Date(group.muteExpiration * 1000) : null,
            lastMessage: group.lastMessage ? {
                body: group.lastMessage.body,
                from: group.lastMessage.from,
                timestamp: new Date(group.lastMessage.timestamp * 1000)
            } : null
        }));

        res.json({ status: 'success', groups: groupDetails });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Failed to fetch chats', error: err.message });
    }
};


const getRecentLongMessages = (clients) => async(req, res) => {
    const { id, chatId } = req.query;

    if (!id || !chatId) {
        return res.status(400).json({ status: 'error', message: 'id and chatId are required' });
    }

    try {
        // Check if client exists in database
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
            // Update client status to disconnected in database
            await UserSession.update({ status: 'disconnected' }, { where: { userId: id } });
            return res.status(404).json({ status: 'error', message: 'Client session not found' });
        }

        const chat = await clients[id].getChatById(chatId);
        if (!chat) {
            return res.status(404).json({ status: 'error', message: 'Chat not found' });
        }

        const messages = await chat.fetchMessages({ limit: 500 });

        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        // Ensure downloads directory exists
        const downloadsDir = path.join(__dirname, '../newdownloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir);
        }

        // Get the last message timestamp or current time
        const lastMessage = messages.length > 0 ? messages[0] : null;
        const timestamp = lastMessage ? lastMessage.timestamp : Math.floor(Date.now() / 1000);

        const filteredMessages = await Promise.all(messages
            .filter(msg => {
                const messageDate = new Date(msg.timestamp * 1000);
                // Only include:
                // - chat messages with body length > 5
                // - image/video messages with caption (caption length > 5)
                if (messageDate < threeDaysAgo) return false;
                if (msg.type === 'chat' && msg.body.length > 5) return true;
                if ((msg.type === 'image' || msg.type === 'video') && msg.body && msg.body.trim().length > 5) return true;
                return false;
            })
            .map(async(msg) => {
                const rawId = msg.author || msg.from;
                const phoneNumber = rawId.split('@')[0];

                let contactInfo = {
                    id: rawId,
                    phoneNumber,
                    name: 'Unknown',
                };

                try {
                    const contact = await clients[id].getContactById(rawId);
                    contactInfo = {
                        id: contact.id._serialized,
                        phoneNumber: contact.id.user,
                        name: contact.pushname || contact.name || 'Unnamed',
                    };
                } catch (err) {}

                let body = msg.body;
                let attach = null;
                let file = null;
                if (msg.type === 'image' || msg.type === 'video') {
                    body = msg.body;
                    attach = msg.type === 'image' ? 'img' : (msg.type === 'video' ? 'video' : null);
                    try {
                        const media = await msg.downloadMedia();
                        if (media) {
                            const ext = msg.type === 'image' ? 'jpg' : 'mp4';
                            const filename = `${msg.id.id}.${ext}`;
                            const downloadPath = path.join(downloadsDir, filename);
                            fs.writeFileSync(downloadPath, media.data, 'base64');
                            file = filename;
                        }
                    } catch (err) {
                        file = null;
                    }
                }

                return {
                    id: msg.id.id,
                    body,
                    type: msg.type,
                    timestamp: new Date(msg.timestamp * 1000),
                    sender: contactInfo,
                    attach,
                    file
                };
            }));

        res.json({
            status: 'success',
            chatName: chat.name || 'Unnamed Chat',
            timestamp: timestamp,
            datetime: new Date(timestamp * 1000).toISOString(),
            messages: filteredMessages
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Failed to fetch recent messages', error: err.message });
    }
};


const getMessagesByTimestamp = (clients) => async(req, res) => {
    const { id, chatId, timestamp } = req.query;

    if (!id || !chatId) {
        return res.status(400).json({ status: 'error', message: 'id and chatId are required' });
    }

    // Default timestamp to one hour ago if not provided
    let effectiveTimestamp = timestamp;
    if (!effectiveTimestamp) {
        effectiveTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago in seconds
    }

    try {
        // Check if client exists in database
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
            // Update client status to disconnected in database
            await UserSession.update({ status: 'disconnected' }, { where: { userId: id } });
            return res.status(404).json({ status: 'error', message: 'Client session not found' });
        }

        // Format chatId if it's a phone number
        let formattedChatId = chatId;

        const chat = await clients[id].getChatById(formattedChatId);
        if (!chat) {
            return res.status(404).json({ status: 'error', message: 'Chat not found' });
        }

        // Parse the timestamp
        const targetTimestamp = parseInt(effectiveTimestamp);
        if (isNaN(targetTimestamp)) {
            return res.status(400).json({ status: 'error', message: 'Invalid timestamp format' });
        }

        // Get the last message to get its timestamp
        const lastMessage = await chat.fetchMessages({ limit: 1 });
        const lastMessageTimestamp = lastMessage.length > 0 ? lastMessage[0].timestamp : targetTimestamp;

        const messages = await chat.fetchMessages({ limit: 500 });

        // // Only send to Slack if chatId matches a specific value
        // const SPECIAL_CHAT_ID = '989369825338@c.us'; // <-- Replace with your desired chatId value
        // if (chatId === SPECIAL_CHAT_ID) {
        //     messages.forEach((msg) => {
        //         notifySentMessage({...msg, chatName: chat.name || 'Unnamed Chat' }).catch(() => {});
        //     });
        // }

        // Ensure downloads directory exists
        const downloadsDir = path.join(__dirname, '../newdownloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir);
        }

        const filteredMessages = await Promise.all(messages
            .filter(msg => {
                // Only include:
                // - chat messages
                // - image/video messages with caption
                if (msg.timestamp < targetTimestamp) return false;
                if (msg.type === 'chat') return true;
                if ((msg.type === 'image' || msg.type === 'video') && msg.body && msg.body.trim() !== '') return true;
                return false;
            })
            .map(async(msg) => {
                const rawId = msg.author || msg.from;
                const phoneNumber = rawId.split('@')[0];

                let contactInfo = {
                    id: rawId,
                    phoneNumber,
                    name: 'Unknown',
                };

                try {
                    const contact = await clients[id].getContactById(rawId);
                    contactInfo = {
                        id: contact.id._serialized,
                        phoneNumber: contact.id.user,
                        name: contact.pushname || contact.name || 'Unnamed',
                        timestamp: new Date(msg.timestamp * 1000).toISOString()
                    };
                } catch (err) {}

                let body = msg.body;
                let attach = null;
                let file = null;
                let mimetype = null;
                let slackBody = body;
                let slackType = msg.type;
                if (msg.type === 'image' || msg.type === 'video') {
                    body = msg.body;
                    attach = msg.type === 'image' ? 'img' : (msg.type === 'video' ? 'video' : null);
                    slackBody = msg.body;
                    slackType = msg.type;
                    try {
                        const media = await msg.downloadMedia();
                        if (media) {
                            const ext = msg.type === 'image' ? 'jpg' : 'mp4';
                            const filename = `${id}_${msg.id.id}.${ext}`;
                            const downloadPath = path.join(downloadsDir, filename);
                            fs.writeFileSync(downloadPath, media.data, 'base64');
                            file = filename;
                            mimetype = media.mimetype;
                        }
                    } catch (err) {
                        file = null;
                    }
                }

                // Return for API response
                return {
                    id: msg.id.id,
                    body,
                    sender: contactInfo,
                    attach,
                    file,
                    mimetype
                };
            }));

        res.json({
            status: 'success',
            chatName: chat.name || 'Unnamed Chat',
            requestedTimestamp: targetTimestamp,
            Timestamp: lastMessageTimestamp,
            DateTime: new Date(lastMessageTimestamp * 1000).toISOString(),
            messages: filteredMessages
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Failed to fetch messages by timestamp', error: err.message });
    }
};

module.exports = { getChats, getRecentLongMessages, getMessagesByTimestamp }