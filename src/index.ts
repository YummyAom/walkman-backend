import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;
const DOWNLOAD_DIR = path.join(process.cwd(), "songs");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use("/songs", express.static(DOWNLOAD_DIR));

let queue: any[] = [];
let currentJob: any = null;
let isProcessing = false;

// ── [NEW] Song list & Delete queue ──────────────────────────────────────
let songList: string[] = [];          // ESP32 push มาเก็บตรงนี้
let deleteQueue: string[] = [];       // รายการที่รอให้ ESP32 ลบ

function processNextJob() {
    if (isProcessing || currentJob) return;

    const job = queue.find(j => j.status === "pending");
    if (!job) return;

    job.status = "downloading";
    currentJob = job;
    isProcessing = true;

    console.log(`[DL] Starting yt-dlp: ${job.url}`);

    const outputTemplate = path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s");
    const ytdlp = spawn("yt-dlp", [
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "128K",
        "--no-playlist",
        "-o", outputTemplate,
        job.url,
    ]);

    ytdlp.stdout.on("data", d => process.stdout.write(d));
    ytdlp.stderr.on("data", d => process.stderr.write(d));

    ytdlp.on("close", async (code) => {
        isProcessing = false;
        if (code !== 0) { job.status = "error"; currentJob = null; return; }

        const files = fs.readdirSync(DOWNLOAD_DIR)
            .filter(f => f.endsWith(".mp3"))
            .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);

        if (files.length === 0) { job.status = "error"; currentJob = null; return; }

        await new Promise(r => setTimeout(r, 2000));

        const filePath = path.join(DOWNLOAD_DIR, files[0].name);
        const size = fs.statSync(filePath).size;
        if (size < 100_000) {
            console.log(`[DL] File too small (${size} bytes) — might be incomplete`);
            job.status = "error";
            currentJob = null;
            return;
        }

        job.file = files[0].name;
        job.fileUrl = `http://192.168.1.175:3001/songs/${encodeURIComponent(files[0].name)}`;
        job.status = "done";
        console.log(`[DL] Ready: ${job.file} (${size} bytes)`);
    });
}

// ── Download endpoints (เดิม) ────────────────────────────────────────────
app.post("/submit", (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "no url" });

    queue.push({ url, status: "pending" });
    console.log(`[QUEUE] Added: ${url}`);
    processNextJob();
    res.json({ ok: true });
});

app.get("/esp/next", (req, res) => {
    processNextJob();
    res.json({ ok: true });
});

app.get("/esp/status", (req, res) => {
    if (!currentJob || currentJob.status !== "done") {
        return res.json({ pending: false });
    }
    res.json({
        pending: true,
        url: currentJob.fileUrl,
        filename: currentJob.file,
    });
});

app.post("/esp/ack", (req, res) => {
    const { filename } = req.body;
    if (!currentJob) return res.json({ ok: false });

    if (currentJob.file === filename) {
        console.log(`[ACK] Done: ${filename}`);
        currentJob = null;
        processNextJob();
    } else {
        console.log(`[ACK] Mismatch: got=${filename} expected=${currentJob.file}`);
    }
    res.json({ ok: true });
});

// ── [NEW] ESP32 push รายการเพลงบน SD card ───────────────────────────────
// ESP32 เรียกหลัง sdcard_load_songs() ทุกครั้ง
// Body: { "songs": ["song1.mp3", "song2.mp3", ...] }
app.post("/esp/songs", (req, res) => {
    const { songs } = req.body;
    if (!Array.isArray(songs)) return res.status(400).json({ error: "songs must be array" });

    songList = songs;
    console.log(`[SONGS] Updated: ${songs.length} songs`);
    res.json({ ok: true });
});

// ── [NEW] Frontend ดูรายการเพลงบน SD card ───────────────────────────────
app.get("/esp/songs", (req, res) => {
    res.json({ songs: songList });
});

// ── [NEW] Frontend สั่งลบเพลง ────────────────────────────────────────────
// Body: { "filename": "song.mp3" }
app.post("/esp/delete", (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "no filename" });

    if (!deleteQueue.includes(filename)) {
        deleteQueue.push(filename);
        console.log(`[DELETE] Queued: ${filename}`);
    }
    res.json({ ok: true, queued: filename });
});

// ── [NEW] ESP32 poll — เช็คว่ามีอะไรต้องลบไหม ───────────────────────────
app.get("/esp/delete-queue", (req, res) => {
    if (deleteQueue.length === 0) {
        return res.json({ pending: false });
    }
    const filename = deleteQueue[0]; // ส่งทีละไฟล์
    res.json({ pending: true, filename });
});

// ── [NEW] ESP32 แจ้งว่าลบเสร็จแล้ว ──────────────────────────────────────
// Body: { "filename": "song.mp3", "success": true }
app.post("/esp/delete-ack", (req, res) => {
    const { filename, success } = req.body;

    const idx = deleteQueue.indexOf(filename);
    if (idx !== -1) {
        deleteQueue.splice(idx, 1);
        console.log(`[DELETE-ACK] ${filename} — success=${success}`);
    }

    // อัปเดต songList ให้ตรงกับ SD จริง
    if (success) {
        songList = songList.filter(s => s !== filename);
    }

    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});