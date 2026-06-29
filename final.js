// ── State ──────────────────────────────────────────────────────────────
let allResults      = [];   // loaded dataset (capped at RESULT_CAP on initial load)
let fullDataset     = null; // null = not yet loaded; array = full set loaded by user
let filteredResults = [];   // current filtered view
let currentPage     = 1;
const PAGE_SIZE     = 25;
const RESULT_CAP    = 1000; // most recent N products shown on startup
let sortKey         = 'last_update_date';
let sortDir         = 'desc';

// Active filter state
let activeStatus = 'all';  // 'all' | 'approved' | 'inactive'
let activeDays   = null;   // null | 90 | 180 | 360
let activeRoute  = '';     // '' | route string

// ── Column definitions ───────────────────────────────────────────────────
const COLUMNS = [
    { key: 'drug_identification_number', label: 'DIN',                cls: 'col-din',         modal: true },
    { key: 'brand_name',                 label: 'Brand name',         cls: 'col-brand' },
    { key: 'company_name',               label: 'Company' },
    { key: 'ingredient_name',            label: 'Active ingredients', cls: 'col-ingredients' },
    { key: 'route_of_administration_name', label: 'Route' },
    { key: 'last_update_date',           label: 'Last updated',       cls: 'col-date' },
    { key: 'history_date',               label: 'History date',       cls: 'col-date' },
];

// ── Fetch helper ─────────────────────────────────────────────────────────
async function fetchData(uri) {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${uri}`);
    return response.json();
}

// ── Paginated fetch ───────────────────────────────────────────────────────
async function fetchAllPages(baseUri) {
    const limit = 1000;
    let offset = 0;
    let all = [];
    while (true) {
        const sep = baseUri.includes('?') ? '&' : '?';
        const page = await fetchData(`${baseUri}${sep}limit=${limit}&offset=${offset}`);
        if (!page || page.length === 0) break;
        all = all.concat(page);
        if (page.length < limit) break;
        offset += limit;
    }
    return all;
}

// ── Data loading ──────────────────────────────────────────────────────────
async function processPart1() {
    const [drugProducts, statuses, schedules, routes] = await Promise.all([
        fetchAllPages('https://health-products.canada.ca/api/drug/drugproduct/?status=1&lang=en&type=json'),
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
    const activeIngredients = await fetchAllPages(
        'https://health-products.canada.ca/api/drug/activeingredient/?lang=en&type=json'
    );

    const byCode = {};
    activeIngredients.forEach(ing => {
        const code = ing.drug_code;
        if (!byCode[code]) byCode[code] = [];
        byCode[code].push(ing);
    });

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

        const merged = part1.map(obj => ({
            ...obj,
            ...(part2[obj.drug_code] || {}),
        }));

        window._fullMerged = merged;

        allResults      = merged.slice(0, RESULT_CAP);
        filteredResults = [...allResults];
        currentPage     = 1;
        populateRouteDropdown();
        renderAll();
        renderStats();
    } catch (err) {
        console.error('Error loading data:', err);
        showError();
    }
}

function loadFullDataset() {
    if (!window._fullMerged) return;
    fullDataset = window._fullMerged;
    allResults  = fullDataset;
    applyFilters();
    populateRouteDropdown();
    renderStats();
    renderLoadMoreBanner();
}

// ── Route dropdown population ─────────────────────────────────────────────
function populateRouteDropdown() {
    const routes = [...new Set(
        allResults
            .map(r => r.route_of_administration_name)
            .filter(Boolean)
    )].sort();

    const sel = document.getElementById('routeFilter');
    if (!sel) return;
    sel.innerHTML = '<option value="">All routes</option>';
    routes.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        sel.appendChild(opt);
    });
}

// ── Filtering ─────────────────────────────────────────────────────────────
function applyFilters() {
    const companyFilter = document.getElementById('companyFilter');
    const ingredientFilter = document.getElementById('ingredientFilter');
    const quickFilter = document.getElementById('quickFilter');
    const routeFilter = document.getElementById('routeFilter');

    const companyRaw    = companyFilter ? companyFilter.value.trim() : '';
    const ingredientRaw = ingredientFilter ? ingredientFilter.value.trim() : '';
    const company       = companyRaw.toLowerCase();
    const ingredient    = ingredientRaw.toLowerCase();
    const quickRaw      = quickFilter ? quickFilter.value.trim() : '';
    const quick         = quickRaw.toLowerCase();
    activeRoute         = routeFilter ? routeFilter.value : '';

    const cutoff = activeDays
        ? new Date(Date.now() - activeDays * 86400000)
        : null;

    filteredResults = allResults.filter(obj => {
        const matchCompany    = !company    || (obj.company_name    || '').toLowerCase().includes(company);
        const matchIngredient = !ingredient || (obj.ingredient_name || '').toLowerCase().includes(ingredient);
        const matchRoute      = !activeRoute || obj.route_of_administration_name === activeRoute;
        const matchDate       = !cutoff || (obj.last_update_date && new Date(obj.last_update_date) >= cutoff);
        const matchQuick      = !quick || [
            obj.brand_name, obj.company_name, obj.ingredient_name,
            obj.route_of_administration_name, obj.drug_identification_number
        ].some(f => (f || '').toLowerCase().includes(quick));

        return matchCompany && matchIngredient && matchRoute && matchDate && matchQuick;
    });

    currentPage = 1;
    renderAll();
    renderPills(companyRaw, ingredientRaw);
    renderStats();
    renderLoadMoreBanner();
}

function resetFilters() {
    const companyFilter = document.getElementById('companyFilter');
    const ingredientFilter = document.getElementById('ingredientFilter');
    const quickFilter = document.getElementById('quickFilter');
    const routeFilter = document.getElementById('routeFilter');

    if (companyFilter) companyFilter.value = '';
    if (ingredientFilter) ingredientFilter.value = '';
    if (quickFilter) quickFilter.value = '';
    if (routeFilter) routeFilter.value = '';

    activeStatus = 'all';
    activeDays   = null;
    activeRoute  = '';
    updateStatusPills();
    updateDayPills();
    filteredResults = [...allResults];
    currentPage     = 1;
    renderAll();
    renderPills('', '');
    renderStats();
    renderLoadMoreBanner();
}

function clearPill(field) {
    if (field === '_days') {
        activeDays = null;
        updateDayPills();
    } else if (field === '_status') {
        activeStatus = 'all';
        updateStatusPills();
    } else if (field === '_route') {
        const routeFilter = document.getElementById('routeFilter');
        if (routeFilter) routeFilter.value = '';
        activeRoute = '';
    } else {
        const inputEl = document.getElementById(field);
        if (inputEl) inputEl.value = '';
    }
    applyFilters();
}

// ── Status pills ──────────────────────────────────────────────────────────
function setStatus(val) {
    activeStatus = val;
    updateStatusPills();
    applyFilters();
}

function updateStatusPills() {
    document.querySelectorAll('.status-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.status === activeStatus);
    });
}

// ── Day pills ─────────────────────────────────────────────────────────────
function setDays(days) {
    activeDays = activeDays === days ? null : days;
    updateDayPills();
    applyFilters();
}

function updateDayPills() {
    document.querySelectorAll('.day-pill').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.days) === activeDays);
    });
}

// ── Quick filter (live) ───────────────────────────────────────────────────
function onQuickInput() {
    applyFilters();
}

// ── Sorting ───────────────────────────────────────────────────────────────
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

// ── Stats panels ──────────────────────────────────────────────────────────
function renderStats() {
    const cutoff = activeDays ? new Date(Date.now() - activeDays * 86400000) : null;
    const inWindow = cutoff
        ? allResults.filter(r => r.last_update_date && new Date(r.last_update_date) >= cutoff).length
        : allResults.length;

    const statInWindow = document.getElementById('statInWindow');
    if (statInWindow) statInWindow.textContent = inWindow.toLocaleString();

    const statFiltered = document.getElementById('statFiltered');
    if (statFiltered) statFiltered.textContent = filteredResults.length.toLocaleString();

    const routeCounts = {};
    filteredResults.forEach(r => {
        const rt = r.route_of_administration_name || 'Unknown';
        routeCounts[rt] = (routeCounts[rt] || 0) + 1;
    });
    const topRoutes = Object.entries(routeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    const routeEl = document.getElementById('statRoutes');
    if (routeEl) {
        if (topRoutes.length === 0) {
            routeEl.innerHTML = '<span style="color:var(--grey-300)">—</span>';
        } else {
            routeEl.innerHTML = topRoutes.map(([r, c]) =>
                `<div class="stat-route-row"><span class="stat-route-name">${r}</span><span class="stat-route-count">${c.toLocaleString()}</span></div>`
            ).join('');
        }
    }

    const approved = allResults.filter(r => (r.status || '').toLowerCase() === 'approved').length;
    const inactive = allResults.length - approved;
    const statApproved = document.getElementById('statStatusApproved');
    const statInactive = document.getElementById('statStatusInactive');
    const statTotal    = document.getElementById('statTotal');
    if (statApproved) statApproved.textContent = approved.toLocaleString();
    if (statInactive) statInactive.textContent = inactive.toLocaleString();
    if (statTotal)    statTotal.textContent    = allResults.length.toLocaleString();
}

// ── Load-more banner ──────────────────────────────────────────────────────
function renderLoadMoreBanner() {
    const container = document.getElementById('loadMoreBannerContainer');
    if (!container) return;

    const totalAvailable = window._fullMerged ? window._fullMerged.length : 0;
    const shouldShow = fullDataset === null
        && activeDays === 360
        && totalAvailable > RESULT_CAP;

    if (!shouldShow) {
        container.innerHTML = '';
        return;
    }

    const extra = totalAvailable - RESULT_CAP;
    container.innerHTML = `
        <div id="loadMoreBanner" class="load-more-banner">
            <span>You're viewing the most recent <strong>${RESULT_CAP.toLocaleString()}</strong> products.
            The last 360 days contains <strong>${totalAvailable.toLocaleString()}</strong> total
            (<strong>+${extra.toLocaleString()}</strong> more).</span>
            <button class="btn-load-more" onclick="loadFullDataset()">
                Load all ${totalAvailable.toLocaleString()} products
            </button>
        </div>`;
}

function downloadCSV() {
    const headers = COLUMNS.map(c => c.label);
    const rows = getSorted(filteredResults).map(obj =>
        COLUMNS.map(c => {
            const v = obj[c.key] || '';
            return `"${String(v).replace(/"/g, '""')}"`;
        }).join(',')
    );
    const csv  = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'drug_products.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// ── Rendering ─────────────────────────────────────────────────────────────
function renderAll() {
    renderResultsMeta();
    renderTable();
    renderPagination();
}

function renderResultsMeta() {
    const meta  = document.getElementById('resultsMeta');
    const count = document.getElementById('resultsCount');
    if (meta)  meta.style.display = 'flex';
    if (count) count.innerHTML = `Showing <strong>${filteredResults.length.toLocaleString()}</strong> of <strong>${allResults.length.toLocaleString()}</strong> products`;
}

function renderTable() {
    const container = document.getElementById('table-container');
    if (!container) return;

    if (filteredResults.length === 0) {
        container.innerHTML = `
            <div class="state-box">
                <div class="state-icon">🔍</div>
                <div class="state-title">No results found</div>
                <div class="state-body">Try adjusting or clearing your filters.</div>
            </div>`;
        return;
    }

    const sorted   = getSorted(filteredResults);
    const start    = (currentPage - 1) * PAGE_SIZE;
    const pageData = sorted.slice(start, start + PAGE_SIZE);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';

    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';

    const table = document.createElement('table');

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

    const tbody = document.createElement('tbody');
    pageData.forEach(obj => {
        const row = tbody.insertRow();
        COLUMNS.forEach(col => {
            const td = row.insertCell();
            if (col.cls) td.className = col.cls;
            const value = obj[col.key] || '—';
            if (col.modal && obj[col.key]) {
                const a = document.createElement('a');
                a.href        = '#';
                a.textContent = value;
                a.title       = 'View full product details';
                a.onclick     = (e) => { e.preventDefault(); openModal(obj); };
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
    if (!container) return;
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

    const win = 5;
    let wStart = Math.max(1, currentPage - Math.floor(win / 2));
    let wEnd   = Math.min(totalPages, wStart + win - 1);
    if (wEnd - wStart + 1 < win) wStart = Math.max(1, wEnd - win + 1);

    if (wStart > 1) {
        container.appendChild(makeBtn('1', 1, false, false));
        if (wStart > 2) { const el = document.createElement('span'); el.textContent = '…'; el.style.cssText = 'padding:0 4px;color:var(--grey-300)'; container.appendChild(el); }
    }
    for (let p = wStart; p <= wEnd; p++) {
        container.appendChild(makeBtn(p, p, false, p === currentPage));
    }
    if (wEnd < totalPages) {
        if (wEnd < totalPages - 1) { const el = document.createElement('span'); el.textContent = '…'; el.style.cssText = 'padding:0 4px;color:var(--grey-300)'; container.appendChild(el); }
        container.appendChild(makeBtn(totalPages, totalPages, false, false));
    }

    container.appendChild(makeBtn('→', currentPage + 1, currentPage === totalPages, false));
}

function renderPills(company, ingredient) {
    const pillsContainer = document.getElementById('activePills');
    if (!pillsContainer) return;
    pillsContainer.innerHTML = '';

    const addPill = (label, field) => {
        const pill = document.createElement('div');
        pill.className = 'filter-pill';
        pill.innerHTML = `${label} <button onclick="clearPill('${field}')" title="Remove filter">✕</button>`;
        pillsContainer.appendChild(pill);
    };

    if (company)    addPill(`Company: ${company}`,       'companyFilter');
    if (ingredient) addPill(`Ingredient: ${ingredient}`, 'ingredientFilter');
    if (activeRoute) addPill(`Route: ${activeRoute}`,    '_route');
    if (activeDays)  addPill(`Last ${activeDays} days`,  '_days');
}

// ── Loading / error states ────────────────────────────────────────────────
function showLoading() {
    const el = document.getElementById('table-container');
    if (el) {
        el.innerHTML = `
            <div class="loading-state">
                <div class="spinner"></div>
                <span class="loading-label">Loading drug data…</span>
                <span class="loading-sub">Fetching from Health Canada's database</span>
            </div>`;
    }
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    ['companyFilter', 'ingredientFilter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keydown', e => {
                if (e.key === 'Enter') applyFilters();
            });
        }
    });

    const quickFilter = document.getElementById('quickFilter');
    if (quickFilter) {
        quickFilter.addEventListener('input', onQuickInput);
    }
    
    main();
});

// ── Modal ─────────────────────────────────────────────────────────────────
function openModal(obj) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    const din  = obj.drug_identification_number;
    const code = obj.drug_code;

    root.innerHTML = `
        <div class="modal-backdrop" id="modalBackdrop">
            <div class="modal" role="dialog" aria-modal="true" aria-label="Product details for DIN ${din}">
                <div class="modal-header">
                    <div>
                        <div class="modal-din">DIN ${din}</div>
                        <h2>${obj.brand_name || '—'}</h2>
                    </div>
                    <button class="modal-close" onclick="closeModal()" aria-label="Close">✕</button>
                </div>
                <div class="modal-body">
                    <div class="modal-loading">
                        <div class="spinner"></div>
                        <span>Loading product details…</span>
                    </div>
                </div>
            </div>
        </div>`;

    const backdrop = document.getElementById('modalBackdrop');
    if (backdrop) {
        backdrop.addEventListener('click', e => {
            if (e.target === e.currentTarget) closeModal();
        });
    }
    document._modalEsc = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', document._modalEsc);

    fetchModalData(code, din).then(html => {
        const body = document.querySelector('.modal-body');
        if (body) body.innerHTML = html;
    });
}

function closeModal() {
    const root = document.getElementById('modal-root');
    if (root) root.innerHTML = '';
    document.removeEventListener('keydown', document._modalEsc);
}
// ── (Remaining structural HTML building helpers omitted for length) ───────