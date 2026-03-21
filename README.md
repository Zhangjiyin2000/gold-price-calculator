# Gold Price Calculator

A simple web-based calculator for gold trading stores.

## Features

- Calculate purity based on water weight and dry weight
- Convert international gold price (USD/oz → USD/g)
- Calculate:
  - Per gram gold price
  - Total gold price

## Formula

Purity:

water_weight / dry_weight \* 2307.454 - 2088.136

Per gram price:

intl_gold_price / 31.1035 - tax_rate% \* purity%

Total price:

dry_weight \* per_gram_price

## Usage

1. Open the webpage
2. Input:
   - Water weight
   - Dry weight
   - Tax rate (%)
   - International gold price (USD/oz)
3. Results will be calculated automatically

## Deployment (GitHub Pages)

Go to:
Settings → Pages → Deploy from branch → main → /root

Then access:
https://your-username.github.io/gold-price-calculator/
