# Deployment Guide

This project is now structured as a reusable single-client deployment template.
Each copied project should have:

- its own folder
- its own `.env`
- its own `config/client.json`
- its own database
- its own storage bucket or bucket prefix
- its own domain

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

```bash
npm run check:cloud
```

## 6. Deploy

### Docker

```bash
docker build -t edusync-client-template .
docker run -p 3000:3000 --env-file .env edusync-client-template
```

### Native Node

```bash
npm ci --omit=dev
npm start
```

## 7. Post-Deploy Verification

Verify these existing flows after each client deployment:

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
