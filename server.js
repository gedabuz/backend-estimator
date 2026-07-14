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

// DATABASE PERMANEN
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'database.json');

let dbFiles = []; 
// UPDATE 1: USERNAME GEDABU DAN ROLE CREATOR
let dbUsers = [
    { username: 'gedabuz', password: 'akuplg88', role: 'Admin', name: 'Rahmatullah (Admin)' }
];
let activeSessions = {}; 

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const rawData = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(rawData);
            dbFiles = parsed.files || [];
            dbUsers = parsed.users || dbUsers;
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
        res.json({ status: 'success', token, role: user.role, name: user.name });
    } else { res.status(401).json({ status: 'error', message: 'Username atau Password salah!' }); }
});

app.post('/create-user', (req, res) => {
    const { token, newUsername, newPassword, newName } = req.body;
    const session = activeSessions[token];
    if (!session || session.role !== 'creator') return res.status(403).json({ status: 'error', message: 'Akses ditolak!' });
    if (dbUsers.find(u => u.username === newUsername)) return res.status(400).json({ status: 'error', message: 'Username terpakai.' });
    
    dbUsers.push({ username: newUsername, password: newPassword, role: 'team', name: newName });
    saveDatabase();
    res.json({ status: 'success', message: `Akun untuk ${newName} berhasil dibuat!` });
});

app.post('/get-users', (req, res) => {
    const { token } = req.body;
    if (!activeSessions[token] || activeSessions[token].role !== 'creator') return res.status(403).send("Ditolak");
    res.json(dbUsers.map(u => ({ username: u.username, name: u.name, role: u.role })));
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

// --- UPDATE 2: ENDPOINT EDIT DATA ---
app.put('/files/:id', async (req, res) => {
    try {
        const { token, project, category, keterangan } = req.body;
        const session = activeSessions[token];
        if (!session) return res.status(401).json({ status: 'error', message: 'Sesi tidak valid.' });

        const id = parseInt(req.params.id);
        const fileIndex = dbFiles.findIndex(f => f.id === id);
        if (fileIndex === -1) return res.status(404).json({ status: 'error', message: 'File tidak ditemukan.' });

        const file = dbFiles[fileIndex];
        // Hanya Creator atau Pengupload asli yang boleh edit
        if (session.role !== 'creator' && session.name !== file.user) {
            return res.status(403).json({ status: 'error', message: 'Hanya uploader asli atau Creator yang bisa mengedit file ini.' });
        }

        try {
            // Update caption di Telegram
            const newCaption = `Proyek: ${project}\nKategori: ${category}\nOleh: ${file.user}\nKeterangan: ${keterangan || '-'}`;
            await client.editMessage(CHANNEL_ID, { message: id, text: newCaption });
        } catch (tgError) { console.warn("Caption telegram tidak bisa diedit, lanjut update lokal."); }

        // Update Lokal
        dbFiles[fileIndex].project = project;
        dbFiles[fileIndex].category = category;
        dbFiles[fileIndex].keterangan = keterangan || '-';
        saveDatabase();

        res.json({ status: 'success', message: 'Data berhasil diupdate!' });
    } catch (error) { res.status(500).json({ status: 'error', message: 'Gagal update data.' }); }
});

// --- UPDATE 2: ENDPOINT HAPUS DATA ---
app.delete('/files/:id', async (req, res) => {
    try {
        const { token } = req.body;
        const session = activeSessions[token];
        if (!session) return res.status(401).json({ status: 'error', message: 'Sesi tidak valid.' });

        const id = parseInt(req.params.id);
        const fileIndex = dbFiles.findIndex(f => f.id === id);
        if (fileIndex === -1) return res.status(404).json({ status: 'error', message: 'File tidak ditemukan.' });

        const file = dbFiles[fileIndex];
        // Hanya Creator atau Pengupload asli yang boleh hapus
        if (session.role !== 'creator' && session.name !== file.user) {
            return res.status(403).json({ status: 'error', message: 'Hanya uploader asli atau Creator yang bisa menghapus file ini.' });
        }

        // Hapus fisik dari Telegram
        await client.deleteMessages(CHANNEL_ID, [id], { revoke: true });

        // Hapus lokal
        dbFiles.splice(fileIndex, 1);
        saveDatabase();

        res.json({ status: 'success', message: 'File berhasil dihapus permanen.' });
    } catch (error) { res.status(500).json({ status: 'error', message: 'Gagal menghapus file.' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
