const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
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

let dbFiles = []; 
let activeSessions = {}; 

// ==========================================
// DAFTAR USER PERMANEN
// Tambahkan anggota tim Anda secara manual di sini agar tidak hilang saat restart
// ==========================================
let dbUsers = [
    { username: 'rahmat', password: 'akuplg88', role: 'creator', name: 'Rahmat (Creator)' },
    { username: 'lukman', password: 'agentA1', role: 'leader etimate', name: 'Pak Lukman' },
    { username: 'Zaenal', password: 'agent1', role: 'estimate', name: 'Mas Zaenal' },
    { username: 'novita', password: 'agent2', role: 'admin', name: 'Mbak Novita' },
    { username: 'puji', password: 'agent3', role: 'estimate', name: 'Mbak Puji' }
    // Contoh menambah tim:
    // { username: 'budi', password: 'budi123', role: 'team', name: 'Budi Santoso' },
];

// ==========================================
// FUNGSI SINKRONISASI DATABASE DARI TELEGRAM
// ==========================================
async function syncDataFromTelegram() {
    console.log("🔄 Memulai sinkronisasi database dari Telegram...");
    try {
        dbFiles = []; // Kosongkan memori sementara
        
        // Menarik 500 pesan/file terbaru dari channel (Bisa dinaikkan jika file sudah ribuan)
        const messages = await client.getMessages(CHANNEL_ID, { limit: 500 });
        
        for (const message of messages) {
            // Pastikan pesan tersebut adalah dokumen/file
            if (message.media && message.media.document) {
                const caption = message.message || "";
                
                // Fungsi cerdas membaca pola teks Caption
                const getMatch = (str, regex) => {
                    const match = str.match(regex);
                    return match ? match[1].trim() : '-';
                };
                
                const project = getMatch(caption, /Proyek:\s*(.+)/);
                const category = getMatch(caption, /Kategori:\s*(.+)/);
                const user = getMatch(caption, /Oleh:\s*(.+)/);
                // Regex [\s\S]+ mengambil seluruh sisa teks hingga ke bawah
                const keterangan = getMatch(caption, /Keterangan:\s*([\s\S]+)/); 
                
                // Mengambil nama file asli
                let fileName = "Dokumen_Estimator";
                if (message.media.document.attributes) {
                    const nameAttr = message.media.document.attributes.find(attr => attr.className === 'DocumentAttributeFilename');
                    if (nameAttr) fileName = nameAttr.fileName;
                }
                
                // Mengambil tanggal file diupload dari server Telegram
                const dateObj = new Date(message.date * 1000); // Convert Unix to JS Date
                const dateStr = dateObj.toISOString().split('T')[0];

                // Memasukkan kembali ke array database
                dbFiles.push({
                    id: message.id, 
                    name: fileName,
                    project: project !== '-' ? project : 'Tidak Diketahui',
                    category: category !== '-' ? category : 'Tidak Diketahui',
                    user: user !== '-' ? user : 'Anonim',
                    keterangan: keterangan !== '-' ? keterangan : '-',
                    date: dateStr
                });
            }
        }
        console.log(`✅ Sinkronisasi Selesai! Berhasil memulihkan ${dbFiles.length} file dari Telegram.`);
    } catch (error) {
        console.error("❌ Gagal melakukan sinkronisasi:", error);
    }
}

// ==========================================
// MENYALAKAN MESIN & MENARIK DATA
// ==========================================
async function startMTProto() {
    await client.start({ botAuthToken: BOT_TOKEN });
    console.log("🚀 Mesin MTProto Stream berhasil terhubung!");
    
    // Panggil fungsi sinkronisasi otomatis setiap kali server baru menyala!
    await syncDataFromTelegram();
}
startMTProto();

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
    res.json({ status: 'success', message: `Akun untuk ${newName} berhasil dibuat!` });
});

app.post('/get-users', (req, res) => {
    const { token } = req.body;
    if (!activeSessions[token] || activeSessions[token].role !== 'owner') return res.status(403).send("Ditolak");
    const safeUsers = dbUsers.map(u => ({ username: u.username, name: u.name, role: u.role }));
    res.json(safeUsers);
});

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const { project, category, user, keterangan, token } = req.body;
        const file = req.file;

        if (!activeSessions[token]) {
            if (file) fs.unlinkSync(file.path);
            return res.status(401).json({ status: 'error', message: 'Sesi login tidak valid, harap login ulang.' });
        }

        // Format Teks Caption Ini SANGAT PENTING untuk dibaca ulang oleh fungsi Sync saat server restart
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
