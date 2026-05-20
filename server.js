// 引入所需模块
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');
const nodemailer = require('nodemailer');
const axios = require('axios');
const multer = require('multer');
const { KgNeo4jService } = require('./kg-neo4j');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// 创建Express应用
const app = express();
const PORT = process.env.PORT || 3001;
const RECO_GATEWAY_ENABLED = String(process.env.RECO_GATEWAY_ENABLED || '0') === '1';
const RECO_SERVICE_BASE_URL = process.env.RECO_SERVICE_BASE_URL || 'http://localhost:3011';
const RECO_ALERT_WEBHOOK_URL = String(process.env.RECO_ALERT_WEBHOOK_URL || '').trim();
const RECO_ALERT_NOTIFY_COOLDOWN_SEC = Math.max(60, Number(process.env.RECO_ALERT_NOTIFY_COOLDOWN_SEC) || 600);
const AMAP_WEB_KEY = String(process.env.AMAP_WEB_KEY || '').trim();
const SHIPPING_ORIGIN_ADDRESS = String(process.env.SHIPPING_ORIGIN_ADDRESS || '北京市朝阳区望京SOHO').trim();
const recoGatewayState = {
    healthy: true,
    last_checked_at: 0,
    last_error: '',
    latency_ms: 0,
    routed_count: 0,
    local_count: 0,
    fallback_count: 0,
    proxy_error_count: 0
};
const recoAlertNotifyState = {
    last_signature: '',
    last_sent_at: 0
};

function markRecoGatewayRoute(kind) {
    if (kind === 'routed') recoGatewayState.routed_count += 1;
    else if (kind === 'local') recoGatewayState.local_count += 1;
    else if (kind === 'fallback') recoGatewayState.fallback_count += 1;
    else if (kind === 'proxy_error') recoGatewayState.proxy_error_count += 1;
}

function getRecoGatewayCounterSummary() {
    const routed = Number(recoGatewayState.routed_count || 0);
    const local = Number(recoGatewayState.local_count || 0);
    const fallback = Number(recoGatewayState.fallback_count || 0);
    const proxyErr = Number(recoGatewayState.proxy_error_count || 0);
    const total = routed + local + fallback;
    const safePct = (x) => total > 0 ? Number(((x / total) * 100).toFixed(2)) : 0;
    return {
        total_count: total,
        routed_count: routed,
        local_count: local,
        fallback_count: fallback,
        proxy_error_count: proxyErr,
        routed_pct: safePct(routed),
        local_pct: safePct(local),
        fallback_pct: safePct(fallback),
        proxy_error_pct: safePct(proxyErr)
    };
}

// 中间件设置
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function forwardToRecoService(pathname, method = 'GET', token = '', query = {}, body = null) {
    const cfg = getRecoSettings ? getRecoSettings() : {};
    const dynamicBase = String(cfg.reco_gateway_base_url || RECO_SERVICE_BASE_URL || 'http://localhost:3011').trim();
    const baseUrl = dynamicBase.replace(/\/+$/, '');
    const url = `${baseUrl}${pathname}`;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await axios({
        url,
        method,
        headers,
        params: query,
        data: body,
        timeout: 5000
    });
    return response.data || {};
}

async function checkRecoGatewayHealth() {
    const cfg = getRecoSettings ? getRecoSettings() : {};
    const enabled = !!cfg.reco_gateway_enabled;
    if (!enabled) {
        recoGatewayState.healthy = true;
        recoGatewayState.last_error = '';
        return recoGatewayState;
    }
    const base = String(cfg.reco_gateway_base_url || RECO_SERVICE_BASE_URL || 'http://localhost:3011').replace(/\/+$/, '');
    const start = Date.now();
    try {
        await axios.get(`${base}/health`, { timeout: 2500 });
        recoGatewayState.healthy = true;
        recoGatewayState.last_checked_at = Date.now();
        recoGatewayState.last_error = '';
        recoGatewayState.latency_ms = Date.now() - start;
    } catch (error) {
        recoGatewayState.healthy = false;
        recoGatewayState.last_checked_at = Date.now();
        recoGatewayState.last_error = String(error.message || 'unknown');
        recoGatewayState.latency_ms = Date.now() - start;
    }
    return recoGatewayState;
}

// 配置multer用于文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'uploads', 'videos');
        // 确保上传目录存在
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // 生成唯一文件名:时间戳 + 原始文件名
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        cb(null, name + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 限制文件大小为500MB
    },
    fileFilter: function (req, file, cb) {
        // 只允许视频文件
        const allowedMimes = ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/x-ms-wmv', 'video/x-matroska'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('只允许上传视频文件（MP4、MOV、AVI等格式）'));
        }
    }
});

const audioStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = path.join(__dirname, 'uploads', 'audio');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname) || '.mp3';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, 'track-' + uniqueSuffix + ext);
    }
});
const uploadAudio = multer({
    storage: audioStorage,
    limits: { fileSize: 80 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const ok =
            /audio\//i.test(file.mimetype) ||
            /\.(mp3|wav|aac|m4a|ogg|flac|webm)$/i.test(file.originalname || '');
        if (ok) cb(null, true);
        else cb(new Error('请上传常见音频格式（mp3/wav/aac/m4a/ogg 等）'));
    }
});

// 提供上传的视频文件访问（这个可以保留，因为路径明确）
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/images', express.static(path.join(__dirname, '图片')));

// 注意:静态文件服务应该放在所有API路由之后，见文件末尾

// 初始化SQLite数据库
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('数据库连接失败:', err.message);
    } else {
        console.log('已连接到SQLite数据库');
        // 创建用户表
                db.run(`CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    email TEXT NOT NULL UNIQUE,
                    password TEXT NOT NULL,
                    is_admin INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        console.error('创建用户表失败:', err.message);
                    } else {
                        console.log('用户表已创建或已存在');
                    }
                });
                
                // 创建验证码表
                db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    code TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP NOT NULL
                )`, (err) => {
                    if (err) {
                        console.error('创建验证码表失败:', err.message);
                    } else {
                        console.log('验证码表已创建或已存在');
                    }
                });
                
                // 创建应用商店表
                db.run(`CREATE TABLE IF NOT EXISTS applications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    icon_url TEXT,
                    download_url TEXT NOT NULL,
                    category TEXT NOT NULL,
                    version TEXT NOT NULL,
                    author TEXT NOT NULL,
                    author_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    downloads INTEGER DEFAULT 0,
                    rating REAL DEFAULT 0.0,
                    is_approved INTEGER DEFAULT 0
                )`, (err) => {
                    if (err) {
                        console.error('创建应用商店表失败:', err.message);
                    } else {
                        console.log('应用商店表已创建或已存在');
                    }
                });
                
                // 创建应用下载记录表
                db.run(`CREATE TABLE IF NOT EXISTS app_downloads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    app_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    download_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (app_id) REFERENCES applications(id),
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )`, (err) => {
                    if (err) {
                        console.error('创建应用下载记录表失败:', err.message);
                    } else {
                        console.log('应用下载记录表已创建或已存在');
                    }
                });
                
                // 创建图书表
                db.run(`CREATE TABLE IF NOT EXISTS books (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    author TEXT NOT NULL,
                    cover_url TEXT,
                    description TEXT NOT NULL,
                    category TEXT NOT NULL,
                    price REAL NOT NULL,
                    stock_quantity INTEGER DEFAULT 0,
                    shelf_status TEXT DEFAULT 'on_sale',
                    pages INTEGER,
                    publisher TEXT,
                    publish_date TEXT,
                    rating REAL DEFAULT 0.0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        console.error('创建图书表失败:', err.message);
                    } else {
                        console.log('图书表已创建或已存在');
                    }
                });
                
                // 创建购物车表
                db.run(`CREATE TABLE IF NOT EXISTS cart_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    book_id INTEGER NOT NULL,
                    quantity INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id),
                    FOREIGN KEY (book_id) REFERENCES books(id),
                    UNIQUE(user_id, book_id)
                )`, (err) => {
                    if (err) {
                        console.error('创建购物车表失败:', err.message);
                    } else {
                        console.log('购物车表已创建或已存在');
                    }
                });
                
                // 创建用户地址簿表（淘宝式历史地址）
                db.run(`CREATE TABLE IF NOT EXISTS user_addresses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    consignee_name TEXT NOT NULL DEFAULT '',
                    phone TEXT NOT NULL DEFAULT '',
                    province_code TEXT DEFAULT '',
                    province_name TEXT DEFAULT '',
                    city_code TEXT DEFAULT '',
                    city_name TEXT DEFAULT '',
                    district_code TEXT DEFAULT '',
                    district_name TEXT DEFAULT '',
                    town_code TEXT DEFAULT '',
                    town_name TEXT DEFAULT '',
                    detail_address TEXT NOT NULL DEFAULT '',
                    full_address TEXT NOT NULL DEFAULT '',
                    tag TEXT DEFAULT '',
                    is_default INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )`, (err) => {
                    if (err) {
                        console.error('创建用户地址簿表失败:', err.message);
                    } else {
                        console.log('用户地址簿表已创建或已存在');
                    }
                });
                
                // 创建应用评分表
                db.run(`CREATE TABLE IF NOT EXISTS app_ratings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    app_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    rating INTEGER NOT NULL,
                    comment TEXT,
                    rated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (app_id) REFERENCES applications(id),
                    FOREIGN KEY (user_id) REFERENCES users(id),
                    UNIQUE (app_id, user_id)
                )`, (err) => {
                    if (err) {
                        console.error('创建应用评分表失败:', err.message);
                    } else {
                        console.log('应用评分表已创建或已存在');
                    }
                });
                
                // 创建订单表
                db.run(`CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    total_amount REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    payment_method TEXT NOT NULL,
                    shipping_address TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )`, (err) => {
                    if (err) {
                        console.error('创建订单表失败:', err.message);
                    } else {
                        console.log('订单表已创建或已存在');
                    }
                });
                
                // 创建订单详情表
                db.run(`CREATE TABLE IF NOT EXISTS order_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    book_id INTEGER NOT NULL,
                    quantity INTEGER NOT NULL,
                    price REAL NOT NULL,
                    FOREIGN KEY (order_id) REFERENCES orders(id),
                    FOREIGN KEY (book_id) REFERENCES books(id)
                )`, (err) => {
                    if (err) {
                        console.error('创建订单详情表失败:', err.message);
                    } else {
                        console.log('订单详情表已创建或已存在');
                    }
                });

                // 创建物流轨迹表
                db.run(`CREATE TABLE IF NOT EXISTS shipping_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    node_code TEXT DEFAULT '',
                    content TEXT NOT NULL,
                    location TEXT DEFAULT '',
                    lng REAL,
                    lat REAL,
                    seq INTEGER DEFAULT 0,
                    is_exception INTEGER DEFAULT 0,
                    operator_id INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (operator_id) REFERENCES users(id)
                )`, (err) => {
                    if (err) {
                        console.error('创建物流轨迹表失败:', err.message);
                    } else {
                        console.log('物流轨迹表已创建或已存在');
                    }
                });

                // 创建物流路线节点表（高德路线切片）
                db.run(`CREATE TABLE IF NOT EXISTS shipping_route_nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    content TEXT NOT NULL,
                    location TEXT DEFAULT '',
                    lng REAL,
                    lat REAL,
                    distance_m INTEGER DEFAULT 0,
                    duration_s INTEGER DEFAULT 0,
                    is_done INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(order_id, seq),
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
                )`, (err) => {
                    if (err) {
                        console.error('创建物流路线节点表失败:', err.message);
                    } else {
                        console.log('物流路线节点表已创建或已存在');
                    }
                });

                // 创建退款申请表
                db.run(`CREATE TABLE IF NOT EXISTS refund_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    refund_type TEXT DEFAULT 'only_refund',
                    reason_code TEXT DEFAULT '',
                    reason_text TEXT DEFAULT '',
                    request_amount REAL NOT NULL,
                    description TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    admin_reply TEXT DEFAULT '',
                    reviewed_by INTEGER,
                    reviewed_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewed_by) REFERENCES users(id)
                )`, (err) => {
                    if (err) {
                        console.error('创建退款申请表失败:', err.message);
                    } else {
                        console.log('退款申请表已创建或已存在');
                    }
                });
                
                // 创建图书评价表
                db.run(`CREATE TABLE IF NOT EXISTS reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    book_id INTEGER NOT NULL,
                    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
                    content TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
                    UNIQUE(user_id, book_id)
                )`, (err) => {
                    if (err) {
                        console.error('创建图书评价表失败:', err.message);
                    } else {
                        console.log('图书评价表已创建或已存在');
                    }
                });
                
                // 创建图书收藏表
                db.run(`CREATE TABLE IF NOT EXISTS favorites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    book_id INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
                    UNIQUE(user_id, book_id)
                )`, (err) => {
                    if (err) {
                        console.error('创建图书收藏表失败:', err.message);
                    } else {
                        console.log('图书收藏表已创建或已存在');
                    }
                });
                
                // 图书推荐行为事件表
                db.run(`CREATE TABLE IF NOT EXISTS book_reco_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    session_id TEXT,
                    book_id INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    event_value REAL DEFAULT 1,
                    scene TEXT DEFAULT 'book_square',
                    strategy TEXT DEFAULT '',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
                )`, (err) => {
                    if (err) {
                        console.error('创建图书推荐行为表失败:', err.message);
                    } else {
                        console.log('图书推荐行为表已创建或已存在');
                    }
                });
                
                // 轻量事件总线：推荐事件队列表（先入队，后消费）
                db.run(`CREATE TABLE IF NOT EXISTS reco_event_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    session_id TEXT,
                    book_id INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    event_value REAL DEFAULT 1,
                    scene TEXT DEFAULT 'book_square',
                    strategy TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    attempts INTEGER DEFAULT 0,
                    available_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    error_message TEXT DEFAULT '',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    processed_at DATETIME
                )`, (err) => {
                    if (err) {
                        console.error('创建推荐事件队列表失败:', err.message);
                    } else {
                        console.log('推荐事件队列表已创建或已存在');
                    }
                });
                
                // 图书推荐缓存表（可选提速）
                db.run(`CREATE TABLE IF NOT EXISTS book_reco_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    book_id INTEGER NOT NULL,
                    score REAL NOT NULL,
                    reason TEXT DEFAULT '',
                    strategy TEXT DEFAULT 'hybrid',
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, book_id),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
                )`, (err) => {
                    if (err) {
                        console.error('创建图书推荐缓存表失败:', err.message);
                    } else {
                        console.log('图书推荐缓存表已创建或已存在');
                    }
                });
                
                // 推荐系统配置（开关、权重、缓存TTL）
                db.run(`CREATE TABLE IF NOT EXISTS reco_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    enabled INTEGER DEFAULT 1,
                    cache_enabled INTEGER DEFAULT 1,
                    cache_ttl_sec INTEGER DEFAULT 120,
                    cf_min_interactions INTEGER DEFAULT 3,
                    cf_min_neighbors INTEGER DEFAULT 2,
                    cf_similarity TEXT DEFAULT 'cosine',
                    ab_enabled INTEGER DEFAULT 0,
                    ab_traffic_pct REAL DEFAULT 20,
                    ab_variant_cf_min_interactions INTEGER DEFAULT 1,
                    ab_variant_cf_min_neighbors INTEGER DEFAULT 1,
                    ab_variant_cf_similarity TEXT DEFAULT 'pearson',
                    alert_cf_hit_min_pct REAL DEFAULT 5,
                    alert_ctr_min_pct REAL DEFAULT 1,
                    reco_gateway_enabled INTEGER DEFAULT 0,
                    reco_gateway_base_url TEXT DEFAULT 'http://localhost:3011',
                    reco_gateway_traffic_pct REAL DEFAULT 100,
                    weights_json TEXT DEFAULT '{}',
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        console.error('创建推荐配置表失败:', err.message);
                    } else {
                        console.log('推荐配置表已创建或已存在');
                        db.run(
                            `INSERT OR IGNORE INTO reco_settings (id, enabled, cache_enabled, cache_ttl_sec, weights_json, updated_at)
                             VALUES (1, 1, 1, 120, '{"impression":0.03,"click":1.2,"detail":1.5,"detail_view":1.5,"favorite":4.0,"cart_add":4.5,"purchase":6.0,"comment":3.0,"report":-6.0,"dwell":2.0}', CURRENT_TIMESTAMP)`,
                            (seedErr) => {
                                if (seedErr) {
                                    console.warn('初始化推荐配置默认值失败:', seedErr.message);
                                }
                            }
                        );
                    }
                });

                // 推荐告警日志（自动巡检结果）
                db.run(`CREATE TABLE IF NOT EXISTS reco_alert_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT DEFAULT 'manual',
                    status TEXT DEFAULT 'ok',
                    alerts_json TEXT DEFAULT '[]',
                    metrics_json TEXT DEFAULT '{}',
                    thresholds_json TEXT DEFAULT '{}',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`, (err) => {
                    if (err) {
                        console.error('创建推荐告警日志表失败:', err.message);
                    } else {
                        console.log('推荐告警日志表已创建或已存在');
                    }
                });
                
                // 用户-物品评分矩阵快照（用于推荐提速与稳定）
                db.run(`CREATE TABLE IF NOT EXISTS user_item_score_snapshot (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    book_id INTEGER NOT NULL,
                    score REAL NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, book_id),
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
                )`, (err) => {
                    if (err) {
                        console.error('创建用户-物品快照表失败:', err.message);
                    } else {
                        console.log('用户-物品快照表已创建或已存在');
                    }
                });
                
                // 创建视频库表
                db.run(`CREATE TABLE IF NOT EXISTS user_videos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    video_url TEXT NOT NULL,
                    video_name TEXT NOT NULL,
                    book_name TEXT NOT NULL,
                    book_id INTEGER,
                    video_tags TEXT DEFAULT '',
                    video_category TEXT DEFAULT '',
                    video_topic TEXT DEFAULT '',
                    author TEXT NOT NULL,
                    duration TEXT DEFAULT '00:00',
                    description TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    review_time TIMESTAMP,
                    is_shared INTEGER DEFAULT 0,
                    FOREIGN KEY (user_id) REFERENCES users(id)
                )`, (err) => {
                    if (err) {
                        console.error('创建视频库表失败:', err.message);
                    } else {
                        console.log('视频库表已创建或已存在');
                    }
                });
                
                // 创建视频点赞表
                db.run(`CREATE TABLE IF NOT EXISTS video_likes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    video_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (video_id) REFERENCES user_videos(id) ON DELETE CASCADE,
                    UNIQUE(user_id, video_id)
                )`, (err) => {
                    if (err) {
                        console.error('创建视频点赞表失败:', err.message);
                    } else {
                        console.log('视频点赞表已创建或已存在');
                    }
                });
                
                // 创建视频收藏表
                db.run(`CREATE TABLE IF NOT EXISTS video_collections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    video_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (video_id) REFERENCES user_videos(id) ON DELETE CASCADE,
                    UNIQUE(user_id, video_id)
                )`, (err) => {
                    if (err) {
                        console.error('创建视频收藏表失败:', err.message);
                    } else {
                        console.log('视频收藏表已创建或已存在');
                    }
                });
                
                // 创建视频评论表
                db.run(`CREATE TABLE IF NOT EXISTS video_comments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    video_id INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (video_id) REFERENCES user_videos(id) ON DELETE CASCADE
                )`, (err) => {
                    if (err) {
                        console.error('创建视频评论表失败:', err.message);
                    } else {
                        console.log('视频评论表已创建或已存在');
                    }
                });
                
                // 创建视频浏览记录表
                db.run(`CREATE TABLE IF NOT EXISTS video_views (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    video_id INTEGER NOT NULL,
                    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (video_id) REFERENCES user_videos(id) ON DELETE CASCADE,
                    UNIQUE(user_id, video_id)
                )`, (err) => {
                    if (err) {
                        console.error('创建视频浏览记录表失败:', err.message);
                    } else {
                        console.log('视频浏览记录表已创建或已存在');
                    }
                });
                
                // 创建视频举报表
                db.run(`CREATE TABLE IF NOT EXISTS video_reports (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    video_id INTEGER NOT NULL,
                    reporter_id INTEGER NOT NULL,
                    reason TEXT NOT NULL,
                    note TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    handled_by INTEGER,
                    handled_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (video_id) REFERENCES user_videos(id) ON DELETE CASCADE,
                    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (handled_by) REFERENCES users(id)
                )`, (err) => {
                    if (err) {
                        console.error('创建视频举报表失败:', err.message);
                    } else {
                        console.log('视频举报表已创建或已存在');
                    }
                });
                
                // 为已有表添加缺失的字段（SQLite不支持IF NOT EXISTS，所以直接添加并处理错误）
                const addColumns = async () => {
                    const columnsToAdd = [
                        // user_videos表的字段
                        { table: 'user_videos', sql: `ADD COLUMN author TEXT DEFAULT ''` },
                        { table: 'user_videos', sql: `ADD COLUMN duration TEXT DEFAULT '00:00'` },
                        { table: 'user_videos', sql: `ADD COLUMN description TEXT DEFAULT ''` },
                        { table: 'user_videos', sql: `ADD COLUMN status TEXT DEFAULT 'pending'` },
                        { table: 'user_videos', sql: `ADD COLUMN review_time TIMESTAMP` },
                        { table: 'user_videos', sql: `ADD COLUMN is_banned INTEGER DEFAULT 0` },
                        { table: 'user_videos', sql: `ADD COLUMN book_id INTEGER` },
                        { table: 'user_videos', sql: `ADD COLUMN video_tags TEXT DEFAULT ''` },
                        { table: 'user_videos', sql: `ADD COLUMN video_category TEXT DEFAULT ''` },
                        { table: 'user_videos', sql: `ADD COLUMN video_topic TEXT DEFAULT ''` },
                        // 推荐事件字段
                        { table: 'book_reco_events', sql: `ADD COLUMN strategy TEXT DEFAULT ''` },
                        { table: 'reco_event_queue', sql: `ADD COLUMN strategy TEXT DEFAULT ''` },
                        // reco_settings表的字段
                        { table: 'reco_settings', sql: `ADD COLUMN cf_min_interactions INTEGER DEFAULT 3` },
                        { table: 'reco_settings', sql: `ADD COLUMN cf_min_neighbors INTEGER DEFAULT 2` },
                        { table: 'reco_settings', sql: `ADD COLUMN cf_similarity TEXT DEFAULT 'cosine'` },
                        { table: 'reco_settings', sql: `ADD COLUMN ab_enabled INTEGER DEFAULT 0` },
                        { table: 'reco_settings', sql: `ADD COLUMN ab_traffic_pct REAL DEFAULT 20` },
                        { table: 'reco_settings', sql: `ADD COLUMN ab_variant_cf_min_interactions INTEGER DEFAULT 1` },
                        { table: 'reco_settings', sql: `ADD COLUMN ab_variant_cf_min_neighbors INTEGER DEFAULT 1` },
                        { table: 'reco_settings', sql: `ADD COLUMN ab_variant_cf_similarity TEXT DEFAULT 'pearson'` },
                        { table: 'reco_settings', sql: `ADD COLUMN alert_cf_hit_min_pct REAL DEFAULT 5` },
                        { table: 'reco_settings', sql: `ADD COLUMN alert_ctr_min_pct REAL DEFAULT 1` },
                        { table: 'reco_settings', sql: `ADD COLUMN reco_gateway_enabled INTEGER DEFAULT 0` },
                        { table: 'reco_settings', sql: `ADD COLUMN reco_gateway_base_url TEXT DEFAULT 'http://localhost:3011'` },
                        { table: 'reco_settings', sql: `ADD COLUMN reco_gateway_traffic_pct REAL DEFAULT 100` },
                        // users表的字段
                        { table: 'users', sql: `ADD COLUMN bio TEXT DEFAULT ''` },
                        // books表扩展字段
                        { table: 'books', sql: `ADD COLUMN stock_quantity INTEGER DEFAULT 0` },
                        { table: 'books', sql: `ADD COLUMN shelf_status TEXT DEFAULT 'on_sale'` },
                        // orders表扩展字段
                        { table: 'orders', sql: `ADD COLUMN order_no TEXT` },
                        { table: 'orders', sql: `ADD COLUMN pay_status TEXT DEFAULT 'unpaid'` },
                        { table: 'orders', sql: `ADD COLUMN pay_at DATETIME` },
                        { table: 'orders', sql: `ADD COLUMN cancel_reason_code TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN cancel_reason_text TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN cancelled_at DATETIME` },
                        { table: 'orders', sql: `ADD COLUMN receiver_name TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN receiver_phone TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN receiver_province TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN receiver_city TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN receiver_district TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN receiver_town TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN receiver_address TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN invoice_type TEXT DEFAULT 'none'` },
                        { table: 'orders', sql: `ADD COLUMN invoice_title TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN invoice_tax_no TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN invoice_email TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN invoice_status TEXT DEFAULT 'not_issued'` },
                        { table: 'orders', sql: `ADD COLUMN shipping_status TEXT DEFAULT 'pending'` },
                        { table: 'orders', sql: `ADD COLUMN shipping_company TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN tracking_no TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN shipping_updated_at DATETIME` },
                        { table: 'orders', sql: `ADD COLUMN shipped_at DATETIME` },
                        { table: 'orders', sql: `ADD COLUMN signed_at DATETIME` },
                        { table: 'orders', sql: `ADD COLUMN eta_at DATETIME` },
                        { table: 'orders', sql: `ADD COLUMN delivery_sla_hours INTEGER DEFAULT 72` },
                        { table: 'orders', sql: `ADD COLUMN shipping_is_delayed INTEGER DEFAULT 0` },
                        { table: 'orders', sql: `ADD COLUMN shipping_delay_minutes INTEGER DEFAULT 0` },
                        { table: 'orders', sql: `ADD COLUMN shipping_exception_code TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN shipping_exception_text TEXT DEFAULT ''` },
                        { table: 'orders', sql: `ADD COLUMN origin_lng REAL` },
                        { table: 'orders', sql: `ADD COLUMN origin_lat REAL` },
                        { table: 'orders', sql: `ADD COLUMN dest_lng REAL` },
                        { table: 'orders', sql: `ADD COLUMN dest_lat REAL` },
                        { table: 'orders', sql: `ADD COLUMN route_distance_m INTEGER DEFAULT 0` },
                        { table: 'orders', sql: `ADD COLUMN route_duration_s INTEGER DEFAULT 0` },
                        { table: 'orders', sql: `ADD COLUMN route_source TEXT DEFAULT 'mock'` }
                    ];
                    
                    for (const columnInfo of columnsToAdd) {
                        try {
                            await new Promise((resolve, reject) => {
                                db.run(`ALTER TABLE ${columnInfo.table} ${columnInfo.sql}`, (err) => {
                                    if (err) {
                                        console.log('字段可能已存在:', err.message);
                                        resolve(); // 字段已存在，继续执行
                                    } else {
                                        console.log(`成功添加字段到${columnInfo.table}:`, columnInfo.sql);
                                        resolve();
                                    }
                                });
                            });
                        } catch (error) {
                            console.error('添加字段时发生错误:', error);
                        }
                    }
                };
                
                addColumns();
    }
});

// JWT密钥（实际项目中应存储在环境变量中）
const JWT_SECRET = 'your-secret-key'; // 在生产环境中使用环境变量

// Coze API配置
const COZE_API_KEY = 'pat_bAO5r4IR5qoycsqgJtNjWmeVmtZvcQOymcRLlhlWMp9hJWnq0fZNnFoILYt4y4X1'; // 在生产环境中使用环境变量
const COZE_API_URL = 'https://api.coze.cn/v1/workflow/stream_run'; // 使用流式响应接口

// 剪映小助手API配置
// 根据官方文档:https://jy.0x0.chat/docs/api-reference/create-draft/
// API不需要Token，直接POST JSON即可
const JIANYING_HELPER_API_URL = 'https://jy-api.0x0.chat/v1'; // 剪映小助手API地址

// 邮件发送配置（已配置为QQ邮箱服务）
// 用户提供的真实QQ邮箱地址
let QQ_EMAIL = '2629492923@qq.com'; // 用户提供的真实QQ邮箱地址

// 如果需要修改邮箱地址，可以:
// 1. 直接修改上面的QQ_EMAIL常量
// 2. 或通过环境变量: set QQ_EMAIL=新的邮箱@qq.com
// 3. 或通过命令行参数: node server.js --email=新的邮箱@qq.com

// 从环境变量或命令行参数获取邮箱地址（优先级高于硬编码值）
if (process.env.QQ_EMAIL) {
    console.log('从环境变量获取QQ邮箱地址');
    QQ_EMAIL = process.env.QQ_EMAIL;
} else {
    const args = process.argv.slice(2);
    const emailArg = args.find(arg => arg.startsWith('--email='));
    if (emailArg) {
        console.log('从命令行参数获取QQ邮箱地址');
        QQ_EMAIL = emailArg.split('=')[1];
    }
}

let transporter = nodemailer.createTransport({
    host: 'smtp.qq.com', // QQ邮箱SMTP服务器地址
    port: 465, // QQ邮箱SMTP端口（SSL加密）
    secure: true, // 使用SSL加密
    auth: {
        user: QQ_EMAIL, // QQ邮箱地址
        pass: 'yyqhkuxdemrtdidh' // 用户提供的QQ邮箱授权码
    }
});

// 强制使用真实邮件发送，不自动切换到演示模式
// 验证邮件配置是否正确
transporter.verify(function(error, success) {
    if (error) {
        console.log('邮件服务配置验证失败:', error);
        console.log('请检查您的邮箱地址和授权码是否正确，以及SMTP服务是否已开启');
    } else {
        console.log('邮件服务已准备就绪，可以发送邮件');
    }
});

// 动态更新邮件配置的函数
function updateEmailConfig(newEmail) {
    if (newEmail && newEmail !== QQ_EMAIL) {
        QQ_EMAIL = newEmail;
        // 重新创建transporter实例
        transporter = nodemailer.createTransport({
            host: 'smtp.qq.com',
            port: 465,
            secure: true,
            auth: {
                user: QQ_EMAIL,
                pass: 'yyqhkuxdemrtdidh'
            }
        });
        
        console.log(`邮件配置已更新，使用新的邮箱地址: ${QQ_EMAIL}`);
        
        // 验证新配置
        return new Promise((resolve, reject) => {
            transporter.verify(function(error, success) {
                if (error) {
                    reject(error);
                } else {
                    resolve(success);
                }
            });
        });
    }
    return Promise.resolve(true);
}
app.get('/', (req, res) => {
    res.redirect('/login.html');
});
// 服务器状态API
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        message: '服务器运行正常',
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
        emailConfigured: QQ_EMAIL !== '请替换为您的真实QQ邮箱地址',
        currentEmail: QQ_EMAIL
    });
});

// 动态配置QQ邮箱API
app.post('/api/config-email', (req, res) => {
    const { qqEmail } = req.body;
    
    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!qqEmail || !emailRegex.test(qqEmail)) {
        return res.status(400).json({ 
            success: false, 
            message: '请输入有效的QQ邮箱地址' 
        });
    }
    
    // 检查是否是QQ邮箱
    if (!qqEmail.endsWith('@qq.com')) {
        return res.status(400).json({ 
            success: false, 
            message: '请输入QQ邮箱地址（@qq.com）' 
        });
    }
    
    // 更新邮件配置
    updateEmailConfig(qqEmail)
        .then(() => {
            res.json({
                success: true,
                message: 'QQ邮箱配置已更新',
                email: qqEmail
            });
        })
        .catch(error => {
            console.error('更新邮件配置失败:', error);
            res.status(500).json({
                success: false,
                message: `配置更新失败: ${error.message}`
            });
        });
});

// 生成6位数字验证码
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// 发送验证码API
app.post('/api/send-verification-code', (req, res) => {
    const { email } = req.body;
    
    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: '请输入有效的邮箱地址' });
    }
    
    // 检查邮箱是否已被注册
    db.get('SELECT id FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        if (user) {
            return res.status(400).json({ success: false, message: '该邮箱已被注册' });
        }
        
        // 生成验证码
        const code = generateVerificationCode();
        // 设置验证码有效期为10分钟
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
        
        // 先删除该邮箱的旧验证码
        db.run('DELETE FROM email_verifications WHERE email = ?', [email], (err) => {
            if (err) {
                console.error('删除旧验证码失败:', err.message);
            }
            
            // 保存新验证码
            db.run(
                'INSERT INTO email_verifications (email, code, expires_at) VALUES (?, ?, ?)',
                [email, code, expiresAt.toISOString()],
                (err) => {
                    if (err) {
                        console.error('保存验证码失败:', err.message);
                        return res.status(500).json({ success: false, message: '发送验证码失败，请稍后再试' });
                    }
                    
                    // 构建邮件内容
                    const mailOptions = {
                        from: QQ_EMAIL, // 必须与上面auth.user完全一致
                        to: email,
                        subject: '图书智能宣传系统 - 注册验证码',
                        text: `您的注册验证码是:${code}，有效期为10分钟。请勿将验证码泄露给他人。`
                    };
                    
                    // 发送邮件
                    transporter.sendMail(mailOptions, (error, info) => {
                        if (error) {
                            console.error('发送邮件失败:', error);
                            return res.status(500).json({ success: false, message: '发送验证码失败，请检查邮箱地址是否正确' });
                        }
                        
                        res.status(200).json({ 
                            success: true, 
                            message: '验证码已发送，请注意查收',
                            email: email
                        });
                    });
                }
            );
        });
    });
});

// 注册API
app.post('/api/register', (req, res) => {
    const { username, email, password, verificationCode } = req.body;
    
    // 简单验证
    if (!username || !email || !password || !verificationCode) {
        return res.status(400).json({ success: false, message: '请填写完整的注册信息' });
    }
    
    // 验证用户名长度
    if (username.length < 4 || username.length > 20) {
        return res.status(400).json({ success: false, message: '用户名长度应在4-20个字符之间' });
    }
    
    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: '请输入有效的邮箱地址' });
    }
    
    // 验证密码强度
    const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;
    if (!passwordRegex.test(password)) {
        return res.status(400).json({ success: false, message: '密码至少包含8个字符，包括字母和数字' });
    }
    
    // 验证邮箱验证码
    db.get(
        'SELECT * FROM email_verifications WHERE email = ? AND code = ? ORDER BY created_at DESC LIMIT 1',
        [email, verificationCode],
        (err, verification) => {
            if (err) {
                return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
            }
            
            if (!verification) {
                return res.status(400).json({ success: false, message: '验证码错误' });
            }
            
            // 检查验证码是否过期
            const now = new Date();
            const expiresAt = new Date(verification.expires_at);
            
            if (now > expiresAt) {
                // 删除过期的验证码
                db.run('DELETE FROM email_verifications WHERE id = ?', [verification.id]);
                return res.status(400).json({ success: false, message: '验证码已过期，请重新获取' });
            }
            
            // 加密密码
            bcrypt.hash(password, 10, (err, hashedPassword) => {
                if (err) {
                    return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                }
                
                // 插入用户数据
                db.run(
                    `INSERT INTO users (username, email, password) VALUES (?, ?, ?)`,
                    [username, email, hashedPassword],
                    (err) => {
                        if (err) {
                            if (err.message.includes('UNIQUE constraint failed: users.username')) {
                                return res.status(400).json({ success: false, message: '用户名已存在' });
                            } else if (err.message.includes('UNIQUE constraint failed: users.email')) {
                                return res.status(400).json({ success: false, message: '邮箱已被注册' });
                            }
                            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                        }
                        
                        // 删除已使用的验证码
                        db.run('DELETE FROM email_verifications WHERE email = ?', [email]);
                        
                        res.status(201).json({ success: true, message: '注册成功' });
                    }
                );
            });
        }
    );
});

// 登录API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    console.log('收到登录请求:', { username, passwordLength: password ? password.length : 0 });
    
    // 简单验证
    if (!username || !password) {
        console.log('登录失败: 用户名或密码为空');
        return res.status(400).json({ success: false, message: '请填写完整的登录信息' });
    }
    // 临时解决方案:直接验证密码
    if (username === 'admin' && password === '123456') {
        console.log('临时密码验证成功: admin账号登录');
    
    // 生成JWT令牌
        const token = jwt.sign(
            { id: 1, username: 'admin', email: 'admin@example.com', isAdmin: true },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
    
        console.log('登录成功:', username);
    
        return res.status(200).json({
            success: true,
            message: '登录成功',
            token: token,
            user: {
                id: 1,
                username: 'admin',
                email: 'admin@example.com'
        }
    });
}
    // 查询用户
    db.get(
        `SELECT * FROM users WHERE username = ? OR email = ?`,
        [username, username],
        (err, user) => {
            if (err) {
                return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
            }
            
            if (!user) {
                return res.status(401).json({ success: false, message: '用户名或密码错误' });
            }
            
            // 验证密码
            bcrypt.compare(password, user.password, (err, result) => {
                if (err) {
                    return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                }
                
                if (!result) {
                    return res.status(401).json({ success: false, message: '用户名或密码错误' });
                }
                
                // 生成JWT令牌
                const token = jwt.sign(
                    { id: user.id, username: user.username, email: user.email, isAdmin: user.is_admin === 1 },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                
                res.status(200).json({
                    success: true,
                    message: '登录成功',
                    token: token,
                    user: {
                        id: user.id,
                        username: user.username,
                        email: user.email
                    }
                });
            });
        }
    );
});

// 验证令牌中间件
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: '未授权访问' });
    }
    
    // 检查是否是客户端生成的临时令牌
    if (token.includes('placeholder_signature')) {
        try {
            // 尝试从临时Token中解析出用户信息
            const payload = token.split('.')[1];
            const decodedPayload = Buffer.from(payload, 'base64').toString('utf8');
            const userInfo = JSON.parse(decodedPayload);
            
            // 设置用户信息
            req.user = {
                id: userInfo.id,
                username: userInfo.username,
                email: userInfo.email,
                isAdmin: userInfo.isAdmin
            };
            next();
        } catch (error) {
            console.error('解析临时Token失败:', error);
            return res.status(403).json({ success: false, message: '令牌无效' });
        }
    } else {
        // 正常验证JWT令牌
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                return res.status(403).json({ success: false, message: '令牌无效' });
            }
            
            req.user = user;
            next();
        });
    }
};

// 验证管理员身份中间件
const authenticateAdmin = (req, res, next) => {
    authenticateToken(req, res, () => {
        // 直接从数据库检查用户的管理员权限
        db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id], (err, user) => {
            if (err) {
                return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
            }
            
            if (!user || user.is_admin !== 1) {
                return res.status(403).json({ success: false, message: '您没有管理员权限' });
            }
            
            // 更新req.user的isAdmin属性
            req.user.isAdmin = true;
            next();
        });
    });
};

// 受保护的路由示例
app.get('/api/user/profile', authenticateToken, (req, res) => {
    // 从数据库获取完整的用户信息（包括bio等字段）
    db.get('SELECT id, username, email, is_admin, bio, created_at FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (err) {
            console.error('查询用户信息失败:', err);
            return res.status(500).json({ success: false, message: '获取用户信息失败' });
        }
        
        if (!user) {
            return res.status(404).json({ success: false, message: '用户不存在' });
        }
        
        const userId = user.id;
        
        // 查询创作视频数
        db.get('SELECT COUNT(*) as count FROM user_videos WHERE user_id = ?', [userId], (err, createdVideosResult) => {
            if (err) {
                console.error('查询创作视频数失败:', err);
                return res.status(500).json({ success: false, message: '获取统计数据失败' });
            }
            
            const createdVideosCount = createdVideosResult ? createdVideosResult.count : 0;
            
            // 查询收藏视频数
            db.get('SELECT COUNT(*) as count FROM video_collections WHERE user_id = ?', [userId], (err, collectedVideosResult) => {
                if (err) {
                    console.error('查询收藏视频数失败:', err);
                    return res.status(500).json({ success: false, message: '获取统计数据失败' });
                }
                
                const collectedVideosCount = collectedVideosResult ? collectedVideosResult.count : 0;
                
                // 查询总播放量（该用户创建的所有视频的播放量总和）
                db.get('SELECT COUNT(*) as count FROM video_views WHERE video_id IN (SELECT id FROM user_videos WHERE user_id = ?)', [userId], (err, totalViewsResult) => {
                    if (err) {
                        console.error('查询总播放量失败:', err);
                        return res.status(500).json({ success: false, message: '获取统计数据失败' });
                    }
                    
                    const totalViews = totalViewsResult ? totalViewsResult.count : 0;
                    
                    res.status(200).json({
                        success: true,
                        user: {
                            id: user.id,
                            username: user.username,
                            email: user.email,
                            is_admin: user.is_admin === 1,
                            bio: user.bio || '',
                            created_at: user.created_at,
                            stats: {
                                createdVideos: createdVideosCount,
                                collectedVideos: collectedVideosCount,
                                totalViews: totalViews
                            }
                        }
                    });
                });
            });
        });
    });
});

// 更新用户信息API
app.put('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const { email, bio, password, confirmPassword } = req.body;
        const userId = req.user.id;
        
        console.log('====== 更新用户信息 ======');
        console.log('用户ID:', userId);
        console.log('邮箱:', email);
        console.log('个人简介:', bio);
        console.log('是否修改密码:', !!password);
        
        // 如果提供了邮箱，先验证邮箱格式
        const emailToCheck = (email !== undefined && email !== null && email !== '' && email.trim() !== '') ? email.trim() : null;
        if (emailToCheck) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailToCheck)) {
                return res.status(400).json({ success: false, message: '邮箱格式不正确' });
            }
        }
        
        // 如果没有提供任何要更新的信息
        if (!password && !emailToCheck && (bio === undefined || bio === null || bio === '')) {
            return res.status(400).json({ success: false, message: '没有要更新的信息' });
        }
        
        // 如果提供了密码，验证密码并检查是否与旧密码相同
        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ success: false, message: '密码长度至少6位' });
            }
            
            if (password !== confirmPassword) {
                return res.status(400).json({ success: false, message: '两次输入的密码不一致' });
            }
            
            // 检查新密码是否与旧密码相同
            db.get('SELECT password FROM users WHERE id = ?', [userId], (err, currentUser) => {
                if (err) {
                    console.error('查询当前用户密码失败:', err);
                    return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                }
                
                if (!currentUser) {
                    return res.status(404).json({ success: false, message: '用户不存在' });
                }
                
                // 使用bcrypt比较新密码和旧密码
                bcrypt.compare(password, currentUser.password, (err, isSame) => {
                    if (err) {
                        console.error('比较密码失败:', err);
                        return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                    }
                    
                    if (isSame) {
                        return res.status(400).json({ success: false, message: '新密码不能与当前密码相同，请重新修改' });
                    }
                    
                    // 新密码与旧密码不同，继续执行更新操作
                    proceedWithUpdate();
                });
            });
            
            // 等待密码检查完成，在回调中继续
            return;
        }
        
        // 如果没有修改密码，直接执行更新操作
        proceedWithUpdate();
        
        // 继续更新操作的函数
        function proceedWithUpdate() {
            // 检查邮箱是否已被其他用户使用（如果提供了新邮箱）
            if (emailToCheck) {
                // 先获取当前用户的邮箱
                db.get('SELECT email FROM users WHERE id = ?', [userId], (err, currentUser) => {
                    if (err) {
                        console.error('查询当前用户邮箱失败:', err);
                        return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                    }
                    
                    // 如果新邮箱与当前邮箱相同，不需要检查，直接更新
                    if (currentUser && currentUser.email === emailToCheck) {
                        updateUserInfo();
                        return;
                    }
                    
                    // 检查邮箱是否已被其他用户使用
                    db.get('SELECT id FROM users WHERE email = ? AND id != ?', [emailToCheck, userId], (err, existingUser) => {
                        if (err) {
                            console.error('查询邮箱失败:', err);
                            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                        }
                        
                        if (existingUser) {
                            return res.status(400).json({ success: false, message: '该邮箱已被其他用户使用' });
                        }
                        
                        // 继续更新操作
                        updateUserInfo();
                    });
                });
            } else {
                // 如果没有提供邮箱或邮箱为空，直接更新
                updateUserInfo();
            }
        }
        
        function updateUserInfo() {
            // 构建更新字段
            const updates = [];
            const values = [];
            
            // 如果提供了邮箱且不为空，更新邮箱
            if (emailToCheck) {
                updates.push('email = ?');
                values.push(emailToCheck);
            }
            
            // 如果提供了个人简介，更新个人简介
            if (bio !== undefined && bio !== null && bio !== '') {
                updates.push('bio = ?');
                values.push(typeof bio === 'string' ? bio.trim() : bio);
            }
            
            // 如果提供了密码，加密后更新（优先处理密码更新）
            if (password) {
                bcrypt.hash(password, 10, (err, hashedPassword) => {
                    if (err) {
                        console.error('加密密码失败:', err);
                        return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                    }
                    
                    updates.push('password = ?');
                    values.push(hashedPassword);
                    values.push(userId);
                    
                    // 执行更新（至少会更新密码，所以updates不会为空）
                    const updateSql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
                    db.run(updateSql, values, function(err) {
                        if (err) {
                            console.error('更新用户信息失败:', err);
                            return res.status(500).json({ success: false, message: '更新用户信息失败: ' + err.message });
                        }
                        
                        console.log('用户信息和密码更新成功，影响行数:', this.changes);
                        res.status(200).json({
                            success: true,
                            message: '密码已更新，请使用新密码登录'
                        });
                    });
                });
                return; // 密码更新是异步的，直接返回
            }
            
            // 不更新密码，只更新其他信息
            if (updates.length === 0) {
                return res.status(400).json({ success: false, message: '没有要更新的信息' });
            }
            
            values.push(userId);
            const updateSql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
            db.run(updateSql, values, function(err) {
                if (err) {
                    console.error('更新用户信息失败:', err);
                    return res.status(500).json({ success: false, message: '更新用户信息失败: ' + err.message });
                }
                
                console.log('用户信息更新成功，影响行数:', this.changes);
                res.status(200).json({
                    success: true,
                    message: '用户信息已更新'
                });
            });
        }
        
    } catch (error) {
        console.error('更新用户信息API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message
        });
    }
});

// 管理员API - 获取所有用户列表
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    console.log('收到获取用户列表请求');
    console.log('当前用户:', req.user);
    db.all(`SELECT id, username, email, is_admin, created_at FROM users`, [], (err, users) => {
        if (err) {
            console.error('查询用户列表错误:', err);
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        console.log('查询到的用户列表:', users);
        
        res.status(200).json({
            success: true,
            users: users
        });
    });
});

// 管理员API - 获取视频列表
app.get('/api/admin/videos', authenticateAdmin, (req, res) => {
    console.log('收到获取视频列表请求');
    console.log('当前用户:', req.user);
    
    // 获取过滤参数
    const { status } = req.query;
    
    // 构建SQL查询
    let query = `
        SELECT uv.*, u.username as uploadUser
        FROM user_videos uv
        JOIN users u ON uv.user_id = u.id
    `;
    
    const params = [];
    
    // 如果有状态过滤，添加WHERE条件
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
        query += ` WHERE uv.status = ?`;
        params.push(status);
    }
    
    // 按创建时间倒序排序
    query += ` ORDER BY uv.created_at DESC`;
    
    db.all(query, params, (err, videos) => {
        if (err) {
            console.error('查询视频列表错误:', err);
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        console.log('查询到的视频列表:', videos);
        
        res.status(200).json({
            success: true,
            videos: videos
        });
    });
});

// 管理员API - 审核视频
app.post('/api/admin/videos/:id/review', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const { action, comments } = req.body;
    
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, message: '无效的审核操作' });
    }
    
    console.log('收到视频审核请求');
    console.log('当前用户:', req.user);
    console.log('视频ID:', id);
    console.log('审核操作:', action);
    
    // 更新数据库中的视频状态
    const status = action === 'approve' ? 'approved' : 'rejected';
    const reviewTime = new Date().toISOString();
    
    db.run(
        `UPDATE user_videos SET status = ?, review_time = ? WHERE id = ?`,
        [status, reviewTime, id],
        function(err) {
            if (err) {
                console.error('更新视频状态错误:', err);
                return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
            }
            
            // 检查是否有视频被更新
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: '未找到该视频' });
            }
            
            console.log('视频状态更新成功');
            
            res.status(200).json({
                success: true,
                message: `视频已${action === 'approve' ? '通过' : '拒绝'}审核`
            });
        }
    );
});

// 管理员API - 设置用户为管理员
app.post('/api/admin/users/:id/set-admin', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const { isAdmin } = req.body;
    
    db.run(`UPDATE users SET is_admin = ? WHERE id = ?`, [isAdmin ? 1 : 0, id], (err) => {
        if (err) {
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        res.status(200).json({
            success: true,
            message: isAdmin ? '已成功设置为管理员' : '已取消管理员权限'
        });
    });
});

// 管理员API - 获取举报列表
app.get('/api/admin/reports', authenticateAdmin, (req, res) => {
    console.log('收到获取举报列表请求');
    console.log('当前用户:', req.user);
    
    // 构建SQL查询，获取待处理的举报列表，包含视频信息和举报人信息
    const query = `
        SELECT 
            vr.*,
            uv.video_name,
            uv.video_url,
            uv.status as video_status,
            uv.is_banned,
            uv.user_id as video_owner_id,
            u1.username as reporter_name,
            u2.username as video_owner_name,
            u3.username as handled_by_name
        FROM video_reports vr
        JOIN user_videos uv ON vr.video_id = uv.id
        JOIN users u1 ON vr.reporter_id = u1.id
        JOIN users u2 ON uv.user_id = u2.id
        LEFT JOIN users u3 ON vr.handled_by = u3.id
        WHERE vr.status = 'pending'
        ORDER BY vr.created_at DESC
    `;
    
    db.all(query, [], (err, reports) => {
        if (err) {
            console.error('查询举报列表错误:', err);
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        console.log('查询到的举报列表:', reports);
        
        // 格式化举报原因
        const reasonMap = {
            '1': '内容违规',
            '2': '版权侵犯',
            '3': '低俗内容',
            '4': '虚假信息',
            '5': '其他原因'
        };
        
        const formattedReports = reports.map(report => ({
            ...report,
            reasonText: reasonMap[report.reason] || '未知原因'
        }));
        
        res.status(200).json({
            success: true,
            reports: formattedReports
        });
    });
});

// 管理员API - 获取所有评论（支持分页和搜索）
app.get('/api/admin/comments', authenticateAdmin, (req, res) => {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    let query = `
        SELECT vc.*, u.username, uv.video_name, uv.id as video_id
        FROM video_comments vc
        JOIN users u ON vc.user_id = u.id
        JOIN user_videos uv ON vc.video_id = uv.id
    `;
    
    const params = [];
    
    if (search && search.trim()) {
        query += ` WHERE (vc.content LIKE ? OR u.username LIKE ? OR uv.video_name LIKE ?)`;
        const searchPattern = `%${search.trim()}%`;
        params.push(searchPattern, searchPattern, searchPattern);
    }
    
    query += ` ORDER BY vc.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);
    
    db.all(query, params, (err, comments) => {
        if (err) {
            console.error('获取评论列表失败:', err);
            return res.status(500).json({ success: false, message: '获取评论列表失败' });
        }
        
        // 获取总数
        let countQuery = `SELECT COUNT(*) as total FROM video_comments vc 
                         JOIN users u ON vc.user_id = u.id 
                         JOIN user_videos uv ON vc.video_id = uv.id`;
        const countParams = [];
        
        if (search && search.trim()) {
            countQuery += ` WHERE (vc.content LIKE ? OR u.username LIKE ? OR uv.video_name LIKE ?)`;
            const searchPattern = `%${search.trim()}%`;
            countParams.push(searchPattern, searchPattern, searchPattern);
        }
        
        db.get(countQuery, countParams, (err, result) => {
            if (err) {
                console.error('获取评论总数失败:', err);
                return res.status(500).json({ success: false, message: '获取评论总数失败' });
            }
            
            res.status(200).json({
                success: true,
                comments: comments,
                total: result.total,
                page: parseInt(page),
                totalPages: Math.ceil(result.total / parseInt(limit))
            });
        });
    });
});

// 管理员API - 删除评论
app.delete('/api/admin/comments/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM video_comments WHERE id = ?', [id], function(err) {
        if (err) {
            console.error('删除评论失败:', err);
            return res.status(500).json({ success: false, message: '删除评论失败' });
        }
        
        if (this.changes === 0) {
            return res.status(404).json({ success: false, message: '评论不存在' });
        }
        
        res.status(200).json({ success: true, message: '评论已删除' });
    });
});

// 管理员API - 获取统计数据
app.get('/api/admin/statistics', authenticateAdmin, (req, res) => {
    const statistics = {};
    
    // 获取总用户数
    db.get('SELECT COUNT(*) as count FROM users', [], (err, result) => {
        if (err) {
            console.error('获取用户总数失败:', err);
            return res.status(500).json({ success: false, message: '获取统计数据失败' });
        }
        statistics.totalUsers = result.count;
        
        // 获取总视频数
        db.get('SELECT COUNT(*) as count FROM user_videos', [], (err, result) => {
            if (err) {
                console.error('获取视频总数失败:', err);
                return res.status(500).json({ success: false, message: '获取统计数据失败' });
            }
            statistics.totalVideos = result.count;
            
            // 获取已发布视频数
            db.get('SELECT COUNT(*) as count FROM user_videos WHERE status = ? AND is_banned = 0', ['approved'], (err, result) => {
                if (err) {
                    console.error('获取已发布视频数失败:', err);
                    return res.status(500).json({ success: false, message: '获取统计数据失败' });
                }
                statistics.approvedVideos = result.count;
                
                // 获取待审核视频数
                db.get('SELECT COUNT(*) as count FROM user_videos WHERE status = ?', ['pending'], (err, result) => {
                    if (err) {
                        console.error('获取待审核视频数失败:', err);
                        return res.status(500).json({ success: false, message: '获取统计数据失败' });
                    }
                    statistics.pendingVideos = result.count;
                    
                    // 获取待处理举报数
                    db.get('SELECT COUNT(*) as count FROM video_reports WHERE status = ?', ['pending'], (err, result) => {
                        if (err) {
                            console.error('获取待处理举报数失败:', err);
                            return res.status(500).json({ success: false, message: '获取统计数据失败' });
                        }
                        statistics.pendingReports = result.count;
                        
                        // 获取总点赞数
                        db.get('SELECT COUNT(*) as count FROM video_likes', [], (err, result) => {
                            if (err) {
                                console.error('获取总点赞数失败:', err);
                                return res.status(500).json({ success: false, message: '获取统计数据失败' });
                            }
                            statistics.totalLikes = result.count;
                            
                            // 获取总收藏数
                            db.get('SELECT COUNT(*) as count FROM video_collections', [], (err, result) => {
                                if (err) {
                                    console.error('获取总收藏数失败:', err);
                                    return res.status(500).json({ success: false, message: '获取统计数据失败' });
                                }
                                statistics.totalCollections = result.count;
                                
                                // 获取总评论数
                                db.get('SELECT COUNT(*) as count FROM video_comments', [], (err, result) => {
                                    if (err) {
                                        console.error('获取总评论数失败:', err);
                                        return res.status(500).json({ success: false, message: '获取统计数据失败' });
                                    }
                                    statistics.totalComments = result.count;
                                    
                                    // 获取热门视频（Top 10，按播放量+点赞+收藏排序）
                                    db.all(`
                                        SELECT uv.id, uv.video_name, uv.book_name, uv.author, uv.duration, uv.created_at,
                                            u.username as uploader_username,
                                            (SELECT COUNT(*) FROM video_views WHERE video_id = uv.id) as views,
                                            (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id) as likes_count,
                                            (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id) as collections_count
                                        FROM user_videos uv
                                        JOIN users u ON uv.user_id = u.id
                                        WHERE uv.status = 'approved' AND uv.is_banned = 0
                                        ORDER BY (COALESCE((SELECT COUNT(*) FROM video_views WHERE video_id = uv.id), 0) + 
                                                 COALESCE((SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id), 0) * 2 + 
                                                 COALESCE((SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id), 0) * 3) DESC
                                        LIMIT 10
                                    `, [], (err, topVideos) => {
                                        if (err) {
                                            console.error('获取热门视频失败:', err);
                                            statistics.topVideos = [];
                                        } else {
                                            statistics.topVideos = topVideos || [];
                                        }
                                        
                                        // 获取最近7天的视频上传趋势
                                        const sevenDaysAgo = new Date();
                                        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                                        const dateStr = sevenDaysAgo.toISOString().split('T')[0];
                                        
                                        db.all(`
                                            SELECT strftime('%Y-%m-%d', created_at) as date, COUNT(*) as count
                                            FROM user_videos
                                            WHERE created_at >= ?
                                            GROUP BY strftime('%Y-%m-%d', created_at)
                                            ORDER BY date ASC
                                        `, [dateStr], (err, uploadTrend) => {
                                            if (err) {
                                                console.error('获取上传趋势失败:', err);
                                                statistics.uploadTrend = [];
                                            } else {
                                                statistics.uploadTrend = uploadTrend || [];
                                            }
                                            
                                            // 获取最近注册的用户（活跃用户）
                                            db.all(`
                                                SELECT id, username, email, created_at
                                                FROM users
                                                ORDER BY created_at DESC
                                                LIMIT 10
                                            `, [], (err, recentUsers) => {
                                                if (err) {
                                                    console.error('获取最近用户失败:', err);
                                                    statistics.recentUsers = [];
                                                } else {
                                                    statistics.recentUsers = recentUsers || [];
                                                }
                                                
                                                // 获取视频作者分布（按作者分类）
                                                db.all(`
                                                    SELECT author, COUNT(*) as count
                                                    FROM user_videos
                                                    WHERE status = 'approved' AND is_banned = 0
                                                    GROUP BY author
                                                    ORDER BY count DESC
                                                    LIMIT 10
                                                `, [], (err, authorDistribution) => {
                                                    if (err) {
                                                        console.error('获取作者分布失败:', err);
                                                        statistics.authorDistribution = [];
                                                    } else {
                                                        statistics.authorDistribution = authorDistribution || [];
                                                    }
                                                    
                                                    res.status(200).json({
                                                        success: true,
                                                        statistics: statistics
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/admin/reports/:id/handle', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const { action } = req.body; // action: 'ban' (下架) 或 'ignore' (忽略)
    const adminId = req.user.id;
    
    console.log('收到处理举报请求');
    console.log('举报ID:', id);
    console.log('处理操作:', action);
    console.log('处理人ID:', adminId);
    
    if (!['ban', 'ignore'].includes(action)) {
        return res.status(400).json({ success: false, message: '无效的处理操作，必须是 ban 或 ignore' });
    }
    
    // 首先获取举报信息
    db.get('SELECT * FROM video_reports WHERE id = ?', [id], (err, report) => {
        if (err) {
            console.error('查询举报信息错误:', err);
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        if (!report) {
            return res.status(404).json({ success: false, message: '未找到该举报记录' });
        }
        
        if (report.status !== 'pending') {
            return res.status(400).json({ success: false, message: '该举报已经处理过了' });
        }
        
        const handledAt = new Date().toISOString();
        const reportStatus = action === 'ban' ? 'approved' : 'rejected'; // approved表示下架，rejected表示忽略
        
        // 更新举报记录状态
        db.run(
            'UPDATE video_reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ?',
            [reportStatus, adminId, handledAt, id],
            function(err) {
                if (err) {
                    console.error('更新举报记录错误:', err);
                    return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
                }
                
                // 如果是下架操作，更新视频的is_banned状态
                if (action === 'ban') {
                    db.run(
                        'UPDATE user_videos SET is_banned = 1 WHERE id = ?',
                        [report.video_id],
                        (err) => {
                            if (err) {
                                console.error('更新视频下架状态错误:', err);
                                return res.status(500).json({ success: false, message: '更新视频状态失败' });
                            }
                            
                            console.log('视频已下架，视频ID:', report.video_id);
                            res.status(200).json({
                                success: true,
                                message: '视频已下架，将从图书广场移除'
                            });
                        }
                    );
                } else {
                    // 忽略操作，只更新举报记录状态
                    console.log('举报已忽略，举报ID:', id);
                    res.status(200).json({
                        success: true,
                        message: '举报已忽略，视频继续正常显示'
                    });
                }
            }
        );
    });
});

// 视频处理API（使用FFmpeg替代剪映API）

// 存储处理中的视频任务（实际项目中应使用数据库）
const videoTasks = {};

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

function runSpawnCmd(bin, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(bin, args, { windowsHide: true });
        let stderr = '';
        let stdout = '';
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        p.stdout.on('data', (d) => { stdout += d.toString(); });
        p.on('error', (err) => reject(err));
        p.on('close', (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error((stderr || stdout || '').trim().slice(-900) || `${bin} 退出码 ${code}`));
        });
    });
}

function resolveUploadedVideoPath(videoUrl) {
    if (!videoUrl || typeof videoUrl !== 'string') return null;
    let pathname = videoUrl.trim();
    try {
        if (/^https?:\/\//i.test(pathname)) {
            pathname = new URL(pathname).pathname;
        }
    } catch (e) {
        return null;
    }
    if (!pathname.startsWith('/uploads/videos/')) return null;
    const abs = path.normalize(path.join(__dirname, pathname.replace(/^\//, '')));
    const root = path.normalize(path.join(__dirname, 'uploads', 'videos'));
    if (!abs.startsWith(root)) return null;
    if (!fs.existsSync(abs)) return null;
    return abs;
}

function resolveUploadedAudioPath(audioUrl) {
    if (!audioUrl || typeof audioUrl !== 'string') return null;
    let pathname = audioUrl.trim();
    try {
        if (/^https?:\/\//i.test(pathname)) {
            pathname = new URL(pathname).pathname;
        }
    } catch (e) {
        return null;
    }
    if (!pathname.startsWith('/uploads/audio/') && !pathname.startsWith('/uploads/videos/')) return null;
    const abs = path.normalize(path.join(__dirname, pathname.replace(/^\//, '')));
    const root = path.normalize(path.join(__dirname, 'uploads'));
    if (!abs.startsWith(root)) return null;
    if (!fs.existsSync(abs)) return null;
    return abs;
}

function collectResolvedAudioTracksForExport(render, vidDur) {
    const out = [];
    for (const t of Array.isArray(render.audioTracks) ? render.audioTracks : []) {
        if (!t || !t.audioUrl) continue;
        const abs = resolveUploadedAudioPath(t.audioUrl);
        if (!abs) continue;
        const start = Math.max(0, Number(t.startTime) || 0);
        const audDur = Number(t.duration) || 0;
        const playLen = Math.min(audDur, Math.max(0, vidDur - start));
        if (playLen <= 0.01) continue;
        out.push({
            abs,
            start,
            playLen,
            fadeIn: Number(t.fadeIn) || 0,
            fadeOut: Number(t.fadeOut) || 0,
            volume: t.volume != null ? Number(t.volume) : 1
        });
    }
    return out;
}

function buildAudioMixFilterComplex(hasAud, vidDur, speed, resolved) {
    const parts = [];
    const at = buildAtempoChain(speed);
    const mainLabel = 'mainaud';
    const vd = Math.max(0.1, vidDur);

    if (hasAud) {
        const atPart = at ? `${at},` : '';
        parts.push(`[0:a]${atPart}[${mainLabel}]`);
    } else {
        parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${vd.toFixed(4)},asetpts=N/SR/TB[${mainLabel}]`);
    }

    resolved.forEach((tr, i) => {
        const inputIdx = i + 1;
        const label = `ex${i}`;
        const fi = Math.min(Math.max(0, tr.fadeIn), tr.playLen * 0.49);
        const fo = Math.min(Math.max(0, tr.fadeOut), tr.playLen * 0.49);
        const foSt = Math.max(0, tr.playLen - fo);
        const startMs = Math.round(tr.start * 1000);
        const vol = Math.max(0, Math.min(2, tr.volume));
        let chain = `atrim=0:${tr.playLen.toFixed(4)}`;
        if (fi > 0.001) chain += `,afade=t=in:st=0:d=${fi.toFixed(3)}`;
        if (fo > 0.001) chain += `,afade=t=out:st=${foSt.toFixed(3)}:d=${fo.toFixed(3)}`;
        chain += `,volume=${vol.toFixed(4)},adelay=${startMs}|${startMs}[${label}]`;
        parts.push(`[${inputIdx}:a]${chain}`);
    });

    let mix = `[${mainLabel}]`;
    resolved.forEach((_, i) => {
        mix += `[ex${i}]`;
    });
    mix += `amix=inputs=${1 + resolved.length}:duration=first:normalize=0[aout]`;
    parts.push(mix);
    parts.push(`[aout]atrim=0:${vd.toFixed(4)}[aout2]`);
    return parts.join(';');
}

function mergeTimeIntervals(intervals) {
    const sorted = intervals
        .map((iv) => ({
            start: Math.max(0, Number(iv.start)),
            end: Math.max(0, Number(iv.end))
        }))
        .filter((iv) => iv.end > iv.start + 1e-4)
        .sort((a, b) => a.start - b.start);
    const out = [];
    for (const iv of sorted) {
        if (!out.length || iv.start > out[out.length - 1].end + 1e-4) {
            out.push({ start: iv.start, end: iv.end });
        } else {
            out[out.length - 1].end = Math.max(out[out.length - 1].end, iv.end);
        }
    }
    return out;
}

function keepSegmentsFromRemoves(duration, removes) {
    const keep = [];
    let t = 0;
    for (const r of removes) {
        const s = Math.min(r.start, duration);
        const e = Math.min(r.end, duration);
        if (s > t + 1e-3) keep.push({ start: t, end: s });
        t = Math.max(t, e);
    }
    if (duration > t + 1e-3) keep.push({ start: t, end: duration });
    return keep.filter((k) => k.end - k.start > 1e-3);
}

async function ffprobeDuration(filePath) {
    const { stdout } = await runSpawnCmd(FFPROBE_BIN, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath
    ]);
    const d = parseFloat(String(stdout).trim());
    if (!isFinite(d) || d <= 0) throw new Error('无法读取视频时长，请先确认 ffprobe 可用');
    return d;
}

async function extractVideoSegment(inputPath, segStart, segEnd, outputPath) {
    const len = segEnd - segStart;
    await runSpawnCmd(FFMPEG_BIN, [
        '-y',
        '-i', inputPath,
        '-ss', String(segStart),
        '-t', String(len),
        '-map', '0:v:0',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath
    ]);
}

async function concatMp4Files(segmentPaths, outputPath) {
    const listPath = path.join(path.dirname(segmentPaths[0]), `concat-${Date.now()}.txt`);
    const posix = (p) => path.resolve(p).split(path.sep).join('/');
    const body = segmentPaths.map((p) => `file '${posix(p).replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, body, 'utf8');
    try {
        await runSpawnCmd(FFMPEG_BIN, [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', listPath,
            '-c', 'copy',
            outputPath
        ]);
    } finally {
        try { fs.unlinkSync(listPath); } catch (e) { /* ignore */ }
    }
}

async function ffmpegRemoveSegmentsFromFile(inputAbs, removeList, outputAbs) {
    const duration = await ffprobeDuration(inputAbs);
    const merged = mergeTimeIntervals(removeList);
    const keep = keepSegmentsFromRemoves(duration, merged);
    if (!keep.length) throw new Error('删除后没有可保留的视频片段');

    const trivial =
        keep.length === 1 &&
        keep[0].start <= 0.05 &&
        keep[0].end >= duration - 0.05;
    if (trivial) {
        await fs.promises.copyFile(inputAbs, outputAbs);
        return;
    }

    const tmpDir = path.join(os.tmpdir(), `ve-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const parts = [];
    try {
        for (let i = 0; i < keep.length; i++) {
            const partPath = path.join(tmpDir, `part${i}.mp4`);
            await extractVideoSegment(inputAbs, keep[i].start, keep[i].end, partPath);
            parts.push(partPath);
        }
        if (parts.length === 1) {
            await fs.promises.copyFile(parts[0], outputAbs);
        } else {
            await concatMp4Files(parts, outputAbs);
        }
    } finally {
        for (const p of parts) {
            try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
        }
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
    }
}

async function extractSegmentWithOptionalSpeed(inputAbs, outAbs, start, duration, speed, hasAud) {
    const args = ['-y', '-ss', String(start), '-t', String(duration), '-i', inputAbs];
    const s = Math.max(0.25, Math.min(4, Number(speed) || 1));
    if (Math.abs(s - 1) > 0.02) {
        args.push('-vf', `setpts=${(1 / s).toFixed(6)}*PTS`);
        if (hasAud) {
            const at = buildAtempoChain(s);
            if (at) args.push('-af', at);
        }
    }
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart');
    if (hasAud) {
        args.push('-c:a', 'aac', '-b:a', '192k');
    } else {
        args.push('-an');
    }
    args.push(outAbs);
    await runSpawnCmd(FFMPEG_BIN, args);
}

async function ffmpegSpeedSegmentFromFile(inputAbs, start, end, speed, outputAbs) {
    const vd = await ffprobeDuration(inputAbs);
    const hasAud = await hasAudioStream(inputAbs);
    const s = Math.max(0.25, Math.min(4, Number(speed) || 1));
    const segStart = Math.max(0, Math.min(vd - 1e-3, Number(start) || 0));
    const segEnd = Math.max(segStart + 0.05, Math.min(vd, Number(end) || vd));
    const segLen = segEnd - segStart;
    if (segLen < 0.05) throw new Error('变速片段过短');

    const tmpDir = path.join(os.tmpdir(), `ves-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const parts = [];
    try {
        if (segStart > 0.02) {
            const p0 = path.join(tmpDir, 'head.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p0, 0, segStart, 1, hasAud);
            parts.push(p0);
        }

        const p1 = path.join(tmpDir, 'mid.mp4');
        await extractSegmentWithOptionalSpeed(inputAbs, p1, segStart, segLen, s, hasAud);
        parts.push(p1);

        if (segEnd < vd - 0.02) {
            const p2 = path.join(tmpDir, 'tail.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p2, segEnd, vd - segEnd, 1, hasAud);
            parts.push(p2);
        }

        if (parts.length === 1) {
            await fs.promises.copyFile(parts[0], outputAbs);
        } else {
            await concatMp4Files(parts, outputAbs);
        }
    } finally {
        for (const p of parts) {
            try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
        }
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
    }
}

async function ffmpegReverseSegmentFromFile(inputAbs, start, end, outputAbs) {
    const vd = await ffprobeDuration(inputAbs);
    const hasAud = await hasAudioStream(inputAbs);
    const segStart = Math.max(0, Math.min(vd - 1e-3, Number(start) || 0));
    const segEnd = Math.max(segStart + 0.05, Math.min(vd, Number(end) || vd));
    const segLen = segEnd - segStart;
    if (segLen < 0.05) throw new Error('倒放片段过短');

    const tmpDir = path.join(os.tmpdir(), `ver-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const parts = [];
    try {
        if (segStart > 0.02) {
            const p0 = path.join(tmpDir, 'head.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p0, 0, segStart, 1, hasAud);
            parts.push(p0);
        }

        const p1 = path.join(tmpDir, 'mid-reverse.mp4');
        const reverseArgs = ['-y', '-ss', String(segStart), '-t', String(segLen), '-i', inputAbs, '-vf', 'reverse'];
        if (hasAud) reverseArgs.push('-af', 'areverse');
        reverseArgs.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart');
        if (hasAud) reverseArgs.push('-c:a', 'aac', '-b:a', '192k');
        else reverseArgs.push('-an');
        reverseArgs.push(p1);
        await runSpawnCmd(FFMPEG_BIN, reverseArgs);
        parts.push(p1);

        if (segEnd < vd - 0.02) {
            const p2 = path.join(tmpDir, 'tail.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p2, segEnd, vd - segEnd, 1, hasAud);
            parts.push(p2);
        }

        if (parts.length === 1) {
            await fs.promises.copyFile(parts[0], outputAbs);
        } else {
            await concatMp4Files(parts, outputAbs);
        }
    } finally {
        for (const p of parts) {
            try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
        }
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
    }
}

async function ffmpegMuteSegmentFromFile(inputAbs, start, end, outputAbs) {
    const vd = await ffprobeDuration(inputAbs);
    const hasAud = await hasAudioStream(inputAbs);
    const segStart = Math.max(0, Math.min(vd - 1e-3, Number(start) || 0));
    const segEnd = Math.max(segStart + 0.05, Math.min(vd, Number(end) || vd));
    const segLen = segEnd - segStart;
    if (segLen < 0.05) throw new Error('静音片段过短');

    const tmpDir = path.join(os.tmpdir(), `vem-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const parts = [];
    try {
        if (segStart > 0.02) {
            const p0 = path.join(tmpDir, 'head.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p0, 0, segStart, 1, hasAud);
            parts.push(p0);
        }

        const p1 = path.join(tmpDir, 'mid-mute.mp4');
        if (hasAud) {
            await runSpawnCmd(FFMPEG_BIN, [
                '-y',
                '-ss', String(segStart),
                '-t', String(segLen),
                '-i', inputAbs,
                '-af', 'volume=0',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-movflags', '+faststart',
                p1
            ]);
        } else {
            await extractSegmentWithOptionalSpeed(inputAbs, p1, segStart, segLen, 1, false);
        }
        parts.push(p1);

        if (segEnd < vd - 0.02) {
            const p2 = path.join(tmpDir, 'tail.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p2, segEnd, vd - segEnd, 1, hasAud);
            parts.push(p2);
        }

        if (parts.length === 1) {
            await fs.promises.copyFile(parts[0], outputAbs);
        } else {
            await concatMp4Files(parts, outputAbs);
        }
    } finally {
        for (const p of parts) {
            try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
        }
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
    }
}

async function ffmpegAudioFadeSegmentFromFile(inputAbs, start, end, fadeSec, outputAbs) {
    const vd = await ffprobeDuration(inputAbs);
    const hasAud = await hasAudioStream(inputAbs);
    if (!hasAud) throw new Error('当前视频没有可处理的音轨');
    const segStart = Math.max(0, Math.min(vd - 1e-3, Number(start) || 0));
    const segEnd = Math.max(segStart + 0.05, Math.min(vd, Number(end) || vd));
    const segLen = segEnd - segStart;
    if (segLen < 0.05) throw new Error('淡入淡出片段过短');
    const fd = Math.max(0.05, Math.min(Number(fadeSec) || 0.5, segLen / 2));

    const tmpDir = path.join(os.tmpdir(), `vef-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const parts = [];
    try {
        if (segStart > 0.02) {
            const p0 = path.join(tmpDir, 'head.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p0, 0, segStart, 1, true);
            parts.push(p0);
        }

        const p1 = path.join(tmpDir, 'mid-fade.mp4');
        const outStart = Math.max(0, segLen - fd);
        await runSpawnCmd(FFMPEG_BIN, [
            '-y',
            '-ss', String(segStart),
            '-t', String(segLen),
            '-i', inputAbs,
            '-af', `afade=t=in:st=0:d=${fd.toFixed(3)},afade=t=out:st=${outStart.toFixed(3)}:d=${fd.toFixed(3)}`,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', '+faststart',
            p1
        ]);
        parts.push(p1);

        if (segEnd < vd - 0.02) {
            const p2 = path.join(tmpDir, 'tail.mp4');
            await extractSegmentWithOptionalSpeed(inputAbs, p2, segEnd, vd - segEnd, 1, true);
            parts.push(p2);
        }

        if (parts.length === 1) {
            await fs.promises.copyFile(parts[0], outputAbs);
        } else {
            await concatMp4Files(parts, outputAbs);
        }
    } finally {
        for (const p of parts) {
            try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
        }
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
    }
}

async function hasAudioStream(filePath) {
    try {
        const { stdout } = await runSpawnCmd(FFPROBE_BIN, [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_type',
            '-of', 'csv=p=0',
            filePath
        ]);
        const o = (stdout || '').trim();
        return o.length > 0 && /audio/i.test(o);
    } catch (e) {
        return false;
    }
}

function buildAtempoChain(speed) {
    let s = Math.max(0.25, Math.min(4, speed));
    const parts = [];
    if (Math.abs(s - 1) < 0.02) return '';
    while (s > 2 + 1e-4) {
        parts.push('atempo=2');
        s /= 2;
    }
    while (s < 0.5 - 1e-4) {
        parts.push('atempo=0.5');
        s /= 0.5;
    }
    if (Math.abs(s - 1) > 1e-3) {
        parts.push(`atempo=${s.toFixed(5)}`);
    }
    return parts.join(',');
}

function exportRenderNeedsPass(render) {
    if (!render || typeof render !== 'object') return false;
    const speed = Number(render.speed);
    if (isFinite(speed) && Math.abs(speed - 1) > 0.02) return true;
    const rot = ((Number(render.rotation) || 0) % 360 + 360) % 360;
    if (rot !== 0) return true;
    if (render.flipHorizontal) return true;
    if (render.flipVertical) return true;
    if (Math.abs((Number(render.scale) || 1) - 1) > 1e-3) return true;
    if (Array.isArray(render.filters) && render.filters.length > 0) return true;
    if (Array.isArray(render.transforms) && render.transforms.length > 0) return true;
    if (Array.isArray(render.subtitles) && render.subtitles.length > 0) return true;
    if (Array.isArray(render.transitions) && render.transitions.length > 0) return true;
    if (Array.isArray(render.audioTracks) && render.audioTracks.length > 0) return true;
    return false;
}

function secondsToAssTime(t) {
    const sec = Math.max(0, Number(t) || 0);
    const cs = Math.min(99, Math.round((sec % 1) * 100));
    const tt = Math.floor(sec);
    const h = Math.floor(tt / 3600);
    const m = Math.floor((tt % 3600) / 60);
    const s = tt % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function hexToAssColor(hex) {
    const h = String(hex || '#ffffff').replace('#', '');
    if (h.length < 6) return '&H00FFFFFF';
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    return `&H00${b}${g}${r}`.toUpperCase();
}

function escapeAssText(t) {
    return String(t).replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

function buildAssSubtitlesContent(subs, playResX, playResY) {
    const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,12,12,38,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const lines = [];
    for (const sub of subs) {
        if (!sub || !sub.text) continue;
        const fs = Math.max(12, Math.min(96, parseInt(sub.fontSize, 10) || 48));
        const c = hexToAssColor(sub.color);
        const st = secondsToAssTime(sub.start);
        const en = secondsToAssTime(sub.end);
        const tx = escapeAssText(sub.text);
        const hasPos =
            typeof sub.posX === 'number' &&
            typeof sub.posY === 'number' &&
            !Number.isNaN(sub.posX) &&
            !Number.isNaN(sub.posY);
        let override;
        if (hasPos) {
            const px = Math.max(0, Math.min(playResX, (Number(sub.posX) / 100) * playResX));
            const py = Math.max(0, Math.min(playResY, (Number(sub.posY) / 100) * playResY));
            override = `{\\an5\\pos(${px.toFixed(0)},${py.toFixed(0)})\\fs${fs}\\1c${c}}`;
        } else {
            const an = sub.position === 'top' ? 8 : sub.position === 'center' ? 5 : 2;
            override = `{\\an${an}\\fs${fs}\\1c${c}}`;
        }
        lines.push(`Dialogue: 0,${st},${en},Default,,0,0,0,,${override}${tx}`);
    }
    return head + lines.join('\n') + '\n';
}

function ffmpegSubtitleFilterPath(assAbsPath) {
    let u = path.resolve(assAbsPath).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(u)) {
        u = u[0] + '\\:' + u.slice(2);
    }
    return u;
}

async function ffmpegApplyRenderPass(inputPath, outputPath, render) {
    let assPath = null;
    try {
        const vfParts = [];
        const withTimeEnable = (expr, start, end) => {
            const s = Number(start);
            const e = Number(end);
            if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s + 1e-4) return expr;
            return `${expr}:enable='between(t,${s.toFixed(4)},${e.toFixed(4)})'`;
        };
        // 与前端 video-editor getCSSFilters 中百分比含义对齐：brightness/contrast/saturate 百分数 → ffmpeg eq
        const cssBrightToEq = (pct) => Math.max(-1, Math.min(1, (Number(pct) - 100) / 100));
        const cssContrastToEq = (pct) => Math.max(0.0625, Math.min(2, Number(pct) / 100));
        const cssSaturateToEq = (pct) => Math.max(0, Math.min(3, Number(pct) / 100));
        const sepiaMatrix =
            'colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131';

        const rot = ((Number(render.rotation) || 0) % 360 + 360) % 360;
        if (rot === 90) vfParts.push('transpose=1');
        else if (rot === 180) vfParts.push('transpose=1,transpose=1');
        else if (rot === 270) vfParts.push('transpose=2');

        if (render.flipHorizontal) vfParts.push('hflip');
        if (render.flipVertical) vfParts.push('vflip');
        const globalScale = Math.max(0.5, Math.min(2, Number(render.scale) || 1));
        if (Math.abs(globalScale - 1) > 1e-3) {
            if (globalScale > 1) {
                vfParts.push(`scale=iw*${globalScale.toFixed(4)}:ih*${globalScale.toFixed(4)},crop=iw/${globalScale.toFixed(4)}:ih/${globalScale.toFixed(4)}`);
            } else {
                vfParts.push(`scale=iw*${globalScale.toFixed(4)}:ih*${globalScale.toFixed(4)},pad=iw/${globalScale.toFixed(4)}:ih/${globalScale.toFixed(4)}:(ow-iw)/2:(oh-ih)/2`);
            }
        }
        
        for (const tr of Array.isArray(render.transforms) ? render.transforms : []) {
            if (!tr) continue;
            const tStart = Number(tr.start);
            const tEnd = Number(tr.end);
            const r = ((Number(tr.rotation) || 0) % 360 + 360) % 360;
            if (r === 90) vfParts.push(withTimeEnable('transpose=1', tStart, tEnd));
            else if (r === 180) vfParts.push(withTimeEnable('transpose=1,transpose=1', tStart, tEnd));
            else if (r === 270) vfParts.push(withTimeEnable('transpose=2', tStart, tEnd));
            if (tr.flipHorizontal) vfParts.push(withTimeEnable('hflip', tStart, tEnd));
            if (tr.flipVertical) vfParts.push(withTimeEnable('vflip', tStart, tEnd));
            const ts = Math.max(0.5, Math.min(2, Number(tr.scale) || 1));
            if (Math.abs(ts - 1) > 1e-3) {
                if (ts > 1) {
                    vfParts.push(withTimeEnable(`scale=iw*${ts.toFixed(4)}:ih*${ts.toFixed(4)},crop=iw/${ts.toFixed(4)}:ih/${ts.toFixed(4)}`, tStart, tEnd));
                } else {
                    vfParts.push(withTimeEnable(`scale=iw*${ts.toFixed(4)}:ih*${ts.toFixed(4)},pad=iw/${ts.toFixed(4)}:ih/${ts.toFixed(4)}:(ow-iw)/2:(oh-ih)/2`, tStart, tEnd));
                }
            }
        }

        for (const f of render.filters || []) {
            if (!f || !f.type) continue;
            const v = Number(f.value);
            const fStart = Number(f.start);
            const fEnd = Number(f.end);
            switch (f.type) {
                case 'brightness': {
                    const b = Math.max(-1, Math.min(1, (v - 100) / 100));
                    vfParts.push(withTimeEnable(`eq=brightness=${b.toFixed(4)}`, fStart, fEnd));
                    break;
                }
                case 'contrast': {
                    const c = Math.max(0.0625, Math.min(2, v / 100));
                    vfParts.push(withTimeEnable(`eq=contrast=${c.toFixed(4)}`, fStart, fEnd));
                    break;
                }
                case 'saturation': {
                    const s = Math.max(0, Math.min(3, v / 100));
                    vfParts.push(withTimeEnable(`eq=saturation=${s.toFixed(4)}`, fStart, fEnd));
                    break;
                }
                case 'hue': {
                    const deg = Math.max(0, Math.min(360, v));
                    if (deg >= 0.01) vfParts.push(withTimeEnable(`hue=h=${deg.toFixed(4)}`, fStart, fEnd));
                    break;
                }
                case 'temperature': {
                    const t = v;
                    const sep = Math.min(28, Math.abs(t) * 0.28);
                    vfParts.push(withTimeEnable(`hue=h=${(t * 0.38).toFixed(4)}`, fStart, fEnd));
                    vfParts.push(
                        withTimeEnable(
                            `eq=saturation=${(1 + sep / 250).toFixed(4)}:brightness=${((sep * (t >= 0 ? 1 : -1)) / 3500).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    if (sep >= 10) vfParts.push(withTimeEnable(sepiaMatrix, fStart, fEnd));
                    break;
                }
                case 'fade': {
                    const fd = v;
                    const sat = Math.max(0, (100 - fd * 0.42) / 100);
                    const bright = (fd * 0.14) / 100;
                    vfParts.push(withTimeEnable(`eq=saturation=${sat.toFixed(4)}:brightness=${bright.toFixed(4)}`, fStart, fEnd));
                    break;
                }
                case 'blur': {
                    const sigma = Math.max(0.1, Math.min(30, v / 10));
                    vfParts.push(withTimeEnable(`gblur=sigma=${sigma.toFixed(2)}`, fStart, fEnd));
                    break;
                }
                case 'grayscale': {
                    if (v >= 50) vfParts.push(withTimeEnable('hue=s=0', fStart, fEnd));
                    break;
                }
                case 'sepia': {
                    if (v >= 50) {
                        vfParts.push(withTimeEnable(sepiaMatrix, fStart, fEnd));
                    }
                    break;
                }
                case 'invert': {
                    if (v >= 50) vfParts.push(withTimeEnable('negate', fStart, fEnd));
                    break;
                }
                case 'vintage': {
                    vfParts.push(withTimeEnable(sepiaMatrix, fStart, fEnd));
                    vfParts.push(
                        withTimeEnable(
                            `eq=contrast=${cssContrastToEq(106).toFixed(4)}:saturation=${cssSaturateToEq(112).toFixed(4)}:brightness=${cssBrightToEq(97).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    break;
                }
                case 'cool': {
                    vfParts.push(withTimeEnable('hue=h=-12', fStart, fEnd));
                    vfParts.push(
                        withTimeEnable(
                            `eq=saturation=${cssSaturateToEq(116).toFixed(4)}:brightness=${cssBrightToEq(103).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    break;
                }
                case 'warm': {
                    vfParts.push(withTimeEnable(sepiaMatrix, fStart, fEnd));
                    vfParts.push(
                        withTimeEnable(
                            `eq=saturation=${cssSaturateToEq(110).toFixed(4)}:brightness=${cssBrightToEq(106).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    break;
                }
                case 'film': {
                    vfParts.push(withTimeEnable(sepiaMatrix, fStart, fEnd));
                    vfParts.push(
                        withTimeEnable(
                            `eq=contrast=${cssContrastToEq(108).toFixed(4)}:saturation=${cssSaturateToEq(96).toFixed(4)}:brightness=${cssBrightToEq(102).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    break;
                }
                case 'vivid': {
                    vfParts.push(
                        withTimeEnable(
                            `eq=saturation=${cssSaturateToEq(138).toFixed(4)}:contrast=${cssContrastToEq(114).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    break;
                }
                case 'cinematic': {
                    vfParts.push(withTimeEnable('hue=h=-8', fStart, fEnd));
                    vfParts.push(
                        withTimeEnable(
                            `eq=contrast=${cssContrastToEq(94).toFixed(4)}:saturation=${cssSaturateToEq(114).toFixed(4)}:brightness=${cssBrightToEq(98).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    break;
                }
                case 'noir': {
                    vfParts.push(
                        withTimeEnable(
                            `eq=saturation=0.22:contrast=${cssContrastToEq(122).toFixed(4)}:brightness=${cssBrightToEq(88).toFixed(4)}`,
                            fStart,
                            fEnd
                        )
                    );
                    break;
                }
                default:
                    break;
            }
        }
        
        // 与前端转场能力保持一致：仅支持 fade / blur，且按时间段启用
        for (const tr of Array.isArray(render.transitions) ? render.transitions : []) {
            if (!tr) continue;
            const tt = String(tr.transitionType || '').toLowerCase();
            if (tt !== 'fade' && tt !== 'blur') continue;
            const start = Math.max(0, Number(tr.start) || 0);
            const end = Math.max(start + 0.05, Number(tr.end) || (start + (Number(tr.duration) || 1)));
            const duration = Math.max(0.05, Number(tr.duration) || (end - start));
            const stop = Math.min(end, start + duration);
            if (stop <= start + 1e-4) continue;
            if (tt === 'fade') {
                vfParts.push(`fade=t=in:st=${start.toFixed(4)}:d=${(stop - start).toFixed(4)}`);
            } else if (tt === 'blur') {
                vfParts.push(`gblur=sigma=14:enable='between(t,${start.toFixed(4)},${stop.toFixed(4)})'`);
            }
        }

        const subs = Array.isArray(render.subtitles) ? render.subtitles : [];
        if (subs.length > 0) {
            assPath = path.join(os.tmpdir(), `vexp-${Date.now()}-${Math.random().toString(16).slice(2)}.ass`);
            const body = buildAssSubtitlesContent(
                subs,
                Math.max(320, Number(render.videoWidth) || 1280),
                Math.max(240, Number(render.videoHeight) || 720)
            );
            fs.writeFileSync(assPath, body, 'utf8');
            const esc = ffmpegSubtitleFilterPath(assPath);
            vfParts.push(`subtitles='${esc}'`);
        }

        const speed = Math.max(0.25, Math.min(4, Number(render.speed) || 1));
        if (Math.abs(speed - 1) > 0.02) {
            vfParts.push(`setpts=${(1 / speed).toFixed(6)}*PTS`);
        }

        const vidDur = await ffprobeDuration(inputPath);
        const hasAud = await hasAudioStream(inputPath);
        const resolvedAudio = collectResolvedAudioTracksForExport(render, vidDur);

        if (resolvedAudio.length > 0) {
            const args = ['-y', '-i', inputPath];
            resolvedAudio.forEach((r) => args.push('-i', r.abs));
            if (vfParts.length) {
                args.push('-vf', vfParts.join(','));
            }
            const fc = buildAudioMixFilterComplex(hasAud, vidDur, speed, resolvedAudio);
            args.push('-filter_complex', fc);
            args.push('-map', '0:v');
            args.push('-map', '[aout2]');
            args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart');
            args.push('-c:a', 'aac', '-b:a', '192k');
            args.push(outputPath);
            await runSpawnCmd(FFMPEG_BIN, args);
        } else {
            let afChain = '';
            if (hasAud && Math.abs(speed - 1) > 0.02) {
                afChain = buildAtempoChain(speed);
            }
            const args = ['-y', '-i', inputPath];
            if (vfParts.length) {
                args.push('-vf', vfParts.join(','));
            }
            if (afChain) {
                args.push('-af', afChain);
            }
            args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart');
            if (hasAud) {
                args.push('-c:a', 'aac', '-b:a', '192k');
            } else {
                args.push('-an');
            }
            args.push(outputPath);
            await runSpawnCmd(FFMPEG_BIN, args);
        }
    } finally {
        if (assPath) {
            try { fs.unlinkSync(assPath); } catch (e) { /* ignore */ }
        }
    }
}

// 检查 FFmpeg / ffprobe 是否可用
app.get('/api/video/check-ffmpeg', async (req, res) => {
    try {
        const { stdout } = await runSpawnCmd(FFMPEG_BIN, ['-version']);
        const line = String(stdout || '').split('\n')[0] || 'ffmpeg';
        res.status(200).json({
            success: true,
            isInstalled: true,
            message: 'FFmpeg 可用',
            versionLine: line
        });
    } catch (error) {
        res.status(200).json({
            success: true,
            isInstalled: false,
            message: '未检测到 FFmpeg。请安装并加入系统 PATH，或设置环境变量 FFMPEG_PATH / FFPROBE_PATH'
        });
    }
});

// 处理JSON视频文件并使用FFmpeg生成视频的API（暂时禁用）
app.post('/api/video/process-json', authenticateToken, async (req, res) => {
    try {
        const { jsonContent, bookInfo } = req.body;
        
        // 验证请求数据
        if (!jsonContent) {
            return res.status(400).json({ success: false, message: '请提供JSON视频内容' });
        }
        
        // 生成任务ID
        const taskId = `task_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        
        // 保存任务信息
        videoTasks[taskId] = {
            status: 'failed',
            createdAt: new Date(),
            jsonContent: jsonContent,
            bookInfo: bookInfo || {},
            userId: req.user.id,
            progress: 0,
            error: '视频处理功能暂时不可用',
            completedAt: new Date()
        };
        
        // 返回任务ID，前端可以通过这个ID查询处理状态
        res.status(202).json({
            success: true,
            message: '视频处理任务已提交',
            taskId: taskId
        });
        
    } catch (error) {
        console.error('提交视频处理任务失败:', error);
        res.status(500).json({ success: false, message: '处理视频文件失败，请稍后再试' });
    }
});

// 查询视频处理状态的API
app.get('/api/video/task/:taskId', authenticateToken, (req, res) => {
    const { taskId } = req.params;
    
    // 检查任务是否存在
    const task = videoTasks[taskId];
    if (!task) {
        return res.status(404).json({ success: false, message: '任务不存在' });
    }
    
    // 检查是否有权限访问该任务
    if (task.userId !== req.user.id) {
        return res.status(403).json({ success: false, message: '无权访问此任务' });
    }
    
    res.status(200).json({
        success: true,
        task: {
            taskId: taskId,
            status: task.status,
            progress: task.progress || 0,
            createdAt: task.createdAt,
            ...(task.completedAt && { completedAt: task.completedAt }),
            ...(task.videoUrl && { cloudVideoUrl: task.videoUrl }),
            ...(task.error && { error: task.error }),
            bookInfo: task.bookInfo
        }
    });
});

// 保存视频到数据库的API
app.post('/api/video/save', authenticateToken, (req, res) => {
    const { videoUrl, title, category, duration, bookInfo } = req.body;
    
    if (!videoUrl || !title) {
        return res.status(400).json({ success: false, message: '请提供视频URL和标题' });
    }
    
    // 注意:实际项目中应该将视频信息保存到数据库
    // 这里只是模拟保存成功的响应
    res.status(200).json({
        success: true,
        message: '视频保存成功',
        video: {
            id: `video_${Date.now()}`,
            title: title,
            category: category || '其他',
            duration: duration || '00:00',
            url: videoUrl,
            bookInfo: bookInfo || {},
            uploadTime: new Date().toISOString(),
            uploadUser: req.user.username,
            status: 'pending' // 初始状态为待审核
        }
    });
});

// 按时间段删除（实际裁切视频文件，需本地 FFmpeg）
app.post('/api/video/ffmpeg-remove', authenticateToken, async (req, res) => {
    try {
        const { videoUrl, segments } = req.body;
        if (!videoUrl || !Array.isArray(segments) || segments.length === 0) {
            return res.status(400).json({ success: false, message: '请提供 videoUrl 与待删除的时间段 segments' });
        }
        const inputAbs = resolveUploadedVideoPath(videoUrl);
        if (!inputAbs) {
            return res.status(400).json({ success: false, message: '无效的视频地址（仅支持本站上载目录 /uploads/videos/）' });
        }
        const outName = `edited-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`;
        const outDir = path.join(__dirname, 'uploads', 'videos');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outAbs = path.join(outDir, outName);
        await ffmpegRemoveSegmentsFromFile(inputAbs, segments, outAbs);
        res.status(200).json({
            success: true,
            videoUrl: `/uploads/videos/${outName}`
        });
    } catch (error) {
        console.error('ffmpeg-remove:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'FFmpeg 处理失败'
        });
    }
});

// 按时间段变速（实际改写视频文件，确保预览与导出一致）
app.post('/api/video/ffmpeg-speed-segment', authenticateToken, async (req, res) => {
    try {
        const { videoUrl, start, end, speed } = req.body;
        if (!videoUrl) {
            return res.status(400).json({ success: false, message: '请提供 videoUrl' });
        }
        const s = Number(speed);
        if (!isFinite(s) || s < 0.25 || s > 4) {
            return res.status(400).json({ success: false, message: 'speed 需在 0.25 - 4 之间' });
        }
        if (!isFinite(Number(start)) || !isFinite(Number(end)) || Number(end) <= Number(start) + 1e-4) {
            return res.status(400).json({ success: false, message: '请提供有效的 start/end 时间段' });
        }
        const inputAbs = resolveUploadedVideoPath(videoUrl);
        if (!inputAbs) {
            return res.status(400).json({ success: false, message: '无效的视频地址（仅支持本站上载目录 /uploads/videos/）' });
        }
        const outName = `speed-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`;
        const outDir = path.join(__dirname, 'uploads', 'videos');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outAbs = path.join(outDir, outName);
        await ffmpegSpeedSegmentFromFile(inputAbs, Number(start), Number(end), s, outAbs);
        res.status(200).json({
            success: true,
            videoUrl: `/uploads/videos/${outName}`
        });
    } catch (error) {
        console.error('ffmpeg-speed-segment:', error);
        res.status(500).json({
            success: false,
            message: error.message || '片段变速失败'
        });
    }
});

// 按时间段倒放（实际改写视频文件，确保预览与导出一致）
app.post('/api/video/ffmpeg-reverse-segment', authenticateToken, async (req, res) => {
    try {
        const { videoUrl, start, end } = req.body;
        if (!videoUrl) {
            return res.status(400).json({ success: false, message: '请提供 videoUrl' });
        }
        if (!isFinite(Number(start)) || !isFinite(Number(end)) || Number(end) <= Number(start) + 1e-4) {
            return res.status(400).json({ success: false, message: '请提供有效的 start/end 时间段' });
        }
        const inputAbs = resolveUploadedVideoPath(videoUrl);
        if (!inputAbs) {
            return res.status(400).json({ success: false, message: '无效的视频地址（仅支持本站上载目录 /uploads/videos/）' });
        }
        const outName = `reverse-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`;
        const outDir = path.join(__dirname, 'uploads', 'videos');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outAbs = path.join(outDir, outName);
        await ffmpegReverseSegmentFromFile(inputAbs, Number(start), Number(end), outAbs);
        res.status(200).json({
            success: true,
            videoUrl: `/uploads/videos/${outName}`
        });
    } catch (error) {
        console.error('ffmpeg-reverse-segment:', error);
        res.status(500).json({
            success: false,
            message: error.message || '片段倒放失败'
        });
    }
});

// 按时间段静音（实际改写视频文件，确保预览与导出一致）
app.post('/api/video/ffmpeg-mute-segment', authenticateToken, async (req, res) => {
    try {
        const { videoUrl, start, end } = req.body;
        if (!videoUrl) {
            return res.status(400).json({ success: false, message: '请提供 videoUrl' });
        }
        if (!isFinite(Number(start)) || !isFinite(Number(end)) || Number(end) <= Number(start) + 1e-4) {
            return res.status(400).json({ success: false, message: '请提供有效的 start/end 时间段' });
        }
        const inputAbs = resolveUploadedVideoPath(videoUrl);
        if (!inputAbs) {
            return res.status(400).json({ success: false, message: '无效的视频地址（仅支持本站上载目录 /uploads/videos/）' });
        }
        const outName = `mute-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`;
        const outDir = path.join(__dirname, 'uploads', 'videos');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outAbs = path.join(outDir, outName);
        await ffmpegMuteSegmentFromFile(inputAbs, Number(start), Number(end), outAbs);
        res.status(200).json({
            success: true,
            videoUrl: `/uploads/videos/${outName}`
        });
    } catch (error) {
        console.error('ffmpeg-mute-segment:', error);
        res.status(500).json({
            success: false,
            message: error.message || '片段静音失败'
        });
    }
});

// 按时间段应用音频淡入淡出（实际改写视频文件，确保预览与导出一致）
app.post('/api/video/ffmpeg-audio-fade-segment', authenticateToken, async (req, res) => {
    try {
        const { videoUrl, start, end, fadeSec } = req.body;
        if (!videoUrl) {
            return res.status(400).json({ success: false, message: '请提供 videoUrl' });
        }
        if (!isFinite(Number(start)) || !isFinite(Number(end)) || Number(end) <= Number(start) + 1e-4) {
            return res.status(400).json({ success: false, message: '请提供有效的 start/end 时间段' });
        }
        const fd = Number(fadeSec);
        if (!isFinite(fd) || fd <= 0) {
            return res.status(400).json({ success: false, message: '请提供有效的 fadeSec' });
        }
        const inputAbs = resolveUploadedVideoPath(videoUrl);
        if (!inputAbs) {
            return res.status(400).json({ success: false, message: '无效的视频地址（仅支持本站上载目录 /uploads/videos/）' });
        }
        const outName = `afade-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`;
        const outDir = path.join(__dirname, 'uploads', 'videos');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outAbs = path.join(outDir, outName);
        await ffmpegAudioFadeSegmentFromFile(inputAbs, Number(start), Number(end), fd, outAbs);
        res.status(200).json({
            success: true,
            videoUrl: `/uploads/videos/${outName}`
        });
    } catch (error) {
        console.error('ffmpeg-audio-fade-segment:', error);
        res.status(500).json({
            success: false,
            message: error.message || '片段音频淡入淡出失败'
        });
    }
});

// 编辑器附加音轨：上传到服务器供导出混音（blob: 无法被 FFmpeg 读取）
app.post('/api/video/upload-audio', authenticateToken, (req, res) => {
    uploadAudio.single('file')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ success: false, message: err.message || '上传失败' });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: '未上传文件' });
        }
        res.json({
            success: true,
            audioUrl: `/uploads/audio/${req.file.filename}`
        });
    });
});

// 导出已剪辑视频（删除裁切 + 可选：变速、旋转、翻转、滤镜、字幕烧录、附加音轨混音）
app.post('/api/video/edit/export', authenticateToken, async (req, res) => {
    let tmpCutPath = null;
    try {
        const { videoUrl, operations, render } = req.body;
        if (!videoUrl) {
            return res.status(400).json({ success: false, message: '请提供 videoUrl' });
        }
        const inputAbs = resolveUploadedVideoPath(videoUrl);
        if (!inputAbs) {
            return res.status(400).json({ success: false, message: '无效的视频地址' });
        }
        const ops = Array.isArray(operations) ? operations : [];
        const removes = ops
            .filter((o) => o && o.type === 'delete')
            .map((o) => {
                const s = o.originalStart != null ? Number(o.originalStart) : Number(o.start);
                const e = o.originalEnd != null ? Number(o.originalEnd) : Number(o.end);
                return { start: s, end: e };
            })
            .filter((iv) => iv.end > iv.start + 1e-4);

        tmpCutPath = path.join(os.tmpdir(), `export-cut-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
        if (!removes.length) {
            await fs.promises.copyFile(inputAbs, tmpCutPath);
        } else {
            await ffmpegRemoveSegmentsFromFile(inputAbs, removes, tmpCutPath);
        }

        const outName = `export-${Date.now()}-${Math.round(Math.random() * 1e9)}.mp4`;
        const outDir = path.join(__dirname, 'uploads', 'videos');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outAbs = path.join(outDir, outName);

        if (exportRenderNeedsPass(render)) {
            await ffmpegApplyRenderPass(tmpCutPath, outAbs, render);
        } else {
            await fs.promises.copyFile(tmpCutPath, outAbs);
        }

        res.status(200).json({
            success: true,
            downloadUrl: `/uploads/videos/${outName}`,
            fileName: outName
        });
    } catch (error) {
        console.error('video edit export:', error);
        res.status(500).json({
            success: false,
            message: error.message || '导出失败'
        });
    } finally {
        if (tmpCutPath) {
            try { fs.unlinkSync(tmpCutPath); } catch (e) { /* ignore */ }
        }
    }
});

// ================= 图书商店API =================

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

const DEFAULT_RECO_SETTINGS = {
    enabled: true,
    cache_enabled: true,
    cache_ttl_sec: 120,
    cf_min_interactions: 3,
    cf_min_neighbors: 2,
    cf_similarity: 'cosine',
    ab_enabled: false,
    ab_traffic_pct: 20,
    ab_variant_cf_min_interactions: 1,
    ab_variant_cf_min_neighbors: 1,
    ab_variant_cf_similarity: 'pearson',
    alert_cf_hit_min_pct: 5,
    alert_ctr_min_pct: 1,
    reco_gateway_enabled: RECO_GATEWAY_ENABLED,
    reco_gateway_base_url: RECO_SERVICE_BASE_URL,
    reco_gateway_traffic_pct: 100,
    weights: { ...RECO_EVENT_WEIGHTS }
};
let runtimeRecoSettings = { ...DEFAULT_RECO_SETTINGS, weights: { ...DEFAULT_RECO_SETTINGS.weights } };

function normalizeRecoSimilarity(v) {
    return String(v || DEFAULT_RECO_SETTINGS.cf_similarity).toLowerCase() === 'pearson' ? 'pearson' : 'cosine';
}

function normalizeRecoSettings(raw = {}) {
    const enabled = raw.enabled === false ? false : Boolean(raw.enabled);
    const cacheEnabled = raw.cache_enabled === false ? false : Boolean(raw.cache_enabled);
    const ttl = Math.max(15, Math.min(3600, Number(raw.cache_ttl_sec) || DEFAULT_RECO_SETTINGS.cache_ttl_sec));
    const cfMinInteractions = Math.max(1, Math.min(50, Number(raw.cf_min_interactions) || DEFAULT_RECO_SETTINGS.cf_min_interactions));
    const cfMinNeighbors = Math.max(1, Math.min(50, Number(raw.cf_min_neighbors) || DEFAULT_RECO_SETTINGS.cf_min_neighbors));
    const cfSimilarity = normalizeRecoSimilarity(raw.cf_similarity);
    const abEnabled = raw.ab_enabled === true || raw.ab_enabled === 1 || raw.ab_enabled === '1';
    const abTrafficPct = Math.max(0, Math.min(100, Number(raw.ab_traffic_pct) || DEFAULT_RECO_SETTINGS.ab_traffic_pct));
    const abVariantCfMinInteractions = Math.max(1, Math.min(50, Number(raw.ab_variant_cf_min_interactions) || DEFAULT_RECO_SETTINGS.ab_variant_cf_min_interactions));
    const abVariantCfMinNeighbors = Math.max(1, Math.min(50, Number(raw.ab_variant_cf_min_neighbors) || DEFAULT_RECO_SETTINGS.ab_variant_cf_min_neighbors));
    const abVariantCfSimilarity = normalizeRecoSimilarity(raw.ab_variant_cf_similarity || DEFAULT_RECO_SETTINGS.ab_variant_cf_similarity);
    const alertCfHitMinPct = Math.max(0, Math.min(100, Number(raw.alert_cf_hit_min_pct) || DEFAULT_RECO_SETTINGS.alert_cf_hit_min_pct));
    const alertCtrMinPct = Math.max(0, Math.min(100, Number(raw.alert_ctr_min_pct) || DEFAULT_RECO_SETTINGS.alert_ctr_min_pct));
    const recoGatewayEnabled = raw.reco_gateway_enabled === true || raw.reco_gateway_enabled === 1 || raw.reco_gateway_enabled === '1';
    const recoGatewayBaseUrl = String(raw.reco_gateway_base_url || DEFAULT_RECO_SETTINGS.reco_gateway_base_url || 'http://localhost:3011').trim();
    const recoGatewayTrafficPct = Math.max(0, Math.min(100, Number(raw.reco_gateway_traffic_pct) || DEFAULT_RECO_SETTINGS.reco_gateway_traffic_pct));
    const mergedWeights = { ...RECO_EVENT_WEIGHTS, ...(raw.weights || {}) };
    const normalizedWeights = {};
    for (const [k, v] of Object.entries(mergedWeights)) {
        const num = Number(v);
        normalizedWeights[k] = Number.isFinite(num) ? num : RECO_EVENT_WEIGHTS[k] || 0;
    }
    return {
        enabled,
        cache_enabled: cacheEnabled,
        cache_ttl_sec: ttl,
        cf_min_interactions: cfMinInteractions,
        cf_min_neighbors: cfMinNeighbors,
        cf_similarity: cfSimilarity,
        ab_enabled: abEnabled,
        ab_traffic_pct: abTrafficPct,
        ab_variant_cf_min_interactions: abVariantCfMinInteractions,
        ab_variant_cf_min_neighbors: abVariantCfMinNeighbors,
        ab_variant_cf_similarity: abVariantCfSimilarity,
        alert_cf_hit_min_pct: alertCfHitMinPct,
        alert_ctr_min_pct: alertCtrMinPct,
        reco_gateway_enabled: recoGatewayEnabled,
        reco_gateway_base_url: recoGatewayBaseUrl,
        reco_gateway_traffic_pct: recoGatewayTrafficPct,
        weights: normalizedWeights
    };
}

async function loadRecoSettingsFromDb() {
    try {
        const tableCols = await dbAllAsync(`PRAGMA table_info(reco_settings)`);
        const colSet = new Set((tableCols || []).map((c) => c.name));
        const cfInteractionsExpr = colSet.has('cf_min_interactions') ? 'cf_min_interactions' : `${DEFAULT_RECO_SETTINGS.cf_min_interactions} AS cf_min_interactions`;
        const cfNeighborsExpr = colSet.has('cf_min_neighbors') ? 'cf_min_neighbors' : `${DEFAULT_RECO_SETTINGS.cf_min_neighbors} AS cf_min_neighbors`;
        const cfSimilarityExpr = colSet.has('cf_similarity') ? 'cf_similarity' : `'${DEFAULT_RECO_SETTINGS.cf_similarity}' AS cf_similarity`;
        const abEnabledExpr = colSet.has('ab_enabled') ? 'ab_enabled' : `${DEFAULT_RECO_SETTINGS.ab_enabled ? 1 : 0} AS ab_enabled`;
        const abTrafficExpr = colSet.has('ab_traffic_pct') ? 'ab_traffic_pct' : `${DEFAULT_RECO_SETTINGS.ab_traffic_pct} AS ab_traffic_pct`;
        const abVarCfMinInteractionsExpr = colSet.has('ab_variant_cf_min_interactions')
            ? 'ab_variant_cf_min_interactions'
            : `${DEFAULT_RECO_SETTINGS.ab_variant_cf_min_interactions} AS ab_variant_cf_min_interactions`;
        const abVarCfMinNeighborsExpr = colSet.has('ab_variant_cf_min_neighbors')
            ? 'ab_variant_cf_min_neighbors'
            : `${DEFAULT_RECO_SETTINGS.ab_variant_cf_min_neighbors} AS ab_variant_cf_min_neighbors`;
        const abVarCfSimilarityExpr = colSet.has('ab_variant_cf_similarity')
            ? 'ab_variant_cf_similarity'
            : `'${DEFAULT_RECO_SETTINGS.ab_variant_cf_similarity}' AS ab_variant_cf_similarity`;
        const alertCfHitMinExpr = colSet.has('alert_cf_hit_min_pct')
            ? 'alert_cf_hit_min_pct'
            : `${DEFAULT_RECO_SETTINGS.alert_cf_hit_min_pct} AS alert_cf_hit_min_pct`;
        const alertCtrMinExpr = colSet.has('alert_ctr_min_pct')
            ? 'alert_ctr_min_pct'
            : `${DEFAULT_RECO_SETTINGS.alert_ctr_min_pct} AS alert_ctr_min_pct`;
        const recoGatewayEnabledExpr = colSet.has('reco_gateway_enabled')
            ? 'reco_gateway_enabled'
            : `${DEFAULT_RECO_SETTINGS.reco_gateway_enabled ? 1 : 0} AS reco_gateway_enabled`;
        const recoGatewayBaseUrlExpr = colSet.has('reco_gateway_base_url')
            ? 'reco_gateway_base_url'
            : `'${DEFAULT_RECO_SETTINGS.reco_gateway_base_url}' AS reco_gateway_base_url`;
        const recoGatewayTrafficExpr = colSet.has('reco_gateway_traffic_pct')
            ? 'reco_gateway_traffic_pct'
            : `${DEFAULT_RECO_SETTINGS.reco_gateway_traffic_pct} AS reco_gateway_traffic_pct`;
        const rows = await dbAllAsync(
            `SELECT enabled, cache_enabled, cache_ttl_sec, ${cfInteractionsExpr}, ${cfNeighborsExpr}, ${cfSimilarityExpr},
                    ${abEnabledExpr}, ${abTrafficExpr}, ${abVarCfMinInteractionsExpr}, ${abVarCfMinNeighborsExpr}, ${abVarCfSimilarityExpr},
                    ${alertCfHitMinExpr}, ${alertCtrMinExpr}, ${recoGatewayEnabledExpr}, ${recoGatewayBaseUrlExpr}, ${recoGatewayTrafficExpr},
                    weights_json
             FROM reco_settings
             WHERE id = 1
             LIMIT 1`
        );
        if (!rows.length) {
            runtimeRecoSettings = { ...DEFAULT_RECO_SETTINGS, weights: { ...DEFAULT_RECO_SETTINGS.weights } };
            return runtimeRecoSettings;
        }
        const row = rows[0];
        let parsedWeights = {};
        try { parsedWeights = JSON.parse(String(row.weights_json || '{}')); } catch (e) { parsedWeights = {}; }
        runtimeRecoSettings = normalizeRecoSettings({
            enabled: Number(row.enabled) === 1,
            cache_enabled: Number(row.cache_enabled) === 1,
            cache_ttl_sec: Number(row.cache_ttl_sec),
            cf_min_interactions: Number(row.cf_min_interactions),
            cf_min_neighbors: Number(row.cf_min_neighbors),
            cf_similarity: String(row.cf_similarity || DEFAULT_RECO_SETTINGS.cf_similarity),
            ab_enabled: Number(row.ab_enabled) === 1,
            ab_traffic_pct: Number(row.ab_traffic_pct),
            ab_variant_cf_min_interactions: Number(row.ab_variant_cf_min_interactions),
            ab_variant_cf_min_neighbors: Number(row.ab_variant_cf_min_neighbors),
            ab_variant_cf_similarity: String(row.ab_variant_cf_similarity || DEFAULT_RECO_SETTINGS.ab_variant_cf_similarity),
            alert_cf_hit_min_pct: Number(row.alert_cf_hit_min_pct),
            alert_ctr_min_pct: Number(row.alert_ctr_min_pct),
            reco_gateway_enabled: Number(row.reco_gateway_enabled) === 1,
            reco_gateway_base_url: String(row.reco_gateway_base_url || DEFAULT_RECO_SETTINGS.reco_gateway_base_url),
            reco_gateway_traffic_pct: Number(row.reco_gateway_traffic_pct),
            weights: parsedWeights
        });
        return runtimeRecoSettings;
    } catch (error) {
        console.warn('loadRecoSettingsFromDb failed, fallback defaults:', error.message);
        runtimeRecoSettings = { ...DEFAULT_RECO_SETTINGS, weights: { ...DEFAULT_RECO_SETTINGS.weights } };
        return runtimeRecoSettings;
    }
}

function getRecoSettings() {
    return runtimeRecoSettings || DEFAULT_RECO_SETTINGS;
}

function getRecoExperimentVariant(userId, recoSettings) {
    const cfg = recoSettings || getRecoSettings();
    if (!cfg.ab_enabled) return 'A';
    const trafficPct = Math.max(0, Math.min(100, Number(cfg.ab_traffic_pct) || 0));
    if (trafficPct <= 0) return 'A';
    const uid = Number(userId) || 0;
    if (!uid) return 'A';
    // Deterministic bucket [0,99] to keep user in same variant.
    const bucket = Math.abs((uid * 1315423911) % 100);
    return bucket < trafficPct ? 'B' : 'A';
}

function getEffectiveCfConfig(userId, recoSettings) {
    const cfg = recoSettings || getRecoSettings();
    const expVariant = getRecoExperimentVariant(userId, cfg);
    const baseCfMinInteractions = Math.max(1, Number(cfg.cf_min_interactions || DEFAULT_RECO_SETTINGS.cf_min_interactions || 3));
    const baseCfMinNeighbors = Math.max(1, Number(cfg.cf_min_neighbors || DEFAULT_RECO_SETTINGS.cf_min_neighbors || 2));
    const baseCfSimilarity = normalizeRecoSimilarity(cfg.cf_similarity || DEFAULT_RECO_SETTINGS.cf_similarity || 'cosine');
    const cfMinInteractions = expVariant === 'B'
        ? Math.max(1, Number(cfg.ab_variant_cf_min_interactions || DEFAULT_RECO_SETTINGS.ab_variant_cf_min_interactions || 1))
        : baseCfMinInteractions;
    const cfMinNeighbors = expVariant === 'B'
        ? Math.max(1, Number(cfg.ab_variant_cf_min_neighbors || DEFAULT_RECO_SETTINGS.ab_variant_cf_min_neighbors || 1))
        : baseCfMinNeighbors;
    const cfSimilarity = expVariant === 'B'
        ? normalizeRecoSimilarity(cfg.ab_variant_cf_similarity || DEFAULT_RECO_SETTINGS.ab_variant_cf_similarity || 'pearson')
        : baseCfSimilarity;
    return {
        expVariant,
        cf_min_interactions: cfMinInteractions,
        cf_min_neighbors: cfMinNeighbors,
        cf_similarity: cfSimilarity
    };
}

function shouldUseRecoGatewayForUser(userId, recoSettings) {
    const cfg = recoSettings || getRecoSettings();
    if (!cfg.reco_gateway_enabled) return false;
    if (!recoGatewayState.healthy) return false;
    const pct = Math.max(0, Math.min(100, Number(cfg.reco_gateway_traffic_pct) || 0));
    if (pct <= 0) return false;
    if (pct >= 100) return true;
    const uid = Number(userId) || 0;
    if (!uid) return false;
    const bucket = Math.abs((uid * 2654435761) % 100);
    return bucket < pct;
}

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

function makeOrderNo() {
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
    const rnd = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    return `ORD${stamp}${rnd}`;
}

function addHoursIso(hours) {
    return new Date(Date.now() + Math.max(1, Number(hours) || 72) * 3600 * 1000).toISOString();
}

async function geocodeAddressByAmap(addressText) {
    const address = String(addressText || '').trim();
    if (!AMAP_WEB_KEY || !address) return null;
    const url = 'https://restapi.amap.com/v3/geocode/geo';
    const resp = await axios.get(url, {
        params: { key: AMAP_WEB_KEY, address },
        timeout: 7000
    });
    const data = resp && resp.data ? resp.data : {};
    if (String(data.status) !== '1' || !Array.isArray(data.geocodes) || !data.geocodes.length) return null;
    const first = data.geocodes[0] || {};
    const loc = String(first.location || '');
    const [lng, lat] = loc.split(',').map((x) => Number(x));
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return {
        lng,
        lat,
        province: String(first.province || ''),
        city: String(first.city || ''),
        district: String(first.district || '')
    };
}

async function reverseGeocodeProvinceByAmap(lng, lat) {
    if (!AMAP_WEB_KEY || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) return '';
    const url = 'https://restapi.amap.com/v3/geocode/regeo';
    const resp = await axios.get(url, {
        params: {
            key: AMAP_WEB_KEY,
            location: `${Number(lng)},${Number(lat)}`,
            extensions: 'base'
        },
        timeout: 7000
    });
    const data = resp && resp.data ? resp.data : {};
    if (String(data.status) !== '1') return '';
    const province = String(data?.regeocode?.addressComponent?.province || '').trim();
    return province;
}

async function collectTransitProvincesFromSteps(steps = [], originProvince = '', destProvince = '') {
    if (!Array.isArray(steps) || !steps.length || !AMAP_WEB_KEY) return [];
    const from = String(originProvince || '').trim();
    const to = String(destProvince || '').trim();
    const found = [];
    const cache = new Map();
    const maxChecks = Math.min(18, steps.length);
    const stride = Math.max(1, Math.floor(steps.length / maxChecks));
    for (let i = 0; i < steps.length; i += stride) {
        const s = steps[i] || {};
        const lng = Number(s.lng);
        const lat = Number(s.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const key = `${lng.toFixed(3)},${lat.toFixed(3)}`;
        let province = cache.get(key);
        if (province === undefined) {
            try {
                province = await reverseGeocodeProvinceByAmap(lng, lat);
            } catch (e) {
                province = '';
            }
            cache.set(key, province || '');
        }
        const p = String(province || '').trim();
        if (!p || p === from || p === to) continue;
        if (!found.includes(p)) found.push(p);
        if (found.length >= 5) break;
    }
    return found;
}

async function planRouteByAmap(origin, destination) {
    if (!AMAP_WEB_KEY || !origin || !destination) return null;
    const url = 'https://restapi.amap.com/v3/direction/driving';
    const resp = await axios.get(url, {
        params: {
            key: AMAP_WEB_KEY,
            origin: `${origin.lng},${origin.lat}`,
            destination: `${destination.lng},${destination.lat}`
        },
        timeout: 7000
    });
    const data = resp && resp.data ? resp.data : {};
    if (String(data.status) !== '1' || !data.route || !Array.isArray(data.route.paths) || !data.route.paths.length) return null;
    const path = data.route.paths[0] || {};
    const steps = Array.isArray(path.steps) ? path.steps : [];
    const parsedSteps = steps.map((s, idx) => {
        const polyline = String(s?.polyline || '');
        const points = polyline
            .split(';')
            .map((p) => p.split(',').map((x) => Number(x)))
            .filter((arr) => arr.length === 2 && Number.isFinite(arr[0]) && Number.isFinite(arr[1]));
        const last = points.length ? points[points.length - 1] : [NaN, NaN];
        return {
            seq: idx + 1,
            instruction: String(s?.instruction || ''),
            road: String(s?.road || ''),
            distance_m: Number(s?.distance || 0),
            duration_s: Number(s?.duration || 0),
            lng: Number(last[0]),
            lat: Number(last[1]),
            polyline
        };
    });
    return {
        distance_m: Number(path.distance || 0),
        duration_s: Number(path.duration || 0),
        polyline: String(path.steps?.map((s) => s.polyline || '').filter(Boolean).join(';') || ''),
        steps: parsedSteps
    };
}

function buildMockRoutePayload() {
    const origin = { lng: 116.4074, lat: 39.9042, city: '北京', province: '北京', district: '朝阳区' };
    const dest = { lng: 121.4737, lat: 31.2304, city: '上海', province: '上海', district: '浦东新区' };
    return {
        source: 'mock',
        origin,
        dest,
        route: {
            distance_m: 1200000,
            duration_s: 48 * 3600,
            polyline: '',
            steps: [
                { seq: 1, instruction: '包裹已从始发仓出库', road: '北京仓', distance_m: 120000, duration_s: 4 * 3600, lng: 116.55, lat: 39.88 },
                { seq: 2, instruction: '包裹运输中，已到达华北转运中心', road: '华北转运中心', distance_m: 380000, duration_s: 10 * 3600, lng: 117.2, lat: 38.95 },
                { seq: 3, instruction: '包裹运输中，已到达华东转运中心', road: '华东转运中心', distance_m: 520000, duration_s: 16 * 3600, lng: 119.5, lat: 34.6 },
                { seq: 4, instruction: '包裹已到达目的城市分拨中心', road: '目的城市分拨中心', distance_m: 180000, duration_s: 8 * 3600, lng: 121.2, lat: 31.45 },
                { seq: 5, instruction: '包裹派送中，请保持电话畅通', road: '末端派送站', distance_m: 20000, duration_s: 2 * 3600, lng: 121.42, lat: 31.28 }
            ]
        },
        slaHours: 72,
        etaAt: addHoursIso(72)
    };
}

function buildRouteNodes(routeInfo, receiverAddress) {
    const steps = Array.isArray(routeInfo?.route?.steps) ? routeInfo.route.steps : [];
    if (!steps.length) return [];
    const originProvince = String(routeInfo?.origin?.province || '').trim() || '发货地';
    const destProvince = String(routeInfo?.dest?.province || '').trim() || '收货地';
    const transitProvinces = Array.isArray(routeInfo?.route?.transit_provinces) ? routeInfo.route.transit_provinces : [];
    const stepTotal = steps.length;
    const pickPointByRatio = (ratio) => {
        const idx = Math.max(0, Math.min(stepTotal - 1, Math.floor(ratio * (stepTotal - 1))));
        return steps[idx] || {};
    };
    const sumDistance = (startRatio, endRatio) => {
        const s = Math.max(0, Math.floor(startRatio * stepTotal));
        const e = Math.min(stepTotal - 1, Math.floor(endRatio * stepTotal));
        let d = 0;
        for (let i = s; i <= e; i++) d += Number(steps[i]?.distance_m || 0);
        return d;
    };
    const sumDuration = (startRatio, endRatio) => {
        const s = Math.max(0, Math.floor(startRatio * stepTotal));
        const e = Math.min(stepTotal - 1, Math.floor(endRatio * stepTotal));
        let t = 0;
        for (let i = s; i <= e; i++) t += Number(steps[i]?.duration_s || 0);
        return t;
    };

    const transitList = transitProvinces.length
        ? transitProvinces
        : (originProvince !== destProvince ? ['跨省干线'] : ['省内运输']);
    const nodes = [];
    let seq = 1;

    const first = steps[0] || {};
    nodes.push({
        seq: seq++,
        status: 'picked',
        content: '包裹已揽收',
        location: originProvince,
        lng: Number(first.lng || routeInfo?.origin?.lng || 0),
        lat: Number(first.lat || routeInfo?.origin?.lat || 0),
        distance_m: Number(first.distance_m || 0),
        duration_s: Number(first.duration_s || 0)
    });

    const n = transitList.length;
    for (let i = 0; i < n; i++) {
        const startRatio = i / n;
        const endRatio = (i + 1) / n;
        const p = pickPointByRatio(endRatio);
        const province = transitList[i];
        nodes.push({
            seq: seq++,
            status: 'in_transit',
            content: '包裹运输中',
            location: province === '跨省干线' || province === '省内运输' ? province : `途经${province}`,
            lng: Number(p.lng || 0),
            lat: Number(p.lat || 0),
            distance_m: sumDistance(startRatio, endRatio),
            duration_s: sumDuration(startRatio, endRatio)
        });
    }

    const last = steps[steps.length - 1] || {};
    nodes.push({
        seq: seq++,
        status: 'delivering',
        content: '包裹派送中',
        location: destProvince,
        lng: Number(last.lng || routeInfo?.dest?.lng || 0),
        lat: Number(last.lat || routeInfo?.dest?.lat || 0),
        distance_m: Number(last.distance_m || 0),
        duration_s: Number(last.duration_s || 0)
    });
    nodes.push({
        seq: seq++,
        status: 'signed',
        content: '包裹已签收，感谢使用',
        location: destProvince,
        lng: Number(routeInfo?.dest?.lng || 0),
        lat: Number(routeInfo?.dest?.lat || 0),
        distance_m: 0,
        duration_s: 0
    });
    return nodes;
}

function extractProvinceText(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (!s) return '';
    const m = s.match(/(北京市|天津市|上海市|重庆市|[^省]+省|[^区]+自治区|[^区]+特别行政区|[^市]+市)/);
    return m ? String(m[1]) : '';
}

async function buildShippingRouteFromAddress(shippingAddress) {
    try {
        if (!AMAP_WEB_KEY) return buildMockRoutePayload();
        const [origin, dest] = await Promise.all([
            geocodeAddressByAmap(SHIPPING_ORIGIN_ADDRESS),
            geocodeAddressByAmap(shippingAddress)
        ]);
        if (!origin || !dest) return buildMockRoutePayload();
        const route = await planRouteByAmap(origin, dest);
        if (!route) return buildMockRoutePayload();
        route.transit_provinces = await collectTransitProvincesFromSteps(
            route.steps || [],
            String(origin.province || ''),
            String(dest.province || '')
        );
        const etaHours = Math.max(24, Math.ceil((Number(route.duration_s || 0) / 3600) * 1.5));
        return {
            source: 'amap',
            origin,
            dest,
            route,
            slaHours: etaHours,
            etaAt: addHoursIso(etaHours)
        };
    } catch (error) {
        console.warn('高德路线规划失败，回退mock:', error.message);
        return buildMockRoutePayload();
    }
}

async function saveShippingRouteNodes(orderId, nodes = []) {
    const oid = Number(orderId || 0);
    if (!oid || !Array.isArray(nodes) || !nodes.length) return 0;
    await dbRunAsync(`DELETE FROM shipping_route_nodes WHERE order_id = ?`, [oid]);
    for (const n of nodes) {
        await dbRunAsync(
            `INSERT INTO shipping_route_nodes (order_id, seq, status, content, location, lng, lat, distance_m, duration_s, is_done, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                oid,
                Number(n.seq || 0),
                String(n.status || 'in_transit'),
                String(n.content || ''),
                String(n.location || ''),
                Number(n.lng || 0),
                Number(n.lat || 0),
                Number(n.distance_m || 0),
                Number(n.duration_s || 0)
            ]
        );
    }
    return nodes.length;
}

async function popNextRouteNode(orderId) {
    const oid = Number(orderId || 0);
    if (!oid) return null;
    const row = await dbGetAsync(
        `SELECT id, seq, status, content, location, lng, lat, distance_m, duration_s
         FROM shipping_route_nodes
         WHERE order_id = ? AND is_done = 0
         ORDER BY seq ASC
         LIMIT 1`,
        [oid]
    );
    if (!row) return null;
    await dbRunAsync(
        `UPDATE shipping_route_nodes
         SET is_done = 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [Number(row.id)]
    );
    return row;
}

async function scanShippingAnomalies() {
    try {
        const rows = await dbAllAsync(
            `SELECT id, shipping_status, shipping_updated_at, eta_at
             FROM orders
             WHERE status NOT IN ('cancelled', 'refunded')`
        );
        const now = Date.now();
        for (const row of rows) {
            const status = String(row.shipping_status || '');
            if (status === 'signed') continue;
            const updatedMs = Date.parse(String(row.shipping_updated_at || row.eta_at || ''));
            const etaMs = Date.parse(String(row.eta_at || ''));
            const noUpdateMinutes = Number.isFinite(updatedMs) ? Math.floor((now - updatedMs) / 60000) : 0;
            const delayMinutes = Number.isFinite(etaMs) ? Math.max(0, Math.floor((now - etaMs) / 60000)) : 0;
            let isDelayed = delayMinutes > 0 ? 1 : 0;
            let nextStatus = status;
            let exCode = '';
            let exText = '';
            if (noUpdateMinutes > 24 * 60) {
                nextStatus = 'exception';
                exCode = 'NO_TRACK_UPDATE';
                exText = '物流长时间未更新，请关注处理';
                isDelayed = 1;
            } else if (status === 'picked' && noUpdateMinutes > 12 * 60) {
                nextStatus = 'exception';
                exCode = 'STAGNATION_PICKED';
                exText = '包裹揽收后长时间未发运';
                isDelayed = 1;
            } else if (status === 'in_transit' && noUpdateMinutes > 48 * 60) {
                nextStatus = 'exception';
                exCode = 'STAGNATION_TRANSIT';
                exText = '包裹运输中滞留超时';
                isDelayed = 1;
            }
            await dbRunAsync(
                `UPDATE orders
                 SET shipping_status = ?, shipping_is_delayed = ?, shipping_delay_minutes = ?,
                     shipping_exception_code = ?, shipping_exception_text = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [nextStatus, isDelayed, delayMinutes, exCode, exText, Number(row.id)]
            );
        }
    } catch (error) {
        console.warn('物流异常扫描失败:', error.message);
    }
}

function normalizeRecoStrategy(strategy) {
    const s = String(strategy || '').trim().toLowerCase();
    if (['cf', 'content', 'hot', 'fresh', 'focus', 'hybrid'].includes(s)) return s;
    return '';
}

async function recordRecoEvent(userId, bookId, eventType, eventValue = 1, scene = 'book_square', sessionId = '', strategy = '') {
    const cfg = getRecoSettings();
    if (!cfg.enabled) return;
    const uid = Number(userId);
    const bid = Number(bookId);
    const ev = String(eventType || '').trim();
    if (!uid || !bid || !ev) return;
    try {
        await dbRunAsync(
            `INSERT INTO reco_event_queue (user_id, session_id, book_id, event_type, event_value, scene, strategy, status, available_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
            [uid, String(sessionId || ''), bid, ev, Number(eventValue) || 1, String(scene || 'book_square'), normalizeRecoStrategy(strategy)]
        );
    } catch (error) {
        console.warn('recordRecoEvent failed:', error.message);
    }
}

async function drainRecoEventQueue(batchSize = 200) {
    const limit = Math.max(1, Math.min(1000, Number(batchSize) || 200));
    const pending = await dbAllAsync(
        `SELECT id, user_id, session_id, book_id, event_type, event_value, scene, strategy, attempts
         FROM reco_event_queue
         WHERE status = 'pending'
           AND datetime(available_at) <= datetime('now')
         ORDER BY id ASC
         LIMIT ?`,
        [limit]
    );
    if (!pending.length) return { pulled: 0, done: 0, retried: 0, failed: 0 };
    const ids = pending.map((x) => Number(x.id)).filter(Boolean);
    const placeholders = ids.map(() => '?').join(',');
    await dbRunAsync(
        `UPDATE reco_event_queue
         SET status = 'processing', attempts = attempts + 1
         WHERE id IN (${placeholders}) AND status = 'pending'`,
        ids
    );
    let done = 0;
    let retried = 0;
    let failed = 0;
    const neo4jDeltaRows = [];
    for (const item of pending) {
        try {
            await dbRunAsync(
                `INSERT INTO book_reco_events (user_id, session_id, book_id, event_type, event_value, scene, strategy)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    Number(item.user_id),
                    String(item.session_id || ''),
                    Number(item.book_id),
                    String(item.event_type || ''),
                    Number(item.event_value) || 1,
                    String(item.scene || 'book_square'),
                    normalizeRecoStrategy(item.strategy)
                ]
            );
            await dbRunAsync(
                `UPDATE reco_event_queue
                 SET status = 'done', processed_at = CURRENT_TIMESTAMP, error_message = ''
                 WHERE id = ?`,
                [Number(item.id)]
            );
            neo4jDeltaRows.push({
                user_id: Number(item.user_id),
                book_id: Number(item.book_id),
                event_type: String(item.event_type || ''),
                event_value: Number(item.event_value) || 1,
                created_at: new Date().toISOString()
            });
            done += 1;
        } catch (error) {
            const attempts = Number(item.attempts || 0) + 1;
            if (attempts >= 3) {
                await dbRunAsync(
                    `UPDATE reco_event_queue
                     SET status = 'failed', error_message = ?, processed_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [String(error.message || 'unknown error').slice(0, 300), Number(item.id)]
                );
                failed += 1;
            } else {
                await dbRunAsync(
                    `UPDATE reco_event_queue
                     SET status = 'pending',
                         available_at = datetime('now', '+30 seconds'),
                         error_message = ?
                     WHERE id = ?`,
                    [String(error.message || 'retry later').slice(0, 300), Number(item.id)]
                );
                retried += 1;
            }
        }
    }
    if (neo4jDeltaRows.length) {
        await syncNeo4jInteractionsIncremental(neo4jDeltaRows);
    }
    return { pulled: pending.length, done, retried, failed };
}

async function backfillRecoEventStrategies(days = 30, limit = 5000) {
    const safeDays = Math.max(1, Math.min(180, Number(days) || 30));
    const safeLimit = Math.max(100, Math.min(50000, Number(limit) || 5000));
    const targetEvents = await dbAllAsync(
        `SELECT id, user_id, book_id, event_type, scene
         FROM book_reco_events
         WHERE COALESCE(strategy, '') = ''
           AND datetime(created_at) >= datetime('now', ?)
           AND event_type IN ('impression', 'click', 'detail', 'detail_view')
         ORDER BY id DESC
         LIMIT ?`,
        [`-${safeDays} day`, safeLimit]
    );
    if (!targetEvents.length) {
        return { scanned: 0, updated: 0, from_cache: 0, fallback_hot: 0 };
    }
    const cacheRows = await dbAllAsync(
        `SELECT user_id, book_id, strategy
         FROM book_reco_cache
         WHERE COALESCE(strategy, '') <> ''
         ORDER BY updated_at DESC
         LIMIT 200000`
    );
    const latestStrategyByPair = new Map();
    for (const row of cacheRows) {
        const uid = Number(row.user_id);
        const bid = Number(row.book_id);
        const strategy = normalizeRecoStrategy(row.strategy);
        if (!uid || !bid || !strategy) continue;
        const key = `${uid}:${bid}`;
        if (!latestStrategyByPair.has(key)) latestStrategyByPair.set(key, strategy);
    }

    const updatesByStrategy = new Map();
    let fromCache = 0;
    let fallbackHot = 0;
    for (const ev of targetEvents) {
        const eventId = Number(ev.id);
        const uid = Number(ev.user_id);
        const bid = Number(ev.book_id);
        if (!eventId || !uid || !bid) continue;
        let strategy = latestStrategyByPair.get(`${uid}:${bid}`) || '';
        if (!strategy && String(ev.scene || '') === 'book_square' && ['impression', 'click'].includes(String(ev.event_type || ''))) {
            strategy = 'hot';
            fallbackHot += 1;
        }
        strategy = normalizeRecoStrategy(strategy);
        if (!strategy) continue;
        fromCache += strategy === 'hot' ? 0 : 1;
        if (!updatesByStrategy.has(strategy)) updatesByStrategy.set(strategy, []);
        updatesByStrategy.get(strategy).push(eventId);
    }

    let updated = 0;
    for (const [strategy, ids] of updatesByStrategy.entries()) {
        if (!ids.length) continue;
        const chunkSize = 400;
        for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const placeholders = chunk.map(() => '?').join(',');
            await dbRunAsync(
                `UPDATE book_reco_events
                 SET strategy = ?
                 WHERE id IN (${placeholders})`,
                [strategy, ...chunk]
            );
            updated += chunk.length;
        }
    }
    return {
        scanned: targetEvents.length,
        updated,
        from_cache: fromCache,
        fallback_hot: fallbackHot
    };
}

async function saveRecoCacheForUser(userId, items = []) {
    const uid = Number(userId);
    if (!uid) return;
    await dbRunAsync(`DELETE FROM book_reco_cache WHERE user_id = ?`, [uid]);
    for (const item of items) {
        await dbRunAsync(
            `INSERT INTO book_reco_cache (user_id, book_id, score, reason, strategy, updated_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [uid, Number(item.id), Number(item.score || 0), String(item.reason || ''), String(item.strategy || 'hybrid')]
        );
    }
}

async function readRecoCacheForUser(userId, limit = 12, ttlSec = 120) {
    const uid = Number(userId);
    if (!uid) return [];
    const rows = await dbAllAsync(
        `SELECT b.id, b.title, b.author, b.category, b.description, b.cover_url, b.price, b.rating, b.created_at,
                c.score, c.reason, c.strategy, c.updated_at
         FROM book_reco_cache c
         JOIN books b ON b.id = c.book_id
         WHERE c.user_id = ?
           AND datetime(c.updated_at) >= datetime('now', ?)
         ORDER BY c.score DESC, b.id DESC
         LIMIT ?`,
        [uid, `-${Math.max(15, Number(ttlSec) || 120)} seconds`, Math.max(1, Number(limit) || 12)]
    );
    return rows || [];
}

async function refreshRecoCacheForActiveUsers(limitPerUser = 20, maxUsers = 100) {
    const rows = await dbAllAsync(
        `SELECT DISTINCT user_id
         FROM book_reco_events
         WHERE user_id IS NOT NULL
           AND datetime(created_at) >= datetime('now', '-30 day')
         ORDER BY user_id DESC
         LIMIT ?`,
        [Math.max(1, Number(maxUsers) || 100)]
    );
    for (const row of rows) {
        const uid = Number(row.user_id);
        if (!uid) continue;
        const items = await buildRecoScoresForUser(uid, Math.max(1, Number(limitPerUser) || 20), Date.now(), 0);
        await saveRecoCacheForUser(uid, items.slice(0, Math.max(1, Number(limitPerUser) || 20)));
    }
    return rows.length;
}

async function rebuildUserItemScoreSnapshot(days = 30) {
    const lookbackDays = Math.max(7, Math.min(90, Number(days) || 30));
    const nowMs = Date.now();
    const DAY_MS = 24 * 3600 * 1000;
    const scoreMap = new Map(); // key: userId|bookId -> score
    const rows = await dbAllAsync(
        `SELECT user_id, book_id, event_type, event_value, created_at
         FROM book_reco_events
         WHERE user_id IS NOT NULL
           AND datetime(created_at) >= datetime('now', ?)`,
        [`-${lookbackDays} day`]
    );
    const activeWeights = (getRecoSettings().weights || RECO_EVENT_WEIGHTS);
    for (const ev of rows) {
        const userId = Number(ev.user_id);
        const bookId = Number(ev.book_id);
        if (!userId || !bookId) continue;
        const w = Number(activeWeights[String(ev.event_type || '')] ?? 0);
        if (!Number.isFinite(w) || w === 0) continue;
        const value = Number(ev.event_value || 1);
        const createdMs = ev.created_at ? new Date(ev.created_at).getTime() : nowMs;
        const age = Math.max(0, nowMs - createdMs);
        const decay = Math.exp(-age / (30 * DAY_MS));
        const s = w * value * decay;
        const key = `${userId}|${bookId}`;
        scoreMap.set(key, (scoreMap.get(key) || 0) + s);
    }
    await dbRunAsync(`DELETE FROM user_item_score_snapshot`);
    for (const [key, score] of scoreMap.entries()) {
        const [uid, bid] = key.split('|').map((x) => Number(x));
        if (!uid || !bid) continue;
        await dbRunAsync(
            `INSERT INTO user_item_score_snapshot (user_id, book_id, score, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
            [uid, bid, Number(score) || 0]
        );
    }
    return scoreMap.size;
}

function tokenizeForReco(text) {
    const src = String(text || '').toLowerCase();
    const latinTokens = src.match(/[a-z0-9]+/g) || [];
    const zhChars = src.match(/[\u4e00-\u9fa5]/g) || [];
    const tokens = [...latinTokens, ...zhChars];
    return tokens.filter((t) => t && t.length > 0);
}

const VIDEO_TAG_SYNONYMS = {
    scifi: '科幻',
    'sciencefiction': '科幻',
    科學幻想: '科幻',
    sci: '科幻',
    ai: '人工智能',
    人工智能: '人工智能',
    machinelearning: '机器学习',
    ml: '机器学习',
    悬疑推理: '悬疑',
    推理: '悬疑',
    奇幻冒险: '奇幻',
    历史: '历史',
    历史传记: '历史',
    经济管理: '经济',
    金融: '经济',
    童话: '童话',
    治愈: '治愈'
};

function normalizeVideoTagToken(token) {
    const raw = String(token || '').trim().toLowerCase();
    if (!raw) return '';
    const compact = raw.replace(/\s+/g, '');
    const mapped = VIDEO_TAG_SYNONYMS[compact] || compact;
    return String(mapped).trim().toLowerCase();
}

function parseVideoTags(rawTags) {
    return String(rawTags || '')
        .split(/[，,|/、\s]+/)
        .map((t) => normalizeVideoTagToken(t))
        .filter(Boolean)
        .slice(0, 8);
}

function dotProduct(a, b) {
    let s = 0;
    for (const [k, v] of a.entries()) {
        s += v * (b.get(k) || 0);
    }
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

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function seededRandFrom(bookId, salt) {
    const b = Number(bookId) || 0;
    const s = Number(salt) || 0;
    let x = (b * 1103515245 + s * 12345 + 1013904223) >>> 0;
    x ^= (x << 13) >>> 0;
    x ^= (x >>> 17) >>> 0;
    x ^= (x << 5) >>> 0;
    return (x >>> 0) / 4294967295;
}

async function buildRecoScoresForUser(userId, limit = 20, salt = 0, focusBookId = 0) {
    const recoSettings = getRecoSettings();
    const activeWeights = recoSettings.weights || RECO_EVENT_WEIGHTS;
    const books = await dbAllAsync(
        `SELECT id, title, author, category, description, cover_url, price, rating, created_at
         FROM books`
    );
    if (!books.length) return [];
    const tagRows = await dbAllAsync(
        `SELECT book_id, video_tags, video_category, video_topic
         FROM user_videos
         WHERE book_id IS NOT NULL
           AND status = 'approved'
           AND (
                COALESCE(video_tags, '') <> ''
                OR COALESCE(video_category, '') <> ''
                OR COALESCE(video_topic, '') <> ''
           )`
    );
    const videoTagByBook = new Map();
    for (const row of tagRows) {
        const bid = Number(row.book_id);
        if (!bid) continue;
        const tags = [
            ...parseVideoTags(row.video_tags),
            ...parseVideoTags(row.video_category),
            ...parseVideoTags(row.video_topic)
        ];
        if (!tags.length) continue;
        if (!videoTagByBook.has(bid)) videoTagByBook.set(bid, new Set());
        const s = videoTagByBook.get(bid);
        tags.forEach((t) => s.add(t));
    }

    const nowMs = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
    const recentEvents = await dbAllAsync(
        `SELECT user_id, book_id, event_type, event_value, created_at
         FROM book_reco_events
         WHERE datetime(created_at) >= datetime('now', '-30 day')`
    );

    const bookTokenCounts = new Map();
    const docFreq = new Map();
    const N = books.length;
    for (const b of books) {
        const videoTagsText = Array.from(videoTagByBook.get(Number(b.id)) || []).join(' ');
        const text = `${b.title || ''} ${b.author || ''} ${b.category || ''} ${b.description || ''} ${videoTagsText}`;
        const tokens = tokenizeForReco(text);
        const tf = new Map();
        for (const tk of tokens) tf.set(tk, (tf.get(tk) || 0) + 1);
        bookTokenCounts.set(b.id, tf);
        const seen = new Set(tf.keys());
        for (const tk of seen) docFreq.set(tk, (docFreq.get(tk) || 0) + 1);
    }

    const bookVectors = new Map();
    for (const b of books) {
        const tf = bookTokenCounts.get(b.id) || new Map();
        const total = Math.max(1, Array.from(tf.values()).reduce((a, c) => a + c, 0));
        const vec = new Map();
        for (const [tk, c] of tf.entries()) {
            const tfNorm = c / total;
            const idf = Math.log((N + 1) / ((docFreq.get(tk) || 0) + 1)) + 1;
            vec.set(tk, tfNorm * idf);
        }
        bookVectors.set(b.id, vec);
    }

    const userBookScore = new Map();
    const hotScore = new Map();
    let snapshotMaxUpdatedAt = null;
    try {
        const snapshotRows = await dbAllAsync(
            `SELECT user_id, book_id, score, updated_at
             FROM user_item_score_snapshot`
        );
        for (const row of snapshotRows) {
            const uid = Number(row.user_id);
            const bid = Number(row.book_id);
            const s = Number(row.score || 0);
            if (!uid || !bid || !Number.isFinite(s)) continue;
            if (!userBookScore.has(uid)) userBookScore.set(uid, new Map());
            const m = userBookScore.get(uid);
            m.set(bid, (m.get(bid) || 0) + s);
            const upd = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
            if (Number.isFinite(upd)) {
                snapshotMaxUpdatedAt = snapshotMaxUpdatedAt == null ? upd : Math.max(snapshotMaxUpdatedAt, upd);
            }
        }
    } catch (e) {
        // 快照不可用时自动回退到事件实时计算
    }
    for (const ev of recentEvents) {
        const eventType = String(ev.event_type || '');
        const base = activeWeights[eventType] ?? 0;
        if (base === 0) continue;
        const value = Number(ev.event_value || 1);
        const createdMs = ev.created_at ? new Date(ev.created_at).getTime() : nowMs;
        const age = Math.max(0, nowMs - createdMs);
        const decay = Math.exp(-age / THIRTY_DAYS_MS);
        const weighted = base * value * decay;
        const bookId = Number(ev.book_id);
        hotScore.set(bookId, (hotScore.get(bookId) || 0) + weighted);
        const uid = Number(ev.user_id);
        if (!uid) continue;
        if (eventType === 'impression') continue;
        const isIncremental = snapshotMaxUpdatedAt != null && createdMs > snapshotMaxUpdatedAt;
        const hasSnapshot = snapshotMaxUpdatedAt != null;
        if (hasSnapshot && !isIncremental) continue;
        if (!userBookScore.has(uid)) userBookScore.set(uid, new Map());
        const m = userBookScore.get(uid);
        m.set(bookId, (m.get(bookId) || 0) + weighted);
    }
    const targetRecentEvents = recentEvents.filter((ev) => Number(ev.user_id) === Number(userId));
    const TEN_MIN_MS = 10 * 60 * 1000;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const recentStrongBook = new Set();
    const recentStrongScore = new Map();
    const eventBoostWeight = {
        click: 1.2,
        detail: 1.6,
        detail_view: 1.6,
        dwell: 2.2,
        favorite: 3.8,
        cart_add: 4.2,
        purchase: 6.0,
        comment: 2.8
    };
    for (const ev of targetRecentEvents) {
        const bid = Number(ev.book_id || 0);
        if (!bid) continue;
        const et = String(ev.event_type || '');
        if (!['click', 'detail', 'detail_view', 'dwell', 'favorite', 'cart_add', 'purchase', 'comment'].includes(et)) continue;
        const createdMs = ev.created_at ? new Date(ev.created_at).getTime() : nowMs;
        if (!Number.isFinite(createdMs)) continue;
        const age = Math.max(0, nowMs - createdMs);
        if (age <= TEN_MIN_MS) recentStrongBook.add(bid);
        if (age <= ONE_DAY_MS) {
            const decay = Math.exp(-age / (6 * 60 * 60 * 1000)); // 6h 半衰感知
            const val = Number(ev.event_value || 1);
            const boost = (eventBoostWeight[et] || 1) * val * decay;
            recentStrongScore.set(bid, (recentStrongScore.get(bid) || 0) + boost);
        }
    }
    // 兜底：若10分钟窗口没命中，用24小时内强互动Top2作为focus候选
    if (!recentStrongBook.size && recentStrongScore.size) {
        const top = Array.from(recentStrongScore.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);
        for (const [bid, score] of top) {
            if (score >= 2) recentStrongBook.add(Number(bid));
        }
    }
    const targetRecentEventCount = targetRecentEvents.length;
    const targetRecentDecayAvg = targetRecentEvents.length
        ? targetRecentEvents.reduce((acc, ev) => {
            const createdMs = ev.created_at ? new Date(ev.created_at).getTime() : nowMs;
            const age = Math.max(0, nowMs - createdMs);
            return acc + Math.exp(-age / THIRTY_DAYS_MS);
        }, 0) / targetRecentEvents.length
        : 0;

    const targetVector = userBookScore.get(Number(userId)) || new Map();
    const targetInteracted = new Set(targetVector.keys());
    const preferredTagSet = new Set();
    const authorByBook = new Map();
    const categoryByBook = new Map();
    for (const b of books) {
        authorByBook.set(Number(b.id), String(b.author || '').trim().toLowerCase());
        categoryByBook.set(Number(b.id), String(b.category || '').trim().toLowerCase());
    }
    for (const bid of targetInteracted) {
        const ts = videoTagByBook.get(Number(bid));
        if (!ts) continue;
        for (const t of ts) preferredTagSet.add(t);
    }

    // 知识图谱分：同作者/同分类/同标签（Jaccard）形成可解释关系增强
    const kgRawScore = new Map();
    const interactedList = Array.from(targetInteracted);
    for (const b of books) {
        const bid = Number(b.id);
        let best = 0;
        let bestReason = '';
        const bAuthor = authorByBook.get(bid) || '';
        const bCategory = categoryByBook.get(bid) || '';
        const bTags = new Set(videoTagByBook.get(bid) || []);
        for (const srcId of interactedList) {
            if (!srcId || srcId === bid) continue;
            let score = 0;
            const sAuthor = authorByBook.get(srcId) || '';
            const sCategory = categoryByBook.get(srcId) || '';
            const sTags = new Set(videoTagByBook.get(srcId) || []);
            if (bAuthor && sAuthor && bAuthor === sAuthor) score += 0.45;
            if (bCategory && sCategory && bCategory === sCategory) score += 0.2;
            if (bTags.size && sTags.size) {
                let inter = 0;
                for (const t of bTags) if (sTags.has(t)) inter++;
                const uni = bTags.size + sTags.size - inter;
                const jaccard = uni > 0 ? inter / uni : 0;
                score += 0.35 * jaccard;
            }
            if (score > best) {
                best = score;
                if (bAuthor && sAuthor && bAuthor === sAuthor) bestReason = `同作者：${b.author || '未知作者'}`;
                else if (bCategory && sCategory && bCategory === sCategory) bestReason = `同分类：${b.category || '未分类'}`;
                else bestReason = '知识图谱关系相似';
            }
        }
        kgRawScore.set(bid, { score: best, reason: bestReason });
    }

    // 内容推荐分（冷启动也可用）
    const userContentProfile = new Map();
    for (const [bookId, score] of targetVector.entries()) {
        const bv = bookVectors.get(bookId);
        if (!bv) continue;
        for (const [tk, w] of bv.entries()) {
            userContentProfile.set(tk, (userContentProfile.get(tk) || 0) + w * score);
        }
    }

    const contentScore = new Map();
    if (userContentProfile.size > 0) {
        for (const b of books) {
            if (targetInteracted.has(b.id)) continue;
            const sim = cosineMap(userContentProfile, bookVectors.get(b.id) || new Map());
            if (sim > 0) contentScore.set(b.id, sim);
        }
    }

    // User-CF 分（按阈值自动切换）
    const cfCfg = getEffectiveCfConfig(userId, recoSettings);
    const expVariant = cfCfg.expVariant;
    const cfMinInteractions = cfCfg.cf_min_interactions;
    const cfMinNeighbors = cfCfg.cf_min_neighbors;
    const cfSimilarity = cfCfg.cf_similarity;
    const neighborSims = [];
    if (targetVector.size >= cfMinInteractions) {
        for (const [uid, vec] of userBookScore.entries()) {
            if (uid === Number(userId)) continue;
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
    const kgVals = Array.from(kgRawScore.values()).map((x) => Number(x?.score || 0));
    const kgMin = kgVals.length ? Math.min(...kgVals) : 0;
    const kgMax = kgVals.length ? Math.max(...kgVals) : 1;

    function norm(v, mn, mx) {
        if (!isFinite(v)) return 0;
        if (Math.abs(mx - mn) < 1e-8) return v > 0 ? 1 : 0;
        return clamp01((v - mn) / (mx - mn));
    }

    const focusedBookId = Number(focusBookId) || 0;
    const focusedBook = books.find((b) => Number(b.id) === focusedBookId) || null;
    const items = [];
    for (const b of books) {
        const allowRecentReplay = recentStrongBook.has(Number(b.id));
        if (targetInteracted.has(b.id) && Number(b.id) !== focusedBookId && !allowRecentReplay) continue;
        const cf = cfEnabled ? norm(cfScore.get(b.id) || 0, cfMin, cfMax) : 0;
        const ct = norm(contentScore.get(b.id) || 0, ctMin, ctMax);
        const kgRaw = kgRawScore.get(Number(b.id)) || { score: 0, reason: '' };
        const kg = norm(kgRaw.score || 0, kgMin, kgMax);
        const hot = norm(hotScore.get(b.id) || 0, hotMin, hotMax);
        const freshDays = Math.max(0, (nowMs - new Date(b.created_at || nowMs).getTime()) / (24 * 3600 * 1000));
        const fresh = Math.exp(-freshDays / 45);
        let focusBoost = 0;
        const matchedTags = [];
        const curTags = Array.from(videoTagByBook.get(Number(b.id)) || []);
        if (preferredTagSet.size > 0 && curTags.length > 0) {
            for (const t of curTags) {
                if (preferredTagSet.has(t)) matchedTags.push(t);
                if (matchedTags.length >= 2) break;
            }
        }
        if (focusedBook && Number(b.id) !== focusedBookId) {
            if (String(b.category || '') === String(focusedBook.category || '')) focusBoost += 0.22;
            if (String(b.author || '') === String(focusedBook.author || '')) focusBoost += 0.12;
        }
        const replayBoost = allowRecentReplay ? 0.55 : 0;
        const finalScore = 0.33 * cf + 0.27 * ct + 0.15 * kg + 0.15 * hot + 0.1 * fresh + focusBoost + replayBoost;
        let reason = '热门推荐';
        let strategy = 'hot';
        if (cf >= ct && cf > 0.2) {
            reason = '与你兴趣相似用户喜欢';
            strategy = 'cf';
        } else if (kg > 0.35) {
            reason = kgRaw.reason || '知识图谱关系相似';
            strategy = 'content';
        } else if (ct > 0.2) {
            reason = '与你偏好内容相似';
            strategy = 'content';
        } else if (fresh > 0.8) {
            reason = '新书探索推荐';
            strategy = 'fresh';
        }
        if (strategy === 'content' && matchedTags.length > 0) {
            reason = `命中标签：${matchedTags.join('、')}`;
        }
        if (focusBoost >= 0.2 && strategy !== 'cf') {
            reason = `你刚互动过《${focusedBook.title || '相关图书'}》相关视频`;
            strategy = 'content';
        }
        if (allowRecentReplay) {
            reason = `你最近高频互动《${b.title || '该书'}》`;
            strategy = 'focus';
        }
        const neighborContribTopk = cfEnabled
            ? topNeighbors
                .map((nb) => {
                    const vec = userBookScore.get(nb.uid) || new Map();
                    const raw = Number(vec.get(b.id) || 0);
                    const contrib = nb.sim * raw;
                    if (!isFinite(contrib) || contrib <= 0) return null;
                    return { user_id: Number(nb.uid), similarity: Number(nb.sim.toFixed(4)), contribution: Number(contrib.toFixed(6)) };
                })
                .filter(Boolean)
                .sort((x, y) => y.contribution - x.contribution)
                .slice(0, 3)
            : [];
        const tagContribTopk = matchedTags
            .map((tag) => {
                const userW = Number(userContentProfile.get(tag) || 0);
                const bookW = Number((bookVectors.get(b.id) || new Map()).get(tag) || 0);
                const contribution = userW * bookW;
                return { tag, contribution: Number(contribution.toFixed(6)) };
            })
            .filter((x) => x.contribution > 0)
            .sort((x, y) => y.contribution - x.contribution)
            .slice(0, 3);
        items.push({
            ...b,
            score: finalScore,
            reason,
            strategy,
            score_breakdown: {
                cf: Number(cf.toFixed(6)),
                content: Number(ct.toFixed(6)),
                kg: Number(kg.toFixed(6)),
                hot: Number(hot.toFixed(6)),
                fresh: Number(fresh.toFixed(6)),
                focus: Number(focusBoost.toFixed(6))
            },
            neighbor_contrib_topk: neighborContribTopk,
            tag_contrib_topk: tagContribTopk,
            time_decay_summary: {
                recent_event_count: targetRecentEventCount,
                avg_decay: Number(targetRecentDecayAvg.toFixed(6))
            },
            experiment_variant: expVariant
        });
    }
    
    if (focusedBook) {
        const existingIdx = items.findIndex((it) => Number(it.id) === focusedBookId);
        const focusItem = {
            ...focusedBook,
            score: 999,
            reason: `你刚互动过《${focusedBook.title || '该图书'}》相关视频`,
            strategy: 'focus',
            score_breakdown: {
                cf: 0,
                content: 0,
                kg: 0,
                hot: 0,
                fresh: 0,
                focus: 999
            },
            neighbor_contrib_topk: [],
            tag_contrib_topk: [],
            time_decay_summary: {
                recent_event_count: targetRecentEventCount,
                avg_decay: Number(targetRecentDecayAvg.toFixed(6))
            },
            experiment_variant: expVariant
        };
        if (existingIdx >= 0) {
            items[existingIdx] = { ...items[existingIdx], ...focusItem };
        } else {
            items.push(focusItem);
        }
    }

    items.sort((a, b) => {
        const d = b.score - a.score;
        if (Math.abs(d) > 0.03) return d;
        return seededRandFrom(a.id, salt) - seededRandFrom(b.id, salt);
    });
    
    // 多样性重排：限制同类目占比、限制同作者重复、保留探索位
    const targetLimit = Math.max(1, limit);
    const maxPerCategory = Math.max(1, Math.floor(targetLimit * 0.4));
    const maxPerAuthor = 2;
    const minExploreSlots = Math.max(1, Math.floor(targetLimit * 0.2));
    
    const selected = [];
    const selectedIds = new Set();
    const catCount = new Map();
    const authorCount = new Map();
    
    function canPick(item, strictCategory) {
        const c = String(item.category || '其他');
        const a = String(item.author || '未知作者');
        const cc = catCount.get(c) || 0;
        const ac = authorCount.get(a) || 0;
        if (ac >= maxPerAuthor) return false;
        if (strictCategory && cc >= maxPerCategory) return false;
        return true;
    }
    
    function pickItem(item) {
        selected.push(item);
        selectedIds.add(item.id);
        const c = String(item.category || '其他');
        const a = String(item.author || '未知作者');
        catCount.set(c, (catCount.get(c) || 0) + 1);
        authorCount.set(a, (authorCount.get(a) || 0) + 1);
    }

    // 优先钉住最近高频互动图书（例如你在图书商店反复点击/停留的书）
    // 避免它们在多样性重排阶段被作者/类目约束再次挤掉。
    const recentFocusCandidates = items
        .filter((it) => recentStrongBook.has(Number(it.id)))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(2, targetLimit));
    for (const it of recentFocusCandidates) {
        if (selected.length >= targetLimit) break;
        if (selectedIds.has(it.id)) continue;
        pickItem({
            ...it,
            reason: `你最近高频互动《${it.title || '该图书'}》`,
            strategy: 'focus',
            score: Math.max(Number(it.score || 0), 999)
        });
    }
    
    // 第一轮：按高分选，严格限制类目上限
    for (const item of items) {
        if (selected.length >= targetLimit) break;
        if (selectedIds.has(item.id)) continue;
        if (!canPick(item, true)) continue;
        pickItem(item);
    }
    
    // 第二轮：补探索位（优先非内容匹配策略）
    if (selected.length < targetLimit) {
        const exploreCandidates = items
            .filter((it) => !selectedIds.has(it.id) && it.strategy !== 'content')
            .sort((a, b) => seededRandFrom(a.id, salt + 17) - seededRandFrom(b.id, salt + 17));
        for (const item of exploreCandidates) {
            if (selected.length >= targetLimit) break;
            if (!canPick(item, false)) continue;
            pickItem(item);
            if (selected.length >= minExploreSlots) {
                // 仅确保有探索位，不强制全部探索
                break;
            }
        }
    }
    
    // 第三轮：放宽类目限制补齐
    if (selected.length < targetLimit) {
        for (const item of items) {
            if (selected.length >= targetLimit) break;
            if (selectedIds.has(item.id)) continue;
            if (!canPick(item, false)) continue;
            pickItem(item);
        }
    }
    
    // 若候选仍不足，用热门补齐
    if (selected.length < targetLimit) {
        const hotBooks = [...books]
            .map((b) => ({ ...b, h: norm(hotScore.get(b.id) || 0, hotMin, hotMax) }))
            .sort((a, b) => b.h - a.h);
        for (const hb of hotBooks) {
            if (selected.length >= targetLimit) break;
            if (selectedIds.has(hb.id)) continue;
            const patched = {
                ...hb,
                score: hb.h,
                reason: '热门推荐',
                strategy: 'hot'
            };
            if (!canPick(patched, false)) continue;
            pickItem(patched);
        }
    }
    
    // 最终兜底：确保最近高频互动图书优先可见（最多前3位）
    const finalBase = selected.slice(0, targetLimit);
    const pinnedRecentTop = items
        .filter((it) => recentStrongBook.has(Number(it.id)))
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, Math.min(3, targetLimit))
        .map((it, idx) => ({
            ...it,
            score: Math.max(Number(it.score || 0), 1200 - idx),
            reason: `你最近高频互动《${it.title || '该图书'}》`,
            strategy: 'focus',
            score_breakdown: {
                ...(it.score_breakdown || {}),
                kg: Number((it.score_breakdown || {}).kg || 0),
                focus: Math.max(Number(it?.score_breakdown?.focus || 0), 1)
            }
        }));

    if (!pinnedRecentTop.length) {
        return finalBase;
    }

    const merged = [];
    const seen = new Set();
    for (const it of pinnedRecentTop) {
        if (merged.length >= targetLimit) break;
        const bid = Number(it.id);
        if (!bid || seen.has(bid)) continue;
        seen.add(bid);
        merged.push(it);
    }
    for (const it of finalBase) {
        if (merged.length >= targetLimit) break;
        const bid = Number(it.id);
        if (!bid || seen.has(bid)) continue;
        seen.add(bid);
        merged.push(it);
    }

    return merged.slice(0, targetLimit);
}

async function buildRecoVideosForUser(userId, limit = 12, salt = 0) {
    const rows = await dbAllAsync(
        `SELECT uv.id, uv.user_id, uv.video_url, uv.video_name, uv.book_name, uv.book_id,
                uv.video_tags, uv.video_category, uv.video_topic, uv.created_at,
                (SELECT COUNT(*) FROM video_likes vl WHERE vl.video_id = uv.id) AS likes_count,
                (SELECT COUNT(*) FROM video_collections vc WHERE vc.video_id = uv.id) AS collections_count,
                (SELECT COUNT(*) FROM video_views vv WHERE vv.video_id = uv.id) AS views_count
         FROM user_videos uv
         WHERE uv.status = 'approved'
           AND (uv.is_banned IS NULL OR uv.is_banned = 0)
         ORDER BY uv.created_at DESC`
    );
    if (!rows.length) return [];
    const nowMs = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;
    const activeWeights = getRecoSettings().weights || RECO_EVENT_WEIGHTS;
    const videos = rows.map((v) => ({ ...v, id: Number(v.id) }));

    const videoTagSet = new Map();
    const bookTagSet = new Map();
    for (const v of videos) {
        const tags = [
            ...parseVideoTags(v.video_tags),
            ...parseVideoTags(v.video_category),
            ...parseVideoTags(v.video_topic)
        ];
        const set = new Set(tags);
        videoTagSet.set(v.id, set);
        const bid = Number(v.book_id || 0);
        if (bid > 0) {
            if (!bookTagSet.has(bid)) bookTagSet.set(bid, new Set());
            const bs = bookTagSet.get(bid);
            set.forEach((t) => bs.add(t));
        }
    }

    const tokenDf = new Map();
    const videoVecRaw = new Map();
    const N = videos.length;
    for (const v of videos) {
        const text = `${v.video_name || ''} ${v.book_name || ''} ${v.video_tags || ''} ${v.video_category || ''} ${v.video_topic || ''}`;
        const tokens = tokenizeForReco(text);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        videoVecRaw.set(v.id, tf);
        const uniq = new Set(tf.keys());
        uniq.forEach((t) => tokenDf.set(t, (tokenDf.get(t) || 0) + 1));
    }
    const videoVec = new Map();
    for (const v of videos) {
        const tf = videoVecRaw.get(v.id) || new Map();
        const total = Math.max(1, Array.from(tf.values()).reduce((a, c) => a + c, 0));
        const vec = new Map();
        for (const [t, c] of tf.entries()) {
            const tfNorm = c / total;
            const idf = Math.log((N + 1) / ((tokenDf.get(t) || 0) + 1)) + 1;
            vec.set(t, tfNorm * idf);
        }
        videoVec.set(v.id, vec);
    }

    const evRows = await dbAllAsync(
        `SELECT book_id, event_type, event_value, created_at
         FROM book_reco_events
         WHERE user_id = ?
           AND datetime(created_at) >= datetime('now', '-30 day')`,
        [Number(userId)]
    );
    // 直接视频行为：用于修复“book_id 为空的视频永远得分上不去”的问题
    const [likeRows, collectRows, viewRows, commentRows] = await Promise.all([
        dbAllAsync(
            `SELECT video_id, created_at
             FROM video_likes
             WHERE user_id = ?
               AND datetime(created_at) >= datetime('now', '-30 day')`,
            [Number(userId)]
        ),
        dbAllAsync(
            `SELECT video_id, created_at
             FROM video_collections
             WHERE user_id = ?
               AND datetime(created_at) >= datetime('now', '-30 day')`,
            [Number(userId)]
        ),
        dbAllAsync(
            `SELECT video_id, viewed_at AS created_at
             FROM video_views
             WHERE user_id = ?
               AND datetime(viewed_at) >= datetime('now', '-30 day')`,
            [Number(userId)]
        ),
        dbAllAsync(
            `SELECT video_id, created_at
             FROM video_comments
             WHERE user_id = ?
               AND datetime(created_at) >= datetime('now', '-30 day')`,
            [Number(userId)]
        )
    ]);
    const userProfile = new Map();
    const bookBehavior = new Map();
    const videoBehaviorRaw = new Map();
    const addVideoBehavior = (videoId, createdAt, baseWeight) => {
        const vid = Number(videoId || 0);
        if (!vid) return;
        const createdMs = createdAt ? new Date(createdAt).getTime() : nowMs;
        const age = Math.max(0, nowMs - createdMs);
        const decay = Math.exp(-age / THIRTY_DAYS_MS);
        const score = baseWeight * decay;
        videoBehaviorRaw.set(vid, (videoBehaviorRaw.get(vid) || 0) + score);
    };
    (likeRows || []).forEach((r) => addVideoBehavior(r.video_id, r.created_at, 3.0));
    (collectRows || []).forEach((r) => addVideoBehavior(r.video_id, r.created_at, 3.8));
    (viewRows || []).forEach((r) => addVideoBehavior(r.video_id, r.created_at, 1.2));
    (commentRows || []).forEach((r) => addVideoBehavior(r.video_id, r.created_at, 2.6));
    const interactedBookIds = new Set();
    for (const ev of evRows) {
        const bid = Number(ev.book_id || 0);
        if (!bid) continue;
        interactedBookIds.add(bid);
        const base = Number(activeWeights[String(ev.event_type || '')] ?? 0);
        if (!base) continue;
        const value = Number(ev.event_value || 1);
        const createdMs = ev.created_at ? new Date(ev.created_at).getTime() : nowMs;
        const age = Math.max(0, nowMs - createdMs);
        const decay = Math.exp(-age / THIRTY_DAYS_MS);
        const s = base * value * decay;
        bookBehavior.set(bid, (bookBehavior.get(bid) || 0) + s);
        const tags = bookTagSet.get(bid) || new Set();
        for (const t of tags) userProfile.set(t, (userProfile.get(t) || 0) + s);
    }

    const hotRaw = new Map();
    for (const v of videos) {
        const hot = Number(v.likes_count || 0) * 1.5 + Number(v.collections_count || 0) * 1.8 + Number(v.views_count || 0) * 0.2;
        hotRaw.set(v.id, hot);
    }
    const hotVals = Array.from(hotRaw.values());
    const hotMin = hotVals.length ? Math.min(...hotVals) : 0;
    const hotMax = hotVals.length ? Math.max(...hotVals) : 1;
    const norm = (x, mn, mx) => Math.abs(mx - mn) < 1e-8 ? (x > 0 ? 1 : 0) : clamp01((x - mn) / (mx - mn));
    const behaviorRawByVideo = new Map();
    for (const v of videos) {
        const bid = Number(v.book_id || 0);
        behaviorRawByVideo.set(v.id, bid > 0 ? Number(bookBehavior.get(bid) || 0) : 0);
    }
    const behaviorVals = Array.from(behaviorRawByVideo.values());
    const behaviorMin = behaviorVals.length ? Math.min(...behaviorVals) : 0;
    const behaviorMax = behaviorVals.length ? Math.max(...behaviorVals) : 1;
    const videoBehaviorVals = Array.from(videoBehaviorRaw.values());
    const videoBehaviorMin = videoBehaviorVals.length ? Math.min(...videoBehaviorVals) : 0;
    const videoBehaviorMax = videoBehaviorVals.length ? Math.max(...videoBehaviorVals) : 1;

    const preferredTagSet = new Set(Array.from(userProfile.keys()));
    const ranked = videos.map((v) => {
        const content = userProfile.size > 0 ? cosineMap(userProfile, videoVec.get(v.id) || new Map()) : 0;
        const behavior = norm(behaviorRawByVideo.get(v.id) || 0, behaviorMin, behaviorMax);
        const directVideoBehavior = norm(videoBehaviorRaw.get(v.id) || 0, videoBehaviorMin, videoBehaviorMax);
        const hot = norm(hotRaw.get(v.id) || 0, hotMin, hotMax);
        const freshDays = Math.max(0, (nowMs - new Date(v.created_at || nowMs).getTime()) / (24 * 3600 * 1000));
        const fresh = Math.exp(-freshDays / 35);
        // 行为信号优先：即便视频没打标签，也能根据你最近看过/点赞/收藏对应图书的视频提升分数
        const score = 0.28 * content + 0.27 * behavior + 0.32 * directVideoBehavior + 0.10 * hot + 0.03 * fresh;
        const matchedTags = Array.from(videoTagSet.get(v.id) || []).filter((t) => preferredTagSet.has(t)).slice(0, 2);
        const reason = directVideoBehavior > 0.2
            ? '你最近互动过该视频'
            : (behavior > 0.2
            ? '你最近互动过相关图书视频'
            : (matchedTags.length
                ? `命中标签：${matchedTags.join('、')}`
                : (content > 0.2 ? '与你偏好内容相似' : '热门视频推荐')));
        const strategy = (directVideoBehavior > 0.2 || behavior > 0.2 || matchedTags.length || content > 0.2) ? 'content' : 'hot';
        return { ...v, score, reason, strategy, matched_tags: matchedTags };
    });

    ranked.sort((a, b) => {
        const d = b.score - a.score;
        if (Math.abs(d) > 0.02) return d;
        return seededRandFrom(a.id, salt) - seededRandFrom(b.id, salt);
    });

    return ranked.slice(0, Math.max(1, Number(limit) || 12));
}

// 推荐服务边界（微服务第一步）：在单体内先进行层次拆分
const recoDataLayer = {
    loadBooks: () => dbAllAsync(
        `SELECT id, title, author, category, description, cover_url, price, rating, created_at
         FROM books`
    ),
    loadRecentEvents: (days = 30) => dbAllAsync(
        `SELECT user_id, book_id, event_type, event_value, created_at
         FROM book_reco_events
         WHERE datetime(created_at) >= datetime('now', ?)`,
        [`-${Math.max(1, Number(days) || 30)} day`]
    ),
    loadVideoTagRows: () => dbAllAsync(
        `SELECT book_id, video_tags
         FROM user_videos
         WHERE book_id IS NOT NULL
           AND status = 'approved'
           AND COALESCE(video_tags, '') <> ''`
    )
};

const recoFeatureLayer = {
    tokenize: tokenizeForReco,
    normalizeTags: parseVideoTags,
    cosine: cosineMap
};

const recoRankLayer = {
    rankForUser: (userId, limit, salt, focusBookId) => buildRecoScoresForUser(userId, limit, salt, focusBookId)
};

const recoCacheLayer = {
    read: (userId, limit, ttlSec) => readRecoCacheForUser(userId, limit, ttlSec),
    save: (userId, items) => saveRecoCacheForUser(userId, items),
    refreshActive: (limitPerUser, maxUsers) => refreshRecoCacheForActiveUsers(limitPerUser, maxUsers),
    rebuildSnapshot: (days) => rebuildUserItemScoreSnapshot(days)
};

const kgNeo4jService = new KgNeo4jService();
let kgGraphSyncRunning = false;

async function buildAndSyncKgGraphData() {
    if (!kgNeo4jService.isReady() || kgGraphSyncRunning) return { books: 0, events: 0 };
    kgGraphSyncRunning = true;
    try {
        const [books, videoTagRows, eventRows] = await Promise.all([
            dbAllAsync(`SELECT id, title, author, category FROM books`),
            dbAllAsync(
                `SELECT book_id, video_tags, video_category, video_topic
                 FROM user_videos
                 WHERE book_id IS NOT NULL
                   AND status = 'approved'`
            ),
            dbAllAsync(
                `SELECT user_id, book_id, event_type, event_value, created_at
                 FROM book_reco_events
                 WHERE datetime(created_at) >= datetime('now', '-30 day')`
            )
        ]);

        const tagMap = new Map();
        for (const row of videoTagRows) {
            const bid = Number(row.book_id || 0);
            if (!bid) continue;
            const tags = new Set(tagMap.get(bid) || []);
            const merged = [row.video_tags, row.video_category, row.video_topic]
                .flatMap((x) => parseVideoTags(x));
            for (const t of merged) tags.add(t);
            tagMap.set(bid, tags);
        }

        const eventWeightMap = {
            impression: 0.03,
            click: 1.2,
            detail: 1.5,
            detail_view: 1.5,
            dwell: 2.0,
            favorite: 4.0,
            cart_add: 4.5,
            purchase: 6.0,
            comment: 3.0,
            report: -6.0
        };
        const weightedEvents = eventRows.map((x) => {
            const ev = String(x.event_type || '').trim().toLowerCase();
            const base = Number(eventWeightMap[ev] || 0);
            return {
                user_id: Number(x.user_id),
                book_id: Number(x.book_id),
                created_at: String(x.created_at || new Date().toISOString()),
                weight: base * (Number(x.event_value) || 1)
            };
        }).filter((x) => x.user_id > 0 && x.book_id > 0 && x.weight !== 0);

        const bookCnt = await kgNeo4jService.upsertBooks(books, tagMap);
        const eventCnt = await kgNeo4jService.upsertInteractions(weightedEvents);
        return { books: bookCnt, events: eventCnt };
    } catch (error) {
        console.warn('Neo4j图谱同步失败:', error.message);
        return { books: 0, events: 0 };
    } finally {
        kgGraphSyncRunning = false;
    }
}

function toNeo4jRecoEventWeight(eventType, eventValue) {
    const ev = String(eventType || '').trim().toLowerCase();
    const base = Number(RECO_EVENT_WEIGHTS[ev] || 0);
    const val = Number(eventValue) || 1;
    return base * val;
}

async function syncNeo4jInteractionsIncremental(rows = []) {
    if (!kgNeo4jService.isReady() || !Array.isArray(rows) || !rows.length) return 0;
    const payload = rows
        .map((x) => ({
            user_id: Number(x.user_id),
            book_id: Number(x.book_id),
            created_at: String(x.created_at || new Date().toISOString()),
            weight: toNeo4jRecoEventWeight(x.event_type, x.event_value)
        }))
        .filter((x) => x.user_id > 0 && x.book_id > 0 && x.weight !== 0);
    if (!payload.length) return 0;
    try {
        return await kgNeo4jService.upsertInteractions(payload);
    } catch (error) {
        console.warn('Neo4j增量行为同步失败:', error.message);
        return 0;
    }
}

async function applyNeo4jKgBoost(userId, items = []) {
    if (!kgNeo4jService.isReady() || !Array.isArray(items) || !items.length) return items;
    try {
        const kgMap = await kgNeo4jService.computeKgScores(userId, items.map((x) => Number(x.id)));
        if (!kgMap.size) return items;
        for (const it of items) {
            const info = kgMap.get(Number(it.id));
            if (!info || !Number.isFinite(info.score)) continue;
            const graphKg = Math.max(0, Math.min(1, Number(info.score) || 0));
            const oldBreakdown = it.score_breakdown || {};
            const oldKg = Math.max(0, Number(oldBreakdown.kg || 0));
            const mergedKg = Math.max(oldKg, graphKg);
            const oldScore = Number(it.score || 0);
            const newScore = oldScore - oldKg * 0.15 + mergedKg * 0.15;
            it.score = Number.isFinite(newScore) ? newScore : oldScore;
            it.score_breakdown = {
                cf: 0,
                content: 0,
                kg: mergedKg,
                kg_graph: graphKg,
                hot: 0,
                fresh: 0,
                focus: 0,
                ...oldBreakdown,
                kg: mergedKg,
                kg_graph: graphKg
            };
            if ((!it.reason || /热门|新书/.test(String(it.reason))) && info.reason) {
                it.reason = `知识图谱关联：${info.reason}`;
            }
        }
        items.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    } catch (error) {
        console.warn('Neo4j KG打分失败，回退本地KG:', error.message);
    }
    return items;
}

const recoService = {
    data: recoDataLayer,
    feature: recoFeatureLayer,
    rank: recoRankLayer,
    cache: recoCacheLayer,
    async recommend({ userId, limit = 12, scene = 'book_square', salt = Date.now(), focusBookId = 0, forceRefresh = false }) {
        const cfg = getRecoSettings();
        if (!cfg.enabled) {
            const fallback = await this.data.loadBooks();
            return {
                disabled: true,
                scene,
                items: fallback
                    .sort((a, b) => Number(b.id) - Number(a.id))
                    .slice(0, limit)
                    .map((it) => ({
                        ...it,
                        score: 0,
                        reason: '推荐已关闭，展示默认新书',
                        strategy: 'fresh'
                    }))
            };
        }
        let items = [];
        if (cfg.cache_enabled && !focusBookId && !forceRefresh) {
            const cached = await this.cache.read(userId, limit, cfg.cache_ttl_sec);
            if (cached.length >= Math.min(3, limit)) items = cached;
        }
        if (!items.length) {
            items = await this.rank.rankForUser(userId, limit, salt, focusBookId);
            if (cfg.cache_enabled && !focusBookId) {
                await this.cache.save(userId, items.slice(0, Math.max(limit, 20)));
            }
        }
        items = await applyNeo4jKgBoost(userId, items);
        return { disabled: false, scene, items };
    }
};

// 推荐行为上报
app.post('/api/reco/event', authenticateToken, async (req, res) => {
    try {
        const { book_id, event_type, event_value = 1, scene = 'book_square', session_id = '', strategy = '' } = req.body || {};
        const bookId = Number(book_id);
        const eventType = String(event_type || '').trim();
        if (!bookId || !eventType) {
            return res.status(400).json({ success: false, message: '请提供 book_id 与 event_type' });
        }
        const authHeader = String(req.headers.authorization || '');
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        const gatewayCfg = getRecoSettings();
        if (shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) && token) {
            try {
                const data = await forwardToRecoService(
                    '/internal/reco/event',
                    'POST',
                    token,
                    {},
                    {
                        book_id: bookId,
                        event_type: eventType,
                        event_value: Number(event_value) || 1,
                        scene: String(scene || 'book_square'),
                        session_id: String(session_id || ''),
                        strategy: String(strategy || '')
                    }
                );
                if (data && data.success) {
                    markRecoGatewayRoute('routed');
                    return res.status(200).json({ success: true, via: 'reco-service' });
                }
            } catch (proxyError) {
                markRecoGatewayRoute('proxy_error');
                console.warn('reco/event proxy fallback:', proxyError.message);
            }
        }
        markRecoGatewayRoute(shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) ? 'fallback' : 'local');
        await recordRecoEvent(
            req.user.id,
            bookId,
            eventType,
            Number(event_value) || 1,
            String(scene || 'book_square'),
            String(session_id || ''),
            strategy
        );
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('reco/event:', error);
        res.status(500).json({ success: false, message: '上报推荐事件失败' });
    }
});

// 视频行为映射到图书推荐行为（图书广场）
app.post('/api/reco/video-event', authenticateToken, async (req, res) => {
    try {
        const { video_id, event_type, event_value = 1, scene = 'book_square_video', session_id = '', strategy = '' } = req.body || {};
        const videoId = Number(video_id);
        const eventType = String(event_type || '').trim();
        if (!videoId || !eventType) {
            return res.status(400).json({ success: false, message: '请提供 video_id 与 event_type' });
        }
        const gatewayCfg = getRecoSettings();
        const authHeader = String(req.headers.authorization || '');
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) && token) {
            try {
                const data = await forwardToRecoService(
                    '/internal/reco/video-event',
                    'POST',
                    token,
                    {},
                    {
                        video_id: videoId,
                        event_type: eventType,
                        event_value: Number(event_value) || 1,
                        scene: String(scene || 'book_square_video'),
                        session_id: String(session_id || ''),
                        strategy: String(strategy || '')
                    }
                );
                if (data && data.success) {
                    markRecoGatewayRoute('routed');
                    return res.status(200).json({ ...data, via: 'reco-service' });
                }
            } catch (proxyError) {
                markRecoGatewayRoute('proxy_error');
                console.warn('reco/video-event proxy fallback:', proxyError.message);
            }
        }
        markRecoGatewayRoute(shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) ? 'fallback' : 'local');
        
        const videoRows = await dbAllAsync(
            `SELECT id, book_id, book_name, video_name FROM user_videos WHERE id = ? LIMIT 1`,
            [videoId]
        );
        const video = videoRows[0];
        if (!video) {
            return res.status(404).json({ success: false, message: '视频不存在' });
        }
        const directBookId = Number(video.book_id || 0);
        if (directBookId > 0) {
            await recordRecoEvent(req.user.id, directBookId, eventType, Number(event_value) || 1, String(scene || 'book_square_video'), String(session_id || ''), strategy);
            return res.status(200).json({ success: true, mapped: true, direct: true, book_id: directBookId });
        }
        
        const bookName = String(video.book_name || '').trim();
        const videoName = String(video.video_name || '').trim();
        const candidates = await dbAllAsync(
            `SELECT id, title
             FROM books
             WHERE title = ?
                OR title = ?
                OR title LIKE ?
                OR title LIKE ?
             LIMIT 20`,
            [bookName, videoName, `%${bookName}%`, `%${videoName}%`]
        );
        const isGenericVideoName = (s) => {
            const t = String(s || '').trim().toLowerCase();
            if (!t) return true;
            if (t === '本地视频' || t === 'local video') return true;
            if (/^[0-9a-f-]{20,}\.mp4$/.test(t)) return true;
            return false;
        };
        if (!candidates.length || (isGenericVideoName(bookName) && isGenericVideoName(videoName))) {
            // 兜底：如果视频元数据无法映射到书名，仍然给用户注入一个弱行为信号，避免“看视频完全无变化”
            const fallbackRows = await dbAllAsync(
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
                 LIMIT 20`
            );
            if (!fallbackRows.length) {
                return res.status(200).json({ success: true, mapped: false, message: '暂无可用图书用于映射' });
            }
            const pickIdx = Math.abs((Number(req.user.id) * 131 + videoId * 17) % fallbackRows.length);
            const fallbackBookId = Number(fallbackRows[pickIdx].id);
            await recordRecoEvent(req.user.id, fallbackBookId, eventType, Math.max(0.2, Number(event_value) || 1) * 0.35, 'book_square_video_fallback', String(session_id || ''), strategy);
            return res.status(200).json({ success: true, mapped: false, fallback: true, book_id: fallbackBookId });
        }
        
        const normalized = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
        const bn = normalized(bookName);
        const vn = normalized(videoName);
        candidates.sort((a, b) => {
            const at = normalized(a.title);
            const bt = normalized(b.title);
            const aScore = (at === bn ? 4 : 0) + (at === vn ? 3 : 0) + (bn && at.includes(bn) ? 2 : 0) + (vn && at.includes(vn) ? 1 : 0);
            const bScore = (bt === bn ? 4 : 0) + (bt === vn ? 3 : 0) + (bn && bt.includes(bn) ? 2 : 0) + (vn && bt.includes(vn) ? 1 : 0);
            return bScore - aScore;
        });
        const bestBookId = Number(candidates[0].id);
        
        await recordRecoEvent(req.user.id, bestBookId, eventType, Number(event_value) || 1, String(scene || 'book_square_video'), String(session_id || ''), strategy);
        
        res.status(200).json({ success: true, mapped: true, book_id: bestBookId });
    } catch (error) {
        console.error('reco/video-event:', error);
        res.status(500).json({ success: false, message: '视频推荐事件上报失败' });
    }
});

// 图书广场智能推荐
app.get('/api/reco/books', authenticateToken, async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
        const scene = String(req.query.scene || 'book_square');
        const salt = Number(req.query.salt) || Date.now();
        const focusBookId = Number(req.query.focus_book_id) || 0;
        const forceRefresh = !!Number(req.query.salt || 0);
        const authHeader = String(req.headers.authorization || '');
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        const gatewayCfg = getRecoSettings();
        if (shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) && token) {
            try {
                const cfg = getRecoSettings();
                const cfCfg = getEffectiveCfConfig(req.user.id, cfg);
                const proxyData = await forwardToRecoService(
                    '/internal/reco/books',
                    'GET',
                    token,
                    {
                        limit,
                        ttl_sec: Number(cfg.cache_ttl_sec || 120),
                        cf_min_interactions: cfCfg.cf_min_interactions,
                        cf_min_neighbors: cfCfg.cf_min_neighbors,
                        cf_similarity: cfCfg.cf_similarity
                    },
                    null
                );
                if (proxyData && proxyData.success && Array.isArray(proxyData.recommendations)) {
                    markRecoGatewayRoute('routed');
                    return res.status(200).json({
                        success: true,
                        scene,
                        disabled: false,
                        via: 'reco-service',
                        recommendations: proxyData.recommendations.map((it) => ({
                            id: it.id,
                            title: it.title,
                            author: it.author,
                            category: it.category,
                            description: it.description,
                            cover_url: it.cover_url,
                            price: it.price,
                            rating: it.rating,
                            score: Number(Number(it.score || 0).toFixed(6)),
                            reason: it.reason || '为你推荐',
                            strategy: it.strategy || 'hybrid',
                            score_breakdown: it.score_breakdown || { cf: 0, content: 0, kg: 0, kg_graph: 0, hot: 0, fresh: 0, focus: 0 },
                            neighbor_contrib_topk: it.neighbor_contrib_topk || [],
                            tag_contrib_topk: it.tag_contrib_topk || [],
                            time_decay_summary: it.time_decay_summary || { recent_event_count: 0, avg_decay: 0 },
                            experiment_variant: it.experiment_variant || 'A'
                        }))
                    });
                }
            } catch (proxyError) {
                markRecoGatewayRoute('proxy_error');
                console.warn('reco/books proxy fallback:', proxyError.message);
            }
        }
        markRecoGatewayRoute(shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) ? 'fallback' : 'local');
        const userId = Number(req.user.id);
        const reco = await recoService.recommend({ userId, limit, scene, salt, focusBookId, forceRefresh });
        const items = reco.items || [];
        res.status(200).json({
            success: true,
            scene,
            disabled: !!reco.disabled,
            recommendations: items.map((it) => ({
                id: it.id,
                title: it.title,
                author: it.author,
                category: it.category,
                description: it.description,
                cover_url: it.cover_url,
                price: it.price,
                rating: it.rating,
                score: Number(it.score.toFixed(6)),
                reason: it.reason,
                strategy: it.strategy,
                score_breakdown: it.score_breakdown || { cf: 0, content: 0, kg: 0, kg_graph: 0, hot: 0, fresh: 0, focus: 0 },
                neighbor_contrib_topk: it.neighbor_contrib_topk || [],
                tag_contrib_topk: it.tag_contrib_topk || [],
                time_decay_summary: it.time_decay_summary || { recent_event_count: 0, avg_decay: 0 },
                experiment_variant: it.experiment_variant || 'A'
            }))
        });
    } catch (error) {
        console.error('reco/books:', error);
        res.status(500).json({ success: false, message: '获取推荐失败' });
    }
});

// 用户兴趣画像（推荐可解释辅助）
app.get('/api/reco/interest-profile', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const days = Math.max(7, Math.min(180, Number(req.query.days) || 90));
        const rows = await dbAllAsync(
            `SELECT e.book_id, e.event_type, e.event_value, e.created_at, e.strategy,
                    b.author, b.category,
                    uv.video_tags, uv.video_category, uv.video_topic
             FROM book_reco_events e
             LEFT JOIN books b ON b.id = e.book_id
             LEFT JOIN user_videos uv ON uv.book_id = e.book_id AND uv.status = 'approved'
             WHERE e.user_id = ?
               AND datetime(e.created_at) >= datetime('now', ?)
             ORDER BY e.created_at DESC
             LIMIT 5000`,
            [userId, `-${days} day`]
        );
        const authorScore = new Map();
        const categoryScore = new Map();
        const tagScore = new Map();
        const strategyCnt = new Map();

        for (const r of rows) {
            const ev = String(r.event_type || '').trim().toLowerCase();
            const w = (Number(RECO_EVENT_WEIGHTS[ev] || 0) || 0) * (Number(r.event_value) || 1);
            if (w === 0) continue;
            const author = String(r.author || '').trim();
            const category = String(r.category || '').trim();
            if (author) authorScore.set(author, (authorScore.get(author) || 0) + w);
            if (category) categoryScore.set(category, (categoryScore.get(category) || 0) + w);
            const tags = [
                ...parseVideoTags(r.video_tags),
                ...parseVideoTags(r.video_category),
                ...parseVideoTags(r.video_topic)
            ];
            for (const t of tags) {
                if (!t) continue;
                tagScore.set(t, (tagScore.get(t) || 0) + w);
            }
            const s = String(r.strategy || '').trim().toLowerCase();
            if (s) strategyCnt.set(s, (strategyCnt.get(s) || 0) + 1);
        }

        const topN = (mp, n = 8) =>
            Array.from(mp.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, n)
                .map(([name, score]) => ({ name, score: Number(Number(score || 0).toFixed(3)) }));

        const totalSignals = rows.reduce((acc, r) => {
            const ev = String(r.event_type || '').trim().toLowerCase();
            const w = (Number(RECO_EVENT_WEIGHTS[ev] || 0) || 0) * (Number(r.event_value) || 1);
            return acc + (Number.isFinite(w) ? Math.max(0, w) : 0);
        }, 0);

        res.status(200).json({
            success: true,
            profile: {
                lookback_days: days,
                event_rows: rows.length,
                signal_score: Number(totalSignals.toFixed(3)),
                top_authors: topN(authorScore, 6),
                top_categories: topN(categoryScore, 6),
                top_tags: topN(tagScore, 10),
                strategy_mix: Array.from(strategyCnt.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([strategy, count]) => ({ strategy, count }))
            }
        });
    } catch (error) {
        console.error('reco/interest-profile:', error);
        res.status(500).json({ success: false, message: '获取兴趣画像失败' });
    }
});

// 图书广场智能推荐（视频 Top-N）
app.get('/api/reco/videos', authenticateToken, async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
        const scene = String(req.query.scene || 'book_square_video');
        const salt = Number(req.query.salt) || Date.now();
        const gatewayCfg = getRecoSettings();
        const authHeader = String(req.headers.authorization || '');
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) && token) {
            try {
                const proxyData = await forwardToRecoService(
                    '/internal/reco/videos',
                    'GET',
                    token,
                    { limit },
                    null
                );
                if (proxyData && proxyData.success && Array.isArray(proxyData.recommendations) && proxyData.recommendations.length >= Math.min(3, limit)) {
                    markRecoGatewayRoute('routed');
                    return res.status(200).json({
                        success: true,
                        scene,
                        via: 'reco-service',
                        recommendations: proxyData.recommendations
                    });
                }
                if (proxyData && proxyData.success && Array.isArray(proxyData.recommendations) && proxyData.recommendations.length > 0) {
                    markRecoGatewayRoute('fallback');
                    console.warn('reco/videos proxy returned too few items, fallback local:', proxyData.recommendations.length);
                }
            } catch (proxyError) {
                markRecoGatewayRoute('proxy_error');
                console.warn('reco/videos proxy fallback:', proxyError.message);
            }
        }
        markRecoGatewayRoute(shouldUseRecoGatewayForUser(req.user.id, gatewayCfg) ? 'fallback' : 'local');
        const userId = Number(req.user.id);
        const items = await buildRecoVideosForUser(userId, limit, salt);
        res.status(200).json({
            success: true,
            scene,
            recommendations: items.map((it) => ({
                id: it.id,
                video_name: it.video_name,
                book_name: it.book_name,
                book_id: it.book_id,
                video_url: it.video_url,
                video_tags: it.video_tags,
                video_category: it.video_category,
                video_topic: it.video_topic,
                score: Number((it.score || 0).toFixed(6)),
                reason: it.reason || '为你推荐',
                strategy: it.strategy || 'content',
                matched_tags: it.matched_tags || []
            }))
        });
    } catch (error) {
        console.error('reco/videos:', error);
        res.status(500).json({ success: false, message: '获取视频推荐失败' });
    }
});

// 管理端：读取推荐配置
app.get('/api/admin/reco-config', authenticateAdmin, async (req, res) => {
    try {
        const cfg = await loadRecoSettingsFromDb();
        res.status(200).json({ success: true, config: cfg });
    } catch (error) {
        console.error('admin/reco-config get:', error);
        res.status(500).json({ success: false, message: '获取推荐配置失败' });
    }
});

// 管理端：保存推荐配置
app.put('/api/admin/reco-config', authenticateAdmin, async (req, res) => {
    try {
        const next = normalizeRecoSettings(req.body || {});
        await dbRunAsync(
            `UPDATE reco_settings
             SET enabled = ?, cache_enabled = ?, cache_ttl_sec = ?, cf_min_interactions = ?, cf_min_neighbors = ?, cf_similarity = ?,
                 ab_enabled = ?, ab_traffic_pct = ?, ab_variant_cf_min_interactions = ?, ab_variant_cf_min_neighbors = ?, ab_variant_cf_similarity = ?,
                 alert_cf_hit_min_pct = ?, alert_ctr_min_pct = ?,
                 reco_gateway_enabled = ?, reco_gateway_base_url = ?, reco_gateway_traffic_pct = ?,
                 weights_json = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = 1`,
            [
                next.enabled ? 1 : 0,
                next.cache_enabled ? 1 : 0,
                next.cache_ttl_sec,
                next.cf_min_interactions,
                next.cf_min_neighbors,
                next.cf_similarity,
                next.ab_enabled ? 1 : 0,
                next.ab_traffic_pct,
                next.ab_variant_cf_min_interactions,
                next.ab_variant_cf_min_neighbors,
                next.ab_variant_cf_similarity,
                next.alert_cf_hit_min_pct,
                next.alert_ctr_min_pct,
                next.reco_gateway_enabled ? 1 : 0,
                next.reco_gateway_base_url,
                next.reco_gateway_traffic_pct,
                JSON.stringify(next.weights)
            ]
        );
        runtimeRecoSettings = next;
        res.status(200).json({ success: true, config: next });
    } catch (error) {
        console.error('admin/reco-config put:', error);
        res.status(500).json({ success: false, message: '保存推荐配置失败' });
    }
});

// 管理端：手动刷新推荐缓存
app.post('/api/admin/reco-cache/refresh', authenticateAdmin, async (req, res) => {
    try {
        const limitPerUser = Math.max(8, Math.min(50, Number(req.body?.limit_per_user) || 20));
        const maxUsers = Math.max(1, Math.min(500, Number(req.body?.max_users) || 100));
        const refreshed = await recoService.cache.refreshActive(limitPerUser, maxUsers);
        res.status(200).json({ success: true, refreshed_users: refreshed });
    } catch (error) {
        console.error('admin/reco-cache/refresh:', error);
        res.status(500).json({ success: false, message: '刷新推荐缓存失败' });
    }
});

// 管理端：手动刷新用户-物品评分矩阵快照
app.post('/api/admin/reco-snapshot/refresh', authenticateAdmin, async (req, res) => {
    try {
        const days = Math.max(7, Math.min(90, Number(req.body?.days) || 30));
        const affected = await recoService.cache.rebuildSnapshot(days);
        res.status(200).json({ success: true, affected_pairs: affected, days });
    } catch (error) {
        console.error('admin/reco-snapshot/refresh:', error);
        res.status(500).json({ success: false, message: '刷新评分矩阵快照失败' });
    }
});

// 管理端：手动消费推荐事件队列
app.post('/api/admin/reco-queue/drain', authenticateAdmin, async (req, res) => {
    try {
        const batch = Math.max(10, Math.min(1000, Number(req.body?.batch) || 300));
        const result = await drainRecoEventQueue(batch);
        res.status(200).json({ success: true, ...result });
    } catch (error) {
        console.error('admin/reco-queue/drain:', error);
        res.status(500).json({ success: false, message: '消费推荐事件队列失败' });
    }
});

// 管理端：回填历史推荐事件策略（用于策略效果看板）
app.post('/api/admin/reco-events/backfill-strategy', authenticateAdmin, async (req, res) => {
    try {
        const days = Math.max(1, Math.min(180, Number(req.body?.days) || 30));
        const limit = Math.max(100, Math.min(50000, Number(req.body?.limit) || 5000));
        const result = await backfillRecoEventStrategies(days, limit);
        res.status(200).json({ success: true, days, limit, ...result });
    } catch (error) {
        console.error('admin/reco-events/backfill-strategy:', error);
        res.status(500).json({ success: false, message: '回填历史策略归因失败' });
    }
});

// 管理端：推荐回归检查（一键）
app.post('/api/admin/reco-regression/run', authenticateAdmin, async (req, res) => {
    try {
        const users = await dbAllAsync(
            `SELECT DISTINCT user_id
             FROM book_reco_events
             WHERE user_id IS NOT NULL
               AND datetime(created_at) >= datetime('now', '-30 day')
             ORDER BY user_id DESC
             LIMIT 8`
        );
        const checkedUsers = [];
        let passed = 0;
        let failed = 0;
        for (const row of users) {
            const uid = Number(row.user_id);
            if (!uid) continue;
            const recs = await buildRecoScoresForUser(uid, 8, Date.now());
            const top = recs[0] || null;
            const ok = !!(top && top.score_breakdown && Array.isArray(top.neighbor_contrib_topk) && Array.isArray(top.tag_contrib_topk) && top.time_decay_summary);
            checkedUsers.push({
                user_id: uid,
                rec_count: recs.length,
                explainable: ok
            });
            if (ok && recs.length > 0) passed += 1;
            else failed += 1;
        }
        res.status(200).json({
            success: true,
            checked: checkedUsers.length,
            passed,
            failed,
            details: checkedUsers
        });
    } catch (error) {
        console.error('admin/reco-regression/run:', error);
        res.status(500).json({ success: false, message: '运行推荐回归检查失败' });
    }
});

async function runRecoAlertsCheck({ source = 'manual', persist = true } = {}) {
    const cfg = getRecoSettings();
    const [impRow] = await dbAllAsync(
        `SELECT COUNT(*) AS c
         FROM book_reco_events
         WHERE event_type = 'impression'
           AND scene = 'book_square'
           AND datetime(created_at) >= datetime('now', '-7 day')`
    );
    const [clickRow] = await dbAllAsync(
        `SELECT COUNT(*) AS c
         FROM book_reco_events
         WHERE event_type = 'click'
           AND scene = 'book_square'
           AND datetime(created_at) >= datetime('now', '-7 day')`
    );
    const [totalRow] = await dbAllAsync(
        `SELECT COUNT(*) AS c
         FROM book_reco_cache
         WHERE datetime(updated_at) >= datetime('now', '-7 day')`
    );
    const [cfRow] = await dbAllAsync(
        `SELECT COUNT(*) AS c
         FROM book_reco_cache
         WHERE strategy = 'cf'
           AND datetime(updated_at) >= datetime('now', '-7 day')`
    );
    const imp = Number(impRow?.c || 0);
    const click = Number(clickRow?.c || 0);
    const total = Number(totalRow?.c || 0);
    const cf = Number(cfRow?.c || 0);
    const ctrPct = imp > 0 ? (click / imp) * 100 : 0;
    const cfHitPct = total > 0 ? (cf / total) * 100 : 0;
    const thresholds = {
        alert_ctr_min_pct: Number(cfg.alert_ctr_min_pct || DEFAULT_RECO_SETTINGS.alert_ctr_min_pct),
        alert_cf_hit_min_pct: Number(cfg.alert_cf_hit_min_pct || DEFAULT_RECO_SETTINGS.alert_cf_hit_min_pct)
    };
    const alerts = [];
    if (ctrPct < thresholds.alert_ctr_min_pct) {
        alerts.push(`CTR过低：${ctrPct.toFixed(2)}% < 阈值${Number(thresholds.alert_ctr_min_pct).toFixed(2)}%`);
    }
    if (cfHitPct < thresholds.alert_cf_hit_min_pct) {
        alerts.push(`CF命中占比过低：${cfHitPct.toFixed(2)}% < 阈值${Number(thresholds.alert_cf_hit_min_pct).toFixed(2)}%`);
    }
    const values = {
        ctr_pct: Number(ctrPct.toFixed(2)),
        cf_hit_pct: Number(cfHitPct.toFixed(2))
    };
    if (persist) {
        try {
            await dbRunAsync(
                `INSERT INTO reco_alert_logs (source, status, alerts_json, metrics_json, thresholds_json, created_at)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    String(source || 'manual'),
                    alerts.length > 0 ? 'alerted' : 'ok',
                    JSON.stringify(alerts),
                    JSON.stringify(values),
                    JSON.stringify(thresholds)
                ]
            );
            // 仅保留最近 2000 条告警巡检记录，避免表无限增长
            await dbRunAsync(
                `DELETE FROM reco_alert_logs
                 WHERE id NOT IN (
                    SELECT id FROM reco_alert_logs ORDER BY id DESC LIMIT 2000
                 )`
            );
        } catch (error) {
            console.warn('写入推荐告警日志失败:', error.message);
        }
    }
    return {
        alerted: alerts.length > 0,
        alerts,
        values,
        thresholds
    };
}

async function maybeNotifyRecoAlertWebhook(result, source = 'auto_cron') {
    if (!RECO_ALERT_WEBHOOK_URL) return false;
    if (!result || !result.alerted || !Array.isArray(result.alerts) || result.alerts.length === 0) return false;
    const now = Date.now();
    const signature = JSON.stringify({
        alerts: result.alerts,
        thresholds: result.thresholds
    });
    const cooldownMs = RECO_ALERT_NOTIFY_COOLDOWN_SEC * 1000;
    if (
        recoAlertNotifyState.last_signature === signature &&
        now - Number(recoAlertNotifyState.last_sent_at || 0) < cooldownMs
    ) {
        return false;
    }
    const payload = {
        text: '推荐系统自动告警',
        source,
        time: new Date().toISOString(),
        alerts: result.alerts,
        values: result.values || {},
        thresholds: result.thresholds || {}
    };
    await axios.post(RECO_ALERT_WEBHOOK_URL, payload, { timeout: 5000 });
    recoAlertNotifyState.last_signature = signature;
    recoAlertNotifyState.last_sent_at = now;
    return true;
}

// 管理端：推荐阈值告警检查
app.post('/api/admin/reco-alerts/check', authenticateAdmin, async (req, res) => {
    try {
        const result = await runRecoAlertsCheck({ source: 'manual', persist: true });
        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('admin/reco-alerts/check:', error);
        res.status(500).json({ success: false, message: '执行推荐告警检查失败' });
    }
});

// 管理端：查询推荐告警日志（默认最近50条）
app.get('/api/admin/reco-alerts/logs', authenticateAdmin, async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));
        const rows = await dbAllAsync(
            `SELECT id, source, status, alerts_json, metrics_json, thresholds_json, created_at
             FROM reco_alert_logs
             ORDER BY id DESC
             LIMIT ?`,
            [limit]
        );
        const logs = (rows || []).map((row) => {
            let alerts = [];
            let metrics = {};
            let thresholds = {};
            try { alerts = JSON.parse(row.alerts_json || '[]') || []; } catch (e) {}
            try { metrics = JSON.parse(row.metrics_json || '{}') || {}; } catch (e) {}
            try { thresholds = JSON.parse(row.thresholds_json || '{}') || {}; } catch (e) {}
            return {
                id: Number(row.id || 0),
                source: String(row.source || ''),
                status: String(row.status || 'ok'),
                alerts,
                metrics,
                thresholds,
                created_at: row.created_at
            };
        });
        res.status(200).json({
            success: true,
            total: logs.length,
            logs
        });
    } catch (error) {
        console.error('admin/reco-alerts/logs:', error);
        res.status(500).json({ success: false, message: '获取推荐告警日志失败' });
    }
});

app.post('/api/admin/reco-gateway/check', authenticateAdmin, async (req, res) => {
    try {
        const state = await checkRecoGatewayHealth();
        res.status(200).json({
            success: true,
            gateway: {
                healthy: !!state.healthy,
                latency_ms: Number(state.latency_ms || 0),
                last_error: String(state.last_error || ''),
                last_checked_at: Number(state.last_checked_at || 0)
            }
        });
    } catch (error) {
        console.error('admin/reco-gateway/check:', error);
        res.status(500).json({ success: false, message: '检查推荐网关状态失败' });
    }
});

app.post('/api/admin/reco-gateway/reset-counters', authenticateAdmin, async (req, res) => {
    try {
        recoGatewayState.routed_count = 0;
        recoGatewayState.local_count = 0;
        recoGatewayState.fallback_count = 0;
        recoGatewayState.proxy_error_count = 0;
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('admin/reco-gateway/reset-counters:', error);
        res.status(500).json({ success: false, message: '重置网关计数器失败' });
    }
});

// 管理端：推荐监控指标
app.get('/api/admin/reco-metrics', authenticateAdmin, async (req, res) => {
    try {
        const cfg = getRecoSettings();
        const [events24hRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c FROM book_reco_events WHERE datetime(created_at) >= datetime('now', '-1 day')`
        );
        const [events7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c FROM book_reco_events WHERE datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [activeUsers7dRow] = await dbAllAsync(
            `SELECT COUNT(DISTINCT user_id) AS c
             FROM book_reco_events
             WHERE user_id IS NOT NULL
               AND datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [videoDwell7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'dwell'
               AND scene LIKE 'book_square_video%'
               AND datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [cacheTotalRow] = await dbAllAsync(`SELECT COUNT(*) AS c FROM book_reco_cache`);
        const [cacheFreshRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_cache
             WHERE datetime(updated_at) >= datetime('now', ?)`,
            [`-${Math.max(15, Number(cfg.cache_ttl_sec) || 120)} seconds`]
        );
        const [recoImp7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'impression'
               AND scene = 'book_square'
               AND datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [recoImp5mRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'impression'
               AND scene = 'book_square'
               AND datetime(created_at) >= datetime('now', '-5 minute')`
        );
        const [recoImp1hRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'impression'
               AND scene = 'book_square'
               AND datetime(created_at) >= datetime('now', '-1 hour')`
        );
        const [recoClick7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'click'
               AND scene = 'book_square'
               AND datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [recoClick5mRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'click'
               AND scene = 'book_square'
               AND datetime(created_at) >= datetime('now', '-5 minute')`
        );
        const [recoClick1hRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'click'
               AND scene = 'book_square'
               AND datetime(created_at) >= datetime('now', '-1 hour')`
        );
        const [recoDwellAvg7dRow] = await dbAllAsync(
            `SELECT AVG(event_value) AS v
             FROM book_reco_events
             WHERE event_type = 'dwell'
               AND (scene = 'book_square' OR scene = 'bookstore')
               AND datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [recoCart7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'cart_add'
               AND datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [recoCart5mRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'cart_add'
               AND datetime(created_at) >= datetime('now', '-5 minute')`
        );
        const [recoCart1hRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'cart_add'
               AND datetime(created_at) >= datetime('now', '-1 hour')`
        );
        const [recoPurchase7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'purchase'
               AND datetime(created_at) >= datetime('now', '-7 day')`
        );
        const [recoPurchase5mRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'purchase'
               AND datetime(created_at) >= datetime('now', '-5 minute')`
        );
        const [recoPurchase1hRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_events
             WHERE event_type = 'purchase'
               AND datetime(created_at) >= datetime('now', '-1 hour')`
        );
        const [recoStrategyTotal7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_cache
             WHERE datetime(updated_at) >= datetime('now', '-7 day')`
        );
        const [recoContentOnly7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_cache
             WHERE strategy = 'content'
               AND datetime(updated_at) >= datetime('now', '-7 day')`
        );
        const [recoCf7dRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM book_reco_cache
             WHERE strategy = 'cf'
               AND datetime(updated_at) >= datetime('now', '-7 day')`
        );
        const strategyDist7d = await dbAllAsync(
            `SELECT strategy, COUNT(*) AS cnt
             FROM book_reco_cache
             WHERE datetime(updated_at) >= datetime('now', '-7 day')
             GROUP BY strategy
             ORDER BY cnt DESC`
        );
        const [queuePendingRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM reco_event_queue
             WHERE status = 'pending'`
        );
        const [queueFailedRow] = await dbAllAsync(
            `SELECT COUNT(*) AS c
             FROM reco_event_queue
             WHERE status = 'failed'`
        );
        const [queueOldestPendingRow] = await dbAllAsync(
            `SELECT MIN(created_at) AS t
             FROM reco_event_queue
             WHERE status = 'pending'`
        );
        const strategyCtrTrend7d = [];
        for (let i = 6; i >= 0; i--) {
            const dayExpr = `-${i} day`;
            const [impRow] = await dbAllAsync(
                `SELECT COUNT(*) AS c
                 FROM book_reco_events
                 WHERE event_type = 'impression'
                   AND scene = 'book_square'
                   AND date(created_at) = date('now', ?)`,
                [dayExpr]
            );
            const [clickRow] = await dbAllAsync(
                `SELECT COUNT(*) AS c
                 FROM book_reco_events
                 WHERE event_type = 'click'
                   AND scene = 'book_square'
                   AND date(created_at) = date('now', ?)`,
                [dayExpr]
            );
            const [cartRow] = await dbAllAsync(
                `SELECT COUNT(*) AS c
                 FROM book_reco_events
                 WHERE event_type = 'cart_add'
                   AND date(created_at) = date('now', ?)`,
                [dayExpr]
            );
            const [purchaseRow] = await dbAllAsync(
                `SELECT COUNT(*) AS c
                 FROM book_reco_events
                 WHERE event_type = 'purchase'
                   AND date(created_at) = date('now', ?)`,
                [dayExpr]
            );
            const [strategyTotalRow] = await dbAllAsync(
                `SELECT COUNT(*) AS c
                 FROM book_reco_cache
                 WHERE date(updated_at) = date('now', ?)`,
                [dayExpr]
            );
            const [strategyCfRow] = await dbAllAsync(
                `SELECT COUNT(*) AS c
                 FROM book_reco_cache
                 WHERE strategy = 'cf'
                   AND date(updated_at) = date('now', ?)`,
                [dayExpr]
            );
            const imp = Number(impRow?.c || 0);
            const click = Number(clickRow?.c || 0);
            const cart = Number(cartRow?.c || 0);
            const purchase = Number(purchaseRow?.c || 0);
            const stratTotal = Number(strategyTotalRow?.c || 0);
            const stratCf = Number(strategyCfRow?.c || 0);
            const ctr = imp > 0 ? (click / imp) : 0;
            const conv = click > 0 ? ((cart + purchase) / click) : 0;
            const cfRatio = stratTotal > 0 ? (stratCf / stratTotal) : 0;
            strategyCtrTrend7d.push({
                date: new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10),
                impression: imp,
                click,
                ctr_pct: Number((ctr * 100).toFixed(2)),
                conversion_pct: Number((Math.min(1, conv) * 100).toFixed(2)),
                cf_ratio_pct: Number((cfRatio * 100).toFixed(2))
            });
        }
        const eventDist = await dbAllAsync(
            `SELECT event_type, COUNT(*) AS cnt
             FROM book_reco_events
             WHERE datetime(created_at) >= datetime('now', '-7 day')
             GROUP BY event_type
             ORDER BY cnt DESC`
        );
        const strategyEffectRaw7d = await dbAllAsync(
            `SELECT strategy,
                    SUM(CASE WHEN event_type = 'impression' THEN 1 ELSE 0 END) AS imp_cnt,
                    SUM(CASE WHEN event_type = 'click' THEN 1 ELSE 0 END) AS click_cnt
             FROM book_reco_events
             WHERE datetime(created_at) >= datetime('now', '-7 day')
               AND scene = 'book_square'
               AND COALESCE(strategy, '') <> ''
             GROUP BY strategy
             ORDER BY click_cnt DESC, imp_cnt DESC`
        );
        const strategyDailyMatrixRaw7d = await dbAllAsync(
            `SELECT date(created_at) AS d,
                    strategy,
                    SUM(CASE WHEN event_type = 'impression' THEN 1 ELSE 0 END) AS imp_cnt,
                    SUM(CASE WHEN event_type = 'click' THEN 1 ELSE 0 END) AS click_cnt
             FROM book_reco_events
             WHERE datetime(created_at) >= datetime('now', '-7 day')
               AND scene = 'book_square'
               AND COALESCE(strategy, '') <> ''
             GROUP BY date(created_at), strategy
             ORDER BY d DESC, strategy ASC`
        );
        const abUserAgg7d = await dbAllAsync(
            `SELECT user_id,
                    SUM(CASE WHEN event_type = 'impression' AND scene = 'book_square' THEN 1 ELSE 0 END) AS imp_cnt,
                    SUM(CASE WHEN event_type = 'click' AND scene = 'book_square' THEN 1 ELSE 0 END) AS click_cnt,
                    SUM(CASE WHEN event_type = 'cart_add' THEN 1 ELSE 0 END) AS cart_cnt,
                    SUM(CASE WHEN event_type = 'purchase' THEN 1 ELSE 0 END) AS purchase_cnt
             FROM book_reco_events
             WHERE user_id IS NOT NULL
               AND datetime(created_at) >= datetime('now', '-7 day')
             GROUP BY user_id`
        );
        const topBooks = await dbAllAsync(
            `SELECT e.book_id, b.title, COUNT(*) AS cnt
             FROM book_reco_events e
             JOIN books b ON b.id = e.book_id
             WHERE datetime(e.created_at) >= datetime('now', '-7 day')
             GROUP BY e.book_id, b.title
             ORDER BY cnt DESC
             LIMIT 8`
        );
        const recoImp7d = Number(recoImp7dRow?.c || 0);
        const recoClick7d = Number(recoClick7dRow?.c || 0);
        const recoCtr7d = recoImp7d > 0 ? (recoClick7d / recoImp7d) : 0;
        const recoImp5m = Number(recoImp5mRow?.c || 0);
        const recoClick5m = Number(recoClick5mRow?.c || 0);
        const recoCtr5m = recoImp5m > 0 ? (recoClick5m / recoImp5m) : 0;
        const recoImp1h = Number(recoImp1hRow?.c || 0);
        const recoClick1h = Number(recoClick1hRow?.c || 0);
        const recoCtr1h = recoImp1h > 0 ? (recoClick1h / recoImp1h) : 0;
        const recoCart7d = Number(recoCart7dRow?.c || 0);
        const recoPurchase7d = Number(recoPurchase7dRow?.c || 0);
        const recoConv7d = recoClick7d > 0 ? ((recoCart7d + recoPurchase7d) / recoClick7d) : 0;
        const cartConv7d = recoClick7d > 0 ? (recoCart7d / recoClick7d) : 0;
        const purchaseConv7d = recoClick7d > 0 ? (recoPurchase7d / recoClick7d) : 0;
        const recoCart5m = Number(recoCart5mRow?.c || 0);
        const recoPurchase5m = Number(recoPurchase5mRow?.c || 0);
        const recoConv5m = recoClick5m > 0 ? ((recoCart5m + recoPurchase5m) / recoClick5m) : 0;
        const recoCart1h = Number(recoCart1hRow?.c || 0);
        const recoPurchase1h = Number(recoPurchase1hRow?.c || 0);
        const recoConv1h = recoClick1h > 0 ? ((recoCart1h + recoPurchase1h) / recoClick1h) : 0;
        const recoStrategyTotal7d = Number(recoStrategyTotal7dRow?.c || 0);
        const recoContentOnly7d = Number(recoContentOnly7dRow?.c || 0);
        const recoCf7d = Number(recoCf7dRow?.c || 0);
        const coldStartRatio7d = recoStrategyTotal7d > 0 ? (recoContentOnly7d / recoStrategyTotal7d) : 0;
        const cfHitRatio7d = recoStrategyTotal7d > 0 ? (recoCf7d / recoStrategyTotal7d) : 0;
        const cfSimilarityMode = String(cfg.cf_similarity || 'cosine').toLowerCase() === 'pearson' ? 'pearson' : 'cosine';
        const cosineHitRatio7d = cfSimilarityMode === 'cosine' ? cfHitRatio7d : 0;
        const pearsonHitRatio7d = cfSimilarityMode === 'pearson' ? cfHitRatio7d : 0;
        const strategyDistribution7d = (strategyDist7d || []).map((it) => {
            const cnt = Number(it?.cnt || 0);
            const ratio = recoStrategyTotal7d > 0 ? (cnt / recoStrategyTotal7d) : 0;
            return {
                strategy: String(it?.strategy || 'unknown'),
                count: cnt,
                ratio_pct: Number((ratio * 100).toFixed(2))
            };
        });
        const strategyEffect7d = (strategyEffectRaw7d || []).map((it) => {
            const imp = Number(it?.imp_cnt || 0);
            const click = Number(it?.click_cnt || 0);
            const ctr = imp > 0 ? (click / imp) : 0;
            const clickShare = recoClick7d > 0 ? (click / recoClick7d) : 0;
            return {
                strategy: String(it?.strategy || 'unknown'),
                impression: imp,
                click,
                ctr_pct: Number((ctr * 100).toFixed(2)),
                click_share_pct: Number((clickShare * 100).toFixed(2))
            };
        });
        const strategySummary7d = ['cf', 'content', 'hot', 'fresh'].map((name) => {
            const hit = strategyEffect7d.find((x) => String(x.strategy) === name);
            return {
                strategy: name,
                impression: Number(hit?.impression || 0),
                click: Number(hit?.click || 0),
                ctr_pct: Number(hit?.ctr_pct || 0),
                click_share_pct: Number(hit?.click_share_pct || 0)
            };
        });
        const strategyDailyMatrix7d = (strategyDailyMatrixRaw7d || []).map((it) => {
            const imp = Number(it?.imp_cnt || 0);
            const click = Number(it?.click_cnt || 0);
            const ctr = imp > 0 ? (click / imp) : 0;
            return {
                date: String(it?.d || ''),
                strategy: String(it?.strategy || 'unknown'),
                impression: imp,
                click,
                ctr_pct: Number((ctr * 100).toFixed(2))
            };
        });
        const abGroupStats = {
            A: { users: 0, impression: 0, click: 0, cart: 0, purchase: 0 },
            B: { users: 0, impression: 0, click: 0, cart: 0, purchase: 0 }
        };
        for (const row of (abUserAgg7d || [])) {
            const uid = Number(row?.user_id || 0);
            if (!uid) continue;
            const grp = getRecoExperimentVariant(uid, cfg);
            const g = grp === 'B' ? abGroupStats.B : abGroupStats.A;
            g.users += 1;
            g.impression += Number(row?.imp_cnt || 0);
            g.click += Number(row?.click_cnt || 0);
            g.cart += Number(row?.cart_cnt || 0);
            g.purchase += Number(row?.purchase_cnt || 0);
        }
        const abExperimentSummary7d = ['A', 'B'].map((group) => {
            const g = abGroupStats[group];
            const ctr = g.impression > 0 ? (g.click / g.impression) : 0;
            const cvr = g.click > 0 ? ((g.cart + g.purchase) / g.click) : 0;
            return {
                group,
                users: g.users,
                impression: g.impression,
                click: g.click,
                ctr_pct: Number((ctr * 100).toFixed(2)),
                conversion_pct: Number((Math.min(1, cvr) * 100).toFixed(2))
            };
        });
        const queuePending = Number(queuePendingRow?.c || 0);
        const queueFailed = Number(queueFailedRow?.c || 0);
        const gatewayCounterSummary = getRecoGatewayCounterSummary();
        const abEnabled = !!cfg.ab_enabled;
        const abTrafficPct = Math.max(0, Math.min(100, Number(cfg.ab_traffic_pct) || 0));
        const activeUsers7d = Number(activeUsers7dRow?.c || 0);
        const abEstimatedVariantBUsers7d = abEnabled ? Math.round(activeUsers7d * (abTrafficPct / 100)) : 0;
        const oldestPendingTs = queueOldestPendingRow?.t ? new Date(queueOldestPendingRow.t).getTime() : null;
        const queueLagSec = oldestPendingTs ? Math.max(0, Math.round((Date.now() - oldestPendingTs) / 1000)) : 0;
        res.status(200).json({
            success: true,
            metrics: {
                events_24h: Number(events24hRow?.c || 0),
                events_7d: Number(events7dRow?.c || 0),
                active_users_7d: activeUsers7d,
                video_dwell_7d: Number(videoDwell7dRow?.c || 0),
                cache_total: Number(cacheTotalRow?.c || 0),
                cache_fresh: Number(cacheFreshRow?.c || 0),
                reco_impression_7d: recoImp7d,
                reco_click_7d: recoClick7d,
                reco_ctr_7d: Number((recoCtr7d * 100).toFixed(2)),
                reco_impression_5m: recoImp5m,
                reco_click_5m: recoClick5m,
                reco_ctr_5m: Number((recoCtr5m * 100).toFixed(2)),
                reco_conversion_5m: Number((Math.min(1, recoConv5m) * 100).toFixed(2)),
                reco_impression_1h: recoImp1h,
                reco_click_1h: recoClick1h,
                reco_ctr_1h: Number((recoCtr1h * 100).toFixed(2)),
                reco_conversion_1h: Number((Math.min(1, recoConv1h) * 100).toFixed(2)),
                reco_avg_dwell_7d: Number((Number(recoDwellAvg7dRow?.v || 0)).toFixed(3)),
                reco_conversion_7d: Number((Math.min(1, recoConv7d) * 100).toFixed(2)),
                reco_cart_conversion_7d: Number((Math.min(1, cartConv7d) * 100).toFixed(2)),
                reco_purchase_conversion_7d: Number((Math.min(1, purchaseConv7d) * 100).toFixed(2)),
                cold_start_ratio_7d: Number((coldStartRatio7d * 100).toFixed(2)),
                cf_hit_ratio_7d: Number((cfHitRatio7d * 100).toFixed(2)),
                cf_similarity_mode: cfSimilarityMode,
                ab_enabled: abEnabled,
                ab_traffic_pct: Number(abTrafficPct.toFixed(2)),
                ab_variant_cf_min_interactions: Number(cfg.ab_variant_cf_min_interactions || DEFAULT_RECO_SETTINGS.ab_variant_cf_min_interactions || 1),
                ab_variant_cf_min_neighbors: Number(cfg.ab_variant_cf_min_neighbors || DEFAULT_RECO_SETTINGS.ab_variant_cf_min_neighbors || 1),
                ab_variant_cf_similarity: normalizeRecoSimilarity(cfg.ab_variant_cf_similarity || DEFAULT_RECO_SETTINGS.ab_variant_cf_similarity),
                ab_estimated_variant_b_users_7d: abEstimatedVariantBUsers7d,
                alert_cf_hit_min_pct: Number(cfg.alert_cf_hit_min_pct || DEFAULT_RECO_SETTINGS.alert_cf_hit_min_pct),
                alert_ctr_min_pct: Number(cfg.alert_ctr_min_pct || DEFAULT_RECO_SETTINGS.alert_ctr_min_pct),
                reco_gateway_enabled: !!cfg.reco_gateway_enabled,
                reco_gateway_base_url: String(cfg.reco_gateway_base_url || RECO_SERVICE_BASE_URL),
                reco_gateway_traffic_pct: Number(cfg.reco_gateway_traffic_pct || DEFAULT_RECO_SETTINGS.reco_gateway_traffic_pct),
                reco_gateway_healthy: !!recoGatewayState.healthy,
                reco_gateway_latency_ms: Number(recoGatewayState.latency_ms || 0),
                reco_gateway_last_error: String(recoGatewayState.last_error || ''),
                reco_gateway_routed_count: Number(recoGatewayState.routed_count || 0),
                reco_gateway_local_count: Number(recoGatewayState.local_count || 0),
                reco_gateway_fallback_count: Number(recoGatewayState.fallback_count || 0),
                reco_gateway_proxy_error_count: Number(recoGatewayState.proxy_error_count || 0),
                reco_gateway_total_count: Number(gatewayCounterSummary.total_count || 0),
                reco_gateway_routed_pct: Number(gatewayCounterSummary.routed_pct || 0),
                reco_gateway_local_pct: Number(gatewayCounterSummary.local_pct || 0),
                reco_gateway_fallback_pct: Number(gatewayCounterSummary.fallback_pct || 0),
                reco_gateway_proxy_error_pct: Number(gatewayCounterSummary.proxy_error_pct || 0),
                cosine_hit_ratio_7d: Number((cosineHitRatio7d * 100).toFixed(2)),
                pearson_hit_ratio_7d: Number((pearsonHitRatio7d * 100).toFixed(2)),
                cf_min_interactions: Number(cfg.cf_min_interactions || DEFAULT_RECO_SETTINGS.cf_min_interactions || 3),
                cf_min_neighbors: Number(cfg.cf_min_neighbors || DEFAULT_RECO_SETTINGS.cf_min_neighbors || 2),
                queue_pending: queuePending,
                queue_failed: queueFailed,
                queue_lag_sec: queueLagSec,
                event_distribution_7d: eventDist || [],
                strategy_distribution_7d: strategyDistribution7d,
                strategy_effect_7d: strategyEffect7d,
                strategy_summary_7d: strategySummary7d,
                strategy_daily_matrix_7d: strategyDailyMatrix7d,
                strategy_ctr_trend_7d: strategyCtrTrend7d,
                ab_experiment_summary_7d: abExperimentSummary7d,
                top_books_7d: topBooks || []
            }
        });
    } catch (error) {
        console.error('admin/reco-metrics:', error);
        res.status(500).json({ success: false, message: '获取推荐监控指标失败' });
    }
});

// 获取图书列表
app.get('/api/books/category-stats', (req, res) => {
    db.all(
        `SELECT b.category AS category, COUNT(*) AS count
         FROM books b
         JOIN (
            SELECT title, author, MAX(id) AS keep_id
            FROM books
            GROUP BY title, author
         ) dedup ON dedup.keep_id = b.id
         WHERE b.category IS NOT NULL
           AND TRIM(b.category) <> ''
           AND COALESCE(b.shelf_status, 'on_sale') = 'on_sale'
         GROUP BY b.category
         ORDER BY count DESC, b.category ASC`,
        [],
        (err, rows) => {
            if (err) {
                console.error('获取图书分类统计失败:', err.message);
                return res.status(500).json({ success: false, message: '获取图书分类统计失败' });
            }
            res.status(200).json({
                success: true,
                categories: (rows || []).map(item => ({
                    category: item.category,
                    count: Number(item.count || 0)
                }))
            });
        }
    );
});

app.get('/api/books/rating-stats', (req, res) => {
    db.all(
        `SELECT b.rating AS rating
         FROM books b
         JOIN (
            SELECT title, author, MAX(id) AS keep_id
            FROM books
            GROUP BY title, author
         ) dedup ON dedup.keep_id = b.id
         WHERE COALESCE(b.shelf_status, 'on_sale') = 'on_sale'`,
        [],
        (err, rows) => {
            if (err) {
                console.error('获取图书评分统计失败:', err.message);
                return res.status(500).json({ success: false, message: '获取图书评分统计失败' });
            }
            const thresholds = [4.5, 4.0, 3.5, 3.0];
            const ratings = (rows || []).map(item => Number(item.rating || 0));
            const stats = thresholds.map(t => ({
                threshold: t,
                count: ratings.filter(v => v >= t).length
            }));
            res.status(200).json({ success: true, ratings: stats });
        }
    );
});

// 获取图书列表
app.get('/api/books', (req, res) => {
    const { page = 1, limit = 10, category, search, sortBy = 'created_at', sortOrder = 'desc', minPrice, maxPrice, rating } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = '';
    let params = [];
    let conditions = [];
    
    // 构建查询条件（用户端默认只显示上架图书）
    conditions.push(`COALESCE(b.shelf_status, 'on_sale') = 'on_sale'`);

    // 构建查询条件
    if (category) {
        conditions.push(`b.category = ?`);
        params.push(category);
    }
    
    if (search) {
        conditions.push(`(b.title LIKE ? OR b.author LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`);
    }
    
    if (minPrice) {
        conditions.push(`b.price >= ?`);
        params.push(parseFloat(minPrice));
    }
    
    if (maxPrice) {
        conditions.push(`b.price <= ?`);
        params.push(parseFloat(maxPrice));
    }
    
    if (rating) {
        conditions.push(`b.rating >= ?`);
        params.push(parseFloat(rating));
    }
    
    // 组合所有条件
    if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
    }
    
    // 构建排序条件
    const validSortColumns = ['created_at', 'title', 'author', 'price', 'rating'];
    const validSortOrders = ['asc', 'desc'];
    
    // 验证排序参数的有效性
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const order = validSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'desc';
    
    // 查询图书列表
    db.all(
        `SELECT b.*
         FROM books b
         JOIN (
            SELECT title, author, MAX(id) AS keep_id
            FROM books
            GROUP BY title, author
         ) dedup ON dedup.keep_id = b.id
         ${whereClause}
         ORDER BY b.${sortColumn} ${order}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, books) => {
            if (err) {
                console.error('获取图书列表失败:', err.message);
                return res.status(500).json({ success: false, message: '获取图书列表失败' });
            }
            
            // 查询总记录数
            db.get(
                `SELECT COUNT(*) AS total
                 FROM books b
                 JOIN (
                    SELECT title, author, MAX(id) AS keep_id
                    FROM books
                    GROUP BY title, author
                 ) dedup ON dedup.keep_id = b.id
                 ${whereClause}`,
                params,
                (err, result) => {
                    if (err) {
                        console.error('获取图书总数失败:', err.message);
                        return res.status(500).json({ success: false, message: '获取图书总数失败' });
                    }
                    
                    res.status(200).json({
                        success: true,
                        books: books,
                        total: result.total,
                        currentPage: parseInt(page),
                        totalPages: Math.ceil(result.total / limit)
                    });
                }
            );
        }
    );
});

// 获取图书详情
app.get('/api/books/:id', (req, res) => {
    const { id } = req.params;
    
    db.get(`SELECT * FROM books WHERE id = ? AND COALESCE(shelf_status, 'on_sale') = 'on_sale'`, [id], (err, book) => {
        if (err) {
            console.error('获取图书详情失败:', err.message);
            return res.status(500).json({ success: false, message: '获取图书详情失败' });
        }
        
        if (!book) {
            return res.status(404).json({ success: false, message: '图书不存在' });
        }
        
        res.status(200).json({ success: true, book: book });
    });
});



// 添加到购物车
app.post('/api/cart/add', authenticateToken, (req, res) => {
    const { book_id, quantity = 1 } = req.body;
    const user_id = req.user.id;
    
    if (!book_id) {
        return res.status(400).json({ success: false, message: '请提供图书ID' });
    }
    
    // 检查图书是否存在
    db.get(`SELECT * FROM books WHERE id = ?`, [book_id], (err, book) => {
        if (err) {
            console.error('检查图书失败:', err.message);
            return res.status(500).json({ success: false, message: '检查图书失败' });
        }
        
        if (!book) {
            return res.status(404).json({ success: false, message: '图书不存在' });
        }
        
        // 检查购物车中是否已存在该图书
        db.get(
            `SELECT * FROM cart_items WHERE user_id = ? AND book_id = ?`,
            [user_id, book_id],
            (err, cartItem) => {
                if (err) {
                    console.error('检查购物车失败:', err.message);
                    return res.status(500).json({ success: false, message: '检查购物车失败' });
                }
                
                if (cartItem) {
                    // 更新数量
                    db.run(
                        `UPDATE cart_items SET quantity = quantity + ? WHERE id = ?`,
                        [quantity, cartItem.id],
                        (err) => {
                            if (err) {
                                console.error('更新购物车失败:', err.message);
                                return res.status(500).json({ success: false, message: '更新购物车失败' });
                            }
                            recordRecoEvent(user_id, book_id, 'cart_add', Math.max(1, Number(quantity) || 1), 'bookstore_cart');
                            res.status(200).json({ success: true, message: '购物车已更新' });
                        }
                    );
                } else {
                    // 添加新项
                    db.run(
                        `INSERT INTO cart_items (user_id, book_id, quantity) VALUES (?, ?, ?)`,
                        [user_id, book_id, quantity],
                        (err) => {
                            if (err) {
                                console.error('添加到购物车失败:', err.message);
                                return res.status(500).json({ success: false, message: '添加到购物车失败' });
                            }
                            recordRecoEvent(user_id, book_id, 'cart_add', Math.max(1, Number(quantity) || 1), 'bookstore_cart');
                            res.status(200).json({ success: true, message: '已添加到购物车' });
                        }
                    );
                }
            }
        );
    });
});

// 获取购物车
app.get('/api/cart', authenticateToken, (req, res) => {
    const user_id = req.user.id;
    
    db.all(
        `SELECT ci.id, ci.user_id, ci.book_id, ci.quantity, ci.created_at, 
                b.title, b.author, b.cover_url, b.price 
         FROM cart_items ci 
         JOIN books b ON ci.book_id = b.id 
         WHERE ci.user_id = ?`,
        [user_id],
        (err, cartItems) => {
            if (err) {
                console.error('获取购物车失败:', err.message);
                return res.status(500).json({ success: false, message: '获取购物车失败' });
            }
            
            // 计算总价
            const totalPrice = cartItems.reduce((total, item) => {
                return total + (item.price * item.quantity);
            }, 0);
            
            res.status(200).json({
                success: true,
                cartItems: cartItems,
                totalPrice: totalPrice
            });
        }
    );
});

// 更新购物车数量
app.put('/api/cart/update/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { quantity } = req.body;
    const user_id = req.user.id;
    
    if (!quantity || quantity < 1) {
        return res.status(400).json({ success: false, message: '请提供有效的数量' });
    }
    
    db.run(
        `UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?`,
        [quantity, id, user_id],
        function(err) {
            if (err) {
                console.error('更新购物车数量失败:', err.message);
                return res.status(500).json({ success: false, message: '更新购物车数量失败' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: '购物车项不存在' });
            }
            
            res.status(200).json({ success: true, message: '购物车已更新' });
        }
    );
});

// 删除购物车项
app.delete('/api/cart/delete/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const user_id = req.user.id;
    
    db.run(
        `DELETE FROM cart_items WHERE id = ? AND user_id = ?`,
        [id, user_id],
        function(err) {
            if (err) {
                console.error('删除购物车项失败:', err.message);
                return res.status(500).json({ success: false, message: '删除购物车项失败' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: '购物车项不存在' });
            }
            
            res.status(200).json({ success: true, message: '购物车项已删除' });
        }
    );
});

function normalizeAddressPayload(raw = {}) {
    const consigneeName = String(raw.consignee_name || raw.receiver_name || '').trim();
    const phone = String(raw.phone || raw.receiver_phone || '').trim();
    const provinceCode = String(raw.province_code || '').trim();
    const provinceName = String(raw.province_name || raw.receiver_province || '').trim();
    const cityCode = String(raw.city_code || '').trim();
    const cityName = String(raw.city_name || raw.receiver_city || '').trim();
    const districtCode = String(raw.district_code || '').trim();
    const districtName = String(raw.district_name || raw.receiver_district || '').trim();
    const townCode = String(raw.town_code || '').trim();
    const townName = String(raw.town_name || raw.receiver_town || '').trim();
    const detailAddress = String(raw.detail_address || raw.receiver_address || '').trim();
    const tag = String(raw.tag || '').trim();
    const fullAddress = `${provinceName}${cityName}${districtName}${townName}${detailAddress}`.trim();
    return {
        consignee_name: consigneeName,
        phone,
        province_code: provinceCode,
        province_name: provinceName,
        city_code: cityCode,
        city_name: cityName,
        district_code: districtCode,
        district_name: districtName,
        town_code: townCode,
        town_name: townName,
        detail_address: detailAddress,
        full_address: fullAddress,
        tag,
        is_default: raw.is_default === true || raw.is_default === 1 || raw.is_default === '1'
    };
}

// 行政区级联（高德 district API 代理）
app.get('/api/geo/districts', async (req, res) => {
    try {
        if (!AMAP_WEB_KEY) {
            return res.status(503).json({ success: false, message: '高德地图KEY未配置' });
        }
        const keywords = String(req.query.keywords || req.query.parent_code || req.query.parentCode || '中国').trim();
        const subdistrict = Math.max(0, Math.min(3, Number(req.query.subdistrict) || 1));
        const level = String(req.query.level || '').trim();
        const url = 'https://restapi.amap.com/v3/config/district';
        const resp = await axios.get(url, {
            params: {
                key: AMAP_WEB_KEY,
                keywords,
                subdistrict,
                extensions: 'base'
            },
            timeout: 7000
        });
        const data = resp && resp.data ? resp.data : {};
        if (String(data.status) !== '1') {
            return res.status(502).json({ success: false, message: data.info || '高德行政区查询失败' });
        }
        const root = Array.isArray(data.districts) && data.districts.length ? data.districts[0] : null;
        let districts = Array.isArray(root?.districts) ? root.districts : [];
        if (level) {
            districts = districts.filter((d) => String(d?.level || '') === level);
        }
        const items = districts.map((d) => ({
            name: String(d?.name || ''),
            adcode: String(d?.adcode || ''),
            level: String(d?.level || ''),
            citycode: String(d?.citycode || ''),
            center: String(d?.center || '')
        })).filter((x) => x.name);
        res.status(200).json({
            success: true,
            parent: root ? {
                name: String(root.name || ''),
                adcode: String(root.adcode || ''),
                level: String(root.level || '')
            } : null,
            items
        });
    } catch (error) {
        console.error('geo/districts:', error);
        res.status(500).json({ success: false, message: '获取行政区失败' });
    }
});

// 地址簿：列表
app.get('/api/addresses', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const rows = await dbAllAsync(
            `SELECT id, user_id, consignee_name, phone,
                    province_code, province_name, city_code, city_name,
                    district_code, district_name, town_code, town_name,
                    detail_address, full_address, tag, is_default, created_at, updated_at
             FROM user_addresses
             WHERE user_id = ?
             ORDER BY is_default DESC, datetime(updated_at) DESC, id DESC`,
            [userId]
        );
        res.status(200).json({ success: true, addresses: rows || [] });
    } catch (error) {
        console.error('addresses/list:', error);
        res.status(500).json({ success: false, message: '获取地址簿失败' });
    }
});

// 地址簿：新增
app.post('/api/addresses', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const addr = normalizeAddressPayload(req.body || {});
        if (!addr.consignee_name || !addr.phone || !addr.detail_address || !addr.full_address || !addr.province_name || !addr.city_name || !addr.district_name) {
            return res.status(400).json({ success: false, message: '请完整填写收货信息（含省市区与详细地址）' });
        }
        if (addr.is_default) {
            await dbRunAsync(`UPDATE user_addresses SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [userId]);
        }
        const run = await dbRunAsync(
            `INSERT INTO user_addresses (
                user_id, consignee_name, phone,
                province_code, province_name, city_code, city_name,
                district_code, district_name, town_code, town_name,
                detail_address, full_address, tag, is_default, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                userId, addr.consignee_name, addr.phone,
                addr.province_code, addr.province_name, addr.city_code, addr.city_name,
                addr.district_code, addr.district_name, addr.town_code, addr.town_name,
                addr.detail_address, addr.full_address, addr.tag, addr.is_default ? 1 : 0
            ]
        );
        const created = await dbGetAsync(`SELECT * FROM user_addresses WHERE id = ? AND user_id = ?`, [Number(run.lastID), userId]);
        res.status(200).json({ success: true, address: created });
    } catch (error) {
        console.error('addresses/create:', error);
        res.status(500).json({ success: false, message: '新建地址失败' });
    }
});

// 地址簿：编辑
app.put('/api/addresses/:id', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const id = Number(req.params.id);
        const exists = await dbGetAsync(`SELECT id FROM user_addresses WHERE id = ? AND user_id = ?`, [id, userId]);
        if (!exists) return res.status(404).json({ success: false, message: '地址不存在' });
        const addr = normalizeAddressPayload(req.body || {});
        if (!addr.consignee_name || !addr.phone || !addr.detail_address || !addr.full_address || !addr.province_name || !addr.city_name || !addr.district_name) {
            return res.status(400).json({ success: false, message: '请完整填写收货信息（含省市区与详细地址）' });
        }
        if (addr.is_default) {
            await dbRunAsync(`UPDATE user_addresses SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [userId]);
        }
        await dbRunAsync(
            `UPDATE user_addresses
             SET consignee_name = ?, phone = ?,
                 province_code = ?, province_name = ?, city_code = ?, city_name = ?,
                 district_code = ?, district_name = ?, town_code = ?, town_name = ?,
                 detail_address = ?, full_address = ?, tag = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND user_id = ?`,
            [
                addr.consignee_name, addr.phone,
                addr.province_code, addr.province_name, addr.city_code, addr.city_name,
                addr.district_code, addr.district_name, addr.town_code, addr.town_name,
                addr.detail_address, addr.full_address, addr.tag, addr.is_default ? 1 : 0,
                id, userId
            ]
        );
        const updated = await dbGetAsync(`SELECT * FROM user_addresses WHERE id = ? AND user_id = ?`, [id, userId]);
        res.status(200).json({ success: true, address: updated });
    } catch (error) {
        console.error('addresses/update:', error);
        res.status(500).json({ success: false, message: '更新地址失败' });
    }
});

// 地址簿：删除
app.delete('/api/addresses/:id', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const id = Number(req.params.id);
        const existed = await dbGetAsync(`SELECT id, is_default FROM user_addresses WHERE id = ? AND user_id = ?`, [id, userId]);
        if (!existed) return res.status(404).json({ success: false, message: '地址不存在' });
        await dbRunAsync(`DELETE FROM user_addresses WHERE id = ? AND user_id = ?`, [id, userId]);
        if (Number(existed.is_default) === 1) {
            const fallback = await dbGetAsync(`SELECT id FROM user_addresses WHERE user_id = ? ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1`, [userId]);
            if (fallback?.id) {
                await dbRunAsync(`UPDATE user_addresses SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [Number(fallback.id), userId]);
            }
        }
        res.status(200).json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('addresses/delete:', error);
        res.status(500).json({ success: false, message: '删除地址失败' });
    }
});

// 地址簿：设默认
app.put('/api/addresses/:id/default', authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.id);
        const id = Number(req.params.id);
        const existed = await dbGetAsync(`SELECT id FROM user_addresses WHERE id = ? AND user_id = ?`, [id, userId]);
        if (!existed) return res.status(404).json({ success: false, message: '地址不存在' });
        await dbRunAsync(`UPDATE user_addresses SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, [userId]);
        await dbRunAsync(`UPDATE user_addresses SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [id, userId]);
        const address = await dbGetAsync(`SELECT * FROM user_addresses WHERE id = ? AND user_id = ?`, [id, userId]);
        res.status(200).json({ success: true, address });
    } catch (error) {
        console.error('addresses/default:', error);
        res.status(500).json({ success: false, message: '设置默认地址失败' });
    }
});

// ================= 订单API =================

// 创建订单
app.post('/api/orders', authenticateToken, async (req, res) => {
    try {
        const user_id = Number(req.user.id);
        const {
            payment_method,
            address_id,
            shipping_address,
            shipping_info = {},
            invoice_info = {}
        } = req.body || {};
        const paymentMethod = String(payment_method || '').trim();
        if (!paymentMethod) {
            return res.status(400).json({ success: false, message: '请提供支付方式' });
        }
        const cartItems = await dbAllAsync(
            `SELECT ci.id, ci.user_id, ci.book_id, ci.quantity, b.title, b.author, b.price
             FROM cart_items ci
             JOIN books b ON ci.book_id = b.id
             WHERE ci.user_id = ?`,
            [user_id]
        );
        if (!cartItems.length) {
            return res.status(400).json({ success: false, message: '购物车为空' });
        }
        const totalAmount = cartItems.reduce((sum, item) => sum + (Number(item.price) * Number(item.quantity)), 0);
        const orderNo = makeOrderNo();
        let receiverName = String(shipping_info.receiver_name || '').trim();
        let receiverPhone = String(shipping_info.receiver_phone || '').trim();
        let receiverProvince = String(shipping_info.receiver_province || '').trim();
        let receiverCity = String(shipping_info.receiver_city || '').trim();
        let receiverDistrict = String(shipping_info.receiver_district || '').trim();
        let receiverTown = String(shipping_info.receiver_town || '').trim();
        let receiverAddress = String(shipping_info.receiver_address || '').trim();
        const selectedAddressId = Number(address_id || 0);
        if (selectedAddressId > 0) {
            const saved = await dbGetAsync(
                `SELECT id, consignee_name, phone, province_name, city_name, district_name, town_name, detail_address, full_address
                 FROM user_addresses
                 WHERE id = ? AND user_id = ?`,
                [selectedAddressId, user_id]
            );
            if (!saved) {
                return res.status(400).json({ success: false, message: '所选历史地址不存在或无权限' });
            }
            receiverName = String(saved.consignee_name || '').trim();
            receiverPhone = String(saved.phone || '').trim();
            receiverProvince = String(saved.province_name || '').trim();
            receiverCity = String(saved.city_name || '').trim();
            receiverDistrict = String(saved.district_name || '').trim();
            receiverTown = String(saved.town_name || '').trim();
            receiverAddress = String(saved.detail_address || '').trim();
        }
        let shippingAddress = String(shipping_address || '').trim();
        if (!shippingAddress) {
            shippingAddress = `${receiverProvince}${receiverCity}${receiverDistrict}${receiverTown}${receiverAddress}`.trim();
        }
        if (!shippingAddress || !receiverName || !receiverPhone || !receiverAddress) {
            return res.status(400).json({ success: false, message: '请提供完整收货信息（姓名、手机号、省市区与详细地址）' });
        }
        const routeInfo = await buildShippingRouteFromAddress(shippingAddress);
        const invoiceType = ['none', 'personal', 'company'].includes(String(invoice_info.invoice_type || 'none'))
            ? String(invoice_info.invoice_type || 'none')
            : 'none';
        const invoiceTitle = String(invoice_info.invoice_title || '').trim();
        const invoiceTaxNo = String(invoice_info.invoice_tax_no || '').trim();
        const invoiceEmail = String(invoice_info.invoice_email || '').trim();

        const orderRun = await dbRunAsync(
            `INSERT INTO orders (
                order_no, user_id, total_amount, status, payment_method, shipping_address,
                pay_status, receiver_name, receiver_phone, receiver_province, receiver_city, receiver_district, receiver_town, receiver_address,
                invoice_type, invoice_title, invoice_tax_no, invoice_email, invoice_status,
                shipping_status, shipping_updated_at, eta_at, delivery_sla_hours,
                origin_lng, origin_lat, dest_lng, dest_lat, route_distance_m, route_duration_s, route_source, updated_at
            ) VALUES (?, ?, ?, 'paid', ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_issued', 'pending', CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                orderNo, user_id, totalAmount, paymentMethod, shippingAddress,
                receiverName, receiverPhone, receiverProvince, receiverCity, receiverDistrict, receiverTown, receiverAddress,
                invoiceType, invoiceTitle, invoiceTaxNo, invoiceEmail,
                routeInfo.etaAt, Number(routeInfo.slaHours || 72),
                Number(routeInfo.origin?.lng || 0), Number(routeInfo.origin?.lat || 0),
                Number(routeInfo.dest?.lng || 0), Number(routeInfo.dest?.lat || 0),
                Number(routeInfo.route?.distance_m || 0), Number(routeInfo.route?.duration_s || 0),
                String(routeInfo.source || 'mock')
            ]
        );
        const orderId = Number(orderRun.lastID);

        for (const item of cartItems) {
            await dbRunAsync(
                `INSERT INTO order_items (order_id, book_id, quantity, price) VALUES (?, ?, ?, ?)`,
                [orderId, Number(item.book_id), Number(item.quantity), Number(item.price)]
            );
        }
        const routeNodes = buildRouteNodes(routeInfo, receiverAddress || shippingAddress);
        await saveShippingRouteNodes(orderId, routeNodes);
        await dbRunAsync(`DELETE FROM cart_items WHERE user_id = ?`, [user_id]);
        await dbRunAsync(
            `INSERT INTO shipping_tracks (order_id, status, node_code, content, location, lng, lat, seq, is_exception, operator_id)
             VALUES (?, 'pending', 'ORDER_CREATED', ?, ?, ?, ?, 1, 0, ?)`,
            [
                orderId,
                routeInfo.source === 'amap' ? '订单创建，已生成高德路线与预计送达时间' : '订单创建，已生成模拟物流路线',
                SHIPPING_ORIGIN_ADDRESS,
                Number(routeInfo.origin?.lng || 0),
                Number(routeInfo.origin?.lat || 0),
                user_id
            ]
        );

        cartItems.forEach((item) => {
            recordRecoEvent(user_id, item.book_id, 'purchase', Math.max(1, Number(item.quantity) || 1), 'order_checkout');
        });
        res.status(200).json({
            success: true,
            message: '订单创建成功',
            order_id: orderId,
            order_no: orderNo,
            total_amount: Number(totalAmount.toFixed(2)),
            shipping: {
                status: 'pending',
                eta_at: routeInfo.etaAt,
                route_source: routeInfo.source,
                distance_m: Number(routeInfo.route?.distance_m || 0),
                duration_s: Number(routeInfo.route?.duration_s || 0)
            }
        });
    } catch (error) {
        console.error('创建订单失败:', error);
        res.status(500).json({ success: false, message: '创建订单失败' });
    }
});

// 获取订单列表
app.get('/api/orders', authenticateToken, async (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
        const status = String(req.query.status || '').trim();
        const user_id = Number(req.user.id);
        const offset = (page - 1) * limit;
        let whereClause = 'WHERE o.user_id = ?';
        const params = [user_id];
        if (status) {
            whereClause += ' AND o.status = ?';
            params.push(status);
        }
        const orders = await dbAllAsync(
            `SELECT o.id, o.order_no, o.user_id, o.total_amount, o.status, o.pay_status, o.payment_method, o.shipping_address,
                    o.receiver_name, o.receiver_phone, o.created_at, o.updated_at, o.shipping_status, o.eta_at, o.shipping_is_delayed,
                    o.shipping_exception_code, o.shipping_exception_text
             FROM orders o
             ${whereClause}
             ORDER BY o.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const totalRow = await dbGetAsync(`SELECT COUNT(*) AS total FROM orders o ${whereClause}`, params);
        res.status(200).json({
            success: true,
            orders,
            total: Number(totalRow?.total || 0),
            currentPage: page,
            totalPages: Math.ceil(Number(totalRow?.total || 0) / limit)
        });
    } catch (error) {
        console.error('获取订单列表失败:', error);
        res.status(500).json({ success: false, message: '获取订单列表失败' });
    }
});

// 获取订单详情
app.get('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const user_id = Number(req.user.id);
        const order = await dbGetAsync(
            `SELECT o.*
             FROM orders o
             WHERE o.id = ? AND o.user_id = ?`,
            [id, user_id]
        );
        if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
        const items = await dbAllAsync(
            `SELECT oi.id, oi.order_id, oi.book_id, oi.quantity, oi.price,
                    b.title, b.author, b.cover_url
             FROM order_items oi
             JOIN books b ON oi.book_id = b.id
             WHERE oi.order_id = ?`,
            [id]
        );
        const tracks = await dbAllAsync(
            `SELECT id, order_id, status, node_code, content, location, lng, lat, seq, is_exception, created_at
             FROM shipping_tracks
             WHERE order_id = ?
             ORDER BY seq ASC, datetime(created_at) ASC`,
            [id]
        );
        const refund = await dbGetAsync(
            `SELECT id, refund_type, reason_code, reason_text, request_amount, description, status, admin_reply, created_at, updated_at, reviewed_at
             FROM refund_requests
             WHERE order_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [id]
        );
        const routeNodes = await dbAllAsync(
            `SELECT seq, status, content, location, lng, lat, distance_m, duration_s, is_done
             FROM shipping_route_nodes
             WHERE order_id = ?
             ORDER BY seq ASC`,
            [id]
        );
        res.status(200).json({ success: true, order: { ...order, items, shipping_tracks: tracks, shipping_route_nodes: routeNodes, refund } });
    } catch (error) {
        console.error('获取订单详情失败:', error);
        res.status(500).json({ success: false, message: '获取订单详情失败' });
    }
});

app.get('/api/orders/:id/shipping', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const user_id = Number(req.user.id);
        const order = await dbGetAsync(
            `SELECT id, order_no, shipping_status, shipping_company, tracking_no, eta_at, shipping_is_delayed, shipping_delay_minutes,
                    shipping_exception_code, shipping_exception_text, route_source, route_distance_m, route_duration_s
             FROM orders WHERE id = ? AND user_id = ?`,
            [id, user_id]
        );
        if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
        const tracks = await dbAllAsync(
            `SELECT id, status, node_code, content, location, lng, lat, seq, is_exception, created_at
             FROM shipping_tracks WHERE order_id = ? ORDER BY seq ASC, datetime(created_at) ASC`,
            [id]
        );
        const routeNodes = await dbAllAsync(
            `SELECT seq, status, content, location, lng, lat, distance_m, duration_s, is_done
             FROM shipping_route_nodes
             WHERE order_id = ?
             ORDER BY seq ASC`,
            [id]
        );
        res.status(200).json({ success: true, shipping: { ...order, tracks, route_nodes: routeNodes } });
    } catch (error) {
        console.error('获取物流信息失败:', error);
        res.status(500).json({ success: false, message: '获取物流信息失败' });
    }
});

app.post('/api/orders/:id/cancel', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const user_id = Number(req.user.id);
        const reasonCode = String(req.body?.reason_code || 'other').trim();
        const reasonText = String(req.body?.reason_text || '').trim();
        const order = await dbGetAsync(`SELECT id, status FROM orders WHERE id = ? AND user_id = ?`, [id, user_id]);
        if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
        if (!['pending', 'paid'].includes(String(order.status))) {
            return res.status(400).json({ success: false, message: '当前订单状态不允许取消' });
        }
        await dbRunAsync(
            `UPDATE orders
             SET status = 'cancelled', cancel_reason_code = ?, cancel_reason_text = ?, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [reasonCode, reasonText, id]
        );
        await dbRunAsync(
            `INSERT INTO shipping_tracks (order_id, status, node_code, content, location, seq, is_exception, operator_id)
             VALUES (?, 'cancelled', 'ORDER_CANCELLED', ?, '', 999, 0, ?)`,
            [id, `订单已取消：${reasonText || reasonCode}`, user_id]
        );
        res.status(200).json({ success: true, message: '订单已取消' });
    } catch (error) {
        console.error('取消订单失败:', error);
        res.status(500).json({ success: false, message: '取消订单失败' });
    }
});

app.post('/api/orders/:id/refund', authenticateToken, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const user_id = Number(req.user.id);
        const refundType = ['only_refund', 'return_refund'].includes(String(req.body?.refund_type || 'only_refund'))
            ? String(req.body?.refund_type || 'only_refund')
            : 'only_refund';
        const reasonCode = String(req.body?.reason_code || 'other').trim();
        const reasonText = String(req.body?.reason_text || '').trim();
        const description = String(req.body?.description || '').trim();
        const order = await dbGetAsync(`SELECT id, total_amount, status FROM orders WHERE id = ? AND user_id = ?`, [id, user_id]);
        if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
        if (!['paid', 'shipped', 'delivered'].includes(String(order.status))) {
            return res.status(400).json({ success: false, message: '当前订单状态不允许退款' });
        }
        const pending = await dbGetAsync(
            `SELECT id FROM refund_requests WHERE order_id = ? AND status = 'pending' LIMIT 1`,
            [id]
        );
        if (pending) return res.status(400).json({ success: false, message: '已有待处理退款申请' });
        const requestAmount = Math.min(Number(req.body?.request_amount || order.total_amount), Number(order.total_amount));
        await dbRunAsync(
            `INSERT INTO refund_requests (order_id, user_id, refund_type, reason_code, reason_text, request_amount, description, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [id, user_id, refundType, reasonCode, reasonText, requestAmount, description]
        );
        await dbRunAsync(`UPDATE orders SET status = 'refunding', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
        res.status(200).json({ success: true, message: '退款申请已提交' });
    } catch (error) {
        console.error('申请退款失败:', error);
        res.status(500).json({ success: false, message: '申请退款失败' });
    }
});

// 更新订单状态
app.put('/api/orders/:id/status', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const user_id = req.user.id;
    
    if (!status || !['pending', 'paid', 'shipped', 'delivered', 'cancelled'].includes(status)) {
        return res.status(400).json({ success: false, message: '请提供有效的订单状态' });
    }
    
    // 检查订单是否存在且属于当前用户
    db.get(
        `SELECT * FROM orders WHERE id = ? AND user_id = ?`,
        [id, user_id],
        (err, order) => {
            if (err) {
                console.error('检查订单失败:', err.message);
                return res.status(500).json({ success: false, message: '检查订单失败' });
            }
            
            if (!order) {
                return res.status(404).json({ success: false, message: '订单不存在' });
            }
            
            // 更新订单状态
            db.run(
                `UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [status, id],
                function(err) {
                    if (err) {
                        console.error('更新订单状态失败:', err.message);
                        return res.status(500).json({ success: false, message: '更新订单状态失败' });
                    }
                    
                    res.status(200).json({
                        success: true,
                        message: '订单状态更新成功',
                        order_id: id,
                        status: status
                    });
                }
            );
        }
    );
});

app.get('/api/admin/shipping/orders', authenticateAdmin, async (req, res) => {
    try {
        const status = String(req.query.status || '').trim();
        let where = '';
        const params = [];
        if (status) {
            where = 'WHERE status = ?';
            params.push(status);
        }
        const rows = await dbAllAsync(
            `SELECT id, order_no, user_id, total_amount, status, shipping_status, eta_at, shipping_is_delayed, shipping_delay_minutes,
                    shipping_exception_code, shipping_exception_text, shipping_company, tracking_no, created_at
             FROM orders ${where}
             ORDER BY datetime(created_at) DESC
             LIMIT 300`,
            params
        );
        res.status(200).json({ success: true, orders: rows });
    } catch (error) {
        console.error('获取物流订单失败:', error);
        res.status(500).json({ success: false, message: '获取物流订单失败' });
    }
});

app.get('/api/admin/shipping/exceptions', authenticateAdmin, async (req, res) => {
    try {
        const rows = await dbAllAsync(
            `SELECT id, order_no, user_id, shipping_status, shipping_exception_code, shipping_exception_text,
                    shipping_delay_minutes, eta_at, updated_at
             FROM orders
             WHERE shipping_status = 'exception' OR shipping_is_delayed = 1
             ORDER BY datetime(updated_at) DESC
             LIMIT 300`
        );
        res.status(200).json({ success: true, orders: rows });
    } catch (error) {
        console.error('获取异常物流失败:', error);
        res.status(500).json({ success: false, message: '获取异常物流失败' });
    }
});

app.put('/api/admin/orders/:id/shipping', authenticateAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        let shippingStatus = String(req.body?.shipping_status || '').trim();
        const statusAllowed = ['pending', 'picked', 'in_transit', 'delivering', 'signed', 'exception'];
        let content = String(req.body?.content || '').trim();
        let location = String(req.body?.location || '').trim();
        const shippingCompany = String(req.body?.shipping_company || '').trim();
        const trackingNo = String(req.body?.tracking_no || '').trim();
        const now = Date.now();
        const order = await dbGetAsync(`SELECT id, created_at, eta_at FROM orders WHERE id = ?`, [id]);
        if (!order) return res.status(404).json({ success: false, message: '订单不存在' });
        if (!shippingStatus) {
            const nextNode = await popNextRouteNode(id);
            if (nextNode) {
                shippingStatus = String(nextNode.status || '').trim();
                if (!content) content = String(nextNode.content || '').trim();
                if (!location) location = String(nextNode.location || '').trim();
            }
        }
        const fullOrder = await dbGetAsync(`SELECT shipping_address, receiver_province FROM orders WHERE id = ?`, [id]);
        const originProvince = extractProvinceText(SHIPPING_ORIGIN_ADDRESS) || '发货地';
        const destProvince = extractProvinceText(fullOrder?.receiver_province || fullOrder?.shipping_address || '') || '收货地';
        if (shippingStatus === 'picked') {
            content = '包裹已揽收';
            location = originProvince;
        } else if (shippingStatus === 'in_transit') {
            content = '包裹运输中';
            location = originProvince !== destProvince ? '跨省干线运输（途经中转省份）' : `${destProvince}省内运输`;
        } else if (shippingStatus === 'delivering') {
            content = '包裹派送中';
            location = destProvince;
        } else if (shippingStatus === 'signed') {
            content = '包裹已签收';
            location = destProvince;
        }
        if (!statusAllowed.includes(shippingStatus)) {
            return res.status(400).json({ success: false, message: '无效物流状态' });
        }
        if (!content) content = `物流状态更新为：${shippingStatus}`;
        const seqRow = await dbGetAsync(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM shipping_tracks WHERE order_id = ?`, [id]);
        const seq = Number(seqRow?.max_seq || 0) + 1;
        let etaAt = String(order.eta_at || addHoursIso(72));
        const etaMs = Date.parse(etaAt);
        const delayMin = Number.isFinite(etaMs) ? Math.max(0, Math.floor((now - etaMs) / 60000)) : 0;
        let isDelayed = delayMin > 0 ? 1 : 0;
        let exceptionCode = '';
        let exceptionText = '';
        if (shippingStatus === 'exception') {
            isDelayed = 1;
            exceptionCode = String(req.body?.exception_code || 'MANUAL_EXCEPTION').trim();
            exceptionText = String(req.body?.exception_text || content).trim();
            etaAt = addHoursIso(12);
        } else if (shippingStatus === 'signed') {
            isDelayed = delayMin > 0 ? 1 : 0;
        }
        await dbRunAsync(
            `UPDATE orders
             SET shipping_status = ?, shipping_company = COALESCE(NULLIF(?, ''), shipping_company),
                 tracking_no = COALESCE(NULLIF(?, ''), tracking_no), shipping_updated_at = CURRENT_TIMESTAMP,
                 eta_at = ?, shipping_is_delayed = ?, shipping_delay_minutes = ?,
                 shipping_exception_code = ?, shipping_exception_text = ?, status = CASE WHEN ? = 'signed' THEN 'delivered' ELSE status END,
                 signed_at = CASE WHEN ? = 'signed' THEN CURRENT_TIMESTAMP ELSE signed_at END,
                 shipped_at = CASE WHEN ? IN ('picked','in_transit','delivering','signed') AND shipped_at IS NULL THEN CURRENT_TIMESTAMP ELSE shipped_at END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                shippingStatus, shippingCompany, trackingNo, etaAt, isDelayed, delayMin,
                exceptionCode, exceptionText, shippingStatus, shippingStatus, shippingStatus, id
            ]
        );
        await dbRunAsync(
            `INSERT INTO shipping_tracks (order_id, status, node_code, content, location, seq, is_exception, operator_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [id, shippingStatus, shippingStatus.toUpperCase(), content, location, seq, shippingStatus === 'exception' ? 1 : 0, Number(req.user.id)]
        );
        res.status(200).json({ success: true, message: '物流状态更新成功' });
    } catch (error) {
        console.error('更新物流状态失败:', error);
        res.status(500).json({ success: false, message: '更新物流状态失败' });
    }
});

app.get('/api/admin/refunds', authenticateAdmin, async (req, res) => {
    try {
        const status = String(req.query.status || '').trim();
        let where = '';
        const params = [];
        if (status) {
            where = 'WHERE r.status = ?';
            params.push(status);
        }
        const rows = await dbAllAsync(
            `SELECT r.*, o.order_no, o.total_amount, u.username
             FROM refund_requests r
             JOIN orders o ON o.id = r.order_id
             JOIN users u ON u.id = r.user_id
             ${where}
             ORDER BY datetime(r.created_at) DESC
             LIMIT 300`,
            params
        );
        res.status(200).json({ success: true, refunds: rows });
    } catch (error) {
        console.error('获取退款申请失败:', error);
        res.status(500).json({ success: false, message: '获取退款申请失败' });
    }
});

app.put('/api/admin/refunds/:id/review', authenticateAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const action = String(req.body?.action || '').trim();
        const adminReply = String(req.body?.admin_reply || '').trim();
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, message: '无效操作' });
        }
        const target = await dbGetAsync(`SELECT id, order_id, status FROM refund_requests WHERE id = ?`, [id]);
        if (!target) return res.status(404).json({ success: false, message: '退款申请不存在' });
        if (target.status !== 'pending') return res.status(400).json({ success: false, message: '该退款申请已处理' });
        const next = action === 'approve' ? 'approved' : 'rejected';
        await dbRunAsync(
            `UPDATE refund_requests
             SET status = ?, admin_reply = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [next, adminReply, Number(req.user.id), id]
        );
        if (action === 'approve') {
            await dbRunAsync(
                `UPDATE orders SET status = 'refunded', pay_status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [target.order_id]
            );
        }
        res.status(200).json({ success: true, message: action === 'approve' ? '已通过退款申请' : '已驳回退款申请' });
    } catch (error) {
        console.error('审核退款失败:', error);
        res.status(500).json({ success: false, message: '审核退款失败' });
    }
});

// ================= 管理员图书管理API =================

// 添加图书
app.post('/api/admin/books', authenticateAdmin, (req, res) => {
    const { title, author, description, price, category, cover_url, stock_quantity } = req.body;
    
    // 验证必填字段
    if (!title || !author || !description || !price || !category || stock_quantity === undefined || stock_quantity === null) {
        return res.status(400).json({ success: false, message: '请提供完整的图书信息' });
    }
    
    // 检查价格和库存数量是否为有效数字
    if (isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
        return res.status(400).json({ success: false, message: '请提供有效的价格' });
    }
    
    if (isNaN(parseInt(stock_quantity)) || parseInt(stock_quantity) < 0) {
        return res.status(400).json({ success: false, message: '请提供有效的库存数量' });
    }
    
    // 添加图书
    db.run(
        `INSERT INTO books (title, author, description, price, category, cover_url, stock_quantity, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [title, author, description, parseFloat(price), category, cover_url, parseInt(stock_quantity)],
        function(err) {
            if (err) {
                console.error('添加图书失败:', err.message);
                return res.status(500).json({ success: false, message: '添加图书失败' });
            }
            
            res.status(201).json({ 
                success: true, 
                message: '图书添加成功', 
                book_id: this.lastID 
            });
        }
    );
});

// 获取所有图书（管理员）
app.get('/api/admin/books', authenticateAdmin, (req, res) => {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (page - 1) * limit;
    let whereClause = '';
    let params = [];
    
    if (search) {
        whereClause = 'WHERE title LIKE ? OR author LIKE ?';
        params.push(`%${search}%`, `%${search}%`);
    }
    
    // 查询图书列表
    db.all(
        `SELECT id, title, author, description, price, category, cover_url, stock_quantity, shelf_status, created_at, updated_at 
         FROM books 
         ${whereClause} 
         ORDER BY created_at DESC 
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
        (err, books) => {
            if (err) {
                console.error('获取图书列表失败:', err.message);
                return res.status(500).json({ success: false, message: '获取图书列表失败' });
            }
            
            // 查询总记录数
            db.get(
                `SELECT COUNT(*) AS total FROM books ${whereClause}`,
                params,
                (err, result) => {
                    if (err) {
                        console.error('获取图书总数失败:', err.message);
                        return res.status(500).json({ success: false, message: '获取图书总数失败' });
                    }
                    
                    res.status(200).json({
                        success: true,
                        books: books,
                        total: result.total,
                        currentPage: parseInt(page),
                        totalPages: Math.ceil(result.total / limit)
                    });
                }
            );
        }
    );
});

// 更新图书
app.put('/api/admin/books/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const { title, author, description, price, category, cover_url, stock_quantity, shelf_status } = req.body;
    
    // 检查图书是否存在
    db.get('SELECT id FROM books WHERE id = ?', [id], (err, book) => {
        if (err) {
            console.error('检查图书失败:', err.message);
            return res.status(500).json({ success: false, message: '检查图书失败' });
        }
        
        if (!book) {
            return res.status(404).json({ success: false, message: '图书不存在' });
        }
        
        // 更新图书信息
        const updateFields = [];
        const updateParams = [];
        
        if (title) { updateFields.push('title = ?'); updateParams.push(title); }
        if (author) { updateFields.push('author = ?'); updateParams.push(author); }
        if (description) { updateFields.push('description = ?'); updateParams.push(description); }
        if (price !== undefined) { 
            if (isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
                return res.status(400).json({ success: false, message: '请提供有效的价格' });
            }
            updateFields.push('price = ?'); 
            updateParams.push(parseFloat(price)); 
        }
        if (category) { updateFields.push('category = ?'); updateParams.push(category); }
        if (cover_url !== undefined) { updateFields.push('cover_url = ?'); updateParams.push(cover_url); }
        if (stock_quantity !== undefined) { 
            if (isNaN(parseInt(stock_quantity)) || parseInt(stock_quantity) < 0) {
                return res.status(400).json({ success: false, message: '请提供有效的库存数量' });
            }
            updateFields.push('stock_quantity = ?'); 
            updateParams.push(parseInt(stock_quantity)); 
        }
        if (shelf_status !== undefined) {
            const status = String(shelf_status).trim();
            if (!['on_sale', 'off_shelf'].includes(status)) {
                return res.status(400).json({ success: false, message: '无效的上架状态' });
            }
            updateFields.push('shelf_status = ?');
            updateParams.push(status);
        }
        
        updateFields.push('updated_at = CURRENT_TIMESTAMP');
        updateParams.push(id);
        
        db.run(
            `UPDATE books SET ${updateFields.join(', ')} WHERE id = ?`,
            updateParams,
            function(err) {
                if (err) {
                    console.error('更新图书失败:', err.message);
                    return res.status(500).json({ success: false, message: '更新图书失败' });
                }
                
                res.status(200).json({ success: true, message: '图书更新成功' });
            }
        );
    });
});

app.put('/api/admin/books/:id/shelf', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const shelfStatus = String(req.body?.shelf_status || '').trim();
    if (!['on_sale', 'off_shelf'].includes(shelfStatus)) {
        return res.status(400).json({ success: false, message: '无效的上架状态' });
    }
    db.run(
        `UPDATE books
         SET shelf_status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [shelfStatus, id],
        function(err) {
            if (err) {
                console.error('更新图书上架状态失败:', err.message);
                return res.status(500).json({ success: false, message: '更新图书上架状态失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ success: false, message: '图书不存在' });
            }
            res.status(200).json({ success: true, message: shelfStatus === 'on_sale' ? '图书已上架' : '图书已下架' });
        }
    );
});

// 删除图书
app.delete('/api/admin/books/:id', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    
    // 检查图书是否存在
    db.get('SELECT id FROM books WHERE id = ?', [id], (err, book) => {
        if (err) {
            console.error('检查图书失败:', err.message);
            return res.status(500).json({ success: false, message: '检查图书失败' });
        }
        
        if (!book) {
            return res.status(404).json({ success: false, message: '图书不存在' });
        }
        
        // 删除图书
        db.run(
            'DELETE FROM books WHERE id = ?',
            [id],
            function(err) {
                if (err) {
                    console.error('删除图书失败:', err.message);
                    return res.status(500).json({ success: false, message: '删除图书失败' });
                }
                
                res.status(200).json({ success: true, message: '图书删除成功' });
            }
        );
    });
});

// ================= 图书评价API =================

// 添加图书评价
app.post('/api/books/:id/reviews', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { rating, content } = req.body;
    const user_id = req.user.id;
    
    // 验证参数
    if (!rating || !content) {
        return res.status(400).json({ success: false, message: '请提供评分和评价内容' });
    }
    
    if (rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: '评分必须在1-5之间' });
    }
    
    if (content.trim().length < 5) {
        return res.status(400).json({ success: false, message: '评价内容至少需要5个字符' });
    }
    
    // 检查图书是否存在
    db.get('SELECT id FROM books WHERE id = ?', [id], (err, book) => {
        if (err) {
            console.error('检查图书失败:', err.message);
            return res.status(500).json({ success: false, message: '检查图书失败' });
        }
        
        if (!book) {
            return res.status(404).json({ success: false, message: '图书不存在' });
        }
        
        // 检查用户是否已经评价过该图书
        db.get(
            'SELECT id FROM reviews WHERE user_id = ? AND book_id = ?',
            [user_id, id],
            (err, existingReview) => {
                if (err) {
                    console.error('检查评价失败:', err.message);
                    return res.status(500).json({ success: false, message: '检查评价失败' });
                }
                
                if (existingReview) {
                    // 更新评价
                    db.run(
                        `UPDATE reviews SET rating = ?, content = ?, updated_at = CURRENT_TIMESTAMP 
                         WHERE id = ?`,
                        [rating, content, existingReview.id],
                        function(err) {
                            if (err) {
                                console.error('更新评价失败:', err.message);
                                return res.status(500).json({ success: false, message: '更新评价失败' });
                            }
                            recordRecoEvent(user_id, id, 'comment', Math.max(1, Number(rating) / 2), 'book_review');
                            res.status(200).json({ success: true, message: '评价已更新' });
                        }
                    );
                } else {
                    // 添加新评价
                    db.run(
                        `INSERT INTO reviews (user_id, book_id, rating, content) 
                         VALUES (?, ?, ?, ?)`,
                        [user_id, id, rating, content],
                        function(err) {
                            if (err) {
                                console.error('添加评价失败:', err.message);
                                return res.status(500).json({ success: false, message: '添加评价失败' });
                            }
                            recordRecoEvent(user_id, id, 'comment', Math.max(1, Number(rating) / 2), 'book_review');
                            res.status(201).json({ 
                                success: true, 
                                message: '评价成功', 
                                review_id: this.lastID 
                            });
                        }
                    );
                }
            }
        );
    });
});

// 获取图书评价列表
app.get('/api/books/:id/reviews', (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    // 检查图书是否存在
    db.get('SELECT id FROM books WHERE id = ?', [id], (err, book) => {
        if (err) {
            console.error('检查图书失败:', err.message);
            return res.status(500).json({ success: false, message: '检查图书失败' });
        }
        
        if (!book) {
            return res.status(404).json({ success: false, message: '图书不存在' });
        }
        
        // 查询评价列表
        db.all(
            `SELECT r.id, r.user_id, r.book_id, r.rating, r.content, r.created_at, r.updated_at, 
                    u.username 
             FROM reviews r 
             JOIN users u ON r.user_id = u.id 
             WHERE r.book_id = ? 
             ORDER BY r.created_at DESC 
             LIMIT ? OFFSET ?`,
            [id, limit, offset],
            (err, reviews) => {
                if (err) {
                    console.error('获取评价列表失败:', err.message);
                    return res.status(500).json({ success: false, message: '获取评价列表失败' });
                }
                
                // 查询总记录数
                db.get(
                    `SELECT COUNT(*) AS total FROM reviews WHERE book_id = ?`,
                    [id],
                    (err, result) => {
                        if (err) {
                            console.error('获取评价总数失败:', err.message);
                            return res.status(500).json({ success: false, message: '获取评价总数失败' });
                        }
                        
                        // 查询平均评分
                        db.get(
                            `SELECT AVG(rating) AS average_rating FROM reviews WHERE book_id = ?`,
                            [id],
                            (err, avgResult) => {
                                if (err) {
                                    console.error('获取平均评分失败:', err.message);
                                    return res.status(500).json({ success: false, message: '获取平均评分失败' });
                                }
                                
                                res.status(200).json({
                                    success: true,
                                    reviews: reviews,
                                    total: result.total,
                                    currentPage: parseInt(page),
                                    totalPages: Math.ceil(result.total / limit),
                                    averageRating: avgResult.average_rating ? parseFloat(avgResult.average_rating.toFixed(1)) : 0
                                });
                            }
                        );
                    }
                );
            }
        );
    });
});

// 获取用户的评价列表
app.get('/api/users/:id/reviews', (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    // 检查用户是否存在
    db.get('SELECT id FROM users WHERE id = ?', [id], (err, user) => {
        if (err) {
            console.error('检查用户失败:', err.message);
            return res.status(500).json({ success: false, message: '检查用户失败' });
        }
        
        if (!user) {
            return res.status(404).json({ success: false, message: '用户不存在' });
        }
        
        // 查询用户的评价列表
        db.all(
            `SELECT r.id, r.user_id, r.book_id, r.rating, r.content, r.created_at, r.updated_at, 
                    b.title, b.author, b.cover_url 
             FROM reviews r 
             JOIN books b ON r.book_id = b.id 
             WHERE r.user_id = ? 
             ORDER BY r.created_at DESC 
             LIMIT ? OFFSET ?`,
            [id, limit, offset],
            (err, reviews) => {
                if (err) {
                    console.error('获取用户评价列表失败:', err.message);
                    return res.status(500).json({ success: false, message: '获取用户评价列表失败' });
                }
                
                // 查询总记录数
                db.get(
                    `SELECT COUNT(*) AS total FROM reviews WHERE user_id = ?`,
                    [id],
                    (err, result) => {
                        if (err) {
                            console.error('获取评价总数失败:', err.message);
                            return res.status(500).json({ success: false, message: '获取评价总数失败' });
                        }
                        
                        res.status(200).json({
                            success: true,
                            reviews: reviews,
                            total: result.total,
                            currentPage: parseInt(page),
                            totalPages: Math.ceil(result.total / limit)
                        });
                    }
                );
            }
        );
    });
});

// 图书收藏API

// 添加收藏
app.post('/api/favorites/:bookId', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const bookId = parseInt(req.params.bookId);
    
    // 检查图书是否存在
    db.get('SELECT id FROM books WHERE id = ?', [bookId], (err, book) => {
        if (err) {
            console.error('检查图书是否存在失败:', err.message);
            return res.status(500).json({ success: false, message: '检查图书是否存在失败' });
        }
        
        if (!book) {
            return res.status(404).json({ success: false, message: '图书不存在' });
        }
        
        // 添加收藏
        db.run(
            `INSERT OR IGNORE INTO favorites (user_id, book_id, created_at) 
             VALUES (?, ?, CURRENT_TIMESTAMP)`,
            [userId, bookId],
            function(err) {
                if (err) {
                    console.error('添加收藏失败:', err.message);
                    return res.status(500).json({ success: false, message: '添加收藏失败' });
                }
                
                // 检查是否是新插入的记录
                if (this.changes > 0) {
                    recordRecoEvent(userId, bookId, 'favorite', 1, 'book_favorite');
                    res.status(201).json({ 
                        success: true, 
                        message: '收藏成功' 
                    });
                } else {
                    res.status(400).json({ 
                        success: false, 
                        message: '您已经收藏了这本书' 
                    });
                }
            }
        );
    });
});

// 取消收藏
app.delete('/api/favorites/:bookId', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const bookId = parseInt(req.params.bookId);
    
    // 取消收藏
    db.run(
        `DELETE FROM favorites WHERE user_id = ? AND book_id = ?`,
        [userId, bookId],
        function(err) {
            if (err) {
                console.error('取消收藏失败:', err.message);
                return res.status(500).json({ success: false, message: '取消收藏失败' });
            }
            
            if (this.changes > 0) {
                res.json({ 
                    success: true, 
                    message: '取消收藏成功' 
                });
            } else {
                res.status(404).json({ 
                    success: false, 
                    message: '您未收藏这本书' 
                });
            }
        }
    );
});

// 获取用户收藏列表
app.get('/api/favorites', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    // 获取收藏列表
    db.all(
        `SELECT b.*, f.created_at AS favorite_time 
         FROM favorites f 
         JOIN books b ON f.book_id = b.id 
         WHERE f.user_id = ? 
         ORDER BY f.created_at DESC 
         LIMIT ? OFFSET ?`,
        [userId, parseInt(limit), offset],
        (err, favorites) => {
            if (err) {
                console.error('获取收藏列表失败:', err.message);
                return res.status(500).json({ success: false, message: '获取收藏列表失败' });
            }
            
            // 获取总数
            db.get(
                `SELECT COUNT(*) AS total FROM favorites WHERE user_id = ?`,
                [userId],
                (err, result) => {
                    if (err) {
                        console.error('获取收藏总数失败:', err.message);
                        return res.status(500).json({ success: false, message: '获取收藏总数失败' });
                    }
                    
                    res.json({ 
                        success: true, 
                        favorites: favorites,
                        total: result.total,
                        currentPage: parseInt(page),
                        totalPages: Math.ceil(result.total / limit)
                    });
                }
            );
        }
    );
});

// 检查用户是否收藏了某本书
app.get('/api/favorites/:bookId', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const bookId = parseInt(req.params.bookId);
    
    db.get(
        'SELECT id FROM favorites WHERE user_id = ? AND book_id = ?',
        [userId, bookId],
        (err, favorite) => {
            if (err) {
                console.error('检查收藏状态失败:', err.message);
                return res.status(500).json({ success: false, message: '检查收藏状态失败' });
            }
            
            res.json({ 
                success: true, 
                isFavorite: !!favorite
            });
        }
    );
});

// 递归复制文件夹的辅助函数
async function copyFolderRecursive(source, target) {
    const fs = require('fs').promises;
    const path = require('path');
    
    // 确保目标文件夹存在
    await fs.mkdir(target, { recursive: true });
    
    // 读取源文件夹中的所有文件和子文件夹
    const entries = await fs.readdir(source, { withFileTypes: true });
    
    for (const entry of entries) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        
        if (entry.isDirectory()) {
            // 如果是文件夹，递归复制
            await copyFolderRecursive(sourcePath, targetPath);
        } else {
            // 如果是文件，直接复制
            await fs.copyFile(sourcePath, targetPath);
        }
    }
}

// 管理本地视频文件的API（替代剪映草稿文件夹复制功能）
app.post('/api/video/manage-file', authenticateToken, async (req, res) => {
    try {
        console.log('收到/api/video/manage-file请求');
        const fs = require('fs').promises;
        const path = require('path');
        const { taskId, action = 'get-info' } = req.body;
        
        // 检查任务是否存在
        if (!taskId) {
            return res.status(400).json({ success: false, message: '请提供任务ID' });
        }
        
        const task = videoTasks[taskId];
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        // 检查是否有权限访问该任务
        if (task.userId !== req.user.id) {
            return res.status(403).json({ success: false, message: '无权访问此任务' });
        }
        
        // 检查任务状态
        if (task.status !== 'completed') {
            return res.status(400).json({ success: false, message: '视频处理尚未完成' });
        }
        
        // 根据操作类型执行不同的功能
        switch (action) {
            case 'get-info':
                // 获取视频文件信息
                res.status(200).json({
                    success: true,
                    message: '视频信息获取成功',
                    video: {
                        taskId: taskId,
                        title: task.bookInfo?.title || '自动生成视频',
                        url: task.videoUrl,
                        localPath: task.videoPath,
                        createdAt: task.completedAt,
                        bookInfo: task.bookInfo
                    }
                });
                break;
                
            case 'download':
                // 提供视频文件下载链接
                res.status(200).json({
                    success: true,
                    message: '视频下载链接获取成功',
                    downloadUrl: task.videoUrl,
                    fileName: path.basename(task.videoPath)
                });
                break;
                
            default:
                res.status(400).json({ success: false, message: '无效的操作类型' });
        }
        
    } catch (error) {
        console.error('管理视频文件失败:', error);
        res.status(500).json({
            success: false,
            message: '管理视频文件失败，请稍后再试',
            error: error.message
        });
    }
});

// 在指定文件夹中搜索视频文件的API
app.post('/api/video/search-in-folder', async (req, res) => {
    try {
        console.log('收到/api/video/search-in-folder请求');
        console.log('请求头:', req.headers);
        const fs = require('fs').promises;
        const path = require('path');
        const { folderPath } = req.body;
        
        // 默认使用D:\视频文件夹
        const searchPath = folderPath || 'D:\\视频';
        
        // 检查文件夹是否存在
        try {
            await fs.access(searchPath);
        } catch (error) {
            return res.status(404).json({
                success: false,
                message: `文件夹不存在: ${searchPath}`
            });
        }
        
        // 查找视频文件
        let videoUrl = null;
        let videoFileName = null;
        let videoFilePath = null;
        
        try {
            // 递归搜索文件夹中的视频文件
            const videoExtensions = ['.mp4', '.mov', '.avi', '.wmv', '.mkv'];
            
            // 递归搜索函数
            async function searchVideosRecursive(dir) {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    
                    if (entry.isDirectory()) {
                        // 如果是目录，递归搜索
                        const result = await searchVideosRecursive(fullPath);
                        if (result) {
                            return result;
                        }
                    } else {
                        // 检查是否是视频文件
                        if (videoExtensions.some(ext => 
                            entry.name.toLowerCase().endsWith(ext)
                        )) {
                            return {
                                fileName: entry.name,
                                filePath: fullPath
                            };
                        }
                    }
                }
                
                return null;
            }
            
            // 先尝试从temp_videos文件夹查找（作为备选）
            const tempVideosPath = path.join(__dirname, 'temp_videos');
            try {
                const tempVideoResult = await searchVideosRecursive(tempVideosPath);
                if (tempVideoResult) {
                    videoFileName = tempVideoResult.fileName;
                    videoFilePath = tempVideoResult.filePath;
                }
            } catch (error) {
                console.warn('从temp_videos文件夹搜索视频失败:', error);
            }
            
            // 如果temp_videos中没有找到，再从指定路径搜索
            if (!videoFileName) {
                const result = await searchVideosRecursive(searchPath);
                if (result) {
                    videoFileName = result.fileName;
                    videoFilePath = result.filePath;
                }
            }
            
            if (videoFileName) {
                const tempId = `temp_${Date.now()}`;
                
                // 构建视频URL
                videoUrl = `/api/video/serve/${tempId}/${encodeURIComponent(videoFileName)}`;
            }
        } catch (error) {
            console.error('搜索视频文件时出错:', error);
            return res.status(500).json({
                success: false,
                message: `搜索视频文件时出错: ${error.message}`
            });
        }
        
        if (videoUrl) {
            res.status(200).json({
                success: true,
                message: `成功找到视频文件: ${videoFileName}`,
                videoUrl: videoUrl,
                fileName: videoFileName,
                filePath: path.join(searchPath, videoFileName)
            });
        } else {
            res.status(200).json({
                success: false,
                message: `在文件夹 ${searchPath} 中未找到视频文件`,
                searchedPath: searchPath
            });
        }
        
    } catch (error) {
        console.error('搜索视频文件API出错:', error);
        res.status(500).json({
            success: false,
            message: `搜索视频文件失败: ${error.message}`
        });
    }
});

// 提供视频文件访问的API（用于前端直接播放视频）
// 移除authenticateToken中间件，允许未登录用户也能访问视频
app.get('/api/video/serve/:taskId/:fileName', async (req, res) => {
    try {
        const { taskId, fileName } = req.params;
        const decodedFileName = decodeURIComponent(fileName);
        
        // 构建视频文件路径（优先从VIDEO_STORAGE_DIR中查找）
        const videoFilePath = path.join(VIDEO_STORAGE_DIR, decodedFileName);
        
        // 检查文件是否存在
        try {
            await fs.promises.access(videoFilePath);
        } catch (error) {
            console.error('视频文件不存在:', videoFilePath);
            return res.status(404).json({ success: false, message: '视频文件不存在' });
        }
        
        // 设置适当的MIME类型并提供文件下载
        const fsModule = require('fs');
        const fileStream = fsModule.createReadStream(videoFilePath);
        
        // 设置响应头
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `inline; filename="${decodedFileName}"`);
        
        // 流式传输文件
        fileStream.pipe(res);
        
    } catch (error) {
        console.error('提供视频文件时出错:', error);
        res.status(500).json({ success: false, message: '提供视频文件失败，请稍后再试' });
    }
});

// 应用商店API

// 获取应用列表
// 应用列表API - 支持分类和搜索
app.get('/api/apps', function(req, res) {
    try {
        // 获取查询参数
        const approved = req.query.approved === 'true' ? 1 : 0;
        const category = req.query.category || '';
        const search = req.query.search || '';
        
        // 调试信息
        console.log('收到应用列表请求:', {
            method: req.method,
            url: req.url,
            query: req.query,
            approved: approved,
            category: category,
            search: search
        });
        
        // 构建查询语句
        let sql = `SELECT * FROM applications WHERE is_approved = ?`;
        const params = [approved];
        
        // 添加分类条件
        if (category && category.trim() !== '') {
            sql += ` AND category = ?`;
            params.push(category.trim());
        }
        
        // 添加搜索条件
        if (search && search.trim() !== '') {
            sql += ` AND (name LIKE ? OR description LIKE ?)`;
            const searchTerm = `%${search.trim()}%`;
            params.push(searchTerm, searchTerm);
        }
        
        // 添加排序
        sql += ` ORDER BY created_at DESC`;
        
        console.log('执行SQL:', sql);
        console.log('参数:', params);
        
        // 执行查询
        db.all(sql, params, function(err, rows) {
            if (err) {
                console.error('查询应用列表出错:', err.message);
                return res.status(500).json({
                    success: false,
                    message: '服务器内部错误'
                });
            }
            
            console.log('查询到', rows.length, '个应用');
            
            // 返回结果
            res.json({
                success: true,
                apps: rows
            });
        });
    } catch (error) {
        console.error('处理应用列表请求出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误'
        });
    }
});

// 获取单个应用详情
app.get('/api/apps/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM applications WHERE id = ?', [id], (err, app) => {
        if (err) {
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        if (!app) {
            return res.status(404).json({ success: false, message: '应用不存在' });
        }
        
        res.status(200).json({
            success: true,
            app: app
        });
    });
});

// 上传/发布应用
app.post('/api/apps', authenticateToken, (req, res) => {
    const { name, description, icon_url, download_url, category, version } = req.body;
    
    // 验证必填字段
    if (!name || !description || !download_url || !category || !version) {
        return res.status(400).json({ success: false, message: '请填写完整的应用信息' });
    }
    
    // 插入应用信息
    db.run(
        `INSERT INTO applications (name, description, icon_url, download_url, category, version, author, author_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description, icon_url, download_url, category, version, req.user.username, req.user.id],
        function(err) {
            if (err) {
                return res.status(500).json({ success: false, message: '发布应用失败，请稍后再试' });
            }
            
            res.status(201).json({
                success: true,
                message: '应用发布成功，等待管理员审核',
                appId: this.lastID
            });
        }
    );
});

// 下载应用
app.post('/api/apps/:id/download', authenticateToken, (req, res) => {
    const { id } = req.params;
    
    // 检查应用是否存在且已审核通过
    db.get('SELECT * FROM applications WHERE id = ? AND is_approved = 1', [id], (err, app) => {
        if (err) {
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        if (!app) {
            return res.status(404).json({ success: false, message: '应用不存在或未通过审核' });
        }
        
        // 记录下载信息
        db.run(
            'INSERT INTO app_downloads (app_id, user_id) VALUES (?, ?)',
            [id, req.user.id],
            (err) => {
                if (err) {
                    console.error('记录下载信息失败:', err.message);
                }
                
                // 更新下载次数
                db.run('UPDATE applications SET downloads = downloads + 1 WHERE id = ?', [id], (err) => {
                    if (err) {
                        console.error('更新下载次数失败:', err.message);
                    }
                });
            }
        );
        
        res.status(200).json({
            success: true,
            message: '应用下载链接获取成功',
            downloadUrl: app.download_url
        });
    });
});

// 评分应用
app.post('/api/apps/:id/rate', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { rating, comment } = req.body;
    
    // 验证评分
    if (rating === undefined || rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: '评分必须在1-5之间' });
    }
    
    // 检查应用是否存在且已审核通过
    db.get('SELECT * FROM applications WHERE id = ? AND is_approved = 1', [id], (err, app) => {
        if (err) {
            return res.status(500).json({ success: false, message: '服务器错误，请稍后再试' });
        }
        
        if (!app) {
            return res.status(404).json({ success: false, message: '应用不存在或未通过审核' });
        }
        
        // 插入或更新评分
        db.run(
            `INSERT OR REPLACE INTO app_ratings (app_id, user_id, rating, comment, rated_at) 
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [id, req.user.id, rating, comment],
            (err) => {
                if (err) {
                    return res.status(500).json({ success: false, message: '评分失败，请稍后再试' });
                }
                
                // 重新计算平均评分
                db.get('SELECT AVG(rating) as avg_rating FROM app_ratings WHERE app_id = ?', [id], (err, result) => {
                    if (err) {
                        console.error('计算平均评分失败:', err.message);
                    } else {
                        const avgRating = result.avg_rating || 0;
                        db.run('UPDATE applications SET rating = ? WHERE id = ?', [avgRating, id], (err) => {
                            if (err) {
                                console.error('更新平均评分失败:', err.message);
                            }
                        });
                    }
                });
                
                res.status(200).json({
                    success: true,
                    message: '评分成功'
                });
            }
        );
    });
});

// 管理员API - 审核应用
app.post('/api/admin/apps/:id/review', authenticateAdmin, (req, res) => {
    const { id } = req.params;
    const { action, comments } = req.body;
    
    if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ success: false, message: '无效的审核操作' });
    }
    
    db.run(
        'UPDATE applications SET is_approved = ? WHERE id = ?',
        [action === 'approve' ? 1 : 0, id],
        (err) => {
            if (err) {
                return res.status(500).json({ success: false, message: '审核失败，请稍后再试' });
            }
            
            res.status(200).json({
                success: true,
                message: `应用已${action === 'approve' ? '通过' : '拒绝'}审核`
            });
        }
    );
});

// 工作流调用API - 使用Coze API流式响应接口
app.post('/api/coze/workflow/invoke', async (req, res) => {
    try {
        // 使用固定的工作流ID，与用户提供的信息一致
        const WORKFLOW_ID = '7633714095825600546';
        const BOT_ID = '7545799369434677294'; // 用户提供的Bot ID
        const SPACE_ID = '7545798611513196554'; // 用户提供的Space ID
        const DEFAULT_ROLE1_IMAGE = process.env.COZE_DEFAULT_ROLE1_IMAGE
            ? String(process.env.COZE_DEFAULT_ROLE1_IMAGE)
            : { file_id: '7633744454184304655' };
        const DEFAULT_ROLE2_IMAGE = process.env.COZE_DEFAULT_ROLE2_IMAGE
            ? String(process.env.COZE_DEFAULT_ROLE2_IMAGE)
            : { file_id: '7633744783319859246' };
        const { params } = req.body;
        
        // 验证请求数据
        if (!params || typeof params !== 'object') {
            return res.status(400).json({ success: false, message: '请提供有效的工作流参数' });
        }
        
        console.log('====== Coze API调用详细日志 ======');
        console.log('时间:', new Date().toISOString());
        console.log('工作流ID:', WORKFLOW_ID);
        console.log('Bot ID:', BOT_ID);
        console.log('Space ID:', SPACE_ID);
        console.log('工作流参数:', params);
        console.log('API URL:', COZE_API_URL); // 使用配置的API URL
        console.log('API Key长度:', COZE_API_KEY ? COZE_API_KEY.length : '未设置');
        
        const finalParams = {
            ...(params || {}),
            // 工作流要求 role1/role2（Image）时，自动注入默认值，避免客户端必须上传
            role1: (params && params.role1) ? params.role1 : DEFAULT_ROLE1_IMAGE,
            role2: (params && params.role2) ? params.role2 : DEFAULT_ROLE2_IMAGE
        };
        
        // 按照Coze API规范构建请求数据 - 使用parameters字段
        const requestData = {
            workflow_id: WORKFLOW_ID,
            bot_id: BOT_ID, // 根据文档添加Bot ID
            space_id: SPACE_ID,
            parameters: finalParams  // 使用正确的字段名parameters
        };

        console.log('发送到Coze API的请求数据(JSON字符串):', JSON.stringify(requestData));

        try {
            // 发送HTTP POST请求到Coze API流式接口
            const response = await axios.post(COZE_API_URL, requestData, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${COZE_API_KEY}`
                },
                timeout: 180000, // 180秒超时
                validateStatus: function (status) {
                    return true; // 不抛出任何HTTP状态码的错误
                }
            });

            // 构建完整响应数据，便于调试
            console.log('Coze API完整响应:', response.status, response.statusText, JSON.stringify(response.data));
            
            // 处理API响应
            if (response.status === 200) {
                // 即使状态码是200，也需要检查响应体中是否包含错误信息
                if (response.data.code && response.data.code !== 0) {
                    console.error('Coze API返回错误信息（状态码200）:', response.data);
                    
                    res.status(500).json({
                        success: false,
                        message: `Coze API调用失败: ${response.data.msg || '未知错误'}`,
                        error: response.data,
                        debugInfo: {
                            workflow_id: WORKFLOW_ID,
                            sentParams: params,
                            timestamp: new Date().toISOString()
                        }
                    });
                } else {
                    // 真正的成功响应
                    let result = response.data.result || response.data;
                    
                    console.log('工作流调用成功，处理后的result:', result);
                    
                    res.status(200).json({
                        success: true,
                        message: '工作流调用成功',
                        data: result
                    });
                }
            } else {
                // 非200状态码的处理
                console.error('Coze API返回非成功状态码:', response.status, response.statusText);
                
                res.status(500).json({
                    success: false,
                    message: `Coze API调用失败: HTTP状态码 ${response.status} - ${response.statusText}`,
                    error: response.data,
                    debugInfo: {
                        workflow_id: WORKFLOW_ID,
                        sentParams: params,
                        timestamp: new Date().toISOString()
                    }
                });
            }
        } catch (axiosError) {
            // 处理Axios请求错误
            console.error('Coze API请求发生异常:');
            console.error('错误名称:', axiosError.name);
            console.error('错误消息:', axiosError.message);
            console.error('错误代码:', axiosError.code);
            console.error('响应数据:', axiosError.response ? JSON.stringify(axiosError.response.data) : '无');
            console.error('响应状态:', axiosError.response ? axiosError.response.status : '无');
            console.error('完整错误对象:', axiosError);
            
            // 构建更详细的错误信息
            let errorMessage = 'Coze API调用失败';
            if (axiosError.response) {
                // 服务器返回了错误响应
                errorMessage += `: 服务器返回错误状态码 ${axiosError.response.status}`;
                if (axiosError.response.data && axiosError.response.data.msg) {
                    errorMessage += ` - ${axiosError.response.data.msg}`;
                }
            } else if (axiosError.request) {
                // 请求已发送但没有收到响应
                errorMessage += ': 服务器无响应，请检查网络连接或API地址是否正确';
            } else {
                // 请求配置出错
                errorMessage += `: ${axiosError.message}`;
            }
            
            res.status(500).json({
                success: false,
                message: errorMessage,
                error: {
                    name: axiosError.name,
                    message: axiosError.message,
                    code: axiosError.code,
                    response: axiosError.response ? {
                        status: axiosError.response.status,
                        data: axiosError.response.data
                    } : null
                },
                debugInfo: {
                    workflow_id: WORKFLOW_ID,
                    sentParams: params,
                    timestamp: new Date().toISOString()
                }
            });
        }
    } catch (error) {
        // 处理其他可能的错误
        console.error('工作流调用整体处理失败:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    } finally {
        console.log('====== Coze API调用日志结束 ======');
    }
});

// 调用剪映小助手API（用于自动化流程）
app.post('/api/video/invoke-helper', authenticateToken, async (req, res) => {
    try {
        const { draftUrl, draftId } = req.body;
        
        // 验证请求数据
        if (!draftUrl || !draftId) {
            return res.status(400).json({
                success: false,
                message: '请提供有效的草稿URL和草稿ID'
            });
        }
        
        console.log('====== 调用剪映小助手API ======');
        console.log('草稿URL:', draftUrl);
        console.log('草稿ID:', draftId);
        
        // 调用剪映小助手API - 使用 create_draft.php 端点
        const apiEndpoint = `${JIANYING_HELPER_API_URL}/create_draft.php`;
        
        try {
            const apiResponse = await axios.post(apiEndpoint, {
                draft_url: draftUrl,
                draft_id: draftId
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${JIANYING_HELPER_API_KEY}`,
                    'X-API-Key': JIANYING_HELPER_API_KEY,
                    'API-Key': JIANYING_HELPER_API_KEY
                },
                timeout: 300000 // 5分钟超时
            });
            
            console.log('剪映小助手API响应:', apiResponse.data);
            
            // 检查响应格式（可能返回成功状态或草稿路径）
            if (apiResponse.data && (apiResponse.data.success || apiResponse.data.draft_path || apiResponse.data.path)) {
                // API调用成功
            } else if (apiResponse.data && apiResponse.data.error) {
                return res.status(500).json({
                    success: false,
                    message: apiResponse.data.error || '剪映小助手API返回错误',
                    error: apiResponse.data.error
                });
            } else {
                return res.status(500).json({
                    success: false,
                    message: '剪映小助手API返回未知格式',
                    error: 'API响应格式不符合预期'
                });
            }
            
            res.status(200).json({
                success: true,
                message: '剪映小助手调用成功',
                output: apiResponse.data.output || 'Successfully processed',
                draftPath: apiResponse.data.draftPath || `D:\\视频\\${draftId}`,
                timestamp: new Date().toISOString()
            });
            
        } catch (apiError) {
            console.error('调用剪映小助手API失败:', apiError);
            
            // 如果API调用失败，返回错误信息
            if (apiError.code === 'ECONNREFUSED' || apiError.code === 'ETIMEDOUT') {
                return res.status(503).json({
                    success: false,
                    message: '无法连接到剪映小助手API服务，请确保剪映小助手服务正在运行',
                    error: apiError.message
                });
            }
            
            return res.status(500).json({
                success: false,
                message: `剪映小助手API调用失败: ${apiError.response?.data?.message || apiError.message}`,
                error: apiError.response?.data || apiError.message
            });
        }
        
    } catch (error) {
        console.error('调用剪映小助手API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 检查剪映云空间上传状态API - 增强日志版本
app.get('/api/video/check-jianying-cloud/:draftId', async (req, res) => {
    console.log('----------------------------------------');
    console.log('[API CALL] 收到 check-jianying-cloud 请求');
    console.log('请求路径:', req.path);
    console.log('请求参数:', req.params);
    console.log('请求头:', req.headers);
    try {
        const { draftId } = req.params;
        
        // 验证请求数据
        if (!draftId) {
            return res.status(400).json({
                success: false,
                message: '请提供有效的草稿ID'
            });
        }
        
        console.log('====== 检查剪映云空间上传状态 ======');
        console.log('草稿ID:', draftId);
        
        // 在实际环境中，这里应该调用剪映本地守护的API来检查上传状态
        // 由于是模拟环境，我们返回模拟数据
        
        // 使用本地实际存在的视频文件作为模拟视频URL
        // 首先检查temp_videos文件夹中是否有视频文件
        const fs = require('fs');
        const path = require('path');
        const videosDir = path.join(__dirname, 'temp_videos');
        
        let mockPlayUrl = null;
        
        // 尝试读取temp_videos文件夹中的视频文件
        try {
            if (fs.existsSync(videosDir)) {
                const files = fs.readdirSync(videosDir);
                const videoFiles = files.filter(file => 
                    file.endsWith('.mp4') || file.endsWith('.webm') || file.endsWith('.ogg')
                );
                
                console.log(`找到${videoFiles.length}个视频文件: ${videoFiles.join(', ')}`);
                
                // 遍历所有视频文件，找到第一个非空的视频文件
                for (const videoFile of videoFiles) {
                    try {
                        const filePath = path.join(videosDir, videoFile);
                        const stats = fs.statSync(filePath);
                        
                        console.log(`检查文件: ${videoFile}, 大小: ${stats.size} 字节`);
                        
                        // 如果文件大小大于0字节，使用这个文件
                if (stats.size > 0) {
                    // 将相对路径转换为完整的URL
                    const baseUrl = `http://${req.get('host')}`;
                    mockPlayUrl = `${baseUrl}/temp_videos/${videoFile}`;
                    console.log(`选择本地视频文件: ${mockPlayUrl}, 大小: ${stats.size} 字节`);
                    break;
                } else {
                    console.log(`跳过空文件: ${videoFile} (0字节)`);
                }
                    } catch (err) {
                        console.error(`检查文件${videoFile}失败:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('读取视频文件夹失败:', err.message);
        }
        
        // 如果没有找到可用的本地视频文件，使用备用的公共视频URL
        if (!mockPlayUrl) {
            // 使用备用的公共视频URL（从Google样本视频库获取，更可靠）
            mockPlayUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
            console.log('没有找到可用的本地视频文件，使用备用公共视频URL:', mockPlayUrl);
        }
        
        // 优先使用本地视频文件，如果本地有视频文件且大小合适，使用本地文件
        let finalVideoUrl = mockPlayUrl;
        
        // 如果没有可用的本地视频文件，使用备用的公共视频URL
        if (!finalVideoUrl) {
            // 使用备用的公共视频URL（从可靠的视频服务获取）
            finalVideoUrl = 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
            console.log(`[LOG] 使用备用公共视频URL: ${finalVideoUrl}`);
        } else {
            console.log(`[LOG] 返回本地视频URL: ${finalVideoUrl}`);
        }
        
        const response = {
            success: true,
            message: '检查剪映云空间上传状态成功',
            isUploaded: false, // 视频尚未上传
            cloudDraftId: null,
            play_url: null, // 没有视频URL
            timestamp: new Date().toISOString()
        };
        
        console.log('[LOG] 返回完整响应:', response);
        console.log('----------------------------------------');
        res.status(200).json(response);
        
    } catch (error) {
        console.error('检查剪映云空间上传状态API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 上传视频文件API
app.post('/api/video/upload', authenticateToken, upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: '请选择要上传的视频文件'
            });
        }

        // 获取视频文件信息
        const videoUrl = `/uploads/videos/${req.file.filename}`;
        const videoName = req.file.originalname;
        const fileSize = req.file.size;

        console.log('====== 上传视频文件 ======');
        console.log('用户ID:', req.user.id);
        console.log('视频文件名:', videoName);
        console.log('文件大小:', fileSize);
        console.log('保存路径:', req.file.path);
        console.log('访问URL:', videoUrl);

        // 获取视频时长（需要读取视频元数据）
        let duration = '00:00';
        try {
            // 这里可以集成ffmpeg或其他工具来获取视频时长
            // 暂时使用默认值，后续可以优化
        } catch (error) {
            console.warn('获取视频时长失败:', error);
        }

        res.status(200).json({
            success: true,
            message: '视频文件上传成功',
            data: {
                videoUrl: videoUrl,
                videoName: videoName,
                fileSize: fileSize,
                duration: duration
            }
        });

    } catch (error) {
        console.error('上传视频文件失败:', error);
        res.status(500).json({
            success: false,
            message: '上传视频文件失败: ' + error.message,
            error: error.message
        });
    }
});

// 保存视频到个人库API（上传文件后调用此API保存到数据库）
app.post('/api/video/save-to-library', authenticateToken, async (req, res) => {
    try {
        const { videoUrl, videoName, bookName, book_id, author, duration, description, video_tags, video_category, video_topic } = req.body;
        const bookId = Number(book_id);
        const normalizedTags = parseVideoTags(video_tags).join(',');
        const normalizedCategory = String(video_category || '').trim();
        const normalizedTopic = String(video_topic || '').trim();
        
        // 验证请求数据
        if (!videoUrl || !videoName || !bookId) {
            return res.status(400).json({
                success: false,
                message: '请提供有效的视频URL、视频名称和关联图书'
            });
        }
        if (!normalizedTags) {
            return res.status(400).json({
                success: false,
                message: '请至少提供 1 个视频标签'
            });
        }
        
        const bookRows = await dbAllAsync(`SELECT id, title FROM books WHERE id = ? LIMIT 1`, [bookId]);
        const matchedBook = bookRows[0];
        if (!matchedBook) {
            return res.status(400).json({
                success: false,
                message: '关联图书不存在，请重新选择'
            });
        }
        
        // 使用用户信息作为默认作者
        const videoAuthor = author || req.user.username;
        const resolvedBookName = String(bookName || matchedBook.title || '').trim() || matchedBook.title;
        const inferredFromTags = normalizedTags
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        const resolvedCategory = normalizedCategory || (inferredFromTags.slice(0, 2).join('/') || '未分类');
        const resolvedTopic = normalizedTopic || (inferredFromTags.slice(0, 3).join(' / ') || `${resolvedBookName}解读`);
        
        console.log('====== 保存视频到个人库 ======');
        console.log('用户ID:', req.user.id);
        console.log('视频URL:', videoUrl);
        console.log('视频名称:', videoName);
        console.log('关联图书ID:', bookId);
        console.log('书籍名称:', resolvedBookName);
        console.log('视频标签:', normalizedTags);
        console.log('视频分类:', resolvedCategory);
        console.log('视频主题:', resolvedTopic);
        console.log('作者:', videoAuthor);
        console.log('时长:', duration);
        
        // 保存视频到数据库，初始状态为 'draft'（草稿）
        db.run(
            `INSERT INTO user_videos (user_id, video_url, video_name, book_name, book_id, video_tags, video_category, video_topic, author, duration, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, videoUrl, videoName, resolvedBookName, bookId, normalizedTags, resolvedCategory, resolvedTopic, videoAuthor, duration || '00:00', description || '', 'draft'],
            function(err) {
                if (err) {
                    console.error('保存视频到数据库失败:', err.message);
                    return res.status(500).json({
                        success: false,
                        message: '保存视频到个人库失败'
                    });
                }
                
                console.log('视频成功保存到数据库，ID:', this.lastID);
                
                res.status(200).json({
                    success: true,
                    message: '视频已成功保存到您的个人库，等待审核',
                    data: {
                        videoId: this.lastID
                    }
                });
            }
        );
        
    } catch (error) {
        console.error('保存视频到个人库API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 获取已审核通过的视频列表API（对所有用户开放）
app.get('/api/videos', async (req, res) => {
    try {
        console.log('====== 获取已审核视频列表 ======');
        
        // 获取查询参数和用户token（可选）
        const { sort, limit } = req.query;
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        let userId = null;
        
        // 如果提供了token，解析用户ID
        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                userId = decoded.id;
            } catch (e) {
                // token无效，忽略
            }
        }
        
        // 构建SQL查询，包含点赞、收藏、评论数量
        let sql = `SELECT uv.*, u.username as upload_user, b.title as book_title,
                   (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id) as likes_count,
                   (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id) as collections_count,
                   (SELECT COUNT(*) FROM video_comments WHERE video_id = uv.id) as comments_count`;
        
        // 如果用户已登录，添加是否已点赞/收藏的字段
        if (userId) {
            sql += `,
                   (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id AND user_id = ?) as is_liked,
                   (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id AND user_id = ?) as is_collected`;
        }
        
        sql += ` FROM user_videos uv 
                 JOIN users u ON uv.user_id = u.id 
                 LEFT JOIN books b ON b.id = uv.book_id
                 WHERE uv.status = ? AND (uv.is_banned IS NULL OR uv.is_banned = 0)`;
        
        const params = [];
        if (userId) {
            params.push(userId, userId);
        }
        params.push('approved');
        
        // 构建排序逻辑
        let orderBy = 'ORDER BY uv.created_at DESC';
        if (sort === 'views') {
            orderBy = 'ORDER BY uv.created_at DESC';
        } else if (sort === 'likes') {
            orderBy = 'ORDER BY likes_count DESC, uv.created_at DESC';
        }
        
        // 构建limit逻辑
        let limitClause = '';
        if (limit && !isNaN(parseInt(limit))) {
            limitClause = 'LIMIT ?';
            params.push(parseInt(limit));
        }
        
        // 组合完整的SQL语句
        const fullSql = `${sql} ${orderBy} ${limitClause}`;
        
        // 查询所有已通过审核的视频
        const videos = await new Promise((resolve, reject) => {
            db.all(
                fullSql,
                params,
                (err, rows) => {
                    if (err) {
                        console.error('SQL查询错误:', err);
                        reject(err);
                    } else {
                        // 转换数据类型
                        const processedVideos = rows.map(video => ({
                            ...video,
                            likes_count: video.likes_count || 0,
                            collections_count: video.collections_count || 0,
                            comments_count: video.comments_count || 0,
                            is_liked: userId ? (video.is_liked > 0) : false,
                            is_collected: userId ? (video.is_collected > 0) : false
                        }));
                        console.log('查询到的视频数据:', processedVideos);
                        console.log('查询到的视频数量:', processedVideos.length);
                        resolve(processedVideos);
                    }
                }
            );
        });
        
        res.status(200).json({
            success: true,
            videos: videos
        });
        
    } catch (error) {
        console.error('获取视频列表API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 用户举报视频API
app.post('/api/videos/:id/report', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { reason, note } = req.body;
        const userId = req.user.id;

        console.log('====== 用户举报视频 ======');
        console.log('视频ID:', id);
        console.log('举报人ID:', userId);
        console.log('举报原因:', reason);
        console.log('举报备注:', note);

        // 验证参数
        if (!reason) {
            return res.status(400).json({
                success: false,
                message: '请选择举报原因'
            });
        }

        // 检查视频是否存在
        db.get('SELECT * FROM user_videos WHERE id = ?', [id], (err, video) => {
            if (err) {
                console.error('查询视频失败:', err);
                return res.status(500).json({
                    success: false,
                    message: '查询视频失败'
                });
            }

            if (!video) {
                return res.status(404).json({
                    success: false,
                    message: '视频不存在'
                });
            }

            // 检查是否已经举报过（同一用户对同一视频只能举报一次）
            db.get(
                'SELECT * FROM video_reports WHERE video_id = ? AND reporter_id = ? AND status = ?',
                [id, userId, 'pending'],
                (err, existingReport) => {
                    if (err) {
                        console.error('查询举报记录失败:', err);
                        return res.status(500).json({
                            success: false,
                            message: '查询举报记录失败'
                        });
                    }

                    if (existingReport) {
                        return res.status(400).json({
                            success: false,
                            message: '您已经举报过该视频，请等待管理员处理'
                        });
                    }

                    // 创建举报记录
                    db.run(
                        'INSERT INTO video_reports (video_id, reporter_id, reason, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
                        [id, userId, reason, note || '', 'pending', new Date().toISOString()],
                        function(err) {
                            if (err) {
                                console.error('创建举报记录失败:', err);
                                return res.status(500).json({
                                    success: false,
                                    message: '创建举报记录失败'
                                });
                            }

                            console.log('举报记录创建成功，ID:', this.lastID);
                            if (Number(video.book_id || 0) > 0) {
                                recordRecoEvent(userId, Number(video.book_id), 'report', 1, 'video_report');
                            }
                            res.status(200).json({
                                success: true,
                                message: '举报已提交，我们会尽快处理',
                                reportId: this.lastID
                            });
                        }
                    );
                }
            );
        });

    } catch (error) {
        console.error('举报视频API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 更新视频状态API（用于提交审核）
app.put('/api/user/videos/:id/status', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user.id;

        // 验证状态值
        if (!status || !['draft', 'pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: '无效的状态值'
            });
        }

        console.log('====== 更新视频状态 ======');
        console.log('视频ID:', id);
        console.log('用户ID:', userId);
        console.log('新状态:', status);

        // 更新视频状态
        db.run(
            `UPDATE user_videos SET status = ? WHERE id = ? AND user_id = ?`,
            [status, id, userId],
            function(err) {
                if (err) {
                    console.error('更新视频状态失败:', err);
                    return res.status(500).json({
                        success: false,
                        message: '更新视频状态失败'
                    });
                }

                if (this.changes === 0) {
                    return res.status(404).json({
                        success: false,
                        message: '视频不存在或无权操作'
                    });
                }

                console.log('视频状态更新成功');
                res.status(200).json({
                    success: true,
                    message: '视频状态已更新',
                    data: {
                        videoId: id,
                        status: status
                    }
                });
            }
        );

    } catch (error) {
        console.error('更新视频状态API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 删除用户视频API
app.delete('/api/user/videos/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        console.log('====== 删除用户视频 ======');
        console.log('视频ID:', id);
        console.log('用户ID:', userId);

        // 首先检查视频是否存在且属于当前用户
        db.get(
            `SELECT * FROM user_videos WHERE id = ? AND user_id = ?`,
            [id, userId],
            (err, video) => {
                if (err) {
                    console.error('查询视频失败:', err);
                    return res.status(500).json({
                        success: false,
                        message: '查询视频失败'
                    });
                }

                if (!video) {
                    return res.status(404).json({
                        success: false,
                        message: '视频不存在或无权删除'
                    });
                }

                // 删除视频文件（如果存在）
                if (video.video_url && video.video_url.startsWith('/uploads/')) {
                    const videoPath = path.join(__dirname, video.video_url);
                    fs.unlink(videoPath, (err) => {
                        if (err && err.code !== 'ENOENT') {
                            console.warn('删除视频文件失败:', err);
                        }
                    });
                }

                // 从数据库删除视频记录
                db.run(
                    `DELETE FROM user_videos WHERE id = ? AND user_id = ?`,
                    [id, userId],
                    function(err) {
                        if (err) {
                            console.error('删除视频记录失败:', err);
                            return res.status(500).json({
                                success: false,
                                message: '删除视频失败'
                            });
                        }

                        console.log('视频删除成功');
                        res.status(200).json({
                            success: true,
                            message: '视频已成功删除'
                        });
                    }
                );
            }
        );

    } catch (error) {
        console.error('删除视频API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// ================= 视频互动功能API =================

// 点赞/取消点赞视频
app.post('/api/videos/:id/like', authenticateToken, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    
    // 检查是否已点赞
    db.get(
        `SELECT * FROM video_likes WHERE user_id = ? AND video_id = ?`,
        [userId, id],
        (err, like) => {
            if (err) {
                console.error('查询点赞失败:', err);
                return res.status(500).json({ success: false, message: '查询点赞失败' });
            }
            
            if (like) {
                // 取消点赞
                db.run(
                    `DELETE FROM video_likes WHERE user_id = ? AND video_id = ?`,
                    [userId, id],
                    function(err) {
                        if (err) {
                            console.error('取消点赞失败:', err);
                            return res.status(500).json({ success: false, message: '取消点赞失败' });
                        }
                        res.status(200).json({ success: true, liked: false, message: '已取消点赞' });
                    }
                );
            } else {
                // 添加点赞
                db.run(
                    `INSERT INTO video_likes (user_id, video_id) VALUES (?, ?)`,
                    [userId, id],
                    function(err) {
                        if (err) {
                            console.error('点赞失败:', err);
                            return res.status(500).json({ success: false, message: '点赞失败' });
                        }
                        res.status(200).json({ success: true, liked: true, message: '点赞成功' });
                    }
                );
            }
        }
    );
});

// 收藏/取消收藏视频
app.post('/api/videos/:id/collect', authenticateToken, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    
    // 检查是否已收藏
    db.get(
        `SELECT * FROM video_collections WHERE user_id = ? AND video_id = ?`,
        [userId, id],
        (err, collection) => {
            if (err) {
                console.error('查询收藏失败:', err);
                return res.status(500).json({ success: false, message: '查询收藏失败' });
            }
            
            if (collection) {
                // 取消收藏
                db.run(
                    `DELETE FROM video_collections WHERE user_id = ? AND video_id = ?`,
                    [userId, id],
                    function(err) {
                        if (err) {
                            console.error('取消收藏失败:', err);
                            return res.status(500).json({ success: false, message: '取消收藏失败' });
                        }
                        res.status(200).json({ success: true, collected: false, message: '已取消收藏' });
                    }
                );
            } else {
                // 添加收藏
                db.run(
                    `INSERT INTO video_collections (user_id, video_id) VALUES (?, ?)`,
                    [userId, id],
                    function(err) {
                        if (err) {
                            console.error('收藏失败:', err);
                            return res.status(500).json({ success: false, message: '收藏失败' });
                        }
                        res.status(200).json({ success: true, collected: true, message: '收藏成功' });
                    }
                );
            }
        }
    );
});

// 获取视频评论列表
app.get('/api/videos/:id/comments', (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    db.all(
        `SELECT vc.*, u.username, u.id as user_id
         FROM video_comments vc
         JOIN users u ON vc.user_id = u.id
         WHERE vc.video_id = ?
         ORDER BY vc.created_at DESC
         LIMIT ? OFFSET ?`,
        [id, limit, offset],
        (err, comments) => {
            if (err) {
                console.error('获取评论失败:', err);
                return res.status(500).json({ success: false, message: '获取评论失败' });
            }
            
            // 获取评论总数
            db.get(
                `SELECT COUNT(*) as total FROM video_comments WHERE video_id = ?`,
                [id],
                (err, result) => {
                    if (err) {
                        console.error('获取评论总数失败:', err);
                        return res.status(500).json({ success: false, message: '获取评论总数失败' });
                    }
                    
                    res.status(200).json({
                        success: true,
                        comments: comments,
                        total: result.total,
                        page: parseInt(page),
                        totalPages: Math.ceil(result.total / limit)
                    });
                }
            );
        }
    );
});

// 添加视频评论
app.post('/api/videos/:id/comments', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.user.id;
    
    if (!content || content.trim().length === 0) {
        return res.status(400).json({ success: false, message: '评论内容不能为空' });
    }
    
    db.run(
        `INSERT INTO video_comments (user_id, video_id, content) VALUES (?, ?, ?)`,
        [userId, id, content.trim()],
        function(err) {
            if (err) {
                console.error('添加评论失败:', err);
                return res.status(500).json({ success: false, message: '添加评论失败' });
            }
            
            // 返回新创建的评论
            db.get(
                `SELECT vc.*, u.username, u.id as user_id
                 FROM video_comments vc
                 JOIN users u ON vc.user_id = u.id
                 WHERE vc.id = ?`,
                [this.lastID],
                (err, comment) => {
                    if (err) {
                        console.error('获取评论失败:', err);
                        return res.status(500).json({ success: false, message: '获取评论失败' });
                    }
                    res.status(201).json({ success: true, comment: comment, message: '评论成功' });
                }
            );
        }
    );
});

// 记录视频浏览API
app.post('/api/videos/:id/view', authenticateToken, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    
    // 检查视频是否存在
    db.get('SELECT id FROM user_videos WHERE id = ?', [id], (err, video) => {
        if (err) {
            console.error('查询视频失败:', err);
            return res.status(500).json({ success: false, message: '查询视频失败' });
        }
        
        if (!video) {
            return res.status(404).json({ success: false, message: '视频不存在' });
        }
        
        // 插入或更新浏览记录（使用INSERT OR REPLACE确保唯一性）
        db.run(
            `INSERT OR REPLACE INTO video_views (user_id, video_id, viewed_at) 
             VALUES (?, ?, CURRENT_TIMESTAMP)`,
            [userId, id],
            function(err) {
                if (err) {
                    console.error('记录浏览失败:', err);
                    return res.status(500).json({ success: false, message: '记录浏览失败' });
                }
                
                // 更新视频的浏览数
                db.run(
                    'UPDATE user_videos SET views = COALESCE(views, 0) + 1 WHERE id = ?',
                    [id],
                    (err) => {
                        if (err) {
                            console.error('更新视频浏览数失败:', err);
                        }
                    }
                );
                
                res.status(200).json({ success: true, message: '浏览记录已保存' });
            }
        );
    });
});

// 获取用户收藏的视频列表
app.get('/api/user/collections', authenticateToken, (req, res) => {
    const userId = req.user.id;
    
    db.all(
        `SELECT uv.*, u.username as upload_user,
         (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id) as likes_count,
         (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id) as collections_count,
         (SELECT COUNT(*) FROM video_comments WHERE video_id = uv.id) as comments_count
         FROM video_collections vc
         JOIN user_videos uv ON vc.video_id = uv.id
         JOIN users u ON uv.user_id = u.id
         WHERE vc.user_id = ? AND uv.status = 'approved'
         ORDER BY vc.created_at DESC`,
        [userId],
        (err, videos) => {
            if (err) {
                console.error('获取收藏视频失败:', err);
                return res.status(500).json({ success: false, message: '获取收藏视频失败' });
            }
            res.status(200).json({ success: true, videos: videos });
        }
    );
});

// 获取用户点赞的视频列表
app.get('/api/user/likes', authenticateToken, (req, res) => {
    const userId = req.user.id;
    
    db.all(
        `SELECT uv.*, u.username as upload_user,
         (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id) as likes_count,
         (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id) as collections_count,
         (SELECT COUNT(*) FROM video_comments WHERE video_id = uv.id) as comments_count
         FROM video_likes vl
         JOIN user_videos uv ON vl.video_id = uv.id
         JOIN users u ON uv.user_id = u.id
         WHERE vl.user_id = ? AND uv.status = 'approved'
         ORDER BY vl.created_at DESC`,
        [userId],
        (err, videos) => {
            if (err) {
                console.error('获取点赞视频失败:', err);
                return res.status(500).json({ success: false, message: '获取点赞视频失败' });
            }
            res.status(200).json({ success: true, videos: videos });
        }
    );
});

// 获取用户评论的视频列表
app.get('/api/user/comments', authenticateToken, (req, res) => {
    const userId = req.user.id;
    
    db.all(
        `SELECT DISTINCT uv.*, u.username as upload_user,
         (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id) as likes_count,
         (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id) as collections_count,
         (SELECT COUNT(*) FROM video_comments WHERE video_id = uv.id) as comments_count
         FROM video_comments vc
         JOIN user_videos uv ON vc.video_id = uv.id
         JOIN users u ON uv.user_id = u.id
         WHERE vc.user_id = ? AND uv.status = 'approved'
         ORDER BY vc.created_at DESC`,
        [userId],
        (err, videos) => {
            if (err) {
                console.error('获取评论视频失败:', err);
                return res.status(500).json({ success: false, message: '获取评论视频失败' });
            }
            res.status(200).json({ success: true, videos: videos });
        }
    );
});

// 获取用户浏览记录
app.get('/api/user/views', authenticateToken, (req, res) => {
    const userId = req.user.id;
    
    db.all(
        `SELECT uv.*, u.username as upload_user,
         (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id) as likes_count,
         (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id) as collections_count,
         (SELECT COUNT(*) FROM video_comments WHERE video_id = uv.id) as comments_count,
         vv.viewed_at
         FROM video_views vv
         JOIN user_videos uv ON vv.video_id = uv.id
         JOIN users u ON uv.user_id = u.id
         WHERE vv.user_id = ? AND uv.status = 'approved'
         ORDER BY vv.viewed_at DESC
         LIMIT 50`,
        [userId],
        (err, videos) => {
            if (err) {
                console.error('获取浏览记录失败:', err);
                return res.status(500).json({ success: false, message: '获取浏览记录失败' });
            }
            res.status(200).json({ success: true, videos: videos });
        }
    );
});

// 获取用户自己的视频列表API
app.get('/api/user/videos', authenticateToken, async (req, res) => {
    try {
        console.log('====== 获取用户视频列表 ======');
        console.log('用户ID:', req.user.id);
        
        // 查询当前用户的所有视频，包含点赞、收藏、评论数量
        db.all(
            `SELECT uv.*, b.title as book_title,
             (SELECT COUNT(*) FROM video_likes WHERE video_id = uv.id) as likes_count,
             (SELECT COUNT(*) FROM video_collections WHERE video_id = uv.id) as collections_count,
             (SELECT COUNT(*) FROM video_comments WHERE video_id = uv.id) as comments_count
             FROM user_videos uv
             LEFT JOIN books b ON b.id = uv.book_id
             WHERE uv.user_id = ? 
             ORDER BY uv.created_at DESC`,
            [req.user.id],
            (err, videos) => {
                if (err) {
                    console.error('查询视频列表失败:', err);
                    return res.status(500).json({
                        success: false,
                        message: '获取视频列表失败'
                    });
                }
        
                console.log('查询到的视频数量:', videos.length);
        
                // 转换数据类型
                const processedVideos = videos.map(video => ({
                    ...video,
                    likes_count: video.likes_count || 0,
                    collections_count: video.collections_count || 0,
                    comments_count: video.comments_count || 0
                }));
        
                res.status(200).json({
                    success: true,
                    videos: processedVideos
                });
            }
        );
        
    } catch (error) {
        console.error('获取用户视频列表API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 复制视频到剪映草稿的API
// 注意:此API接受两种认证方式:JWT令牌和用户直接输入的Token
app.post('/api/video/copy-to-capcut', async (req, res) => {
    try {
        // 检查Authorization头中的Token
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        
        // 模拟用户对象（在实际应用中应该根据Token验证用户身份）
        let user = null;
        
        if (token) {
            try {
                // 尝试使用JWT验证Token
                user = jwt.verify(token, JWT_SECRET);
                req.user = user;
            } catch (jwtError) {
                // 如果不是有效的JWT令牌，假设是用户直接输入的Token
                console.log('使用用户输入的Token进行认证（非JWT）');
                // 这里应该有一个专门用于验证用户输入Token的逻辑
                // 为了演示，我们创建一个模拟用户
                req.user = {
                    id: 'user_' + Date.now(),
                    username: 'video_user',
                    isAdmin: false
                };
            }
        } else {
            // 没有提供Token，但为了演示，我们仍然允许访问
            console.warn('没有提供Token，使用默认用户身份');
            req.user = {
                id: 'default_user',
                username: 'default_video_user',
                isAdmin: false
            };
        }
        const fs = require('fs').promises;
        const path = require('path');
        const { sourceFolder, taskId } = req.body;
        
        // 验证请求数据
        if (!sourceFolder || !taskId) {
            return res.status(400).json({
                success: false,
                message: '请提供有效的源文件夹路径和任务ID'
            });
        }
        
        console.log('====== 复制视频到剪映草稿 ======');
        console.log('用户ID:', req.user.id);
        console.log('源文件夹:', sourceFolder);
        console.log('任务ID:', taskId);
        
        // 剪映草稿文件夹路径（根据实际情况调整）
        // 通常位于用户文档目录下的JianyingPro\Draft文件夹
        const jianyingDraftFolder = path.join(
            process.env.USERPROFILE || process.env.HOMEPATH || '',
            'Documents',
            'JianyingPro',
            'Draft',
            taskId
        );
        
        console.log('目标剪映草稿文件夹:', jianyingDraftFolder);
        
        // 确保剪映草稿文件夹存在
        try {
            await fs.mkdir(jianyingDraftFolder, { recursive: true });
            console.log('剪映草稿文件夹已创建或已存在');
        } catch (error) {
            console.error('创建剪映草稿文件夹失败:', error);
            return res.status(500).json({
                success: false,
                message: '创建剪映草稿文件夹失败',
                error: error.message
            });
        }
        
        // 检查源文件夹是否存在
        try {
            await fs.access(sourceFolder);
        } catch (error) {
            console.error('源文件夹不存在:', sourceFolder);
            return res.status(404).json({
                success: false,
                message: `源文件夹不存在: ${sourceFolder}`
            });
        }
        
        // 复制源文件夹中的所有文件到剪映草稿文件夹
        try {
            await copyFolderRecursive(sourceFolder, jianyingDraftFolder);
            console.log('视频素材文件复制成功');
            
            // 返回成功响应，包含目标路径和云空间信息
            // 注意:前端代码期望的是targetPath和suggestedPath字段
            return res.status(200).json({
                success: true,
                message: '视频素材文件已成功复制到剪映草稿文件夹',
                targetPath: jianyingDraftFolder,
                suggestedPath: jianyingDraftFolder, // 同时提供suggestedPath以便兼容前端代码
                cloudSpaceInfo: {
                    status: 'pending',
                    message: '素材已复制到剪映草稿，等待自动同步到云空间'
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('复制视频素材文件失败:', error);
            return res.status(500).json({
                success: false,
                message: '复制视频素材文件失败',
                error: error.message
            });
        }
        
    } catch (error) {
        console.error('复制视频到剪映草稿API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 剪映小助手API端点（兼容前端调用）
app.post('/api/capcut/assistant', authenticateToken, async (req, res) => {
    try {
        const { draftUrl } = req.body;
        
        // 验证请求数据
        if (!draftUrl) {
            return res.status(400).json({
                success: false,
                message: '请提供有效的草稿URL'
            });
        }
        
        console.log('====== 调用剪映小助手API（/api/capcut/assistant） ======');
        console.log('草稿URL:', draftUrl);
        
        // 调用剪映小助手API - 使用 create_draft.php 端点
        const apiEndpoint = `${JIANYING_HELPER_API_URL}/create_draft.php`;
        
        try {
            const apiResponse = await axios.post(apiEndpoint, {
                draft_url: draftUrl
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${JIANYING_HELPER_API_KEY}`,
                    'X-API-Key': JIANYING_HELPER_API_KEY,
                    'API-Key': JIANYING_HELPER_API_KEY
                },
                timeout: 300000 // 5分钟超时
            });
            
            console.log('剪映小助手API响应:', apiResponse.data);
            
            // 检查响应格式
            if (apiResponse.data && (apiResponse.data.success || apiResponse.data.draft_path || apiResponse.data.path || apiResponse.data.mp4Url)) {
                // API调用成功
            } else if (apiResponse.data && apiResponse.data.error) {
                return res.status(500).json({
                    success: false,
                    message: apiResponse.data.error || '剪映小助手API返回错误',
                    error: apiResponse.data.error
                });
            } else {
                return res.status(500).json({
                    success: false,
                    message: '剪映小助手API返回未知格式',
                    error: 'API响应格式不符合预期'
                });
            }
            
            // 返回MP4直链（如果API返回了）
            res.status(200).json({
                success: true,
                message: '剪映小助手处理成功',
                mp4Url: apiResponse.data.mp4Url || apiResponse.data.videoUrl,
                output: apiResponse.data.output,
                timestamp: new Date().toISOString()
            });
            
        } catch (apiError) {
            console.error('调用剪映小助手API失败:', apiError);
            
            // 如果API调用失败，返回错误信息
            if (apiError.code === 'ECONNREFUSED' || apiError.code === 'ETIMEDOUT') {
                return res.status(503).json({
                    success: false,
                    message: '无法连接到剪映小助手API服务，请确保剪映小助手服务正在运行',
                    error: apiError.message
                });
            }
            
            return res.status(500).json({
                success: false,
                message: `剪映小助手API调用失败: ${apiError.response?.data?.message || apiError.message}`,
                error: apiError.response?.data || apiError.message
            });
        }
        
    } catch (error) {
        console.error('调用剪映小助手API出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message,
            error: error.message
        });
    }
});

// 自动化流程API:从JSON地址生成视频并显示
app.post('/api/video/auto-generate', authenticateToken, async (req, res) => {
    try {
        const { jsonUrl, bookInfo } = req.body;
        
        // 验证请求数据
        if (!jsonUrl) {
            return res.status(400).json({
                success: false,
                message: '请提供有效的JSON文件地址'
            });
        }
        
        console.log('====== 开始自动化视频生成流程 ======');
        console.log('JSON地址:', jsonUrl);
        console.log('图书信息:', bookInfo);
        
        // 生成UUID格式的草稿ID（剪映草稿目录要求UUID格式）
        // 格式:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        function generateUUID() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        }
        
        const draftId = generateUUID(); // UUID格式的草稿ID
        const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`; // 任务ID用于内部跟踪
        
        console.log('生成的草稿ID (UUID格式):', draftId);
        console.log('任务ID:', taskId);
        
        // 临时输出目录（用于存储剪映小助手生成的素材文件）
        const tempOutputDir = path.join(__dirname, 'temp', 'jianying', taskId);
        
        // 剪映草稿目录 - 使用UUID格式的草稿ID
        const jianyingDraftFolder = path.join(
            process.env.USERPROFILE || process.env.HOMEPATH || '',
            'AppData',
            'Local',
            'JianyingPro',
            'User Data',
            'Projects',
            'com.lveditor.draft',
            draftId  // 使用UUID格式的草稿ID
        );
        
        console.log('临时输出目录:', tempOutputDir);
        console.log('剪映草稿目录:', jianyingDraftFolder);
        
        // 确保临时目录存在
        await fs.promises.mkdir(tempOutputDir, { recursive: true });
        
        // 步骤1: 调用剪映小助手API创建草稿
        // 根据官方文档:https://jy.0x0.chat/docs/api-reference/create-draft/
        console.log('步骤1: 调用剪映小助手API创建草稿...');
        let jianyingIds = null;
        try {
            // 步骤1.1: 创建草稿 - 按照官方文档: https://jy.0x0.chat/docs/api-reference/create-draft/
            // API地址: POST https://jy-api.0x0.chat/v1/create_draft.php
            // 请求头: Content-Type: application/json
            // 输入参数: height (画布高度), width (画布宽度)
            // 输出参数: ids (草稿唯一标识符，由两个UUID组成)
            const createDraftEndpoint = `${JIANYING_HELPER_API_URL}/create_draft.php`;
            
            console.log('调用创建草稿API:', createDraftEndpoint);
            console.log('画布尺寸: 1080x1920 (竖屏视频，适合抖音、快手等平台)');
            
            // 按照官方文档的请求格式
            const createDraftResponse = await axios.post(createDraftEndpoint, {
                height: 1920,  // 竖屏视频高度（像素）
                width: 1080    // 竖屏视频宽度（像素）
            }, {
                headers: {
                    'Content-Type': 'application/json'
                    // 注意: 根据官方文档，不需要Token
                },
                timeout: 300000 // 5分钟超时
            });
            
            console.log('创建草稿API响应:', JSON.stringify(createDraftResponse.data, null, 2));
            
            // 按照官方文档，响应格式: { "ids": "uuid1/uuid2" }
            if (!createDraftResponse.data || !createDraftResponse.data.ids) {
                throw new Error('创建草稿失败: API未返回ids字段');
            }
            
            // ids格式: 两个UUID用"/"连接，例如: "c7f3042a-6741-1bad-02a0-0f2ac1527e5f/36788c0f-70d0-4c8a-b77f-613c4173ff42"
            jianyingIds = createDraftResponse.data.ids;
            console.log('获取到草稿IDs:', jianyingIds);
            
            // 验证ids格式（应该是两个UUID用"/"连接）
            if (!jianyingIds || typeof jianyingIds !== 'string' || !jianyingIds.includes('/')) {
                throw new Error('创建草稿失败: ids格式不正确，应为两个UUID用"/"连接');
            }
            
            // 步骤1.2: 从JSON URL中提取视频URL
            let videoUrl = null;
            try {
                // 尝试从JSON URL中提取视频URL
                // 格式可能是:https://ts.fyshark.com/#/cozeToJianyin?drafId=https://video-snot-12220.o...
                const urlMatch = jsonUrl.match(/drafId=([^&]+)/);
                if (urlMatch) {
                    videoUrl = decodeURIComponent(urlMatch[1]);
                    console.log('从JSON URL提取的视频URL:', videoUrl);
                } else {
                    // 如果URL本身就是视频地址
                    videoUrl = jsonUrl;
                }
            } catch (e) {
                console.warn('提取视频URL失败，使用原始URL:', e);
                videoUrl = jsonUrl;
            }
            
            // 步骤1.3: 添加视频到草稿
            const addVideoEndpoint = `${JIANYING_HELPER_API_URL}/add_video.php`;
            
            console.log('调用添加视频API:', addVideoEndpoint);
            console.log('视频URL:', videoUrl);
            
            const addVideoResponse = await axios.post(addVideoEndpoint, {
                ids: jianyingIds,  // 使用创建草稿时获取的ids
                video_urls: [videoUrl],  // 视频URL数组
                timelines: [{start: 0, end: 5000000}]  // 时间线（微秒），0到5秒
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 300000
            });
            
            console.log('添加视频API响应:', JSON.stringify(addVideoResponse.data, null, 2));
            
            if (addVideoResponse.data && addVideoResponse.data.error) {
                throw new Error('添加视频失败: ' + String(addVideoResponse.data.error));
            }
            
            console.log('视频已成功添加到草稿');
                
        } catch (apiError) {
            console.error('调用剪映小助手API失败:', apiError);
            console.error('错误详情:', {
                code: apiError.code,
                message: apiError.message,
                response: apiError.response?.data,
                status: apiError.response?.status
            });
            
            // 如果API调用失败，提供详细的错误信息
            if (apiError.code === 'ECONNREFUSED') {
                throw new Error('无法连接到剪映小助手API服务(' + JIANYING_HELPER_API_URL + '), 请确保剪映小助手服务正在运行');
            } else if (apiError.code === 'ETIMEDOUT') {
                throw new Error('剪映小助手API服务响应超时，请检查服务是否正常运行');
            } else if (apiError.response) {
                // 服务器返回了错误响应
                const status = apiError.response.status;
                const errorMsg = apiError.response.data?.message || apiError.message;
                throw new Error('剪映小助手API返回错误(HTTP ' + status + '): ' + errorMsg);
            } else {
                throw new Error('剪映小助手API调用失败: ' + apiError.message);
            }
        }
        
        // 步骤1.4: 获取播放地址（视频生成需要时间，尝试多次获取）
        let playUrlResponse = null;
        let finalVideoUrl = null;
        const maxRetries = 5; // 最多重试5次
        const retryDelay = 3000; // 每次重试间隔3秒
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const getPlayUrlEndpoint = `${JIANYING_HELPER_API_URL}/get_play_url.php`;
                
                console.log(`调用获取播放地址API (尝试 ${attempt}/${maxRetries}):`, getPlayUrlEndpoint);
                
                playUrlResponse = await axios.post(getPlayUrlEndpoint, {
                    ids: jianyingIds
                }, {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 300000
                });
                
                console.log('获取播放地址API响应:', JSON.stringify(playUrlResponse.data, null, 2));
                
                // 检查多种可能的响应字段名
                const playUrl = playUrlResponse.data?.play_url || 
                               playUrlResponse.data?.playUrl || 
                               playUrlResponse.data?.video_url ||
                               playUrlResponse.data?.videoUrl ||
                               playUrlResponse.data?.mp4_url ||
                               playUrlResponse.data?.mp4Url ||
                               playUrlResponse.data?.url;
                
                if (playUrl) {
                    finalVideoUrl = playUrl;
                    console.log('获取到播放地址:', finalVideoUrl);
                    break; // 成功获取，退出循环
                } else {
                    // 检查是否有错误信息
                    if (playUrlResponse.data?.error) {
                        console.warn(`API返回错误: ${playUrlResponse.data.error}`);
                    } else if (playUrlResponse.data?.message) {
                        console.log(`API消息: ${playUrlResponse.data.message}`);
                    } else {
                        console.log('API响应中没有找到播放地址字段，响应结构:', Object.keys(playUrlResponse.data || {}));
                    }
                    
                    if (attempt < maxRetries) {
                        console.log(`播放地址尚未生成，等待 ${retryDelay/1000} 秒后重试...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    }
                }
            } catch (playUrlError) {
                console.warn(`获取播放地址失败 (尝试 ${attempt}/${maxRetries}):`, playUrlError.message);
                console.warn('错误详情:', {
                    code: playUrlError.code,
                    message: playUrlError.message,
                    response: playUrlError.response?.data,
                    status: playUrlError.response?.status
                });
                
                // 如果是连接错误，不要重试
                if (playUrlError.code === 'ECONNREFUSED' || playUrlError.code === 'ETIMEDOUT') {
                    console.error('无法连接到剪映小助手API，停止重试');
                    break;
                }
                
                if (attempt < maxRetries) {
                    console.log(`等待 ${retryDelay/1000} 秒后重试...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }
        
        // 验证草稿路径是否存在
        let actualDraftPath = null;
        try {
            if (fs.existsSync(jianyingDraftFolder)) {
                actualDraftPath = jianyingDraftFolder;
                console.log('草稿路径存在:', actualDraftPath);
            } else {
                console.log('草稿路径不存在（草稿可能仅存在于剪映云空间）:', jianyingDraftFolder);
            }
        } catch (pathError) {
            console.warn('验证草稿路径时出错:', pathError.message);
        }
        
        // 如果获取到播放地址，返回成功
        if (finalVideoUrl) {
            return res.status(200).json({
                success: true,
                message: '视频生成成功',
                taskId: taskId,
                draftId: draftId,
                jianyingIds: jianyingIds,
                videoUrl: finalVideoUrl,  // MP4直链
                draftPath: actualDraftPath, // 只在路径存在时返回
                note: '草稿已创建并同步到剪映云空间，可在剪映草稿箱查看'
            });
        }
        
        // 如果获取播放地址失败，仍然返回成功（草稿已创建）
        console.log('草稿已成功创建，ids:', jianyingIds);
        console.log('注意: 视频可能需要更多时间生成，请稍后在剪映草稿箱中查看');
        
        return res.status(200).json({
            success: true,
            message: '草稿已成功创建并同步到剪映云空间',
            taskId: taskId,
            draftId: draftId,
            jianyingIds: jianyingIds,
            videoUrl: null, // 视频尚未生成
            draftPath: actualDraftPath, // 只在路径存在时返回
            note: '草稿已创建，视频正在生成中，请稍后在剪映草稿箱中查看。如果路径不存在，说明草稿仅存在于剪映云空间。'
        });
        
    } catch (error) {
        console.error('自动化视频生成流程出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + String(error.message),
            error: error.message
        });
    }
});

// 提供视频文件访问的API
app.get('/api/video/file/:taskId/:filename', authenticateToken, async (req, res) => {
    try {
        const { taskId, filename } = req.params;
        
        // 剪映草稿目录
        const jianyingDraftFolder = path.join(
            process.env.USERPROFILE || process.env.HOMEPATH || '',
            'AppData',
            'Local',
            'JianyingPro',
            'User Data',
            'Projects',
            'com.lveditor.draft',
            taskId
        );
        
        const filePath = path.join(jianyingDraftFolder, filename);
        
        // 检查文件是否存在
        try {
            await fs.promises.access(filePath);
        } catch (error) {
            return res.status(404).json({
                success: false,
                message: '视频文件不存在'
            });
        }
        
        // 设置响应头
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
        
        // 发送文件
        const fileStream = fs.createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        console.error('提供视频文件访问出错:', error);
        res.status(500).json({
            success: false,
            message: '服务器内部错误: ' + error.message
        });
    }
});

// 启动服务器
// 提供静态文件服务（放在所有API路由之后，作为后备）
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    kgNeo4jService.init()
        .then(async (state) => {
            if (!state.ready) {
                console.warn('Neo4j未就绪，继续使用现有轻量KG:', state.reason || 'unknown');
                return;
            }
            console.log('Neo4j图谱已连接，开始旁路增强推荐');
            const syncRes = await buildAndSyncKgGraphData();
            console.log('Neo4j图谱首轮同步完成:', syncRes);
        })
        .catch((error) => {
            console.warn('Neo4j初始化失败，继续轻量KG:', error.message);
        });
    loadRecoSettingsFromDb()
        .then((cfg) => {
            console.log('推荐配置已加载:', { enabled: cfg.enabled, cache_enabled: cfg.cache_enabled, cache_ttl_sec: cfg.cache_ttl_sec });
        })
        .catch(() => {});
    checkRecoGatewayHealth().catch(() => {});
    setInterval(async () => {
        try {
            await checkRecoGatewayHealth();
        } catch (error) {
            console.warn('推荐网关健康检查失败:', error.message);
        }
    }, 15 * 1000);
    setInterval(async () => {
        try {
            const cfg = getRecoSettings();
            if (!cfg.enabled || !cfg.cache_enabled) return;
            await refreshRecoCacheForActiveUsers(20, 120);
        } catch (error) {
            console.warn('推荐缓存定时刷新失败:', error.message);
        }
    }, 2 * 60 * 1000);
    setInterval(async () => {
        try {
            if (!kgNeo4jService.isReady()) return;
            await buildAndSyncKgGraphData();
        } catch (error) {
            console.warn('Neo4j定时同步失败:', error.message);
        }
    }, 5 * 60 * 1000);
    setInterval(async () => {
        try {
            const cfg = getRecoSettings();
            if (!cfg.enabled) return;
            await rebuildUserItemScoreSnapshot(30);
        } catch (error) {
            console.warn('评分矩阵快照定时刷新失败:', error.message);
        }
    }, 5 * 60 * 1000);
    setTimeout(() => {
        rebuildUserItemScoreSnapshot(30).catch(() => {});
    }, 3000);
    setInterval(async () => {
        try {
            const cfg = getRecoSettings();
            if (!cfg.enabled) return;
            await drainRecoEventQueue(300);
        } catch (error) {
            console.warn('推荐事件队列消费失败:', error.message);
        }
    }, 3000);
    setInterval(async () => {
        try {
            const cfg = getRecoSettings();
            if (!cfg.enabled) return;
            const result = await runRecoAlertsCheck({ source: 'auto_cron', persist: true });
            if (result.alerted) {
                console.warn('推荐自动告警触发:', result.alerts.join(' | '));
                try {
                    const sent = await maybeNotifyRecoAlertWebhook(result, 'auto_cron');
                    if (sent) {
                        console.log('推荐自动告警已推送Webhook');
                    }
                } catch (notifyError) {
                    console.warn('推荐自动告警Webhook推送失败:', notifyError.message);
                }
            }
        } catch (error) {
            console.warn('推荐自动告警巡检失败:', error.message);
        }
    }, 5 * 60 * 1000);
    setInterval(async () => {
        await scanShippingAnomalies();
    }, 5 * 60 * 1000);
    setTimeout(() => {
        runRecoAlertsCheck({ source: 'auto_bootstrap', persist: true }).catch(() => {});
    }, 5000);
});

// 在应用关闭时关闭数据库连接
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('关闭数据库连接失败:', err.message);
        } else {
            console.log('已关闭数据库连接');
        }
        process.exit(0);
    });
});