module.exports = {
  apps: [
    {
      name: "minecraft-english-reader",
      script: "server.js",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        DATABASE_PATH: "./data/app.db"
      }
    }
  ]
};
