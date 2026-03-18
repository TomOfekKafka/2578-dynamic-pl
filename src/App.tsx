import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, LineChart, Line
} from 'recharts';
import { credentialsReady, callMcpTool } from './api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiRow {
  'Reporting Date'?: number;
  'DR_ACC_L1.5'?: string;
  'Scenario'?: string;
  Amount: number;
}

interface QuerySettings {
  scenario: string;
  plSection: string;
  breakdownByCategory: boolean;
  breakdownByTime: boolean;
  breakdownByScenario: boolean;
  selectedCategories: string[];
  startDate: string;
  endDate: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PL_CATEGORIES = ['COGS', 'Finance expenses', 'G&A', 'Intercompany', 'Other', 'R&D', 'Revenues', 'S&M', 'Tax'];
const TABLE_ID = '16528';

const CATEGORY_COLORS: Record<string, string> = {
  'Revenues': '#10b981',
  'COGS': '#ef4444',
  'G&A': '#3b82f6',
  'R&D': '#8b5cf6',
  'S&M': '#f97316',
  'Finance expenses': '#ec4899',
  'Intercompany': '#14b8a6',
  'Other': '#94a3b8',
  'Tax': '#f59e0b',
};

const DEFAULT_COLORS = ['#4646CE', '#3b82f6', '#10b981', '#f97316', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f59e0b'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const decodeHtml = (s: string): string => {
  const txt = document.createElement('textarea');
  txt.innerHTML = s;
  return txt.value;
};

const formatCurrency = (val: number): string => {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) {
    return (val < 0 ? '-' : '') + '$' + (abs / 1_000_000).toFixed(1) + 'M';
  }
  if (abs >= 1_000) {
    return (val < 0 ? '-' : '') + '$' + (abs / 1_000).toFixed(0) + 'K';
  }
  return '$' + val.toFixed(0);
};

const formatCurrencyFull = (val: number): string => {
  return (val < 0 ? '-$' : '$') + Math.abs(val).toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const tsToMonthLabel = (ts: number): string => {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' });
};

const monthStrToTs = (monthStr: string): { start: number; end: number } => {
  const [year, month] = monthStr.split('-').map(Number);
  const startOfMonth = new Date(Date.UTC(year!, month! - 1, 1));
  const endOfMonth = new Date(Date.UTC(year!, month!, 0, 23, 59, 59));
  return { start: startOfMonth.getTime() / 1000, end: endOfMonth.getTime() / 1000 };
};

// ─── Mock data ────────────────────────────────────────────────────────────────

const generateMockData = (): ApiRow[] => {
  const rows: ApiRow[] = [];
  const categories = PL_CATEGORIES;
  const amounts: Record<string, number> = {
    'Revenues': 5000000, 'COGS': -1500000, 'G&A': -600000,
    'R&D': -800000, 'S&M': -700000, 'Finance expenses': -200000,
    'Intercompany': -100000, 'Other': -50000, 'Tax': -300000,
  };
  // Jan 2023 to Dec 2024
  for (let y = 2023; y <= 2024; y++) {
    for (let m = 1; m <= 12; m++) {
      const ts = Date.UTC(y, m - 1, 28) / 1000;
      for (const cat of categories) {
        rows.push({
          'Reporting Date': ts,
          'DR_ACC_L1.5': cat,
          Amount: (amounts[cat] ?? 100000) * (0.9 + Math.random() * 0.2),
        });
      }
    }
  }
  return rows;
};

// ─── Loading Spinner ──────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="spinner-wrap">
      <div className="spinner" />
    </div>
  );
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

interface SummaryCardsProps {
  data: ApiRow[];
}

function SummaryCards({ data }: SummaryCardsProps) {
  const revenue = data.filter(r => decodeHtml(r['DR_ACC_L1.5'] ?? '') === 'Revenues').reduce((s, r) => s + r.Amount, 0);
  const expenses = data.filter(r => {
    const cat = decodeHtml(r['DR_ACC_L1.5'] ?? '');
    return cat !== 'Revenues' && cat !== '';
  }).reduce((s, r) => s + r.Amount, 0);
  const netIncome = revenue + expenses; // expenses are negative

  return (
    <div className="summary-cards">
      <div className="card card-green">
        <div className="card-label">Total Revenue</div>
        <div className="card-value">{formatCurrencyFull(revenue)}</div>
      </div>
      <div className="card card-red">
        <div className="card-label">Total Expenses</div>
        <div className="card-value">{formatCurrencyFull(Math.abs(expenses))}</div>
      </div>
      <div className={`card ${netIncome >= 0 ? 'card-blue' : 'card-orange'}`}>
        <div className="card-label">Net Income</div>
        <div className="card-value">{formatCurrencyFull(netIncome)}</div>
      </div>
    </div>
  );
}

// ─── Data Table ───────────────────────────────────────────────────────────────

interface DataTableProps {
  data: ApiRow[];
  settings: QuerySettings;
}

function DataTable({ data, settings }: DataTableProps) {
  const { breakdownByCategory, breakdownByTime, breakdownByScenario } = settings;

  // Pivot: if time+category → rows=dates, cols=categories
  if (breakdownByTime && breakdownByCategory) {
    const dates = [...new Set(data.map(r => r['Reporting Date']!))].sort((a, b) => a - b);
    const cats = [...new Set(data.map(r => decodeHtml(r['DR_ACC_L1.5'] ?? '')))].filter(Boolean).sort();

    const pivot: Record<number, Record<string, number>> = {};
    for (const row of data) {
      const d = row['Reporting Date']!;
      const c = decodeHtml(row['DR_ACC_L1.5'] ?? '');
      if (!pivot[d]) pivot[d] = {};
      pivot[d][c] = (pivot[d][c] ?? 0) + row.Amount;
    }

    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              {cats.map(c => <th key={c} className="num">{c}</th>)}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {dates.map((d, i) => {
              const rowData = pivot[d] ?? {};
              const total = Object.values(rowData).reduce((s, v) => s + v, 0);
              return (
                <tr key={d} className={i % 2 === 0 ? 'row-even' : 'row-odd'}>
                  <td>{tsToMonthLabel(d)}</td>
                  {cats.map(c => (
                    <td key={c} className={`num ${(rowData[c] ?? 0) < 0 ? 'negative' : ''}`}>
                      {formatCurrency(rowData[c] ?? 0)}
                    </td>
                  ))}
                  <td className={`num total-col ${total < 0 ? 'negative' : ''}`}>
                    {formatCurrency(total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td><strong>Total</strong></td>
              {cats.map(c => {
                const total = data.filter(r => decodeHtml(r['DR_ACC_L1.5'] ?? '') === c).reduce((s, r) => s + r.Amount, 0);
                return (
                  <td key={c} className={`num total-col ${total < 0 ? 'negative' : ''}`}>
                    <strong>{formatCurrency(total)}</strong>
                  </td>
                );
              })}
              <td className="num total-col">
                <strong>{formatCurrency(data.reduce((s, r) => s + r.Amount, 0))}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }

  // Only time dimension
  if (breakdownByTime && !breakdownByCategory) {
    const byDate: Record<number, number> = {};
    for (const row of data) {
      const d = row['Reporting Date']!;
      byDate[d] = (byDate[d] ?? 0) + row.Amount;
    }
    const dates = Object.keys(byDate).map(Number).sort((a, b) => a - b);
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Date</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {dates.map((d, i) => (
              <tr key={d} className={i % 2 === 0 ? 'row-even' : 'row-odd'}>
                <td>{tsToMonthLabel(d)}</td>
                <td className={`num ${byDate[d]! < 0 ? 'negative' : ''}`}>{formatCurrencyFull(byDate[d]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Only category dimension
  if (breakdownByCategory && !breakdownByTime) {
    const byCat: Record<string, number> = {};
    for (const row of data) {
      const c = decodeHtml(row['DR_ACC_L1.5'] ?? '');
      byCat[c] = (byCat[c] ?? 0) + row.Amount;
    }
    const cats = Object.keys(byCat).sort();
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Category</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {cats.map((c, i) => (
              <tr key={c} className={i % 2 === 0 ? 'row-even' : 'row-odd'}>
                <td>{c}</td>
                <td className={`num ${byCat[c]! < 0 ? 'negative' : ''}`}>{formatCurrencyFull(byCat[c]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Scenario breakdown
  if (breakdownByScenario) {
    const groupKey = (r: ApiRow) => r.Scenario ?? 'Unknown';
    const scenarios = [...new Set(data.map(groupKey))].sort();
    const byScen: Record<string, number> = {};
    for (const row of data) byScen[groupKey(row)] = (byScen[groupKey(row)] ?? 0) + row.Amount;
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Scenario</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {scenarios.map((s, i) => (
              <tr key={s} className={i % 2 === 0 ? 'row-even' : 'row-odd'}>
                <td>{s}</td>
                <td className={`num ${byScen[s]! < 0 ? 'negative' : ''}`}>{formatCurrencyFull(byScen[s]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // No dimensions — single total
  const total = data.reduce((s, r) => s + r.Amount, 0);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Metric</th><th className="num">Amount</th></tr></thead>
        <tbody>
          <tr className="row-even">
            <td>Total Amount</td>
            <td className={`num ${total < 0 ? 'negative' : ''}`}>{formatCurrencyFull(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Chart ────────────────────────────────────────────────────────────────────

interface ChartProps {
  data: ApiRow[];
  settings: QuerySettings;
}

function Chart({ data, settings }: ChartProps) {
  const { breakdownByCategory, breakdownByTime } = settings;

  if (breakdownByTime && breakdownByCategory) {
    // Stacked bar chart: x=date, stacks=categories
    const dates = [...new Set(data.map(r => r['Reporting Date']!))].sort((a, b) => a - b);
    const cats = [...new Set(data.map(r => decodeHtml(r['DR_ACC_L1.5'] ?? '')))].filter(Boolean).sort();

    const chartData = dates.map(d => {
      const point: Record<string, number | string> = { date: tsToMonthLabel(d) };
      for (const c of cats) {
        const rows = data.filter(r => r['Reporting Date'] === d && decodeHtml(r['DR_ACC_L1.5'] ?? '') === c);
        point[c] = rows.reduce((s, r) => s + r.Amount, 0);
      }
      return point;
    });

    return (
      <ResponsiveContainer width="100%" height={340}>
        <BarChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" height={60} />
          <YAxis tickFormatter={v => formatCurrency(v as number)} tick={{ fontSize: 11 }} width={80} />
          <Tooltip formatter={(v: number) => formatCurrencyFull(v)} />
          <Legend wrapperStyle={{ paddingTop: 8 }} />
          {cats.map((c, i) => (
            <Bar key={c} dataKey={c} stackId="a" fill={CATEGORY_COLORS[c] ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (breakdownByTime && !breakdownByCategory) {
    // Line chart by time
    const byDate: Record<number, number> = {};
    for (const row of data) {
      const d = row['Reporting Date']!;
      byDate[d] = (byDate[d] ?? 0) + row.Amount;
    }
    const chartData = Object.entries(byDate)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([ts, amt]) => ({ date: tsToMonthLabel(Number(ts)), Amount: amt }));

    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 30 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" height={60} />
          <YAxis tickFormatter={v => formatCurrency(v as number)} tick={{ fontSize: 11 }} width={80} />
          <Tooltip formatter={(v: number) => formatCurrencyFull(v)} />
          <Line type="monotone" dataKey="Amount" stroke="#4646CE" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Category only — horizontal bar chart
  const byCat: Record<string, number> = {};
  for (const row of data) {
    const c = decodeHtml(row['DR_ACC_L1.5'] ?? row.Scenario ?? 'Total');
    byCat[c] = (byCat[c] ?? 0) + row.Amount;
  }
  const chartData = Object.entries(byCat).sort(([, a], [, b]) => b - a).map(([cat, amt]) => ({ cat, Amount: amt }));

  if (chartData.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 45)}>
      <BarChart data={chartData} layout="vertical" margin={{ top: 10, right: 30, left: 100, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis type="number" tickFormatter={v => formatCurrency(v as number)} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="cat" tick={{ fontSize: 12 }} width={100} />
        <Tooltip formatter={(v: number) => formatCurrencyFull(v)} />
        <Bar dataKey="Amount" radius={[0, 4, 4, 0]}>
          {chartData.map((entry) => (
            <rect key={entry.cat} fill={CATEGORY_COLORS[entry.cat] ?? '#4646CE'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [scenario, setScenario] = useState('Actuals');
  const [plSection, setPlSection] = useState('P&L');
  const [breakdownByCategory, setBreakdownByCategory] = useState(true);
  const [breakdownByTime, setBreakdownByTime] = useState(true);
  const [breakdownByScenario, setBreakdownByScenario] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([...PL_CATEGORIES]);
  const [startDate, setStartDate] = useState('2023-01');
  const [endDate, setEndDate] = useState('2024-12');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ApiRow[] | null>(null);
  const [querySettings, setQuerySettings] = useState<QuerySettings | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  const toggleCategory = (cat: string) => {
    setSelectedCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  const runQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUsingMock(false);

    const currentSettings: QuerySettings = {
      scenario, plSection, breakdownByCategory, breakdownByTime,
      breakdownByScenario, selectedCategories, startDate, endDate,
    };
    setQuerySettings(currentSettings);

    try {
      await credentialsReady;

      const dimensions: string[] = [];
      if (breakdownByCategory) dimensions.push('DR_ACC_L1.5');
      if (breakdownByTime) dimensions.push('Reporting Date');
      if (breakdownByScenario) dimensions.push('Scenario');

      const filters: Array<{ name: string; values: string[]; is_excluded: boolean }> = [
        { name: 'DR_ACC_L0', values: [plSection], is_excluded: false },
      ];

      if (!breakdownByScenario) {
        filters.push({ name: 'Scenario', values: [scenario], is_excluded: false });
      }

      const excludedCategories = PL_CATEGORIES.filter(c => !selectedCategories.includes(c));
      if (excludedCategories.length > 0) {
        filters.push({ name: 'DR_ACC_L1.5', values: excludedCategories, is_excluded: true });
      }

      const raw = await callMcpTool('aggregate_table_data', {
        table_id: TABLE_ID,
        dimensions,
        metrics: [{ field: 'Amount', agg: 'SUM' }],
        filters,
      }) as ApiRow[];

      // Filter client-side by date range
      const { end: startEnd } = monthStrToTs(startDate);
      const { end: endEnd } = monthStrToTs(endDate);
      const startTs = monthStrToTs(startDate).start;

      let filtered = raw;
      if (breakdownByTime) {
        filtered = raw.filter(r => {
          const ts = r['Reporting Date'];
          if (ts == null) return true;
          return ts >= startTs - 86400 && ts <= endEnd + 86400;
        });
      }
      // Suppress unused
      void startEnd;

      setResults(filtered);
    } catch (err) {
      console.error('API error, using mock data:', err);
      setError('Could not reach API — showing demo data.');
      setUsingMock(true);

      // Filter mock data by date range
      const mock = generateMockData();
      const startTs = monthStrToTs(startDate).start;
      const { end: endEnd } = monthStrToTs(endDate);
      const filtered = mock.filter(r => {
        const ts = r['Reporting Date'];
        if (ts == null) return true;
        return ts >= startTs - 86400 && ts <= endEnd + 86400;
      });
      setResults(filtered);
    } finally {
      setLoading(false);
    }
  }, [scenario, plSection, breakdownByCategory, breakdownByTime, breakdownByScenario, selectedCategories, startDate, endDate]);

  // Run query on mount
  useEffect(() => {
    runQuery();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="header-logo">
            <svg width="32" height="32" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="64" height="64" rx="12" fill="#4646CE" />
              <rect x="10" y="38" width="10" height="16" rx="2" fill="#fff" opacity="0.9" />
              <rect x="27" y="28" width="10" height="26" rx="2" fill="#10b981" opacity="0.9" />
              <rect x="44" y="16" width="10" height="38" rx="2" fill="#f97316" opacity="0.9" />
              <path d="M15 30 L32 20 L49 10" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.6" />
            </svg>
          </div>
          <div>
            <h1 className="app-title">Dynamic P&amp;L</h1>
            <p className="app-subtitle">Interactive Profit &amp; Loss Explorer</p>
          </div>
        </div>
      </header>

      <main className="main-content">
        {/* Control Panel */}
        <section className="control-panel">
          <div className="controls-grid">
            {/* Scenario */}
            <div className="control-group">
              <label className="control-label">Scenario</label>
              <div className="toggle-group">
                {['Actuals', 'Forecast'].map(s => (
                  <button
                    key={s}
                    className={`toggle-btn ${scenario === s ? 'active' : ''}`}
                    onClick={() => setScenario(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* P&L Section */}
            <div className="control-group">
              <label className="control-label">P&amp;L Section</label>
              <select className="select-input" value={plSection} onChange={e => setPlSection(e.target.value)}>
                <option value="P&L">P&amp;L</option>
                <option value="Balance Sheet">Balance Sheet</option>
              </select>
            </div>

            {/* Date Range */}
            <div className="control-group">
              <label className="control-label">Date Range</label>
              <div className="date-range">
                <input
                  type="month"
                  className="date-input"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                />
                <span className="date-sep">to</span>
                <input
                  type="month"
                  className="date-input"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {/* Break down by */}
            <div className="control-group">
              <label className="control-label">Break down by</label>
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input type="checkbox" checked={breakdownByCategory} onChange={e => setBreakdownByCategory(e.target.checked)} />
                  <span>Account Category</span>
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={breakdownByTime} onChange={e => setBreakdownByTime(e.target.checked)} />
                  <span>Time (Month)</span>
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" checked={breakdownByScenario} onChange={e => setBreakdownByScenario(e.target.checked)} />
                  <span>Scenario</span>
                </label>
              </div>
            </div>

            {/* Filter by Category */}
            <div className="control-group control-group-wide">
              <label className="control-label">Filter by Account Category</label>
              <div className="category-checkboxes">
                {PL_CATEGORIES.map(cat => (
                  <label key={cat} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedCategories.includes(cat)}
                      onChange={() => toggleCategory(cat)}
                    />
                    <span style={{ borderLeft: `3px solid ${CATEGORY_COLORS[cat] ?? '#ccc'}`, paddingLeft: 6 }}>
                      {cat}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="run-btn-wrap">
            <button className="run-btn" onClick={runQuery} disabled={loading}>
              {loading ? 'Running…' : 'Run Query'}
            </button>
          </div>
        </section>

        {/* Error / mock notice */}
        {error && (
          <div className="notice-bar">
            {error}
          </div>
        )}
        {usingMock && !error && (
          <div className="notice-bar notice-info">
            Showing demo data.
          </div>
        )}

        {/* Results */}
        {loading && <Spinner />}

        {!loading && results && querySettings && (
          <>
            <SummaryCards data={results} />

            <section className="results-section">
              <div className="results-grid">
                <div className="results-card">
                  <h2 className="section-title">Data Table</h2>
                  <DataTable data={results} settings={querySettings} />
                </div>
                <div className="results-card">
                  <h2 className="section-title">Chart</h2>
                  <Chart data={results} settings={querySettings} />
                </div>
              </div>
            </section>
          </>
        )}

        {!loading && !results && (
          <div className="empty-state">
            <p>Configure your query above and click <strong>Run Query</strong> to see results.</p>
          </div>
        )}
      </main>
    </div>
  );
}
