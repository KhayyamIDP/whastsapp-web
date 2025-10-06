const axios = require('axios');

// Slack webhook URL - replace with your actual webhook URL
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL';

/**
 * Send a message to Slack
 * @param {Object} message - The message to send
 */
const sendToSlack = async(message) => {
    try {
        if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL.includes('YOUR/WEBHOOK/URL')) {
            console.warn('Slack webhook URL not configured. Skipping Slack notification.');
            return;
        }

        await axios.post(SLACK_WEBHOOK_URL, message);
    } catch (error) {
        console.error('Error sending message to Slack:', error);
        throw error;
    }
};

/**
 * Send QR code generated notification to Slack
 * @param {String} clientId - The client ID
 */
const notifyQrGenerated = async(clientId) => {
    try {
        const message = {
            blocks: [{
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*QR Code Generated*\nA new QR code has been generated for client ID: \`${clientId}\``
                }
            }]
        };

        await sendToSlack(message);
    } catch (error) {
        console.error('Error sending QR notification to Slack:', error);
    }
};

/**
 * Send client ready notification to Slack
 * @param {String} clientId - The client ID
 */
const notifyClientReady = async(clientId) => {
    try {
        const message = {
            blocks: [{
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Client Ready*\nClient ID: \`${clientId}\` is now connected and ready.`
                }
            }]
        };

        await sendToSlack(message);
    } catch (error) {
        console.error('Error sending client ready notification to Slack:', error);
    }
};

/**
 * Send client disconnected notification to Slack
 * @param {String} clientId - The client ID
 * @param {String} reason - The disconnection reason
 */
const notifyClientDisconnected = async(clientId, reason) => {
    try {
        const message = {
            blocks: [{
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Client Disconnected*\nClient ID: \`${clientId}\` has disconnected.\nReason: ${reason}`
                }
            }]
        };

        await sendToSlack(message);
    } catch (error) {
        console.error('Error sending client disconnected notification to Slack:', error);
    }
};

/**
 * Send service status notification to Slack
 * @param {Object} statusData - The service status data
 */
const notifyServiceStatus = async(statusData) => {
    try {
        const { service, sessions, timestamp } = statusData;

        // Format the message
        const message = {
            blocks: [{
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "📊 WhatsApp Service Status Report",
                        emoji: true
                    }
                },
                {
                    type: "section",
                    fields: [{
                            type: "mrkdwn",
                            text: `*Service Status:*\n${service.isRunning ? '✅ Running' : '❌ Not Running'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Active Clients:*\n${service.activeClients}`
                        }
                    ]
                },
                {
                    type: "section",
                    fields: [{
                            type: "mrkdwn",
                            text: `*Total Sessions:*\n${sessions.total}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Connected:*\n${sessions.connected}`
                        }
                    ]
                },
                {
                    type: "section",
                    fields: [{
                            type: "mrkdwn",
                            text: `*Pending:*\n${sessions.pending}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Disconnected:*\n${sessions.disconnected}`
                        }
                    ]
                },
                {
                    type: "context",
                    elements: [{
                        type: "mrkdwn",
                        text: `Report generated at: ${new Date(timestamp).toLocaleString()}`
                    }]
                }
            ]
        };

        // Send to Slack
        await sendToSlack(message);

    } catch (error) {
        console.error('Error sending service status to Slack:', error);
        throw error;
    }
};

module.exports = {
    notifyQrGenerated,
    notifyClientReady,
    notifyClientDisconnected,
    notifyServiceStatus
};