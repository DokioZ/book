# Reco MySQL Setup

## 1) Initialize schema

Set MySQL env vars, then run:

`npm run reco:mysql:init`

Required env vars:

- `RECO_MYSQL_HOST`
- `RECO_MYSQL_PORT`
- `RECO_MYSQL_USER`
- `RECO_MYSQL_PASSWORD`
- `RECO_MYSQL_DATABASE`

## 2) Migrate data from SQLite

Run:

`npm run reco:mysql:migrate`

Optional:

- `RECO_SQLITE_PATH` (default `./database.db`)
- `RECO_MIGRATE_CHUNK` (default `1000`)

## 3) Start reco-service with MySQL

Set:

- `RECO_DB_CLIENT=mysql`
- all `RECO_MYSQL_*` vars above
- optional: `RECO_TFIDF_ENGINE=python` to enable sklearn TF-IDF ranking for video recommendations
- optional: `RECO_TFIDF_PYTHON=python` (or full python executable path)
- optional: `RECO_TFIDF_API_URL=http://localhost:3021` to use standalone Python TF-IDF HTTP service first

Then run:

`npm run start:reco`

Health check:

`GET http://localhost:3011/health`

Expected:

- `"db_client":"mysql"`

## 3.1) Install sklearn (for Python TF-IDF engine)

If you enable `RECO_TFIDF_ENGINE=python`, install:

`pip install scikit-learn`

## 3.2) Start standalone Python TF-IDF service (optional but recommended)

Run:

`npm run start:reco:tfidf`

Health check:

`GET http://localhost:3021/health`

## 5) Production-style process orchestration (PM2)

Run both independent services with auto-restart:

`pm2 start ecosystem.reco.config.js`

View status:

`pm2 ls`

## 4) Enable gateway routing in admin

In admin recommendation config:

- turn on `启用推荐网关转发`
- set `推荐服务地址` to `http://localhost:3011`

Save config. Main server will proxy reco traffic to reco-service.
