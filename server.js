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

// ==========================================
// PENGATURAN DATABASE PERMANEN (RAILWAY VOLUME)
// ==========================================
// Mendeteksi apakah berjalan di Railway (/app/data) atau di laptop lokal
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_FILE = path.join(DATA_DIR, 'database.json');

// Database Default (Akan ditimpa jika file database.json ditemukan)
let dbFiles = []; 
let dbUsers = [
    { username: 'rahmatullah', password: 'owner123', role: 'owner', name: 'Rahmatullah (Owner)' }
];
let activeSessions = {}; 

// Fungsi untuk memuat data dari Hardisk Permanen saat server baru menyala
function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const rawData = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(rawData);
            dbFiles = parsed.files || [];
            dbUsers = parsed.users || dbUsers;
            console.log(`✅ Database dimuat: ${dbFiles.length} File & ${dbUsers.length} User.`);
        } catch (err) {
            console.error("Gagal membaca database:", err);
        }
    } else {
        console.log("Database baru dibuat.");
        saveDatabase();
    }
}

// Fungsi untuk menyimpan data ke Hardisk Permanen
function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify({ files: dbFiles, users: dbUsers }, null, 2));
    } catch (err) {
        console.error("Gagal menyimpan database:", err);
    }
}

// Muat database di awal
loadDatabase();

// ==========================================
// MENYALAKAN MESIN TELEGRAM
// ==========================================
async function startMTProto() {
    await client.start({ botAuthToken: BOT_TOKEN });
    console.log("🚀 Mesin MTProto Stream berhasil terhubung ke Telegram!");
}
startMTProto();

// ==========================================
// ENDPOINT: AUTENTIKASI & USER
// ==========================================
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = dbUsers.find(u => u.username === username && u.password === password);
    if (user) {
        const token = Date.now().toString() + Math.random().toString(36).substring(2);
        activeSessions[token] = user;
        res.json({ status: 'success', token, role: user.role, name: user.name });
    } else {
        res.status(401).json({ status: 'error', message: 'Username atau Password salah!' });
    }
});

app.post('/create-user', (req, res) => {
    const { token, newUsername, newPassword, newName } = req.body;
    const session = activeSessions[token];
    if (!session || session.role !== 'owner') return res.status(403).json({ status: 'error', message: 'Akses ditolak!' });
    if (dbUsers.find(u => u.username === newUsername)) return res.status(400).json({ status: 'error', message: 'Username sudah dipakai.' });
    
    dbUsers.push({ username: newUsername, password: newPassword, role: 'team', name: newName });
    saveDatabase(); // Simpan permanen!
    res.json({ status: 'success', message: `Akun untuk ${newName} berhasil dibuat!` });
});

app.post('/get-users', (req, res) => {
    const { token } = req.body;
    if (!activeSessions[token] || activeSessions[token].role !== 'owner') return res.status(403).send("Ditolak");
    const safeUsers = dbUsers.map(u => ({ username: u.username, name: u.name, role: u.role }));
    res.json(safeUsers);
});

// ==========================================
// ENDPOINT: UPLOAD & DOWNLOAD
// ==========================================
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const { project, category, user, keterangan, token } = req.body;
        const file = req.file;

        if (!activeSessions[token]) {
            if (file) fs.unlinkSync(file.path);
            return res.status(401).json({ status: 'error', message: 'Sesi login tidak valid, harap login ulang.' });
        }

        const result = await client.sendFile(CHANNEL_ID, {
            file: file.path,
            caption: `Proyek: ${project}\nKategori: ${category}\nOleh: ${user}\nKeterangan: ${keterangan || '-'}`,
            forceDocument: true,
            attributes: [ new Api.DocumentAttributeFilename({ fileName: file.originalname }) ],
        });

        fs.unlinkSync(file.path);

        const newRecord = {
            id: result.id, 
            name: file.originalname,
            project, category, user,
            keterangan: keterangan || '-',
            date: new Date().toISOString().split('T')[0]
        };

        dbFiles.unshift(newRecord);
        saveDatabase(); // Simpan permanen!
        res.json({ status: 'success', data: newRecord });

    } catch (error) {
        if (req.file) fs.unlinkSync(req.file.path); 
        console.error("Error Upload:", error);
        res.status(500).json({ status: 'error', message: 'Gagal mengunggah file' });
    }
});

app.get('/files', (req, res) => res.json(dbFiles));

app.get('/download/:messageId', async (req, res) => {
    try {
        const token = req.query.token;
        if (!activeSessions[token]) return res.status(401).send("Akses Ditolak. Silakan login.");

        const messageId = parseInt(req.params.messageId);
        const messages = await client.getMessages(CHANNEL_ID, { ids: [messageId] });
        
        if (!messages.length || !messages[0].media) return res.status(404).send("File tidak ditemukan");
        
        const message = messages[0];
        const document = message.media.document;
        let fileName = "Dokumen_Estimator";
        if (document.attributes) {
            const nameAttr = document.attributes.find(attr => attr.className === 'DocumentAttributeFilename');
            if (nameAttr) fileName = nameAttr.fileName;
        }

        const encodedFileName = encodeURIComponent(fileName);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodedFileName}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        if (document.size) res.setHeader('Content-Length', document.size.toString());

        for await (const chunk of client.iterDownload({ file: message.media, requestSize: 1024 * 1024 })) {
            res.write(chunk);
        }
        res.end();
    } catch (error) {
        console.error("Error Download:", error);
        res.status(500).send("Gagal streaming data");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
