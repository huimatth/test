// ── State ──────────────────────────────────────────────────────────────
let allResults      = [];   // full unfiltered dataset (never mutated)
let filteredResults = [];   // current filtered view
let currentPage     = 1;
const PAGE_SIZE     = 25;
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

// ── Paginated fetch (parallel burst) ─────────────────────────────────────
// Fetches pages in parallel bursts of BURST_SIZE instead of one-at-a-time,
// which cuts fetch time ~10x for large endpoints like activeingredient.
async function fetchAllPages(baseUri) {
    const limit      = 1000;
    const BURST_SIZE = 10;
    const sep        = baseUri.includes('?') ? '&' : '?';

    // Fetch the first page to confirm there's data and seed the result
    const first = await fetchData(`${baseUri}${sep}limit=${limit}&offset=0`);
    if (!first || first.length === 0) return [];
    if (first.length < limit) return first;

    let all    = [...first];
    let offset = limit;

    while (true) {
        // Fire BURST_SIZE page requests simultaneously
        const offsets = Array.from({ length: BURST_SIZE }, (_, i) => offset + i * limit);
        const pages   = await Promise.all(
            offsets.map(o => fetchData(`${baseUri}${sep}limit=${limit}&offset=${o}`))
        );

        let done = false;
        for (const page of pages) {
            if (!page || page.length === 0) { done = true; break; }
            all = all.concat(page);
            if (page.length < limit) { done = true; break; }
        }
        if (done) break;
        offset += BURST_SIZE * limit;
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

        allResults = part1.map(obj => ({
            ...obj,
            ...(part2[obj.drug_code] || {}),
        }));

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

// ── Route dropdown population ─────────────────────────────────────────────
function populateRouteDropdown() {
    const routes = [...new Set(
        allResults
            .map(r => r.route_of_administration_name)
            .filter(Boolean)
    )].sort();

    const sel = document.getElementById('routeFilter');
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
    const companyRaw    = document.getElementById('companyFilter').value.trim();
    const ingredientRaw = document.getElementById('ingredientFilter').value.trim();
    const company       = companyRaw.toLowerCase();
    const ingredient    = ingredientRaw.toLowerCase();
    const quickRaw      = document.getElementById('quickFilter').value.trim();
    const quick         = quickRaw.toLowerCase();
    activeRoute         = document.getElementById('routeFilter').value;

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
}

function resetFilters() {
    document.getElementById('companyFilter').value    = '';
    document.getElementById('ingredientFilter').value = '';
    document.getElementById('quickFilter').value      = '';
    document.getElementById('routeFilter').value      = '';
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
}

function clearPill(field) {
    if (field === '_days') {
        activeDays = null;
        updateDayPills();
    } else if (field === '_status') {
        activeStatus = 'all';
        updateStatusPills();
    } else if (field === '_route') {
        document.getElementById('routeFilter').value = '';
        activeRoute = '';
    } else {
        document.getElementById(field).value = '';
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

    // By route: count unique routes in filtered set
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

    // Status breakdown of loaded data
    const approved = allResults.filter(r => (r.status || '').toLowerCase() === 'approved').length;
    const inactive = allResults.length - approved;
    const statApproved = document.getElementById('statStatusApproved');
    const statInactive = document.getElementById('statStatusInactive');
    const statTotal    = document.getElementById('statTotal');
    if (statApproved) statApproved.textContent = approved.toLocaleString();
    if (statInactive) statInactive.textContent = inactive.toLocaleString();
    if (statTotal)    statTotal.textContent    = allResults.length.toLocaleString();
}

// ── CSV Download ──────────────────────────────────────────────────────────
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

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    ['companyFilter', 'ingredientFilter'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') applyFilters();
        });
    });
    document.getElementById('quickFilter').addEventListener('input', onQuickInput);
    main();
});

// ── Modal ─────────────────────────────────────────────────────────────────
function openModal(obj) {
    const root = document.getElementById('modal-root');
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

    document.getElementById('modalBackdrop').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal();
    });
    document._modalEsc = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', document._modalEsc);

    fetchModalData(code, din).then(html => {
        document.querySelector('.modal-body').innerHTML = html;
    });
}

function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
    document.removeEventListener('keydown', document._modalEsc);
}

async function fetchModalData(drugCode, din) {
    const base = 'https://health-products.canada.ca/api/drug';
    try {
        // Phase 1: fetch the product first so we have company_code for the targeted lookup
        const product = await fetchData(`${base}/drugproduct/?id=${drugCode}&lang=en&type=json`);
        const prod    = Array.isArray(product) ? product[0] : product;

        // Phase 2: fetch everything else in parallel, including only the specific company
        const [ingredients, company, forms, packaging,
               routes, schedules, status, therapeutic] = await Promise.all([
            fetchData(`${base}/activeingredient/?id=${drugCode}&lang=en&type=json`),
            prod?.company_code
                ? fetchData(`${base}/company/?id=${prod.company_code}&lang=en&type=json`)
                : Promise.resolve([]),
            fetchData(`${base}/form/?id=${drugCode}&lang=en&type=json`),
            fetchData(`${base}/packaging/?id=${drugCode}&type=json`),
            fetchData(`${base}/route/?id=${drugCode}&lang=en&type=json`),
            fetchData(`${base}/schedule/?id=${drugCode}&lang=en&type=json`),
            fetchData(`${base}/status/?id=${drugCode}&lang=en&type=json`),
            fetchData(`${base}/therapeuticclass/?id=${drugCode}&lang=en&type=json`),
        ]);

        const companyList = Array.isArray(company) ? company : (company ? [company] : []);
        const comp        = companyList[0] || {};

        return buildModalHTML(prod, ingredients, comp, forms, packaging, routes, schedules, status, therapeutic);
    } catch (err) {
        console.error('Modal fetch error:', err);
        return `<div class="modal-error">⚠️ Could not load product details. Please try again.</div>`;
    }
}

function val(v) {
    if (v === null || v === undefined || v === '' || v === 0) return '—';
    return v;
}

function mfield(label, value) {
    return `<div class="modal-field"><label>${label}</label><span>${val(value)}</span></div>`;
}

function buildModalHTML(prod, ingredients, comp, forms, packaging, routes, schedules, status, therapeutic) {
    const sections = [];

    sections.push(`
        <div class="modal-section">
            <div class="modal-section-title">Product overview</div>
            <div class="modal-grid">
                ${mfield('DIN',          prod?.drug_identification_number)}
                ${mfield('Brand name',   prod?.brand_name)}
                ${mfield('Class',        prod?.class_name)}
                ${mfield('Descriptor',   prod?.descriptor)}
                ${mfield('AI group #',   prod?.ai_group_no)}
                ${mfield('Last updated', prod?.last_update_date)}
            </div>
        </div>`);

    if (comp?.company_name) {
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Company</div>
                <div class="modal-grid">
                    ${mfield('Name',        comp.company_name)}
                    ${mfield('Type',        comp.company_type)}
                    ${mfield('Address',     [comp.street_name, comp.suite_number].filter(Boolean).join(', '))}
                    ${mfield('City',        comp.city_name)}
                    ${mfield('Province',    comp.province_name)}
                    ${mfield('Postal code', comp.postal_code)}
                    ${mfield('Country',     comp.country_name)}
                </div>
            </div>`);
    }

    const ings = Array.isArray(ingredients) ? ingredients : (ingredients ? [ingredients] : []);
    if (ings.length > 0) {
        const rows = ings.map(i => `
            <tr>
                <td>${val(i.ingredient_name)}</td>
                <td>${val(i.strength)} ${val(i.strength_unit)}</td>
                <td>${val(i.dosage_value)} ${val(i.dosage_unit)}</td>
            </tr>`).join('');
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Active ingredients</div>
                <table class="modal-table">
                    <thead><tr><th>Ingredient</th><th>Strength</th><th>Dosage</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`);
    }

    const formList = Array.isArray(forms) ? forms : (forms ? [forms] : []);
    if (formList.length > 0) {
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Dosage form</div>
                <div class="modal-grid">
                    ${formList.map(f => mfield('Form', f.pharmaceutical_form_name)).join('')}
                </div>
            </div>`);
    }

    const routeList = Array.isArray(routes) ? routes : (routes ? [routes] : []);
    if (routeList.length > 0) {
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Route of administration</div>
                <div class="modal-grid">
                    ${routeList.map(r => mfield('Route', r.route_of_administration_name)).join('')}
                </div>
            </div>`);
    }

    const schedList = Array.isArray(schedules) ? schedules : (schedules ? [schedules] : []);
    if (schedList.length > 0) {
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Schedule</div>
                <div class="modal-grid">
                    ${schedList.map(s => mfield('Schedule', s.schedule_name)).join('')}
                </div>
            </div>`);
    }

    const statusList = Array.isArray(status) ? status : (status ? [status] : []);
    if (statusList.length > 0) {
        const rows = statusList.map(s => `
            <tr>
                <td>${val(s.status)}</td>
                <td>${val(s.history_date)}</td>
                <td>${val(s.original_market_date)}</td>
                <td>${val(s.expiration_date)}</td>
            </tr>`).join('');
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Status history</div>
                <table class="modal-table">
                    <thead><tr><th>Status</th><th>History date</th><th>Original market date</th><th>Expiry date</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`);
    }

    const tcList = Array.isArray(therapeutic) ? therapeutic : (therapeutic ? [therapeutic] : []);
    if (tcList.length > 0) {
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Therapeutic class</div>
                <div class="modal-grid">
                    ${tcList.map(t => mfield(`${val(t.tc_atc_number)}`, t.tc_atc)).join('')}
                </div>
            </div>`);
    }

    const packList = Array.isArray(packaging) ? packaging : (packaging ? [packaging] : []);
    const packFiltered = packList.filter(p => p.product_information || p.package_type || p.package_size);
    if (packFiltered.length > 0) {
        sections.push(`
            <div class="modal-section">
                <div class="modal-section-title">Packaging</div>
                <div class="modal-grid">
                    ${packFiltered.map(p => mfield('Package info', p.product_information || [p.package_size, p.package_size_unit, p.package_type].filter(Boolean).join(' '))).join('')}
                </div>
            </div>`);
    }

    return sections.join('');
}
