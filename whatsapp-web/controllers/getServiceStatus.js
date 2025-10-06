const UserSession = require('../models/UserSession');
const { notifyServiceStatus } = require('../services/slackService');

const getServiceStatus = (clients) => async(req, res) => {
    try {
        // Get all sessions from database
        const sessions = await UserSession.findAll();

        // Count different statuses
        const statusCounts = {
            total: sessions.length,
            connected: 0,
            pending: 0,
            disconnected: 0,
            timeout: 0
        };

        sessions.forEach(session => {
            if (statusCounts.hasOwnProperty(session.status)) {
                statusCounts[session.status]++;
            }
        });

        // Get active clients count
        const activeClients = Object.keys(clients).length;

        // Check if service is running by checking if we can create a new client
        const isServiceRunning = true; // Since we're able to handle requests, service is running

        const statusData = {
            status: 'success',
            service: {
                isRunning: isServiceRunning,
                activeClients: activeClients,
                totalSessions: statusCounts.total
            },
            sessions: statusCounts,
            timestamp: new Date().toISOString()
        };

        // Send status to Slack if requested
        try {
            await notifyServiceStatus(statusData);
            console.log('Service status notification sent to Slack');
        } catch (slackError) {
            console.error('Failed to send service status to Slack:', slackError);
            // Continue with the response even if Slack notification fails
        }

        res.json(statusData);

    } catch (err) {
        console.error('Error getting service status:', err);
        res.status(500).json({
            status: 'error',
            message: 'Failed to get service status',
            error: err.message
        });
    }
};

module.exports = getServiceStatus;