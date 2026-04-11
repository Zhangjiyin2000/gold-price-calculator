import { useEffect, useRef, useState } from 'react';
import {
  FORMULA_RULES,
  buildRecordPayloadWithReservation,
  calculateResultsWithReservation,
  formatNumber,
} from './lib/calculator.js';
import {
  buildInventoryBatchesFromOrders,
  calculateBrazilSaleLinePreview,
  calculateBrazilSalePreview,
  calculateCompanySaleLinePreview,
  calculateCompanySalePreview,
  calculateMeltPreview,
  calculateXuSaleLinePreview,
  calculateXuSalePreview,
  resolveReferenceIntlGoldPrice,
} from './lib/inventory.js';

const CUSTOMER_STORAGE_KEY = 'gold-price-calculator-customers';
const PENDING_ORDERS_STORAGE_KEY = 'gold-price-calculator-pending-orders';
const INVENTORY_BATCHES_STORAGE_KEY = 'gold-price-calculator-inventory-batches';
const MELT_RECORDS_STORAGE_KEY = 'gold-price-calculator-melt-records';
const COMPANY_SALES_STORAGE_KEY = 'gold-price-calculator-company-sales';
const XU_SALES_STORAGE_KEY = 'gold-price-calculator-xu-sales';
const BRAZIL_SALES_STORAGE_KEY = 'gold-price-calculator-brazil-sales';
const AUTH_TOKEN_STORAGE_KEY = 'gold-price-calculator-auth-token';

const initialValues = {
  customerName: '',
  customerPhone: '',
  waterWeight: '',
  dryWeight: '',
  taxRate: '',
  intlGoldPrice: '',
  formulaRule: '2088.136',
  pricingMode: 'auto',
  manualPurity: '',
  manualPerGramPrice: '',
};

const emptyResults = {
  purityText: '--',
  puritySub: '等待输入数据',
  perGramText: '--',
  perGramSub: '等待输入数据',
  finalPriceText: '--',
  finalPriceSub: '等待输入数据',
  totalPriceText: '--',
  totalPriceSub: '等待输入数据',
  isSplitPricing: false,
  splitAllocations: [],
};

const initialReservationValues = {
  reservedWeight: '',
  lockedIntlGoldPrice: '',
  taxRate: '',
  reservedAt: '',
};

const initialMeltValues = {
  outputDryWeight: '',
  outputWaterWeight: '',
  formulaRule: '2088.136',
};

const initialCompanySaleValues = {
  buyerType: 'company',
  taxRatePercent: '7.5',
  companyInputs: {},
  xuInputs: {},
  brazilInputs: {},
};

const emptyPermissions = {
  canIntakeGold: false,
  canMeltGold: false,
  canSellGold: false,
  canViewCost: false,
  canViewProfit: false,
  canViewFormula: false,
  canManageFinancialDefaults: false,
  canManageUsers: false,
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const DISPLAY_TIME_ZONE = 'America/Paramaribo';

function apiUrl(path) {
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
}

function sanitizeDecimalInput(value) {
  if (value === '') {
    return '';
  }

  const normalized = value.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const parts = normalized.split('.');

  if (parts.length === 1) {
    return parts[0];
  }

  return `${parts[0]}.${parts.slice(1).join('')}`;
}

function formatDateTimeInSuriname(value) {
  if (!value) {
    return '--';
  }

  const normalized = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const [year, month, day] = normalized.split('-');
    return `${year}/${Number(month)}/${Number(day)}`;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return normalized;
  }

  return parsed.toLocaleString('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    hour12: false,
  });
}

function formatBrazilBalanceText(value) {
  if (!Number.isFinite(value)) {
    return '--';
  }

  if (Math.abs(value) < 0.005) {
    return '当前没有克数差额';
  }

  if (value < 0) {
    return `当前欠巴西佬 ${formatNumber(Math.abs(value), 2)}g`;
  }

  return `当前巴西佬欠我们 ${formatNumber(value, 2)}g`;
}

function clearCurrentItemValues(currentValues) {
  return {
    ...currentValues,
    waterWeight: '',
    dryWeight: '',
    taxRate: '',
    intlGoldPrice: '',
    formulaRule: '2088.136',
    pricingMode: 'auto',
    manualPurity: '',
    manualPerGramPrice: '',
  };
}

function formatApiError(detail, status) {
  if (!detail) {
    return `HTTP ${status}`;
  }

  if (typeof detail === 'string') {
    return detail;
  }

  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object') {
          if (item.msg) {
            return item.msg;
          }

          return JSON.stringify(item);
        }

        return String(item);
      })
      .join('；');
  }

  if (typeof detail === 'object') {
    if (typeof detail.error === 'string') {
      return detail.error;
    }

    if (typeof detail.message === 'string') {
      return detail.message;
    }

    return JSON.stringify(detail);
  }

  return String(detail);
}

async function requestJson(path, options = {}) {
  const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  const nextHeaders = new Headers(options.headers || {});
  if (token) {
    nextHeaders.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(apiUrl(path), { ...options, headers: nextHeaders });
  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { detail: rawText || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(formatApiError(data.detail, response.status));
  }
  return data;
}

function App() {
  const intakeSectionRef = useRef(null);
  const [loginValues, setLoginValues] = useState({ username: '', password: '' });
  const [authStatus, setAuthStatus] = useState('请先登录');
  const [currentUser, setCurrentUser] = useState(null);
  const [financialDefaults, setFinancialDefaults] = useState({ usdToUsdtRate: 1 });
  const [financialDefaultsDraft, setFinancialDefaultsDraft] = useState('1');
  const [values, setValues] = useState(initialValues);
  const [results, setResults] = useState(emptyResults);
  const [saveStatus, setSaveStatus] = useState('正在检查后端连接...');
  const [backendStatus, setBackendStatus] = useState('连接中');
  const [storageMode, setStorageMode] = useState('未知');
  const [savedCustomers, setSavedCustomers] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [reservationValues, setReservationValues] = useState(initialReservationValues);
  const [showReservationForm, setShowReservationForm] = useState(false);
  const [selectedReservationIds, setSelectedReservationIds] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [currentOrder, setCurrentOrder] = useState(null);
  const [lastPaidOrder, setLastPaidOrder] = useState(null);
  const [busyAction, setBusyAction] = useState('');
  const [allOrders, setAllOrders] = useState([]);
  const [inventoryBatches, setInventoryBatches] = useState([]);
  const [meltRecords, setMeltRecords] = useState([]);
  const [companySales, setCompanySales] = useState([]);
  const [xuSales, setXuSales] = useState([]);
  const [brazilSales, setBrazilSales] = useState([]);
  const [brazilBalance, setBrazilBalance] = useState({
    fineGoldBalanceAfter: 0,
    costBalanceAfterUsd: 0,
    createdAt: '',
  });
  const [selectedInventoryBatchIds, setSelectedInventoryBatchIds] = useState([]);
  const [meltValues, setMeltValues] = useState(initialMeltValues);
  const [companySaleValues, setCompanySaleValues] = useState(initialCompanySaleValues);
  const [inventoryStatus, setInventoryStatus] = useState('等待同步库存数据');
  const permissions = currentUser?.permissions || emptyPermissions;
  const canIntakeGold = permissions.canIntakeGold;
  const canMeltGold = permissions.canMeltGold;
  const canSellGold = permissions.canSellGold;
  const canViewCost = permissions.canViewCost;
  const canViewProfit = permissions.canViewProfit;
  const canViewFormula = permissions.canViewFormula;
  const canManageFinancialDefaults = permissions.canManageFinancialDefaults;
  const normalizedCustomerName = values.customerName.trim();
  const normalizedCustomerPhone = values.customerPhone.trim();
  const currentCustomerReservations = reservations.filter(
    (reservation) =>
      reservation.status === 'open' &&
      reservation.customerName === normalizedCustomerName &&
      (normalizedCustomerPhone ? reservation.customerPhone === normalizedCustomerPhone : true)
  );
  const selectedReservations = selectedReservationIds
    .map((reservationId) => currentCustomerReservations.find((reservation) => reservation.id === reservationId))
    .filter(Boolean);
  const totalSelectedReservedWeight = selectedReservations.reduce(
    (sum, reservation) => sum + Number(reservation.remainingReservedWeight || 0),
    0
  );

  async function refreshReservations(
    customerName = normalizedCustomerName,
    customerPhone = normalizedCustomerPhone,
    options = {}
  ) {
    const { silent = false } = options;
    if (!customerName) {
      setReservations([]);
      return;
    }

    try {
      const data = await requestJson(
        `/api/reservations?customer_name=${encodeURIComponent(customerName)}&customer_phone=${encodeURIComponent(customerPhone || '')}`
      );
      setReservations(data);
    } catch (error) {
      if (!silent) {
        setSaveStatus(`加载预定失败：${error.message}`);
      } else {
        console.error('Failed to refresh reservations silently', error);
      }
    }
  }

  async function refreshAllOrders(options = {}) {
    const { silent = false } = options;
    try {
      const data = await requestJson('/api/orders');
      setAllOrders(data);
      setInventoryStatus(data.length ? '已从历史订单同步库存来源' : '还没有可同步的订单明细');
    } catch (error) {
      if (!silent) {
        setInventoryStatus(`库存同步失败：${error.message}`);
      } else {
        console.error('Failed to refresh orders silently', error);
      }
    }
  }

  async function refreshCompanySales() {
    if (!canViewProfit) {
      setCompanySales([]);
      return;
    }
    try {
      const data = await requestJson('/api/company-sales');
      setCompanySales(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load company sales from backend', error);
    }
  }

  async function refreshXuSales() {
    if (!canViewProfit) {
      setXuSales([]);
      return;
    }
    try {
      const data = await requestJson('/api/xu-sales');
      setXuSales(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load xu sales from backend', error);
    }
  }

  async function refreshBrazilSales() {
    if (!canViewProfit) {
      setBrazilSales([]);
      return;
    }
    try {
      const data = await requestJson('/api/brazil-sales');
      setBrazilSales(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load brazil sales from backend', error);
    }
  }

  async function refreshBrazilBalance() {
    if (!canSellGold && !canViewProfit) {
      setBrazilBalance({ fineGoldBalanceAfter: 0, costBalanceAfterUsd: 0, createdAt: '' });
      return;
    }
    try {
      const data = await requestJson('/api/brazil-balance');
      setBrazilBalance({
        fineGoldBalanceAfter: Number(data.fineGoldBalanceAfter || 0),
        costBalanceAfterUsd: Number(data.costBalanceAfterUsd || 0),
        createdAt: data.createdAt || '',
      });
    } catch (error) {
      console.error('Failed to load brazil balance from backend', error);
      setBrazilBalance({ fineGoldBalanceAfter: 0, costBalanceAfterUsd: 0, createdAt: '' });
    }
  }

  useEffect(() => {
    refreshReservations();
  }, [normalizedCustomerName, normalizedCustomerPhone]);

  useEffect(() => {
    try {
      const rawCustomers = window.localStorage.getItem(CUSTOMER_STORAGE_KEY);
      if (!rawCustomers) {
        return;
      }

      const parsedCustomers = JSON.parse(rawCustomers);
      if (Array.isArray(parsedCustomers)) {
        setSavedCustomers(parsedCustomers);
      }
    } catch (error) {
      console.error('Failed to load saved customers', error);
    }
  }, []);

  useEffect(() => {
    try {
      const rawPendingOrders = window.localStorage.getItem(PENDING_ORDERS_STORAGE_KEY);
      if (!rawPendingOrders) {
        return;
      }

      const parsedPendingOrders = JSON.parse(rawPendingOrders);
      if (Array.isArray(parsedPendingOrders)) {
        setPendingOrders(parsedPendingOrders);
      }
    } catch (error) {
      console.error('Failed to load pending orders', error);
    }
  }, []);

  useEffect(() => {
    try {
      const rawInventoryBatches = window.localStorage.getItem(INVENTORY_BATCHES_STORAGE_KEY);
      if (rawInventoryBatches) {
        const parsedInventoryBatches = JSON.parse(rawInventoryBatches);
        if (Array.isArray(parsedInventoryBatches)) {
          setInventoryBatches(parsedInventoryBatches);
        }
      }

      const rawMeltRecords = window.localStorage.getItem(MELT_RECORDS_STORAGE_KEY);
      if (rawMeltRecords) {
        const parsedMeltRecords = JSON.parse(rawMeltRecords);
        if (Array.isArray(parsedMeltRecords)) {
          setMeltRecords(parsedMeltRecords);
        }
      }

      const rawCompanySales = window.localStorage.getItem(COMPANY_SALES_STORAGE_KEY);
      if (rawCompanySales) {
        const parsedCompanySales = JSON.parse(rawCompanySales);
        if (Array.isArray(parsedCompanySales)) {
          setCompanySales(parsedCompanySales);
        }
      }

      const rawXuSales = window.localStorage.getItem(XU_SALES_STORAGE_KEY);
      if (rawXuSales) {
        const parsedXuSales = JSON.parse(rawXuSales);
        if (Array.isArray(parsedXuSales)) {
          setXuSales(parsedXuSales);
        }
      }

      const rawBrazilSales = window.localStorage.getItem(BRAZIL_SALES_STORAGE_KEY);
      if (rawBrazilSales) {
        const parsedBrazilSales = JSON.parse(rawBrazilSales);
        if (Array.isArray(parsedBrazilSales)) {
          setBrazilSales(parsedBrazilSales);
        }
      }
    } catch (error) {
      console.error('Failed to load admin inventory data', error);
    }
  }, []);

  useEffect(() => {
    async function loadStatus() {
      try {
        const data = await requestJson('/api/health');
        setBackendStatus(data.status === 'ok' ? '已连接' : '异常');
        setStorageMode(data.storage_mode === 'airtable' ? 'Airtable' : '服务端内存');
        setSaveStatus(
          data.storage_mode === 'airtable'
            ? '后端已连接 Airtable，可以直接按订单保存'
            : '后端未配置 Airtable，当前订单会先保存在服务端内存中'
        );
      } catch (error) {
        setBackendStatus('未连接');
        setStorageMode('不可用');
        setSaveStatus('后端未启动，当前无法创建订单或保存明细');
      }
    }

    loadStatus();
  }, []);

  useEffect(() => {
    async function loadSession() {
      const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
      if (!token) {
        setAuthStatus('请先登录');
        return;
      }

      try {
        const user = await requestJson('/api/auth/me');
        setCurrentUser(user);
        setAuthStatus(`已登录：${user.displayName}`);
      } catch (error) {
        window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
        setCurrentUser(null);
        setAuthStatus(`登录已失效：${error.message}`);
      }
    }

    loadSession();
  }, []);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    if (canIntakeGold || canMeltGold || canSellGold) {
      refreshAllOrders({ silent: true });
    }
    if (canViewProfit) {
      refreshCompanySales();
      refreshXuSales();
      refreshBrazilSales();
    }
    if (canSellGold || canViewProfit) {
      refreshBrazilBalance();
    }
    if (canSellGold || canManageFinancialDefaults || canViewProfit) {
      requestJson('/api/financial-defaults')
        .then((data) => {
          setFinancialDefaults(data);
          setFinancialDefaultsDraft(formatNumber(data.usdToUsdtRate, 4));
        })
        .catch((error) => {
          console.error('Failed to load financial defaults', error);
        });
    }
  }, [currentUser]);

  useEffect(() => {
    if (!allOrders.length && inventoryBatches.length === 0) {
      return;
    }

    setInventoryBatches((current) => {
      const nextBatches = buildInventoryBatchesFromOrders(current, allOrders);
      if (JSON.stringify(nextBatches) === JSON.stringify(current)) {
        return current;
      }
      window.localStorage.setItem(INVENTORY_BATCHES_STORAGE_KEY, JSON.stringify(nextBatches));
      return nextBatches;
    });
  }, [allOrders]);

  useEffect(() => {
    const payload = calculateResultsWithReservation(values, selectedReservations);
    const rule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];

    if (payload.error) {
      setResults({
        purityText: '--',
        puritySub: payload.error,
        perGramText: '--',
        perGramSub: payload.error,
        finalPriceText: '--',
        finalPriceSub: payload.error,
        totalPriceText: '--',
        totalPriceSub: payload.error,
        isSplitPricing: false,
        splitAllocations: [],
      });
      return;
    }

    const isReservedPricing = payload.reservedWeightApplied > 0;
    const isSplitPricing = isReservedPricing && payload.spotWeightApplied > 0;
    const splitAllocations = (payload.allocations || []).map((allocation) => ({
      label: allocation.label,
      weightText: `${formatNumber(allocation.allocatedWeight, 2)}g`,
      perGramText: `$ ${formatNumber(allocation.finalPrice, 2)}`,
      amountText: `$ ${formatNumber(allocation.lineTotal, 0)}`,
    }));

    setResults({
      purityText: `${formatNumber(payload.effectivePurity ?? payload.purity, 2)}%`,
      puritySub: payload.pricingMode === 'manual'
        ? `手动录入纯度 ${formatNumber(payload.effectivePurity, 2)}%，公式参考值 ${formatNumber(payload.calculatedPurity, 2)}%`
        : `计算过程：(${formatNumber(payload.waterWeight, 4)} ÷ ${formatNumber(payload.dryWeight, 4)}) × 2307.454 - ${formatNumber(rule.constant, 3)}，结果为 ${formatNumber(payload.purity, 2)}%`,
      perGramText: payload.missingFields ? '--' : `$ ${formatNumber(payload.effectivePerGramPrice ?? payload.finalPrice, 2)}`,
      perGramSub: payload.missingFields
        ? payload.missingMessage || '输入税点和国际金价后继续计算每克金价'
        : payload.pricingMode === 'manual'
          ? `手动录入每克价 $ ${formatNumber(payload.effectivePerGramPrice, 2)}，公式参考值 $ ${formatNumber(payload.calculatedPerGramPrice, 2)}`
          : selectedReservations.length > 0 && payload.reservedWeightApplied > 0
            ? payload.spotWeightApplied > 0
              ? '当前块存在预定拆分，整块每克价以下方明细为准'
              : '当前块全部按预定价结算，整块每克价以下方明细为准'
            : `计算过程：(${formatNumber(payload.intlGoldPrice, 2)} ÷ 31.1035) × (1 - ${formatNumber(payload.taxRate, 4)}%) × ${formatNumber(payload.purity, 2)}%，结果为 ${formatNumber(payload.finalPrice, 2)}`,
      finalPriceText: payload.missingFields ? '--' : `$ ${formatNumber(payload.finalPrice, 2)}`,
      finalPriceSub: payload.missingFields
        ? payload.missingMessage || '输入税点和国际金价后继续计算每克金价'
        : payload.pricingMode === 'manual'
          ? `当前块使用手动定价，最终按 ${formatNumber(payload.dryWeight, 4)} × ${formatNumber(payload.effectivePerGramPrice, 2)} 记录`
        : selectedReservations.length > 0 && payload.reservedWeightApplied > 0
          ? payload.spotWeightApplied > 0
            ? `已拆分预定价 ${formatNumber(payload.reservedWeightApplied, 2)}g 和实时价 ${formatNumber(payload.spotWeightApplied, 2)}g`
            : `本块 ${formatNumber(payload.reservedWeightApplied, 4)}g 全部按预定国际金价计算`
          : `计算过程：(${formatNumber(payload.intlGoldPrice, 2)} ÷ 31.1035) × (1 - ${formatNumber(payload.taxRate, 4)}%) × ${formatNumber(payload.purity, 2)}%，结果为 ${formatNumber(payload.finalPrice, 2)}`,
      totalPriceText: payload.missingFields || isReservedPricing ? '--' : `$ ${formatNumber(payload.totalPrice, 0)}`,
      totalPriceSub: payload.missingFields
        ? payload.missingMessage || '输入税点和国际金价后继续计算总金价'
        : payload.pricingMode === 'manual'
          ? `手动定价：${formatNumber(payload.dryWeight, 4)} × ${formatNumber(payload.effectivePerGramPrice, 2)}，结果为 ${formatNumber(payload.totalPrice, 0)}`
        : selectedReservations.length > 0 && payload.reservedWeightApplied > 0
          ? payload.spotWeightApplied > 0
            ? `当前块会按预定价 ${formatNumber(payload.reservedWeightApplied, 2)}g + 实时价 ${formatNumber(payload.spotWeightApplied, 2)}g 拆分结算，不在这里预估总价`
            : `当前块全部使用预定国际金价结算，不在这里预估总价`
          : `计算过程：${formatNumber(payload.dryWeight, 4)} × ${formatNumber(payload.finalPrice, 2)}，结果为 ${formatNumber(payload.totalPrice, 0)}`,
      isSplitPricing: isReservedPricing,
      splitAllocations,
    });
  }, [selectedReservations, values]);

  useEffect(() => {
    if (selectedReservationIds.length === 0) {
      return;
    }

    const availableReservationIds = new Set(currentCustomerReservations.map((reservation) => reservation.id));
    const nextSelectedReservationIds = selectedReservationIds.filter((reservationId) => availableReservationIds.has(reservationId));
    if (nextSelectedReservationIds.length !== selectedReservationIds.length) {
      setSelectedReservationIds(nextSelectedReservationIds);
    }
  }, [currentCustomerReservations, selectedReservationIds]);

  function updateField(event) {
    const { name, value } = event.target;
    const decimalFields = new Set(['waterWeight', 'dryWeight', 'taxRate', 'intlGoldPrice', 'manualPurity', 'manualPerGramPrice']);
    setValues((current) => ({
      ...current,
      [name]: decimalFields.has(name) ? sanitizeDecimalInput(value) : value,
    }));
  }

  function clearField(name) {
    setValues((current) => ({ ...current, [name]: '' }));
  }

  function updateReservationField(event) {
    const { name, value } = event.target;
    const decimalFields = new Set(['reservedWeight', 'lockedIntlGoldPrice', 'taxRate']);
    setReservationValues((current) => ({
      ...current,
      [name]: decimalFields.has(name) ? sanitizeDecimalInput(value) : value,
    }));
  }

  function updateLoginField(event) {
    const { name, value } = event.target;
    setLoginValues((current) => ({ ...current, [name]: value }));
  }

  async function login() {
    if (!loginValues.username.trim() || !loginValues.password) {
      setAuthStatus('请输入用户名和密码');
      return;
    }

    setAuthStatus('正在登录...');
    try {
      const data = await requestJson('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginValues),
      });
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, data.token);
      setCurrentUser(data.user);
      setLoginValues({ username: '', password: '' });
      setAuthStatus(`已登录：${data.user.displayName}`);
    } catch (error) {
      setAuthStatus(`登录失败：${error.message}`);
    }
  }

  async function logout() {
    try {
      await requestJson('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Failed to logout cleanly', error);
    } finally {
      window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      setCurrentUser(null);
      setAuthStatus('已退出登录');
      setCompanySales([]);
      setXuSales([]);
      setBrazilSales([]);
      setBrazilBalance({ fineGoldBalanceAfter: 0, costBalanceAfterUsd: 0, createdAt: '' });
    }
  }

  async function saveFinancialDefaults() {
    const usdToUsdtRate = Number.parseFloat(financialDefaultsDraft);
    if (!Number.isFinite(usdToUsdtRate) || usdToUsdtRate <= 0) {
      setInventoryStatus('请先输入有效的 USD/USDT 汇率');
      return;
    }

    setInventoryStatus('正在保存默认汇率...');
    try {
      const data = await requestJson('/api/financial-defaults', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usdToUsdtRate }),
      });
      setFinancialDefaults(data);
      setFinancialDefaultsDraft(formatNumber(data.usdToUsdtRate, 4));
      setInventoryStatus(`已更新默认汇率：1 USD = ${formatNumber(data.usdToUsdtRate, 4)} U`);
    } catch (error) {
      setInventoryStatus(`保存默认汇率失败：${error.message}`);
    }
  }

  function persistCustomerProfile(customerName, customerPhone) {
    const normalizedName = customerName.trim();
    const normalizedPhone = customerPhone.trim();

    if (!normalizedName || !normalizedPhone) {
      return;
    }

    const nextCustomers = [
      { name: normalizedName, phone: normalizedPhone },
      ...savedCustomers.filter(
        (customer) => !(customer.name === normalizedName && customer.phone === normalizedPhone)
      ),
    ].slice(0, 12);

    setSavedCustomers(nextCustomers);
    window.localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(nextCustomers));
  }

  function buildPendingOrderSnapshot(order) {
    return {
      id: order.id,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      status: order.status,
      itemCount: order.summary.itemCount,
      totalAmount: order.summary.totalAmount,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
      items: order.items || [],
    };
  }

  function writePendingOrders(nextPendingOrders) {
    setPendingOrders(nextPendingOrders);
    window.localStorage.setItem(PENDING_ORDERS_STORAGE_KEY, JSON.stringify(nextPendingOrders));
  }

  function writeReservations(nextReservations) {
    setReservations(nextReservations);
  }

  function writeInventoryBatches(nextInventoryBatches) {
    setInventoryBatches(nextInventoryBatches);
    window.localStorage.setItem(INVENTORY_BATCHES_STORAGE_KEY, JSON.stringify(nextInventoryBatches));
  }

  function writeMeltRecords(nextMeltRecords) {
    setMeltRecords(nextMeltRecords);
    window.localStorage.setItem(MELT_RECORDS_STORAGE_KEY, JSON.stringify(nextMeltRecords));
  }

  function writeCompanySales(nextCompanySales) {
    setCompanySales(nextCompanySales);
    window.localStorage.setItem(COMPANY_SALES_STORAGE_KEY, JSON.stringify(nextCompanySales));
  }

  function writeXuSales(nextXuSales) {
    setXuSales(nextXuSales);
    window.localStorage.setItem(XU_SALES_STORAGE_KEY, JSON.stringify(nextXuSales));
  }

  function writeBrazilSales(nextBrazilSales) {
    setBrazilSales(nextBrazilSales);
    window.localStorage.setItem(BRAZIL_SALES_STORAGE_KEY, JSON.stringify(nextBrazilSales));
  }

  function upsertPendingOrder(order) {
    const snapshot = buildPendingOrderSnapshot(order);
    const nextPendingOrders = [
      snapshot,
      ...pendingOrders.filter((pendingOrder) => pendingOrder.id !== order.id),
    ];
    writePendingOrders(nextPendingOrders);
  }

  function removePendingOrder(orderId) {
    const nextPendingOrders = pendingOrders.filter((pendingOrder) => pendingOrder.id !== orderId);
    writePendingOrders(nextPendingOrders);
  }

  async function createReservation() {
    if (!ensureCustomerFilled()) {
      return;
    }

    const reservedWeight = Number.parseFloat(reservationValues.reservedWeight);
    const lockedIntlGoldPrice = Number.parseFloat(reservationValues.lockedIntlGoldPrice);
    const taxRate = Number.parseFloat(reservationValues.taxRate);

    if (!Number.isFinite(reservedWeight) || reservedWeight <= 0) {
      setSaveStatus('请先输入有效的预定克数');
      return;
    }

    if (!Number.isFinite(lockedIntlGoldPrice) || lockedIntlGoldPrice <= 0) {
      setSaveStatus('请先输入有效的预定国际金价');
      return;
    }

    if (!Number.isFinite(taxRate) || taxRate < 0) {
      setSaveStatus('请先输入有效的预定税点');
      return;
    }

    const reservedAt = reservationValues.reservedAt || new Date().toISOString().slice(0, 16);
    setBusyAction('create-reservation');

    try {
      const reservation = await requestJson('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: normalizedCustomerName,
          customerPhone: normalizedCustomerPhone,
          reservedWeight,
          lockedIntlGoldPrice,
          taxRate,
          reservedAt,
        }),
      });

      writeReservations([reservation, ...reservations.filter((item) => item.id !== reservation.id)]);
      setSelectedReservationIds((current) => (current.includes(reservation.id) ? current : [...current, reservation.id]));
      setReservationValues(initialReservationValues);
      setShowReservationForm(false);
      setSaveStatus(
        `已为 ${normalizedCustomerName} 新建预定：${formatNumber(reservedWeight, 4)}g，锁价 $ ${formatNumber(
          lockedIntlGoldPrice,
          2
        )}，税点 ${formatNumber(taxRate, 2)}%`
      );
    } catch (error) {
      setSaveStatus(`新建预定失败：${error.message}`);
    } finally {
      setBusyAction('');
    }
  }

  function toggleReservation(reservationId) {
    const targetReservation = currentCustomerReservations.find((reservation) => reservation.id === reservationId);
    if (!targetReservation) {
      return;
    }

    const isSelected = selectedReservationIds.includes(reservationId);
    const nextSelectedReservations = isSelected
      ? selectedReservations.filter((reservation) => reservation.id !== reservationId)
      : [...selectedReservations, targetReservation];

    setSelectedReservationIds(nextSelectedReservations.map((reservation) => reservation.id));
    if (nextSelectedReservations.length > 0) {
      const totalRemainingWeight = nextSelectedReservations.reduce(
        (sum, reservation) => sum + Number(reservation.remainingReservedWeight || 0),
        0
      );
      setSaveStatus(
        `已选择 ${nextSelectedReservations.length} 条预定，共可用 ${formatNumber(totalRemainingWeight, 4)}g`
      );
      return;
    }

    setSaveStatus('已取消本单预定选择，当前订单将按普通实时金价处理');
  }

  function clearSelectedReservations() {
    setSelectedReservationIds([]);
    setSaveStatus('已取消本单预定选择，当前订单将按普通实时金价处理');
  }

  async function deleteReservation(reservationId) {
    setBusyAction(`delete-reservation-${reservationId}`);
    try {
      await requestJson(`/api/reservations/${reservationId}`, {
        method: 'DELETE',
      });
      setSelectedReservationIds((current) => current.filter((id) => id !== reservationId));
      await refreshReservations(values.customerName.trim(), values.customerPhone.trim(), { silent: true });
      setSaveStatus('已删除这条预定');
    } catch (error) {
      setSaveStatus(`删除预定失败：${error.message}`);
    } finally {
      setBusyAction('');
    }
  }

  function handleCustomerSelect(event) {
    const { name, value } = event.target;
    if (!value) {
      return;
    }

    const selectedCustomer = savedCustomers.find((customer) =>
      name === 'customerName' ? customer.name === value : customer.phone === value
    );

    if (!selectedCustomer) {
      return;
    }

    setValues((current) => ({
      ...current,
      customerName: selectedCustomer.name,
      customerPhone: selectedCustomer.phone,
    }));
  }

  function handleCustomerBlur() {
    persistCustomerProfile(values.customerName, values.customerPhone);
  }

  function clearCustomerInfo() {
    setValues((current) => ({
      ...current,
      customerName: '',
      customerPhone: '',
    }));
    setReservations([]);
    setSelectedReservationIds([]);
    setSaveStatus('已清空客户信息，可以重新录入顾客姓名');
  }

  function ensureCustomerFilled() {
    if (!values.customerName.trim()) {
      setSaveStatus('请先输入顾客姓名，再开始订单');
      return false;
    }

    return true;
  }

  async function startNewOrder() {
    if (!ensureCustomerFilled()) {
      return;
    }

    setBusyAction('new-order');

    try {
      if (currentOrder && currentOrder.status !== 'paid' && currentOrder.items.length > 0) {
        upsertPendingOrder(currentOrder);
      }

      const order = await requestJson('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: values.customerName.trim(),
          customerPhone: values.customerPhone.trim(),
        }),
      });

      setCurrentOrder(order);
      setLastPaidOrder(null);
      persistCustomerProfile(values.customerName, values.customerPhone);
      setValues((current) => clearCurrentItemValues(current));
      setSaveStatus(
        selectedReservations.length > 0
          ? `已为 ${order.customerName} 新建订单，并关联 ${selectedReservations.length} 条预定，共可用 ${formatNumber(totalSelectedReservedWeight, 4)}g`
          : `已为 ${order.customerName} 新建订单，现在可以把本次带来的金子逐块加入`
      );
    } catch (error) {
      setSaveStatus(`新建订单失败：${error.message}`);
    } finally {
      setBusyAction('');
    }
  }

  async function addCurrentItemToOrder() {
    if (!ensureCustomerFilled()) {
      return;
    }

    const payload = buildRecordPayloadWithReservation(values, selectedReservations);
    if (payload.error) {
      setSaveStatus(payload.error);
      return;
    }

    if (!currentOrder) {
      setSaveStatus('请先新建订单，再把当前金子加入订单');
      return;
    }

    if (currentOrder.status === 'paid') {
      setSaveStatus('当前订单已完成支付，请先新建订单，再录入新的金子');
      return;
    }

    if (
      currentOrder.customerName.trim() !== values.customerName.trim() ||
      currentOrder.customerPhone.trim() !== values.customerPhone.trim()
    ) {
      setSaveStatus('当前输入的客户信息与已打开订单不一致，请先新建订单');
      return;
    }

    setBusyAction('add-item');

    try {
      const order = await requestJson(`/api/orders/${currentOrder.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      setCurrentOrder(order);
      if (pendingOrders.some((pendingOrder) => pendingOrder.id === order.id)) {
        upsertPendingOrder(order);
      }
      persistCustomerProfile(values.customerName, values.customerPhone);
      setValues((current) => clearCurrentItemValues(current));
      setSaveStatus(
        payload.usedReservationIds?.length
          ? payload.spotWeightApplied > 0
            ? `已加入当前订单，本块使用了 ${payload.usedReservationIds.length} 条预定，共 ${formatNumber(payload.reservedWeightApplied, 2)}g，剩余 ${formatNumber(payload.spotWeightApplied, 2)}g 按实时价结算`
            : `已加入当前订单，本块全部使用 ${payload.usedReservationIds.length} 条预定结算`
          : `已加入当前订单，第 ${order.summary.itemCount} 块金子已计入本单`
      );

      void refreshReservations(values.customerName.trim(), values.customerPhone.trim(), { silent: true });
      void refreshAllOrders({ silent: true });
    } catch (error) {
      setSaveStatus(`加入失败：${error.message}`);
    } finally {
      setBusyAction('');
    }
  }

  async function removeOrderItem(itemId) {
    if (!currentOrder) {
      return;
    }

    setBusyAction(`delete-${itemId}`);

    try {
      const order = await requestJson(`/api/orders/${currentOrder.id}/items/${itemId}`, {
        method: 'DELETE',
      });

      setCurrentOrder(order);
      await refreshReservations(order.customerName, order.customerPhone);
      await refreshAllOrders();
      if (pendingOrders.some((pendingOrder) => pendingOrder.id === order.id)) {
        upsertPendingOrder(order);
      }
      setSaveStatus(order.summary.itemCount ? '已从当前订单移除一块金子' : '当前订单已清空，可以重新录入');
    } catch (error) {
      setSaveStatus(`删除失败：${error.message}`);
    } finally {
      setBusyAction('');
    }
  }

  async function completePayment() {
    if (!currentOrder) {
      setSaveStatus('请先新建订单并加入至少一块金子');
      return;
    }

    if (!currentOrder.items.length) {
      setSaveStatus('当前订单还没有金子明细，暂时不能完成支付');
      return;
    }

    setBusyAction('pay-order');

    try {
      const order = await requestJson(`/api/orders/${currentOrder.id}/pay`, {
        method: 'PATCH',
      });

      removePendingOrder(order.id);
      setCurrentOrder(null);
      setLastPaidOrder(order);
      setValues(initialValues);
      await refreshAllOrders();
      setSaveStatus(
        `订单已完成支付，本单共 ${order.summary.itemCount} 块金子，总价 $ ${formatNumber(
          order.summary.totalAmount,
          0
        )}`
      );
    } catch (error) {
      setSaveStatus(`支付失败：${error.message}`);
    } finally {
      setBusyAction('');
    }
  }

  function resetCurrentItem() {
    setValues((current) => clearCurrentItemValues(current));
    setSaveStatus('已清空当前录入中的这块金子，订单里的已加入明细不会受影响');
  }

  function parkCurrentOrder() {
    if (!currentOrder) {
      setSaveStatus('当前没有进行中的订单可暂存');
      return;
    }

    if (currentOrder.status === 'paid') {
      setSaveStatus('已支付订单不需要暂存');
      return;
    }

    upsertPendingOrder(currentOrder);
    setCurrentOrder(null);
    setValues(initialValues);
    setSaveStatus(`已将 ${currentOrder.customerName} 的订单暂存到待处理区，你现在可以处理下一位客人`);
  }

  async function resumePendingOrder(orderId) {
    setBusyAction(`resume-${orderId}`);

    try {
      const order = await requestJson(`/api/orders/${orderId}`);
      setCurrentOrder(order);
      setValues((current) => ({
        ...current,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
      }));
      await refreshReservations(order.customerName, order.customerPhone);
      removePendingOrder(order.id);
      setSaveStatus(`已切回 ${order.customerName} 的订单，可以继续录入或完成支付`);
      intakeSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      setSaveStatus(`加载待处理订单失败：${error.message}`);
    } finally {
      setBusyAction('');
    }
  }

  function discardPendingOrder(orderId) {
    const targetOrder = pendingOrders.find((pendingOrder) => pendingOrder.id === orderId);
    removePendingOrder(orderId);

    if (currentOrder?.id === orderId) {
      setCurrentOrder(null);
      setValues(initialValues);
    }

    setSaveStatus(
      targetOrder
        ? `已将 ${targetOrder.customerName} 的待处理订单从列表移除`
        : '已移除待处理订单'
    );
  }

  function toggleInventoryBatch(batchId) {
    setSelectedInventoryBatchIds((current) =>
      current.includes(batchId) ? current.filter((id) => id !== batchId) : [...current, batchId]
    );
  }

  function clearInventorySelection() {
    setSelectedInventoryBatchIds([]);
  }

  function updateMeltField(event) {
    const { name, value } = event.target;
    const decimalFields = new Set(['outputDryWeight', 'outputWaterWeight']);
    setMeltValues((current) => ({
      ...current,
      [name]: decimalFields.has(name) ? sanitizeDecimalInput(value) : value,
    }));
  }

  function updateCompanySaleField(batchId, field, value) {
    setCompanySaleValues((current) => ({
      ...current,
      companyInputs: {
        ...current.companyInputs,
        [batchId]: {
          ...(current.companyInputs[batchId] || {}),
          [field]: value,
        },
      },
    }));
  }

  function updateBuyerType(event) {
    const { value } = event.target;
    setCompanySaleValues((current) => ({ ...current, buyerType: value }));
  }

  function updateXuSaleField(batchId, field, value) {
    setCompanySaleValues((current) => ({
      ...current,
      xuInputs: {
        ...current.xuInputs,
        [batchId]: {
          purityAdjustmentPercent: '0.1',
          ...(current.xuInputs[batchId] || {}),
          [field]: value,
        },
      },
    }));
  }

  function updateBrazilSaleField(batchId, field, value) {
    setCompanySaleValues((current) => ({
      ...current,
      brazilInputs: {
        ...current.brazilInputs,
        [batchId]: {
          purityAdjustmentPercent: '0.1',
          ...(current.brazilInputs[batchId] || {}),
          [field]: value,
        },
      },
    }));
  }

  function resetAdminForms() {
    setSelectedInventoryBatchIds([]);
    setMeltValues(initialMeltValues);
    setCompanySaleValues(initialCompanySaleValues);
  }

  function createMeltBatch() {
    const preview = calculateMeltPreview(selectedInventoryBatches, meltValues.outputDryWeight, meltValues.outputWaterWeight, meltValues.formulaRule);
    if (preview.error) {
      setInventoryStatus(preview.error);
      return;
    }

    const meltId = `melt-${Date.now()}`;
    const outputBatch = {
      id: meltId,
      sourceType: 'melt',
      sourceId: meltId,
      label: `熔合批次 ${meltRecords.length + 1}`,
      customerName: '库存熔合',
      createdAt: new Date().toISOString(),
      dryWeight: preview.outputDryWeight,
      waterWeight: preview.outputWaterWeight,
      purity: preview.purity,
      fineGoldWeight: preview.fineGoldWeight,
      totalCostUsd: preview.inputTotalCostUsd,
      referenceIntlGoldPrice: preview.weightedAverageIntlGoldPrice,
      referenceIntlGoldPriceLabel: '我方收入国际金价（加权平均）',
      remainingFineGoldWeight: preview.fineGoldWeight,
      status: 'available',
      formulaRule: meltValues.formulaRule,
      sourceBatchIds: selectedInventoryBatches.map((batch) => batch.id),
    };

    const nextInventoryBatches = inventoryBatches.map((batch) =>
      selectedInventoryBatchIds.includes(batch.id)
        ? { ...batch, status: 'melted', consumedBy: meltId }
        : batch
    );
    writeInventoryBatches([outputBatch, ...nextInventoryBatches]);
    writeMeltRecords([
      {
        id: meltId,
        createdAt: outputBatch.createdAt,
        sourceBatchIds: selectedInventoryBatches.map((batch) => batch.id),
        inputTotalDryWeight: preview.inputTotalDryWeight,
        inputTotalCostUsd: preview.inputTotalCostUsd,
        outputDryWeight: preview.outputDryWeight,
        outputWaterWeight: preview.outputWaterWeight,
        purity: preview.purity,
        fineGoldWeight: preview.fineGoldWeight,
        weightDifference: preview.weightDifference,
      },
      ...meltRecords,
    ]);
    setInventoryStatus(`已生成 ${outputBatch.label}，熔前 ${formatNumber(preview.inputTotalDryWeight, 2)}g，熔后 ${formatNumber(preview.outputDryWeight, 2)}g`);
    resetAdminForms();
  }

  function createCompanySale() {
    if (companySaleValues.buyerType === 'brazil') {
      const preview = calculateBrazilSalePreview(
        selectedInventoryBatches,
        companySaleValues.brazilInputs,
        companySaleValues.taxRatePercent,
        financialDefaults.usdToUsdtRate,
        brazilFineGoldBalanceBefore,
        brazilCostBalanceBeforeUsd
      );
      if (preview.error) {
        setInventoryStatus(preview.error);
        return;
      }
      if (!Number.isFinite(brazilUsdToUsdtRate) || brazilUsdToUsdtRate <= 0) {
        setInventoryStatus('请管理员先设置有效的 USD/USDT 默认汇率');
        return;
      }

      const createdAt = new Date().toISOString();
      setInventoryStatus('正在保存巴西佬卖出记录...');
      requestJson('/api/brazil-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerType: 'brazil',
          currency: 'USDT',
          createdAt,
          inventoryBatchIds: selectedInventoryBatches.map((batch) => batch.id),
          taxRatePercent: Number.parseFloat(companySaleValues.taxRatePercent),
          usdToUsdtRate: brazilUsdToUsdtRate,
          grossRevenueUsdt: preview.grossRevenueUsdt,
          grossRevenueUsdConverted: preview.grossRevenueUsdConverted,
          inventoryCostUsd: preview.inventoryCostUsd,
          settledCostUsd: preview.settledCostUsd,
          grossProfitUsdConverted: preview.grossProfitUsdConverted,
          fineGoldDelivered: preview.fineGoldDelivered,
          fineGoldSettled: preview.fineGoldSettled,
          fineGoldBalanceBefore: preview.fineGoldBalanceBefore,
          fineGoldBalanceAfter: preview.fineGoldBalanceAfter,
          costBalanceBeforeUsd: preview.costBalanceBeforeUsd,
          costBalanceAfterUsd: preview.costBalanceAfterUsd,
          profitStatus: '已按汇率换算',
          lines: preview.lines,
        }),
      })
        .then((savedSale) => {
          writeBrazilSales([savedSale, ...brazilSales.filter((sale) => sale.id !== savedSale.id)]);
          setBrazilBalance({
            fineGoldBalanceAfter: Number(savedSale.fineGoldBalanceAfter || 0),
            costBalanceAfterUsd: Number(savedSale.costBalanceAfterUsd || 0),
            createdAt: savedSale.createdAt || '',
          });
          writeInventoryBatches(
            inventoryBatches.map((batch) =>
              selectedInventoryBatchIds.includes(batch.id)
                ? { ...batch, status: 'sold_to_brazil', soldBy: savedSale.id }
                : batch
            )
          );
          setInventoryStatus(
            canViewProfit
              ? `已保存巴西佬卖出记录，收入 ${formatNumber(preview.grossRevenueUsdt, 2)} USDT，折美元 $ ${formatNumber(
                  preview.grossRevenueUsdConverted,
                  2
                )}，利润 $ ${formatNumber(preview.grossProfitUsdConverted, 2)}，克数余额 ${formatNumber(
                  preview.fineGoldBalanceAfter,
                  2
                )}g`
              : `已保存巴西佬卖出记录，收入 ${formatNumber(preview.grossRevenueUsdt, 2)} USDT`
          );
          resetAdminForms();
        })
        .catch((error) => {
          setInventoryStatus(`保存巴西佬卖出失败：${error.message}`);
        });
      return;
    }

    if (companySaleValues.buyerType === 'xuzong') {
      const preview = calculateXuSalePreview(
        selectedInventoryBatches,
        companySaleValues.xuInputs,
        companySaleValues.taxRatePercent,
        0
      );
      if (preview.error) {
        setInventoryStatus(preview.error);
        return;
      }
      if (!Number.isFinite(xuUsdToUsdtRate) || xuUsdToUsdtRate <= 0) {
        setInventoryStatus('请管理员先设置有效的 USD/USDT 默认汇率');
        return;
      }

      const createdAt = new Date().toISOString();
      setInventoryStatus('正在保存许总卖出记录...');
      requestJson('/api/xu-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerType: 'xuzong',
          currency: 'USDT',
          createdAt,
          inventoryBatchIds: selectedInventoryBatches.map((batch) => batch.id),
          taxRatePercent: Number.parseFloat(companySaleValues.taxRatePercent),
          usdToUsdtRate: xuUsdToUsdtRate,
          grossRevenueUsdt: preview.grossRevenueUsdt,
          grossRevenueUsdConverted: xuGrossRevenueUsdConverted,
          inventoryCostUsd: preview.inventoryCostUsd,
          grossProfitUsdConverted: xuGrossProfitUsdConverted,
          profitStatus: '已按汇率换算',
          lines: preview.lines,
        }),
      })
        .then((savedSale) => {
          writeXuSales([savedSale, ...xuSales.filter((sale) => sale.id !== savedSale.id)]);
          writeInventoryBatches(
            inventoryBatches.map((batch) =>
              selectedInventoryBatchIds.includes(batch.id)
                ? { ...batch, status: 'sold_to_xuzong', soldBy: savedSale.id }
                : batch
            )
          );
          setInventoryStatus(
            canViewProfit
              ? `已保存许总卖出记录，收入 ${formatNumber(preview.grossRevenueUsdt, 0)} USDT，折美元 $ ${formatNumber(
                  xuGrossRevenueUsdConverted,
                  2
                )}，利润 $ ${formatNumber(xuGrossProfitUsdConverted, 2)}`
              : `已保存许总卖出记录，收入 ${formatNumber(preview.grossRevenueUsdt, 0)} USDT`
          );
          resetAdminForms();
        })
        .catch((error) => {
          setInventoryStatus(`保存许总卖出失败：${error.message}`);
        });
      return;
    }

    const preview = calculateCompanySalePreview(selectedInventoryBatches, companySaleValues.companyInputs);
    if (preview.error) {
      setInventoryStatus(preview.error);
      return;
    }

    const createdAt = new Date().toISOString();
    setInventoryStatus('正在保存公司卖出记录...');
    requestJson('/api/company-sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyerType: 'company',
        currency: 'USD',
        createdAt,
        inventoryBatchIds: selectedInventoryBatches.map((batch) => batch.id),
        grossRevenueUsd: preview.grossRevenueUsd,
        inventoryCostUsd: preview.inventoryCostUsd,
        grossProfitUsd: preview.grossProfitUsd,
        lines: preview.lines,
      }),
    })
      .then((savedSale) => {
        writeCompanySales([savedSale, ...companySales.filter((sale) => sale.id !== savedSale.id)]);
        writeInventoryBatches(
          inventoryBatches.map((batch) =>
            selectedInventoryBatchIds.includes(batch.id)
              ? { ...batch, status: 'sold_to_company', soldBy: savedSale.id }
              : batch
          )
        );
        setInventoryStatus(`已保存公司卖出记录，收入 $ ${formatNumber(preview.grossRevenueUsd, 0)}，利润 $ ${formatNumber(preview.grossProfitUsd, 2)}`);
        resetAdminForms();
      })
      .catch((error) => {
        setInventoryStatus(`保存公司卖出失败：${error.message}`);
      });
  }

  const currentRule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];
  const currentOrderSummary = currentOrder?.summary || { itemCount: 0, totalAmount: 0 };
  const canCompleteOrder = currentOrder && currentOrder.items.length > 0 && currentOrder.status !== 'paid';
  const availableInventoryBatches = inventoryBatches.filter((batch) => batch.status === 'available');
  const inventoryBatchMap = new Map(inventoryBatches.map((batch) => [batch.id, batch]));
  const displayedInventoryBatches = availableInventoryBatches.map((batch) => {
    const referenceIntlGoldPrice = resolveReferenceIntlGoldPrice(batch, inventoryBatchMap);
    return {
      ...batch,
      referenceIntlGoldPrice: referenceIntlGoldPrice.value,
      referenceIntlGoldPriceLabel: referenceIntlGoldPrice.label,
    };
  });
  const selectedInventoryBatches = selectedInventoryBatchIds
    .map((batchId) => displayedInventoryBatches.find((batch) => batch.id === batchId))
    .filter(Boolean);
  const meltPreview = calculateMeltPreview(selectedInventoryBatches, meltValues.outputDryWeight, meltValues.outputWaterWeight, meltValues.formulaRule);
  const companySalePreview = calculateCompanySalePreview(selectedInventoryBatches, companySaleValues.companyInputs);
  const xuSalePreview = calculateXuSalePreview(
    selectedInventoryBatches,
    companySaleValues.xuInputs,
    companySaleValues.taxRatePercent
  );
  const latestBrazilSnapshot = canViewProfit ? (brazilSales[0] || brazilBalance) : brazilBalance;
  const brazilFineGoldBalanceBefore = Number(latestBrazilSnapshot?.fineGoldBalanceAfter || 0);
  const brazilCostBalanceBeforeUsd = Number(latestBrazilSnapshot?.costBalanceAfterUsd || 0);
  const brazilSalePreview = calculateBrazilSalePreview(
    selectedInventoryBatches,
    companySaleValues.brazilInputs,
    companySaleValues.taxRatePercent,
    financialDefaults.usdToUsdtRate,
    brazilFineGoldBalanceBefore,
    brazilCostBalanceBeforeUsd
  );
  const xuUsdToUsdtRate = Number.parseFloat(financialDefaults.usdToUsdtRate);
  const brazilUsdToUsdtRate = Number.parseFloat(financialDefaults.usdToUsdtRate);
  const xuGrossRevenueUsdConverted =
    Number.isFinite(xuSalePreview.grossRevenueUsdt) && Number.isFinite(xuUsdToUsdtRate) && xuUsdToUsdtRate > 0
      ? xuSalePreview.grossRevenueUsdt / xuUsdToUsdtRate
      : Number.NaN;
  const xuGrossProfitUsdConverted =
    Number.isFinite(xuGrossRevenueUsdConverted) && Number.isFinite(xuSalePreview.inventoryCostUsd)
      ? xuGrossRevenueUsdConverted - xuSalePreview.inventoryCostUsd
      : Number.NaN;
  const hasWeightedAverageReference = selectedInventoryBatches.some((batch) =>
    batch.referenceIntlGoldPriceLabel?.includes('加权平均')
  );
  const companySaleLinePreviewByBatchId = new Map(
    selectedInventoryBatches
      .map((batch) => [batch.id, calculateCompanySaleLinePreview(batch, companySaleValues.companyInputs[batch.id] || {})])
      .filter(([, preview]) => preview)
  );
  const xuSaleLinePreviewByBatchId = new Map(
    selectedInventoryBatches
      .map((batch) => [
        batch.id,
        calculateXuSaleLinePreview(
          batch,
          companySaleValues.xuInputs[batch.id] || {},
          companySaleValues.taxRatePercent
        ),
      ])
      .filter(([, preview]) => preview)
  );
  const brazilSaleLinePreviewByBatchId = new Map(
    selectedInventoryBatches
      .map((batch) => [
        batch.id,
        calculateBrazilSaleLinePreview(
          batch,
          companySaleValues.brazilInputs[batch.id] || { purityAdjustmentPercent: '0.1' },
          companySaleValues.taxRatePercent
        ),
      ])
      .filter(([, preview]) => preview)
  );

  if (!currentUser) {
    return (
      <div className="app-shell auth-shell">
        <section className="surface auth-surface">
          <div className="section-heading">
            <h2>员工登录</h2>
            <span className="pill">按账号加载权限</span>
          </div>
          <p className="hero-copy admin-copy">
            登录后系统会根据你的权限，决定你能录入收金、熔合、卖出，还是查看利润和算法说明。
          </p>
          <div className="form-grid auth-grid">
            <label className="field">
              <span>用户名</span>
              <input
                name="username"
                type="text"
                placeholder="例如 admin 或 staff"
                value={loginValues.username}
                onChange={updateLoginField}
              />
            </label>
            <label className="field">
              <span>密码</span>
              <input
                name="password"
                type="password"
                placeholder="请输入密码"
                value={loginValues.password}
                onChange={updateLoginField}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    login();
                  }
                }}
              />
            </label>
          </div>
          <div className="actions">
            <button className="button button-primary" type="button" onClick={login}>
              登录进入系统
            </button>
          </div>
          <p className="save-status">{authStatus}</p>
          <p className="order-items-empty">请输入你的账号和密码登录系统。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="hero">
        <div>
          <p className="eyebrow">React + FastAPI</p>
          <h1>黄金价格计算器</h1>
          <p className="hero-copy">
            第二版已经把订单流程接到后端。现在新建订单、加入金子、删除明细和完成支付都会走服务端存储；如果 Airtable 已配置，数据会直接按订单结构保存进去。
          </p>
        </div>
        <div className="hero-panel">
          <div className="hero-stat-label">当前订单</div>
          <div className="hero-stat-value">
            {currentOrder ? `${currentOrderSummary.itemCount} 件 / $ ${formatNumber(currentOrderSummary.totalAmount, 0)}` : '未开始'}
          </div>
          <div className="hero-stat-sub">
            {currentOrder
              ? `${currentOrder.customerName || '未命名客户'} · ${currentOrder.status === 'paid' ? '已支付' : '进行中'}`
              : '先输入客户信息，再点击“新建订单”'}
          </div>
          <div className="order-meta-list">
            <div>当前用户：{currentUser.displayName}（{currentUser.role}）</div>
            <div>后端状态：{backendStatus}</div>
            <div>存储模式：{storageMode}</div>
            {currentOrder && <div>订单编号：{currentOrder.id.slice(0, 14)}</div>}
            {lastPaidOrder && lastPaidOrder.paidAt && (
              <div>最近结清：{formatDateTimeInSuriname(lastPaidOrder.paidAt)}</div>
            )}
          </div>
          <div className="actions">
            <button className="button button-secondary" type="button" onClick={logout}>
              退出登录
            </button>
          </div>
        </div>
      </div>

      <div className="layout">
        {canIntakeGold && (
          <>
        <section className="surface" ref={intakeSectionRef}>
          <div className="section-heading">
            <h2>录入当前金子</h2>
            <span className="pill">当前规则：{currentRule.label}</span>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>顾客姓名</span>
              <div className="input-shell">
                <input
                  name="customerName"
                  type="text"
                  placeholder="例如 张三"
                  value={values.customerName}
                  onChange={updateField}
                  onInput={handleCustomerSelect}
                  onBlur={handleCustomerBlur}
                  list="saved-customer-names"
                />
                {values.customerName && (
                  <button className="input-clear" type="button" onClick={() => clearField('customerName')} aria-label="清空顾客姓名">
                    ×
                  </button>
                )}
              </div>
              <datalist id="saved-customer-names">
                {savedCustomers.map((customer) => (
                  <option key={`${customer.name}-${customer.phone}`} value={customer.name} />
                ))}
              </datalist>
              <small>同一个客户当天再次到店，也请新建一张新订单，避免把已结清的混进来。</small>
            </label>

            {/*
            <label className="field">
              <span>手机号</span>
              <div className="input-shell">
                <input
                  name="customerPhone"
                  type="tel"
                  placeholder="例如 13800138000"
                  value={values.customerPhone}
                  onChange={updateField}
                  onInput={handleCustomerSelect}
                  onBlur={handleCustomerBlur}
                  list="saved-customer-phones"
                />
                {values.customerPhone && (
                  <button className="input-clear" type="button" onClick={() => clearField('customerPhone')} aria-label="清空手机号">
                    ×
                  </button>
                )}
              </div>
              <datalist id="saved-customer-phones">
                {savedCustomers.map((customer) => (
                  <option key={`${customer.phone}-${customer.name}`} value={customer.phone} />
                ))}
              </datalist>
              <small>优先用姓名和手机号一起识别客户，减少同名混淆。</small>
            </label>
            */}

            <div className="field field-full field-center">
              <div className="customer-actions">
                <button className="button button-primary button-inline-center" type="button" onClick={startNewOrder} disabled={busyAction !== ''}>
                  新建订单
                </button>
                <button
                  className="button button-secondary button-inline-center"
                  type="button"
                  onClick={clearCustomerInfo}
                  disabled={busyAction !== '' || Boolean(currentOrder)}
                >
                  清空客户信息
                </button>
              </div>
              <small>先确认顾客姓名，再点击这里开始这一位客人的新订单。</small>
            </div>

            <div className="reservation-card field-full">
              <div className="reservation-header">
                <div>
                  <h3>预定信息</h3>
                  <p>先看当前客户有没有预定；有的话选中使用，没有就现场补录。</p>
                </div>
                <button
                  className="button button-secondary button-inline"
                  type="button"
                  onClick={() => setShowReservationForm((current) => !current)}
                  disabled={busyAction !== ''}
                >
                  {showReservationForm ? '收起预定表单' : '新建预定'}
                </button>
              </div>

              {!normalizedCustomerName ? (
                <p className="reservation-empty">请先输入顾客姓名，再查看或新建预定。</p>
              ) : (
                <>
                  {selectedReservations.length > 0 ? (
                    <div className="reservation-selected">
                      <div className="reservation-selected-top">
                        <strong>本单已选 {selectedReservations.length} 条预定</strong>
                        <button type="button" className="text-button" onClick={clearSelectedReservations}>
                          清空已选
                        </button>
                      </div>
                      <div className="reservation-grid">
                        <span>总可用克数 {formatNumber(totalSelectedReservedWeight, 4)}g</span>
                        <span>已选预定数 {selectedReservations.length} 条</span>
                        <span>最低锁价 $ {formatNumber(Math.min(...selectedReservations.map((reservation) => Number(reservation.lockedIntlGoldPrice))), 2)}</span>
                        <span>最高锁价 $ {formatNumber(Math.max(...selectedReservations.map((reservation) => Number(reservation.lockedIntlGoldPrice))), 2)}</span>
                        <span>最低税点 {formatNumber(Math.min(...selectedReservations.map((reservation) => Number(reservation.taxRate || 0))), 2)}%</span>
                        <span>最高税点 {formatNumber(Math.max(...selectedReservations.map((reservation) => Number(reservation.taxRate || 0))), 2)}%</span>
                      </div>
                    </div>
                  ) : (
                    <p className="reservation-empty">当前订单还没有选中预定，默认会按实时国际金价结算。</p>
                  )}

                  {currentCustomerReservations.length === 0 ? (
                    <p className="reservation-empty">这位客户目前没有未完成预定，可以直接新建一条。</p>
                  ) : (
                    <div className="reservation-list">
                      {currentCustomerReservations.map((reservation) => (
                        <article
                          className={`reservation-item${selectedReservationIds.includes(reservation.id) ? ' reservation-item-active' : ''}`}
                          key={reservation.id}
                        >
                          <div className="reservation-item-top">
                            <strong>{formatNumber(reservation.remainingReservedWeight, 4)}g 可用预定</strong>
                            <div className="reservation-actions">
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => toggleReservation(reservation.id)}
                                disabled={busyAction !== '' && busyAction !== `delete-reservation-${reservation.id}`}
                              >
                                {selectedReservationIds.includes(reservation.id) ? '已选择' : '加入预定'}
                              </button>
                              <button
                                type="button"
                                className="text-button text-button-danger"
                                onClick={() => deleteReservation(reservation.id)}
                                disabled={busyAction !== ''}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                          <div className="reservation-grid">
                            <span>剩余 {formatNumber(reservation.remainingReservedWeight, 4)}g</span>
                            <span>锁价 $ {formatNumber(reservation.lockedIntlGoldPrice, 2)}</span>
                            <span>税点 {formatNumber(reservation.taxRate || 0, 2)}%</span>
                            <span>预定时间 {formatDateTimeInSuriname(reservation.reservedAt)}</span>
                            <span>状态 {reservation.status}</span>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}

              {showReservationForm && (
                <div className="reservation-form">
                  <div className="form-grid">
                    <label className="field">
                      <span>预定克数</span>
                      <input
                        name="reservedWeight"
                        type="text"
                        inputMode="decimal"
                        placeholder="例如 500"
                        value={reservationValues.reservedWeight}
                        onChange={updateReservationField}
                      />
                    </label>

                    <label className="field">
                      <span>锁定国际金价</span>
                      <input
                        name="lockedIntlGoldPrice"
                        type="text"
                        inputMode="decimal"
                        placeholder="例如 3939"
                        value={reservationValues.lockedIntlGoldPrice}
                        onChange={updateReservationField}
                      />
                    </label>

                    <label className="field">
                      <span>预定税点（%）</span>
                      <input
                        name="taxRate"
                        type="text"
                        inputMode="decimal"
                        placeholder="例如 7.5"
                        value={reservationValues.taxRate}
                        onChange={updateReservationField}
                      />
                    </label>

                    <label className="field field-full">
                      <span>预定时间</span>
                      <input
                        name="reservedAt"
                        type="datetime-local"
                        value={reservationValues.reservedAt}
                        onChange={updateReservationField}
                      />
                      <small>不填则默认使用当前时间。</small>
                    </label>
                  </div>

                  <div className="actions">
                    <button className="button button-primary" type="button" onClick={createReservation}>
                      保存预定
                    </button>
                  </div>
                </div>
              )}
            </div>

            <label className="field">
              <span>干重</span>
              <div className="input-shell">
                <input name="dryWeight" type="text" inputMode="decimal" placeholder="例如 19.84" value={values.dryWeight} onChange={updateField} />
                {values.dryWeight && (
                  <button className="input-clear" type="button" onClick={() => clearField('dryWeight')} aria-label="清空干重">
                    ×
                  </button>
                )}
              </div>
            </label>

            <label className="field">
              <span>水重</span>
              <div className="input-shell">
                <input name="waterWeight" type="text" inputMode="decimal" placeholder="例如 16.23" value={values.waterWeight} onChange={updateField} />
                {values.waterWeight && (
                  <button className="input-clear" type="button" onClick={() => clearField('waterWeight')} aria-label="清空水重">
                    ×
                  </button>
                )}
              </div>
            </label>

            <label className="field">
              <span>税点（%）</span>
              <div className="input-shell">
                <input name="taxRate" type="text" inputMode="decimal" placeholder="例如 3" value={values.taxRate} onChange={updateField} />
                {values.taxRate && (
                  <button className="input-clear" type="button" onClick={() => clearField('taxRate')} aria-label="清空税点">
                    ×
                  </button>
                )}
              </div>
              <small>这里输入百分数本身，例如 3 表示 3%。</small>
            </label>

            <label className="field">
              <span>国际金价（美元/盎司）</span>
              <div className="input-shell">
                <input name="intlGoldPrice" type="text" inputMode="decimal" placeholder="例如 3000" value={values.intlGoldPrice} onChange={updateField} />
                {values.intlGoldPrice && (
                  <button className="input-clear" type="button" onClick={() => clearField('intlGoldPrice')} aria-label="清空国际金价">
                    ×
                  </button>
                )}
              </div>
              <small>{values.pricingMode === 'manual' ? '手动定价时这里只保留公式参考值，不参与最终定价。' : '公式中会先换算成每克美元价格：国际金价 ÷ 31.1035。'}</small>
            </label>

            <label className="field">
              <span>定价方式</span>
              <select name="pricingMode" value={values.pricingMode} onChange={updateField}>
                <option value="auto">自动计算</option>
                <option value="manual">手动录入</option>
              </select>
              <small>{values.pricingMode === 'manual' ? '适合小块特殊件。手动定价暂不支持和预定同时一起使用。' : '默认按公式自动计算纯度和每克金价。'}</small>
            </label>

            <label className="field field-full">
              <span>计算规则</span>
              <select name="formulaRule" value={values.formulaRule} onChange={updateField}>
                {Object.entries(FORMULA_RULES).map(([key, rule]) => (
                  <option key={key} value={key}>
                    {rule.label}（-{rule.constant}）
                  </option>
                ))}
              </select>
              <small>当前只预览这块金子的结果，加入订单后会进入右侧明细汇总。</small>
            </label>

            {values.pricingMode === 'manual' && (
              <>
                <label className="field">
                  <span>手动纯度（%）</span>
                  <div className="input-shell">
                    <input name="manualPurity" type="text" inputMode="decimal" placeholder="例如 89" value={values.manualPurity} onChange={updateField} />
                    {values.manualPurity && (
                      <button className="input-clear" type="button" onClick={() => clearField('manualPurity')} aria-label="清空手动纯度">
                        ×
                      </button>
                    )}
                  </div>
                  <small>最终记录会采用这里的纯度，右侧会同时保留公式参考值。</small>
                </label>

                <label className="field">
                  <span>手动每克金价（美元）</span>
                  <div className="input-shell">
                    <input name="manualPerGramPrice" type="text" inputMode="decimal" placeholder="例如 119.12" value={values.manualPerGramPrice} onChange={updateField} />
                    {values.manualPerGramPrice && (
                      <button className="input-clear" type="button" onClick={() => clearField('manualPerGramPrice')} aria-label="清空手动每克金价">
                        ×
                      </button>
                    )}
                  </div>
                  <small>总价会按 干重 × 手动每克金价 自动计算。</small>
                </label>
              </>
            )}
          </div>

          <div className="actions">
            <button className="button button-primary" type="button" onClick={addCurrentItemToOrder} disabled={busyAction !== '' || !currentOrder}>
              加入当前订单
            </button>
            <button className="button button-secondary" type="button" onClick={completePayment} disabled={busyAction !== '' || !canCompleteOrder}>
              完成支付
            </button>
            <button className="button button-secondary" type="button" onClick={parkCurrentOrder} disabled={busyAction !== '' || !currentOrder || currentOrder.status === 'paid'}>
              暂存待处理
            </button>
            <button className="button button-secondary" type="button" onClick={resetCurrentItem} disabled={busyAction !== ''}>
              清空当前块
            </button>
          </div>

          <p className="save-status">{saveStatus}</p>

          <div className="formula-card">
            <div className="badge">当前规则：{currentRule.label}</div>
            <div>
              <strong>纯度公式：</strong>
              <code>水重 / 干重 × 2307.454 - {formatNumber(currentRule.constant, 3)}</code>
            </div>
            <div>
              <strong>每克金价公式：</strong>
              <code>(国际金价 / 31.1035) × (1 - 税点%) × 纯度%</code>
            </div>
            <div>
              <strong>单块总价公式：</strong>
              <code>{results.isSplitPricing ? '预定价部分金额 + 实时价部分金额' : '干重 × 每克金价'}</code>
            </div>
            <p>
              {results.isSplitPricing
                ? '说明：当前块使用了预定，系统会把预定部分和超出部分分别计价，再汇总成总价。'
                : '说明：当前订单已经接到后端。完成支付后，这张订单会锁定；客户再次到店时，请重新新建订单。'}
            </p>
          </div>
        </section>

        <section className="surface">
          <div className="section-heading">
            <h2>当前订单</h2>
            <span className="pill soft">
              {currentOrder
                ? currentOrder.status === 'paid'
                  ? '已支付'
                  : '进行中'
                : '等待开始'}
            </span>
          </div>

          <div className="results">
            <article className="result-card accent-green">
              <div className="result-label">当前块纯度</div>
              <div className="result-value">{results.purityText}</div>
              <div className="result-sub">{results.puritySub}</div>
            </article>

            <article className="result-card accent-amber">
              <div className="result-label">当前块每克价</div>
              {results.isSplitPricing && results.splitAllocations.length > 0 ? (
                <div className="split-preview">
                  {results.splitAllocations.map((allocation) => (
                    <div className="split-preview-row" key={`per-gram-${allocation.label}`}>
                      <div className="split-preview-name">{allocation.label}</div>
                      <div className="split-preview-meta">{allocation.weightText}</div>
                      <div className="split-preview-value">{allocation.perGramText}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="result-value">{results.perGramText}</div>
              )}
              <div className="result-sub">{results.perGramSub}</div>
            </article>

            <article className="result-card accent-amber">
              <div className="result-label">当前块总价</div>
              {results.isSplitPricing && results.splitAllocations.length > 0 ? (
                <>
                  <div className="split-preview">
                    {results.splitAllocations.map((allocation) => (
                      <div className="split-preview-row" key={`amount-${allocation.label}`}>
                        <div className="split-preview-name">{allocation.label}</div>
                        <div className="split-preview-meta">{allocation.weightText}</div>
                        <div className="split-preview-value">{allocation.amountText}</div>
                      </div>
                    ))}
                  </div>
                  <div className="split-total-row">
                    <span>整块合计</span>
                    <strong>$ {formatNumber(results.splitAllocations.reduce((sum, allocation) => {
                      const numericAmount = Number.parseFloat(String(allocation.amountText).replace(/[$,\s]/g, ''));
                      return sum + (Number.isFinite(numericAmount) ? numericAmount : 0);
                    }, 0), 0)}</strong>
                  </div>
                </>
              ) : (
                <div className="result-value">{results.totalPriceText}</div>
              )}
              <div className="result-sub">{results.totalPriceSub}</div>
            </article>

            <article className="result-card">
              <div className="result-label">本单汇总</div>
              <div className="result-value">
                {currentOrder ? `${currentOrderSummary.itemCount} 件 / $ ${formatNumber(currentOrderSummary.totalAmount, 0)}` : '--'}
              </div>
              <div className="result-sub">
                {currentOrder
                  ? `${currentOrder.customerName} · ${currentOrder.customerPhone || '未填写手机号'}`
                  : '新建订单后，右侧会按本次交易实时汇总所有金子'}
              </div>
            </article>
          </div>

          <div className="order-items-card">
            <div className="order-items-heading">
              <h3>本单金子明细</h3>
              <span>{currentOrderSummary.itemCount} 块</span>
            </div>

            {!currentOrder ? (
              <p className="order-items-empty">
                还没有开始订单。先输入客户信息，然后点击“新建订单”。
              </p>
            ) : (
              <>
                <article className="order-overview">
                  <div className="order-overview-top">
                    <strong>{currentOrder.customerName}</strong>
                    <span className="order-status-chip">
                      {currentOrder.status === 'paid' ? '已支付' : '进行中'}
                    </span>
                  </div>
                  <div className="order-overview-grid">
                    <span>订单编号 {currentOrder.id.slice(0, 14)}</span>
                    <span>手机号 {currentOrder.customerPhone || '--'}</span>
                    <span>创建时间 {formatDateTimeInSuriname(currentOrder.createdAt)}</span>
                    <span>本单总价 $ {formatNumber(currentOrderSummary.totalAmount, 0)}</span>
                  </div>
                </article>

                {currentOrder.items.length === 0 ? (
                  <p className="order-items-empty">
                    当前订单已经创建成功。现在录入第一块金子，然后点击“加入当前订单”。
                  </p>
                ) : (
                  <div className="order-items-list">
                    {currentOrder.items.map((item, index) => (
                      <article className="order-item" key={item.id}>
                        <div className="order-item-top">
                          <strong>第 {index + 1} 块{item.pricingMode === 'manual' ? ' · 手动定价' : ''}</strong>
                          {currentOrder.status !== 'paid' && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => removeOrderItem(item.id)}
                              disabled={busyAction !== ''}
                            >
                              删除
                            </button>
                          )}
                        </div>
                        <div className="order-item-grid">
                          <span>干重 {formatNumber(item.dryWeight, 4)}</span>
                          <span>水重 {formatNumber(item.waterWeight, 4)}</span>
                          <span>纯度 {formatNumber(item.effectivePurity ?? item.purity, 2)}%</span>
                          <span>
                            {item.allocations?.length > 1 ? '计价方式 拆分计价' : `国际金价 $ ${formatNumber(item.intlGoldPrice, 2)}`}
                          </span>
                          <span>
                            {item.allocations?.length > 1 ? '单价 以下方明细为准' : `每克 $ ${formatNumber(item.effectivePerGramPrice ?? item.finalPrice, 2)}`}
                          </span>
                        </div>
                        {item.allocations?.length > 0 && (
                          <div className="allocation-list">
                            {item.allocations.map((allocation, allocationIndex) => (
                              <div className="allocation-item" key={`${item.id}-allocation-${allocationIndex}`}>
                                <strong>{allocation.label}</strong>
                                <div className="order-item-grid">
                                  <span>克数 {formatNumber(allocation.allocatedWeight, 2)}g</span>
                                  <span>国际金价 $ {formatNumber(allocation.intlGoldPriceUsed, 2)}</span>
                                  <span>税点 {formatNumber(allocation.taxRateUsed ?? item.taxRate, 2)}%</span>
                                  <span>每克 $ {formatNumber(allocation.finalPrice, 2)}</span>
                                  <span>金额 $ {formatNumber(allocation.lineTotal, 0)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="order-item-total">小计：$ {formatNumber(item.totalPrice, 0)}</div>
                      </article>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="order-items-card">
            <div className="order-items-heading">
              <h3>待处理订单</h3>
              <span>{pendingOrders.length} 单</span>
            </div>

            {pendingOrders.length === 0 ? (
              <p className="order-items-empty">
                暂时没有挂起的订单。点击“暂存待处理”后，这里会保留未支付客户，方便稍后继续处理。
              </p>
            ) : (
              <div className="pending-orders-list">
                {pendingOrders.map((pendingOrder) => (
                  <article className="pending-order" key={pendingOrder.id}>
                    <div className="order-item-top">
                      <strong>{pendingOrder.customerName}</strong>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => resumePendingOrder(pendingOrder.id)}
                          disabled={busyAction !== ''}
                        >
                          查看
                        </button>
                        <button
                          type="button"
                          className="text-button text-button-danger"
                          onClick={() => discardPendingOrder(pendingOrder.id)}
                          disabled={busyAction !== ''}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                    <div className="order-item-grid">
                      <span>订单编号 {pendingOrder.id.slice(0, 14)}</span>
                      <span>手机号 {pendingOrder.customerPhone || '--'}</span>
                      <span>{pendingOrder.itemCount} 块</span>
                      <span>总价 $ {formatNumber(pendingOrder.totalAmount, 0)}</span>
                    </div>
                    {pendingOrder.items?.length > 0 && (
                      <div className="pending-order-items">
                        {pendingOrder.items.map((item, index) => (
                          <div className="pending-order-item" key={item.id || `${pendingOrder.id}-${index}`}>
                            <strong>第 {index + 1} 块</strong>
                            <div className="order-item-grid">
                              <span>干重 {formatNumber(item.dryWeight, 4)}</span>
                              <span>水重 {formatNumber(item.waterWeight, 4)}</span>
                              <span>纯度 {formatNumber(item.effectivePurity ?? item.purity, 2)}%</span>
                              <span>国际金价 $ {formatNumber(item.intlGoldPrice, 2)}</span>
                              <span>每克 $ {formatNumber(item.effectivePerGramPrice ?? item.finalPrice, 2)}</span>
                              <span>小计 $ {formatNumber(item.totalPrice, 0)}</span>
                            </div>
                            {item.allocations?.length > 0 && (
                              <div className="allocation-list">
                                {item.allocations.map((allocation, allocationIndex) => (
                                  <div className="allocation-item" key={`${pendingOrder.id}-${index}-${allocationIndex}`}>
                                    <strong>{allocation.label}</strong>
                                    <div className="order-item-grid">
                                      <span>克数 {formatNumber(allocation.allocatedWeight, 2)}g</span>
                                      <span>国际金价 $ {formatNumber(allocation.intlGoldPriceUsed, 2)}</span>
                                      <span>税点 {formatNumber(allocation.taxRateUsed ?? item.taxRate, 2)}%</span>
                                      <span>每克 $ {formatNumber(allocation.finalPrice, 2)}</span>
                                      <span>金额 $ {formatNumber(allocation.lineTotal, 0)}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
          </>
        )}
      </div>

      {(canMeltGold || canSellGold || canManageFinancialDefaults || canViewProfit) && (
      <section className="surface admin-surface">
        <div className="section-heading">
          <h2>库存与卖出</h2>
          <span className="pill">独立于收金录入页的后台模块</span>
        </div>
        <p className="hero-copy admin-copy">
          这里先打通第一阶段：历史订单项同步为库存批次，支持整块熔合，并支持按“公司”的美元结算规则卖出。许总和巴西佬先保留入口，下一阶段再接公式。
        </p>
        <p className="save-status">{inventoryStatus}</p>

        <div className="admin-grid">
          {canManageFinancialDefaults && (
            <article className="admin-card admin-card-full">
              <div className="order-items-heading">
                <h3>财务默认值</h3>
                <span>仅管理员可见</span>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>USD/USDT 默认汇率</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="例如 1.02"
                    value={financialDefaultsDraft}
                    onChange={(event) => setFinancialDefaultsDraft(sanitizeDecimalInput(event.target.value))}
                  />
                  <small>员工保存许总/巴西佬卖出时，会自动使用这里的默认汇率。</small>
                </label>
              </div>
              <div className="actions">
                <button className="button button-primary" type="button" onClick={saveFinancialDefaults}>
                  保存默认汇率
                </button>
              </div>
            </article>
          )}
          {(canMeltGold || canSellGold) && (
          <article className="admin-card">
            <div className="order-items-heading">
              <h3>可用库存批次</h3>
              <span>{availableInventoryBatches.length} 块</span>
            </div>
            {availableInventoryBatches.length === 0 ? (
              <p className="order-items-empty">还没有可用库存。系统会从已录入的订单明细自动同步原始库存来源。</p>
            ) : (
              <div className="inventory-list">
                {displayedInventoryBatches.map((batch) => (
                  <article
                    key={batch.id}
                    className={`inventory-item${selectedInventoryBatchIds.includes(batch.id) ? ' inventory-item-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleInventoryBatch(batch.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleInventoryBatch(batch.id);
                      }
                    }}
                  >
                    <div className="reservation-item-top">
                      <strong>{batch.label}</strong>
                      <button
                        type="button"
                        className="text-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleInventoryBatch(batch.id);
                        }}
                      >
                        {selectedInventoryBatchIds.includes(batch.id) ? '已选择' : '选择'}
                      </button>
                    </div>
                    <div className="reservation-grid">
                      <span>状态 {selectedInventoryBatchIds.includes(batch.id) ? '已选择' : '未选择'}</span>
                      <span>来源 {batch.sourceType === 'melt' ? '熔合批次' : '收金订单'}</span>
                      {canViewCost && <span>成本 $ {formatNumber(batch.totalCostUsd, 2)}</span>}
                      <span>干重 {formatNumber(batch.dryWeight, 4)}g</span>
                      <span>水重 {formatNumber(batch.waterWeight, 4)}g</span>
                      <span>纯度 {formatNumber(batch.purity, 2)}%</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div className="actions">
              <button className="button button-secondary" type="button" onClick={clearInventorySelection} disabled={!selectedInventoryBatchIds.length}>
                清空选择
              </button>
            </div>
          </article>
          )}

          {canMeltGold && (
          <article className="admin-card">
            <div className="order-items-heading">
              <h3>熔合管理</h3>
              <span>{selectedInventoryBatchIds.length} 已选</span>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>熔后干重</span>
                <input
                  name="outputDryWeight"
                  type="text"
                  inputMode="decimal"
                  placeholder="例如 1024.63"
                  value={meltValues.outputDryWeight}
                  onChange={updateMeltField}
                />
              </label>
              <label className="field">
                <span>熔后水重</span>
                <input
                  name="outputWaterWeight"
                  type="text"
                  inputMode="decimal"
                  placeholder="例如 980.17"
                  value={meltValues.outputWaterWeight}
                  onChange={updateMeltField}
                />
              </label>
            </div>
            <div className="formula-card admin-formula">
              <div>熔前总干重：{formatNumber(meltPreview.inputTotalDryWeight, 2)}g</div>
              {canViewCost && <div>熔前总成本：$ {formatNumber(meltPreview.inputTotalCostUsd, 2)}</div>}
              <div>熔后纯度：{Number.isFinite(meltPreview.purity) ? `${formatNumber(meltPreview.purity, 2)}%` : '--'}</div>
              <div>重量差：{Number.isFinite(meltPreview.weightDifference) ? `${formatNumber(meltPreview.weightDifference, 2)}g` : '--'}</div>
            </div>
            <div className="actions">
              <button className="button button-primary" type="button" onClick={createMeltBatch} disabled={!selectedInventoryBatchIds.length}>
                生成熔合批次
              </button>
            </div>
          </article>
          )}

          {canSellGold && (
          <article className="admin-card admin-card-full">
            <div className="order-items-heading">
              <h3>
                {companySaleValues.buyerType === 'xuzong'
                  ? '卖给许总'
                  : companySaleValues.buyerType === 'brazil'
                    ? '卖给巴西佬'
                    : '卖给公司'}
              </h3>
              <span>
                {companySaleValues.buyerType === 'xuzong'
                  ? xuSales.length
                  : companySaleValues.buyerType === 'brazil'
                    ? brazilSales.length
                    : companySales.length}{' '}
                笔
              </span>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>买家</span>
                <select name="buyerType" value={companySaleValues.buyerType} onChange={updateBuyerType}>
                  <option value="company">公司</option>
                  <option value="xuzong">许总</option>
                  <option value="brazil">巴西佬</option>
                </select>
              </label>
            </div>
                {selectedInventoryBatches.length === 0 ? (
                  <p className="order-items-empty">
                    {companySaleValues.buyerType === 'xuzong'
                      ? '先从左侧选中要卖给许总的库存批次，再录入本次卖出时的国际金价。'
                      : companySaleValues.buyerType === 'brazil'
                        ? '先从左侧选中要卖给巴西佬的库存批次，再录入每块原始每克报价和本次结算公斤数。'
                        : '先从左侧选中要卖给公司的库存批次，再录入对方给出的干重、纯度和每克价格。'}
                  </p>
                ) : (
                  <div className="company-sale-lines">
                    {companySaleValues.buyerType === 'company'
                      ? selectedInventoryBatches.map((batch) => {
                          const input = companySaleValues.companyInputs[batch.id] || {};
                          const linePreview = companySaleLinePreviewByBatchId.get(batch.id);
                          return (
                            <article className="inventory-item" key={`company-${batch.id}`}>
                              <div className="reservation-item-top">
                                <strong>{batch.label}</strong>
                                <div className="inline-actions">
                                  {canViewCost && <span className="pill">成本 $ {formatNumber(batch.totalCostUsd, 2)}</span>}
                                  <span className="pill soft">
                                    卖价 {linePreview ? `$ ${formatNumber(linePreview.lineAmountRounded, 2)}` : '--'}
                                  </span>
                                  {canViewProfit && (
                                    <span className="pill soft">
                                      单块利润 {linePreview ? `$ ${formatNumber(linePreview.lineProfitUsd, 2)}` : '--'}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="form-grid company-line-grid">
                                <label className="field">
                                  <span>卖出时国际金价（美元/盎司）</span>
                                  <small>
                                    {batch.referenceIntlGoldPriceLabel?.includes('加权平均')
                                      ? `我方收入国际金价* $ ${formatNumber(batch.referenceIntlGoldPrice, 2)}`
                                      : `我方收入国际金价 $ ${formatNumber(batch.referenceIntlGoldPrice, 2)}`}
                                  </small>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder={`我方 ${formatNumber(batch.referenceIntlGoldPrice, 2)}`}
                                    value={input.saleIntlGoldPrice || ''}
                                    onChange={(event) => updateCompanySaleField(batch.id, 'saleIntlGoldPrice', sanitizeDecimalInput(event.target.value))}
                                  />
                                </label>
                                <label className="field">
                                  <span>公司干重</span>
                                  <small>我方干重 {formatNumber(batch.dryWeight, 2)}g</small>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder={`我方 ${formatNumber(batch.dryWeight, 2)}`}
                                    value={input.buyerDryWeight || ''}
                                    onChange={(event) => updateCompanySaleField(batch.id, 'buyerDryWeight', sanitizeDecimalInput(event.target.value))}
                                  />
                                </label>
                                <label className="field">
                                  <span>公司纯度（%）</span>
                                  <small>我方纯度 {formatNumber(batch.purity, 2)}%</small>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder={`我方 ${formatNumber(batch.purity, 2)}%`}
                                    value={input.buyerPurity || ''}
                                    onChange={(event) => updateCompanySaleField(batch.id, 'buyerPurity', sanitizeDecimalInput(event.target.value))}
                                  />
                                </label>
                                <label className="field">
                                  <span>公司每克价（USD）</span>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="例如 136.74"
                                    value={input.buyerPricePerGramUsd || ''}
                                    onChange={(event) => updateCompanySaleField(batch.id, 'buyerPricePerGramUsd', sanitizeDecimalInput(event.target.value))}
                                  />
                                </label>
                              </div>
                            </article>
                          );
                        })
                      : companySaleValues.buyerType === 'xuzong'
                        ? selectedInventoryBatches.map((batch) => {
                          const input = companySaleValues.xuInputs[batch.id] || { purityAdjustmentPercent: '0.1' };
                          const linePreview = xuSaleLinePreviewByBatchId.get(batch.id);
                          return (
                            <article className="inventory-item" key={`xuzong-${batch.id}`}>
                              <div className="reservation-item-top">
                                <strong>{batch.label}</strong>
                                <div className="inline-actions">
                                  {canViewCost && <span className="pill">成本 $ {formatNumber(batch.totalCostUsd, 2)}</span>}
                                  <span className="pill soft">
                                    卖价 {linePreview ? `${formatNumber(linePreview.lineAmountRoundedUsdt, 0)} USDT` : '--'}
                                  </span>
                                  {canViewProfit && <span className="pill soft">利润 待汇率换算</span>}
                                </div>
                              </div>
                              <div className="form-grid company-line-grid">
                                <label className="field">
                                  <span>卖出时国际金价（美元/盎司）</span>
                                  <small>
                                    {batch.referenceIntlGoldPriceLabel?.includes('加权平均')
                                      ? `我方收入国际金价* $ ${formatNumber(batch.referenceIntlGoldPrice, 2)}`
                                      : `我方收入国际金价 $ ${formatNumber(batch.referenceIntlGoldPrice, 2)}`}
                                  </small>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder={`我方 ${formatNumber(batch.referenceIntlGoldPrice, 2)}`}
                                    value={input.saleIntlGoldPrice || ''}
                                    onChange={(event) => updateXuSaleField(batch.id, 'saleIntlGoldPrice', sanitizeDecimalInput(event.target.value))}
                                  />
                                </label>
                                <div className="field">
                                  <span>我方干重</span>
                                  <small>{formatNumber(batch.dryWeight, 2)}g</small>
                                </div>
                                <div className="field">
                                  <span>我方纯度</span>
                                  <small>{formatNumber(batch.purity, 2)}%</small>
                                </div>
                                <label className="field">
                                  <span>纯度加成（%）</span>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="例如 0.1"
                                    value={input.purityAdjustmentPercent || '0.1'}
                                    onChange={(event) => updateXuSaleField(batch.id, 'purityAdjustmentPercent', sanitizeDecimalInput(event.target.value))}
                                  />
                                </label>
                                {canViewFormula && (
                                  <>
                                    <div className="field">
                                      <span>调整后纯度</span>
                                      <small>{linePreview ? `${formatNumber(linePreview.adjustedPurity, 2)}%` : '--'}</small>
                                    </div>
                                    <div className="field">
                                      <span>每克净价（USDT）</span>
                                      <small>{linePreview ? formatNumber(linePreview.netPricePerGramUsdt, 4) : '--'}</small>
                                    </div>
                                  </>
                                )}
                              </div>
                            </article>
                          );
                        })
                        : selectedInventoryBatches.map((batch) => {
                          const input = companySaleValues.brazilInputs[batch.id] || { purityAdjustmentPercent: '0.1' };
                          const linePreview = brazilSaleLinePreviewByBatchId.get(batch.id);
                          return (
                            <article className="inventory-item" key={`brazil-${batch.id}`}>
                              <div className="reservation-item-top">
                                <strong>{batch.label}</strong>
                                <div className="inline-actions">
                                  {canViewCost && <span className="pill">成本 $ {formatNumber(batch.totalCostUsd, 2)}</span>}
                                  <span className="pill soft">
                                    收入 {linePreview ? `${formatNumber(linePreview.lineRevenueUsdt, 2)} USDT` : '--'}
                                  </span>
                                </div>
                              </div>
                              <div className="form-grid company-line-grid">
                                <label className="field">
                                  <span>原始每克报价（USDT）</span>
                                  <small>
                                    {batch.referenceIntlGoldPriceLabel?.includes('加权平均')
                                      ? `我方收入国际金价* $ ${formatNumber(batch.referenceIntlGoldPrice, 2)}`
                                      : `我方收入国际金价 $ ${formatNumber(batch.referenceIntlGoldPrice, 2)}`}
                                  </small>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="例如 153.37"
                                    value={input.rawPricePerGramUsdt || ''}
                                    onChange={(event) =>
                                      updateBrazilSaleField(batch.id, 'rawPricePerGramUsdt', sanitizeDecimalInput(event.target.value))
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span>本块结算公斤数</span>
                                  <small>我方干重 {formatNumber(batch.dryWeight, 2)}g</small>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="例如 1"
                                    value={input.settledKgCount || ''}
                                    onChange={(event) =>
                                      updateBrazilSaleField(batch.id, 'settledKgCount', sanitizeDecimalInput(event.target.value))
                                    }
                                  />
                                </label>
                                <div className="field">
                                  <span>我方纯度</span>
                                  <small>{formatNumber(batch.purity, 2)}%</small>
                                </div>
                                <label className="field">
                                  <span>纯度加成（%）</span>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    placeholder="例如 0.1"
                                    value={input.purityAdjustmentPercent || '0.1'}
                                    onChange={(event) =>
                                      updateBrazilSaleField(batch.id, 'purityAdjustmentPercent', sanitizeDecimalInput(event.target.value))
                                    }
                                  />
                                </label>
                                {canViewFormula && (
                                  <>
                                    <div className="field">
                                      <span>反推国际金价（美元/盎司）</span>
                                      <small>{linePreview ? `$ ${formatNumber(linePreview.saleIntlGoldPrice, 2)}` : '--'}</small>
                                    </div>
                                    <div className="field">
                                      <span>调整后纯度</span>
                                      <small>{linePreview ? `${formatNumber(linePreview.adjustedPurity, 2)}%` : '--'}</small>
                                    </div>
                                    <div className="field">
                                      <span>税后每克净价（USDT）</span>
                                      <small>{linePreview ? formatNumber(linePreview.netPricePerGramUsdt, 2) : '--'}</small>
                                    </div>
                                    <div className="field">
                                      <span>本块纯金</span>
                                      <small>{linePreview ? `${formatNumber(linePreview.fineGoldDelivered, 2)}g` : '--'}</small>
                                    </div>
                                  </>
                                )}
                              </div>
                            </article>
                          );
                        })}
                  </div>
                )}
                {canViewFormula && companySaleValues.buyerType === 'brazil' && selectedInventoryBatches.length > 0 && (
                  <div className="formula-card admin-formula">
                    <div>严格口径：本次实际交付纯金 = 各块（干重 × 调整后纯度）逐块截断到 2 位后相加。</div>
                    <div>严格口径：本次应结纯金 = 各块结算公斤数 × 1000g 后相加。</div>
                    <div>
                      严格口径：平均每克纯金成本 =（上次成本余额 + 本次交付成本）÷（上次纯金余额 + 本次交付纯金）。
                    </div>
                    <div>
                      严格口径：本次已结算成本 = 平均每克纯金成本 × 本次应结纯金；利润 = 折美元收入 - 本次已结算成本。
                    </div>
                    <div>上次纯金余额：{formatNumber(brazilSalePreview.fineGoldBalanceBefore, 2)}g</div>
                    <div>上次成本余额：$ {formatNumber(brazilSalePreview.costBalanceBeforeUsd, 2)}</div>
                    <div>本次实际交付纯金：{formatNumber(brazilSalePreview.fineGoldDelivered, 2)}g</div>
                    <div>本次应结纯金：{formatNumber(brazilSalePreview.fineGoldSettled, 2)}g</div>
                    <div>本次可用纯金：{formatNumber(brazilSalePreview.fineGoldAvailable, 2)}g</div>
                    <div>
                      本次实际交付成本（{formatNumber(brazilSalePreview.fineGoldDelivered, 2)}g）：$
                      {' '}
                      {formatNumber(brazilSalePreview.inventoryCostUsd, 2)}
                    </div>
                    <div>本次可用成本：$ {formatNumber(brazilSalePreview.costAvailableUsd, 2)}</div>
                    <div>平均每克纯金成本：$ {formatNumber(brazilSalePreview.averageCostPerFineGramUsd, 4)} / g</div>
                    <div>
                      本次已结算成本（{formatNumber(brazilSalePreview.fineGoldSettled, 2)}g）：$
                      {' '}
                      {formatNumber(brazilSalePreview.settledCostUsd, 2)}
                    </div>
                    <div>结算后克数余额：{formatBrazilBalanceText(brazilSalePreview.fineGoldBalanceAfter)}</div>
                    <div>结算后成本余额：$ {formatNumber(brazilSalePreview.costBalanceAfterUsd, 2)}</div>
                  </div>
                )}
                {hasWeightedAverageReference && (
                  canViewFormula && <p className="order-items-empty">
                    * 加权口径：熔前每块干重 × 该块收入国际金价，先分别相加，再除以熔前总干重。
                  </p>
                )}
                {(companySaleValues.buyerType === 'xuzong' || companySaleValues.buyerType === 'brazil') && (
                  <div className="form-grid">
                    <label className="field">
                      <span>税点（%）</span>
                      <input
                        name="taxRatePercent"
                        type="text"
                        inputMode="decimal"
                        placeholder="例如 7.5"
                        value={companySaleValues.taxRatePercent}
                        onChange={(event) =>
                          setCompanySaleValues((current) => ({
                            ...current,
                            taxRatePercent: sanitizeDecimalInput(event.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>
                )}
                <div className="results admin-results">
                  <article className="result-card">
                    <div className="result-label">
                      {companySaleValues.buyerType === 'xuzong'
                        ? '许总卖出总额'
                        : companySaleValues.buyerType === 'brazil'
                          ? '巴西佬卖出总额'
                          : '公司卖出总额'}
                    </div>
                    <div className="result-value">
                      {companySaleValues.buyerType === 'xuzong'
                        ? Number.isFinite(xuSalePreview.grossRevenueUsdt)
                          ? `${formatNumber(xuSalePreview.grossRevenueUsdt, 0)} USDT`
                          : '--'
                        : companySaleValues.buyerType === 'brazil'
                          ? Number.isFinite(brazilSalePreview.grossRevenueUsdt)
                            ? `${formatNumber(brazilSalePreview.grossRevenueUsdt, 2)} USDT`
                            : '--'
                        : Number.isFinite(companySalePreview.grossRevenueUsd)
                          ? `$ ${formatNumber(companySalePreview.grossRevenueUsd, 0)}`
                          : '--'}
                    </div>
                    <div className="result-sub">
                      {canViewFormula
                        ? (
                            companySaleValues.buyerType === 'xuzong'
                              ? (xuSalePreview.error || '每块按公式计算后四舍五入到整数 USDT')
                              : companySaleValues.buyerType === 'brazil'
                                ? (brazilSalePreview.error || '按整公斤结算，本次收入按税后每克净价 × 1000 × 结算公斤数')
                                : (companySalePreview.error || '逐块先四舍五入到 2 位小数，再把总额四舍五入到整数')
                          )
                        : ''}
                    </div>
                  </article>
                  {(canViewProfit || canManageFinancialDefaults) && (
                  <article className="result-card">
                    <div className="result-label">
                      {companySaleValues.buyerType === 'xuzong' || companySaleValues.buyerType === 'brazil'
                        ? '折美元收入'
                        : '库存成本'}
                    </div>
                    <div className="result-value">
                      {companySaleValues.buyerType === 'xuzong'
                        ? Number.isFinite(xuGrossRevenueUsdConverted)
                          ? `$ ${formatNumber(xuGrossRevenueUsdConverted, 2)}`
                          : '--'
                        : companySaleValues.buyerType === 'brazil'
                          ? Number.isFinite(brazilSalePreview.grossRevenueUsdConverted)
                            ? `$ ${formatNumber(brazilSalePreview.grossRevenueUsdConverted, 2)}`
                            : '--'
                        : Number.isFinite(companySalePreview.inventoryCostUsd)
                          ? `$ ${formatNumber(companySalePreview.inventoryCostUsd, 2)}`
                          : '--'}
                    </div>
                    <div className="result-sub">
                      {canViewFormula && (companySaleValues.buyerType === 'xuzong' || companySaleValues.buyerType === 'brazil')
                        ? `使用汇率 ${
                            Number.isFinite(companySaleValues.buyerType === 'brazil' ? brazilUsdToUsdtRate : xuUsdToUsdtRate)
                              ? `1 USD = ${formatNumber(
                                  companySaleValues.buyerType === 'brazil' ? brazilUsdToUsdtRate : xuUsdToUsdtRate,
                                  4
                                )} U`
                              : '--'
                          }`
                        : canViewFormula
                          ? '当前版本先按整块批次卖出和整块批次成本结转'
                          : ''}
                    </div>
                  </article>
                  )}
                  {canViewCost && (
                  <article className="result-card">
                    <div className="result-label">
                      {companySaleValues.buyerType === 'brazil' ? '本次已结算成本' : '库存成本'}
                    </div>
                    <div className="result-value">
                      {companySaleValues.buyerType === 'xuzong'
                        ? Number.isFinite(xuSalePreview.inventoryCostUsd)
                          ? `$ ${formatNumber(xuSalePreview.inventoryCostUsd, 2)}`
                          : '--'
                        : companySaleValues.buyerType === 'brazil'
                          ? Number.isFinite(brazilSalePreview.settledCostUsd)
                            ? `$ ${formatNumber(brazilSalePreview.settledCostUsd, 2)}（换算成 ${formatNumber(brazilSalePreview.fineGoldSettled, 2)}g 成本）`
                            : '--'
                        : Number.isFinite(companySalePreview.inventoryCostUsd)
                          ? `$ ${formatNumber(companySalePreview.inventoryCostUsd, 2)}`
                          : '--'}
                    </div>
                    <div className="result-sub">
                      {canViewFormula && companySaleValues.buyerType === 'brazil'
                        ? `本次实际交付成本（${Number.isFinite(brazilSalePreview.fineGoldDelivered) ? formatNumber(brazilSalePreview.fineGoldDelivered, 2) : '--'}g）$ ${Number.isFinite(brazilSalePreview.inventoryCostUsd) ? formatNumber(brazilSalePreview.inventoryCostUsd, 2) : '--'}`
                        : canViewFormula
                          ? '当前版本先按整块批次卖出和整块批次成本结转'
                          : ''}
                    </div>
                  </article>
                  )}
                  {canViewProfit && (
                  <article className="result-card accent-green">
                    <div className="result-label">
                      {companySaleValues.buyerType === 'xuzong' || companySaleValues.buyerType === 'brazil' ? '利润' : '毛利润'}
                    </div>
                    <div className="result-value">
                      {companySaleValues.buyerType === 'xuzong'
                        ? Number.isFinite(xuGrossProfitUsdConverted)
                          ? `$ ${formatNumber(xuGrossProfitUsdConverted, 2)}`
                          : '待汇率换算'
                        : companySaleValues.buyerType === 'brazil'
                          ? Number.isFinite(brazilSalePreview.grossProfitUsdConverted)
                            ? `$ ${formatNumber(brazilSalePreview.grossProfitUsdConverted, 2)}`
                            : '待汇率换算'
                        : Number.isFinite(companySalePreview.grossProfitUsd)
                          ? `$ ${formatNumber(companySalePreview.grossProfitUsd, 2)}`
                          : '--'}
                    </div>
                    <div className="result-sub">
                      {companySaleValues.buyerType === 'xuzong'
                        ? '按统一汇率折算成美元利润'
                        : companySaleValues.buyerType === 'brazil'
                          ? formatBrazilBalanceText(brazilSalePreview.fineGoldBalanceAfter)
                          : '后续再扩展手续费和纯利润字段'}
                    </div>
                  </article>
                  )}
                </div>
                <div className="actions">
                  <button className="button button-primary" type="button" onClick={createCompanySale} disabled={!selectedInventoryBatchIds.length}>
                    {companySaleValues.buyerType === 'xuzong'
                      ? '保存许总卖出'
                      : companySaleValues.buyerType === 'brazil'
                        ? '保存巴西佬卖出'
                        : '保存公司卖出'}
                  </button>
                </div>
                <p className="save-status">
                  {companySaleValues.buyerType === 'xuzong'
                    ? (xuSalePreview.error
                        ? xuSalePreview.error
                        : inventoryStatus.includes('许总卖出')
                          ? inventoryStatus
                          : '填完每块国际金价、纯度加成后，系统会自动使用管理员设置的默认汇率，再点击这里保存到 Airtable。')
                    : companySaleValues.buyerType === 'brazil'
                      ? (brazilSalePreview.error
                          ? brazilSalePreview.error
                          : inventoryStatus.includes('巴西佬卖出')
                            ? inventoryStatus
                            : '填完每块原始每克报价、本块结算公斤数、纯度加成，以及本次统一税点后，系统会自动使用管理员设置的默认汇率，再点击这里保存到 Airtable。')
                    : (companySalePreview.error
                        ? companySalePreview.error
                        : inventoryStatus.includes('公司卖出')
                          ? inventoryStatus
                          : '填完每块的公司干重、纯度和每克价后，点击这里保存到 Airtable。')}
                </p>
          </article>
          )}

          {canMeltGold && (
          <article className="admin-card">
            <div className="order-items-heading">
              <h3>最近熔合</h3>
              <span>{meltRecords.length} 次</span>
            </div>
            {meltRecords.length === 0 ? (
              <p className="order-items-empty">还没有熔合记录。</p>
            ) : (
              <div className="pending-orders-list">
                {meltRecords.slice(0, 6).map((record) => (
                  <article className="pending-order" key={record.id}>
                    <div className="order-item-top">
                      <strong>{record.id}</strong>
                    </div>
                    <div className="order-item-grid">
                      <span>熔前 {formatNumber(record.inputTotalDryWeight, 4)}g</span>
                      <span>熔后 {formatNumber(record.outputDryWeight, 2)}g</span>
                      <span>纯度 {formatNumber(record.purity, 2)}%</span>
                      <span>重量差 {formatNumber(record.weightDifference, 2)}g</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </article>
          )}

          {canViewProfit && (
          <article className="admin-card">
            <div className="order-items-heading">
              <h3>最近公司卖出</h3>
              <span>{companySales.length} 笔</span>
            </div>
            {companySales.length === 0 ? (
              <p className="order-items-empty">还没有公司卖出记录。</p>
            ) : (
              <div className="pending-orders-list">
                {companySales.slice(0, 6).map((sale) => (
                  <article className="pending-order" key={sale.id}>
                    <div className="order-item-top">
                      <strong>{formatDateTimeInSuriname(sale.createdAt)}</strong>
                      <span className="pill">USD</span>
                    </div>
                    <div className="order-item-grid">
                      <span>批次数 {sale.inventoryBatchIds.length}</span>
                      <span>收入 $ {formatNumber(sale.grossRevenueUsd, 0)}</span>
                      <span>成本 $ {formatNumber(sale.inventoryCostUsd, 2)}</span>
                      <span>利润 $ {formatNumber(sale.grossProfitUsd, 2)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </article>
          )}

          {canViewProfit && (
          <article className="admin-card">
            <div className="order-items-heading">
              <h3>最近许总卖出</h3>
              <span>{xuSales.length} 笔</span>
            </div>
            {xuSales.length === 0 ? (
              <p className="order-items-empty">还没有许总卖出记录。</p>
            ) : (
              <div className="pending-orders-list">
                {xuSales.slice(0, 6).map((sale) => (
                  <article className="pending-order" key={sale.id}>
                    <div className="order-item-top">
                      <strong>{formatDateTimeInSuriname(sale.createdAt)}</strong>
                      <span className="pill">USDT</span>
                    </div>
                    <div className="order-item-grid">
                      <span>批次数 {sale.inventoryBatchIds.length}</span>
                      <span>收入 {formatNumber(sale.grossRevenueUsdt, 0)} USDT</span>
                      <span>折美元 $ {formatNumber(sale.grossRevenueUsdConverted, 2)}</span>
                      <span>成本 $ {formatNumber(sale.inventoryCostUsd, 2)}</span>
                      <span>利润 $ {formatNumber(sale.grossProfitUsdConverted, 2)}</span>
                      <span>{sale.profitStatus || '待汇率换算'}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </article>
          )}

          {canViewProfit && (
          <article className="admin-card">
            <div className="order-items-heading">
              <h3>最近巴西佬卖出</h3>
              <span>{brazilSales.length} 笔</span>
            </div>
            {brazilSales.length === 0 ? (
              <p className="order-items-empty">还没有巴西佬卖出记录。</p>
            ) : (
              <div className="pending-orders-list">
                {brazilSales.slice(0, 6).map((sale) => (
                  <article className="pending-order" key={sale.id}>
                    <div className="order-item-top">
                      <strong>{formatDateTimeInSuriname(sale.createdAt)}</strong>
                      <span className="pill">USDT</span>
                    </div>
                    <div className="order-item-grid">
                      <span>批次数 {sale.inventoryBatchIds.length}</span>
                      <span>收入 {formatNumber(sale.grossRevenueUsdt, 2)} USDT</span>
                      <span>折美元 $ {formatNumber(sale.grossRevenueUsdConverted, 2)}</span>
                      <span>本次实际交付成本（{formatNumber(sale.fineGoldDelivered, 2)}g）$ {formatNumber(sale.inventoryCostUsd, 2)}</span>
                      <span>已结算成本（{formatNumber(sale.fineGoldSettled, 2)}g）$ {formatNumber(sale.settledCostUsd, 2)}</span>
                      <span>利润 $ {formatNumber(sale.grossProfitUsdConverted, 2)}</span>
                      <span>{formatBrazilBalanceText(sale.fineGoldBalanceAfter)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </article>
          )}
        </div>
      </section>
      )}
    </div>
  );
}

export default App;
