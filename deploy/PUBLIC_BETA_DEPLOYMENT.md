# Public Beta Deployment

## 1. Prepare DNS and secrets

Point the domain to the server. In `/opt/minecraft-english-reader/.env`, set the real domain and long independent random secrets:

```dotenv
APP_BASE_URL=https://eduplayer.top
HOST=127.0.0.1
COOKIE_SECURE=true
ACCESS_CONTROL_ENFORCED=false
SESSION_DATABASE_PATH=./data/sessions.db
SESSION_SECRET=replace-with-a-long-random-value
REFERRAL_SECRET=replace-with-another-random-value
RATE_LIMIT_SECRET=replace-with-another-random-value
AUDIT_HASH_SECRET=replace-with-another-random-value
```

Rotate the administrator password and any Tencent Cloud keys previously shared in screenshots or logs.

## 2. Back up and migrate

Run from the server as the `ubuntu` user:

```bash
cd /opt/minecraft-english-reader
pm2 stop minecraft-english-reader
bash deploy/backup-sqlite.sh
git pull --ff-only origin main
npm ci --omit=dev
npm run migrate
pm2 restart minecraft-english-reader --update-env
pm2 status
```

The first deployment moves sessions from memory to `data/sessions.db`; users may need to sign in once. Later PM2 restarts preserve sessions.

## 3. Enable HTTPS

The Nginx templates are configured for `eduplayer.top`. Open inbound TCP 80 and 443 in the Tencent Cloud firewall/security group first. Use the HTTP-only bootstrap configuration to obtain the first certificate:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx sqlite3
sudo cp deploy/nginx-http-bootstrap.conf.example /etc/nginx/sites-available/minecraft-english-reader
sudo ln -sfn /etc/nginx/sites-available/minecraft-english-reader /etc/nginx/sites-enabled/minecraft-english-reader
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/html -d eduplayer.top
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/minecraft-english-reader
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Remove any public rule for port 3000; Node listens only on `127.0.0.1`.

## 4. Smoke test

```bash
curl -I http://eduplayer.top
curl -I https://eduplayer.top/login
curl -I http://127.0.0.1:3000/login
sqlite3 data/app.db 'PRAGMA integrity_check;'
```

Confirm HTTP redirects to HTTPS, the login response has security headers, English and Chinese learning still work, and a PM2 restart does not sign out a test user.

## 5. Turn on access control

Keep `ACCESS_CONTROL_ENFORCED=false` for the first deployment. In the admin page, verify inferred primary courses and account types. Then change it to `true` and restart with `--update-env`.

## Rollback

Code rollback does not require removing new columns or tables. Check out the previous known-good commit and restart; the older code ignores additive schema. Restore the database only if an integrity or data problem is confirmed:

```bash
pm2 stop minecraft-english-reader
cp backups/app-YYYYMMDD-HHMMSS.db data/app.db
pm2 restart minecraft-english-reader --update-env
```
