const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const { Api, TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// PERBAIKAN 1: Mencegah Nama File Acak
// ==========================================
const storage = multer.diskStorage({
    destination: '/tmp/',
    filename: (req, file, cb) => {
        // Menggabungkan waktu (agar tidak bentrok) dengan nama asli file beserta ekstensinya
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

async function startMTProto() {
    await client.start({ botAuthToken: BOT_TOKEN });
    console.log("Mesin MTProto Stream berhasil terhubung!");
}
startMTProto();

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const { project, category, user } = req.body;
        const file = req.file;

        // ==========================================
        // PERBAIKAN 2: Memaksa Telegram Menyimpan Nama Asli
        // ==========================================
        const result = await client.sendFile(CHANNEL_ID, {
            file: file.path,
            caption: `Proyek: ${project} | Kategori: ${category} | User: ${user}`,
            forceDocument: true,
            attributes: [
                new Api.DocumentAttributeFilename({
                    fileName: file.originalname, // Kunci utama: Beri tahu Telegram nama aslinya
                }),
            ],
        });

        fs.unlinkSync(file.path);

        const newRecord = {
            id: result.id, 
            name: file.originalname, // Menampilkan nama asli beserta ekstensi di tabel Web
            project, category, user,
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

        // ==========================================
        // PERBAIKAN 3: Header HTTP Anti-Gagal untuk Nama File Berspasi
        // ==========================================
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
