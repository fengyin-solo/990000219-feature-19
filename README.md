# Blog Platform

A lightweight personal blog platform built with Vue 3 + Vite (frontend) and Node.js + Express (backend).

## Tech Stack

### Frontend
- **Vue 3** - Progressive JavaScript framework
- **Vite** - Next generation frontend tooling
- **Vue Router** - Official router for Vue.js
- **Pinia** - State management library
- **Element Plus** - Vue 3 UI component library
- **Axios** - HTTP client
- **Marked** - Markdown parser

### Backend
- **Node.js** - JavaScript runtime
- **Express** - Web application framework
- **better-sqlite3** - Fast SQLite3 library
- **jsonwebtoken** - JWT implementation
- **cors** - Cross-Origin Resource Sharing

## Project Structure

```
blog-platform/
├── frontend/          # Vue 3 + Vite frontend
│   ├── src/
│   │   ├── api/       # API client
│   │   ├── components/# Reusable components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores
│   │   └── views/     # Page components
│   └── ...
├── backend/           # Node.js + Express backend
│   ├── db/            # Database initialization and seeds
│   ├── routes/        # API routes
│   ├── middleware/    # Express middleware
│   └── data/          # SQLite database file
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. **Clone or navigate to the project directory**

```bash
cd blog-platform
```

2. **Install backend dependencies**

```bash
cd backend
npm install
```

3. **Install frontend dependencies**

```bash
cd ../frontend
npm install
```

4. **Initialize the database with seed data**

```bash
cd ../backend
npm run seed
```

### Running the Application

1. **Start the backend server (port 3001)**

```bash
cd backend
npm run dev
```

The API server will start at `http://localhost:3001`

2. **Start the frontend development server (port 5173)**

Open a new terminal:

```bash
cd frontend
npm run dev
```

The frontend will be available at `http://localhost:5173`

## Features

- **Article Management**: Create, read, update, and delete blog articles
- **Markdown Support**: Write articles in Markdown with live preview
- **Tag System**: Organize articles with tags and filter by tags
- **Pagination**: Navigate through articles with pagination (10 per page)
- **Admin Panel**: Protected admin area for managing articles
- **JWT Authentication**: Secure admin login with JSON Web Tokens
- **Runtime Health Checks**: Startup readiness gate plus safe liveness/readiness probes (port, storage, database initialization, CORS)

## Runtime Health Checks

After the HTTP listener starts, the backend runs a **startup readiness gate** that
re-evaluates one unified rule until it passes or a wait limit is reached:

1. **port** — the bound listener accepts a local TCP connection
2. **storage** — the data directory exists and a flushed write probe succeeds (`EACCES` / `EROFS` / `ENOSPC` are reported explicitly)
3. **database** — schema initialization completed (`articles` table exists and is readable)
4. **cors** — an unauthenticated `OPTIONS` preflight returns a matching `Access-Control-Allow-Origin` header

### Check entry points (safe, unauthenticated, read-only)

| Method | Endpoint | Purpose | Success | Failure |
|--------|----------|---------|---------|---------|
| GET | `/health/live` | Liveness — process is up | 200 | never readiness-gated |
| GET | `/health/ready` | Readiness — cached unified result | 200 `ready:true` | 503 with per-check `reason`/`retry` |
| GET | `/health/ready?fresh=1` | Re-run the full check suite on demand (bounded by the per-check timeout) | 200 | 503 |

Both endpoints answer with `Cache-Control: no-store`, only GET/HEAD are
accepted (other methods return 405), and responses contain **no** request
headers, JWTs, environment variables or stack traces — repeated polling cannot
mint, consume or leak tokens. Existing API addresses (`/api/...`), article
browsing and the admin login endpoint are unchanged.

```bash
# HTTP probe (no token required)
curl -i http://localhost:3001/health/ready

# CLI probe — polls until ready, exit 0 ready / 1 not ready (safe for containers/scripts)
npm run healthcheck                      # readiness, default retry loop
npm run healthcheck:live                 # liveness only
node scripts/healthcheck.js --ready --port 3001 --wait-ms 30000
```

### Failure conditions and retry

| Failure | Condition | How to recover / retry |
|---------|-----------|------------------------|
| Port conflict (`EADDRINUSE`) | Another process already holds the port; startup stops with exit code 1 | Stop that process (`lsof -i :3001`) and restart, or start on a free port with `PORT=<free-port> npm start` |
| Storage not writable | Preflight or readiness write probe fails (`EACCES`/`EPERM` read-only, `EROFS` read-only filesystem, `ENOSPC` disk full) | Fix permissions / free space / remount the filesystem, then restart and poll `/health/ready` again |
| Database initialization failed | Database cannot open, or `articles` table missing | Restart so initialization re-runs; if it persists, ensure the data dir is writable and run `npm run seed` |
| CORS check failed | Preflight lacks a matching `Access-Control-Allow-Origin` header | Verify the CORS middleware / reverse proxy, restart, then re-poll |
| Check timeout | A single check did not finish in `HEALTH_CHECK_TIMEOUT_MS` (default 2000ms) | Check host responsiveness; raise the timeout and retry |
| Startup wait limit exceeded | Not all checks passed within `HEALTH_STARTUP_DEADLINE_MS` (default 15000ms) | Resolve the listed failing checks using the per-check `retry` guidance, then poll `/health/ready` again (the service keeps serving health so it can recover without restart); or restart after fixing the cause |

The service keeps the `/health` endpoints available even when not ready, so
operators can poll for the exact failing check and its recovery hint.

Configuration (environment variables): `PORT`, `HEALTH_CHECK_TIMEOUT_MS`,
`HEALTH_STARTUP_DEADLINE_MS`, `HEALTH_STARTUP_POLL_INTERVAL_MS`.

## API Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/health/live` | Liveness probe | No |
| GET | `/health/ready` | Readiness probe (`?fresh=1` to re-check) | No |
| POST | `/api/auth/login` | Admin login | No |
| GET | `/api/articles` | List articles (with pagination and tag filter) | No |
| GET | `/api/articles/:id` | Get single article | No |
| POST | `/api/articles` | Create new article | Yes |
| PUT | `/api/articles/:id` | Update article | Yes |
| DELETE | `/api/articles/:id` | Delete article | Yes |
| GET | `/api/tags` | Get all unique tags | No |

## Admin Credentials

- **Username**: admin
- **Password**: admin123

## Configuration

### Backend

- Server port: `3001` (configurable via `PORT` environment variable)
- JWT secret: `blog-platform-secret-key` (hardcoded in middleware/auth.js)
- Database file: `backend/data/blog.db`

### Frontend

- Dev server port: `5173`
- API proxy: `/api` requests are proxied to `http://localhost:3001`

## Build for Production

### Backend

The backend runs directly with Node.js:

```bash
cd backend
npm start
```

### Frontend

Build the frontend for production:

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/`

## License

MIT
