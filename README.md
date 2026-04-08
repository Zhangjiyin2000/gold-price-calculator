# Gold Price Calculator

This project is now structured as a modern full-stack app:

- `frontend/`: React + Vite
- `backend/`: FastAPI

The calculator keeps your current business rules and now supports order batches:

- Purity formula: `水重 / 干重 × 2307.454 - 常数`
- Per-gram price formula: `(国际金价 / 31.1035) × (1 - 税点%) × 纯度%`
- Purity is truncated to 2 decimal places
- Per-gram price is truncated to 2 decimal places
- Total price truncates all decimal places
- Supports two transparent rule variants:
  - `标准回收规则 (-2088.136)`
  - `活动回收规则 (-2088.163)`
- One customer can have multiple orders in the same day
- The UI totals only the current order, not all same-day records for the customer
- Supports reservation-based split pricing:
  - Reserved weight uses the locked international gold price
  - Overflow weight uses the current spot international gold price
  - Purity and tax rate still come from the actual gold brought in today

## Stack

- Frontend: React 18 + Vite
- Backend: FastAPI + httpx
- Data write: backend order APIs, optionally persisted to Airtable

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

Then set these values in `backend/.env` if you want Airtable persistence:

- `AIRTABLE_TOKEN`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_CUSTOMERS_TABLE_NAME`
- `AIRTABLE_RESERVATIONS_TABLE_NAME`
- `AIRTABLE_ORDERS_TABLE_NAME`
- `AIRTABLE_ITEMS_TABLE_NAME`
- `AIRTABLE_ALLOCATIONS_TABLE_NAME`
- `ALLOWED_ORIGINS` (optional, comma-separated)

If the Airtable variables are not configured, the backend still works in in-memory mode so you can test the order flow locally.

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
AIRTABLE_CUSTOMERS_TABLE_NAME=Customers
AIRTABLE_RESERVATIONS_TABLE_NAME=Reservations
AIRTABLE_ORDERS_TABLE_NAME=Orders
AIRTABLE_ITEMS_TABLE_NAME=Gold Items
AIRTABLE_ALLOCATIONS_TABLE_NAME=Order Item Allocations
ALLOWED_ORIGINS=https://your-frontend-domain.onrender.com
```

5. In the static frontend service, set:

```bash
VITE_API_BASE_URL=https://your-backend-domain.onrender.com
```

6. Redeploy both services after saving the environment variables.

You can then share the frontend URL directly.

So in this project, I choose Option A to deploy online.

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
docs/
  order-batch-design.md
```

## Business Design Notes

- Order batch design for repeat same-day customers:
  - See `docs/order-batch-design.md`

## Airtable Save Flow

The frontend now works in three steps:

1. Create an order
2. Add one or more gold items into that order
3. Mark the order as paid

If the customer has a reservation, one gold item may be split into:

- A reserved-price portion
- A spot-price overflow portion

The backend decides where to store that data:

- If Airtable is configured, reservations, orders, items, and allocations are saved to Airtable
- If Airtable is not configured, data is stored in backend memory for local testing

Current API endpoints:

- `GET /api/reservations?customer_name=&customer_phone=`
- `POST /api/reservations`
- `POST /api/orders`
- `GET /api/orders/{orderId}`
- `POST /api/orders/{orderId}/items`
- `DELETE /api/orders/{orderId}/items/{itemId}`
- `PATCH /api/orders/{orderId}/pay`
- `GET /api/health`

Recommended Airtable tables and fields:

`Customers`

- `Customer ID`
- `Customer Name`
- `Customer Phone`
- `Last Visit At`

`Reservations`

- `Reservation ID`
- `Customer ID`
- `Customer Name`
- `Customer Phone`
- `Reserved Weight`
- `Locked Intl Gold Price`
- `Remaining Reserved Weight`
- `Reserved At`
- `Status`

`Orders`

- `Order ID`
- `Customer ID`
- `Customer Name`
- `Customer Phone`
- `Status`
- `Created At`
- `Paid At`
- `Total Items`
- `Total Amount`

`Gold Items`

- `Item ID`
- `Order ID`
- `Customer ID`
- `Customer Name`
- `Customer Phone`
- `Saved At`
- `Rule Name`
- `Rule Constant`
- `Water Weight`
- `Dry Weight`
- `Tax Rate`
- `International Gold Price`
- `Purity`
- `Per Gram Price`
- `Final Price`
- `Line Total`

`Order Item Allocations`

- `Allocation ID`
- `Order ID`
- `Item ID`
- `Reservation ID`
- `Pricing Mode`
- `Allocation Label`
- `Allocated Weight`
- `Intl Gold Price Used`
- `Per Gram Price`
- `Final Price`
- `Line Total`
- `Created At`
