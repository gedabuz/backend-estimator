const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Api, TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
    destination: '/tmp/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '_' + file.originalname.replace(/\s+/g, '_'));
    }
});
const upload = multer({ storage: storage });

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID; 

const stringSession = new StringSession(""); 
const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

// DATABASE PERMANEN (RAILWAY VOLUME)
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'database.json');

let dbFiles = []; 
let dbUsers = [
    { username: 'gedabu', password: 'owner123', role: 'admin', name: 'Gedabu (Admin)' }
];
let activeSessions = {}; 

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const rawData = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(rawData);
            dbFiles = parsed.files || [];
            
            let loadedUsers = parsed.users || [];
            loadedUsers = loadedUsers.map(u => {
                if (u.role === 'owner' || u.role === 'creator') u.role = 'admin';
                return u;
            });
            
            if (!loadedUsers.find(u => u.role === 'admin')) {
                loadedUsers.push({ username: 'gedabu', password: 'owner123', role: 'admin', name: 'Gedabu (Admin)' });
            }
            
            dbUsers = loadedUsers;
            saveDatabase();
        } catch (err) { console.error("Gagal membaca DB:", err); }
    } else { saveDatabase(); }
}

function saveDatabase() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify({ files: dbFiles, users: dbUsers }, null, 2)); } 
    catch (err) { console.error("Gagal simpan DB:", err); }
}
loadDatabase();

async function startMTProto() {
    await client.start({ botAuthToken: BOT_TOKEN });
    console.log("🚀 Mesin terhubung ke Telegram!");
}
startMTProto();

// --- ENDPOINT AUTENTIKASI ---
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = dbUsers.find(u => u.username === username && u.password === password);
    if (user) {
        const token = Date.now().toString() + Math.random().toString(36).substring(2);
        activeSessions[token] = user;
        res.json({ status: 'success', token, role: user.role, name: user.name, username: user.username });
    } else { res.status(401).json({ status: 'error', message: 'Username atau Password salah!' }); }
});

app.post('/create-user', (req, res) => {
    const { token, newUsername, newPassword, newName } = req.body;
    const session = activeSessions[token];
    if (!session || session.role !== 'admin') return res.status(403).json({ status: 'error', message: 'Akses ditolak!' });
    if (dbUsers.find(u => u.username === newUsername)) return res.status(400).json({ status: 'error', message: 'Username terpakai.' });
    
    dbUsers.push({ username: newUsername, password: newPassword, role: 'team', name: newName });
    saveDatabase();
    res.json({ status: 'success', message: `Akun untuk ${newName} berhasil dibuat!` });
});

app.post('/get-users', (req, res) => {
    const { token } = req.body;
    if (!activeSessions[token] || activeSessions[token].role !== 'admin') return res.status(403).send("Ditolak");
    res.json(dbUsers.map(u => ({ username: u.username, name: u.name, role: u.role })));
});

// --- FITUR BARU: ENDPOINT HAPUS USER TIM ---
app.delete('/users/:username', (req, res) => {
    const { token } = req.body;
    const session = activeSessions[token];
    
    if (!session || session.role !== 'admin') {
        return res.status(403).json({ status: 'error', message: 'Akses ditolak! Hanya Admin yang bisa menghapus user.' });
    }

    const usernameToDelete = req.params.username;

    // Proteksi: Mencegah admin menghapus dirinya sendiri
    if (usernameToDelete === session.username) {
        return res.status(400).json({ status: 'error', message: 'Terjadi kesalahan! Anda tidak bisa menghapus akun Admin Anda sendiri.' });
    }

    const userIndex = dbUsers.findIndex(u => u.username === usernameToDelete);
    if (userIndex === -1) {
        return res.status(404).json({ status: 'error', message: 'User tidak ditemukan.' });
    }

    // Hapus dari database
    dbUsers.splice(userIndex, 1);
    saveDatabase(); // Simpan permanen ke volume Railway

    res.json({ status: 'success', message: `Akun @${usernameToDelete} berhasil dihapus dari sistem.` });
});

app.post('/update-profile', (req, res) => {
    const { token, newUsername, newName, newPassword } = req.body;
    const session = activeSessions[token];
    if (!session) return res.status(401).json({ status: 'error', message: 'Sesi tidak valid.' });

    const userIndex = dbUsers.findIndex(u => u.username === session.username);
    if (userIndex === -1) return res.status(404).json({ status: 'error', message: 'User tidak ditemukan.' });

    if (newUsername !== session.username && dbUsers.find(u => u.username === newUsername)) {
        return res.status(400).json({ status: 'error', message: 'Username baru sudah digunakan.' });
    }

    dbUsers[userIndex].username = newUsername;
    dbUsers[userIndex].name = newName;
    if (newPassword && newPassword.trim() !== "") dbUsers[userIndex].password = newPassword;

    activeSessions[token] = dbUsers[userIndex];
    saveDatabase();
    res.json({ status: 'success', message: 'Profil diperbarui!', name: dbUsers[userIndex].name, username: dbUsers[userIndex].username });
});

// --- ENDPOINT UPLOAD & DOWNLOAD ---
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const { project, category, user, keterangan, token } = req.body;
        if (!activeSessions[token]) return res.status(401).json({ status: 'error', message: 'Sesi tidak valid.' });

        const result = await client.sendFile(CHANNEL_ID, {
            file: req.file.path,
            caption: `Proyek: ${project}\nKategori: ${category}\nOleh: ${user}\nKeterangan: ${keterangan || '-'}`,
            forceDocument: true,
            attributes: [ new Api.DocumentAttributeFilename({ fileName: req.file.originalname }) ],
        });
        fs.unlinkSync(req.file.path);

        const newRecord = {
            id: result.id, name: req.file.originalname, project, category, user,
            keterangan: keterangan || '-', date: new Date().toISOString().split('T')[0]
        };
        dbFiles.unshift(newRecord);
        saveDatabase();
        res.json({ status: 'success', data: newRecord });
    } catch (error) { res.status(500).json({ status: 'error', message: 'Gagal upload file' }); }
});

app.get('/files', (req, res) => res.json(dbFiles));

app.get('/download/:messageId', async (req, res) => {
    try {
        if (!activeSessions[req.query.token]) return res.status(401).send("Akses Ditolak.");
        const messageId = parseInt(req.params.messageId);
        const messages = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        if (!messages.length || !messages[0].media) return res.status(404).send("File tidak ditemukan");
        
        const document = messages[0].media.document;
        let fileName = "Dokumen_Estimator";
        if (document.attributes) {
            const nameAttr = document.attributes.find(attr => attr.className === 'DocumentAttributeFilename');
            if (nameAttr) fileName = nameAttr.fileName;
        }
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        if (document.size) res.setHeader('Content-Length', document.size.toString());

        for await (const chunk of client.iterDownload({ file: messages[0].media, requestSize: 1024 * 1024 })) { res.write(chunk); }
        res.end();
    } catch (error) { res.status(500).send("Gagal streaming data"); }
});

app.put('/files/:id', async (req, res) => {
    try {
        const { token, project, category, keterangan } = req.body;
        const session = activeSessions[token];
        if (!session) return res.status(401).json({ status: 'error', message: 'Sesi tidak valid.' });

        const id = parseInt(req.params.id);
        const fileIndex = dbFiles.findIndex(f => f.id === id);
        if (fileIndex === -1) return res.status(404).json({ status: 'error', message: 'File tidak ditemukan.' });

        const file = dbFiles[fileIndex];
        if (session.role !== 'admin' && session.name !== file.user) return res.status(403).json({ status: 'error', message: 'Akses ditolak.' });

        try {
            const newCaption = `Proyek: ${project}\nKategori: ${category}\nOleh: ${file.user}\nKeterangan: ${keterangan || '-'}`;
            await client.editMessage(CHANNEL_ID, { message: id, text: newCaption });
        } catch (tgError) { console.warn("Caption telegram tidak bisa diedit."); }

        dbFiles[fileIndex].project = project;
        dbFiles[fileIndex].category = category;
        dbFiles[fileIndex].keterangan = keterangan || '-';
        saveDatabase();
        res.json({ status: 'success', message: 'Data berhasil diupdate!' });
    } catch (error) { res.status(500).json({ status: 'error', message: 'Gagal update data.' }); }
});

app.delete('/files/:id', async (req, res) => {
    try {
        const { token } = req.body;
        const session = activeSessions[token];
        if (!session) return res.status(401).json({ status: 'error', message: 'Sesi tidak valid.' });

        const id = parseInt(req.params.id);
        const fileIndex = dbFiles.findIndex(f => f.id === id);
        if (fileIndex === -1) return res.status(404).json({ status: 'error', message: 'File tidak ditemukan.' });

        const file = dbFiles[fileIndex];
        if (session.role !== 'admin' && session.name !== file.user) return res.status(403).json({ status: 'error', message: 'Akses ditolak.' });

        await client.deleteMessages(CHANNEL_ID, [id], { revoke: true });
        dbFiles.splice(fileIndex, 1);
        saveDatabase();
        res.json({ status: 'success', message: 'File berhasil dihapus permanen.' });
    } catch (error) { res.status(500).json({ status: 'error', message: 'Gagal menghapus file.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
