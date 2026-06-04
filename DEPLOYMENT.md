# Deployment Guide

<<<<<<< HEAD
This project is now structured as a reusable single-client deployment template.
Each copied project should have:
=======
This project now supports both a normal long-running Node server (`npm start`, useful for Render) and Vercel Serverless Functions (`api/index.js`, configured by `vercel.json`).

## 1) Create Cloud Storage (Cloudflare R2)
1. Create a Cloudflare account.
2. Open R2 and create a bucket (private recommended).
3. Create R2 API token with read/write bucket access.
4. Note values:
   - Account ID
   - Bucket name
   - Access key ID
   - Secret access key
>>>>>>> c4e26f7 (updated coaching portal features)

- its own folder
- its own `.env`
- its own `config/client.json`
- its own database
- its own storage bucket or bucket prefix
- its own domain

<<<<<<< HEAD
## 1. Prepare A New Client Copy

1. Duplicate the project folder.
2. Rename the folder for the coaching client.
3. Update [config/client.json](/Users/kartiiik_001/Documents/edusync-template/config/client.json).
4. Replace branding assets in [branding](/Users/kartiiik_001/Documents/edusync-template/branding).
5. Copy [.env.template](/Users/kartiiik_001/Documents/edusync-template/.env.template) to `.env`.

## 2. Configure Branding

Edit [config/client.json](/Users/kartiiik_001/Documents/edusync-template/config/client.json):

```json
{
  "clientName": "Demo Coaching",
  "domain": "demo.edusync.me",
  "primaryColor": "#2563eb",
  "supportEmail": "support@edusync.me"
}
```

Replace:

- [branding/logo.png](/Users/kartiiik_001/Documents/edusync-template/branding/logo.png)
- [branding/favicon.ico](/Users/kartiiik_001/Documents/edusync-template/branding/favicon.ico)
- [branding/colors.json](/Users/kartiiik_001/Documents/edusync-template/branding/colors.json) if you want different default background/surface colors

## 3. Configure Environment Variables

Minimum required variables:

```bash
PORT=3000
DATABASE_URL=postgresql://...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-south-1
AWS_BUCKET=...
RESEND_API_KEY=...
RESEND_FROM=...
JWT_SECRET=...
```

Recommended additional values:

```bash
FILE_STORAGE_MODE=s3
LOCAL_PAPER_DIR=./uploads
S3_ENDPOINT=
S3_PUBLIC_BASE_URL=
OWNER_2FA_EMAIL=
OWNER_2FA_PHONE=
```

## 4. Database Configuration

Database connection logic is in [config/database.js](/Users/kartiiik_001/Documents/edusync-template/config/database.js).

For each client deployment:

- provision a separate PostgreSQL database
- set that database URL in `.env`
- keep the same schema/application code

## 5. Upload Configuration

Upload storage logic is in [shared/uploads/storage.js](/Users/kartiiik_001/Documents/edusync-template/shared/uploads/storage.js).

Behavior:

- S3-compatible storage stays supported
- AWS-style env keys are accepted
- uploads are written under a client-specific folder prefix
- local fallback writes under `./uploads` when configured

Run a storage check before deploy:
=======
## 2) Configure Environment Variables
Use `.env.example` as base and set at least:
- `DATABASE_URL=postgresql://...`
- `SESSION_SECRET`
- `FILE_STORAGE_MODE=s3`
- `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
- `S3_REGION=auto`
- `S3_BUCKET_NAME=<YOUR_BUCKET>`
- `S3_ACCESS_KEY_ID=<YOUR_KEY>`
- `S3_SECRET_ACCESS_KEY=<YOUR_SECRET>`
- `S3_SIGNED_URL_TTL_SECONDS=600`
>>>>>>> c4e26f7 (updated coaching portal features)

```bash
npm run check:cloud
```

<<<<<<< HEAD
## 6. Deploy

### Docker
=======
## 3) Deploy on Vercel
Use Vercel project settings to add the production environment variables above.

Required for Vercel:
- `DATABASE_URL` must point to Postgres or Neon. Do not use SQLite on Vercel.
- `SESSION_SECRET` must be a stable random string. Do not leave it blank.
- `FILE_STORAGE_MODE=s3` is required because Vercel cannot persist local uploads.
- `S3_*` variables must point to Cloudflare R2, AWS S3, or another S3-compatible bucket.
- Large file uploads are limited by Vercel request limits. This app defaults to a smaller Vercel upload limit; use direct browser-to-S3 uploads later if you need large PDFs.

Deploy:
```bash
npm install
npx vercel
npx vercel --prod
```

Vercel entrypoint:
- `api/index.js` imports the Express app and prepares storage/database before each cold start.
- `vercel.json` rewrites all traffic to that function.

## 4) Deploy on Render / Railway / Fly / VM
>>>>>>> c4e26f7 (updated coaching portal features)

```bash
docker build -t edusync-client-template .
docker run -p 3000:3000 --env-file .env edusync-client-template
```

### Native Node

```bash
npm ci --omit=dev
npm start
```

<<<<<<< HEAD
## 7. Post-Deploy Verification

Verify these existing flows after each client deployment:
=======
Keep `FILE_STORAGE_MODE=s3` so papers are in cloud.

## 5) Migrate Existing Local Files to Cloud
Only needed if you already uploaded files in local mode.
>>>>>>> c4e26f7 (updated coaching portal features)

1. owner login
2. admin login
3. OTP flow
4. trusted device flow
5. admin dashboard
6. student dashboard
7. paper upload
8. paper view/download
9. attendance update
10. settings save

## 8. New Client Checklist

<<<<<<< HEAD
1. Copy project folder
2. Rename folder
3. Edit `config/client.json`
4. Replace branding assets
5. Copy `.env.template` to `.env`
6. Set separate database credentials
7. Set separate AWS/storage credentials
8. Set separate mail credentials
9. Deploy
10. Connect domain
=======
```bash
npm run migrate:papers:cloud -- --delete-local
```

## 6) Verify
- Login as owner from `/login`.
- Create a coaching tenant and set its `basic`, `mid`, or `premium` subscription.
- Open the generated coaching portal link.
- Login there as coaching admin.
- Open Admin Dashboard > Overview and check `File Storage: S3`.
- Upload PDF/JPG/PNG.
- Login as student and confirm open/download works.
>>>>>>> c4e26f7 (updated coaching portal features)
