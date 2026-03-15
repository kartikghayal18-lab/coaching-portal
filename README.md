# Coaching Classes Management System

A deploy-ready coaching management website with:
- Owner SaaS dashboard
- Coaching admin + student login
- Multi-tenant coaching isolation by coaching code
- Owner-managed subscription plans (`basic`, `mid`, `premium`)
- Student creation by roll number + batch (`11th/12th`, `JEE/NEET`)
- Student delete (also deletes linked papers/attendance/fees)
- Bulk paper upload and auto-assignment from filename = roll no
- Auto marks parsing from filename (`roll_marks_max.ext`)
- Attendance (single + bulk absent entry)
- Fees management
- Batch notes (Google Drive / YouTube links)
- Student dashboard with papers, attendance, fees, notes
- Cloud file storage support (S3-compatible)

## Supported Upload Types
- `pdf`
- `jpeg`
- `jpg`
- `png`

## Default Owner Credentials
- Username: `Scc@coaching`
- Password: `Scc@8208`

These are controlled by env variables in `.env`.

## Quick Start
1. Install dependencies
```bash
npm install
```

2. Create env file
```bash
cp .env.example .env
```

3. Verify cloud storage credentials (when FILE_STORAGE_MODE=s3)
```bash
npm run check:cloud
```

4. Start
```bash
npm start
```

5. Open
- `http://localhost:3000/login`

## SaaS Login Flow
- Owner logs in from `/login` with role `Owner`
- Coaching admin logs in from `/login` with role `Coaching Admin` + `Coaching Code`
- Student logs in from `/login` with role `Student` + `Coaching Code`
- You can also share direct portal links like:
  - `http://your-domain.com/login?coaching=alpha-jee-academy`

This is how 10 different coaching classes use the same website but still see separate dashboards. Every session is bound to one `coaching_id`, and all student/admin data queries are filtered by that tenant.

## Paper Filename Format
- Assignment only: `101.pdf`
- Assignment + marks: `101_78_100.pdf` (roll `101`, marks `78/100`)
- Pattern for auto marks: `rollno_marks_max.ext`

## Storage Modes
### Cloud (recommended for deployment)
Set `FILE_STORAGE_MODE=s3` and fill S3-compatible credentials in `.env`.

### Local (dev fallback)
Set `FILE_STORAGE_MODE=local` (files stored in `papers/`).

## Local-to-Cloud Migration
After enabling cloud mode, migrate existing local files:

```bash
npm run migrate:papers:cloud
```

To migrate and remove local copies:

```bash
npm run migrate:papers:cloud -- --delete-local
```

## Environment Variables
See [.env.example](/Users/kartiiik_001/Documents/Playground/.env.example).

Important keys:
- `SESSION_SECRET`
- `DATA_DIR`
- `LOCAL_PAPER_DIR`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_FORCE_RESET`
- `FILE_STORAGE_MODE`
- `S3_ENDPOINT`
- `S3_REGION`
- `S3_BUCKET_NAME`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`
- `S3_PUBLIC_BASE_URL`
- `S3_SIGNED_URL_TTL_SECONDS`

## Deployment
### Docker
Build:
```bash
docker build -t coaching-app .
```

Run:
```bash
docker run -p 3000:3000 --env-file .env coaching-app
```

### Platform Deploy (Render/Railway/Fly/etc.)
- Set all env vars from `.env.example` in platform settings.
- Keep `FILE_STORAGE_MODE=s3` for production.
- Use managed cloud storage bucket for all uploads.
- Persist `data/coaching.db` if you stay on SQLite, or move to managed DB for scale.
- Full step-by-step: [DEPLOYMENT.md](/Users/kartiiik_001/Documents/Playground/DEPLOYMENT.md)

## Important Paths
- App entry: `src/app.js`
- DB setup: `src/db.js`
- Storage module: `src/storage.js`
- Migration script: `scripts/migrate-papers-to-cloud.js`
- SQLite DB: `data/coaching.db`
