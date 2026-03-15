# Deployment Guide (Cloud Storage + Production)

## 1) Create Cloud Storage (Cloudflare R2)
1. Create a Cloudflare account.
2. Open R2 and create a bucket (private recommended).
3. Create R2 API token with read/write bucket access.
4. Note values:
   - Account ID
   - Bucket name
   - Access key ID
   - Secret access key

R2 endpoint format:
- `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

## 2) Configure Environment Variables
Use `.env.example` as base and set at least:
- `SESSION_SECRET`
- `DATA_DIR`
- `LOCAL_PAPER_DIR`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_FORCE_RESET=false` (after first login)
- `FILE_STORAGE_MODE=s3`
- `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `S3_REGION=auto`
- `S3_BUCKET_NAME=<YOUR_BUCKET>`
- `S3_ACCESS_KEY_ID=<YOUR_KEY>`
- `S3_SECRET_ACCESS_KEY=<YOUR_SECRET>`
- `S3_SIGNED_URL_TTL_SECONDS=600`

Run credential check before deploy:
```bash
npm run check:cloud
```

## 3) Deploy App
Any Node platform works (Render / Railway / Fly / ECS / VM).

### Option A: Deploy with Docker
```bash
docker build -t coaching-app .
docker run -p 3000:3000 --env-file .env coaching-app
```

### Option B: Native Node Deploy
```bash
npm ci --omit=dev
npm start
```

If your platform supports persistent disk (recommended when using SQLite):
- Mount a disk path, for example `/var/data`.
- Set `DATA_DIR=/var/data`.
- Keep `FILE_STORAGE_MODE=s3` so papers are in cloud.

## 4) Migrate Existing Local Files to Cloud
Only needed if you already uploaded files in local mode.

```bash
npm run migrate:papers:cloud
```

To migrate and remove local copies:

```bash
npm run migrate:papers:cloud -- --delete-local
```

## 5) Verify
- Login as owner from `/login`.
- Create a coaching tenant and set its `basic`, `mid`, or `premium` subscription.
- Open the generated coaching portal link.
- Login there as coaching admin.
- Open Admin Dashboard > Overview and check `File Storage: S3`.
- Upload PDF/JPG/PNG.
- Login as student and confirm open/download works.
