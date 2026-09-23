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

## API Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/login` | Admin login | No |
| GET | `/api/articles` | List articles (with pagination and tag filter) | No |
| GET | `/api/articles/:id` | Get single article | No |
| POST | `/api/articles` | Create new article | Yes |
| PUT | `/api/articles/:id` | Update article | Yes |
| DELETE | `/api/articles/:id` | Delete article | Yes |
| GET | `/api/tags` | Get all unique tags | No |
| GET | `/api/health` | Readiness status (port, storage, init, CORS) | No |
| GET | `/api/health/ping` | Lightweight liveness probe | No |

## Health Checks

After startup the server runs a readiness self-check and logs one line per
check. The same checks are exposed through a safe entry point,
`GET /api/health`, and a CLI poller, `npm run healthcheck`.

### Unified determination rules

- Four checks run on every request: **port** (accepting connections),
  **storage** (data directory/database writable and readable),
  **init** (`articles` table exists) and **cors** (`Access-Control-Allow-Origin`
  header present).
- The service is ready (`"status": "ok"`, HTTP 200) only when **all** checks
  pass; any failure yields `"status": "error"` (HTTP 503).
- Each check is bounded by a 2s timeout (`CHECK_TIMEOUT`); the whole run is
  bounded by a 5s waiting limit (`WAIT_LIMIT_EXCEEDED`).
- The endpoint is read-only and idempotent. It never reads or reflects
  request headers, so repeated checks cannot leak tokens, and responses are
  sent with `Cache-Control: no-store`.

Example failure response (HTTP 503):

```json
{
  "status": "error",
  "ok": false,
  "checks": [
    { "name": "storage", "ok": false, "failure": "STORAGE_NOT_WRITABLE",
      "detail": "...", "retry": "Fix permissions/ownership on backend/data, then retry." }
  ],
  "retry": "Service is not ready. Fix the failed checks above, then retry GET /api/health ..."
}
```

### Failure conditions and how to retry

| Failure code | Condition | How to retry |
|--------------|-----------|--------------|
| `PORT_CONFLICT` | Port already in use at startup (server exits 1) | Free the port (`lsof -i :3001`) or set another `PORT` env, then restart |
| `PORT_UNREACHABLE` | Server not accepting connections | Confirm the process is running, then retry the check |
| `STORAGE_NOT_WRITABLE` | Data directory or DB file not writable | Fix permissions/ownership on `backend/data`, then retry |
| `INIT_INCOMPLETE` | `articles` table missing | Run `npm run seed` or restart the server, then retry |
| `CORS_MISCONFIGURED` | CORS header missing | Ensure the `cors` middleware is mounted before routes, then retry |
| `CHECK_TIMEOUT` | A check exceeded its 2s limit | Retry; if it persists, inspect database and system load |
| `WAIT_LIMIT_EXCEEDED` | Checks exceeded the waiting limit | Retry later or raise the limit |

### CLI poller

```bash
cd backend
npm run healthcheck                 # poll until ready (10 attempts, 1s apart)
node scripts/healthcheck.js --retries 5 --interval 2000 --port 3001
```

Exits `0` once the service is ready. If the waiting limit is exceeded it
prints the failed conditions with their retry instructions and exits `1`.

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
