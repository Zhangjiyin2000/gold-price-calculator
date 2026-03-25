import { useEffect, useState } from 'react';
import {
  FORMULA_RULES,
  buildRecordPayload,
  calculateResults,
  formatNumber,
} from './lib/calculator.js';

const CUSTOMER_STORAGE_KEY = 'gold-price-calculator-customers';

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

    if (typeof detail.type === 'string') {
      const pieces = [detail.type];

      if (typeof detail.message === 'string') {
        pieces.push(detail.message);
      }

      return pieces.join(': ');
    }

    return JSON.stringify(detail);
  }

  return String(detail);
}

function App() {
  const [values, setValues] = useState(initialValues);
  const [results, setResults] = useState(emptyResults);
  const [saveStatus, setSaveStatus] = useState('正在检查后端连接...');
  const [backendStatus, setBackendStatus] = useState('连接中');
  const [savedCustomers, setSavedCustomers] = useState([]);

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
    async function loadStatus() {
      try {
        const response = await fetch(apiUrl('/api/health'));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        setBackendStatus(data.status === 'ok' ? '已连接' : '异常');
        setSaveStatus(data.airtable_enabled ? '等待保存新记录' : '后端尚未配置 Airtable');
      } catch (error) {
        setBackendStatus('未连接');
        setSaveStatus('后端未启动，暂时无法保存到 Airtable');
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

  function resetForm() {
    setValues(initialValues);
    setSaveStatus(backendStatus === '已连接' ? '等待保存新记录' : '后端未启动，暂时无法保存到 Airtable');
  }

  async function saveToAirtable() {
    const payload = buildRecordPayload(values);

    if (payload.error) {
      setSaveStatus(payload.error);
      return;
    }

    setSaveStatus('正在写入 Airtable...');

    try {
      const response = await fetch(apiUrl('/api/records'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(formatApiError(data.detail, response.status));
      }

      setSaveStatus(`已记录到 Airtable：${new Date(payload.savedAt).toLocaleString('zh-CN')}`);
      persistCustomerProfile(values.customerName, values.customerPhone);
    } catch (error) {
      setSaveStatus(`写入失败：${error.message}`);
    }
  }

  const currentRule = FORMULA_RULES[values.formulaRule] || FORMULA_RULES['2088.136'];

  return (
    <div className="app-shell">
      <div className="hero">
        <div>
          <p className="eyebrow">React + FastAPI</p>
          <h1>黄金价格计算器</h1>
          <p className="hero-copy">
            适用于黄金买卖门店。输入水重、干重、税点和国际金价，页面会按你当前使用的业务规则即时计算纯度、每克金价和总金价。
          </p>
        </div>
        <div className="hero-panel">
          <div className="hero-stat-label">后端状态</div>
          <div className="hero-stat-value">{backendStatus}</div>
          <div className="hero-stat-sub">默认通过 FastAPI 统一处理 Airtable 写入，避免前端暴露凭证。</div>
        </div>
      </div>

      <div className="layout">
        <section className="surface">
          <div className="section-heading">
            <h2>输入数据</h2>
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
              <small>点开输入框后可直接选取之前输入过的姓名。</small>
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
              <small>点开输入框后可直接选取之前输入过的手机号。</small>
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
              <small>切换后页面会明确展示当前使用的公式常数，并立即重新计算结果。</small>
            </label>
          </div>

          <div className="actions">
            <button className="button button-primary" type="button" onClick={saveToAirtable}>
              记录到 Airtable
            </button>
            <button className="button button-secondary" type="button" onClick={resetForm}>
              清空
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
              <strong>总金价公式：</strong>
              <code>干重 × 每克金价</code>
            </div>
            <p>
              说明：纯度截断保留两位小数，每克金价截断保留两位小数，总金价直接去掉所有小数位。
            </p>
          </div>
        </section>

        <section className="surface">
          <div className="section-heading">
            <h2>计算结果</h2>
            <span className="pill soft">自动实时刷新</span>
          </div>

          <div className="results">
            <article className="result-card accent-green">
              <div className="result-label">纯度</div>
              <div className="result-value">{results.purityText}</div>
              <div className="result-sub">{results.puritySub}</div>
            </article>

            <article className="result-card">
              <div className="result-label">国际金价折算（美元/克）</div>
              <div className="result-value">{results.perGramText}</div>
              <div className="result-sub">按 国际金价 ÷ 31.1035 计算</div>
            </article>

            <article className="result-card accent-amber">
              <div className="result-label">按公式计算后的每克金价</div>
              <div className="result-value">{results.finalPriceText}</div>
              <div className="result-sub">{results.finalPriceSub}</div>
            </article>

            <article className="result-card">
              <div className="result-label">总金价</div>
              <div className="result-value">{results.totalPriceText}</div>
              <div className="result-sub">{results.totalPriceSub}</div>
            </article>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
