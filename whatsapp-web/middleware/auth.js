const API_KEY = process.env.API_KEY;

const verifyApiKey = (req, res, next) => {
    const apiKey = req.headers['x-key'] || req.headers['x-key'];

    if (!apiKey) {
        return res.status(401).json({
            status: 'error',
            message: 'Authorization fail.'
        });
    }
    if (apiKey !== API_KEY) {
        return res.status(401).json({
            status: 'error',
            message: 'Authorization fail'
        });
    }

    next();
};

module.exports = verifyApiKey;