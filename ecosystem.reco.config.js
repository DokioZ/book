module.exports = {
  apps: [
    {
      name: 'reco-service',
      script: 'reco-service.js',
      cwd: '.',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
        RECO_SERVICE_PORT: '3011',
        RECO_DB_CLIENT: 'mysql',
        RECO_MYSQL_HOST: '127.0.0.1',
        RECO_MYSQL_PORT: '3306',
        RECO_MYSQL_USER: 'root',
        RECO_MYSQL_PASSWORD: '123456',
        RECO_MYSQL_DATABASE: 'reco_db',
        RECO_TFIDF_ENGINE: 'python',
        RECO_TFIDF_API_URL: 'http://localhost:3021'
      }
    },
    {
      name: 'reco-tfidf-service',
      script: 'scripts/reco_tfidf_service.py',
      cwd: '.',
      interpreter: 'python',
      args: '--serve --port 3021',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      env: {
        PYTHONUNBUFFERED: '1'
      }
    }
  ]
};
