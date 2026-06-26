// ── State ──────────────────────────────────────────────────────────────
let allResults      = [];   // full unfiltered dataset (never mutated)
let filteredResults = [];   // current filtered view
let currentPage     = 1;
const PAGE_SIZE     = 25;
let sortKey         = 'last_update_date';
let sortDir         = 'desc';   // 'asc' | 'desc'

// ── Column definitions ──────────────────────────────────────────────────
// Maps API keys → display labels and optional renderer
const COLUMNS = [
    { key: 'drug_identification_number', label: 'DIN',              cls: 'col-din',         link: true },
    { key: 'brand_name',                 label: 'Brand name',       cls: 'col-brand' },
    { key: 'company_name',               label: 'Company' },
    { key: 'ingredient_name',            label: 'Active ingredients', cls: 'col-ingredients' },
    { key: 'route_of_administration_name', label: 'Route' },
    { key: 'last_update_date',           label: 'Last updated',     cls: 'col-date' },
    { key: 'history_date',               label: 'History date',     cls: 'col-date' },
];

// ── Fetch helper ────────────────────────────────────────────────────────
async function fetchData(uri) {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${uri}`);
    return response.json();
}

// ── Data loading ─────────────────────────────────────────────────────────
async function processPart1() {
    const [drugProducts, statuses, schedules, routes] = await Promise.all([
        fetchData('https://health-products.canada.ca/api/drug/drugproduct/?status=1&lang=en&type=json'),
        fetchData('https://health-products.canada.ca/api/drug/status/?lang=en&type=json'),
        fetchData('https://health-products.canada.ca/api/drug/schedule/?lang=en&type=json'),
        fetchData('https://health-products.canada.ca/api/drug/route/?lang=en&type=json'),
    ]);

    const combined = {};
    [drugProducts, statuses, schedules, routes].forEach(list => {
        list.forEach(obj => {
            const code = obj.drug_code;
            if (!combined[code]) combined[code] = {};
            Object.assign(combined[code], obj);
        });
    });

    return Object.values(combined)
        .filter(obj =>
            obj.last_update_date &&
            obj.schedule_name === 'NON-PRESCRIPTION DRUGS' &&
            obj.class_name    === 'Human'
        )
        .sort((a, b) => new Date(b.last_update_date) - new Date(a.last_update_date));
}

async function processPart2() {
    const activeIngredients = await fetchData(
        'https://health-products.canada.ca/api/drug/activeingredient/?lang=en&type=json'
    );

    const byCode = {};
    activeIngredients.forEach(ing => {
        const code = ing.drug_code;
        if (!byCode[code]) byCode[code] = [];
        byCode[code].push(ing);
    });

    // Collapse each drug's ingredients into a single readable string
    const collapsed = {};
    Object.entries(byCode).forEach(([code, ings]) => {
        collapsed[code] = {
            ingredient_name: ings.map(i => i.ingredient_name).join(', '),
        };
    });
    return collapsed;
}

async function main() {
    showLoading();
    try {
        const [part1, part2] = await Promise.all([processPart1(), processPart2()]);

        allResults = part1.map(obj => ({
            ...obj,
            ...(part2[obj.drug_code] || {}),
        }));

        filteredResults = [...allResults];
        currentPage     = 1;
        renderAll();
    } catch (err) {
        console.error('Error loading data:', err);
        showError();
    }
}

// ── Filtering ───────────────────────────────────────────────────────────
function applyFilters() {
    const companyRaw    = document.getElementById('companyFilter').value.trim();
    const ingredientRaw = document.getElementById('ingredientFilter').value.trim();
    const company       = companyRaw.toLowerCase();
    const ingredient    = ingredientRaw.toLowerCase();

    // Always filter from the full dataset — fixes the cumulative-filter bug
    filteredResults = allResults.filter(obj => {
        const matchCompany    = !company    || (obj.company_name    || '').toLowerCase().includes(company);
        const matchIngredient = !ingredient || (obj.ingredient_name || '').toLowerCase().includes(ingredient);
        return matchCompany && matchIngredient;
    });

    currentPage = 1;
    renderAll();
    renderPills(companyRaw, ingredientRaw);
}

function resetFilters() {
    document.getElementById('companyFilter').value    = '';
    document.getElementById('ingredientFilter').value = '';
    filteredResults = [...allResults];
    currentPage     = 1;
    renderAll();
    renderPills('', '');
}

// Clear one pill individually
function clearPill(field) {
    document.getElementById(field).value = '';
    applyFilters();
}

// ── Sorting ─────────────────────────────────────────────────────────────
function toggleSort(key) {
    if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        sortKey = key;
        sortDir = 'asc';
    }
    currentPage = 1;
    renderAll();
}

function getSorted(data) {
    return [...data].sort((a, b) => {
        const va = a[sortKey] || '';
        const vb = b[sortKey] || '';
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sortDir === 'asc' ? cmp : -cmp;
    });
}

// ── Rendering ───────────────────────────────────────────────────────────
function renderAll() {
    renderResultsMeta();
    renderTable();
    renderPagination();
}

function renderResultsMeta() {
    const meta  = document.getElementById('resultsMeta');
    const count = document.getElementById('resultsCount');
    meta.style.display  = 'flex';
    count.innerHTML = `Showing <strong>${filteredResults.length.toLocaleString()}</strong> of <strong>${allResults.length.toLocaleString()}</strong> products`;
}

function renderTable() {
    const container = document.getElementById('table-container');

    if (filteredResults.length === 0) {
        container.innerHTML = `
            <div class="state-box">
                <div class="state-icon">🔍</div>
                <div class="state-title">No results found</div>
                <div class="state-body">Try adjusting or clearing your filters.</div>
            </div>`;
        return;
    }

    const sorted  = getSorted(filteredResults);
    const start   = (currentPage - 1) * PAGE_SIZE;
    const pageData = sorted.slice(start, start + PAGE_SIZE);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';

    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';

    const table = document.createElement('table');

    // Header
    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    COLUMNS.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col.label;
        th.onclick = () => toggleSort(col.key);
        if (col.key === sortKey) {
            th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
        headerRow.appendChild(th);
    });

    // Body
    const tbody = document.createElement('tbody');
    pageData.forEach(obj => {
        const row = tbody.insertRow();
        COLUMNS.forEach(col => {
            const td = row.insertCell();
            if (col.cls) td.className = col.cls;
            const value = obj[col.key] || '—';
            if (col.link && obj[col.key]) {
                const a = document.createElement('a');
                a.href        = `https://health-products.canada.ca/dpd-bdpp/info.do?lang=eng&code=${obj[col.key]}`;
                a.textContent = value;
                a.target      = '_blank';
                a.rel         = 'noopener noreferrer';
                td.appendChild(a);
            } else {
                td.textContent = value;
            }
        });
    });

    table.appendChild(tbody);
    scroll.appendChild(table);
    wrapper.appendChild(scroll);
    container.innerHTML = '';
    container.appendChild(wrapper);
}

function renderPagination() {
    const container  = document.getElementById('pagination');
    const totalPages = Math.ceil(filteredResults.length / PAGE_SIZE);
    container.innerHTML = '';

    if (totalPages <= 1) return;

    const makeBtn = (label, page, disabled, active) => {
        const btn = document.createElement('button');
        btn.className   = 'page-btn' + (active ? ' active' : '');
        btn.textContent = label;
        btn.disabled    = disabled;
        btn.onclick     = () => { currentPage = page; renderAll(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
        return btn;
    };

    container.appendChild(makeBtn('←', currentPage - 1, currentPage === 1, false));

    // Show a sliding window of page numbers
    const window_size = 5;
    let start = Math.max(1, currentPage - Math.floor(window_size / 2));
    let end   = Math.min(totalPages, start + window_size - 1);
    if (end - start + 1 < window_size) start = Math.max(1, end - window_size + 1);

    if (start > 1) {
        container.appendChild(makeBtn('1', 1, false, false));
        if (start > 2) { const el = document.createElement('span'); el.textContent = '…'; el.style.padding = '0 4px'; el.style.color = 'var(--grey-300)'; container.appendChild(el); }
    }
    for (let p = start; p <= end; p++) {
        container.appendChild(makeBtn(p, p, false, p === currentPage));
    }
    if (end < totalPages) {
        if (end < totalPages - 1) { const el = document.createElement('span'); el.textContent = '…'; el.style.padding = '0 4px'; el.style.color = 'var(--grey-300)'; container.appendChild(el); }
        container.appendChild(makeBtn(totalPages, totalPages, false, false));
    }

    container.appendChild(makeBtn('→', currentPage + 1, currentPage === totalPages, false));
}

function renderPills(company, ingredient) {
    const pillsContainer = document.getElementById('activePills');
    pillsContainer.innerHTML = '';

    const addPill = (label, field) => {
        const pill = document.createElement('div');
        pill.className = 'filter-pill';
        pill.innerHTML = `${label} <button onclick="clearPill('${field}')" title="Remove filter">✕</button>`;
        pillsContainer.appendChild(pill);
    };

    if (company)    addPill(`Company: ${company}`,         'companyFilter');
    if (ingredient) addPill(`Ingredient: ${ingredient}`,   'ingredientFilter');
}

// ── Loading / error states ───────────────────────────────────────────────
function showLoading() {
    document.getElementById('table-container').innerHTML = `
        <div class="loading-state">
            <div class="spinner"></div>
            <span class="loading-label">Loading drug data…</span>
            <span class="loading-sub">Fetching from Health Canada's database</span>
        </div>`;
}

function showError() {
    document.getElementById('table-container').innerHTML = `
        <div class="state-box">
            <div class="state-icon">⚠️</div>
            <div class="state-title">Couldn't load data</div>
            <div class="state-body">There was a problem reaching the Health Canada API. Check your connection and reload the page.</div>
        </div>`;
}

// ── Live filtering on Enter ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    ['companyFilter', 'ingredientFilter'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') applyFilters();
        });
    });
    main();
});
