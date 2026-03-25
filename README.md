# Gold Price Calculator

This project is now structured as a modern full-stack app:

- `frontend/`: React + Vite
- `backend/`: FastAPI

The calculator keeps your current business rules:

- Purity formula: `水重 / 干重 × 2307.454 - 常数`
- Per-gram price formula: `(国际金价 / 31.1035) × (1 - 税点%) × 纯度%`
- Purity is truncated to 2 decimal places
- Per-gram price is truncated to 2 decimal places
- Total price truncates all decimal places
- Supports two transparent rule variants:
  - `标准回收规则 (-2088.136)`
  - `活动回收规则 (-2088.163)`

## Stack

- Frontend: React 18 + Vite
- Backend: FastAPI + httpx
- Data write: Airtable via backend only

## Run Locally

### 1. Start the backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

Then set these values in `backend/.env` if you want Airtable saving:

- `AIRTABLE_TOKEN`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_TABLE_NAME`
- `ALLOWED_ORIGINS` (optional, comma-separated)

### 2. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8000`.

## Deploy Online

This project is ready to be deployed as:

- `frontend/` -> a static site
- `backend/` -> a FastAPI service

The UI already includes responsive mobile styles, so the shared link can be opened directly on phones.

### Option A: Deploy both services on Render

This repo now includes `render.yaml`, so you can create both services from one repository.

1. Push this repo to GitHub.
2. In Render, create a new Blueprint and connect the repo.
3. Render will detect two services:
   - `gold-price-calculator-api`
   - `gold-price-calculator-web`
4. In the API service, set these environment variables:

```bash
AIRTABLE_TOKEN=pat_xxx
AIRTABLE_BASE_ID=app_xxx
AIRTABLE_TABLE_NAME=Gold Transactions
ALLOWED_ORIGINS=https://your-frontend-domain.onrender.com
```

5. In the static frontend service, set:

```bash
VITE_API_BASE_URL=https://your-backend-domain.onrender.com
```

6. Redeploy both services after saving the environment variables.

You can then share the frontend URL directly.

### Option B: Frontend on Vercel, backend on Render

Recommended setup if you want the easiest frontend sharing flow:

1. Deploy `backend/` to a Python host such as Render.
2. Deploy `frontend/` to a static host such as Vercel or Netlify.
3. Set the frontend environment variable:

```bash
VITE_API_BASE_URL=https://your-backend-domain.com
```

4. Set the backend environment variable:

```bash
ALLOWED_ORIGINS=https://your-frontend-domain.com
```

5. Redeploy both services.

After that, you can send the Vercel URL to anyone and they can open it on desktop or mobile.

## Project Structure

```text
frontend/
  src/
    App.jsx
    styles.css
    lib/calculator.js
backend/
  app/
    main.py
    config.py
    schemas.py
    services/
      airtable.py
      calculator.py
```

## Airtable Save Flow

The `记录到 Airtable` button now sends data to the FastAPI backend instead of writing directly from the browser.

That means:

- Airtable credentials stay on the server
- The frontend only sends the calculated record payload
- The backend creates the Airtable record with a PAT

Expected Airtable fields:

- `Saved At`
- `Customer Name`
- `Customer Phone`
- `Rule Name`
- `Rule Constant`
- `Water Weight`
- `Dry Weight`
- `Tax Rate`
- `International Gold Price`
- `Purity`
- `Per Gram Price`
- `Final Price`
- `Total Price`
