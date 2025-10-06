const UserSession = require('../models/UserSession');

const getStatus = (clients) => async(req, res) => {
    const { id } = req.query;

    try {
        // Check if user exists in database
        const userSession = await UserSession.findOne({
            where: {
                userId: id
            }
        });

        if (!userSession) {
            return res.status(404).json({ status: 'error', message: 'User not found in database' });
        }

        if (!clients[id]) {
            // Update status to disconnected if client not found
            await UserSession.update({ status: 'disconnected' }, { where: { userId: id } });
            return res.status(404).json({ status: 'error', message: 'Client session not found' });
        }

        const client = clients[id];

        const state = await client.getState();
        if (state === 'CONNECTED') {
            // Update status to connected if not already
            if (userSession.status !== 'connected') {
                await UserSession.update({ status: 'connected' }, { where: { userId: id } });
            }
            res.json({ status: 'success', isLoggedIn: true });
        } else {
            // Update status to disconnected
            await UserSession.update({ status: 'disconnected' }, { where: { userId: id } });
            res.json({ status: 'success', isLoggedIn: false });
        }
    } catch (err) {
        console.error('Error in getStatus:', err);
        res.status(500).json({ status: 'error', message: 'Error getting status', error: err.message });
    }
};

module.exports = getStatus;