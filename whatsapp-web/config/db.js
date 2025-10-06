const sequelize = require('./database');
const UserSession = require('../models/UserSession');
const fs = require('fs');
const path = require('path');

const initializeDatabase = async() => {
    try {
        // Check if database exists
        await sequelize.authenticate();
        console.log('Database connection has been established successfully.');

        // Sync all models with force: false to preserve existing data
        await sequelize.sync({ alter: true });
        console.log('All models were synchronized successfully.');

        // Check if UserSession table exists and has records
        const sessions = await UserSession.findAll();
        console.log(`Found ${sessions.length} existing user sessions.`);

        // Check each session path
        for (const session of sessions) {
            if (session.sessionPath) {
                const sessionExists = fs.existsSync(session.sessionPath);
                if (!sessionExists) {
                    await session.update({
                        status: 'disconnected',
                        sessionPath: null,
                        lastActivity: new Date()
                    });
                    console.log(`Session path for user ${session.userId} does not exist. Status updated to disconnected.`);
                }
            }
        }

        return true;
    } catch (error) {
        console.error('Database initialization error:', error);
        throw error;
    }
};

module.exports = initializeDatabase;