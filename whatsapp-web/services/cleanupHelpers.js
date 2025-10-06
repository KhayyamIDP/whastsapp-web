const fs = require('fs').promises;

async function safeDeleteFile(filePath) {
    try {
        await fs.unlink(filePath);
        console.log(`[Cleanup] Deleted file: ${filePath}`);
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`[Cleanup] Failed to delete file ${filePath}:`, err.message);
        }
    }
}

async function safeDeleteDirectory(directoryPath) {
    try {
        await fs.rm(directoryPath, { recursive: true, force: true });
        console.log(`[Cleanup] Deleted directory: ${directoryPath}`);
    } catch (err) {
        console.error(`[Cleanup] Failed to delete directory ${directoryPath}:`, err.message);
    }
}

module.exports = {
    safeDeleteFile,
    safeDeleteDirectory
};