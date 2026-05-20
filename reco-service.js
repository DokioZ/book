const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.RECO_SERVICE_PORT || 3011);
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const DB_PATH = process.env.RECO_DB_PATH || './database.db';
const DB_CLIENT = String(process.env.RECO_DB_CLIENT || 'sqlite').toLowerCase();
const isMySQL = DB_CLIENT === 'mysql';
const RECO_TFIDF_ENGINE = String(process.env.RECO_TFIDF_ENGINE || 'native').toLowerCase(); // native | python
const RECO_TFIDF_PYTHON = process.env.RECO_TFIDF_PYTHON || 'python';
const RECO_TFIDF_API_URL = String(process.env.RECO_TFIDF_API_URL || '').trim();
const RECO_TFIDF_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.RECO_TFIDF_REQUEST_TIMEOUT_MS) || 5000);
const RECO_EVENT_WEIGHTS = {
    impression: 0.03,
    click: 1.2,
    detail: 1.5,
    detail_view: 1.5,
    favorite: 4.0,
    cart_add: 4.5,
    purchase: 6.0,
    comment: 3.0,
    report: -6.0,
    dwell: 2.0
};

app.use(cors());
app.use(express.json());

let db = null;
let mysqlPool = null;
if (!isMySQL) {
    db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
            console.error('[reco-service] sqlite connect failed:', err.message);
        } else {
            console.log(`[reco-service] sqlite connected: ${DB_PATH}`);
        }
    });
}

function dbAllAsync(sql, params = []) {
    if (isMySQL) {
        return mysqlPool.execute(sql, params).then(([rows]) => rows || []);
    }
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbRunAsync(sql, params = []) {
    if (isMySQL) {
        return mysqlPool.execute(sql, params).then(([result]) => result || {});
    }
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

async function initMySQL() {
    if (!isMySQL) return;
    const mysql = require('mysql2/promise');
    mysqlPool = mysql.createPool({
        host: process.env.RECO_MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.RECO_MYSQL_PORT || 3306),
        user: process.env.RECO_MYSQL_USER || 'root',
        password: process.env.RECO_MYSQL_PASSWORD || '',
        database: process.env.RECO_MYSQL_DATABASE || 'reco_db',
        waitForConnections: true,
        connectionLimit: 10
    });
    await mysqlPool.query('SELECT 1');
    await mysqlPool.query(
        `CREATE TABLE IF NOT EXISTS user_item_score_snapshot (
            id BIGINT PRIMARY KEY AUTO_INCREMENT,
            user_id BIGINT NOT NULL,
            book_id BIGINT NOT NULL,
            score DOUBLE NOT NULL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_user_book (user_id, book_id),
            KEY idx_snapshot_updated_at (updated_at)
        )`
    );
    // 兼容旧迁移结构：确保事件表主键可自增，否则消费者写入会失败
    try {
        await mysqlPool.query(
            `ALTER TABLE book_reco_events
             MODIFY COLUMN id BIGINT NOT NULL AUTO_INCREMENT`
        );
    } catch (error) {
        // 字段已是目标形态时忽略
    }
    console.log('[reco-service] mysql connected');
}

function parseTags(raw) {
    return String(raw || '')
        .split(/[,，|\/\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
}

function tokenizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\u4e00-\u9fa5]/g, (m) => ` ${m} `)
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
        .split(/\s+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 1);
}

function dotProduct(a, b) {
    let s = 0;
    for (const [k, v] of a.entries()) s += v * (b.get(k) || 0);
    return s;
}

function vectorNorm(a) {
    let s = 0;
    for (const v of a.values()) s += v * v;
    return Math.sqrt(s);
}

function cosineMap(a, b) {
    const na = vectorNorm(a);
    const nb = vectorNorm(b);
    if (na < 1e-8 || nb < 1e-8) return 0;
    return dotProduct(a, b) / (na * nb);
}

function pearsonMap(a, b) {
    const keys = [];
    for (const k of a.keys()) {
        if (b.has(k)) keys.push(k);
    }
    if (keys.length < 2) return 0;
    let sumA = 0;
    let sumB = 0;
    for (const k of keys) {
        sumA += Number(a.get(k) || 0);
        sumB += Number(b.get(k) || 0);
    }
    const meanA = sumA / keys.length;
    const meanB = sumB / keys.length;
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (const k of keys) {
        const da = Number(a.get(k) || 0) - meanA;
        const dbv = Number(b.get(k) || 0) - meanB;
        num += da * dbv;
        denA += da * da;
        denB += dbv * dbv;
    }
    if (denA < 1e-8 || denB < 1e-8) return 0;
    return num / Math.sqrt(denA * denB);
}

function normalize01(v, mn, mx) {
    if (!isFinite(v)) return 0;
    if (Math.abs(mx - mn) < 1e-8) return v > 0 ? 1 : 0;
    const x = (v - mn) / (mx - mn);
    return Math.max(0, Math.min(1, x));
}

function getRecoEventWeight(eventType) {
    return Number(RECO_EVENT_WEIGHTS[String(eventType || '')] || 0);
}

function getDecayWeightedScore(eventType, eventValue, createdAt) {
    const base = getRecoEventWeight(eventType);
    if (!base) return 0;
    const nowMs = Date.now();
    const createdMs = createdAt ? new Date(createdAt).getTime() : nowMs;
    const age = Math.max(0, nowMs - createdMs);
    const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
    const decay = Math.exp(-age / THIRTY_DAYS_MS);
    const value = Number(eventValue || 1);
    return base * (isFinite(value) ? value : 1) * decay;
}

function runPythonTfidf(payload, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const child = spawn(RECO_TFIDF_PYTHON, ['scripts/reco_tfidf_service.py'], {
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error('python tfidf timeout'));
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += String(d || ''); });
        child.stderr.on('data', (d) => { stderr += String(d || ''); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(stderr || `python exit code ${code}`));
                return;
            }
            try {
                const obj = JSON.parse(stdout || '{}');
                resolve(obj);
            } catch (e) {
                reject(new Error(`python output parse failed: ${e.message}`));
            }
        });
        child.stdin.write(JSON.stringify(payload || {}));
        child.stdin.end();
    });
}

async function runPythonTfidfByApi(payload, timeoutMs = RECO_TFIDF_REQUEST_TIMEOUT_MS) {
    if (!RECO_TFIDF_API_URL) {
        throw new Error('RECO_TFIDF_API_URL is empty');
    }
    const axios = require('axios');
    const base = RECO_TFIDF_API_URL.replace(/\/+$/, '');
    const resp = await axios.post(`${base}/score`, payload || {}, {
        timeout: timeoutMs
    });
    return resp.data || {};
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
        return res.status(401).json({ success: false, message: '缺少认证令牌' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(403).json({ success: false, message: '无效令牌' });
    }
}

app.get('/health', (req, res) => {
    res.status(200).json({
        success: true,
        service: 'reco-service',
        db_client: isMySQL ? 'mysql' : 'sqlite',
        tfidf_engine: RECO_TFIDF_ENGINE,
        tfidf_api_enabled: !!RECO_TFIDF_API_URL,
        time: new Date().toISOString()
    });
});

// 独立推荐服务（第一版）：优先返回推荐缓存，随后热点兜底。
app.get('/internal/reco/books', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
        const ttlSec = Math.max(15, Math.min(3600, Number(req.query.ttl_sec) || 120));
        const cfMinInteractions = Math.max(1, Math.min(50, Number(req.query.cf_min_interactions) || 3));
        const cfMinNeighbors = Math.max(1, Math.min(50, Number(req.query.cf_min_neighbors) || 2));
        const cfSimilarity = String(req.query.cf_similarity || 'cosine').toLowerCase() === 'pearson' ? 'pearson' : 'cosine';
        const cacheRows = isMySQL
            ? await dbAllAsync(
                `SELECT b.id, b.title, b.author, b.category, b.description, b.cover_url, b.price, b.rating,
                        c.score, c.reason, c.strategy
                 FROM book_reco_cache c
                 JOIN books b ON b.id = c.book_id
                 WHERE c.user_id = ?
                   AND c.updated_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
                 ORDER BY c.score DESC, c.id ASC
                 LIMIT ?`,
                [userId, ttlSec, limit]
            )
            : await dbAllAsync(
                `SELECT b.id, b.title, b.author, b.category, b.description, b.cover_url, b.price, b.rating,
                        c.score, c.reason, c.strategy
                 FROM book_reco_cache c
                 JOIN books b ON b.id = c.book_id
                 WHERE c.user_id = ?
                   AND datetime(c.updated_at) >= datetime('now', ?)
                 ORDER BY c.score DESC, c.id ASC
                 LIMIT ?`,
                [userId, `-${ttlSec} seconds`, limit]
            );
        if (cacheRows.length >= Math.min(3, limit)) {
            return res.status(200).json({
                success: true,
                source: 'cache',
                engine: 'hybrid-cache',
                recommendations: cacheRows.map((r) => ({
                    id: r.id,
                    title: r.title,
                    author: r.author,
                    category: r.category,
                    description: r.description,
                    cover_url: r.cover_url,
                    price: r.price,
                    rating: r.rating,
                    score: Number(Number(r.score || 0).toFixed(6)),
                    reason: r.reason || '为你推荐',
                    strategy: r.strategy || 'hybrid'
                }))
            });
        }
        const books = await dbAllAsync(
            `SELECT id, title, author, category, description, cover_url, price, rating, created_at
             FROM books`
        );
        if (!books.length) {
            return res.status(200).json({ success: true, source: 'empty', recommendations: [] });
        }
        const events = isMySQL
            ? await dbAllAsync(
                `SELECT user_id, book_id, event_type, event_value, created_at
                 FROM book_reco_events
                 WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
            )
            : await dbAllAsync(
                `SELECT user_id, book_id, event_type, event_value, created_at
                 FROM book_reco_events
                 WHERE datetime(created_at) >= datetime('now', '-30 day')`
            );
        const snapshotRows = isMySQL
            ? await dbAllAsync(
                `SELECT user_id, book_id, score
                 FROM user_item_score_snapshot
                 WHERE updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
            )
            : await dbAllAsync(
                `SELECT user_id, book_id, score
                 FROM user_item_score_snapshot
                 WHERE datetime(updated_at) >= datetime('now', '-30 day')`
            );
        const videoTagRows = await dbAllAsync(
            `SELECT book_id, video_tags, video_category, video_topic
             FROM user_videos
             WHERE book_id IS NOT NULL`
        );
        const videoTagByBook = new Map();
        for (const row of (videoTagRows || [])) {
            const bid = Number(row.book_id);
            if (!bid) continue;
            if (!videoTagByBook.has(bid)) videoTagByBook.set(bid, new Set());
            const s = videoTagByBook.get(bid);
            for (const t of [...parseTags(row.video_tags), ...parseTags(row.video_category), ...parseTags(row.video_topic)]) s.add(t);
        }

        const nowMs = Date.now();
        const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
        const bookTokenCounts = new Map();
        const docFreq = new Map();
        const N = Math.max(1, books.length);
        for (const b of books) {
            const tokens = [
                ...tokenizeText(b.title),
                ...tokenizeText(b.author),
                ...tokenizeText(b.category),
                ...tokenizeText(b.description),
                ...Array.from(videoTagByBook.get(Number(b.id)) || [])
            ];
            const tf = new Map();
            const seen = new Set();
            for (const tk of tokens) {
                tf.set(tk, (tf.get(tk) || 0) + 1);
                seen.add(tk);
            }
            bookTokenCounts.set(Number(b.id), tf);
            for (const tk of seen) docFreq.set(tk, (docFreq.get(tk) || 0) + 1);
        }
        const bookVectors = new Map();
        for (const b of books) {
            const tf = bookTokenCounts.get(Number(b.id)) || new Map();
            const total = Math.max(1, Array.from(tf.values()).reduce((a, c) => a + c, 0));
            const vec = new Map();
            for (const [tk, c] of tf.entries()) {
                const tfNorm = c / total;
                const idf = Math.log((N + 1) / ((docFreq.get(tk) || 0) + 1)) + 1;
                vec.set(tk, tfNorm * idf);
            }
            bookVectors.set(Number(b.id), vec);
        }

        const userBookScore = new Map();
        const hotScore = new Map();
        if (Array.isArray(snapshotRows) && snapshotRows.length > 0) {
            for (const row of snapshotRows) {
                const uid = Number(row.user_id || 0);
                const bid = Number(row.book_id || 0);
                if (!uid || !bid) continue;
                if (!userBookScore.has(uid)) userBookScore.set(uid, new Map());
                const m = userBookScore.get(uid);
                m.set(bid, Number(row.score || 0));
            }
        }
        for (const ev of (events || [])) {
            const weighted = getDecayWeightedScore(ev.event_type, ev.event_value, ev.created_at);
            if (!weighted) continue;
            const bid = Number(ev.book_id);
            hotScore.set(bid, (hotScore.get(bid) || 0) + weighted);
            const uid = Number(ev.user_id);
            const eventType = String(ev.event_type || '');
            if (!uid || eventType === 'impression') continue;
            if (!userBookScore.has(uid)) userBookScore.set(uid, new Map());
            const m = userBookScore.get(uid);
            // 有快照时，避免重复叠加同一历史，在线事件仅作为轻量增益
            const boost = snapshotRows.length > 0 ? weighted * 0.08 : weighted;
            m.set(bid, (m.get(bid) || 0) + boost);
        }
        const targetVector = userBookScore.get(userId) || new Map();
        const targetInteracted = new Set(targetVector.keys());
        const userContentProfile = new Map();
        for (const [bookId, score] of targetVector.entries()) {
            const bv = bookVectors.get(bookId);
            if (!bv) continue;
            for (const [tk, w] of bv.entries()) userContentProfile.set(tk, (userContentProfile.get(tk) || 0) + w * score);
        }
        const contentScore = new Map();
        if (userContentProfile.size > 0) {
            for (const b of books) {
                if (targetInteracted.has(Number(b.id))) continue;
                const sim = cosineMap(userContentProfile, bookVectors.get(Number(b.id)) || new Map());
                if (sim > 0) contentScore.set(Number(b.id), sim);
            }
        }
        const neighborSims = [];
        if (targetVector.size >= cfMinInteractions) {
            for (const [uid, vec] of userBookScore.entries()) {
                if (uid === userId) continue;
                const sim = cfSimilarity === 'pearson' ? pearsonMap(targetVector, vec) : cosineMap(targetVector, vec);
                if (sim > 0.01) neighborSims.push({ uid, sim });
            }
        }
        neighborSims.sort((a, b) => b.sim - a.sim);
        const topNeighbors = neighborSims.slice(0, 20);
        const cfEnabled = topNeighbors.length >= cfMinNeighbors;
        const cfScore = new Map();
        if (cfEnabled) {
            for (const nb of topNeighbors) {
                const vec = userBookScore.get(nb.uid) || new Map();
                for (const [bookId, s] of vec.entries()) {
                    if (targetInteracted.has(bookId)) continue;
                    cfScore.set(bookId, (cfScore.get(bookId) || 0) + nb.sim * s);
                }
            }
        }
        const hotVals = Array.from(hotScore.values());
        const hotMin = hotVals.length ? Math.min(...hotVals) : 0;
        const hotMax = hotVals.length ? Math.max(...hotVals) : 1;
        const cfVals = Array.from(cfScore.values());
        const cfMin = cfVals.length ? Math.min(...cfVals) : 0;
        const cfMax = cfVals.length ? Math.max(...cfVals) : 1;
        const ctVals = Array.from(contentScore.values());
        const ctMin = ctVals.length ? Math.min(...ctVals) : 0;
        const ctMax = ctVals.length ? Math.max(...ctVals) : 1;
        const ranked = [];
        for (const b of books) {
            if (targetInteracted.has(Number(b.id))) continue;
            const cf = cfEnabled ? normalize01(cfScore.get(Number(b.id)) || 0, cfMin, cfMax) : 0;
            const ct = normalize01(contentScore.get(Number(b.id)) || 0, ctMin, ctMax);
            const hot = normalize01(hotScore.get(Number(b.id)) || 0, hotMin, hotMax);
            const freshDays = Math.max(0, (nowMs - new Date(b.created_at || nowMs).getTime()) / (24 * 3600 * 1000));
            const fresh = Math.exp(-freshDays / 45);
            const finalScore = 0.4 * cf + 0.35 * ct + 0.15 * hot + 0.1 * fresh;
            let reason = '热门推荐';
            let strategy = 'hot';
            if (cf >= ct && cf > 0.2) {
                reason = '与你兴趣相似用户喜欢';
                strategy = 'cf';
            } else if (ct > 0.2) {
                reason = '与你偏好内容相似';
                strategy = 'content';
            } else if (fresh > 0.8) {
                reason = '新书探索推荐';
                strategy = 'fresh';
            }
            ranked.push({
                id: b.id,
                title: b.title,
                author: b.author,
                category: b.category,
                description: b.description,
                cover_url: b.cover_url,
                price: b.price,
                rating: b.rating,
                score: Number(finalScore.toFixed(6)),
                reason,
                strategy
            });
        }
        ranked.sort((a, b) => b.score - a.score);
        return res.status(200).json({
            success: true,
            source: 'hybrid_compute',
            engine: 'hybrid-cf-content',
            recommendations: ranked.slice(0, limit)
        });
    } catch (error) {
        console.error('[reco-service] /internal/reco/books failed:', error.message);
        res.status(500).json({ success: false, message: '推荐服务异常' });
    }
});

async function drainRecoEventQueue(batchSize = 300) {
    const safeBatch = Math.max(1, Math.min(1000, Number(batchSize) || 300));
    const pendingRows = isMySQL
        ? await dbAllAsync(
            `SELECT id, user_id, session_id, book_id, event_type, event_value, scene, strategy, created_at
             FROM reco_event_queue
             WHERE status = 'pending'
               AND available_at <= NOW()
             ORDER BY id ASC
             LIMIT ${safeBatch}`
        )
        : await dbAllAsync(
            `SELECT id, user_id, session_id, book_id, event_type, event_value, scene, strategy, created_at
             FROM reco_event_queue
             WHERE status = 'pending'
               AND datetime(available_at) <= datetime('now')
             ORDER BY id ASC
             LIMIT ?`,
            [batchSize]
        );
    if (!pendingRows.length) return { processed: 0 };
    for (const row of pendingRows) {
        const qid = Number(row.id || 0);
        if (!qid) continue;
        try {
            await dbRunAsync(
                `UPDATE reco_event_queue
                 SET status = 'processing', attempts = COALESCE(attempts, 0) + 1
                 WHERE id = ? AND status = 'pending'`,
                [qid]
            );
            const userId = Number(row.user_id || 0);
            const bookId = Number(row.book_id || 0);
            const eventType = String(row.event_type || '');
            const eventValueRaw = Number(row.event_value || 1);
            const eventValue = Number.isFinite(eventValueRaw) ? eventValueRaw : 1;
            const scene = String(row.scene || 'book_square');
            const sessionId = String(row.session_id || '');
            const strategy = String(row.strategy || '');
            if (!userId || !bookId || !eventType) {
                await dbRunAsync(
                    `UPDATE reco_event_queue
                     SET status = 'failed', error_message = ?, processed_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    ['invalid payload', qid]
                );
                continue;
            }
            await dbRunAsync(
                `INSERT INTO book_reco_events (user_id, session_id, book_id, event_type, event_value, scene, strategy, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [userId, sessionId, bookId, eventType, eventValue, scene, strategy]
            );
            const inc = getDecayWeightedScore(eventType, eventValue, row.created_at);
            const safeInc = Number.isFinite(inc) ? inc : 0;
            if (isMySQL) {
                await dbRunAsync(
                    `INSERT INTO user_item_score_snapshot (user_id, book_id, score, updated_at)
                     VALUES (?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE
                        score = score + VALUES(score),
                        updated_at = NOW()`,
                    [userId, bookId, safeInc]
                );
            } else {
                await dbRunAsync(
                    `INSERT INTO user_item_score_snapshot (user_id, book_id, score, updated_at)
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(user_id, book_id) DO UPDATE SET
                        score = user_item_score_snapshot.score + excluded.score,
                        updated_at = CURRENT_TIMESTAMP`,
                    [userId, bookId, safeInc]
                );
            }
            await dbRunAsync(
                `UPDATE reco_event_queue
                 SET status = 'done', processed_at = CURRENT_TIMESTAMP, error_message = ''
                 WHERE id = ?`,
                [qid]
            );
        } catch (error) {
            const msg = String(error.message || 'consume failed').slice(0, 300);
            if (isMySQL) {
                await dbRunAsync(
                    `UPDATE reco_event_queue
                     SET status = CASE WHEN COALESCE(attempts, 0) >= 5 THEN 'failed' ELSE 'pending' END,
                         available_at = CASE
                            WHEN COALESCE(attempts, 0) >= 5 THEN available_at
                            ELSE DATE_ADD(NOW(), INTERVAL 15 SECOND)
                         END,
                         error_message = ?
                     WHERE id = ?`,
                    [msg, qid]
                ).catch(() => {});
            } else {
                await dbRunAsync(
                    `UPDATE reco_event_queue
                     SET status = CASE WHEN COALESCE(attempts, 0) >= 5 THEN 'failed' ELSE 'pending' END,
                         available_at = CASE
                            WHEN COALESCE(attempts, 0) >= 5 THEN available_at
                            ELSE datetime('now', '+15 seconds')
                         END,
                         error_message = ?
                     WHERE id = ?`,
                    [msg, qid]
                ).catch(() => {});
            }
        }
    }
    return { processed: pendingRows.length };
}

// 独立推荐服务（第一版）：写入推荐事件队列。
app.post('/internal/reco/event', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const bookId = Number(req.body?.book_id);
        const eventType = String(req.body?.event_type || '').trim();
        const eventValue = Number(req.body?.event_value || 1);
        const scene = String(req.body?.scene || 'book_square');
        const sessionId = String(req.body?.session_id || '');
        const strategy = String(req.body?.strategy || '');
        if (!userId || !bookId || !eventType) {
            return res.status(400).json({ success: false, message: '参数不完整' });
        }
        await dbRunAsync(
            `INSERT INTO reco_event_queue (user_id, session_id, book_id, event_type, event_value, scene, strategy, status, available_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
            [userId, sessionId, bookId, eventType, isFinite(eventValue) ? eventValue : 1, scene, strategy]
        );
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[reco-service] /internal/reco/event failed:', error.message);
        res.status(500).json({ success: false, message: '事件写入失败' });
    }
});

app.post('/internal/reco/video-event', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const videoId = Number(req.body?.video_id);
        const eventType = String(req.body?.event_type || '').trim();
        const eventValue = Number(req.body?.event_value || 1);
        const scene = String(req.body?.scene || 'book_square_video');
        const sessionId = String(req.body?.session_id || '');
        const strategy = String(req.body?.strategy || '');
        if (!userId || !videoId || !eventType) {
            return res.status(400).json({ success: false, message: '参数不完整' });
        }
        const videoRows = await dbAllAsync(
            `SELECT id, book_id, book_name, video_name
             FROM user_videos
             WHERE id = ?
             LIMIT 1`,
            [videoId]
        );
        const video = videoRows[0];
        if (!video) {
            return res.status(404).json({ success: false, message: '视频不存在' });
        }
        let mappedBookId = Number(video.book_id || 0);
        if (!mappedBookId) {
            const bookName = String(video.book_name || '').trim();
            const videoName = String(video.video_name || '').trim();
            const candidates = await dbAllAsync(
                `SELECT id
                 FROM books
                 WHERE title = ?
                    OR title = ?
                    OR title LIKE ?
                    OR title LIKE ?
                 LIMIT 20`,
                [bookName, videoName, `%${bookName}%`, `%${videoName}%`]
            );
            if (candidates.length) mappedBookId = Number(candidates[0].id || 0);
        }
        if (!mappedBookId) {
            const hotRows = await dbAllAsync(
                `SELECT b.id
                 FROM books b
                 LEFT JOIN (
                    SELECT book_id, SUM((CASE event_type
                        WHEN 'purchase' THEN 6.0
                        WHEN 'cart_add' THEN 4.5
                        WHEN 'favorite' THEN 4.0
                        WHEN 'comment' THEN 3.0
                        WHEN 'detail' THEN 1.5
                        WHEN 'detail_view' THEN 1.5
                        WHEN 'click' THEN 1.2
                        WHEN 'dwell' THEN 2.0
                        WHEN 'impression' THEN 0.03
                        WHEN 'report' THEN -6.0
                        ELSE 0 END) * COALESCE(event_value,1)) AS hot
                    FROM book_reco_events
                    GROUP BY book_id
                 ) hs ON hs.book_id = b.id
                 ORDER BY COALESCE(hs.hot, 0) DESC, b.id DESC
                 LIMIT 1`
            );
            mappedBookId = Number(hotRows[0]?.id || 0);
        }
        if (!mappedBookId) {
            return res.status(200).json({ success: true, mapped: false, message: '暂无可映射图书' });
        }
        await dbRunAsync(
            `INSERT INTO reco_event_queue (user_id, session_id, book_id, event_type, event_value, scene, strategy, status, available_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
            [userId, sessionId, mappedBookId, eventType, isFinite(eventValue) ? eventValue : 1, scene, strategy]
        );
        res.status(200).json({ success: true, mapped: true, book_id: mappedBookId });
    } catch (error) {
        console.error('[reco-service] /internal/reco/video-event failed:', error.message);
        res.status(500).json({ success: false, message: '视频事件写入失败' });
    }
});

app.get('/internal/reco/videos', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
        const rows = await dbAllAsync(
            `SELECT v.id, v.video_name, v.book_name, v.book_id, v.video_url, v.video_tags, v.video_category, v.video_topic,
                    COALESCE(v.likes_count,0) + COALESCE(v.collections_count,0) * 1.5 + COALESCE(v.views,0) * 0.03 AS score
             FROM user_videos v
             WHERE COALESCE(v.video_url, '') <> ''
               AND COALESCE(v.is_banned, 0) = 0
             ORDER BY score DESC, v.id DESC
             LIMIT 200`
        );
        let ranked = (rows || []).slice(0, limit).map((r) => ({
            id: r.id,
            video_name: r.video_name,
            book_name: r.book_name,
            book_id: r.book_id,
            video_url: r.video_url,
            video_tags: r.video_tags,
            video_category: r.video_category,
            video_topic: r.video_topic,
            score: Number(Number(r.score || 0).toFixed(6)),
            reason: '热门视频推荐',
            strategy: 'hot',
            matched_tags: []
        }));

        let effectiveEngine = RECO_TFIDF_ENGINE;
        if (RECO_TFIDF_ENGINE === 'python' && rows && rows.length > 0 && userId) {
            try {
                const userEventRows = isMySQL
                    ? await dbAllAsync(
                        `SELECT e.book_id, e.event_type, e.event_value
                         FROM book_reco_events e
                         WHERE e.user_id = ?
                           AND e.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                         ORDER BY e.created_at DESC
                         LIMIT 500`,
                        [userId]
                    )
                    : await dbAllAsync(
                        `SELECT e.book_id, e.event_type, e.event_value
                         FROM book_reco_events e
                         WHERE e.user_id = ?
                           AND datetime(e.created_at) >= datetime('now', '-30 day')
                         ORDER BY e.created_at DESC
                         LIMIT 500`,
                        [userId]
                    );
                const bookIds = Array.from(new Set((userEventRows || []).map((x) => Number(x.book_id)).filter(Boolean)));
                let userTokens = [];
                if (bookIds.length) {
                    const placeholders = bookIds.map(() => '?').join(',');
                    const bookVideoRows = await dbAllAsync(
                        `SELECT video_tags, video_category, video_topic
                         FROM user_videos
                         WHERE book_id IN (${placeholders})`,
                        bookIds
                    );
                    for (const r of (bookVideoRows || [])) {
                        userTokens.push(...parseTags(r.video_tags), ...parseTags(r.video_category), ...parseTags(r.video_topic));
                    }
                }
                userTokens = Array.from(new Set(userTokens)).slice(0, 300);
                if (userTokens.length) {
                    let py = null;
                    if (RECO_TFIDF_API_URL) {
                        try {
                            py = await runPythonTfidfByApi({
                                user_tokens: userTokens,
                                candidates: rows.map((r) => ({
                                    video_tags: r.video_tags,
                                    video_category: r.video_category,
                                    video_topic: r.video_topic
                                })),
                                limit
                            });
                            effectiveEngine = 'python_api';
                        } catch (apiErr) {
                            console.warn('[reco-service] python tfidf api fallback to spawn:', apiErr.message);
                        }
                    }
                    if (!py) {
                        py = await runPythonTfidf({
                            user_tokens: userTokens,
                            candidates: rows.map((r) => ({
                                video_tags: r.video_tags,
                                video_category: r.video_category,
                                video_topic: r.video_topic
                            })),
                            limit
                        });
                        effectiveEngine = 'python_spawn';
                    }
                    if (py && py.success && Array.isArray(py.scores) && py.scores.length) {
                        const out = [];
                        for (const s of py.scores) {
                            const idx = Number(s.idx);
                            const score = Number(s.score || 0);
                            if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) continue;
                            const r = rows[idx];
                            const tags = parseTags(r.video_tags);
                            const matched = tags.filter((t) => userTokens.includes(t)).slice(0, 3);
                            out.push({
                                id: r.id,
                                video_name: r.video_name,
                                book_name: r.book_name,
                                book_id: r.book_id,
                                video_url: r.video_url,
                                video_tags: r.video_tags,
                                video_category: r.video_category,
                                video_topic: r.video_topic,
                                score: Number(score.toFixed(6)),
                                reason: matched.length ? `命中标签：${matched.join('、')}` : '与你偏好内容相似',
                                strategy: 'content',
                                matched_tags: matched
                            });
                        }
                        if (out.length) ranked = out.slice(0, limit);
                    }
                }
            } catch (err) {
                effectiveEngine = 'native';
                console.warn('[reco-service] python tfidf fallback to native:', err.message);
            }
        }
        res.status(200).json({
            success: true,
            engine: effectiveEngine,
            recommendations: ranked
        });
    } catch (error) {
        console.error('[reco-service] /internal/reco/videos failed:', error.message);
        res.status(500).json({ success: false, message: '视频推荐服务异常' });
    }
});

app.listen(PORT, () => {
    Promise.resolve()
        .then(() => initMySQL())
        .then(() => {
            console.log(`[reco-service] running on http://localhost:${PORT}`);
            setInterval(async () => {
                try {
                    await drainRecoEventQueue(300);
                } catch (error) {
                    console.warn('[reco-service] queue drain failed:', error.message);
                }
            }, 3000);
        })
        .catch((error) => {
            console.error('[reco-service] boot failed:', error.message);
            process.exit(1);
        });
});
