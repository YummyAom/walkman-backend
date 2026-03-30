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

// ── ฟังก์ชัน download แยกออกมา เรียก background ──────────────────────────
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

        // ✅ รอให้ OS flush ไฟล์ก่อน
        await new Promise(r => setTimeout(r, 2000));

        // ✅ ตรวจว่าไฟล์มีขนาดสมเหตุสมผล (> 100KB)
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

// ── 1. Frontend ส่ง URL ──────────────────────────────────────────────────
app.post("/submit", (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "no url" });

    queue.push({ url, status: "pending" });
    console.log(`[QUEUE] Added: ${url}`);

    // เริ่ม download ทันทีถ้าว่างอยู่
    processNextJob();

    res.json({ ok: true });
});

// ── 2. ESP32 trigger (แค่ kick processNextJob) ───────────────────────────
app.get("/esp/next", (req, res) => {
    processNextJob();  // เรียกได้เสมอ ไม่มีผลถ้ากำลัง download อยู่แล้ว
    res.json({ ok: true });
});

// ── 3. ESP32 เช็คสถานะ ───────────────────────────────────────────────────
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

// ── 4. ESP32 ACK ─────────────────────────────────────────────────────────
app.post("/esp/ack", (req, res) => {
    const { filename } = req.body;

    if (!currentJob) return res.json({ ok: false });

    if (currentJob.file === filename) {
        console.log(`[ACK] Done: ${filename}`);
        currentJob = null;
        // เริ่ม job ถัดไปทันที
        processNextJob();
    } else {
        console.log(`[ACK] Mismatch: got=${filename} expected=${currentJob.file}`);
    }

    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});