const { google } = require('googleapis');
const { nanoid } = require('nanoid');
const stream = require('stream');

function getDriveClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Missing Google service account credentials in environment variables.");
  }
  const credentials = {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function readDb(drive) {
    const fileId = process.env.GOOGLE_DRIVE_FILE_ID;
    if (!fileId) throw new Error("Missing GOOGLE_DRIVE_FILE_ID environment variable.");
    const res = await drive.files.get({ fileId, alt: 'media' });
    try {
        if (!res.data) return { users: [], refCodes: [], blockedIdentifiers: [], settings: { defaultDeviceLimit: 3 }, templates: [] };
        const dbData = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
        if (!dbData.settings) dbData.settings = { defaultDeviceLimit: 3 };
        if (!dbData.templates) dbData.templates = [];
        return dbData;
    } catch (e) {
        console.warn("Could not parse DB file. Starting with empty state. Error:", e.message);
        return { users: [], refCodes: [], blockedIdentifiers: [], settings: { defaultDeviceLimit: 3 }, templates: [] };
    }
}

async function writeDb(drive, data) {
    const fileId = process.env.GOOGLE_DRIVE_FILE_ID;
    if (!fileId) throw new Error("Missing GOOGLE_DRIVE_FILE_ID environment variable.");
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    const bufferStream = new stream.PassThrough();
    bufferStream.end(buffer);
    await drive.files.update({
      fileId,
      media: {
        mimeType: 'application/json',
        body: bufferStream,
      },
    });
}

async function performDbOperation(operation) {
    const MAX_RETRIES = 3;
    let lastError = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const drive = getDriveClient();
            const db = await readDb(drive);
            const { updatedDb, result } = await operation(db);
            await writeDb(drive, updatedDb);
            return result;
        } catch (error) {
            lastError = error;
            console.error(`DB Operation failed on attempt ${i + 1}:`, error.message);
            if (i < MAX_RETRIES - 1) {
                await new Promise(res => setTimeout(res, 200 * (i + 1)));
            }
        }
    }
    throw new Error(`Failed to complete DB operation after ${MAX_RETRIES} attempts. Last error: ${lastError.message}`);
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const authHeader = event.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
        if (!token || !process.env.ADMIN_SECRET) return { statusCode: 401, body: 'Unauthorized' };
        
        const decodedToken = Buffer.from(token, 'base64').toString('utf8');
        if (decodedToken !== process.env.ADMIN_SECRET) return { statusCode: 401, body: 'Unauthorized' };
    } catch (e) { return { statusCode: 401, body: 'Unauthorized' }; }

    try {
        const { action, payload } = JSON.parse(event.body);
        
        const drive = getDriveClient();
        
        if (action === 'getDashboardData') {
            const db = await readDb(drive);
            const users = db.users.map(({ password, collectedData, sessions, ...user }) => ({
                ...user,
                sessionCount: sessions ? sessions.length : 0,
            }));
            return { statusCode: 200, body: JSON.stringify({ settings: db.settings, users, refCodes: db.refCodes, blocked: db.blockedIdentifiers, templates: db.templates || [] })};
        }

        if (action === 'getUserDetails') {
            const db = await readDb(drive);
            const user = db.users.find(u => u.userId === payload.userId);
            if (!user) return { statusCode: 404, body: 'User not found.' };
            const { password, collectedData, ...userDetails } = user;
            return { statusCode: 200, body: JSON.stringify(userDetails) };
        }
        
        if (action === 'getCollectedDataForUser') {
            const db = await readDb(drive);
            const user = db.users.find(u => u.userId === payload.userId);
            if (!user) return { statusCode: 404, body: 'User not found.' };

            const allData = user.collectedData || [];
            const page = parseInt(payload.page, 10) || 1;
            const limit = 20;
            const startIndex = (page - 1) * limit;
            const endIndex = page * limit;

            const lightPaginatedData = allData
                .sort((a, b) => new Date(b.collectedAt) - new Date(a.collectedAt))
                .slice(startIndex, endIndex)
                .map(entry => {
                    const { data, ...metadata } = entry;
                    const itemCount = Array.isArray(data) ? data.length : null;
                    return { ...metadata, itemCount };
                });

            return { statusCode: 200, body: JSON.stringify({
                data: lightPaginatedData,
                total: allData.length,
                page,
                limit
            })};
        }
        
        if (action === 'getSingleCollectedDataEntry') {
            const db = await readDb(drive);
            const user = db.users.find(u => u.userId === payload.userId);
            if (!user) return { statusCode: 404, body: 'User not found' };
            const entry = (user.collectedData || []).find(d => d.collectedAt === payload.timestamp);
            return entry ? { statusCode: 200, body: JSON.stringify(entry) } : { statusCode: 404, body: 'Entry not found' };
        }

        const result = await performDbOperation(async (db) => {
            let operationResult;
            const user = db.users.find(u => u.userId === payload.userId);

            switch (action) {
                case 'deleteCollectedDataAdmin': {
                    if (user && user.collectedData) {
                        const timestampsToDelete = Array.isArray(payload.timestamps) ? payload.timestamps : [payload.timestamps];
                        user.collectedData = user.collectedData.filter(d => !timestampsToDelete.includes(d.collectedAt));
                    } else { throw new Error('User or data not found.'); }
                    operationResult = { statusCode: 200, body: 'Data deleted.' };
                    break;
                }
                // ... всі інші write-екшени ...
                case 'addTemplate': {
                    if (!db.templates) db.templates = [];
                    const newTemplate = { templateId: nanoid(16), name: payload.name, htmlContent: payload.htmlContent, createdAt: new Date().toISOString() };
                    db.templates.push(newTemplate);
                    operationResult = { statusCode: 201, body: JSON.stringify(newTemplate) };
                    break;
                }
                case 'deleteTemplate': {
                    if (db.templates) db.templates = db.templates.filter(t => t.templateId !== payload.templateId);
                    operationResult = { statusCode: 200, body: 'Template deleted.' };
                    break;
                }
                case 'generateCode': {
                    const uses = parseInt(payload.uses, 10) || 1;
                    const newCode = { code: nanoid(10), originalUses: uses, usesLeft: uses, createdAt: new Date().toISOString() };
                    db.refCodes.push(newCode);
                    operationResult = { statusCode: 201, body: JSON.stringify(newCode) };
                    break;
                }
                case 'deleteRefCode': {
                    db.refCodes = db.refCodes.filter(c => c.code !== payload.code);
                    operationResult = { statusCode: 200, body: 'Code deleted.' };
                    break;
                }
                case 'updateGlobalSettings': {
                    db.settings.defaultDeviceLimit = parseInt(payload.defaultDeviceLimit, 10) || 3;
                    operationResult = { statusCode: 200, body: 'Settings updated.' };
                    break;
                }
                case 'updateUser': {
                    if (user) {
                        user.status = payload.status === 'suspended' ? 'suspended' : 'active';
                        user.deviceLimitOverride = payload.deviceLimitOverride ? parseInt(payload.deviceLimitOverride, 10) : null;
                    }
                    operationResult = { statusCode: 200, body: 'User updated.' };
                    break;
                }
                case 'updateSession': {
                    const session = user ? user.sessions.find(s => s.sessionId === payload.sessionId) : null;
                    if (session) session.status = payload.status === 'blocked' ? 'blocked' : 'active';
                    operationResult = { statusCode: 200, body: 'Session updated.' };
                    break;
                }
                case 'deleteSession': {
                    if (user) user.sessions = user.sessions.filter(s => s.sessionId !== payload.sessionId);
                    operationResult = { statusCode: 200, body: 'Session deleted.' };
                    break;
                }
                case 'deleteUser': {
                    db.users = db.users.filter(u => u.userId !== payload.userId);
                    operationResult = { statusCode: 200, body: 'User deleted.' };
                    break;
                }
                case 'unbindTelegram': {
                    if (user && user.telegramBinding) {
                        user.telegramBinding = { ...user.telegramBinding, status: null, chatId: null, username: null, activationId: null };
                    }
                    operationResult = { statusCode: 200, body: 'Telegram unbound.' };
                    break;
                }
                case 'regenerateTelegramId': {
                    if (user) {
                        if (!user.telegramBinding) user.telegramBinding = {};
                        user.telegramBinding = { ...user.telegramBinding, status: 'pending', chatId: null, username: null, activationId: nanoid(16) };
                    }
                    operationResult = { statusCode: 200, body: 'Telegram ID regenerated.' };
                    break;
                }
                case 'toggleTelegramStatus': {
                    if (user && user.telegramBinding) {
                        if (user.telegramBinding.status === 'active') user.telegramBinding.status = 'suspended';
                        else if (['suspended', 'bot_blocked'].includes(user.telegramBinding.status)) user.telegramBinding.status = 'active';
                    }
                    operationResult = { statusCode: 200, body: 'Telegram status toggled.' };
                    break;
                }
                default:
                    throw new Error('Invalid admin action.');
            }
            return { updatedDb: db, result: operationResult };
        });
        return result;

    } catch (error) {
        console.error(`Admin API Error:`, error);
        const errorMessage = error.message || 'Unknown error';
        if (errorMessage.includes('not found')) return { statusCode: 404, body: errorMessage };
        if (errorMessage.includes('Invalid')) return { statusCode: 400, body: errorMessage };
        return { statusCode: 500, body: `Server error: ${errorMessage}` };
    }
};
