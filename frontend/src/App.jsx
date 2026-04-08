import { useEffect, useState } from 'react';
import {
  FORMULA_RULES,
  buildRecordPayloadWithReservation,
  calculateResultsWithReservation,
  formatNumber,
} from './lib/calculator.js';

const CUSTOMER_STORAGE_KEY = 'gold-price-calculator-customers';
const PENDING_ORDERS_STORAGE_KEY = 'gold-price-calculator-pending-orders';

const initialValues = {
  customerName: '',
  customerPhone: '',
  waterWeight: '',
  dryWeight: '',
  taxRate: '',
  intlGoldPrice: '',
  formulaRule: '2088.136',
};

const emptyResults = {
  purityText: '--',
  puritySub: '等待输入数据',
  perGramText: '--',
  finalPriceText: '--',
  finalPriceSub: '等待输入数据',
  totalPriceText: '--',
  totalPriceSub: '等待输入数据',
  isSplitPricing: false,
};

const initialReservationValues = {
  reservedWeight: '',
  lockedIntlGoldPrice: '',
  reservedAt: '',
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

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

function clearCurrentItemValues(currentValues) {
  return {
    ...currentValues,
    waterWeight: '',
    dryWeight: '',
    taxRate: '',
    intlGoldPrice: '',
    formulaRule: '2088.136',
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
  const response = await fetch(apiUrl(path), options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(formatApiError(data.detail, response.status));
  }
  return data;
}

function App() {
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
  const normalizedCustomerName = values.customerName.trim();
  const normalizedCustomerPhone = values.customerPhone.trim();
  const currentCustomerReservations = reservations.filter(
    (reservation) =>
      reservation.status === 'open' &&
      reservation.customerName === normalizedCustomerName &&
      reservation.customerPhone === normalizedCustomerPhone
  );
  const selectedReservations = selectedReservationIds
    .map((reservationId) => currentCustomerReservations.find((reservation) => reservation.id === reservationId))
    .filter(Boolean);
  const totalSelectedReservedWeight = selectedReservations.reduce(
    (sum, reservation) => sum + Number(reservation.remainingReservedWeight || 0),
    0
  );

  async function refreshReservations(customerName = normalizedCustomerName, customerPhone = normalizedCustomerPhone) {
    if (!customerName || !customerPhone) {
      setReservations([]);
      return;
    }

    try {
      const data = await requestJson(
        `/api/reservations?customer_name=${encodeURIComponent(customerName)}&customer_phone=${encodeURIComponent(customerPhone)}`
      );
      setReservations(data);
    } catch (error) {
      setSaveStatus(`加载预定失败：${error.message}`);
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
    const payload = calculateResultsWithReservation(values, selectedReservations);
    const rule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];

    if (payload.error) {
      setResults({
        purityText: '--',
        puritySub: payload.error,
        perGramText: '--',
        finalPriceText: '--',
        finalPriceSub: payload.error,
        totalPriceText: '--',
        totalPriceSub: payload.error,
        isSplitPricing: false,
      });
      return;
    }

    const isReservedPricing = payload.reservedWeightApplied > 0;
    const isSplitPricing = isReservedPricing && payload.spotWeightApplied > 0;

    setResults({
      purityText: `${formatNumber(payload.purity, 2)}%`,
      puritySub: `计算过程：(${formatNumber(payload.waterWeight, 4)} ÷ ${formatNumber(payload.dryWeight, 4)}) × 2307.454 - ${formatNumber(rule.constant, 3)}，结果为 ${formatNumber(payload.purity, 2)}%`,
      perGramText: payload.missingFields ? '--' : `$ ${formatNumber(payload.perGramPrice, 2)}`,
      finalPriceText: payload.missingFields ? '--' : `$ ${formatNumber(payload.finalPrice, 2)}`,
      finalPriceSub: payload.missingFields
        ? payload.missingMessage || '输入税点和国际金价后继续计算每克金价'
        : selectedReservations.length > 0 && payload.reservedWeightApplied > 0
          ? payload.spotWeightApplied > 0
            ? `已拆分预定价 ${formatNumber(payload.reservedWeightApplied, 4)}g 和实时价 ${formatNumber(payload.spotWeightApplied, 4)}g`
            : `本块 ${formatNumber(payload.reservedWeightApplied, 4)}g 全部按预定国际金价计算`
          : `计算过程：(${formatNumber(payload.intlGoldPrice, 2)} ÷ 31.1035) × (1 - ${formatNumber(payload.taxRate, 4)}%) × ${formatNumber(payload.purity, 2)}%，结果为 ${formatNumber(payload.finalPrice, 2)}`,
      totalPriceText: payload.missingFields || isReservedPricing ? '--' : `$ ${formatNumber(payload.totalPrice, 0)}`,
      totalPriceSub: payload.missingFields
        ? payload.missingMessage || '输入税点和国际金价后继续计算总金价'
        : selectedReservations.length > 0 && payload.reservedWeightApplied > 0
          ? payload.spotWeightApplied > 0
            ? `当前块会按预定价 ${formatNumber(payload.reservedWeightApplied, 4)}g + 实时价 ${formatNumber(payload.spotWeightApplied, 4)}g 拆分结算，不在这里预估总价`
            : `当前块全部使用预定国际金价结算，不在这里预估总价`
          : `计算过程：${formatNumber(payload.dryWeight, 4)} × ${formatNumber(payload.finalPrice, 2)}，结果为 ${formatNumber(payload.totalPrice, 0)}`,
      isSplitPricing: isReservedPricing,
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
    const decimalFields = new Set(['waterWeight', 'dryWeight', 'taxRate', 'intlGoldPrice']);
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
    const decimalFields = new Set(['reservedWeight', 'lockedIntlGoldPrice']);
    setReservationValues((current) => ({
      ...current,
      [name]: decimalFields.has(name) ? sanitizeDecimalInput(value) : value,
    }));
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

    if (!Number.isFinite(reservedWeight) || reservedWeight <= 0) {
      setSaveStatus('请先输入有效的预定克数');
      return;
    }

    if (!Number.isFinite(lockedIntlGoldPrice) || lockedIntlGoldPrice <= 0) {
      setSaveStatus('请先输入有效的预定国际金价');
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
          reservedAt,
        }),
      });

      writeReservations([reservation, ...reservations.filter((item) => item.id !== reservation.id)]);
      setSelectedReservationIds((current) => (current.includes(reservation.id) ? current : [...current, reservation.id]));
      setReservationValues(initialReservationValues);
      setShowReservationForm(false);
      setSaveStatus(`已为 ${normalizedCustomerName} 新建预定：${formatNumber(reservedWeight, 4)}g，锁价 $ ${formatNumber(lockedIntlGoldPrice, 2)}`);
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
    setSaveStatus('已清空客户信息，可以重新录入顾客姓名和手机号');
  }

  function ensureCustomerFilled() {
    if (!values.customerName.trim() || !values.customerPhone.trim()) {
      setSaveStatus('请先输入顾客姓名和手机号，再开始订单');
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
      await refreshReservations(values.customerName.trim(), values.customerPhone.trim());
      if (pendingOrders.some((pendingOrder) => pendingOrder.id === order.id)) {
        upsertPendingOrder(order);
      }
      persistCustomerProfile(values.customerName, values.customerPhone);
      setValues((current) => clearCurrentItemValues(current));
      setSaveStatus(
        payload.usedReservationIds?.length
          ? payload.spotWeightApplied > 0
            ? `已加入当前订单，本块使用了 ${payload.usedReservationIds.length} 条预定，共 ${formatNumber(payload.reservedWeightApplied, 4)}g，剩余 ${formatNumber(payload.spotWeightApplied, 4)}g 按实时价结算`
            : `已加入当前订单，本块全部使用 ${payload.usedReservationIds.length} 条预定结算`
          : `已加入当前订单，第 ${order.summary.itemCount} 块金子已计入本单`
      );
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
      upsertPendingOrder(order);
      setSaveStatus(`已切回 ${order.customerName} 的订单，可以继续录入或完成支付`);
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

  const currentRule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];
  const currentOrderSummary = currentOrder?.summary || { itemCount: 0, totalAmount: 0 };
  const canCompleteOrder = currentOrder && currentOrder.items.length > 0 && currentOrder.status !== 'paid';

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
            <div>后端状态：{backendStatus}</div>
            <div>存储模式：{storageMode}</div>
            {currentOrder && <div>订单编号：{currentOrder.id.slice(0, 14)}</div>}
            {lastPaidOrder && lastPaidOrder.paidAt && (
              <div>最近结清：{new Date(lastPaidOrder.paidAt).toLocaleString('zh-CN')}</div>
            )}
          </div>
        </div>
      </div>

      <div className="layout">
        <section className="surface">
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
              <small>先确认顾客姓名和手机号，再点击这里开始这一位客人的新订单。</small>
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

              {!normalizedCustomerName || !normalizedCustomerPhone ? (
                <p className="reservation-empty">先输入顾客姓名和手机号，系统才能显示这位客户的预定信息。</p>
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
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => toggleReservation(reservation.id)}
                            >
                              {selectedReservationIds.includes(reservation.id) ? '已选择' : '加入预定'}
                            </button>
                          </div>
                          <div className="reservation-grid">
                            <span>剩余 {formatNumber(reservation.remainingReservedWeight, 4)}g</span>
                            <span>锁价 $ {formatNumber(reservation.lockedIntlGoldPrice, 2)}</span>
                            <span>预定时间 {new Date(reservation.reservedAt).toLocaleString('zh-CN')}</span>
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
              <small>公式中会先换算成每克美元价格：国际金价 ÷ 31.1035。</small>
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
              <div className="result-label">当前块总价</div>
              <div className="result-value">{results.totalPriceText}</div>
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
                    <span>创建时间 {new Date(currentOrder.createdAt).toLocaleString('zh-CN')}</span>
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
                          <strong>第 {index + 1} 块</strong>
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
                          <span>纯度 {formatNumber(item.purity, 2)}%</span>
                          <span>
                            {item.allocations?.length > 1 ? '计价方式 拆分计价' : `国际金价 $ ${formatNumber(item.intlGoldPrice, 2)}`}
                          </span>
                          <span>
                            {item.allocations?.length > 1 ? '单价 以下方明细为准' : `每克 $ ${formatNumber(item.finalPrice, 2)}`}
                          </span>
                        </div>
                        {item.allocations?.length > 0 && (
                          <div className="allocation-list">
                            {item.allocations.map((allocation, allocationIndex) => (
                              <div className="allocation-item" key={`${item.id}-allocation-${allocationIndex}`}>
                                <strong>{allocation.label}</strong>
                                <div className="order-item-grid">
                                  <span>克数 {formatNumber(allocation.allocatedWeight, 4)}g</span>
                                  <span>国际金价 $ {formatNumber(allocation.intlGoldPriceUsed, 2)}</span>
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
                              <span>纯度 {formatNumber(item.purity, 2)}%</span>
                              <span>国际金价 $ {formatNumber(item.intlGoldPrice, 2)}</span>
                              <span>每克 $ {formatNumber(item.finalPrice, 2)}</span>
                              <span>小计 $ {formatNumber(item.totalPrice, 0)}</span>
                            </div>
                            {item.allocations?.length > 0 && (
                              <div className="allocation-list">
                                {item.allocations.map((allocation, allocationIndex) => (
                                  <div className="allocation-item" key={`${pendingOrder.id}-${index}-${allocationIndex}`}>
                                    <strong>{allocation.label}</strong>
                                    <div className="order-item-grid">
                                      <span>克数 {formatNumber(allocation.allocatedWeight, 4)}g</span>
                                      <span>国际金价 $ {formatNumber(allocation.intlGoldPriceUsed, 2)}</span>
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
      </div>
    </div>
  );
}

export default App;
