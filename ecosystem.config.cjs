module.exports = {
  apps: [
    {
      name: "minecraft-english-reader",
      script: "server.js",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        HOST: "127.0.0.1",
        COOKIE_SECURE: "true",
        DATABASE_PATH: "./data/app.db"
      }
    }
  ]
};
