import { useEffect, useState } from 'react';
import {
  FORMULA_RULES,
  buildRecordPayload,
  calculateResults,
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
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function apiUrl(path) {
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
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
  const [pendingOrders, setPendingOrders] = useState([]);
  const [currentOrder, setCurrentOrder] = useState(null);
  const [lastPaidOrder, setLastPaidOrder] = useState(null);
  const [busyAction, setBusyAction] = useState('');

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
    const payload = calculateResults(values);
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
      });
      return;
    }

    setResults({
      purityText: `${formatNumber(payload.purity, 2)}%`,
      puritySub: `计算过程：(${formatNumber(payload.waterWeight, 4)} ÷ ${formatNumber(payload.dryWeight, 4)}) × 2307.454 - ${formatNumber(rule.constant, 3)}，结果为 ${formatNumber(payload.purity, 2)}%`,
      perGramText: payload.missingFields ? '--' : `$ ${formatNumber(payload.perGramPrice, 2)}`,
      finalPriceText: payload.missingFields ? '--' : `$ ${formatNumber(payload.finalPrice, 2)}`,
      finalPriceSub: payload.missingFields
        ? '输入税点和国际金价后继续计算每克金价'
        : `计算过程：(${formatNumber(payload.intlGoldPrice, 2)} ÷ 31.1035) × (1 - ${formatNumber(payload.taxRate, 4)}%) × ${formatNumber(payload.purity, 2)}%，结果为 ${formatNumber(payload.finalPrice, 2)}`,
      totalPriceText: payload.missingFields ? '--' : `$ ${formatNumber(payload.totalPrice, 0)}`,
      totalPriceSub: payload.missingFields
        ? '输入税点和国际金价后继续计算总金价'
        : `计算过程：${formatNumber(payload.dryWeight, 4)} × ${formatNumber(payload.finalPrice, 2)}，结果为 ${formatNumber(payload.totalPrice, 0)}`,
    });
  }, [values]);

  function updateField(event) {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
  }

  function clearField(name) {
    setValues((current) => ({ ...current, [name]: '' }));
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
      setSaveStatus(`已为 ${order.customerName} 新建订单，现在可以把本次带来的金子逐块加入`);
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

    const payload = buildRecordPayload(values);
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
      setSaveStatus(`已加入当前订单，第 ${order.summary.itemCount} 块金子已计入本单`);
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

            <label className="field">
              <span>干重</span>
              <div className="input-shell">
                <input name="dryWeight" type="number" step="0.0001" placeholder="例如 19.84" value={values.dryWeight} onChange={updateField} />
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
                <input name="waterWeight" type="number" step="0.0001" placeholder="例如 16.23" value={values.waterWeight} onChange={updateField} />
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
                <input name="taxRate" type="number" step="0.0001" placeholder="例如 3" value={values.taxRate} onChange={updateField} />
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
                <input name="intlGoldPrice" type="number" step="0.01" placeholder="例如 3000" value={values.intlGoldPrice} onChange={updateField} />
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
            <button className="button button-primary" type="button" onClick={startNewOrder} disabled={busyAction !== ''}>
              新建订单
            </button>
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
              <code>干重 × 每克金价</code>
            </div>
            <p>
              说明：当前订单已经接到后端。完成支付后，这张订单会锁定；客户再次到店时，请重新新建订单。
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
                          <span>国际金价 $ {formatNumber(item.intlGoldPrice, 2)}</span>
                          <span>每克 $ {formatNumber(item.finalPrice, 2)}</span>
                        </div>
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
